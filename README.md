# dsh-tool-atlas —— 本地工具库向量目录

把「有哪些工具、各自擅长什么」写成一份可被向量模型快速检索的三层目录，让主模型在动手前先把候选工具捞出来，再自己审核用不用。

一个零依赖的 MCP 服务：本地 stdio 进程，数据落两个 JSON 文件，向量用任意 OpenAI 兼容的 `/embeddings` 端点（默认 SiliconFlow 的 `Qwen/Qwen3-Embedding-4B`）。

---

## 为什么不是直接搜工具名

常见的工具面有三套形态，都解决不了「按意图找工具」：

| 工具面 | 检索方式 | 局限 |
|---|---|---|
| 白名单式工具桥（如 `/tools` 端点） | 无检索，过滤后全量 map | 靠模型自己从几百条里面挑 |
| MCP 连接器的 `tool_search` | 字符串打分（`fieldIndex===0?300:180:80` + 精确/前缀/包含加权） | 搜「跑命令」不会命中 `shell`，因为它的 name/title/description 里没有这三个字 |
| 按 toolset 分组 | 只是分组 | 是分类，不是语义 |

atlas 走的是 embedding 语义匹配：工具被总结成「特点 + 应用场景」，向量化之后按意图相似度召回。

## 三层结构

```
总分类 (categories)          编程开发 / 逆向工程 / 安全测试 / 网络通信 / 数据处理 …
  └─ 子分类 (subs)           代码编辑 / bug 修复 / 脱壳还原 / 端口扫描 …
       └─ 工具 (tools)       每条含 traits / scenes / avoid / invoke
```

当前规模：**10 个总分类 / 30 个子分类 / 128 条工具 / 1030 条向量**。

关键设计：**一个工具可以挂多条 `(分类, 子分类)` 路径**。`shell` 同时属于 `code/build`（编译跑测试）、`auto/system`（看进程看端口）、`auto/remote`（远程执行），不需要为了归类牺牲它的通用性。`sub.tools` 与 `tool.categories` 双向维护，`atlas_link` 专门做「追加挂载，不重复录入」。

## 打分机制

一条工具会被拆成**三路独立向量**，而不是把全部字段拼成一大段（拼接会让长文本稀释掉「场景」信号 —— 这是首版实测出来的坑）：

| 维度 | 内容 | 默认权重 |
|---|---|---|
| `scenes` | 逐条场景单独成向量 | 0.55 |
| `traits` | 特点描述 + 避坑说明 | 0.24 |
| `name` | name + display + kind | 0.21 |

场景维度再取 **软最大值**：`0.75 * max(逐条场景分) + 0.25 * mean(逐条场景分)`。纯 max 会让无关工具靠某一条偶然相似的场景词冒头，纯均值又会把强命中稀释，软最大值两头都压住。

两个调节阀：

- **`floor`**：给通用兜底工具一个分数下限，保证它永远进候选 —— 主模型看到候选后自己决定用不用，而不是被排在 20 名之外根本看不到。当前取 `floor` 的共 9 条，典型值从 `0.40` 到 `0.47`。
  **注意**：`floor` 是无条件兜底（`if (s < floor) s = floor`），调高不会让它更准，只会让它在任何查询上都占住前排。`read` 必须保持在 `0.44` —— 早期一度想把它提到 `0.62` 来解决「读文件被抢」，实测那会让它在「今天天气怎么样」（全库最高分仅 0.5279）和「加单元测试」上也霸榜第一。精确命中应该靠补 `scenes` 的自然语言问法，以及压低竞争者的 `cap`。
- **`cap`**：给宽口径工具一个分数上限，防止它们对任何查询都 `0.7+` 把真正的精准工具挤下去。当前取 `cap` 的共 17 条，范围 `0.58`–`0.70`（完整表见下方快照块）。

`cap` 是双面的：`mnemon_document_search` 从 `0.68` 降到 `0.61` 后不再抢「读某个文件」的活；而 `web_search` 的 `0.65` 必须给足 —— 曾试过 `0.59`，结果「搜一下这个报错是什么原因」（本尊 `0.7313`）被 `session_search` 与 `grep` 反超掉到第 3，基准从 24/25 退到 23/25。

