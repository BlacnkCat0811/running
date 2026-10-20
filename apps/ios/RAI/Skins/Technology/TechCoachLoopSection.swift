#if os(iOS)
import SwiftUI

/// Necessary v1 protocol controls, not a second on-device training engine.
struct TechCoachLoopSection: View {
    @Environment(NativeAppModel.self) private var native
    @State private var sheet: Sheet?
    @State private var stopAction: String?
    @State private var stopRevision: Int?
    @State private var stopSession: String?

    /// 上下文决定这里**是不是**训练入口。
    ///
    /// `.summary`（默认）：今日页/托管提示用，只读展示当前模式与今日课，不含创建、
    /// 结束、偏好按钮。`.page`：训练页专用，是唯一可以创建/暂停/结束/改偏好的地方。
    /// 默认值是 `.summary` 是刻意的：任何忘了传上下文的调用点都**不会**悄悄长出
    /// 第二个创建入口。
    enum Context { case page, summary }
    var context: Context = .summary

    private enum Sheet: String, Identifiable {
        case preferences, feedback
        var id: String { rawValue }
    }
    private var disabled: Bool { native.isOffline || native.isPlanBusy || !native.trainingPlanStore.isCurrent }

    var body: some View {
        if let loop = native.coachLoop {
            if context == .summary { summary(loop) } else { detail(loop) }
        }
    }

    /// 摘要上下文（今日页/托管提示）：只展示当前模式与今日课，**不含创建/结束/偏好
    /// 入口**。训练页才是唯一入口 —— 首页再放一份"明确选择模式"按钮，就是 PR5
    /// 要消灭的第二个创建入口。
    @ViewBuilder private func summary(_ loop: CoachLoopResponse) -> some View {
        TechPanel(tint: TechColor.cyan) {
            VStack(alignment: .leading, spacing: 8) {
                Text(loop.settings?.mode == "race_preparation" ? "比赛备赛" : "持续训练")
                    .font(.headline)
                Text(loop.settings?.status == "active" ? "进行中" :
                    loop.settings?.status == "paused" ? "已暂停" :
                    loop.settings == nil ? "尚未配置训练模式" : "已结束")
                    .font(.caption).foregroundStyle(TechColor.muted)
                if native.trainingPlanStore.isCurrent {
                    Text("\(nativeDay(loop.today.day.localDate)) · \(coachLoopTemplateName(loop.days.first?.templateId, kind: loop.today.day.kind))")
                        .font(.subheadline.weight(.semibold))
                    Text(loop.refreshRequired ? "事实已变化，需在训练页刷新后才能下发。" :
                        loop.today.executable ? "今日课已发布。" : "今日无可执行跑课。")
                        .font(.caption).foregroundStyle(TechColor.yellow)
                } else {
                    Text("上次参考安排；请联网后在训练页确认。").font(.caption).foregroundStyle(TechColor.yellow)
                }
                NavigationLink { TechPlanView() } label: {
                    Label("打开训练页", systemImage: "chevron.right")
                        .font(.subheadline.weight(.semibold))
                }
                .accessibilityIdentifier("coach.open-training")
            }
        }
    }

