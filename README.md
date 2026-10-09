# 智云 Pro · DSH 工作台

独立的 `zhiyun-bench` profile，加上 `dsh-zhiyun-shell` 界面外壳。当前对应 Flutter App 的“今天 / 我的课 / 问一问 / 学习 / 个人”，采用暖灰背景、官网求是蓝（#00479D）品牌标记与主要操作、紧凑导航和学习内容卡片；深色模式采用中性炭灰与柔和蓝色强调。保留 Pro 自有标记，官网公开资源整理在 `artifacts/official-classroom/README.md`。

Pro 标记沿用官网的圆角板面与支脚轮廓，板内写 Pro，侧面搭配智云字标；收起导航时切换为更窄的无字轮廓。SVG 位于 `packages/dsh-zhiyun-ui-primitives/src/assets/`，提供随主题变色的完整与无字图标、蓝色及白色完整字标。文字均为矢量路径，不依赖客户端字体。`scripts/generate-brand.py` 是可选的设计生成工具，不参与应用构建。

界面按**职责**拆成包，而不是一个大插件：外壳只声明页框架与插槽、不认识任何具体页面；共享的 UI 原语（图标、品牌标记、空态、样式挂载）单独一个无状态包；账号、课程树、解析编排这些**跨页共用的领域状态**只有一份，装在领域包里、经 Cordis 服务交给页面；每个页面一个包，谁改哪一页一眼可见。依赖方向单向：页面包 → 领域包 / 原语包，外壳不依赖任何页面。

已建立 profile、界面外壳、共享原语、领域状态层、独立智云课堂数据源 `dsh-zhiyun-classroom`、三阶段解析器 `dsh-zhiyun-parser`。个人账号登录、我的课、节次选择、PPT/字幕、解析进度与取消、结果阅读和筛选已接入页面；解析直接使用 DSH 的 LLM 与附件服务。笔记、复习、计划、知识入库和服务器同步仍在后续阶段，页面明确显示未接入说明。没有引入 `zju-mcp` 的知识库或融合解析实现。参见 [学习面板接入](docs/study-integration.md)、[数据源用法](packages/dsh-zhiyun-classroom/README.md) 和 [解析器用法](packages/dsh-zhiyun-parser/README.md)。

## 启动

当前针对 **DSH 0.2 线**。已验证两个宿主版本：**0.2.0-rc.2（npm `latest`，Cordis 4.0.4）与 0.2.1-alpha.1（上游 HEAD，Cordis 4.0.5-alpha.1）**，两者都跑过同一套浏览器验收（见 `artifacts/host-report-<版本>.json`）。0.1.5-rc.2 已不在支持清单里。通过官方 CLI 启动宿主自带的 Web 工作台，不修改上游代码，也不修改原 DSH 用户配置。

宿主的解析顺序（`scripts/profile.mjs`）：`ZHIYUN_DSH_APP_DIR` → 本机已安装的 DSH Desktop → 本仓库 `.runtime/dsh-<版本>/`（先试 `preferredHostVersion`）。**只接受清单内的版本**：机器上装的是旧版（例如 0.1.5）时会自动改用仓库内已验证的那份，并把实际用的宿主打印出来，不会拿未验证的版本凑合。

宿主换了版本或安装位置时，profile 里那两条指向宿主包的链接会被**改指**过去（它们由本脚本创建）；如果那里放的是你自己创建的实体目录，则一律报错退出，不覆盖。原地升级 DSH Desktop（路径不变）不需要做任何事，数据照旧。

指定宿主验证：

```powershell
$env:ZHIYUN_DSH_APP_DIR = 'D:\other\dsh-install'      # 含 node_modules/@deepseek-ai 的 app 目录
npm start
```

```powershell
cd C:\Users\19389\Desktop\zhiyun-pro-js
npm ci
npm run build
npm start
```

启动后打开终端输出的完整本地地址（包含临时访问令牌）。默认端口 `3091`。首次可能出现 DSH 内测说明；继续后进入智云“今天”。“问一问”进入即可输入——工作区已固定为学习空间，要真的收到回答还需在设置里配置模型。

如果宿主不在默认安装位置：

