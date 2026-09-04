# RAI Running 产品/架构设计审查（产品评审员）

> 审查日期：2026-09-04
> 模式：只读产品/架构设计审查（未修改任何文件）
> 范围：桌面 Web（apps/web，主视口 ≥1024px）、iOS 像素壳（?raiShell=ios）、本地 Fastify API、共享 TypeScript 包
> 审查重点：PRD/现状一致性、功能闭环与用户旅程、信息架构与导航、API 设计、可扩展性/演进、领域建模

---

## 0. 结论先行

**整体判断：这是一套“工程上超配、产品上未闭环”的高度自洽系统。**

工程/数据治理（v1–v18 迁移、契约版本、不可变 Run、shadow gate、原子切换、增量导入）是 8–9 分的水平；但**作为“个人跑步产品”的叙事是断裂的**：多个核心价值点（恢复/睡眠/HRV、今日裁决、周目标）目前只在 iOS 像素壳里被“移动端聚合 API + 文件持久化”接住，而桌面 Web（仓库名义上的主力产品）没有对应消费；同时 `/v1/recovery-trends` 等服务端已完整实现的能力在桌面与移动端都无人调用。**数据层很强，产品层有 4 条主链路的“最后一公里”没有走完。**

最需要决策的 3 件事：
1. **明确谁是主力产品**：桌面 Web“数据分析工作台”与 iOS 壳“日常教练”目前是两套产品哲学塞在一个仓库里，导致导航、恢复概念、目标体系全部分裂。若桌面是主力，需补齐桌面缺失的恢复/目标闭环；若 iOS 壳是真正要跑的方向，需要停止把桌面做成“第二产品”。
2. **收敛“恢复”域的多套口径**：恢复证据（已退役）、恢复程度（训练内五维）、恢复准备度（预测输入）、PhysState（训练状态门限）、移动端恢复卡/裁决——5 套同名或近似概念各自计算，UI 展示与数据含义并不一致，是目前最深的领域建模隐患。
3. **补齐功能断点**：recovery-trends 桌面 UI 未接入、目标管理仅移动端、lock 无法显式解除、双形态间无互操作指引——都是“差一公里”即可闭环的点，逐个修复成本不高，但对产品叙事收益很大。

---

## 1. 审查方法

- 通读：`README.md`、`RAI_PRD_V1.0.md`（归档）、`AGENTS.md`、`docs/ARCHITECTURE.md`、`docs/WEB_IMPLEMENTATION.md`、`docs/DATABASE_DESIGN.md`、`docs/WEB_COMPLETION_AUDIT.md`、`docs/PROJECT_HEALTH_AUDIT_2026-09-04.md`、`docs/FIGMA_HIFI_SPEC.md`、`apps/ios/README.md`。
- 代码抽读：桌面路由/导航（`App.tsx`）、桌面 Dashboard、移动端聚合实现（`server.ts` 中 `/v1/mobile/*`、`data.ts`、`mobile-coach.ts`、`mobile-goals.ts`）、iOS 壳各页（`ios/*.tsx`）、`packages/training-load/src/index.ts`、`packages/scoring/src/model.ts`、`packages/application/src/prediction-data.ts`。
- 以下每条均给证据位置；严重度：🔴 阻塞 / 🟠 高 / 🟡 中 / 🟢 低。

---

## 2. 高信号发现清单（按严重度排序）

### F1 🟠 双形态产品定位不清晰：桌面“工作台”与 iOS 壳“日常教练”是两套产品哲学，且共享一套 API + 双套页面树

**位置**：`AGENTS.md`（说只开发桌面 Web）；`docs/ARCHITECTURE.md` §7 与 §3 页头注记（iOS 壳经“产品决策”落地）；`apps/web/src/App.tsx` 与 `apps/web/src/IosMobileApp.tsx`（两棵独立路由树）；`apps/ios/README.md`（自称“调试宿主，不是独立产品”）。

