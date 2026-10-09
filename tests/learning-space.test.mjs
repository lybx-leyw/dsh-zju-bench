/**
 * 学习空间绑定：确定性挑选 + 标题单一来源。
 *
 * 这两条都不是「实现细节」：挑错了会把用户绑到别的工作区，标题漂了会让
 * 宿主建好的学习空间在客户端**认不出来**（表现是「明明建好了还是要你选」）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pickLearningWorkspace, sessionRows, relativeLabel } from '../packages/dsh-zhiyun-study-core/src/learning-space.js';
import { LEARNING_SPACE_TITLE } from '../packages/dsh-zhiyun-study-core/src/learning-space.js';
import { root } from '../scripts/profile.mjs';

const space = { workspaceId: 'space', title: LEARNING_SPACE_TITLE };
const other = { workspaceId: 'other', title: '另一个项目' };

test('学习空间按标题认出，唯一工作区才兜底，含糊时不猜', () => {
  assert.equal(pickLearningWorkspace([], LEARNING_SPACE_TITLE), undefined);
  assert.equal(pickLearningWorkspace(undefined, LEARNING_SPACE_TITLE), undefined);
  // 标题命中：即使旁边还有别的工作区也认它。
  assert.equal(pickLearningWorkspace([other, space], LEARNING_SPACE_TITLE).workspaceId, 'space');
  // 标题没命中但只有一个：还能确定是它。
  assert.equal(pickLearningWorkspace([other], LEARNING_SPACE_TITLE).workspaceId, 'other');
  // 多个候选且都没命中：真正的歧义 → 交回用户。
  assert.equal(pickLearningWorkspace([other, { workspaceId: 'third', title: '第三个' }], LEARNING_SPACE_TITLE), undefined);
});

test('学习空间标题只有一处字面量：两半都 import 同一个模块', async () => {
  // 领域状态包（dsh-zhiyun-study-core）的两半：宿主半建空间，客户端半把它交给壳。
  const pkg = `${root}packages/dsh-zhiyun-study-core/src/`;
  const host = await readFile(`${pkg}host.js`, 'utf8');
  const client = await readFile(`${pkg}client.jsx`, 'utf8');
  for (const [half, source] of [['宿主半', host], ['客户端半', client]]) {
    assert.match(source, /from '\.\/learning-space\.js'/, `${half}必须 import 共享模块`);
    assert.doesNotMatch(source, new RegExp(LEARNING_SPACE_TITLE), `${half}不许自己再写一遍标题字面量`);
  }
  // 宿主建的是这个标题，客户端认的也必须是它 —— 否则建好了也认不出来。
  assert.match(host, /workspaceRegistry\.create\(dir, LEARNING_SPACE_TITLE\)/);
  assert.match(client, /title: LEARNING_SPACE_TITLE/);
});

test('会话行：只列本空间、最近更新在前、空白会话不编标题', () => {
  const workspace = { workspaceId: 'space', sessionIds: ['old', 'blank', 'missing'] };
  // ⚠️ 宿主的 updatedAt 是毫秒数字（Date.now()），不是 ISO 串 —— 这里按真实形状给。
  const sessions = {
    phase: 'ready',
    byId: {
      old: { displayTitle: '线性代数', blank: false, updatedAt: Date.parse('2026-10-06T10:00:00Z') },
      blank: { displayTitle: '', blank: true, updatedAt: Date.parse('2026-10-06T12:00:00Z') },
    },
  };
  const rows = sessionRows(workspace, sessions);
  assert.deepEqual(rows.map(row => row.id), ['blank', 'old'], '按最近更新排序，未登记的会话不出现');
  assert.equal(rows[0].title, '', '空白会话没有标题 —— 界面才显示「新会话」');
  assert.equal(rows[1].title, '线性代数');
  assert.equal(rows[0].updatedAt, Date.parse('2026-10-06T12:00:00Z'), '时间原样带出去（毫秒）');
  assert.deepEqual(sessionRows(workspace, { phase: 'loading', byId: {} }), [], '还没就绪就不列');
  assert.deepEqual(sessionRows(undefined, sessions), [], '认不出学习空间就不列');
  assert.deepEqual(
    sessionRows(workspace, sessions, 30, ['old']).map(row => row.id),
    ['blank'],
    '归档只留下登记槽，侧边栏不能再画这个壳',
  );
});

test('归档正在看的会话时，不自动再补一条壳', async () => {
  // 这两条钉在壳上：自动绑会话的闸门在壳的 client.jsx，抽屉的拦截在壳的 components.jsx。
  const pkg = `${root}packages/dsh-zhiyun-shell/src/`;
  const client = await readFile(`${pkg}client.jsx`, 'utf8');
  const drawer = await readFile(`${pkg}components.jsx`, 'utf8');
  assert.match(client, /shouldSkipAutoSession\(\)/, '自动绑会话要认得「先别补」');
  assert.match(client, /selection\.subscribe/, '补上的会话真正打开之前不能放开下一次');
  assert.doesNotMatch(client, /queueMicrotask\(\(\) => \{ pending = false; \}\)/, '不能在列表更新时立刻再补一次');
  assert.match(drawer, /holdEmptySession\(\)/, '归档当前会话要先拦住自动补壳');
  assert.match(drawer, /archivedSessionIds/, '列表要吃宿主的归档集合');
});

test('相对时间：毫秒（宿主形状）与 ISO 串都收，认不出就不显示', () => {
  const now = new Date('2026-10-06T12:00:00Z');
  const at = iso => Date.parse(iso);
  // 宿主给的是 Date.now() 的毫秒数。
  assert.equal(relativeLabel(at('2026-10-06T11:59:40Z'), now), '刚刚');
  assert.equal(relativeLabel(at('2026-10-06T11:30:00Z'), now), '30 分钟前');
  assert.equal(relativeLabel(at('2026-10-06T09:00:00Z'), now), '3 小时前');
  assert.equal(relativeLabel(at('2026-10-03T12:00:00Z'), now), '3 天前');
  assert.equal(relativeLabel(at('2026-09-20T12:00:00Z'), now), '9月20日');
  // 历史/别的投影可能是 ISO 串，也认。
  assert.equal(relativeLabel('2026-10-06T11:30:00Z', now), '30 分钟前');
  assert.equal(relativeLabel(undefined, now), '', '没有时间就不显示');
  assert.equal(relativeLabel('', now), '', '解析不出来就不显示时间');
  assert.equal(relativeLabel(0, now), '', '0 不是合法时间，不能显示成 1970 年');
});
