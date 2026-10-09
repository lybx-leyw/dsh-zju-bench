// 「个人」页：账号登录、空间与偏好、宿主设置面板的落点。
//
// `zs-account` 区块（登录表单 / 已连接状态）原来住在 study 包里，但它是**个人页**的
// 内容 —— 页面包拥有自己页面上的一切，于是它跟着这一页搬过来。
import React, { useState } from 'react';
import { Icon, Mark, Notice, SectionTitle, mountStyle, useStudy } from 'dsh-zhiyun-ui-primitives';
import css from './style.css';

export const name = 'zhiyun-page-me-client';
export const inject = ['slots'];
export function apply(ctx) {
  mountStyle(ctx, { attribute: 'zhiyunMeStyle', css, label: 'zhiyun: me page styles' });
  // 账号区块是这一页的一部分，但它读的是领域状态；服务缺失时只显示占位。
  ctx.inject(['zhiyunStudyController'], (scope) => {
    scope.slots.inject('zhiyun.me.account', () => scope.slots.register(
      { name: 'zhiyun.me.account' },
      () => <Account controller={scope.zhiyunStudyController} />,
    ));
  });
  ctx.slots.inject('zhiyun.me.content', () => ctx.slots.register({ name: 'zhiyun.me.content' }, Personal));
}

export function Account({ controller }) {
  const s = useStudy(controller), [username, setUsername] = useState(""), [password, setPassword] = useState("");
  return <section className="zs-account" aria-label="智云课堂账号"><div><h2>智云课堂</h2><p>{s.user ? `已连接 · ${s.user.name ?? s.user.id}` : "使用浙大统一身份认证账号连接课堂"}</p></div>{s.loading ? <p>正在读取账号状态…</p> : s.user ? <button className="zs-button" disabled={s.busy} onClick={() => controller.logout()}>退出课堂账号</button> : <form onSubmit={(e) => {
    e.preventDefault();
    const credentials = { username, password };
    setPassword("");
    void controller.authenticate(credentials);
  }}><label>浙大账号<input name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label><label>密码<input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label><button className="zs-primary" disabled={s.busy}>{s.busy ? "正在登录…" : "连接课堂"}</button></form>}<Notice>{s.error}</Notice></section>;
}

/** 页面正文。`renderSlot` 由壳在 main 面板的 owner 参数里交过来（本页要嵌账号区块）。 */
export function Personal({ controller, renderSlot }) {
  return <><div className="zy-intro"><div><span className="zy-eyebrow">按自己的节奏</span><h1>个人</h1><p>你的偏好、AI 服务与学习空间，都在这里。</p></div><Icon name="user" size={38}/></div><div className="zy-person-card"><Mark large/><div><h2>我的学习空间</h2><p>让每一次学习，都更合心意。</p></div><span className="zy-tag">本地独立空间</span></div>{renderSlot('zhiyun.me.account', {})}<SectionTitle>空间与偏好</SectionTitle><div className="zy-card zy-preferences"><div><span><strong>明暗外观</strong><small>调整阅读时的光线与氛围</small></span><button className="zy-secondary" onClick={controller.toggleTheme}><Icon name="moon" size={16}/>切换明暗</button></div></div><div id="zy-personal-settings" aria-label="个人设置"/><p className="zy-personal-note">按需展开设置，留更多空间给学习。</p></>;
}