**问题**：
- 名义产品是桌面 Web，但真正的“日常价值”（今日裁决、下一课、锁定、周目标、恢复卡）几乎全部实现为 **iOS 壳像素风页面 + `/v1/mobile/*` 移动端聚合 API**；桌面 Web 反而是一套面向数据/模型审计的“工作台”（数据与模型 1555 行，几乎独占半壁江山）。
- 桌面与 iOS 壳对同一概念做了两套 UX：桌面 Dashboard 顶部是“有氧配速/有氧耐力/训练强度/恢复程度”四卡 + TA 只在趋势页；iOS 首页是 TA 大数字 hero + 今日裁决 + 昨夜恢复事实。用户拿到的是两套首页语义。
- iOS 壳 README 自述“不是独立产品、不能离线”，却承载了全套教练闭环——**产品定位声明与实际功能价值严重不符**。

**影响**：维护双 UI 成本高（见 F8），且当用户只使用其中一端时，都会觉得产品“缺一半”。

**方案**：
- A（推荐）：明确 iOS 壳 = “日常教练”产品形态、桌面 = “研究与复盘”工作台，并在 README/WEB_IMPLEMENTATION 中把两套入口写清楚，允许从桌面 `?raiShell=ios` 一键预览手机形态。
- B：把“今日教练/目标/恢复”能力在桌面补一套（复用同批 `/v1/mobile/*` 数据契约 + 新桌面壳），让桌面自洽。
- C：若坚持 iOS 壳仅限调试，则把教练逻辑判定为“移动端产品需求”，重新立项，不要在桌面仓库中继续投入。

---

### F2 🟠 “恢复”域概念与口径不统一：至少 5 套同名/近似计算，UI 含义漂移

**位置**：
- 退役：`packages/training-load/src/index.ts` L63-64、L267-270 —— “Recovery scores are no longer consumed by training status / recoveryEvidence 被有意退役，仅保留列兼容”。
- 训练五维：`packages/scoring/src/model.ts` `defaultRaiModelConfig`（recovery 权重 0.125）；`packages/features/src/index.ts` L114 `RECOVERY_WEIGHTS`（睡眠 35/RHR 25/HRV 25/负荷 15）。
- PhysState：`packages/training-load/src/index.ts` `classifyPhysState`（depleted/reduced/recovered_phys/unknown）。
- 预测输入：`packages/application/src/prediction-data.ts` `loadRecoveryReadiness`（对睡眠/RHR/HRV 做简单均值）。
- 移动端恢复卡/裁决：`apps/api/src/mobile-coach.ts` `buildRecovery`（score 恒为 `null`）、`decideVerdict`（阈值链 sleep<0.75、HRV<0.85、RHR>1.03）。
- 桌面 UI 仍在展示已退役的“恢复证据”：`apps/web/src/pages/DashboardPage.tsx` L118-119、L239；`apps/web/src/pages/StatisticsPage.tsx` L168 —— 该值现在恒为 `null`，会永远显示“等待恢复证据/--”。

**问题**：
1. 一个“恢复”被拆成训练内五维、当日生理状态、预测条件、移动端卡片、训练状态输入五种语义，**但都叫/近叫“恢复”**，用户无法判断“恢复程度 65/100”与“今日裁决：只宜有氧”之间的关系。
2. 桌面仍在渲染**已退役字段** recoveryEvidence（数据源恒 null），是明显死代码/死 UI。
3. 移动端 `buildRecovery.score` 恒为 `null`，契约却保留 score 字段，形成“字段在、数值永不填充”的空洞抽象。

**影响**：同一晚睡眠差，在训练五维、PhysState、恢复准备度、今日裁决里可能给出 4 个不一致的信号解释，违背 PRD“可解释、稳定、诚实表达不确定性”原则。

**方案**：
- A（推荐）：收敛为一个**恢复领域事实源**（睡眠/HRV/RHR/负荷 4 信号 + 个人基线），对外只暴露两个派生出口——训练内 Recovery 维度（跑后复盘用）与“今日可训练度”裁决（训练前决策用），删除/冻结其余口径。
- B：若多口径是刻意设计（训练内 vs 当日决策确实不同），则必须在契约与 UI 文案上区分命名（如“恢复状态（训练时）”“今日准备度”），并删除桌面 recoveryEvidence 死 UI。
- C：至少先把“恢复证据”退役字段从桌面 Dashboard/Statistics 移除，改为展示真实存在的 PhysState/恢复事实。

---

