/**
 * 「归纳层」：由引擎从索引结构派生主题地图（不调用任何模型），
 * 压缩成一小段给模型看的「知识地图」，让它知道这里有哪些主题、分布在哪。
 *
 * 渲染路径必须同步，所以 text() 只返回上一次成功快照，后台刷新。
 */
import { runCli, parseJsonOutput } from './engine.js'
import { readConfig } from './config.js'

const REFRESH_MS = 120_000
const DEFAULTS = { enabled: true, per_src: 4, max_sources: 4, max_topics: 3, max_chars: 700 }

function pick(outlineCfg) {
  const cfg = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (outlineCfg && outlineCfg[key] !== undefined && outlineCfg[key] !== null) cfg[key] = outlineCfg[key]
  }
  return cfg
}

function clip(text, n) {
  const s = String(text || '')
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

export function createOutline({ log = () => {}, readConfigImpl = readConfig } = {}) {
  const state = { text: '', at: 0, warming: false, lastError: null, sources: 0, topics: 0 }

  function buildText(result, options) {
    const sources = Array.isArray(result?.sources) ? result.sources : []
    if (!sources.length) return ''
    const lines = []
    for (const source of sources.slice(0, options.max_sources)) {
      const dirs = (source.clusters || [])
        // 三个目录而不是两个：实测方向覆盖率 68.2% → 72.7%（`evals/eval_outline.py`），
        // 多出来的 60 字符买到的定位能力值得。
        .slice(0, 3)
        .map((c) => `${c.path}(${c.chunks})`)
        .join('、')
      const topics = (source.topics || [])
        .slice(0, options.max_topics)
        .map((t) => t.topic)
        .join('/')
      const parts = []
      if (dirs) parts.push(dirs)
      if (topics) parts.push('主题 ' + topics)
      if (!parts.length) continue
      lines.push(`- ${source.label}：${parts.join(' · ')}`)
    }
    if (!lines.length) return ''
    const body = clip(lines.join('\n'), options.max_chars)
    return (
      '【本机知识地图】以下是本机已索引内容的结构（由文件标题与目录派生，不是模型总结）：\n' +
      body +
      '\n问「某个东西在哪」时先看这里判断方向，再用 vmemory_search 精确定位；需要展开某个源的全部主题用 vmemory_outline。'
    )
  }

  async function warm() {
    if (state.warming) return state.text
    state.warming = true
    try {
      const { config } = await readConfigImpl()
      const options = pick(config?.outline)
      if (!options.enabled) {
        state.text = ''
        state.at = Date.now()
        return state.text
      }
      const out = await runCli(config, ['outline', '--json', '--per-src', String(Math.max(3, options.per_src))], {
        timeoutMs: 60_000,
      })
      const parsed = parseJsonOutput(out.stdout, 'outline')
      state.text = buildText(parsed, options)
      state.sources = (parsed?.sources || []).length
      state.topics = (parsed?.sources || []).reduce((sum, s) => sum + (s.topics || []).length, 0)
      state.at = Date.now()
      state.lastError = null
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error)
      log(`知识地图生成失败（忽略）：${state.lastError}`)
    } finally {
      state.warming = false
    }
    return state.text
  }

  /** 同步：返回缓存快照；过期时后台刷新。 */
  function text() {
    if (Date.now() - state.at > REFRESH_MS) {
      void warm().catch(() => {})
    }
    return state.text
  }

  return { warm, text, state }
}
