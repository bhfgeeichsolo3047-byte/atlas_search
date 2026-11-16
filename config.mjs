// config.mjs —— 共享配置层：向量供应商 / 思考强度 / 禁用清单 / 回退模式
// 设计要点：
// 1) 单一事实源是 config.json（默认落在 ATLAS_DIR 下），process.env 只做兜底。
//    换供应商、换模型、改思考强度都不需要改代码，也不需要重启 DSH。
// 2) 按 mtime 热加载：DSH 从 GUI 启动时进程 env 是启动那一刻的快照，
//    配置文件改完立刻生效，比改环境变量可靠得多。
// 3) apiKey 永不入库：config.json 已进 .gitignore，仓库里只留 config.example.json。
import path from 'node:path';
import os from 'node:os';
import { existsSync, readFileSync, writeFileSync, renameSync, statSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
export const ATLAS_DIR =
  process.env.ATLAS_DIR ||
  (existsSync(path.join(ROOT, 'catalog.json')) ? ROOT : path.join(os.homedir(), '.dsh', 'tool-atlas'));
export const CONFIG_PATH = process.env.ATLAS_CONFIG || path.join(ATLAS_DIR, 'config.json');

export const EFFORTS = ['low', 'medium', 'high', 'xhigh'];

// 四档思考强度的全部差异集中在这张表里：检索侧改什么、回吐侧给多少。
// pathTop     路径层保留几条（决定 matchedPaths 的精细度）
// sceneMax    是否启用「逐条场景软最大值」（0.75*max+0.25*mean）
// lexWeight   词元重合度的混合权重（中文二元组 + 英文词），专有名词靠它补语义盲区
// sceneDetail 每个候选回吐几条 scenes（low 只给 2 条，压体积）
// poolFactor  候选池放大倍数（xhigh 先取 topK*3 再精排）
// poolMin     候选池下限条数
// breakdown   是否回吐 scoreBreakdown（三路分量 + 加成明细）
// fallbackLimit  llm-fallback 模式下回吐多少条候选（0 = 全量）
export const EFFORT_PROFILES = {
  low: {
    pathTop: 2, sceneMax: false, lexWeight: 0, sceneDetail: 2,
    poolFactor: 1, poolMin: 0, breakdown: false, fallbackLimit: 12, fallbackFull: false,
    note: '最省：关掉逐条场景精排与词元加分，只留路径前 2 + 三路加权，候选只回前几条场景。',
  },
  medium: {
    pathTop: 4, sceneMax: true, lexWeight: 0, sceneDetail: 4,
    poolFactor: 1, poolMin: 0, breakdown: false, fallbackLimit: 20, fallbackFull: false,
    note: '标准召回：开逐条场景软最大值，路径前 4，不额外精排。',
  },
  high: {
    pathTop: 4, sceneMax: true, lexWeight: 0.06, sceneDetail: 99,
    poolFactor: 1, poolMin: 0, breakdown: true, fallbackLimit: 40, fallbackFull: false,
    note: '默认：场景软最大值 + 词元微加权 + 完整 scenes + scoreBreakdown。',
  },
  xhigh: {
    pathTop: 6, sceneMax: true, lexWeight: 0.10, sceneDetail: 99,
    poolFactor: 3, poolMin: 24, breakdown: true, fallbackLimit: 0, fallbackFull: true,
    note: '最细：候选池放大到 topK*3（下限 24）再逐条场景精排，回吐 matchedScenes 与完整 invoke/avoid/路径名。',
  },
};

export const DEFAULT_CONFIG = {
  embedding: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'Qwen/Qwen3-Embedding-4B',
  },
  reasoningEffort: 'high',
  useLlmFallback: false,
  disabled: { skills: [], tools: [] },
  hideDisabledInBrowse: false,
};

const strArr = (v) => (Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? v.split(',') : []))
  .map((x) => String(x || '').trim()).filter(Boolean);

export function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const e = r.embedding && typeof r.embedding === 'object' ? r.embedding : {};
  const d = r.disabled && typeof r.disabled === 'object' ? r.disabled : {};
  const baseUrl = String(
    e.baseUrl || process.env.EMBED_BASE_URL || process.env.ATLAS_BASE_URL || DEFAULT_CONFIG.embedding.baseUrl,
  ).replace(/\/+$/, '');
  const model = String(e.model || process.env.ATLAS_EMBED_MODEL || DEFAULT_CONFIG.embedding.model);
  const envEffort = String(process.env.ATLAS_REASONING_EFFORT || '');
  const rawEffort = String(r.reasoningEffort || envEffort || DEFAULT_CONFIG.reasoningEffort).toLowerCase();
  const effort = EFFORTS.includes(rawEffort) ? rawEffort : DEFAULT_CONFIG.reasoningEffort;
  const fallback = typeof r.useLlmFallback === 'boolean'
    ? r.useLlmFallback
    : (String(process.env.ATLAS_LLM_FALLBACK || '').toLowerCase() === '1');
  return {
    embedding: { baseUrl, model, apiKey: String(e.apiKey || '') },
    reasoningEffort: effort,
    useLlmFallback: fallback,
    disabled: { skills: strArr(d.skills), tools: strArr(d.tools) },
    hideDisabledInBrowse: typeof r.hideDisabledInBrowse === 'boolean'
      ? r.hideDisabledInBrowse
      : (String(process.env.ATLAS_HIDE_DISABLED || '').toLowerCase() === '1'),
  };
}

let cache = null;
let cacheMtime = -1;

