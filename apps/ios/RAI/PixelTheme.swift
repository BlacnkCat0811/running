#if os(iOS)
import SwiftUI

enum PixelColor {
    static let ink = Color(red: 0x12 / 255.0, green: 0x3F / 255.0, blue: 0x2B / 255.0)
    static let green = Color(red: 0x24 / 255.0, green: 0x74 / 255.0, blue: 0x46 / 255.0)
    static let leaf = Color(red: 0x54 / 255.0, green: 0xA8 / 255.0, blue: 0x64 / 255.0)
    static let mint = Color(red: 0xE7 / 255.0, green: 0xF5 / 255.0, blue: 0xE5 / 255.0)
    static let cyan = Color(red: 0x3A / 255.0, green: 0xA6 / 255.0, blue: 0xC6 / 255.0)
    static let coral = Color(red: 0xED / 255.0, green: 0x65 / 255.0, blue: 0x49 / 255.0)
    static let yellow = Color(red: 0xE9 / 255.0, green: 0xB9 / 255.0, blue: 0x1F / 255.0)
    static let paper = Color(red: 0xFF / 255.0, green: 0xFE / 255.0, blue: 0xF8 / 255.0)
    static let grid = Color(red: 0xB9 / 255.0, green: 0xCD / 255.0, blue: 0xBD / 255.0)
    static let muted = Color(red: 0x5D / 255.0, green: 0x6F / 255.0, blue: 0x64 / 255.0)
    static let paleCoral = Color(red: 0xFD / 255.0, green: 0xE3 / 255.0, blue: 0xDE / 255.0)
    static let paleYellow = Color(red: 0xFD / 255.0, green: 0xF6 / 255.0, blue: 0xDC / 255.0)
    static let paleCyan = Color(red: 0xE2 / 255.0, green: 0xF4 / 255.0, blue: 0xFA / 255.0)
}

enum PixelMetrics {
    static let pageHorizontal: CGFloat = 16
    static let pageVertical: CGFloat = 12
    static let sectionSpacing: CGFloat = 12
    static let panelPadding: CGFloat = 14
    static let border: CGFloat = 2
    static let smallBorder: CGFloat = 1
    static let corner: CGFloat = 3
    static let shadow: CGFloat = 3
    static let tabBarHeight: CGFloat = 68
}

struct PixelBackground: View {
    var body: some View {
        ZStack {
            PixelColor.paper
            Canvas { context, size in
                let step: CGFloat = 16
                let dot = Path(ellipseIn: CGRect(x: 0, y: 0, width: 1.5, height: 1.5))
                for x in stride(from: step / 2, through: size.width, by: step) {
                    for y in stride(from: step / 2, through: size.height, by: step) {
                        context.fill(dot.offsetBy(dx: x, dy: y), with: .color(PixelColor.ink.opacity(0.055)))
                    }
                }
            }
            .allowsHitTesting(false)
        }
        .ignoresSafeArea()
    }
}

struct PixelPanel<Content: View>: View {
    let content: Content
    var tint: Color = PixelColor.green
    var fill: Color = PixelColor.paper
    var shadowColor: Color = PixelColor.ink.opacity(0.12)

    init(
        tint: Color = PixelColor.green,
        fill: Color = PixelColor.paper,
        shadowColor: Color = PixelColor.ink.opacity(0.12),
        @ViewBuilder content: () -> Content
    ) {
        self.tint = tint
        self.fill = fill
        self.shadowColor = shadowColor
        self.content = content()
    }

    var body: some View {
        content
            .padding(PixelMetrics.panelPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                Rectangle()
                    .fill(fill)
                    .overlay(
                        Rectangle()
                            .stroke(tint, lineWidth: PixelMetrics.border)
                    )
                    // Keep the hard pixel shadow on the panel surface only.
                    // A translucent panel fill would otherwise include its
                    // text in the shadow mask and render it as a ghost glyph.
                    .shadow(color: shadowColor, radius: 0, x: PixelMetrics.shadow, y: PixelMetrics.shadow)
            }
    }
}

