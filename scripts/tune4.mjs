// Agent A 审核意见落地：read 场景补词 / document_search 降 cap / shell+edit+grep 补改配置场景
// / web_search 加 cap 0.65 / security-code-auditor 移除错位场景 / 单元测试场景按职责拆分
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
  'tool/read': {
    name: 'read', display: '读文件', kind: 'tool',
    traits: '按行读取本地 UTF-8 文本文件，带行号返回，支持 offset/limit 分页，大文件必须分页读',
    avoid: '查文件路径用 glob；按内容搜用 grep；不要用 shell 的 cat/head/tail',
    invoke: 'read({file_path, offset?, limit?})',
    paths: [['code', 'edit'], ['data', 'file']],
    floor: 0.44, cap: 0,
    scenes: [
      '要看清某个文件的实际内容',
      '改文件前先确认现状',
      '读配置、日志、源码片段',
      '把文件内容读出来看',
      '读某一行到某一行',
      '打开配置文件看内容',
      '读一下这个项目的 README 写的啥',
      '打开 README 或项目说明文件看看内容',
      '读取指定文件的内容',
      '看看这个文档里写了什么',
      '把那个源码文件打开读一遍',
      '看一眼这个日志文件里的内容',
    ],
  },
  'tool/mnemon_document_search': {
    name: 'mnemon_document_search', display: '项目文档检索', kind: 'tool',
    traits: '在项目级托管文档里做聚焦搜索，返回有界证据；与记忆空间是两套',
    avoid: '个人偏好用 recall；已知具体文件路径（如 README、配置或源码）直接读用 read',
    invoke: 'mnemon_document_search({query, limit})',
    paths: [['memory', 'doc']],
    floor: 0, cap: 0.61,
    scenes: [
      '查项目架构/约定/决策记录',
      '找以前写过的方案',
      '查这个项目的架构约定',
      '项目里以前写过的方案文档',
      '找项目的决策记录',
    ],
  },
  'tool/shell': {
    name: 'shell', display: '终端执行', kind: 'tool',
    traits: '在用户配置的默认终端里跑一条命令并回收 stdout/stderr，每次新进程不保留 cwd 与变量，需持久状态用 terminal_open；受 DSH 沙箱约束 万能命令行执行器：任何能用 shell 一条命令完成的事情都走它，包括批处理、管道、重定向、循环。',
    avoid: '要看文本文件内容用 read；要持久 shell 状态用 terminal_open；要交互 stdin 用 terminal',
    invoke: 'shell({command, description, workdir?, run_in_background?})',
    paths: [['code', 'build'], ['auto', 'system'], ['auto', 'remote']],
    floor: 0.47, cap: 0,
    scenes: [
      '跑构建/测试/安装依赖',
      '调用 node/python/curl 等 CLI',
      '批量文件操作',
      '取系统信息',
      '写个脚本批量处理文件',
      '批量重命名文件',
      '跑一条命令看输出',
      '命令行批处理',
      '执行系统命令',
      '定时跑脚本',
      '杀死卡死的进程',
      '装个依赖包',
      '调 git 命令',
      '看进程占了多少内存',
      '编译构建项目',
      '把一堆文件批量转换格式',
      '这台机器装了什么显卡',
      '看系统信息与环境变量',
      '查数据库里的记录',
      '看端口有没有被占用',
      '查磁盘还剩多少空间',
      '看网络通不通 ping 一下',
      '改一下环境变量',
      '装个 python 包',
      '跑一下这段代码看结果',
      '看这个目录占多大',
      '批量改文件权限',
      '起个 docker 容器',
      '把这个目录下所有 json 配置里的 timeout 值改大',
      '批量修改多个配置文件中的字段值',
      '一次性改掉一批文件里的同一个配置项',
      '扫描整个目录把某个字段统一替换',
      '用脚本批量改一批文件里的配置值',
      '跑 pytest 或单元测试看结果',
    ],
  },
  'tool/edit': {
    name: 'edit', display: '精确替换', kind: 'tool',
    traits: '按字面量替换文件中的一段文本，old_string 必须唯一匹配（否则报错），支持 replace_all',
    avoid: '大范围重写用 write；需要正则应走脚本',
    invoke: 'edit({file_path, old_string, new_string, replace_all?})',
    paths: [['code', 'edit']],
    floor: 0.42, cap: 0,
    scenes: [
      '改一行 schema',
      '替换一段配置值',
      '修正函数实现',
      '批量改同一处',
      '精确替换文件里的某段文字',
      '改一行代码',
      '定点修改配置值',
      '把某个单文件里的配置值精确改掉',
      '已知文件路径时直接改里面那几个字段',
      '给已有的测试文件补几行用例',
      '加单元测试用例',
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
      '先全目录搜出所有包含 timeout 的配置文件位置',
      '找出所有用到某个配置键的文件',
      '在改之前先定位这些字段出现在哪些文件',
    ],
  },
  'tool/write': {
    name: 'write', display: '写文件', kind: 'tool',
    traits: '整体创建或覆盖一个 UTF-8 文本文件，父目录自动建；覆盖已有文件前必须先 read 过它',
    avoid: '局部改动优先 edit；不确定原内容时不要直接覆盖',
    invoke: 'write({file_path, content})',
    paths: [['code', 'edit']],
    floor: 0.42, cap: 0,
    scenes: [
      '新建一个文件写入内容',
      '整体重写一个文件',
      '把生成的内容落盘',
      '写一份新的文档或配置',
      '新建一个测试文件',
      '把这段实现拆成新模块文件写出去',
    ],
  },
  'tool/web_search': {
    name: 'web_search', display: '网络搜索', kind: 'tool',
    traits: '一次最多 10 条查询，结果合并返回摘要与来源 URL 列表',
    avoid: '要正文用 web_fetch 跟进',
    invoke: 'web_search({queries:[...]})',
    paths: [['research', 'web'], ['net', 'http']],
    floor: 0.44, cap: 0.65,
    scenes: [
      '查最新信息',
      '找官方文档入口',
      '核实事实',
      '搜一下这个报错怎么解决',
      '查最新的公开信息',
      '找官方文档地址',
    ],
  },
  'skill/security-code-auditor': {
    name: 'security-code-auditor', display: '代码安全审计', kind: 'skill',
    traits: '源码级安全审计方法：污点跟踪、危险函数识别、鉴权缺口、注入面盘点',
    avoid: '黑盒打点用 Web 安全技能；写单元测试用 shell/edit',
    invoke: 'skill({name:"security-code-auditor"})',
    paths: [['sec', 'web'], ['code', 'debug']],
    floor: 0, cap: 0.62,
    scenes: [
      '审一段后端代码有没有洞',
      '上线前做安全检查',
      '检查代码质量',
      '审一遍这段代码有没有问题',
      '做一次代码审查',
    ],
  },
};

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tune4', version: '1' } });
for (const [ref, spec] of Object.entries(E)) {
  const r = await call('atlas_upsert', { ref, ...spec });
  console.log(ref, '->', JSON.stringify(r));
}
const re = await call('atlas_reindex', {});
console.log('reindex ->', JSON.stringify(re));
proc.stdin.end();
