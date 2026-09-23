# RAI 下一步优化建议 · 多智能体讨论纪要

> 讨论时间：2026-09-20 17:50 GMT+8
> 证据底座：模拟器实机截图 5 张（`/tmp/rai-ui/`）+ 云端 9 份真实接口响应（`/tmp/rai-evidence/`）+ 代码逐行核对 + 门禁实跑
> 方法：4 个智能体（指标口径 / 产品体验 / 工程风险 / 红队质询）；**本纪要中所有"已核实"项均由主代理独立复算或实测，非转述**
> 性质：**仅建议，未执行任何改动**

---

## 1. 结论先行

**系统主干是健康的，但我建议先不要碰指标算法——因为现在最"显而易见"的那个修法会制造一条假的安全结论。**

三件事按优先级排：

| | 事项 | 为什么是它 | 代价 |
|---|---|---|---|
| 🔴 **先做** | 把 `/v1/workouts/:id/series` 移出匿名读白名单 | 唯一**不可逆**的在持续暴露：逐秒心率/配速时序，226 KB/次，匿名可取。数据一旦被爬走无法回收 | 改 1 行，不影响任何页面 |
| 🔴 **其次** | 定死"课表真源"，修两份课表打架 | 同一天（09-20）系统给出 `easy 12 km` 和 `long_run 5.5 km` 两个版本，**planRevision 都是 9**。这不修，后面所有课表相关的优化都建在流沙上 | 需你先决策，不是纯代码问题 |
| 🟡 **再次** | 4 周跑量比率——**必须连带修文案与护栏，不能只改切片** | 见 §4：只改切片会让"−54%"翻成"+17%"，并触发一句「跑量爬坡健康，可维持当前节奏」——而这句话来自一个**含 0 km 周**的对照窗口 | 改动面小但**风险高**，需设计 |

---

## 2. 讨论怎么进行的

三个专项智能体并行作业，各自独立取证，然后由红队对它们的结论做交叉质询：

| 智能体 | 视角 | 最有价值的产出 |
|---|---|---|
| 指标口径审查官 | 同一份 payload 里字段之间是否自洽 | 定位了 4 周比率的实现缺陷与基线冻结机制 |
| 产品体验审查官 | 用户看到什么、会怎么误读 | 发现了「今天有两份课表」 |
| 工程风险审查官 | 门禁是否真在把关、能否复现发布 | 实跑 3 项门禁，发现线上健康数据匿名可读 |
| 红队质询官 | 拆前面三份报告的台 | 指出一个"改了会更糟"的陷阱、一处误报 |

**讨论本身的结论**：三人无实质冲突，唯一分歧是**定级哲学**——指标官"看到 −54% 就判 🔴 缺陷"，工程官"用实测门禁定级"。红队最终把 3 条降级、1 条推翻。下面是**经我复核后的净结论**，不是任何单个智能体的原始报告。

---

## 3. 我独立复核后**确认成立**的问题

### 3.1 匿名读健康数据（🔴，正在持续发生）

