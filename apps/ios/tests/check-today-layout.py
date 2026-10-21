"""Source-level Today composition checks; does not replace simulator review.

🔴 显式 `encoding="utf-8"`：这些 Swift 源码含中文，而 `read_text()` 不带 `encoding`
时用**本机默认编码**（Windows = cp936/GBK）⇒ 在 Windows 上直接 `UnicodeDecodeError`
崩溃退出（无逐条原因、无跳过说明），而这条链只在 macOS 上跑、macOS 默认 UTF-8，
所以缺陷在 CI/开发机上都看不见。
本仓是"在 Windows 上开发、在 macOS 上构建"，门禁必须两边都能跑。
"""
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1] / "RAI" / "Skins" / "Technology"
views = (root / "TechViews.swift").read_text(encoding="utf-8")
body = views[views.index("struct TechTodayView"):views.index("private func trainingOverview")]
ordered = [
    "todayHero(today)", "recoveryPanel(today)", "trainingOverview(today)",
    "if let postRun = today.postRun { postRunPanel(postRun) }",
    "recommendationPanel(today)", "planPhaseLine(today)", "abilityCard(today)",
    "TechTodayMetrics(", "raceSummary(today)",
]
positions = [body.index(call) for call in ordered]
assert positions == sorted(positions), "Today/recovery must lead the training cards"
hero = views[views.index("private func todayHero"):views.index("private func heroMetric")]
assert "Text(nativeNumber(data.today.distanceKm, digits: 2))" in hero
assert ".techFont(.hero).monospacedDigit()" in hero, "Emphasize the real distance in its existing slot"
assert 'Text("km").font(.subheadline.weight(.medium)).foregroundStyle(TechColor.muted)' in hero
recommendation = views[views.index("private func recommendationPanel"):views.index("private func lockDisabled")]
assert "Button { showingLock = true } label:" in recommendation
assert ".disabled(lockDisabled(data))" in recommendation
assert ".foregroundStyle(lockDisabled(data) ? TechColor.muted : TechColor.actionInk)" in recommendation
assert ".background(lockDisabled(data) ? TechColor.grid : TechColor.action, in: TechSurfaceShape())" in recommendation, \
    "Unavailable lock actions must be neutral, not a live Volt CTA"
# 2026-10-18（审查 P3-18；计划卡审查的未决项 C4/C5 现记录在 PROJECT_REVIEW §2）：
# 今日页有两张"计划"卡（今日推荐训练 + 阶段量带），此前口径互相冲突。
# 这里钉住 2026-10-18 的文案分层：删掉「量带」或「课表」任一字样都必须变红。
phase = views[views.index("private func planPhaseLine"):views.index("private func recoveryPanel")]
assert "阶段建议量带" in phase, "A1: 量带行必须显式写「阶段建议量带」（不是今天要补的距离）"
assert "按最近 4 周实测推算" in phase, "A1: 阶段量带必须说明推算口径"
assert "课表计划" in phase, "A2: 完成度行必须写「课表计划」，不是裸的已完成/计划"
assert "本周 \\(nativeAdherenceName(adherence.status))" in phase, "A3: 卡头状态必须带「本周」窗口"
assert "今日改为休息后，本周课表还差" in recommendation, "A4: 今日改为休息时必须串起本周课表缺口"
assert "TechTodayHealthTiles" not in views
assert "TechTodayHealthTiles" not in (root / "TechIllustrations.swift").read_text(encoding="utf-8")
assert "TechSyncStatus(" not in body, "Background sync must not add a home status card"
assert "TechFreshnessBanner(" not in body, "Diagnostic timestamps belong in details, not home"
assert "TechDataSyncDetailView" in views, "Health settings must link to details"
assert "UserDataNoticePolicy.recommendationNotice" in views
assert "!native.canConfirmToday" in views, "Stale suggestions cannot be confirmed"
native_root = (root.parents[1] / "NativeViews.swift").read_text(encoding="utf-8")
assert "TechRequestFailure(" not in native_root, "Background refresh failure must not present a modal"
row = views[views.index("private func trainingOverview"):views.index("private func todayHero")]
assert "HStack(alignment: .top" in row
assert "typeSize >= .xxxLarge" in row and "VStack" in row
assert "verdictPanel(data)" in row and "activityPanel(data)" in row
sync = (root / "TechSyncStatus.swift").read_text(encoding="utf-8")
assert ".disabled(sync.isBusy || !session.isReachable)" in sync
assert ".foregroundStyle(sync.isBusy || !session.isReachable ? TechColor.muted : TechColor.cyan)" in sync
assert "var showsHistory = true" in sync, "Settings must retain sync history"
assert "showsHistory || state == .busy || state == .failed || state == .cancelled" in sync
recovery = (root / "TechTodayRecovery.swift").read_text(encoding="utf-8")
assert 'icon: "heart.fill", color: TechColor.coral' in recovery
assert 'icon: "waveform.path.ecg", color: TechColor.success' in recovery
print("Today layout checks passed (order, paired summaries, sync visibility, recovery icons)")

