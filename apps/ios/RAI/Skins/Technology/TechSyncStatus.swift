#if os(iOS)
import SwiftUI

/// Observe sync progress here, not in the entire Today view.
struct TechHomeActions: View {
    @Environment(HealthKitSync.self) private var sync
    @Environment(ServerSession.self) private var session
    @Environment(NativeAppModel.self) private var native
    @State private var userSyncBusy = false
    @State private var userSyncResult: String?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(spacing: 4) {
                Button {
                    Task {
                        let configuration = native.feedbackScope + session.apiToken
                        userSyncBusy = true
                        userSyncResult = nil
                        await sync.sync(to: session.serverURL, apiToken: session.apiToken)
                        await native.refreshAll(requestHandshake: false)
                        userSyncBusy = false
                        guard configuration == native.feedbackScope + session.apiToken else { return }
                        if sync.phase == "succeeded", sync.lastError == nil, !sync.hasPendingTask {
                            userSyncResult = "健康数据检查完成。"
                        } else if sync.phase == "cancelled" {
                            userSyncResult = "已取消同步。"
                        } else {
                            userSyncResult = "更新尚未完成，可在设置查看状态。"
                        }
                        try? await Task.sleep(for: .seconds(4))
                        userSyncResult = nil
                    }
                } label: {
                    Group {
                        if userSyncBusy { ProgressView().tint(TechColor.cyan) }
                        else { Image(systemName: "arrow.trianglehead.2.clockwise.rotate.90").font(.system(size: 19, weight: .medium)) }
                    }
                    .foregroundStyle(sync.isBusy || !session.isReachable ? TechColor.muted : TechColor.cyan).frame(width: 44, height: 44)
                    .background(TechColor.paper, in: TechSurfaceShape())
                }
                .buttonStyle(TechPressStyle()).disabled(sync.isBusy || !session.isReachable)
                .accessibilityLabel("同步健康数据")
                .accessibilityValue(sync.isBusy ? techSyncPhase(sync.phase) : !session.isReachable ? "服务未连接" : "就绪")
                Text(userSyncBusy ? "同步中" : "同步").font(.caption2).foregroundStyle(TechColor.muted)
            }
            if let userSyncResult { Text(userSyncResult).font(.caption2).foregroundStyle(TechColor.muted).accessibilityIdentifier("sync.actionResult") }
            if let today = native.today {
                homeLink("本周活动", symbol: "chart.bar.xaxis", id: "today.week") {
                    TechWeekOverviewView(data: today)
                }
                homeLink("身体指标", symbol: "heart", id: "today.body") {
                    TechBodyMetricsView(data: today)
                }
            }
            VStack(spacing: 4) {
                NavigationLink { TechPlanView() } label: {
                    Image(systemName: "calendar").font(.system(size: 19, weight: .medium))
                        .foregroundStyle(TechColor.ink).frame(width: 44, height: 44)
                        .background(TechColor.paper, in: TechSurfaceShape())
                }.buttonStyle(TechPressStyle()).accessibilityLabel("打开训练计划")
                Text("训练计划").font(.caption2).foregroundStyle(TechColor.muted)
            }
        }
    }

    private func homeLink<Destination: View>(_ title: String, symbol: String, id: String,
                                             @ViewBuilder destination: () -> Destination) -> some View {
        VStack(spacing: 4) {
            NavigationLink(destination: destination) {
                Image(systemName: symbol).font(.system(size: 19, weight: .medium))
                    .foregroundStyle(TechColor.ink).frame(width: 44, height: 44)
                    .background(TechColor.paper, in: TechSurfaceShape())
            }
            .buttonStyle(TechPressStyle()).accessibilityLabel("打开" + title)
            .accessibilityIdentifier(id)
            Text(title).font(.caption2).foregroundStyle(TechColor.muted)
        }
    }

}

struct TechSyncAction: View {
    @Environment(HealthKitSync.self) private var sync
    @Environment(ServerSession.self) private var session
    @Environment(NativeAppModel.self) private var native
    var title = "同步健康数据"
    var compact = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
          if compact {
            Button(action: performSync) {
                Label(sync.lastError == nil ? title : "重试同步", systemImage: "arrow.clockwise")
                    .font(.subheadline.weight(.medium)).foregroundStyle(TechColor.cyan)
                    .frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(TechPressStyle()).disabled(sync.isBusy || !session.isReachable)
          } else {
            TechPrimaryButton(title: sync.lastError == nil ? title : "重试同步",
                              systemName: "arrow.clockwise", isBusy: sync.isBusy,
                              isDisabled: !session.isReachable, busyTitle: techSyncPhase(sync.phase),
                              action: performSync)
          }
            if !session.isReachable {
                Text("服务未连接，请在设置中检查服务地址与网络。")
                    .font(.caption).foregroundStyle(TechColor.yellow)
            }
        }
    }
    private func performSync() {
        Task {
            await sync.sync(to: session.serverURL, apiToken: session.apiToken)
            await native.refreshAll(requestHandshake: false)
        }
    }
}

/// The freshness banner must not repeat the failure card's retry action.
struct TechFreshnessSyncAction: View {
    @Environment(HealthKitSync.self) private var sync
    var body: some View {
        if sync.lastError == nil && !sync.isBusy && sync.phase != "cancelled" {
            TechSyncAction(title: "更新健康数据", compact: true)
        }
    }
}

