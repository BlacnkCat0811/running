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
    static func state(revision: Int = 12, coherence: String = String(repeating: "a", count: 64), empty: Bool = false) throws -> TrainingPlanStateResponse {
        let today = """
        {"generatedAt":"2026-10-09T00:00:00Z","timezone":"Asia/Shanghai","latestDataDate":null,"lastSyncedAt":null,
        "sync":{"status":"never","lastAttemptAt":null,"lastSuccessAt":null,"error":null},
        "coverage":{"latestTrainingDate":null,"latestHealthSampleAt":null,"sleep":{"state":"missing","latestDate":null},"hrv":{"state":"missing","latestDate":null},"restingHeartRate":{"state":"missing","latestDate":null}},
        "recoveryAssessment":{"targetDate":"2026-10-09","coverage":"missing","assessment":"unavailable","reasonCodes":[],"lastObservationDate":null},
        "recommendation":{"planRevision":\(revision),"basis":"training_load_and_plan","recoveryAdjustment":"none","uncertaintyReasons":[],"reasonCodes":[]},
        "freshness":{"state":"unknown","checkedAt":null,"latestTrainingDate":null,"recoveryDate":null},"recommendationRevision":"fixture",
        "today":{"localDate":"2026-10-09","distanceKm":0,"durationSeconds":0,"paceSecondsPerKm":null,"energyKcal":null,"workoutCount":0},
        "week":{"periodStart":"2026-10-05","periodEnd":"2026-10-11","distanceKm":0,"durationSeconds":0,"workoutCount":0},"weekDaily":[],"recentWorkouts":[],
        "ability":{"trueAbility":null,"currentAbility":null,"changeFrom7DaysAgo":null,"growthVelocityPerWeek":null,"decayPoints":0,"snapshotDate":null,"explanation":""},
        "calibration":{"status":"pending","eligibleSessions":0,"eligibleDurationMinutes":0,"spanDays":0,"highCoverageSessions":0,"requirements":{"sessions":12,"durationMinutes":360,"spanDays":28,"highCoverageSessions":6},"message":""},
        "verdict":{"tone":"yellow","title":"","reason":"","triggers":[],"stale":false,"reasonCodes":[]},"nextSession":{"kind":"rest","title":"","reason":"","distanceKm":null,"durationMinutes":null,"paceSecondsPerKmLower":null,"paceSecondsPerKmUpper":null,"heartRateBpmLower":null,"heartRateBpmUpper":null,"structure":null},
        "recovery":{"score":null,"lastNightSleepMinutes":null,"sleepBaselineMinutes":null,"morningHrvMs":null,"hrvBaselineMs":null,"restingHeartRateBpm":null,"restingHeartRateBaselineBpm":null,"state":"unknown","hrvSampleCount":0,"note":""},
        "weekStructure":{"easyDurationFraction":null,"easyDurationFloorFraction":0.7,"qualitySessionCount":0,"qualitySessionCap":2,"easyHonesty":{"intendedEasyCount":0,"easyEnoughCount":0,"honestyFraction":null,"note":""},"remainingDistanceKm":0},
        "race":{"target":null,"daysUntil":null,"taper":false,"shapeScore":null,"volumeFraction":null,"longRunFraction":null,"note":""},"injuryFlags":[],"weekPlan":[],"phase":"morning_open","lock":{"present":false,"relockSuggested":false,"lockedAt":null}}
        """
        let goals = MobileGoalsResponse(revision: revision, easyDurationFloorFraction: 0.7, qualitySessionCap: 2,
            raceTarget: nil, weekPlan: [], lockedSession: nil, weekPlanAudit: nil, weekPlanReplanRequired: false, updatedAt: "fixture")
        let dates = (9...15).map { "2026-10-\(String(format: "%02d", $0))" }
        let days = dates.map { date in empty ? MobileWorkoutPlanDay(localDate: date, kind: "rest", title: "", reason: "",
            distanceKm: nil, durationMinutes: nil, paceSecondsPerKmLower: nil, paceSecondsPerKmUpper: nil, heartRateBpmLower: nil,
            heartRateBpmUpper: nil, structure: nil, source: "manual", executable: false) : day(date) }
        let plan = MobileWorkoutPlanResponse(generatedAt: "fixture", timezone: "Asia/Shanghai", windowDays: 7, planRevision: revision,
            audit: nil, days: days, windowStart: dates[0], windowEnd: dates.last)
        let coach = try JSONDecoder().decode(MobileRunCoachResponse.self, from: Data("""
        {"revision":\(revision),"plan":null,"phase":null,"daysToRace":null,"elapsedWeeks":0,"weeklyCapacityKm":5,"notices":[],"phases":[],"strength":[]}
        """.utf8))
        return .init(metadata: .init(contractVersion: 1, serverId: "server", athleteId: "athlete", datasetEpoch: "epoch",
            goalsRevision: revision, coherenceToken: coherence, timezone: "Asia/Shanghai", localDate: dates[0], windowStart: dates[0],
            windowEnd: dates.last!, ruleVersion: "fixture", publicationDigest: String(repeating: "b", count: 64)),
            availability: empty ? "empty" : "ready", goals: goals, today: try JSONDecoder().decode(MobileTodayResponse.self, from: Data(today.utf8)),
            workoutPlan: plan, coachSummary: coach)
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
    var clearCalls = 0
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
    func removeEntries(_ entries: [PlanScheduledEntry]) async {
        clearCalls += 1
        for entry in entries {
            removed.append(entry.workoutID)
            if !silentlyFailRemoval && !silentlyFailClear {
                listed.removeAll { $0.workoutID == entry.workoutID && PlanReceiptMatcher.instant($0.at, fallbackTimeZone: TimeZone(identifier: "Asia/Shanghai")!) == entry.scheduledAt }
            }
        }
        await event?("removeAll")
    }
    func removeAll() async { clearCalls += 1; if !silentlyFailClear { listed = [] }; await event?("removeAll") }
    func readBack() async -> [PlanSchedulingReadback] {
        readCount += 1
        await event?("readBack\(readCount)")
        return readTransform?(listed) ?? listed
    }
}

@MainActor
final class FakePlanScheduleStorage: PlanSchedulePersistence {
    var value: PlanScheduleOperationJournal?
    var failWrites = false
    var writes = 0
    func scheduleJournalResult() -> CacheReadResult<PlanScheduleOperationJournal> { value.map { .value($0) } ?? .notFound }
    func saveScheduleJournal(_ operation: PlanScheduleOperationJournal) -> Bool {
        writes += 1
        guard !failWrites else { return false }
        value = operation; return true
    }
    func commitScheduleResult(_ operation: PlanScheduleOperationJournal, ledger: PlanWatchLedger?, receipts: [PlanSyncReceipt]) -> Bool {
        saveScheduleJournal(operation)
    }
    static func journal(previous: [PlanScheduledEntry] = []) -> PlanScheduleJournal {
        let snapshot = PlanSyncSnapshot(scope: "test", configuration: UUID(), revision: 12, days: [],
            timezone: "Asia/Shanghai", reminderHour: 8, completedDates: [], localDate: "2026-10-08", windowDays: 7, leaseID: UUID())
        return PlanScheduleJournal(storage: FakePlanScheduleStorage(), snapshot: snapshot, previousEntries: previous)
    }
}
