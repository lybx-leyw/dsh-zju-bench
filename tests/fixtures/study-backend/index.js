// Test-only upstream and deterministic model. Never part of the product profile.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {png,answer} from '../parser/host.mjs';
export const inject=['zhiyunStudy','zhiyunParser','llm','connection','profileContext'];
export async function apply(ctx){
  const require=createRequire(path.join(ctx.profileContext.dir,'package.json'));
  const {LlmAdapter}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
  class Adapter extends LlmAdapter {
    async listModels(){return [{id:'vision',name:'Fixture Vision',inputModalities:['text','image']},{id:'text',name:'Fixture Text',inputModalities:['text']}];}
    async resolveModel(provider,id){return {provider,id,name:id,inputModalities:id==='vision'?['text','image']:['text']};}
    async *stream(options){await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{options.signal.removeEventListener('abort',abort);resolve();},500);const abort=()=>{clearTimeout(timer);reject(options.signal.reason);};options.signal.addEventListener('abort',abort,{once:true});});
      const text=answer(options);yield {type:'text-delta',index:0,text};yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  const unregister=ctx.llm.registerAdapter(['study-fixture'],new Adapter());
  let user=null;
  const meta={complete:true,version:'fixture'};
  const source={
    getCurrentUser:async()=>user,login:async()=>{user={id:'777',name:'测试同学'};return{user};},logout:async()=>{user=null;},
    listCourses:async()=>({items:[{id:'10',title:'概率论与数理统计',teacher:'测试教师',termName:'2026 秋冬',totalCount:3}],meta}),
    listLessons:async()=>({items:[{id:'10_20',courseId:'10',subId:'20',sourceId:'zhiyun:112:10:20',title:'第一节 · 概率密度函数',isPlayable:true},{id:'10_21',courseId:'10',subId:'21',title:'第二节 · 尚未解析',isPlayable:true},{id:'10_22',courseId:'10',subId:'22',title:'第三节 · 尚未发布',isPlayable:false,status:'2'}],meta}),
    getLessonContent:async(_c,subId)=>({sourceId:`zhiyun:112:10:${subId}`,slides:{items:[{page:1,createdSec:1,startMs:1000,imageBytes:png,mediaType:'image/png',imageUrl:'/api/zhiyun-study-slide'}],meta},subtitles:{items:[{startMs:1234,endMs:2000,text:'旧事史'},{startMs:2200,endMs:3100,text:'概率密度函数'}],meta},slidesProcessingSuspected:false})
  };
  const oldSource=ctx.zhiyunStudy.classroom,oldParserSource=ctx.zhiyunParser.classroom,oldRoutes=ctx.zhiyunParser.llm.routes;
  ctx.zhiyunStudy.classroom=source;ctx.zhiyunParser.classroom=source;
  ctx.zhiyunParser.llm.routes={vision:{provider:'study-fixture',model:'vision'},text:{provider:'study-fixture',model:'text'}};
  const remove=ctx.connection.fetch.register({path:'/api/zhiyun-study-slide',methods:['GET'],requestBody:'buffered',fetch:async()=>new Response(png,{headers:{'content-type':'image/png'}})});
  return async()=>{await remove();unregister();ctx.zhiyunStudy.classroom=oldSource;ctx.zhiyunParser.classroom=oldParserSource;ctx.zhiyunParser.llm.routes=oldRoutes;};
}
