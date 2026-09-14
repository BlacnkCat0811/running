#if os(iOS)
import SwiftUI

/// Ice-blue skin tokens. The legacy PixelColor palette is deliberately independent.
enum TechColor {
    static let background = Color(red: 4/255, green: 12/255, blue: 20/255)
    static let paper = Color(red: 10/255, green: 23/255, blue: 36/255)
    static let ink = Color(red: 238/255, green: 245/255, blue: 255/255)
    static let muted = Color(red: 133/255, green: 157/255, blue: 178/255)
    static let cyan = Color(red: 12/255, green: 196/255, blue: 235/255)
    static let blue = Color(red: 0/255, green: 174/255, blue: 239/255)
    static let green = cyan
    static let leaf = Color(red: 136/255, green: 150/255, blue: 255/255)
    static let coral = Color(red: 255/255, green: 109/255, blue: 139/255)
    static let yellow = Color(red: 245/255, green: 190/255, blue: 97/255)
    /// Chart-label accent. Kept out of the view so no shared component has to
    /// carry a single skin's colour inline (see incident 18067cb).
    static let violet = Color(red: 0.64, green: 0.40, blue: 0.53)
    static let grid = Color(red: 42/255, green: 59/255, blue: 80/255)
    static let mint = cyan.opacity(0.09)
    static let paleCyan = cyan.opacity(0.10)
    static let paleCoral = coral.opacity(0.10)
    static let paleYellow = yellow.opacity(0.10)
    static let energy = LinearGradient(colors: [cyan, blue, Color(red: 0.20, green: 0.30, blue: 0.85)], startPoint: .topLeading, endPoint: .bottomTrailing)
    static let action = Color(red: 47/255, green: 217/255, blue: 241/255)
}

enum TechMetrics {
    static let pageHorizontal: CGFloat = 18
    static let pageVertical: CGFloat = 12
    // Scroll content must clear the custom tab bar even inside a NavigationStack.
    static let bottomClearance: CGFloat = 90
    static let sectionSpacing: CGFloat = 8
    static let panelPadding: CGFloat = 13
    static let border: CGFloat = 0.5
    static let smallBorder: CGFloat = 0.5
    static let corner: CGFloat = 12
    static let shadow: CGFloat = 0
}

struct TechBackground: View {
    var body: some View {
        TechColor.background.ignoresSafeArea()
    }
}

private struct TechNavigation: ViewModifier {
    @Environment(\.dismiss) private var dismiss
    let title: String
    func body(content: Content) -> some View {
        content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .toolbar(.visible, for: .navigationBar)
            .toolbarBackground(TechColor.background, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left").font(.system(size: 20, weight: .medium))
                            .foregroundStyle(TechColor.ink).frame(width: 44, height: 44)
                    }.buttonStyle(.plain).accessibilityLabel("返回").accessibilityIdentifier("navigation.back")
                }
            }
    }
}

extension View {
    func techNavigation(_ title: String) -> some View { modifier(TechNavigation(title: title)) }
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
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(TechMetrics.panelPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: TechMetrics.corner, style: .continuous)
                    // Color.gradient automatically lifts dark colors toward gray.
                    // Use a controlled tint instead of washing out the design's navy layers.
                    .fill(fill)
                    .overlay {
                        RoundedRectangle(cornerRadius: TechMetrics.corner, style: .continuous)
                            .fill(LinearGradient(colors: [TechColor.blue.opacity(0.045), .clear],
                                                 startPoint: .topLeading, endPoint: .bottomTrailing))
                    }
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
        VStack(alignment: .leading, spacing: 12) { content }
            .padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: TechMetrics.corner, style: .continuous)
                    .fill(TechColor.paper)
                    .overlay {
                        RoundedRectangle(cornerRadius: TechMetrics.corner, style: .continuous)
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
                Text(title).font(.system(size: title == "RAI" ? 32 : 24, weight: .bold))
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
                    Text(item.title).font(.subheadline.weight(.medium))
                        .lineLimit(1).fixedSize(horizontal: false, vertical: true)
                        .foregroundStyle(selection == item.value ? TechColor.background : TechColor.muted)
                        .frame(maxWidth: .infinity, minHeight: 30)
                        .background {
                            if selection == item.value { Capsule().fill(TechColor.action) }
                        }
                        .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == item.value ? .isSelected : [])
            }
        }.background { Capsule().fill(TechColor.paper).frame(height: 30) }
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
        .padding(12).frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        .background(fill, in: RoundedRectangle(cornerRadius: TechMetrics.corner, style: .continuous))
    }
}

