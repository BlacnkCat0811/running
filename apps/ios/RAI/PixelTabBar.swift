#if os(iOS)
import SwiftUI

enum NativeTab: Int, CaseIterable, Hashable {
    case home
    case workouts
    case statistics
    case trends
    case settings

    var title: String {
        switch self {
        case .home: return "今日"
        case .workouts: return "训练"
        case .statistics: return "统计"
        case .trends: return "趋势"
        case .settings: return "设置"
        }
    }

    var systemName: String {
        switch self {
        case .home: return "sun.max.fill"
        case .workouts: return "figure.run"
        case .statistics: return "chart.bar.fill"
        case .trends: return "chart.line.uptrend.xyaxis"
        case .settings: return "gearshape.fill"
        }
    }
}

struct PixelTabBar: View {
    @Binding var selection: NativeTab
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 4) {
            ForEach(NativeTab.allCases, id: \.self) { tab in
                Button {
                    if reduceMotion {
                        selection = tab
                    } else {
                        withAnimation(.easeOut(duration: 0.12)) {
                            selection = tab
                        }
                    }
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: tab.systemName)
                            .font(.system(size: 19, weight: .heavy))
                            .frame(height: 22)
                        Text(tab.title)
                            .font(.caption2.weight(.heavy))
                    }
                    .foregroundStyle(selection == tab ? PixelColor.green : PixelColor.muted)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(selection == tab ? PixelColor.mint : .clear)
                    .overlay(
                        Rectangle()
                            .stroke(selection == tab ? PixelColor.ink : .clear, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == tab ? .isSelected : [])
                .accessibilityLabel(tab.title)
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 7)
        .padding(.bottom, 5)
        .background(PixelColor.paper)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(PixelColor.ink)
                .frame(height: PixelMetrics.border)
        }
        // Keep navigation text crisp; a view-level shadow creates ghost labels.
    }
}
#endif
