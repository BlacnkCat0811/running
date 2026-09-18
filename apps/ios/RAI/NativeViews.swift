#if os(iOS)
import SwiftUI

// iOS 原生壳。这里是**唯一**的原生入口：底部 Tab + 五个页面。
//
// 2026-09-18 起原生端只有一套视觉（冰蓝科技），页面实现在
// `RAI/Skins/Technology/TechViews.swift`。此文件只保留壳层本身：
// Tab 模型（`NativeTab`）与根视图（`NativeRootView`）。
// 曾经的像素皮肤（`PixelTheme` / `PixelCharts` / `PixelIcons` /
// `PixelTabBar` 与本文件里的像素页面）已整体删除。

/// 原生五入口 Tab。`TechTabBar` 与 UI 回归（`tab.<标题>`）都依赖这个顺序。
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

struct NativeRootView: View {
    @Environment(NativeAppModel.self) private var native
    @Environment(ServerSession.self) private var session
    @Environment(HealthKitSync.self) private var healthSync
    @State private var selectedTab: NativeTab = .home

    var body: some View {
        ZStack {
            TechBackground()
            // Reserve real layout space for chrome. A safeAreaInset outside
            // NavigationStack did not reach its scrolling destinations and
            // required a hard-coded 90pt spacer in every page.
            VStack(spacing: 0) {
                navigationContent.clipped()
                TechTabBar(selection: $selectedTab)
            }
        }
        .task(id: session.serverURLString + "\n" + session.apiToken) {
            native.serverConfigurationChanged()
            await native.bootstrap()
        }
        .onChange(of: healthSync.dataUpdatedGeneration) { _, _ in
            Task {
                await native.refreshAll()
                await native.refreshBodyMetrics()
            }
        }
        .sheet(isPresented: Binding(
            get: { native.errorMessage != nil },
            set: { if !$0 { native.errorMessage = nil } }
        )) {
            TechRequestFailure(message: native.errorMessage ?? "")
        }
    }

    private var navigationContent: some View {
        Group {
            switch selectedTab {
            case .home:
                NavigationStack { TechTodayView() }
            case .workouts:
                NavigationStack { TechWorkoutsView() }
            case .statistics:
                NavigationStack { TechAnalysisView(initialMode: "statistics") }
            case .trends:
                NavigationStack { TechAnalysisView(initialMode: "trends") }
            case .settings:
                NavigationStack { TechNativeSettingsView() }
            }
        }
    }
}
#endif
