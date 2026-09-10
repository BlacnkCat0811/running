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
#endif
