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
    private(set) var workoutPlan: MobileWorkoutPlanResponse?
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
    private(set) var isLoadingWorkoutPlan = false
    private(set) var isRegeneratingPlan = false
    /// Human-readable result of the last plan generation, including fallbacks.
    var planMessage: String?
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
        if requestHandshake {
            // 握手是整页可用性的前置条件：拿不到身份就没有可用的数据域，这时
            // 回退缓存是对的，因为没有任何面板拿到过新数据。
            do {
                let identity = try await api.handshake(baseURL: baseURL, token: token)
                guard isCurrent() else { return }
                Self.saveHandshake(identity, for: baseURL)
                setCacheScope(baseURL: baseURL, handshake: identity)
            } catch {
                guard isCurrent() else { return }
                isOffline = true
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
        if let fetchedToday {
            today = fetchedToday
            recordCache(fetchedToday, key: "today")
        } else {
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
            goals = fetchedGoals
            recordCache(fetchedGoals, key: "goals")
        } else {
            failedPanels += 1
        }
        // Non-fatal: the executable week is a convenience, and a failure here
        // must not mark the whole refresh as offline.
        if let fetchedPlan = try? await api.workoutPlan(baseURL: baseURL, token: token) {
            guard isCurrent() else { return }
            workoutPlan = fetchedPlan
            recordCache(fetchedPlan, key: workoutPlanCacheKey)
        }
        let workoutsSucceeded = await refreshWorkouts()
        guard isCurrent() else { return }
        // 离线的判据只认训练列表这个探针：它答了就说明服务是活的，此时哪怕四个
        // 面板全挂，也应该是「这几项坏了」而不是「整页离线」。
        isOffline = !workoutsSucceeded
        session.isReachable = workoutsSucceeded
        if failedPanels > 0 {
            // 刻意不在这里 `loadCachedData()`：那会把刚刚成功的那几项也推回旧值，
            // 等于用一次部分失败抹掉一次部分成功。首启的空态由 `bootstrap()`
            // 的 `loadCachedData()` 兜底。
            errorMessage = failedPanels == 4
                ? "核心数据均未能更新，当前显示的是上次结果。"
                : "有 \(failedPanels) 项数据未能更新，其余已刷新。"
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
        guard let current = goals else { return false }
        return await persistGoals(UpdateMobileGoalsRequest(
            expectedRevision: current.revision,
            weeklyDistanceKm: weeklyDistanceKm,
            easyDurationFloorFraction: easyDurationFloorFraction,
            qualitySessionCap: qualitySessionCap,
            raceTarget: current.raceTarget,
            weekPlan: weekPlan
        ))
    }

    /// Only changes the race target; omitted weekly-plan fields remain untouched.
    func saveRaceTarget(_ target: MobileRaceTarget?, expectedRevision: Int) async -> Bool {
        guard let current = goals else { return false }
        return await persistGoals(UpdateMobileGoalsRequest(
            expectedRevision: expectedRevision,
            weeklyDistanceKm: current.weeklyDistanceKm,
            easyDurationFloorFraction: nil,
            qualitySessionCap: nil,
            raceTarget: target,
            weekPlan: nil
        ))
    }

    private func persistGoals(_ request: UpdateMobileGoalsRequest) async -> Bool {
        guard !isOffline, let baseURL = session.serverURL else {
            errorMessage = "请先连接 RAI 服务。"
            return false
        }
        let configuration = configurationID
        let token = session.apiToken
        func isCurrent() -> Bool {
            configuration == configurationID && baseURL == session.serverURL &&
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
        func isCurrent() -> Bool {
            requestID == workoutPlanRequestID && configuration == configurationID && baseURL == session.serverURL &&
                token == session.apiToken && !Task.isCancelled
        }
        isLoadingWorkoutPlan = true
        defer {
            if requestID == workoutPlanRequestID, configuration == configurationID {
                isLoadingWorkoutPlan = false
            }
        }
        do {
            let fetched = try await api.workoutPlan(baseURL: baseURL, token: token)
            guard isCurrent() else { return false }
            workoutPlan = fetched
            recordCache(fetched, key: workoutPlanCacheKey)
            return true
        } catch {
            guard isCurrent() else { return false }
            if workoutPlan == nil {
                workoutPlan = cache.read(MobileWorkoutPlanResponse.self, scope: cacheScope, key: workoutPlanCacheKey)?.value
            }
            return false
        }
    }

    /// Replaces the stored week with a freshly generated one. The server falls
    /// back to its heuristic template when the model is unavailable, so this
    /// always leaves a usable week behind — the message says which one it was.
    @discardableResult
    func regenerateWeeklyPlan() async -> Bool {
        guard !isRegeneratingPlan, let baseURL = session.serverURL else { return false }
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
                goals = latest
                recordCache(latest, key: "goals")
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
            let result = try await api.generateWeeklyPlan(
                GenerateWeeklyPlanRequest(expectedRevision: revision),
                baseURL: baseURL,
                token: token
            )
            guard isCurrent() else { return false }
            planMessage = Self.generationSummary(result)
            // `refreshAll` already re-reads the executable week, so a separate
            // workout-plan fetch here would only duplicate the request.
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
                planMessage = "训练目标已在别处更新，请重新生成本周课表。"
            }
            return false
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

    /// Turns a generation result into one honest sentence, including the reason
    /// it fell back to the deterministic template.
    ///
    /// Two warnings are shown, not one: the first explains where the plan came
    /// from and the second is usually that an existing plan was overwritten —
    /// dropping either would hide something the runner needs to know.
    nonisolated static func generationSummary(_ result: MobileWeeklyPlanGenerationResponse) -> String {
        let source = result.audit.generatedBy == "llm"
            ? "大模型生成（\(result.audit.model ?? "未标注模型")）"
            : "已回退到保守模板"
        let quality = result.days.filter { $0.kind == "tempo" || $0.kind == "interval" }.count
        let total = result.days.reduce(0) { $0 + ($1.distanceKm ?? 0) }
        var text = "\(source)：\(result.days.count) 天 / 质量课 \(quality) 堂 / 合计 \(String(format: "%.1f", total)) km。"
        let notes = result.warnings.filter { !$0.isEmpty }.prefix(2)
        if !notes.isEmpty { text += " " + notes.joined(separator: " ") }
        return text
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

    private var workoutPlanCacheKey: String { "workout-plan" }

    private func loadCachedData() {
        // 每个 key 只读一次：原先为了拿 cachedAt 又重复读了一遍，10 个 key 变成 20 次查询。
        let cachedToday = cache.read(MobileTodayResponse.self, scope: cacheScope, key: "today")
        let cachedStatistics = cache.read(MobileStatisticsResponse.self, scope: cacheScope, key: "statistics")
        let cachedTrends = cache.read(MobileTrendsResponse.self, scope: cacheScope, key: "trends")
        let cachedGoals = cache.read(MobileGoalsResponse.self, scope: cacheScope, key: "goals")
        let cachedPredictions = cache.read(NativePredictionResponse.self, scope: cacheScope, key: "predictions")
        let cachedZones = cache.read(NativeTrainingZonesCurrentResponse.self, scope: cacheScope, key: "training-zones")
        today = cachedToday?.value
        statistics = cachedStatistics?.value
        trends = cachedTrends?.value
        goals = cachedGoals?.value
        workoutPlan = cache.read(MobileWorkoutPlanResponse.self, scope: cacheScope, key: workoutPlanCacheKey)?.value
        predictions = cachedPredictions?.value
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
        invalidatePlanOperations()
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
        workoutPlan = nil
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

    private func invalidatePlanOperations() {
        lockRequestID = UUID()
        workoutPlanRequestID = UUID()
        regeneratePlanRequestID = UUID()
        isLockingSession = false
        isLoadingWorkoutPlan = false
        isRegeneratingPlan = false
        planMessage = nil
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

/// The editing rules for the stored week plan, kept outside any skin.
///
/// A skin owns its view code; it does not own its validation. The two skins that
/// existed until 2026-09-18 had grown a byte-identical copy of these bounds, the
/// distance parsing and the "clear the structure when the kind or size changed"
/// rule — which is the same shape of drift that let a 2026-09-13 fix land in one
/// skin only. The rules live here so the off-device regression can pin them
/// once; only the presentation stays in the view layer.
enum NativeGoalWeekDraft {
    static let minWeeklyDistanceKm: Double = 1
    static let maxWeeklyDistanceKm: Double = 500
    /// Above this a single day is a data-entry mistake rather than a workout.
    static let maxDayDistanceKm: Double = 80

    /// Parses a distance field. An empty field is *not* an error: it is how the
    /// editor expresses "no distance set", which the server stores as null.
    static func parsedDistance(_ text: String) -> Double? {
        Double(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    static func weeklyDistanceIsValid(_ text: String) -> Bool {
        parsedDistance(text).map {
            $0.isFinite && (minWeeklyDistanceKm...maxWeeklyDistanceKm).contains($0)
        } ?? false
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
        items.allSatisfy { dayDistanceIsValid(drafts[$0.id] ?? "") }
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
            updated.distanceKm = parsedDistance(drafts[item.id] ?? "")
            if let before = previous[item.localDate],
               before.kind != updated.kind || before.distanceKm != updated.distanceKm {
                updated.structure = nil
            }
            return updated
        }
    }
}
#endif
