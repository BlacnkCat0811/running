#!/bin/bash
# Runs the production model/API/DTOs on macOS with isolated session/cache doubles.
# No app preferences, Keychain, HealthKit, API server, or user cache are touched.
set -euo pipefail
cd "$(dirname "$0")/../../.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# `-disable-sandbox` 是必需的，不是可选优化：swift-driver 会把宏插件
# `swift-plugin-server` 包进 `sandbox-exec`，而当外层环境拒绝嵌套沙箱时插件进程
# 直接死在 "sandbox_apply: Operation not permitted"，随后每个 `@Observable` 展开
# 都报 "produced malformed response"，看起来像一屏源码错误其实不是。
# 详见 typecheck-ios.sh 里同一段注释；两处必须一起加，否则 macOS 纯逻辑回归会被误判。
swiftc_flags=(-parse-as-library -disable-sandbox)
sed '1{/^#if os(iOS)$/d;}; ${/^#endif$/d;}' apps/ios/RAI/NativeAppModel.swift > "$tmp/NativeAppModel.swift"
# `WorkoutPlanMapper.swift` 必须一起编：`NativeAppModel.recordPlanSync` 用
# `WorkoutPlanMapper.plannedWorkout(from:)` 复用「手表真正收到的那批日子」这个判据，
# 少编它就会在 :566 报 "cannot find 'WorkoutPlanMapper' in scope"。
# `typecheck-ios.sh` 是全量一起编，抓不到这种「子集缺文件」——两条通道都要跑。
xcrun swiftc "${swiftc_flags[@]}" apps/ios/RAI/APIModels.swift apps/ios/RAI/APIClient.swift \
  apps/ios/RAI/WorkoutPlanMapper.swift "$tmp/NativeAppModel.swift" apps/ios/tests/ModelRegression.swift \
  -o "$tmp/model-tests"
"$tmp/model-tests"
xcrun swiftc "${swiftc_flags[@]}" apps/ios/RAI/Keychain.swift \
  apps/ios/tests/KeychainRegression.swift -o "$tmp/keychain-tests"
"$tmp/keychain-tests"
# 坐标转换同样是纯数学：去掉平台的 #if os(iOS) 后可在 macOS 上直接跑。
# 锚点由高德 SDK 的 AMapCoordinateConvert(_, .GPS) 实测导出，见
# apps/ios/tests/run-coordinate-sdk-check.sh。
sed '1{/^#if os(iOS)$/d;}; ${/^#endif$/d;}' apps/ios/RAI/CoordinateConversion.swift > "$tmp/CoordinateConversion.swift"
xcrun swiftc "${swiftc_flags[@]}" "$tmp/CoordinateConversion.swift" \
  apps/ios/tests/CoordinateConversionRegression.swift -o "$tmp/coordinate-tests"
"$tmp/coordinate-tests"
# 课表映射同样是纯函数：WorkoutKit 只出现在 WorkoutKitBridge.swift，编译它需要
# iOS SDK，所以本脚本只编译并运行 APIModels + WorkoutPlanMapper + 回归用例。
# 含 WorkoutKit 的源码改由 `bash apps/ios/tests/typecheck-ios.sh` 用
# iPhoneSimulator SDK 做类型检查。
xcrun swiftc "${swiftc_flags[@]}" apps/ios/RAI/APIModels.swift apps/ios/RAI/WorkoutPlanMapper.swift \
  apps/ios/tests/WorkoutPlanMapperRegression.swift -o "$tmp/workout-plan-tests"
"$tmp/workout-plan-tests"
