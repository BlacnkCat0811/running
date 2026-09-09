#if os(iOS)
import SwiftUI

/// Ice-blue skin tokens. The legacy PixelColor palette is deliberately independent.
enum TechColor {
    static let background = Color(red: 9/255, green: 14/255, blue: 23/255)
    static let paper = Color(red: 20/255, green: 30/255, blue: 45/255)
    static let ink = Color(red: 238/255, green: 245/255, blue: 255/255)
    static let muted = Color(red: 157/255, green: 176/255, blue: 197/255)
    static let cyan = Color(red: 105/255, green: 228/255, blue: 242/255)
    static let green = cyan
    static let leaf = Color(red: 136/255, green: 150/255, blue: 255/255)
    static let coral = Color(red: 255/255, green: 109/255, blue: 139/255)
    static let yellow = Color(red: 245/255, green: 190/255, blue: 97/255)
    static let grid = Color(red: 42/255, green: 59/255, blue: 80/255)
    static let mint = cyan.opacity(0.09)
    static let paleCyan = cyan.opacity(0.10)
    static let paleCoral = coral.opacity(0.10)
    static let paleYellow = yellow.opacity(0.10)
    static let energy = LinearGradient(colors: [cyan, Color(red: 0.13, green: 0.60, blue: 0.95), leaf], startPoint: .topLeading, endPoint: .bottomTrailing)
}

enum TechMetrics {
    static let pageHorizontal: CGFloat = 20
    static let pageVertical: CGFloat = 16
    static let sectionSpacing: CGFloat = 16
    static let panelPadding: CGFloat = 18
    static let border: CGFloat = 0.5
    static let smallBorder: CGFloat = 0.5
    static let corner: CGFloat = 22
    static let shadow: CGFloat = 0
}

struct TechBackground: View {
    var body: some View {
        TechColor.background.ignoresSafeArea()
    }
}

struct TechPanel<Content: View>: View {
    let content: Content
    var tint: Color
    var fill: Color
    init(tint: Color = TechColor.grid, fill: Color = TechColor.paper,
         shadowColor: Color = .clear, @ViewBuilder content: () -> Content) {
        self.tint = tint; self.fill = fill; self.content = content()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) { content }
            .padding(TechMetrics.panelPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: TechMetrics.corner, style: .continuous)
                    .fill(fill.gradient)
                    .overlay {
                        RoundedRectangle(cornerRadius: TechMetrics.corner, style: .continuous)
                            .strokeBorder(tint.opacity(0.28), lineWidth: 0.5)
                    }
            }
    }
}

struct TechHeroCard<Content: View>: View {
    let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) { content }
            .padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(LinearGradient(colors: [TechColor.paper, TechColor.cyan.opacity(0.07)], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .overlay {
                        RoundedRectangle(cornerRadius: 24, style: .continuous)
                            .strokeBorder(TechColor.cyan.opacity(0.16), lineWidth: 0.5)
                    }
            }
    }
}

struct TechBadge: View {
    let title: String
    var color: Color = TechColor.cyan
    var fill: Color = TechColor.mint
    var body: some View {
        Text(title).font(.caption.weight(.medium)).foregroundStyle(color)
            .padding(.horizontal, 9).padding(.vertical, 5)
            .background(fill, in: Capsule())
    }
}

struct TechSectionHeader: View {
    let title: String
    var trailing: String?
    var trailingColor: Color = TechColor.muted
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(TechColor.ink)
            Spacer(minLength: 8)
            if let trailing {
                Text(trailing).font(.caption).foregroundStyle(trailingColor)
            }
        }
    }
}

struct TechPageHeader<Trailing: View>: View {
    let title: String
    let eyebrow: String
    let trailing: Trailing
    init(title: String, eyebrow: String = "", @ViewBuilder trailing: () -> Trailing) {
        self.title = title; self.eyebrow = eyebrow; self.trailing = trailing()
    }
    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: title == "RAI" ? 36 : 28, weight: .bold))
                    .foregroundStyle(TechColor.ink)
                if !eyebrow.isEmpty {
                    Text(eyebrow).font(.caption).foregroundStyle(TechColor.muted)
                }
            }
            Spacer(minLength: 8)
            trailing
        }.padding(.bottom, 4)
    }
}

