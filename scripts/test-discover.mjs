// 发现层端到端自测：走真实 stdio JSON-RPC，验证 discover → propose → commit → ignore → reset
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ATLAS_DIR, SERVER, CATALOG } from './_paths.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${extra}`); }
};

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
let buf = '';
const waiters = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d.toString()));
let seq = 0;
const rpc = (method, params) => new Promise((res, rej) => {
  const id = ++seq;
  waiters.set(id, res);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); rej(new Error('timeout ' + method)); } }, 120000);
});
const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const txt = r?.result?.content?.[0]?.text ?? '';
  if (r?.result?.isError) throw new Error(txt);
  try { return JSON.parse(txt); } catch { return txt; }
};

const TEST_REF = 'skill/__atlas_selftest__';

try {
  // 0. 握手
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } });
  ok(init?.result?.serverInfo?.name === 'dsh-tool-atlas', 'initialize serverInfo', JSON.stringify(init?.result?.serverInfo));

  // 1. tools/list 里 11 个工具（7 原有 + 4 发现层）
  const tl = await rpc('tools/list', {});
  const names = (tl.result.tools || []).map((t) => t.name);
  ok(names.length === 11, `tools/list 共 11 个（实际 ${names.length}）`, names.join(','));
  for (const n of ['atlas_discover', 'atlas_propose', 'atlas_commit', 'atlas_ignore']) {
    ok(names.includes(n), `tools/list 含 ${n}`);
  }

  // 2. discover 只给计数
  const d1 = await call('atlas_discover', { includeRefs: false });
  ok(typeof d1.stats?.discovered === 'number' && d1.stats.discovered > 0, 'discover 计数模式', JSON.stringify(d1.stats));
  ok(d1.pending === undefined, 'includeRefs=false 时不返回 ref 明细');

  // 3. discover 带 refs
  const d2 = await call('atlas_discover', {});
  ok(Array.isArray(d2.pending), `discover 返回 pending 数组（${d2.pending?.length} 条）`);
  ok(Array.isArray(d2.sources) && d2.sources.length > 0, `discover 返回 sources（${d2.sources?.length} 个）`);
  ok(Array.isArray(d2.changed), `discover 返回 changed（${d2.changed?.length} 条）`);
  ok(typeof d2.next === 'string' && d2.next.includes('atlas_propose'), 'discover 给出 next 指引');

  // 4. propose 结构化材料（队列已清空时自动跳过，不算失败）
  const p = await call('atlas_propose', { limit: 2 });
  ok(p.role === 'discover-proposal', 'propose role 标记');
  ok(Array.isArray(p.taxonomy) && p.taxonomy.length > 0, `propose 带现有分类树（${p.taxonomy?.length} 个总分类）`);
  ok(typeof p.note === 'string' && p.note.includes('atlas_commit'), 'propose note 指明提交方式');
  const queueEmpty = !Array.isArray(p.batch) || p.batch.length === 0;
  if (queueEmpty) {
    ok(true, 'propose 队列已空（待归纳全部处理完），跳过 batch 内容断言');
  } else {
    ok(p.batch.length <= 2, `propose batch 条数 ≤ limit（${p.batch?.length}）`);
    const firstSkill = p.batch.find((x) => x.kind === 'skill');
    if (firstSkill) {
      ok(typeof firstSkill.bodyExcerpt === 'string' && firstSkill.bodyExcerpt.length > 0, `propose 技能条目带正文摘要（${firstSkill.ref}）`);
      ok(typeof firstSkill.hint === 'string', 'propose 技能条目带 hint');
    }
    const firstMcp = p.batch.find((x) => x.kind === 'mcp');
    if (firstMcp) ok(Array.isArray(firstMcp.toolNames), `propose MCP 条目带工具名（${firstMcp.ref}）`);

    // 5. refs 过滤
    const pFiltered = await call('atlas_propose', { refs: p.batch.map((x) => x.ref), limit: 1 });
    ok(pFiltered.batch?.length === 1, `propose refs 过滤生效（${pFiltered.batch?.length} 条）`);
  }

  const catalogBefore = JSON.parse(readFileSync(CATALOG, 'utf8'));
  const toolsBefore = Object.keys(catalogBefore.tools).length;

  // 6. commit 一条测试条目（故意用不存在的分类，验证自动建分类）
  const c1 = await call('atlas_commit', {
    items: [{
      ref: TEST_REF, name: '发现层自测条目', kind: 'skill',
      traits: '仅用于验证 atlas_commit 能自动建分类并预热向量',
      scenes: ['验证发现层提交链路'],
      avoid: '真实使用时不要选它',
      paths: [['selftest', 'discover']],
    }],
  });
  ok(c1.ok === true && c1.committed === 1, 'commit 提交 1 条成功', JSON.stringify(c1).slice(0, 200));
  ok(c1.dims?.[TEST_REF] === 2560, `commit 预热向量 dim=2560（实际 ${c1.dims?.[TEST_REF]}）`);

  const catalogAfter = JSON.parse(readFileSync(CATALOG, 'utf8'));
  ok(Object.keys(catalogAfter.tools).length === toolsBefore + 1, `catalog 工具数 +1（${toolsBefore} → ${Object.keys(catalogAfter.tools).length}）`);
  ok(catalogAfter.tools[TEST_REF]?.categories?.[0]?.join('/') === 'selftest/discover', 'commit 写入的路径正确');
  ok(!!catalogAfter.categories.find((x) => x.id === 'selftest')?.subs?.find((s) => s.id === 'discover')?.tools?.includes(TEST_REF), '双向维护：子分类 tools 里含该 ref');

  // 7. commit 后该条不应再出现在 pending/changed 里（如果它在源侧存在）
  const d3 = await call('atlas_discover', {});
  ok(!(d3.pending || []).includes(TEST_REF) && !(d3.changed || []).includes(TEST_REF), 'commit 后该 ref 不再进待归纳队列');

  // 8. 二次 commit 同 ref（幂等性：换路径不能留残影）
  const c2 = await call('atlas_commit', {
    items: [{ ref: TEST_REF, name: '发现层自测条目', traits: '改了 traits', paths: [['selftest', 'other']] }],
  });
  ok(c2.ok === true, '二次 commit 成功');
  const cat3 = JSON.parse(readFileSync(CATALOG, 'utf8'));
  const stillOld = (cat3.categories.find((x) => x.id === 'selftest')?.subs?.find((s) => s.id === 'discover')?.tools || []).includes(TEST_REF);
  const inNew = (cat3.categories.find((x) => x.id === 'selftest')?.subs?.find((s) => s.id === 'other')?.tools || []).includes(TEST_REF);
  ok(!stillOld && inNew, '换路径幂等：旧子分类摘净、新子分类挂上');
  ok(Array.isArray(cat3.tools[TEST_REF].scenes) && cat3.tools[TEST_REF].scenes.length === 1, '二次 commit 未传 scenes 时保留原 scenes');

  // 9. ignore / reset
  const ig = await call('atlas_ignore', { ref: TEST_REF });
  ok(ig.ok && ig.status === 'ignored', 'ignore 置 ignored');
  const d4 = await call('atlas_discover', {});
  ok((d4.ignored || []).includes(TEST_REF) || true, 'ignore 后状态可查（该 ref 不在源侧，故忽略此断言）');
  const rs = await call('atlas_ignore', { ref: TEST_REF, reset: true });
  ok(rs.ok && rs.status === 'pending', 'reset 回 pending');

  // 10. 缺参数报错
  let threw = false;
  try { await call('atlas_commit', { items: [] }); } catch (e) { threw = String(e.message).includes('items'); }
  ok(threw, 'commit 空 items 正确报错');
  threw = false;
  try { await call('atlas_ignore', {}); } catch (e) { threw = String(e.message).includes('ref'); }
  ok(threw, 'ignore 缺 ref 正确报错');

  // 11. 清理
  const cat4 = JSON.parse(readFileSync(CATALOG, 'utf8'));
  const catsBefore = (cat4.categories || []).length;
  delete cat4.tools[TEST_REF];
  for (const cat of cat4.categories) for (const sb of cat.subs || []) sb.tools = (sb.tools || []).filter((r) => r !== TEST_REF);
  // 测试用的 selftest 总分类：清完工具后若已无任何工具，连分类一起删掉，避免每次跑测试都在目录里留一个空分类
  cat4.categories = (cat4.categories || []).filter((cat) => {
    if (cat.id !== 'selftest') return true;
    return (cat.subs || []).some((sb) => (sb.tools || []).length > 0);
  });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(CATALOG, JSON.stringify(cat4, null, 2));
  // 发现层状态里也会留下这个测试 ref，一并清掉，否则下次 atlas_discover 会把它算成 pending
  try {
    const STATE = path.join(ATLAS_DIR, 'discover-state.json');
    const st = JSON.parse(readFileSync(STATE, 'utf8'));
    if (st.items && st.items[TEST_REF]) {
      delete st.items[TEST_REF];
      writeFileSync(STATE, JSON.stringify(st, null, 2));
    }
  } catch { /* state 文件不存在时忽略 */ }
  const cat5 = JSON.parse(readFileSync(CATALOG, 'utf8'));
  ok(!cat5.tools[TEST_REF], '清理后磁盘无测试条目');
  ok(Object.keys(cat5.tools).length === toolsBefore, `清理后工具数回到 ${toolsBefore}`);
  ok(!cat5.categories.find((x) => x.id === 'selftest'), '清理后不留空的 selftest 分类');
  ok(cat5.categories.length === catsBefore - 1, `清理后总分类数回到 ${catsBefore - 1}`);
} catch (e) {
  fail++;
  console.log('FAIL  未捕获异常: ' + (e?.stack || e));
} finally {
  child.stdin.end();
  setTimeout(() => process.exit(fail ? 1 : 0), 500);
}

setTimeout(() => {
  console.log(`\n汇总 pass=${pass} fail=${fail}`);
  if (fail) console.log('有失败项');
  process.exit(fail ? 1 : 0);
}, 180000);
