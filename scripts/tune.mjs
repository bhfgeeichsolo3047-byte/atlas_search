// 检索质量调参靶场：给定 query 与期望工具，输出该工具的排名与三路分项分。
import { spawn } from 'node:child_process';
import { SERVER } from './_paths.mjs';

const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
let id = 0;
function rpc(method, params) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    const onData = (buf) => {
      for (const line of buf.toString().split('\n')) {
        const t = line.trim(); if (!t) continue;
        let m; try { m = JSON.parse(t); } catch { continue; }
        if (m.id === myId) { proc.stdout.off('data', onData); resolve(m); }
      }
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    setTimeout(() => { proc.stdout.off('data', onData); reject(new Error('timeout ' + method)); }, 120000);
  });
}

const CASES = [
  ['我想把一个安卓包脱壳看看里面逻辑', 'skill/deepseek-re'],
  ['帮我在这个目录里找有没有哪个文件提到 token 校验', 'tool/grep'],
  ['写个脚本批量重命名文件', 'tool/shell'],
  ['这台机器上有个进程卡死了要杀掉', 'tool/shell'],
  ['把这个大活拆给几个人分别做再汇总', 'tool/summon_experts'],
  ['给文章配一张封面图', 'tool/generate_image'],
  ['查一下最近关于这个病的论文', 'mcp/pubmed'],
  ['跑命令', 'tool/shell'],
  ['看看改完的代码有没有漏洞', 'skill/security-code-auditor'],
  ['连到那台测试机上去部署', 'tool/rw_connect'],
  ['把这段 js 混淆还原一下', 'skill/deepseek-re'],
  ['把上次聊的那个方案找出来', 'tool/session_search'],
  ['记住这个约定以后都这么干', 'tool/mnemon_remember'],
  ['批量下载这些网页存成文本', 'tool/web_fetch'],
  ['给我看一眼屏幕上现在是什么', 'tool/screen_view'],
  ['在这台电脑上点一下那个按钮', 'tool/desktop_control'],
  ['起一个长期跑的服务盯着看', 'tool/terminal_open'],
  ['把这个大文件读出来看第 100 行', 'tool/read'],
  ['搜一下这个报错怎么解决', 'tool/web_search'],
  ['把这个 skill 的内容读出来', 'tool/skill'],
];

await rpc('initialize', {});
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

let pass1 = 0, pass3 = 0, pass5 = 0;
const fails = [];
for (const [q, want] of CASES) {
  const r = await rpc('tools/call', { name: 'atlas_search', arguments: { query: q, topK: 30 } });
  const j = JSON.parse(r.result.content[0].text);
  const top = j.top || [];
  const rank = top.findIndex((t) => t.ref === want);
  const hit = top[rank];
  if (rank === 0) pass1++;
  if (rank >= 0 && rank < 3) pass3++;
  if (rank >= 0 && rank < 5) pass5++;
  const mark = rank === 0 ? 'OK ' : rank < 3 ? 'ok ' : rank < 5 ? '... ' : 'BAD';
  console.log(`${mark} rank=${rank < 0 ? 'X' : rank + 1}  want=${want.padEnd(32)} ${hit ? 'total=' + hit.score + ' ' + JSON.stringify(hit.detail) : ''}`);
  console.log(`     q: ${q}`);
  if (rank !== 0) {
    console.log(`     top1: ${top[0]?.ref} (${top[0]?.score})  top2: ${top[1]?.ref} (${top[1]?.score})  top3: ${top[2]?.ref} (${top[2]?.score})`);
    fails.push([q, want, rank, top.slice(0, 3).map((t) => t.ref)]);
  }
}
console.log(`\n===== 总计 ${CASES.length} 条：top1 ${pass1} / top3 ${pass3} / top5 ${pass5} =====`);
proc.stdin.end();
setTimeout(() => { try { proc.kill(); } catch {} process.exit(0); }, 800);
