// 查看指定条目的 traits/scenes/avoid，便于诊断噪声。
import fs from 'node:fs';
import { CATALOG } from './_paths.mjs';

const c = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
const refs = process.argv.slice(2);
const list = refs.length ? refs : Object.keys(c.tools);
for (const ref of list) {
  const t = c.tools[ref];
  if (!t) { console.log('MISSING', ref); continue; }
  console.log(`\n===== ${ref} =====`);
  console.log(`display: ${t.display}  kind: ${t.kind}  floor: ${t.floor ?? 0}`);
  console.log(`traits : ${t.traits}`);
  console.log(`scenes : ${(t.scenes || []).join(' ／ ')}`);
  console.log(`avoid  : ${t.avoid}`);
  console.log(`paths  : ${(t.categories || []).map(([a, b]) => a + '/' + b).join(', ')}`);
}
