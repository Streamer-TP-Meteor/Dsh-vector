/**
 * "What is indexed on this machine" — a tiny runtime-context block so that any
 * model knows the knowledge sources exist even before it decides to call a tool.
 *
 * Only a few lines, refreshed in the background: the render path must stay
 * synchronous, so `text()` serves the last successful snapshot.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readConfig } from './config.js'

const REFRESH_MS = 60_000
const MAX_SOURCES = 6

function fmtSize(count, unit) {
  const n = Number(count) || 0
  return `${n} 个${unit}`
}

function shortTime(iso) {
  if (!iso) return ''
  const text = String(iso)
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
  if (!match) return text
  return `${match[2]}-${match[3]} ${match[4]}:${match[5]}`
}

export function createSources({ log = () => {}, readConfigImpl = readConfig } = {}) {
  const state = { text: '', at: 0, warming: false, lastError: null }

  function buildText(config, stats) {
    const bySrc = (stats && stats.by_src) || {}
    const configured = []
    for (const source of Array.isArray(config?.sources) ? config.sources : []) {
      if (source && source.name) configured.push({ name: source.name, label: source.label || source.name, project: false })
    }
    for (const source of Array.isArray(config?.project_sources) ? config.project_sources : []) {
      if (source && source.enabled !== false && source.name) {
        configured.push({ name: source.name, label: source.label || source.name, project: true })
      }
    }
    const rows = configured
      .map((item) => {
        const meta = bySrc[item.name] || {}
        return { ...item, files: Number(meta.files) || 0, chunks: Number(meta.chunks) || 0 }
      })
      .filter((item) => item.chunks > 0 || item.files > 0)
      .sort((a, b) => b.chunks - a.chunks)

    if (!rows.length) return ''
    const shown = rows.slice(0, MAX_SOURCES).map((row) => `${row.label}（${fmtSize(row.files, '文件')} / ${fmtSize(row.chunks, '块')}）`)
    const more = rows.length > shown.length ? ` 等 ${rows.length} 个源` : ''
    const updated = shortTime(stats?.built_at)
    const head = `本机向量检索已索引：${shown.join('、')}${more}${updated ? `，最近更新 ${updated}` : ''}。`
    return (
      '【本机向量记忆】' +
      head +
      ' 需要历史决策、项目文档或旧结论时，先用 vmemory_search 检索（比 grep 准），引用前按 path:line 核对原文；' +
      '检索不到时如实说明，不要凭印象编造。'
    )
  }

  async function warm() {
    if (state.warming) return state.text
    state.warming = true
    try {
      const { config } = await readConfigImpl()
      let stats = null
      try {
        const dir = config?.data_dir
        if (dir) stats = JSON.parse(readFileSync(join(dir, 'index', 'stats.json'), 'utf8'))
      } catch (error) {
        // stats are optional: a fresh install has not indexed anything yet
      }
      state.text = buildText(config, stats)
      state.at = Date.now()
      state.lastError = null
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error)
      log(`读取知识源清单失败（忽略）：${state.lastError}`)
    } finally {
      state.warming = false
    }
    return state.text
  }

  /** Synchronous: serve the cached snapshot, refresh in the background when stale. */
  function text() {
    if (Date.now() - state.at > REFRESH_MS) {
      void warm().catch(() => {})
    }
    return state.text
  }

  return { warm, text, state }
}
