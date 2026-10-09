/**
 * 样式归属守卫：各包样式表之间不许有「靠挂载顺序决胜」的层叠依赖。
 *
 * 为什么值得一条常驻测试：每个包的 style.css 是各自 mountStyle 追加的一张独立
 * <style>，同特异性下胜负只看哪张表后挂载，而挂载顺序取决于各 fiber 的 inject
 * 满足时机。拆包时这里真的踩过一次 —— 原 dsh-zhiyun-study/style.css 尾部的两个
 * @media 被整块留在 ui-primitives（inject 为空、永远最先挂），基规则却跟着组件去了
 * 页面包，移动端覆盖全部变成死规则（≤760 时 .zs-heading 仍是 24px/26px，真机复现）。
 *
 * 这个回归不会让任何断言失败、不会报错、也不影响桌面观感，只会在窄屏上悄悄变丑，
 * 所以只能靠静态守卫拦。
 *
 * 下面除了「真实仓库必须干净」，还有一组**造坏**用例：每条断言守卫确实抓得住一种
 * 已知形状的回归。守卫没牙比没有守卫更糟 —— 它会给出虚假的安心。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { analyzeSheets, loadSheets, parseRules, report, specificity } from '../scripts/check-css-order.mjs';

// 用 fileURLToPath 而不是 url.pathname：后者在 Windows 上会带上开头的 /，且会把
// 路径里的空格百分号编码 —— 仓库放在「带空格的目录」下就会读不到 style.css。
const root = fileURLToPath(new URL('..', import.meta.url));

test('真实仓库：没有跨包 @media 顺序依赖，也没有跨包同属性值竞争', () => {
  const analysis = analyzeSheets(loadSheets(root));
  assert.ok(analysis.sheetCount >= 5, `只读到 ${analysis.sheetCount} 个包的样式表`);
  const lines = [];
  report(analysis, { log: m => lines.push(m), error: m => lines.push(m) });
  assert.deepEqual(analysis.problems, [], `发现靠挂载顺序决胜的层叠依赖：\n${lines.join('\n')}`);
  // 守卫本身要有覆盖面：确实比对到了 media 规则，否则「0 条」可能只是因为什么都没看
  assert.ok(analysis.mediaChecked >= 20, `只比对了 ${analysis.mediaChecked} 条 @media 规则，守卫可能失效`);
  // 同理，跨包那一侧也得真的比对过候选对（真实仓库里有几个跨包共用、但各声明不相交
  // 属性的选择器槽位），否则「0 条竞争」是空话。
  assert.ok(analysis.collisionChecked >= 1, `只比对了 ${analysis.collisionChecked} 对跨包同类规则，守卫可能失效`);
});

test('真实仓库：读到的包就是声明了 CSS 的那几个（漏读会静默少检查一个包）', () => {
  const sheets = loadSheets(root);
  // 这五个包有 src/style.css；其余包没有样式表，不该出现在结果里。
  assert.deepEqual([...sheets.keys()], [
    'dsh-zhiyun-page-courses',
    'dsh-zhiyun-page-me',
    'dsh-zhiyun-page-study',
    'dsh-zhiyun-shell',
    'dsh-zhiyun-ui-primitives',
  ]);
});

/* ------------------------------------------------------- 造坏：确认守卫抓得住 */

test('守卫能发现「@media 覆盖的基规则在别的包」', () => {
  const sheets = new Map([
    // alpha 先挂载（像 ui-primitives），beta 后挂载（像页面包）
    ['dsh-zhiyun-alpha', parseRules('body[data-zhiyun] .zs-heading { margin-bottom: 24px; }\n@media (max-width: 760px) { body[data-zhiyun] .zs-heading { margin-bottom: 18px; } }')],
    ['dsh-zhiyun-beta', parseRules('body[data-zhiyun] .zs-heading { margin-bottom: 24px; }')],
  ]);
  const { problems } = analyzeSheets(sheets);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'media-order');
  assert.equal(problems[0].pkg, 'dsh-zhiyun-alpha');
  assert.match(problems[0].media, /max-width: 760px/);
  assert.deepEqual(problems[0].bases, ['dsh-zhiyun-beta:L1']);
});

