import Foundation
import SQLite3

@MainActor
final class SyncTaskStore {
    private static let schemaVersion = 2
    private var database: OpaquePointer?
    /// 受控重开需要它：`open()` 可能被调用不止一次（见 `reopenIfUnavailable()`）。
    private let directory: URL
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
        self.directory = directory
        open()
    }

    /// 打开（或重新打开）日志库。**这是唯一会碰 `database` 的地方。**
    ///
    /// 从 `init` 里抽出来的理由只有一个：失败之后必须有一条回来的路（`reopenIfUnavailable()`）。
    /// 抽之前，"打开失败"与"迁移失败"都把连接关掉、`isAvailable = false`，而**每个读/写都是
    /// 静默 no-op** —— 于是一次瞬时故障（应用支持目录尚未就绪、WAL 锁竞争、磁盘暂时写满）
    /// 会把整个进程的续传能力判死，直到 App 重启。而 `HealthKitSync` 的 `taskStore` 是
    /// `let`：进程内没有任何地方能换一个新的实例。
    private func open() {
        isAvailable = false
        lastError = nil
        if let database { sqlite3_close(database) }
        database = nil
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
            CREATE TABLE IF NOT EXISTS sync_state (
                scope TEXT PRIMARY KEY,
                workout_anchor BLOB,
                export_end REAL,
                updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sync_record_cursors (
                scope TEXT PRIMARY KEY,
                payload BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sync_analysis_reconcile (
                scope TEXT PRIMARY KEY,
                payload BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sync_continuation (
                scope TEXT PRIMARY KEY,
                payload BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sync_pending_deletions (
                scope TEXT PRIMARY KEY,
                payload BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sync_pending_routes (
                scope TEXT NOT NULL,
                workout_uuid TEXT NOT NULL,
                reason TEXT NOT NULL,
                created_at REAL NOT NULL,
                -- R07（2026-10-16）：调度状态与字段（旧库经 `ensurePendingRouteColumns` 幂等补列）。
                -- 全部可空：NULL 由读侧归一（`schedState == nil` ⇒ ready）。
                sched_state TEXT,
                attempt_count INTEGER,
                last_attempt_at REAL,
                next_retry_at REAL,
                blocked_budget_fingerprint TEXT,
                PRIMARY KEY (scope, workout_uuid)
            );
            -- B01（2026-10-17）：路线提交候选的**结算槽**。
            -- 为什么要独立于 sync_tasks：`commitSuccess` 在同一个事务里删掉任务行，
            -- 而"写状态 + 删待办"发生在提交**之后**。候选若只活在任务行里，崩在
            -- 提交成功与结算完成之间就丢了 —— 待办残留（安全，但白读一次 HealthKit），
            -- 且没有任何本地记录能说明"这批已经交付、只差结算"。
            -- 候选只含点数/摘要/状态，不含轨迹点（不是另一份健康库）。
            CREATE TABLE IF NOT EXISTS sync_route_settlements (
                scope TEXT PRIMARY KEY,
                batch_id TEXT NOT NULL,
                payload BLOB NOT NULL,
                created_at REAL NOT NULL
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
        guard migrateRouteStateSchema() else {
            Self.report("route schema migration failed", at: url.path)
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

    /// 不可用时再试一次打开（**受控重开**）。
    ///
    /// 为什么"受控"而不是"每次用之前都开"：`open()` 会跑一句多语句 `sqlite3_exec`（schema）
    /// 与一次迁移判定，它不是免费的；而可用状态下这条路只剩一次布尔读。
    ///
    /// 为什么重开是安全的：
    ///   - 迁移里的失败**已经 `ROLLBACK` 过**（`migrateRouteStateSchema` 的 `defer`）⇒ 盘上
    ///     要么是旧 schema、要么是新 schema，不存在半份；重开只是把同一条幂等判定再跑一次。
    ///   - `PRAGMA user_version` 是幂等标记 ⇒ 已升级的库不会被升第二次。
    ///   - 这里**不删任何文件**。打不开就是打不开：不做"删库重来"（那会丢掉盘上那批进度，
    ///     而进度正是续传的全部依据）。
    ///
    /// - Returns: 重开之后是否可用。失败时 `lastError` 已写明原因。
    @discardableResult
    func reopenIfUnavailable() -> Bool {
        guard !isAvailable else { return true }
        open()
        return isAvailable
    }

    /// `sync_route_state` 在 v1 只有 `workout_uuid` 主键。不能靠新的 CREATE TABLE IF NOT EXISTS
    /// 修复已安装设备，因为 SQLite 会保留旧表。v2 使用 `(scope, workout_uuid)`，旧行不归属于
    /// 任意新 scope，迁移时安全丢弃（下一次每个 workout 都会按 UNKNOWN 首查）。
    ///
    /// 用 `PRAGMA user_version` 做一次性、幂等标记；旧表先改名再创建，避免在同一事务中把旧行
    /// 误归到当前 scope。旧 index 也显式删除，防止改名表留下同名 index 阻塞新建。
    private func migrateRouteStateSchema() -> Bool {
        guard let database else { return false }
        guard let versionStatement = SQLiteSupport.prepare("PRAGMA user_version", database: database) else {
            return false
        }
        let version = sqlite3_step(versionStatement) == SQLITE_ROW
            ? Int(sqlite3_column_int64(versionStatement, 0)) : 0
        sqlite3_finalize(versionStatement)
        if version >= Self.schemaVersion {
            return ensureRouteStateSchema(database: database)
        }
        guard SQLiteSupport.execute("BEGIN IMMEDIATE", database: database) else { return false }
        var committed = false
        defer {
            if !committed { _ = SQLiteSupport.execute("ROLLBACK", database: database) }
        }

        var hasRouteTable = false
        var hasScopeColumn = false
        if let statement = SQLiteSupport.prepare("PRAGMA table_info(sync_route_state)", database: database) {
            while sqlite3_step(statement) == SQLITE_ROW {
                hasRouteTable = true
                if let pointer = sqlite3_column_text(statement, 1), String(cString: pointer) == "scope" {
                    hasScopeColumn = true
                }
            }
            sqlite3_finalize(statement)
        }
        if hasRouteTable && !hasScopeColumn {
            guard SQLiteSupport.execute(
                "DROP INDEX IF EXISTS idx_route_status_cooling; "
                    + "ALTER TABLE sync_route_state RENAME TO sync_route_state_legacy",
                database: database
            ) else { return false }
            // 旧行故意不 INSERT SELECT：它们没有可信 scope，归属未知只能触发一次安全重查。
            guard SQLiteSupport.execute("DROP TABLE sync_route_state_legacy", database: database) else {
                return false
            }
        }
        guard ensureRouteStateSchema(database: database) else { return false }
        guard SQLiteSupport.execute("PRAGMA user_version = 2", database: database) else { return false }
        guard SQLiteSupport.execute("COMMIT", database: database) else { return false }
        committed = true
        return true
    }

    private func ensureRouteStateSchema(database: OpaquePointer) -> Bool {
        SQLiteSupport.execute("""
            CREATE TABLE IF NOT EXISTS sync_route_state (
                scope TEXT NOT NULL,
                workout_uuid TEXT NOT NULL,
                workout_end_date REAL NOT NULL,
                route_status TEXT NOT NULL,
                point_count INTEGER NOT NULL,
                route_hash TEXT,
                last_checked_at REAL NOT NULL,
                stable_check_count INTEGER NOT NULL,
                PRIMARY KEY (scope, workout_uuid)
            );
            CREATE INDEX IF NOT EXISTS idx_route_status_cooling
                ON sync_route_state(scope, route_status, last_checked_at);
            CREATE TABLE IF NOT EXISTS sync_route_discovery (
                scope TEXT PRIMARY KEY NOT NULL,
                last_workout_uuid TEXT NOT NULL
            );
            """, database: database)
        guard ensurePendingRouteColumns(database: database) else { return false }
        return true
    }

    /// R07（2026-10-16）：`sync_pending_routes` 的调度列**幂等补齐**。
    ///
    /// 判据就是表自己（`PRAGMA table_info`）：这组列是**纯追加**（每列可空），对已有行无损，
    /// 缺哪列补哪列。⛔ 不要用 `user_version` 升版本替代它 —— 那会让"旧表"与"新表"在版本号上
    /// 前缀相同、内容不同，反而要再造一个版本；而这个检查天然幂等（已补齐 ⇒ 零次 ALTER）。
    private func ensurePendingRouteColumns(database: OpaquePointer) -> Bool {
        guard let statement = SQLiteSupport.prepare(
            "PRAGMA table_info(sync_pending_routes)", database: database
        ) else { return false }
        var columns = Set<String>()
        while sqlite3_step(statement) == SQLITE_ROW {
            if let pointer = sqlite3_column_text(statement, 1) {
                columns.insert(String(cString: pointer))
            }
        }
        sqlite3_finalize(statement)
        let additions: [(name: String, type: String)] = [
            ("sched_state", "TEXT"),
            ("attempt_count", "INTEGER"),
            ("last_attempt_at", "REAL"),
            ("next_retry_at", "REAL"),
            ("blocked_budget_fingerprint", "TEXT")
        ]
        for (name, type) in additions where !columns.contains(name) {
            guard SQLiteSupport.execute(
                "ALTER TABLE sync_pending_routes ADD COLUMN \(name) \(type)",
                database: database
            ) else { return false }
        }
        return true
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

    /// 只读：这一 scope 上**有没有**任务行。
    ///
    /// 与 `load(scope:)` 的区别不是省一次解码，而是**失败可表达**：`load` 返回 `nil` 时
    /// "没有行"与"读不出来"是同一种形状，而调用方（`probePendingWork`）必须能把它们分开
    /// —— 前者允许说"没有待办"，后者只能报"不知道"。
    ///
    /// - Returns: `true` / `false` 是确定结论；`nil` 表示读取失败（`lastError` 已写明）。
    func hasTask(scope: String) -> Bool? {
        guard let statement = prepare("SELECT 1 FROM sync_tasks WHERE scope = ?") else { return nil }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        guard lastError == nil else { return nil }
        let result = sqlite3_step(statement)
        if result == SQLITE_ROW { return true }
        if result == SQLITE_DONE { return false }
        fail("probe")
        return nil
    }

    /// 只读：库里**存在任何**任务行（不区分 scope）。
    ///
    /// 存在的理由只有一个：**身份未知时**（没有离线握手）探针只知道 URL scope，按它读不到行
    /// 并不能推出"盘上没有待办" —— 那一行可能正躺在某个 `syncScope` 下等着续传。这条查询
    /// 就是"到底有没有归属不明的批次"的唯一旁证，而少了它，探针在身份未知时只能永远报
    /// "不知道"，那会把重排变成每 15 分钟一次、永不停歇的空转。
    ///
    /// - Returns: `true` / `false` 是确定结论；`nil` 表示读取失败。
    func hasAnyTask() -> Bool? {
        guard let statement = prepare("SELECT 1 FROM sync_tasks LIMIT 1") else { return nil }
        defer { sqlite3_finalize(statement) }
        let result = sqlite3_step(statement)
        if result == SQLITE_ROW { return true }
        if result == SQLITE_DONE { return false }
        fail("probe any")
        return nil
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

    // MARK: - 导出水位与成功提交（V2.1 §2「单状态源真相」）

    /// 与任务进度同库的那份已提交水位。
    ///
    /// 为什么它要搬进来：任务进度一直在 `sync_tasks`（SQLite/WAL），而 anchor 与导出水位
    /// 在 `UserDefaults` —— 于是「这次同步已提交」这件事被拆成**跨两个存储的两步写**。
    /// 两个方向都不写坏数据（anchor 新、行还在 ⇒ 幂等重跑；行没了、anchor 旧 ⇒ 重导一段），
    /// 所以它此前没被当成缺陷；但没有第三个存储能同时给出"这两个值属于同一次提交"这个事实。
    struct CommittedState: Equatable {
        var workoutAnchor: Data? = nil
        var exportEnd: Date? = nil
    }

    /// 读已提交的水位。`nil` 表示**这个 scope 还没有任何一行**（不是"两个字段都是空"——
    /// `anchor` 与 `export_end` 各自都可以合法地为空，见 `SyncWatermarkUpdate`）。
    /// 迁移期 `HealthKitSync` 靠这个区分来退回读老 `UserDefaults` 键。
    func loadState(scope: String) -> CommittedState? {
        guard let statement = prepare(
            "SELECT workout_anchor, export_end FROM sync_state WHERE scope = ?"
        ) else { return nil }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        let result = sqlite3_step(statement)
        if result == SQLITE_DONE { return nil }
        guard result == SQLITE_ROW else { fail("read state"); return nil }
        var state = CommittedState()
        if sqlite3_column_type(statement, 0) != SQLITE_NULL {
            let length = Int(sqlite3_column_bytes(statement, 0))
            if length > 0, let pointer = sqlite3_column_blob(statement, 0) {
                state.workoutAnchor = Data(bytes: pointer, count: length)
            } else if length == 0 {
                state.workoutAnchor = Data()
            }
        }
        if sqlite3_column_type(statement, 1) != SQLITE_NULL {
            state.exportEnd = Date(timeIntervalSince1970: sqlite3_column_double(statement, 1))
        }
        return state
    }

    /// 只清**跑步 anchor**，保留 `export_end`（2026-10-17 定点修复用）。
    ///
    /// 🔴 不能走 `commitSuccess(anchor: nil)`：那里 `nil` 的语义是 **`.keep`**（保留），
    /// 走它等于什么都没做，而且读回自检还会通过 —— 一个"看起来成功了"的空操作。
    /// 写后必须读回：修复失败要能被调用方看见，不能让游标停在半清状态。
    @discardableResult
    func clearWorkoutAnchor(scope: String) -> Bool {
        lastError = nil
        guard let statement = prepare("UPDATE sync_state SET workout_anchor = NULL WHERE scope = ?") else {
            return false
        }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        guard sqlite3_step(statement) == SQLITE_DONE else {
            fail("clear workout anchor")
            return false
        }
        let readBack = loadState(scope: scope)
        guard lastError == nil, readBack?.workoutAnchor == nil else {
            lastError = "跑步游标修复后无法读回一致的值。"
            return false
        }
        return true
    }

    /// 只清**指定类型**的记录游标，其余类型逐字节保留（2026-10-17 定点修复用）。
    ///
    /// 用 `JSONSerialization` 而不是 `JSONDecoder([String: HealthKitRecordCursor])`：
    /// 本文件被若干**不含** `HealthKitRecordCursor.swift` 的编译单元引用，引具体类型会让
    /// 那些单元编译不过。JSON 是"字符串键 + 值"的结构，删键不需要知道值的形状。
    /// 写后读回比较的是**我们写下去的那份字节**，所以编码顺序不影响判据。
    @discardableResult
    func clearRecordCursors(_ types: [String], scope: String) -> Bool {
        guard !types.isEmpty else { return true }
        lastError = nil
        guard let payload = loadRecordCursors(scope: scope) else {
            // 没有 payload = 没有游标可清（首装）。`loadRecordCursors` 的失败会置 lastError。
            return lastError == nil
        }
        guard var object = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any] else {
            lastError = "健康记录游标无法解码，修复失败。"
            return false
        }
        for type in types { object.removeValue(forKey: type) }
        guard let encoded = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
            lastError = "健康记录游标无法重新编码。"
            return false
        }
        guard writeRecordCursors(encoded, scope: scope) else { return false }
        guard let readBack = loadRecordCursors(scope: scope), readBack == encoded else {
            lastError = "记录游标修复后无法读回一致的值。"
            return false
        }
        return true
    }

    /// 成功收尾的**单事务**提交：水位前进 + 任务行清空，要么都成、要么都不成。
    ///
    /// 三条护栏缺一不可，且顺序有讲究：
    ///
    /// ① **单事务**。两份状态在语义上是"这次同步已提交"的两半，拆开就还有窗口。
    ///    真正要挡的窗口是"任务行删成功、水位写失败" ⇒ 旧 anchor + 无任务 +
    ///    界面报成功 ⇒ 每次同步重导同一段；而导出里带 `<ExportDate>`（墙钟）⇒
    ///    `payloadHash` 每次都变 ⇒ **服务端每次新建一份导入来源**。用户看不到任何异常。
    ///
    /// ② **提交前**回读断言，不是提交后。提交之后再断言，失败就会把一份**已经成功入库**的
    ///    数据报成"同步失败"，而 `markSuccess` 早已写好"上次同步：刚刚"⇒ 同屏两个相反导向。
    ///    放在 `COMMIT` 之前，失败则整段回滚，异常方向就只有"这次没提交上"。
    ///
    /// ③ `changes()` 必须校验。UPSERT 影响 0 行、或 `DELETE` 删掉 0 行，都说明
    ///    "我以为提交了"是假的（scope 错位、盘上根本没有这一轮的任务）。它在原地是**静默**的：
    ///    `clear(scope:)` 只判 `sqlite3_step == SQLITE_DONE`，删 0 行同样返回成功。
    ///
    /// - Parameter anchor: `nil` 表示**保留**已提交的 anchor（不是"写成空"）。
    /// - Parameter continuationPending: 本批提交后是否仍**悬着未读的页**（S2.3）。
    ///   `true` 写待续哨兵、`false` 清掉同 scope 的旧哨兵 —— 与游标在**同一个事务**里落账：
    ///   拆开就会出现"游标已提交、待续标记没写上"的窗口，而那个窗口里没人会去读剩下的页。
    ///   默认 `false`：既有的调用点（恢复/无导出轮次）不产生新的待续，且会**清掉**完成后的旧标记。
    @discardableResult
    func commitSuccess(scope: String, anchor: Data?, watermark requested: SyncWatermarkUpdate, recordCursors: Data? = nil, pendingDeletions: DirectSyncPendingDeletions? = nil, continuationPending: Bool = false, routeSettlement: Data? = nil, routeSettlementBatchId: String = "") -> Bool {
        guard isAvailable, let database else { fail("commit"); return false }
        lastError = nil
        // 🔴 写入前先把时间点吸附到 REAL 列能逐位往返的那一个值上（`Date.canonicalForREAL`）。
        //    少了这一步，`upsertState` 绑定的 `?3` 与 `readBackMatches` 里的期望值会在
        //    最低位上分叉 —— 实测约一半的 `Date()` 往返有损，症状是一次**完全成功的**提交
        //    被判为失败并整段回滚，报「同步水位写入后无法读回一致的值」。
        //    必须在进入时规范化且只做一次：写与回读断言共用同一个数，两侧才同源。
        let watermark = requested.storedInREAL
        guard SQLiteSupport.execute("BEGIN IMMEDIATE", database: database) else {
            fail("begin"); return false
        }
        var committed = false
        defer {
            if !committed {
                // 回滚同样要响亮：失败已经由上面的 fail() 记下，这里只保证没有半份状态留下。
                _ = SQLiteSupport.execute("ROLLBACK", database: database)
            }
        }
        // 事务开始后、写之前先读一次旧值。`BEGIN IMMEDIATE` 已经拿到写锁，所以这次读与
        // 后面的比对之间没有第三方能插进来 —— 回读断言需要"应该写成什么"，而"应该写成什么"
        // 依赖旧值（`.advance` 是单调取大、`.keep` 是不动）。
        let before = loadState(scope: scope)
        guard lastError == nil else { return false }
        guard upsertState(scope: scope, anchor: anchor, watermark: watermark) else { return false }
        guard readBackMatches(scope: scope, before: before, anchor: anchor, watermark: watermark) else {
            lastError = "同步水位写入后无法读回一致的值，本次提交已回滚。"
            return false
        }
        if let recordCursors {
            guard writeRecordCursors(recordCursors, scope: scope),
                  loadRecordCursors(scope: scope) == recordCursors else {
                lastError = "健康记录游标写入后无法读回一致的值，本次提交已回滚。"
                return false
            }
        }
        // 删除暂存（R3b）与游标同一个事务落账。语义三态：`nil` = 不改旧槽（默认，老调用点零变化）；
        // 空 = 清；非空 = 写。写路径**带 readBack 断言**（这是数据——删不掉的引用若不落盘就
        // 随锚点推进永久丢失；与待续标记的"提示性判据"不同级）。清路径不做断言：
        // 旧槽本来就不存在（nil）时删 0 行是期望状态。
        if let pendingDeletions {
            if pendingDeletions.isEmpty {
                guard writePendingDeletions(nil, scope: scope) else {
                    lastError = "删除暂存清空失败，本次提交已回滚。"
                    return false
                }
            } else {
                guard let payload = try? JSONEncoder().encode(pendingDeletions) else {
                    lastError = "删除暂存编码失败，本次提交已回滚。"
                    return false
                }
                guard writePendingDeletions(payload, scope: scope),
                      loadPendingDeletions(scope: scope) == payload else {
                    lastError = "删除暂存写入后无法读回一致的值，本次提交已回滚。"
                    return false
                }
            }
        }
        // 待续标记与游标同一个事务落账（S2.3）。刻意**不做** readBack 断言：它的读点是
        // `probePendingWork` 的提示性判据，错了只会让前台补跑少几轮/多几轮，不是数据正确性
        // 问题；而每条提交都多开一条查询的代价是实打实的。写失败仍然 fail（宁可整段回滚）。
        //
        // 🔴 哨兵条件（R3b）：**槽非空也是「还有未发送的工作」**——删除暂时装不下时
        // `hasMorePages` 可能为 false（页已被接受），只靠 `continuationPending` 会让
        // 后台续批机器看不见它（无人续发的形态与 R1 同族）。把三种「还有活」并成一个哨兵：
        // 续页、本批新暂存的删除、以及"本轮没重估删除但旧槽仍非空"。
        let deletionsStillPending = pendingDeletions.map { !$0.isEmpty } ?? (loadPendingDeletions(scope: scope) != nil)
        guard writeContinuation((continuationPending || deletionsStillPending) ? Self.continuationPendingSentinel : nil, scope: scope) else {
            lastError = "待续标记写入失败，本次提交已回滚。"
            return false
        }
        // 🔴 B01（2026-10-17）：路线结算候选与"任务行删除"**同一事务**写入。
        //
        // 顺序不能反：先删任务行、再另存候选，两者之间退出就同时丢掉任务与候选 —— 那正是
        // §3.2 步骤 5 禁止的形态。候选落在这里之后，即使进程在提交成功后立刻被杀，
        // 下次启动也能只凭本地候选完成结算（不重读 HealthKit）。
        //
        // 语义：`nil` = 本轮没有路线候选（不改旧槽）；非空 = 覆盖写入并**提交前回读**。
        // 回读断言与删除余量同级：候选丢了就等于"这批白读了"，而它承载的正是待办的删除证明。
        if let routeSettlement {
            guard writeRouteSettlement(
                routeSettlement, batchId: routeSettlementBatchId, scope: scope
            ), loadRouteSettlement(scope: scope) == routeSettlement else {
                lastError = "路线结算候选写入后无法读回一致的值，本次提交已回滚。"
                return false
            }
        }
        guard let statement = prepare("DELETE FROM sync_tasks WHERE scope = ?") else { return false }
        bind(scope, to: statement, at: 1)
        let step = sqlite3_step(statement)
        sqlite3_finalize(statement)
        guard step == SQLITE_DONE else { fail("commit clear"); return false }
        let removed = Int(sqlite3_changes(database))
        guard removed == 1 else {
            lastError = "本次提交找不到对应的同步进度记录，已回滚以免水位与进度脱节。"
            SQLiteSupport.report("commit removed \(removed) task row(s)", database: database)
            return false
        }
        guard SQLiteSupport.execute("COMMIT", database: database) else {
            fail("commit"); return false
        }
        committed = true
        return true
    }

    func loadRecordCursors(scope: String) -> Data? {
        guard let statement = prepare("SELECT payload FROM sync_record_cursors WHERE scope = ?") else { return nil }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        let step = sqlite3_step(statement)
        if step == SQLITE_DONE { return nil }
        guard step == SQLITE_ROW else { fail("record cursor read"); return nil }
        let count = Int(sqlite3_column_bytes(statement, 0))
        guard count > 0, let pointer = sqlite3_column_blob(statement, 0) else {
            fail("record cursor payload"); return nil
        }
        return Data(bytes: pointer, count: count)
    }

    private func writeRecordCursors(_ data: Data, scope: String) -> Bool {
        guard !data.isEmpty, data.count <= Int(Int32.max), let database,
              let statement = prepare("""
                INSERT INTO sync_record_cursors(scope, payload) VALUES (?, ?)
                ON CONFLICT(scope) DO UPDATE SET payload = excluded.payload
                """) else { fail("record cursor prepare"); return false }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        let bound = data.withUnsafeBytes {
            sqlite3_bind_blob(statement, 2, $0.baseAddress, Int32(data.count), SQLiteSupport.transient)
        }
        guard bound == SQLITE_OK, sqlite3_step(statement) == SQLITE_DONE,
              sqlite3_changes(database) == 1 else { fail("record cursor write"); return false }
        return true
    }

    // MARK: 分析终态对账槽（§10.1 / §10.2 的「分析另行跟踪」）

    /// 读回上一次对账的结论。`nil` = 这个 scope 还没有过对账。
    ///
    /// 🔴 **为什么必须是与 `sync_tasks` 并列的独立槽，而不是任务行里的一个字段**：
    /// `commitSuccess` 在**同一个事务**里做「水位前进 + 任务行清空」（见上面那段说明）。
    /// 而分析终态对账按设计发生在**游标提交之后** —— 那一刻任务行已经被删掉了。
    /// 把结论塞进任务行有两个后果，两个都不能接受：
    ///   ① 要么把刚清掉的任务行重新写回去，界面于是又说"还卡着一批"（`hasPendingTask`
    ///      与后台意图判据一起被污染），直接推翻本轮"提交即收尾"的结论；
    ///   ② 要么把对账挪到 `commitSuccess` **之前**，于是对账失败会把一次**已经成功入库**
    ///      的同步报成失败 —— 而 §14.2 A17 的"事实已保存"是不许被一个展示动作推翻的。
    /// 独立槽把两件事分开：`sync_tasks` 只活在飞任务，本表只活"已经收尾的那一批分析到哪了"。
    ///
    /// ⚠️ **权威出口只有这一个。** `SyncTaskState.lastAnalysisStatus` 是同一件事在"任务在飞期间"
    /// 的展示依据（T2 加的，合法），但它随任务行一起消失；重启之后能接着对账的只有本表。
    /// 将来若要读分析状态，**读这里**，不要读任务行 —— 两份真相会分叉，而分叉的那一份
    /// 恰好是"重启后看不到"的那一份。
    func loadAnalysisReconcile(scope: String) -> Data? {
        guard let statement = prepare("SELECT payload FROM sync_analysis_reconcile WHERE scope = ?") else { return nil }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        let step = sqlite3_step(statement)
        if step == SQLITE_DONE { return nil }
        guard step == SQLITE_ROW else { fail("analysis reconcile read"); return nil }
        let count = Int(sqlite3_column_bytes(statement, 0))
        guard count > 0, let pointer = sqlite3_column_blob(statement, 0) else {
            fail("analysis reconcile payload"); return nil
        }
        return Data(bytes: pointer, count: count)
    }

    /// 写下（或覆盖）本 scope 的对账结论。返回值必须被检查：调用方不许"以为写上了"。
    @discardableResult
    func saveAnalysisReconcile(_ data: Data, scope: String) -> Bool {
        guard !data.isEmpty, data.count <= Int(Int32.max), let database,
              let statement = prepare("""
                INSERT INTO sync_analysis_reconcile(scope, payload) VALUES (?, ?)
                ON CONFLICT(scope) DO UPDATE SET payload = excluded.payload
                """) else { fail("analysis reconcile prepare"); return false }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        let bound = data.withUnsafeBytes {
            sqlite3_bind_blob(statement, 2, $0.baseAddress, Int32(data.count), SQLiteSupport.transient)
        }
        guard bound == SQLITE_OK, sqlite3_step(statement) == SQLITE_DONE,
              sqlite3_changes(database) == 1 else { fail("analysis reconcile write"); return false }
        return true
    }

    // MARK: 路线结算槽（B01：提交成功但结算未完成的证据）

    /// 读本 scope 的路线结算候选。`nil` = 没有待结算的批次。
    func loadRouteSettlement(scope: String) -> Data? {
        guard let statement = prepare(
            "SELECT payload FROM sync_route_settlements WHERE scope = ?"
        ) else { return nil }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        let step = sqlite3_step(statement)
        if step == SQLITE_DONE { return nil }
        guard step == SQLITE_ROW else { fail("route settlement read"); return nil }
        let count = Int(sqlite3_column_bytes(statement, 0))
        guard count > 0, let pointer = sqlite3_column_blob(statement, 0) else {
            fail("route settlement payload"); return nil
        }
        return Data(bytes: pointer, count: count)
    }

    /// 读本 scope 结算候选的批次身份（诊断用：日志里要能说出"这是哪一批"）。
    func loadRouteSettlementBatchId(scope: String) -> String? {
        guard let statement = prepare(
            "SELECT batch_id FROM sync_route_settlements WHERE scope = ?"
        ) else { return nil }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
        return columnText(statement, 0)
    }

    /// 写（或覆盖）结算候选。**只在 `commitSuccess` 的事务内调用** —— 它必须与任务行删除
    /// 同进同退，否则"提交成功、候选丢失"会让那批路线白读一次。
    private func writeRouteSettlement(_ data: Data, batchId: String, scope: String) -> Bool {
        guard !data.isEmpty, data.count <= Int(Int32.max), let database, let statement = prepare("""
            INSERT INTO sync_route_settlements(scope, batch_id, payload, created_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(scope) DO UPDATE SET
                batch_id = excluded.batch_id,
                payload = excluded.payload,
                created_at = excluded.created_at
            """) else { fail("route settlement prepare"); return false }
        defer { sqlite3_finalize(statement) }
        guard SQLiteSupport.bind(scope, to: statement, at: 1),
              SQLiteSupport.bind(batchId, to: statement, at: 2) else {
            fail("route settlement bind"); return false
        }
        let bound = data.withUnsafeBytes {
            sqlite3_bind_blob(statement, 3, $0.baseAddress, Int32(data.count), SQLiteSupport.transient)
        }
        guard bound == SQLITE_OK,
              sqlite3_bind_double(statement, 4, Date().timeIntervalSince1970) == SQLITE_OK,
              sqlite3_step(statement) == SQLITE_DONE,
              sqlite3_changes(database) == 1 else {
            fail("route settlement write"); return false
        }
        return true
    }

    /// 清结算候选。**只能在一批真正结算成功之后调用**：删早了就等于放弃那份删除证明，
    /// 下一次重读 HealthKit 才能补回来。幂等：没有行时删除影响 0 行也算成功。
    @discardableResult
    func clearRouteSettlement(scope: String) -> Bool {
        guard isAvailable, database != nil else { fail("route settlement clear"); return false }
        guard let statement = prepare(
            "DELETE FROM sync_route_settlements WHERE scope = ?"
        ) else { return false }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        guard sqlite3_step(statement) == SQLITE_DONE else {
            fail("route settlement clear"); return false
        }
        return true
    }

    // MARK: 待续页槽（S2.3：连续分页尚未 drain 完）

    /// 待续标记的哨兵 payload（内容无意义，**存在性即语义**；用 JSON 是为了诊断可读）。
    private static let continuationPendingSentinel = Data("{\"pending\":true}".utf8)

    /// 读"待续"标记。`nil` = 这个 scope 没有悬着的续页（或从没有过）。
    ///
    /// 🔴 为什么必须是与 `sync_tasks` 并列的独立槽：成功提交会**删掉任务行**
    /// （`commitSuccess` 的事务），而"还有页没读完"恰恰产生于一次**成功提交之后**
    /// （本轮的导出被 `DirectSyncBatchBudget` 截断）。待续标记如果只活在任务行里，
    /// 提交那一刻它就和行一起消失 —— 前台补跑与后台唤醒都失去判据，剩下的页再也没人读。
    ///
    /// ⚠️ 与"后台意图"（`BackgroundIntentStore`）的分工：意图回答"这个目标还有没有活"
    /// （粗糙、两种成因混装），本槽回答"活是不是**只是自己没读完**" ——
    /// 前台补跑额度按它分账（见 `SyncFollowUp.handoff`）。
    func loadContinuation(scope: String) -> Data? {
        guard let statement = prepare("SELECT payload FROM sync_continuation WHERE scope = ?") else { return nil }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        let step = sqlite3_step(statement)
        if step == SQLITE_DONE { return nil }
        guard step == SQLITE_ROW else { fail("continuation read"); return nil }
        let count = Int(sqlite3_column_bytes(statement, 0))
        guard count > 0, let pointer = sqlite3_column_blob(statement, 0) else {
            fail("continuation payload"); return nil
        }
        return Data(bytes: pointer, count: count)
    }

    /// 写/清待续标记（只在 `commitSuccess` 的事务内调用）。
    ///
    /// 语义是二态：`Data` = 悬着（本批提交后仍有未读页）；`nil` = 清。
    /// 清 = **删行**（"没有行"与"有行"是两种形状，前者才是"没有待续"的正典 ——
    /// 与 `loadTask` 的纪律同源：读的人必须能分清"未记录"与"记录为否"）。
    private func writeContinuation(_ data: Data?, scope: String) -> Bool {
        if let data, !data.isEmpty {
            guard data.count <= Int(Int32.max), let database,
                  let statement = prepare("""
                    INSERT INTO sync_continuation(scope, payload) VALUES (?, ?)
                    ON CONFLICT(scope) DO UPDATE SET payload = excluded.payload
                    """) else { fail("continuation prepare"); return false }
            defer { sqlite3_finalize(statement) }
            bind(scope, to: statement, at: 1)
            let bound = data.withUnsafeBytes {
                sqlite3_bind_blob(statement, 2, $0.baseAddress, Int32(data.count), SQLiteSupport.transient)
            }
            guard bound == SQLITE_OK, sqlite3_step(statement) == SQLITE_DONE,
                  sqlite3_changes(database) == 1 else { fail("continuation write"); return false }
            return true
        }
        guard let statement = prepare("DELETE FROM sync_continuation WHERE scope = ?") else { return false }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        // ⚠️ 删 0 行**不是**错误（本来就没有待续）—— 与 `DELETE FROM sync_tasks` 的
        // `changes() == 1` 纪律刻意不同：那里的 0 行意味着"找不到本轮任务行"（错位），
        // 这里的 0 行意味着"已经是干净的"，正是期望状态。
        guard sqlite3_step(statement) == SQLITE_DONE else { fail("continuation clear"); return false }
        return true
    }

    // MARK: 删除暂存槽（R3b：删除引用装不下时的持久溢出）

    /// 读删除暂存。`nil` = 这个 scope 没有暂存的删除（或从没有过）。
    ///
    /// 与 `loadContinuation` 不同，这里读的是**载荷本身**（`DirectSyncPendingDeletions` 的 JSON），
    /// 因为下一批要把这些引用**真的发出去** —— 不是只回答"有没有活"。
    func loadPendingDeletions(scope: String) -> Data? {
        guard let statement = prepare("SELECT payload FROM sync_pending_deletions WHERE scope = ?") else { return nil }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        let step = sqlite3_step(statement)
        if step == SQLITE_DONE { return nil }
        guard step == SQLITE_ROW else { fail("pending deletions read"); return nil }
        let count = Int(sqlite3_column_bytes(statement, 0))
        guard count > 0, let pointer = sqlite3_column_blob(statement, 0) else {
            fail("pending deletions payload"); return nil
        }
        return Data(bytes: pointer, count: count)
    }

    /// 写/清删除暂存（只在 `commitSuccess` 的事务内调用）。`nil` = 清（删行），
    /// 与 `writeContinuation` 同一条纪律：删 0 行不是错误（"已经是干净的"正是期望状态）。
    private func writePendingDeletions(_ data: Data?, scope: String) -> Bool {
        if let data, !data.isEmpty {
            guard data.count <= Int(Int32.max), let database,
                  let statement = prepare("""
                    INSERT INTO sync_pending_deletions(scope, payload) VALUES (?, ?)
                    ON CONFLICT(scope) DO UPDATE SET payload = excluded.payload
                    """) else { fail("pending deletions prepare"); return false }
            defer { sqlite3_finalize(statement) }
            bind(scope, to: statement, at: 1)
            let bound = data.withUnsafeBytes {
                sqlite3_bind_blob(statement, 2, $0.baseAddress, Int32(data.count), SQLiteSupport.transient)
            }
            guard bound == SQLITE_OK, sqlite3_step(statement) == SQLITE_DONE,
                  sqlite3_changes(database) == 1 else { fail("pending deletions write"); return false }
            return true
        }
        guard let statement = prepare("DELETE FROM sync_pending_deletions WHERE scope = ?") else { return false }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        guard sqlite3_step(statement) == SQLITE_DONE else { fail("pending deletions clear"); return false }
        return true
    }

    /// `?5` 三种模式：0 保留 / 1 前进（单调） / 2 清空。用编号参数是因为 `?5` 出现两次。
    private func upsertState(scope: String, anchor: Data?, watermark: SyncWatermarkUpdate) -> Bool {
        guard let statement = prepare("""
            INSERT INTO sync_state(scope, workout_anchor, export_end, updated_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(scope) DO UPDATE SET
                workout_anchor = CASE WHEN ?2 IS NULL
                                      THEN sync_state.workout_anchor
                                      ELSE excluded.workout_anchor END,
                export_end = CASE
                    WHEN ?5 = 0 THEN sync_state.export_end
                    WHEN ?5 = 2 THEN NULL
                    WHEN sync_state.export_end IS NULL THEN excluded.export_end
                    WHEN excluded.export_end > sync_state.export_end THEN excluded.export_end
                    ELSE sync_state.export_end
                END,
                updated_at = excluded.updated_at
            """) else { return false }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        if let anchor {
            guard anchor.count <= Int(Int32.max) else { fail("state anchor too large"); return false }
            // ⚠️ `sqlite3_bind_blob` 必须在 `withUnsafeBytes` **闭包内**调用：`baseAddress`
            // 只在闭包执行期间有效，把它返回出去再绑就是悬垂指针 —— 症状是写进去的 blob
            // 内容不确定，于是同事务内的回读比对失败、整段回滚（`save(_:scope:)` 也是这个形状）。
            let bound = anchor.withUnsafeBytes { buffer in
                sqlite3_bind_blob(statement, 2, buffer.baseAddress, Int32(anchor.count), SQLiteSupport.transient)
            }
            guard bound == SQLITE_OK else { fail("state anchor bind"); return false }
        } else {
            sqlite3_bind_null(statement, 2)
        }
        let mode: Int32
        switch watermark {
        case .keep: mode = 0
        case .advance(let end): mode = 1; sqlite3_bind_double(statement, 3, end.timeIntervalSince1970)
        case .clear: mode = 2
        }
        if mode != 1 { sqlite3_bind_null(statement, 3) }
        sqlite3_bind_double(statement, 4, Date().timeIntervalSince1970)
        sqlite3_bind_int(statement, 5, mode)
        guard sqlite3_step(statement) == SQLITE_DONE else { fail("state upsert"); return false }
        let touched = Int(sqlite3_changes(database))
        guard touched == 1 else {
            lastError = "同步水位未能写入，本次提交已回滚。"
            SQLiteSupport.report("state upsert touched \(touched) row(s)", database: database)
            return false
        }
        return true
    }

    /// 事务内回读比对，比的是**应该写成的值**而不是"请求的值"。
    ///
    /// 两者的差别就在单调性上：`.advance` 是把水位往前推，请求一个**更早**的时间点时
    /// 正确结果是"提交成功、值停在更晚的那一个"。如果拿请求值去比，这条合法路径会被判成
    /// 写入失败并回滚 —— 一次本该成功的同步报错，且下次唤醒再重导一遍。
    private func readBackMatches(
        scope: String,
        before: CommittedState?,
        anchor: Data?,
        watermark: SyncWatermarkUpdate
    ) -> Bool {
        guard let written = loadState(scope: scope) else {
            SQLiteSupport.report("state row unreadable inside the commit", database: database)
            return false
        }
        // `anchor: nil` 的意思是"保留"，所以它必须等于旧值（旧值可能本来就没有）。
        let expectedAnchor = anchor ?? before?.workoutAnchor
        guard written.workoutAnchor == expectedAnchor else {
            // 不留白：这条断言此前失败时只在 `lastError` 里留一句话，日志里分不清是哪一侧
            // 不匹配（2026-09-24 的真机故障就因此只能靠读源码推）。只在失败路径打，内容是长度。
            NSLog(
                "[RAI] anchor read-back mismatch: written=%d bytes expected=%d bytes",
                written.workoutAnchor?.count ?? -1,
                expectedAnchor?.count ?? -1
            )
            return false
        }
        switch watermark {
        case .keep:
            guard written.exportEnd == before?.exportEnd else {
                reportWatermarkMismatch("keep", written: written.exportEnd, expected: before?.exportEnd)
                return false
            }
            return true
        case .clear:
            guard written.exportEnd == nil else {
                reportWatermarkMismatch("clear", written: written.exportEnd, expected: nil)
                return false
            }
            return true
        case .advance(let requested):
            let expected = before?.exportEnd.map { max($0, requested) } ?? requested
            guard written.exportEnd == expected else {
                reportWatermarkMismatch("advance", written: written.exportEnd, expected: expected)
                return false
            }
            return true
        }
    }

    /// 水位回读不一致时的**具名**诊断：哪一侧、差多少。
    ///
    /// 为什么可以打具体数值：这里是失败路径，且时间是水位而不是健康数据 ——
    /// `SQLiteSupport.report` 的"Codes only"口径是为了不把健康数据路径漏进 release 日志，
    /// 而 `%.17g` 打出来的十七位有效数字正是"是不是被 REAL 往返舍掉了最低位"的唯一判据。
    /// 缺了它，这条断言只能给出「无法读回一致的值」这样一句无从下手的话。
    private func reportWatermarkMismatch(_ mode: String, written: Date?, expected: Date?) {
        // 打 `timeIntervalSinceReferenceDate` 而**不是** `timeIntervalSince1970`：
        // `Date` 内部存的就是前者，而"被 REAL 往返舍掉一位"这件事恰好只在这个口径上可见。
        // 2026-09-24 实测：两个不相等的 Date 可以有**逐位相同**的 `timeIntervalSince1970`
        // （都是 1790000000）—— 用后者打日志只会得到 "written=1790000000 expected=1790000000"
        // 这种什么都没说的输出，正好把这次要查的东西藏起来。
        NSLog(
            "[RAI] watermark read-back mismatch (%@): written=%.17g expected=%.17g",
            mode,
            written?.timeIntervalSinceReferenceDate ?? .nan,
            expected?.timeIntervalSinceReferenceDate ?? .nan
        )
    }

    // MARK: - Workout 伴生 Route 状态（按 workout 定频，替代固定 14 天全量回填）

    /// 分块大小。`IN (?,?,…)` 的变量数有上限（旧版 SQLite 是 999），而"重新导入全部"时
    /// 待查 uuid 可能上千。分块是**为了一次不超限**，不是 N+1：一次常规同步的 workout 数
    /// 是个位数，一个块就装完。
    private static let routeStateChunkSize = 400

    /// 有界历史候选队列的位置。与观测状态分开：不可读的 workout 也要跨过，
    /// 但绝不能为它伪造 lastCheckedAt 或稳定证据。
    func loadRouteDiscoveryCursor(scope: String) -> String? {
        guard isAvailable,
              let statement = prepare("SELECT last_workout_uuid FROM sync_route_discovery WHERE scope = ?")
        else { return nil }
        defer { sqlite3_finalize(statement) }
        guard SQLiteSupport.bind(scope, to: statement, at: 1) else {
            fail("route discovery cursor bind"); return nil
        }
        let step = sqlite3_step(statement)
        if step == SQLITE_DONE { return nil }
        guard step == SQLITE_ROW else { fail("read route discovery cursor"); return nil }
        return columnText(statement, 0)
    }

    /// 读伴生状态。
    ///
    /// - Parameter uuids: 传 `nil` 读**全部**。管线走这条路：导出跑在脱离主线程的上下文里
    ///   （`HealthSyncCancellation.runDetached`），那里碰不了 `@MainActor` 的 store，
    ///   所以状态必须在导出**开始前**整批取出来。表很小（每 workout 一行，量级 = 累计跑步
    ///   次数），整表读比"导出中发现一个 uuid 再回头查一次库"更省，也少一层跨 actor 往返。
    ///   传具体 uuid 则只读这一批（回归与定点核对用）。
    func loadRouteStates(scope: String, uuids: [String]? = nil) -> [String: RouteSyncRecord] {
        guard isAvailable else { return [:] }
        let columns = """
            SELECT workout_uuid, workout_end_date, route_status, point_count, \
            route_hash, last_checked_at, stable_check_count FROM sync_route_state
            """
        var result: [String: RouteSyncRecord] = [:]
        guard let uuids else {
            guard let statement = prepare("\(columns) WHERE scope = ?") else { return [:] }
            defer { sqlite3_finalize(statement) }
            bind(scope, to: statement, at: 1)
            readRouteStates(into: &result, from: statement)
            return result
        }
        guard !uuids.isEmpty else { return [:] }
        var offset = 0
        while offset < uuids.count {
            let chunk = Array(uuids[offset..<min(offset + Self.routeStateChunkSize, uuids.count)])
            offset += chunk.count
            let placeholders = Array(repeating: "?", count: chunk.count).joined(separator: ", ")
            guard let statement = prepare("\(columns) WHERE scope = ? AND workout_uuid IN (\(placeholders))") else { continue }
            defer { sqlite3_finalize(statement) }
            var bound = true
            guard SQLiteSupport.bind(scope, to: statement, at: 1) else { continue }
            for (index, uuid) in chunk.enumerated() where !SQLiteSupport.bind(uuid, to: statement, at: Int32(index + 2)) {
                bound = false
                break
            }
            guard bound else { continue }
            readRouteStates(into: &result, from: statement)
        }
        return result
    }

    /// 把 `SELECT` 的结果集读进字典。抽出来是为了让"读全部"与"读一批"共用同一套列序，
    /// 列序只在 `loadRouteStates` 的 SQL 里出现一次。
    private func readRouteStates(into result: inout [String: RouteSyncRecord], from statement: OpaquePointer) {
        while true {
            let step = sqlite3_step(statement)
            if step == SQLITE_DONE { return }
            guard step == SQLITE_ROW else { fail("read route states"); return }
            guard let uuidPointer = sqlite3_column_text(statement, 0) else { continue }
            let uuid = String(cString: uuidPointer)
            // 落盘值不在闭集里 ⇒ 这一行**不能猜**。当作"从未观测"，于是下一轮会重查一次。
            // 方向是安全的（多查一次），代价是一次查询；这里必须**留下痕迹**而不是静默跳过，
            // 否则"状态机永远没生效"会表现成"路线查得莫名其妙的勤"，查无实据。
            guard let status = RouteSyncStatus(rawValue: columnText(statement, 2) ?? "") else {
                SQLiteSupport.report("route state row with unknown status", database: database)
                continue
            }
            result[uuid] = RouteSyncRecord(
                workoutUUID: uuid,
                workoutEndDate: Date(timeIntervalSince1970: sqlite3_column_double(statement, 1)),
                status: status,
                pointCount: Int(sqlite3_column_int64(statement, 3)),
                routeHash: columnText(statement, 4),
                lastCheckedAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 5)),
                stableCheckCount: Int(sqlite3_column_int64(statement, 6))
            )
        }
    }

    /// TEXT 列 → `String?`。**必须在 `sqlite3_step` 之前**把 `String` 建出来：
    /// `sqlite3_column_text` 返回的指针在下一次 step / finalize 之后即失效。
    private func columnText(_ statement: OpaquePointer, _ index: Int32) -> String? {
        guard sqlite3_column_type(statement, index) != SQLITE_NULL,
              let pointer = sqlite3_column_text(statement, index) else { return nil }
        return String(cString: pointer)
    }

    /// 一批伴生状态的**单事务**写入。
    ///
    /// 为什么必须是一个事务：这批记录是"这一轮同步看到了什么"的同一份快照。半批落盘意味着
    /// 一部分 workout 的记忆前进、另一部分停在过去 —— 下一次同步里，前者可能刚好处在
    /// 冷却期的跳过窗口而后者不跳，于是同一份载荷的 route 集合会反过来取决于"上次写到哪儿"。
    /// 单事务把它变成全有或全无。
    ///
    /// 三条护栏与 `commitSuccess` 同源（ADR-004 决策一）：单事务、**提交前**回读断言、
    /// `changes()` 逐行校验。
    @discardableResult
    func upsertRouteStates(
        _ specified: [RouteSyncRecord],
        scope: String,
        discoveryCursor: String? = nil,
        // 🔴 R03（2026-10-16 复查）：待办移除与状态落盘**必须在同一个本地短事务里**。
        // 旧形态是 `HealthKitSync` 里的两次独立写：状态落盘失败只 NSLog、待办照删 ——
        // 那条"读取失败"的路线既没有状态又没了待办，而**无状态行**的 UUID 只能靠待办
        // 队列被发现（`rediscoveryCandidates` 只遍历已有状态行）⇒ 永久不可发现。
        // 现在状态侧任何一步失败 ⇒ 整个事务 ROLLBACK ⇒ 待办原样保留（下批重查，幂等）。
        // 默认空 = 只写状态（既有调用点/测试语义不变）。
        removePendingTodos: [String] = []
    ) -> Bool {
        guard isAvailable, let database else { fail("route state upsert"); return false }
        guard !specified.isEmpty || discoveryCursor != nil || !removePendingTodos.isEmpty else { return true }
        lastError = nil
        // 🔴 与 `commitSuccess` 同源的一步：两个时间列都是 REAL，而 `Date` ↔
        //    `timeIntervalSince1970` 的往返**不是双射**（实测约一半有损，见
        //    `Date.canonicalForREAL`）。这两个字段的来源都是 `Date()`
        //    （`HealthKitExport` 的 `routeNow`），所以下面那句 `written[...] == record`
        //    会按约一半的概率把一次成功的写入判成失败并回滚 ——
        //    这正是报「路线同步状态写入后无法读回一致的值」的那条路径。
        //    注意规范化必须落在 `records` 本身而不是只落在绑定上：比较用的是 `record`，
        //    只把绑定的值吸附掉，比较就会拿原始值去比盘上的规范值，照样不相等。
        //    `workoutUUID` / `workoutEndDate` 是 `let`，所以只能显式重建；重建时**每个字段
        //    都点名**，将来加字段会编译报错，而不是静默把新字段丢掉。
        let records = specified.map { record in
            RouteSyncRecord(
                workoutUUID: record.workoutUUID,
                workoutEndDate: record.workoutEndDate.canonicalForREAL,
                status: record.status,
                pointCount: record.pointCount,
                routeHash: record.routeHash,
                lastCheckedAt: record.lastCheckedAt.canonicalForREAL,
                stableCheckCount: record.stableCheckCount
            )
        }
        guard SQLiteSupport.execute("BEGIN IMMEDIATE", database: database) else {
            fail("route state begin"); return false
        }
        var committed = false
        defer {
            if !committed { _ = SQLiteSupport.execute("ROLLBACK", database: database) }
        }
        guard let statement = prepare("""
            INSERT INTO sync_route_state(
                scope, workout_uuid, workout_end_date, route_status, point_count,
                route_hash, last_checked_at, stable_check_count
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(scope, workout_uuid) DO UPDATE SET
                workout_end_date = excluded.workout_end_date,
                route_status = excluded.route_status,
                point_count = excluded.point_count,
                route_hash = excluded.route_hash,
                last_checked_at = excluded.last_checked_at,
                stable_check_count = excluded.stable_check_count
            """) else { return false }
        defer { sqlite3_finalize(statement) }
        for record in records {
            sqlite3_reset(statement)
            sqlite3_clear_bindings(statement)
            guard SQLiteSupport.bind(scope, to: statement, at: 1) else {
                fail("route state bind"); return false
            }
            guard SQLiteSupport.bind(record.workoutUUID, to: statement, at: 2) else {
                fail("route state bind"); return false
            }
            guard sqlite3_bind_double(statement, 3, record.workoutEndDate.timeIntervalSince1970) == SQLITE_OK else {
                fail("route state bind"); return false
            }
            guard SQLiteSupport.bind(record.status.rawValue, to: statement, at: 4) else {
                fail("route state bind"); return false
            }
            guard sqlite3_bind_int64(statement, 5, Int64(record.pointCount)) == SQLITE_OK else {
                fail("route state bind"); return false
            }
            // `route_hash` 是 TEXT 而不是 BLOB，所以绑定走 `withCString` + `transient`
            // （由 SQLite 立刻复制）。若哪天改成 BLOB，就必须回到 ADR-004「补充 B」那条：
            // `sqlite3_bind_blob` 要在 `withUnsafeBytes` 闭包**内部**调用。
            if let hash = record.routeHash {
                guard SQLiteSupport.bind(hash, to: statement, at: 6) else {
                    fail("route state bind"); return false
                }
            } else {
                guard sqlite3_bind_null(statement, 6) == SQLITE_OK else {
                    fail("route state bind"); return false
                }
            }
            guard sqlite3_bind_double(statement, 7, record.lastCheckedAt.timeIntervalSince1970) == SQLITE_OK else {
                fail("route state bind"); return false
            }
            guard sqlite3_bind_int64(statement, 8, Int64(record.stableCheckCount)) == SQLITE_OK else {
                fail("route state bind"); return false
            }
            guard sqlite3_step(statement) == SQLITE_DONE else { fail("route state upsert"); return false }
            let touched = Int(sqlite3_changes(database))
            guard touched == 1 else {
                lastError = "路线同步状态未能写入，本次提交已回滚。"
                SQLiteSupport.report("route state upsert touched \(touched) row(s)", database: database)
                return false
            }
        }
        let written = loadRouteStates(scope: scope, uuids: records.map(\.workoutUUID))
        guard lastError == nil else { return false }
        for record in records {
            // `RouteSyncRecord` 是 `Equatable`，两个 `Date` 在这里用**严格 `==`** ——
            // 所以上面必须先把两个时间字段规范化（见 `Date.canonicalForREAL`）。
            //
            // 🔴 2026-09-24 订正：这里原本写着"`Date` 经 REAL 列往返之所以位精确，是因为两个
            // 操作数数量级之比 < 2、减法满足 Sterbenz 引理"，并附"实测 200,000 组（含小数秒、
            // 含 `.distantPast`）0 组有损"。那次实测**没错，但外推错了**：被测的是 HealthKit 的
            // `workout.endDate`，而它几乎总是**整秒** —— 整秒的往返有损率确实就是 0/200000
            // （本次复测一致）。可值一旦带小数秒（`Date()` / `exportedThrough` / `routeNow`
            // 都是），这条推理就不成立：加法那一步结果的 ulp 是原值网格的 2 倍，
            // **恰好一半的位模式会被舍掉**（本次逐 ulp 扫 200,000 个时间戳实测 100,000 有损）。
            // ⇒ **"整秒无损"不能外推成"Date 无损"**。
            //
            // 哪天把时间戳改成别的编码（例如秒×1000 存 INTEGER），这两条推理一起作废，需要重测。
            guard written[record.workoutUUID] == record else {
                lastError = "路线同步状态写入后无法读回一致的值，本次提交已回滚。"
                SQLiteSupport.report("route state read-back mismatch", database: database)
                return false
            }
        }
        if let discoveryCursor {
            guard let cursorStatement = prepare("""
                INSERT INTO sync_route_discovery(scope, last_workout_uuid) VALUES (?, ?)
                ON CONFLICT(scope) DO UPDATE SET last_workout_uuid = excluded.last_workout_uuid
                """) else { return false }
            defer { sqlite3_finalize(cursorStatement) }
            guard SQLiteSupport.bind(scope, to: cursorStatement, at: 1),
                  SQLiteSupport.bind(discoveryCursor, to: cursorStatement, at: 2),
                  sqlite3_step(cursorStatement) == SQLITE_DONE,
                  sqlite3_changes(database) == 1,
                  loadRouteDiscoveryCursor(scope: scope) == discoveryCursor else {
                fail("route discovery cursor upsert"); return false
            }
        }
        // 🔴 R03：待办移除 —— 与状态落盘**同一个事务**（见形参注释）。幂等：不在表里的
        // uuid 删除影响 0 行，照样算成功（重复移除、恢复轮残留都靠它）。提交前回读校验
        // "无残留"；任何一步失败 ⇒ 外层 `defer` 的 ROLLBACK 会把状态与待办**一起**回退
        // ——"状态没写上但待办被删"在结构上不可能发生。
        if !removePendingTodos.isEmpty {
            guard let deleteStatement = prepare(
                "DELETE FROM sync_pending_routes WHERE scope = ? AND workout_uuid = ?"
            ) else { return false }
            defer { sqlite3_finalize(deleteStatement) }
            for uuid in removePendingTodos {
                sqlite3_reset(deleteStatement)
                sqlite3_clear_bindings(deleteStatement)
                guard SQLiteSupport.bind(scope, to: deleteStatement, at: 1),
                      SQLiteSupport.bind(uuid, to: deleteStatement, at: 2),
                      sqlite3_step(deleteStatement) == SQLITE_DONE else {
                    fail("pending routes remove in commit"); return false
                }
            }
            let stillThere = loadPendingRoutes(scope: scope)
            for uuid in removePendingTodos where stillThere[uuid] != nil {
                lastError = "路线待办移除后仍能读回，本次提交已回滚。"
                SQLiteSupport.report("pending routes read-back after commit", database: database)
                return false
            }
        }
        guard SQLiteSupport.execute("COMMIT", database: database) else {
            fail("route state commit"); return false
        }
        committed = true
        return true
    }

    /// 待查路线队列（O02/WP-11 + R07）的**登记/更新**。唯一标识 `(scope, workout_uuid)`
    /// ⇒ 重复登记幂等（`ON CONFLICT` 更新 reason 与调度列，**不刷新 createdAt** —— 年龄是
    /// 公平轮转的依据）。三条护栏与 `upsertRouteStates` 同源：单事务、提交前回读、
    /// `changes()` 逐行校验。
    ///
    /// 🔴 R07：写方必须**给全调度字段**（生产的读-改-写模式 = `loadPendingRoutes` 读出 →
    /// `RouteTodoScheduler` 更新 → 写回）。用三条旧字段构造的 todo（缺调度列）会把既有行的
    /// 调度列**清成 NULL**（= 复位 `ready`）——"清空"本身是 `reopened` 的合法形态（它带
    /// `schedState = .ready`），所以这里用直接覆盖而不是 `COALESCE`（后者会把退避/指纹的
    /// 显式清除也挡掉）。
    @discardableResult
    func upsertPendingRoutes(_ todos: [PendingRouteTodo], scope: String) -> Bool {
        guard isAvailable, let database else { fail("pending routes upsert"); return false }
        guard !todos.isEmpty else { return true }
        lastError = nil
        guard SQLiteSupport.execute("BEGIN IMMEDIATE", database: database) else {
            fail("pending routes begin"); return false
        }
        var committed = false
        defer {
            if !committed { _ = SQLiteSupport.execute("ROLLBACK", database: database) }
        }
        guard let statement = prepare("""
            INSERT INTO sync_pending_routes(
                scope, workout_uuid, reason, created_at,
                sched_state, attempt_count, last_attempt_at, next_retry_at, blocked_budget_fingerprint
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(scope, workout_uuid) DO UPDATE SET
                reason = excluded.reason,
                sched_state = excluded.sched_state,
                attempt_count = excluded.attempt_count,
                last_attempt_at = excluded.last_attempt_at,
                next_retry_at = excluded.next_retry_at,
                blocked_budget_fingerprint = excluded.blocked_budget_fingerprint
            """) else { return false }
        defer { sqlite3_finalize(statement) }
        for todo in todos {
            sqlite3_reset(statement)
            sqlite3_clear_bindings(statement)
            guard SQLiteSupport.bind(scope, to: statement, at: 1),
                  SQLiteSupport.bind(todo.workoutUUID, to: statement, at: 2),
                  SQLiteSupport.bind(todo.reason.rawValue, to: statement, at: 3),
                  // `createdAt` 走与 `upsertRouteStates` 同一份 `canonicalForREAL` 规范化：
                  // REAL 列的往返不是双射，规范化让"首写入的值"可被逐位读回、可被断言。
                  sqlite3_bind_double(statement, 4, todo.createdAt.canonicalForREAL.timeIntervalSince1970) == SQLITE_OK,
                  // R07 调度列：NULL 显式绑定（"未记录"与"记录为空"在列语义上都归一为 NULL，
                  // 读侧统一按 ready 处理 —— 见 `PendingRouteTodo.effectiveState`）。
                  bindOptionalText(todo.schedState?.rawValue, to: statement, at: 5),
                  bindOptionalInt(todo.attemptCount, to: statement, at: 6),
                  bindOptionalReal(todo.lastAttemptAt, to: statement, at: 7),
                  bindOptionalReal(todo.nextRetryAt, to: statement, at: 8),
                  bindOptionalText(todo.blockedBudgetFingerprint, to: statement, at: 9) else {
                fail("pending routes bind"); return false
            }
            guard sqlite3_step(statement) == SQLITE_DONE else {
                fail("pending routes upsert"); return false
            }
            let touched = Int(sqlite3_changes(database))
            guard touched == 1 else {
                lastError = "路线待办未能写入，本次提交已回滚。"
                SQLiteSupport.report("pending routes upsert touched \(touched) row(s)", database: database)
                return false
            }
        }
        // 提交前回读（集合级）：这批 todo 必须逐条在表里。理由：
        // - `createdAt` / 时间类调度列经 REAL 列往返不保证双射（同 `upsertRouteStates` 的
        //   canonicalForREAL 一节），逐字段相等会假红，不比；
        // - `reason` / `sched_state` / `attempt_count` 走 TEXT/INTEGER，**可比且必须比** ——
        //   R07 的调度状态是"下一批查不查这条路线"的唯一依据，写歪一格就是无限续批或误阻塞。
        let written = loadPendingRoutes(scope: scope)
        for todo in todos {
            guard let stored = written[todo.workoutUUID],
                  stored.reason == todo.reason,
                  stored.effectiveState == todo.effectiveState,
                  stored.effectiveAttempts == todo.effectiveAttempts else {
                lastError = "路线待办写入后无法读回一致的值。"
                return false
            }
        }
        guard SQLiteSupport.execute("COMMIT", database: database) else {
            fail("pending routes commit"); return false
        }
        committed = true
        return true
    }

    /// 读待查路线队列（O02/WP-11 + R07）。键 = 小写 workout UUID。
    ///
    /// 老行（R07 之前的表）的新列是 NULL ⇒ 调度字段读成 `nil`，由 `effectiveState` 归一为
    /// **ready** —— "预算不足不能迁移成永久 size 阻塞"的落实点（不信任旧标签，下一轮按
    /// 真实结局重写状态；同时不丢弃任何既有未交付 UUID）。
    func loadPendingRoutes(scope: String) -> [String: PendingRouteTodo] {
        guard isAvailable else { return [:] }
        guard let statement = prepare("""
            SELECT workout_uuid, reason, created_at,
                   sched_state, attempt_count, last_attempt_at, next_retry_at, blocked_budget_fingerprint
            FROM sync_pending_routes WHERE scope = ?
            """) else { return [:] }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        var result: [String: PendingRouteTodo] = [:]
        while true {
            let step = sqlite3_step(statement)
            if step == SQLITE_DONE { return result }
            guard step == SQLITE_ROW else { fail("read pending routes"); return result }
            guard let uuidPointer = sqlite3_column_text(statement, 0) else { continue }
            let uuid = String(cString: uuidPointer)
            let rawReason = columnText(statement, 1) ?? ""
            result[uuid] = PendingRouteTodo(
                workoutUUID: uuid,
                // 未知 reason **兜底不丢**：`reason` 只影响展示，查询动作对所有原因一致；
                // 丢一条待办会让"无状态行"的 UUID 永久不被发现（正是 O02 的病灶形态）。
                reason: PendingRouteTodo.PendingRouteReason(rawValue: rawReason) ?? .routeBudget,
                createdAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 2)),
                // 未知 sched_state（损坏/未来版本）同样兜底为 nil ⇒ ready：给一次机会，
                // 由真实结局重写 —— 保守方向与 reason 的兜底一致（永不把行"卡死"）。
                schedState: columnText(statement, 3)
                    .flatMap(PendingRouteTodo.SchedState.init(rawValue:)),
                attemptCount: sqlite3_column_type(statement, 4) == SQLITE_NULL
                    ? nil : Int(sqlite3_column_int64(statement, 4)),
                lastAttemptAt: sqlite3_column_type(statement, 5) == SQLITE_NULL
                    ? nil : Date(timeIntervalSince1970: sqlite3_column_double(statement, 5)),
                nextRetryAt: sqlite3_column_type(statement, 6) == SQLITE_NULL
                    ? nil : Date(timeIntervalSince1970: sqlite3_column_double(statement, 6)),
                blockedBudgetFingerprint: columnText(statement, 7)
            )
        }
    }

    /// 从待办移除（**批次持久提交之后**调用；O02/WP-11）。
    ///
    /// 幂等：不在表里的 uuid 删除影响 0 行，照样算成功（重复移除、恢复轮残留都靠它）。
    /// 失败方向是安全的（残留 ⇒ 下批多查一次），但依然留痕可诊断。
    @discardableResult
    func removePendingRoutes(_ workoutUUIDs: [String], scope: String) -> Bool {
        guard isAvailable, let database else { fail("pending routes remove"); return false }
        guard !workoutUUIDs.isEmpty else { return true }
        lastError = nil
        guard SQLiteSupport.execute("BEGIN IMMEDIATE", database: database) else {
            fail("pending routes remove begin"); return false
        }
        var committed = false
        defer {
            if !committed { _ = SQLiteSupport.execute("ROLLBACK", database: database) }
        }
        guard let statement = prepare(
            "DELETE FROM sync_pending_routes WHERE scope = ? AND workout_uuid = ?"
        ) else { return false }
        defer { sqlite3_finalize(statement) }
        for uuid in workoutUUIDs {
            sqlite3_reset(statement)
            sqlite3_clear_bindings(statement)
            guard SQLiteSupport.bind(scope, to: statement, at: 1),
                  SQLiteSupport.bind(uuid, to: statement, at: 2) else {
                fail("pending routes remove bind"); return false
            }
            guard sqlite3_step(statement) == SQLITE_DONE else {
                fail("pending routes remove"); return false
            }
        }
        let written = loadPendingRoutes(scope: scope)
        for uuid in workoutUUIDs where written[uuid] != nil {
            lastError = "路线待办移除后仍能读回。"
            return false
        }
        guard SQLiteSupport.execute("COMMIT", database: database) else {
            fail("pending routes remove commit"); return false
        }
        committed = true
        return true
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

    /// R07：可空调度列的三件套 —— NULL **显式绑定**（不依赖"未绑定即 NULL"的默认行为，
    /// 让"未记录"在绑定代码里也是显式的）。
    private func bindOptionalText(_ value: String?, to statement: OpaquePointer, at index: Int32) -> Bool {
        guard let value else { return sqlite3_bind_null(statement, index) == SQLITE_OK }
        return SQLiteSupport.bind(value, to: statement, at: index)
    }

    private func bindOptionalInt(_ value: Int?, to statement: OpaquePointer, at index: Int32) -> Bool {
        guard let value else { return sqlite3_bind_null(statement, index) == SQLITE_OK }
        return sqlite3_bind_int64(statement, index, Int64(value)) == SQLITE_OK
    }

    private func bindOptionalReal(_ value: Date?, to statement: OpaquePointer, at index: Int32) -> Bool {
        // 与 `createdAt` 同一份 `canonicalForREAL` 规范化（REAL 往返非双射）。
        guard let value else { return sqlite3_bind_null(statement, index) == SQLITE_OK }
        return sqlite3_bind_double(statement, index, value.canonicalForREAL.timeIntervalSince1970) == SQLITE_OK
    }
}
