import Foundation

/// B01 / B02（2026-10-17 第二轮复查）的纯逻辑判据。
///
/// 两件事放在同一个可执行里，因为它们共享同一份"路线证据"类型：
///
/// * **B01**：结算必须同时具备"观测"与"待办"两份证据。只带完成 UUID（老形态）时
///   一条待办都不能删 —— 删了就把该 UUID 从两条发现通道里同时抹掉（无状态行 +
///   无待办 ⇒ `rediscoveryCandidates` 永远看不到它）。
/// * **B02**：`blocked-size` / 未到期 `retry-wait` 必须在**最终 fetch 之前**拦住
///   全部来源（正式页变更、近期回填、rediscovery、待办）。这台策略机是 `HealthKitExport`
///   唯一该问的判据 —— 旧实现把四个放行口并排写在条件里，任一条命中就绕过调度。
///
/// 明确不在这里测的：`HealthKitSync.markSuccess` 的接线与 `SyncTaskStore` 的事务 ——
/// 前者不被任何回归编译，后者在 `RouteSyncStatePersistenceRegression` 的真库单元里。
@main
struct RouteCommitSettlementRegression {
    static func main() {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            checks += 1
            print("PASS: \(name)")
        }

        let scope = "https://example.test|athlete"
        let uuid = "0f0f0f0f-1111-2222-3333-444444444444"
        let other = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        let now = Date(timeIntervalSince1970: 1_700_000_000)

        func record(
            _ id: String,
            status: RouteSyncStatus = .active,
            points: Int = 500,
            hash: String? = "h1",
            checkedAt: Date? = nil,
            endDate: Date? = nil,
            stable: Int = 0
        ) -> RouteSyncRecord {
            RouteSyncRecord(
                workoutUUID: id,
                workoutEndDate: endDate ?? now.addingTimeInterval(-3600),
                status: status,
                pointCount: points,
                routeHash: hash,
                lastCheckedAt: checkedAt ?? now,
                stableCheckCount: stable
            )
        }

        // ---- 1. 没有候选 ⇒ 一条待办都不删（U01：老任务 / 恢复轮缺证据）。
        //      这是 §3.2 步骤 9 的安全分支：残缺的 `completedRouteTodos` 不是删除证明。
        let none = RouteCommitSettlement.settle(nil, scope: scope)
        check(none.removals.isEmpty, "missing candidate removes no todo (old payload keeps the retry lead)")
        check(none.states.isEmpty, "missing candidate fabricates no route state")
        check(none.discoveryCursor == nil, "missing candidate does not advance the discovery cursor")

        // ---- 2. 完整候选：状态与待办同时结算，且只删有观测的那一条。
        let full = RouteCommitCandidate(
            scope: scope,
            batchId: "batch-1",
            states: [uuid: record(uuid), other: record(other, points: 0, hash: nil)],
            completedTodoUUIDs: [uuid, other],
            discoveryCursor: uuid
        )
        let settled = RouteCommitSettlement.settle(full, scope: scope)
        check(settled.removals == [uuid, other], "both observed todos are removable in candidate order")
        check(settled.states.count == 2, "both observations are written in the same settlement")
        check(settled.unproven.isEmpty, "a fully observed candidate leaves no unproven todo")
        check(settled.discoveryCursor == uuid, "the candidate carries the discovery cursor")
        check(!settled.isEmpty, "a real candidate is not empty")

        // ---- 3. 合法零点观测（跑步机跑步 / 轨迹尚未到达）**是**证明。
        //      把它和"读取失败"混为一谈，会让零轨迹的跑步永远占着待办队列。
        check(
            RouteCommitSettlement.isObservation(record(other, points: 0, hash: nil)),
            "a zero-point observation is a real observation, not a failed read"
        )

        // ---- 4. 候选自称删某条，但那条没有任何观测 ⇒ 保留（U01 的核心断言）。
        let fabricated = RouteCommitCandidate(
            scope: scope,
            batchId: "batch-2",
            states: [uuid: record(uuid)],
            completedTodoUUIDs: [uuid, other],
            discoveryCursor: nil
        )
        let partial = RouteCommitSettlement.settle(fabricated, scope: scope)
        check(partial.removals == [uuid], "only the observed UUID is removable")
        check(partial.unproven == [other], "a completed UUID without observation is kept and reported")

        // ---- 5. 哨兵不是观测：baseline（unknown / distantPast）不能当证明。
        let sentinel = RouteSyncStateMachine.baseline(workoutUUID: other, workoutEndDate: now)
        let sentinelCandidate = RouteCommitCandidate(
            scope: scope,
            batchId: "batch-3",
            states: [other: sentinel],
            completedTodoUUIDs: [other],
            discoveryCursor: nil
        )
        let sentinelResult = RouteCommitSettlement.settle(sentinelCandidate, scope: scope)
        check(sentinelResult.removals.isEmpty, "a baseline sentinel is not proof of observation")
        check(sentinelResult.unproven == [other], "the todo stays queued when only a sentinel exists")

