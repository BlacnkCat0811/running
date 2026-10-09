#if os(iOS)
import SwiftUI

struct TechCoachHeroCard: View {
    let plan: MobileRunCoachPlan
    let phase: String
    let elapsedWeek: Int?
    let daysToRace: Int?
    let todayLocalDate: String?

    private var currentWeek: Int? { techCoachCurrentWeek(elapsedWeeks: elapsedWeek) }
    private var weekLabel: String {
        guard let currentWeek else { return "—" }
        return totalWeeks.map { "\(currentWeek)/\($0)" } ?? "\(currentWeek)周"
    }
    private var totalWeeks: Int? { techCoachTotalWeeks(for: plan) }
    private var fraction: Double? {
        guard let currentWeek, let totalWeeks, totalWeeks > 0 else { return nil }
        return min(1, max(0, Double(currentWeek) / Double(totalWeeks)))
    }

    var body: some View {
        TechHeroCard {
            HStack(alignment: .top, spacing: 12) {
                TechIconBox(systemName: "figure.run.circle.fill", tint: TechColor.ink, fill: TechColor.elevated, size: 48)
                VStack(alignment: .leading, spacing: 4) {
                    Text("跑步教练").font(.caption.weight(.semibold)).foregroundStyle(TechColor.muted)
                    Text(plan.goal == "fitness" ? "改善跑步体能" : "\(nativeKilometers(plan.raceDistanceKm)) 训练计划")
                        .techScaledFont(24, weight: .heavy, relativeTo: .title2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                TechBadge(
                    title: plan.status == "paused" ? "已暂停" : plan.status == "ended" ? "已结束" : "进行中",
                    color: plan.status == "active" ? TechColor.success : TechColor.muted,
                    fill: plan.status == "active" ? TechColor.mint : TechColor.elevated
                )
            }

            HStack(alignment: .center, spacing: 18) {
                TechRingProgress(
                    fraction: fraction,
                    value: weekLabel,
                    label: "训练周期",
                    tint: TechColor.cyan
                )
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Text(phase).font(.headline.weight(.semibold))
                        if let countdown = techCoachRaceCountdown(raceDate: plan.raceDate, todayLocalDate: todayLocalDate, daysToRace: daysToRace) {
                            TechBadge(title: countdown, color: TechColor.yellow, fill: TechColor.paleYellow)
                        }
                    }
                    HStack(spacing: 14) {
                        coachHeroMetric(title: currentWeek.map { "第\($0)周" } ?? "进度待刷新", value: totalWeeks.map { "共\($0)周" } ?? "持续")
                        if let targetTimeSeconds = plan.targetTimeSeconds {
                            coachHeroMetric(title: "目标", value: nativeDuration(targetTimeSeconds))
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            TechProgressBar(fraction: fraction, tint: TechColor.cyan, height: 8)
        }
    }

    private func coachHeroMetric(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(value).font(.headline.weight(.bold).monospacedDigit())
            Text(title).font(.caption).foregroundStyle(TechColor.muted)
        }
    }
}

struct TechTodayTrainingCard: View {
    let today: MobileTodayResponse
    let preferredTargetType: String
    let isCompleted: Bool
    let onConfirm: () -> Void
    let isConfirmDisabled: Bool

    private var session: MobileNextSession { today.nextSession }
    private var target: TechCoachTrainingTarget? {
        techCoachTrainingTarget(for: session, preferredType: preferredTargetType)
    }
    private var isRest: Bool { session.kind == "rest" }
    private var stateLabel: String {
        if isCompleted { return "已记录" }
        if isRest || today.phase == "rest_done" { return "恢复日" }
        if today.lock.present { return "已锁定" }
        return "待开始"
    }
    private var stateColor: Color {
        if isCompleted { return TechColor.success }
        if isRest || today.phase == "rest_done" { return TechColor.muted }
        if today.lock.present { return TechColor.blue }
        return TechColor.cyan
    }
    private var stateFraction: Double {
        if isCompleted || isRest || today.phase == "rest_done" { return 1 }
        if today.lock.present { return 0.65 }
        return 0.18
    }

    var body: some View {
        TechHeroCard {
            HStack(alignment: .top, spacing: 12) {
                TechIconBox(systemName: nativeSessionSymbol(session.kind), tint: stateColor, fill: stateColor.opacity(0.12), size: 52)
                VStack(alignment: .leading, spacing: 4) {
                    Text("今日训练").font(.caption.weight(.semibold)).foregroundStyle(TechColor.muted)
                    Text(session.title).techFont(.compactMetric).fixedSize(horizontal: false, vertical: true)
                    Text(nativeDay(today.today.localDate)).font(.caption).foregroundStyle(TechColor.muted)
                }
                Spacer(minLength: 8)
                TechBadge(title: stateLabel, color: stateColor, fill: stateColor.opacity(0.12))
            }

            TechMetricGrid(minimum: 108) {
                if let distanceKm = session.distanceKm {
                    TechCoachValueTile(value: nativeKilometers(distanceKm), label: "距离", tint: TechColor.ink)
                }
                if let durationMinutes = session.durationMinutes {
                    TechCoachValueTile(value: "\(nativeNumber(durationMinutes, digits: 0)) min", label: "时长", tint: TechColor.ink)
                }
                if let target {
                    TechCoachValueTile(value: target.formattedRange, label: target.title, tint: TechColor.cyan)
                }
            }

            HStack(spacing: 10) {
                TechProgressBar(fraction: stateFraction, tint: stateColor, height: 8)
                Text(stateLabel).font(.caption.weight(.semibold)).foregroundStyle(stateColor)
            }

            if !session.reason.isEmpty {
                Text(session.reason)
                    .font(.caption)
                    .foregroundStyle(TechColor.muted)
                    .lineLimit(1)
            }

            if !isRest && !isCompleted {
                Button(action: onConfirm) {
                    Label(today.lock.relockSuggested ? "重新确认今日训练" : today.lock.present ? "已锁定今日训练" : "确认今日训练", systemImage: today.lock.present ? "checkmark.circle.fill" : "play.fill")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(isConfirmDisabled ? TechColor.muted : TechColor.actionInk)
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .background(isConfirmDisabled ? TechColor.grid : TechColor.action, in: TechSurfaceShape())
                }
                .buttonStyle(TechPressStyle())
                .disabled(isConfirmDisabled)
            }
        }
    }
}

extension TechCoachTrainingTarget {
    var formattedRange: String {
        alert.kind == "heart_rate"
            ? techHeartRateRange(alert.lower, alert.upper)
            : techPaceRange(alert.lower, alert.upper)
    }
}

struct TechCoachValueTile: View {
    let value: String
    let label: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(value)
                .techScaledFont(20, weight: .bold, relativeTo: .title3).monospacedDigit()
                .foregroundStyle(tint)
                .fixedSize(horizontal: false, vertical: true)
            Text(label).font(.caption).foregroundStyle(TechColor.muted)
        }
        .frame(maxWidth: .infinity, minHeight: 70, alignment: .leading)
        .padding(12)
        .background(TechColor.elevated, in: TechSurfaceShape())
    }
}

struct TechCoachEmptyCard<Content: View>: View {
    let createButton: Content

