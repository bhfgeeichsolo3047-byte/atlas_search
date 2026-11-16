#!/usr/bin/env node
// config-cli.mjs —— 命令行管理工具库配置（与 MCP 的 atlas_config / atlas_models 同一套逻辑）
//
// 用法：
//   node scripts/config-cli.mjs show
//   node scripts/config-cli.mjs set --base-url https://api.siliconflow.cn/v1 --model Qwen/Qwen3-Embedding-4B
//   node scripts/config-cli.mjs set --api-key sk-xxx
//   node scripts/config-cli.mjs set --effort high          # low | medium | high | xhigh
//   node scripts/config-cli.mjs set --llm-fallback on      # 不用向量模型，检索改大模型直读
//   node scripts/config-cli.mjs set --hide-disabled on
//   node scripts/config-cli.mjs models                     # 拉 /models，标出 embedding 模型
//   node scripts/config-cli.mjs models --all               # 连非 embedding 一起列
//   node scripts/config-cli.mjs models --save Qwen/Qwen3-Embedding-8B
//   node scripts/config-cli.mjs disable skill/apk-unpack tool/subagent
//   node scripts/config-cli.mjs enable skill/apk-unpack
//   node scripts/config-cli.mjs entries --kind skill       # 列出可禁用的 ref
//
// 配置文件默认在 ATLAS_DIR/config.json（仓库布局下就是仓库根的 config.json，已在 .gitignore 里）。
import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_PATH, EFFORTS, ATLAS_DIR,
  loadConfig, writeConfig, configView, resolveApiKey,
  normalizeModels, embeddingModelsFromList, toggleDisabled,
} from '../config.mjs';

const CATALOG = path.join(ATLAS_DIR, 'catalog.json');

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}
const has = (name) => process.argv.includes('--' + name);
const onoff = (v) => (v === true ? true : /^(1|on|true|yes|y)$/i.test(String(v)));

function loadCatalog() {
  try { return JSON.parse(fs.readFileSync(CATALOG, 'utf8')); } catch { return { categories: [], tools: {} }; }
}

function show() {
  const v = configView(loadConfig());
  console.log(JSON.stringify(v, null, 2));
  if (!v.embedding.apiKey) {
    console.log('');
    console.log('提示：还没有 API Key。写一个：node scripts/config-cli.mjs set --api-key <KEY>');
  }
}

async function set() {
  const patch = {};
  const emb = {};
  if (has('base-url')) emb.baseUrl = String(arg('base-url'));
  if (has('model')) emb.model = String(arg('model'));
  if (has('api-key')) emb.apiKey = String(arg('api-key'));
  if (Object.keys(emb).length) patch.embedding = emb;
  if (has('effort')) {
    const e = String(arg('effort')).toLowerCase();
    if (!EFFORTS.includes(e)) {
      console.error(`--effort 只能是 ${EFFORTS.join(' / ')}`);
      process.exit(1);
    }
    patch.reasoningEffort = e;
  }
  if (has('llm-fallback')) patch.useLlmFallback = onoff(arg('llm-fallback'));
  if (has('hide-disabled')) patch.hideDisabledInBrowse = onoff(arg('hide-disabled'));
  if (!Object.keys(patch).length) {
    console.error('没有可写的字段。可用：--base-url --model --api-key --effort --llm-fallback --hide-disabled');
    process.exit(1);
  }
  const next = await writeConfig(patch);
  console.log('WROTE ' + CONFIG_PATH);
  console.log(JSON.stringify(configView(next), null, 2));
}

async function models() {
  const conf = loadConfig();
  const base = String(arg('base-url') || conf.embedding.baseUrl).replace(/\/+$/, '');
  const key = String(arg('api-key') || resolveApiKey(conf) || '');
  if (!key) {
    console.error('还没有 API Key：先 set --api-key，或设置环境变量 SILICONFLOW_API_KEY');
    process.exit(1);
  }
  let payload = null;
  let status = 0;
  try {
    const res = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key } });
    status = res.status;
    payload = res.ok ? await res.json() : { error: (await res.text().catch(() => '')).slice(0, 300) };
  } catch (e) {
    console.error('拉取 /models 失败：' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  }
  const all = normalizeModels(payload);
  const emb = embeddingModelsFromList(all);
  const wantAll = has('all');
  console.log(`GET ${base}/models -> ${status}，共 ${all.length} 个模型，其中 embedding ${emb.length} 个`);
  for (const m of all) {
    if (!wantAll && !m.embedding) continue;
    const mark = m.embedding ? '  [embedding]' : '';
    console.log(`${m.id}${m.meta ? '  (' + m.meta + ')' : ''}${mark}`);
  }
  const save = arg('save');
  if (save && save !== true) {
    const pick = String(save);
    if (!all.some((m) => m.id === pick)) {
      console.error(`该供应商的模型列表里没有 ${pick}；先不加 --save 看一眼全部 id。`);
      process.exit(1);
    }
    await writeConfig({ embedding: { model: pick, baseUrl: base } });
    console.log(`WROTE model=${pick} baseUrl=${base} -> ${CONFIG_PATH}`);
  }
}

async function toggle(action) {
  // argv[2] 是子命令本身（disable / enable），从 argv[3] 起才是 ref。
  const refs = process.argv.slice(3).filter((x) => !x.startsWith('--'));
  if (!refs.length) {
    console.error(`${action} 后面跟要开关的 ref，如 skill/apk-unpack tool/subagent`);
    process.exit(1);
  }
  const cur = loadConfig();
  const next = await writeConfig({ disabled: toggleDisabled(cur.disabled, action, refs, loadCatalog().tools) });
  console.log(`OK ${action}: ${refs.join(', ')}`);
  console.log(JSON.stringify(next.disabled, null, 2));
}

function entries() {
  const c = loadCatalog();
  const kind = arg('kind');
  const rows = Object.values(c.tools || {})
    .filter((t) => !kind || t.kind === kind)
    .map((t) => `${t.ref}\t${t.kind || ''}\t${t.name}`)
    .sort();
  console.log(rows.join('\n'));
  console.log(`\n共 ${rows.length} 条（可用 disable/enable 按 ref 或 name 开关）`);
}

const cmd = process.argv[2] || 'show';
if (cmd === 'show') show();
else if (cmd === 'set') await set();
else if (cmd === 'models') await models();
else if (cmd === 'disable' || cmd === 'enable') await toggle(cmd);
else if (cmd === 'entries') entries();
else {
  console.error('未知命令：' + cmd);
  console.error('可用：show / set / models / disable / enable / entries');
  process.exit(1);
}
