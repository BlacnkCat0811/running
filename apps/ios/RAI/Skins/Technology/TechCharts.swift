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
            Circle().stroke(TechColor.grid.opacity(0.6), lineWidth: 8)
            Circle().trim(from: 0, to: progress.isFinite ? min(max(progress, 0), 1) : 0)
                .stroke(AngularGradient(colors: [tint, TechColor.leaf, tint], center: .center, startAngle: .degrees(0), endAngle: .degrees(360)),
                        style: StrokeStyle(lineWidth: 8, lineCap: .round))
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

struct TechWeekBars: View {
    let points: [WeekDailyPoint]
    let today: String
    var body: some View {
        Chart(points) { point in
            BarMark(x: .value("日期", nativeWeekday(point.localDate)), y: .value("公里", point.distanceKm), width: .ratio(0.45))
                .foregroundStyle(TechColor.energy).cornerRadius(4)
        }
        .chartYAxis { AxisMarks(position: .leading) }
        .chartYAxisLabel("km")
        .frame(height: 170)
        .accessibilityLabel("本周每日跑量")
    }
}

struct TechMiniBars: View {
    let values: [Double]
    let labels: [String]
    let colors: [Color]
    var height: CGFloat = 180
    var body: some View {
        Chart {
            ForEach(values.indices, id: \.self) { index in
                BarMark(x: .value("周期", index), y: .value("公里", values[index]), width: .ratio(0.58))
                    .foregroundStyle(LinearGradient(colors: [colors.indices.contains(index) ? colors[index] : TechColor.cyan, TechColor.leaf.opacity(0.4)], startPoint: .top, endPoint: .bottom))
                    .cornerRadius(3)
            }
        }
        .chartXAxis {
            AxisMarks(values: Array(values.indices).filter { $0 % max(1, values.count / 4) == 0 }) { axis in
                AxisValueLabel {
                    if let index = axis.as(Int.self), labels.indices.contains(index) {
                        Text(labels[index]).font(.caption2)
                    }
                }
            }
        }
        .chartYAxis { AxisMarks(position: .leading) }
        .chartYAxisLabel("km")
        .frame(height: height)
    }
}

struct TechLineChart: View {
    let values: [Double]
    let labels: [String]
    var tint: Color = TechColor.cyan
    var height: CGFloat = 170
    var body: some View {
        Chart {
            ForEach(values.indices, id: \.self) { index in
                LineMark(x: .value("周期", index), y: .value("跑力", values[index]))
                    .foregroundStyle(tint).interpolationMethod(.monotone)
                    .lineStyle(StrokeStyle(lineWidth: 2))
                PointMark(x: .value("周期", index), y: .value("跑力", values[index]))
                    .foregroundStyle(tint).symbolSize(22)
            }
        }
        .chartXAxis {
            AxisMarks(values: Array(values.indices).filter { $0 % max(1, values.count / 4) == 0 }) { axis in
                AxisValueLabel {
                    if let index = axis.as(Int.self), labels.indices.contains(index) { Text(labels[index]).font(.caption2) }
                }
            }
        }
        .chartYAxis { AxisMarks(position: .leading) }
        .frame(height: height)
    }
}

struct TechMonthChart: View {
    let months: [MonthSummary]
    var body: some View {
        Chart(months) { month in
            BarMark(x: .value("月份", month.month), y: .value("公里", month.runningDistanceKm), width: .ratio(0.48))
                .foregroundStyle(by: .value("运动", "跑步"))
            BarMark(x: .value("月份", month.month), y: .value("公里", month.cyclingDistanceKm), width: .ratio(0.48))
                .foregroundStyle(by: .value("运动", "骑行"))
            BarMark(x: .value("月份", month.month), y: .value("公里", month.otherDistanceKm), width: .ratio(0.48))
                .foregroundStyle(by: .value("运动", "其他"))
        }
        .chartForegroundStyleScale(["跑步": TechColor.cyan, "骑行": TechColor.leaf, "其他": TechColor.muted])
        .chartYAxis { AxisMarks(position: .leading) }
        .chartYAxisLabel("km").frame(height: 220)
    }
}
#endif