struct PixelHeroCard<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(.horizontal, 17)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(PixelColor.green)
            .overlay(
                Rectangle()
                    .stroke(PixelColor.ink, lineWidth: 3)
            )
            .shadow(color: PixelColor.ink.opacity(0.25), radius: 0, x: 4, y: 4)
    }
}

struct PixelBadge: View {
    let title: String
    var color: Color = PixelColor.green
    var fill: Color = PixelColor.mint

    var body: some View {
        Text(title)
            .font(.caption2.weight(.heavy))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(fill)
            .overlay(Rectangle().stroke(color, lineWidth: 1))
    }
}

struct PixelSectionHeader: View {
    let title: String
    var trailing: String?
    var trailingColor: Color = PixelColor.cyan

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title.uppercased())
                .font(.caption2.weight(.heavy))
                .tracking(1)
                .foregroundStyle(PixelColor.green)
            Spacer()
            if let trailing {
                Text(trailing)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(trailingColor)
            }
        }
    }
}

struct PixelSegmentedControl<Value: Hashable>: View {
    let items: [(title: String, value: Value)]
    @Binding var selection: Value

    var body: some View {
        HStack(spacing: 3) {
            ForEach(items, id: \.value) { item in
                Button {
                    selection = item.value
                } label: {
                    Text(item.title)
                        .font(.caption.weight(.heavy))
                        .foregroundStyle(selection == item.value ? .white : PixelColor.green)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .frame(minHeight: 44)
                        .background(selection == item.value ? PixelColor.green : PixelColor.paper)
                        .overlay(
                            Rectangle()
                                .stroke(selection == item.value ? PixelColor.ink : PixelColor.green, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == item.value ? .isSelected : [])
            }
        }
        .padding(3)
        .background(PixelColor.paper)
        .overlay(Rectangle().stroke(PixelColor.green, lineWidth: PixelMetrics.border))
        .shadow(color: PixelColor.ink.opacity(0.12), radius: 0, x: 2, y: 2)
    }
}

struct PixelMetricTile: View {
    let title: String
    let value: String
    var accent: Color = PixelColor.ink
    var fill: Color = PixelColor.paper

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.caption2.weight(.bold))
                .foregroundStyle(PixelColor.muted)
                .lineLimit(1)
            Text(value)
                .font(.system(.subheadline, design: .monospaced).weight(.heavy))
                .foregroundStyle(accent)
                .lineLimit(1)
                .minimumScaleFactor(0.65)
        }
        .padding(10)
        .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
        .background(fill)
        .overlay(Rectangle().stroke(PixelColor.ink.opacity(0.8), lineWidth: PixelMetrics.smallBorder))
        .shadow(color: PixelColor.ink.opacity(0.1), radius: 0, x: 2, y: 2)
    }
}

struct PixelIconButton: View {
    let systemName: String
    let accessibilityLabel: String
    var color: Color = PixelColor.green
    var fill: Color = PixelColor.paper
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 15, weight: .heavy))
                .foregroundStyle(color)
                .frame(width: 44, height: 44)
                .background(fill)
                .overlay(Rectangle().stroke(color, lineWidth: PixelMetrics.border))
                .shadow(color: PixelColor.ink.opacity(0.14), radius: 0, x: 2, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}

struct PixelPrimaryButton: View {
    let title: String
    var systemName: String?
    var isBusy = false
    var isDisabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if isBusy {
                    ProgressView()
                        .tint(.white)
                        .scaleEffect(0.75)
                } else if let systemName {
                    Image(systemName: systemName)
                }
                Text(isBusy ? "处理中…" : title)
                    .font(.footnote.weight(.heavy))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
            .background(isDisabled ? PixelColor.grid : PixelColor.green)
            .overlay(Rectangle().stroke(PixelColor.ink, lineWidth: PixelMetrics.border))
            .shadow(color: PixelColor.ink.opacity(0.25), radius: 0, x: 3, y: 3)
        }
        .buttonStyle(.plain)
        .disabled(isDisabled || isBusy)
    }
}

