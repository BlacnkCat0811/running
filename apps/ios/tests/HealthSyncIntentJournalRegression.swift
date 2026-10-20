import Foundation

/// R2（2026-10-19 复核）：`HealthSyncIntentJournal` 的**行为**回归。
///
/// 钉的是旧 `UserDefaults` 三步读删结构上无法保证的东西：
///   - 两个交错顺序（旧确认先/新记录先）都不许丢新代次；
///   - 确认只删"恰好观察到的那个代次"，`changes=0` 不许随后无条件删除；
///   - 写入成功 = 同库另一条连接可读回（耐久性只到此为止，不冒充跨进程队列）；
///   - 失败必须分类（`record=false` / `acknowledge=.failed`），不许静默；
///   - 旧 UserDefaults 意图迁移：事务内导入 → 回读 → COMMIT → 删旧键；
///   - 不同 scope 不交叉确认。
///
/// 运行在真实 SQLite 文件上（不是替身）：判据的全部意义正是"跨线程 + 跨连接"的原子性，
/// 替身会把它绕过去。
@main
struct HealthSyncIntentJournalRegression {
    static func main() throws {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            checks += 1
            print("PASS: \(name)")
        }

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-intent-journal-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let databaseURL = directory.appendingPathComponent("sync.sqlite")
        let journal = HealthSyncIntentJournal(databaseURL: databaseURL)
        let scope = "urlscope0000000000000000"

        check(journal.unavailableReason == nil, "an isolated journal directory opens")
        check(journal.observe(scope: scope) == nil, "an empty journal has no intent")
        check(!journal.hasIntent(scope: scope), "hasIntent agrees with observe on an empty journal")

        // --- A1（2026-10-19 复核）：连接配置 + MainActor 非阻塞入口 -----------------
        check(
            journal.journalMode?.lowercased() == "wal",
            "the intent journal opens its own connection in WAL mode (durable FULL sync)"
        )
        // MainActor 路径只入队：串行队列保证"先入队先执行"，因此随后的同步 observe 必然
        // 看到它 —— 判据是"不阻塞、且不丢交接语义"，不是"立刻在同一行返回"。
        journal.recordInBackground(scope: "async-scope")
        check(
            journal.observe(scope: "async-scope") != nil,
            "a background-recorded intent is visible to the next queued read (no lost handoff)"
        )
        let backgroundObservation = journal.observe(scope: "async-scope")
        journal.acknowledgeInBackground(backgroundObservation, checkpoint: .taskPersisted)
        check(
            journal.observe(scope: "async-scope") == nil,
            "a background acknowledgement is applied before the next queued read"
        )
        // 旧确认顺序保护在异步入口上同样成立：先入队新记录，再入队旧确认 ⇒ 新记录保留。
        journal.record(scope: "async-scope", generation: "async-old")
        let asyncOld = journal.observe(scope: "async-scope")
        journal.recordInBackground(scope: "async-scope")
        journal.acknowledgeInBackground(asyncOld, checkpoint: .taskPersisted)
        let asyncFinal = journal.observe(scope: "async-scope")
        check(
            asyncFinal != nil && asyncFinal?.generation != "async-old",
            "an async old-generation acknowledgement cannot delete the newer intent"
        )

        // --- T08：observation → acknowledge（合法检查点）------------------------------
        check(journal.record(scope: scope, generation: "g1"), "record writes and reads back the generation")
        let observed = journal.observe(scope: scope)
        check(observed?.generation == "g1" && observed?.scope == scope,
              "observe returns the exact generation and scope")
        check(
            journal.acknowledgeResult(observed, checkpoint: .syncCommitted) == .acknowledged,
            "a durable checkpoint acknowledges exactly the observed generation"
        )
        check(journal.observe(scope: scope) == nil, "the acknowledged generation is gone")
        check(
            journal.acknowledgeResult(observed, checkpoint: .syncCommitted) == .superseded,
            "acknowledging an already-acknowledged generation is a legal no-op"
        )

