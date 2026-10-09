import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCleanSentences, templates, parseBlockDrafts, coverage } from '../packages/dsh-zhiyun-parser/src/core.js';
import { correctionComparison } from '../packages/dsh-zhiyun-parser/src/correction-policy.js';
import { ParserCache } from '../packages/dsh-zhiyun-parser/src/cache.js';
import { mixRequest } from '../packages/dsh-zhiyun-parser/src/prompts.js';
import { lock } from '../scripts/profile.mjs';
import { mountHost, lesson } from './fixtures/parser/host.mjs';

const clean = (original, corrected) => buildCleanSentences(
  [{ text: original, page: 29, startMs: 1000, endMs: 2000 }], `## 逐块标注\n1. 正文：${corrected}`);

test('format-only corrections cost zero while retaining model typography and provenance', () => {
  const original = '“Ｒ₂ − Ｒ₁”，面积Ｒ²。';
  const corrected = '"R2 - R1", 面积 R2.';
  const result = clean(original, corrected);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.sentences, [{ text: corrected, page: 29, startMs: 1000, endMs: 2000, correctionDistance: 0 }]);
  assert.equal(correctionComparison('½\u200b'), correctionComparison('1/2'));
});

test('normalization preserves signs, variable case, numbers and distinct formula symbols', () => {
  for (const [a, b] of [['a+b', 'a-b'], ['P', 'p'], ['q₁', 'q₂'], ['sinθ', 'cosθ'], ['1.2', '12']]) {
    assert.notEqual(correctionComparison(a), correctionComparison(b));
    assert.ok(clean(a, b).sentences[0].correctionDistance > 0 || clean(a, b).rejected.length);
  }
});

test('LaTeX delimiters, known commands, spacing and scripts match equivalent Unicode formulas', () => {
  for (const [original, corrected] of [
    ['R² sinθ dθ', '$R^2\\sin\\theta\\,d\\theta$'],
    ['q₃ = q₁ + q₂', '\\(q_{3}=q_1+q_2\\)'],
    ['σ′=Pcosθ', '$\\sigma′=\\mathbf{P}\\cos\\theta$'],
  ]) {
    assert.equal(correctionComparison(original), correctionComparison(corrected));
    const result = clean(original, corrected);
    assert.equal(result.sentences[0].text, corrected);
    assert.equal(result.sentences[0].correctionDistance, 0);
  }
  assert.notEqual(correctionComparison('$\\unknown{x}$'), correctionComparison('x'));
  assert.notEqual(correctionComparison('$a\\pm b$'), correctionComparison('$a-b$'));
});

test('actual LaTeX formula correction does not count markup as content changes', () => {
  const result = clean('3ac的cos c的dc的。', '$\\sin\\theta\\cos\\theta\\,d\\theta$。');
  assert.deepEqual(result.rejected, []);
  assert.equal(result.sentences[0].correctionDistance, 8);
});

test('single-sentence block declarations keep coverage and their bridge', () => {
  const drafts = parseBlockDrafts('块 1-9\n块 10-20\n  块 21 衔接：进入下一步', 21);
  assert.equal(coverage(drafts, 21).ok, true);
  assert.deepEqual(drafts[2], { sentenceFrom: 21, sentenceTo: 21, bridge: '进入下一步' });
  assert.deepEqual(parseBlockDrafts('块 1-错误', 1, [], { fallback: false }), []);
});

test('all four actual physics corrections rejected by the old policy now pass', () => {
  const cases = [
    ['所以R2乘上3ct。', '所以 R² 乘上 sinθ dθ。'],
    ['对吧，所以就是200平方CAC的呃dc的。', '对吧，所以就是 R² 平方 sinθ 呃 dθ。'],
    ['3ac的cos c的dc的。', 'sinθ cosθ dθ。'],
    ['然后对于qr来说是qa加Q三产业的电视，对qc来说是Q一和Q二产生的电视是这样的。', '然后对于 q₃ 来说是 q₁ 加 q₂ 产生的电势，对 q₂ 来说是 q₁ 和 q₃ 产生的电势是这样的。'],
  ];
  for (const [original, corrected] of cases) {
    const result = clean(original, corrected);
    assert.deepEqual(result.rejected, [], original);
    assert.equal(result.sentences[0].text, corrected);
  }
});

test('long evidence-based corrections are no longer constrained to thirty edits', () => {
  const result = clean('甲'.repeat(50) + '乙'.repeat(50), '丙'.repeat(50) + '乙'.repeat(50));
  assert.equal(result.rejected.length, 0);
  assert.equal(result.sentences[0].correctionDistance, 50);
});

test('complete replacement and excessive expansion still preserve the original', () => {
  for (const [original, corrected] of [['甲乙丙丁戊', '天地玄黄宇'], ['旧事史', '这是完全不同而且过度扩写的一整段新文字']]) {
    const result = clean(original, corrected);
    assert.equal(result.sentences[0].text, original);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0].reason, /80%/);
    assert.ok(result.rejected[0].rawEditDistance >= result.rejected[0].editDistance);
  }
});

test('the live prompt grants formula corrections and matches the relaxed guard', () => {
  const { constant } = mixRequest({ page: 1, lines: [] });
  assert.match(constant, /80 字/);
  assert.match(constant, /80%/);
  assert.match(constant, /数学公式与符号/);
  assert.match(constant, /格式变化本身不占预算/);
  assert.doesNotMatch(constant, /50%|30 字/);
  assert.match(templates.mix, /50%/, 'historical Dart baseline stays unchanged');
});

test('legacy successful cache is revalidated and migrated; invalid cache still requests the model', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiyun-correction-cache-')); let host;
  try {
    host = await mountHost(lock.hostVersions[0], dir);
    const cache = new ParserCache(); host.parser.cache = cache;
    const key = cache.key.bind(cache); let currentKey, legacyKey;
    cache.key = (stage, inputs) => {
      const result = key(stage, inputs);
      if (stage === 'mix' && inputs[1].constant !== templates.mix) {
        currentKey = result; legacyKey = key(stage, [inputs[0], { ...inputs[1], constant: templates.mix }, inputs[2]]);
      }
      return result;
    };
    await host.parser.parse(lesson());
    const raw = (await cache.get(currentKey)).raw;
    cache.memory.delete(currentKey); await cache.put(legacyKey, raw);
    const calls = host.requests.length;
    const migrated = await host.parser.parse(lesson());
    assert.equal(migrated.status, 'ready');
    assert.equal(host.requests.length, calls);
    assert.equal((await cache.get(currentKey)).raw, raw);
    cache.memory.delete(currentKey); await cache.put(legacyKey, '块 1-99');
    const repaired = await host.parser.parse(lesson());
    assert.equal(repaired.status, 'ready');
    assert.equal(host.requests.length, calls + 1);
  } finally { await host?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
