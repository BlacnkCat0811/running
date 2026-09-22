#if os(iOS)
import SwiftUI
import UIKit

/// Ice-blue skin tokens. 2026-09-18 删除像素皮肤后，这是原生端唯一的配色令牌层：
/// 共享组件只准从这里取色，不得内联色值（同事故 18067cb 的教训）。
enum TechColor {
    static let background = Color(red: 4/255, green: 12/255, blue: 20/255)
    static let paper = Color(red: 10/255, green: 23/255, blue: 36/255)
    static let ink = Color(red: 238/255, green: 245/255, blue: 255/255)
    static let muted = Color(uiColor: UIColor { traits in
        traits.accessibilityContrast == .high
            ? UIColor(red: 0.82, green: 0.89, blue: 0.96, alpha: 1)
            : UIColor(red: 0.60, green: 0.70, blue: 0.79, alpha: 1)
    })
    static let elevated = Color(red: 16/255, green: 33/255, blue: 49/255)
    static let cyan = Color(red: 12/255, green: 196/255, blue: 235/255)
    static let blue = Color(red: 0/255, green: 174/255, blue: 239/255)
    static let green = cyan
    static let leaf = Color(red: 136/255, green: 150/255, blue: 255/255)
    static let coral = Color(red: 255/255, green: 109/255, blue: 139/255)
    static let yellow = Color(red: 255/255, green: 214/255, blue: 92/255)
    static let success = Color(red: 50/255, green: 232/255, blue: 192/255)
    static let dusk = Color(red: 111/255, green: 102/255, blue: 159/255)
    static let horizon = Color(red: 220/255, green: 162/255, blue: 149/255)
    static let landscape = Color(red: 25/255, green: 62/255, blue: 113/255)
    /// Chart-label accent. Kept out of the view so no shared component has to
    /// carry a single skin's colour inline (see incident 18067cb).
    static let violet = Color(red: 0.84, green: 0.62, blue: 0.78)
    static let grid = Color(red: 42/255, green: 59/255, blue: 80/255)
    static let mint = cyan.opacity(0.09)
    static let paleCyan = cyan.opacity(0.10)
    static let paleCoral = coral.opacity(0.10)
    static let paleYellow = yellow.opacity(0.10)
    static let energy = LinearGradient(colors: [cyan, blue, Color(red: 0.20, green: 0.30, blue: 0.85)], startPoint: .topLeading, endPoint: .bottomTrailing)
    static let action = Color(red: 47/255, green: 217/255, blue: 241/255)
}

enum TechMetrics {
    static let pageHorizontal: CGFloat = 20
    static let pageVertical: CGFloat = 16
    // NativeRootView reserves actual layout space for the tab bar. This is breathing
    // room only; adding the tab height here a second time leaves a blank screen.
    static let bottomClearance: CGFloat = 24
    static let sectionSpacing: CGFloat = 16
    static let panelPadding: CGFloat = 16
    static let border: CGFloat = 0.5
    static let smallBorder: CGFloat = 0.5
    static let corner: CGFloat = 16
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
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .tint(TechColor.cyan)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left").font(.system(size: 20, weight: .medium))
                            .foregroundStyle(TechColor.ink).frame(width: 44, height: 44)
                    }.buttonStyle(.plain).accessibilityLabel("返回")
                        .accessibilityIdentifier("navigation.back")
                }
            }
            // The native item's accessibility target existed but its glyph was
            // absent in dark-bar simulator captures. Keep an explicit visible
            // glyph while retaining UIKit's interactive transition.
            .background(TechBackGesture())
    }
}

extension View {
    func techNavigation(_ title: String) -> some View { modifier(TechNavigation(title: title)) }
}

