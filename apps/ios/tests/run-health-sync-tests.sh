#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# `-disable-sandbox` 与 `run-model-tests.sh` / `run-session-tests.sh` 保持一致。本编译单元
# 目前是纯 Foundation（`@Observable` 计数为 0），所以不带也能过；但那不是保证 —— 一旦引入
# `@Observable`，宏插件被 `sandbox-exec` 包住后会死在 "sandbox_apply: Operation not
# permitted"，随后满屏 "produced malformed response"，看起来像一屏源码错误其实不是。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/HealthSyncCancellation.swift \
  apps/ios/RAI/StoredZip.swift \
  apps/ios/tests/HealthSyncCancellationRegression.swift \
  -lz \
  -o "$tmp/health-sync-cancellation-tests"
"$tmp/health-sync-cancellation-tests"

# 与 App 一样启用 MainActor 默认隔离，防止纯逻辑编译掩盖大文件 helper 的执行边界错误。
xcrun swiftc -parse-as-library -disable-sandbox \
  -swift-version 5 -default-isolation MainActor \
  apps/ios/RAI/HealthSyncCancellation.swift \
  apps/ios/RAI/HealthSyncArchive.swift \
  apps/ios/tests/HealthSyncArchiveRegression.swift \
  -o "$tmp/health-sync-archive-tests"
"$tmp/health-sync-archive-tests"
python3 apps/ios/tests/check-health-sync-archive.py

# 恢复分支的判据单独一个可执行：一个模块只能有一个 `@main`，所以共用源码、分开编译。
# 它是 2026-09-22 线上「未找到导入来源」死锁的回归（详见该测试文件头部）。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/HealthSyncCancellation.swift \
  apps/ios/tests/HealthSyncResumeRegression.swift \
  -o "$tmp/health-sync-resume-tests"
"$tmp/health-sync-resume-tests"

# 「切后台 = 用户取消」这条错误等价关系留下的判据。纯 Foundation，所以够格进这个可执行；
# `HealthKitSync.swift` 本身不被任何回归编译，判据留在它里面就等于没有执行者。
# `SyncPhase.swift` 一起编：阶段闭集与原子单元判据都住在那里，而 `HealthSyncLifecycle`
# 的 `persistedPhases` / `terminalPhases` 由它派生 —— 少编它这里根本连不上。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/SyncPhase.swift \
  apps/ios/RAI/HealthSyncLifecycle.swift \
  apps/ios/tests/HealthSyncLifecycleRegression.swift \
  -o "$tmp/health-sync-lifecycle-tests"
"$tmp/health-sync-lifecycle-tests"

# 原子单元协议：`upload → inspect → startImport` 的下一步由**字段**推导（计划 §8）。
# 「按字段推导」这条纪律在 2026-09-22 的线上死锁里付过一次代价 —— 当时恢复分支按
# `phase` 字符串猜，于是"批次已上传、导入没发起"与"导入已在跑"分不出来。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/SyncPhase.swift \
  apps/ios/tests/SyncAtomicUnitRegression.swift \
  -o "$tmp/sync-atomic-unit-tests"
"$tmp/sync-atomic-unit-tests"

# `SyncTaskState` 的兼容性：升级不得把老设备上已存在的任务丢掉。
# `loadTask` 用 `try?` 解码 ⇒ 一个解不开的字段会让整份任务被当成"没有任务"，
# 现象是重导整个窗口、计数归零，而 `sync_tasks` 里那一行还在。
# `DirectSyncReceiptState.swift` 必须一起编：PR6 给 `SyncTaskState` 加了 `lastReceipt` /
# `lastAnalysisStatus`（类型 `DirectSyncReceipt` / `DirectSyncAnalysisStatus` 住在那个文件里），
# 少编这一支会以 `cannot find 'DirectSyncReceipt' in scope` 炸 —— 而全量类型检查（一起编）
# 完全看不出来（2026-10-13 实测：本支在 HEAD 上红了整轮 `npm run test:ios`）。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/SyncPhase.swift \
  apps/ios/RAI/DirectSyncReceiptState.swift \
  apps/ios/RAI/SyncTaskState.swift \
  apps/ios/RAI/WorkoutWindowPaging.swift \
  apps/ios/RAI/RouteSyncState.swift \
  apps/ios/tests/SyncTaskMigrationRegression.swift \
  -o "$tmp/sync-task-migration-tests"
