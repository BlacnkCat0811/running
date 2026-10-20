import Foundation

/// The training context a device schedule was pushed under (PR6).
///
/// Why a dedicated value instead of re-deriving it from the current plan: the
/// Watch keeps whatever was last pushed. When the mode, race goal or receipt
/// contract changes, the still-installed entries were authorized under the OLD
/// context. A withdrawal must therefore be attributed to that old context and
/// must never be rejected merely because the *current* configuration differs —
/// while the new push must be attributable to the new one.
///
/// Backward compatibility: the journal keeps `schemaVersion == 1` (the cache
/// store quarantines any other value) and both journal fields that carry this
/// value are optional. An entry written before PR6 decodes with `context == nil`
/// / `replacedContext == nil`, which the switch assessment reports as "unknown
/// provenance": withdrawal of our own UUIDs still proceeds, it just cannot name
/// the configuration the schedule came from.
struct PlanScheduleContext: Codable, Equatable {
    /// Semantics version of this record. A consumer must not interpret an
    /// unknown version as "same context"; it is treated as a configuration
    /// difference (fail-closed) by `PlanScheduleContextChange.evaluate`.
    let contextVersion: Int
    /// Plan/state revision the pushed prescriptions were published from.
    let planRevision: Int
    /// Receipt contract in force (`CoachLoopReceiptContext.contractVersion`);
    /// nil means the scope-less legacy receipt shape.
    let receiptContractVersion: Int?
    /// Business (athlete-local) date the operation was prepared for.
    let businessDate: String
    /// `CoachTrainingMode` (`daily_adaptive` / `race_preparation`); nil for the
    /// legacy plan contract, which has no mode.
    let mode: String?
    /// Local identity of the declared race goal (see `raceGoalIdentity`), nil
    /// when this context declares no race goal.
    let raceGoalID: String?
    /// Coach-loop policy hash; nil for the legacy contract.
    let policyHash: String?

    static let currentVersion = 1

    /// Fields whose change alters the *authority* a receipt was produced under,
    /// as opposed to a normal re-publication of the same configuration.
    enum Difference: String, Hashable {
        case contextVersion, mode, raceGoal, receiptContract, policyHash
        case planRevision, businessDate

        /// True for the fields that switch the training configuration itself.
        var isConfiguration: Bool {
            switch self {
            case .contextVersion, .mode, .raceGoal, .receiptContract, .policyHash: return true
            case .planRevision, .businessDate: return false
            }
        }
    }

    init(planRevision: Int, receiptContractVersion: Int?, businessDate: String, mode: String?,
         raceGoalID: String?, policyHash: String?, contextVersion: Int = PlanScheduleContext.currentVersion) {
        self.contextVersion = contextVersion
        self.planRevision = planRevision
        self.receiptContractVersion = receiptContractVersion
        self.businessDate = businessDate
        self.mode = mode
        self.raceGoalID = raceGoalID
        self.policyHash = policyHash
    }

    /// Canonical race-goal identity. Deliberately local and server-independent:
    /// the legacy dashboard target (date + distance band) and the coach-loop race
    /// settings (date + distance + goal type) both reduce to one stable string,
    /// so editing the goal (e.g. moving the race date) is detected as a context
    /// switch even when the server keeps the same plan revision.
    static func raceGoalIdentity(date: String?, distance: String?, goal: String?) -> String? {
        guard let date, !date.isEmpty else { return nil }
        return [date, distance ?? "~", goal ?? "~"].joined(separator: "|")
    }

    static func raceGoalIdentity(date: String?, distanceKm: Double?, goal: String?) -> String? {
        raceGoalIdentity(date: date, distance: distanceKm.map { String($0) }, goal: goal)
    }

    func differences(from previous: PlanScheduleContext) -> [Difference] {
        var values: [Difference] = []
        if contextVersion != previous.contextVersion { values.append(.contextVersion) }
        if mode != previous.mode { values.append(.mode) }
        if raceGoalID != previous.raceGoalID { values.append(.raceGoal) }
        if receiptContractVersion != previous.receiptContractVersion { values.append(.receiptContract) }
        if policyHash != previous.policyHash { values.append(.policyHash) }
        if planRevision != previous.planRevision { values.append(.planRevision) }
        if businessDate != previous.businessDate { values.append(.businessDate) }
        return values
    }
}

