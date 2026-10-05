#if os(iOS)
import SwiftUI

/// 跑力详情：真实跑力、基础指标与评估趋势。
///
/// 只组合服务端已有载荷，不在设备上重算评分。
struct TechAbilityDetailView: View {
    @Environment(NativeAppModel.self) private var native

    private var ability: MobileAbilityCard? { native.today?.ability }
    private var calibration: MobileCalibrationCard? { native.today?.calibration }

    private var abilityFraction: Double? {
        ability?.trueAbility.map { min(max($0 / 100, 0), 1) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TechMetrics.sectionSpacing) {
                abilityPanel
                dimensionsPanel
                baseMetricsPanel
                predictionPanel
                trendPanel
                paceZonePanel
            }
            .padding(.horizontal, TechMetrics.pageHorizontal)
            .padding(.top, TechMetrics.pageVertical)
            .padding(.bottom, TechMetrics.bottomClearance)
        }
        .background(TechColor.background).foregroundStyle(TechColor.ink)
        .scrollIndicators(.hidden)
        .techNavigation("跑步能力").navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbarBackground(TechColor.background, for: .navigationBar)
        .toolbarColorScheme(.light, for: .navigationBar)
        .refreshable {
            await native.refreshAll()
            await native.refreshBodyMetrics()
        }
        .task {
            if native.trends == nil { await native.refreshAll() }
            await native.refreshBodyMetrics()
        }
    }

    // MARK: - 跑力总览

    private var abilityPanel: some View {
        TechPanel(tint: TechColor.cyan) {
            TechSectionHeader(
                title: "跑步能力",
                trailing: techCalibrationName(calibration?.status),
                trailingColor: TechColor.cyan
            )
            TechAdaptiveStack(spacing: 16) {
                TechAbilityGauge(
                    progress: abilityFraction ?? 0,
                    value: nativeNumber(ability?.trueAbility, digits: 1),
                    caption: "真实跑力 /100"
                )
                VStack(alignment: .trailing, spacing: 9) {
                    techMetricCaption("近 7 天", value: nativeSigned(ability?.changeFrom7DaysAgo))
                    techMetricCaption("增长速度", value: techValue(ability?.growthVelocityPerWeek, unit: "/周"))
                    techMetricCaption("衰减", value: nativeNumber(ability?.decayPoints))
                }
                .frame(minWidth: 92, alignment: .trailing)
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                "真实跑力 \(nativeNumber(ability?.trueAbility, digits: 1))，满分 100"
                + "，近 7 天 \(nativeSigned(ability?.changeFrom7DaysAgo))"
                + "，增长速度 \(techValue(ability?.growthVelocityPerWeek, unit: "/周"))"
                + "，衰减 \(nativeNumber(ability?.decayPoints))"
            )
            if let explanation = ability?.explanation, !explanation.isEmpty {
                Text(explanation).font(.footnote).foregroundStyle(TechColor.muted)
            }
            if let snapshotDate = ability?.snapshotDate {
                Text("快照日期 \(nativeDay(snapshotDate))")
                    .font(.caption2).foregroundStyle(TechColor.muted)
            }
            if let calibration, calibrationNeedsAttention(calibration.status) {
                Text(calibration.message)
                    .font(.caption)
                    .foregroundStyle(TechColor.muted)
                    .padding(9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(TechColor.paleYellow)
                    .overlay(TechSurfaceShape().stroke(TechColor.yellow, lineWidth: 1))
            }
        }
    }

    // MARK: - 能力分析（五维）

    /// 服务端最近一次纳入分析的训练的五维分解（`/v1/dashboard` 的 `dimensions`）。
    ///
    /// 缺值不补零：分数渲染成 `--`，进度条只画轨道不画填充 —— `TechStatLine.fraction`
    /// 收 `nil` 即"没有观测值"，与真实的 0 分区分开。
    ///
    /// 标题右边的日期取 `latestWorkout` 而不是"最新训练"：服务端构造该载荷时
    /// `latestWorkout` 与产出 `dimensions` 的评估来自**同一条**记录
    /// （`data.ts` 先取 `assessment_status = 'eligible'` 的最近一条，再据此查维度），
    /// 所以它就是五维对应的那次训练；换成"今天"或"最新一条训练"都会指错。
    private var dimensionsPanel: some View {
        let dimensions = native.dashboard?.dimensions
        return TechPanel {
            VStack(alignment: .leading, spacing: 8) {
                TechSectionHeader(
                    title: "能力分析",
                    trailing: native.dashboard?.latestWorkout.map { nativeDay($0.startedAt) } ?? "--",
                    trailingColor: TechColor.muted
                )
                Text("各维度按照服务端权重折算进即时跑力；心肺为诊断项，不进入当前跑力权重。")
                    .font(.caption2).foregroundStyle(TechColor.muted)
                if let dimensions {
                    dimensionLine("效率", dimensions.efficiency)
                    dimensionLine("配速", dimensions.pace)
                    dimensionLine("心肺", dimensions.cardio, note: "诊断")
                    dimensionLine("稳定性", dimensions.stability)
                    dimensionLine("恢复", dimensions.recovery)
                } else if native.isLoadingBodyMetrics {
                    ProgressView().tint(TechColor.cyan).frame(maxWidth: .infinity)
                } else {
                    Text("五维分解暂不可用，下拉刷新后重试。")
                        .font(.caption).foregroundStyle(TechColor.muted)
                }
            }
        }
    }

    /// 五维是同一个分数的分解，色相不承载含义 ⇒ 五行共用一个 tint，
    /// 否则五种颜色会被读成五种独立指标（与配速区间那种"颜色即区间"的地方不同）。
    private func dimensionLine(_ label: String, _ value: Double?, note: String? = nil) -> some View {
        TechStatLine(
            label: label,
            value: nativeNumber(value, digits: 0),
            tint: TechColor.cyan,
            fraction: value.flatMap { $0.isFinite ? min(max($0 / 100, 0), 1) : nil },
            note: note
        )
    }

    // MARK: - 基础指标

    private var baseMetricsPanel: some View {
        TechPanel {
            VStack(alignment: .leading, spacing: 10) {
                TechSectionHeader(title: "基础指标", trailing: "预测快照", trailingColor: TechColor.cyan)
                TechMetricGrid {
                    baseMetric(
                        title: "最大摄氧量",
                        value: nativeNumber(native.predictions?.snapshot.vo2Max.valueMlKgMin, digits: 1),
                        unit: "ml/kg/min",
                        available: native.predictions?.snapshot.vo2Max.valueMlKgMin != nil
                    )
                    baseMetric(
                        title: "乳酸阈配速",
                        value: techPace(native.predictions?.snapshot.lactateThreshold.paceSecondsPerKm),
                        unit: "/km",
                        available: native.predictions?.snapshot.lactateThreshold.paceSecondsPerKm != nil
                    )
                    baseMetric(
                        title: "乳酸阈心率",
                        value: native.predictions?.snapshot.lactateThreshold.heartRateBpm.map { nativeNumber($0, digits: 0) } ?? "--",
                        unit: "bpm",
                        available: native.predictions?.snapshot.lactateThreshold.heartRateBpm != nil
                    )
                }
                TechMetricGrid {
                    techMetricCaption("有效 VDOT", value: nativeNumber(native.predictions?.snapshot.performanceVdot.value, digits: 1))
                    techMetricCaption("VO₂ 置信", value: nativePercent(native.predictions?.snapshot.vo2Max.confidence))
                    techMetricCaption("阈值置信", value: nativePercent(native.predictions?.snapshot.lactateThreshold.confidence))
                }
                if native.predictions == nil && native.isLoadingBodyMetrics {
                    ProgressView().tint(TechColor.cyan).frame(maxWidth: .infinity)
                } else if native.predictions == nil {
                    Text("预测快照暂不可用，下拉刷新后重试。")
                        .font(.caption).foregroundStyle(TechColor.muted)
                }
            }
        }
    }

    private func baseMetric(title: String, value: String, unit: String, available: Bool) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption).foregroundStyle(TechColor.muted).fixedSize(horizontal: false, vertical: true)
            Text(value)
                .techScaledFont(24).monospacedDigit()
                .foregroundStyle(available ? TechColor.ink : TechColor.muted)
                .fixedSize(horizontal: false, vertical: true)
            Text(unit).font(.caption2).foregroundStyle(TechColor.muted)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TechColor.background.opacity(0.5), in: TechSurfaceShape())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title) \(available ? value : "暂无数据") \(unit)")
    }

    // MARK: - 评估趋势

    /// 成绩预测只呈现服务端给出的区间与准备度，不承诺比赛成绩。
    @ViewBuilder
    private var predictionPanel: some View {
        if let races = native.predictions?.snapshot.races, !races.isEmpty {
            TechPanel {
                VStack(alignment: .leading, spacing: 9) {
                    TechSectionHeader(title: "成绩预测", trailing: "区间参考", trailingColor: TechColor.muted)
                    Text("预测不是目标成绩，也不代表比赛承诺。区间和可信度均来自服务端，缺失时不作估计。")
                        .font(.caption).foregroundStyle(TechColor.muted)
                    predictionLoadStateBanner
                    ForEach(races) { race in
                        TechAdaptiveStack(spacing: 8) {
                            Text(techRaceDistanceName(race.distance))
                                .font(.subheadline).foregroundStyle(TechColor.muted)
                                .frame(minWidth: 56, alignment: .leading)
                            Text(techDuration(race.predictedSeconds))
                                .font(.title3.weight(.semibold)).monospacedDigit()
                                .foregroundStyle(TechColor.ink).fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 6)
                            VStack(alignment: .trailing, spacing: 3) {
                                Text(techRaceRange(race))
                                    .font(.caption2.monospacedDigit()).foregroundStyle(TechColor.muted)
                                Text("可信度 " + nativePercent(race.confidence))
                                    .font(.caption2).foregroundStyle(TechColor.muted)
                                Text("准备度 " + nativePercent(race.readiness))
                                    .font(.caption2).foregroundStyle(TechColor.cyan)
                                if let fatigue = race.fatigueAdjustmentSeconds {
                                    Text("疲劳修正 \(nativeDuration(fatigue))")
                                        .font(.caption2).foregroundStyle(TechColor.muted)
                                }
                            }
                        }
                        .padding(.vertical, 6)
                        .overlay(alignment: .bottom) {
                            Rectangle().fill(TechColor.grid.opacity(0.5)).frame(height: 1)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var predictionLoadStateBanner: some View {
        switch native.predictionLoadState {
        case .current:
            EmptyView()
        case let .stale(_, message), let .unavailable(message):
            HStack(alignment: .top, spacing: 7) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(TechColor.yellow)
                Text(message)
                    .font(.caption2)
                    .foregroundStyle(TechColor.muted)
            }
        }
    }

    @ViewBuilder
    private var trendPanel: some View {
        if let data = native.trends {
            let points = data.ability.filter { $0.trueAbility != nil }
            TechPanel {
                TechSectionHeader(title: "评估趋势", trailing: "真实跑力", trailingColor: TechColor.cyan)
                if points.isEmpty {
                    TechEmptyState(title: "暂无评估趋势", message: "积累更多训练后显示跑力变化。", systemName: "chart.xyaxis.line")
                } else {
                    TechLineChart(
                        values: points.compactMap(\.trueAbility),
                        labels: points.map { nativeDay($0.date) }
                    )
                    TechMetricGrid(minimum: 140) {
                        techMetricCaption("增长速度", value: techValue(data.growthVelocityPerWeek, unit: "/周"))
                        techMetricCaption("衰减", value: nativeNumber(data.decayPoints))
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var paceZonePanel: some View {
        if let profile = native.trainingZones?.profile {
            TechPanel {
                VStack(alignment: .leading, spacing: 9) {
                    TechSectionHeader(title: "配速区间", trailing: "min/km", trailingColor: TechColor.muted)
                    ForEach(profile.paceBands) { band in
                        TechAdaptiveStack(spacing: 8) {
                            Text(techPaceZoneCode(band.zone))
                                .font(.caption.weight(.semibold)).foregroundStyle(TechColor.actionInk)
                                .padding(6)
                                .background(TechColor.action.opacity(0.75), in: TechSurfaceShape())
                            Text(techPaceZoneName(band.zone)).font(.subheadline.weight(.medium))
                                .foregroundStyle(TechColor.ink)
                            Spacer(minLength: 6)
                            Text(techPaceRange(band.lowerSecondsPerKm, band.upperSecondsPerKm))
                                .font(.caption.monospacedDigit()).foregroundStyle(TechColor.muted)
                        }
                        .padding(.vertical, 5)
                        .overlay(alignment: .bottom) {
                            Rectangle().fill(TechColor.grid.opacity(0.5)).frame(height: 1)
                        }
                    }
                }
            }
        }
    }
}

/// 与既有科技风分区卡一致的中文区间名；未知值不直出英文原值。
func techPaceZoneName(_ zone: String) -> String {
    switch zone {
    case "easy": return "轻松区"
    case "marathon": return "马拉松区"
    case "lactate_threshold": return "阈值区"
    case "anaerobic_endurance": return "无氧耐力区"
    case "sprint": return "冲刺区"
    default: return "配速区间"
    }
}

// `techRaceDistanceName` 已移到 `TechEnumPresentation.swift`：它住在 iOS-only 的
// View 文件里时没有任何通道能编译并断言它，移进纯 Foundation 后进了展示逻辑闸门。

/// 乐观/保守区间；只有单边时说明是哪一边，都没有就不编造区间。
func techRaceRange(_ race: NativeRacePrediction) -> String {
    let optimistic = race.optimisticSeconds
    let pessimistic = race.pessimisticSeconds
    switch (optimistic, pessimistic) {
    case let (best?, worst?): return "\(techDuration(best))–\(techDuration(worst))"
    case let (best?, nil): return "\(techDuration(best)) 或更慢"
    case let (nil, worst?): return "不快于 \(techDuration(worst))"
    default: return "区间暂不可用"
    }
}
#endif
