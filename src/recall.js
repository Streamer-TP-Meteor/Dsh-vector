import { readConfig } from './config.js'
import { normalizeHits, search as engineSearch } from './engine.js'

/**
 * P0 auto-recall: give every model that runs in DSH a small, bounded block of
 * memory retrieved for the *current* user message, without asking the model to
 * call a tool.
 *
 * How it is injected (see dsh-agent-loop / dsh-system-prompt):
 *  - `agent/created` → register one dynamic prompt context in that agent's scope
 *    (`agent.ctx.get('systemPrompt').context(...)`), whose `text()` reads a cache.
 *  - `agent/pre-step` (waterfall) → runs after assembly but before the request
 *    is rendered; we fill the cache here. `refreshContext()` re-resolves context
 *    providers at request time, so the text computed in this step is what the
 *    model actually receives.
 * The block is not a normal chat message: DSH records it as a runtime-context
 * snapshot (identical content is de-duplicated, a newer snapshot replaces the old
 * one). Any failure simply yields an empty context: the turn goes on as before.
 *
 * Deliberately conservative: only the first step of a turn, short/greeting
 * queries skipped, hard character budget, score floor, and a hard timeout.
 */

const GREETING =
  /^(你好|您好|哈喽|嗨|hi|hello|hey|在吗|在不在|ok|okay|好的|好|嗯|收到|谢谢|多谢|thanks|thank you)[\s!！。,.，?？~～]*$/i

const FALLBACK_RECALL = {
  enabled: true,
  k: 3,
  min_cos: 0.3,
  max_chars: 1000,
  timeout_ms: 1500,
  rerank: false,
  min_query_chars: 6,
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Extract plain text from one UserMessage (string content, parts array or {text}). */
export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part.text === 'string') return part.text
        return ''
      })
      .join(' ')
  }
  if (content && typeof content.text === 'string') return content.text
  if (typeof message?.text === 'string') return message.text
  return ''
}

/** The newest user text among the messages claimed for this turn. */
export function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || typeof message !== 'object') continue
    if (message.role !== undefined && message.role !== 'user') continue
    const text = messageText(message).trim()
    if (text) return text
  }
  return ''
}

function formatHits(hits, maxChars) {
  const blocks = []
  let used = 0
  for (const hit of hits) {
    const where = [hit.path, hit.line].filter((value) => value != null && value !== '').join(':')
    const head = `${blocks.length + 1}. ${where}${hit.heading ? ` · ${hit.heading}` : ''}`
    const snippet = String(hit.snippet ?? '').replace(/\s+/g, ' ').trim()
    const block = snippet ? `${head}\n   ${snippet}` : head
    if (used + block.length > maxChars) break
    blocks.push(block)
    used += block.length + 1
  }
  return blocks.join('\n')
}

