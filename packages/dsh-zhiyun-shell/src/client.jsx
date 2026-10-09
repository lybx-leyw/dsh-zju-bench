import React from 'react';
import { Sidebar, Page, AskChrome, AskMenuButton, PersonalSettingsBridge } from './components.jsx';
import { NAV, panelKey } from './model.js';
import { adaptSettingsSurface } from './settings-adapter.js';
import css from './style.css';

export const name = 'zhiyun-shell-client';
export const inject = ['slots', 'layout', 'theme', 'uiWorkspace', 'workspaces', 'sessions'];
export function apply(ctx) {
  try { return applyUI(ctx); }
  catch (error) { console.error('zhiyun UI activation:', error); throw error; }
}
function applyUI(ctx) {
  /** 当前选中的产品页；「问一问」是唯一需要自动绑工作区的那一页。 */
  let active = 'today';
  const drawer = createSessionDrawer();
  // binding 必须先于 controller 建立：controller.navigate 立刻就会用到它，
  // 而别的插件在自己的 apply 里调 zhiyunNavigation.navigate 也可能早于下面几行执行。
  const binding = createLearningSpaceBinding(ctx, () => active === 'ask', drawer);
  const controller = {
    navigate(id) {
      if (!NAV.some(item => item.id === id)) throw new Error(`Unknown Zhiyun page: ${id}`);
      active = id;
      // 抽屉属于问一问：离开这一页就交还右侧轨道。
      if (id !== 'ask') {
        drawer.close();
        binding.reset();
      }
      ctx.layout.selectPanel(id === 'ask' ? null : panelKey(id));
      if (id === 'ask') {
        drawer.releaseEmptySession();
        binding.attempt();
      }
    },
    toggleSidebar: () => ctx.layout.toggleSidebar(),
    toggleTheme: () => ctx.theme.setTheme(ctx.theme.getTheme().active.colorScheme === 'dark' ? 'light' : 'dark'),
  };
  ctx.effect(() => drawer.close, 'zhiyun: sessions drawer');
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.zhiyunStyle = 'true';
    style.textContent = css;
    document.head.append(style);
    const previous = document.body.getAttribute('data-zhiyun');
    document.body.setAttribute('data-zhiyun', 'true');
    return () => {
      style.remove();
      if (previous === null) document.body.removeAttribute('data-zhiyun');
      else document.body.setAttribute('data-zhiyun', previous);
    };
  }, 'zhiyun: owned styles');
  ctx.effect(() => ctx.reflect.provide('zhiyunNavigation', controller), 'zhiyun: navigation service');
  ctx.effect(() => ctx.theme.overrideTokens('dsh-zhiyun-shell', {
    '--dsw-alias-bg-base': { light: '#f7f7f5', dark: '#191c20' },
    '--dsw-alias-label-primary': { light: '#252a30', dark: '#e8ebee' },
    '--dsw-alias-label-secondary': { light: '#666b72', dark: '#afb6bf' },
    '--dsw-alias-button-info-fill': { light: '#00479d', dark: '#245fa9' },
    '--dsw-alias-button-info-hover': { light: '#003b83', dark: '#2b70c3' },
  }), 'zhiyun: reversible native theme layer');
  ctx.slots.inject('sidebar', () => ctx.slots.register({
    name: 'sidebar', priority: -10,
    children: {
      'sidebar.brand.mark': { kind: 'single', scope: 'root' },
      'sidebar.brand.name': { kind: 'single', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      // ⚠️ 刻意**不声明** `sidebar.workspaces`：那是宿主的多项目工作区浏览器
      //    （带工作区切换），与本工作台的单一学习空间不是一回事。不声明 = 它不挂载。
      'sidebar.settings': { kind: 'single', scope: 'root' },
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
    },
    inject: () => ({ controller }),
  }, Sidebar));
  // DSH 0.2 gives child-slot ownership exclusively to the original entry.
  // Adapt its component in place so forms retain that authorization, store,
  // onboarding and plugin registrations; restore it on bundle disposal.
  ctx.effect(() => adaptSettingsSurface(ctx.slots, NativeSettings =>
    props => <PersonalSettingsBridge {...props} controller={controller} NativeSettings={NativeSettings}/>
  ), 'zhiyun: reversible settings surface adapter');
  // 汉堡放进会话头的 leading：那一列在会话名之前，标题会自己让开。
  // 不能用固定定位盖在面板角上，否则会压住会话名（宿主标题行就从这里开始）。
  ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({
    name: 'conversation.header.leading',
    priority: -10,
    inject: () => ({ drawer }),
  }, AskMenuButton));
  // 抽屉挂在 `shell.overlay`（整层 absolute）。`shell.leading` 只在 macOS 且侧栏收起时挂载。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'zhiyun-ask-chrome',
    order: 10,
    inject: () => ({ drawer, sessions: ctx.sessions, workspaces: ctx.workspaces, uiWorkspace: ctx.uiWorkspace, getLearningSpace: () => ctx.get('zhiyunLearningSpace') }),
  }, AskChrome));
  ctx.slots.inject('main', function* () {
    for (const page of NAV.filter(page => page.id !== 'ask')) {
      yield ctx.slots.register({
        name: 'main', key: panelKey(page.id),
        children: { [`zhiyun.${page.id}.content`]: { kind: 'single', scope: 'root' }, ...(page.id === 'me' ? { 'zhiyun.me.account': { kind: 'single', scope: 'root' } } : {}) },
        inject: () => ({ controller, page: page.id }),
      }, Page);
    }
    // Startup selects Today only after all pages have been registered.
    controller.navigate('today');
  });
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark', priority: -10 }, () => <div className="zy-hero-brand"><span>海纳江河，启真厚德</span></div>));
}

