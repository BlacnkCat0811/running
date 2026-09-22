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
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/SyncPhase.swift \
  apps/ios/RAI/SyncTaskState.swift \
  apps/ios/tests/SyncTaskMigrationRegression.swift \
  -o "$tmp/sync-task-migration-tests"
"$tmp/sync-task-migration-tests"

# 后台三机制的纯策略（P2-1）：投递唤醒该不该跑、BGProcessingTask 该推进哪一步。
# 这两件事的调用点在 `AppDelegate.swift` / `RAIApp.swift`，而**这两个文件都不进类型检查**
# （`typecheck-ios.sh:92` 排除清单）⇒ 判据留在调用点等于无人执行，必须住在这里。
# 只依赖 Foundation，所以够格进这个可执行。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/BackgroundSyncPolicy.swift \
  apps/ios/tests/BackgroundSyncPolicyRegression.swift \
  -o "$tmp/background-sync-policy-tests"
"$tmp/background-sync-policy-tests"