export function createRecall({ log = () => {}, searchImpl = engineSearch, readConfigImpl = readConfig } = {}) {
  /** agentId -> { turn, query, text, at } */
  const cache = new Map()
  const registered = new Set()
  const stats = {
    enabled: FALLBACK_RECALL.enabled,
    agents: 0,
    injections: 0,
    skipped: 0,
    errors: 0,
    lastQuery: '',
    lastMs: 0,
    lastHits: 0,
    lastChars: 0,
    lastAt: 0,
    lastError: null,
    textCalls: 0,
    suppressedWarned: false,
  }

  function textFor(agentId) {
    stats.textCalls += 1
    const entry = cache.get(agentId)
    return entry && entry.text ? entry.text : ''
  }

  function forget(agentId) {
    cache.delete(agentId)
    registered.delete(agentId)
  }

  function markRegistered(agentId) {
    registered.add(agentId)
    stats.agents = registered.size
  }

  function isRegistered(agentId) {
    return registered.has(agentId)
  }

  async function readLimits() {
    let recall = { ...FALLBACK_RECALL }
    try {
      const { config } = await readConfigImpl()
      if (config && typeof config.recall === 'object' && config.recall) recall = { ...recall, ...config.recall }
    } catch (error) {
      stats.lastError = error instanceof Error ? error.message : String(error)
    }
    stats.enabled = recall.enabled !== false
    return { config: null, recall }
  }

  /**
   * Compute (or reuse) the recall block for one agent/turn. Never throws.
   * @returns {Promise<string>} the text to show; empty string means "no block".
   */
  async function prepare(agent, messages, turn, scope = null, externalSignal = null) {
    try {
      const { recall } = await readLimits()
      if (!recall.enabled) {
        cache.set(agent.id, { turn, query: '', text: '', at: Date.now() })
        stats.skipped += 1
        return ''
      }

      // Diagnostics: we prepared blocks but the host never asked for the text,
      // which means runtime context is suppressed (system-prompt includeRuntimeContext=false).
      if (stats.injections >= 2 && stats.textCalls === 0 && !stats.suppressedWarned) {
        stats.suppressedWarned = true
        log('向量检索块没有进入请求：宿主可能关闭了运行时上下文；可在 设置 → 向量记忆 → 参数 打开「强制注入（required）」')
      }

      const query = lastUserText(messages)
      if (!query || query.length < clampNumber(recall.min_query_chars, 0, 50, 6)) {
        stats.skipped += 1
        return textFor(agent.id)
      }
      if (GREETING.test(query.trim())) {
        stats.skipped += 1
        return textFor(agent.id)
      }

      const existing = cache.get(agent.id)
      if (existing && existing.turn === turn && existing.query === query) return existing.text

      const started = Date.now()
      const k = clampNumber(recall.k, 1, 10, 3)
      const maxChars = clampNumber(recall.max_chars, 200, 4000, 1000)
      const timeoutMs = clampNumber(recall.timeout_ms, 200, 6000, 1500)
      const minCos = clampNumber(recall.min_cos, 0, 1, 0.3)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      timer.unref?.()
      if (externalSignal && typeof externalSignal.addEventListener === 'function') {
        if (externalSignal.aborted) controller.abort(externalSignal.reason)
        else externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), { once: true })
      }
      try {
        const raw = await searchImpl(null, {
          query,
          k,
          rerank: recall.rerank === true,
          srcs: Array.isArray(scope) && scope.length ? scope : undefined,
          signal: controller.signal,
        })
        const hits = normalizeHits(raw?.hits)
          .filter((hit) => !Number.isFinite(hit.cos) || hit.cos >= minCos)
          .slice(0, k)
        const body = hits.length ? formatHits(hits, maxChars) : ''
        const text = body
          ? `【向量检索 · 本机记忆】以下 ${hits.length} 条由本机向量检索自动选出，供参考；引用具体事实前请核对原文（path:line），不要据此编造。\n${body}`
          : ''
        cache.set(agent.id, { turn, query, text, at: Date.now(), scope: Array.isArray(scope) ? scope : null })
        stats.lastScope = Array.isArray(scope) ? scope : null
        stats.lastQuery = query.length > 120 ? `${query.slice(0, 120)}…` : query
        stats.lastMs = Date.now() - started
        stats.lastHits = hits.length
        stats.lastChars = text.length
        stats.lastAt = Date.now()
        stats.lastError = null
        if (text) stats.injections += 1
        return text
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        stats.errors += 1
        stats.lastError = message
        stats.lastMs = Date.now() - started
        cache.set(agent.id, { turn, query, text: '', at: Date.now() })
        log(`自动召回失败（本轮跳过，不影响对话）：${message}`)
        return ''
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      stats.errors += 1
      stats.lastError = error instanceof Error ? error.message : String(error)
      return ''
    }
  }

  function snapshot() {
    return { ...stats, agents: registered.size }
  }

  return { stats, textFor, forget, prepare, markRegistered, isRegistered, snapshot, cacheSize: () => cache.size }
}
