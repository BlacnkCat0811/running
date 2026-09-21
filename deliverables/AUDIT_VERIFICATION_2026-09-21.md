# 外部审查文档逐条核实报告 · 2026-09-21

> **核实对象**：`PROJECT_COMPREHENSIVE_AUDIT_2026-09-21.md`（微信临时目录收到，非仓库内文档）
> **核实方式**：只读代码核验（Read / Grep），**未修改任何代码**；每条结论均落到 `文件:行号` 或实测数值
> **核实时点**：2026-09-21 10:44，工作区 HEAD = `41c2490`（有未提交改动，见 `git status`）

---

## 0. 结论先行

| 判定 | 条数 | 明细 |
| :--- | :--- | :--- |
| ✅ **真实存在**（证据链完整，可直接排期） | 8 | P1-1、P1-2、P1-3、P1-5、P2-2、P2-3、P3-1、P3-3 |
| 🟡 **存在但描述有偏差**（结论对，细节/行号/严重度不准） | 3 | P1-4、P2-1、P2-4 |
| ❌ **与现状不符**（已删除或从未如此） | 3 | P3-2、§2.3 的"① Shadow 全重放比对"、§2.1 的"18 次迁移账本" |
| ✅ 合规表 §3 七项 | 7/7 | 全部与现状一致（仅 1 处机制名写错） |

**四个必须知道的前提**：

1. 🔴 **该文档的行号全部对不上当前代码**（普遍漂移 5–90 行），路径根写的是 `d:/applerun/...`，而本工作区是 `/Users/ta/running/`。它核对的**不是当前这份快照**——按内容检索才能定位到实体。引用它时必须重新定位，不能照抄行号。
2. 🔴 **它把已删除的东西当成现存防线**：`§2.3` 的"双重门禁 ① 增量 Shadow 全重放哈希一致性比对"已于 2026-09-20 决策删除（`recompute-pipeline.ts:210-216` 有明确注释）。现在只剩模型版本闸门一条。
3. 🟡 **两条被它标为隐患的实际已被治理**：P3-2（`LIKE %id%` 全表扫描）当前实现**主动避开了 LIKE**；P2-1（轨迹 SVG 节点膨胀）实际被 SQL 侧降采样到 ≤500 点封顶，不存在"上万 DOM 节点"。
4. **P1 五条里有四条真实存在**，其中 P1-1/P1-2/P1-5 值得排期，P1-3/P1-4 是设计取舍+缺一个列，成本都不高。

---

## 1. P1 级逐条核实

### P1-1 恢复数据无增量机制，清空重算 + 每日两次全表扫描 — ✅ **真实存在**

| 项 | 证据 |
| :--- | :--- |
| 无条件清空两张表 | `packages/health-export-parser/src/canonicalize-nights.ts:152` — `DELETE FROM canonical_hrv_days; DELETE FROM canonical_nights;` |
| 唯一调用点、无增量分支 | `packages/health-export-parser/src/cli.ts:320` — `canonicalizeNights(store.database, "Asia/Shanghai")`，`import` 与 `incremental-import` 共用同一段代码，**没有** `dirty` 参数（对比同段 `:316-319` 的 `canonicalizeRunningWorkouts` 是**有** `dirtyWorkoutTimes` 增量的） |
| O(D×N) 第一次全扫 | `:161` — 每日 `all.filter((s) => s.end > windowStart && s.start < windowEnd)` |
| O(D×N) 第二次全扫 | `:199-206` — 同一日期内 `for (const raw of all)` 再扫一遍做午睡窗口 |

**补充事实（文档没写）**：`docs/SLEEP_HRV_DESIGN.md:217` 明确写了"接受浪费的 full recompute。`canonicalizeNights` 只挂 CLI"。这是**当时拍定的取舍**，不是疏漏——所以修它要先推翻那条设计结论，不是改个循环。

**改动方向**（供参考，本次未实施）：照抄 `canonicalizeRunningWorkouts` 的 `dirtyWorkoutTimes` 模式给夜表传脏日期集合；两次 `filter` 合并为按日索引的 Map。

---

### P1-2 `localDateTimeAt` 超高频构造 `Intl.DateTimeFormat` — ✅ **真实存在（且比文档说的更严重）**

