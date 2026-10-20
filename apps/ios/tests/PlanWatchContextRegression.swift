import Foundation

/// PR6 regressions: training-context identity for the device schedule journal,
/// the withdrawal-before-push switch protocol, and receipt admission.
///
/// These run against the real `PlanWatchScheduling` state machine with the fake
/// scheduler from `PlanTestFixtures`, so "withdraw before push" and every failure
/// injection are behavioural: a mutant that pushes before withdrawing, drops the
/// journal record, or applies a foreign receipt fails a precondition here.
@main struct PlanWatchContextRegression {
    @MainActor static func main() async throws {
        var count = 0
        func check(_ result: @autoclosure () -> Bool, _ name: String) { precondition(result(), name); count += 1; print("PASS: \(name)") }
        func zone() -> TimeZone {
            guard let value = TimeZone(identifier: "Asia/Shanghai") else { preconditionFailure("fixture timezone must exist") }
            return value
        }
        let now = ISO8601DateFormatter().date(from: "2026-10-08T00:00:00Z")!
        let plan = PlanTestFixtures.plan()
        let identity = PlanReceiptScope(serverId: "server", athleteId: "athlete", datasetEpoch: "epoch")

        // 2026-10-09 08:00 Asia/Shanghai, i.e. the hour the fixture plan schedules.
        func entry(_ id: UUID = UUID()) -> PlanScheduledEntry {
            var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone()
            guard let instant = calendar.date(from: DateComponents(year: 2026, month: 10, day: 9, hour: 8)) else {
                preconditionFailure("fixture instant must build")
            }
            return .init(workoutID: id, localDate: "2026-10-09", scheduledAt: instant)
        }
        func readback(_ value: PlanScheduledEntry) -> PlanSchedulingReadback {
            var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone()
            var at = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: value.scheduledAt)
            at.timeZone = calendar.timeZone
            return .init(workoutID: value.workoutID, at: at, contentMatches: true, complete: false)
        }
        func snapshot(revision: Int = 12, localDate: String = "2026-10-08",
                      coachLoop: CoachLoopReceiptContext? = nil) -> PlanSyncSnapshot {
            .init(scope: "test-scope", configuration: UUID(), revision: revision, days: [], timezone: "Asia/Shanghai",
                  reminderHour: 8, completedDates: [], localDate: localDate, windowDays: 7, leaseID: UUID(),
                  serverIdentity: identity, coachLoop: coachLoop)
        }
        func storedOperation(context: PlanScheduleContext?, replaced: PlanScheduleContext? = nil,
                             previous: [PlanScheduledEntry] = [], phase: PlanScheduleOperationJournal.Phase = .verified)
            -> PlanScheduleOperationJournal {
            var value = PlanScheduleOperationJournal(schemaVersion: 1, operationId: UUID(), scope: "test-scope",
                goalsRevision: context?.planRevision ?? 12, coherenceToken: nil, serverIdentity: identity,
                timezone: "Asia/Shanghai", windowStart: nil, windowEnd: nil, reminderHour: 8, phase: phase,
                items: [], previousEntries: previous, updatedAt: Date())
            value.context = context
            value.replacedContext = replaced
            return value
        }
        func journal(storage: FakePlanScheduleStorage, previous: [PlanScheduledEntry],
                     context: PlanScheduleContext?) -> PlanScheduleJournal {
            let value = PlanScheduleJournal(storage: storage, snapshot: snapshot(), previousEntries: previous)
            if let context { value.attachContext(context) }
            return value
        }
        func sync(_ scheduler: FakeWorkoutScheduler, journal: PlanScheduleJournal) async -> PlanWatchSyncOutcome {
            await PlanWatchScheduling.sync(scheduler: scheduler, plan: plan, completedDates: [], hour: 8, now: now,
                journal: journal, isCurrent: { true })
        }
        func receipt(_ id: String = UUID().uuidString, revision: Int = 12, scope: PlanReceiptScope? = identity,
                     idempotencyKey: String? = nil, lifecycle: String? = "verified",
                     coachLoop: CoachLoopReceiptContext? = nil) -> PlanSyncReceipt {
            .init(localDate: "2026-10-09", kind: "easy", revision: revision, structure: nil,
                  workoutID: id, scheduledAt: "2026-10-09T00:00:00Z",
                  idempotencyKey: idempotencyKey ?? id, contractVersion: 2, scope: scope,
                  operationId: UUID().uuidString, coherenceToken: String(repeating: "a", count: 64),
                  verifiedAt: "2026-10-09T00:00:00Z", timezone: "Asia/Shanghai",
                  prescriptionDigest: String(repeating: "b", count: 64), lifecycleEvent: lifecycle,
                  coachLoop: coachLoop)
        }