assert views.count('.frame(height: typeSize >= .xxxLarge ? nil : 112, alignment: .topLeading)') == 2
assert 'if let series, series.showsPlanSegments' in views
assert 'segmentPanel(series)\n                    } else {\n                        splitPanel(' in views, "Plan steps and kilometer splits are mutually exclusive"
# 实参不钉：2026-10-02 起分段面板接收整个 series（要读 grade 汇总），
# 钉的是「两个分支互斥」这一行为，而不是某个实参写法。
# Observed environment fields now live in the summary, without a second adjusted pace.
for field in ("weatherCondition", "temperatureC", "humidityPercent"):
    assert f"workout.environment?.{field}" in views, f"摘要必须读取真实环境字段：{field}"
assert "environmentPanel(" not in views, "独立环境卡片已移除"
# `WorkoutEnvironmentView` 的两项**契约硬要求**：`reasonCodes` 是 "Codes the UI renders"
# （packages/contracts/src/index.ts:1651），`applied`/`unavailable` "must stay distinguishable
# in the UI"（apps/ios/RAI/NativeFormat.swift 的 nativeEnvironmentReason 文档注释）。
# 它们曾经只活在已删除的 environmentPanel 里 ⇒ 删面板就等于没人渲染。以下三条钉住"必须有入口"。
assert "environment.reasonCodes.map(nativeEnvironmentReason)" in views, "环境理由码必须被渲染"
assert "nativeEnvironmentStatus(environment.status)" in views, "环境修正三态必须可见"
assert "workout.environment?.adjusted" in views, "环境等效量必须仍有入口"
chart = (root / "TechSeriesChart.swift").read_text(encoding="utf-8")
assert '.chartXAxisLabel("min")' in chart and '.chartXAxisLabel("秒")' not in chart
assert 'point.offsetSeconds / 60' in chart and 'selected.offsetSeconds / 60' in chart
assert 'proxy.value(atX:' in chart and '.onTapGesture { location in' in chart
assert 'moveSelection' not in chart and 'chartIdentifier).next' not in chart and 'chartIdentifier).previous' not in chart
assert '.accessibilityAdjustableAction' in chart and 'case .increment: adjustSelection(1)' in chart \
    and 'case .decrement: adjustSelection(-1)' in chart, "VoiceOver must move through chart samples"
for action in ('上一点', '下一点'):
    assert f'.accessibilityAction(named: "{action}")' in chart, "Each chart must expose accessible point actions"
assert 'selectedTime = techSeriesSelectionTime(' in chart and '.accessibilityValue(accessibilityValue)' in chart, \
    "Chart accessibility must update selection and announce the selected sample"
route = (root / "TechRouteView.swift").read_text(encoding="utf-8")
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
assert 'triggerFit: fitRequest, isInteractive: mapInteractive)' in route, \
    "解锁状态必须从 SwiftUI 传到 UIKit 层"
for key in ('map.isScrollEnabled = isInteractive', 'map.isZoomEnabled = isInteractive'):
    assert key in route, f"解锁状态必须真正驱动高德手势开关，缺少：{key}"
print("Compact card heights, minute chart coordinates, structured steps, map consent and map gesture lock checks passed")