| 项 | 证据 |
| :--- | :--- |
| 循环内每次 new | `packages/health-export-parser/src/utils.ts:54-56` — `for (let offset = -16 * 60; offset <= 16 * 60; offset += 15)`，循环体第一句就是 `new Intl.DateTimeFormat(...).formatToParts(...)` |
| 循环次数 | `(960 - (-960)) / 15 + 1 = 129` 次/调用。文档说"129 次"✅ |
| 另一处同类 | `utils.ts:43` — `localDateAt` 每次调用也 new 一个 formatter，而它在 `canonicalize-nights.ts:154` 被**每个 segment 调一次** |
| 每日调用次数 | `canonicalize-nights.ts:159`、`:160`、`:196`、`:197` — **每日 4 次**调 `localDateTimeAt` |

**文档数量级的偏差**：文档说"1,000 天触发近 40 万次实例分配"，按 1000 天 × 4 次/天 × 129 = **约 51.6 万次**，量级对、数值偏低。修法（formatter 提升为模块级缓存/纯数学偏移）在文档里给对了。

---

### P1-3 单 Worker 严格 FIFO 导致任务饥饿 — ✅ **真实存在（行号错）**

| 项 | 证据 |
| :--- | :--- |
| FIFO 排序 | `packages/storage-sqlite/src/recompute-job-repository.ts:48-53` — `ORDER BY created_at, rowid LIMIT 1`。**文档引的 `:35` 是 `get()` 里的 `return row ? this.map(row) : null`** |
| 表里确实没有优先级列 | `packages/storage-sqlite/src/database.ts:446-462` — `recompute_jobs` 列为 `id / job_type / status / dataset_version / feature_run_id / model_run_id / request_json / progress_* / cancel_requested / error_json / created_at / started_at / completed_at`，**无 `priority`** |
| 全仓无 priority 实现 | 跨 `packages/` 检索 `priority\|retry_count` 只命中一个测试名（`training-load.test.ts:235`） |
| 轻量任务确实存在且会被堵 | `packages/application/src/service.ts:77-79` — `enqueueSnapshotRefresh` 入的是同一张队列 |

---

### P1-4 毒药任务崩溃死循环 — 🟡 **成立，但文档措辞不准确**

| 判定项 | 实际 |
| :--- | :--- |
| 位置 | `recompute-job-repository.ts:105-162` 的 `recoverInterrupted()`。**文档引的 `:77` 是 `requestCancellation()` 的 `if (!job)` 判空分支** |
| 无重试上限 | ✅ 成立：无 `retry_count` 列（同 P1-3 证据），失败/中断后 `running → queued`（`:137`）重新排队 |
| ❌ "无条件重置为 queued" | **不准确**。`:129`、`:137`、`:142-143` 有分支：`cancel_requested === 1` 时走 `cancelled` 并写 `error_json`，只有未请求取消的才回 `queued` |
| 附带行为 | `:128` 恢复时会先把关联 `feature_runs` / `model_runs` 置 `failed` |
| 并发保护 | `:144-146` 若 UPDATE 影响行数 ≠1 直接抛错（防止恢复期间状态被改） |

结论：**"缺重试上限"这个真问题是存在的**，但把它描述成"无条件重置"会误导修复方向。加 `retry_count` + 上限 3 次即可闭环。

---

### P1-5 多库备份/恢复不一致（控制库悬挂） — ✅ **真实存在（项目自己已承认）**

| 项 | 证据 |
| :--- | :--- |
| 备份只针对主库 | `apps/api/src/server.ts:442-451` — `new DatabaseMaintenance(databasePath, runtimeRoot, ...)`，只传主库路径 |
| 控制库是独立文件 | `server.ts:99` — `controlDatabasePath = RAI_CONTROL_DATABASE ?? runtimeRoot/var/rai-control.sqlite`；由 `MobileGoalsStore` 独占（`server.ts:383`、`apps/api/src/mobile-goals.ts:175`） |
| `maintenance.ts` 全文无控制库 | 检索 `control` 零命中；`restoreDatabaseGroup()`（`:467`）处理的是 `-wal` / `-shm` **sidecar**，不是第二数据库 |
| **项目文档已自认未完成** | `docs/IOS_CLOUD_REVIEW_PLAN_2026-09-07.md:5` — "控制库尚未纳入业务库的完整备份 bundle，因此'多库恢复一致性'仍是未完成项" |
| 部署侧也只是人工提醒 | `deploy/n100/README.md:172` — "完整恢复还需 runtime.sqlite、rai-control.sqlite、模型 artifacts…"，属操作手册，不是代码保证 |

