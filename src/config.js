import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Configuration for the vector memory engine.
 *
 * The Python engine (engine/vsearch.py, vindex.py, vecserve.py) and this plugin
 * share exactly one JSON file, so there is only one place where a value can
 * live. The engine reads `--config <this file>`; the plugin reads and writes it.
 *
 * Nothing here hardcodes a machine path: every location is derived from the
 * plugin directory, an environment variable, or the OS conventions below. On
 * the first run a config file is materialized with those concrete paths so the
 * Python side never has to guess.
 *
 * Unknown keys are preserved on write: the engine may grow keys faster than this
 * page does, and silently dropping them would be a nasty surprise.
 */

export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const BUNDLED_ENGINE_DIR = join(PLUGIN_DIR, 'engine')
export const IS_WINDOWS = platform() === 'win32'

function venvPython(root) {
  return IS_WINDOWS ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python')
}

/** Directory that holds the bundled Python engine. */
export function engineDir() {
  const override = process.env.DSH_VECTOR_MEMORY_DIR
  if (override && existsSync(join(override, 'vsearch.py'))) return resolve(override)
  return BUNDLED_ENGINE_DIR
}

export function cliPath() {
  return join(engineDir(), 'vsearch.py')
}

export function configPath() {
  const override = process.env.DSH_VECTOR_MEMORY_CONFIG
  if (override) return resolve(override)
  return join(engineDir(), 'config.json')
}

export function engineAvailable() {
  return existsSync(cliPath())
}

/**
 * Where the index/cache lives. Small (a few MB), so the OS user-data directory
 * is the right default; users can point it elsewhere from the settings file.
 */
export function defaultDataDir() {
  const override = process.env.DSH_VECTOR_MEMORY_DATA
  if (override) return resolve(override)
  if (IS_WINDOWS) {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(local, 'dsh-vector-memory')
  }
  return join(homedir(), '.local', 'share', 'dsh-vector-memory')
}

/**
 * Candidate interpreters, in order. The setup script creates <plugin>/.venv, so
 * that one is tried before anything on PATH.
 */
export function pythonCandidates() {
  const list = []
  for (const root of [PLUGIN_DIR, engineDir()]) list.push(venvPython(root))
  if (IS_WINDOWS) list.push(join(PLUGIN_DIR, '.venv', 'Scripts', 'python.exe'))
  return list
}

export const DEFAULTS = {
  // Empty means "discover it": the first run fills these in with concrete paths.
  python: '',
  data_dir: '',
  models: {
    // Hugging Face repo ids work directly: sentence-transformers/transformers
    // download them on first use (honouring HF_ENDPOINT, e.g. a mirror).
    embed: 'Qwen/Qwen3-Embedding-0.6B',
    rerank: 'Qwen/Qwen3-Reranker-0.6B',
  },
  service: {
    host: '127.0.0.1',
    port: 8479,
    threads: 8,
    start_timeout_sec: 90,
    prewarm: true,
    restart_on_crash: true,
    exit_with_dsh: true,
    rerank_idle_unload_min: 5,
    embed_idle_unload_min: 0,
    // Refuse to bind a non-loopback interface unless this is explicitly true.
    allow_remote: false,
  },
  embed: {
    dim: 1024,
    query_instruction:
      'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ',
    batch: 4,
  },
  // Empty by default: a fresh install has nothing to index until you point it at
  // a notes folder (settings page → 项目, or `setup.ps1 -Sources`).
  sources: [],
  chunk: { max_chars: 1200, min_chars: 40 },
  search: {
    k: 5,
    candidates: 30,
    rerank: false,
    rerank_top: 8,
    rrf_k: 60,
    max_snippet: 260,
  },
  index: {
    auto: true,
    on_startup: true,
    interval_min: 0,
    startup_delay_sec: 12,
  },
  // Project sources: a session's working directory is auto-registered as a
  // source and shares the same index/search pipeline.
  project_sources: [],
  project_index: {
    auto_register: true,
    auto_index: true,
    recall_scoped: true,
    extensions: ['.md', '.mdx', '.txt', '.rst'],
    max_files: 200,
    max_file_kb: 512,
    exclude_dirs: [],
  },
  recall: {
    enabled: true,
    k: 3,
    min_cos: 0.3,
    max_chars: 1000,
    timeout_ms: 1500,
    rerank: false,
    min_query_chars: 6,
    require_context: false,
  },
  ui: {
    language: 'auto',
  },
}

