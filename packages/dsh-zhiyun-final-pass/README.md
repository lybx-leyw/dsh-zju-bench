# dsh-zhiyun-final-pass —— 无曰终审

把**一节已经写好的讲义**交给一个 agent 自由整理：弄整齐、弄规范，改到满意为止。

起源于 Flutter App 的 `lib/fusion/lecture_final_pass.dart`；v2 支持整节重组阅读结构，允许改名和拆分合并节点。讲义包负责原稿覆盖、有效来源、例题结构检查及来源锚点推导，宿主仍负责原生 Agent 执行。

## 为什么必须是个 agent

App 的注释写得很清楚：**「整齐规范」说不成一句能塞进 JSON 的指令**。
上一版无曰正是死在这里 —— 「『讲义』定义不出可验收的形态 ⇒ 格式要求全靠猜」。

这一层要的执行者得能：自己分段读完一整节、自己判断哪两块该合并、
哪句口气不对、**反复多轮**改到满意、改完再读一遍检查。那不是一次问答能干的活。

所以本包**不自己发 LLM 请求**，而是接在 DSH 宿主现成的 agent 架构上：

| 宿主服务 | 包 | 本包用它做什么 |
|---|---|---|
| `ctx.agents` | `@deepseek-ai/dsh-agent` | 建一个终审**根 agent**（定 cwd / 预设 / 模型），并持有它的拆卸凭据 |
| `ctx.subagents` | `@deepseek-ai/dsh-subagent` | 每一节**委派一个一次性子 agent**，由它真正读写文件、多轮改稿 |
| `ctx.fs` | `@deepseek-ai/dsh-fs` | 写出待整理的讲义、读回改完的讲义 |
| `ctx.profileContext` | 宿主启动器 | 默认工作目录 |

「agent 要能自己读写文件」也**照样是复用**：文件工具（`read` / `write` / `edit` /
`pwsh`）来自宿主既有的 agent 预设，子 agent 通过宿主自己的 `applyChildComposition()`
继承父 agent 的预设。本包**不注册任何工具** —— 自己再注册一套 `read`/`write`
就是造轮子。

## 提示词只给「什么叫好」

判据写得越死，agent 越会去**凑判据**，而不是把讲义改好。所以
`src/prompts.js` 只描述**什么叫好**（块名要像样、详略要匀、口气是书面陈述…）
加内容忠实与可追溯底线（不许新增知识 / 不许丢知识 / ref 与 src 必须有效），
以及**怎么分段读**（`read` 有 `offset` / `limit`，两次读完；这是被纠正过的教训：
「指令缺口不是能力极限」）。

## 用法

```js
// 插件激活后（inject: agents / subagents / fs / profileContext）
const report = await ctx.zhiyunFinalPass.run({
  text: exportedLectureText,   // 调用方从自己的讲义模型导出
  sectionId: 's1',
  signal,                      // 可选：取消
});

report.text          // 改完的讲义全文
report.shapeChanged  // 知识点/块数变了 —— 变不一定是错，只报事实
report.unchanged     // 文件一个字没动 —— 也是事实，不是失败
report.output        // agent 自己的交代（它说改了哪几件）
```

**导出与合回不在这里**：本包只负责「给定文本 + 节 id，跑完一次终审，把改完的文本
交回来」。这对应 App 把 `runWuyueSecondPass`（跑）与 `mergeAgentLectureText`（合回）
分成两层的形状 —— 讲义模型属于装配那个包。

## 失败一律如实

App 的端口注释把这条写死了：「拿不到结果时必须抛错，**不要**返回
『原讲义 + 空 report』冒充跑过了」——「跑过但没改」与「根本没跑」在用户眼里是两件事。

所以任何没跑成的情况都抛 `FinalPassError`，带稳定 `code`：

| code | 什么时候 |
|---|---|
| `INPUT` | 文本为空 / 节 id 含路径字符 |
| `DISPOSED` | 服务已卸载 |
| `BUSY` | 已有一节在跑（串行） |
| `NO_PROVIDER` | 宿主 `ctx.subagents` 上没有配置的 provider |
| `PROVIDER_UNSUPPORTED` | provider 不支持 `persona`（没有 persona 就不是终审） |
| `TIMEOUT` | 超时 |
| `ABORTED` | 被取消 |
| `AGENT_START_FAILED` | 委派在子 agent 发布前失败 |
| `AGENT_FAILED` | 子 agent 跑完但自己失败了（`stopReason` / `diagnostic` 如实带出） |
| `FORMAT` | 改完的文本读不回 / 标记行被改坏 |

## 两个实现上的坑（都已写进代码注释）

1. **Cordis 会静默丢掉同步 `apply` 返回的 disposer**。实测 4.0.4 与 4.0.5-alpha.1
   行为一致：框架只把返回值当「可迭代的 disposer 列表」处理，一个函数不是可迭代
   对象，于是被忽略 —— 插件卸载时 `dispose()` 根本不跑，agent 与在跑的 run 一起泄漏。
   所以本插件的 `apply` 是 `async` 的。
2. **写文件要自己带 `sandboxPolicy`**。否则插件的写入按「无 session」解析成部署
   默认根，落在终审 agent 的 cwd 之外会被沙箱拒绝（`FS_SANDBOX_DENIED`）。

## 测试

```powershell
node --test tests/final-pass.test.mjs
```

离线用例：用**真的 Cordis**（宿主 `.runtime/dsh-<版本>` 那一份）加载本插件，
只把 `agents` / `subagents` / `fs` / `profileContext` 换成记录调用的假实现。
覆盖：激活与卸载、委派形状、失败/超时/取消如实回报，以及
「终审不是 llm.call」——用一个**投毒**的 `llm` 服务断言（任何属性访问都抛错）。
