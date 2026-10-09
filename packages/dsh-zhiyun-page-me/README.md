# dsh-zhiyun-page-me

「个人」页：账号连接、空间信息、偏好开关，以及宿主设置面板的落点。

**改这一页的东西都在这里。** 页面正文（`Personal`）与账号区块（`Account`）都在本包 —— 账号区块原来住在学习面板包里，但它是个人页的内容，页面包拥有自己页面上的一切，所以跟着这一页搬过来。注意 `SignIn`（「连接你的课堂」）在 `dsh-zhiyun-page-courses`：它要点导航去「个人」，属于那一页的交互。

## 两个插槽

| 插槽 | 内容 | 谁声明 children |
| --- | --- | --- |
| `zhiyun.me.content` | 页面正文（个人卡片、偏好、设置入口 `#zy-personal-settings`） | 外壳 |
| `zhiyun.me.account` | 账号区块，嵌在正文里 | 外壳 |

`Account` 用 `ctx.inject(['zhiyunStudyController'], …)` 惰性取领域状态；`Personal` 从渲染参数里拿外壳给的 `controller`（`navigate / toggleTheme`——「切换明暗」走的就是壳的 `toggleTheme`）和 `renderSlot`（用它把账号区块嵌进正文）。

`#zy-personal-settings` 是宿主设置适配器的落点：外壳的 `components.jsx` 用 MutationObserver 找到这个容器（`settings-adapter.js` 只做插槽条目的换装，不碰 DOM），再把原生设置分组 portal 进来。改这个 id 要同步改外壳。
