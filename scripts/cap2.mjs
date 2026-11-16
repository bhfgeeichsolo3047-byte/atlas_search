// cap 校准 + 宽口径工具补充具体场景（收紧语义边界）。
import fs from 'node:fs';
import { CATALOG } from './_paths.mjs';

const c = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));

// cap 只压掉「极端越界」（0.60 以上乱窜），不再粗暴截到 0.50
const CAPS = {
  'tool/session_search': 0.60,
  'tool/mnemon_document_search': 0.58,
  'tool/mnemon_recall': 0.55,
  'tool/list_experts': 0.55,
  'tool/acp_status': 0.50,
  'tool/compress': 0.52,
  'mcp/embed-router': 0.56,
  'tool/todo_write': 0.52,
};
for (const [ref, cap] of Object.entries(CAPS)) {
  const t = c.tools[ref];
  if (!t) { console.log('SKIP', ref); continue; }
  t.cap = cap;
  t.updatedAt = new Date().toISOString();
  console.log(`CAP ${ref.padEnd(30)} = ${cap}`);
}

// 宽口径工具补/替换场景：加具体表述，替掉过于空泛的
const SCENES = {
  'tool/session_search': [
    '把上次聊的那个方案找出来', '刚才那个报错的栈追踪是啥意思', '以前遇到过同样的坑怎么解决的',
    '翻一下之前会话里定过的做法', '回忆上次改这个文件的原因', '找历史对话里的结论',
  ],
  'tool/mnemon_document_search': [
    '查这个项目的架构约定', '项目里以前写过的方案文档', '找项目的决策记录',
  ],
  'tool/mnemon_recall': [
    '我以前是不是定过这个偏好', '接着旧项目干活需要上下文', '找回以前记下的事实',
  ],
  'tool/list_experts': [
    '有没有对口的专家可以叫', '花名册里都有谁', '某个来源包有哪些专家',
  ],
  'tool/todo_write': [
    '把任务拆成几步列出来', '记一下待办清单', '跟踪多步进度',
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

c.updatedAt = new Date().toISOString();
fs.writeFileSync(CATALOG, JSON.stringify(c, null, 2), 'utf8');
console.log('\n写回完成');
