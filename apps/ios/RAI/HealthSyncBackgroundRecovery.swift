import Foundation

/// 后台冷启动恢复与意图确认的纯逻辑。
///
/// `HealthKitSync` 本身依赖 HealthKit/UIKit，无法进入本机纯逻辑回归；这里承载三条必须有
/// 执行者的规则：
///
/// 1. 离线握手只能恢复“候选 scope”，让后台知道盘上可能有事；真正执行前仍要在线握手；
/// 2. 任务的服务端、运动员、数据集 epoch、协议版本必须逐项匹配，陈旧身份不能冒充当前任务；
/// 3. 后台意图只在任务成功落盘或同步成功提交后确认，并且只确认本轮观察到的代次。
nonisolated enum HealthSyncBackgroundRecovery {
    struct Identity: Equatable, Sendable {
        let serverId: String
        let athleteId: String
        let datasetEpoch: String
        let protocolVersion: Int
        let syncScope: String
    }

    struct Context: Equatable, Sendable {
        let serverURL: String
        let urlScope: String
        let activeScope: String
        let identity: Identity?
    }

    struct TaskIdentity: Equatable, Sendable {
        let target: String
        let serverId: String?
        let athleteId: String?
        let datasetEpoch: String?
        let protocolVersion: Int?
    }

    struct IntentObservation: Equatable, Sendable {
        let scope: String
        let generation: String
    }

    /// 意图位的**成因**。两者都表示"这个目标需要跑一轮"，但来源完全不同：
    ///
    ///   - `healthData`：HealthKit 真的投递了一次变更（用户带着手表跑了步）。
    ///   - `scopeRecovery`：**在线握手**证明权威 scope 变了（服务端换了数据集 epoch / 换了
    ///     运动员），于是新 scope 需要重开一批。它不是"新数据通知"，而是"新身份还没有批次"。
    ///
    /// 为什么要分开存而不是合成一个槽：合成之后，确认其中一个必然顺手删掉另一个 ——
    /// 而"新 scope 还没有批次"这条依据一旦被一批**旧 scope 的**导出确认掉，新 scope 就再也
    /// 不会有人重开（现象是后台静默 `nothingToDo`，直到用户手动点同步）。
    enum IntentCause: String, Sendable, CaseIterable {
        case healthData
        case scopeRecovery
    }

    /// 一个目标的**只读待办快照**。
    ///
    /// 它存在的理由：调度（要不要再排一轮）与完成回执（报成功还是失败）必须由
    /// **这一轮自己按目标读到的**结论决定，而不是由 `HealthKitSync` 上的全局展示标志决定 ——
    /// 那个标志属于**最后一次**同步写它的那个服务端，而单飞闸门拒绝掉的一轮根本没有
    /// 碰过任何标志。
    struct PendingWork: Equatable, Sendable {
        /// 三类判定。`unknown` **不等于**`empty`：它表示"读不出来"或"归属无法判定"，
        /// 此时既不能说没有待办（会静默丢批次），也不能说有待办（会永远空转）。
        enum Verdict: Equatable, Sendable {
            /// 盘上有属于这个目标的任务行。
            case pending
            /// 已确认：这个目标没有任务行，且库里也不存在归属不明的任务行。
            case empty
            /// 读取失败，或库里有行但归属无法判定（身份未知）。
            case unknown
        }

        let serverURL: String
        let urlScope: String
        /// 探针判定归属的那个 scope。身份未知时它是 URL scope —— 是**候选**，不是权威。
        let scope: String
        let verdict: Verdict
        /// 这个 URL scope 上是否挂着一条**健康数据通知**。
        let hasIntent: Bool
        /// 这个 URL scope 上是否挂着一条**恢复请求**（在线握手确认 scope 变了）。
        let hasRecoveryRequest: Bool
        /// 该 scope 上是否悬着**未读完的页**（S2.3：上一批导出被单批预算截断的持久痕迹，
        /// 落在 `SyncTaskStore.sync_continuation` 槽）。
        ///
        /// 与 `hasUncoveredGeneration` 是**不同的事**：后者是"外部又产生了活"（新投递 /
        /// scope 恢复请求），本字段是"自己的活没读完"。两者的正确处置不同（前者要重扫新数据，
        /// 后者从已提交游标接着读即可），而**同一份额度里分不开它们**会互相吃掉：
        /// 前台补跑额度若只按"有新代次"分配，一次 12,000 条的积压（每批 4,500）会从第二页起
        /// 全被甩给后台；反过来若把"有待续页"也算新代次，大批导入期间的前台自旋护栏就失效了。
        /// 见 `SyncFollowUp.handoff`。
        let hasPendingContinuation: Bool
        /// 该 scope 上是否有**现在就该查**的 workout 定向补齐窗口（A4，2026-10-19 复核）。
        ///
        /// 与 `hasPendingContinuation` 是两件事：后者是"上一批导出被预算截断的续页"，
        /// 本字段是"盘上登记了一个到期未收口的窗口"。缺了它，普通 anchor 已追平、通知已确认、
        /// 没有在途批次时，探针会回答"没有下一轮" —— 而窗口的 `nextCheckAt` 就躺在库里，
        /// 没人执行它。用户看到的现象就是"得再点一次同步"。
        ///
        /// ⚠️ **只算"已到期且未过期"**：未来的 `nextCheckAt` 不算活儿（否则前台每轮都会
        /// 立刻重跑），超过 7 天上限的也不算（那是 `WorkoutBackfillScheduler.isExpired`）。
        var hasDueWorkoutWindow: Bool = false

        /// 盘上可能还有没走完的活儿。`unknown` 算"有" —— 保守方向是"多排一轮"，
        /// 而不是"报个成功然后没人再管"。
        var hasUnfinishedWork: Bool { verdict != .empty }

        /// 这个目标身上挂着**一代没有被任何一轮覆盖到**的变更：一条健康数据通知，或一条
        /// scope 恢复请求。
        ///
        /// 与 `needsAnotherRound` 刻意分开：那个还包含"盘上卡着一批没走完的字节"，而"补跑新
        /// 代次"不该顺手重放一次失败的批次（那是后台重排的活，`applicationDidEnterBackground`
        /// 与 BGTask 的回执都用 `needsAnotherRound`）。混用的可见后果是：一次网络失败之后
        /// 前台会立刻再跑一轮同样的失败请求 —— 那不是"接住新代次"，只是重放错误。
        ///
        /// ⚠️ 也**刻意不含** `hasPendingContinuation`：待续页不是新代次（见该字段说明）。
        var hasUncoveredGeneration: Bool { hasIntent || hasRecoveryRequest }

        /// 收工后还要不要再排一次后台执行。`BGTaskScheduler` 的请求是一次性的。
        ///
        /// 含 `hasPendingContinuation`：还有页没读完 = 还有活（分层上是"自己的活"，
        /// 但对"要不要再排一轮"的回答与另两种成因一致）。
        var needsAnotherRound: Bool {
            hasUnfinishedWork || hasIntent || hasRecoveryRequest || hasPendingContinuation
                || hasDueWorkoutWindow
        }

        /// 这一轮能不能向系统报"成功"。判据就是"收工时还有没有事情没做完"（`needsAnotherRound`）。
        var reportsSuccess: Bool { !needsAnotherRound }
    }

    /// 三类判定的唯一来源。写成一个纯函数是为了让"读盘失败"与"身份未知"这两个
    /// **容易退化成 `empty`** 的形态必须有执行者（`HealthSyncBackgroundRecoveryRegression`）。
    ///
    /// - Parameters:
    ///   - identityKnown: 离线握手缓存是否可用。不可用时只知道 URL scope。
    ///   - scopedTaskFound: 在候选 scope（权威 scope + URL scope）上读到了任务行。
    ///   - storesAnyTask: 库里存在任务行（任 scope）。只在身份未知时才需要参考它。
    ///   - readFailed: 任一读取调用失败。
    static func pendingWorkVerdict(
        identityKnown: Bool,
        scopedTaskFound: Bool,
        storesAnyTask: Bool,
        readFailed: Bool
    ) -> PendingWork.Verdict {
        if readFailed { return .unknown }
        if scopedTaskFound { return .pending }
        if identityKnown { return .empty }
        // 身份未知：库里还有行，但没有一行在本目标的 scope 上 ⇒ 那一批归谁无法判定。
        return storesAnyTask ? .unknown : .empty
    }

    enum DurableCheckpoint: Equatable, Sendable {
        case none
        case taskPersisted
        case syncCommitted
    }

    /// `identity == nil` 时只能绑定 URL scope；有离线握手时恢复真实 sync scope。
    /// 这个 context 是候选上下文，不代表服务端身份仍然权威。
    static func context(
        serverURL: String?,
        urlScope: String?,
        identity: Identity?
    ) -> Context? {
        guard let serverURL, let urlScope else { return nil }
        return Context(
            serverURL: serverURL,
            urlScope: urlScope,
            activeScope: identity?.syncScope ?? urlScope,
            identity: identity
        )
    }

    /// 旧任务允许身份字段为空；一旦字段存在，就必须与恢复/在线握手身份逐项一致。
    /// 没有身份时不得接纳带身份的任务，否则 URL 相同但 dataset epoch 已变化时会串批。
    static func taskMatches(_ task: TaskIdentity, context: Context) -> Bool {
        guard task.target == context.serverURL else { return false }
        let carriesIdentity = task.serverId != nil || task.athleteId != nil
            || task.datasetEpoch != nil || task.protocolVersion != nil
        guard let identity = context.identity else { return !carriesIdentity }
        if let serverId = task.serverId, serverId != identity.serverId { return false }
        if let athleteId = task.athleteId, athleteId != identity.athleteId { return false }
        if let datasetEpoch = task.datasetEpoch, datasetEpoch != identity.datasetEpoch { return false }
        if let protocolVersion = task.protocolVersion, protocolVersion != identity.protocolVersion { return false }
        return true
    }

    /// UserDefaults 旧版本存的是 `Date`，新版本存 UUID 字符串；两种都转成稳定代次。
    static func intentGeneration(from stored: Any?) -> String? {
        if let generation = stored as? String, !generation.isEmpty { return generation }
        if let date = stored as? Date {
            return "legacy-date-\(date.timeIntervalSinceReferenceDate.bitPattern)"
        }
        return nil
    }

    /// 只有出现耐久检查点、且磁盘上的代次仍是本轮看到的那一个，才允许删除意图。
    /// 导出期间若又收到通知，当前代次会变化，本轮完成也不能把新通知一起吞掉。
    static func shouldAcknowledgeIntent(
        observed: IntentObservation?,
        currentGeneration: String?,
        checkpoint: DurableCheckpoint
    ) -> Bool {
        guard checkpoint != .none,
              let observed,
              currentGeneration == observed.generation else { return false }
        return true
    }

    /// 把“耐久写”与“确认意图”的先后关系做成可执行协调器。写失败时绝不调用确认闭包。
    static func persistThenAcknowledge(
        checkpoint: DurableCheckpoint,
        persist: () -> Bool,
        acknowledge: (DurableCheckpoint) -> Void
    ) -> Bool {
        guard checkpoint != .none, persist() else { return false }
        acknowledge(checkpoint)
        return true
    }
}

