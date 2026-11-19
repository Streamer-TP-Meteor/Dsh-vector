import { readConfig } from './config.js'
import { ensureService, health, lastSearchAt, startService, stopService, waitServiceDown } from './engine.js'
import { pushEvent } from './events.js'
import { startJob, waitIdle } from './jobs.js'

/**
 * Keeps the base layer warm without ever getting in the user's way.
 *
 * Rules:
 *  - At startup (after a delay that lets DSH finish booting): optionally start
 *    the embedding service, then optionally run one incremental index pass.
 *  - Every TICK: if the service died and prewarm is on, start it again; if a
 *    periodic index interval is configured and it is due, run it.
 *  - Nothing here throws into DSH: every failure is logged, remembered, and
 *    retried on a later tick.
 */

const TICK_MS = 60 * 1000

/**
 * 纯判断：这次要不要重启服务回收内存（不碰任何 IO，方便单测）。
 * - limitMb <= 0 表示用户关掉了回收
 * - idleMin > 0 时要求「距上次检索超过 idleMin 分钟」，避免在用户正在用时重启
 */
export function shouldRecycle({ rssMb, limitMb, idleMin = 0, lastSearchAt = 0, now = Date.now() }) {
  const rss = Number(rssMb || 0)
  const limit = Number(limitMb || 0)
  if (!(limit > 0) || !(rss > limit)) return false
  const idle = Number(idleMin || 0)
  if (idle > 0 && now - Number(lastSearchAt || 0) < idle * 60 * 1000) return false
  return true
}
/**
 * 服务到底空闲了多久（毫秒）。
 * 优先用服务自己上报的 last_req_age_s——它看得到所有客户端（宿主、CLI、索引、另一个 DSH 实例）；
 * 老版本服务没有这个字段时，退回宿主内存里的 lastSearchAt。
 */
export function serviceIdleMs(running, hostLastSearchAt = 0, now = Date.now()) {
  const age = running?.last_req_age_s
  if (typeof age === 'number' && Number.isFinite(age)) return Math.max(0, age * 1000)
  return Math.max(0, now - (Number(hostLastSearchAt) || 0))
}