        // ---- 6. 跨 scope / 未知版本：失败关闭（保留待办，不写状态）。
        let wrongScope = RouteCommitCandidate(
            scope: "other-scope", batchId: "batch-4",
            states: [uuid: record(uuid)], completedTodoUUIDs: [uuid], discoveryCursor: nil
        )
        let crossScope = RouteCommitSettlement.settle(wrongScope, scope: scope)
        check(crossScope.removals.isEmpty, "a candidate from another scope never removes this scope's todo")
        check(crossScope.states.isEmpty, "a candidate from another scope writes no state")
        let future = RouteCommitCandidate(
            version: RouteCommitCandidate.currentVersion + 1,
            scope: scope, batchId: "batch-5",
            states: [uuid: record(uuid)], completedTodoUUIDs: [uuid], discoveryCursor: nil
        )
        let unknownVersion = RouteCommitSettlement.settle(future, scope: scope)
        check(unknownVersion.removals.isEmpty, "an unknown candidate version fails closed")
        check(unknownVersion.unproven == [uuid], "an unknown version reports the todo as unproven")

        // ---- 7. 幂等：同一候选结算两次，结果逐字段相同（重复结算不重复计入）。
        check(
            RouteCommitSettlement.settle(full, scope: scope) == settled,
            "settling the same candidate twice is idempotent"
        )

        // ---- 8. UUID 规范化：大写输入与生产侧小写键必须命中同一条。
        let upper = RouteCommitCandidate(
            scope: scope, batchId: "batch-6",
            states: [uuid.uppercased(): record(uuid)],
            completedTodoUUIDs: [uuid.uppercased()],
            discoveryCursor: nil
        )
        let normalized = RouteCommitSettlement.settle(upper, scope: scope)
        check(normalized.removals == [uuid], "upper-case UUID input normalizes to the production key")
        check(normalized.states.first?.workoutUUID == uuid, "the stored state keeps the production UUID form")

        // ---- 9. 编码往返：候选能跨进程（这是"恢复轮不重读 HealthKit"的前提）。
        let encoded = try! JSONEncoder().encode(full)
        let decoded = try! JSONDecoder().decode(RouteCommitCandidate.self, from: encoded)
        check(decoded == full, "a candidate survives a JSON round trip unchanged")

        // ================= B02：最终执行闸门 =================

        let hour: TimeInterval = 3600
        let day: TimeInterval = 24 * hour
        let active = record(uuid, status: .active, checkedAt: now)

        func decide(
            todo: PendingRouteTodo?,
            existing: RouteSyncRecord = active,
            now: Date = now,
            bytes: Int = 4_000_000,
            files: Int = 40,
            change: Bool = false,
            retry: Bool = false,
            budgetExhausted: Bool = false
        ) -> RouteQueryPolicy.Decision {
            RouteQueryPolicy.decide(
                todo: todo, existing: existing, now: now,
                maxRouteBytes: bytes, maxRouteFiles: files,
                hasWorkoutChange: change,
                isExplicitRetry: retry,
                routeBudgetExhausted: budgetExhausted
            )
        }

        let blocked = PendingRouteTodo(
            workoutUUID: uuid, reason: .routeOversized, createdAt: now.addingTimeInterval(-day),
            schedState: .blockedSize, attemptCount: 1, lastAttemptAt: now.addingTimeInterval(-day),
            nextRetryAt: nil,
            blockedBudgetFingerprint: RouteTodoScheduler.budgetFingerprint(
                maxRouteBytes: 4_000_000, maxRouteFiles: 40
            )
        )
        let backoff = PendingRouteTodo(
            workoutUUID: uuid, reason: .routeBudget, createdAt: now.addingTimeInterval(-day),
            schedState: .retryWait, attemptCount: 2, lastAttemptAt: now.addingTimeInterval(-hour),
            nextRetryAt: now.addingTimeInterval(hour), blockedBudgetFingerprint: nil
        )
        let ready = PendingRouteTodo(
            workoutUUID: uuid, reason: .routeBudget, createdAt: now.addingTimeInterval(-day)
        )

        // 9a. blocked-size 从四条入口都拦得住（U04）：
        //     正式页变更 / 近期回填（active）/ rediscovery（同一 active 记录）/ 待办本身。
        check(decide(todo: blocked) == .blocked(reason: .blockedSize), "blocked-size stops the todo channel")
        check(
            decide(todo: blocked, change: true) == .blocked(reason: .blockedSize),
            "a workout-page change does not clear a size block (change proves nothing about route size)"
        )
        check(
            decide(todo: blocked, existing: record(uuid, status: .active, checkedAt: now.addingTimeInterval(-day))) == .blocked(reason: .blockedSize),
            "the recent-backfill channel cannot bypass a size block"
        )
        check(
            decide(todo: blocked, existing: record(uuid, status: .settled, checkedAt: now.addingTimeInterval(-8 * day))) == .blocked(reason: .blockedSize),
            "the rediscovery channel cannot bypass a size block either"
        )

