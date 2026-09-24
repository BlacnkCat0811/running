import Foundation
import SQLite3

/// 「成功收尾」这条路径的**真实现**回归：`SyncStateCommitPlan`（纯判据）+ `SyncTaskStore`
/// 的单事务提交（真 SQLite）。
///
/// 为什么需要一个新编译单元：
///  1. `SyncPhase.mayAdvanceAnchor` 此前**没有任何生产调用点** —— 定义在 `SyncPhase`、
///     转发在 `HealthSyncBlockedRecovery`、回归里自比。那条自比断言（`mayAdvanceAnchor(p)
///     == !p.isBlocked`）与实现（`!blocked.contains(p)`）是同一句话，只在实现自相矛盾时
///     才可能红。本文件把它挂到**真正的写入路径**上（`SyncStateCommitPlan.mayCommit`），
///     于是"阻塞态绝不推进 anchor"第一次有执行者。
///  2. 「水位前进 + 清任务行」此前是跨两个存储的两步写。单事务的三个护栏（事务 /
///     `changes()` 校验 / 提交**前**回读）都是"不跑一次就看不出来"的形态，必须在真库上跑。
///
/// 明确不在这里测的：`HealthKitSync.markSuccess` 的接线（那个文件不被任何回归编译，
/// 它的判据在门禁 `check-background-capabilities.py` 第 12/14 节）。
@main
struct SyncStateCommitRegression {
    @MainActor
    static func main() throws {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            checks += 1
            print("PASS: \(name)")
        }

        // ---- 1. `SyncStateCommitPlan.watermark`：三态析出。
        //      它取代了原先"`clearExportWatermark()` + `markSuccess(advanceWatermark:)`"
        //      这对调用 —— 那两次调用之间是一条崩溃窗口，方向是"水位清了、任务行还在"
        //      ⇒ 下一次同步按"无水位"重导一段**已经成功导入过**的窗口。
        let early = Date(timeIntervalSince1970: 1_700_000_000)
        let late = Date(timeIntervalSince1970: 1_800_000_000)
        check(
            SyncStateCommitPlan.watermark(advance: true, clear: false, exportEnd: late) == .advance(late),
            "advance=true with a watermark advances it"
        )
        check(
            SyncStateCommitPlan.watermark(advance: false, clear: true, exportEnd: nil) == .clear,
            "an unknown export end clears the watermark instead of leaving a stale one"
        )
        check(
            SyncStateCommitPlan.watermark(advance: false, clear: false, exportEnd: early) == .keep,
            "neither intent leaves the watermark alone"
        )
        // 🔴 这一条逐字对齐改造前的行为：`if advanceWatermark, let exportEnd { ... }` 不成立时
        //    **一个字节都不写**。把它写成 `.clear` 会让"这次导出没算出水位"变成"把水位擦掉"，
        //    下一次同步于是重导整个窗口 —— 而用户什么都没做错。
        check(
            SyncStateCommitPlan.watermark(advance: true, clear: false, exportEnd: nil) == .keep,
            "advance=true with no export end keeps the watermark (it must not become a clear)"
        )

        // ---- 2. 不变式：阻塞态绝不提交。这是 `mayAdvanceAnchor` 的生产执行点。
        for phase in SyncPhase.allCases {
            check(
                SyncStateCommitPlan.mayCommit(phase: phase) == !phase.isBlocked,
                "mayCommit disagrees with isBlocked at \(phase.rawValue)"
            )
        }
        check(
            !SyncStateCommitPlan.mayCommit(phase: .deferredProtectedData),
            "a locked-screen sync must never commit the watermark"
        )
        check(
            !SyncStateCommitPlan.mayCommit(phase: .authRequired),
            "a sync waiting for credentials must never commit the watermark"
        )
        check(
            SyncStateCommitPlan.mayCommit(phase: .succeeded),
            "a finished sync must be allowed to commit"
        )

        // ---- 3. 真库上的单事务提交。
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-sync-state-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let store = SyncTaskStore(directory: root)
        check(store.isAvailable, "a writable directory yields an available journal")

        let anchorA = Data([0xAA, 0x01, 0x02])
        let anchorB = Data([0xBB, 0x03])
        func saveTask(_ byte: UInt8, scope: String = "s1") {
            store.save(Data([byte]), scope: scope)
        }

        check(store.loadState(scope: "s1") == nil, "a fresh scope has no committed state row at all")
        saveTask(1)
        check(
            store.commitSuccess(scope: "s1", anchor: anchorA, watermark: .advance(early)),
            "a commit with one pending task row succeeds"
        )
        check(store.load(scope: "s1") == nil, "a successful commit clears the task row")
        var state = store.loadState(scope: "s1")
        check(state?.workoutAnchor == anchorA, "the committed anchor reads back byte for byte")
        check(state?.exportEnd == early, "the committed export end reads back")

