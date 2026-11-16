#!/usr/bin/env node
// test-config.mjs —— 配置层 / 思考强度 / 禁用清单 / 回退模式的端到端自测
//
// 做法：起一个本地 mock 向量服务（GET /models + POST /embeddings），
// 把 server.mjs 当真的 MCP 子进程拉起来（临时 ATLAS_DIR），走 JSON-RPC 逐条断言。
// 覆盖：配置脱敏、/models 的 embedding 识别、禁用过滤、四档思考强度差异、
//       useLlmFallback 绝不发 embedding 请求、config.json 改完热加载生效。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server.mjs');

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); return; }
  fails.push(name);
  console.log('FAIL  ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 400)));
}

// ---------------- mock 向量服务 ----------------
const calls = { models: 0, embeddings: 0 };
function fakeVec(text) {
  const v = new Array(8).fill(0);
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) v[i % 8] += (s.charCodeAt(i) % 31) / 31;
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => +(x / n).toFixed(6));
}
const mock = http.createServer((req, res) => {
  const json = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  if (req.method === 'GET' && req.url === '/v1/models') {
    calls.models++;
    json(200, { data: [
      { id: 'bge-m3', type: 'embedding' },
      { id: 'Qwen/Qwen3-Embedding-4B', type: 'embedding' },
      { id: 'BAAI/bge-reranker-v2-m3', type: 'rerank' },
      { id: 'Qwen/Qwen2.5-7B-Instruct', type: 'text' },
      { id: 'vendor/unknown-embedding-x' },
    ] });
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/embeddings') {
    calls.embeddings++;
    let buf = '';
    req.on('data', (d) => { buf += d; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(buf); } catch (e) { body = {}; }
      const input = Array.isArray(body.input) ? body.input : [body.input];
      json(200, { data: input.map((t, i) => ({ index: i, embedding: fakeVec(t) })) });
    });
    return;
  }
  json(404, { error: 'not found' });
});
const listen = () => new Promise((r) => mock.listen(0, '127.0.0.1', () => r(mock.address().port)));

// ---------------- 临时目录 + 最小目录 ----------------
function makeAtlasDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-test-'));
  const catalog = {
    version: 1,
    updatedAt: new Date().toISOString(),
    categories: [
      { id: 'term', name: '终端与文件', desc: '命令、读写、检索', subs: [
        { id: 'exec', name: '执行命令', desc: '跑 shell', tools: ['tool/shell', 'tool/grep', 'skill/apk-unpack'] },
      ] },
    ],
    tools: {
      'tool/shell': {
        ref: 'tool/shell', name: 'shell', display: '终端执行', kind: 'tool',
        traits: '执行 bash 命令，返回 stdout/stderr',
        scenes: ['跑构建', '执行脚本', '看目录', '装依赖'],
        avoid: '需要交互式输入时改用 terminal',
        invoke: 'shell({command, description})',
        floor: 0.47, cap: 0, categories: [['term', 'exec']], updatedAt: '',
      },
      'tool/grep': {
        ref: 'tool/grep', name: 'grep', display: '内容检索', kind: 'tool',
        traits: '在文件内容里按正则搜索',
        scenes: ['找函数定义', '找报错来源', '找配置项'],
        avoid: '只找文件名时用 glob',
        invoke: 'grep({pattern, path})',
        floor: 0, cap: 0, categories: [['term', 'exec']], updatedAt: '',
      },
      'skill/apk-unpack': {
        ref: 'skill/apk-unpack', name: 'apk-unpack', display: 'APK 脱壳', kind: 'skill',
        traits: '识别加固方案并脱壳',
        scenes: ['classes.dex 异常小', 'assets 有加密载荷'],
        avoid: '非 Android 样本时别用',
        invoke: '/apk-unpack',
        floor: 0, cap: 0.7, categories: [['term', 'exec']], updatedAt: '',
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(catalog, null, 2));
  return dir;
}
function writeCfg(dir, obj) {
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  const t = new Date(Date.now() + 5);
  fs.utimesSync(p, t, t);
}

// ---------------- MCP 子进程客户端 ----------------
function startServer(dir, port) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      ATLAS_DIR: dir,
      ATLAS_CONFIG: path.join(dir, 'config.json'),
      EMBED_BASE_URL: 'http://127.0.0.1:' + port + '/v1',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  child.stderr.on('data', () => {});
  let seq = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + method)), 30000);
    waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params }) + '\n');
  });
  const call = async (name, args) => {
    const msg = await rpc('tools/call', { name: name, arguments: args || {} });
    if (msg.error) throw new Error(msg.error.message);
    const content = (msg.result && msg.result.content) || [];
    const text = content[0] && content[0].text;
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { parsed = text; }
    return { parsed: parsed, isError: !!(msg.result && msg.result.isError) };
  };
  return { child: child, rpc: rpc, call: call, stop: () => child.kill() };
}

