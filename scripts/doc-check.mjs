#!/usr/bin/env node
/**
 * doc-check.mjs —— README 与 catalog.json / vectors.json 的一致性校验 + 快照块生成
 *
 * 用法：
 *   node doc-check.mjs            # 只校验，漂移则 exit 1
 *   node doc-check.mjs --write    # 从 catalog.json / vectors.json 重新渲染快照块写入 README，然后校验
 *
 * 设计：README 里有一段被 AUTOGEN:ATLAS_SNAPSHOT_START / END 包裹的区块，
 *       该区块是"唯一事实源"（catalog.json + vectors.json）的投影，禁止手改。
 *       任何时候跑过 tune*.mjs / atlas_upsert / atlas_reindex 之后忘同步文档，
 *       跑一次本脚本就会立刻报错拦截。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(DIR, 'catalog.json');
const VECTORS = path.join(DIR, 'vectors.json');
const README = path.join(DIR, 'README.md');

const START = '<!-- AUTOGEN:ATLAS_SNAPSHOT_START -->';
const END = '<!-- AUTOGEN:ATLAS_SNAPSHOT_END -->';

// 重点调整过的工具：其 scenes 条数是调优结论的一部分，必须与文档一致
const KEY_REFS = [
  'tool/shell',
  'tool/read',
  'tool/write',
  'tool/edit',
  'tool/grep',
  'tool/web_search',
  'skill/security-code-auditor',
  'tool/mnemon_document_search',
];

// 散文里必须出现的定论字符串（这些数字人工核定后写死，改动时要同步）
// 匹配前会把正文里的反引号去掉，所以这里不用写 `tool` 的引号形式
const PROSE_ASSERTIONS = [
  'top1 24/25',
  'top3 25/25',
  'top1 22/25',
  'session_search 第 1',
  'shell 第 2',
  'grep 第 3',
];

const loadJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// vectors.json 不入库（可由 reindex 完全重建），全新 clone 里可能不存在。
// 缺失时向量数记为 null，快照块里渲染成「待 reindex」，校验阶段跳过对应断言。
const loadVectors = () => {
  if (!fs.existsSync(VECTORS)) return null;
  try { return loadJson(VECTORS); } catch { return null; }
};

function collect() {
  const cat = loadJson(CATALOG);
  const vec = loadVectors();
  const tools = cat.tools || {};
  let subs = 0;
  for (const c of cat.categories || []) subs += (c.subs || []).length;

  const floors = [];
  const caps = [];
  for (const [ref, t] of Object.entries(tools)) {
    if (Number(t.floor) > 0) floors.push([ref, Number(t.floor)]);
    if (Number(t.cap) > 0) caps.push([ref, Number(t.cap)]);
  }
  const cmp = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]);
  floors.sort(cmp);
  caps.sort(cmp);

  const keyScenes = KEY_REFS.map((ref) => [ref, tools[ref] ? (tools[ref].scenes || []).length : -1]);

  return {
    categories: (cat.categories || []).length,
    subs,
    tools: Object.keys(tools).length,
    vectors: vec ? Object.keys(vec).length : null,
    floors,
    caps,
    keyScenes,
  };
}

function renderSnapshot(s) {
  const L = [];
  L.push(START);
  L.push('<!-- 本区块由 doc-check.mjs --write 从 catalog.json / vectors.json 自动生成，请勿手改。 -->');
  L.push('');
  L.push('### 当前调控参数与规模快照');
  L.push('');
  L.push(
    `目录规模：**${s.categories} 个总分类 / ${s.subs} 个子分类 / ${s.tools} 条工具 / ${s.vectors == null ? '向量待 reindex' : s.vectors + ' 条向量'}**`
  );
  L.push('');
  L.push(`\`floor\`（通用兜底下限，共 ${s.floors.length} 条）：`);
  L.push('');
  L.push('| 工具 | floor |');
  L.push('|---|---|');
  for (const [ref, v] of s.floors) L.push(`| \`${ref}\` | ${v} |`);
  L.push('');
  L.push(`\`cap\`（宽口径封顶，共 ${s.caps.length} 条）：`);
  L.push('');
  L.push('| 工具 | cap |');
  L.push('|---|---|');
  for (const [ref, v] of s.caps) L.push(`| \`${ref}\` | ${v} |`);
  L.push('');
  L.push('重点调整过的 `scenes` 条数：');
  L.push('');
  L.push('| 工具 | scenes |');
  L.push('|---|---|');
  for (const [ref, n] of s.keyScenes) L.push(`| \`${ref}\` | ${n < 0 ? '缺失' : n} |`);
  L.push(END);
  return L.join('\n');
}

function replaceBlock(text, block) {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 || b < 0 || b < a) {
    // 标记缺失：追加到文件末尾
    return text.replace(/\s*$/, '') + '\n\n' + block + '\n';
  }
  return text.slice(0, a) + block + text.slice(b + END.length);
}

function extractBlock(text) {
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 || b < 0 || b < a) return null;
  return text.slice(a, b + END.length);
}

function main() {
  const write = process.argv.includes('--write');
  if (!fs.existsSync(README)) {
    console.error(`FAIL 找不到 ${README}`);
    process.exit(1);
  }
  const s = collect();
  const expect = renderSnapshot(s);

  let text = fs.readFileSync(README, 'utf8');
  if (write) {
    const next = replaceBlock(text, expect);
    if (next !== text) {
      fs.writeFileSync(README, next, 'utf8');
      console.log('WROTE 快照块已重新生成写入 README.md');
      text = next;
    } else {
      console.log('SKIP  快照块已是最新，无需写入');
    }
  }

  const problems = [];

  // 1) 快照块存在且与磁盘事实一致
  const got = extractBlock(text);
  if (!got) {
    problems.push('README 缺少 AUTOGEN 快照块（ATLAS_SNAPSHOT_START / END 标记）');
  } else if (got !== expect) {
    problems.push('README 快照块与 catalog.json / vectors.json 不一致（跑 node doc-check.mjs --write 修正）');
  }

  // 2) 规模数字出现在正文中
  //    注意：必须在「快照块之外」的散文里查。快照块由本脚本自动生成，
  //    它自己就含这些数字；若在全文里查，散文写成旧数字也永远能通过，等于没校验。
  const outside = got ? (text.slice(0, text.indexOf(START)) + text.slice(text.indexOf(END) + END.length)) : text;
  const must = [
    `${s.categories} 个总分类`,
    `${s.subs} 个子分类`,
    `${s.tools} 条工具`,
  ];
  if (s.vectors != null) must.push(`${s.vectors} 条向量`);
  for (const m of must) {
    if (!outside.includes(m)) problems.push(`README 正文缺少「${m}」`);
  }

  // 3) 定论字符串（比对时去掉反引号，让 `shell` 与 shell 等价）
  const stripped = outside.replace(/`/g, '');
  for (const m of PROSE_ASSERTIONS) {
    if (!stripped.includes(m)) problems.push(`README 正文缺少定论「${m}」`);
  }

  // 4) 禁止出现过期的硬编码（历史上踩过的坑）
  const forbidden = [
    ['520 行', 'server.mjs 行数不应硬编码'],
    ['425 条', 'vectors 旧总数'],
    ['467 条向量', 'vectors 旧总数'],
    ['top1 23/25、top3 25/25、top5 25/25', 'max 模式旧跑分'],
    ['mnemon_document_search）', 'cap 旧举例把 document_search 当宽口径首位'],
    ['floor: 0.45', '示例 floor 旧值'],
    ['cap: 0.60      // 可选：宽口径封顶', '示例 cap 旧值'],
  ];
  for (const [needle, why] of forbidden) {
    if (outside.includes(needle)) problems.push(`README 残留过期内容「${needle}」（${why}）`);
  }

  if (problems.length) {
    console.error('FAIL 文档一致性校验未通过：');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }

  console.log('PASS 文档一致性校验通过');
  console.log(
    `  规模: ${s.categories} 分类 / ${s.subs} 子分类 / ${s.tools} 工具 / ${s.vectors == null ? '向量待 reindex' : s.vectors + ' 向量'}`
  );
  console.log(`  floor: ${s.floors.length} 条   cap: ${s.caps.length} 条   重点 scenes: ${s.keyScenes.length} 条`);
  console.log('  ' + s.floors.map(([r, v]) => `${r}=${v}`).join('  '));
  console.log('  ' + s.caps.map(([r, v]) => `${r}=${v}`).join('  '));
  console.log('  ' + s.keyScenes.map(([r, n]) => `${r}=${n}`).join('  '));
}

main();
