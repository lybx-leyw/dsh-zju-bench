# 智云课堂解析器

从 Flutter `lib/fusion/` 移植的独立 Cordis 插件。profile 自动加载并提供 `ctx.zhiyunParser`。所有模型调用直接使用宿主 `ctx.llm`；图片由 `ctx.attachments` 持久化与校验。没有独立 API key、模型 HTTP 客户端或另一套 agent runtime。

```js
export const inject = ['zhiyunClassroom', 'zhiyunParser'];
export async function apply(ctx) {
  // 登录交给数据源与产品账号流程，不自动读取开发凭证。
  const result = await ctx.zhiyunParser.parseClassroom(courseId, subId, {
    context: '课程名 · 节次', signal, onProgress: progress => { /* 更新进度 */ }
  });
}
```

也可以调用 `parse({ slides, subtitles, sourceId, context, signal, onProgress })`，独立验证解析器。每页需要 `page`、`createdSec` 及 `imageBytes` / `imagePath` / 智云资源 `imageUrl` 之一；字幕是 `{startMs,endMs,text}`，时间单位为毫秒。

三个阶段：课件分组看图如实转述 → 逐页纯文本纠错与语义分块 → 分卷维度标注与整节主线。混合解析和标注阶段不再次上传图片。结果含逐句时间与页码、块边界、桥接说明、标签、概述、主线、术语表以及失败诊断。模型输出不掌管时间、不允许删句；过度改写被拒，失败时原文保留并标记 `partial`。

课件描述默认每组最多 **4 页**，以 2×2 原尺寸拼图发送，按原课件页码拆回独立的页面文字、画面与术语。剩余 2–3 页仍拼图，单页直接发送；已有单图缓存继续复用，只把未缓存的页拼在一起。`concurrency` 限制的是模型请求数，默认三个组可同时处理最多十二页，混合解析也使用同一并发闸。拼图不主动缩小原图，超过宿主默认 4194304 像素预算则退回单图。图片构建由插件声明的 `sharp` 依赖完成，模型及附件仍全部使用原生 DSH 服务。

拼图响应若缺页、重复页码、缺少段落或发生超时/截断，会对受影响的页单图补发；正常页照常保留，回退原因记入 `warnings`。一张损坏图片不会让邻页字幕丢失。拼图与单图缓存分开保存；可配置 `visionBatchSize: 1` 完整退回原单图路径（支持 1–4，默认 4）。这项优化允许视觉细节有一定损失，未改变终稿、讲义及字幕来源语义。

句子层分两处：`sentences` 是**页内**句子（块层的坐标基准），`unassignedSentences` 是没落到任何一页上的字幕 —— 它们没有页，所以没有图可以对照纠错、也不进块层与标注，但内容一句不丢；有它们时产物标为 `partial`。块永远只覆盖页内句子。

标注按分卷进行：全部卷并发发出（并发上限由闸约束），失败的卷**只补发那几卷**，两轮、轮间退避 2 秒×轮次；成功的卷照常收下（一题坏只扣那一题）。整节主线的区间会过一遍机械清洗：越界、反向、与前文重叠的区间逐条剔除并写进 `warnings`，其余照常给 —— 不因为一条坏区间丢掉整份主线，也不在代码里凭空补一段。失败卷在 `tagFailures` 里带 `blockFrom`/`blockTo`。

混合解析每页最多 3 轮；纠错被拒与块覆盖违规在同一个循环里收敛，重试提示会逐条点名被拒条目与违规区间。**只有收敛的回包才进缓存**：未收敛的页不固化，用户「重新整理」时那一页才会真的重试（这一处与 App 的段缓存策略不同，理由见迁移记录）。

纠错采用 JS 的宽松策略：比较时先做 Unicode NFKC 归一化（含全半角和上下标字符），排除空白、零宽空格，并统一等价引号、句号、减号和分数斜线；展示时保留模型输出的排版。实质编辑距离上限由 App 的 50% / 30 字放宽为原句的 **80% / 80 字**，允许结合课件恢复严重听错的公式和术语，仍不允许无依据补写或改变句子来源。`correctionDistance` 为排除格式差异后的距离；被拒记录同时保存 `rawEditDistance`。原始 App 提示词基线保留，构造请求时同步应用新策略。旧策略下成功的混合解析缓存经新规则复核后复用，失败页继续重试。

