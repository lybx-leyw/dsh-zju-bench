import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptSettingsSurface } from '../packages/dsh-zhiyun-shell/src/settings-adapter.js';

test('设置适配保留插槽归属与 store，换代和卸载时恢复原组件', () => {
  let entries = [];
  let listener;
  const slots = { entries: () => entries, subscribe: (_, fn) => { listener = fn; return () => { listener = undefined; }; } };
  const wrap = native => ({ native });
  const dispose = adaptSettingsSurface(slots, wrap);
  const first = { component: () => {}, children: { section: {} }, store: {} };
  const original = first.component;
  const children = first.children;
  const store = first.store;
  entries = [first]; listener();
  assert.equal(first.component.native, original);
  assert.equal(first.children, children);
  assert.equal(first.store, store);
  const adapted = first.component;
  listener();
  assert.equal(first.component, adapted, 'registry updates do not wrap twice');
  const second = { component: () => {} };
  const secondOriginal = second.component;
  entries = [second]; listener();
  assert.equal(first.component, original);
  assert.equal(second.component.native, secondOriginal);
  dispose();
  assert.equal(second.component, secondOriginal);
  assert.equal(listener, undefined);
});

test('宿主撤销设置或其他主题接管组件时，清理不覆盖新的所有者', () => {
  let entry = { component: () => {} };
  let listener;
  const original = entry.component;
  const slots = { entries: () => entry ? [entry] : [], subscribe: (_, fn) => { listener = fn; return () => {}; } };
  const dispose = adaptSettingsSurface(slots, native => ({ native }));
  const old = entry;
  entry = undefined; listener();
  assert.equal(old.component, original);
  entry = { component: () => {} }; listener();
  const replacement = () => {};
  entry.component = replacement;
  dispose();
  assert.equal(entry.component, replacement);
});
