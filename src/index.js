import { readFileSync } from 'node:fs'
import { configPath, ensureCardsSource, readConfig } from './config.js'
import { buildIndex, engineStatus, stopServiceSync } from './engine.js'
import { startJob, waitIdle } from './jobs.js'
import { recallScopeFor, projectScopeOnly, registerProject } from './projects.js'
import { pushEvent } from './events.js'
import { PROMPT_SECTION } from './prompt.js'
import { createSources } from './sources.js'
import { createOutline } from './outline.js'
import { createHandoff } from './handoff.js'
import { createCards } from './cards.js'
import { archiveSettings, createArchiver } from './archive.js'
import { createRecall, lastUserText } from './recall.js'
import { registerVectorMemoryRoutes } from './routes.js'
import { SCOPE_MODES, createPrefs } from './sessionprefs.js'
import { createSupervisor } from './supervisor.js'
import { registerVectorMemoryTools } from './tools.js'

export const name = 'dsh-vector-memory'
export const inject = ['tools']

const PACKAGE = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  } catch {
    return {}
  }
})()

const VERSION = PACKAGE.version || '0.0.0'

/**
 * Version display metadata. `version` itself stays strict semver, so the DSH
 * compatibility range and the release date are carried in their own fields and
 * only ever shown, never parsed for compatibility decisions.
 */
const META = {
  releaseDate: PACKAGE.releaseDate || '',
  dshRange: PACKAGE.engines?.dsh || '',
  verifiedOn: PACKAGE.dshCompat?.verifiedOn || '',
}

function safeGet(ctx, service) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(service) : undefined
  } catch {
    return undefined
  }
}

/** DSH 退出时是否连带关闭 Python 服务（默认开；配置里可关）。 */
function exitWithDshEnabled() {
  try {
    const cfg = JSON.parse(readFileSync(configPath(), 'utf8'))
    return cfg?.service?.exit_with_dsh !== false
  } catch {
    return true
  }
}

/**
 * Whether the recall context must survive the host turning runtime context off.
 * Read synchronously so `agent/created` can register without extra await.
 */
function recallRequireContext() {
  try {
    const cfg = JSON.parse(readFileSync(configPath(), 'utf8'))
    return cfg?.recall?.require_context === true
  } catch {
    return false
  }
}