🔴 注意后果与文档一致：还原历史备份后，控制库里锁定的 Session 可能指向主库不存在的记录（`mobile_goals` / `mobile_goals_history`，见 `docs/DATABASE_DESIGN.md:18`）。

---

## 2. P2 级逐条核实

### P2-1 轨迹 SVG 节点膨胀 — 🟡 **存在，但严重度被夸大**

| 项 | 证据 |
| :--- | :--- |
| 逐段渲染 `<line>` | ✅ `apps/web/src/components/RoutePlot.tsx:110-112` |
| 🔴 **但 API 侧已降采样封顶** | `packages/storage-sqlite/src/read/series-read-repository.ts:107-123` — CTE 里 `(sample_number - 1) % MAX(1, (total_samples + 499) / 500) = 0`，**最多返回 ~500 个点** |
| 调用链 | `apps/api/src/data.ts:935` — 详情接口的 `route` 字段走的就是这个 `routePoints()` |

**结论**：全马路线到手不会超过约 500 点 → 最多约 499 个 `<line>` + 200 个公里标记，**不是"上万 DOM 节点"**。文档的"42km 全马上万点 → 卡顿"证据链漏了降采样这一环，把问题放大了约 20 倍。抽稀/合并 `<path>` 仍是合理优化（P2 级），但不是文档暗示的那种线上风险。

### P2-2 构建体积逼近预算红线 — ✅ **真实存在（数值基本吻合）**

| 项 | 证据 |
| :--- | :--- |
| 预算定义 | `apps/web/scripts/check-bundle.mjs:6-12` — charts 450 KB / index 250 KB / css 100 KB（文档引 `:18` 是循环体，不是预算定义） |
| 实测产物（`apps/web/dist/assets/`，2026-09-19 构建） | `charts-CCsdzRcL.js` = **409,047 B = 399.5 KiB**，占 450 KiB 的 **88.7%**；`index-fydzDmV3.js` = 183,411 B；`styles-qFSt3VWe.css` = **81,014 B = 79.1 KiB**，占 100 KiB 的 **79.1%** |

文档写"409 KB / 90.9%"与"79.7 KB / 77.8%"——单位口径（KB vs KiB）不同导致小差异，**结论（charts 已用掉约九成预算、后续扩展易触发构建失败）成立**。注意 dist 是两天前的产物，需重跑 `npm run build` 才能拿到当期数值。

### P2-3 GPX 无条件全盘哈希 — ✅ **真实存在（行号错）**

| 项 | 证据 |
| :--- | :--- |
| 先哈希、后比对 | `packages/health-export-parser/src/gpx-parser.ts:285` — `const currentSha256 = await hashFile(fullPath);` 在**缓存比对之前**无条件执行 |
| 缓存命中判定在之后 | `:286-301` — 拿到 `currentSha256` 才比对 `sha256 / routeId / fileStatus / pointCount` 决定 `continue` |
| `size_bytes` / `modified_at_ms` 白拿了 | `:267-280` SELECT 出来了，**但没参与"要不要读盘算哈希"的判定**，只用于写回（`:313-321`） |

修法（先比 `size_bytes` + `modified_at_ms`，只有元数据不匹配才读文件体）与文档一致。文档引的 `:235-257` 是函数开头的变量声明区，不是证据点。

### P2-4 长距离后程心率漂移误惩罚 — 🟡 **成立，但行号指向完全无关的代码**

| 项 | 证据 |
| :--- | :--- |
| 效率用全段平均 | `packages/features/src/index.ts:557-558` — `efficiencyRaw: speed !== null && averageHeartRate !== null ? speed / averageHeartRate : null`，`averageHeartRate` 是整个 workout 的平均值 |
| 无任何漂移补偿 | 在 `packages/features/src` 内检索 `drift`（不分大小写）**零命中** |
| ❌ 文档引的行 | `:530-534` 是 `qualityScore = 0.55*coverage + 0.25*sourceConfidence + 0.2*eligibility`，**与心率漂移毫无关系** |

**结论**：生理学判断（稳态长跑后半段 HR 自然上浮 → 全段平均效率被低估）在当前代码成立，方向可用；文档给的行号是错的，别照着去改。

