import Foundation

/// Serial across views AND configuration changes. The lease may end while an
/// SDK await is in flight, but the next operation cannot start until targeted
/// cleanup completes. No autonomous scheduling or background work.
@MainActor
final class PlanWatchSyncCoordinator {
    static let shared = PlanWatchSyncCoordinator()
    private var running = false

    func sync(model: NativeAppModel, scheduler: any WorkoutScheduling) async -> String {
        guard !model.hasInterruptedSchedule else { return "上次排期操作中断，请先在前台核验或撤回，不能覆盖未结束账目。" }
        guard !running, let id = model.beginPlanSync() else { return "另一次计划操作尚未结束，请稍后重试。" }
        running = true
        defer { running = false; model.endPlanSync(id) }
        guard await model.refreshPlanState(), let snapshot = model.planSyncSnapshot(id),
              let plan = model.currentWorkoutPlan else {
            return "未能确认最新完整计划，未改动系统排期。请联网刷新后重试。"
        }
        guard let journal = model.makeScheduleJournal(snapshot: snapshot) else { return "本地安全存储无法读取，未改动系统排期。请先恢复账目。" }
        // PR6: a `PlanSyncSnapshot` deliberately carries no coach settings and no
        // race goal (they live in `TrainingPlanStore`), yet exactly those fields
        // decide whether the receipts belong to the same training authority. They
        // are captured onto the journal BEFORE the first persistent write, so a
        // mode/config switch is durable even if this operation is interrupted.
        journal.attachContext(Self.trainingContext(model: model, snapshot: snapshot))
        let outcome = await PlanWatchScheduling.sync(scheduler: scheduler, plan: plan,
            completedDates: snapshot.completedDates, hour: snapshot.reminderHour, now: model.planSyncNow,
            journal: journal,
            isCurrent: { model.isCurrentPlanSync(snapshot) })
        model.diagnoseSchedule(outcome, journal: journal)
        // Superseded results (including cleanup failure) MUST remain visible.
        guard !outcome.superseded else {
            model.recordWatchInterrupted(outcome, snapshot: snapshot, journal: journal)
            return outcome.report
        }
        guard model.isCurrentPlanSync(snapshot) else {
            let cancelled = await PlanWatchScheduling.withdrawSuperseded(outcome, scheduler: scheduler, journal: journal)
            model.recordWatchInterrupted(cancelled, snapshot: snapshot, journal: journal)
            return cancelled.report
        }
        let enriched = model.enrichPlanReceipts(outcome.receipts, snapshot: snapshot, operationID: journal.operation.operationId)
        // PR6: a receipt from another server/athlete/dataset must never be journaled
        // or posted; equivalents stay idempotent. A receipt from an OLDER context is
        // admitted (as history) because withdrawal/replacement must still register.
        let admission = journal.admitReceipts(enriched)
        if !admission.rejected.isEmpty || admission.duplicateCount > 0 {
            journal.recordDiagnostic(name: "schedule_receipt_admission",
                errorCode: !admission.rejected.isEmpty ? "receipt_scope_mismatch" : "receipt_duplicate",
                owed: enriched.count, confirmed: admission.admitted.count)
        }
        let receipts = admission.admitted
        guard outcome.storageError == nil else { model.scheduleStateChanged(); return outcome.report }
        if !model.commitWatchResult(outcome, snapshot: snapshot, journal: journal, receipts: receipts) {
            return outcome.report + "\n系统副作用后的本地账目提交失败，需重新核验；不能继续登记回执。"
        }
        let receiptMessage = await model.recordPlanSyncReceipts(receipts, snapshot: snapshot)
        guard model.isCurrentPlanSync(snapshot) else {
            let cancelled = await PlanWatchScheduling.withdrawSuperseded(outcome, scheduler: scheduler, journal: journal)
            model.recordWatchInterrupted(cancelled, snapshot: snapshot, journal: journal)
            return cancelled.report
        }
        return [outcome.report, receiptMessage].compactMap { $0 }.joined(separator: "\n")
    }

