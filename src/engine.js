import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { cliPath, configPath, engineDir, pythonCandidates, readConfig } from './config.js'

/**
 * Thin bridge to the local Python engine.
 *
 * Two transports, on purpose:
 *  - HTTP to the resident embedding service (127.0.0.1:8479) for health/stats —
 *    milliseconds, no interpreter start.
 *  - The `vsearch.py` CLI for search/index/service control, because the BM25
 *    index and the numpy math live in Python. A CLI call costs ~0.3 s.
 *
 * Everything here is bounded: every spawn has a timeout and gets killed, every
 * HTTP call has an abort signal. Nothing may hang a DSH turn.
 */

const MAX_OUTPUT = 4 * 1024 * 1024

export function pythonPath(cfg) {
  const configured = typeof cfg?.python === 'string' ? cfg.python.trim() : ''
  if (configured && (!configured.includes('/') && !configured.includes('\\') ? true : existsSync(configured))) return configured
  // 没配过（或配的路径已经不存在）：按 paths.js 的候选顺序探测（插件 venv → 引擎 venv → PATH）。
  for (const candidate of pythonCandidates()) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate
    } else {
      return candidate
    }
  }
  return 'python'
}

export function serviceUrl(cfg) {
  const host = cfg?.service?.host || '127.0.0.1'
  const port = Number(cfg?.service?.port || 8479)
  return `http://${host}:${port}`
}

export function engineStatus() {
  return {
    dir: engineDir(),
    cli: cliPath(),
    cliExists: existsSync(cliPath()),
    config: configPath(),
    configExists: existsSync(configPath()),
  }
}

function splitLines(onLine) {
  let pending = ''
  return (chunk) => {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const text = line.trim()
      if (text && typeof onLine === 'function') {
        try {
          onLine(text)
        } catch {
          // a logging callback must never kill the child watcher
        }
      }
    }
  }
}

/**
 * Run the CLI. Resolves { code, stdout, stderr, ms } and rejects on spawn error
 * or timeout (after killing the child).
 */
