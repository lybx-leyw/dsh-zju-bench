export const NAV = Object.freeze([
  { id: 'today', label: '今天', icon: 'sun', hint: '从今天开始，按自己的节奏学习' },
  { id: 'courses', label: '我的课', icon: 'book', hint: '课程、回放与课堂资料' },
  { id: 'ask', label: '问一问', icon: 'chat', hint: '和 AI 一起理解、思考与规划' },
  { id: 'study', label: '学习', icon: 'layers', hint: '把学过的内容，慢慢变成自己的知识' },
  { id: 'me', label: '个人', icon: 'user', hint: '你的学习空间' },
]);
export const panelKey = id => `zhiyun.${id}`;
export function activePage(panel) {
  if (panel == null || panel === 'conversation') return 'ask';
  return NAV.find(page => panelKey(page.id) === panel)?.id ?? null;
}
export function matchingPages(query) {
  const normalized = query.trim().toLocaleLowerCase();
  return NAV.filter(page => `${page.label} ${page.hint}`.toLocaleLowerCase().includes(normalized));
}

// 这里曾经有一份 pickLearningWorkspace 的副本。拆包时学习空间连同它的挑选规则一起
// 搬进了 dsh-zhiyun-study-core/src/learning-space.js（那里要求「标题恰好命中一条」才算
// 确定，并把选中逻辑经 zhiyunLearningSpace 服务暴露给外壳）。留在壳里的这份无人导入、
// 语义还更弱（find 而非 filter），是过期副本，已删除 —— 别再抄第二份。
export function beijingDate(now = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' }).format(now);
}
