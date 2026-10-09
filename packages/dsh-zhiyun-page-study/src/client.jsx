// 「学习」页：学习工作台（课程树 / 讲义 / 字幕 / 终稿 / 检索 / 解析模型选择）。
//
// 领域状态（取数、任务、持久化）在 dsh-zhiyun-study-core 提供的 `zhiyunStudyController`
// 服务里；本包只负责渲染与交互，以及「这一页特有的检索与格式化」。
import React, { useState } from 'react';
import { Notice, mountStyle } from 'dsh-zhiyun-ui-primitives';
import { StudyWorkspace } from './study-workspace.jsx';
import css from './style.css';

export const name = 'zhiyun-page-study-client';
export const inject = ['slots'];
export function apply(ctx) {
  mountStyle(ctx, { attribute: 'zhiyunStudyStyle', css, label: 'zhiyun: study page styles' });
  // 惰性取领域状态：停用状态包时这一页只是空着（壳显示占位），不会把整个前端拖成 pending。
  ctx.inject(['zhiyunStudyController'], (scope) => {
    scope.slots.inject('zhiyun.study.content', () => scope.slots.register(
      { name: 'zhiyun.study.content' },
      () => <Study controller={scope.zhiyunStudyController} />,
    ));
  });
}

/** 解析模型选择：读的是 state 包的路由配置，界面属于这一页，所以留在页面包里。 */
export function ModelSettings({ controller }) {
  const [data, setData] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function load() {
    try {
      setData(await controller.request("models"));
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  async function save(stage, value) {
    setBusy(true);
    try {
      const routes = { ...data.routes };
      if (value) routes[stage] = JSON.parse(value);
      else delete routes[stage];
      await controller.request("models-save", { routes });
      setData({ ...data, routes });
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return <details className="zs-models" onToggle={(e) => {
    if (e.currentTarget.open && !data) void load();
  }}><summary>解析模型</summary><p>使用个人面板已配置的 AI 服务。视觉阶段需要支持图片的模型。</p><Notice>{error}</Notice>{data && ["vision", "text"].map((stage) => <label key={stage}>{stage === "vision" ? "看图转述" : "纠错与标注"}<select disabled={busy} value={data.routes[stage] ? JSON.stringify(data.routes[stage]) : ""} onChange={(e) => void save(stage, e.target.value)}><option value="">跟随当前默认模型</option>{data.catalog.flatMap((p) => p.models.filter((m) => stage !== "vision" || m.inputModalities?.includes("image")).map((m) => <option key={`${p.id}:${m.id}`} value={JSON.stringify({ provider: p.id, model: m.id })}>{p.name} · {m.name}</option>))}</select></label>)}<button className="zs-text" onClick={() => controller.navigate("me")}>前往个人配置 AI 服务 →</button></details>;
}
function Study({ controller }) { return <StudyWorkspace controller={controller} Notice={Notice} ModelSettings={ModelSettings} safeLink={safeLink} />; }
export function safeLink(value) {
  if (typeof value !== "string" || !value.trim()) return void 0;
  try {
    const url = new URL(value, globalThis.location?.href);
    return ["https:", "http:"].includes(url.protocol) ? url.href : void 0;
  } catch {
    return void 0;
  }
}
