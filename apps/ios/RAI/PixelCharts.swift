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
                    .foregroundStyle(PixelColor.ink)
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
            AxisMarks(values: .automatic(desiredCount: min(labels.count, 4))) {
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

/// Pixel-skin route rendering for the workout detail page.
///
/// Projects the GPS trace on a pure SwiftUI canvas: no map tiles and no
/// `UIViewRepresentable`, so the route always draws even when the system map
/// cannot render, and the surface keeps the pixel palette (mint plot, hard ink
/// border, square markers) instead of the technology map.
struct PixelRouteView: View {
    let route: [RoutePoint]
    var height: CGFloat = 240
    private let inset: CGFloat = 20

    private var coordinates: [(longitude: Double, latitude: Double)] {
        route.compactMap { point in
            guard point.longitude.isFinite, point.latitude.isFinite,
                  abs(point.longitude) <= 180, abs(point.latitude) <= 90 else { return nil }
            return (point.longitude, point.latitude)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            if coordinates.count < 2 {
                Text("有效路线坐标不足")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(PixelColor.muted)
                    .frame(maxWidth: .infinity, minHeight: height)
                    .background(PixelColor.mint.opacity(0.35))
                    .overlay(Rectangle().stroke(PixelColor.grid, lineWidth: 1))
            } else {
                Canvas { context, size in
                    draw(in: &context, size: size)
                }
                .frame(height: height)
                .overlay(Rectangle().stroke(PixelColor.ink, lineWidth: PixelMetrics.border))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("真实 GPS 轨迹，\(coordinates.count) 个坐标点；珊瑚色方块为起点，黄色方块为终点，无地图底图")
                legend
            }
        }
        .accessibilityIdentifier("workout.route.map")
    }

    private var legend: some View {
        HStack(spacing: 14) {
            legendItem(color: PixelColor.green, title: "轨迹")
            legendItem(color: PixelColor.coral, title: "起点")
            legendItem(color: PixelColor.yellow, title: "终点")
            Spacer(minLength: 0)
            Text("\(coordinates.count) 个坐标点")
                .font(.caption2.weight(.bold))
                .foregroundStyle(PixelColor.muted)
        }
    }

    private func legendItem(color: Color, title: String) -> some View {
        HStack(spacing: 5) {
            Rectangle()
                .fill(color)
                .frame(width: 9, height: 9)
                .overlay(Rectangle().stroke(PixelColor.ink.opacity(0.5), lineWidth: 1))
            Text(title)
                .font(.caption2.weight(.heavy))
                .foregroundStyle(PixelColor.muted)
        }
    }

    /// Equirectangular projection. Longitude is compressed by the mean latitude
    /// so the trace keeps its real shape instead of stretching east to west.
    private func projected(in size: CGSize) -> [CGPoint] {
        let raw = coordinates
        guard raw.count > 1 else { return [] }
        let meanLatitude = raw.map(\.latitude).reduce(0, +) / Double(raw.count)
        let cosLatitude = max(cos(meanLatitude * .pi / 180), 0.2)
        let xs = raw.map { $0.longitude * cosLatitude }
        let ys = raw.map(\.latitude)
        guard let minX = xs.min(), let maxX = xs.max(),
              let minY = ys.min(), let maxY = ys.max() else { return [] }
        let spanX = max(maxX - minX, 1e-7)
        let spanY = max(maxY - minY, 1e-7)
        let scale = min((size.width - inset * 2) / spanX, (size.height - inset * 2) / spanY)
        guard scale.isFinite, scale > 0 else { return [] }
        let offsetX = (size.width - spanX * scale) / 2
        let offsetY = (size.height - spanY * scale) / 2
        return zip(xs, ys).map { x, y in
            CGPoint(x: (x - minX) * scale + offsetX,
                    // Canvas origin is top-left; flip so north points up.
                    y: size.height - ((y - minY) * scale + offsetY))
        }
    }

    private func draw(in context: inout GraphicsContext, size: CGSize) {
        context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(PixelColor.mint.opacity(0.35)))
        var dots = Path()
        for x in stride(from: 8.0, through: size.width, by: 16) {
            for y in stride(from: 8.0, through: size.height, by: 16) {
                dots.addEllipse(in: CGRect(x: x, y: y, width: 1.6, height: 1.6))
            }
        }
        context.fill(dots, with: .color(PixelColor.ink.opacity(0.08)))
        let points = projected(in: size).filter { $0.x.isFinite && $0.y.isFinite }
        guard points.count > 1 else { return }
        var path = Path()
        path.addLines(points)
        // Paper halo first so the trace stays readable over the grid, then the
        // pixel-green line with square caps and mitred corners.
        context.stroke(path, with: .color(PixelColor.paper),
                       style: StrokeStyle(lineWidth: 7, lineCap: .square, lineJoin: .miter))
        context.stroke(path, with: .color(PixelColor.green),
                       style: StrokeStyle(lineWidth: 3.5, lineCap: .square, lineJoin: .miter))
        for (point, color) in [(points[0], PixelColor.coral), (points[points.count - 1], PixelColor.yellow)] {
            let square = CGRect(x: point.x - 5, y: point.y - 5, width: 10, height: 10)
            context.fill(Path(square), with: .color(color))
            context.stroke(Path(square), with: .color(PixelColor.ink), lineWidth: 1.5)
        }
    }
}

