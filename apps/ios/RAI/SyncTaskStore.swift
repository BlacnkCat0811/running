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

    /// 忘掉已提交的水位 ——「重新导入全部」用它。
    ///
    /// 删**整行**而不是把两个字段置空，因为"这一 scope 从未提交过"正是 `HealthKitSync`
    /// 判断"该不该回退去读老 `UserDefaults` 键"的判据（见 `loadCommittedState`）。
    /// 置空会让"还没迁移"与"迁移过、值是空"变成同一种形状，于是老键会被重新读回来。
    ///
    /// 调用方必须**同时**删掉老键，否则回退路径会把刚刚忘掉的锚又读回来。
    @discardableResult
    func forgetState(scope: String) -> Bool {
        guard let statement = prepare("DELETE FROM sync_state WHERE scope = ?") else { return false }
        defer { sqlite3_finalize(statement) }
        bind(scope, to: statement, at: 1)
        let step = sqlite3_step(statement)
        if step != SQLITE_DONE { fail("forget state") }
        return step == SQLITE_DONE
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
    @discardableResult
    func commitSuccess(scope: String, anchor: Data?, watermark requested: SyncWatermarkUpdate, recordCursors: Data? = nil) -> Bool {
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
        _ specified: [RouteSyncRecord], scope: String, discoveryCursor: String? = nil
    ) -> Bool {
        guard isAvailable, let database else { fail("route state upsert"); return false }
        guard !specified.isEmpty || discoveryCursor != nil else { return true }
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
        guard SQLiteSupport.execute("COMMIT", database: database) else {
            fail("route state commit"); return false
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
}
