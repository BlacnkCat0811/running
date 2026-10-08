#if os(iOS)
import SwiftUI

struct TechWorkoutFeedbackView: View {
    @Environment(NativeAppModel.self) private var native
    @Environment(\.dismiss) private var dismiss
    let detail: WorkoutDetailResponse
    @State private var input: NativeWorkoutFeedbackInput
    /// 选中的档位代表的 `rpe` 整数；`nil` = 不记录感受（保存时按契约发 null）。
    ///
    /// 这里存的是档位值而不是文本框内容：契约要整数、用户要词，中间的换算只此一处
    /// （`TechEffortScale`），界面不出现"1–10"这个量表概念。
    @State private var effort: Int?
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
        _effort = State(initialValue: detail.override?.rpe.map(Int.init))
        _note = State(initialValue: detail.override?.note ?? "")
    }

    /// 旧数据里那些不是档位的取值（1/3/5/7/9，来自上一版数字输入）。
    /// 只提示、不擅自把它归到最近的档位 —— 那等于在用户没动它的时候偷偷改数。
    private var offScaleStoredEffort: Int? {
        guard let stored = detail.override?.rpe.map(Int.init),
              TechEffortScale.option(for: stored) == nil else { return nil }
        return stored
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("记录感受（均可选）") {
                    Text("这次跑得怎么样？选最接近的一档；不选表示不记录。")
                        .font(.caption).foregroundStyle(TechColor.muted)
                    effortChips
                    if let stored = offScaleStoredEffort {
                        Text("当前记录：\(TechEffortScale.label(for: stored))（RPE \(stored)，不在档位中）。选择任一档位后会按档位保存。")
                            .font(.caption).foregroundStyle(TechColor.muted)
                    }
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
                        .font(.caption).foregroundStyle(TechColor.muted)
                }.disabled(busy || pending || saved)
                if let message { Section { Text(message).accessibilityIdentifier("feedback.result") } }
                if let latest {
                    Section("最新记录（你的输入仍保留）") {
                        Text("训练感受：" + effortText(latest.override?.rpe.map(Int.init)))
                        Text(latest.override?.note ?? "无备注")
                        Text("类型：" + (latest.override?.sessionType.map(nativeSessionName) ?? "自动判断"))
                        Button("放弃当前输入，使用最新记录重新编辑") {
                            input = NativeWorkoutFeedbackInput(detail: latest)
                            effort = input.rpe
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
                        .font(.caption).foregroundStyle(TechColor.muted)
                }
            }
            .techFormSurface()
            .navigationTitle("训练反馈").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() }.disabled(busy) } }
            .interactiveDismissDisabled(busy)
            .onChange(of: native.feedbackSessionID) { _, _ in dismiss() }
            .onAppear {
                guard scope == nil else { return }
                scope = native.feedbackSessionID
                if let prior = native.pendingFeedback(for: detail.workout.id) {
                    input = prior.payload
                    effort = input.rpe
                    note = input.note ?? ""
                    pending = true
                    message = "上次保存结果尚未确认，请检查结果。"
                }
            }
        }
    }

    /// 档位点选。用 `TechFlowLayout` 换行而不是横向滚动：六个选项在最小字号下也放得下，
    /// 放大字号时整体折到下一行，不会有滚出屏幕外看不见的档位。
    private var effortChips: some View {
        TechFlowLayout(spacing: 8) {
            effortChip(label: "未填写", value: nil)
            ForEach(TechEffortScale.options, id: \.value) { option in
                effortChip(label: option.label, value: option.value)
            }
        }
        .padding(.vertical, 4)
    }

    private func effortChip(label: String, value: Int?) -> some View {
        let selected = effort == value
        return Button { effort = value } label: {
            Text(label)
                .font(.subheadline.weight(selected ? .semibold : .regular))
                .lineLimit(1).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(selected ? TechColor.actionInk : TechColor.muted)
                .padding(.horizontal, 14)
                .background {
                    if selected { TechSurfaceShape().fill(TechColor.action) }
                    else { TechSurfaceShape().fill(TechColor.paper) }
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(TechPressStyle())
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// 展示已保存的感受：词在前、原始整数在后。整数是服务端真正读到的值，
    /// 藏起来会让"我明明选了很累，为什么负荷没变"无从核对。
    private func effortText(_ value: Int?) -> String {
        guard let value else { return "未填写" }
        return "\(TechEffortScale.label(for: value))（RPE \(value)）"
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
        guard note.count <= 2000 else { message = "备注最多 2000 个字符。"; return }
        // 不做范围校验：`effort` 的每个来源都已在 1–10 内 —— 界面上的档位代表值（回归测试逐项
        // 断言），以及从服务端读回来的旧值（`workout_overrides.rpe INTEGER CHECK (rpe BETWEEN
        // 1 AND 10)`，`packages/storage-sqlite/src/database.ts:439`；写入侧
        // `packages/application/src/service.ts:149` 也只收 1–10 的整数）。本页已经没有可打字的
        // 入口，范围校验是上一版文本框才需要的东西。
        // 语义注意：`effort` 是"用户这次选了什么"，覆盖记录按契约整体提交，所以旧数据里的 7
        // 或 9 会**原样存回**，不擅自归到最近的档位（同文件 off-scale 提示就是这条语义）。
        input.rpe = effort
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
