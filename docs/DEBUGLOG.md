# 调试记录

这份日志按时间顺序记录 atlas 从零到可用的全过程：每一轮的**目的**、**假设**、**实测结果**、**结论**、**修法**。失败的部分保留原样 —— 它们是这份项目最有价值的内容。

所有数字都是当轮真实跑出来的，不是估计值。

---

## 0. 起点：为什么做这个

宿主原本的工具面有三套形态，都解决不了「按意图找工具」：

- 白名单式工具桥：无检索，过滤后全量 map。几百条工具里靠模型自己挑。
- MCP 连接器的 `tool_search`：字符串打分。`fieldIndex===0?300 : fieldIndex===1?180 : 80`，精确 +1000 / 前缀 +500 / 包含 +250，再减 `Math.min(field.length,200)/1000`，且 `terms.every(term => field.includes(term))` —— 所有词必须同时命中。
- 按 toolset 分组：只是分组，不是语义。

实测字符串检索的硬伤：**搜「跑命令」不会命中 `shell`**，因为 `shell` 的 name / title / description 里没有「跑」「命令」这两个字。而人说话时就是这个说法。

所以转向 embedding：把工具总结成「特点 + 应用场景」，向量化之后按意图相似度召回。

---

## 1. 首版：单向量，被自己的长文本稀释

**做法**：把 `name + display + kind + traits + scenes + paths` 全部拼成一段文本，embed 成一个向量；查询时算余弦。

**8 条真实查询的实测**：

| 查询 | top1 | 期望 | 结果 |
|---|---|---|---|
| 我想把一个安卓包脱壳看看里面逻辑 | elf-local-auth-patcher 0.6253 | deepseek-re | ✗ |
| 帮我在这个目录里找有没有哪个文件提到 token 校验 | embed-router 0.6345 | grep | ✗（grep 第 2） |
| 写个脚本批量重命名文件 | edit 0.6018 | shell | ✗（shell 未进 top4） |
| 这台机器上有个进程卡死了要杀掉 | remote_send_message 0.6314 | shell | ✗（shell 未进 top4） |
| 把这个大活拆给几个人分别做再汇总 | summon_experts 0.6669 | summon_experts | ✓ |
| 给文章配一张封面图 | generate_image 0.758 | generate_image | ✓ |
| 查一下最近关于这个病的论文 | pubmed 0.5747 | pubmed | ✓ |
| 跑命令 | wsl 0.7272 | shell | ✗（shell 0.6323 排第 4） |

**结论**：单向量会把「场景」信号稀释掉。`shell` 的场景有 28 条，拼成一段之后那 28 句的语言习惯被 `traits` 里「万能命令行执行器」这类抽象描述压过去了，而 `wsl` 的整段文本更短、更聚焦，余弦反而更高。

**修法**：拆成三路独立向量。

---

## 2. 三路向量 + 逐条场景软最大值

**做法**：

```
name   = [name, display, kind].join(' ')      权重 0.21
traits = traits + avoid                       权重 0.24
scenes = 逐条场景各成一个向量                  权重 0.55
```

场景维度的聚合先试了两种：

- **纯 max**：`s = max(逐条场景分)`。问题：一条偶然相似的场景词就能把无关工具顶上来。「今天天气怎么样」会命中某个带「今天」的工具。
- **纯 mean**：强命中的单条被大量无关场景拉平，`shell` 的 28 条场景反而吃亏。

**软最大值**：`0.75 * max + 0.25 * mean`。两头都压住。默认 `ATLAS_SCENE_MAX=1`（设 `0` 关掉，退回整段场景向量）。

三路加权后又拿 weighted 与 max 两种总打分模式做 25 条基准对比：

| 模式 | top1 | top3 | top5 |
|---|---|---|---|
| `weighted`（`s = sbest*0.55 + st*0.24 + sn*0.21`） | **24/25** | **25/25** | **25/25** |
| `max`（`s = max(sbest, st, sn*1.02)`） | 22/25 | 23/25 | 25/25 |

`max` 在跨域查询上更容易被单条偶然相似的场景词带偏。**保留 weighted 为默认**。

**改完「跑命令」这条**：`shell` 从第 4（0.6323）升到第 1（0.7282）。

---

## 3. floor：一开始用错了

**第一反应**：`shell`、`read` 这类通用工具老是排不上，给它们一个分数下限不就完了。

`floor.mjs` 首版给的：

```
shell 0.47   read 0.44   grep 0.44   glob 0.42   edit 0.42
write 0.42   web_search 0.44   web_fetch 0.43   todo_write 0.40
```

**结果：修好了想修的，也弄坏了不该动的**。后续一轮遇到「读一下这个项目的 README 写的啥」，`read` 只有 0.6306，被 `mnemon_document_search` 的 0.68 压着。当时想直接把 `read` 的 floor 提到 0.62。

