#if os(iOS)
import SwiftUI

/// Only the three existing measurements; no invented score, baseline or history.
struct TechTodayRecoveryMetrics: View {
    let recovery: MobileRecoveryBreakdown
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 16) { metrics }
            } else {
                HStack(alignment: .top, spacing: 8) { metrics }
            }
        }
        .accessibilityIdentifier("today.recovery.metrics")
    }

    @ViewBuilder private var metrics: some View {
        metric("睡眠", value: nativeHoursMinutes(recovery.lastNightSleepMinutes), icon: "moon.fill")
        metric("静息心率", value: measurement(recovery.restingHeartRateBpm, unit: "bpm"), icon: "heart.fill", color: TechColor.coral)
        metric("HRV", value: measurement(recovery.morningHrvMs, unit: "ms"), icon: "waveform.path.ecg", color: TechColor.success)
    }

    private func measurement(_ value: Double?, unit: String) -> String {
        guard let value, value.isFinite, value >= 0 else { return "无记录" }
        return "\(nativeNumber(value, digits: 0)) \(unit)"
    }

    private func metric(_ title: String, value: String, icon: String, color: Color = TechColor.cyan) -> some View {
        VStack(spacing: 7) {
            Image(systemName: icon)
                .font(.system(size: 23, weight: .medium))
                .foregroundStyle(color)
                .accessibilityHidden(true)
            Text(title).font(.caption).foregroundStyle(TechColor.muted)
            Text(value).font(.subheadline.weight(.bold)).monospacedDigit()
                .foregroundStyle(TechColor.ink)
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title)，\(value)")
    }
}

func recoveryStatusColor(_ state: String?) -> Color {
    switch state {
    case "recovered", "recovered_phys": return TechColor.cyan
    case "reduced": return TechColor.yellow
    case "depleted": return TechColor.coral
    default: return TechColor.muted
    }
}

/// A linear 0–100 ruler replaces the home card's radial gauge. Missing data
/// leaves the track empty, with no marker pretending to be a zero measurement.
struct TechTodayAbilityRuler: View {
    let score: Double?
    private var fraction: Double? {
        guard let score, score.isFinite else { return nil }
        return min(max(score / 100, 0), 1)
    }

    var body: some View {
        VStack(spacing: 5) {
            GeometryReader { geometry in
                let width = max(geometry.size.width, 0)
                ZStack(alignment: .topLeading) {
                    Capsule().fill(TechColor.grid).frame(height: 5)
                    if let fraction {
                        Capsule().fill(TechColor.energy)
                            .frame(width: width * fraction, height: 5)
                        Circle().fill(TechColor.ink)
                            .frame(width: 7, height: 7)
                            .overlay(Circle().strokeBorder(TechColor.cyan, lineWidth: 1.5))
                            .offset(x: max(0, min(width - 7, width * fraction - 3.5)), y: -1)
                    }
                    ForEach(0..<11) { tick in
                        Rectangle().fill(TechColor.grid)
                            .frame(width: 1, height: tick.isMultiple(of: 5) ? 8 : 4)
                            .offset(x: max(0, width - 1) * CGFloat(tick) / 10, y: 10)
                    }
                }
            }.frame(height: 18)
            HStack {
                Text("0")
                Spacer()
                Text("100")
            }.font(.caption2.monospacedDigit()).foregroundStyle(TechColor.muted)
        }
        .accessibilityHidden(true)
    }
}
#endif