        // 9b. retry-wait 未到期阻止全部普通来源；到期或显式重试才放行。
        check(decide(todo: backoff) == .blocked(reason: .retryWait), "an unexpired retry backoff stops the todo channel")
        check(
            decide(todo: backoff, change: true) == .blocked(reason: .retryWait),
            "a workout-page change does not shortcut a failed-read backoff"
        )
        check(
            decide(todo: backoff, now: now.addingTimeInterval(2 * hour)).executes,
            "an expired backoff executes without waiting for the next discovery pass"
        )

        // 9c. 能力提高 / 显式重试各自允许一次正确执行，其他条件不放行。
        check(
            decide(todo: blocked, bytes: 8_000_000).executes,
            "a larger batch budget reopens a size block"
        )
        check(
            decide(todo: blocked, files: 40) == .blocked(reason: .blockedSize),
            "an unchanged budget keeps the size block"
        )
        check(
            decide(todo: blocked, bytes: 2_000_000) == .blocked(reason: .blockedSize),
            "a smaller budget never reopens a size block"
        )
        // 全量重扫通道已删除（2026-10-17）：只剩"能力提高"与"定点重试"两条重开依据。
        check(decide(todo: blocked, retry: true).executes, "a targeted retry reopens a size block")
        check(decide(todo: backoff, retry: true).executes, "a targeted retry reopens a retry backoff")

        // 9d. 明确待办不被 settled 降频永久挡住；普通发现服从降频。
        let settledRecord = record(uuid, status: .settled, checkedAt: now.addingTimeInterval(-hour))
        check(
            decide(todo: ready, existing: settledRecord).executes,
            "an explicit todo is not starved by the settled query interval"
        )
        check(
            decide(todo: nil, existing: settledRecord) == .deferred(reason: .notDue),
            "a plain rediscovery of a settled route still respects its interval"
        )
        check(
            decide(todo: nil, existing: settledRecord, change: true).executes,
            "a workout change still queries an ordinary settled route immediately"
        )

        // 9e. 预算满 ⇒ 延后（不是阻塞）：下批满额可再试。
        check(
            decide(todo: ready, budgetExhausted: true) == .deferred(reason: .routeBudget),
            "an exhausted batch budget defers instead of blocking the route"
        )
        check(
            decide(todo: blocked, budgetExhausted: true) == .blocked(reason: .blockedSize),
            "the size block is decided before the batch budget (it is a property of the route)"
        )

        // 9g. §4.2 步骤 6：定点重试只重开**这一条**；其余 UUID 的阻塞不受影响。
        let otherBlocked = PendingRouteTodo(
            workoutUUID: other, reason: .routeOversized, createdAt: now,
            schedState: .blockedSize, attemptCount: 1, lastAttemptAt: now,
            nextRetryAt: nil,
            blockedBudgetFingerprint: RouteTodoScheduler.budgetFingerprint(
                maxRouteBytes: 4_000_000, maxRouteFiles: 40
            )
        )
        check(
            decide(todo: blocked, retry: true).executes,
            "a targeted retry reopens exactly the named UUID"
        )
        check(
            decide(todo: otherBlocked, retry: false) == .blocked(reason: .blockedSize),
            "a targeted retry on one UUID must not reopen another blocked todo"
        )
        check(
            decide(todo: backoff, retry: true).executes,
            "a targeted retry also reopens an unexpired failed-read backoff"
        )
        check(
            decide(todo: ready, retry: true, budgetExhausted: true) == .deferred(reason: .routeBudget),
            "a targeted retry still respects the batch budget (it is not a quota bypass)"
        )

        // 9f. 公平/上限：待办可执行子集仍有界（20 条）且按 createdAt 最早优先。
        var backlog: [PendingRouteTodo] = []
        for index in 0..<25 {
            backlog.append(PendingRouteTodo(
                workoutUUID: String(format: "%08d-0000-0000-0000-000000000000", index),
                reason: .routeBudget,
                createdAt: now.addingTimeInterval(TimeInterval(index - 30))
            ))
        }
        let executable = RouteTodoScheduler.executable(
            backlog, now: now, maxRouteBytes: 4_000_000, maxRouteFiles: 40
        )
        check(executable.count == RouteTodoScheduler.executableBatchLimit, "an executable batch is bounded")
        check(executable.first?.workoutUUID == backlog.first?.workoutUUID, "the oldest todo goes first")

        print("\(checks) route commit settlement / query policy checks passed")
    }
}
