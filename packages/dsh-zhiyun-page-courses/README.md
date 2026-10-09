# dsh-zhiyun-page-courses

「我的课」页：课程网格、查找框与未登录提示。

**改这一页的东西都在这里**。已规划的方向：现在点课程直接跳「学习」页只是权宜之计，未来的**视频播放器**和**笔记记录系统**接进「我的课」时，它们的界面部分属于本包。

## 边界

- `inject: ['slots']`，领域状态用 `ctx.inject(['zhiyunStudyController'], …)` 惰性取（来自 `dsh-zhiyun-study-core`）：停用领域包时这一页只是空着，不会把整个前端拖成 pending。
- 注册插槽时带 `priority: 10` —— 外部扩展（如 `tests/fixtures/course-panel/`）用默认 0 就能遮蔽这一页。这是产品预留的替换点，不是测试专用。
- 点课程走 `controller.selectCourse(c)` + `controller.navigate('study')`。

## 插槽

在 `zhiyun.courses.content` 注册内容（`children` 声明归外壳）。
