import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { cliPath, configPath, engineDir, pythonCandidates } from './config.js'

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
  const configured = typeof cfg?.python === 'string' ? cfg.python : ''
  if (configured && existsSync(configured)) return configured
  const candidate = pythonCandidates().find((item) => existsSync(item))
  if (candidate) return candidate
  // Last resort: whatever "python" resolves to on PATH. The setup script exists
  // precisely so that this branch is not the normal one.
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

export async function httpJson(cfg, path, { method = 'GET', body, timeoutMs = 2500 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(200, timeoutMs))
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
  }
}

/** /health returns { ok, embed, rerank, rss_mb, ... } or null when not running. */
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

export async function waitReady(cfg, { timeoutMs = 20000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const h = await health(cfg)
    if (h && h.embed) return h
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return null
}

export async function search(cfg, { query, k, rerank, src, srcs, signal } = {}) {
  // 优先走常驻服务的 /search：省掉每次约 250ms 的 python 启动开销（每回合向量检索都走这条路）。
  // 服务没起来/接口异常时静默回退到 CLI，保证行为不变。
  try {
    const body = { query: String(query ?? '') }
    if (k) body.k = Number(k)
    if (src) body.src = String(src)
    if (Array.isArray(srcs) && srcs.length) body.srcs = srcs.map(String)
    if (rerank === true || rerank === false) body.rerank = rerank
    const data = await httpJson(cfg, '/search', { method: 'POST', body, timeoutMs: 60000 })
    // 服务端回显 query/k：对不上就说明这条请求没被正确执行，宁可回退 CLI 也不要返回错结果
    const echoed = data && typeof data.query === 'string' ? data.query === String(query ?? '') : true
    if (data && Array.isArray(data.hits) && echoed) {
      if (process.env.VM_DEBUG) console.error('[engine.search] 服务端', serviceUrl(cfg), 'k=', k, 'hits=', data.hits.length, 'first=', data.hits[0]?.path, 'srvMs=', data.info?.ms)
      return data
    }
  } catch (error) {
    if (process.env.VM_DEBUG) console.error('[engine.search] 服务端检索失败，回退 CLI：', error?.message || error)
  }
  const args = ['search', String(query ?? '')]
  if (k) args.push('-k', String(k))
  if (src) args.push('--src', String(src))
  if (Array.isArray(srcs) && srcs.length) args.push('--srcs', srcs.map(String).join(','))
  if (rerank === true) args.push('--rerank')
  if (rerank === false) args.push('--no-rerank')
  args.push('--json')
  const { code, stdout, stderr } = await runCli(cfg, args, { timeoutMs: 240000, signal })
  if (code !== 0) throw new Error(`检索失败（exit ${code}）：${(stderr || stdout).slice(-400)}`)
  return parseJsonOutput(stdout, '检索')
}

export async function buildIndex(cfg, { force = false, only = null, onLine, signal } = {}) {
  const args = ['index', '--json']
  if (force) args.push('--force')
  // only: 只更新这些源（项目标签或源名），其余源的块原样保留 —— 给"只索引某个项目"用。
  const onlyList = Array.isArray(only) ? only.filter(Boolean) : only ? [only] : []
  if (onlyList.length) args.push('--only', onlyList.join(','))
  const { code, stdout, stderr } = await runCli(cfg, args, { timeoutMs: 1800000, onLine, signal })
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
    return out
  })
}
