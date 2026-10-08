#if os(iOS)
import SwiftUI

struct TechRunCoachView: View {
    @Environment(NativeAppModel.self) private var native
    @State private var showingSetup = false
    @State private var editing = false
    @State private var setupID = UUID()
    @State private var pendingAction: String?
    @State private var watchMessage: String?
    @State private var showingLock = false
    @State private var selectedDay: MobileWeekPlanDay?
    @State private var selectedExecutableDay: MobileWorkoutPlanDay?

    private var plan: MobileRunCoachPlan? {
        if let coach = native.runCoach, coach.revision == native.currentPlanRevision { return coach.plan }
        guard native.goals?.revision == native.currentPlanRevision else { return nil }
        return native.goals?.runCoach
    }

    private var controlsUnavailable: Bool {
        native.isOffline || native.isPlanBusy || native.goals?.revision != native.currentPlanRevision
    }

    private var schedule: MobileWorkoutPlanResponse? {
        guard let value = native.workoutPlan, value.planRevision == native.currentPlanRevision else { return nil }
        return value
    }

    private var scheduleHour: Int {
        TrainingReminders.storedHour(scope: native.feedbackScope)
    }

    private var weeklyBudgetLabel: String? {
        guard let budget = native.runCoach?.weeklyCapacityKm else { return nil }
        return [budget].map { "本周预算 \(nativeNumber($0, digits: 1)) km" }.first
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                if let plan {
                    TechCoachHeroCard(
                        plan: plan,
                        phase: native.runCoach?.phase.map(techCoachPhaseName) ?? techCoachNoRaceBlockLabel,
                        elapsedWeek: native.runCoach?.elapsedWeeks ?? 0,
                        daysToRace: native.runCoach?.daysToRace,
                        todayLocalDate: native.today?.today.localDate
                    )
                    .accessibilityIdentifier("coach.overview")

                    explanation

                    if let today = todayForCurrentPlan {
                        TechTodayTrainingCard(
                            today: today,
                            preferredTargetType: plan.targetType,
                            isCompleted: todayIsCompleted(today),
                            onConfirm: { showingLock = true },
                            isConfirmDisabled: !native.canConfirmToday || native.isOffline || native.isPlanBusy
                        )
                        .accessibilityIdentifier("coach.today")
                    } else {
                        TechPanel(tint: TechColor.yellow, fill: TechColor.paleYellow) {
                            HStack(spacing: 12) {
                                TechIconBox(systemName: "calendar.badge.clock", tint: TechColor.yellow, fill: TechColor.paper)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("今日训练").font(.headline.weight(.semibold))
                                    Text("正在刷新今天的安排").font(.caption).foregroundStyle(TechColor.muted)
                                }
                                Spacer(minLength: 0)
                                if native.isLoadingRunCoach { ProgressView().tint(TechColor.yellow) }
                            }
                        }
                        .accessibilityIdentifier("coach.today")
                    }

                    if native.runCoach?.confidence?.reasonCodes.contains("unsupported_distance") == true {
                        Label("该距离不在预测链 · 训练仍按恢复与跑量调整", systemImage: "info.circle")
                            .font(.caption)
                            .foregroundStyle(TechColor.yellow)
                            .accessibilityIdentifier("coach.unsupported-distance")
                    }

                    if plan.status != "ended" {
                        coachControls(plan)
                    }

                    if let today = todayForCurrentPlan {
                        TechCoachWeekProgressCard(
                            days: today.weekPlan,
                            adherence: today.adherence?.current,
                            periodization: today.periodization?.current,
                            weeklyBudgetLabel: weeklyBudgetLabel
                        )
                        TechCoachWeekTimeline(
                            days: today.weekPlan,
                            todayLocalDate: today.today.localDate,
                            onSelect: { selectedDay = $0 }
                        )
                    }

                    TechCoachTrainingDays(
                        plan: plan,
                        unplannedDays: native.runCoach?.unplannedDays
                    )
                    .accessibilityIdentifier("coach.running-days")

                    if plan.status == "active" {
                        if let schedule {
                            TechCoachRollingUpcomingSection(
                                days: techCoachUpcomingTrainingDays(in: schedule),
                                preferredTargetType: plan.targetType,
                                onSelect: { selectedExecutableDay = $0 }
                            )
                        } else if let today = todayForCurrentPlan {
                            TechCoachUpcomingSection(
                                days: upcomingDays(from: today.weekPlan, todayLocalDate: today.today.localDate),
                                executableDays: [],
                                preferredTargetType: plan.targetType,
                                onSelect: { selectedDay = $0 }
                            )
                        }
                    }

                    if let confidence = native.runCoach?.confidence {
                        TechCoachConfidenceCard(confidence: confidence)
                            .accessibilityIdentifier("coach.confidence")
                    }

                    if let phases = native.runCoach?.phases, !phases.isEmpty {
                        TechCoachPhaseTimeline(phases: phases)
                    }

                    if plan.status != "ended" {
                        watch
                        strength
                        if let execution = native.today?.recentPlanExecution, !execution.isEmpty {
                            TechPlanExecutionPanel(days: execution)
                        }
                        Button(role: .destructive) { pendingAction = "end" } label: {
                            Label("结束计划", systemImage: "stop.circle")
                        }
                        .disabled(controlsUnavailable)
                        .accessibilityIdentifier("coach.end")
                    } else {
                        createButton
                        watch
                    }

                    if let recent = native.today?.recentWorkouts, !recent.isEmpty {
                        TechCoachHistoryCard(workouts: Array(recent.prefix(3)))
                    }
                } else {
                    TechCoachEmptyCard { createButton }
                }