export function createSupervisor({ log = () => {}, getVersion = () => '0.0.0' } = {}) {
  let started = false
  let startupTimer = null
  let tickTimer = null
  let lastWarmAt = null
  let lastWarmError = null
  let lastIndexAt = null
  let lastIndexError = null
  let nextIndexAt = null
  let lastTickAt = null
  let wasRunning = false
  let ticks = 0

  const note = (level, message) => {
    try {
      pushEvent(level, message)
      log(message)
    } catch {
      // logging must never break the supervisor
    }
  }

  async function warmService(config) {
    const current = await health(config)
    if (current && current.embed) {
      wasRunning = true
      return { ok: true, already: true }
    }
    note('info', '预热向量服务…')
    const job = startJob({
      kind: 'warm',
      label: '预热向量服务',
      runner: async ({ log: jobLog }) => {
        const h = await startService(config, { onLine: () => {} })
        jobLog(`服务就绪：embed=${Boolean(h?.embed)} rerank=${Boolean(h?.rerank)}`)
        return { embed: Boolean(h?.embed), rerank: Boolean(h?.rerank) }
      },
    })
    if (!job.ok) return { ok: false, error: job.error }
    lastWarmAt = new Date().toISOString()
    wasRunning = true
    return { ok: true, job: job.job }
  }

  async function runIndex(config, { force = false, reason = 'manual' } = {}) {
    const job = startJob({
      kind: 'index',
      label: force ? '全量重建索引' : '增量索引',
      runner: async ({ log: jobLog }) => {
        const { buildIndex } = await import('./engine.js')
        const stats = await buildIndex(config, { force, onLine: (line) => jobLog(line) })
        return stats
      },
    })
    if (!job.ok) return { ok: false, error: job.error }
    note('info', `${force ? '全量' : '增量'}索引已开始（${reason}）`)
    lastIndexAt = new Date().toISOString()
    lastIndexError = null
    return { ok: true, job: job.job }
  }

  /**
   * 内存看守：0.6B 模型在 CPU 上每处理一次嵌入，RSS 会缓慢上涨（实测约 +2.2MB/块，且不回落）。
   * 空闲够久、内存又超阈值时，重启一次服务把内存收回到 ~1.7GB。
   * 走 startJob 是为了跟索引任务串行：索引在跑时本轮直接跳过，不会把索引打断。
   */
  async function recycleIfBloated(config, running) {
    const limitMb = Number(config.service?.recycle_rss_mb || 0)
    const rss = Number(running?.rss_mb || 0)
    const idleMin = Number(config.service?.recycle_idle_min ?? 10)
    // 空闲判定优先用「服务自己看到的最后一次请求」（/health 的 last_req_age_s）：
    // 宿主内存里的 lastSearchAt() 只记录本进程发起的检索，CLI / 索引 / 另一个 DSH 实例
    // 打过来的请求它看不见，会出现「明明在忙着却在空闲窗口被重启」。
    const idleMs = serviceIdleMs(running, lastSearchAt())
    const lastActiveAt = Date.now() - idleMs
    if (!shouldRecycle({ rssMb: rss, limitMb, idleMin, lastSearchAt: lastActiveAt, now: Date.now() })) return
    const job = startJob({
      kind: 'recycle',
      label: `回收向量服务内存（RSS ${Math.round(rss)}MB）`,
      runner: async ({ log: jobLog }) => {
        await stopService(config)
        await waitServiceDown(config)
        const h = await ensureService(config, { attempts: 3, log: jobLog })
        jobLog(`服务已重启：rss ${Math.round(Number(h?.rss_mb || 0))}MB`)
        return { before_mb: Math.round(rss), after_mb: Math.round(Number(h?.rss_mb || 0)) }
      },
    })
    if (!job.ok) return
    note('info', `向量服务内存 ${Math.round(rss)}MB 超过 ${limitMb}MB 且空闲 ${Math.round(idleMs / 60000)} 分钟，已排队重启回收`)
  }

  async function startupPass() {
    try {
      const { config } = await readConfig()
      const prewarm = config.service?.prewarm !== false
      if (prewarm) {
        try {
          await warmService(config)
        } catch (error) {
          lastWarmError = error instanceof Error ? error.message : String(error)
          note('warn', `预热服务失败：${lastWarmError}`)
        }
      }
      if (config.index?.auto !== false && config.index?.on_startup !== false) {
        try {
          // wait for the warm job, so the startup index is not rejected as
          // "another job is running" on a cold start
          await waitIdle(180000)
          await runIndex(config, { reason: 'DSH 启动' })
        } catch (error) {
          lastIndexError = error instanceof Error ? error.message : String(error)
          note('warn', `启动索引失败：${lastIndexError}`)
        }
      }
    } catch (error) {
      note('warn', `启动自检失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function tick() {
    ticks += 1
    lastTickAt = new Date().toISOString()
    try {
      const { config } = await readConfig()
      const running = await health(config)
      if (running?.embed) {
        wasRunning = true
      } else if (wasRunning && config.service?.restart_on_crash !== false) {
        note('warn', '检测到向量服务已退出，准备重新拉起')
        wasRunning = false
      }
      if (running?.embed) await recycleIfBloated(config, running).catch(() => {})
      if (!running?.embed && config.service?.prewarm !== false) {
        await ensureService(config, { attempts: 2, log: (line) => note('info', line) }).catch((error) => {
          lastWarmError = error instanceof Error ? error.message : String(error)
          note('warn', `自动拉起服务失败：${lastWarmError}`)
        })
      }
      const interval = Number(config.index?.interval_min || 0)
      if (config.index?.auto !== false && interval > 0) {
        const due = !nextIndexAt || Date.now() >= nextIndexAt
        if (due) {
          nextIndexAt = Date.now() + interval * 60 * 1000
          await waitIdle(60000)
          await runIndex(config, { reason: `定时（${interval} 分钟）` }).catch((error) => {
            lastIndexError = error instanceof Error ? error.message : String(error)
          })
        }
      } else {
        nextIndexAt = null
      }
    } catch (error) {
      note('warn', `守护进程本轮失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function start() {
    if (started) return
    started = true
    void (async () => {
      let delaySec = 12
      try {
        const { config } = await readConfig()
        delaySec = Math.max(2, Number(config.index?.startup_delay_sec || 12))
      } catch {
        // default delay is fine
      }
      note('info', `基础层守护已启动（v${getVersion()}），${delaySec}s 后自检`)
      startupTimer = setTimeout(() => {
        startupTimer = null
        void startupPass()
      }, delaySec * 1000)
      startupTimer.unref?.()
      tickTimer = setInterval(() => void tick(), TICK_MS)
      tickTimer.unref?.()
    })()
  }

  function stop() {
    started = false
    if (startupTimer) clearTimeout(startupTimer)
    if (tickTimer) clearInterval(tickTimer)
    startupTimer = null
    tickTimer = null
  }

  function status() {
    return {
      enabled: started,
      lastWarmAt,
      lastWarmError,
      lastIndexAt,
      lastIndexError,
      nextIndexAt: nextIndexAt ? new Date(nextIndexAt).toISOString() : null,
      lastTickAt,
      ticks,
      wasRunning,
      tickMs: TICK_MS,
    }
  }

  return { start, stop, status, warmService, runIndex, tick }
}
