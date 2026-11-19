/**
 * 开场简报（handoff）
 *
 * 新开会话时，模型对本项目「上一轮聊到哪儿」一无所知——记忆档（memory/）只记结论，
 * 会话里的过程、没做完的事、当时的取舍都在历史会话里。这个模块从会话归档
 * （<data_dir>/transcripts/manifest.json，由归档脚本物化）里挑出「同一目录最近的
 * 几个根会话」，拼成很小的一段（默认 ≤420 字）注入系统提示。
 *
 * 设计约束：
 *  - 只读 manifest.json（约 200 KB），不解析 md、不碰原始 zstd；
 *  - 每次组装最多读一次盘（60s 缓存），失败/缺档一律静默返回空串；
 *  - 只挑根会话（depth === 0），只挑有点内容的（realUserChars >= 200 或带压缩摘要），
 *    避免「你好👋」这类空会话占额度；
 *  - 输出按预算逐条拼，超预算就停，绝不截断到半个句子以外的程度。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { defaultDataDir, readConfig } from './config.js';

const MANIFEST_NAME = 'manifest.json';
const CACHE_MS = 60_000;
const HEAD = '【上次会话 · 本项目归档】下面几条来自本机会话归档（不是当前对话的内容），按时间从近到远；需要细节可以让我去归档里 grep：';

export const HANDOFF_DEFAULTS = {
  enabled: true,
  max_sessions: 3,
  max_chars: 560,
  transcripts_dir: '',
};

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const norm = (p) => resolve(String(p || '')).toLowerCase().replace(/[\\/]+$/, '');

const inside = (child, parent) => {
  const c = norm(child);
  const p = norm(parent);
  if (!c || !p) return false;
  if (c === p) return true;
  return c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`);
};

/** 归档根目录：env > config.handoff.transcripts_dir > <data_dir>/transcripts */
export function transcriptsDir(config = null) {
  const env = String(process.env.DSH_VECTOR_MEMORY_TRANSCRIPTS || '').trim();
  if (env) return resolve(env);
  const cfg = config || {};
  const own = String(cfg?.handoff?.transcripts_dir || '').trim();
  if (own) return resolve(own);
  const dataDir = String(cfg?.data_dir || '').trim() || defaultDataDir();
  return resolve(dataDir, 'transcripts');
}

export function handoffSettings(config = null) {
  const raw = config?.handoff || {};
  const merged = { ...HANDOFF_DEFAULTS };
  if (raw && typeof raw === 'object') {
    if (raw.enabled === false) merged.enabled = false;
    else if (raw.enabled === true) merged.enabled = true;
    merged.max_sessions = clampInt(raw.max_sessions, 1, 8, merged.max_sessions);
    merged.max_chars = clampInt(raw.max_chars, 120, 2000, merged.max_chars);
    merged.transcripts_dir = String(raw.transcripts_dir || '');
  }
  return merged;
}

const pad = (n) => String(n).padStart(2, '0');

function fmtWhen(ms) {
  const date = new Date(Number(ms) || 0);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return '';
  const now = new Date();
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (date.getFullYear() !== now.getFullYear()) return `${date.getFullYear()}-${md}`;
  return `${md} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const squeeze = (text, max) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(8, max - 1))}…`;
};

/** 从一个 manifest session 条目里取「一句话摘要」 */
function summarize(entry) {
  const pieces = [];
  const ask = squeeze(entry.firstAsk, 40);
  if (ask) pieces.push(`诉求：${ask}`);
  const goal = Array.isArray(entry.openGoals) && entry.openGoals.length
    ? squeeze(entry.openGoals[0], 40)
    : '';
  if (goal) pieces.push(`未完成：${goal}`);
  else {
    const progress = squeeze(entry.lastAnswer, 44);
    if (progress) pieces.push(`停在哪：${progress}`);
  }
  if (!pieces.length) {
    const title = squeeze(entry.title, 50);
    if (title) pieces.push(`主题：${title}`);
  }
  return pieces.join('；');
}