路径层另外给 `matchedPaths` 前 4 名加成 `0.05 / 0.038 / 0.026 / 0.014`，让工具分带上「它所在的分类跟这次意图有多贴」的信息。

<!-- AUTOGEN:ATLAS_SNAPSHOT_START -->
<!-- 本区块由 doc-check.mjs --write 从 catalog.json / vectors.json 自动生成，请勿手改。 -->

### 当前调控参数与规模快照

目录规模：**10 个总分类 / 30 个子分类 / 128 条工具 / 1030 条向量**

`floor`（通用兜底下限，共 9 条）：

| 工具 | floor |
|---|---|
| `tool/shell` | 0.47 |
| `tool/grep` | 0.44 |
| `tool/read` | 0.44 |
| `tool/web_search` | 0.44 |
| `tool/web_fetch` | 0.43 |
| `tool/edit` | 0.42 |
| `tool/glob` | 0.42 |
| `tool/write` | 0.42 |
| `tool/todo_write` | 0.4 |

`cap`（宽口径封顶，共 17 条）：

| 工具 | cap |
|---|---|
| `skill/apk-unpack` | 0.7 |
| `tool/session_search` | 0.7 |
| `skill/chart-visualization` | 0.66 |
| `tool/mnemon_recall` | 0.66 |
| `tool/subagent` | 0.66 |
| `tool/subagent_fork` | 0.66 |
| `tool/web_search` | 0.65 |
| `mcp/embed-router` | 0.64 |
| `mcp/tool-atlas` | 0.64 |
| `tool/list_experts` | 0.64 |
| `skill/security-code-auditor` | 0.62 |
| `skill/wbexpert__ai-image-prompt-engineer__canvas-design` | 0.62 |
| `tool/agent_teams_status` | 0.62 |
| `tool/mnemon_document_search` | 0.61 |
| `tool/compress` | 0.6 |
| `tool/todo_write` | 0.6 |
| `tool/acp_status` | 0.58 |

重点调整过的 `scenes` 条数：

| 工具 | scenes |
|---|---|
| `tool/shell` | 34 |
| `tool/read` | 12 |
| `tool/write` | 12 |
| `tool/edit` | 11 |
| `tool/grep` | 10 |
| `tool/web_search` | 6 |
| `skill/security-code-auditor` | 5 |
| `tool/mnemon_document_search` | 5 |
<!-- AUTOGEN:ATLAS_SNAPSHOT_END -->

## 配置层：供应商 / 思考强度 / 禁用 / 回退

四件事全部落在 `config.json`（默认在 `ATLAS_DIR` 下，仓库布局下就是仓库根的 `config.json`，**已在 `.gitignore` 里**，只提交 `config.example.json`）。服务按文件 `mtime` 热加载，改完下一个请求就生效，不需要重启 DSH。

```json
{
  "embedding": { "baseUrl": "https://api.siliconflow.cn/v1", "apiKey": "", "model": "Qwen/Qwen3-Embedding-4B" },
  "reasoningEffort": "high",
  "useLlmFallback": false,
  "disabled": { "skills": [], "tools": [] },
  "hideDisabledInBrowse": false
}
```

优先级：`config.json` 里的非空值 > 环境变量（含 Windows 用户作用域注册表兜底）> 内置默认值。

**① 向量供应商可配置**

`baseUrl` 只要兼容 OpenAI 的 `POST /embeddings`，`model` 填该供应商的 embedding 模型 id。换供应商不必改代码：

```bash
node scripts/config-cli.mjs models                 # 拉 /models，只列 embedding 模型
node scripts/config-cli.mjs models --all           # 连非 embedding 一起列
node scripts/config-cli.mjs models --save bge-m3   # 选中并立即生效
```

识别规则不靠单一正则：先看响应元数据（`type` / `sub_type` / `pipeline_tag` / `capabilities` / `details.family` 里是否含 embed），元数据缺失再退回 id 正则（`embed` / `bge-` / `e5-` / `gte-` / `nomic-embed` / `mxbai-embed` / `text-embedding` / `qwen3-embedding` 等），并一律排除 `rerank`。这样 OpenAI 只有 `id`、Ollama 有 `details.family`、SiliconFlow 有 `type/sub_type` 三种响应都能正确分类。

