import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {StudyWorkbench,publicError} from '../packages/dsh-zhiyun-study-core/src/workbench.js';
import {mountKnowledge} from './fixtures/study-storage.mjs';
import {createStudyController,playableLessons} from '../packages/dsh-zhiyun-study-core/src/model.js';
import {searchLesson,hitBlockIndexes} from '../packages/dsh-zhiyun-page-study/src/layered-search.js';
async function fixture(directory){
  const host=await mountKnowledge(directory); let user={id:'1',name:'Alice'};
  const result={schema:1,status:'ready',blocks:[],sourceId:'fixture',pages:[],sentences:[],unassignedSentences:[],spine:'',outline:[],vocabulary:[],warnings:[],fetchedAt:new Date().toISOString()};
  const service=new StudyWorkbench({directory,knowledge:host.service,llm:{listProviders:()=>[],resolveModelInfo:async()=>({})},classroom:{getCurrentUser:async()=>user,login:async credentials=>{user={id:credentials.username};return{user};},logout:async()=>{user=null;},listCourses:async()=>({items:[],meta:{complete:true}})},parser:{llm:{routes:{}},parseClassroom:async()=>result}});
  const dispose=service.dispose.bind(service);service.dispose=async()=>{await dispose();await host.dispose();};return service;
}

test('study results persist after host restart and are isolated by classroom account',async()=>{const dir=await mkdtemp(path.join(tmpdir(),'zhiyun-study-'));const service=await fixture(dir);try{
  const key={courseId:'10',subId:'20'};const first=await service.invoke('start',key);assert.equal(first.state,'running');await [...service.jobs.values()][0].done;
  assert.equal((await service.invoke('result',key)).result.status,'ready');const summary=await service.invoke('result',{...key,includeResult:false});assert.equal(summary.result,null);assert.equal(summary.hasResult,true);assert.equal(summary.resultStatus,'ready');await service.dispose();
  const restored=await fixture(dir);await restored.ready;assert.equal((await restored.invoke('result',key)).result.status,'ready');
  await restored.invoke('login',{username:'2',password:'fixture'});assert.equal((await restored.invoke('result',key)).result,null);
  await restored.invoke('logout');await assert.rejects(restored.invoke('result',key),{code:'SESSION_EXPIRED'});await restored.dispose();
}finally{await service.dispose();await rm(dir,{recursive:true,force:true});}});
test('cancel retains earlier result, failed replacement does not overwrite it, duplicate starts deduplicate',async()=>{const dir=await mkdtemp(path.join(tmpdir(),'zhiyun-study-job-'));const service=await fixture(dir);try{
  const key={courseId:'10',subId:'20'};await service.start('10','20');await [...service.jobs.values()][0].done;
  service.parser.parseClassroom=async(_c,_s,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  const active=await service.invoke('start',key);assert.equal((await service.invoke('start',key)).id,active.id);
  await assert.rejects(service.start('11','21'),{code:'BUSY'});await service.invoke('cancel',key);
  assert.equal((await service.invoke('result',key)).job.state,'cancelled');assert.equal((await service.invoke('result',key)).result.status,'ready');
  service.parser.parseClassroom=async()=>{throw Object.assign(new Error('SECRET password or provider response'),{code:'CONFIG'});};await service.invoke('start',key);await [...service.jobs.values()][0].done;
  const data=await service.invoke('result',key);assert.equal(data.job.state,'failed');assert.ok(!JSON.stringify(data).includes('SECRET'));assert.equal(data.result.status,'ready');
}finally{await service.dispose();await rm(dir,{recursive:true,force:true});}});
test('model routing uses host catalog validation and never persists credential-shaped fields',async()=>{const dir=await mkdtemp(path.join(tmpdir(),'zhiyun-study-model-'));const service=await fixture(dir);try{
  await service.invoke('models-save',{routes:{vision:{provider:'fixture',model:'vision',apiKey:'PRIVATE'}}});assert.deepEqual(service.parser.llm.routes,{vision:{provider:'fixture',model:'vision'}});
  await assert.rejects(service.invoke('start',{courseId:'../../etc',subId:'1'}),{code:'INPUT'});
  assert.ok(!JSON.stringify(publicError(new Error('password PRIVATE'))).includes('PRIVATE'));
}finally{await service.dispose();await rm(dir,{recursive:true,force:true});}});
test('fast course switching discards older responses and disposal aborts browser calls',async()=>{let resolveFirst;const pending=new Promise(r=>resolveFirst=r);let signal;
  const controller=createStudyController(async(method,payload,s)=>{signal=s;if(method==='lessons'&&payload.courseId==='1')return pending;return{items:[{id:'new'}],meta:{complete:true}};},{navigate(){}});
  const first=controller.selectCourse({id:'1'});await controller.selectCourse({id:'2'});resolveFirst({items:[{id:'old'}],meta:{}});await first;
  assert.equal(controller.getSnapshot().course.id,'2');assert.equal(controller.getSnapshot().lessons[0].id,'new');controller.dispose();assert.equal(signal.aborted,true);
});
test('section result still loads if classroom content fetch fails; layered search reads the actual parser body',async()=>{const result={blocks:[{index:0,tag:{role:'主线',facets:['概念'],summary:'概率'},bridge:'',sentences:[{text:'密度函数'}]}]};const controller=createStudyController(async(method)=>{if(method==='lessons')return{items:[],meta:{}};if(method==='content')throw new Error('source unavailable');return{result,job:null};},{navigate(){}});
  await controller.selectCourse({id:'1'});await controller.selectLesson({id:'2',subId:'2'});assert.equal(controller.getSnapshot().result,result);assert.equal(controller.getSnapshot().contentLoading,false);
  const hit=searchLesson(result,{query:'密度',mode:'tagFilter',role:'主线',facets:['概念']});
  assert.equal(hit.hits.length,1);assert.equal(hit.hits[0].blockIndex,0);assert.deepEqual([...hitBlockIndexes(hit)],[0]);
  const miss=searchLesson(result,{mode:'tagFilter',role:'支线'});
  assert.equal(miss.hits.length,0);assert.equal(hitBlockIndexes(miss).size,0);
  assert.equal(searchLesson(result,{query:'密度'}).empty,false);assert.equal(searchLesson(result,{}).empty,true);
  controller.dispose();
});
// ── 讲义装配与无曰终审的接线（工具写好了必须真的有人用）───────────────
const wiredFixture=async(directory,{lecture=true,finalPass=true}={})=>{const base=await fixture(directory);
  const parsed={schema:1,status:'ready',sourceId:'c1 · s2',blocks:[{index:1,page:1,sentenceFrom:1,sentenceTo:1,bridge:'',sentences:[{text:'老师原话',startMs:1000,endMs:2000,page:1}],tag:{role:'主线',facets:[],summary:'概述'},startMs:1000}],
    pages:[{page:1,transcription:{pageText:'知识点一',pageVisual:'一张图'}}],outline:[],sentences:[],unassignedSentences:[],failedPages:[],warnings:[],vocabulary:[],spine:'',fetchedAt:new Date().toISOString()};
  base.parser.parseClassroom=async()=>parsed;
  base.lectureOf=()=>lecture?{buildTree:({slides,blocks,outline})=>({chapters:[{title:'第一章',topics:[{title:'知识点一',blockIndexes:[1],fromPage:1,toPage:1,pptLines:['知识点一']}]}],_in:{slides,blocks,outline}}),
    assemble:async({tree,blocks,context,signal})=>{signal?.throwIfAborted();if(!tree||!blocks.length)throw new Error('输入不完整');return{chapters:[{no:1,title:'第一章',topics:[{title:'知识点一',sourceBlockIndexes:[1],passages:[{text:'写成的正文'}],anchor:{page:1,tSec:1},register:'written'}]}],failures:[],warnings:[]};}}:undefined;
  base.finalPassOf=()=>finalPass?{run:async({text,sectionId,signal})=>{signal?.throwIfAborted();if(!text.includes('写成的正文'))throw new Error('终审没拿到讲义正文');if(!/^[\w.-]+$/.test(sectionId))throw new Error('节 id 不合法');return{text:`${text}\n\n（终审整理过）`,unchanged:false,childEvents:3};}}:undefined;
  return base;};
test('reorganized handout persists a bounded previous version; restore keeps transcript and original PPT tree',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'zhiyun-study-restore-'));const s=await wiredFixture(dir);const key={courseId:'10',subId:'20'};
 try{
  await s.invoke('start',key);await [...s.jobs.values()][0].done;await s.invoke('lecture',key);
  const before=(await s.invoke('result',key)).result;
  s.finalPassOf=()=>({run:async({sectionId})=>({text:`#!section ${sectionId} 课\n##!topic 1 1 | 重组知识点 | 章=新章\n>>> BLOCK 定义 | 新标题 | ref=c1t1b1 | src=1\n写成的正文`,unchanged:false})});
  await s.invoke('final-pass',key);const after=(await s.invoke('result',key)).result;
  assert.equal(after.lecture.chapters[0].title,'新章');assert.equal(after.lecture.review.schema,2);
  assert.equal(after.lectureHistory.length,1);assert.deepEqual(after.blocks,before.blocks);assert.deepEqual(after.knowledgeTree,before.knowledgeTree);
  const restored=await s.invoke('lecture-restore',key);assert.deepEqual(restored.lecture,before.lecture);assert.equal(restored.historyCount,0);
  await assert.rejects(s.invoke('lecture-restore',key),{code:'INPUT'});
 }finally{await s.dispose();await rm(dir,{recursive:true,force:true});}
});
test('lecture assembly and final pass are actually wired into the workbench',async()=>{const dir=await mkdtemp(path.join(tmpdir(),'zhiyun-study-wired-'));const service=await wiredFixture(dir);try{
  const key={courseId:'10',subId:'20'};await service.invoke('start',key);await [...service.jobs.values()][0].done;
  const built=await service.invoke('lecture',{...key,context:'c1 · s2'});assert.equal(built.chapters[0].topics[0].passages[0].text,'写成的正文');
  // 讲义与解析产物**同一条记录**：重开服务后仍在，且终审能用它。
  assert.ok((await service.invoke('result',key)).result.lecture.chapters.length===1);
  const passed=await service.invoke('final-pass',{...key});assert.equal(passed.unchanged,false);assert.ok(passed.lecture.chapters[0].topics[0].passages[0].text.includes('终审整理过'));
  assert.equal((await service.invoke('result',key)).result.lecture.review.childEvents,3);
}finally{await service.dispose();await rm(dir,{recursive:true,force:true});}});

