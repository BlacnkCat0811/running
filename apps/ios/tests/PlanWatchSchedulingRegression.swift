import Foundation

@main struct PlanWatchSchedulingRegression {
    @MainActor static func main() async throws {
        var count = 0
        func check(_ result: @autoclosure () -> Bool, _ name: String) { precondition(result(), name); count += 1; print("PASS: \(name)") }
        let now = ISO8601DateFormatter().date(from: "2026-10-08T00:00:00Z")!
        let plan = PlanTestFixtures.plan()
        func sync(_ fake: FakeWorkoutScheduler, plan: MobileWorkoutPlanResponse = plan, current: @escaping () -> Bool = { true }, time: Date = now) async -> PlanWatchSyncOutcome {
            await PlanWatchScheduling.sync(scheduler: fake, plan: plan, completedDates: [], hour: 8, now: time, isCurrent: current)
        }
        let full = FakeWorkoutScheduler()
        let all = await sync(full)
        check(all.verified && all.offered == 3 && all.receipts.count == 3 && all.clearVerified, "all three UUID/time/content matches establish full coverage")
        check(all.receipts.allSatisfy { $0.structure == plan.days.first?.structure && $0.workoutID != nil && $0.idempotencyKey == $0.workoutID }, "receipts contain the actual exported structure and stable operation IDs")
        check(!all.report.contains("已收到"), "system verification never asserts physical Watch delivery")

        let partial = FakeWorkoutScheduler(); partial.silentDates = ["2026-10-10"]
        let two = await sync(partial)
        check(!two.verified && two.scheduled == 2 && two.receipts.map(\.localDate) == ["2026-10-09", "2026-10-11"], "partial success registers exactly the two confirmed days")
        let capacity = FakeWorkoutScheduler(); capacity.capacity = 2
        let capped = await sync(capacity)
        check(capped.offered == 3 && capped.attempted == 2 && capped.scheduled == 2 && !capped.verified, "offered3 pending2 confirmed2 is NOT complete")
        let reject = FakeWorkoutScheduler(); reject.rejectDates = ["2026-10-10"]
        let rejected = await sync(reject)
        check(!rejected.verified && rejected.attempted == 2 && rejected.days.contains { $0.reason == "SDK 不支持必要目标" }, "unsupported required goal rejects the entire day")
        for variant in ["id", "time", "content", "complete", "missing-date", "other-day"] {
            let fake = FakeWorkoutScheduler()
            fake.readTransform = { entries in entries.map { value in
                var at = value.at
                if variant == "time" { at.hour = 9 }
                if variant == "other-day" { at.day = (at.day ?? 1) + 1 }
                if variant == "missing-date" { at = DateComponents() }
                return .init(workoutID: variant == "id" ? UUID() : value.workoutID, at: at,
                    contentMatches: variant != "content", complete: variant == "complete")
            } }
            let result = await sync(fake)
            check(result.receipts.isEmpty && !result.verified, "readback refuses \(variant) mismatch")
        }
        let utc = FakeWorkoutScheduler()
        utc.readTransform = { entries in entries.map { item in
            var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(secondsFromGMT: 0)!
            let date = PlanReceiptMatcher.instant(item.at, fallbackTimeZone: TimeZone(identifier: "Asia/Shanghai")!)!
            var at = cal.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date); at.timeZone = cal.timeZone
            return .init(workoutID: item.workoutID, at: at, contentMatches: true, complete: false)
        } }
        let normalized = await sync(utc)
        check(normalized.verified, "UTC normalization keeps the same exact instant and local attribution")

        let stale = FakeWorkoutScheduler(); stale.silentlyFailClear = true
        stale.listed = [.init(workoutID: UUID(), at: all.submittedEntries.first.map { entry in full.submitted.first!.at } ?? DateComponents(), contentMatches: true, complete: false)]
        let noReplace = await sync(stale)
        check(!noReplace.clearVerified && noReplace.receipts.isEmpty && stale.submitted.isEmpty, "silent removeAll failure prevents replacement and false old-date confirmation")
        let emptyPlan = PlanTestFixtures.plan(dates: [])
        let notCleared = await sync(stale, plan: emptyPlan)
        check(notCleared.report.contains("旧排期未能确认撤回") && !notCleared.verified, "empty-window clear failure cannot be hidden by normal empty copy")
        let cleared = await sync(FakeWorkoutScheduler(), plan: emptyPlan)
        check(cleared.clearVerified && cleared.verified && cleared.report.contains("已核验清空"), "empty window is successful only after verified empty readback")
        for phase in ["authorization", "requestAuthorization", "removeAll", "schedule", "readBack2"] {
            var current = true
            let fake = FakeWorkoutScheduler()
            if phase == "requestAuthorization" { fake.state = "notDetermined" }
            fake.event = { event in if event == phase { current = false } }
            let result = await sync(fake, current: { current })
            check(result.superseded && !result.verified && result.receipts.isEmpty, "lease invalidation during \(phase) refuses stale success")
            check(result.report.contains("终止") && !result.report.contains("未获得"), "supersession during \(phase) is not misreported as failed authorization")
            check(fake.listed.isEmpty, "lease invalidation during \(phase) leaves no submitted stale entries")
        }
        var current = true
        let cleanupFailure = FakeWorkoutScheduler(); cleanupFailure.silentlyFailRemoval = true
        cleanupFailure.event = { event in if event == "schedule" { current = false } }
        let risk = await sync(cleanupFailure, current: { current })
        check(risk.superseded && !risk.cleanupVerified && risk.submittedEntries.count == 1 && risk.report.contains("未能确认撤回"), "failed targeted cleanup retains submitted IDs and visible withdrawal risk")

