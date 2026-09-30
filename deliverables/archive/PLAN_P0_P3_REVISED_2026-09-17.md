# RAI P0–P3 方案（复核修正版）

> 日期：2026-09-17 ｜ 前置文档：`PRODUCT_OPTIMIZATION_MULTIAGENT_2026-09-17.md`、`PLAN_P0_P3_2026-09-17.md`
> 本文档取代上一版方案。所有事实标注：**[实测]** = 本次在真实库副本上复现；**[Read]** = 亲自读到源码行
> 复核方式：只读代码 + `/tmp/rai_ro.sqlite`（`sqlite3 .backup` 一致性快照，**未触碰原库**）

---

## 0. 一页结论

| 项 | 裁决 | 一句话理由 |
|---|---|---|
| **P-1 v22 迁移安全化** | ✅ **做**（升级为"三件套"） | 复核发现原方案改法**根本不会让进程退出**，且 `RestartPreventExitStatus` 单独不够 |
| **P1-A 今日一屏** | ✅ **做，但只做补 `recovery.score`** | 一行改动、数据已就位；**同批改措辞会静默改变课型决策** |
| **P3-B 跑姿降级** | ✅ 做（顺手改文案） | 空操作——Stability 从未用跑姿数据，无分可撤 |
| **P3-A 的"价值内核"** | ✅ 做（一行文案） | 全部价值是"让用户知道分区来自反推"，不需要 CS |
| **P0-2 计划对账** | ✅ **做** | 唯一"零录入"的真实缺口；纯读时派生，可回滚 |
| **P2-B 心率-配速解耦** | 🟡 **做最小形态，不做 GAP** | 实测 33/46 路线海拔极差 <20m ⇒ 坡度影响小，"不做 GAP"有数据支撑 |
| **P2-A RPE/sRPE** | ⏸ **推迟** | 实测 `service.ts:180` **每存一次 override 触发一次全量重算** |
| **P1-B 孤儿清算** | ⏸ **推迟** | 死表零伤害，删它要引 v23 迁移 ⇒ 投入产出为负 |
| **P0-1 分段归并** | ❌ **不做，转为文档记录** | 只影响 3 条/271（9.1 km）；原方案判据**全库零命中**；无低风险中间态 |
| **P3-A 的 CS 校准器** | ⏸ **推迟** | 只有 44 次 Watch 样本；价值内核已由文案交付 |

**一句话**：复核推翻了上一版方案里**两项的形态**（P-1 的改法、P0-1 的判据）与**四项的优先级**。真正值得立刻做的是 **P-1 三件套 + 三处一行改动 + P0-2**，全部不触及不可逆操作。

---

## 1. 复核结果：19 条断言 → 16 条成立、2 条硬错误、4 条新缺陷

### 1.1 两条硬错误（都落在 P0-1）

| # | 原方案写的 | 实测 | 后果 |
|---|---|---|---|
| **E1** | 分段判据 =「A 段结束 ≈ B 段开始（**±120s**）」 | 2024-08-16 真实空档 **1661s（27.7 分钟）**；2024-08-30 空档 424s / 492s ⇒ **该规则全库零命中** | 按原判据，这组**永远不会被合并**。规则是凭想象写的，必须整条删除 |
| **E2** | 「2024-W33 从 **45.45 km → 41.07 km**」 | 实测 W33 canonical = **33.14 km**（且 canonical == all，该周无多成员组）⇒ 合并后应为 **24.04 km** | 两个数字都错，验收无法执行 |

**E1 的正确形态**（若将来要做）：不是"接续"，是「**子段包络吻合**」——存在第三条完整记录 C，子段集合落在 C 的时间包络内、**子段起点对齐 C 起点**（实测差 1 秒）、**子段量之和 ≈ C 的量**（时长 3479 vs 3245 差 6.7%；距离 9.0985 vs 9.0344 差 0.7%）。

### 1.2 四条新缺陷 / 新风险

| # | 缺陷 | 证据 | 影响 |
|---|---|---|---|
| **R1** | 🔴 **原方案的"退出码 78"根本不会退出** | `app.listen` 在 **`server.ts:1535`**，远在 `:350-356` 的 catch **之后**；`process.exitCode = 78` 只是设值，**Fastify 监听句柄让事件循环永不空闲** ⇒ 进程照常起来 | 原方案 §1.3 第 5 条必须改法：用 `process.exit(78)` 或把异常抛到顶层 |
| **R2** | 🔴 **`RestartPreventExitStatus` 单独不够** | `deploy/rai-api.service` 有 `Restart=on-failure` + `RestartSec=5`，**无** `TimeoutStopSec`/`RestartPreventExitStatus`/`StartLimit*` | 需同批加 `StartLimitIntervalSec=300` + `StartLimitBurst=3`（真正防循环的是 StartLimit；OOM/signal 类退出不受 ExitStatus 约束） |
| **R3** | 🟡 **`migrate()` 非整体原子** | `database.ts:1759-1773` 每个迁移各自 `BEGIN IMMEDIATE`/`COMMIT` | 原方案"单事务回滚"只对**单个**迁移成立，措辞需改 |
| **R4** | 🟡 **`migrate()` 首行即写库** | `ensureMigrationTable()`（`:1683-1694`）会 `CREATE TABLE` | "refuse 时不写库"必须**在它之前**用只读 `sqlite_master` 探测，否则违约 |

