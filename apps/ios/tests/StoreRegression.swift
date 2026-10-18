import Foundation
import SQLite3

// `ServerSession` 的生产默认值需要的两个符号（本回归只调用它的 `canonicalURL`，是个
// nonisolated static，所以这两个替身不该被触达）。触发即失败，而不是悄悄去读真 Keychain。
enum Keychain {
    static func loadToken(for server: String?) -> String {
        preconditionFailure("StoreRegression touched the real Keychain path")
    }

    static func saveToken(_ token: String, for server: String?) -> Bool {
        preconditionFailure("StoreRegression touched the real Keychain path")
    }
}

enum RaiURLSession {
    static func make(configuration: URLSessionConfiguration) -> URLSession {
        preconditionFailure("StoreRegression created a non-injected URLSession")
    }
}

/// `CacheStore` 与 `SyncTaskStore` 的**生产实现**回归。
///
/// 为什么需要它：在此之前这两个文件只被 `typecheck-ios.sh` 类型检查过，从未被执行。
/// `ModelRegression.swift` 里有一份 `CacheStore` 替身（`scope` 退化成字符串拼接），
/// 于是「缓存命名空间由什么决定」这条规则从来没被真实现跑过 —— 少算 `datasetEpoch`
/// 或漏掉 `athleteId` 都能全绿通过。两个 store 的构造器都写死了 Application Support
/// 路径，本回归因此只能连真缓存目录一起写；注入 `fileURL` / `directory` 之后，
/// 它在临时目录里跑的就是生产代码本身。
///
/// 明确不在这里测的：`ModelRegression.swift` 那份替身的行为（那是它的职责），
/// 以及 `HealthKitSync` 自己的 `urlScope`/`syncScope`（那两个只取 sha256 前 24 位，
/// 与本文件的 64 位版本不是同一条规则，需要模拟器才能跑）。
@main
struct StoreRegression {
    @MainActor
    static func main() throws {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            checks += 1
            print("PASS: \(name)")
        }

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-store-regression-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let base = URL(string: "http://192.168.1.10:8790")!
        func handshake(server: String = "srv-a", athlete: String = "ath-a", epoch: String = "epoch-a") -> RaiHandshake {
            RaiHandshake(serverId: server, athleteId: athlete, datasetEpoch: epoch,
                         syncProtocolVersion: 1, apiVersion: "1")
        }
        func variant(server: String = "srv-a", athlete: String = "ath-a", epoch: String = "epoch-a",
                     url: String = "http://192.168.1.10:8790") -> String {
            CacheStore.scope(baseURL: URL(string: url)!,
                             handshake: handshake(server: server, athlete: athlete, epoch: epoch))
        }

        // ---- CacheStore.scope：缓存命名空间必须把「哪台服务器 / 哪个运动员 / 哪一代数据」
        //      全部算进去。少算任何一项，两台服务器（或同一台服务器的两代数据）就会互相
        //      读到对方的缓存，而缓存内容是 workout/today/trends 这类真实读数。
        let identityScope = variant()
        check(identityScope == variant(), "cache scope is stable for an identical identity")
        check(identityScope.count == 64, "cache scope is a full sha256 digest, not a truncated one")
        check(identityScope.allSatisfy { $0.isHexDigit && !$0.isUppercase }, "cache scope is lowercase hex")
        check(variant(server: "srv-b") != identityScope, "a different server must not share a cache namespace")
        check(variant(athlete: "ath-b") != identityScope, "a different athlete must not share a cache namespace")
        check(variant(epoch: "epoch-b") != identityScope, "a new dataset epoch must not read the previous epoch's cache")
        check(variant(url: "http://192.168.1.11:8790") != identityScope,
              "a different server address must not share a cache namespace")
        let suite = "rai-handshake-review-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let legacyKey = "rai.handshake.\(CacheStore.urlScope(baseURL: base))"
        defaults.set(try JSONEncoder().encode(handshake()), forKey: legacyKey)
        check(CacheStore.loadHandshake(baseURL: base, userDefaults: defaults)?.datasetEpoch == "epoch-a",
              "background recovery reads the existing full-digest handshake key")
        CacheStore.saveHandshake(handshake(epoch: "epoch-b"), baseURL: base, userDefaults: defaults)
        check(CacheStore.loadHandshake(baseURL: base, userDefaults: defaults)?.datasetEpoch == "epoch-b",
              "the authoritative handshake replaces the cached epoch")
        check(CacheStore.scope(baseURL: base, handshake: nil) != identityScope,
              "a missing handshake must not collide with a known identity")