struct TechSegmentedControl<Value: Hashable>: View {
    let items: [(title: String, value: Value)]
    @Binding var selection: Value
    var body: some View {
        HStack(spacing: 4) {
            ForEach(items, id: \.value) { item in
                Button { selection = item.value } label: {
                    Text(item.title).font(.subheadline.weight(.semibold))
                        .foregroundStyle(selection == item.value ? TechColor.background : TechColor.muted)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(selection == item.value ? TechColor.cyan : .clear, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == item.value ? .isSelected : [])
            }
        }.padding(4).background(TechColor.paper, in: Capsule())
    }
}

struct TechMetricTile: View {
    let title: String
    let value: String
    var accent: Color = TechColor.ink
    var fill: Color = TechColor.paper
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title).font(.caption).foregroundStyle(TechColor.muted)
            Text(value).font(.system(.title3, design: .default).weight(.semibold).monospacedDigit())
                .foregroundStyle(accent).lineLimit(1).minimumScaleFactor(0.65)
        }
        .padding(14).frame(maxWidth: .infinity, minHeight: 84, alignment: .leading)
        .background(fill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct TechIconButton: View {
    let systemName: String
    let accessibilityLabel: String
    var color: Color = TechColor.cyan
    var fill: Color = TechColor.paper
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: systemName).font(.system(size: 19, weight: .medium))
                .foregroundStyle(color).frame(width: 44, height: 44)
                .background(fill, in: RoundedRectangle(cornerRadius: 14))
        }.buttonStyle(.plain).accessibilityLabel(accessibilityLabel)
    }
}

struct TechPrimaryButton: View {
    let title: String
    var systemName: String?
    var isBusy = false
    var isDisabled = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isBusy { ProgressView().tint(TechColor.background) }
                else if let systemName { Image(systemName: systemName) }
                Text(isBusy ? "处理中…" : title).font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(isDisabled ? TechColor.muted : TechColor.background)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(isDisabled ? TechColor.grid : TechColor.cyan, in: Capsule())
        }.buttonStyle(.plain).disabled(isDisabled || isBusy)
    }
}

struct TechProgressBar: View {
    let fraction: Double
    var tint: Color = TechColor.cyan
    var height: CGFloat = 7
    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(TechColor.grid.opacity(0.6))
                Capsule().fill(LinearGradient(colors: [tint, tint.opacity(0.5)], startPoint: .leading, endPoint: .trailing))
                    .frame(width: proxy.size.width * (fraction.isFinite ? min(max(fraction, 0), 1) : 0))
            }
        }.frame(height: height)
        .accessibilityValue(nativePercent(fraction.isFinite ? fraction : nil))
    }
}

struct TechStatLine: View {
    let label: String
    let value: String
    var tint: Color = TechColor.cyan
    var fraction: Double?
    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(tint).frame(width: 6, height: 6)
            Text(label).font(.caption).foregroundStyle(TechColor.muted).frame(width: 64, alignment: .leading)
            TechProgressBar(fraction: fraction ?? 0, tint: tint)
            Text(value).font(.caption.monospacedDigit()).foregroundStyle(TechColor.ink)
                .frame(minWidth: 44, alignment: .trailing)
        }.padding(.vertical, 5)
        .accessibilityElement(children: .combine)
    }
}

struct TechEmptyState: View {
    let title: String
    let message: String
    var systemName = "figure.run"
    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: systemName).font(.system(size: 56, weight: .ultraLight))
                .foregroundStyle(TechColor.energy).padding(.bottom, 12)
            Text(title).font(.title3.weight(.semibold)).foregroundStyle(TechColor.ink)
            Text(message).font(.subheadline).foregroundStyle(TechColor.muted).multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity, minHeight: 240).padding(20)
    }
}

struct TechLoadingState: View {
    let title: String
    var body: some View {
        VStack(spacing: 16) {
            ProgressView().tint(TechColor.cyan)
            Text(title).font(.subheadline).foregroundStyle(TechColor.muted)
        }.frame(maxWidth: .infinity, minHeight: 220)
    }
}

