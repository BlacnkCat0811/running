import Foundation
import Observation

@Observable
@MainActor
final class TrainingPlanStore {
    private(set) var goals: MobileGoalsResponse?
    private(set) var today: MobileTodayResponse?
    private(set) var workoutPlan: MobileWorkoutPlanResponse?
    private(set) var coach: MobileRunCoachResponse?
    private(set) var coachLoop: CoachLoopResponse?
    private(set) var metadata: TrainingPlanStateResponse.Metadata?
    /// v2 统一训练状态（训练页唯一的计划状态）。与 `goals`/`today`/`workoutPlan`
    /// 是两条独立的读：这条回答"现在是什么模式、可否执行、七日意图是什么"，
    /// 那条回答"今天的可执行处方是什么"。**任何执行授权都不从这里产生**。
    private(set) var unified: TrainingPlanStateResponseV2?
    private(set) var unifiedIssue: PlanReadIssue?
    /// 本次运行里这份统一状态是否被服务端确认过。false = 只是上次接受的参考。
    private(set) var unifiedIsCurrent = false
    private(set) var isRefreshingUnified = false
    private(set) var unifiedCachedAt: Date?
    private(set) var availability: PlanAvailability = .unavailable
    private(set) var issue: PlanReadIssue?
    private(set) var minimumRevision = 0
    private(set) var acknowledgement: PlanWriteAcknowledgement?
    private(set) var persistenceFailed = false
    private(set) var isRefreshing = false
    private(set) var isCurrent = false
    private(set) var cachedAt: Date?
    private(set) var serviceReachable = false
    private var requestID = UUID()
    private var epoch = UUID()
    private var unifiedRequestID = UUID()
    private let repository: TrainingPlanRepository
    private let now: () -> Date
    private(set) var scope: String
    private static let unifiedCacheKey = "training-plan-state-v2"
    var legacyRetryCount = 2
    /// 2026-10-18（事故复盘 P0-3）：旧服务（无快照契约）的瞬态重试计划。
    ///
    /// 旧实现是**零退避**立即重试：`.timeout`/`.offline` 一到期就重发，服务端被慢
    /// 查询占住时把 1 条昂贵读放大成 3 条（事故里 coach-loop 实测 13.4s/条）。
    /// 现在与新快照契约同一口径 —— 优先服务端 `Retry-After`，无提示时按本计划退避，
    /// 且只有**服务端已经答复**的瞬态码才重试。测试可注入 `[]` 关闭重试。
    var legacyRetryDelays: [TimeInterval] = [0.15, 0.3]
    /// 2026-10-18（审查 P2-6）：新快照契约下 `503 plan_snapshot_changed` 是
    /// "读期间事实变化，请重读"的瞬态信号。旧实现只对旧服务重试，新契约直接
    /// unavailable。这里做有界退避重试（默认 2 次、150/300ms），测试可注入空数组
    /// 或毫秒级延迟；重试仍走同一个 requestID/epoch/scope/isValid，取消即放弃，
    /// 且只重试**读**，从不重放写请求。
    var snapshotRetryDelays: [TimeInterval] = [0.15, 0.3]
    /// 2026-10-18（审查 P2-6 收尾）：测试可替换的等待实现；生产用 `Task.sleep`。
    /// 返回 false 表示被取消/放弃。服务端 `Retry-After` 常是 1 秒，注入 sleeper 后
    /// 测试可直接断言"按 1 秒重试"，不必真睡 1 秒。
    var sleepBeforeSnapshotRetry: (TimeInterval) async -> Bool = { seconds in
        guard seconds > 0 else { return true }
        do {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            return true
        } catch {
            return false
        }
    }

    init(cache: CacheStore, api: RaiAPIClient, scope: String, now: @escaping () -> Date) {
        self.repository = TrainingPlanRepository(api: api, cache: cache)
        self.scope = scope
        self.now = now
        restoreSafety()
    }

    var revision: Int { max(minimumRevision, max(goals?.revision ?? 0, coach?.revision ?? 0)) }
    var quarantineKey: String { "rai.plan-write-unpersisted." + scope }
    var knownCoachState: Bool {
        [goals?.revision == revision ? goals?.runCoach : nil, coach?.revision == revision ? coach?.plan : nil]
            .compactMap { $0 }.allSatisfy { ["active", "paused", "ended"].contains($0.status) }
    }