公式比较也识别 LaTeX 数学定界符、常用希腊字母与算符命令、排版空白、字体包装和上下标，与等价 Unicode 写法比较；未知命令保留，不会随意吞掉数学内容。单句块的 `块 21` 与 `块 21-21` 等价，仍须通过完整覆盖检查。

默认跟随 DSH 当前模型的 provider/model，但不继承聊天的推理档位。视觉模型必须明确支持 image；否则开跑前抛 `VISION_MODEL`。可用用户 profile overlay 单独选择视觉与文本路由（凭据仍在宿主模型设置中）：

```yaml
- id: zhiyun-parser
  config:
    concurrency: 3
    visionBatchSize: 4
    vision:
      provider: your-host-provider
      model: your-host-vision-model
    text:
      provider: your-host-provider
      model: your-host-text-model
```

可选字段 `reasoningEffort`、`maxTokens` 使用 DSH 自己的契约，不转译为供应商私有参数。未指定 reasoningEffort 时，优先选模型声明的 none/off/disabled；没有此档位则由宿主决定。宿主流截断、空响应或异常均不进入成功缓存。

拼图沿用视觉路由与 `accel.faithful` 的输出预算，未配置时由宿主决定；密集页面可在模型支持时配置 `accel.faithful.maxTokens: 32768`，减少整组截断后补发的次数。

### 加速档位 `accel`

按阶段配置，**没给的字段一个都不发送**（由宿主决定默认值），所以不配 `accel` 时发出的请求与不加速逐字段相同：

```yaml
- id: zhiyun-parser
  config:
    accel:
      faithful: { maxTokens: 32768 }        # 看图阶段
      mix: { maxTokens: 32768, reasoningEffort: low }
      tags: { maxTokens: 4096, reasoningEffort: low }
      outline: {}                           # 打开了这一格但没配字段 = 与不配等价
      escalation: { maxTokens: 60000 }      # 撞上输出上限时的升档预算
```

`maxTokens: 0` = 不传该字段。写错的档位名或字段**在开跑前报错**（`CONFIG`），不猜一个近似值 —— 静默换档位会让「我明明设了 low 为什么很慢」永远查不出来。

`escalation`：某次调用以宿主 `finish.reason.kind === 'max-tokens'` 结束时，按升档预算重试**恰好一次**（默认倍数 2、硬顶 131072）；仍截断就走原来的 `TRUNCATED` 失败路径。只配了 `escalation` 而没有阶段档位也能生效：升档预算作为该阶段重试时的预算下限（绝不下调已有预算），`ceiling` 是硬顶上限（必须 ≥ 升档预算，否则开跑前报错）。**抬不动就不重试** —— 预算已到硬顶、或升档档位与现值相同时请求根本没变，重发只会白花一次调用。没配升档预算时同样不重试。

### 词表持久化

`vocabularyStore` 是词表落盘的口子（`{ load(), save(vocabulary) }`），插件默认用 `<profile>/data/zhiyun-parser/vocabulary.json`，落盘走宿主 `@deepseek-ai/dsh-atomic-write`。解析开跑前 `load()` 一次作为种子，解析结束后**只在真的有新增标签时** `save()` 一次；同一节的所有分卷共享加载后那一份快照，因此词表变了旧标注就不会再命中缓存。`load()` 抛错或数据损坏**不会**让解析失败：退回种子词表，原因同时进 `warnings` 与 `parser.loadIssues`，不静默当成「这次没有新增词」。解析失败时会保留已经提名的新标签，**取消时不写盘**（用户按了停，就不在磁盘上留下他没收下的东西）。

缓存位于独立 profile 的 `data/zhiyun-parser/cache`，绑定模型路由、提示词、图片内容、原字幕和时间。缓存含课程转述与文字，属于用户数据。`dispose()` 会取消本插件所有任务，Cordis 卸载自动调用。

`parseClassroom` 默认要求课件和字幕均确认收全；可显式传 `allowPartialSource: true` 调试未完成数据，结果仍标记部分完成。截图过滤是结果上的 gate 元数据，不丢弃其对应字幕。逐页失败不会抹掉其他页的有效结果。

验证命令：`npm run test:parser`、`npm run parser:verify`、`npm run parser:parity`。最后一个需要相邻 Flutter 仓库和 Dart SDK，仅运行纯 Dart 契约导出，不运行 Flutter 全量测试。
