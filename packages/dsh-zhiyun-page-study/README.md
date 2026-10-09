# dsh-zhiyun-page-study

「学习」页：课程树、讲义阅读、字幕 / PPT / 终稿四视图、分层检索与解析模型选择。

**改这一页的东西都在这里**（领域状态除外，见下）。这是拆分后最大的页面包：`study-workspace.jsx`（工作台）、`lecture-reader.jsx`（讲义正文渲染）、`layered-search.js` + `layers.js`（分层检索）、`format.js`（时间与节次格式化）。

## 边界

- **领域状态不在这里**：账号、课程树取数、解析任务、持久化都在 `dsh-zhiyun-study-core` 提供的 `zhiyunStudyController` 里，本包用 `ctx.inject(['zhiyunStudyController'], …)` 惰性取。停用领域包时这一页空着，不会把整个前端拖成 pending。
- **检索与格式化留在本包**：`searchLesson` / `hitBlockIndexes` / `layerSpecOf` / `time` / `lessonWhen` 只有这一页用，属于「这一页怎么呈现」，不属于领域。`tests/study.test.mjs` 直接从本包 import 它们（`src/layered-search.js`）。
- `lecture-reader.jsx` 用宿主的 `@deepseek-ai/dsh-client-ui-primitives`（`MarkdownText`，种子词），跨包原语用 `dsh-zhiyun-ui-primitives`（`useStudy` / `Notice`）—— 两个不同的包，别混。

## 插槽

在 `zhiyun.study.content` 注册内容（`children` 声明归外壳）。`ModelSettings` 是这一页的「解析模型」折叠区，读领域状态的路由配置，界面留在本包。
