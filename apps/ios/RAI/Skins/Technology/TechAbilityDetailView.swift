#if os(iOS)
import SwiftUI

struct TechAbilityDetailView: View {
    @Environment(NativeAppModel.self) private var native

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("VDOT").font(.subheadline).foregroundStyle(TechColor.muted)
                        Text(nativeNumber(native.predictions?.snapshot.performanceVdot.value, digits: 1))
                            .font(.system(size: 42, weight: .semibold)).monospacedDigit()
                        Text("基于当前训练证据").font(.caption).foregroundStyle(TechColor.cyan)
                    }
                    Spacer()
                    // VDOT is not a percentage: a decorative instrument avoids inventing a maximum.
                    TechInstrumentRing(progress: 0, size: 100)
                }.padding(.vertical, 12)
                if let data = native.trends {
                    let points = data.ability.filter { $0.trueAbility != nil }
                    TechPanel {
                        TechSectionHeader(title: "评估趋势", trailing: "真实跑力")
                        if points.isEmpty {
                            TechEmptyState(title: "暂无评估趋势", message: "积累更多训练后显示跑力变化。")
                        } else {
                            TechLineChart(values: points.compactMap(\.trueAbility),
                                          labels: points.map { nativeDay($0.date) })
                        }
                        HStack {
                            techMetricCaption("增长速度", value: nativeNumber(data.growthVelocityPerWeek))
                            techMetricCaption("衰减", value: nativeNumber(data.decayPoints))
                        }
                    }
                    TechPanel {
                        TechSectionHeader(title: "近期跑力评估", trailing: "\(data.currentAbility.count) 条")
                        ForEach(data.currentAbility.prefix(8)) { point in
                            HStack {
                                Text(nativeDay(point.date)).font(.caption).foregroundStyle(TechColor.muted)
                                Spacer()
                                Text(nativeNumber(point.currentAbility, digits: 1))
                                    .font(.subheadline.weight(.semibold)).monospacedDigit()
                                Text(nativeStatusName(point.assessmentStatus))
                                    .font(.caption).foregroundStyle(TechColor.cyan)
                            }.padding(.vertical, 4)
                        }
                    }
                }
                TechPanel {
                    TechSectionHeader(title: "数据依据")
                    Text("使用服务端跑力评估与预测快照；不绘制接口未提供的置信区间或能力分解。")
                        .font(.footnote).foregroundStyle(TechColor.muted)
                }
                if let profile = native.trainingZones?.profile {
                    TechPanel {
                        TechSectionHeader(title: "配速区间", trailing: "min/km")
                        ForEach(profile.paceBands) { band in
                            HStack {
                                Text(zoneName(band.zone)).font(.subheadline.weight(.medium))
                                    .foregroundStyle(TechColor.cyan)
                                Spacer()
                                Text(paceRange(band.lowerSecondsPerKm, band.upperSecondsPerKm))
                                    .font(.caption.monospacedDigit()).foregroundStyle(TechColor.ink)
                            }.padding(.vertical, 7)
                        }
                    }
                }
            }.padding(20).padding(.bottom, TechMetrics.bottomClearance)
        }
        .background(TechColor.background).foregroundStyle(TechColor.ink)
        .techNavigation("跑力评估").navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbarBackground(TechColor.background, for: .navigationBar)
        .task { await native.refreshBodyMetrics() }
    }

    private func zoneName(_ zone: String) -> String {
        switch zone {
        case "easy": return "E · 轻松"
        case "marathon": return "M · 马拉松"
        case "lactate_threshold": return "T · 阈值"
        case "anaerobic_endurance": return "I · 无氧耐力"
        case "sprint": return "R · 冲刺"
        default: return zone
        }
    }

    private func paceRange(_ lower: Double?, _ upper: Double?) -> String {
        switch (lower, upper) {
        case let (a?, b?): return "\(techPace(a))–\(techPace(b))"
        case let (a?, nil): return "\(techPace(a)) 或更慢"
        case let (nil, b?): return "\(techPace(b)) 或更快"
        default: return "暂无数据"
        }
    }
}
#endif
