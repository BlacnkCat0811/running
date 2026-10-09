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
        let code: Code
        switch error {
        case RaiAPIClientError.unavailable: code = .offline
        case RaiAPIClientError.timedOut: code = .timeout
        case RaiAPIClientError.unauthorized: code = .unauthorized
        case RaiAPIClientError.decoding: code = .contractMismatch
        case RaiAPIClientError.server(_, _, let status): code = status == 409 ? .revisionConflict : status == 404 ? .contractMismatch : .serverUnavailable
        default: code = .serverUnavailable
        }
        return .init(code: code, message: error.localizedDescription)
    }
}
