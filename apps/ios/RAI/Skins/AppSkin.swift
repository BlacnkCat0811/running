import Foundation

/// Stable persisted identifiers; unknown values safely fall back to the original skin.
enum AppSkin: String, CaseIterable, Identifiable {
    case pixel
    case technology

    static let storageKey = "rai.appearance.skin"
    static func resolve(_ rawValue: String) -> AppSkin { AppSkin(rawValue: rawValue) ?? .pixel }
    var id: String { rawValue }
    var title: String { self == .pixel ? "清新像素" : "冰蓝科技" }
}

#if os(iOS)
import SwiftUI

private struct AppSkinKey: EnvironmentKey {
    static let defaultValue = AppSkin.pixel
}

extension EnvironmentValues {
    var appSkin: AppSkin {
        get { self[AppSkinKey.self] }
        set { self[AppSkinKey.self] = newValue }
    }
}

struct AppSkinPicker: View {
    @AppStorage(AppSkin.storageKey) private var rawSkin = AppSkin.pixel.rawValue
    @Environment(\.appSkin) private var skin

    var body: some View {
        Group {
            if skin == .technology {
                TechPanel { choices }
            } else {
                PixelPanel { choices }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("appearance.picker")
    }

    private var choices: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("外观皮肤")
                .font(.headline)
                .foregroundStyle(skin == .technology ? TechColor.ink : PixelColor.ink)
            HStack(spacing: 12) {
                ForEach(AppSkin.allCases) { option in
                    Button { rawSkin = option.rawValue } label: {
                        VStack(alignment: .leading, spacing: 9) {
                            SkinSwatch(skin: option)
                                .frame(height: 76)
                            HStack(spacing: 4) {
                                Text(option.title).font(.subheadline.weight(.semibold))
                                Spacer(minLength: 0)
                                Image(systemName: AppSkin.resolve(rawSkin) == option ? "checkmark.circle.fill" : "circle")
                            }
                        }
                        .foregroundStyle(skin == .technology ? TechColor.ink : PixelColor.ink)
                        .padding(10)
                        .background {
                            RoundedRectangle(cornerRadius: skin == .technology ? 16 : 0)
                                .stroke(AppSkin.resolve(rawSkin) == option
                                    ? (skin == .technology ? TechColor.cyan : PixelColor.green)
                                    : (skin == .technology ? TechColor.grid : PixelColor.grid), lineWidth: 2)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(option.title)
                    .accessibilityAddTraits(AppSkin.resolve(rawSkin) == option ? .isSelected : [])
                    .accessibilityIdentifier("appearance.\(option.rawValue)")
                }
            }
            Text("立即应用，重新打开应用后仍保留。")
                .font(.caption)
                .foregroundStyle(skin == .technology ? TechColor.muted : PixelColor.muted)
        }
    }
}

private struct SkinSwatch: View {
    let skin: AppSkin
    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                Circle().stroke(skin == .technology ? TechColor.grid : PixelColor.mint, lineWidth: 5)
                Circle().trim(from: 0, to: 0.75)
                    .stroke(skin == .technology ? TechColor.cyan : PixelColor.green,
                            style: StrokeStyle(lineWidth: 5, lineCap: skin == .technology ? .round : .butt))
                    .rotationEffect(.degrees(-90))
            }.frame(width: 35, height: 35)
            VStack(alignment: .leading, spacing: 6) {
                Text("RAI").font(.caption.bold())
                RoundedRectangle(cornerRadius: skin == .technology ? 3 : 0)
                    .fill(skin == .technology ? TechColor.cyan : PixelColor.green).frame(height: 4)
                RoundedRectangle(cornerRadius: skin == .technology ? 3 : 0)
                    .fill(skin == .technology ? TechColor.grid : PixelColor.grid).frame(width: 28, height: 4)
            }
        }
        .foregroundStyle(skin == .technology ? TechColor.ink : PixelColor.ink)
        .padding(12)
        .background(skin == .technology ? TechColor.background : PixelColor.paper,
                    in: RoundedRectangle(cornerRadius: skin == .technology ? 12 : 0))
        .accessibilityHidden(true)
    }
}
#endif
