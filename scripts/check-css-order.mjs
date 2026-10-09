#!/usr/bin/env node
// 检查各包样式表之间有没有「靠挂载顺序决胜」的层叠依赖。
//
// 背景：每个包的 style.css 是各自 mountStyle 追加的一张独立 <style>，同特异性下
// 胜负只看哪张表后挂载，而挂载顺序取决于各 fiber 的 inject 满足时机（不是 profile 顺序）。
// 拆包时这里真的踩过一次：原 dsh-zhiyun-study/style.css 尾部的两个 @media 被整块留在
// ui-primitives（inject 为空、永远最先挂），而基规则跟着组件去了页面包，于是移动端覆盖
// 全部变成死规则 —— ≤760 时 .zs-heading 仍是 24px/26px 而不是 18px/23px（真机复现）。
//
// 只认一条硬规则：**两条规则若能命中同一个元素、特异性相同、又给同一块地盘赋了不同的值，
// 谁生效就只取决于挂载顺序 —— 这就是隐患**。围绕它做三件事：
//   1. 跨包冲突：这种情况出现在两个不同的包里（含「@media 覆盖的基规则在别的包」）。
//   2. 同包倒序：@media 覆盖写在它要覆盖的基规则**之前**，同特异性下永远输，是死规则。
//   3. 简写/长写：`margin` 与 `margin-bottom` 争同一块地盘，属性名不同也要算冲突。
//
// 判定「能命中同一个元素」用**主体（最右复合选择器）相同 + 选择器里的类/属性记号有交集**，
// 而不是选择器字符串全等 —— 后者会漏掉「同一个选择器在别的包里多写了 `body[data-zhiyun]`
// 前缀」这类拼写差异，而那正是这个 bug 最容易重现的形状。特异性不同则不算隐患：高的那条
// 无论挂载顺序都会赢。
//
// 用法：node scripts/check-css-order.mjs        （退出码非 0 表示发现隐患）
// 也可以 import { analyzeSheets, parseRules, loadSheets } 在测试里直接断言。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const norm = s => s.replace(/\s+/g, ' ').trim();

/** 值的比较口径：空白归一；不含引号/url()/var()/自定义属性名时忽略大小写（`RED` 就是 `red`）。 */
function normalizeValue(value) {
  const v = norm(value);
  if (/["']|url\(|var\(|--/.test(v)) return v;
  return v.toLowerCase();
}

/** 递归下降切片：剥注释、正确跳过 @keyframes 内部的 from/to/百分比选择器。 */
export function parseRules(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const stack = [];
  let i = 0, buf = '';
  while (i < css.length) {
    const c = css[i];
    if (c === '{') {
      const prelude = buf.trim(); buf = '';
      if (prelude.startsWith('@')) {
        stack.push(prelude.startsWith('@keyframes') ? '\u0000keyframes' : prelude.replace(/\s+/g, ' '));
        i++; continue;
      }
      if (stack.some(s => s === '\u0000keyframes')) {
        let depth = 1, j = i + 1;
        while (j < css.length && depth > 0) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
        i = j; continue;
      }
      let depth = 1, j = i + 1, body = '';
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') { depth--; if (depth === 0) break; }
        body += css[j]; j++;
      }
      out.push({
        selector: prelude.replace(/\s+/g, ' ').trim(),
        body: body.trim(),
        media: stack.filter(s => s !== '\u0000keyframes'),
        line: css.slice(0, i).split('\n').length,
      });
      i = j + 1; continue;
    }
    if (c === '}') { stack.pop(); buf = ''; i++; continue; }
    buf += c; i++;
  }
  return out;
}

const declarations = body => {
  const map = new Map();
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon >= 0) map.set(norm(part.slice(0, colon)), norm(part.slice(colon + 1)));
  }
  return map;
};

