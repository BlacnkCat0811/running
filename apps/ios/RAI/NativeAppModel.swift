#if os(iOS)
import Foundation
import Observation

@Observable
@MainActor
final class NativeAppModel {
    let session: ServerSession
    private let api: RaiAPIClient
    private let now: () -> Date
    private let cache = CacheStore()

    private(set) var handshake: RaiHandshake?
    private(set) var today: MobileTodayResponse?
    private(set) var statistics: MobileStatisticsResponse?
    private(set) var trends: MobileTrendsResponse?
    private(set) var goals: MobileGoalsResponse?
    private(set) var workoutPlan: MobileWorkoutPlanResponse?
    private(set) var runCoach: MobileRunCoachResponse?
    private(set) var isLoadingRunCoach = false
    private(set) var isUpdatingRunCoach = false
    var runCoachError: String?
    private var runCoachRequestID = UUID()
    private(set) var predictions: NativePredictionResponse?
    private(set) var dashboard: NativeDashboardResponse?
    private(set) var trainingZones: NativeTrainingZonesCurrentResponse?
    private(set) var trainingStatistics: NativeTrainingStatisticsOverviewResponse?
    private(set) var workouts: [WorkoutListItem] = []
    private(set) var workoutTotal = 0
    private(set) var selectedWorkout: WorkoutDetailResponse?
    private(set) var selectedSeries: WorkoutSeriesResponse?
    private(set) var isLoading = false
    private(set) var isRefreshing = false
    private(set) var isOffline = false
    private(set) var isTodayAvailable = false
    var canConfirmToday: Bool {
        guard let today else { return false }
        return isTodayAvailable && UserDataNoticePolicy.isCurrentDay(today.today.localDate, timezone: today.timezone, now: now())
    }
    private(set) var lastCacheUpdate: Date?
    var errorMessage: String?
    private(set) var isLoadingWorkouts = false
    private(set) var workoutListError: String?
    private(set) var isLoadingTrainingStatistics = false
    private(set) var isLoadingWorkout = false
    private(set) var isLoadingBodyMetrics = false
    private(set) var workoutDetailError: String?
    private(set) var bodyMetricsError: String?
    private(set) var predictionLoadState: PredictionLoadState = .unavailable(message: "尚未加载预测")
    private var predictionLastCacheAt: Date?
    private(set) var isLockingSession = false
    private(set) var isLoadingWorkoutPlan = false
    private(set) var workoutPlanError: String?
    private(set) var isRegeneratingPlan = false
    private(set) var isSavingGoals = false
    private(set) var isRefreshingPlan = false
    private(set) var isSyncingPlan = false
    private var planMutationEpoch = UUID()
    private var planRefreshRequestID = UUID()
    private var saveGoalsRequestID = UUID()
    private var refreshQueued = false
    private var refreshHandshakeQueued = false
    var isPlanBusy: Bool { isSavingGoals || isLockingSession || isRegeneratingPlan || isSyncingPlan || isUpdatingRunCoach }
    var currentPlanRevision: Int { max(minimumPlanRevision, max(goals?.revision ?? 0, runCoach?.revision ?? 0)) }
    /// Human-readable result of the last plan generation, including fallbacks.
    var planMessage: String?
    var planPreview: MobileWeeklyPlanPreview?
    private(set) var lastWatchRevision: Int?
    private(set) var lastWatchSyncAt: Date?
    private var lastWatchDays: [MobileWorkoutPlanDay]?
    private var lastWatchTimezone: String?
    private var lastWatchHour: Int?
    var watchNeedsUpdate: Bool { watchPlanNeedsUpdate(workoutPlan) }

    /// The only executable plan the UI is allowed to present as current.
    ///
    /// A goals mutation can succeed while the follow-up executable-plan read
    /// fails. Keeping the old response in memory is useful for diagnostics and
    /// offline recovery, but it must not be presented as the new prescription.
    var currentWorkoutPlan: MobileWorkoutPlanResponse? {
        guard let workoutPlan, workoutPlan.planRevision == currentPlanRevision else { return nil }
        return workoutPlan
    }

    /// True when the last Watch acknowledgement refers to a plan that is no
    /// longer current. This is intentionally independent of connectivity: a
    /// stale local Watch schedule can be withdrawn without fetching a new plan.
    var watchNeedsClear: Bool {
        lastWatchRevision != nil && currentWorkoutPlan == nil && watchPlanNeedsUpdate(workoutPlan)
    }

    func watchPlanNeedsUpdate(_ plan: MobileWorkoutPlanResponse?) -> Bool {
        guard let revision = lastWatchRevision else { return false }
        guard let plan else { return true }
        return currentPlanRevision != revision || plan.planRevision != revision ||
            plan.days != lastWatchDays || plan.timezone != lastWatchTimezone ||
            Self.storedScheduleHour(scope: cacheScope) != lastWatchHour
    }
    var workoutSessionType: String? {
        didSet {
            guard oldValue != workoutSessionType else { return }
            workoutRequestID = UUID()
            isLoadingWorkouts = false
            workouts = []
            workoutTotal = 0
            loadCachedWorkouts()
        }
    }
    private var workoutRequestID = UUID()
    private var detailRequestID = UUID()
    private var lockRequestID = UUID()
    private var workoutPlanRequestID = UUID()
    private var regeneratePlanRequestID = UUID()
    private var planSyncRequestID = UUID()
    private var minimumPlanRevision = 0

    /// Dates `/v1/mobile/today` reports as already trained.
    ///
    /// `/v1/mobile/workout-plan` carries those same dates as prescriptions, so
    /// the week panel has to be told which rows are history rather than work
    /// still owed. Not a view decision — the rule lives here, not in a skin.
    var completedWeekDates: Set<String> {
        Set((today?.weekPlan ?? []).compactMap { $0.completedWorkoutId != nil ? $0.localDate : nil })
    }

    private var configurationID = UUID()
    private var cacheScope: String
    private let workoutPageSize = 30

    init(session: ServerSession, api: RaiAPIClient? = nil, now: @escaping () -> Date = Date.init) {
        self.now = now
        self.api = api ?? RaiAPIClient()
        self.session = session
        let baseURL = session.serverURL ?? URL(fileURLWithPath: "/")
        let knownHandshake = Self.loadHandshake(for: baseURL)
        self.handshake = knownHandshake
        self.cacheScope = CacheStore.scope(baseURL: baseURL, handshake: knownHandshake)
    }

    func bootstrap() async {
        guard !isLoading else { return }
        loadCachedData()
        guard session.serverURL != nil else { return }
        await connect()
    }

    func serverConfigurationChanged() {
        configurationID = UUID()
        isTodayAvailable = false
        isLoading = false
        isRefreshing = false
        invalidatePlanOperations()
        session.isReachable = false
        guard let baseURL = session.serverURL else {
            clearPresentation()
            handshake = nil
            isOffline = true
            return
        }
        prepareCacheScope(for: baseURL)
        isOffline = true
        errorMessage = nil
    }