**实测否决了这个想法**：

```
查询「今天天气怎么样」          全库最高分 screen_view 0.5279
查询「帮我给这段 python 代码加单元测试」  全库最高分 security-code-auditor 0.5822
```

`floor` 是**无条件兜底**（`if (s < floor) s = floor`）。`read` 一旦到 0.62，这两条查询里它都会霸榜第一 —— 一个只读文件的工具成了「今天天气」的答案。

**结论**：`floor` 的正确用法只有一个 —— 让通用兜底工具「永远可见」，而不是「更准」。它的合法区间是 `0.40`–`0.47`。

**修法**：`read` 保持 `0.44` 不动，改补它的 `scenes` 自然语言问法（6 条 → 12 条，加入「读一下这个项目的 README 写的啥」「把那个源码文件打开读一遍」「看一眼这个日志文件里的内容」等）；同时把竞争者 `mnemon_document_search` 的 `cap` 从 `0.68` 降到 `0.61`。

修完：`read` 0.7593 第 1（detail: name 0.5708 / traits 0.3936 / scenes 0.6707），`mnemon_document_search` 0.6100 第 2（被 cap 压住），`session_search` 0.5993。

复验「今天天气怎么样」时 **`read` 未进榜** —— 证明这条修法是对的。

---

## 4. cap：三轮校准，一次差点把基准打崩

**目的**：宽口径工具（历史会话检索、文档检索、专家列表）对任何查询都能给 0.65+，会把真正的精准工具挤下去。

**第一轮（`cap.mjs`）：一律 0.50** —— 太狠。

```
session_search 0.50   mnemon_document_search 0.50   mnemon_recall 0.48
list_experts 0.46     acp_status 0.44
```

后果：`session_search` 从 rank 2 被打到 **rank 21**。它在自己本该命中的「刚才那个报错的栈追踪是啥意思」「把上次聊的那个方案找出来」上都进不了 top3。

**第二轮（`cap2.mjs`）：回调到 0.58 区间**，同时给这些宽口径工具补具体场景（收紧语义边界）：

```
session_search 0.60   mnemon_document_search 0.58   mnemon_recall 0.55
list_experts 0.55     acp_status 0.50   compress 0.52   embed-router 0.56   todo_write 0.52
```

有改善，但 `session_search` 仍然偏弱。

**第三轮（`cap3.mjs`）：抬到最终值**，并补 `subagent` / `subagent_fork` / `agent_teams_status` / `security-code-auditor`：

```
session_search 0.70     mnemon_document_search 0.68   mnemon_recall 0.66
list_experts 0.64       acp_status 0.58    compress 0.60
embed-router 0.64       todo_write 0.60
subagent 0.66           subagent_fork 0.66
agent_teams_status 0.62 security-code-auditor 0.62
```

**结论**：`cap` 的语义是「拦住极端泛化」，不是「把它压到跟普通工具一样」。典型区间 `0.58`–`0.70`。

`web_search` 的 cap 值得单记一笔：它一开始没有 cap，在「把这个目录下的 json 配置里所有 timeout 值改大一点」这条上以 0.5841 抢了第一（正解应该是 `shell` / `grep`）。

先试 `cap = 0.59`，**又把基准打退了**：

```
「搜一下这个报错是什么原因」本尊 web_search 0.7313
cap 0.59 之后 → session_search 0.6307 第 1、grep 0.6198 第 2、web_search 第 3
基准从 top1 24/25 → 23/25
```

最终给 `0.65`：既能把「改配置」这条的伪命中压到第 2（0.5842，实际第 1 变成 `shell` 0.6587），又不影响真正的排障搜索。

---

## 5. 十四个查询的完整修前 → 修后对照