### F3 🟠 主链路断点：`/v1/recovery-trends` 服务端已实现，但桌面与移动端 UI 均未消费；睡眠/HRV 恢复数据没有趋势可视化

**位置**：
- 服务端：`apps/api/src/data.ts` `recoveryTrends(days)`；`apps/api/src/server.ts` GET `/v1/recovery-trends`；存储 `SqliteRecoveryFactsReadRepository`。
- UI 消费：桌面 `apps/web/src/**` **全文无** `/v1/recovery-trends` 调用；移动端 iOS 壳只消费 `/v1/mobile/today`（昨夜卡）与 `/v1/predictions`（恢复准备度百分比），也没有睡眠/HRV 趋势图。`docs/WEB_IMPLEMENTATION.md` L77 自己标注“桌面图表待接入，移动端恢复卡走 /v1/mobile/today”。

**问题**：schema v17 投入了 canonical_nights/canonical_hrv_days 完整事实管线，服务端有 28–365 天恢复趋势端点，但**产品没有任何页面展示睡眠时长/HRV/RHR 的连续趋势**。用户只能看到“昨夜”一个点 + “当前是否偏低于基线”，无法判断恢复状态是变好还是变差——而这恰恰是 RAI “解释为什么今天跑得好/差”的核心证据。

**方案**：
- A（推荐）：桌面 Trends 或 Statistics 增加“恢复趋势”区块（直接消费 `/v1/recovery-trends`），iOS 壳 Trends/身体指标页同步加一个小趋势卡。这是把已有能力变现，成本低。
- B：若产品决策为“睡眠/HRV 只在移动端卡展示”，则应明确降级 `/v1/recovery-trends` 为研究用途并从 README 的交付承诺中移除（避免“已实现=已交付”的错觉）。
- C：折中——桌面 Dashboard 训练状态卡旁加“最近 7 夜睡眠/HRV”迷你事实行，先解决“用户根本看不到恢复事实”的问题。

---

### F4 🟠 目标管理只服务移动端：周目标/赛事目标/课表参数全部落在 iOS 壳与 JSON 文件，桌面与移动端无互操作

**位置**：
- 目标读写在 `apps/api/src/mobile-goals.ts`（`var/mobile-goals.json`）；`GET/PUT /v1/mobile/goals`、`POST /v1/mobile/lock` 仅被 iOS 壳调用。
- UI：目标编辑只在 `apps/web/src/ios/Settings.tsx`；桌面 Settings/任何桌面页**无周目标/赛事目标入口**。
- 桌面预测页 `PredictionsPage.tsx` 是可调温度/湿度/爬升的场景化预测，但**不读写 goals 里的 raceTarget**，与移动端目标赛事完全脱节。

**问题**：
- 桌面上找不到“这周目标多少公里/备赛哪场”，iOS 壳里设定的赛事目标不会影响桌面预测场景，反之亦然——用户在两端的心理模型无法互通。
- goals 决定 `decideVerdict`/`decideNextSession`（教练输出）的关键参数（周目标、轻松占比下限、质量课上限、赛事目标），但它既不在 SQLite 备份/恢复/删除流程内，也不在 `/v1/diagnostics` 内；`PROJECT_HEALTH_AUDIT` 也没覆盖它。作为“用户意图”数据，它却是整个系统里**最脆弱的持久化**（见 F5）。

**方案**：
- A（推荐）：goals 语义收敛为“训练偏好/计划”域并纳入 SQLite（`training_plan_settings` 或现有 `training_zone_profile_settings` 同族），让备份/恢复/删除/诊断与主库一致；桌面至少提供只读周目标展示。
- B：若坚持文件持久化，至少：(a) 桌面新增目标展示/编辑入口（复用同一 goals 契约）；(b) 桌面预测页读取 raceTarget 作为默认场景；(c) 将 goals 纳入备份（或明确文档声明其不在备份内）。

---

### F5 🟡 目标文件持久化缺少原子性、并发协调与备份集成，且 lock 无法显式解除

**位置**：`apps/api/src/mobile-goals.ts` 全文件；`server.ts` PUT `/v1/mobile/goals` 与 POST `/v1/mobile/lock` 直接操作同一文件；`mobile-coach.ts` `lockState` / `resolveLockedNextSession`。

