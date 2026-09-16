#if os(iOS)
import Charts
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
                        TechIconButton(systemName: "arrow.trianglehead.2.clockwise.rotate.90", accessibilityLabel: "同步健康数据", color: TechColor.cyan) {
                            Task {
                                await healthSync.sync(to: session.serverURL, apiToken: session.apiToken)
                                await native.refreshAll(requestHandshake: false)
                            }
                        }
                        .disabled(healthSync.isBusy || native.isOffline)
                        Text("同步").font(.caption2.weight(.bold)).foregroundStyle(TechColor.muted)
                        }
                        VStack(spacing: 2) {
                        NavigationLink {
                            TechPlanView()
                        } label: {
                            Image(systemName: "calendar")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(TechColor.ink)
                                .frame(width: 44, height: 44)
                                .background(TechColor.paper, in: RoundedRectangle(cornerRadius: 14))
                        }
                        .accessibilityLabel("打开训练计划")
                        Text("训练计划").font(.caption2.weight(.medium)).foregroundStyle(TechColor.muted)
                        }
                    }
                }

                if let today = native.today {
                    if native.isOffline || today.verdict.stale || today.freshness.state != "valid" {
                        TechFreshnessBanner(today: today, isOffline: native.isOffline, cacheDate: native.lastCacheUpdate)
                    }
                    todayHero(today)
                    verdictPanel(today)
                    recoveryPanel(today)
                    TechTodayMetrics(workout: today.recentWorkouts.first)
                        .id(today.generatedAt)
                    recommendationPanel(today)
                    activityPanel(today)
                    raceSummary(today)
                    TodayDetailLinks(data: today)
                    DisclosureGroup("跑力、周计划与训练依据") {
                        abilityPanel(today)
                        planPanel(today)
                        contextPanel(today)
                    }.font(.subheadline).tint(TechColor.cyan)
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
            .padding(.bottom, TechMetrics.bottomClearance)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .scrollIndicators(.hidden)
        .refreshable { await native.refreshAll() }
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showingLock) { TechLockSheet() }
    }

    private func todayHero(_ data: MobileTodayResponse) -> some View {
        TechHeroCard {
            HStack(alignment: .center, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(data.today.workoutCount > 0 ? "今日跑步" : "今日训练")
                        .font(.subheadline).foregroundStyle(TechColor.muted)
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text(nativeNumber(data.today.distanceKm, digits: 2))
                            .font(.system(size: 40, weight: .bold)).monospacedDigit()
                            .lineLimit(1).minimumScaleFactor(0.6)
                        Text("km").font(.subheadline)
                    }.foregroundStyle(TechColor.ink)
                }
                Spacer(minLength: 0)
                ZStack {
                    TechInstrumentRing(progress: data.week.goalProgressFraction ?? 0, size: 112)
                }.accessibilityLabel("本周目标进度 \(nativePercent(data.week.goalProgressFraction))")
            }
            HStack(spacing: 12) {
                heroMetric("时间", techDuration(data.today.durationSeconds))
                heroMetric("平均配速", techPace(data.today.paceSecondsPerKm) + "/km")
                heroMetric("kcal", data.today.energyKcal.map { nativeNumber($0, digits: 0) } ?? "--")
            }
            HStack(spacing: 10) {
                Text("本周 \(nativeNumber(data.week.distanceKm)) / \(nativeNumber(data.week.goalDistanceKm)) km")
                    .font(.caption2).foregroundStyle(TechColor.muted)
                TechProgressBar(fraction: data.week.goalProgressFraction ?? 0)
                Text(nativePercent(data.week.goalProgressFraction)).font(.caption2).foregroundStyle(TechColor.cyan)
            }.padding(.horizontal, 8).padding(.vertical, 6).background(TechColor.paper, in: RoundedRectangle(cornerRadius: 6))
        }
    }

    private func heroMetric(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(value).font(.title3.weight(.semibold).monospacedDigit())
                .foregroundStyle(TechColor.ink).lineLimit(1).minimumScaleFactor(0.65)
            Text(title).font(.caption).foregroundStyle(TechColor.muted)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func raceSummary(_ data: MobileTodayResponse) -> some View {
        if let target = data.race.target {
            NavigationLink { TechPlanView() } label: {
                TechPanel {
                    HStack(spacing: 12) {
                        Image(systemName: "trophy.fill").foregroundStyle(TechColor.cyan)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(target.distance).font(.subheadline.weight(.semibold)).foregroundStyle(TechColor.ink)
                            Text(nativeDay(target.date) + (data.race.daysUntil.map { "（\($0)天）" } ?? ""))
                                .font(.caption).foregroundStyle(TechColor.muted)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(TechColor.muted)
                    }
                }
            }.buttonStyle(.plain)
        }
    }

    private func activityPanel(_ data: MobileTodayResponse) -> some View {
        TechPanel {
            TechSectionHeader(title: "本周训练结构")
            HStack(spacing: 24) {
                TechRing(progress: data.weekStructure.easyDurationFraction ?? 0,
                         value: nativePercent(data.weekStructure.easyDurationFraction), label: "轻松跑比例", size: 82)
                Rectangle().fill(TechColor.grid.opacity(0.5)).frame(width: 1, height: 74)
                VStack(alignment: .leading, spacing: 12) {
                    Text("质量课").font(.caption).foregroundStyle(TechColor.muted)
                    Text("\(data.weekStructure.qualitySessionCount) / \(data.weekStructure.qualitySessionCap) 次")
                        .font(.title3.weight(.semibold)).monospacedDigit()
                    HStack(spacing: 10) {
                        ForEach(0..<max(data.weekStructure.qualitySessionCap, 1), id: \.self) { index in
                            Circle().fill(index < data.weekStructure.qualitySessionCount ? TechColor.cyan : TechColor.grid)
                                .frame(width: 10, height: 10)
                        }
                    }.accessibilityHidden(true)
                    Text("轻松执行度 \(nativePercent(data.weekStructure.easyHonesty.honestyFraction))")
                        .font(.caption).foregroundStyle(TechColor.muted)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func abilityPanel(_ data: MobileTodayResponse) -> some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 11) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        TechSectionHeader(title: "当前跑力", trailing: techStatusName(data.calibration.status), trailingColor: TechColor.cyan)
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
            HStack(alignment: .center, spacing: 14) {
                VStack(alignment: .leading, spacing: 7) {
                    TechSectionHeader(title: "训练判定")
                    Text(data.verdict.title).font(.title3.weight(.semibold)).foregroundStyle(tone)
                    Text(data.verdict.reason).font(.footnote).foregroundStyle(TechColor.muted)
                }
                TechInstrumentRing(progress: 0, size: 60).accessibilityHidden(true)
            }
            if !data.verdict.triggers.isEmpty {
                DisclosureGroup("判定依据") {
                    ForEach(data.verdict.triggers, id: \.code) { trigger in
                        Text(trigger.detail).font(.caption).foregroundStyle(TechColor.muted)
                    }
                }.font(.caption).tint(tone)
            }
        }
    }

    private func recommendationPanel(_ data: MobileTodayResponse) -> some View {
        TechPanel {
            TechSectionHeader(title: "今日推荐训练")
            Label("\(data.nextSession.title) \(nativeKilometers(data.nextSession.distanceKm))", systemImage: nativeSessionSymbol(data.nextSession.kind))
                .font(.headline).foregroundStyle(TechColor.cyan)
            Divider().overlay(TechColor.grid)
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("建议配速 " + techPaceRange(data.nextSession.paceSecondsPerKmLower, data.nextSession.paceSecondsPerKmUpper))
                    Text("预计时间 \(data.nextSession.durationMinutes.map { nativeNumber($0, digits: 0) + " 分钟" } ?? "待评估")")
                }.font(.caption).foregroundStyle(TechColor.muted)
                Spacer(minLength: 8)
                Button { showingLock = true } label: {
                    Text(data.lock.present ? "已锁定" : "锁定安排").font(.caption.weight(.semibold))
                        .foregroundStyle(TechColor.background).padding(.horizontal, 14).frame(minHeight: 44)
                        .background(TechColor.action, in: Capsule())
                }.buttonStyle(.plain).disabled(data.lock.present || data.verdict.stale || native.isOffline)
                    .opacity(data.lock.present || data.verdict.stale || native.isOffline ? 0.5 : 1)
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
        TechPanel {
            TechSectionHeader(title: "恢复状态")
            HStack(spacing: 22) {
                VStack(spacing: 8) {
                    Image(systemName: data.recovery.state == "recovered" ? "heart.fill" : "heart.text.square")
                        .font(.system(size: 30)).foregroundStyle(techToneColor(data.recovery.state ?? "unknown"))
                    Text(data.recovery.stateLabel).font(.subheadline.weight(.semibold))
                        .foregroundStyle(TechColor.ink)
                }.frame(minWidth: 82)
                Rectangle().fill(TechColor.grid.opacity(0.5)).frame(width: 1, height: 64)
                Text(data.recovery.note).font(.footnote).foregroundStyle(TechColor.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
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
                        Text(day.kind == "rest" ? "休息" : nativeKilometers(day.distanceKm))
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

    private struct TodayDetailLinks: View {
        let data: MobileTodayResponse

        var body: some View {
            VStack(alignment: .leading, spacing: 8) {
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
                    .buttonStyle(.plain).accessibilityIdentifier("today.week")

                    NavigationLink {
                        TechBodyMetricsView(data: data)
                    } label: {
                        detailLink(
                            title: "身体指标",
                            subtitle: data.recovery.state == "recovered" ? "状态良好" : techStatusName(data.recovery.state),
                            systemName: "heart",
                            tint: TechColor.cyan,
                            fill: TechColor.paper
                        )
                    }
                    .buttonStyle(.plain).accessibilityIdentifier("today.body")
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
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(TechColor.ink)
                    Text(subtitle).font(.caption2).foregroundStyle(TechColor.muted).lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: systemName).font(.system(size: 19, weight: .regular)).foregroundStyle(tint)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(11)
            .background(TechColor.paper, in: RoundedRectangle(cornerRadius: TechMetrics.corner))
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
                            techMetricCaption("目标配速", value: "\(techPace(target.targetPaceSecondsPerKm))/km")
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
                HStack {
                    Image(systemName: "calendar").foregroundStyle(TechColor.cyan)
                    Spacer()
                    Text((data.weekDaily.first.map { nativeDay($0.localDate) } ?? "—") + " – " + (data.weekDaily.last.map { nativeDay($0.localDate) } ?? "—"))
                        .font(.headline)
                    Spacer()
                }.padding(.vertical, 6)
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
                            Text("\(data.week.workoutCount) 次 · \(techDuration(data.week.durationSeconds))")
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

                HStack(spacing: 10) {
                    TechMetricTile(title: "本周总时长", value: techDuration(data.week.durationSeconds))
                    TechMetricTile(title: "本周跑步次数", value: "\(data.week.workoutCount) 次")
                }
                TechPanel {
                    TechSectionHeader(title: "每日明细", trailing: "公里 / 次数")
                    ForEach(data.weekDaily) { day in
                        HStack {
                            Text(nativeDay(day.localDate)).font(.subheadline)
                            Spacer()
                            Text(nativeKilometers(day.distanceKm)).font(.subheadline.monospacedDigit())
                            Text("\(day.workoutCount) 次").font(.caption).foregroundStyle(TechColor.muted).frame(width: 40)
                        }.padding(.vertical, 7)
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
                                Text(day.kind == "rest" ? "休息" : nativeKilometers(day.distanceKm))
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
            .padding(.bottom, TechMetrics.bottomClearance)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .scrollIndicators(.hidden)
        .techNavigation("本周活动")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbarBackground(TechColor.background, for: .navigationBar)
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
                if summary.verdict.stale || native.isOffline {
                    TechFreshnessBanner(today: summary, isOffline: native.isOffline, cacheDate: native.lastCacheUpdate)
                }
                TechSectionHeader(title: "身体状态")
                readinessPanel
                HStack(spacing: 10) {
                    TechMetricTile(title: "静息心率", value: nativeNumber(summary.recovery.restingHeartRateBpm, digits: 0) + " bpm")
                    TechMetricTile(title: "HRV", value: nativeNumber(summary.recovery.morningHrvMs, digits: 0) + " ms")
                }
                TechPanel {
                    HStack {
                        TechIconBox(systemName: "moon.fill", tint: TechColor.leaf)
                        VStack(alignment: .leading, spacing: 6) {
                            Text("睡眠时长").font(.caption).foregroundStyle(TechColor.muted)
                            Text(nativeHoursMinutes(summary.recovery.lastNightSleepMinutes)).font(.title2.weight(.semibold))
                        }
                        Spacer()
                        TechSleepHistory().id(summary.generatedAt)
                    }
                }
                TechSectionHeader(title: "恢复状态")
                recoveryPanel
                zonePanels
                predictionsPanel
                DisclosureGroup("核心能力与配速参考") {
                    coreMetricsPanel
                    pacePanel
                }.font(.subheadline).tint(TechColor.cyan)

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
            .padding(.bottom, TechMetrics.bottomClearance)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .scrollIndicators(.hidden)
        .techNavigation("身体指标")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbarBackground(TechColor.background, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .task {
            await native.refreshBodyMetrics()
        }
        .refreshable {
            await native.refreshBodyMetrics()
        }
    }

    private var readinessPanel: some View {
        HStack(spacing: 10) {
            TechPanel {
                HStack(spacing: 6) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("准备度").font(.caption).foregroundStyle(TechColor.muted)
                        Text(nativePercent(native.predictions?.inputs.recoveryReadiness)).font(.title2.weight(.semibold)).monospacedDigit()
                        Text("预测快照").font(.caption2).foregroundStyle(TechColor.muted)
                    }
                    Spacer(minLength: 0)
                    TechGauge(progress: native.predictions?.inputs.recoveryReadiness ?? 0, value: "", label: "", size: 46)
                }
            }
            TechPanel {
                HStack(spacing: 6) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("VDOT").font(.caption).foregroundStyle(TechColor.muted)
                        Text(nativeNumber(native.predictions?.snapshot.performanceVdot.value, digits: 1)).font(.title2.weight(.semibold)).monospacedDigit()
                        Text("预测快照").font(.caption2).foregroundStyle(TechColor.muted)
                    }
                    Spacer(minLength: 0)
                    TechRunnerIcon(size: 34)
                }
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
                    metricTile(title: "乳酸阈配速", value: techPace(native.predictions?.snapshot.lactateThreshold.paceSecondsPerKm), unit: "/km", accent: TechColor.cyan)
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
                    metricTile(title: "最近训练平均配速", value: techPace(latest), unit: "/km", accent: TechColor.green)
                    metricTile(title: "轻松跑配速", value: paceRange(easy?.lowerSecondsPerKm, easy?.upperSecondsPerKm), unit: nil, accent: TechColor.cyan)
                }
                if let rolling {
                    Text("近 28 天平均配速：\(techPace(rolling))/km。训练平均配速不等于轻松跑处方。")
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
        TechPanel {
            HStack(spacing: 22) {
                TechGauge(progress: 0,
                          value: nativeNumber(summary.recovery.score, digits: 0),
                          label: "恢复状态", size: 86)
                Text(summary.recovery.note).font(.footnote).foregroundStyle(TechColor.muted)
            }
            DisclosureGroup("恢复基线") {
                bodyMetricRow("睡眠基线", value: summary.recovery.sleepBaselineMinutes.map { nativeHoursMinutes($0) })
                bodyMetricRow("HRV 基线", value: summary.recovery.hrvBaselineMs.map { "\(nativeNumber($0)) ms" })
                bodyMetricRow("静息心率基线", value: summary.recovery.restingHeartRateBaselineBpm.map { "\(nativeNumber($0, digits: 0)) bpm" })
            }.font(.caption).tint(TechColor.cyan)
        }
    }

    @ViewBuilder
    private var zonePanels: some View {
        if let profile = native.trainingZones?.profile {
            TechPanel(tint: TechColor.cyan) {
                VStack(alignment: .leading, spacing: 9) {
                    TechSectionHeader(title: "配速分区", trailing: "按阈值配速计算", trailingColor: TechColor.cyan)
                    ForEach(profile.paceBands) { band in
                        zoneRow(code: techPaceZoneCode(band.zone), label: nativePaceZone(band.zone), value: paceRange(band.lowerSecondsPerKm, band.upperSecondsPerKm), tint: nativePaceZoneColor(band.zone))
                    }
                }
            }
            TechPanel {
                VStack(alignment: .leading, spacing: 9) {
                    TechSectionHeader(title: "心率分区", trailing: "\(nativeNumber(profile.restingHeartRateBpm, digits: 0))–\(nativeNumber(profile.maximumHeartRateBpm, digits: 0)) bpm", trailingColor: TechColor.coral)
                    ForEach(profile.heartRateBands) { band in
                        zoneRow(code: techHeartRateZoneCode(band.zone), label: nativeHeartRateZone(band.zone), value: techHeartRateRange(band.lowerBpm, band.upperBpm), tint: techHeartRateZoneColor(band.zone))
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
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        ForEach(races) { race in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(nativeRaceDistance(race.distance)).font(.subheadline).foregroundStyle(TechColor.muted)
                                Text(techDuration(race.predictedSeconds)).font(.title2.weight(.semibold)).monospacedDigit()
                                    .lineLimit(1).minimumScaleFactor(0.6)
                                Text(racePredictionText(race)).font(.caption2).foregroundStyle(TechColor.muted)
                                Text("准备度 " + nativePercent(race.readiness)).font(.caption).foregroundStyle(TechColor.cyan)
                            }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                .background(TechColor.blue.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
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

    private func zoneRow(code: String, label: String, value: String, tint: Color) -> some View {
        HStack(spacing: 8) {
            Text(code).font(.caption.weight(.semibold)).foregroundStyle(TechColor.background)
                .frame(width: 28, height: 24).background(tint, in: RoundedRectangle(cornerRadius: 6))
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
        techPaceRange(lower, upper)
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
        case "easy": return TechColor.cyan
        case "marathon": return TechColor.blue
        case "lactate_threshold": return TechColor.leaf
        case "anaerobic_endurance": return Color.purple
        case "sprint": return Color.pink
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
                        Text(techStatusName(today.freshness.state))
                            .font(.caption2.weight(.semibold))
                    }
                    DisclosureGroup {
                        Text("结果生成于 \(nativeDate(today.generatedAt))")
                        if let cacheDate {
                            Text("缓存更新于 \(nativeDate(ISO8601DateFormatter().string(from: cacheDate)))")
                        }
                    } label: {
                        Text("健康数据截至 \(nativeDay(today.latestDataDate ?? "未知"))")
                    }
                    .font(.caption2).foregroundStyle(TechColor.muted).tint(tint)
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
        techDuration(native.trainingStatistics?.month?.durationSeconds)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                TechPageHeader(title: "训练", eyebrow: "KEEP GOING") {
                    TechBadge(title: "共 \(native.workoutTotal) 次", color: TechColor.cyan, fill: TechColor.paleCyan)
                }
                TechFilterChips(
                    items: filters.map { (title: $0.0, value: $0.1 ?? "all") },
                    selection: selectedFilter
                )
                TechHeroCard {
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("本月总里程").font(.caption).foregroundStyle(TechColor.muted)
                            Text(monthDistance).font(.system(size: 32, weight: .semibold)).monospacedDigit()
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 12) {
                            Text("训练次数").font(.caption).foregroundStyle(TechColor.muted)
                            Text(monthWorkoutCount + " 次").font(.title2.weight(.semibold)).monospacedDigit()
                        }
                    }
                    Text("本月累计时长 " + monthDuration).font(.caption).foregroundStyle(TechColor.muted)
                    if let months = native.statistics?.months, months.count > 1 {
                        TechSparkline(values: months.map(\.totalDistanceKm))
                        Text("近 \(months.count) 个月里程 · km")
                            .font(.caption2).foregroundStyle(TechColor.muted)
                    }

                }
                if native.workouts.isEmpty && native.isLoadingWorkouts {
                    TechLoadingState(title: "正在读取训练")
                } else if native.workouts.isEmpty {
                    VStack(spacing: 24) {
                        VStack(spacing: 16) {
                            TechEmptyState(title: "尚无训练记录", message: "连接 Apple 健康并同步后查看训练；当前筛选也可能暂无记录。", systemName: "shoe")
                            NavigationLink { TechNativeSettingsView() } label: {
                                Text("前往同步").font(.subheadline.weight(.semibold))
                                    .foregroundStyle(TechColor.background).frame(maxWidth: .infinity, minHeight: 48)
                                    .background(TechColor.cyan, in: Capsule())
                            }
                        }
                        TechPanel(tint: TechColor.blue, fill: TechColor.blue.opacity(0.09)) {
                            Label("数据不足时不显示评分", systemImage: "info.circle")
                                .font(.subheadline.weight(.medium)).foregroundStyle(TechColor.ink)
                            Text("累积足够的训练数据后，才会显示训练评分和相关分析。")
                                .font(.caption).foregroundStyle(TechColor.muted)
                        }
                    }
                } else {
                    LazyVStack(spacing: 8) {
                            ForEach(native.workouts) { workout in
                                NavigationLink {
                                    TechWorkoutDetailView(workoutId: workout.id)
                                } label: {
                                    TechWorkoutRow(workout: workout)
                                        .padding(.horizontal, 12)
                                        .background(TechColor.paper, in: RoundedRectangle(cornerRadius: 14))
                                }
                                .buttonStyle(.plain).accessibilityIdentifier("workout.\(workout.id)")
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
            .padding(.bottom, TechMetrics.bottomClearance)
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
        HStack(spacing: 12) {
            TechIconBox(systemName: nativeSessionSymbol(workout.sessionType, indoor: workout.indoor == true), tint: tint, fill: TechColor.blue.opacity(0.12))
            VStack(alignment: .leading, spacing: 5) {
                Text(nativeSessionName(workout.sessionType) + (workout.indoor == true ? " · 室内" : ""))
                    .font(.subheadline.weight(.semibold)).foregroundStyle(TechColor.ink)
                Text(techKilometers(workout.distanceKm)).font(.subheadline.monospacedDigit()).foregroundStyle(TechColor.ink)
                Text(nativeDate(workout.startedAt)).font(.caption2).foregroundStyle(TechColor.muted)
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 6) {
                Text(techPace(workout.averagePaceSecondsPerKm) + "/km").font(.subheadline.monospacedDigit()).foregroundStyle(TechColor.ink)
                Text(techDuration(workout.durationSeconds)).font(.caption.monospacedDigit()).foregroundStyle(TechColor.muted)
            }
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(TechColor.muted)
        }.padding(.vertical, 10)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(nativeSessionName(workout.sessionType))，\(nativeDate(workout.startedAt))，\(nativeKilometers(workout.distanceKm))，\(techPace(workout.averagePaceSecondsPerKm))/km，\(techStatusName(workout.assessmentStatus))")
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
                    detailOverview(detail.workout)
                    if !detail.route.isEmpty { routePanel(detail.route) }
                    DisclosureGroup("全部训练指标") { detailMetrics(detail.workout) }
                        .font(.subheadline).tint(TechColor.cyan)
                    if let series = native.selectedSeries { seriesPanel(series) }
                    segmentPanel(native.selectedSeries)
                    splitPanel(native.selectedSeries?.splits ?? [])
                    qualityPanel(detail)
                    if let load = detail.trainingLoad { trainingLoadPanel(load) }
                    if let zones = detail.zoneSummary { zonePanel(zones) }
                    if let override = detail.override { overridePanel(override) }
                }
                .padding(.horizontal, TechMetrics.pageHorizontal)
                .padding(.vertical, TechMetrics.pageVertical)
                .padding(.bottom, TechMetrics.bottomClearance)
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
        .techNavigation("训练详情")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbarBackground(TechColor.background, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .task(id: workoutId) { await native.loadWorkout(id: workoutId) }
        .refreshable { await native.loadWorkout(id: workoutId) }
    }

    private func detailHeader(_ workout: WorkoutDetail) -> some View {
        HStack(spacing: 14) {
            TechIconBox(systemName: nativeSessionSymbol(workout.sessionType), size: 48)
            VStack(alignment: .leading, spacing: 6) {
                Text(nativeSessionName(workout.sessionType)).font(.headline)
                Text(nativeDate(workout.startedAt)).font(.caption).foregroundStyle(TechColor.muted)
            }
            Spacer()
            if workout.indoor == true { TechBadge(title: "室内") }
        }.padding(.vertical, 6)
    }

    private func detailOverview(_ workout: WorkoutDetail) -> some View {
        VStack(spacing: 8) {
            TechPanel {
                HStack {
                    overviewMetric(techKilometers(workout.distanceKm), "距离")
                    overviewMetric(techDuration(workout.durationSeconds), "时长")
                }
            }
            HStack(spacing: 7) {
                TechMetricTile(title: "平均配速", value: techPace(workout.averagePaceSecondsPerKm) + "/km")
                TechMetricTile(title: "平均心率", value: nativeNumber(workout.averageHeartRateBpm, digits: 0) + " bpm")
                TechMetricTile(title: "能量消耗", value: nativeNumber(workout.activeEnergyKcal, digits: 0) + " kcal")
            }
        }
    }

    private func overviewMetric(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(value).font(.system(size: 32, weight: .semibold)).monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.7)
            Text(label).font(.caption).foregroundStyle(TechColor.muted)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
    }

    private func detailMetrics(_ workout: WorkoutDetail) -> some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
            TechMetricTile(title: "距离", value: nativeKilometers(workout.distanceKm), accent: TechColor.cyan)
            TechMetricTile(title: "时长", value: techDuration(workout.durationSeconds), accent: TechColor.green)
            TechMetricTile(title: "配速", value: "\(techPace(workout.averagePaceSecondsPerKm))/km", accent: TechColor.cyan)
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
                    TechRouteView(route: route)
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
                TechFilterChips(items: metricItems.map { (title: $0.0, value: $0.1) }, selection: $selectedMetric)
                if metric.points.isEmpty {
                    Text("没有可展示的\(metric.unit)样本")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
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

    /// What the run was actually made of — the plan's own steps, or the Watch's
    /// own lap boundaries, rather than a 1 km ruler.
    ///
    /// Rendered above the kilometre split because it answers "did I run the
    /// session I was given"; the split stays as the neutral fallback. An empty
    /// panel always explains itself — "no segments" is a fact, a blank is a bug.
    private func segmentPanel(_ series: WorkoutSeriesResponse?) -> some View {
        let segments = series?.segments ?? []
        return TechPanel {
            VStack(alignment: .leading, spacing: 4) {
                TechSectionHeader(title: "课表分段", trailing: "\(segments.count) 段")
                if let note = series?.segmentNote {
                    Text(note)
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                }
                if let plan = series?.segmentPlan {
                    Text("匹配 \(plan.localDate) 第 \(plan.revision) 版课表（\(nativeSessionName(plan.kind))）· 可解释 \(nativePercent(plan.explainedFraction))")
                        .font(.caption2.weight(.bold).monospacedDigit())
                        .foregroundStyle(TechColor.cyan)
                }
                if segments.isEmpty {
                    Text("没有课表分段，可参考下方公里分段")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                } else {
                    ForEach(segments) { segment in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 8) {
                                Text(segment.label)
                                    .font(.subheadline.weight(.semibold))
                                    .frame(minWidth: 64, alignment: .leading)
                                Spacer()
                                Text(nativeDuration(segment.durationSeconds))
                                Text(nativeKilometers(segment.distanceMeters / 1000))
                                Text("\(techPace(segment.averagePaceSecondsPerKm))/km")
                                Text(segment.averageHeartRateBpm.map { "\(nativeNumber($0, digits: 0)) bpm" } ?? "--")
                            }
                            .font(.caption.weight(.bold).monospacedDigit())
                            .foregroundStyle(TechColor.muted)
                            HStack(spacing: 10) {
                                Text(nativeSegmentDose(segment))
                                if let alert = nativeSegmentAlert(segment) { Text(alert) }
                            }
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(TechColor.cyan)
                        }
                        .padding(.vertical, 7)
                        .overlay(alignment: .bottom) { Rectangle().fill(TechColor.grid).frame(height: 1) }
                    }
                }
            }
        }
    }

    private func splitPanel(_ splits: [WorkoutSplit]) -> some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 4) {
                TechSectionHeader(title: "公里分段", trailing: "\(splits.count) 段")
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
                            Text("\(techPace(split.averagePaceSecondsPerKm))/km")
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
                    techMetricCaption("评估状态", value: techStatusName(detail.workout.assessmentStatus))
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
        TechPanel {
            TechSectionHeader(title: "训练负荷")
            Text(nativeNumber(load.load)).font(.system(size: 34, weight: .semibold)).monospacedDigit()
                .foregroundStyle(TechColor.ink)
            DisclosureGroup("负荷依据") {
                HStack(spacing: 8) {
                    techMetricCaption("强度", value: nativeNumber(load.intensity))
                    techMetricCaption("置信度", value: nativePercent(load.confidence))
                    techMetricCaption("心率", value: load.averageHeartRate.map { nativeNumber($0, digits: 0) } ?? "--")
                }
                Text("来源：\(load.source) · 刺激：\(nativeStimulusName(load.stimulusType))")
                    .font(.caption).foregroundStyle(TechColor.muted)
                ForEach(load.explanations, id: \.code) { explanation in
                    Text(explanation.code + (explanation.value.map { " · \(nativeNumber($0))" } ?? ""))
                        .font(.caption2).foregroundStyle(TechColor.muted)
                }
            }.font(.caption).tint(TechColor.cyan)
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
    @State private var isSyncingPlan = false
    @State private var planSyncMessage: String?
    @State private var selectedDay: MobileWeekPlanDay?
    @Environment(NativeAppModel.self) private var native
    @State private var weeklyText = "30"
    @State private var easyFloor = 0.8
    @State private var qualityCap = 2
    @State private var weekPlan: [MobileGoalsPlanItem] = []
    @State private var distanceDrafts: [String: String] = [:]
    @State private var isSaving = false
    @State private var saveMessage: String?

    // The bounds, the parsing rule and the "clear a stale structure" rule are
    // shared with the pixel skin through `NativeGoalWeekDraft`; none of them is a
    // skin decision, and keeping a copy per skin is how the 2026-09-13 fix ended
    // up in one skin only.
    private var weeklyValue: Double? { NativeGoalWeekDraft.parsedDistance(weeklyText) }
    private var areDistancesValid: Bool {
        NativeGoalWeekDraft.distancesAreValid(distanceDrafts, for: weekPlan)
    }
    private var isWeeklyValid: Bool { NativeGoalWeekDraft.weeklyDistanceIsValid(weeklyText) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                if editing {
                    goalEditor
                    weekPlanPanel
                TechPrimaryButton(title: "保存计划", systemName: "checkmark", isBusy: isSaving, isDisabled: isSaving || !isWeeklyValid || !areDistancesValid || native.isOffline || native.goals == nil) {
                    Task { await save() }
                }
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
            .padding(.bottom, TechMetrics.bottomClearance)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .scrollIndicators(.hidden)
        .techNavigation(editing ? "编辑周计划" : "训练计划")
        .sheet(isPresented: $showingLock) { TechLockSheet() }
        .sheet(item: $selectedDay) { day in
            TechPlanDaySheet(day: day, isToday: day.localDate == native.today?.today.localDate)
        }
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
            // The watch panel lives on this page now, so it must be able to fill
            // itself even when the home screen never ran in this session.
            if native.workoutPlan == nil { _ = await native.refreshWorkoutPlan() }
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
                    TechGauge(progress: native.goals?.easyDurationFloorFraction ?? 0,
                             value: nativePercent(native.goals?.easyDurationFloorFraction), label: "轻松占比", size: 68)
                    TechGauge(progress: Double(native.goals?.qualitySessionCap ?? 0) / 4,
                              value: "\(native.goals?.qualitySessionCap ?? 0)", label: "质量课上限", size: 68)
                }

            }
            TechSectionHeader(title: "7 天训练安排", trailing: "本周")
            if native.today?.weekPlan.isEmpty != false {
                Text("尚未取到本周安排").font(.footnote).foregroundStyle(TechColor.muted)
            } else {
                // The executable week, straight from `/v1/mobile/today` — the
                // same array the home screen draws its week card from, so the
                // two screens cannot name a different session for one date.
                // Building the chips from the *stored* plan instead read the
                // last saved prescription for every date: today showed a
                // session the recovery gate had already overruled, and a past
                // day showed "间歇跑 8.6 km" while the home screen showed what
                // was actually run. The server already resolves the three
                // tenses (`buildWeekPlan`), and that rule stays on the server.
                //
                // Seven equal columns, not a fixed 46pt chip inside a horizontal
                // scroller: the strip *is* the week, so a scroller both clipped
                // the last day and left the row short of the page's right edge.
                // Tapping a column opens that day's prescription, which is the
                // only place the interval breakdown is spelled out.
                HStack(spacing: 5) {
                    ForEach(native.today?.weekPlan ?? []) { day in
                        Button { selectedDay = day } label: { weekChip(day) }
                            .buttonStyle(.plain)
                            .frame(maxWidth: .infinity)
                            .accessibilityLabel(weekChipLabel(day))
                    }
                }
                .frame(maxWidth: .infinity)
            }
            if native.isOffline {
                Label("离线时可查看计划，重新连接后可编辑", systemImage: "wifi.slash")
                    .font(.footnote).foregroundStyle(TechColor.yellow)
            }
            watchPlanPanel
        }
    }

    /// One column of the week strip. Every column is the same width so the row
    /// ends flush with the panel's right edge; the labels shrink rather than
    /// wrap, because a wrapped column would silently change the row's height.
    private func weekChip(_ day: MobileWeekPlanDay) -> some View {
        let isToday = day.localDate == native.today?.today.localDate
        return VStack(spacing: 11) {
            VStack(spacing: 4) {
                Text(nativeWeekday(day.localDate))
                Text(nativeDay(day.localDate))
            }
            .font(.caption2)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .foregroundStyle(isToday ? TechColor.background : TechColor.muted)
            .background(isToday ? TechColor.action : TechColor.grid.opacity(0.25), in: RoundedRectangle(cornerRadius: 6))
            Circle().fill(techSessionColor(day.kind)).frame(width: 8, height: 8)
            Text(nativeSessionName(day.kind))
                .font(.caption2)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .foregroundStyle(TechColor.ink)
            Text(day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : "—")
                .font(.caption2.monospacedDigit())
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .foregroundStyle(TechColor.muted)
        }
        .padding(.horizontal, 2)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity)
        .background(isToday ? TechColor.blue.opacity(0.17) : TechColor.paper, in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(isToday ? TechColor.cyan : TechColor.grid.opacity(0.45), lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: 9))
    }

    private func weekChipLabel(_ day: MobileWeekPlanDay) -> String {
        let distance = day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : "无距离"
        return "\(nativeWeekday(day.localDate))\(nativeDay(day.localDate))，\(nativeSessionName(day.kind))，\(distance)，查看训练详情"
    }

    /// Generation and sync stay two separate actions, and they live here now:
    /// the home screen no longer carries the watch panel, so this page is the
    /// only place that can rewrite the stored week or mirror it onto the watch.
    private var watchPlanPanel: some View {
        let plan = native.workoutPlan
        // The panel used to count the server's `executable` flag, which is a
        // looser question than "did this day survive mapping" — a week could read
        // "5 项可上表" while the watch received four. Counting with the bridge's
        // own predicate keeps the sentence and the sync in agreement, and that
        // predicate now also leaves out the days the watch is no longer owed — over,
        // or already trained — which the sentence below has always promised
        // ("已完成的日期不会重复下发").
        //
        // Reading the offer rather than recomputing a count is what lets the zero
        // case say *why* it is zero: a week that is finished or already run is not a
        // shortfall, and the old copy told the runner to regenerate it anyway, while
        // the sync itself reported "本周没有还需要上表的训练". One classification,
        // two surfaces.
        let now = Date()
        let offer = plan.map {
            WorkoutPlanMapper.weekOffer(in: $0, now: now, completedLocalDates: native.completedWeekDates)
        }
        let schedulableCount = offer?.offered.count ?? 0
        let unoffered = plan.map {
            WorkoutPlanMapper.unofferedDays(in: $0, completedLocalDates: native.completedWeekDates)
        } ?? []
        return TechPanel {
            VStack(alignment: .leading, spacing: 12) {
                TechSectionHeader(
                    title: "手表课表",
                    trailing: plan == nil ? "未生成" : "\(schedulableCount) 项可上表",
                    trailingColor: TechColor.cyan
                )
                if plan == nil {
                    Text("还没有本周课表。生成后即可一键同步到手表「体能训练」。")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                } else if schedulableCount == 0 {
                    // The fallback is the same string the classifier would return for
                    // a week with nothing usable in it, so "no plan to ask" and "plan
                    // with nothing to send" stay one sentence rather than two copies.
                    Text(offer?.emptyOfferMessage ?? WorkoutPlanMapper.WeekOffer.unusableWeekMessage)
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                } else {
                    Text("将把 \(schedulableCount) 天训练写入手表「体能训练」，已完成的日期不会重复下发。")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                }
                if !unoffered.isEmpty {
                    // "N 项可上表" already implies something was left out; naming
                    // which days, and why, is the only part the runner can act on.
                    Text("以下日期不会上表：" + unoffered
                        .map { "\(nativeDay($0.localDate)) \($0.reason)" }
                        .joined(separator: "、"))
                        .font(.caption)
                        .foregroundStyle(TechColor.coral)
                }
                if let audit = plan?.audit {
                    Text(
                        audit.generatedBy == "llm"
                            ? "由 \(audit.model ?? "大模型") 生成 · \(nativeDate(audit.generatedAt ?? ""))"
                            : "由保守模板生成 · \(nativeDate(audit.generatedAt ?? ""))"
                    )
                    .font(.caption2)
                    .foregroundStyle(TechColor.muted)
                }
                if let message = native.planMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(TechColor.ink)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(TechColor.paleYellow, in: RoundedRectangle(cornerRadius: 12))
                }
                if let message = planSyncMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(TechColor.ink)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(TechColor.mint, in: RoundedRectangle(cornerRadius: 12))
                }
                TechPrimaryButton(
                    title: "一键同步到手表",
                    systemName: "applewatch",
                    isBusy: isSyncingPlan,
                    isDisabled: native.isOffline || schedulableCount == 0
                ) {
                    syncPlanToWatch()
                }
                Button {
                    Task { _ = await native.regenerateWeeklyPlan() }
                } label: {
                    HStack(spacing: 6) {
                        if native.isRegeneratingPlan {
                            ProgressView().tint(TechColor.cyan).scaleEffect(0.7)
                        } else {
                            Image(systemName: "wand.and.stars")
                        }
                        Text(native.isRegeneratingPlan ? "生成中…" : "重新生成本周课表")
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(TechColor.cyan)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background {
                        Capsule().stroke(TechColor.cyan, lineWidth: 1)
                    }
                }
                .buttonStyle(.plain)
                .disabled(native.isRegeneratingPlan || native.isOffline)
            }
        }
    }

    private func syncPlanToWatch() {
        guard let plan = native.workoutPlan, !isSyncingPlan else { return }
        isSyncingPlan = true
        planSyncMessage = nil
        Task {
            // Permission is asked for only when the user actually tries to sync, so
            // the system prompt arrives with an obvious reason attached to it.
            let outcome = await WorkoutKitBridge.syncRequestingAuthorization(
                plan: plan,
                completedLocalDates: native.completedWeekDates
            )
            // Receipts are registered only for the days the bridge read back off
            // the scheduler: the row means "the watch received this day", and a
            // plan that never got there must not be allowed to label a later run.
            let receipt = outcome.scheduledLocalDates.isEmpty
                ? nil
                : await native.recordPlanSync(plan, localDates: outcome.scheduledLocalDates)
            isSyncingPlan = false
            planSyncMessage = [outcome.report, receipt].compactMap { $0 }.joined(separator: "；")
        }
    }

    private var goalEditor: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 13) {
                TechSectionHeader(title: "周目标", trailing: "1–500 km")
                TechField("每周跑量") {
                    HStack {
                        TextField("30", text: $weeklyText)
                            .accessibilityIdentifier("plan.weeklyDistance")
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
                        .tint(TechColor.cyan)
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

            }
        }
    }

    /// The rows of the stored plan this editor may change.
    ///
    /// Today is not one of them, and neither is any day before it. Today's
    /// session is decided by the coach's recovery gate, not by the stored plan —
    /// `planOverview` above and the home screen both render the gate's answer —
    /// so a row here would offer an edit that never takes effect. The server
    /// marks every day before today `rest/0` for every reader, so those rows are
    /// equally inert. Both are still round-tripped on save, so hiding them costs
    /// no data; it is only the *editing* that would be a lie.
    ///
    /// When today's date is unknown — `/v1/mobile/today` failed while the goals
    /// request succeeded — nothing is offered. The editor cannot tell which row
    /// is the inert one, and guessing would restore exactly the edit this
    /// property exists to withhold.
    private var editablePlanIndexes: [Int] {
        guard let today = native.today?.today.localDate else { return [] }
        return weekPlan.indices.filter { weekPlan[$0].localDate > today }
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
                } else if editablePlanIndexes.isEmpty {
                    Text(native.today == nil
                        ? "未能取到今日状态，无法确定哪一天由恢复状态决定，暂不可编辑。"
                        : "今天之前的日期由服务端置为休息，今天由恢复状态决定；本周没有可编辑的日期。")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                } else {
                    ForEach(editablePlanIndexes, id: \.self) { index in
                        let item = weekPlan[index]
                        HStack(spacing: 7) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(nativeWeekday(item.localDate)).font(.caption.weight(.semibold))
                                Text(nativeDay(item.localDate)).font(.caption2).foregroundStyle(TechColor.muted)
                            }.frame(width: 48, alignment: .leading)
                            Picker("训练类型", selection: $weekPlan[index].kind) {
                                Text("休息").tag("rest")
                                Text("恢复跑").tag("recovery")
                                Text("轻松跑").tag("easy")
                                Text("长距离").tag("long_run")
                                Text("节奏跑").tag("tempo")
                                Text("间歇跑").tag("interval")
                            }.pickerStyle(.menu).tint(TechColor.cyan).frame(maxWidth: .infinity, minHeight: 44)
                            TextField("km", text: Binding(
                                get: { distanceDrafts[item.id] ?? "" },
                                set: { distanceDrafts[item.id] = $0 }
                            )).keyboardType(.decimalPad).multilineTextAlignment(.trailing)
                                .font(.subheadline.monospacedDigit()).frame(width: 54, height: 44)
                                .accessibilityLabel("\(nativeWeekday(item.localDate))距离")
                            Text("km").font(.caption).foregroundStyle(TechColor.muted)
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
                TechPanel(tint: TechColor.cyan, fill: .clear) {
                    VStack(alignment: .leading, spacing: 8) {
                        TechSectionHeader(title: "比赛目标", trailing: goals.lockedSession == nil ? "未锁定" : "已锁定", trailingColor: TechColor.cyan)
                        if let race = goals.raceTarget {
                            Text("\(race.distance) · \(nativeDay(race.date))")
                                .font(.headline.weight(.semibold))
                            Text(race.targetPaceSecondsPerKm.map { "目标配速：\(techPace($0))/km" } ?? "未设置目标配速")
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
                .background { TechRaceLandscape().clipShape(RoundedRectangle(cornerRadius: TechMetrics.corner)) }
            }
        }
    }

    private func loadDraft() {
        guard let goals = native.goals else { return }
        weeklyText = nativeNumber(goals.weeklyDistanceKm)
        easyFloor = goals.easyDurationFloorFraction
        qualityCap = goals.qualitySessionCap
        weekPlan = goals.weekPlan
        distanceDrafts = NativeGoalWeekDraft.drafts(from: goals.weekPlan)
    }

    private func save() async {
        guard !isSaving, areDistancesValid, let weekly = weeklyValue,
              NativeGoalWeekDraft.weeklyDistanceIsValid(weeklyText) else { return }
        let plan = NativeGoalWeekDraft.normalized(
            weekPlan,
            drafts: distanceDrafts,
            loaded: native.goals?.weekPlan ?? []
        )
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

/// The prescription one column of the week strip opens into.
///
/// The strip can only carry a kind, a colour and a distance; the interval
/// breakdown, the warmup and the pace band are what actually make the day
/// executable, and the stored plan is the only thing that carries them.
private struct TechPlanDaySheet: View {
    let day: MobileWeekPlanDay
    let isToday: Bool

    private var statusText: String {
        // The word is a statement about the data, so it lives next to the mapper's
        // other day judgments; only the colour below is a skin decision.
        WorkoutPlanMapper.weekStripStatus(
            completed: day.completedWorkoutId != nil,
            isRest: day.kind == "rest",
            isToday: isToday
        )
    }

    private var statusColor: Color {
        if day.completedWorkoutId != nil { return TechColor.green }
        if day.kind == "rest" { return TechColor.muted }
        return isToday ? TechColor.cyan : TechColor.ink
    }

    private var lines: [NativeStructureLine] { nativeStructureLines(day.structure) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(nativeWeekday(day.localDate)) · \(nativeDay(day.localDate))")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(TechColor.ink)
                        Text(day.title.isEmpty ? nativeSessionName(day.kind) : day.title)
                            .font(.subheadline)
                            .foregroundStyle(TechColor.muted)
                    }
                    Spacer(minLength: 0)
                    Circle().fill(techSessionColor(day.kind))
                        .frame(width: 12, height: 12)
                        .padding(.top, 7)
                }
                HStack(spacing: 12) {
                    TechMetricTile(title: "距离", value: day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : "—")
                    TechMetricTile(title: "状态", value: statusText, accent: statusColor)
                }
                if lines.isEmpty {
                    TechPanel {
                        Text(day.kind == "rest"
                            ? "这一天没有训练安排。"
                            : "这一天还没有结构化处方；生成课表后，热身、主课与放松的步骤会显示在这里。")
                            .font(.footnote)
                            .foregroundStyle(TechColor.muted)
                    }
                } else {
                    TechPanel {
                        VStack(alignment: .leading, spacing: 12) {
                            TechSectionHeader(title: "训练内容", trailing: "\(lines.count) 步")
                            ForEach(lines) { line in
                                HStack(alignment: .top, spacing: 12) {
                                    Text(line.title)
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(TechColor.cyan)
                                        .frame(width: 80, alignment: .leading)
                                        .lineLimit(2)
                                        .minimumScaleFactor(0.7)
                                    Text(line.detail)
                                        .font(.caption)
                                        .foregroundStyle(TechColor.ink)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.vertical, TechMetrics.pageVertical)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .presentationDragIndicator(.visible)
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
                    NavigationLink {
                        TechAbilityDetailView()
                    } label: {
                        TechPanel {
                            HStack {
                                TechIconBox(systemName: "chart.xyaxis.line")
                                Text("跑力评估").font(.headline)
                                Spacer()
                                Image(systemName: "chevron.right").font(.caption)
                            }.foregroundStyle(TechColor.cyan)
                        }
                    }.buttonStyle(.plain).accessibilityIdentifier("analysis.ability")
                }
            }
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.top, TechMetrics.pageVertical)
            .padding(.bottom, TechMetrics.bottomClearance)
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
        case "records": return "个人纪录"
        default: return "趋势"
        }
    }

    @ViewBuilder
    private var trendsContent: some View {
        if let data = native.trends {
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                TechPanel {
                    TechSectionHeader(title: "里程变化（近 4 周）", trailing: "km", trailingColor: TechColor.muted)
                    HStack(alignment: .center, spacing: 14) {
                        Text(data.distanceChangeFraction4Weeks.map { nativeSignedPercent($0) } ?? "数据不足")
                            .font(.system(size: 30, weight: .semibold)).monospacedDigit()
                            .foregroundStyle(TechColor.cyan).lineLimit(1).minimumScaleFactor(0.65)
                        Spacer(minLength: 0)
                        VStack(alignment: .trailing, spacing: 6) {
                            if let previous = data.weeks.dropLast().last {
                                Text("上周  " + nativeKilometers(previous.distanceKm))
                            }
                            if let current = data.weeks.last {
                                Text("本周  " + nativeKilometers(current.distanceKm))
                            }
                        }.font(.caption).foregroundStyle(TechColor.muted)
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
                DisclosureGroup("跑力变化依据") {
                    HStack {
                        techMetricCaption("增长速度", value: nativeNumber(data.growthVelocityPerWeek))
                        techMetricCaption("衰减", value: nativeNumber(data.decayPoints))
                    }.padding(.vertical, 8)
                }.font(.caption).tint(TechColor.muted)
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
            VStack(alignment: .leading, spacing: 22) {
                HStack(spacing: 12) {
                    TechMetricTile(title: "总里程", value: nativeKilometers(data.totals.distanceKm))
                    TechMetricTile(title: "总时长", value: techDuration(data.totals.durationSeconds))
                }
                TechSectionHeader(title: "三个月里程分布", trailing: "单位：km")
                TechMonthChart(months: data.months)
                Divider().overlay(TechColor.grid)
                heartRatePanel(data.heartRateZones)
                HStack(spacing: 8) {
                    TechMetricTile(title: "训练次数", value: "\(data.totals.workoutCount)")
                    TechMetricTile(title: "环比", value: nativeSignedPercent(data.totals.distanceChangeFraction))
                    TechMetricTile(title: "平均配速", value: techPace(data.totals.averagePaceSecondsPerKm) + "/km")
                }
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
                            Text(techStatusName(point.assessmentStatus))
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
                                Text(techDuration(zones.reduce(0) { $0 + $1.durationSeconds }))
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
                recordTile("最快 5 公里", value: records.fastest5k.map { techDuration($0.paceSecondsPerKm * 5) }, date: records.fastest5k.map { techRecordDate($0.startedAt) })
                recordTile("最快 10 公里", value: records.fastest10k.map { techDuration($0.paceSecondsPerKm * 10) }, date: records.fastest10k.map { techRecordDate($0.startedAt) })
                recordTile("最长距离", value: records.longestDistance.map { nativeKilometers($0.distanceKm) }, date: records.longestDistance.map { techRecordDate($0.startedAt) })
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
                if title == "最大月跑量", let months = native.statistics?.months, months.count > 1 {
                    TechSparkline(values: months.map(\.totalDistanceKm), tint: TechColor.leaf)
                    Text("近 \(months.count) 个月 · km").font(.caption2).foregroundStyle(TechColor.muted)
                }
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
    /// 观察地图隐私状态，保证设置页开关与状态文案随同意/关闭实时刷新。
    @AppStorage(MapPrivacy.storageKey) private var mapPrivacyState = MapPrivacy.State.ask.rawValue

    private var mapEnabled: Bool { mapPrivacyState == MapPrivacy.State.agreed.rawValue }

    var body: some View {
        @Bindable var session = session
        ScrollView {
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                TechPageHeader(title: "设置") {
                    TechBadge(title: session.isReachable ? "在线" : "离线", color: session.isReachable ? TechColor.green : TechColor.coral, fill: session.isReachable ? TechColor.mint : TechColor.paleCoral)
                }
                TechSectionHeader(title: "服务连接")
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
                settingsLink("外观皮肤", subtitle: "冰蓝科技 / 清新像素", icon: "paintpalette", tint: TechColor.cyan) {
                    AppSkinPicker()
                }
                settingsLink("地图底图",
                             subtitle: mapEnabled ? "高德已启用" : "仅离线轨迹",
                             icon: "map", tint: TechColor.cyan) {
                    mapPanel
                }
                settingsLink("本地缓存", subtitle: native.lastCacheUpdate == nil ? "无缓存" : "可离线查看", icon: "externaldrive", tint: TechColor.cyan) {
                    cachePanel
                    versionPanel
                }
                TechSectionHeader(title: "应用信息")
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
                        Label(techHealthError(error), systemImage: "exclamationmark.circle")
                            .font(.footnote).foregroundStyle(TechColor.coral)
                    }
                }
            }
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.top, TechMetrics.pageVertical)
            .padding(.bottom, TechMetrics.bottomClearance)
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

    }

    private func settingsLink<Content: View>(_ title: String, subtitle: String, icon: String,
                                             tint: Color, @ViewBuilder content: () -> Content) -> some View {
        let destination = content()
        return NavigationLink {
            ScrollView {
                VStack(spacing: 18) { destination }.padding(20).padding(.bottom, TechMetrics.bottomClearance)
            }
            .background(TechColor.background).foregroundStyle(TechColor.ink)
            .techNavigation(title)
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
        VStack(spacing: 20) {
            VStack(spacing: 12) {
                Image(systemName: healthSync.lastError == nil ? "heart.fill" : "exclamationmark.circle")
                    .font(.system(size: 40, weight: .light)).foregroundStyle(TechColor.coral)
                    .frame(width: 68, height: 68)
                    .background(healthSync.lastError == nil ? Color.white : .clear, in: RoundedRectangle(cornerRadius: 17))
                Text(healthSync.lastError == nil ? "Apple 健康" : "同步未完成").font(.title2.weight(.semibold))
                Text(healthSync.lastError == nil ? "只读访问" : "请检查连接与健康权限后重试。")
                    .font(.caption).foregroundStyle(TechColor.muted)
                if let error = healthSync.lastError {
                    Text(techHealthError(error)).font(.footnote).foregroundStyle(TechColor.coral).multilineTextAlignment(.center)
                } else {
                    Text("我们仅读取你在 Apple 健康中的跑步相关数据，用于更全面的分析与建议。")
                        .font(.footnote).foregroundStyle(TechColor.muted).multilineTextAlignment(.center)
                }
            }.frame(maxWidth: .infinity).padding(.vertical, 20)
            TechPanel {
                TechSectionHeader(title: "同步的健康数据类别")
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    healthType("跑步", icon: "figure.run", tint: TechColor.cyan)
                    healthType("心率", icon: "heart", tint: TechColor.coral)
                    healthType("路线", icon: "map", tint: TechColor.cyan)
                    healthType("卡路里", icon: "flame", tint: TechColor.coral)
                    healthType("恢复", icon: "moon", tint: TechColor.leaf)
                }
            }
            TechPanel {
                TechSectionHeader(title: "同步状态", trailing: healthSync.isBusy ? "进行中" : healthSync.hasCompletedSync ? "已同步" : "未同步")
                if healthSync.isBusy {
                    HStack(spacing: 12) {
                        ProgressView().tint(TechColor.cyan)
                        Text(techSyncPhase(healthSync.phase)).font(.subheadline).foregroundStyle(TechColor.cyan)
                    }
                }
                if let date = healthSync.lastSyncAt {
                    Label("上次成功同步 " + nativeDate(ISO8601DateFormatter().string(from: date)), systemImage: "clock")
                        .font(.caption).foregroundStyle(TechColor.muted)
                }
                if let message = healthSync.message { Text(message).font(.footnote).foregroundStyle(TechColor.muted) }
                TechPrimaryButton(title: healthSync.lastError == nil ? "同步健康数据" : "重试同步", isBusy: healthSync.isBusy,
                                  isDisabled: healthSync.isBusy || !session.isReachable) {
                    Task {
                        await healthSync.sync(to: session.serverURL, apiToken: session.apiToken)
                        await native.refreshAll(requestHandshake: false)
                    }
                }.accessibilityIdentifier("health.sync")
            }
            TechPanel(fill: TechColor.blue.opacity(0.08)) {
                Label("同步时保持应用打开，避免同步中断。", systemImage: "info.circle")
                    .font(.footnote).foregroundStyle(TechColor.muted)
            }
            Button("打开健康权限") {
                guard let url = URL(string: "x-apple-health://") else { return }
                UIApplication.shared.open(url)
            }.font(.subheadline).foregroundStyle(TechColor.cyan).frame(minHeight: 44)
        }
    }

    private func healthType(_ title: String, icon: String, tint: Color) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon).foregroundStyle(tint).frame(width: 24)
            Text(title).font(.subheadline)
            Spacer()
        }.padding(10).background(TechColor.background.opacity(0.4), in: Capsule())
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
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(TechColor.coral)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .overlay(Capsule().stroke(TechColor.coral.opacity(0.7), lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
        .sheet(isPresented: $showingClearCache) {
            TechConfirmationSheet(title: "清除本机缓存？", message: "这不会影响服务端数据，仅删除本机的离线页面缓存。", symbol: "trash", confirmTitle: "清除", destructive: true) {
                native.clearCache()
                showingClearCache = false
            } cancel: { showingClearCache = false }
        }
    }

    private var mapPanel: some View {
        TechPanel(tint: TechColor.cyan) {
            VStack(alignment: .leading, spacing: 9) {
                TechSectionHeader(title: "高德地图底图",
                                  trailing: mapEnabled ? "已启用" : "仅离线轨迹",
                                  trailingColor: mapEnabled ? TechColor.green : TechColor.muted)
                Text("训练详情底图由高德提供：显示时会向高德请求所在区域瓦片；跑步坐标只在手机上绘制，健康数据不会提供给高德。")
                    .font(.footnote)
                    .foregroundStyle(TechColor.muted)
                TechPrimaryButton(title: mapEnabled ? "关闭高德底图" : "启用高德底图",
                                  isDisabled: false) {
                    if mapEnabled {
                        MapPrivacy.decline()
                    } else {
                        MapPrivacy.resetToAsk()
                    }
                }
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