    /// 训练页的完整控制：唯一的创建/暂停/结束/偏好/反馈入口。
    @ViewBuilder private func detail(_ loop: CoachLoopResponse) -> some View {
            TechPanel(tint: TechColor.cyan) {
                VStack(alignment: .leading, spacing: 12) {
                    Text(loop.settings?.mode == "race_preparation" ? "每日自适应 · 比赛备赛" : "每日自适应 · 持续训练")
                        .font(.headline)
                    if let settings = loop.settings {
                        Text(settings.status == "active" ? "进行中" : settings.status == "paused" ? "已暂停" : "已结束")
                        Text("建议 \(nativeNumber(loop.volumePolicy.suggestedWeeklyKm)) km · 实际 \(nativeNumber(loop.volumePolicy.actualWeekKm)) km · 保护上限 \(nativeNumber(loop.volumePolicy.weeklyProtectionKm)) km")
                            .font(.caption).foregroundStyle(TechColor.muted)
                        Text("保护上限是自动处方边界，不代表低于它必然安全。").font(.caption2).foregroundStyle(TechColor.muted)
                        if native.trainingPlanStore.isCurrent {
                            Text("\(nativeDay(loop.today.day.localDate)) · \(coachLoopTemplateName(loop.days.first?.templateId, kind: loop.today.day.kind))")
                                .font(.subheadline.weight(.semibold))
                            Text(loop.today.day.reason ?? "请按当前执行结构训练").font(.caption)
                            Text(loop.refreshRequired ? "事实已变化，需显式刷新；当前不能下发。" :
                                loop.today.executable ? "今日完整课已发布；未来日期只是展望。" : "今日无可执行跑课。")
                                .font(.caption).foregroundStyle(TechColor.yellow)
                            if let structure = loop.today.day.structure {
                                ForEach(nativeStructureLines(structure)) { line in
                                    Text("\(line.title) · \(line.detail)").font(.caption)
                                }
                            }
                        } else {
                            Text("上次参考安排，非当前可执行处方；请联网重新读取。").foregroundStyle(TechColor.yellow)
                        }
                        Text("阶段：\(loop.executionPolicy.phase.map(techCoachPhaseName) ?? "无比赛阶段")")
                            .font(.caption)
                        if loop.executionPolicy.protections.contains(where: \.active) {
                            Text("赛前执行保护生效；不会因追加绕过。").font(.caption).foregroundStyle(TechColor.yellow)
                        }
                        Text("质量课：有观测 \(loop.executionSummary.qualityObserved) · 确认 \(loop.executionSummary.qualityConfirmed) · 已知未满足 \(loop.executionSummary.qualityKnownNotMet) · 未确认 \(loop.executionSummary.qualityUnconfirmed)")
                            .font(.caption).foregroundStyle(TechColor.muted)
                        DisclosureGroup("执行复盘与未来展望") {
                            ForEach(loop.days) { row in
                                Text("\(nativeDay(row.day.localDate)) · \(coachLoopTemplateName(row.templateId, kind: row.day.kind))\(row.day.localDate == loop.today.day.localDate ? "" : "（展望）")")
                                    .font(.caption).frame(maxWidth: .infinity, alignment: .leading)
                            }
                            ForEach(loop.execution) { row in
                                Text("\(nativeDay(row.localDate)) · 剂量 \(row.dose.status) · 刺激 \(row.stimulus.status) · \(row.completion)")
                                    .font(.caption).frame(maxWidth: .infinity, alignment: .leading)
                            }
                            ForEach(loop.reasons.indices, id: \.self) { index in
                                Text(loop.reasons[index].code).font(.caption2).foregroundStyle(TechColor.muted)
                            }
                        }
                        if let gap = loop.goalGap {
                            if gap.status == "available", let seconds = gap.gapSeconds {
                                Text("当前准备情景：参考 \(gap.referenceSeconds.map(techDuration) ?? "--") · 目标 \(gap.targetSeconds.map(techDuration) ?? "--") · 差值 \(seconds > 0 ? "+" : "")\(nativeNumber(seconds, digits: 0)) 秒")
                                    .font(.caption)
                                Text("参考未校准，不是达标概率。").font(.caption2).foregroundStyle(TechColor.muted)
                            } else { Text("目标差距：\(gap.status)").font(.caption).foregroundStyle(TechColor.muted) }
                        }
                        Button("按最新事实刷新训练安排") { Task { await native.changeCoachLoop(action: "refresh") } }.disabled(disabled || settings.status != "active")
                        Button("训练偏好 / 确认当前规则") { sheet = .preferences }.disabled(disabled || settings.status == "ended")
                        Button("训练前感受（可跳过）") { sheet = .feedback }.disabled(disabled)
                        Button(settings.status == "paused" ? "恢复训练" : "暂停训练") {
                            prepareStop(settings.status == "paused" ? "resume" : "pause", loop)
                        }.disabled(disabled || settings.status == "ended")
                        Button("结束当前模式", role: .destructive) { prepareStop("end", loop) }.disabled(disabled || settings.status == "ended")
                        if settings.status == "ended" { Button("创建新的训练模式") { sheet = .preferences }.disabled(disabled) }
                        Button("更新预测摘要（独立命令）") { Task { await native.refreshCoachPrediction() } }.disabled(disabled)
                    } else {
                        // 唯一的创建入口：训练页上的一次配置决定模式（持续训练或比赛备赛），
                        // 不再有"旧教练 / 新教练"两个创建按钮需要用户先选一边。
                        Text("尚未配置训练模式。配置一次即可：有比赛目标时按比赛备赛，否则按持续训练；旧系统排期会先核验／撤回。")
                            .font(.caption).foregroundStyle(TechColor.muted)
                        Button("配置训练模式（持续训练 / 比赛备赛）") { sheet = .preferences }.disabled(disabled)
                    }
                    if let message = native.runCoachError { Text(message).font(.caption).foregroundStyle(TechColor.yellow) }
                    Button("重新读取（不改课）") { Task { await native.refreshPlanState() } }.disabled(native.isPlanBusy)
                    Button("确认上次反馈保存结果") { Task { await native.saveCoachFeedback(retry: true) } }.disabled(disabled)
                }
            }
            .accessibilityIdentifier("coach.loop")
            .sheet(item: $sheet) { item in
                switch item {
                case .preferences: TechCoachLoopPreferencesSheet(initial: loop, sessionID: native.feedbackSessionID)
                case .feedback: TechCoachLoopFeedbackSheet(sessionID: native.feedbackSessionID)
                }
            }
            .confirmationDialog("确认训练模式操作？", isPresented: Binding(get: { stopAction != nil }, set: { if !$0 { stopAction = nil } })) {
                if let action = stopAction {
                    Button("确认", role: action == "end" ? .destructive : nil) {
                        stopAction = nil
                        Task { await native.changeCoachLoop(action: action, expectedRevision: stopRevision, editorSessionID: stopSession) }
                    }
                }
            }
            .onChange(of: native.feedbackSessionID) { _, _ in sheet = nil; stopAction = nil }
    }

