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

    private var plan: MobileRunCoachPlan? {
        if let coach = native.runCoach, coach.revision == native.currentPlanRevision { return coach.plan }
        guard native.goals?.revision == native.currentPlanRevision else { return nil }
        return native.goals?.runCoach
    }
    private var controlsUnavailable: Bool { native.isOffline || native.isPlanBusy || native.goals?.revision != native.currentPlanRevision }
    private var schedule: MobileWorkoutPlanResponse? {
        guard let value = native.workoutPlan, value.planRevision == native.currentPlanRevision else { return nil }
        return value
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                if let plan {
                    overview(plan)
                    if let phases = native.runCoach?.phases, !phases.isEmpty {
                        DisclosureGroup("计划阶段") {
                            ForEach(phases) { phase in
                                HStack(alignment: .top, spacing: 12) {
                                    Image(systemName: phase.current ? "circle.inset.filled" : "circle").foregroundStyle(phase.current ? TechColor.green : TechColor.muted)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(phaseName(phase.phase)).font(.subheadline.weight(.semibold))
                                        Text("\(nativeDay(phase.startsOn)) – \(nativeDay(phase.endsOn))").font(.caption).foregroundStyle(TechColor.muted)
                                    }
                                }.padding(.vertical, 7)
                            }
                        }
                    }
                    if plan.status != "ended" {
                        HStack {
                            Button { setupID = UUID(); editing = true; showingSetup = true } label: { Label("训练偏好", systemImage: "slider.horizontal.3") }
                                .accessibilityIdentifier("coach.preferences")
                            Spacer()
                            Button { pendingAction = plan.status == "paused" ? "resume" : "pause" } label: {
                                Label(plan.status == "paused" ? "继续计划" : "暂停计划", systemImage: plan.status == "paused" ? "play.fill" : "pause.fill")
                            }.accessibilityIdentifier("coach.pause-resume")
                        }.font(.subheadline.weight(.semibold))
                        .disabled(controlsUnavailable)
                        if let today = native.today, today.recommendation.planRevision == native.currentPlanRevision,
                           (native.isTodayAvailable || native.isOffline), plan.status == "active" {
                            TechPanel {
                                TechSectionHeader(title: "今日训练")
                                Text(today.nextSession.title).font(.title3.bold())
                                Text(today.nextSession.reason).font(.footnote).foregroundStyle(TechColor.muted)
                                if today.nextSession.kind != "rest" {
                                    HStack {
                                        if let km = today.nextSession.distanceKm { Text(nativeKilometers(km)) }
                                        if let minutes = today.nextSession.durationMinutes { Text("\(Int(minutes.rounded())) 分钟") }
                                    }.font(.headline.monospacedDigit())
                                    Button { showingLock = true } label: { Label(today.lock.relockSuggested ? "重新确认今日训练" : "确认今日训练", systemImage: "checkmark.circle") }
                                        .disabled(!native.canConfirmToday || native.isOffline || native.isPlanBusy)
                                }
                            }
                        }
                        calendar
                        strength
                        watch
                        if let execution = native.today?.recentPlanExecution, !execution.isEmpty {
                            TechPlanExecutionPanel(days: execution)
                        }
                        Button(role: .destructive) { pendingAction = "end" } label: { Label("结束计划", systemImage: "stop.circle") }
                            .disabled(controlsUnavailable)
                            .accessibilityIdentifier("coach.end")
                    } else {
                        createButton
                        watch
                    }
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        Image(systemName: "figure.run.circle.fill").font(.system(size: 48)).foregroundStyle(TechColor.green)
                        Text("你的跑步教练").font(.title2.bold())
                        Text("改善体能 · 顺利完赛 · 目标时间").font(.subheadline).foregroundStyle(TechColor.muted)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 12)
                    createButton
                }
                if native.isLoadingRunCoach { ProgressView("正在更新训练安排") }
                if let message = native.runCoachError {
                    Text(message).font(.footnote).foregroundStyle(TechColor.coral)
                    Button { Task { await native.refreshRunCoach() } } label: { Label("重试", systemImage: "arrow.clockwise") }
                }
                if let coach = native.runCoach {
                    ForEach(coach.notices, id: \.self) { Text($0).font(.footnote).foregroundStyle(TechColor.muted) }
                }
                if let recent = native.today?.recentWorkouts, plan != nil, !recent.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        TechSectionHeader(title: "训练记录与反馈")
                        ForEach(Array(recent.prefix(3))) { workout in
                            NavigationLink { TechWorkoutDetailView(workoutId: workout.id) } label: {
                                Label(nativeDate(workout.startedAt), systemImage: "figure.run")
                            }
                        }
                    }
                }
                if native.isOffline { Label("离线缓存", systemImage: "wifi.slash").font(.footnote).foregroundStyle(TechColor.yellow) }
                if plan == nil || plan?.status == "ended" {
                    NavigationLink { TechManualPlanView() } label: { Label("手动课表", systemImage: "calendar.badge.clock") }
                }
            }
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.top, TechMetrics.pageVertical)
            .padding(.bottom, TechMetrics.bottomClearance)
        }
        .background(TechColor.background).foregroundStyle(TechColor.ink)
        .techNavigation("跑步教练")
        .task { await native.refreshRunCoach() }
        .refreshable { await native.refreshAll() }
        .sheet(isPresented: $showingSetup) { TechRunCoachSetup(plan: editing ? plan : nil).id(setupID) }
        .sheet(isPresented: $showingLock) { TechLockSheet() }
        .confirmationDialog(actionTitle, isPresented: Binding(get: { pendingAction != nil }, set: { if !$0 { pendingAction = nil } }), titleVisibility: .visible) {
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

    private var createButton: some View {
        TechPrimaryButton(title: "创建教练计划", systemName: "plus", isDisabled: controlsUnavailable || native.goals == nil) {
            setupID = UUID(); editing = false; showingSetup = true
        }.accessibilityIdentifier("coach.create")
    }

    private func overview(_ plan: MobileRunCoachPlan) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(plan.goal == "fitness" ? "改善跑步体能" : "\(nativeKilometers(plan.raceDistanceKm)) 训练计划").font(.title2.bold())
                Spacer()
                Text(plan.status == "paused" ? "已暂停" : plan.status == "ended" ? "已结束" : "进行中")
                    .font(.caption.bold()).foregroundStyle(plan.status == "active" ? TechColor.green : TechColor.muted)
            }
            if let date = plan.raceDate {
                HStack {
                    Text(nativeDate(date))
                    Spacer()
                    if let days = native.runCoach?.daysToRace { Text("距比赛 \(days) 天") }
                }.font(.subheadline.monospacedDigit())
            }
            if let seconds = plan.targetTimeSeconds { Text("目标 \(nativeDuration(seconds))").font(.headline.monospacedDigit()) }
            HStack {
                Text("第 \((native.runCoach?.elapsedWeeks ?? 0) + 1) 周")
                Text(phaseName(native.runCoach?.phase))
                Spacer()
                Text(plan.targetType == "heart_rate" ? "心率目标" : "配速目标")
            }.font(.caption).foregroundStyle(TechColor.muted)
            Text("跑步日：\(plan.runningDays.map(weekdayName).joined(separator: "、"))")
                .font(.caption).foregroundStyle(TechColor.muted)
            if let adapted = plan.adaptedAt { Text("最近调整 \(nativeDate(adapted))").font(.caption2).foregroundStyle(TechColor.muted) }
        }.accessibilityIdentifier("coach.overview")
    }

    private var calendar: some View {
        VStack(alignment: .leading, spacing: 10) {
            TechSectionHeader(title: "未来七日")
            if let schedule {
                ForEach(schedule.days) { day in
                    TechExecutablePlanDay(day: day)
                    if let completed = native.today?.weekPlan.first(where: { $0.localDate == day.localDate })?.completedWorkoutId {
                        NavigationLink { TechWorkoutDetailView(workoutId: completed) } label: { Label("训练记录与反馈", systemImage: "bubble.left.and.text.bubble.right") }
                            .font(.caption)
                    }
                    Divider()
                }
            } else { Text("训练安排尚未刷新。").font(.footnote).foregroundStyle(TechColor.muted) }
        }
    }

    @ViewBuilder private var strength: some View {
        if let sessions = native.runCoach?.strength, !sessions.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                TechSectionHeader(title: "补充力量训练")
                ForEach(sessions) { session in
                    DisclosureGroup("\(nativeDate(session.localDate)) · \(session.durationMinutes) 分钟") {
                        ForEach(session.exercises.indices, id: \.self) { index in
                            HStack { Text(session.exercises[index].name); Spacer(); Text(session.exercises[index].dose).foregroundStyle(TechColor.muted) }
                                .font(.subheadline).padding(.vertical, 5)
                        }
                    }
                }
            }
        }
    }

    private var watch: some View {
        VStack(alignment: .leading, spacing: 10) {
            TechPrimaryButton(title: plan?.status == "active" ? "同步跑步课表到手表" : "撤回手表课表", systemName: "applewatch", isBusy: native.isSyncingPlan,
                              isDisabled: schedule == nil || controlsUnavailable) {
                Task { await syncWatch() }
            }
            if native.watchNeedsUpdate { Text("手表课表需要更新").font(.caption).foregroundStyle(TechColor.coral) }
            if let watchMessage { Text(watchMessage).font(.footnote).foregroundStyle(TechColor.muted) }
        }
    }

    @MainActor private func syncWatch() async {
        guard let id = native.beginPlanSync() else { return }
        defer { native.endPlanSync(id) }
        guard await native.refreshWorkoutPlan(), native.isCurrentPlanSync(id), let schedule = native.workoutPlan else {
            watchMessage = "课表未刷新，原手表排期未修改。"; return
        }
        let outcome = await WorkoutKitBridge.syncRequestingAuthorization(plan: schedule, completedLocalDates: native.completedWeekDates,
            isCurrent: { native.isCurrentPlanSync(id) })
        guard native.isCurrentPlanSync(id) else { return }
        watchMessage = outcome.report
        if outcome.authorized && outcome.verified {
            native.recordWatchAcknowledgement(plan: schedule)
            if let error = await native.recordPlanSync(schedule, localDates: outcome.scheduledLocalDates) {
                watchMessage = outcome.report + "\n" + error
            }
        }
    }

    private func phaseName(_ value: String?) -> String {
        switch value { case "base": "基础期"; case "build": "专项期"; case "peak": "强化期"; case "taper": "减量期"; case "race_week": "比赛周"; case "past": "赛后恢复"; default: "持续训练" }
    }
    private func weekdayName(_ day: Int) -> String { ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"][min(7, max(1, day))] }
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
                        if distance == -1 { TextField("距离（km）", text: $customDistance).keyboardType(.decimalPad).disabled(plan != nil) }
                        DatePicker("比赛日期", selection: $raceDate, in: plan == nil ? Date().addingTimeInterval(42 * 86_400)...Date().addingTimeInterval(364 * 86_400) : Date.distantPast...Date.distantFuture, displayedComponents: .date)
                            .disabled(plan != nil)
                        if goal == "time" {
                            HStack { Text("目标时间（分钟）"); TextField("分钟", value: $targetMinutes, format: .number).keyboardType(.decimalPad).multilineTextAlignment(.trailing) }
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
            .navigationTitle(plan == nil ? "创建教练计划" : "训练偏好")
            .navigationBarTitleDisplayMode(.inline)
            .environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!)
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
                parser.timeZone = TimeZone(identifier: "Asia/Shanghai"); parser.dateFormat = "yyyy-MM-dd"
                if let date = parser.date(from: value) { raceDate = date }
            }
            if let seconds = plan.targetTimeSeconds { targetMinutes = seconds / 60 }
        }
    }
    @MainActor private func save() async {
        let date = DateFormatter(); date.calendar = Calendar(identifier: .gregorian); date.timeZone = TimeZone(identifier: "Asia/Shanghai"); date.dateFormat = "yyyy-MM-dd"
        let config = MobileRunCoachConfig(goal: goal, raceDate: goal == "fitness" ? nil : date.string(from: raceDate),
            raceDistanceKm: goal == "fitness" ? nil : km, targetTimeSeconds: goal == "time" ? targetMinutes * 60 : nil,
            runningDays: runningDays.sorted(), longRunDays: longRunDays.sorted(), targetType: targetType, strengthTraining: strengthTraining, durationWeeks: durationWeeks)
        if await native.changeRunCoach(action: plan == nil ? "start" : "update", config: config, expectedRevision: baseRevision) { dismiss() }
    }
}
#endif
