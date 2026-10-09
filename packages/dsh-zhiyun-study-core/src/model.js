export function createStudyController(call, navigation) {
  let state = { loading: true, user: null, courses: [], lessons: [], course: null, lesson: null, content: null, result: null, job: null, activeJob: null, error: null, busy: false, sectionLoading: false, contentLoading: false, coursesMeta: null, lessonsMeta: null, lessonsByCourse: {}, lessonMetaByCourse: {}, lessonHiddenByCourse: {}, loadingCourses: {}, sectionStates: {}, expandedCourses: {}, lecture: null, lectureBusy: false, finalPassBusy: false };
  const listeners = new Set(), lifetime = new AbortController();
  let closed = false, selection = 0, account = 0, timer = null, polling = false;
  const lessonLoads = new Map();
  const update = (patch) => {
    if (closed) return;
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };
  async function request(method, payload = {}) {
    return call(method, payload, lifetime.signal);
  }
  const currentKey = () => state.lesson ? { courseId: state.course.id, subId: state.lesson.subId } : null;
  async function refresh() {
    const epoch = ++account;
    selection++;
    lessonLoads.clear();
    update({ loading: true, error: null, course: null, lesson: null, result: null, content: null, lessons: [], courses: [], job: null, activeJob: null, lessonsByCourse: {}, lessonMetaByCourse: {}, lessonHiddenByCourse: {}, loadingCourses: {}, sectionStates: {}, expandedCourses: {}, lecture: null, lectureBusy: false, finalPassBusy: false, busy: false });
    try {
      const initial = await request("state");
      if (epoch !== account || closed) return;
      update({ user: initial.user, activeJob: initial.jobs[0] ?? null });
      if (initial.jobs.length) schedule();
      if (initial.user) {
        const courses = await request("courses");
        if (epoch === account) update({ courses: courses.items, coursesMeta: courses.meta });
      }
    } catch (e) {
      if (epoch === account) update({ error: e.message, ...e.code === "SESSION_EXPIRED" ? { user: null } : {} });
    } finally {
      if (epoch === account) update({ loading: false });
    }
  }
  async function loadCourse(course, { force = false } = {}) {
    const id = String(course.id);
    if (!force && state.lessonsByCourse[id]) return { items: state.lessonsByCourse[id], meta: state.lessonMetaByCourse[id] };
    if (!force && lessonLoads.has(id)) return lessonLoads.get(id);
    const epoch = account;
    update({ loadingCourses: { ...state.loadingCourses, [id]: true } });
    const task = (async () => {
      try {
        const data = await request("lessons", { courseId: course.id });
        if (epoch !== account || closed) return { items: playableLessons(data.items), meta: data.meta };
        // 上游给的是**课程表上的全部槽位**，未开课、未发布的节次也在列表里。
        // 它们不可回放，也不可能有解析结果，所以在**写入口**就丢掉，与 App
        // 同口径（`ClassroomVideo.isPlayable` 即 `status === '6'`）。渲染路径
        // 因此不再需要过滤；隐藏数单独留一份，免得以后想看「另有 N 节不可
        // 回放」时无从可查。
        const items = playableLessons(data.items);
        update({ lessonsByCourse: { ...state.lessonsByCourse, [id]: items }, lessonMetaByCourse: { ...state.lessonMetaByCourse, [id]: data.meta }, lessonHiddenByCourse: { ...state.lessonHiddenByCourse, [id]: (data.items?.length ?? 0) - items.length }, ...(state.course?.id === course.id ? { lessons: items, lessonsMeta: data.meta } : {}) });
        // Load persisted parse/job state lazily for the expanded course.
        //
        // 合批成一次 RPC：一门课的可回放节次通常在十几个到几十个，逐节查询
        // 等于 O(节数) 次往返（线性代数 31 次、大学写作 61 次），而这里问的
        // 只是「有没有已存产物」，宿主侧查的是本地存储。
        const subIds = items.map((lesson) => lesson.subId).filter(Boolean).map(String);
        if (subIds.length) {
          try {
            const batch = await request("results", { courseId: course.id, subIds });
            if (epoch === account && !closed) {
              const states = { ...state.sectionStates };
              for (const [subId, status] of Object.entries(batch.items ?? {})) states[`${id}:${subId}`] = { parsed: Boolean(status.hasResult), resultStatus: status.resultStatus ?? null, job: status.job ?? null };
              update({ sectionStates: states });
            }
          } catch {
            // Keep source availability separate from parse status. The lesson
            // remains usable and its status can be retried on refresh.
          }
        }
        return { items, meta: data.meta };
      } catch (error) {
        if (epoch === account && !closed) update({ error: error.message });
        throw error;
      } finally {
        lessonLoads.delete(id);
        if (epoch === account && !closed) update({ loadingCourses: { ...state.loadingCourses, [id]: false } });
      }
    })();
    lessonLoads.set(id, task);
    return task;
  }
  async function selectCourse(course) {
    const ticket = ++selection;
    update({ course, lesson: null, lessons: [], content: null, result: null, job: null, error: null, sectionLoading: true, contentLoading: false, expandedCourses: { ...state.expandedCourses, [String(course.id)]: true } });
    try {
      const lessons = await loadCourse(course);
      if (ticket === selection) update({ lessons: lessons.items, lessonsMeta: lessons.meta });
    } catch (e) {
      if (ticket === selection) update({ error: e.message });
    } finally {
      if (ticket === selection) update({ sectionLoading: false });
    }
  }
  async function selectLesson(lesson, course = state.course) {
    if (!course) return;
    const ticket = ++selection, key = { courseId: course.id, subId: lesson.subId };
    update({ course, lesson, lessons: state.lessonsByCourse[String(course.id)] ?? state.lessons, lessonsMeta: state.lessonMetaByCourse[String(course.id)] ?? state.lessonsMeta, content: null, result: null, lecture: null, lectureBusy: false, finalPassBusy: false, busy: false, job: null, error: null, contentLoading: true });
    const outcomes = await Promise.allSettled([request("content", key), request("result", key)]);
    if (ticket !== selection || closed) return;
    const [content, result] = outcomes;
    const parsed = result.status === "fulfilled" ? result.value.result : null;
    const job = result.status === "fulfilled" ? result.value.job : null;
    const sectionKey = `${course.id}:${lesson.subId}`;
    update({ lecture: parsed?.lecture ?? null, content: content.status === "fulfilled" ? content.value : null, result: parsed, job, sectionStates: { ...state.sectionStates, [sectionKey]: { parsed: Boolean(parsed), resultStatus: parsed?.status ?? null, job } }, contentLoading: false, error: outcomes.filter((r) => r.status === "rejected").map((r) => r.reason.message).join("；") || null });
    if (result.status === "fulfilled" && result.value.job?.error) update({ error: result.value.job.error.message });
    if (result.status === "fulfilled" && result.value.job?.state === "running") {
      update({ activeJob: result.value.job });
      schedule();
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (!closed) timer = setTimeout(poll, 800);
  }
  async function poll() {
    if (closed || polling || !state.activeJob) return;
    polling = true;
    const epoch = account, active = state.activeJob;
    try {
      let data = await request("result", { courseId: active.courseId, subId: active.subId, includeResult: false });
      if (data.job?.state !== "running") data = await request("result", { courseId: active.courseId, subId: active.subId });
      if (epoch !== account || closed) return;
      const key = currentKey(), selected = key?.courseId === active.courseId && key?.subId === active.subId;
      const sectionKey = `${active.courseId}:${active.subId}`;
      update({ ...selected ? { job: data.job, result: data.result ?? state.result, ...(data.result ? { lecture: data.result.lecture ?? null } : {}) } : {}, activeJob: data.job?.state === "running" ? data.job : null, sectionStates: { ...state.sectionStates, [sectionKey]: { parsed: Boolean(data.hasResult ?? data.result), resultStatus: data.resultStatus ?? data.result?.status ?? null, job: data.job ?? null } } });
      if (data.job?.error) update({ error: data.job.error.message });
      if (data.job?.state === "running") schedule();
    } catch (e) {
      if (epoch === account) {
        update({ error: e.message });
        schedule();
      }
    } finally {
      polling = false;
    }
  }
  return {
    getSnapshot: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    request,
    refresh,
    loadCourse,
    selectCourse,
    selectLesson,
    /**
     * 展开 / 收起某门课。展开状态放在控制器里，与 `course`/`lesson` 同寿命：
     * 组件自己的 `useState` 会随左侧导航切换而卸载丢失，于是切走再回来时
     * 右边还开着某节课、左边的树却全收起了，得重新点开。
     */
    toggleCourse(course) {
      const id = String(course.id), open = !state.expandedCourses[id];
      update({ expandedCourses: { ...state.expandedCourses, [id]: open } });
      if (open) void loadCourse(course).catch(() => {});
      return open;
    },
    navigate: (page) => navigation.navigate(page),
    async authenticate(credentials) {
      update({ busy: true, error: null });
      try {
        await request("login", credentials);
        await refresh();
      } catch (e) {
        update({ error: e.message });
      } finally {
        update({ busy: false });
      }
    },
    async logout() {
      update({ busy: true, error: null });
      try {
        await request("logout");
        clearTimeout(timer);
        await refresh();
      } catch (e) {
        update({ error: e.message });
      } finally {
        update({ busy: false });
      }
    },
    async start() {
      const key = currentKey();
      if (!key) return;
      const epoch = account;
      update({ busy: true, error: null });
      try {
        const job = await request("start", { ...key, context: `${state.course.title} · ${state.lesson.title}` });
        if (epoch === account) {
          const selected = key.courseId === state.course?.id && key.subId === state.lesson?.subId;
          update({ ...(selected ? { job } : {}), activeJob: job });
          const sectionKey = `${key.courseId}:${key.subId}`;
          update({ sectionStates: { ...state.sectionStates, [sectionKey]: { ...state.sectionStates[sectionKey], ...(selected ? { parsed: Boolean(state.result), resultStatus: state.result?.status ?? null } : {}), job } } });
          schedule();
        }
      } catch (e) {
        update({ error: e.message });
      } finally {
        update({ busy: false });
      }
    },
    async cancel() {
      if (!state.activeJob) return;
      update({ busy: true });
      try {
        await request("cancel", { courseId: state.activeJob.courseId, subId: state.activeJob.subId });
        await poll();
      } catch (e) {
        update({ error: e.message });
      } finally {
        update({ busy: false });
      }
    },
    /**
     * 生成讲义（习坎装配）。与解析**分开**是有意的：解析是「把课听成字」，
     * 讲义是「把字整理成可读的稿」——后者要再看一遍模型，用户可能只想先解析。
     */
    async assembleLecture() {
      const key = currentKey(); if (!key) return;
      const ticket = selection, epoch = account;
      update({ busy: true, error: null, lectureBusy: true });
      try {
        const lecture = await request("lecture", { ...key, context: [state.course?.title, state.lesson?.title].filter(Boolean).join(" · ") });
        if (ticket === selection && epoch === account) update({ lecture, result: { ...state.result, lecture, lectureHistory: [], canRestoreLecture: false } });
      } catch (e) { if (ticket === selection && epoch === account) update({ error: e.message }); }
      finally { if (ticket === selection && epoch === account) update({ busy: false, lectureBusy: false }); }
    },
    async finalPass() {
      const key = currentKey(); if (!key) return;
      const ticket = selection, epoch = account;
      update({ busy: true, error: null, finalPassBusy: true });
      try {
        const out = await request("final-pass", key);
        if (ticket === selection && epoch === account) update({ lecture: out.lecture, result: { ...state.result, lecture: out.lecture, canRestoreLecture: true } });
      } catch (e) { if (ticket === selection && epoch === account) update({ error: e.message }); }
      finally { if (ticket === selection && epoch === account) update({ busy: false, finalPassBusy: false }); }
    },
    async restoreLecture() {
      const key = currentKey(); if (!key) return;
      const ticket = selection, epoch = account; update({ busy: true, error: null });
      try {
        const out = await request('lecture-restore', key);
        if (ticket === selection && epoch === account) update({ lecture: out.lecture, result: { ...state.result, lecture: out.lecture, canRestoreLecture: out.historyCount > 0 } });
      } catch (e) { if (ticket === selection && epoch === account) update({ error: e.message }); }
      finally { if (ticket === selection && epoch === account) update({ busy: false }); }
    },
    dispose() {
      closed = true;
      selection++;
      account++;
      clearTimeout(timer);
      lifetime.abort();
      listeners.clear();
    }
  };
}
export const time = (ms) => {
  const seconds = Math.floor(ms / 1e3);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
/**
 * 节次可回放判定 —— 与 App 同口径（`ClassroomVideo.isPlayable`，即
 * `status === '6'`）。
 *
 * 上游给的是**课程表上的全部槽位**：尚未开课、尚未发布的节次也在列表里。
 * App 拉全量后在 UI 层丢掉它们（`study_section_list.dart:482`，收藏空态
 * 「这门课还没有可回放的节」），这里保持一致。
 *
 * 缺字段时按可回放处理：判定权在上游，客户端不该因为字段缺失而藏掉课程。
 */
export const playableLessons = (items = []) => items.filter((lesson) => lesson?.isPlayable !== false);

// 检索不再放在控制器里：档位、2×11 维与层范围都是**纯函数**的输入，
// 由 `layers.js`（层/档位注册表）与 `layered-search.js`（检索引擎）承担，
// 视图自己持有那几个 useState。控制器只管数据与任务。


export function lessonWhen(value) {
  if (value == null || value === '') return '课堂学习';
  const raw = String(value).trim();
  const n = /^\d{10,13}$/.test(raw) ? Number(raw) : null;
  const date = new Date(n === null ? raw : n < 1e12 ? n * 1000 : n);
  return Number.isNaN(date.getTime()) ? raw : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}
