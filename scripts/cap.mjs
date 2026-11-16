// 给宽口径工具设置分数上限 cap，压掉它们对任意查询的过度泛化命中。
import fs from 'node:fs';
import { CATALOG } from './_paths.mjs';

const c = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));

const CAPS = {
  'tool/session_search': 0.50,
  'tool/mnemon_document_search': 0.50,
  'tool/mnemon_recall': 0.48,
  'tool/list_experts': 0.46,
  'tool/acp_status': 0.44,
  'tool/compress': 0.46,
  'mcp/embed-router': 0.50,
};

for (const [ref, cap] of Object.entries(CAPS)) {
  const t = c.tools[ref];
  if (!t) { console.log('SKIP', ref); continue; }
  t.cap = cap;
  t.updatedAt = new Date().toISOString();
  console.log(`CAP ${ref.padEnd(30)} = ${cap}`);
}
c.updatedAt = new Date().toISOString();
fs.writeFileSync(CATALOG, JSON.stringify(c, null, 2), 'utf8');
console.log('\n写回完成');
