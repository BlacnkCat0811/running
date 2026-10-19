# iOS 健康同步：方案执行记录（2026-10-19）

- 日期：2026-10-19，Asia/Shanghai
- 输入方案：[IOS_SYNC_VERIFY_AND_PLAN_2026-10-19.md](IOS_SYNC_VERIFY_AND_PLAN_2026-10-19.md)
- 执行范围：P0（发版前置 + 生产部署 + 验收）、P1（已在 `33f79fe`）、P2 的 A3/A5/A6/A8 代码与回归
- 生产实例：`lhins-3gatdqed` / `101.33.202.40` / ap-guangzhou
- 执行通道：本机 SSH（`root@101.33.202.40`，key 认证）执行部署脚本；**迁移前停服、自动一致性备份**
- 一句话：**P0 已上线并逐条验收通过**；P2 的四条缺口已在本地 HEAD 实现并过门禁，**未随本次发版**；A2（分页）仍按方案单独排期。

---

## 1. P0 执行结果（已上线）

### 1.1 P0-2 部署

| 项 | 值 |
| --- | --- |
| 部署前线上 HEAD | `8efdb99`（2026-10-18 19:58:48） |
| 部署后线上 HEAD | **`33f79fe`**（服务端代码与 `d037fc7` 逐字相同；`33f79fe` 只含 iOS 改动） |
| 部署脚本 | `deploy/upgrade.sh --apply --migrate`（停服 → 迁移 → 重启 → 认证健康检查） |
| 迁移 | v45 → **v46**（`health_records.available_at`，纯加可空列） |
| 迁移输出 | `"status":"migrated"`、`"pending":[]`、`"foreignKeyCheck":"ok"`、`elapsedMs:36003` |
| 迁移前后行数 | workouts 289、health_records 534,807、route_points 246,142（**逐项相等，无重建/无回填**） |
| 自动迁移备份 | `/var/lib/rai/var/backups/rai.before-v46.2026-10-19T03-28-31-894Z.sqlite`（2.3 G） |
| 依赖 | `package-lock.json` 未变化 ⇒ 跳过 `npm ci`；无 Rust 重编 |
| 健康检查 | 认证 `GET /v1/health` = 200 且 `status=ok`、`databaseReady=true`；无令牌 = 401 |
| 停机窗口 | 停服 → 迁移（含备份 36 s）→ 重启，分钟级（无写入/同步进行中） |

**回滚锚点**：`git checkout 8efdb99` + `systemctl restart rai-api`。v46 加的可空列**保留**（旧代码不读它），**不写 down migration**；迁移前数据以备份文件为准。

### 1.2 P0-1 A7 覆盖跳过闸门（已在 `33f79fe`，随下次 iOS 构建生效）

`apps/ios/RAI/HealthKitRecordCursor.swift`：`SyncCoveragePolicy.allowsHistorySkip = false`；`historyFloor` 在生产路径恒返回 `nil`；`shouldRestartHistory` 要求非 nil 下界才重开历史段。打开条件（服务端返回连续段 + 段间留 overlap + "中间有洞"回归）写在常量注释里。**本次部署不启用覆盖跳过**：线上 `GET /v1/sync/coverage` 已存在，但客户端仍全量重放，只把覆盖信息用于优先级。

### 1.3 P0 验收断言（生产实测，2026-10-19 11:30 CST）

| # | 断言 | 实测 |
| --- | --- | --- |
| 1 | 读侧已解耦：列表 item 含 `analysisPublishStatus`，顶层结构变化 | **通过**：`GET /v1/workouts?limit=1` 200；item 含 `analysisPublishStatus`/`assessmentStatus`；顶层含 `currentFacts`/`publishedAnalysis` |
| 2 | 新合同在：`/freshness`、`/sync/coverage` 不再 404 | **通过**：两者均 200，返回真实数据（见下） |
| 3 | VO2Max 不再 `full:true` | **代码已确认**：线上 `dirty-range.ts` 对 `vo2Max` 只记 `reasons`、不再置 `full`；**运行期证据待下一次真实同步**（见 §5 真机验收） |
| 4 | 事故窗口可被新端点直接读出 | **通过**：`/freshness` 返回 `facts.committedAt=2026-10-18T12:29:38.755Z`、`facts.lastBatchAt=12:30:23.066Z`、`analysis.publishedAt=12:31:21.265Z`（即 102.51 s 的那三个时刻） |
| 5 | v46 到达时间语义可读 | **通过**：列存在；534,807 行全 `NULL`（历史行不回填，符合"事件时刻≠可得时刻"的迁移纪律） |
| 6 | 老 App 兼容 | **通过**：列表仍返回旧字段 `assessmentStatus`；新字段均为增量 |

