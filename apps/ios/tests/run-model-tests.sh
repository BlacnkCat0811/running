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
# `WorkoutPlanMapper.swift` 一起编：`NativeAppModel` 与映射器共用同一批课表 DTO
# （`MobileWorkoutPlanDay` / `MobileWorkoutPlanResponse`），少编它就会在模型回归里
# 报 "cannot find type ... in scope"；同时映射器一旦编译不过，模型回归也不该报绿。
# `typecheck-ios.sh` 是全量一起编，抓不到这种「子集缺文件」——两条通道都要跑。
# `CalibrationState.swift` 必须留在编译列表里：它决定"校准完成"要不要继续挂黄色
# 告警框，曾被写成 `!= "ready"`（契约里不存在的取值）而对任何输入恒为真。它住在
# `NativeFormat.swift` 时因为拖进 `PixelColor`（iOS 专属）而进不了这扇闸门，于是
# 错了也无人报警 —— 抽出来就是为了让它在这里被钉住。
# `NativeFormat.swift` 自 2026-09-18 起也进这扇闸门：删除像素皮肤后它已无 iOS 专属
# 依赖（不再 import SwiftUI、不再引用 PixelColor），而它是页面数值/单位/日期的唯一
# 归一化点 —— 编不过或改坏了，整机展示全错，没有理由让它在闸门外。
xcrun swiftc "${swiftc_flags[@]}" apps/ios/RAI/APIModels.swift apps/ios/RAI/APIClient.swift \
  apps/ios/RAI/NativeFormat.swift apps/ios/RAI/WorkoutPlanMapper.swift \
  apps/ios/RAI/CalibrationState.swift \
  "$tmp/NativeAppModel.swift" apps/ios/tests/ModelRegression.swift \
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
# iOS SDK，所以本脚本只编译并运行 APIModels + WorkoutPlanMapper + PlanReceiptMatcher
# + 回归用例。含 WorkoutKit 的源码改由 `bash apps/ios/tests/typecheck-ios.sh` 用
# iPhoneSimulator SDK 做类型检查。
# `PlanReceiptMatcher.swift` 必须留在编译列表里：它决定「哪几天真的上了表」，是纯
# Foundation，也是唯一能钉住这条规则的通道 —— 规则住在 `WorkoutKitBridge` 里时只能
# 配合 iOS SDK 编译，于是错了也没有任何通道能发现。
# Run mapping regressions with the app's default actor isolation, not just the
# host compiler default, so direct isolated-function transforms stay covered.
xcrun swiftc "${swiftc_flags[@]}" -swift-version 5 -default-isolation MainActor \
  apps/ios/RAI/APIModels.swift apps/ios/RAI/WorkoutPlanMapper.swift \
  apps/ios/RAI/PlanReceiptMatcher.swift \
  apps/ios/tests/WorkoutPlanMapperRegression.swift -o "$tmp/workout-plan-tests"
"$tmp/workout-plan-tests"

bash apps/ios/tests/run-session-tests.sh
bash apps/ios/tests/run-health-sync-tests.sh
# `CacheStore` / `SyncTaskStore` 的生产实现回归。这两个文件此前只被类型检查过：
# `ModelRegression.swift` 里有一份 `CacheStore` 替身，于是"缓存命名空间由什么决定"
# 这条规则从来没被真实现跑过。替身隔离本身没错，错的是把替身的绿灯当成真实现的判据。
bash apps/ios/tests/run-store-tests.sh
# `run-tech-presentation-tests.sh` 必须挂在这里，否则它只是一个"手工脚本"。
# 实测过它的失效模式：脚本自己跑绿、突变也真红，但全仓没有任何入口
# 会执行它 —— 新写的 `TechPlotSampling` / `TechSyncPresentation` / `verdictIconName`
# 断言因此从不参与任何一次回归。这与 `CalibrationState.swift`、`PlanReceiptMatcher.swift`
# 的教训同类：判据存在不等于判据被执行。挂在聚合入口里才算真的"被钉住"。
bash apps/ios/tests/run-tech-presentation-tests.sh
# `check-today-layout.py` 曾是一支孤儿脚本：断言写得对、手工跑也真绿，但全仓没有任何
# 入口会执行它（`grep -rn check-today-layout apps packages docs` 只在它自己里命中）。
# 它钉的是今日页的组合顺序、`TechTodayHealthTiles` 已移除、`showsHistory` 的告警条件、
# 紧凑卡片高度、分钟轴替代秒轴、地图同意开关默认值 —— 全是"改错了肉眼也看不出来"的
# 版式判据，正是最需要执行者的那一类。挂在聚合入口里才算真的被钉住。
python3 apps/ios/tests/check-today-layout.py
# 后台同步能力的结构门禁。`HealthKitSync.swift` 不被任何回归脚本编译，类型检查又看不见
# "切后台时到底调了谁"；这个脚本钉的是「生命周期中止不得冒充用户取消」「expiration handler
# 必须走 suspendForLifecycle」这类改错了照样编译通过的事实，并顺手断言自己没变成孤儿。
python3 apps/ios/tests/check-background-capabilities.py