/// 后台意图的生产存储器。使用者必须传 URL scope；确认时严格使用 observation 自带的 scope，
/// 因而切换目标 URL 后不可能误删另一目标的意图。
///
/// `nonisolated`：A8 之后 `record(scope:)` 有两个调用上下文 —— MainActor 上的派发路径，以及
/// **HealthKit 私有队列**上的观察者回调（经 `HealthSyncObserverIntentChannel`）。默认隔离
/// （`-default-isolation MainActor`）会把它算成 MainActor 类型，于是回调那条路只能在
/// "把 `completion()` 推后"与"跨隔离读状态"之间二选一 —— 两者都不可接受。类型本身没有可变
/// 状态（`UserDefaults` 是线程安全的，各调用点写的是**不同 key**）。
nonisolated struct HealthSyncBackgroundIntentStore {
    private let userDefaults: UserDefaults
    private let baseKey: String

    init(userDefaults: UserDefaults = .standard, baseKey: String) {
        self.userDefaults = userDefaults
        self.baseKey = baseKey
    }

    func storageKey(scope: String) -> String { "\(baseKey).\(scope)" }

    /// 写入一条后台意图，并**回读校验**它确实在当前默认域里读得回来。
    ///
    /// 🔴 为什么要回读（A8，2026-10-19）：`UserDefaults.set` 不抛错、也没有返回值，观察者
    /// 回调里"这次写到底成没成"否则无从判断 —— 而 A8 要的正是"写失败必须被分类记录，
    /// 不许静默吞掉"。一次 `set` + 一次 `get` 仍然是 O(1)，不遍历、不编码、不 `synchronize()`。
    ///
    /// ⚠️ 能证明的边界：回读只证明"本进程的默认域里这份代次可见"—— 而观察者之后、导出
    /// 确认时读的正是同一份默认域。跨进程耐久性由 cfprefsd 承担（与既有意图写同一档）；
    /// 要更强只能 `synchronize()` 整域同步落盘，那与"回调里有上限的同步写"冲突
    /// （见 `HealthSyncObserverIntentHandoff`）。
    @discardableResult
    func record(scope: String, generation: String = UUID().uuidString) -> Bool {
        let key = storageKey(scope: scope)
        userDefaults.set(generation, forKey: key)
        return HealthSyncBackgroundRecovery.intentGeneration(from: userDefaults.object(forKey: key))
            == generation
    }

    func observe(scope: String) -> HealthSyncBackgroundRecovery.IntentObservation? {
        guard let generation = HealthSyncBackgroundRecovery.intentGeneration(
            from: userDefaults.object(forKey: storageKey(scope: scope))
        ) else { return nil }
        return .init(scope: scope, generation: generation)
    }

    func hasIntent(scope: String) -> Bool { observe(scope: scope) != nil }

    @discardableResult
    func acknowledge(
        _ observed: HealthSyncBackgroundRecovery.IntentObservation?,
        checkpoint: HealthSyncBackgroundRecovery.DurableCheckpoint
    ) -> Bool {
        guard let observed else { return false }
        let key = storageKey(scope: observed.scope)
        let current = HealthSyncBackgroundRecovery.intentGeneration(from: userDefaults.object(forKey: key))
        guard HealthSyncBackgroundRecovery.shouldAcknowledgeIntent(
            observed: observed,
            currentGeneration: current,
            checkpoint: checkpoint
        ) else { return false }
        userDefaults.removeObject(forKey: key)
        return true
    }
}

