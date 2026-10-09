import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { initialize, lock, root, runHost } from './profile.mjs';
import { LEARNING_SPACE_TITLE } from '../packages/dsh-zhiyun-study-core/src/learning-space.js';

const evidence = path.join(root, 'artifacts');

/** The host runs its own first-run steps — the developer-preview notice and the
 *  "add an API key" model step. They belong to host onboarding, not to this
 *  product, so acknowledge them the way a user would (继续 / 稍后配置) and then
 *  require a genuinely quiet page before touching it. Only a *visible* mask
 *  counts: the modal layer stays attached when nothing is open. */
async function settleHostOverlays(page) {
  const steps = [
    page.getByRole('button', { name: '继续', exact: true }),
    page.getByRole('button', { name: '稍后配置', exact: true }),
  ];
  const mask = page.locator('div[role="presentation"] > div[aria-hidden="true"]').first();
  const deadline = Date.now() + 45000;
  let quiet = 0;
  while (Date.now() < deadline) {
    let acknowledged = false;
    for (const step of steps) {
      if (!await step.isVisible().catch(() => false)) continue;
      // 0.2.1-alpha 的「继续」先禁用、等一个异步步骤之后才可点：
      // 可见 ≠ 可点，硬点会让 Playwright 一直等 enabled 直到超时。
      if (!await step.isEnabled().catch(() => false)) continue;
      try {
        await step.click({ timeout: 5000 });
      } catch {
        // 弹层可能在点击途中被宿主换掉（新版会自己消失）——下一轮再看，不算失败。
      }
      acknowledged = true;
      break;
    }
    if (acknowledged) { quiet = 0; continue; }
    quiet = (await mask.isVisible().catch(() => false)) ? 0 : quiet + 1;
    if (quiet >= 8) return;
    await page.waitForTimeout(250);
  }
  throw new Error('a host onboarding overlay is still blocking the page after 45s');
}

/** Load the document again and wait for the product page to mount. A row added
 *  to the profile joins the browser boot graph on the next document load: the
 *  host injects window.__DSH_BOOT__ per index.html request. */