**问题**：
1. **写放大 + 竞态**：每次 PUT goals 或 POST lock 都 `writeFileSync` 整文件（无原子 rename），两个并发写（用户在 iOS 设置保存目标的同时点锁定）可能互相覆盖；与 SQLite 的 `MutationCoordinator`/publication lock 形成反差。
2. **弱校验**：读损坏 JSON 时 `loadFile` catch 直接返回 `emptyGoals()`（L126-128），用户目标在文件半写/损坏时**静默丢失**并被重置为默认 30km，无告警。
3. **lock 无显式解除**：`POST /v1/mobile/lock` 只接受 lock/relock；若用户误锁或当天不跑想取消，只能等第二天（localDate 变化）或等“恢复变差→relock”。没有“unlock/今天不练了”操作。
4. 与 F4 相同：该文件不在备份/删除范围内，属数据一致性盲区。

**方案**：
- A：lock 增加 `unlock` action（或语义改为“今日计划仅当日有效，自然过期”并明确文案），避免把用户锁死在错误课表。
- B：`MobileGoalsStore.write` 改为 tmp+rename 原子写，并在解析失败时保留坏文件副本 + 显式错误而非静默回默认。
- C：若长期保留 JSON，考虑串行化（简单 mutex）与纳入备份 glob。

---

### F6 🟠 桌面 Dashboard 顶部弱化核心能力指标，TA/趋势与“恢复”均在更深层页面；首页没有回答 PRD 首要问题“我的真实能力”

**位置**：`apps/web/src/pages/DashboardPage.tsx`（四张卡是“有氧配速/有氧耐力/训练强度/恢复程度”，来源于最新训练 + 负荷，而非 TA）；对照 `docs/FIGMA_HIFI_SPEC.md` §4.2（Overview 首屏 TA hero）与 `RAI_PRD_V1.0.md` §7.2（首页：真实跑力大数字 + 7 日变化 + GV）。

**问题**：
- 桌面首页标题是“你的跑步能力”，但**不直接显示 TA 数值、7 日变化、GV、Decay**——这些只在 `/trends` 或 iOS 壳首页。用户打开桌面首页，看到的是“最近一次训练的平均配速”和“最近一次训练的维度分”，可能误以为那代表当前能力。
- 与 FIGMA 高保真规范不一致：spec 要求 Overview 的 TA hero，当前桌面 Dashboard 实现成“训练表现”导向。文档（WEB_COMPLETION_AUDIT 声称“概览 TA、7 日变化、CA/TA 差、GV、校准、Decay、解释”）与现状脱节。

**方案**：
- A（推荐）：桌面 Dashboard 顶部恢复“真实跑力 TA + 7 日变化 + 成长速度 + 最新 CA 差 + 关键解释”的第一屏（与 iOS 首页对齐），把训练四卡下移为次级区块。
- B：若桌面刻意定位“训练表现工作台”，则修改页面标题/文案（不叫“你的跑步能力”），并在明显位置引导“查看真实能力趋势 → /trends”。
- C：最小改动：在 Dashboard 增加 `latestSnapshot`（API 已返回）的 TA 汇总条，数据零成本、页面只读已具备。

---

### F7 🟡 桌面侧边导航信息层级扁平化：9 个一级入口混入“功能页/设置页”，且与 FIGMA 导航规范不一致

**位置**：`apps/web/src/App.tsx` L89-99 desktopNavigation（概览、训练、分区、统计、趋势、预测、数据与模型、数据审计、设置 9 项平铺）；对照 `docs/FIGMA_HIFI_SPEC.md` §3.1（Overview/Training/Trends/Data & Model 为主干 + 底部设置图标）；`/data/audit` 与 `/more` 的特殊显隐逻辑（L137-144）。

**问题**：
- “分区（设置类）”“预测（功能页）”“数据审计（只读分析）”“设置”都与高频浏览页同层级，导航宽度 224px 下信息密度高、主次不明。
- `数据审计` 在普通路径下被 filter 掉（L138-140），只有在 `/data/audit` 时才出现——用户不知道有审计页；而 `/more` 页只存在于移动导航，desktop 也注册了 `/more` 路由（L269）但桌面导航永远不显示入口，形成隐藏路由。
- 该导航同时服务桌面与 390px 冻结态（`mobileNavigation`），两套列表靠同一份 items 数组二次过滤，脆弱。

