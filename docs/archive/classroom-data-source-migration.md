# 智云课堂数据源迁移清单

盘点日期：2026-10-07。后续实施状态：JS 独立数据源与 Cordis 插件已实现并验证，详见 [验证记录](classroom-data-source-verification.md)。下文保留最初迁移范围与验收设计；具体已覆盖及未覆盖项以验证记录为准。

## 迁移顺序与边界

按「数据源 → 解析器 → 学习面板壳 → 其他面板」推进。数据源先通过独立验证，再接入界面。保留 Flutter 手机端，JS 端的数据模型为以后服务端同步保留来源与稳定标识。

第一阶段拟新增 `packages/dsh-zhiyun-classroom`：内部为可脱离 DSH 运行的 JS 数据源，外部为薄 Cordis 插件适配层。登录、网络请求、Cookie、原始资源下载均在宿主运行；前端只通过宿主服务读取必要结果。沿用现有 DSH 宿主及 zhiyun-bench profile，不修改其核心。

本阶段不迁移混合解析、知识库、向量检索、LLM 提示词、计划或通知；不引入 zju-mcp 的业务实现。服务端返回的 PPT 文本、字幕属于数据源输出，视觉识别及三流融合属于下一阶段解析器。

## Dart 依据

以下路径均相对于 `C:/Users/19389/Desktop/zhiyun-pro`：

| 文件 | 迁移用途 |
| --- | --- |
| `lib/bridge/zhiyun_data_source.dart` | 对外门面、Cookie 存储、用户信息、课表日期、下载入口 |
| `lib/bridge/classroom_api.dart` | 五类数据接口、返回结构检查、分页及会话异常 |
| `lib/bridge/classroom_models.dart` | 课程、节次、PPT、字幕、资源、课表模型 |
| `lib/bridge/zjuam_client.dart` | CAS 表单登录、公钥读取及兼容 RSA 算法 |
| `lib/bridge/service_login.dart` | CAS 到智云课堂业务会话的跳转 |
| `lib/bridge/login_lock.dart` | 登录串行化 |
| `lib/bridge/credentials.dart`、`credential_store.dart` | 凭据来源及存储接口 |
| `lib/bridge/file_downloader.dart`、`slide_downloader.dart` | 流式下载、续传、取消、图片批量下载 |
| `lib/state/providers.dart` | 复用会话、过期后登录的 App 编排参考；不迁移 Riverpod |
| `lib/bridge/tool/ds_cli.dart` | 已有独立验证入口参考 |

## 接口清单

| 能力 | 当前接口 | 请求与响应重点 |
| --- | --- | --- |
| 我的课程 | `https://education.cmc.zju.edu.cn/personal/courseapi/vlabpassportapi/v1/account-profile/course` | 当前固定 `nowpage=1&per-page=100&force_mycourse=1`；读取 `params.result.data` |
| 课程节次与资源 | `https://yjapi.cmc.zju.edu.cn/courseapi/v2/course/catalogue` | `course_id`；读取 `result.data`；默认只返回 `status=6` 的可播放节次 |
| PPT 帧 | `https://classroom.zju.edu.cn/pptnote/v1/schedule/search-ppt` | `course_id/sub_id/page/per_page`；当前每页 100，最多 20 页，有重复页防护 |
| 字幕 | `https://yjapi.cmc.zju.edu.cn/courseapi/v3/web-socket/search-trans-result` | `sub_id&format=json`；读取 `list[].all_content[]`，按开始时间排序 |
| 课表 | `https://yjapi.cmc.zju.edu.cn/courseapi/v2/schedule/get-week-schedules` | `user_id/tenant_id/start_at/end_at`；默认 tenant `112`；读取 `result.list` |

视频地址来自 catalogue 内嵌 `content.playback.url`，并非另外一个视频接口；兼容 `content.video_url`。原始课件来自 `content.download.ppt.path_name`，没有课件直链不代表没有 PPT 帧。

