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
            CREATE TABLE IF NOT EXISTS sync_state (
                scope TEXT PRIMARY KEY,
                workout_anchor BLOB,
                export_end REAL,
                updated_at REAL NOT NULL
            );
            -- Workout 伴生 Route 状态。主键是 workout uuid（小写，口径同
            -- `HealthKitExport.routeFileWorkoutId`）：HealthKit **没有** route anchor，
            -- `HKWorkoutRoute` 是附着在 `HKWorkout` 上的衍生资源，所以这条状态只能挂在
            -- workout 身上。它不是"续传进度"而是"降频记忆"，因此和 `sync_state` 一样必须
            -- 与任务同库 —— 单状态源真相（V2.1 §2 原则 3）。
            CREATE TABLE IF NOT EXISTS sync_route_state (
                workout_uuid TEXT PRIMARY KEY,
                workout_end_date REAL NOT NULL,
                route_status TEXT NOT NULL,
                point_count INTEGER NOT NULL,
                route_hash TEXT,
                last_checked_at REAL NOT NULL,
                stable_check_count INTEGER NOT NULL
            );
            -- `cooling` 的节流判据是"距上次实际查询够久了没"，按 (状态, 上次查询时间) 建索引
            -- 让"这批里哪些该跳过"是一次索引扫描而不是全表扫。表本身很小，但这一条把
            -- 查询形状固化下来，避免以后有人在 SQL 里做函数运算把索引写废。
            CREATE INDEX IF NOT EXISTS idx_route_status_cooling
                ON sync_route_state(route_status, last_checked_at);
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
    func commitSuccess(scope: String, anchor: Data?, watermark: SyncWatermarkUpdate) -> Bool {
        guard isAvailable, let database else { fail("commit"); return false }
        lastError = nil
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
        guard written.workoutAnchor == expectedAnchor else { return false }
        switch watermark {
        case .keep:
            return written.exportEnd == before?.exportEnd
        case .clear:
            return written.exportEnd == nil
        case .advance(let requested):
            let expected = before?.exportEnd.map { max($0, requested) } ?? requested
            return written.exportEnd == expected
        }
    }

    // MARK: - Workout 伴生 Route 状态（按 workout 定频，替代固定 14 天全量回填）

    /// 分块大小。`IN (?,?,…)` 的变量数有上限（旧版 SQLite 是 999），而"重新导入全部"时
    /// 待查 uuid 可能上千。分块是**为了一次不超限**，不是 N+1：一次常规同步的 workout 数
    /// 是个位数，一个块就装完。
    private static let routeStateChunkSize = 400

    /// 读伴生状态。
    ///
    /// - Parameter uuids: 传 `nil` 读**全部**。管线走这条路：导出跑在脱离主线程的上下文里
    ///   （`HealthSyncCancellation.runDetached`），那里碰不了 `@MainActor` 的 store，
    ///   所以状态必须在导出**开始前**整批取出来。表很小（每 workout 一行，量级 = 累计跑步
    ///   次数），整表读比"导出中发现一个 uuid 再回头查一次库"更省，也少一层跨 actor 往返。
    ///   传具体 uuid 则只读这一批（回归与定点核对用）。
    func loadRouteStates(uuids: [String]? = nil) -> [String: RouteSyncRecord] {
        guard isAvailable else { return [:] }
        let columns = """
            SELECT workout_uuid, workout_end_date, route_status, point_count, \
            route_hash, last_checked_at, stable_check_count FROM sync_route_state
            """
        var result: [String: RouteSyncRecord] = [:]
        guard let uuids else {
            guard let statement = prepare(columns) else { return [:] }
            defer { sqlite3_finalize(statement) }
            readRouteStates(into: &result, from: statement)
            return result
        }
        guard !uuids.isEmpty else { return [:] }
        var offset = 0
        while offset < uuids.count {
            let chunk = Array(uuids[offset..<min(offset + Self.routeStateChunkSize, uuids.count)])
            offset += chunk.count
            let placeholders = Array(repeating: "?", count: chunk.count).joined(separator: ", ")
            guard let statement = prepare("\(columns) WHERE workout_uuid IN (\(placeholders))") else { continue }
            defer { sqlite3_finalize(statement) }
            var bound = true
            for (index, uuid) in chunk.enumerated() where !SQLiteSupport.bind(uuid, to: statement, at: Int32(index + 1)) {
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
    func upsertRouteStates(_ records: [RouteSyncRecord]) -> Bool {
        guard isAvailable, let database else { fail("route state upsert"); return false }
        guard !records.isEmpty else { return true }
        lastError = nil
        guard SQLiteSupport.execute("BEGIN IMMEDIATE", database: database) else {
            fail("route state begin"); return false
        }
        var committed = false
        defer {
            if !committed { _ = SQLiteSupport.execute("ROLLBACK", database: database) }
        }
        guard let statement = prepare("""
            INSERT INTO sync_route_state(
                workout_uuid, workout_end_date, route_status, point_count,
                route_hash, last_checked_at, stable_check_count
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(workout_uuid) DO UPDATE SET
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
            guard SQLiteSupport.bind(record.workoutUUID, to: statement, at: 1) else {
                fail("route state bind"); return false
            }
            guard sqlite3_bind_double(statement, 2, record.workoutEndDate.timeIntervalSince1970) == SQLITE_OK else {
                fail("route state bind"); return false
            }
            guard SQLiteSupport.bind(record.status.rawValue, to: statement, at: 3) else {
                fail("route state bind"); return false
            }
            guard sqlite3_bind_int64(statement, 4, Int64(record.pointCount)) == SQLITE_OK else {
                fail("route state bind"); return false
            }
            // `route_hash` 是 TEXT 而不是 BLOB，所以绑定走 `withCString` + `transient`
            // （由 SQLite 立刻复制）。若哪天改成 BLOB，就必须回到 ADR-004「补充 B」那条：
            // `sqlite3_bind_blob` 要在 `withUnsafeBytes` 闭包**内部**调用。
            if let hash = record.routeHash {
                guard SQLiteSupport.bind(hash, to: statement, at: 5) else {
                    fail("route state bind"); return false
                }
            } else {
                guard sqlite3_bind_null(statement, 5) == SQLITE_OK else {
                    fail("route state bind"); return false
                }
            }
            guard sqlite3_bind_double(statement, 6, record.lastCheckedAt.timeIntervalSince1970) == SQLITE_OK else {
                fail("route state bind"); return false
            }
            guard sqlite3_bind_int64(statement, 7, Int64(record.stableCheckCount)) == SQLITE_OK else {
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
        let written = loadRouteStates(uuids: records.map(\.workoutUUID))
        guard lastError == nil else { return false }
        for record in records {
            // `RouteSyncRecord` 是 `Equatable`，两个 `Date` 在这里用**严格 `==`**。
            // 这不是想当然：`Date` 经 REAL 列往返（`timeIntervalSince1970` ↔
            // `timeIntervalSinceReferenceDate`，两边差常量 978307200）之所以位精确，是因为
            // 两个操作数量级之比 < 2，减法满足 Sterbenz 引理因而**精确**，绝对值更大的
            // 加法回程也就复现出原来那一位 double。实测 200,000 组（含小数秒、含
            // `.distantPast`）0 组有损。哪天把时间戳改成别的编码（例如秒×1000 存 INTEGER），
            // 这条推理作废，需要重测。
            guard written[record.workoutUUID] == record else {
                lastError = "路线同步状态写入后无法读回一致的值，本次提交已回滚。"
                SQLiteSupport.report("route state read-back mismatch", database: database)
                return false
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
