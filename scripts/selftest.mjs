#!/usr/bin/env node
// 端到端自测：upsert / link / browse 三层 / search(avoid + auditProtocol) / 清理
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { SERVER, CATALOG } from './_paths.mjs';

const TEST_REF = 'tool/__selftest__';

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const waiters = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d.toString()));
let seq = 0;
function rpc(method, params) {
  const id = ++seq;
  return new Promise((res, rej) => {
    waiters.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); rej(new Error('timeout ' + method)); } }, 180000);
  });
}
const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.error) throw new Error(name + ': ' + JSON.stringify(r.error));
  const text = r.result?.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return text; }
};
const ok = (c, m) => console.log((c ? '  [PASS] ' : '  [FAIL] ') + m);

(async () => {
  console.log('=== 1) initialize ===');
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } });
  ok(init.result?.serverInfo?.name === 'dsh-tool-atlas', 'initialize: ' + JSON.stringify(init.result?.serverInfo));

  const before = await call('atlas_stats');
  console.log('=== 2) atlas_upsert（验 v is not defined 已修 + sceneList 预热）===');
  const up = await call('atlas_upsert', {
    ref: TEST_REF,
    name: '__selftest__',
    display: '自测占位工具',
    kind: 'tool',
    traits: '仅用于端到端自测的占位条目，验证 upsert 不崩、多分类挂载、逐条场景向量预热',
    scenes: ['自测场景甲：验证向量写入', '自测场景乙：验证批量预热', '自测场景丙：验证多路径'],
    avoid: '真实任务中不要使用，它只是自测占位',
    invoke: '__selftest__({})',
    paths: [['code', 'debug'], ['auto', 'system']],
    floor: 0.2,
  });
  ok(up && up.ok === true, 'upsert 返回 ok=true');
  ok(typeof up.dim === 'number' && up.dim > 0, 'upsert dim=' + up.dim + '（非 ReferenceError）');
  ok(Array.isArray(up.paths) && up.paths.length === 2, 'upsert 多分类=' + JSON.stringify(up.paths));

  console.log('=== 3) atlas_link 追加挂载 ===');
  const lk = await call('atlas_link', { ref: TEST_REF, category: 'data', sub: 'file' });
  ok(lk && lk.ok === true && lk.categories.length === 3, 'link 后分类数=' + (lk?.categories?.length ?? 'n/a'));

  console.log('=== 4) atlas_browse 三层 ===');
  const b1 = await call('atlas_browse');
  ok(b1.layer === 1 && Array.isArray(b1.categories), '第 1 层 categories=' + (b1.categories?.length ?? 0));
  const b2 = await call('atlas_browse', { category: 'code' });
  ok(b2.layer === 2 && Array.isArray(b2.subs), '第 2 层 subs=' + (b2.subs?.length ?? 0));
  const b3 = await call('atlas_browse', { category: 'code', sub: 'debug' });
  ok(b3.layer === 3 && Array.isArray(b3.tools), '第 3 层 tools=' + (b3.tools?.length ?? 0));
  const third = b3.tools?.find((x) => x.ref === TEST_REF);
  ok(!!third, '第 3 层含自测条目');
  ok(third && Object.prototype.hasOwnProperty.call(third, 'avoid') && third.avoid.includes('不要使用'), '第 3 层暴露 avoid=' + JSON.stringify(third?.avoid ?? null));

  console.log('=== 5) atlas_search（avoid + auditProtocol）===');
  const sr = await call('atlas_search', { query: '我想把一个安卓包脱壳看看里面逻辑', topK: 5 });
  ok(Array.isArray(sr.top) && sr.top.length > 0, 'search top=' + (sr.top?.length ?? 0));
  ok(sr.top?.every((x) => Object.prototype.hasOwnProperty.call(x, 'avoid')), '每个候选项都带 avoid 字段');
  ok(sr.auditProtocol && Array.isArray(sr.auditProtocol.checklist) && sr.auditProtocol.checklist.length === 4, 'auditProtocol 四步清单齐');
  ok(typeof sr.auditProtocol?.fallback === 'string' && sr.auditProtocol.fallback.length > 0, 'auditProtocol 有 fallback');
  console.log('    top3: ' + sr.top.slice(0, 3).map((x) => `${x.ref}(${x.score})`).join(' / '));
  console.log('    matchedPaths: ' + sr.matchedPaths.map((p) => `${p.path}:${p.score}`).join(' / '));

  console.log('=== 6) 清理自测条目 ===');
  const raw = JSON.parse(readFileSync(CATALOG, 'utf8'));
  if (raw.tools[TEST_REF]) {
    delete raw.tools[TEST_REF];
    for (const c of raw.categories) for (const s of c.subs || []) {
      s.tools = (s.tools || []).filter((r) => r !== TEST_REF);
    }
    raw.updatedAt = new Date().toISOString();
    writeFileSync(CATALOG, JSON.stringify(raw, null, 2), 'utf8');
    ok(true, '已从 catalog.json 移除 ' + TEST_REF);
  } else ok(true, 'catalog 中本无自测条目');

  const after = await call('atlas_stats');
  // 进程内 catalog 有缓存，stats 可能读到删前的快照；以磁盘为准判定清理是否彻底。
  const disk = JSON.parse(readFileSync(CATALOG, 'utf8'));
  const diskRefs = Object.keys(disk.tools);
  const leaked = [];
  for (const c of disk.categories) for (const s of c.subs || []) if ((s.tools || []).includes(TEST_REF)) leaked.push(c.id + '/' + s.id);
  ok(!diskRefs.includes(TEST_REF) && leaked.length === 0, `磁盘清理彻底：tools=${diskRefs.length}，泄漏路径=${leaked.length}`);
  ok(diskRefs.length === before.tools, `工具数回落到 ${diskRefs.length}（自测前 ${before.tools}）`);
  console.log('=== 汇总：' + JSON.stringify({ tools: diskRefs.length, subs: after.subs, categories: after.categories, vectors: after.vectors }) + ' ===');
  child.stdin.end();
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error('FATAL ' + e.message); child.kill(); process.exit(1); });
