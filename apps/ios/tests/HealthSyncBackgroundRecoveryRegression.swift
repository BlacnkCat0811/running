import Foundation

@main
struct HealthSyncBackgroundRecoveryRegression {
    static func main() throws {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            checks += 1
            print("PASS: \(name)")
        }

        let identity = HealthSyncBackgroundRecovery.Identity(
            serverId: "server-a",
            athleteId: "athlete-a",
            datasetEpoch: "epoch-2",
            protocolVersion: 3,
            syncScope: "sync-scope-2"
        )
        let recovered = HealthSyncBackgroundRecovery.context(
            serverURL: "https://rai.example/",
            urlScope: "url-scope",
            identity: identity
        )
        check(recovered?.activeScope == "sync-scope-2", "an offline handshake restores the real sync scope")
        check(
            HealthSyncBackgroundRecovery.context(
                serverURL: "https://rai.example/", urlScope: "url-scope", identity: nil
            )?.activeScope == "url-scope",
            "without an offline handshake recovery stays in the URL scope"
        )
        check(
            HealthSyncBackgroundRecovery.context(serverURL: nil, urlScope: nil, identity: identity) == nil,
            "an unbound background launch cannot invent a recovery context"
        )

        let currentTask = HealthSyncBackgroundRecovery.TaskIdentity(
            target: "https://rai.example/",
            serverId: "server-a",
            athleteId: "athlete-a",
            datasetEpoch: "epoch-2",
            protocolVersion: 3
        )
        check(
            HealthSyncBackgroundRecovery.taskMatches(currentTask, context: recovered!),
            "a task matching the recovered identity is a background candidate"
        )
        let staleEpoch = HealthSyncBackgroundRecovery.TaskIdentity(
            target: currentTask.target,
            serverId: currentTask.serverId,
            athleteId: currentTask.athleteId,
            datasetEpoch: "epoch-1",
            protocolVersion: currentTask.protocolVersion
        )
        check(
            !HealthSyncBackgroundRecovery.taskMatches(staleEpoch, context: recovered!),
            "a stale dataset epoch is not accepted as the current candidate"
        )
        let URLOnly = HealthSyncBackgroundRecovery.context(
            serverURL: "https://rai.example/", urlScope: "url-scope", identity: nil
        )!
        check(
            !HealthSyncBackgroundRecovery.taskMatches(currentTask, context: URLOnly),
            "a URL-only recovery cannot accept an identity-scoped task"
        )

        let observed = HealthSyncBackgroundRecovery.IntentObservation(scope: "url-scope", generation: "g1")
        check(
            !HealthSyncBackgroundRecovery.shouldAcknowledgeIntent(
                observed: observed, currentGeneration: "g1", checkpoint: .none
            ),
            "handshake, export, cancellation, and save failures keep the observed intent"
        )
        check(
            HealthSyncBackgroundRecovery.shouldAcknowledgeIntent(
                observed: observed, currentGeneration: "g1", checkpoint: .taskPersisted
            ),
            "the observed intent is consumed after a resumable task is persisted"
        )
        check(
            HealthSyncBackgroundRecovery.shouldAcknowledgeIntent(
                observed: observed, currentGeneration: "g1", checkpoint: .syncCommitted
            ),
            "the observed intent is consumed after a successful sync commit"
        )
        check(
            !HealthSyncBackgroundRecovery.shouldAcknowledgeIntent(
                observed: observed, currentGeneration: "g2", checkpoint: .taskPersisted
            ),
            "a notification arriving during export survives the older generation's checkpoint"
        )
        let legacy = Date(timeIntervalSinceReferenceDate: 1234.5)
        check(
            HealthSyncBackgroundRecovery.intentGeneration(from: legacy)
                == HealthSyncBackgroundRecovery.intentGeneration(from: legacy),
            "a legacy Date intent has a stable migration generation"
        )
        check(
            HealthSyncBackgroundRecovery.intentGeneration(from: "generation") == "generation",
            "a UUID-string intent preserves its exact generation"
        )

