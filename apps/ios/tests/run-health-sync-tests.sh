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