        // The same publisher is called by Native connect/refresh and HealthKit sync.
        // Inject the real cache's isolated suite so a crash between request and
        // handshake publication can be reproduced without touching app defaults.
        let recovery = HealthSyncScopeRecoveryStore(userDefaults: defaults, baseKey: "rai.hk.backgroundRecovery")
        let urlScope = HealthSyncIdentityPublisher.urlScope(for: base)
        let newIdentity = handshake(epoch: "epoch-c")
        let newScope = HealthSyncIdentityPublisher.syncScope(for: base, identity: newIdentity)
        check(HealthSyncIdentityPublisher.syncScope(for: base, identity: handshake(epoch: "epoch-b")) != newScope,
              "the recovery scope includes the dataset epoch")
        HealthSyncIdentityPublisher.publish(newIdentity, baseURL: base, userDefaults: defaults,
            load: { CacheStore.loadHandshake(baseURL: $0, userDefaults: defaults) },
            save: { value, url in
                check(recovery.observe(urlScope: urlScope, targetScope: newScope) != nil,
                      "a recovery request is persisted before the new handshake is cached")
                CacheStore.saveHandshake(value, baseURL: url, userDefaults: defaults)
            })
        check(CacheStore.loadHandshake(baseURL: base, userDefaults: defaults)?.datasetEpoch == "epoch-c",
              "the existing handshake cache key receives the new identity")
        let observedRecovery = recovery.observe(urlScope: urlScope, targetScope: newScope)
        check(observedRecovery != nil, "a failed HealthKit handshake leaves the Native-published request")
        check(!recovery.acknowledge(observedRecovery, targetScope: "old-scope", checkpoint: .taskPersisted),
              "an old scope's successful export cannot clear the new scope's request")
        check(recovery.hasRequest(urlScope: urlScope), "the new scope request survives the old batch")
        HealthSyncIdentityPublisher.publish(newIdentity, baseURL: base, userDefaults: defaults,
            load: { CacheStore.loadHandshake(baseURL: $0, userDefaults: defaults) },
            save: { CacheStore.saveHandshake($0, baseURL: $1, userDefaults: defaults) })
        check(recovery.observe(urlScope: urlScope, targetScope: newScope) == observedRecovery,
              "publishing the same identity again does not request another export")
        recovery.record(urlScope: urlScope, targetScope: newScope)
        check(!recovery.acknowledge(observedRecovery, targetScope: newScope, checkpoint: .taskPersisted),
              "a newer recovery generation survives an earlier export")
        let latestRecovery = recovery.observe(urlScope: urlScope, targetScope: newScope)
        check(recovery.acknowledge(latestRecovery, targetScope: newScope, checkpoint: .taskPersisted),
              "only the new scope's persisted export acknowledges its current request")
        check(!recovery.hasRequest(urlScope: urlScope), "the completed recovery is cleared")

        let interruptedBase = URL(string: "http://interrupted.example:8790")!
        let interruptedURLScope = HealthSyncIdentityPublisher.urlScope(for: interruptedBase)
        let interruptedScope = HealthSyncIdentityPublisher.syncScope(for: interruptedBase, identity: newIdentity)
        CacheStore.saveHandshake(handshake(), baseURL: interruptedBase, userDefaults: defaults)
        HealthSyncIdentityPublisher.publish(newIdentity, baseURL: interruptedBase, userDefaults: defaults,
            load: { CacheStore.loadHandshake(baseURL: $0, userDefaults: defaults) },
            save: { _, _ in }) // simulate process termination before cache publication
        let afterRestart = HealthSyncScopeRecoveryStore(userDefaults: defaults, baseKey: "rai.hk.backgroundRecovery")
        check(afterRestart.observe(urlScope: interruptedURLScope, targetScope: interruptedScope) != nil,
              "after interruption before cache publication, a new store sees the durable request")
        check(CacheStore.loadHandshake(baseURL: interruptedBase, userDefaults: defaults)?.datasetEpoch == "epoch-a",
              "the interrupted publication still exposes the old offline identity")
        HealthSyncIdentityPublisher.publish(newIdentity, baseURL: interruptedBase, userDefaults: defaults,
            load: { CacheStore.loadHandshake(baseURL: $0, userDefaults: defaults) },
            save: { CacheStore.saveHandshake($0, baseURL: $1, userDefaults: defaults) })
        check(afterRestart.observe(urlScope: interruptedURLScope, targetScope: interruptedScope) != nil,
              "retrying publication after restart retains a recoverable new scope request")

        // ---- CacheStore.urlScope：只认规范化之后的地址身份，与书写形式无关。
        //      它决定「握手应答缓存」这类键，写错就会在换端口/换大小写后读到旧服务器的应答。
        let canonicalScope = CacheStore.urlScope(baseURL: URL(string: "http://Host.Example:80/rai?x=1#frag")!)
        check(canonicalScope == CacheStore.urlScope(baseURL: URL(string: "http://host.example")!),
              "url scope ignores host case, the default port, path, query and fragment")
        check(canonicalScope != CacheStore.urlScope(baseURL: URL(string: "https://host.example")!),
              "url scope still separates http from https")
        check(canonicalScope.count == 64, "url scope is a full sha256 digest")

