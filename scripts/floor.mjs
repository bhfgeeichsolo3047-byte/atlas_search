// 给通用兜底工具设置分数下限 floor，保证它们总能进候选。
import fs from 'node:fs';
import { CATALOG } from './_paths.mjs';

const c = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));

// ref -> floor。通用工具给低一点的 floor（只是保底可见），精准工具不给 floor。
const FLOORS = {
  'tool/shell': 0.47,
  'tool/read': 0.44,
  'tool/grep': 0.44,
  'tool/glob': 0.42,
  'tool/edit': 0.42,
  'tool/write': 0.42,
  'tool/web_search': 0.44,
  'tool/web_fetch': 0.43,
  'tool/todo_write': 0.40,
};

for (const [ref, f] of Object.entries(FLOORS)) {
  const t = c.tools[ref];
  if (!t) { console.log('SKIP', ref); continue; }
  t.floor = f;
  t.updatedAt = new Date().toISOString();
  console.log(`FLOOR ${ref.padEnd(22)} = ${f}`);
}
c.updatedAt = new Date().toISOString();
fs.writeFileSync(CATALOG, JSON.stringify(c, null, 2), 'utf8');
console.log('\n写回完成');
