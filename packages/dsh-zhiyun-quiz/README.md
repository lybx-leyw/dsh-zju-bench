# dsh-zhiyun-quiz

智云 Pro 的**出题与质检**层：题形状 + 先筛后出 + 三态硬检查。

零 UI、零 Flutter 依赖、**零落盘**。llm 由集成层注入窄接口，持久化交给宿主存储栈。

## 规格来源

**逐条对齐 App 的 Dart 实现，不自己发明算法。** 每个源文件头都写明了它对齐的是哪一件：

| 本包文件 | App 侧规格 |
|---|---|
| `src/model.js` | `lib/fusion/quiz_model.dart` |
| `src/generate.js` | `lib/fusion/quiz_generate.dart` |
| `src/quality.js` | `lib/fusion/quiz_quality.dart` |
| `src/dedupe.js` | `lib/fusion/quiz_dedupe.dart` |
| `src/lecture.js` | `lib/fusion/lecture_quiz.dart` |
| `src/store.js` | `lib/data/quiz_store.dart` |
| `src/index.js` | 无（本包自己的宿主接缝） |

阈值、判据、失败文案、三态语义、甚至 `cancelled()` 的措辞都照抄 ——
**测试里的每条断言都能追到 Dart 侧一条已经写在注释里的判据**。

## 三条硬纪律在这一层的落点

### ① 生成的题**默认不入库**

生成的题 `status = 'proposed'`，**不进复习队列**，必须用户一键采纳。
这条纪律如果只写在界面上，任何一条新的调用路径都能绕过它 —— 所以它落在**接口**上：

| 方法 | 能不能让题进队列 |
|---|---|
| `store.saveGenerated` | **不能**。状态**强制**写回 `proposed`，且**逐条记录 note** |
| `store.saveSelfAudited` | 能 —— 但只收「带 `讲义自审依据：` 前缀 + 块号 `-1`」的讲义题 |
| `store.adopt` / `store.discard` | 能 —— 这是**用户动作**的两个入口 |
| `store.reviewQueue` | **只返回 `accepted` 的**（读侧落点） |

`generate.js` 里**没有任何**把 `proposed` 改成 `accepted` 的路径。

### ② 先筛后出（不许整节一把丢）

- 输入单位是**已筛的块**，每块必须写明它是**怎么被选中的**；
- `selection === 'wholeSection'`（整节）会被 `planQuizGeneration` **拒绝**；
- `generate()` 对这类请求**一次模型调用都不发**（测试钉住 `llm.calls.length === 0`）。

### ③ 每块**两次**调用，次序是 Rewrite → 出题

`+Rewrite`（把材料改写成含答案的知识陈述）是主要收益来源，**不是可选优化**。
`generate()` 返回的 `calls` 里能直接读出次序：

```js
out.calls // ['rewrite', 'generate', 'rewrite', 'generate', ...]
```

第二段请求体里带的是 `statements`（改写产物），**不带** `material`（原始 ASR）——
这一点由测试捕获请求体断言。

## 质检是**三态**的

| 判定 | 含义 | 后果 |
|---|---|---|
| `pass` | 检查**适用**且通过 | 继续走后面的层 |
| `fail` | 检查**适用**且不通过 | 硬检查失败 → **直接丢弃**，不用 LLM 判 |
| `undecided` | 检查**适用但输入不在场** | **不许**自动采纳，进人工队列 |

「检查**不适用**于这道题」（如短答题去查「挖空标记」）算 `pass` 并在 `detail`
里写明「不适用」—— 那不是缺失输入，而是这道题**根本没有**那个维度；
记成 `undecided` 会让人工队列被「每道纯文本题都待人工」淹掉，那就等于
把人工环节做成橡皮图章。

**关键**：`passedAll` 为真**不代表**题目值得做 —— 实测 120/122 通过全部硬检查，
仍有 8/120 被警告层标记。硬检查保证**结构**，不保证教学正确。

## 本包**不做**什么

| 不做 | 理由 |
|---|---|
| **不落盘** | 不 import 文件系统模块、不拼路径、不写文件。持久化由集成层用宿主存储栈完成（`ctx.storage`）。扫源码的测试钉住它。 |
| **不发 HTTP** | llm 由集成层注入窄接口 `{ call({stage, route, constant, variable, signal}) }`。 |
| **不读环境变量** | 同上，配置由集成层给。 |
| **不引入任何依赖** | `package.json` 里没有 `dependencies`；源码只 import `./` 相对路径。 |
| **零 UI** | 界面在别的包。 |

并发闸是本包**本地 20 行原语**（与 `dsh-zhiyun-parser` 的 `Limiter` 同语义），
不跨包复用：本包必须能单独发布，为了一个信号量去依赖兄弟包会把版本拴在一起。

