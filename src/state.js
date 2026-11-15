import { existsSync } from 'node:fs'
import { readdir, readFile, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { readConfig } from './config.js'
import { engineStatus, health, stats } from './engine.js'
import { recentEvents } from './events.js'
import { activeJob, lastJob, publicJob } from './jobs.js'

/**
 * Everything the settings page renders in one payload: plugin identity, service
 * liveness, index statistics, model/disk usage and recent jobs. Cheap on purpose
 * (no spawning, no walking 1 GB of model weights — model sizes come from the
 * single safetensors file).
 */

async function safeReadJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function sizeOf(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}

async function dirSize(root, { maxDepth = 4 } = {}) {
  let total = 0
  const walk = async (current, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (entry.isFile()) total += await sizeOf(full)
    }
  }
  await walk(root, 0)
  return total
}

async function countMarkdown(root, { maxDepth = 4 } = {}) {
  let count = 0
  let bytes = 0
  const walk = async (current, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        count += 1
        bytes += await sizeOf(full)
      }
    }
  }
  await walk(root, 0)
  return { count, bytes }
}

async function freeSpace(path) {
  try {
    const info = await statfs(path)
    return { total: info.blocks * info.bsize, free: info.bavail * info.bsize }
  } catch {
    return null
  }
}

function iso(value) {
  if (!value) return null
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export async function buildState({ version = '0.0.0', meta = null, supervisor = null, recall = null, cwd = '', projects: projectAgents = [] } = {}) {
  const { config, error: configError, path: cfgPath } = await readConfig()
  const engine = engineStatus()
  const dataDir = config.data_dir
  const indexDir = join(dataDir, 'index')
  const [indexStats, manifest, serviceHealth, serviceStats, indexBytes, dataBytes, free, sourcesInfo] =
    await Promise.all([
      safeReadJson(join(indexDir, 'stats.json')),
      safeReadJson(join(indexDir, 'manifest.json')),
      health(config),
      stats(config),
      dirSize(indexDir, { maxDepth: 2 }),
      dirSize(dataDir, { maxDepth: 2 }),
      freeSpace(dataDir),
      Promise.all(
        (Array.isArray(config.sources) ? config.sources : []).map(async (source) => {
          const exists = existsSync(source.root)
          const counted = exists ? await countMarkdown(source.root, { maxDepth: 5 }) : { count: 0, bytes: 0 }
          return { name: source.name, root: source.root, exists, files: counted.count, bytes: counted.bytes }
        }),
      ),
    ])

  // 跨盘项目源：数量/块数直接取索引统计，不再遍历目录（大仓库每 5 秒扫一遍太贵）。
  const bySrc = indexStats?.by_src || {}
  const projects = (Array.isArray(config.project_sources) ? config.project_sources : []).map((source) => ({
    name: source.name,
    label: source.label,
    root: source.root,
    exists: existsSync(source.root),
    enabled: source.enabled !== false,
    extensions: source.extensions || [],
    files: bySrc[source.name]?.files ?? 0,
    chunks: bySrc[source.name]?.chunks ?? 0,
    addedAt: source.added_at || null,
  }))
  const sourcesAll = [
    ...sourcesInfo,
    ...projects.map((item) => ({
      name: item.name,
      root: item.root,
      exists: item.exists,
      files: item.files,
      bytes: null,
      project: true,
      chunks: item.chunks,
    })),
  ]

  const embedModel = config.models?.embed
  const rerankModel = config.models?.rerank
  const [embedBytes, rerankBytes] = await Promise.all([
    sizeOf(join(embedModel || '', 'model.safetensors')),
    sizeOf(join(rerankModel || '', 'model.safetensors')),
  ])

  const trackedFiles = manifest?.files ? Object.keys(manifest.files).length : 0
  const running = Boolean(serviceHealth?.embed)
  const job = activeJob()
  const jobView = job
    ? publicJob(job)
    : (() => {
        const last = lastJob('index')
        return last ? publicJob(last) : null
      })()

  return {
    ok: true,
    now: new Date().toISOString(),
    plugin: {
      name: 'dsh-vector-memory',
      version,
      releaseDate: meta?.releaseDate || '',
      dshRange: meta?.dshRange || '',
      verifiedOn: meta?.verifiedOn || '',
      engine,
      configPath: cfgPath,
      configError,
      dataDir,
      indexDir,
      modelsDir: join(dataDir, 'models'),
      cwd,
    },
    config,
    capability: {
      python: typeof config.python === 'string' && existsSync(config.python),
      engine: engine.cliExists,
      config: !configError,
      embedModel: Boolean(embedModel) && existsSync(embedModel),
      rerankModel: Boolean(rerankModel) && existsSync(rerankModel),
    },
    service: {
      running,
      embed: Boolean(serviceHealth?.embed),
      rerank: Boolean(serviceHealth?.rerank),
      watchPid: serviceHealth?.watch_pid ?? null,
      host: config.service?.host,
      port: config.service?.port,
      url: `http://${config.service?.host || '127.0.0.1'}:${config.service?.port || 8479}`,
      rssMb: serviceStats?.rss_mb ?? serviceHealth?.rss_mb ?? null,
      calls: serviceStats?.calls ?? null,
      lastMs: serviceStats?.last_ms ?? null,
      startedAt: iso(serviceStats?.started_at ?? serviceHealth?.started_at),
      health: serviceHealth || null,
    },
    index: {
      built: Boolean(indexStats),
      files: indexStats?.files ?? trackedFiles,
      filesChanged: indexStats?.files_changed ?? null,
      chunks: indexStats?.chunks ?? null,
      dim: indexStats?.dim ?? config.embed?.dim ?? null,
      builtAt: iso(indexStats?.built_at),
      seconds: indexStats?.seconds ?? null,
      newChunks: indexStats?.new ?? null,
      reused: indexStats?.reused ?? null,
      bytes: indexBytes,
      sources: sourcesAll,
      bySrc: Object.keys(bySrc).length ? bySrc : null,
    },
    projects: {
      list: projects,
      settings: config.project_index || {},
      agents: Array.isArray(projectAgents) ? projectAgents : [],
    },
    models: {
      embed: { path: embedModel, bytes: embedBytes, exists: Boolean(embedModel) && existsSync(embedModel) },
      rerank: { path: rerankModel, bytes: rerankBytes, exists: Boolean(rerankModel) && existsSync(rerankModel) },
    },
    disk: {
      dataDir,
      dataBytes,
      free,
    },
    job: jobView,
    jobs: { active: Boolean(job) },
    supervisor: supervisor ? supervisor.status() : null,
    recall: recall && typeof recall.snapshot === 'function' ? recall.snapshot() : null,
    events: recentEvents(12),
  }
}