/** DEFAULTS with the discoverable paths made concrete (used for the first write). */
export function materializeDefaults() {
  const config = clone(DEFAULTS)
  config.data_dir = defaultDataDir()
  const python = pythonCandidates().find((candidate) => existsSync(candidate))
  config.python = python || ''
  return config
}

/**
 * Make sure a config file exists. Returns { created, path }.
 * Creating it early means the Python engine and the settings page always see
 * the same, fully spelled-out file.
 */
export async function seedConfig() {
  const path = configPath()
  if (existsSync(path)) return { created: false, path }
  await writeConfig(materializeDefaults())
  return { created: true, path }
}

/**
 * Every editable value with its accepted range. Anything not listed here is not
 * editable from the settings page (paths and source definitions stay file-only
 * on purpose: a wrong path there would break the engine silently).
 */
export const LIMITS = [
  { path: 'search.k', type: 'int', min: 1, max: 30, label: '每次返回条数' },
  { path: 'search.candidates', type: 'int', min: 5, max: 200, label: '候选池大小' },
  { path: 'search.rerank', type: 'bool', label: '默认启用重排' },
  { path: 'search.rerank_top', type: 'int', min: 1, max: 50, label: '重排候选数' },
  { path: 'search.max_snippet', type: 'int', min: 60, max: 2000, label: '摘要长度' },
  { path: 'search.rrf_k', type: 'int', min: 1, max: 1000, label: 'RRF 平滑常数' },
  { path: 'chunk.max_chars', type: 'int', min: 200, max: 8000, label: '单块最大字数' },
  { path: 'chunk.min_chars', type: 'int', min: 0, max: 1000, label: '单块最小字数' },
  { path: 'index.auto', type: 'bool', label: '自动增量索引' },
  { path: 'index.on_startup', type: 'bool', label: '启动时索引一次' },
  { path: 'index.interval_min', type: 'int', min: 0, max: 1440, label: '定时索引间隔（分钟）' },
  { path: 'index.startup_delay_sec', type: 'int', min: 2, max: 600, label: '启动延迟（秒）' },
  { path: 'project_index.auto_register', type: 'bool', label: '自动登记会话所在项目' },
  { path: 'project_index.auto_index', type: 'bool', label: '登记后自动索引项目文档' },
  { path: 'project_index.recall_scoped', type: 'bool', label: '向量检索按项目隔离（推荐）' },
  { path: 'project_index.max_files', type: 'int', min: 10, max: 2000, label: '单个项目最多索引文件数' },
  { path: 'project_index.max_file_kb', type: 'int', min: 16, max: 4096, label: '单文件大小上限（KB）' },
  { path: 'recall.enabled', type: 'bool', label: '向量检索（自动召回）' },
  { path: 'recall.k', type: 'int', min: 1, max: 10, label: '自动召回条数' },
  { path: 'recall.min_cos', type: 'number', min: 0, max: 1, label: '自动召回相关度阈值' },
  { path: 'recall.max_chars', type: 'int', min: 200, max: 4000, label: '自动召回字符上限' },
  { path: 'recall.timeout_ms', type: 'int', min: 200, max: 6000, label: '自动召回超时（毫秒）' },
  { path: 'recall.rerank', type: 'bool', label: '自动召回使用重排' },
  { path: 'recall.min_query_chars', type: 'int', min: 0, max: 50, label: '自动召回最小提问长度' },
  { path: 'recall.require_context', type: 'bool', label: '强制注入（宿主关闭运行时上下文时仍保留）' },
  { path: 'service.threads', type: 'int', min: 1, max: 32, label: '推理线程数' },
  { path: 'service.port', type: 'int', min: 1024, max: 65535, label: '服务端口' },
  { path: 'service.start_timeout_sec', type: 'int', min: 10, max: 600, label: '启动超时（秒）' },
  { path: 'service.prewarm', type: 'bool', label: '自动预热服务' },
  { path: 'service.restart_on_crash', type: 'bool', label: '崩溃后自动拉起' },
  { path: 'service.exit_with_dsh', type: 'bool', label: 'DSH 退出时关闭服务' },
  { path: 'service.rerank_idle_unload_min', type: 'int', min: 0, max: 1440, label: '重排模型空闲卸载（分钟，0=不卸）' },
  { path: 'service.embed_idle_unload_min', type: 'int', min: 0, max: 1440, label: '嵌入模型空闲卸载（分钟，0=不卸）' },
  { path: 'ui.language', type: 'enum', values: ['auto', 'zh'], label: '界面语言' },
]

