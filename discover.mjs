#!/usr/bin/env node
/**
 * dsh-tool-atlas · 发现层（零依赖）
 * ------------------------------------------------------------------
 * 约定式自动发现本机技能与 MCP 工具，产出「待归纳」清单交给**当前客户端主模型**
 * 阅读并决定归档路径（分类 / 子分类）。发现层本身不做语义判断，只做三件事：
 *   1. 按约定扫出所有条目（技能目录、MCP server 的工具表）
 *   2. 用内容指纹比对 catalog，分出 pending / changed / indexed / ignored
 *   3. 把原始材料（frontmatter + 正文摘要 + 工具名与描述）整理成提案，供主模型审阅
 *
 * 约定（与 @weibaohui/skills-management 同源）
 *   C1 技能源：家目录下任何 `.<name>/skills/` 目录（Windows: %USERPROFILE%\.xxx\skills）
 *      由规则自动识别；规则够不到的用显式清单补（DSH 用户库、agents 共享池、preset 层）。
 *   C2 一个技能 = 技能根下的一个子目录，内含 SKILL.md，frontmatter 至少 name + description。
 *   C3 MCP 工具源 = <dshHome>/storages/mcp_connector.json → tables.tool_catalog。
 *   C4 发现结果只写 discover-state.json；要进 catalog.json 必须由主模型审核后 commit。
 */
import { promises as fsp, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

export const HOME = os.homedir();
export const DSH_HOME = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(HOME, '.dsh');
export const ATLAS_DIR = process.env.ATLAS_DIR || path.join(DSH_HOME, 'tool-atlas');
export const STATE_FILE = path.join(ATLAS_DIR, 'discover-state.json');
export const CATALOG_FILE = path.join(ATLAS_DIR, 'catalog.json');
export const MCP_STORE = path.join(DSH_HOME, 'storages', 'mcp_connector.json');

export const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 24);

// 显式技能源：约定规则覆盖不到的固定位置
const EXPLICIT_SKILL_SOURCES = [
  { key: 'dsh-user', label: 'DSH 用户库', dir: path.join(DSH_HOME, 'skills') },
  { key: 'agents-pool', label: 'Agents 共享池', dir: path.join(HOME, '.agents', 'skills') },
];
const PRESET_ROOT = path.join(DSH_HOME, '.agent-presets');

function statIsDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
function statIsFile(p) { try { return statSync(p).isFile(); } catch { return false; } }
function readdirDirs(p) {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch { return []; }
}

// ---------- frontmatter ----------
// 只解析 SKILL.md 顶部的简单 YAML（key: value 与缩进续行），不引入 yaml 依赖。
export function parseFrontmatter(text) {
  const src = String(text || '');
  const m = src.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  let key = null;
  let buf = [];
  const flush = () => {
    if (!key) return;
    meta[key] = buf.join(' ').replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
    key = null;
    buf = [];
  };
  for (const raw of m[1].split(/\r?\n/)) {
    const head = raw.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (head) { flush(); key = head[1]; buf = [head[2]]; continue; }
    if (key && /^\s+\S/.test(raw)) { buf.push(raw.trim()); continue; }
    if (key && raw.trim() === '') continue;
    flush();
  }
  flush();
  const body = src.slice(m[0].length).replace(/^\s*\n/, '');
  return { meta, body };
}

// ---------- 技能源发现 ----------
// C1-a：家目录直下任何 `.` 开头且内含 skills/ 子目录的目录
export async function discoverSkillHomes(home = HOME) {
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(home, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.name.startsWith('.') || e.name === '.' || e.name === '..') continue;
    const dir = path.join(home, e.name, 'skills');
    if (statIsDir(dir)) out.push({ key: e.name.slice(1), label: e.name.slice(1), dir });
  }
  return out;
}
// C1-b：preset 层的 skills/（~/.dsh/.agent-presets/<preset>/skills）
export function discoverPresetSkillHomes() {
  const out = [];
  for (const name of readdirDirs(PRESET_ROOT)) {
    const dir = path.join(PRESET_ROOT, name, 'skills');
    if (statIsDir(dir)) out.push({ key: `preset-${name}`, label: `Preset ${name}`, dir });
  }
  return out;
}
export function listSkillSources() {
  const all = [];
  const seen = new Set();
  const push = (s) => {
    const k = path.resolve(s.dir).toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    all.push({ kind: 'skill', ...s });
  };
  for (const s of EXPLICIT_SKILL_SOURCES) if (statIsDir(s.dir)) push({ ...s, rule: 'explicit' });
  for (const s of discoverPresetSkillHomes()) push({ ...s, rule: 'preset' });
  for (const s of discoverSkillHomesSync()) push({ ...s, rule: 'convention' });
  return all;
}
function discoverSkillHomesSync() {
  const out = [];
  for (const name of readdirDirs(HOME)) {
    if (!name.startsWith('.')) continue;
    const dir = path.join(HOME, name, 'skills');
    if (statIsDir(dir)) out.push({ key: name.slice(1), label: name.slice(1), dir });
  }
  return out;
}

