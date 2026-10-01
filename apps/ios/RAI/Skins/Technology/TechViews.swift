#if os(iOS)
import Charts
import SwiftUI
import UIKit

// Technology skin presentation. All business operations use the shared NativeAppModel.
struct TechTodayView: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var showingLock = false
    @State private var showingVerdict = false
    @Environment(NativeAppModel.self) private var native
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                TechTodayHeader(date: native.today.map { nativeDay($0.today.localDate) } ?? "RUNNING INTELLIGENCE")

                if let today = native.today {
                    todayHero(today)
                    recoveryPanel(today)
                    trainingOverview(today)
                    if let postRun = today.postRun { postRunPanel(postRun) }
                    recommendationPanel(today)
                    abilityCard(today)
                    TechTodayMetrics(workout: today.recentWorkouts.first, refreshRevision: today.generatedAt)
                    raceSummary(today)
                } else if native.isLoading {
                    TechPanel { TechLoadingState(title: "正在读取 RAI 服务") }
                } else {
                    TechPanel(tint: TechColor.cyan) {
                        TechEmptyState(
                            title: "尚未连接 RAI 服务",
                            message: native.errorMessage ?? "请在设置中连接服务并读取 Apple 健康数据。",
                            systemName: "server.rack"
                        )
                        NavigationLink("检查连接") { TechNativeSettingsView() }
                        Button("重新读取") { Task { await native.refreshAll() } }
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
        .sheet(isPresented: $showingVerdict) {
            NavigationStack {
                ScrollView {
                    if let today = native.today { verdictDetailPanel(today).padding(20) }
                }
                .background(TechColor.background)
                .navigationTitle("训练判定依据")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showingVerdict = false } } }
            }.preferredColorScheme(.dark)
        }
    }

    /// Keep the two training summaries together; accessibility text gets full-width cards.
    private func trainingOverview(_ data: MobileTodayResponse) -> some View {
        Group {
            if typeSize >= .xxxLarge {
                VStack(spacing: TechMetrics.sectionSpacing) {
                    verdictPanel(data)
                    activityPanel(data)
                }
            } else {
                HStack(alignment: .top, spacing: 12) {
                    verdictPanel(data).frame(maxWidth: .infinity)
                    activityPanel(data).frame(maxWidth: .infinity)
                }
            }
        }.accessibilityIdentifier("today.trainingOverview")
    }

    private func todayHero(_ data: MobileTodayResponse) -> some View {
        TechHeroCard {
            TechAdaptiveStack(spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Label(data.today.workoutCount > 0 ? "今日跑步" : "今日训练", systemImage: "shoeprints.fill")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(TechColor.ink)
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text(nativeNumber(data.today.distanceKm, digits: 2))
                            .techScaledFont(44, weight: .bold).monospacedDigit()
                            .fixedSize(horizontal: false, vertical: true)
                        Text("km").font(.subheadline)
                    }.foregroundStyle(TechColor.ink)
                    Text("今日总距离").font(.caption).foregroundStyle(TechColor.muted)
                }
                Spacer(minLength: 0)
                ZStack {
                    TechInstrumentRing(progress: data.week.goalProgressFraction ?? 0, size: 112)
                }.accessibilityLabel("本周目标进度 \(nativePercent(data.week.goalProgressFraction))")
            }
            TechMetricGrid {
                heroMetric("时间", techDuration(data.today.durationSeconds))
                heroMetric("平均配速", techPace(data.today.paceSecondsPerKm) + "/km")
                heroMetric("kcal", data.today.energyKcal.map { nativeNumber($0, digits: 0) } ?? "--")
            }
            HStack(spacing: 10) {
                Text("本周 \(nativeNumber(data.week.distanceKm)) / \(nativeNumber(data.week.goalDistanceKm)) km")
                    .font(.caption2).foregroundStyle(TechColor.muted)
                TechProgressBar(fraction: data.week.goalProgressFraction)
                Text(nativePercent(data.week.goalProgressFraction)).font(.caption2).foregroundStyle(TechColor.cyan)
            }.padding(.horizontal, 8).padding(.vertical, 6).background(TechColor.paper, in: RoundedRectangle(cornerRadius: 6))
        }
    }

    private func heroMetric(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(value).font(.title3.weight(.semibold).monospacedDigit())
                .foregroundStyle(TechColor.ink).fixedSize(horizontal: false, vertical: true)
            Text(title).font(.caption).foregroundStyle(TechColor.muted)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 比赛目标卡。**无条件渲染**：没有目标时服务端仍给出 `race.note` 引导文案
    /// （`mobile-coach.ts` 的 `buildRaceCard` 无目标分支给出设置入口和默认距离）。
    /// 旧版整卡写在 `if let target` 里，于是
    /// `race.note` / `race.shapeScore` / `race.taper` 三个字段在科技风没有任何入口
    /// —— 有数据、有契约、没展示位，且当时连声明都没有。
    ///
    /// 距离用 `techRaceDistanceName` 而不是直出 `target.distance`：契约里它是闭集
    /// `five_k | ten_k | half_marathon`，直出会让用户看到 `half_marathon`。
    private func raceSummary(_ data: MobileTodayResponse) -> some View {
        let target = data.race.target
        return NavigationLink { TechPlanView() } label: {
            TechPanel {
                VStack(alignment: .leading, spacing: 11) {
                    HStack(spacing: 12) {
                        Image(systemName: target == nil ? "flag.checkered" : "trophy.fill")
                            .foregroundStyle(TechColor.cyan)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(target.map { "\(techRaceDistanceName($0.distance)) · \(nativeDay($0.date))" }
                                ?? "尚未设置比赛目标")
                                .font(.subheadline.weight(.semibold)).foregroundStyle(TechColor.ink)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(data.race.note)
                                .font(.caption).foregroundStyle(TechColor.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(TechColor.muted)
                    }
                    if target != nil || data.race.shapeScore != nil {
                        TechAdaptiveStack(spacing: 10) {
                            if let pace = target?.targetPaceSecondsPerKm {
                                TechMetricTile(title: "目标配速", value: techPace(pace) + "/km", accent: TechColor.cyan)
                            }
                            if let score = data.race.shapeScore {
                                TechMetricTile(title: target == nil ? "10 公里准备度（默认）" : "赛事准备度", value: nativePercent(score), accent: TechColor.green)
                            }
                            if target != nil {
                                TechMetricTile(title: "减量", value: data.race.taper ? "是" : "否",
                                               accent: data.race.taper ? TechColor.yellow : TechColor.muted)
                            }
                        }
                    }
                }
            }
        }.buttonStyle(TechPressStyle())
            // 这是今日页的**最后一块内容**（`TechTodayView.body` 里最后一个子视图），
            // 所以它也是"页面底部有没有被底栏压住"这条断言的唯一合格锚点。
            // 不给它标识符时，UI 用例只能退而求其次地断言某个中间元素，
            // 那样即使底栏改成覆盖式布局、真正的内容被压在栏下，用例也不会报红。
            .accessibilityIdentifier("today.race")
    }

    private func activityPanel(_ data: MobileTodayResponse) -> some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 8) {
                Text("本周训练结构").font(.caption.weight(.semibold)).accessibilityAddTraits(.isHeader)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(nativePercent(data.weekStructure.easyDurationFraction))
                        .font(.title3.weight(.bold)).monospacedDigit().foregroundStyle(TechColor.cyan)
                    Text("轻松跑").font(.caption2).foregroundStyle(TechColor.muted)
                }
                TechProgressBar(fraction: data.weekStructure.easyDurationFraction, height: 4)
                Text("质量课 \(data.weekStructure.qualitySessionCount) / \(data.weekStructure.qualitySessionCap) 次")
                    .font(.caption).monospacedDigit()
                Text("轻松执行度 \(nativePercent(data.weekStructure.easyHonesty.honestyFraction))")
                    .font(.caption2).foregroundStyle(TechColor.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(height: typeSize >= .xxxLarge ? nil : 112, alignment: .topLeading)
        }
    }

    private func abilityCard(_ data: MobileTodayResponse) -> some View {
        NavigationLink {
            TechAbilityDetailView()
        } label: {
            TechPanel(tint: TechColor.cyan) {
                TechAdaptiveStack(spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 6) {
                            Text("当前跑力").font(.subheadline.weight(.semibold)).foregroundStyle(TechColor.ink)
                            Image(systemName: "chevron.right").font(.caption2).foregroundStyle(TechColor.muted)
                        }
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text(nativeNumber(data.ability.trueAbility, digits: 1))
                                .techScaledFont(36, weight: .semibold).monospacedDigit()
                                .foregroundStyle(TechColor.ink).fixedSize(horizontal: false, vertical: true)
                            Text("/100").font(.caption).foregroundStyle(TechColor.muted)
                        }
                        HStack(spacing: 6) {
                            Text("近 7 天").font(.caption2).foregroundStyle(TechColor.muted)
                            Text(nativeSigned(data.ability.changeFrom7DaysAgo))
                                .font(.caption.weight(.semibold).monospacedDigit())
                                .foregroundStyle(abilityDeltaColor(data.ability.changeFrom7DaysAgo))
                            Text("· " + techCalibrationName(data.calibration.status))
                                .font(.caption2).foregroundStyle(TechColor.muted)
                        }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chart.bar.xaxis")
                        .font(.system(size: 28, weight: .light))
                        .foregroundStyle(TechColor.cyan)
                        .accessibilityHidden(true)
                }
                TechTodayAbilityRuler(score: data.ability.trueAbility)

                if calibrationNeedsAttention(data.calibration.status) {
                    Text(data.calibration.message)
                        .font(.caption2)
                        .foregroundStyle(TechColor.muted)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(TechColor.paleYellow)
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(TechColor.yellow, lineWidth: 1))
                }
            }
        }
        .buttonStyle(TechPressStyle())
        .accessibilityIdentifier("today.ability")
        .accessibilityLabel(abilityAccessibilityLabel(data))
        .accessibilityHint("查看跑步能力详情")
    }

    /// 覆盖式 label 会盖掉卡内文字，所以变化、校准状态和校准说明都要在这里补齐。
    private func abilityAccessibilityLabel(_ data: MobileTodayResponse) -> String {
        var parts = [
            "当前跑力 \(nativeNumber(data.ability.trueAbility, digits: 1))，满分 100",
            "近 7 天 \(nativeSigned(data.ability.changeFrom7DaysAgo))",
            techCalibrationName(data.calibration.status)
        ]
        if calibrationNeedsAttention(data.calibration.status) {
            parts.append(data.calibration.message)
        }
        return parts.joined(separator: "，")
    }

    private func abilityDeltaColor(_ delta: Double?) -> Color {
        guard let delta, delta.isFinite else { return TechColor.muted }
        if delta > 0 { return TechColor.cyan }
        if delta < 0 { return TechColor.coral }
        return TechColor.muted
    }

    private func verdictPanel(_ data: MobileTodayResponse) -> some View {
        let tone = techToneColor(data.verdict.tone)
        return Button { showingVerdict = true } label: {
            TechPanel(tint: tone) {
                VStack(alignment: .leading, spacing: 6) {
                    Label("训练判定", systemImage: "dumbbell.fill").font(.caption.weight(.semibold))
                    Text(data.verdict.title).font(.title3.weight(.bold)).foregroundStyle(tone)
                    Text(data.verdict.reason).font(.caption2).foregroundStyle(TechColor.muted)
                        .lineLimit(typeSize >= .xxxLarge ? nil : 2)
                    Spacer(minLength: 0)
                    HStack {
                        Text("判定依据")
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                    }.font(.caption2).foregroundStyle(tone)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(height: typeSize >= .xxxLarge ? nil : 112, alignment: .topLeading)
            }
        }.buttonStyle(TechPressStyle())
            .accessibilityLabel("训练判定，\(data.verdict.title)，\(data.verdict.reason)")
            .accessibilityHint("查看完整判定依据")
    }

    private func verdictDetailPanel(_ data: MobileTodayResponse) -> some View {
        let tone = techToneColor(data.verdict.tone)
        return TechPanel(tint: tone) {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 9) {
                    Label("训练判定", systemImage: "dumbbell.fill").font(.subheadline.weight(.semibold))
                    Text(data.verdict.title).techScaledFont(23, weight: .bold).foregroundStyle(tone)
                    Text(data.verdict.reason).font(.footnote).foregroundStyle(TechColor.muted)
                }
                TechVerdictInstrument(fraction: data.weekStructure.easyDurationFraction, tone: tone,
                                      symbol: verdictIconName(tone: data.verdict.tone))
            }
            if !data.verdict.triggers.isEmpty {
                DisclosureGroup {
                    ForEach(data.verdict.triggers, id: \.code) { trigger in
                        Text(trigger.detail).font(.caption).foregroundStyle(TechColor.muted)
                    }
                } label: { Text("判定依据").frame(minHeight: 44) }.font(.caption).tint(tone)
            }
        }
    }

    /// 「最近一次训练反馈」。`postRun` 只在"今天已经练过"时有值
    /// （`mobile-coach.ts` 的 `buildPostRun` 对非今日训练返回 null），因此这里按
    /// optional 处理，不用空态占位。
    ///
    /// 刺激匹配走 `techStimulusMatchName`：契约 `MobileStimulusMatch` 是闭集
    /// `aligned | too_hard | too_easy | unknown`，直出会让用户看到 `too_hard`。
    private func postRunPanel(_ postRun: MobilePostRunVerdict) -> some View {
        TechPanel(tint: TechColor.coral) {
            VStack(alignment: .leading, spacing: 9) {
                TechSectionHeader(title: "最近一次训练反馈",
                                  trailing: nativeSessionName(postRun.sessionType),
                                  trailingColor: TechColor.coral)
                Text(postRun.headline)
                    .font(.subheadline.weight(.semibold)).foregroundStyle(TechColor.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text("刺激 \(nativeStimulusName(postRun.stimulusType)) · 匹配 \(techStimulusMatchName(postRun.stimulusMatch))")
                    .font(.caption).foregroundStyle(TechColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
                if let delta = postRun.trueAbilityDelta {
                    Text("跑力变化 \(nativeSigned(delta))")
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(abilityDeltaColor(delta))
                }
                NavigationLink("记录感受 / 查看训练") { TechWorkoutDetailView(workoutId: postRun.workoutId) }
                ForEach(postRun.details, id: \.self) { detail in
                    Text("· \(detail)")
                        .font(.caption).foregroundStyle(TechColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func recommendationPanel(_ data: MobileTodayResponse) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            // 阶段放在这里而不是别处：`MobileDayPhase` 讲的就是"今天走到哪一步"
            // （待同步 / 晨间开放 / 已锁定 / 已训练 / 休息日完成），它决定下面这条推荐
            // 该被怎么读。做成标题的 trailing 而不是单独一行，是因为它修饰的是这条推荐。
            TechSectionHeader(title: native.canConfirmToday ? "今日推荐训练" : "训练建议参考", trailing: techPhaseName(data.phase))
            if let notice = UserDataNoticePolicy.recommendationNotice(
                currentDay: UserDataNoticePolicy.isCurrentDay(data.today.localDate, timezone: data.timezone),
                available: native.isTodayAvailable) {
                Text(notice).font(.caption).foregroundStyle(TechColor.muted)
                Button("刷新建议") { Task { await native.refreshAll() } }
            }
            if let planned = data.recommendation.plannedKind,
               planned != data.recommendation.effectiveKind {
                Text("原计划：\(nativeSessionName(planned)) → 当前：\(data.nextSession.title)")
                    .font(.caption.weight(.semibold)).foregroundStyle(TechColor.coral)
                if let reason = data.recommendation.adjustmentReason {
                    Text(reason).font(.caption).foregroundStyle(TechColor.muted)
                }
            }
            Label("\(data.nextSession.title) \(nativeKilometers(data.nextSession.distanceKm))", systemImage: nativeSessionSymbol(data.nextSession.kind))
                .techScaledFont(22, weight: .semibold).foregroundStyle(TechColor.action)
            TechAdaptiveStack {
                VStack(alignment: .leading, spacing: 8) {
                    Text("建议配速 " + techPaceRange(data.nextSession.paceSecondsPerKmLower, data.nextSession.paceSecondsPerKmUpper))
                    Text("预计时间 \(data.nextSession.durationMinutes.map { nativeNumber($0, digits: 0) + " 分钟" } ?? "待评估")")
                }.font(.caption).foregroundStyle(TechColor.muted)
                Spacer(minLength: 8)
                Button { showingLock = true } label: {
                    Text(data.lock.relockSuggested ? "重新确认" : data.lock.present ? "已锁定" : "锁定安排").font(.caption.weight(.semibold))
                        .foregroundStyle(TechColor.background).padding(.horizontal, 14).frame(minHeight: 44)
                        .background(TechColor.action, in: Capsule())
                }.buttonStyle(TechPressStyle()).disabled(lockDisabled(data))
                    .saturation(lockDisabled(data) ? 0 : 1)
            }
            if let note = lockNote(data) {
                Text(note)
                    .font(.caption).foregroundStyle(TechColor.muted)
            }
            // 这条安排是怎么来的，以及恢复监测有没有参与。放在建议下面而不是标题里，
            // 是因为它解释的是这条建议本身——"未结合今日恢复"既不是批准也不是降级。
            VStack(alignment: .leading, spacing: 6) {
                Text("\(techRecommendationBasisName(data.recommendation.basis)) · \(techRecoveryAdjustmentName(data.recommendation.recoveryAdjustment))")
                    .font(.caption.weight(.medium)).foregroundStyle(TechColor.ink)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(data.recommendation.uncertaintyReasons, id: \.self) { reason in
                    Text("· \(reason)")
                        .font(.caption2).foregroundStyle(TechColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Divider().overlay(TechColor.cyan.opacity(0.2))
            NavigationLink { TechPlanView() } label: {
                Label("查看训练计划", systemImage: "calendar")
                    .font(.subheadline.weight(.medium)).frame(minHeight: 44)
            }.buttonStyle(TechPressStyle()).foregroundStyle(TechColor.cyan)
                .accessibilityIdentifier("today.plan")
        }
        .padding(TechMetrics.panelPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { TechRunningLandscape(road: true) }
        .clipShape(RoundedRectangle(cornerRadius: TechMetrics.corner))
        .overlay(RoundedRectangle(cornerRadius: TechMetrics.corner).strokeBorder(TechColor.cyan.opacity(0.4), lineWidth: 0.7))
    }

    /// 锁定只被两件事挡住：安排已锁，或上一次刷新真的失败了。
    ///
    /// 「今天没有恢复记录」曾经也挡在这里，等于把一个没戴表的夜晚变成"你不能确认
    /// 明天的课"。缺测只减少一份判断依据，不剥夺确认安排的能力。
    private func lockDisabled(_ data: MobileTodayResponse) -> Bool {
        (data.lock.present && !data.lock.relockSuggested) || data.sync.status == "failed" || native.isOffline || !native.canConfirmToday || native.isPlanBusy
    }

    private func lockNote(_ data: MobileTodayResponse) -> String? {
        if !native.canConfirmToday { return "当前建议仅供参考，连接并刷新后才能确认。" }
        if data.lock.relockSuggested { return "今日判断已变化，请查看最新建议并重新确认；手表课表也需要更新。" }
        if data.lock.present { return "今日安排已锁定，可在训练计划中查看。" }
        if data.sync.status == "failed" { return "上次健康同步未完成，请重新同步后再锁定。" }
        if native.isOffline { return "离线仅可查看，连接后才能锁定安排。" }
        return nil
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
            TechSectionHeader(title: "恢复状态", trailing: data.recovery.stateLabel,
                              trailingColor: recoveryStatusColor(data.recovery.state))
            TechTodayRecoveryMetrics(recovery: data.recovery)
        }
    }
}

struct TechZoneDistributionPanel: View {
    let title: String
    let period: String
    let zones: [HeartRateZoneSummary]
    var isPace = false

    private func zoneName(_ zone: String) -> String {
        guard isPace else { return nativeHeartRateZone(zone) }
        switch zone {
        case "easy": return "轻松区"
        case "marathon": return "马拉松区"
        case "lactate_threshold": return "阈值区"
        case "anaerobic_endurance": return "无氧耐力区"
        case "sprint": return "冲刺区"
        default: return "未分类"
        }
    }

    private func zoneColor(_ zone: String) -> Color {
        guard isPace else { return techHeartRateZoneColor(zone) }
        switch zone {
        case "easy": return TechColor.cyan
        case "marathon": return TechColor.green
        case "lactate_threshold": return TechColor.yellow
        case "anaerobic_endurance": return TechColor.blue
        case "sprint": return TechColor.coral
        default: return TechColor.muted
        }
    }

    var body: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 9) {
                TechSectionHeader(title: title, trailing: period)
                if zones.isEmpty {
                    Text(isPace ? "没有满足覆盖率要求的配速数据" : "没有满足覆盖率要求的心率数据")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                } else {
                    HStack(spacing: 16) {
                        Chart(zones) { zone in
                            SectorMark(angle: .value("时长", zone.durationSeconds), innerRadius: .ratio(0.78), angularInset: 2)
                                .foregroundStyle(zoneColor(zone.zone))
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
                                    Circle().fill(zoneColor(zone.zone)).frame(width: 6, height: 6)
                                    Text(zoneName(zone.zone)).font(.caption2)
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
}

struct TechWeekOverviewView: View {
    @Environment(NativeAppModel.self) private var native
    private let initialData: MobileTodayResponse

    init(data: MobileTodayResponse) {
        initialData = data
    }

    private var data: MobileTodayResponse { native.today ?? initialData }

    private var remainingDistanceLabel: String {
        data.week.remainingDistanceKm.map { "剩余 \(nativeKilometers($0))" } ?? "未设置周目标"
    }

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
                                 value: nativeKilometers(data.week.distanceKm), label: "已完成", size: 144,
                                 detail: remainingDistanceLabel)
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
                if native.isRefreshing {
                    ProgressView("正在更新本周统计").font(.caption).tint(TechColor.cyan)
                }
                if let error = native.errorMessage {
                    Text(error).font(.caption).foregroundStyle(TechColor.yellow)
                }
                if !data.week.hasWeeklyActivityStatistics {
                    TechPanel {
                        Label("本周统计尚未更新", systemImage: "arrow.clockwise")
                            .font(.subheadline.weight(.semibold))
                        Text(native.isOffline
                             ? "当前显示旧缓存。连接服务后下拉刷新，即可读取本周统计。"
                             : "当前接口或缓存尚未包含新增周统计。请更新并重启手机连接的 API 服务，再下拉刷新；仅重新安装 iOS App 不会更新服务端。")
                            .font(.caption).foregroundStyle(TechColor.muted)
                    }
                } else {
                    TechMetricGrid(minimum: 140) {
                        TechMetricTile(title: "平均速度", value: data.week.averageSpeedKmPerHour.map { nativeNumber($0) + " km/h" } ?? "暂无有效数据")
                        TechMetricTile(title: "平均配速", value: data.week.averagePaceSecondsPerKm.map { techPace($0) + "/km" } ?? "暂无有效数据")
                        TechMetricTile(title: "平均心率", value: data.week.averageHeartRateBpm.map { nativeNumber($0, digits: 0) + " bpm" } ?? "暂无心率记录")
                    }
                }
                Text("本周全部跑步汇总；平均心率按有记录的跑步时长加权。区间占比按有效区间时长计算。")
                    .font(.caption2).foregroundStyle(TechColor.muted)
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

                if data.week.hasWeeklyActivityStatistics {
                    TechZoneDistributionPanel(title: "心率区间分布", period: "本周总活动",
                                              zones: data.week.heartRateZones ?? [])
                    TechZoneDistributionPanel(title: "配速区间分布", period: "本周总活动",
                                              zones: data.week.paceZones ?? [], isPace: true)
                }

            }
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.vertical, TechMetrics.pageVertical)
            .padding(.bottom, TechMetrics.bottomClearance)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .scrollIndicators(.hidden)
        .task { await native.refreshAll(requestHandshake: false) }
        .refreshable { await native.refreshAll() }
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
                if native.isOffline || summary.sync.status != "ok" || summary.recoveryAssessment.coverage == "none" {
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
                DisclosureGroup {
                    coreMetricsPanel
                    pacePanel
                } label: { Text("核心能力与配速参考").frame(minHeight: 44) }.font(.subheadline).tint(TechColor.cyan)

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
                TechGauge(progress: summary.recovery.score.map { min(max($0 / 100, 0), 1) } ?? 0,
                          value: nativeNumber(summary.recovery.score, digits: 0),
                          label: "恢复状态", size: 86)
                Text(summary.recovery.note).font(.footnote).foregroundStyle(TechColor.muted)
            }
            DisclosureGroup {
                bodyMetricRow("睡眠基线", value: summary.recovery.sleepBaselineMinutes.map { nativeHoursMinutes($0) })
                bodyMetricRow("HRV 基线", value: summary.recovery.hrvBaselineMs.map { "\(nativeNumber($0)) ms" })
                bodyMetricRow("静息心率基线", value: summary.recovery.restingHeartRateBaselineBpm.map { "\(nativeNumber($0, digits: 0)) bpm" })
            } label: { Text("恢复基线").frame(minHeight: 44) }.font(.caption).tint(TechColor.cyan)
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
                predictionLoadStateBanner
                if let races = native.predictions?.snapshot.races, !races.isEmpty {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        ForEach(races) { race in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(nativeRaceDistance(race.distance)).font(.subheadline).foregroundStyle(TechColor.muted)
                                Text(techDuration(race.predictedSeconds)).font(.title2.weight(.semibold)).monospacedDigit()
                                    .fixedSize(horizontal: false, vertical: true)
                                Text(racePredictionText(race)).font(.caption2).foregroundStyle(TechColor.muted)
                                Text("可信度 " + nativePercent(race.confidence)).font(.caption2).foregroundStyle(TechColor.muted)
                                Text("准备度 " + nativePercent(race.readiness)).font(.caption).foregroundStyle(TechColor.cyan)
                                if let fatigue = race.fatigueAdjustmentSeconds {
                                    Text("疲劳修正 \(nativeDuration(fatigue))")
                                        .font(.caption2).foregroundStyle(TechColor.muted)
                                }
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

    @ViewBuilder
    private var predictionLoadStateBanner: some View {
        switch native.predictionLoadState {
        case .current:
            EmptyView()
        case let .stale(_, message), let .unavailable(message):
            HStack(alignment: .top, spacing: 7) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(TechColor.yellow)
                Text(message)
                    .font(.caption2)
                    .foregroundStyle(TechColor.muted)
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
                .fixedSize(horizontal: false, vertical: true)
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
        let method = race.method ?? "服务端模型"
        return "预测 \(predicted) · 区间 \(optimistic)–\(pessimistic) · \(method)"
    }
}

/// 数据状态横幅。
///
/// 它现在回答两个互不替代的问题：刷新有没有跑成（`sync`），以及各项记录走到哪
/// 一天了（`coverage`）。旧的写法把「今晚有没有夜」当成「数据新不新」，于是没戴表
/// 的夜晚被显示成"数据过期"——那是一个越界的判断，横幅不该做。
struct TechFreshnessBanner: View {
    let today: MobileTodayResponse
    let isOffline: Bool
    let cacheDate: Date?
    var showsSyncAction = false

    private var tint: Color {
        if isOffline { return TechColor.cyan }
        if today.sync.status == "failed" { return TechColor.coral }
        if today.sync.status == "never" { return TechColor.yellow }
        return TechColor.green
    }

    private var symbol: String {
        if isOffline { return "wifi.slash" }
        if today.sync.status == "failed" { return "exclamationmark.triangle" }
        if today.sync.status == "never" { return "clock.badge.exclamationmark" }
        return "antenna.radiowaves.left.and.right"
    }

    /// 一句话说清"数据到哪了"。缺测只陈述事实，不评价跑者。
    private var explanation: String {
        if isOffline { return "显示的是上次缓存的结果。" }
        switch today.sync.status {
        case "failed": return "上次同步健康数据失败，请重新同步。"
        case "never": return "还没有完成过一次健康数据同步。"
        default: break
        }
        switch today.recoveryAssessment.coverage {
        case "none":
            return today.recoveryAssessment.lastObservationDate
                .map { "今天没有恢复监测记录；最近一次是 \(nativeDay($0))，未参与今日安排。" }
                ?? "今天没有恢复监测记录，本次安排未结合恢复数据。"
        case "partial":
            return "今天的恢复监测不完整，只有部分指标参与了判断。"
        default:
            return "训练与恢复数据均可用于今天的判断。"
        }
    }

    var body: some View {
        TechPanel(tint: tint, fill: tint.opacity(0.08), shadowColor: tint.opacity(0.15)) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: symbol)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 4) {
                    TechAdaptiveStack(spacing: 4) {
                        Text(isOffline ? "离线缓存" : "数据状态")
                            .font(.caption.weight(.semibold))
                        Spacer()
                        Text(techSyncStatusName(today.sync.status))
                            .font(.caption2.weight(.semibold))
                    }
                    Text(explanation)
                        .font(.caption2).foregroundStyle(TechColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    DisclosureGroup {
                        Text("结果生成于 \(nativeDate(today.generatedAt))")
                        // 训练数据日期取契约顶层字段 `latestDataDate`；`coverage.latestTrainingDate`
                        // 是同一个值，不再重复渲染（覆盖明细里已有它的兄弟项）。
                        Text("最近已导入训练 \(nativeDay(today.latestDataDate ?? "未知"))")
                        Text("最近健康样本 \(nativeDate(today.coverage.latestHealthSampleAt).isEmpty ? "暂无" : nativeDate(today.coverage.latestHealthSampleAt))")
                        Text("睡眠记录 \(techCoverageStateName(today.coverage.sleep.state))· 夜间 HRV \(techCoverageStateName(today.coverage.hrv.state))· 静息心率 \(techCoverageStateName(today.coverage.restingHeartRate.state))")
                        Text("今日恢复监测 \(techRecoveryCoverageName(today.recoveryAssessment.coverage))· \(techRecoveryAssessmentName(today.recoveryAssessment.assessment))")
                        if let cacheDate {
                            Text("缓存更新于 \(nativeDate(ISO8601DateFormatter().string(from: cacheDate)))")
                        }
                    } label: {
                        Text("数据覆盖明细")
                    }
                    .font(.caption2).foregroundStyle(TechColor.muted).tint(tint)
                }
            }
            .foregroundStyle(TechColor.ink)
            if showsSyncAction { TechFreshnessSyncAction() }
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
                if let error = native.workoutListError {
                    Text(error).font(.footnote).foregroundStyle(TechColor.coral)
                }
                NavigationLink("找不到刚完成的训练？") { TechDataSyncDetailView() }
                TechFilterChips(
                    items: filters.map { (title: $0.0, value: $0.1 ?? "all") },
                    selection: selectedFilter
                )
                TechHeroCard {
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("本月总里程").font(.caption).foregroundStyle(TechColor.muted)
                            Text(monthDistance).techScaledFont(32, weight: .semibold).monospacedDigit()
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
                                .buttonStyle(TechPressStyle()).accessibilityIdentifier("workout.\(workout.id)")
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
    @State private var feedbackDetail: WorkoutDetailResponse?

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
                    Button("记录感受 / 编辑训练") { feedbackDetail = detail }
                        .frame(minHeight: 44).accessibilityIdentifier("workout.feedback")
                    ShareLink(item: "训练摘要：\(nativeSessionName(detail.workout.sessionType)) · \(nativeKilometers(detail.workout.distanceKm)) · \(techDuration(detail.workout.durationSeconds))") {
                        Label("分享无路线摘要", systemImage: "square.and.arrow.up")
                    }
                    if !detail.route.isEmpty { routePanel(detail.route) }
                    DisclosureGroup { detailMetrics(detail.workout) } label: { Text("全部训练指标").frame(minHeight: 44) }
                        .font(.subheadline).tint(TechColor.cyan)
                    if let series = native.selectedSeries { seriesPanel(series) }
                    if let series = native.selectedSeries, series.showsPlanSegments {
                        segmentPanel(series)
                    } else {
                        splitPanel(native.selectedSeries?.splits ?? [])
                    }
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
        .sheet(item: $feedbackDetail) { TechWorkoutFeedbackView(detail: $0) }
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
                TechMetricGrid(minimum: 140) {
                    overviewMetric(techKilometers(workout.distanceKm), "距离")
                    overviewMetric(techDuration(workout.durationSeconds), "时长")
                }
            }
            TechMetricGrid {
                TechMetricTile(title: "平均配速", value: techPace(workout.averagePaceSecondsPerKm) + "/km")
                TechMetricTile(title: "平均心率", value: nativeNumber(workout.averageHeartRateBpm, digits: 0) + " bpm")
                TechMetricTile(title: "能量消耗", value: nativeNumber(workout.activeEnergyKcal, digits: 0) + " kcal")
            }
        }
    }

    private func overviewMetric(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(value).techScaledFont(32, weight: .semibold).monospacedDigit()
                .fixedSize(horizontal: false, vertical: true)
            Text(label).font(.caption).foregroundStyle(TechColor.muted)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
    }

    private func detailMetrics(_ workout: WorkoutDetail) -> some View {
        TechMetricGrid(minimum: 140) {
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
                    TechRouteView(route: route).equatable()
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
                    TechHeartRateChart(metric: metric,
                        averageHeartRate: native.selectedWorkout?.workout.averageHeartRateBpm,
                        durationSeconds: native.selectedWorkout?.workout.elapsedSeconds ?? 0).equatable()
                } else {
                    TechSeriesChart(metric: metric).equatable()
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

    private func segmentPanel(_ series: WorkoutSeriesResponse) -> some View {
        let segments = series.segments
        return VStack(alignment: .leading, spacing: 12) {
            TechSectionHeader(title: "课表分段", trailing: "\(segments.count) 段")
            ForEach(segments) { segment in
                TechPanel(tint: segmentTint(segment.purpose).opacity(0.5)) {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(String(format: "%02d", segment.index))
                            .font(.caption.monospacedDigit().weight(.semibold))
                            .foregroundStyle(segmentTint(segment.purpose))
                        Text(segment.label).font(.headline).foregroundStyle(TechColor.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(nativeSegmentDose(segment))
                        if let alert = nativeSegmentAlert(segment) { Text(alert) }
                    }
                    .font(.caption).foregroundStyle(segmentTint(segment.purpose))
                    .fixedSize(horizontal: false, vertical: true)
                    LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading, spacing: 12) {
                        segmentMetric("实际距离", value: nativeKilometers(segment.distanceMeters / 1000))
                        segmentMetric("用时", value: nativeDuration(segment.durationSeconds))
                        segmentMetric("平均配速", value: "\(techPace(segment.averagePaceSecondsPerKm))/km")
                        segmentMetric("平均心率", value: segment.averageHeartRateBpm.map { "\(nativeNumber($0, digits: 0)) bpm" } ?? "--")
                    }
                }
            }
            if series.segmentPlan != nil || series.segmentNote != nil {
                DisclosureGroup("分段来源") {
                    if let note = series.segmentNote { Text(note) }
                    if let plan = series.segmentPlan {
                        Text("匹配 \(plan.localDate) 第 \(plan.revision) 版课表（\(nativeSessionName(plan.kind))）· 可解释 \(nativePercent(plan.explainedFraction))")
                    }
                }
                .font(.caption).foregroundStyle(TechColor.muted).tint(TechColor.cyan)
            }
        }
    }

    private func segmentTint(_ purpose: String) -> Color {
        switch purpose {
        case "warmup": return TechColor.yellow
        case "work": return TechColor.cyan
        case "recovery", "cooldown": return TechColor.green
        default: return TechColor.muted
        }
    }

    private func segmentMetric(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption2).foregroundStyle(TechColor.muted)
            Text(value).font(.subheadline.weight(.semibold).monospacedDigit())
                .foregroundStyle(TechColor.ink).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func splitPanel(_ splits: [WorkoutSplit]) -> some View {
        let maxPace = max(splits.map(\.averagePaceSecondsPerKm).max() ?? 1, 1)
        return TechPanel {
            VStack(alignment: .leading, spacing: 4) {
                TechSectionHeader(title: "公里分段", trailing: "\(splits.count) 段")
                if splits.isEmpty {
                    Text("没有分段数据")
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                } else {
                    ForEach(splits) { split in
                        TechAdaptiveStack(spacing: 8) {
                            Text(split.distanceMeters < 999.5 ? "尾段" : "\(split.index) km")
                                .font(.subheadline.weight(.semibold))
                                .frame(width: 52, alignment: .leading)
                            TechProgressBar(fraction: split.averagePaceSecondsPerKm / maxPace)
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
            Text(nativeNumber(load.load)).techScaledFont(34, weight: .semibold).monospacedDigit()
                .foregroundStyle(TechColor.ink)
            DisclosureGroup {
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
            } label: { Text("负荷依据").frame(minHeight: 44) }.font(.caption).tint(TechColor.cyan)
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
                if let value = override.rpe {
                    // 词在前、原始整数在后：整数是服务端真正读到的值（`prediction-data.ts:150`
                    // 拿 `rpe >= 9` 当"很吃力"的证据），只显示词会让"我选了很累，为什么负荷
                    // 没变"无从核对。
                    Text("训练感受：\(TechEffortScale.label(for: Int(value)))（RPE \(Int(value))）")
                }
                if !override.conditionTags.isEmpty { Text("状态标签：\(override.conditionTags.joined(separator: "、"))") }
                if let value = override.note, !value.isEmpty { Text(value) }
            }
            .font(.footnote)
            .foregroundStyle(TechColor.muted)
        }
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
                                Text("跑步能力").font(.headline)
                                Spacer()
                                Image(systemName: "chevron.right").font(.caption)
                            }.foregroundStyle(TechColor.cyan)
                        }
                    }.buttonStyle(TechPressStyle()).accessibilityIdentifier("analysis.ability")
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
                            .techScaledFont(30).monospacedDigit()
                            .foregroundStyle(TechColor.cyan).fixedSize(horizontal: false, vertical: true)
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
                DisclosureGroup {
                    HStack {
                        techMetricCaption("增长速度", value: nativeNumber(data.growthVelocityPerWeek))
                        techMetricCaption("衰减", value: nativeNumber(data.decayPoints))
                    }.padding(.vertical, 8)
                } label: { Text("跑力变化依据").frame(minHeight: 44) }.font(.caption).tint(TechColor.muted)
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
        TechZoneDistributionPanel(title: "心率区间分布", period: "近 28 天", zones: zones)
    }

    private func recordsPanel(_ records: PersonalRecords) -> some View {
        VStack(spacing: 22) {
            Image(systemName: "trophy").font(.system(size: 52, weight: .ultraLight))
                .foregroundStyle(TechColor.energy).padding(.top, 16)
            Text("不断突破，成就更好的自己").font(.subheadline).foregroundStyle(TechColor.muted)
            TechMetricGrid(minimum: 140) {
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
                    .foregroundStyle(TechColor.ink).fixedSize(horizontal: false, vertical: true)
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
                settingsLink("地图底图",
                             subtitle: mapEnabled ? "高德已启用" : "仅离线轨迹",
                             icon: "map", tint: TechColor.cyan) {
                    mapPanel
                }
                settingsLink("本地缓存", subtitle: native.lastCacheUpdate == nil ? "无缓存" : "可离线查看", icon: "externaldrive", tint: TechColor.cyan) {
                    cachePanel
                    versionPanel
                }
                settingsLink("训练提醒", subtitle: "可选 · 默认关闭", icon: "bell", tint: TechColor.cyan) {
                    TechTrainingReminderView()
                }
                settingsLink("导出训练摘要", subtitle: "不含路线与健康原始数据", icon: "square.and.arrow.up", tint: TechColor.cyan) {
                    TechWorkoutExportView()
                }
                TechSectionHeader(title: "应用信息")
                settingsLink("关于 RAI", subtitle: "跑步数据分析与建议", icon: "waveform.path", tint: TechColor.leaf) {
                    versionPanel
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
        .modifier(TechKeyboardDismiss())
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
            .modifier(TechKeyboardDismiss())
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
        }.buttonStyle(TechPressStyle())
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
                if let storageError = session.credentialStorageError {
                    Text(storageError)
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
                TechMetricGrid(minimum: 140) {
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
                                  isDisabled: healthSync.isBusy || !session.isReachable, busyTitle: techSyncPhase(healthSync.phase)) {
                    Task {
                        await healthSync.sync(to: session.serverURL, apiToken: session.apiToken)
                        await native.refreshAll(requestHandshake: false)
                    }
                }.accessibilityIdentifier("health.sync")
            }
            NavigationLink("数据与同步详情") { TechDataSyncDetailView() }
            TechPanel(fill: TechColor.blue.opacity(0.08)) {
                Label("后台会尝试继续同步，也可在此查看进度。", systemImage: "info.circle")
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
                .buttonStyle(TechPressStyle())
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
