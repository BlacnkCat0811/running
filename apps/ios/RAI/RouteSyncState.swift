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
    /// P1-3（2026-10-18 同步诊断）：**服务端已确认收到的那一版轨迹内容摘要**。
    ///
    /// 为什么需要它：`routeHash` 只说"手机此刻看到的轨迹是什么"，不是"服务端有没有这一版"。
    /// 2026-10-18 的诊断实测，跑完 24h 内路线状态是 `.active`（每批都查），于是**同一份
    /// GPX 每批重发**，并且因为 `routeFiles` 非空，workout XML 也跟着重发（约 2527 点/批）。
    /// 记下交付过的摘要之后，导出侧才能在"内容没变、workout 没变更、也不是显式重试"时
    /// 不再把这份 GPX 放进载荷。
    ///
    /// 🔴 写入时机 = **批次成功提交之后**（与 `routeStates` 同一个结算事务，
    /// `SyncTaskStore.upsertRouteStates`）。绝不能在上传/导入之前写：那会把一份**从未被
    /// 服务端确认**的轨迹记成"已交付"，此后所有批次都不再重发它 —— 方向是**静默丢数据**。
    /// 老 payload/老行缺这一列 ⇒ `nil` = "没有交付证据" ⇒ 照旧每轮重查/重发（安全方向）。
    var deliveredHash: String? = nil
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

/// P2-1（A3）：**单个类型**的补齐进度。
///
/// 为什么"整窗总数"不够：见 `WorkoutBackfillWindow` 的 P2-1 一节。这里只放逐类型的可读状态，
/// 判据全部在 `WorkoutBackfillScheduler`（纯函数、有回归执行者）。
///
/// ⚠️ 本结构是 `types_json` 的**载荷**，它会被编成 JSON 落进 SQL 列。新增字段必须 Optional
/// （或提供显式 `init(from:)`），否则老 JSON 会整段解不开 —— 而读侧对解不开的处理是
/// "全部 unknown ⇒ 未完成"（安全方向，但会把窗口打成死循环重查）。当前版本由载荷里的
/// `ProgressPayload.version` 显式标记，未知版本同样按 unknown 处理。
nonisolated struct TypeProgress: Codable, Equatable, Sendable {
    /// **最近一趟**（完整窗口查询，不是增量）本类型读到的样本条数。0 = 读到了空页。
    var observed: Int = 0
    /// 已写进载荷的**累计**条数（只作诊断；不参与收口判据 —— 判据只看"读到了多少"）。
    var delivered: Int = 0
    /// 连续多少趟"与上一趟相同**且为正**"。`stabilityToComplete`（= 1）即"第二次相同"。
    /// 只有 `pageComplete && observed > 0` 且与 `previousObserved` 相等时才 +1；任何变化、
    /// 截断或空观测都清零。
    var stablePasses: Int = 0
    /// 上一趟是否读到了窗口末尾（`observed < pageLimit`）。`false` = 命中单类型上限，
    /// 页**可能被截断**（A2 分页尚未实现，不得把"这一页装满了"读成"没有更多了"）。
    var pageComplete: Bool = false
    /// 最近一次**真实查询**的时刻（授权失败 / 被预算切断的类型不动它）。
    var lastObservedAt: Date? = nil
    /// 上一趟**可比较**的条数。
    ///
    /// 为什么不能用别的字段代替：判据是"与上一趟相同"，而 `observed` 每次都被覆盖 ——
    /// 没有这一格，"稳定"就只能靠调用方跨批次记忆，进程重启即丢。`nil` = 没有可比基线
    /// （首查 / 上一趟被截断 / 上一趟为空观测）。
    var previousObserved: Int? = nil
}