**② 技能与工具可禁用**

`disabled.skills` / `disabled.tools` 按 `ref`（`skill/apk-unpack`）或 `name`（`apk-unpack`）匹配。语义是「当前会话里不该被推荐给我用」，不是「从目录里删掉」：

| 入口 | 禁用后的表现 |
|---|---|
| `atlas_search` | 直接从候选里剔除，返回体带 `disabledExcluded` 计数 |
| `atlas_browse` / `atlas_detail` | 默认保留并标 `disabled: true`（目录是事实，推荐才是策略） |
| 同上，但 `hideDisabledInBrowse: true` | 浏览时也隐藏，等价于「当它不存在」 |

```bash
node scripts/config-cli.mjs disable skill/apk-unpack tool/subagent
node scripts/config-cli.mjs enable  skill/apk-unpack
node scripts/config-cli.mjs entries --kind skill    # 列出可禁用的 ref
```

**③ 四档思考强度（默认 `high`）**

| 档位 | 路径层 | 场景精排 | 词元混合 | 回吐体积 |
|---|---|---|---|---|
| `low` | 前 2 | 关 | 0 | 每条候选只给前 2 条 `scenes` |
| `medium` | 前 4 | 开（软最大值） | 0 | 完整 `scenes` |
| `high`（默认） | 前 4 | 开 | 0.06 | 完整 `scenes` + `scoreBreakdown` + `pathLabels` |
| `xhigh` | 前 6 | 开 + 候选池放大到 `topK*3`（下限 24）再按场景 top3 均值精排 | 0.10 | 额外 `matchedScenes`、完整 `invoke` / `avoid` / 路径名 |

`low` 到 `high` 只影响召回精度与回吐体积，不改变打分口径本身；`xhigh` 会真的改变排序（放大池子后用「场景 top3 均值」重排）。

**④ 不用向量模型，改由大模型直读（`useLlmFallback`）**

置 `true` 后 `atlas_search` 走**硬短路**：这条路径里不出现任何 `embed` / `embedBatch` / `vecForFill` 调用 —— 即使配了 Key 也一个请求都不发。只按字面重合度（英文按词、中文按二元组）排序，把候选**原文**按思考强度分档回吐：`low` 前 12 条精简、`medium` 前 20、`high` 前 40 并附分类概览、`xhigh` 全量含完整字段。返回体带 `mode: "llm-fallback"` 与 `embeddingBypassed: true`，`auditProtocol` 照常保留 —— 判断权仍然在主模型手里。

同一开关也作用于写入侧：`atlas_upsert` / `atlas_link` / `atlas_commit` 跳过向量预热（返回 `embeddingSkipped: true`），`atlas_reindex` 直接短路。适合「没有 Key / 不想付费 / 只想让模型读目录」的场合。

```bash
node scripts/config-cli.mjs set --llm-fallback on
node scripts/config-cli.mjs set --effort xhigh
node scripts/config-cli.mjs show
```

## 十三个工具

| 工具 | 用途 |
|---|---|
| `atlas_search` | 语义检索。返回 `matchedPaths` + `top` + `hint` + `auditProtocol`（hint 明确写「是否使用由主模型审核决定」） |
| `atlas_browse` | 三层浏览。不传参=第一层，传 `category`=第二层，传 `category`+`sub`=第三层 |
| `atlas_detail` | 单条工具详述 |
| `atlas_upsert` | 录入/更新。可同时声明 `categories` 与 `subs`，自动建分类，自动预热向量 |
| `atlas_link` | 把已有工具追加挂到另一路径，不重复录入 |
| `atlas_stats` | 目录规模与每分类工具数 |
| `atlas_reindex` | 全量重算向量，`force` 清缓存 |
| `atlas_discover` | 扫描本机技能目录与 MCP 工具表，和 catalog 比对，出 pending / changed / indexed / ignored / missing |
| `atlas_propose` | 把待归纳条目整理成主模型可读的材料（frontmatter + 正文摘要 + 附带文件 / MCP 工具名与描述），不做归类判断 |
| `atlas_commit` | 主模型归纳完，整批写进 catalog（内部走 upsertEntry，自动建分类、双向挂载、预热向量、状态转 indexed） |
| `atlas_ignore` | 标记某条「不收」，之后不再进待归纳队列；`reset` 撤销 |
| `atlas_config` | 读写 `config.json`：向量供应商 / 模型 / Key / 思考强度 / 禁用清单 / 回退开关。改完即时生效，不用重启宿主 |
| `atlas_models` | 拉供应商的 `GET /models`，自动标出哪些是 embedding 模型；`applyModel` 一键切换 |

