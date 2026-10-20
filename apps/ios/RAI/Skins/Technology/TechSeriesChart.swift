#if os(iOS)
import Charts
import SwiftUI

/// Equatable input boundary prevents unrelated detail-page changes from
/// rebuilding the sorted / sampled series. Selection state lives below it.
struct TechWorkoutSeriesChart: View, Equatable {
    let metric: TechWorkoutMetric
    let series: MetricSeries
    let average: Double?
    let durationSeconds: Double
    /// 空图占位。2026-10-18（事故复盘 P0-3）：`freshness.series[].state == not_seen_yet` 的
    /// 指标是"服务端尚未观察到该指标"（**不**归因 Apple Watch），与"设备没有这项数据"必须
    /// 用不同的话说 —— 旧实现两种情形都渲染成「暂无…时序样本」，于是用户没法判断该等还是该放弃。
    /// 文案由 `WorkoutFreshnessPresentation.emptySeriesPlaceholder` 给出（纯函数、有回归）。
    var emptySeriesNote: String? = nil

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.metric == rhs.metric && lhs.average == rhs.average && lhs.durationSeconds == rhs.durationSeconds
            && lhs.emptySeriesNote == rhs.emptySeriesNote
            && lhs.series.unit == rhs.series.unit && lhs.series.totalSamples == rhs.series.totalSamples
            && lhs.series.points.elementsEqual(rhs.series.points) {
                $0.offsetSeconds == $1.offsetSeconds && $0.value == $1.value
            }
    }

    var body: some View {
        TechPreparedWorkoutSeriesChart(metric: metric, data: TechSeriesData(points: metric.chartSeries(from: series).points),
                                       average: average, durationSeconds: durationSeconds,
                                       emptySeriesNote: emptySeriesNote)
    }
}

private struct TechPreparedWorkoutSeriesChart: View {
    let metric: TechWorkoutMetric
    let data: TechSeriesData
    let average: Double?
    let durationSeconds: Double
    var emptySeriesNote: String? = nil

    private var accent: Color {
        switch metric {
        case .pace: return TechColor.blue
        case .heartRate: return TechColor.coral
        case .power: return TechColor.yellow
        case .elevation: return TechColor.leaf
        default: return TechColor.cyan
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TechSectionHeader(title: metric.title,
                              trailing: metric == .elevation ? metric.unit : "平均 \(value(average))",
                              trailingColor: accent)
            if data.validCount > 0 {
                HStack {
                    Text("\(metric == .pace ? "最快" : "最低") \(value(data.minimum))")
                    Spacer(minLength: 8)
                    Text("\(metric == .pace ? "最慢" : "最高") \(value(data.maximum))")
                }
                .font(.caption.monospacedDigit()).foregroundStyle(TechColor.muted)
            }
            if data.points.isEmpty {
                Text(emptySeriesNote ?? "暂无\(metric.title)时序样本")
                    .font(.footnote).foregroundStyle(TechColor.muted)
                    .frame(maxWidth: .infinity, minHeight: 72)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                TechPreparedSeriesChart(data: data, unit: metric.unit, durationSeconds: durationSeconds,
                                        chartIdentifier: "workout.series.\(metric.rawValue)",
                                        accent: accent, isPace: metric == .pace, digits: metric.digits,
                                        metricTitle: metric.title)
            }
        }
    }

    private func value(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "--" }
        return metric == .pace ? "\(techPace(value))/km" : "\(nativeNumber(value, digits: metric.digits)) \(metric.unit)"
    }
}

private struct TechPreparedSeriesChart: View {
    let data: TechSeriesData
    let unit: String
    var durationSeconds: Double = 0
    var chartIdentifier = "workout.series.chart"
    var accent: Color = TechColor.cyan
    var isPace = false
    var digits = 1
    var metricTitle = "训练"
    @ScaledMetric(relativeTo: .caption) private var height: CGFloat = 190
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var selectedTime: Double?

