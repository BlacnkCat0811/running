#if os(iOS)
import SwiftUI

struct TechDayWorkoutsView: View {
    let localDate: String
    @Environment(ServerSession.self) private var session
    @Environment(NativeAppModel.self) private var native
    @State private var items: [WorkoutListItem] = []
    @State private var total = 0
    @State private var message: String?
    @State private var busy = false
    private var identity: String { native.feedbackScope + session.apiToken }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(items) { item in
                    NavigationLink { TechWorkoutDetailView(workoutId: item.id) } label: { TechWorkoutRow(workout: item) }
                }
                if busy { ProgressView() }
                if let message { Text(message).font(.footnote) }
                if !busy && items.isEmpty {
                    Text("暂未找到这一天的训练；不代表没有完成训练。")
                    NavigationLink("检查数据与同步") { TechDataSyncDetailView() }
                }
                if items.count < total { Button("加载更多") { Task { await load(reset: false) } }.disabled(busy) }
                Button("重新读取") { Task { await load(reset: true) } }.disabled(busy)
            }.padding(20)
        }.background(TechColor.background).foregroundStyle(TechColor.ink)
            .navigationTitle(localDate).task(id: identity) { await load(reset: true) }
    }
    private func load(reset: Bool) async {
        guard let url = session.serverURL else { return }
        let scope = identity
        if reset { items = []; total = 0 }
        busy = true; message = nil
        defer { if scope == identity { busy = false } }
        do {
            let result = try await RaiAPIClient().workouts(baseURL: url, token: session.apiToken, limit: 30,
                offset: items.count, sessionType: nil, localDate: localDate)
            guard scope == identity, !Task.isCancelled else { return }
            let seen = Set(items.map(\.id))
            items += result.items.filter { !seen.contains($0.id) }; total = result.total
        } catch { if scope == identity { message = error.localizedDescription } }
    }
}
#endif
