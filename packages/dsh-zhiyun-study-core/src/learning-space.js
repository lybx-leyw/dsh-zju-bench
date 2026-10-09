/**
 * 本工作台自己的「学习空间」——每个数据目录恰好一个工作区。
 *
 * # 为什么这两行要单独成为模块
 *
 * 这个包的两半都要用它：
 * - **宿主半**（`src/index.js`）是知道数据目录的那一侧，由它去 `workspaceRegistry`
 *   建/复用这条记录，并把标题写进去；
 * - **客户端半**（`src/client.jsx`）要在进入「问一问」时认出**哪一条**是学习空间。
 *
 * 标题一旦在两处各写一遍就会漂移：宿主写「智云学习空间」、客户端找另一个串，
 * 表现是「明明建好了却还是让你选工作区」。所以字面量只留在这里，
 * 两半都 import 它，`tests/learning-space.test.mjs` 会盯着这件事。
 */

/** 学习空间目录名（相对数据目录）。 */
export const LEARNING_SPACE_DIR = 'workspace';

/** 学习空间标题：宿主写进注册表，客户端按它认人。 */
export const LEARNING_SPACE_TITLE = '智云学习空间';

// ---------------------------------------------------------------------------
// 「学习空间」的纯函数部分：宿主半用它建/复用工作区，客户端半用它认人。
// 放在同一个模块里，是因为标题是两半唯一的共同事实（tests/learning-space.test.mjs 盯着）。

/**
 * 从工作区列表里**确定地**认出学习空间。
 *
 * 规则：标题命中优先；只有一个工作区时才兜底（用户可能改过名）；
 * 多个工作区且都没命中标题，视为真歧义 —— 返回 undefined，让上层退回「让用户选」。
 */
export function pickLearningWorkspace(items = [], title = LEARNING_SPACE_TITLE) {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const named = items.filter(item => item?.title === title);
  if (named.length === 1) return named[0];
  return items.length === 1 ? items[0] : undefined;
}

/**
 * 宿主给的时间戳是**毫秒数字**（不是 ISO 串）。早先按字符串处理，结果一边
 * 排不出顺序、一边把相对时间显示成「暂无消息」。数字优先，字符串再退回解析。
 */
export function timestampOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * 一条工作区里可显示的会话行：跳过已归档与未登记的，按更新时间倒序截断。
 *
 * 空白会话保留（用户可能刚开），只是标题给空串 —— 界面上显示成「新会话」。
 */
export function sessionRows(workspace, sessions, limit = 30, archivedSessionIds = []) {
  if (workspace === undefined || sessions === undefined || sessions.phase !== 'ready') return [];
  const archived = new Set((archivedSessionIds ?? []).map(String));
  const rows = [];
  for (const id of workspace.sessionIds ?? []) {
    if (archived.has(String(id))) continue;
    // ⚠️ 宿主的会话列表投影是 `{ phase, ids, byId }`（见 dsh-api-session-controller 的
    //    ClientSessions）；没有 `sessions` 这个字段，读它会让每一行都落空。
    const summary = sessions.byId?.[id];
    if (summary === undefined) continue;
    rows.push({
      id,
      title: summary.blank === true ? '' : (summary.displayTitle ?? ''),
      blank: summary.blank === true,
      updatedAt: timestampOf(summary.updatedAt),
    });
  }
  rows.sort((left, right) => right.updatedAt - left.updatedAt);
  return rows.slice(0, limit);
}

/** 相对时间：一周内说「几分钟前」，再往前给日期。 */
export function relativeLabel(value, now = new Date()) {
  const at = timestampOf(value);
  if (at === 0) return '';
  const minutes = Math.floor((now.getTime() - at) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  // 日期按北京时间算：宿主的 `updatedAt` 是本地毫秒数，但界面上的「几月几日」
  // 是给人看的日历日 —— 跨时区（或机器时区不是 +08）时按机器时区算会差一天。
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' }).format(new Date(at));
}
