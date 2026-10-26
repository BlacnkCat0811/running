import Foundation

/// B07 pure-logic regression: execution DTOs, association presentation,
/// candidate eligibility, snapshot watermarks and the shared durable journal.
final class ExecutionProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (URLRequest) -> (Int, Data) = { _ in (503, Data()) }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, data) = Self.handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor final class ExecutionJournal: TrainingPlanCommandPersistence {
    var pending: PendingPlanPublication?
    var watermark: TrainingPlanCommandWatermark?
    var failIntent = false
    func pendingPublication(scope: String) -> CacheReadResult<PendingPlanPublication?> { .value(pending) }
    func savePublication(_ value: PendingPlanPublication?, scope: String) -> Bool {
        if failIntent && value != nil { return false }
        pending = value
        return true
    }
    func trainingPlanCommandWatermark(scope: String) -> CacheReadResult<TrainingPlanCommandWatermark> {
        watermark.map { .value($0) } ?? .notFound
    }
    func saveTrainingPlanCommandWatermark(_ value: TrainingPlanCommandWatermark, scope: String) -> Bool {
        watermark = value
        return true
    }
}

@main struct TrainingPlanExecutionRegression {
    @MainActor static func main() async throws {
        var count = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            count += 1
            print("PASS: \(name)")
        }
        let identity = PlanReceiptScope(serverId: "server", athleteId: "athlete", datasetEpoch: "epoch")
        let fixtureURL = URL(fileURLWithPath: "apps/ios/tests/fixtures/training-plan-closed-loop.json")
        let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as! [String: Any]
        let sameDayRuns = fixture["sameDayRuns"] as! [[String: Any]]

        // MARK: - DTO decoding / encoding

        func candidateJSON(_ value: [String: Any]) -> [String: Any] {
            ["trainingSessionId": value["trainingSessionId"]!, "sourceFactDigest": value["sourceFactDigest"]!,
             "startedAt": value["startedAt"]!, "endedAt": value["endedAt"]!,
             "distanceMeters": value["distanceMeters"]!, "durationSeconds": value["durationSeconds"]!,
             "evidence": value["evidence"]!]
        }
        func candidateResponse(contractVersion: Int = 1, stateRevision: Int = 7,
                               planInstanceId: String = "plan", sessionId: String = "session",
                               sessionRevision: Int = 3, executionRevision: Int = 2,
                               candidates: [[String: Any]]? = nil,
                               nextCursor: Any = NSNull(),
                               rangeStart: String = "2026-10-26", rangeEnd: String = "2026-10-30") -> TrainingPlanExecutionCandidatesResponse {
            let rows = candidates ?? sameDayRuns.map(candidateJSON)
            let object: [String: Any] = ["contractVersion": contractVersion,
                "scope": ["serverId": "server", "athleteId": "athlete", "datasetEpoch": "epoch"],
                "stateRevision": stateRevision, "planInstanceId": planInstanceId, "sessionId": sessionId,
                "sessionRevision": sessionRevision, "executionRevision": executionRevision,
                "rangeStart": rangeStart, "rangeEnd": rangeEnd, "candidates": rows, "nextCursor": nextCursor]
            return try! JSONDecoder().decode(TrainingPlanExecutionCandidatesResponse.self,
                from: JSONSerialization.data(withJSONObject: object))
        }
        let decodedPage = candidateResponse(nextCursor: "cursor-2")
        check(decodedPage.contractVersion == 1 && decodedPage.scope == identity && decodedPage.stateRevision == 7,
              "execution candidates decode with contract, scope and state revision")
        check(decodedPage.candidates.count == 2 && decodedPage.candidates[0].trainingSessionId == "synthetic-run-1" &&
              decodedPage.candidates[0].distanceMeters == 8200 && decodedPage.candidates[0].durationSeconds == 3000 &&
              decodedPage.candidates[0].evidence == "needs_confirmation" && decodedPage.nextCursor == "cursor-2",
              "same-day candidates preserve identity, actual metrics and paging cursor")
        check(TrainingPlanExecutionPolicy.validate(decodedPage, identity: identity, planInstanceId: "plan",
            sessionId: "session", sessionRevision: 3, executionRevision: 2, expectedStateRevision: 7) == nil,
            "a candidate page bound to the current session/instance/revisions is accepted")
        check(TrainingPlanExecutionPolicy.validate(candidateResponse(contractVersion: 2), identity: identity,
            planInstanceId: "plan", sessionId: "session", sessionRevision: 3, executionRevision: 2,
            expectedStateRevision: 7) != nil, "an unknown candidate contract version is rejected")
        check(TrainingPlanExecutionPolicy.validate(candidateResponse(planInstanceId: "other"), identity: identity,
            planInstanceId: "plan", sessionId: "session", sessionRevision: 3, executionRevision: 2,
            expectedStateRevision: 7) != nil, "candidates from another plan instance are rejected")
        check(TrainingPlanExecutionPolicy.validate(candidateResponse(sessionId: "other"), identity: identity,
            planInstanceId: "plan", sessionId: "session", sessionRevision: 3, executionRevision: 2,
            expectedStateRevision: 7) != nil, "candidates for another session are rejected")
        check(TrainingPlanExecutionPolicy.validate(candidateResponse(sessionRevision: 4), identity: identity,
            planInstanceId: "plan", sessionId: "session", sessionRevision: 3, executionRevision: 2,
            expectedStateRevision: 7) != nil, "a changed session revision invalidates the candidate page")
        var duplicate = sameDayRuns.map(candidateJSON)
        duplicate[1]["trainingSessionId"] = duplicate[0]["trainingSessionId"]!
        check(TrainingPlanExecutionPolicy.validate(candidateResponse(candidates: duplicate), identity: identity,
            planInstanceId: "plan", sessionId: "session", sessionRevision: 3, executionRevision: 2,
            expectedStateRevision: 7) != nil, "duplicate same-day candidates are rejected rather than merged")
        var badEvidence = sameDayRuns.map(candidateJSON)
        badEvidence[0]["evidence"] = "auto_confirmed"
        check(TrainingPlanExecutionPolicy.validate(candidateResponse(candidates: badEvidence), identity: identity,
            planInstanceId: "plan", sessionId: "session", sessionRevision: 3, executionRevision: 2,
            expectedStateRevision: 7) != nil, "unknown candidate evidence cannot become an automatic confirmation")