    func connect() async {
        guard !isLoading else { return }
        guard let baseURL = session.serverURL else {
            errorMessage = RaiAPIClientError.invalidServerAddress.localizedDescription
            return
        }
        let configuration = configurationID
        let token = session.apiToken
        func isCurrent() -> Bool {
            configuration == configurationID && baseURL == session.serverURL &&
                token == session.apiToken && !Task.isCancelled
        }
        prepareCacheScope(for: baseURL)
        isLoading = true
        defer { if configuration == configurationID { isLoading = false } }
        errorMessage = nil
        do {
            let identity = try await api.handshake(baseURL: baseURL, token: token)
            guard isCurrent() else { return }
            HealthSyncIdentityPublisher.publish(identity, baseURL: baseURL)
            setCacheScope(baseURL: baseURL, handshake: identity)
            session.isReachable = true
            session.lastError = nil
            await session.probe()
            guard isCurrent() else { return }
            loadCachedData()
            await refreshAll(requestHandshake: false)
        } catch {
            guard isCurrent() else { return }
            isOffline = true
            errorMessage = friendlyMessage(error)
            loadCachedData()
        }
    }

    func refreshAll(requestHandshake: Bool = true) async {
        guard let baseURL = session.serverURL else { return }
        guard !isRefreshing else {
            refreshQueued = true
            refreshHandshakeQueued = refreshHandshakeQueued || requestHandshake
            return
        }
        let configuration = configurationID
        let token = session.apiToken
        let mutation = planMutationEpoch
        func isCurrent() -> Bool {
            configuration == configurationID && baseURL == session.serverURL &&
                token == session.apiToken && mutation == planMutationEpoch && !Task.isCancelled
        }
        prepareCacheScope(for: baseURL)
        isRefreshing = true
        defer {
            if configuration == configurationID {
                isRefreshing = false
                if refreshQueued {
                    let handshake = refreshHandshakeQueued
                    refreshQueued = false
                    refreshHandshakeQueued = false
                    Task { await self.refreshAll(requestHandshake: handshake) }
                }
            }
        }
        errorMessage = nil
        if requestHandshake {
            // 握手是整页可用性的前置条件：拿不到身份就没有可用的数据域，这时
            // 回退缓存是对的，因为没有任何面板拿到过新数据。
            do {
                let identity = try await api.handshake(baseURL: baseURL, token: token)
                guard isCurrent() else { return }
                HealthSyncIdentityPublisher.publish(identity, baseURL: baseURL)
                setCacheScope(baseURL: baseURL, handshake: identity)
            } catch {
                guard isCurrent() else { return }
                isOffline = true
                isTodayAvailable = false
                errorMessage = friendlyMessage(error)
                loadCachedData()
                return
            }
        }
        // 四个面板互不依赖：并发拉取，并且**逐个**容错。
        //
        // 原先把四个请求绑成一个元组一起 `try await`，任一失败就整体抛错 ——
        // 「统计接口 500」会把已经拿到的今日/趋势/目标一起丢掉，再整体回退到
        // 更旧的缓存。一次单点抖动等于整页降级，而且用户看不出是哪一项坏了。
        // 现在失败的面板保持原值不动，成功的照常写入并落缓存。
        async let pendingToday = api.today(baseURL: baseURL, token: token)
        async let pendingStatistics = api.statistics(baseURL: baseURL, token: token)
        async let pendingTrends = api.trends(baseURL: baseURL, token: token)
        async let pendingGoals = api.goals(baseURL: baseURL, token: token)
        let fetchedToday = try? await pendingToday
        let fetchedStatistics = try? await pendingStatistics
        let fetchedTrends = try? await pendingTrends
        let fetchedGoals = try? await pendingGoals
        guard isCurrent() else { return }
        var failedPanels = 0
        let snapshotIsCurrent = (fetchedGoals?.revision ?? -1) >= max(minimumPlanRevision, goals?.revision ?? -1) &&
            (fetchedToday?.recommendation.planRevision == nil || fetchedToday?.recommendation.planRevision == fetchedGoals?.revision)
        if let fetchedToday, snapshotIsCurrent {
            isTodayAvailable = true
            today = fetchedToday
            recordCache(fetchedToday, key: "today")
        } else {
            isTodayAvailable = false
            failedPanels += 1
        }
        if let fetchedStatistics {
            statistics = fetchedStatistics
            recordCache(fetchedStatistics, key: "statistics")
        } else {
            failedPanels += 1
        }
        if let fetchedTrends {
            trends = fetchedTrends
            recordCache(fetchedTrends, key: "trends")
        } else {
            failedPanels += 1
        }
        if let fetchedGoals {
            acceptGoals(fetchedGoals)
        } else {
            failedPanels += 1
        }
        // Non-fatal: the executable week is a convenience, and a failure here
        // must not mark the whole refresh as offline.
        do {
            let fetchedPlan = try await api.workoutPlan(baseURL: baseURL, token: token)
            guard isCurrent() else { return }
            if fetchedPlan.planRevision >= max(minimumPlanRevision, goals?.revision ?? 0) {
                workoutPlan = fetchedPlan
                workoutPlanError = nil
                recordCache(fetchedPlan, key: workoutPlanCacheKey)
            } else {
                workoutPlanError = "服务返回的课表版本已过期，请刷新后重试。"
            }
        } catch {
            guard isCurrent() else { return }
            workoutPlanError = friendlyMessage(error)
        }
        let workoutsSucceeded = await refreshWorkouts()
        guard isCurrent() else { return }
        // Any successful panel proves service reachability. Recommendation freshness is
        // tracked separately, so a list-only failure cannot invalidate every panel.
        let anySucceeded = workoutsSucceeded || fetchedToday != nil || fetchedStatistics != nil || fetchedTrends != nil || fetchedGoals != nil
        isOffline = !anySucceeded
        session.isReachable = anySucceeded
        if failedPanels > 0 {
            // 刻意不在这里 `loadCachedData()`：那会把刚刚成功的那几项也推回旧值，
            // 等于用一次部分失败抹掉一次部分成功。首启的空态由 `bootstrap()`
            // 的 `loadCachedData()` 兜底。
            errorMessage = failedPanels == 4
                ? "核心数据均未能更新，当前显示的是上次结果。"
                : "有 \(failedPanels) 项数据未能更新，其余已刷新。"
        }
        if fetchedGoals?.runCoach != nil { await refreshRunCoach() }
    }