---

## 3. P3 级逐条核实

### P3-1 时区默认硬编码 `Asia/Shanghai` — ✅ **真实存在（行号错）**

硬编码/默认值分布（文档只引了 1 处且引错）：

| 位置 | 形态 |
| :--- | :--- |
| `packages/training-load/src/index.ts:326` | `localDateInTimeZone(instant, timeZone = "Asia/Shanghai")`。**文档引的 `:320` 是 ACWR 的 minimumHistoryDays 门限判断** |
| `packages/health-export-parser/src/canonicalize-nights.ts:148` | 默认参数 |
| `apps/api/src/server.ts:632` | `timeZone: "Asia/Shanghai"` 写死在 `localToday` 一带 |
| `apps/api/src/mobile-read.ts:628`、`apps/api/src/data.ts:85` | 移动端锚点 |
| `apps/web/src/format.ts:55`、`:64`、`apps/web/src/ios/shared.tsx:55` | 前端展示 |

🔴 **关键补充**：全仓检索 `RAI_TIMEZONE` **零命中**（只在 `deliverables/gstack/*` 的旧设计文档里被提议过）。也就是说即使把 `RAI_CONTROL_DATABASE` 这类 env 都配好了，**时区没有任何环境出口**，这条不是"默认值可覆盖"，而是**真硬编码**。要改需先定"单一 App 时区入口"，涉及解析/服务/展示三层的传递。

### P3-2 `removeWorkoutsBySyncIdentifiers` 用 `LIKE %id%` 全表扫描 — ❌ **与现状不符（已治理/描述错误）**

| 项 | 证据 |
| :--- | :--- |
| 真实位置 | `packages/storage-sqlite/src/database.ts:2637` 起。**文档引的 `:2068` 是 `insertEventStatement.run(...)` 里的 `event.date` 参数行** |
| 实现方式 | `:2642-2658` — 注释原文：**"Match the parsed metadata values exactly. LIKE is unsafe here: a sync identifier containing '%' or '_' would become a wildcard, and a substring match could delete a different workout."** 随后用 `json_valid` + `json_each` 精确展开元数据数组 |
| 全文 LIKE 残留 | 只有 3 处，**全部在注释里**（`:2438`、`:2642`、`:2708`），无一处是 SQL |

**判定**：当前实现**刻意规避**了 LIKE，且注释解释了为什么必须规避（通配符注入 + 子串误删）。文档此条要么基于更早的版本，要么是凭印象写的。**不建议按此条排期**——按它去"优化 LIKE"会改到一段本来就正确的代码。

### P3-3 `WorkoutTable` 双 DOM 树挂载 — ✅ **真实存在**

`apps/web/src/components/WorkoutTable.tsx:13-30` 桌面 `<table>` 与 `:31-39` `.workout-mobile-list` **同一次渲染里同时挂载**，靠 CSS 二选一隐藏。

🔴 **动手前的闸门**：`.workout-mobile-list` 属 `AGENTS.md` 明列的**冻结区**（"Do not modify `.mobile-nav-links` and `.workout-mobile-list` behavior"）。改成条件渲染必须先拿你的显式授权，否则违反仓库规约。

---

## 4. §2 架构描述性断言的抽查

只抽查了会误导后续决策的三处，其余描述性内容（分层图、算法说明）未逐行核验。

