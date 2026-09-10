#if os(iOS)
import Charts
import CoreLocation
import MapKit
import SwiftUI
import UIKit

struct NativeRootView: View {
    @Environment(\.appSkin) private var skin
    @Environment(NativeAppModel.self) private var native
    @Environment(ServerSession.self) private var session
    @Environment(HealthKitSync.self) private var healthSync
    @State private var selectedTab: NativeTab = .home

    var body: some View {
        ZStack {
            if skin == .technology { TechBackground() } else { PixelBackground() }
            Group {
                switch selectedTab {
                case .home:
                    NavigationStack { if skin == .technology { TechTodayView() } else { TodayView() } }
                case .workouts:
                    NavigationStack { if skin == .technology { TechWorkoutsView() } else { WorkoutsView() } }
                case .statistics:
                    NavigationStack { if skin == .technology { TechAnalysisView(initialMode: "statistics") } else { AnalysisView(initialMode: "statistics") } }
                case .trends:
                    NavigationStack { if skin == .technology { TechAnalysisView(initialMode: "trends") } else { AnalysisView(initialMode: "trends") } }
                case .settings:
                    NavigationStack { if skin == .technology { TechNativeSettingsView() } else { NativeSettingsView() } }
                }
            }
            // Destinations belong to a skin. Recreate only the navigation subtree
            // on a skin change; selectedTab and all environment services stay alive.
            .id(skin)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if skin == .technology { TechTabBar(selection: $selectedTab) }
            else { PixelTabBar(selection: $selectedTab) }
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
        .alert("请求未完成", isPresented: Binding(
            get: { skin == .pixel && native.errorMessage != nil },
            set: { if !$0 { native.errorMessage = nil } }
        )) {
            Button("知道了", role: .cancel) { native.errorMessage = nil }
        } message: {
            Text(native.errorMessage ?? "")
        }
        .sheet(isPresented: Binding(
            get: { skin == .technology && native.errorMessage != nil },
            set: { if !$0 { native.errorMessage = nil } }
        )) {
            TechRequestFailure(message: native.errorMessage ?? "")
        }
    }
}

struct PixelPageHeader<Trailing: View>: View {
    let title: String
    let eyebrow: String
    let trailing: Trailing

    init(
        title: String,
        eyebrow: String = "RAI / RUNNING INTELLIGENCE",
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.title = title
        self.eyebrow = eyebrow
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(eyebrow)
                    .font(.caption2.weight(.heavy))
                    .tracking(1)
                    .foregroundStyle(PixelColor.green)
                Text(title)
                    .font(.system(size: 27, weight: .heavy, design: .rounded))
                    .foregroundStyle(PixelColor.ink)
            }
            Spacer(minLength: 8)
            trailing
        }
        .padding(.horizontal, 4)
        .padding(.bottom, 4)
    }
}