    @discardableResult
    func refreshRunCoach() async -> Bool {
        guard !isLoadingRunCoach, !isPlanBusy, let baseURL = session.serverURL else { return false }
        let configuration = configurationID
        let token = session.apiToken
        let requestID = UUID()
        runCoachRequestID = requestID
        isLoadingRunCoach = true
        defer { if runCoachRequestID == requestID { isLoadingRunCoach = false } }
        func isCurrent() -> Bool {
            configuration == configurationID && baseURL == session.serverURL && token == session.apiToken &&
                runCoachRequestID == requestID && !Task.isCancelled
        }
        do {
            let value = try await api.runCoach(baseURL: baseURL, token: token)
            guard isCurrent(), value.revision >= currentPlanRevision else { return false }
            minimumPlanRevision = max(minimumPlanRevision, value.revision)
            runCoach = value
            recordCache(value, key: "run-coach")
            runCoachError = nil
            if value.plan?.status == "active", !isOffline {
                return await changeRunCoach(action: "refresh", expectedRevision: value.revision)
            }
            // Paused/ended plans also need coherent dependent reads after a
            // partial save, and an offline retry must restore reachability.
            let refreshed = await refreshPlanState()
            guard isCurrent() else { return false }
            guard refreshed else {
                runCoachError = "教练状态已更新，但训练安排未刷新，请重新连接后刷新。"
                return false
            }
            if value.plan?.status == "active", value.revision == currentPlanRevision {
                return await changeRunCoach(action: "refresh", expectedRevision: value.revision)
            }
            return true
        } catch {
            guard isCurrent() else { return false }
            runCoachError = friendlyMessage(error)
            return false
        }
    }

    @discardableResult
    func changeRunCoach(action: String, config: MobileRunCoachConfig? = nil, expectedRevision: Int? = nil) async -> Bool {
        guard !isPlanBusy, !isOffline, let baseURL = session.serverURL,
              let revision = expectedRevision ?? goals?.revision else { return false }
        let configuration = configurationID
        let token = session.apiToken
        let requestID = UUID()
        saveGoalsRequestID = requestID
        isUpdatingRunCoach = true
        defer { if saveGoalsRequestID == requestID { isUpdatingRunCoach = false } }
        func isCurrent() -> Bool {
            configuration == configurationID && baseURL == session.serverURL && token == session.apiToken &&
                saveGoalsRequestID == requestID && !Task.isCancelled
        }
        do {
            let value = try await api.runCoachCommand(MobileRunCoachCommand(expectedRevision: revision, action: action, config: config), baseURL: baseURL, token: token)
            guard isCurrent() else { return false }
            invalidatePlanReads()
            minimumPlanRevision = max(minimumPlanRevision, value.revision)
            runCoach = value
            recordCache(value, key: "run-coach")
            runCoachError = nil
            let refreshed = await refreshPlanState()
            guard isCurrent() else { return false }
            if !refreshed { runCoachError = "教练计划已保存，但训练安排未刷新，请重新连接后刷新。" }
            return true
        } catch {
            guard isCurrent() else { return false }
            runCoachError = friendlyMessage(error)
            if case RaiAPIClientError.server(let code, _, _) = error, code == "mobile_goals_revision_conflict" {
                _ = await refreshPlanState()
            }
            return false
        }
    }

    @discardableResult
    func refreshWorkouts() async -> Bool {
        guard let baseURL = session.serverURL else { return false }
        let requestID = UUID()
        workoutRequestID = requestID
        let scope = cacheScope
        let token = session.apiToken
        let filter = workoutSessionType
        let key = workoutsCacheKey
        workoutListError = nil
        isLoadingWorkouts = true
        defer { if workoutRequestID == requestID { isLoadingWorkouts = false } }
        do {
            let response = try await api.workouts(
                baseURL: baseURL, token: token, limit: workoutPageSize,
                offset: 0, sessionType: filter
            )
            guard workoutRequestID == requestID, scope == cacheScope,
                  baseURL == session.serverURL, token == session.apiToken,
                  !Task.isCancelled else { return false }
            workouts = response.items
            workoutTotal = response.total
            recordCache(response, key: key)
            return true
        } catch {
            guard workoutRequestID == requestID, scope == cacheScope,
                  baseURL == session.serverURL, token == session.apiToken,
                  !Task.isCancelled else { return false }
            isOffline = true
            workoutListError = friendlyMessage(error)
            errorMessage = workoutListError
            loadCachedWorkouts()
            return false
        }
    }

    func loadMoreWorkouts() async {
        guard let baseURL = session.serverURL,
              !isLoadingWorkouts, !isRefreshing,
              workouts.count < workoutTotal else { return }
        let requestID = UUID()
        workoutRequestID = requestID
        let scope = cacheScope
        let token = session.apiToken
        let key = workoutsCacheKey
        let filter = workoutSessionType
        let nextOffset = workouts.count
        workoutListError = nil
        isLoadingWorkouts = true
        defer { if workoutRequestID == requestID { isLoadingWorkouts = false } }
        do {
            let response = try await api.workouts(
                baseURL: baseURL, token: token, limit: workoutPageSize,
                offset: nextOffset, sessionType: filter
            )
            guard workoutRequestID == requestID, scope == cacheScope,
                  baseURL == session.serverURL, token == session.apiToken,
                  !Task.isCancelled else { return }
            let existing = Set(workouts.map(\.id))
            workouts.append(contentsOf: response.items.filter { !existing.contains($0.id) })
            workoutTotal = response.total
            recordCache(
                WorkoutListResponse(items: workouts, total: response.total, limit: response.limit, offset: 0),
                key: key
            )
        } catch {
            guard workoutRequestID == requestID, scope == cacheScope,
                  baseURL == session.serverURL, token == session.apiToken,
                  !Task.isCancelled else { return }
            isOffline = true
            workoutListError = friendlyMessage(error)
            errorMessage = workoutListError
        }
    }

    func refreshTrainingStatistics() async {
        guard let baseURL = session.serverURL,
              !isLoadingTrainingStatistics else { return }
        let configuration = configurationID
        let scope = cacheScope
        let token = session.apiToken
        isLoadingTrainingStatistics = true
        defer {
            if configuration == configurationID {
                isLoadingTrainingStatistics = false
            }
        }
        do {
            let fetched = try await api.trainingStatisticsOverview(baseURL: baseURL, token: token)
            guard configuration == configurationID,
                  scope == cacheScope,
                  baseURL == session.serverURL,
                  token == session.apiToken,
                  !Task.isCancelled else { return }
            trainingStatistics = fetched
            recordCache(fetched, key: "training-statistics")
        } catch {
            // The workout list remains usable with cached data or "--" metrics.
            guard configuration == configurationID,
                  scope == cacheScope,
                  baseURL == session.serverURL,
                  token == session.apiToken,
                  !Task.isCancelled else { return }
        }
    }