实测 `/v1/workouts` 200/18,909 B、`/v1/workouts/:id` 200/83,860 B、`/v1/workouts/:id/series` 200/**226,708 B**、`/v1/recovery-trends`、`/v1/predictions` 均匿名 200。

**关键细节（比"全公开"更准确的判断）**：

| 端点 | 结果 |
|---|---|
| `/v1/workouts/:id/series`（逐秒时序） | 🔴 **200 匿名** |
| `/v1/workouts/:id/route`、`/gpx`、`/streams` | 🟢 **401**（GPS 坐标未暴露） |
| `/v1/backups`、`/v1/diagnostics`、`/v1/openapi.json` | 🟢 401 |

**我做了一个决定性实验，把根因钉死**（这是红队留下的唯一待补项）：

```
Host: tpandmr.xyz      -> 200   ← 匿名放行
Host: www.tpandmr.xyz  -> 401
Host: example.com      -> 401
Host: 127.0.0.1:8787   -> 401
Host: localhost        -> 401
```

→ 匿名读由**精确 Host 匹配** `RAI_PUBLIC_HOSTS` 决定。**线上确实设了 `RAI_PUBLIC_HOSTS=tpandmr.xyz`。**

**这不是代码缺陷，是运维配置偏离了自己的文档。** `apps/api/src/server.ts:198-223` 的注释写明这个白名单是"给 Web SPA 免 Token 打开用"的，而项目自己的两份部署文档明确反对当前配置：

- `deploy/README-CLOUD-2C2G.md:51`：「`RAI_PUBLIC_HOSTS` **保持空**」（这份正是 2C2G 云主机指南，与线上主机规格对应）
- `deploy/n100/README.md:167`：「**不要为了页面能打开而设置 `RAI_PUBLIC_HOSTS` 公开健康数据**」

**⚠️ 不要直接全量收回**（红队实测）：`apps/web/src` 全库 **0 处** Bearer；`deploy/nginx-rai.conf:6-11` 说明 iOS WKWebView 壳与浏览器加载的是同一份静态 Web。全量收回 = Web 全站 401 + 壳内同步失效。

**建议**：本轮只把 `series` 收窄（`server.ts:234` 删 1 行），其余端点等你决定整体策略。

**验收标准**：无 Token `curl https://tpandmr.xyz/v1/workouts/<id>/series` 返回 401；Web 与 iOS 所有页面仍正常渲染（`/v1/mobile/today`、`/v1/dashboard` 仍 200）。
**回滚**：把该行加回白名单，重启服务。

---

### 3.2 课表存在两个互相矛盾的版本（🔴，需你决策）

同一时刻、同一个 `planRevision = 9`：

| 来源 | 2026-09-20 |
|---|---|
| `mobile-today.weekPlan` | `easy` / **12 km** |
| `mobile-workout-plan.days[0]` | `easy` / **12 km** |
| `mobile-goals.weekPlan` | `long_run` / **5.5 km** ← 冲突 |

`workout-plan.audit` 显示它由 LLM 生成（`deepseek:deepseek-flash`，`promptVersion: weekly-plan-v2`，生成于 09-18T00:56），`goals.weekPlan` 的理由文案是"恢复数据陈旧且本周轻松占比偏低"。**两侧理由来源不同、版本号却相同**——所以不能用"版本号大小"判谁新。

**这不是我能替你定的**：先要定位写入者，确认 `goals.weekPlan` 是遗留路径还是另一套并行逻辑。

**为什么优先**：产品审查官建议"把今天这一课显式展示出来"。但**现在就展示，等于把矛盾直接摆到用户面前**。先收敛数据源，再谈展示。

---

### 3.3 `weekPlan` 把过去有计划的日伪造成「休息」（🔴）

`mobile-coach.ts:1191-1202` 的行为，实测三处真冲突：

| 日期 | `today.weekPlan` | `recentPlanExecution` / `goals.weekPlan` |
|---|---|---|
| 09-15 | `rest`（`planned: true`） | `recovery` / 4 km |
| 09-17 | `rest`（`planned: true`） | `easy` / 4.8 km |
| 09-19 | `rest`（`planned: true`） | `recovery` / 3 km |

**红队的修正我采纳**：范围没有指标官说的那么大。`09-13`/`09-14` 的 `planRevision = null`（当时确实没有计划），显示 rest 是合理默认。**真冲突只有 `planRevision != null` 的那 3 天。**

**影响**：用户回看时会看到"我当时被安排休息"，而事实上被安排了跑。**"计划 vs 实际"的对照被抹掉，教练信任无法累积。**

**验收标准**：`today.weekPlan[09-17].kind === "easy"`；`weekPlan` 中每个 `planned: true` 的 past 日都能与 `recentPlanExecution` 对上。

---

### 3.4 恢复卡片「恢复良好」与当日建议「只宜有氧」同屏相悖（🟡）

**红队把这条从 🔴 降到 🟡，我同意**——理由是系统当天并没有推强度：`verdict.tone = yellow`（只宜有氧）、`recommendation.recoveryAdjustment = "none"`。所以"诱导用户上强度"是行为假设，不是证据。

**但真正的矛盾在别处，三人原本都没这么表述**：**同一屏上「恢复良好」是绿灯语义，「只宜有氧」是限制语义。** 加上：

- 睡眠 315.8 min = 5h16m，仅为基线的 89%；而**基线本身只有 353.7 min（5.9h）**
- `recovery.hrvSampleCount = 2`（两个样本）
- `recovery.score = null` 是**硬编码**（`mobile-coach.ts:932`），从未计算
- 同时 `dashboard.dimensions.recovery = 40.65`，是五维中倒数第二

**相对化归一掩盖了绝对不足**：睡眠 5.3 小时被判"恢复良好"，因为它比一个同样偏低的个人基线好一点。这是**风险模型的口径问题**，不是文案问题。

**建议**：`score` 为 null 时不输出定性断言，改中性表述 + 明示"睡眠为基线 89%（偏低）"。

---

### 3.5 4 周跑量比率：一个"看似显然的修法"会制造假安全信号（🟡→ 高风险）

这是我建议**最谨慎对待**的一条。

**现状**（`apps/api/src/data.ts:711-716`）：

```ts
const recent   = weeks.slice(-4).reduce(...)        // 含"未结束的本周"
const previous = weeks.slice(-8, -4).reduce(...)
```

`isComplete` 在 `:707` **已经算好了**，但这两行没用它。

**我在真实数据上复算两种口径**（12 周数据取自 `/tmp/rai-evidence/mobile-trends.json`）：

| 口径 | 近 4 周 | 前 4 周 | 结果 |
|---|---|---|---|
| 现状（含未完成周） | 28.3150 | 61.1921 | **−53.73%** |
| 改成"只用完整周" | 42.3479 | 36.0796 | **+17.37%** ← 符号翻转 |

**为什么危险**——`data.ts:761-776` 用这个数字直接驱动一句教练结论：

```ts
if (percent > 30)      → warning  "跑量增幅偏快…超过 30% 安全阈值"
else if (percent > 0)  → positive "跑量爬坡健康…处于安全区间（<30%），可维持当前节奏"
```

- 现状 `percent = −54`：两个分支都不触发（当前唯一 insight 是"真实能力在爬升"）
- 改成完整周后 `percent = +17`：**会新增一句「跑量爬坡健康，可维持当前节奏」**
- 而 +17% 的对照窗口是 `2026-07-20 ~ 08-10`，其中 `07-20~07-26` 是 **0 km** 周

→ 也就是说：**改完之后，系统会依据一个含零周的窗口，给出正向的"可以维持"安全结论。** 对训练负荷风险模型来说，这比现状更糟。

**同时，现状本身也已经自相矛盾**（界面实测）：趋势页卡片标题「里程变化（近 4 周）」+ 数字 **−54%**，副行却是「上周 12.2 km / 本周 11.1 km」（= **−9%**）。同一张卡片三个数互斥。

**还有个跨页符号冲突**（红队提出、我确认）：
- 统计页「环比 **+18%**」← `statistics.totals.distanceChangeFraction = +0.1754`
- 趋势页「近 4 周 **−54%**」← `trends.distanceChangeFraction4Weeks = −0.5373`

同一天、同一个 App，一页说涨一页说跌。

**建议（连带修，不可拆）**：
1. 先定义窗口语义（完整周 / 滚动周），两侧文案都写清
2. 加护栏：对照窗口内出现 0 km 周时，不下"爬坡健康"这类正向结论，或降级为中性
3. UI 修正副行，让它与标题同口径

**验收标准**：趋势页卡片上所有数字可互相复算；`percent` 走向变化时 insight 文案有对拍测试；构造一个"对照窗口含零周"的用例，确认不输出 positive。
**回滚**：还原 `:714-715` 两行。

---

### 3.6 其余确认项（汇总）

| 问题 | 证据 | 定级 |
|---|---|---|
| 统计页顶栏无时间窗标签，与同屏柱状图差 2.7 倍（48.4 km/9 次 vs 130.8 km/23 次） | `data.ts:621-650`；契约 `totals` **无窗口字段**；窗口文案硬编码在 `apps/web/src/ios/Statistics.tsx:84` | 🟡 |
| 训练数据截至 09-16，界面无提示 | 后端**已有** `recommendation.uncertaintyReasons: ["训练数据截至 2026-09-16，尚未包含今天。"]`，**是 UI 没渲染** | 🟡 |
| `easy_floor.value = 0.3`，真值 0.2570 | `mobile-coach.ts:352` 调 `:133` 的 `roundKm()`（注释写明是为"100 m 显示"设计的取整函数）**误用于比率**；同类误用见 `:322-323,329,332` | 🟡 |
| 09-16 计划 `rest` 却跑了阈值课（5.03 km / lactate_threshold），零信号 | `mobile-coach.ts:977` 显式 `plannedKind !== "rest"` 跳过对照 | 🟡 |
| 能力基线冻结在 2024-06-28~08-16 | `dashboard.calibration.baselineStartAt/EndAt` 实测；`recompute-pipeline.ts:1810-1816` 取**最早** eligible 课，凑够门槛即 break | 🟡 设计+未披露，非缺陷 |
| `growthVelocityPerWeek = 0` 与"近 84 日 +3.1"同屏 | 真因**不是**衰减谷：`trends.ability` 中 09-16~09-20 五天 `trueAbility` **完全相同**（46.39956627333749）→ 序列平坦 | 🟡 |
| `recentPlanExecution.distanceRatio` 7 行全 null；`missed` 不可表达 | `plan-execution.ts:34-36`；契约枚举无 `missed` | 🟡 |
| 模型只用到 49/272 堂课 | `dashboard.totals`：sessions 272 / eligible 49 / trial 205 / excluded 18。`trial` = 缺心率或轨迹证据（`packages/features/src/index.ts:392-395`），**不是试用期** | 🟡 |
| 部署不可复现 | 全库无 Dockerfile/compose；线上手工容器；`deploy/upgrade.sh:16-22` 硬假设 `/opt/rai` + `systemctl` | 🟡 |
| 备份"是否在跑"不可验证、失败无告警 | 仓库无 timer 单元，但 `README.md:47` 写"systemd 定时一致性备份" | 🟡 |
| iOS 门禁缺 Xcode 时 `exit 0` | `apps/ios/tests/run-ios-gates.sh:42-47`（脚本自己注释里就写着"静默通过的门禁比没有门禁更危险"） | 🟡 换机时才会显形 |

---

## 4. 红队推翻 / 降级的（含我对红队的纠正）

| 主张 | 判定 | 依据 |
|---|---|---|
| 工程官的「`package-lock.json` 缺 `@rai/training-load`」 | ❌ **误报，推翻** | 红队直接解析 lock，`packages["apps/api"].dependencies` **含**该项，`node_modules/` 下亦存在 |
| 红队称「三人都没提 +18% vs −54% 符号冲突」 | ❌ **红队此处说错了** | 产品体验官的表格里**明确列了**「跨页变化率反向：统计环比 +18% vs 趋势 −54%」。我保留产品官这一条 |
| 指标官对 `growthVelocityPerWeek=0` 的「窗口含衰减谷」解释 | ⚠️ 结论对、**根因错** | 真因是 09-16 后无新的 eligible 课 → 序列平坦（5 天 `trueAbility` 逐字相同） |
| 指标官「weekPlan 伪造 rest 影响 7 天」 | ⚠️ **范围过大** | `09-13`/`09-14` 的 `planRevision = null`，rest 为合理默认；真冲突仅 3 天 |
| 产品官「恢复良好会诱导上强度」 | ⚠️ **降级，无证据** | 当日 `recoveryAdjustment = "none"`、`verdict = yellow`，系统没推强度。改以"同屏两个相反导向 + 相对化归一"表述（§3.4） |
| 产品官「数据停更 4 天」 | ⚠️ **措辞不准** | 睡眠/HRV/静息心率 `state = current`（09-20）。是"**无训练数据**"，不是"停更" |
| 产品官「这是数据看板不是教练」 | ⚠️ **价值判断，非事实** | `nextSession` **已返回** `easy / 12 km / 85 min` + 完整 `structure`（热身/主课/冷身 + 心率区间）。"今天这一课"数据层已有，缺的是展示 |
| 统计页两张截图 md5 相同 | ✅ 红队观察对，**但非缺陷** | 是我取证顺序造成的（截图时 App 已在统计页），非渲染问题 |

---

## 5. 门禁实跑结果（工程官实测，我未复跑）

| 门禁 | 命令 | 真实结果 | 耗时 |
|---|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ 通过 | 1m13s |
| iOS 门禁 | `npm run test:ios` | ✅ 通过（**确认真跑了 6m31s，未跳过**） | 6m31s |
| 单元/集成 | `npm test` | ✅ 737 项 / 725 pass / 0 fail / 12 skip；web 84 用例全过 | 4m39s |
| E2E | `npm run test:e2e` | **未跑**（`AGENTS.md` 禁止，未授权） | — |

审计报告点名的 flaky `server-runtime.test.ts:211` **本轮未复现**。工作树未被测试运行改动。

**另一项值得记的好消息**：2026-09-10 审计里那批"连续两轮未修"的 P1，**多数已解决**——Keychain 明文回退已移除（`apps/ios/RAI/Keychain.swift:12-27`）、`BGProcessingTask` 已从仓库消失（与 `AGENTS.md` 边界一致）、`verdict.stale` 已改为派生（`mobile-coach.ts:280`）。

---

## 6. 需要你先做决定的事（不是代码问题）

| # | 决策 | 选项 |
|---|---|---|
| D1 | 这台公网主机上的健康数据，是否接受匿名可读？ | (a) 单用户自用、接受公开 → 写进 README 明示；(b) 收回 → **必须先给 Web 加 Token 通道**，否则全站 401 |
| D2 | 云端容器是"唯一事实"还是迁回 systemd 模板？ | (a) 承认容器，回填 `deploy/CONTAINER.md`（base image / Node 版本 / 启动命令 / 挂载点）；(b) 迁回 `rai-api.service` |
| D3 | 课表真源是谁？`goals.weekPlan` 还是 `workout-plan`？ | 需先定位写入者（§3.2） |
| D4 | 备份失败的告警渠道 | 邮件 / 微信 / 仅日志 |

---

## 7. 明确**不建议动**的（避免过度优化）

- **本机 e2e 跑不动**（无 Chrome/Edge）——环境限制，非项目缺陷
- **`<1024px` 冻结区**——本轮零改动，`AGENTS.md` 明确保护，不要碰
- **恢复卡片不显示综合分**——`hrvSampleCount = 2`，两个样本出分反而不稳。问题在文案断言，不在"没分数"
- **训练列表默认只显示 5 条**——作为"最近训练"入口合理，缺的是可见延伸入口，不是内容
- **趋势页"浅色表示本周尚未结束""从旧到新"图例**——口径说明做得对，保留
- **"共 272 次"包含 trial/excluded**——用户关心"我一共跑了多少次"，这个口径合理，要补说明而非改统计对象
- **`var/` 与 `apps/ios/Pods` 的忽略**——已正确（`git ls-files var` = 0）
- **`apps/ios/design` 占 57 MB**——只影响 clone 体积，不急

---

## 8. 我没查的 / 查不动的

- **云端容器内部**：base image、Node 版本、启动命令、是否挂载数据卷——无访问权限
- **生产库内容**：真实行数、`schema_migrations` 版本、`var/backups/` 实际有几份、最新一份何时
- **真实数据上的恢复演练**：只读了恢复逻辑与单测（`apps/api/test/maintenance.test.ts` 覆盖较完整），**从未在真实数据上恢复过**
- **线上备份是否真在跑**：无法确认
- **`npm ci` 是否真会失败**：为避免删 `node_modules`，只做了文件比对
- **Rust 降级路径**：未触发（线上 `name: "rust"`，未降级）；`fallbackReason` 是否到达界面未验证
- **真机行为**：HealthKit 同步、后台任务、高德坐标对拍
- **`/v1/workouts/:id/series` 等端点我只取了状态码与字节数，未拉取任何个人健康数据内容**

---

## 9. 证据文件

| 路径 | 内容 |
|---|---|
| `/tmp/rai-evidence/*.json` | 9 份云端真实接口响应（health / runtime-status / mobile-today / statistics / trends / goals / workout-plan / workouts-all(401) / dashboard） |
| `/tmp/rai-ui/01-今天.png` ~ `05-设置.png` | 模拟器逐页签实机截图 |
| `/tmp/rai-ui/00-current.png` | 取证起始帧 |
| `apps/api/src/server.ts:198-252` | 匿名读白名单定义与设计意图注释 |
| `deploy/README-CLOUD-2C2G.md:51`、`deploy/n100/README.md:167` | 项目自己的"不要公开健康数据"警告 |
