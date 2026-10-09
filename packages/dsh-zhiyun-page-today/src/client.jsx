// 「今天」页：日程、插空任务与最近进度的落点。
//
// 现在页面上还没有课程与计划的数据源，所以这里呈现的是**空状态**骨架；
// 后续要在这一页加日历组件、计划创建组件时，它们属于本包，而不是壳。
import React from 'react';
import { Icon, SectionTitle } from 'dsh-zhiyun-ui-primitives';

export const name = 'zhiyun-page-today-client';
/**
 * 只依赖 `slots`（注册页面内容必需）。
 *
 * 导航控制器由壳在 `renderSlot` 的 owner 参数里交过来（见 dsh-zhiyun-shell 的 Page）——
 * 页面包与壳之间因此只有「壳声明插槽、页面填内容」一条边，页面不认识任何具体服务名。
 */
export const inject = ['slots'];
export function apply(ctx) {
  ctx.slots.inject('zhiyun.today.content', () => ctx.slots.register({ name: 'zhiyun.today.content' }, Today));
}

export function Today({ controller }) {
  return <>
    <div className="zy-intro"><div><span className="zy-eyebrow">一点一滴，学有所获</span><h1>今天，从容开始。</h1><p>看看接下来的安排，留一点时间给自己。</p></div><span className="zy-date-icon"><Icon name="sun" size={42}/></span></div>
    <SectionTitle>今天的安排</SectionTitle>
    <section className="zy-now"><span className="zy-pill"><span/>现在</span><h2>给今天留一点空白</h2><p>今天的课程与计划还没有接入，暂时无法判断空闲时间。</p><button className="zy-text-button" onClick={() => controller.navigate('ask')}>先聊聊今天想学什么 <Icon name="arrow" size={16}/></button></section>
    <div className="zy-agenda-grid">
      <section><SectionTitle aside="按时间先后">接下来</SectionTitle><div className="zy-empty-row"><Icon name="calendar"/><div><strong>固定时间的安排</strong><p>课程和定时计划会显示在这里</p></div></div></section>
      <section><SectionTitle aside="按空闲时间处理">插空完成</SectionTitle><div className="zy-empty-row"><Icon name="check"/><div><strong>留给空档的小任务</strong><p>没有固定时间的任务放在这里</p></div></div></section>
    </div>
    <SectionTitle aside="接着上次的进度">最近在看</SectionTitle>
    <div className="zy-resume"><span className="zy-book-cover"><Icon name="book" size={26}/></span><div><h3>下一次打开，从上次继续</h3><p>课程接入后，你最近学习的内容会留在这里。</p></div><button className="zy-secondary" onClick={() => controller.navigate('courses')}>我的课 <Icon name="arrow" size={15}/></button></div>
    <div className="zy-quiet-footer">不必一次学完所有，今天也可以只前进一步。</div>
  </>;
}
