# 设计说明

这份文档讲清楚 atlas 的**数据模型、检索算法、发现层协议**，以及每个设计决定背后的取舍。想改代码前先读这一份。

---

## 一、要解决的问题

宿主（DeepSeek Harness）里可用的工具数量在几百条量级：内置工具、MCP 连接器工具、技能（skill）。模型要在动手前决定「用哪一个」，靠两条路：

1. 全量工具表塞进系统提示词 —— 上下文爆炸。
2. 靠模型自己记得有哪些 —— 记不住，尤其新装的。

中间缺一层：**按意图召回候选工具**。atlas 就是这一层。

它不负责「决定用哪个」—— 那是主模型的活。它只负责「把最可能的十来个候选捞出来，并附上足够的判断材料（场景、禁用条件、调用方式）」。

---

## 二、三层数据模型

### 结构

```
catalog = {
  version, updatedAt,
  categories: [                          ← 第一层：总分类
    {
      id, name, desc,
      subs: [                            ← 第二层：子分类
        { id, name, desc,
          tools: [ref, ...]              ← 第三层：工具引用
        }
      ]
    }
  ],
  tools: {                               ← 工具详述（按 ref 索引）
    "tool/shell": {
      ref, name, display, kind,
      traits,                            ← 特点：是什么、怎么干活、什么坑
      scenes: [string, ...],             ← 应用场景：用户真实会说的话
      avoid,                             ← 禁用条件
      invoke,                            ← 调用方式示例
      floor, cap,                        ← 打分的上下限
      categories: [[catId, subId], ...], ← 多路径挂载
      updatedAt
    }
  }
}
```

### 关键决定 1：工具与分类是**多对多**

`tool.categories` 与 `sub.tools` 双向维护：

- 一个工具可以挂 N 条 `(分类, 子分类)` 路径。
- 一个子分类下有 M 个工具。

**理由**：`shell` 同时是「编译跑测试」「看进程看端口」「远程执行」。强行归一类，另外两类查询就失配。

`atlas_link` 专门做「追加挂另一条路径」，不重复录入 `traits` / `scenes`。

**双向维护的陷阱**：换路径时必须**先把 ref 从所有 `sub.tools` 里摘掉**，再按新的 `categories` 重塞。只做「加」不做「减」会留残影 —— 一个工具同时出现在它已经不属于的子分类里。

```js
// upsertEntry 里的核心逻辑
for (const cat of c.categories)
  for (const sub of cat.subs)
    sub.tools = sub.tools.filter((x) => x !== ref);   // 先摘干净

for (const [cid, sid] of entry.categories) {
  const sub = ensureSub(ensureCat(cid), sid);
  if (!sub.tools.includes(ref)) sub.tools.push(ref);  // 再重新挂
}
```

### 关键决定 2：`kind` 区分五类

| kind | 含义 | 示例 |
|---|---|---|
| `tool` | 宿主内置工具 | `tool/shell`、`tool/read` |
| `mcp` | MCP server（每 server 一条聚合条目） | `mcp/pubmed`、`mcp/tool-atlas` |
| `skill` | 技能（SKILL.md） | `skill/ida-reverse` |
| `agy-native` | 外部 agent 的原生工具 | — |
| `cli` | 命令行工具 | — |

`kind` 进 `name` 向量（`[name, display, kind].join(' ')`），所以「给我个技能」「用 MCP 查」这类查询有微弱信号。

MCP 按 **server 聚合**成一条而非每工具一条：`mcp/pubmed` 覆盖 12 个 pubmed 工具。理由是同一 server 的工具用法高度同质，拆开会让 top10 里塞满同门兄弟。

---

## 三、检索算法

### 3.1 三路向量

每条工具拆成**三路独立文本**分别 embed，而不是拼接：

```
name   = [name, display, kind].join(' ')
traits = traits + '\n' + avoid
scenes = scenes.join('；')              ← 整段（用于粗排与缓存）
sceneList = scenes                       ← 逐条（用于精排）
```

**为什么拆**：单向量实测会把场景信号稀释。`shell` 的 28 条场景拼进一段后，「跑命令」只排第 4（0.6323），被 `wsl` 这类短文本工具压过。

