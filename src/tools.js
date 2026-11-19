import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { defaultDataDir, readConfig } from './config.js'
import { buildIndex, normalizeHits, parseJsonOutput, runCli, search } from './engine.js'
import { buildState } from './state.js'
import { startJob } from './jobs.js'
import { renderResults, retrieve } from './retrieve.js'

/** 把一个可能带多行 traceback 的错误压成「最后一行 + 截断」，对模型友好。 */
function lastLine(message) {
  const lines = String(message || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const last = lines[lines.length - 1] || String(message || '未知错误')
  return last.length > 300 ? `${last.slice(0, 300)}…` : last
}

/**
 * The agent-facing surface. Same three tools as the first release, now backed by
 * the shared modules instead of their own copy of the spawn code.
 *
 * Output objects are built field by field: DSH rejects tool results that are not
 * lossless JSON, and a stray `undefined` from the CLI is enough to break a call.
 */
const textBlocks = (text) => [{ type: 'text', text }]

function summariseSearch(value) {
  const hits = Array.isArray(value.hits) ? value.hits : []
  if (!hits.length) return [`No matches for: ${value.query}`]
  const lines = [`${hits.length} match(es) for: ${value.query}`]
  hits.forEach((hit, index) => {
    const where = hit.path ? `${hit.path}:${hit.line ?? '?'}` : '?'
    const stamp = hit.date ? `（${hit.date}）` : ''
    lines.push(`${index + 1}. [${Number(hit.score ?? 0).toFixed(3)}] ${where}${hit.heading ? ` · ${hit.heading}` : ''}${stamp}`)
    if (hit.snippet) lines.push(`   ${String(hit.snippet).replace(/\s+/g, ' ').trim()}`)
  })
  if (value.ms != null) lines.push(`(${value.ms} ms)`)
  return lines
}

/**
 * 会话归档的文本检索：不走向量、不碰嵌入服务，直接扫已归档的 .md（12 MB / 514 个文件，几十毫秒）。
 * 存在的理由：DSH 自带的 session_search 每次要现解压 350 MB zstd，30 秒超时；归档是物化好的。
 */
export function searchTranscripts(root, query, { k = 6, maxSnippet = 240 } = {}) {
  const needle = String(query || '').trim()
  if (!needle || !existsSync(root)) return { hits: [], scanned: 0, ms: 0 }
  const started = Date.now()
  const lower = needle.toLowerCase()
  const tokens = lower.split(/\s+/).filter((t) => t.length >= 2)
  const files = []
  const walk = (dir) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.md')) files.push(p)
    }
  }
  walk(root)
  const hits = []
  for (const file of files) {
    let text
    try {
      const st = statSync(file)
      if (st.size > 8 * 1024 * 1024) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const haystack = text.toLowerCase()
    let score = 0
    if (haystack.includes(lower)) score += 6
    for (const token of tokens) {
      let idx = haystack.indexOf(token)
      let n = 0
      while (idx !== -1 && n < 20) {
        n++
        idx = haystack.indexOf(token, idx + token.length)
      }
      if (n) score += n
    }
    if (!score) continue
    // 标题行（# 开头）命中再加权：标题往往就是那次会话的主题
    const titleMatch = /^#\s+(.+)$/m.exec(text)
    const title = titleMatch ? titleMatch[1].trim() : basename(file, '.md')
    if (title.toLowerCase().includes(lower) || tokens.some((t) => title.toLowerCase().includes(t))) score += 4
    const at = haystack.indexOf(lower) !== -1 ? haystack.indexOf(lower) : haystack.indexOf(tokens.find((t) => haystack.includes(t)) || '')
    const snippet = at >= 0 ? text.slice(Math.max(0, at - 60), Math.min(text.length, at + maxSnippet)).replace(/\s+/g, ' ').trim() : ''
    const fm = (key) => {
      const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text)
      return m ? m[1].trim() : ''
    }
    hits.push({
      score,
      path: file,
      title,
      project: fm('project'),
      createdAt: fm('created_at'),
      sessionId: fm('session_id'),
      snippet,
    })
  }
  hits.sort((a, b) => b.score - a.score)
  return { hits: hits.slice(0, Math.max(1, Math.min(20, k))), scanned: files.length, ms: Date.now() - started }
}

