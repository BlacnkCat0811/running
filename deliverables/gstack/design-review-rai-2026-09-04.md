# RAI Running 项目设计审查报告（软件工坊 · 多成员协作）

**日期**：2026-09-04
**场景**：设计审查（产品 / 信息架构 / UI 设计系统 / 工程质量与数据层）——只给方案，不实施
**参与成员**：产品评审员（gstack-product-reviewer） + 排障手（gstack-investigator） + 设计师（gstack-designer）
**审查基线**：`main @ 6c61a9a`（工作树含例行未提交改动，审查未触碰任何文件）

---

## 📌 TL;DR（执行摘要）

- 整体结论：🟡 **有条件通过** —— 工程资产（不可变 Run / 原子切换 / shadow gate / 契约版本）教科书级，但"产品叙事断裂 + 设计系统半重构 + 存储语义分裂"是三大结构性问题
- 合并后高信号发现：🔴 5 / 🟠 11 / 🟡 14 / 🟢 1（合并组），阻塞项 0（无阻断性 bug），但存在 2 个**门禁绕过级风险**（R1 激活双实现、R2 持久化生命周期）与 1 个**口径分裂风险**（恢复域 ≥5 套语义）
- 最需要先做的不是写代码，而是 **3 个决策**：①谁是主力产品（桌面 Web vs iOS 壳）②恢复域收敛为几个出口 ③移动端目标/锁定数据是否入主库
- 下一步：按本报告「行动清单」P0→P1 推进；建议先落决策 1（1 天内），再进入分批实施

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| Go / No-Go | 🟡 **条件 Go**（先决策、后分批复用式实施；不收敛口径前不建议一次性动工） |
| 严重度分布（合并去重后） | 🔴 5 / 🟠 11 / 🟡 14 / 🟢 1（低信号已合并组） |
| 关键行动项 | 12 条（见行动清单） |
| 建议负责人 | 仓库 owner（单人项目）——按"决策 → P0 修复 → 分批优化"自排 |
| 本次改动 | 0 文件改动（只读审查，方案未实施） |

---

## 1. 各成员核心结论

### 🔍 产品评审员（产品/架构）
"工程上超配、产品上未闭环"：数据/模型治理 8–9 分，但恢复、今日裁决、周目标等核心价值只被 iOS 壳接住，桌面 Web（名义主力）缺消费端；`/v1/recovery-trends` 已完整实现却无人调用。4 条主链路"最后一公里"未走完，根因是**产品形态决策未落地**（桌面=研究/复盘工作台 vs iOS=日常教练，两套哲学共享一套 API）。建议先明确谁是主力产品，再把恢复概念收敛、补齐功能断点。

### 🛡️ 排障手（工程质量/数据层）
"工程纪律优秀，但架构目标 vs 实现有 4 处系统性落差"：①存储三套分裂（rai.sqlite / runtime.sqlite / mobile-goals.json）备份恢复删除只覆盖业务库；②**模型激活在 HTTP 路由重复实现 storage 仓库方法，语义已微漂移（门禁绕过级风险）**；③写路径巨型单体未拆（database.ts 2067 行 / worker.ts 1930 行 / recompute-pipeline 2155 行）；④时区 Asia/Shanghai 硬编码 137 处/17 文件，与行级 `timezone_identifier` 设计冲突。强项清单明确列出（checksum ledger、staging+rollback、影子 hash、data_version 缓存等）勿在重构中丢失。

