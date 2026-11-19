import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  PLUGIN_DIR,
  cliPath,
  configPath,
  defaultDataDir,
  engineAvailable,
  engineDir,
  firstExistingPython,
  pythonCandidates,
} from './paths.js'

/**
 * Configuration for the vector memory engine.
 *
 * The Python engine (vsearch.py / vindex.py / vecserve.py) and this plugin share
 * exactly one JSON file, so there is only one place where a value can live. The
 * engine reads `--config <this file>`; the plugin reads and writes it here.
 *
 * Unknown keys are preserved on write: the engine may grow keys faster than this
 * page does, and silently dropping them would be a nasty surprise.
 *
 * 路径怎么来的见 paths.js——这里只声明"默认值长什么样"，不再写死任何一台机器的位置。
 */

// 兼容旧导入路径（engine.js / routes.js / sessionprefs.js 都从 config.js 拿）。
export { PLUGIN_DIR, cliPath, configPath, engineAvailable, engineDir, defaultDataDir, pythonCandidates }

export const DEFAULTS = {
  // 空串 = 第一次运行时自动探测（见 paths.js 的 pythonCandidates）。
  python: '',
  data_dir: '',
  models: {
    // Hugging Face 仓库 id 可以直接用：transformers 首次使用时下载（支持 HF_ENDPOINT 镜像）。
    embed: 'Qwen/Qwen3-Embedding-0.6B',
    rerank: 'Qwen/Qwen3-Reranker-0.6B',
  },
  service: {
    max_concurrent: 6,
    host: '127.0.0.1',
    port: 8479,
    threads: 12,
    start_timeout_sec: 90,
    prewarm: true,
    restart_on_crash: true,
    exit_with_dsh: true,
    rerank_idle_unload_min: 5,
    embed_idle_unload_min: 0,
    // 全量重建会让服务内存一路涨（实测每块约 +2.2MB，5000 块到 ~10GB，且不回落）。
    // 重建后如果服务 RSS 超过这个值，就重启一次服务把内存还回去（0 = 从不重启）。
    recycle_rss_mb: 3000,
    recycle_idle_min: 10,
    // 拒绝绑定非回环地址，除非显式打开（发布版的安全默认）。
    allow_remote: false,
  },
  embed: {
    dim: 1024,
    query_instruction:
      'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ',
    batch: 4,
  },
  // 首次运行时为空：让用户在设置页里添加自己的文档目录（发布版不会替你猜路径）。
  // 本机真实目录写在 config.json 里，不在代码里。
  sources: [],
  chunk: { max_chars: 1200, min_chars: 40, split_long: false, split_chars: 700 },
  search: {
    k: 5,
    candidates: 30,
    rerank: false,
    rerank_top: 8,
    rrf_k: 60,
    max_snippet: 260,
    // 查询里出现符号名（如 `chunk_code`、`GameMode`）时，字面命中块的分数加成。
    // 量纲对齐 RRF：1.0 ≈「命中一个符号」等价于「某一路排第一」。0 = 关闭。
    // 实测（10 道代码题）：0 → R@1 10%、1.5 → 20%、3.0 与 1.5 相同（饱和）。
    ident_boost: 1.5,
  },
  outline: { enabled: true, per_src: 4, max_sources: 4, max_topics: 3, max_chars: 700 },
  index: {
    auto: true,
    on_startup: true,
    interval_min: 0,
    startup_delay_sec: 12,
  },
  // 跨盘项目：会话所在目录会被自动登记成一个源，和 memory 走同一条索引/检索链路。
  project_sources: [],
  project_index: {
    auto_register: true,
    auto_index: true,
    recall_scoped: true,
    // 文档 + 代码。代码不做语义切块，只抽顶层符号（函数/类/类型），
    // 「XX 在哪定义」这类问题靠 BM25 命中路径与符号名即可，向量只做补充。
    extensions: [
      '.md', '.mdx', '.txt', '.rst', '.docx', '.pdf',
      '.py', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
      '.cs', '.gd', '.lua',
    ],
    max_files: 200,
    max_file_kb: 512,
    // PDF 天生比文本大（65 页中文论文 4-8MB），用 512KB 的通用上限会把它们全排除，
    // 所以 PDF 单独给一个更宽的上限；扫描件没有文本层，索引时会静默产出 0 块。
    max_pdf_kb: 8192,
    exclude_dirs: [],
    code_index: true,
    max_symbols_per_file: 20,
  },
  recall: {
    enabled: true,
    k: 3,
    // 0.45 comes from a measured sweep (evals/reports): below ~0.42 unrelated
    // questions still return 3 chunks (max cosine 0.28-0.47 on this corpus),
    // while every correct top-1 hit sits at 0.41-0.86. 0.45 suppresses ~5/6 of
    // the hallucination cases while costing ~3 points of Recall@1.
    min_cos: 0.45,
    weak_cos: 0.55,
    max_chars: 1000,
    timeout_ms: 1500,
    rerank: false,
    min_query_chars: 6,
    require_context: false,
    // 每条命中带日期（正文里的 YYYY-MM-DD 优先，否则文件 mtime）；
    // 超过 stale_days 天的标「较早」——这是模型判断"这条还作不作数"的唯一客观线索。
    show_date: true,
    stale_days: 180,
  },
  ui: {
    language: 'auto',
  },
  // 开场简报：新会话第一个请求就注入「同一目录最近几个会话」的极短摘要，
  // 治「新开会话不知道上一轮聊到哪儿」。数据来自会话归档 manifest（只读）。
  cards: {
    enabled: true,
    k: 1,
    min_score: 12,
    max_chars: 320,
  },
  handoff: {
    enabled: true,
    max_sessions: 3,
    max_chars: 560,
    // 留空 = <data_dir>/transcripts（归档脚本的默认输出目录）
    transcripts_dir: '',
    // 归档器：DSH 会话存档目录留空 = 自动探测（~/.dsh/sessions，可用 DSH_VECTOR_MEMORY_SESSIONS 覆盖）
    sessions_dir: '',
    auto_archive: true,
    archive_interval_min: 120,
  },
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
  { path: 'outline.enabled', type: 'bool', label: '知识地图（结构派生）' },
  { path: 'outline.per_src', type: 'int', min: 2, max: 12, label: '每个源列几个主题' },

  { path: 'chunk.split_long', type: 'bool', label: '长条目细切（检索用子块、展示用整条）' },
  { path: 'chunk.split_chars', type: 'int', min: 300, max: 2000, label: '细切目标长度（字符）' },  { path: 'search.ident_boost', type: 'number', min: 0, max: 5, label: '符号名命中加成（0=关闭）' },
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
  { path: 'project_index.max_pdf_kb', type: 'int', min: 256, max: 65536, label: 'PDF 大小上限（KB）' },
  { path: 'project_index.code_index', type: 'bool', label: '索引代码文件（只抽顶层符号）' },
  { path: 'project_index.max_symbols_per_file', type: 'int', min: 5, max: 50, label: '每个代码文件最多索引符号数' },
  { path: 'recall.enabled', type: 'bool', label: '向量检索（自动召回）' },
  { path: 'recall.k', type: 'int', min: 1, max: 10, label: '自动召回条数' },
  { path: 'recall.min_cos', type: 'number', min: 0, max: 1, label: '自动召回相关度阈值' },
  { path: 'recall.weak_cos', type: 'number', min: 0, max: 1, label: '弱相关标注阈值' },
  { path: 'recall.max_chars', type: 'int', min: 200, max: 4000, label: '自动召回字符上限' },
  { path: 'recall.timeout_ms', type: 'int', min: 200, max: 6000, label: '自动召回超时（毫秒）' },
  { path: 'recall.rerank', type: 'bool', label: '自动召回使用重排' },
  { path: 'recall.min_query_chars', type: 'int', min: 0, max: 50, label: '自动召回最小提问长度' },
  { path: 'recall.require_context', type: 'bool', label: '强制注入（宿主关闭运行时上下文时仍保留）' },
  { path: 'recall.show_date', type: 'bool', label: '命中标注日期' },
  { path: 'recall.stale_days', type: 'int', min: 1, max: 3650, label: '超过多少天标「较早」' },
  { path: 'cards.enabled', type: 'bool', label: '归档卡片（旧会话的压缩摘要按需注入）' },
  { path: 'cards.k', type: 'int', min: 1, max: 3, label: '归档卡片每轮最多注入几条' },
  { path: 'cards.min_score', type: 'int', min: 0, max: 60, label: '归档卡片最低匹配分（越高越保守）' },
  { path: 'cards.max_chars', type: 'int', min: 80, max: 1200, label: '归档卡片正文上限（字符）' },
  { path: 'handoff.enabled', type: 'bool', label: '开场简报（注入上一轮会话摘要）' },
  { path: 'handoff.max_sessions', type: 'int', min: 1, max: 8, label: '开场简报最多几个会话' },
  { path: 'handoff.max_chars', type: 'int', min: 120, max: 2000, label: '开场简报字数上限' },
  { path: 'handoff.auto_archive', type: 'bool', label: '自动归档会话（供开场简报使用）' },
  { path: 'handoff.archive_interval_min', type: 'int', min: 15, max: 1440, label: '归档检查间隔（分钟）' },
  { path: 'service.threads', type: 'int', min: 1, max: 32, label: '推理线程数' },
  { path: 'service.port', type: 'int', min: 1024, max: 65535, label: '服务端口' },
  { path: 'service.start_timeout_sec', type: 'int', min: 10, max: 600, label: '启动超时（秒）' },
  { path: 'service.prewarm', type: 'bool', label: '自动预热服务' },
  { path: 'service.restart_on_crash', type: 'bool', label: '崩溃后自动拉起' },
  { path: 'service.exit_with_dsh', type: 'bool', label: 'DSH 退出时关闭服务' },
  { path: 'service.rerank_idle_unload_min', type: 'int', min: 0, max: 1440, label: '重排模型空闲卸载（分钟，0=不卸）' },
  { path: 'service.embed_idle_unload_min', type: 'int', min: 0, max: 1440, label: '嵌入模型空闲卸载（分钟，0=不卸）' },
  { path: 'service.max_concurrent', type: 'int', min: 1, max: 16, label: '同时检索的并发上限（默认 6；多了排队，按 CPU 核数调）' },
    { path: 'service.recycle_idle_min', type: 'int', min: 0, max: 720, label: '内存超阈值后空闲多少分钟才重启回收（0=立刻）' },
    { path: 'service.recycle_rss_mb', type: 'int', min: 0, max: 60000, label: '重建后内存超多少 MB 就重启服务（0=不重启）' },
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
  // 空值 = 没配过：第一次运行时把探测结果落成具体路径，这样 Python 侧不用再猜。
  if (!config.data_dir) config.data_dir = defaultDataDir()
  if (!config.python) config.python = firstExistingPython()
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
/**
 * 把「会话卡片」登记成一个固定源（S3.5）：<data_dir>/cards 下是归档器物化出来的摘要 md。
 * 只增不改；已经有同名源就直接返回 false。这样跨会话的"以前聊过什么"也能走向量，
 * 而代价只有 200 多块（对比全量对话 1.5 万块）。
 */
export async function ensureCardsSource(log = () => {}) {
  try {
    const { config } = await readConfig()
    const list = Array.isArray(config?.sources) ? config.sources : []
    if (list.some((item) => item && item.name === 'cards')) return false
    const root = join(String(config?.data_dir || defaultDataDir()), 'cards')
    const next = { ...config, sources: [...list, { name: 'cards', label: '会话卡片', root, globs: ['**/*.md'], enabled: true }] }
    await writeConfig(next)
    log(`已登记会话卡片源：${root}`)
    return true
  } catch (error) {
    log(`登记会话卡片源失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

export async function updateConfig(input) {  const { patch, warnings } = normalizePatch(input)
  if (Object.keys(patch).length === 0) {
    const current = await readConfig()
    return { config: current.config, warnings, changed: false }
  }
  const current = await readConfig()
  const next = deepMerge(clone(current.config), patch)
  const written = await writeConfig(next)
  return { config: next, warnings, changed: true, path: written.path, bytes: written.bytes }
}