`/sync/coverage` 实测片段：

```json
{"datasetEpoch":"default","types":[
  {"type":"HKQuantityTypeIdentifierHeartRate","knownFrom":"2024-06-06T00:50:00.000Z","knownUntil":"2026-10-18T12:29:12.000Z","sampleCount":111951},
  {"type":"HKQuantityTypeIdentifierRunningPower","knownFrom":"2024-06-28T11:23:00.000Z","knownUntil":"2026-10-14T13:27:58.000Z","sampleCount":26136}]}
```

**部署后未做**（按方案属于发布后真机验收）：触发一次新同步并确认最新批次的 `analysis_dirty_plan_json.full == false`、批容量从固定 4,500 变为按字节、端到端时间线。

---

## 2. P1 状态（已在 `33f79fe`，随下次 iOS 构建生效）

| 项 | 内容 | 证据 |
| --- | --- | --- |
| A1 本批新登记窗口本批生效 | `WorkoutBackfillScheduler.batchSnapshot(persisted:acceptedPageRegistrations:)`；记录段用"盘上 ∪ 本批已交付页"的窗口快照 | `HealthKitExport.swift` 记录段调用点；`RouteSyncStatePersistenceRegression` |
| A4 到期窗口进统一待办 | `PendingWork.hasDueWorkoutWindow` + `needsAnotherRound`；`WorkoutBackfillScheduler.hasDueWindow` | `HealthSyncBackgroundRecovery.swift`、`BackgroundSyncPolicyRegression` |
| A4 防自旋 | `isExpired` 在 `due()` 选择前结算过期；被份额切断的窗口不会永远"还有活" | 同上，新增回归 |

这两条是"用户要不要点第二次同步"的端上缺口；**必须随 App 构建发版**才生效（服务端部署覆盖不到）。

---

## 3. P2 增量（代码完成，**未部署、未发版**）

四条都在本地工作区实现并通过门禁；按方案"服务端 + iOS 同批进退"，建议与下一版 App 同批上线。

### 3.1 A6 / P2-2：分析发布状态区分"旧分析可用"与"新分析未发布"

- 唯一判据 `analysisVisibility()` 在 `packages/storage-sqlite/src/read/workout-read-repository.ts`；列表 / 详情 / freshness 三处同源。
- 硬证明：active release 的 `analysis_run_input_bindings.captured_dependency_generation`；影响本训练的批次代次越过捕获点 ⇒ `pending`。
- 退化分支（必须留痕）：老 release 无绑定 / v39 前批次无代次 ⇒ 退回 `active_model_run.activated_at` 时间证明；`raw-only` 批次永不翻 pending。
- 任务证据：`queued|running ⇒ pending`、`failed ⇒ failed`（刻意不用只在发布事务写的 `analysis_job_coverage`）。
- 新字段 `analysisAvailable`：`pending + true` = 旧分析可读；详情仍 **200**，旧分数/分析块可读。
- 回归：`apps/api/test/workout-visibility-freshness.test.ts` 新增 A6 三条 + 退化 + raw-only + 三处一致性（含 HTTP 200）；突变：改回"有评估行即 published" ⇒ 2 条红。
- 已知边界：记录类变更按批次 MIN/MAX `effective_at` 区间归并 ⇒ 同窗口的其它训练可能被保守标 pending（方向安全）；老 ZIP 导入车道只能走时间证明。

### 3.2 A5 / P2-3：三态新鲜度（只加字段，`completeness` 语义未改）

- `GET /v1/workouts/:id/freshness` 新增 `deliveryState`（`delivered|partial|unknown`）/ `analysisState` / `stabilityState`，以及 `analysis.available`。
- **24h 静默只影响 stabilityState**（`stable` vs `settling`）；`completeness` 公式本轮刻意不动，下一版再改。
- `deliveryState` 是**到达证据**（服务端没有客户端读取回执）：`unknown` = 无批次账本，"不知道"不是"手表在传"；`partial` = 只有窗口记录账本；`delivered` = workout 实体已由成功批次交付。
- 契约：`packages/api-contracts`、`docs/IOS_NATIVE_API_CONTRACT.md`；iOS `APIModels.swift` 全部可选解码（老服务端省略 ⇒ nil，UI 行为不变）+ `TechPresentationRegression` 5 条解码回归。

