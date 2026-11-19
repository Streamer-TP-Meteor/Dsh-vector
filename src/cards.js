import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { defaultDataDir } from './config.js'

/**
 * 归档卡片：从会话归档里挖「模型当年自己写的压缩摘要」，当成一条条小卡片。
 *
 * 为什么不向量化：本机实测嵌入只有 1.1 块/秒、每块 +2.2MB 且不回落，
 * 489 张卡要 7 分钟 + 1.1GB 内存，而且会和 memory 抢同一个 top-k 通道。
 * 卡片要的是「一句话对上就值」，字面打分够用，且零构建成本、零常驻内存。
 *
 * 数据来源：`<data_dir>/transcripts/**\/*.md` 的 `## 压缩摘要` 段（归档器写的），
 * 每段是一张卡：时间 + 一句标题 + 正文开头。
 */

export const CARD_DEFAULTS = { enabled: true, k: 1, min_score: 12, max_chars: 320 }

export function cardSettings(config) {
  const raw = (config && config.cards) || {}
  const num = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }
  return {
    enabled: raw.enabled !== false,
    k: Math.max(1, Math.min(3, Math.round(num(raw.k, CARD_DEFAULTS.k)))),
    min_score: Math.max(0, num(raw.min_score, CARD_DEFAULTS.min_score)),
    max_chars: Math.max(80, Math.min(1200, Math.round(num(raw.max_chars, CARD_DEFAULTS.max_chars)))),
  }
}

const HEADER = /^###\s*摘要\s*\d+\s*[·・]\s*(.+)$/
const SECTION = /^##\s*压缩摘要/
const NEXT_H2 = /^##\s/

/** 把一份归档 md 里的压缩摘要切成卡片。 */
export function parseCards(text, meta) {
  const lines = String(text ?? '').split(/\r?\n/)
  const cards = []
  let inSection = false
  let current = null
  const flush = () => {
    if (!current) return
    const body = current.body.join('\n').trim()
    if (body) {
      const firstLine = body.split('\n')[0].trim()
      const head = firstLine.length > 90 ? `${firstLine.slice(0, 90)}…` : firstLine
      const rest = body.slice(firstLine.length).replace(/^\s*\n/, '').replace(/\s+/g, ' ').trim()
      const excerpt = (rest || body).replace(/\s+/g, ' ').trim()
      cards.push({
        id: `${meta.sessionId}#${cards.length + 1}`,
        sessionId: meta.sessionId,
        project: meta.project,
        projectLabel: meta.projectLabel,
        sessionTitle: meta.title || '',
        path: meta.path,
        date: current.date,
        title: head,
        excerpt: excerpt.slice(0, 400),
        chars: body.length,
      })
    }
    current = null
  }
  for (const line of lines) {
    if (current) {
      const nextHead = HEADER.exec(line)
      if (nextHead) {
        flush()
        current = { date: nextHead[1].trim(), body: [] }
        continue
      }
      if (SECTION.test(line) || line.startsWith('### ') || NEXT_H2.test(line)) {
        flush()
        inSection = SECTION.test(line)
        continue
      }
      current.body.push(line)
      continue
    }
    if (SECTION.test(line)) {
      inSection = true
      continue
    }
    if (inSection) {
      const hit = HEADER.exec(line)
      if (hit) {
        current = { date: hit[1].trim(), body: [] }
        continue
      }
      if (NEXT_H2.test(line)) inSection = false
    }
  }
  flush()
  return cards
}

export function cjkTerms(query) {
  const out = new Set()
  const lower = String(query ?? '').toLowerCase()
  for (const word of lower.match(/[a-z0-9_.+\-]{2,}/g) || []) {
    if (word.length <= 24) out.add(word)
  }
  const cjk = lower.replace(/[^\u3400-\u9fff]+/g, ' ')
  for (const seg of cjk.split(/\s+/)) {
    if (seg.length < 2) continue
    for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2))
  }
  return [...out]
}