> ✅ **附带实测（原方案未验证、但恰好成立）**：`npm run start` 是两层 workspace 嵌套调用，**能原样透传子进程退出码**（实测退出码 78 传出）⇒ `RestartPreventExitStatus=78` 机制可用。

### 1.3 一个需要纠正的现网认知

原方案说"此后每一个写请求都会经 `openMainDatabase` 重跑一遍 44s 迁移再失败"。**成立，但要补三句**：

- `databaseIsReady()`（`server.ts:361-389`）在 recovery 时返回 false，**但只有 2 个 GET 端点据此拦阻**（`:1087`、`:1100`）
- **9 个写端点**走 `openMainDatabase()`（`:502/800/1033/1134/1177/1207/1252/1269/1300`）⇒ 确实重跑
- 🔴 **最危险的形态不是"循环"，是"不循环"**：异常被 `:350-356` 吞掉 ⇒ **进程以正常退出路径继续运行到 `:1535` 开始监听** ⇒ `systemctl status` 显示 **active**，用户会判定"部署成功"，实际只读端点报 `recovery_required`、写端点每次等一次迁移尝试

⇒ **验收必须新增一条**："启动后 `databaseReadyAtStartup === true`"，不能只验"进程在跑"。

---

## 2. 三派讨论：交集与分歧

三个独立立场（数据正确性派 / 实施风险官 / 减法裁判）基于**同一份复核后的事实底稿**对抗，结果：

### 交集（三派一致）

| 结论 | 说明 |
|---|---|
| **P-1 必做，且要加强** | 全票。且风险官指出"ExitStatus 单独不够"、减法裁判称它是"全清单唯一净收益、零新增面的改动" |
| **P0-1 不自动合并** | 全票。数据正确性派**自己**给出"不值得"的结论（n=1 支撑不了通用规则） |
| **拍定阈值不得当验收标准** | 减法裁判立论：`0.7`、`±120s`、`3%`、`>8%/<4%` 只能当参数，且必须能观测分布 |

### 分歧

| 项 | 数据正确性派 | 实施风险官 | 减法裁判 | 我的裁决 |
|---|---|---|---|---|
| P0-1 | 做候选清单，搭到下次重算窗口 | 暂缓，只出诊断 | 砍 | **不做，转文档记录**（见 §3.9） |
| P2-A | 未表态 | 会与 P0-1 重算撞车 | 砍 | **推迟**（理由比"砍"更硬，见 §3.7） |
| P3-A | 未表态 | 留只读诊断 | 推迟 | **推迟 CS，但交付文案内核**（见 §3.6） |
| P2-B | 未表态 | 留只读诊断 | 条件做最小形态 | **做最小形态**（见 §3.5） |
| P1-B | 未表态 | 紧跟 P-1，但先 RENAME | 推迟 | **推迟**（见 §3.8） |

### 三派都没抓到的三点（我补的）

1. 🔴 **`service.ts:180` 是"每次保存都触发全量重算"**，不是"可能与 P0-1 撞车"——`appendWorkoutOverride` **无条件**调 `enqueueFullRecompute()`（且在 COMMIT 之前）。这让 P2-A 从"录入麻烦"升级为"**每录一次主观感受就等一次全量重算**"。
2. 🔴 **P0-1 没有低风险中间态**：`:312-318` 的全量重建会 `DELETE FROM workout_group_members` + 重置 `is_canonical` ⇒ **手工改的归属会在下次全量导入时被覆盖**。只有"改算法 + 全量重算"或"完全不动"两条路。
3. 🔴 **P3-A 的价值可以用一行文案零成本交付**：它的全部价值是"让用户知道分区来自反推 VDOT 而非实测"，而这个事实**不需要 CS 就能展示**。CS 只是"自动化这个怀疑"。

---

## 3. 逐项裁决与改动方案

### 3.1 P-1：v22 迁移安全化（升级为"三件套"）✅ 做

**为什么升级**：原方案只做"refuse + 退出码 78"，但实测 R1 说明**这条改法不会退出**，R2 说明**ExitStatus 单独不够**。

