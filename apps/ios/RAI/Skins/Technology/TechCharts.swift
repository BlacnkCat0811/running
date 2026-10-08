#if os(iOS)
import Charts
import SwiftUI

struct TechRing: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let progress: Double
    let value: String
    let label: String
    var tint: Color = TechColor.cyan
    var size: CGFloat = 88
    var detail: String? = nil
    var body: some View {
        if typeSize >= .xxxLarge && (!value.isEmpty || !label.isEmpty) {
            VStack(alignment: .leading, spacing: 8) {
                Text(value).font(.title2.weight(.semibold)).monospacedDigit().foregroundStyle(TechColor.ink)
                Text(label).font(.caption).foregroundStyle(TechColor.muted)
                if let detail { Text(detail).font(.caption).foregroundStyle(TechColor.cyan) }
                TechProgressBar(fraction: progress, tint: tint).accessibilityHidden(true)
            }.accessibilityElement(children: .combine)
        } else { graphic }
    }
    private var graphic: some View {
        ZStack {
            // Track ring: a *closed* circle, so `lineCap` would be ignored anyway
            // (a closed subpath has no endpoints). Not passing it keeps the code
            // honest about which strokes actually need a round cap.
            Circle().stroke(TechColor.grid.opacity(0.6), lineWidth: size * 0.10)
            Circle().trim(from: 0, to: progress.isFinite ? min(max(progress, 0), 1) : 0)
                .stroke(tint, style: StrokeStyle(lineWidth: size * 0.10, lineCap: .round))
                .rotationEffect(.degrees(-90))
            VStack(spacing: 4) {
                Text(value).font(.system(.title3, design: .default).weight(.semibold).monospacedDigit())
                    .foregroundStyle(TechColor.ink).lineLimit(1).minimumScaleFactor(0.6)
                Text(label).font(.caption2).foregroundStyle(TechColor.muted)
                if let detail {
                    Text(detail).font(.caption2).monospacedDigit().foregroundStyle(TechColor.cyan)
                        .lineLimit(1).minimumScaleFactor(0.7)
                }
            }.padding(10)
        }.frame(width: size, height: size)
            .accessibilityElement(children: .ignore).accessibilityLabel("\(label) \(value)" + (detail.map { "，" + $0 } ?? ""))
    }
}

/// Decorative concentric instrument, separate from the data-bearing progress arc.
struct TechInstrumentRing: View {
    let progress: Double
    var size: CGFloat = 124
    var body: some View {
        ZStack {
            Circle().stroke(TechColor.grid.opacity(0.55), lineWidth: 1)
            Circle().stroke(TechColor.grid.opacity(0.18), lineWidth: size * 0.17)
                .frame(width: size * 0.80, height: size * 0.80)
            // Closed concentric ring — see the note on `TechRing.graphic` above.
            Circle().stroke(TechColor.grid.opacity(0.6), lineWidth: size * 0.085)
                .frame(width: size * 0.80, height: size * 0.80)
            Circle().trim(from: 0, to: progress.isFinite ? min(max(progress, 0), 1) : 0)
                .stroke(TechColor.cyan, style: StrokeStyle(lineWidth: size * 0.085, lineCap: .round))
                .frame(width: size * 0.80, height: size * 0.80)
                .rotationEffect(.degrees(-90))
            Circle().fill(TechColor.background)
                .frame(width: size * 0.51, height: size * 0.51)
            Circle().stroke(TechColor.grid.opacity(0.65), lineWidth: 1)
                .frame(width: size * 0.52, height: size * 0.52)
            TechRunnerIcon(color: TechColor.ink, size: size * 0.33)
        }.frame(width: size, height: size).accessibilityHidden(true)
    }
}

struct TechGauge: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let progress: Double
    let value: String
    let label: String
    var size: CGFloat = 82
    var body: some View {
        if typeSize >= .xxxLarge {
            TechMetricTile(title: label, value: value, accent: TechColor.cyan)
        } else { graphic }
    }
    private var graphic: some View {
        ZStack {
            Circle().trim(from: 0, to: 0.75)
                .stroke(TechColor.grid, style: StrokeStyle(lineWidth: 7, lineCap: .round))
                .rotationEffect(.degrees(135))
            Circle().trim(from: 0, to: 0.75 * (progress.isFinite ? min(max(progress, 0), 1) : 0))
                .stroke(TechColor.energy, style: StrokeStyle(lineWidth: 7, lineCap: .round))
                .rotationEffect(.degrees(135))
            VStack(spacing: 4) {
                Text(value).font(.title3.weight(.semibold)).monospacedDigit().foregroundStyle(TechColor.ink)
                Text(label).font(.caption2).foregroundStyle(TechColor.cyan)
                    .multilineTextAlignment(.center).lineLimit(2).minimumScaleFactor(0.7)
            }.padding(7)
        }.frame(width: size, height: size)
            .accessibilityElement(children: .ignore).accessibilityLabel("\(label) \(value)")
    }
}

