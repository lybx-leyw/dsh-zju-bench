import test from 'node:test';
import assert from 'node:assert/strict';
import {exportReorganization,mergeReorganization} from '../packages/dsh-zhiyun-lecture/src/agent-text.js';
const lecture=()=>({title:'课',chapters:[{no:1,title:'旧章',topics:[{title:'封面',sourceBlockIndexes:[1,2],blocks:[{kind:'definition',title:'定义',text:'定义正文'},{kind:'example',title:'例题',stem:'题目条件',solution:'已讲的解答'}]}]}]});
const record={blocks:[{index:1,page:4,startMs:1000,tag:{role:'主线',summary:'定义'}},{index:2,page:7,startMs:2000,tag:{role:'主线',summary:'例题'}}],outline:[]};
const organized=()=>`#!section x 课
##!topic 1 1 | 概念 | 章=理论
>>> BLOCK 定义 | 概念定义 | ref=c1t1b1 | src=1
定义正文
##!topic 2 1 | 应用 | 章=练习
>>> BLOCK 例题 | 条件与求解 | ref=c1t1b2 | src=2
题目条件
>>> SOLUTION
已讲的解答`;
test('reorganization accepts renaming, new chapters, accurate source-derived anchors and separate examples',()=>{
 const original=lecture(), snapshot=JSON.stringify(original);const out=mergeReorganization(original,organized(),record,'x');
 assert.equal(out.lecture.chapters.length,2);assert.equal(out.lecture.chapters[0].title,'理论');assert.equal(out.lecture.chapters[1].topics[0].title,'应用');
 assert.equal(out.lecture.chapters[1].topics[0].fromPage,7);assert.equal(out.lecture.chapters[1].topics[0].anchor.startMs,2000);
 assert.equal(out.lecture.chapters[1].topics[0].blocks[0].solution,'已讲的解答');assert.equal(JSON.stringify(original),snapshot);
 assert.deepEqual(out.coverage,{unitsBefore:2,unitsCovered:2,sourcesBefore:2,sourcesCovered:2});
 const round=mergeReorganization(out.lecture,exportReorganization(out.lecture,'x',record),record,'x');assert.equal(round.lecture.chapters.length,2);
});
test('malformed or incomplete reorganizations fail instead of silently restoring old titles',()=>{
 for(const text of [organized().replace('ref=c1t1b2','ref=invented'),organized().replace('src=2','src=99'),organized().split('##!topic 2')[0],organized().replace('>>> SOLUTION\n已讲的解答',''),organized().replace('ref=c1t1b1','ref=c1t1b1,c1t1b2').split('##!topic 2')[0],organized().replace('section x','section foreign')])assert.throws(()=>mergeReorganization(lecture(),text,record,'x'),{code:'FORMAT'});
});
test('Markdown body headings survive and split blocks can reference the same original unit',()=>{
 const text=organized().replace('定义正文','### 正文标题\n定义正文\n>>> BLOCK 讲解 | 补充 | ref=c1t1b1 | src=1\n同一原稿的另一部分');const out=mergeReorganization(lecture(),text,record,'x');
 assert.equal(out.lecture.chapters[0].topics[0].blocks.length,2);assert.match(out.lecture.chapters[0].topics[0].blocks[0].text,/### 正文标题/);
});