## 用法

```js
import { createQuizGenerator } from 'dsh-zhiyun-quiz/generate';
import { createQualityPipeline } from 'dsh-zhiyun-quiz/quality';
import { makeSourceMaterial } from 'dsh-zhiyun-quiz/generate';

const gen = createQuizGenerator({
  llm,                        // 集成层注入的窄接口
  concurrency: 3,
  pipeline: createQualityPipeline({ answerability, judge }),
});

const out = await gen.generate({
  blocks: [makeSourceMaterial({ blockIndex: 0, page: 1, atSec: 0, summary: '…' })],
  context: { courseId, sectionId, pageCount: 12, sourceRevision },
  signal,                     // 取消抛 CANCELLED，不降级
  onProgress: ({ phase, done, total }) => {},
  rate,                       // 额度台账（可选）
  maxCards: 5,
});
// out: { admitted, rejected, problems, calls, rate, density, ok, summary }
```

Cordis 插件形式：`ctx.provide('zhiyunQuiz', { generate, store, dispose, … })`，
`inject: ['zhiyunParser']`（**不声明存储** —— 本包不落盘）。

## 验收

```bash
node --test tests/quiz.test.mjs
```

108 个用例全绿，覆盖任务书列的八条硬验收：
① 默认不入库 ② 硬检查失败就丢弃且有原因 ③ 三态（不在场是 `undecided`）
④ 锚点等式 `materialIdWith` ⑤ `wholeSection` 被拒 ⑥ 每块两次调用且次序固定
⑦ 取消抛 `CANCELLED` ⑧ 源码不出现 `node:fs` / `ctx.storage` / `process.env`。

> 测试是**离线**的：假 llm，不联网、不落盘。108 个用例 / 0 失败。

其中第 ① 条有**两层**保证：行为层（`saveGenerated` 产出的题进不了 `reviewQueue`）
+ **源码层**（扫 `store.js`，断言把题写成 `accepted` 的**写点只有两处**：
`saveSelfAudited` 与 `adopt`）。后者才是「没有别的路径」这句话的证据 ——
将来有人加一个批量采纳函数，它会立刻变红。

⚠️ 第 ⑧ 条的扫描**只针对代码，不针对注释**：本包的注释里**故意**写着
「这里不 import 文件系统模块」「持久化由集成层的存储服务负责」「不走 tmp+rename」
—— 那些是**说明为什么不这么做**的取舍记录。对整份文件做关键词扫描会把它们
误判成违规，于是为了过测试就得**删掉理由**，那正好把最有价值的注释换成了
最没价值的门禁。所以扫描先剥注释，并配一条反向对照断言证明剥离真的在剥。

---

## 实现与**未实现**判据（如实）

对齐度高的部分不在这里重复（见上面）。以下是**没有做到**或**与 App 有出入**的点。

### 1. 选择题 / 案例题的**生成**未实现（有意的，且拒绝在花钱之前）

请求里含 `mcq` / `caseStudy` 时，`planQuizGeneration` 会在**任何模型调用之前**
拒绝整次请求，理由名是 `typeNotImplementedInJs`：

```
typeNotImplementedInJs：本包**没有实现** mcq 的构造路径（现在能出的是 cloze、shortAnswer）。
⚠️ 选择题要造干扰项（实测 AI 干扰项仅 45% 功能有效）、案例题要综合多块，
它们的**形状与质检**已经实现并有测试覆盖，缺的是**构造那一步**。
这里直接拒绝，**不产出一道构造不完整的题**，也不先花一次 rewrite 的钱
```

- **形状**（`model.js` 的 `choices` / `distractorSourceIds`）与**质检**
  （`singleCorrectAnswer` / `optionCount` / `duplicateOption` /
  `numericEquivalence`）**都实现了**，且有用例覆盖；
- `distractorTraceability`（干扰项逐条可追溯）**已移植，有 4 个用例**；
- **未实现**的是 Dart 的 `buildMcqItem` / `buildCaseItem` 两条构造路径：
  `parseMcqRow` / `parseCaseRow`、选项按池内下标替换、案例题的多块综合与
  `_decorateStatements`、以及案例题「整批只出一次」那条分支。
- 理由：任务书把本包范围定为「题形状 + 先筛后出 + 三态硬检查」，
  而 Dart 自己就把选择题放在**质检链路验证之后**（实测 AI 干扰项仅 45% 功能有效）。
  与其产出一道半成品，不如**明确报名字**。
- ⚠️ 拒绝**必须在计划层**：若放到逐块循环里报，第一块已经发过一次 `rewrite`，
  而这次请求必然一道题都出不来 —— 那一笔是**纯白花**。有三个用例钉住这一点
  （`llm.calls.length === 0`，含正向对照：第 3 期的两类题不受影响）。

