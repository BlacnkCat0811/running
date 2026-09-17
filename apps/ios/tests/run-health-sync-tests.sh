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