| # | 查询 | 修前 top1 | 修后 top1 | 处置 |
|---|---|---|---|---|
| 1 | 这台机器上有个进程卡死了要杀掉 | shell 0.7152 ✓ | shell 0.7132 ✓ | 无需改 |
| 2 | 写个脚本批量重命名这些文件 | shell 0.5975 ✓ | shell ✓ | 无需改 |
| 3 | 把这个大活拆给几个人分别做再汇总 | summon_experts 0.7175 ✓ | summon_experts 0.7177 ✓ | 无需改 |
| 4 | 查一下最近关于这个病的论文 | pubmed 0.6848 ✓ | pubmed ✓ | 无需改 |
| 5 | 跑命令 | shell 0.7282 ✓ | shell 0.7255 ✓ | 三路向量已修好 |
| 6 | 脱壳（限 re/unpack） | elf-local-auth-patcher ✓ | 同 ✓ | 无需改 |
| 7 | **读一下这个项目的 README 写的啥** | mnemon_document_search 0.68 ✗ | **read 0.7593** ✓ | 补 read 场景 + 降 document_search cap |
| 8 | 帮我截个图看看当前屏幕上是什么 | screen_view 0.8115 ✓ | screen_view 0.8115 ✓ | 无需改 |
| 9 | 今天天气怎么样 | 全库最高 0.5277（合理低分） | 全库最高 0.5279（合理低分） | 无需改；验证 read 不霸榜 |
| 11 | **把这个目录下的 json 配置里所有 timeout 值改大一点** | web_search 0.5841 ✗ | **shell 0.6587** ✓ | shell/grep/edit 补改配置场景 + web_search cap 0.65 |
| 12 | **帮我给这段 python 代码加单元测试** | security-code-auditor 0.5822 ✗ | **edit 0.6147** ✓ | 移除 auditor 错位场景 + 单元测试场景按职责拆给 edit/write/shell |

---

## 6. tune4 / tune5：一次整组覆盖引发的回归

**tune4 的意图**（落地审核意见）：`read` 补 6 条场景、`mnemon_document_search` cap 降到 0.61、`shell` 补 6 条改配置场景、`edit` 补 4 条、`grep` 补 3 条、`write` 补 6 条、`web_search` cap 0.65、`security-code-auditor` 移除错位场景。

**tune4 犯的错**：更新 `tool/write` 时把 `scenes` 直接**整组替换**成新的 6 条，覆盖掉了原有 9 条（含「把这几份文档合成一份」「导出结果到文件」）。

**回归现象**（自查 compare.mjs 发现）：

```
第 6 条「把这三份文档合成一份」  tool/write 从 Rank1 → Rank6
第 13 条「找一下项目里所有 yml 文件」 tool/glob 从 Rank1 → Rank2   ← grep 新场景抢活
weighted 从 top1 24/25 → 22/25，top3 从 25/25 → 24/25
```

注意失败出现在**完全无关的查询**上 —— 「三份文档合成一份」跟「补单元测试场景」八竿子打不着。这正是整组覆盖最阴的地方：改 A 坏了 B。

**tune5 修法**：

1. `tool/write` 的 `scenes` 恢复为**原 9 条 + 新增 3 条 = 12 条**（新增加的是「新建一个测试文件」「把这段实现拆成新模块文件写出去」「整体写出一份新文档」）；
2. `tool/grep` 删掉「在改之前先定位这些字段出现在哪些文件」这条（它抢 `glob` 的活），只保留「按内容搜配置键」类表述。

修完基准回到 **top1 24/25 · top3 25/25 · top5 25/25**。

**教训（已写进 README 硬规矩）**：改 `scenes` 必须读出原数组再 `concat`，禁止整组覆盖。

---

## 7. 工程化：四道自检 + 文档防脱节

### 7.1 `doc-check.mjs` 的致命漏检

第一版校验逻辑在**全文**里查 `${s.categories} 个总分类` 等字符串。

**问题**：快照块是脚本自己渲染的，本身含这些正确数字。于是正文写成旧数字也永远能通过 —— 等于没校验。

**修法**：只在**快照块之外**的散文里比对：

```js
const outside = got
  ? text.slice(0, text.indexOf(START)) + text.slice(text.indexOf(END) + END.length)
  : text;
```

改完立刻拦下 5 处真漂移（正文仍写「10 分类 / 24 子分类 / 47 工具 / 467 向量」，磁盘已是 11/29/50/506）。

**第二条漏检**：当断言文案里写 `` `session_search` 第 1 `` 而正文里带反引号时匹配不到。修法：比对前 `const stripped = outside.replace(/`/g, '')`。

### 7.2 `saveState` 的两个真 bug

**bug 1：并发写抢同一个 tmp 文件**

```
Error: ENOENT: no such file or directory,
       rename '...\discover-state.json.tmp' -> '...\discover-state.json'
```

原因：tmp 名固定 `${STATE_FILE}.tmp`，两个进程同时写会互相把对方的 tmp 搬走。

修法：tmp 名带 pid + 随机后缀：

```js
`${STATE_FILE}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
```

**bug 2：漏了 `await`**

`atlas_commit` / `atlas_ignore` 两处 `saveState(st)` 忘了 `await`，进程还没写完就返回了响应。表现是测试随机读到半截状态。

修法：全部补成 `await saveState(st);`。

### 7.3 进程内 catalog 缓存导致的测试误报

`atlas_stats` 读的是进程内缓存。自测删条目后再调 `atlas_stats`，读到的是**删前快照**，于是断言「清理干净了」失败。

