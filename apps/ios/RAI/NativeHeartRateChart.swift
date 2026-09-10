#if os(iOS)
import Charts
import SwiftUI

/// The summary average comes from the workout, not the downsampled plot.
struct NativeHeartRateChart: View {
    let metric: MetricSeries
    let averageHeartRate: Double?
    let durationSeconds: Double
    @ScaledMetric(relativeTo: .caption) private var chartHeight: CGFloat = 170
    private let cyan = Color(red: 0.05, green: 0.80, blue: 1)
    private let muted = Color(red: 0.49, green: 0.59, blue: 0.68)
    private var data: HeartRateChartData { HeartRateChartData(points: metric.points, durationSeconds: durationSeconds) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("心率", systemImage: "heart.fill")
                .font(.caption.weight(.semibold)).foregroundStyle(.white)
                .labelStyle(HeartRateLabelStyle())
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 3) {
                        Text(nativeNumber(averageHeartRate, digits: 0))
                            .font(.system(size: 32, weight: .semibold)).monospacedDigit()
                        Text("bpm").font(.caption)
                    }.foregroundStyle(.white)
                    Text("平均心率").font(.caption2).foregroundStyle(muted)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text("最大心率").font(.caption2).foregroundStyle(muted)
                    Text("\(nativeNumber(data.maximum, digits: 0)) bpm")
                        .font(.subheadline.weight(.medium)).monospacedDigit().foregroundStyle(.white)
                }
            }
            if data.points.isEmpty {
                Text("暂无有效心率样本").font(.footnote).foregroundStyle(muted)
                    .frame(maxWidth: .infinity, minHeight: chartHeight)
            } else {
                Chart(data.points) { point in
                    AreaMark(x: .value("时间", point.offsetSeconds),
                             yStart: .value("基线", data.lowerBound), yEnd: .value("心率", point.value))
                        .foregroundStyle(LinearGradient(colors: [cyan.opacity(0.28), cyan.opacity(0.01)], startPoint: .top, endPoint: .bottom))
                        .interpolationMethod(.linear)
                    LineMark(x: .value("时间", point.offsetSeconds), y: .value("心率", point.value))
                        .foregroundStyle(cyan).lineStyle(StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                        .interpolationMethod(.linear)
                    if data.points.count == 1 {
                        PointMark(x: .value("时间", point.offsetSeconds), y: .value("心率", point.value))
                            .foregroundStyle(cyan).symbolSize(16)
                    }
                }
                .chartXScale(domain: 0...data.duration)
                .chartYScale(domain: data.lowerBound...data.upperBound)
                .chartXAxis {
                    AxisMarks(values: data.timeTicks) { value in
                        AxisValueLabel(centered: false, anchor: .topTrailing, collisionResolution: .disabled) {
                            if let seconds = value.as(Double.self) {
                                Text(HeartRateChartData.timeLabel(seconds)).font(.system(size: 9)).foregroundStyle(muted)
                            }
                        }
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading, values: Array(stride(from: data.lowerBound, through: data.upperBound, by: 40))) {
                        AxisGridLine().foregroundStyle(muted.opacity(0.12))
                        AxisValueLabel().font(.system(size: 9)).foregroundStyle(muted)
                    }
                }
                .frame(height: chartHeight)
                .accessibilityLabel("心率随训练时间变化，单位为每分钟心跳次数")
            }
        }
        .padding(16)
        .background(Color(red: 0.025, green: 0.075, blue: 0.12), in: RoundedRectangle(cornerRadius: 16))
        .accessibilityIdentifier("workout.heartRate.chart")
    }
}

private struct HeartRateLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 5) {
            configuration.icon.foregroundStyle(Color(red: 0.64, green: 0.40, blue: 0.53))
            configuration.title
        }
    }
}
#endif