struct TechAbilityGauge: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let progress: Double
    var value: String
    var caption: String
    var size: CGFloat = 190
    var lineWidth: CGFloat = 12

    private var filled: Double { progress.isFinite ? min(max(progress, 0), 1) : 0 }
    private var lowerClearance: CGFloat { 6 }
    private var stroke: StrokeStyle { StrokeStyle(lineWidth: lineWidth, lineCap: .round) }
    /// Stroke is centered on the path. Inset by half the line width so the
    /// stroke stays inside `size`; otherwise `.clipped()` shears it off.
    private var inset: CGFloat { lineWidth / 2 }
    private var radius: CGFloat { (size - lineWidth) / 2 }
    private var bottomOverflow: CGFloat { inset + lowerClearance }
    private var arcHeight: CGFloat { size / 2 + bottomOverflow }

    var body: some View {
        VStack(spacing: 2) {
            ZStack {
                // `trim(0...0.5)` sweeps the lower half from 3 o'clock; flipping
                // the arc alone lifts it into the upper half without also
                // flipping the segment ticks, which are already placed on top.
                ZStack {
                    Circle().trim(from: 0, to: 0.5)
                        .stroke(TechColor.grid.opacity(0.55), style: stroke)
                    if filled > 0 {
                        Circle().trim(from: 0, to: 0.5 * filled)
                            .stroke(TechColor.energy, style: stroke)
                    }
                }
                .rotationEffect(.degrees(180))
                .padding(inset)
                ForEach([-72.0, -36, 0, 36, 72], id: \.self) { angle in
                    TechSurfaceShape().fill(TechColor.paper)
                        .frame(width: lineWidth * 0.22, height: lineWidth * 1.24)
                        .offset(y: -radius)
                        .rotationEffect(.degrees(angle))
                }
            }
            .frame(width: size, height: size)
            .frame(height: arcHeight, alignment: .top)
            .clipped()
            .overlay(alignment: .bottom) {
                if !typeSize.isAccessibilitySize && (!value.isEmpty || !caption.isEmpty) {
                    VStack(spacing: 3) {
                        if !value.isEmpty {
                            Text(value)
                                .font(.system(size: size * 0.2, weight: .heavy)).monospacedDigit()
                                .foregroundStyle(TechColor.ink).lineLimit(1).minimumScaleFactor(0.55)
                        }
                        if !caption.isEmpty {
                            Text(caption).font(.caption2).foregroundStyle(TechColor.muted)
                                .lineLimit(1).minimumScaleFactor(0.7)
                        }
                    }
                    .padding(.bottom, bottomOverflow)
                    .padding(.horizontal, lineWidth * 2)
                }
            }
            if typeSize.isAccessibilitySize && !value.isEmpty {
                Text(value).font(.title.weight(.bold)).monospacedDigit().foregroundStyle(TechColor.ink)
                Text(caption).font(.caption).foregroundStyle(TechColor.muted)
            }
            HStack {
                Text("0")
                Spacer(minLength: 0)
                Text("100")
            }
            .font(.caption2).foregroundStyle(TechColor.muted)
            .frame(width: size - lineWidth)
        }
        .frame(width: size)
        .accessibilityHidden(true)
    }
}

struct TechWeekBars: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .caption) private var chartScale: CGFloat = 1
    let points: [WeekDailyPoint]
    let today: String
    var body: some View {
        Chart(points) { point in
            BarMark(x: .value("日期", nativeWeekday(point.localDate)), y: .value("公里", point.distanceKm), width: .ratio(0.45))
                .foregroundStyle(TechColor.energy).cornerRadius(4)
        }
        .chartXAxis {
            AxisMarks(values: points.enumerated().filter {
                !typeSize.isAccessibilitySize || $0.offset % 3 == 0
            }.map { nativeWeekday($0.element.localDate) }) {
                AxisValueLabel().foregroundStyle(TechColor.muted)
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading) {
                AxisGridLine().foregroundStyle(TechColor.grid.opacity(0.45))
                AxisValueLabel().foregroundStyle(TechColor.muted)
            }
        }
        .chartYAxisLabel("km")
        .chartYScale(domain: 0...max((points.map(\.distanceKm).max() ?? 0) * 1.15, 1))
        .frame(height: 170 * chartScale)
        .overlay {
            if points.allSatisfy({ $0.distanceKm == 0 }) {
                Text("本周暂无里程").font(.footnote).foregroundStyle(TechColor.muted)
            }
        }
        .accessibilityLabel("本周每日跑量")
    }
}

