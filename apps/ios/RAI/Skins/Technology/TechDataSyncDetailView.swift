#if os(iOS)
import SwiftUI

struct TechDataSyncDetailView: View {
    @Environment(NativeAppModel.self) private var native
    @Environment(HealthKitSync.self) private var sync
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                TechSyncStatus(showsActions: false)
                if let date = sync.lastSyncAt {
                    Text("最近成功同步：" + nativeDate(ISO8601DateFormatter().string(from: date)))
                }
                if let summary = sync.lastExportSummary {
                    exportSummaryPanel(summary)
                }
                Text(sync.hasPendingContinuation
                     ? "有尚未读完的页，会接着读取。"
                     : sync.hasPendingTask ? "有尚未完成的同步任务" : "暂无待处理同步任务")
                if let today = native.today {
                    TechFreshnessBanner(today: today, isOffline: native.isOffline, cacheDate: native.lastCacheUpdate)
                }
                if let error = native.errorMessage { Text(error).foregroundStyle(TechColor.coral) }
                Text("最近训练日期只表示已读取到的记录，不代表此前每天的数据都完整。没有跑步、睡眠或 HRV 记录，也不一定是权限或同步故障。")
                    .font(.footnote).foregroundStyle(TechColor.muted)
                TechSyncAction()
                NavigationLink("检查服务连接") { TechNativeSettingsView() }
            }.padding(20)
        }
        .background(TechColor.background).foregroundStyle(TechColor.ink)
        .navigationTitle("数据与同步详情").navigationBarTitleDisplayMode(.inline)
    }

    /// P2-3：**本批到底带来了什么**（只展示，不新增轮询）。
    ///
    /// 数据来自 `HealthKitSync.lastExportSummary`（每批导出后更新，`markSuccess` 拿到回执后
    /// 补齐计数）。为什么必须有它：4500 条里 95% 以上是服务端已有的重复，而界面此前只有一句
    /// "同步完成" —— 于是"本批 0 新增"被读成"同步坏了"，"本批已满"被读成"这个类型零进展"。
    /// 预算停因的解释住在 `SyncExportSummaryCopy.budgetNote`（纯函数、有回归），
    /// 视图不再自己解释停因（那正是旧文案说反话的地方）。
    @ViewBuilder private func exportSummaryPanel(_ summary: ExportSummary) -> some View {
        let counts = SyncResultCopy.BatchCounts(
            parsed: summary.recordsParsed,
            inserted: summary.recordsInserted,
            unchanged: summary.recordsUnchanged
        )
        TechPanel(tint: TechColor.cyan) {
            VStack(alignment: .leading, spacing: 6) {
                Text("本批导出")
                    .font(.subheadline.weight(.semibold))
                Text(SyncExportSummaryCopy.batchLine(
                    recordCount: summary.recordCount,
                    workoutCount: summary.workoutCount,
                    routeCount: summary.routeCount
                ))
                .font(.caption.monospacedDigit()).foregroundStyle(TechColor.muted)
                if let note = SyncResultCopy.countsNote(counts) {
                    Text("服务端回执：" + note)
                        .font(.caption).foregroundStyle(TechColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let note = SyncExportSummaryCopy.budgetNote(
                    budgetStopReason: summary.budgetStopReason,
                    hasMorePages: summary.hasMorePages
                ) {
                    Text(note).font(.caption).foregroundStyle(TechColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let note = SyncExportSummaryCopy.continuationNote(hasPendingContinuation: sync.hasPendingContinuation) {
                    Text(note).font(.caption).foregroundStyle(TechColor.cyan)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sync.exportSummary")
    }
}
#endif
