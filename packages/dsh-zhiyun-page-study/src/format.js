// 时刻格式化：只服务于学习工作台的读法。
//
// `time` 是课件页上「课堂时间 mm:ss」，`lessonWhen` 是节次列表上的开课时间。
// 它们读的是领域数据（startAt / startMs 的语义来自智云课堂接口），但**只被界面使用**，
// 所以留在页面包里；状态包（dsh-zhiyun-study-core）只管取数与任务。
export const time = (ms) => {
  const seconds = Math.floor(ms / 1e3);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

export function lessonWhen(value) {
  if (value == null || value === '') return '课堂学习';
  const raw = String(value).trim();
  // 10-13 位数字串按时间戳解释：上游既有秒（10 位）也有毫秒（13 位）。
  const n = /^\d{10,13}$/.test(raw) ? Number(raw) : null;
  const date = new Date(n === null ? raw : n < 1e12 ? n * 1000 : n);
  return Number.isNaN(date.getTime()) ? raw : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}
