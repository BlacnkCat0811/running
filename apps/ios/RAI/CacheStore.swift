#if os(iOS)
import CryptoKit
import Foundation
import SQLite3

struct CachedValue<Value: Codable>: Codable {
    let value: Value
    let cachedAt: Date
}

@MainActor
final class CacheStore {
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
            PRAGMA synchronous = NORMAL;
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
            """)
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: fileURL.path
        )
    }

    deinit {
        if let database { sqlite3_close(database) }
    }

    func read<Value: Codable>(_ type: Value.Type, scope: String, key: String) -> CachedValue<Value>? {
        guard let statement = prepare("SELECT cached_at, payload FROM cache_entries WHERE scope = ? AND cache_key = ?") else {
            return nil
        }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        bind(key, to: statement, at: 2)
        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
        let cachedAt = Date(timeIntervalSince1970: sqlite3_column_double(statement, 0))
        guard let bytes = sqlite3_column_blob(statement, 1) else { return nil }
        let length = Int(sqlite3_column_bytes(statement, 1))
        let payload = Data(bytes: bytes, count: length)
        guard let value = try? JSONDecoder().decode(type, from: payload) else { return nil }
        return CachedValue(value: value, cachedAt: cachedAt)
    }

    func write<Value: Codable>(_ value: Value, scope: String, key: String) -> Date? {
        let cachedAt = Date()
        guard let payload = try? JSONEncoder().encode(value),
              let statement = prepare("""
                INSERT INTO cache_entries(scope, cache_key, cached_at, payload)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(scope, cache_key) DO UPDATE SET
                    cached_at = excluded.cached_at,
                    payload = excluded.payload
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