// 读一个技能目录 → 提案素材
export function readSkillEntry(src, dirName) {
  const dir = path.join(src.dir, dirName);
  const skillMd = path.join(dir, 'SKILL.md');
  let text = '';
  let fpExtra = '';
  try {
    text = readFileSync(skillMd, 'utf8');
    const st = statSync(skillMd);
    fpExtra = `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch { return null; }
  const { meta, body } = parseFrontmatter(text);
  const name = String(meta.name || dirName).trim();
  const description = String(meta.description || '').trim();
  // 目录下其它文件（脚本/参考资料）——主模型据此判断这技能是不是带可执行资产
  let files = [];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name !== 'SKILL.md')
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .slice(0, 20);
  } catch {}
  return {
    ref: `skill/${dirName}`,
    kind: 'skill',
    source: src.key,
    sourceLabel: src.label,
    sourceDir: src.dir,
    dir,
    name,
    display: name,
    description,
    whenToUse: String(meta.whenToUse || meta['when-to-use'] || '').trim(),
    role: String(meta.role || '').trim(),
    enabled: meta.enabled === undefined ? null : String(meta.enabled).toLowerCase() !== 'false',
    bodyExcerpt: body.replace(/\s+/g, ' ').trim().slice(0, 1600),
    files,
    fingerprint: sha(`${name}\n${description}\n${String(meta.whenToUse || meta['when-to-use'] || '')}\n${fpExtra}`),
  };
}

// ---------- MCP 工具源发现 ----------
export function readMcpStore() {
  try { return JSON.parse(readFileSync(MCP_STORE, 'utf8')); } catch { return null; }
}
// C3：tables.tool_catalog → [{ key, serverName, enabled, tools:[{name,title,description}] }]
export function listMcpServers() {
  const store = readMcpStore();
  const cat = store?.tables?.tool_catalog || {};
  const conns = store?.tables?.connections || {};
  const enabled = new Map();
  for (const [k, v] of Object.entries(conns || {})) {
    const en = v?.enabled !== false;
    enabled.set(String(v?.serverName || v?.connectorId || k), en);
  }
  const out = [];
  for (const [key, entry] of Object.entries(cat)) {
    const serverName = String(entry?.serverName || entry?.connectorId || key);
    const tools = Array.isArray(entry?.tools) ? entry.tools : [];
    const rows = tools.map((t) => ({
      name: String(t?.name || ''),
      title: String(t?.title || ''),
      description: String(t?.description || '').replace(/\s+/g, ' ').trim(),
    })).filter((t) => t.name);
    if (!rows.length) continue;
    out.push({
      key, connectorId: String(entry?.connectorId || key), serverName,
      enabled: enabled.get(serverName) !== false,
      signature: String(entry?.connectionSignature || ''),
      tools: rows,
      fingerprint: sha(rows.map((r) => `${r.name}|${r.title}|${r.description}`).join('\n')),
    });
  }
  return out;
}
// MCP 条目 ref：优先复用 catalog 里已有的 `mcp/<x>`（x 出现在 serverName 里），否则按名派生
export function deriveMcpRef(serverName, catalog) {
  const lower = String(serverName).toLowerCase();
  const hits = Object.entries(catalog?.tools || {})
    .filter(([ref]) => ref.startsWith('mcp/'))
    .map(([ref, t]) => [ref, String(t?.name || ref.slice(4)).toLowerCase()])
    .filter(([, n]) => n && n.length >= 3 && lower.includes(n));
  if (hits.length) return hits[0][0];
  const short = lower.replace(/^custom-/, '').replace(/-main$/, '').replace(/-catalog$/, '');
  return `mcp/${short || lower}`;
}

// ---------- 发现状态 ----------
const EMPTY_STATE = { version: 1, scannedAt: '', sources: [], items: {} };
export function loadState() {
  try {
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return { ...EMPTY_STATE, ...j, items: j?.items || {}, sources: j?.sources || [] };
  } catch { return JSON.parse(JSON.stringify(EMPTY_STATE)); }
}
export async function saveState(state) {
  await fsp.mkdir(ATLAS_DIR, { recursive: true });
  state.version = 1;
  state.scannedAt = new Date().toISOString();
  // 临时名带 pid+随机后缀：并发两次写同一文件时不会互相抢同一个 tmp
  const tmp = `${STATE_FILE}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
  await fsp.rename(tmp, STATE_FILE);
  return state;
}
export function loadCatalogFile() {
  try { return JSON.parse(readFileSync(CATALOG_FILE, 'utf8')); } catch { return { categories: [], tools: {} }; }
}

/**
 * 全量扫描 + 与 catalog 比对。
 * status 语义：
 *   pending  catalog 里没有、且没被 ignore 过 → 等主模型归纳
 *   changed  catalog 里有但指纹变了（技能改了 description/正文，或 MCP server 工具表变了）→ 等主模型复核
 *   indexed  catalog 里有且指纹一致 → 已是最新
 *   ignored  主模型明确标记「不收」→ 不再进队列
 */
export async function discoverAll({ catalog } = {}) {
  const cat = catalog || loadCatalogFile();
  const prev = loadState();
  const sources = listSkillSources();
  const raw = [];

  // 同一个技能常被多个 agent 目录共享（软链或复制），ref 按 frontmatter name 归一，
  // 只保留一份，其余记为 mirrors —— 否则 leanrea 这种会被算成 5+ 条重复待归纳。
  const byName = new Map();
  const sourceStats = [];
  for (const src of sources) {
    let ok = 0;
    for (const name of readdirDirs(src.dir)) {
      const e = readSkillEntry(src, name);
      if (!e) continue;
      ok++;
      const key = e.name.toLowerCase();
      const prevHit = byName.get(key);
      if (!prevHit) { byName.set(key, { ...e, mirrors: [], __rule: src.rule }); continue; }
      // 已有同名的：优先级 explicit > preset > convention（同优先级保留先见到的）
      const rank = (r) => (r === 'explicit' ? 0 : r === 'preset' ? 1 : 2);
      if (rank(src.rule) < rank(prevHit.__rule || 'convention')) {
        byName.set(key, { ...e, mirrors: [...prevHit.mirrors, prevHit.sourceDir], __rule: src.rule });
      } else {
        prevHit.mirrors.push(src.dir);
      }
    }
    sourceStats.push({ key: src.key, label: src.label, dir: src.dir, skills: ok, rule: src.rule });
  }
  for (const e of byName.values()) {
    const { __rule, ...rest } = e;
    raw.push(rest);
  }

  const servers = listMcpServers();
  for (const s of servers) {
    const ref = deriveMcpRef(s.serverName, cat);
    raw.push({
      ref,
      kind: 'mcp',
      source: 'mcp-store',
      sourceLabel: 'MCP 工具表',
      serverName: s.serverName,
      connectorId: s.connectorId,
      enabled: s.enabled,
      name: ref.slice(4),
      display: s.serverName,
      description: `${s.tools.length} 个 MCP 工具：${s.tools.slice(0, 24).map((t) => t.name).join(', ')}${s.tools.length > 24 ? ' …' : ''}`,
      tools: s.tools,
      toolCount: s.tools.length,
      fingerprint: s.fingerprint,
    });
  }
  sourceStats.push({
    key: 'mcp-store', label: 'MCP 工具表', dir: MCP_STORE,
    skills: servers.reduce((n, s) => n + s.tools.length, 0), rule: 'explicit', servers: servers.length,
  });

  const items = {};
  const fresh = [], changed = [], indexed = [], ignored = [];
  const now = new Date().toISOString();
  for (const e of raw) {
    const seenBefore = prev.items[e.ref];
    const inCatalog = !!cat?.tools?.[e.ref];
    let status;
    if (!inCatalog) status = seenBefore?.status === 'ignored' ? 'ignored' : 'pending';
    else if (!seenBefore || seenBefore.fingerprint !== e.fingerprint) status = 'changed';
    else status = 'indexed';
    const rec = {
      ref: e.ref, kind: e.kind, source: e.source, name: e.name,
      fingerprint: e.fingerprint, status,
      firstSeenAt: seenBefore?.firstSeenAt || now,
      updatedAt: now,
    };
    if (seenBefore?.decidedAt) rec.decidedAt = seenBefore.decidedAt;
    items[e.ref] = rec;
    if (status === 'pending') fresh.push(rec);
    else if (status === 'changed') changed.push(rec);
    else if (status === 'ignored') ignored.push(rec);
    else indexed.push(rec);
  }

  // catalog 有、发现层没有 → 源侧消失（只对来自技能源的条目报警；手写/MCP 条目不在此列）
  const missing = [];
  for (const [ref, t] of Object.entries(cat?.tools || {})) {
    if (items[ref]) continue;
    const fromSkillSource = ref.startsWith('skill/');
    if (!fromSkillSource) continue;
    if (t?.origin === 'manual') continue;
    missing.push({ ref, kind: t?.kind || '', name: t?.name || ref });
  }

  const state = { ...prev, sources: sourceStats, items };
  await saveState(state);
  return {
    scannedAt: state.scannedAt,
    sources: sourceStats,
    items, fresh, changed, indexed, ignored, missing,
    stats: {
      skillSources: sources.length,
      mcpServers: servers.length,
      discovered: raw.length,
      pending: fresh.length,
      changed: changed.length,
      indexed: indexed.length,
      ignored: ignored.length,
      missing: missing.length,
      catalogTools: Object.keys(cat?.tools || {}).length,
    },
  };
}

// ---------- 主模型审阅提案 ----------
/**
 * 把一批待归纳条目整理成「主模型可读的原始材料」。
 * @param {object} scan  discoverAll 的返回
 * @param {object} opts  { limit, refs, verbose, catalog }
 */
export function buildProposal(scan, { limit = 6, refs = null, verbose = false, catalog = null } = {}) {
  const cat = catalog || loadCatalogFile();
  let queue = [...scan.fresh, ...scan.changed];
  if (Array.isArray(refs) && refs.length) {
    const want = new Set(refs);
    queue = queue.filter((r) => want.has(r.ref));
  }
  const batch = [];
  for (const rec of queue.slice(0, Math.max(1, Math.min(limit, 20)))) {
    if (rec.kind === 'skill') {
      const src = listSkillSources().find((s) => s.key === rec.source) || null;
      const e = src ? readSkillEntry(src, rec.ref.slice(6)) : null;
      if (!e) continue;
      batch.push({
        ref: e.ref, kind: 'skill', status: rec.status, source: e.sourceLabel || rec.source,
        name: e.name, description: e.description,
        whenToUse: e.whenToUse, role: e.role,
        bodyExcerpt: e.bodyExcerpt, files: e.files,
        hint: '技能：从 description/whenToUse 提炼 traits；把正文里「什么时候用/触发词/适用场景」抽成 scenes；把「不适用/改用别的」抽成 avoid。invoke 写 skill({name:"' + e.ref.slice(6) + '"})。',
      });
    } else {
      const srv = listMcpServers().find((s) => deriveMcpRef(s.serverName, cat) === rec.ref);
      if (!srv) continue;
      batch.push({
        ref: rec.ref, kind: 'mcp', status: rec.status,
        source: `MCP server ${srv.serverName}（${srv.enabled ? '已连接' : '已停用'}）`,
        name: rec.ref.slice(4), serverName: srv.serverName, toolCount: srv.tools.length,
        toolNames: srv.tools.map((t) => t.name),
        sample: (verbose ? srv.tools : srv.tools.slice(0, 4)).map((t) => ({
          name: t.name, title: t.title, description: String(t.description || '').slice(0, verbose ? 400 : 200),
        })),
        hint: 'MCP server（聚合条目）：按 toolNames 概括这套工具整体能干什么写 traits；scenes 写「什么任务该找这个 server」；avoid 写「什么时候改用别的更合适」。若某几个工具用途差异极大，可单工具粒度再 upsert（ref 用 mcp/<server>/<tool>）并 atlas_link 挂同一路径。',
      });
    }
  }
  return {
    role: 'discover-proposal',
    note: '发现层只做扫描与整理，不做归类判断。请阅读 batch 每条材料后，自己决定它该落在哪条 (总分类,子分类) 路径，并写出 traits / scenes / avoid，然后一次 atlas_commit 提交整批。',
    queued: queue.length,
    remaining: Math.max(0, queue.length - batch.length),
    batch,
    taxonomy: (cat.categories || []).map((c) => ({
      id: c.id, name: c.name, desc: c.desc || '',
      subs: (c.subs || []).map((s) => ({ id: s.id, name: s.name, desc: s.desc || '', tools: (s.tools || []).length })),
    })),
    limits: { limitMax: 20, verbose: 'verbose=true 时 MCP 条目附带每工具 400 字描述、技能正文截断更长' },
    next: '读材料 → 定路径与 traits/scenes/avoid → atlas_commit({ items:[...] })；不想收的用 atlas_ignore({ ref })；只想看某几条用 atlas_propose({ refs:[...] })',
    scannedAt: scan.scannedAt,
  };
}