const LIMIT_INDEX = new Map(LIMITS.map((item) => [item.path, item]))

export function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = deepMerge(out[key], value)
    else out[key] = value
  }
  return out
}

export function getPath(object, path) {
  let cursor = object
  for (const key of path.split('.')) {
    if (cursor == null) return undefined
    cursor = cursor[key]
  }
  return cursor
}

export function setPath(object, path, value) {
  const keys = path.split('.')
  let cursor = object
  for (const key of keys.slice(0, -1)) {
    if (cursor[key] == null || typeof cursor[key] !== 'object') cursor[key] = {}
    cursor = cursor[key]
  }
  cursor[keys[keys.length - 1]] = value
}

/** Read the config file; returns { config, path, error, raw } and never throws. */
export async function readConfig() {
  const path = configPath()
  let raw = null
  let error = null
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  const config = deepMerge(clone(DEFAULTS), raw || {})
  if (!config.data_dir) config.data_dir = defaultDataDir()
  if (!config.python) {
    const candidate = pythonCandidates().find((item) => existsSync(item))
    config.python = candidate || ''
  }
  return { config, path, raw, error }
}

async function fileSize(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}

/** Atomic write: tmp file + rename, with one .bak of the previous content. */
export async function writeConfig(config) {
  const path = configPath()
  await mkdir(dirname(path), { recursive: true })
  const existed = existsSync(path)
  if (existed) {
    try {
      await copyFile(path, `${path}.bak`)
    } catch {
      // keeping the previous file is best effort; the write below still matters
    }
  }
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
  return { path, bytes: await fileSize(path), hadBackup: existed }
}

/**
 * Validate and normalize a patch coming from the settings page.
 * Returns { patch, warnings } and throws on a value that cannot be accepted.
 */
export function normalizePatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数必须是对象')
  const flat = []
  const walk = (value, prefix) => {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (child && typeof child === 'object' && !Array.isArray(child)) walk(child, path)
      else flat.push([path, child])
    }
  }
  walk(input, '')
  const patch = {}
  const warnings = []
  for (const [path, value] of flat) {
    const limit = LIMIT_INDEX.get(path)
    if (!limit) {
      warnings.push(`忽略未知或只读参数：${path}`)
      continue
    }
    if (limit.type === 'bool') {
      if (typeof value !== 'boolean') throw new Error(`${limit.label} 必须是 true/false`)
      setPath(patch, path, value)
      continue
    }
    if (limit.type === 'enum') {
      if (!limit.values.includes(value)) throw new Error(`${limit.label} 只能是 ${limit.values.join(' / ')}`)
      setPath(patch, path, value)
      continue
    }
    const number = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(number)) throw new Error(`${limit.label} 必须是数字`)
    if (!Number.isInteger(number) && limit.type === 'int') throw new Error(`${limit.label} 必须是整数`)
    if (number < limit.min || number > limit.max) {
      throw new Error(`${limit.label} 必须在 ${limit.min}–${limit.max} 之间（收到 ${number}）`)
    }
    setPath(patch, path, number)
  }
  const k = getPath(patch, 'search.k')
  const candidates = getPath(patch, 'search.candidates')
  if (k != null && candidates != null && candidates < k) throw new Error('候选池大小不能小于每次返回条数')
  return { patch, warnings }
}

/** Merge a validated patch into the file and return the new config. */
export async function updateConfig(input) {
  const { patch, warnings } = normalizePatch(input)
  if (Object.keys(patch).length === 0) {
    const current = await readConfig()
    return { config: current.config, warnings, changed: false }
  }
  const current = await readConfig()
  const next = deepMerge(clone(current.config), patch)
  const written = await writeConfig(next)
  return { config: next, warnings, changed: true, path: written.path, bytes: written.bytes }
}
