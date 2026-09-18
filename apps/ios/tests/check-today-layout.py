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
assert "TechSyncStatus(showsHistory: false)" in body
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
chart = (root / "TechSeriesChart.swift").read_text()
assert '.chartXAxisLabel("min")' in chart and '.chartXAxisLabel("秒")' not in chart
assert 'point.offsetSeconds / 60' in chart and 'selected.offsetSeconds / 60' in chart
assert 'selectedTime = data.points[index].offsetSeconds / 60' in chart
route = (root / "TechRouteView.swift").read_text()
assert '@State private var showingSystemMap = true' in route
assert 'else if showingSystemMap, mapAllowed' in route
print("Compact card heights, minute chart coordinates, structured steps and map consent checks passed")