```powershell
$env:ZHIYUN_DSH_APP_DIR = 'D:\DSH Desktop\resources\app'
npm start
```

可选变量：`ZHIYUN_PORT` 修改端口；`ZHIYUN_DSH_HOME` 指定专属数据目录。默认 `.runtime/home/` 保存会话、配置及存储，**这不是可随意删除的构建缓存**。`.runtime/dsh-<版本>/` 是给兼容性验证用的宿主临时安装（各约 500 MB），删掉只影响「本机没有受支持版本时的回退」。不会读取旧项目的 `.env`，也不会自动复制用户凭据。

`npm run profile:init` 可重复执行：创建 profile、连接本地插件和宿主包；已有自定义配置保持原样。遇到其他项目的同名 profile、冲突路径或不匹配的宿主版本会报错，不覆盖。

## 结构

```text
profiles/zhiyun-bench/                profile 模板：base → web-app → 智云界面
packages/dsh-zhiyun-shell/            界面外壳：侧栏、页框架、主题、导航服务与插槽契约
packages/dsh-zhiyun-ui-primitives/    共享 UI 原语：图标、品牌标记、空态、样式挂载（无状态）
packages/dsh-zhiyun-study-core/       领域状态层：学习空间、学习控制器与后端（多页唯一真源）
packages/dsh-zhiyun-page-today/       「今天」页
packages/dsh-zhiyun-page-courses/     「我的课」页
packages/dsh-zhiyun-page-study/       「学习」页：课程树、讲义阅读、分层检索与习题
packages/dsh-zhiyun-page-me/          「个人」页：账号、空间信息与偏好
packages/dsh-zhiyun-classroom/        独立智云课堂数据源
packages/dsh-zhiyun-parser/           使用宿主 LLM / 附件的三阶段解析器
packages/dsh-zhiyun-lecture/          PPT 知识树 + 习坎填充讲义 + 书面语验收
packages/dsh-zhiyun-final-pass/       无曰终审：跑在宿主 agent 运行时（agents/subagents/fs）
packages/dsh-zhiyun-knowledge/        解析产物入库与检索：宿主 storage-domain
packages/dsh-zhiyun-quiz/             题形状、先筛后出、三态硬检查、去重
packages/dsh-zhiyun-notes/            节笔记与 zy:// 内链解析
scripts/profile.mjs                   初始化、版本检查、官方 CLI 启动
scripts/build.mjs                     浏览器 bundle；React 由宿主提供
tests/                                profile 保护与导航测试、扩展插件 fixture
artifacts/                            真实宿主浏览器验收与截图（忽略提交）
.runtime/home/                        当前产品的独立持久数据（忽略提交）
.runtime/dsh-<版本>/                  兼容性验证用的宿主临时安装（忽略提交）
.ref/                                 官方 Harness 参考源码（忽略提交）
.ref-codex-ui/                        Codex UI 参考源码（忽略提交）
```

参考仓库的 HEAD 并不等于运行时版本；**已验证版本清单**见 `runtime.lock.json` 的 `hostVersions`（Cordis 只约束大版本）。往清单里加一个版本之前，必须先用该版本的宿主跑通 `npm run test:host`，并把结果留在 `artifacts/host-report-<版本>.json`；只放宽版本号不算支持。

## 已实现