        // ---- read / write / clear：缓存的实际读写路径。
        let cache = CacheStore(fileURL: root.appendingPathComponent("cache.sqlite"))
        let writtenAt = cache.write(["hello": "world"], scope: "s1", key: "k1")
        let stored = cache.read([String: String].self, scope: "s1", key: "k1")
        check(stored?.value == ["hello": "world"], "a written value reads back")
        check(abs((stored?.cachedAt.timeIntervalSince(writtenAt!) ?? 999)) < 5,
              "a read reports when the value was written")
        check(cache.read([String: String].self, scope: "s2", key: "k1") == nil,
              "the same key under another scope is a miss, not the other scope's value")
        check(cache.read([String: String].self, scope: "s1", key: "k2") == nil, "an unwritten key is a miss")
        _ = cache.write(["hello": "second"], scope: "s1", key: "k1")
        check(cache.read([String: String].self, scope: "s1", key: "k1")?.value == ["hello": "second"],
              "rewriting a key replaces its value")
        _ = cache.write(["keep": "1"], scope: "s2", key: "k1")
        cache.clear(scope: "s1")
        check(cache.read([String: String].self, scope: "s1", key: "k1") == nil, "clear(scope:) drops that scope")
        check(cache.read([String: String].self, scope: "s2", key: "k1")?.value == ["keep": "1"],
              "clear(scope:) leaves other scopes alone")
        cache.clearAll()
        check(cache.read([String: String].self, scope: "s2", key: "k1") == nil, "clearAll() drops every scope")

        // ---- prune：淘汰策略。它是「缓存会不会无限增长」的唯一判据，此前从未被执行。
        //      `write` 每次都调用它，所以写坏它要么让缓存无界，要么把刚写进去的值删掉。
        let pruner = CacheStore(fileURL: root.appendingPathComponent("prune.sqlite"))
        for index in 0..<5 { _ = pruner.write(["i": index], scope: "p", key: "k\(index)") }
        pruner.prune(maxEntries: 1000, maxBytes: 100 * 1024 * 1024)
        check((0..<5).allSatisfy { pruner.read([String: Int].self, scope: "p", key: "k\($0)") != nil },
              "prune keeps every entry while both limits are respected")
        pruner.prune(maxEntries: 2, maxBytes: 100 * 1024 * 1024)
        check((0..<3).allSatisfy { pruner.read([String: Int].self, scope: "p", key: "k\($0)") == nil },
              "prune evicts the oldest entries first")
        check((3..<5).allSatisfy { pruner.read([String: Int].self, scope: "p", key: "k\($0)") != nil },
              "prune stops at the entry limit instead of emptying the table")
        pruner.prune(maxEntries: 0, maxBytes: 100 * 1024 * 1024)
        check((3..<5).allSatisfy { pruner.read([String: Int].self, scope: "p", key: "k\($0)") == nil },
              "an entry limit of zero empties the table")
        for index in 0..<3 { _ = pruner.write(["i": index], scope: "p", key: "b\(index)") }
        pruner.prune(maxEntries: 1000, maxBytes: 1)
        check((0..<3).allSatisfy { pruner.read([String: Int].self, scope: "p", key: "b\($0)") == nil },
              "prune enforces the byte limit and terminates once the table is empty")

        // 开不出库时不允许崩、也不允许假装写成功。
        let brokenCache = CacheStore(fileURL: URL(fileURLWithPath: "/dev/null/not-a-directory/cache.sqlite"))
        check(brokenCache.write(["a": "b"], scope: "s", key: "k") == nil,
              "a failed cache write must not advance freshness")
        check(brokenCache.read([String: String].self, scope: "s", key: "k") == nil,
              "a cache that cannot open reports a miss instead of crashing")

        // ---- SyncTaskStore：健康同步的断点续传日志。它决定「重连后从哪继续」，
        //      而「没有任务」与「存了一个空任务」必须是可区分的；scope 之间也不能串。
        let journal = SyncTaskStore(directory: root.appendingPathComponent("sync"))
        check(journal.isAvailable, "a writable directory yields an available journal")
        check(journal.load(scope: "s1") == nil, "an empty journal reports no saved task")
        journal.save(Data([1, 2, 3]), scope: "s1")
        check(journal.load(scope: "s1") == Data([1, 2, 3]), "a saved task reads back byte for byte")
        journal.save(Data([9]), scope: "s1")
        check(journal.load(scope: "s1") == Data([9]), "saving the same scope replaces the previous task")
        journal.save(Data([7]), scope: "s2")
        check(journal.load(scope: "s1") == Data([9]), "saving another scope leaves the first task intact")
        journal.clear(scope: "s1")
        check(journal.load(scope: "s1") == nil, "clear(scope:) forgets that scope")
        check(journal.load(scope: "s2") == Data([7]), "clear(scope:) leaves other scopes alone")

