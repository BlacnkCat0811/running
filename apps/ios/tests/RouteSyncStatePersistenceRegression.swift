import Foundation
import SQLite3

/// `sync_route_state` 的落盘回归：真 SQLite（`SyncTaskStore(directory:)` 支持注入目录），
/// 不是替身。
///
/// 为什么它必须存在：
///  1. 这张表是"降频记忆"的**唯一**住处（不落 `UserDefaults`、不落 JSON、不落内存单例），
///     所以"记得住"这件事本身就是一个可证伪的断言 —— 进程重启、`journal_mode=WAL`
///     的 checkpoint、`route_hash` 为 NULL 的形状，都只有在真库上跑才看得出来。
///  2. 批量写入的语义是**单事务**。半批落盘意味着下一次同步里一部分 workout 处在冷却窗口、
///     另一部分不处在，于是同一份载荷的 route 集合反过来说取决于"上次写到哪儿"。
///     这条只有注入一个失败才能验证。
///
/// 明确不在这里测的：`HealthKitExport.exportArchive` 的调用点、`HealthKitSync.markSuccess`
/// 里"先提交、后落记忆"的顺序，以及省略 GPX 的安全性 —— 前者由门禁
/// `check-background-capabilities.py` 的结构判据负责，后者由 `gpx-parser.ts` 的
/// `preserveAbsent` 分支负责（见 `ADR-004` 与本次增量报告）。
@main
struct RouteSyncStatePersistenceRegression {
    @MainActor
    static func main() throws {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            checks += 1
            print("PASS: \(name)")
        }

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-route-state-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let store = SyncTaskStore(directory: root)
        check(store.isAvailable, "a writable directory yields an available journal")
        let scopeA = "sync-scope-a"
        let scopeB = "sync-scope-b"

        let t0 = Date(timeIntervalSince1970: 1_700_000_000)
        let end = Date(timeIntervalSince1970: 1_699_000_000)
        func record(
            _ uuid: String,
            _ status: RouteSyncStatus,
            points: Int = 500,
            hash: String? = "h1",
            checked: Date = t0,
            stable: Int = 0,
            endDate: Date = end
        ) -> RouteSyncRecord {
            RouteSyncRecord(
                workoutUUID: uuid,
                workoutEndDate: endDate,
                status: status,
                pointCount: points,
                routeHash: hash,
                lastCheckedAt: checked,
                stableCheckCount: stable
            )
        }

        // ---- 1. 空表与空批。
        check(store.loadRouteStates(scope: scopeA).isEmpty, "a fresh journal has no route state rows")
        check(store.loadRouteStates(scope: scopeA, uuids: ["whatever"]).isEmpty, "an unobserved workout reads back as absent")
        check(store.upsertRouteStates([], scope: scopeA), "an empty batch succeeds without opening a transaction")
        check(store.loadRouteStates(scope: scopeA).isEmpty, "an empty batch writes nothing")

        // ---- 2. 往返逐字段相等。`Date` 走 REAL 列、`route_hash` 走 TEXT 列（可 NULL）。
        let a = record("aaaaaaaa-0000-0000-0000-000000000001", .active, points: 1234, hash: "deadbeef", checked: t0, stable: 1)
        let b = record("bbbbbbbb-0000-0000-0000-000000000002", .cooling, points: 0, hash: nil, checked: t0, stable: 2)
        let c = record("cccccccc-0000-0000-0000-000000000003", .settled, points: 987654, hash: String(repeating: "ab", count: 32), checked: t0, stable: 9)
        let batch = [a, b, c]
        check(store.upsertRouteStates(batch, scope: scopeA), "a batch of three distinct workouts writes in one transaction")
        let loaded = store.loadRouteStates(scope: scopeA)
        check(loaded.count == batch.count, "the whole batch reads back")
        for want in batch {
            check(loaded[want.workoutUUID] == want, "every column round-trips for \(want.workoutUUID)")
        }
        // 🔴 NULL 与空串必须能区分。把 `nil` 写成 `""`，"没有轨迹"就会变成"有一段空轨迹"，
        //    于是状态机永远判不出变化（`"" != nil` 恒为真 —— 方向是安全的，但记忆会永远卡在
        //    active，降频收益全部作废）。
        check(loaded[b.workoutUUID]?.routeHash == nil, "a nil digest round-trips as SQL NULL")
        check(
            loaded[c.workoutUUID]?.routeHash == String(repeating: "ab", count: 32),
            "a 64-character digest round-trips byte for byte (a dangling pointer would corrupt it)"
        )

        // ---- 3. 定点读，以及"空筛选 ≠ 读全部"。
        check(store.loadRouteStates(scope: scopeA, uuids: [a.workoutUUID]).count == 1, "a targeted read returns only the asked-for row")
        check(
            store.loadRouteStates(scope: scopeA, uuids: [a.workoutUUID])[a.workoutUUID] == a,
            "the targeted read returns the same record as the full read"
        )
        check(
            store.loadRouteStates(scope: scopeA, uuids: []).isEmpty,
            "an empty filter reads nothing — it must not silently degrade into a full scan"
        )

        // ---- 4. 真落盘：换一个 store 实例（新连接）仍然读得到。
        let reopened = SyncTaskStore(directory: root)
        check(reopened.isAvailable, "the journal reopens")
        check(reopened.loadRouteStates(scope: scopeA) == loaded, "route state survives a reopen instead of living in memory")

        // ---- 5. UPSERT 覆盖同一主键，而不是撞主键失败、也不是插入第二行。
        var changed = a
        changed.status = .settled
        changed.stableCheckCount = 7
        changed.pointCount = 999
        changed.lastCheckedAt = t0.addingTimeInterval(3600)
        changed.routeHash = "after"
        check(store.upsertRouteStates([changed], scope: scopeA), "a second write for the same workout succeeds")
        check(store.loadRouteStates(scope: scopeA)[a.workoutUUID] == changed, "the second write updates in place")
        check(store.loadRouteStates(scope: scopeA).count == batch.count, "the second write does not add a row")

        // ---- 6. 分块边界：跨过 `routeStateChunkSize`（400）必须仍然一个不少。
        //      它不是性能测试，是"`IN (?,?,…)` 的变量数上限"这条约束的守卫：
        //      分块写错（例如把 offset 前进量写成分块数）会让回来读到的那一批悄悄变少，
        //      表现是"一部分 workout 永远被当作首查" —— 只多查，不报错。
        let many = (0..<401).map { index in
            record(String(format: "chunk-%04d", index), .cooling, points: index, hash: "h\(index)", checked: t0, stable: index)
        }
        check(store.upsertRouteStates(many, scope: scopeA), "a batch larger than the chunk size writes in one transaction")
        let chunked = store.loadRouteStates(scope: scopeA, uuids: many.map(\.workoutUUID))
        check(chunked.count == many.count, "every row of an over-chunk-size batch reads back")
        check(
            many.allSatisfy { chunked[$0.workoutUUID] == $0 },
            "an over-chunk-size batch round-trips field for field"
        )