### 检索结果里的 `auditProtocol`

`atlas_search` 与 `atlas_browse` 第三层返回的每条候选都带 `avoid`（禁用条件），并附统一的 `auditProtocol`：主模型必须依次过四步 ——

1. `scenes` 里是否真有一条对上当前子目标；
2. 是否命中 `avoid`；
3. `kind / invoke` 在当前环境是否真可用；
4. `paths` 只是弱信号。

四步全过才允许调用。全都不合格就改写 query 重检，或者直接动手，不为用工具而用工具。

## 发现层：新技能 / 新工具怎么自动进来

参照 `weibaohui/skills-management` 的约定式发现，但把判断权留给主模型 —— 发现层只负责「找出差异 + 整理材料」，落哪条路径、`traits` / `scenes` / `avoid` 怎么写由当前主模型读完材料自己定。

四条约定：

| 约定 | 内容 |
|---|---|
| C1 技能源 | 家目录下任何 `.<name>/skills/` 自动识别（Windows 为 `%USERPROFILE%\.xxx\skills`），另加显式清单：DSH 用户库 `~/.dsh/skills`、agents 共享池 `~/.agents/skills`、preset 层 `~/.dsh/.agent-presets/*/skills` |
| C2 一个技能 | 技能根下每个子目录内含 `SKILL.md`，frontmatter 至少 `name` + `description` |
| C3 MCP 工具源 | `~/.dsh/storages/mcp_connector.json` → `tables.tool_catalog`（每 server 一条聚合条目，`ref` 优先复用 catalog 里已有的 `mcp/<x>`） |
| C4 发现结果 | 只写 `discover-state.json`；进 `catalog.json` 必须主模型审核后 `atlas_commit` |

同一技能常被多个 agent 目录共享（软链或复制），所以按 frontmatter `name` 归一去重，只留一份，其余路径记进 `mirrors` —— 否则 `leanrea` 这类会被算成 5 条重复待归纳。

状态语义：

| status | 含义 | 下一步 |
|---|---|---|
| `pending` | catalog 里没有，且没被 ignore 过 | 等主模型归纳 |
| `changed` | catalog 里有但指纹变了（技能改了 description / 正文，或 MCP server 工具表变了） | 等主模型复核 |
| `indexed` | catalog 里有且指纹一致 | 已最新 |
| `ignored` | 主模型明确标记「不收」 | 不再进队列 |
| `missing` | catalog 里有、但源侧不见了（只对 `skill/` 开头且非手写的条目报警） | 考虑清理 |

标准流程（三个工具串起来，主模型全程做判断）：

```
atlas_discover({})                       → 看 stats：多少 pending / changed
atlas_propose({ limit: 6 })              → 拿材料：技能正文摘要 + MCP 工具清单 + 现有分类树
   ↓（主模型读材料，决定每条落在哪条 (总分类,子分类)，写 traits / scenes / avoid）
atlas_commit({ items: [...] })           → 整批落库：自动建分类、双向挂载、预热向量、状态转 indexed
atlas_ignore({ ref })                    → 不想收的直接标记，不必留在队列里
```

MCP 不可用时用命令行：`node discover-cli.mjs scan` / `propose --limit 6 --verbose` / `ignore --ref skill/xxx` / `reset --ref skill/xxx` / `sources`。

