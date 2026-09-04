# RAI Running — UI / 设计系统只读审查（2026-09-04）

> **范围**：只读审查，不修改任何代码。桌面 Web（≥1024px，主要验证视口 1440×900）。
> **审查对象**：`apps/web/src/{styles.css, reference-shell.css, first-run-pixel.css, pixel-layout.css, dashboard-reference.css, training-reference.css, data-reference.css, analysis-reference.css, components/*, pages/*}` + `docs/FIGMA_HIFI_SPEC.md` + `docs/design-references/pixel-ui/*.webp`。
> **冻结边界**（AGENTS.md）：mobileNavigation、`.mobile-nav-links`、`<1024px` 媒体查询、390px E2E 不在改动建议范围；如必要会显式标注「需用户授权」。
> **严重度**：🔴 严重（影响一致性/可维护性/可访问性）· 🟠 主要（明显偏差）· 🟡 次要（细节优化）· 🟢 增强（机会型）。

---

## TL;DR（结论先行）

- **设计系统处于「半重构」状态**：`:root` token 块（styles.css L1–22）被 `@media (min-width: 1024px)` 内的 `:root` 二次覆盖（L800–816），又在 `pixel-layout.css`（L3–13）第三次声明，并在 `ios-pixel.css`（L2–21）第四次平行存在。**「绿色」一词在四个文件里有四个不同的十六进制值**，色板在层级间漂移。
- **桌面正在 ship 与 FIGMA_HIFI_SPEC.md（规范源文件）相反的视觉风格**：规范写 radius 6 px + 白色卡片 + 软阴影，实际桌面是 pixel-cut 硬边 + 2 px 黑绿描边 + 跑者像素精灵图。规范已经过时，**真实的 spec 是 `docs/design-references/pixel-ui/*.webp` 一组散落截图**——没有 DESIGN.md 这种源文件。
- **没有任何暗色模式支持**：未声明 `prefers-color-scheme: dark`、未设置 `color-scheme`、没有 [data-theme] 切换。对于当前在深色系统环境下工作的用户，桌面强制 #fffef8 浅色纸张会持续造成对比与视觉疲劳。
- **图表与组件到处硬编码色值**，绕过了 token 系统：AbilityChart、WorkoutDetailPage、WorkoutSeriesChart 三处共 20+ 个 inline hex。重排版/换肤成本极高。
- **可访问性总体合格但有两处明确漏洞**：能力趋势图上的 CA 点是 `<circle onClick>`，键盘无法到达；状态徽标 `positive/attention/danger/neutral` 是颜色唯一信号，色盲用户难辨。
- **桌面 ↔ iOS 双 UI 维护成本高**：styles.css 和 ios-pixel.css 是平行的 token 系统，配色、间距、圆角各跑各的；两者都参考同一品牌但实际定义分离。

---

## 发现清单（按严重度排序）

### 🔴 [C1] 设计系统碎片化：6 份 CSS，token 在 4 处声明，绿色有 4 个色值
- **位置**：`apps/web/src/styles.css` L1–22、L800–816；`pixel-layout.css` L3–13；`ios-pixel.css` L2–21；`reference-shell.css`、`first-run-pixel.css`、`dashboard-reference.css`、`training-reference.css`、`data-reference.css`、`analysis-reference.css`。
- **证据**：同样名为「绿色」/「green」的语义色在四处分别被定义为 `#1f6d4c`（base）、`#286b4d`（styles.css ≥1024）、`#247446`（pixel-layout.css ≥1024）、`#247446`（ios-pixel.css）。`--radius` 在 base 是 6 px，≥1024 改写为 3 px，`pixel-layout.css` 用 `border-radius: 0 + clip-path: var(--pixel-cut)` 直接覆盖；`--shadow` 从 `0 12px 30px rgba(31,52,41,.07)` 改为 `3px 3px 0 rgba(23,79,53,.12)`。每页再各导入自己的 `*-reference.css`，里面又重复一次 `@media (min-width: 1024px) { ... }`。
- **方案**：抽出独立的 `tokens.css`，仅在此处声明 `:root` 语义 token（`--color-bg`、`--color-surface`、`--color-surface-2`、`--color-ink`、`--color-muted`、`--color-line`、`--color-brand`、`--color-coral`、`--color-amber`、`--color-red`、`--color-info`、`--radius-pixel`、`--radius-soft`、`--shadow-pixel`、`--shadow-card`、`--font-display`、`--font-mono`、`--space-1..8`）。其他 CSS 仅消费 token。`pixel-layout.css` 改为「在 ≥1024 时为各组件附加 pixel 修饰类」，而不是再次 `:root`。最终在 `DESIGN.md` 维护唯一源文件。

