import Foundation

@MainActor final class CommandJournal: TrainingPlanCommandPersistence {
    var pending: PendingPlanPublication?
    var watermark: TrainingPlanCommandWatermark?
    var failIntent = false
    var failAcknowledgement = false
    var failClear = false
    func pendingPublication(scope: String) -> CacheReadResult<PendingPlanPublication?> { .value(pending) }
    func savePublication(_ value: PendingPlanPublication?, scope: String) -> Bool {
        if failIntent && value != nil || failClear && value == nil { return false }
        pending = value; return true
    }
    func trainingPlanCommandWatermark(scope: String) -> CacheReadResult<TrainingPlanCommandWatermark> { watermark.map { .value($0) } ?? .notFound }
    func saveTrainingPlanCommandWatermark(_ value: TrainingPlanCommandWatermark, scope: String) -> Bool {
        if failAcknowledgement { return false }; watermark = value; return true
    }
}
final class CommandProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (URLRequest) -> (Int, Data) = { _ in (503, Data()) }
    private static let responseLock = NSLock()
    nonisolated(unsafe) private static var heldPath: String?
    nonisolated(unsafe) private static var heldResponse: (@Sendable () -> Void)?
    static func holdNext(_ path: String) { responseLock.withLock { heldPath = path } }
    static var hasHeldResponse: Bool { responseLock.withLock { heldResponse != nil } }
    static func deliverHeld() {
        let response = responseLock.withLock { let value = heldResponse; heldResponse = nil; return value }
        response?()
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, data) = Self.handler(request)
        let deliver: @Sendable () -> Void = { [self] in
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        }
        let held = Self.responseLock.withLock {
            guard request.url!.path.hasSuffix(Self.heldPath ?? "\u{0}") else { return false }
            Self.heldPath = nil; Self.heldResponse = deliver; return true
        }
        if !held { deliver() }
    }
    override func stopLoading() {}
}
@main struct TrainingPlanPublisherRegression {
    @MainActor static func main() async throws {
        func check(_ value: Bool, _ name: String) { precondition(value, name); print("PASS: \(name)") }
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [CommandProtocol.self]
        let api = RaiAPIClient(session: URLSession(configuration: configuration))
        let identity = PlanReceiptScope(serverId: "server", athleteId: "athlete", datasetEpoch: "epoch")
        let context = TrainingPlanPublisher.Context(baseURL: URL(string: "https://commands.invalid")!, cacheScope: "scope",
            identity: identity, sessionID: UUID(), credential: "synthetic-token")
        let clock = ISO8601DateFormatter().date(from: "2026-10-23T04:00:00Z")!
        let draft = TrainingPlanCommandPreviewRequest(operationScope: identity, action: .pause, expectedStateRevision: 2, raceGoal: nil)
        let summary = "{\"mode\":\"coach\",\"modeReason\":\"no_race_goal\",\"daysToRace\":null,\"runState\":\"active\",\"admission\":\"ready\",\"raceGoal\":null}"
        let previewData = Data("{\"contractVersion\":2,\"candidateId\":\"abc:2026-10-23T04:02:00.000Z\",\"expiresAt\":\"2026-10-23T04:02:00.000Z\",\"expectedStateRevision\":2,\"before\":\(summary),\"after\":\(summary),\"warnings\":[]}".utf8)
        func result(_ id: String) -> Data { Data("{\"contractVersion\":2,\"operationId\":\"\(id)\",\"stateRevision\":3,\"goalsRevision\":17,\"warnings\":[]}".utf8) }
        var posts: [Data] = []; var paths: [String] = []; var queryStatus = "committed"; var queryHTTP = 200; var lostReply = false
        var policyChanged = false
        let journal = CommandJournal()
        CommandProtocol.handler = { request in
            let path = request.url!.path; paths.append(path)
            check(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-token", "authenticated transport")
            if path.hasSuffix("/preview") {
                check(request.httpMethod == "POST", "preview uses POST")
                return (200, previewData)
            }
            if path.contains("/plan-operations/") {
                guard queryHTTP == 200 else { return (queryHTTP, Data("{\"code\":\"missing_route\",\"message\":\"missing\"}".utf8)) }
                let id = path.components(separatedBy: "/").last!
                return (200, Data("{\"status\":\"\(queryStatus)\",\"operationId\":\"\(id)\"\(queryStatus == "committed" ? ",\"result\":" + String(data: result(id), encoding: .utf8)! : "")}".utf8))
            }
            check(path == "/v1/mobile/training-plan/commands" || path == "/v1/mobile/training-plan/commands/refresh", "all new writes use v2 URLs")
            check(request.httpMethod == "POST", "submit/refresh use POST")
            let data = request.httpBody ?? request.httpBodyStream.map { stream -> Data in
                stream.open(); defer { stream.close() }; var buffer = [UInt8](repeating: 0, count: 4096); var value = Data()
                while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; value.append(contentsOf: buffer[0..<n]) }; return value
            } ?? Data()
            posts.append(data)
            let envelope = try! JSONDecoder().decode(TrainingPlanRefreshRequest.self, from: data)
            check(envelope.contractVersion == 2 && envelope.operationScope == identity && envelope.expectedStateRevision == 2, "wire version/scope/revision preserved")
            if policyChanged { return (409, Data("{\"code\":\"coach_policy_changed\",\"message\":\"请先确认当前规则版本，再提交训练变更。\"}".utf8)) }
            if lostReply { return (503, Data("{\"code\":\"synthetic_lost_reply\",\"message\":\"unknown\"}".utf8)) }
            return (200, result(envelope.operationId))
        }
        let publisher = TrainingPlanPublisher(api: api, persistence: journal, now: { clock })
        func waitForHeldResponse() async throws {
            for _ in 0..<200 {
                if CommandProtocol.hasHeldResponse { return }
                try await Task.sleep(for: .milliseconds(5))
            }
            preconditionFailure("transport never reached response latch")
        }
        for reason in ["close button", "gesture dismissal", "draft change"] {
            CommandProtocol.holdNext("/preview")
            let inFlight = Task { await publisher.makePreview(draft, context: context) { true } }
            try await waitForHeldResponse()
            check(publisher.phase == .previewing, "\(reason): fixture is previewing")
            publisher.cancelPreview()
            check(!publisher.isBusy && publisher.preview == nil, "\(reason): cancellation invalidates immediately")
            CommandProtocol.deliverHeld()
            check(!(await inFlight.value) && publisher.preview == nil && publisher.phase == .idle,
                  "\(reason): late preview cannot restore a candidate after reopening")
            check(await publisher.confirm(context: context) { true } == nil && posts.isEmpty && journal.pending == nil,
                  "\(reason): reopening requires another explicit preview")
        }
        CommandProtocol.holdNext("/preview")
        let oldPreview = Task { await publisher.makePreview(draft, context: context) { true } }
        try await waitForHeldResponse()
        publisher.cancelPreview()
        let changedDraft = TrainingPlanCommandPreviewRequest(operationScope: identity, action: .resume, expectedStateRevision: 2, raceGoal: nil)
        check(await publisher.makePreview(changedDraft, context: context) { true }, "new draft may preview while the cancelled response is in flight")
        CommandProtocol.deliverHeld()
        check(!(await oldPreview.value) && publisher.matchesPreview(action: .resume, raceGoal: nil) &&
              !publisher.matchesPreview(action: .pause, raceGoal: nil), "old completion cannot clear or replace the new draft candidate")
        publisher.cancelPreview()
        check(await publisher.makePreview(draft, context: context) { true }, "preview is accepted")
        publisher.cancelPreview()
        check(posts.isEmpty && journal.pending == nil, "preview cancellation is zero writes and no journal")
        check(await publisher.makePreview(draft, context: context) { true }, "preview again")
        journal.failIntent = true
        check(await publisher.confirm(context: context) { true } == nil && posts.isEmpty, "intent persistence failure sends zero writes")
        check(journal.pending == nil && publisher.phase == .needsPreview && !publisher.executionBlocked && publisher.preview == nil,
              "an unsent intent failure needs a new preview rather than an unrecoverable pending-operation gate")
        publisher.cancelPreview()
        check(!publisher.executionBlocked && journal.pending == nil, "closing and reopening after an unsent failure remains retryable")
        journal.failIntent = false
        check(await publisher.makePreview(draft, context: context) { true }, "preview before in-flight submission dismissal")
        CommandProtocol.holdNext("/commands")
        let submission = Task { await publisher.confirm(context: context) { true } }
        try await waitForHeldResponse()
        let sentIntent = journal.pending
        publisher.cancelPreview()
        check(publisher.isBusy && publisher.phase == .submitting && journal.pending?.payload == sentIntent?.payload && sentIntent != nil,
              "closing during submit preserves its generation and durable intent")
        CommandProtocol.deliverHeld()
        check(await submission.value != nil && publisher.phase == .committedAwaitingRead && publisher.finishRead(context: context),
              "dismissed submission still acknowledges and completes the normal read lifecycle")
        posts.removeAll()
        lostReply = true
        check(await publisher.makePreview(draft, context: context) { true }, "preview after storage repair")
        check(await publisher.confirm(context: context) { true } == nil && journal.pending != nil, "unknown result preserves original intent")
        let unresolved = journal.pending
        publisher.cancelPreview()
        check(journal.pending?.payload == unresolved?.payload && journal.pending?.operationId == unresolved?.operationId,
              "preview cleanup never deletes an unresolved submit journal")
        let firstBytes = journal.pending!.payload
        let restarted = TrainingPlanPublisher(api: api, persistence: journal, now: { clock })
        CommandProtocol.holdNext("/plan-operations/" + journal.pending!.operationId)
        let query = Task { await restarted.recover(context: context, mayReplay: false) { true } }
        try await waitForHeldResponse()
        restarted.cancelPreview()
        check(restarted.isBusy && restarted.phase == .querying && journal.pending?.payload == firstBytes,
              "closing during query preserves its generation and original submit journal")
        CommandProtocol.deliverHeld()
        let committed = await query.value
        check(committed?.stateRevision == 3 && posts.count == 1 && journal.watermark?.goalsRevision == 17,
              "restart queries committed even with write capability off, without submitting twice")
        check(journal.watermark?.stateRevision == 3 && restarted.executionBlocked, "state/goals watermarks remain separate and execution awaits read")
        journal.failClear = true
        check(!restarted.finishRead(context: context) && journal.pending != nil && restarted.phase == .storageFailure, "clear failure cannot report success")
        journal.failClear = false
        _ = await restarted.recover(context: context, mayReplay: false) { true }
        check(restarted.finishRead(context: context) && journal.pending == nil, "committed read recovery closes only pending row")
        journal.pending = .init(operationId: try JSONDecoder().decode(TrainingPlanRefreshRequest.self, from: firstBytes).operationId,
            route: "training-command", payload: firstBytes, preparedAt: clock)
        queryStatus = "notFound"; queryHTTP = 404; lostReply = false
        _ = await restarted.recover(context: context, mayReplay: true) { true }
        check(posts.count == 1 && journal.pending != nil, "HTTP 404 is not business notFound and never replays")
        queryHTTP = 200
        _ = await restarted.recover(context: context, mayReplay: true) { true }
        check(posts.count == 2 && posts.last == firstBytes, "explicit notFound replays original UUID and exact Data bytes")
        queryStatus = "committed"; journal.failAcknowledgement = true
        _ = await restarted.recover(context: context, mayReplay: false) { true }
        check(restarted.phase == .storageFailure && restarted.executionBlocked && journal.pending != nil, "acknowledgement failure preserves recoverable intent")
        journal.failAcknowledgement = false
        queryStatus = "future-status"
        _ = await restarted.recover(context: context, mayReplay: true) { true }
        check(posts.count == 2 && journal.pending != nil, "unknown status never replays or clears intent")
        queryStatus = "scopeMismatch"
        _ = await restarted.recover(context: context, mayReplay: true) { true }
        check(journal.pending == nil && posts.count == 2, "terminal scope mismatch closes only this pending row")
        _ = await restarted.refresh(revision: 2, context: context) { true }
        check(paths.last == "/v1/mobile/training-plan/commands/refresh", "refresh has its own endpoint without candidate")
        check(restarted.finishRead(context: context), "fixture: close the acknowledged refresh before testing a rejected new command")
        policyChanged = true
        check(await restarted.makePreview(draft, context: context) { true }, "policy rejection still follows an explicit preview")
        check(await restarted.confirm(context: context) { true } == nil && journal.pending == nil && restarted.phase == .needsPreview &&
              restarted.message?.contains("确认当前规则版本") == true,
              "policy-change rejection closes only the rejected intent and tells the user to accept the rules rather than repeat previews")
        check(!paths.contains("/v1/mobile/goals") && !paths.contains("/v1/mobile/run-coach"), "zero retired URL requests")
        // B05: session commands share the durable journal, with their own wire
        // contract, instance binding and independent capability.
        var sessionPosts: [Data] = []
        var sessionQueryHTTP = 200
        var sessionQueryStatus = "committed"
        var sessionLostReply = false
        var sessionMissing = false
        let sessionDraft = TrainingPlanSessionDraft.move(sessionId: "session", sessionRevision: 1, localDate: "2026-10-29")
        let sessionRequest = TrainingPlanSessionPreviewRequest(operationScope: identity, expectedStateRevision: 2,
            planInstanceId: "instance", draft: sessionDraft)
        let sessionPreviewObject: [String: Any] = ["contractVersion": 1, "operationScope": ["serverId": "server", "athleteId": "athlete", "datasetEpoch": "epoch"],
            "expectedStateRevision": 2, "planInstanceId": "instance", "candidateId": "signed-session-candidate", "inputKey": "facts-input",
            "expiresAt": "2026-10-23T04:02:00.000Z", "impact": ["before": NSNull(), "after": NSNull(), "suppressions": [],
                "affectedDates": ["2026-10-29"], "deviceWithdrawalRequired": true, "warnings": []]]
        let sessionPreviewData = try JSONSerialization.data(withJSONObject: sessionPreviewObject)
        func sessionResult(_ id: String) -> Data {
            Data("{\"contractVersion\":1,\"operationId\":\"\(id)\",\"stateRevision\":4,\"goalsRevision\":18,\"planInstanceId\":\"instance\",\"warnings\":[]}".utf8)
        }
        let sessionJournal = CommandJournal()
        CommandProtocol.handler = { request in
            let path = request.url!.path
            if path.hasSuffix("/preview") {
                check(path == "/v1/mobile/training-plan/session-commands/preview" && request.httpMethod == "POST" &&
                      request.value(forHTTPHeaderField: "X-RAI-Client-Training-Session-Commands") == "1", "session preview uses its own exact negotiated route")
                return (200, sessionPreviewData)
            }
            if path.contains("/plan-operations/") {
                if sessionQueryHTTP != 200 { return (sessionQueryHTTP, Data("{\"code\":\"route_missing\",\"message\":\"upgrade\"}".utf8)) }
                let id = path.components(separatedBy: "/").last!
                return (200, Data("{\"status\":\"\(sessionQueryStatus)\",\"operationId\":\"\(id)\"\(sessionQueryStatus == "committed" ? ",\"result\":" + String(data: sessionResult(id), encoding: .utf8)! : "")}".utf8))
            }
            check(path == "/v1/mobile/training-plan/session-commands" && request.httpMethod == "POST" &&
                  request.value(forHTTPHeaderField: "X-RAI-Client-Training-Session-Commands") == "1", "session submit never uses configuration or retired routes")
            let data: Data
            if let body = request.httpBody { data = body }
            else { let stream = request.httpBodyStream!; stream.open(); defer { stream.close() }
                var bytes = [UInt8](repeating: 0, count: 8192); var value = Data()
                while stream.hasBytesAvailable { let count = stream.read(&bytes, maxLength: bytes.count); if count <= 0 { break }; value.append(contentsOf: bytes[0..<count]) }; data = value }
            sessionPosts.append(data)
            let body = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
            check(body["contractVersion"] as? Int == 1 && body["planInstanceId"] as? String == "instance", "session contract and instance survive durable encoding")
            if sessionMissing { return (404, Data("{\"code\":\"training_session_not_found\",\"message\":\"当前课程已不存在，请重读。\"}".utf8)) }
            if sessionLostReply { return (503, Data("{\"code\":\"lost_reply\",\"message\":\"query\"}".utf8)) }
            return (200, sessionResult(body["operationId"] as! String))
        }
        let sessionPublisher = TrainingPlanPublisher(api: api, persistence: sessionJournal, now: { clock })
        check(await sessionPublisher.makeSessionPreview(sessionRequest, context: context) { true }, "session preview accepted")
        sessionPublisher.cancelPreview()
        check(await sessionPublisher.confirmSession(context: context) { true } == nil && sessionJournal.pending == nil, "closed session preview cannot submit")
        check(await sessionPublisher.makeSessionPreview(sessionRequest, context: context) { true }, "new session preview accepted")
        sessionJournal.failIntent = true
        check(await sessionPublisher.confirmSession(context: context) { true } == nil && sessionPosts.isEmpty, "session intent failure sends zero HTTP")
        sessionJournal.failIntent = false
        check(await sessionPublisher.makeSessionPreview(sessionRequest, context: context) { true }, "session draft retry after storage repair")
        sessionLostReply = true
        check(await sessionPublisher.confirmSession(context: context) { true } == nil && sessionJournal.pending != nil, "session unknown response keeps original journal")
        let originalSessionBytes = sessionJournal.pending!.payload
        let sessionRestart = TrainingPlanPublisher(api: api, persistence: sessionJournal, now: { clock })
        sessionQueryHTTP = 404
        _ = await sessionRestart.recover(context: context, mayReplay: true) { true }
        check(sessionPosts.count == 1 && sessionJournal.pending?.payload == originalSessionBytes, "session HTTP 404 is not business notFound")
        sessionQueryHTTP = 200; sessionQueryStatus = "notFound"; sessionLostReply = false
        check(await sessionRestart.recover(context: context, mayReplay: true) { true } != nil && sessionPosts.count == 2 &&
              sessionPosts[1] == originalSessionBytes, "session restart replays original UUID and exact bytes only after business notFound")
        check(sessionJournal.watermark?.stateRevision == 4 && sessionRestart.executionBlocked, "session save persists separate state/goals floors before re-read")
        check(sessionRestart.finishRead(context: context) && sessionJournal.pending == nil, "session read completion closes journal")
        sessionJournal.pending = .init(operationId: (try JSONDecoder().decode(TrainingPlanRefreshRequest.self, from: originalSessionBytes)).operationId,
            route: "training-session", payload: originalSessionBytes, preparedAt: clock)
        sessionQueryStatus = "committed"
        check(await sessionRestart.recover(context: context, mayReplay: false) { true } != nil && sessionPosts.count == 2,
              "session committed query works with independent write capability disabled")
        check(sessionRestart.finishRead(context: context), "close the previous known result before testing entity rejection")
        sessionMissing = true
        check(await sessionRestart.makeSessionPreview(sessionRequest, context: context) { true }, "preview precedes a competing session deletion")
        check(await sessionRestart.confirmSession(context: context) { true } == nil && sessionJournal.pending == nil &&
              sessionRestart.phase == .needsPreview && sessionRestart.message?.contains("当前课程已不存在") == true,
              "known session-not-found 404 is a rejected business command, not a missing route or unknown operation")
        let patch = TrainingPlanSessionPatch(reason: nil, updatesReason: true)
        let patchObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as! [String: Any]
        check(patchObject["reason"] is NSNull && patchObject["structure"] == nil, "session explicit clear differs from omission")
        let day = MobilePlannedDay(localDate: "2026-10-29", kind: "easy", distanceKm: 8,
            structure: .init(warmup: nil, blocks: [.init(iterations: 1, steps: [.init(purpose: "work", goal: .distance(meters: 8000), alert: nil)])], cooldown: nil), reason: nil)
        let addObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(TrainingPlanSessionDraft.add(day))) as! [String: Any]
        let prescribed = addObject["prescription"] as! [String: Any], structured = prescribed["structure"] as! [String: Any]
        let block = (structured["blocks"] as! [[String: Any]])[0], step = (block["steps"] as! [[String: Any]])[0]
        check(structured["warmup"] is NSNull && structured["cooldown"] is NSNull && step["alert"] is NSNull && prescribed["reason"] is NSNull,
              "session structure sends canonical null fields rather than lossy optional encoding")
        print("TrainingPlanPublisher regression passed")
    }
}