    var executablePlan: MobileWorkoutPlanResponse? {
        guard isCurrent, !persistenceFailed, knownCoachState,
              workoutPlan?.planRevision == revision else { return nil }
        if let loop = coachLoop, loop.settings != nil {
            guard !loop.refreshRequired,
                  UserDataNoticePolicy.isCurrentDay(loop.today.day.localDate, timezone: loop.timezone, now: now()) else { return nil }
        }
        return workoutPlan
    }

    func presentation(offline: Bool) -> PlanPresentationSnapshot {
        if let loop = coachLoop, loop.settings != nil {
            return .init(revision: revision, goals: goals?.revision == revision ? goals : nil,
                coach: nil, coachPlan: nil, today: nil, executablePlan: executablePlan,
                availability: isRefreshing ? .refreshing : isCurrent && !loop.refreshRequired ? availability :
                    offline ? .cached(asOf: cachedAt) : .savedAwaitingRefresh,
                lastKnownTodayDate: loop.today.day.localDate, issue: issue)
        }
        let currentCoach = coach?.revision == revision ? coach : nil
        let plan = currentCoach?.plan ?? (goals?.revision == revision ? goals?.runCoach : nil)
        let reference = today.flatMap { value in
            value.recommendation.planRevision == revision && !persistenceFailed && knownCoachState &&
                UserDataNoticePolicy.isCurrentDay(value.today.localDate, timezone: value.timezone, now: now()) && (isCurrent || offline) ? value : nil
        }
        let state: PlanAvailability
        if isRefreshing { state = .refreshing }
        else if !knownCoachState { state = .unavailable }
        else if persistenceFailed || (acknowledgement != nil && !isCurrent) { state = .savedAwaitingRefresh }
        else if offline, reference != nil { state = .cached(asOf: cachedAt) }
        else if reference != nil, executablePlan != nil { state = availability }
        else { state = availability == .revisionMismatch ? .revisionMismatch : .unavailable }
        return .init(revision: revision, goals: goals?.revision == revision && knownCoachState ? goals : nil,
            coach: currentCoach, coachPlan: plan.flatMap { ["active", "paused", "ended"].contains($0.status) ? $0 : nil },
            today: reference, executablePlan: isCurrent && reference != nil ? executablePlan : nil,
            availability: state, lastKnownTodayDate: today?.today.localDate, issue: issue)
    }

    func configure(scope: String, clear: Bool = false) {
        invalidate()
        if self.scope != scope || clear {
            goals = nil; today = nil; workoutPlan = nil; coach = nil; coachLoop = nil; metadata = nil
            unified = nil; unifiedIssue = nil; unifiedIsCurrent = false; unifiedCachedAt = nil
            acknowledgement = nil; minimumRevision = 0; cachedAt = nil
            availability = .unavailable; issue = nil
        }
        self.scope = scope
        restoreSafety()
    }

    func invalidate() {
        epoch = UUID(); requestID = UUID(); unifiedRequestID = UUID()
        isRefreshing = false; isCurrent = false
        isRefreshingUnified = false; unifiedIsCurrent = false
        metadata = nil
        availability = acknowledgement == nil ? .unavailable : .savedAwaitingRefresh
    }

    func restoreSafety() {
        let result = repository.acknowledgement(scope: scope)
        acknowledgement = result.value
        let floor = repository.revisionFloor(scope: scope)
        minimumRevision = max(minimumRevision, floor ?? 0)
        let quarantine = UserDefaults.standard.object(forKey: quarantineKey) as? Int
        minimumRevision = max(minimumRevision, quarantine ?? 0)
        persistenceFailed = result.isFailure || floor == nil || quarantine != nil
        if persistenceFailed {
            issue = .init(code: result.failureCode ?? .storageUnavailable, message: "计划安全记录无法读取；不能把损坏或不可用存储当作空账目。")
        }
    }

    func acceptGoals(_ value: MobileGoalsResponse) {
        guard value.revision >= revision else { return }
        if value.revision != goals?.revision { invalidate() }
        minimumRevision = value.revision; goals = value
        if coach?.revision != value.revision { coach = nil }
        _ = repository.persist(value, scope: scope, key: "goals")
    }

    func acceptCoach(_ value: MobileRunCoachResponse) {
        // 2026-10-18（审查 P2-9）：教练闭环生效时旧 run-coach 响应不得写回。
        // 否则"coachLoop=1 且无 snapshot"的错峰组合会在同一次前台刷新里出现两套
        // 教练状态（`refreshRunCoach` 旧路径与教练闭环路径），破坏状态所有权单源。
        guard coachLoop == nil else { return }
        guard value.revision >= revision else { return }
        if value.revision != revision { invalidate() }
        minimumRevision = max(minimumRevision, value.revision); coach = value
        _ = repository.persist(value, scope: scope, key: "run-coach")
    }