    private var selected: MetricPoint? {
        guard let selectedTime else { return nil }
        return data.points.min { abs($0.offsetSeconds / 60 - selectedTime) < abs($1.offsetSeconds / 60 - selectedTime) }
    }

    private var accessibilityValue: String {
        if let selected {
            return "\(nativeNumber(selected.offsetSeconds / 60, digits: 1)) min，\(formatted(selected.value)) \(isPace ? "/km" : unit)"
        }
        return "\(isPace ? "最快" : "最低") \(data.minimum.map(formatted) ?? "--")，\(isPace ? "最慢" : "最高") \(data.maximum.map(formatted) ?? "--") \(isPace ? "/km" : unit)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if data.points.isEmpty {
                Text("暂无有效样本").font(.footnote).foregroundStyle(TechColor.muted)
            } else {
                Chart {
                    ForEach(data.points) { point in
                        LineMark(x: .value("时间 (min)", point.offsetSeconds / 60), y: .value(unit, point.value))
                            .foregroundStyle(accent).interpolationMethod(.linear)
                            .lineStyle(StrokeStyle(lineWidth: 2))
                        if data.points.count == 1 {
                            PointMark(x: .value("时间 (min)", point.offsetSeconds / 60), y: .value(unit, point.value))
                                .foregroundStyle(accent)
                        }
                    }
                    if let selected {
                        RuleMark(x: .value("选中时间 (min)", selected.offsetSeconds / 60))
                            .foregroundStyle(TechColor.muted).lineStyle(StrokeStyle(lineWidth: 1, dash: [4]))
                        PointMark(x: .value("时间 (min)", selected.offsetSeconds / 60), y: .value(unit, selected.value))
                            .foregroundStyle(TechColor.ink)
                            .symbolSize(42)
                    }
                }
                .chartXScale(domain: 0...max(1.0 / 60, durationSeconds.isFinite ? durationSeconds / 60 : 0,
                                           (data.points.last?.offsetSeconds ?? 0) / 60))
                .chartYScale(domain: .automatic(includesZero: false, reversed: isPace))
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: typeSize.isAccessibilitySize ? 2 : 4)) {
                        AxisValueLabel().foregroundStyle(TechColor.muted)
                        AxisGridLine().foregroundStyle(TechColor.grid.opacity(0.45))
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { axis in
                        AxisValueLabel {
                            if let value = axis.as(Double.self) {
                                Text(formatted(value)).foregroundStyle(TechColor.muted)
                            }
                        }
                        AxisGridLine().foregroundStyle(TechColor.grid.opacity(0.45))
                    }
                }
                .chartXAxisLabel("min").chartYAxisLabel(isPace ? "min/km" : unit)
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
                .accessibilityLabel("\(metricTitle)时序")
                .accessibilityValue(accessibilityValue)
                .accessibilityAdjustableAction { direction in
                    switch direction {
                    case .increment: adjustSelection(1)
                    case .decrement: adjustSelection(-1)
                    @unknown default: break
                    }
                }
                .accessibilityAction(named: "上一点") { adjustSelection(-1) }
                .accessibilityAction(named: "下一点") { adjustSelection(1) }
                .accessibilityIdentifier(chartIdentifier)

                if let selected {
                    Text("\(nativeNumber(selected.offsetSeconds / 60, digits: 1) + " min") · \(formatted(selected.value)) \(isPace ? "/km" : unit)")
                        .font(.subheadline.monospacedDigit()).foregroundStyle(TechColor.ink)
                        .accessibilityIdentifier("\(chartIdentifier).selection")
                }
            }
        }
    }

    private func formatted(_ value: Double) -> String {
        isPace ? techPace(value) : nativeNumber(value, digits: digits)
    }

    private func adjustSelection(_ direction: Int) {
        selectedTime = techSeriesSelectionTime(points: data.points, selectedTime: selectedTime, direction: direction)
    }

}
#endif