                if native.isLoadingRunCoach { ProgressView("正在更新训练安排") }
                if let message = native.runCoachError {
                    TechPanel(tint: TechColor.coral, fill: TechColor.paleCoral) {
                        HStack(spacing: 10) {
                            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(TechColor.coral)
                            Text(message).font(.footnote).foregroundStyle(TechColor.coral)
                            Spacer(minLength: 0)
                            Button("重试") { Task { await native.refreshRunCoach() } }
                                .font(.caption.weight(.semibold))
                        }
                    }
                }
                if let coach = native.runCoach, !coach.notices.isEmpty {
                    TechPanel(tint: TechColor.yellow, fill: TechColor.paleYellow) {
                        ForEach(coach.notices, id: \.self) { notice in
                            Label(notice, systemImage: "info.circle")
                                .font(.caption)
                                .foregroundStyle(TechColor.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                if native.isOffline {
                    Label("离线缓存", systemImage: "wifi.slash")
                        .font(.footnote)
                        .foregroundStyle(TechColor.yellow)
                }
                if plan == nil || plan?.status == "ended" {
                    NavigationLink { TechManualPlanView() } label: {
                        Label("手动课表", systemImage: "calendar.badge.clock")
                    }
                }
            }
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.top, TechMetrics.pageVertical)
            .padding(.bottom, TechMetrics.bottomClearance)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .techNavigation("跑步教练")
        .task { await native.refreshRunCoach() }
        .refreshable { await native.refreshAll() }
        .sheet(isPresented: $showingSetup) {
            TechRunCoachSetup(plan: editing ? plan : nil).id(setupID)
        }
        .sheet(isPresented: $showingLock) { TechLockSheet() }
        .sheet(item: $selectedDay) { day in
            NavigationStack {
                TechCoachDaySheet(
                    day: day,
                    isToday: day.localDate == native.today?.today.localDate
                )
            }
        }
        .sheet(item: $selectedExecutableDay) { day in
            NavigationStack {
                TechCoachExecutableDaySheet(day: day, preferredTargetType: plan?.targetType ?? "")
            }
        }
        .confirmationDialog(
            actionTitle,
            isPresented: Binding(get: { pendingAction != nil }, set: { if !$0 { pendingAction = nil } }),
            titleVisibility: .visible
        ) {
            if let action = pendingAction {
                Button(actionTitle, role: action == "end" ? .destructive : nil) {
                    pendingAction = nil
                    Task { await native.changeRunCoach(action: action) }
                }
            }
            Button("取消", role: .cancel) { pendingAction = nil }
        }
    }

    private var actionTitle: String {
        pendingAction == "end" ? "结束当前教练计划？" : pendingAction == "resume" ? "按当前训练状态继续计划？" : "暂停教练计划？"
    }

    private var todayForCurrentPlan: MobileTodayResponse? {
        guard let today = native.today,
              today.recommendation.planRevision == native.currentPlanRevision,
              native.isTodayAvailable || native.isOffline else { return nil }
        return today
    }

    private func todayIsCompleted(_ today: MobileTodayResponse) -> Bool {
        today.today.workoutCount > 0 || today.phase == "post_run"
    }

    @ViewBuilder private var explanation: some View {
        let calibration = native.today.flatMap {
            $0.recommendation.planRevision == native.currentPlanRevision ? $0.calibration : nil
        }
        let budget = native.runCoach.flatMap {
            $0.revision == native.currentPlanRevision ? $0.weeklyCapacityKm : nil
        }
        // Count stored sessions even when today's session is recorded or needs reconfirmation.
        let scheduled = schedule?.days.filter { $0.kind != "rest" }.count
        let facts = [
            calibration.map(techCoachCalibrationLabel),
            scheduled.map { "本周排入 \($0) 次训练" },
            budget.map { "本周预算 \(nativeNumber($0, digits: 1)) km" }
        ].compactMap { $0 }
        if !facts.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text(facts.joined(separator: " · "))
                    .font(.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = techCoachCalibrationExplanation(calibration, weeklyBudgetKm: budget) {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(TechColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityIdentifier("coach.explanation")
        }
    }

    private func coachControls(_ plan: MobileRunCoachPlan) -> some View {
        HStack(spacing: 12) {
            Button {
                setupID = UUID()
                editing = true
                showingSetup = true
            } label: {
                Label("训练偏好", systemImage: "slider.horizontal.3")
            }
            .accessibilityIdentifier("coach.preferences")
            Spacer(minLength: 8)
            Button {
                pendingAction = plan.status == "paused" ? "resume" : "pause"
            } label: {
                Label(
                    plan.status == "paused" ? "继续计划" : "暂停计划",
                    systemImage: plan.status == "paused" ? "play.fill" : "pause.fill"
                )
            }
            .accessibilityIdentifier("coach.pause-resume")
        }
        .font(.subheadline.weight(.semibold))
        .disabled(controlsUnavailable)
    }

    private var createButton: some View {
        TechPrimaryButton(title: "创建教练计划", systemName: "plus", isDisabled: controlsUnavailable || native.goals == nil) {
            setupID = UUID()
            editing = false
            showingSetup = true
        }
        .accessibilityIdentifier("coach.create")
    }

    private func upcomingDays(from days: [MobileWeekPlanDay], todayLocalDate: String) -> [MobileWeekPlanDay] {
        days.filter { $0.localDate > todayLocalDate && $0.planned && $0.kind != "rest" }.prefix(3).map { $0 }
    }

    private var watch: some View {
        TechPanel(tint: native.watchNeedsUpdate ? TechColor.coral : TechColor.grid) {
            VStack(alignment: .leading, spacing: 12) {
                TechSectionHeader(
                    title: "手表课表",
                    trailing: native.watchNeedsUpdate ? "需要更新" : "就绪",
                    trailingColor: native.watchNeedsUpdate ? TechColor.coral : TechColor.cyan
                )
                TechPrimaryButton(
                    title: plan?.status == "active" ? "同步跑步课表到手表" : "撤回手表课表",
                    systemName: "applewatch",
                    isBusy: native.isSyncingPlan,
                    isDisabled: native.isPlanBusy || (native.watchNeedsClear ? false : schedule == nil || controlsUnavailable)
                ) {
                    Task { await syncWatch() }
                }
                if schedule == nil, let error = native.workoutPlanError {
                    Text(error).font(.caption).foregroundStyle(TechColor.yellow)
                }
                if let watchMessage {
                    Text(watchMessage).font(.caption).foregroundStyle(TechColor.muted)
                }
            }
        }
    }

    private var strength: some View {
        Group {
            if let sessions = native.runCoach?.strength, !sessions.isEmpty {
                TechPanel {
                    VStack(alignment: .leading, spacing: 10) {
                        TechSectionHeader(title: "力量训练", trailing: "补充")
                        ForEach(sessions) { session in
                            DisclosureGroup {
                                ForEach(session.exercises.indices, id: \.self) { index in
                                    HStack {
                                        Text(session.exercises[index].name)
                                        Spacer()
                                        Text(session.exercises[index].dose).foregroundStyle(TechColor.muted)
                                    }
                                    .font(.subheadline)
                                    .padding(.vertical, 5)
                                }
                            } label: {
                                HStack {
                                    Text(nativeDate(session.localDate))
                                    Spacer()
                                    Text("\(session.durationMinutes) 分钟")
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(TechColor.muted)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    @MainActor
    private func syncWatch() async {
        let clearOnly = native.watchNeedsClear
        guard let id = native.beginPlanSync(allowOffline: clearOnly) else { return }
        defer { native.endPlanSync(id) }
        if clearOnly {
            let outcome = await WorkoutKitBridge.clearRequestingAuthorization(
                isCurrent: { native.isCurrentPlanSync(id) }
            )
            guard native.isCurrentPlanSync(id) else { return }
            watchMessage = outcome.report
            if outcome.authorized && outcome.verified {
                native.recordWatchClearAcknowledgement()
            }
            return
        }
        guard await native.refreshWorkoutPlan(), native.isCurrentPlanSync(id), let schedule = native.currentWorkoutPlan else {
            watchMessage = "课表未刷新，原手表排期未修改。"
            return
        }
        let usedScheduleHour = scheduleHour
        let outcome = await WorkoutKitBridge.syncRequestingAuthorization(
            plan: schedule,
            completedLocalDates: native.completedWeekDates,
            scheduleHour: usedScheduleHour,
            isCurrent: { native.isCurrentPlanSync(id) }
        )
        guard native.isCurrentPlanSync(id) else { return }
        watchMessage = outcome.report
        if outcome.authorized && outcome.verified {
            native.recordWatchAcknowledgement(plan: schedule, scheduleHour: usedScheduleHour)
            if let error = await native.recordPlanSync(schedule, localDates: outcome.scheduledLocalDates) {
                watchMessage = outcome.report + "\n" + error
            }
        }
    }
}

private struct TechCoachHeroCard: View {
    let plan: MobileRunCoachPlan
    let phase: String
    let elapsedWeek: Int
    let daysToRace: Int?
    let todayLocalDate: String?

    private var currentWeek: Int { max(1, elapsedWeek + 1) }
    private var totalWeeks: Int? { techCoachTotalWeeks(for: plan) }
    private var fraction: Double? {
        guard let totalWeeks, totalWeeks > 0 else { return nil }
        return min(1, max(0, Double(currentWeek) / Double(totalWeeks)))
    }

    var body: some View {
        TechHeroCard {
            HStack(alignment: .top, spacing: 12) {
                TechIconBox(systemName: "figure.run.circle.fill", tint: TechColor.ink, fill: TechColor.elevated, size: 48)
                VStack(alignment: .leading, spacing: 4) {
                    Text("跑步教练").font(.caption.weight(.semibold)).foregroundStyle(TechColor.muted)
                    Text(plan.goal == "fitness" ? "改善跑步体能" : "\(nativeKilometers(plan.raceDistanceKm)) 训练计划")
                        .techScaledFont(24, weight: .heavy, relativeTo: .title2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                TechBadge(
                    title: plan.status == "paused" ? "已暂停" : plan.status == "ended" ? "已结束" : "进行中",
                    color: plan.status == "active" ? TechColor.success : TechColor.muted,
                    fill: plan.status == "active" ? TechColor.mint : TechColor.elevated
                )
            }

            HStack(alignment: .center, spacing: 18) {
                TechRingProgress(
                    fraction: fraction,
                    value: totalWeeks.map { "\(currentWeek)/\($0)" } ?? "\(currentWeek)周",
                    label: "训练周期",
                    tint: TechColor.cyan
                )
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Text(phase).font(.headline.weight(.semibold))
                        if let countdown = techCoachRaceCountdown(raceDate: plan.raceDate, todayLocalDate: todayLocalDate, daysToRace: daysToRace) {
                            TechBadge(title: countdown, color: TechColor.yellow, fill: TechColor.paleYellow)
                        }
                    }
                    HStack(spacing: 14) {
                        coachHeroMetric(title: "第\(currentWeek)周", value: totalWeeks.map { "共\($0)周" } ?? "持续")
                        if let targetTimeSeconds = plan.targetTimeSeconds {
                            coachHeroMetric(title: "目标", value: nativeDuration(targetTimeSeconds))
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            TechProgressBar(fraction: fraction, tint: TechColor.cyan, height: 8)
        }
    }

    private func coachHeroMetric(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(value).font(.headline.weight(.bold).monospacedDigit())
            Text(title).font(.caption).foregroundStyle(TechColor.muted)
        }
    }
}

private struct TechTodayTrainingCard: View {
    let today: MobileTodayResponse
    let preferredTargetType: String
    let isCompleted: Bool
    let onConfirm: () -> Void
    let isConfirmDisabled: Bool

    private var session: MobileNextSession { today.nextSession }
    private var target: TechCoachTrainingTarget? {
        techCoachTrainingTarget(for: session, preferredType: preferredTargetType)
    }
    private var isRest: Bool { session.kind == "rest" }
    private var stateLabel: String {
        if isCompleted { return "已记录" }
        if isRest || today.phase == "rest_done" { return "恢复日" }
        if today.lock.present { return "已锁定" }
        return "待开始"
    }
    private var stateColor: Color {
        if isCompleted { return TechColor.success }
        if isRest || today.phase == "rest_done" { return TechColor.muted }
        if today.lock.present { return TechColor.blue }
        return TechColor.cyan
    }
    private var stateFraction: Double {
        if isCompleted || isRest || today.phase == "rest_done" { return 1 }
        if today.lock.present { return 0.65 }
        return 0.18
    }

    var body: some View {
        TechHeroCard {
            HStack(alignment: .top, spacing: 12) {
                TechIconBox(systemName: nativeSessionSymbol(session.kind), tint: stateColor, fill: stateColor.opacity(0.12), size: 52)
                VStack(alignment: .leading, spacing: 4) {
                    Text("今日训练").font(.caption.weight(.semibold)).foregroundStyle(TechColor.muted)
                    Text(session.title).techFont(.compactMetric).fixedSize(horizontal: false, vertical: true)
                    Text(nativeDay(today.today.localDate)).font(.caption).foregroundStyle(TechColor.muted)
                }
                Spacer(minLength: 8)
                TechBadge(title: stateLabel, color: stateColor, fill: stateColor.opacity(0.12))
            }

            TechMetricGrid(minimum: 108) {
                if let distanceKm = session.distanceKm {
                    TechCoachValueTile(value: nativeKilometers(distanceKm), label: "距离", tint: TechColor.ink)
                }
                if let durationMinutes = session.durationMinutes {
                    TechCoachValueTile(value: "\(nativeNumber(durationMinutes, digits: 0)) min", label: "时长", tint: TechColor.ink)
                }
                if let target {
                    TechCoachValueTile(value: target.formattedRange, label: target.title, tint: TechColor.cyan)
                }
            }

            HStack(spacing: 10) {
                TechProgressBar(fraction: stateFraction, tint: stateColor, height: 8)
                Text(stateLabel).font(.caption.weight(.semibold)).foregroundStyle(stateColor)
            }

            if !session.reason.isEmpty {
                Text(session.reason)
                    .font(.caption)
                    .foregroundStyle(TechColor.muted)
                    .lineLimit(1)
            }

            if !isRest && !isCompleted {
                Button(action: onConfirm) {
                    Label(today.lock.relockSuggested ? "重新确认今日训练" : today.lock.present ? "已锁定今日训练" : "确认今日训练", systemImage: today.lock.present ? "checkmark.circle.fill" : "play.fill")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(isConfirmDisabled ? TechColor.muted : TechColor.actionInk)
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .background(isConfirmDisabled ? TechColor.grid : TechColor.action, in: TechSurfaceShape())
                }
                .buttonStyle(TechPressStyle())
                .disabled(isConfirmDisabled)
            }
        }
    }
}

private extension TechCoachTrainingTarget {
    var formattedRange: String {
        alert.kind == "heart_rate"
            ? techHeartRateRange(alert.lower, alert.upper)
            : techPaceRange(alert.lower, alert.upper)
    }
}

private struct TechCoachValueTile: View {
    let value: String
    let label: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(value)
                .techScaledFont(20, weight: .bold, relativeTo: .title3).monospacedDigit()
                .foregroundStyle(tint)
                .fixedSize(horizontal: false, vertical: true)
            Text(label).font(.caption).foregroundStyle(TechColor.muted)
        }
        .frame(maxWidth: .infinity, minHeight: 70, alignment: .leading)
        .padding(12)
        .background(TechColor.elevated, in: TechSurfaceShape())
    }
}

private struct TechCoachWeekProgressCard: View {
    let days: [MobileWeekPlanDay]
    let adherence: MobileAdherenceWeek?
    let periodization: MobilePeriodizationWeek?
    let weeklyBudgetLabel: String?

    private var progress: TechCoachWeekProgress { TechCoachWeekProgress(days: days, adherence: adherence) }

    var body: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 12) {
                TechSectionHeader(title: "本周进度", trailing: "\(progress.completedCount)/\(progress.plannedCount) 次", trailingColor: TechColor.cyan)
                HStack(alignment: .center, spacing: 16) {
                    TechRingProgress(
                        fraction: progress.fraction,
                        value: adherence?.plannedDistanceKm != nil
                            ? nativeNumber(adherence?.observedDistanceKm, digits: 0)
                            : "\(progress.completedCount)",
                        label: adherence?.plannedDistanceKm != nil ? "已完成 km" : "已完成",
                        tint: TechColor.cyan
                    )
                    VStack(alignment: .leading, spacing: 10) {
                        if let adherence, let planned = adherence.plannedDistanceKm {
                            TechCoachProgressStat(title: "跑量", value: "\(nativeKilometers(adherence.observedDistanceKm)) / \(nativeKilometers(planned))")
                        } else {
                            TechCoachProgressStat(title: "训练", value: "已完成 \(progress.completedCount) 次")
                            TechCoachProgressStat(title: "未记录", value: "\(progress.unrecordedCount) 次")
                        }
                        if progress.unknownCount > 0 {
                            TechBadge(title: "\(progress.unknownCount) 天待同步", color: TechColor.yellow, fill: TechColor.paleYellow)
                        }
                        if let periodization {
                            TechCoachProgressStat(title: techCoachPhaseName(periodization.phase), value: "\(nativeNumber(periodization.volumeBandKm.lower, digits: 0))–\(nativeNumber(periodization.volumeBandKm.upper, digits: 0)) km")
                        }
                        if let weeklyBudgetLabel {
                            TechBadge(title: weeklyBudgetLabel, color: TechColor.cyan, fill: TechColor.mint)
                        }
                    }
                    Spacer(minLength: 0)
                }
                TechProgressBar(fraction: progress.fraction, tint: TechColor.cyan, height: 8)
            }
        }
    }
}

private struct TechCoachProgressStat: View {
    let title: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title).font(.caption).foregroundStyle(TechColor.muted)
            Text(value).font(.subheadline.weight(.semibold).monospacedDigit())
        }
    }
}

private struct TechCoachWeekTimeline: View {
    @ScaledMetric(relativeTo: .caption) private var cardWidth: CGFloat = 116
    @ScaledMetric(relativeTo: .title3) private var iconHeight: CGFloat = 24
    let days: [MobileWeekPlanDay]
    let todayLocalDate: String
    let onSelect: (MobileWeekPlanDay) -> Void

    var body: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 12) {
                TechSectionHeader(title: "本周安排", trailing: "点击查看")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(days) { day in
                            Button { onSelect(day) } label: { dayCard(day) }
                                .buttonStyle(TechPressStyle())
                                .accessibilityLabel(dayAccessibilityLabel(day))
                                .accessibilityIdentifier("coach.week-day.\(day.localDate)")
                        }
                    }
                }
            }
        }
    }

    private func dayCard(_ day: MobileWeekPlanDay) -> some View {
        let isToday = day.localDate == todayLocalDate
        let completed = techCoachDayIsCompleted(day)
        let tint = completed ? TechColor.success : techSessionColor(day.kind)
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(nativeWeekday(day.localDate)).font(.caption.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                if isToday { Circle().fill(TechColor.cyan).frame(width: 7, height: 7) }
            }
            Text(nativeDay(day.localDate)).font(.caption2).foregroundStyle(TechColor.muted)
                .fixedSize(horizontal: false, vertical: true)
            Image(systemName: completed ? "checkmark.circle.fill" : nativeSessionSymbol(day.kind))
                .font(.title3.weight(.semibold))
                .foregroundStyle(tint)
                .frame(height: iconHeight)
            Text(techCoachWeekDayTitle(day))
                .font(.caption.weight(.semibold))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Text(day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : day.kind == "rest" ? "休息" : "—")
                .font(.caption2.weight(.bold).monospacedDigit())
                .foregroundStyle(TechColor.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(12)
        .frame(width: min(cardWidth, 260), alignment: .topLeading)
        .frame(minHeight: 140, alignment: .topLeading)
        .background(isToday ? TechColor.mint : TechColor.paper, in: TechSurfaceShape())
        .overlay(TechSurfaceShape().stroke(isToday ? TechColor.cyan : TechColor.grid.opacity(0.6), lineWidth: isToday ? 1.5 : 1))
    }

    private func dayAccessibilityLabel(_ day: MobileWeekPlanDay) -> String {
        let state = techCoachDayIsCompleted(day) ? "已记录" : "未记录"
        return "\(nativeWeekday(day.localDate))\(nativeDay(day.localDate))，\(techCoachWeekDayTitle(day))，\(day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : "无距离")，\(state)，查看训练详情"
    }
}

private struct TechCoachTrainingDays: View {
    let plan: MobileRunCoachPlan
    let unplannedDays: [MobileRunCoachResponse.UnplannedDay]?

    var body: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 10) {
                TechSectionHeader(title: "可跑步日", trailing: "按偏好")
                HStack(spacing: 7) {
                    ForEach(plan.runningDays, id: \.self) { day in
                        TechBadge(title: weekdayName(day), color: TechColor.cyan, fill: TechColor.mint)
                    }
                }
                Text("可选，不是承诺；实际排课按校准、跑量与恢复调整。")
                    .font(.caption)
                    .foregroundStyle(TechColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
                if let unplannedDays, !unplannedDays.isEmpty {
                    Text("其中 \(unplannedDays.count) 天本周没有排入训练。")
                        .font(.caption)
                        .foregroundStyle(TechColor.muted)
                    ForEach(Array(Set(unplannedDays.map { "\(techCoachUnplannedReasonName($0.code))：\($0.detail)" })).sorted(), id: \.self) { detail in
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(TechColor.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private func weekdayName(_ day: Int) -> String {
        ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"][min(7, max(1, day))]
    }
}

private struct TechCoachRollingUpcomingSection: View {
    let days: [MobileWorkoutPlanDay]
    let preferredTargetType: String
    let onSelect: (MobileWorkoutPlanDay) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TechSectionHeader(title: "接下来训练", trailing: "未来 3 次")
            if days.isEmpty {
                TechPanel { Text("接下来没有已生成的训练").font(.caption).foregroundStyle(TechColor.muted) }
            } else {
                ForEach(days) { day in
                    Button { onSelect(day) } label: {
                        TechCoachRollingUpcomingRow(day: day, preferredTargetType: preferredTargetType)
                    }
                    .buttonStyle(TechPressStyle())
                }
            }
        }
    }
}

private struct TechCoachRollingUpcomingRow: View {
    let day: MobileWorkoutPlanDay
    let preferredTargetType: String

    private var target: TechCoachTrainingTarget? {
        techCoachTrainingTarget(for: day, preferredType: preferredTargetType)
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(nativeWeekday(day.localDate)).font(.caption.weight(.semibold))
                Text(nativeDay(day.localDate)).font(.caption2).foregroundStyle(TechColor.muted)
            }
            .frame(width: 48, alignment: .leading)
            TechIconBox(systemName: nativeSessionSymbol(day.kind), tint: techSessionColor(day.kind), fill: techSessionColor(day.kind).opacity(0.12), size: 38)
            VStack(alignment: .leading, spacing: 4) {
                Text(day.title.isEmpty ? nativeSessionName(day.kind) : day.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TechColor.ink)
                HStack(spacing: 10) {
                    if let distance = day.distanceKm {
                        Text(nativeKilometers(distance))
                    }
                    if let duration = day.durationMinutes {
                        Text("\(nativeNumber(duration, digits: 0)) min")
                    }
                    if let target {
                        Text(target.formattedRange)
                    }
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(TechColor.muted)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(TechColor.muted)
        }
        .padding(12)
        .background(TechColor.paper, in: TechSurfaceShape())
        .overlay(TechSurfaceShape().stroke(TechColor.grid.opacity(0.6), lineWidth: 1))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(nativeWeekday(day.localDate))\(nativeDay(day.localDate))，\(nativeSessionName(day.kind))，查看训练详情")
    }
}

private struct TechCoachUpcomingSection: View {
    let days: [MobileWeekPlanDay]
    let executableDays: [MobileWorkoutPlanDay]
    let preferredTargetType: String
    let onSelect: (MobileWeekPlanDay) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TechSectionHeader(title: "接下来训练", trailing: "未来 3 次")
            if days.isEmpty {
                TechPanel { Text("接下来没有已生成的训练").font(.caption).foregroundStyle(TechColor.muted) }
            } else {
                ForEach(days) { day in
                    Button { onSelect(day) } label: {
                        TechCoachUpcomingRow(
                            day: day,
                            executable: executableDays.first(where: { $0.localDate == day.localDate }),
                            preferredTargetType: preferredTargetType
                        )
                    }
                    .buttonStyle(TechPressStyle())
                }
            }
        }
    }
}

private struct TechCoachExecutableDaySheet: View {
    let day: MobileWorkoutPlanDay
    let preferredTargetType: String
    private var lines: [NativeStructureLine] { nativeStructureLines(day.structure) }
    private var target: TechCoachTrainingTarget? {
        techCoachTrainingTarget(for: day, preferredType: preferredTargetType)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    TechIconBox(systemName: nativeSessionSymbol(day.kind), tint: techSessionColor(day.kind), fill: techSessionColor(day.kind).opacity(0.12), size: 46)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(nativeWeekday(day.localDate)) · \(nativeDay(day.localDate))")
                            .font(.title3.weight(.semibold))
                        Text(day.title.isEmpty ? nativeSessionName(day.kind) : day.title)
                            .font(.subheadline)
                            .foregroundStyle(TechColor.muted)
                    }
                    Spacer(minLength: 0)
                    TechBadge(title: "计划中", color: TechColor.cyan, fill: TechColor.mint)
                }
                TechMetricGrid(minimum: 120) {
                    TechMetricTile(title: "距离", value: nativeKilometers(day.distanceKm))
                    if let durationMinutes = day.durationMinutes {
                        TechMetricTile(title: "时长", value: "\(nativeNumber(durationMinutes, digits: 0)) min")
                    }
                    if let target {
                        TechMetricTile(title: target.title, value: target.formattedRange, accent: TechColor.cyan)
                    }
                }
                if lines.isEmpty {
                    TechPanel {
                        Text("这次训练暂未提供结构化步骤。")
                            .font(.footnote)
                            .foregroundStyle(TechColor.muted)
                    }
                } else {
                    TechPanel {
                        VStack(alignment: .leading, spacing: 10) {
                            TechSectionHeader(title: "训练内容", trailing: "\(lines.count) 步")
                            ForEach(lines) { line in
                                TechAdaptiveStack(spacing: 10) {
                                    Text(line.title)
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(TechColor.cyan)
                                        .frame(minWidth: 72, alignment: .leading)
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
        .navigationTitle("训练详情")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct TechCoachUpcomingRow: View {
    let day: MobileWeekPlanDay
    let executable: MobileWorkoutPlanDay?
    let preferredTargetType: String

    private var target: TechCoachTrainingTarget? {
        if let executable {
            return techCoachTrainingTarget(for: executable, preferredType: preferredTargetType)
        }
        return techCoachTrainingTarget(structure: day.structure)
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(nativeWeekday(day.localDate)).font(.caption.weight(.semibold))
                Text(nativeDay(day.localDate)).font(.caption2).foregroundStyle(TechColor.muted)
            }
            .frame(width: 48, alignment: .leading)
            TechIconBox(systemName: nativeSessionSymbol(day.kind), tint: techSessionColor(day.kind), fill: techSessionColor(day.kind).opacity(0.12), size: 38)
            VStack(alignment: .leading, spacing: 4) {
                Text(day.title.isEmpty ? nativeSessionName(day.kind) : day.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TechColor.ink)
                HStack(spacing: 10) {
                    if let distance = executable?.distanceKm ?? (day.distanceKm > 0 ? day.distanceKm : nil) {
                        Text(nativeKilometers(distance))
                    }
                    if let duration = executable?.durationMinutes {
                        Text("\(nativeNumber(duration, digits: 0)) min")
                    }
                    if let target {
                        Text(target.formattedRange)
                    }
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(TechColor.muted)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(TechColor.muted)
        }
        .padding(12)
        .background(TechColor.paper, in: TechSurfaceShape())
        .overlay(TechSurfaceShape().stroke(TechColor.grid.opacity(0.6), lineWidth: 1))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(nativeWeekday(day.localDate))\(nativeDay(day.localDate))，\(nativeSessionName(day.kind))，查看训练详情")
    }
}

private struct TechCoachConfidenceCard: View {
    let confidence: MobileRunCoachResponse.Confidence

    var body: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 12) {
                TechSectionHeader(title: "备赛准备度", trailing: techCoachConfidenceBandName(confidence.band ?? ""))
                if confidence.status == "available", let value = confidence.value {
                    HStack(spacing: 16) {
                        TechRingProgress(
                            fraction: value / 100,
                            value: "\(Int(value.rounded()))",
                            label: "/ 100",
                            tint: bandColor(confidence.band)
                        )
                        VStack(alignment: .leading, spacing: 8) {
                            Text(techCoachConfidenceBandName(confidence.band ?? ""))
                                .font(.headline.weight(.semibold))
                                .foregroundStyle(bandColor(confidence.band))
                            if let level = confidence.evidenceLevel {
                                Text(techCoachEvidenceLevelName(level)).font(.caption).foregroundStyle(TechColor.muted)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    if let components = confidence.components {
                        VStack(spacing: 2) {
                            TechProgressRow(label: "跑量", fraction: components.volume)
                            TechProgressRow(label: "长课", fraction: components.longRun)
                            TechProgressRow(label: "频率", fraction: components.frequency)
                            TechProgressRow(label: "强度", fraction: components.exposure)
                            TechProgressRow(label: "新鲜度", fraction: components.recency)
                        }
                        .accessibilityLabel(componentLine(components))
                    }
                } else {
                    Text("暂无法给出准备度").font(.headline.weight(.semibold))
                }
                if !confidence.note.isEmpty {
                    DisclosureGroup("查看依据") {
                        Text(confidence.note).font(.caption).foregroundStyle(TechColor.muted)
                    }
                    .font(.caption.weight(.semibold))
                    .tint(TechColor.cyan)
                }
            }
        }
    }

    private func bandColor(_ band: String?) -> Color {
        switch band {
        case "high": return TechColor.green
        case "moderate": return TechColor.yellow
        default: return TechColor.coral
        }
    }

    private func componentLine(_ components: MobileRunCoachResponse.Components) -> String {
        "跑量 \(nativePercent(components.volume)) · 长课 \(nativePercent(components.longRun)) · "
            + "频率 \(nativePercent(components.frequency)) · 强度 \(nativePercent(components.exposure)) · "
            + "新鲜度 \(nativePercent(components.recency))"
    }
}

private struct TechProgressRow: View {
    let label: String
    let fraction: Double

    var body: some View {
        HStack(spacing: 8) {
            Text(label).font(.caption).foregroundStyle(TechColor.muted).frame(width: 42, alignment: .leading)
            TechProgressBar(fraction: fraction, tint: TechColor.cyan, height: 6)
            Text(nativePercent(fraction)).font(.caption2.monospacedDigit()).foregroundStyle(TechColor.ink).frame(width: 40, alignment: .trailing)
        }
    }
}

private struct TechCoachPhaseTimeline: View {
    let phases: [MobileRunCoachResponse.Phase]

    var body: some View {
        TechPanel {
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(phases) { phase in
                        HStack(alignment: .top, spacing: 12) {
                            VStack(spacing: 0) {
                                Image(systemName: phase.current ? "circle.inset.filled" : "circle")
                                    .foregroundStyle(phase.current ? TechColor.cyan : TechColor.muted)
                                if phase.id != phases.last?.id {
                                    Rectangle().fill(TechColor.grid).frame(width: 1, height: 30)
                                }
                            }
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 8) {
                                    Text(techCoachPhaseName(phase.phase)).font(.subheadline.weight(.semibold))
                                    if phase.current { TechBadge(title: "当前", color: TechColor.cyan, fill: TechColor.mint) }
                                }
                                Text("\(nativeDay(phase.startsOn)) – \(nativeDay(phase.endsOn))")
                                    .font(.caption)
                                    .foregroundStyle(TechColor.muted)
                            }
                            Spacer(minLength: 0)
                        }
                    }
                }
                .padding(.top, 10)
            } label: {
                TechSectionHeader(title: "训练周期", trailing: "阶段")
            }
            .tint(TechColor.cyan)
        }
    }
}

private struct TechCoachHistoryCard: View {
    let workouts: [WorkoutListItem]

    var body: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 10) {
                TechSectionHeader(title: "最近训练", trailing: "历史")
                ForEach(workouts) { workout in
                    NavigationLink { TechWorkoutDetailView(workoutId: workout.id) } label: {
                        HStack(spacing: 10) {
                            TechIconBox(systemName: "checkmark.circle.fill", tint: TechColor.success, fill: TechColor.mint, size: 34)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(nativeSessionName(workout.sessionType)).font(.subheadline.weight(.semibold))
                                Text(nativeDate(workout.startedAt)).font(.caption).foregroundStyle(TechColor.muted)
                            }
                            Spacer(minLength: 0)
                            Text(nativeKilometers(workout.distanceKm)).font(.caption.monospacedDigit()).foregroundStyle(TechColor.ink)
                            Image(systemName: "chevron.right").font(.caption2).foregroundStyle(TechColor.muted)
                        }
                        .padding(.vertical, 5)
                    }
                    .buttonStyle(TechPressStyle())
                }
            }
        }
    }
}