struct TechField<Content: View>: View {
    let label: String
    let content: Content
    init(_ label: String, @ViewBuilder content: () -> Content) { self.label = label; self.content = content() }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.caption).foregroundStyle(TechColor.muted)
            content.font(.subheadline).foregroundStyle(TechColor.ink)
                .padding(13).frame(minHeight: 48)
                .background(TechColor.background.opacity(0.65), in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

struct TechInsightCard: View {
    let insight: MobileInsight
    private var tint: Color { insight.kind == "positive" ? TechColor.cyan : TechColor.coral }
    var body: some View {
        TechPanel(tint: tint, fill: tint.opacity(0.07)) {
            VStack(alignment: .leading, spacing: 10) {
                Label(insight.title, systemImage: insight.kind == "positive" ? "lightbulb" : "exclamationmark.circle")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(tint)
                Text(insight.detail).font(.footnote).foregroundStyle(TechColor.muted)
            }
        }
    }
}

struct TechRunnerIcon: View {
    var color: Color = TechColor.cyan
    var background: Color = .clear
    var size: CGFloat = 42
    var body: some View {
        Image(systemName: "figure.run").font(.system(size: size * 0.65, weight: .medium))
            .foregroundStyle(color).frame(width: size, height: size)
            .background(background, in: Circle()).accessibilityHidden(true)
    }
}

struct TechIconBox: View {
    let systemName: String
    var tint: Color = TechColor.cyan
    var fill: Color = TechColor.mint
    var size: CGFloat = 42
    var body: some View {
        Image(systemName: systemName).font(.system(size: size * 0.45, weight: .medium))
            .foregroundStyle(tint).frame(width: size, height: size)
            .background(fill, in: RoundedRectangle(cornerRadius: 13)).accessibilityHidden(true)
    }
}

/// An orbital accent drawn natively, so the design remains sharp at any size.
struct TechOrbit: View {
    var body: some View {
        ZStack {
            ForEach(0..<4) { index in
                Ellipse().stroke(TechColor.energy.opacity(0.8 - Double(index) * 0.15), lineWidth: index == 0 ? 2 : 1)
                    .frame(width: CGFloat(130 + index * 35), height: CGFloat(40 + index * 18))
                    .rotationEffect(.degrees(-27))
            }
            Circle().fill(TechColor.energy).frame(width: 42, height: 42)
                .shadow(color: TechColor.cyan.opacity(0.4), radius: 25)
        }.frame(height: 180).frame(maxWidth: .infinity).accessibilityHidden(true)
    }
}

struct TechTabBar: View {
    @Binding var selection: NativeTab
    var body: some View {
        HStack(spacing: 0) {
            ForEach(NativeTab.allCases, id: \.self) { tab in
                Button { selection = tab } label: {
                    VStack(spacing: 5) {
                        Image(systemName: tab == .home ? "house" : tab.systemName)
                            .font(.system(size: 21, weight: .medium)).frame(height: 24)
                        Text(tab.title).font(.caption2.weight(.medium))
                    }
                    .foregroundStyle(selection == tab ? TechColor.cyan : TechColor.muted)
                    .frame(maxWidth: .infinity, minHeight: 54)
                    .contentShape(Rectangle())
                }.buttonStyle(.plain)
                    .accessibilityAddTraits(selection == tab ? .isSelected : [])
                    .accessibilityIdentifier("tab.\(tab.title)")
            }
        }.padding(.horizontal, 12).padding(.top, 8)
            .background(TechColor.background.opacity(0.97))
            .overlay(alignment: .top) { Rectangle().fill(TechColor.grid.opacity(0.4)).frame(height: 0.5) }
    }
}

func techSessionColor(_ value: String) -> Color {
    switch value {
    case "tempo", "interval", "race": return TechColor.leaf
    case "long_run": return TechColor.yellow
    case "rest": return TechColor.muted
    default: return TechColor.cyan
    }
}

func techToneColor(_ tone: String) -> Color {
    switch tone {
    case "red", "warning", "stale", "injury": return TechColor.coral
    case "yellow", "caution", "insufficient": return TechColor.yellow
    default: return TechColor.cyan
    }
}

func techHeartRateZoneColor(_ value: String) -> Color {
    switch nativeHeartRateZone(value) {
    case "恢复区": return TechColor.cyan
    case "有氧基础区": return Color.teal
    case "有氧动力区": return TechColor.leaf
    case "乳酸阈值区": return TechColor.yellow
    case "无氧区间": return TechColor.coral
    default: return TechColor.cyan
    }
}

func techMetricCaption(_ title: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
        Text(title).font(.caption).foregroundStyle(TechColor.muted)
        Text(value).font(.subheadline.weight(.semibold).monospacedDigit())
            .foregroundStyle(TechColor.ink).lineLimit(1).minimumScaleFactor(0.7)
    }.frame(maxWidth: .infinity, alignment: .leading)
}
#endif
