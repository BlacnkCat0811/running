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
        var hasUncoveredGeneration: Bool { hasIntent || hasRecoveryRequest }

        /// 收工后还要不要再排一次后台执行。`BGTaskScheduler` 的请求是一次性的。
        var needsAnotherRound: Bool { hasUnfinishedWork || hasIntent || hasRecoveryRequest }

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
struct HealthSyncBackgroundIntentStore {
    private let userDefaults: UserDefaults
    private let baseKey: String

    init(userDefaults: UserDefaults = .standard, baseKey: String) {
        self.userDefaults = userDefaults
        self.baseKey = baseKey
    }

    func storageKey(scope: String) -> String { "\(baseKey).\(scope)" }

    func record(scope: String, generation: String = UUID().uuidString) {
        userDefaults.set(generation, forKey: storageKey(scope: scope))
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
