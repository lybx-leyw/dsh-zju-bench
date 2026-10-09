# 智云知识库

解析产物的**入库与检索**。零 UI、零自建落盘：数据全部交给宿主的存储栈。

## 一条硬约束：持久化只用宿主的存储栈

本包是 Cordis 插件，`inject: ['storageDomain', 'profileContext']`，挂载后提供
`ctx.zhiyunKnowledge`。落盘、原子替换、JSON 序列化、变更事件全部由宿主负责：

- `ctx.storageDomain`（`@deepseek-ai/dsh-storage-domain`）：schema 校验 + 单写链的 KV 域。
- `ctx.storage`（`@deepseek-ai/dsh-storage`）：后端注册表；本仓 profile 里 `storage-domain`
  路由到 `json` 后端（`@deepseek-ai/dsh-storage-json`，root = `dshHomePath('storages')`）。

本包**一行文件 IO 都没有**（没有 `node:fs`、没有 tmp+rename、没有自建 JSON 索引），
`tests/knowledge.test.mjs` 里有一条自检把这件事钉住。

## 域与记录

一张表 `lectures`，键是 `accountId:courseId:subId`。**账号在键里**，所以
「不同账号的同名课程节次互不可见」是存储层的性质，不是查询层记得过滤才有的效果。

记录以解析器产物为底：`sourceId` / `accountId` / `courseId` / `subId` / `status` /
`fetchedAt` / `schema`，加 `sentences` / `unassignedSentences` / `blocks` / `spine` /
`outline` / `vocabulary` / `warnings`，以及讲义字段 `lecture`（暂未生成时为 `null`）。
解析器产物里的其余字段（`pages` / `glossary` / `failures` / `calls` / `version`…）
原样带过 —— 记录 schema 是**宽松**的：它声明哪些字段必须在，不限定只有哪些字段。

## 服务接口

| 方法 | 说明 |
|---|---|
| `put(record)` | 写入或**替换**（同一把键再写是替换，不是追加）。写前按宿主 schema 校验，坏记录以 `INVALID_RECORD` 拒绝，不落盘。返回 `{ key, replaced }`。 |
| `get({accountId,courseId,subId})` | 取完整产物；没有这条返回 `undefined`。 |
| `listByCourse({accountId,courseId,full?})` | 列出该账号该课程下的节次摘要（`full: true` 时带完整 `record`），按 `subId` 排序。 |
| `remove({accountId,courseId,subId})` | 删除；`true` 确实删了，`false` 本来就没有。 |
| `search({accountId,query,courseId?})` | **字面**检索：在**块正文 / 块概述 / 块衔接**里做连续子串匹配。返回命中片段（字段名 + 块序号 + 原文）。 |
| `size` / `domainName` / `tableName` / `recordSchema` / `closed` | 诊断信息。 |

### 检索是字面的，不是智能的

`search` 就是 `String.prototype.includes`：大小写敏感、不切词、不做同义改写、
不算相关度。命名与文案都按这件事如实说 —— 它不是向量检索，也不是 AI 检索。
未落页的字幕（`unassignedSentences`）不属于任何块，因此不在被检索的表面上。

## 失败都是有名字的

`KnowledgeError.code`：

- `CONFIG` —— 宿主存储栈解析不出来或形状不对（环境问题，重试无用）。
- `INPUT` —— 身份段 / 记录 / 检索词不合法（输入问题，重试无用）。
- `INVALID_RECORD` —— 记录不过宿主的 schema（含 zod 逐字段诊断）。
- `CORRUPT` —— 记录与它的键身份不一致（不静默当成「没有这条」）。
- `DISPOSED` —— 服务已随插件卸载。

存量记录坏在介质里时，宿主的 `open()` 会以 `DomainError` `invalid-record` 带出
表名与键；本包**不吞**这个错：静默跳过等于把「这条坏了」说成「没这条」。

## 卸载

插件返回的 disposer 按「先封服务入口（此后得到 `DISPOSED`）→ 再释放域（排空在飞
写入、放开域名）→ 摘掉服务」收尾。`domain/changed` 与域名释放都是宿主的行为。

## 前提与验证

前提：profile 必须挂载 `@deepseek-ai/dsh-storage`、`dsh-storage-json`、
`dsh-storage-domain`（本仓 profile 经 `@deepseek-ai/dsh-base` 的 bundle 已具备），
并让 `dsh-zhiyun-knowledge` 进入 profile 的 bundles。

验证：`node --test tests/knowledge.test.mjs`。用例跑的是**真实宿主存储栈**
（从 `.runtime/dsh-<版本>/node_modules` 加载 cordis / dsh-storage / dsh-storage-json /
dsh-storage-domain），覆盖写入-读回逐字段一致、真实持久化、账号隔离、同键替换、
坏字段在写入端与读取端两侧的如实失败、检索命中与未命中、卸载后服务消失与域释放，
以及名单里每个宿主版本。
