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
        case RaiAPIClientError.server(_, _, let status): code = status == 409 ? .revisionConflict : status == 404 ? .contractMismatch : .serverUnavailable
        // 2026-10-18（审查 P2-6 收尾）：503 + Retry-After 仍只是"服务端暂时不可用"，
        // 不能因为携带重试提示就归成 contractMismatch；保留可重试分类。
        case RaiAPIClientError.retryableServer(_, _, let status, _):
            code = status == 409 ? .revisionConflict : status == 404 ? .contractMismatch : .serverUnavailable
        default: code = .serverUnavailable
        }
        return .init(code: code, message: error.localizedDescription)
    }
}