private struct TechCoachEmptyCard<Content: View>: View {
    let createButton: Content

    init(@ViewBuilder createButton: () -> Content) {
        self.createButton = createButton()
    }

    var body: some View {
        TechPanel(tint: TechColor.cyan) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    TechIconBox(systemName: "figure.run.circle.fill", tint: TechColor.cyan, fill: TechColor.mint, size: 50)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("你的跑步教练").font(.title2.weight(.bold))
                        Text("从今天开始，按计划训练").font(.subheadline).foregroundStyle(TechColor.muted)
                    }
                }
                createButton
            }
        }
    }
}

private struct TechRingProgress: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let fraction: Double?
    let value: String
    let label: String
    let tint: Color

    private var clampedFraction: Double? {
        guard let fraction, fraction.isFinite else { return nil }
        return min(1, max(0, fraction))
    }

    var body: some View {
        ZStack {
            Circle().stroke(TechColor.grid.opacity(0.55), lineWidth: 8)
            if let clampedFraction {
                Circle()
                    .trim(from: 0, to: clampedFraction)
                    .stroke(tint, style: StrokeStyle(lineWidth: 8, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            VStack(spacing: 1) {
                Text(value).font(.caption.weight(.bold).monospacedDigit()).foregroundStyle(TechColor.ink)
                    .lineLimit(1).minimumScaleFactor(0.25)
                Text(label).font(.caption2).foregroundStyle(TechColor.muted)
                    .lineLimit(1).minimumScaleFactor(0.25)
            }
        }
        .frame(width: 76, height: 76)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.3), value: clampedFraction)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(value)
    }
}