JS 对外服务建议提供：`restoreSession`、`login`、`logout`、`getCurrentUser`、`listCourses`、`listLessons({onlyPlayable})`、`getSchedule({start,end})`、`getSlides`、`getSubtitles`、`getLessonContent`；下载能力作为阶段 1B 的 `downloadResource`。请求支持取消，结果携带抓取时间及完整性诊断。具体契约随实现落实，不能让 UI 依赖上游原始 JSON。

## 模型与解析器交接

| 模型 | 必须保留的字段及语义 |
| --- | --- |
| 课程 | id、标题、教师、封面、学期、学院、课程代码、学习进度及数量 |
| 节次 | courseId、subId、标题、开始时间、播放状态、讲师、教室、资源；Dart 的 id 实际是 `${courseId}_${subId}` |
| PPT 帧 | 1 起始页码、图片、缩略图、服务端文本、`created_sec`、重点标记、detectType |
| 字幕 | 原文、译文、开始及结束毫秒；上游 `BeginSec/EndSec` 为秒，可能为字符串，Dart 乘 1000 后 round |
| 资源 | 课件名称与 URL、处理状态、视频 URL、视频时长、封面及其他资源文件；时长 `contents_duration` 单位为纳秒 |
| 课表 | 日期字符串 `day`、课程/节次标识、教师、教室、状态、直播/公开属性；条目 startAt/endAt 为 Unix 秒 |

保留原始时间单位与来源字段，同时提供统一的毫秒字段；验证数值范围，不把日期字符串当 Unix 时间。课表“今天”按 Asia/Shanghai 计算，与 Windows 系统时区无关。

规范化标识建议为 `zhiyun:112:<courseId>:<subId>`，模型里的 ID 统一字符串，上游数字 ID 保留兼容映射，避免与其他数据源冲突。资源签名 URL 不作为同步主键。解析器输入保留来源标识、抓取时间、PPT 时间锚点、字幕区间及内容版本/摘要；不把原始 Cookie 或凭据传给解析器。

`slidesIncomplete = subtitles.length > 50 && slides.length <= 2` 是当前 App 的启发式，不能当成服务端事实。分别记录上游处理状态、分页完整性和此类推测，允许内容尚在处理时重新获取。

## 登录与会话迁移

1. 先复用本 profile 的持久化 Cookie，以一次课程请求验证会话；网络失败不能自动触发重新登录。
2. CAS 先读取 `/cas/login` 的 execution，再读取 `/cas/v2/getPubKey` 的 modulus/exponent。
3. 按 Dart 的 UTF-8 → BigInt 模幂 → 十六进制方式生成密码字段。该服务使用特定 RSA 协议，不能替换成通用 OAEP/PKCS 填充。
4. 提交表单并取得 SSO 会话，再沿 tgmedia → CAS → 智云业务站点的跳转建立业务 Cookie。
5. 用户标识由 `JWTUser` Cookie 读取；它实际是 URL 编码 JSON，不能直接按 JWT token 解码。兼容 sub/user_id/id。
6. 同一数据源的登录串行执行，避免请求互相挤掉会话；多个进程或 Flutter 与 JS 并行登录的行为须在真实验证中记录，不能声称进程内锁解决了全部问题。

Cookie 必须按域、路径、过期时间及 Secure 规则保存；相对跳转用 URL 解析。Dart 的跨域 Cookie 拼接/复制逻辑只作为业务行为参考，JS 不直接把所有 Cookie 发往每一跳。确有必要的业务域 Cookie 转移须明确列出并验证；CAS SSO Cookie 不发送给任意资源 CDN。

凭据由可替换的安全存储适配器提供，不能放入前端状态、公开 profile 或日志。测试凭据来源只记录来源及是否存在。Cookie 存储也按 profile 隔离；注销清除会话；插件卸载关闭客户端并取消在途请求。

## 必须处理的现有缺口