| # | 文件:行号 | 改法 |
|---|---|---|
| 1 | `packages/storage-sqlite/src/database.ts:24-32` | `RaiDatabaseOpenOptions` 增 `migrationPolicy?: "apply" \| "refuse"`（默认 `"apply"`）；新增 `export class PendingMigrationsError extends Error`（携带 `versions[]`/`names[]` + 中文处置命令） |
| 2 | `database.ts:1719-1722` | `migrate()` 增第三参 `policy`；`open()`（`:1649-1662`）透传 |
| 3 | 🔴 `database.ts` 新增私有 `listPendingMigrationsReadonly()` | **必须在 `new RaiDatabase(path)` 之前**用**独立只读连接**（`new DatabaseSync(path, { readOnly: true })`）探测——**不能只在 `ensureMigrationTable()` 之前**：构造函数（`:1635-1647`）已执行 `PRAGMA journal_mode = WAL`，实测在非 WAL 库上**会改写模式 ⇒ 改主库头**（而只读连接实测不改任何字节）。探测：`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`；表不存在 ⇒ 全部 pending。`policy==="refuse"` 且 pending 非空 ⇒ **立即 throw（此时才是真零写库）** |
| 4 | 🔴 `apps/api/src/server.ts:350-356` | catch 分支按错误类型分流：`PendingMigrationsError` ⇒ `app.log.fatal(...)` 打印版本号与处置命令 + **`process.exit(78)`**（**不是 `process.exitCode`**，见 R1）⇒ 其它错误保持现有行为不变 |
| 5 | `apps/api/src/server.ts:338` + `:405-407` | 两处均传 `migrationPolicy: "refuse"` |
| 6 | `database.ts:1755-1757` | `createBackup` 前加磁盘预检（可用 ≥ 主库×1.1 + 256 MiB）；`migrate` 内注释修正"**逐迁移事务**"（R3） |
| 7 | 🔴 `deploy/rai-api.service` | **三行**：`RestartPreventExitStatus=78`、**`StartLimitIntervalSec=300`**、**`StartLimitBurst=3`**（R2）。首次部署期可临时 `Restart=no` |
| 8 | 新增 `packages/storage-sqlite/src/migrate-cli.ts` + `package.json` 加 `"data:migrate"` | `--database`、`--apply`（默认 dry-run）；流程 = 取 publication lock → 磁盘预检 → `open(apply)` → 打印前后 `MAX(version)`/行数/耗时 → `PRAGMA foreign_key_check` |
| 9 | `packages/storage-sqlite/src/index.ts:14-20` | 导出 `PendingMigrationsError` |
| 10 | `apps/api/src/worker.ts`、`recompute-thread.ts` | 同样传 `refuse`（纵深防御：worker 永不迁移） |

**验收（修正版）**

| 判据 | 期望 |
|---|---|
| pending 不执行 | 造 v22 未应用的库 ⇒ 启动 API **≤5s 退出码 78**，日志含版本与命令 |
| 🔴 **零写库**（**分场景**，真实检查后修正） | ① **refuse + pending 路径** ⇒ 断言**主库文件 md5 不变**且无新增 `-wal`/`-shm`（实测：无写入时 md5 完全相同 `57fada8c…`，这是**最强判据**）。② **apply 路径** ⇒ 用**逻辑指纹**（`schema_migrations` 全量有序 sha256 + `workouts`/`route_points`/`health_records` 行数与整表 sha256 + `integrity_check`）——真迁移必然改哈希（实测迁移后 `57fada8c…`→`11135274…`），哈希无从反映"是否被意外改动" |
| 🔴 **启动真实性** | 库 current 时启动 ⇒ **`databaseReadyAtStartup === true`** 且 `/v1/health` 返回 `"ok"`（**不是 `recovery_required`**）—— 防住 R1 描述的"active 但半挂" |
| 显式迁移可观测 | `--apply` 打印前后 `MAX(version)` + 行数 + 耗时；结束 `foreign_key_check` 为空 |
| 幂等 | 二次执行输出 `already current`；耗时 **< 3 s**（🔴 **实测修正**：324 MB 库即使零 pending，`open` 仍耗 **1306 ms**——对全部已应用迁移做 `sha256(up.toString())` 校验 + `prepareStatements`。原写"<1s"不成立） |
| 测试 | 新增 `packages/storage-sqlite/test/migration-policy.test.ts`（refuse+pending 抛错且**逻辑指纹不变** / refuse+current 可开 / apply 不回归）；`apps/api/test/` 加 spawn 用例：pending 库 ⇒ ≤5s 退 78 |

**回滚**：`git revert`（默认 `apply`，旧库/旧 CLI 不受影响）；service 文件改动单独 revert。数据回滚 = 停服 → 用 `var/backups/rai.before-v22.<ts>.sqlite` 覆盖（**同时删 `-wal`/`-shm`**）→ 启动。