function installExitCleanup(log) {  try {
    if (typeof process.once !== 'function') return
    process.once('exit', () => {
      try {
        if (!exitWithDshEnabled()) return
        stopServiceSync()
      } catch {
        // 退出钩子里绝不能抛
      }
    })
    log('已注册退出清理：关闭 DSH 时一并关闭向量服务')
  } catch (error) {
    log(`退出清理注册失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function withTimeout(promise, ms, fallback = null) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(fallback), ms)
    timer.unref?.()
    Promise.resolve(promise).then(finish, () => finish(fallback))
  })
}

/**
 * Cross-drive project sources.
 *
 * A session may live on E:\, F:\ — anywhere. When one is created we ask the
 * host's `workingDirectory` service for its directory, register that directory as
 * an extra index source, and give the recall a scope of [memory, that project].
 * Without that scope every search would also pull in the shared notes repo; with
 * it, project docs and memories live side by side.
 *
 * Everything here is best-effort: no workingDirectory service, an unreadable
 * config, or a busy job queue all just skip the step.
 */
function installProjects(ctx, log) {
  const agents = new Map()
  const lastIndex = new Map()

  const resolveRoot = async (agent) => {
    const wd = safeGet(ctx, 'workingDirectory')
    if (!wd) return null
    try {
      if (typeof wd.ensure === 'function') return await withTimeout(wd.ensure(agent), 1500, null)
      if (typeof wd.get === 'function') return wd.get(agent?.session ?? agent)
    } catch {
      return null
    }
    return null
  }

  const scheduleIndex = (root) => {
    const key = String(root).toLowerCase()
    const last = lastIndex.get(key) || 0
    if (Date.now() - last < 10 * 60 * 1000) return
    lastIndex.set(key, Date.now())
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await waitIdle(120000)
          const { config } = await readConfig()
          const started = startJob({
            kind: 'index',
            label: `索引项目 ${root}`,
            runner: async ({ log: jobLog, signal }) => buildIndex(config, { onLine: (line) => jobLog(line), signal }),
          })
          if (started.ok) log(`开始索引项目（后台）：${root}`)
          else log(`项目索引未启动：${started.error}`)
        } catch (error) {
          log(`项目索引失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
        }
      })()
    }, 5000)
    timer.unref?.()
  }

  const ensureProject = async (agent) => {
    if (!agent?.id) return null
    const cached = agents.get(agent.id)
    if (cached && Date.now() - cached.at < 60000) return cached
    const root = await resolveRoot(agent)
    if (!root) return cached ?? null
    const { config } = await readConfig()
    const settings = config.project_index || {}
    let result = null
    if (settings.auto_register !== false) {
      result = await registerProject(root)
      if (result?.ok && result.added) {
        log(`已登记跨盘项目源：${result.source.label}（${root}）`)
        pushEvent('info', `已登记项目源 ${result.source.label}：${root}`)
      } else if (result && result.ok === false) {
        log(`项目源未登记（${result.reason}）`)
      }
    }
    const scope = await recallScopeFor(root, { scoped: settings.recall_scoped !== false })
    const entry = { root, scope, at: Date.now() }
    agents.set(agent.id, entry)
    if (settings.auto_index !== false && !result?.covered) scheduleIndex(root)
    return entry
  }

  return {
    ensureProject,
    scopeFor: (agentId) => agents.get(agentId)?.scope ?? null,
    rootFor: (agentId) => agents.get(agentId)?.root ?? null,
    forget: (agentId) => agents.delete(agentId),
    // 「仅本项目」模式要的源名（不读 config 之外的缓存，直接问 projects.js）
    projectScopeOnly: (root) => projectScopeOnly(root),
    snapshot: () => [...agents.entries()].map(([id, item]) => ({ agent: String(id).slice(0, 8), root: item.root, scope: item.scope })),
  }
}

