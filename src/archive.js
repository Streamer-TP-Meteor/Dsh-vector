// 会话归档（S0）：把 DSH 会话存档（.jsonl.zstd）物化成可 grep 的纯文本 .md + manifest.json
// 目的：①给「开场简报」提供数据 ②让旧会话细节不再只能靠向量检索 ③顺手替代现解压式的 session_search
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { defaultDataDir } from './config.js'

const unzstd = promisify(zstdDecompress)

export const PARSER_VERSION = 5

const pad = (n) => String(n).padStart(2, '0')

function fmtTime(ms, withDate = true) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return withDate ? `${date} ${time}` : time
}

function labelFor(cwd) {
  if (!cwd) return 'unknown'
  const norm = String(cwd).replace(/[\\/]+$/, '')
  const m = norm.match(/^([a-zA-Z]):[\\/]/)
  const base = norm.split(/[\\/]/).filter(Boolean).pop() || 'root'
  const safe = base.replace(/[^\p{L}\p{N}_.-]+/gu, '_').slice(0, 40)
  return `${(m ? m[1] : 'x').toLowerCase()}-${safe}`
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

const blockText = (blocks) =>
  (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b && typeof b.text === 'string' && (b.type === 'text' || b.type === undefined))
    .map((b) => b.text)
    .join('\n')
    .trim()

export function defaultSessionsDir() {
  const env = process.env.DSH_VECTOR_MEMORY_SESSIONS || process.env.DSH_SESSIONS_DIR
  if (env) return env
  return join(homedir(), '.dsh', 'sessions')
}

export function archiveSettings(config) {
  const handoff = config?.handoff || {}
  return {
    enabled: handoff.auto_archive !== false,
    sessions_dir: String(handoff.sessions_dir || '') || defaultSessionsDir(),
    transcripts_dir: String(handoff.transcripts_dir || ''),
    interval_min: Number(handoff.archive_interval_min) > 0 ? Number(handoff.archive_interval_min) : 120,
  }
}

// 扫描存档：同一会话目录可能同时有旧格式与 v4，v4（重新序列化的干净消息流）优先
function listSessionFiles(root) {
  const files = []
  const walk = (d) => {
    let entries = []
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.jsonl\.zstd$/.test(e.name)) files.push(p)
    }
  }
  walk(root)
  files.sort()
  const byDir = new Map()
  for (const f of files) {
    const dir = dirname(f)
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir).push(f)
  }
  const chosen = []
  const legacySkipped = []
  for (const [dir, list] of byDir) {
    if (list.length === 1) {
      chosen.push(list[0])
      continue
    }
    const v4 = list.find((f) => /\.v4\.jsonl\.zstd$/.test(f))
    if (v4) {
      chosen.push(v4)
      for (const f of list) if (f !== v4) legacySkipped.push({ file: f, reason: 'v4 优先', dir })
    } else {
      const sized = list.map((f) => ({ f, size: (() => { try { return statSync(f).size } catch { return 0 } })() }))
      sized.sort((a, b) => b.size - a.size)
      chosen.push(sized[0].f)
      for (const x of sized.slice(1)) legacySkipped.push({ file: x.f, reason: '取最大文件', dir })
    }
  }
  return { files: chosen, legacySkipped }
}