/// 🔴 A8（2026-10-19 复核）：`HKObserverQuery` 回调里"**先落耐久意图、再 `completion()`**"的判据。
///
/// 缺陷形态（审计 A8）：回调原先先 `completion()`、再 `Task { await onObserverChange?() }`。
/// 若进程在这两步之间被系统结束，HealthKit 已经收到"这次投递处理完了"的回执，而本地没有留下
/// 这次变化的任何耐久痕迹 —— 这次唤醒等于没有发生过（观察者投递不会被重放），那批健康数据
/// 要等**下一次**投递才有人管。`SyncDeliveryPolicy` 那条"未绑定是唯一不记意图的分支"管的是
/// 它**之后**的异步派发路径，管不到这个窗口：那一步自己就要先跨一次 `Task` 与 MainActor。
///
/// 两条硬约束（执行者是 `BackgroundSyncPolicyRegression`）：
///
///   1. **顺序**：耐久写一定在 `completion()` 之前；`completion()` **恰好一次**，且**每条分支**
///      （写失败 / 还没有目标 / scope 非法）都必须调用它 —— HealthKit 连续 3 次收不到会**永久**
///      停掉这个类型的投递，而且毫无报错。
///   2. **有界**：一次投递最多一次 `UserDefaults.set` + 一次回读；不遍历、不编码大对象、
///      不 `synchronize()`、失败**不重试**。加锁、哈希、磁盘遍历都不在这条路上。
///
/// ⚠️ Apple 的合同是"处理完这次新数据后调用 completion"，并没有要求 completion 是第一句。
/// 真正不能做的是让 completion 等导出（秒到分钟级）—— 这里等的是微秒级的默认域写入。
nonisolated enum HealthSyncObserverIntentHandoff {
    /// 本次投递的意图落点。**每个分支都要留痕**：成功靠默认域里的代次（导出时读得到），
    /// 失败靠 `HealthSyncObserverIntentChannel` 的分类计数 + `[RAI]` 日志 —— 观察者回调没有
    /// 返回值，静默吞掉就等于"这次唤醒无痕消失"，而那正是本节要消灭的形态。
    enum Outcome: Equatable, Sendable {
        /// 已按 `scope` 落了一条耐久意图（代次由 store 生成/校验）。
        case recorded(scope: String)
        /// 进程里还没有任何"当前导出目标"（例如从未同步过的全新安装）。
        /// 没有目标 ⇒ 意图没有消费者可查，与 `SyncDeliveryPolicy` 的 `.ignore` 同一条理由。
        case noTarget
        /// 耐久痕迹没有落地。分类见 `Failure`。
        case failed(Failure)

        /// 写失败的两类成因。每一类都意味着"这次唤醒的持久痕迹没了"，处置却不同：
        /// `writeNotVerified` 要盯默认域（受保护数据锁定 / 容量），`scopeUnusable` 是代码
        /// 把坏值投进了投影 —— 静默写下去只会得到一条没人读的死 key。
        enum Failure: String, CaseIterable, Equatable, Sendable {
            /// 写完读不回来：默认域拒绝这次写入。
            case writeNotVerified
            /// 目标 scope 不是一个可用的 key（空 / 超长 / 含控制字符或空白）。
            case scopeUnusable
        }
    }

    /// scope 能不能当一个 key 后缀。**刻意不钉死 24 位**：长度与算法是
    /// `HealthKitSync.urlScope(for:)`（sha256 前 24 位十六进制）的职责，在这里再写一个 24
    /// 就有两份语义、迟早分叉。这里只钉"能安全拼进 UserDefaults key"这件事；
    /// 上限 64 只为不让一个坏值变成一条超长 key（列出的合法值里没有超过 24 的）。
    ///
    /// 🔴 为什么非法 scope 要单独分类、而不是"写进去算了"：空 / 含空白 / 超长的 scope 写进去
    /// 就是一条**没有任何消费者**的死 key —— 现象与"这次唤醒被丢了"完全一样，还多一条永远
    /// 清不掉的残留。宁可在这里记一笔 `scopeUnusable`。
    static func isUsableScope(_ scope: String) -> Bool {
        guard !scope.isEmpty, scope.utf8.count <= maxScopeBytes else { return false }
        // 只接受可见 ASCII：合法的 scope 是十六进制摘要，不含空白也不需要任何转义。
        return scope.utf8.allSatisfy { $0 > 0x20 && $0 < 0x7F }
    }

    /// `isUsableScope` 的长度上界（字节）。远大于生产值（24），只为挡住坏值。
    static let maxScopeBytes = 64

    /// 判据①②的生产实现：**先 record、再 completion()**。
    ///
    /// `record` 是注入 seam：生产是 `HealthSyncBackgroundIntentStore.record(scope:)`
    /// （一次 `set` + 一次回读），回归里是"记一笔并返回 false/true"，于是"顺序"与"写失败仍要
    /// 回执"这两条判据可以在**不碰真实 HealthKit、也不污染真实默认域**的条件下被执行。
    ///
    /// 🔴 本函数里 `complete()` 只有一个调用点，且在所有分支之后 —— 这就是"任何失败都不许
    /// 吞掉回执"的形态。改回"先 complete 再 record"会让 A8 的窗口原样长回来，而顺序判据
    /// （回归里在 `complete` 内部读意图）会立刻转红。
    @discardableResult
    static func recordThenComplete(
        scope: String?,
        record: (String) -> Bool,
        complete: () -> Void
    ) -> Outcome {
        let outcome = recordOutcome(scope: scope, record: record)
        complete()
        return outcome
    }

    /// 只做"记"、不碰 completion。拆出来是为了让上面的顺序一眼可见：
    /// 唯一的 `complete()` 在它返回**之后**，中间没有任何分支能绕开它。
    static func recordOutcome(scope: String?, record: (String) -> Bool) -> Outcome {
        guard let scope else { return .noTarget }
        guard isUsableScope(scope) else { return .failed(.scopeUnusable) }
        return record(scope) ? .recorded(scope: scope) : .failed(.writeNotVerified)
    }

    /// 失败/空目标的日志行（**唯一出处**，分类与计数都从这一处出）。
    ///
    /// 带**累计次数**：写失败若持续发生（默认域长期不可用），一行行一模一样的日志会淹没在
    /// 噪声里，而递增的 n 让人一眼看出"这不是偶发"。成功**不留**日志：耐久痕迹本身就是回执。
    static func reportLine(for outcome: Outcome, failures: Int) -> String? {
        switch outcome {
        case .recorded:
            return nil
        case .noTarget:
            return "an observer delivery arrived before any export target was published; "
                + "its intent has no scope to land on, so the completion window stays open"
        case .failed(let failure):
            return "observer intent was not persisted (\(failure.rawValue), n=\(failures)): "
                + "completion was still reported to HealthKit"
        }
    }
}