test('守卫能发现「跨包用不同的值声明同一个 (选择器, 属性)」', () => {
  const sheets = new Map([
    ['dsh-zhiyun-alpha', parseRules('body[data-zhiyun] .zs-shared { color: red; padding: 4px; }')],
    ['dsh-zhiyun-beta', parseRules('body[data-zhiyun] .zs-shared { color: blue; padding: 4px; }')],
  ]);
  const { problems } = analyzeSheets(sheets);
  // 只有 color 值不同算隐患；padding 两边都是 4px，谁赢都一样
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'cross-package-value');
  assert.equal(problems[0].prop, 'color');
});

test('守卫能发现「简写 vs 它重置的长写」跨包竞争', () => {
  // margin 会重置 margin-bottom，两者争同一块地盘，但属性名字面不同 ——
  // 只比对名字的守卫会漏掉这种情况。
  const sheets = new Map([
    ['dsh-zhiyun-alpha', parseRules('body[data-zhiyun] .zs-box { margin: 4px; }')],
    ['dsh-zhiyun-beta', parseRules('body[data-zhiyun] .zs-box { margin-bottom: 8px; }')],
  ]);
  const { problems } = analyzeSheets(sheets);
  assert.equal(problems.length, 1, `简写/长写竞争未被捕获：${JSON.stringify(problems)}`);
  assert.equal(problems[0].kind, 'cross-package-value');
  assert.match(problems[0].prop, /margin/);
});

/* --------------------------- 造坏：几种「换个写法就漏」的形状（复核报告点出的盲区） */

test('守卫能发现「同一个选择器在别的包里换了拼写」（特异性相同、字符串不同）', () => {
  // 这是最可能重现的形状：两个包给同一个元素的同一属性赋了不同的值，选择器字符串
  // 不相等（中间的祖先链换了写法），但特异性相同 ⇒ 胜负只剩挂载顺序。
  // 只按选择器字符串全等建索引的守卫会完全看不见这种。
  const sheets = new Map([
    ['dsh-zhiyun-alpha', parseRules('.zs-study .zs-heading h1 { font-size: 26px; }')],
    ['dsh-zhiyun-beta', parseRules('[data-zhiyun] .zs-heading h1 { font-size: 99px; }')],
  ]);
  // 前置条件：两条选择器确实特异性相同，否则这个用例证明不了「按字符串配对」的盲区
  assert.deepEqual(specificity('.zs-study .zs-heading h1'), [0, 2, 1]);
  assert.deepEqual(specificity('[data-zhiyun] .zs-heading h1'), [0, 2, 1]);
  const { problems } = analyzeSheets(sheets);
  assert.equal(problems.length, 1, `拼写差异导致的真实冲突未被捕获：${JSON.stringify(problems)}`);
  assert.equal(problems[0].kind, 'cross-package-value');
  assert.equal(problems[0].prop, 'font-size');
});

test('守卫不误报：主题作用域前缀不同会改变特异性，因而由特异性决胜、与顺序无关', () => {
  // 复核报告把这一条列为「换了拼写就会漏」，但 `body[data-zhiyun]` 前缀会抬高特异性
  // （属性选择器算 class 级），带前缀的那条**无论挂载顺序都赢** —— 这是确定性结果，
  // 不是顺序依赖。守卫按特异性过滤是正确的；把它报出来反而是误报。
  const sheets = new Map([
    ['dsh-zhiyun-alpha', parseRules('body[data-zhiyun] .zs-heading h1 { font-size: 26px; }')],
    ['dsh-zhiyun-beta', parseRules('.zs-heading h1 { font-size: 99px; }')],
  ]);
  assert.deepEqual(specificity('body[data-zhiyun] .zs-heading h1'), [0, 2, 2]);
  assert.deepEqual(specificity('.zs-heading h1'), [0, 1, 1]);
  const { problems } = analyzeSheets(sheets);
  assert.deepEqual(problems, [], `特异性不同不该报：${JSON.stringify(problems)}`);
});