        let assessmentJSON: [String: Any] = ["version": "assessment-v1", "policyStatus": "candidate",
            "localDate": "2026-10-28", "asOf": "2026-10-28T02:00:00.000Z", "planRevision": 3,
            "prescriptionDigest": NSNull(), "workoutIds": ["synthetic-run-1"],
            "association": ["status": "matched", "method": "measured_steps_with_plan", "evidenceRefs": []],
            "observation": "observed", "evidenceLevel": "measured_steps",
            "dose": ["status": "partial", "basis": "work_steps", "requiredDistanceMeters": 8000,
                     "observedDistanceMeters": 6200, "requiredWorkSeconds": NSNull(),
                     "observedWorkSeconds": NSNull(), "requiredReps": NSNull(), "verifiedReps": NSNull()],
            "stimulus": ["status": "not_assessable", "channel": NSNull(),
                         "validCoverageFraction": NSNull(), "timeInTargetFraction": NSNull()],
            "completion": "known_not_met",
            "reasons": [["code": "dose_short", "policyVersion": "v1", "evidenceRefs": [],
                         "affectedDates": ["2026-10-28"], "params": ["missingMeters": 1800]]]]
        let executionJSON: [String: Any] = ["sessionId": "synthetic-session", "executionRevision": 2,
            "association": "confirmed", "trainingSessionId": "synthetic-run-1",
            "sourceFactDigest": sameDayRuns[0]["sourceFactDigest"]!, "prescriptionSessionRevision": 1,
            "assessment": assessmentJSON, "availableAt": "2026-10-28T02:10:00.000Z",
            "reasonCodes": ["training_execution_source_changed"]]
        var sessionsObject = fixture["sessions"] as! [String: Any]
        sessionsObject["executions"] = [executionJSON]
        let sessionView = try JSONDecoder().decode(TrainingPlanSessionsView.self,
            from: JSONSerialization.data(withJSONObject: sessionsObject))
        let decodedExecution = try XCTUnwrap(sessionView.executions?.first)
        check(decodedExecution.association == "confirmed" && decodedExecution.trainingSessionId == "synthetic-run-1" &&
              decodedExecution.executionRevision == 2 && decodedExecution.reasonCodes == ["training_execution_source_changed"],
              "optional executions decode without losing association identity or reasons")
        check(decodedExecution.assessment?.dose.status == "partial" &&
              decodedExecution.assessment?.dose.observedDistanceMeters == 6200 &&
              decodedExecution.assessment?.stimulus.status == "not_assessable" &&
              decodedExecution.assessment?.reasons.first?.params["missingMeters"] == .number(1800),
              "assessment keeps partial dose, unknown stimulus and nested reason params")
        var absentObject = fixture["sessions"] as! [String: Any]
        absentObject.removeValue(forKey: "executions")
        let absentView = try JSONDecoder().decode(TrainingPlanSessionsView.self,
            from: JSONSerialization.data(withJSONObject: absentObject))
        check(absentView.executions == nil, "absent executions decode as unknown, not an empty history")
        var emptyObject = fixture["sessions"] as! [String: Any]
        emptyObject["executions"] = []
        let emptyView = try JSONDecoder().decode(TrainingPlanSessionsView.self,
            from: JSONSerialization.data(withJSONObject: emptyObject))
        check(emptyView.executions == [], "an explicit empty executions array stays distinguishable from absence")
        let roundTripView = try JSONDecoder().decode(TrainingPlanSessionsView.self,
            from: JSONEncoder().encode(sessionView))
        check(roundTripView == sessionView, "executions, assessment and reason params survive Codable round-trip")

