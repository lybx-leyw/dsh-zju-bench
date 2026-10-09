import React from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
const labels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '注释' };
const kinds = { elaboration: ['讲解', 'explain'], definition: ['定义', 'definition'], procedure: ['步骤', 'procedure'], example: ['例题', 'example'], note: ['说明', 'note'] };
const blocksOf = t => t.blocks?.length ? t.blocks : (t.passages ?? []).map(p => ({text:p.text,kind:Object.keys(kinds).find(k=>kinds[k][0]===p.label) ?? 'elaboration'}));
const kindOf = b => b.kind?.wire ?? b.kind ?? 'elaboration';

export function LectureReader({ state, controller, onSource, focus }) {
  const lecture = state.lecture, busy = state.busy || state.activeJob?.state === 'running';
  const chapters = lecture?.chapters ?? [], topics = chapters.flatMap(c => c.topics);
  const [tocOpen, setTocOpen] = React.useState(false), [active, setActive] = React.useState('');
  const root = React.useRef(null), navigatingUntil = React.useRef(0), prefix = React.useId().replace(/:/g,'');
  const idOf = (ci,ti,bi) => `${prefix}-${ci}${ti==null?'':`-${ti}`}${bi==null?'':`-${bi}`}`;
  const jump = id => { navigatingUntil.current=Date.now()+1000; setActive(id); document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'}); };
  React.useEffect(() => {
    setActive('');
    if (!root.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(() => {
      if(Date.now()<navigatingUntil.current)return;
      const locations=[...root.current.querySelectorAll('[data-handout-location]')].map(el=>({el,rect:el.getBoundingClientRect()}));
      const first=locations.filter(x=>x.rect.bottom>80&&x.rect.top<innerHeight*.4).sort((a,b)=>Math.abs(a.rect.top-80)-Math.abs(b.rect.top-80))[0];
      if(first)setActive(first.el.id);
    },{rootMargin:'-8% 0px -65% 0px'});
    root.current.querySelectorAll('[data-handout-location]').forEach(el=>observer.observe(el));
    return ()=>observer.disconnect();
  },[lecture?.revision]);
  const treeLink = (id,title,cls) => <button className={`${cls}${active===id?' is-active':''}`} aria-current={active===id?'location':undefined} onClick={()=>jump(id)}>{title}</button>;
  // 检索结果面板点「讲义（知识点稿）」的命中时，视图把章/知识点序号交进来；讲义与终稿同屏切换后，
  // 章节内容要等到这一轮渲染完才在 DOM 里，所以放到 effect 里跳。
  React.useEffect(() => {
    if (focus?.chapterNo == null) return;
    const id = idOf(focus.chapterNo - 1, focus.topicNo == null ? null : focus.topicNo - 1);
    const target = document.getElementById(id);
    if (!target) return;
    navigatingUntil.current = Date.now() + 1000;
    setActive(id);
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focus?.nonce]);
  const canRestore=state.result?.canRestoreLecture ?? !!state.result?.lectureHistory?.length;
  return <div className="zs-handout" ref={root}>
    <div className="zs-handout-toolbar"><div><strong>{lecture ? `${chapters.length} 章 · ${topics.length} 个知识点` : '把主线整理成可阅读的知识点'}</strong><small>{lecture?.review ? `讲义已终审${lecture.review.unchanged ? ' · 本轮未改动' : ''}` : '讲义独立于解析终稿，保留页码和来源块。'}</small></div><div className="zs-handout-actions">
      {canRestore && <button className="zs-button" disabled={busy} onClick={()=>controller.restoreLecture()}>恢复上一版</button>}
      <button className="zs-button" disabled={busy || !state.result} onClick={()=>controller.assembleLecture()}>{state.lectureBusy?'正在生成讲义…':lecture?'重新生成讲义':'生成讲义'}</button>
      <button className="zs-button" disabled={busy || !topics.length} onClick={()=>controller.finalPass()}>{state.finalPassBusy?'整节重组终审中…':'重组并终审'}</button>
    </div></div>
    {!topics.length ? <div className="zs-content-empty"><strong>{state.result?'这节课还没有生成讲义':'先整理课堂，生成解析终稿'}</strong><small>讲义将按章节与知识点组织主线内容。</small></div> : <>
      <button className="zs-handout-toc-toggle" onClick={()=>setTocOpen(v=>!v)} aria-expanded={tocOpen}>☰ 讲义目录 <span>{tocOpen?'收起':'展开'}</span></button>
      {tocOpen && <aside className="zs-handout-drawer" aria-label="讲义目录"><div className="zs-handout-drawer-title">章节 · 知识点 · 正文小标题</div>{chapters.map((c,ci)=><details className="zs-handout-tree-branch" key={ci} open><summary>{treeLink(idOf(ci),`${String(ci+1).padStart(2,'0')} ${c.title}`,'zs-handout-tree-chapter')}</summary>{c.topics.map((t,ti)=><details key={ti} className="zs-handout-tree-leaf"><summary>{treeLink(idOf(ci,ti),`${ti+1}. ${t.title}`,'zs-handout-tree-topic')}</summary>{blocksOf(t).map((b,bi)=>{const label=kinds[kindOf(b)]?.[0]??'讲解';return <React.Fragment key={bi}>{treeLink(idOf(ci,ti,bi),`${label} · ${b.title||`${label} ${bi+1}`}`,'zs-handout-tree-block')}</React.Fragment>;})}</details>)}</details>)}</aside>}
      {chapters.map((c,ci)=><section className="zs-handout-chapter" id={idOf(ci)} data-handout-location key={ci}><header><small>第 {ci+1} 章</small><h2>{c.title}</h2></header>{c.topics.map((t,ti)=><article className="zs-handout-topic" id={idOf(ci,ti)} data-handout-location key={ti}><header><h3>{t.title}</h3><button className="zs-text zs-source-anchor" onClick={()=>onSource(t)}>P{t.fromPage??t.anchor?.page}{t.toPage>t.fromPage?`–${t.toPage}`:''} · 回到终稿 ↗</button></header>
        {t.register!=='written'&&<p className="zs-draft-label">本知识点保留课堂原话，尚未写成书面稿。</p>}
        {blocksOf(t).map((b,bi)=>{const kind=kindOf(b),[label,tone]=kinds[kind]??kinds.elaboration;return <section className={`zs-handout-block zs-handout-block--${tone}`} id={idOf(ci,ti,bi)} data-handout-location key={bi}>
          <div className="zs-handout-kind"><span>{label}</span>{b.title&&<strong>{b.title}</strong>}{b.sourceBlockIndexes?.length>0&&<button className="zs-text zs-block-source" onClick={()=>onSource(b)}>来源 ↗</button>}</div>
          {kind==='example'?<><div className="zs-example-label">题干</div><MarkdownText text={b.stem??''} labels={labels}/>{b.solution?.trim()?<details className="zs-example-solution"><summary>查看解答</summary><MarkdownText text={b.solution} labels={labels}/></details>:<small className="zs-muted">课堂未提供解答</small>}</>:<MarkdownText text={b.text??b.displayText??''} labels={labels}/>}
        </section>;})}
      </article>)}</section>)}
    </>}
    {!!lecture?.warnings?.length&&<details className="zs-diagnostics"><summary>讲义加工记录</summary>{lecture.warnings.map((w,i)=><p key={i}>{w}</p>)}</details>}
  </div>;
}
