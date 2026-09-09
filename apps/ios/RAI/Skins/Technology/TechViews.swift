#if os(iOS)
import Charts
import CoreLocation
import MapKit
import SwiftUI
import UIKit

// Technology skin presentation. All business operations use the shared NativeAppModel.
struct TechTodayView: View {
    @State private var showingLock = false
    @Environment(NativeAppModel.self) private var native
    @Environment(ServerSession.self) private var session
    @Environment(HealthKitSync.self) private var healthSync

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                TechPageHeader(title: "RAI", eyebrow: native.today.map { nativeDay($0.today.localDate) } ?? "RUNNING INTELLIGENCE") {
                    HStack(spacing: 7) {
                        VStack(spacing: 2) {
                        TechIconButton(systemName: "heart.text.square", accessibilityLabel: "同步健康数据", color: TechColor.coral) {
                            Task {
                                await healthSync.sync(to: session.serverURL, apiToken: session.apiToken)
                                await native.refreshAll(requestHandshake: false)
                            }
                        }
                        .disabled(healthSync.isBusy || native.isOffline)
                        Text("同步").font(.caption2.weight(.bold)).foregroundStyle(TechColor.muted)
                        }
                        VStack(spacing: 2) {
                        TechIconButton(systemName: "arrow.clockwise", accessibilityLabel: "刷新首页") {
                            Task { await native.refreshAll() }
                        }
                        .disabled(native.isRefreshing)
                        Text("刷新").font(.caption2.weight(.bold)).foregroundStyle(TechColor.muted)
                        }
                        VStack(spacing: 2) {
                        NavigationLink {
                            TechPlanView()
                        } label: {
                            Image(systemName: "calendar")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(TechColor.green)
                                .frame(width: 44, height: 44)
                                .background(TechColor.paper, in: RoundedRectangle(cornerRadius: 14))
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(TechColor.green, lineWidth: TechMetrics.border))

                        }
                        .accessibilityLabel("打开训练计划")
                        Text("计划").font(.caption2.weight(.bold)).foregroundStyle(TechColor.muted)
                        }
                    }
                }

                if let today = native.today {
                    TechFreshnessBanner(today: today, isOffline: native.isOffline, cacheDate: native.lastCacheUpdate)
                    todayHero(today)
                    verdictPanel(today)
                    recoveryPanel(today)
                    abilityPanel(today)
                    activityPanel(today)
                    planPanel(today)
                    contextPanel(today)
                    recentPanel(today)
                    TodayDetailLinks(data: today)
                } else if native.isLoading {
                    TechPanel { TechLoadingState(title: "正在读取 RAI 服务") }
                } else {
                    TechPanel(tint: TechColor.cyan) {
                        TechEmptyState(
                            title: "尚未连接 RAI 服务",
                            message: "请在设置中填写手机可访问的服务地址。",
                            systemName: "server.rack"
                        )
                    }
                }
            }
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.top, TechMetrics.pageVertical)
            .padding(.bottom, 18)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .scrollIndicators(.hidden)
        .refreshable { await native.refreshAll() }
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showingLock) { TechLockSheet() }
    }

    private func todayHero(_ data: MobileTodayResponse) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(alignment: .center, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(data.today.workoutCount > 0 ? "今日跑步" : "今日训练")
                        .font(.subheadline).foregroundStyle(TechColor.muted)
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text(nativeNumber(data.today.distanceKm, digits: 2))
                            .font(.system(size: 48, weight: .bold)).monospacedDigit()
                            .lineLimit(1).minimumScaleFactor(0.6)
                        Text("km").font(.subheadline)
                    }.foregroundStyle(TechColor.ink)
                }
                Spacer(minLength: 0)
                ZStack {
                    TechRing(progress: data.week.goalProgressFraction ?? 0, value: "", label: "", size: 112)
                    TechRunnerIcon(size: 46)
                }.accessibilityLabel("本周目标进度 \(nativePercent(data.week.goalProgressFraction))")
            }
            HStack(spacing: 12) {
                heroMetric("时间", nativeDuration(data.today.durationSeconds))
                heroMetric("平均配速", nativePace(data.today.paceSecondsPerKm) + "/km")
                heroMetric("kcal", data.today.energyKcal.map { nativeNumber($0, digits: 0) } ?? "--")
            }
            HStack(spacing: 10) {
                Text("本周 \(nativeNumber(data.week.distanceKm)) / \(nativeNumber(data.week.goalDistanceKm)) km")
                    .font(.caption2).foregroundStyle(TechColor.muted)
                TechProgressBar(fraction: data.week.goalProgressFraction ?? 0)
                Text(nativePercent(data.week.goalProgressFraction)).font(.caption2).foregroundStyle(TechColor.cyan)
            }.padding(10).background(TechColor.paper, in: Capsule())
        }.padding(.vertical, 12)
    }

    private func heroMetric(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(value).font(.title3.weight(.semibold).monospacedDigit())
                .foregroundStyle(TechColor.ink).lineLimit(1).minimumScaleFactor(0.65)
            Text(title).font(.caption).foregroundStyle(TechColor.muted)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func activityPanel(_ data: MobileTodayResponse) -> some View {
        let goalProgress = data.week.goalProgressFraction ?? 0
        let qualityCap = max(data.weekStructure.qualitySessionCap, 1)
        let qualityProgress = min(Double(data.weekStructure.qualitySessionCount) / Double(qualityCap), 1)
        let easyHonesty = data.weekStructure.easyHonesty.honestyFraction ?? 0

        return TechPanel {
            HStack(alignment: .center, spacing: 14) {
                TechRing(
                    progress: goalProgress,
                    value: nativePercent(data.week.goalProgressFraction),
                    label: "周目标",
                    tint: TechColor.cyan
                )
                VStack(alignment: .leading, spacing: 10) {
                    TechStatLine(
                        label: "里程",
                        value: nativeKilometers(data.week.distanceKm),
                        tint: TechColor.coral,
                        fraction: goalProgress
                    )
                    TechStatLine(
                        label: "质量",
                        value: "\(data.weekStructure.qualitySessionCount)/\(data.weekStructure.qualitySessionCap)",
                        tint: TechColor.green,
                        fraction: qualityProgress
                    )
                    TechStatLine(
                        label: "轻松度",
                        value: nativePercent(data.weekStructure.easyHonesty.honestyFraction),
                        tint: TechColor.yellow,
                        fraction: easyHonesty
                    )
                }
            }
        }
    }

    private func abilityPanel(_ data: MobileTodayResponse) -> some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 11) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        TechSectionHeader(title: "当前跑力", trailing: nativeStatusName(data.calibration.status), trailingColor: TechColor.cyan)
                        Text(nativeNumber(data.ability.trueAbility, digits: 1))
                            .font(.system(size: 42, weight: .semibold, design: .default))
                            .foregroundStyle(TechColor.coral)
                        Text(data.ability.explanation)
                            .font(.footnote)
                            .foregroundStyle(TechColor.muted)
                    }
                    Spacer(minLength: 10)
                    VStack(alignment: .trailing, spacing: 7) {
                        techMetricCaption("近 7 天", value: nativeSigned(data.ability.changeFrom7DaysAgo))
                        techMetricCaption("增长速度", value: nativeNumber(data.ability.growthVelocityPerWeek))
                        techMetricCaption("衰减", value: nativeNumber(data.ability.decayPoints))
                    }
                    .frame(width: 86, alignment: .trailing)
                }
                if data.calibration.status != "ready" {
                    Text(data.calibration.message)
                        .font(.caption)
                        .foregroundStyle(TechColor.muted)
                        .padding(9)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(TechColor.paleYellow)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(TechColor.yellow, lineWidth: 1))
                }
            }
        }
    }

    private func verdictPanel(_ data: MobileTodayResponse) -> some View {
        let tone = techToneColor(data.verdict.tone)
        return TechPanel(tint: tone) {
            VStack(alignment: .leading, spacing: 11) {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: data.verdict.tone == "green" ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(tone)
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 7) {
                            Text(data.verdict.title)
                                .font(.headline.weight(.semibold))
                                .foregroundStyle(TechColor.ink)
                            if data.verdict.stale {
                                TechBadge(title: "数据过期", color: TechColor.coral, fill: TechColor.paleCoral)
                            }
                        }
                        Text(data.verdict.reason)
                            .font(.subheadline)
                            .foregroundStyle(TechColor.muted)
                        if data.nextSession.kind != "rest" {
                            Text("下一课：\(data.nextSession.title) · \(nativeKilometers(data.nextSession.distanceKm))")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(TechColor.ink)
                        }
                    }
                }
                if !data.verdict.triggers.isEmpty {
                    TechFlowLayout(spacing: 6) {
                        ForEach(data.verdict.triggers.prefix(3), id: \.code) { trigger in
                            TechBadge(title: trigger.detail, color: tone, fill: tone.opacity(0.1))
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
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(TechColor.green)
                } else if !data.verdict.stale {
                    TechPrimaryButton(
                        title: "锁定今日安排",
                        systemName: "lock.open",
                        isBusy: native.isLockingSession,
                        isDisabled: native.isOffline
                    ) {
                        showingLock = true
                    }
                }
            }
        }
    }

    private func weekPanel(_ data: MobileTodayResponse) -> some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 11) {
                TechSectionHeader(title: "本周里程", trailing: nativePercent(data.week.goalProgressFraction), trailingColor: TechColor.coral)
                HStack(alignment: .firstTextBaseline) {
                    Text(nativeKilometers(data.week.distanceKm))
                        .font(.system(.title3, design: .default).weight(.semibold))
                        .foregroundStyle(TechColor.ink)
                    Text("/ \(nativeKilometers(data.week.goalDistanceKm))")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(TechColor.muted)
                    Spacer()
                    Text("\(data.week.workoutCount) 次")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(TechColor.green)
                }
                TechWeekBars(points: data.weekDaily, today: data.today.localDate)
            }
        }
    }

    private func recoveryPanel(_ data: MobileTodayResponse) -> some View {
        let recoveryColor = data.recovery.state == "recovered" ? TechColor.green : TechColor.yellow
        return TechPanel(tint: recoveryColor) {
            VStack(alignment: .leading, spacing: 11) {
                TechSectionHeader(title: "恢复", trailing: nativeStatusName(data.recovery.state), trailingColor: recoveryColor)
                HStack(spacing: 8) {
                    TechMetricTile(title: "睡眠", value: data.recovery.lastNightSleepMinutes.map { "\(nativeNumber($0, digits: 0)) 分" } ?? "无记录", accent: TechColor.cyan)
                    TechMetricTile(title: "HRV", value: data.recovery.morningHrvMs.map { "\(nativeNumber($0)) ms" } ?? "无记录", accent: TechColor.green)
                    TechMetricTile(title: "静息心率", value: data.recovery.restingHeartRateBpm.map { nativeNumber($0, digits: 0) } ?? "无记录", accent: TechColor.cyan)
                }
                Text(data.recovery.note)
                    .font(.footnote)
                    .foregroundStyle(TechColor.muted)
            }
        }
    }

    private func planPanel(_ data: MobileTodayResponse) -> some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 9) {
                TechSectionHeader(title: "本周计划", trailing: "质量课 \(data.weekStructure.qualitySessionCount)/\(data.weekStructure.qualitySessionCap)")
                ForEach(data.weekPlan) { day in
                    HStack(spacing: 9) {
                        Text(nativeWeekday(day.localDate))
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .frame(width: 35, alignment: .leading)
                        Image(systemName: day.completedWorkoutId == nil ? "square" : "checkmark.square.fill")
                            .foregroundStyle(day.completedWorkoutId == nil ? TechColor.grid : TechColor.green)
                        Text(day.title)
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(TechColor.ink)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : "休息")
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(day.distanceKm > 0 ? TechColor.green : TechColor.muted)
                    }
                    .padding(.vertical, 5)
                    .overlay(alignment: .bottom) {
                        Rectangle()
                            .fill(TechColor.grid.opacity(0.55))
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
                        .foregroundStyle(TechColor.coral)
                    }
                }
            }
        }
    }

    private func recentPanel(_ data: MobileTodayResponse) -> some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 5) {
                TechSectionHeader(title: "最近训练", trailing: "全部 ›")
                ForEach(data.recentWorkouts.prefix(5)) { workout in
                    NavigationLink {
                        TechWorkoutDetailView(workoutId: workout.id)
                    } label: {
                        TechWorkoutRow(workout: workout)
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
                TechSectionHeader(title: "深入查看", trailing: "更多详情", trailingColor: TechColor.cyan)
                HStack(spacing: 8) {
                    NavigationLink {
                        TechWeekOverviewView(data: data)
                    } label: {
                        detailLink(
                            title: "本周活动",
                            subtitle: "\(data.week.workoutCount) 次 · \(nativeKilometers(data.week.distanceKm))",
                            systemName: "calendar",
                            tint: TechColor.green,
                            fill: TechColor.mint
                        )
                    }
                    .buttonStyle(.plain)

                    NavigationLink {
                        TechBodyMetricsView(data: data)
                    } label: {
                        detailLink(
                            title: "身体指标",
                            subtitle: data.recovery.state == "recovered" ? "状态良好" : nativeStatusName(data.recovery.state),
                            systemName: "heart.text.square.fill",
                            tint: TechColor.coral,
                            fill: TechColor.paleCoral
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
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(tint)
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TechColor.ink)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(TechColor.muted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
            .padding(11)
            .background(fill, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(tint, lineWidth: TechMetrics.border))
        }
    }

    private func contextPanel(_ data: MobileTodayResponse) -> some View {
        VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
            TechPanel(tint: TechColor.cyan) {
                VStack(alignment: .leading, spacing: 8) {
                    TechSectionHeader(title: "训练阶段", trailing: data.phase, trailingColor: TechColor.cyan)
                    HStack {
                        Text(data.race.note)
                            .font(.footnote)
                            .foregroundStyle(TechColor.muted)
                        Spacer()
                        if let days = data.race.daysUntil {
                            Text(days >= 0 ? "还有 \(days) 天" : "已结束")
                                .font(.caption.weight(.semibold).monospacedDigit())
                                .foregroundStyle(TechColor.cyan)
                        }
                    }
                    if let target = data.race.target {
                        Text("比赛目标：\(target.distance) · \(nativeDay(target.date))")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TechColor.ink)
                        HStack(spacing: 8) {
                            techMetricCaption("目标配速", value: "\(nativePace(target.targetPaceSecondsPerKm))/km")
                            techMetricCaption("体型分", value: nativeNumber(data.race.shapeScore))
                            techMetricCaption("减量", value: data.race.taper ? "是" : "否")
                        }
                    }
                    if let remaining = data.weekStructure.remainingDistanceKm {
                        Text("本周剩余建议：\(nativeKilometers(remaining)) · \(data.weekStructure.easyHonesty.note)")
                            .font(.caption)
                            .foregroundStyle(TechColor.muted)
                    }
                }
            }
            if let postRun = data.postRun {
                TechPanel(tint: TechColor.coral, fill: TechColor.paleCoral) {
                    VStack(alignment: .leading, spacing: 7) {
                        TechSectionHeader(title: "最近一次训练反馈", trailing: nativeSessionName(postRun.sessionType), trailingColor: TechColor.coral)
                        Text(postRun.headline)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TechColor.ink)
                        Text("刺激：\(nativeStimulusName(postRun.stimulusType)) · 匹配：\(postRun.stimulusMatch)")
                            .font(.caption)
                            .foregroundStyle(TechColor.muted)
                        if let delta = postRun.trueAbilityDelta {
                            Text("跑力变化：\(nativeSigned(delta))")
                                .font(.caption.weight(.semibold).monospacedDigit())
                                .foregroundStyle(delta >= 0 ? TechColor.green : TechColor.coral)
                        }
                        ForEach(postRun.details, id: \.self) { detail in
                            Text("· \(detail)")
                                .font(.caption)
                                .foregroundStyle(TechColor.muted)
                        }
                    }
                }
            }
        }
    }
}

