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
                    Text("基于计划 v\(preview.revision)。仅确认后保存；不会自动发送到手表。已记录训练及已锁定的今天保持不变。")
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

/// 近七日执行记录。
///
/// 旧版每天铺三行文字 + 最多两个 `NavigationLink`（"查看当天训练"、"检查数据与同步"），
/// 七天摞下来是一屏密集的链接和状态句（2026-10-01 可用性反馈："太乱"）。现在改成**一天一行**：
/// 左侧星期/日期，中间"计划 vs 已导入"，右侧一枚状态胶囊，整行可点、只留一个入口。
///
/// "检查数据与同步"没有丢：它一直就在这一天的详情页里（`TechDayWorkoutsView` 在当天没有
/// 记录时给出该入口）。逐日重复印七遍，只是把同一个链接说了七次。
///
/// 文案仍然只陈述数据："已导入"是"服务端收到了几条记录"，不是"用户完成了没有" ——
/// 未导入不等于未完成，这一点在标题下方明写。
///
/// 右侧胶囊的文案来自 `techPlanExecutionStatusName`，配色来自同一组闭集
/// （`TechPlanExecutionStatus`）。面板里不再留第二份状态文案：有第二份，契约新增取值时
/// 两句里总有一句会说错。
struct TechPlanExecutionPanel: View {
    let days: [MobilePlanExecutionDay]

    var body: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 12) {
                TechSectionHeader(title: "近七日执行记录", trailing: "状态", trailingColor: TechColor.muted)
                Text("仅比较已导入的跑量，不把未导入判为未完成，也不据此评价训练质量。")
                    .font(.caption).foregroundStyle(TechColor.muted)
                VStack(spacing: 0) {
                    ForEach(Array(days.enumerated()), id: \.element.id) { index, day in
                        NavigationLink { TechDayWorkoutsView(localDate: day.localDate) } label: { row(day) }
                            .buttonStyle(TechPressStyle())
                        if index < days.count - 1 {
                            Rectangle().fill(TechColor.grid.opacity(0.5)).frame(height: 1)
                        }
                    }
                }
            }
        }
    }

    private func row(_ day: MobilePlanExecutionDay) -> some View {
        let chip = statusChip(day)
        return HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(nativeWeekday(day.localDate)).font(.caption.weight(.semibold)).foregroundStyle(TechColor.ink)
                Text(nativeDay(day.localDate)).font(.caption2).foregroundStyle(TechColor.muted)
            }
            .frame(minWidth: 54, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text(planLine(day)).font(.footnote.weight(.semibold)).foregroundStyle(TechColor.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text(observedLine(day)).font(.caption).foregroundStyle(TechColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 8) {
                TechBadge(title: chip.label, color: chip.color, fill: chip.fill)
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(TechColor.muted)
            }
        }
        .padding(.vertical, 10)
        .frame(minHeight: 56)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(nativeWeekday(day.localDate))\(nativeDay(day.localDate))，\(planLine(day))，\(observedLine(day))，\(chip.label)，查看当天训练")
    }

    /// 计划侧：训练类型 + 计划跑量。没有计划快照时直说，不拿 0 km 冒充一次计划。
    private func planLine(_ day: MobilePlanExecutionDay) -> String {
        guard let kind = day.plannedKind else { return "无计划快照" }
        let name = nativeSessionName(kind)
        guard let distance = day.plannedDistanceKm, distance > 0 else { return name }
        return "\(name) · 计划 \(nativeKilometers(distance))"
    }

    /// 观测侧：服务端收到的记录。0 条必须说成"尚未导入"，不能说成 0 公里。
    private func observedLine(_ day: MobilePlanExecutionDay) -> String {
        guard day.observedWorkoutCount > 0 else { return "尚未导入训练" }
        return "已导入 \(nativeKilometers(day.observedDistanceKm)) · \(day.observedWorkoutCount) 次"
    }

    /// 状态胶囊：**文案与配色一起决定**，避免"文案说 A、颜色说 B"。
    ///
    /// 文案只从 `techPlanExecutionStatusName` 来（闭集与文案都在 `TechEnumPresentation.swift`，
    /// 闸门逐值对账）；配色开在 `TechPlanExecutionStatus` 上且**没有 `default`** —— 枚举少一个
    /// 取值时这里编译不过，而不是掉进一句"自信的错话"。
    ///
    /// 域外取值（契约新增、本端枚举还没跟上）走 `?? .unknown`：文案已经说了"未知状态"，
    /// 配色就复用 unknown 那一档，不替它表态，也不新增第二条兜底路径 —— 想画成"成功"
    /// 就必须真的是 `.observed`，而那要求契约真的发了 `observed`。
    private func statusChip(_ day: MobilePlanExecutionDay) -> (label: String, color: Color, fill: Color) {
        let label = techPlanExecutionStatusName(day.status)
        switch TechPlanExecutionStatus(rawValue: day.status) ?? .unknown {
        case .observed: return (label, TechColor.success, TechColor.mint)
        case .pending: return (label, TechColor.muted, TechColor.elevated)
        case .unknown: return (label, TechColor.yellow, TechColor.paleYellow)
        }
    }
}

struct TechExecutablePlanDay: View {
    let day: MobileWorkoutPlanDay
    /// The server's code for a selected running day this week did not pay for. Nil when the day
    /// needs no explanation (it is not a running day, or it carries a session).
    var unplanned: String?
    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 6) {
                Text(day.executable ? "可同步" : "不下发：休息、未生成、已记录训练或待重新确认")
                if let unplanned { Text(unplanned) }
                if !day.reason.isEmpty { Text(day.reason) }
                Text("来源：\(NativeAppModel.planSourceName(day.source))")
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
