import Foundation

/// Route 追踪用的四态闭集。取值与 `sync_route_state.route_status` 的落盘字符串逐字一致。
///
/// 为什么必须是闭集：这一列会被 SQL 直接比较（`WHERE route_status = 'cooling'`），
/// 也会被状态机 `switch`。裸字符串在这两处**都不会**在改错时报错 —— 一个拼错的
/// `"cooling"` 只会让这些行永远不被选中，静默退化成"从不检查"。
nonisolated enum RouteSyncStatus: String, Codable, Sendable, CaseIterable {
    /// 从未观测过。首次发现即落在这里，**必须**查一次。
    case unknown
    /// 高频：跑步刚结束的 24 小时内（或稳定性尚未证实）。每次同步都查。
    case active
    /// 中频冷却：已证实稳定、且已跨过 24 小时。每 12 小时最多查一次。
    case cooling
    /// 低频休眠：已跨过 3 天且冷却期验证稳定。空路线每日、已有路线每周分批复查。
    case settled
}

/// 一条 Workout 的 Route 伴生状态。
///
/// 路线点的读取仍依赖所属 workout：先用 `HKQuery.predicateForObjects(from: workout)`
/// 找到 route sample，再用 `HKWorkoutRouteQuery` 逐点取回。sample 的变化通知不等于路线
/// 内容已完整可读，因此降频记忆以 workout UUID 标识，复合主键为 (scope, workout_uuid)。
nonisolated struct RouteSyncRecord: Equatable, Sendable {
    /// 小写化的 `HKWorkout.uuid.uuidString`。
    ///
    /// 口径与 GPX 文件名一致（`HealthKitExport.routeFileWorkoutId`）：导入侧把 route 路径当
    /// **大小写不敏感**的身份，两边必须用同一种写法，否则状态永远命中不了自己的行。
    let workoutUUID: String
    /// 判定"年龄"的基准。用 `endDate` 而不是 `startDate`：轨迹是跑完之后才成形并到达的，
    /// 一次 5 小时的超马期间 route 一直在增长，用 startDate 会让它过早离开高频窗口。
    let workoutEndDate: Date
    var status: RouteSyncStatus
    /// 最近一次观测到的轨迹点数。0 是**合法观测**（跑步机跑步、或路线尚未到达）。
    var pointCount: Int
    /// 观测到的轨迹内容摘要。`nil` 同样合法（没有轨迹可摘要）。
    var routeHash: String?
    /// 最近一次**实际查询**的时间。跳过查询时**不动**它 —— 它正是"距上次检查多久"的判据。
    var lastCheckedAt: Date
    /// 连续多少次观测与上一次**完全一致**（点数 + 摘要）。任何变化都清零。
    var stableCheckCount: Int
}

/// 待查路线（O02/WP-11）：**预算拒绝时未能查询**的训练的持久待办。
///
/// 与 `RouteSyncRecord` 的分工：那是"查过没有"的记忆（每个 workout 一行状态）；这是
/// "**还没查**"的队列 —— 训练 XML 已交付、锚已推进、但它的 route 查询被预算挡住，
/// 且**没有**状态行（`rediscoveryCandidates` 只遍历已有状态行，不认识它）⇒ 没有这条
/// 待办，那些 UUID 重启后永久不可发现（O02 的病灶：只设 `routeStopReason` 布尔带不回 UUID）。
///
/// 只是 UUID 队列（不存轨迹）；唯一标识 `(scope, workout_uuid)`，重复登记幂等。
nonisolated struct PendingRouteTodo: Codable, Equatable, Sendable {
    /// 小写化的 workout UUID（与 `HealthKitExport.routeFileWorkoutId` 同源）。
    let workoutUUID: String
    /// 为什么被延后（展示用；闭集）。
    let reason: PendingRouteReason
    /// **首次**入队时刻（公平轮转的年龄依据；重复 upsert **不刷新**它）。
    let createdAt: Date

    /// 延后原因（闭集：落盘字符串会被读回比较，裸字符串改错不会在编译期报错）。
    nonisolated enum PendingRouteReason: String, Codable, Sendable {
        /// route 预算耗尽（"先判后取"闸门）：本批没查，下批应优先补。
        case routeBudget
        /// 单条轨迹超过**满额**单批预算：额度重置也装不下（需后续处置，不无限前台补跑）。
        case routeOversized
    }
}
