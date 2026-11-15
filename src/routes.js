import { spawn } from 'node:child_process'
import { buildState } from './state.js'
import {
  DEFAULTS,
  clone,
  configPath,
  engineDir,
  getPath,
  readConfig,
  updateConfig,
  writeConfig,
} from './config.js'
import { buildIndex, health, normalizeHits, search, startService, stopService } from './engine.js'
import { pushEvent } from './events.js'
import { activeJob, cancelJob, getJob, publicJob, startJob, summariseJobs } from './jobs.js'
import { listProjects, registerProject, removeProject } from './projects.js'

/**
 * Same-origin JSON bridge for the settings page.
 *
 * Rules that keep this boring and safe:
 * - one route table (`ROUTES`) is the single source of truth for both dispatch and registration,
 *   so a declared method can never drift from the handled one;
 * - the legacy prefix is normalised onto the main prefix before matching, so the fallback channel
 *   actually works when the authenticated channel is unavailable;
 * - non-authenticated transports must come from a loopback Host (DNS-rebinding guard);
 * - user-facing errors carry a status (400/404/413/405), stacks only go to the log;
 * - long work always goes through the single-flight job queue instead of blocking the request.
 */
const PREFIX = '/api/dsh-vector-memory'
const LEGACY_PREFIX = '/api/dsh-vector-memory-legacy'
const CLIENT_HEADER_NAME = 'x-vector-memory-client'
const CLIENT_HEADER = 'vector-memory/1'
const BODY_LIMIT = 512 * 1024
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** An error whose message is safe to show the user, with the HTTP status it maps to. */
class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const badRequest = (message) => new HttpError(400, message)

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function hostOf(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return ''
  if (text.startsWith('[')) return text.slice(0, text.indexOf(']') + 1) || '[::1]'
  return text.split(':')[0]
}

function isLoopbackHost(value) {
  const host = hostOf(value)
  return Boolean(host) && LOOPBACK_HOSTS.has(host)
}

async function readJsonBody(req, limit = BODY_LIMIT) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw badRequest('请求体不是合法 JSON')
  }
}

/**
 * Reveal a folder in the OS file manager.
 *
 * `spawn` reports a missing executable as an asynchronous `'error'` event; with no listener that
 * becomes an uncaughtException and would take the whole host down. We attach the listener and
 * never use the exit code (`explorer.exe` exits 1 even when it works).
 */