struct TechMiniBars: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .caption) private var chartScale: CGFloat = 1
    let values: [Double]
    let labels: [String]
    let colors: [Color]
    var height: CGFloat = 180
    var body: some View {
        Chart {
            ForEach(values.indices, id: \.self) { index in
                // A ratio width needs a categorical scale step. Integer X values
                // form a continuous scale and can collapse these bars to zero width.
                BarMark(x: .value("周期", String(index)), y: .value("公里", values[index]), width: .ratio(0.58))
                    .foregroundStyle(colors.indices.contains(index) ? colors[index] : TechColor.cyan)
                    .cornerRadius(4)
            }
        }
        .chartXAxis {
            AxisMarks(values: Array(values.indices).filter { $0 % max(1, values.count / (typeSize.isAccessibilitySize ? 2 : 4)) == 0 }.map(String.init)) { axis in
                AxisValueLabel {
                    if let key = axis.as(String.self), let index = Int(key), labels.indices.contains(index) {
                        Text(labels[index]).font(.caption2)
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading) {
                AxisGridLine().foregroundStyle(TechColor.grid.opacity(0.45))
                AxisValueLabel().foregroundStyle(TechColor.muted)
            }
        }
        .chartYAxisLabel("km")
        .frame(height: height * chartScale)
    }
}

struct TechLineChart: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .caption) private var chartScale: CGFloat = 1
    let values: [Double]
    let labels: [String]
    var tint: Color = TechColor.cyan
    var height: CGFloat = 170
    private var lowerBound: Double { max(0, (values.filter(\.isFinite).min() ?? 0) - 5) }
    private var upperBound: Double { max(lowerBound + 10, (values.filter(\.isFinite).max() ?? 0) + 5) }
    var body: some View {
        let low = lowerBound
        let high = upperBound
        let displayed = TechPlotSampling.indices(values: values, limit: 240)
        Chart {
            ForEach(displayed, id: \.self) { index in
                LineMark(x: .value("周期", index), y: .value("跑力", values[index]))
                    .foregroundStyle(tint).interpolationMethod(.monotone)
                    .lineStyle(StrokeStyle(lineWidth: 2))
                if index % max(1, values.count / 8) == 0 || index == values.count - 1 {
                    PointMark(x: .value("周期", index), y: .value("跑力", values[index]))
                        .foregroundStyle(tint).symbolSize(22)
                }
                AreaMark(x: .value("周期", index), yStart: .value("基线", low), yEnd: .value("跑力", values[index]))
                    .foregroundStyle(tint.opacity(0.08))
                    .interpolationMethod(.monotone)
            }
        }
        .chartXAxis {
            AxisMarks(values: Array(values.indices).filter { $0 % max(1, values.count / (typeSize.isAccessibilitySize ? 2 : 4)) == 0 }) { axis in
                AxisValueLabel {
                    if let index = axis.as(Int.self), labels.indices.contains(index) { Text(labels[index]).font(.caption2) }
                }
            }
        }
        .chartYScale(domain: low...high)
        .chartYAxis {
            AxisMarks(position: .leading) {
                AxisGridLine().foregroundStyle(TechColor.grid.opacity(0.45))
                AxisValueLabel().foregroundStyle(TechColor.muted)
            }
        }
        .frame(height: height * chartScale)
        .accessibilityLabel("跑力评估趋势")
        .accessibilityValue("\(values.count) 次评估，最低 \(nativeNumber(values.filter(\.isFinite).min()))，最高 \(nativeNumber(values.filter(\.isFinite).max()))")
    }
}

struct TechMonthChart: View {
    @ScaledMetric(relativeTo: .caption) private var chartScale: CGFloat = 1
    let months: [MonthSummary]
    var body: some View {
        Chart(months) { month in
            BarMark(x: .value("月份", month.month), y: .value("公里", month.runningDistanceKm), width: .ratio(0.48))
                .foregroundStyle(by: .value("运动", "跑步"))
            BarMark(x: .value("月份", month.month), y: .value("公里", month.cyclingDistanceKm), width: .ratio(0.48))
                .foregroundStyle(by: .value("运动", "骑行"))
            BarMark(x: .value("月份", month.month), y: .value("公里", month.otherDistanceKm), width: .ratio(0.48))
                .foregroundStyle(by: .value("运动", "其他"))
                .annotation(position: .top) {
                    Text(nativeNumber(month.totalDistanceKm)).font(.caption2).foregroundStyle(TechColor.ink)
                }
        }
        .chartForegroundStyleScale(["跑步": TechColor.cyan, "骑行": TechColor.leaf, "其他": TechColor.muted])
        .chartXAxis {
            AxisMarks { axis in
                AxisValueLabel {
                    if let month = axis.as(String.self), let number = Int(month.suffix(2)) {
                        Text("\(number)月").font(.caption).foregroundStyle(TechColor.muted)
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading) {
                AxisGridLine().foregroundStyle(TechColor.grid.opacity(0.45))
                AxisValueLabel().foregroundStyle(TechColor.muted)
            }
        }
        .frame(height: 220 * chartScale)
    }
}
#endif