struct TechPanel<Content: View>: View {
    @Environment(\.colorSchemeContrast) private var contrast
    let content: Content
    var tint: Color
    var fill: Color
    init(tint: Color = TechColor.grid, fill: Color = TechColor.paper,
         shadowColor: Color = .clear, @ViewBuilder content: () -> Content) {
        self.tint = tint; self.fill = fill; self.content = content()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }
            .padding(TechMetrics.panelPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: TechMetrics.corner, style: .continuous)
                    // Color.gradient automatically lifts dark colors toward gray.
                    // Use a controlled tint instead of washing out the design's navy layers.
                    .fill(LinearGradient(colors: [fill, fill, TechColor.background.opacity(0.85)],
                                         startPoint: .topLeading, endPoint: .bottomTrailing))
                    .overlay {
                        RoundedRectangle(cornerRadius: TechMetrics.corner, style: .continuous)
                            .strokeBorder(tint.opacity(contrast == .increased ? 1 : 0.72),
                                          lineWidth: contrast == .increased ? 1 : TechMetrics.border)
                    }
            }
    }
}

struct TechHeroCard<Content: View>: View {
    let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }
            .padding(TechMetrics.panelPadding).frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: TechMetrics.corner, style: .continuous)
                    .fill(LinearGradient(colors: [TechColor.elevated, TechColor.paper, TechColor.background],
                                         startPoint: .topLeading, endPoint: .bottomTrailing))
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
        TechAdaptiveStack(spacing: 8) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(TechColor.ink)
                .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            if let trailing {
                Text(trailing).font(.caption).foregroundStyle(trailingColor)
                    .fixedSize(horizontal: false, vertical: true)
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
        TechAdaptiveStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).techScaledFont(title == "RAI" ? 32 : 24, weight: .bold)
                    .foregroundStyle(TechColor.ink)
                    .accessibilityAddTraits(.isHeader)
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
    @Environment(\.dynamicTypeSize) private var typeSize
    let items: [(title: String, value: Value)]
    @Binding var selection: Value
    var body: some View {
        if typeSize.isAccessibilitySize {
            TechFilterChips(items: items, selection: $selection)
        } else {
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
                .buttonStyle(TechPressStyle())
                .accessibilityAddTraits(selection == item.value ? .isSelected : [])
            }
        }.background { Capsule().fill(TechColor.paper).frame(height: 30) }
        }
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
                .foregroundStyle(accent).fixedSize(horizontal: false, vertical: true)
        }
        .padding(12).frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        .background(fill, in: RoundedRectangle(cornerRadius: TechMetrics.corner, style: .continuous))
        .accessibilityElement(children: .combine)
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
                    }.buttonStyle(TechPressStyle())
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
        }.buttonStyle(TechPressStyle()).accessibilityLabel(accessibilityLabel)
    }
}

struct TechPrimaryButton: View {
    let title: String
    var systemName: String?
    var isBusy = false
    var isDisabled = false
    var busyTitle = "处理中…"
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isBusy { ProgressView().tint(TechColor.background) }
                else if let systemName { Image(systemName: systemName) }
                Text(isBusy ? busyTitle : title).font(.subheadline.weight(.semibold))
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(isDisabled ? TechColor.muted : TechColor.background)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 50)
                .background {
                    if isDisabled { Capsule().fill(TechColor.grid) }
                    else { Capsule().fill(TechColor.action) }
                }
        }.buttonStyle(TechPressStyle()).disabled(isDisabled || isBusy)
            .accessibilityLabel(title)
            .accessibilityValue(isBusy ? busyTitle : "")
    }
}

struct TechProgressBar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// `nil` 表示缺值，而不是 0：仍然画轨道，但不画填充、不报百分比，
    /// 否则一个缺失的分数会和真实的 0 分长得一模一样。
    let fraction: Double?
    var tint: Color = TechColor.cyan
    var height: CGFloat = 7
    private var clamped: Double? {
        guard let fraction, fraction.isFinite else { return nil }
        return min(max(fraction, 0), 1)
    }
    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(TechColor.grid.opacity(0.6))
                if let clamped {
                    Capsule().fill(LinearGradient(colors: [tint, tint.opacity(0.5)], startPoint: .leading, endPoint: .trailing))
                        .frame(width: proxy.size.width * clamped)
                }
            }
        }.frame(height: height)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: clamped)
        .accessibilityValue(nativePercent(clamped))
    }
}

