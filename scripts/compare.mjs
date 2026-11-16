// 对比加权 vs max 两种打分模式在本轮改动后的成绩。
import { spawn } from 'node:child_process';
import { SERVER } from './_paths.mjs';

const CASES = [
  ['skill/deepseek-re', '我想把一个安卓包脱壳看看里面逻辑'],
  ['tool/grep', '帮我在这个目录里找有没有哪个文件提到 token 校验'],
  ['tool/shell', '写个脚本批量重命名文件'],
  ['tool/shell', '这台机器上有个进程卡死了要杀掉'],
  ['tool/session_search', '把上次聊的那个方案找出来'],
  ['tool/write', '把这三份文档合成一份'],
  ['tool/session_search', '刚才那个报错的栈追踪是啥意思'],
  ['tool/shell', '帮我看看数据库里这条记录'],
  ['tool/shell', '这台机器装了什么显卡'],
  ['tool/shell', '查一下哪个进程占用了 8080 端口'],
  ['tool/read', '打开这个配置文件看看里面写了什么'],
  ['tool/edit', '把这几处变量名统一改一下'],
  ['tool/glob', '找一下项目里所有 yml 文件'],
  ['tool/web_search', '搜一下这个报错是什么原因'],
  ['tool/web_fetch', '把这个网页的正文抓下来'],
  ['mcp/pubmed', '查一下这个病的临床试验进展'],
  ['mcp/openalex', '找这个方向高被引的论文'],
  ['tool/generate_image', '画一张赛博朋克风格的城市夜景'],
  ['tool/edit_image', '把这张图里的背景换掉'],
  ['tool/render_ui', '给这几项数据做个对比面板'],
  ['tool/desktop_control', '帮我在桌面上点开那个窗口'],
  ['tool/rw_connect', '连到那台远程服务器上操作'],
  ['tool/summon_expert', '找个代码审查专家看看这段实现'],
  ['tool/summon_experts', '这几块并行分工给几个专家做'],
  ['tool/workflow', '对几百个文件跑同一套检查'],
];

function run(mode) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ATLAS_SCORE_MODE: mode },
    });
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
        let m; try { m = JSON.parse(line); } catch { continue; }
        const cb = pending.get(m.id);
        if (cb) { pending.delete(m.id); cb(m); }
      }
    });
    function rpc(method, params) {
      const myId = ++id;
      return new Promise((res, rej) => {
        pending.set(myId, res);
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
        setTimeout(() => { if (pending.delete(myId)) rej(new Error('timeout ' + method)); }, 180000);
      });
    }
    (async () => {
      await rpc('initialize', {});
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const rows = [];
      let hit1 = 0, hit3 = 0, hit5 = 0;
      for (const [want, q] of CASES) {
        const r = await rpc('tools/call', { name: 'atlas_search', arguments: { query: q, topK: 10 } });
        const j = JSON.parse(r.result.content[0].text);
        const refs = (j.top || []).map((t) => t.ref);
        const rank = refs.indexOf(want) + 1;
        if (rank === 1) hit1++;
        if (rank >= 1 && rank <= 3) hit3++;
        if (rank >= 1 && rank <= 5) hit5++;
        rows.push({ want, q, rank, top: refs.slice(0, 3) });
      }
      proc.stdin.end();
      setTimeout(() => { try { proc.kill(); } catch {} }, 300);
      resolve({ mode, hit1, hit3, hit5, total: CASES.length, rows });
    })();
  });
}

const w = await run('weighted');
const m = await run('max');
for (const r of [w, m]) {
  console.log(`\n===== ${r.mode}: top1 ${r.hit1}/${r.total}  top3 ${r.hit3}/${r.total}  top5 ${r.hit5}/${r.total} =====`);
  for (const x of r.rows) {
    const mark = x.rank === 1 ? '✓' : (x.rank >= 1 && x.rank <= 5 ? '·' : '✗');
    console.log(`  ${mark} rank=${String(x.rank).padEnd(3)} ${x.want.padEnd(26)} q="${x.q}"  top: ${x.top.join(' / ')}`);
  }
}
