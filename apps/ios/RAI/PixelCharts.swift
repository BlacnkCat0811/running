#if os(iOS)
import Charts
import SwiftUI

struct PixelRing: View {
    let progress: Double
    let value: String
    let label: String
    var tint: Color = PixelColor.coral
    var size: CGFloat = 88

    var body: some View {
        ZStack {
            Circle()
                .stroke(PixelColor.mint, lineWidth: 10)
            Circle()
                .trim(from: 0, to: min(max(progress, 0), 1))
                .stroke(tint, style: StrokeStyle(lineWidth: 10, lineCap: .butt))
                .rotationEffect(.degrees(-90))
            VStack(spacing: 1) {
                Text(value)
                    .font(.system(.subheadline, design: .monospaced).weight(.heavy))
                    .foregroundStyle(PixelColor.ink)
                Text(label)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(PixelColor.muted)
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label) \(value)")
    }
}

struct PixelWeekBars: View {
    let points: [WeekDailyPoint]
    let today: String

    private var maximum: Double {
        max(points.map(\.distanceKm).max() ?? 0, 1)
    }

    var body: some View {
        VStack(spacing: 7) {
            HStack(alignment: .bottom, spacing: 6) {
                ForEach(points) { point in
                    VStack(spacing: 5) {
                        GeometryReader { proxy in
                            VStack {
                                Spacer(minLength: 0)
                                Rectangle()
                                    .fill(point.localDate == today ? PixelColor.coral : PixelColor.green)
                                    .frame(height: max(3, proxy.size.height * point.distanceKm / maximum))
                                    .overlay(Rectangle().stroke(PixelColor.ink, lineWidth: 1.5))
                            }
                        }
                        .frame(height: 100)
                        Text(nativeWeekday(point.localDate))
                            .font(.caption2.weight(.heavy))
                            .foregroundStyle(point.localDate == today ? PixelColor.coral : PixelColor.muted)
                    }
                    .frame(maxWidth: .infinity)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(nativeWeekday(point.localDate))，\(nativeKilometers(point.distanceKm))")
                }
            }
            .frame(height: 120)
        }
    }
}

struct PixelMiniBars: View {
    let values: [Double]
    let labels: [String]
    let colors: [Color]
    var height: CGFloat = 150

    private var maximum: Double {
        max(values.max() ?? 0, 1)
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            ForEach(values.indices, id: \.self) { index in
                VStack(spacing: 6) {
                    GeometryReader { proxy in
                        VStack {
                            Spacer(minLength: 0)
                            Rectangle()
                                .fill(colors.indices.contains(index) ? colors[index] : PixelColor.green)
                                .frame(height: max(3, proxy.size.height * values[index] / maximum))
                                .overlay(Rectangle().stroke(PixelColor.ink, lineWidth: 1.5))
                        }
                    }
                    .frame(height: height - 22)
                    Text(labels.indices.contains(index) ? labels[index] : "")
                        .font(.caption2.weight(.heavy))
                        .foregroundStyle(PixelColor.muted)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .frame(height: height)
    }
}

struct PixelLineChart: View {
    let values: [Double]
    let labels: [String]
    var tint: Color = PixelColor.green
    var height: CGFloat = 170

    var body: some View {
        Chart {
            ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                LineMark(
                    x: .value("周期", labels.indices.contains(index) ? labels[index] : "\(index + 1)"),
                    y: .value("数值", value)
                )
                .foregroundStyle(tint)
                .interpolationMethod(.stepEnd)
                PointMark(
                    x: .value("周期", labels.indices.contains(index) ? labels[index] : "\(index + 1)"),
                    y: .value("数值", value)
                )
                .foregroundStyle(index == values.count - 1 ? PixelColor.coral : tint)
            }
        }
        .frame(height: height)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: min(labels.count, 5))) {
                AxisGridLine(stroke: StrokeStyle(lineWidth: 1, dash: [2, 3]))
                    .foregroundStyle(PixelColor.grid.opacity(0.7))
                AxisValueLabel()
                    .foregroundStyle(PixelColor.muted)
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading) {
                AxisGridLine(stroke: StrokeStyle(lineWidth: 1, dash: [2, 3]))
                    .foregroundStyle(PixelColor.grid.opacity(0.7))
                AxisValueLabel()
                    .foregroundStyle(PixelColor.muted)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("趋势图，共 \(values.count) 个数据点")
    }
}
#endif