struct TechWeekOverviewView: View {
    let data: MobileTodayResponse

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                TechPanel {
                    HStack(spacing: 24) {
                        TechRing(progress: data.week.goalProgressFraction ?? 0,
                                 value: nativeNumber(data.week.distanceKm), label: "km", size: 124)
                        VStack(alignment: .leading, spacing: 14) {
                            Text("周进度").font(.subheadline).foregroundStyle(TechColor.muted)
                            Text(nativePercent(data.week.goalProgressFraction))
                                .font(.title.weight(.bold)).foregroundStyle(TechColor.cyan)
                            Text("目标 \(nativeKilometers(data.week.goalDistanceKm))")
                                .font(.caption).foregroundStyle(TechColor.muted)
                            Text("\(data.week.workoutCount) 次 · \(nativeDuration(data.week.durationSeconds))")
                                .font(.caption).foregroundStyle(TechColor.ink)
                        }
                    }.frame(maxWidth: .infinity)
                }

                TechPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        TechSectionHeader(title: "每日活动", trailing: "周一 – 周日")
                        TechWeekBars(points: data.weekDaily, today: data.today.localDate)
                    }
                }

                TechPanel {
                    VStack(alignment: .leading, spacing: 8) {
                        TechSectionHeader(title: "训练结构", trailing: "本周")
                        TechStatLine(
                            label: "质量",
                            value: "\(data.weekStructure.qualitySessionCount)/\(data.weekStructure.qualitySessionCap)",
                            tint: TechColor.green,
                            fraction: data.weekStructure.qualitySessionCap > 0
                                ? Double(data.weekStructure.qualitySessionCount) / Double(data.weekStructure.qualitySessionCap)
                                : 0
                        )
                        TechStatLine(
                            label: "轻松度",
                            value: nativePercent(data.weekStructure.easyHonesty.honestyFraction),
                            tint: TechColor.yellow,
                            fraction: data.weekStructure.easyHonesty.honestyFraction
                        )
                        if let remaining = data.weekStructure.remainingDistanceKm {
                            Text("距离周目标还差 \(nativeKilometers(remaining))")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(TechColor.muted)
                        }
                    }
                }

                TechPanel {
                    VStack(alignment: .leading, spacing: 8) {
                        TechSectionHeader(title: "本周计划", trailing: "完成情况")
                        ForEach(data.weekPlan) { day in
                            HStack(spacing: 9) {
                                Image(systemName: day.completedWorkoutId == nil ? "square" : "checkmark.square.fill")
                                    .foregroundStyle(day.completedWorkoutId == nil ? TechColor.grid : TechColor.green)
                                Text(nativeWeekday(day.localDate))
                                    .font(.caption.weight(.semibold))
                                    .frame(width: 35, alignment: .leading)
                                Text(day.title)
                                    .font(.subheadline.weight(.bold))
                                    .lineLimit(1)
                                Spacer()
                                Text(day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : "休息")
                                    .font(.caption.weight(.semibold).monospacedDigit())
                                    .foregroundStyle(day.distanceKm > 0 ? TechColor.green : TechColor.muted)
                            }
                            .padding(.vertical, 6)
                            .overlay(alignment: .bottom) {
                                Rectangle().fill(TechColor.grid.opacity(0.55)).frame(height: 1)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.vertical, TechMetrics.pageVertical)
            .padding(.bottom, 18)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .scrollIndicators(.hidden)
        .navigationTitle("本周活动")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(TechColor.paper, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
    }
}

struct TechBodyMetricsView: View {
    @Environment(NativeAppModel.self) private var native
    let data: MobileTodayResponse

    private var summary: MobileTodayResponse {
        native.today ?? data
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                readinessPanel
                coreMetricsPanel
                pacePanel
                recoveryPanel
                zonePanels
                predictionsPanel

                if let error = native.bodyMetricsError {
                    TechPanel(tint: TechColor.yellow, fill: TechColor.paleYellow) {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(TechColor.yellow)
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(TechColor.muted)
                        }
                    }
                }

                if !summary.injuryFlags.isEmpty {
                    TechPanel(tint: TechColor.coral, fill: TechColor.paleCoral) {
                        VStack(alignment: .leading, spacing: 8) {
                            TechSectionHeader(title: "需要留意", trailing: "\(summary.injuryFlags.count) 项", trailingColor: TechColor.coral)
                            ForEach(summary.injuryFlags) { flag in
                                HStack(alignment: .top, spacing: 7) {
                                    Image(systemName: "cross.case.fill")
                                    Text("\(flag.title)：\(flag.detail)")
                                }
                                .font(.footnote)
                                .foregroundStyle(TechColor.coral)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.vertical, TechMetrics.pageVertical)
            .padding(.bottom, 18)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .scrollIndicators(.hidden)
        .navigationTitle("身体指标")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(TechColor.paper, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .task {
            await native.refreshBodyMetrics()
        }
        .refreshable {
            await native.refreshBodyMetrics()
        }
    }

    private var readinessPanel: some View {
        HStack(spacing: 12) {
            TechPanel {
                VStack(alignment: .leading, spacing: 14) {
                    Text("身体准备度").font(.caption).foregroundStyle(TechColor.muted)
                    TechRing(progress: native.predictions?.inputs.recoveryReadiness ?? 0,
                             value: nativePercent(native.predictions?.inputs.recoveryReadiness), label: "准备度", size: 82)
                }.frame(maxWidth: .infinity)
            }
            TechPanel {
                VStack(alignment: .leading, spacing: 14) {
                    Text("VDOT").font(.caption).foregroundStyle(TechColor.muted)
                    Text(nativeNumber(native.predictions?.snapshot.performanceVdot.value))
                        .font(.system(size: 32, weight: .semibold)).foregroundStyle(TechColor.ink)
                    Text(nativeStatusName(native.trainingStatistics?.status?.trainingStatus))
                        .font(.caption).foregroundStyle(TechColor.cyan)
                }.frame(maxWidth: .infinity, minHeight: 112, alignment: .leading)
            }
        }
    }

    private var coreMetricsPanel: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 10) {
                TechSectionHeader(title: "核心能力", trailing: "预测快照", trailingColor: TechColor.cyan)
                HStack(spacing: 8) {
                    metricTile(title: "最大摄氧量", value: nativeNumber(native.predictions?.snapshot.vo2Max.valueMlKgMin, digits: 1), unit: "ml/kg/min", accent: TechColor.cyan)
                    metricTile(title: "VDOT", value: nativeNumber(native.predictions?.snapshot.performanceVdot.value, digits: 1), unit: "有效跑力", accent: TechColor.green)
                }
                HStack(spacing: 8) {
                    metricTile(title: "乳酸阈配速", value: nativePace(native.predictions?.snapshot.lactateThreshold.paceSecondsPerKm), unit: "/km", accent: TechColor.cyan)
                    metricTile(title: "阈值心率", value: native.predictions?.snapshot.lactateThreshold.heartRateBpm.map { nativeNumber($0, digits: 0) } ?? "--", unit: "bpm", accent: TechColor.yellow)
                }
            }
        }
    }

    private var pacePanel: some View {
        let latest = native.dashboard?.latestWorkout?.averagePaceSecondsPerKm
        let rolling = native.trainingStatistics?.rolling28Days?.averagePaceSecondsPerKm
        let easy = native.trainingZones?.profile.paceBands.first { $0.zone == "easy" }
        return TechPanel {
            VStack(alignment: .leading, spacing: 10) {
                TechSectionHeader(title: "配速参考", trailing: "当前数据", trailingColor: TechColor.cyan)
                HStack(spacing: 8) {
                    metricTile(title: "最近训练平均配速", value: nativePace(latest), unit: "/km", accent: TechColor.green)
                    metricTile(title: "轻松跑配速", value: paceRange(easy?.lowerSecondsPerKm, easy?.upperSecondsPerKm), unit: nil, accent: TechColor.cyan)
                }
                if let rolling {
                    Text("近 28 天平均配速：\(nativePace(rolling))/km。训练平均配速不等于轻松跑处方。")
                        .font(.caption)
                        .foregroundStyle(TechColor.muted)
                } else {
                    Text("轻松跑配速来自当前训练分区快照，建议按区间而非单点执行。")
                        .font(.caption)
                        .foregroundStyle(TechColor.muted)
                }
            }
        }
    }

    private var recoveryPanel: some View {
        TechPanel(tint: recoveryTint) {
            VStack(alignment: .leading, spacing: 10) {
                TechSectionHeader(title: "恢复明细", trailing: nativeStatusName(summary.recovery.state), trailingColor: recoveryTint)
                HStack(spacing: 8) {
                    TechMetricTile(title: "睡眠", value: nativeHoursMinutes(summary.recovery.lastNightSleepMinutes), accent: TechColor.cyan)
                    TechMetricTile(title: "HRV", value: summary.recovery.morningHrvMs.map { "\(nativeNumber($0)) ms" } ?? "无记录", accent: TechColor.green)
                    TechMetricTile(title: "静息心率", value: summary.recovery.restingHeartRateBpm.map { nativeNumber($0, digits: 0) } ?? "无记录", accent: TechColor.cyan)
                }
                bodyMetricRow("睡眠基线", value: summary.recovery.sleepBaselineMinutes.map { nativeHoursMinutes($0) })
                bodyMetricRow("HRV 基线", value: summary.recovery.hrvBaselineMs.map { "\(nativeNumber($0)) ms" })
                bodyMetricRow("静息心率基线", value: summary.recovery.restingHeartRateBaselineBpm.map { "\(nativeNumber($0, digits: 0)) bpm" })
                Text(summary.recovery.note)
                    .font(.footnote)
                    .foregroundStyle(TechColor.muted)
            }
        }
    }

    @ViewBuilder
    private var zonePanels: some View {
        if let profile = native.trainingZones?.profile {
            TechPanel {
                VStack(alignment: .leading, spacing: 9) {
                    TechSectionHeader(title: "心率分区", trailing: "\(nativeNumber(profile.restingHeartRateBpm, digits: 0))–\(nativeNumber(profile.maximumHeartRateBpm, digits: 0)) bpm", trailingColor: TechColor.coral)
                    ForEach(profile.heartRateBands) { band in
                        zoneRow(label: nativeHeartRateZone(band.zone), value: "\(band.lowerBpm.map { nativeNumber($0, digits: 0) } ?? "--")–\(band.upperBpm.map { nativeNumber($0, digits: 0) } ?? "--") bpm", tint: techHeartRateZoneColor(band.zone))
                    }
                }
            }
            TechPanel(tint: TechColor.cyan) {
                VStack(alignment: .leading, spacing: 9) {
                    TechSectionHeader(title: "配速分区", trailing: "按阈值配速计算", trailingColor: TechColor.cyan)
                    ForEach(profile.paceBands) { band in
                        zoneRow(label: nativePaceZone(band.zone), value: paceRange(band.lowerSecondsPerKm, band.upperSecondsPerKm), tint: nativePaceZoneColor(band.zone))
                    }
                }
            }
        } else if native.isLoadingBodyMetrics {
            TechPanel { TechLoadingState(title: "正在读取训练分区") }
        } else {
            TechPanel(tint: TechColor.yellow, fill: TechColor.paleYellow) {
                TechEmptyState(title: "训练分区暂不可用", message: "完成一次重新计算后，心率和配速分区会显示在这里。", systemName: "chart.bar.xaxis")
            }
        }
    }

    private var predictionsPanel: some View {
        TechPanel(tint: TechColor.yellow) {
            VStack(alignment: .leading, spacing: 9) {
                TechSectionHeader(title: "成绩预测", trailing: "区间参考", trailingColor: TechColor.yellow)
                Text("根据当前 VDOT、准备度和训练证据估算，不代表比赛承诺。")
                    .font(.caption)
                    .foregroundStyle(TechColor.muted)
                if let races = native.predictions?.snapshot.races, !races.isEmpty {
                    ForEach(races) { race in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "flag.checkered")
                                .foregroundStyle(TechColor.yellow)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(nativeRaceDistance(race.distance))
                                    .font(.subheadline.weight(.semibold))
                                Text(racePredictionText(race))
                                    .font(.caption.weight(.bold).monospacedDigit())
                                    .foregroundStyle(TechColor.muted)
                            }
                            Spacer()
                            Text(nativePercent(race.readiness))
                                .font(.caption2.weight(.semibold).monospacedDigit())
                                .foregroundStyle(TechColor.yellow)
                        }
                        .padding(.vertical, 7)
                        .overlay(alignment: .bottom) {
                            Rectangle().fill(TechColor.grid.opacity(0.55)).frame(height: 1)
                        }
                    }
                } else {
                    Text("暂无可用成绩预测")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                }
            }
        }
    }

    private var recoveryTint: Color {
        summary.recovery.state == "recovered" ? TechColor.green : TechColor.yellow
    }

    private func metricTile(title: String, value: String, unit: String?, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption2.weight(.bold))
                .foregroundStyle(TechColor.muted)
                .lineLimit(1)
            Text(value)
                .font(.system(.subheadline, design: .default).weight(.semibold))
                .foregroundStyle(accent)
                .lineLimit(1)
                .minimumScaleFactor(0.55)
            if let unit {
                Text(unit)
                    .font(.caption2)
                    .foregroundStyle(TechColor.muted)
                    .lineLimit(1)
            }
        }
        .padding(9)
        .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        .background(TechColor.paper, in: RoundedRectangle(cornerRadius: 12))

    }

    private func zoneRow(label: String, value: String, tint: Color) -> some View {
        HStack(spacing: 8) {
            Rectangle().fill(tint).frame(width: 9, height: 9).overlay(RoundedRectangle(cornerRadius: 12).stroke(TechColor.ink.opacity(0.5), lineWidth: 1))
            Text(label)
                .font(.caption.weight(.bold))
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(value)
                .font(.caption2.weight(.semibold).monospacedDigit())
                .foregroundStyle(TechColor.ink)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 5)
        .overlay(alignment: .bottom) {
            Rectangle().fill(TechColor.grid.opacity(0.55)).frame(height: 1)
        }
    }

    private func bodyMetricRow(_ label: String, value: String?) -> some View {
        HStack {
            Text(label).font(.caption.weight(.bold))
            Spacer()
            Text(value ?? "无记录")
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(value == nil ? TechColor.muted : TechColor.ink)
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
        case "easy": return TechColor.leaf
        case "marathon": return TechColor.cyan
        case "lactate_threshold": return TechColor.yellow
        case "anaerobic_endurance": return TechColor.coral
        case "sprint": return TechColor.ink
        default: return TechColor.grid
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

struct TechFreshnessBanner: View {
    let today: MobileTodayResponse
    let isOffline: Bool
    let cacheDate: Date?

    private var tint: Color {
        if isOffline { return TechColor.cyan }
        if today.freshness.state == "stale" || today.verdict.stale { return TechColor.yellow }
        return TechColor.green
    }

    var body: some View {
        TechPanel(tint: tint, fill: tint.opacity(0.08), shadowColor: tint.opacity(0.15)) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: isOffline ? "wifi.slash" : today.freshness.state == "stale" ? "clock.badge.exclamationmark" : "antenna.radiowaves.left.and.right")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(isOffline ? "离线缓存" : "数据状态")
                            .font(.caption.weight(.semibold))
                        Spacer()
                        Text(nativeStatusName(today.freshness.state))
                            .font(.caption2.weight(.semibold))
                    }
                    Text("健康数据截至 \(nativeDay(today.latestDataDate ?? "未知")) · 结果生成于 \(nativeDate(today.generatedAt))")
                        .font(.caption)
                        .foregroundStyle(TechColor.muted)
                    if let cacheDate {
                        Text("缓存更新于 \(nativeDate(ISO8601DateFormatter().string(from: cacheDate)))")
                            .font(.caption2)
                            .foregroundStyle(TechColor.muted)
                    }
                }
            }
            .foregroundStyle(TechColor.ink)
        }
    }
}

