#if os(iOS)
import SwiftUI

// iOS 原生壳。这里是**唯一**的原生入口：底部 Tab + 五个页面。
//
// 原生端只有一套视觉（清新），页面实现在
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
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedTab: NativeTab = .home
    /// 2026-10-18（事故复盘 P0-3 复查）：后台窗口完成的健康同步不在当时发 UI 级读，
    /// 但 `refreshBodyMetrics` 没有别的触发入口（`refreshAll` 不读预测/仪表盘/体重），
    /// 因此记下这次完成，回前台补刷一次。
    @State private var bodyMetricsRefreshPending = false

    var body: some View {
        ZStack {
            TechBackground()
            // Reserve real layout space for the tab bar. A safeAreaInset outside
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
        .task(id: reminderSnapshot) {
            guard scenePhase == .active else { return }
            // 2026-10-18（审查 P2-10）：教练闭环也必须有明确的提醒上下文；
            // 不能再把 `canConfirmToday`（闭环下恒 false）当作提醒可用性。
            let context = native.reminderContext
            await TrainingReminders.shared.reconcile(scope: native.feedbackScope, plan: context.plan,
                completed: context.completedDates, available: context.available)
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            // HealthKit updates are not guaranteed at a civil-date boundary.
            // Refresh once on foreground and once just after the next plan day
            // begins so the coach, today's recommendation and the executable
            // Watch week cannot remain on yesterday's snapshot.
            await native.refreshAll()
            // 2026-10-18（事故复盘 P0-3 复查）：后台完成的同步不直接发 UI 级读，改为
            // 回前台补刷 body metrics（`refreshAll` 不读预测/仪表盘/体重，没有别的入口）。
            if bodyMetricsRefreshPending {
                bodyMetricsRefreshPending = false
                await native.refreshBodyMetrics()
            }
            // 2026-10-18（事故复盘 P0-6）：回到前台也要让"正打开的那条训练"跟上 ——
            // 后台窗口里发生的同步不会发 UI 级读，这里补一次（自身仍是"有打开会话且 stale"
            // 才真的发请求，且只在 freshness/分析仍可能变化时才重取）。
            await native.reloadOpenWorkoutIfStale(isForeground: true)
            while !Task.isCancelled {
                let timezone = TimeZone(identifier: native.today?.timezone ?? "Asia/Shanghai") ?? .current
                var calendar = Calendar(identifier: .gregorian)
                calendar.timeZone = timezone
                let start = calendar.startOfDay(for: Date())
                let next = calendar.date(byAdding: .day, value: 1, to: start) ?? Date().addingTimeInterval(86_400)
                let delay = max(1, next.timeIntervalSinceNow + 1)
                do {
                    try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                } catch {
                    return
                }
                guard !Task.isCancelled else { return }
                await native.refreshAll()
            }
        }
        .onChange(of: healthSync.dataUpdatedGeneration) { _, _ in
            Task {
                // 2026-10-18（事故复盘 P0-3）：同步成功（+1）不等于"用户正在看"。
                // 后台窗口里发起的 UI 级读会带着 15s/60s 超时跨过后台到期点，进程被
                // 挂起后请求冻结、恢复前台时集中以 -1001 报出。回前台时
                // `.task(id: scenePhase)` 已经会 refreshAll 一次，这里只在前台补刷。
                guard scenePhase == .active else {
                    // 后台窗口：不发起 UI 级读，只记下这次同步，回前台补刷一次。
                    bodyMetricsRefreshPending = true
                    return
                }
                await native.refreshAll()
                await native.refreshBodyMetrics()
                // 2026-10-18（事故复盘 P0-6）：`refreshAll` **不碰** `selectedWorkout` /
                // `selectedSeries`，所以数据到了、正打开的那条训练还是旧的（服务端证据
                // 12:29:42Z 列表已变，App 直到 12:31:55Z 才读新详情）。这里并排补一次
                // 有界重取：只在有打开会话、且它确实 stale 时才发读（判据在
                // `WorkoutFreshnessPresentation.shouldReload`，350 ms 合并窗口在模型里）。
                await native.reloadOpenWorkoutIfStale(isForeground: true)
            }
        }

    }

    private var reminderSnapshot: String {
        let context = native.reminderContext
        let plan = context.plan.flatMap { try? JSONEncoder().encode($0) }.map { String(decoding: $0, as: UTF8.self) } ?? ""
        return native.feedbackScope + "\(native.currentPlanRevision)" + String(native.isCoachLoopManaged) +
            plan + context.completedDates.sorted().joined() +
            String(TrainingReminders.storedHour(scope: native.feedbackScope)) +
            String(context.available) + String(describing: scenePhase)
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