/**
 * 历史会话抽屉的开合状态。
 *
 * 抽屉渲染在「问一问」面板上（见 components.jsx 的 AskChrome）：会话头 leading 里的汉堡
 * 点开后，从面板左缘拉出整高抽屉。不是宿主右栏。
 *
 * 为什么不用宿主布局的右侧轨道（`ctx.layout.openRightbar`）：
 * 那条轨道归宿主的右栏插件（文档/文件/终端分页）所有，它的呈现同步会把轨道关回去，
 * 我们打开会被立刻关掉；而停用那个插件又会让 9 个客户端插件（chat/skill/plan/…）
 * 因缺少 `sidebarRight` 服务而无法激活，整个前端起不来（实测）。
 * 所以我们不去抢那条轨道。
 */
function createSessionDrawer() {
  let shown = false;
  // 用户刚归档了正在看的那条：先别自动补一条新壳。补上的话，历史清了，列表里还是有一条会话。
  let skipAutoSession = false;
  const listeners = new Set();
  const emit = () => { for (const listener of listeners) listener(); };
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => shown,
    toggle() { shown = !shown; emit(); },
    close() { if (!shown) return; shown = false; emit(); },
    holdEmptySession() { skipAutoSession = true; },
    releaseEmptySession() { skipAutoSession = false; },
    shouldSkipAutoSession: () => skipAutoSession,
  };
}

/**
 * 「问一问」固定绑到本工作台的学习空间。
 *
 * 只有三个条件同时成立才动作：这一页正是问一问、当前没有已打开的会话、
 * 工作区列表里能**确定地**认出学习空间（见 `pickLearningWorkspace`）。
 *
 * 为什么不怕攒出一堆空会话：宿主的 `connectWorkspace` 会先找该目录下已有的空白会话
 * 并复用它，只在一条都没有时才新建。已经打开的会话绝不顶掉 —— 这里只填「什么都没有」的空档。
 * 抽屉刚归档了正在看的那条时先停一下：这时候补一条，历史清了，列表里马上又有壳。
 * 再次进入问一问会放开，仍按原来的规则填空档。
 *
 * ⚠️「当前有没有会话」在 0.2 不能读 `sessions.list.getSnapshot().current`：
 *    那个字段已经不存在了（旧版有），读它恒为 undefined ⇒ 每次进问一问都重新绑一次。
 *    现在读宿主自己持久化的「主面板在看哪个会话」（`uiWorkspace.selection`，
 *    也就是 localStorage 里的 `dsh.sessions.current`）。取不到就当作没有，
 *    退回原来的行为（不会更糟）；`?.` 保证宿主哪天换形状也不会把插件带崩。
 */
function createLearningSpaceBinding(ctx, isAskActive, drawer) {
  let pending = false;
  const openSessionId = () => ctx.uiWorkspace?.selection?.getSnapshot?.()?.sessionId;
  const attempt = () => {
    if (pending || !isAskActive() || drawer.shouldSkipAutoSession()) return;
    const workspace = ctx.workspaces.list.getSnapshot();
    const session = ctx.sessions.list.getSnapshot();
    if (workspace.phase !== 'ready' || session.phase !== 'ready') return;
    if (openSessionId() !== undefined) return;
    // 学习空间的定义（标题、怎么认）归领域状态包，壳按服务取，不复制第二份字面量。
    const learningSpace = ctx.get('zhiyunLearningSpace');
    const target = learningSpace?.pickLearningWorkspace(workspace.items, learningSpace.title);
    if (target === undefined) return;
    // 挂起一直留到主面板真的打开一条会话。列表一更新就放开的话，下一次 attempt
    // 会把这次还没走完的导航取消掉，然后自己再来一次，空档里会打成循环。
    pending = true;
    ctx.uiWorkspace.startSession(target.workspaceId);
  };
  ctx.effect(() => {
    const selection = ctx.uiWorkspace?.selection;
    if (selection == null || typeof selection.subscribe !== 'function') return undefined;
    return selection.subscribe(() => {
      if (openSessionId() !== undefined) pending = false;
    });
  }, 'zhiyun: bind learning space (selection)');
  ctx.effect(() => ctx.workspaces.list.subscribe(attempt), 'zhiyun: bind learning space (workspaces)');
  ctx.effect(() => ctx.sessions.list.subscribe(attempt), 'zhiyun: bind learning space (sessions)');
  return {
    attempt,
    reset() { pending = false; },
  };
}