        // `.none` 检查点不得确认（旧判据 `shouldAcknowledgeIntent` 的第一条）。
        check(journal.record(scope: scope, generation: "g2"), "a new generation is recorded")
        check(
            journal.acknowledgeResult(journal.observe(scope: scope), checkpoint: .none) == .notEligible
                && journal.observe(scope: scope)?.generation == "g2",
            "a non-durable checkpoint must not consume the intent"
        )

        // --- T07：旧观察 → 新记录 → 旧确认 ⇒ 新代次保留 ------------------------------
        journal.record(scope: scope, generation: "old")
        let oldObservation = journal.observe(scope: scope)
        journal.record(scope: scope, generation: "new")
        check(
            journal.acknowledgeResult(oldObservation, checkpoint: .taskPersisted) == .superseded,
            "an older observation cannot acknowledge the newer generation"
        )
        check(
            journal.observe(scope: scope)?.generation == "new",
            "the newer generation survives the older observation's acknowledgement"
        )

        // --- T07b：旧确认先提交 → 新记录随后插入 ⇒ 新记录保留 ------------------------
        journal.record(scope: scope, generation: "before")
        let beforeObservation = journal.observe(scope: scope)
        check(
            journal.acknowledgeResult(beforeObservation, checkpoint: .taskPersisted) == .acknowledged,
            "the observation is acknowledged before the new delivery lands"
        )
        journal.record(scope: scope, generation: "after")
        check(
            journal.observe(scope: scope)?.generation == "after",
            "a delivery that lands after the acknowledgement is not deleted"
        )

        // --- T09：记录与确认并发（真实 SQLite + 独立连接边界） -----------------------
        //
        // 不变量是**确定性的**：先记 g-a 并观察；随后并发 { 记录 g-b } / { 确认 g-a }。
        // 无论谁先执行，最终都必须是 g-b —— 旧实现里"确认读到 g-a → 新记录写入 → 确认删除"
        // 的窗口会让最终结果变成"没有意图"。
        for round in 0..<40 {
            let oldGeneration = "race-old-\(round)"
            let newGeneration = "race-new-\(round)"
            journal.record(scope: scope, generation: oldGeneration)
            let raceObservation = journal.observe(scope: scope)
            let group = DispatchGroup()
            let recordResult = RaceBox<Bool>()
            let ackResult = RaceBox<Bool>()
            DispatchQueue.global().async(group: group) {
                recordResult.write(journal.record(scope: scope, generation: newGeneration))
            }
            DispatchQueue.global().async(group: group) {
                ackResult.write(journal.acknowledge(raceObservation, checkpoint: .syncCommitted))
            }
            group.wait()
            let final = journal.observe(scope: scope)?.generation
            precondition(recordResult.read() == true, "record failed in race round \(round)")
            precondition(final == newGeneration,
                        "race round \(round) lost the new generation (final=\(String(describing: final)), ack=\(String(describing: ackResult.read())))")
            checks += 1
        }
        print("PASS: 40 record/acknowledge race rounds never lost the newer generation")

        // --- T10：不同 scope 不交叉确认 ---------------------------------------------
        journal.record(scope: "scope-a", generation: "a1")
        journal.record(scope: "scope-b", generation: "b1")
        let observationA = journal.observe(scope: "scope-a")
        check(
            journal.acknowledgeResult(observationA, checkpoint: .syncCommitted) == .acknowledged
                && journal.observe(scope: "scope-b")?.generation == "b1",
            "acknowledging one scope must not touch another"
        )

        // --- T11：COMMIT 之后换一条连接仍能读到（耐久边界只到"同库可读回"） ----------
        journal.record(scope: "durable", generation: "g-durable")
        journal.close()
        let reopened = HealthSyncIntentJournal(databaseURL: databaseURL)
        check(reopened.observe(scope: "durable")?.generation == "g-durable",
              "an intent committed before close is readable from a new connection")
        reopened.close()

