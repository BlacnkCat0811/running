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
    /// 一条**刚变更过**的轨迹就可能被直接判进 `settled` 而永不再查。
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
    /// 休眠阈值：跑完超过这么久、且冷却期已验证稳定，就永久不再查。
    static let settleWindow: TimeInterval = 3 * 24 * 60 * 60
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
        isForceManualRescan: Bool = false
    ) -> Bool {
        if isForceManualRescan { return true }
        switch existing.status {
        case .unknown:
            // 从未观测过。不查就永远没有点数与摘要，冷却与休眠都无从谈起。
            return true
        case .active:
            // 高频窗口内每次同步都查。窗口外**仍然要查**，直到攒够稳定证据
            // （见 `decide` 里 active → cooling 的那一步）—— 少查一次就少一份证据。
            return true
        case .cooling:
            // 唯一一个"有条件地不查"的状态：距上次**实际查询**不足 12 小时就跳过。
            return now.timeIntervalSince(existing.lastCheckedAt) >= coolingInterval
        case .settled:
            // 永久休眠。只有人工重扫能唤醒，而它已经在上面第一行被拦掉了。
            return false
        }
    }

    /// 记录阶段：拿到（或没拿到）观测后算出下一个状态。这是本次改造对外的主契约。
    ///
    /// - Parameter observation: `nil` 表示**这一轮没有查询**（管线判定不需要查，或查询失败）。
    ///   它不是"观测到空轨迹"——后者是 `RouteObservation(pointCount: 0, routeHash: nil)`。
    static func decide(
        existing: RouteSyncRecord,
        observation: RouteObservation?,
        now: Date,
        isForceManualRescan: Bool = false
    ) -> Decision {
        let needsQuery = shouldQuery(existing: existing, now: now, isForceManualRescan: isForceManualRescan)
        guard needsQuery, let observation else {
            // 没查 ⇒ 状态一动不动。宁可下一轮再判，也不许把"这次没看"记成一次检查。
            return Decision(shouldQuery: needsQuery, nextState: existing)
        }

        var next = existing
        next.pointCount = observation.pointCount
        next.routeHash = observation.routeHash
        next.lastCheckedAt = now

        // 人工重扫的语义是"我不信这个状态了，从零重来"：回 `active`、稳定性清零。
        // 放在变化判定**之前**，否则一条恰好没变的轨迹会保留住旧的 `stableCheckCount`，
        // 于是"重扫"完的第一轮就又够格降频了 —— 那等于没重扫。
        if isForceManualRescan {
            next.status = .active
            next.stableCheckCount = 0
            return Decision(shouldQuery: true, nextState: next)
        }

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
            // 到不了：`settled` 的 `shouldQuery` 恒为 false，上面已被 `guard` 挡回。留着是为了穷尽。
            next.status = .settled
        }
        return Decision(shouldQuery: true, nextState: next)
    }
}
