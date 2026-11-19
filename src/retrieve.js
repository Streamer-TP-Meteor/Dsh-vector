// 统一检索：一个入口，把三条通道合成一份答案
//
//   通道 1 · 文档向量（memory / 项目文档 / 会话卡片）   语义，换任何模型都能用
//   通道 2 · 会话卡片（归档摘要物化成 md 后也在向量库里） 语义，跨会话
//   通道 3 · 归档全文（transcripts/*.md 字面扫描）        精确，兜底
//
// 两阶段取文：只要命中的是「卡片」（摘要），就顺手把归档原文里最相关的一段取出来，
// 让模型不用再发一次 read —— 摘要负责“被搜到”，原文负责“说得清”。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { cjkTerms } from './cards.js'
import { defaultDataDir, readConfig } from './config.js'

const MAX_EXCERPT = 900
const MAX_CARDS = 60

function walkMd(dir, out = []) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walkMd(path, out)
    else if (entry.name.endsWith('.md')) out.push(path)
  }
  return out
}

/** 归档目录里 sessionId -> md 路径（514 个文件，走一次就够，用 mtime 缓存 60 秒）。 */
function createTranscriptIndex() {
  let cache = null
  let at = 0
  return (transcriptsRoot) => {
    const now = Date.now()
    if (cache && now - at < 60_000) return cache
    const map = new Map()
    if (existsSync(transcriptsRoot)) {
      for (const file of walkMd(transcriptsRoot)) {
        const id = basename(file, '.md')
        if (id.startsWith('session-')) map.set(id, file)
      }
    }
    cache = map
    at = now
    return map
  }
}

const transcriptIndex = createTranscriptIndex()

