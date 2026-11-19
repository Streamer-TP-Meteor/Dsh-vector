import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

import { PLUGIN_DIR, clone, engineDir, readConfig, writeConfig } from './config.js'

/**
 * Cross-drive project sources.
 *
 * The engine indexes `config.sources` (memory/, harness-project/) plus
 * `config.project_sources` — an array this module maintains. A session whose
 * working directory is on E:\ or F:\ therefore gets its own docs indexed and
 * retrievable, without a second code path: it is just another source.
 *
 * Two guard rails keep this safe on a machine with a nearly full C: drive and a
 * CPU-only embedding model:
 *   - only text-like extensions (project_index.extensions), with per-file and
 *     per-source caps, and noise directories skipped in the engine;
 *   - roots that are already covered (or would cover) an existing source are not
 *     registered again, so a directory inside an existing source is never indexed twice.
 */

// Never register these: system trees, other apps, and DSH's own caches. Indexing
// them would burn minutes of CPU embedding and produce noise.
// 只拦「明确的系统/缓存位置」，不写死任何一台机器的用户名或盘符：
// 其余该拦的目录（索引自己的 data_dir、引擎目录、插件目录）在运行时动态算，
// 因为它们随 config.json 变——写死的清单迟早和真实安装对不上。
const SYSTEM_PREFIXES = [
  'c:\\windows',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\programdata',
  'c:\\$recycle.bin',
  join(homedir(), 'appdata'),
  join(homedir(), '.cache'),
  '/proc',
  '/sys',
  '/dev',
  '/usr',
  '/etc',
]

function blockedPrefixes(config = null) {
  const list = [...SYSTEM_PREFIXES]
  for (const extra of [config?.data_dir, engineDir(), PLUGIN_DIR]) {
    if (typeof extra === 'string' && extra.trim()) list.push(norm(extra))
  }
  return list.map((item) => norm(item))
}

const norm = (p) => resolve(p).toLowerCase().replace(/[\\/]+$/, '')
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

/** Serialize read-modify-write of the shared config file inside this process. */
let chain = Promise.resolve()
function serial(task) {
  const next = chain.then(task, task)
  chain = next.catch(() => {})
  return next
}

export function labelFor(root) {
  const abs = resolve(root)
  const drive = (abs.match(/^([A-Za-z]):/) || [])[1]
  // 保留 Unicode 字母数字：中文目录名会退化成 "d--" 这样的标签，既难辨认也难在搜索结果里区分
  // （历史源 proj-d-- 仍按旧 label 工作，改名只影响新登记的目录）
  const raw = basename(abs)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_.-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  const base = raw || 'root'
  return `${drive ? drive.toLowerCase() : 'x'}-${base}`
}

export function projectNameFor(root) {
  return `proj-${labelFor(root)}`
}

export async function listProjects() {
  const { config, error } = await readConfig()
  return {
    projects: Array.isArray(config.project_sources) ? config.project_sources : [],
    settings: config.project_index || {},
    error,
  }
}

/**
 * Register one directory as a project source. Idempotent by normalized path.
 * Returns { ok, added, source?, reason? } and never throws for a "not now" case.
 */
// 代码扩展名白名单：project_index.code_index=false 时从源里剔除，
// 这样关掉代码索引不需要用户手动改每个源。
const CODE_EXTS = new Set([
  '.py', '.pyw', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.cs', '.gd', '.lua',
])

function pickExtensions(list, settings = {}) {
  const base = Array.isArray(list) && list.length ? list : ['.md', '.mdx', '.txt', '.rst']
  if (settings.code_index !== false) return base
  const kept = base.filter((ext) => !CODE_EXTS.has(String(ext).toLowerCase()))
  return kept.length ? kept : ['.md']
}

export async function registerProject(root, { extensions, maxFiles, maxFileKb } = {}) {
  const abs = resolve(root)
  return serial(async () => {
    if (!existsSync(abs)) return { ok: false, reason: `目录不存在：${abs}` }
    const low = norm(abs)
    if (blockedPrefixes().some((prefix) => inside(low, prefix))) {
      return { ok: false, reason: `系统/缓存目录不索引：${abs}` }
    }

    const { config } = await readConfig()
    const list = Array.isArray(config.project_sources) ? config.project_sources : []
    const settings = config.project_index || {}
    const fixed = Array.isArray(config.sources) ? config.sources : []

    // Already covered by a fixed source? Then this directory is inside an existing source:
    // and must not be added a second time under another label.
    for (const source of fixed) {
      if (!source?.root) continue
      const rootLow = norm(source.root)
      if (inside(low, rootLow) || inside(rootLow, low)) {
        return { ok: true, added: false, covered: true, source: { name: source.name, root: source.root } }
      }
    }

    const found = list.find((item) => item?.root && norm(item.root) === low)
    if (found) return { ok: true, added: false, source: found }

    const baseLabel = labelFor(abs)
    let label = baseLabel
    for (let i = 2; list.some((item) => item.label === label); i += 1) label = `${baseLabel}-${i}`
    const source = {
      name: `proj-${label}`,
      label,
      root: abs,
      globs: ['**/*'],
      extensions: pickExtensions(extensions || settings.extensions, settings),
      max_files: maxFiles || settings.max_files || 200,
      max_file_kb: maxFileKb || settings.max_file_kb || 512,
      enabled: true,
      added_at: new Date().toISOString(),
    }

    const next = clone(config)
    next.project_sources = [...list, source]
    await writeConfig(next)
    return { ok: true, added: true, source }
  })
}

