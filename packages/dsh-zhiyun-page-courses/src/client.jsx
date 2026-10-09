// 「我的课」页：课程网格 + 未登录提示。
//
// 数据来自领域状态包（dsh-zhiyun-study-core 提供的 `zhiyunStudyController`），
// 本包只负责这一页长什么样、点了之后去哪。
import React, { useState } from 'react';
import { Notice, mountStyle, useStudy } from 'dsh-zhiyun-ui-primitives';
import css from './style.css';

export const name = 'zhiyun-page-courses-client';
export const inject = ['slots'];
export function apply(ctx) {
  // 样式随本包生命周期装卸。
  mountStyle(ctx, { attribute: 'zhiyunCoursesStyle', css, label: 'zhiyun: courses page styles' });
  // 惰性取数据服务：停用领域状态包时这一页只是空着（壳显示占位），不会像硬 inject
  // 那样把整个前端拖成 pending（`web boot: N entries did not activate`）。
  ctx.inject(['zhiyunStudyController'], (scope) => {
    // priority 10：外部扩展（如测试提供方）用 0 就能遮蔽这一页。
    scope.slots.inject('zhiyun.courses.content', () => scope.slots.register(
      { name: 'zhiyun.courses.content', priority: 10 },
      () => <Courses controller={scope.zhiyunStudyController} />,
    ));
  });
}

export function SignIn({ controller }) {
  return <div className="zs-empty"><span className="zs-empty-title">连接你的课堂</span><p>登录浙大账号，把课程、课件和课堂字幕带到学习空间。</p><button className="zs-primary" onClick={() => controller.navigate("me")}>前往个人面板登录</button></div>;
}

export function Courses({ controller }) {
  const s = useStudy(controller), [query, setQuery] = useState("");
  return <section className="zs-courses"><header className="zs-heading"><div><small>课程 · 回放 · 资料</small><h1>我的课</h1><p>把一门课的内容，安放在一起。</p></div><button className="zs-button" disabled={s.loading || s.busy} onClick={() => controller.refresh()}>刷新课程</button></header><Notice>{s.error}</Notice>{s.loading ? <p className="zs-muted">正在读取课程…</p> : !s.user ? <SignIn controller={controller} /> : <><label className="zs-search">查找课程<input type="search" placeholder="课程名称、教师" value={query} onChange={(e) => setQuery(e.target.value)} /></label>{s.coursesMeta?.complete !== true && <Notice>课程列表尚未确认收全，可刷新重试。</Notice>}<div className="zs-course-grid">{s.courses.filter((c) => `${c.title} ${c.teacher ?? ""}`.includes(query)).map((c) => <button className="zs-course" key={c.id} onClick={() => {
    void controller.selectCourse(c);
    controller.navigate("study");
  }}><span className="zs-course-code">{c.termName ?? "智云课堂"}</span><h2>{c.title}</h2><p>{c.teacher ?? "教师信息未提供"}</p><footer><span>{c.totalCount ? `${c.totalCount} 节课程` : "查看节次"}</span><span>进入学习 →</span></footer></button>)}</div>{!s.courses.length && <p className="zs-muted">这个账号暂时没有课程。</p>}</>}</section>;
}
