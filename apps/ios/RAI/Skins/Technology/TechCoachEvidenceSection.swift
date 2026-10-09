#if os(iOS)
import SwiftUI

struct TechCoachConfidenceCard: View {
    let confidence: MobileRunCoachResponse.Confidence

    var body: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 12) {
                TechSectionHeader(title: "备赛准备度", trailing: techCoachConfidenceBandName(confidence.band ?? ""))
                if confidence.status == "available", let value = confidence.value {
                    HStack(spacing: 16) {
                        TechRingProgress(
                            fraction: value / 100,
                            value: "\(Int(value.rounded()))",
                            label: "/ 100",
                            tint: bandColor(confidence.band)
                        )
                        VStack(alignment: .leading, spacing: 8) {
                            Text(techCoachConfidenceBandName(confidence.band ?? ""))
                                .font(.headline.weight(.semibold))
                                .foregroundStyle(bandColor(confidence.band))
                            if let level = confidence.evidenceLevel {
                                Text(techCoachEvidenceLevelName(level)).font(.caption).foregroundStyle(TechColor.muted)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    if let components = confidence.components {
                        VStack(spacing: 2) {
                            TechProgressRow(label: "跑量", fraction: components.volume)
                            TechProgressRow(label: "长课", fraction: components.longRun)
                            TechProgressRow(label: "频率", fraction: components.frequency)
                            TechProgressRow(label: "强度", fraction: components.exposure)
                            TechProgressRow(label: "新鲜度", fraction: components.recency)
                        }
                        .accessibilityLabel(componentLine(components))
                    }
                } else {
                    Text("暂无法给出准备度").font(.headline.weight(.semibold))
                }
                if !confidence.note.isEmpty {
                    DisclosureGroup("查看依据") {
                        Text(confidence.note).font(.caption).foregroundStyle(TechColor.muted)
                    }
                    .font(.caption.weight(.semibold))
                    .tint(TechColor.cyan)
                }
            }
        }
    }

    private func bandColor(_ band: String?) -> Color {
        switch band {
        case "high": return TechColor.green
        case "moderate": return TechColor.yellow
        default: return TechColor.coral
        }
    }

    private func componentLine(_ components: MobileRunCoachResponse.Components) -> String {
        "跑量 \(nativePercent(components.volume)) · 长课 \(nativePercent(components.longRun)) · "
            + "频率 \(nativePercent(components.frequency)) · 强度 \(nativePercent(components.exposure)) · "
            + "新鲜度 \(nativePercent(components.recency))"
    }
}

struct TechProgressRow: View {
    let label: String
    let fraction: Double

    var body: some View {
        HStack(spacing: 8) {
            Text(label).font(.caption).foregroundStyle(TechColor.muted).frame(width: 42, alignment: .leading)
            TechProgressBar(fraction: fraction, tint: TechColor.cyan, height: 6)
            Text(nativePercent(fraction)).font(.caption2.monospacedDigit()).foregroundStyle(TechColor.ink).frame(width: 40, alignment: .trailing)
        }
    }
}

struct TechCoachPhaseTimeline: View {
    let phases: [MobileRunCoachResponse.Phase]

    var body: some View {
        TechPanel {
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(phases) { phase in
                        HStack(alignment: .top, spacing: 12) {
                            VStack(spacing: 0) {
                                Image(systemName: phase.current ? "circle.inset.filled" : "circle")
                                    .foregroundStyle(phase.current ? TechColor.cyan : TechColor.muted)
                                if phase.id != phases.last?.id {
                                    Rectangle().fill(TechColor.grid).frame(width: 1, height: 30)
                                }
                            }
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 8) {
                                    Text(techCoachPhaseName(phase.phase)).font(.subheadline.weight(.semibold))
                                    if phase.current { TechBadge(title: "当前", color: TechColor.cyan, fill: TechColor.mint) }
                                }
                                Text("\(nativeDay(phase.startsOn)) – \(nativeDay(phase.endsOn))")
                                    .font(.caption)
                                    .foregroundStyle(TechColor.muted)
                            }
                            Spacer(minLength: 0)
                        }
                    }
                }
                .padding(.top, 10)
            } label: {
                TechSectionHeader(title: "训练周期", trailing: "阶段")
            }
            .tint(TechColor.cyan)
        }
    }
}

struct TechCoachHistoryCard: View {
    let workouts: [WorkoutListItem]

    var body: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 10) {
                TechSectionHeader(title: "最近训练", trailing: "历史")
                ForEach(workouts) { workout in
                    NavigationLink { TechWorkoutDetailView(workoutId: workout.id) } label: {
                        HStack(spacing: 10) {
                            TechIconBox(systemName: "checkmark.circle.fill", tint: TechColor.success, fill: TechColor.mint, size: 34)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(nativeSessionName(workout.sessionType)).font(.subheadline.weight(.semibold))
                                Text(nativeDate(workout.startedAt)).font(.caption).foregroundStyle(TechColor.muted)
                            }
                            Spacer(minLength: 0)
                            Text(nativeKilometers(workout.distanceKm)).font(.caption.monospacedDigit()).foregroundStyle(TechColor.ink)
                            Image(systemName: "chevron.right").font(.caption2).foregroundStyle(TechColor.muted)
                        }
                        .padding(.vertical, 5)
                    }
                    .buttonStyle(TechPressStyle())
                }
            }
        }
    }
}

#endif