| 断言 | 核实 | 证据 |
| :--- | :--- | :--- |
| §2.1 "主业务库…**18 次迁移账本**"、§6 "v1~v18" | ❌ **过期** | 迁移链当前为 **v1–v22**（v11 为占位无 SQL），末条 `database.ts:1397` `version: 22 / realign_health_record_stable_ids_and_remove_duplicates` |
| §2.3 "双重模型门禁 ① 增量 Shadow 全重放哈希一致性比对" | ❌ **该机制已被删除** | `packages/application/src/services/recompute-pipeline.ts:210-216` 注释："the shadow full-replay comparison was removed by decision (deliverables/SHADOW_REMOVAL_RUNTIME_INVARIANTS_2026-09-20.md)" |
| §2.3 "②`rai-shadow-gate-v1` 硬门禁 8 项指标" | ✅ **准确** | 调用点 `recompute-pipeline.ts:217-222`（incumbent 存在时强制，失败即抛错阻断激活）；实现 `model-run-repository.ts:139-243`；失败判据恰好 **8 条**（`:235-242`）：`recovery_null_rate_delta` / `eligible_session_delta` / `current_ability_mean_absolute_delta` / `current_ability_p95_absolute_delta` / `final_true_ability_delta` / `assessment_status_change_rate` / `recovery_saturation_rate` / `invalid_values`。阈值 0.1 / 0.05 / 8 / 15 / 10 / 0.1 / 0.2 / >0，与文档所述一致 |
| §2.2 "CA…心肺（Cardio）权重显式设为 0" | ✅ 准确 | `packages/scoring/src/model.ts:32-38`，注释 "The observed Cardio proxy is duration multiplied by speed, which is chiefly distance" + `cardio: 0` |
| §2.2 "增长阻力 R = clamp(((100-TA)/50)^1.5, 0.15, 1)" | ✅ 逐字准确 | `packages/scoring/src/index.ts:87-89` |
| §2.2 "残差钳制 ±12" | ✅ 准确 | `packages/scoring/src/index.ts:95` — `clamp(input.currentAbility - input.trueAbility, -12, 12)` |
| §2.1 "硬链接排他发布锁 linkSync" | ⚪ 未逐行核验 | `packages/storage-sqlite/src/publication-lock.ts` 存在，本次未验证 `linkSync` 细节 |

---

## 5. §3 `AGENTS.md` 合规表核实 — **7/7 与现状一致**，1 处机制名写错

| 约束项 | 核实结果 | 证据 |
| :--- | :--- | :--- |
| 主视口 1440×900 / 最小 1024px | ✅ 一致 | `apps/web/e2e/web-flows.test.ts` 多处 `viewport: { width: 1440, height: 900 }`，另有独立 1024px 用例（`:506-508`） |
| 冻结 <1024px 媒体查询 | ✅ 一致 | `apps/web/src/styles.css` 实况：`:822 min-width:1024`、`:1046 prefers-reduced-motion`、`:1050 max-width:1180`、`:1073 max-width:820`、`:1228 max-width:480` — 与 `AGENTS.md` 断点说明完全对应 |
| 冻结 `mobileNavigation` | ✅ 一致（行号差 1） | `apps/web/src/App.tsx:102`（文档写 101-107），`:181` 处 `className="mobile-nav-links"` |
| 冻结 `.mobile-nav-links` / `.workout-mobile-list` | ✅ 一致 | 见 P3-3 |
| 390px E2E 仅显式请求时运行 | ✅ 一致 | `web-flows.test.ts:19-21` — `responsiveTest` 在 `npm_lifecycle_event === "test:e2e:web"` 时 `skip`；390px 用例在 `:1114-1116` |
| 禁止设备端重写评分 | ✅ 一致 | `apps/ios` 内检索 `vdot\|trimp\|currentAbility\|trueAbility`，全部命中在 `APIModels.swift`（DTO 解码）与 `Skins/**`（展示格式化），**无任何本地评分计算** |
| 禁止 HealthKit 回写 | ✅ 一致 | `apps/ios/RAI/HealthKitExport.swift:187`、`:195`、`:208` — `toShare: []`（三处请求/查询授权都是空写权限） |
| 禁止假后台推送 | ⚠️ **结论对，机制名错** | 全 `apps/ios` 检索 `BGTask / BGProcessingTask / BGAppRefresh / backgroundDelivery` **零命中**；实际用的是 `HealthKitSync.swift:142` 的 `UIApplication.shared.beginBackgroundTask(withName: "rai-health-sync")` |

§3 那条"仅使用标准 `BGProcessingTask`"是文档编造/记错的机制名。**合规结论不变**（`beginBackgroundTask` 是标准的前台任务续期 API，不是 HealthKit background delivery，不构成"假后台推送"），但文档在此处暴露了"描述细节未经代码核对"的特征——这与 P2-4、P3-2 的行号错位是同一个毛病。

---

## 6. 该文档的可信度画像（供后续引用时定权）

**可信的部分**：算法与阈值类断言非常准（ACWR 门限、8 项门禁判据与其数值、growthResistance 公式、残差 ±12、Cardio 权重归零、冻结区判定、`toShare: []`）——这些"读代码能读到常量"的地方它基本没错。

