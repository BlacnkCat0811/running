import Foundation

struct TrainingPlanRead {
    let goals: MobileGoalsResponse
    let today: MobileTodayResponse
    let workoutPlan: MobileWorkoutPlanResponse
    let coach: MobileRunCoachResponse?
    let aggregate: TrainingPlanStateResponse?
}

struct TrainingPlanPartialReadError: Error {
    let goals: MobileGoalsResponse?
    let today: MobileTodayResponse?
    let plan: MobileWorkoutPlanResponse?
    let cause: Error
}

@MainActor
struct TrainingPlanRepository {
    let api: RaiAPIClient
    let cache: CacheStore

    func cached<Value: Codable>(_ type: Value.Type, scope: String, key: String) -> CacheReadResult<CachedValue<Value>> {
        cache.readResult(type, scope: scope, key: key)
    }

    func persist<Value: Codable>(_ value: Value, scope: String, key: String) -> Date? {
        cache.write(value, scope: scope, key: key)
    }

    func acknowledgement(scope: String) -> CacheReadResult<PlanWriteAcknowledgement> { cache.planAcknowledgementResult(scope: scope) }
    func revisionFloor(scope: String) -> Int? { cache.planRevisionFloor(scope: scope) }
    func acknowledge(_ value: PlanWriteAcknowledgement, scope: String, goals: MobileGoalsResponse?, coach: MobileRunCoachResponse?) -> Bool {
        cache.acknowledgePlanWrite(value, scope: scope, goals: goals, coach: coach)
    }
    func diagnostic(_ value: PlanDiagnosticEvent) { cache.recordPlanDiagnostic(value) }

    func read(baseURL: URL, token: String, handshake: RaiHandshake?) async throws -> TrainingPlanRead {
        if let version = handshake?.planSnapshotContractVersion {
            guard version == 1 else { throw RaiAPIClientError.decoding("不支持的计划快照契约") }
            let value = try await api.trainingPlanState(baseURL: baseURL, token: token)
            return .init(goals: value.goals, today: value.today, workoutPlan: value.workoutPlan, coach: value.coachSummary, aggregate: value)
        }
        async let goalRead = api.goals(baseURL: baseURL, token: token)
        async let todayRead = api.today(baseURL: baseURL, token: token)
        async let planRead = api.workoutPlan(baseURL: baseURL, token: token)
        do { return try await .init(goals: goalRead, today: todayRead, workoutPlan: planRead, coach: nil, aggregate: nil) }
        catch {
            let goals = try? await goalRead
            let today = try? await todayRead
            let plan = try? await planRead
            throw TrainingPlanPartialReadError(goals: goals, today: today, plan: plan, cause: error)
        }
    }

    /// v2 统一训练状态：训练页唯一的计划读。
    ///
    /// 刻意**不**参与 `read` 的 v1 三读/聚合分支：v2 不是"执行处方快照"的另一种
    /// 包装，它没有今日建议和可执行处方。把它塞进 `TrainingPlanRead` 会迫使调用点
    /// 在两个合同之间挑一个当"当前"，而 PR5 的规则是两者各管各的：
    /// 执行授权只能来自执行快照，模式/准入/意图只能来自统一状态。
    func readUnifiedPlan(baseURL: URL, token: String, sessionEntities: Bool = false,
                         updateStages: Bool = false) async throws -> TrainingPlanStateResponseV2 {
        try await api.trainingPlanStateV2(baseURL: baseURL, token: token, sessionEntities: sessionEntities,
            updateStages: updateStages)
    }
}

extension PlanReadIssue {
    static func network(_ error: Error) -> Self {
        // 2026-10-18（审查 P2-8）：安全字段校验失败不是"协议形状不兼容"。
        // 若误归成 contractMismatch，面板会提示"升级 App/服务端版本"，
        // 而真实原因是这一份快照不可信。保持不可重试、单独分类。
        if let validation = error as? PlanSnapshotValidationError {
            return .init(code: .snapshotValidationFailed, message: validation.message)
        }
        let code: Code
        switch error {
        case RaiAPIClientError.unavailable: code = .offline
        case RaiAPIClientError.timedOut: code = .timeout
        case RaiAPIClientError.unauthorized: code = .unauthorized
        case RaiAPIClientError.decoding: code = .contractMismatch
        case RaiAPIClientError.server(_, _, let status): code = status == 409 ? .revisionConflict
            // PR-01: HTTP 410 means the old plan surface was deliberately
            // retired. It is a terminal upgrade state, never "server
            // temporarily unavailable" — retrying the same read cannot help.
            : status == 404 || status == 410 ? .contractMismatch : .serverUnavailable
        // 2026-10-18（审查 P2-6 收尾）：503 + Retry-After 仍只是"服务端暂时不可用"，
        // 不能因为携带重试提示就归成 contractMismatch；保留可重试分类。
        case RaiAPIClientError.retryableServer(_, _, let status, _):
            code = status == 409 ? .revisionConflict : status == 404 || status == 410 ? .contractMismatch : .serverUnavailable
        default: code = .serverUnavailable
        }
        return .init(code: code, message: error.localizedDescription)
    }

    /// v2 统一训练读的错误分类。
    ///
    /// 合同拒绝与"某份快照不可信"必须是两类：前者只有升级/迁移能解决，且绝不能
    /// 退回旧合同；后者是这一次的数据有问题，重读可能恢复。网络与鉴权错误沿用
    /// `network(_:)` 的既有分类，避免"连不上"被提示成"升级 App"。
    static func unified(_ error: Error) -> Self {
        switch error {
        case RaiTrainingPlanContractError.contractUnsupported:
            return .init(code: .upgradeRequired, message: error.localizedDescription)
        case RaiTrainingPlanContractError.notMigrated:
            return .init(code: .notMigrated, message: error.localizedDescription)
        case RaiTrainingPlanContractError.unavailable:
            return .init(code: .serverUnavailable, message: error.localizedDescription)
        case let validation as TrainingPlanUnifiedValidationError:
            switch validation {
            case .unsupportedContractVersion:
                return .init(code: .upgradeRequired, message: validation.localizedDescription)
            case .staleGoalsRevision:
                return .init(code: .revisionConflict, message: validation.localizedDescription)
            default:
                return .init(code: .snapshotValidationFailed, message: validation.localizedDescription)
            }
        case RaiAPIClientError.decoding:
            return .init(code: .contractMismatch, message: error.localizedDescription)
        default:
            return network(error)
        }
    }
}