### 3.2 打分公式

```
场景分 sbest：
  sceneMax 开（默认）→ 0.75 * max(逐条场景余弦) + 0.25 * mean(逐条场景余弦)
  sceneMax 关        → cosine(query_vec, scenes_vec)

加权：
  weighted 模式：s = sbest*W_S + st*W_T + sn*W_N      默认 0.55 / 0.24 / 0.21
  max 模式：     s = max(sbest, st, sn*1.02)

路径加成：
  pathTop = 全量子分类向量打分的前 4 名
  s += [0.050, 0.038, 0.026, 0.014][排名]

边界钳制：
  if (floor > 0 && s < floor) s = floor
  if (cap   > 0 && s > cap)   s = cap
```

### 3.3 为什么场景维度用「软最大值」

| 聚合方式 | 问题 |
|---|---|
| 纯 max | 一条偶然相似的场景词就能把无关工具顶上来（「今天天气」命中带「今天」的工具） |
| 纯 mean | 强命中的单条被大量无关场景拉平，`shell` 的 28 条反而吃亏 |
| **`0.75*max + 0.25*mean`** | 主命中保留主导权，又让「多条场景都沾一点」的工具拿到加成 |

### 3.4 为什么 `avoid` 不参与打分

`toolFields` 把 `avoid` 拼进 `traits` 向量（它描述的是「什么时候别用」，属于特点的一部分）。

但 `avoid` **不作为扣分项**：向量空间里没有「负向匹配」这回事，把 avoid 单独 embed 再做减法会引入不可控噪声。

`avoid` 的真正用途是**给主模型看的**：它进 `summary(t)`，随每条候选一起返回。判断交给人（模型），不交给分数。

### 3.5 `auditProtocol` —— 把「用不用」明确交回主模型

`atlas_search` 的返回体固定带一个四步审核协议：

```json
{
  "role": "recall-only",
  "checklist": [
    "1. scenes 里是否真有一条对上当前子目标（不要只看总分）",
    "2. 是否命中该条目的 avoid 禁用条件",
    "3. kind / invoke 在当前环境是否真可用",
    "4. paths 只是弱信号，不能单凭它认定相关"
  ],
  "fallback": "全部候选都不合格时，改写 query 重检，或直接按已有知识动手——不要为了用工具而用工具。"
}
```

**设计意图**：向量召回本质是「猜」。分数高不等于「该用」。把审核步骤写进返回体，让每次调用都带着这段约束，比写在系统提示词里更难被忽略。

`fallback` 那一条尤其重要：目录里没有合适工具时，正确答案是**如实说没有**，而不是硬凑一个（实测「今天天气怎么样」全库最高仅 0.5279，没有任何工具被顶到高位）。

### 3.6 向量缓存

```
vectors.json = {
  "<sha256(MODEL + ' ' + text) 前 24 位>": [float, ...]
}
```

- 键含模型名 —— 换模型自动失效，不会用错空间的向量。
- 写入用 tmp + rename（原子），tmp 名带 pid + 随机后缀防并发抢。
- 三级缓存：进程内 `memCache` → 磁盘 `vectors.json` → API。

`vecForMany(texts)` 一次调用批量处理未命中的文本（每批 16 条），避免 N 次 API 往返。这是 `warmTool` 的底层：

```js
async function warmTool(ref, t) {
  const f = toolFields(ref, t);
  const vecs = await vecForMany([f.name, f.traits, f.scenes, ...f.sceneList]);
  await saveVecDisk();
  return vecs[0] || null;
}
```

---

## 四、发现层

### 4.1 为什么需要它

atlas 的目录是**人工/模型总结**出来的。新装一个技能、新接一个 MCP server，目录不会自动知道。

发现层做的事：**自动找出「本机有什么、目录里缺什么」**，把差异整理成主模型可读的材料，由主模型决定收不收、落到哪。

### 4.2 四条约定

