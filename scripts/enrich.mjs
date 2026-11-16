// 数据增强：给召回弱的条目补场景词与特点，之后由 atlas_reindex 重算向量。
// 只追加不覆盖（去重），避免破坏已播种内容。
import fs from 'node:fs';
import { CATALOG } from './_paths.mjs';

const c = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));

// ref -> { scenes?: [...], traits?: '...附加' }
const PATCH = {
  'tool/shell': {
    scenes: [
      '写个脚本批量处理文件', '批量重命名文件', '跑一条命令看输出', '命令行批处理',
      '执行系统命令', '定时跑脚本', '杀死卡死的进程', '装个依赖包', '调 git 命令',
      '看进程占了多少内存', '编译构建项目', '把一堆文件批量转换格式',
    ],
    traits: ' 万能命令行执行器：任何能用 shell 一条命令完成的事情都走它，包括批处理、管道、重定向、循环。',
  },
  'tool/terminal_open': {
    scenes: ['起个长期跑的服务盯着输出', '需要保持会话状态的交互式命令行', '进 REPL 或 ssh 里连续操作'],
  },
  'mcp/pubmed': {
    scenes: [
      '查某个病的研究进展', '找某药物的临床试验论文', '搜医学文献', '要论文的标准引用格式',
      '这个症状有什么最新研究', 'PubMed 上有没有相关文章', '查期刊论文的影响因子与被引',
    ],
    traits: ' 覆盖 PubMed / PMC / Europe PMC，找医学、疾病、药物、临床试验、生信方向的论文与全文时首选。',
  },
  'mcp/openalex': {
    scenes: ['查某个领域的整体研究趋势', '找某位学者的全部论文', '某个机构发表了什么', '跨学科文献统计与引用关系'],
  },
  'skill/deepseek-re': {
    scenes: [
      '把安卓包脱壳看逻辑', 'APK 反编译', 'js 代码混淆还原', '反混淆还原可读代码',
      '判断这段二进制在干什么', '逆向总流程该走哪几步', '选哪个逆向工具',
    ],
    traits: ' 逆向工程总纲：先判断文件类型与语言，再决定走静态反编译、动态调试、脱壳还是补丁，通吃 APK/JS/ELF/PE。',
  },
  'skill/elf-local-auth-patcher': {
    scenes: ['APK 或 ELF 的授权校验打补丁', '绕过注册码校验', '改二进制里的判断跳转'],
  },
  'mcp/craft-anything': {
    scenes: ['把安卓包拆开看它引用了哪些库', '反汇编一个可执行文件', '看安装包里都有什么文件'],
  },
  'tool/web_fetch': {
    scenes: ['抓一个网页正文存下来', '批量下载页面转文本', '取某个 URL 的完整内容'],
  },
  'tool/grep': {
    scenes: ['在目录里搜哪个文件提到了某个字符串', '按内容找代码', '正则搜文本'],
  },
  'tool/glob': {
    scenes: ['按文件名或路径模式找文件', '列出目录下所有某类文件'],
  },
  'tool/read': {
    scenes: ['把文件内容读出来看', '读某一行到某一行', '打开配置文件看内容'],
  },
  'tool/edit': {
    scenes: ['精确替换文件里的某段文字', '改一行代码', '定点修改配置值'],
  },
  'tool/write': {
    scenes: ['新建一个文件写入内容', '整份覆盖写文件'],
  },
  'tool/screen_view': {
    scenes: ['看一眼屏幕上现在是什么', '截图看当前界面', '确认操作后的画面结果'],
  },
  'tool/desktop_control': {
    scenes: ['在这台电脑上点一下按钮', '模拟键盘输入', '操作桌面上的窗口'],
  },
  'tool/rw_connect': {
    scenes: ['连到那台测试机上去部署', 'ssh 到远端服务器干活', '连远程机器改文件'],
  },
  'tool/session_search': {
    scenes: ['把上次聊过的方案找出来', '翻以前会话里说过的结论', '回忆之前定过的做法'],
  },
  'tool/web_search': {
    scenes: ['搜一下这个报错怎么解决', '查最新的公开信息', '找官方文档地址'],
  },
  'tool/workflow': {
    scenes: ['把一堆文件并行处理一遍', '批量任务编排脚本', '一次派很多个子任务出去'],
  },
};

let touched = 0;
for (const [ref, patch] of Object.entries(PATCH)) {
  const t = c.tools[ref];
  if (!t) { console.log('SKIP 不存在:', ref); continue; }
  const before = (t.scenes || []).length;
  const scenes = Array.isArray(t.scenes) ? t.scenes.slice() : (t.scenes ? [t.scenes] : []);
  for (const s of patch.scenes || []) if (!scenes.includes(s)) scenes.push(s);
  t.scenes = scenes;
  if (patch.traits && !String(t.traits || '').includes(patch.traits.trim().slice(0, 8))) {
    t.traits = String(t.traits || '') + patch.traits;
  }
  t.updatedAt = new Date().toISOString();
  touched++;
  console.log(`PATCH ${ref}  scenes ${before} -> ${scenes.length}`);
}
c.updatedAt = new Date().toISOString();
fs.writeFileSync(CATALOG, JSON.stringify(c, null, 2), 'utf8');
console.log(`\n已增强 ${touched} 条，写回 ${CATALOG}`);
