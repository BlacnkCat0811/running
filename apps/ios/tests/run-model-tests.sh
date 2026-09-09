#!/bin/bash
# Runs the production model/API/DTOs on macOS with isolated session/cache doubles.
# No app preferences, Keychain, HealthKit, API server, or user cache are touched.
set -euo pipefail
cd "$(dirname "$0")/../../.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sed '1{/^#if os(iOS)$/d;}; ${/^#endif$/d;}' apps/ios/RAI/NativeAppModel.swift > "$tmp/NativeAppModel.swift"
xcrun swiftc -parse-as-library apps/ios/RAI/APIModels.swift apps/ios/RAI/APIClient.swift \
  "$tmp/NativeAppModel.swift" apps/ios/tests/ModelRegression.swift -o "$tmp/model-tests"
"$tmp/model-tests"