        let daily = PlanScheduleContext(planRevision: 12, receiptContractVersion: 1, businessDate: "2026-10-08",
            mode: "daily_adaptive", raceGoalID: nil, policyHash: "policy-a")
        let race = PlanScheduleContext(planRevision: 12, receiptContractVersion: 1, businessDate: "2026-10-08",
            mode: "race_preparation", raceGoalID: PlanScheduleContext.raceGoalIdentity(date: "2026-11-08", distanceKm: 21.1, goal: "finish"),
            policyHash: "policy-a")
        let legacy = PlanScheduleContext(planRevision: 12, receiptContractVersion: nil, businessDate: "2026-10-08",
            mode: nil, raceGoalID: nil, policyHash: nil)

        // 1. Context identity survives the journal codec, and a pre-PR6 payload
        //    (no context keys at all) still decodes and stays withdrawable.
        let encoded = try JSONEncoder().encode(storedOperation(context: daily, replaced: race, previous: []))
        let decoded = try JSONDecoder().decode(PlanScheduleOperationJournal.self, from: encoded)
        check(decoded.context == daily && decoded.replacedContext == race,
              "context and replaced context round-trip through the journal codec")
        guard var object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] else {
            preconditionFailure("journal must encode as a JSON object")
        }
        object.removeValue(forKey: "context"); object.removeValue(forKey: "replacedContext")
        let prePR6 = try JSONDecoder().decode(PlanScheduleOperationJournal.self, from: JSONSerialization.data(withJSONObject: object))
        check(prePR6.context == nil && prePR6.replacedContext == nil && prePR6.schemaVersion == 1,
              "a journal written without the new fields still decodes (backward compatible)")
        let oldEntry = entry()
        let legacyStorage = FakePlanScheduleStorage()
        legacyStorage.value = storedOperation(context: nil, previous: [oldEntry], phase: .clearing)
        let legacyJournal = PlanScheduleJournal(storage: legacyStorage, operation: legacyStorage.value ?? prePR6)
        let legacyScheduler = FakeWorkoutScheduler(); legacyScheduler.listed = [readback(oldEntry)]
        let legacyRecovery = await PlanWatchScheduling.recover(scheduler: legacyScheduler, journal: legacyJournal,
                                                               withdraw: true, isCurrent: { true })
        check(legacyRecovery.verified && legacyRecovery.cleanupVerified && legacyScheduler.listed.isEmpty,
              "a pre-PR6 journal without a context remains withdrawable")

        // 2. Change classification: configuration differences switch, publication
        //    differences only refresh, and an unrecorded provenance claims nothing.
        check(PlanScheduleContextChange.evaluate(previous: nil, current: daily) == .unknown,
              "no recorded previous context is unknown provenance, not a switch")
        check(PlanScheduleContextChange.evaluate(previous: daily, current: nil) == .unknown,
              "a missing current context cannot claim sameness")
        check(PlanScheduleContextChange.evaluate(previous: daily, current: daily) == .same,
              "an identical context is a no-op")
        let newerRevision = PlanScheduleContext(planRevision: 13, receiptContractVersion: 1,
            businessDate: "2026-10-08", mode: "daily_adaptive", raceGoalID: nil, policyHash: "policy-a")
        let refresh = PlanScheduleContextChange.evaluate(previous: daily, current: newerRevision)
        check(refresh == .refresh([.planRevision]) && !refresh.isConfigurationSwitch,
              "a newer plan revision alone is a refresh, not a configuration switch")
        let modeSwitch = PlanScheduleContextChange.evaluate(previous: race, current: daily)
        check(modeSwitch.isConfigurationSwitch && Set(modeSwitch.differences) == Set([.mode, .raceGoal]),
              "a mode + race goal change is a configuration switch")
        let endedLoop = PlanScheduleContext(planRevision: 12, receiptContractVersion: nil, businessDate: "2026-10-08",
            mode: nil, raceGoalID: nil, policyHash: nil)
        check(PlanScheduleContextChange.evaluate(previous: race, current: endedLoop).isConfigurationSwitch,
              "ending the coach-loop (mode becomes legacy) is a configuration switch")
        check(PlanScheduleContext.raceGoalIdentity(date: "2026-11-08", distanceKm: 21.1, goal: "finish")
                  == "2026-11-08|21.1|finish",
              "race goal identity is deterministic and includes date, distance and goal")
        check(PlanScheduleContext.raceGoalIdentity(date: nil, distance: "half_marathon", goal: nil) == nil,
              "a race goal without a date has no identity")
        check(PlanScheduleContext.raceGoalIdentity(date: "2026-11-08", distance: "half_marathon", goal: nil)
                  != PlanScheduleContext.raceGoalIdentity(date: "2026-12-06", distance: "half_marathon", goal: nil),
              "a moved race date changes the race goal identity")

        // 3. The replaced context is captured from the durable journal before this
        //    operation overwrites the row (the switch must stay attributable).
        let captureStorage = FakePlanScheduleStorage()
        captureStorage.value = storedOperation(context: race, previous: [oldEntry])
        let captured = PlanScheduleJournal(storage: captureStorage, snapshot: snapshot(), previousEntries: [oldEntry])
        check(captured.previousContext == race && captured.operation.replacedContext == race,
              "the replaced context is captured from the durable journal before it is overwritten")

        // 4. Switch-with-withdraw ordering: verify old entries -> withdrawal
        //    intent durable -> withdraw -> strong empty read-back -> register ->
        //    only then push. The order is asserted from the scheduler's own event
        //    stream, and the durable row at removal time proves what is on disk.
        let switchStorage = FakePlanScheduleStorage()
        switchStorage.value = storedOperation(context: race, previous: [oldEntry])
        let switchJournal = journal(storage: switchStorage, previous: [oldEntry], context: daily)
        var events: [String] = []
        var journalAtRemoval: PlanScheduleOperationJournal?
        let switchScheduler = FakeWorkoutScheduler(); switchScheduler.listed = [readback(oldEntry)]
        switchScheduler.event = { event in
            events.append(event)
            if event == "removeAll" { journalAtRemoval = switchStorage.value }
        }
        let switched = await sync(switchScheduler, journal: switchJournal)
        check(events == ["authorization", "readBack1", "removeAll", "readBack2", "schedule", "schedule", "schedule", "readBack3"],
              "the switch withdraws and strongly reads back before any new schedule call")
        check(switched.contextSwitch && switched.withdrawalRegistered && switched.verified
                  && switched.contextChange.isConfigurationSwitch && switchScheduler.removed.contains(oldEntry.workoutID),
              "a configuration switch is registered after the withdrawal and before the new push")
        check(journalAtRemoval?.phase == .clearing && journalAtRemoval?.context == daily
                  && journalAtRemoval?.replacedContext == race,
              "the new and the replaced context are durable before the first destructive SDK call")
        check(switchJournal.operation.context == daily && switchJournal.operation.replacedContext == race,
              "the operation itself records the pushed context and the one it replaces")

        // 5. A same-configuration refresh still replaces the schedule, but must not
        //    claim a configuration switch (that report is the mode-change signal).
        let refreshStorage = FakePlanScheduleStorage()
        let earlier = PlanScheduleContext(planRevision: 11, receiptContractVersion: 1, businessDate: "2026-10-08",
            mode: "daily_adaptive", raceGoalID: nil, policyHash: "policy-a")
        refreshStorage.value = storedOperation(context: earlier, previous: [oldEntry])
        let refreshJournal = journal(storage: refreshStorage, previous: [oldEntry], context: daily)
        let refreshScheduler = FakeWorkoutScheduler(); refreshScheduler.listed = [readback(oldEntry)]
        let refreshed = await sync(refreshScheduler, journal: refreshJournal)
        check(refreshed.contextChange == .refresh([.planRevision]) && !refreshed.contextSwitch
                  && refreshed.verified && refreshScheduler.clearCalls == 1,
              "a same-configuration refresh replaces the schedule without claiming a mode switch")

        // 6. Unknown provenance: a first push / explicit clear / pre-PR6 journal has
        //    no recorded context. Taking our own entries back must still work.
        let unknownStorage = FakePlanScheduleStorage()
        let unknownJournal = journal(storage: unknownStorage, previous: [oldEntry], context: daily)
        let unknownScheduler = FakeWorkoutScheduler(); unknownScheduler.listed = [readback(oldEntry)]
        let unknown = await sync(unknownScheduler, journal: unknownJournal)
        check(unknown.contextChange == .unknown && !unknown.contextSwitch && unknown.verified
                  && unknownScheduler.removed.contains(oldEntry.workoutID),
              "an unrecorded previous context never blocks withdrawing our own entries")

        // 7. Withdrawal failure during a switch: nothing is pushed, the journal keeps
        //    the old identities and the reservation, and recovery can withdraw again.
        let failStorage = FakePlanScheduleStorage()
        failStorage.value = storedOperation(context: race, previous: [oldEntry])
        let failJournal = journal(storage: failStorage, previous: [oldEntry], context: daily)
        let failScheduler = FakeWorkoutScheduler(); failScheduler.listed = [readback(oldEntry)]
        failScheduler.silentlyFailClear = true
        let failed = await sync(failScheduler, journal: failJournal)
        check(!failed.clearVerified && failed.contextSwitch && !failed.withdrawalRegistered && failScheduler.submitted.isEmpty,
              "a switch whose withdrawal cannot be verified pushes nothing")
        check(failed.report.contains("训练配置已切换") && failed.report.contains("旧排期未能确认撤回"),
              "a failed switch is reported as a switch, not as an ordinary empty window")
        check(failStorage.value?.phase == .clearing && failStorage.value?.terminal == false
                  && failStorage.value?.previousEntries == [oldEntry] && failStorage.value?.context == daily
                  && failStorage.value?.items.count == 3 && failStorage.value?.items.allSatisfy { $0.phase == .prepared } == true,
              "a failed switch keeps the journal unfinished with the old identities and the prepared reservation")
        failScheduler.silentlyFailClear = false
        let failRecoveryJournal = PlanScheduleJournal(storage: failStorage, operation: failStorage.value ?? storedOperation(context: nil))
        let failRecovery = await PlanWatchScheduling.recover(scheduler: failScheduler, journal: failRecoveryJournal,
                                                             withdraw: true, isCurrent: { true })
        check(failRecovery.verified && failScheduler.listed.isEmpty,
              "the failed switch is recoverable by an explicit withdrawal of the same entry identities")

        // 8. Stale read-back: the entry really is gone, but a stale inventory still
        //    reports it — that must not be certified as a completed withdrawal.
        let staleStorage = FakePlanScheduleStorage()
        staleStorage.value = storedOperation(context: race, previous: [oldEntry])
        let staleJournal = journal(storage: staleStorage, previous: [oldEntry], context: daily)
        let staleScheduler = FakeWorkoutScheduler(); staleScheduler.listed = [readback(oldEntry)]
        staleScheduler.readTransform = { _ in [readback(oldEntry)] }
        let stale = await sync(staleScheduler, journal: staleJournal)
        check(!stale.clearVerified && staleScheduler.listed.isEmpty && staleScheduler.submitted.isEmpty
                  && !stale.withdrawalRegistered,
              "a stale read-back cannot certify the withdrawal even though the entry is gone")

        // 9. Journal write failure at the registration step: the withdrawal was read
        //    back empty, but without the durable registration nothing may be pushed.
        let registrationStorage = FakePlanScheduleStorage()
        registrationStorage.value = storedOperation(context: race, previous: [oldEntry])
        let registrationJournal = journal(storage: registrationStorage, previous: [oldEntry], context: daily)
        let registrationScheduler = FakeWorkoutScheduler(); registrationScheduler.listed = [readback(oldEntry)]
        registrationScheduler.event = { event in if event == "readBack2" { registrationStorage.failWrites = true } }
        let unregistered = await sync(registrationScheduler, journal: registrationJournal)
        check(unregistered.storageError != nil && unregistered.submittedEntries.isEmpty && !unregistered.withdrawalRegistered,
              "an unwritable withdrawal registration stops the push instead of running unregistered")
        check(registrationStorage.value?.phase == .clearing,
              "the durable journal still records the clearing intent when registration fails")
        registrationStorage.failWrites = false
        let unregisteredJournal = PlanScheduleJournal(storage: registrationStorage,
            operation: registrationStorage.value ?? storedOperation(context: nil))
        let unwound = await PlanWatchScheduling.recover(scheduler: registrationScheduler, journal: unregisteredJournal,
                                                        withdraw: true, isCurrent: { true })
        check(unwound.verified, "the registration failure is recoverable: the withdrawal can be re-read and registered")

        // 10. Reservation write failure precedes every destructive SDK step.
        let noSideStorage = FakePlanScheduleStorage()
        noSideStorage.value = storedOperation(context: race, previous: [oldEntry])
        noSideStorage.failWrites = true
        let noSideJournal = journal(storage: noSideStorage, previous: [oldEntry], context: daily)
        let noSideScheduler = FakeWorkoutScheduler(); noSideScheduler.listed = [readback(oldEntry)]
        let noSide = await sync(noSideScheduler, journal: noSideJournal)
        check(noSide.storageError != nil && noSideScheduler.clearCalls == 0 && noSideScheduler.submitted.isEmpty,
              "a failed reservation write precedes and prevents every destructive switch step")

        // 11. Receipt admission: scope mismatch is rejected, older context is admitted
        //     as history (a withdrawal must still be registerable), duplicates are
        //     idempotent, and the journal applies the policy to its own identity.
        let currentReceipt = receipt()
        let duplicate = receipt(currentReceipt.workoutID ?? "", idempotencyKey: currentReceipt.idempotencyKey)
        let duplicates = PlanScheduleReceiptAdmission.admit([currentReceipt, duplicate], identity: identity, context: legacy)
        check(duplicates.admitted == [currentReceipt] && duplicates.duplicateCount == 1,
              "equivalent receipts are idempotent within one batch")
        let foreignScope = PlanReceiptScope(serverId: "server", athleteId: "athlete", datasetEpoch: "another-epoch")
        let foreign = receipt(scope: foreignScope)
        let filtered = PlanScheduleReceiptAdmission.admit([currentReceipt, foreign], identity: identity, context: legacy)
        check(filtered.admitted == [currentReceipt] && filtered.rejected == [foreign],
              "a receipt for another dataset is rejected, never applied")
        let olderReceipt = receipt(UUID().uuidString, revision: 12, lifecycle: "replaced",
                                   coachLoop: .init(contractVersion: 1, policyHash: "policy-a", decisionRef: "d1"))
        let olderContext = PlanScheduleContext(planRevision: 13, receiptContractVersion: 1, businessDate: "2026-10-09",
            mode: "race_preparation", raceGoalID: nil, policyHash: "policy-b")
        let olderDecision = PlanScheduleReceiptAdmission.classify(olderReceipt, identity: identity, context: olderContext, seen: [])
        check(olderDecision == .admitHistory,
              "a receipt from an older mode/policy context is admitted as history, never rejected")
        let olderAdmission = PlanScheduleReceiptAdmission.admit([olderReceipt], identity: identity, context: olderContext)
        check(olderAdmission.admitted == [olderReceipt] && olderAdmission.historyCount == 1,
              "older-context receipts stay admissible for withdrawal/replacement")
        let legacyReceipt = PlanSyncReceipt(localDate: "2026-10-09", kind: "easy", revision: 12, structure: nil)
        check(PlanScheduleReceiptAdmission.classify(legacyReceipt, identity: identity, context: legacy, seen: []) == .admit,
              "a legacy scope-less receipt keeps its pre-PR6 admission rule")
        let legacyOne = PlanSyncReceipt(localDate: "2026-10-09", kind: "easy", revision: 12, structure: nil,
                                        workoutID: UUID().uuidString)
        let legacyTwo = PlanSyncReceipt(localDate: "2026-10-09", kind: "easy", revision: 12, structure: nil,
                                        workoutID: legacyOne.workoutID)
        check(PlanScheduleReceiptAdmission.admit([legacyOne, legacyTwo], identity: identity, context: legacy).duplicateCount == 1,
              "legacy receipts without an idempotency key dedupe on UUID + date + event")
        let receiptJournal = PlanScheduleJournal(storage: FakePlanScheduleStorage(), snapshot: snapshot(), previousEntries: [])
        receiptJournal.attachContext(legacy)
        let applied = receiptJournal.admitReceipts([currentReceipt, foreign])
        check(applied.admitted == [currentReceipt] && applied.rejected == [foreign],
              "the journal applies the receipt admission policy to its own context and identity")

        print("Plan watch context regression: \(count) checks passed")
    }
}