        let unsupported = FakeWorkoutScheduler(); unsupported.isSupported = false
        let unsupportedResult = await sync(unsupported)
        check(unsupportedResult.deviceUnsupported && unsupported.authRequests == 0, "support check precedes authorization")
        let denied = FakeWorkoutScheduler(); denied.state = "denied"
        let deniedResult = await sync(denied)
        check(!deniedResult.authorized && denied.authRequests == 0 && !deniedResult.report.contains("重装"), "denied authorization uses supported settings guidance, not reinstall/reset")
        for state in ["denied", "restricted"] {
            let fake = FakeWorkoutScheduler(); fake.state = state
            let outcome = await PlanWatchScheduling.clear(scheduler: fake, isCurrent: { true })
            check(!outcome.verified && outcome.report.contains(state == "denied" ? "拒绝" : "限制") &&
                  fake.authRequests == 0, "withdrawal reports \(state) without implying system clear or re-prompting")
        }

        let midnight = ISO8601DateFormatter().date(from: "2026-10-09T15:59:40Z")!
        let crossing = await sync(FakeWorkoutScheduler(), plan: PlanTestFixtures.plan(dates: ["2026-10-09"]), time: midnight)
        check(crossing.receipts.isEmpty && crossing.attempted == 0 && crossing.offered == 1 && !crossing.verified, "late slot crossing midnight is refused, never reassigned")
        let badZone = await sync(FakeWorkoutScheduler(), plan: PlanTestFixtures.plan(timezone: "unknown/timezone"))
        check(!badZone.verified && badZone.attempted == 0, "missing execution timezone does not default optimistically")
        let malformed = await sync(FakeWorkoutScheduler(), plan: .init(generatedAt: plan.generatedAt, timezone: plan.timezone, windowDays: 7, planRevision: 12, audit: nil, days: [PlanTestFixtures.day("2026-10-09", meters: 5000000)]))
        check(malformed.attempted == 0 && !malformed.verified, "dose clamping cannot produce a partial prescription reported as complete")
        let unsafeTarget = MobileSessionStructure(warmup: nil, blocks: [.init(iterations: 1, steps: [
            .init(purpose: "work", goal: .distance(meters: 4000), alert: .init(kind: "heart_rate", lower: 350, upper: 400))
        ])], cooldown: nil)
        let cappedHR = MobileWorkoutPlanDay(localDate: "2026-10-09", kind: "easy", title: "unsafe target", reason: "", distanceKm: 4,
            durationMinutes: nil, paceSecondsPerKmLower: nil, paceSecondsPerKmUpper: nil, heartRateBpmLower: nil, heartRateBpmUpper: nil,
            structure: unsafeTarget, source: "manual", executable: true)
        let targetOutcome = await sync(FakeWorkoutScheduler(), plan: .init(generatedAt: plan.generatedAt, timezone: plan.timezone,
            windowDays: 7, planRevision: 12, audit: nil, days: [cappedHR]))
        check(targetOutcome.attempted == 0 && !targetOutcome.verified, "heart-rate clamping is not treated as lossless export of a required target")
        let fractional = PlanTestFixtures.day("2026-10-09", meters: 4000.5)
        let fractionalOutcome = await sync(FakeWorkoutScheduler(), plan: .init(generatedAt: plan.generatedAt, timezone: plan.timezone,
            windowDays: 7, planRevision: 12, audit: nil, days: [fractional]))
        check(fractionalOutcome.attempted == 0 && !fractionalOutcome.verified,
              "fractional compatibility dose cannot disagree with whole-unit server receipt normalization")
        let json = try PlanTestFixtures.json(plan)
        for field in ["planRevision", "timezone", "executable"] {
            var object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
            if field == "executable" { var days = object["days"] as! [[String: Any]]; days[0].removeValue(forKey: field); object["days"] = days }
            else { object.removeValue(forKey: field) }
            check((try? JSONDecoder().decode(MobileWorkoutPlanResponse.self, from: JSONSerialization.data(withJSONObject: object))) == nil, "missing safety field \(field) rejects execution payload")
        }
        let unknownGoal = "{\"type\":\"future-goal\"}"
        check((try? JSONDecoder().decode(MobileStepGoal.self, from: Data(unknownGoal.utf8))) == nil, "unknown executable enum is not converted to open")
        for version in [1, 2] {
            let url = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("apps/ios/tests/fixtures/plan-v\(version).json")
            let decoded = try JSONDecoder().decode(MobileWorkoutPlanResponse.self, from: Data(contentsOf: url))
            let fixtureOutcome = await sync(FakeWorkoutScheduler(), plan: decoded)
            check(fixtureOutcome.verified && fixtureOutcome.receipts.count == 1, "golden v\(version) payload preserves explicit executable safety metadata")
        }
        let legacyHandshake = "{\"serverId\":\"server\",\"athleteId\":\"athlete\",\"datasetEpoch\":\"epoch\",\"syncProtocolVersion\":1,\"apiVersion\":\"v1\"}"
        let handshake = try JSONDecoder().decode(RaiHandshake.self, from: Data(legacyHandshake.utf8))
        check(handshake.planReceiptMetadata == nil,
              "old handshake omits additive receipt capability safely")
        let duplicate = MobileWorkoutPlanResponse(generatedAt: plan.generatedAt, timezone: plan.timezone, windowDays: 7, planRevision: 12, audit: nil, days: [plan.days[0], plan.days[0]])
        let duplicateOutcome = await sync(FakeWorkoutScheduler(), plan: duplicate)
        check(duplicateOutcome.attempted == 0 && duplicateOutcome.validationError != nil, "duplicate local-date identity cannot produce ambiguous receipts")

        print("Plan scheduling regression: \(count) checks passed")
    }
}
