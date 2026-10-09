# dsh-zhiyun-ui-primitives

智云 Pro 的**共享 UI 原语**：无状态、纯展示，被外壳与全部页面包共用。拆包前这些原语散在外壳的 `components.jsx` 里，页面组件也直接从外壳 import —— 共享物塞进「界面外壳」会让任何页面改动都要碰壳。现在壳不认识页面，页面也不认识壳，两边都只认这个包。

导出的东西（客户端）：`Icon`、`Mark`、`Empty`、`SectionTitle`、`Notice`、`useStore`、`useStudy`、`mountStyle`。

## 用法

```js
import { Icon, Mark, Empty, SectionTitle, Notice, mountStyle, useStudy } from 'dsh-zhiyun-ui-primitives';
```

跨包解析走客户端模块表：包名写进使用方 `package.json` 的 `dsh.client.external`，构建时 esbuild external 化，运行时由模块表解析到**本包 bundle 的 exports**（`scripts/build.mjs` 从 package.json 读 external，是单一真源）。

样式：本包把共享原子样式（按钮、空态、Notice、分区标题、跨页公共选择器）挂成 `<style data-zhiyun-primitives-style>`，随本包生命周期装卸。各页面包自己的样式仍挂在自己的 `<style data-zhiyun-*-style>` 上 —— 用 `mountStyle(ctx, { attribute, css, label })` 统一，卸载时随 `ctx.effect` 回收。

## 样式归属的一个注意点

`.zs-button`、`.zs-primary`、`.zs-muted`、`.zs-courses button` 这类公共原子类的**唯一定义在本包**，消费方却在 `dsh-zhiyun-page-courses`、`dsh-zhiyun-page-me`、`dsh-zhiyun-page-study` 三个页面包。当前没问题：页面包都在 `dsh.client.external` 里声明了本包，客户端模块表会强制本包先 materialize，样式必然生效。

但这条依赖是**隐式**的 —— 单独停用本包（或将来新增页面包忘了写 `external`）时，这三个页面的按钮与提示文字会**静默退化成无样式**，不报错。所以：新增页面包务必在 `package.json` 的 `dsh.client.external` 里写 `"dsh-zhiyun-ui-primitives"`，`scripts/build.mjs` 会照它做 external 化。

## 响应式覆盖必须和它覆盖的基规则同包

每个包的 `style.css` 是各自 `mountStyle` 追加的一张**独立 `<style>`**。同特异性下胜负只看哪张表后挂载 —— 而本包 `inject` 为空、激活最早，表几乎总是排在最前。所以**写在本包、却要覆盖别的包基规则的 `@media` 是死规则**。

拆包时这里真的踩过一次：原 `dsh-zhiyun-study/style.css` 尾部的两个 `@media`（1050 / 760）被整块留在本包，而它们的基规则跟着组件去了页面包，结果 ≤760 时 `.zs-heading` 仍是 `24px/26px` 而不是 `18px/23px`（真机三档视口实测复现）。修法是把每条覆盖搬到基规则所在的那个包：`.zs-workbench`/`.zs-models`/`.zs-progress` → `dsh-zhiyun-page-study`，`.zs-heading*` → `dsh-zhiyun-page-courses`，`.zs-account form` → `dsh-zhiyun-page-me`。

本包只留「基规则也在本包」或「不与任何基规则争同一属性」的覆盖。改 CSS 时可以用 `node scripts/check-css-order.mjs` 复核（它同时检查跨包 `@media` 顺序依赖，以及跨包在同一选择器下争同一属性却给了不同值 —— 包括**简写与它重置的长写**，`margin` vs `margin-bottom` 属性名不同但争的是同一块地盘）。

## 品牌资源

`src/assets/` 四个 SVG：`zhiyun-mark.svg`、`zhiyun-mark-compact.svg`、`zhiyun-pro-blue.svg`、`zhiyun-pro-white.svg`。文字均为矢量路径，不依赖客户端字体。`scripts/generate-brand.py` 是可选的设计生成工具，不参与应用构建。

## ⚠️ 不要写 `export default`

宿主 Loader 解析 bundle exports 时优先取 `default`（`vendor/loader` 的 `unwrapExports`：`exports = exports.default ?? exports`）。本包一旦写了 `export default primitives`，Loader 拿到的就是原语命名空间对象（没有 `apply`），整页直接：

```
Failed to load plugins: invalid plugin, expect function or object with an "apply" method, received object
```

这是拆包真机上踩到的第一个坑（整站白屏）。具名导出就够了 —— 别的包 `import { Icon } from 'dsh-zhiyun-ui-primitives'` 走的是模块表的 exports 表，与 ESM default 无关。
