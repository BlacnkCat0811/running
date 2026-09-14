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

    init() {
        let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let directory = applicationSupport.appendingPathComponent("RAI", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        fileURL = directory.appendingPathComponent("cache.sqlite")
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

    func write<Value: Codable>(_ value: Value, scope: String, key: String) -> Date {
        let cachedAt = Date()
        guard let payload = try? JSONEncoder().encode(value),
              let statement = prepare("""
                INSERT INTO cache_entries(scope, cache_key, cached_at, payload)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(scope, cache_key) DO UPDATE SET
                    cached_at = excluded.cached_at,
                    payload = excluded.payload
                """) else {
            return cachedAt
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
            print("RAI cache write failed: step=\(stepResult) scope=\(scope) key=\(key)")
        }
        prune()
        return cachedAt
    }

    func clear(scope: String) {
        guard let statement = prepare("DELETE FROM cache_entries WHERE scope = ?") else { return }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        _ = sqlite3_step(statement)
    }

    func clearAll() {
        execute("DELETE FROM cache_entries")
    }

    private func prune(maxEntries: Int = 240, maxBytes: Int = 100 * 1024 * 1024) {
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
            _ = sqlite3_step(statement)
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
        guard let database else { return }
        _ = sql.withCString { statement in
            sqlite3_exec(database, statement, nil, nil, nil)
        }
    }

    private func prepare(_ sql: String) -> OpaquePointer? {
        guard let database else { return nil }
        var statement: OpaquePointer?
        let result = sql.withCString { value in
            sqlite3_prepare_v2(database, value, -1, &statement, nil)
        }
        guard result == SQLITE_OK else { return nil }
        return statement
    }

    private func bind(_ value: String, to statement: OpaquePointer, at index: Int32) {
        _ = value.withCString { pointer in
            sqlite3_bind_text(statement, index, pointer, -1, SQLITE_TRANSIENT)
        }
    }

    private var SQLITE_TRANSIENT: sqlite3_destructor_type {
        unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    }
}
#endif
