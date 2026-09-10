#if os(iOS)
import Charts
import SwiftUI

struct TechRing: View {
    let progress: Double
    let value: String
    let label: String
    var tint: Color = TechColor.cyan
    var size: CGFloat = 88
    var body: some View {
        ZStack {
            Circle().stroke(TechColor.grid.opacity(0.6), lineWidth: size * 0.10)
            Circle().trim(from: 0, to: progress.isFinite ? min(max(progress, 0), 1) : 0)
                .stroke(AngularGradient(colors: [tint, TechColor.blue, TechColor.leaf], center: .center, startAngle: .degrees(0), endAngle: .degrees(360)),
                        style: StrokeStyle(lineWidth: size * 0.10, lineCap: .round))
                .rotationEffect(.degrees(-90))
            VStack(spacing: 4) {
                Text(value).font(.system(.title3, design: .default).weight(.semibold).monospacedDigit())
                    .foregroundStyle(TechColor.ink).lineLimit(1).minimumScaleFactor(0.6)
                Text(label).font(.caption2).foregroundStyle(TechColor.muted)
            }.padding(10)
        }.frame(width: size, height: size)
            .accessibilityElement(children: .ignore).accessibilityLabel("\(label) \(value)")
    }
}

/// Decorative concentric instrument, separate from the data-bearing progress arc.
struct TechInstrumentRing: View {
    let progress: Double
    var size: CGFloat = 124
    var body: some View {
        ZStack {
            Circle().stroke(TechColor.blue.opacity(0.13), lineWidth: 1)
            ForEach(0..<24, id: \.self) { tick in
                Capsule().fill(TechColor.blue.opacity(tick % 3 == 0 ? 0.5 : 0.16))
                    .frame(width: 2, height: tick % 3 == 0 ? 5 : 3)
                    .offset(y: -size * 0.47).rotationEffect(.degrees(Double(tick) * 15))
            }
            Circle().stroke(TechColor.blue.opacity(0.08), lineWidth: size * 0.16)
                .frame(width: size * 0.78, height: size * 0.78)
            TechRing(progress: progress, value: "", label: "", size: size * 0.78)
                .shadow(color: TechColor.blue.opacity(0.5), radius: 5)
            // Instrument accents are decorative, not extra progress or fabricated readings.
            ForEach(0..<8, id: \.self) { tick in
                Circle().fill(tick.isMultiple(of: 2) ? TechColor.cyan.opacity(0.7) : TechColor.blue.opacity(0.35))
                    .frame(width: size * 0.027, height: size * 0.027)
                    .offset(y: -size * 0.39).rotationEffect(.degrees(Double(tick) * 45))
            }
            Circle().fill(TechColor.background)
                .frame(width: size * 0.51, height: size * 0.51)
            Circle().stroke(TechColor.cyan.opacity(0.22), lineWidth: 1)
                .frame(width: size * 0.52, height: size * 0.52)
            TechRunnerIcon(color: TechColor.ink, size: size * 0.33)
        }.frame(width: size, height: size).accessibilityHidden(true)
    }
}

struct TechGauge: View {
    let progress: Double
    let value: String
    let label: String
    var size: CGFloat = 82
    var body: some View {
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
                    .foregroundStyle(LinearGradient(colors: [colors.indices.contains(index) ? colors[index] : TechColor.cyan, TechColor.leaf.opacity(0.4)], startPoint: .top, endPoint: .bottom))
                    .cornerRadius(3)
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
    private var lowerBound: Double { max(0, (values.min() ?? 0) - 5) }
    private var upperBound: Double { max(lowerBound + 10, (values.max() ?? 0) + 5) }
    var body: some View {
        Chart {
            ForEach(values.indices, id: \.self) { index in
                LineMark(x: .value("周期", index), y: .value("跑力", values[index]))
                    .foregroundStyle(tint).interpolationMethod(.monotone)
                    .lineStyle(StrokeStyle(lineWidth: 2))
                if index % max(1, values.count / 8) == 0 || index == values.count - 1 {
                    PointMark(x: .value("周期", index), y: .value("跑力", values[index]))
                        .foregroundStyle(tint).symbolSize(22)
                }
                AreaMark(x: .value("周期", index), yStart: .value("基线", lowerBound), yEnd: .value("跑力", values[index]))
                    .foregroundStyle(LinearGradient(colors: [tint.opacity(0.18), .clear], startPoint: .top, endPoint: .bottom))
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
        .chartYScale(domain: lowerBound...upperBound)
        .chartYAxis {
            AxisMarks(position: .leading) {
                AxisGridLine().foregroundStyle(TechColor.grid.opacity(0.45))
                AxisValueLabel().foregroundStyle(TechColor.muted)
            }
        }
        .frame(height: height * chartScale)
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
