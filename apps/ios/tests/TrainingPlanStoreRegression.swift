import Foundation

enum Keychain {
    static func loadToken(for server: String?) -> String { preconditionFailure("Unexpected Keychain read") }
    static func saveToken(_ token: String, for server: String?) -> Bool { preconditionFailure("Unexpected Keychain write") }
}

final class PlanStoreProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (URLRequest) -> (Int, String, Double) = { _ in (503, "{}", 0) }
    /// 2026-10-18（P2-6 收尾）：可附加响应头（如 `Retry-After`），默认 nil 与旧行为一致。
    nonisolated(unsafe) static var extraHeaders: [String: String]? = nil
    /// 2026-10-18（事故复盘 P0-3）：可选地让请求以网络错误结束（模拟 `.timeout`/
    /// `.offline`），用于钉住"旧服务不再重试没拿到任何答复的失败"。
    nonisolated(unsafe) static var failure: URLError? = nil
    private let lock = NSLock()
    private var stopped = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        // handler 先跑（用例用它计数/决定状态），再决定是否以网络错误结束。
        let (status, body, delay) = Self.handler(request)
        let failure = Self.failure
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [self] in
            lock.lock()
            let alreadyStopped = stopped
            stopped = true
            lock.unlock()
            guard !alreadyStopped else { return }
            if let failure {
                client?.urlProtocol(self, didFailWithError: failure)
                return
            }
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: Self.extraHeaders)!, cacheStoragePolicy: .notAllowed)
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
            case "coherence": metadata["coherenceToken"] = "not-a-hash"
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
            // 2026-10-18（审查 P2-8）：安全字段校验失败是 snapshotValidationFailed，
            // 不再是"协议版本不兼容"的 contractMismatch（那会引导用户升级 App）。
            check(!result && store.executablePlan == nil && !store.isCurrent &&
                  store.issue?.code == .snapshotValidationFailed && store.availability == .unavailable,
                  "Store rejects unsafe aggregate \(variant) as a snapshot validation failure without mixing old execution")
        }
        if let diagnosticsURL = cache.exportPlanDiagnostics() {
            let diagnostics = try String(contentsOf: diagnosticsURL, encoding: .utf8)
            check(diagnostics.contains("\"snapshot_validation_failed\""),
                  "security-field rejection records a distinct snapshot_validation_failed diagnostic")
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
        // 2026-10-18（审查 P2-6）：新快照契约下 503 plan_snapshot_changed 是有界退避重试，
        // 不是直接 unavailable；重试仍受 requestID/epoch/scope/isValid/取消约束。
        final class AttemptCounter: @unchecked Sendable {
            private let lock = NSLock()
            private var stored = 0
            var count: Int { lock.lock(); defer { lock.unlock() }; return stored }
            func next() -> Int { lock.lock(); defer { lock.unlock() }; stored += 1; return stored }
        }
        // 2026-10-18（审查 P2-6 收尾）：延迟选择是纯函数，先钉住三种分支。
        final class DelayRecorder: @unchecked Sendable {
            private let lock = NSLock()
            private var stored: [TimeInterval] = []
            func append(_ value: TimeInterval) { lock.lock(); stored.append(value); lock.unlock() }
            var values: [TimeInterval] { lock.lock(); defer { lock.unlock() }; return stored }
        }
        check(TrainingPlanStore.snapshotRetryDelay(serverHint: 1, defaults: [0.15, 0.3], attempt: 0) == 1,
              "a server Retry-After hint wins over the local backoff schedule")
        check(TrainingPlanStore.snapshotRetryDelay(serverHint: 0.01, defaults: [0.15, 0.3], attempt: 0) == 0.1 &&
              TrainingPlanStore.snapshotRetryDelay(serverHint: 0, defaults: [0.15, 0.3], attempt: 0) == 0.1,
              "a tiny/zero server hint is floored at 0.1s instead of busy-looping")
        check(TrainingPlanStore.snapshotRetryDelay(serverHint: 9, defaults: [0.15, 0.3], attempt: 0) == 5,
              "a long server hint is capped at 5s")
        check(TrainingPlanStore.snapshotRetryDelay(serverHint: nil, defaults: [0.15, 0.3], attempt: 0) == 0.15 &&
              TrainingPlanStore.snapshotRetryDelay(serverHint: nil, defaults: [0.15, 0.3], attempt: 1) == 0.3,
              "without a hint the local 150/300ms schedule is used")
        check(TrainingPlanStore.snapshotRetryDelay(serverHint: nil, defaults: [0.15, 0.3], attempt: 2) == nil,
              "the retry schedule is exhausted after its entries")

        let retryStore = TrainingPlanStore(cache: cache, api: api, scope: UUID().uuidString,
            now: { ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")! })
        retryStore.snapshotRetryDelays = [0.001, 0.001]
        let retries = AttemptCounter()
        let retryDelays = DelayRecorder()
        retryStore.sleepBeforeSnapshotRetry = { retryDelays.append($0); return true }
        PlanStoreProtocol.handler = { _ in
            retries.next() <= 2
                ? (503, "{\"code\":\"plan_snapshot_changed\",\"message\":\"changed\"}", 0)
                : (200, goodJSON, 0)
        }
        let retried = await retryStore.refresh(baseURL: base, token: "", handshake: handshake, isValid: { true })
        check(retried && retryStore.isCurrent && retryStore.issue == nil && retries.count == 3 &&
              retryDelays.values == [0.001, 0.001],
              "new snapshot contract retries 503 plan_snapshot_changed twice with the local fallback schedule")
        let exhaustedStore = TrainingPlanStore(cache: cache, api: api, scope: UUID().uuidString,
            now: { ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")! })
        exhaustedStore.snapshotRetryDelays = [0.001, 0.001]
        let exhausted = AttemptCounter()
        let exhaustedDelays = DelayRecorder()
        exhaustedStore.sleepBeforeSnapshotRetry = { exhaustedDelays.append($0); return true }
        PlanStoreProtocol.handler = { _ in exhausted.next() <= 3
            ? (503, "{\"code\":\"plan_snapshot_changed\",\"message\":\"still changing\"}", 0)
            : (200, goodJSON, 0) }
        let exhaustedRead = await exhaustedStore.refresh(baseURL: base, token: "", handshake: handshake, isValid: { true })
        check(!exhaustedRead && exhausted.count == 3 && exhaustedStore.issue?.code == .serverUnavailable &&
              exhaustedStore.availability == .unavailable && exhaustedStore.serviceReachable &&
              exhaustedDelays.values == [0.001, 0.001],
              "snapshot retry is bounded (initial + 2), then reports a reachable-server failure")
        let cancellingStore = TrainingPlanStore(cache: cache, api: api, scope: UUID().uuidString,
            now: { ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")! })
        cancellingStore.snapshotRetryDelays = [0.2]
        let cancelling = AttemptCounter()
        PlanStoreProtocol.handler = { _ in
            _ = cancelling.next()
            return (503, "{\"code\":\"plan_snapshot_changed\",\"message\":\"changed\"}", 0)
        }
        let cancelledRetry = Task { await cancellingStore.refresh(baseURL: base, token: "", handshake: handshake, isValid: { true }) }
        try await Task.sleep(for: .milliseconds(30))
        cancellingStore.invalidate()
        let cancelledResult = await cancelledRetry.value
        check(!cancelledResult && cancelling.count == 1 && !cancellingStore.isRefreshing,
              "cancelling during snapshot backoff abandons the retry instead of issuing another read")

        // 2026-10-18（审查 P2-6 收尾）：服务端 Retry-After 优先。
        let hintStore = TrainingPlanStore(cache: cache, api: api, scope: UUID().uuidString,
            now: { ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")! })
        hintStore.snapshotRetryDelays = [0.001, 0.001]
        let hintDelays = DelayRecorder()
        hintStore.sleepBeforeSnapshotRetry = { hintDelays.append($0); return true }
        let hintAttempts = AttemptCounter()
        PlanStoreProtocol.extraHeaders = ["Retry-After": "1"]
        PlanStoreProtocol.handler = { _ in
            hintAttempts.next() == 1
                ? (503, "{\"code\":\"plan_snapshot_changed\",\"message\":\"changed\"}", 0)
                : (200, goodJSON, 0)
        }
        let hintedRetry = await hintStore.refresh(baseURL: base, token: "", handshake: handshake, isValid: { true })
        PlanStoreProtocol.extraHeaders = nil
        check(hintedRetry && hintStore.isCurrent && hintAttempts.count == 2 && hintDelays.values == [1],
              "503 + Retry-After: 1 is retried after the server hint, not the local schedule")

        // 503 无 Retry-After：直接使用默认 150/300ms 计划（用注入 sleeper 记录，不真睡）。
        let defaultScheduleStore = TrainingPlanStore(cache: cache, api: api, scope: UUID().uuidString,
            now: { ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")! })
        let defaultScheduleDelays = DelayRecorder()
        defaultScheduleStore.sleepBeforeSnapshotRetry = { defaultScheduleDelays.append($0); return true }
        let defaultScheduleAttempts = AttemptCounter()
        PlanStoreProtocol.handler = { _ in
            defaultScheduleAttempts.next() <= 2
                ? (503, "{\"code\":\"plan_snapshot_changed\",\"message\":\"changed\"}", 0)
                : (200, goodJSON, 0)
        }
        let defaultScheduleRetry = await defaultScheduleStore.refresh(baseURL: base, token: "", handshake: handshake, isValid: { true })
        check(defaultScheduleRetry && defaultScheduleAttempts.count == 3 &&
              defaultScheduleDelays.values == [0.15, 0.3],
              "503 without Retry-After falls back to the default 150/300ms local schedule")

        // 非法/HTTP-date 头被忽略，回退本地计划。
        let invalidHeaderStore = TrainingPlanStore(cache: cache, api: api, scope: UUID().uuidString,
            now: { ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")! })
        invalidHeaderStore.snapshotRetryDelays = [0.001]
        let invalidDelays = DelayRecorder()
        invalidHeaderStore.sleepBeforeSnapshotRetry = { invalidDelays.append($0); return true }
        let invalidAttempts = AttemptCounter()
        PlanStoreProtocol.extraHeaders = ["Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT"]
        PlanStoreProtocol.handler = { _ in
            invalidAttempts.next() == 1
                ? (503, "{\"code\":\"plan_snapshot_changed\",\"message\":\"changed\"}", 0)
                : (200, goodJSON, 0)
        }
        let invalidHeaderRetry = await invalidHeaderStore.refresh(baseURL: base, token: "", handshake: handshake, isValid: { true })
        PlanStoreProtocol.extraHeaders = nil
        check(invalidHeaderRetry && invalidAttempts.count == 2 && invalidDelays.values == [0.001],
              "an HTTP-date Retry-After is ignored and the local schedule is used")

        // 等待期间取消/放弃：不再发下一次读，也不把取消包装成成功。
        let abortedStore = TrainingPlanStore(cache: cache, api: api, scope: UUID().uuidString,
            now: { ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")! })
        abortedStore.snapshotRetryDelays = [0.001, 0.001]
        let abortedAttempts = AttemptCounter()
        abortedStore.sleepBeforeSnapshotRetry = { _ in false }
        PlanStoreProtocol.extraHeaders = ["Retry-After": "1"]
        PlanStoreProtocol.handler = { _ in
            _ = abortedAttempts.next()
            return (503, "{\"code\":\"plan_snapshot_changed\",\"message\":\"changed\"}", 0)
        }
        let abortedRead = await abortedStore.refresh(baseURL: base, token: "", handshake: handshake, isValid: { true })
        PlanStoreProtocol.extraHeaders = nil
        check(!abortedRead && abortedAttempts.count == 1 && !abortedStore.isRefreshing &&
              abortedStore.availability == .unavailable && abortedStore.serviceReachable,
              "an aborted retry wait stops the read loop instead of issuing another request")

        // 2026-10-18（审查 P2-7）：legacy 三 GET 路径补本地安全校验。
        let legacyHandshake = RaiHandshake(serverId: "server", athleteId: "athlete", datasetEpoch: "epoch",
            syncProtocolVersion: 1, apiVersion: "v1")
        let legacyState = try PlanTestFixtures.state()
        let legacyGoalsJSON = try PlanTestFixtures.json(legacyState.goals)
        let legacyTodayJSON = try PlanTestFixtures.json(legacyState.today)
        let legacyPlan = PlanTestFixtures.plan(revision: 12, dates: ["2026-10-09", "2026-10-10"])
        let legacyPlanJSON = try PlanTestFixtures.json(legacyPlan)
        let legacyStore = TrainingPlanStore(cache: cache, api: api, scope: UUID().uuidString,
            now: { ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")! })
        func serveLegacy(today: String = legacyTodayJSON, plan: String = legacyPlanJSON) {
            PlanStoreProtocol.handler = { request in
                switch request.url!.path {
                case "/v1/mobile/goals": return (200, legacyGoalsJSON, 0)
                case "/v1/mobile/today": return (200, today, 0)
                case "/v1/mobile/workout-plan": return (200, plan, 0)
                default: return (404, "{}", 0)
                }
            }
        }
        serveLegacy()
        let legacyLoaded = await legacyStore.refresh(baseURL: base, token: "", handshake: legacyHandshake, isValid: { true })
        check(legacyLoaded && legacyStore.isCurrent && legacyStore.executablePlan != nil,
              "legacy three-GET refresh is current only when today/window/timezone are locally coherent")
        for variant in ["previous-day", "window-length", "duplicate-day", "timezone"] {
            var todayObject = try JSONSerialization.jsonObject(with: Data(legacyTodayJSON.utf8)) as! [String: Any]
            var planObject = try JSONSerialization.jsonObject(with: Data(legacyPlanJSON.utf8)) as! [String: Any]
            switch variant {
            case "previous-day":
                var today = todayObject["today"] as! [String: Any]
                today["localDate"] = "2026-10-08"; todayObject["today"] = today
            case "window-length":
                planObject["windowDays"] = 0
            case "duplicate-day":
                var days = planObject["days"] as! [[String: Any]]
                days[1] = days[0]; planObject["days"] = days
            default:
                todayObject["timezone"] = "UTC"; planObject["timezone"] = "UTC"
            }
            serveLegacy(today: String(decoding: try JSONSerialization.data(withJSONObject: todayObject), as: UTF8.self),
                        plan: String(decoding: try JSONSerialization.data(withJSONObject: planObject), as: UTF8.self))
            let rejected = await legacyStore.refresh(baseURL: base, token: "", handshake: legacyHandshake, isValid: { true })
            check(!rejected && !legacyStore.isCurrent && legacyStore.executablePlan == nil &&
                  legacyStore.issue?.code == .snapshotValidationFailed,
                  "legacy snapshot rejects \(variant) instead of marking an unverified window current")
        }
        serveLegacy()
        _ = await legacyStore.refresh(baseURL: base, token: "", handshake: legacyHandshake, isValid: { true })
        // 2026-10-18（审查 P3-15）：单条缓存路径必须保留缓存时间。
        let cachedLegacy = TrainingPlanStore(cache: cache, api: api, scope: legacyStore.scope,
            now: { ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")! })
        cachedLegacy.loadCache()
        check(cachedLegacy.cachedAt != nil && cachedLegacy.availability == .cached(asOf: cachedLegacy.cachedAt),
              "legacy per-key cache paths keep their cachedAt instead of losing the cache time")
        check(cachedLegacy.availability.message.contains("缓存于"),
              "offline cache wording states when the snapshot was cached")

        // 2026-10-18（事故复盘 P0-3）：旧服务的读重试收窄。
        //
        // 事故里服务端被慢查询占住（coach-loop 实测 13.4s/条），客户端 15s/4s 超时
        // 先到期。旧实现 `.timeout`/`.offline` 也零退避立即重试，等于把 1 条昂贵读
        // 放大成 3 条。现在只有"服务端已经答复"的瞬态码才重试，且先退避再重读。
        let legacyReadClock = { ISO8601DateFormatter().date(from: "2026-10-09T04:00:00Z")! }
        for (networkError, expectedCode) in [(URLError(.timedOut), PlanReadIssue.Code.timeout),
                                             (URLError(.notConnectedToInternet), PlanReadIssue.Code.offline)] {
            let noRetryStore = TrainingPlanStore(cache: cache, api: api, scope: UUID().uuidString, now: legacyReadClock)
            noRetryStore.legacyRetryDelays = [0.001, 0.001]
            let noRetryDelays = DelayRecorder()
            noRetryStore.sleepBeforeSnapshotRetry = { noRetryDelays.append($0); return true }
            let noRetryAttempts = AttemptCounter()
            PlanStoreProtocol.handler = { _ in _ = noRetryAttempts.next(); return (0, "", 0) }
            PlanStoreProtocol.failure = networkError
            let noRetryRead = await noRetryStore.refresh(baseURL: base, token: "", handshake: legacyHandshake, isValid: { true })
            PlanStoreProtocol.failure = nil
            check(!noRetryRead && noRetryStore.issue?.code == expectedCode &&
                  noRetryAttempts.count == 3 && noRetryDelays.values.isEmpty && !noRetryStore.serviceReachable,
                  "legacy \(expectedCode.rawValue) is not retried: one three-GET attempt, no backoff, not reachable")
        }

        // 服务端已答复（503）+ Retry-After：按服务端提示退避一次后重读；重读仍走
        // 同一个 requestID/epoch/scope，取消即放弃。
        let legacyHintStore = TrainingPlanStore(cache: cache, api: api, scope: UUID().uuidString, now: legacyReadClock)
        legacyHintStore.legacyRetryDelays = [0.001, 0.001]
        let legacyHintDelays = DelayRecorder()
        legacyHintStore.sleepBeforeSnapshotRetry = { legacyHintDelays.append($0); return true }
        let legacyHintGoalCalls = AttemptCounter()
        PlanStoreProtocol.extraHeaders = ["Retry-After": "1"]
        PlanStoreProtocol.handler = { request in
            switch request.url!.path {
            case "/v1/mobile/goals":
                return legacyHintGoalCalls.next() == 1
                    ? (503, "{\"code\":\"database_busy\",\"message\":\"busy\"}", 0)
                    : (200, legacyGoalsJSON, 0)
            case "/v1/mobile/today": return (200, legacyTodayJSON, 0)
            case "/v1/mobile/workout-plan": return (200, legacyPlanJSON, 0)
            default: return (404, "{}", 0)
            }
        }
        let legacyHinted = await legacyHintStore.refresh(baseURL: base, token: "", handshake: legacyHandshake, isValid: { true })
        PlanStoreProtocol.extraHeaders = nil
        check(legacyHinted && legacyHintStore.isCurrent && legacyHintDelays.values == [1] && legacyHintGoalCalls.count == 2,
              "legacy 503 + Retry-After: 1 backs off by the server hint before the single reread")

        // 无 Retry-After：回退默认 150/300ms 计划（用注入 sleeper 记录，不真睡）。
        let legacyScheduleStore = TrainingPlanStore(cache: cache, api: api, scope: UUID().uuidString, now: legacyReadClock)
        let legacyScheduleDelays = DelayRecorder()
        legacyScheduleStore.sleepBeforeSnapshotRetry = { legacyScheduleDelays.append($0); return true }
        let legacyScheduleGoalCalls = AttemptCounter()
        PlanStoreProtocol.handler = { request in
            switch request.url!.path {
            case "/v1/mobile/goals":
                return legacyScheduleGoalCalls.next() <= 2
                    ? (503, "{\"code\":\"database_busy\",\"message\":\"busy\"}", 0)
                    : (200, legacyGoalsJSON, 0)
            case "/v1/mobile/today": return (200, legacyTodayJSON, 0)
            case "/v1/mobile/workout-plan": return (200, legacyPlanJSON, 0)
            default: return (404, "{}", 0)
            }
        }
        let legacyScheduled = await legacyScheduleStore.refresh(baseURL: base, token: "", handshake: legacyHandshake, isValid: { true })
        check(legacyScheduled && legacyScheduleStore.isCurrent &&
              legacyScheduleDelays.values == [0.15, 0.3] && legacyScheduleGoalCalls.count == 3,
              "legacy 503 without Retry-After backs off on the default 150/300ms schedule")

        // 重试有界：1 + legacyRetryCount 次后停止，并如实报"服务端可达但不可用"。
        let legacyExhaustedStore = TrainingPlanStore(cache: cache, api: api, scope: UUID().uuidString, now: legacyReadClock)
        legacyExhaustedStore.legacyRetryDelays = [0.001, 0.001]
        let legacyExhaustedDelays = DelayRecorder()
        legacyExhaustedStore.sleepBeforeSnapshotRetry = { legacyExhaustedDelays.append($0); return true }
        let legacyExhaustedGoalCalls = AttemptCounter()
        PlanStoreProtocol.handler = { request in
            switch request.url!.path {
            case "/v1/mobile/goals":
                _ = legacyExhaustedGoalCalls.next()
                return (503, "{\"code\":\"database_busy\",\"message\":\"busy\"}", 0)
            case "/v1/mobile/today": return (200, legacyTodayJSON, 0)
            case "/v1/mobile/workout-plan": return (200, legacyPlanJSON, 0)
            default: return (404, "{}", 0)
            }
        }
        let legacyExhaustedRead = await legacyExhaustedStore.refresh(baseURL: base, token: "", handshake: legacyHandshake, isValid: { true })
        check(!legacyExhaustedRead && legacyExhaustedGoalCalls.count == 3 &&
              legacyExhaustedDelays.values == [0.001, 0.001] &&
              legacyExhaustedStore.issue?.code == .serverUnavailable &&
              legacyExhaustedStore.serviceReachable && legacyExhaustedStore.availability == .unavailable,
              "legacy retries are bounded (initial + 2), then report a reachable-server failure")

        // 退避等待期间被取消/放弃：不再发下一次读，取消不包装成成功。
        let legacyAbortStore = TrainingPlanStore(cache: cache, api: api, scope: UUID().uuidString, now: legacyReadClock)
        legacyAbortStore.legacyRetryDelays = [0.001, 0.001]
        legacyAbortStore.sleepBeforeSnapshotRetry = { _ in false }
        let legacyAbortGoalCalls = AttemptCounter()
        PlanStoreProtocol.handler = { request in
            switch request.url!.path {
            case "/v1/mobile/goals":
                _ = legacyAbortGoalCalls.next()
                return (503, "{\"code\":\"database_busy\",\"message\":\"busy\"}", 0)
            case "/v1/mobile/today": return (200, legacyTodayJSON, 0)
            case "/v1/mobile/workout-plan": return (200, legacyPlanJSON, 0)
            default: return (404, "{}", 0)
            }
        }
        let legacyAbortedRead = await legacyAbortStore.refresh(baseURL: base, token: "", handshake: legacyHandshake, isValid: { true })
        check(!legacyAbortedRead && legacyAbortGoalCalls.count == 1 && !legacyAbortStore.isRefreshing &&
              legacyAbortStore.availability == .unavailable && legacyAbortStore.serviceReachable,
              "an aborted legacy retry wait stops the read loop instead of issuing another request")

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
        let identitiesData = try Data(contentsOf: URL(fileURLWithPath: "apps/ios/tests/fixtures/training-plan-sessions-v2.json"))
        let identitiesFixture = try JSONSerialization.jsonObject(with: identitiesData) as! [String: Any]
        let identitiesWire = identitiesFixture["wire"] as! [String: Any]
        let identitiesJSON = String(decoding: try JSONSerialization.data(withJSONObject: identitiesWire), as: UTF8.self)
        var identitiesHandshake = RaiHandshake(serverId: "synthetic-server", athleteId: "synthetic-athlete", datasetEpoch: "synthetic-epoch",
            syncProtocolVersion: 1, apiVersion: "v1")
        identitiesHandshake.trainingPlanContractVersion = 2
        identitiesHandshake.trainingPlanSessionContractVersion = 1
        let identityScope = UUID().uuidString
        let identityClock = { ISO8601DateFormatter().date(from: "2026-10-25T04:00:00Z")! }
        let identityStore = TrainingPlanStore(cache: cache, api: api, scope: identityScope, now: identityClock)
        PlanStoreProtocol.handler = { request in
            precondition(request.httpMethod == "GET" && request.value(forHTTPHeaderField: "X-RAI-Training-Sessions") == "1")
            return (200, identitiesJSON, 0)
        }
        let identityLoaded = await identityStore.refreshUnifiedPlan(baseURL: base, token: "", handshake: identitiesHandshake, isValid: { true })
        check(identityLoaded && identityStore.unifiedIsCurrent && identityStore.unified?.sessions?.sessions.first?.sessionRevision == 3,
              "B02 Store accepts the negotiated stable session revision")
        let identityCached = TrainingPlanStore(cache: cache, api: api, scope: identityScope, now: identityClock)
        identityCached.loadCache()
        check(identityCached.unified == identityStore.unified && !identityCached.unifiedIsCurrent && identityCached.executablePlan == nil,
              "B02 real SQLite cache retains complete identity/override/suppression but remains reference-only after restart")
        let isolatedIdentity = TrainingPlanStore(cache: cache, api: api, scope: UUID().uuidString, now: identityClock)
        isolatedIdentity.loadCache()
        check(isolatedIdentity.unified == nil, "B02 identities cannot cross the cache scope")
        // B07: the optional execution rows are cached with the same snapshot, and
        // a lower state revision / same-revision instance swap cannot roll it back.
        var executionWire = identitiesWire
        var executionExtension = executionWire["sessions"] as! [String: Any]
        executionExtension["executions"] = [["sessionId": "synthetic-stable-session", "executionRevision": 1,
            "association": "unlinked", "trainingSessionId": NSNull(), "sourceFactDigest": NSNull(),
            "prescriptionSessionRevision": 3, "assessment": NSNull(),
            "availableAt": "2026-10-25T02:00:00.000Z", "reasonCodes": []]]
        executionWire["sessions"] = executionExtension
        let executionJSON = String(decoding: try JSONSerialization.data(withJSONObject: executionWire), as: UTF8.self)
        PlanStoreProtocol.handler = { _ in (200, executionJSON, 0) }
        let executionLoaded = await identityStore.refreshUnifiedPlan(baseURL: base, token: "", handshake: identitiesHandshake, isValid: { true })
        check(executionLoaded && identityStore.sessionExecutionsKnown &&
              identityStore.sessionExecution(for: "synthetic-stable-session")?.association == "unlinked",
              "B07 Store caches the optional execution view without inventing a row")
        var staleWire = executionWire
        staleWire["stateRevision"] = 6
        let staleJSON = String(decoding: try JSONSerialization.data(withJSONObject: staleWire), as: UTF8.self)
        PlanStoreProtocol.handler = { _ in (200, staleJSON, 0) }
        let staleRejected = await identityStore.refreshUnifiedPlan(baseURL: base, token: "", handshake: identitiesHandshake, isValid: { true })
        check(!staleRejected && identityStore.unified?.stateRevision == 7 &&
              identityStore.sessionExecution(for: "synthetic-stable-session") != nil,
              "B07 an older GET cannot overwrite a newer execution snapshot")
        var foreignInstanceWire = executionWire
        var foreignExtension = foreignInstanceWire["sessions"] as! [String: Any]
        foreignExtension["planInstanceId"] = "other-instance"
        var foreignSessions = foreignExtension["sessions"] as! [[String: Any]]
        foreignSessions[0]["planInstanceId"] = "other-instance"
        foreignExtension["sessions"] = foreignSessions
        foreignInstanceWire["sessions"] = foreignExtension
        let foreignJSON = String(decoding: try JSONSerialization.data(withJSONObject: foreignInstanceWire), as: UTF8.self)
        PlanStoreProtocol.handler = { _ in (200, foreignJSON, 0) }
        let foreignRejected = await identityStore.refreshUnifiedPlan(baseURL: base, token: "", handshake: identitiesHandshake, isValid: { true })
        check(!foreignRejected && identityStore.unified?.sessions?.planInstanceId == "synthetic-plan",
              "B07 a same-revision plan-instance swap is rejected")
        var missingIdentity = identitiesWire; missingIdentity.removeValue(forKey: "sessions")
        let missingIdentityJSON = String(decoding: try JSONSerialization.data(withJSONObject: missingIdentity), as: UTF8.self)
        PlanStoreProtocol.handler = { _ in (200, missingIdentityJSON, 0) }
        let missingRead = await identityStore.refreshUnifiedPlan(baseURL: base, token: "", handshake: identitiesHandshake, isValid: { true })
        check(!missingRead && !identityStore.unifiedIsCurrent && identityStore.unified?.sessions != nil,
              "B02 missing negotiated identities do not overwrite the retained reference with an empty extension")
        print("TrainingPlanStore regression: \(count) checks passed")
    }
}
