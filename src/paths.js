// 路径解析：把「这台机器怎么装」和「插件怎么工作」彻底分开。
//
// 背景：以前 config.js 里写死了这台开发机的东西（引擎目录、python、数据目录、模型目录
// 各写一处）。那样一来
// 发布版和开发版必须是两份不同的代码，每次升级都要手工"消毒"一遍——迟早出错。
//
// 现在所有"位置"都在这里推导，顺序是：
//   1. 环境变量（DSH_VECTOR_MEMORY_DIR / _CONFIG / _DATA）—— 测试和特殊安装用
//   2. 插件自带的 engine/（发布版布局）
//   3. 老位置 ~/.dsh/skills/vector-memory（开发机布局，向后兼容）
//   4. 系统约定（%LOCALAPPDATA% 等）
//
// 原则：**只有"猜不到的地方"才写死，猜得到的地方一律探测。** 具体路径仍然存在 config.json
// 里（那是每台机器自己的东西），这里只负责给第一次运行一个合理默认值。
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const IS_WINDOWS = process.platform === 'win32'
/** 发布版布局：引擎随插件一起分发。 */
export const BUNDLED_ENGINE_DIR = join(PLUGIN_DIR, 'engine')
/** 开发机布局：引擎是独立安装的 skill 目录（历史路径，保留兼容）。 */
export const LEGACY_ENGINE_DIR = join(homedir(), '.dsh', 'skills', 'vector-memory')

const hasEngine = (dir) => Boolean(dir) && existsSync(join(dir, 'vsearch.py'))

/** 引擎目录：环境变量 > 插件自带 > 老 skill 目录。 */
export function engineDir() {
  const override = process.env.DSH_VECTOR_MEMORY_DIR
  if (hasEngine(override)) return resolve(override)
  if (hasEngine(BUNDLED_ENGINE_DIR)) return BUNDLED_ENGINE_DIR
  if (hasEngine(LEGACY_ENGINE_DIR)) return LEGACY_ENGINE_DIR
  return BUNDLED_ENGINE_DIR
}

export function cliPath() {
  return join(engineDir(), 'vsearch.py')
}

export function configPath() {
  const override = process.env.DSH_VECTOR_MEMORY_CONFIG
  if (override) return resolve(override)
  return join(engineDir(), 'config.json')
}

export function engineAvailable() {
  return hasEngine(engineDir())
}

/**
 * 索引/缓存目录。几 MB 到几百 MB，属于"用户数据"，放系统用户目录而不是插件目录，
 * 这样插件升级/换版本不会把索引弄丢。
 */
export function defaultDataDir() {
  const override = process.env.DSH_VECTOR_MEMORY_DATA
  if (override) return resolve(override)
  if (IS_WINDOWS) {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(local, 'dsh-vector-memory')
  }
  return join(homedir(), '.local', 'share', 'dsh-vector-memory')
}

/** 插件目录下、或引擎目录下的 venv 解释器路径。 */
export function venvPython(root) {
  return IS_WINDOWS ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python')
}

/** 候选解释器，按优先级：插件 venv > 引擎 venv > PATH 上的 python/py。 */
export function pythonCandidates() {
  const list = []
  for (const root of [PLUGIN_DIR, engineDir()]) {
    const candidate = venvPython(root)
    if (!list.includes(candidate)) list.push(candidate)
  }
  if (IS_WINDOWS) list.push('py', 'python')
  else list.push('python3', 'python')
  return list
}

/** 第一个真实存在的候选（找不到就返回空串，交给调用方回退 PATH）。 */
export function firstExistingPython() {
  for (const candidate of pythonCandidates()) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate
    } else {
      return candidate // PATH 上的名字没法用 existsSync 判断，直接交出去
    }
  }
  return ''
}