function parseSession(text) {
  const lines = text.split('\n').filter(Boolean)
  let header = null
  let lastTitle = ''
  let lastTitleSource = ''
  const goals = new Map()
  const turns = []
  const compressBlocks = []
  let turnCount = 0
  let realUserChars = 0
  let assistantChars = 0

  for (const line of lines) {
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const ty = r.type || ''
    const d = r.data || {}
    if (ty === 'session' && !header) {
      header = r
      continue
    }
    if (ty === 'turn/start') turnCount++
    else if (ty === 'session/title') {
      const src = String(d.source?.kind || '')
      if (d.title && (src === 'llm' || !lastTitle || (src === 'user' && lastTitleSource === 'fallback'))) {
        lastTitle = String(d.title)
        lastTitleSource = src
      }
    } else if (ty === 'goal/change') {
      const g = d.goal
      if (g?.id) {
        const prev = goals.get(g.id) || {}
        goals.set(g.id, {
          ...prev,
          objective: String(g.objective || prev.objective || ''),
          phase: String(g.phase || prev.phase || ''),
          operation: String(d.operation || ''),
          time: r.time,
        })
      }
    } else if (ty === 'user/message') {
      const kind = String(d.source?.kind || 'unknown')
      if (kind !== 'user') continue // 关键过滤：丢掉 goal/instructions/skill-catalog 等系统注入样板
      const t = blockText(d.content)
      if (!t) continue
      realUserChars += t.length
      turns.push({ role: 'U', text: t, time: r.time })
    } else if (ty === 'assistant/message') {
      const t = blockText(d.message?.content)
      if (!t) continue
      const prev = turns[turns.length - 1]
      if (prev && prev.role === 'A' && prev.text === t) continue // 重试导致的重复
      assistantChars += t.length
      turns.push({ role: 'A', text: t, time: r.time })
    } else if (ty === 'tool/call') {
      const name = String(d.name || d.tool || '')
      if (name === 'compress') {
        let args = d.arguments
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args)
          } catch {
            args = null
          }
        }
        const content = args?.content
        if (typeof content === 'string') {
          if (content.trim()) compressBlocks.push({ seq: r.time || 0, content: content.trim() })
        } else if (Array.isArray(content)) {
          const parts = []
          for (const item of content) {
            if (!item || typeof item !== 'object') continue
            const range = [item.startId, item.endId].filter(Boolean).join('–')
            const head = [range, item.topic ? `「${item.topic}」` : ''].filter(Boolean).join(' ')
            const body = typeof item.summary === 'string' ? item.summary.trim() : ''
            if (head || body) parts.push(`${head}${head && body ? '\n' : ''}${body}`)
          }
          if (parts.length) compressBlocks.push({ seq: r.time || 0, content: parts.join('\n\n') })
        }
      }
    }
  }
  return { header, lastTitle, goals, turns, compressBlocks, turnCount, realUserChars, assistantChars }
}

function renderMd({ id, header, lastTitle, goals, turns, compressBlocks, turnCount, realUserChars, assistantChars, cwd, createdAt, depth, format, thin, siblingLegacy, projectLabel }) {
  const openGoals = [...goals.values()].filter((g) => g.phase === 'active')
  const out = [
    '---',
    `session_id: ${id}`,
    `project: ${cwd || 'unknown'}`,
    `project_label: ${projectLabel}`,
    `created_at: ${fmtTime(createdAt) || 'unknown'}`,
    `turns: ${turnCount}`,
    `depth: ${depth}`,
    `format: ${format}`,
    `agent_preset: ${String(header?.agentPreset || '')}`,
    `real_user_chars: ${realUserChars}`,
    `assistant_chars: ${assistantChars}`,
    `compress_blocks: ${compressBlocks.length}`,
    `signal: ${thin ? 'thin' : 'ok'}`,
    ...(siblingLegacy ? [`legacy_extra: ${basename(siblingLegacy)}（旧格式 chunk 流，未解析）`] : []),
    '---',
    '',
    `# ${lastTitle || `（无标题）${id}`}`,
    '',
  ]
  if (openGoals.length) {
    out.push('## 开放目标', '')
    for (const g of openGoals) out.push(`- ${g.objective}（phase=${g.phase}）`)
    out.push('')
  }
  const doneGoals = [...goals.values()].filter((g) => g.phase !== 'active')
  if (doneGoals.length) {
    out.push('## 历史目标', '')
    for (const g of doneGoals.slice(-5)) out.push(`- [${g.phase || '?'}] ${g.objective}`)
    out.push('')
  }
  if (compressBlocks.length) {
    out.push('## 压缩摘要（模型亲笔，密度最高）', '')
    compressBlocks.forEach((b, i) => {
      out.push(`### 摘要 ${i + 1} · ${fmtTime(b.seq)}`, '', b.content, '')
    })
  }
  if (turns.length) {
    out.push('## 对话', '')
    for (const t of turns) {
      if (t.role === 'U') out.push(`**U · ${fmtTime(t.time, false)}**`, '', t.text, '')
      else out.push('**A**', '', t.text, '')
    }
  }
  return { md: out.join('\n'), openGoals }
}

/**
 * 卡片源（S3.5）：把根会话的压缩摘要单独物化成一份小 md，交给向量索引。
 * 一个 `## 摘要 N · <日期>` 小节 ≈ 一个块，234 条摘要 ≈ 234 块（对比：全量对话 1.5 万块）。
 */