        // Inject real SQLite write failures after a successful open: availability
        // alone cannot prove that a later update or clear was durable.
        var control: OpaquePointer?
        let journalPath = root.appendingPathComponent("sync/sync.sqlite").path
        precondition(sqlite3_open(journalPath, &control) == SQLITE_OK)
        precondition(sqlite3_exec(control, "CREATE TRIGGER fail_update BEFORE UPDATE ON sync_tasks BEGIN SELECT RAISE(ABORT, 'fixture'); END; CREATE TRIGGER fail_delete BEFORE DELETE ON sync_tasks BEGIN SELECT RAISE(ABORT, 'fixture'); END;", nil, nil, nil) == SQLITE_OK)
        check(!journal.save(Data([8]), scope: "s2"), "a rejected update reports failure")
        check(journal.lastError != nil, "journal write failure has an actionable state")
        check(journal.load(scope: "s2") == Data([7]), "a rejected update retains the last durable task")
        check(!journal.clear(scope: "s2"), "a rejected clear reports failure")
        check(journal.load(scope: "s2") == Data([7]), "a rejected clear retains the resume state")
        sqlite3_close(control)

        let brokenJournal = SyncTaskStore(directory: URL(fileURLWithPath: "/dev/null/not-a-directory"))
        check(!brokenJournal.isAvailable, "a journal that cannot open reports itself unavailable")
        check(!brokenJournal.save(Data([1]), scope: "s1"), "an unavailable journal rejects writes")
        check(brokenJournal.load(scope: "s1") == nil, "an unavailable journal never pretends a save happened")
        brokenJournal.clear(scope: "s1")
        check(brokenJournal.load(scope: "s1") == nil, "clearing an unavailable journal is a no-op, not a crash")

        // Genuine SQLite migration lock: a v1 journal contains a pending task
        // and committed watermark. The same failed store must recover in place.
        let migrationDirectory = root.appendingPathComponent("migration")
        try FileManager.default.createDirectory(at: migrationDirectory, withIntermediateDirectories: true)
        let migrationPath = migrationDirectory.appendingPathComponent("sync.sqlite").path
        var lockConnection: OpaquePointer?
        precondition(sqlite3_open(migrationPath, &lockConnection) == SQLITE_OK)
        let fixtureSQL = """
            PRAGMA journal_mode = WAL;
            PRAGMA user_version = 1;
            CREATE TABLE sync_tasks (scope TEXT PRIMARY KEY, updated_at REAL NOT NULL, payload BLOB NOT NULL);
            CREATE TABLE sync_state (scope TEXT PRIMARY KEY, workout_anchor BLOB, export_end REAL, updated_at REAL NOT NULL);
            CREATE TABLE sync_route_state (workout_uuid TEXT PRIMARY KEY);
            INSERT INTO sync_tasks VALUES ('locked-scope', 1, x'010203');
            INSERT INTO sync_state VALUES ('locked-scope', x'0405', 42, 1);
            """
        precondition(sqlite3_exec(lockConnection, fixtureSQL, nil, nil, nil) == SQLITE_OK)
        precondition(sqlite3_exec(lockConnection, "BEGIN EXCLUSIVE", nil, nil, nil) == SQLITE_OK)
        let migrating = SyncTaskStore(directory: migrationDirectory)
        check(!migrating.isAvailable, "a real SQLite migration lock makes the journal unavailable")
        check(migrating.hasTask(scope: "locked-scope") == nil,
              "an unavailable read returns unknown and does not migrate schema")
        precondition(sqlite3_exec(lockConnection, "ROLLBACK", nil, nil, nil) == SQLITE_OK)
        sqlite3_close(lockConnection)
        check(migrating.reopenIfUnavailable(), "the same store reopens after the migration lock is released")
        check(migrating.load(scope: "locked-scope") == Data([1, 2, 3]),
              "reopening preserves the pending task bytes")
        check(migrating.loadState(scope: "locked-scope")?.workoutAnchor == Data([4, 5])
              && migrating.loadState(scope: "locked-scope")?.exportEnd == Date(timeIntervalSince1970: 42),
              "reopening preserves the committed anchor and watermark")

