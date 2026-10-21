import Foundation

@MainActor final class ServerSession {
    var serverURL: URL? = URL(string: "https://\(UUID().uuidString).invalid")
    var apiToken = ""
    var isReachable = false
    var lastError: String?
    func probe() async {}
}
struct CachedValue<Value> { let value: Value; let cachedAt: Date }
@MainActor final class CacheStore: PlanSchedulePersistence {
    private static var entries: [String: Data] = [:]
    static var failPlanWrites = false
    static var failWrites = false
    /// 与真实 `CacheStore` 的嵌套类型同名（`CacheStore.swift:13`）：模型代码读
    /// `cache.lastReadIssue` 做损坏自愈判断时，两套实现必须能互换编译。
    enum ReadIssue: String { case unavailable, unsupportedSchema, corruptPayload }
    var lastReadIssue: ReadIssue?
    private static var acknowledgements: [String: PlanWriteAcknowledgement] = [:]
    private static var ledger: PlanWatchLedger?
    private static var scheduleJournal: PlanScheduleOperationJournal?
    private static var handshakes: [String: RaiHandshake] = [:]
    static func resetScheduleSafety() { ledger = nil; scheduleJournal = nil }
    static func loadHandshake(baseURL: URL) -> RaiHandshake? { handshakes[baseURL.absoluteString] }
    static func saveHandshake(_ value: RaiHandshake, baseURL: URL) { handshakes[baseURL.absoluteString] = value }
    static func urlScope(baseURL: URL) -> String { baseURL.absoluteString }
    static func scope(baseURL: URL, handshake: RaiHandshake?) -> String {
        baseURL.absoluteString + (handshake?.datasetEpoch ?? "")
    }
    func read<V: Codable>(_ type: V.Type, scope: String, key: String) -> CachedValue<V>? {
        guard let data = Self.entries[scope + key], let value = try? JSONDecoder().decode(type, from: data) else { return nil }
        return CachedValue(value: value, cachedAt: Date())
    }
    func readResult<V: Codable>(_ type: V.Type, scope: String, key: String) -> CacheReadResult<CachedValue<V>> { read(type, scope: scope, key: key).map { .value($0) } ?? .notFound }
    func recordPlanDiagnostic(_ event: PlanDiagnosticEvent) {}
    func exportPlanDiagnostics() -> URL? { nil }
    func write<V: Codable>(_ value: V, scope: String, key: String) -> Date? {
        guard !Self.failWrites else { return nil }
        Self.entries[scope + key] = try? JSONEncoder().encode(value)
        return Date()
    }
    func planWriteAcknowledgement(scope: String) -> PlanWriteAcknowledgement? { Self.acknowledgements[scope] }
    func planAcknowledgementResult(scope: String) -> CacheReadResult<PlanWriteAcknowledgement> {
        Self.acknowledgements[scope].map { .value($0) } ?? .notFound
    }
    func acknowledgePlanWrite(_ ack: PlanWriteAcknowledgement, scope: String, goals: MobileGoalsResponse? = nil, coach: MobileRunCoachResponse? = nil) -> Bool {
        guard !Self.failPlanWrites else { return false }
        guard ack.revision >= (Self.acknowledgements[scope]?.revision ?? 0) else { return true }
        Self.acknowledgements[scope] = ack
        for key in ["goals", "today", "workout-plan", "run-coach"] { Self.entries.removeValue(forKey: scope + key) }
        if let goals { _ = write(goals, scope: scope, key: "goals") }
        if let coach { _ = write(coach, scope: scope, key: "run-coach") }
        return true
    }
    func planRevisionFloor(scope: String) -> Int? { Self.acknowledgements[scope]?.revision ?? 0 }
    func pendingPlanReceipts(scope: String) -> [PlanSyncReceipt] { read([PlanSyncReceipt].self, scope: scope, key: "receipt-journal")?.value ?? [] }
    func pendingPlanReceiptsResult(scope: String) -> CacheReadResult<[PlanSyncReceipt]> { .value(pendingPlanReceipts(scope: scope)) }
    func savePendingPlanReceipts(_ receipts: [PlanSyncReceipt], scope: String) -> Bool { write(receipts, scope: scope, key: "receipt-journal") != nil }
    func watchLedger() -> PlanWatchLedger? { Self.ledger }
    func watchLedgerResult() -> CacheReadResult<PlanWatchLedger?> { .value(Self.ledger) }
    func saveWatchLedger(_ ledger: PlanWatchLedger?) -> Bool { Self.ledger = ledger; return true }
    /// 与真实 `CacheStore.clear(scope:)`（只 `DELETE FROM cache_entries`）**语义对齐**：
    /// `publication` / `coach-feedback` 住在 `app_metadata`、回执账目住在
    /// `plan_receipt_journal`，三者都必须存活；只有普通缓存条目会被清掉。
    ///
    /// 2026-10-15（审查 🟡-C2）：此前替身把 `publication` 一并删掉 —— 与真实现**相反**，
    /// 而发布/回执/台账整条行为链都跑在替身上 ⇒ 给出一批与生产相反的绿灯
    /// （🔴-1 的"清除缓存解不开楔死"因此没有任何断言会变红）。
    func clear(scope: String) {
        let persistent = ["publication", "coach-feedback", "receipt-journal"]
        Self.entries = Self.entries.filter { entry in
            guard entry.key.hasPrefix(scope) else { return true }
            return persistent.contains { entry.key.hasPrefix(scope + $0) }
        }
    }
    /// 单条删除（真实 `CacheStore.remove` 的替身；自愈路径调用）。
    func remove(scope: String, key: String) { Self.entries.removeValue(forKey: scope + key) }
    func scheduleJournalResult() -> CacheReadResult<PlanScheduleOperationJournal> { Self.scheduleJournal.map { .value($0) } ?? .notFound }
    func saveScheduleJournal(_ value: PlanScheduleOperationJournal) -> Bool { Self.scheduleJournal = value; return !Self.failWrites }
    func commitScheduleResult(_ operation: PlanScheduleOperationJournal, ledger: PlanWatchLedger?, receipts: [PlanSyncReceipt]) -> Bool {
        guard !Self.failWrites else { return false }
        Self.scheduleJournal = operation; Self.ledger = ledger
        var pending = pendingPlanReceipts(scope: operation.scope)
        if operation.phase == .withdrawn {
            let ids = Set((operation.previousEntries + operation.items.map(\.entry)).map { $0.workoutID.uuidString })
            pending.removeAll { (operation.clearAll || ids.contains($0.workoutID ?? "")) && ($0.lifecycleEvent == nil || $0.lifecycleEvent == "verified") }
        }
        for receipt in receipts where !pending.contains(where: { $0.idempotencyKey == receipt.idempotencyKey }) { pending.append(receipt) }
        return savePendingPlanReceipts(pending, scope: operation.scope)
    }
    func pendingPublication(scope: String) -> CacheReadResult<PendingPlanPublication?> { .value(read(PendingPlanPublication.self, scope: scope, key: "publication")?.value) }
    func savePublication(_ value: PendingPlanPublication?, scope: String) -> Bool { write(value, scope: scope, key: "publication") != nil }
    func pendingCoachFeedback(scope: String) -> CacheReadResult<CoachLoopFeedbackCommand?> { .value(read(CoachLoopFeedbackCommand?.self, scope: scope, key: "coach-feedback")?.value ?? nil) }
    func saveCoachFeedback(_ value: CoachLoopFeedbackCommand?, scope: String) -> Bool { write(value, scope: scope, key: "coach-feedback") != nil }
}

final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (URLRequest) -> (Int, String, Double) = { _ in (503, "{}", 0) }
    /// 2026-10-18（P2-6 收尾）：让个别用例附加响应头（如 `Retry-After`），
    /// 其余用例保持 nil，行为与之前完全一致。
    nonisolated(unsafe) static var extraHeaders: [String: String]? = nil
    private let lock = NSLock()
    private var stopped = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, body, delay) = Self.handler(request)
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [self] in
            lock.lock()
            let alreadyStopped = stopped
            stopped = true
            lock.unlock()
            guard !alreadyStopped else { return }
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: Self.extraHeaders)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {
        lock.lock()
        let cancelled = !stopped
        stopped = true
        lock.unlock()
        // 2026-10-18（事故复盘 P0-3）：`stopLoading` 在任务被取消时被 URLSession 调起，
        // 用例用它钉住"新请求真的取消了旧 URLSession 请求"，而不只是丢弃旧结果。
        if cancelled { CancellationLog.shared.record() }
    }
}

/// 被取消的 URLSession 请求计数（跨用例归零；只在"真的取消"时 +1）。
final class CancellationLog: @unchecked Sendable {
    static let shared = CancellationLog()
    private let lock = NSLock()
    private var stored = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return stored }
    func reset() { lock.lock(); stored = 0; lock.unlock() }
    func record() { lock.lock(); stored += 1; lock.unlock() }
}

final class RequestLog: @unchecked Sendable {
    struct Entry {
        let host: String
        let path: String
        let method: String
        let body: Data?
    }

    private let lock = NSLock()
    private var entries: [Entry] = []

    func record(_ request: URLRequest) {
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                data.append(buffer, count: count)
            }
            body = data
        }
        lock.lock()
        entries.append(Entry(
            host: request.url?.host ?? "",
            path: request.url?.path ?? "",
            method: request.httpMethod ?? "GET",
            body: body
        ))
        lock.unlock()
    }

    func count(method: String, path: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return entries.filter { $0.method == method && $0.path == path }.count
    }

    func lastBody(method: String, path: String) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return entries.last { $0.method == method && $0.path == path }?.body
    }
}