/// P2-1（A3）：**本趟**对某个类型的观测事实。调用方只报事实，判据在调度器里。
///
/// 🔴 为什么要把 `pageLimit` 一起报上来：`HealthKitExport` 的窗口查询会按剩余份额**收窄**
/// 页大小（`DirectSyncBatchBudget.shareLimitedPageSize`）。返回条数恰好等于**本次的**
/// 页上限时，剩下的样本可能还在后面 —— 那种趟不能算"读到了 EOF"。
nonisolated struct TypeObservation: Equatable, Sendable {
    /// 本次查询返回的样本条数（0 = 空页，是合法观测）。
    let observed: Int
    /// 本趟真正写进载荷的条数。
    let delivered: Int
    /// 本次查询的页上限（`recentSamples(limit:)` 实际用的值）。
    let pageLimit: Int
    /// 授权错误：HealthKit 对"未授权读"报错或返回空，**不能**读成"没有样本"。
    /// 这类查询不是观测 —— 该类型的既有进度会被作废（方向：宁可多查，不可误判完整）。
    let unauthorized: Bool

    init(observed: Int, delivered: Int, pageLimit: Int, unauthorized: Bool = false) {
        self.observed = max(0, observed)
        self.delivered = max(0, delivered)
        self.pageLimit = max(0, pageLimit)
        self.unauthorized = unauthorized
    }

    /// 是否读到窗口末尾。`observed >= pageLimit` = 命中上限 ⇒ **可能**被截断。
    var pageComplete: Bool {
        !unauthorized && pageLimit > 0 && observed < pageLimit
    }
}

/// P2-1（A3）：最近一趟窗口查询的**结局**（`completionReason` 的载体，随 `types_json` 落盘）。
nonisolated enum WorkoutBackfillPassOutcome: String, Codable, Sendable {
    /// 整窗跑完（可能仍然 pending：只是"这一趟读完了"，不是"补齐了"）。
    case settled
    /// 页预算/份额把这一趟切断 ⇒ 不记账，下批从同一窗口重来。
    case budgetBlocked = "blocked"
    /// 本趟有类型因授权失败而**没读到**（不是空，是不知道）。
    case unauthorized
}

