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
                Text(sync.hasPendingTask ? "有尚未完成的同步任务" : "暂无待处理同步任务")
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
}
#endif
