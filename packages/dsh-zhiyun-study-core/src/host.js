// 学习领域核心的**宿主半边**。两件事，都是「学习」这个产品事实：
//
// 1. 学习空间：每个数据目录恰好一个工作区记录。路径来源按可靠性排序：`DSH_HOME`
//    （本工作台自己的数据目录）优先；没有该变量时退回宿主进程的工作目录 ——
//    我们的启动脚本就是 `cwd = <数据目录>/workspace`，两者指向同一个目录。
//    `create` 是「建或复用」且按 fs.realpath 归一化：重复启动只会拿到同一条记录。
// 2. 学习工作台：把课程/解析/持久化编排挂成 `zhiyunStudy` 服务 + /api/zhiyun-study。
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { StudyWorkbench, publicError } from "./workbench.js";
import { LEARNING_SPACE_DIR, LEARNING_SPACE_TITLE } from './learning-space.js';

// ⚠️ 只声明**硬依赖**：讲义与终审是可选加工步骤，用 `ctx.get` 惰性取。
//    写进 inject 会让「停用其中一个」直接拖死整个学习面板（连解析都用不了）。
export const inject = ["workspaceRegistry", "connection", "profileContext", "zhiyunClassroom", "zhiyunParser", "llm", "zhiyunKnowledge"];

export async function apply(ctx) {
  const home = process.env.DSH_HOME;
  const dir = home ? path.join(home, LEARNING_SPACE_DIR) : process.cwd();
  try {
    await mkdir(dir, { recursive: true });
    if (!(await stat(dir)).isDirectory()) throw new Error('不是一个目录');
    const workspace = await ctx.workspaceRegistry.create(dir, LEARNING_SPACE_TITLE);
    ctx.logger?.info?.(`zhiyun: 学习空间就绪 ${workspace.id} → ${dir}`);
  } catch (error) {
    // 学习空间建不出来不该让学习面板装不上：如实警告，客户端会退回「让用户选」。
    ctx.logger?.warn?.(`zhiyun: 学习空间 ${dir} 不可用：${error}`);
  }
  const workbench = new StudyWorkbench({ classroom: ctx.zhiyunClassroom, parser: ctx.zhiyunParser, llm: ctx.llm,
    knowledge: ctx.zhiyunKnowledge,
    directory: path.join(ctx.profileContext.dir, "data/zhiyun-study"),
    lecture: () => ctx.get("zhiyunLecture"), finalPass: () => ctx.get("zhiyunFinalPass") });
  await workbench.ready;
  ctx.provide("zhiyunStudy", workbench);
  const remove = ctx.connection.fetch.register({ path: "/api/zhiyun-study", methods: ["POST"], requestBody: "buffered", fetch: async (request) => {
    let rpcId = "invalid-request", result;
    try {
      const message = await request.json();
      if (message?.type !== "client-request" || message.method !== "zhiyun-study" || typeof message.rpcId !== "string" || message.rpcId.length > 200) throw Object.assign(new Error("invalid envelope"), { code: "INPUT" });
      rpcId = message.rpcId;
      const { method, args } = message.payload ?? {};
      if (!["state", "login", "logout", "courses", "lessons", "content", "result", "results", "start", "cancel", "models", "models-save", "lecture", "final-pass", "lecture-restore", "search"].includes(method) || args === null || typeof args !== "object" || Array.isArray(args)) throw Object.assign(new Error("unknown"), { code: "INPUT" });
      result = { ok: true, value: await workbench.invoke(method, args, request.signal) };
    } catch (error) {
      result = { ok: false, error: { ...publicError(error), details: {} } };
    }
    return Response.json({ type: "server-response", rpcId, result }, { headers: { "cache-control": "no-store" } });
  } });
  return async () => {
    await remove();
    await workbench.dispose();
  };
}