/// P0-4（2026-10-18 同步诊断）：一条「刚完成的训练」的**定向补齐窗口**。
///
/// ## 为什么需要它
///
/// 2026-10-18 的 6km 跑步实测：跑完 97 s 内服务端只拿到 HR/步幅/PhysicalEffort 四类，
/// speed/power/cadence/VO/GCT 一条都没有。原因不是导出顺序，而是 **Apple Watch → iPhone
/// 的样本是流式到达的**：每次同步只是"当时手机里已有样本"的快照。而客户端**只有**路线侧的
/// 持久待办（`sync_pending_routes`），没有 workout 级待办 ⇒ 一次训练缺哪些类型、还差多久，
/// 没有任何机制记录与补齐。历史重放期里，新数据只能挤 48h 窗口的 20% 份额。
///
/// 本类型是那个缺口的持久载体：把"这次训练的时间窗还没补齐"写成一行（与路线待办同库、
/// 同一条"成功后才结算"纪律），后续每批在**任何历史重放之前**按窗口做一次**全类型**有界
/// 查询，直到"每个已登记类型都读到窗口末尾且连续两趟一致"或 7 天到期才收口。
///
/// ## P2-1（A3，2026-10-19）：为什么收口判据必须是**逐类型**的
///
/// 旧判据是"整窗总样本数连续两次相同"（`lastSampleCount` / `stableCount`）。生产实测
/// （`deliverables/IOS_SYNC_INGEST_AUDIT_2026-10-19.md` A3）里它把"500 条心率 + 其余类型
/// 全 0"的两次查询读成"补齐完成"，而 HealthKit 的迟到样本（实测 36–72 h）随后到达时窗口
/// 已经关闭 —— 迟到的类型**没有任何机制重开**。总数相同既不证明缺失类型已提供，也不证明
/// 已有类型的内容/覆盖没有变化。所以现在：
/// - 每个类型的可读状态各自记账（见 `TypeProgress` 与 `TypeObservation`）；
/// - "已见类型"必须 `pageComplete && stablePasses >= 1`；命中单类型 `limit` 视为**可能截断**
///   （A2 分页尚未实现 ⇒ **不得**假设 EOF）；
/// - "已登记但从未读到样本"的类型记 unseen，**只有 7 天到期**才退出 —— "稳定"可以用于降频，
///   但不能直接等同"完整"；
/// - 结算原因区分 `completed` / `expired` / `blocked`（页预算）/ `unauthorized`。
///
/// 🔴 向下兼容：`types` / `lastPassOutcome` 是**新增列**（`types_json`）。老行没有它 ⇒
/// 读侧按"全部 unknown ⇒ 未完成"处理（`SyncTaskStore` 里显式清掉 `completedAt`），
/// 方向是"多查一次"而不是"把没读到读成已完整"。
///
/// ## 为什么窗口要加 5 分钟
///
/// 训练前后的恢复心率/PhysicalEffort 常落在 `[start, end]` 之外几十秒；查询窗口取
/// `[start − 5min, end + 5min]` 才能把"跑完那一刻才到的样本"也覆盖进来。服务端按
/// `RAIHealthKitSampleUUID` 幂等，重复写到正式流已覆盖的样本不会产生重复事实。
///
/// ## 与正式 anchor/窗口的关系
///
/// 窗口 pass 用**无锚点 + 时间谓词**查询（`HealthKitExport` 的 `recentSamples`），
/// **绝不推进**正式 anchor，也不改任何游标记账 —— 它只是一条并行的恢复通道。
/// 它写进载荷的样本也与 48h 窗口 pass / 正式 anchor 段可能重复：那是**有意接受**的，
/// 因为服务端按 UUID last-wins 幂等，而窗口自己是有界、有限次（≤ 5 次检查）的。
nonisolated struct WorkoutBackfillWindow: Codable, Equatable, Sendable {
    /// 小写化的 workout UUID（口径与 `HealthKitExport.routeFileWorkoutId` 同源）。
    let workoutUUID: String
    /// 查询下界 = `workout.startDate − 5min`（见 `WorkoutBackfillScheduler.windowPadding`）。
    var windowStart: Date
    /// 查询上界 = `workout.endDate + 5min`。
    var windowEnd: Date
    /// **首次**登记时刻。它同时是 7 天到期判据的起点，重开窗口也**不**刷新它 ——
    /// 否则一条反复变更的老训练可以让窗口永远活着（无界重复查询）。
    let createdAt: Date
    /// 下一次允许查询的时刻（重试序列见 `WorkoutBackfillScheduler.retryIntervals`）。
    var nextCheckAt: Date
    /// 已完成的**整窗查询**次数（预算没跑完的一趟不计数）。
    var attemptCount: Int
    /// **老判据的遗留字段**（P2-1 之前：整窗总样本数"连续两次相同"）。
    ///
    /// 现在只记"最近一趟查到的样本总数"（诊断/日志），**不再参与收口判据** —— 判据已移到
    /// `types` 的逐类型进度。保留这一列是为了不重建表、也让降级回旧版本时行还是可读的。
    var lastSampleCount: Int
    /// **老判据的遗留字段**（连续多少次整窗总数相同）。新逻辑不再写非零值，只保留列兼容。
    var stableCount: Int
    /// P2-1（A3）：**逐类型进度**（键 = `export.xml` 类型名，如
    /// `HKQuantityTypeIdentifierHeartRate`）。
    ///
    /// 空字典 = 这一行没有**任何**逐类型证据（新登记的窗口，或老版本写下的行）。
    /// 两种都必须读成"未完成"：老行的 `completedAt` 会被读侧清掉（见类型头部兼容一节）。
    var types: [String: TypeProgress] = [:]
    /// P2-1（A3）：最近一趟窗口查询的结局。`completed`/`pending` 之外的收口原因
    /// （`blocked`/`unauthorized`）由它承载；见 `WorkoutBackfillScheduler.completionReason`。
    var lastPassOutcome: WorkoutBackfillPassOutcome? = nil
    /// 非 nil = 已收口（逐类型补齐完成或 7 天到期），不再查询；行保留供诊断。
    var completedAt: Date?

    var isCompleted: Bool { completedAt != nil }

    /// 7 天上限的到期时刻（诊断用；判据在 `WorkoutBackfillScheduler.afterPass`）。
    var expiresAt: Date { createdAt.addingTimeInterval(WorkoutBackfillScheduler.completionWindow) }
}

