#!/usr/bin/env node
// dsh-tool-atlas —— 本地工具库向量目录 MCP 服务（stdio，零依赖）
// 三层目录: 总目录(分类) -> 子分类 -> 工具详述；一个工具可挂多个 (分类,子分类) 路径
// 向量: 供应商 / 模型 / Key 全部来自 config.json（OpenAI 兼容 /embeddings），改完即时生效
// 授权: config.json > SILICONFLOW_API_KEY / ATLAS_API_KEY > Windows 用户作用域注册表
import { createInterface } from 'node:readline';
import { promises as fsp } from 'node:fs';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { discoverAll, buildProposal, loadState, saveState, loadCatalogFile } from './discover.mjs';
import {
  ATLAS_DIR, CONFIG_PATH, EFFORTS, DEFAULT_CONFIG,
  loadConfig, writeConfig, configView, effortProfile,
  resolveApiKey, lexScore, normalizeModels, embeddingModelsFromList,
} from './config.mjs';

const VERSION = '1.1.0';
const NAME = 'dsh-tool-atlas';
// 配置每次用到时读一次（mtime 未变走缓存）：换模型、换供应商、改思考强度都不需要重启进程。
const cfg = () => loadConfig();
const modelId = () => cfg().embedding.model;
const baseUrl = () => cfg().embedding.baseUrl;
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
// 如果 API Key 是之后才写进 User 作用域的，这里就取不到 —— config.mjs 会去注册表捞一次。
function resolveKey() { return resolveApiKey(cfg()); }
async function embedBatch(texts) {
  const key = resolveKey();
  if (!key) fail('还没有可用的 API Key：用 config-cli set --api-key <KEY> 写进 config.json，或设置环境变量 SILICONFLOW_API_KEY。');
  const res = await fetch(baseUrl() + '/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: modelId(), input: texts }),
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
    const k = sha(modelId() + ' ' + texts[i]);
    const hit = memCache.get(k);
    if (hit) out[i] = hit; else todo.push(i);
  }
  for (let i = 0; i < todo.length; i += BATCH) {
    const idxs = todo.slice(i, i + BATCH);
    const vecs = await embedBatch(idxs.map((ix) => texts[ix]));
    idxs.forEach((ix, j) => { memCache.set(sha(modelId() + ' ' + texts[ix]), vecs[j]); out[ix] = vecs[j]; });
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
  const k = sha(modelId() + ' ' + text);
  const d = loadVecDisk();
  if (d[k]) return Float32Array.from(d[k]);
  const m = memCache.get(k);
  return m || null;
}
async function vecForFill(text) {
  const k = sha(modelId() + ' ' + text);
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
  const keys = texts.map((t) => sha(modelId() + ' ' + String(t || '')));
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
  // 回退模式下不做向量化：用户明确要求「不调向量模型」时，录入也必须遵守。
  if (cfg().useLlmFallback) return null;
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

// ---------------- 录入 ----------------
// atlas_upsert 与 atlas_commit 共用这一段：改 ref 的路径必须幂等，
// 否则同一 ref 换分类后会同时挂在旧子分类下，留下检索残影。
function upsertEntry(args, c) {
  if (!args.ref || !args.name || !args.traits) fail('ref / name / traits 是必填的');
  const cats = Array.isArray(args.categories) ? args.categories : [];
  for (const cc of cats) if (cc && cc.id) ensureCat(cc.id, cc.name, cc.desc);
  const subs = Array.isArray(args.subs) ? args.subs : [];
  for (const ss of subs) if (ss && ss.categoryId && ss.id) ensureSub(ensureCat(ss.categoryId), ss.id, ss.name, ss.desc);
  const paths = Array.isArray(args.paths) && args.paths.length ? args.paths : [['misc', 'uncategorized']];
  for (const p of paths) ensureSub(ensureCat(p[0]), p[1] || 'uncategorized');
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
  // 双向维护 sub.tools：先把 ref 从所有子分类摘掉，再按新路径重塞
  for (const cat of c.categories) for (const sb of cat.subs || []) {
    sb.tools = (sb.tools || []).filter((r) => r !== args.ref);
  }
  for (const [a, b] of entry.categories) {
    const cat = ensureCat(a); const sb = ensureSub(cat, b);
    if (!sb.tools.includes(args.ref)) sb.tools.push(args.ref);
  }
  return entry;
}

// ---------------- 禁用清单 ----------------
// 语义是「当前会话里不该被推荐给我用」，不是「从目录里删掉」：
// atlas_search 直接剔除（不推荐禁用项），atlas_browse / atlas_detail 默认保留并标 disabled，
// 因为目录是事实，推荐才是策略。hideDisabledInBrowse=true 时才连浏览也隐藏。
function disabledRefs(c) {
  const d = cfg().disabled;
  const want = new Set([...d.skills, ...d.tools].map((x) => String(x || '').trim()).filter(Boolean));
  const hit = new Set();
  if (!want.size) return hit;
  for (const ref of Object.keys(c.tools || {})) {
    const t = c.tools[ref];
    if (want.has(ref) || (t && want.has(t.name))) hit.add(ref);
  }
  return hit;
}

// 按思考强度裁剪摘要体积：low 只回前 2 条场景，high/xhigh 回完整 scenes。
// pathLabels 只在 high 及以上给：路径名是弱信号，低档没必要占体积。
function summaryFor(t, profile, c, matchedScenes) {
  const s = summary(t);
  if (profile.sceneDetail < 99 && Array.isArray(s.scenes) && s.scenes.length > profile.sceneDetail) {
    s.scenes = s.scenes.slice(0, profile.sceneDetail);
    s.scenesTruncated = true;
  }
  if (profile.breakdown) {
    s.pathLabels = (t.categories || []).map(([a, b]) => {
      const cat = (c.categories || []).find((x) => x.id === a);
      const sb = cat && (cat.subs || []).find((x) => x.id === b);
      return [cat && cat.name, sb && sb.name].filter(Boolean).join(' > ') || (a + '/' + b);
    });
  }
  if (matchedScenes && matchedScenes.length) s.matchedScenes = matchedScenes;
  return s;
}

// ---------------- 大模型直读模式（useLlmFallback） ----------------
// 硬短路：这条路径里不出现 embed / embedBatch / vecForFill —— 即使配了 Key 也一个请求都不发。
// 只用字面重合度排序（tokens/lexScore 是纯字符串计算），按思考强度决定回吐多少原文：
//   low 前 12 条精简 / medium 前 20 条 / high 前 40 条含分类概览 / xhigh 全量 + 完整字段。
function fallbackSearch(query, { topK = 8, category = null, sub = null, minScore = 0 } = {}) {
  const c = loadCatalog();
  const profile = effortProfile(cfg());
  const dis = disabledRefs(c);
  const refs = Object.keys(c.tools).filter((ref) => {
    if (dis.has(ref)) return false;
    const t = c.tools[ref];
    if (!category) return true;
    return (t.categories || []).some(([a, b]) => a === category && (!sub || b === sub));
  });
  const ranked = refs.map((ref) => {
    const t = c.tools[ref];
    const f = toolFields(ref, t);
    return { ref, t, lex: lexScore(query, [f.name, f.traits, f.scenes].join(' ')) };
  }).sort((a, b) => b.lex - a.lex || a.ref.localeCompare(b.ref));
  const limit = profile.fallbackLimit > 0 ? profile.fallbackLimit : ranked.length;
  const want = Math.max(Math.max(topK, 1), limit);
  const picked = ranked.slice(0, Math.min(want, ranked.length));
  const slim = profile.fallbackLimit > 0 && !profile.breakdown;
  const top = picked.map(({ t, lex }) => {
    if (slim) {
      const s = summaryFor(t, profile, c);
      return {
        ref: s.ref, name: s.name, display: s.display, kind: s.kind,
        traits: s.traits, scenes: s.scenes, paths: s.paths, lexMatch: +lex.toFixed(4),
      };
    }
    return { ...summaryFor(t, profile, c), score: +lex.toFixed(4), lexMatch: +lex.toFixed(4) };
  }).filter((x) => (minScore > 0 ? x.lexMatch >= minScore : true));
  const body = {
    mode: 'llm-fallback',
    embeddingBypassed: true,
    reasoningEffort: cfg().reasoningEffort,
    model: modelId(),
    top,
    total: ranked.length,
    hint: '向量检索已被关闭（useLlmFallback=true）：这里没有余弦分数，只有按字面重合度排的候选原文。读 scenes/avoid 自己判断，不要当成排序结论。',
    instruction: '按 scenes 是否命中当前子目标、avoid 是否触发、kind/invoke 在当前会话是否可用这三步筛；都不合适就改写 query 再看一次，或直接动手。',
    auditProtocol: AUDIT_PROTOCOL,
  };
  if (profile.breakdown) {
    // high / xhigh 额外给分类概览：没有向量时，主模型靠目录结构定位比靠词面更快。
    body.categories = (c.categories || []).map((cat) => ({
      id: cat.id, name: cat.name,
      subs: (cat.subs || []).map((s) => ({
        id: s.id, name: s.name,
        tools: (s.tools || []).filter((r) => !dis.has(r)).length,
      })),
    }));
  }
  return body;
}

// ---------------- 检索 ----------------
async function searchTools(query, { topK = 8, category = null, sub = null, minScore = 0 } = {}) {
  const c = loadCatalog();
  const conf = cfg();
  const profile = effortProfile(conf);
  if (conf.useLlmFallback) return fallbackSearch(query, { topK, category, sub, minScore });
  const dis = disabledRefs(c);
  const refs = Object.keys(c.tools).filter((ref) => {
    if (dis.has(ref)) return false;
    const t = c.tools[ref];
    if (!category) return true;
    return (t.categories || []).some(([a, b]) => a === category && (!sub || b === sub));
  });
  if (!refs.length) {
    return { model: modelId(), mode: 'vector', top: [], note: '目录为空、该分类下没有工具，或候选全被禁用清单挡掉了' };
  }

  // 1) 路径层：先按 总分类/子分类 语义定位（保留几条由思考强度决定）
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
  const pathTop = pathScored.slice(0, Math.max(profile.pathTop, 1));
  const pathBoost = new Map();
  pathTop.forEach((p, i) => pathBoost.set(p.cat + '/' + p.sub, Math.max(0, 0.05 - i * 0.012)));

  // 2) 工具层：名称/特点/场景三路向量 + 路径加成
  // 打分模式两种：
  //   weighted（默认）= 三路加权和。稳健，但通用工具的强场景分会被弱名称分拉低。
  //   max = 取三路最高分（哪个维度最贴用户意图就用哪个）。通用工具更容易冒头，冷门工具也可能偶然冒头。
  const scored = [];
  const W_S = num(process.env.ATLAS_W_SCENE, 0.55);
  const W_T = num(process.env.ATLAS_W_TRAIT, 0.24);
  const W_N = num(process.env.ATLAS_W_NAME, 0.21);
  const MODE = process.env.ATLAS_SCORE_MODE || 'weighted';
  const sceneMax = profile.sceneMax;
  for (const ref of refs) {
    const t = c.tools[ref];
    const f = toolFields(ref, t);
    const [vn, vt, vs] = await Promise.all([vecForFill(f.name), vecForFill(f.traits), vecForFill(f.scenes)]);
    const sn = cosine(qv, vn), st = cosine(qv, vt), ss = cosine(qv, vs);
    // 逐条场景向量取「软最大值」：max 取单条最强命中，再与均值混合。
    // 纯 max 会让无关工具靠某一条偶然相似的场景词冒头（噪声），纯均值又会把强命中稀释掉，
    // 所以用 0.75*max + 0.25*mean：强命中的场景仍主导，但单条孤证要打折。
    let sbest = ss;
    let sceneCos = null;
    if (sceneMax && f.sceneList.length > 1) {
      const list = await vecForMany(f.sceneList);
      let mx = -1, sum = 0, n = 0;
      sceneCos = [];
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (!v) continue;
        const c2 = cosine(qv, v);
        sceneCos.push({ text: f.sceneList[i], cos: c2 });
        sum += c2; n++; if (c2 > mx) mx = c2;
      }
      if (n) { const mean = sum / n; sbest = mx * 0.75 + mean * 0.25; }
      if (ss > sbest) sbest = ss;
      if (sceneCos) sceneCos.sort((a, b) => b.cos - a.cos);
    }
    // 词元重合度：向量对专有名词/命令名不敏感，这里按字面重合补一路（权重由思考强度给，high 只给 0.06）。
    const lex = profile.lexWeight > 0 ? lexScore(query, [f.name, f.traits, f.scenes].join(' ')) : 0;
    const base = MODE === 'max'
      ? Math.max(sbest, st, sn * 1.02) + lex * profile.lexWeight
      : sbest * W_S + st * W_T + sn * W_N + lex * profile.lexWeight;
    let boost = 0;
    for (const [a, b] of t.categories || []) boost += pathBoost.get(a + '/' + b) || 0;
    // 通用兜底工具（t.floor > 0）：给它一个分数下限，保证它总能进入候选名单，
    // 但不超过强语义命中，避免抢掉精准工具的位置。主模型看到候选后再决定用不用。
    // 语义泛化型工具（t.cap > 0）：给它一个分数上限，防止「检索/记忆」这类宽口径工具
    // 对任何查询都高度相似，把真正的精准工具挤下去。
    const clamp = (v) => {
      let x = v;
      if (t.floor > 0 && x < t.floor) x = t.floor;
      if (t.cap > 0 && x > t.cap) x = t.cap;
      return x;
    };
    const s = clamp(base + boost);
    if (s < minScore) continue;
    scored.push({ t, ref, base, boost, sbest, sn, st, ss, lex, sceneCos, s, clamp });
  }
  scored.sort((a, b) => b.s - a.s);

  // 3) 候选池：xhigh 先放大池子，再用「场景 top3 均值」做一轮精排。
  // 逐条场景比合并成一段更抗稀释，top3 均值能把「三条都相关」和「一条偶然很像」区分开。
  const poolSize = profile.poolFactor > 1
    ? Math.max(Math.max(topK, 1) * profile.poolFactor, profile.poolMin)
    : scored.length;
  const pool = scored.slice(0, Math.min(poolSize, scored.length));
  if (profile.poolFactor > 1) {
    for (const it of pool) {
      if (!it.sceneCos || !it.sceneCos.length) continue;
      const top3 = it.sceneCos.slice(0, 3);
      const mean3 = top3.reduce((n, x) => n + x.cos, 0) / top3.length;
      const refined = it.sbest * 0.6 + mean3 * 0.4;
      it.sceneTop3 = mean3;
      it.s = it.clamp(it.base - it.sbest * W_S + refined * W_S + it.boost);
    }
    pool.sort((a, b) => b.s - a.s);
  }

  const top = pool.slice(0, Math.min(Math.max(topK, 1), 30)).map((it) => {
    const out = summaryFor(
      it.t, profile, c,
      profile.breakdown && it.sceneCos ? it.sceneCos.slice(0, 3).map((x) => x.text) : null,
    );
    out.score = +it.s.toFixed(4);
    out.detail = { name: +it.sn.toFixed(4), traits: +it.st.toFixed(4), scenes: +it.ss.toFixed(4) };
    if (profile.breakdown) {
      out.detail.lexMatch = +it.lex.toFixed(4);
      if (it.sceneTop3 != null) out.detail.sceneTop3 = +it.sceneTop3.toFixed(4);
    }
    return out;
  });

  return {
    mode: 'vector',
    model: modelId(),
    reasoningEffort: conf.reasoningEffort,
    matchedPaths: pathTop.map((p) => {
      const cat = c.categories.find((x) => x.id === p.cat);
      const sb = cat && (cat.subs || []).find((s) => s.id === p.sub);
      return { path: p.cat + '/' + p.sub, label: [cat && cat.name, sb && sb.name].filter(Boolean).join(' > '), score: p.score };
    }),
    top,
    ...(dis.size ? { disabledExcluded: dis.size } : {}),
    hint: '以上为向量召回候选，是否使用由主模型审核决定；score 为余弦相似度+路径加成，仅供参考不构成结论。',
    auditProtocol: AUDIT_PROTOCOL,
    // 发现层挂到检索上：每次检索顺手报一下待归纳规模，主模型不必专门去扫描。
    // 只读 state 文件，不重新扫盘（扫盘可能几百毫秒，不该塞进检索热路径）。
    ...(() => {
      try {
        const xs = Object.values(loadState().items || {});
        const pending = xs.filter((x) => x.status === 'pending').length;
        const changed = xs.filter((x) => x.status === 'changed').length;
        if (!pending && !changed) return {};
        return {
          discoverBacklog: {
            pending, changed,
            note: '工具库有未归纳的新条目。需要时调 atlas_propose 拿材料，读完自己决定归类后 atlas_commit。',
          },
        };
      } catch { return {}; }
    })(),
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
  {
    name: 'atlas_discover',
    description: '发现层扫描：按约定扫本机技能目录（~/.xxx/skills、DSH 用户库、agents 共享池、preset 层）与 MCP 工具表，和 catalog 比对后列出 pending（没收录）/ changed（源侧变了）/ indexed（已最新）/ ignored（标记不收）/ missing（catalog 有但源侧没了）。只写 discover-state.json，不动 catalog。',
    inputSchema: {
      type: 'object',
      properties: { includeRefs: { type: 'boolean', description: '是否在结果里列出全部 ref 明细（默认 true；false 只给计数）' } },
    },
  },
  {
    name: 'atlas_propose',
    description: '把待归纳条目整理成「主模型可读的原始材料」：技能的 frontmatter + 正文摘要 + 附带文件，MCP server 的工具名与描述。发现层不做归类判断——由你读完材料后自己决定落在哪条 (总分类,子分类) 路径，写出 traits/scenes/avoid。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '本次取几条，默认 6，上限 20' },
        refs: { type: 'array', items: { type: 'string' }, description: '（可选）只看指定 ref，如 ["skill/leanrea","mcp/treg"]' },
        verbose: { type: 'boolean', description: 'true 时 MCP 条目附带每个工具的更长描述' },
      },
    },
  },
  {
    name: 'atlas_commit',
    description: '把主模型归纳好的一批条目写进 catalog（内部就是批量 atlas_upsert）：每条给 ref / name / traits / paths，可选 display/kind/scenes/avoid/invoke/floor/cap。写完后状态从 pending/changed 变 indexed。',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string' }, name: { type: 'string' }, display: { type: 'string' },
              kind: { type: 'string' }, traits: { type: 'string' },
              scenes: { type: 'array', items: { type: 'string' } },
              avoid: { type: 'string' }, invoke: { type: 'string' },
              floor: { type: 'number' }, cap: { type: 'number' },
              paths: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            },
            required: ['ref', 'name', 'traits', 'paths'],
          },
          description: '要提交的条目数组',
        },
        categories: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, desc: { type: 'string' } }, required: ['id'] },
          description: '（可选）新建/更新总分类（整批共用）',
        },
        subs: {
          type: 'array',
          items: { type: 'object', properties: { categoryId: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, desc: { type: 'string' } }, required: ['categoryId', 'id'] },
          description: '（可选）新建/更新子分类（整批共用）',
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'atlas_ignore',
    description: '标记某条发现「不收」：之后扫描不再进待归纳队列。reset=true 撤销该标记。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: '如 skill/quiet-musing' },
        reset: { type: 'boolean', description: 'true = 撤销 ignore，回到待归纳' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'atlas_config',
    description: '读写工具库配置（config.json，改完即时生效，不需要重启）：action=get 看当前配置（apiKey 脱敏）；set 改向量供应商 baseUrl / 模型 model / apiKey / 思考强度 reasoningEffort(low|medium|high|xhigh) / useLlmFallback / hideDisabledInBrowse / disabled；disable 与 enable 按 refs 批量开关禁用项；reset 恢复默认（保留 apiKey）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'get（默认）/ set / reset / disable / enable' },
        baseUrl: { type: 'string', description: 'set：OpenAI 兼容的向量服务地址，如 https://api.siliconflow.cn/v1' },
        model: { type: 'string', description: 'set：embedding 模型 id' },
        apiKey: { type: 'string', description: 'set：API Key（写进本机 config.json，不入库）' },
        reasoningEffort: { type: 'string', description: 'set：low / medium / high / xhigh，默认 high' },
        useLlmFallback: { type: 'boolean', description: 'set：true = 不调向量模型，检索改为把候选原文直接交给大模型判断' },
        hideDisabledInBrowse: { type: 'boolean', description: 'set：true = 浏览时连禁用项也隐藏' },
        disabled: {
          type: 'object',
          properties: {
            skills: { type: 'array', items: { type: 'string' } },
            tools: { type: 'array', items: { type: 'string' } },
          },
          description: 'set：整体替换禁用清单（按 ref 或 name 匹配）',
        },
        refs: { type: 'array', items: { type: 'string' }, description: 'disable / enable：要开关的 ref 列表' },
      },
    },
  },
  {
    name: 'atlas_models',
    description: '拉取当前向量供应商的 GET /models 列表，自动标出哪些是 embedding 模型（按元数据 type/sub_type/pipeline_tag/capabilities 与 id 正则识别，排除 rerank）。可选 applyModel 把某个 id 一键写进配置。',
    inputSchema: {
      type: 'object',
      properties: {
        baseUrl: { type: 'string', description: '（可选）临时指定供应商地址，不写则用配置里的' },
        apiKey: { type: 'string', description: '（可选）临时指定 Key，不写则用配置/环境变量' },
        applyModel: { type: 'string', description: '（可选）把这个模型 id 写进配置并立即生效' },
        all: { type: 'boolean', description: 'false 时只回 embedding 模型，默认回全部' },
      },
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
    const conf = cfg();
    const dis = disabledRefs(c);
    const hide = conf.hideDisabledInBrowse || args.includeDisabled === false;
    const keep = (ref) => !hide || !dis.has(ref);
    if (!args.category) {
      const out = c.categories.map((cat) => {
        const refs = [...new Set((cat.subs || []).flatMap((s) => s.tools || []))].filter(keep);
        return {
          id: cat.id, name: cat.name, desc: cat.desc,
          subs: (cat.subs || []).length,
          tools: refs.length,
          ...(dis.size ? { disabled: refs.filter((r) => dis.has(r)).length } : {}),
        };
      });
      return { content: [{ type: 'text', text: JSON.stringify({ layer: 1, categories: out, totalTools: Object.keys(c.tools).length, disabled: dis.size }, null, 2) }] };
    }
    const cat = findCat(args.category);
    if (!cat) fail(`没有这个总分类: ${args.category}`);
    if (!args.sub) {
      const out = (cat.subs || []).map((s) => ({
        id: s.id, name: s.name, desc: s.desc,
        tools: (s.tools || []).filter(keep).map((ref) => ({
          ref, name: c.tools[ref]?.name || ref,
          ...(dis.has(ref) ? { disabled: true } : {}),
        })),
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ layer: 2, category: { id: cat.id, name: cat.name, desc: cat.desc }, subs: out }, null, 2) }] };
    }
    const sb = (cat.subs || []).find((s) => s.id === args.sub);
    if (!sb) fail(`该总分类下没有子分类: ${args.sub}`);
    const out = (sb.tools || []).filter(keep).map((ref) => {
      const s = summary(c.tools[ref] || { ref, name: ref });
      if (dis.has(ref)) s.disabled = true;
      return s;
    });
    return { content: [{ type: 'text', text: JSON.stringify({ layer: 3, path: `${cat.id}/${sb.id}`, label: `${cat.name} > ${sb.name}`, tools: out }, null, 2) }] };
  }

  if (name === 'atlas_detail') {
    const t = c.tools[args.ref];
    if (!t) fail(`没有这个工具条目: ${args.ref}`);
    const dis = disabledRefs(c);
    return { content: [{ type: 'text', text: JSON.stringify({
      ...t,
      ...(dis.has(args.ref) ? { disabled: true } : {}),
      pathLabels: (t.categories || []).map(([a, b]) => {
        const cat = c.categories.find((x) => x.id === a);
        const sb = cat?.subs?.find((s) => s.id === b);
        return [cat?.name, sb?.name].filter(Boolean).join(' > ');
      }),
    }, null, 2) }] };
  }

  if (name === 'atlas_upsert') {
    const entry = upsertEntry(args, c);
    await saveCatalog();
    loadCatalog();
    const vn = await warmTool(entry.ref, entry);
    const skipped = cfg().useLlmFallback;
    return { content: [{ type: 'text', text: JSON.stringify({
      ok: true, ref: entry.ref, paths: entry.categories,
      dim: vn ? vn.length : 0, label: entry.name,
      ...(skipped ? { embeddingSkipped: true, note: 'useLlmFallback=true：不调用向量模型，该条目只有原文，检索走大模型直读。' } : {}),
    }, null, 2) }] };
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
    const vn = await warmTool(args.ref, t);
    const skipped = cfg().useLlmFallback;
    return { content: [{ type: 'text', text: JSON.stringify({
      ok: true, ref: args.ref, categories: t.categories,
      ...(skipped ? { embeddingSkipped: true } : { dim: vn ? vn.length : 0 }),
    }, null, 2) }] };
  }

  if (name === 'atlas_stats') {
    const conf = cfg();
    const cats = c.categories.map((cat) => ({
      id: cat.id, name: cat.name,
      subs: (cat.subs || []).length,
      tools: new Set((cat.subs || []).flatMap((s) => s.tools || [])).size,
    }));
    const dis = disabledRefs(c);
    return { content: [{ type: 'text', text: JSON.stringify({
      dir: ATLAS_DIR, configPath: CONFIG_PATH,
      model: conf.embedding.model, baseUrl: conf.embedding.baseUrl,
      reasoningEffort: conf.reasoningEffort, useLlmFallback: conf.useLlmFallback,
      disabled: dis.size,
      categories: c.categories.length,
      subs: c.categories.reduce((n, cat) => n + (cat.subs || []).length, 0),
      tools: Object.keys(c.tools).length,
      vectors: Object.keys(loadVecDisk()).length,
      updatedAt: c.updatedAt, perCategory: cats,
    }, null, 2) }] };
  }

  if (name === 'atlas_reindex') {
    if (cfg().useLlmFallback) {
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: false, embeddingSkipped: true,
        note: 'useLlmFallback=true：检索走大模型直读，不需要向量。要重建向量先把 useLlmFallback 关掉。',
      }, null, 2) }] };
    }
    if (args.force) { vecDisk = {}; vecDirty = true; await saveVecDisk(); }
    const refs = Object.keys(c.tools);
    let done = 0;
    for (const ref of refs) { await warmTool(ref, c.tools[ref]); done++; }
    const paths = [];
    for (const cat of c.categories) for (const sb of cat.subs || []) paths.push(pathText(cat, sb));
    for (const p of paths) await vecForFill(p);
    await saveVecDisk();
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, model: modelId(), tools: done, paths: paths.length, vectors: Object.keys(loadVecDisk()).length }, null, 2) }] };
  }

  // ---------------- 发现层：扫 → 提案 → 审核提交 ----------------
  // 分工写死在这三段里：discover 只比对事实，propose 只整理材料，
  // 归类判断（落哪条路径、traits/scenes/avoid 怎么写）由主模型读完材料自己定。
  if (name === 'atlas_discover') {
    const scan = await discoverAll({ catalog: c });
    const base = { scannedAt: scan.scannedAt, stats: scan.stats };
    if (args.includeRefs === false) {
      return { content: [{ type: 'text', text: JSON.stringify(base, null, 2) }] };
    }
    const body = {
      ...base,
      sources: scan.sources,
      pending: scan.fresh.map((r) => r.ref),
      changed: scan.changed.map((r) => r.ref),
      ignored: scan.ignored.map((r) => r.ref),
      missing: scan.missing.map((r) => r.ref),
      next: '接着调 atlas_propose 拿材料读；读完你自己决定每条落在哪条 (总分类,子分类)，写 traits/scenes/avoid，再 atlas_commit。',
    };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
  }

  if (name === 'atlas_propose') {
    const scan = await discoverAll({ catalog: c });
    const r = buildProposal(scan, {
      limit: args.limit,
      refs: Array.isArray(args.refs) ? args.refs : null,
      verbose: !!args.verbose,
      catalog: c,
    });
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
  }

  if (name === 'atlas_commit') {
    const items = Array.isArray(args.items) ? args.items : [];
    if (!items.length) fail('items 是必填的（至少一条）');
    const batchCats = Array.isArray(args.categories) ? args.categories : [];
    const batchSubs = Array.isArray(args.subs) ? args.subs : [];
    const refs = [];
    for (const it of items) {
      const merged = { ...it, categories: [...(it.categories || []), ...batchCats], subs: [...(it.subs || []), ...batchSubs] };
      const entry = upsertEntry(merged, c);
      refs.push(entry.ref);
    }
    await saveCatalog();
    loadCatalog();
    const dims = {};
    const skipWarm = cfg().useLlmFallback;
    for (const ref of refs) {
      const t = c.tools[ref];
      if (!t) continue;
      if (skipWarm) { dims[ref] = 0; continue; }
      const vn = await warmTool(ref, t);
      dims[ref] = vn ? vn.length : 0;
    }
    // 状态落盘：这批 ref 从 pending/changed 变 indexed，记谁在什么时候定的
    let remaining = null;
    try {
      const st = loadState();
      const now = new Date().toISOString();
      for (const ref of refs) {
        const it = st.items[ref] || { ref };
        it.status = 'indexed';
        it.decidedAt = now;
        it.decidedBy = 'model';
        st.items[ref] = it;
      }
      await saveState(st);
      remaining = Object.values(st.items).filter((x) => x.status === 'pending').length;
    } catch {}
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, committed: refs.length, refs, dims, remainingPending: remaining }, null, 2) }] };
  }

  if (name === 'atlas_ignore') {
    if (!args.ref) fail('ref 是必填的');
    const st = loadState();
    const it = st.items[args.ref] || { ref: args.ref };
    if (args.reset) {
      it.status = 'pending';
      delete it.decidedAt; delete it.decidedBy;
    } else {
      it.status = 'ignored';
      it.decidedAt = new Date().toISOString();
      it.decidedBy = 'model';
    }
    st.items[args.ref] = it;
    await saveState(st);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ref: args.ref, status: it.status }, null, 2) }] };
  }

  // ---------------- 配置面：向量供应商 / 思考强度 / 禁用清单 / 回退开关 ----------------
  // 全部走 config.json（mtime 热加载），改完立刻生效，不需要重启 DSH。
  if (name === 'atlas_config') {
    const action = String(args.action || 'get');
    if (action === 'reset') {
      const cur = cfg();
      const next = await writeConfig({
        embedding: { baseUrl: DEFAULT_CONFIG.embedding.baseUrl, model: DEFAULT_CONFIG.embedding.model, apiKey: cur.embedding.apiKey },
        reasoningEffort: DEFAULT_CONFIG.reasoningEffort,
        useLlmFallback: DEFAULT_CONFIG.useLlmFallback,
        disabled: { skills: [], tools: [] },
        hideDisabledInBrowse: DEFAULT_CONFIG.hideDisabledInBrowse,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, action, config: configView(next) }, null, 2) }] };
    }
    if (action === 'set') {
      const patch = {};
      const emb = {};
      if (typeof args.baseUrl === 'string') emb.baseUrl = args.baseUrl;
      if (typeof args.model === 'string') emb.model = args.model;
      if (typeof args.apiKey === 'string') emb.apiKey = args.apiKey;
      if (Object.keys(emb).length) patch.embedding = emb;
      if (typeof args.reasoningEffort === 'string') {
        const e = args.reasoningEffort.toLowerCase();
        if (!EFFORTS.includes(e)) fail('reasoningEffort 只能是 ' + EFFORTS.join(' / '));
        patch.reasoningEffort = e;
      }
      if (typeof args.useLlmFallback === 'boolean') patch.useLlmFallback = args.useLlmFallback;
      if (typeof args.hideDisabledInBrowse === 'boolean') patch.hideDisabledInBrowse = args.hideDisabledInBrowse;
      if (args.disabled && typeof args.disabled === 'object') {
        patch.disabled = {
          skills: Array.isArray(args.disabled.skills) ? args.disabled.skills : undefined,
          tools: Array.isArray(args.disabled.tools) ? args.disabled.tools : undefined,
        };
      }
      if (!Object.keys(patch).length) fail('set 至少要给一个字段（baseUrl / model / apiKey / reasoningEffort / useLlmFallback / disabled / hideDisabledInBrowse）');
      const next = await writeConfig(patch);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, action, config: configView(next) }, null, 2) }] };
    }
    if (action === 'disable' || action === 'enable') {
      const cur = cfg();
      const list = Array.isArray(args.refs) ? args.refs.map(String) : [];
      if (!list.length) fail('disable / enable 需要 refs 数组');
      const pick = (arr) => (action === 'disable'
        ? [...new Set([...arr, ...list])]
        : arr.filter((x) => !list.includes(x)));
      const next = await writeConfig({ disabled: { skills: pick(cur.disabled.skills), tools: pick(cur.disabled.tools) } });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, action, disabled: next.disabled }, null, 2) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, action: 'get', config: configView(cfg()) }, null, 2) }] };
  }

  if (name === 'atlas_models') {
    const conf = cfg();
    const base = String(args.baseUrl || conf.embedding.baseUrl).replace(/\/+$/, '');
    const key = typeof args.apiKey === 'string' && args.apiKey ? args.apiKey : resolveKey();
    if (!key) fail('还没有可用的 API Key：先用 atlas_config set 写 apiKey，或设置环境变量 SILICONFLOW_API_KEY。');
    let payload = null;
    let status = 0;
    try {
      const res = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key } });
      status = res.status;
      if (res.ok) payload = await res.json();
      else payload = { error: (await res.text().catch(() => '')).slice(0, 300) };
    } catch (e) {
      fail('拉取 /models 失败：' + (e && e.message ? e.message : String(e)));
    }
    const all = normalizeModels(payload);
    const emb = embeddingModelsFromList(all);
    let applied = null;
    if (args.applyModel) {
      const pick = String(args.applyModel);
      if (!all.some((m) => m.id === pick)) fail('该供应商的模型列表里没有 ' + pick + '，先不加 applyModel 看一眼全部 id。');
      await writeConfig({ embedding: { model: pick, baseUrl: base } });
      applied = pick;
    }
    return { content: [{ type: 'text', text: JSON.stringify({
      ok: status >= 200 && status < 300,
      status, baseUrl: base, current: conf.embedding.model,
      total: all.length,
      embeddingModels: emb,
      ...(applied ? { applied } : {}),
      ...(args.all === false ? {} : { models: all }),
    }, null, 2) }] };
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
