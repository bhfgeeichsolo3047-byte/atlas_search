#!/usr/bin/env node
// 快速 smoke test：对 atlas 服务跑几个真实查询，看三层匹配效果
import { spawn } from 'node:child_process';
import { SERVER } from './_paths.mjs';

const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
let id = 0;
function rpc(method, params) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    const onData = (buf) => {
      for (const line of buf.toString().split('\n')) {
        const t = line.trim(); if (!t) continue;
        let m; try { m = JSON.parse(t); } catch { continue; }
        if (m.id === myId) { proc.stdout.off('data', onData); resolve(m); }
      }
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    setTimeout(() => { proc.stdout.off('data', onData); reject(new Error('timeout ' + method)); }, 120000);
  });
}

const QUERIES = [
  '我想把一个安卓包脱壳看看里面逻辑',
  '帮我在这个目录里找有没有哪个文件提到 token 校验',
  '写个脚本批量重命名文件',
  '这台机器上有个进程卡死了要杀掉',
  '把这个大活拆给几个人分别做再汇总',
  '给文章配一张封面图',
  '查一下最近关于这个病的论文',
  '跑命令',
];

await rpc('initialize', {});
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

for (const q of QUERIES) {
  const r = await rpc('tools/call', { name: 'atlas_search', arguments: { query: q, topK: 4 } });
  const txt = r?.result?.content?.[0]?.text || '';
  let j; try { j = JSON.parse(txt); } catch { console.log('RAW', q, txt.slice(0, 200)); continue; }
  console.log('\n【' + q + '】');
  console.log('  路径命中: ' + (j.matchedPaths || []).map((p) => `${p.label}(${p.score})`).join(' , '));
  for (const t of j.top || []) console.log(`  - ${t.ref.padEnd(34)} ${String(t.score).padEnd(7)} ${t.display}`);
}
proc.stdin.end();
setTimeout(() => { try { proc.kill(); } catch {} process.exit(0); }, 1200);
