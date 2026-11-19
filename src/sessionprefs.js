import { readFile } from 'node:fs/promises'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

import { engineDir } from './config.js'
import { labelFor } from './projects.js'

/**
 * Per-session and per-project vector-memory preferences.
 *
 * The global `config.json` answers "what may this installation do". This file
 * answers "what does *this* conversation / *this* directory want right now":
 *
 *   recall     on | off   — inject the 【向量检索 · 本机记忆】 block at all
 *   scope      auto | all | memory | project — which sources the recall may search
 *   awareness  on | off   — inject the two awareness blocks (源清单 / 知识地图)
 *
 * Resolution order is session > project > global config. A missing key means
 * "inherit", so a conversation that never touched these switches costs exactly
 * one project lookup and behaves like before.
 *
 * It lives next to the engine (session-prefs.json) instead of inside
 * config.json on purpose: the config is the engine's contract, and hundreds of
 * session ids rotating through it would make every config write a session write.
 * The host is one long-lived process, so the in-memory snapshot is the read path
 * (`resolveNow`, synchronous, used by prompt-context text()) and the file is only
 * touched when the user flips a switch or a new session directory appears.
 */

export const PREFS_VERSION = 1

/** Keep the file bounded: oldest sessions are dropped first. */
const MAX_SESSIONS = 400
const MAX_PROJECTS = 200

export const SCOPE_MODES = [
  { value: 'auto', label: '自动（本项目 + 记忆）', hint: '当前项目目录的文档 + memory/，默认' },
  { value: 'all', label: '全部来源', hint: '所有已登记源一起检索（可能跨项目串味）' },
  { value: 'memory', label: '仅记忆', hint: '只搜 memory/ 与 harness-project/ 这类固定源' },
  { value: 'project', label: '仅本项目', hint: '只搜当前目录对应的项目源，不搜 memory/' },
]

const SCOPE_VALUES = new Set(SCOPE_MODES.map((item) => item.value))
const RECALL_VALUES = new Set(['on', 'off'])
const AWARENESS_VALUES = new Set(['on', 'off'])
const HANDOFF_VALUES = new Set(['on', 'off'])
const KEYS = [
  ['recall', RECALL_VALUES],
  ['scope', SCOPE_VALUES],
  ['awareness', AWARENESS_VALUES],
  ['handoff', HANDOFF_VALUES],
]

const norm = (value) => resolve(String(value)).toLowerCase().replace(/[\\/]+$/, '')
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

export function prefsPath() {
  const override = process.env.DSH_VECTOR_MEMORY_SESSION_PREFS
  if (override) return resolve(override)
  return resolve(engineDir(), 'session-prefs.json')
}

function emptyState() {
  return { version: PREFS_VERSION, updated_at: null, sessions: {}, projects: {} }
}

function cleanEntry(raw, { withRoot = false } = {}) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, allowed] of KEYS) {
    const value = raw[key]
    if (value === undefined || value === null || value === '' || value === 'inherit') continue
    if (!allowed.has(String(value))) continue
    out[key] = String(value)
  }
  if (withRoot && typeof raw.root === 'string' && raw.root.trim()) out.root = resolve(raw.root.trim())
  if (typeof raw.label === 'string' && raw.label) out.label = raw.label
  if (typeof raw.updated_at === 'string' && raw.updated_at) out.updated_at = raw.updated_at
  return out
}

function cleanState(raw) {
  const state = emptyState()
  if (!raw || typeof raw !== 'object') return state
  if (typeof raw.updated_at === 'string' && raw.updated_at) state.updated_at = raw.updated_at
  const sessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {}
  for (const [id, entry] of Object.entries(sessions)) {
    if (!id) continue
    const clean = cleanEntry(entry, { withRoot: true })
    if (Object.keys(clean).length) state.sessions[String(id)] = clean
  }
  const projects = raw.projects && typeof raw.projects === 'object' ? raw.projects : {}
  for (const [root, entry] of Object.entries(projects)) {
    if (!root) continue
    const clean = cleanEntry(entry)
    if (!clean.root) clean.root = String(root)
    state.projects[String(root)] = clean
  }
  return state
}

/** Apply a validated patch: `null` / '' / 'inherit' deletes the key (= follow parent). */
function applyPatch(target, patch, { root = null, label = null } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    if (root) target.root = resolve(root)
    if (label) target.label = label
    return target
  }
  for (const [key, allowed] of KEYS) {
    if (!(key in patch)) continue
    const value = patch[key]
    if (value === null || value === undefined || value === '' || value === 'inherit') {
      delete target[key]
      continue
    }
    if (!allowed.has(String(value))) throw new Error(`不支持的取值：${key}=${String(value)}`)
    target[key] = String(value)
  }
  if (root) target.root = resolve(root)
  if (label) target.label = label
  return target
}

/** Longest registered project whose directory contains `root`. */
export function findProjectEntry(projects, root) {
  if (!root) return { key: null, entry: {} }
  let low
  try {
    low = norm(root)
  } catch {
    return { key: null, entry: {} }
  }
  let bestKey = null
  let bestLength = -1
  let bestEntry = {}
  for (const [key, entry] of Object.entries(projects || {})) {
    if (!entry || typeof entry !== 'object') continue
    let keyLow
    try {
      keyLow = norm(entry.root || key)
    } catch {
      continue
    }
    if (!inside(low, keyLow)) continue
    if (keyLow.length > bestLength) {
      bestKey = key
      bestLength = keyLow.length
      bestEntry = entry
    }
  }
  return { key: bestKey, entry: bestEntry }
}

