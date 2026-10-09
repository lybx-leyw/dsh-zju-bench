import test from 'node:test';
import assert from 'node:assert/strict';
import { exportLectureForAgent, mergeAgentLectureText } from '../packages/dsh-zhiyun-lecture/src/agent-text.js';
import { countShape } from '../packages/dsh-zhiyun-final-pass/src/index.js';
const lecture = () => ({ title: '完整课堂', chapters: [{ no: 1, title: '概率', topics: [
  { title: '独立性', fromPage: 2, toPage: 4, sourceBlockIndexes: [3, 5], anchor: { page: 2, tSec: 120 }, draft: '课堂原话', passages: [{ text: '修改前的正文' }], register: 'draft' },
  { title: '条件概率', fromPage: 5, toPage: 6, sourceBlockIndexes: [8], passages: [{ text: '保留的另一知识点' }], anchor: { page: 5, tSec: 180 } },
] }] });
test('App handout export matches the actual final-pass marker contract; roundtrip preserves anchors and body', () => {
  const original = lecture(), text = exportLectureForAgent(original, 'account-course-lesson');
  assert.match(text, /^#!section account-course-lesson /);
  assert.deepEqual(countShape(text), { topics: 2, blocks: 2 });
  const merged = mergeAgentLectureText(original, text).lecture;
  assert.deepEqual(merged.chapters[0].topics[0].anchor, original.chapters[0].topics[0].anchor);
  assert.equal(merged.chapters[0].topics[0].passages[0].text, '修改前的正文');
});
test('App merge changes only handout bodies, accepts splits, keeps missing topics and ignores invented identities', () => {
  const original = lecture(), snapshot = JSON.stringify(original);
  const text = '#!section x\n##!topic 1 1 | 改坏的标题 | P99-100 | src=90\n>>> BLOCK 定义 | 独立事件\n新的定义\n>>> BLOCK 例题 | 骰子\n题干与解答\n##!topic 20 20\n>>> BLOCK 讲解\n不存在的知识点';
  const result = mergeAgentLectureText(original, text);
  assert.equal(result.updated, 1); const topic = result.lecture.chapters[0].topics[0];
  assert.equal(topic.title, '独立性'); assert.equal(topic.fromPage, 2); assert.deepEqual(topic.sourceBlockIndexes, [3, 5]);
  assert.deepEqual(topic.anchor, { page: 2, tSec: 120 }); assert.equal(topic.blocks.length, 2);
  assert.equal(topic.blocks[1].stem, '题干与解答');
  assert.deepEqual(result.lecture.chapters[0].topics[1], original.chapters[0].topics[1]);
  assert.equal(JSON.stringify(original), snapshot);
});
test('Unparseable review is rejected; examples retain stem and solution on export', () => {
  assert.throws(() => mergeAgentLectureText(lecture(), '# 普通 Markdown\n没有标记'), { code: 'FORMAT' });
  const original = lecture(); original.chapters[0].topics[0].blocks = [{ kind: 'example', stem: '例题题干', solution: '例题解答', title: '练习' }];
  const text = exportLectureForAgent(original, 'x'); assert.ok(text.includes('例题题干\n\n例题解答'));
});
