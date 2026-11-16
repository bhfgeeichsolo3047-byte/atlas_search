# 调参手册

这份文档给出 atlas 每一个可调参数的**取值区间、判断标准、修改方法**，以及踩过的具体坑。数据以当前 `catalog.json` 实测为准（10 个总分类 / 30 个子分类 / 128 条工具 / 1030 条向量）。

调参的目标不是「让分数更高」，而是**让正确的工具排到第一，同时不误伤无关查询**。这两件事经常冲突，所以每次改完必须跑 25 条基准。

---

## 一、参数总览

| 参数 | 位置 | 合法区间 | 作用 |
|---|---|---|---|
| `ATLAS_W_SCENE` | 环境变量 | 0–1 | 场景向量权重，默认 `0.55` |
| `ATLAS_W_TRAIT` | 环境变量 | 0–1 | 特点向量权重，默认 `0.24` |
| `ATLAS_W_NAME` | 环境变量 | 0–1 | 名称向量权重，默认 `0.21` |
| `ATLAS_SCENE_MAX` | 环境变量 | `1` / `0` | 逐条场景软最大值开关，默认开 |
| `ATLAS_SCORE_MODE` | 环境变量 | `weighted` / `max` | 总打分模式，默认 `weighted` |
| `floor` | 每条工具 | `0.40`–`0.47` | 分数无条件下限 |
| `cap` | 每条工具 | `0.58`–`0.70` | 分数无条件上限 |
| `scenes` | 每条工具 | 3–34 条 | 用户真实会说的话 |
| `traits` | 每条工具 | 一句话 | 工具是什么、怎么干活、什么坑 |
| `avoid` | 每条工具 | 一句话 | 什么时候别用它（进 `summary`，不参与打分） |
| `paths` | 每条工具 | ≥1 条 | `[总分类, 子分类]`，可多条 |

三个权重加起来建议等于 `1.0`。改权重比改 floor/cap 影响面大得多，除非数据分布彻底变了，否则不要动。

---

## 二、`scenes` —— 唯一真正影响准确度的字段

### 写什么

**写用户真实会说的那句话**，不要写归纳。

| 好 | 坏 |
|---|---|
| 把这台机器上卡死的进程杀掉 | 用于进程管理 |
| 帮我在这个目录里找有没有文件提到 token 校验 | 文件内容搜索 |
| 把这三份文档合成一份 | 文档合并操作 |

向量模型匹配的是**语言习惯**，不是意图分类。写归纳等于让用户先学会你的分类体系，而他不会。

### 写多少

当前 128 条平均 4.6 条。分布严重不均是有意为之：

| 工具 | scenes | 理由 |
|---|---|---|
| `tool/shell` | 34 | 万能执行器，用户能用 shell 做的事无穷多 |
| `mcp/pubmed` | 18 | 医学检索的问法极其分散（查病／查药／查临床试验／查引用） |
| `tool/read` | 12 | 「读文件」的说法至少有十来种 |
| `tool/write` | 12 | 新建／整份覆盖／落盘／导出，都算 |
| `mcp/openalex` | 12 | 学术检索的多种问法 |
| `tool/session_search` | 12 | 历史会话检索的多种口语表述 |
| `tool/edit` | 11 | 精确改单文件的各种说法 |
| `tool/grep` | 10 | 按内容搜索的各种说法 |
| 其余 120 条 | 3–8 | 场景相对收敛 |

**判断标准**：这个工具被用户「用不同的说法请求」的可能有多少。说法收敛的给 3–5 条就够，多写反而稀释。

### 硬规矩：必须 concat，禁止整组覆盖

```js
// 正确
const t = c.tools[ref];
t.scenes = [...(t.scenes || []), ...NEW_SCENES.filter(x => !(t.scenes || []).includes(x))];

// 错误 —— tune4 就是这么把基准从 24/25 打到 22/25 的
c.tools[ref].scenes = NEW_SCENES;
```

整组覆盖最阴的地方：**失败出现在完全无关的查询上**。当时替换了 `tool/write` 的 9 条场景，结果「把这三份文档合成一份」从第 1 掉到第 6 —— 这条跟「补单元测试场景」八竿子打不着。

---

## 三、`floor` —— 只用来「保底可见」

### 语义