    init(@ViewBuilder createButton: () -> Content) {
        self.createButton = createButton()
    }

    var body: some View {
        TechPanel(tint: TechColor.cyan) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    TechIconBox(systemName: "figure.run.circle.fill", tint: TechColor.cyan, fill: TechColor.mint, size: 50)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("你的跑步教练").font(.title2.weight(.bold))
                        Text("从今天开始，按计划训练").font(.subheadline).foregroundStyle(TechColor.muted)
                    }
                }
                createButton
            }
        }
    }
}

struct TechRingProgress: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let fraction: Double?
    let value: String
    let label: String
    let tint: Color

    private var clampedFraction: Double? {
        guard let fraction, fraction.isFinite else { return nil }
        return min(1, max(0, fraction))
    }

    var body: some View {
        ZStack {
            Circle().stroke(TechColor.grid.opacity(0.55), lineWidth: 8)
            if let clampedFraction {
                Circle()
                    .trim(from: 0, to: clampedFraction)
                    .stroke(tint, style: StrokeStyle(lineWidth: 8, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            VStack(spacing: 1) {
                Text(value).font(.caption.weight(.bold).monospacedDigit()).foregroundStyle(TechColor.ink)
                    .lineLimit(1).minimumScaleFactor(0.25)
                Text(label).font(.caption2).foregroundStyle(TechColor.muted)
                    .lineLimit(1).minimumScaleFactor(0.25)
            }
        }
        .frame(width: 76, height: 76)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.3), value: clampedFraction)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(value)
    }
}

#endif
