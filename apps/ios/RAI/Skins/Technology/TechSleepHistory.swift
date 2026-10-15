#if os(iOS)
import SwiftUI
import Charts

struct TechSleepHistory: View {
    @Environment(ServerSession.self) private var session
    @State private var days: [NativeRecoveryTrend.Day] = []
    /// 加载失败 ≠ 没有记录（2026-10-15 审查 🟡-B6）：此前 `try?` 把两者折成同一个空数组，
    /// 网络 / 契约失败看起来像"暂无睡眠趋势"，且没有任何重试入口。
    @State private var loadFailed = false
    @State private var reloadCounter = 0
    private var requestKey: String { session.serverURLString + session.apiToken }
    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if days.contains(where: { $0.sleepMinutes != nil }) {
                Chart(days) { day in
                    if let minutes = day.sleepMinutes {
                        BarMark(x: .value("日期", day.date), y: .value("睡眠小时", minutes / 60), width: .ratio(0.6))
                            .foregroundStyle(TechColor.energy)
                            .accessibilityLabel(nativeDay(day.date))
                            .accessibilityValue(nativeHoursMinutes(minutes))
                    }
                }
                .chartXScale(domain: days.map(\.date))
                .chartXAxis(.hidden).chartYAxis(.hidden)
                .frame(width: 108, height: 38)
                Text("近 14 天 · 小时").font(.caption2).foregroundStyle(TechColor.muted)
            } else if loadFailed {
                Text("睡眠趋势加载失败").font(.caption2).foregroundStyle(TechColor.yellow)
                Button("重试") { reloadCounter += 1 }
                    .font(.caption2).buttonStyle(.plain).foregroundStyle(TechColor.cyan)
            } else {
                Text("暂无睡眠趋势").font(.caption2).foregroundStyle(TechColor.muted)
            }
        }
        .task(id: "\(requestKey)#\(reloadCounter)") {
            days = []
            loadFailed = false
            guard let url = session.serverURL else { return }
            let key = requestKey
            do {
                let result = try await RaiAPIClient().recoveryTrend(baseURL: url, token: session.apiToken)
                guard !Task.isCancelled, key == requestKey else { return }
                days = result.days
            } catch {
                guard !Task.isCancelled, key == requestKey else { return }
                loadFailed = true
            }
        }
    }
}
#endif
