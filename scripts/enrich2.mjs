// 第二轮数据增强：补齐「通用系统操作」类场景，压掉检索噪声工具的过度泛化场景。
import fs from 'node:fs';
import { CATALOG } from './_paths.mjs';

const c = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));

const ADD_SCENES = {
  'tool/shell': [
    '这台机器装了什么显卡', '看系统信息与环境变量', '查数据库里的记录', '看端口有没有被占用',
    '查磁盘还剩多少空间', '看网络通不通 ping 一下', '改一下环境变量', '装个 python 包',
    '跑一下这段代码看结果', '看这个目录占多大', '批量改文件权限', '起个 docker 容器',
  ],
  'mcp/pubmed': [
    '这个病有什么治疗方法', '某种疾病的临床研究', '药物疗效的论文', '查一下这个症状的文献',
    '医学论文检索', '临床试验结果', '查 PMID',
  ],
  'mcp/openalex': [
    '这个研究方向近年趋势', '某学者发表过什么', '跨学科文献计量', '查 DOI 与引用数',
  ],
  'tool/write': [
    '把这几份文档合成一份', '把内容保存成文件', '生成一份报告写进文件', '导出结果到文件',
  ],
  'skill/security-code-auditor': [
    '给这几个函数写单元测试', '检查代码质量', '审一遍这段代码有没有问题', '做一次代码审查',
  ],
  'tool/terminal_open': [
    '需要一直开着的交互式会话', '在终端里连续敲命令',
  ],
};

// 噪声工具：收窄过度泛化的场景
const TRIM_SCENES = {
  'tool/list_experts': ['查一下最近关于这个病的论文', '找论文', '查文献', '搜索资料', '查最近的研究'],
  'tool/mnemon_document_search': ['查论文', '查文献', '搜索最新资讯', '查这个病'],
  'tool/session_search': ['查论文', '查文献', '搜最新信息'],
};

let n = 0;
for (const [ref, scenes] of Object.entries(ADD_SCENES)) {
  const t = c.tools[ref];
  if (!t) { console.log('SKIP', ref); continue; }
  const cur = Array.isArray(t.scenes) ? t.scenes.slice() : (t.scenes ? [t.scenes] : []);
  let added = 0;
  for (const s of scenes) if (!cur.includes(s)) { cur.push(s); added++; }
  t.scenes = cur;
  t.updatedAt = new Date().toISOString();
  n++;
  console.log(`ADD  ${ref.padEnd(32)} +${added}  -> ${cur.length}`);
}
for (const [ref, drop] of Object.entries(TRIM_SCENES)) {
  const t = c.tools[ref];
  if (!t) { console.log('SKIP', ref); continue; }
  const cur = Array.isArray(t.scenes) ? t.scenes.slice() : [];
  const before = cur.length;
  t.scenes = cur.filter((s) => !drop.includes(s));
  t.updatedAt = new Date().toISOString();
  console.log(`TRIM ${ref.padEnd(32)} ${before} -> ${t.scenes.length}`);
}
c.updatedAt = new Date().toISOString();
fs.writeFileSync(CATALOG, JSON.stringify(c, null, 2), 'utf8');
console.log(`\n增强 ${n} 条，写回 ${CATALOG}`);