**方案**：
- A（推荐）：把桌面一级导航收敛为“概览 / 训练 / 统计 / 趋势 / 预测”，把“分区、数据与模型、数据审计、设置”归入二级（设置区或“更多”抽屉），与 FIGMA 规范一致。
- B：删除 desktop 不用的 `/more` 路由或明确其为 390px-only。
- C：`/data/audit` 提供显式入口（如数据与模型页内 tab），避免隐藏路由。

---

### F8 🟡 双套 UI 重复实现与知识分裂：同一组件语义在桌面与 iOS 壳各写一遍，且存在第三处“format/工具”层

**位置**：`apps/web/src/components/*`（AbilityChart/TrendAnalysisCharts/WorkoutTable）与 `apps/web/src/ios/*`（Trends.tsx 内联实现 AbilityChart、WorkoutRow/Stat/zone 工具）；`apps/web/src/format.ts` 与 `apps/web/src/ios/shared.tsx` 两处都有 `trainingStatusLabel`/`sessionType`/`pace` 等近似映射。

**问题**：
- 能力曲线、训练状态标签、周柱状图等核心可视化在桌面与 iOS 壳有两套实现（甚至 CSS 也分 `styles.css` / `reference-*.css` / `ios-pixel.css` / `pixel-layout.css`），一旦语义（如 TrainingStatusCode 标签）更新，很容易只改一端——事实上 `trainingStatusLabel` 在 `pages/DashboardPage.tsx`、`pages/StatisticsPage.tsx`、`ios/shared.tsx` 已有 3 份近似但不同文案。
- 桌面 `format.ts` 与 iOS `shared.tsx` 存在 `sessionType/pace/trainingStatusLabel/zoneColors` 重复定义（F1 的微观版）。

**方案**：
- A：把纯格式/标签/状态映射收进 `apps/web/src/format.ts`（桌面+iOS 共用），CSS 主题独立但组件层共用；iOS 壳只保留像素风 wrapper。
- B：至少把 `TrainingStatusCode`→中文标签做成单一数据源（从 api-contracts 或 format.ts 导出），消除 3 份漂移。

---

### F9 🟡 移动端聚合 API 职责过重：`/v1/mobile/today` 单响应同时承担数据聚合、教练裁决、下一课开方、锁定、周进度、赛事形态，难以演进与复用

**位置**：`apps/api/src/data.ts` `mobileToday()`（约 130 行 SQL/组装 + 调 `assembleMobileCoach`）；`apps/api/src/mobile-coach.ts`（797 行规则引擎：decideVerdict/decideNextSession/buildWeekPlan/buildInjuryFlags/buildRaceCard）；`server.ts` `/v1/mobile/today`。

**问题**：
1. **职责过重**：一次 `today` 请求做 10+ 件事，且同时依赖 goals 文件与数据库读。任何一处想复用“裁决规则”（未来 RN 直接读库），都必须复用整个 HTTP 聚合，或者把规则再拷一份。
2. **规则引擎藏在 API 进程内**：mobile-coach 有 30+ 硬编码阈值（sleep<0.75、HRV<0.85、RHR>1.03、ACWR 1.3/1.5、easy floor 0.7、quality cap 2、taper 14 天、RACE_TARGETS 15/25/35km），既不在 versioned config，也不在纯领域包，难测试难追溯。
3. 与 PRD 的“移动端复用 TS 评分核心”承诺冲突：这些规则若能复用，应放在纯 TS 包；现状是它们绑定在 Fastify 应用层。

**方案**：
- A（推荐）：把 mobile-coach 规则下沉到 `packages/coaching`（或并入 application 纯 TS 层），API 只做 DTO 组装；阈值进 versioned config JSON。
- B：至少为 `/v1/mobile/today` 拆分“/today/morning-card”“/today/next-session”“/week”等多个聚合端点，降低单响应耦合与单点变更风险。
- C：短期无资源时，为 mobile-coach 补一组针对阈值分支的黄金用例（现测试仅覆盖 trainer 层），锁住行为。

