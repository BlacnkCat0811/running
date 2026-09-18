#if os(iOS)
import SwiftUI

/// Decorative illustration. Curves here are not plotted training samples.
struct TechShoeIllustration: View {
    var body: some View {
        Canvas { context, size in
            let sx = size.width / 280, sy = size.height / 150
            func path(_ points: [CGPoint]) -> Path {
                Path { p in
                    guard let first = points.first else { return }
                    p.move(to: CGPoint(x: first.x * sx, y: first.y * sy))
                    for point in points.dropFirst() { p.addLine(to: CGPoint(x: point.x * sx, y: point.y * sy)) }
                }
            }
            for row in 0..<5 {
                var wave = Path()
                wave.move(to: CGPoint(x: 0, y: CGFloat(95 + row * 9) * sy))
                wave.addCurve(to: CGPoint(x: size.width, y: CGFloat(83 + row * 10) * sy),
                              control1: CGPoint(x: 100 * sx, y: CGFloat(20 + row * 6) * sy),
                              control2: CGPoint(x: 166 * sx, y: CGFloat(145 + row * 5) * sy))
                context.stroke(wave, with: .color(TechColor.blue.opacity(0.12)), lineWidth: 1)
            }
            let outline: [CGPoint] = [CGPoint(x: 50,y: 104), CGPoint(x: 69,y: 88), CGPoint(x: 88,y: 77), CGPoint(x: 105,y: 45), CGPoint(x: 114,y: 42), CGPoint(x: 123,y: 52), CGPoint(x: 144,y: 54), CGPoint(x: 162,y: 42), CGPoint(x: 157,y: 28), CGPoint(x: 167,y: 24), CGPoint(x: 183,y: 34), CGPoint(x: 207,y: 56), CGPoint(x: 218,y: 76), CGPoint(x: 207,y: 88), CGPoint(x: 183,y: 96), CGPoint(x: 153,y: 118), CGPoint(x: 116,y: 131), CGPoint(x: 79,y: 129), CGPoint(x: 51,y: 118), CGPoint(x: 50,y: 104)]
            context.stroke(path(outline), with: .color(TechColor.cyan), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            context.stroke(path([CGPoint(x: 51,y: 113), CGPoint(x: 92,y: 121), CGPoint(x: 126,y: 119), CGPoint(x: 163,y: 101), CGPoint(x: 191,y: 82), CGPoint(x: 214,y: 73)]), with: .color(TechColor.blue), lineWidth: 2)
            context.stroke(path([CGPoint(x: 97,y: 99), CGPoint(x: 125,y: 103), CGPoint(x: 180,y: 64), CGPoint(x: 185,y: 43)]), with: .color(TechColor.cyan.opacity(0.7)), lineWidth: 1)
            for index in 0..<4 {
                let y = CGFloat(62 + index * 8)
                context.stroke(path([CGPoint(x: 101 - CGFloat(index * 4),y: y), CGPoint(x: 121 - CGFloat(index * 4),y: y + 5)]), with: .color(TechColor.cyan), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            }
        }.frame(height: 150).accessibilityHidden(true)
    }
}

struct TechRaceLandscape: View {
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                LinearGradient(colors: [TechColor.paper, TechColor.blue.opacity(0.17)], startPoint: .leading, endPoint: .trailing)
                Path { path in
                    let w = geometry.size.width, h = geometry.size.height
                    path.move(to: CGPoint(x: 0, y: h))
                    for (x, y) in [(0.0,0.8),(0.3,0.65),(0.45,0.76),(0.62,0.32),(0.71,0.56),(0.81,0.4),(1.0,0.74),(1.0,1.0)] {
                        path.addLine(to: CGPoint(x: w * x, y: h * y))
                    }
                    path.closeSubpath()
                }.fill(TechColor.background.opacity(0.6))
                Image(systemName: "figure.run").font(.system(size: 35, weight: .ultraLight))
                    .foregroundStyle(TechColor.muted.opacity(0.24))
                    .position(x: geometry.size.width * 0.78, y: geometry.size.height * 0.63)
            }
        }.accessibilityHidden(true)
    }
}