/// What changed between the context the installed schedule was pushed under and
/// the context a new push is about to use (PR6).
enum PlanScheduleContextChange: Equatable {
    /// No previous context is on record: a first push, a full explicit clear, or
    /// a journal written before PR6. The normal identity-verified replacement
    /// still applies; an unknown provenance never blocks taking our own entries
    /// back, and never fabricates a "mode switch" claim either.
    case unknown
    /// Same configuration and same publication. A re-push is idempotent.
    case same
    /// Same configuration, newer plan publication or business day.
    case refresh([PlanScheduleContext.Difference])
    /// Mode / race goal / receipt contract / policy changed: the installed entries
    /// were pushed under a different authority and must be withdrawn — verified,
    /// withdrawn, read back empty, and only then registered — before a new push.
    case switchContext([PlanScheduleContext.Difference])

    static func evaluate(previous: PlanScheduleContext?, current: PlanScheduleContext?) -> PlanScheduleContextChange {
        guard let previous, let current else { return .unknown }
        if previous == current { return .same }
        let differences = current.differences(from: previous)
        guard !differences.isEmpty else { return .same }
        return differences.contains(where: \.isConfiguration) ? .switchContext(differences) : .refresh(differences)
    }

    var isConfigurationSwitch: Bool {
        if case .switchContext = self { return true }
        return false
    }

    var differences: [PlanScheduleContext.Difference] {
        switch self {
        case .unknown, .same: return []
        case .refresh(let values), .switchContext(let values): return values
        }
    }
}

/// Admission decisions for device receipts entering the durable operation journal.
///
/// Why a policy instead of trusting every receipt: a receipt that names another
/// server/athlete/dataset would attribute device evidence to a different data
/// set, and it could never be withdrawn through this journal. A receipt that
/// merely carries an OLDER context (previous revision, previous coach-loop
/// policy, or the other training mode) is exactly what a withdrawal or
/// replacement has to be registered against, so it is admitted as history and
/// never dropped because the current mode differs.
enum PlanScheduleReceiptAdmission {
    enum Decision: Equatable {
        /// Same context identity: current device evidence.
        case admit
        /// Older context: withdrawal/replacement evidence, never relabelled as
        /// current. This is the decision that keeps a mode switch recoverable.
        case admitHistory
        /// Equivalent receipt already present in this batch: idempotent, not
        /// applied twice.
        case duplicate
        /// Names another server/athlete/dataset (or an unrepresentable contract):
        /// must not be journaled or posted.
        case rejectScopeMismatch
    }

    struct Result: Equatable {
        var admitted: [PlanSyncReceipt] = []
        var rejected: [PlanSyncReceipt] = []
        var duplicateCount = 0
        var historyCount = 0
    }

    /// Stable identity of one receipt for idempotency. Receipts produced by the
    /// v2 contract always carry `idempotencyKey`; legacy receipts do not, so the
    /// fallback must be equally stable across retries of the same export.
    static func dedupeKey(_ receipt: PlanSyncReceipt) -> String {
        if let key = receipt.idempotencyKey, !key.isEmpty { return "key:" + key }
        let event = receipt.lifecycleEvent ?? "verified"
        if let workoutID = receipt.workoutID, !workoutID.isEmpty {
            return "workout:\(workoutID.uppercased())|\(event)|\(receipt.localDate)"
        }
        return "legacy:\(receipt.localDate)|\(receipt.kind)|\(receipt.revision)|\(event)"
    }