**上线序列**（新增第 0 步，因 R3 需确认库内版本低于代码）：
```bash
# 0) 只读确认线上 v22 是否已应用 + 备份落点实况
sudo -u rai node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/var/lib/rai/var/rai.sqlite",{readOnly:true});
console.log(d.prepare("SELECT MAX(version) v FROM schema_migrations").get(), d.prepare("SELECT COUNT(*) n FROM health_records").get());'
ls -la /var/lib/rai/var/backups/ 2>/dev/null || ls -la /var/lib/rai/backups/ 2>/dev/null
# 1) 备份（API 在线时做）
curl -fsS -X POST http://127.0.0.1:8787/v1/backups -H "Authorization: Bearer $RAI_API_TOKEN"
# 2) 发布代码（此时 restart 会以 78 退出——属预期，不再盲跑 44s）
cd /opt/rai && sudo bash deploy/upgrade.sh --apply
# 3) 显式迁移
sudo -u rai npm run data:migrate -- --database /var/lib/rai/var/rai.sqlite --apply
# 4) 启动 + 验真实就绪
sudo systemctl start rai-api && curl -fsS http://127.0.0.1:8787/v1/health -H "Authorization: Bearer $RAI_API_TOKEN"
```
⚠️ **需线上确认**：① `MAX(version)` 与 `health_records` 行数；② `systemctl show rai-api -p TimeoutStopUSec` 实际值；③ 备份落点——**代码是 `/var/lib/rai/var/backups/`（`database.ts:1709` 的 `dirname(dbPath)/backups`），`README-UBUNTU.md:71` 写 `/var/lib/rai/backups/`（错），`:105` 写 `var/backups/`（对）⇒ 文档自身矛盾**。

---

### 3.2 P1-A：只补 `recovery.score`（不碰措辞）✅ 做

**为什么拆开**：`mobile-coach.ts:794` 的 `score: null` 是硬编码，而 `sleepRatio/hrvRatio/rhrDelta` 都已算出 ⇒ 补一个数是**零风险**。但 `:741` 有 `if (verdict.title.includes("恢复"))` —— **中文子串判断**，一旦改 `verdict.title` 措辞，green/yellow 会**静默走到错误课型**。这两件事风险差一个量级，必须拆。

| # | 文件 | 改法 |
|---|---|---|
| 1 | `apps/api/src/mobile-coach.ts:794` | `score: null` → 用既有 `sleepRatio/hrvRatio/rhrDelta` 合成 0-100，任一缺失则 null。**DTO 字段已存在，契约零变更** |
| 2 | — | **本批不动 `decideVerdict` 的 title 措辞**。措辞改造（原方案 §4.2 第 2/3/4 条）单独排期，且必须配套 `:741` 的负例测试 |

**验收**：睡眠/HRV/RHR 齐全时 `/v1/mobile/today` 的 `recovery.score` 非 null；缺失时仍 null。回归 `mobile-coach.test.ts`（`:109/110/126/145` 按 title/tone 断言；`:423/438/474/532` 按周计划断言）。门禁：`npm run typecheck && npm test && npm run build`。

⚠️ **一处必查**：`score` 从 null 变数值会让做**深比较**的用例失败——执行时逐一核对，不要"改测试迁就代码"。

**回滚**：单行 `git checkout --`，无数据面影响。

---

### 3.3 P3-B：跑姿文案 ✅ 做（顺手，不立项）

**实测确认是空操作**：`packages/features/src/index.ts:543-547` 的 `stabilityRaw = 1 − avg(speedCV, hrCV)` —— **只用速度 CV 与心率 CV，从未使用垂直振幅/触地时间**。⇒ 没有分可撤，**不触及评分口径、不必升 `MODEL_CONFIG_VERSION`、历史分数可比性不受影响**。

| # | 文件 | 改法 |
|---|---|---|
| 1 | `apps/web/src/pages/WorkoutDetailPage.tsx:263` | 跑姿指标分两组：「功率 / 步幅」与「垂直振幅 / 触地时间（**腕表估计，误差大，仅记录**）」。**不动 `:262` 的维度评分** |
| 2 | `WorkoutDetailPage.tsx:252` | 跑姿曲线**保留**（数据控需要），标题加「（腕表估计）」 |
| 3 | iOS 双皮肤 | `NativeViews.swift:1269-1270`、`TechViews.swift:1178-1179`、`TechTodayMetrics.swift:25` 同步文案 |

**验收**：跑姿四指标**不得**出现在 `packages/{features,scoring,training-zones,training-load}`；真实库 5,274 / 5,269 条样本**仍可见**（数据不删）。**回滚**：单文件 revert。

---

### 3.4 P3-A 的"价值内核"：一行文案 ✅ 做（CS 推迟）

**关键洞察**：P3-A 的全部价值是"让用户知道强度分区来自**成绩反推 VDOT**、不是实测阈值"。而这个事实**不需要 CS 就能展示**。

- **依据**：`recompute-pipeline.ts:1235` 调 `estimateLactateThresholdFromPerformanceVdot`（定义 `physiology/src/index.ts:803`），`:1244` 构造 `ThresholdPaceCandidate`（`training-zones/src/index.ts:37`，用于 `:53`）⇒ **分区确实来自成绩反推** [Read]
- **改法**：训练分区页（`TrainingZonesPage.tsx:63/101`）加一行说明：「本分区由近期成绩反推（VDOT 代理），**非实测阈值**」；若已有 `confidence`/`evidenceCount`（`training-zones/src/index.ts:268`）一并展示
- **成本**：一行文案。**零新表、零新端点、零重算**