function renderCardsMd({ id, lastTitle, compressBlocks, cwd, createdAt, projectLabel }) {
  const out = [
    '---',
    `kind: session-card`,
    `session_id: ${id}`,
    `project: ${cwd || 'unknown'}`,
    `project_label: ${projectLabel}`,
    `created_at: ${fmtTime(createdAt) || 'unknown'}`,
    `summaries: ${compressBlocks.length}`,
    '---',
    '',
    `# ${lastTitle || `（无标题）${id}`}`,
    '',
  ]
  // 卡片只留摘要的第一段（<=420 字）：细节在 transcripts 原文里，卡片只负责“能被搜到”。
  compressBlocks.forEach((b, i) => {
    const flat = String(b.content || '').replace(/\s+/g, ' ').trim()
    const cut = flat.length > 420 ? `${flat.slice(0, 420)}…` : flat
    out.push(`### 摘要 ${i + 1} · ${fmtTime(b.seq)}`, '', cut, '')
  })
  return out.join('\n')
}

export function createArchiver({ log = () => {}, readConfigImpl } = {}) {  let running = null
  let last = null
  let lastAt = 0

  // 注意：config.js 的 readConfig() 是 async 的（返回 {config,path,raw,error} 的 Promise）
  const resolveConfig = async () => {
    if (!readConfigImpl) return null
    try {
      const result = await readConfigImpl()
      return result?.config ?? result ?? null
    } catch {
      return null
    }
  }

  const dirs = async () => {
    const config = await resolveConfig()
    const settings = archiveSettings(config)
    const outRoot = settings.transcripts_dir || join(String(config?.data_dir || defaultDataDir()), 'transcripts')
    // 卡片源目录：默认 <data_dir>/cards，可用 handoff.cards_dir 覆盖（交给环境变量也一样）
    const cardsRoot = String(settings.cards_dir || '').trim() || join(dirname(outRoot), 'cards')
    return { settings, outRoot, cardsRoot, sessionsRoot: settings.sessions_dir, config }
  }

  async function runOnce({ force = false, reason = 'manual' } = {}) {
    const started = Date.now()
    const { outRoot, sessionsRoot } = await dirs()
    const { cardsRoot } = await dirs()
    const stats = { reason, sessionsRoot, outRoot, cardsRoot, scanned: 0, written: 0, skipped: 0, failed: 0, bytesIn: 0, bytesOut: 0, root: 0, sub: 0, thin: 0, ok: 0, cards: 0, compressBlocks: 0, byProject: {}, errors: [] }
    if (!existsSync(sessionsRoot)) {
      last = { at: Date.now(), durationMs: Date.now() - started, ...stats, error: `会话目录不存在：${sessionsRoot}` }
      return last
    }
    const { files, legacySkipped } = listSessionFiles(sessionsRoot)
    stats.legacySkipped = legacySkipped.length
    ensureDir(outRoot)
    const manifestPath = join(outRoot, 'manifest.json')
    let manifest = { version: 1, parserVersion: PARSER_VERSION, updatedAt: 0, sessions: {} }
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch {
        /* 重建 */
      }
    }
    manifest.sessions = manifest.sessions || {}
    // 快速增量：按「文件路径 -> 已有条目」先判一遍，没变就不解压
    // （514 个会话解压要 30s 级别，定时任务不该每次都付这个代价）
    const byFile = new Map()
    for (const entry of Object.values(manifest.sessions)) {
      if (entry && typeof entry.file === 'string') byFile.set(entry.file, entry)
    }

    for (const file of files) {
      stats.scanned++
      let st
      try {
        st = statSync(file)
      } catch {
        stats.failed++
        continue
      }
      stats.bytesIn += st.size
      const known = byFile.get(file)
      if (!force && known && known.parserVersion === PARSER_VERSION && known.size === st.size && known.mtime === st.mtimeMs) {
        stats.skipped++
        stats.bytesOut += known.outBytes || 0
        continue
      }
      let text
      try {
        text = (await unzstd(readFileSync(file))).toString('utf8')
      } catch (err) {
        stats.failed++
        if (stats.errors.length < 5) stats.errors.push(`${basename(file)}: ${err.message}`)
        continue
      }
      const parsed = parseSession(text)
      const { header } = parsed
      const sessionId = String(header?.id || '') || file.split(/[\\/]/).filter(Boolean).slice(-2)[0]
      const cwd = String(header?.cwd || '')
      const createdAtRaw = Number(header?.createdAt || 0)
      const createdAt = createdAtRaw > 1e12 ? createdAtRaw : createdAtRaw * 1000
      const depth = Number(header?.delegationDepth || 0)
      const format = header && typeof header.version === 'number' ? header.version : 'old'
      const thin = parsed.realUserChars < 500
      const prevEntry = manifest.sessions[sessionId]
      if (!force && prevEntry && prevEntry.parserVersion === PARSER_VERSION && prevEntry.size === st.size && prevEntry.mtime === st.mtimeMs) {
        stats.skipped++
        stats.bytesOut += prevEntry.outBytes || 0
        continue
      }
      const projectLabel = labelFor(cwd)
      const projectDir = join(outRoot, projectLabel)
      ensureDir(projectDir)
      const mdPath = join(projectDir, `${sessionId}.md`)
      const siblingLegacy = legacySkipped.find((x) => x.dir === dirname(file))?.file || ''
      const rendered = renderMd({ ...parsed, id: sessionId, cwd, createdAt, depth, format, thin, siblingLegacy, projectLabel })
      try {
        writeFileSync(mdPath, rendered.md, 'utf8')
      } catch (err) {
        stats.failed++
        if (stats.errors.length < 5) stats.errors.push(`${basename(mdPath)}: ${err.message}`)
        continue
      }
      const outBytes = Buffer.byteLength(rendered.md, 'utf8')
      // 卡片源：把「模型亲笔的压缩摘要」单独物化成一份可被向量索引的 md（S3.5）。
      // 只收根会话且有摘要的，一个摘要一个 ## 小节（引擎按标题切块 → 一条摘要 ≈ 一块）。
      if (depth === 0 && parsed.compressBlocks.length) {
        try {
          const cardDir = join(cardsRoot, projectLabel)
          ensureDir(cardDir)
          writeFileSync(join(cardDir, `${sessionId}.md`), renderCardsMd({ ...parsed, id: sessionId, cwd, createdAt, projectLabel }), 'utf8')
          stats.cards = (stats.cards || 0) + 1
        } catch (err) {
          if (stats.errors.length < 5) stats.errors.push(`cards ${sessionId}: ${err.message}`)
        }
      }
      stats.written++
      stats.bytesOut += outBytes
      if (depth > 0) stats.sub++
      else stats.root++
      if (thin) stats.thin++
      else stats.ok++
      stats.compressBlocks += parsed.compressBlocks.length
      const pj = (stats.byProject[projectLabel] = stats.byProject[projectLabel] || { sessions: 0, bytes: 0 })
      pj.sessions++
      pj.bytes += outBytes
      const firstAsk = (parsed.turns.find((t) => t.role === 'U')?.text || '').replace(/\s+/g, ' ').trim().slice(0, 140)
      const lastAnswer = ([...parsed.turns].reverse().find((t) => t.role === 'A')?.text || '').replace(/\s+/g, ' ').trim().slice(0, 160)
      manifest.sessions[sessionId] = {
        sessionId,
        project: cwd,
        projectLabel,
        file,
        md: mdPath,
        size: st.size,
        mtime: st.mtimeMs,
        outBytes,
        format,
        depth,
        turns: parsed.turnCount,
        realUserChars: parsed.realUserChars,
        assistantChars: parsed.assistantChars,
        compressBlocks: parsed.compressBlocks.length,
        thin,
        title: parsed.lastTitle,
        parserVersion: PARSER_VERSION,
        createdAt: Number(createdAt) || 0,
        firstAsk,
        lastAnswer,
        openGoals: rendered.openGoals.slice(0, 3).map((g) => String(g.objective || '').replace(/\s+/g, ' ').trim().slice(0, 140)),
        updatedAt: Date.now(),
      }
    }

    manifest.updatedAt = Date.now()
    try {
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    } catch (err) {
      if (stats.errors.length < 5) stats.errors.push(`manifest: ${err.message}`)
    }
    last = {
      at: Date.now(),
      durationMs: Date.now() - started,
      ...stats,
      sessions: Object.keys(manifest.sessions).length,
      bytesInMB: +(stats.bytesIn / 1048576).toFixed(2),
      bytesOutMB: +(stats.bytesOut / 1048576).toFixed(2),
    }
    lastAt = Date.now()
    const summary = `归档完成：${last.written} 写 / ${last.skipped} 跳过 / ${last.failed} 失败，${last.bytesOutMB} MB，用时 ${(last.durationMs / 1000).toFixed(1)}s`
    log(summary)
    return last
  }

  function run(options = {}) {
    if (running) return running
    running = runOnce(options)
      .catch((err) => {
        last = { at: Date.now(), error: err?.message || String(err), written: 0, skipped: 0, failed: 1 }
        log(`归档失败：${last.error}`)
        return last
      })
      .finally(() => {
        running = null
      })
    return running
  }

  async function status() {
    const { settings, outRoot, sessionsRoot } = await dirs()
    return {
      enabled: settings.enabled,
      sessionsDir: sessionsRoot,
      transcriptsDir: outRoot,
      intervalMin: settings.interval_min,
      running: !!running,
      lastAt,
      last,
      parserVersion: PARSER_VERSION,
    }
  }

  return { run, status, dirs }
}