        // ---- 7. 单事务：任一行写不进去 ⇒ 整批回滚，不留半份。
        //      注入方式与 `SyncStateCommitRegression` 同源：另开一条连接到**同一个库文件**，
        //      在 UPDATE 上挂一个必然失败的触发器。批里第一条是 INSERT（新 uuid，会成功），
        //      第二条是 UPDATE（已有 uuid，会失败）—— 于是"第一条有没有被留下"就是
        //      "是不是真的在一个事务里"的判据。
        var control: OpaquePointer?
        let databasePath = root.appendingPathComponent("sync.sqlite").path
        guard sqlite3_open_v2(databasePath, &control, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else {
            preconditionFailure("could not open the journal for trigger injection")
        }
        defer { sqlite3_close(control) }
        let trigger = """
            CREATE TRIGGER reject_route_state_update BEFORE UPDATE ON sync_route_state
            BEGIN SELECT RAISE(ABORT, 'injected route state failure'); END;
            """
        guard sqlite3_exec(control, trigger, nil, nil, nil) == SQLITE_OK else {
            preconditionFailure("could not inject the route state failure trigger")
        }
        let freshUUID = "dddddddd-0000-0000-0000-000000000004"
        let doomed = [record(freshUUID, .active), changed]
        check(!store.upsertRouteStates(doomed, scope: scopeA), "a batch whose second row cannot be written fails")
        check(store.lastError != nil, "the failed batch leaves an actionable error")
        check(
            store.loadRouteStates(scope: scopeA, uuids: [freshUUID])[freshUUID] == nil,
            "the first row of the failed batch is rolled back too — the batch really is one transaction"
        )
        check(
            store.loadRouteStates(scope: scopeA)[a.workoutUUID] == changed,
            "the failed batch leaves the earlier committed value alone"
        )
        sqlite3_exec(control, "DROP TRIGGER reject_route_state_update", nil, nil, nil)

        // ---- 8. 落盘值不在闭集里 ⇒ 那一行当作"从未观测"（于是下一轮会重查一次），
        //      而**不是**猜一个状态、也不是让整批读取失败。方向必须是安全的：多查一次，
        //      不丢数据。剩下的行照常返回。
        sqlite3_exec(
            control,
            "UPDATE sync_route_state SET route_status = 'not-a-real-status' WHERE workout_uuid = '\(c.workoutUUID)'",
            nil, nil, nil
        )
        let afterCorruption = store.loadRouteStates(scope: scopeA)
        check(afterCorruption[c.workoutUUID] == nil, "a row whose status is outside the closed set is withheld")
        check(
            afterCorruption[a.workoutUUID] == changed,
            "one unreadable row does not poison the rest of the read"
        )
        var rawRows = 0
        var rows: OpaquePointer?
        if sqlite3_prepare_v2(control, "SELECT COUNT(*) FROM sync_route_state", -1, &rows, nil) == SQLITE_OK,
           sqlite3_step(rows) == SQLITE_ROW {
            rawRows = Int(sqlite3_column_int64(rows, 0))
        }
        sqlite3_finalize(rows)
        check(rawRows > afterCorruption.count, "the withheld row is still on disk — the read skipped it, it did not delete it")

        // ---- 9. 与 `commitSuccess` 是**两个**事务，而且方向是刻意选的。
        //      记忆写在提交**之后**（`HealthKitSync.markSuccess`），所以一次失败的水位提交
        //      绝不许顺带把记忆退回去 —— 那种"顺带"会让一次本来成功的同步白查一遍。
        check(
            !store.commitSuccess(scope: "no-such-task", anchor: nil, watermark: .keep),
            "committing without a pending task row still fails loudly"
        )
        check(
            store.loadRouteStates(scope: scopeA)[a.workoutUUID] == changed,
            "a failed watermark commit leaves route state untouched"
        )

        // ---- 10. 不可用的日志：不许假装写成功，也不许假装读到了空集合（两者都是"猜"）。
        let broken = SyncTaskStore(directory: URL(fileURLWithPath: "/dev/null/not-a-directory"))
        check(!broken.isAvailable, "a journal that cannot open reports itself unavailable")
        check(broken.loadRouteStates(scope: scopeA).isEmpty, "an unavailable journal reports no memory instead of inventing one")
        check(
            !broken.upsertRouteStates([record(freshUUID, .active)], scope: scopeA),
            "an unavailable journal rejects a route state write"
        )

        // ---- 11. 🔴 2026-09-24 真机故障的回归：**不能逐位往返 REAL 的 Date**。
        //      两个时间列都是 REAL，而 `Date` 内部存 `timeIntervalSinceReferenceDate`，与列里的
        //      `timeIntervalSince1970` 差常量 978307200 —— 这个映射**不是双射**：对 2026 年的时间戳
        //      二者之比 ≈ 1.8（< 2），加法那一步结果的 ulp 是原值网格的 2 倍，于是原值最低位为 1
        //      的时间戳**会被舍掉一位**。实测逐 ulp 扫 200,000 个真实时间戳：**恰好一半有损**；
        //      整秒时间戳 0/200000 有损 —— 所以上面第 2 节那批 `1_700_000_000` 的 fixture
        //      永远绿，而生产路径上 `HealthKitExport.swift:286` 的 `routeNow = Date()` 带完整小数秒。
        //      症状：下面那句 `written[...] == record`（比整个 `RouteSyncRecord`）按约一半的概率
        //      判不等 ⇒ 整批回滚，用户看到「路线同步状态写入后无法读回一致的值」。
        //
        //      ⚠️ 本节必须留在**文件末尾**：突变「批量写不再 BEGIN IMMEDIATE」期望红在第 71 行的
        //      `a batch of three distinct workouts writes in one transaction` 上；把本节挪到它
        //      前面会让本用例先撞上，那条突变的 `assertion_hit` 就变假了（2026-09-24 实测踩过）。
        let realUlp = Double(sign: .plus, exponent: -23, significand: 1)  // 2^-23
        let basis = Date(timeIntervalSince1970: 1_790_000_000).timeIntervalSinceReferenceDate
        let lossy = Date(timeIntervalSinceReferenceDate: basis + realUlp)
        // 前置条件本身也要断言：这个 fixture 哪天变回无损，下面两条就全成了空转。
        check(
            Date(timeIntervalSince1970: lossy.timeIntervalSince1970) != lossy,
            "the lossy fixture must actually lose a bit in the REAL round trip"
        )
        check(
            Date(timeIntervalSince1970: lossy.canonicalForREAL.timeIntervalSince1970)
                == lossy.canonicalForREAL,
            "canonicalForREAL must land on a fixed point of the round trip"
        )
        check(
            store.upsertRouteStates([
                RouteSyncRecord(
                    workoutUUID: "lossy-workout",
                    workoutEndDate: lossy,
                    status: .active,
                    pointCount: 17,
                    routeHash: "cafe",
                    lastCheckedAt: lossy,
                    stableCheckCount: 2
                )
            ], scope: scopeA),
            "a route state whose dates cannot survive the REAL round trip still commits"
        )
        check(
            store.loadRouteStates(scope: scopeA, uuids: ["lossy-workout"])["lossy-workout"]
                == RouteSyncRecord(
                    workoutUUID: "lossy-workout",
                    workoutEndDate: lossy.canonicalForREAL,
                    status: .active,
                    pointCount: 17,
                    routeHash: "cafe",
                    lastCheckedAt: lossy.canonicalForREAL,
                    stableCheckCount: 2
                ),
            "the committed route state reads back at the canonical value"
        )

        // A different server/epoch must query the same workout again.
        check(store.loadRouteStates(scope: scopeB).isEmpty, "a new scope inherits no settled routes")
        check(store.loadRouteStates(scope: scopeB, uuids: [a.workoutUUID]).isEmpty, "targeted reads also isolate scopes")
        check(store.upsertRouteStates([a], scope: scopeB), "the same UUID can be stored in a second scope")
        check(store.loadRouteStates(scope: scopeA)[a.workoutUUID] == changed, "writing B leaves A untouched")
        check(store.loadRouteStates(scope: scopeB)[a.workoutUUID] == a, "B keeps its own observation")

        let legacyRoot = root.appendingPathComponent("legacy")
        try FileManager.default.createDirectory(at: legacyRoot, withIntermediateDirectories: true)
        var legacyDB: OpaquePointer?
        precondition(sqlite3_open(legacyRoot.appendingPathComponent("sync.sqlite").path, &legacyDB) == SQLITE_OK)
        precondition(sqlite3_exec(legacyDB, """
            CREATE TABLE sync_route_state (workout_uuid TEXT PRIMARY KEY, workout_end_date REAL NOT NULL,
              route_status TEXT NOT NULL, point_count INTEGER NOT NULL, route_hash TEXT,
              last_checked_at REAL NOT NULL, stable_check_count INTEGER NOT NULL);
            INSERT INTO sync_route_state VALUES ('old', 1700000000, 'settled', 42, 'old-hash', 1700000000, 3);
            CREATE TABLE sync_tasks (scope TEXT PRIMARY KEY, updated_at REAL NOT NULL, payload BLOB NOT NULL);
            INSERT INTO sync_tasks VALUES ('old-scope', 1700000000, X'0102');
            """, nil, nil, nil) == SQLITE_OK)
        sqlite3_close(legacyDB)
        let upgraded = SyncTaskStore(directory: legacyRoot)
        check(upgraded.isAvailable, "an installed legacy schema upgrades successfully")
        check(upgraded.loadRouteStates(scope: scopeA).isEmpty, "unowned legacy memory is discarded")
        check(upgraded.load(scope: "old-scope") == Data([1, 2]), "migration preserves pending task bytes")
        check(upgraded.upsertRouteStates([a], scope: scopeA), "upgraded schema accepts scoped records")
        let upgradedAgain = SyncTaskStore(directory: legacyRoot)
        check(upgradedAgain.loadRouteStates(scope: scopeA)[a.workoutUUID] == a, "reopening never repeats the destructive migration")

        // 重新发现队列和观测分别存储，且仍共用单事务和 scope。
        check(store.loadRouteDiscoveryCursor(scope: scopeA) == nil, "an existing journal starts without a rediscovery cursor")
        let beforeCursorOnly = store.loadRouteStates(scope: scopeA)
        check(store.upsertRouteStates([], scope: scopeA, discoveryCursor: "history-019"),
              "an unreadable historical page can advance only its traversal cursor")
        check(store.loadRouteStates(scope: scopeA) == beforeCursorOnly,
              "advancing traversal without observations never fabricates stable checks or timestamps")
        check(reopened.loadRouteDiscoveryCursor(scope: scopeA) == "history-019", "the traversal cursor survives a different connection")
        check(store.loadRouteDiscoveryCursor(scope: scopeB) == nil, "a different server/epoch inherits no traversal cursor")
        check(store.upsertRouteStates([], scope: scopeB, discoveryCursor: "scope-b-last"), "scope B writes its own traversal cursor")
        check(store.loadRouteDiscoveryCursor(scope: scopeA) == "history-019", "scope B never moves scope A's traversal cursor")

        precondition(sqlite3_exec(control, """
            CREATE TRIGGER ignore_route_discovery_update BEFORE UPDATE ON sync_route_discovery
            BEGIN SELECT RAISE(IGNORE); END;
            """, nil, nil, nil) == SQLITE_OK)
        var cursorBatchRecord = changed
        cursorBatchRecord.pointCount += 1
        check(!store.upsertRouteStates([cursorBatchRecord], scope: scopeA, discoveryCursor: "history-039"),
              "a traversal cursor UPSERT that touches zero rows fails")
        check(store.lastError != nil, "a silently ignored cursor write leaves diagnostics")
        check(store.loadRouteStates(scope: scopeA)[changed.workoutUUID] == changed,
              "a failed cursor write rolls back route observations in the same batch")
        check(store.loadRouteDiscoveryCursor(scope: scopeA) == "history-019", "a failed batch leaves its previous cursor intact")
        precondition(sqlite3_exec(control, "DROP TRIGGER ignore_route_discovery_update", nil, nil, nil) == SQLITE_OK)
        check(store.upsertRouteStates([cursorBatchRecord], scope: scopeA, discoveryCursor: "history-039"),
              "observations and the traversal cursor commit together after recovery")
        check(store.loadRouteStates(scope: scopeA)[changed.workoutUUID] == cursorBatchRecord
              && store.loadRouteDiscoveryCursor(scope: scopeA) == "history-039",
              "a successful batch exposes both its route memory and cursor")

        // 已安装 v2 库没有新表；ensure-schema 必须幂等补表，不得丢弃既有路线/任务。
        var installedDB: OpaquePointer?
        precondition(sqlite3_open(legacyRoot.appendingPathComponent("sync.sqlite").path, &installedDB) == SQLITE_OK)
        precondition(sqlite3_exec(installedDB, "DROP TABLE sync_route_discovery", nil, nil, nil) == SQLITE_OK)
        sqlite3_close(installedDB)
        let withDiscovery = SyncTaskStore(directory: legacyRoot)
        check(withDiscovery.isAvailable, "an installed v2 journal gains the rediscovery table")
        check(withDiscovery.loadRouteStates(scope: scopeA)[a.workoutUUID] == a, "adding the table preserves installed settled memory")
        check(withDiscovery.load(scope: "old-scope") == Data([1, 2]), "adding the table preserves unfinished upload bytes")
        check(withDiscovery.upsertRouteStates([], scope: scopeA, discoveryCursor: "installed-last"),
              "the upgraded table can persist a traversal cursor")

        // ── O02/WP-11：待查路线队列（sync_pending_routes） ────────────────────────────
        // 三条语义：登记幂等（reason 更新、**createdAt 不刷新**）、提交前回读、移除幂等
        // （不在表里的 uuid 也算成功 —— 恢复轮残留与重复移除都靠它）。
        let todoA = PendingRouteTodo(
            workoutUUID: "todo-a", reason: .routeBudget,
            createdAt: Date(timeIntervalSince1970: 1_700_500_000)
        )
        let todoOversized = PendingRouteTodo(
            workoutUUID: "todo-b", reason: .routeOversized,
            createdAt: Date(timeIntervalSince1970: 1_700_500_100)
        )
        check(store.loadPendingRoutes(scope: scopeA).isEmpty, "a fresh scope has no pending route todos")
        check(store.upsertPendingRoutes([todoA, todoOversized], scope: scopeA),
              "pending route todos persist")
        let loadedTodos = store.loadPendingRoutes(scope: scopeA)
        check(loadedTodos[todoA.workoutUUID]?.reason == .routeBudget
              && loadedTodos[todoOversized.workoutUUID]?.reason == .routeOversized,
              "both reasons round-trip")
        // 重复登记幂等：reason 更新、`createdAt` 保持**首次**值（年龄是公平轮转的依据）。
        let reregistered = PendingRouteTodo(
            workoutUUID: "todo-a", reason: .routeOversized,
            createdAt: Date(timeIntervalSince1970: 1_700_600_000)
        )
        check(store.upsertPendingRoutes([reregistered], scope: scopeA),
              "re-registering an existing todo is idempotent")
        let afterReregister = store.loadPendingRoutes(scope: scopeA)
        check(afterReregister["todo-a"]?.reason == .routeOversized, "re-registering refreshes the reason")
        check(afterReregister["todo-a"]?.createdAt == todoA.createdAt.canonicalForREAL,
              "re-registering never refreshes createdAt (age is the fair-rotation key)")
        check(store.loadPendingRoutes(scope: scopeB).isEmpty, "scope B never sees scope A's todos")
        check(store.removePendingRoutes(["todo-a", "never-there"], scope: scopeA),
              "removing a missing uuid is a no-op success (idempotent)")
        check(store.loadPendingRoutes(scope: scopeA)["todo-a"] == nil, "a removed todo does not come back")
        check(store.loadRouteStates(scope: scopeA)[a.workoutUUID] == cursorBatchRecord,
              "todo bookkeeping leaves this journal's settled route memory untouched")

        // 已安装 v2 库缺 sync_pending_routes：ensure-schema 幂等补表且不丢既有数据。
        var todoDB: OpaquePointer?
        precondition(sqlite3_open(legacyRoot.appendingPathComponent("sync.sqlite").path, &todoDB) == SQLITE_OK)
        precondition(sqlite3_exec(todoDB, "DROP TABLE sync_pending_routes", nil, nil, nil) == SQLITE_OK)
        sqlite3_close(todoDB)
        let withTodos = SyncTaskStore(directory: legacyRoot)
        check(withTodos.isAvailable, "an installed v2 journal gains the pending-routes table")
        check(withTodos.loadRouteStates(scope: scopeA)[a.workoutUUID] == a,
              "adding the pending-routes table preserves settled memory")
        check(withTodos.upsertPendingRoutes([todoOversized], scope: scopeA),
              "the upgraded table can persist todos")

        // ── R03（2026-10-16 复查）：状态落盘与待办移除的**同一事务** ─────────────────
        // 语义：状态写不进去 ⇒ 待办**不得**被移除（旧形态是两次独立写：状态失败只 NSLog、
        // 待办照删 —— 那条被删掉的待办就是"无状态行"的 UUID 的唯一发现路径）；反过来，
        // 待办删不掉 ⇒ 状态也**不得**落地（否则"成功了一半"没人分得清）。
        // 故障注入沿用本文件既有手法（另开连接挂 BEFORE UPDATE / BEFORE DELETE 触发器）。
        let r03UUID = "r03aaaa-0000-0000-0000-0000000000a1"
        check(store.upsertPendingRoutes(
            [PendingRouteTodo(workoutUUID: r03UUID, reason: .routeBudget,
                              createdAt: Date(timeIntervalSince1970: 1_700_700_000))],
            scope: scopeA), "R03: a todo registers before the atomic settle")
        var r03Record = cursorBatchRecord
        r03Record.pointCount += 17

        // ① 状态写入失败 ⇒ 待办保留、状态不落。
        precondition(sqlite3_exec(control, """
            CREATE TRIGGER reject_route_state_update_r03 BEFORE UPDATE ON sync_route_state
            BEGIN SELECT RAISE(ABORT, 'injected route state failure'); END;
            """, nil, nil, nil) == SQLITE_OK)
        check(!store.upsertRouteStates([r03Record], scope: scopeA, removePendingTodos: [r03UUID]),
              "R03: a state write that cannot land fails the whole batch")
        check(store.loadPendingRoutes(scope: scopeA)[r03UUID] != nil,
              "R03: a failed state flush leaves the delivered todo intact (it is the only retry lead)")
        check(store.loadRouteStates(scope: scopeA)[cursorBatchRecord.workoutUUID] == cursorBatchRecord,
              "R03: a failed state flush leaves the previous state value untouched")
        sqlite3_exec(control, "DROP TRIGGER reject_route_state_update_r03", nil, nil, nil)

        // ② 待办删除失败 ⇒ 状态同样回滚（不能"成功了一半"）。
        precondition(sqlite3_exec(control, """
            CREATE TRIGGER reject_pending_delete_r03 BEFORE DELETE ON sync_pending_routes
            BEGIN SELECT RAISE(ABORT, 'injected pending delete failure'); END;
            """, nil, nil, nil) == SQLITE_OK)
        check(!store.upsertRouteStates([r03Record], scope: scopeA, removePendingTodos: [r03UUID]),
              "R03: a todo that cannot be removed fails the whole batch")
        check(store.loadRouteStates(scope: scopeA)[cursorBatchRecord.workoutUUID] == cursorBatchRecord,
              "R03: the state write rolls back with the failed todo removal (no half-success)")
        check(store.loadPendingRoutes(scope: scopeA)[r03UUID] != nil, "R03: the todo stays on disk")
        sqlite3_exec(control, "DROP TRIGGER reject_pending_delete_r03", nil, nil, nil)

        // ③ 恢复之后一次成功结算：状态落盘 + 待办移除同批生效；重复结算幂等。
        check(store.upsertRouteStates([r03Record], scope: scopeA, removePendingTodos: [r03UUID]),
              "R03: after recovery, state and todo settle in one transaction")
        check(store.loadRouteStates(scope: scopeA)[cursorBatchRecord.workoutUUID] == r03Record,
              "R03: the state value lands in the same commit")
        check(store.loadPendingRoutes(scope: scopeA)[r03UUID] == nil,
              "R03: the delivered todo is removed in the same commit")
        check(store.upsertRouteStates([r03Record], scope: scopeA, removePendingTodos: [r03UUID]),
              "R03: repeating the same settle is idempotent (a missing uuid is a no-op success)")
        check(store.lastError == nil, "R03: the idempotent settle leaves no error behind")

        // ── R07（2026-10-16 复查）：待办调度的落盘与纯函数语义 ──────────────────────
        // 缺陷本体：原因字段不参与调度 —— "满额也装不下"的路线每轮都被当成"下批可再试"，
        // 每批重读同一份不可装入的 GPX（无限续批）。以下断言钉四件事：
        // ① 调度字段的落盘往返；② 老行（新列 NULL）映射成 ready（**不**迁移成永久阻塞）；
        // ③ 纯函数语义（退避有界、上限与公平序、blocked 只在能力提高时重开、显式重试复位）；
        // ④ 结局记账（读取失败 ⇒ 退避；确认超满额 ⇒ 阻塞 + 指纹）。
        let r07Now = Date(timeIntervalSince1970: 1_700_800_000)
        let r07Retry = PendingRouteTodo(
            workoutUUID: "r07-retry", reason: .routeBudget, createdAt: r07Now,
            schedState: .retryWait, attemptCount: 2,
            lastAttemptAt: r07Now, nextRetryAt: r07Now.addingTimeInterval(600)
        )
        let r07Blocked = PendingRouteTodo(
            workoutUUID: "r07-blocked", reason: .routeOversized, createdAt: r07Now,
            schedState: .blockedSize, attemptCount: 3,
            blockedBudgetFingerprint: RouteTodoScheduler.budgetFingerprint(
                maxRouteBytes: 100, maxRouteFiles: 10
            )
        )
        check(store.upsertPendingRoutes([r07Retry, r07Blocked], scope: scopeA),
              "R07: scheduled todos persist")
        let r07Loaded = store.loadPendingRoutes(scope: scopeA)
        check(r07Loaded["r07-retry"]?.effectiveState == .retryWait
              && r07Loaded["r07-retry"]?.attemptCount == 2,
              "R07: the retry-wait state and attempt count round-trip")
        check(r07Loaded["r07-blocked"]?.effectiveState == .blockedSize
              && r07Loaded["r07-blocked"]?.blockedBudgetFingerprint == "100:10",
              "R07: the blocked-size state and budget fingerprint round-trip")

        // ② 老行映射：直接 SQL 造一行"只有旧四列"（模拟 R07 之前的表形态；新列 NULL）。
        precondition(sqlite3_exec(control, """
            INSERT INTO sync_pending_routes(scope, workout_uuid, reason, created_at)
            VALUES ('\(scopeA)', 'r07-legacy', 'routeOversized', 1700800000);
            """, nil, nil, nil) == SQLITE_OK)
        let legacyTodo = store.loadPendingRoutes(scope: scopeA)["r07-legacy"]
        check(legacyTodo?.effectiveState == .ready,
              "R07: a legacy row (no scheduling columns) maps to ready — never a permanent size block")
        check(legacyTodo?.effectiveAttempts == 0, "R07: a legacy row starts with zero attempts")

        // ③a 退避有界。
        check(RouteTodoScheduler.retryBackoff(attempts: 0) == 1800,
              "R07: backoff starts at 30 minutes")
        check(RouteTodoScheduler.retryBackoff(attempts: 3) == 1800 * 8,
              "R07: backoff doubles per attempt")
        check(RouteTodoScheduler.retryBackoff(attempts: 99) == RouteTodoScheduler.retryBackoffCap,
              "R07: backoff is bounded by the cap (frequency drops, the todo never leaves the queue)")

        // ③b 可执行子集：上限 + 公平序（最老优先）+ 状态过滤。
        let r07Many = (0..<25).map { index in
            PendingRouteTodo(
                workoutUUID: String(format: "r07-%02d", index), reason: .routeBudget,
                createdAt: r07Now.addingTimeInterval(Double(index))
            )
        }
        let executableMany = RouteTodoScheduler.executable(
            r07Many, now: r07Now, maxRouteBytes: 100, maxRouteFiles: 10
        )
        check(executableMany.count == RouteTodoScheduler.executableBatchLimit,
              "R07: the executable batch is bounded")
        check(executableMany.first?.workoutUUID == "r07-00"
              && executableMany.last?.workoutUUID == "r07-19",
              "R07: fairness order is oldest-first")
        let mixed = [r07Retry, r07Blocked]
            + [PendingRouteTodo(workoutUUID: "r07-ready", reason: .routeBudget, createdAt: r07Now)]
        let executableMixed = RouteTodoScheduler.executable(
            mixed, now: r07Now, maxRouteBytes: 100, maxRouteFiles: 10
        )
        check(executableMixed.map { $0.workoutUUID } == ["r07-ready"],
              "R07: blocked-size and unexpired retry-wait stay out of the executable batch")
        let retryDueSoon = RouteTodoScheduler.executable(
            [r07Retry], now: r07Now.addingTimeInterval(601), maxRouteBytes: 100, maxRouteFiles: 10
        )
        check(retryDueSoon.count == 1, "R07: a due retry-wait becomes executable again")

        // ③c blocked 只在**能力提高**时重开（相同、缩小、一维升一维降都不算）。
        check(!RouteTodoScheduler.isExecutable(
            r07Blocked, now: r07Now, maxRouteBytes: 100, maxRouteFiles: 10
        ), "R07: identical budget capability keeps the size block")
        check(!RouteTodoScheduler.isExecutable(
            r07Blocked, now: r07Now, maxRouteBytes: 90, maxRouteFiles: 10
        ), "R07: a shrunk budget keeps the size block")
        check(!RouteTodoScheduler.isExecutable(
            r07Blocked, now: r07Now, maxRouteBytes: 200, maxRouteFiles: 5
        ), "R07: one dimension up with another down is NOT 'ability improved'")
        check(RouteTodoScheduler.isExecutable(
            r07Blocked, now: r07Now, maxRouteBytes: 200, maxRouteFiles: 10
        ), "R07: a strictly improved budget capability reopens the block")
        check(RouteTodoScheduler.reopened(r07Blocked).effectiveState == .ready,
              "R07: an explicit rescan reopens a blocked todo")

        // ④ 结局记账：读取失败 ⇒ 有界退避（尝试 +1）；确认超满额 ⇒ 阻塞 + 指纹。
        let afterRetry = RouteTodoScheduler.afterUnreadable(r07Retry, now: r07Now)
        check(afterRetry.effectiveState == .retryWait && afterRetry.effectiveAttempts == 3
              && afterRetry.nextRetryAt
                  == r07Now.addingTimeInterval(RouteTodoScheduler.retryBackoff(attempts: 3)),
              "R07: an unreadable outcome books a bounded retry")
        let afterOversize = RouteTodoScheduler.afterOversized(
            r07Retry, now: r07Now, maxRouteBytes: 100, maxRouteFiles: 10
        )
        check(afterOversize.effectiveState == .blockedSize
              && afterOversize.blockedBudgetFingerprint == "100:10",
              "R07: an oversized outcome books a size block with the capability fingerprint")

        // ⑤ B01（2026-10-17）：结算槽与"待办 / 状态"的证据链。
        //
        // 复现的病灶形态是「待办 1 条 / 状态 0 行 → 恢复轮提交后待办 0 / 状态仍 0」。
        // 这一段的断言顺序刻意照着那条时间线走：先造出"只有待办"的状态，再提交（只写槽），
        // 再结算（写状态 + 删待办），最后证明"只有 UUID 没有观测"的候选删不掉任何东西。
        let settleScope = "sync-scope-settlement"
        let todoUUID = "AAAAAAAA-1111-2222-3333-444444444444"
        let observedUUID = todoUUID.lowercased()
        check(store.upsertPendingRoutes([
            PendingRouteTodo(workoutUUID: observedUUID, reason: .routeBudget, createdAt: t0)
        ], scope: settleScope), "B01: the retry lead is queued")
        check(store.loadRouteStates(scope: settleScope, uuids: [observedUUID]).isEmpty,
              "B01: the workout has no route state yet")

        let candidate = RouteCommitCandidate(
            scope: settleScope, batchId: "batch-settlement",
            states: [observedUUID: record(observedUUID, .active)],
            completedTodoUUIDs: [todoUUID],
            discoveryCursor: observedUUID
        )
        let settlementPayload = try JSONEncoder().encode(candidate)
        check(store.save(Data("task".utf8), scope: settleScope), "B01: a live task row exists")
        check(store.commitSuccess(
            scope: settleScope, anchor: Data("anchor".utf8), watermark: .keep,
            routeSettlement: settlementPayload, routeSettlementBatchId: candidate.batchId
        ), "B01: the commit writes the settlement slot in the same transaction")
        check(store.loadRouteSettlement(scope: settleScope) == settlementPayload,
              "B01: the candidate survives the commit (a crash here still has the evidence)")
        check(store.loadRouteSettlementBatchId(scope: settleScope) == "batch-settlement",
              "B01: the slot names the batch it belongs to")
        check(store.loadRouteStates(scope: settleScope, uuids: [observedUUID]).isEmpty,
              "B01: commit alone does not fabricate a route state")
        check(store.loadPendingRoutes(scope: settleScope)[observedUUID] != nil,
              "B01: commit alone does not remove the todo")

        let settlement = RouteCommitSettlement.settle(candidate, scope: settleScope)
        check(settlement.removals == [observedUUID], "B01: the observed todo is the only removable one")
        check(store.upsertRouteStates(
            settlement.states, scope: settleScope,
            discoveryCursor: settlement.discoveryCursor,
            removePendingTodos: settlement.removals
        ), "B01: settlement writes state and removes the todo in one transaction")
        check(store.loadRouteStates(scope: settleScope, uuids: [observedUUID]).count == 1,
              "B01: the observation is persisted")
        check(store.loadPendingRoutes(scope: settleScope)[observedUUID] == nil,
              "B01: the retry lead is consumed only together with its observation")
        check(store.clearRouteSettlement(scope: settleScope),
              "B01: the slot is released after settlement")
        check(store.loadRouteSettlement(scope: settleScope) == nil,
              "B01: a released slot reads as absent")

        // 反向：只有 UUID、没有观测的候选（老 payload 的形态）⇒ 一条待办都不删。
        let legacy = RouteCommitCandidate(
            scope: settleScope, batchId: "batch-legacy",
            states: [:], completedTodoUUIDs: [observedUUID], discoveryCursor: nil
        )
        check(store.upsertPendingRoutes([
            PendingRouteTodo(workoutUUID: observedUUID, reason: .routeBudget, createdAt: t0)
        ], scope: settleScope), "B01: the retry lead is queued again for the negative case")
        let legacySettlement = RouteCommitSettlement.settle(legacy, scope: settleScope)
        check(legacySettlement.removals.isEmpty && legacySettlement.unproven == [observedUUID],
              "B01: a candidate with only a UUID proves nothing")
        check(store.upsertRouteStates(
            legacySettlement.states, scope: settleScope,
            removePendingTodos: legacySettlement.removals
        ), "B01: an evidence-free settlement is a successful no-op")
        check(store.loadPendingRoutes(scope: settleScope)[observedUUID] != nil,
              "B01: the retry lead survives an evidence-free settlement")

        // ── P1-3（2026-10-18 同步诊断）：已交付轨迹摘要的落盘 ─────────────────────────
        // 判据：`deliveredHash` 只描述"服务端已确认收到哪一版内容"，必须能跨进程读回；
        // NULL（老行/从未交付）与"摘要为空串"不是一回事 —— 前者 ⇒ 下一轮照旧重发。
        let deliveredUUID = "deliver-0000-0000-0000-0000000000d1"
        var delivered = record(deliveredUUID, .active, checked: t0)
        check(delivered.deliveredHash == nil, "a fresh route record has no delivered hash (old payload shape)")
        check(store.upsertRouteStates([delivered], scope: scopeA),
              "a route state without a delivered hash persists (additive column, NULL is legal)")
        check(store.loadRouteStates(scope: scopeA, uuids: [deliveredUUID])[deliveredUUID]?.deliveredHash == nil,
              "NULL delivered hash reads back as nil, never as an empty string")
        delivered.deliveredHash = "sha256-delivered-1"
        check(store.upsertRouteStates([delivered], scope: scopeA),
              "a delivered hash persists with the observation")
        let independentlyReopened = SyncTaskStore(directory: root)
        check(independentlyReopened.loadRouteStates(scope: scopeA, uuids: [deliveredUUID])[deliveredUUID] == delivered,
              "the delivered hash survives a different connection (P1-3 needs it across syncs)")
        check(independentlyReopened.loadRouteStates(scope: scopeB, uuids: [deliveredUUID])[deliveredUUID] == nil,
              "the delivered hash is scope-isolated like every other route field")
        // 失败整批回滚：摘要与观测在同一事务里，不会出现"内容变了、摘要没变"的半份状态。
        let originalDeliveredUUID = deliveredUUID
        var redelivery = delivered
        redelivery.deliveredHash = "sha256-delivered-2"
        redelivery.pointCount += 1
        precondition(sqlite3_exec(control, """
            CREATE TRIGGER reject_delivered_hash_update BEFORE UPDATE ON sync_route_state
            BEGIN SELECT RAISE(ABORT, 'injected delivered-hash failure'); END;
            """, nil, nil, nil) == SQLITE_OK)
        check(!store.upsertRouteStates([redelivery], scope: scopeA),
              "an injected failure rolls back the delivered hash together with the observation")
        check(store.loadRouteStates(scope: scopeA, uuids: [originalDeliveredUUID])[originalDeliveredUUID] == delivered,
              "a failed write never leaves a newer delivered hash behind (that would suppress a real resend)")
        sqlite3_exec(control, "DROP TRIGGER reject_delivered_hash_update", nil, nil, nil)

        // ── P0-4（2026-10-18 同步诊断）：workout 定向补齐窗口的纯逻辑 ─────────────────
        // 判据三件事：登记只覆盖"最近 7 天结束"的训练；重试序列 15m/1h/6h/24h/72h；
        // "连续两次样本数一致"或 7 天到期才收口。写错任何一条的后果都是"要么每批白读
        // 一次 HealthKit，要么迟到样本重新永久缺失"。
        let windowNow = Date(timeIntervalSince1970: 1_800_000_000)
        check(WorkoutBackfillScheduler.windowPadding == 300,
              "the workout window pads 5 minutes on both sides (recovery HR / late PE live there)")
        check(WorkoutBackfillScheduler.registrationLookback == 7 * 24 * 3600,
              "only workouts that ended within the last 7 days get a window")
        let expectedLadder: [TimeInterval] = [
            15 * 60, 60 * 60, 6 * 60 * 60, 24 * 60 * 60, 72 * 60 * 60
        ]
        let schedulerLadder: [TimeInterval] = WorkoutBackfillScheduler.retryIntervals
        check(schedulerLadder == expectedLadder,
              "the retry ladder is exactly 15m / 1h / 6h / 24h / 72h")
        check(WorkoutBackfillScheduler.retryInterval(attempts: 1) == 15 * 60,
              "after the first completed pass the next check is in 15 minutes")
        check(WorkoutBackfillScheduler.retryInterval(attempts: 5) == 72 * 3_600,
              "the fifth pass waits 72 hours")
        check(WorkoutBackfillScheduler.retryInterval(attempts: 99) == 72 * 3_600,
              "the ladder caps at 72 hours (bounded; no unbounded backoff growth)")

        let endedRecently = windowNow.addingTimeInterval(-3_600)
        check(WorkoutBackfillScheduler.shouldRegister(endDate: endedRecently, now: windowNow),
              "a just-finished workout is inside the registration lookback")
        check(!WorkoutBackfillScheduler.shouldRegister(
                endDate: windowNow.addingTimeInterval(-9 * 24 * 3600), now: windowNow),
              "a 9-day-old workout is not registered again (history replay covers it)")
        check(!WorkoutBackfillScheduler.shouldRegister(
                endDate: windowNow.addingTimeInterval(6 * 3600), now: windowNow),
              "a workout that ends too far in the future is not registered")

        let registered = WorkoutBackfillScheduler.register(
            workoutUUID: "window-workout",
            startDate: endedRecently.addingTimeInterval(-2_700),
            endDate: endedRecently,
            existing: nil,
            now: windowNow
        )
        check(registered != nil, "a recent workout registers a window")
        if let registered {
            check(registered.windowStart == endedRecently.addingTimeInterval(-2_700 - 300)
                  && registered.windowEnd == endedRecently.addingTimeInterval(300),
                  "the window is [start − 5min, end + 5min]")
            check(registered.attemptCount == 0 && registered.stableCount == 0
                  && registered.completedAt == nil && registered.nextCheckAt == windowNow,
                  "a fresh window is due immediately with no observations booked yet")
            check(WorkoutBackfillScheduler.due([registered], now: windowNow).count == 1,
                  "a fresh window is due")
            // 第一次整窗查询：查到 40 条 ⇒ 记账（不完成）。
            let firstPass = WorkoutBackfillScheduler.afterPass(
                registered, observedSamples: 40, now: windowNow)
            check(firstPass.attemptCount == 1 && firstPass.lastSampleCount == 40
                  && firstPass.stableCount == 0 && firstPass.completedAt == nil,
                  "the first completed pass only records the baseline (one observation is not 'stable')")
            check(firstPass.nextCheckAt == windowNow.addingTimeInterval(15 * 60),
                  "the next check follows the ladder (15 minutes after the first pass)")
            check(WorkoutBackfillScheduler.due([firstPass], now: windowNow.addingTimeInterval(14 * 60)).isEmpty,
                  "a window is not re-read before its nextCheckAt (the ladder bounds the queries)")
            check(WorkoutBackfillScheduler.due([firstPass], now: windowNow.addingTimeInterval(15 * 60)).count == 1,
                  "the window becomes due exactly at nextCheckAt")
            // 第二次查询样本数变化 ⇒ 稳定计数清零（不能提前收口）。
            let changedPass = WorkoutBackfillScheduler.afterPass(
                firstPass, observedSamples: 41, now: windowNow.addingTimeInterval(15 * 60))
            check(changedPass.stableCount == 0 && changedPass.lastSampleCount == 41
                  && changedPass.completedAt == nil,
                  "a changed sample count resets stability (still receiving samples)")
            check(changedPass.attemptCount == 2
                  && changedPass.nextCheckAt == windowNow.addingTimeInterval(15 * 60 + 3_600),
                  "the second pass schedules the next check 1 hour later")
            // 第三次样本数与上次相同 ⇒ 连续两次一致 ⇒ 收口。
            let stablePass = WorkoutBackfillScheduler.afterPass(
                changedPass, observedSamples: 41, now: windowNow.addingTimeInterval(15 * 60 + 3_600))
            check(stablePass.stableCount == 1 && stablePass.isCompleted,
                  "two consecutive equal counts complete the window (nothing new arrived)")
            check(WorkoutBackfillScheduler.completionReason(stablePass) == "stable",
                  "completion reason distinguishes 'stable' from 'expired'")
            check(WorkoutBackfillScheduler.due([stablePass], now: windowNow.addingTimeInterval(10 * 24 * 3600)).isEmpty,
                  "a completed window is never queried again")
            // 🔴 Lead 复核修正：空窗（0 样本）**不得**靠"连续两次相同"收口 ——
            // Apple Watch 迟到样本实测 36–72h 才到，15m/1h 两次空查就关闭会把
            // "样本还没到手机"读成"这条训练没有这些类型"（与 10-14 空窗不推进水位同源）。
            let emptyFirst = WorkoutBackfillScheduler.afterPass(
                registered, observedSamples: 0, now: windowNow)
            check(emptyFirst.isCompleted == false && emptyFirst.stableCount == 0,
                  "the first empty pass does not complete the window (empty is not 'stable')")
            let emptySecond = WorkoutBackfillScheduler.afterPass(
                emptyFirst, observedSamples: 0, now: windowNow.addingTimeInterval(15 * 60))
            check(emptySecond.isCompleted == false && emptySecond.stableCount == 0
                  && emptySecond.lastSampleCount == 0,
                  "two empty passes still do NOT complete the window (the samples may still be on the watch)")
            // 样本数从 0 变正 ⇒ 更新计数、清零稳定；下一次相同（正数）才收口。
            // ⚠️ 这一段必须在**走完整条重试阶梯之前**做：阶梯累计 >7 天，之后的观测会先被
            // 7 天上限收口，掩盖"0→正数"的记账语义。
            let becamePositive = WorkoutBackfillScheduler.afterPass(
                emptySecond, observedSamples: 7,
                now: windowNow.addingTimeInterval(15 * 60 + 60 * 60))
            check(becamePositive.isCompleted == false
                  && becamePositive.lastSampleCount == 7
                  && becamePositive.stableCount == 0,
                  "a 0→positive transition records the samples and resets stability")
            let positiveStable = WorkoutBackfillScheduler.afterPass(
                becamePositive, observedSamples: 7,
                now: windowNow.addingTimeInterval(15 * 60 + 60 * 60 + 60))
            check(positiveStable.isCompleted && positiveStable.stableCount == 1,
                  "after real samples arrive, two consecutive equal counts complete the window")
            // 空窗继续走重试阶梯：15m / 1h / 6h / 24h / 72h，每一次都不得收口。
            var emptyLadder = emptySecond
            var emptyWaits: [TimeInterval] = []
            var emptyNow = windowNow.addingTimeInterval(15 * 60)
            for step in 0..<5 {
                let expected = WorkoutBackfillScheduler.retryInterval(attempts: step + 2)
                emptyWaits.append(emptyLadder.nextCheckAt.timeIntervalSince(emptyNow))
                check(emptyLadder.isCompleted == false,
                      "empty window step \(step) must not complete before the 7-day cap")
                check(emptyLadder.nextCheckAt.timeIntervalSince(emptyNow) == expected,
                      "empty window step \(step) follows the retry ladder")
                emptyNow = emptyLadder.nextCheckAt
                emptyLadder = WorkoutBackfillScheduler.afterPass(
                    emptyLadder, observedSamples: 0, now: emptyNow)
            }
            let expectedEmptyWaits: [TimeInterval] = [
                60 * 60, 6 * 60 * 60, 24 * 60 * 60, 72 * 60 * 60, 72 * 60 * 60
            ]
            let actualEmptyWaits: [TimeInterval] = emptyWaits
            check(actualEmptyWaits == expectedEmptyWaits,
                  "the empty-window ladder is 1h / 6h / 24h / 72h / 72h after the first 15m check")
            // 空窗在 7 天上限到达时**强制**收口。
            let emptyExpired = WorkoutBackfillScheduler.afterPass(
                emptyLadder, observedSamples: 0,
                now: registered.createdAt.addingTimeInterval(WorkoutBackfillScheduler.completionWindow))
            check(emptyExpired.isCompleted
                  && WorkoutBackfillScheduler.completionReason(emptyExpired) == "expired",
                  "the 7-day cap force-completes an empty window (bounded retries, not forever)")

            // 7 天到期：即便样本数一直在变，也必须收口（否则永远补下去）。
            var expiring = registered
            expiring.lastSampleCount = 40
            expiring.attemptCount = 1
            let expiredPass = WorkoutBackfillScheduler.afterPass(
                expiring, observedSamples: 99,
                now: registered.createdAt.addingTimeInterval(WorkoutBackfillScheduler.completionWindow))
            check(expiredPass.isCompleted
                  && WorkoutBackfillScheduler.completionReason(expiredPass) == "expired",
                  "the 7-day cap completes the window even when the count keeps changing")
        }

        // 窗口刷新：变宽才重开（同一 UUID 反复出现元数据变更不能无限重排）。
        let registeredBase = WorkoutBackfillScheduler.register(
            workoutUUID: "window-refresh", startDate: windowNow.addingTimeInterval(-3_600),
            endDate: windowNow.addingTimeInterval(-60), existing: nil, now: windowNow)
        check(registeredBase != nil, "registration fixture exists")
        if let base = registeredBase {
            let sameWidth = WorkoutBackfillScheduler.register(
                workoutUUID: "window-refresh", startDate: windowNow.addingTimeInterval(-3_600),
                endDate: windowNow.addingTimeInterval(-60), existing: base, now: windowNow.addingTimeInterval(600))
            check(sameWidth == base,
                  "an unchanged window is returned untouched (no schedule refresh, no reopen)")
            var completedBase = base
            completedBase.completedAt = windowNow
            let widenedCompleted = WorkoutBackfillScheduler.register(
                workoutUUID: "window-refresh", startDate: windowNow.addingTimeInterval(-3_600),
                endDate: windowNow.addingTimeInterval(-60) + 600, existing: completedBase,
                now: windowNow.addingTimeInterval(3_600))
            check(widenedCompleted != nil && widenedCompleted?.isCompleted == false,
                  "a wider window reopens a completed one (late statistics changed the workout)")
            check(widenedCompleted?.createdAt == base.createdAt,
                  "reopening preserves createdAt so the 7-day cap is not refreshed")
        }
        // 有界与公平：单批最多 passBatchLimit 条，按 nextCheckAt 最早优先。
        let manyDue = (0..<7).map { index in
            WorkoutBackfillWindow(
                workoutUUID: String(format: "due-%02d", index),
                windowStart: windowNow.addingTimeInterval(-3_600),
                windowEnd: windowNow,
                createdAt: windowNow,
                nextCheckAt: windowNow.addingTimeInterval(TimeInterval(index)),
                attemptCount: 0, lastSampleCount: 0, stableCount: 0, completedAt: nil
            )
        }
        let dueBatch = WorkoutBackfillScheduler.due(manyDue, now: windowNow.addingTimeInterval(100))
        check(dueBatch.count == WorkoutBackfillScheduler.passBatchLimit,
              "one batch is bounded by passBatchLimit windows (no unbounded HealthKit reads)")
        check(dueBatch.map(\.workoutUUID) == ["due-00", "due-01", "due-02", "due-03"],
              "due windows are taken in nextCheckAt order (fairness: oldest due first)")

        // ── P0-4：窗口在真库上的落盘（登记 / 结算 / 重启后仍在） ────────────────────
        let windowScope = "window-scope"
        check(store.loadWorkoutBackfillWindows(scope: windowScope).isEmpty,
              "a fresh scope has no workout backfill windows")
        if let registered {
            check(store.upsertWorkoutBackfillWindows([registered], scope: windowScope),
                  "a workout window registers in the sync journal")
            check(store.loadWorkoutBackfillWindows(scope: windowScope)[registered.workoutUUID] == registered,
                  "the registered window reads back field for field (times canonicalized)")
            let afterFirstPass = WorkoutBackfillScheduler.afterPass(
                registered, observedSamples: 40, now: windowNow.addingTimeInterval(60))
            check(store.upsertWorkoutBackfillWindows([afterFirstPass], scope: windowScope),
                  "the settled window (attempt/nextCheck) persists after commit")
            check(store.loadWorkoutBackfillWindows(scope: windowScope)[registered.workoutUUID] == afterFirstPass,
                  "the settlement survives in the journal")
            check(SyncTaskStore(directory: root)
                .loadWorkoutBackfillWindows(scope: windowScope)[registered.workoutUUID] == afterFirstPass,
                "the window survives a different connection (it must outlive the process)")
            check(store.loadWorkoutBackfillWindows(scope: scopeA).isEmpty,
                  "windows are scope-isolated like route memory")
            // 失败整批回滚：本批的窗口记账不能半份落盘。
            precondition(sqlite3_exec(control, """
                CREATE TRIGGER reject_window_update BEFORE UPDATE ON sync_pending_workout_windows
                BEGIN SELECT RAISE(ABORT, 'injected window failure'); END;
                """, nil, nil, nil) == SQLITE_OK)
            var corrupted = afterFirstPass
            corrupted.windowEnd = afterFirstPass.windowEnd.addingTimeInterval(600)
            check(!store.upsertWorkoutBackfillWindows([corrupted], scope: windowScope),
                  "an injected window failure fails the batch")
            check(store.loadWorkoutBackfillWindows(scope: windowScope)[registered.workoutUUID] == afterFirstPass,
                  "a failed window batch leaves the previous schedule intact")
            sqlite3_exec(control, "DROP TRIGGER reject_window_update", nil, nil, nil)
        }

        // ── 已安装 v2 库的 v2→v3 迁移：加列 + 建表，且不丢既有数据 ─────────────────
        let v2Root = root.appendingPathComponent("v2-installed")
        try FileManager.default.createDirectory(at: v2Root, withIntermediateDirectories: true)
        var v2DB: OpaquePointer?
        precondition(sqlite3_open(v2Root.appendingPathComponent("sync.sqlite").path, &v2DB) == SQLITE_OK)
        precondition(sqlite3_exec(v2DB, """
            PRAGMA user_version = 2;
            CREATE TABLE sync_tasks (scope TEXT PRIMARY KEY, updated_at REAL NOT NULL, payload BLOB NOT NULL);
            INSERT INTO sync_tasks VALUES ('v2-scope', 1700000000, X'0A0B');
            CREATE TABLE sync_route_state (
              scope TEXT NOT NULL, workout_uuid TEXT NOT NULL, workout_end_date REAL NOT NULL,
              route_status TEXT NOT NULL, point_count INTEGER NOT NULL, route_hash TEXT,
              last_checked_at REAL NOT NULL, stable_check_count INTEGER NOT NULL,
              PRIMARY KEY (scope, workout_uuid));
            INSERT INTO sync_route_state VALUES ('v2-scope', 'v2-workout', 1700000000, 'cooling', 321, 'v2-hash', 1700000000, 2);
            """, nil, nil, nil) == SQLITE_OK)
        sqlite3_close(v2DB)
        let migratedV3 = SyncTaskStore(directory: v2Root)
        check(migratedV3.isAvailable, "an installed v2 journal migrates to v3")
        check(migratedV3.load(scope: "v2-scope") == Data([0x0A, 0x0B]),
              "v2→v3 migration preserves pending task bytes")
        let migratedRecord = migratedV3.loadRouteStates(scope: "v2-scope")["v2-workout"]
        check(migratedRecord?.pointCount == 321 && migratedRecord?.routeHash == "v2-hash",
              "v2→v3 migration preserves the installed route memory")
        check(migratedRecord?.deliveredHash == nil,
              "the added delivered_route_hash column reads as nil for pre-existing rows (safe: resend once)")
        check(migratedV3.loadWorkoutBackfillWindows(scope: "v2-scope").isEmpty,
              "the added workout-window table exists and starts empty")
        check(migratedV3.upsertWorkoutBackfillWindows([registered ?? WorkoutBackfillWindow(
                workoutUUID: "v3-workout", windowStart: windowNow, windowEnd: windowNow,
                createdAt: windowNow, nextCheckAt: windowNow,
                attemptCount: 0, lastSampleCount: 0, stableCount: 0, completedAt: nil
              )], scope: "v2-scope"),
              "the migrated journal accepts workout windows")
        // 迁移是幂等的：再打开一次不重建、不丢数据。
        let reopenedV3 = SyncTaskStore(directory: v2Root)
        check(reopenedV3.isAvailable
              && reopenedV3.loadRouteStates(scope: "v2-scope")["v2-workout"]?.pointCount == 321,
              "reopening a migrated journal is a no-op (PRAGMA user_version pins it)")

        print("\(checks) route state persistence regression checks passed")
    }
}