⇒ **CS 校准器推迟的理由**：实测满足"轨迹跨度 ≥12 min 且有速度样本"的会话**只有 44 次，且全部来自 Apple Watch**（connect/huawei/coros 无轨迹）。它只是一个提示器，而提示的价值已由文案交付。

---

### 3.5 P2-B：心率-配速解耦（最小形态，**不做 GAP**）🟡 做

**实测支撑"不做 GAP"**：

| 实测 | 数值 |
|---|---|
| `route_points` 总数 / 有速度 / 有海拔 | 204,284 / **204,284（全部）** / 199,842 |
| 有速度样本的跑步会话 | **仅 46 次（全部 apple_watch）**；connect/huawei/coros **无轨迹** |
| 会话时长分布 | 平均 36.2 min；**≥12 min 的 43 次**；≥40 min 的 14 次 |
| 🔴 **海拔极差分布** | **<20 m：33 个**；20–50 m：12 个；**≥100 m：仅 1 个** |

⇒ **72% 的路线海拔极差 <20 m** ⇒ 坡度对解耦的影响极小 ⇒ 用新的未验证量（GAP）去修正唯一可信的新增项**不划算**（那会造出"第二个 P0-1"）。

**最小形态（合并三派要求）**

| 约束 | 内容 |
|---|---|
| 样本 | 只算 apple_watch；其它来源 `null` |
| 落库 | **不落库**、不进五维/EWMA/CatBoost、不加新端点 |
| 坡度 | `gradeAdjusted: false` 且 UI 显式标注；**爬升 >30 m 的课直接不出值**（用已有海拔算，比"标注"更安全） |
| 门槛 | `elapsedSeconds < 2400` ｜ HR 覆盖 <0.7 ｜ `speedTrack` 为 null ｜ 课型 ∈ {interval, race} 或速度 CV >0.15 ｜ 任一半无 HR 或 ΔHR <5 bpm |
| 算法 | 剔前 600s → 按时间对半 → 每半用 `meters/时间` 求配速、HR 按重叠时长加权 → `Δ=(P₂/HR₂)/(P₁/HR₁)−1` |
| 落点（**必须分层，否则编译不过**） | ① 纯函数放 `packages/features/src/index.ts`——✅ 已确认在 `tsconfig.pure.json` 白名单内，但该配置是 `"types": []` ⇒ **纯函数不能 import `storage-sqlite`，也不能用任何 node API**；② 采样在 API 读路径（`apps/api/src/data.ts`）调 `SqliteSeriesReadRepository.speedTrack`（**`packages/storage-sqlite/src/read/series-read-repository.ts:269`**，注意有 `read/` 子目录），把**纯数据**传给纯函数。该方法的既有质量门在 `:314`（`durationCoverage < 0.8 \|\| scale < 0.75 \|\| scale > 1.25 ⇒ null`），**不要另写采样** |

**验收（修正版）**：**逐 `trainingSessionId` 列出 Δ 与阈值对照 + 人工判读**，不要承诺"普遍出值"——46 次全为单设备、非独立同分布，只能证"Watch 子集未见 Δ 超阈"。门禁：`typecheck` + `test` + `build` + `test:e2e:web`。

**回滚**：删函数与 DTO 可选字段；iOS 宽容解码不崩。

---

### 3.6 P0-2：计划对账 ✅ 做

**全部断言复核成立**：
- `mobile-coach.ts:1051-1062` 过去日直接返回 `rest/planned:true`，且排在 `:1079` 的 `stored.get()` **之前** ⇒ 过去日永不查已存课表 [Read]
- `missed|adherence|completed_short` 全仓源码**零命中** [实测]
- `MobilePlanAudit`（`api-contracts:580-585`）= 生成溯源（generatedBy/model/promptVersion/generatedAt）⇒ **不是对账雏形，不复用** [Read]
- `mobile_goals_history` 仅 SELECT + INSERT，**无 DELETE** ⇒ 对账数据今天就能算，**不需要迁移** [Read]

**改动清单**：沿用上一版方案 §3.3 的 8 条（`api-contracts:665-675` 加 `status/plannedKind/plannedDistanceKm`；`:791` 后加 `planAdherence`；`mobile-coach.ts` 把 stored 查表上移到 `:1051` 之前并抽出 `classifyPlanDay`；`weekly-plan-prompt.ts:43-97` 加 `recentExecution`；`WEEKLY_PLAN_PROMPT_VERSION` → v2）。**0 新文件、0 新表、0 新端点。**

**判定规则**（`Asia/Shanghai` 本地日）：`missed` = 过去 + 有计划 + `kind !== rest` + 无训练 + **数据已覆盖该日**；未覆盖 ⇒ `pending`，**不计入分母**（宁可漏报，不可误报）。`adherence` 窗口 = **滚动 7 天**（不用自然周——`ensureWeeklyPlan` 恰在周一早上跑，自然周的过去日恒为 0）。

🔴 **文案同步（必须同批）**：`NativeViews.swift:1886` 现写"今天之前的日期由服务端置为休息"——改后会变成**事实错误**。