function installPromptSection(ctx, log) {
  const systemPrompt = safeGet(ctx, 'systemPrompt')
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    log('systemPrompt 不可用，提示词段落未注入')
    return
  }
  try {
    systemPrompt.section({ name: 'vector-memory', order: 2060, text: PROMPT_SECTION })
    log('提示词段落已注入（order 2060）')
  } catch (error) {
    log(`提示词注入失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * "Awareness" layer: two ~2 line context blocks — which note sources exist on
 * this machine (`vector-sources`) and what they talk about (`vector-outline`).
 * Without them a model only knows that a search tool exists, not what there is
 * to search, so it rarely looks — the exact failure mode this plugin fixes.
 *
 * Both used to be registered globally, so every conversation paid for them even
 * when the user wanted "this session is a throwaway chat, keep my memory out of
 * it". They are now registered per agent and gated by the session/project switch
 * in sessionprefs.js: when awareness is off, text() returns '' and DSH drops the
 * block. An unloaded prefs snapshot defaults to "on", so a broken file can never
 * silently remove the awareness layer.
 */
function installAwareness(ctx, log, { prefs = null, projects = null } = {}) {
  const sources = createSources({ log })
  const outline = createOutline({ log })
  const registered = new Set()

  const awarenessOn = (agent) => {
    if (!prefs) return true
    try {
      const resolved = prefs.resolveNow({ sessionId: agent?.id, root: projects?.rootFor?.(agent?.id) ?? null })
      return resolved.awareness !== 'off'
    } catch {
      return true
    }
  }

  const registerFor = (agent) => {
    if (!agent?.id || registered.has(agent.id)) return
    const scopedCtx = agent.ctx
    const systemPrompt = typeof scopedCtx?.get === 'function' ? scopedCtx.get('systemPrompt') : undefined
    if (!systemPrompt || typeof systemPrompt.context !== 'function') {
      log('agent 作用域没有 systemPrompt，知识源清单/知识地图未注册')
      return
    }
    try {
      systemPrompt.context({
        name: 'vector-sources',
        order: 949,
        text: () => (awarenessOn(agent) ? sources.text() : ''),
      })
      systemPrompt.context({
        name: 'vector-outline',
        order: 948,
        text: () => (awarenessOn(agent) ? outline.text() : ''),
      })
      registered.add(agent.id)
    } catch (error) {
      log(`知识块注册失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  void sources.warm().then((text) => {
    if (text) log(`知识源清单已就绪（${text.length} 字符）`)
    else log('知识源清单暂为空（还没有索引任何源）')
  })
  void outline.warm().then((text) => {
    if (text) log(`知识地图已就绪（${text.length} 字符，${outline.state.sources} 个源 / ${outline.state.topics} 个主题）`)
    else log('知识地图暂为空（索引结构里还没有可归纳的标题）')
  })

  if (typeof ctx.on === 'function') {
    ctx.on('agent/created', (payload = {}) => {
      const agent = payload?.agent
      if (!agent?.id) return
      registerFor(agent)
      void sources.warm().catch(() => {})
      void outline.warm().catch(() => {})
    })
    log('知识源清单/知识地图已改为按会话注册（可在会话里单独关闭）')
  } else {
    // No event system: fall back to the old global registration, always on.
    const systemPrompt = safeGet(ctx, 'systemPrompt')
    if (!systemPrompt || typeof systemPrompt.context !== 'function') {
      log('systemPrompt.context 不可用，知识源清单/知识地图未注入')
    } else {
      try {
        systemPrompt.context({ name: 'vector-sources', order: 949, text: () => sources.text() })
        systemPrompt.context({ name: 'vector-outline', order: 948, text: () => outline.text() })
      } catch (error) {
        log(`知识块注入失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return { sources, outline }
}

/**
 * 开场简报：给每个新会话注入「同一目录最近几个会话」的极短摘要。
 *
 * 为什么是 per-agent：①每个会话的目录不同，简报内容不同；②用户可以在会话里
 * 单独关掉它（prefs.handoff = 'off'），关掉时必须真的不注入——全局注册做不到。
 * 文本在 agent/created 之后异步算好放进 Map，text() 同步取；算好前返回空串，
 * 宿主会丢弃空块，所以最坏只是第一个请求没有简报。
 */
function installHandoff(ctx, log, { prefs = null, projects = null } = {}) {
  const handoff = createHandoff({ log })
  void handoff.warm()
  const texts = new Map()
  const regord = new Set()

  const fill = (agent) => {
    void (async () => {
      try {
        const entry = projects ? await projects.ensureProject(agent) : null
        const root = entry?.root || ''
        if (prefs) {
          const resolved = prefs.resolveNow({ sessionId: agent.id, root: root || null })
          if (resolved.handoff === 'off') {
            texts.delete(agent.id)
            return
          }
        }
        await handoff.warm()
        const text = handoff.textFor(root, { exclude: agent.id })
        if (text) texts.set(agent.id, text)
        else texts.delete(agent.id)
      } catch (error) {
        log(`开场简报生成失败（本轮跳过）：${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }

  const registerFor = (agent) => {
    if (!agent?.id || regord.has(agent.id)) return
    const systemPrompt = typeof agent.ctx?.get === 'function' ? agent.ctx.get('systemPrompt') : undefined
    if (!systemPrompt || typeof systemPrompt.context !== 'function') return
    try {
      systemPrompt.context({
        name: 'vector-handoff',
        order: 947,
        text: () => texts.get(agent.id) || '',
      })
      regord.add(agent.id)
    } catch (error) {
      log(`开场简报注册失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (typeof ctx.on === 'function') {
    ctx.on('agent/created', (payload = {}) => {
      const agent = payload?.agent
      if (!agent?.id) return
      registerFor(agent)
      fill(agent)
    })
    ctx.on('agent/disposed', (payload = {}) => {
      const id = payload?.agent?.id ?? payload?.id
      if (!id) return
      texts.delete(id)
      regord.delete(id)
    })
  }

  return {
    textFor: (root) => handoff.textFor(root),
    preview: (root) => handoff.preview(root),
    invalidate: () => handoff.invalidate(),
    snapshot: () => ({ agents: texts.size }),
  }
}

/**
 * 归档器（S0）：启动后延迟跑一次 + 定时跑，避免简报随会话变旧而失效。
 * 手动触发走 `POST /api/dsh-vector-memory/archive/run`。
 */
function installArchiver(ctx, log) {
  const archiver = createArchiver({ log, readConfigImpl: readConfig })
  let timer = null
  let kick = null
  void (async () => {
    try {
      const { config } = await readConfig()
      const settings = archiveSettings(config)
      if (!settings.enabled) {
        log('会话归档关闭（handoff.auto_archive=false），只能手动触发')
        return
      }
      // 60s 后再跑：错开索引、嵌入服务启动的高峰
      kick = setTimeout(() => {
        void archiver.run({ reason: 'startup' })
      }, 60_000)
      kick.unref?.()
      timer = setInterval(
        () => {
          void archiver.run({ reason: 'interval' })
        },
        Math.max(15, settings.interval_min) * 60_000,
      )
      timer.unref?.()
      log(`会话归档已启用（每 ${settings.interval_min} 分钟检查一次，会话目录 ${settings.sessions_dir}）`)
    } catch (error) {
      log(`会话归档启动失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      if (timer) clearInterval(timer)
      if (kick) clearTimeout(kick)
      timer = null
      kick = null
    }, 'vector-memory: archiver')
  }
  return {
    run: (options) => archiver.run(options),
    status: () => archiver.status(),
    dirs: () => archiver.dirs(),
  }
}

/**
 * Turn one UI scope mode into the engine's `srcs` filter.
 * `null` = search everything, `[]` = nothing to search (skip the query).
 */
async function resolveScope({ mode = 'auto', entry = null, projects = null } = {}) {
  if (mode === 'all') return { scope: null, empty: false }
  // 「仅记忆」= 长期记忆 + 旧会话卡片（两者都是跨项目、跟目录无关的）
  if (mode === 'memory') {
    const keep = new Set(['memory', 'cards'])
    const auto = Array.isArray(entry?.scope) ? entry.scope : []
    const scope = auto.filter((name) => keep.has(name))
    return { scope: scope.length ? scope : ['memory'], empty: false }
  }
  if (mode === 'project') {
    if (!projects || !entry?.root) return { scope: [], empty: true }
    try {
      const scope = await projects.projectScopeOnly(entry.root)
      return { scope, empty: scope.length === 0 }
    } catch {
      return { scope: [], empty: true }
    }
  }
  const auto = entry?.scope ?? null
  return { scope: auto, empty: Array.isArray(auto) && auto.length === 0 }
}

/**
 * sessionId -> working directory, for the settings/UI side, where no agent object
 * is at hand. Two hops, cheapest first: the agents registry + workingDirectory
 * service, then the directory remembered in session-prefs.json.
 */
function createSessionRootResolver(ctx, projects = null) {
  return async function rootFor(sessionId) {
    const id = String(sessionId || '').trim()
    if (!id) return null
    const wd = safeGet(ctx, 'workingDirectory')
    try {
      const agents = safeGet(ctx, 'agents')
      const agent = typeof agents?.get === 'function' ? agents.get(id) : null
      if (agent && wd) {
        if (typeof wd.get === 'function') {
          const value = wd.get(agent.session ?? agent)
          if (value) return value
        }
        if (typeof wd.ensure === 'function') {
          const value = await withTimeout(wd.ensure(agent), 1500, null)
          if (value) return value
        }
      }
    } catch {
      // fall through to the remembered directory
    }
    return projects?.rootFor?.(id) || null
  }
}

/**
 * P0 auto-recall wiring.
 *
 * Every agent gets one dynamic prompt context whose text is filled during that
 * turn's first pre-step. Nothing is persisted into the session log; if anything
 * here fails the turn simply proceeds without the block.
 */
function installAutoRecall(ctx, log, projects = null, prefs = null, cards = null) {
  if (typeof ctx.on !== 'function') {
    log('事件系统不可用，自动召回未启用（工具检索仍可用）')
    return null
  }
  const recall = createRecall({ log })
  // 归档卡片块的文本（每个 agent 一份）。和召回块一样，只在内存里，不进会话日志。
  const cardText = new Map()
  async function fillCards(agent, messages, disable) {
    if (!cards || !agent?.id) return
    if (disable) {
      cardText.delete(agent.id)
      return
    }
    try {
      const query = lastUserText(Array.isArray(messages) ? messages : [])
      const cfg = (await readConfig())?.config ?? null
      const text = await cards.inject(query, cfg)
      if (text) cardText.set(agent.id, text)
      else cardText.delete(agent.id)
    } catch (error) {
      cardText.delete(agent.id)
      log(`归档卡片检索失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    ctx.on('agent/created', (payload = {}) => {
      try {
        const agent = payload?.agent
        if (!agent?.id) return
        const scopedCtx = agent.ctx
        const systemPrompt = typeof scopedCtx?.get === 'function' ? scopedCtx.get('systemPrompt') : undefined
        if (!systemPrompt || typeof systemPrompt.context !== 'function') {
          log('agent 作用域没有 systemPrompt，自动召回上下文未注册')
          return
        }
        if (recall.isRegistered(agent.id)) return
        const contextEntry = {
          name: 'vector-search',
          order: 950,
          text: () => recall.textFor(agent.id),
        }
        // DSH 可以整块关闭「运行时上下文」(system-prompt config includeRuntimeContext=false)，
        // 那时普通 context 会被静默丢弃；required:true 是唯一的豁免通道，交由用户显式开启。
        if (recallRequireContext()) contextEntry.required = true
        systemPrompt.context(contextEntry)
        recall.markRegistered(agent.id)
        // 归档卡片：独立一块、order 946（在知识地图 948 之前），没命中时 text() 返回空串，
        // DSH 会丢掉空块，所以"没有相关旧会话"等于零噪音。
        if (cards && !cards.isRegistered?.(agent.id)) {
          try {
            const cardEntry = {
              name: 'vector-cards',
              order: 946,
              text: () => cardText.get(agent.id) || '',
            }
            if (recallRequireContext()) cardEntry.required = true
            systemPrompt.context(cardEntry)
            cards.markRegistered?.(agent.id)
          } catch (error) {
            log(`归档卡片上下文注册失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        log(`自动召回上下文已注册（agent ${String(agent.id).slice(0, 8)}）`)
        // Resolve this agent's directory + register it as a project source. The
        // directory is then remembered in session-prefs.json, so the in-session
        // switch can resolve it later without an agent object at hand.
        if (projects) {
          projects
            .ensureProject(agent)
            .then((entry) => {
              if (entry?.root && prefs) void prefs.rememberRoot(agent.id, entry.root).catch(() => {})
            })
            .catch((error) => {
              log(`跨盘项目登记失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
            })
        }
        if (prefs) void prefs.ready().catch(() => {})
      } catch (error) {
        log(`自动召回上下文注册失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })

    // 每个回合最多尝试几次召回。第一次通常在第 1 步做；如果那一次失败了
    // （典型情况：DSH 刚重启，向量服务还在冷启动，2 秒超时被 abort），
    // 就在同一回合的后续步骤再试，避免"重启后第一轮完全没有召回"。
    const recallAttempts = new Map()
    const MAX_RECALL_ATTEMPTS = 3

    ctx.on('agent/pre-step', async (payload, next) => {
      try {
        const { agent, messages, turn, step, signal } = payload ?? {}
        if (agent?.id) {
          const id = agent.id
          const turnKey = `${id}|${turn ?? 0}`
          const used = recallAttempts.get(turnKey) ?? 0
          // 会话/项目级开关：先按快照判一次，决定这一回合要不要花一次检索。
          const preset = prefs ? await prefs.resolve({ sessionId: id, root: projects?.rootFor?.(id) ?? null }) : null
          const presetOff = preset?.recall === 'off'
          const empty = !recall.textFor(id)
          // 被关掉时不再重试：重试只会反复写空缓存、白刷统计。
          const shouldRun = step === 1 || (!presetOff && empty && used < MAX_RECALL_ATTEMPTS)
          if (shouldRun) {
            if (recallAttempts.size > 512) recallAttempts.clear()
            recallAttempts.set(turnKey, used + 1)
            const entry = projects ? await projects.ensureProject(agent) : null
            if (entry?.root && prefs) void prefs.rememberRoot(id, entry.root).catch(() => {})
            const resolved = prefs ? await prefs.resolve({ sessionId: id, root: entry?.root ?? null }) : null
            const disabled = resolved?.recall === 'off'
            const mode = resolved?.scope || 'auto'
            const { scope, empty: nothingToSearch } = await resolveScope({ mode, entry, projects })
            await recall.prepare(agent, Array.isArray(messages) ? messages : [], turn, scope, signal ?? null, {
              muted: disabled || nothingToSearch,
              mode: disabled ? 'off' : mode,
            })
            // 归档卡片：只在「向量召回没有强相关命中」时补一条旧会话摘要，
            // 避免和召回块叠着抢注意力（弱相关/没命中时卡片才是主要线索）。
            const snap = recall.snapshot?.() || {}
            const weak = snap.lastStatus !== 'found'
            await fillCards(agent, messages, disabled || !weak)
          }
        }
      } catch (error) {
        log(`自动召回预取失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    })

    // Long-lived host process: drop per-agent state when an agent goes away.
    ctx.on('agent/disposed', (payload = {}) => {
      try {
        const id = payload?.agent?.id
        if (!id) return
        recall.forget(id)
        cardText.delete(id)
        projects?.forget?.(id)
      } catch {
        // ignore
      }
    })

    // Compaction replaces a long stretch of the conversation with a summary. The recall block
    // fetched for the old turn no longer matches the (now much shorter) context, so drop the cache
    // and let the next step search again. `compaction/end` is a *session log* event type, not a
    // cordis event, so it has to be observed through `session/event` (payload: { session, event }).
    ctx.on('session/event', (payload = {}) => {
      try {
        const event = payload?.event
        if (event?.type !== 'compaction/end') return
        if (event?.data?.error) return
        recall.invalidateAll()
        cardText.clear()
        cards?.invalidate?.()
        log('会话已压缩，下一次请求会重新检索向量记忆')
      } catch {
        // ignore
      }
    })

    log('自动召回已启用（每回合第一步，含超时与字符上限，失败自动跳过）')
    return recall
  } catch (error) {
    log(`自动召回注册失败（工具检索不受影响）：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * Base layer plugin.
 *
 * Design rules (this plugin is meant to live here for a long time):
 *  - apply() never throws: a broken tool must not stop DSH from booting.
 *  - every external call has a timeout; nothing blocks a turn.
 *  - the settings page is a bridge to files, not a second source of truth.
 *  - the supervisor only warms and indexes; it never changes user data.
 */
export function apply(ctx, config = {}) {
  const options = { tools: true, prompt: true, routes: true, recall: true, projects: true, supervisor: true, archive: true, ...config }
  const log = (message) => {
    try {
      pushEvent('info', message)
      ctx.logger?.info?.(`[vector-memory] ${message}`)
    } catch {
      // logging must never break plugin loading
    }
  }

  const engine = engineStatus()
  log(`v${VERSION} 启动：引擎 ${engine.dir}${engine.cliExists ? '' : '（未找到 vsearch.py！）'}`)

  const supervisor = createSupervisor({ log, getVersion: () => VERSION })
  // Late-bound handles: tools are registered before recall exists, but
  // vmemory_status needs to read the recall counters at call time.
  const runtime = { recall: null }

  try {
    if (options.tools) {
      const tools = safeGet(ctx, 'tools') ?? ctx.tools
      if (tools && typeof tools.register === 'function') {
        try {
          registerVectorMemoryTools(tools, log, runtime)
        } catch (error) {
          log(`工具注册失败：${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        log('tools 服务不可用，三个 vmemory_* 工具未注册')
      }
    }

    // 会话/项目级开关：全局 config 说「这台机器允许做什么」，session-prefs.json
    // 说「这个会话 / 这个目录现在想不想用」。只有需要注入的层面才创建它。
    const prefsRuntime = options.prompt || options.recall ? createPrefs({ log }) : null
    if (prefsRuntime) {
      void prefsRuntime.ready().then((state) => {
        const sessions = Object.keys(state.sessions || {}).length
        const projectsWithPrefs = Object.keys(state.projects || {}).length
        log(`会话级开关已加载（${sessions} 个会话 / ${projectsWithPrefs} 个项目有自定义设置）`)
      })
    }

    if (options.prompt) installPromptSection(ctx, log)
    const projectsRuntime = options.projects ? installProjects(ctx, log) : null
    if (options.prompt) installAwareness(ctx, log, { prefs: prefsRuntime, projects: projectsRuntime })
    const handoffRuntime = options.prompt ? installHandoff(ctx, log, { prefs: prefsRuntime, projects: projectsRuntime }) : null
    const cardsRuntime = options.recall ? createCards({ log }) : null
  const recallRuntime = options.recall ? installAutoRecall(ctx, log, projectsRuntime, prefsRuntime, cardsRuntime) : null
    const archiveRuntime = options.archive ? installArchiver(ctx, log) : null
  // 会话卡片源（S3.5）：只登记一次，之后打索引时一起进向量库
  if (options.prompt || options.recall) void ensureCardsSource(log).catch(() => {})
    runtime.recall = recallRuntime

    installExitCleanup(log)

    if (options.routes) {
      const mount = () => {
        try {
          const { dispose } = registerVectorMemoryRoutes(ctx, {
            version: VERSION,
            meta: META,
            supervisor,
            log,
            recall: recallRuntime,
            projects: projectsRuntime,
            // 会话内快捷开关用的运行时：偏好存储 + sessionId→目录解析 + 范围模式表
            session: {
              prefs: prefsRuntime,
              rootFor: createSessionRootResolver(ctx, projectsRuntime),
              modes: SCOPE_MODES,
              handoff: handoffRuntime,
            },
            archive: archiveRuntime,
          cards: cardsRuntime,
          })
          if (typeof ctx.effect === 'function' && typeof dispose === 'function') {
            ctx.effect(() => dispose, 'vector-memory: settings routes')
          }
        } catch (error) {
          log(`设置页接口挂载失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['webServer'], () => mount())
        } catch {
          mount()
        }
      } else {
        mount()
      }
    }

    if (options.supervisor) {
      try {
        supervisor.start()
        if (typeof ctx.effect === 'function') ctx.effect(() => () => supervisor.stop(), 'vector-memory: supervisor')
      } catch (error) {
        log(`守护进程启动失败：${error instanceof Error ? error.message : String(error)}`)
      }
      // Warm the cache once so the first state request is cheap, and surface a
      // missing engine early in the log rather than on the user's first search.
      void readConfig()
        .then(({ config, error }) => {
          if (error) log(`配置文件读取有问题：${error}`)
          if (!engine.cliExists) log('引擎缺失：vmemory_search 会返回明确错误，设置页会显示红色提示')
          return config
        })
        .catch((error) => log(`启动自检失败：${error instanceof Error ? error.message : String(error)}`))
    }
  } catch (error) {
    log(`插件初始化失败（已忽略，DSH 继续启动）：${error instanceof Error ? error.message : String(error)}`)
  }
}

export { VERSION }

