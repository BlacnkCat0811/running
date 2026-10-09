#if os(iOS)
import SwiftUI

/// Same explicit system-schedule controls on coach and manual pages, including
/// offline/no-plan/ended states. Natural-week progress stays outside this section.
struct TechPlanWatchSection: View {
    @Environment(NativeAppModel.self) private var native
    let allowsSynchronization: Bool
    @State private var message: String?
    @State private var diagnosticURL: URL?

    private var plan: MobileWorkoutPlanResponse? { native.planPresentation.executablePlan }
    private var hour: Int { TrainingReminders.storedHour(scope: native.feedbackScope) }

    var body: some View {
        TechPanel(tint: native.watchNeedsUpdate || native.watchNeedsClear ? TechColor.coral : TechColor.grid) {
            VStack(alignment: .leading, spacing: 12) {
                TechSectionHeader(title: "手表课表", trailing: native.watchStatusLabel, trailingColor: TechColor.muted)
                Text("核验的是本机系统训练日程，不代表配对手表已收到；请在手表确认实际可见。")
                    .font(.caption).foregroundStyle(TechColor.muted)
                if native.goals?.weekPlanReplanRequired == true {
                    Text("旧模型课表的未来安排已停用，请重新预览规则课表。手表上的旧排期不会自动撤回，请手动同步以撤回或替换。")
                        .font(.caption).foregroundStyle(TechColor.coral)
                }
                if let ledger = native.watchLedger {
                    Text("上次记录：v\(ledger.revision) · \(ledger.entries.count) 项 · \(nativeDate(ISO8601DateFormatter().string(from: ledger.confirmedAt)))；不是本次核验。")
                        .font(.caption2).foregroundStyle(TechColor.muted)
                    if ledger.requiresWithdrawal == true {
                        Text("中断操作曾提交条目，撤回尚未确认，请显式撤回。").font(.caption).foregroundStyle(TechColor.coral)
                    }
                }
                if let plan {
                    if let audit = plan.audit {
                        Text(NativeAppModel.planSourceName(audit.generatedBy)).font(.caption2).foregroundStyle(TechColor.muted)
                    }
                    DisclosureGroup {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("从今天起的滚动执行窗口，与自然周进度分开；暂不可执行的日期不会下发。排期时刻 \(String(format: "%02d:00", hour))。")
                                .font(.caption).foregroundStyle(TechColor.muted)
                            ForEach(plan.days) { day in TechExecutablePlanDay(day: day) }
                        }.padding(.top, 6)
                    } label: {
                        Text("未来 \(plan.windowDays) 日系统排期（含今天） · v\(plan.planRevision)")
                            .font(.caption.weight(.semibold)).frame(minHeight: 44)
                    }.tint(TechColor.cyan)
                } else {
                    Text(native.workoutPlanError ?? native.planPresentation.availability.message)
                        .font(.caption).foregroundStyle(TechColor.yellow)
                }
                if allowsSynchronization {
                    TechPrimaryButton(title: "同步跑步课表到系统日程", systemName: "applewatch",
                        isBusy: native.isSyncingPlan, isDisabled: native.isPlanBusy || native.isOffline || plan == nil || native.hasInterruptedSchedule) {
                        synchronize()
                    }
                    .accessibilityIdentifier("plan.watch.sync")
                }
                Button("撤回 RAI 系统旧排期", role: .destructive, action: withdraw)
                    .disabled(native.isPlanBusy)
                    .accessibilityIdentifier("plan.watch.clear")
                if native.hasInterruptedSchedule {
                    Text("操作中断后不会自动继续排期。请选择核验原条目或撤回；离线和无计划时仍可操作。")
                        .font(.caption).foregroundStyle(TechColor.coral)
                    Button("核验中断操作的系统日程") {
                        Task { message = await PlanWatchSyncCoordinator.shared.recover(model: native, withdraw: false) }
                    }.disabled(native.isPlanBusy || native.scheduleStorageIssue)
                    Button("撤回中断操作的条目", role: .destructive) {
                        Task { message = await PlanWatchSyncCoordinator.shared.recover(model: native, withdraw: true) }
                    }.disabled(native.isPlanBusy || native.scheduleStorageIssue)
                }
                if let issue = native.planPresentation.issue {
                    Text("\(issue.code.rawValue)：\(issue.message)").font(.caption).foregroundStyle(TechColor.yellow)
                }
                if native.handshake?.planSnapshotContractVersion == nil {
                    Text("旧服务只校验共享版本，不提供完整事实快照保证；升级服务后可启用强一致读取。")
                        .font(.caption2).foregroundStyle(TechColor.muted)
                }
                if native.handshake?.planReceiptContractVersion != 2 {
                    Text("此服务使用旧回执协议，不能登记事实令牌或撤回事件；本机核验与服务端登记分开处理。")
                        .font(.caption2).foregroundStyle(TechColor.muted)
                }
                if native.hasPendingPlanPublication {
                    Button("确认上次发布结果") { Task { message = await native.resolvePlanPublication() } }
                        .disabled(native.isOffline || native.isPlanBusy)
                }
                if native.hasPendingPlanReceipts {
                    Button("重试登记已核验日期") {
                        Task { message = await native.retryPlanSyncReceipts() }
                    }.disabled(native.isOffline || native.isPlanBusy)
                }
                Button("准备脱敏计划诊断包") {
                    diagnosticURL = native.exportPlanDiagnostics()
                    if diagnosticURL == nil { message = "诊断记录无法读取或导出；不会包含令牌、路线或原始健康数据。" }
                }
                if let diagnosticURL { ShareLink("分享脱敏计划诊断", item: diagnosticURL) }
                if let message { Text(message).font(.caption).foregroundStyle(TechColor.muted).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("plan.watch.result") }
                if let message = native.planMessage { Text(message).font(.caption).foregroundStyle(TechColor.muted) }
                if native.planPersistenceFailed { Text(native.errorMessage ?? "本地确认记录未持久化，请联网刷新。") .font(.caption).foregroundStyle(TechColor.coral) }
            }
        }
    }

    private func synchronize() {
        Task { message = await PlanWatchSyncCoordinator.shared.sync(model: native) }
    }
    private func withdraw() {
        Task { message = await PlanWatchSyncCoordinator.shared.clear(model: native) }
    }
}
#endif
