import Foundation

/// 一轮 Route 观测的**结果**。只描述"看到了什么"，不含任何决策 —— 决策在
/// `RouteSyncStateMachine` 里。
///
/// 它之所以单独成型：`HealthKitExport.exportArchive` 跑在脱离主线程的上下文里
/// （见 `HealthSyncCancellation.runDetached`），而 `SyncTaskStore` 是 `@MainActor`。
/// 导出侧**不能**碰数据库，于是它只能把观测回传成这个 `Sendable` 值，由主线程侧落盘。
nonisolated struct RouteObservation: Equatable, Sendable {
    /// 本轮取回的轨迹点总数（一个 workout 的多段 route 求和）。
    /// 0 是**合法观测**：跑步机跑步、或轨迹尚未从手表到达。
    let pointCount: Int
    /// 轨迹内容摘要。`nil` 与 `pointCount == 0` 是同一件事的两种写法，都合法。
    let routeHash: String?
}

/// Workout 伴生 Route 的**纯状态机**。
///
/// 它没有任何副作用、不读时钟也不读盘 —— 时间与已有状态都由参数传入。
/// 这一点不是洁癖：这台机器要判的正是"跳过查询"与"查询后没变化"的**区别**，
/// 而两者在真实的同步里长得一模一样（都表现为"这一次同步没有新轨迹"）。
/// 只有把决策从 IO 里剥出来，这两个分支才各自可执行地验证
/// （见 `RouteSyncStateMachineTests`）。
nonisolated enum RouteSyncStateMachine {
    /// 一轮决策的完整输出。
    ///
    /// 🔴 `nextState` 在 `shouldQuery == false` 时是**原样携带**（含 `lastCheckedAt` 不动）。
    /// 这一条是整台机器的意义所在：跳过查询**不能**被记成"查过了、而且和上次一样"，
    /// 否则 `stableCheckCount` 会把"没查"当成一次稳定证据，冷却期凭空缩短，
    /// 一条**刚变更过**的轨迹就可能被直接判进 `settled`，错过高频补齐窗口。
    /// （这与 ADR-004 决策二「没读到 ≠ 没变化」是同一条不变式在客户端的另一处落点。）
    struct Decision: Equatable {
        let shouldQuery: Bool
        let nextState: RouteSyncRecord
    }

    /// 高频窗口：跑步结束后这段时间内，每次同步都查。轨迹是跑完之后才成形并陆续到达的，
    /// 所以这段时间里"没变化"不算证据。
    static let activeWindow: TimeInterval = 24 * 60 * 60
    /// 冷却期的查询节流：距**上次实际查询**不足这么久就跳过。
    static let coolingInterval: TimeInterval = 12 * 60 * 60
    /// 休眠阈值：跑完超过这么久、且冷却期已验证稳定，就转入低频重新发现。
    static let settleWindow: TimeInterval = 3 * 24 * 60 * 60
    /// HealthKit 不暴露读取权限的变化；空路线每天复查，已有路线每周复查。
    /// 这些是最低间隔，不是定时任务：只在已有同步机会中分批执行。
    static let emptyRediscoveryInterval: TimeInterval = 24 * 60 * 60
    static let settledRediscoveryInterval: TimeInterval = 7 * 24 * 60 * 60
    /// 每轮最多追加这么多历史/休眠候选，不恢复每轮全历史轨迹查询。
    static let rediscoveryBatchLimit = 20
    /// 降频到 `cooling` 所需的**连续**稳定观测次数。
    ///
    /// 为什么不是 1：`routeHash` 是内容摘要，一次"看起来一样"可能只是查询当刻轨迹恰好
    /// 停了（比如手表还没把最后一段同步上来）。要两次独立查询都一致，才把频率降下来。
    static let stabilityToCool: Int = 2

    /// 从未观测过的一条状态。
    ///
    /// ⚠️ 注意它的 `pointCount = 0` / `routeHash = nil` **不是观测值**，是哨兵。
    /// 所以 `.unknown` 永远不能拿去和观测做"有没有变化"的比较 —— 见 `decide` 里
    /// `isFirstObservation` 那一步。把它当成"上次观测到 0 点"会让一次真实的首查
    /// （比如 500 点）被判成"变了"，那方向是安全的；反过来若轨迹真为 0 点被判成"没变"，
    /// 就会在第一次就把 `stableCheckCount` 记成 1 —— 所以这里直接按"首查必然算变化"处理。
    static func baseline(workoutUUID: String, workoutEndDate: Date) -> RouteSyncRecord {
        RouteSyncRecord(
            workoutUUID: workoutUUID,
            workoutEndDate: workoutEndDate,
            status: .unknown,
            pointCount: 0,
            routeHash: nil,
            lastCheckedAt: .distantPast,
            stableCheckCount: 0
        )
    }

    /// 计划阶段：这一轮要不要真的发 `HKWorkoutRouteQuery`。
    ///
    /// 单独暴露它，是为了让管线能在**查询之前**就批量筛掉不该查的 workout ——
    /// 那正是这次改造的收益来源（见步骤 3）。
    static func shouldQuery(
        existing: RouteSyncRecord,
        now: Date,
        hasWorkoutChange: Bool = false
    ) -> Bool {
        if hasWorkoutChange { return true }
        switch existing.status {
        case .unknown:
            // 从未观测过。不查就永远没有点数与摘要，冷却与休眠都无从谈起。
            return true
        case .active:
            // 高频窗口内每次同步都查。窗口外**仍然要查**，直到攒够稳定证据
            // （见 `decide` 里 active → cooling 的那一步）—— 少查一次就少一份证据。
            return true
        case .cooling:
            // 距上次**实际查询**不足 12 小时就跳过。
            return now.timeIntervalSince(existing.lastCheckedAt) >= coolingInterval
        case .settled:
            let interval = existing.pointCount == 0 || existing.routeHash == nil
                ? emptyRediscoveryInterval : settledRediscoveryInterval
            return now.timeIntervalSince(existing.lastCheckedAt) >= interval
        }
    }

    /// 休眠路线（包括近期 workout）和窗口外的待查路线共享一个有界轮转队列。
    /// cursor 只记录候选遍历位置，**不是** HealthKit anchor 或稳定性证据。
    /// 即使旧 workout 已删除/暂不可读，也要跨过它；否则队首的不可读 UUID 会饿死后面的路线。
    static func rediscoveryCandidates(
        existing: [RouteSyncRecord],
        currentWorkoutUUIDs: Set<String>,
        changedWorkoutUUIDs: Set<String> = [],
        now: Date,
        cursor: String?,
        limit: Int = rediscoveryBatchLimit
    ) -> [String] {
        guard limit > 0 else { return [] }
        let due = existing.filter { record in
            !changedWorkoutUUIDs.contains(record.workoutUUID)
                && (!currentWorkoutUUIDs.contains(record.workoutUUID) || record.status == .settled)
                && shouldQuery(existing: record, now: now)
        }.map(\.workoutUUID).sorted()
        guard let cursor else { return Array(due.prefix(limit)) }
        let after = due.filter { $0 > cursor }
        let wrapped = due.filter { $0 <= cursor }
        return Array((after + wrapped).prefix(limit))
    }

    /// 记录阶段：拿到（或没拿到）观测后算出下一个状态。这是本次改造对外的主契约。
    ///
    /// - Parameter observation: `nil` 表示**这一轮没有查询**（管线判定不需要查，或查询失败）。
    ///   它不是"观测到空轨迹"——后者是 `RouteObservation(pointCount: 0, routeHash: nil)`。
    static func decide(
        existing: RouteSyncRecord,
        observation: RouteObservation?,
        now: Date,
        hasWorkoutChange: Bool = false
    ) -> Decision {
        let needsQuery = shouldQuery(
            existing: existing, now: now, hasWorkoutChange: hasWorkoutChange
        )
        guard needsQuery, let observation else {
            // 没查 ⇒ 状态一动不动。宁可下一轮再判，也不许把"这次没看"记成一次检查。
            return Decision(shouldQuery: needsQuery, nextState: existing)
        }

        var next = existing
        next.pointCount = observation.pointCount
        next.routeHash = observation.routeHash
        next.lastCheckedAt = now

        let isFirstObservation = existing.status == .unknown
        let changed = isFirstObservation
            || observation.pointCount != existing.pointCount
            || observation.routeHash != existing.routeHash
        if changed {
            // 变化 ⇒ 回到高频。轨迹还在长（补传、纠偏）时，它必须被持续盯着。
            next.status = .active
            next.stableCheckCount = 0
            return Decision(shouldQuery: true, nextState: next)
        }

        let stable = existing.stableCheckCount + 1
        next.stableCheckCount = stable
        let age = now.timeIntervalSince(existing.workoutEndDate)
        switch existing.status {
        case .unknown:
            // 到不了：`.unknown` 已被 `isFirstObservation` 判进 `changed`。留着是为了穷尽。
            next.status = .active
        case .active:
            // "跨过 24 小时"用的是**年龄**（距 workout 结束），不是距上次查询 ——
            // 否则一台刚装上的设备会因为它自己刚查过一次而立刻降频。
            next.status = (age >= activeWindow && stable >= stabilityToCool) ? .cooling : .active
        case .cooling:
            // 冷却期里唯一能再降一级的依据：稳定 **且** 已经跑完超过 3 天。
            // 只判稳定不判年龄，会让一场两周前的老跑步在 12 小时后就休眠 —— 那没错，
            // 但会漏掉"轨迹在冷却期里被补传"的窗口，所以两级判据都要满足才落到 `settled`。
            next.status = age > settleWindow ? .settled : .cooling
        case .settled:
            // 低频复查没有变化就继续休眠；点数/摘要变化已在上面唤醒到 active。
            next.status = .settled
        }
        return Decision(shouldQuery: true, nextState: next)
    }
}