/// Preserve every existing filter without squeezing six labels into a single width.
struct TechFilterChips<Value: Hashable>: View {
    let items: [(title: String, value: Value)]
    @Binding var selection: Value
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                ForEach(items, id: \.value) { item in
                    Button { selection = item.value } label: {
                        Text(item.title).font(.subheadline.weight(.medium)).fixedSize()
                            .foregroundStyle(selection == item.value ? TechColor.background : TechColor.muted)
                            .padding(.horizontal, 16).frame(minHeight: 30)
                            .background {
                                if selection == item.value { Capsule().fill(TechColor.action) }
                                else { Capsule().fill(TechColor.paper) }
                            }
                            .frame(minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                        .accessibilityAddTraits(selection == item.value ? .isSelected : [])
                }
            }
        }
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
                .background {
                    if isDisabled { Capsule().fill(TechColor.grid) }
                    else { Capsule().fill(TechColor.action) }
                }
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
            if systemName == "shoe" {
                TechShoeIllustration()
            } else {
                Image(systemName: systemName).font(.system(size: 56, weight: .ultraLight))
                    .foregroundStyle(TechColor.energy).padding(.bottom, 12)
            }
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
                .padding(.horizontal, 12).padding(.vertical, 8).frame(minHeight: 44)
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
            Ellipse()
                .fill(RadialGradient(colors: [TechColor.blue.opacity(0.48), TechColor.leaf.opacity(0.16), .clear],
                                     center: .center, startRadius: 8, endRadius: 130))
                .frame(width: 255, height: 100).rotationEffect(.degrees(-27))
            ForEach(0..<4) { index in
                Ellipse().stroke(TechColor.energy.opacity(0.8 - Double(index) * 0.15), lineWidth: index == 0 ? 2 : 1)
                    .frame(width: CGFloat(130 + index * 35), height: CGFloat(40 + index * 18))
                    .rotationEffect(.degrees(-27))
            }
            Ellipse().fill(TechColor.energy.opacity(0.2))
                .overlay(Ellipse().stroke(TechColor.blue.opacity(0.65), lineWidth: 1))
                .frame(width: 185, height: 65).rotationEffect(.degrees(-27))
            Circle().fill(RadialGradient(colors: [TechColor.cyan, TechColor.blue], center: .topLeading,
                                        startRadius: 1, endRadius: 38)).frame(width: 36, height: 36)
                .shadow(color: TechColor.cyan.opacity(0.4), radius: 25)
        }.frame(height: 150).frame(maxWidth: .infinity).accessibilityHidden(true)
    }
}

struct TechTabBar: View {
    @Binding var selection: NativeTab
    var body: some View {
        HStack(spacing: 0) {
            ForEach(NativeTab.allCases, id: \.self) { tab in
                Button { selection = tab } label: {
                    VStack(spacing: 5) {
                        Image(systemName: tab == .home ? (selection == tab ? "house.fill" : "house") : tab.systemName)
                            .font(.system(size: 19, weight: .medium)).frame(height: 22)
                        Text(tab.title).font(.caption2.weight(.medium))
                    }
                    .foregroundStyle(selection == tab ? TechColor.cyan : TechColor.muted)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .contentShape(Rectangle())
                }.buttonStyle(.plain)
                    .accessibilityAddTraits(selection == tab ? .isSelected : [])
                    .accessibilityIdentifier("tab.\(tab.title)")
                    .accessibilityShowsLargeContentViewer { Text(tab.title) }
            }
        }.padding(.horizontal, 12).padding(.top, 8)
            .background(TechColor.background.opacity(0.97))
            .overlay(alignment: .top) { Rectangle().fill(TechColor.grid.opacity(0.4)).frame(height: 0.5) }
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
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
func techStatusName(_ value: String?) -> String {
    guard let value, value != "unknown", value != "unavailable" else { return "暂无数据" }
    return nativeStatusName(value)
}

func techDuration(_ seconds: Double?) -> String {
    guard let seconds, seconds.isFinite, seconds >= 0, seconds < Double(Int.max) else { return "--" }
    let total = Int(seconds.rounded(.down))
    if total >= 3600 { return String(format: "%d:%02d:%02d", total / 3600, (total % 3600) / 60, total % 60) }
    return String(format: "%d:%02d", total / 60, total % 60)
}

func techPace(_ seconds: Double?) -> String {
    nativePace(seconds).replacingOccurrences(of: " ", with: "")
}

func techKilometers(_ kilometers: Double?) -> String {
    guard let kilometers else { return "--" }
    return nativeNumber(kilometers, digits: 2) + " km"
}

func techSyncPhase(_ phase: String) -> String {
    switch phase {
    case "collecting": return "读取健康数据"
    case "uploading": return "上传数据"
    case "importing": return "导入数据"
    case "recomputing": return "更新分析"
    case "succeeded": return "同步完成"
    case "failed": return "同步失败"
    case "cancelled": return "同步已取消"
    default: return "等待同步"
    }
}

func techPaceRange(_ lower: Double?, _ upper: Double?) -> String {
    switch (lower, upper) {
    case let (a?, b?): return "\(techPace(a))–\(techPace(b))/km"
    case let (a?, nil): return "\(techPace(a))/km 或更慢"
    case let (nil, b?): return "\(techPace(b))/km 或更快"
    default: return "暂无配速参考"
    }
}

func techHeartRateRange(_ lower: Double?, _ upper: Double?) -> String {
    switch (lower, upper) {
    case let (a?, b?): return "\(nativeNumber(a, digits: 0))–\(nativeNumber(b, digits: 0)) bpm"
    case let (a?, nil): return "\(nativeNumber(a, digits: 0)) bpm 以上"
    case let (nil, b?): return "\(nativeNumber(b, digits: 0)) bpm 以下"
    default: return "暂无范围"
    }
}

func techPaceZoneCode(_ zone: String) -> String {
    switch zone {
    case "easy": return "E"
    case "marathon": return "M"
    case "lactate_threshold": return "T"
    case "anaerobic_endurance": return "I"
    case "sprint": return "R"
    default: return "—"
    }
}

func techHeartRateZoneCode(_ zone: String) -> String {
    switch nativeHeartRateZone(zone) {
    case "恢复区": return "Z1"
    case "有氧基础区": return "Z2"
    case "有氧动力区": return "Z3"
    case "乳酸阈值区": return "Z4"
    case "无氧区间": return "Z5"
    default: return "—"
    }
}

func techRecordDate(_ value: String) -> String {
    // Personal records span years, unlike the current week's date labels.
    nativeDate(value).split(separator: " ").first.map(String.init) ?? "--"
}

func techHealthError(_ value: String) -> String {
    if value.contains("com.apple.developer.healthkit") && value.contains("entitlement") {
        return "此安装缺少 HealthKit 权限签名，请在 Xcode 配置健康能力并签名后重试。"
    }
    return value
}

#endif