### 🔴 [C2] 无暗色模式支持
- **位置**：styles.css、pixel-layout.css、ios-pixel.css、reference-shell.css 全部 grep `prefers-color-scheme|color-scheme|data-theme|\.dark` 均无命中。`html { background: var(--bg); }` 始终是 `#f3f5f2` 浅绿；面板使用 `#fffef8` 米色。
- **证据**：当前用户为深色系统，桌面端持续以浅色 paper 渲染，branding 像素风的硬绿描边在深色 OS 上下文里尤其刺眼。`@media (prefers-color-scheme: dark)` 与 `color-scheme: light dark` 在任何 CSS 都未声明。
- **方案**：在 `tokens.css` 引入 `:root.theme-dark` 与 `@media (prefers-color-scheme: dark) { :root { ... } }`，为语义 token 提供暗色版本（`--color-bg: #0f1812`、`--color-surface: #16221b`、`--color-ink: #e8efe6`、`--color-muted: #8aa094`、`--color-line: #2c4438`、`--color-brand: #54a864`、`--color-coral: #ed8d76` 等），并在 Settings 提供主题切换器（`document.documentElement.dataset.theme = "dark"` 覆盖 `@media`）。同时设置 `html { color-scheme: light dark; }` 让原生控件也跟随。

### 🔴 [C3] 图表与组件到处硬编码色值，绕开 token
- **位置**：
  - `components/AbilityChart.tsx` L43–99：`stroke="#1f6d4c"`、`fill="#d86a53"`、`stroke="#dfe5df"`、`fill="#d99a3d"`、`fill="#fff8e9"`、`stroke="#b96f18"`、`tick fill="#6d786f"`。
  - `pages/WorkoutDetailPage.tsx` L25：`const zoneColors = ["#dce8ec", "#dfeadf", "#f0e4b8", "#f4d3c9", "#efc2be"]`；L137：`<WorkoutSeriesChart ... color="#3c6e9d" />` 等 8 处 `color="#..."`。
  - `components/DashboardPerformanceChart.tsx`、其他图表组件同理。
- **方案**：在 `tokens.css` 增加 `data-*` 系列的图与系列 token：`--chart-ta-line`、`--chart-ca-fill`、`--chart-ca-low-stroke`、`--chart-decay-band`、`--chart-grid`、`--chart-axis-text`、`--chart-model-line`、`--series-heart`、`--series-pace`、`--series-cadence`、`--series-elevation`、`--series-power`、`--series-stride`、`--series-osc`、`--series-gct`、`--zone-1..5`。组件读 `getComputedStyle(document.documentElement).getPropertyValue('--chart-ca-fill')` 或通过 CSS 变量传给 recharts（recharts 支持 `stroke="var(--chart-ta-line)"` 形式传入 CSS 变量）。如此暗色模式/品牌换肤一处生效。

### 🟠 [M1] :root 在 `@media` 里被「偷偷」改写
- **位置**：`styles.css` L799–816（`@media (min-width: 1024px) { :root { --ink: ...; --muted: ...; --radius: 3px; --shadow: 3px 3px 0 ...; ... } }`）。
- **问题**：开发者查 `--green` 会看到 `#1f6d4c`，但只要视口 ≥1024，实际生效是 `#286b4d`，因为后定义的媒体查询覆盖了全局。`--radius` 6 → 3、`--shadow` 软 → 硬。这相当于「在不同断点上有两套 token」，且无任何文档说明。
- **方案**：把 ≥1024 的样式定义为「附加」而非「重写」。建议引入 `<html data-density="pixel">`（desktop ≥1024 时由 main.tsx 或 matchMedia 切换），用 `[data-density="pixel"] { --radius: 0; --shadow: ... }` 显式表达主题切换；不要把重定义埋在 media 里。或在 DESIGN.md 显式声明「`--green` 在 ≥1024 切到深绿 #286b4d」并解释原因。

