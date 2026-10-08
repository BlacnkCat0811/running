#if os(iOS)
import SwiftUI

/// A real reflow, rather than shrinking text to make a fixed row fit.
struct TechAdaptiveStack<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    var spacing: CGFloat = 12
    private let content: Content

    init(spacing: CGFloat = 12, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.content = content()
    }

    var body: some View {
        if typeSize >= .xxxLarge {
            VStack(alignment: .leading, spacing: spacing) { content }
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: spacing) { content }
                VStack(alignment: .leading, spacing: spacing) { content }
            }
        }
    }
}

struct TechMetricGrid<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1
    var minimum: CGFloat
    let content: Content

    init(minimum: CGFloat = 100, @ViewBuilder content: () -> Content) {
        self.minimum = minimum
        self.content = content()
    }

    var body: some View {
        LazyVGrid(columns: typeSize.isAccessibilitySize
                  ? [GridItem(.flexible(), alignment: .leading)]
                  : [GridItem(.adaptive(minimum: minimum * scale), spacing: 12, alignment: .leading)],
                  alignment: .leading, spacing: 12) { content }
    }
}

/// Display sizes stay recognisable at the default size and follow Dynamic Type.
enum TechFontRole {
    case display, hero, metric, compactMetric, pageTitle, section, label

    var size: CGFloat {
        switch self {
        case .display: return 60
        case .hero: return 52
        case .metric: return 32
        case .compactMetric: return 22
        case .pageTitle: return 28
        case .section: return 17
        case .label: return 12
        }
    }

    var weight: Font.Weight {
        switch self {
        case .display, .hero: return .heavy
        case .metric, .compactMetric, .pageTitle, .section: return .bold
        case .label: return .medium
        }
    }

    var relativeTo: Font.TextStyle {
        switch self {
        case .display, .hero: return .largeTitle
        case .metric, .pageTitle: return .title
        case .compactMetric: return .title3
        case .section: return .headline
        case .label: return .caption
        }
    }
}

private struct TechScaledFont: ViewModifier {
    @ScaledMetric private var size: CGFloat
    let weight: Font.Weight
    init(size: CGFloat, weight: Font.Weight, relativeTo: Font.TextStyle) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: relativeTo)
        self.weight = weight
    }
    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight))
    }
}

extension View {
    func techFont(_ role: TechFontRole) -> some View {
        techScaledFont(role.size, weight: role.weight, relativeTo: role.relativeTo)
    }

    func techScaledFont(_ size: CGFloat, weight: Font.Weight = .semibold,
                        relativeTo: Font.TextStyle = .title) -> some View {
        modifier(TechScaledFont(size: size, weight: weight, relativeTo: relativeTo))
    }
}

/// Feedback is local to the pressed control; no perpetual or whole-page animation.
struct TechPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Rectangle())
            .opacity(isEnabled && configuration.isPressed ? 0.78 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: configuration.isPressed)
    }
}

/// Used on forms with numeric keyboards, which don't provide a Return key.
struct TechKeyboardDismiss: ViewModifier {
    func body(content: Content) -> some View {
        content
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("完成输入") {
                        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder),
                                                        to: nil, from: nil, for: nil)
                    }
                    .accessibilityIdentifier("keyboard.done")
                }
            }
    }
}
#endif