**验收**：造数（周一存 `interval 8km`、周二无记录、周三实跑 `easy 3km`）⇒ 周一 `status="missed"` 且 `kind="interval"`、周三 `completed_short`；未同步日为 `pending` 且不入分母；未来日与今日渲染**逐字节不变**。

**风险**：`0.7` 完成阈值是**拍的** ⇒ 首版只暴露 `completed_short` 计数，用真实分布校准后再启用判定。

---

### 3.7 P2-A：RPE/sRPE ⏸ 推迟（理由比"砍"更硬）

**复核成立的部分**：`rpe INTEGER CHECK (rpe BETWEEN 1 AND 10)` 在 `database.ts:423/707/1182` [Read]；iOS Swift 全仓无 `PATCH` [实测]；`workout_overrides` 真实库 **0 行** [实测]；`server.ts:797` 409 写忙保护存在 [Read]。

🔴 **推迟的硬理由**（实测，三派只有风险官接近）：
```ts
// packages/application/src/service.ts:180  （appendWorkoutOverride 内，且在 COMMIT 之前）
const jobId = this.enqueueFullRecompute();
```
**无条件**触发 ⇒ **用户每存一条 RPE 就付一次全量重算**。而 409 只挡并发写，**不挡重算叠加**。

⇒ 减法裁判说"砍"结果对，但理由应从"录入麻烦"换成"**每次录入触发全量重算**"。
⇒ **改判条件**：若能把 override 保存改为"仅标记受影响会话 + 增量重算"，本项目才值得做。

---

### 3.8 P1-B：孤儿清算 ⏸ 推迟

| 资产 | 复核 | 处置 |
|---|---|---|
| `GET /v1/import-sources/recent` | ✅ 真孤儿（仅测试调用：`apps/api/test/import-sources.test.ts:65/70/84/104`） | 推迟。接通收益是"复用上次导入来源"，而用户的导入是手动上传 export.xml ⇒ 省的是"重新选文件" |
| `GET /v1/openapi.json` | ✅ web 零消费 | 保留（零运行时成本，`schemas.test.ts` 依赖） |
| `import_batch_files` | ✅ 真死表（全仓仅 `database.ts:941` 一处 `CREATE TABLE`） | **推迟**。死表**零伤害**（不占 CPU/写入、不误导查询），删它需新增 v23 迁移 ⇒ **永久进入 checksum 体系**，投入产出为负 |
| `import_entity_generations` | ❌ 误判，**活表**（`database.ts` 命中 15 次） | 不可删。误删会造成增量导入**静默数据丢失** |

⇒ 若将来确要做，护栏：先 `RENAME TO _deprecated_<日期>` 观察一周期，再 DROP。

---

### 3.9 P0-1：分段归并 ❌ 不做，转文档记录

**影响面实测**：**1 组、3 条记录、9.0985 km**（占 271 条的 1.1%、1799 km 的 0.5%），且发生在 **2024-08-16**（两年前）⇒ 对当下训练决策**无影响**。

🔴 **新证据（我实测的，三派讨论时还没有）**：

| 证据 | 数值 | 含义 |
|---|---|---|
| 原方案"±120s 接续"规则命中数 | **0**（08-16 实际差 1661s；08-30 差 424s/492s） | 该规则是凭想象写的 |
| 全库「同日 ≥2 条跑步」 | **47 天**，其中 **≥3 条的 8 天** | 同日多课是**常态**，不是异常 |
| 2024-08-30 近失误 | 距离判据 4.192 vs 4.013 差 **4.5%**（阈值 5%）⇒ **只差 0.5 个百分点就误触发**；靠"时长 ±10%"（19%）挡住 | 任何自动合并规则都在走钢丝 |
| 2024-11-21 实际条数 | **4 条**（不是 3 条）；968/768/739/670 s，3.318/2.399/2.434/2.385 km | 形态像间歇分段，不是"被切三段" |
| 跨源去重健康度 | 2024-05-24（huawei+coros）、07-11、07-13（connect+watch）**都已正确合并**且起跑完全相同 | **120s 窗对跨源同跑是有效的**——失败的是"距离差 51%"，不是时间窗 |

🔴 **为什么没有中间态**：`canonicalize.ts:312-318` 全量重建会 `DELETE FROM workout_group_members` + 重置 `is_canonical` ⇒ **手工改的归属会在下次全量导入时被覆盖**。只有"改算法 + 全量重算"或"完全不动"两条路。而前者代价是**不可逆**（`workout_group.id` 由成员集合生成，`canonicalize.ts:359-362`）+ 全量 recompute + 单例阈值 + 47 天分布上走钢丝。

**⇒ 处置：不写代码。把该已知缺陷与其量化影响记录在案**（`docs/DATA_AUDIT.md` 加一节 + 项目备忘），让"W33 里程含 9.1 km 重复"这件事有据可查。