---

### F10 🟡 桌面统计/趋势与移动端统计/趋势存在重复业务查询与口径差异

**位置**：
- 桌面：`/v1/training-statistics/*`、`/v1/trends`、`/v1/recovery-trends`；
- 移动端：`/v1/mobile/statistics`、`/v1/mobile/trends`（`data.ts` mobileStatistics/mobileTrends 各自重写近 3 月/28 天/12 周/纪录查询）。

**问题**：
- 移动端 statistics/trends 与桌面 statistics/trends 本可共享同一批只读 repository 查询，但实现上是两套 SQL/组装，导致“锚定口径、环比定义、纪录识别”必须两处同步（README 说移动端“按数据最新日期锚定”，桌面 `recoveryTrends` 却按 `new Date()` 墙钟取 `end`，L612-617 —— 口径已不一致）。
- `recoveryTrends` 日期序列用 `86400000` 步进且不做时区对齐，与 mobile/trends 的锚定口径不同，一旦两端都消费会出偏差。

**方案**：
- A：统一让 storage repository 提供“按 as-of-date 锚定”的公共查询（trends/recovery/statistics），桌面与移动端传不同 asOf 即可，消灭重复 SQL。
- B：至少统一 recovery-trends 的锚定语义（数据最新日期 vs 墙钟），并加注释/测试明确。

---

### F11 🟡 Feature/Model Run 等概念对普通用户门槛过高，且集中在“数据与模型”一页

**位置**：`apps/web/src/pages/DataModelPage.tsx`（1555 行，含 Feature Run/Model Run/active 指针/shadow gate/导入任务/删除确认）；`docs/DATABASE_DESIGN.md`。

**问题**：
- “Feature Run”“Model Run”“shadow gate”“active pointer”是很好的**内部可复现性**设计，但直接作为产品页元素暴露给个人跑步用户；用户被要求理解“为什么有两个 Run”“候选 Run 是否通过门禁”——这超出“个人跑步能力分析”的目标人群认知。
- 页面 1555 行，单文件功能密度极高，几乎没有拆分（对照其它页面 80–400 行），导航与代码都是“数据与模型”独大。

**方案**：
- A：把面向用户的文案收敛为“当前模型版本 + 数据更新时间 + 重新计算”按钮，Run/门禁/对照片段折叠为“高级/研究”区（或在 `/data/audit` 下）。
- B：把 DataModelPage 拆为“导入与任务”“模型与版本”“数据审计”三个路由/组件，与导航层级（F7）一起治理。
- C：至少保证页面首屏不出现 shadow gate/Feature Run 术语，先回答“我的数据是最新的吗/需要重算吗”。

---

### F12 🟡 桌面页面缺少对“跨页一致的第一价值主张”的提炼：四张能力卡来源混杂

**位置**：`apps/web/src/pages/DashboardPage.tsx` L76-122 四卡（有氧配速=最近训练均配速；有氧耐力=最近一次训练 Stability 分；训练强度=当前 7d 负荷；恢复程度=最近一次训练 Recovery 分）。

**问题**：
- 卡 2 与卡 4 取自**最近一次训练的维度分**，卡 3 取自**当前 7 天负荷**，卡 1 取自**最近训练均配速**——四个指标时间基准不同、语义层级不同，却并排放置成“能力概览”，容易让用户把“上一场训练的恢复分”当成“今天的恢复状态”（与 F2/F6 联动）。
- 指标解释口径与训练详情页/统计页的相同名称可能不一致（Stability 在 Dashboard 叫“有氧耐力”，在详情页是五维的 Stability 维度）。

**方案**：
- A：四卡改为统一当前状态口径（TA/负荷/PhysState/最新跑表现）并明确每卡的“数据时点”标签（如“来自最近一次训练 7/8”）。
- B：复用 F6 的 TA hero 之后，将四卡保留为次级“最近训练表现”块并重命名，避免“能力”二字的误导。

---

### F13 🟡 锁/裁决与“数据新鲜度”语义在 iOS 壳首页交织，存在错误可训练暗示风险

**位置**：`apps/web/src/ios/Home.tsx` L39-45（need_sync 提示“数据不是今天的，不要开绿灯”）、L248-254 `inferPhase`；`mobile-coach.ts` `decideVerdict` 的 stale 兜底 L279-281。

