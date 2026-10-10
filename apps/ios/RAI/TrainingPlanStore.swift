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
    private let repository: TrainingPlanRepository
    private let now: () -> Date
    private(set) var scope: String
    var legacyRetryCount = 2

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
            acknowledgement = nil; minimumRevision = 0; cachedAt = nil
            availability = .unavailable; issue = nil
        }
        self.scope = scope
        restoreSafety()
    }

    func invalidate() {
        epoch = UUID(); requestID = UUID(); isRefreshing = false; isCurrent = false
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
        let cachedGoals = aggregate?.value.goals ?? repository.cached(MobileGoalsResponse.self, scope: scope, key: "goals").value?.value
        let cachedCoach = aggregate?.value.coachSummary ?? repository.cached(MobileRunCoachResponse.self, scope: scope, key: "run-coach").value?.value
        if let value = cachedGoals, value.revision >= revision { minimumRevision = value.revision; goals = value }
        if let value = cachedCoach, value.revision >= revision { minimumRevision = value.revision; coach = value }
        let cachedToday = aggregate?.value.today ?? repository.cached(MobileTodayResponse.self, scope: scope, key: "today").value?.value
        if cachedToday?.recommendation.planRevision == revision { today = cachedToday }
        let cachedPlan = aggregate?.value.workoutPlan ?? repository.cached(MobileWorkoutPlanResponse.self, scope: scope, key: "workout-plan").value?.value
        if cachedPlan?.planRevision == revision { workoutPlan = cachedPlan }
        cachedAt = aggregate?.cachedAt
        availability = persistenceFailed ? .savedAwaitingRefresh : .cached(asOf: cachedAt)
        isCurrent = false
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
        let retries = max(0, min(2, handshake?.planSnapshotContractVersion == nil ? legacyRetryCount : 0))
        for attempt in 0...retries {
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
                if let goals = partial?.goals, goals.revision >= revision {
                    minimumRevision = goals.revision; self.goals = goals
                    serviceReachable = true
                    _ = repository.persist(goals, scope: scope, key: "goals")
                }
                if let plan = partial?.plan, plan.planRevision >= revision {
                    workoutPlan = plan
                    _ = repository.persist(plan, scope: scope, key: "workout-plan")
                }
                let reason = PlanReadIssue.network(partial?.cause ?? error)
                issue = reason
                if case RaiAPIClientError.server(let code, _, _) = partial?.cause ?? error, code == "plan_snapshot_changed" {
                    diagnostic("snapshot_changed", code: code)
                } else { diagnostic(reason.code == .revisionConflict ? "revision_mismatch" : "snapshot_rejected", code: reason.code.rawValue) }
                if attempt < retries && reason.retryable { continue }
                availability = acknowledgement != nil ? .savedAwaitingRefresh : reason.code == .revisionConflict ? .revisionMismatch : .unavailable
                return false
            }
        }
        return false
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
            throw RaiAPIClientError.decoding("教练闭环的身份、事实版本或当前日期无效")
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
            throw RaiAPIClientError.decoding("教练窗口、生命周期或追加授权不一致")
        }
        if value.today.executable {
            guard WorkoutPlanMapper.executionMapping(from: value.devicePlan.days[0], hour: 7).status == .exact else {
                // A refresh-required snapshot is reference-only, not executable.
                if value.refreshRequired { return }
                throw RaiAPIClientError.decoding("今日新课型无法无损映射，禁止执行")
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
            throw RaiAPIClientError.decoding("缺少建议安全版本或教练状态不受支持")
        }
        guard value.goals.revision >= revision, value.today.recommendation.planRevision == value.goals.revision,
              value.workoutPlan.planRevision == value.goals.revision else {
            throw RaiAPIClientError.server(code: "revision_mismatch", message: "计划版本不一致，请重读完整快照。", status: 409)
        }
        guard value.today.timezone == value.workoutPlan.timezone else {
            throw RaiAPIClientError.decoding("计划日期或业务时区不一致")
        }
        guard let aggregate = value.aggregate else { return }
        guard UserDataNoticePolicy.isCurrentDay(value.today.today.localDate, timezone: value.today.timezone, now: now()) else {
            throw RaiAPIClientError.decoding("完整快照不属于当前业务日期")
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
              let zone = TimeZone(identifier: metadata.timezone) else { throw RaiAPIClientError.decoding("完整快照的安全身份或窗口字段无效") }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = calendar; formatter.timeZone = zone; formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        guard let start = formatter.date(from: metadata.windowStart), formatter.string(from: start) == metadata.windowStart else {
            throw RaiAPIClientError.decoding("窗口起始日不是真实日期")
        }
        let dates = (0..<value.workoutPlan.windowDays).map { formatter.string(from: calendar.date(byAdding: .day, value: $0, to: start)!) }
        guard dates == value.workoutPlan.days.map(\.localDate), dates.last == metadata.windowEnd,
              (aggregate.availability == "empty") == !value.workoutPlan.days.contains(where: { $0.executable && $0.kind != "rest" }) else {
            throw RaiAPIClientError.decoding("逐日身份必须连续、唯一且覆盖闭区间")
        }
    }
}
