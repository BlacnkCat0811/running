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
#
# `-warnings-as-errors`（2026-10-20）与 `typecheck-ios.sh` 同一条纪律：app target 用
# `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor` 编译，"该写 nonisolated 却没写"这类诊断
# 只得到 warning，而它们在 Swift 6 语言模式下是 error。旧行为是打印完照样 exit 0，于是
# 警告可以无限攒；`HealthSyncIntentJournalRegression.swift` 里那条 `_ =` 就是这么留下的。
# 开闸时 5 个编译单元全部 0 warning；引入新 warning ⇒ 当场红，静默通过才是要防的东西。
swiftc_flags=(-parse-as-library -disable-sandbox -warnings-as-errors)
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
  apps/ios/RAI/CalibrationState.swift apps/ios/RAI/UserDataNoticePolicy.swift \
  apps/ios/RAI/HealthSyncBackgroundRecovery.swift apps/ios/RAI/HealthSyncIdentityPublisher.swift \
  apps/ios/RAI/PlanStatePolicy.swift apps/ios/RAI/PlanWatchScheduling.swift \
  apps/ios/RAI/PlanReceiptMatcher.swift apps/ios/RAI/PlanWatchSyncCoordinator.swift \
  apps/ios/RAI/PlanScheduleOperationJournal.swift apps/ios/RAI/TrainingPlanRepository.swift apps/ios/RAI/TrainingPlanStore.swift \
  apps/ios/RAI/TrainingPlanExecutionPolicy.swift apps/ios/RAI/TrainingPlanPublisher.swift \
  apps/ios/RAI/TrainingReminderPolicy.swift apps/ios/RAI/PlanMutationDisposition.swift apps/ios/RAI/SyncPresentationPolicy.swift \
  "$tmp/NativeAppModel.swift" apps/ios/tests/PlanTestFixtures.swift apps/ios/tests/ModelRegression.swift \
  -o "$tmp/model-tests"
"$tmp/model-tests"
# PR5：v2 统一训练读合同（`X-RAI-Training-Contract: 2`）的纯逻辑回归。
# 只编模型 + API 客户端 + 纯判定：协商常量、409/503 的合同分类、接受前的
# 身份/业务日/窗口/版本下限校验、以及"未知合同版本绝不显示成休息"的页面状态派生。
# 这些判定一旦写错，编译和全量类型检查都不会红，而用户看到的是"今天休息"。
xcrun swiftc "${swiftc_flags[@]}" apps/ios/RAI/APIModels.swift apps/ios/RAI/APIClient.swift \
  apps/ios/RAI/PlanStatePolicy.swift apps/ios/RAI/UserDataNoticePolicy.swift \
  apps/ios/RAI/TrainingPlanExecutionPolicy.swift \
  apps/ios/tests/TrainingPlanV2Regression.swift -o "$tmp/training-plan-v2-tests"
"$tmp/training-plan-v2-tests"
xcrun swiftc "${swiftc_flags[@]}" apps/ios/RAI/APIModels.swift apps/ios/RAI/APIClient.swift \
  apps/ios/RAI/PlanStatePolicy.swift apps/ios/RAI/UserDataNoticePolicy.swift \
  apps/ios/RAI/TrainingPlanExecutionPolicy.swift apps/ios/RAI/TrainingPlanPublisher.swift \
  apps/ios/tests/TrainingPlanPublisherRegression.swift \
  -o "$tmp/training-plan-publisher-tests"
"$tmp/training-plan-publisher-tests"
# B07 execution association: DTO/state-machine/candidate/assessment/journal gates.
# The publisher is compiled with its pure policy so a broken pending-row replay,
# a session/execution watermark or a "pending confirmation == completed" wording
# regression fails here rather than only on a Simulator tap-through.
xcrun swiftc "${swiftc_flags[@]}" apps/ios/RAI/APIModels.swift apps/ios/RAI/APIClient.swift \
  apps/ios/RAI/PlanStatePolicy.swift apps/ios/RAI/UserDataNoticePolicy.swift \
  apps/ios/RAI/TrainingPlanExecutionPolicy.swift apps/ios/RAI/TrainingPlanPublisher.swift \
  apps/ios/tests/TrainingPlanExecutionRegression.swift -o "$tmp/training-plan-execution-tests"
"$tmp/training-plan-execution-tests"
bash apps/ios/tests/run-plan-watch-tests.sh
bash apps/ios/tests/run-training-plan-store-tests.sh
bash apps/ios/tests/run-user-experience-tests.sh
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
  apps/ios/RAI/PlanReceiptMatcher.swift apps/ios/RAI/PlanStatePolicy.swift \
  apps/ios/RAI/TrainingPlanExecutionPolicy.swift \
  apps/ios/RAI/PlanWatchScheduling.swift apps/ios/RAI/UserDataNoticePolicy.swift \
  apps/ios/RAI/PlanScheduleOperationJournal.swift \
  apps/ios/tests/WorkoutPlanMapperRegression.swift -o "$tmp/workout-plan-tests"