| 约定 | 内容 | 设计理由 |
|---|---|---|
| C1 技能源 | 家目录下任何 `.<name>/skills/` 自动识别（Windows `%USERPROFILE%\.xxx\skills`），另加显式清单：DSH 用户库 `~/.dsh/skills`、agents 共享池 `~/.agents/skills`、preset 层 `~/.dsh/.agent-presets/*/skills` | 照搬 `weibaohui/skills-management` 的约定式发现：新 agent 装上就自动被扫到，零配置 |
| C2 一个技能 | 技能根下每个子目录内含 `SKILL.md`，frontmatter 至少 `name` + `description` | 只认标准形态，避免把普通目录误判成技能 |
| C3 MCP 工具源 | `~/.dsh/storages/mcp_connector.json` → `tables.tool_catalog` | 连接器的工具表已经是权威事实，不重复爬 |
| C4 发现结果 | 只写 `discover-state.json`；进 `catalog.json` 必须主模型审核后 `atlas_commit` | **关键**：发现层不做判断。自动归类会把目录搞乱，且错误一旦入库很难回溯 |

### 4.3 去重：按 frontmatter `name`，不按目录名

同一个技能常被多个 agent 目录共享（软链或复制）。实测本机 51 个技能源里，`leanrea` 出现在 5 个以上的 `.xxx/skills` 下。

**按目录名去重会得到 5 条重复条目。**

正确做法：按 frontmatter `name` 归一到 `byName: Map`，优先级 `explicit(0) > preset(1) > convention(2)`，同优先级保留先见到的，其余路径记进 `mirrors[]`。

**踩过的坑**：`byName` 里存的是条目对象，但优先级判断需要知道「这条来自哪条规则」。第一版写 `rank(prevHit.__rule)`，而 `__rule` 从未被赋值 → 永远回落到 `'convention'` → explicit 压不过 convention，显式清单里的技能被约定层覆盖。

修法：存条目时显式带上 `__rule`：

```js
byName.set(key, { ...e, mirrors: [], __rule: src.rule });
```

### 4.4 五种 status

| status | 判定 | 含义 |
|---|---|---|
| `pending` | 不在 catalog，且没被 ignore 过 | 等主模型归纳 |
| `changed` | 在 catalog，但指纹变了 | 等主模型复核 |
| `indexed` | 在 catalog 且指纹一致 | 已最新 |
| `ignored` | 主模型标记「不收」 | 不再进队列 |
| `missing` | 在 catalog，但源侧不见了（只对 `skill/` 开头且非手写的报） | 考虑清理 |

**指纹** = `sha256(name + description + whenToUse + size+mtimeMs)` 前 24 位。

含 `mtimeMs` 是刻意的：技能正文改了但 `description` 没改时，也要能被发现。副作用是 `touch` 一下文件就会变成 `changed` —— 可接受，因为复核成本只是读一遍材料。

### 4.5 材料整理（`atlas_propose`）

发现层只负责「找差异」，**不判断**。判断需要读内容，那是主模型的事。

`atlas_propose` 产出的材料：

- **技能**：`name` / `description` / `whenToUse` / `role` / `bodyExcerpt`（正文压空白截 1600 字）/ `files`（除 SKILL.md 外最多 20 项文件名）/ `hint`
- **MCP**：`serverName` / `toolCount` / `toolNames` / `sample`（前 5 个工具，`verbose` 时带 400 字描述）/ `hint`
- **taxonomy**：现有分类树（带每个子分类的工具数），让主模型知道「已有格子在哪」

默认 `limit: 6`，上限 20。给太多材料会挤占上下文，反而降低判断质量。

### 4.6 落库（`atlas_commit`）

主模型读完材料后，一次性提交整批：

```js
atlas_commit({
  categories: [{ id, name, desc }],       // 需要新建的总分类
  subs: [{ categoryId, id, name, desc }], // 需要新建的子分类
  items: [{
    ref, name, display, kind,
    traits, scenes, avoid, invoke,
    floor, cap,
    paths: [[catId, subId], ...]
  }]
})
```

内部流程：