    func acknowledge(revision: Int, action: String, goals: MobileGoalsResponse? = nil, coach: MobileRunCoachResponse? = nil) {
        invalidate()
        minimumRevision = max(minimumRevision, revision)
        let ack = PlanWriteAcknowledgement(revision: revision, action: action, acknowledgedAt: now(), planId: coach?.plan?.id ?? goals?.runCoach?.id)
        acknowledgement = ack
        if repository.acknowledge(ack, scope: scope, goals: goals, coach: coach) {
            minimumRevision = max(minimumRevision, repository.revisionFloor(scope: scope) ?? revision)
            persistenceFailed = false
            UserDefaults.standard.removeObject(forKey: quarantineKey)
        } else {
            persistenceFailed = true
            UserDefaults.standard.set(revision, forKey: quarantineKey)
            issue = .init(code: .storageUnavailable, message: "服务端已保存，本地确认记录未持久化；请刷新，不要重复发布。")
        }
        if let goals { acceptGoals(goals) }
        if let coach { acceptCoach(coach) }
        availability = .savedAwaitingRefresh
    }

    func loadCache() {
        restoreSafety()
        guard !isCurrent else { return }
        loadCachedUnifiedPlan()
        if let cached = repository.cached(CoachLoopResponse.self, scope: scope, key: "coach-loop").value,
           cached.value.settings != nil, cached.value.revision >= revision {
            coachLoop = cached.value; goals = cached.value.goals; minimumRevision = cached.value.revision
            today = nil; workoutPlan = nil; coach = nil; cachedAt = cached.cachedAt
            availability = .cached(asOf: cachedAt)
            return
        }
        let aggregateResult = repository.cached(TrainingPlanStateResponse.self, scope: scope, key: "training-plan-state")
        let aggregate = aggregateResult.value
        if aggregateResult.isFailure {
            issue = .init(code: aggregateResult.failureCode ?? .corruptPayload, message: "上次展示快照无法读取，需要联网重建；安全记录仍保留。")
            diagnostic("cache_decode_failed", code: "cache_envelope_invalid")
        }
        // 2026-10-18（审查 P3-15）：旧服务/单条缓存路径此前只取聚合的 cachedAt，
        // 聚合缺失时缓存时间直接丢失，离线文案只能说"上次缓存"。
        // 这里把实际用到的每条缓存的时间合并成"最近一次缓存时间"。
        var latestCacheAt = aggregate?.cachedAt
        func mergeCacheAt(_ value: Date?) {
            guard let value else { return }
            if latestCacheAt == nil || value > latestCacheAt! { latestCacheAt = value }
        }
        let cachedGoalsValue = aggregate == nil
            ? repository.cached(MobileGoalsResponse.self, scope: scope, key: "goals").value
            : nil
        let cachedCoachValue = aggregate == nil
            ? repository.cached(MobileRunCoachResponse.self, scope: scope, key: "run-coach").value
            : nil
        let cachedTodayValue = aggregate == nil
            ? repository.cached(MobileTodayResponse.self, scope: scope, key: "today").value
            : nil
        let cachedPlanValue = aggregate == nil
            ? repository.cached(MobileWorkoutPlanResponse.self, scope: scope, key: "workout-plan").value
            : nil
        let cachedGoals = aggregate?.value.goals ?? cachedGoalsValue?.value
        let cachedCoach = aggregate?.value.coachSummary ?? cachedCoachValue?.value
        if let value = cachedGoals, value.revision >= revision { minimumRevision = value.revision; goals = value }
        if let value = cachedCoach, value.revision >= revision { minimumRevision = value.revision; coach = value }
        let cachedToday = aggregate?.value.today ?? cachedTodayValue?.value
        if cachedToday?.recommendation.planRevision == revision { today = cachedToday }
        let cachedPlan = aggregate?.value.workoutPlan ?? cachedPlanValue?.value
        if cachedPlan?.planRevision == revision { workoutPlan = cachedPlan }
        mergeCacheAt(cachedGoalsValue?.cachedAt)
        mergeCacheAt(cachedCoachValue?.cachedAt)
        mergeCacheAt(cachedTodayValue?.cachedAt)
        mergeCacheAt(cachedPlanValue?.cachedAt)
        cachedAt = latestCacheAt
        availability = persistenceFailed ? .savedAwaitingRefresh : .cached(asOf: cachedAt)
        isCurrent = false
    }