```js
if (t.floor > 0 && s < t.floor) s = t.floor;
```

**无条件**。不管查询是什么，只要算出来低于 floor，就直接拉到 floor。

### 当前取值（共 9 条）

| 工具 | floor | 理由 |
|---|---|---|
| `tool/shell` | 0.47 | 最高。任何「跑个命令」的意图都应该看到它 |
| `tool/read` | 0.44 | 读文件是极高频动作 |
| `tool/grep` | 0.44 | 按内容搜索 |
| `tool/web_search` | 0.44 | 联网查证 |
| `tool/web_fetch` | 0.43 | 抓网页正文 |
| `tool/write` | 0.42 | 写文件 |
| `tool/edit` | 0.42 | 改文件 |
| `tool/glob` | 0.42 | 按路径找文件 |
| `tool/todo_write` | 0.40 | 任务清单，兜底性质 |

### 什么时候该调

**只有一种情况**：这个通用工具在大量正常查询里进不了 top5，用户根本看不到它。

### 什么时候绝对不该调

想用它解决「某个具体查询命中了错的工具」。**这不归 floor 管**。

实测反例（差点写进代码的错误决定）：

```
想把 read 的 floor 从 0.44 提到 0.62，解决「读 README 被 document_search 抢」
实测：
  「今天天气怎么样」              全库最高 screen_view 0.5279
  「帮我给这段 python 代码加单元测试」 全库最高 security-code-auditor 0.5822
  → read 一旦到 0.62，这两条查询里它都会霸榜第一
```

一个只读文件的工具成了「今天天气怎么样」的答案 —— 比原来的问题严重得多。

**正确解法**：补 `scenes` 的自然语言问法（让真实向量分自己上去），压低竞争者的 `cap`。

修完实测：`read` 0.7593 第 1，`mnemon_document_search` 0.6100 第 2（被 cap 压），`session_search` 0.5993，「今天天气怎么样」时 `read` 未进榜。

### 判断一个 floor 是否合适的小测试

跑 `scripts/smoke.mjs` 里那条**故意跨域**的查询（「今天天气怎么样」）。如果某个 floor 工具出现在 top3，说明它的 floor 太高了。

---

## 四、`cap` —— 拦住「对什么查询都很高」的泛化

### 语义

```js
if (t.cap > 0 && s > t.cap) s = t.cap;
```

同样是**无条件**。它的用途与 floor 相反：floor 保证低分工具可见，cap 防止高分工具霸榜。

### 当前取值（共 17 条）

| 工具 | cap | 为什么需要 |
|---|---|---|
| `tool/session_search` | 0.70 | 「找上次聊的」「刚才那个报错」类查询都 0.7+，但它的真实职责只是翻历史 |
| `skill/apk-unpack` | 0.70 | 通用脱壳技能，对任何逆向问法都给高分 |
| `tool/subagent` | 0.66 | 派遣单个子代理，语义极宽 |
| `tool/subagent_fork` | 0.66 | 同上 |
| `tool/mnemon_recall` | 0.66 | 记忆召回，对任何「想知道 X」都高分 |
| `skill/chart-visualization` | 0.66 | 「画个图」类说法通吃 |
| `tool/web_search` | 0.65 | 见下文专门一节 |
| `tool/list_experts` | 0.64 | 「找个专家」语义宽 |
| `mcp/embed-router` | 0.64 | 语义检索，对任何查询都给分 |
| `mcp/tool-atlas` | 0.64 | 工具检索自身，宽口径 |
| `skill/security-code-auditor` | 0.62 | 「检查代码」类通吃 |
| `tool/agent_teams_status` | 0.62 | 团队状态查询 |
| `skill/wbexpert__ai-image-prompt-engineer__canvas-design` | 0.62 | 设计类说法通吃 |
| `tool/mnemon_document_search` | 0.61 | 见下文专门一节 |
| `tool/todo_write` | 0.60 | 任务清单 |
| `tool/compress` | 0.60 | 上下文压缩 |
| `tool/acp_status` | 0.58 | 上下文用量查询 |

### 三轮校准史（这三次都写进了 DEBUGLOG）

