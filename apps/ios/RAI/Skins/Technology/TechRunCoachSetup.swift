#if os(iOS)
import SwiftUI

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
