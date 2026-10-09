import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Empty, Icon, Mark, useStore } from 'dsh-zhiyun-ui-primitives';
import { NAV, activePage, matchingPages, beijingDate } from './model.js';

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(timer); }, []);
  return now;
}

export function SearchDialog({ controller, open, onClose }) {
  const dialog = useRef(null);
  const [query, setQuery] = useState('');
  const items = matchingPages(query);
  useEffect(() => {
    if (open) { setQuery(''); dialog.current.showModal(); }
    else if (dialog.current.open) dialog.current.close();
  }, [open]);
  return <dialog className="zy-search-dialog" ref={dialog} aria-label="跳转到" onCancel={onClose} onClose={onClose} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <form method="dialog" onSubmit={event => { event.preventDefault(); if (items[0]) { controller.navigate(items[0].id); onClose(); } }}>
      <div className="zy-search-input"><Icon name="search"/><input aria-label="搜索页面" placeholder="想去哪里？" value={query} onChange={event => setQuery(event.target.value)} autoFocus/><button type="button" onClick={onClose} aria-label="关闭跳转"><kbd>Esc</kbd></button></div>
      <div className="zy-search-results">{items.length ? items.map(item => <button type="button" key={item.id} onClick={() => { controller.navigate(item.id); onClose(); }}><Icon name={item.icon}/><span>{item.label}<small>{item.hint}</small></span><Icon name="arrow" size={16}/></button>) : <p>没有找到这个页面</p>}</div>
    </form>
  </dialog>;
}

export function Sidebar({ collapsed, controller, renderSlot, usePanelInfo }) {
  const active = activePage(usePanelInfo(info => info.activePanelId));
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    function key(event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(value => !value); }
    }
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  return <aside className={`zy-sidebar${collapsed ? ' zy-collapsed' : ''}`} aria-label="智云主导航">
    <button className="zy-brand" title="智云 Pro · 今天" aria-label="智云 Pro · 今天" onClick={() => controller.navigate('today')}><Mark compact={collapsed}/>{!collapsed && <span>智云</span>}</button>
    <button className="zy-search-button" onClick={() => setSearchOpen(true)} title="跳转 Ctrl+K"><Icon name="search"/>{!collapsed && <><span>跳转到…</span><kbd>Ctrl K</kbd></>}</button>
    <nav className="zy-nav" aria-label="主要页面">{NAV.map(item => <button key={item.id} className={active === item.id ? 'is-active' : ''} aria-current={active === item.id ? 'page' : undefined} aria-label={item.label} title={item.label} onClick={() => controller.navigate(item.id)}><Icon name={item.icon}/>{!collapsed && <span>{item.label}</span>}</button>)}</nav>
    {!collapsed && <div className="zy-sidebar-middle">
      <div className="zy-divider"/>
      {/* 会话管理不在侧栏：它属于「问一问」的版面（见 SessionHeader）。侧栏只留一句心情。 */}
      <p className="zy-sidebar-note">学习中的每个问题，<br/>都值得留下答案。</p>
      <div className="zy-extension-actions">{renderSlot('sidebar.footer.action', { wide: true })}</div>
    </div>}
    <div className="zy-sidebar-bottom">
      <div className="zy-settings-host">{renderSlot('sidebar.settings', { wide: !collapsed })}</div>
      <button className="zy-collapse" onClick={controller.toggleSidebar} title={collapsed ? '展开导航' : '收起导航'} aria-label={collapsed ? '展开导航' : '收起导航'}><Icon name="collapse"/>{!collapsed && <span>收起导航</span>}</button>
      {!collapsed && <div className="zy-profile-label"><span/>独立学习空间 <small>{__ZHIYUN_PROFILE__}</small></div>}
    </div>
    <SearchDialog controller={controller} open={searchOpen} onClose={() => setSearchOpen(false)}/>
  </aside>;
}

/** Keep the native shell alive for onboarding, recovery and shortcuts; its
 * section renderers move into Personal without copying their forms or data. */