struct TechStatLine: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let label: String
    let value: String
    var tint: Color = TechColor.cyan
    var fraction: Double?
    /// 紧跟标签的小徽标，用于标注该行的性质而非数值（如能力分析里的「诊断」）。
    /// 只在确实需要区分时才传：徽标会挤窄同一行的进度条，多一枚就少一截可读长度。
    var note: String?
    var body: some View {
        TechAdaptiveStack(spacing: 8) {
          HStack(spacing: 8) {
            Circle().fill(tint).frame(width: 6, height: 6)
            Text(label).font(.caption).foregroundStyle(TechColor.muted)
                .frame(minWidth: typeSize.isAccessibilitySize ? 0 : 48, alignment: .leading)
            if let note {
                Text(note)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(TechColor.muted)
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .overlay(RoundedRectangle(cornerRadius: 4).stroke(TechColor.grid, lineWidth: 1))
                    .fixedSize()
            }
          }
            TechProgressBar(fraction: fraction, tint: tint)
                .accessibilityHidden(true)
            Text(value).font(.caption.monospacedDigit()).foregroundStyle(TechColor.ink)
                .frame(minWidth: 44, alignment: .trailing)
        }.padding(.vertical, 8)
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
                            .font(.system(size: 22, weight: .semibold)).frame(height: 25)
                            .shadow(color: selection == tab ? TechColor.cyan.opacity(0.35) : .clear, radius: 7)
                        Text(tab.title).font(.caption2.weight(.medium))
                    }
                    .foregroundStyle(selection == tab ? TechColor.cyan : TechColor.muted)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .contentShape(Rectangle())
                }.buttonStyle(TechPressStyle())
                    .accessibilityAddTraits(selection == tab ? .isSelected : [])
                    .accessibilityIdentifier("tab.\(tab.title)")
                    .accessibilityShowsLargeContentViewer { Text(tab.title) }
            }
        }.padding(.horizontal, 12).padding(.top, 8)
            .background(TechColor.background)
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
            .foregroundStyle(TechColor.ink).fixedSize(horizontal: false, vertical: true)
    }.frame(maxWidth: .infinity, alignment: .leading)
}
func techStatusName(_ value: String?) -> String {
    guard let value, value != "unknown", value != "unavailable" else { return "暂无数据" }
    return nativeStatusName(value)
}

/// 校准进度短标签，供空间有限的卡片标题使用。
/// `nil` 是载荷缺失，不是未知状态，按 `techStatusName` 的约定显示「暂无数据」。
func techCalibrationName(_ value: String?) -> String {
    switch value {
    case "completed": return "已校准"
    case "calibrating": return "校准中"
    case "not_started": return "尚未开始"
    default: return "暂无数据"
    }
}

/// 给可选数值附单位：缺值保持 `--`，不加单位后缀。
/// `nativeNumber(nil) + "/周"` 会渲染成 `--/周`，看起来像存在一个速率。
func techValue(_ value: Double?, digits: Int = 1, unit: String) -> String {
    guard let value, value.isFinite else { return "--" }
    return nativeNumber(value, digits: digits) + unit
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
    // `exported` = ZIP 已落盘、还没开始传。不给它名分就会落到 `default` 的"等待同步"，
    // 而那一刻恰恰是"本地有一份数据等着发出去"—— 用户能做的事和"等待"完全不同。
    case "exported": return "已准备数据"
    case "uploading": return "上传数据"
    // `uploaded` = 服务端已收下、导入还没发起。与 `importing` 分开写，是因为它意味着
    // "再等一会儿就要开始算"，而不是"正在算"。
    case "uploaded": return "已上传，等待导入"
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