> 常量 `kImplementedQuizTypes` 与 `kPhase3QuizTypes` **值相同但含义不同**：
> 前者是「本包的代码里真的有这条构造路径吗」，后者是「产品这一期上哪两类」。
> 合成一个会让「白名单允许」被静默读成「本包实现好了」。

### 2. 讲义题送进硬检查会在 `schema` 上 fail（**与 App 同病**，已钉住）

事实（两侧都成立）：

- App 的 `lib/state/quiz.dart` 造讲义题时写 `blockIndex: -1` / `page: 0`；
- `quiz_quality.dart` 的 `schema` 项要求 `blockIndex >= 0` 且 `page >= 1`
  → 讲义题必然 `schema` fail；
- App 之所以不受影响，是因为「按讲义出题」**整条绕过质检链**：
  它自己的准入判据是 `admitLectureDrafts`（依据必须对得上工具回包原文），
  然后走 `saveSelfAudited` 直接进队列。

**本包照抄 App 的取值（-1 / 0），不改成能过 `schema` 的假值** ——
改成 `page: 1` 是发明一个 App 没有的取值，会让两边读同一份数据时对不上。
这条不一致由 `tests/quiz.test.mjs` 里一条**明确标注为「已知未对齐」**的用例钉住，
免得它被误读成「讲义题也过了质检链」。

**没做到的**：没有为讲义题单独定义一套质检口径。App 也没有。

### 3. `3.5×10^3` 解析不出来（Dart 的文档与实现不符，本包照抄**实现**）

`quiz_quality.dart` 的 `parseNumericValue` 文档说认 `3.5×10^3`，但实现先把 `×10`
替换成 `e`（得到 `3.5e^3`），而科学计数正则不接受 `^` → 返回 `null`。

本包照抄**实现的判据**（返回 `null`，落进 `uncovered`），不照抄文档的承诺 ——
猜成 3500 正是「假装准确」。有一个用例把这件事如实钉住。

### 4. 未移植的 Dart 成员（不在本任务范围）

| Dart | 状态 |
|---|---|
| `QuizRateLedger` / `QuizRatePolicy` / `QuizRateDecision` | **已移植**（含按天 / 按节、`check` / `consume` / JSON 往返） |
| `computeBacklog` / `QuizBacklog` | **已移植** |
| `adviseCardsPerPage` | **已移植** |
| `dropExactQuizDuplicates` / `parseQuizDedupeIndexes` | **已移植** |
| `QuizAttempt` / 错题归因 / 薄弱点 | **已移植**（含 FSRS 隔离：`fsrsRating` 只来自 `selfRecall`） |
| `wilsonInterval` / `ratioWithWilson` | **已移植**（`n=0` 拒绝给数） |
| `HumanCorrectionLedger` / 人工修正台账 | **未移植**（App 侧是审核界面的一部分，属 UI 层） |
| `rankByAgreement` / `AgreementRanking` / `WilsonInterval` 排名的**分配**逻辑 | 只移植了「一致性不得当放行阈值」这条纪律（`kAgreementGatingBanReason`）；排序 / 分配算力是审核界面的活 |
| 干扰项**功能率**统计（`DistractorStat` / `DistractorAnalysis`） | **未移植**（依赖真实作答的大样本，属统计报表层） |
| `QuizGenerator` 的案例题「整批只出一次」分支 | 未实现（依赖案例题构造，见第 1 条） |
| `saveSelfAudited` 的 `notes` 文案 | 已对齐，但**行号 / 文件路径**类的文案（如「第 3 行」）本包不产生（本包不认识文件） |

### 5. 一处**有意的**与 Dart 不同的设计

Dart 的 `QuizGenerator.generate` 是 `request` + `rate` + `maxCards` 三个位置 / 具名参数；
本包收一个 `{ blocks, context, signal, onProgress, rate, maxCards }` —— 因为任务书
指定的签名就是这个（`generate({ blocks, context, signal, onProgress })`）。
`rate` / `maxCards` 作为**可选**扩展字段保留，行为与 Dart 一致
（速率判定在**任何模型调用之前**，不够就**明确拒绝**而不是静默少出几张）。

### 6. 并发

`createQuizGenerator({ concurrency })` 的并发闸**已实现**（含「异常也释放名额」与
「排队中可取消」两条语义，各有用例），但 `generate()` **按固定次序逐次 await**
（先 rewrite、再 generate），所以实际在飞请求恒为 1。
`concurrency` 的实际作用是**硬上限**：它让 `active <= concurrency` 成为一条
能用代码判的不变量。这不是缺陷，是「先筛后出 + 两次调用次序固定」的必然结果；
如果将来要并行处理多块，闸已经就位。