### 🟠 [M2] FIGMA_HIFI_SPEC.md 描述与实际桌面实现相反
- **位置**：`docs/FIGMA_HIFI_SPEC.md` §2.1「surface/raised `#FFFFFF`、6 px 圆角、不嵌套卡片」、§2.2「阴影仅用于 drawer/modal」；而实际桌面 `pixel-layout.css` + `reference-shell.css` 渲染的是硬 2 px 黑绿描边、`clip-path: var(--pixel-cut)` notched corners、3px 3px 0 硬阴影、`runner-chibi.webp` 像素精灵。
- **证据**：`docs/design-references/pixel-ui/dashboard.webp` 等 11 张参考截图（2026-07-15）展示的是「清新像素风」+ pixel-cut，但 FIGMA_HIFI_SPEC.md（2026-07-10）的 Tokens / Components / Charts 都讲的是 minimal/soft。两份文档相隔 5 天但风格相反。
- **方案**：二选一：① 把 FIGMA_HIFI_SPEC.md 退役并以 `DESIGN.md` 替代，明确 tokens（基于 pixel 主题）和组件清单；② 或将代码回退到 FIGMA_HIFI_SPEC.md 描述的 minimal 风格（更费力）。当前实现显然已经选定了 pixel 方向，因此应当更新规范，把 `design-references/pixel-ui/*.webp` 作为视觉基准并写进 DESIGN.md。

### 🟠 [M3] 每页一份 `*-reference.css`，结构重复度高
- **位置**：`apps/web/src/{dashboard-reference, training-reference, data-reference, analysis-reference}.css` 全部 `@media (min-width: 1024px) { ... }`，且都重复定义 `.dashboard-page .dashboard-grid`、`.panel { ... }`、`.panel-heading { ... }` 等修饰类。`pixel-layout.css` 已经处理了部分，但每个 ref-css 又在各自页面范围内做二次覆盖。
- **方案**：以组件为单位拆分 CSS（或采用 CSS Modules）。`WorkoutTable`/`WorkoutSeriesChart`/`RoutePlot`/`StatusBadge`/`CapabilityCard`/`RaceCard` 等组件各自就近 `*.module.css`。删掉 `*-reference.css` 整组文件。这种重构对 styles.css 体量也是减负（当前 1262 行）。

### 🟠 [M4] 状态色语义不完整；缺 `info`
- **位置**：`styles.css` L228–231：`.status-badge.positive/.attention/.danger/.neutral`；FIGMA_HIFI_SPEC §2.1 列出 `status/info #2A6FA8`。
- **证据**：多个面板使用「诊断/信息性」语境却用 amber 或 green 表示：`prediction-formula-fallback` 用 amber-soft；`prediction-model-active-note` 用 #23573e 绿；`background-refresh-error` 警告重试用 amber-soft。**没有蓝色 / info 调色板**。
- **方案**：补 `--color-info`、`--color-info-soft`、`--border-info` token；增加 `.status-badge.info`。`status-badge.neutral` 当前 `color: #5f6a63; background: #e9ede9` 仍是绿色家族，可考虑作为「诊断/info」视觉基础并加点 pattern。

