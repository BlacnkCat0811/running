#if os(iOS)
import CryptoKit
import Foundation
import SQLite3

struct CachedValue<Value: Codable>: Codable {
    let value: Value
    let cachedAt: Date
}

@MainActor
final class CacheStore: PlanSchedulePersistence {
    enum ReadIssue: String { case unavailable, unsupportedSchema, corruptPayload }
    private(set) var lastReadIssue: ReadIssue?
    private var database: OpaquePointer?
    private let fileURL: URL

    convenience init() {
        let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let directory = applicationSupport.appendingPathComponent("RAI", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        self.init(fileURL: directory.appendingPathComponent("cache.sqlite"))
    }

    /// 指定路径的构造器。`fileURL` 可注入是为了让**真实现**的规则（命名空间隔离、
    /// 淘汰策略）能在临时文件上被执行 —— 在此之前这两个文件只被类型检查过，从未运行：
    /// `ModelRegression.swift` 里那份 `CacheStore` 替身把 `scope` 退化成字符串拼接、
    /// 读写走内存字典，于是少算 `datasetEpoch` 或漏掉 `athleteId` 都能全绿。
    init(fileURL: URL) {
        self.fileURL = fileURL
        openDatabase(at: fileURL)
        execute("""
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            CREATE TABLE IF NOT EXISTS cache_entries (
                scope TEXT NOT NULL,
                cache_key TEXT NOT NULL,
                cached_at REAL NOT NULL,
                payload BLOB NOT NULL,
                PRIMARY KEY (scope, cache_key)
            );
            CREATE INDEX IF NOT EXISTS idx_cache_entries_cached_at
                ON cache_entries(scope, cached_at);
            CREATE INDEX IF NOT EXISTS idx_cache_entries_cached_at_global
                ON cache_entries(cached_at);
            CREATE TABLE IF NOT EXISTS plan_write_acknowledgements (
                scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS app_metadata (
                metadata_key TEXT PRIMARY KEY, payload BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS plan_receipt_journal (
                scope TEXT PRIMARY KEY, payload BLOB NOT NULL
            );
            """)
        // Known v1 rows contain the same DTO representation; v2 adds explicit
        // envelope versioning. Unknown versions never become executable data.
        if let statement = prepare("PRAGMA table_info(cache_entries)") {
            var found = false
            while sqlite3_step(statement) == SQLITE_ROW {
                if let name = sqlite3_column_text(statement, 1), String(cString: name) == "schema_version" { found = true }
            }
            sqlite3_finalize(statement)
            if !found { execute("ALTER TABLE cache_entries ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1") }
        }
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: fileURL.path
        )
    }

    deinit {
        if let database { sqlite3_close(database) }
    }

    func read<Value: Codable>(_ type: Value.Type, scope: String, key: String) -> CachedValue<Value>? {
        lastReadIssue = nil
        guard let statement = prepare("SELECT cached_at, payload, schema_version FROM cache_entries WHERE scope = ? AND cache_key = ?") else {
            lastReadIssue = .unavailable
            return nil
        }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        bind(key, to: statement, at: 2)
        let result = sqlite3_step(statement)
        if result == SQLITE_DONE { return nil }
        guard result == SQLITE_ROW else { lastReadIssue = .unavailable; return nil }
        guard (1...2).contains(sqlite3_column_int(statement, 2)) else {
            lastReadIssue = .unsupportedSchema
            return nil
        }
        let cachedAt = Date(timeIntervalSince1970: sqlite3_column_double(statement, 0))
        guard let bytes = sqlite3_column_blob(statement, 1) else { lastReadIssue = .corruptPayload; return nil }
        let length = Int(sqlite3_column_bytes(statement, 1))
        let payload = Data(bytes: bytes, count: length)
        guard let value = try? JSONDecoder().decode(type, from: payload) else {
            lastReadIssue = .corruptPayload
            return nil
        }
        return CachedValue(value: value, cachedAt: cachedAt)
    }

    func readResult<Value: Codable>(_ type: Value.Type, scope: String, key: String) -> CacheReadResult<CachedValue<Value>> {
        if let value = read(type, scope: scope, key: key) { return .value(value) }
        switch lastReadIssue {
        case .unavailable: return .storageUnavailable
        case .unsupportedSchema: return .unsupportedSchema
        case .corruptPayload: return .corruptPayload
        case nil: return .notFound
        }
    }

