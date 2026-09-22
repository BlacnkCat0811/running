#if os(iOS)
import SwiftUI

/// Observe sync progress here, not in the entire Today view.
struct TechHomeActions: View {
    @Environment(HealthKitSync.self) private var sync
    @Environment(ServerSession.self) private var session
    @Environment(NativeAppModel.self) private var native

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(spacing: 4) {
                Button {
                    Task {
                        await sync.sync(to: session.serverURL, apiToken: session.apiToken)
                        await native.refreshAll(requestHandshake: false)
                    }
                } label: {
                    Group {
                        if sync.isBusy { ProgressView().tint(TechColor.cyan) }
                        else { Image(systemName: "arrow.trianglehead.2.clockwise.rotate.90").font(.system(size: 19, weight: .medium)) }
                    }
                    .foregroundStyle(TechColor.cyan).frame(width: 44, height: 44)
                    .background(TechColor.paper, in: RoundedRectangle(cornerRadius: TechMetrics.corner))
                }
                .buttonStyle(TechPressStyle()).disabled(sync.isBusy || !session.isReachable)
                .accessibilityLabel("同步健康数据")
                .accessibilityValue(sync.isBusy ? techSyncPhase(sync.phase) : !session.isReachable ? "服务未连接" : "就绪")
                Text(sync.isBusy ? "同步中" : "同步").font(.caption2).foregroundStyle(TechColor.muted)
            }
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
                        .background(TechColor.paper, in: RoundedRectangle(cornerRadius: TechMetrics.corner))
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
                    .background(TechColor.paper, in: RoundedRectangle(cornerRadius: TechMetrics.corner))
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
    @Environment(HealthKitSync.self) private var sync
    private var state: TechSyncPresentation {
        .resolve(phase: sync.phase, isBusy: sync.isBusy, hasError: sync.lastError != nil,
                 hasSyncDate: sync.lastSyncAt != nil, hasPendingTask: sync.hasPendingTask)
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
                    TechSyncAction(title: "重新同步", compact: true)
                } else if state == .pending {
                    // 有一条**没走完**的进度留在磁盘上。刻意不写成失败：用户不需要做任何事，
                    // 下一次同步会从本地已落盘的那一批接着走，不必重读 HealthKit。
                    Label(techSyncPhase(sync.phase), systemImage: "arrow.down.circle.dotted")
                        .font(.subheadline.weight(.medium)).foregroundStyle(TechColor.cyan)
                    Text("上次同步未走完，数据已保存在本机；下次连接会接着完成，不必重新读取健康数据。")
                        .font(.caption).foregroundStyle(TechColor.muted)
                    TechSyncAction(title: "继续同步", compact: true)
                } else if state == .busy {
                    Label(techSyncPhase(sync.phase), systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
                        .font(.subheadline.weight(.medium)).foregroundStyle(TechColor.cyan)
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
                            .shadow(color: TechColor.success.opacity(0.18), radius: 8)
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