| 轮次 | 做法 | 结果 |
|---|---|---|
| `cap.mjs` | 一律压到 0.50 / 0.48 / 0.46 | **打崩**。`session_search` 从 rank 2 → rank 21 |
| `cap2.mjs` | 回调到 0.55–0.60 | 有改善，`session_search` 仍偏弱 |
| `cap3.mjs` | 抬到 0.58–0.70 | 定稿 |

**结论**：cap 的语义是「拦住极端泛化（0.70+ 到处乱窜）」，不是「压到跟普通工具一样」。**区间 `0.58`–`0.70`**。

### 两个专门记录

**`mnemon_document_search` 从 0.68 → 0.61**

`0.68` 时它抢走了「读一下这个项目的 README 写的啥」（0.68 第 1，`read` 0.6306 第 2）。降到 `0.61` 后 `read` 靠补足的 scenes 拿到 0.7593 第 1，它退到 0.6100 第 2 —— 正好是「被 cap 压住但仍在候选里」的理想状态。

它的 `avoid` 也同步改成：「个人偏好用 recall；已知具体文件路径（如 README、配置或源码）直接读用 read」。

**`web_search` 从无 → 0.65**

无 cap 时它在「把这个目录下的 json 配置里所有 timeout 值改大一点」上以 0.5841 抢第一（正解是 `shell` / `grep`）。

先试 `0.59`，**又把基准打退**：

```
「搜一下这个报错是什么原因」
  本尊 web_search 0.7313
  cap 0.59 → session_search 0.6307 第 1、grep 0.6198 第 2、web_search 第 3
  基准 top1 24/25 → 23/25
```

最终 `0.65`：既把「改配置」的伪命中压到第 2（0.5842，第 1 变成 `shell` 0.6587），又不影响真正的排障搜索。

**教训**：宽口径检索类工具的 cap 必须给足它的真实命中分。压得太狠等于把它从正确场景里也删掉了。

---

## 五、`paths` —— 一工具多路径

### 为什么允许重复挂载

`tool/shell` 挂三条路径：

```
["code",  "build"]   编译跑测试
["auto",  "system"]  看进程看端口
["auto",  "remote"]  远程执行
```

如果强行只归一类，无论归哪类，另外两类查询都会失配。**归类不该成为通用性的代价**。

### 当前分布

| 总分类 | 中文名 | 子分类 | 工具数（含重复挂载） |
|---|---|---|---|
| `re` | 逆向工程 | 6 | 53 |
| `code` | 编程开发 | 4 | 37 |
| `agent` | 智能体编排 | 4 | 31 |
| `auto` | 系统自动化 | 3 | 26 |
| `data` | 数据处理 | 3 | 23 |
| `media` | 媒体生成 | 2 | 21 |
| `memory` | 记忆与知识 | 2 | 19 |
| `net` | 网络通信 | 3 | 15 |
| `research` | 信息研究 | 2 | 10 |
| `sec` | 安全测试 | 1 | 6 |

（工具总数 128，上表求和 241，差额来自多路径挂载。）

### 路径层怎么影响检索

`matchedPaths` 的全量子分类向量先打分，前 4 名给工具分加成：

```
第 1 名 +0.050    第 2 名 +0.038    第 3 名 +0.026    第 4 名 +0.014
```

所以路径文本（`cat.name | cat.desc | sub.name | sub.desc`）也会被匹配。子分类的 `desc` 写得越具体越好 —— 它是「意图 → 领域」的第一层信号。

**注意**：`paths` 只是弱信号。`auditProtocol` 第 4 步明确要求主模型把它当弱信号看，最终还是要看 `scenes` 是否真对上子目标。

---

## 六、三路向量权重

### 默认值

```
scenes  0.55    ← 用户怎么说（最贴意图）
traits  0.24    ← 工具是什么、怎么做
name    0.21    ← 名字（最短，信号最弱）
```

### 为什么 scenes 权重最高

首版单向量（全部字段拼一段）的实测：`shell` 的 28 条场景被 `traits` 里「万能命令行执行器」这种抽象描述稀释，「跑命令」只排第 4（0.6323）。

拆成三路并让 scenes 占 0.55 之后，同一条查询 `shell` 升到第 1（0.7282）。

### 什么时候该改权重

基本不该改。真要改，先跑 `scripts/compare.mjs` 建立基线，改完再跑，两边对比：

```
weighted 模式（默认）：top1 24/25  top3 25/25  top5 25/25
max 模式：             top1 22/25  top3 23/25  top5 25/25
```