    func write<Value: Codable>(_ value: Value, scope: String, key: String) -> Date? {
        let cachedAt = Date()
        guard let payload = try? JSONEncoder().encode(value),
              let statement = prepare("""
                INSERT INTO cache_entries(scope, cache_key, cached_at, payload, schema_version)
                VALUES (?, ?, ?, ?, 2)
                ON CONFLICT(scope, cache_key) DO UPDATE SET
                    cached_at = excluded.cached_at,
                    payload = excluded.payload,
                    schema_version = excluded.schema_version
                """) else {
            SQLiteSupport.report("cache encode/prepare", database: database)
            return nil
        }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        bind(key, to: statement, at: 2)
        sqlite3_bind_double(statement, 3, cachedAt.timeIntervalSince1970)
        var stepResult: Int32 = SQLITE_MISUSE
        payload.withUnsafeBytes { buffer in
            sqlite3_bind_blob(statement, 4, buffer.baseAddress, Int32(payload.count), nil)
            stepResult = sqlite3_step(statement)
        }
        if stepResult != SQLITE_DONE {
            // 写缓存失败不致命（重新联网会重建），但必须可观测：
            // 静默丢弃会让离线可用性无预警地退化，且调用方仍以为写入成功。
            SQLiteSupport.report("cache write", database: database)
            return nil
        }
        prune()
        return cachedAt
    }

    func planWriteAcknowledgement(scope: String) -> PlanWriteAcknowledgement? {
        planAcknowledgementResult(scope: scope).value
    }

    func planAcknowledgementResult(scope: String) -> CacheReadResult<PlanWriteAcknowledgement> {
        readMetadata(PlanWriteAcknowledgement.self, sql: "SELECT payload FROM plan_write_acknowledgements WHERE scope = ?", key: scope)
    }

    /// The scalar floor remains authoritative even if explanatory metadata
    /// becomes undecodable. Failure to query safety storage is not a cache miss.
    func planRevisionFloor(scope: String) -> Int? {
        guard let statement = prepare("SELECT revision FROM plan_write_acknowledgements WHERE scope = ?") else { return nil }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        switch sqlite3_step(statement) {
        case SQLITE_ROW:
            guard sqlite3_column_type(statement, 0) == SQLITE_INTEGER, sqlite3_column_int64(statement, 0) >= 0 else { return nil }
            return Int(sqlite3_column_int64(statement, 0))
        case SQLITE_DONE: return 0
        default: return nil
        }
    }

    /// One transaction makes the durable floor, cache invalidation, and the
    /// complete write response visible together. Safety metadata is not pruned
    /// or deleted by "clear cache".
    func acknowledgePlanWrite(
        _ acknowledgement: PlanWriteAcknowledgement, scope: String,
        goals: MobileGoalsResponse? = nil, coach: MobileRunCoachResponse? = nil
    ) -> Bool {
        guard SQLiteSupport.execute("BEGIN IMMEDIATE", database: database) else { return false }
        var committed = false
        defer { if !committed { _ = SQLiteSupport.execute("ROLLBACK", database: database) } }
        if planAcknowledgementResult(scope: scope).failureCode == .unsupportedSchema { return false }
        if let floor = planRevisionFloor(scope: scope), floor > acknowledgement.revision {
            committed = SQLiteSupport.execute("COMMIT", database: database)
            return committed
        }
        guard let payload = try? JSONEncoder().encode(acknowledgement),
              let statement = prepare("""
                INSERT INTO plan_write_acknowledgements(scope, revision, payload) VALUES (?, ?, ?)
                ON CONFLICT(scope) DO UPDATE SET revision = excluded.revision, payload = excluded.payload
                WHERE excluded.revision >= plan_write_acknowledgements.revision
                """) else { return false }
        bind(scope, to: statement, at: 1)
        sqlite3_bind_int64(statement, 2, Int64(acknowledgement.revision))
        let result = payload.withUnsafeBytes { buffer -> Int32 in
            sqlite3_bind_blob(statement, 3, buffer.baseAddress, Int32(payload.count), nil)
            return sqlite3_step(statement)
        }
        sqlite3_finalize(statement)
        guard result == SQLITE_DONE, let deletion = prepare("""
            DELETE FROM cache_entries WHERE scope = ? AND cache_key IN ('goals','today','run-coach','workout-plan','training-plan-state')
            """) else { return false }
        bind(scope, to: deletion, at: 1)
        let deleted = sqlite3_step(deletion)
        sqlite3_finalize(deletion)
        guard deleted == SQLITE_DONE else { return false }
        if let goals, write(goals, scope: scope, key: "goals") == nil { return false }
        if let coach, write(coach, scope: scope, key: "run-coach") == nil { return false }
        committed = SQLiteSupport.execute("COMMIT", database: database)
        return committed
    }

