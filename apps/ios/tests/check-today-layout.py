"""Source-level Today composition checks; does not replace simulator review."""
from pathlib import Path

root = Path(__file__).resolve().parents[1] / "RAI" / "Skins" / "Technology"
views = (root / "TechViews.swift").read_text()
body = views[views.index("struct TechTodayView"):views.index("private func trainingOverview")]
ordered = ["todayHero(today)", "recoveryPanel(today)", "trainingOverview(today)", "recommendationPanel(today)"]
positions = [body.index(call) for call in ordered]
assert positions == sorted(positions), "Today/recovery must lead the training cards"
assert "TechTodayHealthTiles" not in views
assert "TechTodayHealthTiles" not in (root / "TechIllustrations.swift").read_text()
assert "TechSyncStatus(" not in body, "Background sync must not add a home status card"
assert "TechFreshnessBanner(" not in body, "Diagnostic timestamps belong in details, not home"
assert "TechDataSyncDetailView" in views, "Health settings must link to details"
assert "UserDataNoticePolicy.recommendationNotice" in views
assert "!native.canConfirmToday" in views, "Stale suggestions cannot be confirmed"
native_root = (root.parents[1] / "NativeViews.swift").read_text()
assert "TechRequestFailure(" not in native_root, "Background refresh failure must not present a modal"
row = views[views.index("private func trainingOverview"):views.index("private func todayHero")]
assert "HStack(alignment: .top" in row
assert "typeSize >= .xxxLarge" in row and "VStack" in row
assert "verdictPanel(data)" in row and "activityPanel(data)" in row
sync = (root / "TechSyncStatus.swift").read_text()
assert "var showsHistory = true" in sync, "Settings must retain sync history"
assert "showsHistory || state == .busy || state == .failed || state == .cancelled" in sync
recovery = (root / "TechTodayRecovery.swift").read_text()
assert 'icon: "heart.fill", color: TechColor.coral' in recovery
assert 'icon: "waveform.path.ecg", color: TechColor.success' in recovery
print("Today layout checks passed (order, paired summaries, sync visibility, recovery icons)")

assert views.count('.frame(height: typeSize >= .xxxLarge ? nil : 112, alignment: .topLeading)') == 2
assert 'if let series = native.selectedSeries, series.showsPlanSegments' in views
assert 'segmentPanel(series)\n                    } else {\n                        splitPanel(' in views, "Plan steps and kilometer splits are mutually exclusive"
# 实参不钉：2026-10-02 起分段面板接收整个 series（要读 grade 汇总），
# 钉的是「两个分支互斥」这一行为，而不是某个实参写法。
# §5 环境只读视图必须在详情页真的渲染，且理由码走 NativeFormat 的统一翻译。
assert 'environmentPanel(detail.workout.environment)' in views, "详情页必须展示环境只读视图"
assert 'nativeEnvironmentReason' in views, "环境理由码必须走统一翻译"
chart = (root / "TechSeriesChart.swift").read_text()
assert '.chartXAxisLabel("min")' in chart and '.chartXAxisLabel("秒")' not in chart
assert 'point.offsetSeconds / 60' in chart and 'selected.offsetSeconds / 60' in chart
assert 'selectedTime = data.points[index].offsetSeconds / 60' in chart
route = (root / "TechRouteView.swift").read_text()
assert '@State private var showingSystemMap = true' in route
assert 'else if showingSystemMap, mapAllowed' in route
# 地图手势锁定：训练详情整体是 ScrollView，`MAMapView` 一旦接管拖动，
# 「往下翻页」就变成「把地图划走」（2026-10-01 用户反馈）。下面 4 条各钉住一个
# 改错了照样编译通过的环节：SwiftUI 侧默认值、屏蔽层的命中测试、以及解锁状态
# 是否真的驱动了高德自己的手势开关。
assert '@State private var mapInteractive = false' in route, \
    "地图必须默认锁定，否则纵向滑动又被 MAMapView 截获"
assert 'allowsHitTesting(!mapInteractive)' in route, \
    "锁定时屏蔽层必须放行触摸给外层滚动视图，解锁后必须不再拦截地图"
assert 'NativeRouteMap(coordinates: coordinates, triggerFit: fitRequest, isInteractive: mapInteractive)' in route, \
    "解锁状态必须从 SwiftUI 传到 UIKit 层"
for key in ('map.isScrollEnabled = isInteractive', 'map.isZoomEnabled = isInteractive'):
    assert key in route, f"解锁状态必须真正驱动高德手势开关，缺少：{key}"
print("Compact card heights, minute chart coordinates, structured steps, map consent and map gesture lock checks passed")
