#if os(iOS)
import SwiftUI

struct TechRunCoachView: View {
    @Environment(NativeAppModel.self) private var native
    @State private var showingSetup = false
    @State private var editing = false
    @State private var setupID = UUID()
    @State private var setupSessionID = ""
    @State private var pendingAction: String?
    @State private var pendingRevision: Int?
    @State private var pendingSessionID: String?
    @State private var showingLock = false
    @State private var selectedDay: MobileWeekPlanDay?
    @State private var selectedExecutableDay: MobileWorkoutPlanDay?

    private var snapshot: PlanPresentationSnapshot { native.planPresentation }
    private var plan: MobileRunCoachPlan? { snapshot.coachPlan }

    private var controlsUnavailable: Bool {
        native.isOffline || native.isPlanBusy || native.planPersistenceFailed || snapshot.goals == nil
    }

    private var schedule: MobileWorkoutPlanResponse? { snapshot.executablePlan }

    private var weeklyBudgetLabel: String? {
        guard let budget = snapshot.coach?.weeklyCapacityKm else { return nil }
        return [budget].map { "本周预算 \(nativeNumber($0, digits: 1)) km" }.first
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                if native.isCoachLoopManaged {
                    TechCoachLoopSection()
                } else if let plan {
                    if plan.status == "active", native.usesIntegratedPlanContract {
                        Button("按最新训练事实调整计划") { Task { await native.changeRunCoach(action: "refresh") } }
                            .disabled(controlsUnavailable)
                    }
                    TechCoachHeroCard(
                        plan: plan,
                        phase: snapshot.coach.map { $0.phase.map(techCoachPhaseName) ?? techCoachNoRaceBlockLabel } ?? "阶段待刷新",
                        elapsedWeek: snapshot.coach?.elapsedWeeks,
                        daysToRace: snapshot.coach?.daysToRace,
                        todayLocalDate: snapshot.today?.today.localDate
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
                                    Text(snapshot.availability.message).font(.caption).foregroundStyle(TechColor.muted)
                                    if let date = snapshot.lastKnownTodayDate {
                                        Text("上次安排日期 \(date)（非当前处方）").font(.caption2).foregroundStyle(TechColor.muted)
                                    }
                                }
                                Spacer(minLength: 0)
                                if native.isLoadingRunCoach { ProgressView().tint(TechColor.yellow) }
                                else { Button("重试") { Task { await native.refreshPlanState() } }.font(.caption) }
                            }
                        }
                        .accessibilityIdentifier("coach.today")
                    }

                    if snapshot.coach?.confidence?.reasonCodes.contains("unsupported_distance") == true {
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
                        unplannedDays: snapshot.coach?.unplannedDays
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

                    if let confidence = snapshot.coach?.confidence {
                        TechCoachConfidenceCard(confidence: confidence)
                            .accessibilityIdentifier("coach.confidence")
                    }

                    if snapshot.coach?.phase != nil, let phases = snapshot.coach?.phases, !phases.isEmpty {
                        TechCoachPhaseTimeline(phases: phases)
                    }

                    if plan.status != "ended" {
                        TechCoachStrengthSection(sessions: snapshot.coach?.strength ?? [])
                        if let execution = snapshot.today?.recentPlanExecution, !execution.isEmpty {
                            TechPlanExecutionPanel(days: execution)
                        }
                        Button(role: .destructive) { prepareAction("end") } label: {
                            Label("结束计划", systemImage: "stop.circle")
                        }
                        .disabled(controlsUnavailable)
                        .accessibilityIdentifier("coach.end")
                    } else {
                        createButton
                    }

                    if let recent = native.today?.recentWorkouts, !recent.isEmpty {
                        TechCoachHistoryCard(workouts: Array(recent.prefix(3)))
                    }
                } else {
                    TechCoachEmptyCard { createButton }
                }

                if !native.isCoachLoopManaged, native.handshake?.coachLoopContractVersion == 1 {
                    TechCoachLoopSection()
                }
                TechPlanWatchSection(allowsSynchronization: native.isCoachLoopManaged ?
                    native.coachLoop?.settings?.status == "active" : plan?.status == "active")

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
                if let coach = snapshot.coach, !coach.notices.isEmpty {
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
                if !native.isCoachLoopManaged && (plan == nil || plan?.status == "ended") {
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
            TechRunCoachSetup(plan: editing ? plan : nil, editorSessionID: setupSessionID).id(setupID)
        }
        .sheet(isPresented: $showingLock) { TechLockSheet() }
        .sheet(item: $selectedDay) { day in
            NavigationStack {
                TechCoachDaySheet(
                    day: day,
                    isToday: day.localDate == snapshot.today?.today.localDate
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
                    let revision = pendingRevision
                    let sessionID = pendingSessionID
                    pendingAction = nil
                    Task { await native.changeRunCoach(action: action, expectedRevision: revision, editorSessionID: sessionID) }
                }
            }
            Button("取消", role: .cancel) { pendingAction = nil }
        }
        .onChange(of: native.feedbackSessionID) { _, _ in
            showingSetup = false; showingLock = false; pendingAction = nil; selectedDay = nil; selectedExecutableDay = nil
        }
    }

    private func prepareAction(_ action: String) {
        pendingRevision = snapshot.revision; pendingSessionID = native.feedbackSessionID; pendingAction = action
    }

    private var actionTitle: String {
        pendingAction == "end" ? "结束当前教练计划？" : pendingAction == "resume" ? "按当前训练状态继续计划？" : "暂停教练计划？"
    }

    private var todayForCurrentPlan: MobileTodayResponse? { snapshot.today }

    private func todayIsCompleted(_ today: MobileTodayResponse) -> Bool {
        today.today.workoutCount > 0 || today.phase == "post_run"
    }

    @ViewBuilder private var explanation: some View {
        let calibration = snapshot.today.flatMap {
            $0.recommendation.planRevision == native.currentPlanRevision ? $0.calibration : nil
        }
        let budget = snapshot.coach.flatMap {
            $0.revision == native.currentPlanRevision ? $0.weeklyCapacityKm : nil
        }
        // Count stored sessions even when today's session is recorded or needs reconfirmation.
        let scheduled = schedule?.days.filter { $0.kind != "rest" }.count
        let facts = [
            calibration.map(techCoachCalibrationLabel),
            scheduled.map { "未来7日已排 \($0) 次训练" },
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
                setupSessionID = native.feedbackSessionID
                editing = true
                showingSetup = true
            } label: {
                Label("训练偏好", systemImage: "slider.horizontal.3")
            }
            .accessibilityIdentifier("coach.preferences")
            Spacer(minLength: 8)
            Button {
                prepareAction(plan.status == "paused" ? "resume" : "pause")
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
            setupSessionID = native.feedbackSessionID
            editing = false
            showingSetup = true
        }
        .accessibilityIdentifier("coach.create")
    }

    private func upcomingDays(from days: [MobileWeekPlanDay], todayLocalDate: String) -> [MobileWeekPlanDay] {
        days.filter { $0.localDate > todayLocalDate && $0.planned && $0.kind != "rest" }.prefix(3).map { $0 }
    }



}

#endif