test('missing slide transcriptions report the source failure before attempting handout generation',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'zhiyun-study-no-slides-'));const s=await wiredFixture(dir);const key={courseId:'10',subId:'20'};
 try{
  const parse=s.parser.parseClassroom;
  s.parser.parseClassroom=async()=>{const result=await parse();result.pages[0].transcription=null;result.pages[0].failure='URL';return result;};
  const original=s.lectureOf();s.lectureOf=()=>({...original,buildTree:()=>assert.fail('invalid source must stop before building a tree'),assemble:()=>assert.fail('do not consume model calls without slide text')});
  await s.invoke('start',key);await [...s.jobs.values()][0].done;
  const before=(await s.invoke('result',key)).result;
  await assert.rejects(s.invoke('lecture',key),{code:'SLIDE_READ_FAILED'});
  assert.match(publicError({code:'SLIDE_READ_FAILED'}).message,/重新整理/);
  assert.deepEqual((await s.invoke('result',key)).result,before);
 }finally{await s.dispose();await rm(dir,{recursive:true,force:true});}
});
test('missing optional services fail loudly by name instead of silently doing nothing',async()=>{const dir=await mkdtemp(path.join(tmpdir(),'zhiyun-study-nowired-'));const service=await wiredFixture(dir,{lecture:false,finalPass:false});try{
  const key={courseId:'10',subId:'20'};await service.invoke('start',key);await [...service.jobs.values()][0].done;
  await assert.rejects(service.invoke('lecture',key),{code:'NOT_WIRED'});
  // 终审先要求有讲义 —— 没讲义时的失败必须说清「先做什么」，不是笼统报错。
  await assert.rejects(service.invoke('final-pass',key),{code:'NOT_WIRED'});
}finally{await service.dispose();await rm(dir,{recursive:true,force:true});}});
test('final pass refuses to run before a lecture exists',async()=>{const dir=await mkdtemp(path.join(tmpdir(),'zhiyun-study-nofinal-')) ;const service=await wiredFixture(dir,{lecture:true,finalPass:true});try{
  const key={courseId:'10',subId:'20'};await service.invoke('start',key);await [...service.jobs.values()][0].done;
  await assert.rejects(service.invoke('final-pass',key),{code:'INPUT'});
}finally{await service.dispose();await rm(dir,{recursive:true,force:true});}});