**问题**：
- 移动端裁决依赖“昨夜睡眠/HRV/RHR + 负荷”，但若数据同步滞后（`latestDataDate < today`），裁决退化为“数据不是今天的”黄条 + 默认“只宜有氧”。产品文案很诚实，但首页仍显示“真实能力 TA + 今日裁决”的完整 UI，用户可能误解“裁决基于最新数据”。
- 相位（phase）在客户端推断（inferPhase）与服务端裁决（decideDayPhase/lockState）各有一份，未来如果客户端与服务端时钟/时区不一致（见 F14），裁决与展示会打架。

**方案**：
- A：当 `latestDataDate < today` 时，由服务端把裁决 tone 锁为 yellow 且 UI 弱化 TA/裁决展示，只显示“同步后给今日裁决”主 CTA（iOS 壳首页已有该文案，需保证展示层不绕过）。
- B：把 phase 判定收敛到服务端单一出口（dayPhase 由 API 返回），客户端只渲染。

---

### F14 🟡 时区处理高度集中于 Asia/Shanghai 硬编码，个人工具可接受但缺乏解释与兜底

**位置**：`apps/api/src/data.ts`（多处 `timeZone: "Asia/Shanghai"`）、`apps/api/src/mobile-read.ts`（loadCanonicalNight(..., "Asia/Shanghai")）、`apps/api/src/server.ts` L402-407 `localToday`、`apps/web/src/ios/shared.tsx` `shanghaiDate`、`apps/web/src/pages/SettingsPage.tsx` L355-358（设置页写死显示 Asia/Shanghai）。

**问题**：
- PRD §15.5 明确要求“跨时区与跨午夜”处理，但实现将 Asia/Shanghai 写死在 API/移动端/worker；DB 按 `timezone_identifier` 存储说明已考虑多时区，但产品所有“今日/恢复窗口/锚定”都钉死上海。
- 用户若异地（旅行/换时区）或健康数据带不同时区，恢复夜窗口/“今日”可能取错日期。

**方案**：
- A：短期把“产品时区”做成单例可配置（settings 存储，默认 Asia/Shanghai），API/移动端从同一配置取，避免散落硬编码。
- B：中期按 PRD 处理：Workout 用绝对时间；DailyContext 按数据自带时区关联；恢复窗口按训练开始时间向前查。

---

### F15 🟢 Schema/迁移 v1–v18 + 契约版本 + shadow gate：治理强但存在“为单人工具过度工程”与历史占位噪音

**位置**：`packages/storage-sqlite/src/database.ts`（v1–v18，v11 为占位无 SQL）；`DATABASE_DESIGN.md`；`docs/ARCHITECTURE_DEBT_MIGRATION.md`；`rai-shadow-gate-v1`。

**问题**：
- 对单用户本地工具，v18 迁移 + 契约版本 + hash 对照 + shadow gate 的投入显著高于同类产品；这是**有意为之且执行扎实**，但成本体现在每次 schema/算法变更都要走完整重算/门禁/双 run 对比流程，迭代速度被拖慢。
- 迁移 18 个版本、契约 6+ 个版本常量、每版 feature/model 配置 hash——新人（或半年后的本人）理解成本高；`v11` 空占位属于历史噪音。
- 值得肯定：recompute validation + shadow gate + active pointer 保证“绝不展示半成品”，这是本项目最强的工程资产，不建议回退。

**方案**：
- A：不削减治理，但把“何时必须新 Run/何时可 in-place”写成分层决策表（数据事实变更 / 派生逻辑变更 / 展示口径变更），避免所有变更都触发全量重算的惯性。
- B：文档中为每个契约版本给一行“变更原因+影响范围+是否需重算”的 changelog，把治理成本转为可读资产。

---

### F16 🟢 数据/模型治理强但“用户可见模型状态”文案偏工程化，且存在 README 与实现脱节残余

**位置**：README.md 与实现基本同步（09-04 修订），但：`apps/web/src/pages/SettingsPage.tsx` L358 仍硬编码“Asia/Shanghai”；`docs/FIGMA_HIFI_SPEC.md` 头部声明冻结 `rai-model-config-v2` 而当前为 v3（spec 是历史稿，README 已用文件名日期提示时效）；`docs/WEB_COMPLETION_AUDIT.md` 自注“历史验收快照不代表当前”。