    /// 上次接受的 v2 统一状态：**只作参考**，从不置为当前。
    ///
    /// 与 v1 快照的缓存路径同一条纪律：离线时能看上次的模式与七日意图，但
    /// `unifiedIsCurrent` 保持 false，页面必须显示"上次参考，需联网确认"。
    private func loadCachedUnifiedPlan() {
        guard unified == nil else { return }
        let result = repository.cached(TrainingPlanStateResponseV2.self, scope: scope, key: Self.unifiedCacheKey)
        if result.isFailure {
            unifiedIssue = .init(code: result.failureCode ?? .corruptPayload,
                message: "上次统一训练状态无法读取；联网后必须重新确认。")
        }
        guard let cached = result.value else { return }
        unified = cached.value
        unifiedIsCurrent = false
        unifiedCachedAt = cached.cachedAt
    }

    /// v2 统一训练状态的唯一读入口。
    ///
    /// 为什么与 `refresh` 分开：`refresh` 的成功标准是"可执行处方可确认"（今日建议、
    /// 执行窗口、写确认水位），这条的成功标准是"模式/准入/七日意图可确认"。把两者
    /// 合成一次读，任何一侧失败都会让另一侧冒充成功 —— 而"合同升级"与"今天没训练"
    /// 恰好是最不能互相冒充的两件事。
    ///
    /// 身份/业务日/窗口/版本下限全部在 `TrainingPlanUnifiedPolicy.validate` 里校验；
    /// 失败时保留上一份快照作为**参考**，但绝不把 `unifiedIsCurrent` 留在 true。
    func refreshUnifiedPlan(baseURL: URL, token: String, handshake: RaiHandshake?, isValid: () -> Bool) async -> Bool {
        let request = UUID()
        unifiedRequestID = request
        let mutation = epoch
        let scope = self.scope
        func valid() -> Bool {
            unifiedRequestID == request && epoch == mutation && self.scope == scope && isValid() && !Task.isCancelled
        }
        isRefreshingUnified = true
        defer { if unifiedRequestID == request { isRefreshingUnified = false } }
        do {
            let value = try await repository.readUnifiedPlan(baseURL: baseURL, token: token)
            guard valid() else { return false }
            serviceReachable = true
            // 版本下限取**写确认**过的下限（`minimumRevision`），不是 `revision`：
            // `revision` 会被另一条读的临时值抬高，用它当门槛会让两条读互相把对方
            // 判成"陈旧"。这里也不把统一状态的 currentGoalsRevision 抬进下限 ——
            // 下限是写确认的水位，读投影没有资格改动它。
            try TrainingPlanUnifiedPolicy.validate(
                value,
                identity: handshake.map { .init(serverId: $0.serverId, athleteId: $0.athleteId, datasetEpoch: $0.datasetEpoch) },
                minimumGoalsRevision: minimumRevision,
                now: now()
            )
            unified = value
            unifiedIsCurrent = true
            unifiedIssue = nil
            unifiedCachedAt = repository.persist(value, scope: scope, key: Self.unifiedCacheKey)
            diagnostic("unified_snapshot_accepted")
            return true
        } catch {
            guard valid() else { return false }
            unifiedIsCurrent = false
            let issue = PlanReadIssue.unified(error)
            unifiedIssue = issue
            // 服务端答复过（含 403/409/5xx）说明服务可达；一次合同拒绝不该被报成离线。
            if issue.code != .offline, issue.code != .timeout { serviceReachable = true }
            diagnostic("unified_snapshot_rejected", code: issue.code.rawValue)
            return false
        }
    }

