import { randomUUID } from 'node:crypto'

/**
 * One background job at a time (index / warm / service restart ...).
 *
 * Why single-flight: the Python engine is a single interpreter doing CPU-bound
 * work. Two concurrent index runs would fight over the same files and the same
 * service, and a user clicking a button twice would be enough to start one. The
 * second request gets a clear "already running" answer instead.
 */

const jobs = new Map()
const MAX_LOG = 200
const KEEP_FINISHED = 20
let activeId = null

function trimFinished() {
  const finished = [...jobs.values()].filter((job) => job.status !== 'running')
  while (finished.length > KEEP_FINISHED) {
    const oldest = finished.shift()
    if (oldest) jobs.delete(oldest.id)
  }
}

export function activeJob() {
  return activeId ? jobs.get(activeId) ?? null : null
}

export function getJob(id) {
  return jobs.get(String(id ?? '')) ?? null
}

export function publicJob(job) {
  if (!job) return null
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    ms: job.finishedAt ? job.finishedAt - job.startedAt : Date.now() - job.startedAt,
    error: job.error,
    result: job.result,
    log: job.log.slice(-40),
  }
}

/** Latest job of a kind (running or finished), used to restore UI state. */
export function lastJob(kind) {
  let found = null
  for (const job of jobs.values()) {
    if (job.kind !== kind) continue
    if (!found || job.startedAt > found.startedAt) found = job
  }
  return found
}

export function summariseJobs() {
  const list = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
  return list.map(publicJob)
}

/**
 * Start a job. `runner` receives { log, signal, job } and may be async.
 * Returns the public job immediately; never throws for a second concurrent job.
 */
export function startJob({ kind, label, runner }) {
  const running = activeJob()
  if (running) {
    return { ok: false, error: `已有任务在运行：${running.label}（${running.kind}）`, job: publicJob(running) }
  }
  const controller = new AbortController()
  const job = {
    id: randomUUID(),
    kind,
    label: label || kind,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    result: null,
    log: [],
    controller,
  }
  jobs.set(job.id, job)
  activeId = job.id
  const log = (message) => {
    const text = String(message ?? '').trim()
    if (!text) return
    job.log.push(`${new Date().toISOString().slice(11, 19)} ${text}`)
    if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG)
  }
  log(`${job.label} 开始`)
  // done 让调用方（比如 vmemory_index 工具）能等这次任务真正结束，又不必绕过单飞队列自己跑 runner：
  // 绕过队列会让外部取消（SIGTERM）落在写盘中间，正是审计 PY-01/STB-01 的放大器。
  const done = Promise.resolve()
    .then(() => runner({ log, signal: controller.signal, job }))
    .then((result) => {
      job.status = 'done'
      job.result = result ?? null
      job.finishedAt = Date.now()
      log(`完成，用时 ${((job.finishedAt - job.startedAt) / 1000).toFixed(1)}s`)
      return { ok: true, job: publicJob(job) }
    })
    .catch((error) => {
      const aborted = controller.signal.aborted
      job.status = aborted ? 'cancelled' : 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      job.finishedAt = Date.now()
      log(`${aborted ? '已取消' : '失败'}：${job.error}`)
      return { ok: false, cancelled: aborted, error: job.error, job: publicJob(job) }
    })
    .finally(() => {
      if (activeId === job.id) activeId = null
      trimFinished()
    })
  return { ok: true, job: publicJob(job), done }
}

/**
 * Wait until no job is running. Used by the supervisor so that "warm the
 * service, then index once" happens in order instead of the index being
 * rejected with "already running".
 */
export async function waitIdle(timeoutMs = 180000) {
  const deadline = Date.now() + Math.max(1000, timeoutMs)
  while (activeJob() && Date.now() < deadline) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 250)
      if (typeof timer?.unref === 'function') timer.unref()
    })
  }
  return !activeJob()
}

export function cancelJob(id) {
  const job = id ? getJob(id) : activeJob()
  if (!job) return { ok: false, error: '没有找到这个任务' }
  if (job.status !== 'running') return { ok: false, error: '任务已经结束' }
  job.controller.abort()
  return { ok: true, job: publicJob(job) }
}
