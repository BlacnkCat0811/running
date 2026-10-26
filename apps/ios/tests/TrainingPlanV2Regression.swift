import Foundation

/// PR5：v2 统一训练读合同 + 训练页单一状态。
///
/// 这里只编纯逻辑（APIModels + APIClient + PlanStatePolicy + UserDataNoticePolicy），
/// 不碰 UI、不碰缓存、不发网络请求。判据覆盖三件"改错了照样编译通过"的事：
/// 1. `X-RAI-Training-Contract: 2` 的协商常量与 409/503 分类（未知合同版本必须
///    是可识别的升级状态，而不是一条普通服务端错误）；
/// 2. 接受一份 v2 快照前的身份/业务日/窗口/版本下限校验；
/// 3. 页面状态派生：休息、比赛日、需刷新、待配置、已结束、不可判定各自独立，
///    未知合同版本**绝不能**显示成休息。
/// 只在这支回归里使用的 URLProtocol 替身：钉住"请求真的带上了协商头"
/// 与"409/503 真的被分类成合同错误"，而不是只测分类函数本身。
final class V2ContractProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (URLRequest) -> (Int, String) = { _ in (503, "{}") }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let (status, body) = Self.handler(request)
        guard let response = HTTPURLResponse(
            url: url, statusCode: status, httpVersion: nil, headerFields: nil) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct TrainingPlanV2Regression {
    static func main() async throws {
        let now = ISO8601DateFormatter().date(from: "2026-10-20T04:00:00Z")!
        let identity = PlanReceiptScope(serverId: "server", athleteId: "athlete", datasetEpoch: "epoch")
        var count = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            count += 1
            print("PASS: \(name)")
        }
        func snapshot(
            contractVersion: Int = 2,
            businessDate: String = "2026-10-20",
            mode: String = "coach",
            modeReason: String = "no_race_goal",
            daysToRace: Int? = nil,
            runState: String = "active",
            admission: String = "ready",
            sourceStatus: String = "active",
            current: Bool = true,
            days: [MobilePlannedDay] = [],
            raceGoal: TrainingPlanStateResponseV2.RaceGoal? = nil,
            permitted: Bool = false,
            reasonCodes: [String] = ["projection_only", "facts_freshness_not_evaluated",
                                     "device_coordination_not_evaluated"],
            goalsRevision: Int? = 12,
            currentGoalsRevision: Int = 12,
            scope: PlanReceiptScope = identity
        ) -> TrainingPlanStateResponseV2 {
            .init(
                contractVersion: contractVersion,
                scope: scope,
                businessDate: businessDate,
                stateRevision: 3,
                migratedAt: "2026-10-20T00:00:00Z",
                migration: .init(version: 1, source: "legacy_goals",
                                 sourceStatus: sourceStatus, sourceDigest: String(repeating: "a", count: 64)),
                mode: mode,
                modeReason: modeReason,
                daysToRace: daysToRace,
                runState: runState,
                admission: admission,
                raceGoal: raceGoal,
                plan: .init(goalsRevision: goalsRevision, currentGoalsRevision: currentGoalsRevision,
                            current: current, days: days, lockedToday: false),
                execution: .init(permitted: permitted, reasonCodes: reasonCodes)
            )
        }
        func day(_ date: String, _ kind: String, km: Double = 5) -> MobilePlannedDay {
            .init(localDate: date, kind: kind, distanceKm: km, structure: nil, reason: nil)
        }
        func updateView(contractVersion: Int = 1,
                        factsStatus: String = "stored",
                        analysisStatus: String = "ready",
                        associationStatus: String = "current",
                        planStatus: String = "pending",
                        desired: String? = "desired-key",
                        published: String? = nil,
                        evaluatedKey: String? = nil,
                        evaluatedRevision: Int? = nil,
                        reasonCodes: [String] = []) -> TrainingPlanUpdateView {
            .init(contractVersion: contractVersion,
                  facts: .init(status: factsStatus, identity: "facts-1"),
                  analysis: .init(status: analysisStatus, identity: "analysis-1"),
                  association: .init(status: associationStatus, identity: "execution-1"),
                  plan: .init(status: planStatus, desiredInputKey: desired,
                              publishedInputKey: published, evaluatedInputKey: evaluatedKey,
                              evaluatedStateRevision: evaluatedRevision, reasonCodes: reasonCodes))
        }

        // MARK: 协商常量 / 线格式解码

        check(RaiTrainingPlanContract.headerField == "X-RAI-Training-Contract",
              "the contract header has one spelling")
        check(RaiTrainingPlanContract.version == 2 && RaiTrainingPlanContract.requestedVersion == "2",
              "the client requests exactly contract 2 (no version picker, no v1 downgrade)")

        // PR-05：两个 facts/analysis 能力位是**不同的键**；iOS 本版只镜像
        // `factsAnalysisViewContractVersion`、明确不消费两块视图，老服务端缺位
        // 必须解成 nil（不能伪造“有视图但为空”）。
        let handshakeJSON = """
        {"serverId":"server","athleteId":"athlete","datasetEpoch":"epoch",
         "syncProtocolVersion":1,"apiVersion":"v1",
         "factsAnalysisContractVersion":1,"factsAnalysisViewContractVersion":1}
        """
        let handshake = try JSONDecoder().decode(RaiHandshake.self, from: Data(handshakeJSON.utf8))
        check(handshake.factsAnalysisContractVersion == 1 && handshake.factsAnalysisViewContractVersion == 1,
              "the receipt and view capabilities decode as separate keys")
        let legacyHandshakeJSON = """
        {"serverId":"server","athleteId":"athlete","datasetEpoch":"epoch",
         "syncProtocolVersion":1,"apiVersion":"v1"}
        """
        let legacyHandshake = try JSONDecoder().decode(RaiHandshake.self, from: Data(legacyHandshakeJSON.utf8))
        check(legacyHandshake.legacyPlanWritesSupported && !legacyHandshake.trainingPlanV2CommandsSupported,
              "an explicitly negotiated legacy protocol does not imply v2 writes")
        for (read, write, publication, allowed) in [
            (2, 2, 1, true), (2, 999, 1, false), (999, 2, 1, false),
            (2, 2, 999, false), (2, 0, 1, false)
        ] {
            var capabilities = legacyHandshake
            capabilities.trainingPlanContractVersion = read
            capabilities.trainingPlanCommandContractVersion = write
            capabilities.planPublicationContractVersion = publication
            check(capabilities.trainingPlanV2CommandsSupported == allowed && !capabilities.legacyPlanWritesSupported,
                  "exact read/write/publication versions negotiate independently; v2 never authorizes legacy")
        }
        var missingDurability = legacyHandshake
        missingDurability.trainingPlanContractVersion = 2
        missingDurability.trainingPlanCommandContractVersion = 2
        check(!missingDurability.trainingPlanV2CommandsSupported && !missingDurability.legacyPlanWritesSupported,
              "v2 commands require the durable operation capability")
        check(legacyHandshake.factsAnalysisContractVersion == nil && legacyHandshake.factsAnalysisViewContractVersion == nil,
              "an old server's missing capability keys decode as nil, never as a zero/empty view")

        // B01 protocol freeze: same synthetic matrix as the Node contract tests.
        // New routes/storage/UI remain deferred; these gates do not grant execution.
        let sharedURL = URL(fileURLWithPath: "apps/ios/tests/fixtures/training-plan-closed-loop.json")
        let shared = try JSONSerialization.jsonObject(with: Data(contentsOf: sharedURL)) as! [String: Any]
        let capabilityCases = shared["capabilities"] as! [[String: Any]]
        check(capabilityCases.count == 22, "the complete B01 capability matrix is loaded")
        for row in capabilityCases {
            let payload = try JSONSerialization.data(withJSONObject: row["handshake"]!)
            let value = try JSONDecoder().decode(RaiHandshake.self, from: payload)
            let expected = row["expected"] as! [String: Bool]
            let name = row["name"] as! String
            check(value.trainingPlanSessionsSupported == expected["sessions"] &&
                  value.trainingPlanSessionCommandsSupported == expected["sessionCommands"] &&
                  value.trainingPlanExecutionCommandsSupported == expected["executionCommands"] &&
                  value.trainingPlanUpdatesSupported == expected["updates"], "B01 exact capabilities: \(name)")
            check(value.legacyPlanWritesSupported == (row["legacyWrites"] as! Bool),
                  "B01 capabilities never authorize retired URLs: \(name)")
        }
        for row in shared["projections"] as! [[String: Any]] where row["rejected"] as! Bool == false {
            let payload = try JSONSerialization.data(withJSONObject: row["wire"]!)
            let before = try JSONDecoder().decode(TrainingPlanStateResponseV2.self, from: payload)
            var extended = row["wire"] as! [String: Any]
            extended["sessions"] = shared["sessions"]
            let withExtension = try JSONSerialization.data(withJSONObject: extended)
            let after = try JSONDecoder().decode(TrainingPlanStateResponseV2.self, from: withExtension)
            check(before.plan == after.plan && before.scope == after.scope && !after.execution.permitted && after.sessions != nil,
                  "B02 optional extension retains identities without altering the existing projection: \(row["name"]!)")
        }

        let v2JSON = """
        {
          "contractVersion": 2,
          "scope": {"serverId": "server", "athleteId": "athlete", "datasetEpoch": "epoch"},
          "businessDate": "2026-10-20",
          "stateRevision": 9,
          "migratedAt": "2026-10-20T00:00:00.000Z",
          "migration": {"version": 1, "source": "legacy_goals", "sourceStatus": "active",
                        "sourceDigest": "\(String(repeating: "a", count: 64))"},
          "mode": "race", "modeReason": "race_goal_upcoming", "daysToRace": 47,
          "runState": "active", "admission": "ready",
          "raceGoal": {"id": "goal-1", "date": "2026-12-06", "distanceKm": 10, "goal": "time",
                       "targetTimeSeconds": 3000,
                       "support": {"distance": "ten_k", "support": "standard",
                                   "horizon": "within_horizon", "preparation": "ready",
                                   "weeksToRace": 7, "daysToRace": 47, "reasonCodes": []}},
          "plan": {"goalsRevision": 12, "currentGoalsRevision": 12, "current": true, "lockedToday": false,
                   "days": [{"localDate": "2026-10-21", "kind": "tempo", "distanceKm": 8,
                             "structure": null, "reason": "quality"}]},
          "execution": {"permitted": false,
                        "reasonCodes": ["projection_only", "facts_freshness_not_evaluated",
                                        "device_coordination_not_evaluated"]}
        }
        """
        // 真实请求路径：协商头 + 200 解码 + 409/503 分类。
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [V2ContractProtocol.self]
        let api = RaiAPIClient(session: URLSession(configuration: configuration))
        guard let base = URL(string: "https://training-contract.invalid") else {
            preconditionFailure("test base URL must be a valid URL")
        }
        var observedHeader: String?
        var observedPath: String?
        var observedMethod: String?
        var observedBody: Data?
        V2ContractProtocol.handler = { request in
            observedHeader = request.value(forHTTPHeaderField: RaiTrainingPlanContract.headerField)
            observedPath = request.url?.path
            observedMethod = request.httpMethod
            observedBody = request.httpBody
            return (200, v2JSON)
        }
        let live = try await api.trainingPlanStateV2(baseURL: base, token: "test-token")
        check(live.contractVersion == 2 && live.mode == "race",
              "the v2 read call decodes the unified payload from the wire")
        check(observedHeader == "2" && observedPath == "/v1/mobile/training-plan-state",
              "the training-plan read always requests contract 2 on its own path")
        check(observedMethod == "GET" && observedBody == nil,
              "the negotiated unified read sends GET with no mutation body")
        func contractFailure(_ status: Int, _ body: String) async -> RaiTrainingPlanContractError? {
            V2ContractProtocol.handler = { _ in (status, body) }
            do {
                _ = try await api.trainingPlanStateV2(baseURL: base, token: "test-token")
                return nil
            } catch {
                return error as? RaiTrainingPlanContractError
            }
        }
        let unsupported = await contractFailure(409, #"{"code":"training_contract_unsupported","message":"x"}"#)
        check(unsupported == .contractUnsupported,
              "409 training_contract_unsupported surfaces as a typed upgrade state")
        let unmigrated = await contractFailure(409, #"{"code":"training_plan_not_migrated","message":"m"}"#)
        check(unmigrated == .notMigrated,
              "409 training_plan_not_migrated surfaces as a typed migration state")
        let unavailable = await contractFailure(503, #"{"code":"training_plan_state_unavailable","message":"u"}"#)
        check(unavailable == .unavailable(code: "training_plan_state_unavailable"),
              "503 training_plan_state_unavailable surfaces as a typed retryable state")
        let missingRoute = await contractFailure(404, "{}")
        check(missingRoute == .contractUnsupported,
              "a 404 from an old server surfaces as an upgrade state, not rest")
        let unrelated = await contractFailure(500, #"{"code":"http_500","message":"boom"}"#)
        check(unrelated == nil, "an unrelated 500 is not misreported as a contract problem")
        print("Training plan v2 wire negotiation: 6 checks passed")

        let decoded = try JSONDecoder().decode(TrainingPlanStateResponseV2.self, from: Data(v2JSON.utf8))
        check(decoded.contractVersion == 2 && decoded.scope == identity && decoded.stateRevision == 9,
              "the v2 payload decodes with its identity and revision")
        check(decoded.mode == "race" && decoded.modeReason == "race_goal_upcoming" && decoded.daysToRace == 47,
              "mode, reason and days-to-race survive decoding")
        check(decoded.raceGoal?.support.distance == "ten_k" && decoded.raceGoal?.targetTimeSeconds == 3000,
              "the race goal carries distance support and target time")
        check(decoded.plan.current && decoded.plan.days.count == 1 && decoded.plan.days[0].kind == "tempo",
              "the published weekly intention decodes as stored intent")
        check(decoded.execution.permitted == false,
              "the read projection carries no execution grant")
        check(decoded.intent(on: "2026-10-21")?.localDate == "2026-10-21" && decoded.intent(on: "2026-10-20") == nil,
              "a missing day is an absent intent, never an implied rest")
        check((try? JSONDecoder().decode(TrainingPlanStateResponseV2.self, from: Data("{}".utf8))) == nil,
              "an empty/legacy payload cannot decode as the v2 contract (no silent fallback)")

        // F03 的载荷字段是可选的：老服务端没有它们，新服务端带它们。
        let legacyWeekRow = """
        {"localDate":"2026-10-18","kind":"rest","title":"休息","planned":true,
         "completedWorkoutId":null,"distanceKm":0,"workoutCount":0,"structure":null}
        """
        let partialRow = try JSONDecoder().decode(MobileWeekPlanDay.self, from: Data(legacyWeekRow.utf8))
        check(partialRow.observation == nil && partialRow.intentKind == nil,
              "week rows cached before F03 still decode (optional intent/observation)")
        let plannedRowJSON = """
        {"localDate":"2026-10-18","kind":"interval","title":"原计划间歇／尚无训练观测","planned":true,
         "completedWorkoutId":null,"distanceKm":9,"workoutCount":0,"structure":null,
         "intentKind":"interval","observation":"unknown"}
        """
        let plannedRow = try JSONDecoder().decode(MobileWeekPlanDay.self, from: Data(plannedRowJSON.utf8))
        check(plannedRow.intentKind == "interval" && plannedRow.observation == "unknown",
              "a past planned-but-unobserved row keeps its intent and unknown observation")

        // MARK: 合同拒绝分类

        check(RaiTrainingPlanContractError.classification(serverCode: "training_contract_unsupported", status: 409)
              == .contractUnsupported, "an unsupported contract version is a typed upgrade state")
        check(RaiTrainingPlanContractError.classification(serverCode: "training_plan_not_migrated", status: 409)
              == .notMigrated, "an unmigrated scope is a typed migration state")
        check(RaiTrainingPlanContractError.classification(serverCode: "training_plan_state_unavailable", status: 503)
              == .unavailable(code: "training_plan_state_unavailable"),
              "an unreadable unified store is a retryable unavailable state")
        check(RaiTrainingPlanContractError.classification(serverCode: nil, status: 404) == .contractUnsupported,
              "an old server without the route is an upgrade state, not a generic failure")
        check(RaiTrainingPlanContractError.classification(serverCode: "http_500", status: 500) == nil,
              "unrelated server failures are not misreported as contract problems")
        check(RaiTrainingPlanContractError.classification(serverCode: nil, status: 0) == nil,
              "a transport failure is not misreported as a contract problem")

        // MARK: 接受前的校验

        let valid = snapshot(days: [day("2026-10-21", "tempo")])
        do {
            try TrainingPlanUnifiedPolicy.validate(valid, identity: identity, minimumGoalsRevision: 12, now: now)
            check(true, "a coherent v2 snapshot is accepted")
        } catch {
            check(false, "a coherent v2 snapshot must be accepted: \(error)")
        }
        do {
            try TrainingPlanUnifiedPolicy.validate(valid, identity: nil, minimumGoalsRevision: 12, now: now)
            check(false, "a snapshot without a known identity must be rejected")
        } catch {
            check((error as? TrainingPlanUnifiedValidationError) == .identityMismatch,
                  "a snapshot without a known identity fails the identity check")
        }
        let foreignScope = snapshot(scope: PlanReceiptScope(serverId: "server", athleteId: "other", datasetEpoch: "epoch"))
        do {
            try TrainingPlanUnifiedPolicy.validate(foreignScope, identity: identity, minimumGoalsRevision: 12, now: now)
            check(false, "a snapshot from another athlete must be rejected")
        } catch {
            check((error as? TrainingPlanUnifiedValidationError) == .identityMismatch,
                  "a snapshot from another athlete is rejected before display")
        }
        do {
            try TrainingPlanUnifiedPolicy.validate(snapshot(contractVersion: 3), identity: identity,
                                                   minimumGoalsRevision: 12, now: now)
            check(false, "a newer contract version must be rejected")
        } catch {
            check((error as? TrainingPlanUnifiedValidationError) == .unsupportedContractVersion(3),
                  "a newer contract version is an explicit upgrade state")
        }
        do {
            try TrainingPlanUnifiedPolicy.validate(snapshot(currentGoalsRevision: 11), identity: identity,
                                                   minimumGoalsRevision: 12, now: now)
            check(false, "a snapshot below the acknowledged revision floor must be rejected")
        } catch {
            check((error as? TrainingPlanUnifiedValidationError) == .staleGoalsRevision(reported: 11, floor: 12),
                  "the write-confirmation revision floor cannot be lowered by a read")
        }
        do {
            try TrainingPlanUnifiedPolicy.validate(snapshot(businessDate: "2026-10-19"), identity: identity,
                                                   minimumGoalsRevision: 12, now: now)
            check(false, "yesterday's business date must be rejected")
        } catch {
            check((error as? TrainingPlanUnifiedValidationError) == .invalidBusinessDate("2026-10-19"),
                  "a snapshot from another business date fails closed")
        }
        do {
            try TrainingPlanUnifiedPolicy.validate(snapshot(days: [day("2026-10-19", "easy")]), identity: identity,
                                                   minimumGoalsRevision: 12, now: now)
            check(false, "a day before the business date must be rejected")
        } catch {
            check((error as? TrainingPlanUnifiedValidationError) != nil,
                  "a day outside the business-date window fails closed")
        }
        do {
            try TrainingPlanUnifiedPolicy.validate(
                snapshot(days: [day("2026-10-21", "easy"), day("2026-10-21", "tempo")]),
                identity: identity, minimumGoalsRevision: 12, now: now)
            check(false, "duplicate dates must be rejected")
        } catch {
            check((error as? TrainingPlanUnifiedValidationError) != nil,
                  "duplicate published days fail closed")
        }
        do {
            try TrainingPlanUnifiedPolicy.validate(
                snapshot(mode: "race", modeReason: "race_day", daysToRace: nil),
                identity: identity, minimumGoalsRevision: 12, now: now)
            check(false, "race mode without a days-to-race must be rejected")
        } catch {
            check((error as? TrainingPlanUnifiedValidationError) != nil,
                  "race mode without its race facts fails closed")
        }

        let raceSupport = TrainingPlanStateResponseV2.RaceGoalSupport(
            distance: "ten_k", support: "standard", horizon: "within_horizon",
            preparation: "ready", weeksToRace: 7, daysToRace: 0, reasonCodes: [])
        let raceGoal = TrainingPlanStateResponseV2.RaceGoal(
            id: "goal-1", date: "2026-10-20", distanceKm: 10, goal: "finish",
            targetTimeSeconds: nil, support: raceSupport)

        // MARK: 页面状态派生

        func view(_ snapshot: TrainingPlanStateResponseV2?,
                  issue: PlanReadIssue? = nil,
                  refreshing: Bool = false,
                  referenceOnly: Bool = false,
                  devicePending: Bool = false) -> TrainingPlanUnifiedView {
            TrainingPlanUnifiedPolicy.view(snapshot: snapshot, issue: issue, isRefreshing: refreshing,
                                           isReferenceOnly: referenceOnly,
                                           deviceCoordinationPending: devicePending, now: now)
        }
        let upgrade = view(nil, issue: PlanReadIssue(code: .upgradeRequired, message: "upgrade"))
        check(upgrade.phase == .upgradeRequired && !upgrade.isRest,
              "an unknown contract version shows an upgrade state, never rest")
        let notMigrated = view(nil, issue: PlanReadIssue(code: .notMigrated, message: "migrate"))
        check(notMigrated.phase == .notMigrated && !notMigrated.isRest,
              "an unmigrated scope shows a migration state, never rest")
        let offline = view(nil, issue: PlanReadIssue(code: .offline, message: "offline"))
        check(offline.phase == .unavailable("offline") && !offline.isRest,
              "a failed read is unavailable, never rest")
        check(view(nil, refreshing: true).phase == .loading,
              "a read in flight is loading, not an empty plan")
        let notAssessable = view(snapshot(mode: "future_mode"))
        if case .notAssessable = notAssessable.phase {
            check(!notAssessable.isRest, "an unknown mode is not assessable and never rest")
        } else {
            check(false, "an unknown mode must be explicitly not-assessable")
        }

        let coachDay = view(snapshot(days: [day("2026-10-20", "easy")]))
        check(coachDay.phase == .ready && coachDay.mode == "coach" && coachDay.runState == "active",
              "a configured coach plan is ready with its mode and run state")
        check(!coachDay.isRest && coachDay.todayIntent?.kind == "easy" && !coachDay.executionGranted,
              "a published session is not rest and the projection grants no execution")
        let restDay = view(snapshot(days: [day("2026-10-20", "rest")]))
        check(restDay.isRest && restDay.phase == .ready,
              "only an explicitly prescribed rest day is rendered as rest")
        let noIntent = view(snapshot())
        check(noIntent.phase == .ready && !noIntent.isRest && noIntent.todayIntent == nil,
              "a missing today intention is unknown, not a rest day")
        let raceDay = view(snapshot(mode: "race", modeReason: "race_day", daysToRace: 0,
                                    days: [day("2026-10-20", "race")], raceGoal: raceGoal))
        check(raceDay.isRaceDay && raceDay.phase == .ready && !raceDay.isRest,
              "a race-day plan is distinguished from rest")
        let needsConfig = view(snapshot(admission: "needs_configuration"))
        check(needsConfig.phase == .needsConfiguration,
              "an incomplete configuration is its own state")
        let ended = view(snapshot(runState: "paused", admission: "needs_confirmation", sourceStatus: "ended"))
        check(ended.phase == .needsConfirmation && ended.runState == "paused",
              "an ended programme needs confirmation and never reports active")
        let stale = view(snapshot(current: false))
        check(stale.phase == .refreshRequired,
              "a snapshot whose goals moved after migration is refresh-required")
        let reference = view(snapshot(), referenceOnly: true)
        check(reference.phase == .refreshRequired && reference.isReferenceOnly,
              "a cached snapshot is reference-only, never current")
        let pending = view(snapshot(), devicePending: true)
        check(pending.factsPending && pending.deviceCoordinationPending,
              "facts freshness and device coordination stay distinguishable")
        let contractViolation = view(snapshot(permitted: true))
        check(!contractViolation.executionGranted && contractViolation.contractViolation != nil,
              "a projection that wrongly carries an execution grant is ignored and flagged")

        // MARK: F03 渲染侧

        func weekRow(_ date: String, kind: String, intent: String?, observation: String?,
                     completed: String? = nil, planned: Bool = true) -> MobileWeekPlanDay {
            .init(localDate: date, kind: kind, title: "", planned: planned, completedWorkoutId: completed,
                  distanceKm: 0, workoutCount: 0, structure: nil, intentKind: intent, observation: observation)
        }
        let observedRow = weekRow("2026-10-17", kind: "completed", intent: "interval",
                                  observation: "observed", completed: "w-1")
        let plannedUnobservedRow = weekRow("2026-10-18", kind: "interval", intent: "interval",
                                           observation: "unknown")
        let neverPlannedRow = weekRow("2026-10-19", kind: "rest", intent: nil,
                                      observation: "unknown", planned: false)
        let rows = TrainingPlanUnifiedPolicy.weekReview(
            from: [observedRow, plannedUnobservedRow, neverPlannedRow], businessDate: "2026-10-20")
        check(rows.count == 3 && rows[0].detail == "已导入训练" && !rows[0].detail.contains("休息"),
              "an observed past day reports an imported workout")
        check(rows[1].displayKind == "interval" && rows[1].detail.contains("尚无训练观测"),
              "a past planned interval with no observation keeps its intent and says observation is missing")
        check(rows[2].displayKind == "rest" && rows[2].detail.contains("未排课"),
              "a past day that was never planned says so instead of asserting a rest")
        check(!rows[1].detail.contains("休息") && !rows[1].displayKind.contains("rest"),
              "planned-but-unobserved is never rendered as rest")
        let legacyWritten = TrainingPlanUnifiedPolicy.weekReview(
            from: [weekRow("2026-10-18", kind: "rest", intent: nil, observation: nil)], businessDate: "2026-10-20")
        check(legacyWritten.first?.detail == "该服务端未提供观测状态",
              "a payload without observation says the field is absent instead of claiming rest")
        check(TrainingPlanUnifiedPolicy.observationNote(observedRow) == "已导入训练",
              "an observed day's note says the workout was imported")
        check(TrainingPlanUnifiedPolicy.observationNote(plannedUnobservedRow)?
            .contains("尚无训练观测") == true,
            "single-day note distinguishes planned-but-unobserved")
        check(TrainingPlanUnifiedPolicy.observationNote(neverPlannedRow) == "未排课",
            "single-day note distinguishes never-planned")

        // B02 stable identity fixture is shared with the real TypeScript reader.
        let identitiesURL = URL(fileURLWithPath: "apps/ios/tests/fixtures/training-plan-sessions-v2.json")
        let identitiesFixture = try JSONSerialization.jsonObject(with: Data(contentsOf: identitiesURL)) as! [String: Any]
        let identitiesWire = identitiesFixture["wire"] as! [String: Any]
        let identitiesData = try JSONSerialization.data(withJSONObject: identitiesWire)
        let identitiesSnapshot = try JSONDecoder().decode(TrainingPlanStateResponseV2.self, from: identitiesData)
        let identitiesScope = PlanReceiptScope(serverId: "synthetic-server", athleteId: "synthetic-athlete", datasetEpoch: "synthetic-epoch")
        let identitiesNow = ISO8601DateFormatter().date(from: "2026-10-25T04:00:00Z")!
        do {
            try TrainingPlanUnifiedPolicy.validate(identitiesSnapshot, identity: identitiesScope,
                                                   minimumGoalsRevision: 7, now: identitiesNow,
                                                   updateNegotiated: true)
            check(true, "B02 legitimate identity view passes validation (including an absent update = unknown)")
        } catch {
            check(false, "B02 legitimate identity view must pass validation: \(error)")
        }
        let roundTrip = try JSONDecoder().decode(TrainingPlanStateResponseV2.self, from: JSONEncoder().encode(identitiesSnapshot))
        check(roundTrip == identitiesSnapshot && roundTrip.sessions?.sessions.first?.sessionRevision == 3,
              "B02 identity, revision, override, protection, suppression and units survive Codable round-trip")
        check(roundTrip.sessions?.sessions.first?.userOverride?.prescription.distanceKm == 10 &&
              roundTrip.sessions?.sessions.first?.sessionId == "synthetic-stable-session" &&
              roundTrip.sessions?.suppressions.count == 2 && !roundTrip.execution.permitted,
              "B02 moved and edited intent keeps one stable ID and grants no execution")
        V2ContractProtocol.handler = { request in
            precondition(request.httpMethod == "GET" && request.httpBody == nil && request.url?.path == "/v1/mobile/training-plan-state")
            precondition(request.value(forHTTPHeaderField: "X-RAI-Training-Contract") == "2" &&
                         request.value(forHTTPHeaderField: "X-RAI-Training-Sessions") == "1")
            return (200, String(decoding: identitiesData, as: UTF8.self))
        }
        let identitiesLive = try await api.trainingPlanStateV2(baseURL: base, token: "test-token", sessionEntities: true)
        check(identitiesLive.sessions == identitiesSnapshot.sessions, "B02 actual transport requests exactly the optional session read extension")

        // B08 update extension: present only after exact negotiation, bound to the
        // same session view/instance, and its evaluated watermark cannot exceed the
        // snapshot it claims to describe.
        var validUpdateSnapshot = identitiesSnapshot
        validUpdateSnapshot.update = updateView(planStatus: "current", desired: "current-key",
            published: "current-key", evaluatedKey: "current-key", evaluatedRevision: 7)
        do {
            try TrainingPlanUnifiedPolicy.validate(validUpdateSnapshot, identity: identitiesScope,
                minimumGoalsRevision: 7, now: identitiesNow, updateNegotiated: true)
            check(true, "B08 a negotiated update view with matching published/evaluated keys is accepted")
        } catch {
            check(false, "B08 a valid negotiated update view must be accepted: \(error)")
        }
        var unnegotiated = identitiesSnapshot
        unnegotiated.update = updateView()
        do {
            try TrainingPlanUnifiedPolicy.validate(unnegotiated, identity: identitiesScope,
                minimumGoalsRevision: 7, now: identitiesNow)
            check(false, "B08 an update view without negotiation must be rejected")
        } catch let error as TrainingPlanUnifiedValidationError {
            check(error == .unexpectedUpdateExtension,
                  "B08 an unnegotiated update view fails closed instead of being ignored")
        } catch { check(false, "B08 unnegotiated update failed with the wrong error: \(error)") }
        var noSessions = snapshot(days: [])
        noSessions.update = updateView()
        do {
            try TrainingPlanUnifiedPolicy.validate(noSessions, identity: identity,
                minimumGoalsRevision: 12, now: now, updateNegotiated: true)
            check(false, "B08 an update view without the session view must be rejected")
        } catch let error as TrainingPlanUnifiedValidationError {
            check(error == .updateRequiresSessions,
                  "B08 an update view cannot be attributed without the exact session view")
        } catch { check(false, "B08 missing session view failed with the wrong error: \(error)") }
        var futureUpdate = identitiesSnapshot
        futureUpdate.update = updateView(contractVersion: 2)
        do {
            try TrainingPlanUnifiedPolicy.validate(futureUpdate, identity: identitiesScope,
                minimumGoalsRevision: 7, now: identitiesNow, updateNegotiated: true)
            check(false, "B08 an unknown update contract version must be rejected")
        } catch let error as TrainingPlanUnifiedValidationError {
            check(error == .unknownValue(field: "update.contractVersion", value: "2"),
                  "B08 update contractVersion is checked independently of the handshake")
        } catch { check(false, "B08 update version failed with the wrong error: \(error)") }
        var futureWatermark = identitiesSnapshot
        futureWatermark.update = updateView(evaluatedKey: "evaluated-key", evaluatedRevision: 8)
        do {
            try TrainingPlanUnifiedPolicy.validate(futureWatermark, identity: identitiesScope,
                minimumGoalsRevision: 7, now: identitiesNow, updateNegotiated: true)
            check(false, "B08 evaluatedStateRevision beyond stateRevision must be rejected")
        } catch let error as TrainingPlanUnifiedValidationError {
            check(error == .invalidUpdate("evaluatedStateRevision 8 超过 stateRevision 7"),
                  "B08 evaluatedStateRevision cannot exceed the snapshot state revision")
        } catch { check(false, "B08 future evaluated watermark failed with the wrong error: \(error)") }
        var missingEvaluatedKey = identitiesSnapshot
        missingEvaluatedKey.update = updateView(evaluatedRevision: 7)
        do {
            try TrainingPlanUnifiedPolicy.validate(missingEvaluatedKey, identity: identitiesScope,
                minimumGoalsRevision: 7, now: identitiesNow, updateNegotiated: true)
            check(false, "B08 evaluatedStateRevision without its key must be rejected")
        } catch let error as TrainingPlanUnifiedValidationError {
            check(error == .invalidUpdate("evaluatedStateRevision 缺少 evaluatedInputKey"),
                  "B08 evaluated revision and evaluated key must be present together")
        } catch { check(false, "B08 evaluated key mismatch failed with the wrong error: \(error)") }
        var falseCurrent = identitiesSnapshot
        falseCurrent.update = updateView(planStatus: "current", desired: "desired-key",
            published: "other-published", evaluatedKey: "other-evaluated", evaluatedRevision: 7)
        do {
            try TrainingPlanUnifiedPolicy.validate(falseCurrent, identity: identitiesScope,
                minimumGoalsRevision: 7, now: identitiesNow, updateNegotiated: true)
            check(false, "B08 status=current with neither published nor evaluated input key must be rejected")
        } catch let error as TrainingPlanUnifiedValidationError {
            check(error == .invalidUpdate("status=current 但 published/evaluated 输入键都不是当前输入"),
                  "B08 plan.current is only accepted with a matching published or evaluated input key")
        } catch { check(false, "B08 false-current update failed with the wrong error: \(error)") }
        var badStage = identitiesSnapshot
        badStage.update = updateView(factsStatus: "unknown")
        do {
            try TrainingPlanUnifiedPolicy.validate(badStage, identity: identitiesScope,
                minimumGoalsRevision: 7, now: identitiesNow, updateNegotiated: true)
            check(false, "B08 unknown update stage status must be rejected")
        } catch let error as TrainingPlanUnifiedValidationError {
            check(error == .invalidUpdate("facts.status 未知"),
                  "B08 update stage values are a closed set, not free strings")
        } catch { check(false, "B08 unknown stage failed with the wrong error: \(error)") }
        let expectedErrors: [String: TrainingPlanUnifiedValidationError] = [
            "unknown_version": .unknownValue(field: "sessions.contractVersion", value: "99"),
            "duplicate": .invalidDays("课程身份、修订或状态不可信"),
            "foreign_instance": .invalidDays("课程身份、修订或状态不可信"),
            "unknown_lifecycle": .invalidDays("课程身份、修订或状态不可信"),
            "unknown_protection": .invalidDays("课程身份、修订或状态不可信"),
            "lost_owner": .invalidDays("已发布意图没有稳定课程身份"),
            "bad_override": .invalidDays("用户覆盖与有效处方不一致"),
            "unknown_reference": .invalidDays("课程日期抑制不可信")
        ]
        for variant in expectedErrors.keys.sorted() {
            var wire = identitiesWire
            var extensionValue = wire["sessions"] as! [String: Any]
            var sessions = extensionValue["sessions"] as! [[String: Any]]
            switch variant {
            case "unknown_version": extensionValue["contractVersion"] = 99
            case "duplicate": sessions.append(sessions[0])
            case "foreign_instance": sessions[0]["planInstanceId"] = "other"
            case "unknown_lifecycle": sessions[0]["lifecycle"] = "scheduled_is_completed"
            case "unknown_protection": sessions[0]["protection"] = "future_value"
            case "lost_owner": sessions = []
            case "bad_override": sessions[0]["protection"] = "automatic"
            default:
                var suppressions = extensionValue["suppressions"] as! [[String: Any]]
                suppressions[0]["sessionId"] = "other-session"
                extensionValue["suppressions"] = suppressions
            }
            extensionValue["sessions"] = sessions; wire["sessions"] = extensionValue
            let changed = try JSONDecoder().decode(TrainingPlanStateResponseV2.self, from: JSONSerialization.data(withJSONObject: wire))
            do {
                try TrainingPlanUnifiedPolicy.validate(changed, identity: identitiesScope, minimumGoalsRevision: 7, now: identitiesNow)
                check(false, "B02 corrupt identity view must be rejected: \(variant)")
            } catch let error as TrainingPlanUnifiedValidationError {
                check(error == expectedErrors[variant],
                      "B02 identity validation rejects \(variant) with the expected error \(String(describing: error))")
            } catch {
                check(false, "B02 identity validation failed with the wrong error type for \(variant): \(error)")
            }
        }
        check(RaiTrainingPlanContractError.classification(serverCode: "training_session_contract_unsupported", status: 409) == .contractUnsupported,
              "B02 unsupported session extension is an upgrade state and never a legacy fallback")
        // B07 replaces the B02 refusal with a compatible optional decoder: a
        // present execution view must be preserved, not thrown away. Absence is
        // still distinguishable from an explicit empty history.
        var executionsWire = identitiesWire
        var executionsExtension = executionsWire["sessions"] as! [String: Any]
        executionsExtension["executions"] = [["sessionId": "synthetic-stable-session", "executionRevision": 1,
            "association": "unlinked", "trainingSessionId": NSNull(), "sourceFactDigest": NSNull(),
            "prescriptionSessionRevision": 3, "assessment": NSNull(),
            "availableAt": "2026-10-25T02:00:00.000Z", "reasonCodes": []]]
        executionsWire["sessions"] = executionsExtension
        let withExecutions = try JSONDecoder().decode(TrainingPlanStateResponseV2.self,
            from: JSONSerialization.data(withJSONObject: executionsWire))
        check(withExecutions.sessions?.executions?.count == 1 &&
              withExecutions.sessions?.executions?.first?.association == "unlinked" &&
              withExecutions.sessions?.executions?.first?.trainingSessionId == nil,
              "B07 optional executions decode compatibly and keep unknown-vs-unlinked identity")
        let roundTrippedExecutions = try JSONDecoder().decode(TrainingPlanStateResponseV2.self,
            from: JSONEncoder().encode(withExecutions))
        check(roundTrippedExecutions.sessions?.executions == withExecutions.sessions?.executions,
              "B07 execution rows survive the real cache Codable round-trip")
        var absentExecutionsWire = identitiesWire
        var absentExtension = absentExecutionsWire["sessions"] as! [String: Any]
        absentExtension.removeValue(forKey: "executions"); absentExecutionsWire["sessions"] = absentExtension
        let absentExecutions = try JSONDecoder().decode(TrainingPlanStateResponseV2.self,
            from: JSONSerialization.data(withJSONObject: absentExecutionsWire))
        check(absentExecutions.sessions?.executions == nil,
              "B07 absent executions remain unknown, never an empty history")
        print("Training plan v2 contract regression: \(count) checks passed")
    }
}