detail = views[views.index("struct TechWorkoutDetailView"):views.index("struct TechAnalysisView")]
composition = detail[:detail.index("private func detailOverview")]
ordered = ["routePanel(detail, series: series)",
           "detailOverview(detail, grade: series?.grade)", "seriesPanels(series,", "splitPanel(series)",
           "qualityPanel(detail)"]
positions = [composition.index(call) for call in ordered]
assert positions == sorted(positions), "The route and summary must lead the vertically stacked metrics"
assert "LazyVStack" in composition, "Offscreen charts must not all prepare on opening a workout"
assert "selectedMetric" not in detail and "TechFilterChips" not in detail, "Metrics no longer require switching"
assert "ForEach(TechWorkoutMetric.allCases)" in detail, "All chart sections must actually render"
assert '"平均等强配速", value: grade?.gradeAdjustedPaceSecondsPerKm.map' in detail, \
    "The summary must use the server's distance-weighted grade-adjusted pace, not the weather adjustment"
splits = detail[detail.index("private func splitPanel"):detail.index("private func qualityPanel")]
assert "gradeAdjustedPaceSecondsPerKm" not in splits and "等强" not in splits, \
    "Adjusted pace belongs only in the summary, never the kilometer rows"
assert '.automatic(includesZero: false, reversed: isPace)' in chart, "Faster pace must be higher on the chart"
assert 'chartIdentifier).selection' in chart, "Each chart keeps independent tap inspection"
assert 'trainingLoadPanel(' not in detail and 'zonePanel(' not in detail, "负荷与心率区间不得有重复卡片"
overview = detail[detail.index("private func detailOverview"):detail.index("private func overviewMetric")]
assert 'if summaryExpanded' in overview and 'detailMetrics(workout)' in overview and '.onTapGesture' in overview, \
    "整张摘要可点击展开全部指标"
collapsed = overview.split("if summaryExpanded", 1)[0]
assert 'detailMetrics(workout)' not in collapsed and '全部训练指标' not in collapsed, \
    "完整训练指标必须留到点击展开后"
assert '@State private var summaryExpanded = false' in detail and 'summaryExpanded = false\n' in composition, \
    "训练详情初次展示和切换训练时必须默认收起全部指标"
assert 'detailMetrics(' not in composition and '全部训练指标' not in composition, "底部不再有全部指标入口"
assert 'TechWorkoutShareMenu(detail: detail, grade:' in detail, "分享必须从训练详情右上角入口提供"
# `TechShareCardView` 已在 2026-10-05 重命名为 `TechWorkoutShareSheet`，旧名全仓不再出现 ——
# 只断言旧名 `not in` 会**恒真**（实测：往详情页插回内联分享卡片，门禁仍全绿）。
# 所以锚点必须跟着类型名走，并加一条守卫：被锚的名字真的存在；下次再改名时这里先红，
# 而不是让 `not in` 静默退化成"检查一个不存在的字符串"。
share_source = (root / "TechShareCardView.swift").read_text(encoding="utf-8")
# 用 `\b` 词边界，不用裸 `in "struct TechWorkoutShareSheet"` —— 子串匹配会被
# `struct TechWorkoutShareSheetRenamed` 这类改名绕过（2026-10-05 突变验证实测）。
assert re.search(r"\bstruct TechWorkoutShareSheet\b", share_source), \
    "分享卡片类型已改名：请同步下面的内联挂载锚点，否则 `not in` 会恒真"
for inline_mount in ("TechWorkoutShareSheet(", "TechShareCardView("):
    assert inline_mount not in detail, f"训练详情滚动内容不应再挂载分享卡片：{inline_mount}"
share = (root / "TechShareCardView.swift").read_text(encoding="utf-8")
assert 'showingShareSheet' in share and '.sheet(isPresented: $showingShareSheet)' in share, \
    "右上角分享必须直接打开单一训练分享卡片"
assert 'Button("高德地图卡片"' not in share and 'Button("训练摘要卡片"' not in share, \
    "地图与训练摘要不能再作为两个独立分享选项"