1. 先统一建 `categories` / `subs`；
2. 逐条走 `upsertEntry`（复用 upsert 的全部逻辑：自动建分类、双向挂载）；
3. 整批 `saveCatalog()` + `loadCatalog()`（一次落盘，不是每条一次）；
4. 逐条 `warmTool` 预热向量；
5. 把 `discover-state.json` 里这些 ref 置 `status: 'indexed'` + `decidedAt` + `decidedBy: 'model'`。

**为什么整批落盘**：78 条分 5 批时，如果每条都 `saveCatalog()`，会有 78 次全量 JSON 序列化（当时 catalog 已 150KB）。整批一次明显更快。

### 4.7 backlog 挂进检索返回体

`atlas_search` 的返回体末尾会条件性带上：

```json
"discoverBacklog": {
  "pending": 78,
  "changed": 0,
  "note": "工具库有未归纳的新条目。需要时调 atlas_propose 拿材料，读完自己决定归类后 atlas_commit。"
}
```

**只在有 backlog 时出现**，队列空了就完全不出现在返回体里。

实现上只 `loadState()` 读文件，**不重扫盘** —— 扫盘要几百毫秒，绝不能进检索热路径。

设计意图：让「有新东西该归纳了」这件事自己冒出来，而不是靠主模型记得去查。

---

## 五、为什么 MCP 而不是插件

DSH 的插件能做的事比 MCP server 多（能注册 systemPrompt 段、能注入 web 路由、能拦截工具调用）。

**选择 MCP 的理由**：

1. **零依赖**：`server.mjs` 只用 node 内置模块（`readline` / `fs` / `crypto` / `child_process` / `path` / `os`）。没有 `node_modules`，不会被依赖升级打坏。
2. **可移植**：同一份代码在任何支持 MCP 的宿主里都能跑，不绑 DSH。
3. **隔离**：进程独立，崩了不影响宿主。改代码只要重连 MCP 连接，不用重载插件、不用重启宿主。
4. **调试友好**：可以直接 `printf` 走 stdio 打 JSON-RPC，不需要起整个宿主。

**代价**：拿不到 systemPrompt 注入。所以 `auditProtocol` 只能塞在 `atlas_search` 的返回体里，而不是注册成一个常驻提示词段。这个取舍是划算的 —— 返回体随每次调用出现，比常驻提示词更贴近使用时机。

---

## 六、发现的入口

发现层开了两个入口，同一份逻辑：

| 入口 | 用途 | 实现 |
|---|---|---|
| MCP 工具（`atlas_discover` / `atlas_propose` / `atlas_commit` / `atlas_ignore`） | 主模型在会话里直接调用 | `server.mjs` 的 `callTool` 分支，import `discover.mjs` |
| CLI（`discover-cli.mjs scan` / `propose` / `ignore` / `reset` / `sources`） | MCP 不可用、或想在终端里看 | 直接 import `discover.mjs` 的函数 |

两个入口共享 `discover.mjs` 的 `discoverAll` / `buildProposal` / `loadState` / `saveState`，不重复实现。

**为什么 CLI 里没有 `commit`**：commit 需要主模型先读完材料写出 `traits` / `scenes` / `avoid`，纯命令行填不了这些字段。CLI 的定位是「看状态」，不是「做判断」。

---

## 七、自检体系

四套脚本，覆盖不同层次：

| 脚本 | 断言数 | 覆盖 | 何时跑 |
|---|---|---|---|
| `selftest.mjs` | 17 | MCP 协议握手、upsert / link / browse 三层、search 的 avoid + auditProtocol、清理 | 每次改动服务代码 |
| `test-discover.mjs` | 34 | 发现层端到端：discover → propose → commit → ignore → reset、二次 commit 幂等、残留清理 | 每次改动发现层 |
| `compare.mjs` | 25 条用例 | 检索质量基准，weighted vs max | 每次改数据 |
| `doc-check.mjs` | 4 类校验 | README 与磁盘一致性 + 快照块生成 | 每次改数据（收尾） |

**`doc-check.mjs` 的设计值得说明**：README 里有一段被 `AUTOGEN:ATLAS_SNAPSHOT_START` / `END` 包裹的区块，内容是 `catalog.json` + `vectors.json` 的投影，由 `--write` 渲染。

