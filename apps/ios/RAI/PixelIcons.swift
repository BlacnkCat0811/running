#if os(iOS)
import SwiftUI

struct PixelRunnerIcon: View {
    var color: Color = .white
    var background: Color = .clear
    var size: CGFloat = 42

    private let cells: [(Int, Int)] = [
        (0, 1), (0, 2),
        (1, 0), (1, 1), (1, 2), (1, 3),
        (2, 1), (2, 2),
        (3, 1), (3, 3)
    ]

    var body: some View {
        Canvas { context, canvasSize in
            let cell = min(canvasSize.width, canvasSize.height) / 4
            for (row, column) in cells {
                let rect = CGRect(x: CGFloat(column) * cell, y: CGFloat(row) * cell, width: cell - 1, height: cell - 1)
                context.fill(Path(rect), with: .color(color))
            }
        }
        .frame(width: size, height: size)
        .background(background)
        .accessibilityHidden(true)
    }
}

struct PixelIconBox: View {
    let systemName: String
    var tint: Color = PixelColor.green
    var fill: Color = PixelColor.mint
    var size: CGFloat = 38

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: size * 0.42, weight: .heavy))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(fill)
            .overlay(Rectangle().stroke(PixelColor.ink, lineWidth: PixelMetrics.border))
    }
}

func nativeSessionSymbol(_ value: String, indoor: Bool = false) -> String {
    if indoor { return "figure.run.circle.fill" }
    switch value {
    case "easy", "recovery": return "figure.run"
    case "steady": return "figure.walk.motion"
    case "tempo": return "speedometer"
    case "interval": return "bolt.fill"
    case "long_run": return "figure.run.circle"
    case "race": return "flag.fill"
    case "rest": return "bed.double.fill"
    default: return "figure.run"
    }
}

func nativeSessionColor(_ value: String) -> Color {
    switch value {
    case "tempo", "interval", "race": return PixelColor.coral
    case "long_run": return PixelColor.cyan
    case "recovery", "easy": return PixelColor.green
    case "rest": return PixelColor.muted
    default: return PixelColor.yellow
    }
}
#endif
