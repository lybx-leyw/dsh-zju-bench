# App 解析器迁移

本阶段迁移实际使用的三阶段 `lib/fusion/fusion.dart` 路径；不使用 zju-mcp 的解析和知识库。不迁移 Flutter 的 LLM HTTP/供应商实现，改用 DSH `llm.prepareCall().stream()`，沿用宿主模型路由和 `llm/stream` 扩展点。图片调用宿主附件服务。这里无需 agent 工具循环，属于宿主 LLM 服务的直接消费者。

## 已迁移

- 课件/字幕归页；缺失或重复时间锚点告警；毫秒时间不丢精度。
- 单页完整视觉转述、文本/画面/术语三节提取、截图 gate。
- 基于原字幕的 edits-only 清洗；UTF-16 编辑距离；最多 30 字且最多原句 50% 的纠错限制；空缺条目保留原文。
- 块边界完整覆盖检查、有限语义重试、异常时整页一块回退、跨页连续块拼接。
- 术语汇总、App 种子词表、显式新增标签、未知标签拒绝、逐字段部分结果保留。
- 每卷 24 块 / 50000 字符的标注输入预算、分卷失败诊断、全局概述驱动的整节主线覆盖校验。
- 共享并发限制、单页超时、用户取消、插件卸载取消、逐阶段成功缓存和部分结果状态。
- `parse` 和 `parseClassroom` 服务接口、独立 profile 注册和保留用户覆盖的升级初始化。

提示词来自当前 Dart 文件，常量段作为静态 JSON 带入 JS。`scripts/parser-reference.mjs` 直接执行真实 Dart 纯逻辑，核对转述、纠错、块边界、覆盖判定以及视觉、混合、分卷、整节请求。无需网络、账号或 Flutter 全量测试。基线为合成数据，不包含真实课程或凭证。

## 与 App 的明确差异

JS 保留数据源完整毫秒时间；失败页及分卷失败以结构化诊断返回，不静默丢弃 ASR。`parseClassroom` 对课件和字幕的完整性都设门槛，无法确认时需要调用者显式接受部分数据。未知标签拒绝按当前块判断，避免其他块的拒绝污染本块。截图仅提供 gate 标记，是否从学习树隐藏由下一阶段消费者决定。

原 App 的每句、每块语义保持，未引入自己的模型重试 HTTP 实现（传输层重试归宿主的 `llm/stream` 瀑布）。

## 与 App 逐项对齐（2026-10-07 第二轮）

对照 `lib/fusion/` 逐条核对后补齐了四处行为差异：

| 差异 | App | 对齐后 |
| --- | --- | --- |
| 未落页字幕 | 并入句子层，**不造块** | 产物新增 `unassignedSentences`；`sentences` 只含页内句子，未落页的字幕不再伪造块、也不进标注 |
| 标注分卷调度 | 全部卷并发，只补发失败的卷，轮间退避 | 并发发出（并发上限由闸约束），失败卷单独补发，两轮、退避 2 秒×轮次 |
| 整节主线区间 | `sanitizeOutline` 逐条剔除越界/反向/重叠，其余照常给 | 同口径清洗并如实记警告；不再因为一条坏区间就丢掉整份主线 |
| 重试提示语 | 逐条点名被拒条目与覆盖违规 | `correctionRetryHint` / `coverageRetryHint` 列出条目、原因、字数与违规区间 |

顺带把「所有块都有概述才发主线」放宽为 App 的口径：只要有块拿到概述，缺失概述的块以占位符参与主线请求。诊断新增 `tagFailures[].blockFrom/blockTo`，便于定位是哪一卷坏了；有未落页字幕时产物如实标为 `partial`（那些句子没有清洗、也没有标注）。

### 一处**有意保留**的差异：混合解析的段缓存