struct TodayView: View {
    @Environment(NativeAppModel.self) private var native
    @Environment(ServerSession.self) private var session
    @Environment(HealthKitSync.self) private var healthSync

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PixelMetrics.sectionSpacing) {
                PixelPageHeader(title: "今天") {
                    HStack(spacing: 7) {
                        VStack(spacing: 2) {
                        PixelIconButton(systemName: "heart.text.square", accessibilityLabel: "同步健康数据", color: PixelColor.coral) {
                            Task {
                                await healthSync.sync(to: session.serverURL, apiToken: session.apiToken)
                                await native.refreshAll(requestHandshake: false)
                            }
                        }
                        .disabled(healthSync.isBusy || native.isOffline)
                        Text("同步").font(.caption2.weight(.bold)).foregroundStyle(PixelColor.muted)
                        }
                        VStack(spacing: 2) {
                        PixelIconButton(systemName: "arrow.clockwise", accessibilityLabel: "刷新首页") {
                            Task { await native.refreshAll() }
                        }
                        .disabled(native.isRefreshing)
                        Text("刷新").font(.caption2.weight(.bold)).foregroundStyle(PixelColor.muted)
                        }
                        VStack(spacing: 2) {
                        NavigationLink {
                            PlanView()
                        } label: {
                            Image(systemName: "calendar")
                                .font(.system(size: 15, weight: .heavy))
                                .foregroundStyle(PixelColor.green)
                                .frame(width: 38, height: 34)
                                .background(PixelColor.paper)
                                .overlay(Rectangle().stroke(PixelColor.green, lineWidth: PixelMetrics.border))
                                .shadow(color: PixelColor.ink.opacity(0.14), radius: 0, x: 2, y: 2)
                        }
                        .accessibilityLabel("打开训练计划")
                        Text("计划").font(.caption2.weight(.bold)).foregroundStyle(PixelColor.muted)
                        }
                    }
                }

                if let today = native.today {
                    FreshnessBanner(today: today, isOffline: native.isOffline, cacheDate: native.lastCacheUpdate)
                    todayHero(today)
                    activityPanel(today)
                    abilityPanel(today)
                    verdictPanel(today)
                    contextPanel(today)
                    recentPanel(today)
                    TodayDetailLinks(data: today)
                } else if native.isLoading {
                    PixelPanel { PixelLoadingState(title: "正在读取 RAI 服务") }
                } else {
                    PixelPanel(tint: PixelColor.cyan) {
                        PixelEmptyState(
                            title: "尚未连接 RAI 服务",
                            message: "请在设置中填写手机可访问的服务地址。",
                            systemName: "server.rack"
                        )
                    }
                }
            }
            .padding(.horizontal, PixelMetrics.pageHorizontal)
            .padding(.top, PixelMetrics.pageVertical)
            .padding(.bottom, 18)
        }
        .scrollIndicators(.hidden)
        .refreshable { await native.refreshAll() }
        .toolbar(.hidden, for: .navigationBar)
    }

    private func todayHero(_ data: MobileTodayResponse) -> some View {
        PixelHeroCard {
            ZStack(alignment: .topTrailing) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(data.today.workoutCount > 0 ? "今日跑步 · 已完成" : "今日训练 · 等待出发")
                        .font(.caption.weight(.heavy))
                        .foregroundStyle(.white.opacity(0.9))
                        .tracking(0.5)
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(nativeNumber(data.today.distanceKm, digits: 2))
                            .font(.system(size: 38, weight: .heavy, design: .monospaced))
                            .foregroundStyle(.white)
                        Text("公里")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(.white.opacity(0.85))
                    }
                    HStack(spacing: 7) {
                        heroMetric("时长", nativeDuration(data.today.durationSeconds))
                        heroMetric("配速", "\(nativePace(data.today.paceSecondsPerKm))/km")
                        heroMetric("千卡", data.today.energyKcal.map { nativeNumber($0, digits: 0) } ?? "--")
                    }
                }
                PixelRunnerIcon(size: 46)
                    .padding(.top, 2)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("今日跑步，距离 \(nativeKilometers(data.today.distanceKm))，时长 \(nativeDuration(data.today.durationSeconds))，配速 \(nativePace(data.today.paceSecondsPerKm))/km")
    }

    private func heroMetric(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.system(.subheadline, design: .monospaced).weight(.heavy))
                .lineLimit(1)
                .minimumScaleFactor(0.65)
            Text(title)
                .font(.caption2.weight(.bold))
                .foregroundStyle(PixelColor.muted)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PixelColor.paper)
        .overlay(Rectangle().stroke(PixelColor.ink, lineWidth: PixelMetrics.smallBorder))
        .shadow(color: PixelColor.ink.opacity(0.12), radius: 0, x: 1, y: 1)
    }

    private func activityPanel(_ data: MobileTodayResponse) -> some View {
        let goalProgress = data.week.goalProgressFraction ?? 0
        let qualityCap = max(data.weekStructure.qualitySessionCap, 1)
        let qualityProgress = min(Double(data.weekStructure.qualitySessionCount) / Double(qualityCap), 1)
        let easyHonesty = data.weekStructure.easyHonesty.honestyFraction ?? 0

        return PixelPanel {
            HStack(alignment: .center, spacing: 14) {
                PixelRing(
                    progress: goalProgress,
                    value: nativePercent(data.week.goalProgressFraction),
                    label: "周目标",
                    tint: PixelColor.coral
                )
                VStack(alignment: .leading, spacing: 10) {
                    PixelStatLine(
                        label: "里程",
                        value: nativeKilometers(data.week.distanceKm),
                        tint: PixelColor.coral,
                        fraction: goalProgress
                    )
                    PixelStatLine(
                        label: "质量",
                        value: "\(data.weekStructure.qualitySessionCount)/\(data.weekStructure.qualitySessionCap)",
                        tint: PixelColor.green,
                        fraction: qualityProgress
                    )
                    PixelStatLine(
                        label: "轻松度",
                        value: nativePercent(data.weekStructure.easyHonesty.honestyFraction),
                        tint: PixelColor.yellow,
                        fraction: easyHonesty
                    )
                }
            }
        }
    }

    private func abilityPanel(_ data: MobileTodayResponse) -> some View {
        PixelPanel {
            VStack(alignment: .leading, spacing: 11) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        PixelSectionHeader(title: "当前跑力", trailing: nativeStatusName(data.calibration.status), trailingColor: PixelColor.cyan)
                        Text(nativeNumber(data.ability.trueAbility, digits: 1))
                            .font(.system(size: 42, weight: .heavy, design: .monospaced))
                            .foregroundStyle(PixelColor.coral)
                        Text(data.ability.explanation)
                            .font(.footnote)
                            .foregroundStyle(PixelColor.muted)
                    }
                    Spacer(minLength: 10)
                    VStack(alignment: .trailing, spacing: 7) {
                        metricCaption("近 7 天", value: nativeSigned(data.ability.changeFrom7DaysAgo))
                        metricCaption("增长速度", value: nativeNumber(data.ability.growthVelocityPerWeek))
                        metricCaption("衰减", value: nativeNumber(data.ability.decayPoints))
                    }
                    .frame(width: 86, alignment: .trailing)
                }
                if data.calibration.status != "ready" {
                    Text(data.calibration.message)
                        .font(.caption)
                        .foregroundStyle(PixelColor.muted)
                        .padding(9)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(PixelColor.paleYellow)
                        .overlay(Rectangle().stroke(PixelColor.yellow, lineWidth: 1))
                }
            }
        }
    }

    private func verdictPanel(_ data: MobileTodayResponse) -> some View {
        let tone = nativeToneColor(data.verdict.tone)
        return PixelPanel(tint: tone) {
            VStack(alignment: .leading, spacing: 11) {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: data.verdict.tone == "green" ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                        .font(.system(size: 24, weight: .heavy))
                        .foregroundStyle(tone)
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 7) {
                            Text(data.verdict.title)
                                .font(.headline.weight(.heavy))
                                .foregroundStyle(PixelColor.ink)
                        }
                        Text(data.verdict.reason)
                            .font(.subheadline)
                            .foregroundStyle(PixelColor.muted)
                        if data.nextSession.kind != "rest" {
                            Text("下一课：\(data.nextSession.title) · \(nativeKilometers(data.nextSession.distanceKm))")
                                .font(.footnote.weight(.heavy))
                                .foregroundStyle(PixelColor.ink)
                        }
                    }
                }
                if !data.verdict.triggers.isEmpty {
                    FlowLayout(spacing: 6) {
                        ForEach(data.verdict.triggers.prefix(3), id: \.code) { trigger in
                            PixelBadge(title: trigger.detail, color: tone, fill: tone.opacity(0.1))
                        }
                    }
                }
                if data.lock.present {
                    HStack(spacing: 7) {
                        Image(systemName: "lock.fill")
                        Text("今日安排已锁定")
                        Spacer()
                        Text("服务端已确认")
                            .font(.caption2)
                    }
                    .font(.footnote.weight(.heavy))
                    .foregroundStyle(PixelColor.green)
                } else if !data.verdict.stale {
                    PixelPrimaryButton(
                        title: "锁定今日安排",
                        systemName: "lock.open",
                        isBusy: native.isLockingSession,
                        isDisabled: native.isOffline
                    ) {
                        Task { _ = await native.lockNextSession() }
                    }
                }
            }
        }
    }

    private func weekPanel(_ data: MobileTodayResponse) -> some View {
        PixelPanel {
            VStack(alignment: .leading, spacing: 11) {
                PixelSectionHeader(title: "本周里程", trailing: nativePercent(data.week.goalProgressFraction), trailingColor: PixelColor.coral)
                HStack(alignment: .firstTextBaseline) {
                    Text(nativeKilometers(data.week.distanceKm))
                        .font(.system(.title3, design: .monospaced).weight(.heavy))
                        .foregroundStyle(PixelColor.ink)
                    Text("/ \(nativeKilometers(data.week.goalDistanceKm))")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(PixelColor.muted)
                    Spacer()
                    Text("\(data.week.workoutCount) 次")
                        .font(.footnote.weight(.heavy))
                        .foregroundStyle(PixelColor.green)
                }
                PixelWeekBars(points: data.weekDaily, today: data.today.localDate)
            }
        }
    }

    private func recoveryPanel(_ data: MobileTodayResponse) -> some View {
        let recoveryColor = data.recovery.state == "recovered" ? PixelColor.green : PixelColor.yellow
        return PixelPanel(tint: recoveryColor) {
            VStack(alignment: .leading, spacing: 11) {
                PixelSectionHeader(title: "恢复", trailing: data.recovery.stateLabel, trailingColor: recoveryColor)
                HStack(spacing: 8) {
                    PixelMetricTile(title: "睡眠", value: data.recovery.lastNightSleepMinutes.map { "\(nativeNumber($0, digits: 0)) 分" } ?? "无记录", accent: PixelColor.cyan)
                    PixelMetricTile(title: "HRV", value: data.recovery.morningHrvMs.map { "\(nativeNumber($0)) ms" } ?? "无记录", accent: PixelColor.green)
                    PixelMetricTile(title: "静息心率", value: data.recovery.restingHeartRateBpm.map { nativeNumber($0, digits: 0) } ?? "无记录", accent: PixelColor.coral)
                }
                Text(data.recovery.note)
                    .font(.footnote)
                    .foregroundStyle(PixelColor.muted)
            }
        }
    }

    private func planPanel(_ data: MobileTodayResponse) -> some View {
        PixelPanel {
            VStack(alignment: .leading, spacing: 9) {
                PixelSectionHeader(title: "本周计划", trailing: "质量课 \(data.weekStructure.qualitySessionCount)/\(data.weekStructure.qualitySessionCap)")
                ForEach(data.weekPlan) { day in
                    HStack(spacing: 9) {
                        Text(nativeWeekday(day.localDate))
                            .font(.caption.weight(.heavy).monospacedDigit())
                            .frame(width: 35, alignment: .leading)
                        Image(systemName: day.completedWorkoutId == nil ? "square" : "checkmark.square.fill")
                            .foregroundStyle(day.completedWorkoutId == nil ? PixelColor.grid : PixelColor.green)
                        Text(day.title)
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(PixelColor.ink)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : "休息")
                            .font(.caption.weight(.heavy).monospacedDigit())
                            .foregroundStyle(day.distanceKm > 0 ? PixelColor.green : PixelColor.muted)
                    }
                    .padding(.vertical, 5)
                    .overlay(alignment: .bottom) {
                        Rectangle()
                            .fill(PixelColor.grid.opacity(0.55))
                            .frame(height: 1)
                    }
                }
                if !data.injuryFlags.isEmpty {
                    ForEach(data.injuryFlags) { flag in
                        HStack(alignment: .top, spacing: 7) {
                            Image(systemName: "cross.case.fill")
                            Text("\(flag.title)：\(flag.detail)")
                        }
                        .font(.caption)
                        .foregroundStyle(PixelColor.coral)
                    }
                }
            }
        }
    }

    private func recentPanel(_ data: MobileTodayResponse) -> some View {
        PixelPanel {
            VStack(alignment: .leading, spacing: 5) {
                PixelSectionHeader(title: "最近训练", trailing: "全部 ›")
                ForEach(data.recentWorkouts.prefix(5)) { workout in
                    NavigationLink {
                        WorkoutDetailView(workoutId: workout.id)
                    } label: {
                        WorkoutRow(workout: workout)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private struct TodayDetailLinks: View {
        let data: MobileTodayResponse

        var body: some View {
            VStack(alignment: .leading, spacing: 8) {
                PixelSectionHeader(title: "深入查看", trailing: "更多详情", trailingColor: PixelColor.cyan)
                HStack(spacing: 8) {
                    NavigationLink {
                        WeekOverviewView(data: data)
                    } label: {
                        detailLink(
                            title: "本周活动",
                            subtitle: "\(data.week.workoutCount) 次 · \(nativeKilometers(data.week.distanceKm))",
                            systemName: "calendar",
                            tint: PixelColor.green,
                            fill: PixelColor.mint
                        )
                    }
                    .buttonStyle(.plain)

                    NavigationLink {
                        BodyMetricsView(data: data)
                    } label: {
                        detailLink(
                            title: "身体指标",
                            subtitle: data.recovery.state == "recovered" ? "状态良好" : nativeStatusName(data.recovery.state),
                            systemName: "heart.text.square.fill",
                            tint: PixelColor.coral,
                            fill: PixelColor.paleCoral
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }

        private func detailLink(
            title: String,
            subtitle: String,
            systemName: String,
            tint: Color,
            fill: Color
        ) -> some View {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: systemName)
                    .font(.system(size: 19, weight: .heavy))
                    .foregroundStyle(tint)
                Text(title)
                    .font(.subheadline.weight(.heavy))
                    .foregroundStyle(PixelColor.ink)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(PixelColor.muted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
            .padding(11)
            .background(fill)
            .overlay(Rectangle().stroke(tint, lineWidth: PixelMetrics.border))
            .shadow(color: PixelColor.ink.opacity(0.1), radius: 0, x: 2, y: 2)
        }
    }

    private func contextPanel(_ data: MobileTodayResponse) -> some View {
        VStack(alignment: .leading, spacing: PixelMetrics.sectionSpacing) {
            PixelPanel(tint: PixelColor.cyan) {
                VStack(alignment: .leading, spacing: 8) {
                    PixelSectionHeader(title: "训练阶段", trailing: data.phase, trailingColor: PixelColor.cyan)
                    HStack {
                        Text(data.race.note)
                            .font(.footnote)
                            .foregroundStyle(PixelColor.muted)
                        Spacer()
                        if let days = data.race.daysUntil {
                            Text(days >= 0 ? "还有 \(days) 天" : "已结束")
                                .font(.caption.weight(.heavy).monospacedDigit())
                                .foregroundStyle(PixelColor.cyan)
                        }
                    }
                    if let target = data.race.target {
                        Text("比赛目标：\(target.distance) · \(nativeDay(target.date))")
                            .font(.caption.weight(.heavy))
                            .foregroundStyle(PixelColor.ink)
                        HStack(spacing: 8) {
                            metricCaption("目标配速", value: "\(nativePace(target.targetPaceSecondsPerKm))/km")
                            metricCaption("体型分", value: nativeNumber(data.race.shapeScore))
                            metricCaption("减量", value: data.race.taper ? "是" : "否")
                        }
                    }
                    if let remaining = data.weekStructure.remainingDistanceKm {
                        Text("本周剩余建议：\(nativeKilometers(remaining)) · \(data.weekStructure.easyHonesty.note)")
                            .font(.caption)
                            .foregroundStyle(PixelColor.muted)
                    }
                }
            }
            if let postRun = data.postRun {
                PixelPanel(tint: PixelColor.coral, fill: PixelColor.paleCoral) {
                    VStack(alignment: .leading, spacing: 7) {
                        PixelSectionHeader(title: "最近一次训练反馈", trailing: nativeSessionName(postRun.sessionType), trailingColor: PixelColor.coral)
                        Text(postRun.headline)
                            .font(.subheadline.weight(.heavy))
                            .foregroundStyle(PixelColor.ink)
                        Text("刺激：\(nativeStimulusName(postRun.stimulusType)) · 匹配：\(postRun.stimulusMatch)")
                            .font(.caption)
                            .foregroundStyle(PixelColor.muted)
                        if let delta = postRun.trueAbilityDelta {
                            Text("跑力变化：\(nativeSigned(delta))")
                                .font(.caption.weight(.heavy).monospacedDigit())
                                .foregroundStyle(delta >= 0 ? PixelColor.green : PixelColor.coral)
                        }
                        ForEach(postRun.details, id: \.self) { detail in
                            Text("· \(detail)")
                                .font(.caption)
                                .foregroundStyle(PixelColor.muted)
                        }
                    }
                }
            }
        }
    }
}

struct WeekOverviewView: View {
    let data: MobileTodayResponse

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PixelMetrics.sectionSpacing) {
                PixelPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        PixelSectionHeader(title: "本周概览", trailing: nativePercent(data.week.goalProgressFraction), trailingColor: PixelColor.coral)
                        HStack(spacing: 8) {
                            PixelMetricTile(title: "跑量", value: nativeKilometers(data.week.distanceKm), accent: PixelColor.coral)
                            PixelMetricTile(title: "训练次数", value: "\(data.week.workoutCount)", accent: PixelColor.green)
                            PixelMetricTile(title: "总时长", value: nativeDuration(data.week.durationSeconds), accent: PixelColor.cyan)
                        }
                        PixelProgressBar(
                            fraction: data.week.goalProgressFraction ?? 0,
                            tint: PixelColor.coral,
                            height: 10
                        )
                        Text("目标 \(nativeKilometers(data.week.goalDistanceKm)) · \(data.week.periodStart) – \(data.week.periodEnd)")
                            .font(.caption)
                            .foregroundStyle(PixelColor.muted)
                    }
                }

                PixelPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        PixelSectionHeader(title: "每日活动", trailing: "周一 – 周日")
                        PixelWeekBars(points: data.weekDaily, today: data.today.localDate)
                    }
                }

                PixelPanel {
                    VStack(alignment: .leading, spacing: 8) {
                        PixelSectionHeader(title: "训练结构", trailing: "本周")
                        PixelStatLine(
                            label: "质量",
                            value: "\(data.weekStructure.qualitySessionCount)/\(data.weekStructure.qualitySessionCap)",
                            tint: PixelColor.green,
                            fraction: data.weekStructure.qualitySessionCap > 0
                                ? Double(data.weekStructure.qualitySessionCount) / Double(data.weekStructure.qualitySessionCap)
                                : 0
                        )
                        PixelStatLine(
                            label: "轻松度",
                            value: nativePercent(data.weekStructure.easyHonesty.honestyFraction),
                            tint: PixelColor.yellow,
                            fraction: data.weekStructure.easyHonesty.honestyFraction
                        )
                        if let remaining = data.weekStructure.remainingDistanceKm {
                            Text("距离周目标还差 \(nativeKilometers(remaining))")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(PixelColor.muted)
                        }
                    }
                }

                PixelPanel {
                    VStack(alignment: .leading, spacing: 8) {
                        PixelSectionHeader(title: "本周计划", trailing: "完成情况")
                        ForEach(data.weekPlan) { day in
                            HStack(spacing: 9) {
                                Image(systemName: day.completedWorkoutId == nil ? "square" : "checkmark.square.fill")
                                    .foregroundStyle(day.completedWorkoutId == nil ? PixelColor.grid : PixelColor.green)
                                Text(nativeWeekday(day.localDate))
                                    .font(.caption.weight(.heavy))
                                    .frame(width: 35, alignment: .leading)
                                Text(day.title)
                                    .font(.subheadline.weight(.bold))
                                    .lineLimit(1)
                                Spacer()
                                Text(day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : "休息")
                                    .font(.caption.weight(.heavy).monospacedDigit())
                                    .foregroundStyle(day.distanceKm > 0 ? PixelColor.green : PixelColor.muted)
                            }
                            .padding(.vertical, 6)
                            .overlay(alignment: .bottom) {
                                Rectangle().fill(PixelColor.grid.opacity(0.55)).frame(height: 1)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, PixelMetrics.pageHorizontal)
            .padding(.vertical, PixelMetrics.pageVertical)
            .padding(.bottom, 18)
        }
        .scrollIndicators(.hidden)
        .navigationTitle("本周活动")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PixelColor.paper, for: .navigationBar)
        .toolbarColorScheme(.light, for: .navigationBar)
    }
}

struct BodyMetricsView: View {
    @Environment(NativeAppModel.self) private var native
    let data: MobileTodayResponse

    private var summary: MobileTodayResponse {
        native.today ?? data
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PixelMetrics.sectionSpacing) {
                readinessPanel
                coreMetricsPanel
                pacePanel
                recoveryPanel
                zonePanels
                predictionsPanel

                if let error = native.bodyMetricsError {
                    PixelPanel(tint: PixelColor.yellow, fill: PixelColor.paleYellow) {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(PixelColor.yellow)
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(PixelColor.muted)
                        }
                    }
                }

                if !summary.injuryFlags.isEmpty {
                    PixelPanel(tint: PixelColor.coral, fill: PixelColor.paleCoral) {
                        VStack(alignment: .leading, spacing: 8) {
                            PixelSectionHeader(title: "需要留意", trailing: "\(summary.injuryFlags.count) 项", trailingColor: PixelColor.coral)
                            ForEach(summary.injuryFlags) { flag in
                                HStack(alignment: .top, spacing: 7) {
                                    Image(systemName: "cross.case.fill")
                                    Text("\(flag.title)：\(flag.detail)")
                                }
                                .font(.footnote)
                                .foregroundStyle(PixelColor.coral)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, PixelMetrics.pageHorizontal)
            .padding(.vertical, PixelMetrics.pageVertical)
            .padding(.bottom, 18)
        }
        .scrollIndicators(.hidden)
        .navigationTitle("身体指标")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PixelColor.paper, for: .navigationBar)
        .toolbarColorScheme(.light, for: .navigationBar)
        .task {
            await native.refreshBodyMetrics()
        }
        .refreshable {
            await native.refreshBodyMetrics()
        }
    }

    private var readinessPanel: some View {
        let readiness = native.predictions?.inputs.recoveryReadiness
        let status = native.trainingStatistics?.status?.trainingStatus
        let evidence = native.trainingStatistics?.status?.recoveryEvidence
        return PixelHeroCard {
            HStack(spacing: 14) {
                PixelRing(
                    progress: readiness ?? 0,
                    value: nativePercent(readiness),
                    label: "恢复准备程度",
                    tint: PixelColor.coral,
                    size: 92
                )
                VStack(alignment: .leading, spacing: 6) {
                    Text("身体状态")
                        .font(.caption.weight(.heavy))
                        .foregroundStyle(.white.opacity(0.9))
                    Text(nativeStatusName(status))
                        .font(.title3.weight(.heavy))
                        .foregroundStyle(.white)
                    Text(evidence.map { "恢复证据 \(nativePercent($0))" } ?? "基于睡眠、HRV 与近期负荷")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.78))
                }
                Spacer(minLength: 0)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("恢复准备程度 \(nativePercent(readiness))，身体状态 \(nativeStatusName(status))")
    }

    private var coreMetricsPanel: some View {
        PixelPanel {
            VStack(alignment: .leading, spacing: 10) {
                PixelSectionHeader(title: "核心能力", trailing: "预测快照", trailingColor: PixelColor.cyan)
                HStack(spacing: 8) {
                    metricTile(title: "最大摄氧量", value: nativeNumber(native.predictions?.snapshot.vo2Max.valueMlKgMin, digits: 1), unit: "ml/kg/min", accent: PixelColor.cyan)
                    metricTile(title: "VDOT", value: nativeNumber(native.predictions?.snapshot.performanceVdot.value, digits: 1), unit: "有效跑力", accent: PixelColor.green)
                }
                HStack(spacing: 8) {
                    metricTile(title: "乳酸阈配速", value: nativePace(native.predictions?.snapshot.lactateThreshold.paceSecondsPerKm), unit: "/km", accent: PixelColor.coral)
                    metricTile(title: "阈值心率", value: native.predictions?.snapshot.lactateThreshold.heartRateBpm.map { nativeNumber($0, digits: 0) } ?? "--", unit: "bpm", accent: PixelColor.yellow)
                }
            }
        }
    }

    private var pacePanel: some View {
        let latest = native.dashboard?.latestWorkout?.averagePaceSecondsPerKm
        let rolling = native.trainingStatistics?.rolling28Days?.averagePaceSecondsPerKm
        let easy = native.trainingZones?.profile.paceBands.first { $0.zone == "easy" }
        return PixelPanel {
            VStack(alignment: .leading, spacing: 10) {
                PixelSectionHeader(title: "配速参考", trailing: "当前数据", trailingColor: PixelColor.cyan)
                HStack(spacing: 8) {
                    metricTile(title: "最近训练平均配速", value: nativePace(latest), unit: "/km", accent: PixelColor.green)
                    metricTile(title: "轻松跑配速", value: paceRange(easy?.lowerSecondsPerKm, easy?.upperSecondsPerKm), unit: nil, accent: PixelColor.cyan)
                }
                if let rolling {
                    Text("近 28 天平均配速：\(nativePace(rolling))/km。训练平均配速不等于轻松跑处方。")
                        .font(.caption)
                        .foregroundStyle(PixelColor.muted)
                } else {
                    Text("轻松跑配速来自当前训练分区快照，建议按区间而非单点执行。")
                        .font(.caption)
                        .foregroundStyle(PixelColor.muted)
                }
            }
        }
    }

    private var recoveryPanel: some View {
        PixelPanel(tint: recoveryTint) {
            VStack(alignment: .leading, spacing: 10) {
                PixelSectionHeader(title: "恢复明细", trailing: nativeStatusName(summary.recovery.state), trailingColor: recoveryTint)
                HStack(spacing: 8) {
                    PixelMetricTile(title: "睡眠", value: nativeHoursMinutes(summary.recovery.lastNightSleepMinutes), accent: PixelColor.cyan)
                    PixelMetricTile(title: "HRV", value: summary.recovery.morningHrvMs.map { "\(nativeNumber($0)) ms" } ?? "无记录", accent: PixelColor.green)
                    PixelMetricTile(title: "静息心率", value: summary.recovery.restingHeartRateBpm.map { nativeNumber($0, digits: 0) } ?? "无记录", accent: PixelColor.coral)
                }
                bodyMetricRow("睡眠基线", value: summary.recovery.sleepBaselineMinutes.map { nativeHoursMinutes($0) })
                bodyMetricRow("HRV 基线", value: summary.recovery.hrvBaselineMs.map { "\(nativeNumber($0)) ms" })
                bodyMetricRow("静息心率基线", value: summary.recovery.restingHeartRateBaselineBpm.map { "\(nativeNumber($0, digits: 0)) bpm" })
                Text(summary.recovery.note)
                    .font(.footnote)
                    .foregroundStyle(PixelColor.muted)
            }
        }
    }

    @ViewBuilder
    private var zonePanels: some View {
        if let profile = native.trainingZones?.profile {
            PixelPanel {
                VStack(alignment: .leading, spacing: 9) {
                    PixelSectionHeader(title: "心率分区", trailing: "\(nativeNumber(profile.restingHeartRateBpm, digits: 0))–\(nativeNumber(profile.maximumHeartRateBpm, digits: 0)) bpm", trailingColor: PixelColor.coral)
                    ForEach(profile.heartRateBands) { band in
                        zoneRow(label: nativeHeartRateZone(band.zone), value: "\(band.lowerBpm.map { nativeNumber($0, digits: 0) } ?? "--")–\(band.upperBpm.map { nativeNumber($0, digits: 0) } ?? "--") bpm", tint: nativeHeartRateZoneColor(band.zone))
                    }
                }
            }
            PixelPanel(tint: PixelColor.cyan) {
                VStack(alignment: .leading, spacing: 9) {
                    PixelSectionHeader(title: "配速分区", trailing: "按阈值配速计算", trailingColor: PixelColor.cyan)
                    ForEach(profile.paceBands) { band in
                        zoneRow(label: nativePaceZone(band.zone), value: paceRange(band.lowerSecondsPerKm, band.upperSecondsPerKm), tint: nativePaceZoneColor(band.zone))
                    }
                }
            }
        } else if native.isLoadingBodyMetrics {
            PixelPanel { PixelLoadingState(title: "正在读取训练分区") }
        } else {
            PixelPanel(tint: PixelColor.yellow, fill: PixelColor.paleYellow) {
                PixelEmptyState(title: "训练分区暂不可用", message: "完成一次重新计算后，心率和配速分区会显示在这里。", systemName: "chart.bar.xaxis")
            }
        }
    }

    private var predictionsPanel: some View {
        PixelPanel(tint: PixelColor.yellow) {
            VStack(alignment: .leading, spacing: 9) {
                PixelSectionHeader(title: "成绩预测", trailing: "区间参考", trailingColor: PixelColor.yellow)
                Text("根据当前 VDOT、准备度和训练证据估算，不代表比赛承诺。")
                    .font(.caption)
                    .foregroundStyle(PixelColor.muted)
                if let races = native.predictions?.snapshot.races, !races.isEmpty {
                    ForEach(races) { race in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "flag.checkered")
                                .foregroundStyle(PixelColor.yellow)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(nativeRaceDistance(race.distance))
                                    .font(.subheadline.weight(.heavy))
                                Text(racePredictionText(race))
                                    .font(.caption.weight(.bold).monospacedDigit())
                                    .foregroundStyle(PixelColor.muted)
                            }
                            Spacer()
                            Text(nativePercent(race.readiness))
                                .font(.caption2.weight(.heavy).monospacedDigit())
                                .foregroundStyle(PixelColor.yellow)
                        }
                        .padding(.vertical, 7)
                        .overlay(alignment: .bottom) {
                            Rectangle().fill(PixelColor.grid.opacity(0.55)).frame(height: 1)
                        }
                    }
                } else {
                    Text("暂无可用成绩预测")
                        .font(.footnote)
                        .foregroundStyle(PixelColor.muted)
                }
            }
        }
    }

    private var recoveryTint: Color {
        summary.recovery.state == "recovered" ? PixelColor.green : PixelColor.yellow
    }

    private func metricTile(title: String, value: String, unit: String?, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption2.weight(.bold))
                .foregroundStyle(PixelColor.muted)
                .lineLimit(1)
            Text(value)
                .font(.system(.subheadline, design: .monospaced).weight(.heavy))
                .foregroundStyle(accent)
                .lineLimit(1)
                .minimumScaleFactor(0.55)
            if let unit {
                Text(unit)
                    .font(.caption2)
                    .foregroundStyle(PixelColor.muted)
                    .lineLimit(1)
            }
        }
        .padding(9)
        .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        .background(PixelColor.paper)
        .overlay(Rectangle().stroke(PixelColor.ink.opacity(0.8), lineWidth: PixelMetrics.smallBorder))
    }

    private func zoneRow(label: String, value: String, tint: Color) -> some View {
        HStack(spacing: 8) {
            Rectangle().fill(tint).frame(width: 9, height: 9).overlay(Rectangle().stroke(PixelColor.ink.opacity(0.5), lineWidth: 1))
            Text(label)
                .font(.caption.weight(.bold))
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(value)
                .font(.caption2.weight(.heavy).monospacedDigit())
                .foregroundStyle(PixelColor.ink)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 5)
        .overlay(alignment: .bottom) {
            Rectangle().fill(PixelColor.grid.opacity(0.55)).frame(height: 1)
        }
    }

    private func bodyMetricRow(_ label: String, value: String?) -> some View {
        HStack {
            Text(label).font(.caption.weight(.bold))
            Spacer()
            Text(value ?? "无记录")
                .font(.caption.weight(.heavy).monospacedDigit())
                .foregroundStyle(value == nil ? PixelColor.muted : PixelColor.ink)
        }
        .padding(.vertical, 5)
    }

    private func paceRange(_ lower: Double?, _ upper: Double?) -> String {
        switch (lower, upper) {
        case (nil, nil): return "暂不可用"
        case let (lower?, nil): return "\(nativePace(lower))/km 或更慢"
        case let (nil, upper?): return "不快于 \(nativePace(upper))/km"
        case let (lower?, upper?): return "\(nativePace(lower))/km–\(nativePace(upper))/km"
        }
    }

    private func nativePaceZone(_ value: String) -> String {
        switch value {
        case "easy": return "轻松区"
        case "marathon": return "马拉松区"
        case "lactate_threshold": return "阈值区"
        case "anaerobic_endurance": return "无氧耐力区"
        case "sprint": return "冲刺区"
        default: return "配速区间"
        }
    }

    private func nativePaceZoneColor(_ value: String) -> Color {
        switch value {
        case "easy": return PixelColor.leaf
        case "marathon": return PixelColor.cyan
        case "lactate_threshold": return PixelColor.yellow
        case "anaerobic_endurance": return PixelColor.coral
        case "sprint": return PixelColor.ink
        default: return PixelColor.grid
        }
    }

    private func nativeRaceDistance(_ value: String) -> String {
        switch value {
        case "five_k": return "5 公里"
        case "ten_k": return "10 公里"
        case "half_marathon": return "半马"
        default: return value
        }
    }

    private func racePredictionText(_ race: NativeRacePrediction) -> String {
        let predicted = race.predictedSeconds.map(nativeDuration) ?? "--"
        let optimistic = race.optimisticSeconds.map(nativeDuration) ?? "--"
        let pessimistic = race.pessimisticSeconds.map(nativeDuration) ?? "--"
        return "预测 \(predicted) · 区间 \(optimistic)–\(pessimistic)"
    }
}

