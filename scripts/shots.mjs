/**
 * 视觉抽查：对着正在运行的实例抓几张关键状态的图，用来判断版面/字体问题。
 *
 * 用法：node scripts/shots.mjs "http://127.0.0.1:3082/?token=..."
 * 输出到 artifacts/shots/。
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { root } from './profile.mjs';

const url = process.argv[2];
if (!url) throw new Error('用法：node scripts/shots.mjs "<带 token 的地址>"');
const out = path.join(root, 'artifacts', 'shots');
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ channel: process.env.ZHIYUN_BROWSER_CHANNEL ?? 'msedge', headless: true });
const consoleErrors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, locale: 'zh-CN' });
  page.on('console', message => { if (message.type() === 'error' || message.text().startsWith('[zhiyun')) consoleErrors.push(message.text()); });
  page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('.zy-page[data-page=today]').waitFor({ timeout: 60000 });
  for (const label of ['继续', '稍后配置']) {
    const button = page.getByRole('button', { name: label, exact: true });
    if (await button.isVisible().catch(() => false)) await button.click();
  }
  await page.screenshot({ path: path.join(out, 'today.png'), fullPage: true });
  await page.getByRole('navigation', { name: '主要页面' }).getByRole('button', { name: '问一问', exact: true }).click();
  await page.locator('.zy-topbar').waitFor({ timeout: 30000 });
  await page.screenshot({ path: path.join(out, 'ask.png'), fullPage: true });
  await page.locator('.zy-topbar-menu').click();
  await page.locator('.zy-drawer').waitFor();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, 'ask-drawer.png'), fullPage: true });
  // 抽查用的读数：抽屉是否是 app 那种整高侧边抽屉（锚点/尺寸/遮罩/结构）。
  const drawer = await page.evaluate(() => {
    const node = document.querySelector('.zy-drawer');
    const box = node?.getBoundingClientRect();
    return {
      head: document.querySelector('.zy-drawer-head')?.innerText.replace(/\s+/g, ' '),
      box: box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}` : '缺失',
      scrim: document.querySelector('.zy-drawer-scrim[data-open=true]') !== null,
      rows: [...document.querySelectorAll('.zy-drawer-row')].map(row => ({
        title: row.querySelector('.zy-drawer-name')?.textContent,
        meta: row.querySelector('.zy-drawer-meta')?.textContent,
        current: row.classList.contains('is-current'),
      })),
    };
  });
  console.log(`抽屉：${drawer.head} ｜ 位置尺寸 ${drawer.box} ｜ 遮罩 ${drawer.scrim ? '有' : '无'}`);
  for (const row of drawer.rows) console.log(`  ${row.current ? '▶' : ' '} ${row.title} ｜ ${row.meta || '(无说明)'}`);
  console.log('布局：' + await page.evaluate(() => {
    const frame = document.querySelector('[class*="frame"]');
    return `grid=${getComputedStyle(frame).gridTemplateColumns} ｜ 导航栏右缘=${Math.round(document.querySelector('.zy-sidebar').getBoundingClientRect().right)}`;
  }));
  // 左上 bar 是否贴在问一问面板左缘（决定它是不是「设计的」，而不是浮在空里）。
  console.log('左上bar几何：' + await page.evaluate(() => {
    const r = selector => {
      const node = document.querySelector(selector);
      if (!node) return `${selector}=无`;
      const b = node.getBoundingClientRect();
      return `${selector}: x=${Math.round(b.x)} y=${Math.round(b.y)} w=${Math.round(b.width)} h=${Math.round(b.height)}`;
    };
    return [r('.zy-topbar'), r('.zy-topbar-menu'), r('.zy-topbar-title')].join(' ｜ ');
  }));
  await page.keyboard.press('Escape');
  await page.locator('.zy-drawer').waitFor({ state: 'hidden' });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, 'ask-drawer-closed.png'), fullPage: true });
  for (const [label, pageId] of [['我的课', 'courses'], ['学习', 'study'], ['个人', 'me']]) {
    await page.getByRole('navigation', { name: '主要页面' }).getByRole('button', { name: label, exact: true }).click();
    await page.locator(`.zy-page[data-page=${pageId}]`).waitFor();
  }
  await page.screenshot({ path: path.join(out, 'me.png'), fullPage: true });
  await page.setViewportSize({ width: 760, height: 900 });
  await page.getByRole('navigation', { name: '主要页面' }).getByRole('button', { name: '问一问', exact: true }).click();
  await page.locator('.zy-topbar').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'ask-narrow.png'), fullPage: true });
  console.log(`截图已写入 ${out}`);
  if (consoleErrors.length) console.log(`浏览器报错 ${consoleErrors.length} 条：\n  ${consoleErrors.slice(0, 6).join('\n  ')}`);
} finally {
  await browser.close();
}