function openPath(target) {
  const command =
    process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(command, [target], { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', (error) => {
      try {
        pushEvent('warn', `打开目录失败：${describeError(error)}`)
      } catch {
        // ignore
      }
    })
    child.unref()
    return { ok: true, pending: true }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

export function makeRoutes({
  version,
  meta = null,
  supervisor,
  recall = null,
  projects = null,
  log = () => {},
  ctx,
} = {}) {
  const note = (message) => {
    try {
      pushEvent('info', message)
      log(message)
    } catch {
      // ignore
    }
  }

  const searchSettings = (config) => config.search || {}

  async function state() {
    let cwd = ''
    try {
      cwd = ctx?.get?.('workingDirectory')?.defaultDirectory || ''
    } catch {
      cwd = ''
    }
    let projectAgents = []
    try {
      projectAgents = projects?.snapshot?.() || []
    } catch {
      projectAgents = []
    }
    return buildState({ version, meta, supervisor, recall, cwd, projects: projectAgents })
  }

  async function searchRoute(body) {
    const query = String(body?.query ?? '').trim()
    if (!query) throw badRequest('请输入查询内容')
    if (query.length > 2000) throw badRequest('查询过长（最多 2000 字）')
    const { config } = await readConfig()
    const wanted = Number(body?.k || searchSettings(config).k || 5)
    const k = Number.isFinite(wanted) ? Math.min(30, Math.max(1, Math.round(wanted))) : 5
    const started = Date.now()
    const result = await search(config, { query, k, rerank: body?.rerank === true, src: body?.src ? String(body.src) : undefined })
    const hits = normalizeHits(result?.hits)
    const info = result?.info || {}
    return {
      ok: true,
      query,
      hits,
      ms: Number(info.ms ?? Date.now() - started),
      reranked: Boolean(info.reranked),
      total: hits.length,
    }
  }

  async function configRoute(body) {
    const patch = body?.patch
    const before = (await readConfig()).config
    const result = await updateConfig(patch)
    if (result.changed) note(`参数已保存：${Object.keys(patch || {}).join(', ') || '（无变化）'}`)
    // Compare server-side instead of trusting the client's `previous` snapshot.
    const restartHint = ['service.port', 'service.threads'].some(
      (path) => getPath(before, path) !== getPath(result.config, path),
    )
    return {
      ok: true,
      changed: result.changed,
      warnings: result.warnings || [],
      config: result.config,
      restartHint,
    }
  }

  /**
   * Restore editable settings, keeping what identifies this installation: interpreter, data
   * directory, model paths, memory sources and registered cross-drive projects. (An earlier
   * version dropped `project_sources`, which silently unregistered every project.)
   */
  async function resetRoute() {
    const current = (await readConfig()).config
    const next = {
      ...clone(DEFAULTS),
      python: current.python,
      data_dir: current.data_dir,
      models: current.models,
      sources: current.sources,
      project_sources: current.project_sources || [],
    }
    const written = await writeConfig(next)
    const restartHint = ['service.port', 'service.threads'].some(
      (path) => getPath(current, path) !== getPath(next, path),
    )
    note('参数已恢复默认（保留解释器、数据目录、模型与索引源）')
    return { ok: true, changed: true, warnings: [], config: next, restartHint, path: written?.path }
  }

  const indexLabel = (stats) => {
    const seconds = Number(stats?.seconds)
    const files = Number(stats?.files)
    const chunks = Number(stats?.chunks)
    return [
      `索引完成：${Number.isFinite(files) ? files : 0} 个文件、${Number.isFinite(chunks) ? chunks : 0} 块`,
      `（新增 ${Number(stats?.new) || 0} / 复用 ${Number(stats?.reused) || 0}）`,
      `${Number(stats?.dim) || 0} 维`,
      `${Number.isFinite(seconds) ? seconds.toFixed(1) : '?'}s`,
    ].join('')
  }

  async function indexRoute(body) {
    const force = body?.force === true
    const only = Array.isArray(body?.only) ? body.only.map(String) : undefined
    const { config } = await readConfig()
    return startJob({
      kind: 'index',
      label: force ? '全量重建索引' : '增量索引',
      runner: async ({ log: jobLog, signal }) => {
        const stats = await buildIndex(config, { force, only, signal, onLine: (line) => jobLog(line) })
        jobLog(indexLabel(stats))
        return stats
      },
    })
  }

  async function cancelRoute(body) {
    const id = String(body?.id ?? '').trim()
    if (!id) throw badRequest('请指定要取消的任务')
    const cancelled = cancelJob(id)
    if (!cancelled) throw new HttpError(404, '任务不存在或已结束')
    return { ok: true, cancelled: true, id }
  }

  async function serviceRoute(body) {
    const action = String(body?.action ?? '')
    const { config } = await readConfig()
    if (action === 'stop') {
      const running = activeJob()
      if (running) throw new HttpError(409, `有任务正在运行（${running.label}），暂不能停止服务`)
      const result = await stopService(config)
      note(result?.stopped ? '向量服务已停止' : '服务停止请求已发送')
      return { ok: true, stopped: Boolean(result?.stopped) }
    }
    if (action === 'start' || action === 'warm') {
      return startJob({
        kind: 'warm',
        label: '预热向量服务',
        runner: async ({ log: jobLog, signal }) => {
          const result = await startService(config, { signal, onLine: (line) => jobLog(line) })
          jobLog(`服务就绪：embed=${Boolean(result?.embed)} rerank=${Boolean(result?.rerank)}`)
          return result
        },
      })
    }
    if (action === 'restart') {
      return startJob({
        kind: 'warm',
        label: '重启向量服务',
        runner: async ({ log: jobLog, signal }) => {
          jobLog('停止旧进程…')
          await stopService(config)
          jobLog('重新加载模型…')
          const result = await startService(config, { signal, onLine: (line) => jobLog(line) })
          jobLog(`服务就绪：embed=${Boolean(result?.embed)} rerank=${Boolean(result?.rerank)}`)
          return result
        },
      })
    }
    throw badRequest(`未知的服务操作：${action || '（空）'}`)
  }

  /**
   * Cross-drive project sources: add a directory, remove one, or index it right away.
   * Indexing respects `name`: only that project's files are re-embedded.
   */
  async function projectsRoute(body) {
    const action = String(body?.action ?? 'list')
    if (action === 'list') {
      const listed = await listProjects()
      return { ok: true, ...listed }
    }
    if (action === 'add') {
      const root = String(body?.root ?? '').trim()
      if (!root) throw badRequest('请填写项目目录')
      const result = await registerProject(root)
      if (result?.ok && result.added) note(`已登记项目源：${result.source.label}（${result.source.root}）`)
      return result
    }
    if (action === 'remove') {
      const name = String(body?.name ?? '').trim()
      if (!name) throw badRequest('请指定要移除的项目源')
      const result = await removeProject(name)
      if (result?.ok) note(`已移除项目源：${name}`)
      return result
    }
    if (action === 'index') {
      const name = String(body?.name ?? '').trim()
      const { config } = await readConfig()
      return startJob({
        kind: 'index',
        label: name ? `索引项目 ${name}` : '索引全部源',
        runner: async ({ log: jobLog, signal }) => {
          const stats = await buildIndex(config, {
            force: false,
            only: name ? [name] : undefined,
            signal,
            onLine: (line) => jobLog(line),
          })
          jobLog(indexLabel(stats))
          return stats
        },
      })
    }
    throw badRequest(`未知的项目操作：${action}`)
  }

  async function openRoute(body) {
    const target = String(body?.target ?? '')
    const { config } = await readConfig()
    const targets = {
      config: configPath(),
      data: config.data_dir,
      engine: engineDir(),
      logs: `${config.data_dir}/logs`,
    }
    const resolved = targets[target]
    if (!resolved) throw badRequest(`未知目录：${target || '（空）'}`)
    return openPath(resolved)
  }

  /** Relative path (no prefix) -> handler. Both dispatch and registration read this table. */
  const ROUTES = [
    ['GET', '/state', () => state()],
    ['GET', '/jobs', () => ({ ok: true, active: publicJob(activeJob()), jobs: summariseJobs() })],
    [
      'GET',
      '/job',
      ({ url }) => {
        const job = getJob(url.searchParams.get('id'))
        if (!job) throw new HttpError(404, '任务不存在')
        return { ok: true, job: publicJob(job) }
      },
    ],
    ['GET', '/health', async () => ({ ok: true, service: await health((await readConfig()).config) })],
    ['POST', '/config', ({ body }) => configRoute(body)],
    ['POST', '/config/reset', () => resetRoute()],
    ['POST', '/index', ({ body }) => indexRoute(body)],
    ['POST', '/job/cancel', ({ body }) => cancelRoute(body)],
    ['POST', '/service', ({ body }) => serviceRoute(body)],
    ['POST', '/search', ({ body }) => searchRoute(body)],
    ['POST', '/projects', ({ body }) => projectsRoute(body)],
    ['POST', '/open', ({ body }) => openRoute(body)],
  ]
  const BY_PATH = new Map(ROUTES.map(([method, path, handler]) => [path, { method, handler }]))

  /**
   * @param {object} req node-style request
   * @param {object} res node-style response
   * @param {{ transport?: 'fetch' | 'webServer' | 'legacy' }} options
   *   `fetch` = host-authenticated channel; the other two are ordinary HTTP routes and must
   *   additionally prove they come from a loopback Host.
   */
  async function route(req, res, { transport = 'fetch' } = {}) {
    const raw = new URL(req.url ?? '/', 'http://localhost')
    const method = (req.method ?? 'GET').toUpperCase()
    let path = raw.pathname
    const legacy = path === LEGACY_PREFIX || path.startsWith(`${LEGACY_PREFIX}/`)
    if (legacy) path = PREFIX + path.slice(LEGACY_PREFIX.length)

    try {
      if (String(req.headers['sec-fetch-site'] ?? '') === 'cross-site') {
        return json(res, 403, { ok: false, error: '不允许跨站请求' })
      }
      if (req.headers[CLIENT_HEADER_NAME] !== CLIENT_HEADER) {
        return json(res, 403, { ok: false, error: '只接受来自「向量记忆」设置页的请求' })
      }
      if (transport !== 'fetch' && !isLoopbackHost(req.headers.host)) {
        return json(res, 403, { ok: false, error: '只接受本机地址的请求' })
      }

      const relative = path.startsWith(PREFIX) ? path.slice(PREFIX.length) : null
      const entry = relative ? BY_PATH.get(relative) : null
      if (!entry) return json(res, 404, { ok: false, error: `未知接口：${raw.pathname}` })
      if (entry.method !== method) {
        return json(res, 405, { ok: false, error: `接口只支持 ${entry.method}` })
      }
      if (legacy && entry.method !== 'GET') {
        // The legacy prefix exists only to keep the page rendering when the authenticated channel
        // is unavailable; it must never be a mutation path (it is protected by a static header).
        return json(res, 403, { ok: false, error: '兼容通道只读：当前无法执行操作，请重启 DSH 或检查认证通道' })
      }

      let body = {}
      if (method === 'POST') {
        try {
          body = await readJsonBody(req)
        } catch (error) {
          throw error instanceof HttpError ? error : badRequest(describeError(error))
        }
      }
      const value = await entry.handler({ body, url: raw, req })
      return json(res, 200, value)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      if (status >= 500) {
        try {
          log(`[vector-memory] ${method} ${raw.pathname} 失败：${describeError(error)}`)
          log(String(error?.stack ?? '').split('\n').slice(0, 6).join('\n'))
        } catch {
          // ignore
        }
      }
      return json(res, status, { ok: false, error: describeError(error) })
    }
  }

  return { route, state, searchRoute, configRoute, indexRoute, serviceRoute, projectsRoute, ROUTES }
}

/** Present one Fetch request as the node-style req the dispatcher already speaks. */
function nodeRequestOf(request, bodyText) {
  const url = new URL(request.url)
  const headers = {}
  for (const [key, value] of request.headers) headers[String(key).toLowerCase()] = value
  const req = {
    method: String(request.method ?? 'GET').toUpperCase(),
    url: `${url.pathname}${url.search}`,
    headers,
  }
  if (typeof bodyText === 'string') {
    const buf = Buffer.from(bodyText, 'utf8')
    req[Symbol.asyncIterator] = async function* iterate() {
      yield buf
    }
  }
  return req
}

/** Collect what the dispatcher writes so it can be returned as a Fetch Response. */
function responseSink() {
  const state = { status: 200, headers: {}, chunks: [] }
  const res = {
    get statusCode() {
      return state.status
    },
    set statusCode(value) {
      state.status = Number(value) || 200
    },
    setHeader(key, value) {
      state.headers[String(key).toLowerCase()] = String(value)
    },
    removeHeader(key) {
      delete state.headers[String(key).toLowerCase()]
    },
    writeHead(status, headers) {
      state.status = Number(status) || state.status
      if (headers && typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) state.headers[String(key).toLowerCase()] = String(value)
      }
    },
    write(chunk) {
      if (chunk !== undefined && chunk !== null) state.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
      return true
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) state.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
      return res
    },
    on() {},
    once() {},
  }
  return {
    res,
    state,
    bodyText: () => Buffer.concat(state.chunks).toString('utf8'),
  }
}