struct FreshnessBanner: View {
    let today: MobileTodayResponse
    let isOffline: Bool
    let cacheDate: Date?

    private var tint: Color {
        if isOffline { return PixelColor.cyan }
        if today.freshness.state == "stale" || today.verdict.stale { return PixelColor.yellow }
        return PixelColor.green
    }

    var body: some View {
        PixelPanel(tint: tint, fill: tint.opacity(0.08), shadowColor: tint.opacity(0.15)) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: isOffline ? "wifi.slash" : today.freshness.state == "stale" ? "clock.badge.exclamationmark" : "antenna.radiowaves.left.and.right")
                    .font(.system(size: 15, weight: .heavy))
                    .foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(isOffline ? "离线缓存" : "数据状态")
                            .font(.caption.weight(.heavy))
                        Spacer()
                        Text(nativeStatusName(today.freshness.state))
                            .font(.caption2.weight(.heavy))
                    }
                    Text("健康数据截至 \(nativeDay(today.latestDataDate ?? "未知")) · 结果生成于 \(nativeDate(today.generatedAt))")
                        .font(.caption)
                        .foregroundStyle(PixelColor.muted)
                    if let cacheDate {
                        Text("缓存更新于 \(nativeDate(ISO8601DateFormatter().string(from: cacheDate)))")
                            .font(.caption2)
                            .foregroundStyle(PixelColor.muted)
                    }
                }
            }
            .foregroundStyle(PixelColor.ink)
        }
    }
}