"$tmp/sync-task-migration-tests"

xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/HealthKitRecordCursor.swift \
  apps/ios/tests/HealthKitRecordCursorRegression.swift \
  -o "$tmp/healthkit-record-cursor-tests"
"$tmp/healthkit-record-cursor-tests"

# 后台三机制的纯策略（P2-1）：投递唤醒该不该跑、BGProcessingTask 该推进哪一步。
# 这两件事的调用点在 `AppDelegate.swift` / `RAIApp.swift`。
# ⚠️ 覆盖范围（2026-09-24 实测修正，别再照抄旧说法）：`typecheck-ios.sh:102` 的排除清单是
# `MapPrivacy.swift / RAIApp.swift / TechRouteView.swift` 这三个 —— **`AppDelegate.swift` 不在其中**，
# 它会真被类型检查（实测：往它末尾插一句类型错误的代码，`typecheck-ios.sh` 立刻以
# `AppDelegate.swift:303:… error:` 退出 1）。但 `typecheck-ios.sh` 只做类型检查、不跑任何断言，
# 而 `RAIApp.swift` 连类型检查都进不去 ⇒ 判据仍然必须有执行者，不能只留在调用点。
#
# ⚠️ `HealthSyncBackgroundRecovery.swift` 必须一起编：`reportedSuccess` / `shouldResubmit`
# 的入参是那份**按目标读到的待办快照**（`PendingWork`）。少编它，这个单元会在真跑门禁时以
# `cannot find type 'HealthSyncBackgroundRecovery' in scope` 炸掉 —— 而 `typecheck-ios.sh`
# 是全量一起编的，"少列一个文件"在那里完全看不出来（同 capabilities §14i 的教训）。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/BackgroundSyncPolicy.swift \
  apps/ios/RAI/HealthSyncBackgroundRecovery.swift \
  apps/ios/RAI/HealthSyncWorkPlanner.swift \
  apps/ios/tests/BackgroundSyncPolicyRegression.swift \
  -o "$tmp/background-sync-policy-tests"
"$tmp/background-sync-policy-tests"

# R2（2026-10-19 复核）：观察者意图的**原子存储边界**（HealthSyncIntentJournal）。
#
# 旧实现在 UserDefaults 上做"读 current → 比较 → removeObject"三步：observer 在 HealthKit
# 队列写、确认在 MainActor 删，三步之间没有任何原子性 ⇒ 旧确认可以删掉刚写入的新代次。
# 这里用**真实 SQLite 文件**逐条执行两种交错顺序、并发记录/确认、跨连接重开、失败分类与
# 旧键迁移。判据的全部意义是"跨线程 + 跨连接"，替身会把它绕过去，所以必须用真库。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/HealthSyncBackgroundRecovery.swift \
  apps/ios/RAI/HealthSyncIntentJournal.swift \
  apps/ios/RAI/SQLiteSupport.swift \
  apps/ios/tests/HealthSyncIntentJournalRegression.swift \
  -lsqlite3 \
  -o "$tmp/health-sync-intent-journal-tests"

# R3（2026-10-19 复核）：训练窗口 anchored 分页的**纯状态机**（rev/EOF/轮转/CAS 前驱）。
# 判据全部是"改错了照样编译通过"的形态：满页当 EOF、缺锚点仍推进、窗口扩宽后复用旧锚。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/RouteSyncState.swift \
  apps/ios/RAI/WorkoutWindowPaging.swift \
  apps/ios/tests/WorkoutWindowPagingRegression.swift \
  -o "$tmp/workout-window-paging-tests"
"$tmp/workout-window-paging-tests"

