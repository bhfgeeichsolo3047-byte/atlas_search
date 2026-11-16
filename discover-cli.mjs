#!/usr/bin/env node
/**
 * discover-cli —— 发现层的命令行入口（供人/主模型直接跑，不经 MCP）
 *   node discover-cli.mjs scan
 *   node discover-cli.mjs propose [--limit 6] [--verbose] [--refs skill/a,mcp/b]
 *   node discover-cli.mjs ignore --ref skill/xxx
 *   node discover-cli.mjs reset --ref skill/xxx
 */
import { discoverAll, buildProposal, loadState, saveState, loadCatalogFile, listSkillSources } from './discover.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'scan';
function flag(name, def = undefined) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

if (cmd === 'scan') {
  const cat = loadCatalogFile();
  const scan = await discoverAll({ catalog: cat });
  console.log(JSON.stringify({
    scannedAt: scan.scannedAt,
    stats: scan.stats,
    sources: scan.sources,
    pendingRefs: scan.fresh.map((r) => r.ref),
    changedRefs: scan.changed.map((r) => r.ref),
    ignoredRefs: scan.ignored.map((r) => r.ref),
    missing: scan.missing,
  }, null, 2));
  process.exit(0);
}

if (cmd === 'propose') {
  const cat = loadCatalogFile();
  const scan = await discoverAll({ catalog: cat });
  const refsRaw = flag('refs', null);
  const refs = refsRaw && refsRaw !== true ? String(refsRaw).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const out = buildProposal(scan, {
    limit: Number(flag('limit', 6)),
    verbose: !!flag('verbose', false),
    refs,
    catalog: cat,
  });
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

if (cmd === 'ignore' || cmd === 'reset') {
  const ref = flag('ref', null);
  if (!ref || ref === true) { console.error('需要 --ref skill/xxx'); process.exit(2); }
  const st = loadState();
  if (!st.items[ref]) { console.error(`状态里没有这个条目: ${ref}`); process.exit(2); }
  if (cmd === 'ignore') {
    st.items[ref].status = 'ignored';
    st.items[ref].decidedAt = new Date().toISOString();
    st.items[ref].decidedBy = 'cli';
  } else {
    st.items[ref].status = 'pending';
    delete st.items[ref].decidedAt;
    delete st.items[ref].decidedBy;
  }
  await saveState(st);
  console.log(JSON.stringify({ ok: true, ref, status: st.items[ref].status }, null, 2));
  process.exit(0);
}

if (cmd === 'sources') {
  console.log(JSON.stringify(listSkillSources(), null, 2));
  process.exit(0);
}

console.error(`未知子命令: ${cmd}（scan / propose / ignore / reset / sources）`);
process.exit(2);
