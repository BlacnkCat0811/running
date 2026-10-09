import Foundation

/// Shared builders: safety metadata is explicit, never supplied by optimistic
/// decode defaults. JSON fixtures are derived from real Codable DTOs.
enum PlanTestFixtures {
    static func day(_ date: String, executable: Bool = true, meters: Double = 4000) -> MobileWorkoutPlanDay {
        .init(localDate: date, kind: "easy", title: "轻松跑", reason: "",
            distanceKm: meters / 1000, durationMinutes: nil, paceSecondsPerKmLower: nil,
            paceSecondsPerKmUpper: nil, heartRateBpmLower: nil, heartRateBpmUpper: nil,
            structure: .init(warmup: nil, blocks: [.init(iterations: 1, steps: [.init(purpose: "work", goal: .distance(meters: meters), alert: nil)])], cooldown: nil),
            source: "heuristic", executable: executable)
    }
    static func plan(revision: Int = 12, dates: [String] = ["2026-10-09", "2026-10-10", "2026-10-11"], timezone: String = "Asia/Shanghai") -> MobileWorkoutPlanResponse {
        .init(generatedAt: "2026-10-08T00:00:00Z", timezone: timezone, windowDays: 7, planRevision: revision, audit: nil, days: dates.map { day($0) })
    }
    static func json<V: Encodable>(_ value: V) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }
}

@MainActor
final class FakeWorkoutScheduler: WorkoutScheduling {
    var isSupported = true
    var capacity = 10
    var state = "authorized"
    var listed: [PlanSchedulingReadback] = []
    var submitted: [PlanSchedulingRequest] = []
    var removed: [UUID] = []
    var silentlyFailClear = false
    var silentlyFailRemoval = false
    var silentDates = Set<String>()
    var rejectDates = Set<String>()
    var readTransform: (([PlanSchedulingReadback]) -> [PlanSchedulingReadback])?
    var event: ((String) async -> Void)?
    var readCount = 0
    var authRequests = 0
    func authorization() async -> String { await event?("authorization"); return state }
    func requestAuthorization() async -> String { authRequests += 1; await event?("requestAuthorization"); state = "authorized"; return state }
    func prepare(_ request: PlanSchedulingRequest) -> String? { rejectDates.contains(request.entry.localDate) ? "SDK 不支持必要目标" : nil }
    func schedule(_ request: PlanSchedulingRequest) async {
        submitted.append(request)
        if !silentDates.contains(request.entry.localDate) { listed.append(.init(workoutID: request.entry.workoutID, at: request.at, contentMatches: true, complete: false)) }
        await event?("schedule")
    }
    func remove(_ request: PlanSchedulingRequest) async {
        removed.append(request.entry.workoutID)
        if !silentlyFailRemoval { listed.removeAll { $0.workoutID == request.entry.workoutID } }
        await event?("remove")
    }
    func removeAll() async { if !silentlyFailClear { listed = [] }; await event?("removeAll") }
    func readBack() async -> [PlanSchedulingReadback] {
        readCount += 1
        await event?("readBack\(readCount)")
        return readTransform?(listed) ?? listed
    }
}
