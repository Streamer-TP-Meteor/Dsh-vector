import { readConfig } from './config.js'
import { buildIndex, normalizeHits, search } from './engine.js'
import { buildState } from './state.js'

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
    lines.push(`${index + 1}. [${Number(hit.score ?? 0).toFixed(3)}] ${where}${hit.heading ? ` · ${hit.heading}` : ''}`)
    if (hit.snippet) lines.push(`   ${String(hit.snippet).replace(/\s+/g, ' ').trim()}`)
  })
  if (value.ms != null) lines.push(`(${value.ms} ms)`)
  return lines
}

export function registerVectorMemoryTools(tools, log = () => {}) {
  tools.register({
    name: 'vmemory_search',
    description:
      "Semantic recall over the note sources this user registered (Qwen3-Embedding-0.6B + BM25 fused with RRF; optional Qwen3-Reranker). " +
      'Returns ranked passages with sources like <source>/<file>:<line>. Use it before asking the user to repeat a past decision, before writing a memory entry, ' +
      'or whenever a request references something said earlier. Read the cited entry before quoting it. Offline and local.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language question in Chinese or English, e.g. "上次定的向量化方案是什么".' },
        k: { type: 'integer', description: 'How many matches to return (default 5).' },
        src: { type: 'string', description: 'Restrict to one registered source by name (default: all of them).' },
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
      render: (args, value) => textBlocks(summariseSearch(value).join('\n')),
    },
    execute: async (args, exec) => {
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
    },
  })

  tools.register({
    name: 'vmemory_index',
    description:
      'Incrementally re-index the local vector memory (registered note folders and project directories). Only changed files are re-embedded, so it usually takes seconds. ' +
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
      const stats = await buildIndex(config, { force: args.force === true })
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
          `data: ${value.plugin?.dataDir || ''} (${value.disk?.dataBytes ?? 0} bytes)`,
        ].join('\n'),
      ),
    },
    execute: async () => {
      const state = await buildState({ version: 'tool' })
      return {
        ok: true,
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

  log('tools registered: vmemory_search, vmemory_index, vmemory_status')
  return 3
}