struct TechWorkoutsView: View {
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
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                TechPageHeader(title: "训练") {
                    TechBadge(title: "共 \(native.workoutTotal) 次", color: TechColor.cyan, fill: TechColor.paleCyan)
                }
                TechSegmentedControl(
                    items: filters.map { (title: $0.0, value: $0.1 ?? "all") },
                    selection: selectedFilter
                )
                HStack(spacing: 8) {
                    TechMetricTile(title: "本月次数", value: monthWorkoutCount, accent: TechColor.green)
                    TechMetricTile(title: "本月里程", value: monthDistance, accent: TechColor.cyan)
                    TechMetricTile(title: "本月时长", value: monthDuration, accent: TechColor.cyan)
                }
                if native.workouts.isEmpty && native.isLoadingWorkouts {
                    TechLoadingState(title: "正在读取训练")
                } else if native.workouts.isEmpty {
                    TechPanel(tint: TechColor.cyan) {
                        VStack(spacing: 16) {
                            TechEmptyState(title: "尚无训练记录", message: "同步 Apple 健康后查看训练；当前筛选也可能暂无记录。", systemName: "shoe")
                            NavigationLink { TechNativeSettingsView() } label: {
                                Text("前往同步").font(.subheadline.weight(.semibold))
                                    .foregroundStyle(TechColor.background).frame(maxWidth: .infinity, minHeight: 48)
                                    .background(TechColor.cyan, in: Capsule())
                            }
                        }
                    }
                } else {
                    TechPanel {
                        VStack(spacing: 0) {
                            ForEach(native.workouts) { workout in
                                NavigationLink {
                                    TechWorkoutDetailView(workoutId: workout.id)
                                } label: {
                                    TechWorkoutRow(workout: workout)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    if native.workouts.count < native.workoutTotal {
                        TechPrimaryButton(
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
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.top, TechMetrics.pageVertical)
            .padding(.bottom, 18)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
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

struct TechWorkoutRow: View {
    let workout: WorkoutListItem

    private var tint: Color { techSessionColor(workout.sessionType) }

    var body: some View {
        HStack(spacing: 10) {
            TechIconBox(
                systemName: nativeSessionSymbol(workout.sessionType, indoor: workout.indoor == true),
                tint: tint,
                fill: tint.opacity(0.12)
            )
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(nativeSessionName(workout.sessionType))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TechColor.ink)
                    if workout.indoor == true { TechBadge(title: "室内", color: TechColor.cyan, fill: TechColor.paleCyan) }
                }
                Text(nativeDate(workout.startedAt))
                    .font(.caption)
                    .foregroundStyle(TechColor.muted)
                HStack(spacing: 7) {
                    Text(nativeKilometers(workout.distanceKm))
                    Text(nativeDuration(workout.durationSeconds))
                    Text("\(nativePace(workout.averagePaceSecondsPerKm))/km")
                }
                .font(.caption2.weight(.bold).monospacedDigit())
                .foregroundStyle(TechColor.muted)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 5) {
                Text(nativeKilometers(workout.distanceKm))
                    .font(.system(.subheadline, design: .default).weight(.semibold))
                    .foregroundStyle(tint)
                TechBadge(
                    title: nativeStatusName(workout.assessmentStatus),
                    color: workout.assessmentStatus == "excluded" ? TechColor.coral : TechColor.green,
                    fill: workout.assessmentStatus == "excluded" ? TechColor.paleCoral : TechColor.mint
                )
                if workout.hasRoute {
                    Image(systemName: "map.fill")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(TechColor.cyan)
                }
            }
        }
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(TechColor.grid.opacity(0.55))
                .frame(height: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(nativeSessionName(workout.sessionType))，\(nativeDate(workout.startedAt))，\(nativeKilometers(workout.distanceKm))，\(nativePace(workout.averagePaceSecondsPerKm))/km")
    }
}

struct TechWorkoutDetailView: View {
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
                VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                    if let error = native.workoutDetailError {
                        Text(error).font(.footnote).foregroundStyle(TechColor.coral)
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
                .padding(.horizontal, TechMetrics.pageHorizontal)
                .padding(.vertical, TechMetrics.pageVertical)
            } else if let error = native.workoutDetailError, !native.isLoadingWorkout {
                VStack(spacing: 12) {
                    TechEmptyState(title: "训练详情暂不可用", message: error, systemName: "wifi.exclamationmark")
                    TechPrimaryButton(title: "重新加载", systemName: "arrow.clockwise") {
                        Task { await native.loadWorkout(id: workoutId) }
                    }
                }
                .padding(.horizontal, TechMetrics.pageHorizontal)
            } else {
                TechLoadingState(title: "正在读取训练详情")
                    .padding(.horizontal, TechMetrics.pageHorizontal)
            }
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .scrollIndicators(.hidden)
        .navigationTitle("训练详情")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(TechColor.paper, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .task(id: workoutId) { await native.loadWorkout(id: workoutId) }
        .refreshable { await native.loadWorkout(id: workoutId) }
    }

    private func detailHeader(_ workout: WorkoutDetail) -> some View {
        TechHeroCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(nativeSessionName(workout.sessionType))
                        .font(.title2.weight(.semibold))
                    Spacer()
                    TechRunnerIcon(size: 34)
                }
                Text(nativeDate(workout.startedAt))
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.85))
                HStack(spacing: 7) {
                    TechBadge(title: nativeStimulusName(workout.stimulusType), color: TechColor.cyan, fill: TechColor.mint)
                    TechBadge(title: nativeStatusName(workout.assessmentStatus), color: TechColor.green, fill: TechColor.mint)
                    if workout.indoor == true { TechBadge(title: "室内", color: TechColor.cyan, fill: TechColor.paleCyan) }
                }
            }
            .foregroundStyle(.white)
        }
    }

