import { readFileSync } from 'node:fs'
import { configPath, readConfig, seedConfig } from './config.js'
import { buildIndex, engineStatus, stopServiceSync } from './engine.js'
import { startJob, waitIdle } from './jobs.js'
import { recallScopeFor, registerProject } from './projects.js'
import { pushEvent } from './events.js'
import { PROMPT_SECTION } from './prompt.js'
import { createRecall } from './recall.js'
import { registerVectorMemoryRoutes } from './routes.js'
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
 * Without the scope a search inside a project would surface the workspace
 * memory sources only; with it, project docs and memories live side by side.
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
 * P0 auto-recall wiring.
 *
 * Every agent gets one dynamic prompt context whose text is filled during that
 * turn's first pre-step. Nothing is persisted into the session log; if anything
 * here fails the turn simply proceeds without the block.
 */
function installAutoRecall(ctx, log, projects = null) {
  if (typeof ctx.on !== 'function') {
    log('事件系统不可用，自动召回未启用（工具检索仍可用）')
    return null
  }
  const recall = createRecall({ log })
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
        log(`自动召回上下文已注册（agent ${String(agent.id).slice(0, 8)}）`)
        // Resolve this agent's directory + register it as a project source.
        if (projects) {
          projects.ensureProject(agent).catch((error) => {
            log(`跨盘项目登记失败（已忽略）：${error instanceof Error ? error.message : String(error)}`)
          })
        }
      } catch (error) {
        log(`自动召回上下文注册失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })

    ctx.on('agent/pre-step', async (payload, next) => {
      try {
        const { agent, messages, turn, step, signal } = payload ?? {}
        if (agent?.id && step === 1) {
          const entry = projects ? await projects.ensureProject(agent) : null
          await recall.prepare(agent, Array.isArray(messages) ? messages : [], turn, entry?.scope ?? null, signal ?? null)
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
        projects?.forget?.(id)
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
  const options = { tools: true, prompt: true, routes: true, recall: true, projects: true, supervisor: true, ...config }
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

  // 首次运行生成配置文件：引擎与设置页因此永远看到同一份、路径已展开的文件。
  // 失败不致命（settings 页会显示 configError），但不能拖住插件加载。
  void seedConfig()
    .then(({ created, path }) => {
      if (created) log(`已生成默认配置：${path}`)
    })
    .catch((error) => log(`生成默认配置失败：${error instanceof Error ? error.message : String(error)}`))

  const supervisor = createSupervisor({ log, getVersion: () => VERSION })

  try {
    if (options.tools) {
      const tools = safeGet(ctx, 'tools') ?? ctx.tools
      if (tools && typeof tools.register === 'function') {
        try {
          registerVectorMemoryTools(tools, log)
        } catch (error) {
          log(`工具注册失败：${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        log('tools 服务不可用，三个 vmemory_* 工具未注册')
      }
    }

    if (options.prompt) installPromptSection(ctx, log)

    const projectsRuntime = options.projects ? installProjects(ctx, log) : null
    const recallRuntime = options.recall ? installAutoRecall(ctx, log, projectsRuntime) : null

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