private struct TechCoachDaySheet: View {
    let day: MobileWeekPlanDay
    let isToday: Bool

    private var lines: [NativeStructureLine] { nativeStructureLines(day.structure) }
    private var isCompleted: Bool { techCoachDayIsCompleted(day) }
    private var status: String {
        if isCompleted { return "已记录" }
        if day.kind == "rest" { return "休息" }
        return isToday ? "今日" : "计划中"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    TechIconBox(systemName: nativeSessionSymbol(day.kind), tint: techSessionColor(day.kind), fill: techSessionColor(day.kind).opacity(0.12), size: 46)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(nativeWeekday(day.localDate)) · \(nativeDay(day.localDate))")
                            .font(.title3.weight(.semibold))
                        Text(day.title.isEmpty ? nativeSessionName(day.kind) : day.title)
                            .font(.subheadline)
                            .foregroundStyle(TechColor.muted)
                    }
                    Spacer(minLength: 0)
                    TechBadge(title: status, color: isCompleted ? TechColor.success : TechColor.cyan, fill: isCompleted ? TechColor.mint : TechColor.paleCyan)
                }
                TechMetricGrid(minimum: 120) {
                    TechMetricTile(title: "距离", value: day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : "—")
                    TechMetricTile(title: "训练状态", value: status, accent: isCompleted ? TechColor.success : TechColor.cyan)
                }
                if lines.isEmpty {
                    TechPanel {
                        Text(isCompleted ? "这一天已有训练记录。" : day.kind == "rest" ? "这一天没有训练安排。" : "这一天暂未提供结构化训练步骤。")
                            .font(.footnote)
                            .foregroundStyle(TechColor.muted)
                    }
                } else {
                    TechPanel {
                        VStack(alignment: .leading, spacing: 10) {
                            TechSectionHeader(title: "训练内容", trailing: "\(lines.count) 步")
                            ForEach(lines) { line in
                                TechAdaptiveStack(spacing: 10) {
                                    Text(line.title).font(.caption.weight(.semibold)).foregroundStyle(TechColor.cyan).frame(minWidth: 72, alignment: .leading)
                                    Text(line.detail).font(.caption).foregroundStyle(TechColor.ink).frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                    }
                }
                if let workoutId = day.completedWorkoutId {
                    NavigationLink("查看已记录训练") { TechWorkoutDetailView(workoutId: workoutId) }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(TechColor.cyan)
                }
            }
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.vertical, TechMetrics.pageVertical)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .navigationTitle("训练详情")
        .navigationBarTitleDisplayMode(.inline)
    }
}