`atlas_search` 的返回体在存在未归纳条目时会带一个 `discoverBacklog`（只读 state 文件，不重扫盘，不拖慢检索热路径），提醒主模型「有新材料待归纳」。

## 检索质量（25 条人工用例）

```
weighted 模式：top1 24/25、top3 25/25、top5 25/25
max 模式：     top1 22/25、top3 23/25、top5 25/25
```

默认 `ATLAS_SCORE_MODE=weighted`。`max` 模式（`s = max(场景分, 特点分, 名称分*1.02)`）在跨域查询上更容易被单条偶然相似的场景词带偏，所以保留 weighted 为默认。

唯一没拿第一的是「帮我看看数据库里这条记录」：`session_search` 第 1、`shell` 第 2、`grep` 第 3。这句本身语义就偏「翻历史会话」，`shell` 能升到第 2（调优前是第 3）已经算合理分布。

负向用例也验过：「今天天气怎么样」全库最高分仅 `0.5279`（`screen_view`），没有任何工具被硬凑成第一 —— 目录里没有的能力，向量就不该硬给。`atlas_detail` 查不存在的 ref 返回 `没有这个工具条目`。

## 项目结构

```
.
├── server.mjs              MCP 服务本体（stdio，零依赖，13 个工具）
├── config.mjs              共享配置层（热加载 / 优先级 / 思考强度 / 模型识别）
├── config.example.json     配置模板（真正的 config.json 不入库）
├── discover.mjs            发现层本体（约定扫描 + 指纹比对 + 提案材料整理，零依赖）
├── discover-cli.mjs        发现层命令行
├── catalog.json            三层目录数据（10 个总分类 / 30 个子分类 / 128 条工具）
├── vectors.json            向量缓存（1030 条，键 = sha256(MODEL + ' ' + text) 前 24 位）
├── discover-state.json     发现层状态（90 条，全部 indexed）
├── docs/
│   ├── DEBUGLOG.md         完整调试过程：每一轮的假设、实测、踩坑与修法
│   ├── TUNING.md           调参方法论：25 条基准、floor/cap 推导过程
│   └── DESIGN.md           设计取舍：为什么三路向量、为什么发现层不判断
└── scripts/                21 个调试与自检脚本（见下表）
```

`scripts/` 下各脚本：

| 脚本 | 作用 |
|---|---|
| `seed.mjs` | 首次播种 10 分类 / 24 子分类 / 47 工具 |
| `enrich.mjs` / `enrich2.mjs` | 补场景词与特点描述（只追加不覆盖） |
| `floor.mjs` | 单独设 floor |
| `cap.mjs` / `cap2.mjs` / `cap3.mjs` | 三轮 cap 校准（0.50 → 0.58 → 最终值） |
| `tune4.mjs` | 审核修复轮：read / shell / edit / grep / web_search 等的场景与参数边界重构 |
| `tune5.mjs` | 回归修复轮：恢复被覆盖的 `tool/write` 场景、移除 `grep` 误抢 `glob` 的场景 |
| `smoke.mjs` | 8 条速测 |
| `compare.mjs` | weighted vs max 25 条基准对比 |
| `dump.mjs` | 单查询全量排名 + 三路分项分 |
| `probe.mjs` / `show.mjs` / `tune.mjs` | 单查询诊断 / 打印条目 / 20 条用例排名 |
| `reindex.mjs` | `--force` 全量重算向量 |
| `selftest.mjs` | 协议与工程自检（17 项断言） |
| `test-discover.mjs` | 发现层端到端自测（34 项断言，走真实 stdio JSON-RPC） |
| `doc-check.mjs` | 文档一致性校验 + 快照块生成（`--write`） |
| `config-cli.mjs` | 配置命令行：`show` / `set` / `models` / `disable` / `enable` / `entries` |
| `test-config.mjs` | 配置层端到端自测（本地 mock 向量服务，42 项断言） |

## 快速开始

**1. 准备数据目录**

默认 `ATLAS_DIR` = `~/.dsh/tool-atlas`。仓库里的 `catalog.json` / `vectors.json` 直接复制进去即可开箱（向量缓存命中就不必重新调 embedding）：