        // 单调：晚的水位不许被早的顶回去（原实现在 Swift 里先读后比 —— 那是两段之间的竞态，
        // 现在由 SQL 的 CASE 在事务内决定）。
        saveTask(2)
        check(store.commitSuccess(scope: "s1", anchor: nil, watermark: .advance(late)), "a later watermark commits")
        saveTask(3)
        check(store.commitSuccess(scope: "s1", anchor: nil, watermark: .advance(early)), "an earlier watermark commits")
        check(store.loadState(scope: "s1")?.exportEnd == late, "the watermark never moves backwards")

        // `anchor: nil` = **保留**，不是"写成空"。写成空会让下一次同步从零重导出全部路线。
        state = store.loadState(scope: "s1")
        check(state?.workoutAnchor == anchorA, "anchor=nil keeps the committed anchor instead of erasing it")

        // `.clear` 必须真的写出 NULL（下一次同步于是重导一段窗口，而不是拿着旧水位跳过它）。
        saveTask(4)
        check(store.commitSuccess(scope: "s1", anchor: anchorB, watermark: .clear), "a clear commits")
        state = store.loadState(scope: "s1")
        check(state?.exportEnd == nil, "a clear writes NULL, not a stale date")
        check(state?.workoutAnchor == anchorB, "a clear still advances the anchor it was given")

        // `.keep` 两个字段都不动。
        saveTask(5)
        check(store.commitSuccess(scope: "s1", anchor: nil, watermark: .keep), "a keep commits")
        state = store.loadState(scope: "s1")
        check(state?.exportEnd == nil, "a keep leaves the export end alone")
        check(state?.workoutAnchor == anchorB, "a keep leaves the anchor alone")

        // ---- 3b. 🔴 2026-09-24 真机故障的回归：**不能逐位往返 REAL 的 Date**。
        //      `sync_state.export_end` 与 `sync_route_state` 的两个时间列都是 REAL，而 `Date`
        //      内部存 `timeIntervalSinceReferenceDate`，与列里的 `timeIntervalSince1970` 差
        //      常量 978307200 —— 这个映射**不是双射**：对 2026 年的时间戳，结果与常量之比
        //      ≈ 1.8（< 2），加法落在 Sterbenz 引理的邻居情形上，结果的 ulp 被放大到原值网格
        //      的 2 倍 ⇒ 原值最低位为 1 的时间戳**会被舍掉一位**。
        //      实测（本机逐 ulp 扫 200,000 个真实时间戳）：**恰好一半有损**；整秒时间戳
        //      0/200000 有损 —— 这正是本文件此前全绿却看不见故障的原因：`1_700_000_000`
        //      这类 fixture 全落在无损区。典型的「fixture 的值让守卫不可见」。
        //      生产路径上 `HealthKitExport` 的 `exportedThrough = Date()` 与 route 的
        //      `routeNow = Date()` 都带完整小数秒 ⇒ 回读断言拿**原始 Date** 去比读回来的
        //      Date，约一半概率判不等 ⇒ 一次完全成功的提交被整段回滚，用户看到
        //      「同步水位写入后无法读回一致的值」。
        let realUlp = Double(sign: .plus, exponent: -23, significand: 1)  // 2^-23
        let basis = Date(timeIntervalSince1970: 1_790_000_000).timeIntervalSinceReferenceDate
        let lossy = Date(timeIntervalSinceReferenceDate: basis + realUlp)
        // 前置条件本身也要断言：这个 fixture 哪天变回无损，下面几条就全成了空转。
        check(
            Date(timeIntervalSince1970: lossy.timeIntervalSince1970) != lossy,
            "the lossy fixture must actually lose a bit in the REAL round trip"
        )
        check(
            Date(timeIntervalSince1970: lossy.canonicalForREAL.timeIntervalSince1970)
                == lossy.canonicalForREAL,
            "canonicalForREAL must land on a fixed point of the round trip"
        )

        saveTask(20, scope: "lossy")
        check(
            store.commitSuccess(scope: "lossy", anchor: nil, watermark: .advance(lossy)),
            "a watermark that cannot survive the REAL round trip still commits"
        )
        check(
            store.loadState(scope: "lossy")?.exportEnd == lossy.canonicalForREAL,
            "the committed watermark reads back at the canonical value"
        )

