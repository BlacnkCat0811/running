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
nonisolated struct RouteSyncRecord: Codable, Equatable, Sendable {
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
///
/// ## R07（2026-10-16 复查）：显式调度状态与字段
///
/// 复查证据："超大路线没有真正的跨轮阻塞/退避 —— 原因字段未参与调度，续批继续读取
/// 同一不可装入路线。" 所以待办不只是"要查的 UUID 列表"，还带**怎么调度它**：
/// - `schedState`：ready（可执行）／retry-wait（读取暂不可用 ⇒ 有界退避）／
///   blocked-size（满额也装不下 ⇒ 不安排即时补跑，只有能力提高/显式重试才重开）；
/// - `attemptCount` / `lastAttemptAt` / `nextRetryAt`：诊断与退避的载体；
/// - `blockedBudgetFingerprint`：阻塞时记下的**预算能力** —— 只有它**提高**才自动重开。
///
/// 🔴 全部新字段 `Optional`（老 payload/老行缺键 = `nil`）且读侧归一：`nil` 一律按
/// **ready** 处理 —— 这就是"预算不足不能迁移成永久 size 阻塞"的落实点（不信任旧标签，
/// 下一轮按真实结局重写状态）。⛔ 不要把这几个字段做成非可选：合成的 `Decodable`
/// 对非可选属性缺键即抛，会重演"升级后任务/待办整批读不出来"的事故。
nonisolated struct PendingRouteTodo: Codable, Equatable, Sendable {
    /// 小写化的 workout UUID（与 `HealthKitExport.routeFileWorkoutId` 同源）。
    let workoutUUID: String
    /// 为什么被延后（展示用；闭集）。
    let reason: PendingRouteReason
    /// **首次**入队时刻（公平轮转的年龄依据；重复 upsert **不刷新**它）。
    let createdAt: Date

    // MARK: R07 调度字段（全部 Optional；读侧归一）

    /// 调度状态；`nil`（老行/缺键）= `.ready`。
    var schedState: SchedState? = nil
    /// 已尝试次数（成功移除不计）。
    var attemptCount: Int? = nil
    /// 最近一次尝试时刻。
    var lastAttemptAt: Date? = nil
    /// `retry-wait` 的到期时刻（`nil` = 未记录 ⇒ 可执行）。
    var nextRetryAt: Date? = nil
    /// 进入 `blocked-size` 时记下的预算能力指纹（`RouteTodoScheduler.budgetFingerprint`）。
    var blockedBudgetFingerprint: String? = nil

    /// 延后原因（闭集：落盘字符串会被读回比较，裸字符串改错不会在编译期报错）。
    nonisolated enum PendingRouteReason: String, Codable, Sendable {
        /// route 预算耗尽（"先判后取"闸门）：本批没查，下批应优先补。
        case routeBudget
        /// 单条轨迹超过**满额**单批预算：额度重置也装不下（需后续处置，不无限前台补跑）。
        case routeOversized
        /// 首次查询就读取失败（授权/部分段失败）。旧实现只给"已在队列里"的待办退避，
        /// 于是"没有状态行、也没有待办"的迟到训练在锚越过之后再无发现通道
        /// （`rediscoveryCandidates` 只遍历已有状态行）。见 `afterUnreadableFailure`。
        case routeUnreadable
    }

    /// 调度状态闭集（落盘字符串与 SQL 可见值逐字一致）。
    nonisolated enum SchedState: String, Codable, Sendable, CaseIterable {
        /// 可执行（下一批应查）。
        case ready
        /// 读取暂不可用（授权/部分失败）⇒ 有界退避后重试。
        case retryWait = "retry-wait"
        /// 满额也装不下 ⇒ 等能力变化或显式重试（不持续安排即时补跑）。
        case blockedSize = "blocked-size"
    }

    /// 读侧归一：缺键 = `ready`（见类型说明的 R07 一节）。
    var effectiveState: SchedState { schedState ?? .ready }
    var effectiveAttempts: Int { attemptCount ?? 0 }
}

/// R07（2026-10-16 复查）：待办路线的**调度**（纯函数，可独立断言）。
///
/// 缺陷形态：原因字段不参与调度 —— 一条"满额也装不下"的路线每轮都被当作"下批可再试"，
/// 前台/后台的每一批都重新读取同一份不可装入的 GPX（无限续批、每批白读 HealthKit）。
///
/// 语义（文档 R07 步骤 2–5）：
/// - 可执行子集有**数量上限与公平顺序**（`createdAt` 最早优先）——不能把整队列一次性
///   送进 HealthKit（步骤 4）；
/// - 退避**有界**（≤ `retryBackoffCap`）：到顶只降频，绝不把待办移出队列（步骤 3）；
/// - `blocked-size` 只有"预算能力提高"（指纹变化且提高）才自动重开；用户显式重试
///   （"重新导入全部"）走 `reopened` 强制通道（步骤 5）；
/// - ⛔ "路线内容发生可信变化"这一条**不做**：手机侧没有可靠的路线内容版本追踪，
///   伪造一个判据比承认缺口更坏；两条真实通道（能力提高/显式重试）覆盖它。
///
/// 🔴 本类型**刻意零外部类型依赖**（预算能力用两个 Int 传入，不用 `DirectSyncBatchBudget`）：
/// `RouteSyncState.swift` 被四个**文件集合各不相同**的 swiftc 测试单元编译
///（`run-health-sync-tests.sh`），引一个只在部分单元里存在的类型会让其余单元编译失败。
/// 调用方（`HealthKitExport`）负责把 `budget.maxRouteBytes / maxRouteFiles` 传进来。
nonisolated enum RouteTodoScheduler {
    /// 单批最多执行多少条待办（与 `RouteSyncStateMachine.rediscoveryBatchLimit` 同值 20，
    /// 但**语义不同**：那是"每轮发现候选"的上限，这是"每批执行待办"的上限；两者独立可调）。
    static let executableBatchLimit = 20
    /// 退避基数与上限（有界：到顶只降频）。
    static let retryBackoffBase: TimeInterval = 30 * 60
    static let retryBackoffCap: TimeInterval = 12 * 60 * 60

    /// 有界指数退避：`base × 2^attempts`，封顶 `retryBackoffCap`。
    static func retryBackoff(attempts: Int) -> TimeInterval {
        let exponent = max(0, min(attempts, 8))
        return min(retryBackoffBase * pow(2, Double(exponent)), retryBackoffCap)
    }

    /// 预算能力指纹：`"<maxRouteBytes>:<maxRouteFiles>"`（可解析、可比较；格式锚在这里）。
    static func budgetFingerprint(maxRouteBytes: Int, maxRouteFiles: Int) -> String {
        "\(maxRouteBytes):\(maxRouteFiles)"
    }

    /// "能力**提高**"的严格判据：两维都不更小、且至少一维更大。
    /// （"任一维变大"更宽松，会让"一维变大另一维变小"的收敛中间态也重开 —— 那条路线
    /// 会被再次读一遍又再判阻塞，正是要治的浪费。）
    static func abilityImproved(current: String, stored: String) -> Bool {
        guard let now = parseFingerprint(current), let before = parseFingerprint(stored) else {
            return false
        }
        return now.bytes >= before.bytes && now.files >= before.files
            && (now.bytes > before.bytes || now.files > before.files)
    }

    /// 单条待办当前是否可执行（不含"显式重试"——那是调用方的强制通道）。
    static func isExecutable(
        _ todo: PendingRouteTodo, now: Date, maxRouteBytes: Int, maxRouteFiles: Int
    ) -> Bool {
        switch todo.effectiveState {
        case .ready:
            return true
        case .retryWait:
            // 缺 `nextRetryAt`（未记录）= 可执行：给一次机会，由真实结局重写状态。
            guard let next = todo.nextRetryAt else { return true }
            return next <= now
        case .blockedSize:
            guard let stored = todo.blockedBudgetFingerprint else {
                // 没有指纹就无法证明"能力提高" ⇒ 不自动重开（等显式重试）。
                // 本版本写的 blockedSize 必带指纹，缺它只可能是损坏 —— 保守方向。
                return false
            }
            return abilityImproved(
                current: budgetFingerprint(maxRouteBytes: maxRouteBytes, maxRouteFiles: maxRouteFiles),
                stored: stored
            )
        }
    }

    /// 从一批待办里选出**本批可执行**的：过滤 ⇒ 公平序（`createdAt` 最早优先，同龄按 uuid）
    /// ⇒ 截到上限（不能把整队列一次性送进 HealthKit）。
    static func executable(
        _ todos: [PendingRouteTodo],
        now: Date,
        maxRouteBytes: Int,
        maxRouteFiles: Int,
        limit: Int = executableBatchLimit
    ) -> [PendingRouteTodo] {
        todos
            .filter {
                isExecutable($0, now: now, maxRouteBytes: maxRouteBytes, maxRouteFiles: maxRouteFiles)
            }
            .sorted {
                $0.createdAt == $1.createdAt
                    ? $0.workoutUUID < $1.workoutUUID
                    : $0.createdAt < $1.createdAt
            }
            .prefix(max(0, limit))
            .map { $0 }
    }

    /// 读取失败后的**唯一**记账入口。
    ///
    /// 无既有待办时用 `.routeUnreadable` 新建一条 —— 这是"首次读取就失败"的迟到训练
    /// 唯一的重试线索：它可能既没有状态行（`rediscoveryCandidates` 看不到它），
    /// 也不在队列里，而 anchor 已经越过它。有则原样沿用 `createdAt`（公平轮转的年龄
    /// 不能因为一次失败被刷新）。
    static func afterUnreadableFailure(
        existing: PendingRouteTodo?, now: Date, workoutUUID: String
    ) -> PendingRouteTodo {
        let base = existing ?? PendingRouteTodo(
            workoutUUID: workoutUUID, reason: .routeUnreadable, createdAt: now
        )
        return afterUnreadable(base, now: now)
    }

    /// 读取失败（`.unreadable`）之后的记账：尝试 +1、进入**有界退避**。保留原 reason。
    static func afterUnreadable(_ todo: PendingRouteTodo, now: Date) -> PendingRouteTodo {
        var updated = todo
        let attempts = todo.effectiveAttempts + 1
        updated.attemptCount = attempts
        updated.lastAttemptAt = now
        updated.schedState = .retryWait
        updated.nextRetryAt = now.addingTimeInterval(retryBackoff(attempts: attempts))
        return updated
    }

    /// 确认"满额也装不下"之后的记账：进入 `blocked-size`，记下**当时的预算能力**。
    static func afterOversized(
        _ todo: PendingRouteTodo, now: Date, maxRouteBytes: Int, maxRouteFiles: Int
    ) -> PendingRouteTodo {
        var updated = todo
        updated.attemptCount = todo.effectiveAttempts + 1
        updated.lastAttemptAt = now
        updated.schedState = .blockedSize
        updated.nextRetryAt = nil
        updated.blockedBudgetFingerprint = budgetFingerprint(
            maxRouteBytes: maxRouteBytes, maxRouteFiles: maxRouteFiles
        )
        return updated
    }

    /// 用户显式重试（"重新导入全部"）：把一条待办复位成 `ready`（清退避与阻塞指纹；
    /// `attemptCount`/`lastAttemptAt` 保留作诊断）。
    static func reopened(_ todo: PendingRouteTodo) -> PendingRouteTodo {
        var updated = todo
        updated.schedState = .ready
        updated.nextRetryAt = nil
        updated.blockedBudgetFingerprint = nil
        return updated
    }

    private static func parseFingerprint(_ value: String) -> (bytes: Int, files: Int)? {
        let parts = value.split(separator: ":")
        guard parts.count == 2, let bytes = Int(parts[0]), let files = Int(parts[1]) else {
            return nil
        }
        return (bytes, files)
    }
}

/// B01（2026-10-17 复查）：一批路线观测的**持久提交候选**。
///
/// ## 为什么"完成 UUID"不够
///
/// R03 把"已交付、待提交后结算"的待办 UUID 落进任务行（`SyncTaskState.completedRouteTodos`），
/// 但没有同时保存**这一批到底观测到了什么**。于是恢复轮只能删待办、写不出状态：
///
/// ```text
/// 待办 1 条 / sync_route_state 0 行
///   → 恢复轮提交成功（带 completedRouteTodos = [uuid]）
///   → upsertRouteStates([], removePendingTodos: [uuid])
///   → 待办 0 条 / 状态仍 0 行        ← 这条路线永久不可发现
/// ```
///
/// 为什么是"永久"：`RouteSyncStateMachine.rediscoveryCandidates` 只遍历**已有状态行**，
/// 而没有状态行的 UUID 只能靠待办队列被发现。两者同时为空 = 没有任何入口会再查它。
///
/// 修法不是在恢复轮"补一条空状态"（那会把"没读到"记成"读到了零点"，方向错），而是让
/// **观测本身跨进程**：导出轮把完整观测与完成 UUID 一起持久化，恢复轮用同一份证据同时
/// 写状态与删待办。候选里只有点数、摘要与状态，不存轨迹点。
///
/// ## 版本与损坏
///
/// `version` 是显式的：未知版本一律**不结算**（待办保留），绝不按当前字段猜。
/// `init(from:)` 会重新规范化所有 UUID，防止手改/损坏的 payload 绕过键匹配。
nonisolated struct RouteCommitCandidate: Codable, Equatable, Sendable {
    /// 当前形态。改动字段语义时必须递增；读侧对未知版本失败关闭。
    static let currentVersion = 1

    let version: Int
    /// 写入时的 scope。结算方必须核对 —— 跨 scope 复用会把别的账号的状态写进来。
    let scope: String
    /// 批次身份（= `payloadHash`）。与任务行的载荷哈希同源，便于人工对账。
    let batchId: String
    /// 本批**完整观测**过的路线状态（键 = 小写 workout UUID）。
    let states: [String: RouteSyncRecord]
    /// 本批已交付、可在提交成功后移除的待办 UUID。每一条都必须在 `states` 里有观测证明。
    let completedTodoUUIDs: [String]
    /// 本批推进到的发现游标（`nil` = 本轮不动游标）。
    let discoveryCursor: String?

    /// UUID 的唯一规范化口径（与 `HealthKitExport.routeFileWorkoutId` 同源：小写化）。
    static func normalize(_ uuid: String) -> String { uuid.lowercased() }

    init(
        version: Int = RouteCommitCandidate.currentVersion,
        scope: String,
        batchId: String,
        states: [String: RouteSyncRecord],
        completedTodoUUIDs: [String],
        discoveryCursor: String?
    ) {
        self.version = version
        self.scope = scope
        self.batchId = batchId
        // 键与值两处都规范化：调用方可能从 `[String: RouteSyncRecord]` 直接传进来，
        // 而那个字典的键在历史上曾经只由导出侧保证小写。规范化放在**构造**这一步，
        // 读侧（`settle`）再核一次 —— 两道都在，坏数据才进不来。
        var normalizedStates: [String: RouteSyncRecord] = [:]
        for (key, record) in states {
            let normalized = Self.normalize(key)
            guard normalized == Self.normalize(record.workoutUUID) else { continue }
            normalizedStates[normalized] = record
        }
        self.states = normalizedStates
        var seen = Set<String>()
        self.completedTodoUUIDs = completedTodoUUIDs
            .map(Self.normalize)
            .filter { seen.insert($0).inserted }
        self.discoveryCursor = discoveryCursor
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decode(Int.self, forKey: .version)
        let scope = try container.decode(String.self, forKey: .scope)
        let batchId = try container.decode(String.self, forKey: .batchId)
        // 缺键 = 损坏。这里**不用** `decodeIfPresent` 兜底成空：静默把损坏读成
        // "没有状态、没有待办"会让结算方以为无活可干，而实际那批证据已经丢了。
        let rawStates = try container.decode([String: RouteSyncRecord].self, forKey: .states)
        let rawCompleted = try container.decode([String].self, forKey: .completedTodoUUIDs)
        let discoveryCursor = try container.decodeIfPresent(String.self, forKey: .discoveryCursor)
        self = RouteCommitCandidate(
            version: version,
            scope: scope,
            batchId: batchId,
            states: rawStates,
            completedTodoUUIDs: rawCompleted,
            discoveryCursor: discoveryCursor
        )
    }
}

/// B01：把候选**结算**成"要写哪些状态、要删哪些待办"的纯函数。
///
/// 判据只有一条：**每个要删的 UUID 都必须有本批的完整观测**。
/// "读取失败 / 部分读取 / 预算拒绝" 都不进候选（导出侧的分类），所以它们不会在这里被删。
/// 结算方仍要自己核一遍 —— 候选可能来自旧版本或损坏的 payload，不能假设生产端没出错。
nonisolated enum RouteCommitSettlement {
    /// 结算结果。`states` / `removals` 都为空 = 没有任何可执行动作。
    struct Result: Equatable, Sendable {
        let states: [RouteSyncRecord]
        let removals: [String]
        /// 缺证明（或被版本/scope 拒绝）而**必须保留**的待办 UUID。
        let unproven: [String]
        let discoveryCursor: String?

        var isEmpty: Bool { states.isEmpty && removals.isEmpty && discoveryCursor == nil }
    }

    /// 一条记录是否算"一次真实观测"。
    ///
    /// 两个条件都必要：
    /// - `status != .unknown`：`.unknown` 是**哨兵**（`RouteSyncStateMachine.baseline`），
    ///   不是观测结果；把它当证据等于凭空造一条"查过了"；
    /// - `lastCheckedAt > .distantPast`：baseline 的 `lastCheckedAt` 就是 `.distantPast`。
    ///
    /// 合法零点（跑步机跑步、轨迹尚未到达）满足这两条 —— 它是真观测，必须能结算。
    static func isObservation(_ record: RouteSyncRecord) -> Bool {
        record.status != .unknown && record.lastCheckedAt > .distantPast
    }

    static func settle(_ candidate: RouteCommitCandidate?, scope: String) -> Result {
        guard let candidate else {
            // 老任务 / 没有候选：**一条待办都不删**（§3.2 步骤 9）。残缺的
            // `completedRouteTodos` 不是删除证明 —— 从 UUID 猜造状态是禁止的方向。
            return Result(states: [], removals: [], unproven: [], discoveryCursor: nil)
        }
        guard candidate.version == RouteCommitCandidate.currentVersion else {
            return Result(
                states: [], removals: [], unproven: candidate.completedTodoUUIDs,
                discoveryCursor: nil
            )
        }
        guard candidate.scope == scope else {
            return Result(
                states: [], removals: [], unproven: candidate.completedTodoUUIDs,
                discoveryCursor: nil
            )
        }
        var proven: [String: RouteSyncRecord] = [:]
        for (key, record) in candidate.states {
            let normalized = RouteCommitCandidate.normalize(key)
            guard normalized == RouteCommitCandidate.normalize(record.workoutUUID),
                  isObservation(record) else { continue }
            proven[normalized] = record
        }
        let states = proven.values.sorted { $0.workoutUUID < $1.workoutUUID }
        var removals: [String] = []
        var unproven: [String] = []
        for uuid in candidate.completedTodoUUIDs {
            let normalized = RouteCommitCandidate.normalize(uuid)
            if proven[normalized] != nil {
                removals.append(normalized)
            } else {
                unproven.append(normalized)
            }
        }
        return Result(
            states: states,
            removals: removals,
            unproven: unproven,
            discoveryCursor: candidate.discoveryCursor
        )
    }
}
