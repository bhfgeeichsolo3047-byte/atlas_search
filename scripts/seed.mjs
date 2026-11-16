#!/usr/bin/env node
// 一次性播种：把本地工具库三层目录灌进 atlas（通过 MCP stdio 调 atlas_upsert）
import { spawn } from 'node:child_process';
import { SERVER } from './_paths.mjs';

const NODE = process.execPath;

const CATS = [
  { id: 'code', name: '编程开发', desc: '写代码、改代码、调试、重构、测试、依赖管理、Git 操作' },
  { id: 're', name: '逆向工程', desc: '反编译、脱壳、动态调试、二进制补丁、协议还原、混淆分析' },
  { id: 'sec', name: '安全测试', desc: '渗透测试、漏洞扫描、凭证攻击、提权、无线、Web 安全、社工' },
  { id: 'net', name: '网络通信', desc: '抓包、端口扫描、代理隧道、DNS、HTTP 调试、CDN 溯源' },
  { id: 'data', name: '数据处理', desc: '文件检索、文本处理、结构化数据、数据库、日志分析、统计' },
  { id: 'media', name: '媒体生成', desc: '图像生成、图像编辑、语音合成、视频、UI 渲染' },
  { id: 'research', name: '信息研究', desc: '网络搜索、学术检索、文献查询、网页抓取、事实核查' },
  { id: 'auto', name: '系统自动化', desc: '桌面操作、窗口控制、剪贴板、进程管理、注册表、WSL、远程机器' },
  { id: 'agent', name: '智能体编排', desc: '派发子代理、专家召唤、团队协作、任务板、工作流、技能加载' },
  { id: 'memory', name: '记忆与知识', desc: '持久记忆、项目文档、历史会话检索、上下文压缩管理' },
  { id: 'misc', name: '其他', desc: '暂未归类' },
];

const SUBS = [
  ['code', 'edit', '代码编辑', '读写改写源码文件、批量替换、格式化、跨文件定位'],
  ['code', 'debug', '调试排错', '复现问题、读堆栈、加日志、定位根因、验证修复'],
  ['code', 'build', '构建运行', '编译、打包、跑测试、起服务、依赖安装'],
  ['code', 'git', '版本控制', '提交、分支、工作树、diff 审查、冲突处理'],
  ['re', 'static', '静态分析', '反汇编、反编译、伪代码、控制流、符号恢复'],
  ['re', 'dynamic', '动态调试', '断点、hook、内存读写、寄存器、运行时跟踪'],
  ['re', 'unpack', '脱壳还原', '加壳识别、dump、IAT 修复、OEP 定位'],
  ['re', 'patch', '补丁改造', '字节补丁、跳转改写、重签名、功能复验'],
  ['sec', 'web', 'Web 安全', '注入、XSS、SSRF、上传、越权、WAF 绕过'],
  ['sec', 'cred', '凭证攻击', '爆破、撞库、哈希破解、票据滥用、MFA'],
  ['sec', 'privesc', '提权横向', '本地提权、域内横向、服务滥用、内核利用'],
  ['sec', 'wireless', '无线近场', '握手包、PMKID、蓝牙、RFID'],
  ['net', 'scan', '扫描探测', '端口、服务、指纹、子域、目录'],
  ['net', 'proxy', '代理隧道', '代理池、SOCKS、端口转发、内网穿透'],
  ['net', 'http', 'HTTP 调试', '请求构造、抓包、证书、DNS'],
  ['data', 'file', '文件检索', '按名找文件、按内容搜、语义搜片段'],
  ['data', 'text', '文本处理', '替换、抽取、格式转换、正则'],
  ['data', 'db', '数据库', '查询、迁移、结构分析'],
  ['media', 'image', '图像', '生成、编辑、风格迁移、看图'],
  ['media', 'ui', '界面渲染', '卡片渲染、图表、交互组件'],
  ['research', 'web', '网络检索', '搜索、抓网页、聚合'],
  ['research', 'paper', '学术文献', '论文检索、元数据、引用、全文'],
  ['auto', 'desktop', '桌面控制', '点击、输入、窗口、截图'],
  ['auto', 'system', '系统管理', '进程、注册表、环境变量、服务'],
  ['auto', 'remote', '远程执行', '远程主机、SSH、WSL、跨机文件'],
  ['agent', 'dispatch', '代理派发', '子代理、专家召唤、批量小队'],
  ['agent', 'team', '团队协作', '建队、任务板、认领、审批、评审'],
  ['agent', 'skill', '技能加载', '技能检索、技能正文加载'],
  ['memory', 'mem', '持久记忆', '记事实、召回、热记忆维护'],
  ['memory', 'doc', '项目文档', '长文档写入、检索、归档'],
];