### 🟠 [M5] `status-badge` 仅靠颜色编码，色盲不友好
- **位置**：`styles.css` L228–231 + `components/StatusBadge.tsx`。
- **问题**：positive/attention/danger/neutral 四个状态仅以背景色 + 文字色区分，无图标、无形状区分。色弱用户在训练列表（`WorkoutTable.tsx`）扫状态徽标时不易分辨。当前文字标签（如「良好」「适中」「数据不足」）部分是补救，但 `StatusBadge` 自身仍只靠颜色。
- **方案**：在 StatusBadge 内加入语义图标前缀（`✓` positive / `!` attention / `✕` danger / `–` neutral），或添加左侧 4 px 形状条（圆点/三角/方块/横线）。这与已有的 `◉ ▥ ◆ ▥` glyph 风格一致。

### 🟠 [M6] 双 UI 维护成本：styles.css vs ios-pixel.css 平行 token
- **位置**：`apps/web/src/styles.css` L1–22（base）、L800–816（pixel ≥1024 overlay）；`apps/web/src/ios-pixel.css` L1–27。两者都自定义 `--pixel-*` 命名空间，互不复用。
- **证据**：iOS 重新定义 `--pixel-ink #123f2b`、`--pixel-green #247446`、`--pixel-coral #ed6549`；桌面 ≥1024 用 `--green #286b4d`、`--coral #e7775d`。同一品牌的「绿」和「橙」在桌面端和 iOS 端用 RGB 差几到几十的两个值，长期会漂移。
- **方案**：tokens.css 同时定义两套 alias：`--color-brand: #247446`（品牌主色，桌面与 iOS 共用）、`--color-brand-desktop: #286b4d`（桌面深绿变体）、`--color-coral-shared: #ed6549`（共享）、`--color-coral-desktop: #e7775d`。ios-pixel.css 的 `:root` 改读 `var(--color-brand)` 等共享值。

### 🟡 [m1] `CaDot` 是 SVG `<circle onClick>`，键盘不可达
- **位置**：`components/AbilityChart.tsx` L40–49。
- **问题**：能力趋势图上的 CA 散点为可点击跳转元素（点击打开训练详情），但用 `<circle onClick>` 不在 Tab 序列中，屏幕阅读器无法朗读，键盘用户无法激活。底部 `<details>` 提供了等价列表作为兜底，但它是独立 affordance，不属于同一焦点流。
- **方案**：把 CaDot 包成 `<button type="button" aria-label="...">` 或对 recharts `Scatter` 使用 `shape={<button-shaped CaDot onActivate={...} tabIndex={0} />}`；或为图表设 `role="application"` 并启用 roving tabindex（同 KeyCharts 实现）。同时给图表区域 `aria-label`（已有）。

### 🟡 [m2] Border-radius 多套共存：0 / 3 px / 4 px / 6 px
- **位置**：`styles.css` L20（`--radius: 6px`）、L41–42（`4px`）、L813（`--radius: 3px`）、L948（`border-radius: 0`）；pixel-layout.css 全局 `border-radius: 0 + clip-path`。
- **问题**：基础 token 与 pixel override 同时存在，开发者挑组件时会问「我该用哪个？」。
- **方案**：仅保留 `0` 与 `6px` 两档：`--radius-soft: 6px`、`--radius-pixel: 0`。在 ≥1024 主题切换到 `--radius-pixel`；删除 `4px` / `3px` 散值。

### 🟡 [m3] 间距 token 与魔法值混用
- **位置**：styles.css L67–111、L137–209 出现 14/15/17/18/19/20/21/24 px padding、9/10/11/12/13 px 字号、3/4/5/6/7 px 行高、9/10/11 px letter-spacing。无一处 `--space-*` token。
- **证据**：pixel-layout.css L26–55 同样使用 11/12/13/14/15/16/18 px magic 值；dashboard-reference.css L23–37 又是另一组（17/38 px 等）。FIGMA_HIFI_SPEC §2.2 列出 4/8/12/16/24/32/40/48 的 spacing scale，但代码完全没引用。
- **方案**：建立 `--space-1..8`（4/8/12/16/24/32/48/64）；加 stylelint 规则禁止 raw px 值进入 margin/padding/gap。同步把 `--type-caption: 12px`、`--type-label: 11px` 等抽出。

