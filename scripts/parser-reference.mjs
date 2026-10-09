import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const flutter = path.resolve(root, '../zhiyun-pro');
const uri = file => pathToFileURL(path.join(flutter, 'lib/fusion', file)).href;
const directory = path.join(root, 'artifacts/parser'); await mkdir(directory, { recursive: true });
const script = `import 'dart:convert'; import 'dart:io';
import '${uri('prompt.dart')}'; import '${uri('taxonomy.dart')}';
import '${uri('faithful.dart')}'; import '${uri('cleaning.dart')}';
import '${uri('blocks.dart')}'; import '${uri('pagegate.dart')}';
import '${uri('glossary.dart')}';
void main() {
 final v=TagVocabulary.seed();
 final chunk=buildTagChunkRequestParts(vocabulary:v,contextPath:'context',chunk:[]);
 final tag=buildDimensionTagRequestParts(vocabulary:v,contextPath:'context',catalog:[]);
 final outline=buildSectionOutlineRequestParts(summaries:[],courseContext:'context');
 final prompts={'faithful':faithfulTranscribePrompt,'mix':mixParsePrompt,'dimension':tag.constant,'chunk':chunk.constant.replaceAll(v.promptList,'@@VOCAB@@'),'outline':outline.constant,'vocabulary':v.terms.map((t)=>{'name':t.name,'aliases':t.aliases}).toList(),'stopwords':glossaryStopwords.toList(),'screenshotHints':pageGateScreenshotHints};
 final cases=<Map<String,dynamic>>[];
 for (final response in ['## 逐块标注\\n1. 正文：旧四史\\n块 1-2','## 页面对应\\n1. 不能改\\n## 逐块标注\\n2. 衔接：承接上文\\n块 1-1\\n块 2-2','块 2-2\\n1. 正文：这是完全不同而且过度扩写的一整段新文字','块 1-3','']) {
  final raw=[RawLine(startMs:1234,endMs:2000,page:1,text:'旧事史'),RawLine(startMs:2200,endMs:3100,page:1,text:'概率密度函数')];
  final clean=buildCleanSentences(rawLines:raw,rawResponse:response);
  final drafts=parseBlockDrafts(response,sentenceCount:2,lineBridges:clean.bridges);
  cases.add({'response':response,'sentences':clean.sentences.map((s)=>{'startMs':s.startMs,'endMs':s.endMs,'page':s.page,'text':s.text,'correctionDistance':s.correctionDistance}).toList(),'bridges':clean.bridges,'rejected':clean.rejected.map((r)=>r.index).toList(),'drafts':drafts.map((d)=>{'sentenceFrom':d.sentenceFrom,'sentenceTo':d.sentenceTo,'bridge':d.bridge}).toList(),'coverageOk':validateBlockCoverage(drafts,2).ok});
 }
 final faithful=FaithfulTranscription.parse('## 页面文字\\n概率密度\\n## 页面画面\\n一张曲线图\\n## 术语\\n概率密度函数');
 final mix=buildMixParseRequestParts(contextPath:'context',page:2,windowText:'[00:01]旧事史\\n[00:02]概率密度函数',from:'00:01',to:'00:03',faithfulText:faithful.raw,glossaryTerms:['概率密度函数']);
 final entries=[BlockCatalogEntry(index:1,page:2,from:'00:01',to:'00:03',text:'旧四史\\n概率密度函数',bridge:'接着上文')];
 final actualChunk=buildTagChunkRequestParts(vocabulary:v,contextPath:'context',chunk:entries,totalBlocks:1);
 final actualOutline=buildSectionOutlineRequestParts(summaries:[(index:1,summary:'概率密度函数'),(index:2,summary:'')],courseContext:'context');
 print(jsonEncode({'prompts':prompts,'cases':cases,'faithful':faithful.toJson(),'faithfulRequest':buildFaithfulRequest(contextPath:'context',page:2),'chunk':{'constant':actualChunk.constant,'variable':actualChunk.variable},'outline':{'constant':actualOutline.constant,'variable':actualOutline.variable},'mix':{'constant':mix.constant,'variable':mix.variable}}));
}`;
const runner = path.join(directory, 'reference.dart'); await writeFile(runner, script);
let executable = process.env.DART_EXECUTABLE ?? 'dart';
if (process.platform === 'win32' && !process.env.DART_EXECUTABLE) {
  const resolved = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile','-Command','(Get-Command dart).Source'], { windowsHide: true });
    let out=''; child.stdout.on('data', c => out+=c); child.on('error', reject); child.on('close', code => code===0 ? resolve(out.trim()) : reject(new Error('找不到 Dart')));
  });
  executable = resolved.endsWith('.bat') ? path.join(path.dirname(resolved), 'cache/dart-sdk/bin/dart.exe') : resolved;
  await access(executable);
}
const output = await new Promise((resolve, reject) => {
  const child=spawn(executable,[runner],{windowsHide:true}); const out=[],err=[];
  // ⚠️ 必须攒 Buffer 再整体解 UTF-8：逐块 `out += chunk` 会在**多字节字符
  //    跨块**时把它切成两个替换字符（实测「可选，只在要补时写」变成 `可选��`），
  //    于是这条校验会偶发地报一个假的 deepEqual 失败。
  const capture = (sink, chunk) => sink.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  child.stdout.on('data',c=>capture(out,c)); child.stderr.on('data',c=>capture(err,c));
  child.on('error',reject);
  child.on('close',code=>code===0 ? resolve(JSON.parse(Buffer.concat(out).toString('utf8'))) : reject(new Error(Buffer.concat(err).toString('utf8'))));
});
if (process.argv.includes('--export')) {
  const assets=path.join(root,'packages/dsh-zhiyun-parser/assets'); const fixtures=path.join(root,'tests/fixtures/parser');
  await mkdir(assets,{recursive:true}); await mkdir(fixtures,{recursive:true});
  await writeFile(path.join(assets,'prompts.json'),JSON.stringify(output.prompts,null,2)+'\n');
  await writeFile(path.join(fixtures,'dart-reference.json'),JSON.stringify(output,null,2)+'\n');
} else {
  const stored=JSON.parse(await readFile(path.join(root,'tests/fixtures/parser/dart-reference.json'),'utf8'));
  const { default: assert }=await import('node:assert/strict'); assert.deepEqual(output,stored);
}
console.log('Dart 解析契约、提示词与离线基线验证完成。');