test('守卫能发现跨包「不同的 @media 条件在同一宽度下都生效」', () => {
  // 两个包的 @media 条件不同（1050 vs 760），但在 700px 下都命中 ——
  // 只按 (选择器, 媒体条件) 精确配对的守卫会漏。
  const sheets = new Map([
    ['dsh-zhiyun-alpha', parseRules('@media (max-width: 1050px) { body[data-zhiyun] .zs-workbench { grid-template-columns: 210px 1fr; } }')],
    ['dsh-zhiyun-beta', parseRules('@media (max-width: 760px) { body[data-zhiyun] .zs-workbench { grid-template-columns: 1fr; } }')],
  ]);
  const { problems } = analyzeSheets(sheets);
  assert.equal(problems.length, 1, `跨包不同媒体条件的冲突未被捕获：${JSON.stringify(problems)}`);
  assert.equal(problems[0].kind, 'cross-package-value');
});

test('守卫能发现「同一个包内 @media 覆盖写在了基规则之前」', () => {
  // 同包内也是后写的赢；覆盖排在基规则之前就是死规则，且不会有任何报错。
  const sheets = new Map([
    ['dsh-zhiyun-alpha', parseRules('@media (max-width: 760px) { body[data-zhiyun] .zs-x { padding: 12px; } }\nbody[data-zhiyun] .zs-x { padding: 30px; }')],
  ]);
  const { problems } = analyzeSheets(sheets);
  assert.equal(problems.length, 1, `同包倒序未被捕获：${JSON.stringify(problems)}`);
  assert.equal(problems[0].kind, 'dead-media');
  assert.equal(problems[0].base, 'dsh-zhiyun-alpha:L2');
});

test('守卫不误报：跨包但特异性不同（高的那条无论顺序都赢）', () => {
  const sheets = new Map([
    ['dsh-zhiyun-alpha', parseRules('body[data-zhiyun] .zs-x { color: red; }')],
    ['dsh-zhiyun-beta', parseRules('body[data-zhiyun] #zs-target .zs-x { color: blue; }')],
  ]);
  const { problems } = analyzeSheets(sheets);
  assert.deepEqual(problems, [], `特异性不同不该报：${JSON.stringify(problems)}`);
});

test('守卫不误报：值相同（谁赢都一样），以及大小写不同的同值颜色', () => {
  const sheets = new Map([
    ['dsh-zhiyun-alpha', parseRules('body[data-zhiyun] .zs-x { color: RED; padding: 4px; }')],
    ['dsh-zhiyun-beta', parseRules('body[data-zhiyun] .zs-x { color: red; padding: 4px; }')],
  ]);
  const { problems } = analyzeSheets(sheets);
  assert.deepEqual(problems, [], `同值不该报：${JSON.stringify(problems)}`);
});

test('守卫不误报：两个包各管主体不同的元素，即使类名有重合', () => {
  // 主体不同的规则不可能命中同一个元素，不该因为「共享了一个祖先类名」而误报。
  const sheets = new Map([
    ['dsh-zhiyun-alpha', parseRules('body[data-zhiyun] .zs-study .zs-card { color: red; }')],
    ['dsh-zhiyun-beta', parseRules('body[data-zhiyun] .zs-study .zs-chip { color: blue; }')],
  ]);
  const { problems } = analyzeSheets(sheets);
  assert.deepEqual(problems, [], `主体不同不该报：${JSON.stringify(problems)}`);
});