const TOOLS = [
  // ---- 代码 ----
  { ref: 'tool/read', name: 'read', display: '读文件', kind: 'tool',
    traits: '按行读取本地 UTF-8 文本文件，带行号返回，支持 offset/limit 分页，大文件必须分页读',
    scenes: ['要看清某个文件的实际内容', '改文件前先确认现状', '读配置、日志、源码片段'],
    avoid: '查文件路径用 glob；按内容搜用 grep；不要用 shell 的 cat/head/tail',
    invoke: 'read({file_path, offset?, limit?})', paths: [['code', 'edit'], ['data', 'file']] },
  { ref: 'tool/write', name: 'write', display: '写文件', kind: 'tool',
    traits: '整体创建或覆盖一个 UTF-8 文本文件，父目录自动建；覆盖已有文件前必须先 read 过它',
    scenes: ['新建源码/脚本/配置/文档', '整文件重写', '落盘完整产出物'],
    avoid: '局部改动优先 edit；不确定原内容时不要直接覆盖',
    invoke: 'write({file_path, content})', paths: [['code', 'edit']] },
  { ref: 'tool/edit', name: 'edit', display: '精确替换', kind: 'tool',
    traits: '按字面量替换文件中的一段文本，old_string 必须唯一匹配（否则报错），支持 replace_all',
    scenes: ['改一行 schema', '替换一段配置值', '修正函数实现', '批量改同一处'],
    avoid: '大范围重写用 write；需要正则应走脚本',
    invoke: 'edit({file_path, old_string, new_string, replace_all?})', paths: [['code', 'edit']] },
  { ref: 'tool/glob', name: 'glob', display: '按路径找文件', kind: 'tool',
    traits: '按 glob 模式匹配文件路径（不是目录），含隐藏与忽略文件，按修改时间排序返回最多 100 条',
    scenes: ['不知道文件在哪先定位', '列某个目录下的所有 .ts', '找最近改过的文件'],
    avoid: '按内容找用 grep；不要用 shell find',
    invoke: 'glob({pattern, path?})', paths: [['code', 'edit'], ['data', 'file']] },
  { ref: 'tool/grep', name: 'grep', display: '按内容搜索', kind: 'tool',
    traits: 'ripgrep 正则搜索文件内容，返回带行号的匹配行，按文件分组，上限 250 条',
    scenes: ['找某个函数/常量在哪定义', '找所有调用点', '搜配置键', '定位报错文案'],
    avoid: '按文件名找用 glob；不要用 shell grep/rg',
    invoke: 'grep({pattern, path?, include?})', paths: [['code', 'edit'], ['data', 'text'], ['data', 'file']] },
  { ref: 'tool/shell', name: 'shell', display: '终端执行', kind: 'tool',
    traits: '在用户配置的默认终端里跑一条命令并回收 stdout/stderr，每次新进程不保留 cwd 与变量，需持久状态用 terminal_open；受 DSH 沙箱约束',
    scenes: ['跑构建/测试/安装依赖', '调用 node/python/curl 等 CLI', '批量文件操作', '取系统信息'],
    avoid: '要看文本文件内容用 read；要持久 shell 状态用 terminal_open；要交互 stdin 用 terminal',
    invoke: 'shell({command, description, workdir?, run_in_background?})', paths: [['code', 'build'], ['auto', 'system'], ['auto', 'remote']] },
  { ref: 'tool/terminal_open', name: 'terminal_open', display: '持久终端', kind: 'tool',
    traits: '开一个持久终端会话（PTY），跨调用保留 cwd 与变量，可发信号、可读屏幕；出现在用户侧栏',
    scenes: ['跑 dev server / watcher', '需要交互 stdin 的程序', 'repl、ssh、数据库客户端', '多步命令保留状态'],
    avoid: '一次性命令用 shell 更快',
    invoke: 'terminal_open({type:"shell", cwd?, name?})', paths: [['code', 'build'], ['auto', 'system']] },
  { ref: 'tool/todo_write', name: 'todo_write', display: '任务清单', kind: 'tool',
    traits: '记录并更新多步任务清单，勾选完成状态，整表替换',
    scenes: ['多步骤工作开工前列计划', '向用户展示进度'],
    avoid: '单步琐事不需要',
    invoke: 'todo_write({todos:[{content, status}]})', paths: [['agent', 'team']] },

  // ---- 逆向 ----
  { ref: 'mcp/craft-anything', name: 'craft-anything', display: '二进制分析台', kind: 'mcp',
    traits: 'MCP 二进制/应用分析工作台：打开 PE/ELF/Mach-O/APK/IPA/ASAR/文件夹为 target，出概览、函数档案、伪代码、汇编、基本块、调用图、字符串导入导出、加固检测、归档对比、特征追踪；Clean room 只做外部观察，Deep mode 接 Ghidra 读内部',
    scenes: ['看清一个二进制是什么、用什么写的、有没有壳', '分析某个函数怎么工作', '对比两个版本的产物差异', '追一个界面文案到实现代码', '解 APK/IPA/Electron 包结构'],
    avoid: '纯源码问题用 read/grep；要动态跑起来调试需要 Deep mode 或 Frida toolset',
    invoke: 'core_target_open({path}) → core_overview_show / native_function_study / core_feature_find',
    paths: [['re', 'static'], ['re', 'unpack'], ['sec', 'web']] },
  { ref: 'skill/deepseek-re', name: 'deepseek-re', display: '逆向总纲技能', kind: 'skill',
    traits: '逆向工程方法论技能：从样本识别到静态动态结合的完整流程、工具链选择、证据链要求',
    scenes: ['开一个新的逆向任务前先定路线', '不确定该用 IDA 还是 Ghidra 还是 radare'],
    avoid: '已有明确工具方向时不必加载',
    invoke: 'skill({name:"deepseek-re"})', paths: [['re', 'static'], ['re', 'dynamic']] },
  { ref: 'skill/ida-reverse', name: 'ida-reverse', display: 'IDA 逆向技能', kind: 'skill',
    traits: 'IDA Pro 逆向辅助技能，覆盖反编译、交叉引用、类型恢复、脚本批处理',
    scenes: ['用 IDA 分析 exe/dll/so/elf/macho', '找密码、找算法、漏洞分析'],
    avoid: '没装 IDA 时改用 ghidra-analysis',
    invoke: 'skill({name:"ida-reverse"})', paths: [['re', 'static']] },
  { ref: 'skill/ghidra-analysis', name: 'ghidra-analysis', display: 'Ghidra 分析技能', kind: 'skill',
    traits: 'Ghidra 无头/图形分析流程，反编译与脚本自动化',
    scenes: ['无 IDA 许可证时的反编译', '批量函数分析', '脚本化提取'],
    avoid: '需要 IDA 特有功能时用 ida-reverse',
    invoke: 'skill({name:"ghidra-analysis"})', paths: [['re', 'static']] },
  { ref: 'skill/elf-local-auth-patcher', name: 'elf-local-auth-patcher', display: 'ELF/APK 授权补丁', kind: 'skill',
    traits: 'APK/ELF 本地授权替换、卡密校验替换、AArch64 分支补丁、loader/memfd 执行链恢复、payload trailer 保留、重签名与真机验证',
    scenes: ['改 APK 里的 so 校验逻辑', '离线授权替换', '补丁后保持可安装可运行'],
    avoid: '纯静态理解先用 craft-anything 概览',
    invoke: 'skill({name:"elf-local-auth-patcher"})', paths: [['re', 'patch'], ['re', 'unpack']] },

  // ---- 安全 ----
  { ref: 'skill/security-code-auditor', name: 'security-code-auditor', display: '代码安全审计', kind: 'skill',
    traits: '源码级安全审计方法：污点跟踪、危险函数识别、鉴权缺口、注入面盘点',
    scenes: ['审一段后端代码有没有洞', '上线前做安全检查'],
    avoid: '黑盒打点用 Web 安全技能',
    invoke: 'skill({name:"security-code-auditor"})', paths: [['sec', 'web'], ['code', 'debug']] },

  // ---- 网络 ----
  { ref: 'tool/web_fetch', name: 'web_fetch', display: '抓网页', kind: 'tool',
    traits: '拉取指定 HTTP(S) URL 并解码为文本，返回正文供分析，外部内容是不可信数据',
    scenes: ['读某个文档页/公告/仓库文件', '核实搜索结果原文', '取 API 返回'],
    avoid: '要搜索结果列表用 web_search；要浏览器 DOM 用 windows Scrape use_dom',
    invoke: 'web_fetch({url})', paths: [['net', 'http'], ['research', 'web']] },
  { ref: 'tool/web_search', name: 'web_search', display: '网络搜索', kind: 'tool',
    traits: '一次最多 10 条查询，结果合并返回摘要与来源 URL 列表',
    scenes: ['查最新信息', '找官方文档入口', '核实事实'],
    avoid: '要正文用 web_fetch 跟进',
    invoke: 'web_search({queries:[...]})', paths: [['research', 'web'], ['net', 'http']] },

  // ---- 研究 ----
  { ref: 'mcp/pubmed', name: 'pubmed-biomedical-literature', display: '生物医学文献', kind: 'mcp',
    traits: 'MCP 医学文献库：PubMed/PMC/Europe PMC 检索、元数据、全文、引文格式化、MeSH 词表、拼写纠正、iCite 引用指标',
    scenes: ['查某个药物/疾病的研究', '找论文全文', '要标准引用格式', '查 MeSH 主题词'],
    avoid: '非生物医学领域用 openalex',
    invoke: 'pubmed_search_articles → pubmed_fetch_articles → pubmed_fetch_fulltext',
    paths: [['research', 'paper']] },
  { ref: 'mcp/openalex', name: 'openalex-research-catalog', display: '学术全库', kind: 'mcp',
    traits: 'MCP OpenAlex 全学科文献目录：作品/作者/来源/机构/主题/关键词/出版商/资助方，支持过滤、排序、分组统计、引用图、语义检索',
    scenes: ['跨学科论文检索', '看某领域年度趋势', '查作者与机构产出', '顺引用链找相关工作'],
    avoid: '要医学全文用 pubmed',
    invoke: 'openalex_resolve_name → openalex_search_entities / openalex_analyze_trends',
    paths: [['research', 'paper']] },

  // ---- 媒体 ----
  { ref: 'tool/generate_image', name: 'generate_image', display: '文生图', kind: 'tool',
    traits: '按完整视觉描述生成一张图（主体、构图、风格、光线、画面文字），成功后直接附在对话里',
    scenes: ['画插图/封面/概念图', '生成占位素材'],
    avoid: '改已有图用 edit_image',
    invoke: 'generate_image({prompt, aspect_ratio?})', paths: [['media', 'image']] },
  { ref: 'tool/edit_image', name: 'edit_image', display: '改图', kind: 'tool',
    traits: '在保留主体的前提下改已有图：换场景/服装/姿势/光线/风格/构图；支持多图参考与 GIF 动图',
    scenes: ['同一角色的新场景', '换风格重绘', '把草图变成成品'],
    avoid: '全新画面用 generate_image',
    invoke: 'edit_image({prompt, source_path?/source_attachment_id?})', paths: [['media', 'image']] },
  { ref: 'tool/render_ui', name: 'render_ui', display: '交互卡片', kind: 'tool',
    traits: '把结构化 spec 渲染成对话里的可交互 UI 卡片：表格、图表、步骤、对比、表单、3D、流程图；带 action 的组件会把交互回传',
    scenes: ['≥3 条并列要点或对比', '指标面板', '流程/架构图', '要用户做选择'],
    avoid: '纯文字讲得清的地方不要套壳',
    invoke: 'render_ui({spec:{title, items:[...]}})', paths: [['media', 'ui'], ['data', 'text']] },

  // ---- 桌面 / 系统 ----
  { ref: 'tool/desktop_control', name: 'desktop_control', display: '桌面控制', kind: 'tool',
    traits: '操作真实桌面：移动/点击/拖拽/滚动/输入文本/发键/聚焦窗口/读控件树/列窗口；坐标是物理屏幕像素',
    scenes: ['操作没有 API 的 GUI 程序', '点按钮、填表单', '读窗口控件结构'],
    avoid: '能用 CLI 解决的不要动桌面',
    invoke: 'desktop_control({action, x?, y?, target?, title?})', paths: [['auto', 'desktop']] },
  { ref: 'tool/screen_view', name: 'screen_view', display: '看屏幕', kind: 'tool',
    traits: '截取当前屏幕返回真实图像，可按窗口或区域裁剪，可选坐标标尺与光标位置',
    scenes: ['操作桌面前先看现状', '确认动作结果', '让用户指着看'],
    avoid: '不要用它读文本文件',
    invoke: 'screen_view({window?, region?})', paths: [['auto', 'desktop']] },
  { ref: 'mcp/windows', name: 'windows', display: 'Windows 桌面套件', kind: 'mcp',
    traits: 'MCP Windows 桌面操作：截图、快照（含可交互元素树）、点击、输入、快捷键、滚动、剪贴板、进程列表/终止、注册表读写、等待、Toast 通知、显示信息、网页抓取',
    scenes: ['进程卡了要杀', '读写注册表', '剪贴板搬运', '按元素树精确点按钮'],
    avoid: '简单点击可先用 desktop_control',
    invoke: 'mcp__windows__Snapshot / Process / Registry / Clipboard / Shortcut',
    paths: [['auto', 'desktop'], ['auto', 'system']] },
  { ref: 'tool/wsl', name: 'wsl', display: 'WSL 执行', kind: 'tool',
    traits: '在 WSL 里跑 Linux 命令，Windows 路径自动转 /mnt/，可指定发行版、env、stdin、超时、后台；破坏性命令需 allowDangerous',
    scenes: ['需要 Linux 工具链', '跨 Win/Linux 文件处理', '装 pip/apt 包'],
    avoid: '纯 Windows 命令用 shell',
    invoke: 'wsl({command, description, distro?, asRoot?})', paths: [['auto', 'remote'], ['auto', 'system']] },
  { ref: 'tool/rw_connect', name: 'rw_connect', display: '远程机器连接', kind: 'tool',
    traits: 'SSH 连远端主机：密码/私钥/agent/keyboard-interactive，支持 ~/.ssh/config 别名、ProxyJump、openssh 后端（GSSAPI）、已存机器注册表与重绑定',
    scenes: ['连另一台机器干活', '跨机部署与排障'],
    avoid: '本机命令用 shell',
    invoke: 'rw_connect({machineId?/host, username?})', paths: [['auto', 'remote'], ['net', 'proxy']] },
  { ref: 'tool/remote_send_message', name: 'remote_send_message', display: '派任务给远端会话', kind: 'tool',
    traits: '向远端 Harness 会话发文本任务或追问，走 Host 队列与既有权限；需要唯一 operationId 去重',
    scenes: ['多机协同开发', '远程长任务托管'],
    avoid: '本机委派用 summon_expert / subagent',
    invoke: 'remote_send_message({hostId, workspaceId, sessionId, operationId, message})',
    paths: [['auto', 'remote'], ['agent', 'dispatch']] },

  // ---- 智能体编排 ----
  { ref: 'tool/summon_expert', name: 'summon_expert', display: '召唤单个专家', kind: 'tool',
    traits: '从合并花名册（628 位）召唤一位领域专家跑完整任务，带该专家 persona 与工具面，同步等结果；任务书需自包含',
    scenes: ['把某块专业工作整体交出去', '需要特定角色视角复核'],
    avoid: '多个专家并行用 summon_experts；要延续对话用 subagent',
    invoke: 'summon_expert({expert:"bundled-core/code-reviewer", task:"...", readOnly?})',
    paths: [['agent', 'dispatch']] },
  { ref: 'tool/summon_experts', name: 'summon_experts', display: '批量召唤专家', kind: 'tool',
    traits: '并行召唤多位专家（≤8，并发 4），每人独立任务书，部分失败不影响其余；可 stagger 预热缓存',
    scenes: ['需要多领域同时产出', '一支小队干一个大活'],
    avoid: '单个专家用 summon_expert 更省',
    invoke: 'summon_experts({experts:[{expert, task}], stagger?})', paths: [['agent', 'dispatch']] },
  { ref: 'tool/list_experts', name: 'list_experts', display: '专家名册', kind: 'tool',
    traits: '列出合并花名册：不带参数给来源与数量，带 bySource 展开该来源专家名',
    scenes: ['不确定有没有对口专家', '看某来源包有哪些人'],
    avoid: '知道专家名时直接 summon',
    invoke: 'list_experts({bySource?})', paths: [['agent', 'dispatch']] },
  { ref: 'tool/subagent', name: 'subagent', display: '派子代理', kind: 'tool',
    traits: '把自包含任务交给一个独立上下文的子代理，立即返回名字，完成时自动通知；可用 send_message 继续对话',
    scenes: ['独立调研/审查/实现，不吃主上下文', '长任务后台跑'],
    avoid: '需要领域 persona 时用 summon_expert',
    invoke: 'subagent({description, prompt, name?, cwd?})', paths: [['agent', 'dispatch']] },
  { ref: 'tool/subagent_fork', name: 'subagent_fork', display: '分叉子代理', kind: 'tool',
    traits: '派生一个继承本次对话已完成轮次的子代理，适合接着当前讨论继续的活',
    scenes: ['基于刚才的结论做后续分析', '让另一个 agent 复核本会话的改动'],
    avoid: '与当前对话无关的任务用 subagent',
    invoke: 'subagent_fork({description, prompt})', paths: [['agent', 'dispatch']] },
  { ref: 'tool/agent_teams_create', name: 'agent_teams_create', display: '建协作团队', kind: 'tool',
    traits: '创建 AgentTeams 团队，approval=required 时先出计划卡等用户批准再开工；可在同一次调用里给全套 roster 与任务 DAG',
    scenes: ['多角色分工的大任务', '需要质量门禁（需求→实现→验证→评审→集成）'],
    avoid: '一两次委派用 summon',
    invoke: 'agent_teams_create({name, description, approval:"required", plan:{members,tasks}})',
    paths: [['agent', 'team']] },
  { ref: 'tool/agent_teams_status', name: 'agent_teams_status', display: '团队状态', kind: 'tool',
    traits: '读团队快照：成员活动、任务状态/负责人/依赖/产出、队长可见全部邮箱',
    scenes: ['派活后看进度', '判断哪个任务卡住了'],
    avoid: '不要用它做忙轮询',
    invoke: 'agent_teams_status()', paths: [['agent', 'team']] },
  { ref: 'tool/team_task_create', name: 'team_task_create', display: '建共享任务', kind: 'tool',
    traits: '在共享任务板创建一条无主待办，可挂 blocked_by 前置与写作用域',
    scenes: ['拆活给团队', '记录待办与依赖'],
    avoid: '正式质量门禁任务用 agent_teams_create_task',
    invoke: 'team_task_create({subject, description, blocked_by?, write_scopes?})',
    paths: [['agent', 'team']] },
  { ref: 'tool/workflow', name: 'workflow', display: '脚本化扇出', kind: 'tool',
    traits: '用 JS 脚本编排大规模子代理：agent/pipeline/parallel/phase/log 钩子，结果结构化返回；无文件与网络能力，干活的是 agent',
    scenes: ['几十上百个文件批量审计/迁移', '多角度并行调研后汇总', '对抗性验证一批结论'],
    avoid: '一两个委派用 subagent 就够',
    invoke: 'workflow({script, meta:{name, description}})', paths: [['agent', 'dispatch'], ['data', 'file']] },
  { ref: 'tool/skill', name: 'skill', display: '加载技能', kind: 'tool',
    traits: '加载某个技能的完整正文（方法论、前提、分支、反证要求），加载后按其执行',
    scenes: ['任务命中技能目录里的条目前先读它', '需要领域标准流程'],
    avoid: '不知道该用哪个技能先用 embed-router 的 route_lookup',
    invoke: 'skill({name})', paths: [['agent', 'skill']] },
  { ref: 'mcp/embed-router', name: 'embed-router', display: '语义路由', kind: 'mcp',
    traits: 'MCP 语义检索（Qwen3-Embedding-4B）：技能路由 route_lookup 扫技能库 name+description 给余弦分；semantic_file_search 对目录建向量索引查文件片段；semantic_rank/similarity 做排序与相似度',
    scenes: ['一句话需求该配哪个技能', '在未知目录里按语义找代码片段', '给一批候选文本排相关度'],
    avoid: '工具表检索它不管（那层是字符串匹配）',
    invoke: 'route_lookup({query, topK}) / semantic_file_search({query, path, glob})',
    paths: [['agent', 'skill'], ['memory', 'mem'], ['data', 'file']] },

  // ---- 记忆 ----
  { ref: 'tool/mnemon_recall', name: 'mnemon_recall', display: '记忆召回', kind: 'tool',
    traits: '从持久记忆空间召回有界证据，一个初始查询加一次不同查询的细化，走向量语义检索',
    scenes: ['需要以前定下的事实/偏好/决策', '接着旧项目干活'],
    avoid: '项目长文档用 document_search',
    invoke: 'mnemon_recall({query, memoryBodyIds?})', paths: [['memory', 'mem']] },
  { ref: 'tool/mnemon_remember', name: 'mnemon_remember', display: '写入记忆', kind: 'tool',
    traits: '把一条自包含的durable洞察归档进记忆空间：分类、重要度、实体、标签',
    scenes: ['用户明确要求记住某事', '沉淀关键决策'],
    avoid: '临时进度、对话转储、代码里显而易见的事实都不要写',
    invoke: 'mnemon_remember({content, category, importance, memoryBodyId})',
    paths: [['memory', 'mem']] },
  { ref: 'tool/mnemon_document_search', name: 'mnemon_document_search', display: '项目文档检索', kind: 'tool',
    traits: '在项目级托管文档里做聚焦搜索，返回有界证据；与记忆空间是两套',
    scenes: ['查项目架构/约定/决策记录', '找以前写过的方案'],
    avoid: '个人偏好用 recall',
    invoke: 'mnemon_document_search({query, limit})', paths: [['memory', 'doc']] },
  { ref: 'tool/session_search', name: 'session_search', display: '历史会话检索', kind: 'tool',
    traits: '在本工作区的历史会话里全文搜索，每个会话返回最强匹配事件；可再 trace 看血缘',
    scenes: ['找以前怎么解决同类问题', '回忆某次改动的原因'],
    avoid: '记忆空间里已有的用 recall',
    invoke: 'session_search({query})', paths: [['memory', 'doc'], ['data', 'text']] },
  { ref: 'mcp/hindsight', name: 'hindsight', display: '项目记忆页', kind: 'mcp',
    traits: 'MCP 仓库记忆：页面清单与正文（架构、组件、约定、决策、在办事项）、混合检索、深度反思 WHY、文档摄入、同步状态',
    scenes: ['非平凡任务开工前先读项目已知', '问「为什么当初这样定」'],
    avoid: '一次性事实用 mnemon',
    invoke: 'hindsight_list_pages / read_page / search_pages / reflect',
    paths: [['memory', 'doc'], ['memory', 'mem']] },
  { ref: 'tool/compress', name: 'compress', display: '上下文压缩', kind: 'tool',
    traits: '把自己写好的自包含摘要替换掉一批已消费对话区间，多个区间一次批量提交；摘要即唯一记录，务必保留路径/签名/报错/决策理由',
    scenes: ['上下文快满又必须继续', '长任务中段整理'],
    avoid: '内容还会用到就别压',
    invoke: 'compress({content})', paths: [['memory', 'doc']] },

  // ---- 数据 ----
  { ref: 'tool/read_image', name: 'read_image', display: '读图', kind: 'tool',
    traits: '读取本地 PNG/JPEG/WebP/GIF 并返回图像本身，大图自动降采样',
    scenes: ['看截图/示意图/设计稿', '核对图像内容'],
    avoid: '要更高分辨率用 acp_read_original_image',
    invoke: 'read_image({file_path})', paths: [['media', 'image'], ['data', 'file']] },
  { ref: 'tool/acp_status', name: 'acp_status', display: '上下文用量', kind: 'tool',
    traits: '查看上下文占用与可压缩区间；可列消息级明细、按工具过滤、看压缩块账本',
    scenes: ['判断该不该压缩', '定位最占 token 的消息'],
    avoid: '不需要频繁查',
    invoke: 'acp_status({scope?, view?, tool?})', paths: [['memory', 'doc']] },
  { ref: 'mcp/treg', name: 'treg', display: '外部数据与生成', kind: 'mcp',
    traits: 'MCP 外部能力网关：SEO/SERP、外链、社交与趋势、人物公司信息、广告、抓取、图像与视频生成、语音；先 catalog_search 说想干什么，再 catalog_get 看参数价格，再 call',
    scenes: ['需要外部实时数据但没 API key', '批量抓取/生成素材', '查站点排名与外链'],
    avoid: '能 web_fetch 解决的不要花钱',
    invoke: 'catalog_search → catalog_get → call({endpoint_id, params})',
    paths: [['research', 'web'], ['media', 'image'], ['net', 'http']] },
];