/** 从归档 md 里取「和 query 最相关的一段」，带行号，供模型直接引用。 */
export function transcriptExcerpt(file, query, { maxChars = MAX_EXCERPT } = {}) {
  if (!file || !existsSync(file)) return null
  let text
  try {
    if (statSync(file).size > 8 * 1024 * 1024) return null
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const terms = cjkTerms(query)
  if (!terms.length) return null
  const lines = text.split(/\r?\n/)
  let best = { line: -1, score: 0 }
  lines.forEach((line, i) => {
    const lower = line.toLowerCase()
    let score = 0
    for (const term of terms) {
      if (lower.includes(term)) score += term.length >= 4 ? 2 : 1
    }
    if (/^\s*#{1,3}\s/.test(line)) score *= 1.4
    if (score > best.score) best = { line: i, score }
  })
  if (best.line < 0) return null
  // 从命中行往下取，直到攒够 maxChars；行号按 1 起算，方便模型直接 read
  let start = best.line
  let budget = maxChars
  while (start > 0 && budget > 0 && best.line - start < 6) {
    start -= 1
    budget -= lines[start].length
  }
  budget = maxChars
  const chunk = []
  let end = start
  while (end < lines.length && budget > 0) {
    chunk.push(lines[end])
    budget -= lines[end].length + 1
    end += 1
  }
  const body = chunk.join('\n').trim()
  if (!body) return null
  return { file, line: start + 1, endLine: end, score: best.score, text: body }
}

/**
 * 主检索：先语义（向量），不够再字面（归档），卡片命中自动取原文。
 * @param {object} options
 * @param {string} options.query
 * @param {number} [options.k=5]
 * @param {string[]|null} [options.srcs]  限定来源（null = 不过滤，跨项目跨盘）
 * @param {boolean} [options.expand=true]  卡片命中是否回取归档原文
 */
export async function retrieve({ query, k = 5, srcs = null, expand = true, searchImpl, transcriptsImpl, log = () => {}, vectorTimeoutMs = 16000 } = {}) {
  const started = Date.now()
  const text = String(query || '').trim()
  if (!text) return { query: '', ms: 0, results: [], docs: [], cards: [], archive: [], errors: ['空查询'] }
  // 配置读失败不能连带整次检索失败：退回默认数据目录，至少归档通道还能用。
  let config = null
  try {
    config = (await readConfig())?.config || null
  } catch (error) {
    log(`读配置失败，按默认数据目录继续：${error instanceof Error ? error.message : String(error)}`)
  }
  const dataDir = String(config?.data_dir || defaultDataDir())
  const transcriptsRoot = String(config?.handoff?.transcripts_dir || '').trim() || join(dataDir, 'transcripts')
  const cardsRoot = join(dataDir, 'cards')
  const errors = []

  // ---- 阶段 1 和 2 并行：向量（语义，跨项目跨盘）+ 归档（字面，精确兜底）
  // 两条通道各自都有 100–300ms 的成本，串行会让一次工具调用等到 600ms 以上，所以并发跑。
  // 向量通道再加一层「总预算」：服务半死不活时不能让工具调用无限等待，超时就只交出归档结果。
  const wantVector = Math.max(3, Math.min(20, k * 2))
  // 超时不能只是「不等了」：底层请求还在跑，会被 engine 当成服务不可用再回退 CLI（最长 240s），
  // 留下一个孤儿 python 进程（审计 HOST-04）。所以超时就 abort，并禁止这条通道回退 CLI。
  // 每次尝试用独立的 AbortController——重试时旧的已经 abort 了。
  const runVectorChannel = async (budgetMs) => {
    const controller = new AbortController()
    const bounded = (promise, ms, onTimeout) =>
      new Promise((resolve) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          onTimeout()
          try {
            controller.abort()
          } catch {
            // ignore
          }
          resolve([])
        }, Math.max(500, ms))
        promise.then((value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        })
      })
    let timedOut = false
    const hits = await bounded(
      (async () => {
        try {
          const raw = await searchImpl(null, {
            query: text,
            k: wantVector,
            srcs: Array.isArray(srcs) && srcs.length ? srcs : undefined,
            timeoutMs: budgetMs,
            allowCli: false,
            signal: controller.signal,
          })
          return Array.isArray(raw?.hits) ? raw.hits : []
        } catch (error) {
          errors.push(`向量检索失败：${error instanceof Error ? error.message : String(error)}`)
          return []
        }
      })(),
      budgetMs + 1500,
      () => {
        timedOut = true
        errors.push(`向量检索超时（>${(budgetMs / 1000).toFixed(1)}s），本次只用归档通道`)
      },
    )
    return { hits, timedOut }
  }
  const archiveTask = (async () => {
    if (!transcriptsImpl) return []
    try {
      const literal = transcriptsImpl(transcriptsRoot, text, { k: Math.max(3, k) })
      return Array.isArray(literal?.hits) ? literal.hits : []
    } catch (error) {
      errors.push(`归档检索失败：${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  })()
  const [firstAttempt, archiveHits] = await Promise.all([runVectorChannel(vectorTimeoutMs), archiveTask])
  // 两条路都空（多半是并发突发把向量闸门排满了）：再给一次短机会。
  // 只重试「闸门繁忙 / 连接抖动」这类过一会儿可能就好的失败；
  // 真超时说明服务慢或半死，再等一轮只会把延迟翻倍，不重试。
  const worthRetry = !firstAttempt.timedOut && firstAttempt.hits.length === 0 && archiveHits.length === 0
  const vectorHits = worthRetry
    ? (await runVectorChannel(Math.min(6000, vectorTimeoutMs))).hits
    : firstAttempt.hits

  const results = []
  const seenSessions = new Set()
  for (const hit of vectorHits) {
    const rel = String(hit?.path || '')
    const isCard = rel.includes('会话卡片/') || rel.startsWith('cards/')
    const sessionId = isCard ? basename(rel.split(':')[0], '.md') : ''
    if (isCard && sessionId) {
      if (seenSessions.has(sessionId)) continue
      seenSessions.add(sessionId)
    }
    results.push({
      kind: isCard ? 'card' : 'doc',
      path: rel,
      score: Number(hit?.score || 0),
      cos: Number.isFinite(Number(hit?.cos)) ? Number(hit.cos) : null,
      snippet: String(hit?.snippet || '').slice(0, 300),
      sessionId,
      project: '',
      no: Number(hit?.no || 0) || Number(hit?.line || 0) || 0,
    })
    if (results.filter((r) => r.kind === 'card').length >= MAX_CARDS) break
  }
  for (const hit of archiveHits) {
    const sessionId = String(hit?.sessionId || '')
    if (sessionId && seenSessions.has(sessionId)) continue
    if (sessionId) seenSessions.add(sessionId)
    results.push({
      kind: 'archive',
      path: String(hit?.path || ''),
      score: Number(hit?.score || 0),
      cos: null,
      snippet: String(hit?.snippet || '').slice(0, 300),
      sessionId,
      project: String(hit?.project || ''),
      no: 0,
      title: String(hit?.title || ''),
    })
  }

  const grouped = groupResults(results, k)

  // ---- 阶段 3：卡片命中 → 回取归档原文
  if (expand) {
    const index = transcriptIndex(transcriptsRoot)
    for (const item of grouped.results) {
      if (item.kind !== 'card' || !item.sessionId) continue
      const file = index.get(item.sessionId)
      if (!file) continue
      try {
        const excerpt = transcriptExcerpt(file, text)
        if (excerpt) item.excerpt = excerpt
      } catch (error) {
        errors.push(`取原文失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const cardsDir = cardsRoot.toLowerCase()
  for (const item of grouped.results) {
    if (item.kind === 'card' && !item.file) item.file = join(cardsDir, item.path.split(':')[0].replace(/^会话卡片[\\/]/, ''))
  }

  log(`检索「${text.slice(0, 30)}」→ 文档 ${grouped.docs.length} / 卡片 ${grouped.cards.length} / 归档 ${grouped.archive.length}，${Date.now() - started}ms`)
  return { query: text, ms: Date.now() - started, ...grouped, errors, transcriptsRoot, cardsRoot }
}

/**
 * 分通道输出，每个通道各自排序、各自限额 —— 不做跨通道混排。
 *
 * 实测教训（先说结论）：混排会被量纲污染。字面命中的「历史会话」分数只有 0.4–0.68，
 * 而文档的 cos 常常 0.6–0.75，一混排就把会话挤到后面，「找到那次会话」的 Recall@3
 * 从 88%（只用归档）掉到 60%；按通道轮转又变成文档永远第一，Recall@1 只剩 4%。
 *
 * 所以模型侧看到的是三个分区：文档 / 会话卡片 / 归档全文。
 * 每个分区内部按自己的分数排，互不侵占地盘；谁的问题找谁的分区。
 */
export function groupResults(results, limit = 5) {
  const normalized = results.slice()
  let maxArchive = 0
  for (const item of normalized) if (item.kind === 'archive' && item.score > maxArchive) maxArchive = item.score
  for (const item of normalized) {
    let quality
    if (item.cos != null) quality = Math.max(0, Math.min(1, item.cos))
    else quality = maxArchive > 0 ? 0.4 + 0.28 * (item.score / maxArchive) : 0
    item.rank = Math.round(quality * 1000) / 1000
  }

  const prefer = { card: 0, archive: 1, doc: 2 }
  normalized.sort((a, b) => (b.rank || 0) - (a.rank || 0) || prefer[a.kind] - prefer[b.kind])

  const seen = new Set()
  const docs = []
  const cards = []
  const archive = []
  const seenSession = new Set()
  for (const item of normalized) {
    const key = item.sessionId ? `s:${item.sessionId}` : `p:${item.path}`
    if (seen.has(key)) continue
    seen.add(key)
    if (item.kind === 'card') {
      if (item.sessionId && seenSession.has(item.sessionId)) continue
      if (item.sessionId) seenSession.add(item.sessionId)
      cards.push(item)
    } else if (item.kind === 'archive') {
      if (item.sessionId && seenSession.has(item.sessionId)) continue
      if (item.sessionId) seenSession.add(item.sessionId)
      archive.push(item)
    } else {
      docs.push(item)
    }
  }

  const docLimit = Math.max(1, Math.min(10, limit))
  const sessionLimit = Math.max(1, Math.min(10, limit))
  const outDocs = docs.slice(0, docLimit)
  const outCards = cards.slice(0, Math.max(1, Math.round(sessionLimit / 2)))
  const outArchive = archive.slice(0, sessionLimit)
  return { docs: outDocs, cards: outCards, archive: outArchive, results: [...outDocs, ...outCards, ...outArchive] }
}

/** 把结果渲染成给模型看的文本（工具返回值）。 */
export function renderResults(payload, { maxChars = 3600 } = {}) {
  const { query, docs = [], cards = [], archive = [], ms, errors } = payload
  const lines = [`【统一检索】「${query}」${ms}ms · 文档 ${docs.length} · 会话卡片 ${cards.length} · 归档全文 ${archive.length}`]
  if (errors?.length) lines.push(`部分通道失败：${errors.join('；')}`)
  let used = 0
  const push = (text) => {
    if (used + text.length > maxChars) return false
    used += text.length
    lines.push(text)
    return true
  }
  const renderItem = (item, i) => {
    const label = item.kind === 'card' ? '会话卡片' : item.kind === 'archive' ? '归档全文' : '文档'
    const chunk = [`${i + 1}. [${label}] ${item.path}${item.cos != null ? ` · cos ${item.cos.toFixed(2)}` : ''}`]
    if (item.title) chunk.push(`   标题：${item.title}`)
    if (item.snippet) chunk.push(`   摘要：${item.snippet.replace(/\s+/g, ' ').slice(0, 240)}`)
    if (item.excerpt) chunk.push(`   原文（${item.excerpt.file}:${item.excerpt.line}）：${item.excerpt.text.replace(/\s+/g, ' ').slice(0, MAX_EXCERPT)}`)
    return chunk.join('\n')
  }
  const section = (title, items) => {
    if (!items.length) return
    push(title)
    items.forEach((item, i) => push(renderItem(item, i)))
  }
  section('— 文档 / 记忆（文档里怎么写的）—', docs)
  section('— 历史会话 · 摘要卡片（当时聊了什么）—', cards)
  section('— 历史会话 · 归档原文（精确匹配）—', archive)
  push('引用前请按上面的路径与行号核对原文；没搜到就直说没搜到，不要编。')
  return lines.join('\n')
}

/** 给自动召回用的极简版：只要标题行，不要原文段落（省 token）。 */
export async function retrieveBrief({ query, k = 3, srcs = null, searchImpl, transcriptsImpl }) {
  const payload = await retrieve({ query, k, srcs, expand: false, searchImpl, transcriptsImpl })
  const top = payload.results.slice(0, k)
  if (!top.length) return { text: '', payload }
  const body = top
    .map((item, i) => {
      const label = item.kind === 'card' ? '会话卡片' : item.kind === 'archive' ? '归档' : '文档'
      return `${i + 1}. [${label}] ${item.path}${item.snippet ? ` — ${item.snippet.replace(/\s+/g, ' ').slice(0, 150)}` : ''}`
    })
    .join('\n')
  return { text: body, payload }
}

export const __retrieveTest = { MAX_EXCERPT, MAX_CARDS, createTranscriptIndex }
