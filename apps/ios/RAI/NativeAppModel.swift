#if os(iOS)
import Foundation
import Observation

@Observable
@MainActor
final class NativeAppModel {
    let session: ServerSession
    private let api: RaiAPIClient
    private let cache = CacheStore()

    private(set) var handshake: RaiHandshake?
    private(set) var today: MobileTodayResponse?
    private(set) var statistics: MobileStatisticsResponse?
    private(set) var trends: MobileTrendsResponse?
    private(set) var goals: MobileGoalsResponse?
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
    private(set) var lastCacheUpdate: Date?
    var errorMessage: String?
    private(set) var isLoadingWorkouts = false
    private(set) var isLoadingTrainingStatistics = false
    private(set) var isLoadingWorkout = false
    private(set) var isLoadingBodyMetrics = false
    private(set) var workoutDetailError: String?
    private(set) var bodyMetricsError: String?
    private(set) var isLockingSession = false
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

    private var configurationID = UUID()
    private var cacheScope: String
    private let workoutPageSize = 30

    init(session: ServerSession, api: RaiAPIClient? = nil) {
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
        isLoading = false
        isRefreshing = false
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
            Self.saveHandshake(identity, for: baseURL)
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
        guard !isRefreshing else { return }
        let configuration = configurationID
        let token = session.apiToken
        func isCurrent() -> Bool {
            configuration == configurationID && baseURL == session.serverURL &&
                token == session.apiToken && !Task.isCancelled
        }
        prepareCacheScope(for: baseURL)
        isRefreshing = true
        defer { if configuration == configurationID { isRefreshing = false } }
        errorMessage = nil
        do {
            if requestHandshake {
                let identity = try await api.handshake(baseURL: baseURL, token: token)
                guard isCurrent() else { return }
                Self.saveHandshake(identity, for: baseURL)
                setCacheScope(baseURL: baseURL, handshake: identity)
            }
            let fetchedToday = try await api.today(baseURL: baseURL, token: token)
            guard isCurrent() else { return }
            today = fetchedToday
            recordCache(today, key: "today")
            let fetchedStatistics = try await api.statistics(baseURL: baseURL, token: token)
            guard isCurrent() else { return }
            statistics = fetchedStatistics
            recordCache(statistics, key: "statistics")
            let fetchedTrends = try await api.trends(baseURL: baseURL, token: token)
            guard isCurrent() else { return }
            trends = fetchedTrends
            recordCache(trends, key: "trends")
            let fetchedGoals = try await api.goals(baseURL: baseURL, token: token)
            guard isCurrent() else { return }
            goals = fetchedGoals
            recordCache(goals, key: "goals")
            let workoutsSucceeded = await refreshWorkouts()
            guard isCurrent() else { return }
            isOffline = !workoutsSucceeded
            session.isReachable = workoutsSucceeded
        } catch {
            guard isCurrent() else { return }
            isOffline = true
            errorMessage = friendlyMessage(error)
            loadCachedData()
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
            errorMessage = friendlyMessage(error)
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
            errorMessage = friendlyMessage(error)
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
        weeklyDistanceKm: Double,
        easyDurationFloorFraction: Double,
        qualitySessionCap: Int,
        weekPlan: [MobileGoalsPlanItem]
    ) async -> Bool {
        guard let baseURL = session.serverURL, let current = goals else {
            errorMessage = "请先连接 RAI 服务。"
            return false
        }
        let configuration = configurationID
        let token = session.apiToken
        func isCurrent() -> Bool {
            configuration == configurationID && baseURL == session.serverURL && token == session.apiToken
        }
        do {
            let updated = try await api.updateGoals(
                UpdateMobileGoalsRequest(
                    expectedRevision: current.revision,
                    weeklyDistanceKm: weeklyDistanceKm,
                    easyDurationFloorFraction: easyDurationFloorFraction,
                    qualitySessionCap: qualitySessionCap,
                    raceTarget: current.raceTarget,
                    weekPlan: weekPlan
                ),
                baseURL: baseURL,
                token: token
            )
            guard isCurrent() else { return false }
            goals = updated
            recordCache(updated, key: "goals")
            await refreshAll(requestHandshake: false)
            return true
        } catch {
            guard isCurrent() else { return false }
            errorMessage = friendlyMessage(error)
            if case RaiAPIClientError.server(let code, _, _) = error, code == "mobile_goals_revision_conflict" {
                if let latest = try? await api.goals(baseURL: baseURL, token: token), isCurrent() {
                    goals = latest
                    recordCache(latest, key: "goals")
                }
            }
            return false
        }
    }

    func lockNextSession(relock: Bool = false) async -> Bool {
        guard !isLockingSession, !isOffline,
              let baseURL = session.serverURL, let current = today else { return false }
        isLockingSession = true
        defer { isLockingSession = false }
        let configuration = configurationID
        let token = session.apiToken
        func isCurrent() -> Bool {
            configuration == configurationID && baseURL == session.serverURL && token == session.apiToken
        }
        do {
            let updated = try await api.lockSession(
                LockMobileSessionRequest(action: relock ? "relock" : "lock", expectedRevision: current.recommendationRevision),
                baseURL: baseURL,
                token: token
            )
            guard isCurrent() else { return false }
            goals = updated
            recordCache(updated, key: "goals")
            do {
                let latest = try await api.today(baseURL: baseURL, token: token)
                guard isCurrent() else { return true }
                today = latest
                recordCache(latest, key: "today")
            } catch {
                guard isCurrent() else { return true }
                errorMessage = "课程已锁定，但今日数据未能刷新。请刷新页面，不必重复锁定。"
            }
            return true
        } catch {
            guard isCurrent() else { return false }
            errorMessage = friendlyMessage(error)
            return false
        }
    }

    func clearCache() {
        configurationID = UUID()
        isLoading = false
        isRefreshing = false
        cache.clear(scope: cacheScope)
        clearPresentation()
    }

    private var workoutsCacheKey: String {
        "workouts-\(workoutSessionType ?? "all")"
    }

    private func loadCachedData() {
        today = cache.read(MobileTodayResponse.self, scope: cacheScope, key: "today")?.value
        statistics = cache.read(MobileStatisticsResponse.self, scope: cacheScope, key: "statistics")?.value
        trends = cache.read(MobileTrendsResponse.self, scope: cacheScope, key: "trends")?.value
        goals = cache.read(MobileGoalsResponse.self, scope: cacheScope, key: "goals")?.value
        predictions = cache.read(NativePredictionResponse.self, scope: cacheScope, key: "predictions")?.value
        dashboard = cache.read(NativeDashboardResponse.self, scope: cacheScope, key: "dashboard")?.value
        trainingZones = cache.read(NativeTrainingZonesCurrentResponse.self, scope: cacheScope, key: "training-zones")?.value
        trainingStatistics = cache.read(NativeTrainingStatisticsOverviewResponse.self, scope: cacheScope, key: "training-statistics")?.value
        loadCachedWorkouts()
        lastCacheUpdate = [
            cache.read(MobileTodayResponse.self, scope: cacheScope, key: "today")?.cachedAt,
            cache.read(MobileStatisticsResponse.self, scope: cacheScope, key: "statistics")?.cachedAt,
            cache.read(MobileTrendsResponse.self, scope: cacheScope, key: "trends")?.cachedAt
            , cache.read(NativePredictionResponse.self, scope: cacheScope, key: "predictions")?.cachedAt
            , cache.read(NativeTrainingZonesCurrentResponse.self, scope: cacheScope, key: "training-zones")?.cachedAt
        ].compactMap { $0 }.max()
    }

    private func prepareCacheScope(for baseURL: URL) {
        let known = Self.loadHandshake(for: baseURL)
        setCacheScope(baseURL: baseURL, handshake: known)
        loadCachedData()
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
        isLoadingWorkouts = false
        isLoadingTrainingStatistics = false
        isLoadingWorkout = false
        isLoadingBodyMetrics = false
        workoutDetailError = nil
        bodyMetricsError = nil
        today = nil
        statistics = nil
        trends = nil
        goals = nil
        predictions = nil
        dashboard = nil
        trainingZones = nil
        trainingStatistics = nil
        workouts = []
        workoutTotal = 0
        selectedWorkout = nil
        selectedSeries = nil
        lastCacheUpdate = nil
    }

    private func loadCachedWorkouts() {
        guard let cached = cache.read(WorkoutListResponse.self, scope: cacheScope, key: workoutsCacheKey)?.value else { return }
        workouts = cached.items
        workoutTotal = cached.total
    }

    private func recordCache<Value: Codable>(_ value: Value?, key: String) {
        guard let value else { return }
        lastCacheUpdate = cache.write(value, scope: cacheScope, key: key)
    }

    private func friendlyMessage(_ error: Error) -> String {
        if let error = error as? RaiAPIClientError { return error.localizedDescription }
        if error is CancellationError { return "请求已取消。" }
        return "请求失败，请检查 RAI 服务和网络。"
    }

    private static func handshakeKey(for baseURL: URL) -> String {
        "rai.handshake.\(CacheStore.urlScope(baseURL: baseURL))"
    }

    private static func loadHandshake(for baseURL: URL) -> RaiHandshake? {
        guard let data = UserDefaults.standard.data(forKey: handshakeKey(for: baseURL)) else { return nil }
        return try? JSONDecoder().decode(RaiHandshake.self, from: data)
    }

    private static func saveHandshake(_ handshake: RaiHandshake, for baseURL: URL) {
        guard let data = try? JSONEncoder().encode(handshake) else { return }
        UserDefaults.standard.set(data, forKey: handshakeKey(for: baseURL))
    }
}
#endif