        let confirmRequest = TrainingPlanExecutionCommandRequest(operationId: "op-1", operationScope: identity,
            expectedStateRevision: 7, planInstanceId: "plan", sessionId: "session", sessionRevision: 3,
            executionRevision: 2, draft: .confirm(trainingSessionId: "run-1", sourceFactDigest: "digest"))
        let confirmObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(confirmRequest)) as! [String: Any]
        let confirmDraft = confirmObject["draft"] as! [String: Any]
        check(confirmObject["contractVersion"] as? Int == 1 && confirmObject["operationId"] as? String == "op-1" &&
              confirmObject["planInstanceId"] as? String == "plan" && confirmObject["sessionId"] as? String == "session" &&
              confirmObject["executionRevision"] as? Int == 2 && confirmDraft["action"] as? String == "confirm" &&
              confirmDraft["trainingSessionId"] as? String == "run-1" && confirmDraft["sourceFactDigest"] as? String == "digest" &&
              confirmDraft["sessionId"] == nil && confirmDraft["sessionRevision"] == nil,
              "execution command encodes the exact frozen draft shape (no duplicated session revision)")
        let skipObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            TrainingPlanExecutionCommandRequest(operationId: "op-2", operationScope: identity, expectedStateRevision: 7,
                planInstanceId: "plan", sessionId: "session", sessionRevision: 3, executionRevision: 0,
                draft: .skip(reason: "受伤休息")))) as! [String: Any]
        let skipDraft = skipObject["draft"] as! [String: Any]
        check(skipDraft["action"] as? String == "skip" && skipDraft["reason"] as? String == "受伤休息" &&
              skipDraft["trainingSessionId"] == nil && skipDraft["sourceFactDigest"] == nil,
              "an explicit skip carries only its required reason")
        let responseObject: [String: Any] = ["contractVersion": 1, "operationId": "op-1", "stateRevision": 8,
            "goalsRevision": NSNull(), "planInstanceId": "plan", "outcome": "changed", "session": NSNull(),
            "execution": executionJSON, "planUpdate": "pending", "warnings": ["计划尚未重评"]]
        let commandResponse = try JSONDecoder().decode(TrainingPlanClosedLoopCommandResponse.self,
            from: JSONSerialization.data(withJSONObject: responseObject))
        check(commandResponse.goalsRevision == nil && commandResponse.outcome == "changed" &&
              commandResponse.planUpdate == "pending" && commandResponse.execution?.sessionId == "synthetic-session",
              "execution command response decodes a null goals revision and separate plan-update state")
        check(commandResponse.warnings == ["计划尚未重评"], "execution warnings survive decoding")

        // MARK: - Capability matrix

        func handshake(_ mutate: (inout RaiHandshake) -> Void) -> RaiHandshake {
            var value = RaiHandshake(serverId: "server", athleteId: "athlete", datasetEpoch: "epoch",
                syncProtocolVersion: 1, apiVersion: "v1")
            value.trainingPlanContractVersion = 2
            value.trainingPlanSessionContractVersion = 1
            value.planPublicationContractVersion = 1
            value.trainingPlanExecutionCommandContractVersion = 1
            mutate(&value)
            return value
        }
        check(handshake { _ in }.trainingPlanExecutionCommandsSupported,
              "execution commands require sessions + publication + exactly execution contract 1")
        check(!handshake { $0.trainingPlanExecutionCommandContractVersion = nil }.trainingPlanExecutionCommandsSupported,
              "a missing execution contract closes the capability")
        check(!handshake { $0.trainingPlanExecutionCommandContractVersion = 2 }.trainingPlanExecutionCommandsSupported,
              "an unknown execution contract closes the capability")
        check(!handshake { $0.planPublicationContractVersion = nil }.trainingPlanExecutionCommandsSupported,
              "execution commands require durable publication")
        check(!handshake { $0.trainingPlanSessionContractVersion = nil }.trainingPlanExecutionCommandsSupported,
              "execution commands require the sessions read contract")

        // MARK: - Association / assessment presentation

        func session(lifecycle: String = "pending", date: String = "2026-10-28", id: String = "session") -> TrainingPlanSessionsView.Session {
            .init(planInstanceId: "plan", sessionId: id, sessionRevision: 3,
                prescription: .init(localDate: date, kind: "easy", distanceKm: 8, structure: nil, reason: nil),
                recommendation: nil, userOverride: nil, protection: "automatic", lifecycle: lifecycle,
                availableAt: "2026-10-25T02:00:00.000Z", supersededBySessionId: nil)
        }
        func assessment(observation: String = "observed", dose: String = "partial",
                        stimulus: String = "not_assessable", completion: String = "known_not_met",
                        distance: Double? = 6200) -> WorkoutExecutionAssessment {
            .init(version: "assessment-v1", policyStatus: "candidate", localDate: "2026-10-28",
                asOf: "2026-10-28T02:00:00.000Z", planRevision: 3, prescriptionDigest: nil,
                workoutIds: ["synthetic-run-1"], association: .init(status: "matched",
                    method: "measured_steps_with_plan", evidenceRefs: []), observation: observation,
                evidenceLevel: "measured_steps", dose: .init(status: dose, basis: "work_steps",
                    requiredDistanceMeters: 8000, observedDistanceMeters: distance, requiredWorkSeconds: nil,
                    observedWorkSeconds: nil, requiredReps: nil, verifiedReps: nil),
                stimulus: .init(status: stimulus, channel: nil, validCoverageFraction: nil,
                    timeInTargetFraction: nil), completion: completion, reasons: [])
        }
        func execution(association: String, lifecycle: String = "pending",
                       assessment: WorkoutExecutionAssessment? = nil,
                       id: String = "session") -> TrainingPlanSessionExecution {
            .init(sessionId: id, executionRevision: 2, association: association,
                trainingSessionId: ["confirmed", "invalidated"].contains(association) ? "synthetic-run-1" : nil,
                sourceFactDigest: ["confirmed", "invalidated"].contains(association) ? String(repeating: "a", count: 64) : nil,
                prescriptionSessionRevision: 3, assessment: assessment,
                availableAt: "2026-10-28T02:10:00.000Z", reasonCodes: [])
        }
        let invalidExecution = TrainingPlanSessionExecution(sessionId: "session", executionRevision: 2,
            association: "confirmed", trainingSessionId: nil, sourceFactDigest: nil,
            prescriptionSessionRevision: 3, assessment: nil,
            availableAt: "2026-10-28T02:10:00.000Z", reasonCodes: [])
        check(TrainingPlanExecutionPolicy.validate(execution: invalidExecution, session: session()) != nil,
              "a confirmed execution row without an actual-training identity is rejected")
        let unknownView = TrainingPlanExecutionPolicy.review(session: session(lifecycle: "completed"),
            execution: nil, executionsKnown: false)
        check(unknownView.statusTitle == "执行视图未知" && unknownView.statusDetail.contains("不能据此判断已完成或未完成") &&
              !unknownView.claimsCompletion, "a missing execution view is unknown, never incomplete")
        let unlinkedView = TrainingPlanExecutionPolicy.review(session: session(), execution: nil, executionsKnown: true)
        check(unlinkedView.statusTitle == "尚未关联实际训练" && unlinkedView.statusDetail.contains("不等于课程未完成") &&
              !unlinkedView.claimsCompletion && unlinkedView.doseText.contains("未知"),
              "an absent row is not an incomplete course and not an empty history")
        let pendingView = TrainingPlanExecutionPolicy.review(session: session(),
            execution: execution(association: "pending_confirmation"), executionsKnown: true)
        check(pendingView.statusTitle == "待确认实际训练" && pendingView.statusDetail.contains("确认前不宣称完成") &&
              !pendingView.claimsCompletion, "pending confirmation is neither completed nor incomplete")
        let partialView = TrainingPlanExecutionPolicy.review(session: session(lifecycle: "completed"),
            execution: execution(association: "confirmed", lifecycle: "completed",
                assessment: assessment(dose: "partial", stimulus: "not_assessable")), executionsKnown: true)
        check(partialView.claimsCompletion && partialView.doseText.contains("不足（partial") &&
              partialView.stimulusText.contains("无法评估") && partialView.completionText.contains("明确未达标"),
              "partial dose and unknown stimulus stay separate while a confirmed completion is claimed")
        let unknownDoseView = TrainingPlanExecutionPolicy.review(session: session(lifecycle: "completed"),
            execution: execution(association: "confirmed", lifecycle: "completed",
                assessment: assessment(dose: "not_assessable", stimulus: "not_assessable")), executionsKnown: true)
        check(unknownDoseView.doseText.contains("无法评估（证据不足，不是未完成）") &&
              !unknownDoseView.doseText.contains("未达标"),
              "unknown dose is not rendered as a missed or partial dose")
        let noAssessmentView = TrainingPlanExecutionPolicy.review(session: session(lifecycle: "completed"),
            execution: execution(association: "confirmed", lifecycle: "completed", assessment: nil), executionsKnown: true)
        check(noAssessmentView.doseText.contains("尚未评估") && noAssessmentView.completionText.contains("尚未评估") &&
              noAssessmentView.claimsCompletion, "a confirmed link without assessment is unknown, not incomplete")
        let tooHardView = TrainingPlanExecutionPolicy.review(session: session(lifecycle: "completed"),
            execution: execution(association: "confirmed", lifecycle: "completed",
                assessment: assessment(dose: "met", stimulus: "too_hard", completion: "confirmed")), executionsKnown: true)
        check(tooHardView.stimulusText.contains("偏强") && tooHardView.doseText == "剂量：达标",
              "stimulus too hard is independent from dose")
        let inconsistentView = TrainingPlanExecutionPolicy.review(session: session(lifecycle: "completed"),
            execution: execution(association: "pending_confirmation"), executionsKnown: true)
        check(!inconsistentView.claimsCompletion && inconsistentView.statusDetail.contains("不宣称完成"),
              "completed lifecycle without a confirmed link never becomes a completion claim")
        let invalidatedView = TrainingPlanExecutionPolicy.review(session: session(lifecycle: "completed"),
            execution: execution(association: "invalidated"), executionsKnown: true)
        check(invalidatedView.statusTitle == "关联已失效" && !invalidatedView.claimsCompletion &&
              invalidatedView.reasonTexts.isEmpty, "an invalidated association keeps history but withdraws the current completion")

        check(TrainingPlanExecutionPolicy.permitsNewExecution(runState: "active", sourceStatus: "active"),
              "EXEC-01: active plan permits new execution")
        for status in ["paused", "ended"] {
            check(!TrainingPlanExecutionPolicy.permitsNewExecution(runState: "paused", sourceStatus: status),
                  "EXEC-01: stopped plan prohibits Confirm/Correct/Skip")
            check(TrainingPlanExecutionPolicy.canRetract(execution(association: "confirmed")),
                  "EXEC-01: historical Retract remains available without new authorization")
        }
        // MARK: - Candidate selection / eligibility

        check(TrainingPlanExecutionPolicy.preferredCandidateSelection(decodedPage.candidates) == nil,
              "multiple same-day candidates are never preselected for automatic confirmation")
        check(TrainingPlanExecutionPolicy.preferredCandidateSelection([decodedPage.candidates[0]]) == "synthetic-run-1",
              "a single candidate may be highlighted but still requires an explicit command")
        check(TrainingPlanExecutionPolicy.candidateActionTitle(association: "confirmed", session: session()) == "改选为这条" &&
              TrainingPlanExecutionPolicy.candidateActionTitle(association: "invalidated", session: session()) == "重新关联为这条" &&
              TrainingPlanExecutionPolicy.candidateActionTitle(association: "unlinked", session: session()) == "确认关联",
              "candidate action copy distinguishes confirm, correct and re-link")
        check(TrainingPlanExecutionPolicy.canSkip(session: session(), execution: nil, hasCandidates: false),
              "a pending course with no candidate may be explicitly skipped")
        check(!TrainingPlanExecutionPolicy.canSkip(session: session(), execution: nil, hasCandidates: nil),
              "an unread candidate page disables skip instead of pretending there are no runs")
        check(!TrainingPlanExecutionPolicy.canSkip(session: session(), execution: nil, hasCandidates: true),
              "an executed candidate blocks skip even before confirmation")
        check(!TrainingPlanExecutionPolicy.canSkip(session: session(lifecycle: "completed"), execution: nil, hasCandidates: false),
              "a completed course cannot be skipped")
        check(!TrainingPlanExecutionPolicy.canSkip(session: session(),
            execution: execution(association: "pending_confirmation"), hasCandidates: false),
              "a pending-confirmation link cannot be overwritten by skip")
        check(TrainingPlanExecutionPolicy.canRetract(execution(association: "confirmed")) &&
              !TrainingPlanExecutionPolicy.canRetract(nil) &&
              !TrainingPlanExecutionPolicy.canRetract(execution(association: "pending_confirmation")),
              "retract is available only for a persisted link")
        let expanded = TrainingPlanExecutionPolicy.expandedRange(sessionDate: "2026-10-28")
        check(expanded?.start == "2026-10-13" && expanded?.end == "2026-11-12",
              "the widened candidate window is the 31-day maximum around the course date")
        check(TrainingPlanExecutionPolicy.acceptsSnapshot(incomingStateRevision: 5, incomingPlanInstanceId: "plan",
            existingStateRevision: 5, existingPlanInstanceId: "plan") &&
              !TrainingPlanExecutionPolicy.acceptsSnapshot(incomingStateRevision: 4, incomingPlanInstanceId: "plan",
            existingStateRevision: 5, existingPlanInstanceId: "plan") &&
              TrainingPlanExecutionPolicy.acceptsSnapshot(incomingStateRevision: 6, incomingPlanInstanceId: "new-plan",
            existingStateRevision: 5, existingPlanInstanceId: "plan") &&
              !TrainingPlanExecutionPolicy.acceptsSnapshot(incomingStateRevision: 5, incomingPlanInstanceId: "new-plan",
            existingStateRevision: 5, existingPlanInstanceId: "plan"),
              "an old GET cannot roll back state revision or swap a plan instance at the same revision")
        check(!TrainingPlanExecutionPolicy.acceptsSnapshot(incomingStateRevision: 4, incomingPlanInstanceId: nil,
            existingStateRevision: 5, existingPlanInstanceId: "plan") &&
              TrainingPlanExecutionPolicy.acceptsSnapshot(incomingStateRevision: 5, incomingPlanInstanceId: nil,
            existingStateRevision: 5, existingPlanInstanceId: "plan") &&
              !TrainingPlanExecutionPolicy.acceptsSnapshot(incomingStateRevision: 4, incomingPlanInstanceId: nil,
            existingStateRevision: 5, existingPlanInstanceId: nil) &&
              TrainingPlanExecutionPolicy.acceptsSnapshot(incomingStateRevision: 5, incomingPlanInstanceId: nil,
            existingStateRevision: 5, existingPlanInstanceId: nil) &&
              !TrainingPlanExecutionPolicy.acceptsSnapshot(incomingStateRevision: 5, incomingPlanInstanceId: "plan",
            existingStateRevision: 5, existingPlanInstanceId: nil) &&
              TrainingPlanExecutionPolicy.acceptsSnapshot(incomingStateRevision: 6, incomingPlanInstanceId: "plan",
            existingStateRevision: 5, existingPlanInstanceId: nil),
              "an identity-less old server cannot overwrite a newer snapshot; a first identity-bearing snapshot needs a strictly newer revision")
        let stalePage = TrainingPlanExecutionPolicy.candidatePageMismatch(candidateResponse(stateRevision: 6),
            planInstanceId: "plan", sessionId: "session", sessionRevision: 3,
            executionRevision: 2, stateRevision: 7)
        check(stalePage?.contains("计划状态已变化") == true &&
              TrainingPlanExecutionPolicy.candidatePageMismatch(candidateResponse(),
                planInstanceId: "plan", sessionId: "session", sessionRevision: 3,
                executionRevision: 2, stateRevision: 7) == nil &&
              TrainingPlanExecutionPolicy.candidatePageMismatch(candidateResponse(sessionRevision: 4),
                planInstanceId: "plan", sessionId: "session", sessionRevision: 3,
                executionRevision: 2, stateRevision: 7)?.contains("课程修订") == true &&
              TrainingPlanExecutionPolicy.candidatePageMismatch(candidateResponse(executionRevision: 3),
                planInstanceId: "plan", sessionId: "session", sessionRevision: 3,
                executionRevision: 2, stateRevision: 7)?.contains("执行修订") == true,
              "skip/confirm candidates must match the current state, session and execution revisions")
        check(TrainingPlanExecutionPolicy.actionFailureMessage("confirm").contains("未能保存关联") &&
              TrainingPlanExecutionPolicy.actionFailureMessage("retract").contains("未能撤回关联") &&
              TrainingPlanExecutionPolicy.actionFailureMessage("skip").contains("未能跳过课程"),
              "failed confirm/retract/skip actions always have user-visible copy")
        check(TrainingPlanExecutionPolicy.serverErrorMessage("training_execution_source_changed")?.contains("源训练记录已变化") == true &&
              TrainingPlanExecutionPolicy.serverErrorMessage("training_execution_link_conflict")?.contains("已关联其他课程") == true &&
              TrainingPlanExecutionPolicy.serverErrorMessage("training_execution_revision_conflict")?.contains("执行修订已变化") == true &&
              TrainingPlanExecutionPolicy.serverErrorMessage("unknown_code") == nil,
              "source-change and link-conflict errors have readable Chinese copy")
        check(TrainingPlanExecutionPolicy.reasonTexts(["execution_retracted", "execution_source_changed"])
                == ["已撤回关联", "源训练已更正"],
              "retracted and corrected execution reason codes have Chinese mappings")
        check(TrainingPlanExecutionPolicy.durationText(3_725) == "1小时2分" &&
              TrainingPlanExecutionPolicy.durationText(59) == "59秒" &&
              TrainingPlanExecutionPolicy.durationText(0) == "0秒",
              "normal durations keep their existing readable format")
        check(TrainingPlanExecutionPolicy.durationText(-1) == "未知" &&
              TrainingPlanExecutionPolicy.durationText(.infinity) == "未知" &&
              TrainingPlanExecutionPolicy.durationText(.nan) == "未知" &&
              TrainingPlanExecutionPolicy.durationText(1e300) == "超过 7 天" &&
              TrainingPlanExecutionPolicy.durationText(Double.greatestFiniteMagnitude) == "超过 7 天",
              "an arbitrary finite Double never traps Int(value.rounded())")
        let listSessions = [
            session(lifecycle: "completed", date: "2026-10-26", id: "done"),
            session(lifecycle: "cancelled", date: "2026-10-29", id: "cancelled"),
            session(lifecycle: "pending", date: "2026-10-27", id: "past"),
            session(lifecycle: "pending", date: "2026-10-28", id: "today"),
            TrainingPlanSessionsView.Session(planInstanceId: "plan", sessionId: "old", sessionRevision: 1,
                prescription: .init(localDate: "2026-10-25", kind: "easy", distanceKm: 5, structure: nil, reason: nil),
                recommendation: nil, userOverride: nil, protection: "automatic", lifecycle: "pending",
                availableAt: "2026-10-25T02:00:00.000Z", supersededBySessionId: "today")
        ]
        let visible = TrainingPlanExecutionPolicy.visibleSessions(listSessions)
        check(visible.map(\.sessionId) == ["done", "past", "today", "cancelled"],
              "finished and past sessions stay visible (only superseded identities are hidden), sorted by date")
        check(TrainingPlanExecutionPolicy.sessionListState(session: listSessions[0], businessDate: "2026-10-28").isReadOnly &&
              TrainingPlanExecutionPolicy.sessionListState(session: listSessions[1], businessDate: "2026-10-28").isReadOnly &&
              TrainingPlanExecutionPolicy.sessionListState(session: listSessions[2], businessDate: "2026-10-28").isReadOnly &&
              !TrainingPlanExecutionPolicy.sessionListState(session: listSessions[3], businessDate: "2026-10-28").isReadOnly,
              "completed/cancelled/past rows are read-only while today's pending row remains editable")
        check(TrainingPlanExecutionPolicy.sessionListState(session: listSessions[0], businessDate: "2026-10-28")
                .caption.contains("查看记录") &&
              !TrainingPlanExecutionPolicy.sessionListState(session: listSessions[0], businessDate: "2026-10-28")
                .caption.contains("调整") &&
              TrainingPlanExecutionPolicy.sessionListState(session: listSessions[2], businessDate: "2026-10-28")
                .caption.contains("过去课程") &&
              TrainingPlanExecutionPolicy.sessionListState(session: listSessions[3], businessDate: "2026-10-28")
                .caption.contains("点按查看"),
              "read-only rows say 查看记录 and never promise 调整; an editable automatic row stays a view action")
        let protectedToday = TrainingPlanSessionsView.Session(planInstanceId: "plan", sessionId: "protected",
            sessionRevision: 1,
            prescription: .init(localDate: "2026-10-28", kind: "easy", distanceKm: 5, structure: nil, reason: nil),
            recommendation: nil, userOverride: nil, protection: "user_protected", lifecycle: "pending",
            availableAt: "2026-10-25T02:00:00.000Z", supersededBySessionId: nil)
        check(TrainingPlanExecutionPolicy.sessionListState(session: protectedToday, businessDate: "2026-10-28")
                .caption.contains("查看/调整"),
              "an editable user-protected row keeps the adjust action")
        let history = TrainingPlanExecutionPolicy.historyRows(
            sessions: [session(lifecycle: "completed", id: "session-a"),
                       session(lifecycle: "pending", date: "2026-10-29", id: "session-b")],
            executions: [execution(association: "confirmed", lifecycle: "completed",
                assessment: assessment(), id: "session-a")], businessDate: "2026-10-30")
        check(history.count == 2 && history[0].statusTitle == "已关联实际训练" &&
              history[0].detail.contains("不足") && history[1].statusTitle == "尚未关联实际训练" &&
              !history[1].detail.contains("未完成"), "managed history separates associated, partial and unlinked rows")
        let unknownHistory = TrainingPlanExecutionPolicy.historyRows(
            sessions: [session(lifecycle: "completed")], executions: nil, businessDate: "2026-10-30")
        check(unknownHistory.first?.statusTitle == "执行视图未知",
              "managed history does not turn an absent execution view into an empty history")

        // MARK: - Transport: exact headers/route and 404 semantics

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ExecutionProtocol.self]
        let api = RaiAPIClient(session: URLSession(configuration: configuration))
        let base = URL(string: "https://execution.invalid")!
        var observed: (path: String, method: String, query: [String: String], headers: [String: String], body: Data?)?
        let pageData = try JSONSerialization.data(withJSONObject: ["contractVersion": 1,
            "scope": ["serverId": "server", "athleteId": "athlete", "datasetEpoch": "epoch"],
            "stateRevision": 7, "planInstanceId": "plan", "sessionId": "session",
            "sessionRevision": 3, "executionRevision": 2, "rangeStart": "2026-10-26",
            "rangeEnd": "2026-10-30", "candidates": sameDayRuns.map(candidateJSON), "nextCursor": NSNull()])
        ExecutionProtocol.handler = { request in
            let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
            var query: [String: String] = [:]
            for item in components.queryItems ?? [] { query[item.name] = item.value }
            observed = (request.url!.path, request.httpMethod ?? "", query,
                ["contract": request.value(forHTTPHeaderField: "X-RAI-Training-Contract") ?? "",
                 "sessions": request.value(forHTTPHeaderField: "X-RAI-Training-Sessions") ?? "",
                 "execution": request.value(forHTTPHeaderField: "X-RAI-Client-Training-Execution-Commands") ?? "",
                 "authorization": request.value(forHTTPHeaderField: "Authorization") ?? ""], request.httpBody)
            return (200, pageData)
        }
        let livePage = try await api.trainingPlanExecutionCandidates(sessionId: "session", planInstanceId: "plan",
            rangeStart: "2026-10-26", rangeEnd: "2026-10-30", cursor: "cursor-1", baseURL: base, token: "token")
        check(livePage.candidates.count == 2 && observed?.path == "/v1/mobile/training-plan/sessions/session/execution-candidates" &&
              observed?.method == "GET" && observed?.query["planInstanceId"] == "plan" &&
              observed?.query["rangeStart"] == "2026-10-26" && observed?.query["rangeEnd"] == "2026-10-30" &&
              observed?.query["cursor"] == "cursor-1" &&
              observed?.headers["contract"] == "2" && observed?.headers["sessions"] == "1" &&
              observed?.headers["execution"] == "1" && observed?.headers["authorization"] == "Bearer token" &&
              observed?.body == nil,
              "candidate GET uses its exact route, query and three negotiated headers")
        ExecutionProtocol.handler = { _ in (404, Data("{}".utf8)) }
        do {
            _ = try await api.trainingPlanExecutionCandidates(sessionId: "session", planInstanceId: "plan",
                baseURL: base, token: "token")
            check(false, "an old server 404 must be classified")
        } catch let error as RaiAPIClientError {
            check(error.serverCode == RaiTrainingPlanExecutionContract.routeUnsupportedCode && error.httpStatus == 404,
                  "an empty 404 is route-unsupported/upgrade, never operation notFound")
        }
        ExecutionProtocol.handler = { _ in (404, Data("{\"code\":\"training_session_not_found\",\"message\":\"课程不存在\"}".utf8)) }
        do {
            _ = try await api.trainingPlanExecutionCandidates(sessionId: "session", planInstanceId: "plan",
                baseURL: base, token: "token")
            check(false, "a business 404 must surface")
        } catch let error as RaiAPIClientError {
            check(error.serverCode == "training_session_not_found" && error.httpStatus == 404,
                  "training_session_not_found remains a business answer, not a missing route")
        }
        let commandResponseData = try JSONSerialization.data(withJSONObject: responseObject)
        ExecutionProtocol.handler = { request in
            observed = (request.url!.path, request.httpMethod ?? "", [:],
                ["execution": request.value(forHTTPHeaderField: "X-RAI-Client-Training-Execution-Commands") ?? ""],
                request.httpBody ?? request.httpBodyStream.flatMap { stream -> Data? in
                    stream.open(); defer { stream.close() }
                    var bytes = [UInt8](repeating: 0, count: 8192); var value = Data()
                    while stream.hasBytesAvailable {
                        let read = stream.read(&bytes, maxLength: bytes.count)
                        if read <= 0 { break }
                        value.append(contentsOf: bytes[0..<read])
                    }
                    return value
                })
            return (200, commandResponseData)
        }
        let liveCommand = try await api.submitTrainingExecutionCommand(confirmRequest, baseURL: base, token: "token")
        check(observed?.path == "/v1/mobile/training-plan/execution-commands" && observed?.method == "POST" &&
              observed?.headers["execution"] == "1" && liveCommand.execution?.association == "confirmed",
              "execution command POST uses its exact route and execution negotiation header")
        let postedObject = try JSONSerialization.jsonObject(with: observed!.body!) as! [String: Any]
        check((postedObject["draft"] as! [String: Any])["action"] as? String == "confirm",
              "execution command body is the original draft, not a regenerated plan")

        // MARK: - Shared durable journal / replay / watermarks

        let clock = ISO8601DateFormatter().date(from: "2026-10-25T04:00:00Z")!
        let context = TrainingPlanPublisher.Context(baseURL: base, cacheScope: "scope", identity: identity,
            sessionID: UUID(), credential: "token")
        let target = TrainingPlanExecutionTarget(planInstanceId: "plan", sessionId: "session", sessionRevision: 3,
            executionRevision: 2, stateRevision: 7)
        let journal = ExecutionJournal()
        journal.watermark = .init(stateRevision: 6, goalsRevision: 18)
        var resultExecutionJSON = executionJSON
        resultExecutionJSON["sessionId"] = "session"
        var posts: [Data] = []
        var queryStatus = "committed"
        var queryHTTP = 200
        var postHTTP = 200
        func successResult(operationId: String, stateRevision: Int = 8, goalsRevision: Any = NSNull()) -> Data {
            let object: [String: Any] = ["contractVersion": 1, "operationId": operationId,
                "stateRevision": stateRevision, "goalsRevision": goalsRevision, "planInstanceId": "plan",
                "outcome": "changed", "session": NSNull(), "execution": resultExecutionJSON,
                "planUpdate": "pending", "warnings": []]
            return try! JSONSerialization.data(withJSONObject: object)
        }
        ExecutionProtocol.handler = { request in
            let path = request.url!.path
            if path.contains("/plan-operations/") {
                if queryHTTP != 200 { return (queryHTTP, Data("{\"code\":\"route_missing\",\"message\":\"upgrade\"}".utf8)) }
                let id = path.components(separatedBy: "/").last!
                if queryStatus == "committed" {
                    return (200, Data("{\"status\":\"committed\",\"operationId\":\"\(id)\",\"result\":\(String(data: successResult(operationId: id), encoding: .utf8)!)}".utf8))
                }
                return (200, Data("{\"status\":\"\(queryStatus)\",\"operationId\":\"\(id)\"}".utf8))
            }
            check(path == "/v1/mobile/training-plan/execution-commands", "journal submit uses the execution route")
            let data = request.httpBody ?? request.httpBodyStream.flatMap { stream -> Data? in
                stream.open(); defer { stream.close() }
                var bytes = [UInt8](repeating: 0, count: 8192); var value = Data()
                while stream.hasBytesAvailable {
                    let read = stream.read(&bytes, maxLength: bytes.count)
                    if read <= 0 { break }
                    value.append(contentsOf: bytes[0..<read])
                }
                return value
            } ?? Data()
            posts.append(data)
            if postHTTP != 200 { return (postHTTP, Data("{\"code\":\"synthetic_lost_reply\",\"message\":\"unknown\"}".utf8)) }
            let body = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
            return (200, successResult(operationId: body["operationId"] as! String))
        }
        let publisher = TrainingPlanPublisher(api: api, persistence: journal, now: { clock })
        let first = await publisher.execute(.confirm(trainingSessionId: "synthetic-run-1",
            sourceFactDigest: sameDayRuns[0]["sourceFactDigest"] as! String), target: target, context: context) { true }
        check(first != nil && publisher.phase == .committedAwaitingRead && journal.pending != nil &&
              journal.watermark?.stateRevision == 8 && journal.watermark?.goalsRevision == 18,
              "a null goals revision keeps the existing goals floor and advances state")
        check(posts.count == 1 && posts[0] == journal.pending?.payload &&
              (try! JSONSerialization.jsonObject(with: posts[0]) as! [String: Any])["operationId"] as? String == journal.pending?.operationId,
              "the journal stores the original UUID and the exact bytes that were sent")
        let watermarkObject = try JSONSerialization.jsonObject(with: JSONEncoder().encode(journal.watermark!)) as! [String: Any]
        check(Set(watermarkObject.keys) == ["schemaVersion", "stateRevision", "goalsRevision"] &&
              watermarkObject["sessionRevision"] == nil && watermarkObject["executionRevision"] == nil,
              "the execution acknowledgement watermark contains only state/goals, never session/execution revisions")
        check(publisher.finishRead(context: context) && journal.pending == nil, "a successful execution closes the one shared pending row after full read")

        // Lost response: the original row survives, a restarted publisher queries
        // the committed operation, and no second POST occurs.
        postHTTP = 503
        let lost = await publisher.execute(.correct(trainingSessionId: "synthetic-run-1",
            sourceFactDigest: sameDayRuns[0]["sourceFactDigest"] as! String), target: target, context: context) { true }
        check(lost == nil && journal.pending != nil, "an unknown execution result keeps its journal row")
        let originalBytes = journal.pending!.payload
        let originalID = journal.pending!.operationId
        postHTTP = 200; queryStatus = "committed"; queryHTTP = 200
        let restarted = TrainingPlanPublisher(api: api, persistence: journal, now: { clock })
        let recovered = await restarted.recoverExecution(context: context, mayReplay: false) { true }
        check(recovered != nil && posts.count == 2 && journal.pending?.payload == originalBytes &&
              journal.pending?.operationId == originalID && restarted.phase == .committedAwaitingRead,
              "restart queries the original committed operation without resubmitting or changing bytes")
        _ = restarted.finishRead(context: context)

        // Business notFound is the only reason to replay; an HTTP 404 is not.
        queryStatus = "notFound"; queryHTTP = 200
        let replayJournal = ExecutionJournal()
        replayJournal.pending = .init(operationId: originalID, route: "training-execution",
            payload: originalBytes, preparedAt: clock)
        let replayPublisher = TrainingPlanPublisher(api: api, persistence: replayJournal, now: { clock })
        let beforeReplayPosts = posts.count
        _ = await replayPublisher.recoverExecution(context: context, mayReplay: false) { true }
        check(posts.count == beforeReplayPosts && replayJournal.pending != nil,
              "a read-only recovery keeps the journal when replay is not allowed")
        let replayValue = await replayPublisher.recoverExecution(context: context, mayReplay: true) { true }
        check(replayValue != nil && posts.count == beforeReplayPosts + 1 && posts.last == originalBytes,
              "a business notFound replays the exact original UUID and bytes")
        _ = replayPublisher.finishRead(context: context)

        queryHTTP = 404; queryStatus = "committed"
        let missingRouteJournal = ExecutionJournal()
        missingRouteJournal.pending = .init(operationId: originalID, route: "training-execution",
            payload: originalBytes, preparedAt: clock)
        let missingRoutePublisher = TrainingPlanPublisher(api: api, persistence: missingRouteJournal, now: { clock })
        _ = await missingRoutePublisher.recoverExecution(context: context, mayReplay: true) { true }
        check(missingRouteJournal.pending != nil && posts.count == beforeReplayPosts + 1,
              "an HTTP 404 from the operation query is route/upgrade, not operation notFound or replay")
        queryHTTP = 200

        // A real business 404 on submit is a known rejection and closes only this row.
        let businessJournal = ExecutionJournal()
        let businessPublisher = TrainingPlanPublisher(api: api, persistence: businessJournal, now: { clock })
        postHTTP = 404
        ExecutionProtocol.handler = { _ in (404, Data("{\"code\":\"training_session_not_found\",\"message\":\"当前课程已不存在，请重读。\"}".utf8)) }
        _ = await businessPublisher.execute(.confirm(trainingSessionId: "synthetic-run-1", sourceFactDigest: "d"), target: target,
            context: context) { true }
        check(businessJournal.pending == nil && businessPublisher.phase == .needsPreview &&
              businessPublisher.message?.contains("当前课程已不存在") == true,
              "a training_session_not_found 404 is a rejected business command, not an unknown operation")
        postHTTP = 200
        print("Training plan execution regression: \(count) checks passed")
    }
}

private func XCTUnwrap<T>(_ value: T?) throws -> T {
    guard let value else { throw NSError(domain: "TrainingPlanExecutionRegression", code: 1) }
    return value
}