    func refresh(baseURL: URL, token: String, handshake: RaiHandshake?, isValid: () -> Bool) async -> Bool {
        let request = UUID(); requestID = request
        let mutation = epoch; let scope = scope
        func valid() -> Bool { requestID == request && epoch == mutation && self.scope == scope && isValid() && !Task.isCancelled }
        isRefreshing = true; isCurrent = false; availability = .refreshing
        serviceReachable = false
        defer {
            if requestID == request {
                isRefreshing = false
                if availability == .refreshing { availability = acknowledgement == nil ? .unavailable : .savedAwaitingRefresh }
            }
        }
        let aggregateContract = handshake?.planSnapshotContractVersion != nil
        let legacyRetries = aggregateContract ? 0 : max(0, min(2, legacyRetryCount))
        // 新契约的 503 表示"读期间事实变化，可安全重读"；退避重试次数由
        // `snapshotRetryDelays` 决定，旧契约沿用 `legacyRetryCount`。
        // `coach_snapshot_changed` 是教练闭环读取的同族信号（批次 A 服务端加入）。
        let retryableSnapshotCodes: Set<String> = ["plan_snapshot_changed", "coach_snapshot_changed"]
        let maxAttempts = 1 + (aggregateContract ? snapshotRetryDelays.count : legacyRetries)
        var snapshotRetriesUsed = 0
        for attempt in 0..<maxAttempts {
            do {
                if let version = handshake?.coachLoopContractVersion {
                    guard version == 1 else { throw RaiAPIClientError.decoding("不支持的教练闭环契约，不能回退旧执行协议") }
                    let loop = try await repository.api.coachLoop(baseURL: baseURL, token: token)
                    guard valid() else { return false }
                    serviceReachable = true
                    try validateCoachLoop(loop, handshake: handshake)
                    coachLoop = loop
                    if loop.settings != nil {
                        if persistenceFailed {
                            let ack = acknowledgement ?? .init(revision: loop.revision, action: "online-verification", acknowledgedAt: now(), planId: nil)
                            guard repository.acknowledge(ack, scope: scope, goals: loop.goals, coach: nil) else {
                                availability = .savedAwaitingRefresh; return false
                            }
                            persistenceFailed = false
                            UserDefaults.standard.removeObject(forKey: quarantineKey)
                        }
                        minimumRevision = max(minimumRevision, loop.revision); goals = loop.goals
                        today = nil; coach = nil; workoutPlan = loop.devicePlan; metadata = nil
                        cachedAt = repository.persist(loop, scope: scope, key: "coach-loop")
                        isCurrent = true; issue = nil
                        availability = loop.refreshRequired ? .savedAwaitingRefresh : loop.today.executable ? .current : .empty
                        return true
                    }
                } else if coachLoop?.settings != nil {
                    throw RaiAPIClientError.decoding("服务不再支持已启用的教练合同，禁止旧协议执行；旧排期需显式撤回")
                }
                let value = try await repository.read(baseURL: baseURL, token: token, handshake: handshake)
                guard valid() else { return false }
                serviceReachable = true
                if value.aggregate == nil, value.goals.revision >= revision {
                    goals = value.goals; minimumRevision = value.goals.revision
                    _ = repository.persist(value.goals, scope: scope, key: "goals")
                }
                try validate(value, handshake: handshake)
                if persistenceFailed {
                    let ack = acknowledgement ?? .init(revision: value.goals.revision, action: "online-verification", acknowledgedAt: now(), planId: nil)
                    guard repository.acknowledge(ack, scope: scope, goals: value.goals, coach: value.coach) else {
                        availability = .savedAwaitingRefresh
                        return false
                    }
                    persistenceFailed = false
                    UserDefaults.standard.removeObject(forKey: quarantineKey)
                }
                goals = value.goals; today = value.today; workoutPlan = value.workoutPlan
                if let coach = value.coach { self.coach = coach }
                else if coach?.revision != value.goals.revision { coach = nil }
                metadata = value.aggregate?.metadata; minimumRevision = max(minimumRevision, value.goals.revision)
                isCurrent = true; issue = nil
                availability = value.aggregate?.availability == "empty" ? .empty : .current
                diagnostic("snapshot_accepted")
                if let aggregate = value.aggregate { cachedAt = repository.persist(aggregate, scope: scope, key: "training-plan-state") }
                else {
                    _ = repository.persist(value.goals, scope: scope, key: "goals")
                    _ = repository.persist(value.today, scope: scope, key: "today")
                    cachedAt = repository.persist(value.workoutPlan, scope: scope, key: "workout-plan")
                }
                return true
            } catch {
                guard valid() else { return false }
                let partial = error as? TrainingPlanPartialReadError
                // 部分读取的目标/执行数据只作编辑上下文参照，从不单独置 current。
                if let goals = partial?.goals, goals.revision >= revision {
                    minimumRevision = goals.revision; self.goals = goals
                    serviceReachable = true
                    _ = repository.persist(goals, scope: scope, key: "goals")
                }
                if let plan = partial?.plan, plan.planRevision >= revision {
                    workoutPlan = plan
                    _ = repository.persist(plan, scope: scope, key: "workout-plan")
                }
                let cause = partial?.cause ?? error
                var serverCode: String?
                var retryAfterHint: TimeInterval?
                if let apiError = cause as? RaiAPIClientError {
                    // 2026-10-18（审查 P2-6 收尾）：`503 + Retry-After` 现在抛
                    // `.retryableServer`；它与 `.server` 共用 code/status 语义。
                    serverCode = apiError.serverCode
                    if case let .retryableServer(_, _, _, hint) = apiError { retryAfterHint = hint }
                    if apiError.httpStatus != nil {
                        // 能收到服务端错误码说明服务可达；否则一次 503/422 会被误报成离线。
                        serviceReachable = true
                    }
                }
                let reason = PlanReadIssue.network(cause)
                issue = reason
                if let serverCode, retryableSnapshotCodes.contains(serverCode) {
                    diagnostic("snapshot_changed", code: serverCode)
                } else if reason.code == .revisionConflict {
                    diagnostic("revision_mismatch", code: reason.code.rawValue)
                } else if reason.code == .snapshotValidationFailed {
                    // 2026-10-18（审查 P2-8）：安全字段校验失败单独记码，不与 contract mismatch 混淆。
                    diagnostic("snapshot_validation_failed", code: reason.code.rawValue)
                } else {
                    diagnostic("snapshot_rejected", code: reason.code.rawValue)
                }
                // 新契约：只对"事实快照变化"的 503 做有界退避重读；同一 requestID/epoch/scope，
                // 取消或失效即放弃。写请求从不经过此路径，因此不存在重放写的可能。
                // 2026-10-18（审查 P2-6 收尾）：延迟优先采用服务端 `Retry-After`
                // （夹取 0.1...5 秒），没有提示时回退到本地 `snapshotRetryDelays`。
                if aggregateContract, let serverCode, retryableSnapshotCodes.contains(serverCode),
                   let delay = Self.snapshotRetryDelay(serverHint: retryAfterHint,
                       defaults: snapshotRetryDelays, attempt: snapshotRetriesUsed) {
                    snapshotRetriesUsed += 1
                    guard await sleepBeforeSnapshotRetry(delay) else {
                        // 取消不是网络失败：保持"未确认"，不写 issue、不继续重读。
                        return false
                    }
                    guard valid() else { return false }
                    continue
                }
                // 2026-10-18（事故复盘 P0-3）：旧服务只重试**服务端已经答复**的瞬态
                // 错误。`.timeout`/`.offline` 表示一个字节都没拿到：服务端正被慢查询
                // 占住时，零退避立即重试只会把 1 条昂贵读放大成 3 条，延长故障恢复。
                // 等待同样走 `snapshotRetryDelay`（Retry-After 优先、0.1...5s 夹取）
                // 与 `sleepBeforeSnapshotRetry`；取消即放弃，不把取消包装成成功。
                if !aggregateContract, attempt < legacyRetries,
                   Self.legacyRetryableCodes.contains(reason.code),
                   let delay = Self.snapshotRetryDelay(serverHint: retryAfterHint,
                       defaults: legacyRetryDelays, attempt: attempt) {
                    guard await sleepBeforeSnapshotRetry(delay) else { return false }
                    guard valid() else { return false }
                    continue
                }
                availability = acknowledgement != nil ? .savedAwaitingRefresh : reason.code == .revisionConflict ? .revisionMismatch : .unavailable
                return false
            }
        }
        return false
    }