    func clear(model: NativeAppModel, scheduler: any WorkoutScheduling) async -> String {
        guard !running, let id = model.beginPlanSync(allowOffline: true) else { return "另一次计划操作尚未结束，请稍后重试。" }
        running = true
        defer { running = false; model.endPlanSync(id) }
        guard let journal = model.makeClearJournal() else { return "本地安全存储无法读取，撤回意图不能持久化，请先恢复账目。" }
        let previous = model.watchLedger
        let outcome = await PlanWatchScheduling.clear(scheduler: scheduler, journal: journal, isCurrent: { model.isCurrentPlanSync(id) })
        if model.isCurrentPlanSync(id) {
            if outcome.verified {
                guard model.commitScheduleWithdrawal(journal: journal, previous: previous, empty: true) else {
                    return "系统日程已读回为空，但撤回账目未能原子提交；请重新核验。"
                }
                if !model.isOffline { await model.recordScheduleLifecycle(event: "withdrawn", ledger: previous) }
            } else { model.recordWatchClearFailure(outcome) }
        }
        model.scheduleStateChanged()
        return outcome.report
    }

    func recover(model: NativeAppModel, scheduler: any WorkoutScheduling, withdraw: Bool) async -> String {
        guard !running, let journal = model.interruptedScheduleJournal(), let id = model.beginPlanSync(allowOffline: true) else {
            return "没有可读取的待核验操作，或另一操作尚未结束。"
        }
        running = true
        defer { running = false; model.endPlanSync(id); model.scheduleStateChanged() }
        let result = await PlanWatchScheduling.recover(scheduler: scheduler, journal: journal, withdraw: withdraw,
            isCurrent: { model.isCurrentPlanSync(id) })
        model.diagnoseSchedule(result, journal: journal)
        guard model.isCurrentPlanSync(id) else { return "操作已失效，请重新核验。" }
        return await model.recordRecoveredSchedule(result, journal: journal, withdraw: withdraw)
    }

    /// Captures the training context a push happens under (PR6).
    ///
    /// Why combine snapshot and store: the snapshot proves the plan/state
    /// revision, the business date and the receipt contract, but it deliberately
    /// excludes coach settings and the race goal — exactly the fields that decide
    /// whether two pushes belong to the same training authority. A mode/race edit
    /// between two pushes must be read from the store and frozen onto the journal.
    private static func trainingContext(model: NativeAppModel, snapshot: PlanSyncSnapshot) -> PlanScheduleContext {
        .init(planRevision: snapshot.revision,
              receiptContractVersion: snapshot.coachLoop?.contractVersion,
              businessDate: snapshot.localDate,
              mode: model.isCoachLoopManaged ? model.coachLoop?.settings?.mode : nil,
              raceGoalID: Self.raceGoalID(model),
              policyHash: snapshot.coachLoop?.policyHash)
    }

    /// Local identity of the declared race goal: the coach-loop race settings when
    /// the new contract is active, the legacy goals target otherwise. Both reduce
    /// to one stable string, so moving the race date or distance counts as a
    /// configuration switch and forces withdrawal before the new schedule.
    private static func raceGoalID(_ model: NativeAppModel) -> String? {
        if model.isCoachLoopManaged {
            guard let race = model.coachLoop?.settings?.race else { return nil }
            return PlanScheduleContext.raceGoalIdentity(date: race.raceDate, distanceKm: race.raceDistanceKm, goal: race.goal)
        }
        guard let target = model.goals?.raceTarget else { return nil }
        return PlanScheduleContext.raceGoalIdentity(date: target.date, distance: target.distance, goal: nil)
    }

    #if os(iOS)
    func sync(model: NativeAppModel) async -> String { await sync(model: model, scheduler: WorkoutKitBridge()) }
    func clear(model: NativeAppModel) async -> String { await clear(model: model, scheduler: WorkoutKitBridge()) }
    func recover(model: NativeAppModel, withdraw: Bool) async -> String { await recover(model: model, scheduler: WorkoutKitBridge(), withdraw: withdraw) }
    #endif
}