test('守卫不误报：分属两包的 margin-top 与 margin-bottom 互不重置', () => {
  // 两个长写之间没有覆盖关系，哪个赢都对彼此无影响。
  const sheets = new Map([
    ['dsh-zhiyun-alpha', parseRules('body[data-zhiyun] .zs-box { margin-top: 4px; color: red; }')],
    ['dsh-zhiyun-beta', parseRules('body[data-zhiyun] .zs-box { margin-bottom: 8px; color: red; }')],
  ]);
  const { problems } = analyzeSheets(sheets);
  assert.deepEqual(problems, [], `不应误报：${JSON.stringify(problems)}`);
});

test('守卫不误报：自足的 @media（基规则和覆盖同包、覆盖在后）与 @keyframes 内部选择器', () => {
  const sheets = new Map([
    ['dsh-zhiyun-alpha', parseRules(`
      body[data-zhiyun] .zs-workbench { display: grid; }
      @media (max-width: 760px) { body[data-zhiyun] .zs-workbench { display: flex; } }
      @keyframes zs-spin { from { opacity: 0; } to { opacity: 1; } }
    `)],
    ['dsh-zhiyun-beta', parseRules('body[data-zhiyun] .zs-other { color: red; }')],
  ]);
  const { problems } = analyzeSheets(sheets);
  assert.deepEqual(problems, [], `不应误报：${JSON.stringify(problems)}`);
});

test('守卫不误报：媒体条件互斥（min-width 与 max-width 不重叠）', () => {
  const sheets = new Map([
    ['dsh-zhiyun-alpha', parseRules('@media (min-width: 900px) { body[data-zhiyun] .zs-x { font-size: 20px; } }')],
    ['dsh-zhiyun-beta', parseRules('@media (max-width: 760px) { body[data-zhiyun] .zs-x { font-size: 12px; } }')],
  ]);
  const { problems } = analyzeSheets(sheets);
  assert.deepEqual(problems, [], `互斥媒体条件不该报：${JSON.stringify(problems)}`);
});

/* ------------------------------------------------------------------ 选择器工具 */

test('特异性计算覆盖 :is/:where/#id/属性/伪元素', () => {
  // 注意 `body[data-zhiyun] .zs-heading h1` 是 [0,2,2]：属性选择器与类同级，
  // 主题作用域前缀会实实在在抬高特异性 —— 这一点决定了「跨包覆盖」是否由顺序决胜。
  assert.deepEqual(specificity('body[data-zhiyun] .zs-heading h1'), [0, 2, 2]);
  assert.deepEqual(specificity('.zs-x'), [0, 1, 0]);
  assert.deepEqual(specificity('#a .b c'), [1, 1, 1]);
  assert.deepEqual(specificity(':where(#a) .b'), [0, 1, 0], ':where() 计 0');
  assert.deepEqual(specificity(':is(#a, .b)'), [1, 0, 0], ':is() 取最高的那个');
  assert.deepEqual(specificity('.zs-icon-button::before'), [0, 1, 1]);
  assert.deepEqual(specificity('*'), [0, 0, 0]);
});

/* -------------------------------------------------------------- 递归读样式表 */

test('loadSheets 递归读 src 下的所有 .css，不只读 style.css', () => {
  // 只认 src/style.css 会让后来新增的 src/settings.css 整个逃出检查范围。
  const sheets = loadSheets(root);
  const totalRules = [...sheets.values()].reduce((n, rules) => n + rules.length, 0);
  assert.ok(totalRules >= 500, `只解析出 ${totalRules} 条规则，样式表可能没读全`);
});

/* ---------------------------------------------------------------------- 退出码 */

test('退出码：有问题返回 1，没问题返回 0', () => {
  const clean = analyzeSheets(new Map([['dsh-zhiyun-alpha', parseRules('.a { color: red; }')]]));
  assert.equal(report(clean, { log: () => {}, error: () => {} }), 0);
  const dirty = analyzeSheets(new Map([
    ['dsh-zhiyun-alpha', parseRules('.a { color: red; }')],
    ['dsh-zhiyun-beta', parseRules('.a { color: blue; }')],
  ]));
  assert.equal(report(dirty, { log: () => {}, error: () => {} }), 1);
});