**不可信的部分**（同一份文档里）：
1. **所有行号**都指向另一份快照，普遍漂移 5–90 行；P2-4、P3-1、P3-2、P1-3 的引用行甚至落在**语义完全无关**的语句上。
2. **把已删除的机制写成现存防线**（Shadow 全重放比对，2026-09-20 已删）。
3. **把已治理的问题写成现存隐患**（P3-2 的 LIKE：当前代码专门写了注释说明为什么不用 LIKE）。
4. **漏掉缓解层导致严重度误判**（P2-1：漏了 SQL 侧 500 点降采样，把 ≤499 个 `<line>` 说成"上万 DOM 节点"）。
5. **机制名写错**（`BGProcessingTask` ↔ `beginBackgroundTask`）。

**结论**：这份文档可以当"**问题方向的候选清单**"用，不能当"**证据**"用。凡要据此动手的条目，必须先在当前工作区重新定位并复算——本次核实中有 3 条（P3-2、Shadow、迁移数）就是这么被否掉的。

---

## 7. 建议的处理排序（按"可逆性 + 收益"，非按文档的 P1/P2/P3）

| 优先级 | 条目 | 为什么这个顺序 | 改动性质 |
| :--- | :--- | :--- | :--- |
| 1 | **P1-2**（formatter 复用） | 纯函数内部优化，不改任何对外行为与数据；收益确定（数十万次→数百次分配） | 可逆，无需迁移 |
| 2 | **P2-3**（GPX 先比 mtime/size） | 同样纯内部，且能直接砍掉全量增量同步的磁盘 IO | 可逆 |
| 3 | **P1-1**（夜表增量化） | 收益最大但要先推翻 `SLEEP_HRV_DESIGN.md:217` 的既有结论；需补"脏日期 → 只重算受影响窗口"的等价性回归 | 需回归，慎动 |
| 4 | **P1-4 + P1-3**（`retry_count` + `priority`） | 都要动 `recompute_jobs` 表结构 → **新增迁移（v23）**，按项目铁律「不可改历史迁移的 up」，只能追加 | 需迁移 + 部署闸门 |
| 5 | **P1-5**（控制库并入备份 bunde） | 触及持久化与恢复语义，风险最高；且项目文档已把它列为未完成项，属"已知并接受" | 需迁移语义评审 |
| — | **P2-1 / P2-2 / P2-4 / P3-1 / P3-3** | 方向可用但严重度被夸大或缺前置条件（P3-3 还撞冻结区） | 建议降级排期 |

---

*核实过程只读：未创建、未修改、未删除任何源码或数据文件。本报告自身写入 `deliverables/`。*

---

## 🔴 勘误（2026-09-21 追加，经四智能体对抗审查 + 主智能体亲验后修正）

以 `IMPLEMENTATION_PLAN_2026-09-21.md` 为准。本报告中以下结论已被推翻或修正：

| 本报告原说法 | 修正后事实 |
| :--- | :--- |
| P1-2 "1,000 天 ≈ 51.6 万次"构造 | 探测循环对 Asia/Shanghai 实际执行 **97 次**（非 129）⇒ 本库 814 天场景为 **32.2 万次** |
| P3-1 "时区硬编码 9 处" / "唯一一处 SQL 硬编码偏移" | 实测生产代码 **46 处**；偏移类硬编码 **3 处**（`trends-read-repository.ts:106`、`mobile-read.ts:83`、`plan-execution.ts:19`），另有 SQL 字面量 `data.ts:296` 与契约层字面量类型 `api-contracts/src/index.ts:298` |
| P1-1 / P1-3 / P1-4 判定 | **维持**（已亲验） |
| P2-1 "≤499 个 `<line>`" | **维持**（读取侧 SQL 降采样 ≤500 点） |
| P3-2 "与现状不符" | **维持**（当前实现主动规避 LIKE） |
| §2.1 "18 次迁移账本" | **维持推翻**：实际 v1–v22；且迁移带 checksum（`database.ts:1622`），改历史迁移会被强制拒绝 |

🔴 **另暴露一个工具隐患**：代码检索工具对 pattern `timezone_identifier` 会**静默返回空**（同文件搜 `zone_identifier` 正常）。
因此本报告中所有"零命中"型结论（如 `drift` 无命中、`BGTask` 无命中、`RAI_TIMEZONE` 无命中）**均已用另一种写法交叉复核过**，结论不变。
