#if os(iOS)
import Foundation
import Observation

@Observable
@MainActor
final class NativeAppModel {
    let session: ServerSession
    private let api = RaiAPIClient()
    private let cache = CacheStore()

    private(set) var handshake: RaiHandshake?
    private(set) var today: MobileTodayResponse?
    private(set) var statistics: MobileStatisticsResponse?
    private(set) var trends: MobileTrendsResponse?
    private(set) var goals: MobileGoalsResponse?
    private(set) var workouts: [WorkoutListItem] = []
    private(set) var workoutTotal = 0
    private(set) var selectedWorkout: WorkoutDetailResponse?
    private(set) var selectedSeries: WorkoutSeriesResponse?
    private(set) var isLoading = false
    private(set) var isRefreshing = false
    private(set) var isOffline = false
    private(set) var lastCacheUpdate: Date?
    var errorMessage: String?
    var workoutSessionType: String?

    private var cacheScope: String
    private let workoutPageSize = 30

    init(session: ServerSession) {
        self.session = session
        let baseURL = session.serverURL ?? URL(string: "http://invalid")!
        handshake = Self.loadHandshake(for: baseURL)
        cacheScope = CacheStore.scope(baseURL: baseURL, handshake: handshake)
    }

    func bootstrap() async {
        guard !isLoading else { return }
        loadCachedData()
        guard session.serverURL != nil else { return }
        await connect()
    }

    func serverConfigurationChanged() {
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
        guard let baseURL = session.serverURL else {
            errorMessage = RaiAPIClientError.invalidServerAddress.localizedDescription
            return
        }
        prepareCacheScope(for: baseURL)
        isLoading = true
        errorMessage = nil
        do {
            let identity = try await api.handshake(baseURL: baseURL, token: session.apiToken)
            Self.saveHandshake(identity, for: baseURL)
            setCacheScope(baseURL: baseURL, handshake: identity)
            session.isReachable = true
            session.lastError = nil
            await session.probe()
            loadCachedData()
            await refreshAll(requestHandshake: false)
        } catch {
            isOffline = true
            errorMessage = friendlyMessage(error)
            loadCachedData()
        }
        isLoading = false
    }

    func refreshAll(requestHandshake: Bool = true) async {
        guard let baseURL = session.serverURL else { return }
        guard !isRefreshing else { return }
        prepareCacheScope(for: baseURL)
        isRefreshing = true
        errorMessage = nil
        do {
            if requestHandshake {
                let identity = try await api.handshake(baseURL: baseURL, token: session.apiToken)
                Self.saveHandshake(identity, for: baseURL)
                setCacheScope(baseURL: baseURL, handshake: identity)
            }
            today = try await api.today(baseURL: baseURL, token: session.apiToken)
            recordCache(today, key: "today")
            statistics = try await api.statistics(baseURL: baseURL, token: session.apiToken)
            recordCache(statistics, key: "statistics")
            trends = try await api.trends(baseURL: baseURL, token: session.apiToken)
            recordCache(trends, key: "trends")
            goals = try await api.goals(baseURL: baseURL, token: session.apiToken)
            recordCache(goals, key: "goals")
            await refreshWorkouts()
            isOffline = false
            session.isReachable = true
        } catch {
            isOffline = true
            errorMessage = friendlyMessage(error)
            loadCachedData()
        }
        isRefreshing = false
    }

    func refreshWorkouts() async {
        guard let baseURL = session.serverURL else { return }
        do {
            let response = try await api.workouts(
                baseURL: baseURL,
                token: session.apiToken,
                limit: workoutPageSize,
                offset: 0,
                sessionType: workoutSessionType
            )
            workouts = response.items
            workoutTotal = response.total
            recordCache(response, key: workoutsCacheKey)
            isOffline = false
        } catch {
            errorMessage = friendlyMessage(error)
            loadCachedWorkouts()
        }
    }

    func loadMoreWorkouts() async {
        guard let baseURL = session.serverURL,
              !isRefreshing,
              workouts.count < workoutTotal else { return }
        isRefreshing = true
        let nextOffset = workouts.count
        do {
            let response = try await api.workouts(
                baseURL: baseURL,
                token: session.apiToken,
                limit: workoutPageSize,
                offset: nextOffset,
                sessionType: workoutSessionType
            )
            let existing = Set(workouts.map(\.id))
            workouts.append(contentsOf: response.items.filter { !existing.contains($0.id) })
            workoutTotal = response.total
            recordCache(
                WorkoutListResponse(items: workouts, total: response.total, limit: response.limit, offset: 0),
                key: workoutsCacheKey
            )
        } catch {
            errorMessage = friendlyMessage(error)
        }
        isRefreshing = false
    }

    func loadWorkout(id: String) async {
        guard let baseURL = session.serverURL else { return }
        if selectedWorkout?.workout.id == id { return }
        do {
            selectedWorkout = try await api.workoutDetail(id: id, baseURL: baseURL, token: session.apiToken)
            recordCache(selectedWorkout, key: "workout-detail-\(id)")
            do {
                selectedSeries = try await api.workoutSeries(id: id, baseURL: baseURL, token: session.apiToken)
                recordCache(selectedSeries, key: "workout-series-\(id)")
            } catch {
                selectedSeries = cache.read(WorkoutSeriesResponse.self, scope: cacheScope, key: "workout-series-\(id)")?.value
            }
        } catch {
            selectedWorkout = cache.read(WorkoutDetailResponse.self, scope: cacheScope, key: "workout-detail-\(id)")?.value
            selectedSeries = cache.read(WorkoutSeriesResponse.self, scope: cacheScope, key: "workout-series-\(id)")?.value
            errorMessage = friendlyMessage(error)
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
                token: session.apiToken
            )
            goals = updated
            recordCache(updated, key: "goals")
            await refreshAll(requestHandshake: false)
            return true
        } catch {
            errorMessage = friendlyMessage(error)
            if case RaiAPIClientError.server(let code, _, _) = error, code == "mobile_goals_revision_conflict" {
                goals = try? await api.goals(baseURL: baseURL, token: session.apiToken)
            }
            return false
        }
    }

    func lockNextSession(relock: Bool = false) async -> Bool {
        guard let baseURL = session.serverURL, let current = today else { return false }
        do {
            let updated = try await api.lockSession(
                LockMobileSessionRequest(action: relock ? "relock" : "lock", expectedRevision: current.recommendationRevision),
                baseURL: baseURL,
                token: session.apiToken
            )
            goals = updated
            recordCache(updated, key: "goals")
            today = try await api.today(baseURL: baseURL, token: session.apiToken)
            recordCache(today, key: "today")
            return true
        } catch {
            errorMessage = friendlyMessage(error)
            return false
        }
    }

    func clearCache() {
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
        loadCachedWorkouts()
        lastCacheUpdate = [
            cache.read(MobileTodayResponse.self, scope: cacheScope, key: "today")?.cachedAt,
            cache.read(MobileStatisticsResponse.self, scope: cacheScope, key: "statistics")?.cachedAt,
            cache.read(MobileTrendsResponse.self, scope: cacheScope, key: "trends")?.cachedAt
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
        today = nil
        statistics = nil
        trends = nil
        goals = nil
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
