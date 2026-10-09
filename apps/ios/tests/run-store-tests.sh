#!/bin/bash
# `CacheStore` 与 `SyncTaskStore` 的生产实现回归（缓存隔离、淘汰策略、续传日志）。
#
# 这两个文件此前只被 `typecheck-ios.sh` 检查过类型，从未被执行：
# `ModelRegression.swift` 里有一份 `CacheStore` 替身（`scope` 退化成字符串拼接，
# `read`/`write` 走内存字典），所以「缓存命名空间由什么决定」「淘汰先删哪一条」
# 这两条规则从来没有真实现跑过。替身是合理的隔离手段，但它不能替代真实现的判据。
#
# `CacheStore.swift` 整份包在 `#if os(iOS)` 里，用 sed 去掉首尾两行即可在 macOS 上
# **原样**编译 —— 实测 `FileProtectionType` / `FileAttributeKey.protectionKey` /
# `CryptoKit` / `SQLite3` 在 macOS SDK 上都可用，所以这里跑的就是生产实现本身，
# 不是"改写一份等价逻辑再测"。`SyncTaskStore.swift` 没有外层包裹（只在文件保护那几行
# 内部用 `#if os(iOS)`），直接编译。
#
# `ServerSession.swift` 一起编：`CacheStore.urlScope` 依赖它的 `canonicalURL`，
# 而那正是 urlScope 的判据所在（去端口、去 path/query、小写 host）。本回归只调用那个
# nonisolated static，所以 `StoreRegression.swift` 里的 Keychain/RaiURLSession 替身
# 一旦被触达就会 precondition 失败。
set -euo pipefail
cd "$(dirname "$0")/../../.."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

sed '1{/^#if os(iOS)$/d;}; ${/^#endif$/d;}' apps/ios/RAI/CacheStore.swift > "$tmp/CacheStore.swift"

# `-disable-sandbox` 见 run-model-tests.sh 的同一段注释：`ServerSession` 带
# `@Observable`，宏插件被 swift-driver 包进 `sandbox-exec` 后在外层拒绝嵌套沙箱的
# 环境里会直接死掉，失败形态是满屏 "produced malformed response"，与真实错误无关。
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/APIModels.swift apps/ios/RAI/PlanStatePolicy.swift \
  apps/ios/RAI/PlanScheduleOperationJournal.swift apps/ios/RAI/PlanWatchScheduling.swift \
  apps/ios/RAI/WorkoutPlanMapper.swift apps/ios/RAI/PlanReceiptMatcher.swift apps/ios/RAI/UserDataNoticePolicy.swift \
  apps/ios/RAI/ServerSession.swift \
  "$tmp/CacheStore.swift" \
  apps/ios/RAI/HealthSyncBackgroundRecovery.swift apps/ios/RAI/HealthSyncIdentityPublisher.swift \
  apps/ios/RAI/SyncPhase.swift \
  apps/ios/RAI/SyncStateCommitPlan.swift \
  apps/ios/RAI/SyncTaskStore.swift \
  apps/ios/RAI/SQLiteSupport.swift \
  apps/ios/RAI/RouteSyncState.swift \
  apps/ios/tests/StoreRegression.swift \
  -o "$tmp/store-tests"
"$tmp/store-tests"