test('handout uses only mainline and page text, persists tree, and review never mutates final transcript',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'zhiyun-semantics-'));const s=await wiredFixture(dir);const key={courseId:'10',subId:'20'};
  try{
    const parse=s.parser.parseClassroom;s.parser.parseClassroom=async()=>{const r=await parse();r.blocks.push({...r.blocks[0],index:2,tag:{role:'支线',facets:[],summary:'旁支'},sentences:[{text:'不进讲义',page:1,startMs:2000,endMs:3000}]});return r;};
    const original=s.lectureOf();s.lectureOf=()=>({...original,buildTree:input=>{assert.equal(input.blocks.length,1);assert.equal(input.slides[0].text,'知识点一');return original.buildTree(input);}});
    await s.invoke('start',key);await [...s.jobs.values()][0].done;
    const before=await s.invoke('result',key);await s.invoke('lecture',key);await s.invoke('final-pass',key);
    const after=(await s.invoke('result',key)).result;
    assert.deepEqual(after.blocks,before.result.blocks);assert.deepEqual(after.pages,before.result.pages);assert.ok(after.knowledgeTree.chapters.length);
    assert.match(after.lecture.review.text,/^#!section /);assert.ok(after.lecture.chapters[0].topics[0].passages[0].text.includes('终审整理过'));
    await s.invoke('lecture',key);assert.equal((await s.invoke('result',key)).result.lecture.review,null);
    s.parser.parseClassroom=async()=>{const r=await parse();r.blocks[0].sentences[0].text='新版终稿';return r;};
    await s.invoke('start',key);await [...s.jobs.values()][0].done;assert.equal((await s.invoke('result',key)).result.lecture,null);
  }finally{await s.dispose();await rm(dir,{recursive:true,force:true});}
});

