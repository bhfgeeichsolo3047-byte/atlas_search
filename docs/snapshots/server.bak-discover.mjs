#!/usr/bin/env node
// dsh-tool-atlas —— 本地工具库向量目录 MCP 服务（stdio，零依赖）
// 三层目录: 总目录(分类) -> 子分类 -> 工具详述；一个工具可挂多个 (分类,子分类) 路径
// 向量: siliconflow Qwen/Qwen3-Embedding-4B (OpenAI 兼容 /embeddings)
// 授权: 复用 SILICONFLOW_API_KEY（与 embed-router 同源）
import { createInterface } from 'node:readline';
import { promises as fsp } from 'node:fs';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const VERSION = '1.0.0';
const NAME = 'dsh-tool-atlas';
const MODEL = process.env.ATLAS_EMBED_MODEL || 'Qwen/Qwen3-Embedding-4B';
const BASE = (process.env.EMBED_BASE_URL || process.env.ATLAS_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
const ATLAS_DIR = process.env.ATLAS_DIR || path.join(os.homedir(), '.dsh', 'tool-atlas');
const CATALOG = path.join(ATLAS_DIR, 'catalog.json');
const VECTORS = path.join(ATLAS_DIR, 'vectors.json');
const BATCH = 16;

try { mkdirSync(ATLAS_DIR, { recursive: true }); } catch {}

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 24);
function fail(msg) { throw new Error(msg); }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// ---------------- embedding ----------------
const memCache = new Map();
// 环境变量兜底：DSH 从 GUI 启动时进程 env 是启动那一刻的快照，
// 如果 API Key 是之后才写进 User 作用域的，这里就取不到 —— 直接从注册表 HKCU\Environment 捞一次。
function resolveKey() {
  const direct = process.env.SILICONFLOW_API_KEY || process.env.ATLAS_API_KEY;
  if (direct) return direct;
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'SILICONFLOW_API_KEY'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
    if (m) { const v = m[1].trim(); process.env.SILICONFLOW_API_KEY = v; return v; }
  } catch {}
  return '';
}
async function embedBatch(texts) {
  const key = resolveKey();
  if (!key) fail('SILICONFLOW_API_KEY 未设置。请先在系统环境变量里配置 siliconflow API Key 后重启 DSH。');
  const res = await fetch(`${BASE}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    fail(`embedding API ${res.status}: ${body.slice(0, 300)}`);
  }
  const j = await res.json();
  if (!Array.isArray(j?.data) || j.data.length !== texts.length) fail('embedding API 响应异常: data 数量不匹配');
  return j.data.map((d) => Float32Array.from(d.embedding));
}
async function embed(texts) {
  const out = new Array(texts.length);
  const todo = [];
  for (let i = 0; i < texts.length; i++) {
    const k = sha(`${MODEL} ${texts[i]}`);
    const hit = memCache.get(k);
    if (hit) out[i] = hit; else todo.push(i);
  }
  for (let i = 0; i < todo.length; i += BATCH) {
    const idxs = todo.slice(i, i + BATCH);
    const vecs = await embedBatch(idxs.map((ix) => texts[ix]));
    idxs.forEach((ix, j) => { memCache.set(sha(`${MODEL} ${texts[ix]}`), vecs[j]); out[ix] = vecs[j]; });
  }
  return out;
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ---------------- 向量磁盘缓存（增量） ----------------
let vecDisk = null;
function loadVecDisk() {
  if (vecDisk) return vecDisk;
  try { vecDisk = JSON.parse(readFileSync(VECTORS, 'utf8')) || {}; } catch { vecDisk = {}; }
  return vecDisk;
}
let vecDirty = false;
async function saveVecDisk() {
  if (!vecDirty) return;
  const tmp = VECTORS + '.tmp';
  try { await fsp.writeFile(tmp, JSON.stringify(vecDisk)); await fsp.rename(tmp, VECTORS); vecDirty = false; } catch {}
}
function vecFor(text) {
  const k = sha(`${MODEL} ${text}`);
  const d = loadVecDisk();
  if (d[k]) return Float32Array.from(d[k]);
  const m = memCache.get(k);
  return m || null;
}
async function vecForFill(text) {
  const k = sha(`${MODEL} ${text}`);
  const d = loadVecDisk();
  if (d[k]) return Float32Array.from(d[k]);
  const [v] = await embed([text]);
  d[k] = Array.from(v, (x) => +x.toFixed(4));
  vecDirty = true;
  return v;
}
// 批量版：把所有未命中的文本去重后一次性交给 embed()（内部按 BATCH=16 分片），
// 比逐条 vecForFill 少几十次 HTTP 往返。返回值与入参顺序一一对应。
async function vecForMany(texts) {
  const keys = texts.map((t) => sha(`${MODEL} ${String(t || '')}`));
  const d = loadVecDisk();
  const miss = [];
  const seen = new Set();
  for (let i = 0; i < texts.length; i++) {
    const k = keys[i];
    if (d[k] || seen.has(k)) continue;
    seen.add(k);
    miss.push({ k, text: String(texts[i]) });
  }
  if (miss.length) {
    const vecs = await embed(miss.map((m) => m.text));
    miss.forEach((m, i) => { d[m.k] = Array.from(vecs[i], (x) => +x.toFixed(4)); });
    vecDirty = true;
  }
  return keys.map((k) => (d[k] ? Float32Array.from(d[k]) : (memCache.get(k) || null)));
}
// 预热一条工具的全部向量：三路 + 逐条场景，一次批量落盘。
async function warmTool(ref, t) {
  const f = toolFields(ref, t);
  const vecs = await vecForMany([f.name, f.traits, f.scenes, ...f.sceneList]);
  await saveVecDisk();
  return vecs[0] || null;
}

// ---------------- 目录模型 ----------------
const EMPTY = { version: 1, updatedAt: '', categories: [], tools: {} };
let catalog = null;

function loadCatalog() {
  if (catalog) return catalog;
  try { catalog = JSON.parse(readFileSync(CATALOG, 'utf8')); } catch { catalog = JSON.parse(JSON.stringify(EMPTY)); }
  catalog.categories ||= [];
  catalog.tools ||= {};
  return catalog;
}
async function saveCatalog() {
  const c = loadCatalog();
  c.version = 1;
  c.updatedAt = new Date().toISOString();
  const tmp = CATALOG + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(c, null, 2));
  await fsp.rename(tmp, CATALOG);
  catalog = null;
  return c;
}

function findCat(id) { return loadCatalog().categories.find((c) => c.id === id); }
function ensureCat(id, name, desc) {
  const c = loadCatalog();
  let cat = c.categories.find((x) => x.id === id);
  if (!cat) { cat = { id, name: name || id, desc: desc || '', subs: [] }; c.categories.push(cat); }
  else { if (name) cat.name = name; if (desc) cat.desc = desc; }
  cat.subs ||= [];
  return cat;
}
function ensureSub(cat, subId, name, desc) {
  let sub = cat.subs.find((s) => s.id === subId);
  if (!sub) { sub = { id: subId, name: name || subId, desc: desc || '', tools: [] }; cat.subs.push(sub); }
  else { if (name) sub.name = name; if (desc) sub.desc = desc; }
  sub.tools ||= [];
  return sub;
}
// 一条工具拆成 4 条互补向量：名称/特点/场景/避让。
// 特点与场景是正向语义，分开成两条避免长文本互相稀释；避让(avoid)是反向语义，单独一路用来扣分。
function toolFields(ref, t) {
  const nameText = [t.name, t.display || '', t.kind || ''].filter(Boolean).join(' ');
  const traitText = [t.traits || ''].filter(Boolean).join(' ');
  const sceneText = Array.isArray(t.scenes) ? t.scenes.join('；') : (t.scenes || '');
  const avoidText = [t.avoid || ''].filter(Boolean).join(' ');
  return {
    name: nameText || ref,
    traits: traitText || nameText || ref,
    scenes: sceneText || traitText || nameText || ref,
    // 逐条场景单独成向量：场景一多，合并成一段会把每条信号稀释掉。
    sceneList: (Array.isArray(t.scenes) ? t.scenes : (t.scenes ? [t.scenes] : []))
      .map((s) => String(s || '').trim()).filter(Boolean),
    avoid: avoidText || '',
  };
}
function toolText(ref, t) {
  const f = toolFields(ref, t);
  return [f.name, f.traits, f.scenes].filter(Boolean).join(' | ');
}
function pathText(cat, sub) {
  return [cat.name, cat.desc || '', sub ? sub.name : '', sub ? (sub.desc || '') : ''].filter(Boolean).join(' | ');
}
function summary(t) {
  return {
    ref: t.ref, name: t.name, display: t.display || '', kind: t.kind || '',
    traits: t.traits || '',
    scenes: Array.isArray(t.scenes) ? t.scenes : (t.scenes ? [t.scenes] : []),
    // avoid 是审核环节的排他边界：主模型要靠它判断「这个候选该不该用」。
    // 不给 avoid，就必须再调一次 atlas_detail 才能做决定，召回等于白给。
    avoid: t.avoid || '',
    invoke: t.invoke || '',
    paths: (t.categories || []).map(([a, b]) => `${a}/${b}`),
    ...(t.floor > 0 ? { floor: t.floor } : {}),
    ...(t.cap > 0 ? { cap: t.cap } : {}),
  };
}
// 主模型审核清单：向量召回只负责"像"，用不用由主模型对着这张单子逐条判。
const AUDIT_PROTOCOL = {
  role: 'recall-only',
  note: '本检索只做语义召回，不代表推荐。以下四步全部通过才调用该工具。',
  checklist: [
    { step: 1, field: 'scenes', ask: '候选的某条场景是否与你当前要做的子目标一致？只是字面相似不够。' },
    { step: 2, field: 'avoid', ask: '是否命中 avoid 描述的禁用条件？命中即弃用，换下一个候选。' },
    { step: 3, field: 'kind / invoke', ask: '当前会话环境里这个工具真的可用吗（MCP 是否已连接、权限是否够、平台是否匹配）？' },
    { step: 4, field: 'paths', ask: '它所在的分类路径与你的意图是否同向？路径只是弱信号，与前三步冲突时以 scenes/avoid 为准。' },
  ],
  fallback: '全部候选都不合格时，改写 query 重检，或直接按已有知识动手——不要为了用工具而用工具。',
};

// ---------------- 检索 ----------------
async function searchTools(query, { topK = 8, category = null, sub = null, minScore = 0 } = {}) {
  const c = loadCatalog();
  const refs = Object.keys(c.tools).filter((ref) => {
    const t = c.tools[ref];
    if (!category) return true;
    return (t.categories || []).some(([a, b]) => a === category && (!sub || b === sub));
  });
  if (!refs.length) return { model: MODEL, top: [], note: '目录为空或该分类下没有工具' };

  // 1) 路径层：先按 总分类/子分类 语义定位
  const pathEntries = [];
  for (const cat of c.categories) {
    for (const sb of cat.subs || []) pathEntries.push({ cat, sub: sb, text: pathText(cat, sb) });
  }
  const qv = (await embed([query]))[0];
  const pathScored = [];
  for (const p of pathEntries) {
    const v = await vecForFill(p.text);
    pathScored.push({ cat: p.cat.id, sub: p.sub.id, score: +cosine(qv, v).toFixed(4) });
  }
  pathScored.sort((a, b) => b.score - a.score);
  const pathTop = pathScored.slice(0, 4);
  const pathBoost = new Map();
  pathTop.forEach((p, i) => pathBoost.set(`${p.cat}/${p.sub}`, Math.max(0, 0.05 - i * 0.012)));

  // 2) 工具层：名称/特点/场景三路向量 + 路径加成
  // 打分模式两种：
  //   weighted（默认）= 三路加权和。稳健，但通用工具的强场景分会被弱名称分拉低。
  //   max = 取三路最高分（哪个维度最贴用户意图就用哪个）。通用工具更容易冒头，冷门工具也可能偶然冒头。
  const scored = [];
  const W_S = num(process.env.ATLAS_W_SCENE, 0.55);
  const W_T = num(process.env.ATLAS_W_TRAIT, 0.24);
  const W_N = num(process.env.ATLAS_W_NAME, 0.21);
  const MODE = process.env.ATLAS_SCORE_MODE || 'weighted';
  const sceneMax = process.env.ATLAS_SCENE_MAX !== '0';
  for (const ref of refs) {
    const t = c.tools[ref];
    const f = toolFields(ref, t);
    const [vn, vt, vs] = await Promise.all([vecForFill(f.name), vecForFill(f.traits), vecForFill(f.scenes)]);
    const sn = cosine(qv, vn), st = cosine(qv, vt), ss = cosine(qv, vs);
    // 逐条场景向量取「软最大值」：max 取单条最强命中，再与均值混合。
    // 纯 max 会让无关工具靠某一条偶然相似的场景词冒头（噪声），纯均值又会把强命中稀释掉，
    // 所以用 0.75*max + 0.25*mean：强命中的场景仍主导，但单条孤证要打折。
    let sbest = ss;
    if (sceneMax && f.sceneList.length > 1) {
      const list = await vecForMany(f.sceneList);
      let mx = -1, sum = 0, n = 0;
      for (const v of list) { if (!v) continue; const c2 = cosine(qv, v); sum += c2; n++; if (c2 > mx) mx = c2; }
      if (n) { const mean = sum / n; sbest = mx * 0.75 + mean * 0.25; }
      if (ss > sbest) sbest = ss;
    }
    let s;
    if (MODE === 'max') {
      // max 模式下，名称维度命中专有名词权重略高，避免纯场景泛化
      s = Math.max(sbest, st, sn * 1.02);
    } else {
      s = sbest * W_S + st * W_T + sn * W_N;
    }
    for (const [a, b] of t.categories || []) s += pathBoost.get(`${a}/${b}`) || 0;
    // 通用兜底工具（t.floor > 0）：给它一个分数下限，保证它总能进入候选名单，
    // 但不超过强语义命中，避免抢掉精准工具的位置。主模型看到候选后再决定用不用。
    if (t.floor > 0 && s < t.floor) s = t.floor;
    // 语义泛化型工具（t.cap > 0）：给它一个分数上限，防止「检索/记忆」这类宽口径工具
    // 对任何查询都高度相似，把真正的精准工具挤下去。
    if (t.cap > 0 && s > t.cap) s = t.cap;
    if (s < minScore) continue;
    scored.push({ ...summary(t), score: +s.toFixed(4), detail: { name: +sn.toFixed(4), traits: +st.toFixed(4), scenes: +ss.toFixed(4) } });
  }
  scored.sort((a, b) => b.score - a.score);
  return {
    model: MODEL,
    matchedPaths: pathTop.map((p) => {
      const cat = c.categories.find((x) => x.id === p.cat);
      const sb = cat?.subs?.find((s) => s.id === p.sub);
      return { path: `${p.cat}/${p.sub}`, label: [cat?.name, sb?.name].filter(Boolean).join(' > '), score: p.score };
    }),
    top: scored.slice(0, Math.min(Math.max(topK, 1), 30)),
    hint: '以上为向量召回候选，是否使用由主模型审核决定；score 为余弦相似度+路径加成，仅供参考不构成结论。',
    auditProtocol: AUDIT_PROTOCOL,
  };
}

// ---------------- MCP 工具定义 ----------------
const TOOLS = [
  {
    name: 'atlas_search',
    description: '工具库语义检索（三层目录）：先用向量把查询匹配到「总分类 > 子分类」，再在路径下按工具的「特点+应用场景」摘要向量打分，返回候选工具列表交主模型审核。适合「我该用什么工具干这件事」这类问题。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要做的事的自然语言描述，不要写工具名' },
        topK: { type: 'number', description: '返回候选数，默认 8，上限 30' },
        category: { type: 'string', description: '限定总分类 id（可选）' },
        sub: { type: 'string', description: '限定子分类 id（可选，需同时给 category）' },
        minScore: { type: 'number', description: '最低分阈值，默认 0' },
      },
      required: ['query'],
    },
  },
  {
    name: 'atlas_browse',
    description: '浏览三层目录结构，不做向量检索。不传参数=列出所有总分类；传 category=列出该分类下子分类与工具名；传 category+sub=列出该子分类下工具摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: '总分类 id' },
        sub: { type: 'string', description: '子分类 id' },
      },
    },
  },
  {
    name: 'atlas_detail',
    description: '取一个工具的完整详述条目（特点、应用场景、何时不要用、调用方式、所属全部路径）。',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: '工具的 ref，如 tool/shell 或 mcp/treg' } },
      required: ['ref'],
    },
  },
  {
    name: 'atlas_upsert',
    description: '录入或更新一个工具条目（像写记忆一样总结它）。同一工具可挂多个 (category, sub) 路径，实现多用途归类。分类/子分类不存在会自动创建。写完后自动预热该条目的向量。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '稳定标识，建议 tool/<name> 或 mcp/<name>' },
        name: { type: 'string', description: '工具真实名字，如 shell' },
        display: { type: 'string', description: '中文显示名，如 终端执行' },
        kind: { type: 'string', description: 'tool / mcp / agy-native / skill / cli' },
        traits: { type: 'string', description: '特点：这个工具是什么、怎么干活、有什么限制。写给向量模型看，越具体越好' },
        scenes: { type: 'array', items: { type: 'string' }, description: '应用场景列表：什么时候该用它' },
        avoid: { type: 'string', description: '什么时候不要用它，该换谁' },
        invoke: { type: 'string', description: '调用方式示意，如 shell({command, description})' },
        floor: { type: 'number', description: '（可选）分数下限 0~0.6：通用兜底工具建议给 0.42，保证它总能进候选名单，但不会挤掉精准工具' },
        cap: { type: 'number', description: '（可选）分数上限 0~0.6：宽口径工具（检索/记忆/搜索类）建议给 0.50，防止它对任何查询都高分而压掉精准工具' },
        paths: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: '要挂的路径数组，每项是 [categoryId, subId]；可给多个实现多分类',
        },
        categories: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, name: { type: 'string' }, desc: { type: 'string' } },
            required: ['id'],
          },
          description: '（可选）同时声明/更新总分类，name/desc 用于路径层向量',
        },
        subs: {
          type: 'array',
          items: {
            type: 'object',
            properties: { categoryId: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, desc: { type: 'string' } },
            required: ['categoryId', 'id'],
          },
          description: '（可选）同时声明/更新子分类',
        },
      },
      required: ['ref', 'name', 'traits', 'paths'],
    },
  },
  {
    name: 'atlas_link',
    description: '把一个已存在的工具追加挂到另一个 (总分类,子分类) 路径，实现一工具多用途归类，不重复录入。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        category: { type: 'string', description: '总分类 id' },
        sub: { type: 'string', description: '子分类 id' },
      },
      required: ['ref', 'category', 'sub'],
    },
  },
  {
    name: 'atlas_stats',
    description: '看目录规模：分类数、子分类数、工具条目数、每个分类下工具数、向量缓存条目数。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'atlas_reindex',
    description: '重算全部条目的向量（目录大改后跑一次；平时按需增量预热，不需要手动调用）。force=true 会清空磁盘向量缓存。',
    inputSchema: {
      type: 'object',
      properties: { force: { type: 'boolean', description: '清空缓存后全量重算' } },
    },
  },
];

// ---------------- 工具实现 ----------------
async function callTool(name, args) {
  args = args || {};
  const c = loadCatalog();

  if (name === 'atlas_search') {
    if (!args.query) fail('query 不能为空');
    const r = await searchTools(args.query, args);
    await saveVecDisk();
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
  }

  if (name === 'atlas_browse') {
    if (!args.category) {
      const out = c.categories.map((cat) => ({
        id: cat.id, name: cat.name, desc: cat.desc,
        subs: (cat.subs || []).length,
        tools: new Set((cat.subs || []).flatMap((s) => s.tools || [])).size,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ layer: 1, categories: out, totalTools: Object.keys(c.tools).length }, null, 2) }] };
    }
    const cat = findCat(args.category);
    if (!cat) fail(`没有这个总分类: ${args.category}`);
    if (!args.sub) {
      const out = (cat.subs || []).map((s) => ({ id: s.id, name: s.name, desc: s.desc, tools: (s.tools || []).map((ref) => ({ ref, name: c.tools[ref]?.name || ref })) }));
      return { content: [{ type: 'text', text: JSON.stringify({ layer: 2, category: { id: cat.id, name: cat.name, desc: cat.desc }, subs: out }, null, 2) }] };
    }
    const sb = (cat.subs || []).find((s) => s.id === args.sub);
    if (!sb) fail(`该总分类下没有子分类: ${args.sub}`);
    const out = (sb.tools || []).map((ref) => summary(c.tools[ref] || { ref, name: ref }));
    return { content: [{ type: 'text', text: JSON.stringify({ layer: 3, path: `${cat.id}/${sb.id}`, label: `${cat.name} > ${sb.name}`, tools: out }, null, 2) }] };
  }

  if (name === 'atlas_detail') {
    const t = c.tools[args.ref];
    if (!t) fail(`没有这个工具条目: ${args.ref}`);
    return { content: [{ type: 'text', text: JSON.stringify({ ...t, pathLabels: (t.categories || []).map(([a, b]) => {
      const cat = c.categories.find((x) => x.id === a);
      const sb = cat?.subs?.find((s) => s.id === b);
      return [cat?.name, sb?.name].filter(Boolean).join(' > ');
    }) }, null, 2) }] };
  }

  if (name === 'atlas_upsert') {
    if (!args.ref || !args.name || !args.traits) fail('ref / name / traits 是必填的');
    const cats = Array.isArray(args.categories) ? args.categories : [];
    for (const cc of cats) ensureCat(cc.id, cc.name, cc.desc);
    const subs = Array.isArray(args.subs) ? args.subs : [];
    for (const ss of subs) ensureSub(ensureCat(ss.categoryId), ss.id, ss.name, ss.desc);
    const paths = Array.isArray(args.paths) && args.paths.length ? args.paths : [['misc', 'uncategorized']];
    for (const p of paths) {
      const cat = ensureCat(p[0]);
      ensureSub(cat, p[1] || 'uncategorized');
    }
    const prev = c.tools[args.ref] || {};
    const entry = {
      ref: args.ref,
      name: args.name,
      display: args.display ?? prev.display ?? '',
      kind: args.kind ?? prev.kind ?? 'tool',
      traits: args.traits,
      scenes: Array.isArray(args.scenes) ? args.scenes : (prev.scenes || []),
      avoid: args.avoid ?? prev.avoid ?? '',
      invoke: args.invoke ?? prev.invoke ?? '',
      floor: typeof args.floor === 'number' ? args.floor : (prev.floor ?? 0),
      cap: typeof args.cap === 'number' ? args.cap : (prev.cap ?? 0),
      categories: paths.map((p) => [p[0], p[1] || 'uncategorized']),
      updatedAt: new Date().toISOString(),
    };
    c.tools[args.ref] = entry;
    // 双向维护 sub.tools
    for (const cat of c.categories) for (const sb of cat.subs || []) {
      sb.tools = (sb.tools || []).filter((r) => r !== args.ref);
    }
    for (const [a, b] of entry.categories) {
      const cat = ensureCat(a); const sb = ensureSub(cat, b);
      if (!sb.tools.includes(args.ref)) sb.tools.push(args.ref);
    }
    await saveCatalog();
    loadCatalog();
    const vn = await warmTool(args.ref, entry);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ref: args.ref, paths: entry.categories, dim: vn ? vn.length : 0, label: entry.name }, null, 2) }] };
  }

  if (name === 'atlas_link') {
    const t = c.tools[args.ref];
    if (!t) fail(`没有这个工具条目: ${args.ref}`);
    const cat = ensureCat(args.category);
    const sb = ensureSub(cat, args.sub);
    t.categories ||= [];
    if (!t.categories.some(([a, b]) => a === args.category && b === args.sub)) t.categories.push([args.category, args.sub]);
    if (!sb.tools.includes(args.ref)) sb.tools.push(args.ref);
    await saveCatalog(); loadCatalog();
    await warmTool(args.ref, t);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ref: args.ref, categories: t.categories }, null, 2) }] };
  }

  if (name === 'atlas_stats') {
    const cats = c.categories.map((cat) => ({
      id: cat.id, name: cat.name,
      subs: (cat.subs || []).length,
      tools: new Set((cat.subs || []).flatMap((s) => s.tools || [])).size,
    }));
    return { content: [{ type: 'text', text: JSON.stringify({
      dir: ATLAS_DIR, model: MODEL,
      categories: c.categories.length,
      subs: c.categories.reduce((n, cat) => n + (cat.subs || []).length, 0),
      tools: Object.keys(c.tools).length,
      vectors: Object.keys(loadVecDisk()).length,
      updatedAt: c.updatedAt, perCategory: cats,
    }, null, 2) }] };
  }

  if (name === 'atlas_reindex') {
    if (args.force) { vecDisk = {}; vecDirty = true; await saveVecDisk(); }
    const refs = Object.keys(c.tools);
    let done = 0;
    for (const ref of refs) { await warmTool(ref, c.tools[ref]); done++; }
    const paths = [];
    for (const cat of c.categories) for (const sb of cat.subs || []) paths.push(pathText(cat, sb));
    for (const p of paths) await vecForFill(p);
    await saveVecDisk();
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tools: done, paths: paths.length, vectors: Object.keys(loadVecDisk()).length }, null, 2) }] };
  }

  fail(`未知工具: ${name}`);
}

// ---------------- MCP 通道 ----------------
let pending = 0;
const rl = createInterface({ input: process.stdin });
const send = (obj) => { try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch {} };

rl.on('line', async (line) => {
  const t = line.trim();
  if (!t) return;
  let msg; try { msg = JSON.parse(t); } catch { return; }
  const { id, method, params } = msg;
  pending++;
  try {
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: NAME, version: VERSION } } });
    if ((method || '').startsWith('notifications/')) return;
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try { return send({ jsonrpc: '2.0', id, result: await callTool(params.name, params.arguments) }); }
      catch (e) { return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `ERROR: ${e.message}` }], isError: true } }); }
    }
    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法: ${method}` } });
  } catch (e) {
    return send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
  } finally { pending--; }
});

rl.on('close', () => { const check = () => { if (pending <= 0) process.exit(0); else setTimeout(check, 50); }; check(); });
process.on('uncaughtException', (e) => { try { process.stderr.write('uncaught: ' + (e?.stack || e) + '\n'); } catch {} });