**改判门槛**（若将来数据量变化）：全量扫描显示**该类记录 ≥8 对且涉及里程 ≥2%**（当前 1 对 / 9.1 km / 0.5%，差一个数量级）。届时用「子段包络吻合」判据（§1.1），且**只进人工清单、不自动合并**。

⚠️ 遗留（需先解决）：`canonicalize.ts:239-243` 的增量脏集 `±120_000ms` 与 `:285` 主循环 `>120 break` 是**同一组魔法数**，任何窗口调整必须四处同步（`:81/:141/:242/:285`）。

---

## 4. 修正后的执行清单

### 第一批：可直接做（无迁移、无重算、不可逆风险为零或极低）

| 序 | 项 | 成本 | 可回滚方式 |
|---|---|---|---|
| 1 | **P-1 三件套**（代码 10 处 + service 3 行 + 新 CLI + 测试） | 中 | `git revert` + 恢复 service 文件 |
| 2 | **P1-A 补 `recovery.score`**（1 行） | 极低 | `git checkout --` |
| 3 | **P3-A 分区来源文案**（1 行） | 极低 | `git checkout --` |
| 4 | **P3-B 跑姿文案**（Web 2 处 + iOS 3 处） | 低 | `git checkout --` |
| 5 | **P0-2 计划对账**（0 新文件/表/端点，8 处改动） | 中 | 还原分类分支 + 契约字段 + 提示词版本回落 |

> **建议从 1 开始**：它是后续一切破坏性变更的前置护栏（原方案顺序正确，但**改法必须按 §3.1 修正**）。

### 第二批：需独立窗口

| 序 | 项 | 前置 |
|---|---|---|
| 6 | **P2-B 解耦**（最小形态） | 需先跑一遍 46 次会话的 Δ 分布，确认 43 次里有足够非 null 样本 |

### 不做 / 推迟

| 项 | 状态 | 重新评估条件 |
|---|---|---|
| P2-A RPE/sRPE | 推迟 | override 保存改为增量重算后 |
| P1-B 孤儿清算 | 推迟 | 仅当决定引入 v23 迁移时顺带做 |
| P3-A 的 CS 校准器 | 推迟 | 文案已交付价值内核；除非 Watch 样本量显著上升 |
| P0-1 分段归并 | 不做 | 该类记录 ≥8 对且涉里程 ≥2% |

### 与上一版方案的顺序对照

```
上一版：P-1 → P0-1 → P0-2 → P1-A → P1-B → P2-A → P2-B → P3-A → P3-B
修正版：P-1三件套 → （P1-A / P3-A文案 / P3-B / P0-2 并行） → P2-B
        砍掉：P0-1、P2-A、P1-B、P3-A的CS
```

理由：P0-1 是唯一会**不可逆改历史数据**的项，把它从"第二个做"改为"不做"；P2-A 因全量重算成本移出；其余低风险项**可并行**（互不碰同一文件）。

---

## 5. 需线上确认 / 需补实测

| # | 项 | 方式 |
|---|---|---|
| 1 | 线上 `MAX(version)` 与 `health_records` 行数 | SSH 只读 node 片段（§3.1 上线序列第 0 步） |
| 2 | `systemctl show rai-api -p TimeoutStopUSec` | SSH |
| 3 | 备份实际落点（`/var/lib/rai/var/backups/` vs `/var/lib/rai/backups/`） | SSH `ls` |
| 4 | ~~`POST /v1/database/restore`~~ 的实际语义（整库替换还是回填？是否停机？） | ✅ **已结案（2026-09-19，读码 + 只读线上核验）**。⚠️ **该路径不存在** —— 恢复入口是 `POST /v1/backups/:name/restore`（`server.ts:1513-1533`，实现在 `maintenance.restoreBackup`，`maintenance.ts:257`）。语义：**整库文件级替换**（staging 复制 → `validateRaiDatabaseIdentity` + `quick_check` + `foreign_key_check` → 当前库 move-aside 回滚文件 → 换入），**候选备份会被显式迁移到当前 schema**；**服务进程不停**，但替换窗口内数据库被关闭（route 传 `beforeReplace = () => recoverDatabaseJobs(true)`，之后 `invalidateDatabaseReadiness()` 并重排 workers）；替换前自动落一份 `before-restore` 安全备份（当前库不可读时改为 quarantine 保留原始字节）。请求体必须是 `{"confirmation":"恢复此备份"}`，有任务在跑时 409。线上核验方式：`GET /v1/health` = 200 + `databaseReady:true`，且**当前部署世代（`fda35e8` 及其后）的 `server.ts` 含该路由** |
| 5 | `packages/features` 是否在 `tsconfig.pure.json` 白名单 | ✅ **已确认在**（读配置） |
| 6 | `enqueueFullRecompute` 是否对同一时刻去重（决定 P2-A 改判可行性） | ✅ **已结案：完全不去重** —— `service.ts:62→212→recompute-job-repository.ts:20-29` 是**纯 INSERT**，无 `WHERE NOT EXISTS`/upsert/唯一索引；`claimNext():38-63` 逐条 FIFO ⇒ 连存 5 次 RPE = **串行跑 5 遍全量重算**。⇒ P2-A **维持推迟**，且若要解冻，**前置条件是先给存储层加去重/合并语义**（独立改动） |