校验时**只在快照块之外**比对数字 —— 第一版在全文里查，而快照块本身含正确数字，导致正文写错也永远通过，等于没校验。这个漏检是靠「正文写旧数字仍 PASS」发现的。

同时维护一份**黑名单**，拦住历史过期字面量（如 `520 行`、`425 条`、`floor: 0.45`），防止旧文案被复制回来。

---

## 八、已知边界

| 边界 | 说明 |
|---|---|
| 单查询单意图 | 一条查询多意图（「脱壳+重签名+上架」）只能召回到主意图那一侧，需要主模型自己拆 |
| 目录必须人工/模型维护 | 发现层只找差异，`traits` / `scenes` 的质量完全取决于归纳者 |
| 向量依赖外部 API | `SILICONFLOW_API_KEY` 失效时检索不可用（缓存命中部分仍可） |
| 无增量索引 | 改一条工具要 `reindex` 就得全量重算（有 vectors.json 缓存所以只是本地重算，不重复付费） |
| cap / floor 是全局参数 | 不随查询变化。跨域查询时靠 `auditProtocol` 的 fallback 兜住 |
| 中文为主 | `scenes` 全是中文表述，英文查询命中率未验证 |

---

## 九、配置层：把「换供应商 / 改强度 / 禁工具 / 不调向量」从代码里挪出来

### 9.1 为什么要有 config.json，而不是全靠环境变量

环境变量在 DSH 里有两个硬伤：宿主从 GUI 启动时进程 env 是启动那一刻的快照，之后写进用户作用域的变量取不到；改完还得重启。配置文件的解法是 **按 `mtime` 热加载** —— `loadConfig()` 每次调用先 `statSync` 一次，mtime 没变直接返回缓存对象，变了就重新解析。代价是一次 `stat`（微秒级），换来「改完下一个请求就生效」。

优先级写成三级：`config.json` 非空值 > 环境变量（Windows 再兜一层 `HKCU\Environment` 注册表）> 内置默认值。环境变量保留是为了 CI / 容器能一次性注入，不为了日常改配置。

`apiKey` 只落在 `config.json`，而 `config.json` 进 `.gitignore`，仓库里只有 `config.example.json`。所有对外回吐（`atlas_config get`、`config-cli show`、`atlas_stats`）一律走 `configView()`，`apiKey` 经 `maskKey()` 脱敏，并额外报 `apiKeySource`（`config.json` / `env` / `none`）—— 排查「为什么还是旧 Key」时这一条比 Key 本身有用。

### 9.2 为什么 embedding 模型识别不能只靠正则

三家供应商的 `GET /models` 返回结构完全不同：OpenAI 只有 `{id}`；SiliconFlow 有 `type` / `sub_type`；Ollama 有 `details.family`；vLLM 常常只有 `id`。只写正则会在「id 里没有 embed 字样」时漏判，只看元数据会在「元数据缺失」时漏判。

所以 `isEmbeddingModel()` 是两段式：先看元数据里是否出现 `embed`（覆盖 `type` / `sub_type` / `pipeline_tag` / `task` / `capabilities` / `details.family`），再看 id 正则（`embed` / `bge-` / `e5-` / `gte-` / `nomic-embed` / `mxbai-embed` / `snowflake-arctic-embed` / `text-embedding` / `qwen3-embedding`），并且**先排除 `rerank`** —— rerank 模型的 id 里也常带 `bge`，不排掉就会被当成 embedding 选走，然后在 `/embeddings` 上 400。

### 9.3 禁用清单为什么不是「从目录里删掉」

目录是**事实**，推荐是**策略**。禁用一条技能的语义是「这次会话别推荐给我用」，不是「这条技能不存在」。所以：

- `atlas_search` 剔除（推荐层面生效），并在返回体里报 `disabledExcluded` 让主模型知道「候选少了，不是我漏了」；
- `atlas_browse` / `atlas_detail` 默认保留并标 `disabled: true`，只有 `hideDisabledInBrowse: true` 才彻底隐藏。