        // Safety metadata is durable, scoped, transactional, and not evictable.
        let safetyURL = root.appendingPathComponent("plan-safety.sqlite")
        let safety = CacheStore(fileURL: safetyURL)
        let floor12 = PlanWriteAcknowledgement(revision: 12, action: "fixture", acknowledgedAt: Date(), planId: nil)
        let floor13 = PlanWriteAcknowledgement(revision: 13, action: "preview-confirm", acknowledgedAt: Date(), planId: nil)
        _ = safety.write("old-execution", scope: "A", key: "workout-plan")
        _ = safety.write("old-today", scope: "A", key: "today")
        check(safety.acknowledgePlanWrite(floor13, scope: "A"), "plan acknowledgement transaction commits")
        check(safety.read(String.self, scope: "A", key: "workout-plan") == nil && safety.read(String.self, scope: "A", key: "today") == nil,
              "write transaction invalidates old executable and today caches")
        safety.clear(scope: "A"); safety.prune(maxEntries: 0)
        let reopenedSafety = CacheStore(fileURL: safetyURL)
        check(reopenedSafety.planWriteAcknowledgement(scope: "A")?.revision == 13, "floor survives clear-cache, eviction, and database reopen")
        check(reopenedSafety.planWriteAcknowledgement(scope: "B") == nil, "identity scopes have independent write floors")
        _ = reopenedSafety.write("new-execution", scope: "A", key: "workout-plan")
        check(reopenedSafety.acknowledgePlanWrite(floor12, scope: "A") && reopenedSafety.planWriteAcknowledgement(scope: "A")?.revision == 13,
              "late acknowledgement cannot lower the durable floor")
        check(reopenedSafety.read(String.self, scope: "A", key: "workout-plan")?.value == "new-execution",
              "late lower acknowledgement cannot delete higher-version execution cache")
        safety.clearAll()
        check(safety.planWriteAcknowledgement(scope: "A")?.revision == 13, "clear-all affects presentation caches, never safety metadata")
        let ledger = PlanWatchLedger(scope: "A", revision: 13, entries: [.init(workoutID: UUID(), localDate: "2026-10-09", scheduledAt: Date())], fingerprint: "digest", reminderHour: 8, confirmedAt: Date(), registeredDates: [])
        check(safety.saveWatchLedger(ledger), "app-wide last-sync ledger persists")
        check(CacheStore(fileURL: safetyURL).watchLedger() == ledger, "last-sync ledger survives reopen without pretending current system verification")
        check(safety.saveWatchLedger(nil) && CacheStore(fileURL: safetyURL).watchLedger() == nil, "verified clear removes durable last-sync record")
        let pendingReceipt = PlanSyncReceipt(localDate: "2026-10-09", kind: "easy", revision: 13, structure: nil,
            workoutID: UUID().uuidString, scheduledAt: "2026-10-09T00:00:00Z", idempotencyKey: "pending-key", exportNotes: [])
        check(safety.savePendingPlanReceipts([pendingReceipt], scope: "A"), "confirmed receipt retry journal commits")
        safety.clearAll(); safety.prune(maxEntries: 0)
        check(CacheStore(fileURL: safetyURL).pendingPlanReceipts(scope: "A") == [pendingReceipt] &&
              safety.pendingPlanReceipts(scope: "B").isEmpty, "pending receipt journal survives clearing/eviction/reopen without crossing scopes")