    func loadWorkout(id: String) async {
        let requestID = UUID()
        detailRequestID = requestID
        let scope = cacheScope
        let token = session.apiToken
        let baseURL = session.serverURL
        selectedWorkout = cache.read(WorkoutDetailResponse.self, scope: scope, key: "workout-detail-\(id)")?.value
        selectedSeries = cache.read(WorkoutSeriesResponse.self, scope: scope, key: "workout-series-\(id)")?.value
        workoutDetailError = nil
        isLoadingWorkout = true
        defer { if detailRequestID == requestID { isLoadingWorkout = false } }
        func isCurrent() -> Bool {
            detailRequestID == requestID && scope == cacheScope &&
                baseURL == session.serverURL && token == session.apiToken && !Task.isCancelled
        }
        guard let baseURL else {
            workoutDetailError = "请先连接 RAI 服务。"
            return
        }
        do {
            let detail = try await api.workoutDetail(id: id, baseURL: baseURL, token: token)
            guard isCurrent() else { return }
            selectedWorkout = detail
            recordCache(detail, key: "workout-detail-\(id)")
            do {
                let series = try await api.workoutSeries(id: id, baseURL: baseURL, token: token)
                guard isCurrent() else { return }
                selectedSeries = series
                recordCache(series, key: "workout-series-\(id)")
            } catch {
                guard isCurrent() else { return }
                workoutDetailError = "时序数据未能更新，可下拉重试。"
            }
        } catch {
            guard isCurrent() else { return }
            workoutDetailError = friendlyMessage(error)
        }
    }

    func refreshBodyMetrics() async {
        guard let baseURL = session.serverURL,
              !isLoadingBodyMetrics else { return }
        let configuration = configurationID
        let scope = cacheScope
        let token = session.apiToken
        isLoadingBodyMetrics = true
        bodyMetricsError = nil
        defer {
            if configuration == configurationID {
                isLoadingBodyMetrics = false
            }
        }

        async let predictionRequest = api.predictions(baseURL: baseURL, token: token)
        async let dashboardRequest = api.dashboard(baseURL: baseURL, token: token)
        async let zonesRequest = api.trainingZonesCurrent(baseURL: baseURL, token: token)
        async let statisticsRequest = api.trainingStatisticsOverview(baseURL: baseURL, token: token)

        let fetchedPrediction = try? await predictionRequest
        let fetchedDashboard = try? await dashboardRequest
        let fetchedZones = try? await zonesRequest
        let fetchedStatistics = try? await statisticsRequest

        guard configuration == configurationID,
              scope == cacheScope,
              baseURL == session.serverURL,
              token == session.apiToken,
              !Task.isCancelled else { return }

        if let fetchedPrediction {
            predictions = fetchedPrediction
            recordCache(fetchedPrediction, key: "predictions")
            predictionLoadState = .current(
                generatedAt: fetchedPrediction.generatedAt ?? fetchedPrediction.snapshot.generatedAt,
                dataThroughAt: fetchedPrediction.snapshot.dataThroughAt
            )
        } else {
            predictionLoadState = predictions == nil
                ? .unavailable(message: "预测暂不可用，请重试。")
                : .stale(
                    lastSuccessAt: predictionLastCacheAt,
                    message: "预测刷新失败，当前显示的是旧结果。"
                )
        }
        if let fetchedDashboard {
            dashboard = fetchedDashboard
            recordCache(fetchedDashboard, key: "dashboard")
        }
        if let fetchedZones {
            trainingZones = fetchedZones
            recordCache(fetchedZones, key: "training-zones")
        }
        if let fetchedStatistics {
            trainingStatistics = fetchedStatistics
            recordCache(fetchedStatistics, key: "training-statistics")
        }

        let failedCount =
            (fetchedPrediction == nil ? 1 : 0) +
            (fetchedDashboard == nil ? 1 : 0) +
            (fetchedZones == nil ? 1 : 0) +
            (fetchedStatistics == nil ? 1 : 0)
        if failedCount > 0 {
            bodyMetricsError = failedCount == 4
                ? "身体指标暂不可用，请检查服务连接后重试。"
                : "部分身体指标暂不可用，已显示可读取的数据。"
        }
    }

    func saveGoals(
        expectedRevision: Int,
        easyDurationFloorFraction: Double,
        qualitySessionCap: Int,
        weekPlan: [MobileGoalsPlanItem]
    ) async -> Bool {
        guard let current = goals else { return false }
        return await persistGoals(UpdateMobileGoalsRequest(
            expectedRevision: expectedRevision,
            easyDurationFloorFraction: easyDurationFloorFraction,
            qualitySessionCap: qualitySessionCap,
            raceTarget: current.raceTarget,
            weekPlan: current.weekPlanReplanRequired == true ? nil : weekPlan
        ))
    }

    /// Only changes the race target; omitted weekly-plan fields remain untouched.
    func saveRaceTarget(_ target: MobileRaceTarget?, expectedRevision: Int) async -> Bool {
        guard goals != nil else { return false }
        return await persistGoals(UpdateMobileGoalsRequest(
            expectedRevision: expectedRevision,
            easyDurationFloorFraction: nil,
            qualitySessionCap: nil,
            raceTarget: target,
            weekPlan: nil
        ))
    }

    private func persistGoals(_ request: UpdateMobileGoalsRequest) async -> Bool {
        guard !isPlanBusy else { return false }
        guard !isOffline, let baseURL = session.serverURL else {
            errorMessage = "请先连接 RAI 服务。"
            return false
        }
        let configuration = configurationID
        let token = session.apiToken
        let requestID = UUID()
        saveGoalsRequestID = requestID
        isSavingGoals = true
        planMessage = nil
        errorMessage = nil
        defer { if requestID == saveGoalsRequestID { isSavingGoals = false } }
        func isCurrent() -> Bool {
            requestID == saveGoalsRequestID && configuration == configurationID && baseURL == session.serverURL &&
                token == session.apiToken && !Task.isCancelled
        }
        guard isCurrent() else { return false }
        do {
            let updated = try await api.updateGoals(
                request,
                baseURL: baseURL,
                token: token
            )
            guard isCurrent() else { return false }
            invalidatePlanReads()
            acceptGoals(updated)
            let refreshed = await refreshPlanState()
            guard isCurrent() else { return false }
            if !refreshed {
                planMessage = "已保存，但部分计划数据未刷新。请刷新计划，不必重复保存。"
            }
            return true
        } catch {
            guard isCurrent() else { return false }
            errorMessage = friendlyMessage(error)
            if case RaiAPIClientError.server(let code, _, _) = error, code == "mobile_goals_revision_conflict" {
                if let latest = try? await api.goals(baseURL: baseURL, token: token), isCurrent() {
                    acceptGoals(latest)
                }
            }
            return false
        }
    }

    func lockNextSession(relock: Bool = false) async -> Bool {
        guard !isPlanBusy, !isOffline, canConfirmToday,
              let baseURL = session.serverURL, let current = today else { return false }
        let requestID = UUID()
        lockRequestID = requestID
        let configuration = configurationID
        let token = session.apiToken
        func isCurrent() -> Bool {
            requestID == lockRequestID && configuration == configurationID && baseURL == session.serverURL &&
                token == session.apiToken && !Task.isCancelled
        }
        isLockingSession = true
        defer {
            if requestID == lockRequestID, configuration == configurationID {
                isLockingSession = false
            }
        }
        guard isCurrent() else { return false }
        do {
            let updated = try await api.lockSession(
                LockMobileSessionRequest(action: relock ? "relock" : "lock", expectedRevision: current.recommendationRevision),
                baseURL: baseURL,
                token: token
            )
            guard isCurrent() else { return false }
            invalidatePlanReads()
            acceptGoals(updated)
            if !(await refreshPlanState()), isCurrent() {
                planMessage = "课程已锁定，但计划数据未能刷新。请刷新页面，不必重复锁定。"
            }
            return true
        } catch {
            guard isCurrent() else { return false }
            errorMessage = friendlyMessage(error)
            return false
        }
    }

