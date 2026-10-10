import Foundation

enum Keychain {
    static func loadToken(for server: String?) -> String { preconditionFailure("Unexpected Keychain read") }
    static func saveToken(_ token: String, for server: String?) -> Bool { preconditionFailure("Unexpected Keychain write") }
}

final class PlanStoreProtocol: URLProtocol, @unchecked Sendable {
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

@main struct TrainingPlanStoreRegression {
    @MainActor static func main() async throws {
        var count = 0
        func check(_ result: @autoclosure () -> Bool, _ name: String) { precondition(result(), name); count += 1; print("PASS: \(name)") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = CacheStore(fileURL: root.appendingPathComponent("cache.sqlite"))
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [PlanStoreProtocol.self]
        let api = RaiAPIClient(session: URLSession(configuration: configuration))
        let base = URL(string: "https://plan-store.invalid")!
        let handshake = RaiHandshake(serverId: "server", athleteId: "athlete", datasetEpoch: "epoch", syncProtocolVersion: 1, apiVersion: "v1",
            planSnapshotContractVersion: 1)
        let store = TrainingPlanStore(cache: cache, api: api, scope: UUID().uuidString, now: { ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")! })
        let good = try PlanTestFixtures.state()
        let goodJSON = try PlanTestFixtures.json(good)
        PlanStoreProtocol.handler = { request in
            precondition(request.url!.path == "/v1/mobile/training-plan-state", "capability selects exactly one aggregate endpoint")
            return (200, goodJSON, 0)
        }
        let loaded = await store.refresh(baseURL: base, token: "", handshake: handshake, isValid: { true })
        check(loaded && store.executablePlan?.days.count == 7 && store.metadata?.coherenceToken == good.metadata.coherenceToken, "Store alone accepts a complete identity-bound seven-day snapshot")
        let cached = TrainingPlanStore(cache: cache, api: api, scope: store.scope, now: { ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")! })
        cached.loadCache()
        check(cached.today != nil && cached.executablePlan == nil && !cached.isCurrent, "cached aggregates remain reference-only and do not authorize offline scheduling")
        let empty = try PlanTestFixtures.json(PlanTestFixtures.state(empty: true))
        PlanStoreProtocol.handler = { _ in (200, empty, 0) }
        let emptyRead = await store.refresh(baseURL: base, token: "", handshake: handshake, isValid: { true })
        check(emptyRead && store.availability == .empty && store.issue == nil, "complete empty execution domain is distinct from read failure")
        for variant in ["identity", "coherence", "windowStart", "windowEnd", "duplicate", "non-real-date", "length"] {
            var object = try JSONSerialization.jsonObject(with: Data(goodJSON.utf8)) as! [String: Any]
            var metadata = object["metadata"] as! [String: Any]
            var plan = object["workoutPlan"] as! [String: Any]
            switch variant {
            case "identity": metadata["athleteId"] = "another-athlete"
            case "coherence": metadata.removeValue(forKey: "coherenceToken")
            case "windowStart": plan.removeValue(forKey: "windowStart")
            case "windowEnd": metadata["windowEnd"] = "2026-10-16"
            case "duplicate":
                var days = plan["days"] as! [[String: Any]]; days[1] = days[0]; plan["days"] = days
            case "length": plan["windowDays"] = 8
            default: metadata["windowStart"] = "2026-02-30"; metadata["localDate"] = "2026-02-30"; plan["windowStart"] = "2026-02-30"
            }
            object["metadata"] = metadata; object["workoutPlan"] = plan
            let json = String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
            PlanStoreProtocol.handler = { _ in (200, json, 0) }
            let result = await store.refresh(baseURL: base, token: "", handshake: handshake, isValid: { true })
            check(!result && store.executablePlan == nil && store.issue?.code == .contractMismatch, "Store rejects unsafe aggregate \(variant) without mixing old execution")
        }
        PlanStoreProtocol.handler = { _ in (200, goodJSON, 0.15) }
        let older = Task { await store.refresh(baseURL: base, token: "", handshake: handshake, isValid: { true }) }
        try await Task.sleep(for: .milliseconds(20))
        store.acknowledge(revision: 13, action: "test")
        let late = await older.value
        check(!late && store.revision == 13 && store.executablePlan == nil, "late aggregate cannot undo a durable acknowledged mutation")
        let changed = try PlanTestFixtures.json(PlanTestFixtures.state(revision: 13, coherence: String(repeating: "c", count: 64)))
        PlanStoreProtocol.handler = { _ in (200, changed, 0) }
        let changedRead = await store.refresh(baseURL: base, token: "", handshake: handshake, isValid: { true })
        check(changedRead && store.metadata?.coherenceToken == String(repeating: "c", count: 64), "same prescription revision can receive a new server facts token")
        PlanStoreProtocol.handler = { _ in (200, changed, 0.15) }
        let cancelled = Task { await store.refresh(baseURL: base, token: "", handshake: handshake, isValid: { true }) }
        try await Task.sleep(for: .milliseconds(20)); cancelled.cancel()
        _ = await cancelled.value
        check(!store.isCurrent && !store.isRefreshing, "cancelled reads cannot leave an executable current snapshot or stuck spinner")
        let lateScope = Task { await store.refresh(baseURL: base, token: "", handshake: handshake, isValid: { true }) }
        try await Task.sleep(for: .milliseconds(20)); store.configure(scope: UUID().uuidString, clear: true)
        _ = await lateScope.value
        check(store.goals == nil && store.revision == 0, "Store rejects a late read after its identity scope changes")
        var futureHandshake = handshake
        futureHandshake.planSnapshotContractVersion = 9
        let future = await store.refresh(baseURL: base, token: "", handshake: futureHandshake, isValid: { true })
        check(!future && store.issue?.code == .contractMismatch, "higher snapshot capability fails closed without a legacy downgrade")
        let loopData = try Data(contentsOf: URL(fileURLWithPath: "apps/ios/tests/fixtures/coach-loop-v1.json"))
        let loop = try JSONDecoder().decode(CoachLoopResponse.self, from: loopData)
        let loopJSON = String(decoding: loopData, as: UTF8.self)
        let loopHandshake = RaiHandshake(serverId: loop.scope.serverId, athleteId: loop.scope.athleteId,
            datasetEpoch: loop.scope.datasetEpoch, syncProtocolVersion: 1, apiVersion: "v1",
            planSnapshotContractVersion: 1, planPublicationContractVersion: 1, planReceiptContractVersion: 2, coachLoopContractVersion: 1)
        let loopStore = TrainingPlanStore(cache: cache, api: api, scope: UUID().uuidString,
            now: { ISO8601DateFormatter().date(from: "2026-10-08T04:00:00Z")! })
        PlanStoreProtocol.handler = { request in
            precondition(request.url!.path == "/v1/mobile/coach-loop", "opted-in client must not use legacy S-based reads")
            return (200, loopJSON, 0)
        }
        let loopLoaded = await loopStore.refresh(baseURL: base, token: "", handshake: loopHandshake, isValid: { true })
        check(loopLoaded && loopStore.executablePlan?.windowDays == 1 &&
            loopStore.executablePlan?.days[0].structure == loop.today.day.structure,
            "AC0-12 native v1 reads exact published today, never exports future outlook")
        check(loopStore.coachLoop?.volumePolicy.suggestedWeeklyKm == 20 && loopStore.coachLoop?.volumePolicy.weeklyProtectionKm == 26,
            "AC0-13 native retains independent S20/H26 and real extension authority")
        check(loopStore.today == nil && loopStore.coach == nil && loopStore.presentation(offline: false).today == nil,
            "old today/fitness projections cannot reappear after explicit conversion")
        let loopCached = TrainingPlanStore(cache: cache, api: api, scope: loopStore.scope,
            now: { ISO8601DateFormatter().date(from: "2026-10-08T04:00:00Z")! })
        loopCached.loadCache()
        check(loopCached.coachLoop?.settings?.mode == "daily_adaptive" && loopCached.executablePlan == nil,
            "offline new-contract cache is reference-only")
        for variant in ["identity", "facts", "token", "duplicate", "paused", "authorization", "missing-authorization", "timezone", "today-mismatch"] {
            var object = try JSONSerialization.jsonObject(with: loopData) as! [String: Any]
            switch variant {
            case "identity": object["scope"] = ["serverId": "other", "athleteId": loop.scope.athleteId, "datasetEpoch": loop.scope.datasetEpoch]
            case "facts": object["factsHash"] = "not-a-hash"
            case "token": object.removeValue(forKey: "executionToken")
            case "duplicate":
                var days = object["days"] as! [[String: Any]]; days[1] = days[0]; object["days"] = days
            case "paused":
                var settings = object["settings"] as! [String: Any]; settings["status"] = "paused"; object["settings"] = settings
            case "authorization":
                var today = object["today"] as! [String: Any]; today["decisionRef"] = String(repeating: "f", count: 64); object["today"] = today
            case "missing-authorization":
                var today = object["today"] as! [String: Any]; today["decisionRef"] = NSNull(); object["today"] = today
                var days = object["days"] as! [[String: Any]]; days[0]["decisionRef"] = NSNull(); object["days"] = days
            case "timezone": object["timezone"] = "UTC"
            default:
                var today = object["today"] as! [String: Any]; today["executable"] = false; object["today"] = today
            }
            let invalid = String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
            PlanStoreProtocol.handler = { _ in (200, invalid, 0) }
            let rejected = await loopStore.refresh(baseURL: base, token: "", handshake: loopHandshake, isValid: { true })
            check(!rejected && loopStore.executablePlan == nil, "new client fails closed for \(variant)")
        }
        var oldServer = loopHandshake; oldServer.coachLoopContractVersion = nil
        PlanStoreProtocol.handler = { _ in preconditionFailure("must refuse protocol rollback before issuing any legacy request") }
        let rollback = await loopCached.refresh(baseURL: base, token: "", handshake: oldServer, isValid: { true })
        check(!rollback && loopCached.executablePlan == nil, "AC4-12/AC0-21 server rollback never downgrades an opted-in plan")
        var futureLoop = loopHandshake; futureLoop.coachLoopContractVersion = 2
        let futureLoopRead = await loopStore.refresh(baseURL: base, token: "", handshake: futureLoop, isValid: { true })
        check(!futureLoopRead && loopStore.executablePlan == nil, "unknown future coach contract is not guessed")
        let fields = CoachLoopFeedbackCommand.Fields(phase: "pre_run", observedAt: loop.asOf, requestedAction: "rest")
        let encodedFields = try JSONSerialization.jsonObject(with: JSONEncoder().encode(fields)) as! [String: Any]
        check(encodedFields["fatigue"] is NSNull && encodedFields["workoutId"] is NSNull &&
            encodedFields["rpeOverrideRef"] is NSNull && encodedFields["requestedAction"] as? String == "rest",
            "AC5-01/02 feedback skips encode explicit null, not missing/normal or duplicate RPE")
        let preferences = CoachLoopPreferences(mode: "daily_adaptive", runningDays: [4], longRunDays: [],
            availabilityMinutesByWeekday: [:], targetType: "pace", race: nil)
        let encodedPreferences = try JSONSerialization.jsonObject(with: JSONEncoder().encode(preferences)) as! [String: Any]
        check(encodedPreferences["race"] is NSNull && encodedPreferences["status"] == nil,
            "unlimited daily preferences explicitly clear race without smuggling lifecycle state")
        let feedbackCommand = CoachLoopFeedbackCommand(operationId: UUID().uuidString, operationScope: loop.scope,
            id: UUID().uuidString, expectedRevision: 0, action: "save", consent: true, fields: fields)
        check(cache.saveCoachFeedback(feedbackCommand, scope: loopStore.scope), "feedback intent is durably saved before network")
        cache.clear(scope: loopStore.scope)
        check((cache.pendingCoachFeedback(scope: loopStore.scope).value ?? nil)?.operationId == feedbackCommand.operationId,
            "clearing presentation cache cannot erase unknown-result feedback operation")
        print("TrainingPlanStore regression: \(count) checks passed")
    }
}