    static func classify(_ receipt: PlanSyncReceipt, identity: PlanReceiptScope?, context: PlanScheduleContext?,
                         seen: Set<String>) -> Decision {
        // 1. Scope identity is never negotiated away. A v2 receipt without a scope
        //    is not provably ours either, so it is rejected with the same reason.
        //    A journal that predates the recorded identity (nil) cannot prove a
        //    mismatch, so it keeps the pre-PR6 behaviour and lets the server —
        //    which is the authority on receipt scope — reject a foreign receipt.
        if receipt.contractVersion != nil || receipt.scope != nil {
            guard receipt.contractVersion == 2 else { return .rejectScopeMismatch }
            guard let scope = receipt.scope else { return .rejectScopeMismatch }
            if let identity, scope != identity { return .rejectScopeMismatch }
        }
        // 2. Idempotency before context: a replay must not be counted as a new
        //    (or older) event even when the current context has since moved on.
        if seen.contains(dedupeKey(receipt)) { return .duplicate }
        // 3. Older context: admitted, but flagged so no caller can mistake it for
        //    current evidence. Without a recorded context nothing can be proven,
        //    and the server remains the authority on the receipt's currency.
        guard let context else { return .admit }
        let event = receipt.lifecycleEvent ?? "verified"
        var older = false
        if receipt.revision != context.planRevision { older = true }
        if let expected = context.policyHash, receipt.coachLoop?.policyHash != expected { older = true }
        if let contract = context.receiptContractVersion,
           receipt.coachLoop == nil || receipt.coachLoop?.contractVersion != contract { older = true }
        if context.mode == nil, receipt.coachLoop != nil { older = true }
        if context.mode != nil, receipt.coachLoop == nil { older = true }
        // A lifecycle event always describes an entry that is being taken back;
        // it is history by definition, never current coverage.
        if event != "verified" { older = true }
        return older ? .admitHistory : .admit
    }

    static func admit(_ receipts: [PlanSyncReceipt], identity: PlanReceiptScope?,
                      context: PlanScheduleContext?) -> Result {
        var result = Result()
        var seen = Set<String>()
        for receipt in receipts {
            switch classify(receipt, identity: identity, context: context, seen: seen) {
            case .admit:
                result.admitted.append(receipt)
            case .admitHistory:
                result.admitted.append(receipt); result.historyCount += 1
            case .duplicate:
                result.duplicateCount += 1
            case .rejectScopeMismatch:
                result.rejected.append(receipt)
            }
            seen.insert(dedupeKey(receipt))
        }
        return result
    }
}

struct PlanScheduleOperationJournal: Codable, Equatable {
    enum Phase: String, Codable { case prepared, clearing, scheduling, verifying, verified, partial, withdrawalRequired, withdrawn, interrupted }
    enum ItemPhase: String, Codable { case prepared, submitting, returned, confirmed, withdrawing, withdrawn }
    struct Item: Codable, Equatable {
        let entry: PlanScheduledEntry
        let kind: String
        let title: String
        let structure: MobileSessionStructure
        let prescriptionDigest: String
        var phase: ItemPhase
    }
    let schemaVersion: Int
    let operationId: UUID
    let scope: String
    let goalsRevision: Int
    let coherenceToken: String?
    let serverIdentity: PlanReceiptScope?
    let timezone: String
    let windowStart: String?
    let windowEnd: String?
    let reminderHour: Int
    var phase: Phase
    var items: [Item]
    var previousEntries: [PlanScheduledEntry]
    var updatedAt: Date
    var clearAll = false
    var coachLoop: CoachLoopReceiptContext? = nil
    /// The context this operation is pushing under (PR6). Optional so a payload
    /// written before PR6 keeps decoding; nil means "not captured", never
    /// "same as the replaced context".
    var context: PlanScheduleContext? = nil
    /// The context the entries this operation withdraws were pushed under (PR6).
    /// Persisted with the first write-ahead record, so a crash mid-switch leaves
    /// the old authority explicit and the operation recoverable.
    var replacedContext: PlanScheduleContext? = nil
    var terminal: Bool { [.verified, .withdrawn].contains(phase) }

    func requests() -> [PlanSchedulingRequest] {
        guard let zone = TimeZone(identifier: timezone) else { return [] }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
        return items.compactMap { item in
            let day = MobileWorkoutPlanDay(localDate: item.entry.localDate, kind: item.kind, title: item.title, reason: "",
                distanceKm: nil, durationMinutes: nil, paceSecondsPerKmLower: nil, paceSecondsPerKmUpper: nil,
                heartRateBpmLower: nil, heartRateBpmUpper: nil, structure: item.structure, source: "manual", executable: true)
            guard let mapped = WorkoutPlanMapper.plannedWorkout(from: day, hour: reminderHour),
                  WorkoutPlanMapper.safeExportedStructure(mapped, original: item.structure) != nil,
                  // 摘要在数值不可量化时返回 nil（2026-10-18 审查 P2-13）：
                  // 无法重建"原操作的真实导出身份"，按 fail-closed 拒绝该条，由调用方
                  // 提示"只能显式撤回"。
                  (try? PlanFingerprint.prescriptionDigest(kind: item.kind, structure: item.structure)) == item.prescriptionDigest else { return nil }
            var at = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: item.entry.scheduledAt)
            at.timeZone = zone
            return .init(entry: item.entry, at: at, workout: mapped, exportedStructure: item.structure, exportNotes: [], kind: item.kind)
        }
    }
}