    private func detailMetrics(_ workout: WorkoutDetail) -> some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
            TechMetricTile(title: "距离", value: nativeKilometers(workout.distanceKm), accent: TechColor.cyan)
            TechMetricTile(title: "时长", value: nativeDuration(workout.durationSeconds), accent: TechColor.green)
            TechMetricTile(title: "配速", value: "\(nativePace(workout.averagePaceSecondsPerKm))/km", accent: TechColor.cyan)
            TechMetricTile(title: "平均心率", value: workout.averageHeartRateBpm.map { "\(nativeNumber($0, digits: 0)) bpm" } ?? "--")
            TechMetricTile(title: "步频", value: workout.averageCadenceSpm.map { "\(nativeNumber($0, digits: 0)) spm" } ?? "--")
            TechMetricTile(title: "功率", value: workout.averagePowerWatts.map { "\(nativeNumber($0, digits: 0)) W" } ?? "--")
            TechMetricTile(title: "步幅", value: workout.averageStrideLengthMeters.map { "\(nativeNumber($0)) m" } ?? "--")
            TechMetricTile(title: "垂直振幅", value: workout.averageVerticalOscillationCm.map { "\(nativeNumber($0)) cm" } ?? "--")
            TechMetricTile(title: "触地时间", value: workout.averageGroundContactTimeMs.map { "\(nativeNumber($0, digits: 0)) ms" } ?? "--")
            TechMetricTile(title: "爬升", value: workout.elevationGainMeters.map { "\(nativeNumber($0, digits: 0)) m" } ?? "--", accent: TechColor.yellow)
            TechMetricTile(title: "能量", value: workout.activeEnergyKcal.map { "\(nativeNumber($0, digits: 0)) kcal" } ?? "--", accent: TechColor.cyan)
            TechMetricTile(title: "质量分", value: nativeNumber(workout.qualityScore), accent: TechColor.green)
        }
    }

    private func routePanel(_ route: [RoutePoint]) -> some View {
        TechPanel(tint: TechColor.cyan) {
            VStack(alignment: .leading, spacing: 9) {
                TechSectionHeader(title: "路线", trailing: "\(route.count) 个点", trailingColor: TechColor.cyan)
                if route.count > 1 {
                    Map {
                        MapPolyline(coordinates: route.map { CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude) })
                            .stroke(TechColor.cyan, lineWidth: 3)
                    }
                    .mapStyle(.standard(elevation: .flat, pointsOfInterest: .excludingAll))
                    .frame(height: 280)
                    .clipShape(RoundedRectangle(cornerRadius: 18))
                } else {
                    Text("路线数据不足")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                }
            }
        }
    }

    private func seriesPanel(_ series: WorkoutSeriesResponse) -> some View {
        let metric = metricSeries(from: series.series, key: selectedMetric)
        return TechPanel {
            VStack(alignment: .leading, spacing: 10) {
                TechSectionHeader(title: "训练时序", trailing: "\(metric.totalSamples) 点", trailingColor: TechColor.cyan)
                ScrollView(.horizontal, showsIndicators: false) {
                    TechSegmentedControl(
                        items: metricItems.map { (title: $0.0, value: $0.1) },
                        selection: $selectedMetric
                    )
                    .frame(minWidth: 610)
                }
                if metric.points.isEmpty {
                    Text("没有可展示的\(metric.unit)样本")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                        .frame(maxWidth: .infinity, minHeight: 120)
                } else {
                    Chart(metric.points) { point in
                        LineMark(
                            x: .value("时间", point.offsetSeconds),
                            y: .value(metric.unit, point.value)
                        )
                        .foregroundStyle(TechColor.green)
                        .interpolationMethod(.monotone)
                        AreaMark(x: .value("时间", point.offsetSeconds), y: .value(metric.unit, point.value))
                            .foregroundStyle(LinearGradient(colors: [TechColor.cyan.opacity(0.16), .clear], startPoint: .top, endPoint: .bottom))
                            .interpolationMethod(.monotone)
                    }
                    .frame(height: 190)
                    .chartPlotStyle { plot in
                        plot.background(TechColor.mint.opacity(0.35))
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(TechColor.grid, lineWidth: 1))
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
        TechPanel {
            VStack(alignment: .leading, spacing: 4) {
                TechSectionHeader(title: "分段", trailing: "\(splits.count) 段")
                if splits.isEmpty {
                    Text("没有分段数据")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                } else {
                    ForEach(splits) { split in
                        HStack(spacing: 8) {
                            Text(split.distanceMeters < 999.5 ? "尾段" : "\(split.index) km")
                                .font(.subheadline.weight(.semibold))
                                .frame(width: 52, alignment: .leading)
                            TechProgressBar(fraction: split.averagePaceSecondsPerKm / max(splits.map(\.averagePaceSecondsPerKm).max() ?? 1, 1))
                            Text("\(nativePace(split.averagePaceSecondsPerKm))/km")
                            Text(split.averageHeartRateBpm.map { "\(nativeNumber($0, digits: 0)) bpm" } ?? "--")
                        }
                        .font(.caption.weight(.bold).monospacedDigit())
                        .foregroundStyle(TechColor.muted)
                        .padding(.vertical, 7)
                        .overlay(alignment: .bottom) { Rectangle().fill(TechColor.grid).frame(height: 1) }
                    }
                }
            }
        }
    }

    private func qualityPanel(_ detail: WorkoutDetailResponse) -> some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 10) {
                TechSectionHeader(title: "质量与模型", trailing: detail.workout.modelVersion, trailingColor: TechColor.cyan)
                HStack(spacing: 8) {
                    TechMetricTile(title: "心率覆盖", value: nativePercent(detail.workout.heartRateCoverage), accent: TechColor.cyan)
                    TechMetricTile(title: "来源可信度", value: nativePercent(detail.workout.sourceConfidence), accent: TechColor.green)
                    TechMetricTile(title: "刺激可信度", value: nativePercent(detail.workout.stimulusConfidence), accent: TechColor.yellow)
                }
                HStack(spacing: 8) {
                    techMetricCaption("评估状态", value: nativeStatusName(detail.workout.assessmentStatus))
                    techMetricCaption("样本数", value: "\(detail.workout.heartRateSampleCount)")
                    techMetricCaption("路线质量", value: nativePercent(detail.workout.routeQuality))
                }
                if !detail.workout.missingReasons.isEmpty {
                    Text("数据不足：\(detail.workout.missingReasons.joined(separator: "、"))")
                        .font(.footnote)
                        .foregroundStyle(TechColor.coral)
                }
                if !detail.workout.explanationCodes.isEmpty {
                    Text(detail.workout.explanationCodes.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(TechColor.muted)
                }
            }
        }
    }

    private func trainingLoadPanel(_ load: WorkoutTrainingLoad) -> some View {
        TechPanel(tint: TechColor.coral) {
            VStack(alignment: .leading, spacing: 10) {
                TechSectionHeader(title: "训练负荷", trailing: nativeNumber(load.load), trailingColor: TechColor.coral)
                HStack(spacing: 8) {
                    TechMetricTile(title: "强度", value: nativeNumber(load.intensity), accent: TechColor.cyan)
                    TechMetricTile(title: "置信度", value: nativePercent(load.confidence), accent: TechColor.green)
                    TechMetricTile(title: "心率", value: load.averageHeartRate.map { nativeNumber($0, digits: 0) } ?? "--", accent: TechColor.cyan)
                }
                Text("来源：\(load.source) · 刺激：\(nativeStimulusName(load.stimulusType))")
                    .font(.caption)
                    .foregroundStyle(TechColor.muted)
                ForEach(load.explanations, id: \.code) { explanation in
                    Text(explanation.code + (explanation.value.map { " · \(nativeNumber($0))" } ?? ""))
                        .font(.caption2)
                        .foregroundStyle(TechColor.muted)
                }
            }
        }
    }

    private func zonePanel(_ zones: WorkoutZoneSummary) -> some View {
        TechPanel(tint: TechColor.yellow) {
            VStack(alignment: .leading, spacing: 9) {
                TechSectionHeader(title: "区间暴露", trailing: nativeStimulusName(zones.stimulusType), trailingColor: TechColor.yellow)
                Text("心率覆盖 \(nativePercent(zones.heartRateCoverage)) · 配速覆盖 \(nativePercent(zones.paceCoverage))")
                    .font(.caption)
                    .foregroundStyle(TechColor.muted)
                ForEach(zones.heartRateExposure) { zone in
                    TechStatLine(
                        label: nativeHeartRateZone(zone.zone),
                        value: nativePercent(zone.fraction),
                        tint: techHeartRateZoneColor(zone.zone),
                        fraction: zone.fraction
                    )
                }
                if !zones.secondaryStimulusTypes.isEmpty {
                    Text("次要刺激：\(zones.secondaryStimulusTypes.map(nativeStimulusName).joined(separator: "、"))")
                        .font(.caption)
                        .foregroundStyle(TechColor.muted)
                }
            }
        }
    }

    private func overridePanel(_ override: WorkoutOverride) -> some View {
        TechPanel(tint: TechColor.cyan) {
            VStack(alignment: .leading, spacing: 7) {
                TechSectionHeader(title: "人工覆盖", trailing: "v\(override.revision)", trailingColor: TechColor.cyan)
                if let value = override.eligibilityOverride { Text("纳入状态：\(value)") }
                if let value = override.statisticsParticipation { Text("统计参与：\(value)") }
                if let value = override.sessionType { Text("训练类型：\(nativeSessionName(value))") }
                if let value = override.performanceProtocol { Text("表现协议：\(value)") }
                if let value = override.rpe { Text("RPE：\(nativeNumber(value))") }
                if !override.conditionTags.isEmpty { Text("状态标签：\(override.conditionTags.joined(separator: "、"))") }
                if let value = override.note, !value.isEmpty { Text(value) }
            }
            .font(.footnote)
            .foregroundStyle(TechColor.muted)
        }
    }
}