App 在未收敛时也把这一页的原始回包写进段缓存（「只付一次钱」），代价是那一页此后再也不会被重新解析。JS 保持**只有收敛的回包才进缓存**：App 有自动解析看门狗反复重跑，固化失败结果是它要背的包袱；JS 没有看门狗，重跑只由用户点「重新整理」发起，若把未收敛的回包缓存下来，那个按钮会变成空转。代价是未收敛的页重跑时会再花一次调用 —— 那正是用户点按钮想达到的结果。

### 校验脚本的两处缺陷（已修）

`scripts/parser-reference.mjs` 与 `scripts/classroom-parity.mjs` 原先逐块 `out += chunk` 拼接子进程输出，汉字跨块时会被切成 U+FFFD，导致 Dart 契约校验**偶发**报假的 deepEqual 失败（实测「可选，只在要补时写」变成 `可选��`）。现改为攒 Buffer 后整体解 UTF-8；两个宿主验收脚本改用 `setEncoding('utf8')`，走 StringDecoder 正确处理跨块字符。

`scripts/test-host.mjs` 点击设置分组的定位器改为 `:scope > summary`：宿主某些分组内部还会渲染嵌套 details，裸 `locator('summary')` 会命中子节点而触发 strict mode 冲突。

## 验证与边界

`tests/parser.test.mjs` 验证 Dart 契约、时间归属无丢失、护栏、缓存失效、失败原文保留、有限重试、取消与卸载。在 DSH 0.2.0-rc.2 和 0.2.1-alpha.1 中实际挂载 Cordis、原生 LLM runtime、原生本地附件服务，再注册确定性模型 adapter，运行完整解析。不是仅对服务对象打桩。两版产物由 `parser:verify` 写到 `artifacts/parser/`。

确定性模型验证证明工程接入、请求格式和结果保护机制；**不证明真实模型的 OCR 或课程解析质量**。真实模型质量验收需要在宿主配置可用的视觉/文本模型后，以真实课程运行 `parseClassroom`；当前没有为此另建 API 客户端或读取外部 LLM 密钥。之前已完成的真实智云数据源验证不等同于本阶段的真实 LLM 验证。

2026-10-07 验收：JS 全套 47 项通过、0 失败、0 跳过；其中解析器 15 项。Dart 契约复验、UI 构建、产品 profile 初始化/检查通过。两个支持版本的真实浏览器验收各 13 项通过，包含业务插件注入解析器检查，记录在 `artifacts/host-report-<版本>.json`。确定性宿主解析每版 4 次模型请求，第二次运行全部命中缓存，产物在 `artifacts/parser/lesson-<版本>.json`。

2026-10-07 第二轮（逐项对齐后）复验：JS 全套 **54 项通过**、0 失败、0 跳过，其中解析器 17 项（新增主线清洗、未落页字幕、分卷并发补发三项）。`parser:parity` 与 `classroom:parity` 通过，且连跑 6 次稳定（此前会偶发失败）。`parser:verify` 两版各 4 次请求、第二次全部命中缓存、状态 `ready`。两个支持版本的浏览器验收：通用回归各 13 项、学习面板各 8 项，全部通过。

随后已通过独立的学习面板插件接入，见 [接入记录](study-integration.md)。该插件当时叫 `dsh-zhiyun-study`，界面拆分后已按职责分为领域状态层 `dsh-zhiyun-study-core` 与页面包 `dsh-zhiyun-page-{today,courses,study,me}`（见 [依赖图](dependency-graph.html)）。知识入库、PPT 层级树、讲义润色（习坎）、讲义终审 agent（无曰）、测验和通知属于后续阶段；加速档位、沙盒池、词表持久化与解析产物检索仍未迁移（差异清单见 `docs/` 同目录的对照记录）。

## 第二轮：多智能体并行迁移（2026-10-07）

由 Lead 固定契约、三名队友并行实现，Lead 负责接线与验收。新增六个包，全部注册进 `zhiyun-bench` profile：

