#if os(iOS)
import SwiftUI
import Charts

struct TechSleepHistory: View {
    @Environment(ServerSession.self) private var session
    @State private var days: [NativeRecoveryTrend.Day] = []
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
            } else {
                Text("暂无睡眠趋势").font(.caption2).foregroundStyle(TechColor.muted)
            }
        }
        .task(id: requestKey) {
            days = []
            guard let url = session.serverURL else { return }
            let key = requestKey
            if let result = try? await RaiAPIClient().recoveryTrend(baseURL: url, token: session.apiToken),
               !Task.isCancelled, key == requestKey { days = result.days }
        }
    }
}
#endif
