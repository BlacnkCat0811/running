# RAI 原生 iOS 验收记录

记录日期：2026-09-08。代码工作区位于 `/Users/ta/running`。已使用本机
Xcode 26.5 / iOS Simulator 26.5 完成无签名 Debug 构建；真实 iPhone、
HealthKit 权限和视觉截图验收仍需在连接设备上完成。

## 代码与接口检查

| 阶段 | 场景 | 结果 | 证据/备注 |
| --- | --- | --- | --- |
| P0 | 服务端身份、代际、移动接口核验 | 通过 | `apps/api/src/server.ts`、`packages/api-contracts/src/index.ts` |
| P1 | Swift DTO 覆盖 handshake、今日、训练、统计、趋势、目标、锁课 | 通过构建 | `apps/ios/RAI/APIModels.swift`、`APIClient.swift` |
| P2 | SwiftUI 原生五入口、像素视觉系统、Keychain 服务凭证、SQLite 页面缓存 | 通过构建 | `PixelTheme.swift`、`PixelTabBar.swift`、`NativeViews.swift`、`NativeAppModel.swift` |
| P3 | 今日、训练筛选/分页、详情、路线、全部时序、计划、分析 | 通过构建 | `NativeViews.swift`、`PixelCharts.swift` |
| P4 | HealthKit ZIP/XML 管道和失败任务持久化 | 通过构建，未真机 | `HealthKitSync.swift`、`HealthKitExport.swift`、`SyncTaskStore.swift` |
| P5 | revision 目标保存和建议 revision 锁课 | 通过构建 | `NativeAppModel.swift`、`APIClient.swift` |
| P6 | 首次连接页、离线/过期状态、VoiceOver 文本状态、Reduce Motion | 通过构建，未真机 | `RootView.swift`、`NativeViews.swift`、`PixelTheme.swift` |

## 仓库验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 通过：448 个 Node/API 测试，59 个 Web 测试 |
| `npm run build` | 通过 |
| `npm run test:e2e:web` | 通过：10 个测试，1 个 390px 测试跳过 |
| Xcode simulator Debug build | 通过：`xcodebuild -project apps/ios/RAI.xcodeproj -scheme RAI -sdk iphonesimulator -configuration Debug -derivedDataPath /tmp/rai-derived CODE_SIGNING_ALLOWED=NO build` |
| Xcode unit/UI tests | 未配置/未运行 |
| HealthKit 权限、生命周期、路线和图表真机测试 | 未运行：当前环境无 iPhone |
| 390px responsive E2E | 按仓库约束未运行 |

上表的 Xcode 构建命令保留 2026-09-08 当日原始记录。2026-09-11 接入高德 SDK（CocoaPods）后，构建入口改为 workspace：`cd apps/ios && pod install`，再执行 `xcodebuild -workspace apps/ios/RAI.xcworkspace -scheme RAI -configuration Debug -sdk iphonesimulator -derivedDataPath /tmp/rai-derived CODE_SIGNING_ALLOWED=NO build`；只打开 `RAI.xcodeproj` 会因 `Pods_RAI` 链接失败。当前构建与验收入口见 `apps/ios/README.md` 与 `docs/IOS_NATIVE_RUNBOOK.md`。

同日还完成：高德 Key 改为本地 `Configs/AmapKey.xcconfig` + `$(RAI_AMAP_API_KEY)` 注入（仓库不含明文，无 Key 时构建通过但底图不加载）；新增隐私门控（未同意不初始化地图 SDK、不创建 `MAMapView`）；`run-model-tests.sh` 增加 WGS-84→GCJ-02 坐标回归，`run-coordinate-sdk-check.sh` 用高德 SDK 的 `AMapCoordinateConvert(_, .GPS)` 现场对拍（境内差 0.02–0.6 m，境外原样）。以上均为命令级验证，真机/模拟器的人工视觉验收仍未运行。

P4 已补充服务端批次幂等：`X-RAI-Sync-Batch` 会在运行时 SQLite 中绑定到来源，重复上传不会创建第二个来源；同代复用和跨 `datasetEpoch` 隔离分别由 `apps/api/test/import-sources.test.ts` 与 API 运行时测试覆盖。HealthKit 增量导出还会对近期跑步做路线补查，并把 workout UUID 写入同步清单和导入元数据，用于路线晚到和来源删除场景。Swift/Xcode 和真机验证仍未运行。

## 下一轮必须补测

连接错误地址、超时和 401；断网重启读取缓存；清缓存保留同步任务和凭证；切换服务隔离缓存；revision 冲突；重复锁课；首次大历史同步；上传后 App 终止；服务端成功后 App 终止；部分 HealthKit 权限；路线晚到和来源删除；VoiceOver、Reduce Motion、Dynamic Type 和两种 iPhone 尺寸。