struct PixelProgressBar: View {
    let fraction: Double
    var tint: Color = PixelColor.coral
    var height: CGFloat = 8

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Rectangle()
                    .fill(PixelColor.mint)
                Rectangle()
                    .fill(tint)
                    .frame(width: proxy.size.width * min(max(fraction, 0), 1))
            }
            .overlay(Rectangle().stroke(PixelColor.ink.opacity(0.35), lineWidth: 1))
        }
        .frame(height: height)
    }
}

struct PixelStatLine: View {
    let label: String
    let value: String
    var tint: Color = PixelColor.green
    var fraction: Double?

    var body: some View {
        HStack(spacing: 8) {
            Rectangle()
                .fill(tint)
                .frame(width: 9, height: 9)
                .overlay(Rectangle().stroke(PixelColor.ink.opacity(0.5), lineWidth: 1))
            Text(label)
                .font(.caption.weight(.bold))
                .frame(width: 42, alignment: .leading)
            PixelProgressBar(fraction: fraction ?? 0, tint: tint)
            Text(value)
                .font(.caption2.weight(.heavy).monospacedDigit())
                .foregroundStyle(PixelColor.ink)
                .frame(width: 58, alignment: .trailing)
        }
    }
}

struct PixelEmptyState: View {
    let title: String
    let message: String
    var systemName = "square.dashed"

    var body: some View {
        VStack(spacing: 9) {
            Image(systemName: systemName)
                .font(.system(size: 28, weight: .heavy))
                .foregroundStyle(PixelColor.cyan)
            Text(title)
                .font(.headline.weight(.heavy))
                .foregroundStyle(PixelColor.ink)
            Text(message)
                .font(.footnote)
                .foregroundStyle(PixelColor.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 150)
        .padding(16)
    }
}

struct PixelLoadingState: View {
    let title: String

    var body: some View {
        VStack(spacing: 10) {
            ProgressView()
                .tint(PixelColor.green)
                .scaleEffect(1.15)
            Text(title)
                .font(.footnote.weight(.bold))
                .foregroundStyle(PixelColor.muted)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }
}

struct PixelField<Content: View>: View {
    let label: String
    let content: Content

    init(_ label: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption2.weight(.heavy))
                .foregroundStyle(PixelColor.green)
            content
                .font(.subheadline)
                .foregroundStyle(PixelColor.ink)
                .padding(.horizontal, 10)
                .padding(.vertical, 9)
                .background(PixelColor.paper)
                .overlay(Rectangle().stroke(PixelColor.green, lineWidth: PixelMetrics.border))
        }
    }
}

struct PixelInsightCard: View {
    let insight: MobileInsight

    private var isPositive: Bool { insight.kind == "positive" }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: isPositive ? "lightbulb.fill" : "exclamationmark.triangle.fill")
                .font(.system(size: 16, weight: .heavy))
                .foregroundStyle(isPositive ? PixelColor.green : PixelColor.yellow)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 4) {
                Text(insight.title)
                    .font(.subheadline.weight(.heavy))
                    .foregroundStyle(isPositive ? PixelColor.green : PixelColor.ink)
                Text(insight.detail)
                    .font(.footnote)
                    .foregroundStyle(PixelColor.muted)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isPositive ? PixelColor.mint : PixelColor.paleYellow)
        .overlay(Rectangle().stroke(isPositive ? PixelColor.leaf : PixelColor.yellow, lineWidth: PixelMetrics.border))
        .shadow(color: PixelColor.ink.opacity(0.1), radius: 0, x: 2, y: 2)
    }
}
#endif
