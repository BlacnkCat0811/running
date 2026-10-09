#if os(iOS)
import SwiftUI

struct TechCoachWeekProgressCard: View {
    let days: [MobileWeekPlanDay]
    let adherence: MobileAdherenceWeek?
    let periodization: MobilePeriodizationWeek?
    let weeklyBudgetLabel: String?

    private var progress: TechCoachWeekProgress { TechCoachWeekProgress(days: days, adherence: adherence) }

    var body: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 12) {
                TechSectionHeader(title: "本周进度", trailing: "\(progress.completedCount)/\(progress.plannedCount) 次", trailingColor: TechColor.cyan)
                HStack(alignment: .center, spacing: 16) {
                    TechRingProgress(
                        fraction: progress.fraction,
                        value: adherence?.plannedDistanceKm != nil
                            ? nativeNumber(adherence?.observedDistanceKm, digits: 0)
                            : "\(progress.completedCount)",
                        label: adherence?.plannedDistanceKm != nil ? "已完成 km" : "已完成",
                        tint: TechColor.cyan
                    )
                    VStack(alignment: .leading, spacing: 10) {
                        if let adherence, let planned = adherence.plannedDistanceKm {
                            TechCoachProgressStat(title: "跑量", value: "\(nativeKilometers(adherence.observedDistanceKm)) / \(nativeKilometers(planned))")
                        } else {
                            TechCoachProgressStat(title: "训练", value: "已完成 \(progress.completedCount) 次")
                            TechCoachProgressStat(title: "未记录", value: "\(progress.unrecordedCount) 次")
                        }
                        if progress.unknownCount > 0 {
                            TechBadge(title: "\(progress.unknownCount) 天待同步", color: TechColor.yellow, fill: TechColor.paleYellow)
                        }
                        if let periodization {
                            TechCoachProgressStat(title: techCoachPhaseName(periodization.phase), value: "\(nativeNumber(periodization.volumeBandKm.lower, digits: 0))–\(nativeNumber(periodization.volumeBandKm.upper, digits: 0)) km")
                        }
                        if let weeklyBudgetLabel {
                            TechBadge(title: weeklyBudgetLabel, color: TechColor.cyan, fill: TechColor.mint)
                        }
                    }
                    Spacer(minLength: 0)
                }
                TechProgressBar(fraction: progress.fraction, tint: TechColor.cyan, height: 8)
            }
        }
    }
}

struct TechCoachProgressStat: View {
    let title: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title).font(.caption).foregroundStyle(TechColor.muted)
            Text(value).font(.subheadline.weight(.semibold).monospacedDigit())
        }
    }
}

struct TechCoachWeekTimeline: View {
    @ScaledMetric(relativeTo: .caption) private var cardWidth: CGFloat = 116
    @ScaledMetric(relativeTo: .title3) private var iconHeight: CGFloat = 24
    let days: [MobileWeekPlanDay]
    let todayLocalDate: String
    let onSelect: (MobileWeekPlanDay) -> Void

    var body: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 12) {
                TechSectionHeader(title: "本周安排", trailing: "点击查看")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(days) { day in
                            Button { onSelect(day) } label: { dayCard(day) }
                                .buttonStyle(TechPressStyle())
                                .accessibilityLabel(dayAccessibilityLabel(day))
                                .accessibilityIdentifier("coach.week-day.\(day.localDate)")
                        }
                    }
                }
            }
        }
    }

    private func dayCard(_ day: MobileWeekPlanDay) -> some View {
        let isToday = day.localDate == todayLocalDate
        let completed = techCoachDayIsCompleted(day)
        let tint = completed ? TechColor.success : techSessionColor(day.kind)
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(nativeWeekday(day.localDate)).font(.caption.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                if isToday { Circle().fill(TechColor.cyan).frame(width: 7, height: 7) }
            }
            Text(nativeDay(day.localDate)).font(.caption2).foregroundStyle(TechColor.muted)
                .fixedSize(horizontal: false, vertical: true)
            Image(systemName: completed ? "checkmark.circle.fill" : nativeSessionSymbol(day.kind))
                .font(.title3.weight(.semibold))
                .foregroundStyle(tint)
                .frame(height: iconHeight)
            Text(techCoachWeekDayTitle(day))
                .font(.caption.weight(.semibold))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Text(day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : day.kind == "rest" ? "休息" : "—")
                .font(.caption2.weight(.bold).monospacedDigit())
                .foregroundStyle(TechColor.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(12)
        .frame(width: min(cardWidth, 260), alignment: .topLeading)
        .frame(minHeight: 140, alignment: .topLeading)
        .background(isToday ? TechColor.mint : TechColor.paper, in: TechSurfaceShape())
        .overlay(TechSurfaceShape().stroke(isToday ? TechColor.cyan : TechColor.grid.opacity(0.6), lineWidth: isToday ? 1.5 : 1))
    }

    private func dayAccessibilityLabel(_ day: MobileWeekPlanDay) -> String {
        let state = techCoachDayIsCompleted(day) ? "已记录" : "未记录"
        return "\(nativeWeekday(day.localDate))\(nativeDay(day.localDate))，\(techCoachWeekDayTitle(day))，\(day.distanceKm > 0 ? nativeKilometers(day.distanceKm) : "无距离")，\(state)，查看训练详情"
    }
}

struct TechCoachTrainingDays: View {
    let plan: MobileRunCoachPlan
    let unplannedDays: [MobileRunCoachResponse.UnplannedDay]?

    var body: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 10) {
                TechSectionHeader(title: "可跑步日", trailing: "按偏好")
                HStack(spacing: 7) {
                    ForEach(plan.runningDays, id: \.self) { day in
                        TechBadge(title: weekdayName(day), color: TechColor.cyan, fill: TechColor.mint)
                    }
                }
                Text("可选，不是承诺；实际排课按校准、跑量与恢复调整。")
                    .font(.caption)
                    .foregroundStyle(TechColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
                if let unplannedDays, !unplannedDays.isEmpty {
                    Text("其中 \(unplannedDays.count) 天未来7日窗口没有排入训练。")
                        .font(.caption)
                        .foregroundStyle(TechColor.muted)
                    ForEach(Array(Set(unplannedDays.map { "\(techCoachUnplannedReasonName($0.code))：\($0.detail)" })).sorted(), id: \.self) { detail in
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(TechColor.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private func weekdayName(_ day: Int) -> String {
        ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"][min(7, max(1, day))]
    }
}

#endif
