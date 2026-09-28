#if os(iOS)
import SwiftUI

struct TechWorkoutFeedbackView: View {
    @Environment(NativeAppModel.self) private var native
    @Environment(\.dismiss) private var dismiss
    let detail: WorkoutDetailResponse
    @State private var input: NativeWorkoutFeedbackInput
    @State private var rpeText: String
    @State private var note: String
    @State private var busy = false
    @State private var pending = false
    @State private var saved = false
    @State private var message: String?
    @State private var scope: String?
    @State private var latest: WorkoutDetailResponse?

    init(detail: WorkoutDetailResponse) {
        self.detail = detail
        _input = State(initialValue: NativeWorkoutFeedbackInput(detail: detail))
        _rpeText = State(initialValue: detail.override?.rpe.map { String(Int($0)) } ?? "")
        _note = State(initialValue: detail.override?.note ?? "")
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("记录感受（均可选）") {
                    TextField("RPE 1–10，留空可清除", text: $rpeText).keyboardType(.numberPad)
                    Text("1 表示非常轻松，10 表示极其吃力。未填写不代表训练不好。")
                        .font(.caption).foregroundStyle(.secondary)
                    TextField("备注", text: $note, axis: .vertical).lineLimit(3...6)
                }.disabled(busy || pending || saved)
                Section("纠正训练") {
                    Picker("训练类型", selection: $input.sessionType) {
                        Text("自动判断").tag(String?.none)
                        ForEach(["easy", "steady", "tempo", "interval", "long_run", "race", "recovery", "unknown"], id: \.self) {
                            Text(nativeSessionName($0)).tag(Optional($0))
                        }
                    }
                    participationPicker("模型评估", selection: $input.eligibilityOverride)
                    participationPicker("跑量与负荷统计", selection: $input.statisticsParticipation)
                    Text("两项互相独立，不删除 Apple 健康原始记录。选择自动判断可撤销覆盖。")
                        .font(.caption).foregroundStyle(.secondary)
                }.disabled(busy || pending || saved)
                if let message { Section { Text(message).accessibilityIdentifier("feedback.result") } }
                if let latest {
                    Section("最新记录（你的输入仍保留）") {
                        Text("RPE：\(latest.override?.rpe.map { String(Int($0)) } ?? "未填写")")
                        Text(latest.override?.note ?? "无备注")
                        Text("类型：" + (latest.override?.sessionType.map(nativeSessionName) ?? "自动判断"))
                        Button("放弃当前输入，使用最新记录重新编辑") {
                            input = NativeWorkoutFeedbackInput(detail: latest)
                            rpeText = input.rpe.map(String.init) ?? ""
                            note = input.note ?? ""
                            self.latest = nil
                            message = "已载入最新记录，请重新填写后保存。"
                        }
                    }
                }
                Section {
                    if !saved {
                        Button(busy ? "正在保存…" : pending ? "检查保存结果" : "保存反馈") { Task { await save() } }
                            .disabled(busy || scope != native.feedbackSessionID)
                        if !pending {
                            Button("查看最新记录（保留输入）") {
                                Task {
                                    await native.loadWorkout(id: detail.workout.id)
                                    guard scope == native.feedbackSessionID else { return }
                                    latest = native.selectedWorkout?.workout.id == detail.workout.id ? native.selectedWorkout : nil
                                }
                            }.disabled(busy)
                        }
                    }
                    Text("反馈不保证改变下一次建议；备注不会自动变成训练指令。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("训练反馈").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() }.disabled(busy) } }
            .interactiveDismissDisabled(busy)
            .onChange(of: native.feedbackSessionID) { _, _ in dismiss() }
            .onAppear {
                guard scope == nil else { return }
                scope = native.feedbackSessionID
                if let prior = native.pendingFeedback(for: detail.workout.id) {
                    input = prior.payload
                    rpeText = input.rpe.map(String.init) ?? ""
                    note = input.note ?? ""
                    pending = true
                    message = "上次保存结果尚未确认，请检查结果。"
                }
            }
        }
    }
    private func participationPicker(_ title: String, selection: Binding<String?>) -> some View {
        Picker(title, selection: selection) {
            Text("自动 / 默认").tag(String?.none)
            Text("纳入").tag(Optional("include"))
            Text("排除").tag(Optional("exclude"))
        }
    }
    private func save() async {
        guard scope == native.feedbackSessionID else { return }
        let value = rpeText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.isEmpty && (Int(value) == nil || !(1...10).contains(Int(value) ?? 0)) {
            message = "RPE 请输入 1–10 的整数，或留空。"; return
        }
        guard note.count <= 2000 else { message = "备注最多 2000 个字符。"; return }
        input.rpe = Int(value)
        input.note = note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : note
        busy = true
        defer { busy = false }
        let outcome = await native.saveFeedback(input)
        guard scope == native.feedbackSessionID else { return }
        switch outcome {
        case .saved(let text): saved = true; pending = false; message = text
        case .pending(let text): pending = native.pendingFeedback(for: detail.workout.id) != nil; message = text
        case .failed(let text): pending = false; message = text
        }
    }
}
#endif