    /// Fetches the executable week handed to the workout scheduler. Read-only
    /// and independent of the goals revision, so a failure here never blocks the
    /// rest of the app — it simply leaves whatever was last shown in place.
    @discardableResult
    func refreshWorkoutPlan() async -> Bool {
        guard !isLoadingWorkoutPlan, let baseURL = session.serverURL else { return false }
        let requestID = UUID()
        workoutPlanRequestID = requestID
        let configuration = configurationID
        let token = session.apiToken
        let mutation = planMutationEpoch
        func isCurrent() -> Bool {
            requestID == workoutPlanRequestID && configuration == configurationID && baseURL == session.serverURL &&
                token == session.apiToken && mutation == planMutationEpoch && !Task.isCancelled
        }
        isLoadingWorkoutPlan = true
        workoutPlanError = nil
        defer {
            if requestID == workoutPlanRequestID, configuration == configurationID {
                isLoadingWorkoutPlan = false
            }
        }
        do {
            let fetched = try await api.workoutPlan(baseURL: baseURL, token: token)
            guard isCurrent() else { return false }
            guard fetched.planRevision >= max(minimumPlanRevision, goals?.revision ?? 0) else {
                workoutPlanError = "服务返回的课表版本已过期，请刷新后重试。"
                return false
            }
            workoutPlan = fetched
            recordCache(fetched, key: workoutPlanCacheKey)
            workoutPlanError = nil
            return true
        } catch {
            guard isCurrent() else { return false }
            if workoutPlan == nil,
               let cachedPlan = cache.read(MobileWorkoutPlanResponse.self, scope: cacheScope, key: workoutPlanCacheKey)?.value,
               cachedPlan.planRevision >= max(minimumPlanRevision, goals?.revision ?? 0) {
                workoutPlan = cachedPlan
                workoutPlanError = "课表读取失败，当前显示的是离线缓存。"
            } else {
                workoutPlanError = friendlyMessage(error)
            }
            return false
        }
    }

    /// Requests a deterministic coach preview.
    /// Only confirmPlanPreview persists it; creating or cancelling a preview
    /// leaves the runner's stored week unchanged.
    @discardableResult
    func regenerateWeeklyPlan() async -> Bool {
        guard !isPlanBusy, let baseURL = session.serverURL else { return false }
        let requestID = UUID()
        regeneratePlanRequestID = requestID
        let configuration = configurationID
        let token = session.apiToken
        func isCurrent() -> Bool {
            requestID == regeneratePlanRequestID && configuration == configurationID && baseURL == session.serverURL &&
                token == session.apiToken && !Task.isCancelled
        }
        isRegeneratingPlan = true
        defer {
            if requestID == regeneratePlanRequestID, configuration == configurationID {
                isRegeneratingPlan = false
            }
        }
        planMessage = nil
        // No loaded goals snapshot means no revision to send, which the server
        // reads as "skip the optimistic lock". Fetch one first so a concurrent
        // edit is caught rather than silently overwritten.
        let revision: Int
        if let loadedRevision = goals?.revision {
            revision = loadedRevision
        } else {
            do {
                let latest = try await api.goals(baseURL: baseURL, token: token)
                guard isCurrent() else { return false }
                acceptGoals(latest)
                revision = latest.revision
            } catch {
                guard isCurrent() else { return false }
                let message = "未能读取训练目标版本，已取消生成以避免覆盖其他修改。请检查连接后重试。"
                errorMessage = message
                planMessage = message
                return false
            }
        }
        guard isCurrent() else { return false }
        do {
            let result = try await api.previewWeeklyPlan(
                GenerateWeeklyPlanRequest(expectedRevision: revision),
                baseURL: baseURL,
                token: token
            )
            guard isCurrent() else { return false }
            planPreview = result
            planMessage = "预览已生成，确认前不会修改课表，也不会发送到手表。"
            return true
        } catch {
            guard isCurrent() else { return false }
            errorMessage = friendlyMessage(error)
            planMessage = friendlyMessage(error)
            if case RaiAPIClientError.server(let code, _, _) = error, code == "mobile_goals_revision_conflict" {
                if let latest = try? await api.goals(baseURL: baseURL, token: token), isCurrent() {
                    acceptGoals(latest)
                }
                planMessage = "训练目标已在别处更新，请重新生成本周课表。"
            }
            return false
        }
    }

    @discardableResult
    func confirmPlanPreview(_ preview: MobileWeeklyPlanPreview) async -> Bool {
        guard !isPlanBusy, !isOffline, preview.revision == goals?.revision,
              let baseURL = session.serverURL else { return false }
        let configuration = configurationID
        let token = session.apiToken
        let requestID = UUID()
        regeneratePlanRequestID = requestID
        isRegeneratingPlan = true
        defer { if requestID == regeneratePlanRequestID { isRegeneratingPlan = false } }
        func isCurrent() -> Bool {
            requestID == regeneratePlanRequestID && configuration == configurationID &&
                baseURL == session.serverURL && token == session.apiToken && !Task.isCancelled
        }
        do {
            let result = try await api.confirmWeeklyPlan(ConfirmWeeklyPlanRequest(candidateId: preview.candidateId, expectedRevision: preview.revision), baseURL: baseURL, token: token)
            guard isCurrent() else { return false }
            invalidatePlanReads()
            planPreview = nil
            minimumPlanRevision = max(minimumPlanRevision, result.revision)
            let refreshed = await refreshPlanState()
            guard isCurrent() else { return false }
            planMessage = refreshed ? Self.generationSummary(result) + "；尚未同步到手表。" : "新课表已保存，但显示未刷新。请刷新计划，不要重复提交。"
            return true
        } catch {
            guard isCurrent() else { return false }
            planMessage = friendlyMessage(error)
            if case RaiAPIClientError.server(let code, _, _) = error,
               code == "plan_preview_stale" || code == "mobile_goals_revision_conflict" {
                planPreview = nil
                _ = await refreshPlanState()
            }
            return false
        }
    }

    func recordWatchAcknowledgement(plan: MobileWorkoutPlanResponse, scheduleHour: Int) {
        lastWatchRevision = plan.planRevision
        lastWatchDays = plan.days
        lastWatchTimezone = plan.timezone
        lastWatchHour = min(23, max(0, scheduleHour))
        lastWatchSyncAt = Date()
    }

    func recordWatchClearAcknowledgement() {
        lastWatchRevision = nil
        lastWatchSyncAt = Date()
        lastWatchDays = nil
        lastWatchTimezone = nil
        lastWatchHour = nil
    }

