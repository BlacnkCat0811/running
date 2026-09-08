# RAI 原生 iOS 验收记录

记录日期：2026-09-08。环境：Windows 工作区 `D:\applerun`。本机没有 Xcode、iOS SDK 或连接的 iPhone，因此未将 Xcode/真机项目标为通过。

## 代码与接口检查

| 阶段 | 场景 | 结果 | 证据/备注 |
| --- | --- | --- | --- |
| P0 | 服务端身份、代际、移动接口核验 | 通过 | `apps/api/src/server.ts`、`packages/api-contracts/src/index.ts` |
| P1 | Swift DTO 覆盖 handshake、今日、训练、统计、趋势、目标、锁课 | 已实现，未编译 | `apps/ios/RAI/APIModels.swift`、`APIClient.swift` |
| P2 | SwiftUI 原生五入口、Keychain 服务凭证、SQLite 页面缓存 | 已实现，未编译 | `NativeViews.swift`、`NativeAppModel.swift`、`CacheStore.swift` |
| P3 | 今日、训练筛选/分页、详情、路线、时序、计划、分析 | 已实现，未编译 | `NativeViews.swift` |
| P4 | HealthKit ZIP/XML 管道和失败任务持久化 | 已实现，未编译/未真机 | `HealthKitSync.swift`、`HealthKitExport.swift`、`SyncTaskStore.swift` |
| P5 | revision 目标保存和建议 revision 锁课 | 已实现，未编译 | `NativeAppModel.swift`、`APIClient.swift` |

## 仓库验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 通过：448 个 Node/API 测试，59 个 Web 测试 |
| `npm run build` | 通过 |
| `npm run test:e2e:web` | 通过：10 个测试，1 个 390px 测试跳过 |
| Xcode build/unit/UI tests | 未运行：当前环境无 Xcode |
| HealthKit 权限、生命周期、路线和图表真机测试 | 未运行：当前环境无 iPhone |
| 390px responsive E2E | 按仓库约束未运行 |

P4 已补充服务端批次幂等：`X-RAI-Sync-Batch` 会在运行时 SQLite 中绑定到来源，重复上传不会创建第二个来源；同代复用和跨 `datasetEpoch` 隔离分别由 `apps/api/test/import-sources.test.ts` 与 API 运行时测试覆盖。HealthKit 增量导出还会对近期跑步做路线补查，并把 workout UUID 写入同步清单和导入元数据，用于路线晚到和来源删除场景。Swift/Xcode 和真机验证仍未运行。

## 下一轮必须补测

连接错误地址、超时和 401；断网重启读取缓存；清缓存保留同步任务和凭证；切换服务隔离缓存；revision 冲突；重复锁课；首次大历史同步；上传后 App 终止；服务端成功后 App 终止；部分 HealthKit 权限；路线晚到和来源删除；VoiceOver、深色模式和两种 iPhone 尺寸。