- 启动进入“今天”；固定安排在插空任务之前。
- 「问一问」固定绑定产品自带的学习空间（`<数据目录>/workspace`，标题「智云学习空间」）：进入即可输入，不再出现「选择工作区」。宿主会复用该目录下已有的空白会话，反复进出不会攒会话；已打开的会话不会被顶掉。工作区列表含糊（多个候选且都认不出）时不做选择，交回用户。
- 会话管理（切换 / 新建 / 重命名 / 归档）是**问一问的左侧整高抽屉**，形态对齐 app 的 `lib/widgets/chat/session_drawer.dart`：会话条显示当前会话并开合抽屉；抽屉贴问一问面板左缘拉出（Material 抽屉语义：宽 304、右侧圆角、遮罩、Esc／点遮罩关闭、点一行即切换并关闭）；头部是「历史图标 + 会话 + 新建」，列表行是「会话图标 + 标题 + 相对时间 + `⋯`（重命名 / 归档）」，空态是「还没有会话」。与 app 的两处差异：说明位置放相对时间而非「N 条消息」（宿主的列表投影没有消息条数），菜单是「归档」而非「删除」（宿主只提供归档，且可在宿主设置里恢复）。侧栏**不再**挂宿主的会话/工作区浏览器 —— 这个工作台只有一个学习空间，没有「切换工作区」这个概念。
- 五项主导航、Ctrl+K 搜索跳转、可收起侧栏、学习页签。
- 明暗主题通过宿主 theme 服务切换，原生聊天也采用智云配色。
- 原生会话树、模型设置、权限与审批能力由 DSH 提供。
- 设置融入“个人”：通用设置、AI 服务、功能与插件、AI 使用偏好按卡片展开，直接使用原生设置插件的真实表单。侧栏不再显示单独的设置入口；宿主设置快捷键也进入个人页。首次配置引导与连接恢复仍由宿主管理。
- 课程、学习、今天、个人页面提供声明式内容插槽，业务插件可以替换内容。真实宿主里已用一个**不属于产品**的测试插件接管「我的课」内容，并通过产品的导航服务跳回今天。页面本身也是插件：外壳没装页面包时显示「暂时不可用」占位，装了哪个页面就有哪一页。
- 样式、主题覆盖、导航服务、插槽都属于 Cordis 生命周期；停用产品包后一并回收，宿主官方侧栏与会话界面恢复（见 `artifacts/disabled-host-sidebar.png`）。
- 新增插件行在下一次文档加载时进入浏览器启动图谱（宿主按 `index.html` 请求注入启动图谱）；已加载 bundle 的重建走宿主 HMR。

主题包替换 `ui-sidebar`，保留 `ui-layout`、`ui-renderer`、聊天、设置等宿主插件。不能与另一个同时拥有侧栏子插槽的风格插件共同启用。没有修改上游 DOM 节点；少量 CSS 适配绑定到自有标记，原生 hero 标题布局仍依赖固定版本的结构，受浏览器回归保护。

外壳的 `src/settings-adapter.js` 负责把宿主设置嵌进个人页：暂时包装原生 `sidebar.settings` 的组件，并保留原登记的子插槽授权、store 和注入能力，再通过 React portal 将设置分组放到个人页。DSH 0.2 不允许另一登记重复声明这些子插槽，因此这不是通用插件 API；升级宿主必须跑真实宿主回归。适配会随原登记换代，停用时恢复原组件，不复制配置表单或配置数据。

**右侧栏那条轨道不要碰**（这条是实测踩出来的）：宿主的右栏（文档 / 文件 / 终端分页，`ui-sidebar-right`）拥有它，并且它的呈现同步会把轨道关回去 —— 我们调 `ctx.layout.openRightbar()` 会被它立刻关掉，抽屉只剩 1px 边框；而**停用**它更糟：`chat`、`skill`、`plan`、`deliverables`、`subagent`、`reference`、`files`、`terminal`、`documentpreview` 这 9 个客户端插件都注入它的 `sidebarRight`/`sidebarRightTabs` 服务，前端会以 “web boot: 9 entries did not activate” 直接起不来。宿主布局能占版面的座位只有三个（左栏 / 中间栏 / 右栏），所以会话抽屉用抽屉自身的语义实现：固定定位、贴问一问面板左缘、整高、带遮罩，锚点跟着导航栏实测宽度走（可收起、可拖动）。

## 检查

```powershell
npm test
npm run check:css
npm run profile:check
npm run profile:dump
npm run test:host
```

