// Standalone experiment only: no parser, profile or production storage changes.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {root,locateHost} from './profile.mjs';
import {ClassroomSource} from '../packages/dsh-zhiyun-classroom/src/source.js';
import {HarnessLlm} from '../packages/dsh-zhiyun-parser/src/llm.js';
import {faithfulRequest} from '../packages/dsh-zhiyun-parser/src/prompts.js';
import {LectureParser} from '../packages/dsh-zhiyun-parser/src/parser.js';
import {transcribeSlides} from '../packages/dsh-zhiyun-parser/src/vision.js';

const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
if(!args.includes('--live'))throw Error('Use --live --credentials-file <local file>; real model requests incur cost.');
const env=Object.fromEntries((await fs.readFile(option('--credentials-file',path.join(root,'../zhiyun-pro/.temp_env')),'utf8')).split(/\r?\n/).flatMap(l=>{const m=l.match(/^\s*(?:export\s+)?(\w+)\s*=\s*(.*?)\s*$/);return m?[[m[1],m[2].replace(/^(["'])(.*)\1$/,'$2')]]:[];}));
const rounds=Number(option('--rounds','2')),concurrency=Number(option('--concurrency','3'));
if(!Number.isInteger(rounds)||rounds<1||rounds>10||!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw Error('Invalid rounds/concurrency');
const dir=path.resolve(option('--output',path.join(root,'artifacts/vision-collage')));await fs.mkdir(dir,{recursive:true});
const report={at:new Date().toISOString(),rounds,concurrency,requests:[],errors:[]};
const host=await locateHost(),require=createRequire(path.join(host.app,'package.json'));
const sharp=require('sharp');const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)).href);
const [{Context},{default:Llm},PiAi,{default:Attachments}]=await Promise.all(['cordis','dsh-llm','dsh-llm-pi-ai','dsh-attachment-local'].map(load));
const ctx=new Context();
const source=new ClassroomSource({sessionFile:path.join(root,'.runtime/vision-bench/session.dpapi')});
const secretValues=[env.ZJU_USER,env.ZJU_PASS,...Object.entries(env).filter(([k])=>/KEY|COOKIE/.test(k)).map(([,v])=>v)].filter(Boolean);
const safe=s=>secretValues.reduce((t,key)=>t.replaceAll(key,'[redacted]'),String(s)).replace(/token=[^\s"&]+/g,'token=[redacted]');
try {
 const base=env.FUSION_BASE_URL,model=env.FUSION_VISION_MODEL,key=env.FUSION_API_KEY;
 if(!base||!model||!key)throw Error('Vision model configuration missing');
 process.env.ZHIYUN_VISION_BENCH_KEY=key;
 const endpoint=base.replace(/\/+$/,'').replace(/\/chat\/completions$/,'');
 await ctx.plugin(Llm);await ctx.plugin(Attachments,{dshHome:path.join(root,'.runtime/vision-bench')});
 await ctx.plugin(PiAi,{providers:{'vision-bench':{api:'openai-completions',baseURL:/\/v\d+$/.test(endpoint)?endpoint:endpoint+'/v1',apiKeyEnv:'ZHIYUN_VISION_BENCH_KEY',models:[{id:model,input:['text','image'],contextWindow:1048576,maxTokens:32768,reasoningEfforts:{off:null,high:'high'},compat:{supportsStore:false,supportsDeveloperRole:false,maxTokensField:'max_tokens',thinkingFormat:'deepseek',supportsReasoningEffort:false}}]}}});
 const adapter=new HarnessLlm({llm:ctx.llm,attachments:ctx.attachments,selection:()=>({provider:'vision-bench',model}),timeoutMs:600000});
 let route;
 try{route=(await adapter.resolve()).vision;}catch(e){
  try{await ctx.llm.prepareCall({provider:'vision-bench',model});}catch(detail){throw Error(`Native model route: ${detail.code??''} ${safe(detail.message)}`);}
  throw e;
 }
 report.model=model;report.hostVersion=host.version;report.endpoint=new URL(base).origin;
 let selected;
 try{selected=JSON.parse(await fs.readFile(path.join(dir,'selection.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(!selected){
  const restored=await source.restoreSession();if(!restored.authenticated)await source.login({username:env.ZJU_USER,password:env.ZJU_PASS});
  const courses=await source.listCourses();
  const preferred=courses.items.filter(c=>/计算机视觉/.test(c.title));
  for(const course of [...preferred,...courses.items.filter(c=>!preferred.includes(c))]){
   const lessons=await source.listLessons(course.id);
   for(const lesson of lessons.items.filter(l=>l.isPlayable).slice(0,3)){
    const content=await source.getLessonContent(course.id,lesson.subId);if(content.slides.items.length<16||!content.slides.meta.complete)continue;
    const pages=option('--pages','5,9,13,16').split(',').map(Number);const slides=pages.map(p=>content.slides.items.find(s=>s.page===p));if(slides.some(s=>!s))continue;
    selected={courseTitle:course.title,lessonTitle:lesson.title,pages:[]};
    for(const [i,slide] of slides.entries()){
     const opened=await source.transport.request(slide.imageUrl,{auth:false,stream:true});let bytes;try{if(!opened.response.ok)throw Error('Slide download failed');bytes=Buffer.from(await opened.response.arrayBuffer());}finally{opened.release();}
     const file=`page-${i+1}.png`;await sharp(bytes).png().toFile(path.join(dir,file));const meta=await sharp(bytes).metadata();
     selected.pages.push({page:slide.page,file,width:meta.width,height:meta.height});
    }
    break;
   }
   if(selected)break;
  }
  if(!selected)throw Error('No complete lesson with four representative pages found');
  await fs.writeFile(path.join(dir,'selection.json'),JSON.stringify(selected,null,2));
 }
 report.selection=selected;
 const width=Math.max(...selected.pages.map(p=>p.width)),height=Math.max(...selected.pages.map(p=>p.height)),label=40;
 const panels=[];for(const [i,p] of selected.pages.entries()){
  const left=(i%2)*width,top=Math.floor(i/2)*(height+label);
  panels.push({input:Buffer.from(`<svg width="${width}" height="${label}"><rect width="100%" height="100%" fill="#fff"/><text x="16" y="29" font-size="24" fill="#111">IMAGE ${i+1} / PAGE ${p.page}</text></svg>`),left,top});
  panels.push({input:await fs.readFile(path.join(dir,p.file)),left,top:top+label});
 }
 const collage=await sharp({create:{width:width*2,height:(height+label)*2,channels:3,background:'#ffffff'}}).composite(panels).png().toBuffer();
 await fs.writeFile(path.join(dir,'collage.png'),collage);report.collage={width:width*2,height:(height+label)*2,bytes:collage.length,resized:false,order:'top-left, top-right, bottom-left, bottom-right'};
 if(args.includes('--parser-check')) {
  const parser=new LectureParser({llm:adapter,concurrency,visionBatchSize:4});
  const events=[],warnings=[],signal=AbortSignal.timeout(600000);
  const slides=await Promise.all(selected.pages.map(async p=>({page:p.page,imageBytes:await fs.readFile(path.join(dir,p.file)),mediaType:'image/png'})));
  const started=performance.now();
  const pages=await transcribeSlides(parser,slides,route,selected.courseTitle,signal,events,warnings);
  report.integration={durationMs:Math.round(performance.now()-started),events,warnings,pages:pages.map((p,i)=>({page:slides[i].page,...p}))};
  report.ok=pages.every(p=>p.transcription&&!p.imageFailure)&&events.length===1&&events[0].mode==='collage';
  for(const p of report.integration.pages)if(p.transcription)await fs.writeFile(path.join(dir,`parser-page-${p.page}.md`),p.transcription.raw);
  parser.dispose();
  if(!report.ok)process.exitCode=1;
  console.log(JSON.stringify({ok:report.ok,durationMs:report.integration.durationMs,pages:report.integration.pages.map(p=>p.page),events,warnings}));
 } else {
 const attachments=[];for(const p of selected.pages)attachments.push(await adapter.image(await fs.readFile(path.join(dir,p.file)),'image/png',p.file));
 const collageRef=await adapter.image(collage,'image/png','collage.png');
 const constant=faithfulRequest('',1).constant;
 async function call(round,arm,index){
  const variable=arm==='collage'?`这是一张 2×2 拼图，包含四张独立课件。按左上、右上、左下、右下依次处理，标签 IMAGE 1–4 仅是测试标识。每张分别完整执行上述要求，不概括、不串页，不用其他格补写当前格。严格输出四组，第一组以 # 图1 开头，其后保留 ## 页面文字、## 页面画面、## 术语；其他组依次 # 图2、# 图3、# 图4。每组必须包含全部可见文字和图形关系。`:faithfulRequest(selected.courseTitle,selected.pages[index].page).variable;
  const start=performance.now();const result=await adapter.call({route:{...route,maxTokens:arm==='collage'?32768:8192},constant,variable,image:arm==='collage'?collageRef:attachments[index],stage:'vision-bench'});
  const durationMs=Math.round(performance.now()-start),name=`round-${round}-${arm}${index==null?'':`-${index+1}`}.md`;await fs.writeFile(path.join(dir,name),result.text);
  const item={round,arm,index:index==null?null:index+1,durationMs,usage:result.usage,file:name,characters:result.text.length};report.requests.push(item);console.log(JSON.stringify(item));
 }
 const trials=[];
 async function singles(round){const start=performance.now();let cursor=0;await Promise.all(Array.from({length:concurrency},async()=>{while(cursor<4){const i=cursor++;await call(round,'single',i);}}));return Math.round(performance.now()-start);}
 for(let round=1;round<=rounds;round++){
  let singleWallMs,collageWallMs;const arms=round%2?['single','collage']:['collage','single'];
  for(const arm of arms){if(arm==='single')singleWallMs=await singles(round);else{const start=performance.now();await call(round,'collage',null);collageWallMs=Math.round(performance.now()-start);}}
  trials.push({round,order:arms,singleWallMs,collageWallMs,collageSpeedup:singleWallMs/collageWallMs});report.trials=trials;
 }
 report.ok=true;report.timingIncludes='Host attachment resolution, provider request and complete generation; source download and collage construction excluded equally.';
 report.qualityNote='No automatic semantic quality claim. Inspect originals, individual descriptions and per-panel collage descriptions for exact text, omissions, graph relations and cross-panel contamination.';
 }
}catch(e){report.ok=false;report.errors.push({code:e.code??'BENCH',message:safe(e.message)});console.error(safe(e.message));process.exitCode=1;}
finally{await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));await source.dispose().catch(()=>{});await ctx.fiber.dispose();}