| 发现 | JS 迁移要求 |
| --- | --- |
| 课程只取第一页、最多 100 条 | 确认分页元数据和分页参数；未确认前报告完整性未知，不能宣称已取全 |
| PPT 的 list 类型错误会结束循环 | 非预期结构应报结构错误，不能当作空页 |
| PPT 最多 20 页、重复页即停止 | 返回停止原因；服务端仍有更多条目时报告部分结果 |
| PPT 以图片 URL 去重 | 保留原始记录及时间锚点；同图不同出现时间不能未经评估丢掉，变更须与 Dart 基线对照 |
| 部分嵌套坏行被跳过 | 输出可定位且脱敏的诊断，区分真正空数据与全部行解析失败 |
| 返回 HTML 一律被当成会话过期 | 区分登录页面、HTTP 服务错误、非预期 HTML，防止无效重登录循环 |
| 数据源日期只检查字符串格式 | 校验真实日历日期和起止顺序；不能仅依赖上层 AI 工具校验 |
| 内容抓取进度把页数与字幕数混用 | 按 slides/subtitles 分阶段报告，未知总量使用不确定进度 |

课表空区间须保留现有严格特例：没有正常列表，且服务端明确表达“课表为空”，并未明确返回失败时，允许空结果。不能把所有 code=400 或缺失 list 都视为无课；正常列表优先。

## 实施批次与验收门槛

### 1A：数据读取独立闭环

- 建立纯 JS 模型、可注入 HTTP transport、Cookie/凭据接口、错误分类。
- 移植 CAS 与业务登录，再接课程、节次、课表、PPT、字幕和内容聚合。
- 增加独立验证 CLI；默认离线，真实模式显式启用，凭据由安全输入提供。
- 最后提供 Cordis 服务及 profile 配置，不依赖学习面板才能运行。

离线验收：以 Dart 现有模型测试为基线，使用同一份脱敏 fixture 对比字段、计数、顺序、时间与资源地址映射。包括对象/字符串 content、缺失可选资源、合法空列表、结构改变、401/403、超时、HTML、分页重复/截断、取消、会话恢复、时区跨日、无效日期。RSA 用固定公开测试向量对照。新增错误处理与 Dart 的行为差异单独记录，不把 Dart 当前行为视为全部正确。

已有参考测试：`test/bridge_test.dart`、`test/schedule_empty_test.dart`、`test/credential_store_test.dart`、`test/credentials_test.dart`、`test/credential_leak_test.dart`、`test/timetable_tool_test.dart`。这些测试覆盖范围不同，不能仅凭模型测试通过声称真实网络链路通过。现有 Flutter 全量测试的历史失败与本阶段迁移验收分开记录。

真实验收：使用授权测试账号，分别验证新登录与旧 Cookie 恢复、课程列表完整性、同一课程多节次、可播放/处理中/资源缺失、PPT 与字幕、包含课程与空日的课表窗口。将相同节次与 Flutter 结果逐项对照，保存脱敏验证报告；单节成功不代表所有状态通过。注销后不得继续使用旧会话。日志不包含密码、Cookie、CAS ticket 或签名资源参数。

宿主验收：在 zhiyun-bench profile 挂载服务；复用当前宿主测试，确认启停、取消、profile 隔离及现有问一问/个人界面工作正常。其他 profile 不应自动加载该数据源。只有离线、真实链路、宿主三项均有证据，才标记数据源通过。

### 1B：资源下载

流式落盘，不把视频整体放入内存；验证 200/206、Range 被忽略、Content-Range 不匹配、取消及续跑、未知长度、文件名与路径边界、小图并发失败汇总。针对实际资源域验证必要 Referer/Cookie；不默认下载整段视频。参考 `test/download_test.dart`，用本地 HTTP 服务验证下载行为，减少对真实 CDN 的依赖。

### 第二阶段入口

完成数据源验收后再盘点 Dart 解析管线，建立固定节次样本及中间产物对照，保持用户认可的解析路径。学习面板先使用已验证服务展示课程与节次，随后接入已验证解析结果；不让解析/UI 改动掩盖数据源错误。

## 本次完成与待办

已完成：接口、模型、登录链路盘点，以及 JS 数据源、下载、独立 CLI、脱敏 Dart 对照和 Cordis 挂载。随后已独立迁移 Dart 三阶段解析器，见 [迁移记录](parser-migration.md)；学习页面暂不接入。真实账号仅验证部分课程；分页异常和资源缺失另有离线用例，不能据此声称已覆盖全部服务端状态。