# R3 的**落盘**一侧：分页候选只在 commitSuccess 的同一事务里提交，且带前驱锚点 CAS。
# 与既有的单事务提交回归同一手法：`SyncTaskStore(directory:)` 注入临时目录，
# 跑的是真实 SQLite 文件，不是替身。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/SyncPhase.swift \
  apps/ios/RAI/SyncStateCommitPlan.swift \
  apps/ios/RAI/SyncTaskStore.swift \
  apps/ios/RAI/APIModels.swift \
  apps/ios/RAI/DirectSyncBatchBudget.swift \
  apps/ios/RAI/SQLiteSupport.swift \
  apps/ios/RAI/RouteSyncState.swift \
  apps/ios/RAI/WorkoutWindowPaging.swift \
  apps/ios/tests/WorkoutWindowPagingStoreRegression.swift \
  -o "$tmp/workout-window-paging-store-tests"
"$tmp/workout-window-paging-store-tests"
"$tmp/health-sync-intent-journal-tests"

# 后台冷启动的恢复/意图确认时序。生产接线在 `HealthKitSync.swift`，但 URL/HealthKit/UIKit
# 依赖使它不能进入纯逻辑可执行；因此“陈旧 epoch 不接纳”“失败不消费”“任务落盘才消费”
# 与“导出期间新通知不被旧代次吞掉”必须在这个无副作用核心里执行。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/SyncPhase.swift \
  apps/ios/RAI/SyncStateCommitPlan.swift \
  apps/ios/RAI/SyncTaskStore.swift \
  apps/ios/RAI/WorkoutWindowPaging.swift \
  apps/ios/RAI/APIModels.swift \
  apps/ios/RAI/DirectSyncBatchBudget.swift \
  apps/ios/RAI/SQLiteSupport.swift \
  apps/ios/RAI/RouteSyncState.swift \
  apps/ios/RAI/HealthSyncBackgroundRecovery.swift \
  apps/ios/tests/HealthSyncBackgroundRecoveryRegression.swift \
  -lsqlite3 \
  -o "$tmp/health-sync-background-recovery-tests"
"$tmp/health-sync-background-recovery-tests"

# 锁屏 / 凭证阻塞（V2.1 规范 §3.3 / §3.4）：两个新阶段的落点、恢复判据，以及
# 「阻塞态绝不推进 anchor」这条不变式 —— 破了它不是报错，而是**静默丢数据**：
# 客户端会把"这一次没读到"当成"数据没有变化"从而推进水位，那段健康数据从此再也导不出来。
# `HealthSyncLifecycle.swift` 一起编：阻塞态经生命周期中止之后该保留还是降级，判据跨两个文件。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/SyncPhase.swift \
  apps/ios/RAI/HealthSyncLifecycle.swift \
  apps/ios/RAI/HealthSyncBlockedRecovery.swift \
  apps/ios/tests/HealthSyncBlockedRecoveryRegression.swift \
  -o "$tmp/health-sync-blocked-recovery-tests"
"$tmp/health-sync-blocked-recovery-tests"

# 成功收尾那条路（V2.1 规范 §2 原则 3「单状态源真相」）：`SyncStateCommitPlan` 的三态析出、
# `mayAdvanceAnchor` 的**生产执行点**，以及 `SyncTaskStore.commitSuccess` 单事务的三个护栏。
#
# 这两件事必须放一起编：判据（plan）与落盘（store）分家时，"阻塞态绝不推进 anchor" 会退化成
# 一句话而没有写入路径上的执行者 —— 那正是本次修复前的形态。
# `SyncTaskStore` + `SQLiteSupport` 只依赖 Foundation + SQLite3，所以这里跑的是**真库**，
# 不是替身（与 `run-store-tests.sh` 同一手法：`SyncTaskStore(directory:)` 支持注入目录）。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/SyncPhase.swift \
  apps/ios/RAI/SyncStateCommitPlan.swift \
  apps/ios/RAI/SyncTaskStore.swift \
  apps/ios/RAI/WorkoutWindowPaging.swift \
  apps/ios/RAI/APIModels.swift \
  apps/ios/RAI/DirectSyncBatchBudget.swift \
  apps/ios/RAI/SQLiteSupport.swift \
  apps/ios/RAI/RouteSyncState.swift \
  apps/ios/tests/SyncStateCommitRegression.swift \
  -o "$tmp/sync-state-commit-tests"
"$tmp/sync-state-commit-tests"