    private func prepareStop(_ action: String, _ loop: CoachLoopResponse) {
        stopRevision = loop.revision; stopSession = native.feedbackSessionID; stopAction = action
    }
}

private func coachLoopTemplateName(_ template: String?, kind: String) -> String {
    switch template {
    case "aerobic_endurance": return "有氧耐力"
    case "long_aerobic": return "长有氧 / LSD"
    case "fartlek": return "快慢法特莱克"
    case "threshold": return "阈值训练"
    default: return nativeSessionName(kind)
    }
}

struct TechCoachLoopPreferencesSheet: View {
    @Environment(NativeAppModel.self) private var native
    @Environment(\.dismiss) private var dismiss
    let initial: CoachLoopResponse
    let sessionID: String
    @State private var mode = "daily_adaptive"
    @State private var days = Set([1, 2, 4, 6, 7])
    @State private var longDays = Set([7])
    @State private var targetType = "pace"
    @State private var availability: [String: Int?] = [:]
    @State private var goal = "finish"
    @State private var distance = 10.0
    @State private var raceDate = Date().addingTimeInterval(84 * 86_400)
    @State private var targetMinutes = 60.0
    @State private var accepted = false
    @State private var loaded = false
    private var updating: Bool { initial.settings != nil && initial.settings?.status != "ended" }
    private var valid: Bool {
        accepted && !days.isEmpty && longDays.isSubset(of: days) &&
            (mode == "daily_adaptive" || days.count >= 3 && !longDays.isEmpty) &&
            sessionID == native.feedbackSessionID && initial.revision == native.coachLoop?.revision &&
            initial.policyHash == native.coachLoop?.policyHash
    }
    private var calendar: Calendar {
        var value = Calendar(identifier: .gregorian); value.timeZone = TimeZone(identifier: "Asia/Shanghai")!; return value
    }
    private var raceRange: ClosedRange<Date> {
        let start = calendar.startOfDay(for: Date())
        return calendar.date(byAdding: .day, value: 42, to: start)!...calendar.date(byAdding: .day, value: 364, to: start)!
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("训练模式") {
                    Picker("模式", selection: $mode) {
                        Text("持续训练（无期限）").tag("daily_adaptive")
                        Text("比赛备赛").tag("race_preparation")
                    }.disabled(updating)
                    if mode == "race_preparation" {
                        Picker("目标", selection: $goal) { Text("完赛").tag("finish"); Text("成绩").tag("time") }.disabled(updating)
                        Picker("距离", selection: $distance) {
                            Text("5 km").tag(5.0); Text("10 km").tag(10.0); Text("半马").tag(21.0975)
                        }.disabled(updating)
                        DatePicker("比赛日期", selection: $raceDate, in: updating ? Date.distantPast...Date.distantFuture : raceRange, displayedComponents: .date).disabled(updating)
                        if goal == "time" { TextField("目标分钟", value: $targetMinutes, format: .number).keyboardType(.decimalPad) }
                        Text("新赛事需42–364天；同一时间只运行一个训练模式，模式或赛事变更需先结束当前模式，再在同一页面创建。").font(.caption)
                    }
                }
                Section("可跑日与可用时长") {
                    ForEach(1...7, id: \.self) { day in
                        Toggle("星期\(day)", isOn: Binding(get: { days.contains(day) }, set: {
                            if $0 { days.insert(day) } else { days.remove(day); longDays.remove(day) }
                        }))
                        if days.contains(day) {
                            Toggle("长课偏好日", isOn: Binding(get: { longDays.contains(day) }, set: {
                                if $0 { longDays.insert(day) } else { longDays.remove(day) }
                            }))
                            Toggle("设置可用时长", isOn: Binding(get: { (availability[String(day)] ?? nil) != nil }, set: {
                                availability[String(day)] = $0 ? 60 : nil
                            }))
                            if let minutes = availability[String(day)] ?? nil {
                                Stepper("\(minutes) 分钟", value: Binding(get: { (availability[String(day)] ?? nil) ?? 60 },
                                    set: { availability[String(day)] = $0 }), in: 10...240)
                            }
                        }
                    }
                    Text("10–29分钟不会自动生成短跑课；未设置不表示无限容量。").font(.caption)
                }
                Section("强度目标") {
                    Picker("目标", selection: $targetType) { Text("配速").tag("pace"); Text("心率").tag("heart_rate") }
                }
                Section("明确确认") {
                    Text("规则 \(String(initial.policyHash.prefix(12)))：30分钟整课、独立建议量/保护上限及受控追加。策略未作个人安全保证；选择本配置不等于专业领域审阅。")
                        .font(.caption)
                    Toggle("接受此版本并转换 / 更新", isOn: $accepted)
                    if let error = native.runCoachError { Text(error).foregroundStyle(TechColor.yellow) }
                }
            }
            .navigationTitle("训练模式与偏好")
            .environment(\.timeZone, calendar.timeZone)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("保存") { Task { await save() } }.disabled(!valid || native.isPlanBusy || native.isOffline) }
            }
            .interactiveDismissDisabled(native.isUpdatingRunCoach)
            .onAppear {
                guard !loaded else { return }; loaded = true
                if let settings = initial.settings {
                    mode = settings.mode; days = Set(settings.runningDays); longDays = Set(settings.longRunDays)
                    targetType = settings.targetType; availability = settings.availabilityMinutesByWeekday
                    if let race = settings.race {
                        goal = race.goal; distance = race.raceDistanceKm ?? 10; targetMinutes = (race.targetTimeSeconds ?? 3600) / 60
                        let formatter = DateFormatter(); formatter.timeZone = calendar.timeZone; formatter.dateFormat = "yyyy-MM-dd"
                        if let date = race.raceDate.flatMap(formatter.date(from:)) { raceDate = date }
                    }
                }
            }
        }
    }
    private func save() async {
        guard valid else { return }
        let formatter = DateFormatter(); formatter.calendar = calendar; formatter.timeZone = calendar.timeZone; formatter.dateFormat = "yyyy-MM-dd"
        let race: MobileRunCoachConfig? = mode == "race_preparation" ? .init(goal: goal, raceDate: formatter.string(from: raceDate),
            raceDistanceKm: distance, targetTimeSeconds: goal == "time" ? targetMinutes * 60 : nil,
            runningDays: days.sorted(), longRunDays: longDays.sorted(), targetType: targetType, strengthTraining: false) : nil
        let preferences = CoachLoopPreferences(mode: mode, runningDays: days.sorted(), longRunDays: longDays.sorted(),
            availabilityMinutesByWeekday: availability, targetType: targetType, race: race)
        if await native.changeCoachLoop(action: updating ? "update" : "enable", preferences: preferences,
            acceptedPolicyHash: initial.policyHash, expectedRevision: initial.revision, editorSessionID: sessionID) { dismiss() }
    }
}