如果禁用等于删除，主模型就永远看不到「这条被禁了」，也就无法在换场景后主动提出「要不要启用它」。保留可见性 + 标注，比删掉信息量更大。

匹配同时认 `ref`（`skill/apk-unpack`）与 `name`（`apk-unpack`）：调用方通常只记得名字，配置里手写 ref 容易打错层级。

### 9.4 四档思考强度改的是什么

四档差异全部集中在 `EFFORT_PROFILES` 一张表里，而不是散在代码各处 if 里。改的是四个旋钮：

| 旋钮 | 含义 |
|---|---|
| `pathTop` | 路径层保留几条，决定 `matchedPaths` 的精细度 |
| `sceneMax` | 是否启用逐条场景软最大值 |
| `lexWeight` | 词元重合度的混合权重 |
| `sceneDetail` / `poolFactor` / `breakdown` | 回吐体积、候选池放大倍数、是否给 `scoreBreakdown` |

`low` → `high` 只调精度与体积，**不换打分口径**（权重仍是 0.55 / 0.24 / 0.21），这样同一份 `catalog.json` 在不同档位下的相对排序是稳定的，调参结论不会因为换档失效。

`xhigh` 是唯一会**改变排序**的档：候选池先放大到 `max(topK*3, 24)`，再用「场景 top3 均值」重排。理由是软最大值仍可能被单条强命中主导，而 top3 均值能区分「三条都相关」和「一条偶然很像」。重排只作用在放大后的池子里，代价是每次检索多算 `3 * poolSize` 次余弦（纯本地计算，不额外调 API）。

词元重合度（`lexScore`）解决的是向量模型的固有盲区：专有名词、命令名、文件名这类字面信号，语义向量往往给不出高分。中文按二元组切（无分词依赖），英文按 `[a-z0-9_./+-]{2,}` 切。权重给得很小（`high` 0.06 / `xhigh` 0.10），因为它只是补丁 —— 给大了会让「查询里恰好出现的词」压过真正的语义匹配。

### 9.5 `useLlmFallback`：为什么必须是硬短路

这个开关的语义是「不用向量模型」，所以实现上必须是**物理上不发请求**，而不是「发了但忽略结果」。`searchTools()` 第一行就 `if (conf.useLlmFallback) return fallbackSearch(...)`，而 `fallbackSearch()` 里不出现任何 `embed` / `embedBatch` / `vecForFill`。自测里专门有一条断言盯这件事：记下调用前的 `/embeddings` 计数，跑完一次 `atlas_search` 后计数必须不变。

排序退化为纯字面重合度（`lexScore`），但回吐的**信息量按档位放大**：没有向量分数可依，主模型只能读原文，所以 `high` 给前 40 条 + 分类概览，`xhigh` 给全量含完整 `invoke` / `avoid` / 路径名。`low` 反而给得最少（前 12 条精简）—— 这一档的定位是「省 token」。

写入侧同开关同语义：`atlas_upsert` / `atlas_link` / `atlas_commit` 跳过 `warmTool`（返回 `embeddingSkipped: true`），`atlas_reindex` 直接短路。否则「关掉向量」之后一次录入又会偷偷调一次 API。

### 9.6 自测怎么覆盖这套东西

`scripts/test-config.mjs` 起一个本地 mock 向量服务（`GET /models` + `POST /embeddings`），把 `server.mjs` 当真的 MCP 子进程拉起来，用临时 `ATLAS_DIR` 跑 42 项断言。关键点：

1. mock 的 `/models` 里放五种模型（有元数据的 embedding、只有 id 的 embedding、rerank、普通对话模型），验证识别规则的两段式与 rerank 排除；
2. 断言 `atlas_config get` 的回吐里**不含**测试用 Key 明文；
3. 逐档改 `reasoningEffort` 后立刻再检索，验证 mtime 热加载真的生效（不是重启才生效）；
4. 禁用 / 启用 / `hideDisabledInBrowse` 三种组合分别验 `atlas_search` 与 `atlas_browse`；
5. `useLlmFallback` 用计数器证明零请求。

这套测试不依赖真实 API Key，也不消耗额度，所以能进常规自检清单。
