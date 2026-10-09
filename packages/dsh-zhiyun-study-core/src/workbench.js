import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { exportReorganization, mergeReorganization } from "dsh-zhiyun-lecture/agent-text";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fault = (code, message) => Object.assign(new Error(message), { code });
const identifier = (value) => {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) throw fault("INPUT", "课程或节次编号无效");
  return value;
};
// The parser's final transcript is immutable input to the separately versioned handout.
export const finalVersion = record => digest(JSON.stringify([record.sourceId, record.pages, record.sentences, record.unassignedSentences, record.blocks, record.spine, record.outline]));
const identity = key => { const [accountId, courseId, subId] = key.split(":"); return { accountId, courseId, subId }; };
const faultMessages = {
  NOT_WIRED: "所需加工插件未启用，请检查插件配置。", FORMAT: "终审稿格式无法读取，已保留上一版讲义。",
  CORRUPT: "已有学习资料无法读取，原文件已保留。", INVALID_RECORD: "产物未通过存储校验，未覆盖已有资料。",
  TIMEOUT: "加工超时，已有终稿和讲义已保留。", ABORTED: "加工已取消。",
  NO_PROVIDER: "终审所需的宿主子 Agent 服务不可用。", AGENT_START_FAILED: "终审 Agent 启动失败，请检查宿主模型和预设。",
  NO_MAIN: "本节没有可用的主线块，请先完成终稿标注。", NO_TOPICS: "未从课件中提取出可写成讲义的知识点。",
  SLIDE_READ_FAILED: "课件图片尚未成功解析。请重新整理这节课，再生成讲义。",
};
export const publicError = (error) => ({ code: error.code ?? "FAILED", message: {
  ...faultMessages,
  VISION_MODEL: "请选择支持图片的视觉模型，再开始解析。",
  CONFIG: "请先在个人面板配置可用的 AI 服务。",
  SESSION_EXPIRED: "课堂登录已过期，请重新登录。",
  CANCELLED: "已取消解析。",
  PARTIAL_SOURCE: "课件或字幕仍在处理中，请稍后再试。",
  INPUT: "输入信息无效。",
  NETWORK: "课堂服务暂时无法连接，请稍后重试。",
  AUTH_REJECTED: "账号或密码未通过验证。",
  CREDENTIALS: "请输入浙大账号和密码。",
  ACCOUNT_BUSY: "账号正在切换，请稍候。",
  BUSY: "已有加工任务正在运行，请等待完成或先取消。"
}[error.code] ?? "操作未完成，请重试。" });
export class StudyWorkbench {
  constructor({ classroom, parser, llm, directory, lecture, finalPass, knowledge }) {
    this.classroom = classroom;
    this.parser = parser;
    this.llm = llm;
    this.directory = directory;
    if (!knowledge?.get || !knowledge?.put) throw fault("CONFIG", "学习工作台需要知识库存储服务");
    this.knowledge = knowledge;
    this.mutations = new Map();
    this.migrations = new Map();
    // 讲义装配与无曰终审**惰性取用**（传进来的是取值函数，不是服务实例）。
    //
    // ⚠️ 不写进插件的 `inject` 是有意的：`inject` 是**硬依赖** —— 任一被停用
    //    都会让整个学习面板 pending（连解析都用不了）。这两个是可选的加工步骤，
    //    缺了应当只让「讲义 / 终审」这两个动作如实报未接入，而不是把页面拖死。
    this.lectureOf = lecture ?? (() => undefined);
    this.finalPassOf = finalPass ?? (() => undefined);
    this.jobs = new Map();
    this.closed = false;
    this.accountBusy = false;
    this.controllers = new Set();
    this.ready = this.loadRoutes();
  }
  async loadRoutes() {
    try {
      const r = JSON.parse(await readFile(path.join(this.directory, "models.json"), "utf8"));
      this.parser.llm.routes = this.cleanRoutes(r);
    } catch (e) {
      if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
    }
  }
  cleanRoutes(routes = {}) {
    const out = {};
    for (const key of ["vision", "text"]) {
      const r = routes[key];
      if (r == null) continue;
      if (typeof r.provider !== "string" || typeof r.model !== "string" || !r.provider || !r.model || r.provider.length > 200 || r.model.length > 300) throw fault("INPUT", "模型路由无效");
      out[key] = { provider: r.provider, model: r.model };
    }
    return out;
  }
  async atomic(file, data) {
    // 复用宿主的原子替换：它专门处理了 Windows 上 rename 的瞬态
    // EACCES/EBUSY/EPERM 重试，并保证替换后的 inode 带上传入的权限位。
    // 手写 `writeFile` + `rename` 在 Windows 上会偶发失败。
    await writeFileAtomic(file, JSON.stringify(data), { mode: 0o600, dirMode: 0o700 });
  }
  async user() {
    if (this.accountBusy) throw fault("ACCOUNT_BUSY", "账号正在切换");
    const user = await this.classroom.getCurrentUser();
    if (!user) throw fault("SESSION_EXPIRED", "需要登录");
    return user;
  }
  key(user, courseId, subId) {
    if (!/^[^\s:]+$/.test(String(user.id))) throw fault("INPUT", "账号标识无效");
    return `${user.id}:${identifier(courseId)}:${identifier(subId)}`;
  }
  file(key) {
    return path.join(this.directory, "results", `${digest(key)}.json`);
  }
  async result(key) {
    const current = await this.knowledge.get(identity(key));
    if (current) return structuredClone(current);
    if (this.migrations.has(key)) return this.migrations.get(key);
    const migration = this.migrate(key); this.migrations.set(key, migration);
    try { return await migration; } finally { this.migrations.delete(key); }
  }
  async migrate(key) {
    // Lazy migration: only the currently authenticated account can derive this
    // old hash. Keep the old file as a recovery copy; never dual-write it.
    let old;
    try { old = JSON.parse(await readFile(this.file(key), "utf8")); }
    catch (e) { if (e.code === "ENOENT") return null; if (e instanceof SyntaxError) throw fault("CORRUPT", "旧产物 JSON 损坏"); throw e; }
    if (old.schema !== 1 || !Array.isArray(old.blocks)) throw fault("CORRUPT", "旧产物格式无效");
    const { finalPass: legacyReview, ...record } = old;
    record.sourceVersion = finalVersion(record);
    if (record.lecture) record.lecture = { ...record.lecture, sourceVersion: record.sourceVersion,
      revision: digest(JSON.stringify(record.lecture)), review: null,
      warnings: [...(record.lecture.warnings ?? []), ...(legacyReview ? ["旧终审文本未合回结构，请重新终审讲义。"] : [])] };
    // A concurrent migration may have already populated the domain.
    if (!await this.knowledge.get(identity(key))) await this.knowledge.put({ ...record, ...identity(key) });
    return structuredClone(await this.knowledge.get(identity(key)));
  }
  async save(key, record) { await this.knowledge.put(JSON.parse(JSON.stringify({ ...record, ...identity(key) }))); }
  async mutate(key, signal, work) {
    if (this.closed) throw fault("DISPOSED", "服务已关闭");
    if (this.accountBusy) throw fault("ACCOUNT_BUSY", "账号正在切换");
    if (this.mutations.has(key)) throw fault("BUSY", "这一节已有加工任务");
    const controller = new AbortController();
    const entry = { controller, done: null };
    this.mutations.set(key, entry);
    entry.done = Promise.resolve().then(() => work(AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])));
    try { return await entry.done; } finally { if (this.mutations.get(key) === entry) this.mutations.delete(key); }
  }
  view(job) {
    return job ? { id: job.id, courseId: job.courseId, subId: job.subId, state: job.state, progress: job.progress, error: job.error ?? null } : null;
  }
  async account(action, credentials, signal) {
    if (this.accountBusy) throw fault("ACCOUNT_BUSY", "账号正在切换");
    this.accountBusy = true;
    try {
      for (const job of this.jobs.values()) if (job.state === "running") job.controller.abort();
      for (const op of this.mutations.values()) op.controller.abort();
      await Promise.allSettled([...this.jobs.values()].map(j => j.done).concat([...this.mutations.values()].map(op => op.done)));
      if (action === "logout") {
        await this.classroom.logout();
        return { user: null };
      }
      if (typeof credentials?.username !== "string" || typeof credentials?.password !== "string" || credentials.username.length > 200 || credentials.password.length > 1e3) throw fault("INPUT", "账号信息无效");
      const result = await this.classroom.login({ username: credentials.username.trim(), password: credentials.password }, { signal });
      return { user: result.user };
    } finally {
      this.accountBusy = false;
    }
  }
  async start(courseId, subId, context) {
    await this.ready;
    const user = await this.user(), key = this.key(user, courseId, subId), existing = this.jobs.get(key);
    if (existing?.state === "running") return this.view(existing);
    if ([...this.jobs.values()].some((j) => j.state === "running")) throw fault("BUSY", "请先等待或取消当前解析");
    if (this.mutations.has(key)) throw fault("BUSY", "这一节已有加工任务");
    const controller = new AbortController();
    const job = { id: randomUUID(), courseId, subId, state: "running", progress: { phase: "source", done: 0, total: 0 }, controller, userId: user.id };
    this.jobs.set(key, job);
    job.done = (async () => {
      try {
        await this.mutate(key, controller.signal, async signal => {
        const result = await this.parser.parseClassroom(courseId, subId, { context: typeof context === "string" ? context.slice(0, 500) : `${courseId} · ${subId}`, signal, onProgress: (p) => job.progress = p });
        signal.throwIfAborted();
        const sourceVersion = finalVersion(result), previous = await this.result(key);
        // Equal transcript preserves its derived handout. A changed transcript
        // explicitly invalidates the handout and review; no stale final-pass text.
        const keep = previous?.sourceVersion === sourceVersion;
        await this.save(key, { ...result, sourceVersion, title: typeof context === "string" ? context : result.sourceId,
          lecture: keep ? previous.lecture ?? null : null, knowledgeTree: keep ? previous.knowledgeTree ?? null : null,
          lectureHistory: keep ? previous.lectureHistory ?? [] : [] });
        job.state = result.status === "ready" ? "ready" : "partial";
        });
      } catch (error) {
        job.state = controller.signal.aborted ? "cancelled" : "failed";
        job.error = publicError(error);
      }
    })();
    return this.view(job);
  }
  /**
   * 把一节**已经解析过**的产物装配成讲义，并落进同一份记录里。
   *
   * # 为什么讲义是「投影」，不原地改树
   *
   * 知识树是空间性的课程图谱（后续出题、复习、知识树视图都建在它上面），
   * 而讲义只是「这次课讲到了哪几块」的一次投影。所以这里每次都用
   * `buildTree` **重建**一棵树再交给装配器，而不是把上一版的树读回来改 ——
   * 原地改树等于把「这次有没有讲到」写回地图，App 侧已经写错过一次。
   */
  async assembleLecture(key, payload, signal) {
    return this.mutate(key, signal, async signal => {
      const lecture = this.lectureOf();
      if (!lecture?.assemble || !lecture?.buildTree) throw fault("NOT_WIRED", "讲义装配未接入");
      const stored = await this.result(key);
      if (!stored) throw fault("INPUT", "请先生成终稿");
      // App uses pageText for its knowledge tree, not visual description.
      const slides = stored.pages.filter(p => p.transcription?.pageText?.trim())
        .map(p => ({ page: p.page, text: p.transcription.pageText }));
      if (!slides.length && stored.pages.some(p => !p.transcription)) throw fault("SLIDE_READ_FAILED", "课件图片尚未成功解析");
      const selected = stored.blocks.filter(b => b.tag?.role === "主线");
      if (!selected.length) throw fault("NO_MAIN", "本节没有主线块");
      const excluded = stored.blocks.length - selected.length;
      const blocks = selected.map(b => ({ index: b.index, page: b.page,
        text: b.sentences.map(s => s.text).join(""), summary: b.tag?.summary ?? "", startMs: b.startMs ?? null }));
      const tree = lecture.buildTree({ slides, blocks, outline: stored.outline ?? [] });
      const title = typeof payload.context === "string" ? payload.context.slice(0, 500) : String(stored.title ?? stored.sourceId ?? "");
      const out = await lecture.assemble({ tree, blocks, context: title, signal });
      signal.throwIfAborted();
      if (!out.chapters.length) throw fault("NO_TOPICS", "没有可用讲义知识点");
      const generated = { schema: 1, title, chapters: out.chapters,
        warnings: [...(tree.warnings ?? []), ...(out.warnings ?? []), ...(excluded ? [`已排除 ${excluded} 个支线或未标注块；终稿保留全部内容。`] : [])],
        failures: out.failures, sourceVersion: stored.sourceVersion, revision: randomUUID(), review: null, at: new Date().toISOString() };
      await this.save(key, { ...stored, lectureHistory: [], knowledgeTree: { ...tree, sourceVersion: stored.sourceVersion }, lecture: generated });
      return generated;
    });
  }
  async finalPass(key, payload, signal) {
    return this.mutate(key, signal, async signal => {
      const pass = this.finalPassOf();
      if (!pass?.run) throw fault("NOT_WIRED", "讲义终审未接入");
      const stored = await this.result(key), lecture = stored?.lecture;
      if (!lecture?.chapters?.length) throw fault("INPUT", "请先生成讲义");
      // Use the account-scoped key, not caller-provided ids, for sandbox files.
      const sectionId = digest(key);
      const before = exportReorganization(lecture, sectionId, stored);
      const out = await pass.run({ text: before, sectionId, signal });
      signal.throwIfAborted();
      const merged = mergeReorganization(lecture, out.text, stored, sectionId);
      const reviewed = { ...merged.lecture, revision: randomUUID(), review: {
        schema: 2, sourceVersion: stored.sourceVersion, baseRevision: lecture.revision, coverage: merged.coverage,
        text: out.text, unchanged: out.unchanged, updatedTopics: merged.updated,
        childEvents: out.childEvents ?? null, at: new Date().toISOString(),
      } };
      // Parser pages, sentences, timestamps, roles and block indexes are untouched.
      await this.save(key, { ...stored, lectureHistory: [...(stored.lectureHistory ?? []), lecture].slice(-3), lecture: reviewed });
      return { lecture: reviewed, unchanged: out.unchanged };
    });
  }
  async restoreLecture(key, signal) {
    return this.mutate(key, signal, async () => {
      const stored = await this.result(key), history = [...(stored?.lectureHistory ?? [])];
      const lecture = history.pop();
      if (!lecture || lecture.sourceVersion !== stored.sourceVersion) throw fault("INPUT", "没有可恢复的同版本讲义");
      await this.save(key, { ...stored, lecture, lectureHistory: history });
      return { lecture, historyCount: history.length };
    });
  }
  async dispatch(method, payload = {}, signal) {
    if (this.closed) throw fault("DISPOSED", "服务已关闭");
    await this.ready;
    signal?.throwIfAborted();
    if (method === "state") {
      const user2 = await this.classroom.getCurrentUser();
      return { user: user2, jobs: [...this.jobs.values()].filter((j) => j.state === "running" && j.userId === user2?.id).map((j) => this.view(j)) };
    }
    if (method === "login" || method === "logout") return this.account(method, payload, signal);
    if (method === "models") {
      const catalog = await Promise.all(this.llm.listProviders().map(async (p) => ({ id: p.id, name: p.name, models: await this.llm.listModels(p.id) })));
      return { catalog, routes: this.parser.llm.routes };
    }
    if (method === "models-save") {
      if (this.mutations.size) throw fault("BUSY", "加工完成后才能切换模型");
      const routes = this.cleanRoutes(payload.routes);
      for (const r of Object.values(routes)) await this.llm.resolveModelInfo(r.provider, r.model, signal);
      await this.atomic(path.join(this.directory, "models.json"), routes);
      this.parser.llm.routes = routes;
      return { routes };
    }
    const user = await this.user();
    if (method === "courses") return this.classroom.listCourses({ signal });
    if (method === "search") {
      if (typeof payload.query !== "string" || payload.query.length > 500) throw fault("INPUT", "检索词无效");
      return this.knowledge.search({ accountId: String(user.id), query: payload.query,
        ...(payload.courseId == null ? {} : { courseId: identifier(payload.courseId) }), layer: payload.layer ?? "final" });
    }
    const courseId = identifier(payload.courseId);
    if (method === "lessons") return this.classroom.listLessons(courseId, { onlyPlayable: false, signal });
    // 批量解析状态：界面展开一门课时要知道每个节次有没有已存产物，逐节
    // 发 `result` 等于 O(节数) 次往返（线性代数 31、大学写作 61）。这里
    // 一次问完整门课，宿主侧只是查本地存储。单个坏编号跳过即可，不该让
    // 一个陈旧 id 把整棵课程树打空。
    if (method === "results") {
      const subIds = Array.isArray(payload.subIds) ? payload.subIds.slice(0, 200) : [];
      const items = {};
      await Promise.all(subIds.map(async (raw) => {
        let id;
        try { id = identifier(raw); } catch { return; }
        const itemKey = this.key(user, courseId, id), stored = await this.result(itemKey);
        items[id] = { hasResult: Boolean(stored), resultStatus: stored?.status ?? null, job: this.view(this.jobs.get(itemKey)) };
      }));
      return { items };
    }
    const subId = identifier(payload.subId), key = this.key(user, courseId, subId);
    if (method === "content") return this.classroom.getLessonContent(courseId, subId, { signal });
    if (method === "result") {
      const stored = await this.result(key);
      return { result: payload.includeResult === false ? null : stored, hasResult: Boolean(stored), resultStatus: stored?.status ?? null, job: this.view(this.jobs.get(key)) };
    }
    if (method === "lecture") return this.assembleLecture(key, payload, signal);
    if (method === "final-pass") return this.finalPass(key, payload, signal);
    if (method === "lecture-restore") return this.restoreLecture(key, signal);
    if (method === "start") return this.start(courseId, subId, payload.context);
    if (method === "cancel") {
      const job = this.jobs.get(key);
      if (job?.state === "running") {
        job.controller.abort();
        await job.done;
      }
      return this.view(job);
    }
    throw fault("INPUT", "未知操作");
  }
  async invoke(method, payload, signal) {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return await this.dispatch(method, payload, AbortSignal.any([controller.signal, ...signal ? [signal] : []]));
    } finally {
      this.controllers.delete(controller);
    }
  }
  async dispose() {
    this.closed = true;
    for (const c of this.controllers) c.abort();
    for (const job of this.jobs.values()) job.controller.abort();
    for (const op of this.mutations.values()) op.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(j => j.done).concat([...this.mutations.values()].map(op => op.done)));
  }
}