### 🎨 设计师（UI/设计系统）
设计系统处于"半重构"状态：token 在 4 处声明、同一种"绿色"有 4 个色值、`:root` 在 `@media ≥1024` 内被静默改写；**桌面正在 ship 与 FIGMA_HIFI_SPEC 相反的 pixel-cut 视觉**（规范源已过时，真实基准是散落的 pixel-ui/*.webp 截图，无 DESIGN.md 源文件）；全站无暗色模式；图表与组件 20+ inline hex 绕过 token；两处可访问性漏洞（CA 点不可键盘达、status-badge 仅颜色编码）。桌面 ↔ iOS 双 UI 平行 token 体系持续漂移。

---

## 2. 综合审查发现（跨成员去重合并，按严重度排序）

> 合并规则：时区硬编码（R3+F14）、goals 文件生命周期（R2+F5）、恢复域口径（F2+R5）、规范漂移（M2+F16）、双 UI 知识分裂（F8+M6）、Dashboard 首屏（F6+F12）、移动读路径（F10+R5 工程面）等跨成员重叠项已合并为单行；来源成员列于末列。

| # | 严重度 | 类别 | 位置 | 问题描述（一句话） | 优化方案（方向） | 来源成员 |
|---|--------|------|------|------------------|----------------|---------|
| 1 | 🔴 | 工程·安全 | `server.ts:953-991` vs `model-run-repository.ts:89-125` | 模型激活逻辑在路由内联复刻仓库 `activateSucceeded()`，已出现 EXISTS 无排序 vs ORDER BY DESC 语义漂移——门禁判断双实现，改动即分叉 | 路由只做错误→HTTP 映射；激活收敛到仓库单实现；补"路由行为=仓库行为"锁测试 | 排障手 |
| 2 | 🔴 | 数据·一致性 | `maintenance.ts` / `runtime-state.ts` / `mobile-goals.ts` | 三套持久化（业务库/运行时库/goals.json）生命周期未协调：备份、恢复、删除只覆盖业务库；goals 脆写（无原子 rename、损坏静默重置为默认 30km）、lock 无 unlock（误锁只能等次日）；删除 DB 后 goals/任务状态残留（隐私语义不清） | 用户可写且不可重建的状态（goals/lock）入业务 SQLite 走同一迁移与备份，或统一 bundle 原子打包；lock 增加 unlock；文档化恢复/删除后每份状态语义与降级策略（读时自愈） | 排障手+产品评审员 |
| 3 | 🔴 | 设计系统 | `styles.css` L1–22/L800–816、`pixel-layout.css`、`ios-pixel.css` L2–21 等 6+ 份 CSS | token 4 处声明、绿色 4 个色值（#1f6d4c/#286b4d/#247446×2）；`:root` 在 `@media (min-width:1024px)` 内静默改写 radius/shadow/ink——两套 token 无文档 | 抽 `tokens.css` 单点声明语义 token；pixel 用 `[data-density]` 显式附加修饰而非 media 内重写 `:root`；DESIGN.md 作为唯一视觉源文件 | 设计师 |
| 4 | 🔴 | 主题 | 全部 CSS grep 无 `prefers-color-scheme/color-scheme/data-theme` | 无暗色模式：桌面强制 #fffef8 浅色 paper，深色 OS 下用户长期使用对比疲劳；原生控件 color-scheme 未设置 | tokens.css 增加 `:root.theme-dark` + `@media (prefers-color-scheme: dark)` 语义 token 暗色版；Settings 提供主题切换器；`html { color-scheme: light dark }` | 设计师 |
| 5 | 🔴 | 可视化 | `AbilityChart.tsx` L43–99、`WorkoutDetailPage.tsx` L25/L137、`WorkoutSeriesChart` 等 | 图表与组件 20+ inline hex 绕过 token，重排版/换肤成本极高 | 增加 `--chart-*` / `--series-*` / `--zone-1..5` token，组件经 CSS 变量取值（recharts 支持 `stroke="var(--...)"`） | 设计师 |
| 6 | 🟠 | 产品形态 | `AGENTS.md`、`App.tsx`/`IosMobileApp.tsx` 双路由树、`apps/ios/README.md` | 桌面"工作台"与 iOS"日常教练"两套产品哲学共享一套 API；iOS README 自称非产品却承载全套教练闭环——定位声明与价值不符 | 明确主力形态（推荐：iOS=日常教练、桌面=研究与复盘工作台），README/AGENTS 写明边界；允许桌面 `?raiShell=ios` 预览手机形态 | 产品评审员 |
| 7 | 🟠 | 领域建模 | `training-load` L63-64/L267-270、`scoring/model.ts`、`features` L114、`prediction-data.ts`、`mobile-coach.ts`、`DashboardPage.tsx` L118-239、`mobile-read.ts` L424-497 | "恢复"口径 ≥5 套（训练五维/PhysState/预测准备度/移动卡/退役 recoveryEvidence）互不一致；桌面渲染已退役恒 null 字段；`buildRecovery.score` 恒 null；移动读路径还残留直接读 health_records 直算睡眠的死代码（与 canonical_nights 两套口径） | 收敛为单一恢复事实源（睡眠/RHR/HRV/负荷+基线），对外只留"训练内 Recovery"与"今日可训练度"两出口；删 recoveryEvidence 死 UI 与 loadSleepWindow/loadMetricWindow 死代码 | 产品评审员+排障手 |
| 8 | 🟠 | 功能闭环 | `data.ts` recoveryTrends、`server.ts` GET /v1/recovery-trends；web/iOS 均无调用 | 服务端恢复趋势端点（28–365 天）已实现，桌面与 iOS UI 均未消费——用户只能看到"昨夜"一个点，无法判断恢复变好/变差 | 桌面 Trends/Statistics 加"恢复趋势"区块（直接消费现有端点，成本低）；iOS 加小趋势卡；或明确定义降级为研究用途 | 产品评审员 |
| 9 | 🟠 | 产品功能 | `mobile-goals.ts`、`ios/Settings.tsx`、`PredictionsPage.tsx` | 目标管理只服务移动端：桌面无周目标/赛事目标入口，预测页不读 raceTarget，两端用户心理模型无法互通 | goals 语义收敛为"训练偏好/计划"并纳入 SQLite（同 training_zone 族），桌面至少提供只读周目标；预测页默认场景读 raceTarget | 产品评审员 |
| 10 | 🟠 | 产品首屏 | `DashboardPage.tsx` L76-122、FIGMA_HIFI_SPEC §4.2、PRD §7.2 | 桌面 Dashboard 标题"你的跑步能力"却不显示 TA/7 日变化/GV/Decay；四卡来源混杂（最近训练配速/维度分/7d 负荷），时点标签缺失，易把"上一场恢复分"当"今日状态" | 首页恢复 TA hero + 7 日变化 + 最新 CA 差第一屏（对齐 iOS）；四卡下移为"最近训练表现"并重命名 + 标注数据时点 | 产品评审员 |
| 11 | 🟠 | 工程·架构 | `storage database.ts`（2067 行）、`worker.ts`（1930 行）、`recompute-pipeline.ts`（2155 行） | 写路径巨型单体：迁移+schema+连接+导入写 API 一文件；3 个 worker 一类文件；最大 pipeline 2155 行无直接单测 | 按既有 ARCHITECTURE_DEBT_MIGRATION 推进 SqliteImportWriter 抽取、pipeline 三段拆分、worker 按类拆文件；每步保持行为锁 | 排障手 |
| 12 | 🟠 | 数据·时区 | 全仓 137 处/17 文件（纯包默认、SQL `+8 hours`、canonicalize-nights、mobile 锚点） | Asia/Shanghai 硬编码贯穿全部层，与 schema 行级 `timezone_identifier` 设计冲突；跨时区/旅行时日边界、周聚合、恢复基线系统性错位 | 收敛单一 App 时区策略（env `RAI_TIMEZONE` 缺省 Asia/Shanghai）于解析/服务边界显式传入；SQL 偏移参数化；补 UTC 边界与跨时区黄金用例 | 排障手+产品评审员 |
| 13 | 🟠 | 设计源文件 | `docs/FIGMA_HIFI_SPEC.md` §2.1-2.2 vs `pixel-layout.css`/`reference-shell.css`/`design-references/pixel-ui/*.webp` | 规范描述 minimal soft（白卡 6px 圆角软阴影），实际 ship pixel-cut 硬边 2px 描边——两份文档相隔 5 天风格相反，FIGMA 稿仍被当"当前设计稿"引用 | 退役 FIGMA_HIFI_SPEC（标注归档/冻结期），建立 DESIGN.md（tokens+组件清单+图表规则+a11y checklist），以 pixel-ui 截图为视觉基准 | 设计师+产品评审员 |
| 14 | 🟠 | 前端架构 | `components/*` vs `ios/*.tsx`、`format.ts` vs `ios/shared.tsx`；styles.css vs ios-pixel.css | 双 UI 重复实现与知识分裂：核心可视化/格式映射各写两套，`trainingStatusLabel` 已有 3 份近似不同文案，平行 token 系统（品牌绿桌面 #286b4d vs iOS #247446）持续漂移 | 纯格式/标签/状态映射收进 format.ts 单源（桌面+iOS 共用）；共享语义色 `--color-brand/--color-coral`，ios 仅做 alias | 产品评审员+设计师 |
| 15 | 🟠 | CSS 结构 | `dashboard/training/data/analysis-reference.css` | 每页一份 `*-reference.css` 重复 media wrapper 与 grid/panel 覆写，styles.css 已达 1262 行 | 组件就近 CSS Modules（WorkoutTable/AbilityChart/RoutePlot 等），删除整组 `*-reference.css` | 设计师 |
| 16 | 🟠 | 组件·可访问 | `styles.css` L228-231、`StatusBadge.tsx`、spec §2.1 status/info | 状态色语义缺 info（诊断语境误用 amber/green）；status-badge 仅颜色编码，色盲用户难辨 | 补 `--color-info` + `.status-badge.info`；StatusBadge 加语义图标前缀或左侧形状条（与 ◉▥◆ 风格一致） | 设计师 |
| 17 | 🟡 | 信息架构 | `App.tsx` L89-99/L137-144/L269 | 桌面导航 9 项平铺主次不明；`/data/audit` 普通路径被 filter 成隐藏路由；`/more` 是 desktop 幽灵路由 | 一级导航收敛为 5 主干（概览/训练/统计/趋势/预测），分区/数据与模型/审计/设置入二级；审计页给显式入口 | 产品评审员 |
| 18 | 🟡 | API 设计 | `data.ts` mobileToday、`mobile-coach.ts`（797 行）、`server.ts` | `/v1/mobile/today` 单响应做 10+ 件事；教练规则引擎 30+ 硬编码阈值（sleep<0.75、HRV<0.85、RHR>1.03、ACWR 1.3/1.5…）绑在 Fastify 应用层，违背"移动端复用 TS 核心"承诺 | 规则下沉纯 TS 包（packages/coaching）、阈值进 versioned config；或拆分 morning-card/next-session/week 端点降低单响应耦合 | 产品评审员 |
| 19 | 🟡 | 数据·口径 | `data.ts` mobileStatistics/mobileTrends、`trends-read-repository.ts`（SQL `+8 hours`）、`mobile-read.ts` | 移动/桌面统计趋势重复 SQL 未下沉 storage（与 ARCHITECTURE §4.7 声明不符）；recovery-trends 按墙钟 `new Date()`、移动端按数据最新日期锚定，口径已不一致 | storage 统一提供"按 as-of 锚定"公共查询（桌面/移动传不同 asOf）；删移动读路径死代码；文档同步修正"已下沉"表述 | 排障手+产品评审员 |
| 20 | 🟡 | 产品·复杂度 | `DataModelPage.tsx`（1555 行） | Feature/Model Run/shadow gate 术语直接暴露给个人用户门槛过高；单文件功能密度远超其它页 | 用户文案收敛为"模型版本+数据更新时间+重算按钮"，Run/门禁折叠为高级区；页面拆为导入与任务/模型与版本/数据审计三段 | 产品评审员 |
| 21 | 🟡 | 移动 UX | `ios/Home.tsx` L39-45/L248-254、`mobile-coach.ts` L279-281 | 数据陈旧（latestDataDate<today）时首页仍显示完整 TA+裁决 UI（有诚实黄条但可能被误解）；phase 在客户端推断与服务端裁决各一份 | 陈旧时服务端锁 tone=yellow 且 UI 弱化 TA/裁决、突出"同步后给裁决"CTA；phase 收敛服务端单一出口 | 产品评审员 |
| 22 | 🟡 | 契约 | `api-contracts` L451-458、`schemas.ts`、`mobile-goals.ts`、`mobile-coach.ts`、DB CHECK | 同一词汇（session kind/race distance 等）5 处定义；JSON Schema enum 与 TS union 无推导/断言，漂移时合法值被误拒或非法值漏过 | contracts 定义 `as const` 唯一词表，TS union 推导、schema enum 生成；补断言测试 schema.enum==TS 值集 | 排障手 |
| 23 | 🟡 | 契约·响应 | `schemas.ts` L400+ openapi 手写、`server.ts` 无 response schema、`api-contracts` 大量 `\|string` 放宽 | 路由响应无运行时校验，契约只受编译期保护；openapi.json/路由/DTO 三份手维漂移 | 同源生成 openapi + 关键端点启用 `schema.response`；收紧 `|string`；响应 DTO 黄金快照测试 | 排障手 |
| 24 | 🟡 | 类型安全 | 全仓 159 处 `as unknown as`（pipeline 34、database 20…） | SQLite 行边界普遍强制类型，列更名/语义变化静默返回 undefined/NaN，错误延迟到业务逻辑 | 引入带列名校验的 `mapRow<T>` mapper 层；eslint 门禁 as any/unknown；JSON 只在契约边界解析 | 排障手 |
| 25 | 🟡 | 迁移治理 | `database.ts` L1282-1296/L1414-1426 checksum(up.toString())、L939-945 v11 占位 | 迁移 checksum 基于函数源码，改注释/格式化即全线 fail-closed，缺合法修订流程；空占位版本依赖编号连续易误用 | 文档化"已发布迁移不可变，只能新增 vN+1"；hash 改稳定化 body 摘要；dry-run 检查 CLI；避免空占位 | 排障手 |
| 26 | 🟡 | 并发 | `worker.ts` RecomputeWorker.drain vs ImportWorker 1613-1700 | live-DB 重算与 staging 克隆+rename 换库无显式互锁，swap 窗口内 live 产生的新 model run/job 随文件替换丢失 | import activate 阶段加 recompute 静默互锁；swap 并发集成测试；文档化优先级（建议导入为准） | 排障手 |
| 27 | 🟡 | 分层 | `server.ts` L298-304/L427-448/L440-460 | 路由与启动引导仍内联 SQL/治理决策（如 checkTrainingZoneBackfill 自动 enqueue full recompute） | 收敛为 application 服务 `ensureZoneBackfillCompatibility()`（可注入 repo）；路由只留错误映射 | 排障手 |
| 28 | 🟡 | 测试 | `recompute-pipeline.ts`（2155 行）vs `packages/application/test/` | 最大、最贵、最易回归的模块 0 个直接单测引用，只能靠门面间接覆盖 | 建直接单测（内存/临时 DB fixture）：shadow mismatch 拒绝、checkpoint 复用边界、swap 并发、快照半写取消 | 排障手 |
| 29 | 🟡 | 可访问/细节 | `AbilityChart.tsx` L40-49、pixel-layout.css L146、styles.css 8–10px 字号 | CaDot `<circle onClick>` 键盘不可达；8–10px 字号低于可读下限（WCAG 1.4.4 精神）；空态/loading/error 覆盖不均；chibi sprite 4 处手定位 | CaDot 包 `<button>`；最小字号 11px + uppercase/letter-spacing 强化层级；`<PageState>` 强制三态；sprite 集中 `icon-sprite.css` | 设计师 |
| 30 | 🟢 | 机会（合并组） | styles.css 散裸 hex；api-contracts re-export 领域类型；SEED_CONTENT_HASH 哨兵 | 裸 hex 可语义化（--surface-job-* 等）；api-contracts 应只导出 HTTP DTO 白名单；哨兵用 NULL+显式状态列取代 | 定义语义 surface/border token；禁用 api-contracts `export *`；seed 迁移真实空状态指纹 | 设计师+排障手 |

---

## 2.1 优化方案优先序（严重度 × 成本 × 依赖）

| 序 | 动作 | 对应发现 | 预估成本 | 性质 |
|----|------|---------|---------|------|
| 0 | **产品形态决策**：主力产品是谁 + 恢复域收敛为几个出口 + goals 是否入主库 | F1/F2/F4 | <1d | 决策（先于一切代码） |
| 1 | 模型激活收敛仓库单实现 + 行为锁测试 | #1 | 0.5–1d | P0 修复 |
| 2 | 三套持久化生命周期协调（先文档化语义 + goals 读时自愈 + lock unlock，再入库/打包） | #2 | 2–4d | P0 数据一致性 |
| 3 | 桌面 Dashboard 恢复 TA hero + 恢复事实区块（消费已存在 recovery-trends） | #8/#10 | 2–3d | 高价值低成本 |
| 4 | 移除退役 recoveryEvidence 死 UI + 移动读路径死代码，收敛"恢复"命名 | #7 | 1–2d | 口径收敛 |
| 5 | 设计系统 token 化（抽 tokens.css + [data-density] + 图表色 token） | #3/#5 | 3–5d | 重构（先行铺垫暗色） |
| 6 | 暗色模式 + color-scheme | #4 | 1–2d | 体验 |
| 7 | 时区配置化（env RAI_TIMEZONE + SQL 参数化 + 边界测试） | #12 | 1–2d | 越晚越贵 |
| 8 | goals 纳入主数据 / 桌面只读目标 + 预测读 raceTarget | #9 | 2–3d | 产品闭环 |
| 9 | mobile-coach 规则下沉纯 TS + 阈值配置化 | #18 | 3–5d | 架构 |
| 10 | 写路径拆分（ImportWriter/pipeline/worker 按既有债务方案） | #11/#28 | 分期 | 架构 |
| 11 | 契约/类型收口（词表单源、response schema、mapRow、迁移策略） | #22/#23/#24/#25 | 分期 | 稳健性 |
| 12 | DESIGN.md 建立 + FIGMA_HIFI_SPEC 归档标注 | #13 | 0.5d | 文档 |

---

## ✅ 行动清单

| # | 行动 | 负责方 | 紧急度 | 期望完成 |
|---|------|--------|--------|---------|
| 1 | 拍板产品形态决策（桌面/iOS 定位、恢复域出口数、goals 归属），同步更新 README/AGENTS | 仓库 owner | P0 | 1d 内 |
| 2 | 删除 `server.ts:953-991` 内联激活，收敛 `SqliteModelRunRepository.activateSucceeded()` 单实现，补路由=仓库行为锁测试 | owner | P0 | 随下个迭代 |
| 3 | 文档化 tri-store 恢复/删除语义；mobile-goals 改 tmp+rename 原子写 + 损坏保留副本；lock 加 unlock | owner | P0 | 1–2d |
| 4 | 桌面 Dashboard 首屏加 TA hero 汇总条 + 恢复事实区块（直接消费 /v1/recovery-trends） | owner | P1 | 2–3d |
| 5 | 删除 recoveryEvidence 死 UI 与 loadSleepWindow/loadMetricWindow/metricValues 死代码 | owner | P1 | 1–2d |
| 6 | 抽取 tokens.css（单点声明）+ `[data-density="pixel"]`，删除 media 内 `:root` 重写；图表色 token 化 | owner | P1 | 3–5d |
| 7 | 暗色模式（prefers-color-scheme + data-theme 切换器） | owner | P1 | 1–2d |
| 8 | 时区配置化：RAI_TIMEZONE env + SQL 偏移参数化 + UTC 边界测试 | owner | P1 | 1–2d |
| 9 | goals/lock 入业务 SQLite（或桌面只读 + 纳入备份） | owner | P1 | 2–4d |
| 10 | DESIGN.md 建立，FIGMA_HIFI_SPEC 归档标注 | owner | P2 | 0.5d |
| 11 | trainingStatusLabel 等格式映射收进 format.ts 单源 | owner | P2 | 1d |
| 12 | 关键模块（RecomputePipeline）补直接单测；启动引导治理收敛 application 服务 | owner | P2 | 分期 |

> ⚠️ 全部建议均未实施（用户要求只给方案）。以上行动需在 AGENTS.md 边界内执行：<1024px 冻结区、mobileNavigation、390px E2E 不在任何方案范围内（设计师已确认未触碰）；涉及 iOS 壳/桌面双形态的改动需先完成决策 1。

---

## ⚠️ 待完善 / 已知局限

- **未执行全量测试/运行时验证**：本次为静态走读 + grep 取证；行号基于审查时工作树（`main @ 6c61a9a`），实施前需以最新代码复核。
- **安全专项未单列**：安全官（OWASP/STRIDE）本轮未上场；#2 的隐私语义与 token/备份问题如需深度安全建模，建议另开一轮 security 专项。
- **覆盖盲区**：DataModelPage（63KB）、TrendsPage/StatisticsPage/SettingsPage/TrainingZonesPage/DataAuditPage 页面级代码仅核 existence/imports，iOS 壳各页面主体未深入；这些区域的问题可能被低估。
- **冻结边界**：设计师与产品评审员均未审查/建议 <1024px 冻结响应式区；如未来需处理，须用户显式授权。
- **交叉验证缺口**：部分"死代码/零调用"结论基于 grep 全仓搜索，实施删除前建议再跑一次 typecheck/引用确认。

---

## 📚 成员产出索引（原始报告）

- 🔍 gstack-product-reviewer（产品评审员）原始产出：`deliverables/gstack/raw/product-review-rai-2026-09-04.md`（16 条 F1–F16 + 功能闭环总评矩阵 + 优先序表）
- 🛡️ gstack-investigator（排障手）原始产出：`deliverables/gstack/raw/investigation-rai-2026-09-04.md`（15 条 R1–R15 + 工程强项清单，含行号证据）
- 🎨 gstack-designer（设计师）原始产出：`deliverables/gstack/raw/design-review-rai-2026-09-04.md`（18 条 C1–C3/M1–M6/m1–m8/e1–e2 + 主题趋势建议）

---

> 本报告由软件工坊 AI 协作生成（产品评审员 + 排障手 + 设计师），关键决策请由工程负责人复核。
> 本次审查为只读，未修改任何项目文件。