// ---------------- 播种 ----------------
function rpc(proc, id, method, params) {
  return new Promise((resolve, reject) => {
    const onData = (buf) => {
      for (const line of buf.toString().split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let m; try { m = JSON.parse(t); } catch { continue; }
        if (m.id === id) { proc.stdout.off('data', onData); resolve(m); }
      }
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { proc.stdout.off('data', onData); reject(new Error(`timeout ${method} id=${id}`)); }, 120000);
  });
}

const proc = spawn(NODE, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
let id = 0;

proc.on('exit', (c) => { if (c !== 0) { console.error('server exited', c); process.exit(c || 1); } });

try {
  await rpc(proc, ++id, 'initialize', {});
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // 先声明分类与子分类
  let ok = 0, bad = 0;
  for (const t of TOOLS) {
    const paths = t.paths || [['misc', 'uncategorized']];
    const usedCats = [...new Set(paths.map((p) => p[0]))];
    const args = {
      ref: t.ref, name: t.name, display: t.display, kind: t.kind,
      traits: t.traits, scenes: t.scenes || [], avoid: t.avoid || '', invoke: t.invoke || '',
      paths,
      categories: CATS.filter((c) => usedCats.includes(c.id)),
      subs: SUBS.filter((s) => paths.some((p) => p[0] === s[0] && p[1] === s[1]))
        .map(([categoryId, sid, name, desc]) => ({ categoryId, id: sid, name, desc })),
    };
    try {
      const r = await rpc(proc, ++id, 'tools/call', { name: 'atlas_upsert', arguments: args });
      const txt = r?.result?.content?.[0]?.text || '';
      if (r?.result?.isError) { console.error('FAIL', t.ref, txt.slice(0, 200)); bad++; }
      else { ok++; console.log('OK  ', t.ref, '→', paths.map((p) => p.join('/')).join(', ')); }
    } catch (e) { console.error('ERR ', t.ref, e.message); bad++; }
  }
  console.log(`\n=== seeded ${ok} tools, ${bad} failed ===`);
  const st = await rpc(proc, ++id, 'tools/call', { name: 'atlas_stats', arguments: {} });
  console.log(st?.result?.content?.[0]?.text || '');
} catch (e) {
  console.error('SEED ERROR', e.message);
  process.exitCode = 1;
} finally {
  proc.stdin.end();
  setTimeout(() => { try { proc.kill(); } catch {} process.exit(process.exitCode || 0); }, 1500);
}