/// `HealthSyncObserverIntentHandoff` 的**生产接线**：目标投影 + 分类计数 + `[RAI]` 日志。
///
/// 为什么要有"目标投影"这一层：观察者回调跑在 HealthKit 的私有队列上，而"当前服务端 ⇒
/// urlScope"是 `HealthKitSync` 的 MainActor 状态（`activeServerURL` / `activeScope`）。
/// 回调里既不能 `await`（`completion()` 必须同步跟上），也不该跨隔离去读那份状态。
/// 投影里存的是**同一个 urlScope 字符串**（唯一生产者是 `HealthKitSync.urlScope(for:)`），
/// 所以"观察者写的 key"与"导出/确认读的 key"同源同形 —— 不可能出现两份哈希算法各算一遍。
///
/// 线程安全：`publish` 在 MainActor 上调，`currentScope` / 记账在 HealthKit 队列上调，
/// 全部走同一把 `NSLock`（O(1)，与 `RaiBackgroundUploadSession` 同一手法）。
/// 因此这里标 `@unchecked Sendable`：那把锁就是这份承诺本身。
nonisolated final class HealthSyncObserverIntentChannel: @unchecked Sendable {
    private let lock = NSLock()
    private var scope: String?
    private var counts: [HealthSyncObserverIntentHandoff.Outcome.Failure: Int] = [:]
    private var noTargetCount = 0
    private var reportedNoTarget = false
    private let record: (String) -> Bool
    private let report: (String) -> Void

    /// 生产与回归共用这一个构造：`record` 是唯一的写入缝。
    init(record: @escaping (String) -> Bool, report: @escaping (String) -> Void = { _ in }) {
        self.record = record
        self.report = report
    }

    /// 生产构造：写的是后台意图存储（一次 `set` + 一次回读）。
    convenience init(
        baseKey: String,
        userDefaults: UserDefaults = .standard,
        report: @escaping (String) -> Void = { _ in }
    ) {
        let store = HealthSyncBackgroundIntentStore(userDefaults: userDefaults, baseKey: baseKey)
        self.init(record: { store.record(scope: $0) }, report: report)
    }

    /// 🔴 目标投影的**唯一写点**：与 `activeServerURL` / `activeScope` 在同一处更新
    /// （`HealthKitSync.performSync` / `restoreBackgroundContext` / `recordBackgroundIntent`）。
    func publish(scope newValue: String?) {
        lock.lock()
        scope = newValue
        lock.unlock()
    }

    /// 回调在 `completion()` 之前同步读到的那一个 scope。`nil` = 本进程还没有目标。
    var currentScope: String? {
        lock.lock()
        defer { lock.unlock() }
        return scope
    }

    /// 分类失败计数（诊断与回归用）。键是分类，值是本进程累计次数。
    var failures: [HealthSyncObserverIntentHandoff.Outcome.Failure: Int] {
        lock.lock()
        defer { lock.unlock() }
        return counts
    }

    /// "还没有目标"的投递次数（本进程累计）。它是一项**已知窗口**的度量，不是错误。
    var noTargets: Int {
        lock.lock()
        defer { lock.unlock() }
        return noTargetCount
    }

    /// 一次投递的交接：**先 record、再 completion()**（判据在 `HealthSyncObserverIntentHandoff`）。
    ///
    /// 记账/日志刻意放在 `completion()` **之后**：诊断绝不挡在回执前面。写失败时唯一的痕迹
    /// 就是这里的一条 `[RAI]` 日志 + 分类计数。
    @discardableResult
    func recordThenComplete(complete: () -> Void) -> HealthSyncObserverIntentHandoff.Outcome {
        let outcome = HealthSyncObserverIntentHandoff.recordThenComplete(
            scope: currentScope,
            record: record,
            complete: complete
        )
        note(outcome)
        return outcome
    }

    private func note(_ outcome: HealthSyncObserverIntentHandoff.Outcome) {
        var failureCount = 0
        var shouldReport = true
        lock.lock()
        switch outcome {
        case .recorded:
            shouldReport = false
        case .noTarget:
            noTargetCount += 1
            // 每个进程只报一次：全新安装的每次投递都会落在这里，逐条报会把日志刷满；
            // 但"一次都不报"等于把一个已知窗口藏起来 —— 而这一条正是 A8 的剩余风险。
            shouldReport = !reportedNoTarget
            reportedNoTarget = true
        case .failed(let failure):
            counts[failure, default: 0] += 1
            failureCount = counts[failure] ?? 0
        }
        lock.unlock()
        // 日志在锁外发：拼字符串 + 写诊断通道不是 O(1)，而 MainActor 那边的 `publish`
        // 要的是同一把锁 —— 不能拿回执的时效去换一行日志。
        guard shouldReport,
              let line = HealthSyncObserverIntentHandoff.reportLine(
                  for: outcome, failures: failureCount
              )
        else { return }
        report(line)
    }
}