宿主测试使用另一个全新数据目录、随机本地端口和无头 Edge，不调用模型、不读取校园账号。**十五项**检查覆盖真实页面装配、五项导航、Ctrl+K 搜索、宿主主题服务、原生会话与设置、窄窗口无横向溢出、学习空间绑定、**会话抽屉是贴问一问面板左缘的整高抽屉（断言高度、锚点、宽度、遮罩、Esc 与点遮罩关闭）**、**独立插件接管课程内容并通过导航服务跳转**、以及**停用产品 bundle 后回收样式与插槽、恢复宿主侧栏**。每次运行都会留下总报告与按宿主版本命名的报告、截图在 `artifacts/`。可用 `ZHIYUN_BROWSER_CHANNEL` 指定已安装的其他 Chromium channel，用 `ZHIYUN_DSH_APP_DIR` 指定要验证的宿主安装。`node scripts/shots.mjs "<带 token 的地址>"` 可对运行中的实例抓一套版面截图并打印抽屉的位置尺寸与结构，便于挑视觉问题。

宿主自己的首次上手弹窗（内测声明、添加 API Key）由测试按用户方式确认（「继续」/「稍后配置」），它们属于宿主上手流程，不是本产品的验收内容；未配置模型时该弹窗会在每次文档加载后再次出现。

`npm run check:css`（也作为 `tests/css-order.test.mjs` 跑在 `npm test` 里）检查各包样式表之间的隐式层叠依赖。每个包的 `style.css` 是各自独立的一张 `<style>`，同特异性下**胜负只看哪张表后挂载**，而挂在顺序取决于各插件激活时机。所以有一条硬规则：**每条 `@media` 覆盖必须和它要覆盖的基规则待在同一个包里**。拆包时真的踩过一次 —— 移动端覆盖被整块留在最先挂载的原语包里，窄屏样式全部失效且不报任何错（细节见 `packages/dsh-zhiyun-ui-primitives/README.md`）。

守卫的判据是「**两条规则能命中同一个元素 + 特异性相同 + 争同一块地盘 + 值不同** ⇒ 胜负只剩挂载顺序」。「能命中同一个元素」按**主体（最右复合选择器）相同且选择器记号有交集**判定，**不是**选择器字符串全等 —— 后者会漏掉「同一个选择器在别的包里换了个祖先链写法」这种最可能重现的形状。同时它也算特异性：`body[data-zhiyun]` 这类主题作用域前缀会抬高特异性（属性选择器与类同级），带前缀的那条无论挂载顺序都赢，属确定性结果、不算隐患。覆盖的形状包括：跨包冲突、跨包**不同** `@media` 条件在同一宽度下同时生效、同包内 `@media` 覆盖写在基规则之前（同包内也是后写的赢）、以及**简写与它重置的长写**（`margin` vs `margin-bottom`；`margin-top` 与 `margin-bottom` 互不重置，不会被误报）。测试里除「真实仓库必须干净」外还有一组**造坏**用例——守卫没牙比没有守卫更糟，它会给出虚假的安心。

客户端包的 `external` 面由 `tests/build-seeds.test.mjs` 守着（也跑在 `npm test` 里）。跨包 import 必须写进该包 `package.json` 的 `dsh.client.external`，`scripts/build.mjs` 直接照用这份声明当 esbuild 的 `external` —— **只有一处真源**。漏项的两种失效都不报「缺依赖」：本机解得开的词（如 `@deepseek-ai/cordis`）会被 esbuild **静默整包内联**，产出平白多几万字节、运行时出现插件与宿主两个实例；本机解不开的词（`dsh-client-ui-slots` 等）则直接 `Could not resolve`。守卫同时覆盖宿主静态模块表的全部 **9 个种子词**，并用「不落盘构建 + metafile」断言产出里没有任何本包 `src/` 之外的文件 —— 后者才是能看见「到底把谁打进去了」的那条断言。

## 参考与边界

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：运行时及官方服务。参考提交 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。
- [DSH Codex UI](https://github.com/MichengAI/dsh-codex-ui)：参考 manifest、浏览器 factory 装配、插槽所有权及宿主验证方式；提交 `ff42c6f9296ee7022ab2e919f849ecd05d4df63e`。没有引入该插件的业务或界面实现。
- `zju-mcp`：仅参考独立 home/profile 的组装方式。
- `zhiyun-pro/lib/app_shell.dart` 与 `theme.dart`：导航、配色、密度与界面方向的产品依据。

本轮不包含独立 EXE 打包、Flutter 数据迁移、校园业务接入或同步服务器。通知仍由各业务插件后续接入；本界面没有宣称课程提醒已可用。
