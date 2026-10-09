import React, { useEffect, useState } from "react";
import { useStudy } from 'dsh-zhiyun-ui-primitives';
import { LectureReader } from "./lecture-reader.jsx";
import { time, lessonWhen } from "./format.js";
import { QueryMode, queryModes, defaultQueryMode, queryModeOf, LayerId, defaultSearchLayers, layerLabel, availableLayers, layerRegistry, lineRoles, facetOptions } from "./layers.js";
import { searchLesson, hitBlockIndexes, lessonCatalog, searchNote } from "./layered-search.js";

function CourseTree({ state, controller, ModelSettings }) {
  const [query, setQuery] = useState("");
  const courses = state.courses.filter((course) => `${course.title} ${course.teacher ?? ""} ${course.termName ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <aside className="zs-course-tree" aria-label="课程与节次">
    <div className="zs-tree-top"><div><span className="zs-eyebrow">学习空间</span><h2>课程目录</h2></div><span className="zs-course-total">{state.courses.length}</span></div>
    <label className="zs-tree-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="查找课程" placeholder="查找课程" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="zs-course-list">
      {courses.map((course) => {
        const id = String(course.id), isOpen = Boolean(state.expandedCourses[id]), loading = Boolean(state.loadingCourses[id]);
        // 不可回放的节次在写入控制器时就被丢掉了（`model.js` 的 `loadCourse`），
        // 所以这里直接渲染，渲染路径上不再过滤。
        //
        // 计数只在节次读回来之后才显示：课程表槽位数（概率论 15）和可回放节数
        // （3）差得很远，先显示前者会在展开的瞬间跳成后者。
        const lessons = state.lessonsByCourse[id] ?? [], meta = state.lessonMetaByCourse[id];
        const hidden = state.lessonHiddenByCourse[id] ?? 0;
        const count = meta ? lessons.length : null;
        return <section className={`zs-course-group${isOpen ? " is-open" : ""}`} key={id}>
          <button className="zs-course-toggle" aria-expanded={isOpen} onClick={() => controller.toggleCourse(course)}><span className="zs-chevron" aria-hidden="true">{isOpen ? "⌄" : "›"}</span><span className="zs-course-name"><strong>{course.title}</strong><small>{course.termName ?? course.teacher ?? "课程"}</small></span>{count !== null && <span className="zs-course-count">{count}</span>}</button>
          {isOpen && <div className="zs-tree-lessons">{loading && !lessons.length ? <p className="zs-tree-hint">正在读取节次…</p> : lessons.map((lesson) => {
            const key = `${id}:${lesson.subId}`, status = state.sectionStates[key], selected = state.course?.id === course.id && state.lesson?.id === lesson.id;
            const job = status?.job ?? (state.activeJob?.courseId === course.id && state.activeJob?.subId === lesson.subId ? state.activeJob : null);
            const label = job?.state === "running" ? "解析中" : status?.parsed ? status.resultStatus === "ready" ? "已整理" : "待完善" : status ? "待整理" : "课堂资料";
            return <button className={`zs-tree-lesson${selected ? " is-selected" : ""}`} key={lesson.id} aria-current={selected ? "page" : undefined} onClick={() => void controller.selectLesson(lesson, course)}>
              <span className={`zs-state-dot${job?.state === "running" ? " is-running" : status?.parsed ? " is-ready" : ""}`} aria-hidden="true" />
              <span className="zs-tree-lesson-copy"><strong>{lesson.title}</strong><small>{lessonWhen(lesson.startAt)}</small></span><span className="zs-state-label">{label}</span>
            </button>;
          })}{!loading && !lessons.length && <p className="zs-tree-hint">{meta ? meta.complete === false ? "节次未收全，可刷新重试。" : "这门课还没有可回放的节" : "暂无节次"}</p>}{lessons.length > 0 && hidden > 0 && <p className="zs-tree-hint">课程表里另有 {hidden} 个槽位不可回放，已隐藏</p>}{meta?.complete === false && <p className="zs-tree-hint">节次列表尚未收全</p>}</div>}
        </section>;
      })}
      {!courses.length && <div className="zs-tree-empty"><p>{query ? "没有找到匹配课程。" : state.error ? "课程列表暂时无法读取。" : "这里还没有课程。"}</p>{!query && <button className="zs-text" onClick={() => controller.refresh()}>重新读取课程 →</button>}</div>}
    </div>
    <div className="zs-tree-footer">{state.coursesMeta?.complete === false && <span>课程列表尚未收全</span>}<ModelSettings controller={controller} /></div>
  </aside>;
}

function AssetCard({ icon, label, detail, value, active, onClick }) {
  return <button className={`zs-asset-card${active ? " is-active" : ""}`} onClick={onClick}>
    <span className="zs-asset-icon" aria-hidden="true">{icon}</span><span className="zs-asset-copy"><small>{label}</small><strong>{value}</strong><span>{detail}</span></span><span className="zs-asset-arrow" aria-hidden="true">↗</span>
  </button>;
}

// 高级检索的选项住在搜索框右边的浮窗里：检索入口、2×11 维与层范围都与 tab 无关，
// 不打开时整块收起，学习页面上不留任何控件痕迹。
//
// 每张 chip 都带本节条数微标（`lessonCatalog`）：0 条的虚化、点不动 ——
// 点下去只会得到「没有命中」，那是假反馈。标签过滤一旦按维度收窄，
// 页面层/主线/术语表就没有块级标签可用，那几张 chip 转成「本轮不参与」的灰态，
// 并在行下写明原因，免得「选了『图上的字』却一条不出」无从解释。
function Chip({ label, count, on, disabled, idle, title, onClick }) {
  const cls = `zs-chip${on ? " is-on" : ""}${disabled ? " is-off" : ""}${idle ? " is-idle" : ""}`;
  return <button type="button" className={cls} aria-pressed={on} disabled={disabled} title={title} onClick={onClick}>{label}{count == null ? null : <span className="zs-chip-count">{count}</span>}</button>;
}

function AdvancedSearchPanel({ state, mode, setMode, role, setRole, facets, setFacets, layers, setLayers, modeHint, tagMode, filtersActive, catalog, layerOn, toggleLayer, toggleFacet }) {
  const blockLayers = new Set([LayerId.finalDoc, LayerId.teacher]);
  return (
    <div className="zs-filter-panel" role="dialog" aria-label="高级检索选项">
      <div className="zs-filter-row"><span className="zs-filter-label">检索入口</span><div className="zs-chips">{queryModes.map((item) => <button type="button" key={item.id} className={`zs-chip${mode === item.id ? " is-on" : ""}`} aria-pressed={mode === item.id} title={item.hint} onClick={() => setMode(item.id)}>{item.label}</button>)}</div></div>
      <p className="zs-filter-hint">{modeHint}</p>
      {tagMode && <>
        <div className="zs-filter-row"><span className="zs-filter-label">主支线</span><div className="zs-chips"><Chip label="全部" count={catalog.layers[LayerId.finalDoc] ?? 0} on={!role} title="不按主支线收窄" onClick={() => setRole("")} />{lineRoles.map((item) => <Chip key={item} label={item} count={catalog.roles[item] ?? 0} on={role === item} disabled={!(catalog.roles[item] ?? 0)} title={catalog.roles[item] ? `${item}：本节 ${catalog.roles[item]} 个片段` : `本节没有标成「${item}」的片段`} onClick={() => setRole(item)} />)}</div></div>
        <div className="zs-filter-row"><span className="zs-filter-label">内容类型</span><div className="zs-chips">{facetOptions(state.result).map((item) => { const count = catalog.facets[item] ?? 0; return <Chip key={item} label={item} count={count} on={facets.includes(item)} disabled={!count} title={count ? `${item}：本节 ${count} 个片段` : `本节没有标成「${item}」的片段`} onClick={() => toggleFacet(item)} />; })}</div></div>
        {(facets.length > 0 || Boolean(role)) && <button type="button" className="zs-text" onClick={() => { setFacets([]); setRole(""); }}>清空筛选</button>}
      </>}
      <div className="zs-filter-row"><span className="zs-filter-label">层范围</span><div className="zs-chips">{availableLayers.map((spec) => { const count = catalog.layers[spec.id] ?? 0; const idle = filtersActive && !blockLayers.has(spec.id); return <Chip key={spec.id} label={spec.label} count={count} on={layerOn(spec.id)} disabled={!count} idle={idle} title={!count ? "本节这一层没有内容" : idle ? `${spec.label}：标签过滤已按维度收窄，这一层本轮不参与（它没有块级标签）` : `${spec.label}：本节 ${count} 条`} onClick={() => toggleLayer(spec.id)} />; })}</div></div>
      {filtersActive && <p className="zs-filter-hint">已按维度收窄：只有「终稿（块级）」与「老师原话（句子层）」能出结果，其余层本轮不参与。</p>}
      <div className="zs-filter-row"><span className="zs-filter-label">未接入</span><div className="zs-chips">{layerRegistry.filter((spec) => !spec.available).map((spec) => <span key={spec.id} className="zs-chip is-off" title={spec.reason}>{spec.label}</span>)}</div></div>
      {layers && <button type="button" className="zs-text" onClick={() => setLayers(null)}>恢复默认层</button>}
    </div>
  );
}

// 命中列表住在节次头部下方的抽屉里（正常文档流）：它只在「正在检索」时出现，
// 位置稳定，不会被浮窗挡住，也不占用终稿 tab 的工具栏。
function SearchResults({ outcome, jumpToHit }) {
  return (
    <div className="zs-results" role="region" aria-label="检索结果">
      <p className="zs-results-head">{outcome.hits.length ? `命中 ${outcome.hits.length} 条` : "没有命中"}{outcome.omitted ? ` · 另有 ${outcome.omitted} 条未显示` : ""}</p>
      <p className="zs-results-note">{searchNote(outcome)}</p>
      <div className="zs-hit-list">{outcome.hits.map((hit, index) => <button type="button" className="zs-hit" key={`${hit.id}-${index}`} onClick={() => jumpToHit(hit)}>
        <span className="zs-hit-top"><span className="zs-chip is-on zs-hit-layer">{layerLabel(hit.layer)}</span><span className="zs-hit-where">{hit.chapterNo != null ? `第 ${hit.chapterNo} 章 · 知识点 ${hit.topicNo}` : hit.page != null ? `第 ${hit.page} 页` : hit.atSec != null ? time(hit.atSec * 1000) : ""}{hit.chapterNo == null && hit.page != null && hit.atSec != null ? ` · ${time(hit.atSec * 1000)}` : ""}</span></span>
        <span className="zs-hit-text">{hit.preview}</span>
      </button>)}</div>
    </div>
  );
}

export function StudyWorkspace({ controller, Notice, ModelSettings, safeLink }) {
  const state = useStudy(controller), [tab, setTab] = useState("终稿"), [query, setQuery] = useState(""), [mode, setMode] = useState(defaultQueryMode.id), [role, setRole] = useState(""), [facets, setFacets] = useState([]), [layers, setLayers] = useState(null), [optionsOpen, setOptionsOpen] = useState(false), [lectureFocus, setLectureFocus] = useState(null), [page, setPage] = useState(0), [mobileTree, setMobileTree] = useState(false);
  const advancedRef = React.useRef(null);
  useEffect(() => { setQuery(""); setRole(""); setFacets([]); setOptionsOpen(false); setLectureFocus(null); setPage(0); setTab("终稿"); }, [state.lesson?.id, state.course?.id]);
  // 浮窗是「选项」的住处，点外面或按 Esc 就收；它只覆盖在自己那一角，不接管正文的点击。
  useEffect(() => {
    if (!optionsOpen) return undefined;
    const onPointerDown = (event) => { if (!advancedRef.current?.contains(event.target)) setOptionsOpen(false); };
    const onKeyDown = (event) => { if (event.key === "Escape") setOptionsOpen(false); };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("mousedown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [optionsOpen]);
  const slides = state.content?.slides.items ?? [], subtitles = state.content?.subtitles.items ?? [], active = state.activeJob, running = active?.state === "running", ownRunning = running && active.courseId === state.course?.id && active.subId === state.lesson?.subId;
  // 检索是纯函数的输入输出：档位 + 2×11 维 + 层范围进，命中集出。控制器不参与。
  const wanted = layers ?? defaultSearchLayers;
  const outcome = searchLesson(state.result, { query, mode, role, facets, layers: wanted });
  const hitBlocks = hitBlockIndexes(outcome);
  const catalog = lessonCatalog(state.result);
  const tagMode = mode === QueryMode.tagFilter.id;
  // 「这次到底在检索」＝有关键词，或者标签过滤档位下给了维度（App `_SearchBlockState._searching`）。
  const keywordSearch = Boolean(query.trim());
  const searching = keywordSearch || (tagMode && (facets.length > 0 || Boolean(role)));
  // 两种检索的正文语义不同，不能混为一谈：
  //   · 有关键词 —— 这是**查找**，正文让位给结果：命中正文渲染在抽屉里，
  //     正文区不再用「减法」（原本那样会剩下几个未命中块，甚至空态与命中列表自相矛盾）。
  //   · 只有维度（标签过滤档）—— 这是**筛选**，正文就是筛选后的块本身，保持原样。
  const blocks = keywordSearch ? [] : searching ? (state.result?.blocks ?? []).filter((block) => hitBlocks.has(block.index)) : state.result?.blocks ?? [];
  const modeHint = `${queryModeOf(mode).hint}${tagMode ? "；可以不给关键词，只给筛选" : "（筛选只在「标签过滤」档位生效）"}`;
  const layerOn = (id) => (layers ? layers.includes(id) : defaultSearchLayers.has(id));
  const toggleLayer = (id) => { const base = layers ?? [...defaultSearchLayers]; setLayers(base.includes(id) ? base.filter((item) => item !== id) : [...base, id]); };
  const toggleFacet = (label) => setFacets((value) => (value.includes(label) ? value.filter((item) => item !== label) : [...value, label]));
  const jumpToHit = (hit) => {
    // 抽屉常驻在节次头部下方（正常流式布局，不覆盖正文），命中可能指向当前没在看的 tab，
    // 所以块级命中要先切回终稿再定位。
    // 关键词检索时正文是空的（让位给结果），块根本不存在：先退出检索把正文还原成全量，再滚动过去。
    if (hit.blockIndex != null) { if (keywordSearch) { setQuery(""); setOptionsOpen(false); } setTab("终稿"); setTimeout(() => document.getElementById(`zs-block-${hit.blockIndex}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0); }
    else if (hit.layer === LayerId.lecture) { setLectureFocus({ chapterNo: hit.chapterNo, topicNo: hit.topicNo, nonce: Date.now() }); setTab("讲义"); }
    else if (hit.page != null) { const index = slides.findIndex((item) => item.page === hit.page); if (index >= 0) { setPage(index); setTab("PPT"); } }
  };
  if (state.loading) return <div className="zs-workspace-loading"><span className="zs-spinner" />正在连接课堂与学习资料…</div>;
  if (!state.user) return <div className="zs-workspace-signin"><div className="zs-signin-mark">知</div><h1>连接智云课堂</h1><p>登录后，课程、课件与课堂字幕会汇集到这间学习工作台。</p><button className="zs-primary" onClick={() => controller.navigate("me")}>前往个人面板登录</button><Notice>{state.error}</Notice></div>;
  return <section className="zs-study" aria-label="学习工作台">
    <div className="zs-workbench-shell">
      <button className="zs-mobile-tree-toggle" aria-expanded={mobileTree} onClick={() => setMobileTree((value) => !value)}><span>课程目录</span><span>{state.course?.title ?? "选择一门课程"}</span><span aria-hidden="true">{mobileTree ? "⌃" : "⌄"}</span></button>
      <div className={`zs-workbench${mobileTree ? " is-tree-open" : ""}`}>
        <CourseTree state={state} controller={controller} ModelSettings={ModelSettings} />
        <main className="zs-reader">
          <Notice>{state.error}</Notice>
          {!state.lesson ? <div className="zs-reader-empty"><span className="zs-motto-text">海纳江河，启真厚德</span><h1>从一节课开始，搭建自己的知识脉络。</h1><p>展开左侧课程，选择一节课堂。课件、字幕和解析内容会在这里自然汇合。</p><div className="zs-empty-hint"><span>01</span><div><strong>选择课程与节次</strong><small>课程资料会按课堂归档</small></div><span>02</span><div><strong>阅读与整理</strong><small>在同一处查看课件、字幕与讲义</small></div></div></div> : <>
            <header className="zs-current-section">
              <div className="zs-breadcrumb-row">
                <div className="zs-breadcrumb"><span>{state.course?.title}</span><span aria-hidden="true">/</span><span>{state.lesson.title}</span></div>
                {state.result && <div className="zs-search-entry" ref={advancedRef}>
                  <label className="zs-search-box"><span aria-hidden="true">⌕</span><input type="search" aria-label="查找解析正文" placeholder={tagMode ? "按标签筛（可留空）：如「所有例题」" : "检索本节：正文、讲义、课件…"} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setOptionsOpen(false); event.currentTarget.blur(); } }} />{query && <button type="button" className="zs-search-clear" aria-label="清空检索" onClick={() => setQuery("")}>×</button>}</label>
                  <button type="button" className="zs-search-trigger" aria-expanded={optionsOpen} aria-controls="zs-advanced-popover" onClick={() => setOptionsOpen((value) => !value)}>高级检索</button>
                  {optionsOpen && <div className="zs-advanced-popover" id="zs-advanced-popover">
                    <AdvancedSearchPanel state={state} mode={mode} setMode={setMode} role={role} setRole={setRole} facets={facets} setFacets={setFacets} layers={layers} setLayers={setLayers} modeHint={modeHint} tagMode={tagMode} filtersActive={outcome.filtersActive} catalog={catalog} layerOn={layerOn} toggleLayer={toggleLayer} toggleFacet={toggleFacet} />
                  </div>}
                </div>}
              </div>
              <div className="zs-current-main"><div><span className={`zs-current-state${state.result?.status === "ready" ? " is-ready" : ""}`}><i />{running ? ownRunning ? "正在解析" : "其他课堂解析中" : state.result ? state.result.status === "ready" ? "学习资料已整理" : "解析部分完成" : "等待整理"}</span><h1>{state.lesson.title}</h1><p>{lessonWhen(state.lesson.startAt)}{state.lesson.lecturerName ? ` · ${state.lesson.lecturerName}` : ""}</p></div><div className="zs-current-actions">{state.lesson.videoUrl && <a className="zs-button" href={safeLink(state.lesson.videoUrl)} target="_blank" rel="noreferrer"><span aria-hidden="true">▷</span> 课堂回放</a>}<button className="zs-primary" disabled={state.busy || running || state.contentLoading || !state.content || state.content.slides.meta.complete !== true || state.content.subtitles.meta.complete !== true} onClick={() => controller.start()}>{state.result ? "重新整理" : "整理这节课"}<span aria-hidden="true"> ↗</span></button></div></div>
              {running && <div className="zs-progress" role="status"><span>{ownRunning ? "正在整理" : "另一节课堂正在整理"} · {({ source: "读取资料", faithful: "看图转述", mix: "纠错与分块", tags: "整理内容标签", done: "完成" })[active.progress.phase] ?? active.progress.phase} {active.progress.total ? `${active.progress.done}/${active.progress.total}` : ""}</span>{active.progress.total > 0 && <progress value={active.progress.done} max={active.progress.total} />}<button className="zs-text" disabled={state.busy} onClick={() => controller.cancel()}>取消</button></div>}
            </header>
            {state.result && searching && <div className="zs-search-drawer" id="zs-search-drawer">
              <SearchResults outcome={outcome} jumpToHit={jumpToHit} />
            </div>}
            <div className="zs-assets" aria-label="课堂资料概览">
              <AssetCard icon="▤" label="解析终稿" value={state.result ? `${state.result.blocks.length} 个知识片段` : "尚未整理"} detail={state.result ? state.result.status === "ready" ? "主线与重点已就绪" : "包含未完成内容" : "把课堂转成清晰脉络"} active={tab === "终稿"} onClick={() => setTab("终稿")} />              <AssetCard icon="▧" label="课堂课件" value={`${slides.length} 页`} detail={slides.length ? "浏览课堂投影片" : "暂无课件资料"} active={tab === "PPT"} onClick={() => setTab("PPT")} />
              <AssetCard icon="≋" label="课堂字幕" value={`${subtitles.length} 条`} detail={subtitles.length ? "按时间回看课堂原话" : "暂无字幕资料"} active={tab === "字幕"} onClick={() => setTab("字幕")} />
            </div>
            <section className="zs-content-section">
              <div className="zs-content-heading"><div><span className="zs-eyebrow">当前课堂</span><h2>{tab === "讲义" ? "课堂讲义" : tab === "终稿" ? "解析终稿" : tab === "PPT" ? "课堂课件" : "课堂字幕"}</h2></div><div className="zs-content-tools"><div className="zs-content-switch" role="tablist" aria-label="课堂内容">{["终稿", "讲义", "PPT", "字幕"].map((item) => <button key={item} id={`zs-tab-${item}`} role="tab" aria-controls="zs-content-panel" aria-selected={tab === item} onClick={() => setTab(item)}>{item}</button>)}</div><button className="zs-icon-button" title="刷新课堂" aria-label="刷新课堂" disabled={state.loading || state.busy} onClick={() => controller.refresh()}>↻</button></div></div>
              {state.contentLoading ? <div className="zs-content-loading"><span className="zs-spinner" />正在读取课件与字幕…</div> : <div id="zs-content-panel" role="tabpanel" aria-labelledby={`zs-tab-${tab}`}>
                {tab === "讲义" ? <LectureReader state={state} controller={controller} focus={lectureFocus} onSource={(topic) => { setTab("终稿"); setQuery(""); setRole(""); setFacets([]); setTimeout(() => document.getElementById(`zs-block-${topic.sourceBlockIndexes?.[0] ?? topic.blockIndexes?.[0]}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0); }} /> : tab === "PPT" ? slides.length ? <><div className="zs-slide-controls"><span>第 <strong>{slides[page]?.page}</strong> 页 <span className="zs-muted">/ {slides.length}</span></span><div><button className="zs-button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>上一页</button><button className="zs-button" disabled={page >= slides.length - 1} onClick={() => setPage((value) => value + 1)}>下一页</button></div></div><img className="zs-slide" src={safeLink(slides[page]?.imageUrl)} alt={`第 ${slides[page]?.page} 页课件`} /><p className="zs-slide-time">课堂时间 {time(slides[page]?.startMs ?? 0)}</p></> : <div className="zs-content-empty"><span>▧</span><strong>这节课暂时没有课件</strong><small>课堂资料完成同步后会显示在这里</small></div>
                  : tab === "字幕" ? <div className="zs-transcript">{subtitles.map((line, index) => <p key={index}><time>{time(line.startMs)}</time><span>{line.text}</span></p>)}{!subtitles.length && <div className="zs-content-empty"><span>≋</span><strong>这节课暂时没有字幕</strong><small>课堂资料完成同步后会显示在这里</small></div>}</div>
                    : state.result ? <><Notice>{state.result.status !== "ready" ? "部分页面或标签还未整理完成；原始字幕仍然保留，可以重新整理。" : null}</Notice><p className="zs-layer-note">终稿保留纠错后的课堂原话、主支线标签和来源时间。<button className="zs-text" onClick={() => setTab("讲义")}>阅读知识点讲义 →</button></p><div className="zs-outline"><div><small>本节主线</small><h3>{state.result.spine || "主线尚未生成"}</h3></div><div className="zs-outline-links">{state.result.outline.map((outline, index) => <button className="zs-text" key={index} onClick={() => document.getElementById(`zs-block-${outline.from}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>{outline.title}<span>↓</span></button>)}</div></div>
                  <div className="zs-blocks">{blocks.map((block) => <article className="zs-block" id={`zs-block-${block.index}`} key={block.index}><header><span>{time(block.startMs ?? 0)} · {block.page ? `第 ${block.page} 页` : "字幕"} · {block.tag.role ?? "未标注"}</span><div>{(block.tag.facets ?? []).map((item) => <span className="zs-facet" key={item}>{item}</span>)}</div></header>{block.tag.summary && <h3>{block.tag.summary}</h3>}{block.bridge && <p className="zs-bridge">{block.bridge}</p>}{block.sentences.map((line, index) => <p key={index}>{line.text}</p>)}</article>)}</div>{blocks.length ? null : keywordSearch && outcome.hits.length ? <p className="zs-muted">正文已让位给检索结果：{outcome.hits.length} 条命中都在上方「检索结果」面板里，点任意一条即可回到对应位置。</p> : <p className="zs-muted">没有匹配的内容。</p>}<details className="zs-diagnostics"><summary>查看整理记录</summary><p>{state.result.sentences.length + (state.result.unassignedSentences?.length ?? 0)} 句字幕 · {state.result.blocks.length} 个知识片段 · {state.result.failedPages?.length ?? 0} 页需重试{state.result.unassignedSentences?.length ? ` · ${state.result.unassignedSentences.length} 句没落到任何一页（已单列保留）` : ""}</p>{state.result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details></> : <div className="zs-unparsed"><div className="zs-unparsed-icon">✦</div><h3>让课堂内容变成自己的理解</h3><p>{slides.length} 页课件 · {subtitles.length} 条字幕。整理后，这里会呈现课堂主线、重点和可检索的知识片段。</p>{state.content && (state.content.slides.meta.complete !== true || state.content.subtitles.meta.complete !== true) ? <Notice>课堂资料尚未收全，请刷新课堂后再试。</Notice> : <button className="zs-text" onClick={() => controller.start()}>开始整理这节课 →</button>}</div>}
              </div>}
            </section>
          </>}
        </main>
      </div>
    </div>
  </section>;
}
