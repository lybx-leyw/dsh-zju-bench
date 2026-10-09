import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as models from '../packages/dsh-zhiyun-classroom/src/models.js';

test('sanitized real API fixture matches recorded Dart model output without a Dart runtime', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/classroom/sanitized-api.json', import.meta.url), 'utf8'));
  const expected = JSON.parse(await readFile(new URL('./fixtures/classroom/dart-models.json', import.meta.url), 'utf8'));
  const omit = (item, keys) => Object.fromEntries(Object.entries(item).filter(([k]) => !keys.includes(k)));
  const actual = { courses: fixture.courses.map(models.course), lessons: fixture.lessons.map(models.lesson).map(l => {
    l = omit(l, ['sourceId', 'isPlayable']); if (l.resources) l.resources = omit(l.resources, ['videoDurationMs']); return l;
  }), slides: fixture.slides.map((row, i) => models.slide(row, i + 1)).map(s => omit(s, ['startMs', 'upstreamId'])),
  subtitles: fixture.subtitles.map(models.subtitle), schedule: fixture.schedule.map(models.scheduleEntry).map(e => omit(e, ['sourceId', 'startMs', 'endMs'])) };
  assert.deepEqual(actual, expected);
});