struct WorkoutsView: View {
    @Environment(NativeAppModel.self) private var native

    private let filters: [(String, String?)] = [
        ("全部", nil),
        ("轻松跑", "easy"),
        ("稳态跑", "steady"),
        ("长距离", "long_run"),
        ("节奏跑", "tempo"),
        ("间歇跑", "interval")
    ]

    private var selectedFilter: Binding<String> {
        Binding(
            get: { native.workoutSessionType ?? "all" },
            set: {
                native.workoutSessionType = $0 == "all" ? nil : $0
                Task { await native.refreshWorkouts() }
            }
        )
    }

    private var monthWorkoutCount: String {
        guard let count = native.trainingStatistics?.month?.workoutCount else { return "--" }
        return String(count)
    }

    private var monthDistance: String {
        guard let meters = native.trainingStatistics?.month?.distanceMeters else { return "--" }
        return nativeKilometers(meters / 1000)
    }

    private var monthDuration: String {
        nativeDuration(native.trainingStatistics?.month?.durationSeconds)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PixelMetrics.sectionSpacing) {
                PixelPageHeader(title: "训练") {
                    PixelBadge(title: "共 \(native.workoutTotal) 次", color: PixelColor.cyan, fill: PixelColor.paleCyan)
                }
                PixelSegmentedControl(
                    items: filters.map { (title: $0.0, value: $0.1 ?? "all") },
                    selection: selectedFilter
                )
                HStack(spacing: 8) {
                    PixelMetricTile(title: "本月次数", value: monthWorkoutCount, accent: PixelColor.green)
                    PixelMetricTile(title: "本月里程", value: monthDistance, accent: PixelColor.coral)
                    PixelMetricTile(title: "本月时长", value: monthDuration, accent: PixelColor.cyan)
                }
                if native.workouts.isEmpty && native.isLoadingWorkouts {
                    PixelLoadingState(title: "正在读取训练")
                } else if native.workouts.isEmpty {
                    PixelPanel(tint: PixelColor.cyan) {
                        PixelEmptyState(title: "暂无训练", message: "同步 Apple 健康或刷新 RAI 服务后重试。", systemName: "figure.run.circle")
                    }
                } else {
                    PixelPanel {
                        VStack(spacing: 0) {
                            ForEach(native.workouts) { workout in
                                NavigationLink {
                                    WorkoutDetailView(workoutId: workout.id)
                                } label: {
                                    WorkoutRow(workout: workout)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    if native.workouts.count < native.workoutTotal {
                        PixelPrimaryButton(
                            title: "加载更多",
                            systemName: "chevron.down",
                            isBusy: native.isLoadingWorkouts,
                            isDisabled: native.isLoadingWorkouts || native.isRefreshing
                        ) {
                            Task { await native.loadMoreWorkouts() }
                        }
                    }
                }
            }
            .padding(.horizontal, PixelMetrics.pageHorizontal)
            .padding(.top, PixelMetrics.pageVertical)
            .padding(.bottom, 18)
        }
        .scrollIndicators(.hidden)
        .navigationTitle("")
        .toolbar(.hidden, for: .navigationBar)
        .task {
            if native.trainingStatistics?.month == nil { await native.refreshTrainingStatistics() }
            if native.workouts.isEmpty { await native.refreshWorkouts() }
        }
        .refreshable {
            await native.refreshTrainingStatistics()
            await native.refreshWorkouts()
        }
    }
}

struct WorkoutRow: View {
    let workout: WorkoutListItem

    private var tint: Color { nativeSessionColor(workout.sessionType) }

    var body: some View {
        HStack(spacing: 10) {
            PixelIconBox(
                systemName: nativeSessionSymbol(workout.sessionType, indoor: workout.indoor == true),
                tint: tint,
                fill: tint.opacity(0.12)
            )
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(nativeSessionName(workout.sessionType))
                        .font(.subheadline.weight(.heavy))
                        .foregroundStyle(PixelColor.ink)
                    if workout.indoor == true { PixelBadge(title: "室内", color: PixelColor.cyan, fill: PixelColor.paleCyan) }
                }
                Text(nativeDate(workout.startedAt))
                    .font(.caption)
                    .foregroundStyle(PixelColor.muted)
                HStack(spacing: 7) {
                    Text(nativeKilometers(workout.distanceKm))
                    Text(nativeDuration(workout.durationSeconds))
                    Text("\(nativePace(workout.averagePaceSecondsPerKm))/km")
                }
                .font(.caption2.weight(.bold).monospacedDigit())
                .foregroundStyle(PixelColor.muted)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 5) {
                Text(nativeKilometers(workout.distanceKm))
                    .font(.system(.subheadline, design: .monospaced).weight(.heavy))
                    .foregroundStyle(tint)
                PixelBadge(
                    title: nativeStatusName(workout.assessmentStatus),
                    color: workout.assessmentStatus == "excluded" ? PixelColor.coral : PixelColor.green,
                    fill: workout.assessmentStatus == "excluded" ? PixelColor.paleCoral : PixelColor.mint
                )
                if workout.hasRoute {
                    Image(systemName: "map.fill")
                        .font(.caption2.weight(.heavy))
                        .foregroundStyle(PixelColor.cyan)
                }
            }
        }
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(PixelColor.grid.opacity(0.55))
                .frame(height: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(nativeSessionName(workout.sessionType))，\(nativeDate(workout.startedAt))，\(nativeKilometers(workout.distanceKm))，\(nativePace(workout.averagePaceSecondsPerKm))/km")
    }
}

struct WorkoutDetailView: View {
    @Environment(NativeAppModel.self) private var native
    let workoutId: String
    @State private var selectedMetric = "heartRate"

