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
        check(store.loadRouteStates().isEmpty, "a fresh journal has no route state rows")
        check(store.loadRouteStates(uuids: ["whatever"]).isEmpty, "an unobserved workout reads back as absent")
        check(store.upsertRouteStates([]), "an empty batch succeeds without opening a transaction")
        check(store.loadRouteStates().isEmpty, "an empty batch writes nothing")

        // ---- 2. 往返逐字段相等。`Date` 走 REAL 列、`route_hash` 走 TEXT 列（可 NULL）。
        let a = record("aaaaaaaa-0000-0000-0000-000000000001", .active, points: 1234, hash: "deadbeef", checked: t0, stable: 1)
        let b = record("bbbbbbbb-0000-0000-0000-000000000002", .cooling, points: 0, hash: nil, checked: t0, stable: 2)
        let c = record("cccccccc-0000-0000-0000-000000000003", .settled, points: 987654, hash: String(repeating: "ab", count: 32), checked: t0, stable: 9)
        let batch = [a, b, c]
        check(store.upsertRouteStates(batch), "a batch of three distinct workouts writes in one transaction")
        let loaded = store.loadRouteStates()
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
        check(store.loadRouteStates(uuids: [a.workoutUUID]).count == 1, "a targeted read returns only the asked-for row")
        check(
            store.loadRouteStates(uuids: [a.workoutUUID])[a.workoutUUID] == a,
            "the targeted read returns the same record as the full read"
        )
        check(
            store.loadRouteStates(uuids: []).isEmpty,
            "an empty filter reads nothing — it must not silently degrade into a full scan"
        )

        // ---- 4. 真落盘：换一个 store 实例（新连接）仍然读得到。
        let reopened = SyncTaskStore(directory: root)
        check(reopened.isAvailable, "the journal reopens")
        check(reopened.loadRouteStates() == loaded, "route state survives a reopen instead of living in memory")

        // ---- 5. UPSERT 覆盖同一主键，而不是撞主键失败、也不是插入第二行。
        var changed = a
        changed.status = .settled
        changed.stableCheckCount = 7
        changed.pointCount = 999
        changed.lastCheckedAt = t0.addingTimeInterval(3600)
        changed.routeHash = "after"
        check(store.upsertRouteStates([changed]), "a second write for the same workout succeeds")
        check(store.loadRouteStates()[a.workoutUUID] == changed, "the second write updates in place")
        check(store.loadRouteStates().count == batch.count, "the second write does not add a row")

        // ---- 6. 分块边界：跨过 `routeStateChunkSize`（400）必须仍然一个不少。
        //      它不是性能测试，是"`IN (?,?,…)` 的变量数上限"这条约束的守卫：
        //      分块写错（例如把 offset 前进量写成分块数）会让回来读到的那一批悄悄变少，
        //      表现是"一部分 workout 永远被当作首查" —— 只多查，不报错。
        let many = (0..<401).map { index in
            record(String(format: "chunk-%04d", index), .cooling, points: index, hash: "h\(index)", checked: t0, stable: index)
        }
        check(store.upsertRouteStates(many), "a batch larger than the chunk size writes in one transaction")
        let chunked = store.loadRouteStates(uuids: many.map(\.workoutUUID))
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
        check(!store.upsertRouteStates(doomed), "a batch whose second row cannot be written fails")
        check(store.lastError != nil, "the failed batch leaves an actionable error")
        check(
            store.loadRouteStates(uuids: [freshUUID])[freshUUID] == nil,
            "the first row of the failed batch is rolled back too — the batch really is one transaction"
        )
        check(
            store.loadRouteStates()[a.workoutUUID] == changed,
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
        let afterCorruption = store.loadRouteStates()
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
            store.loadRouteStates()[a.workoutUUID] == changed,
            "a failed watermark commit leaves route state untouched"
        )

        // ---- 10. 不可用的日志：不许假装写成功，也不许假装读到了空集合（两者都是"猜"）。
        let broken = SyncTaskStore(directory: URL(fileURLWithPath: "/dev/null/not-a-directory"))
        check(!broken.isAvailable, "a journal that cannot open reports itself unavailable")
        check(broken.loadRouteStates().isEmpty, "an unavailable journal reports no memory instead of inventing one")
        check(
            !broken.upsertRouteStates([record(freshUUID, .active)]),
            "an unavailable journal rejects a route state write"
        )

        print("\(checks) route state persistence regression checks passed")
    }
}
