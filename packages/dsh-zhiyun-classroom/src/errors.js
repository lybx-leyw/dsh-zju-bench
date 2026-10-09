export class ClassroomError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ClassroomError';
    this.code = code;
    // Details must be constructed from safe metadata, never raw response/body/URL.
    this.details = details;
  }
  toJSON() { return { code: this.code, message: this.message, details: this.details }; }
}
export function shape(label, field) {
  return new ClassroomError('API_SHAPE', `${label}返回结构异常：${field}`);
}
export function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function array(value, label, field) {
  if (!Array.isArray(value)) throw shape(label, field);
  return value;
}