test('same-section writes cannot race; malformed review preserves the existing handout',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'zhiyun-write-race-'));const s=await wiredFixture(dir);const key={courseId:'10',subId:'20'};
  try{
    await s.invoke('start',key);await [...s.jobs.values()][0].done;await s.invoke('lecture',key);
    const before=(await s.invoke('result',key)).result;let release,entered;const started=new Promise(r=>entered=r);
    s.finalPassOf=()=>({run:async()=>{entered();await new Promise(r=>release=r);return{text:'invalid markdown',unchanged:false};}});
    const running=s.invoke('final-pass',key);await started;
    await assert.rejects(s.invoke('lecture',key),{code:'BUSY'});await assert.rejects(s.invoke('start',key),{code:'BUSY'});
    release();await assert.rejects(running,{code:'FORMAT'});assert.deepEqual((await s.invoke('result',key)).result,before);
  }finally{await s.dispose();await rm(dir,{recursive:true,force:true});}
});

test('legacy final transcript migrates once into host storage; old review is not mistaken for structured handout',async()=>{
  const {mkdir,writeFile,readFile}=await import('node:fs/promises');
  const dir=await mkdtemp(path.join(tmpdir(),'zhiyun-migrate-'));const s=await wiredFixture(dir);const args={courseId:'10',subId:'20'};
  try{
    const legacy=await s.parser.parseClassroom();legacy.finalPass={text:'旧文本',childEvents:3};legacy.lecture={chapters:[{title:'旧讲义',topics:[]}],warnings:[]};
    const key=s.key({id:'1'},'10','20'),file=s.file(key);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(legacy));
    const results=await Promise.all([s.invoke('result',args),s.invoke('result',args)]);
    assert.ok(results[0].result.sourceVersion);assert.equal(results[0].result.lecture.review,null);assert.ok(results[0].result.lecture.warnings.some(w=>w.includes('旧终审')));
    assert.equal(s.knowledge.size,1);assert.deepEqual(JSON.parse(await readFile(file,'utf8')),legacy);
    await s.invoke('login',{username:'2',password:'fixture'});assert.equal((await s.invoke('result',args)).result,null);
  }finally{await s.dispose();await rm(dir,{recursive:true,force:true});}
});