    /// 2026-10-18（事故复盘 P0-3）：旧服务可安全重试的错误码。
    ///
    /// 只有**服务端已经答复**的瞬态失败（HTTP 5xx/409）才在名单里。`.timeout`/
    /// `.offline` 描述的是"没拿到任何答复"，这时重试等于给已经排队的慢请求再加一条
    /// 昂贵重计算 —— 事故里服务端 13.4s/条，客户端 15s/4s 超时先到期，重试只会让
    /// 恢复更慢。`PlanReadIssue.retryable`（含 `.timeout`/`.offline`）仍用于 UI 的
    /// "可重试"提示，这里只在 store 的读循环里收窄重试面。
    static let legacyRetryableCodes: [PlanReadIssue.Code] = [.serverUnavailable, .revisionConflict]

    /// 2026-10-18（审查 P2-6 收尾）：纯函数选择下一次重试延迟。
    ///
    /// - 服务端 `Retry-After` 优先，夹取 `0.1...5` 秒（`RaiRetryAfter` 已把
    ///   原始值夹到 `0...5`，这里再兜住 0 附近的"立即重试"）；
    /// - 提示缺失时回退到本地退避计划 `defaults[attempt]`；
    /// - 计划用尽返回 nil（不再重试）。
    /// 无 sleep、无状态，测试可直接断言。
    static func snapshotRetryDelay(serverHint: TimeInterval?, defaults: [TimeInterval], attempt: Int) -> TimeInterval? {
        if let serverHint { return min(max(serverHint, 0.1), 5) }
        guard defaults.indices.contains(attempt) else { return nil }
        return defaults[attempt]
    }