    func watchLedger() -> PlanWatchLedger? {
        watchLedgerResult().value ?? nil
    }

    func watchLedgerResult() -> CacheReadResult<PlanWatchLedger?> {
        readMetadata(Optional<PlanWatchLedger>.self, sql: "SELECT payload FROM app_metadata WHERE metadata_key = ?", key: "watch-ledger")
    }

    func saveWatchLedger(_ ledger: PlanWatchLedger?) -> Bool {
        guard !watchLedgerResult().isFailure else { return false }
        guard let statement = prepare("INSERT OR REPLACE INTO app_metadata(metadata_key, payload) VALUES ('watch-ledger', ?)"),
              let payload = try? JSONEncoder().encode(ledger) else { return false }
        defer { sqlite3_finalize(statement) }
        return payload.withUnsafeBytes { buffer in
            sqlite3_bind_blob(statement, 1, buffer.baseAddress, Int32(payload.count), nil)
            return sqlite3_step(statement) == SQLITE_DONE
        }
    }

    func pendingPlanReceipts(scope: String) -> [PlanSyncReceipt] {
        pendingPlanReceiptsResult(scope: scope).value ?? []
    }

    func pendingPlanReceiptsResult(scope: String) -> CacheReadResult<[PlanSyncReceipt]> {
        let result = readMetadata([PlanSyncReceipt].self, sql: "SELECT payload FROM plan_receipt_journal WHERE scope = ?", key: scope)
        if let values = result.value {
            if values.contains(where: { $0.contractVersion != nil && $0.contractVersion != 2 }) { return .unsupportedSchema }
            if !values.allSatisfy(\.hasRequiredVerificationFields) { return .corruptPayload }
        }
        return result
    }

    func savePendingPlanReceipts(_ receipts: [PlanSyncReceipt], scope: String) -> Bool {
        guard !pendingPlanReceiptsResult(scope: scope).isFailure, receipts.allSatisfy(\.hasRequiredVerificationFields) else { return false }
        guard let payload = try? JSONEncoder().encode(receipts),
              let statement = prepare("INSERT OR REPLACE INTO plan_receipt_journal(scope, payload) VALUES (?, ?)") else { return false }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        return payload.withUnsafeBytes { buffer in
            sqlite3_bind_blob(statement, 2, buffer.baseAddress, Int32(payload.count), nil)
            return sqlite3_step(statement) == SQLITE_DONE
        }
    }