test('account switch cancels in-flight handout before committing and selection change discards late UI handout',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'zhiyun-account-op-'));const s=await wiredFixture(dir),key={courseId:'10',subId:'20'};
  try{
    await s.invoke('start',key);await [...s.jobs.values()][0].done;const old=s.lectureOf();let entered;const started=new Promise(r=>entered=r);
    s.lectureOf=()=>({...old,assemble:async({signal})=>{entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
    const op=s.invoke('lecture',key);const rejection=assert.rejects(op);await started;await s.invoke('login',{username:'2',password:'fixture'});await rejection;
    assert.equal((await s.invoke('result',key)).result,null);assert.equal(s.knowledge.get({accountId:'1',...key}).lecture,null);
  }finally{await s.dispose();await rm(dir,{recursive:true,force:true});}
  let finish;const pending=new Promise(r=>finish=r);const course={id:'10',title:'课'},a={subId:'20'},b={subId:'21'};
  const c=createStudyController(async(method,payload)=>{if(method==='lecture')return pending;if(method==='result')return {result:{schema:1,blocks:[],lecture:null}};if(method==='content')return {slides:{items:[]},subtitles:{items:[]}};return {items:[],meta:{complete:true}};},{navigate(){}});
  await c.selectLesson(a,course);const generating=c.assembleLecture();await c.selectLesson(b,course);finish({chapters:[{title:'来自上一节'}]});await generating;assert.equal(c.getSnapshot().lecture,null);c.dispose();
});


test('knowledge search distinguishes immutable final transcript from current reviewed handout and never trusts a caller account',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'zhiyun-layer-search-'));const s=await wiredFixture(dir),key={courseId:'10',subId:'20'};
  try{
    await s.invoke('start',key);await [...s.jobs.values()][0].done;await s.invoke('lecture',key);
    assert.equal((await s.invoke('search',{query:'老师原话',layer:'final'})).length,1);
    assert.equal((await s.invoke('search',{query:'写成的正文',layer:'final'})).length,0);
    let hits=await s.invoke('search',{query:'写成的正文',layer:'lecture'});assert.equal(hits[0].matches[0].field,'lecture');assert.equal(hits[0].matches[0].page,1);
    await s.invoke('final-pass',key);hits=await s.invoke('search',{query:'终审整理过',layer:'lecture'});assert.equal(hits.length,1);
    assert.equal((await s.invoke('search',{query:'终审整理过',layer:'final'})).length,0);
    await s.invoke('login',{username:'2',password:'fixture'});assert.deepEqual(await s.invoke('search',{accountId:'1',query:'终审整理过',layer:'all'}),[]);
  }finally{await s.dispose();await rm(dir,{recursive:true,force:true});}
});

test('sessions that cannot be replayed stay out of the study tree and are never queried',async()=>{
  // 上游的节次列表是课程表槽位：未开课/未发布的节次不可回放，也不可能有
  // 解析结果。App 拉全量后在 UI 层丢掉它们（study_section_list.dart:482），
  // 这里保持同一口径，并顺手省掉这些节次的解析状态查询。
  const asked=[];const scheduled=[
    {id:'1_1',courseId:'1',subId:'1',title:'第1-3节',isPlayable:true,status:'6'},
    {id:'1_2',courseId:'1',subId:'2',title:'尚未发布的节次',isPlayable:false,status:'2'},
    {id:'1_3',courseId:'1',subId:'3',title:'缺字段的节次'}];
  assert.deepEqual(playableLessons(scheduled).map((l)=>l.subId),['1','3']);
  assert.deepEqual(playableLessons([]),[]);
  const controller=createStudyController(async(method,payload)=>{
    if(method==='lessons')return{items:scheduled,meta:{complete:true}};
    if(method==='results'){asked.push(...payload.subIds);return{items:Object.fromEntries(payload.subIds.map((subId)=>[subId,{hasResult:false,resultStatus:null,job:null}]))};}
    return{items:[],meta:{complete:true}};
  },{navigate(){}});
  await controller.selectCourse({id:'1'});
  assert.deepEqual(controller.getSnapshot().lessons.map((l)=>l.subId),['1','3']);
  assert.deepEqual([...asked].sort(),['1','3'],'不可回放的节次不应产生解析状态查询');
  assert.deepEqual(controller.getSnapshot().lessonsByCourse['1'].map((l)=>l.subId),['1','3'],'不可回放的节次不进入缓存');
  controller.dispose();
});
