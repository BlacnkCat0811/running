#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sed '1{/^#if os(iOS)$/d;}; ${/^#endif$/d;}' apps/ios/RAI/CacheStore.swift > "$tmp/CacheStore.swift"
xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/APIModels.swift apps/ios/RAI/APIClient.swift apps/ios/RAI/PlanStatePolicy.swift \
  apps/ios/RAI/TrainingPlanRepository.swift apps/ios/RAI/TrainingPlanStore.swift \
  apps/ios/RAI/TrainingPlanExecutionPolicy.swift \
  apps/ios/RAI/ServerSession.swift "$tmp/CacheStore.swift" apps/ios/RAI/SQLiteSupport.swift \
  apps/ios/RAI/PlanScheduleOperationJournal.swift apps/ios/RAI/PlanWatchScheduling.swift \
  apps/ios/RAI/WorkoutPlanMapper.swift apps/ios/RAI/PlanReceiptMatcher.swift apps/ios/RAI/UserDataNoticePolicy.swift \
  apps/ios/tests/PlanTestFixtures.swift apps/ios/tests/TrainingPlanStoreRegression.swift \
  -o "$tmp/training-plan-store-tests"
"$tmp/training-plan-store-tests"
