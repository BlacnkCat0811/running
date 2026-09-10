#if os(iOS)
import SwiftUI

/// Read a detail independently: opening Today must not replace the selected workout.
struct TechTodayMetrics: View {
    @Environment(ServerSession.self) private var session
    let workout: WorkoutListItem?
    @State private var detail: WorkoutDetailResponse?
    @State private var failed = false
    private var requestKey: String { (workout?.id ?? "") + session.serverURLString + session.apiToken }

    var body: some View {
        VStack(spacing: TechMetrics.sectionSpacing) {
            TechPanel {
                TechSectionHeader(title: "荣耀指标", trailing: workout.map { nativeDay(String($0.startedAt.prefix(10))) } ?? "暂无训练")
                Grid(horizontalSpacing: 14, verticalSpacing: 10) {
                    GridRow {
                        metric("心率", value: nativeNumber(detail?.workout.averageHeartRateBpm ?? workout?.averageHeartRateBpm, digits: 0), unit: "bpm", icon: "waveform.path.ecg")
                        metric("训练负荷", value: nativeNumber(detail?.trainingLoad?.load, digits: 0), unit: "", icon: "flame")
                    }
                    Rectangle().fill(TechColor.grid.opacity(0.5)).frame(height: 0.5).gridCellColumns(2)
                    GridRow {
                        metric("步频", value: nativeNumber(detail?.workout.averageCadenceSpm, digits: 0), unit: "spm", icon: "shoeprints.fill")
                        metric("触地时间", value: nativeNumber(detail?.workout.averageGroundContactTimeMs, digits: 0), unit: "ms", icon: "figure.run")
                    }
                }
                if failed {
                    Text("部分指标暂不可用，下拉刷新后重试。")
                        .font(.caption2).foregroundStyle(TechColor.muted)
                }
            }
            if let dimensions = detail?.dimensions {
                TechPanel {
                    TechSectionHeader(title: "关键指标", trailing: "最近训练 · /100")
                    HStack(spacing: 12) {
                        metric("效率", value: nativeNumber(dimensions.efficiency, digits: 0), unit: "", icon: "bolt")
                        metric("心肺", value: nativeNumber(dimensions.cardio, digits: 0), unit: "", icon: "heart")
                        metric("稳定性", value: nativeNumber(dimensions.stability, digits: 0), unit: "", icon: "waveform.path")
                    }
                }
            }
        }
        .task(id: requestKey) {
            detail = nil; failed = false
            guard let workout, let url = session.serverURL else { return }
            let key = requestKey
            do {
                let result = try await RaiAPIClient().workoutDetail(id: workout.id, baseURL: url, token: session.apiToken)
                guard !Task.isCancelled, key == requestKey else { return }
                detail = result
            } catch {
                guard !Task.isCancelled, key == requestKey else { return }
                failed = true
            }
        }
    }

    private func metric(_ title: String, value: String, unit: String, icon: String) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.caption2).foregroundStyle(TechColor.muted)
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(value).font(.system(size: 19, weight: .semibold)).monospacedDigit()
                    Text(unit).font(.caption2)
                }.foregroundStyle(TechColor.ink).lineLimit(1).minimumScaleFactor(0.7)
            }
            Spacer(minLength: 0)
            Image(systemName: icon).font(.system(size: 17, weight: .light)).foregroundStyle(TechColor.cyan.opacity(0.65))
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
#endif
