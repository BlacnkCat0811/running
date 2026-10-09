#if os(iOS)
import SwiftUI

struct TechCoachRollingUpcomingSection: View {
    let days: [MobileWorkoutPlanDay]
    let preferredTargetType: String
    let onSelect: (MobileWorkoutPlanDay) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TechSectionHeader(title: "接下来训练", trailing: "未来 3 次")
            if days.isEmpty {
                TechPanel { Text("接下来没有已生成的训练").font(.caption).foregroundStyle(TechColor.muted) }
            } else {
                ForEach(days) { day in
                    Button { onSelect(day) } label: {
                        TechCoachRollingUpcomingRow(day: day, preferredTargetType: preferredTargetType)
                    }
                    .buttonStyle(TechPressStyle())
                }
            }
        }
    }
}

struct TechCoachRollingUpcomingRow: View {
    let day: MobileWorkoutPlanDay
    let preferredTargetType: String

    private var target: TechCoachTrainingTarget? {
        techCoachTrainingTarget(for: day, preferredType: preferredTargetType)
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(nativeWeekday(day.localDate)).font(.caption.weight(.semibold))
                Text(nativeDay(day.localDate)).font(.caption2).foregroundStyle(TechColor.muted)
            }
            .frame(width: 48, alignment: .leading)
            TechIconBox(systemName: nativeSessionSymbol(day.kind), tint: techSessionColor(day.kind), fill: techSessionColor(day.kind).opacity(0.12), size: 38)
            VStack(alignment: .leading, spacing: 4) {
                Text(day.title.isEmpty ? nativeSessionName(day.kind) : day.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TechColor.ink)
                HStack(spacing: 10) {
                    if let distance = day.distanceKm {
                        Text(nativeKilometers(distance))
                    }
                    if let duration = day.durationMinutes {
                        Text("\(nativeNumber(duration, digits: 0)) min")
                    }
                    if let target {
                        Text(target.formattedRange)
                    }
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(TechColor.muted)
            }
            if !day.executable { Text("暂不可执行").font(.caption2).foregroundStyle(TechColor.yellow) }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(TechColor.muted)
        }
        .padding(12)
        .background(TechColor.paper, in: TechSurfaceShape())
        .overlay(TechSurfaceShape().stroke(TechColor.grid.opacity(0.6), lineWidth: 1))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(nativeWeekday(day.localDate))\(nativeDay(day.localDate))，\(nativeSessionName(day.kind))，查看训练详情")
    }
}

struct TechCoachUpcomingSection: View {
    let days: [MobileWeekPlanDay]
    let executableDays: [MobileWorkoutPlanDay]
    let preferredTargetType: String
    let onSelect: (MobileWeekPlanDay) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TechSectionHeader(title: "接下来训练", trailing: "未来 3 次")
            if days.isEmpty {
                TechPanel { Text("接下来没有已生成的训练").font(.caption).foregroundStyle(TechColor.muted) }
            } else {
                ForEach(days) { day in
                    Button { onSelect(day) } label: {
                        TechCoachUpcomingRow(
                            day: day,
                            executable: executableDays.first(where: { $0.localDate == day.localDate }),
                            preferredTargetType: preferredTargetType
                        )
                    }
                    .buttonStyle(TechPressStyle())
                }
            }
        }
    }
}

struct TechCoachExecutableDaySheet: View {
    let day: MobileWorkoutPlanDay
    let preferredTargetType: String
    private var lines: [NativeStructureLine] { nativeStructureLines(day.structure) }
    private var target: TechCoachTrainingTarget? {
        techCoachTrainingTarget(for: day, preferredType: preferredTargetType)
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
                    TechBadge(title: "计划中", color: TechColor.cyan, fill: TechColor.mint)
                }
                TechMetricGrid(minimum: 120) {
                    TechMetricTile(title: "距离", value: nativeKilometers(day.distanceKm))
                    if let durationMinutes = day.durationMinutes {
                        TechMetricTile(title: "时长", value: "\(nativeNumber(durationMinutes, digits: 0)) min")
                    }
                    if let target {
                        TechMetricTile(title: target.title, value: target.formattedRange, accent: TechColor.cyan)
                    }
                }
                if lines.isEmpty {
                    TechPanel {
                        Text("这次训练暂未提供结构化步骤。")
                            .font(.footnote)
                            .foregroundStyle(TechColor.muted)
                    }
                } else {
                    TechPanel {
                        VStack(alignment: .leading, spacing: 10) {
                            TechSectionHeader(title: "训练内容", trailing: "\(lines.count) 步")
                            ForEach(lines) { line in
                                TechAdaptiveStack(spacing: 10) {
                                    Text(line.title)
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(TechColor.cyan)
                                        .frame(minWidth: 72, alignment: .leading)
                                    Text(line.detail)
                                        .font(.caption)
                                        .foregroundStyle(TechColor.ink)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                    }
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

struct TechCoachUpcomingRow: View {
    let day: MobileWeekPlanDay
    let executable: MobileWorkoutPlanDay?
    let preferredTargetType: String

    private var target: TechCoachTrainingTarget? {
        if let executable {
            return techCoachTrainingTarget(for: executable, preferredType: preferredTargetType)
        }
        return techCoachTrainingTarget(structure: day.structure)
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(nativeWeekday(day.localDate)).font(.caption.weight(.semibold))
                Text(nativeDay(day.localDate)).font(.caption2).foregroundStyle(TechColor.muted)
            }
            .frame(width: 48, alignment: .leading)
            TechIconBox(systemName: nativeSessionSymbol(day.kind), tint: techSessionColor(day.kind), fill: techSessionColor(day.kind).opacity(0.12), size: 38)
            VStack(alignment: .leading, spacing: 4) {
                Text(day.title.isEmpty ? nativeSessionName(day.kind) : day.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TechColor.ink)
                HStack(spacing: 10) {
                    if let distance = executable?.distanceKm ?? (day.distanceKm > 0 ? day.distanceKm : nil) {
                        Text(nativeKilometers(distance))
                    }
                    if let duration = executable?.durationMinutes {
                        Text("\(nativeNumber(duration, digits: 0)) min")
                    }
                    if let target {
                        Text(target.formattedRange)
                    }
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(TechColor.muted)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(TechColor.muted)
        }
        .padding(12)
        .background(TechColor.paper, in: TechSurfaceShape())
        .overlay(TechSurfaceShape().stroke(TechColor.grid.opacity(0.6), lineWidth: 1))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(nativeWeekday(day.localDate))\(nativeDay(day.localDate))，\(nativeSessionName(day.kind))，查看训练详情")
    }
}

#endif