### 🟡 [m4] 字号含 8–10 px，低于可读下限
- **位置**：pixel-layout.css L146 `font-size: 8px`（dashboard-capability-card 描述行）；styles.css L109、L158、L201、L213、L788 等大量 `font-size: 9px`、`10px` 用于解释性标签（zone exposure、prediction model panel、prediction-formula-fallback）。
- **问题**：8 px 与 9 px 字号在桌面 1440px 视距下辨识度差，对老花、低视力用户极不友好，违反 WCAG SC 1.4.4（文字缩放）精神。
- **方案**：将最小字号提升到 11 px；面板次要文字使用 `text-transform: uppercase + letter-spacing` 替代小尺寸表达层级；与现有 `span small` (`10px`)、` 9px` 等标签统一成 11/12 px 两级。

### 🟡 [m5] 字体栈在 base 与 pixel 之间不一致
- **位置**：styles.css L31（`"Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace`）vs L829（`"SFMono-Regular", Consolas, "Microsoft YaHei UI", monospace`）。基线 `font-family` 用 `"Microsoft YaHei UI"` 在主族，pixel overlay 改用 `Inter, "Segoe UI"`。
- **方案**：用 `--font-sans`、`--font-mono`、`--font-display` 三个 token；Cascadia/Inter 由 token 决定。

### 🟡 [m6] 空态/错误/Loading 覆盖不均
- **位置**：`components/Feedback.tsx` 定义了 `LoadingBlock / ErrorBlock / EmptyBlock`，但页面层级使用不一致：`DashboardPage` 用 `<LoadingBlock/>`；`PredictionsPage` 直接 `<div className="page"><LoadingBlock label="..."/></div>`；`WorkoutTable` 空数据时只渲染空 `<tbody>` 没有空态；`pages/DataModelPage.tsx` 63 KB 大文件（未审）大概率有自己的实现方式。
- **方案**：把 `EmptyBlock`、`LoadingBlock`、`ErrorBlock` 升级为必填 `<PageState>` 模式，每个列表/表格/图表容器必须显式选择 `loading | empty | error | ok | partial` 之一，并提供一致的可视骨架（图标 + 标题 + 描述 + 重试/导入 CTA）。

### 🟡 [m7] 像素 chibi 精灵图在多处手定位
- **位置**：`styles.css` L902（`/assets/runner-chibi.webp -4px -7px / 368px 138px`）、L1015（`0 -20px / 512px 192px`）；`pixel-layout.css` L36（`-1px -18px / 320px 120px`）、L95（`-1px -18px / 320px 120px`）；`reference-shell.css` L53（`-4px -6px / 376px 141px`）。
- **问题**：同一张 512×192 sprite，被 4 处不同尺寸/偏移地 hand-positioned。改 sprite 即需改 4 处，未来增删图标场景困难。
- **方案**：将 runner-chibi 替换为 `<img class="icon-runner" />`，通过 CSS object-position + width/height 控制取景；或维护一个 `icon-sprite.css` 集中声明每种用途的 `background-position` 与 `background-size`。

### 🟡 [m8] 预测页 nav 用 `<b aria-current="page">` 而非 `<a>`
- **位置**：`pages/PredictionsPage.tsx` L199：`<b aria-current="page">生理与成绩预测</b>`，与同 nav 内其他 `<Link to="/zones">训练分区</Link>` 行为不一致。
- **方案**：保持 `<a aria-current="page">`（去掉 href 或 `aria-disabled="true"`）；或在外层用 `<nav aria-label="...">` + `<ul role="list">`，current 项用 `<a aria-current="page">`。

### 🟢 [e1] 数字 tabular-nums 仅在 `@media ≥1024` 生效
- **位置**：styles.css L31–32 在 pixel 媒体查询里才设 `font-variant-numeric: tabular-nums`；base 没有。
- **方案**：在 `:root` 一次性设置 `font-variant-numeric: tabular-nums`，并通过 `.numeric` 类豁免等宽字体（仅做数字等宽），避免全站 monospace 误用。