### 3.3 A3 / P2-1：窗口收口改为逐类型进度

- `WorkoutBackfillWindow` 增加 `types: [String: TypeProgress]`（observed/delivered/stablePasses/pageComplete/lastObservedAt/previousObserved）；`afterPass` 接收逐类型观测。
- 收口 = **每个登记类型**都 `pageComplete && stablePasses>=1`（`stabilityToComplete=1`，第二次相同即稳定）；unseen 类型只能 7 天到期退出；`afterBlockedPass` 预算切断的趟不推进稳定计数；原因 `completed/expired/blocked/unauthorized/pending`。
- 分页未实现 ⇒ `observed == pageLimit` 视为可能截断（`pageComplete=false`），不假设 EOF。
- 持久化：`SyncTaskStore` schema 3→4，`types_json` 可空列；**老行/损坏/未知版本/被降级版本改过的行一律 fail-closed**（types unknown + 清 `completedAt` ⇒ 未完成、下轮重查）。
- 回归：`RouteSyncStatePersistenceRegression` 241 checks（必需 5 条 + 截断/授权/空窗阶梯/到期/v2→v4、v3→v4 真库迁移/降级对账）；结构门禁 §12j +8 条。
- 已知代价：登记类型 = 17 个 quantity 类型 ⇒ 多数窗口会 pending 到 7 天（A4 探针期间持续报"还有活"），补跑轮次比旧版多；A2 分页上线后应再收窄退场条件。

### 3.4 A8 / P3-4：observer 通知在 completion 前落耐久意图

- `HKObserverQuery` 回调改为 `intentChannel.recordThenComplete { completion() }`：先一次 `UserDefaults` set + 回读校验（O(1)、不抛错、不重试），再 `completion()`；`completion()` 仍恰好一次且严格早于任何 `Task`/`await`。
- 耐久失败/无目标/scope 非法三类都**仍然回执**，失败分类计数 + `[RAI]` 日志（不静默）。
- scope 同源：`performSync` / `restoreBackgroundContext` / `recordBackgroundIntent` / **启动注册**四处投影的都是同一次 `Self.urlScope(for:)` 计算。
- 本记录的集成补丁：在 `RaiStartup.registerSyncEntryPoints` **注册观察者之前**发布目标投影（`publishObserverTarget(for:)`），关掉"后台冷启动首次投递无目标可落"的残余窗口；只发布目标、不写意图（否则会凭空造一条待跑变化）。
- 回归：`BackgroundSyncPolicyRegression` 新增 3 条（顺序 / 写失败仍回执+分类计数 / scope 不误记），顺序证明点放在 `completion()` **内部**（用导出侧 `observe(scope:)` 读得到才算 durable）；结构门禁新增 3 条（冷启动投影先于注册 / `recordThenComplete` 接线 / `publishObserverTarget` 存在）。

### 3.5 未做：A2 / P2-4 分页（按方案单独排期）

本轮**未实现**分页。落地时按方案 §6 P2-4 执行：键 `(scope, workoutUUID, type)` 持久化 `pageToken`；谓词 `start >= lastStart`（含）+ `limit = pageLimit + margin`；本地按 `(startAt, uuid)` 排序并跳过已交付 UUID；同一 `startAt` 桶有界、跨批清空；整页全已交付 ⇒ `pageStalled` + 降频，不原地重试。**必须先做本地 schema 迁移 + 回滚路径**，并补"单类型 3,000 条两批收敛 / 同 startAt 两 UUID 跨页不漏"回归。

---

## 4. 验证记录（本轮，本机）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0（两个 tsconfig） |
| `RAI_TEST_CONCURRENCY=2 npm test` | 见 §4.1（本轮权威运行） |
| `npm run test:ios` | 见 §4.1（本轮权威运行） |
| `bash apps/ios/tests/typecheck-ios.sh` | exit 0：95 文件通过（3 个仅依赖高德 SDK 的文件按既有约定跳过） |
| `python3 apps/ios/tests/check-background-capabilities.py` | **310 checks / 0 failed**（floor 309） |
| `npm run check:docs` | exit 0（94 files / 648 local links / 2 anchors / 0 problems） |
| `npm run check:acceptance-matrix` | exit 0 |
| `npm run check:doc-refs` | exit 0（143 refs / 0 越界） |