/**
 * Register the page's API.
 *
 * Prefers the host's authenticated API channel (`connection.fetch.register`, DSH 0.2.2+).
 * When that channel is mounted a read-only legacy prefix is also exposed, so a future host that
 * stops forwarding the channel can still render the page. Older hosts use the plain prefix route.
 */
export function registerVectorMemoryRoutes(
  ctx,
  { version, meta = null, supervisor, recall = null, projects = null, log } = {},
) {
  const note = (message) => {
    try {
      log?.(message)
    } catch {
      // ignore
    }
  }
  const routes = makeRoutes({ version, meta, supervisor, recall, projects, log, ctx })
  const ENDPOINTS = routes.ROUTES.map(([method, path]) => ({ path: `${PREFIX}${path}`, methods: [method] }))

  const asFetch = async (request) => {
    const method = String(request.method ?? 'GET').toUpperCase()
    const declared = Number(request.headers.get('content-length') || 0)
    if (method === 'POST' && Number.isFinite(declared) && declared > BODY_LIMIT) {
      return new Response(JSON.stringify({ ok: false, error: '请求体过大' }), {
        status: 413,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    let bodyText = null
    if (method === 'POST') {
      try {
        bodyText = await request.text()
      } catch {
        bodyText = ''
      }
      if (bodyText.length > BODY_LIMIT) {
        return new Response(JSON.stringify({ ok: false, error: '请求体过大' }), {
          status: 413,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
    }
    const sink = responseSink()
    await routes.route(nodeRequestOf(request, bodyText), sink.res, { transport: 'fetch' })
    const headers = { ...sink.state.headers }
    if (!headers['content-type']) headers['content-type'] = 'application/json; charset=utf-8'
    headers['cache-control'] = 'no-store'
    return new Response(sink.bodyText() || null, { status: sink.state.status, headers })
  }

  const webServer = ctx.get?.('webServer')
  const connection = ctx.get?.('connection')
  const fetchRegistry = connection?.fetch

  if (fetchRegistry && typeof fetchRegistry.register === 'function') {
    const disposers = []
    try {
      for (const endpoint of ENDPOINTS) {
        const off = fetchRegistry.register({
          path: endpoint.path,
          methods: endpoint.methods,
          requestBody: 'buffered',
          fetch: asFetch,
        })
        disposers.push(off)
      }
      note(`设置页接口已挂载到 DSH 认证通道（${ENDPOINTS.length} 条精确路由）`)

      let legacyDispose = null
      if (webServer?.register) {
        try {
          legacyDispose = webServer.register({
            kind: 'prefix',
            path: LEGACY_PREFIX,
            handler: (req, res) => routes.route(req, res, { transport: 'legacy' }),
          })
          note(`兼容前缀已挂载（只读）：${LEGACY_PREFIX}`)
        } catch (error) {
          note(`兼容前缀挂载失败：${describeError(error)}`)
        }
      }
      return {
        transport: 'fetch',
        routes,
        endpoints: ENDPOINTS,
        legacyPrefix: legacyDispose ? LEGACY_PREFIX : null,
        dispose: async () => {
          for (const off of disposers) {
            try {
              await off?.()
            } catch {
              // ignore
            }
          }
          try {
            await legacyDispose?.()
          } catch {
            // ignore
          }
        },
      }
    } catch (error) {
      note(`认证通道路由注册失败，回退 webServer：${describeError(error)}`)
      for (const off of disposers) {
        try {
          const removing = off?.()
          if (removing && typeof removing.catch === 'function') removing.catch(() => {})
        } catch {
          // ignore
        }
      }
    }
  }

  if (!webServer?.register) {
    note('webServer 不可用，设置页不会被加载')
    return { transport: 'none', routes, endpoints: ENDPOINTS, dispose: () => {} }
  }
  const dispose = webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => routes.route(req, res, { transport: 'webServer' }),
  })
  note(`设置页接口已挂载（兼容模式）：${PREFIX}`)
  return {
    transport: 'webServer',
    routes,
    endpoints: ENDPOINTS,
    dispose: async () => {
      try {
        if (typeof dispose === 'function') await dispose()
      } catch {
        // ignore
      }
    },
  }
}

export const __routesTest = { PREFIX, LEGACY_PREFIX, CLIENT_HEADER, CLIENT_HEADER_NAME, BODY_LIMIT }