"$tmp/workout-plan-tests"
# 直连回执与游标闸门（`docs/SQLITE_DIRECT_SYNC_DESIGN.md` §5.1 / §10.1 / §10.2）。
# 为什么必须挂在这扇聚合门禁里：这三个判据的失效方向全是**静默**的 —— 拿服务端的单一
# `succeeded` 当回执去推进游标，那段窗口从此不会再被任何一次 anchored query 返回；
# 连续分页还没 drain 完就清空后台待办意图，用户不打开 App 就再也没人接着发下一批。
# 而它两侧都够不着：`HealthKitSync.swift` 不被任何回归脚本编译（整份锁在 `#if os(iOS)`
# + HealthKit 里），`typecheck-ios.sh` 又只看类型不跑断言。判据存在 ≠ 判据被执行 ——
# 本仓在 `TechPlotSampling` / `check-today-layout.py` 上已经各付过一次学费。
#
# `SyncPhase.swift` 必须一起编：闸门第一条走的就是 `SyncPhase.mayAdvanceAnchor`
# （「阻塞态绝不推进 anchor」的唯一出处，不得在这里再抄一份阻塞清单），
# 而 `SyncTaskState.resolvedPhase` 也由它派生 —— 少编它这里会以
# `cannot find type 'SyncPhase' in scope` 炸，而全量类型检查（一起编）完全看不出来。
xcrun swiftc "${swiftc_flags[@]}" apps/ios/RAI/SyncPhase.swift \
  apps/ios/RAI/DirectSyncReceiptState.swift apps/ios/RAI/DirectSyncCursorPolicy.swift \
  apps/ios/RAI/SyncTaskState.swift apps/ios/RAI/RouteSyncState.swift \
  apps/ios/RAI/WorkoutWindowPaging.swift \
  apps/ios/tests/DirectSyncReceiptRegression.swift -o "$tmp/direct-sync-receipt-tests"
"$tmp/direct-sync-receipt-tests"

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
# 导出确定性的结构门禁。`HealthKitExport.swift` 同样不被任何回归脚本编译（整个文件被
# `#if os(iOS)` + `import HealthKit` 锁死，helper 全是 private static），于是"跑两遍断言
# 字节相同"在本机走不通。它钉的是三条**改错了照样编译通过、肉眼也看不出来**的确定性事实：
# `<MetadataEntry>` 必须按键排序（否则同一次跑步被反复判 updated）、样本查询必须显式排序
# （否则 export.xml 字节抖动，`source_sha256` 永不重复）、manifest 不许带墙钟
# （否则上传幂等键每次都变）。它顺手断言自己没变成孤儿。
python3 apps/ios/tests/check-export-determinism.py
# 直连同步的三支结构门禁（PR6）。`HealthKitSync.swift` 与 `DirectSyncCursorPolicy.swift` 里
# 有一批**改错了照样编译通过、肉眼也看不出来**的接线：用户看到的是 §10.3 的哪一句、六句是否
# 还来自同一个集中入口（旧语义有没有偷偷回来）、游标闸门是不是排在提交之前、被闸门拦下的一轮
# 会不会顺手把后台待办意图清掉、`requiresReceipt` 在**七类调用点**上有没有各自传对、
# 以及"对账排在游标提交之后、失败不让同步变红"。
# 🔴 这三支都**只**断言"自己没变成孤儿"，所以不挂在这里 = 它们一条判据都不执行
# （`check-today-layout.py` 的历史失效模式）。三条一起挂、缺一条都会让对应门禁转红。
python3 apps/ios/tests/check-direct-sync-status-copy.py
python3 apps/ios/tests/check-direct-sync-contract-parity.py
python3 apps/ios/tests/check-direct-sync-analysis-reconcile.py
# PR-02（2026-10-21）退役计划面出站门禁：统一页不得再链到手动课表编辑器，
# 生产 Swift 代码只能在 APIClient 兼容传输里拼退役路径；新服务宣告统一读能力
# 而未宣告写能力时，模型必须在发请求前拒绝旧写 route。它同时断言自己是本聚合
# 入口的真实调用者（`check-today-layout.py` 的孤儿教训）。
python3 apps/ios/tests/check-retired-plan-outbound.py
# PR5 读侧一致性（C9 键集/可选性 + C2 键集不跨域 + 能力位命名）。它此前是**唯一一支孤儿**：
# 只挂在 `npm run check:ios-gates` 里，而那个入口不在 pre-commit、也不在 CI ⇒ 从 2026-10-13
# 引入起连续 6 天**一条判据都没执行**（还因为缺 gitignored 的基线被写成"预存在失败"）。
# 2026-10-19：基线入库（`apps/ios/tests/fixtures/pr5-c9-baseline-keys.json`，可由
# `--write-baseline` 重建）+ 挂进本聚合入口 ⇒ `npm run test:ios` 在 macOS 上真的会跑它。
python3 apps/ios/tests/check-pr5-facts-analysis.py
# Optional release red/green proof; ordinary gates already execute all positive regressions.
if [ "${RAI_PLAN_STATE_MUTATIONS:-0}" = 1 ]; then
  bash apps/ios/tests/run-plan-state-mutations.sh
fi