    func refreshRacePrediction() async {
        guard let baseURL = session.serverURL else { return }
        let configuration = configurationID
        let token = session.apiToken
        do {
            let result = try await api.predictions(baseURL: baseURL, token: token)
            guard configuration == configurationID, baseURL == session.serverURL,
                  token == session.apiToken, !Task.isCancelled else { return }
            predictions = result
            recordCache(result, key: "predictions")
            predictionLoadState = .current(
                generatedAt: result.generatedAt ?? result.snapshot.generatedAt,
                dataThroughAt: result.snapshot.dataThroughAt
            )
        } catch {
            guard configuration == configurationID, baseURL == session.serverURL,
                  token == session.apiToken, !Task.isCancelled else { return }
            predictionLoadState = predictions == nil
                ? .unavailable(message: friendlyMessage(error))
                : .stale(lastSuccessAt: predictionLastCacheAt, message: friendlyMessage(error))
        }
    }

    /// Registers the executable week with the server as "handed to the Watch".
    ///
    /// WorkoutKit scheduling is device-side only, so nothing else can tell the
    /// server which prescription the watch received — and the runner syncs
    /// *tomorrow's* session, so the run's own date cannot identify the plan.
    /// Without this receipt the detail page can only fall back to kilometre
    /// splits.
    ///
    /// Returns the failure text for the caller to append, and never touches
    /// `errorMessage`: failing to register a receipt costs segment labels, so it
    /// must not make a sync that already landed look broken.
    ///
    /// `localDates` is the set the bridge **read back** after scheduling, not the
    /// set the mapper believes is schedulable. Those differ: `schedule(_:at:)`
    /// reports no error, so a day can satisfy every local check and still never
    /// reach the watch. Re-deriving the set here would register a day the watch
    /// never received, and the detail page would then label a later run with a
    /// prescription that was never handed over.
    func recordPlanSync(
        _ plan: MobileWorkoutPlanResponse,
        localDates: [String]
    ) async -> String? {
        let scheduled = Set(localDates)
        let days = plan.days.filter { scheduled.contains($0.localDate) }
        guard !days.isEmpty else { return nil }
        guard let baseURL = session.serverURL else { return "服务器地址未配置，课表推送未登记" }
        let token = session.apiToken
        let configuration = configurationID
        let scope = cacheScope
        func isCurrent() -> Bool {
            configuration == configurationID && scope == cacheScope &&
                baseURL == session.serverURL && token == session.apiToken && !Task.isCancelled
        }
        var failures = 0
        for (offset, day) in days.enumerated() {
            guard isCurrent() else {
                // 取消或换了服务器：剩下的日期不会再发出去，但它们同样没有登记
                // 成功，必须计入失败，否则调用方会把整周当成已登记。
                failures += days.count - offset
                break
            }
            do {
                _ = try await api.recordPlanSync(
                    PlanSyncReceipt(
                        localDate: day.localDate,
                        kind: day.kind,
                        revision: plan.planRevision,
                        structure: day.structure
                    ),
                    baseURL: baseURL,
                    token: token
                )
            } catch {
                failures += 1
            }
        }
        guard failures == 0 else {
            return "\(failures) 天的课表推送未能在服务端登记，训练分段可能无法按课表还原"
        }
        return nil
    }

    nonisolated static func planSourceName(_ source: String) -> String {
        switch source {
        case "heuristic": return "规则教练生成"
        case "manual": return "手工计划"
        case "llm": return "历史模型课表"
        default: return "来源未知"
        }
    }

    /// Reports the plan's provenance and the first two adjustment warnings.
    nonisolated static func generationSummary(_ result: MobileWeeklyPlanGenerationResponse) -> String {
        let source = planSourceName(result.audit.generatedBy)
        let quality = result.days.filter { $0.kind == "tempo" || $0.kind == "interval" }.count
        let total = result.days.reduce(0) { $0 + ($1.distanceKm ?? 0) }
        var text = "\(source)：\(result.days.count) 天 / 质量课 \(quality) 堂 / 合计 \(String(format: "%.1f", total)) km。"
        let notes = result.warnings.filter { !$0.isEmpty }.prefix(2)
        if !notes.isEmpty { text += " " + notes.joined(separator: " ") }
        return text
    }

    func clearCache() {
        configurationID = UUID()
        isTodayAvailable = false
        isLoading = false
        isRefreshing = false
        cache.clear(scope: cacheScope)
        clearPresentation()
    }

    private var workoutsCacheKey: String {
        "workouts-\(workoutSessionType ?? "all")"
    }

    private var workoutPlanCacheKey: String { "workout-plan" }

    private func loadCachedData() {
        isTodayAvailable = false
        // 每个 key 只读一次：原先为了拿 cachedAt 又重复读了一遍，10 个 key 变成 20 次查询。
        let cachedToday = cache.read(MobileTodayResponse.self, scope: cacheScope, key: "today")
        let cachedStatistics = cache.read(MobileStatisticsResponse.self, scope: cacheScope, key: "statistics")
        let cachedTrends = cache.read(MobileTrendsResponse.self, scope: cacheScope, key: "trends")
        let cachedGoals = cache.read(MobileGoalsResponse.self, scope: cacheScope, key: "goals")
        if let cachedCoach = cache.read(MobileRunCoachResponse.self, scope: cacheScope, key: "run-coach"),
           cachedCoach.value.revision >= max(currentPlanRevision, cachedGoals?.value.revision ?? 0) {
            runCoach = cachedCoach.value
            minimumPlanRevision = cachedCoach.value.revision
        }
        let cachedPredictions = cache.read(NativePredictionResponse.self, scope: cacheScope, key: "predictions")
        let cachedZones = cache.read(NativeTrainingZonesCurrentResponse.self, scope: cacheScope, key: "training-zones")
        if let cachedToday,
           (cachedToday.value.recommendation.planRevision ?? cachedGoals?.value.revision ?? minimumPlanRevision) >= max(minimumPlanRevision, cachedGoals?.value.revision ?? 0) {
            today = cachedToday.value
        }
        statistics = cachedStatistics?.value
        trends = cachedTrends?.value
        if let cachedGoals, cachedGoals.value.revision >= max(minimumPlanRevision, goals?.revision ?? 0) {
            goals = cachedGoals.value
            minimumPlanRevision = cachedGoals.value.revision
        }
        if let cachedPlan = cache.read(MobileWorkoutPlanResponse.self, scope: cacheScope, key: workoutPlanCacheKey)?.value,
           cachedPlan.planRevision >= minimumPlanRevision {
            workoutPlan = cachedPlan
        }
        predictions = cachedPredictions?.value
        predictionLastCacheAt = cachedPredictions?.cachedAt
        if cachedPredictions != nil {
            predictionLoadState = .stale(
                lastSuccessAt: cachedPredictions?.cachedAt,
                message: "当前显示的是缓存中的预测，等待刷新。"
            )
        }
        dashboard = cache.read(NativeDashboardResponse.self, scope: cacheScope, key: "dashboard")?.value
        trainingZones = cachedZones?.value
        trainingStatistics = cache.read(NativeTrainingStatisticsOverviewResponse.self, scope: cacheScope, key: "training-statistics")?.value
        loadCachedWorkouts()
        // 缓存新鲜度：陈旧数据不隐藏，由 TechFreshnessBanner 显式告知用户，因此这里不设硬 TTL。
        lastCacheUpdate = [
            cachedToday?.cachedAt,
            cachedStatistics?.cachedAt,
            cachedTrends?.cachedAt,
            cachedPredictions?.cachedAt,
            cachedZones?.cachedAt
        ].compactMap { $0 }.max()
    }