async function main() {
  const port = await listen();
  const dir = makeAtlasDir();
  writeCfg(dir, {
    embedding: { baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: 'test-key-should-never-leak', model: 'bge-m3' },
    reasoningEffort: 'high',
    useLlmFallback: false,
    disabled: { skills: [], tools: [] },
    hideDisabledInBrowse: false,
  });
  const s = startServer(dir, port);
  try {
    const init = await s.rpc('initialize', {});
    ok('initialize 返回 serverInfo', !!(init.result && init.result.serverInfo && init.result.serverInfo.name === 'dsh-tool-atlas'), init.result);

    const list = await s.rpc('tools/list', {});
    const names = ((list.result && list.result.tools) || []).map((t) => t.name);
    ok('tools/list 含 atlas_config', names.includes('atlas_config'), names);
    ok('tools/list 含 atlas_models', names.includes('atlas_models'), names);
    const old = ['atlas_search', 'atlas_browse', 'atlas_detail', 'atlas_upsert', 'atlas_link', 'atlas_stats', 'atlas_reindex', 'atlas_discover', 'atlas_propose', 'atlas_commit', 'atlas_ignore'];
    ok('原有 11 个工具仍在', old.every((n) => names.includes(n)), names);

    // 1) 配置读取 + 脱敏
    const got = await s.call('atlas_config', { action: 'get' });
    const raw = JSON.stringify(got.parsed);
    ok('atlas_config get 回吐配置', !!(got.parsed && got.parsed.config && got.parsed.config.reasoningEffort === 'high'), got.parsed);
    ok('atlas_config get 不泄露 apiKey 明文', !raw.includes('test-key-should-never-leak') && got.parsed.config.embedding.apiKey.includes('***'), got.parsed.config.embedding);
    ok('atlas_config get 报出 apiKey 来源', got.parsed.config.embedding.apiKeySource === 'config.json', got.parsed.config.embedding);

    // 2) /models 识别
    const mo = await s.call('atlas_models', {});
    const embIds = (mo.parsed && mo.parsed.embeddingModels) || [];
    ok('atlas_models 拉到全部模型', mo.parsed && mo.parsed.total === 5, mo.parsed);
    ok('atlas_models 识别 embedding（含无元数据靠 id 正则）', embIds.includes('bge-m3') && embIds.includes('Qwen/Qwen3-Embedding-4B') && embIds.includes('vendor/unknown-embedding-x'), embIds);
    ok('atlas_models 排除 rerank', !embIds.includes('BAAI/bge-reranker-v2-m3'), embIds);
    ok('atlas_models 排除普通对话模型', !embIds.includes('Qwen/Qwen2.5-7B-Instruct'), embIds);

    // 3) 向量检索（high）
    const hi = await s.call('atlas_search', { query: '执行 bash 命令跑构建', topK: 5 });
    ok('high 档走向量模式', hi.parsed.mode === 'vector', hi.parsed.mode);
    ok('high 档回吐 reasoningEffort', hi.parsed.reasoningEffort === 'high', hi.parsed.reasoningEffort);
    ok('high 档有候选', Array.isArray(hi.parsed.top) && hi.parsed.top.length >= 2, hi.parsed.top && hi.parsed.top.length);
    ok('high 档回吐 scoreBreakdown（detail.lexMatch）', !!(hi.parsed.top[0] && hi.parsed.top[0].detail && 'lexMatch' in hi.parsed.top[0].detail), hi.parsed.top[0] && hi.parsed.top[0].detail);
    ok('high 档回吐 pathLabels', !!(hi.parsed.top[0] && Array.isArray(hi.parsed.top[0].pathLabels)), hi.parsed.top[0] && hi.parsed.top[0].pathLabels);
    ok('high 档匹配路径非空', Array.isArray(hi.parsed.matchedPaths) && hi.parsed.matchedPaths.length > 0, hi.parsed.matchedPaths);

    // 4) 思考强度热加载
    await s.call('atlas_config', { action: 'set', reasoningEffort: 'low' });
    const lo = await s.call('atlas_search', { query: '执行 bash 命令跑构建', topK: 5 });
    ok('low 档热加载生效', lo.parsed.reasoningEffort === 'low', lo.parsed.reasoningEffort);
    const loShell = (lo.parsed.top || []).find((t) => t.ref === 'tool/shell');
    ok('low 档 scenes 裁到 2 条', !!(loShell && loShell.scenes.length <= 2 && loShell.scenesTruncated === true), loShell && { n: loShell.scenes.length, t: loShell.scenesTruncated });
    ok('low 档不给 scoreBreakdown', !!(lo.parsed.top[0] && !('lexMatch' in (lo.parsed.top[0].detail || {}))), lo.parsed.top[0] && lo.parsed.top[0].detail);
    ok('low 档不给 pathLabels', !!(lo.parsed.top[0] && !('pathLabels' in lo.parsed.top[0])), lo.parsed.top[0] && Object.keys(lo.parsed.top[0]));

    await s.call('atlas_config', { action: 'set', reasoningEffort: 'medium' });
    const md = await s.call('atlas_search', { query: '执行 bash 命令跑构建', topK: 5 });
    ok('medium 档热加载生效', md.parsed.reasoningEffort === 'medium', md.parsed.reasoningEffort);

    await s.call('atlas_config', { action: 'set', reasoningEffort: 'xhigh' });
    const xh = await s.call('atlas_search', { query: '执行 bash 命令跑构建', topK: 2 });
    ok('xhigh 档热加载生效', xh.parsed.reasoningEffort === 'xhigh', xh.parsed.reasoningEffort);
    const xhShell = (xh.parsed.top || []).find((t) => t.ref === 'tool/shell');
    ok('xhigh 档回吐 matchedScenes', !!(xhShell && Array.isArray(xhShell.matchedScenes) && xhShell.matchedScenes.length > 0), xhShell && xhShell.matchedScenes);
    await s.call('atlas_config', { action: 'set', reasoningEffort: 'high' });

    // 5) 禁用清单
    await s.call('atlas_config', { action: 'disable', refs: ['skill/apk-unpack'] });
    const dis = await s.call('atlas_search', { query: 'classes.dex 异常小 脱壳', topK: 5 });
    ok('禁用项不进检索结果', !(dis.parsed.top || []).some((t) => t.ref === 'skill/apk-unpack'), (dis.parsed.top || []).map((t) => t.ref));
    ok('检索回吐 disabledExcluded', dis.parsed.disabledExcluded === 1, dis.parsed.disabledExcluded);
    const br = await s.call('atlas_browse', { category: 'term', sub: 'exec' });
    const bItem = (br.parsed.tools || []).find((t) => t.ref === 'skill/apk-unpack');
    ok('浏览默认保留禁用项并标 disabled', !!(bItem && bItem.disabled === true), bItem);
    await s.call('atlas_config', { action: 'set', hideDisabledInBrowse: true });
    const br2 = await s.call('atlas_browse', { category: 'term', sub: 'exec' });
    ok('hideDisabledInBrowse=true 时浏览隐藏', !(br2.parsed.tools || []).some((t) => t.ref === 'skill/apk-unpack'), (br2.parsed.tools || []).map((t) => t.ref));
    await s.call('atlas_config', { action: 'set', hideDisabledInBrowse: false });
    await s.call('atlas_config', { action: 'enable', refs: ['skill/apk-unpack'] });
    const back = await s.call('atlas_search', { query: 'classes.dex 异常小 脱壳', topK: 5 });
    ok('enable 后重新可被推荐', (back.parsed.top || []).some((t) => t.ref === 'skill/apk-unpack'), (back.parsed.top || []).map((t) => t.ref));

    // 6) useLlmFallback：绝不发 embedding 请求
    await s.call('atlas_config', { action: 'set', useLlmFallback: true });
    const before = calls.embeddings;
    const fb = await s.call('atlas_search', { query: '执行 bash 命令跑构建', topK: 3 });
    ok('回退模式标记 mode=llm-fallback', fb.parsed.mode === 'llm-fallback', fb.parsed.mode);
    ok('回退模式标 embeddingBypassed', fb.parsed.embeddingBypassed === true, fb.parsed.embeddingBypassed);
    ok('回退模式一个 embedding 请求都不发', calls.embeddings === before, { before: before, after: calls.embeddings });
    ok('回退模式仍给候选原文', Array.isArray(fb.parsed.top) && fb.parsed.top.length > 0, fb.parsed.top && fb.parsed.top.length);
    ok('回退模式给分类概览（high 档）', Array.isArray(fb.parsed.categories) && fb.parsed.categories.length > 0, fb.parsed.categories);
    ok('回退模式保留 auditProtocol', !!(fb.parsed.auditProtocol && Array.isArray(fb.parsed.auditProtocol.checklist)), fb.parsed.auditProtocol);
    const stFb = await s.call('atlas_stats', {});
    ok('atlas_stats 报出 useLlmFallback', stFb.parsed.useLlmFallback === true, stFb.parsed.useLlmFallback);
    const reidx = await s.call('atlas_reindex', {});
    ok('回退模式下 reindex 短路', reidx.parsed.embeddingSkipped === true, reidx.parsed);
    const ups = await s.call('atlas_upsert', { ref: 'tool/new-one', name: 'new-one', traits: '测试条目', paths: [['term', 'exec']] });
    ok('回退模式下 upsert 跳过向量化', ups.parsed.embeddingSkipped === true && ups.parsed.dim === 0, ups.parsed);
    await s.call('atlas_config', { action: 'set', useLlmFallback: false });

    // 7) reset 保留 apiKey
    const reset = await s.call('atlas_config', { action: 'reset' });
    ok('reset 后回到默认思考强度', reset.parsed.config.reasoningEffort === 'high', reset.parsed.config.reasoningEffort);
    ok('reset 保留 apiKey', reset.parsed.config.embedding.apiKey.includes('***'), reset.parsed.config.embedding);
    ok('reset 清空禁用清单', reset.parsed.config.disabled.skills.length === 0 && reset.parsed.config.disabled.tools.length === 0, reset.parsed.config.disabled);

    // 8) 错误分支
    const bad = await s.call('atlas_config', { action: 'set', reasoningEffort: 'ultra' });
    ok('非法思考强度被拒', bad.isError === true && String(bad.parsed).includes('reasoningEffort'), bad.parsed);
  } finally {
    s.stop();
    mock.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('');
  console.log('PASS ' + pass + ' / FAIL ' + fails.length);
  if (fails.length) {
    console.log('失败项：');
    for (const f of fails) console.log('  - ' + f);
    process.exit(1);
  }
}

await main();