@main struct ModelRegression {
    @MainActor static func main() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        let api = RaiAPIClient(session: URLSession(configuration: config))
        let session = ServerSession()
        var modelNow = ISO8601DateFormatter().date(from: "2026-09-16T00:00:00Z")!
        let model = NativeAppModel(session: session, api: api, now: { modelNow })
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            print("PASS: \(name)")
        }
        func segment(lower: Double, upper: Double) -> WorkoutSegment {
            WorkoutSegment(index: 2, label: "训练", purpose: "work", goalType: "distance", goalMeters: 2600,
                           goalSeconds: nil, alertKind: "pace", alertLower: lower, alertUpper: upper,
                           startOffsetSeconds: 300, durationSeconds: 981, distanceMeters: 2600,
                           averagePaceSecondsPerKm: 377, averageHeartRateBpm: 162, averageCadenceSpm: nil)
        }
        check(nativeSegmentAlert(segment(lower: 423, upper: 380)) == "提醒 \(nativePace(380))–\(nativePace(423))/km", "September 14 pace display orders fast to slow")
        check(nativeSegmentAlert(segment(lower: 1, upper: 423)) == "配速目标异常", "historical corrupt target is not displayed as a valid range")
        check(NativeRaceGoalDraft.isValidPace(""), "blank target pace is optional")
        check(NativeRaceGoalDraft.finishSeconds("1:45:00") == 6300, "finish time parses hours minutes seconds")
        check(NativeRaceGoalDraft.finishSeconds("50:00") == 3000, "finish time parses minutes seconds")
        check(NativeRaceGoalDraft.finishSeconds("1:60:00") == nil && NativeRaceGoalDraft.finishSeconds("1:5:00") == nil, "invalid finish time is rejected")
        check(NativeRaceGoalDraft.finishText(pace: 300, distance: "ten_k") == "0:50:00", "ten-kilometer finish time matches pace")
        check(abs(NativeRaceGoalDraft.kilometers("half_marathon") * 300 - 6329.25) < 0.001, "half-marathon conversion uses full distance")
        check(NativeRaceGoalDraft.paceSeconds("5:30") == 330, "race pace converts minutes and seconds")
        check(NativeRaceGoalDraft.paceSeconds("2:30") == 150 && NativeRaceGoalDraft.paceSeconds("15:00") == 900, "race pace includes API boundaries")
        for invalid in ["2:29", "15:01", "5:60", "5:3", "abc", "-5:30", "5.5:30"] {
            check(!NativeRaceGoalDraft.isValidPace(invalid), "invalid race pace rejected: \(invalid)")
        }
        let race = MobileRaceTarget(date: "2026-12-06", distance: "half_marathon", targetPaceSecondsPerKm: 330)
        for target in [race, nil] as [MobileRaceTarget?] {
            let request = UpdateMobileGoalsRequest(expectedRevision: 12,
                easyDurationFloorFraction: nil, qualitySessionCap: nil, raceTarget: target, weekPlan: nil)
            let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as! [String: Any]
            check(object["weekPlan"] == nil, "race-only save does not replace weekly plan")
            if target == nil {
                check(object["raceTarget"] is NSNull, "clear emits explicit null instead of omitting race target")
            } else {
                check((object["raceTarget"] as? [String: Any])?["targetPaceSecondsPerKm"] as? Double == 330, "race target is encoded for persistence")
            }
        }
        let legacyWeekJSON = """
        {"periodStart":"2026-09-14","periodEnd":"2026-09-20","distanceKm":11.1,
         "durationSeconds":3600,"workoutCount":2,"goalDistanceKm":30,"goalProgressFraction":0.37}
        """
        let oldWeek = try JSONDecoder().decode(WeekSummary.self, from: Data(legacyWeekJSON.utf8))
        check(!oldWeek.hasWeeklyActivityStatistics, "old API/cache is not mistaken for empty weekly statistics")
        // The legacy payload above still carries `goalDistanceKm` / `goalProgressFraction`.
        // It has to keep decoding: the decoder ignores what the contract retired, and
        // the fields that remain must survive the round trip.
        check(oldWeek.distanceKm == 11.1 && oldWeek.workoutCount == 2,
              "a legacy week payload still decodes with the retired goal keys present")
        let emptyWeekJSON = legacyWeekJSON.replacingOccurrences(of: "}", with: ",\"heartRateZones\":[],\"paceZones\":[]}")
        let emptyWeek = try JSONDecoder().decode(WeekSummary.self, from: Data(emptyWeekJSON.utf8))
        check(emptyWeek.hasWeeklyActivityStatistics, "new API empty zones remain a valid no-data result")
        let fullWeekJSON = legacyWeekJSON.replacingOccurrences(of: "}", with: """
        ,"averageSpeedKmPerHour":11.1,"averagePaceSecondsPerKm":324.324,"averageHeartRateBpm":145,
        "heartRateZones":[{"zone":"aerobic_base","durationSeconds":3000,"fraction":1}],
        "paceZones":[{"zone":"easy","durationSeconds":3600,"fraction":1}]}
        """)
        let fullWeek = try JSONDecoder().decode(WeekSummary.self, from: Data(fullWeekJSON.utf8))
        check(fullWeek.hasWeeklyActivityStatistics && fullWeek.averageSpeedKmPerHour == 11.1 &&
              fullWeek.averagePaceSecondsPerKm == 324.324 && fullWeek.averageHeartRateBpm == 145 &&
              fullWeek.heartRateZones?.first?.durationSeconds == 3000 && fullWeek.paceZones?.first?.durationSeconds == 3600,
              "native decoder preserves all five weekly statistics from the API")
        for (state, expected) in [("recovered", "恢复良好"), ("reduced", "恢复不足"), ("depleted", "需要休息"), ("unknown", "未识别状态")] {
            let json = "{\"state\":\"\(state)\",\"lastNightSleepMinutes\":420,\"note\":\"test\"}"
            let recovery = try JSONDecoder().decode(MobileRecoveryBreakdown.self, from: Data(json.utf8))
            check(recovery.stateLabel == expected, "recovery state \(state) is not pending")
        }
        let predictionJSON = """
        {
          "reportVersion":"rai-physiology-report-v2",
          "generatedAt":"2026-09-25T00:00:00.000Z",
          "inputs":{"recoveryReadiness":0.8,"readiness":{"five_k":null}},
          "guidanceCodes":["race_readiness_missing"],
          "explainability":{
            "schemaVersion":"prediction-explainability-v1",
            "recovery":{"readiness":0.8,"status":"available","source":"canonical","asOf":"2026-09-25T00:00:00.000Z","latestObservedAt":"2026-09-24T00:00:00.000Z","coverage":"partial"},
            "readiness":{"five_k":{"value":null,"status":"insufficient_data","evidenceCount":0,"dataThroughAt":null}}
          },
          "snapshot":{
            "schemaVersion":"physiology-prediction-v1",
            "modelVersion":"physiology-v1",
            "generatedAt":"2026-09-25T00:00:00.000Z",
            "dataThroughAt":"2026-09-24T00:00:00.000Z",
            "vo2Max":{"status":"available","valueMlKgMin":50,"confidence":0.8},
            "performanceVdot":{"status":"available","value":48,"confidence":0.7},
            "lactateThreshold":{"status":"available","paceSecondsPerKm":300,"heartRateBpm":165,"confidence":0.6},
            "races":[{"distance":"five_k","predictedSeconds":1200,"optimisticSeconds":1150,"pessimisticSeconds":1260,"fatigueAdjustmentSeconds":12,"readiness":null,"confidence":0.6,"method":"daniels_vdot_conditions_v3","evidenceCodes":["fatigue_adjustment"]}]
          }
        }
        """
        let decodedPrediction = try JSONDecoder().decode(
            NativePredictionResponse.self,
            from: Data(predictionJSON.utf8)
        )
        check(decodedPrediction.snapshot.races.first?.fatigueAdjustmentSeconds == 12, "prediction DTO preserves fatigue adjustment")
        check(decodedPrediction.explainability?.recovery?.source == "canonical", "prediction DTO preserves recovery provenance")
        let hasNoReadinessValue = decodedPrediction.inputs.readiness?.values.compactMap { $0 }.isEmpty ?? true
        check(hasNoReadinessValue, "prediction DTO preserves missing readiness")
        let chart = HeartRateChartData(points: [
            MetricPoint(timestamp: "", offsetSeconds: 2538, value: 176),
            MetricPoint(timestamp: "", offsetSeconds: 0, value: 90),
            MetricPoint(timestamp: "", offsetSeconds: 5, value: .nan),
            MetricPoint(timestamp: "", offsetSeconds: -1, value: 200)
        ], durationSeconds: 2538)
        check(chart.maximum == 176 && chart.points.count == 2, "heart rate ignores invalid samples and sorts time")
        check(chart.timeTicks == [0, 600, 1200, 1800, 2538], "heart rate time axis fits endpoint without overlap")
        check(HeartRateChartData.timeLabel(2538) == "42:18", "heart rate uses minutes and seconds")
        check(chart.lowerBound == 40 && chart.upperBound == 200, "heart rate matches reference scale")
        check(HeartRateChartData(points: [], durationSeconds: 0).duration == 1, "empty heart rate has valid scale")
        func list(_ id: String) -> String {
            """
            {"items":[{"id":"\(id)","startedAt":"2026-09-08","endedAt":"2026-09-08","durationSeconds":600,"sourceCategory":"apple_health","sessionType":"easy","stimulusType":"easy","eligibilityStatus":"eligible","missingReasons":[],"qualityScore":1,"hasRoute":false}],"total":1,"limit":30,"offset":0}
            """
        }
        let slowList = list("old"), fastList = list("new")
        StubProtocol.handler = { request in
            (200, request.url!.query!.contains("easy") ? slowList : fastList,
             request.url!.query!.contains("easy") ? 0.15 : 0.01)
        }
        model.workoutSessionType = "easy"
        CancellationLog.shared.reset()
        let old = Task { await model.refreshWorkouts() }
        try await Task.sleep(for: .milliseconds(30))
        model.workoutSessionType = "tempo"
        await model.refreshWorkouts()
        _ = await old.value
        check(model.workouts.first?.id == "new", "late filter response cannot replace current list")
        // 2026-10-18（事故复盘 P0-3）：只换 requestID 挡得住结果，挡不住旧网络请求还在
        // 服务端排队；新请求必须真正取消它（URLSession 随 Task 取消断开连接）。
        try await Task.sleep(for: .milliseconds(30))
        check(CancellationLog.shared.count >= 1,
              "a new workouts request cancels the old URLSession request, not merely discards its result")
        model.workoutSessionType = "interval"
        StubProtocol.handler = { _ in (503, "{}", 0) }
        await model.refreshWorkouts()
        check(model.workouts.isEmpty && model.workoutTotal == 0, "uncached failed filter does not retain another filter's rows")
        check(model.isOffline && !model.isLoadingWorkouts, "failed list exits loading and reports offline")
        await model.loadWorkout(id: "missing")
        check(model.workoutDetailError != nil && !model.isLoadingWorkout, "detail failure exits spinner with retryable error")
        StubProtocol.handler = { _ in (200, slowList, 0.12) }
        let pending = Task { await model.refreshWorkouts() }
        try await Task.sleep(for: .milliseconds(20))
        session.serverURL = URL(string: "https://\(UUID().uuidString).invalid")
        model.serverConfigurationChanged()
        _ = await pending.value
        check(model.workouts.isEmpty, "old server response cannot publish into new server scope")
        let clearing = Task { await model.refreshWorkouts() }
        try await Task.sleep(for: .milliseconds(20))
        model.clearCache()
        _ = await clearing.value
        check(model.workouts.isEmpty && !model.isLoadingWorkouts, "clear cache invalidates pending list response")
        StubProtocol.handler = { _ in (503, "{}", 0.12) }
        let cancelled = Task { await model.loadWorkout(id: "cancelled") }
        try await Task.sleep(for: .milliseconds(20))
        cancelled.cancel()
        await cancelled.value
        check(model.workoutDetailError == nil && !model.isLoadingWorkout, "cancelled detail does not present a failure")
        func detail(_ id: String) -> String {
            """
            {"workout":{"id":"\(id)","startedAt":"2026-09-08","endedAt":"2026-09-08","durationSeconds":600,"elapsedSeconds":600,"sourceCategory":"apple_health","sessionType":"easy","stimulusType":"easy","eligibilityStatus":"eligible","missingReasons":[],"qualityScore":1,"hasRoute":false,"modelVersion":"test","updatedTrueAbility":false,"heartRateSampleCount":0,"routePointCount":0,"sourceConfidence":1,"effectiveWeights":{},"confidenceFactors":{},"explanationCodes":[]},"dimensions":{},"route":[]}
            """
        }
        let detailA = detail("a"), detailB = detail("b")
        StubProtocol.handler = { request in
            if request.url!.path.hasSuffix("series") { return (503, "{}", 0) }
            return (200, request.url!.path.hasSuffix("/a") ? detailA : detailB,
                    request.url!.path.hasSuffix("/a") ? 0.15 : 0.01)
        }
        let pendingA = Task { await model.loadWorkout(id: "a") }
        try await Task.sleep(for: .milliseconds(20))
        await model.loadWorkout(id: "b")
        await pendingA.value
        check(model.selectedWorkout?.workout.id == "b", "late detail cannot replace newly selected workout")
        check(model.selectedSeries == nil && model.workoutDetailError != nil, "series failure keeps detail available with explicit feedback")
        StubProtocol.handler = { _ in (503, "{}", 0) }
        await model.loadWorkout(id: "never-cached")
        check(model.selectedWorkout == nil && model.selectedSeries == nil, "opening another workout clears both previous detail and series")

        // --- executable weekly plan ------------------------------------------
        let planJSON = """
        {"generatedAt":"2026-09-11T01:00:00.000Z","timezone":"Asia/Shanghai","windowDays":2,"planRevision":7,
         "audit":{"generatedBy":"llm","model":"deepseek:deepseek-chat","promptVersion":"weekly-plan-v1","generatedAt":"2026-09-11T00:30:00.000Z"},
         "days":[
          {"localDate":"2026-09-11","kind":"interval","title":"间歇 / VO₂","reason":"闸门放行","distanceKm":11.4,"durationMinutes":62,
           "paceSecondsPerKmLower":240,"paceSecondsPerKmUpper":265,"heartRateBpmLower":160,"heartRateBpmUpper":172,
           "structure":{"warmup":{"purpose":"warmup","goal":{"type":"time","seconds":600},"alert":null},
            "blocks":[{"iterations":6,"steps":[{"purpose":"work","goal":{"type":"distance","meters":800},"alert":{"kind":"pace","lower":240,"upper":265}},
                                              {"purpose":"recovery","goal":{"type":"time","seconds":120},"alert":null}]}],
            "cooldown":{"purpose":"cooldown","goal":{"type":"time","seconds":600},"alert":null}},
           "source":"llm","executable":true},
          {"localDate":"2026-09-12","kind":"rest","title":"休息","reason":"","distanceKm":null,"durationMinutes":null,
           "paceSecondsPerKmLower":null,"paceSecondsPerKmUpper":null,"heartRateBpmLower":null,"heartRateBpmUpper":null,
           "structure":null,"source":"llm","executable":false}
         ]}
        """
        let generationJSON = """
        {"generatedAt":"2026-09-11T00:30:00.000Z","revision":8,
         "audit":{"generatedBy":"heuristic","model":null,"promptVersion":null,"generatedAt":"2026-09-11T00:30:00.000Z"},
         "days":[{"localDate":"2026-09-11","kind":"easy","distanceKm":8,"structure":null,"reason":"轻松"}],"warnings":[]}
        """
        let goalsJSON = """
        {"revision":12,"weeklyDistanceKm":40,"easyDurationFloorFraction":0.7,"qualitySessionCap":2,
         "raceTarget":null,"weekPlan":[],"lockedSession":null,"weekPlanAudit":null,"updatedAt":"2026-09-11T00:00:00.000Z"}
        """
        let todayJSON = """
        {"generatedAt":"2026-09-16T01:00:00.000Z","timezone":"Asia/Shanghai","latestDataDate":"2026-09-15",
         "lastSyncedAt":"2026-09-16T00:30:00.000Z",
         "sync":{"status":"ok","lastAttemptAt":"2026-09-16T00:28:00.000Z","lastSuccessAt":"2026-09-16T00:30:00.000Z","error":null},
         "coverage":{"latestTrainingDate":"2026-09-15","latestHealthSampleAt":"2026-09-16T00:30:00.000Z",
                     "sleep":{"state":"current","latestDate":"2026-09-16"},
                     "hrv":{"state":"current","latestDate":"2026-09-16"},
                     "restingHeartRate":{"state":"current","latestDate":"2026-09-16"}},
         "recoveryAssessment":{"targetDate":"2026-09-16","coverage":"complete","assessment":"no_low_signal",
                               "reasonCodes":[],"lastObservationDate":"2026-09-16"},
         "recommendation":{"planRevision":12,"basis":"training_load_and_plan","recoveryAdjustment":"none",
                           "uncertaintyReasons":[],"reasonCodes":[]},
         "freshness":{"state":"valid","checkedAt":"2026-09-16T00:30:00.000Z","latestTrainingDate":"2026-09-15","recoveryDate":"2026-09-16"},
         "recommendationRevision":"recommendation-12",
         "today":{"localDate":"2026-09-16","distanceKm":0,"durationSeconds":0,"paceSecondsPerKm":null,"energyKcal":null,"workoutCount":0},
         "week":{"periodStart":"2026-09-14","periodEnd":"2026-09-20","distanceKm":12,"durationSeconds":4200,"workoutCount":2,"goalDistanceKm":40,"goalProgressFraction":0.3},
         "weekDaily":[],"recentWorkouts":[],
         "ability":{"trueAbility":44,"currentAbility":43.5,"changeFrom7DaysAgo":0.2,"growthVelocityPerWeek":0.1,"decayPoints":0,"snapshotDate":"2026-09-15","explanation":""},
         "calibration":{"status":"completed","eligibleSessions":20,"eligibleDurationMinutes":600,"spanDays":60,"highCoverageSessions":12,
                        "requirements":{"sessions":12,"durationMinutes":360,"spanDays":28,"highCoverageSessions":6},"message":""},
         "verdict":{"tone":"green","title":"可以训练","reason":"恢复充分","triggers":[],"stale":false,"reasonCodes":[]},
         "nextSession":{"kind":"easy","title":"轻松跑","reason":"闸门放行","distanceKm":8,"durationMinutes":50,
                        "paceSecondsPerKmLower":330,"paceSecondsPerKmUpper":390,"heartRateBpmLower":130,"heartRateBpmUpper":150,"structure":null},
         "recovery":{"score":80,"lastNightSleepMinutes":430,"sleepBaselineMinutes":430,"morningHrvMs":52,"hrvBaselineMs":52,
                     "restingHeartRateBpm":52,"restingHeartRateBaselineBpm":53,"state":"recovered","hrvSampleCount":1,"note":""},
         "postRun":null,
         "weekStructure":{"easyDurationFraction":0.8,"easyDurationFloorFraction":0.7,"qualitySessionCount":0,"qualitySessionCap":2,
                          "easyHonesty":{"intendedEasyCount":3,"easyEnoughCount":3,"honestyFraction":1,"note":""},"remainingDistanceKm":28},
         "race":{"target":null,"daysUntil":null,"taper":false,"shapeScore":null,"volumeFraction":null,"longRunFraction":null,"note":""},
         "injuryFlags":[],"weekPlan":[],"phase":"morning_open",
         "lock":{"present":false,"relockSuggested":false,"lockedAt":null}}
        """
        do {
            // 2026-10-18（事故复盘 P0-3）：`refreshPlanState` 单飞。
            //
            // 它是客户端唯一会触发 coach-loop 重计算的入口（服务端实测 13.4s/条）。
            // 并发调用必须复用同一个在飞 `Task`，不再各发一条教练闭环/完整计划读。
            let flightLog = RequestLog()
            let flightPlan = try PlanTestFixtures.json(PlanTestFixtures.plan(revision: 12, dates: ["2026-09-16"]))
            StubProtocol.handler = { request in
                flightLog.record(request)
                switch request.url!.path {
                case "/v1/mobile/goals": return (200, goalsJSON, 0.12)
                case "/v1/mobile/today": return (200, todayJSON, 0.12)
                case "/v1/mobile/workout-plan": return (200, flightPlan, 0.12)
                default: return (503, "{}", 0)
                }
            }
            let flightModel = NativeAppModel(session: ServerSession(), api: api, now: { modelNow })
            let firstRead = Task { await flightModel.refreshPlanState() }
            try await Task.sleep(for: .milliseconds(30))
            let reusedRead = await flightModel.refreshPlanState()
            let firstResult = await firstRead.value
            check(firstResult && reusedRead && flightModel.currentWorkoutPlan?.planRevision == 12,
                  "concurrent plan refreshes both observe the shared completed read")
            check(flightLog.count(method: "GET", path: "/v1/mobile/goals") == 1 &&
                  flightLog.count(method: "GET", path: "/v1/mobile/today") == 1 &&
                  flightLog.count(method: "GET", path: "/v1/mobile/workout-plan") == 1,
                  "a concurrent refreshPlanState reuses the in-flight Task instead of issuing a second plan read")

            // 配置变化必须取消在飞读：旧 scope 的结果不得写回新配置，也不得让下一次
            // 刷新复用一个已作废的读。
            let staleModel = NativeAppModel(session: ServerSession(), api: api, now: { modelNow })
            let staleRead = Task { await staleModel.refreshPlanState() }
            try await Task.sleep(for: .milliseconds(30))
            staleModel.session.serverURL = URL(string: "https://rai-ios-lane-new-server.invalid")
            staleModel.serverConfigurationChanged()
            let staleResult = await staleRead.value
            check(!staleResult && staleModel.currentWorkoutPlan == nil && !staleModel.isTodayAvailable,
                  "a configuration change cancels the in-flight plan read so an old scope can never publish")

            // 取消后再次刷新必须是**新**读，而不是复用已取消的任务。
            StubProtocol.handler = { request in
                switch request.url!.path {
                case "/v1/mobile/goals": return (200, goalsJSON, 0)
                case "/v1/mobile/today": return (200, todayJSON, 0)
                case "/v1/mobile/workout-plan": return (200, flightPlan, 0)
                default: return (503, "{}", 0)
                }
            }
            let recoveredRead = await staleModel.refreshPlanState()
            check(recoveredRead && staleModel.currentWorkoutPlan?.planRevision == 12,
                  "a refresh after the cancelled single-flight task starts a fresh read for the new configuration")
        }

        do {
            // 2026-10-18（事故复盘 P0-3）：`refreshAll` 排队重跑加 ~350ms 合并窗口，
            // 让同一波 burst（回前台 + 同步成功 + 进页面）合并成一次重跑，而不是
            // "完成即立刻重跑"再叠一轮 coach-loop/四连读。
            let coalesceLog = RequestLog()
            let coalescePlan = try PlanTestFixtures.json(PlanTestFixtures.plan(revision: 12, dates: ["2026-09-16"]))
            StubProtocol.handler = { request in
                coalesceLog.record(request)
                switch request.url!.path {
                case "/v1/mobile/goals": return (200, goalsJSON, 0.05)
                case "/v1/mobile/today": return (200, todayJSON, 0.05)
                case "/v1/mobile/workout-plan": return (200, coalescePlan, 0.05)
                case "/v1/workouts": return (200, fastList, 0.05)
                default: return (503, "{}", 0)
                }
            }
            let coalesceModel = NativeAppModel(session: ServerSession(), api: api, now: { modelNow })
            let firstRefresh = Task { await coalesceModel.refreshAll(requestHandshake: false) }
            for _ in 0..<100 {
                if coalesceLog.count(method: "GET", path: "/v1/mobile/goals") > 0 { break }
                try await Task.sleep(for: .milliseconds(2))
            }
            await coalesceModel.refreshAll(requestHandshake: false) // 在飞时排入一次重跑
            await firstRefresh.value
            let roundsAfterFirst = coalesceLog.count(method: "GET", path: "/v1/mobile/goals")
            try await Task.sleep(for: .milliseconds(150))
            check(coalesceLog.count(method: "GET", path: "/v1/mobile/goals") == roundsAfterFirst,
                  "a queued refreshAll waits out the coalescing window instead of rerunning immediately")
            try await Task.sleep(for: .milliseconds(500))
            check(coalesceLog.count(method: "GET", path: "/v1/mobile/goals") == roundsAfterFirst + 1,
                  "the coalesced refreshAll runs exactly once after the ~350ms window")
        }

        do {
            // 2026-10-18（事故复盘 P0-3）：一次 refreshAll 全失败**不**把 isReachable 打回
            // false。失败判定交给 ServerSession 的 3 次探针阈值；否则一次慢刷新就会把探针
            // 间隔从 30s 收紧到 ~5s、禁用同步入口，等于制造更多请求。
            let offlineSession = ServerSession()
            offlineSession.isReachable = true
            let offlineModel = NativeAppModel(session: offlineSession, api: api, now: { modelNow })
            StubProtocol.handler = { _ in (503, "{}", 0) }
            await offlineModel.refreshAll(requestHandshake: false)
            check(offlineModel.isOffline && offlineSession.isReachable,
                  "an all-failure refreshAll leaves reachability to the probe failure threshold")
            check((offlineModel.errorMessage ?? "").contains("核心数据均未能更新"),
                  "the all-panel failure classification and copy stay unchanged")
        }

        // Race editor uses the real API client/model, including refresh and conflict recovery.
        let raceModel = NativeAppModel(session: ServerSession(), api: api)
        let raceRequests = RequestLog()
        func raceHandler(_ goals: String, putStatus: Int = 200) {
            StubProtocol.handler = { request in
                raceRequests.record(request)
                let path = request.url!.path
                if path.hasSuffix("/goals") {
                    if request.httpMethod == "PUT" && putStatus != 200 {
                        return (putStatus, "{\"code\":\"mobile_goals_revision_conflict\",\"message\":\"目标已更新\"}", 0)
                    }
                    return (200, goals, 0)
                }
                if path.hasSuffix("/today") {
                    let revision = (try? JSONSerialization.jsonObject(with: Data(goals.utf8)) as? [String: Any])?["revision"] as? Int ?? 12
                    return (200, todayJSON.replacingOccurrences(of: "\"planRevision\":12", with: "\"planRevision\":\(revision)"), 0)
                }
                if path.hasSuffix("/workouts") { return (200, fastList, 0) }
                return (503, "{}", 0)
            }
        }
        raceHandler(goalsJSON)
        await raceModel.refreshAll(requestHandshake: false)
        let savedRaceJSON = goalsJSON.replacingOccurrences(of: "\"revision\":12", with: "\"revision\":13")
            .replacingOccurrences(of: "\"raceTarget\":null", with: "\"raceTarget\":{\"date\":\"2026-12-06\",\"distance\":\"half_marathon\",\"targetPaceSecondsPerKm\":330}")
        raceHandler(savedRaceJSON)
        let raceSaved = await raceModel.saveRaceTarget(race, expectedRevision: 12)
        check(raceSaved && raceModel.goals?.raceTarget == race, "race save updates model after server acknowledgement and refresh")
        let raceBody = try JSONSerialization.jsonObject(with: raceRequests.lastBody(method: "PUT", path: "/v1/mobile/goals")!) as! [String: Any]
        check(raceBody["expectedRevision"] as? Int == 12 && raceBody["weekPlan"] == nil, "race save carries editor revision without replacing the plan")
        check(raceBody["easyDurationFloorFraction"] == nil, "race save touches only the race target")
        raceHandler(savedRaceJSON, putStatus: 409)
        let raceConflict = await raceModel.saveRaceTarget(nil, expectedRevision: 12)
        check(!raceConflict && raceModel.goals?.raceTarget == race, "race conflict preserves persisted target and reports failure")
        raceHandler(savedRaceJSON, putStatus: 503)
        let raceFailed = await raceModel.saveRaceTarget(nil, expectedRevision: 13)
        check(!raceFailed && raceModel.goals?.raceTarget == race, "failed clear does not optimistically erase the target")
        raceHandler(goalsJSON.replacingOccurrences(of: "\"revision\":12", with: "\"revision\":14"))
        let raceCleared = await raceModel.saveRaceTarget(nil, expectedRevision: 13)
        check(raceCleared && raceModel.goals?.raceTarget == nil, "race clear refreshes to persisted empty state")
        let clearBody = try JSONSerialization.jsonObject(with: raceRequests.lastBody(method: "PUT", path: "/v1/mobile/goals")!) as! [String: Any]
        check(clearBody["raceTarget"] is NSNull, "real clear request sends explicit JSON null")

        do {
            let planModel = NativeAppModel(session: ServerSession(), api: api)
            let storedPlanJSON = savedRaceJSON
            raceHandler(storedPlanJSON)
            await planModel.refreshAll(requestHandshake: false)
            let updatedPlanJSON = storedPlanJSON.replacingOccurrences(of: "\"revision\":13", with: "\"revision\":14")
                .replacingOccurrences(of: "\"easyDurationFloorFraction\":0.7", with: "\"easyDurationFloorFraction\":0.85")
                .replacingOccurrences(of: "\"qualitySessionCap\":2", with: "\"qualitySessionCap\":3")
            raceHandler(updatedPlanJSON)
            let planSaved = await planModel.saveGoals(
                expectedRevision: 13,
                easyDurationFloorFraction: 0.85,
                qualitySessionCap: 3,
                weekPlan: []
            )
            let planBody = try JSONSerialization.jsonObject(with: raceRequests.lastBody(method: "PUT", path: "/v1/mobile/goals")!) as! [String: Any]
            check(planSaved, "saving training settings succeeds")
            check(planBody["expectedRevision"] as? Int == 13, "plan save keeps revision conflict protection")
            check(planBody["easyDurationFloorFraction"] as? Double == 0.85 && planBody["qualitySessionCap"] as? Int == 3,
                  "remaining weekly settings are still editable")
            check((planBody["raceTarget"] as? [String: Any])?["targetPaceSecondsPerKm"] as? Double == 330,
                  "plan save preserves the stored race target")
            check(planBody["weekPlan"] as? [String] == [], "plan save still submits the daily plan")
        }

        let previewBase = try JSONSerialization.jsonObject(with: Data(generationJSON.utf8)) as! [String: Any]
        var previewObject = previewBase
        previewObject["candidateId"] = "preview-test"
        previewObject["expiresAt"] = "2099-01-01T00:00:00Z"
        previewObject["revision"] = 12
        previewObject["replacedDates"] = ["2026-09-12"]
        previewObject["windowStart"] = "2026-09-11"
        previewObject["windowEnd"] = "2026-09-17"
        let previewJSON = String(data: try JSONSerialization.data(withJSONObject: previewObject), encoding: .utf8)!

        do {
            let oldGoals = try JSONDecoder().decode(MobileGoalsResponse.self, from: Data(goalsJSON.utf8))
            check(oldGoals.weekPlanReplanRequired != true, "old API and cache payloads default to no pending migration")
            let pendingJSON = goalsJSON
                .replacingOccurrences(of: "\"weekPlanAudit\":null", with: "\"weekPlanAudit\":null,\"weekPlanReplanRequired\":true")
                .replacingOccurrences(of: "\"weekPlan\":[]", with: "\"weekPlan\":[{\"localDate\":\"2026-09-18\",\"kind\":\"easy\",\"distanceKm\":8}]")
            let pendingModel = NativeAppModel(session: ServerSession(), api: api)
            raceHandler(pendingJSON)
            await pendingModel.refreshAll(requestHandshake: false)
            check(pendingModel.goals?.weekPlanReplanRequired == true, "pending retirement loads from the API")
            let cached = try JSONDecoder().decode(MobileGoalsResponse.self, from: JSONEncoder().encode(pendingModel.goals!))
            check(cached.weekPlanReplanRequired == true, "pending retirement survives cache encoding and decoding")
            raceHandler(pendingJSON.replacingOccurrences(of: "\"revision\":12", with: "\"revision\":13"))
            let saved = await pendingModel.saveGoals(expectedRevision: 12, easyDurationFloorFraction: 0.85,
                                                     qualitySessionCap: 1, weekPlan: cached.weekPlan)
            let body = try JSONSerialization.jsonObject(with: raceRequests.lastBody(method: "PUT", path: "/v1/mobile/goals")!) as! [String: Any]
            check(saved && pendingModel.goals?.weekPlanReplanRequired == true, "saving settings cannot clear pending confirmation")
            check(body["weekPlan"] == nil, "pending settings save omits even a nonempty daily plan")
            check(body["weekPlanReplanRequired"] == nil, "clients cannot write the server-owned migration state")
            check(body["easyDurationFloorFraction"] as? Double == 0.85 && body["qualitySessionCap"] as? Int == 1,
                  "training settings remain writable while a rule preview needs confirmation")
            StubProtocol.handler = { _ in (503, "{}", 0) }
            await pendingModel.refreshAll(requestHandshake: false)
            check(pendingModel.isOffline && pendingModel.goals?.weekPlanReplanRequired == true,
                  "an offline cache does not silently remove the confirmation gate")
        }

        // Regression: an older full refresh must not undo an acknowledged save.
        do {
            let concurrentModel = NativeAppModel(session: ServerSession(), api: api)
            raceHandler(goalsJSON)
            await concurrentModel.refreshAll(requestHandshake: false)
            let auditRequests = RequestLog()
            StubProtocol.handler = { request in
                auditRequests.record(request)
                let path = request.url!.path
                if path.hasSuffix("/goals") {
                    return request.httpMethod == "PUT"
                        ? (200, savedRaceJSON, 0)
                        : (200, goalsJSON, 0.30)
                }
                if path.hasSuffix("/today") { return (200, todayJSON, 0) }
                if path.hasSuffix("/workouts") { return (200, fastList, 0) }
                return (503, "{}", 0)
            }
            let olderRefresh = Task { await concurrentModel.refreshAll(requestHandshake: false) }
            for _ in 0..<100 {
                if auditRequests.count(method: "GET", path: "/v1/mobile/goals") > 0 { break }
                try await Task.sleep(for: .milliseconds(2))
            }
            let acknowledged = await concurrentModel.saveRaceTarget(race, expectedRevision: 12)
            let immediatelyAfterSave = concurrentModel.goals?.revision ?? -1
            await olderRefresh.value
            print("AUDIT stale-refresh: saveAcknowledged=\(acknowledged), immediatelyAfterSaveRevision=\(immediatelyAfterSave), finalRevision=\(concurrentModel.goals?.revision ?? -1), raceDisappeared=\(concurrentModel.goals?.raceTarget == nil)")
            check(acknowledged && immediatelyAfterSave == 13 && concurrentModel.goals?.revision == 13 && concurrentModel.goals?.raceTarget == race,
                  "older GET cannot overwrite acknowledged PUT or clear the race target")
        }

        session.serverURL = URL(string: "https://rai-plan.test")
        model.serverConfigurationChanged()
        let generationRequests = RequestLog()
        StubProtocol.handler = { request in
            generationRequests.record(request)
            let path = request.url!.path
            if path.hasSuffix("/workout-plan/preview") { return (200, previewJSON, 0) }
            if path.hasSuffix("/workout-plan") { return (200, planJSON, 0) }
            if path.hasSuffix("/goals") { return (200, goalsJSON, 0) }
            return (503, "{}", 0)
        }
        let planFetched = await model.refreshWorkoutPlan()
        check(!planFetched && model.currentWorkoutPlan == nil && model.goals?.revision == 12,
              "partial legacy reads retain editable goals without promoting a stale execution response")
        let decodedPlan = try JSONDecoder().decode(MobileWorkoutPlanResponse.self, from: Data(planJSON.utf8))
        check(decodedPlan.days.first?.structure?.blocks.first?.iterations == 6, "the session structure survives the round trip")
        check(decodedPlan.days.first?.executable == true, "an executable day is marked as such")
        check(decodedPlan.planRevision == 7, "the plan revision is carried for conflict messages")

        let generated = await model.createWeeklyPlanPreview()
        check(generated, "a plan generation reports success")
        check(model.planPreview?.audit.generatedBy == "heuristic", "preview exposes rule coach provenance")
        check(model.planPreview?.audit.model == nil && model.planPreview?.audit.promptVersion == nil,
              "rule coach previews have no language model or prompt metadata")
        let generationBody = generationRequests.lastBody(method: "POST", path: "/v1/mobile/workout-plan/preview")
        let generationObject = generationBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        check(generationObject?["expectedRevision"] as? Int == 12, "a generated plan posts the loaded goals revision")
        check(generationRequests.count(method: "POST", path: "/v1/mobile/workout-plan/confirm") == 0, "preview never confirms implicitly")
        let candidate = model.planPreview!
        let confirmedJSON = generationJSON.replacingOccurrences(of: "\"revision\":8", with: "\"revision\":13")
        StubProtocol.handler = { _ in (503, "{}", 0) }
        await model.refreshAll(requestHandshake: false)
        StubProtocol.handler = { request in
            let path = request.url!.path
            if path.hasSuffix("/confirm") { return (200, confirmedJSON, 0) }
            if path.hasSuffix("/goals") { return (200, goalsJSON, 0) }
            if path.hasSuffix("/today") { return (200, todayJSON, 0) }
            if path.hasSuffix("/workout-plan") { return (200, planJSON, 0) }
            return (503, "{}", 0)
        }
        let offlineConfirm = await model.confirmPlanPreview(candidate)
        check(!offlineConfirm && model.planPreview?.candidateId == candidate.candidateId, "offline confirmation is rejected without discarding the preview")
        _ = await model.refreshPlanState()
        let confirmedWithStaleReads = await model.confirmPlanPreview(candidate)
        check(confirmedWithStaleReads && model.planPreview == nil, "confirmation acknowledgement survives stale follow-up reads")
        check(model.planPresentation.availability == .savedAwaitingRefresh && model.planPresentation.goals == nil, "saved acknowledgement plus old goals exposes saved-awaiting-refresh, not old current controls")
        check(model.planMessage?.contains("已保存，但显示未刷新") == true, "partial refresh is not reported as failed persistence")
        let staleRefresh = await model.refreshPlanState()
        check(!staleRefresh, "old read revision cannot satisfy acknowledged confirmation revision")
        do {
            StubProtocol.handler = { _ in (503, "{}", 0) }
            let restarted = NativeAppModel(session: session, api: api, now: { modelNow })
            await restarted.bootstrap()
            check(restarted.currentPlanRevision >= 13 && restarted.currentWorkoutPlan == nil,
                  "manual confirm watermark survives all failed reads and offline restart")
            restarted.clearCache()
            check(restarted.currentPlanRevision >= 13, "clear-cache preserves acknowledged execution safety floor")
        }

        StubProtocol.handler = { request in
            let path = request.url!.path
            if path.hasSuffix("/goals") { return (200, goalsJSON.replacingOccurrences(of: "\"revision\":12", with: "\"revision\":13"), 0) }
            if path.hasSuffix("/today") { return (200, todayJSON.replacingOccurrences(of: "\"planRevision\":12", with: "\"planRevision\":13"), 0) }
            if path.hasSuffix("/workout-plan") {
                // 2026-10-18（审查 P2-7）：legacy 读取现在要求窗口首日==today 且逐日连续；
                // 旧 fixture 的 09-11/09-12 会被拒绝，这里换成当天起的滚动窗口。
                let coherent = planJSON
                    .replacingOccurrences(of: "\"planRevision\":7", with: "\"planRevision\":13")
                    .replacingOccurrences(of: "\"localDate\":\"2026-09-11\"", with: "\"localDate\":\"2026-09-16\"")
                    .replacingOccurrences(of: "\"localDate\":\"2026-09-12\"", with: "\"localDate\":\"2026-09-17\"")
                return (200, coherent, 0)
            }
            return (503, "{}", 0)
        }
        let latestPlanRefreshed = await model.refreshPlanState()
        check(latestPlanRefreshed && model.goals?.revision == 13 && model.workoutPlan?.planRevision == 13, "matching acknowledged revision refreshes every dependent plan surface")
        let verifiedWatchPlan = model.workoutPlan!
        model.recordWatchAcknowledgement(
            plan: verifiedWatchPlan,
            scheduleHour: 8
        )
        check(!model.watchNeedsUpdate, "a verified matching watch plan is current")
        let watchHourKey = "rai.training-reminder.\(model.feedbackScope).hour"
        let previousWatchHour = UserDefaults.standard.object(forKey: watchHourKey)
        UserDefaults.standard.set(8, forKey: watchHourKey)
        model.recordWatchAcknowledgement(plan: verifiedWatchPlan, scheduleHour: 7)
        check(model.watchNeedsUpdate, "a changed reminder hour dirties the Watch plan against the hour actually synced")
        if let previousWatchHour {
            UserDefaults.standard.set(previousWatchHour, forKey: watchHourKey)
        } else {
            UserDefaults.standard.removeObject(forKey: watchHourKey)
        }
        model.recordWatchAcknowledgement(plan: verifiedWatchPlan, scheduleHour: 8)
        var watchObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(verifiedWatchPlan)) as! [String: Any]
        watchObject["generatedAt"] = "2099-01-01T00:00:00Z"
        let reloadedWatchPlan = try JSONDecoder().decode(MobileWorkoutPlanResponse.self, from: JSONSerialization.data(withJSONObject: watchObject))
        check(!model.watchPlanNeedsUpdate(reloadedWatchPlan), "read timestamps alone do not dirty device scheduling")
        var watchDays = watchObject["days"] as! [[String: Any]]
        watchDays[0]["executable"] = false
        watchObject["days"] = watchDays
        let gatedWatchPlan = try JSONDecoder().decode(MobileWorkoutPlanResponse.self, from: JSONSerialization.data(withJSONObject: watchObject))
        check(model.watchPlanNeedsUpdate(gatedWatchPlan), "same goals revision with a newly vetoed prescription needs device update")
        check(model.commitScheduleWithdrawal(journal: model.makeClearJournal()!, previous: model.watchLedger, empty: true),
              "verified withdrawal commits its safety records together")
        check(!model.watchNeedsUpdate && !model.watchNeedsClear, "a verified Watch withdrawal clears the stale acknowledgement")

        StubProtocol.handler = { _ in
            (409, "{\"code\":\"mobile_goals_revision_conflict\",\"message\":\"训练目标已在其他页面更新\"}", 0)
        }
        let conflicted = await model.createWeeklyPlanPreview()
        check(!conflicted, "a revision conflict is reported as a failure")
        check(model.planMessage == "训练目标已在别处更新，请重新生成本周课表。", "a revision conflict tells the user to regenerate")

        let failedRevisionRequests = RequestLog()
        session.serverURL = URL(string: "https://rai-plan-goals-fail.test")
        model.serverConfigurationChanged()
        StubProtocol.handler = { request in
            failedRevisionRequests.record(request)
            return request.url!.path.hasSuffix("/goals") ? (503, "{}", 0) : (200, generationJSON, 0)
        }
        let missingRevision = await model.createWeeklyPlanPreview()
        check(!missingRevision, "generation fails closed when the goals revision cannot be read")
        check(
            failedRevisionRequests.count(method: "POST", path: "/v1/mobile/workout-plan/preview") == 0,
            "a failed goals read never posts an unlocked generation"
        )
        check(
            model.planMessage?.contains("取消生成") == true,
            "a failed goals read explains that generation was cancelled safely"
        )

        let cancelledGenerationRequests = RequestLog()
        session.serverURL = URL(string: "https://rai-plan-cancel.test")
        model.serverConfigurationChanged()
        StubProtocol.handler = { request in
            cancelledGenerationRequests.record(request)
            return request.url!.path.hasSuffix("/goals") ? (200, goalsJSON, 0.15) : (200, generationJSON, 0)
        }
        let cancelledGeneration = Task { await model.createWeeklyPlanPreview() }
        try await Task.sleep(for: .milliseconds(20))
        cancelledGeneration.cancel()
        _ = await cancelledGeneration.value
        check(
            cancelledGenerationRequests.count(method: "POST", path: "/v1/mobile/workout-plan/preview") == 0,
            "cancelling while goals load never posts generation"
        )

        let switchedGenerationRequests = RequestLog()
        session.serverURL = URL(string: "https://rai-plan-old.test")
        model.serverConfigurationChanged()
        StubProtocol.handler = { request in
            switchedGenerationRequests.record(request)
            return request.url!.path.hasSuffix("/goals") ? (200, goalsJSON, 0.15) : (200, generationJSON, 0)
        }
        let oldGeneration = Task { await model.createWeeklyPlanPreview() }
        try await Task.sleep(for: .milliseconds(20))
        session.serverURL = URL(string: "https://rai-plan-new.test")
        model.serverConfigurationChanged()
        _ = await oldGeneration.value
        check(
            switchedGenerationRequests.count(method: "POST", path: "/v1/mobile/workout-plan/preview") == 0,
            "switching servers while goals load never posts to the old server"
        )
        check(model.planMessage == nil, "switching configurations clears the old plan message")

        session.serverURL = URL(string: "https://rai-plan-loading-old.test")
        model.serverConfigurationChanged()
        StubProtocol.handler = { request in
            guard request.url!.path.hasSuffix("/workout-plan") else { return (503, "{}", 0) }
            return (200, planJSON, request.url!.host!.contains("old") ? 0.18 : 0.35)
        }
        let oldPlanLoad = Task { await model.refreshWorkoutPlan() }
        try await Task.sleep(for: .milliseconds(20))
        session.serverURL = URL(string: "https://rai-plan-loading-new.test")
        model.serverConfigurationChanged()
        let newPlanLoad = Task { await model.refreshWorkoutPlan() }
        try await Task.sleep(for: .milliseconds(220))
        _ = await oldPlanLoad.value
        check(model.isLoadingWorkoutPlan, "an old plan response cannot stop the new configuration's plan loading")
        _ = await newPlanLoad.value
        check(!model.isLoadingWorkoutPlan, "the owning plan request clears its loading state")

        session.serverURL = URL(string: "https://rai-generate-loading-old.test")
        model.serverConfigurationChanged()
        StubProtocol.handler = { request in
            let path = request.url!.path
            if path.hasSuffix("/goals") { return (200, goalsJSON, 0) }
            if path.hasSuffix("/workout-plan/preview") {
                return (200, previewJSON, request.url!.host!.contains("old") ? 0.18 : 0.35)
            }
            if path.hasSuffix("/workout-plan") { return (200, planJSON, 0) }
            if path == "/v1/workouts" { return (200, list("generation-refresh"), 0) }
            return (503, "{}", 0)
        }
        let oldPlanGeneration = Task { await model.createWeeklyPlanPreview() }
        try await Task.sleep(for: .milliseconds(20))
        session.serverURL = URL(string: "https://rai-generate-loading-new.test")
        model.serverConfigurationChanged()
        let newPlanGeneration = Task { await model.createWeeklyPlanPreview() }
        try await Task.sleep(for: .milliseconds(220))
        _ = await oldPlanGeneration.value
        check(model.isRegeneratingPlan, "an old generation cannot stop the new configuration's generation spinner")
        _ = await newPlanGeneration.value
        check(!model.isRegeneratingPlan, "the owning generation request clears its spinner")

        func seedLockState() async {
            await model.refreshAll(requestHandshake: false)
        }
        session.serverURL = URL(string: "https://rai-lock-loading-old.test")
        model.serverConfigurationChanged()
        let lockPlanJSON = try PlanTestFixtures.json(PlanTestFixtures.plan(revision: 12, dates: ["2026-09-16", "2026-09-17"]))
        StubProtocol.handler = { request in
            let path = request.url!.path
            if path.hasSuffix("/lock") {
                return (200, goalsJSON, request.url!.host!.contains("old") ? 0.18 : 0.35)
            }
            if path.hasSuffix("/today") { return (200, todayJSON, 0) }
            if path.hasSuffix("/goals") { return (200, goalsJSON, 0) }
            if path.hasSuffix("/workout-plan") { return (200, lockPlanJSON, 0) }
            if path == "/v1/workouts" { return (200, list("lock-refresh"), 0) }
            return (503, "{}", 0)
        }
        await seedLockState()
        check(model.canConfirmToday, "fixture business date is confirmable under the injected clock")
        modelNow = ISO8601DateFormatter().date(from: "2026-09-16T16:30:00Z")!
        check(!model.canConfirmToday, "crossing Shanghai midnight revokes confirmation without changing the payload")
        let staleLockAccepted = await model.lockNextSession()
        check(!staleLockAccepted, "model rejects a previous-day recommendation")
        modelNow = ISO8601DateFormatter().date(from: "2026-09-16T00:00:00Z")!
        let oldLock = Task { await model.lockNextSession() }
        try await Task.sleep(for: .milliseconds(20))
        session.serverURL = URL(string: "https://rai-lock-loading-new.test")
        model.serverConfigurationChanged()
        await seedLockState()
        let newLock = Task { await model.lockNextSession() }
        try await Task.sleep(for: .milliseconds(220))
        _ = await oldLock.value
        check(model.isLockingSession, "an old lock response cannot stop the new configuration's lock spinner")
        _ = await newLock.value
        check(!model.isLockingSession, "the owning lock request clears its spinner")

        let coachJSON = """
        {"generatedAt":"2026-09-11T00:30:00.000Z","revision":9,
         "audit":{"generatedBy":"heuristic","model":null,"promptVersion":null,"generatedAt":"2026-09-11T00:30:00.000Z"},
         "days":[{"localDate":"2026-09-11","kind":"easy","distanceKm":8,"structure":null,"reason":null}],
         "warnings":["已收紧本周跑量"]}
        """
        if let coach = try? JSONDecoder().decode(MobileWeeklyPlanGenerationResponse.self, from: Data(coachJSON.utf8)) {
            let summary = NativeAppModel.generationSummary(coach)
            check(summary.contains("规则教练生成"), "a coach plan is labelled as rule generation")
            check(summary.contains("已收紧本周跑量"), "rule adjustments are still surfaced")
            check(!summary.contains("回退") && !summary.contains("保守模板"), "normal rule generation is never labelled as failure or fallback")
        } else {
            check(false, "a rule coach generation payload decodes")
        }
        check(NativeAppModel.planSourceName("llm") == "历史模型课表", "legacy plans are not relabelled as rule generation")
        check(NativeAppModel.planSourceName("manual") == "手工计划", "manual provenance stays distinct")
        check(NativeAppModel.planSourceName("future-source") == "来源未知", "unknown provenance does not pretend to be a rule plan")

        // The server prepends the overwrite note, so a one-warning display would
        // hide that stored work was replaced.
        let overwrittenJSON = """
        {"generatedAt":"2026-09-11T00:30:00.000Z","revision":10,
         "audit":{"generatedBy":"heuristic","model":null,"promptVersion":null,"generatedAt":"2026-09-11T00:30:00.000Z"},
         "days":[{"localDate":"2026-09-11","kind":"interval","distanceKm":9,"structure":null,"reason":null}],
         "warnings":["已覆盖 2 天既有课表（2026-09-12、2026-09-13）：原有分段与说明不再保留","自然周剩余预算已用完","第三条不该出现"]}
        """
        if let overwritten = try? JSONDecoder().decode(MobileWeeklyPlanGenerationResponse.self, from: Data(overwrittenJSON.utf8)) {
            let summary = NativeAppModel.generationSummary(overwritten)
            check(summary.contains("规则教练生成"), "a rewritten plan still names its rule coach")
            check(summary.contains("已覆盖 2 天既有课表"), "an overwrite of stored work is surfaced")
            check(summary.contains("自然周剩余预算已用完"), "the rule adjustment is still surfaced")
            check(!summary.contains("第三条"), "the summary stays short instead of listing every warning")
        } else {
            check(false, "an overwrite generation payload decodes")
        }

        // Receipt regression uses actual scheduler output, never re-derives
        // confirmation from original plan dates/structures.
        do {
            let receiptPlan = PlanTestFixtures.plan(dates: ["2026-10-09", "2026-10-10", "2026-10-11"])
            let fake = FakeWorkoutScheduler(); fake.silentDates = ["2026-10-10"]
            let outcome = await PlanWatchScheduling.sync(scheduler: fake, plan: receiptPlan, completedDates: [], hour: 8,
                now: ISO8601DateFormatter().date(from: "2026-10-08T00:00:00Z")!, journal: FakePlanScheduleStorage.journal(), isCurrent: { true })
            let receiptSession = ServerSession()
            let receiptModel = NativeAppModel(session: receiptSession, api: api)
            let log = RequestLog()
            StubProtocol.handler = { request in
                log.record(request)
                return (503, "{}", 0)
            }
            let failed = await receiptModel.recordPlanSyncReceipts(outcome.receipts)
            check(failed != nil && receiptModel.hasPendingPlanReceipts, "failed registration retains exact confirmed receipts for foreground retry")
            check(log.count(method: "POST", path: "/v1/mobile/workout-plan/synced") == 2, "partial sync registers exactly two verified days, not the unverified day")
            let pending = CacheStore().pendingPlanReceipts(scope: receiptModel.feedbackScope)
            check(pending.map(\.localDate) == ["2026-10-09", "2026-10-11"] && pending.map(\.workoutID) == outcome.receipts.map(\.workoutID), "retained journal carries actual exported day IDs and structures")
            StubProtocol.handler = { request in log.record(request); return (200, "{\"recordedAt\":\"2026-10-08T00:00:00Z\"}", 0) }
            let repaired = await receiptModel.recordPlanSyncReceipts(pending)
            check(repaired == nil && !receiptModel.hasPendingPlanReceipts, "foreground retry clears only successfully registered entries")
            _ = await receiptModel.recordPlanSyncReceipts([])
            check(log.count(method: "POST", path: "/v1/mobile/workout-plan/synced") == 4, "empty confirmed set emits no guessed receipts")
            let body = try JSONSerialization.jsonObject(with: log.lastBody(method: "POST", path: "/v1/mobile/workout-plan/synced")!) as! [String: Any]
            check(body["workoutID"] == nil && body["idempotencyKey"] == nil && body["structure"] != nil, "older server wire contract omits new metadata but retains actual export")
            let modernSession = ServerSession()
            CacheStore.saveHandshake(RaiHandshake(serverId: "fixture-server", athleteId: "fixture-athlete",
                datasetEpoch: "fixture-epoch", syncProtocolVersion: 1, apiVersion: "v1", planReceiptMetadata: true),
                baseURL: modernSession.serverURL!)
            let modernModel = NativeAppModel(session: modernSession, api: api)
            let modernResult = await modernModel.recordPlanSyncReceipts(outcome.receipts)
            let modernBody = try JSONSerialization.jsonObject(with: log.lastBody(method: "POST", path: "/v1/mobile/workout-plan/synced")!) as! [String: Any]
            let exported = outcome.receipts.last!
            check(modernResult == nil && modernBody["workoutID"] as? String == exported.workoutID &&
                  modernBody["scheduledAt"] as? String == exported.scheduledAt &&
                  modernBody["idempotencyKey"] as? String == exported.idempotencyKey,
                  "advertised receipt capability sends actual verified UUID/time and stable idempotency key")
        }

        // --- shared goal-editor rules ----------------------------------------
        // Both skins validate through `NativeGoalWeekDraft`. The rules used to be
        // duplicated byte-for-byte in each skin, which is how the 2026-09-13 fix
        // shipped in one skin only.
        check(NativeGoalWeekDraft.parsedDistance(" 12.5 ") == 12.5, "a padded distance parses")
        check(NativeGoalWeekDraft.parsedDistance("") == nil, "an empty field means unset, not zero")
        check(NativeGoalWeekDraft.parsedDistance("abc") == nil, "a non-numeric distance does not parse")
        check(
            NativeGoalWeekDraft.dayDistanceIsValid("") && NativeGoalWeekDraft.dayDistanceIsValid("80"),
            "a day may be unset or sit exactly on the cap"
        )
        check(
            !NativeGoalWeekDraft.dayDistanceIsValid("80.1") && !NativeGoalWeekDraft.dayDistanceIsValid("-1"),
            "a day outside 0–80 is rejected"
        )

        func planStructure(_ meters: Double) -> MobileSessionStructure {
            MobileSessionStructure(
                warmup: nil,
                blocks: [MobileIntervalBlock(iterations: 1, steps: [MobileWorkoutStep(purpose: "work", goal: .distance(meters: meters), alert: nil)])],
                cooldown: nil
            )
        }
        let storedGoals = [
            MobileGoalsPlanItem(localDate: "2026-09-16", kind: "easy", distanceKm: 8, structure: planStructure(2_000), reason: nil),
            MobileGoalsPlanItem(localDate: "2026-09-17", kind: "tempo", distanceKm: 10, structure: planStructure(3_000), reason: nil)
        ]
        let seeded = NativeGoalWeekDraft.drafts(from: storedGoals)
        check(seeded["2026-09-16"] == String(8.0), "drafts seed one text field per stored day")
        check(NativeGoalWeekDraft.parsedDistance(seeded["2026-09-16"] ?? "") == 8, "a seeded draft parses back to its distance")
        check(
            NativeGoalWeekDraft.drafts(from: [
                MobileGoalsPlanItem(localDate: "2026-09-18", kind: "rest", distanceKm: nil, structure: nil, reason: nil)
            ])["2026-09-18"] == "",
            "a day with no distance seeds an empty field"
        )
        check(
            NativeGoalWeekDraft.distancesAreValid(["2026-09-16": "8", "2026-09-17": "10"], for: storedGoals),
            "a week of valid drafts passes"
        )
        check(
            !NativeGoalWeekDraft.distancesAreValid(["2026-09-16": "81", "2026-09-17": "10"], for: storedGoals),
            "one out-of-range draft fails the whole week"
        )
        check(
            NativeGoalWeekDraft.distancesAreValid([:], for: storedGoals),
            "a missing draft falls back to unset rather than invalid"
        )

        // The structure belongs to the kind and the size it was generated for, so
        // it is dropped — and only dropped — when either of those moved.
        let kindChanged = NativeGoalWeekDraft.normalized(
            [
                MobileGoalsPlanItem(localDate: "2026-09-16", kind: "easy", distanceKm: 8, structure: planStructure(2_000), reason: nil),
                MobileGoalsPlanItem(localDate: "2026-09-17", kind: "easy", distanceKm: 10, structure: planStructure(3_000), reason: nil)
            ],
            drafts: ["2026-09-16": "8", "2026-09-17": "10"],
            loaded: storedGoals
        )
        check(kindChanged[0].distanceKm == 8, "an untouched day keeps its distance")
        check(kindChanged[0].structure != nil, "an untouched day keeps its prescription")
        check(kindChanged[1].structure == nil, "a day whose kind changed drops the stale prescription")
        check(kindChanged[1].distanceKm == 10, "the unchanged distance is still applied")

        let resized = NativeGoalWeekDraft.normalized(
            [MobileGoalsPlanItem(localDate: "2026-09-16", kind: "easy", distanceKm: 8, structure: planStructure(2_000), reason: nil)],
            drafts: ["2026-09-16": "12"],
            loaded: storedGoals
        )
        check(resized[0].distanceKm == 12, "a resized day takes the new distance")
        check(resized[0].structure == nil, "a resized day drops the stale prescription")

        let cleared = NativeGoalWeekDraft.normalized(
            [MobileGoalsPlanItem(localDate: "2026-09-16", kind: "easy", distanceKm: 8, structure: planStructure(2_000), reason: nil)],
            drafts: ["2026-09-16": ""],
            loaded: storedGoals
        )
        check(cleared[0].distanceKm == nil, "clearing the field unsets the distance")
        check(cleared[0].structure == nil, "unsetting the distance drops the stale prescription")

        // 校准提示判据：契约取值域是 `not_started | calibrating | completed`。
        // 曾写成 `!= "ready"` —— 契约里没有的取值，于是对任何输入都恒为真，把
        // "校准完成"渲染成黄色告警框（内容还是"校准完成，真实能力可以当作主参考"）。
        // 未知取值与 `nil` 必须走"继续提示"，不许被映射到宽松分支。
        let calibrationCases: [(String?, Bool)] = [
            ("completed", false),
            ("calibrating", true),
            ("not_started", true),
            ("ready", true),
            ("", true),
            (nil, true)
        ]
        for (status, expected) in calibrationCases {
            check(calibrationNeedsAttention(status) == expected,
                  "calibration '\(status ?? "nil")' needs attention == \(expected)")
        }

        // Feedback uses the real HTTP client and model. Lost acknowledgements retain the key and payload.
        let feedbackModel = NativeAppModel(session: ServerSession(), api: api)
        let feedbackInput = try JSONDecoder().decode(NativeWorkoutFeedbackInput.self, from: Data("""
        {"trainingSessionId":"feedback-run","expectedRevision":0,"eligibilityOverride":"exclude","statisticsParticipation":"include",
         "sessionType":"race","performanceProtocol":"five_k_time_trial","rpe":7,"conditionTags":["hot"],"note":"draft"}
        """.utf8))
        let feedbackLog = RequestLog()
        StubProtocol.handler = { request in
            feedbackLog.record(request)
            return (503, "{}", 0)
        }
        if case .pending = await feedbackModel.saveFeedback(feedbackInput) {} else { preconditionFailure("lost reply must be pending") }
        let retained = feedbackModel.pendingFeedback(for: "feedback-run")
        check(retained != nil, "lost feedback reply retains durable command")
        let firstPayload = try JSONDecoder().decode(NativeFeedbackCommand.self, from: feedbackLog.lastBody(method: "POST", path: "/v1/commands")!)
        check(firstPayload.payload == feedbackInput, "feedback preserves all override fields")
        StubProtocol.handler = { request in
            feedbackLog.record(request)
            if request.url!.path == "/v1/commands" {
                return (200, "{\"id\":\"cmd-feedback\",\"status\":\"succeeded\",\"result\":{\"overrideId\":\"override-1\",\"jobId\":\"job-feedback\"}}", 0)
            }
            if request.url!.path == "/v1/jobs/job-feedback" { return (200, "{\"status\":\"failed\"}", 0) }
            return (503, "{}", 0)
        }
        if case .saved(let text) = await feedbackModel.saveFeedback(feedbackInput) {
            check(text.contains("反馈已保存") && text.contains("分析更新未完成"), "analysis failure cannot turn saved feedback into unsaved")
        } else { preconditionFailure("receipt success must be saved") }
        let retried = try JSONDecoder().decode(NativeFeedbackCommand.self, from: feedbackLog.lastBody(method: "POST", path: "/v1/commands")!)
        check(retried.idempotencyKey == firstPayload.idempotencyKey, "uncertain feedback retries reuse the same key")
        check(feedbackModel.pendingFeedback(for: "feedback-run") == nil, "successful feedback clears pending command")

        let rejectedModel = NativeAppModel(session: ServerSession(), api: api)
        StubProtocol.handler = { _ in (400, "{\"code\":\"request_error\",\"message\":\"invalid feedback\"}", 0) }
        if case .failed = await rejectedModel.saveFeedback(feedbackInput) {} else { preconditionFailure("rejected enqueue must unlock editing") }
        check(rejectedModel.pendingFeedback(for: "feedback-run") == nil, "rejected enqueue does not pin the form forever")
        StubProtocol.handler = { _ in (200, "{\"id\":\"cmd-feedback\",\"status\":\"failed\",\"error\":{\"code\":\"workout_override_revision_conflict\",\"message\":\"训练反馈已在别处更新\"}}", 0) }
        if case .failed(let text) = await rejectedModel.saveFeedback(feedbackInput) {
            check(text.contains("别处更新"), "feedback conflict is actionable and preserves draft")
        } else { preconditionFailure("CAS conflict cannot succeed") }

        // §5 环境修正三态（docs/ALGORITHM.md）。契约要求 `applied` / `not_needed` /
        // `unavailable` 在 UI 里可区分：把三者压成同一个字符串，就会让"本次没带天气"
        // 读成"无需修正"—— 这正是该契约存在的理由。未知取值一律落到安全侧。
        check(nativeEnvironmentStatus("applied") == "已按环境条件修正", "Applied correction has its own wording")
        check(nativeEnvironmentStatus("not_needed") == "处于参考条件，未修正", "Reference conditions say so explicitly")
        check(nativeEnvironmentStatus("unavailable") == "环境数据不足，未修正", "Missing weather must not read as no adjustment")
        check(nativeEnvironmentStatus("applied") != nativeEnvironmentStatus("unavailable"),
              "The two states a reader must never confuse stay distinguishable")
        check(nativeEnvironmentStatus("brand_new_status") == "环境数据不足，未修正",
              "An unknown status falls to the safe side, never to 'not needed'")

        let coachPlanJSON = """
        {"id":"coach-fixture","startedOn":"2026-09-16","status":"active","pausedOn":null,"endedOn":null,
         "adaptationKey":"facts","adaptedAt":"2026-09-16T01:00:00Z","goal":"fitness","raceDate":null,
         "raceDistanceKm":null,"targetTimeSeconds":null,"runningDays":[1,2,4,6,7],"longRunDays":[7],
         "targetType":"heart_rate","strengthTraining":true,"durationWeeks":12}
        """
        let decodedCoach = try JSONDecoder().decode(MobileRunCoachPlan.self, from: Data(coachPlanJSON.utf8))
        check(decodedCoach.config.longRunDays == [7] && decodedCoach.config.targetType == "heart_rate", "coach DTO preserves training preferences")
        let roundTrippedCoach = try JSONDecoder().decode(MobileRunCoachPlan.self, from: JSONEncoder().encode(decodedCoach))
        check(roundTrippedCoach == decodedCoach,
              "coach plan survives the offline cache round trip")
        let runCoachJSON = """
        {"revision":2,"plan":\(coachPlanJSON),"phase":null,"daysToRace":null,"elapsedWeeks":0,"weeklyCapacityKm":5,"notices":[],"phases":[],"strength":[]}
        """
        let coachGoals = { (revision: Int) in """
        {"revision":\(revision),"easyDurationFloorFraction":0.8,"qualitySessionCap":2,"raceTarget":null,
         "weekPlan":[],"lockedSession":null,"weekPlanAudit":null,"weekPlanReplanRequired":false,
         "runCoach":\(revision == 1 ? "null" : coachPlanJSON),"updatedAt":"2026-09-16T01:00:00Z"}
        """ }
        let coachSession = ServerSession()
        let coachModel = NativeAppModel(session: coachSession, api: api)
        let coachLog = RequestLog()
        StubProtocol.handler = { request in
            coachLog.record(request)
            if request.url!.path == "/v1/mobile/run-coach" { return (200, runCoachJSON, 0) }
            if request.url!.path == "/v1/mobile/goals" {
                return (200, coachGoals(coachLog.count(method: "POST", path: "/v1/mobile/run-coach") == 0 ? 1 : 2), 0)
            }
            return (503, "{}", 0)
        }
        _ = await coachModel.refreshPlanState()
        let coachSaved = await coachModel.changeRunCoach(action: "start", config: decodedCoach.config)
        check(coachSaved, "coach acknowledgement remains saved even when dependent reads fail")
        check(coachModel.runCoach?.revision == 2 && coachModel.goals?.runCoach?.id == "coach-fixture", "coach write refreshes the matching goals revision")
        check(coachModel.runCoachError?.contains("已保存") == true, "a partial refresh is not reported as a failed coach save")
        let coachBody = try JSONSerialization.jsonObject(with: coachLog.lastBody(method: "POST", path: "/v1/mobile/run-coach")!) as! [String: Any]
        check(coachBody["expectedRevision"] as? Int == 1 && coachBody["action"] as? String == "start", "coach commands carry the editor's CAS revision")
        let encodedConfig = coachBody["config"] as! [String: Any]
        check(encodedConfig["raceDate"] is NSNull && encodedConfig["raceDistanceKm"] is NSNull && encodedConfig["targetTimeSeconds"] is NSNull,
              "fitness commands explicitly encode nullable fields required by the API schema")
        check(!coachModel.isPlanBusy, "coach mutation always releases the shared plan gate")
        StubProtocol.handler = { request in
            if request.url!.path == "/v1/mobile/goals" { return (200, coachGoals(2), 0) }
            if request.url!.path == "/v1/mobile/workout-plan" {
                return (200, planJSON.replacingOccurrences(of: "\"planRevision\":7", with: "\"planRevision\":2"), 0)
            }
            return (503, "{}", 0)
        }
        let todayOnlyFailure = await coachModel.refreshPlanState()
        check(!todayOnlyFailure && !coachModel.isTodayAvailable && !coachModel.isOffline,
              "A failed today read does not mark successful goals and schedule reads offline")
        check(coachModel.goals?.runCoach?.status == "active" && coachModel.workoutPlan?.planRevision == 2 && coachModel.currentWorkoutPlan == nil,
              "a partial legacy schedule remains a reference, never current execution when today fails")
        StubProtocol.handler = { request in
            if request.url!.path == "/v1/mobile/run-coach" { return (200, runCoachJSON, 0.15) }
            return (503, "{}", 0)
        }
        let oldCoachWrite = Task { await coachModel.changeRunCoach(action: "pause") }
        try await Task.sleep(for: .milliseconds(25))
        coachSession.serverURL = URL(string: "https://new-coach-scope.invalid")
        let obsoleteCoachSaved = await oldCoachWrite.value
        check(!obsoleteCoachSaved, "a coach reply from the old server cannot publish into the new scope")
        check(!coachModel.isUpdatingRunCoach, "obsolete coach requests release only their own spinner")

        let partialCoachSession = ServerSession()
        let partialCoachLog = RequestLog()
        let partialCoachModel = NativeAppModel(session: partialCoachSession, api: api)
        StubProtocol.handler = { request in
            partialCoachLog.record(request)
            if request.url!.path == "/v1/mobile/run-coach" { return (200, runCoachJSON, 0) }
            if request.url!.path == "/v1/mobile/goals" && partialCoachLog.count(method: "POST", path: "/v1/mobile/run-coach") == 0 {
                return (200, coachGoals(1), 0)
            }
            return (503, "{}", 0)
        }
        _ = await partialCoachModel.refreshPlanState()
        let partiallyRefreshedCoachSaved = await partialCoachModel.changeRunCoach(action: "start", config: decodedCoach.config)
        check(partiallyRefreshedCoachSaved && partialCoachModel.currentPlanRevision == 2 && partialCoachModel.goals?.revision == 1,
              "the coach acknowledgement establishes the display revision even when every dependent read fails")
        StubProtocol.handler = { _ in (503, "{}", 0) }
        // 2026-10-18（审查 P2-7）：legacy 读取现在要求 today 属于当前业务日；
        // 该模型随后会做完整的 legacy 三读，必须注入固定时钟，不能用真实时间跑 2026-09-16 的 fixture。
        let restartedCoachModel = NativeAppModel(session: partialCoachSession, api: api, now: { modelNow })
        await restartedCoachModel.bootstrap()
        check(restartedCoachModel.isOffline && restartedCoachModel.runCoach?.revision == 2 && restartedCoachModel.currentPlanRevision == 2,
              "a saved coach acknowledgement survives an offline restart independently of the old goals cache")
        check(restartedCoachModel.goals == nil && restartedCoachModel.workoutPlan == nil,
              "older goal and workout caches cannot masquerade as the acknowledged coach revision")

        let pausedCoachPlanJSON = coachPlanJSON.replacingOccurrences(of: "\"status\":\"active\"", with: "\"status\":\"paused\"")
        let pausedCoachJSON = runCoachJSON.replacingOccurrences(of: coachPlanJSON, with: pausedCoachPlanJSON)
        let pausedGoalsJSON = coachGoals(2).replacingOccurrences(of: coachPlanJSON, with: pausedCoachPlanJSON)
        // 2026-10-18（审查 P2-7）：legacy 执行窗口必须从今天开始且逐日连续。
        let currentCoachPlanJSON = planJSON
            .replacingOccurrences(of: "\"planRevision\":7", with: "\"planRevision\":2")
            .replacingOccurrences(of: "\"localDate\":\"2026-09-11\"", with: "\"localDate\":\"2026-09-16\"")
            .replacingOccurrences(of: "\"localDate\":\"2026-09-12\"", with: "\"localDate\":\"2026-09-17\"")
        let pausedRetryLog = RequestLog()
        StubProtocol.handler = { request in
            pausedRetryLog.record(request)
            if request.url!.path == "/v1/mobile/run-coach" { return (200, pausedCoachJSON, 0) }
            if request.url!.path == "/v1/mobile/goals" { return (200, pausedGoalsJSON, 0) }
            if request.url!.path == "/v1/mobile/today" { return (200, todayJSON.replacingOccurrences(of: "\"planRevision\":12", with: "\"planRevision\":2"), 0) }
            if request.url!.path == "/v1/mobile/workout-plan" { return (200, currentCoachPlanJSON, 0) }
            return (503, "{}", 0)
        }
        let pausedRetrySucceeded = await restartedCoachModel.refreshRunCoach()
        check(pausedRetrySucceeded && !restartedCoachModel.isOffline && restartedCoachModel.runCoach?.plan?.status == "paused",
              "an offline paused-coach retry restores connectivity and the acknowledged state")
        check(restartedCoachModel.goals?.revision == 2 && restartedCoachModel.workoutPlan?.planRevision == 2 && restartedCoachModel.runCoachError == nil,
              "paused-coach retry repairs dependent reads and clears the partial-refresh error")
        check(pausedRetryLog.count(method: "POST", path: "/v1/mobile/run-coach") == 0,
              "paused-coach retry remains read-only and does not resume the plan")

        let newerPausedCoachJSON = pausedCoachJSON.replacingOccurrences(of: "\"revision\":2", with: "\"revision\":3")
        StubProtocol.handler = { request in
            if request.url!.path == "/v1/mobile/run-coach" { return (200, newerPausedCoachJSON, 0) }
            if request.url!.path == "/v1/mobile/goals" { return (200, pausedGoalsJSON, 0) }
            if request.url!.path == "/v1/mobile/today" { return (200, todayJSON.replacingOccurrences(of: "\"planRevision\":12", with: "\"planRevision\":2"), 0) }
            if request.url!.path == "/v1/mobile/workout-plan" { return (200, currentCoachPlanJSON, 0) }
            return (503, "{}", 0)
        }
        let staleCoachRetrySucceeded = await restartedCoachModel.refreshRunCoach()
        check(!staleCoachRetrySucceeded && restartedCoachModel.currentPlanRevision == 3 && restartedCoachModel.runCoach?.revision == 3,
              "a newer coach read cannot be undone by older dependent snapshots")
        check(restartedCoachModel.runCoachError?.contains("未刷新") == true && !restartedCoachModel.isTodayAvailable,
              "stale dependent reads keep the retry error visible and cannot enable today's training")

        // All four durable write paths, including a failed acknowledgement store.
        for action in ["goals", "lock", "coach", "confirm"] {
            for persistenceFails in [false, true] {
                let isolatedSession = ServerSession()
                var clock = ISO8601DateFormatter().date(from: "2026-09-16T00:00:00Z")!
                let isolated = NativeAppModel(session: isolatedSession, api: api, now: { clock })
                let oldPlan = try PlanTestFixtures.json(PlanTestFixtures.plan(revision: 12, dates: ["2026-09-16", "2026-09-17"]))
                StubProtocol.handler = { request in
                    let path = request.url!.path
                    if path.hasSuffix("/goals") { return (200, goalsJSON, 0) }
                    if path.hasSuffix("/today") { return (200, todayJSON, 0) }
                    if path.hasSuffix("/workout-plan") { return (200, oldPlan, 0) }
                    return (503, "{}", 0)
                }
                let seeded = await isolated.refreshPlanState()
                check(seeded, "\(action): coherent safety fixtures contain real today revision")
                let v13Goals = goalsJSON.replacingOccurrences(of: "\"revision\":12", with: "\"revision\":13")
                let v13Coach = runCoachJSON.replacingOccurrences(of: "\"revision\":2", with: "\"revision\":13")
                CacheStore.failPlanWrites = persistenceFails
                CacheStore.failWrites = persistenceFails
                StubProtocol.handler = { request in
                    guard request.httpMethod == "PUT" || request.httpMethod == "POST" else { return (503, "{}", 0) }
                    if request.url!.path.hasSuffix("/confirm") { return (200, confirmedJSON, 0) }
                    if request.url!.path.hasSuffix("/run-coach") { return (200, v13Coach, 0) }
                    return (200, v13Goals, 0)
                }
                let saved: Bool
                switch action {
                case "goals": saved = await isolated.saveGoals(expectedRevision: 12, easyDurationFloorFraction: 0.8, qualitySessionCap: 2, weekPlan: [])
                case "lock": saved = await isolated.lockNextSession()
                case "coach": saved = await isolated.changeRunCoach(action: "start", config: decodedCoach.config, expectedRevision: 12)
                default:
                    isolated.planPreview = candidate
                    saved = await isolated.confirmPlanPreview(candidate)
                }
                CacheStore.failPlanWrites = false
                CacheStore.failWrites = false
                check(saved && isolated.currentPlanRevision == 13 && isolated.currentWorkoutPlan == nil,
                      "\(action): acknowledgement survives failed dependent reads")
                if persistenceFails {
                    check(isolated.planPersistenceFailed && isolated.errorMessage?.contains("本地确认记录未持久化") == true,
                          "\(action): failed durable write is visible and execution is quarantined")
                }
                let restarted = NativeAppModel(session: isolatedSession, api: api, now: { clock })
                await restarted.bootstrap()
                check(restarted.currentPlanRevision >= 13 && restarted.currentWorkoutPlan == nil,
                      "\(action): offline restart cannot expose old v12 executable cache")
                check(restarted.planPersistenceFailed == persistenceFails,
                      "\(action): independent quarantine survives a failed SQLite acknowledgement")
                let freshPlan = try PlanTestFixtures.json(PlanTestFixtures.plan(revision: 13, dates: ["2026-09-16", "2026-09-17"]))
                StubProtocol.handler = { request in
                    if request.url!.path.hasSuffix("/goals") { return (200, v13Goals, 0) }
                    if request.url!.path.hasSuffix("/today") { return (200, todayJSON.replacingOccurrences(of: "\"planRevision\":12", with: "\"planRevision\":13"), 0) }
                    if request.url!.path.hasSuffix("/workout-plan") { return (200, freshPlan, 0) }
                    return (503, "{}", 0)
                }
                let recovered = await restarted.refreshPlanState()
                check(recovered && !restarted.planPersistenceFailed && restarted.currentWorkoutPlan?.planRevision == 13,
                      "\(action): online coherent confirmation repairs persistence and execution")
                let lease = restarted.beginPlanSync()!
                let snapshot = restarted.planSyncSnapshot(lease)!
                check(restarted.isCurrentPlanSync(snapshot), "\(action): complete snapshot obtains lease")
                var changed = try JSONSerialization.jsonObject(with: Data(freshPlan.utf8)) as! [String: Any]
                changed["generatedAt"] = "2099-01-01T00:00:00Z"
                var wire = String(decoding: try JSONSerialization.data(withJSONObject: changed), as: UTF8.self)
                StubProtocol.handler = { request in
                    if request.url!.path.hasSuffix("/goals") { return (200, v13Goals, 0) }
                    if request.url!.path.hasSuffix("/today") { return (200, todayJSON.replacingOccurrences(of: "\"planRevision\":12", with: "\"planRevision\":13"), 0) }
                    if request.url!.path.hasSuffix("/workout-plan") { return (200, wire, 0) }
                    return (503, "{}", 0)
                }
                _ = await restarted.refreshWorkoutPlan()
                check(restarted.isCurrentPlanSync(snapshot), "only generatedAt changes do not invalidate the lease")
                var renamedDays = changed["days"] as! [[String: Any]]
                renamedDays[0]["title"] = "仅展示名称"; renamedDays[0]["reason"] = "仅展示理由"; changed["days"] = renamedDays
                wire = String(decoding: try JSONSerialization.data(withJSONObject: changed), as: UTF8.self)
                _ = await restarted.refreshWorkoutPlan()
                check(restarted.isCurrentPlanSync(snapshot), "display wording alone does not revoke an execution-semantic lease")
                var changedDays = changed["days"] as! [[String: Any]]; changedDays[0]["executable"] = false; changed["days"] = changedDays
                wire = String(decoding: try JSONSerialization.data(withJSONObject: changed), as: UTF8.self)
                _ = await restarted.refreshWorkoutPlan()
                check(!restarted.isCurrentPlanSync(snapshot), "same revision recovery gate change invalidates the complete snapshot lease")
                restarted.endPlanSync(lease)
                if action == "goals" && !persistenceFails {
                    let goodToday = todayJSON.replacingOccurrences(of: "\"planRevision\":12", with: "\"planRevision\":13")
                    var todayWire = goodToday
                    wire = freshPlan
                    StubProtocol.handler = { request in
                        if request.url!.path.hasSuffix("/goals") { return (200, v13Goals, 0) }
                        if request.url!.path.hasSuffix("/today") { return (200, todayWire, 0) }
                        if request.url!.path.hasSuffix("/workout-plan") { return (200, wire, 0) }
                        return (503, "{}", 0)
                    }
                    _ = await restarted.refreshPlanState()
                    for change in ["structure", "timezone", "hour", "completed", "midnight", "token"] {
                        let syncID = restarted.beginPlanSync()!
                        let before = restarted.planSyncSnapshot(syncID)!
                        let hourKey = "rai.training-reminder." + restarted.feedbackScope + ".hour"
                        let originalHour = UserDefaults.standard.object(forKey: hourKey)
                        let oldToken = isolatedSession.apiToken
                        switch change {
                        case "structure":
                            let replacement = MobileWorkoutPlanResponse(generatedAt: "new timestamp", timezone: "Asia/Shanghai", windowDays: 7, planRevision: 13,
                                audit: nil, days: [PlanTestFixtures.day("2026-09-16", meters: 6000), PlanTestFixtures.day("2026-09-17")])
                            wire = try PlanTestFixtures.json(replacement); _ = await restarted.refreshWorkoutPlan()
                        case "timezone":
                            wire = try PlanTestFixtures.json(PlanTestFixtures.plan(revision: 13, dates: ["2026-09-16", "2026-09-17"], timezone: "UTC")); _ = await restarted.refreshWorkoutPlan()
                        case "hour": UserDefaults.standard.set(before.reminderHour == 8 ? 9 : 8, forKey: hourKey)
                        case "completed":
                            var object = try JSONSerialization.jsonObject(with: Data(goodToday.utf8)) as! [String: Any]
                            object["weekPlan"] = [["localDate":"2026-09-16", "kind":"easy", "title":"completed", "planned":true, "completedWorkoutId":"observed", "distanceKm":4, "workoutCount":1]]
                            todayWire = String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
                            _ = await restarted.refreshPlanState()
                        case "midnight": clock = clock.addingTimeInterval(86400)
                        default: isolatedSession.apiToken = "another identity"
                        }
                        check(!restarted.isCurrentPlanSync(before), "snapshot lease invalidates \(change), not merely revision changes")
                        restarted.endPlanSync(syncID)
                        isolatedSession.apiToken = oldToken
                        if let originalHour { UserDefaults.standard.set(originalHour, forKey: hourKey) }
                        else { UserDefaults.standard.removeObject(forKey: hourKey) }
                        clock = ISO8601DateFormatter().date(from: "2026-09-16T00:00:00Z")!
                        wire = freshPlan; todayWire = goodToday
                        _ = await restarted.refreshPlanState()
                    }
                    let coordinator = PlanWatchSyncCoordinator()
                    let fake = FakeWorkoutScheduler()
                    fake.silentDates = ["2026-09-17"]
                    let log = RequestLog()
                    StubProtocol.handler = { request in
                        log.record(request)
                        if request.url!.path.hasSuffix("/goals") { return (200, v13Goals, 0) }
                        if request.url!.path.hasSuffix("/today") { return (200, goodToday, 0) }
                        if request.url!.path.hasSuffix("/workout-plan") { return (200, freshPlan, 0) }
                        if request.url!.path.hasSuffix("/synced") { return (200, "{\"recordedAt\":\"2026-09-16T00:00:00Z\"}", 0) }
                        return (503, "{}", 0)
                    }
                    let partial = await coordinator.sync(model: restarted, scheduler: fake)
                    check(partial.contains("部分核验") && restarted.watchState == .partial && log.count(method: "POST", path: "/v1/mobile/workout-plan/synced") == 1,
                          "shared coordinator registers partial confirmed day, never calls it full coverage")
                    check(restarted.watchLedger?.entries.count == 1 && restarted.watchLedger?.registeredDates == ["2026-09-16"], "ledger stores actual confirmed coverage and separate server registration")
                    await restarted.refreshAll(requestHandshake: false)
                    check(restarted.watchState == .partial,
                          "same-scope ordinary refresh preserves this session's actual partial system verification")
                    wire = try PlanTestFixtures.json(MobileWorkoutPlanResponse(generatedAt: "new", timezone: "Asia/Shanghai", windowDays: 7, planRevision: 13,
                        audit: nil, days: [PlanTestFixtures.day("2026-09-16", meters: 6000), PlanTestFixtures.day("2026-09-17")]))
                    StubProtocol.handler = { request in
                        if request.url!.path.hasSuffix("/workout-plan") { return (200, wire, 0) }
                        return (503, "{}", 0)
                    }
                    _ = await restarted.refreshWorkoutPlan()
                    check(restarted.watchNeedsUpdate && restarted.watchStatusLabel.contains("中断"),
                          "a changed effective plan makes a partial persisted ledger stale, not partially current")
                    wire = freshPlan
                    _ = await restarted.refreshWorkoutPlan()
                    StubProtocol.handler = { request in
                        if request.url!.path.hasSuffix("/goals") { return (200, v13Goals, 0) }
                        if request.url!.path.hasSuffix("/today") { return (200, goodToday, 0) }
                        if request.url!.path.hasSuffix("/workout-plan") { return (200, wire, 0) }
                        if request.url!.path.hasSuffix("/synced") { return (200, "{\"recordedAt\":\"2026-09-16T00:00:00Z\"}", 0) }
                        return (503, "{}", 0)
                    }
                    let afterRestart = NativeAppModel(session: isolatedSession, api: api, now: { clock })
                    check(afterRestart.watchLedger?.entries.count == 1 && afterRestart.watchState == .unknown && afterRestart.hasInterruptedSchedule, "partial operation after restart remains interrupted, never becomes current verification")
                    _ = await coordinator.recover(model: restarted, scheduler: fake, withdraw: true)
                    let invalidating = FakeWorkoutScheduler()
                    var competingResult = ""
                    let competitor = FakeWorkoutScheduler()
                    invalidating.event = { event in
                        if event == "schedule" {
                            wire = freshPlan.replacingOccurrences(of: "\"executable\":true", with: "\"executable\":false")
                            StubProtocol.handler = { request in
                                if request.url!.path.hasSuffix("/workout-plan") { return (200, wire, 0) }
                                return (503, "{}", 0)
                            }
                            _ = await restarted.refreshWorkoutPlan()
                            competingResult = await coordinator.clear(model: restarted, scheduler: competitor)
                        }
                    }
                    let cancelledReport = await coordinator.sync(model: restarted, scheduler: invalidating)
                    check(cancelledReport.contains("已终止") && invalidating.removed.count == 1 && invalidating.listed.isEmpty,
                          "same-revision mid-schedule mutation uses targeted cleanup in shared coordinator")
                    check(competingResult.contains("尚未结束") && competitor.readCount == 0, "serial coordinator rejects next operation until old cleanup completes")
                    wire = freshPlan
                    let lateReceiptLog = RequestLog()
                    StubProtocol.handler = { request in
                        lateReceiptLog.record(request)
                        if request.url!.path.hasSuffix("/goals") { return (200, v13Goals, 0) }
                        if request.url!.path.hasSuffix("/today") { return (200, goodToday, 0) }
                        if request.url!.path.hasSuffix("/workout-plan") { return (200, wire, 0) }
                        if request.url!.path.hasSuffix("/synced") { return (200, "{\"recordedAt\":\"2026-09-16T00:00:00Z\"}", 0.25) }
                        return (503, "{}", 0)
                    }
                    _ = await restarted.refreshPlanState()
                    let lateReceiptScheduler = FakeWorkoutScheduler()
                    let lateSync = Task { await coordinator.sync(model: restarted, scheduler: lateReceiptScheduler) }
                    for _ in 0..<200 {
                        if lateReceiptLog.count(method: "POST", path: "/v1/mobile/workout-plan/synced") > 0 { break }
                        try await Task.sleep(for: .milliseconds(2))
                    }
                    wire = freshPlan.replacingOccurrences(of: "\"executable\":true", with: "\"executable\":false")
                    _ = await restarted.refreshWorkoutPlan()
                    let lateReport = await lateSync.value
                    check(lateReport.contains("已终止") && lateReceiptScheduler.removed.count == 2 && lateReceiptScheduler.listed.isEmpty,
                          "effective change during server receipt registration withdraws all of this operation's submitted IDs")
                    check(!restarted.hasPendingPlanReceipts && restarted.watchState == .empty,
                          "superseded withdrawn days are not queued for later registration or retained as verified current")
                    StubProtocol.handler = { _ in (503, "{}", 0) }
                    await afterRestart.bootstrap()
                    let withdrawal = await coordinator.clear(model: afterRestart, scheduler: FakeWorkoutScheduler())
                    check(withdrawal.contains("已核验清空") && afterRestart.watchState == .empty,
                          "offline restart with no current plan still supports explicit withdrawal")
                }
                // Distinct identity scope may start at its own revision, not A's floor.
                isolatedSession.serverURL = URL(string: "https://\(UUID().uuidString).invalid")!
                restarted.serverConfigurationChanged()
                check(restarted.currentPlanRevision == 0 && restarted.watchStatusLabel == "未核验", "scope switch does not carry A's revision or verification into B")
                clock = clock.addingTimeInterval(86400)
            }
        }

        do {
            let publicationSession = ServerSession()
            let clock = ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")!
            let initial = try PlanTestFixtures.json(PlanTestFixtures.state())
            let published = try PlanTestFixtures.state(revision: 13)
            let publishedJSON = try PlanTestFixtures.json(published)
            let publishedGoals = try PlanTestFixtures.json(published.goals)
            let capabilities = try PlanTestFixtures.json(RaiHandshake(serverId: "server", athleteId: "athlete", datasetEpoch: "epoch",
                syncProtocolVersion: 1, apiVersion: "v1", planSnapshotContractVersion: 1, planPublicationContractVersion: 1, planReceiptContractVersion: 2))
            let log = RequestLog()
            let publisher = NativeAppModel(session: publicationSession, api: api, now: { clock })
            StubProtocol.handler = { request in
                log.record(request)
                if request.url!.path == "/v1/handshake" { return (200, capabilities, 0) }
                if request.url!.path == "/v1/mobile/training-plan-state" { return (200, initial, 0) }
                return (503, "{}", 0)
            }
            await publisher.bootstrap()
            let rejectedEditor = await publisher.saveRaceTarget(nil, expectedRevision: 12, editorSessionID: "other-connection")
            check(!rejectedEditor && log.count(method: "PUT", path: "/v1/mobile/goals") == 0,
                  "equal revisions cannot authorize a draft owned by another connection")
            let lostReply = await publisher.saveRaceTarget(nil, expectedRevision: 12)
            check(!lostReply && publisher.hasPendingPlanPublication && publisher.currentWorkoutPlan == nil,
                  "lost business response retains durable original operation and disables old execution")
            let originalBody = log.lastBody(method: "PUT", path: "/v1/mobile/goals")!
            let operation = try JSONSerialization.jsonObject(with: originalBody) as! [String: Any]
            let operationId = operation["operationId"] as! String
            let restarted = NativeAppModel(session: publicationSession, api: api, now: { clock })
            StubProtocol.handler = { request in
                log.record(request)
                if request.url!.path == "/v1/handshake" { return (200, capabilities, 0) }
                if request.url!.path == "/v1/mobile/training-plan-state" { return (200, publishedJSON, 0) }
                if request.url!.path == "/v1/mobile/plan-operations/" + operationId {
                    return (200, "{\"status\":\"committed\",\"operationId\":\"\(operationId)\",\"result\":\(publishedGoals)}", 0)
                }
                return (503, "{}", 0)
            }
            await restarted.bootstrap()
            check(restarted.hasPendingPlanPublication, "pending publication survives model reconstruction and cached identity recovery")
            let secondPublish = await restarted.saveRaceTarget(nil, expectedRevision: 13)
            check(!secondPublish && log.count(method: "PUT", path: "/v1/mobile/goals") == 1,
                  "uncertain original result blocks a different publication without changing its revision or operation key")
            let resolved = await restarted.resolvePlanPublication()
            check(!restarted.hasPendingPlanPublication && restarted.currentPlanRevision == 13 &&
                  resolved.contains("没有再次发布") && log.count(method: "PUT", path: "/v1/mobile/goals") == 1,
                  "foreground operation query after restart accepts committed result without another business write")
        }

        do {
            // PR-01：410 是**已确认的终局**（旧面已退役），不是"结果未知"。
            // 旧文案会在收到 410 后仍提示"发布结果尚未确认"，把用户留在一个
            // 永远不会成功的重试循环里；未知 410 码同样不得自动重试。
            CacheStore.resetScheduleSafety()
            let retireSession = ServerSession()
            let retireClock = ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")!
            let retireState = try PlanTestFixtures.json(PlanTestFixtures.state())
            let retireCapabilities = try PlanTestFixtures.json(RaiHandshake(serverId: "server", athleteId: "athlete",
                datasetEpoch: "epoch", syncProtocolVersion: 1, apiVersion: "v1",
                planSnapshotContractVersion: 1, planPublicationContractVersion: 1, planReceiptContractVersion: 2))
            let retireModel = NativeAppModel(session: retireSession, api: api, now: { retireClock })
            StubProtocol.handler = { request in
                if request.url!.path == "/v1/handshake" { return (200, retireCapabilities, 0) }
                if request.url!.path == "/v1/mobile/training-plan-state" { return (200, retireState, 0) }
                return (503, "{}", 0)
            }
            await retireModel.bootstrap()
            // A separate ledger: the pending watch receipt must survive the 410
            // cleanup. Only the publication row may be closed.
            let keptReceipt = PlanSyncReceipt(localDate: "2026-10-09", kind: "easy", revision: 12,
                structure: MobileSessionStructure(warmup: nil, blocks: [.init(iterations: 1, steps: [
                    .init(purpose: "work", goal: .time(seconds: 600), alert: nil)])], cooldown: nil),
                workoutID: UUID().uuidString, scheduledAt: "2026-10-09T00:30:00Z",
                idempotencyKey: UUID().uuidString, contractVersion: 2,
                scope: .init(serverId: "server", athleteId: "athlete", datasetEpoch: "epoch"),
                operationId: UUID().uuidString, coherenceToken: String(repeating: "a", count: 64),
                verifiedAt: "2026-10-09T00:00:00Z", timezone: "Asia/Shanghai",
                prescriptionDigest: String(repeating: "b", count: 64), lifecycleEvent: "verified")
            check(CacheStore().savePendingPlanReceipts([keptReceipt], scope: retireModel.feedbackScope),
                  "fixture: seed a pending watch receipt before the retirement answer")
            for code in ["legacy_surface_retired", "unknown_gone_surface"] {
                StubProtocol.handler = { request in
                    if request.url!.path == "/v1/handshake" { return (200, retireCapabilities, 0) }
                    if request.url!.path == "/v1/mobile/training-plan-state" { return (200, retireState, 0) }
                    if request.httpMethod == "PUT" && request.url!.path == "/v1/mobile/goals" {
                        return (410, "{\"code\":\"\(code)\",\"message\":\"该旧接口已退役。\"}", 0)
                    }
                    return (503, "{}", 0)
                }
                let accepted = await retireModel.saveRaceTarget(nil, expectedRevision: 12)
                check(!accepted && !retireModel.hasPendingPlanPublication,
                      "a terminal 410 (\(code)) closes the pending publication instead of pinning it forever")
                check((retireModel.planMessage ?? "").contains("已退役") &&
                      !(retireModel.planMessage ?? "").contains("尚未确认"),
                      "after a confirmed 410 the UI never claims the result is still unconfirmed")
                check(CacheStore().pendingPlanReceipts(scope: retireModel.feedbackScope).count == 1,
                      "closing the publication row must not delete the independent watch-receipt ledger")
            }
        }

        do {
            // PR-02：新服务宣告统一**读**能力（trainingPlanContractVersion=2）但
            // 未宣告写命令能力时，旧写面必须 fail-closed，且连本地 pending 账目
            // 都不应产生。老服务两个新键都缺 ⇒ 既有协议不受影响（其他用例覆盖）。
            CacheStore.resetScheduleSafety()
            let readOnlySession = ServerSession()
            let readOnlyClock = ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")!
            let readOnlyState = try PlanTestFixtures.json(PlanTestFixtures.state())
            let readOnlyCapabilities = try PlanTestFixtures.json(RaiHandshake(serverId: "server", athleteId: "athlete",
                datasetEpoch: "epoch", syncProtocolVersion: 1, apiVersion: "v1",
                planSnapshotContractVersion: 1, trainingPlanContractVersion: 2, planReceiptContractVersion: 2))
            let readOnlyLog = RequestLog()
            let readOnlyModel = NativeAppModel(session: readOnlySession, api: api, now: { readOnlyClock })
            StubProtocol.handler = { request in
                readOnlyLog.record(request)
                if request.url!.path == "/v1/handshake" { return (200, readOnlyCapabilities, 0) }
                if request.url!.path == "/v1/mobile/training-plan-state" { return (200, readOnlyState, 0) }
                return (503, "{}", 0)
            }
            await readOnlyModel.bootstrap()
            check(!readOnlyModel.planWritesAvailable,
                  "a server advertising the unified read capability without the write command capability is read-only")
            let blocked = await readOnlyModel.saveRaceTarget(nil, expectedRevision: 12)
            check(!blocked && !readOnlyModel.hasPendingPlanPublication &&
                  readOnlyLog.count(method: "PUT", path: "/v1/mobile/goals") == 0 &&
                  (readOnlyModel.errorMessage ?? "").contains("尚未适配"),
                  "a retired legacy write is refused before any request and never creates a pending publication")
        }

        do {
            // 终局码白名单的**纯判据对账**（审查 🔴-1 / 🟡-C1 / 🟡-C4）：
            // 三组名单是"作废本地账目"的全部依据，名单成员错了就是要么锁死、要么误删。
            for code in ["plan_operation_scope_mismatch", "plan_operation_expired", "plan_operation_key_conflict"] {
                check(PlanMutationDisposition.isTerminalPlanPublicationError(code),
                      "publication terminal code \(code) must be classified terminal")
            }
            // 2026-10-18（深度审查 P3-19）：受教练合同管理的数据集对 legacy 写路由恒 409
            // `coach_loop_contract_required`（server.ts preHandler）⇒ 同一份 legacy 载荷
            // 重放永远不可能成功，必须作废本地账目，否则 `hasPendingPlanPublication` 永久钉住。
            check(PlanMutationDisposition.isTerminalPlanPublicationError("coach_loop_contract_required"),
                  "the coach-loop contract guard (409) is terminal for a legacy publication — " +
                  "replaying the same payload can never succeed while the dataset stays managed")
            check(PlanMutationDisposition.isTerminalPlanReceiptError("coach_loop_contract_required"),
                  "the coach-loop contract guard (409) is terminal for a legacy watch receipt too " +
                  "(/v1/mobile/workout-plan/** is prefix-matched) — otherwise hasPendingPlanReceipts " +
                  "stays true forever and the user has no exit")
            // PR-01：旧面退役是 410 终局；任何未知 410 也不得进入自动重试。
            check(PlanMutationDisposition.isTerminalPlanPublicationError("legacy_surface_retired"),
                  "legacy_surface_retired is terminal: the retired route can never accept the old payload")
            check(PlanMutationDisposition.isTerminalPlanPublicationStatus(410)
                    && !PlanMutationDisposition.isTerminalPlanPublicationStatus(409)
                    && !PlanMutationDisposition.isTerminalPlanPublicationStatus(503),
                  "HTTP 410 (gone) is terminal for any code, while 409/503 stay retryable")
            check(!PlanMutationDisposition.isTerminalPlanReceiptError("plan_snapshot_changed")
                    && !PlanMutationDisposition.isTerminalPlanReceiptError("database_busy"),
                  "the retryable 503 codes must NOT become terminal (they are 're-read, facts changed')")
            for code in ["network", "mutation_conflict", "unauthorized", "http_503", "http_500"] {
                check(!PlanMutationDisposition.isTerminalPlanPublicationError(code),
                      "transient publication code \(code) must NOT be terminal")
            }
            for code in ["plan_receipt_scope_mismatch", "plan_receipt_evidence_mismatch", "plan_receipt_contract_mismatch",
                         "plan_receipt_date_invalid", "plan_receipt_key_conflict",
                         "coach_receipt_contract_mismatch", "coach_receipt_evidence_mismatch",
                         "coach_loop_contract_required"] {
                check(PlanMutationDisposition.isTerminalPlanReceiptError(code),
                      "receipt terminal code \(code) must be classified terminal")
            }
            for code in ["network", "http_500", "coach_receipt_unknown_schedule", "coach_receipt_unknown_prescription"] {
                check(!PlanMutationDisposition.isTerminalPlanReceiptError(code),
                      "receipt code \(code) must NOT be terminal (server state can still advance)")
            }
            for code in ["coach_feedback_invalid", "coach_feedback_revision_conflict", "coach_feedback_not_found",
                         "FST_ERR_VALIDATION", "coach_scope_mismatch"] {
                check(PlanMutationDisposition.isTerminalCoachFeedbackError(code),
                      "feedback terminal code \(code) must be classified terminal")
            }
            check(!PlanMutationDisposition.isTerminalCoachFeedbackError("network"),
                  "a transient feedback failure must stay retryable")
        }

        do {
            // 2026-10-18（深度审查 P3-26）：读取面板失败类别的归并规则。
            // 这些布尔决定"点亮离线横幅 / 提示升级 App / 说明快照不可信"，改错方向全是
            // **用户可见的错误指引**，而此前它们是 `refresh()` 里的三个内联布尔，无判据。
            let allOk = NativeAppModel.ReadPanelTally.of([.ok, .ok, .ok, .ok])
            check(allOk.failed == 0 && allOk.anySucceeded && allOk.serverAnswered
                    && !allOk.decodingOnly && !allOk.validationOnly,
                  "four healthy panels report no failure class")
            let offline = NativeAppModel.ReadPanelTally.of([.failure, .failure, .failure, .failure])
            check(offline.failed == 4 && !offline.serverAnswered && !offline.decodingOnly && !offline.validationOnly,
                  "four network failures are the only shape that lights the offline banner")
            let decoded = NativeAppModel.ReadPanelTally.of([.decoding, .decoding, .decoding, .decoding])
            check(decoded.decodingOnly && decoded.serverAnswered && !decoded.validationOnly,
                  "pure decode failures are contract drift: reachable server, upgrade hint allowed")
            let validated = NativeAppModel.ReadPanelTally.of([.validation, .validation, .validation, .validation])
            check(validated.validationOnly && validated.serverAnswered && !validated.decodingOnly,
                  "pure safety-field failures are reachable-but-untrusted: never an upgrade hint")
            let mixedKinds = NativeAppModel.ReadPanelTally.of([.validation, .decoding, .decoding, .decoding])
            check(!mixedKinds.decodingOnly && !mixedKinds.validationOnly && mixedKinds.serverAnswered,
                  "a mixed snapshot-validation + decode failure is NEITHER pure drift NOR pure validation " +
                  "(P3-26: the old predicate counted .validation as decoding and told the user to upgrade)")
            let mixedWithOffline = NativeAppModel.ReadPanelTally.of([.ok, .ok, .decoding, .failure])
            check(!mixedWithOffline.serverAnswered && !mixedWithOffline.decodingOnly && !mixedWithOffline.validationOnly,
                  "one real network failure among decode failures keeps the offline classification")
        }

        do {
            // 2026-10-18（深度审查 P3-25）：计划业务时区解析**不再静默兜底 UTC+8**。
            // 旧实现用固定兜底值去比较绝对时刻（撤回残留判据），坏字符串会静默产出错误身份。
            check(PlanReceiptMatcher.planTimeZone("Asia/Shanghai")?.identifier == "Asia/Shanghai",
                  "a valid IANA plan timezone parses")
            check(PlanReceiptMatcher.planTimeZone("America/New_York")?.identifier == "America/New_York",
                  "a non-default plan timezone parses (no hard-coded fallback involvement)")
            check(PlanReceiptMatcher.planTimeZone("Not/AZone") == nil
                    && PlanReceiptMatcher.planTimeZone("") == nil,
                  "an unparseable plan timezone returns nil — the caller must fail closed instead of " +
                  "comparing identities with a substituted timezone")
        }

        do {
            // 版本偏斜降级（审查 🟡-B1）：缺四个核心子卡键的 today 必须**仍能解码**，
            // 且降级为诚实的空态（sync=never / coverage=none / assessment=not_assessed）。
            let skewed = """
            {"generatedAt":"2026-10-09T00:00:00Z","timezone":"Asia/Shanghai","latestDataDate":null,"lastSyncedAt":null,
            "freshness":{"state":"unknown","checkedAt":null,"latestTrainingDate":null,"recoveryDate":null},"recommendationRevision":"fixture",
            "today":{"localDate":"2026-10-09","distanceKm":0,"durationSeconds":0,"paceSecondsPerKm":null,"energyKcal":null,"workoutCount":0},
            "week":{"periodStart":"2026-10-05","periodEnd":"2026-10-11","distanceKm":0,"durationSeconds":0,"workoutCount":0},"weekDaily":[],"recentWorkouts":[],
            "ability":{"trueAbility":null,"currentAbility":null,"changeFrom7DaysAgo":null,"growthVelocityPerWeek":null,"decayPoints":0,"snapshotDate":null,"explanation":""},
            "calibration":{"status":"not_started","eligibleSessions":0,"eligibleDurationMinutes":0,"spanDays":0,"highCoverageSessions":0,"requirements":{"sessions":12,"durationMinutes":360,"spanDays":28,"highCoverageSessions":6},"message":""},
            "verdict":{"tone":"yellow","title":"","reason":"","triggers":[],"stale":false,"reasonCodes":[]},
            "nextSession":{"kind":"rest","title":"","reason":"","distanceKm":null,"durationMinutes":null,"paceSecondsPerKmLower":null,"paceSecondsPerKmUpper":null,"heartRateBpmLower":null,"heartRateBpmUpper":null,"structure":null},
            "recovery":{"score":null,"lastNightSleepMinutes":null,"sleepBaselineMinutes":null,"morningHrvMs":null,"hrvBaselineMs":null,"restingHeartRateBpm":null,"restingHeartRateBaselineBpm":null,"state":"unknown","hrvSampleCount":0,"note":""},
            "weekStructure":{"easyDurationFraction":null,"easyDurationFloorFraction":0.7,"qualitySessionCount":0,"qualitySessionCap":2,"easyHonesty":{"intendedEasyCount":0,"easyEnoughCount":0,"honestyFraction":null,"note":""}},
            "race":{"target":null,"daysUntil":null,"taper":false,"shapeScore":null,"volumeFraction":null,"longRunFraction":null,"note":""},"injuryFlags":[],"weekPlan":[],"phase":"morning_open","lock":{"present":false,"relockSuggested":false,"lockedAt":null}}
            """
            let decodedSkew = try JSONDecoder().decode(MobileTodayResponse.self, from: Data(skewed.utf8))
            check(decodedSkew.sync.status == "never" && decodedSkew.coverage.sleep.state == "none" &&
                  decodedSkew.recoveryAssessment.assessment == "not_assessed" &&
                  decodedSkew.recommendation.basis == "insufficient_training_history",
                  "a today payload missing the four core cards decodes into honest empty states instead of failing the whole page")
        }

        do {
            // 失败态可区分（审查 🟡-B2/B3）：4 个面板全部 200+非法 JSON ⇒ 不点亮"离线"、
            // 给出"版本不兼容"文案；全部 503 ⇒ 命中全失败分支（failedPanels == 4）。
            let decodeClock = ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")!
            let decodeCapabilities = try PlanTestFixtures.json(RaiHandshake(serverId: "server", athleteId: "athlete",
                datasetEpoch: "epoch", syncProtocolVersion: 1, apiVersion: "v1", planReceiptContractVersion: 2))
            let decodeModel = NativeAppModel(session: ServerSession(), api: api, now: { decodeClock })
            StubProtocol.handler = { request in
                if request.url!.path == "/v1/handshake" { return (200, decodeCapabilities, 0) }
                return (200, "{\"junk\":", 0)
            }
            await decodeModel.bootstrap()
            check(!decodeModel.isOffline && ((decodeModel.errorMessage ?? "").contains("版本不兼容")),
                  "200-with-bad-JSON must be reported as a version mismatch, never as offline")
            let networkModel = NativeAppModel(session: ServerSession(), api: api, now: { decodeClock })
            StubProtocol.handler = { request in
                // 握手成功、四个面板全失败 —— 才走到 refreshAll 的全失败分类
                // （握手本身失败会停在 connect 的"连不上"分支，那是另一条既有路径）。
                if request.url!.path == "/v1/handshake" { return (200, decodeCapabilities, 0) }
                return (503, "{}", 0)
            }
            await networkModel.bootstrap()
            check(networkModel.isOffline && ((networkModel.errorMessage ?? "").contains("核心数据均未能更新")),
                  "an all-network failure hits the whole-page branch with the true denominator (4)")
        }

        do {
            // 终局答复的清算（审查 🔴-1）：expired（410）必须作废本地账目，
            // 否则 `plan_publication_pending` 会永久拒绝后续全部计划写与手表排期。
            CacheStore.resetScheduleSafety()
            let terminalSession = ServerSession()
            let terminalClock = ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")!
            let terminalInitial = try PlanTestFixtures.json(PlanTestFixtures.state())
            let terminalCapabilities = try PlanTestFixtures.json(RaiHandshake(serverId: "server", athleteId: "athlete", datasetEpoch: "epoch",
                syncProtocolVersion: 1, apiVersion: "v1", planSnapshotContractVersion: 1, planPublicationContractVersion: 1, planReceiptContractVersion: 2))
            let terminalLog = RequestLog()
            let terminalModel = NativeAppModel(session: terminalSession, api: api, now: { terminalClock })
            StubProtocol.handler = { request in
                terminalLog.record(request)
                if request.url!.path == "/v1/handshake" { return (200, terminalCapabilities, 0) }
                if request.url!.path == "/v1/mobile/training-plan-state" { return (200, terminalInitial, 0) }
                return (503, "{}", 0)
            }
            await terminalModel.bootstrap()
            let lostTerminalReply = await terminalModel.saveRaceTarget(nil, expectedRevision: 12)
            check(!lostTerminalReply && terminalModel.hasPendingPlanPublication,
                  "terminal-answer fixture starts from a durable pending publication")
            let terminalBody = terminalLog.lastBody(method: "PUT", path: "/v1/mobile/goals")!
            let terminalOperationId = (try JSONSerialization.jsonObject(with: terminalBody) as! [String: Any])["operationId"] as! String
            StubProtocol.handler = { request in
                terminalLog.record(request)
                if request.url!.path == "/v1/handshake" { return (200, terminalCapabilities, 0) }
                if request.url!.path == "/v1/mobile/training-plan-state" { return (200, terminalInitial, 0) }
                if request.url!.path == "/v1/mobile/plan-operations/" + terminalOperationId {
                    return (200, "{\"status\":\"expired\",\"operationId\":\"\(terminalOperationId)\"}", 0)
                }
                return (503, "{}", 0)
            }
            let expiredMessage = await terminalModel.resolvePlanPublication()
            check(!terminalModel.hasPendingPlanPublication && expiredMessage.contains("已作废"),
                  "an expired terminal answer clears the durable ledger instead of wedging every later publication")
            // 账目已清 ⇒ 新发布必须重新被允许（此前会被 plan_publication_pending 永久拒绝）：
            let terminalGoals = try PlanTestFixtures.json(PlanTestFixtures.state().goals)
            StubProtocol.handler = { request in
                terminalLog.record(request)
                if request.url!.path == "/v1/handshake" { return (200, terminalCapabilities, 0) }
                if request.url!.path == "/v1/mobile/training-plan-state" { return (200, terminalInitial, 0) }
                if request.url!.path == "/v1/mobile/goals" { return (200, terminalGoals, 0) }
                return (503, "{}", 0)
            }
            let republishedAfterTerminal = await terminalModel.saveRaceTarget(nil, expectedRevision: 12)
            check(republishedAfterTerminal, "after a terminal answer clears the ledger, publishing is allowed again")
        }

        do {
            // scopeMismatch（409）与 expired 同族：同样必须清账；未知答复则必须保留账目、
            // 并由显式的「放弃本次未确认发布」出口兜底（审查 🔴-1）。
            CacheStore.resetScheduleSafety()
            let mismatchSession = ServerSession()
            let mismatchClock = ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")!
            let mismatchInitial = try PlanTestFixtures.json(PlanTestFixtures.state())
            let mismatchCapabilities = try PlanTestFixtures.json(RaiHandshake(serverId: "server", athleteId: "athlete", datasetEpoch: "epoch",
                syncProtocolVersion: 1, apiVersion: "v1", planSnapshotContractVersion: 1, planPublicationContractVersion: 1, planReceiptContractVersion: 2))
            let mismatchLog = RequestLog()
            let mismatchModel = NativeAppModel(session: mismatchSession, api: api, now: { mismatchClock })
            StubProtocol.handler = { request in
                mismatchLog.record(request)
                if request.url!.path == "/v1/handshake" { return (200, mismatchCapabilities, 0) }
                if request.url!.path == "/v1/mobile/training-plan-state" { return (200, mismatchInitial, 0) }
                return (503, "{}", 0)
            }
            await mismatchModel.bootstrap()
            _ = await mismatchModel.saveRaceTarget(nil, expectedRevision: 12)
            let mismatchBody = mismatchLog.lastBody(method: "PUT", path: "/v1/mobile/goals")!
            let mismatchOperationId = (try JSONSerialization.jsonObject(with: mismatchBody) as! [String: Any])["operationId"] as! String
            StubProtocol.handler = { request in
                if request.url!.path == "/v1/mobile/plan-operations/" + mismatchOperationId {
                    return (200, "{\"status\":\"scopeMismatch\",\"operationId\":\"\(mismatchOperationId)\"}", 0)
                }
                return (503, "{}", 0)
            }
            let mismatchMessage = await mismatchModel.resolvePlanPublication()
            check(!mismatchModel.hasPendingPlanPublication && mismatchMessage.contains("已作废"),
                  "a scopeMismatch terminal answer also clears the durable ledger")
            // 未知答复（503）保留账目；「放弃」是唯一用户可控出口，且只清本地账目：
            StubProtocol.handler = { _ in (503, "{}", 0) }
            let abandonedPublish = await mismatchModel.saveRaceTarget(nil, expectedRevision: 12)
            check(!abandonedPublish && mismatchModel.hasPendingPlanPublication,
                  "an unknown outcome retains the ledger — the explicit abandon exit is the way out")
            let abandonMessage = mismatchModel.abandonPendingPlanPublication()
            check(!mismatchModel.hasPendingPlanPublication && abandonMessage.contains("已放弃"),
                  "the explicit abandon exit clears the ledger without claiming the server operation never happened")
        }

        do {
            // 回执终局拒绝的清算（审查 🟡-C1）：内容级终局必须作废该条回执，
            // 瞬时失败必须保留 —— 否则要么永久锁死教练启用，要么把断点续传删了。
            CacheStore.resetScheduleSafety()
            let receiptSession = ServerSession()
            let receiptClock = ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")!
            let receiptState = try PlanTestFixtures.json(PlanTestFixtures.state())
            let receiptCapabilities = try PlanTestFixtures.json(RaiHandshake(serverId: "server", athleteId: "athlete", datasetEpoch: "epoch",
                syncProtocolVersion: 1, apiVersion: "v1", planSnapshotContractVersion: 1, planReceiptContractVersion: 2))
            StubProtocol.handler = { request in
                if request.url!.path == "/v1/handshake" { return (200, receiptCapabilities, 0) }
                if request.url!.path == "/v1/mobile/training-plan-state" { return (200, receiptState, 0) }
                return (503, "{}", 0)
            }
            let receiptTerminalModel = NativeAppModel(session: receiptSession, api: api, now: { receiptClock })
            await receiptTerminalModel.bootstrap()
            let receiptScheduler = FakeWorkoutScheduler()
            let receiptCoordinator = PlanWatchSyncCoordinator()
            _ = await receiptCoordinator.sync(model: receiptTerminalModel, scheduler: receiptScheduler)
            let pendingVerified = CacheStore().pendingPlanReceipts(scope: receiptTerminalModel.feedbackScope)
                .filter { $0.lifecycleEvent == "verified" }
            check(!pendingVerified.isEmpty && receiptTerminalModel.hasPendingPlanReceipts,
                  "terminal-rejection fixture starts from pending verified receipts (coach enable is blocked)")
            // 瞬时失败（500）必须保留账目：
            StubProtocol.handler = { request in
                if request.url!.path == "/v1/mobile/workout-plan/synced" { return (500, "{}", 0) }
                return (503, "{}", 0)
            }
            let retainedCount = CacheStore().pendingPlanReceipts(scope: receiptTerminalModel.feedbackScope).count
            _ = await receiptTerminalModel.recordPlanSyncReceipts([pendingVerified[0]])
            check(CacheStore().pendingPlanReceipts(scope: receiptTerminalModel.feedbackScope).count == retainedCount,
                  "a transient 5xx keeps the receipt queued for the next foreground retry")
            // 内容级终局拒绝（422 evidence_mismatch）⇒ 全部作废 + 解除阻塞：
            StubProtocol.handler = { request in
                if request.url!.path == "/v1/mobile/workout-plan/synced" {
                    return (422, "{\"code\":\"plan_receipt_evidence_mismatch\",\"message\":\"导出摘要不匹配\"}", 0)
                }
                return (503, "{}", 0)
            }
            let terminalReceiptMessage = await receiptTerminalModel.recordPlanSyncReceipts(pendingVerified)
            check(terminalReceiptMessage?.contains("终局拒绝") == true && terminalReceiptMessage?.contains("已作废") == true,
                  "a terminal receipt rejection is reported as final — not as another foreground retry")
            check(!receiptTerminalModel.hasPendingPlanReceipts &&
                  CacheStore().pendingPlanReceipts(scope: receiptTerminalModel.feedbackScope).isEmpty,
                  "terminal rejections drop the receipts so hasPendingPlanReceipts no longer blocks coach enable")
        }

        do {
            // 教练反馈终局白名单（审查 🟡-C4）：coach_scope_mismatch 必须清账而不是"重试原反馈"。
            CacheStore.resetScheduleSafety()
            let feedbackData = try Data(contentsOf: URL(fileURLWithPath: "apps/ios/tests/fixtures/coach-loop-v1.json"))
            let feedbackLoop = try JSONDecoder().decode(CoachLoopResponse.self, from: feedbackData)
            let feedbackJSON = String(decoding: feedbackData, as: UTF8.self)
            let feedbackSession = ServerSession()
            let feedbackHandshake = RaiHandshake(serverId: feedbackLoop.scope.serverId, athleteId: feedbackLoop.scope.athleteId,
                datasetEpoch: feedbackLoop.scope.datasetEpoch, syncProtocolVersion: 1, apiVersion: "v1",
                planSnapshotContractVersion: 1, planPublicationContractVersion: 1, planReceiptContractVersion: 2, coachLoopContractVersion: 1)
            CacheStore.saveHandshake(feedbackHandshake, baseURL: feedbackSession.serverURL!)
            let feedbackModel = NativeAppModel(session: feedbackSession, api: api,
                now: { ISO8601DateFormatter().date(from: "2026-10-08T04:00:00Z")! })
            StubProtocol.handler = { request in
                if request.url!.path == "/v1/mobile/coach-loop" { return (200, feedbackJSON, 0) }
                return (503, "{}", 0)
            }
            _ = await feedbackModel.refreshPlanState()
            check(feedbackModel.coachLoop != nil, "coach feedback fixture loads the new contract")
            // 瞬时失败：保留账目并提示"重试原反馈"：
            StubProtocol.handler = { request in
                if request.url!.path == "/v1/mobile/coach-feedback" { return (503, "{}", 0) }
                if request.url!.path == "/v1/mobile/coach-loop" { return (200, feedbackJSON, 0) }
                return (503, "{}", 0)
            }
            let transientFeedback = await feedbackModel.saveCoachFeedback(fields: .init(phase: "post_run", observedAt: "2026-10-08T04:00:00Z"))
            check(!transientFeedback && feedbackModel.runCoachError?.contains("重试原反馈") == true &&
                  (CacheStore().pendingCoachFeedback(scope: feedbackModel.feedbackScope).value ?? nil) != nil,
                  "a transient feedback failure keeps the queued command and asks for an explicit retry")
            // 终局（coach_scope_mismatch）：清账 + 如实告知，不再要求重试：
            StubProtocol.handler = { request in
                if request.url!.path == "/v1/mobile/coach-feedback" {
                    return (409, "{\"code\":\"coach_scope_mismatch\",\"message\":\"反馈属于其他数据集。\"}", 0)
                }
                if request.url!.path == "/v1/mobile/coach-loop" { return (200, feedbackJSON, 0) }
                return (503, "{}", 0)
            }
            let terminalFeedback = await feedbackModel.saveCoachFeedback(retry: true)
            check(!terminalFeedback && feedbackModel.runCoachError?.contains("未保存") == true &&
                  (CacheStore().pendingCoachFeedback(scope: feedbackModel.feedbackScope).value ?? nil) == nil,
                  "coach_scope_mismatch is terminal: the queued feedback is cleared instead of a doomed retry")
        }

        do {
            CacheStore.resetScheduleSafety()
            let recoverySession = ServerSession()
            let clock = ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")!
            let state = try PlanTestFixtures.json(PlanTestFixtures.state())
            let capabilities = try PlanTestFixtures.json(RaiHandshake(serverId: "server", athleteId: "athlete", datasetEpoch: "epoch",
                syncProtocolVersion: 1, apiVersion: "v1", planSnapshotContractVersion: 1, planReceiptContractVersion: 2))
            StubProtocol.handler = { request in
                switch request.url!.path {
                case "/v1/handshake": return (200, capabilities, 0)
                case "/v1/mobile/training-plan-state": return (200, state, 0)
                case "/v1/mobile/workout-plan/synced": return (200, "{\"recordedAt\":\"2026-10-09T04:00:00Z\",\"matchesCurrent\":true}", 0)
                default: return (503, "{}", 0)
                }
            }
            let original = NativeAppModel(session: recoverySession, api: api, now: { clock })
            await original.bootstrap()
            let fake = FakeWorkoutScheduler()
            let coordinator = PlanWatchSyncCoordinator()
            _ = await coordinator.sync(model: original, scheduler: fake)
            let oldLedger = original.watchLedger!
            let oldIDs = Set(oldLedger.entries.map { $0.workoutID.uuidString })
            let lease = original.beginPlanSync()!
            _ = await original.refreshPlanState()
            let snapshot = original.planSyncSnapshot(lease)!
            let journal = original.makeScheduleJournal(snapshot: snapshot)!
            let replacement = await PlanWatchScheduling.sync(scheduler: fake, plan: original.currentWorkoutPlan!, completedDates: [],
                hour: snapshot.reminderHour, now: clock, journal: journal, isCurrent: { original.isCurrentPlanSync(snapshot) })
            check(replacement.verified && !journal.operation.terminal, "replacement recovery fixture stops after SDK verification but before ledger commit")
            original.endPlanSync(lease)
            let restarted = NativeAppModel(session: recoverySession, api: api, now: { clock })
            await restarted.bootstrap()
            let first = fake.listed[0]
            fake.listed.append(.init(workoutID: UUID(), at: first.at, contentMatches: false, complete: false))
            _ = await coordinator.recover(model: restarted, scheduler: fake, withdraw: false)
            check(restarted.hasInterruptedSchedule && restarted.watchLedger == oldLedger &&
                  CacheStore().pendingPlanReceipts(scope: restarted.feedbackScope).isEmpty,
                  "unknown recovery entries preserve the old ledger and cannot end the journal or enqueue verified receipts")
            fake.listed.removeLast()
            let delayed = fake.listed.removeLast()
            _ = await coordinator.recover(model: restarted, scheduler: fake, withdraw: false)
            let partialPending = CacheStore().pendingPlanReceipts(scope: restarted.feedbackScope)
            check(restarted.hasInterruptedSchedule && restarted.watchLedger?.entries.count == replacement.scheduled - 1 &&
                  Set(partialPending.filter { $0.lifecycleEvent == "replaced" }.compactMap(\.workoutID)) == oldIDs,
                  "partial recovery records the fully removed old entries while retaining an unfinished replacement journal")
            fake.listed.append(delayed)
            _ = await coordinator.recover(model: restarted, scheduler: fake, withdraw: false)
            let pending = CacheStore().pendingPlanReceipts(scope: restarted.feedbackScope)
            let replaced = pending.filter { $0.lifecycleEvent == "replaced" }
            check(!restarted.hasInterruptedSchedule && restarted.watchState == .verifiedCurrent &&
                  restarted.watchLedger?.entries == replacement.confirmedEntries,
                  "exact recovery commits the newly verified ledger and ends the interrupted journal")
            check(Set(replaced.compactMap(\.workoutID)) == oldIDs && replaced.count == oldIDs.count &&
                  pending.filter { $0.lifecycleEvent == "verified" }.count == replacement.scheduled,
                  "recovered replacement atomically queues every old termination event with the new verified receipts")
            check(!replaced.contains { event in replacement.confirmedEntries.contains {
                $0.workoutID.uuidString == event.workoutID
            } }, "repeating partial recovery cannot terminate newly confirmed replacement entries")
            check(replaced.allSatisfy { event in oldLedger.receipts!.contains {
                $0.workoutID == event.workoutID && $0.scheduledAt == event.scheduledAt &&
                    $0.structure == event.structure && $0.prescriptionDigest == event.prescriptionDigest
            } }, "recovered replacement events retain the old actual UUID/time/prescription evidence")
        }

        do {
            CacheStore.resetScheduleSafety()
            let receiptSession = ServerSession()
            let clock = ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")!
            let initial = try PlanTestFixtures.json(PlanTestFixtures.state())
            let updated = try PlanTestFixtures.json(PlanTestFixtures.state(revision: 13, coherence: String(repeating: "c", count: 64)))
            let capabilities = try PlanTestFixtures.json(RaiHandshake(serverId: "server", athleteId: "athlete", datasetEpoch: "epoch",
                syncProtocolVersion: 1, apiVersion: "v1", planSnapshotContractVersion: 1, planReceiptContractVersion: 2))
            StubProtocol.handler = { request in
                if request.url!.path == "/v1/handshake" { return (200, capabilities, 0) }
                if request.url!.path == "/v1/mobile/training-plan-state" { return (200, initial, 0) }
                return (503, "{}", 0)
            }
            let receiptModel = NativeAppModel(session: receiptSession, api: api, now: { clock })
            await receiptModel.bootstrap()
            let fake = FakeWorkoutScheduler()
            let coordinator = PlanWatchSyncCoordinator()
            _ = await coordinator.sync(model: receiptModel, scheduler: fake)
            let oldReceipt = receiptModel.watchLedger!.receipts![0]
            let log = RequestLog()
            StubProtocol.handler = { request in
                log.record(request)
                if request.url!.path == "/v1/mobile/training-plan-state" { return (200, updated, 0) }
                if request.url!.path == "/v1/mobile/workout-plan/synced" {
                    let body = try! JSONSerialization.jsonObject(with: log.lastBody(method: "POST", path: request.url!.path)!) as! [String: Any]
                    let matches = (body["revision"] as! Int) == 13 && body["lifecycleEvent"] as! String == "verified"
                    return (200, "{\"recordedAt\":\"2026-10-09T04:00:00Z\",\"matchesCurrent\":\(matches)}", 0)
                }
                return (503, "{}", 0)
            }
            _ = await coordinator.sync(model: receiptModel, scheduler: fake)
            let currentLedger = receiptModel.watchLedger!
            check(currentLedger.revision == 13 && receiptModel.watchState == .verifiedCurrent &&
                  CacheStore().pendingPlanReceipts(scope: receiptModel.feedbackScope).contains { $0.revision == 12 && $0.lifecycleEvent == "verified" },
                  "historical-retry fixture retains lost old receipts beside a successfully verified replacement")
            let historicalMessage = await receiptModel.retryPlanSyncReceipts()
            check(receiptModel.watchLedger == currentLedger && receiptModel.watchState == .verifiedCurrent &&
                  !historicalMessage.contains("请撤回") && !receiptModel.hasPendingPlanReceipts,
                  "retrying stale historical verification never quarantines or asks to withdraw the current ledger")
            StubProtocol.handler = { request in
                if request.url!.path == "/v1/mobile/workout-plan/synced" {
                    return (409, "{\"code\":\"plan_receipt_scope_mismatch\",\"message\":\"old receipt identity\"}", 0)
                }
                return (503, "{}", 0)
            }
            _ = await receiptModel.recordPlanSyncReceipts([oldReceipt])
            check(receiptModel.watchLedger == currentLedger && receiptModel.watchState == .verifiedCurrent,
                  "historical scope-mismatch receipts cannot mark unrelated current entries for withdrawal")
            StubProtocol.handler = { _ in (200, "{\"recordedAt\":\"2026-10-09T04:00:00Z\",\"matchesCurrent\":false}", 0) }
            var differentTime = currentLedger.receipts![0]
            differentTime.scheduledAt = ISO8601DateFormatter().string(from: currentLedger.entries[0].scheduledAt.addingTimeInterval(3600))
            differentTime.idempotencyKey = UUID().uuidString
            _ = await receiptModel.recordPlanSyncReceipts([differentTime])
            check(receiptModel.watchLedger == currentLedger && receiptModel.watchState == .verifiedCurrent,
                  "same UUID at a different instant cannot invalidate the current system entry")
            var actualCurrent = currentLedger.receipts![0]
            actualCurrent.workoutID = actualCurrent.workoutID!.lowercased()
            let precise = ISO8601DateFormatter(); precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            actualCurrent.scheduledAt = precise.string(from: currentLedger.entries[0].scheduledAt)
            _ = await receiptModel.recordPlanSyncReceipts([actualCurrent])
            check(receiptModel.watchLedger?.requiresWithdrawal == true && receiptModel.watchState == .stale,
                  "stale evidence for the actual current UUID/instant still requires withdrawal across equivalent timestamp encodings")
        }

        // Legacy missing revision is separately tested; it never enables execution.
        do {
            let legacy = NativeAppModel(session: ServerSession(), api: api, now: { modelNow })
            let plan12 = try PlanTestFixtures.json(PlanTestFixtures.plan(revision: 12, dates: ["2026-09-16"]))
            StubProtocol.handler = { request in
                if request.url!.path.hasSuffix("/goals") { return (200, goalsJSON, 0) }
                if request.url!.path.hasSuffix("/today") { return (200, todayJSON.replacingOccurrences(of: "\"planRevision\":12,", with: ""), 0) }
                if request.url!.path.hasSuffix("/workout-plan") { return (200, plan12, 0) }
                return (503, "{}", 0)
            }
            let coherent = await legacy.refreshPlanState()
            check(!coherent && !legacy.canConfirmToday && legacy.planPresentation.today == nil, "legacy today missing revision decodes but cannot be current execution")
            check(legacy.planPresentation.availability == .unavailable, "unavailable today is not mislabeled as a known revision mismatch")
        }

        do {
            let unknownState = NativeAppModel(session: ServerSession(), api: api, now: { ISO8601DateFormatter().date(from: "2026-09-16T00:00:00Z")! })
            let unknownGoals = coachGoals(2).replacingOccurrences(of: "\"status\":\"active\"", with: "\"status\":\"future-status\"")
            let plan2 = try PlanTestFixtures.json(PlanTestFixtures.plan(revision: 2, dates: ["2026-09-16"]))
            StubProtocol.handler = { request in
                if request.url!.path.hasSuffix("/goals") { return (200, unknownGoals, 0) }
                if request.url!.path.hasSuffix("/today") { return (200, todayJSON.replacingOccurrences(of: "\"planRevision\":12", with: "\"planRevision\":2"), 0) }
                if request.url!.path.hasSuffix("/workout-plan") { return (200, plan2, 0) }
                return (503, "{}", 0)
            }
            let usable = await unknownState.refreshPlanState()
            check(!usable && unknownState.planPresentation.coachPlan == nil && unknownState.currentWorkoutPlan == nil,
                  "unknown coach state is not interpreted as active execution")
            check(!unknownState.canConfirmToday && unknownState.planPresentation.today == nil,
                  "unknown coach state cannot confirm or display a current training recommendation")
        }

        do {
            CacheStore.resetScheduleSafety()
            let data = try Data(contentsOf: URL(fileURLWithPath: "apps/ios/tests/fixtures/coach-loop-v1.json"))
            let loop = try JSONDecoder().decode(CoachLoopResponse.self, from: data)
            let json = String(decoding: data, as: UTF8.self)
            let session = ServerSession()
            let handshake = RaiHandshake(serverId: loop.scope.serverId, athleteId: loop.scope.athleteId,
                datasetEpoch: loop.scope.datasetEpoch, syncProtocolVersion: 1, apiVersion: "v1",
                planSnapshotContractVersion: 1, planPublicationContractVersion: 1, planReceiptContractVersion: 2, coachLoopContractVersion: 1)
            CacheStore.saveHandshake(handshake, baseURL: session.serverURL!)
            let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [StubProtocol.self]
            let model = NativeAppModel(session: session, api: RaiAPIClient(session: URLSession(configuration: configuration)),
                now: { ISO8601DateFormatter().date(from: "2026-10-08T04:00:00Z")! })
            let wireRequests = RequestLog()
            StubProtocol.handler = { request in
                precondition(request.url!.path == "/v1/mobile/coach-loop/synced")
                wireRequests.record(request)
                let object = try! JSONSerialization.jsonObject(with: wireRequests.lastBody(method: "POST", path: request.url!.path)!) as! [String: Any]
                let context = object["coachLoop"] as! [String: Any]
                let structure = object["structure"] as! [String: Any]
                let block = (structure["blocks"] as! [[String: Any]])[0]
                let work = (block["steps"] as! [[String: Any]])[0]
                precondition(context["decisionRef"] is NSNull && structure["warmup"] is NSNull &&
                    structure["cooldown"] is NSNull && work["alert"] is NSNull, "regular/cold-start wire must preserve canonical unknowns")
                return (200, "{\"recordedAt\":\"2026-10-08T04:00:00Z\",\"matchesCurrent\":false}", 0)
            }
            let wireAPI = RaiAPIClient(session: URLSession(configuration: configuration))
            let noTargets = MobileSessionStructure(warmup: nil, blocks: [.init(iterations: 1, steps: [
                .init(purpose: "work", goal: .time(seconds: 1800), alert: nil)])], cooldown: nil)
            let wireReceipt = PlanSyncReceipt(localDate: loop.today.day.localDate, kind: "easy", revision: loop.revision,
                structure: noTargets, coachLoop: .init(contractVersion: 1, policyHash: loop.policyHash, decisionRef: nil))
            _ = try await wireAPI.recordPlanSync(wireReceipt, baseURL: session.serverURL!, token: "")
            check(wireRequests.count(method: "POST", path: "/v1/mobile/coach-loop/synced") == 1,
                "regular and cold-start receipts preserve explicit null authority/targets without a legacy downgrade")
            var receiptCount = 0
            let loopRequests = RequestLog()
            StubProtocol.handler = { request in
                if request.url!.path == "/v1/mobile/coach-loop" { return (200, json, 0) }
                precondition(request.url!.path == "/v1/mobile/coach-loop/synced", "native must never use legacy receipt endpoint")
                loopRequests.record(request)
                let object = try! JSONSerialization.jsonObject(with: loopRequests.lastBody(method: "POST", path: "/v1/mobile/coach-loop/synced")!) as! [String: Any]
                let context = object["coachLoop"] as! [String: Any]
                precondition(context["decisionRef"] as? String == loop.today.decisionRef &&
                    object["coherenceToken"] as? String == loop.executionToken, "authorization and effective facts identity must survive export")
                receiptCount += 1
                return (200, "{\"recordedAt\":\"2026-10-08T04:00:00Z\",\"matchesCurrent\":true}", 0)
            }
            let loaded = await model.refreshPlanState()
            check(loaded, "native model selects new contract before old aggregates")
            check(model.today == nil && model.currentWorkoutPlan?.windowDays == 1 && model.coachLoop?.settings?.mode == "daily_adaptive",
                "native screens share one new-contract today authority without fabricated programme")
            let scheduler = FakeWorkoutScheduler()
            _ = await PlanWatchSyncCoordinator.shared.sync(model: model, scheduler: scheduler)
            check(receiptCount == 1 && model.watchLedger?.entries.count == 1,
                "AC0-12 device fake proves exact today-only scheduling and explicit new receipt route")
            check(model.watchLedger?.receipts?.first?.coachLoop == loop.receiptContext,
                "new receipt authorization survives durable ledger and withdrawal")
            let conversion = await model.changeCoachLoop(action: "enable", preferences: loop.settings!.preferences,
                acceptedPolicyHash: loop.policyHash)
            check(!conversion && model.runCoachError?.contains("旧系统排期") == true,
                "local uncoordinated schedule blocks conversion even before the server can see a receipt")
            let lease = model.beginPlanSync()!
            let snapshot = model.planSyncSnapshot(lease)!
            let journal = PlanScheduleJournal(storage: CacheStore(), snapshot: snapshot, previousEntries: [])
            check(journal.operation.coachLoop == loop.receiptContext, "interrupted scheduling journal persists new authority for recovery")
            model.endPlanSync(lease)
            var sends = 0
            StubProtocol.handler = { request in
                precondition(request.url!.path == "/v1/mobile/coach-loop")
                if request.httpMethod == "GET" { return (200, json, 0) }
                sends += 1
                return (503, "{}", 0)
            }
            let published = await model.changeCoachLoop(action: "refresh")
            check(!published, "unknown-result coach publication is not reported as saved")
            check(model.hasPendingPlanPublication && model.currentWorkoutPlan == nil && sends == 1,
                "lost reply durably retains original new-contract operation and invalidates execution")
            let republished = await model.changeCoachLoop(action: "refresh")
            check(!republished && sends == 1,
                "pending new-contract operation prevents issuing a second UUID")
        }

        // 2026-10-18（审查 P1-1）：v2 回执的显式 null 线格式适用于**所有** v2 回执，
        // 不只是教练闭环。服务端现会规范化后接受两种形状，但客户端仍应发送规范 wire
        // （显式 null）：否则旧服务端的规范化校验会把普通手动计划回执 422 终局拒绝，
        // 也会让同一处方在两端得到不同身份。
        do {
            let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [StubProtocol.self]
            let wireAPI = RaiAPIClient(session: URLSession(configuration: configuration))
            let session = ServerSession()
            let noOptionalTargets = MobileSessionStructure(warmup: nil, blocks: [.init(iterations: 2, steps: [
                .init(purpose: "work", goal: .time(seconds: 600), alert: nil)])], cooldown: nil)
            let v2Log = RequestLog()
            StubProtocol.handler = { request in
                v2Log.record(request)
                return (200, "{\"recordedAt\":\"2026-10-18T00:00:00Z\",\"matchesCurrent\":true}", 0)
            }
            let v2Receipt = PlanSyncReceipt(localDate: "2026-10-18", kind: "easy", revision: 12,
                structure: noOptionalTargets, workoutID: UUID().uuidString,
                scheduledAt: "2026-10-18T00:30:00Z", idempotencyKey: UUID().uuidString,
                contractVersion: 2,
                scope: .init(serverId: "server", athleteId: "athlete", datasetEpoch: "epoch"),
                operationId: UUID().uuidString, coherenceToken: String(repeating: "a", count: 64),
                verifiedAt: "2026-10-18T00:00:00Z", timezone: "Asia/Shanghai",
                prescriptionDigest: String(repeating: "b", count: 64), lifecycleEvent: "verified")
            _ = try await wireAPI.recordPlanSync(v2Receipt, baseURL: session.serverURL!, token: "")
            check(v2Log.count(method: "POST", path: "/v1/mobile/workout-plan/synced") == 1 &&
                  v2Log.count(method: "POST", path: "/v1/mobile/coach-loop/synced") == 0,
                "non-coach v2 receipt stays on the manual-plan receipt route")
            let v2Body = try JSONSerialization.jsonObject(
                with: v2Log.lastBody(method: "POST", path: "/v1/mobile/workout-plan/synced")!) as! [String: Any]
            let v2Structure = v2Body["structure"] as! [String: Any]
            let v2Work = ((v2Structure["blocks"] as! [[String: Any]])[0]["steps"] as! [[String: Any]])[0]
            check(v2Structure["warmup"] is NSNull && v2Structure["cooldown"] is NSNull && v2Work["alert"] is NSNull,
                "non-coach v2 receipt writes explicit null warmup/cooldown/alert for the canonical digest")
            check(v2Body["contractVersion"] as? Int == 2 && v2Body["scope"] as? [String: Any] != nil &&
                  v2Body["operationId"] as? String == v2Receipt.operationId &&
                  v2Body["coherenceToken"] as? String == v2Receipt.coherenceToken &&
                  v2Body["verifiedAt"] as? String == v2Receipt.verifiedAt &&
                  v2Body["timezone"] as? String == "Asia/Shanghai" &&
                  v2Body["prescriptionDigest"] as? String == v2Receipt.prescriptionDigest &&
                  v2Body["lifecycleEvent"] as? String == "verified",
                "non-coach v2 receipt keeps every required verification field on the wire")
            let legacyLog = RequestLog()
            StubProtocol.handler = { request in
                legacyLog.record(request)
                return (200, "{\"recordedAt\":\"2026-10-18T00:00:00Z\"}", 0)
            }
            let legacyReceipt = PlanSyncReceipt(localDate: "2026-10-18", kind: "easy", revision: 12,
                structure: noOptionalTargets)
            _ = try await wireAPI.recordPlanSync(legacyReceipt, baseURL: session.serverURL!, token: "")
            check(legacyLog.count(method: "POST", path: "/v1/mobile/workout-plan/synced") == 1,
                "legacy receipt still uses the manual-plan receipt route")
            let legacyBody = try JSONSerialization.jsonObject(
                with: legacyLog.lastBody(method: "POST", path: "/v1/mobile/workout-plan/synced")!) as! [String: Any]
            let legacyStructure = legacyBody["structure"] as! [String: Any]
            let legacyWork = ((legacyStructure["blocks"] as! [[String: Any]])[0]["steps"] as! [[String: Any]])[0]
            check(!legacyStructure.keys.contains("warmup") && !legacyStructure.keys.contains("cooldown") &&
                  legacyWork["alert"] == nil && legacyBody["contractVersion"] == nil,
                "legacy receipt keeps synthesized Codable key omission instead of inventing explicit nulls")
        }
        do {
            // 2026-10-18（审查 P2-9）：coachLoop=1 且无 planSnapshotContractVersion 的
            // 错峰能力组合。所有"完整计划读取"必须走新教练合同，不得回落到旧 run-coach。
            CacheStore.resetScheduleSafety()
            let mixedSession = ServerSession()
            let mixedLoopData = try Data(contentsOf: URL(fileURLWithPath: "apps/ios/tests/fixtures/coach-loop-v1.json"))
            let mixedLoop = try JSONDecoder().decode(CoachLoopResponse.self, from: mixedLoopData)
            let mixedLoopJSON = String(decoding: mixedLoopData, as: UTF8.self)
            let mixedHandshake = RaiHandshake(serverId: mixedLoop.scope.serverId, athleteId: mixedLoop.scope.athleteId,
                datasetEpoch: mixedLoop.scope.datasetEpoch, syncProtocolVersion: 1, apiVersion: "v1",
                planPublicationContractVersion: 1, planReceiptContractVersion: 2, coachLoopContractVersion: 1)
            CacheStore.saveHandshake(mixedHandshake, baseURL: mixedSession.serverURL!)
            let mixedLog = RequestLog()
            let mixedModel = NativeAppModel(session: mixedSession, api: api,
                now: { ISO8601DateFormatter().date(from: "2026-10-08T04:00:00Z")! })
            StubProtocol.handler = { request in
                mixedLog.record(request)
                if request.url!.path == "/v1/mobile/coach-loop" { return (200, mixedLoopJSON, 0) }
                return (503, "{}", 0)
            }
            let mixedRefreshed = await mixedModel.refreshRunCoach()
            check(mixedRefreshed && mixedModel.isCoachLoopManaged && mixedModel.coachLoop != nil,
                  "mixed capability (coachLoop without snapshot) refreshes through the coach-loop contract")
            check(mixedLog.count(method: "GET", path: "/v1/mobile/run-coach") == 0 &&
                  mixedLog.count(method: "GET", path: "/v1/mobile/goals") == 0,
                  "mixed capability never falls back to the legacy run-coach/goals reads")
            let staleLegacyCoach = try JSONDecoder().decode(MobileRunCoachResponse.self, from: Data(runCoachJSON.utf8))
            mixedModel.trainingPlanStore.acceptCoach(staleLegacyCoach)
            check(mixedModel.runCoach == nil && mixedModel.coachLoop != nil,
                  "a legacy coach response cannot overwrite an active coach-loop state")
        }

        do {
            // 2026-10-18（审查 P2-8）：安全校验失败的面板分类与文案。
            let validationSession = ServerSession()
            let validationClock = ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")!
            let validationCapabilities = try PlanTestFixtures.json(RaiHandshake(
                serverId: "server", athleteId: "athlete", datasetEpoch: "epoch",
                syncProtocolVersion: 1, apiVersion: "v1",
                planSnapshotContractVersion: 1, planReceiptContractVersion: 2))
            var unsafeObject = try JSONSerialization.jsonObject(
                with: Data(try PlanTestFixtures.json(PlanTestFixtures.state()).utf8)) as! [String: Any]
            var unsafePlan = unsafeObject["workoutPlan"] as! [String: Any]
            var unsafeDays = unsafePlan["days"] as! [[String: Any]]
            unsafeDays[1] = unsafeDays[0]
            unsafePlan["days"] = unsafeDays
            unsafeObject["workoutPlan"] = unsafePlan
            let unsafeJSON = String(decoding: try JSONSerialization.data(withJSONObject: unsafeObject), as: UTF8.self)
            let emptyStatisticsJSON = """
            {"generatedAt":"2026-10-09T00:00:00Z","timezone":"Asia/Shanghai","months":[],
             "totals":{"distanceKm":0,"durationSeconds":0,"workoutCount":0,
              "averagePaceSecondsPerKm":null,"distanceChangeFraction":null},"heartRateZones":[]}
            """
            let emptyTrendsJSON = """
            {"generatedAt":"2026-10-09T00:00:00Z","timezone":"Asia/Shanghai","weeks":[],
             "records":{"fastest5k":null,"fastest10k":null,"longestDistance":null,"biggestMonth":null},
             "insights":[],"ability":[],"currentAbility":[],"decayPoints":0}
            """
            StubProtocol.handler = { request in
                switch request.url!.path {
                case "/v1/handshake": return (200, validationCapabilities, 0)
                case "/v1/mobile/training-plan-state": return (200, unsafeJSON, 0)
                case "/v1/mobile/statistics": return (200, emptyStatisticsJSON, 0)
                case "/v1/mobile/trends": return (200, emptyTrendsJSON, 0)
                case "/v1/workouts": return (200, "{\"items\":[],\"total\":0,\"limit\":30,\"offset\":0}", 0)
                default: return (503, "{}", 0)
                }
            }
            let validationModel = NativeAppModel(session: validationSession, api: api, now: { validationClock })
            await validationModel.bootstrap()
            check(validationModel.trainingPlanStore.issue?.code == .snapshotValidationFailed,
                  "an unsafe aggregate snapshot is classified as snapshot validation failure")
            check(validationModel.errorMessage?.contains("未通过安全校验") == true &&
                  validationModel.errorMessage?.contains("升级") != true,
                  "validation panel copy explains the rejected snapshot and never suggests upgrading the client")
            check(!validationModel.isOffline,
                  "a reachable server returning an untrusted snapshot is not reported as offline")
        }
        do {
            // 2026-10-18（审查 P2-6 收尾）：`Retry-After` 解析规则。
            check(RaiRetryAfter.seconds(from: "1") == 1, "Retry-After accepts integer seconds")
            check(RaiRetryAfter.seconds(from: " 2 ") == 2, "Retry-After tolerates surrounding whitespace")
            check(RaiRetryAfter.seconds(from: "0") == 0, "Retry-After accepts zero seconds")
            check(RaiRetryAfter.seconds(from: "-3") == 0, "negative Retry-After is clamped to zero, never negative")
            // 2026-10-18（深度审查 P3-28）：**展示**不再夹取 0..5，**调度**才夹取。
            // 旧实现让 429 文案把"服务端建议 9 秒"说成"建议 5 秒"—— 改写服务端的建议而
            // 用户不可知。两条口径必须分开断言，否则改回去也不会有判据响。
            check(RaiRetryAfter.seconds(from: "9") == 9,
                  "the DISPLAY value keeps the server's suggestion (9 stays 9, not clamped to 5)")
            check(RaiRetryAfter.schedulingSeconds(from: "9") == 5,
                  "the SCHEDULING value is clamped to five seconds (a foreground retry must not stall)")
            check(RaiRetryAfter.seconds(from: "600") == 600
                    && RaiRetryAfter.seconds(from: "100000") == RaiRetryAfter.displayMaximum,
                  "the display value only caps absurd waits (600 s ceiling), never rewrites plausible ones")
            check(RaiRetryAfter.schedulingSeconds(from: "1") == 1
                    && RaiRetryAfter.schedulingSeconds(from: "-3") == 0
                    && RaiRetryAfter.schedulingSeconds(from: "abc") == nil,
                  "the scheduling value keeps the same parse rules and the 0...5 clamp")
            check(RaiRetryAfter.seconds(from: "1.5") == nil, "fractional Retry-After is ignored (integers only)")
            check(RaiRetryAfter.seconds(from: "Wed, 21 Oct 2015 07:28:00 GMT") == nil,
                  "HTTP-date Retry-After is ignored instead of being misread as seconds")
            check(RaiRetryAfter.seconds(from: "abc") == nil && RaiRetryAfter.seconds(from: nil) == nil,
                  "invalid or missing Retry-After is ignored")

            // 503 + Retry-After -> retryableServer（带提示）；其余 503 仍是 server。
            let retryAfterBase = URL(string: "https://retry-after.invalid")!
            func planReadError(headers: [String: String]?) async -> RaiAPIClientError? {
                StubProtocol.extraHeaders = headers
                StubProtocol.handler = { _ in
                    (503, "{\"code\":\"plan_snapshot_changed\",\"message\":\"快照变化，请重读\"}", 0)
                }
                defer { StubProtocol.extraHeaders = nil }
                do {
                    _ = try await api.trainingPlanState(baseURL: retryAfterBase, token: "")
                    return nil
                } catch let error as RaiAPIClientError {
                    return error
                } catch {
                    return nil
                }
            }
            let hinted = await planReadError(headers: ["Retry-After": "1"])
            if case let .retryableServer(code, message, status, hint)? = hinted {
                check(code == "plan_snapshot_changed" && status == 503 && hint == 1,
                      "503 with Retry-After: 1 becomes a retryable server error carrying the hint")
                check(message.contains("快照变化"), "retryable server error keeps the server message")
                check(hinted?.serverCode == "plan_snapshot_changed" && hinted?.httpStatus == 503,
                      "retryable server error exposes code/status for classification")
                if let hinted {
                    let issue = PlanReadIssue.network(hinted)
                    check(issue.code == .serverUnavailable && issue.retryable,
                          "a retryable 503 is classified as retryable server-unavailable, not contract mismatch")
                    check(hinted.errorDescription == message, "retryable server error has a localized message")
                }
                // PR-01：旧面 410 是终局升级状态，不是"服务端暂时不可用"。
                let retiredRead = PlanReadIssue.network(
                    RaiAPIClientError.server(code: "legacy_surface_retired", message: "该旧接口已退役", status: 410))
                check(retiredRead.code == .contractMismatch && !retiredRead.retryable,
                      "a retired 410 read is an upgrade state and is never auto-retried")
            } else {
                check(false, "503 with Retry-After: 1 must throw retryableServer")
            }
            if case .server(_, _, 503)? = await planReadError(headers: nil) {
                check(true, "503 without Retry-After keeps the non-retryable server error")
            } else {
                check(false, "503 without Retry-After must stay .server")
            }
            if case .server(_, _, 503)? = await planReadError(headers: ["Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT"]) {
                check(true, "503 with an HTTP-date Retry-After stays .server")
            } else {
                check(false, "HTTP-date Retry-After must be ignored")
            }
            if case let .retryableServer(_, _, _, hint)? = await planReadError(headers: ["Retry-After": "0"]) {
                check(hint == 0, "Retry-After: 0 is preserved as an immediate-retry hint")
            } else {
                check(false, "Retry-After: 0 must still be a retryable hint")
            }
            if case let .retryableServer(_, _, _, hint)? = await planReadError(headers: ["Retry-After": "9"]) {
                check(hint == 5, "Retry-After: 9 is clamped to five seconds")
            } else {
                check(false, "Retry-After: 9 must be a retryable hint")
            }
            // 429 仍走旧路径（文案携带建议），不被升级成可重试 case（重试属于调用方语义）。
            StubProtocol.extraHeaders = ["Retry-After": "5"]
            StubProtocol.handler = { _ in (429, "{\"code\":\"rate_limited\",\"message\":\"容量已满\"}", 0) }
            do {
                _ = try await api.today(baseURL: retryAfterBase, token: "")
                check(false, "429 must throw")
            } catch let error as RaiAPIClientError {
                if case let .server(code, message, status) = error {
                    check(code == "rate_limited" && status == 429 && message.contains("建议 5 秒"),
                          "429 keeps the legacy server error plus its retry hint")
                } else {
                    check(false, "429 must remain .server, not retryableServer")
                }
            } catch {
                check(false, "429 must throw RaiAPIClientError")
            }
            // P3-28 的端到端形态：服务端说 9 秒 ⇒ 文案照说 9 秒（不再被改写为 5 秒）。
            StubProtocol.extraHeaders = ["Retry-After": "9"]
            do {
                _ = try await api.today(baseURL: retryAfterBase, token: "")
                check(false, "429 must throw")
            } catch let error as RaiAPIClientError {
                if case let .server(_, message, _) = error {
                    check(message.contains("建议 9 秒") && !message.contains("建议 5 秒"),
                          "a 429 with Retry-After: 9 quotes the server's nine seconds verbatim (P3-28)")
                } else {
                    check(false, "429 must remain .server")
                }
            } catch {
                check(false, "429 must throw RaiAPIClientError")
            }
            StubProtocol.extraHeaders = nil
        }
        // ---------------------------------------------------------------------------
        // 2026-10-18（同步诊断 P0-3 / P0-6）：打开会话的 freshness 与**自动重取**。
        //
        // 这条链此前完全没有执行者：`dataUpdatedGeneration` 只接 `refreshAll()`，而
        // `refreshAll` 不碰 `selectedWorkout`/`selectedSeries` —— 详情只在 `.task` / 下拉刷新
        // 时读。服务端证据里那句"列表 12:29:42Z 已变，App 直到 12:31:55Z 才第一次读新详情"
        // 就是它。判据：代次变化且存在打开会话 ⇒ 真的发出一次 detail+series+freshness 读。
        // ---------------------------------------------------------------------------
        let refreshNow = ISO8601DateFormatter().date(from: "2026-10-18T13:00:00Z")!
        func refreshDetail(_ id: String, endedAt: String, publishStatus: String?) -> String {
            let publish = publishStatus.map { ",\"analysisPublishStatus\":\"\($0)\"" } ?? ""
            return """
            {"workout":{"id":"\(id)","startedAt":"2026-10-18T11:46:38Z","endedAt":"\(endedAt)","durationSeconds":2528,"elapsedSeconds":2528,"sourceCategory":"apple_health","sessionType":"easy","stimulusType":"easy","eligibilityStatus":"eligible","missingReasons":[],"qualityScore":1,"hasRoute":false,"modelVersion":"test","updatedTrueAbility":false,"heartRateSampleCount":0,"routePointCount":0,"sourceConfidence":1,"effectiveWeights":{},"confidenceFactors":{},"explanationCodes":[]\(publish)},"dimensions":{},"route":[]}
            """
        }
        func refreshSeries(_ id: String) -> String {
            let metrics = ["heartRate", "speed", "power", "cadence", "elevation",
                           "strideLength", "verticalOscillation", "groundContactTime"]
                .map { "\"\($0)\":{\"unit\":\"x\",\"totalSamples\":0,\"points\":[]}" }
                .joined(separator: ",")
            return """
            {"trainingSessionId":"\(id)","startedAt":"2026-10-18T11:46:38Z","endedAt":"2026-10-18T12:28:46Z","sourceCategory":"apple_health","splits":[],"series":{\(metrics)}}
            """
        }
        func refreshFreshness(_ id: String, completeness: String, analysis: String) -> String {
            return """
            {"workoutId":"\(id)","facts":{"committedAt":"2026-10-18T12:29:38Z","lastBatchAt":"2026-10-18T12:31:43Z","batches":6},"analysis":{"status":"\(analysis)","jobId":"job","publishedAt":null},"series":[{"metric":"heartRate","samples":505,"state":"present"},{"metric":"speed","samples":0,"state":"not_seen_yet"}],"completeness":"\(completeness)"}
            """
        }
        let refreshSession = ServerSession()
        refreshSession.serverURL = URL(string: "https://workout-refresh.invalid")
        let refreshModel = NativeAppModel(session: refreshSession, api: api, now: { refreshNow })
        let refreshLog = RequestLog()
        let detailPath = "/v1/workouts/run-1"
        let seriesPath = "/v1/workouts/run-1/series"
        let freshnessPath = "/v1/workouts/run-1/freshness"
        StubProtocol.handler = { request in
            refreshLog.record(request)
            switch request.url!.path {
            case freshnessPath:
                return (200, refreshFreshness("run-1", completeness: "partial", analysis: "published"), 0)
            case seriesPath:
                return (200, refreshSeries("run-1"), 0)
            default:
                return (200, refreshDetail("run-1", endedAt: "2026-10-18T12:28:46Z", publishStatus: nil), 0)
            }
        }
        await refreshModel.loadWorkout(id: "run-1")
        check(refreshModel.selectedFreshness?.completeness == "partial",
              "opening a workout must fetch detail, series and freshness")
        check(refreshLog.count(method: "GET", path: detailPath) == 1
              && refreshLog.count(method: "GET", path: seriesPath) == 1
              && refreshLog.count(method: "GET", path: freshnessPath) == 1,
              "detail, series and freshness are fetched together")
        // 后台（不在前台）不重取：后台窗口里的 UI 级读会跨过后台到期点被系统挂起。
        let backgroundReload = await refreshModel.reloadOpenWorkoutIfStale(isForeground: false, coalescing: 0)
        check(backgroundReload == false, "a background activation must not start a UI-level read")
        check(refreshLog.count(method: "GET", path: detailPath) == 1,
              "a background reload must not touch the network")
        // 代次变化且存在打开会话 ⇒ 重取（这是 P0-6 的核心判据）。
        let generationReload = await refreshModel.reloadOpenWorkoutIfStale(isForeground: true, coalescing: 0)
        check(generationReload, "a stale open workout must be refetched after a sync generation")
        check(refreshLog.count(method: "GET", path: detailPath) == 2
              && refreshLog.count(method: "GET", path: seriesPath) == 2
              && refreshLog.count(method: "GET", path: freshnessPath) == 2,
              "the refetch refreshes detail, series and freshness together")
        // 350 ms 合并窗口：同一波里的第二次调用复用第一次的重取，不把 burst 变成 N 倍读。
        let burstFirst = Task { await refreshModel.reloadOpenWorkoutIfStale(isForeground: true, coalescing: 0.05) }
        try await Task.sleep(for: .milliseconds(5))
        let burstSecond = Task { await refreshModel.reloadOpenWorkoutIfStale(isForeground: true, coalescing: 0.05) }
        let firstReloaded = await burstFirst.value
        let secondReloaded = await burstSecond.value
        check(firstReloaded && secondReloaded, "both callers of a burst share one refetch")
        check(refreshLog.count(method: "GET", path: detailPath) == 3,
              "the coalescing window merges a burst into a single refetch")
        // 老服务端（freshness 404）：详情照常可用，只是没有补齐状态 —— 绝不把整页报成失败。
        let legacySession = ServerSession()
        legacySession.serverURL = URL(string: "https://workout-legacy.invalid")
        let legacyModel = NativeAppModel(session: legacySession, api: api, now: { refreshNow })
        StubProtocol.handler = { request in
            if request.url!.path.hasSuffix("/freshness") { return (404, "{\"message\":\"未找到\"}", 0) }
            if request.url!.path.hasSuffix("/series") { return (200, refreshSeries("run-1"), 0) }
            return (200, refreshDetail("run-1", endedAt: "2026-10-18T12:28:46Z", publishStatus: nil), 0)
        }
        await legacyModel.loadWorkout(id: "run-1")
        check(legacyModel.selectedWorkout?.workout.id == "run-1" && legacyModel.selectedFreshness == nil,
              "a server without the freshness endpoint must not break the detail page")
        // 已完整、已发布、且结束很久的训练：代次变化不再重取（否则每批都白读三条接口）。
        StubProtocol.handler = { request in
            refreshLog.record(request)
            switch request.url!.path {
            case freshnessPath:
                return (200, refreshFreshness("run-1", completeness: "complete", analysis: "published"), 0)
            case seriesPath:
                return (200, refreshSeries("run-1"), 0)
            default:
                return (200, refreshDetail("run-1", endedAt: "2026-10-14T12:00:00Z", publishStatus: "published"), 0)
            }
        }
        await refreshModel.loadWorkout(id: "run-1")
        let beforeSettled = refreshLog.count(method: "GET", path: detailPath)
        let settledReload = await refreshModel.reloadOpenWorkoutIfStale(isForeground: true, coalescing: 0)
        check(settledReload == false, "a complete, published, old workout must not be refetched")
        check(refreshLog.count(method: "GET", path: detailPath) == beforeSettled,
              "a settled workout must not cost a network read per sync generation")

        print("All model regression checks passed.")
    }
}