export function configMtime() {
  try { return statSync(CONFIG_PATH).mtimeMs; } catch { return 0; }
}
export function readConfigFile() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch { return {}; }
}
// 热加载入口：mtime 没变就直接用缓存，改完文件下一个请求就生效。
export function loadConfig() {
  const m = configMtime();
  if (cache && m === cacheMtime) return cache;
  cacheMtime = m;
  cache = normalizeConfig(readConfigFile());
  return cache;
}
export function invalidateConfig() { cache = null; cacheMtime = -1; }

export async function writeConfig(patch) {
  const cur = readConfigFile();
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && cur[k] && typeof cur[k] === 'object') {
      next[k] = { ...cur[k], ...v };
    } else {
      next[k] = v;
    }
  }
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  renameSync(tmp, CONFIG_PATH);
  invalidateConfig();
  return loadConfig();
}

export function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  if (s.length <= 8) return s.slice(0, 2) + '***';
  return s.slice(0, 4) + '***' + s.slice(-4);
}

let envKeyCache = null;
// 三级回退：config.json > 环境变量 > Windows 用户作用域注册表。
// 注册表这一级是因为 DSH 从 GUI 启动时 env 是快照，之后才写进用户变量的 Key 取不到。
export function resolveApiKey(cfg) {
  const c = cfg || loadConfig();
  if (c.embedding.apiKey) return c.embedding.apiKey;
  if (envKeyCache) return envKeyCache;
  const direct = process.env.SILICONFLOW_API_KEY || process.env.ATLAS_API_KEY || '';
  if (direct) return direct;
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'SILICONFLOW_API_KEY'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
    if (m) { envKeyCache = m[1].trim(); process.env.SILICONFLOW_API_KEY = envKeyCache; return envKeyCache; }
  } catch {}
  return '';
}

export function effortProfile(cfg) {
  const c = cfg || loadConfig();
  return EFFORT_PROFILES[c.reasoningEffort] || EFFORT_PROFILES.high;
}

// ---------------- 词元重合度 ----------------
// 向量擅长「意思像」，对专有名词、文件名、命令名这类字面信号反而弱。
// 这里补一路字面重合：英文按词切，中文按二元组切（中文没有空格，二元组是零依赖的近似）。
export function tokens(s) {
  const out = new Set();
  const low = String(s || '').toLowerCase();
  if (!low) return [];
  for (const m of low.matchAll(/[a-z0-9_./+-]{2,}/g)) out.add(m[0]);
  for (const seg of low.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (seg.length === 1) out.add(seg);
    for (let i = 0; i + 1 < seg.length; i++) out.add(seg.slice(i, i + 2));
  }
  return [...out];
}
export function lexScore(query, text) {
  const q = tokens(query);
  if (!q.length) return 0;
  const t = new Set(tokens(text));
  if (!t.size) return 0;
  let hit = 0;
  for (const w of q) if (t.has(w)) hit += 1;
  return hit / q.length;
}

// ---------------- /models 拉取与 embedding 模型识别 ----------------
// 不同供应商的 /models 字段不统一（OpenAI 只有 id，SiliconFlow 有 type/sub_type，
// Ollama 有 details.family，vLLM 只有 id）。先看元数据，再退回 ID 正则。
const EMBED_ID_RE = /embed|embedding|bge-|bge_|e5-|gte-|nomic-embed|mxbai-embed|snowflake-arctic-embed|text-embedding|jina-embeddings|qwen3-embedding/i;
const RERANK_RE = /rerank/i;

export function isEmbeddingModel(m) {
  if (!m) return false;
  const id = String(m.id || m.name || m.model || '');
  const meta = [
    m.type, m.sub_type, m.pipeline_tag, m.task, m.object,
    m.details && m.details.family, m.details && m.details.families,
    ...(Array.isArray(m.capabilities) ? m.capabilities : []),
  ].filter(Boolean).join(' ').toLowerCase();
  if (RERANK_RE.test(id) || RERANK_RE.test(meta)) return false;
  if (/embed/.test(meta)) return true;
  return EMBED_ID_RE.test(id);
}

export function normalizeModels(payload) {
  const list = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload && payload.data) ? payload.data
      : (Array.isArray(payload && payload.models) ? payload.models : []));
  return list.map((m) => {
    const id = String((m && (m.id || m.name || m.model)) || '').trim();
    return {
      id,
      embedding: isEmbeddingModel(m),
      meta: [m && m.type, m && m.sub_type, m && m.pipeline_tag].filter(Boolean).join('/') || '',
    };
  }).filter((m) => m.id);
}

export function embeddingModelsFromList(list) {
  return list.filter((m) => m.embedding).map((m) => m.id);
}

// 供 MCP / CLI 共用的脱敏视图：绝不回吐明文 apiKey。
export function configView(cfg) {
  const c = cfg || loadConfig();
  return {
    configPath: CONFIG_PATH,
    embedding: {
      baseUrl: c.embedding.baseUrl,
      model: c.embedding.model,
      apiKey: maskKey(c.embedding.apiKey),
      apiKeySource: c.embedding.apiKey ? 'config.json'
        : (process.env.SILICONFLOW_API_KEY || process.env.ATLAS_API_KEY ? 'env' : 'none'),
    },
    reasoningEffort: c.reasoningEffort,
    efforts: EFFORTS,
    effortProfile: effortProfile(c),
    useLlmFallback: c.useLlmFallback,
    disabled: c.disabled,
    hideDisabledInBrowse: c.hideDisabledInBrowse,
  };
}