export function runCli(cfg, args, { timeoutMs = 180000, signal, onLine } = {}) {
  return new Promise((resolvePromise, reject) => {
    const cli = cliPath()
    if (!existsSync(cli)) {
      reject(new Error(`向量引擎不存在：${cli}（检查引擎目录）`))
      return
    }
    const startedAt = Date.now()
    const full = ['--config', configPath(), ...args]
    let child
    try {
      child = spawn(pythonPath(cfg), [cli, ...full], {
        cwd: engineDir(),
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          PYTHONUNBUFFERED: '1',
          // 让 Python 服务盯着 DSH 宿主进程：DSH 退出后服务自动关闭，避免空闲驻留。
          VECTOR_MEMORY_WATCH_PID: String(process.pid),
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    // 先挂一个兜底 error 监听：下面 signal 已取消时会提前 return，
    // 那时若 spawn 本身失败（python 路径不存在等），'error' 事件没人接 → 未捕获异常把宿主带走
    // （外部审计 HOST-05 指出的真实风险）。
    child.on('error', () => {})
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
      fn(value)
    }
    const kill = () => {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
    const onAbort = () => {
      kill()
      finish(reject, new Error('已取消'))
    }
    if (signal) {
      if (signal.aborted) {
        kill()
        reject(new Error('已取消'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    timer = setTimeout(() => {
      kill()
      finish(reject, new Error(`向量引擎超时（${Math.round(timeoutMs / 1000)}s）：${args.slice(0, 2).join(' ')}`))
    }, Math.max(5000, timeoutMs))

    const stdoutLines = splitLines(onLine)
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8')
      stdoutLines(chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => finish(reject, error))
    child.on('close', (code) => finish(resolvePromise, { code, stdout, stderr, ms: Date.now() - startedAt }))
  })
}

/** Last JSON object in a CLI output stream (engine prints progress lines too). */
export function parseJsonOutput(text, what = 'engine') {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) throw new Error(`${what}：没有输出`)
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = Math.max(trimmed.lastIndexOf('\n{'), trimmed.lastIndexOf('\n['))
    if (start >= 0) {
      try {
        return JSON.parse(trimmed.slice(start + 1))
      } catch {
        // fall through to a readable error
      }
    }
    throw new Error(`${what}：输出不是 JSON（${trimmed.slice(0, 200)}）`)
  }
}

// 并发闸门：检索请求一起涌进来时，别把 CPU 上的 0.6B 小模型压垮。
// 实测 20 路并发会让单次延迟从 0.7s 涨到十几秒，撞上顶层的 12s 预算就整批降级；
// 限流之后多出来的请求排队（最多 128 个），排不上就快速失败，让上层走归档通道。
const DEFAULT_MAX_CONCURRENT = 6
const GATE = { active: 0, waiters: [] }
function gateLimit(cfg) {
  const value = Number(cfg?.service?.max_concurrent)
  if (Number.isFinite(value) && value >= 1) return Math.min(32, Math.floor(value))
  return DEFAULT_MAX_CONCURRENT
}
function pumpGate() {
  while (GATE.waiters.length) {
    const next = GATE.waiters[0]
    if (GATE.active >= next.limit) break
    GATE.waiters.shift()
    clearTimeout(next.timer)
    GATE.active += 1
    next.resolve()
  }
}
async function acquireGate(cfg, waitMs) {
  const limit = gateLimit(cfg)
  if (GATE.active < limit) {
    GATE.active += 1
    return
  }
  if (GATE.waiters.length >= 128) throw new Error('向量服务繁忙（排队已满）')
  await new Promise((resolve, reject) => {
    const waiter = { limit, resolve, timer: null }
    waiter.timer = setTimeout(() => {
      const index = GATE.waiters.indexOf(waiter)
      if (index >= 0) GATE.waiters.splice(index, 1)
      reject(new Error(`向量服务繁忙（排队超过 ${Math.round(waitMs)}ms）`))
    }, Math.max(200, waitMs))
    GATE.waiters.push(waiter)
  })
}
function releaseGate() {
  GATE.active = Math.max(0, GATE.active - 1)
  pumpGate()
}

export async function httpJson(cfg, path, { method = 'GET', body, timeoutMs = 2500, signal = null } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(200, timeoutMs))
  // 外部取消也要立刻断掉请求：只靠超时的话，调用方 1500ms 的预算是摆设（审计 HOST-03）。
  const forwardAbort = () => {
    try {
      controller.abort()
    } catch {
      // ignore
    }
  }
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer)
      throw new Error('已取消')
    }
    if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', forwardAbort, { once: true })
  }
  try {
    const response = await fetch(`${serviceUrl(cfg)}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    if (!response.ok) throw new Error(`向量服务 HTTP ${response.status}${data?.error ? `: ${data.error}` : ''}`)
    return data
  } finally {
    clearTimeout(timer)
    if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', forwardAbort)
  }
}

/** /health returns { ok, embed, rerank, rss_mb, ... } or null when not running. */
// 正在进行的「拉起服务」流程（防并发重启把加载中的进程杀掉）
let ENSURE_INFLIGHT = null

export async function health(cfg) {
  try {
    const data = await httpJson(cfg, '/health', { timeoutMs: 1500 })
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

export async function stats(cfg) {
  try {
    return await httpJson(cfg, '/stats', { timeoutMs: 1500 })
  } catch {
    return null
  }
}

export async function shutdown(cfg) {
  try {
    return await httpJson(cfg, '/shutdown', { method: 'POST', timeoutMs: 4000 })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Start the resident service and wait until the embedding model is ready. */
export async function startService(cfg, { onLine, signal, timeoutMs } = {}) {
  const budget = Math.max(30000, Number(cfg?.service?.start_timeout_sec || 90) * 1000 + 15000)
  const { code, stdout, stderr } = await runCli(cfg, ['serve', '--start'], {
    timeoutMs: timeoutMs || budget,
    signal,
    onLine,
  })
  if (code !== 0) throw new Error(`服务启动失败（exit ${code}）：${(stderr || stdout).slice(-300)}`)
  const parsed = stdout.trim().startsWith('{') ? JSON.parse(stdout.trim()) : null
  return parsed || (await health(cfg))
}

export async function stopService(cfg) {
  const result = await shutdown(cfg)
  const still = await health(cfg)
  return { ...result, stopped: !still }
}

/**
 * 同步关闭服务：给进程退出钩子用（`process.once('exit')` 里不能 await）。
 * 找不到引擎或服务本来就没跑时安静返回 false。
 */
export function stopServiceSync({ timeoutMs = 6000 } = {}) {
  try {
    const cli = cliPath()
    if (!existsSync(cli)) return false
    let cfg = {}
    try {
      cfg = JSON.parse(readFileSync(configPath(), 'utf8'))
    } catch {
      cfg = {}
    }
    const result = spawnSync(pythonPath(cfg), [cli, '--config', configPath(), 'serve', '--stop'], {
      cwd: engineDir(),
      timeout: timeoutMs,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    return result.status === 0
  } catch {
    return false
  }
}

/** 等到服务端口彻底关闭（重启前用，避免新进程绑不上）。 */
export async function waitServiceDown(cfg, { timeoutMs = 8000, intervalMs = 300, healthFn = health } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const h = await healthFn(cfg)
    if (!h) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

/**
 * 把服务拉回到「embed 就绪」的状态，失败会重试。
 *
 * 为什么需要它：内存看守的重启是 stop → start 两步，中间任何一步抖一下
 * （端口还没释放、python 冷启动被挤、模型加载超时）就会把服务留在「关着」的状态，
 * 而下一轮守护要等 60 秒。这里做成「健康就返回、半死就先关再起、失败退避重试」。
 */
export async function ensureService(cfg, { attempts = 3, log = () => {}, onLine, healthFn = health, startFn = startService, stopFn = stopService, waitFn = waitReady } = {}) {
  // 同一时刻只允许一个「拉起」流程在跑：守护 tick、预热任务、内存看守都可能同时触发，
  // 并发拉起会把正在加载模型的进程反复杀掉重来（实测会陷入永远 embed=false 的循环）。
  if (ENSURE_INFLIGHT) return ENSURE_INFLIGHT
  const loadBudget = Math.max(15000, Number(cfg?.service?.start_timeout_sec || 90) * 1000)
  ENSURE_INFLIGHT = (async () => {
    let lastError = null
    for (let i = 1; i <= Math.max(1, attempts); i += 1) {
      const h = await healthFn(cfg)
      if (h?.embed) return h
      if (h && !h.embed_error) {
        // 进程活着、模型还在加载：等它，别重启（重启只会把加载进度清零）
        const ready = await waitFn(cfg, { timeoutMs: loadBudget })
        if (ready) return ready
        lastError = new Error('服务在加载但一直没就绪')
      } else {
        try {
          if (h?.embed_error) {
            await stopFn(cfg)
            await waitServiceDown(cfg, { healthFn })
          }
          const started = await startFn(cfg, { onLine })
          if (started?.embed) return started
          const ready = await waitFn(cfg, { timeoutMs: loadBudget })
          if (ready) return ready
          lastError = new Error('服务已启动但模型未就绪')
        } catch (error) {
          lastError = error
        }
      }
      if (i < attempts) {
        log(`拉起向量服务第 ${i} 次失败，稍后重试：${lastError instanceof Error ? lastError.message : lastError}`)
        await new Promise((r) => setTimeout(r, 800 * i))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError || '向量服务不可用'))
  })().finally(() => {
    ENSURE_INFLIGHT = null
  })
  return ENSURE_INFLIGHT
}
export async function waitReady(cfg, { timeoutMs = 20000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const h = await health(cfg)
    if (h && h.embed) return h
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return null
}

// 最近一次检索的时间戳：给「空闲时重启服务回收内存」用。
let LAST_SEARCH_AT = 0
export function lastSearchAt() {
  return LAST_SEARCH_AT
}

/**
 * 调用方常常没有配置对象（自动召回、统一检索、工具入口都传 null），
 * 以前直接把这个 null 透下去 → service.host/port/max_concurrent 全部走缺省值，
 * 用户改了端口/并发上限却静默不生效（外部审计 HOST-02）。这里统一兜底读配置。
 */
async function resolveConfig(cfg) {
  if (cfg && typeof cfg === 'object' && Object.keys(cfg).length) return cfg
  try {
    const read = await readConfig()
    if (read?.config) return read.config
  } catch {
    // 配置读不出来也不能让检索直接崩：退化成内置缺省值继续。
  }
  return cfg || {}
}

export async function search(cfg, { query, k, rerank, src, srcs, signal, timeoutMs = 60000, allowCli = true } = {}) {
  LAST_SEARCH_AT = Date.now()
  if (signal?.aborted) throw new Error('已取消')
  const conf = await resolveConfig(cfg)
  // 优先走常驻服务的 /search：省掉每次约 250ms 的 python 启动开销（每回合向量检索都走这条路）。
  // 服务没起来/接口异常时静默回退到 CLI，保证行为不变。
  // timeoutMs / allowCli：工具调用路径给的是「有预算的检索」（几秒内必须有答案），
  // 所以既能收紧 HTTP 超时，也能在服务不可用时直接失败，让上层降级到归档通道而不是等 CLI 冷启动。
  const budgetMs = Math.max(500, Number(timeoutMs) || 60000)
  // 排队预算给到总预算的六成：20 路突发在一档 4 并发下大约要 3.5–4 秒，
  // 只给 3 秒会让排在后面的请求白等一场再失败，降级成归档反而更难解释。
  const gateWaitMs = Math.min(10000, Math.max(800, budgetMs - 2000))
  await acquireGate(conf, gateWaitMs)
  try {
    const body = { query: String(query ?? '') }
    if (k) body.k = Number(k)
    if (src) body.src = String(src)
    if (Array.isArray(srcs) && srcs.length) body.srcs = srcs.map(String)
    if (rerank === true || rerank === false) body.rerank = rerank
    const data = await httpJson(conf, '/search', { method: 'POST', body, timeoutMs: budgetMs, signal })
    // 服务端回显 query/k：对不上就说明这条请求没被正确执行，宁可回退 CLI 也不要返回错结果
    const echoed = data && typeof data.query === 'string' ? data.query === String(query ?? '') : true
    if (data && Array.isArray(data.hits) && echoed) {
      if (process.env.VM_DEBUG) console.error('[engine.search] 服务端', serviceUrl(conf), 'k=', k, 'hits=', data.hits.length, 'first=', data.hits[0]?.path, 'srvMs=', data.info?.ms)
      return data
    }
  } catch (error) {
    if (process.env.VM_DEBUG) console.error('[engine.search] 服务端检索失败，回退 CLI：', error?.message || error)
    // 调用方主动取消（超时/取消）不算「服务不可用」，别把已取消伪装成一次降级
    if (signal?.aborted) throw new Error('已取消')
    if (allowCli === false) {
      throw new Error(`向量服务不可用（${error?.message || error}）`)
    }
  } finally {
    releaseGate()
  }
  if (signal?.aborted) throw new Error('已取消')
  const args = ['search', String(query ?? '')]
  if (k) args.push('-k', String(k))
  if (src) args.push('--src', String(src))
  if (Array.isArray(srcs) && srcs.length) args.push('--srcs', srcs.map(String).join(','))
  if (rerank === true) args.push('--rerank')
  if (rerank === false) args.push('--no-rerank')
  args.push('--json')
  // CLI 回退路径同样要有预算：给 240s 的旧值会让「几秒内必须有答案」的调用白等 4 分钟。
  const cliTimeoutMs = Math.max(5000, Math.min(240000, Number(timeoutMs) * 2 || 240000))
  const { code, stdout, stderr } = await runCli(conf, args, { timeoutMs: cliTimeoutMs, signal })
  if (code !== 0) throw new Error(`检索失败（exit ${code}）：${(stderr || stdout).slice(-400)}`)
  return parseJsonOutput(stdout, '检索')
}

export async function buildIndex(cfg, { force = false, only = null, onLine, signal } = {}) {
  const conf = await resolveConfig(cfg)
  const args = ['index', '--json']
  if (force) args.push('--force')
  // only: 只更新这些源（项目标签或源名），其余源的块原样保留 —— 给"只索引某个项目"用。
  const onlyList = Array.isArray(only) ? only.filter(Boolean) : only ? [only] : []
  if (onlyList.length) args.push('--only', onlyList.join(','))
  const { code, stdout, stderr } = await runCli(conf, args, { timeoutMs: 1800000, onLine, signal })
  if (code !== 0) throw new Error(`索引失败（exit ${code}）：${(stderr || stdout).slice(-600)}`)
  return parseJsonOutput(stdout, '索引')
}

/** One search hit → the shape both the tool and the settings page expose. */
export function normalizeHits(raw) {
  const list = Array.isArray(raw) ? raw : []
  return list.map((hit) => {
    const out = {}
    const score = Number(hit?.score)
    if (Number.isFinite(score)) out.score = score
    const cos = Number(hit?.cos)
    if (Number.isFinite(cos)) out.cos = cos
    const bm25 = Number(hit?.bm25)
    if (Number.isFinite(bm25)) out.bm25 = bm25
    if (hit?.src) out.source = String(hit.src)
    if (hit?.path) out.path = String(hit.path)
    if (hit?.heading) out.heading = String(hit.heading)
    const line = Number(hit?.line)
    if (Number.isInteger(line)) out.line = line
    if (hit?.snippet != null) out.snippet = String(hit.snippet)
    if (hit?.date) out.date = String(hit.date)
    return out
  })
}
