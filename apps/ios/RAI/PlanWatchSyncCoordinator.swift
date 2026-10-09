import Foundation

/// Serial across views AND configuration changes. The lease may end while an
/// SDK await is in flight, but the next operation cannot start until targeted
/// cleanup completes. No autonomous scheduling or background work.
@MainActor
final class PlanWatchSyncCoordinator {
    static let shared = PlanWatchSyncCoordinator()
    private var running = false

    func sync(model: NativeAppModel, scheduler: any WorkoutScheduling) async -> String {
        guard !running, let id = model.beginPlanSync() else { return "另一次计划操作尚未结束，请稍后重试。" }
        running = true
        defer { running = false; model.endPlanSync(id) }
        guard await model.refreshPlanState(), let snapshot = model.planSyncSnapshot(id),
              let plan = model.currentWorkoutPlan else {
            return "未能确认最新完整计划，未改动系统排期。请联网刷新后重试。"
        }
        let outcome = await PlanWatchScheduling.sync(scheduler: scheduler, plan: plan,
            completedDates: snapshot.completedDates, hour: snapshot.reminderHour, now: model.planSyncNow,
            isCurrent: { model.isCurrentPlanSync(snapshot) })
        // Superseded results (including cleanup failure) MUST remain visible.
        guard !outcome.superseded else {
            model.recordWatchInterrupted(outcome, snapshot: snapshot)
            return outcome.report
        }
        guard model.isCurrentPlanSync(snapshot) else {
            let cancelled = await PlanWatchScheduling.withdrawSuperseded(outcome, scheduler: scheduler)
            model.recordWatchInterrupted(cancelled, snapshot: snapshot)
            return cancelled.report
        }
        model.recordWatchResult(outcome, snapshot: snapshot)
        let receiptMessage = await model.recordPlanSyncReceipts(outcome.receipts, snapshot: snapshot)
        guard model.isCurrentPlanSync(snapshot) else {
            let cancelled = await PlanWatchScheduling.withdrawSuperseded(outcome, scheduler: scheduler)
            model.recordWatchInterrupted(cancelled, snapshot: snapshot)
            return cancelled.report
        }
        return [outcome.report, receiptMessage].compactMap { $0 }.joined(separator: "\n")
    }

    func clear(model: NativeAppModel, scheduler: any WorkoutScheduling) async -> String {
        guard !running, let id = model.beginPlanSync(allowOffline: true) else { return "另一次计划操作尚未结束，请稍后重试。" }
        running = true
        defer { running = false; model.endPlanSync(id) }
        let outcome = await PlanWatchScheduling.clear(scheduler: scheduler, isCurrent: { model.isCurrentPlanSync(id) })
        if model.isCurrentPlanSync(id) { model.recordWatchClearResult(outcome) }
        return outcome.report
    }

    #if os(iOS)
    func sync(model: NativeAppModel) async -> String { await sync(model: model, scheduler: WorkoutKitBridge()) }
    func clear(model: NativeAppModel) async -> String { await clear(model: model, scheduler: WorkoutKitBridge()) }
    #endif
}