/// Pixel-skin heart rate chart for the workout detail page.
///
/// Shares the same data contract as `NativeHeartRateChart` (average from the
/// workout summary, peak from the retained series) so both skins show identical
/// values, but renders with the pixel palette instead of the technology palette.
struct PixelHeartRateChart: View {
    let metric: MetricSeries
    let averageHeartRate: Double?
    let durationSeconds: Double
    @ScaledMetric(relativeTo: .caption) private var chartHeight: CGFloat = 170
    private var data: HeartRateChartData { HeartRateChartData(points: metric.points, durationSeconds: durationSeconds) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "heart.fill")
                    .font(.caption.weight(.heavy))
                    .foregroundStyle(PixelColor.coral)
                Text("心率")
                    .font(.caption.weight(.heavy))
                    .foregroundStyle(PixelColor.green)
            }
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 3) {
                        Text(nativeNumber(averageHeartRate, digits: 0))
                            .font(.system(.title2, design: .monospaced).weight(.heavy))
                        Text("bpm").font(.caption.weight(.bold))
                    }
                    .foregroundStyle(PixelColor.ink)
                    Text("平均心率").font(.caption2.weight(.bold)).foregroundStyle(PixelColor.muted)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text("最大心率").font(.caption2.weight(.bold)).foregroundStyle(PixelColor.muted)
                    Text("\(nativeNumber(data.maximum, digits: 0)) bpm")
                        .font(.system(.subheadline, design: .monospaced).weight(.heavy))
                        .monospacedDigit()
                        .foregroundStyle(PixelColor.coral)
                }
            }
            if data.points.isEmpty {
                Text("暂无有效心率样本")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(PixelColor.muted)
                    .frame(maxWidth: .infinity, minHeight: chartHeight)
                    .background(PixelColor.mint.opacity(0.35))
                    .overlay(Rectangle().stroke(PixelColor.grid, lineWidth: 1))
            } else {
                Chart(data.points) { point in
                    AreaMark(
                        x: .value("时间", point.offsetSeconds),
                        yStart: .value("基线", data.lowerBound),
                        yEnd: .value("心率", point.value)
                    )
                    .foregroundStyle(PixelColor.coral.opacity(0.12))
                    .interpolationMethod(.stepEnd)
                    LineMark(x: .value("时间", point.offsetSeconds), y: .value("心率", point.value))
                        .foregroundStyle(PixelColor.coral)
                        .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .butt, lineJoin: .miter))
                        .interpolationMethod(.stepEnd)
                    if data.points.count == 1 {
                        PointMark(x: .value("时间", point.offsetSeconds), y: .value("心率", point.value))
                            .foregroundStyle(PixelColor.coral).symbolSize(16)
                    }
                }
                .chartXScale(domain: 0...data.duration)
                .chartYScale(domain: data.lowerBound...data.upperBound)
                .chartXAxis {
                    AxisMarks(values: data.timeTicks) { value in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 1, dash: [2, 3]))
                            .foregroundStyle(PixelColor.grid.opacity(0.7))
                        AxisValueLabel(centered: false, anchor: .topTrailing, collisionResolution: .disabled) {
                            if let seconds = value.as(Double.self) {
                                Text(HeartRateChartData.timeLabel(seconds))
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundStyle(PixelColor.muted)
                            }
                        }
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading, values: Array(stride(from: data.lowerBound, through: data.upperBound, by: 40))) {
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 1, dash: [2, 3]))
                            .foregroundStyle(PixelColor.grid.opacity(0.7))
                        AxisValueLabel().font(.system(size: 9, weight: .bold)).foregroundStyle(PixelColor.muted)
                    }
                }
                .frame(height: chartHeight)
                .chartPlotStyle { plot in
                    plot.background(PixelColor.mint.opacity(0.35))
                        .overlay(Rectangle().stroke(PixelColor.grid, lineWidth: 1))
                }
                .accessibilityLabel("心率随训练时间变化，单位为每分钟心跳次数")
            }
        }
        .accessibilityIdentifier("workout.heartRate.chart")
    }
}
#endif