    func acceptCoachLoopWrite(_ value: CoachLoopResponse) {
        acknowledge(revision: value.revision, action: "coach-loop", goals: value.goals)
        coachLoop = value
        today = nil; coach = nil; workoutPlan = nil
        _ = repository.persist(value, scope: scope, key: "coach-loop")
    }

    private func validateCoachLoop(_ value: CoachLoopResponse, handshake: RaiHandshake?) throws {
        func hash(_ value: String) -> Bool { value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil }
        guard value.contractVersion == 1, value.timezone == "Asia/Shanghai",
              value.scope.serverId == handshake?.serverId, value.scope.athleteId == handshake?.athleteId,
              value.scope.datasetEpoch == handshake?.datasetEpoch, !value.scope.serverId.isEmpty,
              !value.scope.athleteId.isEmpty, !value.scope.datasetEpoch.isEmpty,
              value.revision >= revision, value.goals.revision == value.revision,
              hash(value.policyHash), hash(value.factsHash), hash(value.executionToken),
              UserDataNoticePolicy.isCurrentDay(value.today.day.localDate, timezone: value.timezone, now: now()),
              UserDataNoticePolicy.localDate(now: ISO8601DateFormatter().date(from: value.asOf) ??
                fractionDate(value.asOf) ?? .distantPast, timezone: value.timezone) == value.today.day.localDate,
              value.executionPolicy.localDate == value.today.day.localDate,
              value.days.count == 7, value.days.first?.day.localDate == value.today.day.localDate,
              value.days.first?.day == value.today.day,
              value.days.first?.executable == value.today.executable,
              value.days.first?.decisionRef == value.today.decisionRef,
              value.volumePolicy.suggestedWeeklyKm.isFinite, value.volumePolicy.suggestedWeeklyKm >= 0,
              value.volumePolicy.weeklyProtectionKm.isFinite, value.volumePolicy.weeklyProtectionKm >= 0 else {
            throw PlanSnapshotValidationError("教练闭环的身份、事实版本或当前日期无效")
        }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: value.timezone)!
        let formatter = DateFormatter(); formatter.calendar = calendar; formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        guard let start = formatter.date(from: value.today.day.localDate),
              value.days.map(\.day.localDate) == (0..<7).map({ formatter.string(from: calendar.date(byAdding: .day, value: $0, to: start)!) }),
              value.settings.map({ ["daily_adaptive", "race_preparation"].contains($0.mode) &&
                ["active", "paused", "ended"].contains($0.status) && ["pace", "heart_rate"].contains($0.targetType) }) ?? true,
              value.settings?.status == "active" || !value.days.contains(where: \.executable),
              !value.today.executable || value.today.decisionRef == value.volumePolicy.extension.authorizedDecisionRef,
              !value.today.executable || value.volumePolicy.extension.status != "eligible" || value.today.decisionRef != nil else {
            throw PlanSnapshotValidationError("教练窗口、生命周期或追加授权不一致")
        }
        if value.today.executable {
            guard WorkoutPlanMapper.executionMapping(from: value.devicePlan.days[0], hour: 7).status == .exact else {
                // A refresh-required snapshot is reference-only, not executable.
                if value.refreshRequired { return }
                throw PlanSnapshotValidationError("今日新课型无法无损映射，禁止执行")
            }
        }
    }

    private func fractionDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }

    private func diagnostic(_ name: String, code: String? = nil) {
        repository.diagnostic(.init(at: now(), name: name, scopeDigest: scope, operationId: nil, revision: revision,
            owed: nil, confirmed: nil, errorCode: code))
    }

    private func validate(_ value: TrainingPlanRead, handshake: RaiHandshake?) throws {
        guard value.today.recommendation.planRevision != nil,
              [value.goals.runCoach, value.coach?.plan].compactMap({ $0 }).allSatisfy({ ["active", "paused", "ended"].contains($0.status) }) else {
            throw PlanSnapshotValidationError("缺少建议安全版本或教练状态不受支持")
        }
        guard value.goals.revision >= revision, value.today.recommendation.planRevision == value.goals.revision,
              value.workoutPlan.planRevision == value.goals.revision else {
            throw RaiAPIClientError.server(code: "revision_mismatch", message: "计划版本不一致，请重读完整快照。", status: 409)
        }
        guard value.today.timezone == value.workoutPlan.timezone else {
            throw PlanSnapshotValidationError("计划日期或业务时区不一致")
        }
        guard let aggregate = value.aggregate else {
            // 2026-10-18（审查 P2-7）：旧服务三 GET 不能证明"同一事实快照"，
            // 但当前业务日/时区/窗口/逐日连续性都可以在本地判定；校验失败时
            // 调用方保持 isCurrent == false，绝不把旧响应标成 current。
            try validateLegacySnapshot(value)
            return
        }
        guard UserDataNoticePolicy.isCurrentDay(value.today.today.localDate, timezone: value.today.timezone, now: now()) else {
            throw PlanSnapshotValidationError("完整快照不属于当前业务日期")
        }
        let metadata = aggregate.metadata
        guard metadata.contractVersion == 1, metadata.serverId == handshake?.serverId,
              !metadata.serverId.isEmpty, !metadata.athleteId.isEmpty, !metadata.datasetEpoch.isEmpty, !metadata.ruleVersion.isEmpty,
              metadata.athleteId == handshake?.athleteId, metadata.datasetEpoch == handshake?.datasetEpoch,
              metadata.goalsRevision == value.goals.revision, metadata.timezone == "Asia/Shanghai",
              metadata.timezone == value.today.timezone, metadata.localDate == value.today.today.localDate,
              metadata.windowStart == metadata.localDate, metadata.windowStart == value.workoutPlan.windowStart,
              metadata.windowEnd == value.workoutPlan.windowEnd, metadata.coherenceToken.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              metadata.publicationDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              aggregate.coachSummary.revision == value.goals.revision, ["ready", "empty"].contains(aggregate.availability),
              (1...14).contains(value.workoutPlan.windowDays), value.workoutPlan.days.count == value.workoutPlan.windowDays,
              let zone = TimeZone(identifier: metadata.timezone) else { throw PlanSnapshotValidationError("完整快照的安全身份或窗口字段无效") }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = calendar; formatter.timeZone = zone; formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        guard let start = formatter.date(from: metadata.windowStart), formatter.string(from: start) == metadata.windowStart else {
            throw PlanSnapshotValidationError("窗口起始日不是真实日期")
        }
        let dates = (0..<value.workoutPlan.windowDays).map { formatter.string(from: calendar.date(byAdding: .day, value: $0, to: start)!) }
        guard dates == value.workoutPlan.days.map(\.localDate), dates.last == metadata.windowEnd,
              (aggregate.availability == "empty") == !value.workoutPlan.days.contains(where: { $0.executable && $0.kind != "rest" }) else {
            throw PlanSnapshotValidationError("逐日身份必须连续、唯一且覆盖闭区间")
        }
    }

    private func validateLegacySnapshot(_ value: TrainingPlanRead) throws {
        guard value.today.timezone == "Asia/Shanghai",
              let zone = TimeZone(identifier: value.today.timezone),
              UserDataNoticePolicy.isCurrentDay(value.today.today.localDate, timezone: value.today.timezone, now: now()) else {
            throw PlanSnapshotValidationError("旧服务计划快照不属于当前业务日期或时区不受支持")
        }
        let plan = value.workoutPlan
        guard (1...14).contains(plan.windowDays), !plan.days.isEmpty, plan.days.count <= plan.windowDays,
              plan.days.first?.localDate == value.today.today.localDate,
              plan.windowStart == nil || plan.windowStart == plan.days.first?.localDate else {
            throw PlanSnapshotValidationError("旧服务计划窗口长度或起始日无效")
        }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = calendar; formatter.timeZone = zone; formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        guard let start = formatter.date(from: value.today.today.localDate),
              formatter.string(from: start) == value.today.today.localDate else {
            throw PlanSnapshotValidationError("旧服务计划起始日不是真实日期")
        }
        let dates = (0..<plan.days.count).map { formatter.string(from: calendar.date(byAdding: .day, value: $0, to: start)!) }
        guard dates == plan.days.map(\.localDate),
              plan.windowEnd == nil || plan.windowEnd == plan.days.last?.localDate else {
            throw PlanSnapshotValidationError("旧服务计划逐日身份必须连续、唯一且覆盖闭区间")
        }
    }
}