    private let metricItems = [
        ("心率", "heartRate"),
        ("速度", "speed"),
        ("功率", "power"),
        ("步频", "cadence"),
        ("海拔", "elevation"),
        ("步幅", "strideLength"),
        ("垂直", "verticalOscillation"),
        ("触地", "groundContactTime")
    ]

    var body: some View {
        ScrollView {
            if let detail = native.selectedWorkout, detail.workout.id == workoutId {
                VStack(alignment: .leading, spacing: PixelMetrics.sectionSpacing) {
                    if let error = native.workoutDetailError {
                        Text(error).font(.footnote).foregroundStyle(PixelColor.coral)
                    }
                    detailHeader(detail.workout)
                    detailMetrics(detail.workout)
                    if !detail.route.isEmpty { routePanel(detail.route) }
                    if let series = native.selectedSeries { seriesPanel(series) }
                    splitPanel(native.selectedSeries?.splits ?? [])
                    qualityPanel(detail)
                    if let load = detail.trainingLoad { trainingLoadPanel(load) }
                    if let zones = detail.zoneSummary { zonePanel(zones) }
                    if let override = detail.override { overridePanel(override) }
                }
                .padding(.horizontal, PixelMetrics.pageHorizontal)
                .padding(.vertical, PixelMetrics.pageVertical)
            } else if let error = native.workoutDetailError, !native.isLoadingWorkout {
                VStack(spacing: 12) {
                    PixelEmptyState(title: "训练详情暂不可用", message: error, systemName: "wifi.exclamationmark")
                    PixelPrimaryButton(title: "重新加载", systemName: "arrow.clockwise") {
                        Task { await native.loadWorkout(id: workoutId) }
                    }
                }
                .padding(.horizontal, PixelMetrics.pageHorizontal)
            } else {
                PixelLoadingState(title: "正在读取训练详情")
                    .padding(.horizontal, PixelMetrics.pageHorizontal)
            }
        }
        .scrollIndicators(.hidden)
        .navigationTitle("训练详情")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PixelColor.paper, for: .navigationBar)
        .toolbarColorScheme(.light, for: .navigationBar)
        .task(id: workoutId) { await native.loadWorkout(id: workoutId) }
        .refreshable { await native.loadWorkout(id: workoutId) }
    }

    private func detailHeader(_ workout: WorkoutDetail) -> some View {
        PixelHeroCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(nativeSessionName(workout.sessionType))
                        .font(.title2.weight(.heavy))
                    Spacer()
                    PixelRunnerIcon(size: 34)
                }
                Text(nativeDate(workout.startedAt))
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.85))
                HStack(spacing: 7) {
                    PixelBadge(title: nativeStimulusName(workout.stimulusType), color: PixelColor.ink, fill: .white)
                    PixelBadge(title: nativeStatusName(workout.assessmentStatus), color: PixelColor.green, fill: PixelColor.mint)
                    if workout.indoor == true { PixelBadge(title: "室内", color: PixelColor.cyan, fill: PixelColor.paleCyan) }
                }
            }
            .foregroundStyle(.white)
        }
    }

    private func detailMetrics(_ workout: WorkoutDetail) -> some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
            PixelMetricTile(title: "距离", value: nativeKilometers(workout.distanceKm), accent: PixelColor.coral)
            PixelMetricTile(title: "时长", value: nativeDuration(workout.durationSeconds), accent: PixelColor.green)
            PixelMetricTile(title: "配速", value: "\(nativePace(workout.averagePaceSecondsPerKm))/km", accent: PixelColor.cyan)
            PixelMetricTile(title: "平均心率", value: workout.averageHeartRateBpm.map { "\(nativeNumber($0, digits: 0)) bpm" } ?? "--")
            PixelMetricTile(title: "步频", value: workout.averageCadenceSpm.map { "\(nativeNumber($0, digits: 0)) spm" } ?? "--")
            PixelMetricTile(title: "功率", value: workout.averagePowerWatts.map { "\(nativeNumber($0, digits: 0)) W" } ?? "--")
            PixelMetricTile(title: "步幅", value: workout.averageStrideLengthMeters.map { "\(nativeNumber($0)) m" } ?? "--")
            PixelMetricTile(title: "垂直振幅", value: workout.averageVerticalOscillationCm.map { "\(nativeNumber($0)) cm" } ?? "--")
            PixelMetricTile(title: "触地时间", value: workout.averageGroundContactTimeMs.map { "\(nativeNumber($0, digits: 0)) ms" } ?? "--")
            PixelMetricTile(title: "爬升", value: workout.elevationGainMeters.map { "\(nativeNumber($0, digits: 0)) m" } ?? "--", accent: PixelColor.yellow)
            PixelMetricTile(title: "能量", value: workout.activeEnergyKcal.map { "\(nativeNumber($0, digits: 0)) kcal" } ?? "--", accent: PixelColor.coral)
            PixelMetricTile(title: "质量分", value: nativeNumber(workout.qualityScore), accent: PixelColor.green)
        }
    }

    private func routePanel(_ route: [RoutePoint]) -> some View {
        PixelPanel(tint: PixelColor.cyan) {
            VStack(alignment: .leading, spacing: 9) {
                PixelSectionHeader(title: "路线", trailing: "\(route.count) 个点", trailingColor: PixelColor.cyan)
                if route.count > 1 {
                    TechRouteView(route: route)
                } else {
                    Text("路线数据不足")
                        .font(.footnote)
                        .foregroundStyle(PixelColor.muted)
                }
            }
        }
    }

    private func seriesPanel(_ series: WorkoutSeriesResponse) -> some View {
        let metric = metricSeries(from: series.series, key: selectedMetric)
        return PixelPanel {
            VStack(alignment: .leading, spacing: 10) {
                PixelSectionHeader(title: "训练时序", trailing: "\(metric.totalSamples) 点", trailingColor: PixelColor.cyan)
                ScrollView(.horizontal, showsIndicators: false) {
                    PixelSegmentedControl(
                        items: metricItems.map { (title: $0.0, value: $0.1) },
                        selection: $selectedMetric
                    )
                    .frame(minWidth: 610)
                }
                if metric.points.isEmpty {
                    Text("没有可展示的\(metric.unit)样本")
                        .font(.footnote)
                        .foregroundStyle(PixelColor.muted)
                        .frame(maxWidth: .infinity, minHeight: 120)
                } else if selectedMetric == "heartRate" {
                    NativeHeartRateChart(metric: metric,
                        averageHeartRate: native.selectedWorkout?.workout.averageHeartRateBpm,
                        durationSeconds: native.selectedWorkout?.workout.elapsedSeconds ?? 0)
                } else {
                    Chart(metric.points) { point in
                        LineMark(
                            x: .value("时间", point.offsetSeconds),
                            y: .value(metric.unit, point.value)
                        )
                        .foregroundStyle(PixelColor.green)
                        .interpolationMethod(.stepEnd)
                        PointMark(
                            x: .value("时间", point.offsetSeconds),
                            y: .value(metric.unit, point.value)
                        )
                        .foregroundStyle(PixelColor.coral)
                    }
                    .frame(height: 190)
                    .chartPlotStyle { plot in
                        plot.background(PixelColor.mint.opacity(0.35))
                            .overlay(Rectangle().stroke(PixelColor.grid, lineWidth: 1))
                    }
                    .chartXAxisLabel("秒")
                    .chartYAxisLabel(metric.unit)
                }
            }
        }
    }

    private func metricSeries(from series: WorkoutSeries, key: String) -> MetricSeries {
        switch key {
        case "speed": return series.speed
        case "power": return series.power
        case "cadence": return series.cadence
        case "elevation": return series.elevation
        case "strideLength": return series.strideLength
        case "verticalOscillation": return series.verticalOscillation
        case "groundContactTime": return series.groundContactTime
        default: return series.heartRate
        }
    }

    private func splitPanel(_ splits: [WorkoutSplit]) -> some View {
        PixelPanel {
            VStack(alignment: .leading, spacing: 4) {
                PixelSectionHeader(title: "分段", trailing: "\(splits.count) 段")
                if splits.isEmpty {
                    Text("没有分段数据")
                        .font(.footnote)
                        .foregroundStyle(PixelColor.muted)
                } else {
                    ForEach(splits) { split in
                        HStack(spacing: 8) {
                            Text(split.distanceMeters < 999.5 ? "尾段" : "\(split.index) km")
                                .font(.subheadline.weight(.heavy))
                                .frame(width: 52, alignment: .leading)
                            Spacer()
                            Text("\(nativePace(split.averagePaceSecondsPerKm))/km")
                            Text(split.averageHeartRateBpm.map { "\(nativeNumber($0, digits: 0)) bpm" } ?? "--")
                        }
                        .font(.caption.weight(.bold).monospacedDigit())
                        .foregroundStyle(PixelColor.muted)
                        .padding(.vertical, 7)
                        .overlay(alignment: .bottom) { Rectangle().fill(PixelColor.grid).frame(height: 1) }
                    }
                }
            }
        }
    }

    private func qualityPanel(_ detail: WorkoutDetailResponse) -> some View {
        PixelPanel {
            VStack(alignment: .leading, spacing: 10) {
                PixelSectionHeader(title: "质量与模型", trailing: detail.workout.modelVersion, trailingColor: PixelColor.cyan)
                HStack(spacing: 8) {
                    PixelMetricTile(title: "心率覆盖", value: nativePercent(detail.workout.heartRateCoverage), accent: PixelColor.coral)
                    PixelMetricTile(title: "来源可信度", value: nativePercent(detail.workout.sourceConfidence), accent: PixelColor.green)
                    PixelMetricTile(title: "刺激可信度", value: nativePercent(detail.workout.stimulusConfidence), accent: PixelColor.yellow)
                }
                HStack(spacing: 8) {
                    metricCaption("评估状态", value: nativeStatusName(detail.workout.assessmentStatus))
                    metricCaption("样本数", value: "\(detail.workout.heartRateSampleCount)")
                    metricCaption("路线质量", value: nativePercent(detail.workout.routeQuality))
                }
                if !detail.workout.missingReasons.isEmpty {
                    Text("数据不足：\(detail.workout.missingReasons.joined(separator: "、"))")
                        .font(.footnote)
                        .foregroundStyle(PixelColor.coral)
                }
                if !detail.workout.explanationCodes.isEmpty {
                    Text(detail.workout.explanationCodes.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(PixelColor.muted)
                }
            }
        }
    }

    private func trainingLoadPanel(_ load: WorkoutTrainingLoad) -> some View {
        PixelPanel(tint: PixelColor.coral) {
            VStack(alignment: .leading, spacing: 10) {
                PixelSectionHeader(title: "训练负荷", trailing: nativeNumber(load.load), trailingColor: PixelColor.coral)
                HStack(spacing: 8) {
                    PixelMetricTile(title: "强度", value: nativeNumber(load.intensity), accent: PixelColor.coral)
                    PixelMetricTile(title: "置信度", value: nativePercent(load.confidence), accent: PixelColor.green)
                    PixelMetricTile(title: "心率", value: load.averageHeartRate.map { nativeNumber($0, digits: 0) } ?? "--", accent: PixelColor.cyan)
                }
                Text("来源：\(load.source) · 刺激：\(nativeStimulusName(load.stimulusType))")
                    .font(.caption)
                    .foregroundStyle(PixelColor.muted)
                ForEach(load.explanations, id: \.code) { explanation in
                    Text(explanation.code + (explanation.value.map { " · \(nativeNumber($0))" } ?? ""))
                        .font(.caption2)
                        .foregroundStyle(PixelColor.muted)
                }
            }
        }
    }

    private func zonePanel(_ zones: WorkoutZoneSummary) -> some View {
        PixelPanel(tint: PixelColor.yellow) {
            VStack(alignment: .leading, spacing: 9) {
                PixelSectionHeader(title: "区间暴露", trailing: nativeStimulusName(zones.stimulusType), trailingColor: PixelColor.yellow)
                Text("心率覆盖 \(nativePercent(zones.heartRateCoverage)) · 配速覆盖 \(nativePercent(zones.paceCoverage))")
                    .font(.caption)
                    .foregroundStyle(PixelColor.muted)
                ForEach(zones.heartRateExposure) { zone in
                    PixelStatLine(
                        label: nativeHeartRateZone(zone.zone),
                        value: nativePercent(zone.fraction),
                        tint: nativeHeartRateZoneColor(zone.zone),
                        fraction: zone.fraction
                    )
                }
                if !zones.secondaryStimulusTypes.isEmpty {
                    Text("次要刺激：\(zones.secondaryStimulusTypes.map(nativeStimulusName).joined(separator: "、"))")
                        .font(.caption)
                        .foregroundStyle(PixelColor.muted)
                }
            }
        }
    }

    private func overridePanel(_ override: WorkoutOverride) -> some View {
        PixelPanel(tint: PixelColor.cyan) {
            VStack(alignment: .leading, spacing: 7) {
                PixelSectionHeader(title: "人工覆盖", trailing: "v\(override.revision)", trailingColor: PixelColor.cyan)
                if let value = override.eligibilityOverride { Text("纳入状态：\(value)") }
                if let value = override.statisticsParticipation { Text("统计参与：\(value)") }
                if let value = override.sessionType { Text("训练类型：\(nativeSessionName(value))") }
                if let value = override.performanceProtocol { Text("表现协议：\(value)") }
                if let value = override.rpe { Text("RPE：\(nativeNumber(value))") }
                if !override.conditionTags.isEmpty { Text("状态标签：\(override.conditionTags.joined(separator: "、"))") }
                if let value = override.note, !value.isEmpty { Text(value) }
            }
            .font(.footnote)
            .foregroundStyle(PixelColor.muted)
        }
    }
}