assert 'TechWorkoutCombinedShareImage' in share and 'detail: detail, grade: grade, card: card, snapshot: snapshot' in share, \
    "地图和训练摘要必须由同一个图片视图合成"
assert share.count('ShareLink(') == 1 and 'Text("路线")' in share and 'Text("训练摘要")' in share, \
    "组合卡片必须包含路线与训练摘要，并且只提供一个分享对象"
assert 'ShareLink(item: item, preview: SharePreview' in share, "分享必须发送图片，而不是纯文字"
assert 'native.feedbackSessionID' in share and 'key == requestKey' in share, "分享不得使用旧服务或旧会话的异步结果"
assert 'polylines: card.polylines' in share, "地图分享只使用服务端隐私裁剪路线"
assert 'state == 1' in route and 'map.takeSnapshot(in:' in route, "高德底图未完成加载不能生成地图卡片"
assert 'techShareRoutePolylinesForRendering(polylines)' in route, "地图分享必须保留隐私裁剪断点"
assert '个有效样本' not in chart and '个峰谷采样点' not in chart, "训练时序不再显示采样统计尾注"
assert 'trainingEffectPanel(detail)' in detail, "训练详情必须展示训练效果卡片"
effect = detail[detail.index('private func trainingEffectPanel'):detail.index('private func trainingEffectTint')]
assert 'techWorkoutPrimaryStimulusScore(zones)' in effect and 'stimulusScores.max' not in effect, \
    "The primary stimulus must preserve the server verdict, including unclassified"
assert 'primaryType == "unclassified"' in effect and '本次训练刺激未分类' in effect, \
    "Unclassified training needs an explicit display instead of an inferred stimulus"
assert 'TechMetricTile(' not in detail[detail.index("private func detailMetrics"):detail.index("private func routePanel")], \
    "Expanded summary metrics must not nest cards inside the summary card"
assert 'splits: series?.splits ?? []' in detail, "Kilometer markers must update when server splits arrive"
assert 'kilometerMarkers: geometry.kilometerMarkers' in route and 'kilometerMarkers: kilometerMarkers' in route
assert 'for (index, marker) in geometry.kilometerMarkers.enumerated()' in route and 'for (index, badge) in kilometerBadges.enumerated()' in route, \
    "Both offline trace and interactive map must render the kilometer markers"
assert route.count('techRouteMarkerFrames(') == 2, "Both map renderers must separate overlapping lap markers"
assert route.count('techRouteMarkerLeader(') == 2 and 'kilometerLeaders.path = leaders.cgPath' in route \
    and 'context.stroke(leaders,' in route, "Both renderers must link displaced labels to their GPS anchors"
assert '$0.timestamp == $1.timestamp' in route and 'lhs.splits.elementsEqual(rhs.splits)' in route, \
    "Map caching must include timestamps and split boundaries"
# 起终点标记：离线路迹与交互地图必须画同一种形状。2026-10-05 之前一处是方点
# （`Path(CGRect(...))`）、一处是圆点（`UIBezierPath(ovalIn:)`）—— 同一张路线图两种渲染。
assert 'Path(ellipseIn: CGRect(x: point.x - 5, y: point.y - 5, width: 10, height: 10))' in route, \
    "离线轨迹的起终点必须是圆点，与交互地图一致"
assert 'UIBezierPath(ovalIn: CGRect(x: $0.x - 5, y: $0.y - 5, width: 10, height: 10))' in route, \
    "交互地图的起终点必须是圆点"
# `TechShareRouteMapContainer` 不在类型检查覆盖内（`typecheck-ios.sh` 排除 `TechRouteView.swift`），
# 所以这些"改错了照样编译通过、肉眼也看不出来"的守卫只能靠文本判据钉住。
for pinned in ['fitAttempts < 12', 'Self.maxSnapshotAttempts', 'self.stopped', 'MapPrivacy.mapEnabled',
               'map.takeSnapshot(in:', 'state == 1', 'techShareRoutePolylinesForRendering(polylines)']:
    assert pinned in route, f"分享地图的关键守卫丢失：{pinned}"
print("Workout detail layout checks passed (expandable weather summary, no duplicate panels, tap charts, kilometer markers)")