        let suiteName = "rai-background-intent-\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            preconditionFailure("could not create an isolated UserDefaults suite")
        }
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = HealthSyncBackgroundIntentStore(userDefaults: defaults, baseKey: "intent")

        // 真实 UserDefaults 交接：旧版本 Date 仍能被观察，并在耐久检查点后迁移式消费。
        defaults.set(legacy, forKey: store.storageKey(scope: "scope-a"))
        let legacyObservation = store.observe(scope: "scope-a")
        check(legacyObservation != nil, "a legacy Date intent is observed from real UserDefaults")
        check(
            store.acknowledge(legacyObservation, checkpoint: .taskPersisted),
            "a legacy Date intent is acknowledged after a durable task save"
        )
        check(!store.hasIntent(scope: "scope-a"), "the acknowledged legacy intent is removed")

        store.record(scope: "scope-a", generation: "generation-1")
        let first = store.observe(scope: "scope-a")
        store.record(scope: "scope-a", generation: "generation-2")
        check(
            !store.acknowledge(first, checkpoint: .taskPersisted),
            "a newer generation arriving during export is not removed by the older observation"
        )
        check(
            store.observe(scope: "scope-a")?.generation == "generation-2",
            "the newer generation remains in real UserDefaults"
        )

        store.record(scope: "scope-b", generation: "other-target")
        let currentA = store.observe(scope: "scope-a")
        check(
            store.acknowledge(currentA, checkpoint: .syncCommitted),
            "the current target's generation is acknowledged after commit"
        )
        check(
            store.observe(scope: "scope-b")?.generation == "other-target",
            "acknowledging one URL scope never deletes another target's intent"
        )

        store.record(scope: "scope-a", generation: "save-failure")
        let failedSaveObservation = store.observe(scope: "scope-a")
        let brokenJournal = SyncTaskStore(directory: URL(fileURLWithPath: "/dev/null/not-a-directory"))
        var acknowledgeCalls = 0
        let saved = HealthSyncBackgroundRecovery.persistThenAcknowledge(
            checkpoint: .taskPersisted,
            persist: { brokenJournal.save(Data("payload".utf8), scope: "sync-scope") },
            acknowledge: { checkpoint in
                acknowledgeCalls += 1
                _ = store.acknowledge(failedSaveObservation, checkpoint: checkpoint)
            }
        )
        check(!saved, "a real SQLite save failure is reported by the durable-write coordinator")
        check(acknowledgeCalls == 0, "a save failure never reaches intent acknowledgement")
        check(store.hasIntent(scope: "scope-a"), "a save failure leaves the real intent present")

        let savedSuccessfully = HealthSyncBackgroundRecovery.persistThenAcknowledge(
            checkpoint: .taskPersisted,
            persist: { true },
            acknowledge: { checkpoint in
                _ = store.acknowledge(failedSaveObservation, checkpoint: checkpoint)
            }
        )
        check(savedSuccessfully, "a successful durable save reaches acknowledgement")
        check(!store.hasIntent(scope: "scope-a"), "the intent is consumed only after durable save succeeds")

        // --- 只读待办探针的三类判定（`PendingWork.Verdict`） -------------------------
        // 三类**互不替代**，而且 read failure 与 identity-unknown 都不许退化成 `empty`
        // —— `empty` 会让调度器报一个空队列成功，而盘上可能还压着一批没人管。
        func pending(
            _ verdict: HealthSyncBackgroundRecovery.PendingWork.Verdict,
            intent: Bool = false,
            recovery: Bool = false,
            continuation: Bool = false
        ) -> HealthSyncBackgroundRecovery.PendingWork {
            HealthSyncBackgroundRecovery.PendingWork(
                serverURL: "https://rai.example/",
                urlScope: "url-scope",
                scope: "sync-scope-2",
                verdict: verdict,
                hasIntent: intent,
                hasRecoveryRequest: recovery,
                // S2.3 新增维度：本文件的断言都针对"三类判定 × 两个成因位"，
                // 待续页的判定由 `BackgroundSyncPolicyRegression` 逐条钉着；
                // 这里显式传 false 保证 memberwise init 的必填位不缺。
                hasPendingContinuation: continuation
            )
        }

        check(
            HealthSyncBackgroundRecovery.pendingWorkVerdict(
                identityKnown: true, scopedTaskFound: false, storesAnyTask: true, readFailed: false
            ) == .empty,
            "a known identity makes the scoped read authoritative, even when another scope still holds a row"
        )
        check(
            HealthSyncBackgroundRecovery.pendingWorkVerdict(
                identityKnown: false, scopedTaskFound: false, storesAnyTask: true, readFailed: false
            ) == .unknown,
            "an unknown identity with unattributable rows is not 'nothing to do'"
        )
        check(
            HealthSyncBackgroundRecovery.pendingWorkVerdict(
                identityKnown: false, scopedTaskFound: false, storesAnyTask: false, readFailed: false
            ) == .empty,
            "an unknown identity with an empty journal is a confirmed empty queue"
        )
        check(
            HealthSyncBackgroundRecovery.pendingWorkVerdict(
                identityKnown: true, scopedTaskFound: true, storesAnyTask: true, readFailed: false
            ) == .pending,
            "a task row on the target's own scope is pending work"
        )
        check(
            HealthSyncBackgroundRecovery.pendingWorkVerdict(
                identityKnown: true, scopedTaskFound: true, storesAnyTask: true, readFailed: true
            ) == .unknown,
            "a read failure outranks a found row: the probe cannot claim to know the queue (migration "
                + "failure and an unavailable journal both land here)"
        )

        // 三类判定派生出来的"重排"与"回执"。`unknown` 与两个成因位都不许报成功 ——
        // 报成功之后系统不会再派活，而盘上那一批或那条通知就再也没人管。
        check(
            pending(.empty).reportsSuccess && !pending(.empty).needsAnotherRound,
            "a confirmed empty target needs no further round and may report success"
        )
        check(
            !pending(.pending).reportsSuccess && pending(.pending).needsAnotherRound
                && pending(.pending).hasUnfinishedWork,
            "a pending task row must resubmit and must never report success"
        )
        check(
            !pending(.unknown).reportsSuccess && pending(.unknown).needsAnotherRound
                && pending(.unknown).hasUnfinishedWork,
            "an unknown verdict counts as unfinished work in both directions"
        )
        check(
            !pending(.empty, intent: true).reportsSuccess && pending(.empty, intent: true).needsAnotherRound,
            "an unclaimed notification keeps the round from reporting success and forces another round"
        )
        check(
            !pending(.empty, recovery: true).reportsSuccess
                && pending(.empty, recovery: true).needsAnotherRound
                && !pending(.empty, recovery: true).hasUnfinishedWork,
            "a scope recovery request is not a task row, but it still forces another round"
        )

        // --- 两个成因必须是**两个**成因 ---------------------------------------------
        // 合成一个枚举值就等于合成一个存储槽，于是"确认新 scope 还没批次"会被一批**旧 scope**
        // 的导出顺手确认掉 —— 新 scope 从此静默 `nothingToDo`。
        let causes = HealthSyncBackgroundRecovery.IntentCause.allCases
        check(
            causes.count == 2
                && Set(causes.map { $0.rawValue }).count == causes.count,
            "the intent causes must stay two distinguishable values with distinct raw values"
        )
        let notificationIntents = HealthSyncBackgroundIntentStore(
            userDefaults: defaults, baseKey: "cause.notification"
        )
        let recoveryIntents = HealthSyncBackgroundIntentStore(
            userDefaults: defaults, baseKey: "cause.recovery"
        )
        notificationIntents.record(scope: "scope-a", generation: "notification-1")
        recoveryIntents.record(scope: "scope-a", generation: "recovery-1")
        check(
            notificationIntents.acknowledge(
                notificationIntents.observe(scope: "scope-a"), checkpoint: .syncCommitted
            ) && recoveryIntents.hasIntent(scope: "scope-a"),
            "acknowledging the health-data notification must not delete the scope-recovery request"
        )
        check(
            !notificationIntents.hasIntent(scope: "scope-a")
                && recoveryIntents.observe(scope: "scope-a")?.generation == "recovery-1",
            "each cause keeps its own generation; the survivor is untouched by the other's checkpoint"
        )

        // --- 受控重开 ---------------------------------------------------------------
        // `SyncTaskStore` 一旦打开失败就把每个读/写变成静默 no-op，而 `HealthKitSync` 的
        // `taskStore` 是 `let` ⇒ 进程内没有第二条路。这里钉住"打开一次失败之后还能回来"。
        let temporary = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-reopen-\(UUID().uuidString)", isDirectory: true)
        let recoverable = SyncTaskStore(directory: temporary)
        check(recoverable.isAvailable, "a writable directory yields an available journal")
        check(recoverable.reopenIfUnavailable(), "an available journal is not reopened needlessly")
        check(
            SyncTaskStore(directory: URL(fileURLWithPath: "/dev/null/not-a-directory"))
                .reopenIfUnavailable() == false,
            "an unrecoverable location stays unavailable instead of pretending to recover"
        )
        try? FileManager.default.removeItem(at: temporary)

        // --- R1（2026-10-19 复核）：窗口探针的三态与过期结算 ---------------------------
        //
        // 旧形态只有"现在有没有到期窗口"一个布尔：未来的复查时刻与超过 7 天的死窗口
        // 都落进 `false`，前者没人安排下一次唤醒，后者永远不落 `expired` 终态。
        // 这里在**真实 SQLite 库**上逐项钉住三件事：到期/未来/过期分开报、过期结算
        // 落盘且可读回、重复结算幂等。
        let windowDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-window-probe-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: windowDirectory) }
        let windowStore = SyncTaskStore(directory: windowDirectory)
        check(windowStore.isAvailable, "the window probe test journal is available")
        let probeNow = Date(timeIntervalSince1970: 1_790_000_000)
        func window(
            _ uuid: String,
            createdAt: Date,
            nextCheckAt: Date,
            completedAt: Date? = nil,
            outcome: WorkoutBackfillPassOutcome? = .settled
        ) -> WorkoutBackfillWindow {
            WorkoutBackfillWindow(
                workoutUUID: uuid,
                windowStart: createdAt.addingTimeInterval(-30 * 60),
                windowEnd: createdAt.addingTimeInterval(30 * 60),
                createdAt: createdAt,
                nextCheckAt: nextCheckAt,
                attemptCount: completedAt == nil ? 1 : 2,
                lastSampleCount: 1,
                stableCount: 0,
                types: ["HKQuantityTypeIdentifierHeartRate": TypeProgress(observed: 1, delivered: 1)],
                lastPassOutcome: outcome,
                completedAt: completedAt
            )
        }
        let dueWindow = window("w-due", createdAt: probeNow.addingTimeInterval(-3600),
                               nextCheckAt: probeNow.addingTimeInterval(-60))
        let futureWindow = window("w-future", createdAt: probeNow.addingTimeInterval(-3600),
                                  nextCheckAt: probeNow.addingTimeInterval(15 * 60))
        let expiredWindow = window("w-expired", createdAt: probeNow.addingTimeInterval(-8 * 24 * 3600),
                                   nextCheckAt: probeNow.addingTimeInterval(-8 * 24 * 3600 + 60 * 60),
                                   completedAt: nil, outcome: .budgetBlocked)
        let completedWindow = window("w-completed", createdAt: probeNow.addingTimeInterval(-3600),
                                     nextCheckAt: probeNow, completedAt: probeNow.addingTimeInterval(-120))
        check(
            windowStore.upsertWorkoutBackfillWindows(
                [dueWindow, futureWindow, expiredWindow, completedWindow], scope: "scope-a"
            ),
            "the window probe fixtures were persisted"
        )
        let probe = windowStore.probeWorkoutWindowWork(scope: "scope-a", now: probeNow)
        check(probe?.dueProbeCount == 1, "exactly one due workout window is reported")
        check(probe?.nextProbeAt == futureWindow.nextCheckAt,
              "the earliest future check time is reported separately from due work")
        check(probe?.expiredWindowCount == 1, "the 7-day expired window is reported for settlement")
        check(probe?.immediatePageCount == 0, "no paging work is invented before R3 creates rows")
        check(
            windowStore.probeWorkoutWindowWork(scope: "scope-b", now: probeNow)?.dueProbeCount == 0,
            "another scope cannot see this scope's windows"
        )

        let settledCount = windowStore.settleExpiredWorkoutWindows(scope: "scope-a", now: probeNow)
        check(settledCount == 1, "the expired window was settled in one short transaction")
        let afterSettle = windowStore.loadWorkoutBackfillWindows(scope: "scope-a")
        check(afterSettle["w-expired"]?.isCompleted == true,
              "the settled window has a persistent completed timestamp")
        check(afterSettle["w-expired"]?.lastPassOutcome == .expired,
              "the settled window records why it stopped (expired)")
        check(WorkoutBackfillScheduler.completionReason(afterSettle["w-expired"]!) == "expired",
              "the settled window reads back as expired, not blocked")
        check(afterSettle["w-due"]?.isCompleted == false && afterSettle["w-future"]?.isCompleted == false,
              "settling expired windows does not touch live ones")
        let afterProbe = windowStore.probeWorkoutWindowWork(scope: "scope-a", now: probeNow)
        check(afterProbe?.expiredWindowCount == 0 && afterProbe?.dueProbeCount == 1,
              "a settled window disappears from both due and expired counts")
        check(windowStore.settleExpiredWorkoutWindows(scope: "scope-a", now: probeNow) == 0,
              "settling expired windows is idempotent")
        check(
            SyncTaskStore(directory: URL(fileURLWithPath: "/dev/null/not-a-directory"))
                .probeWorkoutWindowWork(scope: "scope-a", now: probeNow) == nil,
            "an unreadable journal reports unknown instead of an empty window queue"
        )

        print("\(checks) background recovery regression checks passed")
    }
}