export function PersonalSettingsBridge(props) {
  const { NativeSettings, useSections, renderSlot, actions, controller } = props;
  const sections = useSections(rows => rows);
  const shell = props.useStore(state => state);
  const [target, setTarget] = useState(null);
  useEffect(() => {
    const find = () => setTarget(document.getElementById('zy-personal-settings'));
    find();
    const observer = new MutationObserver(find);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!shell.open) return;
    controller.navigate('me');
    actions.close();
  }, [shell.open, controller, actions]);
  return <><NativeSettings {...props}/>{target && createPortal(<div className="zy-settings-groups">{sections.map(section => <details className="zy-settings-group" key={section.id} data-settings-section={section.id}>
    <summary><span className="zy-settings-icon"><Icon name={/model|provider|agent/.test(section.id) ? 'chat' : /permission/.test(section.id) ? 'check' : /plugin|module/.test(section.id) ? 'layers' : 'user'}/></span><span><strong>{section.id === 'models' ? 'AI 服务' : section.id === 'plugins' ? '功能与插件' : section.id === 'agent-presets' ? 'AI 使用偏好' : section.label}</strong><small>{/model|provider/.test(section.id) ? '配置问一问使用的 AI 服务' : /permission/.test(section.id) ? '管理 AI 可以执行的操作' : /plugin|module/.test(section.id) ? '管理学习空间的扩展能力' : /agent/.test(section.id) ? '选择模型、工具与权限的组合' : '调整应用与使用偏好'}</small></span><Icon name="chevron" size={16}/></summary>
    <div className="zy-settings-body">{renderSlot('settings.section', { close: actions.close }, { only: section.id })}{section.id === 'general' && <div className="zy-settings-document">{renderSlot('settings.action', {})}</div>}</div>
  </details>)}</div>, target)}</>;
}
export function Page({ page, controller, renderSlot }) {
  const now = useClock();
  const item = NAV.find(item => item.id === page);
  // 页面内容由各自的页面包注册进 `zhiyun.<page>.content`。壳不认识它们，
  // 所以这里的 fallback 不是「页面」而是「这个页面包没装」的占位 ——
  // 壳在场时导航、页头、主题都照常可用。
  const missing = () => <Empty title={`${item.label}暂时不可用`}>这个页面由独立的插件包提供，当前未启用。</Empty>;
  // 页面契约仍由壳定义：`controller`（导航/主题）与 `renderSlot`（渲染它自己的子插槽，
  // 比如个人页里的 `zhiyun.me.account`）作为 owner props 交给页面组件 ——
  // owner props 在宿主渲染顺序里最后展开，页面不必知道这些服务从哪来。
  return <div className="zy-page" data-page={page}>
    <header className="zy-page-header"><strong>{item.label}</strong><span className="zy-header-date">{beijingDate(now)}</span><div className="zy-header-actions"><button aria-label="切换明暗" title="切换明暗" onClick={controller.toggleTheme}><Icon name="moon" size={18}/></button><button className="zy-ask-button" onClick={() => controller.navigate('ask')}><Icon name="chat" size={17}/>问一问</button></div></header>
    <main className="zy-scroll"><div className="zy-content">{renderSlot(`zhiyun.${page}.content`, { controller, renderSlot }, { fallback: React.createElement(missing) })}</div></main>
  </div>;
}

/**
 * 「问一问」面板的盒子：侧栏右边那一列（宿主的中间栏）。
 * 汉堡和抽屉都锚在它的左上角，而不是视口的左上角 —— Windows 标题栏会把这一列往下推，
 * 锚在视口上按钮就会漂进标题栏。
 */