function prune(record, max, sortKey) {
  const entries = Object.entries(record)
  if (entries.length <= max) return record
  entries.sort((a, b) => String(b[1]?.[sortKey] || '').localeCompare(String(a[1]?.[sortKey] || '')))
  return Object.fromEntries(entries.slice(0, max))
}

export function createPrefs({ log = () => {}, path = prefsPath() } = {}) {
  let state = emptyState()
  let loaded = false
  let loading = null
  let chain = Promise.resolve()

  const serial = (task) => {
    const next = chain.then(task, task)
    chain = next.catch(() => {})
    return next
  }

  async function load() {
    try {
      const text = await readFile(path, 'utf8')
      state = cleanState(JSON.parse(text))
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        log(`会话偏好读取失败（按默认处理）：${error instanceof Error ? error.message : String(error)}`)
      }
      state = emptyState()
    }
    loaded = true
    return state
  }

  /** Resolves once the on-disk state is in memory; never rejects. */
  function ready() {
    if (loaded) return Promise.resolve(state)
    if (!loading) {
      loading = load().finally(() => {
        loading = null
      })
    }
    return loading
  }

  function snapshot() {
    return state
  }

  function sessionRoot(sessionId) {
    const id = String(sessionId || '').trim()
    if (!id) return null
    return state.sessions?.[id]?.root || null
  }

  /**
   * Synchronous resolution against the in-memory snapshot. Prompt-context text()
   * has to stay synchronous, so this is the only read path that matters there.
   */
  function resolveNow({ sessionId, root = null } = {}) {
    const id = String(sessionId || '').trim()
    const session = (id && state.sessions?.[id]) || {}
    const projectRoot = session.root || (root ? String(root) : null)
    const project = findProjectEntry(state.projects, projectRoot)
    const entry = project.entry || {}
    const origin = {}
    const pick = (key) => {
      if (session[key] !== undefined) {
        origin[key] = 'session'
        return session[key]
      }
      if (entry[key] !== undefined) {
        origin[key] = 'project'
        return entry[key]
      }
      origin[key] = 'global'
      return null
    }
    return {
      sessionId: id || null,
      recall: pick('recall'),
      scope: pick('scope'),
      awareness: pick('awareness'),
      handoff: pick('handoff'),
      origin,
      session,
      project: { key: project.key, entry, root: projectRoot ? resolve(projectRoot) : null },
    }
  }

  const resolveAsync = async ({ sessionId, root = null } = {}) => {
    await ready()
    return resolveNow({ sessionId, root })
  }

  async function write(next) {
    state = next
    loaded = true
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}`
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  }

  /** Patch one session; `root` records the directory so later reads need no agent. */
  async function updateSession(sessionId, patch, { root = null } = {}) {
    const id = String(sessionId || '').trim()
    if (!id) throw new Error('缺少会话 id')
    return serial(async () => {
      await ready()
      const now = new Date().toISOString()
      const next = { ...state, sessions: { ...state.sessions }, projects: { ...state.projects } }
      const entry = { ...(next.sessions[id] || {}) }
      applyPatch(entry, patch, { root })
      const meaningful = KEYS.some(([key]) => entry[key] !== undefined) || Boolean(entry.root)
      if (!meaningful) delete next.sessions[id]
      else {
        entry.updated_at = now
        next.sessions[id] = entry
      }
      next.sessions = prune(next.sessions, MAX_SESSIONS, 'updated_at')
      next.updated_at = now
      await write(next)
      return resolveNow({ sessionId: id, root })
    })
  }

  /** Patch one project (all sessions whose directory is inside it). */
  async function updateProject(root, patch) {
    const abs = String(root || '').trim()
    if (!abs) throw new Error('缺少项目目录')
    const storeKey = resolve(abs)
    return serial(async () => {
      await ready()
      const now = new Date().toISOString()
      const next = { ...state, sessions: { ...state.sessions }, projects: { ...state.projects } }
      const entry = { ...(next.projects[storeKey] || {}) }
      applyPatch(entry, patch, { root: storeKey, label: labelFor(storeKey) })
      entry.updated_at = now
      next.projects[storeKey] = entry
      next.projects = prune(next.projects, MAX_PROJECTS, 'updated_at')
      next.updated_at = now
      await write(next)
      return resolveNow({ root: storeKey })
    })
  }

  /** Remember which directory a session lives in (so the UI can resolve it later). */
  async function rememberRoot(sessionId, root) {
    const id = String(sessionId || '').trim()
    if (!id || !root) return null
    let abs
    try {
      abs = resolve(String(root))
    } catch {
      return null
    }
    if (state.sessions?.[id]?.root === abs) return null
    try {
      return await updateSession(id, {}, { root: abs })
    } catch (error) {
      log(`记录会话目录失败（忽略）：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  async function forgetSession(sessionId) {
    const id = String(sessionId || '').trim()
    if (!id) return false
    return serial(async () => {
      await ready()
      if (!state.sessions?.[id]) return false
      const next = { ...state, sessions: { ...state.sessions }, projects: { ...state.projects } }
      delete next.sessions[id]
      next.updated_at = new Date().toISOString()
      await write(next)
      return true
    })
  }

  return {
    path,
    ready,
    snapshot,
    resolveNow,
    resolve: resolveAsync,
    sessionRoot,
    updateSession,
    updateProject,
    rememberRoot,
    forgetSession,
  }
}