function countOf(haystack, needle) {
  let n = 0
  let at = haystack.indexOf(needle)
  while (at >= 0 && n < 4) {
    n += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return n
}

/** 字面打分：词/双字命中次数 + 标题加成 + 整句命中加成。 */
export function scoreCard(card, query) {
  const terms = cjkTerms(query)
  if (!terms.length) return 0
  const title = String(card.title ?? '').toLowerCase()
  const body = `${card.title ?? ''} ${card.excerpt ?? ''} ${card.sessionTitle ?? ''}`.toLowerCase()
  let score = 0
  for (const term of terms) {
    const inBody = countOf(body, term)
    if (inBody) score += inBody * (term.length >= 4 ? 1.6 : 1)
    if (title.includes(term)) score += 2
  }
  const phrase = String(query ?? '').trim().toLowerCase()
  if (phrase.length >= 4 && body.includes(phrase)) score += 4
  return score
}

function clip(text, max) {
  const s = String(text ?? '').trim()
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

export function createCards({ log = () => {}, readConfigImpl } = {}) {
  let cache = null
  let cacheAt = 0
  let cacheKey = ''
  const stats = { calls: 0, injected: 0, skipped: 0, best: 0, lastQuery: '', lastAt: 0, cards: 0 }

  function transcriptsDir(config) {
    const fromEnv = String(process.env.DSH_VECTOR_MEMORY_TRANSCRIPTS ?? '').trim()
    if (fromEnv) return fromEnv
    const configured = String(config?.handoff?.transcripts_dir ?? '').trim()
    if (configured) return configured
    const dataDir = String(config?.data_dir ?? '').trim() || defaultDataDir()
    return join(dataDir, 'transcripts')
  }

  function loadManifest(dir) {
    const file = join(dir, 'manifest.json')
    if (!existsSync(file)) return []
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const list = raw && raw.sessions && typeof raw.sessions === 'object' ? Object.values(raw.sessions) : []
      return list.filter((item) => item && item.sessionId && item.md)
    } catch (error) {
      log(`读取归档 manifest 失败：${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  async function build(config, { force = false } = {}) {
    const dir = transcriptsDir(config)
    const entries = loadManifest(dir)
    const key = `${dir}|${entries.length}|${entries.reduce((sum, item) => sum + (Number(item.mtime) || 0), 0)}`
    if (!force && cache && key === cacheKey) return cache
    const cards = []
    for (const item of entries) {
      if (Number(item.depth) > 0) continue // 子代理会话不进卡片
      if (Number(item.compressBlocks) <= 0) continue
      const path = String(item.md)
      if (!existsSync(path)) continue
      try {
        const text = readFileSync(path, 'utf8')
        cards.push(
          ...parseCards(text, {
            sessionId: item.sessionId,
            project: item.project,
            projectLabel: item.projectLabel,
            title: item.title,
            path,
          }),
        )
      } catch {
        /* 单个文件坏掉不影响其它卡片 */
      }
    }
    cache = cards
    cacheAt = Date.now()
    cacheKey = key
    stats.cards = cards.length
    return cards
  }

  /** 同一进程内最多每 5 分钟重建一次卡片列表（归档器更新后自然跟进）。 */
  async function ensure(config) {
    if (cache && Date.now() - cacheAt < 5 * 60 * 1000) return cache
    return build(config)
  }

  async function search(query, config, { k, minScore, maxChars } = {}) {
    const settings = cardSettings(config)
    if (!settings.enabled) return []
    const q = String(query ?? '').trim()
    if (q.length < 4) return []
    const cards = await ensure(config)
    if (!cards.length) return []
    const limit = Math.max(1, Math.min(3, Number(k) || settings.k))
    const floor = Number.isFinite(minScore) ? Number(minScore) : settings.min_score
    const scored = []
    for (const card of cards) {
      const score = scoreCard(card, q)
      if (score >= floor) scored.push({ score, card })
    }
    scored.sort((a, b) => b.score - a.score)
    stats.calls += 1
    stats.lastQuery = q.slice(0, 80)
    stats.lastAt = Date.now()
    stats.best = scored.length ? scored[0].score : 0
    const out = scored.slice(0, limit).map(({ score, card }) => ({
      score,
      ...card,
      excerpt: clip(card.excerpt, Math.max(80, maxChars || settings.max_chars)),
    }))
    if (!out.length) stats.skipped += 1
    else stats.injected += out.length
    return out
  }

  function format(query, hits, config) {
    if (!Array.isArray(hits) || !hits.length) return ''
    const dir = transcriptsDir(config)
    const lines = hits.map((hit) => {
      const where = hit.date ? `${hit.date} ` : ''
      return `- ${where}「${clip(hit.title, 70)}」${hit.excerpt}`
    })
    const paths = hits.map((hit) => hit.path.slice(dir.length).replace(/^[\\/]+/, '')).join('、')
    return [
      `【归档卡片 · 本机历史】下面 ${hits.length} 条来自过去的会话归档（是当时模型自己写的压缩摘要，不是本次对话）；可能相关，引用前请核对原文：`,
      ...lines,
      `（原文：${dir}\\${paths}）`,
    ].join('\n')
  }

  /** 一步到位：检索 + 格式化。命中 0 条返回空串（不注入任何东西）。 */
  async function inject(query, config) {
    const hits = await search(query, config)
    if (!hits.length) return ''
    return format(query, hits, config)
  }

  function snapshot(config) {
    const settings = cardSettings(config)
    return {
      ...stats,
      cards: stats.cards || (cache ? cache.length : 0),
      age_ms: cache ? Date.now() - cacheAt : null,
      enabled: settings.enabled,
      min_score: settings.min_score,
      dir: transcriptsDir(config),
    }
  }

  function invalidate() {
    cache = null
    cacheAt = 0
    cacheKey = ''
  }

  return { build, search, format, inject, snapshot, invalidate }
}
