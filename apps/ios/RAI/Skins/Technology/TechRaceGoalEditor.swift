#if os(iOS)
import SwiftUI

struct RaceGoalEditorContext: Identifiable {
    let id = UUID()
    let goals: MobileGoalsResponse
}

/// Snapshot the revision when opened: concurrent edits must conflict, not overwrite.
struct TechRaceGoalEditor: View {
    let context: RaceGoalEditorContext
    @Environment(NativeAppModel.self) private var native
    @Environment(\.dismiss) private var dismiss
    @State private var date: Date
    @State private var distance: String
    @State private var pace: String
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

    private var stale: Bool { native.goals?.revision != context.goals.revision }

    var body: some View {
        NavigationStack {
            Form {
                Section("比赛目标") {
                    DatePicker("比赛日期", selection: $date, displayedComponents: .date)
                    Picker("比赛距离", selection: $distance) {
                        Text("5 公里").tag("five_k")
                        Text("10 公里").tag("ten_k")
                        Text("半程马拉松").tag("half_marathon")
                    }
                    TextField("目标配速（可选，例如 5:30）", text: $pace)
                        .keyboardType(.numbersAndPunctuation)
                        .accessibilityIdentifier("race-goal-pace")
                    Text("配速单位：分:秒 / 公里，范围 2:30–15:00。留空表示不设目标配速。")
                        .font(.caption).foregroundStyle(.secondary)
                    if !NativeRaceGoalDraft.isValidPace(pace) {
                        Text("请输入有效配速，例如 5:30（2:30–15:00）。").foregroundStyle(.red)
                    }
                }
                .disabled(saving)
                Section {
                    Text("保存后更新首页的比赛倒计时、赛事准备度和减量提示。赛事准备度不是体型评分，也不是目标成绩达成概率。已有周计划不会自动重排。")
                    if stale {
                        Text("目标已在其他页面更新。请关闭后重新打开，避免覆盖新内容。")
                            .foregroundStyle(.red)
                    }
                    if let failure { Text(failure).foregroundStyle(.red) }
                    if native.isOffline { Text("当前离线，请连接服务后保存。").foregroundStyle(.red) }
                }.font(.footnote)
                if context.goals.raceTarget != nil {
                    Section {
                        Button("清除比赛目标", role: .destructive) { confirmClear = true }
                            .disabled(saving || stale || native.isOffline)
                            .accessibilityIdentifier("race-goal-clear")
                    }
                }
            }
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
                            targetPaceSecondsPerKm: NativeRaceGoalDraft.paceSeconds(pace)
                        )
                        Task { await save(target) }
                    }
                    .disabled(saving || stale || native.isOffline || !NativeRaceGoalDraft.isValidPace(pace))
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
        }
    }

    @MainActor private func save(_ target: MobileRaceTarget?) async {
        guard !saving, !stale, !native.isOffline else { return }
        saving = true
        failure = nil
        let success = await native.saveRaceTarget(target, expectedRevision: context.goals.revision)
        saving = false
        if success { dismiss() }
        else { failure = native.errorMessage ?? "保存未完成，请重试。" }
    }
}
#endif
