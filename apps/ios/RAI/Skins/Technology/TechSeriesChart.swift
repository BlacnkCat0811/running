#if os(iOS)
import Charts
import SwiftUI

/// Equatable input boundary prevents unrelated detail-page changes from
/// rebuilding the sorted / sampled series. Selection state lives below it.
struct TechSeriesChart: View, Equatable {
    let metric: MetricSeries
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.metric.unit == rhs.metric.unit
            && lhs.metric.points.elementsEqual(rhs.metric.points) {
                $0.offsetSeconds == $1.offsetSeconds && $0.value == $1.value
            }
    }
    var body: some View {
        TechPreparedSeriesChart(data: TechSeriesData(points: metric.points), unit: metric.unit)
    }
}

struct TechHeartRateChart: View, Equatable {
    let metric: MetricSeries
    let averageHeartRate: Double?
    let durationSeconds: Double
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.averageHeartRate == rhs.averageHeartRate && lhs.durationSeconds == rhs.durationSeconds
            && TechSeriesChart(metric: lhs.metric) == TechSeriesChart(metric: rhs.metric)
    }
    var body: some View {
        let data = TechSeriesData(points: metric.points.filter { $0.value > 0 })
        VStack(alignment: .leading, spacing: 16) {
            Label("心率", systemImage: "heart").font(.subheadline.weight(.medium)).foregroundStyle(TechColor.coral)
            TechMetricGrid(minimum: 140) {
                TechMetricTile(title: "平均心率", value: "\(nativeNumber(averageHeartRate, digits: 0)) bpm")
                TechMetricTile(title: "最大心率", value: "\(nativeNumber(data.maximum, digits: 0)) bpm")
            }
            TechPreparedSeriesChart(data: data, unit: "bpm", durationSeconds: durationSeconds,
                                    chartIdentifier: "workout.heartRate.chart")
        }
    }
}

private struct TechPreparedSeriesChart: View {
    let data: TechSeriesData
    let unit: String
    var durationSeconds: Double = 0
    var chartIdentifier = "workout.series.chart"
    @ScaledMetric(relativeTo: .caption) private var height: CGFloat = 190
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var selectedTime: Double?

    private var selected: MetricPoint? {
        guard let selectedTime else { return nil }
        return data.points.min { abs($0.offsetSeconds / 60 - selectedTime) < abs($1.offsetSeconds / 60 - selectedTime) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if data.points.isEmpty {
                Text("暂无有效样本").font(.footnote).foregroundStyle(TechColor.muted)
            } else {
                Chart {
                    ForEach(data.points) { point in
                        LineMark(x: .value("时间 (min)", point.offsetSeconds / 60), y: .value(unit, point.value))
                            .foregroundStyle(TechColor.cyan).interpolationMethod(.linear)
                        if data.points.count == 1 {
                            PointMark(x: .value("时间 (min)", point.offsetSeconds / 60), y: .value(unit, point.value))
                                .foregroundStyle(TechColor.cyan)
                        }
                    }
                    if let selected {
                        RuleMark(x: .value("选中时间 (min)", selected.offsetSeconds / 60))
                            .foregroundStyle(TechColor.muted).lineStyle(StrokeStyle(lineWidth: 1, dash: [4]))
                        PointMark(x: .value("时间 (min)", selected.offsetSeconds / 60), y: .value(unit, selected.value))
                            .foregroundStyle(TechColor.ink)
                    }
                }
                .chartXScale(domain: 0...max(1.0 / 60, durationSeconds.isFinite ? durationSeconds / 60 : 0,
                                           (data.points.last?.offsetSeconds ?? 0) / 60))
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: typeSize.isAccessibilitySize ? 2 : 4)) {
                        AxisValueLabel().foregroundStyle(TechColor.muted)
                        AxisGridLine().foregroundStyle(TechColor.grid)
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) {
                        AxisValueLabel().foregroundStyle(TechColor.muted)
                        AxisGridLine().foregroundStyle(TechColor.grid)
                    }
                }
                .chartXAxisLabel("min").chartYAxisLabel(unit)
                .frame(height: height)
                .chartOverlay { proxy in
                    GeometryReader { geometry in
                        Color.clear.contentShape(Rectangle())
                            .onTapGesture { location in
                                guard let plotFrame = proxy.plotFrame else { return }
                                let frame = geometry[plotFrame]
                                guard frame.contains(location) else { return }
                                selectedTime = proxy.value(atX: location.x - frame.minX, as: Double.self)
                            }
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("训练时序，\(data.validCount) 个有效采样时刻")
                .accessibilityValue("最低 \(nativeNumber(data.minimum))，最高 \(nativeNumber(data.maximum)) \(unit)")
                .accessibilityIdentifier(chartIdentifier)

                if let selected {
                    Text("\(nativeNumber(selected.offsetSeconds / 60, digits: 1) + " min") · \(nativeNumber(selected.value)) \(unit)")
                        .font(.subheadline.monospacedDigit()).foregroundStyle(TechColor.ink)
                        .accessibilityIdentifier("workout.series.selection")
                }
                Text(data.validCount > data.points.count
                     ? "显示 \(data.points.count) 个峰谷采样点，原始数据不变。轻点图表查看。"
                     : "轻点图表查看数值，上下滑动浏览页面。")
                    .font(.caption).foregroundStyle(TechColor.muted)
                HStack {
                    Button { moveSelection(-1) } label: { Text("上一点").frame(minWidth: 44, minHeight: 44) }
                        .accessibilityIdentifier("workout.series.previous")
                    Spacer()
                    Button { moveSelection(1) } label: { Text("下一点").frame(minWidth: 44, minHeight: 44) }
                        .accessibilityIdentifier("workout.series.next")
                }
                .font(.subheadline).foregroundStyle(TechColor.cyan).buttonStyle(TechPressStyle())
                .frame(minHeight: 44)
            }
        }
    }

    private func moveSelection(_ direction: Int) {
        guard !data.points.isEmpty else { return }
        let current = selected.flatMap { point in data.points.firstIndex { $0.offsetSeconds == point.offsetSeconds } }
        let index = current.map { min(max($0 + direction, 0), data.points.count - 1) } ?? 0
        selectedTime = data.points[index].offsetSeconds / 60
    }
}
#endif
