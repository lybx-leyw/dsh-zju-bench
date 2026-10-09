/// 讲义装配的具名失败。
///
/// # 为什么要有 code
///
/// 本包对外只有三个入口（建树 / 验收 / 填充），它们的失败**性质完全不同**：
/// 输入不合法（INPUT）、没注入模型（CONFIG）、被取消（CANCELLED）、
/// 加工器已释放（DISPOSED）、模型回包无法解析（PARSE）。
/// 集成的上层要靠 code 决定「重试 / 报配置 / 静默丢弃」，
/// 靠 message 猜是猜不准的 —— 而猜错的代价是重试一个永远失败的调用。
export class LectureError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LectureError';
    this.code = code;
    this.details = details;
  }
}
