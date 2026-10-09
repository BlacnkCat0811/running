#if os(iOS)
import SwiftUI

struct RaceGoalEditorContext: Identifiable {
    let id = UUID()
    let goals: MobileGoalsResponse
    let editorSessionID: String
}

/// Snapshot the revision when opened: concurrent edits must conflict, not overwrite.
struct TechRaceGoalEditor: View {
    let context: RaceGoalEditorContext
    @Environment(NativeAppModel.self) private var native
    @Environment(\.dismiss) private var dismiss
    @State private var date: Date
    @State private var distance: String
    @State private var pace: String
    @State private var inputMode = "pace"
    @State private var finish = ""
    @State private var saving = false
    @State private var confirmClear = false
    @State private var failure: String?

    init(context: RaceGoalEditorContext) {
        self.context = context
        let target = context.goals.raceTarget
        _date = State(initialValue: target.flatMap { NativeRaceGoalDraft.dateFormatter.date(from: $0.date) } ?? Date())
        _distance = State(initialValue: target?.distance ?? "ten_k")
        _pace = State(initialValue: target?.targetPaceSecondsPerKm.map {
            let seconds = Int($0.rounded())
            return String(format: "%d:%02d", seconds / 60, seconds % 60)
        } ?? "")
    }

    private var stale: Bool { native.goals?.revision != context.goals.revision || context.editorSessionID != native.feedbackSessionID }
    private var resolvedPace: Double? {
        inputMode == "pace" ? NativeRaceGoalDraft.paceSeconds(pace) : NativeRaceGoalDraft.finishSeconds(finish).map { $0 / NativeRaceGoalDraft.kilometers(distance) }
    }
    private var validTarget: Bool {
        if inputMode == "pace" { return NativeRaceGoalDraft.isValidPace(pace) }
        if finish.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        return resolvedPace.map { (150...900).contains($0) } ?? false
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("比赛目标") {
                    DatePicker("比赛日期", selection: $date, displayedComponents: .date)
                    if NativeRaceGoalDraft.dateFormatter.string(from: date) < (native.today?.today.localDate ?? NativeRaceGoalDraft.dateFormatter.string(from: Date())) {
                        Text("所选日期已过。保存只保留历史目标，不代表已经参赛或完赛；如需备赛，请选择未来日期。")
                            .font(.caption).foregroundStyle(TechColor.yellow)
                    }
                    Picker("比赛距离", selection: $distance) {
                        Text("5 公里").tag("five_k")
                        Text("10 公里").tag("ten_k")
                        Text("半程马拉松").tag("half_marathon")
                    }
                    Picker("目标输入方式", selection: $inputMode) {
                        Text("配速").tag("pace")
                        Text("完赛时间").tag("finish")
                    }.pickerStyle(.segmented)
                    if inputMode == "pace" {
                      TextField("目标配速（可选，例如 5:30）", text: $pace)
                        .keyboardType(.numbersAndPunctuation)
                        .accessibilityIdentifier("race-goal-pace")
                    } else {
                        TextField("完赛时间（如 1:45:00 或 50:00）", text: $finish)
                            .keyboardType(.numbersAndPunctuation)
                            .accessibilityIdentifier("race-goal-finish")
                    }
                    if let resolvedPace, validTarget {
                        Text("等价配速 \(nativePace(resolvedPace))/km · 完赛 \(NativeRaceGoalDraft.finishText(pace: resolvedPace, distance: distance))")
                            .font(.footnote)
                    }
                    Text("配速单位：分:秒 / 公里，范围 2:30–15:00。留空表示不设目标配速。")
                        .font(.caption).foregroundStyle(TechColor.muted)
                    if !validTarget {
                        Text("请输入有效配速，例如 5:30（2:30–15:00）。").foregroundStyle(TechColor.coral)
                    }
                }
                .disabled(saving)
                Section {
                    Text("保存后更新比赛倒计时、赛事准备度和减量提示。准备度不是目标成绩达成概率。既有计划保留，执行窗口按比赛约束复核；请查看并重新同步手表。")
                    if stale {
                        Text("目标已在其他页面更新。请关闭后重新打开，避免覆盖新内容。")
                            .foregroundStyle(TechColor.coral)
                    }
                    if let failure { Text(failure).foregroundStyle(TechColor.coral) }
                    if native.isOffline { Text("当前离线，请连接服务后保存。").foregroundStyle(TechColor.coral) }
                }.font(.footnote)
                if context.goals.raceTarget != nil {
                    Section {
                        Button("清除比赛目标", role: .destructive) { confirmClear = true }
                            .disabled(saving || stale || native.isOffline)
                            .accessibilityIdentifier("race-goal-clear")
                    }
                }
            }
            .techFormSurface()
            .navigationTitle("比赛目标")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "保存中…" : "保存") {
                        let target = MobileRaceTarget(
                            date: NativeRaceGoalDraft.dateFormatter.string(from: date),
                            distance: distance,
                            targetPaceSecondsPerKm: resolvedPace
                        )
                        Task { await save(target) }
                    }
                    .disabled(saving || native.isPlanBusy || stale || native.isOffline || !validTarget)
                    .accessibilityIdentifier("race-goal-save")
                }
            }
            .confirmationDialog("清除比赛目标？", isPresented: $confirmClear, titleVisibility: .visible) {
                Button("清除比赛目标", role: .destructive) { Task { await save(nil) } }
                Button("取消", role: .cancel) {}
            } message: {
                Text("仅清除比赛日期、距离和目标配速，保留周计划。准备度将恢复为默认 10 公里参考。")
            }
            .interactiveDismissDisabled(saving)
            .onChange(of: inputMode) { old, new in
                if new == "finish" { finish = NativeRaceGoalDraft.finishText(pace: NativeRaceGoalDraft.paceSeconds(pace), distance: distance) }
                else if old == "finish", let seconds = NativeRaceGoalDraft.finishSeconds(finish) {
                    let value = Int((seconds / NativeRaceGoalDraft.kilometers(distance)).rounded())
                    pace = String(format: "%d:%02d", value / 60, value % 60)
                } else { pace = "" }
            }
        }
    }

    @MainActor private func save(_ target: MobileRaceTarget?) async {
        guard !saving, !stale, !native.isOffline else { return }
        saving = true
        failure = nil
        let success = await native.saveRaceTarget(target, expectedRevision: context.goals.revision, editorSessionID: context.editorSessionID)
        saving = false
        if success { dismiss() }
        else { failure = native.errorMessage ?? "保存未完成，请重试。" }
    }
}
#endif