/// Scope recovery carries the *new* sync scope as well as its generation.
/// Unlike a HealthKit notification, an old scope's export cannot claim it.
struct HealthSyncScopeRecoveryStore {
    struct Request: Codable, Equatable {
        let targetScope: String
        let generation: String
    }

    struct Observation: Equatable {
        let urlScope: String
        let request: Request
    }

    private let userDefaults: UserDefaults
    private let baseKey: String

    init(userDefaults: UserDefaults = .standard, baseKey: String) {
        self.userDefaults = userDefaults
        self.baseKey = baseKey
    }

    func storageKey(urlScope: String) -> String { "\(baseKey).\(urlScope)" }

    func record(urlScope: String, targetScope: String) {
        let request = Request(targetScope: targetScope, generation: UUID().uuidString)
        userDefaults.set(try! JSONEncoder().encode(request), forKey: storageKey(urlScope: urlScope))
    }

    func hasRequest(urlScope: String) -> Bool {
        userDefaults.object(forKey: storageKey(urlScope: urlScope)) != nil
    }

    func observe(urlScope: String, targetScope: String) -> Observation? {
        let key = storageKey(urlScope: urlScope)
        if let data = userDefaults.data(forKey: key),
           let request = try? JSONDecoder().decode(Request.self, from: data),
           request.targetScope == targetScope {
            return Observation(urlScope: urlScope, request: request)
        }
        // A pre-upgrade request stored only a generation. Bind it to the
        // authoritative scope at the export start; keep the old key readable.
        if let generation = HealthSyncBackgroundRecovery.intentGeneration(from: userDefaults.object(forKey: key)) {
            return Observation(urlScope: urlScope, request: .init(targetScope: targetScope, generation: generation))
        }
        return nil
    }

    @discardableResult
    func acknowledge(_ observed: Observation?, targetScope: String,
                     checkpoint: HealthSyncBackgroundRecovery.DurableCheckpoint) -> Bool {
        guard checkpoint != .none, let observed, observed.request.targetScope == targetScope else { return false }
        let key = storageKey(urlScope: observed.urlScope)
        let current: String?
        if let data = userDefaults.data(forKey: key),
           let request = try? JSONDecoder().decode(Request.self, from: data) {
            current = request.targetScope == targetScope ? request.generation : nil
        } else {
            current = HealthSyncBackgroundRecovery.intentGeneration(from: userDefaults.object(forKey: key))
        }
        guard current == observed.request.generation else { return false }
        userDefaults.removeObject(forKey: key)
        return true
    }
}