struct TechSyncStatus: View {
    var showsHistory = true
    var showsActions = true
    @Environment(HealthKitSync.self) private var sync
    private var state: TechSyncPresentation {
        .resolve(phase: sync.phase, isBusy: sync.isBusy, hasError: sync.lastError != nil,
                 hasSyncDate: sync.lastSyncAt != nil, hasPendingTask: sync.hasPendingTask,
                 // 阻塞判据只从 `SyncPhase` 来（本文件只被类型检查、不进任何回归单元，
                 // 所以引得到它）—— 展示层不自己抄一份阶段名单。
                 isBlockedPhase: SyncPhase.migrate(sync.phase).isBlocked)
    }
    /// 面板边框色。抽出来是因为档位从三档变成四档 —— 再套一层三元表达式，
    /// 颜色选错在深色底上根本看不出来。
    private var panelTint: Color {
        switch state {
        case .failed: return TechColor.coral
        case .cancelled: return TechColor.yellow
        case .pending: return TechColor.cyan
        default: return TechColor.success
        }
    }

    /// `.pending` 这一档的正文。三种情形（未走完 / 等解锁 / 等凭证）的原因不同，
    /// 共用一句会让其中两句变成假话 —— 尤其"数据已保存在本机"在锁屏那一支是**不成立**的。
    private var pendingDetail: String {
        switch SyncPhase.migrate(sync.phase) {
        case .deferredProtectedData:
            return "设备锁定时 Apple 健康数据不可读。解锁后会自动继续，不必手动操作。"
        case .authRequired:
            return "登录状态已失效；本地已保存的数据仍然完好，重新登录后会接着上传。"
        default:
            return "上次同步未走完，数据已保存在本机；下次连接会接着完成，不必重新读取健康数据。"
        }
    }

    /// 图标同样要分开：锁、钥匙、未完成的下载是三种不同的"等"，同一个图标会让
    /// 用户在两种完全不同的处境下看到同一个界面。
    private var pendingIcon: String {
        switch SyncPhase.migrate(sync.phase) {
        case .deferredProtectedData: return "lock.fill"
        case .authRequired: return "key.fill"
        default: return "arrow.down.circle.dotted"
        }
    }
    var body: some View {
        if state != .hidden
            && (showsHistory || state == .busy || state == .failed || state == .cancelled || state == .pending) {
            TechPanel(tint: panelTint,
                      fill: state == .succeeded ? TechColor.success.opacity(0.09) : TechColor.paper) {
                if state == .cancelled {
                    Label("同步已取消", systemImage: "pause.circle")
                        .font(.subheadline.weight(.medium)).foregroundStyle(TechColor.yellow)
                    Text("取消不会撤销已完成的数据导入，可在任务结束后重新同步。")
                        .font(.caption).foregroundStyle(TechColor.muted)
                    if showsActions { TechSyncAction(title: "重新同步", compact: true) }
                } else if state == .pending {
                    // 有一条**没走完**的进度留在磁盘上。刻意不写成失败：用户不需要做任何事，
                    // 下一次同步会从本地已落盘的那一批接着走，不必重读 HealthKit。
                    //
                    // 这一档自 V2.1 起还覆盖两个**阻塞态**（§3.3 / §3.4）：它们同样是
                    // "没走完、不用重读 HealthKit"，但原因各不相同 —— 锁屏时本机**没有**
                    // 待发数据（预检查在导出之前就返回了），而凭证失效时数据完好、缺的只是登录。
                    // 三件事共用一句正文会让其中两句变成假话，所以按阶段分流。
                    Label(techSyncPhase(sync.phase), systemImage: pendingIcon)
                        .font(.subheadline.weight(.semibold)).foregroundStyle(TechColor.cyan)
                    Text(pendingDetail)
                        .font(.caption).foregroundStyle(TechColor.muted)
                    if showsActions { TechSyncAction(title: "继续同步", compact: true) }
                } else if state == .busy {
                    Label(techSyncPhase(sync.phase), systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(TechColor.cyan)
                    Text("同步时保持应用打开；下拉刷新仅更新页面，不导入健康数据。")
                        .font(.caption).foregroundStyle(TechColor.muted)
                } else if state == .failed {
                    TechAdaptiveStack(spacing: 8) {
                        Label("同步未完成", systemImage: "exclamationmark.circle")
                            .font(.subheadline.weight(.medium)).foregroundStyle(TechColor.coral)
                        Spacer(minLength: 0)
                        TechSyncAction(compact: true)
                    }
                    DisclosureGroup {
                        Text(sync.lastError.map(techHealthError) ?? "同步未完成，请检查连接后重试。")
                            .font(.footnote).foregroundStyle(TechColor.muted)
                    } label: { Text("原因与处理方法").frame(minHeight: 44) }.font(.caption).tint(TechColor.muted)
                } else if let date = sync.lastSyncAt {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 28, weight: .medium)).foregroundStyle(TechColor.success)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 6) {
                            Text(state == .succeeded ? "健康同步完成" : "上次健康同步")
                                .font(.subheadline.weight(.semibold)).foregroundStyle(TechColor.ink)
                            Text(date, format: .dateTime.year().month().day().hour().minute())
                                .font(.caption).foregroundStyle(TechColor.muted)
                            if state == .succeeded, let message = sync.message, !message.isEmpty {
                                Text(message).font(.caption).foregroundStyle(TechColor.muted)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
            .accessibilityIdentifier("health.status")
        }
    }
}
#endif