/// B02（2026-10-17 复查）：**最终执行闸门** —— 所有路线来源在 fetch 之前必须经过这里。
///
/// ## 病灶
///
/// `RouteTodoScheduler.executable` 只筛"待办发现集合"：`blocked-size` 与未到期的
/// `retry-wait` 不进 `executableTodoIDs`。但导出侧的最终 fetch 条件还有三个**平行**放行口：
///
/// ```swift
/// previous.status != .settled || hasWorkoutChange
///   || rediscoveryIDs.contains(routeKey) || executableTodoIDs.contains(routeKey)
/// ```
///
/// 同一 UUID 只要从正式 workout 页（`hasWorkoutChange`）、近期回填或 rediscovery 再次
/// 被"发现"，就能绕过调度读到那份已经判定装不下的 GPX —— 每批白读一次，正是 R07 要治的
/// 形态。调度器本身没错，错在**它不是唯一入口**。
///
/// ## 判据顺序（顺序本身是契约）
///
/// 1. 待办调度态：`blocked-size` / 未到期 `retry-wait` 阻止**全部**普通来源；
/// 2. 本批预算：满额 ⇒ 延后（不是阻塞，下批可再试）；
/// 3. 既有路线的查询间隔（`RouteSyncStateMachine.shouldQuery`）；
/// 4. 以上都通过 ⇒ 执行。
///
/// ⚠️ 第 2 / 3 步的例外是**明确待办**：`ready` 或已到期的待办不能被 `settled` 降频
/// 永久挡住，否则"有待办 + 已有状态行"会每轮被发现、每轮被跳过，卡在队列里永远不查。
///
/// ⚠️ `hasWorkoutChange` **不**清除 `blocked-size`：它只证明"workout 行变了"，不证明
/// "那条超大路线变小了"。能力指纹提高或显式重试才是重开依据（没有可靠的内容版本信号）。
nonisolated enum RouteQueryPolicy {
    enum Decision: Equatable, Sendable {
        case execute
        /// 本批不做，但下批/下一轮可以再做（不是路线的属性）。
        case deferred(reason: DeferReason)
        /// 这条路线当前不可执行，必须等能力变化或显式重试。
        case blocked(reason: BlockReason)

        var executes: Bool { self == .execute }
    }

    nonisolated enum DeferReason: String, Equatable, Sendable {
        /// 本批路线字节/文件额度已满。
        case routeBudget
        /// 既有状态的查询间隔未到（冷却/休眠），且没有明确待办。
        case notDue
    }

    nonisolated enum BlockReason: String, Equatable, Sendable {
        /// 满额也装不下，且预算能力没有提高。
        case blockedSize
        /// 上次读取失败的有界退避尚未到期。
        case retryWait
    }

    static func decide(
        todo: PendingRouteTodo?,
        existing: RouteSyncRecord,
        now: Date,
        maxRouteBytes: Int,
        maxRouteFiles: Int,
        hasWorkoutChange: Bool,
        /// 用户对**这一条** UUID 的显式重试（§4.2 步骤 6）。
        ///
        /// 它能重开 `blocked-size` / 未到期 `retry-wait`，但**只重开这一条** ——
        /// 其余 UUID 的退避与阻塞原样保留（"其他待办不饿死"是同一条判据的另一半）。
        isExplicitRetry: Bool = false,
        routeBudgetExhausted: Bool
    ) -> Decision {
        if let todo, !isExplicitRetry {
            switch todo.effectiveState {
            case .blockedSize:
                let improved = todo.blockedBudgetFingerprint.map { stored in
                    RouteTodoScheduler.abilityImproved(
                        current: RouteTodoScheduler.budgetFingerprint(
                            maxRouteBytes: maxRouteBytes, maxRouteFiles: maxRouteFiles
                        ),
                        stored: stored
                    )
                } ?? false
                guard improved else { return .blocked(reason: .blockedSize) }
            case .retryWait:
                if let next = todo.nextRetryAt, next > now {
                    return .blocked(reason: .retryWait)
                }
            case .ready:
                break
            }
        }
        guard !routeBudgetExhausted else { return .deferred(reason: .routeBudget) }
        let due = RouteSyncStateMachine.shouldQuery(
            existing: existing,
            now: now,
            hasWorkoutChange: hasWorkoutChange
        )
        // 明确待办（ready / 到期 / 能力提高）本身就是"要查"的证据 —— 不能被降频挡住。
        // 普通发现（`todo == nil`）才服从状态机的查询间隔。
        if !due && todo == nil { return .deferred(reason: .notDue) }
        return .execute
    }
}