export async function removeProject(name) {
  return serial(async () => {
    const { config } = await readConfig()
    const list = Array.isArray(config.project_sources) ? config.project_sources : []
    const kept = list.filter((item) => item?.name !== name)
    if (kept.length === list.length) return { ok: false, reason: `没有这个项目源：${name}` }
    const next = clone(config)
    next.project_sources = kept
    await writeConfig(next)
    return { ok: true, removed: name, remaining: kept.length }
  })
}

/** Source names that a recall in this directory may search. `null` = no filter. */
export async function recallScopeFor(root, { scoped = true, config: preset = null } = {}) {
  if (!scoped) return null
  const config = preset || (await readConfig()).config
  const scope = ['memory']
  // 会话卡片（旧会话压缩摘要）走同一个向量库，跨会话也靠它：默认一直参与
  if (Array.isArray(config.sources) && config.sources.some((item) => item && item.name === 'cards')) scope.push('cards')
  if (!root) return scope
  const low = norm(root)
  const list = Array.isArray(config.project_sources) ? config.project_sources : []
  const hit = list.find((item) => item?.root && (inside(low, norm(item.root)) || inside(norm(item.root), low)))
  if (hit) scope.push(hit.name)
  else if (Array.isArray(config.sources)) {
    // Covered by a fixed source: extend the scope to its siblings so
    // harness-project still shows up next to memory.
    for (const source of config.sources) {
      if (!source?.root) continue
      const rootLow = norm(source.root)
      if (inside(low, rootLow) || inside(rootLow, low)) scope.push(source.name)
    }
  }
  return [...new Set(scope)]
}

/** Normalized absolute path, exported for the session-prefs layer and the routes. */
export function normalizeRoot(root) {
  return norm(root)
}

/** The project source whose directory contains `root` (or is contained by it). */
export function projectSourceFor(config, root) {
  if (!root) return null
  let low
  try {
    low = norm(root)
  } catch {
    return null
  }
  const list = Array.isArray(config?.project_sources) ? config.project_sources : []
  return list.find((item) => item?.root && (inside(low, norm(item.root)) || inside(norm(item.root), low))) || null
}

/**
 * Scope for 「仅本项目」: the project source alone, never memory/.
 * When the directory is covered by fixed sources instead (the shared notes repo and its
 * subdirectories), its own docs are those fixed sources minus `memory` — so the
 * main workspace still gets a meaningful "project only" answer.
 * An empty array is meaningful: "this directory has no project docs yet", and the
 * caller must skip the search instead of falling back to a global one.
 */
export async function projectScopeOnly(root, { config: preset = null } = {}) {
  const config = preset || (await readConfig()).config
  const source = projectSourceFor(config, root)
  if (source) return [source.name]
  if (!root) return []
  const low = norm(root)
  const names = []
  for (const item of Array.isArray(config.sources) ? config.sources : []) {
    if (!item?.root || item.name === 'memory') continue
    const rootLow = norm(item.root)
    if (inside(low, rootLow) || inside(rootLow, low)) names.push(item.name)
  }
  return [...new Set(names)]
}

/** Flip one project source's `enabled` flag (the engine skips disabled sources). */
export async function setProjectEnabled(name, enabled = true) {
  return serial(async () => {
    const { config } = await readConfig()
    const list = Array.isArray(config.project_sources) ? config.project_sources : []
    const index = list.findIndex((item) => item?.name === name)
    if (index < 0) return { ok: false, reason: `没有这个项目源：${name}` }
    const flag = enabled !== false
    const next = clone(config)
    next.project_sources = list.map((item, i) => (i === index ? { ...item, enabled: flag } : item))
    await writeConfig(next)
    return { ok: true, name, enabled: flag, source: next.project_sources[index] }
  })
}
