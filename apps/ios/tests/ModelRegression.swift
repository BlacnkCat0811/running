import Foundation

@MainActor final class ServerSession {
    var serverURL: URL? = URL(string: "https://\(UUID().uuidString).invalid")
    var apiToken = ""
    var isReachable = false
    var lastError: String?
    func probe() async {}
}
struct CachedValue<Value> { let value: Value; let cachedAt: Date }
@MainActor final class CacheStore {
    private var entries: [String: Data] = [:]
    static func urlScope(baseURL: URL) -> String { baseURL.absoluteString }
    static func scope(baseURL: URL, handshake: RaiHandshake?) -> String {
        baseURL.absoluteString + (handshake?.datasetEpoch ?? "")
    }
    func read<V: Codable>(_ type: V.Type, scope: String, key: String) -> CachedValue<V>? {
        guard let data = entries[scope + key], let value = try? JSONDecoder().decode(type, from: data) else { return nil }
        return CachedValue(value: value, cachedAt: Date())
    }
    func write<V: Codable>(_ value: V, scope: String, key: String) -> Date {
        entries[scope + key] = try? JSONEncoder().encode(value)
        return Date()
    }
    func clear(scope: String) { entries = entries.filter { !$0.key.hasPrefix(scope) } }
}

final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (URLRequest) -> (Int, String, Double) = { _ in (503, "{}", 0) }
    private let lock = NSLock()
    private var stopped = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, body, delay) = Self.handler(request)
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [self] in
            lock.lock(); defer { lock.unlock() }
            guard !stopped else { return }
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() { lock.lock(); stopped = true; lock.unlock() }
}