async function reloadProduct(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await settleHostOverlays(page);
  await page.locator('.zy-page[data-page=today]').waitFor({ timeout: 60000 });
}
await mkdir(evidence, { recursive: true });
let server;
let browser;
let hostLog = '';
let runtime;
const errors = [];
const checks = [];
try {
  let url = process.env.ZHIYUN_TEST_URL;
  if (!url && process.argv.includes('--running')) {
    url = (await readFile(path.join(root, 'host.log'), 'utf8')).match(/dsh web: (http:\/\/\S+)/)?.[1];
  }
  if (!url) {
    runtime = await initialize({ home: path.join(evidence, `host-${Date.now()}`) });
    await symlink(path.join(root, 'tests/fixtures/course-panel'), path.join(runtime.profile, 'node_modules', 'zhiyun-test-course-panel'), process.platform === 'win32' ? 'junction' : 'dir');
    server = runHost(runtime, ['--no-open', '--port', '0'], { pipe: true });
    url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Host startup timed out: ${hostLog.slice(-3000)}`)), 180000);
      const consume = data => {
        hostLog += data;
        const match = hostLog.match(/dsh web: (http:\/\/\S+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      };
      // 按 UTF-8 **整体**解码：逐块拼字符串会在汉字跨块时产生替换字符，污染启动日志。
      server.stdout.setEncoding('utf8');
      server.stderr.setEncoding('utf8');
      server.stdout.on('data', consume);
      server.stderr.on('data', consume);
      server.on('error', error => { clearTimeout(timeout); reject(error); });
      server.on('exit', code => { clearTimeout(timeout); reject(new Error(`Host exited ${code}: ${hostLog.slice(-2000)}`)); });
    });
  }
  browser = await chromium.launch({ channel: process.env.ZHIYUN_BROWSER_CHANNEL ?? 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, locale: 'zh-CN', colorScheme: 'light' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('.zy-page[data-page=today]').waitFor({ timeout: 60000 });
  await settleHostOverlays(page);
  if (await page.locator('body').evaluate(body => body.hasAttribute('data-ds-dark-theme'))) {
    await page.getByRole('button', { name: '切换明暗', exact: true }).click();
    await page.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme'));
  }
  checks.push('Real host boot and initial Today selection');
  assert.equal(await page.getByRole('navigation', { name: '主要页面' }).getByRole('button').count(), 5);
  await page.screenshot({ path: path.join(evidence, 'today-light.png'), fullPage: true });
  for (const [label, id] of [['我的课', 'courses'], ['学习', 'study'], ['个人', 'me']]) {
    await page.getByRole('navigation', { name: '主要页面' }).getByRole('button', { name: label, exact: true }).click();
    await page.locator(`.zy-page[data-page=${id}]`).waitFor();
  }
  checks.push('All product pages navigate through host layout');
  await page.getByRole('navigation', { name: '主要页面' }).getByRole('button', { name: '学习', exact: true }).click();
  await page.getByRole('button', { name: '前往个人面板登录' }).waitFor();
  await page.getByRole('button', { name: '前往个人面板登录' }).click();
  await page.getByRole('region', { name: '智云课堂账号' }).waitFor();
  await page.getByLabel('浙大账号', { exact: true }).waitFor();
  await page.getByRole('navigation', {name:'主要页面'}).getByRole('button',{name:'学习',exact:true}).click();
  await page.screenshot({ path: path.join(evidence, 'study.png'), fullPage: true });
  await page.keyboard.press('Control+k');
  await page.getByRole('textbox', { name: '搜索页面' }).fill('今天');
  await page.keyboard.press('Enter');
  await page.locator('.zy-page[data-page=today]').waitFor();
  checks.push('Search dialog and keyboard navigation');
  await page.getByRole('button', { name: '切换明暗', exact: true }).click();
  await page.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'));
  await page.screenshot({ path: path.join(evidence, 'today-dark.png'), fullPage: true });
  await page.getByRole('button', { name: '切换明暗', exact: true }).click();
  await page.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme'));
  checks.push('Native theme service switches light/dark');
  await page.getByRole('navigation', { name: '主要页面' }).getByRole('button', { name: '问一问', exact: true }).click();
  await page.locator('.zy-hero-brand').waitFor();
  checks.push('Native DSH conversation remains mounted with Zhiyun hero');
  // 「问一问」is bound to the workbench's own learning space: the composer comes up
  // ready instead of asking which directory to use, and that space is the one shown.
  await page.waitForFunction(() => !document.body.innerText.includes('选择一个工作区开始'), undefined, { timeout: 30000 });
  assert.ok((await page.locator('body').innerText()).includes(LEARNING_SPACE_TITLE), 'the fixed learning space is selected');
  await page.screenshot({ path: path.join(evidence, 'ask.png'), fullPage: true });
  checks.push('Ask binds the fixed learning space instead of asking to choose a workspace');
  // 会话管理在「问一问」的版面上：侧栏不再挂宿主的工作区浏览器（没有工作区切换）。
  assert.equal(await page.locator('[data-slot="sidebar.workspaces"]').count(), 0, 'the host workspace browser must not be mounted');
  const sidebarText = await page.locator('.zy-sidebar').innerText();
  assert.equal(sidebarText.includes('工作区'), false, 'the sidebar must not offer workspace switching');
  assert.equal(sidebarText.includes('会话记录'), false, 'the sidebar must not host the session list');
  await page.locator('.zy-topbar').waitFor();
  // 会话抽屉 = 对齐 app 的**左侧整高抽屉**：贴问一问面板左缘、整高、有遮罩、Esc/遮罩可关。
  const sidebarRight = await page.locator('.zy-sidebar').evaluate(node => Math.round(node.getBoundingClientRect().right));
  const viewport = page.viewportSize();
  await page.locator('.zy-topbar-menu').click();
  const drawer = page.locator('.zy-drawer');
  await drawer.waitFor();
  await page.waitForTimeout(400);
  const drawerBox = await drawer.boundingBox();
  assert.equal(await drawer.getAttribute('data-open'), 'true', 'the top-left hamburger opens the drawer');
  assert.ok(drawerBox.height >= viewport.height * 0.95, `the drawer must span the full height (${Math.round(drawerBox.height)} of ${viewport.height})`);
  assert.ok(Math.abs(drawerBox.x - sidebarRight) <= 2, `the drawer must start at the Ask panel's left edge (x=${Math.round(drawerBox.x)}, sidebar right=${sidebarRight})`);
  assert.ok(drawerBox.width >= 280, `the drawer must keep the Material width (${Math.round(drawerBox.width)}px)`);
  assert.equal(await page.locator('.zy-drawer-scrim[data-open=true]').count(), 1, 'an open drawer carries its scrim');
  // 当前会话必须**恰好**标记一行：0.2 把 `current` 从 session controller 移走了，
  // 早先这里读它，结果高亮永远不亮（也不再有「当前」这个概念可用）。
  assert.equal(await page.locator('.zy-drawer-row.is-current').count(), 1, 'exactly one row is the current session');
  assert.equal(await page.locator('.zy-drawer-head').count(), 1, 'the drawer carries its own header');
  await page.screenshot({ path: path.join(evidence, 'ask-sessions.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.zy-drawer-scrim[data-open=true]').count(), 0, 'Esc closes the drawer and its scrim');
  await page.locator('.zy-topbar-menu').click();
  await drawer.waitFor();
  await page.waitForTimeout(300);
  await page.locator('.zy-drawer-scrim').click({ position: { x: 500, y: 400 } });
  await drawer.waitFor({ state: 'hidden' });
  checks.push('Session management is a full-height left drawer attached to the Ask panel');
  await page.getByRole('button', { name: '个人', exact: true }).click();
  const settings = page.locator('.zy-settings-group');
  await settings.first().waitFor();
  assert.ok(await settings.count() >= 2, 'host settings providers appear inside Personal');
  assert.equal(await page.locator('.zy-sidebar').getByRole('button', { name: '设置', exact: true }).isVisible(), false);
  // ⚠️ 用 `:scope > summary`：宿主某些设置分组内部还会渲染**嵌套**的 details，
  //    裸 `locator('summary')` 会同时命中子节点，触发 strict mode 冲突。
  await settings.first().locator(':scope > summary').click();
  assert.ok(await settings.first().locator(':scope > .zy-settings-body').isVisible());
  assert.equal(await page.locator('[role="dialog"]:visible').count(), 0, 'settings expand inline');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(evidence, 'settings.png'), fullPage: true });
  for (const group of await settings.all()) {
    if (!await group.evaluate(node => node.open)) await group.locator(':scope > summary').click();
    assert.ok(await group.locator(':scope > .zy-settings-body').isVisible());
    assert.ok((await group.locator(':scope > .zy-settings-body').innerText()).trim().length > 0);
    await group.locator(':scope > summary').click();
  }
  await page.locator('.zy-scroll').evaluate(node => { node.scrollTop = 0; });
  if (await page.locator('body').evaluate(body => body.hasAttribute('data-ds-dark-theme'))) {
    await page.locator('.zy-page-header').getByRole('button', { name: '切换明暗', exact: true }).click();
    await page.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme'));
  }
  await page.screenshot({ path: path.join(evidence, 'personal-light.png'), fullPage: true });
  await page.locator('.zy-page-header').getByRole('button', { name: '切换明暗', exact: true }).click();
  await page.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'));
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(evidence, 'personal-dark.png'), fullPage: true });
  await page.locator('.zy-page-header').getByRole('button', { name: '切换明暗', exact: true }).click();
  await page.getByRole('button', { name: '今天', exact: true }).click();
  await page.keyboard.press('Control+Alt+Comma');
  await page.locator('.zy-page[data-page=me]').waitFor();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-modal="true"]'));
  await page.setViewportSize({ width: 760, height: 900 });
  const models = page.locator('[data-settings-section="models"]');
  await models.locator(':scope > summary').click();
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.locator('.zy-scroll').evaluate(node => node.scrollWidth > node.clientWidth), false, 'Personal forms fit a narrow column');
  await page.screenshot({ path: path.join(evidence, 'personal-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 980 });
  checks.push('Native settings providers expand inline inside Personal');
  // Every document load goes through the same onboarding handling: the host's
  // model step reappears per load whenever no model is configured.
  await reloadProduct(page);
  await page.getByRole('button', { name: '收起导航', exact: true }).click();
  await page.locator('.zy-collapsed').waitFor();
  await page.screenshot({ path: path.join(evidence, 'navigation-collapsed.png'), fullPage: true });
  await page.getByRole('button', { name: '展开导航', exact: true }).click();
  await page.setViewportSize({ width: 760, height: 900 });
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, 'window must not overflow horizontally');
  await page.screenshot({ path: path.join(evidence, 'today-narrow.png'), fullPage: true });
  checks.push('Collapsed navigation and narrow window');
  if (runtime) {
    const patch = path.join(runtime.profile, 'cordis.patch.yml');
    // Installing a row is an install: the file watcher applies the new layer
    // first, then the next document load carries the new entry in its boot graph.
    await writeFile(patch, '- insert:\n    - id: test-course-panel\n      name: zhiyun-test-course-panel\n');
    await page.waitForTimeout(800);
    await reloadProduct(page);
    await page.getByRole('navigation', { name: '主要页面' }).getByRole('button', { name: '我的课', exact: true }).click();
    await page.locator('[data-test-course-provider]').waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: '返回今天', exact: true }).click();
    await page.locator('.zy-page[data-page=today]').waitFor();
    await writeFile(patch, '[]\n');
    await page.waitForTimeout(800);
    await reloadProduct(page);
    assert.equal(await page.locator('[data-test-course-provider]').count(), 0, 'an uninstalled plugin must leave no rendered content');
    checks.push('Independent plugin contributes course content and drives navigation through the product service');

    // Disabling the product bundle is a removal: the host sidebar and the
    // official theme come back, with no leftover styles or slot occupants.
    // 拆包后「产品」= 壳 + 共享原语 + 领域核心 + 四个页面包，要一起停 —— 页面包在
    // dsh.client.external 里声明了原语包，只停一半会让模块表缺行（require 落空）。
    await writeFile(patch, '- id: zhiyun-shell\n  disabled: true\n- id: zhiyun-ui-primitives\n  disabled: true\n- id: zhiyun-study-core\n  disabled: true\n- id: zhiyun-page-today\n  disabled: true\n- id: zhiyun-page-courses\n  disabled: true\n- id: zhiyun-page-study\n  disabled: true\n- id: zhiyun-page-me\n  disabled: true\n- id: ui-sidebar\n  disabled: false\n');
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settleHostOverlays(page);
    await page.waitForFunction(() => !document.body.hasAttribute('data-zhiyun'), undefined, { timeout: 60000 });
    assert.equal(await page.locator('style[data-zhiyun-style]').count(), 0);
    assert.equal(await page.locator('.zy-sidebar').count(), 0);
    await page.screenshot({ path: path.join(evidence, 'disabled-host-sidebar.png'), fullPage: true });
    await writeFile(patch, '[]\n');
    await page.waitForTimeout(800);
    await reloadProduct(page);
    assert.equal(await page.locator('style[data-zhiyun-style]').count(), 1);
    checks.push('Disabling the product bundle retracts its styles and slots and restores the host sidebar');
  }
  assert.deepEqual(errors, [], 'No browser activation/render errors');
  if (runtime) {
    assert.ok(hostLog.includes('ZHIYUN_CLASSROOM_HOST_READY'), 'Business plugin injected the real classroom service in this host');
    checks.push('Independent business plugin injects the classroom source from the product profile');
    assert.ok(hostLog.includes('ZHIYUN_PARSER_HOST_READY'), 'Business plugin injected the parser in this host');
    checks.push('Independent business plugin injects the parser backed by host LLM and attachments');
    // 讲义装配与无曰终审也必须在**真实宿主**里激活过：单测用的是假 ctx，
    // 而 `inject` 了一个不存在的服务只有在真宿主里才表现为永远 pending。
    assert.ok(hostLog.includes('ZHIYUN_LECTURE_HOST_READY'), 'Lecture assembler activated in this host');
    assert.ok(hostLog.includes('ZHIYUN_FINAL_PASS_HOST_READY'), 'Final-pass agent service activated on the host agent runtime');
    assert.ok(hostLog.includes('ZHIYUN_STORE_HOST_READY'), 'Quiz, notes and knowledge services activated from the product profile');
    checks.push('Lecture assembler and agent-runtime final pass activate from the product profile');
    checks.push('Quiz, notes and knowledge storage services activate from the product profile');
  }
  const hostVersion = runtime?.version ?? lock.hostVersions.join(' / ');
  const report = JSON.stringify({ checks, errors, hostVersion }, null, 2);
  await writeFile(path.join(evidence, 'host-report.json'), report);
  // 每个宿主版本各留一份：支持多个版本时，「哪一版过了」必须可查，不能被下次运行覆盖。
  await writeFile(path.join(evidence, `host-report-${hostVersion}.json`), report);
  await page.screenshot({ path: path.join(evidence, `today-${hostVersion}.png`), fullPage: true });
  console.log(checks.map(check => `PASS ${check}`).join('\n'));
} catch (error) {
  await writeFile(path.join(evidence, 'host-log.txt'), hostLog.replace(/token=[^\s]+/g, 'token=[redacted]'));
  await writeFile(path.join(evidence, 'host-errors.json'), JSON.stringify({ error: error.message, errors, checks }, null, 2));
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) {
      await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
      await writeFile(path.join(evidence, 'failure.txt'), await page.locator('body').innerText());
    }
  }
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill();
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 6000))]);
  }
}
