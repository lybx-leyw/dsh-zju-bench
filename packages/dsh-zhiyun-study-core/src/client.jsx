// 领域状态包的客户端半边：把学习控制器挂成 Cordis 服务，给三个页面包共用。
//
// 为什么状态住在包外而不是页面里：账号、课程树、解析任务的寿命必须长过页面切换
// （离开「学习」再回来，展开的课程、正在跑的解析都该还在），而「我的课」「学习」
// 「个人」读的是同一份数据 —— 谁渲染谁持有状态，就会变成三份互相打架的状态。
import { createStudyController } from './model.js';
import { LEARNING_SPACE_TITLE, pickLearningWorkspace, sessionRows, relativeLabel } from './learning-space.js';

export const name = 'zhiyun-study-core-client';
/**
 * 只声明宿主的连接服务。
 *
 * 导航（`zhiyunNavigation`）由壳提供，这里**故意不写进 inject**：写进去以后
 * 「停用壳」会连坐把数据层一起拖成 pending，整个前端启动失败（`web boot: N entries
 * did not activate`）；而导航只在用户点「进入学习」的那一刻才用到，晚一点取没有代价。
 */
export const inject = ['connection'];
export function apply(ctx) {
  const navigation = { navigate: (page) => ctx.get('zhiyunNavigation')?.navigate(page) };
  const controller = createStudyController(async (method, payload, signal) => {
    const result = await ctx.connection.rpc.call('/api', 'zhiyun-study', { method, args: payload }, signal);
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.value;
  }, navigation);
  ctx.effect(() => ctx.reflect.provide('zhiyunStudyController', controller), 'zhiyun: study controller service');
  // 会话抽屉要按「这个固定学习空间」筛会话，所以把「认出学习空间」这件事作为服务交给壳。
  // 走服务而不是让壳 require 本包的 bundle：停用本包时壳只是列不出会话，
  // 不会因为 require 落空而把整个前端拖垮。标题字面量也只留在这里一份。
  ctx.effect(() => ctx.reflect.provide('zhiyunLearningSpace', {
    title: LEARNING_SPACE_TITLE,
    pickLearningWorkspace,
    sessionRows,
    relativeLabel,
  }), 'zhiyun: learning space service');
  ctx.effect(() => () => controller.dispose(), 'zhiyun: study controller lifetime');
  void controller.refresh();
}
