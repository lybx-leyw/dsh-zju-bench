/// **书面语验收**：对照口述，判断整理稿能不能算「已成稿」。
///
/// 逐条对齐 App 的 `lib/fusion/lecture_register.dart`：没通过的概念**保持草稿**，
/// 正文可以留下，不退回口述。
///
/// # 为什么判据是「字符串形态」而不是「像不像书面语」
///
/// 因为「像不像书面语」不可复核。下面几条**可复核**：空稿、与口述逐字相同、
/// 含课堂称呼、说半截的句子。用户手里就有口述稿，他能在两秒内核对每一条。
/// 判据越可复核，越不会被当成「AI 觉着不行」—— 那种读数用户已经否过一次。
///
/// ⚠️ 本文件不判长度、不判口语词密度：那两条住 `polish.js`，而且**都不驱动回退**
///    （原话的口语词比产出更多，退回原话等于给用户一份更脏的）。

/// 课堂称呼：这些词**只可能**来自教室现场，书面讲义里不该出现。
///
/// 与 `kLectureFillerWords` 故意重叠而不合并：那条是**密度判据**（只报告），
/// 这条是**成稿判据**（决定 register）。两条判据要能各自改，各自动摇。
export const kClassroomMarks = [
  '同学们',
  '各位同学',
  '我们来看',
  '大家看',
  '听懂了吗',
];

/// 成稿状态（与 Dart `TopicRegister` 的三个值同口径）。
///
/// `failed` 只由「加工结果是空的」产出；其余不通过都是 `draft`。
/// 这个区分有意义：`failed` = 这次没产出，`draft` = 产出了但还不能算成稿。
export const REGISTER = Object.freeze({
  written: 'written',
  draft: 'draft',
  failed: 'failed',
});

/// **归一化**：去掉全部空白与句读，只留下字。
///
/// 用它判「与口述相同」的理由：重新断句、加标点**不是**加工 ——
/// 拿原文只加逗号交回来，仍然是照抄。所以比较必须忽略标点与空白。
export function normalizeLectureText(s) {
  return String(s ?? '')
    .replace(/\s+/gu, '')
    .replace(/[，。！？、；：,.!?;；]/gu, '');
}

function same(source, rewritten) {
  const a = normalizeLectureText(source);
  return a === normalizeLectureText(rewritten) && a.length > 0;
}

/// 末尾是不是虚词/标点 —— 那是**被切断的正文**（「内存采用随机寻址的」）。
function incomplete(s) {
  const t = String(s ?? '').trim();
  if (t.length === 0) return true;
  const bad = '的了啊呢吧吗呃呀哇，、：';
  return bad.includes(t[t.length - 1]);
}

/// 对照口述，判断整理稿能不能标成已成稿。
///
/// 返回 `{ register, notes }`：`notes` 是**如实告警**（每一条都指名了判据），
/// 空数组 = 全部通过。notes 非空时 `register` 一律不是 `written`。
export function judgeWritten({ source, rewritten } = {}) {
  const dst = String(rewritten ?? '').trim();
  if (dst.length === 0) {
    return { register: REGISTER.failed, notes: ['加工结果是空的'] };
  }
  const notes = [];
  if (same(source, dst)) notes.push('与口述相同');
  for (const mark of kClassroomMarks) {
    if (dst.includes(mark)) notes.push(`含课堂称呼「${mark}」`);
  }
  if (incomplete(dst)) notes.push('有说半截的句子');
  if (notes.length === 0) return { register: REGISTER.written, notes: [] };
  return { register: REGISTER.draft, notes };
}
