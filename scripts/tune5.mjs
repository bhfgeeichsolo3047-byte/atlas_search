// tune5：修 tune4 引入的两处回归
// 1) tool/write 的 scenes 被误覆盖（丢了「把这几份文档合成一份」等 9 条原场景）→ 恢复原 9 条 + 追加单元测试新场景
// 2) tool/grep 新场景「在改之前先定位这些字段出现在哪些文件」与 glob 抢活 → 删掉，只保留「按内容搜配置键」类表述
import { spawn } from 'node:child_process';
import { SERVER } from './_paths.mjs';

const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
let id = 0;
const pending = new Map();
let buf = '';
proc.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const cb = pending.get(m.id);
    if (cb) { pending.delete(m.id); cb(m); }
  }
});
function rpc(method, params) {
  const myId = ++id;
  return new Promise((res) => {
    pending.set(myId, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
}
async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.error) throw new Error(name + ': ' + JSON.stringify(r.error));
  const text = r.result?.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return text; }
}

const E = {
  'tool/write': {
    name: 'write', display: '写文件', kind: 'tool',
    traits: '整体创建或覆盖一个 UTF-8 文本文件，父目录自动建；覆盖已有文件前必须先 read 过它',
    avoid: '局部改动优先 edit；不确定原内容时不要直接覆盖',
    invoke: 'write({file_path, content})',
    paths: [['code', 'edit']],
    floor: 0.42, cap: 0,
    scenes: [
      '新建源码/脚本/配置/文档',
      '整文件重写',
      '落盘完整产出物',
      '新建一个文件写入内容',
      '整份覆盖写文件',
      '把这几份文档合成一份',
      '把内容保存成文件',
      '生成一份报告写进文件',
      '导出结果到文件',
      '新建一个测试文件',
      '把这段实现拆成新模块文件写出去',
      '整体写出一份新文档',
    ],
  },
  'tool/grep': {
    name: 'grep', display: '按内容搜索', kind: 'tool',
    traits: 'ripgrep 正则搜索文件内容，返回带行号的匹配行，按文件分组，上限 250 条',
    avoid: '按文件名找用 glob；不要用 shell grep/rg',
    invoke: 'grep({pattern, path?, include?})',
    paths: [['code', 'edit'], ['data', 'text'], ['data', 'file']],
    floor: 0.44, cap: 0,
    scenes: [
      '找某个函数/常量在哪定义',
      '找所有调用点',
      '搜配置键',
      '定位报错文案',
      '在目录里搜哪个文件提到了某个字符串',
      '按内容找代码',
      '正则搜文本',
      '搜出所有包含 timeout 这个键的配置内容',
      '找出所有用到某个配置键的地方',
      '按字段名搜索它在源码里出现的位置',
    ],
  },
};

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tune5', version: '1' } });
for (const [ref, spec] of Object.entries(E)) {
  const r = await call('atlas_upsert', { ref, ...spec });
  console.log(ref, '->', JSON.stringify(r));
}
const re = await call('atlas_reindex', {});
console.log('reindex ->', JSON.stringify(re));
proc.stdin.end();