struct PlanView: View {
    @Environment(NativeAppModel.self) private var native
    @State private var weeklyText = "30"
    @State private var easyFloor = 0.8
    @State private var qualityCap = 2
    @State private var weekPlan: [MobileGoalsPlanItem] = []
    @State private var distanceDrafts: [String: String] = [:]
    @State private var isSaving = false
    @State private var saveMessage: String?

    private var weeklyValue: Double? { Double(weeklyText.trimmingCharacters(in: .whitespacesAndNewlines)) }
    private var areDistancesValid: Bool {
        weekPlan.allSatisfy { item in
            let text = (distanceDrafts[item.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty || Double(text).map { $0.isFinite && (0...80).contains($0) } == true
        }
    }
    private var isWeeklyValid: Bool { weeklyValue.map { (1...500).contains($0) } ?? false }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PixelMetrics.sectionSpacing) {
                PixelPageHeader(title: "计划") {
                    if let goals = native.goals { PixelBadge(title: "v\(goals.revision)", color: PixelColor.cyan, fill: PixelColor.paleCyan) }
                }
                goalEditor
                weekPlanPanel
                racePanel
                if let saveMessage {
                    PixelPanel(tint: saveMessage.hasPrefix("已") ? PixelColor.green : PixelColor.coral, fill: saveMessage.hasPrefix("已") ? PixelColor.mint : PixelColor.paleCoral) {
                        Text(saveMessage)
                            .font(.footnote.weight(.bold))
                            .foregroundStyle(saveMessage.hasPrefix("已") ? PixelColor.green : PixelColor.coral)
                    }
                }
            }
            .padding(.horizontal, PixelMetrics.pageHorizontal)
            .padding(.top, PixelMetrics.pageVertical)
            .padding(.bottom, 18)
        }
        .scrollIndicators(.hidden)
        .navigationTitle("训练计划")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .scrollDismissesKeyboard(.interactively)
        .task {
            if native.goals == nil { await native.refreshAll() }
            loadDraft()
        }
        .onChange(of: native.goals?.revision) { _, _ in loadDraft() }
    }

    private var goalEditor: some View {
        PixelPanel {
            VStack(alignment: .leading, spacing: 13) {
                PixelSectionHeader(title: "周目标", trailing: "1–500 km")
                PixelField("每周跑量") {
                    HStack {
                        TextField("30", text: $weeklyText)
                            .keyboardType(.decimalPad)
                            .textInputAutocapitalization(.never)
                        Text("km")
                            .foregroundStyle(PixelColor.muted)
                    }
                }
                if !weeklyText.isEmpty && !isWeeklyValid {
                    Text("请输入 1 到 500 km 的目标。")
                        .font(.caption)
                        .foregroundStyle(PixelColor.coral)
                }
                VStack(alignment: .leading, spacing: 7) {
                    HStack {
                        Text("轻松训练时长下限")
                            .font(.caption.weight(.heavy))
                            .foregroundStyle(PixelColor.green)
                        Spacer()
                        Text(nativePercent(easyFloor))
                            .font(.caption.weight(.heavy).monospacedDigit())
                            .foregroundStyle(PixelColor.coral)
                    }
                    Slider(value: $easyFloor, in: 0.4...0.95, step: 0.05)
                        .tint(PixelColor.coral)
                }
                HStack {
                    Text("质量课上限")
                        .font(.caption.weight(.heavy))
                        .foregroundStyle(PixelColor.green)
                    Spacer()
                    Stepper("\(qualityCap) 次", value: $qualityCap, in: 0...4)
                        .labelsHidden()
                    Text("\(qualityCap) 次")
                        .font(.footnote.weight(.heavy).monospacedDigit())
                }
                PixelPrimaryButton(title: "保存到 RAI 服务", systemName: "checkmark", isBusy: isSaving, isDisabled: isSaving || !isWeeklyValid || !areDistancesValid || native.isOffline || native.goals == nil) {
                    Task { await save() }
                }
            }
        }
    }

    private var weekPlanPanel: some View {
        PixelPanel {
            VStack(alignment: .leading, spacing: 8) {
                PixelSectionHeader(title: "本周安排", trailing: "逐日计划")
                if !areDistancesValid {
                    Text("每日距离请输入 0–80 km，留空表示未设置。")
                        .font(.caption).foregroundStyle(PixelColor.coral)
                }
                if weekPlan.isEmpty {
                    Text("服务端尚未保存逐日计划")
                        .font(.footnote)
                        .foregroundStyle(PixelColor.muted)
                } else {
                    ForEach(weekPlan.indices, id: \.self) { index in
                        let item = weekPlan[index]
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(nativeWeekday(item.localDate))
                                    .font(.subheadline.weight(.heavy))
                                    .foregroundStyle(PixelColor.ink)
                                Spacer()
                                TextField("距离 km", text: Binding(
                                    get: { distanceDrafts[item.id] ?? "" },
                                    set: { distanceDrafts[item.id] = $0 }
                                ))
                                .keyboardType(.decimalPad)
                                .multilineTextAlignment(.trailing)
                                .font(.footnote.monospacedDigit())
                                .padding(7)
                                .frame(width: 88)
                                .background(PixelColor.paper)
                                .overlay(Rectangle().stroke(PixelColor.green, lineWidth: 1))
                            }
                            Picker("训练类型", selection: $weekPlan[index].kind) {
                                Text("休息").tag("rest")
                                Text("恢复跑").tag("recovery")
                                Text("轻松跑").tag("easy")
                                Text("稳态跑").tag("steady")
                                Text("长距离").tag("long_run")
                                Text("节奏跑").tag("tempo")
                                Text("间歇跑").tag("interval")
                            }
                            .pickerStyle(.menu)
                            .tint(PixelColor.green)
                        }
                        .padding(.vertical, 8)
                        .overlay(alignment: .bottom) { Rectangle().fill(PixelColor.grid).frame(height: 1) }
                    }
                }
            }
        }
    }

    private var racePanel: some View {
        Group {
            if let goals = native.goals {
                PixelPanel(tint: PixelColor.cyan) {
                    VStack(alignment: .leading, spacing: 8) {
                        PixelSectionHeader(title: "比赛目标", trailing: goals.lockedSession == nil ? "未锁定" : "已锁定", trailingColor: PixelColor.cyan)
                        if let race = goals.raceTarget {
                            Text("\(race.distance) · \(nativeDay(race.date))")
                                .font(.headline.weight(.heavy))
                            Text(race.targetPaceSecondsPerKm.map { "目标配速：\(nativePace($0))/km" } ?? "未设置目标配速")
                                .font(.footnote)
                                .foregroundStyle(PixelColor.muted)
                        } else {
                            Text("尚未设置比赛目标。")
                                .font(.footnote)
                                .foregroundStyle(PixelColor.muted)
                        }
                        if let locked = goals.lockedSession {
                            Text("锁定课程：\(locked.session.title) · \(nativeDate(locked.lockedAt))")
                                .font(.caption)
                                .foregroundStyle(PixelColor.green)
                        }
                    }
                }
            }
        }
    }

    private func loadDraft() {
        guard let goals = native.goals else { return }
        weeklyText = nativeNumber(goals.weeklyDistanceKm)
        easyFloor = goals.easyDurationFloorFraction
        qualityCap = goals.qualitySessionCap
        weekPlan = goals.weekPlan
        distanceDrafts = Dictionary(uniqueKeysWithValues: goals.weekPlan.map {
            ($0.id, $0.distanceKm.map { String($0) } ?? "")
        })
    }

    private func save() async {
        guard !isSaving, areDistancesValid, let weekly = weeklyValue, (1...500).contains(weekly) else { return }
        let plan = weekPlan.map { item in
            var updated = item
            updated.distanceKm = Double((distanceDrafts[item.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
            return updated
        }
        isSaving = true
        saveMessage = nil
        let success = await native.saveGoals(
            weeklyDistanceKm: weekly,
            easyDurationFloorFraction: easyFloor,
            qualitySessionCap: qualityCap,
            weekPlan: plan
        )
        saveMessage = success ? "已保存，服务端已确认。" : "保存未完成，请重新读取后再试。"
        isSaving = false
    }
}

struct AnalysisView: View {
    @Environment(NativeAppModel.self) private var native
    private let mode: String

    init(initialMode: String = "trends") {
        mode = initialMode
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PixelMetrics.sectionSpacing) {
                PixelPageHeader(title: pageTitle) {
                    PixelIconButton(systemName: "arrow.clockwise", accessibilityLabel: "刷新分析") {
                        Task { await native.refreshAll() }
                    }
                    .disabled(native.isRefreshing)
                }
                if mode == "statistics" {
                    statisticsContent
                } else {
                    trendsContent
                    recordsContent
                }
            }
            .padding(.horizontal, PixelMetrics.pageHorizontal)
            .padding(.top, PixelMetrics.pageVertical)
            .padding(.bottom, 18)
        }
        .scrollIndicators(.hidden)
        .toolbar(.hidden, for: .navigationBar)
        .task {
            if native.trends == nil || native.statistics == nil { await native.refreshAll() }
        }
    }

    private var pageTitle: String {
        switch mode {
        case "statistics": return "统计"
        case "records": return "纪录"
        default: return "趋势"
        }
    }

    @ViewBuilder
    private var trendsContent: some View {
        if let data = native.trends {
            let abilityValues = data.ability.compactMap(\.trueAbility)
            VStack(alignment: .leading, spacing: PixelMetrics.sectionSpacing) {
                PixelPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        PixelSectionHeader(title: "跑量趋势", trailing: data.distanceChangeFraction4Weeks == nil ? "数据不足" : nativeSignedPercent(data.distanceChangeFraction4Weeks), trailingColor: data.distanceChangeFraction4Weeks == nil ? PixelColor.yellow : PixelColor.green)
                        Text("近 4 周总跑量变化")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(PixelColor.muted)
                        if let change = data.distanceChangeFraction4Weeks {
                            Text(nativeSignedPercent(change))
                                .font(.system(size: 34, weight: .heavy, design: .monospaced))
                                .foregroundStyle(change >= 0 ? PixelColor.green : PixelColor.coral)
                            Text("较 4 周前 · 以数据最新日为锚点")
                                .font(.caption)
                                .foregroundStyle(PixelColor.muted)
                        } else {
                            Text("数据不足 · 累计足够周跑量后显示增幅")
                                .font(.footnote.weight(.bold))
                                .foregroundStyle(PixelColor.yellow)
                                .padding(10)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .background(PixelColor.paleYellow)
                                .overlay(Rectangle().stroke(PixelColor.yellow, lineWidth: 1))
                        }
                        if !abilityValues.isEmpty {
                            PixelLineChart(
                                values: abilityValues,
                                labels: data.ability.map { nativeDay($0.date) },
                                tint: PixelColor.green
                            )
                        }
                        HStack {
                            metricCaption("增长速度", value: nativeNumber(data.growthVelocityPerWeek))
                            Spacer()
                            metricCaption("衰减", value: nativeNumber(data.decayPoints))
                        }
                    }
                }
                PixelPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        PixelSectionHeader(title: "12 周跑量", trailing: "从旧到新")
                        Text("每根柱代表一周；浅色表示本周尚未结束")
                            .font(.caption2)
                            .foregroundStyle(PixelColor.muted)
                        PixelMiniBars(
                            values: data.weeks.map(\.distanceKm),
                            labels: data.weeks.map { nativeShortWeek($0.periodStart) },
                            colors: data.weeks.map { $0.isComplete ? PixelColor.green : PixelColor.grid }
                        )
                    }
                }
                if !data.insights.isEmpty {
                    ForEach(data.insights) { insight in
                        PixelInsightCard(insight: insight)
                    }
                }
            }
        } else {
            PixelPanel { PixelLoadingState(title: "正在读取趋势") }
        }
    }

    @ViewBuilder
    private var statisticsContent: some View {
        if let data = native.statistics {
            VStack(alignment: .leading, spacing: PixelMetrics.sectionSpacing) {
                PixelPanel {
                    HStack(spacing: 8) {
                        PixelMetricTile(title: "总距离", value: nativeKilometers(data.totals.distanceKm), accent: PixelColor.coral)
                        PixelMetricTile(title: "训练次数", value: "\(data.totals.workoutCount)", accent: PixelColor.green)
                        PixelMetricTile(title: "环比", value: nativeSignedPercent(data.totals.distanceChangeFraction), accent: PixelColor.cyan)
                    }
                    .accessibilityElement(children: .combine)
                }
                PixelPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        PixelSectionHeader(title: "每月里程", trailing: "近 3 月")
                        PixelMiniBars(
                            values: data.months.map(\.totalDistanceKm),
                            labels: data.months.map(\.month),
                            colors: data.months.enumerated().map { $0.offset == data.months.count - 1 ? PixelColor.coral : PixelColor.green }
                        )
                        HStack(spacing: 12) {
                            legendDot("跑步", color: PixelColor.green)
                            legendDot("骑行", color: PixelColor.yellow)
                            legendDot("其他", color: PixelColor.cyan)
                        }
                    }
                }
                PixelPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        PixelSectionHeader(title: "统计摘要")
                        HStack(spacing: 8) {
                            PixelMetricTile(title: "总时长", value: nativeDuration(data.totals.durationSeconds), accent: PixelColor.green)
                            PixelMetricTile(title: "平均配速", value: "\(nativePace(data.totals.averagePaceSecondsPerKm))/km", accent: PixelColor.cyan)
                            PixelMetricTile(title: "月数", value: "\(data.months.count)", accent: PixelColor.yellow)
                        }
                    }
                }
                heartRatePanel(data.heartRateZones)
            }
        } else {
            PixelPanel { PixelLoadingState(title: "正在读取统计") }
        }
    }

    private var recordsContent: some View {
        Group {
            if let records = native.trends?.records {
                recordsPanel(records)
            } else {
                PixelPanel { PixelEmptyState(title: "暂无纪录", message: "完成更多训练后，个人纪录会自动生成。", systemName: "trophy") }
            }
        }
    }

    private func currentAbilityPanel(_ points: [CurrentAbilityPoint]) -> some View {
        PixelPanel(tint: PixelColor.cyan) {
            VStack(alignment: .leading, spacing: 8) {
                PixelSectionHeader(title: "近期跑力评估", trailing: "\(points.count) 条", trailingColor: PixelColor.cyan)
                if points.isEmpty {
                    Text("暂无跑力评估记录")
                        .font(.footnote)
                        .foregroundStyle(PixelColor.muted)
                } else {
                    ForEach(points.prefix(8)) { point in
                        HStack(spacing: 8) {
                            Text(nativeDay(point.date))
                                .font(.caption2.weight(.heavy).monospacedDigit())
                                .frame(width: 52, alignment: .leading)
                            Text(nativeNumber(point.currentAbility, digits: 1))
                                .font(.footnote.weight(.heavy).monospacedDigit())
                                .foregroundStyle(PixelColor.coral)
                            Spacer()
                            Text(nativeStatusName(point.assessmentStatus))
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(PixelColor.muted)
                            Text(nativeKilometers(point.distanceKm))
                                .font(.caption2.weight(.bold).monospacedDigit())
                                .foregroundStyle(PixelColor.green)
                        }
                        .padding(.vertical, 5)
                        .overlay(alignment: .bottom) { Rectangle().fill(PixelColor.grid).frame(height: 1) }
                    }
                }
            }
        }
    }

    private func heartRatePanel(_ zones: [HeartRateZoneSummary]) -> some View {
        PixelPanel {
            VStack(alignment: .leading, spacing: 9) {
                PixelSectionHeader(title: "心率区间分布", trailing: "近 28 天")
                if zones.isEmpty {
                    Text("没有满足覆盖率要求的心率数据")
                        .font(.footnote)
                        .foregroundStyle(PixelColor.muted)
                } else {
                    ForEach(zones) { zone in
                        PixelStatLine(
                            label: nativeHeartRateZone(zone.zone),
                            value: nativePercent(zone.fraction),
                            tint: nativeHeartRateZoneColor(zone.zone),
                            fraction: zone.fraction
                        )
                    }
                }
            }
        }
    }

    private func recordsPanel(_ records: PersonalRecords) -> some View {
        PixelPanel(tint: PixelColor.yellow) {
            VStack(alignment: .leading, spacing: 3) {
                PixelSectionHeader(title: "个人纪录", trailing: "PB", trailingColor: PixelColor.yellow)
                recordRow("最快 5 km", value: records.fastest5k.map { "\(nativePace($0.paceSecondsPerKm))/km · \(nativeDate($0.startedAt))" })
                recordRow("最快 10 km", value: records.fastest10k.map { "\(nativePace($0.paceSecondsPerKm))/km · \(nativeDate($0.startedAt))" })
                recordRow("最长距离", value: records.longestDistance.map { "\(nativeKilometers($0.distanceKm)) · \(nativeDate($0.startedAt))" })
                recordRow("最大月跑量", value: records.biggestMonth.map { "\(nativeKilometers($0.distanceKm)) · \($0.month)" })
            }
        }
    }

    private func recordRow(_ title: String, value: String?) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "trophy.fill")
                .foregroundStyle(PixelColor.yellow)
            Text(title)
                .font(.subheadline.weight(.heavy))
            Spacer()
            Text(value ?? "暂无记录")
                .font(.caption.weight(.bold))
                .foregroundStyle(PixelColor.muted)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 9)
        .overlay(alignment: .bottom) { Rectangle().fill(PixelColor.grid).frame(height: 1) }
    }

    private func legendDot(_ title: String, color: Color) -> some View {
        HStack(spacing: 5) {
            Rectangle().fill(color).frame(width: 9, height: 9)
            Text(title).font(.caption2.weight(.bold)).foregroundStyle(PixelColor.muted)
        }
    }

}