struct TechPlanView: View {
    @State private var editing = false
    @State private var showingLock = false
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
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                if editing {
                    goalEditor
                    weekPlanPanel
                } else {
                    planOverview
                }
                racePanel
                if !editing {
                    TechPrimaryButton(title: "编辑周计划", isDisabled: native.goals == nil || native.isOffline) {
                        loadDraft()
                        editing = true
                    }
                    if let today = native.today, !today.lock.present, !today.verdict.stale {
                        TechPrimaryButton(title: "锁定今日安排", systemName: "lock", isDisabled: native.isOffline) {
                            showingLock = true
                        }
                    }
                }
                if let saveMessage {
                    TechPanel(tint: saveMessage.hasPrefix("已") ? TechColor.green : TechColor.coral, fill: saveMessage.hasPrefix("已") ? TechColor.mint : TechColor.paleCoral) {
                        Text(saveMessage)
                            .font(.footnote.weight(.bold))
                            .foregroundStyle(saveMessage.hasPrefix("已") ? TechColor.green : TechColor.coral)
                    }
                }
            }
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.top, TechMetrics.pageVertical)
            .padding(.bottom, 18)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .scrollIndicators(.hidden)
        .navigationTitle(editing ? "编辑周计划" : "训练计划")
        .sheet(isPresented: $showingLock) { TechLockSheet() }
        .toolbar {
            if editing {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("取消") { loadDraft(); editing = false }
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .scrollDismissesKeyboard(.interactively)
        .task {
            if native.goals == nil { await native.refreshAll() }
            loadDraft()
        }
        .onChange(of: native.goals?.revision) { _, _ in loadDraft() }
    }

    private var planOverview: some View {
        VStack(alignment: .leading, spacing: 20) {
            TechHeroCard {
                HStack(spacing: 18) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("本周总里程").font(.subheadline).foregroundStyle(TechColor.muted)
                        Text(nativeNumber(native.goals?.weeklyDistanceKm) + " km")
                            .font(.system(size: 34, weight: .bold)).foregroundStyle(TechColor.ink)
                            .lineLimit(1).minimumScaleFactor(0.65)
                    }
                    Spacer(minLength: 0)
                    TechRing(progress: native.goals?.easyDurationFloorFraction ?? 0,
                             value: nativePercent(native.goals?.easyDurationFloorFraction), label: "轻松占比", size: 76)
                }
                Text("质量课上限 \(native.goals?.qualitySessionCap ?? 0) 次")
                    .font(.caption).foregroundStyle(TechColor.muted)
            }
            TechSectionHeader(title: "7 天训练安排", trailing: "本周")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(native.goals?.weekPlan ?? []) { day in
                        VStack(spacing: 13) {
                            Text(nativeWeekday(day.localDate)).font(.caption)
                            Text(nativeDay(day.localDate)).font(.caption2).foregroundStyle(TechColor.muted)
                            Image(systemName: nativeSessionSymbol(day.kind)).font(.title3)
                                .foregroundStyle(techSessionColor(day.kind))
                            Text(nativeSessionName(day.kind)).font(.caption)
                            Text(day.distanceKm.map { nativeKilometers($0) } ?? "—")
                                .font(.caption.monospacedDigit()).foregroundStyle(TechColor.muted)
                        }
                        .padding(.vertical, 16).frame(width: 74)
                        .background(TechColor.paper, in: RoundedRectangle(cornerRadius: 14))
                    }
                }
            }
            if native.isOffline {
                Label("离线时可查看计划，重新连接后可编辑", systemImage: "wifi.slash")
                    .font(.footnote).foregroundStyle(TechColor.yellow)
            }
        }
    }

    private var goalEditor: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 13) {
                TechSectionHeader(title: "周目标", trailing: "1–500 km")
                TechField("每周跑量") {
                    HStack {
                        TextField("30", text: $weeklyText)
                            .keyboardType(.decimalPad)
                            .textInputAutocapitalization(.never)
                        Text("km")
                            .foregroundStyle(TechColor.muted)
                    }
                }
                if !weeklyText.isEmpty && !isWeeklyValid {
                    Text("请输入 1 到 500 km 的目标。")
                        .font(.caption)
                        .foregroundStyle(TechColor.coral)
                }
                VStack(alignment: .leading, spacing: 7) {
                    HStack {
                        Text("轻松训练时长下限")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TechColor.green)
                        Spacer()
                        Text(nativePercent(easyFloor))
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(TechColor.coral)
                    }
                    Slider(value: $easyFloor, in: 0.4...0.95, step: 0.05)
                        .tint(TechColor.coral)
                }
                HStack {
                    Text("质量课上限")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TechColor.green)
                    Spacer()
                    Stepper("\(qualityCap) 次", value: $qualityCap, in: 0...4)
                        .labelsHidden()
                    Text("\(qualityCap) 次")
                        .font(.footnote.weight(.semibold).monospacedDigit())
                }
                TechPrimaryButton(title: "保存到 RAI 服务", systemName: "checkmark", isBusy: isSaving, isDisabled: isSaving || !isWeeklyValid || !areDistancesValid || native.isOffline || native.goals == nil) {
                    Task { await save() }
                }
            }
        }
    }

    private var weekPlanPanel: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 8) {
                TechSectionHeader(title: "本周安排", trailing: "逐日计划")
                if !areDistancesValid {
                    Text("每日距离请输入 0–80 km，留空表示未设置。")
                        .font(.caption).foregroundStyle(TechColor.coral)
                }
                if weekPlan.isEmpty {
                    Text("服务端尚未保存逐日计划")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                } else {
                    ForEach(weekPlan.indices, id: \.self) { index in
                        let item = weekPlan[index]
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(nativeWeekday(item.localDate))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(TechColor.ink)
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
                                .background(TechColor.paper, in: RoundedRectangle(cornerRadius: 14))
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(TechColor.green, lineWidth: 1))
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
                            .tint(TechColor.green)
                        }
                        .padding(.vertical, 8)
                        .overlay(alignment: .bottom) { Rectangle().fill(TechColor.grid).frame(height: 1) }
                    }
                }
            }
        }
    }

    private var racePanel: some View {
        Group {
            if let goals = native.goals {
                TechPanel(tint: TechColor.cyan) {
                    VStack(alignment: .leading, spacing: 8) {
                        TechSectionHeader(title: "比赛目标", trailing: goals.lockedSession == nil ? "未锁定" : "已锁定", trailingColor: TechColor.cyan)
                        if let race = goals.raceTarget {
                            Text("\(race.distance) · \(nativeDay(race.date))")
                                .font(.headline.weight(.semibold))
                            Text(race.targetPaceSecondsPerKm.map { "目标配速：\(nativePace($0))/km" } ?? "未设置目标配速")
                                .font(.footnote)
                                .foregroundStyle(TechColor.muted)
                        } else {
                            Text("尚未设置比赛目标。")
                                .font(.footnote)
                                .foregroundStyle(TechColor.muted)
                        }
                        if let locked = goals.lockedSession {
                            Text("锁定课程：\(locked.session.title) · \(nativeDate(locked.lockedAt))")
                                .font(.caption)
                                .foregroundStyle(TechColor.green)
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
        if success { editing = false }
        isSaving = false
    }
}

struct TechAnalysisView: View {
    @Environment(NativeAppModel.self) private var native
    @State private var mode: String

    init(initialMode: String = "trends") {
        _mode = State(initialValue: initialMode)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                TechPageHeader(title: pageTitle) {
                    TechIconButton(systemName: "arrow.clockwise", accessibilityLabel: "刷新分析") {
                        Task { await native.refreshAll() }
                    }
                    .disabled(native.isRefreshing)
                }
                TechSegmentedControl(items: [("统计", "statistics"), ("趋势", "trends"), ("纪录", "records")], selection: $mode)
                if mode == "statistics" {
                    statisticsContent
                } else if mode == "records" {
                    recordsContent
                } else {
                    trendsContent
                    if let data = native.trends { currentAbilityPanel(data.currentAbility) }
                }
            }
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.top, TechMetrics.pageVertical)
            .padding(.bottom, 18)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
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
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                TechPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        TechSectionHeader(title: "跑量趋势", trailing: data.distanceChangeFraction4Weeks == nil ? "数据不足" : nativeSignedPercent(data.distanceChangeFraction4Weeks), trailingColor: data.distanceChangeFraction4Weeks == nil ? TechColor.yellow : TechColor.green)
                        Text("近 4 周总跑量变化")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(TechColor.muted)
                        if let change = data.distanceChangeFraction4Weeks {
                            Text(nativeSignedPercent(change))
                                .font(.system(size: 34, weight: .semibold, design: .default))
                                .foregroundStyle(change >= 0 ? TechColor.green : TechColor.coral)
                            Text("较 4 周前 · 以数据最新日为锚点")
                                .font(.caption)
                                .foregroundStyle(TechColor.muted)
                        } else {
                            Text("数据不足 · 累计足够周跑量后显示增幅")
                                .font(.footnote.weight(.bold))
                                .foregroundStyle(TechColor.yellow)
                                .padding(10)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .background(TechColor.paleYellow)
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(TechColor.yellow, lineWidth: 1))
                        }
                        if !abilityValues.isEmpty {
                            TechLineChart(
                                values: abilityValues,
                                labels: data.ability.filter { $0.trueAbility != nil }.map { nativeDay($0.date) },
                                tint: TechColor.green
                            )
                        }
                        HStack {
                            techMetricCaption("增长速度", value: nativeNumber(data.growthVelocityPerWeek))
                            Spacer()
                            techMetricCaption("衰减", value: nativeNumber(data.decayPoints))
                        }
                    }
                }
                TechPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        TechSectionHeader(title: "12 周跑量", trailing: "从旧到新")
                        Text("每根柱代表一周；浅色表示本周尚未结束")
                            .font(.caption2)
                            .foregroundStyle(TechColor.muted)
                        TechMiniBars(
                            values: data.weeks.map(\.distanceKm),
                            labels: data.weeks.map { nativeShortWeek($0.periodStart) },
                            colors: data.weeks.map { $0.isComplete ? TechColor.green : TechColor.grid }
                        )
                    }
                }
                if !data.insights.isEmpty {
                    ForEach(data.insights) { insight in
                        TechInsightCard(insight: insight)
                    }
                }
            }
        } else {
            TechPanel { TechLoadingState(title: "正在读取趋势") }
        }
    }

    @ViewBuilder
    private var statisticsContent: some View {
        if let data = native.statistics {
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                TechPanel {
                    HStack(spacing: 8) {
                        TechMetricTile(title: "总距离", value: nativeKilometers(data.totals.distanceKm), accent: TechColor.cyan)
                        TechMetricTile(title: "训练次数", value: "\(data.totals.workoutCount)", accent: TechColor.green)
                        TechMetricTile(title: "环比", value: nativeSignedPercent(data.totals.distanceChangeFraction), accent: TechColor.cyan)
                    }
                    .accessibilityElement(children: .combine)
                }
                TechPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        TechSectionHeader(title: "每月里程", trailing: "近 3 月")
                        TechMonthChart(months: data.months)
                    }
                }
                TechPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        TechSectionHeader(title: "统计摘要")
                        HStack(spacing: 8) {
                            TechMetricTile(title: "总时长", value: nativeDuration(data.totals.durationSeconds), accent: TechColor.green)
                            TechMetricTile(title: "平均配速", value: "\(nativePace(data.totals.averagePaceSecondsPerKm))/km", accent: TechColor.cyan)
                            TechMetricTile(title: "月数", value: "\(data.months.count)", accent: TechColor.yellow)
                        }
                    }
                }
                heartRatePanel(data.heartRateZones)
            }
        } else {
            TechPanel { TechLoadingState(title: "正在读取统计") }
        }
    }

    private var recordsContent: some View {
        Group {
            if let records = native.trends?.records {
                recordsPanel(records)
            } else {
                TechPanel { TechEmptyState(title: "暂无纪录", message: "完成更多训练后，个人纪录会自动生成。", systemName: "trophy") }
            }
        }
    }

    private func currentAbilityPanel(_ points: [CurrentAbilityPoint]) -> some View {
        TechPanel(tint: TechColor.cyan) {
            VStack(alignment: .leading, spacing: 8) {
                TechSectionHeader(title: "近期跑力评估", trailing: "\(points.count) 条", trailingColor: TechColor.cyan)
                if points.isEmpty {
                    Text("暂无跑力评估记录")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                } else {
                    ForEach(points.prefix(8)) { point in
                        HStack(spacing: 8) {
                            Text(nativeDay(point.date))
                                .font(.caption2.weight(.semibold).monospacedDigit())
                                .frame(width: 52, alignment: .leading)
                            Text(nativeNumber(point.currentAbility, digits: 1))
                                .font(.footnote.weight(.semibold).monospacedDigit())
                                .foregroundStyle(TechColor.coral)
                            Spacer()
                            Text(nativeStatusName(point.assessmentStatus))
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(TechColor.muted)
                            Text(nativeKilometers(point.distanceKm))
                                .font(.caption2.weight(.bold).monospacedDigit())
                                .foregroundStyle(TechColor.green)
                        }
                        .padding(.vertical, 5)
                        .overlay(alignment: .bottom) { Rectangle().fill(TechColor.grid).frame(height: 1) }
                    }
                }
            }
        }
    }

    private func heartRatePanel(_ zones: [HeartRateZoneSummary]) -> some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 9) {
                TechSectionHeader(title: "心率区间分布", trailing: "近 28 天")
                if zones.isEmpty {
                    Text("没有满足覆盖率要求的心率数据")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                } else {
                    HStack(spacing: 16) {
                        Chart(zones) { zone in
                            SectorMark(angle: .value("时长", zone.durationSeconds), innerRadius: .ratio(0.78), angularInset: 2)
                                .foregroundStyle(techHeartRateZoneColor(zone.zone))
                        }
                        .chartBackground { _ in
                            VStack(spacing: 5) {
                                Text("总时长").font(.caption2).foregroundStyle(TechColor.muted)
                                Text(nativeDuration(zones.reduce(0) { $0 + $1.durationSeconds }))
                                    .font(.caption.weight(.semibold)).foregroundStyle(TechColor.ink)
                            }
                        }.frame(width: 110, height: 110)
                        VStack(spacing: 10) {
                            ForEach(zones) { zone in
                                HStack(spacing: 6) {
                                    Circle().fill(techHeartRateZoneColor(zone.zone)).frame(width: 6, height: 6)
                                    Text(nativeHeartRateZone(zone.zone)).font(.caption2)
                                    Spacer(minLength: 2)
                                    Text(nativePercent(zone.fraction)).font(.caption.monospacedDigit())
                                }.foregroundStyle(TechColor.muted)
                            }
                        }
                    }
                }
            }
        }
    }

    private func recordsPanel(_ records: PersonalRecords) -> some View {
        VStack(spacing: 22) {
            Image(systemName: "trophy").font(.system(size: 52, weight: .ultraLight))
                .foregroundStyle(TechColor.energy).padding(.top, 16)
            Text("不断突破，成就更好的自己").font(.subheadline).foregroundStyle(TechColor.muted)
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                recordTile("最快 5 公里", value: records.fastest5k.map { nativeDuration($0.paceSecondsPerKm * 5) }, date: records.fastest5k.map { nativeDay($0.startedAt) })
                recordTile("最快 10 公里", value: records.fastest10k.map { nativeDuration($0.paceSecondsPerKm * 10) }, date: records.fastest10k.map { nativeDay($0.startedAt) })
                recordTile("最长距离", value: records.longestDistance.map { nativeKilometers($0.distanceKm) }, date: records.longestDistance.map { nativeDay($0.startedAt) })
                recordTile("最大月跑量", value: records.biggestMonth.map { nativeKilometers($0.distanceKm) }, date: records.biggestMonth?.month)
            }
        }
    }

    private func recordTile(_ title: String, value: String?, date: String?) -> some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 14) {
                Text(title).font(.subheadline).foregroundStyle(TechColor.cyan)
                Text(value ?? "--").font(.title2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(TechColor.ink).lineLimit(1).minimumScaleFactor(0.6)
                Text(date ?? "暂无纪录").font(.caption).foregroundStyle(TechColor.muted)
            }.frame(minHeight: 120, alignment: .topLeading)
        }
    }

    private func recordRow(_ title: String, value: String?) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "trophy.fill")
                .foregroundStyle(TechColor.yellow)
            Text(title)
                .font(.subheadline.weight(.semibold))
            Spacer()
            Text(value ?? "暂无记录")
                .font(.caption.weight(.bold))
                .foregroundStyle(TechColor.muted)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 9)
        .overlay(alignment: .bottom) { Rectangle().fill(TechColor.grid).frame(height: 1) }
    }

    private func legendDot(_ title: String, color: Color) -> some View {
        HStack(spacing: 5) {
            Rectangle().fill(color).frame(width: 9, height: 9)
            Text(title).font(.caption2.weight(.bold)).foregroundStyle(TechColor.muted)
        }
    }

}

