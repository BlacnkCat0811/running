#if os(iOS)
import Charts
import SwiftUI

/// The summary average comes from the workout, not the downsampled plot.
///
/// 共享组件：颜色一律从环境皮肤取，不得硬编码单一皮肤视觉（见事故 18067cb）。
struct NativeHeartRateChart: View {
    let metric: MetricSeries
    let averageHeartRate: Double?
    let durationSeconds: Double
    @Environment(\.appSkin) private var skin
    @ScaledMetric(relativeTo: .caption) private var chartHeight: CGFloat = 170
    private var cyan: Color { skin == .technology ? TechColor.cyan : PixelColor.green }
    private var muted: Color { skin == .technology ? TechColor.muted : PixelColor.muted }
    private var ink: Color { skin == .technology ? TechColor.ink : PixelColor.ink }
    private var cardFill: Color { skin == .technology ? TechColor.paper : PixelColor.paper }
    private var cardCorner: CGFloat { skin == .technology ? 16 : PixelMetrics.corner }
    private var labelAccent: Color { skin == .technology ? TechColor.violet : PixelColor.coral }
    private var data: HeartRateChartData { HeartRateChartData(points: metric.points, durationSeconds: durationSeconds) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("心率", systemImage: "heart.fill")
                .font(.caption.weight(.semibold)).foregroundStyle(ink)
                .labelStyle(HeartRateLabelStyle(tint: labelAccent))
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 3) {
                        Text(nativeNumber(averageHeartRate, digits: 0))
                            .font(.system(size: 32, weight: .semibold)).monospacedDigit()
                        Text("bpm").font(.caption)
                    }.foregroundStyle(ink)
                    Text("平均心率").font(.caption2).foregroundStyle(muted)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text("最大心率").font(.caption2).foregroundStyle(muted)
                    Text("\(nativeNumber(data.maximum, digits: 0)) bpm")
                        .font(.subheadline.weight(.medium)).monospacedDigit().foregroundStyle(ink)
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
        .background(cardFill, in: RoundedRectangle(cornerRadius: cardCorner))
        .accessibilityIdentifier("workout.heartRate.chart")
    }
}

private struct HeartRateLabelStyle: LabelStyle {
    let tint: Color
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 5) {
            configuration.icon.foregroundStyle(tint)
            configuration.title
        }
    }
}
#endif
