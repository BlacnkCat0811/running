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
xcrun swiftc -parse-as-library apps/ios/RAI/Keychain.swift \
  apps/ios/tests/KeychainRegression.swift -o "$tmp/keychain-tests"
"$tmp/keychain-tests"
# 坐标转换同样是纯数学：去掉平台的 #if os(iOS) 后可在 macOS 上直接跑。
# 锚点由高德 SDK 的 AMapCoordinateConvert(_, .GPS) 实测导出，见
# apps/ios/tests/run-coordinate-sdk-check.sh。
sed '1{/^#if os(iOS)$/d;}; ${/^#endif$/d;}' apps/ios/RAI/CoordinateConversion.swift > "$tmp/CoordinateConversion.swift"
xcrun swiftc -parse-as-library "$tmp/CoordinateConversion.swift" \
  apps/ios/tests/CoordinateConversionRegression.swift -o "$tmp/coordinate-tests"
"$tmp/coordinate-tests"
