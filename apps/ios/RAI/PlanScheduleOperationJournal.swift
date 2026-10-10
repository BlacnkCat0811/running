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
                  PlanFingerprint.prescriptionDigest(kind: item.kind, structure: item.structure) == item.prescriptionDigest else { return nil }
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
        operation.items = requests.map { .init(entry: $0.entry, kind: $0.kind, title: $0.workout.displayName,
            structure: $0.exportedStructure, prescriptionDigest: PlanFingerprint.prescriptionDigest(kind: $0.kind, structure: $0.exportedStructure), phase: .prepared) }
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