`max` 模式（`s = max(场景分, 特点分, 名称分*1.02)`）在跨域查询上更容易被单条偶然相似的场景词带偏，所以只作为对照保留。

---

## 七、标准调参流程

**每次改动都必须走完五步**，缺一步就会出 tune4 那种事故。

```
1. 建立基线
   node scripts/compare.mjs > baseline.txt

2. 改数据
   用 scripts/*.mjs 或 MCP 的 atlas_upsert
   —— scenes 必须 concat，禁止整组覆盖

3. 重算向量
   node scripts/reindex.mjs --force
   （或者 MCP 的 atlas_reindex({ force: true })）

4. 三重回归
   node scripts/compare.mjs      # 25 条基准不许退
   node scripts/selftest.mjs     # 协议与工程自检
   node scripts/test-discover.mjs # 发现层 34 项

5. 同步文档
   node scripts/doc-check.mjs --write   # 重渲染快照块
   node scripts/doc-check.mjs           # 校验，漂移则 exit 1
```

第 5 步是硬性收尾：README 里 `AUTOGEN:ATLAS_SNAPSHOT_START` / `END` 之间的区块由脚本从 `catalog.json` 与 `vectors.json` 直接渲染，手改无效；正文里的规模数字若与磁盘事实不一致，`doc-check.mjs` 会以 exit 1 拦下。

---

## 八、目录扩容时先加 cap

发现层可以一次带进几十条新条目。批量归纳之后，新条目的 `traits` / `scenes` 往往写得比较泛，会抢走原有工具的第一名。

实测案例：85 条技能入库后，「画赛博朋克风格的城市夜景」被 `skill/...canvas-design` 以 0.6442 抢走（`tool/generate_image` 0.6394），基准从 24/25 掉到 21/25。

**最便宜的修法是只给新竞争者加 cap，不动它的 scenes**（动 scenes 有覆盖风险）：

```
skill/apk-unpack            0.70
skill/chart-visualization   0.66
skill/canvas-design         0.66 → 实测仍不够，压到 0.62 后恢复
```

先封顶再加数据，比事后调 scenes 便宜得多。

---

## 九、发现层参数

| 位置 | 值 | 说明 |
|---|---|---|
| `discoverAll` 去重键 | frontmatter `name` | 同一技能常被多个 agent 目录共享（软链或复制），不去重会算成多条 |
| 优先级 | `explicit`(0) > `preset`(1) > `convention`(2) | 同优先级保留先见到的，其余路径记进 `mirrors` |
| `buildProposal` 默认 `limit` | 6 | 上限 20。一次给主模型 6 条材料，读完再拿下一批 |
| `bodyExcerpt` 截断 | 1600 字 | 技能正文压缩空白后截断，够判断定位，又不至于塞满上下文 |
| `files` 上限 | 20 项 | 只列文件名（目录带尾斜杠），不读内容 |
| MCP 条目的 `sample` | 前 5 个工具名 | `verbose: true` 时附带 400 字描述 |

发现层的四条约定、五种 status、标准流程见 `README.md` 的「发现层」章节。

---

## 十、故障速查

| 症状 | 原因 | 处置 |
|---|---|---|
| 检索返回空 `[]` | `SILICONFLOW_API_KEY` 没生效 | `resolveKey()` 会从 `HKCU\Environment` 兜底；仍失败则手设环境变量 |
| 新条目搜不到 | 忘了 `reindex` | `node scripts/reindex.mjs --force` |
| `atlas_stats` 数字跟磁盘不一致 | 进程内 catalog 缓存滞后 | 正常现象，重启进程即恢复；判定以磁盘 `catalog.json` 为准 |
| `doc-check` 报漂移 | 改了数据没同步文档 | `node scripts/doc-check.mjs --write` |
| `saveState` 报 ENOENT rename | 并发写同一 tmp 文件 | 已修（tmp 名带 pid + 随机后缀）；若复发检查是否退回了旧版 |
| `atlas_commit` 后状态没变 | 漏了 `await saveState` | 已修；检查是否退回了旧版 |
| 发现层报某技能 `pending` 但目录里没有 | 源路径变了 | `atlas_discover` 会报 `missing`，确认后 `atlas_ignore` 或修正源路径 |