// 简写属性会重置它展开出的长写属性，所以 `margin: 4px` 和 `margin-bottom: 8px` 争的是
// 同一块地盘，胜负同样由挂载顺序决定 —— 但属性名字面不同，只比对名字会漏掉。
// 注意这里刻意只记「简写 → 它重置的长写」：margin-top 与 margin-bottom 互不重置，
// 分属两个包是安全的，不能被误报。
const SHORTHAND_LONGHANDS = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'margin-block-start', 'margin-block-end', 'margin-inline-start', 'margin-inline-end'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'padding-block-start', 'padding-block-end', 'padding-inline-start', 'padding-inline-end'],
  inset: ['top', 'right', 'bottom', 'left', 'inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end'],
  'margin-block': ['margin-block-start', 'margin-block-end'],
  'margin-inline': ['margin-inline-start', 'margin-inline-end'],
  'padding-block': ['padding-block-start', 'padding-block-end'],
  'padding-inline': ['padding-inline-start', 'padding-inline-end'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  border: ['border-width', 'border-style', 'border-color', 'border-top', 'border-right', 'border-bottom', 'border-left',
    'border-top-width', 'border-top-style', 'border-top-color', 'border-right-width', 'border-right-style', 'border-right-color',
    'border-bottom-width', 'border-bottom-style', 'border-bottom-color', 'border-left-width', 'border-left-style', 'border-left-color'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
  'border-image': ['border-image-source', 'border-image-slice', 'border-image-width', 'border-image-outset', 'border-image-repeat'],
  background: ['background-color', 'background-image', 'background-position', 'background-size',
    'background-repeat', 'background-origin', 'background-clip', 'background-attachment'],
  font: ['font-style', 'font-variant', 'font-weight', 'font-stretch', 'font-size', 'line-height', 'font-family'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  gap: ['row-gap', 'column-gap'],
  overflow: ['overflow-x', 'overflow-y'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
  'place-self': ['align-self', 'justify-self'],
  'grid-template': ['grid-template-rows', 'grid-template-columns', 'grid-template-areas'],
  grid: ['grid-template-rows', 'grid-template-columns', 'grid-template-areas',
    'grid-auto-rows', 'grid-auto-columns', 'grid-auto-flow'],
  'grid-area': ['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end'],
  'text-decoration': ['text-decoration-line', 'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness'],
  transition: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'],
  animation: ['animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay',
    'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-play-state'],
  'list-style': ['list-style-type', 'list-style-position', 'list-style-image'],
  'list-style-type': [],
  outline: ['outline-color', 'outline-style', 'outline-width'],
  columns: ['column-width', 'column-count'],
};

/** 两个属性是否争同一块地盘：同名，或一方是另一方的简写。 */
export function propertyOverlaps(a, b) {
  if (a === b) return true;
  return Boolean(SHORTHAND_LONGHANDS[a]?.includes(b) || SHORTHAND_LONGHANDS[b]?.includes(a));
}

/* ------------------------------------------------------------------ 选择器分析 */

/** 按组合器（空格 / > / + / ~）切成复合选择器，括号与方括号内的不算分隔。 */
function splitCompounds(selector) {
  const out = [];
  let buf = '';
  let depth = 0;
  for (const ch of selector) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && /[\s>+~]/.test(ch)) { if (buf) out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

function compareSpec(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function compoundSpecificity(compound) {
  let a = 0, b = 0, c = 0;
  let i = 0;
  while (i < compound.length) {
    const ch = compound[i];
    if (ch === '#') { a++; i++; while (i < compound.length && /[\w-]/.test(compound[i])) i++; continue; }
    if (ch === '.') { b++; i++; while (i < compound.length && /[\w-]/.test(compound[i])) i++; continue; }
    if (ch === '[') {
      b++; let depth = 1; i++;
      while (i < compound.length && depth > 0) { if (compound[i] === '[') depth++; else if (compound[i] === ']') depth--; i++; }
      continue;
    }
    if (ch === ':') {
      if (compound[i + 1] === ':') { c++; i += 2; while (i < compound.length && /[\w-]/.test(compound[i])) i++; continue; }
      let j = i + 1, name = '';
      while (j < compound.length && /[\w-]/.test(compound[j])) { name += compound[j]; j++; }
      if (compound[j] === '(') {
        let depth = 1, k = j + 1, inner = '';
        while (k < compound.length && depth > 0) {
          if (compound[k] === '(') depth++;
          else if (compound[k] === ')') { depth--; if (depth === 0) break; }
          inner += compound[k]; k++;
        }
        if (name === 'where') { /* 计 0 */ }
        else if (name === 'is' || name === 'not' || name === 'has') {
          const best = inner.split(',').map(s => specificity(s))
            .reduce((m, p) => (compareSpec(p, m) > 0 ? p : m), [0, 0, 0]);
          a += best[0]; b += best[1]; c += best[2];
        } else { b++; }
        i = k + 1; continue;
      }
      b++; i = j; continue;
    }
    if (ch === '*') { i++; continue; }
    if (/[a-zA-Z]/.test(ch)) { c++; i++; while (i < compound.length && /[\w-]/.test(compound[i])) i++; continue; }
    i++;
  }
  return [a, b, c];
}

/** 选择器特异性 [id, class/属性/伪类, 元素/伪元素]。 */
export function specificity(selector) {
  const total = [0, 0, 0];
  for (const compound of splitCompounds(norm(selector))) {
    const part = compoundSpecificity(compound);
    total[0] += part[0]; total[1] += part[1]; total[2] += part[2];
  }
  return total;
}

const specText = ([a, b, c]) => `${a}-${b}-${c}`;

/** 主体 = 最右复合选择器：真正被这条规则命中的那个元素。 */
function subjectOf(selector) {
  const compounds = splitCompounds(norm(selector));
  return compounds.length > 0 ? compounds[compounds.length - 1] : '';
}

/** 主题作用域前缀去掉后的形态：`body[data-zhiyun] .x h1` 与 `.x h1` 是同一个选择器。 */
function stripScope(selector) {
  return norm(norm(selector)
    .replace(/^body\[data-zhiyun\]\s*/i, '')
    .replace(/^html\s+/i, '')
    .replace(/^:root\s+/i, ''));
}

/** 选择器里出现的类/属性/id 记号（`[data-zhiyun]` 这种主题作用域除外）。 */
const SCOPE_TOKENS = new Set(['[data-zhiyun]', '[data-zhiyun-study]', '[data-zhiyun-primitives]']);
function tokensOf(selector) {
  const set = new Set();
  for (const m of norm(selector).matchAll(/[.#][\w-]+|\[[^\]]+\]/g)) {
    const token = m[0].toLowerCase();
    if (!SCOPE_TOKENS.has(token)) set.add(token);
  }
  return set;
}

/* ---------------------------------------------------------------- 媒体条件求值 */

/** 把 `@media (max-width: 760px) and (prefers-reduced-motion: no-preference)` 解析成条件组。 */
function parseMedia(query) {
  const body = query.replace(/^@media\s*/i, '');
  // 顶层逗号 = 「或」：任一备选命中即命中
  return body.split(',').map(alt => {
    const conditions = [];
    for (const part of alt.split(/\s+and\s+/i)) {
      const width = /\(\s*(max-width|min-width|width)\s*:\s*([\d.]+)(px|em|rem)?\s*\)/i.exec(part);
      if (width) {
        const scale = width[3] === 'em' || width[3] === 'rem' ? 16 : 1;
        conditions.push({ op: width[1].toLowerCase(), value: Number(width[2]) * scale });
      } else if (part.trim() && !/^\(?\s*only\s+screen\s*\)?$/i.test(part.trim())) {
        // 非宽度条件（prefers-*、hover 等）无法静态求值，按「可能命中」处理
        conditions.push({ op: 'other', value: 0 });
      }
    }
    return conditions;
  });
}

/**
 * 这条规则在给定宽度下是否可能生效。
 * 没有 @media 的规则恒为真；嵌套多层 @media 时每层都要命中。
 */
function activeAt(mediaList, width) {
  for (const query of mediaList) {
    const alternatives = parseMedia(query);
    const hit = alternatives.some(conditions => conditions.every(c => {
      if (c.op === 'other') return true;
      if (c.op === 'max-width') return width <= c.value;
      if (c.op === 'min-width') return width >= c.value;
      return width === c.value;
    }));
    if (!hit) return false;
  }
  return true;
}

/** 收集所有媒体条件里的宽度断点，用于挑选「值得试」的宽度。 */
function candidateWidths(sheets) {
  const values = new Set([0, 100000]);
  for (const rules of sheets.values()) {
    for (const rule of rules) {
      for (const query of rule.media) {
        for (const alt of parseMedia(query)) {
          for (const c of alt) {
            if (c.op === 'other') continue;
            values.add(Math.max(0, c.value - 1));
            values.add(c.value);
            values.add(c.value + 1);
          }
        }
      }
    }
  }
  return [...values].sort((a, b) => a - b);
}

/* ---------------------------------------------------------------------- 装载 */

/**
 * 读各 dsh-zhiyun-* 包的样式表 → Map<包名, 规则[]>（按包名排序）。
 *
 * 递归读 `src/**` 下的**所有** .css —— 只认 `src/style.css` 会让后来新增的
 * `src/settings.css` 之类的表整个逃出检查范围。读失败不吞异常：文件在那里却读不动，
 * 是环境问题，不该表现为「检查通过」。
 */
export function loadSheets(root) {
  const pkgRoot = path.join(root, 'packages');
  const sheets = new Map();
  if (!existsSync(pkgRoot)) return sheets;
  for (const dir of readdirSync(pkgRoot).sort()) {
    if (!dir.startsWith('dsh-zhiyun-')) continue;
    const srcDir = path.join(pkgRoot, dir, 'src');
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) continue;
    const files = [];
    (function walk(current) {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.name.toLowerCase().endsWith('.css')) files.push(abs);
      }
    })(srcDir);
    if (files.length === 0) continue;
    files.sort();
    const rules = [];
    for (const file of files) {
      const parsed = parseRules(readFileSync(file, 'utf8'));
      // 一个包只有一张表时不带文件名（报告里 `pkg:L行号` 就够定位）；
      // 多张表时必须带上，否则行号无法区分。
      const tag = files.length > 1 ? path.basename(file) : undefined;
      for (const rule of parsed) rules.push(tag ? { ...rule, file: tag } : rule);
    }
    sheets.set(dir, rules);
  }
  return sheets;
}

/* ---------------------------------------------------------------------- 检查 */

const where = entry => `${entry.pkg}${entry.file ? `/${entry.file}` : ''}:L${entry.line}`;

/** 两条规则是否「可能命中同一个元素」：主体相同，且选择器里的记号有交集。 */
function mayTargetSame(entryA, entryB) {
  if (entryA.subject !== entryB.subject || entryA.subject === '') return false;
  if (entryA.stripped === entryB.stripped) return true;
  for (const token of entryA.tokens) if (entryB.tokens.has(token)) return true;
  return false;
}

/** 两条规则里争同一块地盘、且值确实不同的属性对（同名同值不算：谁赢都一样）。 */
function conflictingProps(a, b) {
  const hits = [];
  for (const [propA, valueA] of a.props) {
    for (const [propB, valueB] of b.props) {
      if (!propertyOverlaps(propA, propB)) continue;
      if (normalizeValue(valueA) === normalizeValue(valueB)) continue;
      hits.push([propA, valueA, propB, valueB]);
    }
  }
  return hits;
}

/** 对一个 Map<包名, 规则[]> 做全部检查。 */
export function analyzeSheets(sheets) {
  const entries = [];
  for (const [pkg, rules] of sheets) {
    for (const rule of rules) {
      if (rule.selector.startsWith('@')) continue;
      for (const selector of rule.selector.split(',').map(norm)) {
        if (!selector) continue;
        entries.push({
          pkg, file: rule.file, line: rule.line, selector,
          subject: subjectOf(selector),
          stripped: stripScope(selector),
          tokens: tokensOf(selector),
          specificities: specificity(selector),
          props: declarations(rule.body),
          media: rule.media,
        });
      }
    }
  }

  const widths = candidateWidths(sheets);
  const problems = [];

  // 规则 1：跨包冲突 —— 特异性相同、能命中同一元素、争同一属性且值不同。
  // 只要存在一个宽度让两条都生效，胜负就只剩挂载顺序这一条依据。
  //
  // comparedPairs 数的是「真的比对到底」的那一类候选对（跨包 + 特异性相同 + 可能命中同一
  // 元素 + 存在共同生效宽度），**不含「值恰好相同所以不报」的**。它是守卫的覆盖面证据：
  // 若它是 0，说明过滤条件把什么都滤掉了，「0 条问题」不能当成通过。
  let comparedPairs = 0;
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      if (a.pkg === b.pkg) continue;
      if (compareSpec(a.specificities, b.specificities) !== 0) continue;
      if (!mayTargetSame(a, b)) continue;
      // 两条规则得在某个宽度下同时生效，否则谈不上「同一个元素上的竞争」
      if (!widths.some(w => activeAt(a.media, w) && activeAt(b.media, w))) continue;
      comparedPairs++;
      const conflicts = conflictingProps(a, b);
      if (conflicts.length === 0) continue;
      const [propA, valueA, propB, valueB] = conflicts[0];
      const aIsMedia = a.media.length > 0, bIsMedia = b.media.length > 0;
      if (aIsMedia !== bIsMedia) {
        // 一边是 @media 覆盖、另一边是它的基规则 —— 拆包踩过的就是这个形状
        const override = aIsMedia ? a : b;
        const base = aIsMedia ? b : a;
        problems.push({
          kind: 'media-order',
          pkg: override.pkg, line: override.line, file: override.file,
          selector: override.selector,
          media: override.media.join(' & ').replace(/^@media\s*/i, ''),
          covered: [...override.props].map(([k, v]) => `${k}:${v}`).join(' | '),
          bases: [where(base)],
          detail: `${propA}:${valueA} vs ${propB}:${valueB}`,
        });
      } else {
        problems.push({
          kind: 'cross-package-value',
          selector: a.selector,
          prop: propA === propB ? propA : `${propA} / ${propB}`,
          media: a.media.join(' & ').replace(/^@media\s*/i, ''),
          sites: [`${where(a)} = ${propA}: ${valueA}`, `${where(b)} = ${propB}: ${valueB}`],
        });
      }
    }
  }

  // 规则 2：同一个包内，@media 覆盖写在它要覆盖的基规则之前（同特异性下后者永远赢 ⇒ 死规则）。
  for (const [pkg, rules] of sheets) {
    for (const rule of rules) {
      if (!rule.media.length || rule.selector.startsWith('@')) continue;
      for (const selector of rule.selector.split(',').map(norm)) {
        if (!selector) continue;
        const override = {
          pkg, file: rule.file, line: rule.line, selector,
          subject: subjectOf(selector), stripped: stripScope(selector), tokens: tokensOf(selector),
          specificities: specificity(selector), props: declarations(rule.body), media: rule.media,
        };
        for (const other of rules) {
          if (other === rule || other.media.length || other.selector.startsWith('@')) continue;
          if (other.line <= rule.line) continue;
          for (const later of other.selector.split(',').map(norm)) {
            if (!later) continue;
            const base = {
              pkg, file: other.file, line: other.line, selector: later,
              subject: subjectOf(later), stripped: stripScope(later), tokens: tokensOf(later),
              specificities: specificity(later), props: declarations(other.body), media: [],
            };
            if (compareSpec(base.specificities, override.specificities) < 0) continue;
            if (!mayTargetSame(base, override)) continue;
            if (conflictingProps(base, override).length === 0) continue;
            problems.push({
              kind: 'dead-media',
              pkg, line: rule.line, file: rule.file, selector,
              media: rule.media.join(' & ').replace(/^@media\s*/i, ''),
              base: where(base),
            });
            break;
          }
        }
      }
    }
  }

  const mediaChecked = entries.filter(e => e.media.length > 0).length;
  return { problems, mediaChecked, collisionChecked: comparedPairs, sheetCount: sheets.size, packages: [...sheets.keys()] };
}

/** 打印报告；返回应使用的退出码。 */
export function report(analysis, { log = console.log, error = console.error } = {}) {
  const { problems, mediaChecked, collisionChecked, sheetCount } = analysis;
  for (const p of problems) {
    if (p.kind === 'media-order') {
      error(`✗ @media 覆盖和它要覆盖的基规则在别的包，胜负只能由挂载顺序决定`);
      error(`    ${p.pkg}${p.file ? `/${p.file}` : ''}:L${p.line}  @media ${p.media}`);
      error(`    ${p.selector} → 覆盖为 ${p.covered}`);
      for (const b of p.bases) error(`    基规则在 ${b}`);
      error(`    ⇒ 把这条覆盖搬到基规则所在的包。挂载顺序由各 fiber 的 inject 满足时机决定，`);
      error(`      不是契约：覆盖在前就静默失效，在后只是碰巧生效，两种都不该依赖`);
    } else if (p.kind === 'dead-media') {
      error(`✗ @media 覆盖写在了基规则之前，同特异性下永远输`);
      error(`    ${p.pkg}${p.file ? `/${p.file}` : ''}:L${p.line}  @media ${p.media}`);
      error(`    ${p.selector}`);
      error(`    同包内更靠后的基规则在 ${p.base}`);
      error(`    ⇒ 把这条 @media 移到基规则之后；同包内也是后写的赢`);
    } else {
      error(`✗ 两个包在同一个元素上争同一属性，却给了不同的值（特异性相同，胜负只看挂载顺序）`);
      error(`    ${p.selector} { ${p.prop} }${p.media ? `  @media ${p.media}` : ''}`);
      for (const s of p.sites) error(`    ${s}`);
      error(`    ⇒ 让其中一个包只声明「不与对方争同一属性」的部分，或把规则收拢到同一个包`);
    }
    error('');
  }
  const count = kind => problems.filter(p => p.kind === kind).length;
  log(`检查了 ${sheetCount} 个包的样式表：跨包 @media 顺序依赖 ${count('media-order')} 条，`
    + `跨包同属性值竞争 ${count('cross-package-value')} 条，同包内 @media 倒序 ${count('dead-media')} 条`
    + `（共比对 ${mediaChecked} 条 @media 规则、${collisionChecked} 对跨包同类规则）。`);
  if (problems.length) {
    error(`发现 ${problems.length} 条靠挂载顺序决胜的层叠依赖。`);
    return 1;
  }
  log('样式归属正确：没有跨包顺序依赖 ✓');
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sheets = loadSheets(root);
  if (sheets.size === 0) {
    console.error('没读到任何 packages/dsh-zhiyun-*/src/**/*.css —— 检查是否在仓库根运行。');
    process.exit(1);
  }
  process.exit(report(analyzeSheets(sheets)));
}