function useAskPanelBox() {
  const [box, setBox] = useState({ left: 0, top: 0, width: 0, height: 0, radius: '0px' });
  useLayoutEffect(() => {
    const measure = () => {
      const sidebar = document.querySelector('.zy-sidebar');
      // 侧栏根节点外面可能还有插槽包一层。顺着父级走到网格那一格，它的下一个兄弟才是问一问所在的中间栏。
      let column = sidebar;
      while (column?.parentElement && getComputedStyle(column.parentElement).display !== 'grid') column = column.parentElement;
      const panel = column?.nextElementSibling ?? sidebar?.parentElement?.nextElementSibling;
      if (!(panel instanceof HTMLElement)) {
        const edge = sidebar ? Math.round(sidebar.getBoundingClientRect().right) : 0;
        setBox({ left: edge, top: 0, width: Math.max(0, window.innerWidth - edge), height: window.innerHeight, radius: '0px' });
        return;
      }
      const rect = panel.getBoundingClientRect();
      setBox({
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        radius: getComputedStyle(panel).borderTopLeftRadius || '0px',
      });
    };
    measure();
    const sidebar = document.querySelector('.zy-sidebar');
    let column = sidebar;
    while (column?.parentElement && getComputedStyle(column.parentElement).display !== 'grid') column = column.parentElement;
    const panel = column?.nextElementSibling;
    const observer = new ResizeObserver(measure);
    if (sidebar) observer.observe(sidebar);
    if (column instanceof HTMLElement && column !== sidebar) observer.observe(column);
    if (panel instanceof HTMLElement) observer.observe(panel);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  return box;
}

/** 当前会话：0.2 里「主面板在看哪个会话」由 uiWorkspace.selection 持久化。 */
function useCurrentSession(uiWorkspace, sessions) {
  const sessionId = useSyncExternalStore(
    listener => uiWorkspace.selection?.subscribe(listener) ?? (() => {}),
    () => uiWorkspace.selection?.getSnapshot?.()?.sessionId,
    () => undefined,
  );
  const sessionList = useStore(sessions.list);
  const summary = sessionId === undefined ? undefined : sessionList.byId?.[sessionId];
  return { sessionId, title: summary === undefined || summary.blank === true ? '' : (summary.displayTitle ?? '') };
}

/**
 * 问一问会话头的 leading：跟会话名排在同一行，标题在它右边，不再盖住名字。
 * 挂在宿主的 `conversation.header.leading`（这一列在会话名之前，问一问才挂载）。
 */
export function AskMenuButton({ drawer }) {
  const open = useSyncExternalStore(drawer.subscribe, drawer.getSnapshot, drawer.getSnapshot);
  return <button type="button" className="zy-topbar zy-topbar-menu" aria-expanded={open} aria-controls="zy-session-drawer" aria-label="会话" title="会话" onClick={() => drawer.toggle()}><span className="zy-topbar-glyph"><Icon name="menu" size={18}/></span></button>;
}

/**
 * 会话抽屉挂在 `shell.overlay`，只在问一问显示。开关是会话头里的 {@link AskMenuButton}。
 */
export function AskChrome({ drawer, sessions, workspaces, uiWorkspace, usePanelInfo, getLearningSpace }) {
  const active = activePage(usePanelInfo(info => info.activePanelId));
  const box = useAskPanelBox();
  const open = useSyncExternalStore(drawer.subscribe, drawer.getSnapshot, drawer.getSnapshot);
  if (active !== 'ask') return null;
  return <SessionDrawer open={open} box={box} drawer={drawer} sessions={sessions} workspaces={workspaces} uiWorkspace={uiWorkspace} getLearningSpace={getLearningSpace}/>;
}

/**
 * 会话抽屉：贴着问一问面板的左缘，拉出这一列的整高。
 *
 * 顶栏是「会话」和新建。遮罩只盖这一列，滑出动画也被这一列裁住，不会扫过导航栏。
 * 开关不浮在这一层上：它在会话头的 leading 里，和会话名并排。
 *
 * 说明位置放的是相对时间而不是「N 条消息」（宿主的列表投影没有条数）。
 * 菜单是「归档」：宿主没有删除接口，归档会把这条从列表里拿掉（登记槽还在，设置里可以恢复）。
 * 正在看的那条被归档后，不要马上再开一条空白会话，否则只是历史没了、壳还在。
 */
export function SessionDrawer({ open, box, sessions, workspaces, uiWorkspace, drawer, getLearningSpace }) {
  const [menu, setMenu] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const drawerRef = useRef(null);
  const sessionList = useStore(sessions.list);
  const workspaceList = useStore(workspaces.list);
  const { sessionId } = useCurrentSession(uiWorkspace, sessions);
  useEffect(() => {
    if (!open) { setMenu(null); setRenaming(null); setError(''); return; }
    const onKey = event => { if (event.key === 'Escape') { if (menu) setMenu(null); else drawer.close(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, menu, drawer]);
  useEffect(() => {
    if (!menu) return;
    const onPointer = event => {
      const target = event.target;
      if (target instanceof Element && target.closest('.zy-drawer-menu, .zy-drawer-more')) return;
      setMenu(null);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [menu]);
  // 所有 hook 都在此之上；下面只做纯计算，早期 return 不再改变 hook 数量。
  // 「哪个工作区是这个学习空间」由领域状态包（dsh-zhiyun-study-core）回答：
  // 它没有激活时这里拿不到服务，抽屉就只显示空列表 —— 导航与页面都还在。
  const learningSpace = getLearningSpace?.();
  const space = learningSpace?.pickLearningWorkspace(workspaceList.items, learningSpace.title);
  if (space === undefined || box.height === 0) return null;
  const rows = learningSpace.sessionRows(space, sessionList, 60, workspaceList.archivedSessionIds);
  const menuRow = menu === null ? undefined : rows.find(row => row.id === menu.id);
  const startNew = () => { setError(''); drawer.close(); uiWorkspace.startSession(space.workspaceId); };
  const openSession = id => { setError(''); drawer.close(); uiWorkspace.openSession(id); };
  const archiveRow = id => {
    setMenu(null);
    const current = String(id) === String(sessionId);
    if (current) drawer.holdEmptySession();
    Promise.resolve(uiWorkspace.archiveSession(id)).catch(() => {
      if (current) drawer.releaseEmptySession();
      setError('归档失败');
    });
  };
  const commitRename = async id => {
    const title = draft.trim();
    setRenaming(null);
    const binding = sessions.binding(id);
    if (binding === undefined || title === '') return;
    const result = await binding.session.rename(title);
    if (result !== undefined && result.ok === false) setError(result.error?.message ?? '重命名失败');
  };
  const toggleMenu = (event, id) => {
    if (menu?.id === id) { setMenu(null); return; }
    const button = event.currentTarget.getBoundingClientRect();
    const host = drawerRef.current?.getBoundingClientRect();
    if (!host) return;
    const width = 148;
    const height = 84;
    const top = host.bottom - button.bottom < height + 8 ? button.top - host.top - height - 4 : button.bottom - host.top + 4;
    const left = Math.min(Math.max(8, button.right - host.left - width), Math.max(8, host.width - width - 8));
    setMenu({ id, top, left });
  };
  return <div className="zy-drawer-layer" data-open={open} style={{ left: box.left, top: box.top, width: box.width, height: box.height, borderTopLeftRadius: box.radius }}>
    <div className="zy-drawer-scrim" data-open={open} onClick={() => drawer.close()}/>
    <aside className="zy-drawer" id="zy-session-drawer" ref={drawerRef} data-open={open} aria-hidden={!open} aria-label="会话">
      <header className="zy-drawer-head">
        <strong>会话</strong>
        <button className="zy-drawer-add" title="新建会话" aria-label="新建会话" onClick={startNew}><Icon name="plus" size={18}/></button>
      </header>
      <div className="zy-drawer-list" role="list" onScroll={() => setMenu(null)}>
        {error && <p className="zy-drawer-error" role="alert">{error}</p>}
        {rows.length === 0 && <div className="zy-drawer-empty"><Icon name="chat" size={22}/><p>还没有会话</p></div>}
        {rows.map(row => <div key={row.id} role="listitem" className={`zy-drawer-row${String(row.id) === String(sessionId) ? ' is-current' : ''}`}>
          {renaming === row.id
            ? <input className="zy-drawer-input" autoFocus aria-label="会话名称" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') commitRename(row.id); if (event.key === 'Escape') setRenaming(null); }} onBlur={() => commitRename(row.id)}/>
            : <button className="zy-drawer-open" title={row.title || '新会话'} onClick={() => openSession(row.id)}>
                <Icon name="chat" size={18}/>
                <span className="zy-drawer-text">
                  <span className={`zy-drawer-name${row.title ? '' : ' is-blank'}`}>{row.title || '新会话'}</span>
                  <small className="zy-drawer-meta">{learningSpace.relativeLabel(row.updatedAt) || '暂无消息'}</small>
                </span>
              </button>}
          <button className="zy-drawer-more" type="button" aria-expanded={menu?.id === row.id} aria-haspopup="menu" title="更多" aria-label="更多操作" onClick={event => toggleMenu(event, row.id)}><Icon name="more" size={16}/></button>
        </div>)}
      </div>
      {menuRow && <div className="zy-drawer-menu" style={{ top: menu.top, left: menu.left }} role="menu">
        {sessions.binding(menuRow.id) !== undefined && <button type="button" role="menuitem" onClick={() => { setMenu(null); setRenaming(menuRow.id); setDraft(menuRow.title); }}>重命名</button>}
        <button type="button" role="menuitem" className="is-danger" onClick={() => archiveRow(menuRow.id)}>归档</button>
      </div>}
    </aside>
  </div>;
}