**问题**：文档自身加了“历史/以 README 为准”的免责声明，方向正确；但 FIGMA_HIFI_SPEC（含 Dashboard TA hero、导航、Cardio 诊断等规范）仍被当作“当前设计稿”引用风险高——若按它开发会与现状冲突。

**方案**：给 FIGMA_HIFI_SPEC 头部同样加“归档/仅参考 v2 冻结期”标注，或在仓库维护一份“当前产品规范 vs 历史 spec 差异表”。

---

## 3. 功能闭环与用户旅程总评

以 6 个关键旅程检查，结论：

| 旅程 | 桌面 Web | iOS 壳 | 断点 |
|---|---|---|---|
| 导入 → 审计 → 评分 | ✅ 完整（ZIP/目录/后台任务/审计） | ✅ 原生同步 → 上传 | 闭环 |
| 训练列表 → 详情 → 覆盖 | ✅ 完整 | ✅ 复用列表/详情 + override | 闭环 |
| 趋势/预测 | ✅ 桌面趋势+预测 | 🟡 iOS 趋势/身体指标可用 | 移动端趋势缺恢复维度 |
| **恢复（睡眠/HRV/RHR）** | ❌ 桌面无趋势图，Dashboard 显示退役字段 | 🟡 仅“昨夜卡”+ 恢复准备度百分比 | **F3/F2**：没有连续恢复可视化 |
| **目标管理** | ❌ 桌面无入口 | ✅ iOS 设置可编辑 | **F4**：目标/赛事不在桌面 |
| **训练前决策（今日裁决/锁定）** | ❌ 桌面无此概念 | ✅ 完整 | **F1**：双形态各自半套 |

结论：**最能体现 RAI “能力估计 + 状态解释 + 今日决策”的产品闭环只在 iOS 壳里成立；桌面 Web 是数据/模型工作台，两者之间没有互操作桥。** 这不是“功能缺失”，而是产品形态决策未落地的表现。

---

## 4. 可优化优先序（综合严重度 × 成本）

| 序 | 动作 | 对应发现 | 预估成本 |
|---|---|---|---|
| 1 | 产品形态决策：谁是主力产品，README/AGENTS 明确边界 | F1 | 决策 < 1d |
| 2 | 桌面 Dashboard 恢复 TA hero + 增加“恢复事实”区块 | F3/F6 | 2–3d |
| 3 | 移除桌面已退役 recoveryEvidence 死 UI，收敛“恢复”概念 | F2 | 1–2d |
| 4 | goals/lock 纳入主数据管理（或至少原子写 + unlock + 桌面只读） | F4/F5 | 2–4d |
| 5 | mobile-coach 规则下沉纯 TS + 阈值配置化 | F9 | 3–5d |
| 6 | 桌面导航收敛为 5 主干 + 二级入口 | F7 | 1–2d |
| 7 | 统一 format/trainingStatusLabel 单一数据源 | F8 | 1d |
| 8 | storage 层统一桌面/移动/恢复查询锚定 | F10 | 2–4d |
| 9 | 时区配置化（默认 Asia/Shanghai） | F14 | 1–2d |
| 10 | DataModelPage 拆分 + 文案降级 | F11 | 2–3d |

---

## 5. 审慎肯定（防止只报问题）

- **不可变 Run + 原子切换 + shadow gate + recompute validation**：工程上教科书级，是 RAI 可复现性的基石，建议保留并继续投资。
- **导入/审计/覆盖/备份/恢复链路**：桌面端极完整，含取消任务、失败恢复、在线备份、删除前自动备份，用户数据安全做得很到位。
- **iOS 壳的裁决文案与边界表达**（“数据不是今天的，不要开绿灯”“室内跑不计入真实能力”“把区间当参考”）是产品诚实性的最佳实践，值得作为全端文案标准。
- **PRD 归档 + 现状注记**：文档治理已显著改善（README/ARCHITECTURE 与实现基本对齐）。

---

*审查为只读模式；未修改任何文件。*