    private func readMetadata<V: Decodable>(_ type: V.Type, sql: String, key: String) -> CacheReadResult<V> {
        guard let statement = prepare(sql) else { return .storageUnavailable }
        defer { sqlite3_finalize(statement) }
        bind(key, to: statement, at: 1)
        let result = sqlite3_step(statement)
        if result == SQLITE_DONE { return .notFound }
        guard result == SQLITE_ROW else { return .storageUnavailable }
        guard let bytes = sqlite3_column_blob(statement, 0) else { return .corruptPayload }
        let data = Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 0)))
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let version = object["schemaVersion"] as? Int, version != 1 { return .unsupportedSchema }
        do { return .value(try JSONDecoder().decode(type, from: data)) }
        catch { return .corruptPayload }
    }

    func pendingPublication(scope: String) -> CacheReadResult<PendingPlanPublication?> {
        readMetadata(Optional<PendingPlanPublication>.self, sql: "SELECT payload FROM app_metadata WHERE metadata_key = ?", key: "publication." + scope)
    }

    func savePublication(_ value: PendingPlanPublication?, scope: String) -> Bool {
        guard !pendingPublication(scope: scope).isFailure else { return false }
        return saveMetadata(value, key: "publication." + scope)
    }

    private func saveMetadata<Value: Encodable>(_ value: Value, key: String) -> Bool {
        guard let payload = try? JSONEncoder().encode(value),
              let statement = prepare("INSERT OR REPLACE INTO app_metadata(metadata_key, payload) VALUES (?, ?)") else { return false }
        defer { sqlite3_finalize(statement) }
        bind(key, to: statement, at: 1)
        return payload.withUnsafeBytes { buffer in
            sqlite3_bind_blob(statement, 2, buffer.baseAddress, Int32(payload.count), nil)
            return sqlite3_step(statement) == SQLITE_DONE
        }
    }

    func scheduleJournalResult() -> CacheReadResult<PlanScheduleOperationJournal> {
        let value = readMetadata(PlanScheduleOperationJournal.self, sql: "SELECT payload FROM app_metadata WHERE metadata_key = ?", key: "schedule-operation")
        if let operation = value.value, operation.schemaVersion != 1 { return .unsupportedSchema }
        return value
    }

    func saveScheduleJournal(_ value: PlanScheduleOperationJournal) -> Bool {
        guard !scheduleJournalResult().isFailure else { return false }
        return saveMetadata(value, key: "schedule-operation")
    }

    func commitScheduleResult(_ operation: PlanScheduleOperationJournal, ledger: PlanWatchLedger?, receipts: [PlanSyncReceipt]) -> Bool {
        let existing = pendingPlanReceiptsResult(scope: operation.scope)
        guard !existing.isFailure, !watchLedgerResult().isFailure,
              SQLiteSupport.execute("BEGIN IMMEDIATE", database: database) else { return false }
        var committed = false
        defer { if !committed { _ = SQLiteSupport.execute("ROLLBACK", database: database) } }
        if operation.phase == .withdrawn && operation.clearAll {
            guard withdrawAllPendingReceipts(observedAt: operation.updatedAt) else { return false }
        }
        let current = pendingPlanReceiptsResult(scope: operation.scope)
        guard !current.isFailure else { return false }
        var pending = current.value ?? []
        if operation.phase == .withdrawn {
            let ids = Set((operation.previousEntries + operation.items.map(\.entry)).map { $0.workoutID.uuidString })
            pending.removeAll { ids.contains($0.workoutID ?? "") && ($0.lifecycleEvent == nil || $0.lifecycleEvent == "verified") }
        }
        for receipt in receipts where !pending.contains(where: { $0.idempotencyKey == receipt.idempotencyKey }) { pending.append(receipt) }
        guard saveScheduleJournal(operation), saveWatchLedger(ledger), savePendingPlanReceipts(pending, scope: operation.scope) else { return false }
        committed = SQLiteSupport.execute("COMMIT", database: database)
        return committed
    }

    private func withdrawAllPendingReceipts(observedAt: Date) -> Bool {
        guard let statement = prepare("SELECT scope FROM plan_receipt_journal") else { return false }
        var scopes: [String] = []
        var result = sqlite3_step(statement)
        while result == SQLITE_ROW {
            if let text = sqlite3_column_text(statement, 0) { scopes.append(String(cString: text)) }
            result = sqlite3_step(statement)
        }
        sqlite3_finalize(statement)
        guard result == SQLITE_DONE else { return false }
        for scope in scopes {
            let previous = pendingPlanReceiptsResult(scope: scope)
            guard !previous.isFailure else { return false }
            var pending = (previous.value ?? []).filter { $0.lifecycleEvent != nil && $0.lifecycleEvent != "verified" }
            for var receipt in previous.value ?? [] where receipt.contractVersion == 2 && receipt.lifecycleEvent == "verified" {
                receipt.lifecycleEvent = "withdrawn"; receipt.verifiedAt = ISO8601DateFormatter().string(from: observedAt)
                receipt.idempotencyKey = (receipt.workoutID ?? "") + ":withdrawn"
                if !pending.contains(where: { $0.idempotencyKey == receipt.idempotencyKey }) { pending.append(receipt) }
            }
            guard savePendingPlanReceipts(pending, scope: scope) else { return false }
        }
        return true
    }

    func recordPlanDiagnostic(_ event: PlanDiagnosticEvent) {
        let result = readMetadata([PlanDiagnosticEvent].self, sql: "SELECT payload FROM app_metadata WHERE metadata_key = ?", key: "plan-diagnostics")
        guard !result.isFailure else { return }
        _ = saveMetadata(Array(((result.value ?? []) + [event]).suffix(500)), key: "plan-diagnostics")
    }

    func exportPlanDiagnostics() -> URL? {
        let result = readMetadata([PlanDiagnosticEvent].self, sql: "SELECT payload FROM app_metadata WHERE metadata_key = ?", key: "plan-diagnostics")
        guard !result.isFailure else { return nil }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("rai-plan-diagnostics.json")
        do {
            try encoder.encode(result.value ?? []).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return url
        } catch { return nil }
    }

    func clear(scope: String) {
        guard let statement = prepare("DELETE FROM cache_entries WHERE scope = ?") else { return }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        if sqlite3_step(statement) != SQLITE_DONE { SQLiteSupport.report("cache delete", database: database) }
    }

    func clearAll() {
        execute("DELETE FROM cache_entries")
    }

    /// 淘汰策略：按 `cached_at` 从最旧开始删，直到条目数与总字节数都回到上限以内。
    /// 刻意不是 `private`：上限是参数化的，而它是"缓存会不会无界增长"的唯一判据 ——
    /// 拿小上限直接调它，才能在几毫秒里验证「先删最旧」与「两个上限都生效」。
    func prune(maxEntries: Int = 240, maxBytes: Int = 100 * 1024 * 1024) {
        guard let database else { return }
        while true {
            guard let countStatement = prepare("SELECT COUNT(*), COALESCE(SUM(length(payload)), 0) FROM cache_entries") else { return }
            let hasRow = sqlite3_step(countStatement) == SQLITE_ROW
            let count = hasRow ? Int(sqlite3_column_int64(countStatement, 0)) : 0
            let bytes = hasRow ? Int(sqlite3_column_int64(countStatement, 1)) : 0
            sqlite3_finalize(countStatement)
            guard count > maxEntries || bytes > maxBytes else { return }
            guard let statement = prepare("""
                DELETE FROM cache_entries WHERE rowid = (
                    SELECT rowid FROM cache_entries ORDER BY cached_at ASC, rowid ASC LIMIT 1
                )
                """) else { return }
            if sqlite3_step(statement) != SQLITE_DONE { SQLiteSupport.report("cache delete", database: database) }
            let removed = sqlite3_changes(database)
            sqlite3_finalize(statement)
            if removed == 0 { return }
        }
    }

    static func scope(baseURL: URL, handshake: RaiHandshake?) -> String {
        let identity = [
            baseURL.absoluteString,
            handshake?.serverId ?? "unknown-server",
            handshake?.athleteId ?? "unknown-athlete",
            handshake?.datasetEpoch ?? "unknown-epoch"
        ].joined(separator: "|")
        let digest = SHA256.hash(data: Data(identity.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    static func urlScope(baseURL: URL) -> String {
        let canonical = ServerSession.canonicalURL(baseURL)
        let digest = SHA256.hash(data: Data(canonical.absoluteString.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// 离线握手与缓存必须共用**同一份** URL scope 实现。
    ///
    /// 这里刻意使用完整 64 位 digest；HealthKit 自己的历史键使用 24 位前缀，两者是不同的
    /// 兼容性域，不能因为算法看起来相似就互相替换。
    static func handshakeStorageKey(baseURL: URL) -> String {
        "rai.handshake.\(urlScope(baseURL: baseURL))"
    }

    static func loadHandshake(baseURL: URL, userDefaults: UserDefaults = .standard) -> RaiHandshake? {
        guard let data = userDefaults.data(forKey: handshakeStorageKey(baseURL: baseURL)) else { return nil }
        return try? JSONDecoder().decode(RaiHandshake.self, from: data)
    }

    static func saveHandshake(
        _ handshake: RaiHandshake,
        baseURL: URL,
        userDefaults: UserDefaults = .standard
    ) {
        guard let data = try? JSONEncoder().encode(handshake) else { return }
        userDefaults.set(data, forKey: handshakeStorageKey(baseURL: baseURL))
    }

    private func openDatabase(at url: URL) {
        let result = url.path.withCString { path in
            sqlite3_open_v2(
                path,
                &database,
                SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX,
                nil
            )
        }
        if result != SQLITE_OK {
            if let database { sqlite3_close(database) }
            database = nil
        }
    }

    private func execute(_ sql: String) {
        if !SQLiteSupport.execute(sql, database: database) {
            SQLiteSupport.report("cache execute", database: database)
        }
    }

    private func prepare(_ sql: String) -> OpaquePointer? {
        let statement = SQLiteSupport.prepare(sql, database: database)
        if statement == nil { SQLiteSupport.report("cache prepare", database: database) }
        return statement
    }

    private func bind(_ value: String, to statement: OpaquePointer, at index: Int32) {
        if !SQLiteSupport.bind(value, to: statement, at: index) {
            SQLiteSupport.report("cache bind", database: database)
        }
    }
}
#endif