        var failureDB: OpaquePointer?
        precondition(sqlite3_open(safetyURL.path, &failureDB) == SQLITE_OK)
        defer { sqlite3_close(failureDB) }
        precondition(sqlite3_exec(failureDB, "CREATE TRIGGER fail_plan_write BEFORE INSERT ON plan_write_acknowledgements BEGIN SELECT RAISE(ABORT, 'injected'); END", nil, nil, nil) == SQLITE_OK)
        _ = safety.write("diagnostic-old", scope: "C", key: "workout-plan")
        check(!safety.acknowledgePlanWrite(floor13, scope: "C"), "injected SQLite acknowledgement failure is not reported as durable success")
        check(safety.planWriteAcknowledgement(scope: "C") == nil && safety.read(String.self, scope: "C", key: "workout-plan")?.value == "diagnostic-old",
              "failed transaction rolls back metadata and cache invalidation together; model must quarantine old cache")
        precondition(sqlite3_exec(failureDB, "DROP TRIGGER fail_plan_write", nil, nil, nil) == SQLITE_OK)
        check(safety.acknowledgePlanWrite(floor13, scope: "C") && safety.read(String.self, scope: "C", key: "workout-plan") == nil,
              "acknowledgement recovery durably invalidates the old cache")
        _ = safety.write("test", scope: "C", key: "schema")
        precondition(sqlite3_exec(failureDB, "UPDATE cache_entries SET schema_version=999 WHERE cache_key='schema'", nil, nil, nil) == SQLITE_OK)
        check(safety.read(String.self, scope: "C", key: "schema") == nil && safety.lastReadIssue == .unsupportedSchema, "unknown cache schema is classified and fails closed")
        precondition(sqlite3_exec(failureDB, "UPDATE cache_entries SET schema_version=2,payload=x'00' WHERE cache_key='schema'", nil, nil, nil) == SQLITE_OK)
        check(safety.read(String.self, scope: "C", key: "schema") == nil && safety.lastReadIssue == .corruptPayload, "corrupt cache is distinct from cache absence without logging payload")
        // 2026-10-15（审查 B-🔡3）：损坏行必须能被单条清掉（自愈入口 = NativeAppModel.readCacheHealing）——
        // 清掉后的下一次读取是"干净的 miss"，而不是再一次解码失败。
        safety.remove(scope: "C", key: "schema")
        check(safety.read(String.self, scope: "C", key: "schema") == nil && safety.lastReadIssue == nil,
              "removing a corrupt cache row heals it: the next read is a clean miss, not a repeat decode failure")
        precondition(sqlite3_exec(failureDB, "UPDATE plan_write_acknowledgements SET payload=x'00' WHERE scope='A'", nil, nil, nil) == SQLITE_OK)
        check(safety.planWriteAcknowledgement(scope: "A") == nil && safety.planRevisionFloor(scope: "A") == 13,
              "corrupt explanatory write metadata cannot erase the authoritative scalar revision floor")
        check(safety.planAcknowledgementResult(scope: "A").failureCode == .corruptPayload,
              "safety metadata corruption has a typed read result, never a cache miss")
        let snapshot = PlanSyncSnapshot(scope: "journal-scope", configuration: UUID(), revision: 13, days: [],
            timezone: "Asia/Shanghai", reminderHour: 8, completedDates: [], localDate: "2026-10-09", windowDays: 7, leaseID: UUID())
        let scheduleJournal = PlanScheduleJournal(storage: safety, snapshot: snapshot, previousEntries: [])
        check(scheduleJournal.prepare([]) && scheduleJournal.persist(.clearing), "write-ahead intent and clearing phase commit before any SDK effect")
        safety.clearAll(); safety.prune(maxEntries: 0)
        let reopenedJournal = CacheStore(fileURL: safetyURL)
        check(reopenedJournal.scheduleJournalResult().value?.phase == .clearing &&
              reopenedJournal.scheduleJournalResult().value?.terminal == false,
              "unfinished operation survives clear-cache, eviction and simulated process restart")
        let publication = PendingPlanPublication(operationId: UUID().uuidString, route: "coach", payload: Data("{}".utf8), preparedAt: Date())
        check(safety.savePublication(publication, scope: "journal-scope"), "pending business publication is safety metadata")
        safety.clearAll()
        check((CacheStore(fileURL: safetyURL).pendingPublication(scope: "journal-scope").value ?? nil)?.operationId == publication.operationId,
              "lost-response business operation survives clear-cache and reopen")
        // 2026-10-15（审查 🟡-C2）：上面那条钉的是 `clearAll()`；"清除缓存"按钮实际走
        // `clear(scope:)` —— 两者都不得删除未决发布账目。这条钉 scope 版，并与模型回归里
        // 替身 `clear` 的对齐改动构成同一事实的两端（替身给反向绿灯曾让这条性质无人守）。
        _ = safety.write("payload", scope: "scope-clear", key: "goals")
        check(safety.read(String.self, scope: "scope-clear", key: "goals") != nil, "scope-clear fixture writes an ordinary cache entry")
        check(safety.savePublication(publication, scope: "scope-clear"), "scope-clear fixture saves a publication")
        safety.clear(scope: "scope-clear")
        check(safety.read(String.self, scope: "scope-clear", key: "goals") == nil,
              "clearing one scope's cache removes its ordinary entries")
        check((CacheStore(fileURL: safetyURL).pendingPublication(scope: "scope-clear").value ?? nil)?.operationId == publication.operationId,
              "the scoped clear-cache path must not delete an unresolved publication ledger")
        precondition(sqlite3_exec(failureDB, "CREATE TRIGGER fail_receipt BEFORE INSERT ON plan_receipt_journal BEGIN SELECT RAISE(ABORT, 'injected'); END", nil, nil, nil) == SQLITE_OK)
        check(!scheduleJournal.finish(ledger: ledger, receipts: [pendingReceipt], verified: true),
              "ledger, schedule journal and pending receipts do not report a partial transaction as committed")
        check(CacheStore(fileURL: safetyURL).scheduleJournalResult().value?.phase == .clearing &&
              CacheStore(fileURL: safetyURL).watchLedger() == nil,
              "receipt persistence failure rolls journal and ledger back to the preceding durable intent")
        precondition(sqlite3_exec(failureDB, "DROP TRIGGER fail_receipt", nil, nil, nil) == SQLITE_OK)
        let exported = MobileSessionStructure(warmup: nil, blocks: [.init(iterations: 1, steps: [
            .init(purpose: "work", goal: .distance(meters: 4000), alert: nil)
        ])], cooldown: nil)
        let uuid = UUID().uuidString
        let verifiedReceipt = PlanSyncReceipt(localDate: "2026-10-09", kind: "easy", revision: 13, structure: exported,
            workoutID: uuid, scheduledAt: "2026-10-09T00:00:00Z", idempotencyKey: uuid, contractVersion: 2,
            scope: .init(serverId: "server", athleteId: "athlete", datasetEpoch: "epoch"), operationId: UUID().uuidString,
            coherenceToken: String(repeating: "a", count: 64), verifiedAt: "2026-10-09T00:00:00Z", timezone: "Asia/Shanghai",
            prescriptionDigest: try? PlanFingerprint.prescriptionDigest(kind: "easy", structure: exported), lifecycleEvent: "verified")
        let replacementScope = "replacement-recovery"
        let oldEntry = PlanScheduledEntry(workoutID: UUID(uuidString: uuid)!, localDate: verifiedReceipt.localDate,
            scheduledAt: ISO8601DateFormatter().date(from: verifiedReceipt.scheduledAt!)!)
        let previousLedger = PlanWatchLedger(scope: replacementScope, revision: 13, entries: [oldEntry], fingerprint: "old",
            reminderHour: 8, confirmedAt: Date(), registeredDates: [oldEntry.localDate], receipts: [verifiedReceipt])
        let replacementSnapshot = PlanSyncSnapshot(scope: replacementScope, configuration: UUID(), revision: 14, days: [],
            timezone: "Asia/Shanghai", reminderHour: 8, completedDates: [], localDate: "2026-10-10", windowDays: 7, leaseID: UUID())
        let replacementJournal = PlanScheduleJournal(storage: safety, snapshot: replacementSnapshot, previousEntries: [oldEntry])
        let replacementDay = MobileWorkoutPlanDay(localDate: "2026-10-10", kind: "easy", title: "replacement", reason: "",
            distanceKm: 4, durationMinutes: nil, paceSecondsPerKmLower: nil, paceSecondsPerKmUpper: nil,
            heartRateBpmLower: nil, heartRateBpmUpper: nil, structure: exported, source: "manual", executable: true)
        let replacementWorkout = WorkoutPlanMapper.plannedWorkout(from: replacementDay, hour: 8)!
        let replacementEntry = PlanScheduledEntry(workoutID: UUID(), localDate: replacementDay.localDate,
            scheduledAt: oldEntry.scheduledAt.addingTimeInterval(86400))
        var at = DateComponents(year: 2026, month: 10, day: 10, hour: 8, minute: 0)
        at.timeZone = TimeZone(identifier: "Asia/Shanghai")
        let replacementRequest = PlanSchedulingRequest(entry: replacementEntry, at: at, workout: replacementWorkout,
            exportedStructure: exported, exportNotes: [], kind: "easy")
        let replacementReceipt = PlanSyncReceipt(localDate: replacementEntry.localDate, kind: "easy", revision: 14, structure: exported,
            workoutID: replacementEntry.workoutID.uuidString, scheduledAt: ISO8601DateFormatter().string(from: replacementEntry.scheduledAt),
            idempotencyKey: replacementEntry.workoutID.uuidString, contractVersion: 2, scope: verifiedReceipt.scope,
            operationId: replacementJournal.operation.operationId.uuidString, coherenceToken: String(repeating: "c", count: 64),
            verifiedAt: "2026-10-10T00:00:00Z", timezone: "Asia/Shanghai", prescriptionDigest: verifiedReceipt.prescriptionDigest,
            lifecycleEvent: "verified")
        let replacementLedger = PlanWatchLedger(scope: replacementScope, revision: 14, entries: [replacementEntry], fingerprint: "new",
            reminderHour: 8, confirmedAt: Date(), registeredDates: [], receipts: [replacementReceipt])
        var replacedReceipt = verifiedReceipt
        replacedReceipt.lifecycleEvent = "replaced"; replacedReceipt.verifiedAt = "2026-10-10T00:00:00Z"
        replacedReceipt.idempotencyKey = uuid + ":replaced"
        check(safety.saveWatchLedger(previousLedger) && replacementJournal.prepare([replacementRequest]) &&
              replacementJournal.persist(.verifying), "replacement recovery retains the old actual receipt until the final transaction")
        precondition(sqlite3_exec(failureDB, """
            CREATE TRIGGER fail_recovery_receipts BEFORE INSERT ON plan_receipt_journal
            WHEN NEW.scope = 'replacement-recovery' BEGIN SELECT RAISE(ABORT, 'injected'); END
            """, nil, nil, nil) == SQLITE_OK)
        check(!replacementJournal.finish(ledger: replacementLedger, receipts: [replacementReceipt, replacedReceipt], verified: true),
              "replacement recovery does not report success when lifecycle receipt persistence fails")
        let failedRecovery = CacheStore(fileURL: safetyURL)
        check(failedRecovery.watchLedger() == previousLedger && failedRecovery.scheduleJournalResult().value?.phase == .verifying &&
              failedRecovery.pendingPlanReceipts(scope: replacementScope).isEmpty,
              "failed replacement recovery preserves old evidence and rolls back new ledger, terminal journal and both events")
        precondition(sqlite3_exec(failureDB, "DROP TRIGGER fail_recovery_receipts", nil, nil, nil) == SQLITE_OK)
        let retryRecovery = PlanScheduleJournal(storage: safety, operation: failedRecovery.scheduleJournalResult().value!)
        check(retryRecovery.finish(ledger: replacementLedger, receipts: [replacementReceipt, replacedReceipt], verified: true),
              "replacement recovery atomically commits the new verified receipt with the old replaced event")
        let committedRecovery = CacheStore(fileURL: safetyURL)
        check(committedRecovery.watchLedger() == replacementLedger && committedRecovery.scheduleJournalResult().value?.terminal == true &&
              committedRecovery.pendingPlanReceipts(scope: replacementScope) == [replacementReceipt, replacedReceipt],
              "reopening preserves both sides of the replacement and its terminal safety journal")
        check(safety.savePendingPlanReceipts([verifiedReceipt], scope: "older-service"), "verified old-scope pending receipt is retained without a ledger")
        let clearJournal = PlanScheduleJournal(storage: safety, snapshot: snapshot, previousEntries: [])
        check(clearJournal.prepareClear() && clearJournal.finishWithdrawal(ledger: nil, receipts: []),
              "explicit app-wide clear atomically ends all pending verification events across scopes")
        let withdrawnReceipts = safety.pendingPlanReceiptsResult(scope: "older-service").value!
        check(withdrawnReceipts.count == 1 && withdrawnReceipts[0].lifecycleEvent == "withdrawn" &&
              withdrawnReceipts[0].structure == exported && withdrawnReceipts[0].workoutID == uuid,
              "an old queued verification cannot reactivate coverage after all-app withdrawal")
        check(!safety.savePendingPlanReceipts([PlanSyncReceipt(localDate: "2026-10-09", kind: "easy", revision: 13, structure: nil, contractVersion: 2)], scope: "unsafe"),
              "new receipt contract safety fields are required even in local persistence")
        precondition(sqlite3_exec(failureDB, "UPDATE plan_receipt_journal SET payload=x'00' WHERE scope='A'", nil, nil, nil) == SQLITE_OK)
        check(safety.pendingPlanReceiptsResult(scope: "A").failureCode == .corruptPayload &&
              !safety.savePendingPlanReceipts([], scope: "A") &&
              safety.pendingPlanReceiptsResult(scope: "A").failureCode == .corruptPayload,
              "corrupt pending receipts cannot be replaced by a guessed empty journal")
        precondition(sqlite3_exec(failureDB, "UPDATE app_metadata SET payload=x'7b22736368656d6156657273696f6e223a3939397d' WHERE metadata_key='schedule-operation'", nil, nil, nil) == SQLITE_OK)
        check(safety.scheduleJournalResult().failureCode == .unsupportedSchema && !safety.saveScheduleJournal(scheduleJournal.operation),
              "higher safety journal schema stays quarantined, never overwritten or treated as absent")
        check(brokenCache.pendingPlanReceiptsResult(scope: "A").failureCode == .storageUnavailable &&
              brokenCache.scheduleJournalResult().failureCode == .storageUnavailable,
              "unavailable SQLite is distinct from empty safety metadata")

        let legacyURL = root.appendingPathComponent("legacy-cache.sqlite")
        var legacyDB: OpaquePointer?
        precondition(sqlite3_open(legacyURL.path, &legacyDB) == SQLITE_OK)
        precondition(sqlite3_exec(legacyDB, """
            CREATE TABLE cache_entries (scope TEXT NOT NULL, cache_key TEXT NOT NULL, cached_at REAL NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(scope, cache_key));
            INSERT INTO cache_entries VALUES ('legacy', 'value', 1, x'226c656761637922');
            """, nil, nil, nil) == SQLITE_OK)
        sqlite3_close(legacyDB)
        let migratedCache = CacheStore(fileURL: legacyURL)
        check(migratedCache.read(String.self, scope: "legacy", key: "value")?.value == "legacy",
              "known pre-versioned cache explicitly migrates to schema1 without inventing DTO fields")
        check(migratedCache.write("schema2", scope: "legacy", key: "value") != nil &&
              CacheStore(fileURL: legacyURL).read(String.self, scope: "legacy", key: "value")?.value == "schema2",
              "migrated cache accepts new schema2 writes and survives reopen")

        print("\(checks) store regression checks passed")
    }
}
