import Foundation

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
    init(storage: any PlanSchedulePersistence, snapshot: PlanSyncSnapshot, previousEntries: [PlanScheduledEntry]) {
        self.storage = storage
        operation = .init(schemaVersion: 1, operationId: UUID(), scope: snapshot.scope, goalsRevision: snapshot.revision,
            coherenceToken: snapshot.coherenceToken, serverIdentity: snapshot.serverIdentity, timezone: snapshot.timezone, windowStart: snapshot.windowStart,
            windowEnd: snapshot.windowEnd, reminderHour: snapshot.reminderHour, phase: .prepared, items: [],
            previousEntries: previousEntries, updatedAt: Date())
        operation.coachLoop = snapshot.coachLoop
    }
    init(storage: any PlanSchedulePersistence, operation: PlanScheduleOperationJournal) {
        self.storage = storage; self.operation = operation
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
        return storage.commitScheduleResult(operation, ledger: ledger, receipts: receipts)
    }
    func finishWithdrawal(ledger: PlanWatchLedger?, receipts: [PlanSyncReceipt]) -> Bool {
        operation.phase = .withdrawn; operation.updatedAt = Date()
        return storage.commitScheduleResult(operation, ledger: ledger, receipts: receipts)
    }
    func cancelBeforeSideEffect(ledger: PlanWatchLedger?) -> Bool {
        operation.items = []; operation.previousEntries = []
        return finishWithdrawal(ledger: ledger, receipts: [])
    }
}
