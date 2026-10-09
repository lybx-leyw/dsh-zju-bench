# AGENTS.md

本文件是面向 agent 的仓库约定。agent 指令文件需要在仓库根才会被自动读取，所以仓库根的 [AGENTS.md](../../AGENTS.md) 只是入口指针，正文放在这里，由维护者管理。协作规范正文见 [CONTRIBUTING.md](CONTRIBUTING.md)。

本文件只讲每次工作都必须遵守的几件事：**共享仓库**、**开工前的检查**与**文件归属**。

## 共享仓库

本项目的共享仓库是唯一的一个，地址固定为：

```text
https://github.com/lybx-leyw/dsh-zju-bench
```

它的 `origin` 必须正好是上面这个地址。所有提交最终都只推到这里，不推其他任何仓库。

## 每次开始工作前

依次执行下面的命令，并把结果简要汇报给用户：

```bash
git status                    # 是否有未提交的改动
git branch --show-current
git remote get-url origin     # 输出必须是 https://github.com/lybx-leyw/dsh-zju-bench
git fetch origin
git config user.name          # 确认当前用户是谁，用于下文的“文件归属”检查
```

- `git remote get-url origin` 的输出**必须与上节地址逐字符一致**；不一致（`origin` 不存在、指向 fork、指向别的项目、用 SSH 别名或跳转链接写法、或其他任何地址）一律视为错误配置。
- 遇到上述错误配置，**停下来向用户说明差异，由用户决定是否修改远端**，不要默默继续，也不要凭自己的判断“纠正”成其他地址。
- 如果当前目录还不是 Git 仓库，先向用户说明，再协助其 `git clone https://github.com/lybx-leyw/dsh-zju-bench`。**不要在错误的目录里初始化新仓库。**
- 需要添加或修正远端时，用完整地址：`git remote add origin https://github.com/lybx-leyw/dsh-zju-bench`，或 `git remote set-url origin https://github.com/lybx-leyw/dsh-zju-bench`。
- 如果有未提交的改动，先弄清这些改动是不是用户想要的，再决定提交、暂存（`git stash`）还是保留。**不要丢弃用户的改动。**

`git config user.name` 的结果就是后文里的“当前用户”。归属判断依据是这个值，而不是发起请求的账号 —— 两者可能不一致。

## 文件归属

**不得修改他人的 `OWNERS`，不得把自己写进他人的、且非 Open 的 `Owner`。**

判断某个文件属于谁，按 [CONTRIBUTING.md 第 2 章](CONTRIBUTING.md#2-owner-机制)的规则：从文件所在目录向上找第一个 `OWNERS`，子目录覆盖父目录，一路都没有则按 shared 处理。

- **shared 或 Open 区域**：可以直接改。
- **指定 Owner 且非 Open 的区域**：只有 `Owner:` 列出的账号可以改。

若任务确实需要改动他人的**非 Open 文件**（例如调整公共接口），**停下来**，建议用户先和负责人沟通，由负责人自己修改。

### 第 2 章：Owner 机制（摘要）

**三种模式**，只约束“谁能改代码”，不表示上下级：

| 模式 | 谁能改 | 责任与裁决 |
| --- | --- | --- |
| `shared`（默认） | 所有人 | 修改者对自己的改动负责，相关回归测试必须通过，实际使用不得破坏已有功能 |
| `@负责人` | 仅名单内成员 | Owner 决定实现方向及破坏性变更；名单外成员有需求时直接联系 Owner，由 Owner 修改 |
| `@负责人 + Open` | 所有人 | 修改者负责验证与修复；Owner 负责事后审查，对该区域的最终状态负责，有权保留、调整或撤销他人的改动 |

指定 Owner 且未标 Open 的区域，限制针对**修改行为本身**，名单外成员不能先改再交给 Owner 审批。需要开放协作时，应先改成 Open。

**声明位置与继承**：

- 每个目录最多一份 `OWNERS`（文件名无后缀），默认作用于该目录及其子目录的全部内容，包括源码、测试、配置和文档。
- 找某个文件的 Owner 时，从它所在目录逐级向上找，第一个遇到的 `OWNERS` 就是它的声明；子目录覆盖父目录。
- 一路到仓库根都没有 `OWNERS` 时按 shared 管理。

**声明格式**，三种写法选用一种：

```text
Owner: shared
Owner: @alice, @bob
Owner: @alice, @bob + Open
```

`Open` 必须同时指定至少一位负责人。负责人使用 GitHub 账号，带 `@` 前缀，多人以英文逗号分隔。

**声明变更需先达成一致，再修改文件**：不得通过自行修改或删除声明绕过权限限制。

本节是摘要，细节以 [CONTRIBUTING.md 第 2 章](CONTRIBUTING.md#2-owner-机制)原文为准 —— 摘要只是为了在不改动他人文件时能就地判断。

## 推送远程

推送远程一律走 PR：`main` 已设置分支保护，不要直接向 `main` 推送。
