# dsh-zhiyun-shell

智云 Pro 的界面外壳插件：侧栏、页框架、主题层、导航服务与插槽契约。当前验证宿主为 `0.2.0-rc.2`。宿主提供 React 和全部 DSH 客户端服务；不要再打包一份 React。

外壳**不认识任何具体页面**：它声明五个页面的面板骨架和内容插槽，页面由各自的插件包填充（`dsh-zhiyun-page-today / -courses / -study / -me`）。页面包没装时页面显示「暂时不可用」占位，外壳照常工作。

构建：在仓库根运行 `npm run build`。本地 profile 通过目录链接加载 `lib/`，修改源文件后需重新构建，DSH 的客户端更新机制会更新页面。

## 页面插槽

外壳在 `main` 插槽里为 `NAV` 的每一页声明一个 **root / single** 内容插槽（声明即认领，页面包只注册内容，不重复声明 `children`）：

| 插槽 | 内容位置 |
| --- | --- |
| `zhiyun.today.content` | 今天页正文 |
| `zhiyun.courses.content` | 我的课页正文 |
| `zhiyun.study.content` | 学习页正文 |
| `zhiyun.me.content` | 个人页正文 |
| `zhiyun.me.account` | 个人页账号区块（嵌在个人页正文里） |

页面包在客户端导出 `inject: ['slots']`，然后：

```js
// 只用外壳给的 controller（今天页）：
export function apply(ctx) {
  ctx.slots.inject('zhiyun.today.content', () =>
    ctx.slots.register({ name: 'zhiyun.today.content' }, TodayPage)
  );
}

// 还要领域状态（我的课 / 学习 / 个人）：先等 controller 到位，再注册插槽
export function apply(ctx) {
  ctx.inject(['zhiyunStudyController'], (scope) => {
    scope.slots.inject('zhiyun.courses.content', () =>
      scope.slots.register({ name: 'zhiyun.courses.content', priority: 10 },
        () => <CoursesPage controller={scope.zhiyunStudyController} />)
    );
  });
}
```

页面组件同时从渲染参数里拿到外壳注入的 `controller`（`navigate / toggleSidebar / toggleTheme`）和 `renderSlot`。`ctx.slots.inject` 在声明已存在时立即执行，声明后到也会补执行，外壳卸载时贡献随之撤销（连同 `ctx.inject` 的作用域一起）。

`controller.navigate(id)` 支持 `today / courses / ask / study / me`，`ask` 进入现有 DSH 会话。此接口属于**客户端服务**（`zhiyunNavigation`），不应在宿主插件中注入。

## 领域服务（由 `dsh-zhiyun-study-core` 提供）

外壳只按服务名取用，不静态依赖领域包 —— 领域包被停用时外壳仍能启动，只是列不出会话：

| 服务 | 用途 |
| --- | --- |
| `zhiyunStudyController` | 账号、课程树、讲义与习题的状态机（页面包用 `ctx.inject(['zhiyunStudyController'], …)` 取） |
| `zhiyunLearningSpace` | 学习空间的识别与会话行投影（外壳的会话抽屉用 `ctx.get('zhiyunLearningSpace')`） |

两侧都不写进 `inject`：页面包用 `ctx.inject(['zhiyunStudyController'], …)` 等它到位再注册插槽，外壳用 `ctx.get('zhiyunLearningSpace')` 直接取。领域包缺失或未激活时降级（会话抽屉空列表、页面显示未连接），不会连坐成 pending。

## 生命周期与兼容

`cordis.patch.yml` 禁用官方 `ui-sidebar`，本插件声明同一组侧栏扩展点，保留原生设置与会话入口。右侧栏**不能停用**：宿主的文档/文件/终端分页等 9 个客户端插件都注入 `sidebarRight`，停用它会让整个前端启动失败。

主题通过 `theme.overrideTokens('dsh-zhiyun-shell', …)` 层叠，卸载后撤销。业务内容插槽在外壳卸载时消失，依赖插件应使用 `slots.inject` 随其声明生命周期装卸。

停用外壳时应在 profile patch 中同时设置 `zhiyun-shell.disabled: true` 和 `ui-sidebar.disabled: false`。移除整个 bundle 后其侧栏覆盖自然失效。

共享的图标、品牌标记、空态与分区标题来自 `dsh-zhiyun-ui-primitives`（`dsh.client.external` 里声明，esbuild 里 external）。

`src/style.css` 里的 `.zy-*` 与旧外壳逐字一致（74 个类），另有 4 个无前缀状态类 `is-active` / `is-blank` / `is-current` / `is-danger`（`is-active` 只出现在 `.zy-nav button.is-active`，`.is-blank` 只出现在 `.zy-drawer-name.is-blank` 等，均带宿主前缀限定）。它们与 `dsh-zhiyun-page-study` 的 `.zs-asset-card.is-active`、`.zs-handout-drawer button.is-active` **属性不相交**，当前不会互相覆盖；但无前缀类名本身是跨包共享的命名空间，将来若要给壳侧 `.is-active` 增加属性，先确认不与页面包的声明撞同名属性。

兼容范围当前仅包含锁定版本；没有承诺与最新版 DSH 或任意第三方 UI 同时工作。