/// A compact, labeled series drawn only from supplied observations.
struct TechSparkline: View {
    let values: [Double]
    var tint: Color = TechColor.cyan
    var body: some View {
        Canvas { context, size in
            let samples = values.filter(\.isFinite)
            guard samples.count > 1 else { return }
            let low = samples.min() ?? 0, high = samples.max() ?? 1
            let span = max(high - low, 1)
            let points = samples.enumerated().map { index, value in
                CGPoint(x: size.width * Double(index) / Double(samples.count - 1), y: size.height * (0.9 - 0.8 * (value - low) / span))
            }
            var line = Path(); line.addLines(points)
            var area = line
            area.addLine(to: CGPoint(x: size.width, y: size.height))
            area.addLine(to: CGPoint(x: 0, y: size.height)); area.closeSubpath()
            context.fill(area, with: .linearGradient(Gradient(colors: [tint.opacity(0.2), .clear]), startPoint: .zero, endPoint: CGPoint(x: 0,y: size.height)))
            context.stroke(line, with: .color(tint), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
        }.frame(height: 30).accessibilityHidden(true)
    }
}

/// Local vector scenery: decorative, offline, and independent of health data.
struct TechRunningLandscape: View {
    var road = false
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                LinearGradient(colors: [TechColor.landscape, TechColor.dusk, TechColor.horizon],
                               startPoint: .top, endPoint: .bottomTrailing)
                Canvas { context, size in
                    func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                        CGPoint(x: x * size.width, y: y * size.height)
                    }
                    for layer in 0..<3 {
                        let offset = CGFloat(layer) * 0.10
                        let ridge = Path { p in
                            p.move(to: point(0, 0.65 + offset))
                            p.addLines([point(0.18, 0.51 + offset), point(0.32, 0.60 + offset),
                                        point(0.51, 0.36 + offset), point(0.70, 0.64 + offset),
                                        point(0.84, 0.54 + offset), point(1, 0.40 + offset), point(1, 1), point(0, 1)])
                            p.closeSubpath()
                        }
                        context.fill(ridge, with: .color(TechColor.background.opacity(0.30 + Double(layer) * 0.22)))
                    }
                    if road {
                        let track = Path { p in
                            p.move(to: point(0.42, 1))
                            p.addCurve(to: point(0.91, 0.53), control1: point(0.66, 0.69), control2: point(0.94, 0.78))
                            p.addCurve(to: point(0.80, 1), control1: point(0.96, 0.80), control2: point(0.79, 0.82))
                            p.closeSubpath()
                        }
                        context.fill(track, with: .color(TechColor.landscape))
                        context.stroke(track, with: .color(TechColor.cyan.opacity(0.35)), lineWidth: 1)
                    }
                }
                Image(systemName: "figure.run")
                    .font(.system(size: road ? 26 : 32, weight: .medium))
                    .foregroundStyle(TechColor.background.opacity(0.85))
                    .position(x: geometry.size.width * 0.76, y: geometry.size.height * 0.73)
                LinearGradient(colors: [TechColor.background.opacity(0.98), TechColor.background.opacity(0.75), .clear],
                               startPoint: .leading, endPoint: .trailing)
                LinearGradient(colors: [.clear, TechColor.background.opacity(0.6)], startPoint: .top, endPoint: .bottom)
            }
        }.clipped().allowsHitTesting(false).accessibilityHidden(true)
    }
}

struct TechTodayHeader: View {
    let date: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TechAdaptiveStack {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Image(systemName: "mountain.2.fill").foregroundStyle(TechColor.energy)
                            .font(.system(size: 28, weight: .bold)).accessibilityHidden(true)
                        Text("RAI").techScaledFont(34, weight: .bold).accessibilityAddTraits(.isHeader)
                    }
                    Text(date).font(.caption).foregroundStyle(TechColor.muted)
                }
                Spacer(minLength: 0)
                TechHomeActions()
            }
            Text("坚持，让更好的你发生 💙").font(.caption).foregroundStyle(TechColor.muted)
        }
        .padding(.vertical, 8)
        .background { TechRunningLandscape().padding(.horizontal, -TechMetrics.pageHorizontal).padding(.top, -25) }
    }
}

/// The arc is the measured easy-running fraction, never a synthetic readiness score.
struct TechVerdictInstrument: View {
    let fraction: Double?
    let tone: Color
    let symbol: String
    var body: some View {
        ZStack {
            Circle().stroke(TechColor.grid.opacity(0.65), lineWidth: 9)
            if let fraction, fraction.isFinite {
                Circle().trim(from: 0, to: min(max(fraction, 0), 1))
                    .stroke(LinearGradient(colors: [tone, tone.opacity(0.65)], startPoint: .top, endPoint: .bottom),
                            style: StrokeStyle(lineWidth: 9, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            VStack(spacing: 5) {
                Image(systemName: symbol).font(.system(size: 25, weight: .medium)).foregroundStyle(tone)
                Text(nativePercent(fraction)).font(.subheadline.weight(.semibold)).monospacedDigit()
                Text("轻松跑占比").font(.system(size: 10)).foregroundStyle(TechColor.muted)
            }
        }.frame(width: 104, height: 104).padding(5)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("本周轻松跑时长占比 \(nativePercent(fraction))")
    }
}

#endif