### 4.1 权威套件结果

以本节数字为准（并发跑 `test:ios` 或编辑源码期间的运行一律不算证据）。

**全量 Node 套件**：`RAI_TEST_CONCURRENCY=2 npm test` → `tests 2150 / pass 2145 / fail 2 / skipped 3`，**exit 1**。两项失败均**不是本轮引入**：

1. `packages/health-export-parser/test/native-worker.test.ts:28` "Rust decoded data preserves TS stable IDs…" —— 已知的**旧 Rust 二进制**问题（`crates/` 在 10-16/17 改过、本机无 cargo；见 [README](README.md) 与 [plan-remove-web-keep-ios-api.md](plan-remove-web-keep-ios-api.md) 的基线记录）。单独重跑同一文件仍红（7 pass / 1 fail），与读侧改动无关（本批未改 parser/写侧）。
2. `packages/storage-sqlite/test/connection-contention.test.ts:22` "open() 只用了 198 ms…" —— 负载下的**时序抖动**；单独重跑通过（2/2）。按仓库既有纪律（重负载下 5 s/30 s 预算会假红）记录为环境性失败。

**iOS 门禁**：`npm run test:ios` → **exit 0**（独立串行、无并发编辑）。关键计数：类型检查 95 文件通过；`241 route state persistence`、`Background capability 310 / 0 failed`、`Technology presentation 253`、`106 store`、`85 HealthKit record cursor`、`112 HealthKit record sync wiring / 0 failed`、`Export determinism 14 / 0 failed`、`55 direct-sync status copy`、`21 contract parity`、`43 analysis reconcile`；末行"iOS 门禁通过（类型检查 + 纯逻辑回归）"。

---

## 5. 上线顺序与真机验收

1. **服务端**：A6/A5 是只加字段 + 状态派生，无迁移；建议与下一版 App 同批部署（`deploy/upgrade.sh --apply`，无 `--migrate`）。
2. **iOS**：下一构建包含 `33f79fe` 的 A7/A1/A4 + 本轮 A3/A8；A2 分页未含。
3. **真机验收**（发布后第一场跑步/同步）：
   - 服务端：最新 `import_batches.analysis_dirty_plan_json.full` 应为 `false`；
   - 批容量：`summary.xml.recordCount` 不再固定 4500，按字节收敛；
   - 时间线：`GET /v1/workouts/:id/freshness` 的 `facts.committedAt` 到 `analysis.publishedAt` 间隔应回到秒级；
   - App 内：一次同步后列表出现新训练（不必等分析发布），详情 200；
   - 覆盖跳过：确认客户端**没有**因 `/sync/coverage` 跳过历史（A7 闸门关）。

---

## 6. 未验证 / 仍未关闭

| 项 | 状态 |
| --- | --- |
| `full:false` 运行期证据 | 待下一次真实同步（本次部署只证明代码在线上） |
| 手机安装的 App 构建号 | 服务端不可见（方案 §9 已知未知） |
| HealthKit 类型"首次可读"时刻 / 482 条步幅为何晚 44 s | 只有设备侧能回答 |
| `route_evidence_unmerged` 发版后是否仍触发 | 待真机一轮 |
| A2 分页 / 95.9% 重复载荷去重 / 端到端四时刻埋点 | 未做（P2-4 / P3） |
| iOS 构建分发（TestFlight/App Store） | 需要用户 Apple 账号与签名环境，本环境不能代办 |

---

## 7. 本轮改动文件

- 服务端/契约：`packages/storage-sqlite/src/read/workout-read-repository.ts`、`apps/api/src/data.ts`、`packages/api-contracts/src/index.ts`、`apps/api/test/workout-visibility-freshness.test.ts`、`docs/IOS_NATIVE_API_CONTRACT.md`
- iOS：`apps/ios/RAI/{APIModels,HealthKitExport,HealthKitSync,HealthSyncBackgroundRecovery,RouteSyncState,SyncTaskStore,AppDelegate}.swift`
- iOS 回归：`apps/ios/tests/{BackgroundSyncPolicyRegression,RouteSyncStatePersistenceRegression,TechPresentationRegression}.swift`、`apps/ios/tests/check-background-capabilities.py`
- 生产：无仓库内改动（部署日志见 §1）
