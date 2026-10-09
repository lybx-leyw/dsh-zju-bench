# 参与智云 Pro

本文档约定智云 Pro 的开发环境与协作流程。新增的 AGENTS、skills 等协作材料也放在本目录下。

## 0. 安装 Node.js、npm 和 Git

已安装这些工具且版本满足 1.1 要求的，可以跳过本节。以下操作可在任意目录执行。

### 0.1 Windows（PowerShell / cmd）

使用 WinGet 安装 [Node.js LTS](https://github.com/microsoft/winget-pkgs/tree/master/manifests/o/OpenJS/NodeJS/LTS) 和 [Git](https://git-scm.com/install/windows)：

```powershell
winget install --id OpenJS.NodeJS.LTS -e --source winget
winget install --id Git.Git -e --source winget
```

按提示确认安装。若找不到 `winget`，先在 Microsoft Store 安装或更新“应用安装程序”，参见 [WinGet 官方说明](https://learn.microsoft.com/en-us/windows/package-manager/winget/)。

### 0.2 macOS / Linux（bash / zsh）

先安装 Git 和下载工具，按自己的系统选择一项：

| 系统 | 命令 |
| --- | --- |
| macOS | `xcode-select --install`，等待命令行工具安装完成；系统已带 curl |
| Ubuntu / Debian | `sudo apt update && sudo apt install -y git curl ca-certificates` |
| Fedora | `sudo dnf install -y git curl ca-certificates` |

其他发行版使用对应的包管理器安装 Git 和 curl，参见 [Git 官方说明](https://git-scm.com/install/linux)。

然后使用 [nvm](https://github.com/nvm-sh/nvm#installing-and-updating) 安装 Node.js 24：

```bash
# macOS 默认使用 zsh，先确保配置文件存在
if [ "${SHELL##*/}" = "zsh" ]; then touch ~/.zshrc; fi
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
```

**重新打开终端**，再执行：

```bash
nvm install 24
nvm alias default 24
```

以上方式都会一并安装 npm，无需单独安装。

### 0.3 验证安装

安装后**重新打开终端**（Windows 可用 PowerShell 或 cmd），执行：

```bash
node -v
npm -v
git --version
```

三条命令都输出版本号，且 Node.js 满足 1.1 的版本要求即可。如果提示找不到命令，先确认安装完成并已重开终端；若 PowerShell 提示禁止运行 `npm.ps1`，可改用 cmd 执行后续命令。

## 1. 开发环境准备

### 1.1 环境要求

- **Node.js**：22.19.0 至 22.x，或 24.0.0 及以上（以 [package.json](../../package.json) 的 `engines` 为准）。
- **npm**：安装依赖、构建和启动项目。
- **Git**：参与版本协作，以及拉取可选的参考源码。

先进入项目文件夹（包含 `package.json` 和本文档的目录）。以下命令均在**仓库根目录**执行；除标明终端的环境变量示例外，适用于 PowerShell、cmd 和 macOS / Linux 终端。

### 1.2 安装并启动

首次运行，依次安装独立宿主、安装项目依赖，再构建并启动：

```bash
npm install --prefix .runtime/dsh-0.2.0-rc.2 @deepseek-ai/dsh@0.2.0-rc.2
npm ci
npm run dev
```

安装命令使用 [runtime.lock.json](../../runtime.lock.json) 中的 `preferredHostVersion`，当前为 `0.2.0-rc.2`；不要改用 `@latest`，也不要省略 `--prefix`，它用于将宿主依赖安装到独立目录。Windows 默认位置已有受支持的 DSH Desktop 时，可跳过第一条命令；其他位置的宿主需按 1.3 显式指定。

启动脚本会检查宿主版本、连接本仓库插件，并初始化独立的 `zhiyun-bench` profile，无需手动注入。终端会打印实际使用的宿主、profile、数据目录和访问地址。

**启动成功的标志**：打开终端输出的完整地址（含临时访问令牌），能进入「今天」并看到五项导航：今天、我的课、问一问、学习、个人。默认端口为 `3091`；使用 AI 功能还需在设置中配置模型。

后续开发先在原终端按 `Ctrl+C` 停止服务，再用 `npm run dev` 重新构建并启动；无需重新构建时使用 `npm start`。`dev` 不会持续监听源码变化。依赖锁文件变化后重新执行 `npm ci`。

### 1.3 常用配置与排查

| 需求 | 操作 |
| --- | --- |
| 检查宿主版本并初始化 / 更新 profile | `npm run profile:check`（不启动服务、不验证页面） |
| 查看合并后的插件配置 | 构建完成后执行 `npm run profile:dump` |
| 更换启动端口 | `npm start -- --port 3081` |
| 提示缺少客户端产物 | 运行 `npm run dev`，先构建再启动 |
| 提示宿主缺失或版本不匹配 | 按 1.2 安装，并检查是否设置了指向其他宿主的环境变量 |

需要指定安装或数据位置时，再设置以下环境变量：

| 变量 | 作用 | 默认行为 |
| --- | --- | --- |
| `ZHIYUN_DSH_APP_DIR` | 指定宿主绝对路径，指向包含 `node_modules` 的那一层 | 先查找 Windows 默认位置的 DSH Desktop，再查找 `.runtime/dsh-<版本>/` 中受支持的宿主 |
| `ZHIYUN_DSH_HOME` | 用绝对路径指定会话、配置和存储的数据目录 | `.runtime/home/` |
| `ZHIYUN_PORT` | 指定端口 | `3091`，可由命令行 `--port` 覆盖 |

例如，将路径替换为已安装宿主的实际位置，按自己的终端选择一种写法，然后在**同一终端**执行 `npm start`。以下设置仅对当前终端及其启动的进程生效；显式指定的宿主不可用时，脚本会报错，不再自动查找其他位置。

```powershell
# PowerShell
$env:ZHIYUN_DSH_APP_DIR = 'C:\Users\me\dsh-host'
```

```bat
:: cmd
set "ZHIYUN_DSH_APP_DIR=C:\Users\me\dsh-host"
```

```bash
# macOS / Linux
export ZHIYUN_DSH_APP_DIR="$HOME/dsh-host"
```

**`.runtime/home/` 保存真实数据，不要作为缓存删除。** `.runtime/dsh-<版本>/` 则是可重新安装的宿主目录。

### 1.4 可选：拉取参考源码

需要让 AI 助手或开发者查阅 Cordis 插件及 UI 实现时，可拉取以下参考仓库；它们不是运行依赖，且已被 `.gitignore` 忽略。以下为首次拉取命令，已有对应目录时无需重复执行 `git clone`。

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git .ref
git -C .ref checkout 5badb15009ae1756c3afe0ae0cef1faafc290ccc

git clone https://github.com/MichengAI/dsh-codex-ui.git .ref-codex-ui
git -C .ref-codex-ui checkout ff42c6f9296ee7022ab2e919f849ecd05d4df63e
```

提交号与 [ATTRIBUTION.md](../../ATTRIBUTION.md) 中记录的一致。参考源码用于理解实现，运行时兼容性仍以 `runtime.lock.json` 为准。

## 2. Owner 机制

### 2.1 三种 Owner 模式

本项目采用三种 Owner 模式，分别约定修改权限与责任，不表示上下级关系。模式只约束“谁能改代码”，未声明或声明为 shared 的区域，任何人都可以改。

| 模式 | 谁能改 | 责任与裁决 |
| --- | --- | --- |
| `shared`（默认） | 所有人 | 修改者对自己的改动负责，相关回归测试必须通过，实际使用不得破坏已有功能 |
| `@负责人` | 仅名单内成员 | Owner 决定实现方向及破坏性变更；名单外成员有需求时直接联系 Owner，由 Owner 修改 |
| `@负责人 + Open` | 所有人 | 修改者负责验证与修复；Owner 负责事后审查，对该区域的最终状态负责，有权保留、调整或撤销他人的改动 |

指定 Owner 且未标 Open 的区域，限制针对**修改行为本身**，名单外成员不能先改再交给 Owner 审批。需要开放协作时，应先按 2.3 改为 Open。

三种模式均要求修改者完成相关回归测试与实际使用验证。指定 Owner 的区域应尽量兼容已有下游插件；确需破坏性变更时，由 Owner 决定，并说明影响范围与迁移方式，按新的约定验收。多人 Owner 的日常改动可由任一 Owner 决定，破坏性变更需名单内成员一致同意。

Open 区域允许先改、后审查。与 Owner 确认的职责、接口或实现方向不符的改动，Owner 有权撤销，包括破坏性撤销；大改前建议直接沟通，减少返工。撤销已被下游使用的改动时，应通知受影响的成员，并尽量提供兼容或迁移方式。Owner 的最终责任不免除修改者的验证与修复责任。

修改 shared 或 Open 区域时，若需要联动修改他人的非 Open 区域，应联系对应 Owner 处理，不能以修复兼容性为由越权修改。

### 2.2 声明位置与继承

- **目录级声明**：每个目录最多一份 `OWNERS`，文件名就是 `OWNERS`（无后缀），默认作用于该目录及其子目录的全部内容，包括源码、测试、配置和文档。
- **就近优先**：找某个文件的 Owner 时，从它所在目录逐级向上找，第一个遇到的 `OWNERS` 就是它的声明。子目录的 `OWNERS` 覆盖父目录；根目录那份只覆盖没有自己的 `OWNERS` 的区域。
- **无声明默认 shared**：一路到仓库根都没有 `OWNERS` 时按 shared 管理。插件包与基础设施（脚本、公共测试、根配置等）适用同一规则，基础设施不再单独设例外表。
- **暂不使用 CODEOWNERS**：`OWNERS` 是本项目的团队约定，GitHub 不识别、不会自动请求评审、也不展示负责人。将来需要时，由 `OWNERS` 汇总生成根目录 `CODEOWNERS`，不另立一份真源。

shared 表示开放修改权限，仍需遵守验证要求和其他协作规范。

### 2.3 声明格式

每个 `OWNERS` 只写一行 `Owner:`，三种写法选用一种：

```text
Owner: shared
Owner: @alice, @bob
Owner: @alice, @bob + Open
```

`shared` 与 `Open` 使用固定拼写；`Open` 必须同时指定至少一位负责人。负责人使用 GitHub 账号，带 `@` 前缀，多人以英文逗号分隔。作用范围由文件所在目录决定，不在文件里写路径；需要说明时加 `#` 开头的注释行。

例如，左侧是位置，右侧是文件内容：

```text
OWNERS                                      # 可不写；不写即为 shared
packages/dsh-zhiyun-shell/OWNERS            Owner: @alice
packages/dsh-zhiyun-shell/src/OWNERS        Owner: @alice, @bob + Open
scripts/OWNERS                              Owner: @bob, @carol + Open
```

**声明变更需先达成一致，再修改文件**：shared 区域的认领需团队确认；已有指定 Owner 的区域，调整名单或模式需现有 Owner 一致同意。直接沟通确认即可，无需额外提案流程；不得通过自行修改或删除声明绕过权限限制。

## 3. 贡献方式：提供插件包

本项目的功能单位是插件包（`packages/dsh-zhiyun-*`），不是往某个大插件里塞代码。贡献一个新功能，就是提供一个包，或改动已有的包；改动某一页时只动对应的包（各包职责见 [README](../../README.md) 与包内的 `README.md`）。

**插件包怎么写没有额外规定，参考现成实现即可**：

- `.ref/`（DeepSeek Harness）与 `.ref-codex-ui/` 里有大量插件包与 profile 组合的实例：包清单、宿主半边、浏览器半边、插槽注册都能找到对应的写法（获取方式见 1.4）。
- 也可以在 DSH 里新建任务并选择**创造模式**，让它按运行时 API 写出插件包与组合。

除此之外，本项目只有四条约定。

### 3.1 不要接入会让整个 profile 起不来的包

profile 中任何一条 Loader 条目解析失败，起不来的都是**整个工作台**，而不是那一个包：其他人拉取后连界面都进不去。因此没把握的插件包不要写进 `profiles/zhiyun-bench/package.json` 的 `dsh.profile.bundles`，留在 `packages/` 下即可。

开发期间当然可以接进去验证，提交前把不稳定的条目去掉。这条针对的是新引入、来源不确定的包，不针对仓库里已有的本地包。

### 3.2 最好提供测试

不强制，但建议提供：改动出错时其他人能立刻发现，也才敢动这个包。

- 放在仓库根目录的 `tests/<名字>.test.mjs`。`npm test` 即 `node --test tests/*.test.mjs`，文件名必须匹配 `*.test.mjs`。
- 直接 import 包的源码，不经过构建产物、不需要宿主、不连网，任何人都能用一条命令跑完。

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { 某个纯函数 } from '../packages/dsh-zhiyun-<名字>/src/<文件>.js';

test('用例名说清被钉住的行为', () => {
  assert.equal(某个纯函数(输入), 期望);
});
```

需要外部真值的用例，把夹具放在包内的 `fixtures/`，并在注释里写明生成方式；例见 `packages/dsh-zhiyun-notes/fixtures/dart-golden-*.json`。涉及宿主的改动（插槽、导航、主题、宿主适配）用 `npm run test:host` 在真实宿主中验证，它会在 `artifacts/` 留下报告与截图。

### 3.3 参考其他项目前先确认协议

参考本仓库之外的任何项目之前，**先确认对方的协议**（仓库通常带 `LICENSE`；没有许可证的代码默认保留所有权利，不得复制）。确认之后按下面的方式记录。

- **只做了简单借鉴**（读了实现、换了写法，没有引入对方的实现）：在仓库根的 [ATTRIBUTION.md](../../ATTRIBUTION.md) 中追加一两行说明即可 —— 项目、协议、参考了什么。这种情况不需要合法说明。
- **移植了较多代码**，无法在一两行内写明：在对应插件包内写一份 `ATTRIBUTION.md`，说清楚用了哪些部分、来源与提交号、依据对方哪个协议所以合法、以及做了哪些改动；再在根 `ATTRIBUTION.md` 中指向该包的 `ATTRIBUTION.md`。

作者自己的项目之间（例如 `zhiyun-pro`、`zju-mcp`）互相搬运实现属于同一作者，不需要声明。第三方库通过 `package.json` 正常引入并按原协议使用的，也不需要额外说明。

### 3.4 推送前检查有无泄露个人信息

**本仓库是公开仓库**，推送出去的内容任何人都能看到，并且可能在很短时间内被自动化工具抓取扫描。因此提交前必须自查一遍，确认没有夹带个人信息。

需要重点检查的几类内容：

- **个人凭证**：学号、密码、Cookie、API key、token，以及 `.temp_env`、`.env`、`*.dpapi` 这类凭据或会话文件。不要写进代码、文档、注释、测试夹具，也不要写进提交信息。
- **本地绝对路径**：形如 `C:\Users\<用户名>\...`、`/Users/<用户名>/...` 的路径常因带用户名而暴露身份，同时会让其他人无法使用。代码与文档中应写相对路径或占位符（如 `C:\Users\me\dsh-host`）。检查时不要只看源码 —— 注释、文档、测试夹具同样要看。
- **个人数据**：真实的课程、成绩，以及从智云解析出的私人内容。
- **姓名等身份信息**：带有自己或组员姓名、学号、头像、联系方式等身份信息的资料不要推送，包括名单、分工安排、会议记录这类交流材料。**仓库内组员之间的交流文档一律用 GitHub 用户名指代，不写真实姓名。** 提交者信息同样会进入公开的提交历史，所以 `git config user.name` 应为 GitHub 用户名；`git config user.email` 用哪个邮箱取决于账号本身 —— 如果这个邮箱本来就是该 GitHub 账号的注册邮箱，用它没有问题，不必为了藏学号特意改掉；只有在这个邮箱不是账号注册邮箱时，才应改用 GitHub 的 noreply 地址（形如 `ID+用户名@users.noreply.github.com`，在 GitHub 设置中可查）。

`.gitignore` 已覆盖 `.env`、`.temp_env`、`*.dpapi`、`.runtime/`、`artifacts/` 等路径，正常情况下这些文件不会被提交；但不要把个人凭证放进会被提交的文件里，也不要为了省事用 `git add -f` 强行加入。

不确定某个值能否公开时，按不能公开处理，先删除或改成占位符。**一旦发现凭证已经推送出去，应立刻作废并重新申请** —— 抓取是自动的，只从历史记录里删掉并不够。

## 4. 你也许可以从这里开始

本章是一条推荐的参与路径，不是流程规定，从任何一步进入都可以。

### 4.1 从一个想法开始

本项目的形态是：**用 DSH 插件把 DSH 改造成浙大专属的工作台**。因此“能做什么”没有清单，以下几个方向只是示例：

- **为 AI 提供更多 tool**：把手上的服务、脚本、数据变成 agent 能调用的工具。
- **对已解析的智云数据做更多处理**：例如用解析结果生成 quiz。
- **为项目添加更多可视化组件**：例如内嵌视频播放器。
- 搭建本地 OCR 服务这类基础设施。
- 搭建内嵌的笔记管理服务。
- 新增科研版面。
- 制作 ZJU 专属的插件管理界面。

你可以做你想做的一切，只要不违反第 2 章的 Owner 核心规则。

### 4.2 寻找可借鉴的先例

充分利用 GitHub 上的 DSH 生态：有功能类似的实现时，优先评估能否改造为适合浙大场景的插件，能不自己造轮子就不要自己造轮子。本项目的 `.ref/` 与 `.ref-codex-ui/` 中也有大量现成写法可以参考（获取方式见 1.4）。

同时需要甄别：功能相近的插件未必在浙大场景下有足够的性能或合适的接口，这种情况下以自己设计为准。

决定参考某个第三方项目时，按 3.3 先确认对方协议并做好记录。

### 4.3 完成你想要的插件并撰写 `OWNERS`

vibe coding 是被鼓励的。可以用第 3 章提到的**创造模式**，也可以用自己顺手的方式把插件写出来。过程中不要丢掉 3.1 那条底线：稳定的包才接进 profile。

插件完成后，按第 2 章给它一份 `OWNERS`，让后来的人知道这个包归谁、能不能改；也可以按 2.3 标成 Open，让所有人都能改。不写 `OWNERS` 同样按 shared 管理，但那样没有人知道该找谁。

### 4.4 测试插件，返工与迭代

按 3.2 为插件配上测试，先自己跑通，再在真实工作台中实际使用一遍。不符预期就返工，多迭代几轮是常态。

### 4.5 最终验证，接入与提交

1. **最终验证**：`npm test` 全部通过；改动了样式表则再跑 `npm run check:css`；改动了插槽、导航、主题或宿主适配则再跑 `npm run test:host`；最后用 `npm start` 手工使用一遍。
2. **检查个人信息**：按 3.4 确认没有夹带凭证、本地绝对路径或个人数据 —— 公开仓库推送后会被自动抓取。
3. **接入**：确认插件不会让 profile 起不来后，按 3.1 接进 profile，并重新执行 `npm run profile:init`。
4. **提交**：把改动提交到团队的共享仓库，并说明插件的作用与验证方式，让其他人能独立复核，而不是只拿到一批代码。