---

## 6. 复核方法论沉淀（供后续同类评审复用）

1. 🔴 **分发给子智能体的"事实"必须先亲验**——上一轮的 3 条错误前提（"无 RPE 表""Stability 用跑姿""GAP 已存在"）全部错误并污染了三派推理。本轮底稿只写亲验项。
2. 🔴 **按"可逆性"分类，而非按"置信度声明"分类**——只读派生/可回滚（补字段、改返回、改展示）可直接做；触碰持久化、改 id 生成、不可逆（迁移、DROP、stableId 成员集）必须先在本机只读副本跑通 + 备回滚脚本。
3. 🔴 **"未验证"标注不能当作免责**——本轮两条硬错误都出在**标了 [亲验] 却算错**的地方（规则方向、验收数值），说明"读过代码"不等于"在真实数据上验过"。规则类断言必须在真库上跑命中数。
4. **拍定阈值（0.7 / ±120s / 3% / >8%/<4%）一律不得当验收标准**，只能当参数，且必须能观测分布。

---

*复核与起草：小满 🧭 ｜ 2026-09-17 ｜ 19 条断言逐条实测 + 3 派独立对抗 + 裁决层补 3 项*

---

## 7. 真实检查记录（第二轮，2026-09-17 晚）

完整报告：`deliverables/PLAN_P0_P3_RECHECK_2026-09-17.md`。本轮原则：**能跑的一律跑**（6 项可运行实测 + 30 余处行号核对，全程只读副本）。

### 推翻本文档上一版的 2 条结论（已就地修正）

| 上版写的 | 实测 | 已改位置 |
|---|---|---|
| 「库文件哈希不变是**假**断言（WAL 会改主库头）」 | ❌ **错**。实测 `RaiDatabase.open` 前后 md5 **完全相同**（`57fada8c…`），无 `-wal`/`-shm`。库已是 WAL 时 `PRAGMA journal_mode=WAL` 是 no-op + 无写入 ⇒ 哈希不变 | §3.1 验收表（改为**分场景**） |
| 「`speedTrack` 不存在」 | ❌ **错**，是我 grep 时**漏了 `read/` 子目录**。实际在 `packages/storage-sqlite/src/read/series-read-repository.ts:269`，质量门 `:314` 与本文档**逐字一致** | §3.5 落点 |

### 实测确认（上一版只是推断）

- 🔴 `process.exitCode = 78` 在 Fastify 监听下**确实不会退出**（4 秒后进程仍在运行）⇒ 必须 `process.exit(78)`，§3.1 第 4 条正确
- ✅ 完整启动链 **`npm run start` → `npm -w @rai/api` → `prestart`（check-node-version）→ `tsx src/server.ts`** 原样透传 **78** ⇒ `RestartPreventExitStatus=78` 可用

### 新增观察项（不改结论，但应记录）

| 项 | 实测值 | 含义 |
|---|---|---|
| **每次 `open` 的固定成本** | **1306 ms**（324 MB 库、零 pending） | 9 个写端点每个请求都付一次 ⇒ 值得独立优化（缓存 checksum 校验结果 / 只校验 pending） |
| **v22 幂等重跑** | **7515 ms**（其中备份 324 MB 占大头） | 「44.3 s」仅指**首次**迁移（真改 160k 行 id），不可当通用预期 |
| 备份落点 | `dirname(dbPath)/backups` 实测真的生成 324 MB 文件 | 线上即 `/var/lib/rai/var/backups/` |
| `import_issues` 表 | 当前**空表**（连 `AMBIGUOUS_TRAINING_SESSION_MATCH` 也没有） | 该表**从未被写入过** ⇒ 若要用它做 REVIEW 清单，要确认写入路径真的存在 |
| 🔴 **重算排队不去重** | `service.ts:62→212→recompute-job-repository.ts:20-29` 为**纯 INSERT**（无 `WHERE NOT EXISTS`/upsert/唯一索引），`claimNext():38-63` 逐条 FIFO | §5 第 6 项**结案**：P2-A 是**确定性串行叠加**，非"疑似"。解冻前置 = 先改存储层去重/合并语义 |
| 构造函数副作用 | `PRAGMA journal_mode=WAL` 在 `delete` 模式的库上**确实改成 wal**（改文件头）；只读连接**不改任何字节** | ⇒ refuse 探测必须用**独立只读连接**（§3.1 第 3 条已改） |

### 本轮抓到的表述问题

- **§3.5 / §3.4 的分层**：`speedTrack` 要连库（`storage-sqlite`），纯函数在 `features`（`"types": []`，不能用 node API）⇒ 必须写成"**API 读路径取样本 → 传纯数据给纯函数**"，否则按字面实施会**编译不过**
- **§3.1 「幂等 <1s」**：实测 1306 ms ⇒ 已改为 **< 3 s**