struct TechRunCoachSetup: View {
    @Environment(NativeAppModel.self) private var native
    @Environment(\.dismiss) private var dismiss
    let plan: MobileRunCoachPlan?
    @State private var goal = "fitness"
    @State private var distance = 10.0
    @State private var customDistance = "50"
    @State private var raceDate = Date().addingTimeInterval(84 * 86_400)
    @State private var targetMinutes = 60.0
    @State private var runningDays = Set([1, 2, 4, 6, 7])
    @State private var longRunDays = Set([7])
    @State private var targetType = "pace"
    @State private var strengthTraining = false
    @State private var durationWeeks = 12
    @State private var baseRevision: Int?
    @State private var loaded = false

    private var km: Double { distance == -1 ? Double(customDistance) ?? 0 : distance }
    private var planTimeZone: TimeZone {
        TimeZone(identifier: native.today?.timezone ?? "Asia/Shanghai") ?? .current
    }
    private var planCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = planTimeZone
        return calendar
    }
    private var raceDateRange: ClosedRange<Date> {
        let start = planCalendar.startOfDay(for: Date())
        let minimum = planCalendar.date(byAdding: .day, value: 42, to: start) ?? start
        let maximum = planCalendar.date(byAdding: .day, value: 364, to: start) ?? start
        return minimum...maximum
    }
    /// The pace the entered duration works out to, `m:ss /km`. Nil until both inputs are usable.
    private var targetPaceLabel: String? {
        guard km > 0, targetMinutes > 0 else { return nil }
        let seconds = (targetMinutes * 60 / km).rounded()
        guard seconds.isFinite, seconds > 0 else { return nil }
        return String(format: "%d:%02d /km", Int(seconds) / 60, Int(seconds) % 60)
    }
    private var valid: Bool {
        runningDays.count >= 3 && !longRunDays.isEmpty && longRunDays.isSubset(of: runningDays) &&
            (goal == "fitness" || (km >= 1.6 && km <= 1609.344 && (goal != "time" || (150...900).contains(targetMinutes * 60 / km)))) &&
            baseRevision == native.goals?.revision && baseRevision == native.currentPlanRevision
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("训练目标") {
                    Picker("目标", selection: $goal) {
                        Text("改善体能").tag("fitness"); Text("顺利完赛").tag("finish"); Text("目标时间").tag("time")
                    }.disabled(plan != nil).accessibilityIdentifier("coach.setup.goal")
                    if goal == "fitness" { Stepper("\(durationWeeks) 周", value: $durationWeeks, in: 6...52).disabled(plan != nil) }
                    if goal != "fitness" {
                        Picker("比赛距离", selection: $distance) {
                            Text("5 km").tag(5.0); Text("10 km").tag(10.0); Text("半程马拉松").tag(21.0975)
                            Text("马拉松").tag(42.195); Text("自定义").tag(-1.0)
                        }.disabled(plan != nil).accessibilityIdentifier("coach.setup.distance")
                        if distance == -1 {
                            TextField("距离（km）", text: $customDistance).keyboardType(.decimalPad).disabled(plan != nil)
                            // Decision 4: say it while the choice is being made, not after the
                            // runner has filled in a date and a target time for a distance that
                            // will never get a prediction or a confidence value.
                            Text("自定义距离不在成绩预测链内：不会有成绩预测，也不会有备赛信心值。")
                                .font(.caption).foregroundStyle(TechColor.muted)
                        }
                        DatePicker("比赛日期", selection: $raceDate, in: plan == nil ? raceDateRange : Date.distantPast...Date.distantFuture, displayedComponents: .date)
                            .disabled(plan != nil)
                        Text("日期按 \(planTimeZone.identifier) 计算。新建比赛计划需要至少 6 周准备时间。")
                            .font(.caption).foregroundStyle(TechColor.muted)
                        if goal == "time" {
                            HStack { Text("目标时间（分钟）"); TextField("分钟", value: $targetMinutes, format: .number).keyboardType(.decimalPad).multilineTextAlignment(.trailing) }
                            // Derived, not judged: the stored goal is a duration, so the pace it
                            // implies is invisible until someone divides. The form used to accept
                            // a half-marathon target of 1:00:00 (2:51/km) with nothing on screen
                            // to notice. Showing the quotient needs no new threshold — every
                            // "beyond world class" cut-off would be an uncalibrated constant.
                            if let pace = targetPaceLabel {
                                Text("目标配速 \(pace)").font(.caption).foregroundStyle(TechColor.muted)
                            }
                        }
                    }
                }
                Section("可跑步日") {
                    ForEach(1...7, id: \.self) { day in
                        Toggle(weekdayName(day), isOn: Binding(get: { runningDays.contains(day) }, set: { value in
                            if value { runningDays.insert(day) } else { runningDays.remove(day); longRunDays.remove(day) }
                        }))
                    }
                }
                Section("长距离偏好日") {
                    Text("可多选；教练每周通常从中选择一个长距离日。")
                        .font(.caption).foregroundStyle(TechColor.muted)
                    ForEach(runningDays.sorted(), id: \.self) { day in
                        Toggle(weekdayName(day), isOn: Binding(get: { longRunDays.contains(day) }, set: { value in
                            if value { longRunDays.insert(day) } else { longRunDays.remove(day) }
                        }))
                    }
                }
                Section("训练偏好") {
                    Picker("强度目标", selection: $targetType) { Text("配速").tag("pace"); Text("心率").tag("heart_rate") }
                        .pickerStyle(.segmented)
                    Toggle("补充力量训练", isOn: $strengthTraining)
                }
                if runningDays.count < 3 { Text("请选择至少三个可跑步日。").foregroundStyle(TechColor.coral) }
                if longRunDays.isEmpty { Text("请选择长距离偏好日。").foregroundStyle(TechColor.coral) }
                if goal != "fitness" && !(1.6...1609.344).contains(km) { Text("比赛距离须为 1.6–1609.344 km。").foregroundStyle(TechColor.coral) }
                if goal == "time" && km > 0 && !(150...900).contains(targetMinutes * 60 / km) { Text("目标时间对应配速须为 2:30–15:00 /km。").foregroundStyle(TechColor.coral) }
                if baseRevision != native.goals?.revision { Text("计划已在别处更新，请关闭后重新编辑；当前草稿未保存。").foregroundStyle(TechColor.coral) }
                if let error = native.runCoachError { Text(error).foregroundStyle(TechColor.coral) }
            }
            .techFormSurface()
            .navigationTitle(plan == nil ? "创建教练计划" : "训练偏好")
            .navigationBarTitleDisplayMode(.inline)
            .environment(\.timeZone, planTimeZone)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(native.isUpdatingRunCoach) }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: {
                        if native.isUpdatingRunCoach { ProgressView() } else { Label(plan == nil ? "开始" : "保存", systemImage: "checkmark") }
                    }.disabled(!valid || native.isOffline || native.isPlanBusy).accessibilityIdentifier("coach.setup.save")
                }
            }
            .interactiveDismissDisabled(native.isUpdatingRunCoach)
            .onAppear { load() }
        }
    }

    private func weekdayName(_ day: Int) -> String { ["", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"][day] }
    private func load() {
        guard !loaded else { return }; loaded = true
        baseRevision = native.goals?.revision
        if let plan {
            goal = plan.goal; targetType = plan.targetType; strengthTraining = plan.strengthTraining
            durationWeeks = plan.durationWeeks ?? 12
            runningDays = Set(plan.runningDays); longRunDays = Set(plan.longRunDays)
            if let value = plan.raceDistanceKm {
                distance = [5.0, 10.0, 21.0975, 42.195].contains(value) ? value : -1
                customDistance = String(value)
            }
            if let value = plan.raceDate {
                let parser = DateFormatter(); parser.locale = Locale(identifier: "en_US_POSIX")
                parser.timeZone = planTimeZone; parser.dateFormat = "yyyy-MM-dd"
                if let date = parser.date(from: value) { raceDate = date }
            }
            if let seconds = plan.targetTimeSeconds { targetMinutes = seconds / 60 }
        }
    }
    @MainActor private func save() async {
        let date = DateFormatter(); date.calendar = planCalendar; date.timeZone = planTimeZone; date.dateFormat = "yyyy-MM-dd"
        let config = MobileRunCoachConfig(goal: goal, raceDate: goal == "fitness" ? nil : date.string(from: raceDate),
            raceDistanceKm: goal == "fitness" ? nil : km, targetTimeSeconds: goal == "time" ? targetMinutes * 60 : nil,
            runningDays: runningDays.sorted(), longRunDays: longRunDays.sorted(), targetType: targetType, strengthTraining: strengthTraining, durationWeeks: durationWeeks)
        if await native.changeRunCoach(action: plan == nil ? "start" : "update", config: config, expectedRevision: baseRevision) { dismiss() }
    }
}
#endif
