#if os(iOS)
import SwiftUI

struct TechPlanPreviewSheet: View {
    let preview: MobileWeeklyPlanPreview
    @Environment(NativeAppModel.self) private var native
    @Environment(\.dismiss) private var dismiss
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            List {
                Section("未来七日 · \(preview.windowStart)–\(preview.windowEnd)") {
                    Text("基于计划 v\(preview.revision)。仅确认后保存；不会自动发送到手表。已完成及已锁定的今天保持不变。")
                    Text("替换日期：" + (preview.replacedDates.isEmpty ? "无既有处方被替换" : preview.replacedDates.joined(separator: "、")))
                        .font(.footnote)
                    Text("预览有效至 \(nativeDate(preview.expiresAt))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("候选课表") {
                    ForEach(preview.days, id: \.localDate) { day in
                        VStack(alignment: .leading, spacing: 6) {
                            if let previous = preview.previousDays?.first(where: { $0.localDate == day.localDate }) {
                                Text("原计划：\(nativeSessionName(previous.kind)) · \(nativeKilometers(previous.distanceKm))")
                                    .font(.caption).foregroundStyle(.secondary)
                            } else {
                                Text("原计划：未安排").font(.caption).foregroundStyle(.secondary)
                            }
                            Text("\(day.localDate) · \(nativeSessionName(day.kind)) · \(nativeKilometers(day.distanceKm))")
                            if let reason = day.reason { Text(reason).font(.caption).foregroundStyle(.secondary) }
                            ForEach(nativeStructureLines(day.structure)) { line in
                                Text("\(line.title)：\(line.detail)").font(.caption)
                            }
                        }
                    }
                }
                if !preview.warnings.isEmpty {
                    Section("调整说明") {
                        ForEach(Array(preview.warnings.enumerated()), id: \.offset) { _, warning in Text(warning).font(.footnote) }
                    }
                }
                if preview.revision != native.goals?.revision {
                    Text("目标版本已改变，请取消并重新生成预览。").foregroundStyle(.red)
                }
                if let failure { Text(failure).foregroundStyle(.red) }
            }
            .navigationTitle("确认新课表")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(native.isRegeneratingPlan) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(native.isRegeneratingPlan ? "保存中…" : "确认替换") {
                        Task {
                            if await native.confirmPlanPreview(preview) { dismiss() }
                            else { failure = native.planMessage ?? "未能保存，请刷新后重试。" }
                        }
                    }.disabled(native.isPlanBusy || native.isOffline || preview.revision != native.goals?.revision)
                }
            }
            .interactiveDismissDisabled(native.isRegeneratingPlan)
        }
    }
}

struct TechPlanExecutionPanel: View {
    let days: [MobilePlanExecutionDay]
    var body: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 10) {
                TechSectionHeader(title: "近七日执行记录")
                Text("仅比较已导入的跑量，不把未导入判为未完成，也不据此评价训练质量。")
                    .font(.caption).foregroundStyle(TechColor.muted)
                ForEach(days) { day in
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(nativeDay(day.localDate)) · \(day.plannedKind.map(nativeSessionName) ?? "无计划快照")")
                            .font(.footnote.weight(.semibold))
                        Text("计划 \(nativeKilometers(day.plannedDistanceKm)) · 已导入 \(nativeKilometers(day.observedDistanceKm)) · \(day.observedWorkoutCount) 次")
                            .font(.caption)
                        Text(day.status == "observed" ? "已观测" : day.status == "pending" ? "等待训练数据，暂不判断" : "缺少计划快照，无法比较")
                            .font(.caption).foregroundStyle(TechColor.muted)
                    }
                }
            }
        }
    }
}

struct TechExecutablePlanDay: View {
    let day: MobileWorkoutPlanDay
    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 6) {
                Text(day.executable ? "可同步" : "不下发：休息、未生成、已完成或待重新确认")
                if !day.reason.isEmpty { Text(day.reason) }
                Text("来源：\(day.source == "llm" ? "模型生成并经规则复核" : "规则模板 / 手工计划")")
                ForEach(nativeStructureLines(day.structure)) { line in
                    Text("\(line.title)：\(line.detail)")
                }
            }.font(.caption).foregroundStyle(TechColor.muted)
        } label: {
            Text("\(day.localDate) · \(day.title) · \(nativeKilometers(day.distanceKm))")
                .font(.footnote).foregroundStyle(TechColor.ink)
        }
    }
}
#endif