/// P0-4 的**纯逻辑**调度器：登记/刷新、到期判定、重试序列、收口判据。
///
/// 为什么必须是纯函数、且住在 `RouteSyncState.swift`：`HealthKitExport` 依赖 HealthKit，
/// 不能被任何回归编译；而"什么时候该再查一次 / 什么时候算补齐了"正是这条修复里**最容易
/// 写错又最贵**的判据（写成无限重试 ⇒ 每批白读 18 次 HealthKit；写得太早收口 ⇒ 迟到样本
/// 重新永久缺失，正是 2026-10-14 事故的形态）。放在这里，`RouteSyncStateMachineTests`
/// 与 `RouteSyncStatePersistenceRegression` 都能直接钉它。
nonisolated enum WorkoutBackfillScheduler {
    /// 窗口两侧的 padding（见 `WorkoutBackfillWindow` 的说明）。
    static let windowPadding: TimeInterval = 5 * 60

    /// 只给"最近这段时间内结束"的训练登记窗口。更老的不再新增（历史重放自己会覆盖），
    /// 也避免一条老训练因元数据变化被反复登记。
    static let registrationLookback: TimeInterval = 7 * 24 * 60 * 60

    /// 窗口从**首次登记**起最多存活这么久，到点无论观测如何都收口。
    /// 依据：10-14 实测迟到样本 36–72 h 到达；7 天给足两轮完整迟到窗口，同时给"无界补齐"封顶。
    static let completionWindow: TimeInterval = 7 * 24 * 60 * 60

    /// 到期重试序列：15 min / 1 h / 6 h / 24 h / 72 h（第 5 次之后保持 72 h 直到 7 天到期）。
    static let retryIntervals: [TimeInterval] = [15 * 60, 60 * 60, 6 * 60 * 60, 24 * 60 * 60, 72 * 60 * 60]

    /// 单批最多处理几条窗口（有界是判据的一部分：每条窗口 × 18 个类型，不能把一批变成
    /// 上百次查询）。按 `nextCheckAt` 最早优先，同龄按 UUID 稳定排序。
    static let passBatchLimit = 4

    /// 单类型单窗口的查询上限（`recentSamples` 的 limit）。有界同 `recentWindowLimit`。
    static let perTypeLimit = 1500

    /// 逐类型"连续多少次相同"算稳定。
    ///
    /// **= 1 ⇒ 第二次观测到相同正数即该类型稳定**（不是"三次"：旧注释写"连续两次一致"容易
    /// 被读成需要两格增量，审计报告 §3.1 专门点过这一处）。判定在 `afterPass`：
    /// 首趟只记基线（`stablePasses == 0`），第二趟相同才 +1。
    static let stabilityToComplete = 1

    /// 本批窗口**尝试**的结局（供日志/收口原因；纯值，不落库）。
    ///
    /// - `completed`：每个登记类型都 `pageComplete && stablePasses >= 1`。
    /// - `expired`：7 天上限到期（无论观测如何）。
    /// - `blocked`：页预算/份额切断了一趟，**没有**推进稳定计数。
    /// - `unauthorized`：本趟有类型因授权失败而没读到（不是空，是不知道）。
    /// - `pending`：还没收口，继续走重试阶梯。
    static let reasonPending = "pending"
    static let reasonCompleted = "completed"
    static let reasonExpired = "expired"
    static let reasonBlocked = "blocked"
    static let reasonUnauthorized = "unauthorized"

    /// 是否该为这条 workout 登记/刷新窗口。
    /// - Parameter endDate: workout 的结束时刻（**不是**开始时刻：轨迹/统计跑完才成形）。
    static func shouldRegister(endDate: Date, now: Date) -> Bool {
        let age = now.timeIntervalSince(endDate)
        return age >= -windowPadding && age <= registrationLookback
    }

    /// 第 `attempts` 次整窗查询之后的等待时长（调用方传**新的** `attemptCount`，从 1 起）。
    static func retryInterval(attempts: Int) -> TimeInterval {
        let index = min(max(0, attempts - 1), retryIntervals.count - 1)
        return retryIntervals[index]
    }

    /// 登记/刷新一条窗口。返回 `nil` = 这条 workout 不在登记窗口内（太老/时间在未来）。
    ///
    /// 三种输入形态：
    /// 1. 没有旧行：新建，`nextCheckAt = now`（本批就会查一次）。
    /// 2. 有旧行、窗口**没有变宽**：原样返回。这是 `hasWorkoutChange` 因元数据/统计变化
    ///    反复命中的常见形态 —— 不刷新调度、不重开已收口的窗口，否则"每批都改一行元数据"
    ///    就能让这条窗口永远排队（无界重复查询）。
    /// 3. 有旧行、窗口**变宽了**（endDate 后移/startDate 前移 ⇒ 确实出现新的样本区间）：
    ///    重新排队（清 `completedAt`/逐类型进度/尝试次数），但**保留 `createdAt`** ——
    ///    7 天上限仍然从首次登记起算。已过 7 天的窗口不再重开。
    ///
    /// 🔴 形态 3 必须清空 `types`：旧进度是**旧时间区间**的观测，窗口一宽就不可比
    /// （"上一次相同"的判据会把两个不同区间的计数当成一次稳定）。清空 = 全部回到 unseen，
    /// 方向是"多读一遍"，绝不把扩大后的区间读成已完整。
    static func register(
        workoutUUID: String,
        startDate: Date,
        endDate: Date,
        existing: WorkoutBackfillWindow?,
        now: Date
    ) -> WorkoutBackfillWindow? {
        guard shouldRegister(endDate: endDate, now: now) else { return nil }
        let start = startDate.addingTimeInterval(-windowPadding)
        let end = endDate.addingTimeInterval(windowPadding)
        if let existing {
            let widened = start < existing.windowStart || end > existing.windowEnd
            guard widened else { return existing }
            // 已过 7 天上限 ⇒ 不再重开（重开也只会被 `afterPass` 立刻收口）。
            guard now.timeIntervalSince(existing.createdAt) < completionWindow else { return existing }
            var refreshed = existing
            refreshed.windowStart = min(existing.windowStart, start)
            refreshed.windowEnd = max(existing.windowEnd, end)
            refreshed.nextCheckAt = now
            refreshed.attemptCount = 0
            refreshed.lastSampleCount = 0
            refreshed.stableCount = 0
            refreshed.types = [:]
            refreshed.lastPassOutcome = nil
            refreshed.completedAt = nil
            return refreshed
        }
        return WorkoutBackfillWindow(
            workoutUUID: workoutUUID,
            windowStart: start,
            windowEnd: end,
            createdAt: now,
            nextCheckAt: now,
            attemptCount: 0,
            lastSampleCount: 0,
            stableCount: 0,
            completedAt: nil
        )
    }

    /// A1（2026-10-19 复核）：**本批可用的窗口快照**。
    ///
    /// `persisted` 是"上一批结束时就已在盘上"的窗口；`acceptedPageRegistrations` 是本批
    /// **已完整交付的页**新登记/刷新的窗口（`pageWindowRegistrations` 只在页被接受后并入，
    /// 被拒页的那一份随页丢弃）。读记录必须用两者的并集，否则"本批刚发现的训练"永远不会在
    /// 本批被定向补读 —— 现象是用户必须再点一次同步才能看到各项时序。
    ///
    /// 同 UUID 以页内登记为准：它可能因窗口变宽而重开（`register` 的 `widened` 分支）。
    static func batchSnapshot(
        persisted: [WorkoutBackfillWindow],
        acceptedPageRegistrations: [WorkoutBackfillWindow]
    ) -> [WorkoutBackfillWindow] {
        // 用逐个赋值而不是 `Dictionary(uniqueKeysWithValues:)`：后者在重复键上会崩溃，
        // 而这里的输入是"同一 UUID 的旧值与新值"，后写覆盖正是想要的行为。
        var byUUID: [String: WorkoutBackfillWindow] = [:]
        for window in persisted { byUUID[window.workoutUUID] = window }
        for window in acceptedPageRegistrations { byUUID[window.workoutUUID] = window }
        return Array(byUUID.values)
    }

    /// 窗口是否已过 7 天上限。**选择之前**就要问一次（A2/A4 复核）。
    ///
    /// 旧实现只在 `afterPass` 里结算过期，而 `afterPass` 只在"整窗所有类型都跑完"时才调用 ——
    /// 一个被份额反复截断的窗口永远跑不完，于是它的 `nextCheckAt` 永远 `<= now`：
    /// 既排在 `due` 的最前面挡住别的窗口，又会让待办探针永远回答"还有活"。
    static func isExpired(_ window: WorkoutBackfillWindow, now: Date) -> Bool {
        now.timeIntervalSince(window.createdAt) >= completionWindow
    }

    /// 盘上是否存在**现在就该查**的窗口（A4）。待办探针与前台补跑共用同一条判据。
    ///
    /// 三个条件缺一不可：未收口、未过期、已到期。写成纯函数是为了让"未来 6 小时后的复查"
    /// 与"7 天前的死窗口"这两种容易写成自旋的形态，必须有回归执行者。
    static func hasDueWindow(
        _ windows: [String: WorkoutBackfillWindow],
        now: Date
    ) -> Bool {
        windows.values.contains {
            !$0.isCompleted && !isExpired($0, now: now) && $0.nextCheckAt <= now
        }
    }

    /// 本批要处理的窗口（到期、未收口；有界 + 公平序）。
    static func due(
        _ windows: [WorkoutBackfillWindow],
        now: Date,
        limit: Int = passBatchLimit
    ) -> [WorkoutBackfillWindow] {
        guard limit > 0 else { return [] }
        return windows
            .filter { !$0.isCompleted && !isExpired($0, now: now) && $0.nextCheckAt <= now }
            .sorted { lhs, rhs in
                if lhs.nextCheckAt != rhs.nextCheckAt { return lhs.nextCheckAt < rhs.nextCheckAt }
                return lhs.workoutUUID < rhs.workoutUUID
            }
            .prefix(limit)
            .map { $0 }
    }

    /// 逐类型收口判据（P2-1/A3）：**每个登记类型**都必须
    /// `pageComplete && stablePasses >= stabilityToComplete`。
    ///
    /// 🔴 三个"不得"：
    /// - `registeredTypes` 为空 ⇒ **不得**收口（没有登记类型 = 没有判据，老行/未知形态都走这里）；
    /// - 没有进度条目的类型 = unseen ⇒ 不得收口（"没读到"不是"没有"）；
    /// - 命中单类型上限（`pageComplete == false`）⇒ 不得收口，即便两次条数相同
    ///   （A2 分页未实现，`observed == pageLimit` 只是"这一页满了"）。
    static func isComplete(
        _ window: WorkoutBackfillWindow,
        registeredTypes: [String]
    ) -> Bool {
        let registered = Set(registeredTypes)
        guard !registered.isEmpty else { return false }
        return registered.allSatisfy { type in
            guard let progress = window.types[type] else { return false }
            return progress.pageComplete && progress.stablePasses >= stabilityToComplete
        }
    }

    /// 已登记但**从未读到样本**的类型（诊断/回归用；顺序确定）。
    ///
    /// "unseen" 的口径 = 没有进度条目，或最近一趟观测为 0（0 是合法观测，但不是"看到了样本"）。
    /// 它们不参与完成，只能等 7 天到期 —— 这正是 A3 要的"迟到类型自动重开"的另一面。
    static func unseenTypes(
        _ window: WorkoutBackfillWindow,
        registeredTypes: [String]
    ) -> [String] {
        Set(registeredTypes).sorted().filter { type in
            guard let progress = window.types[type] else { return true }
            return progress.observed == 0
        }
    }

    /// 一趟**完整**窗口查询之后的记账（整窗所有类型都查完；被预算切断的一趟走
    /// `afterBlockedPass`）。
    ///
    /// 判据（P2-1/A3，替代旧的"整窗总数两次相同"）：
    /// - 逐类型：本趟 `pageComplete && observed > 0` 且与上一趟同一个数 ⇒ `stablePasses += 1`；
    ///   首趟 / 数变了 / 被截断 / 空观测 ⇒ 清零（`previousObserved` 只在"可比较"时才记）；
    /// - 收口：每个登记类型都 `pageComplete && stablePasses >= stabilityToComplete`，或 7 天到期；
    /// - 否则按重试序列排下一次检查。
    ///
    /// 🔴 **为什么"0 样本"不能靠稳定收口**：Apple Watch → iPhone 的迟到样本实测 36–72 h
    /// 才到（`docs/HEALTHKIT_RECORD_SYNC_V2.md` §54-86 与 2026-10-14/17 两次事故）。若空窗在
    /// 15m/1h 两次空查后就判"稳定、已收口"，那正好把"样本还没到手机"读成"这条训练没有这些
    /// 类型"—— P0-4 会在最需要它的场景里失效。空观测不是"数据已稳定"的证据（与 10-14
    /// "空窗不得推进水位"同一条纪律：**没读到 ≠ 没有**）。
    /// 因此空类型只能靠**7 天到期**强制收口；期间按 15m/1h/6h/24h/72h 继续重试。
    ///
    /// - Parameters:
    ///   - observations: 本趟每个**成功查询**的类型的观测事实。缺条目 = 该类型本趟没读到
    ///     （授权失败或被预算挡住）⇒ 既有进度保留，但本趟不构成"新证据"。
    ///   - registeredTypes: 本窗口**已登记**的类型（`HealthKitExport` 的 quantity descriptors）。
    ///     它决定 unseen：登记过却从未读到样本的类型不允许被其它类型的正数"代为完成"。
    static func afterPass(
        _ window: WorkoutBackfillWindow,
        observations: [String: TypeObservation],
        registeredTypes: [String],
        now: Date
    ) -> WorkoutBackfillWindow {
        var next = window
        var merged = window.types
        var unauthorized = false
        for type in observations.keys.sorted() {
            guard let observation = observations[type] else { continue }
            if observation.unauthorized {
                // 授权失败不是"空页"：作废该类型的可读证据（宁可多查，不可误判完整）。
                unauthorized = true
                if var progress = merged[type] {
                    progress.stablePasses = 0
                    progress.previousObserved = nil
                    progress.pageComplete = false
                    merged[type] = progress
                }
                continue
            }
            var progress = merged[type] ?? TypeProgress()
            if observation.pageComplete, observation.observed > 0 {
                if let previous = progress.previousObserved, previous == observation.observed {
                    progress.stablePasses += 1
                } else {
                    progress.stablePasses = 0
                }
                progress.previousObserved = observation.observed
            } else {
                // 截断/空观测都不是"数据已稳定"的证据；0 → 正数时必须重新从首查算起。
                progress.stablePasses = 0
                progress.previousObserved = nil
            }
            progress.observed = observation.observed
            progress.delivered += observation.delivered
            progress.pageComplete = observation.pageComplete
            progress.lastObservedAt = now
            merged[type] = progress
        }
        next.types = merged
        next.lastSampleCount = observations.values.reduce(0) { $0 + $1.observed }
        next.attemptCount = window.attemptCount + 1
        next.lastPassOutcome = unauthorized ? .unauthorized : .settled
        let expired = now.timeIntervalSince(window.createdAt) >= completionWindow
        if isComplete(next, registeredTypes: registeredTypes) || expired {
            next.completedAt = now
            next.nextCheckAt = now
            return next
        }
        next.completedAt = nil
        next.nextCheckAt = now.addingTimeInterval(retryInterval(attempts: next.attemptCount))
        return next
    }

    /// 被页预算/份额**切断**的一趟的记账（P2-1/A3）。
    ///
    /// 与 `afterPass` 的分工：
    /// - **推进**逐类型实况（`observed`/`pageComplete`/`delivered`/`lastObservedAt`）——
    ///   这叫"份额耗尽后仍有进展"；
    /// - **不推进** `stablePasses`/`previousObserved`，也**不**加 `attemptCount`、**不**动
    ///   `nextCheckAt`：这一趟不是一次完整的整窗查询，下批必须从同一窗口重来（与旧实现
    ///   "不记账"同一条纪律）。已写出的样本不回滚（载荷是追加写的，服务端按 UUID 幂等）。
    /// - 记下结局（`blocked` / `unauthorized`），让"到期有原因"成立。
    static func afterBlockedPass(
        _ window: WorkoutBackfillWindow,
        observations: [String: TypeObservation],
        now: Date
    ) -> WorkoutBackfillWindow {
        var next = window
        var merged = window.types
        var unauthorized = false
        for type in observations.keys.sorted() {
            guard let observation = observations[type] else { continue }
            if observation.unauthorized {
                unauthorized = true
                if var progress = merged[type] {
                    progress.stablePasses = 0
                    progress.previousObserved = nil
                    progress.pageComplete = false
                    merged[type] = progress
                }
                continue
            }
            var progress = merged[type] ?? TypeProgress()
            progress.observed = observation.observed
            progress.delivered += observation.delivered
            progress.pageComplete = observation.pageComplete
            progress.lastObservedAt = now
            // stablePasses / previousObserved 刻意不动（见函数说明）。
            merged[type] = progress
        }
        next.types = merged
        next.lastSampleCount = observations.values.reduce(0) { $0 + $1.observed }
        next.lastPassOutcome = unauthorized ? .unauthorized : .budgetBlocked
        return next
    }

    /// 收口原因（日志/任务行只记原因，不记样本值）。
    ///
    /// 取值：`completed` / `expired` / `blocked` / `unauthorized` / `pending`。
    /// - 已收口：`completedAt` 距 `createdAt` 达到 7 天上限 ⇒ `expired`，否则 `completed`；
    /// - 未收口：看最近一趟结局（被预算切断 ⇒ `blocked`；授权失败 ⇒ `unauthorized`）。
    static func completionReason(_ window: WorkoutBackfillWindow) -> String {
        if window.isCompleted {
            let completedAt = window.completedAt ?? window.createdAt
            let elapsed = completedAt.timeIntervalSince(window.createdAt)
            return elapsed >= completionWindow ? reasonExpired : reasonCompleted
        }
        switch window.lastPassOutcome {
        case .budgetBlocked: return reasonBlocked
        case .unauthorized: return reasonUnauthorized
        case .settled, nil: return reasonPending
        }
    }

    /// `types_json` 的载荷形态（P2-1/A3）。
    ///
    /// 为什么不直接编码 `WorkoutBackfillWindow`：窗口的其余字段各有独立 SQL 列（时间列必须走
    /// `canonicalForREAL`），只有这一组是 JSON。`version` 是显式的：未知版本一律当 unknown 读
    /// （`decodeProgress` 返回 nil），不按当前字段猜 —— 与 `RouteCommitCandidate` 同一条纪律。
    nonisolated struct ProgressPayload: Codable, Equatable, Sendable {
        static let currentVersion = 1
        let version: Int
        let types: [String: TypeProgress]
        let lastPassOutcome: WorkoutBackfillPassOutcome?
        /// 写这份 JSON 时窗口行的 `attempt_count` / `completed_at`。
        ///
        /// 用途是**降级回滚的识别**：老版本 App 的 UPSERT 不含 `types_json` 列，退回老版本再
        /// 跑一轮时，它会改 `attempt_count`/`completed_at` 却把这份 JSON 原样留在盘上。
        /// 读侧拿这两个字段与列值对账，对不上就说明"这行被旧写入者改过" ⇒ 按 unknown 处理
        /// （未完成，重查一次），绝不拿旧版本的 completed 当新判据的证据。
        let attemptCount: Int
        let completedAt: Date?
    }

    /// 编码为 `types_json`。`sortedKeys` 让同一窗口两次编码**逐字节相同**（回读/对账可比较）。
    static func encodeProgress(_ window: WorkoutBackfillWindow) -> Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try? encoder.encode(ProgressPayload(
            version: ProgressPayload.currentVersion,
            types: window.types,
            lastPassOutcome: window.lastPassOutcome,
            attemptCount: window.attemptCount,
            completedAt: window.completedAt
        ))
    }

    /// 解码 `types_json`。**nil = 全部 unknown**（老行没有这一列 / 未知版本 / 损坏）——
    /// 读侧必须据此把该窗口当成"未完成"，绝不能按完成处理。
    static func decodeProgress(_ data: Data?) -> ProgressPayload? {
        guard let data, !data.isEmpty else { return nil }
        guard let payload = try? JSONDecoder().decode(ProgressPayload.self, from: data) else { return nil }
        guard payload.version == ProgressPayload.currentVersion else { return nil }
        return payload
    }

    /// 需要持久化的窗口集合（去重 + 稳定排序；表键 `(scope, workout_uuid)`）。
    static func normalized(_ windows: [WorkoutBackfillWindow]) -> [WorkoutBackfillWindow] {
        var byUUID: [String: WorkoutBackfillWindow] = [:]
        for window in windows {
            byUUID[window.workoutUUID.lowercased()] = window
        }
        return byUUID.values.sorted { $0.workoutUUID < $1.workoutUUID }
    }
}