export function createHandoff({ log = () => {}, readConfigImpl = readConfig } = {}) {
  let cache = { at: 0, dir: '', sessions: [] };
  // readConfig() 是 async 的：这里缓存一份解析好的配置，`load()` 保持同步（routes 的 preview 也要同步调用）
  let cfgCache = null;

  async function warm() {
    try {
      const raw = readConfigImpl();
      const resolved = raw && typeof raw.then === 'function' ? await raw : raw;
      cfgCache = resolved?.config || {};
    } catch (err) {
      log(`开场简报读取配置失败（用默认值）：${err?.message || err}`);
      cfgCache = cfgCache || {};
    }
    return cfgCache;
  }

  function load() {
    const config = cfgCache || {};
    const settings = handoffSettings(config);
    const dir = transcriptsDir(config);
    const now = Date.now();
    if (cache.dir === dir && now - cache.at < CACHE_MS) return { dir, settings, sessions: cache.sessions };

    let sessions = [];
    const manifestPath = join(dir, MANIFEST_NAME);
    if (settings.enabled && existsSync(manifestPath)) {
      try {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const all = raw?.sessions && typeof raw.sessions === 'object' ? Object.values(raw.sessions) : [];
        sessions = all
          .filter((item) => item && typeof item === 'object')
          .filter((item) => Number(item.depth || 0) === 0)
          .filter((item) => !item.thin || Number(item.compressBlocks || 0) > 0)
          .filter((item) => Number(item.realUserChars || 0) >= 200 || Number(item.compressBlocks || 0) > 0)
          .map((item) => ({
            sessionId: String(item.sessionId || ''),
            project: String(item.project || ''),
            createdAt: Number(item.createdAt || 0),
            // 「上次聊到哪儿」应按**最后活动时间**排：跨天大工程的 createdAt 很久远，按创建时间会被新开的小会话挤掉
            at: Number(item.mtime || 0) || Number(item.updatedAt || 0) || Number(item.createdAt || 0),
            title: String(item.title || ''),
            firstAsk: String(item.firstAsk || ''),
            lastAnswer: String(item.lastAnswer || ''),
            openGoals: Array.isArray(item.openGoals) ? item.openGoals : [],
            compressBlocks: Number(item.compressBlocks || 0),
          }))
          .filter((item) => item.title || item.firstAsk);
      } catch (err) {
        log(`开场简报读取归档清单失败（本轮跳过）：${err?.message || err}`);
        sessions = [];
      }
    }
    cache = { at: now, dir, sessions };
    return { dir, settings, sessions };
  }

  /** 某个目录最近的根会话（新的在前） */
  function recentFor(root, limit = 3, { exclude = '' } = {}) {
    const { dir, settings, sessions } = load();
    if (!settings.enabled || !root) return { dir, settings, sessions: [] };
    const skip = String(exclude || '');
    const mine = sessions
      .filter((item) => item.project && inside(item.project, root))
      .filter((item) => !skip || item.sessionId !== skip)
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, limit);
    return { dir, settings, sessions: mine };
  }

  /**
   * 生成注入文本；root 为空或没有归档时返回空串（DSH 会丢弃空块）。
   * exclude = 当前会话 id：恢复会话时别把"自己"当成上次会话。
   */
  function textFor(root, options = {}) {
    const maxSessions = clampInt(options.max_sessions, 1, 8, HANDOFF_DEFAULTS.max_sessions);
    const { dir, settings, sessions } = recentFor(root, maxSessions, { exclude: options.exclude });
    if (!settings.enabled || !sessions.length) return '';
    const budget = clampInt(options.max_chars, 120, 2000, settings.max_chars);
    const lines = [HEAD.replace('：', `（${dir}）：`)];
    let used = lines[0].length;
    for (const item of sessions) {
      const when = fmtWhen(item.at || item.createdAt);
      const title = squeeze(item.title, 34);
      const body = summarize(item);
      const label = [when, title ? `「${title}」` : ''].filter(Boolean).join(' ');
      const line = `- ${label}${body ? ` ${body}` : ''}`;
      if (used + line.length + 1 > budget) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length === 1) return '';
    return lines.join('\n');
  }

  return {
    warm,
    textFor,
    recentFor,
    /** 给设置页/会话面板看的状态：有几个旧会话可用、简报多长 */
    preview(root) {
      const { dir, settings, sessions } = recentFor(root, HANDOFF_DEFAULTS.max_sessions);
      const text = settings.enabled ? textFor(root) : '';
      return { enabled: settings.enabled, dir, sessions: sessions.length, chars: text.length };
    },
    transcriptsDir: () => load().dir,
    invalidate: () => {
      cache = { at: 0, dir: '', sessions: [] };
    },
  };
}

