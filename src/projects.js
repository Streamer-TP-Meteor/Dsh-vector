import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

import { clone, readConfig, writeConfig } from './config.js'

/**
 * Cross-drive project sources.
 *
 * The engine indexes `config.sources` (whatever notes folders you registered)
 * plus `config.project_sources` — an array this module maintains. A session
 * whose working directory is on another drive therefore gets its own docs
 * indexed and retrievable, without a second code path: it is just another
 * source.
 *
 * Two guard rails keep this safe on a machine with a nearly full system drive
 * and a CPU-only embedding model:
 *   - only text-like extensions (project_index.extensions), with per-file and
 *     per-source caps, and noise directories skipped in the engine;
 *   - roots that are already covered (or would cover) an existing source are not
 *     registered again, so a workspace is never indexed twice.
 */

// Never register these: system trees, other apps, and runtime caches. Indexing
// them would burn minutes of CPU embedding and produce noise. Everything is
// derived from the current OS/user, so it is correct on any machine.
function blockedPrefixes() {
  const home = homedir()
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const programData = process.env.ProgramData || 'C:\\ProgramData'
  const systemDrive = process.env.SystemDrive || 'C:'
  return [
    join(systemDrive, '\\', 'Windows'),
    programFiles,
    programFilesX86,
    programData,
    join(systemDrive, '\\', '$Recycle.Bin'),
    appData,
    localAppData,
    join(home, '.dsh', 'dsh-runtimes'),
    join(home, '.cache'),
    // Our own data/models directories must never be indexed as a project.
    ...(process.env.DSH_VECTOR_MEMORY_DATA ? [process.env.DSH_VECTOR_MEMORY_DATA] : []),
  ]
}

const BLOCKED = blockedPrefixes().map((item) => resolve(item).toLowerCase())

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
export async function registerProject(root, { extensions, maxFiles, maxFileKb } = {}) {
  const abs = resolve(root)
  return serial(async () => {
    if (!existsSync(abs)) return { ok: false, reason: `目录不存在：${abs}` }
    const low = norm(abs)
    if (BLOCKED.some((prefix) => inside(low, prefix))) {
      return { ok: false, reason: `系统/缓存目录不索引：${abs}` }
    }

    const { config } = await readConfig()
    const list = Array.isArray(config.project_sources) ? config.project_sources : []
    const settings = config.project_index || {}
    const fixed = Array.isArray(config.sources) ? config.sources : []

    // Already covered by a fixed source? Then this directory is the workspace
    // memory root and must not be added a second time under another label.
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
      extensions: extensions || settings.extensions || ['.md', '.mdx', '.txt', '.rst'],
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
export async function recallScopeFor(root, { scoped = true } = {}) {
  if (!scoped) return null
  const { config } = await readConfig()
  const scope = ['memory']
  if (!root) return scope
  const low = norm(root)
  const list = Array.isArray(config.project_sources) ? config.project_sources : []
  const hit = list.find((item) => item?.root && (inside(low, norm(item.root)) || inside(norm(item.root), low)))
  if (hit) scope.push(hit.name)
  else if (Array.isArray(config.sources)) {
    // Covered by a fixed source (the workspace root): extend the scope to its
    // siblings so a project inside the workspace still searches its documents.
    for (const source of config.sources) {
      if (!source?.root) continue
      const rootLow = norm(source.root)
      if (inside(low, rootLow) || inside(rootLow, low)) scope.push(source.name)
    }
  }
  return [...new Set(scope)]
}
