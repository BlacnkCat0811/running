import Foundation
import SQLite3

@MainActor
final class SyncTaskStore {
    private var database: OpaquePointer?
    private(set) var lastError: String?

    /// False when the journal could not be opened, in which case every read and
    /// write below is a no-op. Callers must not treat that as "no task saved":
    /// a sync that cannot record its progress loses its ability to resume.
    private(set) var isAvailable = false

    convenience init() {
        let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let directory = applicationSupport.appendingPathComponent("RAI", isDirectory: true)
        self.init(directory: directory)
    }

    /// 指定目录的构造器；`directory` 可注入的理由与 `CacheStore.init(fileURL:)` 相同：
    /// 这一层此前只被 `typecheck-ios.sh` 检查过类型、从未被执行（连替身都没有），
    /// 于是「续传日志到底存不存得住、scope 之间会不会串」没有任何通道能验证。
    init(directory: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("sync.sqlite")
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
            Self.report("open failed (sqlite \(result))", at: url.path)
            return
        }
        let schema = """
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            CREATE TABLE IF NOT EXISTS sync_tasks (
                scope TEXT PRIMARY KEY,
                updated_at REAL NOT NULL,
                payload BLOB NOT NULL
            );
            """
        let execResult = schema.withCString { sql in
            sqlite3_exec(database, sql, nil, nil, nil)
        }
        guard execResult == SQLITE_OK else {
            Self.report("schema failed (sqlite \(execResult))", at: url.path)
            if let database { sqlite3_close(database) }
            database = nil
            return
        }
        isAvailable = true
        #if os(iOS)
        // The journal holds the resume state of a sync that carries health data,
        // so it gets the same protection as the payload — including the WAL and
        // shared-memory sidecars, which the `journal_mode` pragma just created.
        for path in [url.path, url.path + "-wal", url.path + "-shm"] {
            guard FileManager.default.fileExists(atPath: path) else { continue }
            try? FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: path
            )
        }
        #endif
    }

    /// Logs a failure that has no user-facing surface. `NSLog` rather than `print`
    /// because this is a release-path diagnosis, not console noise.
    private static func report(_ what: String, at location: String) {
        #if os(iOS)
        NSLog("[RAI] sync journal %@ at %@", what, location)
        #else
        print("[RAI] sync journal \(what) at \(location)")
        #endif
    }

    deinit {
        if let database { sqlite3_close(database) }
    }

    func load(scope: String) -> Data? {
        guard let statement = prepare("SELECT payload FROM sync_tasks WHERE scope = ?") else { return nil }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        let result = sqlite3_step(statement)
        if result == SQLITE_DONE { return nil }
        guard result == SQLITE_ROW else { fail("read"); return nil }
        let length = Int(sqlite3_column_bytes(statement, 0))
        if length == 0 { return Data() }
        guard let pointer = sqlite3_column_blob(statement, 0) else { fail("read payload"); return nil }
        return Data(bytes: pointer, count: length)
    }

    @discardableResult
    func save(_ data: Data, scope: String) -> Bool {
        guard let statement = prepare("""
            INSERT INTO sync_tasks(scope, updated_at, payload)
            VALUES (?, ?, ?)
            ON CONFLICT(scope) DO UPDATE SET
                updated_at = excluded.updated_at,
                payload = excluded.payload
            """) else { return false }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        sqlite3_bind_double(statement, 2, Date().timeIntervalSince1970)
        guard data.count <= Int(Int32.max) else { fail("payload too large"); return false }
        let bound = data.withUnsafeBytes { buffer in
            sqlite3_bind_blob(statement, 3, buffer.baseAddress, Int32(data.count), SQLiteSupport.transient)
        }
        guard bound == SQLITE_OK, lastError == nil else { fail("bind"); return false }
        let step = sqlite3_step(statement)
        if step != SQLITE_DONE {
            fail("save")
        }
        return step == SQLITE_DONE
    }

    @discardableResult
    func clear(scope: String) -> Bool {
        guard let statement = prepare("DELETE FROM sync_tasks WHERE scope = ?") else { return false }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        let step = sqlite3_step(statement)
        if step != SQLITE_DONE {
            fail("clear")
        }
        return step == SQLITE_DONE
    }

    private func fail(_ operation: String) {
        lastError = "同步进度未能保存或读取，请检查设备存储空间后重试。"
        SQLiteSupport.report("sync journal \(operation)", database: database)
    }

    private func prepare(_ sql: String) -> OpaquePointer? {
        lastError = nil
        guard let statement = SQLiteSupport.prepare(sql, database: database) else {
            fail("prepare")
            return nil
        }
        return statement
    }

    private func bind(_ value: String, to statement: OpaquePointer, at index: Int32) {
        if !SQLiteSupport.bind(value, to: statement, at: index) { fail("bind") }
    }
}