struct TechNativeSettingsView: View {
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
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                TechPageHeader(title: "设置") {
                    TechBadge(title: session.isReachable ? "在线" : "离线", color: session.isReachable ? TechColor.green : TechColor.coral, fill: session.isReachable ? TechColor.mint : TechColor.paleCoral)
                }
                settingsLink("RAI 服务", subtitle: session.isReachable ? "已连接" : "待连接", icon: "server.rack", tint: TechColor.cyan) {
                    serverPanel(session: session)
                }
                settingsLink("Apple 健康", subtitle: healthSync.isBusy ? "正在同步" : "只读同步", icon: "heart", tint: TechColor.coral) {
                    healthPanel
                }
                if let date = healthSync.lastSyncAt {
                    Label("上次同步 \(nativeDate(ISO8601DateFormatter().string(from: date)))", systemImage: "clock")
                        .font(.caption).foregroundStyle(TechColor.muted).padding(.horizontal, 4)
                }
                AppSkinPicker()
                settingsLink("本地缓存", subtitle: native.lastCacheUpdate == nil ? "无缓存" : "可离线查看", icon: "externaldrive", tint: TechColor.cyan) {
                    cachePanel
                    versionPanel
                }
                settingsLink("关于 RAI", subtitle: "跑步数据分析与建议", icon: "waveform.path", tint: TechColor.leaf) {
                    versionPanel
                }
                TechPrimaryButton(title: "同步健康数据", isBusy: healthSync.isBusy,
                                  isDisabled: healthSync.isBusy || !session.isReachable) {
                    Task {
                        await healthSync.sync(to: session.serverURL, apiToken: session.apiToken)
                        await native.refreshAll(requestHandshake: false)
                    }
                }
                if let error = healthSync.lastError {
                    TechPanel(tint: TechColor.coral, fill: TechColor.paleCoral) {
                        Label(error, systemImage: "exclamationmark.circle")
                            .font(.footnote).foregroundStyle(TechColor.coral)
                    }
                }
            }
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.top, TechMetrics.pageVertical)
            .padding(.bottom, 18)
        }
        .onAppear {
            draftURL = session.serverURLString
            draftToken = session.apiToken
        }
        .scrollDismissesKeyboard(.interactively)
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .scrollIndicators(.hidden)
        .toolbar(.hidden, for: .navigationBar)
        .alert("清除本机缓存？", isPresented: $showingClearCache) {
            Button("清除", role: .destructive) { native.clearCache() }
            Button("取消", role: .cancel) { }
        } message: {
            Text("服务端数据不会受到影响。")
        }
    }

    private func settingsLink<Content: View>(_ title: String, subtitle: String, icon: String,
                                             tint: Color, @ViewBuilder content: () -> Content) -> some View {
        let destination = content()
        return NavigationLink {
            ScrollView {
                VStack(spacing: 18) { destination }.padding(20)
            }
            .background(TechColor.background).foregroundStyle(TechColor.ink)
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
            .toolbarBackground(TechColor.background, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
        } label: {
            TechPanel {
                HStack(spacing: 14) {
                    TechIconBox(systemName: icon, tint: tint, fill: tint.opacity(0.08))
                    VStack(alignment: .leading, spacing: 6) {
                        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(TechColor.ink)
                        Text(subtitle).font(.caption).foregroundStyle(TechColor.muted)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(TechColor.muted)
                }
            }
        }.buttonStyle(.plain)
    }

    private func serverPanel(session: ServerSession) -> some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 11) {
                TechSectionHeader(title: "服务连接", trailing: session.isReachable ? "已连接" : "待连接", trailingColor: session.isReachable ? TechColor.green : TechColor.coral)
                TechField("服务器地址") {
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
                TechField("API Token（可选）") {
                    SecureField("云端部署时填写", text: Binding(
                        get: { draftToken },
                        set: { draftToken = $0 }
                    ))
                }
                TechPrimaryButton(title: session.isReachable ? "重新检查连接" : "连接服务", systemName: "network", isBusy: native.isLoading, isDisabled: native.isLoading) {
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
                    .foregroundStyle(TechColor.muted)
                }
                if let error = session.lastError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(TechColor.coral)
                }
                if !discovery.candidates.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("发现的 RAI 服务")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TechColor.green)
                        ForEach(discovery.candidates, id: \.absoluteString) { url in
                            Button(url.absoluteString) {
                                draftURL = url.absoluteString
                                draftToken = Keychain.loadToken(for: url.absoluteString)
                            }
                            .font(.caption.monospaced())
                            .foregroundStyle(TechColor.cyan)
                        }
                    }
                }
            }
        }
    }

    private var healthPanel: some View {
        TechPanel(tint: TechColor.coral) {
            VStack(alignment: .leading, spacing: 10) {
                TechSectionHeader(title: "Apple 健康", trailing: healthSync.isBusy ? "同步中" : healthSync.hasCompletedSync ? "已同步" : "未同步", trailingColor: healthSync.isBusy ? TechColor.yellow : TechColor.coral)
                VStack(spacing: 14) {
                    Image(systemName: "heart.fill").font(.system(size: 38)).foregroundStyle(TechColor.coral)
                        .frame(width: 70, height: 70).background(TechColor.paper, in: RoundedRectangle(cornerRadius: 18))
                    Text("Apple 健康").font(.title2.weight(.semibold))
                    Text("只读访问").font(.caption).foregroundStyle(TechColor.cyan)
                    Text("读取跑步、心率、路线、卡路里与恢复数据，用于你的训练分析。")
                        .font(.subheadline).foregroundStyle(TechColor.muted).multilineTextAlignment(.center)
                }.frame(maxWidth: .infinity).padding(.vertical, 20)
                TechPrimaryButton(title: healthSync.isBusy ? "同步中" : "同步健康数据", systemName: "arrow.triangle.2.circlepath", isBusy: healthSync.isBusy, isDisabled: healthSync.isBusy || !session.isReachable) {
                    Task {
                        await healthSync.sync(to: session.serverURL, apiToken: session.apiToken)
                        await native.refreshAll(requestHandshake: false)
                    }
                }
                if let lastSyncAt = healthSync.lastSyncAt {
                    Text("上次同步：\(nativeDate(ISO8601DateFormatter().string(from: lastSyncAt))) · 导入 \(healthSync.lastWorkoutCount ?? 0) 条训练")
                        .font(.caption)
                        .foregroundStyle(TechColor.muted)
                }
                if let phase = healthSync.isBusy ? healthSync.phase : nil {
                    ProgressView().tint(TechColor.coral)
                    Text(phase)
                        .font(.caption2)
                        .foregroundStyle(TechColor.muted)
                }
                if let message = healthSync.message {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(TechColor.muted)
                }
                if let error = healthSync.lastError {
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.circle").font(.system(size: 44, weight: .light))
                        Text("同步未完成").font(.title3.weight(.semibold))
                        Text(error).font(.footnote).multilineTextAlignment(.center)
                    }.foregroundStyle(TechColor.coral).frame(maxWidth: .infinity).padding(.vertical, 18)
                }
                Button("打开健康权限") {
                    guard let url = URL(string: "x-apple-health://") else { return }
                    UIApplication.shared.open(url)
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(TechColor.cyan)
            }
        }
    }

    private var cachePanel: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 9) {
                TechSectionHeader(title: "数据管理", trailing: native.lastCacheUpdate.map { nativeDate(ISO8601DateFormatter().string(from: $0)) } ?? "无缓存", trailingColor: TechColor.cyan)
                Text("缓存用于离线查看首页、训练、统计和趋势；不会删除服务端数据。")
                    .font(.footnote)
                    .foregroundStyle(TechColor.muted)
                Button {
                    showingClearCache = true
                } label: {
                    HStack {
                        Image(systemName: "trash")
                        Text("清除本机页面缓存")
                        Spacer()
                        Image(systemName: "chevron.right")
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(TechColor.coral)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var versionPanel: some View {
        TechPanel(tint: TechColor.cyan) {
            VStack(alignment: .leading, spacing: 8) {
                TechSectionHeader(title: "关于 RAI", trailing: "TECHNOLOGY EDITION", trailingColor: TechColor.cyan)
                LabeledContent("应用", value: "RAI 原生 iOS")
                    .font(.footnote.weight(.bold))
                LabeledContent("最低系统", value: "iOS 17")
                    .font(.footnote.weight(.bold))
                Text("根据你的训练与恢复数据，持续记录跑力变化。")
                    .font(.caption)
                    .foregroundStyle(TechColor.muted)
                LabeledContent("版本", value: (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "—")
                    .font(.footnote)
            }
        }
    }
}


#endif
