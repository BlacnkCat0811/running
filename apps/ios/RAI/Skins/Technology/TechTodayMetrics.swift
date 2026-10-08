#if os(iOS)
import SwiftUI

/// 最近一次训练的生理与机械指标。
///
/// Read a detail independently: opening Today must not replace the selected workout.
struct TechTodayMetrics: View {
    @Environment(ServerSession.self) private var session
    let workout: WorkoutListItem?
    var refreshRevision = ""
    @State private var detail: WorkoutDetailResponse?
    @State private var failed = false
    @State private var retryGeneration = 0
    @State private var loadedIdentity = ""
    private var identity: String { (workout?.id ?? "") + "\n" + session.serverURLString + "\n" + session.apiToken }
    private var requestKey: String { identity + "\n" + refreshRevision + "\n\(retryGeneration)" }

    var body: some View {
        TechPanel {
            TechSectionHeader(title: "荣耀指标", trailing: workout.map { nativeDay(String($0.startedAt.prefix(10))) } ?? "暂无训练")
            TechMetricGrid(minimum: 140) {
                    metric("心率", value: nativeNumber(detail?.workout.averageHeartRateBpm ?? workout?.averageHeartRateBpm, digits: 0), unit: "bpm", icon: "waveform.path.ecg")
                    metric("训练负荷", value: nativeNumber(detail?.trainingLoad?.load, digits: 0), unit: "", icon: "flame")
                    metric("步频", value: nativeNumber(detail?.workout.averageCadenceSpm, digits: 0), unit: "spm", icon: "shoeprints.fill")
                    metric("触地时间", value: nativeNumber(detail?.workout.averageGroundContactTimeMs, digits: 0), unit: "ms", icon: "figure.run")
            }
            if failed {
                Text("部分指标未能更新，已加载的指标仍保留。")
                    .font(.caption2).foregroundStyle(TechColor.muted)
                Button("重试加载指标") { retryGeneration += 1 }
                    .font(.subheadline).foregroundStyle(TechColor.cyan).frame(minHeight: 44)
                    .buttonStyle(TechPressStyle()).accessibilityIdentifier("today.metrics.retry")
            }
        }
        .task(id: requestKey) {
            // Refresh an existing card in place; a new server/workout must never
            // momentarily inherit another workout's detail.
            if loadedIdentity != identity { detail = nil }
            loadedIdentity = identity
            failed = false
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
                    Text(value).techScaledFont(20, weight: .bold, relativeTo: .title3).monospacedDigit()
                    Text(unit).font(.caption2).foregroundStyle(TechColor.muted)
                }.foregroundStyle(TechColor.ink).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Image(systemName: icon).font(.system(size: 19, weight: .medium)).foregroundStyle(TechColor.muted)
                .accessibilityHidden(true)
        }.frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(title)，\(value == "--" ? "暂无数据" : value) \(unit)")
    }
}
#endif