    private func prepareCacheScope(for baseURL: URL) {
        let known = Self.loadHandshake(for: baseURL)
        setCacheScope(baseURL: baseURL, handshake: known)
        if goals == nil && today == nil { loadCachedData() }
    }

    private func setCacheScope(baseURL: URL, handshake: RaiHandshake?) {
        let nextScope = CacheStore.scope(baseURL: baseURL, handshake: handshake)
        if nextScope != cacheScope {
            clearPresentation()
        }
        self.handshake = handshake
        cacheScope = nextScope
    }

    private func clearPresentation() {
        workoutRequestID = UUID()
        detailRequestID = UUID()
        invalidatePlanOperations()
        isLoadingWorkouts = false
        isLoadingTrainingStatistics = false
        isLoadingWorkout = false
        isLoadingBodyMetrics = false
        workoutDetailError = nil
        workoutListError = nil
        bodyMetricsError = nil
        isTodayAvailable = false
        today = nil
        statistics = nil
        trends = nil
        goals = nil
        workoutPlan = nil
        workoutPlanError = nil
        runCoach = nil
        runCoachError = nil
        predictions = nil
        dashboard = nil
        trainingZones = nil
        trainingStatistics = nil
        workouts = []
        workoutTotal = 0
        selectedWorkout = nil
        selectedSeries = nil
        predictionLoadState = .unavailable(message: "尚未加载预测")
        predictionLastCacheAt = nil
        lastCacheUpdate = nil
    }

    private func invalidatePlanOperations() {
        invalidatePlanReads()
        saveGoalsRequestID = UUID()
        runCoachRequestID = UUID()
        isUpdatingRunCoach = false
        isLoadingRunCoach = false
        isSavingGoals = false
        isSyncingPlan = false
        planSyncRequestID = UUID()
        minimumPlanRevision = 0
        refreshQueued = false
        refreshHandshakeQueued = false
        lockRequestID = UUID()
        workoutPlanRequestID = UUID()
        regeneratePlanRequestID = UUID()
        isLockingSession = false
        isLoadingWorkoutPlan = false
        isRegeneratingPlan = false
        planMessage = nil
        planPreview = nil
        lastWatchRevision = nil
        lastWatchSyncAt = nil
        lastWatchDays = nil
        lastWatchTimezone = nil
        lastWatchHour = nil
    }

    private func invalidatePlanReads() {
        planMutationEpoch = UUID()
        planRefreshRequestID = UUID()
        workoutPlanRequestID = UUID()
        isLoadingWorkoutPlan = false
        isRefreshingPlan = false
    }

    private func acceptGoals(_ value: MobileGoalsResponse) {
        guard value.revision >= max(minimumPlanRevision, goals?.revision ?? 0) else { return }
        minimumPlanRevision = value.revision
        goals = value
        if runCoach?.revision != value.revision { runCoach = nil }
        recordCache(value, key: "goals")
    }

    /// Writes refresh only their dependent surfaces. Older full-page reads cannot
    /// undo the acknowledgement, and unrelated statistics never delay feedback.
    @discardableResult
    func refreshPlanState() async -> Bool {
        guard let baseURL = session.serverURL else { return false }
        let configuration = configurationID
        let token = session.apiToken
        let mutation = planMutationEpoch
        let requestID = UUID()
        planRefreshRequestID = requestID
        isRefreshingPlan = true
        defer { if requestID == planRefreshRequestID { isRefreshingPlan = false } }
        async let goalRead = api.goals(baseURL: baseURL, token: token)
        async let todayRead = api.today(baseURL: baseURL, token: token)
        async let planRead = api.workoutPlan(baseURL: baseURL, token: token)
        let newGoals = try? await goalRead
        let newToday = try? await todayRead
        let newPlan = try? await planRead
        guard configuration == configurationID, token == session.apiToken,
              baseURL == session.serverURL, mutation == planMutationEpoch,
              requestID == planRefreshRequestID, !Task.isCancelled else { return false }
        if let newGoals { acceptGoals(newGoals) }
        let coherent = newGoals?.revision == goals?.revision && (newGoals?.revision ?? -1) >= minimumPlanRevision &&
            (newToday?.recommendation.planRevision == nil || newToday?.recommendation.planRevision == newGoals?.revision)
        if let newToday, coherent {
            isTodayAvailable = true
            today = newToday
            recordCache(newToday, key: "today")
        } else {
            isTodayAvailable = false
        }
        if let newPlan, newPlan.planRevision >= max(minimumPlanRevision, goals?.revision ?? 0) {
            workoutPlan = newPlan
            workoutPlanError = nil
            recordCache(newPlan, key: workoutPlanCacheKey)
        } else if newPlan == nil {
            workoutPlanError = "当前课表未能刷新，旧课表不会作为最新处方使用。"
        }
        if newGoals != nil { isOffline = false; session.isReachable = true }
        return coherent && newToday != nil && newPlan?.planRevision == goals?.revision
    }

    /// Device scheduling shares the mutation gate with saves and generation.
    func beginPlanSync(allowOffline: Bool = false) -> UUID? {
        guard !isPlanBusy, (allowOffline || !isOffline) else { return nil }
        isSyncingPlan = true
        planSyncRequestID = UUID()
        return planSyncRequestID
    }

    func isCurrentPlanSync(_ id: UUID) -> Bool { id == planSyncRequestID && isSyncingPlan && !Task.isCancelled }
    func endPlanSync(_ id: UUID) { if id == planSyncRequestID { isSyncingPlan = false } }

    private func loadCachedWorkouts() {
        guard let cached = cache.read(WorkoutListResponse.self, scope: cacheScope, key: workoutsCacheKey)?.value else { return }
        workouts = cached.items
        workoutTotal = cached.total
    }

    private func recordCache<Value: Codable>(_ value: Value?, key: String) {
        guard let value else { return }
        if let writtenAt = cache.write(value, scope: cacheScope, key: key) {
            lastCacheUpdate = writtenAt
            if key == "predictions" {
                predictionLastCacheAt = writtenAt
            }
        } else {
            errorMessage = "数据已读取，但离线缓存未能保存。请检查设备存储空间。"
        }
    }

    var feedbackScope: String { cacheScope }
    /// Ephemeral UI ownership, never persisted as a preferences/cache key.
    var feedbackSessionID: String { configurationID.uuidString + cacheScope + session.apiToken }
    private var feedbackBusy = false

    func pendingFeedback(for id: String) -> NativeFeedbackCommand? {
        cache.read(NativeFeedbackPending.self, scope: cacheScope, key: "feedback.pending." + id)?.value.command
    }

