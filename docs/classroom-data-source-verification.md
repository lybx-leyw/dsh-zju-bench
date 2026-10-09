# 智云课堂数据源实施与验证

日期：2026-10-07。本记录对应独立数据源阶段，尚未接入学习面板。随后完成的解析器迁移与最新回归结果见 [解析迁移记录](parser-migration.md)；下文保留数据源阶段的原始验收范围与数量。

## 实施结果

新增 `packages/dsh-zhiyun-classroom`，包含可独立运行的 JS 数据源与薄 Cordis 插件。接口覆盖 CAS/业务登录、会话恢复和本地注销、用户信息、课程、节次、资源元数据、课表、PPT 帧、字幕、内容聚合、流式单文件下载与批量图片下载。

插件已加入 zhiyun-bench 的 bundle 清单。初始化旧的智云 profile 时，仅追加新数据源 bundle，并保留原 manifest 的其他字段及机器本地覆盖配置。未修改 DSH 核心及 Flutter 业务代码；未引入 zju-mcp 的知识库或混合解析。

会话使用 profile 内当前 Windows 用户绑定的 DPAPI 加密文件；密码不持久化。校方 Cookie 按标准域/路径规则处理，SSO Cookie 额外限制在 CAS 主机；资源下载不附带业务 Cookie。错误不携带原始响应或签名地址。插件卸载撤销服务并取消请求。

## 验证证据

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 新 CAS 登录及业务会话建立 | 通过 | 本次从授权的 `.temp_env` 读取凭据；未输出或复制凭据 |
| 独立进程恢复加密 Cookie | 通过 | 后续 CLI 运行显示 restored=true，不重新提交密码 |
| 我的课程 | 30 门，meta.complete=true，停止原因为 total | `artifacts/classroom/live-verification.json` |
| 真实课程分页 | per-page=2，nowpage=1/2 各返回 2 条，服务端页码分别为 1/2，结果不重复 | 最新 live-verification.json 的 course-pagination |
| 节次目录 | 抽查两门课程，覆盖 status=2 与 status=6 | 同上 |
| 两节录播内容 | 111 页/1343 句；80 页/1329 句；两次 PPT 完整性均为 true | 同上 |
| 本周课表 | 2026-10-05 至 10-11：7 天、5 条课程 | 同上 |
| 空日课表 | 2026-10-07：0 天/0 条，识别为 explicit-empty | 最新 live-verification.json 的 schedule-day |
| 资源 Range | 视频、原始课件、PPT 图片均返回 206 与 Content-Range | 最新 live-verification.json；只请求范围并取消响应 |
| 本地注销 | clearedUser=true，authenticated=false | 最新 live-verification.json |
| Dart/JS 模型对照 | 同一脱敏样本逐字段一致，111 页、1343 句、5 条课表 | `artifacts/classroom/dart-model-parity.json`；`tests/fixtures/classroom` |
| 两个真实 Cordis 版本 | 服务挂载、profile 隔离、卸载撤销/关闭均通过 | `tests/classroom-cordis.test.mjs`，0.2.0-rc.2 与 0.2.1-alpha.1 |
| Node 全套 | 31 项通过，0 失败、0 跳过 | `npm test` |
| 前端构建 | 通过 | `npm run build` |
| DSH 宿主浏览器回归 | 两个支持版本各 12 项通过，包含真实业务插件注入数据源 | `artifacts/host-report-<版本>.json` |

脱敏接口 fixture 按字段白名单生成：真实课程/教师/教室名称、账号 ID、字幕及 PPT 文本、资源 URL 均替换。Dart 直接导入当前 Flutter 的 classroom_models.dart，对同一 fixture 输出结果；普通 Node 测试对照已记录的 Dart 基线，无需安装 Dart。

## 已修正的迁移差异

- 课程支持分页；重复页、页数上限、未知完整性均显式报告。
- PPT 返回结构异常不再当作正常空页；分页上限或重复页且未达到总数时返回部分结果；重叠页中的同一记录不重复计入总数。
- 同图不同出现时间保留为独立事件；Dart 的按 URL 去重行为不直接照搬。
- 区分会话失效、服务错误、非预期 HTML、结构错误、超时及取消；网络失败不自动重新登录。
- 课程接口业务 code=1000 表示成功，不能按 HTTP 状态码大小误判；真实复验与离线回归均覆盖此格式。
- 课表日期在数据源层校验真实日历与顺序，统一采用上海日期。
- 下载检查 Content-Range，忽略 Range 时从头重写临时文件；有强 ETag 才复用已有部分文件。取消保留临时文件，完整后以原子不覆盖方式建立正式文件；视频不整体载入内存。

## 覆盖边界

真实验证使用一个账号、部分课程和两节录播，不代表所有课程、所有服务端状态均通过。超过 100 门课程、错误/重复分页、资源缺失、登录拒绝、网络异常和下载中断主要由离线测试覆盖；未为这些场景制造真实服务端故障。真实资源只验证响应和 Range，未完整下载大视频。下载目标为支持硬链接的本地文件系统（Windows NTFS）；其他文件系统的最终落盘行为需另行适配。

课程与 PPT 的总数在本次样本中可用。服务端没有给总数且只返回短页时，当前实现报告 complete=null，不能据此展示“全部取完”。`slidesProcessingSuspected` 仅保留 Dart 启发式，不能替代服务端处理状态。

进程内串行锁不能协调手机 App、其他 Node 进程或官网的并行重新登录。当前插件没有把登录表单或学习数据接入前端；下一步按既定顺序盘点并迁移 Dart 解析器，建立独立解析样本后再接学习面板。

默认宿主的一次浏览器回归在界面重载期间出现 `dynamicCordisRunner/inventory` 的 Failed to fetch；宿主日志已显示数据源注入成功。相同代码复跑后 12 项通过，记录为宿主重载时的瞬时请求失败；没有为通过测试过滤该错误。

## 复验命令

```powershell
npm test
npm run classroom:parity
npm run classroom:verify -- --live --credentials-file C:/Users/19389/Desktop/zhiyun-pro/.temp_env --start 2026-10-05 --end 2026-10-11
npm run classroom:verify -- --live --probe-resources --logout-at-end
npm run test:host
```

CLI 默认不会联网；真实模式须显式 --live。报告及加密会话均在被忽略的本机目录中，源码中只保留脱敏测试材料。