### 🟢 [e2] 大量「裸 hex」可语义化
- **位置**：styles.css 散布 `#f4f6f4`（workout-table th 背景）、`#dfcaa7`（job-banner 边框）、`#bcd5c5`、`#bad2c2`、`#dfb5af`、`#e3d4b9`、`#a8bcae`、`#e9ede9`、`#cfd7d0`（button border）、`#f7f9f7`、`#f7eedf`、`#f7faf5`、`#f7faf7`、`#fffef0`、`#f5fbf2`、`#f7fbf8`、`#f8fbf8` 等。多数是状态/容器/表面的语义色，但缺乏命名 token。
- **方案**：定义语义 surface token（`--surface-job-warning`、`--surface-job-success`、`--surface-job-danger`、`--border-job-warning` ...），统一引用。

---

## 主题趋势建议（不写实现代码）

1. **建立 `DESIGN.md` 作为唯一源文件**：放在仓库根，列 tokens（CSS 变量定义）、组件清单、图表规则、空白态模板、可访问性 checklist；指向 `apps/web/src/tokens.css`。
2. **抽出 `tokens.css` + 删除 4 处 token 重声明**：styles.css、pixel-layout.css、ios-pixel.css、reference-shell.css 都消费同一组 `:root` token。
3. **新增暗色主题**：先 `prefers-color-scheme: dark` 自动跟随，再在 Settings 提供 [data-theme] 切换器。
4. **图表颜色 token 化**：让 AbilityChart / DashboardPerformanceChart / WorkoutSeriesChart 都从 CSS 变量读色。
5. **统一圆角策略**：保留 0 / 6 px 两档，删除 3 px / 4 px 散值。
6. **空态/错误态标准化**：每个有数据加载的页面强制三态（loading / empty / error），统一使用 `<PageState>` 组件。
7. **可访问性最小补丁**：CaDot 改为可 focus 元素；StatusBadge 加 icon 前缀；所有 icon-button 强制 `aria-label`；预测页 nav 改用 `<a aria-current>`。
8. **最小字号策略**：将 8–10 px 字号提到 11 px；通过 uppercase + letter-spacing 强化层级表达。
9. **状态语义补全**：补 `--color-info`，引入对应 `status-badge.info` 与面板用法。
10. **视觉参考更新**：把 `docs/design-references/pixel-ui/*.webp` 迁移到 `design/screenshots/desktop-1440/*.webp` 并在 DESIGN.md 引用，作为当前视觉基准（替代过时的 FIGMA_HIFI_SPEC.md）。

---

## 审查覆盖与方法

- **审过的文件**：`App.tsx`、`main.tsx`、`IosMobileApp.tsx`、`ios/App.tsx`、`styles.css`（全 1262 行）、`reference-shell.css`、`pixel-layout.css`（前 160 行）、`ios-pixel.css`（前 140 行）、`first-run-pixel.css`、`dashboard-reference.css`、`Feedback.tsx`、`StatusBadge.tsx`、`WorkoutTable.tsx`、`AbilityChart.tsx`、`OverrideDrawer.tsx`、`GlobalTaskStatus.tsx`、`DashboardPage.tsx`、`PredictionsPage.tsx`、`WorkoutDetailPage.tsx`。
- **审过的视觉证据**：`docs/design-references/pixel-ui/{dashboard, workouts, workout-detail}.webp`；通过 grep 与现状（参考截图时间 2026-07-15、代码 git history 2026-09-04）确认代码实现与截图一致。
- **未审**：DataModelPage（63 KB，最大页面）、TrendsPage、StatisticsPage、SettingsPage、TrainingZonesPage、DataAuditPage（仅核查文件存在与 imports）；ios/{Home,Workouts,Statistics,Trends,Settings,Physiology,Week,WorkoutDetail}.tsx 主体未深入。
- **未触碰（按 AGENTS.md）**：mobileNavigation、`.mobile-nav-links`、`@media (max-width: 1180/820/480)` 规则、390px E2E 流程；`apps/ios` 调试壳代码。

> 本报告不写实现代码；如需进一步实施建议，可基于上述 token / 组件拆分方向进入 design-html skill 做 prototype 验证。