# Workout 伴生 Route 的**定频判据**（取代固定 14 天全量回填）：四态闭集、稳定性计数、
# 人工重扫复位，以及那条最危险的不变式 —— "跳过一轮"绝不能产生稳定证据。
#
# 它单独一个可执行、且**只**编译纯 Foundation 的三个文件，是刻意的：这台机器的全部价值
# 来自"无副作用"，一旦它能碰到 HealthKit 或数据库，判据就只能靠真机复现了。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/RouteSyncState.swift \
  apps/ios/RAI/RouteSyncStateMachine.swift \
  apps/ios/tests/RouteSyncStateMachineTests.swift \
  -o "$tmp/route-sync-state-machine-tests"
"$tmp/route-sync-state-machine-tests"

# B01/B02（第二轮复查）：路线结算的证据判据 + 最终执行闸门。
# 两件事共用 `RouteSyncState.swift` 的同一份类型（候选/结算/策略），所以同编一个单元 ——
# 分家会让"要删哪些待办"与"允不允许 fetch"各自演化，而它们必须回答同一个问题：
# 这条 UUID 这一批到底有没有**完整观测**。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/RouteSyncState.swift \
  apps/ios/RAI/RouteSyncStateMachine.swift \
  apps/ios/tests/RouteCommitSettlementRegression.swift \
  -o "$tmp/route-commit-settlement-tests"
"$tmp/route-commit-settlement-tests"

# 直连单批预算（S2.1/S2.2 + 2026-10-14 route 维度补全）：换算与边界都是纯函数，
# 失效方向静默（换算漏 0.9 ⇒ 载荷贴服务端硬上界；闸门边界写错 ⇒ 恰好等于上界时
# 放行一个必被拒的批）。`APIModels.swift` 必须一起编：决策依赖 `DirectSyncBounds`。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/APIModels.swift \
  apps/ios/RAI/DirectSyncBatchBudget.swift \
  apps/ios/tests/DirectSyncBatchBudgetTests.swift \
  -o "$tmp/direct-sync-budget-tests"
"$tmp/direct-sync-budget-tests"

# 上面那批判据的**落盘**一侧：`sync_route_state` 是真库上的单事务批量写。
# 为什么不能只测"函数返回了什么"：这张表是降频记忆的唯一住处（不许落 `UserDefaults`、
# 不许落 JSON、不许落内存单例），所以"跨进程还记得住""NULL 与空串分得开""半批写失败会整批
# 回滚"这三件事，只有在一个真库文件上跑才算数。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/SyncPhase.swift \
  apps/ios/RAI/SyncStateCommitPlan.swift \
  apps/ios/RAI/SyncTaskStore.swift \
  apps/ios/RAI/WorkoutWindowPaging.swift \
  apps/ios/RAI/APIModels.swift \
  apps/ios/RAI/DirectSyncBatchBudget.swift \
  apps/ios/RAI/SQLiteSupport.swift \
  apps/ios/RAI/RouteSyncState.swift \
  apps/ios/RAI/RouteSyncStateMachine.swift \
  apps/ios/tests/RouteSyncStatePersistenceRegression.swift \
  -o "$tmp/route-sync-state-persistence-tests"
"$tmp/route-sync-state-persistence-tests"

# 路线 GPX 的**流式写出**：判据是"与旧的拼串实现逐字节相同" + 预算分类 + 放弃时不留残片。
# 只有 `RouteGpxWriter.swift`（纯 Foundation/CryptoKit）进本单元 —— 它刻意不依赖 CLLocation，
# 所以"格式漂移"这条在 macOS 上就能抓到，不必等真机。
xcrun swiftc -parse-as-library -disable-sandbox \
  -swift-version 5 -default-isolation MainActor \
  apps/ios/RAI/RouteGpxWriter.swift \
  apps/ios/tests/RouteGpxStreamingRegression.swift \
  -o "$tmp/route-gpx-streaming-tests"
"$tmp/route-gpx-streaming-tests"

# 这个 python 门禁除了 iOS 源码，还读 `packages/health-export-parser/src/apple-health-parser.ts`
# 做文本判据。静态输入面解析看不穿 bash → python 的间接层，所以这里**显式点名**它 ——
# 否则 `RAI_MUTATION_FOR` 裁剪时那条 parser 突变会静默漏跑（改了它却没验到它的判据）。
python3 apps/ios/tests/check-healthkit-record-sync.py
