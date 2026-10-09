#if os(iOS)
import SwiftUI

struct TechCoachDaySheet: View {
    let day: MobileWeekPlanDay
    let isToday: Bool

    private var lines: [NativeStructureLine] { nativeStructureLines(day.structure) }
    private var isCompleted: Bool { techCoachDayIsCompleted(day) }
    private var status: String {
        if isCompleted { return "已记录" }
        if day.kind == "rest" { return "休息" }
        return isToday ? "今日" : "计划中"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    TechIconBox(systemName: nativeSessionSymbol(day.kind), tint: techSessionColor(day.kind), fill: techSessionColor(day.kind).opacity(0.12), size: 46)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(nativeWeekday(day.localDate)) · \(nativeDay(day.localDate))")
                            .font(.title3.weight(.semibold))
                        Text(day.title.isEmpty ? nativeSessionName(day.kind) : day.title)
                            .font(.subheadline)
                            .foregroundStyle(TechColor.muted)
                    }
                    Spacer(minLength: 0)
                    TechBadge(title: status, color: isCompleted ? TechColor.success : TechColor.cyan, fill: isCompleted ? TechColor.mint : TechColor.paleCyan)
                }
                TechMetricGrid(minimum: 120) {
                    TechMetricTile(title: "距离", value: day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : "—")
                    TechMetricTile(title: "训练状态", value: status, accent: isCompleted ? TechColor.success : TechColor.cyan)
                }
                if lines.isEmpty {
                    TechPanel {
                        Text(isCompleted ? "这一天已有训练记录。" : day.kind == "rest" ? "这一天没有训练安排。" : "这一天暂未提供结构化训练步骤。")
                            .font(.footnote)
                            .foregroundStyle(TechColor.muted)
                    }
                } else {
                    TechPanel {
                        VStack(alignment: .leading, spacing: 10) {
                            TechSectionHeader(title: "训练内容", trailing: "\(lines.count) 步")
                            ForEach(lines) { line in
                                TechAdaptiveStack(spacing: 10) {
                                    Text(line.title).font(.caption.weight(.semibold)).foregroundStyle(TechColor.cyan).frame(minWidth: 72, alignment: .leading)
                                    Text(line.detail).font(.caption).foregroundStyle(TechColor.ink).frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                    }
                }
                if let workoutId = day.completedWorkoutId {
                    NavigationLink("查看已记录训练") { TechWorkoutDetailView(workoutId: workoutId) }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(TechColor.cyan)
                }
            }
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.vertical, TechMetrics.pageVertical)
        }
        .background(TechColor.background)
        .foregroundStyle(TechColor.ink)
        .navigationTitle("训练详情")
        .navigationBarTitleDisplayMode(.inline)
    }
}


#endif