struct NativeSettingsView: View {
    @Environment(ServerSession.self) private var session
    @Environment(ServerDiscovery.self) private var discovery
    @Environment(HealthKitSync.self) private var healthSync
    @Environment(NativeAppModel.self) private var native
    @State private var showingClearCache = false
    @State private var draftURL = ""
    @State private var draftToken = ""

    var body: some View {
        @Bindable var session = session
        ScrollView {
            VStack(alignment: .leading, spacing: PixelMetrics.sectionSpacing) {
                PixelPageHeader(title: "设置") {
                    PixelBadge(title: session.isReachable ? "在线" : "离线", color: session.isReachable ? PixelColor.green : PixelColor.coral, fill: session.isReachable ? PixelColor.mint : PixelColor.paleCoral)
                }
                serverPanel(session: session)
                AppSkinPicker()
                healthPanel
                cachePanel
                versionPanel
            }
            .padding(.horizontal, PixelMetrics.pageHorizontal)
            .padding(.top, PixelMetrics.pageVertical)
            .padding(.bottom, 18)
        }
        .onAppear {
            draftURL = session.serverURLString
            draftToken = session.apiToken
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollIndicators(.hidden)
        .toolbar(.hidden, for: .navigationBar)
        .alert("清除本机缓存？", isPresented: $showingClearCache) {
            Button("清除", role: .destructive) { native.clearCache() }
            Button("取消", role: .cancel) { }
        } message: {
            Text("服务端数据不会受到影响。")
        }
    }

    private func serverPanel(session: ServerSession) -> some View {
        PixelPanel {
            VStack(alignment: .leading, spacing: 11) {
                PixelSectionHeader(title: "服务连接", trailing: session.isReachable ? "已连接" : "待连接", trailingColor: session.isReachable ? PixelColor.green : PixelColor.coral)
                PixelField("服务器地址") {
                    TextField("http://192.168.x.x:5173", text: Binding(
                        get: { draftURL },
                        set: {
                            draftURL = $0
                            draftToken = Keychain.loadToken(for: $0)
                        }
                    ))
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                }
                PixelField("API Token（可选）") {
                    SecureField("云端部署时填写", text: Binding(
                        get: { draftToken },
                        set: { draftToken = $0 }
                    ))
                }
                PixelPrimaryButton(title: session.isReachable ? "重新检查连接" : "连接服务", systemName: "network", isBusy: native.isLoading, isDisabled: native.isLoading) {
                    if draftURL == session.serverURLString && draftToken == session.apiToken {
                        Task { await native.connect() }
                    } else {
                        session.serverURLString = draftURL
                        session.apiToken = draftToken
                    }
                }
                if let identity = native.handshake {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("服务：\(identity.serverId)")
                        Text("个人数据：\(identity.athleteId)")
                        Text("数据代际：\(identity.datasetEpoch)")
                        Text("协议：v\(identity.syncProtocolVersion) · API \(identity.apiVersion)")
                    }
                    .font(.caption)
                    .foregroundStyle(PixelColor.muted)
                }
                if let error = session.lastError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(PixelColor.coral)
                }
                if !discovery.candidates.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("发现的 RAI 服务")
                            .font(.caption.weight(.heavy))
                            .foregroundStyle(PixelColor.green)
                        ForEach(discovery.candidates, id: \.absoluteString) { url in
                            Button(url.absoluteString) {
                                draftURL = url.absoluteString
                                draftToken = Keychain.loadToken(for: url.absoluteString)
                            }
                            .font(.caption.monospaced())
                            .foregroundStyle(PixelColor.cyan)
                        }
                    }
                }
            }
        }
    }

    private var healthPanel: some View {
        PixelPanel(tint: PixelColor.coral) {
            VStack(alignment: .leading, spacing: 10) {
                PixelSectionHeader(title: "Apple 健康", trailing: healthSync.isBusy ? "同步中" : healthSync.hasCompletedSync ? "已同步" : "未同步", trailingColor: healthSync.isBusy ? PixelColor.yellow : PixelColor.coral)
                HStack(spacing: 10) {
                    PixelIconBox(systemName: "heart.text.square.fill", tint: PixelColor.coral, fill: PixelColor.paleCoral)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("只读健康同步")
                            .font(.subheadline.weight(.heavy))
                        Text("跑步 · 心率 · 路线 · 卡路里 · 恢复")
                            .font(.caption)
                            .foregroundStyle(PixelColor.muted)
                    }
                    Spacer()
                }
                PixelPrimaryButton(title: healthSync.isBusy ? "同步中" : "同步健康数据", systemName: "arrow.triangle.2.circlepath", isBusy: healthSync.isBusy, isDisabled: healthSync.isBusy || !session.isReachable) {
                    Task {
                        await healthSync.sync(to: session.serverURL, apiToken: session.apiToken)
                        await native.refreshAll(requestHandshake: false)
                    }
                }
                if let lastSyncAt = healthSync.lastSyncAt {
                    Text("上次同步：\(nativeDate(ISO8601DateFormatter().string(from: lastSyncAt))) · 导入 \(healthSync.lastWorkoutCount ?? 0) 条训练")
                        .font(.caption)
                        .foregroundStyle(PixelColor.muted)
                }
                if let phase = healthSync.isBusy ? healthSync.phase : nil {
                    ProgressView().tint(PixelColor.coral)
                    Text(phase)
                        .font(.caption2)
                        .foregroundStyle(PixelColor.muted)
                }
                if let message = healthSync.message {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(PixelColor.muted)
                }
                if let error = healthSync.lastError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(PixelColor.coral)
                }
                Button("打开健康权限") {
                    guard let url = URL(string: "x-apple-health://") else { return }
                    UIApplication.shared.open(url)
                }
                .font(.caption.weight(.heavy))
                .foregroundStyle(PixelColor.cyan)
            }
        }
    }

    private var cachePanel: some View {
        PixelPanel {
            VStack(alignment: .leading, spacing: 9) {
                PixelSectionHeader(title: "数据管理", trailing: native.lastCacheUpdate.map { nativeDate(ISO8601DateFormatter().string(from: $0)) } ?? "无缓存", trailingColor: PixelColor.cyan)
                Text("缓存用于离线查看首页、训练、统计和趋势；不会删除服务端数据。")
                    .font(.footnote)
                    .foregroundStyle(PixelColor.muted)
                Button {
                    showingClearCache = true
                } label: {
                    HStack {
                        Image(systemName: "trash")
                        Text("清除本机页面缓存")
                        Spacer()
                        Image(systemName: "chevron.right")
                    }
                    .font(.footnote.weight(.heavy))
                    .foregroundStyle(PixelColor.coral)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var versionPanel: some View {
        PixelPanel(tint: PixelColor.cyan) {
            VStack(alignment: .leading, spacing: 8) {
                PixelSectionHeader(title: "关于 RAI", trailing: "PIXEL EDITION", trailingColor: PixelColor.cyan)
                LabeledContent("应用", value: "RAI 原生 iOS")
                    .font(.footnote.weight(.bold))
                LabeledContent("最低系统", value: "iOS 17")
                    .font(.footnote.weight(.bold))
                Text("跑力、恢复、负荷和预测均由 RAI 服务端计算。手机端不运行 Node.js、评分核心或 SQLite。")
                    .font(.caption)
                    .foregroundStyle(PixelColor.muted)
                Text("接口：today · workouts · statistics · trends · goals · lock")
                    .font(.caption2.monospaced())
                    .foregroundStyle(PixelColor.cyan)
            }
        }
    }
}

struct FlowLayout<Content: View>: View {
    let spacing: CGFloat
    let content: Content

    init(spacing: CGFloat = 8, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.content = content()
    }

    var body: some View {
        HStack(spacing: spacing) {
            content
        }
    }
}

private func metricCaption(_ title: String, value: String) -> some View {
    VStack(alignment: .trailing, spacing: 3) {
        Text(title)
            .font(.caption2.weight(.bold))
            .foregroundStyle(PixelColor.muted)
            .frame(maxWidth: .infinity, alignment: .trailing)
        Text(value)
            .font(.caption.weight(.heavy).monospacedDigit())
            .foregroundStyle(PixelColor.ink)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .frame(maxWidth: .infinity, alignment: .trailing)
    }
}
#endif