        // route 一侧的同类用例刻意**不在这里**，而在
        // `RouteSyncStatePersistenceRegression.swift` 的**末尾**：那才是 `sync_route_state`
        // 的落盘主场，且它必须排在那个文件既有的
        // `a batch of three distinct workouts writes in one transaction` **之后** ——
        // 突变「批量写不再 BEGIN IMMEDIATE」期望红在那一条上。放在它前面会让本用例先撞上，
        // 于是那条突变的 `assertion_hit` 变假（2026-09-24 实测踩过一次：`assertion_hit=False`）。

        // 🔴 护栏②：**没有任务行**时提交必须失败，而不是安静地只写水位。
        //      它是"我以为提交了"的唯一出口 —— 少了这一条，任务行删成功、水位写失败那一路
        //      会让界面报成功、而每次同步重导同一段。
        check(
            !store.commitSuccess(scope: "s1", anchor: nil, watermark: .keep),
            "committing with no pending task row fails loudly instead of silently committing a watermark"
        )
        check(store.lastError != nil, "the failed commit leaves an actionable error")
        check(!store.commitSuccess(scope: "empty-scope", anchor: anchorB, watermark: .keep),
              "a scope that was never used cannot commit")
        check(store.loadState(scope: "empty-scope") == nil,
              "a rejected commit writes nothing for the untouched scope")

        // 🔴 护栏①：任一句失败 ⇒ 整段回滚。
        //      注入触发器要开第二条连接（`StoreRegression.swift` 同款手法），且必须先让
        //      `sync_state` 那一行存在，否则 UPSERT 走的是 INSERT 分支、UPDATE 触发器不响。
        var control: OpaquePointer?
        let path = root.appendingPathComponent("sync.sqlite").path
        precondition(sqlite3_open(path, &control) == SQLITE_OK)
        let trigger = "CREATE TRIGGER fail_state_update BEFORE UPDATE ON sync_state "
            + "BEGIN SELECT RAISE(ABORT, 'fixture'); END;"
        precondition(sqlite3_exec(control, trigger, nil, nil, nil) == SQLITE_OK)
        saveTask(6)
        check(
            !store.commitSuccess(scope: "s1", anchor: nil, watermark: .advance(late)),
            "a rejected watermark write fails the commit"
        )
        check(
            store.load(scope: "s1") == Data([6]),
            "a rejected watermark write rolls the transaction back — the task row survives"
        )
        check(
            store.loadState(scope: "s1")?.workoutAnchor == anchorB,
            "a rejected watermark write leaves the previously committed anchor intact"
        )
        sqlite3_exec(control, "DROP TRIGGER fail_state_update", nil, nil, nil)
        check(
            store.commitSuccess(scope: "s1", anchor: nil, watermark: .advance(late)),
            "the same commit succeeds once the write is allowed again"
        )

        // 反方向：水位写得进、任务行删不掉 ⇒ 同样必须整段回滚（不能留下"水位已新、进度还在"）。
        let deleteTrigger = "CREATE TRIGGER fail_task_delete BEFORE DELETE ON sync_tasks "
            + "BEGIN SELECT RAISE(ABORT, 'fixture'); END;"
        precondition(sqlite3_exec(control, deleteTrigger, nil, nil, nil) == SQLITE_OK)
        saveTask(7)
        check(
            !store.commitSuccess(scope: "s1", anchor: anchorA, watermark: .advance(early)),
            "a rejected task-row delete fails the commit"
        )
        check(store.load(scope: "s1") == Data([7]), "the task row survives a rejected delete")
        check(
            store.loadState(scope: "s1")?.workoutAnchor == anchorB,
            "the anchor written moments earlier is rolled back with the failed delete"
        )
        sqlite3_close(control)

        // ---- 4. `forgetState`：「重新导入全部」用它。删**整行**，这样"从未提交过"与
        //      "提交过、值是空"不会变成同一种形状 —— 后者会让 `HealthKitSync` 的
        //      迁移回退把老 `UserDefaults` 键又读回来。
        check(store.loadState(scope: "s1") != nil, "state exists before a full re-import")
        check(store.forgetState(scope: "s1"), "forgetState succeeds")
        check(store.loadState(scope: "s1") == nil, "forgetState removes the row, not just its values")
        check(store.load(scope: "s1") == Data([7]), "forgetState leaves the task row alone")

        // 一个不可用的日志不得假装提交成功（`isAvailable == false` 时所有读写都是 no-op）。
        let broken = SyncTaskStore(directory: URL(fileURLWithPath: "/dev/null/not-a-directory"))
        check(!broken.isAvailable, "a journal that cannot open reports itself unavailable")
        check(!broken.commitSuccess(scope: "s1", anchor: anchorA, watermark: .keep),
              "an unavailable journal rejects a commit")
        check(broken.loadState(scope: "s1") == nil, "an unavailable journal never pretends a commit happened")

        print("\(checks) sync-state commit regression checks passed")
    }
}