@MainActor
protocol PlanSchedulePersistence: AnyObject {
    func scheduleJournalResult() -> CacheReadResult<PlanScheduleOperationJournal>
    func saveScheduleJournal(_ value: PlanScheduleOperationJournal) -> Bool
    func commitScheduleResult(_ operation: PlanScheduleOperationJournal, ledger: PlanWatchLedger?, receipts: [PlanSyncReceipt]) -> Bool
    func recordPlanDiagnostic(_ value: PlanDiagnosticEvent)
}

extension PlanSchedulePersistence {
    func recordPlanDiagnostic(_ value: PlanDiagnosticEvent) {}
}

@MainActor
final class PlanScheduleJournal {
    private let storage: any PlanSchedulePersistence
    private(set) var operation: PlanScheduleOperationJournal
    /// Context of the last durably persisted operation, captured before this
    /// operation overwrites the journal row (PR6). Nil means we never recorded
    /// one: first push, an explicit full clear, or a journal written before the
    /// context existed. It is read-only evidence for the switch assessment and
    /// is never used to block a withdrawal.
    private(set) var previousContext: PlanScheduleContext?

    init(storage: any PlanSchedulePersistence, snapshot: PlanSyncSnapshot, previousEntries: [PlanScheduledEntry]) {
        self.storage = storage
        // A read, never a write: the row still describes the previously pushed
        // operation. `scheduleJournalResult()` reports failure for corrupt or
        // future schemas, in which case provenance stays unknown (nil).
        let previous = storage.scheduleJournalResult().value?.context
        previousContext = previous
        operation = .init(schemaVersion: 1, operationId: UUID(), scope: snapshot.scope, goalsRevision: snapshot.revision,
            coherenceToken: snapshot.coherenceToken, serverIdentity: snapshot.serverIdentity, timezone: snapshot.timezone, windowStart: snapshot.windowStart,
            windowEnd: snapshot.windowEnd, reminderHour: snapshot.reminderHour, phase: .prepared, items: [],
            previousEntries: previousEntries, updatedAt: Date())
        operation.coachLoop = snapshot.coachLoop
        operation.replacedContext = previous
    }
    init(storage: any PlanSchedulePersistence, operation: PlanScheduleOperationJournal) {
        self.storage = storage; self.operation = operation
        previousContext = operation.replacedContext
    }
    /// Records the context captured by the caller (coordinator) from the plan
    /// snapshot plus the store.
    ///
    /// Why not derive it here: `PlanSyncSnapshot` deliberately carries no coach
    /// settings and no race goal (they live in `TrainingPlanStore`), while the
    /// journal must persist exactly what the server compares receipts against.
    /// Callers that never attach a context keep the pre-PR6 behaviour.
    func attachContext(_ value: PlanScheduleContext) { operation.context = value }
    /// Applies the receipt admission policy to this operation's own identity.
    func admitReceipts(_ receipts: [PlanSyncReceipt]) -> PlanScheduleReceiptAdmission.Result {
        PlanScheduleReceiptAdmission.admit(receipts, identity: operation.serverIdentity, context: operation.context)
    }
    func prepare(_ requests: [PlanSchedulingRequest]) -> Bool {
        // 2026-10-18（审查 P2-13）：摘要计算遇到不可量化数值会抛错。这里在持久化
        // 意图之前 fail-closed（返回 false，不产生 SDK 副作用），不猜测成某个剂量。
        var prepared: [PlanScheduleOperationJournal.Item] = []
        for request in requests {
            guard let digest = try? PlanFingerprint.prescriptionDigest(kind: request.kind, structure: request.exportedStructure) else {
                return false
            }
            prepared.append(.init(entry: request.entry, kind: request.kind, title: request.workout.displayName,
                structure: request.exportedStructure, prescriptionDigest: digest, phase: .prepared))
        }
        operation.items = prepared
        return persist(.prepared)
    }
    func prepareClear() -> Bool {
        operation.clearAll = true
        return persist(.prepared)
    }
    func persist(_ phase: PlanScheduleOperationJournal.Phase, entry: UUID? = nil, itemPhase: PlanScheduleOperationJournal.ItemPhase? = nil) -> Bool {
        let previousTime = operation.updatedAt
        operation.phase = phase; operation.updatedAt = Date()
        if let entry, let itemPhase, let index = operation.items.firstIndex(where: { $0.entry.workoutID == entry }) { operation.items[index].phase = itemPhase }
        let persisted = storage.saveScheduleJournal(operation)
        storage.recordPlanDiagnostic(.init(at: operation.updatedAt, name: "schedule_" + phase.rawValue, scopeDigest: operation.scope,
            operationId: operation.operationId.uuidString, revision: operation.goalsRevision, owed: operation.items.count,
            confirmed: operation.items.filter { $0.phase == .confirmed }.count, errorCode: persisted ? nil : "storage_unavailable",
            durationMilliseconds: max(0, operation.updatedAt.timeIntervalSince(previousTime) * 1000)))
        return persisted
    }
    /// 记录一条**不可核验/降级**类诊断（2026-10-18 深度审查 P3-25 / P3-27）。
    ///
    /// 与 `persist` 里的"阶段推进"诊断不同，这条不改变操作阶段 —— 它只负责让"某件事无法
    /// 按身份判定"留下痕迹。此前这类形态（例如计划的业务时区字符串无法解析）在 UI 上只会
    /// 表现为一句笼统的"未能确认撤回"，而导出诊断里没有任何可归因的码。
    func recordDiagnostic(name: String, errorCode: String?, owed: Int? = nil, confirmed: Int? = nil) {
        storage.recordPlanDiagnostic(.init(
            at: Date(), name: name, scopeDigest: operation.scope,
            operationId: operation.operationId.uuidString, revision: operation.goalsRevision,
            owed: owed, confirmed: confirmed, errorCode: errorCode))
    }
    func finish(ledger: PlanWatchLedger?, receipts: [PlanSyncReceipt], verified: Bool) -> Bool {
        operation.phase = verified ? .verified : .partial; operation.updatedAt = Date()
        let confirmed = Set(ledger?.entries.map(\.workoutID) ?? [])
        for index in operation.items.indices where confirmed.contains(operation.items[index].entry.workoutID) { operation.items[index].phase = .confirmed }
        return storage.commitScheduleResult(operation, ledger: ledger, receipts: admittedRecords(receipts))
    }
    func finishWithdrawal(ledger: PlanWatchLedger?, receipts: [PlanSyncReceipt]) -> Bool {
        operation.phase = .withdrawn; operation.updatedAt = Date()
        return storage.commitScheduleResult(operation, ledger: ledger, receipts: admittedRecords(receipts))
    }
    /// Receipts that may be journaled, after the admission policy ran (PR6).
    ///
    /// Filtered here as well as in the coordinator because `finish` is also
    /// reached from the recovery path, where a stale receipt from another
    /// server/dataset must never be persisted as this operation's evidence.
    /// Rejections and duplicates are recorded as diagnostics so the loss is
    /// attributable instead of silent.
    private func admittedRecords(_ receipts: [PlanSyncReceipt]) -> [PlanSyncReceipt] {
        let admission = admitReceipts(receipts)
        if !admission.rejected.isEmpty {
            recordDiagnostic(name: "schedule_receipt_scope_mismatch", errorCode: "receipt_scope_mismatch",
                            owed: receipts.count, confirmed: admission.admitted.count)
        }
        if admission.duplicateCount > 0 {
            recordDiagnostic(name: "schedule_receipt_duplicate", errorCode: "receipt_duplicate",
                            owed: receipts.count, confirmed: admission.admitted.count)
        }
        return admission.admitted
    }
    func cancelBeforeSideEffect(ledger: PlanWatchLedger?) -> Bool {
        operation.items = []; operation.previousEntries = []
        return finishWithdrawal(ledger: ledger, receipts: [])
    }
}
