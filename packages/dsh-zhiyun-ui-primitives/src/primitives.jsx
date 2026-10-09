// 共享 UI 原语：无状态、纯展示，被壳与各页面包共同引用。
//
// 这里**没有**领域状态：账号、课程、解析任务属于 dsh-zhiyun-study-core，
// 通过 Cordis 服务传递（见下面的 useStudy）。这个包只回答「长什么样」。
import React, { useSyncExternalStore } from 'react';
import brandMark from './assets/zhiyun-mark.svg';
import compactBrandMark from './assets/zhiyun-mark-compact.svg';

const paths = {
  sun: 'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  book: 'M12 5v15M12 5C9 3 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1Z',
  chat: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 3-2Zm2 5h10M7 13h6',
  layers: 'm12 3 10 5-10 5L2 8l10-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
  search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-1 5 5 5',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  collapse: 'M8 4v16M3 4h18v16H3V4Zm14 4-4 4 4 4',
  plus: 'M12 5v14M5 12h14',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-5v5l3 2',
  moon: 'M20 14A9 9 0 0 1 10 4a9 9 0 1 0 10 10Z',
  check: 'm5 12 4 4L19 6',
  calendar: 'M7 2v4M17 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z',
  chevron: 'm9 5 7 7-7 7',
  close: 'M6 6l12 12M18 6 6 18',
  history: 'M3 12a9 9 0 1 0 2.6-6.4M3 4v5h5M12 8v4.2l3 1.8',
  menu: 'M4 7h16M4 12h16M4 17h16',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
};
export function Icon({ name, size = 19 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.book}/></svg>;
}
export function Mark({ large = false, compact = false }) {
  return <span className={`zy-mark${large ? ' zy-mark-large' : ''}${compact ? ' zy-mark-compact' : ''}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: compact ? compactBrandMark : brandMark }}/>;
}

export function Empty({ icon = 'book', title, children, action }) {
  return <div className="zy-empty"><span className="zy-empty-icon"><Icon name={icon} size={27}/></span><h3>{title}</h3><p>{children}</p>{action}</div>;
}
export function SectionTitle({ children, aside }) { return <div className="zy-section-title"><h2>{children}</h2>{aside && <span>{aside}</span>}</div>; }

/** 订阅宿主的客户端 store（快照 + 订阅就是它的全部接口）。 */
export function useStore(store) {
  return useSyncExternalStore(
    listener => store.subscribe(listener),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );
}

/** 领域状态包通过服务交出来的控制器：订阅 + 快照。 */
export const useStudy = (controller) => useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

/** 一句话的提示条；没有内容时不占位。 */
export function Notice({ children }) {
  return children ? <div className="zs-notice" role="alert">{children}</div> : null;
}

/**
 * 把一份 CSS 挂成受生命周期管理的 `<style>`。
 *
 * 每个客户端包都带来自己那份样式表，卸载时必须一起走 —— 宿主按 `data-plugin` 认领
 * 卸载时新增的 `<style>`，这里用自命名属性 + `ctx.effect` 的清理函数达到同一效果，
 * 且不依赖宿主内部实现。四个页面包都要做同一件事，所以它属于共享原语。
 */
export function mountStyle(ctx, { attribute, css, label }) {
  return ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset[attribute] = 'true';
    style.textContent = css;
    document.head.append(style);
    return () => style.remove();
  }, label);
}