```bash
mkdir -p ~/.dsh/tool-atlas
cp catalog.json vectors.json discover-state.json ~/.dsh/tool-atlas/
```

想从零开始则跳过复制，直接用 `scripts/seed.mjs` 播种，再 `scripts/reindex.mjs --force` 建向量。

**2. 配供应商与 Key**

推荐写进 `config.json`（改完即时生效，也不会因为宿主重启丢掉）：

```bash
cp config.example.json config.json          # 仓库布局下就是仓库根
node scripts/config-cli.mjs set --api-key sk-xxx
node scripts/config-cli.mjs set --base-url https://api.siliconflow.cn/v1 --model Qwen/Qwen3-Embedding-4B
node scripts/config-cli.mjs models          # 不确定有哪些 embedding 模型时先看一眼
```

也可以用环境变量（优先级低于 `config.json`）：

```bash
export SILICONFLOW_API_KEY=...   # 任意 OpenAI 兼容 embeddings 端点的 key
```

Windows 上如果 key 是后来才写进 User 作用域的（DSH 从 GUI 启动时进程 env 是启动那一刻的快照），`resolveKey()` 会自己去 `HKCU\Environment` 读一次，不需要重启宿主。

**3. 注册为 MCP 服务（stdio）**

```
command: node
args:    ["<repo>/.dsh/tool-atlas/server.mjs"]   # 换成你的实际路径
env:     ATLAS_EMBED_MODEL=Qwen/Qwen3-Embedding-4B
         ATLAS_SCORE_MODE=weighted
```

**4. 验证**

```bash
node scripts/selftest.mjs        # 17 项协议自检
node scripts/test-discover.mjs   # 34 项发现层自检
node scripts/test-config.mjs     # 42 项配置层自检（本地 mock 向量服务）
node scripts/compare.mjs         # 25 条检索基准
node scripts/doc-check.mjs       # 文档与数据一致性
```

## 环境变量

`config.json` 里给了非空值就以配置为准，环境变量是兜底（便于 CI / 容器一次性注入）。

| 变量 | 默认 | 作用 |
|---|---|---|
| `ATLAS_CONFIG` | `<ATLAS_DIR>/config.json` | 配置文件路径 |
| `ATLAS_REASONING_EFFORT` | `high` | 思考强度兜底：`low` / `medium` / `high` / `xhigh` |
| `ATLAS_LLM_FALLBACK` | 关 | 设 `1` 等于 `useLlmFallback: true` |
| `ATLAS_HIDE_DISABLED` | 关 | 设 `1` 等于 `hideDisabledInBrowse: true` |
| `SILICONFLOW_API_KEY` | — | embedding 授权（也可用 `ATLAS_API_KEY`） |
| `ATLAS_EMBED_MODEL` | `Qwen/Qwen3-Embedding-4B` | 向量模型 |
| `ATLAS_BASE_URL` / `EMBED_BASE_URL` | `https://api.siliconflow.cn/v1` | OpenAI 兼容 API 端点 |
| `ATLAS_DIR` | `~/.dsh/tool-atlas` | 数据目录 |
| `ATLAS_SCORE_MODE` | `weighted` | `weighted` 或 `max` |
| `ATLAS_W_SCENE` | `0.55` | 场景权重 |
| `ATLAS_W_TRAIT` | `0.24` | 特点权重 |
| `ATLAS_W_NAME` | `0.21` | 名称权重 |
| `ATLAS_SCENE_MAX` | 开 | 设 `0` 关掉逐条场景软最大值，退回整段场景向量 |

## 加工具 / 调参流程

```
atlas_upsert({
  ref: "tool/my-tool",
  name: "my-tool",
  display: "中文显示名",
  kind: "tool",              // tool | mcp | agy-native | skill | cli
  traits: "这个工具是什么、怎么干活、有什么坑",
  scenes: ["用户会怎么说这句话 1", "用户会怎么说这句话 2"],
  avoid: "什么时候别用它，该换谁",
  invoke: "my_tool({...})",
  paths: [["code","debug"], ["auto","system"]],
  floor: 0.44,   // 可选：仅示例。通用底层工具的典型范围 0.40–0.47
  cap: 0.62      // 可选：仅示例。宽口径防抢占工具的典型范围 0.58–0.70
})
```

