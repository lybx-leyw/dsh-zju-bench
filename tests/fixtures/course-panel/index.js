export const inject = ['zhiyunClassroom', 'zhiyunParser', 'zhiyunLecture', 'zhiyunFinalPass', 'zhiyunQuiz', 'zhiyunNotes', 'zhiyunKnowledge'];
export async function apply(ctx) {
  const source = ctx.zhiyunClassroom;
  if (!source || await source.getCurrentUser() !== null) throw new Error('Fresh host profile must expose an unauthenticated classroom service');
  console.log('ZHIYUN_CLASSROOM_HOST_READY');
  if (typeof ctx.zhiyunParser?.parseClassroom !== 'function') throw new Error('Parser must be injected by the product profile');
  console.log('ZHIYUN_PARSER_HOST_READY');
  // 两个新插件也必须**在真实宿主里激活过**才算装上：单元测试用的是假 ctx，
  // 而「inject 了一个不存在的服务」只有在真宿主里才会表现为永远 pending。
  if (typeof ctx.zhiyunLecture?.assemble !== 'function') throw new Error('Lecture assembler must be injected by the product profile');
  console.log('ZHIYUN_LECTURE_HOST_READY');
  if (typeof ctx.zhiyunFinalPass?.run !== 'function') throw new Error('Final-pass agent service must be injected by the product profile');
  console.log('ZHIYUN_FINAL_PASS_HOST_READY');
  // 断言各自**真实存在**的表面：quiz 的 `reviewQueue` 是 getter（返回数组），
  // 对它做 typeof === 'function' 会误报未接入。
  if (typeof ctx.zhiyunQuiz?.generate !== 'function' || typeof ctx.zhiyunQuiz?.store !== 'object') throw new Error('Quiz service must be injected by the product profile');
  if (typeof ctx.zhiyunNotes?.getOrEmpty !== 'function') throw new Error('Notes service must be injected by the product profile');
  if (typeof ctx.zhiyunKnowledge?.put !== 'function') throw new Error('Knowledge store must be injected by the product profile');
  console.log('ZHIYUN_STORE_HOST_READY');
}