    /// Online submissions only; the journal retains the SAME command on a lost reply.
    /// A cache eviction is still safe: expectedRevision prevents a second append.
    func saveFeedback(_ input: NativeWorkoutFeedbackInput) async -> NativeFeedbackOutcome {
        guard !feedbackBusy, !isOffline, let baseURL = session.serverURL else {
            return .pending("连接后才能保存；你的输入仍保留。")
        }
        let scope = cacheScope
        let token = session.apiToken
        let configuration = configurationID
        func isCurrent() -> Bool { scope == cacheScope && configuration == configurationID && token == session.apiToken && !Task.isCancelled }
        let key = "feedback.pending." + input.trainingSessionId
        let retained = pendingFeedback(for: input.trainingSessionId)
        let command = retained ?? NativeFeedbackCommand(idempotencyKey: UUID().uuidString, payload: input)
        guard cache.write(NativeFeedbackPending(command: command), scope: scope, key: key) != nil else {
            return .failed("无法安全保留本次操作，请检查设备空间后重试。尚未提交。")
        }
        feedbackBusy = true
        defer { feedbackBusy = false }
        do {
            var response: NativeCommandResponse
            do {
                response = try await api.submitFeedback(command, baseURL: baseURL, token: token)
            } catch {
                // A rejected enqueue has no business effect; allow correcting the draft.
                if retained == nil, isCurrent(), case let RaiAPIClientError.server(_, _, status) = error, (400..<500).contains(status) {
                    _ = cache.write(NativeFeedbackPending(command: nil), scope: scope, key: key)
                    return .failed(friendlyMessage(error))
                }
                if retained == nil, isCurrent(), case RaiAPIClientError.unauthorized = error {
                    _ = cache.write(NativeFeedbackPending(command: nil), scope: scope, key: key)
                    return .failed(friendlyMessage(error))
                }
                throw error
            }
            guard isCurrent() else { return .pending("连接已切换，原操作结果将在原连接中查询。") }
            for _ in 0..<20 {
                if response.status != "queued" && response.status != "running" { break }
                try await Task.sleep(for: .milliseconds(500))
                guard isCurrent() else { return .pending("请回到原连接查看保存结果。") }
                response = try await api.command(id: response.id, baseURL: baseURL, token: token)
                guard isCurrent() else { return .pending("请回到原连接查看保存结果。") }
            }
            if response.status == "succeeded" {
                _ = cache.write(NativeFeedbackPending(command: nil), scope: scope, key: key)
                var message = "反馈已保存；分析稍后更新。"
                if let jobId = response.result?.jobId, let job = try? await api.job(id: jobId, baseURL: baseURL, token: token) {
                    if job.status == "succeeded" { message = "反馈已保存，分析已更新。" }
                    else if job.status == "failed" { message = "反馈已保存，但分析更新未完成；请稍后检查。" }
                }
                guard isCurrent() else { return .saved("反馈已保存到原连接。") }
                await loadWorkout(id: input.trainingSessionId)
                guard isCurrent() else { return .saved("反馈已保存到原连接。") }
                await refreshAll()
                return .saved(message)
            }
            if response.status == "failed" || response.status == "cancelled" {
                _ = cache.write(NativeFeedbackPending(command: nil), scope: scope, key: key)
                return .failed(response.error?.message ?? "保存未完成，输入仍保留。")
            }
            return .pending("正在保存，请稍后点击检查结果；不必重复填写。")
        } catch {
            return .pending("暂未确认保存结果：" + friendlyMessage(error) + " 重试会查询同一次操作。")
        }
    }

    private func friendlyMessage(_ error: Error) -> String {
        if let error = error as? RaiAPIClientError { return error.localizedDescription }
        if error is CancellationError { return "请求已取消。" }
        return "请求失败，请检查 RAI 服务和网络。"
    }

    private static func loadHandshake(for baseURL: URL) -> RaiHandshake? {
        CacheStore.loadHandshake(baseURL: baseURL)
    }

    private static func storedScheduleHour(scope: String) -> Int {
        let stored = UserDefaults.standard.integer(forKey: "rai.training-reminder." + scope + ".hour")
        return (7...21).contains(stored) ? stored : 8
    }

}

/// The editing rules for the stored week plan, kept outside any skin.
///
/// A skin owns its view code; it does not own its validation. The two skins that
/// existed until 2026-09-18 had grown a byte-identical copy of these bounds, the
/// distance parsing and the "clear the structure when the kind or size changed"
/// rule — which is the same shape of drift that let a 2026-09-13 fix land in one
/// skin only. The rules live here so the off-device regression can pin them
/// once; only the presentation stays in the view layer.
enum NativeGoalWeekDraft {
    static func canEditDistance(_ kind: String) -> Bool {
        ["easy", "recovery", "long_run"].contains(kind)
    }
    /// Above this a single day is a data-entry mistake rather than a workout.
    static let maxDayDistanceKm: Double = 80

    /// Parses a distance field. An empty field is *not* an error: it is how the
    /// editor expresses "no distance set", which the server stores as null.
    static func parsedDistance(_ text: String) -> Double? {
        Double(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func dayDistanceIsValid(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return true }
        return parsedDistance(trimmed).map { $0.isFinite && (0...maxDayDistanceKm).contains($0) } == true
    }

    /// Seeds the per-day text fields from what the server returned.
    static func drafts(from items: [MobileGoalsPlanItem]) -> [String: String] {
        Dictionary(uniqueKeysWithValues: items.map {
            ($0.id, $0.distanceKm.map { String($0) } ?? "")
        })
    }

    static func distancesAreValid(
        _ drafts: [String: String],
        for items: [MobileGoalsPlanItem]
    ) -> Bool {
        items.allSatisfy { !canEditDistance($0.kind) || dayDistanceIsValid(drafts[$0.id] ?? "") }
    }

    /// Applies the edited text fields onto the week before it is sent back.
    ///
    /// A structure belongs to the kind and the size it was generated for. The
    /// editor loads whatever the server returned, so sending it straight back
    /// after the user changed the kind or the distance would pair an old
    /// prescription with a new label; clearing it lets the server rebuild the
    /// prescription from what was actually asked for.
    static func normalized(
        _ items: [MobileGoalsPlanItem],
        drafts: [String: String],
        loaded: [MobileGoalsPlanItem]
    ) -> [MobileGoalsPlanItem] {
        let previous = Dictionary(uniqueKeysWithValues: loaded.map { ($0.localDate, $0) })
        return items.map { item in
            var updated = item
            if updated.kind == "rest" {
                updated.distanceKm = nil
                updated.structure = nil
            } else if canEditDistance(updated.kind) {
                updated.distanceKm = parsedDistance(drafts[item.id] ?? "")
            }
            if let before = previous[item.localDate],
               before.kind != updated.kind || before.distanceKm != updated.distanceKm {
                updated.structure = nil
            }
            return updated
        }
    }
}
#endif