`traits` 和 `scenes` 的质量直接决定检索效果。场景要写**用户真实会说的那句话**，不要写「用于文件操作」这种归纳 —— 向量模型匹配的是语言习惯，不是意图分类。

**改 `scenes` 必须追加合并，禁止整组覆盖。** 调优时曾用 6 条新场景整体替换 `tool/write` 原有的 9 条，直接导致「把这三份文档合成一份」从第 1 掉到第 6，基准从 top1 24/25 退到 22/25。正确写法是先读出原数组再 `concat`。

**标准四步**：

1. 用脚本或 `atlas_upsert` 改 `catalog.json`（场景/参数）；
2. 跑 `atlas_reindex`（或 `scripts/reindex.mjs --force`）重算向量；
3. 跑 `scripts/compare.mjs` 确认 25 条基准不退化、跑 `scripts/selftest.mjs` 确认协议与工程自检全绿；
4. 跑 `scripts/doc-check.mjs --write` 刷新本文档的快照块，再跑一次 `scripts/doc-check.mjs` 校验通过。

第 4 步是硬性收尾：`README.md` 里 `AUTOGEN:ATLAS_SNAPSHOT_START` / `END` 之间的区块由脚本从 `catalog.json` 与 `vectors.json` 直接渲染，手改无效；正文里的规模数字与基准成绩若与磁盘事实不一致，`doc-check.mjs` 会以 exit 1 拦下。这样「改了数据忘了改文档」不会再悄悄发生。

## 调试过程

完整的调试记录在 [`docs/DEBUGLOG.md`](docs/DEBUGLOG.md)，按轮次记录了假设 → 实测 → 结论 → 修法。几条最值得抄走的教训：

1. **单向量会稀释信号**。首版把 `name + traits + scenes + paths` 拼成一段去 embed，「跑命令」这条查询里 `shell` 只排第 4（`wsl` 0.727 / `remote_send_message` 0.726 / `shell` 0.632）。拆成三路加权后升到第 1（0.73）。
2. **`floor` 不能当解药**。它无条件兜底，调高只让工具在任何查询上都占前排。想修「某类意图被抢」只有两条正路：补 `scenes` 的真人说法、压低竞争者的 `cap`。
3. **`cap` 不是越低越好**。一律压到 0.50 把 `session_search` 从 rank 2 打到 rank 21，基准直接崩。
4. **覆盖整组 `scenes` 是最贵的错误**。一次覆盖让基准从 24/25 掉到 22/25，且失败现象出现在完全无关的查询上（「把这三份文档合成一份」）。
5. **文档校验必须在正文里查、不能在快照块里查**。快照块是脚本自己渲染的，本身含正确数字；早期版本在全文里查，于是正文写成旧数字也永远通过，等于没校验。改成只比对快照块之外的散文，立刻拦下 3 处真漂移。
6. **并发写状态文件要带 pid + 随机后缀的 tmp 名**。固定 `${FILE}.tmp` 在两个进程同时写时会互相抢，报 `ENOENT: rename`。
7. **`saveState()` 别忘 `await`**。漏了之后进程还没写完就返回，测试读到半截，表现为随机失败。

## 回滚

**① 数据级回滚（只退回调优前状态，保留 MCP 服务）**

用仓库里的历史快照覆盖数据文件后重算向量：

```bash
cp docs/snapshots/catalog.bak-tune3.json  catalog.json
cp docs/snapshots/vectors.bak-tune3.json  vectors.json
node scripts/reindex.mjs --force
```

然后在宿主里重连该 MCP 连接（`mcp_connector_reconnect({key:"..."})`）让它重新加载。

**② 彻底卸载**

```
断开并删除该 MCP 连接
删除数据目录（ATLAS_DIR）
```

不影响宿主本体、不影响其它 MCP 连接、不影响任何已有工具。

## License

MIT，见 [LICENSE](LICENSE)。
