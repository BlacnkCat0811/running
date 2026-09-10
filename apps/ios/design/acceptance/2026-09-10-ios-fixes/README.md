# iOS 今日页与训练详情修复验收

2026-09-10，使用真实数据库的隔离副本及 RAI Technology Acceptance 模拟器。未写入生产数据库。

- 今日页：训练判定不再被数据日期阻断；真实恢复数据展示“恢复不足”，说明中保留证据日期。
- 心率：平均值来自训练汇总，最大值来自保留峰值的时序；青色曲线、渐变填充、分钟时间轴。截图为该次真实训练值，不使用参考图示例值。
- 地图：原生 MapKit 在模拟器显示高德标识，但底图仍为空白。UIKit 轨迹层根据 MapKit 坐标转换绘制，已在截图确认轨迹和起终点可见。街道底图加载与实地坐标对齐仍需真机联网验收，不能把此截图当作底图通过证明。

验证结果：

- `npm run typecheck` 通过。
- `npm test`：后端/共享包 449 通过、3 跳过；Web 59 通过。
- `npm run build` 通过。
- API 数据及峰值抽样最终回归 10 项通过。
- `bash apps/ios/tests/run-model-tests.sh` 通过，包括恢复状态映射和心率轴数据检查。
- iOS Simulator SDK 构建通过。
- 原生 UI 今日/身体指标与训练详情 2 项通过；地图轨迹层改动后训练详情再次通过。

日志和 xcresult 位于 `/tmp/rai-ios-fixes-visual`、`/tmp/rai-ios-fixes-visual-map`。本目录保留关键截图。API 与 iOS 应用需同时更新，缓存需成功刷新。