| 包 | 内容 | 依赖的宿主能力 |
| --- | --- | --- |
| `dsh-zhiyun-parser`（补齐） | 加速档位与截断升档、词表可注入 store | 宿主 `llm`、`dsh-atomic-write` |
| `dsh-zhiyun-lecture` | PPT 知识树、习坎填充讲义、书面语验收 | 无（llm 由集成层注入） |
| `dsh-zhiyun-final-pass` | 无曰终审：**跑在宿主 agent 运行时上** | `ctx.agents` / `ctx.subagents` / `ctx.fs` / 预设 |
| `dsh-zhiyun-knowledge` | 解析产物按账号+课程+节次入库、字面检索 | `ctx.storage` / `ctx.storageDomain` |
| `dsh-zhiyun-quiz` | 题形状、先筛后出、三态硬检查、去重 | 无（落盘交给集成层） |
| `dsh-zhiyun-notes` | 节笔记、`zy://` 内链与时间链接 | `ctx.storageDomain`（经 knowledge 的宿主解析器） |

**接线（Lead 做的部分）**：`profiles/zhiyun-bench/package.json` 与 `scripts/profile.mjs` 的 bundle 白名单/junction 表；学习面板的 RPC 增加 `lecture`/`final-pass` 两个动作，并在界面上给出「生成讲义」「无曰终审」入口；讲义与解析产物落进同一条记录。`ziyunLecture`/`ziyunFinalPass` **刻意不写进 `inject`** —— 它们是可选加工步骤，写进去会让「停用其中一个」把整个学习面板拖成 pending；改用调用时惰性取，缺了就具名报 `NOT_WIRED`。

### 真机验收抓到的四个「单测全绿但装不上」

这一轮最有价值的部分不是新增代码，而是真实宿主暴露的缺陷 —— 它们全都通过了各自的单元测试：

1. **`dsh-zhiyun-notes` 没声明 `dsh.bundle`**，宿主直接 `skipping profile bundle`，插件从不加载。
2. **同包缺 `cordis.patch.yml`**，声明了 bundle 也进不了启动图谱。
3. **`storageDomain` 必须写进 `inject`**。它由宿主在 `ctx.inject([...backends])` 的**子 fiber** 里 provide，而 `ctx.get()` 只按本插件的依赖图解析 —— 不声明就永远探不到。原先按「未声明 inject 读属性会抛」的判断改用了 `ctx.get`，结论对了一半、方向反了：正因如此才必须声明。
4. **笔记包从自身路径 `import('@deepseek-ai/dsh-storage-domain')`**，而宿主包只在 profile 的 node_modules 链里，必然 `ERR_MODULE_NOT_FOUND`。改用 `dsh-zhiyun-knowledge/src/host.js` 那份已验证的 `profileContext.dir` + `createRequire` 解析（同一件事不留两份实现），并保持动态 import。

另外把三处手写的 `tmp + rename` 全部换成宿主 `@deepseek-ai/dsh-atomic-write`（课堂会话落盘保持二进制格式不变，改格式会让用户被迫重新登录）。

### 验收

- JS 全套 **303 项通过**、0 失败、0 跳过（上一轮 135 项）。
- `parser:parity` 与 `classroom:parity` 通过（真跑 Dart 逐字段对照）。
- 真实宿主：通用回归 **15 项**、学习面板 **8 项** 全部通过；`test-host` 新增「七个服务在真实宿主里激活」的断言，并用**变异测试**验证过该断言会红（不是空转）。
- 已知偶发：`test:host` 约 1/4 概率因宿主 `ui-cordis` 库存请求瞬时失败而报 `No browser activation/render errors`；本会话早期（改动前）已出现同一现象，**与本次插件无关**。

### 未对齐（各包 README 有明细）

- 讲义：逐概念撰写缓存未接（集成层负责）；`Lecture` 读模型的完整写回未迁。
- 出题：选择题/案例题的构造路径未实现，在**任何模型调用之前**具名拒绝；讲义题过不了硬检查是 **App 同病**（照抄取值，不改）。
- 笔记：JS 只有 53 位安全整数，`2^63-1` 主动拒绝而非给出错秒数。
- 终审：本包不含讲义的导出与合回（由学习面板那一层做）。
- 仍属后续：沙盒池与集群规划、向量/混合检索、通知。