@main struct ModelRegression {
    @MainActor static func main() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        let api = RaiAPIClient(session: URLSession(configuration: config))
        let session = ServerSession()
        let model = NativeAppModel(session: session, api: api)
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            print("PASS: \(name)")
        }
        for (state, expected) in [("recovered", "恢复良好"), ("reduced", "恢复不足"), ("depleted", "需要休息"), ("unknown", "基线不足")] {
            let json = "{\"state\":\"\(state)\",\"lastNightSleepMinutes\":420,\"note\":\"test\"}"
            let recovery = try JSONDecoder().decode(MobileRecoveryBreakdown.self, from: Data(json.utf8))
            check(recovery.stateLabel == expected, "recovery state \(state) is not pending")
        }
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
        let old = Task { await model.refreshWorkouts() }
        try await Task.sleep(for: .milliseconds(30))
        model.workoutSessionType = "tempo"
        await model.refreshWorkouts()
        _ = await old.value
        check(model.workouts.first?.id == "new", "late filter response cannot replace current list")
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
         "audit":{"generatedBy":"llm","model":"deepseek:deepseek-chat","promptVersion":"weekly-plan-v1","generatedAt":"2026-09-11T00:30:00.000Z"},
         "days":[{"localDate":"2026-09-11","kind":"easy","distanceKm":8,"structure":null,"reason":"轻松"}],"warnings":[]}
        """
        session.serverURL = URL(string: "https://rai-plan.test")
        model.serverConfigurationChanged()
        StubProtocol.handler = { request in
            let path = request.url!.path
            if path.hasSuffix("/workout-plan/generate") { return (200, generationJSON, 0) }
            if path.hasSuffix("/workout-plan") { return (200, planJSON, 0) }
            return (503, "{}", 0)
        }
        let planFetched = await model.refreshWorkoutPlan()
        check(planFetched && model.workoutPlan?.days.count == 2, "the executable week is fetched and stored")
        check(model.workoutPlan?.days.first?.structure?.blocks.first?.iterations == 6, "the session structure survives the round trip")
        check(model.workoutPlan?.days.first?.executable == true, "an executable day is marked as such")
        check(model.workoutPlan?.planRevision == 7, "the plan revision is carried for conflict messages")

        let generated = await model.regenerateWeeklyPlan()
        check(generated, "a plan generation reports success")
        check(model.planMessage?.contains("大模型生成") == true, "a model-generated plan says so")
        check(model.planMessage?.contains("deepseek:deepseek-chat") == true, "the generating model is named")

        StubProtocol.handler = { _ in
            (409, "{\"code\":\"mobile_goals_revision_conflict\",\"message\":\"训练目标已在其他页面更新\"}", 0)
        }
        let conflicted = await model.regenerateWeeklyPlan()
        check(!conflicted, "a revision conflict is reported as a failure")
        check(model.planMessage == "训练目标已在别处更新，请重新生成本周课表。", "a revision conflict tells the user to regenerate")

        let fallbackJSON = """
        {"generatedAt":"2026-09-11T00:30:00.000Z","revision":9,
         "audit":{"generatedBy":"heuristic","model":null,"promptVersion":null,"generatedAt":"2026-09-11T00:30:00.000Z"},
         "days":[{"localDate":"2026-09-11","kind":"easy","distanceKm":8,"structure":null,"reason":null}],
         "warnings":["未配置 RAI_LLM_API_KEY，已回退到启发式课表"]}
        """
        if let fallback = try? JSONDecoder().decode(MobileWeeklyPlanGenerationResponse.self, from: Data(fallbackJSON.utf8)) {
            let summary = NativeAppModel.generationSummary(fallback)
            check(summary.contains("保守模板"), "a fallback plan is labelled as a fallback")
            check(summary.contains("RAI_LLM_API_KEY"), "a fallback plan explains why it fell back")
        } else {
            check(false, "a fallback generation payload decodes")
        }

        // The server prepends the overwrite note, so a one-warning display would
        // hide that stored work was replaced.
        let overwrittenJSON = """
        {"generatedAt":"2026-09-11T00:30:00.000Z","revision":10,
         "audit":{"generatedBy":"llm","model":"deepseek:deepseek-chat","promptVersion":"weekly-plan-v1","generatedAt":"2026-09-11T00:30:00.000Z"},
         "days":[{"localDate":"2026-09-11","kind":"interval","distanceKm":9,"structure":null,"reason":null}],
         "warnings":["已覆盖 2 天既有课表（2026-09-12、2026-09-13）：原有分段与说明不再保留","未配置 RAI_LLM_API_KEY，已回退到启发式课表","第三条不该出现"]}
        """
        if let overwritten = try? JSONDecoder().decode(MobileWeeklyPlanGenerationResponse.self, from: Data(overwrittenJSON.utf8)) {
            let summary = NativeAppModel.generationSummary(overwritten)
            check(summary.contains("deepseek:deepseek-chat"), "a model plan names the model")
            check(summary.contains("已覆盖 2 天既有课表"), "an overwrite of stored work is surfaced")
            check(summary.contains("RAI_LLM_API_KEY"), "the reason for a fallback is still surfaced")
            check(!summary.contains("第三条"), "the summary stays short instead of listing every warning")
        } else {
            check(false, "an overwrite generation payload decodes")
        }

        // --- plan-sync receipts follow the bridge, not the mapper -------------
        // `recordPlanSync` must register exactly the days the bridge read back off
        // the scheduler. Re-deriving the set from the mapper would register days
        // the watch never received, and a later run would then be labelled with a
        // prescription that was never handed over.
        let receiptPlanJSON = """
        {"generatedAt":"2026-09-11T01:00:00.000Z","timezone":"Asia/Shanghai","windowDays":2,"planRevision":7,
         "audit":{"generatedBy":"llm","model":null,"promptVersion":null,"generatedAt":"2026-09-11T00:30:00.000Z"},
         "days":[
          {"localDate":"2026-09-11","kind":"easy","title":"轻松跑","reason":"","distanceKm":8,"durationMinutes":48,
           "paceSecondsPerKmLower":330,"paceSecondsPerKmUpper":390,"heartRateBpmLower":120,"heartRateBpmUpper":150,
           "structure":{"warmup":null,"blocks":[{"iterations":1,"steps":[{"purpose":"work","goal":{"type":"distance","meters":8000},"alert":null}]}],"cooldown":null},
           "source":"llm","executable":true},
          {"localDate":"2026-09-12","kind":"easy","title":"轻松跑","reason":"","distanceKm":8,"durationMinutes":48,
           "paceSecondsPerKmLower":330,"paceSecondsPerKmUpper":390,"heartRateBpmLower":120,"heartRateBpmUpper":150,
           "structure":{"warmup":null,"blocks":[{"iterations":1,"steps":[{"purpose":"work","goal":{"type":"distance","meters":8000},"alert":null}]}],"cooldown":null},
           "source":"llm","executable":true}
         ]}
        """
        final class ReceiptCounter: @unchecked Sendable {
            private let lock = NSLock()
            private var value = 0
            func bump() { lock.lock(); value += 1; lock.unlock() }
            var count: Int { lock.lock(); defer { lock.unlock() }; return value }
        }
        if let receiptPlan = try? JSONDecoder().decode(MobileWorkoutPlanResponse.self, from: Data(receiptPlanJSON.utf8)) {
            check(receiptPlan.days.count == 2, "the receipt fixture holds two offerable days")
            let receipts = ReceiptCounter()
            StubProtocol.handler = { request in
                if request.url!.path.hasSuffix("/workout-plan/synced") {
                    receipts.bump()
                    return (200, "{}", 0)
                }
                return (503, "{}", 0)
            }
            _ = await model.recordPlanSync(receiptPlan, localDates: ["2026-09-12"])
            check(receipts.count == 1, "only the day the bridge reported back is registered as a receipt")
            _ = await model.recordPlanSync(receiptPlan, localDates: [])
            check(receipts.count == 1, "an empty bridged set registers no receipt at all")
            _ = await model.recordPlanSync(receiptPlan, localDates: ["2026-09-11", "2026-09-12"])
            check(receipts.count == 3, "both bridged days are registered")
            _ = await model.recordPlanSync(receiptPlan, localDates: ["2026-09-30"])
            check(receipts.count == 3, "a date outside the plan registers nothing")
        } else {
            check(false, "the receipt fixture decodes")
        }

        // --- shared goal-editor rules ----------------------------------------
        // Both skins validate through `NativeGoalWeekDraft`. The rules used to be
        // duplicated byte-for-byte in each skin, which is how the 2026-09-13 fix
        // shipped in one skin only.
        check(NativeGoalWeekDraft.parsedDistance(" 12.5 ") == 12.5, "a padded distance parses")
        check(NativeGoalWeekDraft.parsedDistance("") == nil, "an empty field means unset, not zero")
        check(NativeGoalWeekDraft.parsedDistance("abc") == nil, "a non-numeric distance does not parse")
        check(
            NativeGoalWeekDraft.weeklyDistanceIsValid("1") && NativeGoalWeekDraft.weeklyDistanceIsValid("500"),
            "the weekly bounds are inclusive"
        )
        check(
            !NativeGoalWeekDraft.weeklyDistanceIsValid("0.9") && !NativeGoalWeekDraft.weeklyDistanceIsValid("500.1"),
            "the weekly bounds reject just outside"
        )
        check(!NativeGoalWeekDraft.weeklyDistanceIsValid(""), "an empty weekly target is invalid")
        check(
            NativeGoalWeekDraft.dayDistanceIsValid("") && NativeGoalWeekDraft.dayDistanceIsValid("80"),
            "a day may be unset or sit exactly on the cap"
        )
        check(
            !NativeGoalWeekDraft.dayDistanceIsValid("80.1") && !NativeGoalWeekDraft.dayDistanceIsValid("-1"),
            "a day outside 0–80 is rejected"
        )
        check(
            NativeGoalWeekDraft.maxDayDistanceKm < NativeGoalWeekDraft.maxWeeklyDistanceKm,
            "one day can never exceed the whole week"
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

        print("All model regression checks passed.")
    }
}