修法：所有「清理是否彻底」的判定改为**直读磁盘 `catalog.json``，不信 `atlas_stats`。

同源现象在生产里也出现过一次：磁盘已是 10 分类 / 30 子分类，但 `atlas_stats` 连续几轮都报 11 / 32 且带着一个空的 `selftest` 分类 —— 直到进程重启后才恢复真值。**这是缓存滞后，不是数据错。**

### 7.4 测试残留：`selftest` 分类反复出现

`test-discover.mjs` 每跑一次就往 catalog 里塞一个 `selftest` 总分类（含 discover / other 两个子分类），清理段落只删了工具 ref，**没删空分类本身、也没清 `discover-state.json`**。

结果：跑完测试，下一次 `atlas_discover` 又把 `skill/__atlas_selftest__` 算成 pending。

修法（`scripts/test-discover.mjs` 清理段）：

```js
// 清完工具后若 selftest 分类已无任何工具，连分类一起删
cat4.categories = (cat4.categories || []).filter((cat) => {
  if (cat.id !== 'selftest') return true;
  return (cat.subs || []).some((sb) => (sb.tools || []).length > 0);
});

// discover-state.json 里的测试 ref 一并清掉
const STATE = path.join(ATLAS_DIR, 'discover-state.json');
const st = JSON.parse(readFileSync(STATE, 'utf8'));
if (st.items && st.items[TEST_REF]) {
  delete st.items[TEST_REF];
  writeFileSync(STATE, JSON.stringify(st, null, 2));
}
```

并加两条回归断言：`清理后不留空的 selftest 分类`、`清理后总分类数回到 10`。改完连跑两次 verify，磁盘稳定。

---

## 8. 发现层：78 条批量归纳把基准打下去了

**背景**：发现层扫出 90 条去重后条目（51 个技能源 / 5 个 MCP server / 65 个 MCP 工具），其中 78 条待归纳。

**分 5 批 `atlas_commit` 全部落库**（每批 dim 均 2560），catalog 从 50 条涨到 128 条（tool 35 / mcp 8 / skill 85）。

**副作用**：新来的 85 条技能里有几条 traits/scenes 写得太泛，抢了原本由工具占的第一：

```
「画赛博朋克风格的城市夜景」
  skill/wbexpert__ai-image-prompt-engineer__canvas-design 0.6442  ← 抢了
  tool/generate_image                                      0.6394
  分项：n=0.5902  t=0.4774  s=0.5333
```

**修法**：给三条新竞争者加 cap，不动它们的 scenes（避免重演 tune4 的覆盖事故）：

```
skill/apk-unpack            0.70
skill/chart-visualization   0.66
skill/canvas-design         0.66 → 实测仍不够，压到 0.62 后恢复
```

修完基准回到 **top1 24/25 · top3 25/25 · top5 25/25**，与归并前持平。

**结论**：目录扩容时，新条目的 `cap` 是先手 —— 先封顶再加数据，比事后调 scenes 便宜得多。

---

## 9. 工程化收尾时又踩的一个坑

把 19 个调试脚本从仓库根收进 `scripts/` 之后：

1. `selftest.mjs` 里两处硬编码的 `C:\Users\<name>\.dsh\tool-atlas\...` 依赖 `path` 却没 import → `ReferenceError`。
2. `test-discover.mjs` 原本解构了 `{ ATLAS_DIR }`，但代码里还用到 `SERVER` / `CATALOG` → `ReferenceError: SERVER is not defined`。
3. `doc-check.mjs` 的 `const DIR = path.dirname(fileURLToPath(import.meta.url))` 在移进 `scripts/` 后指向了 `scripts/`，找 catalog 找错地方。

统一修法：新增 `scripts/_paths.mjs` 作为唯一路径来源，优先级 `ATLAS_DIR 环境变量 > 仓库根（若含 catalog.json）> ~/.dsh/tool-atlas`；`doc-check.mjs` 的 `DIR` 改成 `path.resolve(..., '..')` 指回仓库根。

修完 20 个脚本 `node --check` 全绿，三套自检（`selftest` / `test-discover` / `doc-check`）全部 PASS。

---

## 附：环境相关的两个坑

**1. PowerShell 的 `.Replace()` 会把 `` `r`n `` 当字面量写进 JS 源文件**

用它拼换行会产出 `}`r`n    await saveVecDisk();` 这种行，`node --check` 报 `SyntaxError: Unexpected identifier 'n'`。

**不要用 shell 字符串替换来插换行**，直接用编辑器或 `edit` 工具。

**2. PowerShell 写文件会加 UTF-8 BOM**

首 3 字节 `239,187,191` 会让 `node --check` 报 `SyntaxError: Invalid or unexpected token` 并指向 `#!/usr/bin/env node`。

修法：

```powershell
[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
```

正确首 3 字节应为 `35,33,47`。
