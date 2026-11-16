// 第三轮：cap 抬高（0.60 太狠把 session_search 打到 rank 9），补 summon_expert 场景。
import fs from 'node:fs';
import { CATALOG } from './_paths.mjs';

const c = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));

// cap 目的只是拦住「对任何查询都 0.7+」的极端泛化，不该拦自己本该命中的场景。
const CAPS = {
  'tool/session_search': 0.70,
  'tool/mnemon_document_search': 0.68,
  'tool/mnemon_recall': 0.66,
  'tool/list_experts': 0.64,
  'tool/acp_status': 0.58,
  'tool/compress': 0.60,
  'mcp/embed-router': 0.64,
  'tool/todo_write': 0.60,
  'tool/subagent_fork': 0.66,
  'tool/subagent': 0.66,
  'tool/agent_teams_status': 0.62,
};
for (const [ref, cap] of Object.entries(CAPS)) {
  const t = c.tools[ref];
  if (!t) { console.log('SKIP', ref); continue; }
  t.cap = cap;
  t.updatedAt = new Date().toISOString();
  console.log(`CAP ${ref.padEnd(30)} = ${cap}`);
}

// summon_expert 只有 2 条场景，太窄 —— "找个代码审查专家" 命不中。
const SCENES = {
  'tool/summon_expert': [
    '找个代码审查专家看看这段实现', '让某个领域的专家来把关', '需要特定角色视角复核',
    '这段代码帮我找行家审一下', '叫一个安全审计专家看这个模块',
    '把某块专业工作整体交出去', '这个活找个对口的专家来做',
  ],
  'tool/summon_experts': [
    '这几块并行分工给几个专家做', '同时叫几个不同领域的专家', '多领域并行审一遍',
  ],
  'tool/session_search': [
    '把上次聊的那个方案找出来', '找以前会话里说过的结论',
  ],
};
for (const [ref, scenes] of Object.entries(SCENES)) {
  const t = c.tools[ref];
  if (!t) { console.log('SKIP', ref); continue; }
  const cur = Array.isArray(t.scenes) ? t.scenes.slice() : [];
  for (const s of scenes) if (!cur.includes(s)) cur.push(s);
  t.scenes = cur;
  t.updatedAt = new Date().toISOString();
  console.log(`SCENES ${ref.padEnd(30)} -> ${cur.length}`);
}

// security-code-auditor 现在抢了 summon_expert 的位置（它是技能不是工具），给它个 cap 别抢
const sc = c.tools['skill/security-code-auditor'];
if (sc) { sc.cap = 0.62; console.log('CAP skill/security-code-auditor    = 0.62'); }

c.updatedAt = new Date().toISOString();
fs.writeFileSync(CATALOG, JSON.stringify(c, null, 2), 'utf8');
console.log('\n写回完成');