struct TechCoachLoopFeedbackSheet: View {
    @Environment(NativeAppModel.self) private var native
    @Environment(\.dismiss) private var dismiss
    let sessionID: String
    var workoutID: String? = nil
    @State private var consent = false
    @State private var fatigue: String?
    @State private var soreness: String?
    @State private var discomfort: String?
    @State private var action: String?
    @State private var interruption: String?
    private var hasFields: Bool { fatigue != nil || soreness != nil || discomfort != nil || action != nil || interruption != nil }
    var body: some View {
        NavigationStack {
            Form {
                Text("全部可跳过，不会生成“正常”记录；不会改变长期能力。训练前状态只在当日有效，训练后原因不作为次日训练前状态。").font(.caption)
                choices("疲劳", $fatigue, [("平常", "usual"), ("增加", "elevated"), ("明显", "high")])
                choices("酸痛", $soreness, [("无", "none"), ("轻微", "mild"), ("明显", "marked")])
                choices("不适", $discomfort, [("无", "none"), ("有", "present")])
                if workoutID == nil {
                    choices("今日偏好", $action, [("无特别要求", "none"), ("仅轻松", "easy_only"), ("休息", "rest")])
                } else {
                    choices("中断原因", $interruption, [("时间", "time_constraint"), ("疲劳", "fatigue"), ("不适", "discomfort"),
                        ("天气", "weather"), ("设备", "equipment"), ("其他", "other")])
                    Text("RPE仍在原训练感受里保存，这里不复制。").font(.caption)
                }
                Toggle("同意保存这次主观感受", isOn: $consent)
                if let loop = native.coachLoop {
                    let latest = Dictionary(grouping: loop.subjectiveFeedback, by: \.id).compactMap { $0.value.max(by: { $0.revision < $1.revision }) }
                    ForEach(latest.filter { $0.retractedAt == nil && $0.localDate == loop.today.day.localDate }) { feedback in
                        Button("撤回 \(nativeDate(feedback.observedAt)) 的记录", role: .destructive) {
                            Task { if await native.saveCoachFeedback(retract: feedback) { dismiss() } }
                        }.disabled(!consent || native.isPlanBusy || sessionID != native.feedbackSessionID)
                    }
                }
                if let error = native.runCoachError { Text(error).foregroundStyle(TechColor.yellow) }
            }
            .navigationTitle(workoutID == nil ? "训练前感受" : "训练后原因")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("跳过") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        Task {
                            let fields = CoachLoopFeedbackCommand.Fields(phase: workoutID == nil ? "pre_run" : "post_run",
                                observedAt: ISO8601DateFormatter().string(from: Date()), workoutId: workoutID,
                                fatigue: fatigue, soreness: soreness, discomfort: discomfort, requestedAction: action,
                                interruptionReason: interruption)
                            if await native.saveCoachFeedback(fields: fields) { dismiss() }
                        }
                    }.disabled(!consent || !hasFields || native.isPlanBusy || native.isOffline || sessionID != native.feedbackSessionID)
                }
            }
        }
    }
    private func choices(_ label: String, _ value: Binding<String?>, _ options: [(String, String)]) -> some View {
        Picker(label, selection: value) {
            Text("跳过").tag(String?.none)
            ForEach(options, id: \.1) { option in Text(option.0).tag(Optional(option.1)) }
        }
    }
}
#endif