export function registerVectorMemoryTools(tools, log = () => {}, runtime = null) {
  tools.register({
    name: 'vmemory_search',
    description:
      "Semantic recall over this machine's DSH memory and project notes (Qwen3-Embedding-0.6B + BM25 fused with RRF; optional Qwen3-Reranker). " +
      'Returns ranked passages with sources like memory/decisions.md:159. Use it before asking the user to repeat a past decision, before writing a memory entry, ' +
      'or whenever a request references something said earlier. Read the cited entry before quoting it. Offline and local.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language question in Chinese or English, e.g. "上次定的向量化方案是什么".' },
        k: { type: 'integer', description: 'How many matches to return (default 5).' },
        src: { type: 'string', description: 'Restrict to one registered source (default: all sources in scope).' },
        rerank: {
          type: 'boolean',
          description: 'Enable the Qwen3-Reranker cross-encoder pass (more precise, but costs ~6-15s per query on CPU). Off by default.',
        },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          query: { type: 'string' },
          hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
          ms: { type: 'number' },
        },
      },
      render: (args, value) => {
        if (value?.ok === false) return textBlocks(`检索没成功：${value.error || '未知错误'}\n（本机向量服务可能没起来；可以稍后重试，或用 vmemory_archive_search 搜历史会话原文。）`)
        return textBlocks(summariseSearch(value).join('\n'))
      },
    },
    execute: async (args, exec) => {
      try {
        const { config } = await readConfig()
        const result = await search(config, {
          query: String(args.query ?? ''),
          k: args.k,
          src: args.src,
          rerank: args.rerank === true,
          signal: exec?.signal,
        })
        const hits = normalizeHits(result?.hits)
        const info = result?.info || {}
        const ms = Number(info.ms)
        return {
          ok: true,
          query: String(args.query ?? ''),
          hits,
          ...(Number.isFinite(ms) ? { ms } : {}),
          reranked: Boolean(info.reranked),
        }
      } catch (error) {
        // 工具不该把异常抛给模型：抛出去只会变成一条难读的 tool error，这里换成可读的结果。
        const message = error instanceof Error ? error.message : String(error)
        log(`vmemory_search 失败：${message}`)
        return { ok: false, query: String(args?.query ?? ''), hits: [], error: lastLine(message) }
      }
    },
  })

  tools.register({
    name: 'vmemory_index',
    description:
      'Incrementally re-index the local vector memory (memory/*.md and project notes). Only changed files are re-embedded, so it usually takes seconds. ' +
      'Call it after writing memory files. force=true rebuilds everything (slow, ~4 min on CPU).',
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Rebuild the whole index instead of updating changed files.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          files: { type: 'number' },
          chunks: { type: 'number' },
          new: { type: 'number' },
          reused: { type: 'number' },
          seconds: { type: 'number' },
        },
      },
      render: (args, value) => textBlocks(
        [
          `Index updated: ${value.files} file(s), ${value.chunks} chunk(s)`,
          `new ${value.new}, reused ${value.reused}, ${value.dim}-dim, ${Number(value.seconds).toFixed(1)}s`,
        ].join('\n'),
      ),
    },
    execute: async (args) => {
      const { config } = await readConfig()
      // 走 jobs 的单飞队列，而不是直接 buildIndex：直接跑会绕开「一次只允许一个任务」的保护，
      // 与索引任务并发时 vindex 的写盘没有锁，取消一个任务就能把另一个正在写的索引打断（审计 PY-01/STB-01）。
      const started = startJob({
        kind: 'index',
        label: args.force === true ? '重建索引（force）' : '更新索引（工具调用）',
        runner: async ({ log: jobLog, signal }) => {
          const stats = await buildIndex(config, {
            force: args.force === true,
            signal,
            onLine: (line) => jobLog(line),
          })
          jobLog(`索引完成：${stats?.chunks ?? '?'} 块 / ${stats?.files ?? '?'} 文件`)
          return stats
        },
      })
      if (!started.ok) {
        log(`vmemory_index 排队失败：${started.error}`)
        return { ok: false, busy: true, error: lastLine(started.error) }
      }
      const outcome = await started.done
      if (!outcome?.ok) {
        log(`vmemory_index 失败：${outcome?.error || '未知错误'}`)
        return { ok: false, cancelled: outcome?.cancelled === true, error: lastLine(outcome?.error || '索引失败') }
      }
      const stats = outcome.job?.result ?? null
      const out = { ok: true }
      for (const key of ['files', 'files_changed', 'chunks', 'new', 'reused', 'dim', 'seconds']) {
        const number = Number(stats?.[key])
        if (Number.isFinite(number)) out[key] = number
      }
      return out
    },
  })

  tools.register({
    name: 'vmemory_status',
    description:
      'Status of the local vector memory layer: whether the embedding service is running, its RSS/port, index size and freshness, model paths and disk usage.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          service: { type: 'object', additionalProperties: true },
          index: { type: 'object', additionalProperties: true },
        },
      },
      render: (args, value) => textBlocks(
        [
          `service: ${value.service?.running ? 'running' : 'stopped'} · ${value.service?.url || ''} · rss ${value.service?.rssMb ?? '?'} MB`,
          `index: ${value.index?.chunks ?? '?'} chunks / ${value.index?.files ?? '?'} files · dim ${value.index?.dim ?? '?'} · built ${value.index?.builtAt || 'never'}`,
          'recall: ' +
            (value.recall
              ? `${value.recall.injections ?? 0} injected / ${value.recall.notFound ?? 0} notFound / ${value.recall.skipped ?? 0} skipped / ${value.recall.errors ?? 0} errors · best ${value.recall.lastBestCos ?? '-'}`
              : 'n/a'),
          `data: ${value.plugin?.dataDir || ''} (${value.disk?.dataBytes ?? 0} bytes)`,
        ].join('\n'),
      ),
    },
    execute: async () => {
      const state = await buildState({ version: 'tool' })
      const recall = runtime?.recall
      return {
        ok: true,
        recall: recall && typeof recall.snapshot === 'function' ? recall.snapshot() : null,
        plugin: { dataDir: state.plugin.dataDir, version: state.plugin.version, configPath: state.plugin.configPath },
        service: {
          running: state.service.running,
          url: state.service.url,
          rssMb: state.service.rssMb,
          calls: state.service.calls,
          rerank: state.service.rerank,
        },
        index: {
          chunks: state.index.chunks,
          files: state.index.files,
          dim: state.index.dim,
          builtAt: state.index.builtAt,
        },
        disk: { dataBytes: state.disk.dataBytes, free: state.disk.free?.free ?? null },
      }
    },
  })


  tools.register({
    name: 'vmemory_outline',
    description:
      'Topic map of what is indexed on this machine, derived from file headings and paths (no model involved). ' +
      'Use it when you need to know WHICH areas exist and WHERE they live before searching, e.g. "what does this project cover" ' +
      'or "which folder talks about audio". Every topic carries a path:line you can open.',
    parameters: {
      type: 'object',
      properties: {
        src: { type: 'string', description: 'limit to one source (source name or label); omit for all' },
        per_src: { type: 'integer', description: 'how many topics/paths per source (default 6, max 20)' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          sources: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (args, value) => {
        const list = Array.isArray(value.sources) ? value.sources : []
        if (!list.length) return textBlocks('（还没有可归纳的索引结构）')
        const lines = []
        for (const s of list) {
          lines.push(`${s.label} · ${s.files} files / ${s.chunks} chunks`)
          if (Array.isArray(s.clusters) && s.clusters.length) {
            lines.push('  paths: ' + s.clusters.map((c) => `${c.path}(${c.chunks})`).join(', '))
          }
          if (Array.isArray(s.topics)) {
            for (const t of s.topics) lines.push(`  - ${t.topic} (${t.count}) @ ${t.at}`)
          }
        }
        return textBlocks(lines.join('\n'))
      },
    },
    execute: async (args = {}, exec = {}) => {
      const cfg = (await readConfig()).config
      const perSrc = Math.min(20, Math.max(1, Number(args.per_src) || 6))
      const cliArgs = ['outline', '--json', '--per-src', String(perSrc)]
      if (args.src) cliArgs.push('--src', String(args.src))
      const out = await runCli(cfg, cliArgs, { timeoutMs: 60_000, signal: exec.signal })
      const parsed = parseJsonOutput(out.stdout, 'outline')
      const sources = (Array.isArray(parsed?.sources) ? parsed.sources : []).map((s) => ({
        name: String(s.name || ''),
        label: String(s.label || s.name || ''),
        files: Number(s.files) || 0,
        chunks: Number(s.chunks) || 0,
        topicTotal: Number(s.topic_total) || 0,
        clusters: (Array.isArray(s.clusters) ? s.clusters : []).map((c) => ({
          path: String(c.path || ''),
          chunks: Number(c.chunks) || 0,
        })),
        topics: (Array.isArray(s.topics) ? s.topics : []).map((t) => ({
          topic: String(t.topic || ''),
          count: Number(t.count) || 0,
          at: String(t.at || ''),
        })),
      }))
      return { ok: true, sources, chunks: Number(parsed?.chunks) || 0, ms: Number(parsed?.ms) || 0 }
    },
  })

  tools.register({
    name: 'vmemory_archive_search',
    description:
      'Literal text search over ARCHIVED past conversations (the plugin materialises DSH session files into readable .md). ' +
      'Use it when the user refers to something said in an earlier conversation ("上次/之前那个会话里说过"), when memory/*.md lacks the detail, ' +
      'or before claiming a past detail cannot be found. Returns session id, project, date and a snippet you can then read in full. ' +
      'It is plain grep on local files (fast, no embedding service); for semantic recall over curated notes use vmemory_search instead.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words or a phrase to look for (Chinese or English). Multiple words are OR-matched and scored.' },
        k: { type: 'integer', description: 'How many conversations to return (default 6, max 20).' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          query: { type: 'string' },
          hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
          scanned: { type: 'number' },
          ms: { type: 'number' },
          dir: { type: 'string' },
        },
      },
      render: (args, value) => {
        const hits = Array.isArray(value.hits) ? value.hits : []
        if (!hits.length) {
          return textBlocks(`没有在会话归档里找到「${value.query}」。\n归档目录：${value.dir}\n（可以换更短的关键词，或先用 vmemory_search 查记忆库）`)
        }
        const lines = [`${hits.length} 个会话命中「${value.query}」（扫了 ${value.scanned} 个归档文件，${value.ms} ms）`]
        hits.forEach((hit, index) => {
          lines.push(
            `${index + 1}. [${hit.score}] ${hit.title} · ${hit.project || '?'}${hit.createdAt ? ` · ${hit.createdAt}` : ''}`,
            `   ${hit.path}:${hit.sessionId ? ` session ${hit.sessionId}` : ''}`,
            `   ${String(hit.snippet || '').slice(0, 220)}`,
          )
        })
        lines.push('（要细节就用 read 打开上面的路径，按 session_id 在归档目录里找）')
        return textBlocks(lines.join('\n'))
      },
    },
    execute: async (args = {}) => {
      const { config } = await readConfig()
      const dir = join(String(config?.data_dir || defaultDataDir()), 'transcripts')
      const result = searchTranscripts(dir, args.query, { k: Number(args.k) || 6 })
      return {
        ok: true,
        query: String(args.query ?? ''),
        hits: result.hits,
        scanned: result.scanned,
        ms: result.ms,
        dir,
      }
    },
  })

  tools.register({
    name: 'vmemory_recall',
    description:
      'ONE-STOP recall across everything this machine knows: curated docs (memory/*.md, project notes) + session cards (model-written summaries of past conversations) + ' +
      'literal search in archived conversations. Use it FIRST whenever the user says "上次/之前/我们说过/按旧方案" or asks about work done in another session/project/drive — ' +
      'it needs no keyword luck and works with any model. Returns three sections: docs, session cards (with an auto-extracted excerpt of the original transcript), and raw archive hits. ' +
      'It costs one embedding round-trip plus a local grep (~0.7 s).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language question or keywords (Chinese or English).' },
        k: { type: 'integer', description: 'How many items per channel (default 5, max 10).' },
        srcs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional source names to restrict the vector channel (e.g. ["memory","cards"]). Omit to search every indexed source, cross-project and cross-drive.',
        },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          query: { type: 'string' },
          ms: { type: 'number' },
          docs: { type: 'array', items: { type: 'object', additionalProperties: true } },
          cards: { type: 'array', items: { type: 'object', additionalProperties: true } },
          archive: { type: 'array', items: { type: 'object', additionalProperties: true } },
          errors: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (args, value) => {
        if (value?.ok === false) return textBlocks(`统一检索没成功：${value.error || '未知错误'}\n（可以稍后再试，或用 vmemory_search / vmemory_archive_search 分别查。）`)
        const total = (value.docs?.length || 0) + (value.cards?.length || 0) + (value.archive?.length || 0)
        if (!total) {
          return textBlocks(
            `没有找到和「${value.query}」相关的东西（文档 / 会话卡片 / 归档全文都没命中）。\n` +
              `${value.errors?.length ? `通道报错：${value.errors.join('；')}\n` : ''}` +
              '可以换更短的词，或用 vmemory_search（只查文档）、vmemory_archive_search（只查归档全文）。',
          )
        }
        return textBlocks(renderResults(value))
      },
    },
    execute: async (args = {}) => {
      try {
        const payload = await retrieve({
          query: String(args.query ?? ''),
          k: Number(args.k) || 5,
          srcs: Array.isArray(args.srcs) && args.srcs.length ? args.srcs.map(String) : null,
          searchImpl: search,
          transcriptsImpl: searchTranscripts,
          log: (message) => log(message),
        })
        return { ok: true, ...payload }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`vmemory_recall 失败：${message}`)
        return { ok: false, query: String(args?.query ?? ''), docs: [], cards: [], archive: [], results: [], error: lastLine(message) }
      }
    },
  })

  log('tools registered: vmemory_search, vmemory_index, vmemory_status, vmemory_outline, vmemory_archive_search, vmemory_recall')
  return 6
}