        // --- T12：库不可用 ⇒ 明确失败，不伪造成功 ------------------------------------
        let broken = HealthSyncIntentJournal(
            databaseURL: URL(fileURLWithPath: "/dev/null/not-a-directory/sync.sqlite")
        )
        check(!broken.record(scope: "scope-a", generation: "g"), "a broken journal cannot record")
        check(broken.observe(scope: "scope-a") == nil, "a broken journal cannot observe")
        check(
            broken.acknowledgeResult(
                .init(scope: "scope-a", generation: "g"), checkpoint: .taskPersisted
            ) == .failed,
            "a broken journal reports acknowledge failure instead of success"
        )
        // 观察者通道的合同：写失败仍必须**恰好一次** completion，并分类成 writeNotVerified。
        let brokenChannel = HealthSyncObserverIntentChannel(record: { scope in broken.record(scope: scope) })
        brokenChannel.publish(scope: "scope-a")
        var completions = 0
        let outcome = brokenChannel.recordThenComplete { completions += 1 }
        check(
            outcome == .failed(.writeNotVerified) && completions == 1
                && brokenChannel.failures[.writeNotVerified] == 1,
            "a failed intent write still completes exactly once and is classified"
        )

        // --- T13：旧 UserDefaults 意图迁移 ------------------------------------------
        let suiteName = "rai-intent-migration-\(UUID().uuidString)"
        guard let legacyDefaults = UserDefaults(suiteName: suiteName) else {
            preconditionFailure("could not create an isolated UserDefaults suite")
        }
        defer { legacyDefaults.removePersistentDomain(forName: suiteName) }
        let legacyKey = "legacy.intent.migrate-scope"
        legacyDefaults.set("legacy-generation", forKey: legacyKey)
        let migrationURL = directory.appendingPathComponent("migrate.sqlite")
        let migrating = HealthSyncIntentJournal(
            databaseURL: migrationURL,
            legacyUserDefaults: legacyDefaults,
            legacyBaseKey: "legacy.intent"
        )
        let migrated = migrating.observe(scope: "migrate-scope")
        check(migrated?.generation == "legacy-generation",
              "a legacy UserDefaults intent is imported into SQLite")
        check(legacyDefaults.object(forKey: legacyKey) == nil,
              "the legacy key is removed only after the SQLite transaction committed")
        migrating.close()
        let migratedReload = HealthSyncIntentJournal(
            databaseURL: migrationURL,
            legacyUserDefaults: legacyDefaults,
            legacyBaseKey: "legacy.intent"
        )
        check(migratedReload.observe(scope: "migrate-scope")?.generation == "legacy-generation",
              "the migrated generation survives a new connection")
        // 旧 Date 形态也必须能迁移（老版本存 Date）。
        let dateKey = "legacy.intent.date-scope"
        let legacyDate = Date(timeIntervalSinceReferenceDate: 4242.5)
        legacyDefaults.set(legacyDate, forKey: dateKey)
        migratedReload.migrateLegacy(scope: "date-scope")
        check(migratedReload.observe(scope: "date-scope") != nil
                && legacyDefaults.object(forKey: dateKey) == nil,
              "a legacy Date intent is migrated with a stable generation")
        // 新写入优先于旧键：迁移不能把已确认/已更新的 SQLite 行倒退。
        migratedReload.record(scope: "date-scope", generation: "newer")
        legacyDefaults.set("older", forKey: dateKey)
        check(migratedReload.observe(scope: "date-scope")?.generation == "newer",
              "migration never overwrites a newer SQLite generation")
        migrating.close()
        migratedReload.close()

        // --- 写入后崩溃/重开：generation 原样保留（不依赖墙钟） ----------------------
        let finalJournal = HealthSyncIntentJournal(databaseURL: databaseURL)
        check(finalJournal.record(scope: "fresh", generation: "uuid-shaped-generation"),
              "record accepts an explicit generation")
        check(finalJournal.observe(scope: "fresh")?.generation == "uuid-shaped-generation",
              "the explicit generation is stored verbatim")
        finalJournal.close()

        print("\(checks) intent journal regression checks passed")
    }
}

/// 并发测试里把结果从闭包带回来（Swift 5 语言模式下最轻的载体）。
private final class RaceBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value?

    func write(_ value: Value) {
        lock.lock()
        defer { lock.unlock() }
        self.value = value
    }

    func read() -> Value? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}
