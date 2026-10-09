# 智云课堂数据源

宿主插件注册 `ctx.zhiyunClassroom`；业务插件声明 `inject = ['zhiyunClassroom']` 后使用。插件只建立客户端，不自动登录、不读取 Flutter 的凭据文件、不修改前端。状态按 DSH `profileContext.dir` 隔离，卸载时撤销服务、取消请求。

纯 JS 使用不需要 Cordis：

```js
import { ClassroomSource } from 'dsh-zhiyun-classroom/source';

const source = new ClassroomSource({ sessionFile: 'C:/local/session.dpapi' });
try {
  const session = await source.restoreSession();
  if (!session.authenticated) await source.login({ username, password });
  const courses = await source.listCourses();
  const lessons = await source.listLessons(courses.items[0].id);
  const content = await source.getLessonContent(lessons.items[0].courseId, lessons.items[0].subId);
} finally {
  await source.dispose();
}
```

## 服务契约

| 方法 | 结果 |
| --- | --- |
| `restoreSession()` | `{ authenticated, user }`；网络/结构错误仍抛出，不误判成未登录 |
| `login({username,password}, {signal})` | 验证业务会话后返回登录结果；同进程同账号登录串行 |
| `logout()` | 取消请求并清空本地 Cookie；不代表注销校方所有站点的 SSO |
| `getCurrentUser()` | `{id,name}` 或 null |
| `listCourses({signal})` | 课程列表与分页元数据 |
| `listLessons(courseId,{onlyPlayable=true,signal})` | 节次及资源；false 保留不可播放状态 |
| `getSlides(courseId,subId,{signal,onProgress})` | PPT 帧及完整性元数据 |
| `getSubtitles(courseId,subId,{signal,onProgress})` | 按开始时间排序的字幕 |
| `getLessonContent(courseId,subId,options)` | 并行获取 slides/subtitles，保留各自元数据 |
| `getSchedule({start,end,userId,signal})` | 课表；默认上海今天，最多 31 天 |
| `downloadResource({url,destination,signal,onProgress,maxBytes,timeoutMs})` | 流式下载；默认 20 分钟，目标须为绝对路径 |
| `downloadSlides(courseId,subId,{directory,concurrency=6,signal,onProgress})` | 图片下载结果逐页汇总，最多 8 并发 |
| `dispose()` | 取消请求、关闭客户端、等待会话写入 |

列表结果统一 `{items, meta}`。`meta.complete` 为 true/false/null，分别代表已收全、部分结果、完整性尚未确认；`reason` 给出 total/empty-page/repeated-page/page-limit 等停止原因。不能在 UI 中把 false/null 默认为全部内容。`version` 是此响应规范化字段的快照摘要，包含资源地址，后续同步应另外设计语义内容版本。

ID 规范化为字符串；节次保留 Dart 的 `courseId_subId`，另有带来源的 `sourceId`。字幕使用毫秒，PPT 的 createdSec 与课表 startAt/endAt 保留秒，同时提供毫秒字段；视频同时保留纳秒与毫秒时长。课表日期原样保留为 YYYY-MM-DD。PPT 同图不同时间保留为独立事件，避免丢失三流融合锚点。

历史课件返回的 `http://video.cmc.zju.edu.cn/` 图片地址会统一升级为 HTTPS，原签名查询串保持不变；规范化后的 PPT 地址可供解析器和浏览器共同使用，传输层也兼容旧地址。其他非本机 HTTP 地址仍会拒绝，不回退到明文请求。

失败使用 `ClassroomError.code`：SESSION_EXPIRED、AUTH_REJECTED、AUTH_SHAPE、API_SHAPE、BUSINESS、HTTP、NETWORK、TIMEOUT、CANCELLED、STORAGE 等。诊断不携带原始响应、密码、Cookie、CAS ticket 或签名 URL。

Windows 持久化会话使用当前用户 DPAPI；未提供 sessionFile 时仅内存存储。其他平台需注入 `protect(bytes,decrypt)` 保护器。支持自定义 transport/fetch 进行离线测试。密码由调用方安全存储提供，数据源本身不保存密码；不要放进 Cordis 公共配置。

## 验证

```powershell
npm run test:classroom
npm run classroom:verify -- --live --credentials-file C:/Users/19389/Desktop/zhiyun-pro/.temp_env --start 2026-10-05 --end 2026-10-11
npm run classroom:verify -- --live --probe-resources --logout-at-end
npm run classroom:parity
```

首次验证从指定文件读取 `ZJU_USER/ZJU_PASS`，也可由进程环境变量提供。后续命令默认复用 `.runtime/classroom-verify/session.dpapi`；`--fresh` 才重新登录。资源探测请求前 4096 字节并取消响应，不下载完整视频。验证报告只记录数量与状态，存放 `artifacts/classroom`。

`classroom:parity` 需 Dart SDK 和相邻 Flutter 仓库，可用 `--flutter-root` 指定；Windows 可用 `DART_EXECUTABLE` 指向 dart.exe。普通 Node 测试使用已记录的 Dart 脱敏基线，无需 Dart。`--capture-live` 使用已有验证会话，按字段白名单生成脱敏接口样本及 Dart 基线，不能作为日常测试自动执行。

2026-10-07 已通过新登录、会话恢复、30 门课程、两节内容、本周/空日课表、资源 Range 和本地注销验证。缺失课件/视频等可选资源及异常分页使用离线测试；未覆盖所有课程和所有服务端状态。完整证据见仓库 `docs/archive/classroom-data-source-verification.md`。
