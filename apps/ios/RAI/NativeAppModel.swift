#if os(iOS)
import Foundation
import Observation

@Observable
@MainActor
final class NativeAppModel {
    let session: ServerSession
    private let api: RaiAPIClient
    private let now: () -> Date
    private let cache: CacheStore
    let trainingPlanStore: TrainingPlanStore

    private(set) var handshake: RaiHandshake?
    var today: MobileTodayResponse? { trainingPlanStore.today }
    private(set) var statistics: MobileStatisticsResponse?
    private(set) var trends: MobileTrendsResponse?
    var goals: MobileGoalsResponse? { trainingPlanStore.goals }
    var workoutPlan: MobileWorkoutPlanResponse? { trainingPlanStore.workoutPlan }
    var runCoach: MobileRunCoachResponse? { trainingPlanStore.coach }
    var coachLoop: CoachLoopResponse? { trainingPlanStore.coachLoop }

    /// 读取面板的单次结果分类（2026-10-15 审查 🟡-B2/B3）：
    /// `decoding` = 契约漂移（服务端可达、载荷解不开），`validation` = 服务端数据
    /// 通过了协议形状但安全字段不可信（2026-10-18 审查 P2-8，绝不能提示升级 App），
    /// `failure` = 其余（网络/服务端）。
    enum ReadPanelOutcome: Equatable { case ok, decoding, validation, failure }

    /// 读取面板失败类别的**纯**归并（2026-10-18 深度审查 P3-26）。
    ///
    /// 为什么抽出来：`isOffline` / "提示升级应用" / "安全校验失败" 这三个结论此前是
    /// `refresh()` 里三个内联布尔，而 P3-26 的缺陷正是"`decodingOnly` 没排除 `.validation`"
    /// —— 内联布尔没有任何可执行判据盯着（`ModelRegression` 也测不到）。归并规则集中在这里，
    /// 行为由回归逐组合钉住。
    ///
    /// 语义（与旧行为逐条对齐，除 P3-26 修正的那一条）：
    /// - `anySucceeded`：至少一项成功；
    /// - `serverAnswered`：没有任何 `.failure` ⇒ 服务端答复过（内容不可用也不算离线；
    ///   全部成功时**真空为真**，与"离线"判据 `!anySucceeded && !serverAnswered` 自洽）；
    /// - `decodingOnly`：**只有**解码失败（`.validation` 不计入 —— 那是"数据不可信"而非
    ///   "格式不认识"，提示用户升级 App 既不解决问题也会误导排查）；
    /// - `validationOnly`：含 `.validation` 且其余失败项也都是 `.validation`。
    struct ReadPanelTally: Equatable {
        let failed: Int
        let anySucceeded: Bool
        let serverAnswered: Bool
        let decodingOnly: Bool
        let validationOnly: Bool

        static func of(_ outcomes: [ReadPanelOutcome]) -> ReadPanelTally {
            let failed = outcomes.filter { $0 != .ok }
            return ReadPanelTally(
                failed: failed.count,
                anySucceeded: outcomes.contains { $0 == .ok },
                serverAnswered: outcomes.allSatisfy { $0 != .failure },
                decodingOnly: !failed.isEmpty && outcomes.allSatisfy { $0 == .ok || $0 == .decoding },
                validationOnly: failed.contains(.validation) && outcomes.allSatisfy { $0 == .ok || $0 == .validation }
            )
        }
    }
    var isCoachLoopManaged: Bool { coachLoop?.settings != nil }
    /// 2026-10-18（审查 P2-9）：能力协商**单源**。
    ///
    /// `TrainingPlanStore.refresh` 以 `coachLoopContractVersion` 决定是否走新教练合同
    /// （与是否宣告快照契约无关）；门面若再按 `planSnapshotContractVersion` 单独分叉，
    /// "coachLoop=1 且无 snapshot"的错峰组合会在同一次刷新里混读新旧教练合同。
    /// 因此凡是"是否需要完整计划读取"的判断，统一看 `usesIntegratedPlanContract`。
    private var usesCoachLoopContract: Bool { handshake?.coachLoopContractVersion != nil }
    private var usesAggregatePlanSnapshot: Bool { handshake?.planSnapshotContractVersion != nil }
    var usesIntegratedPlanContract: Bool { usesCoachLoopContract || usesAggregatePlanSnapshot }

    /// 训练页只有一个入口，页面形态由**服务端能力**决定，不是用户选择。
    ///
    /// 宣告教练闭环合同的服务器使用统一模式页（持续训练/比赛备赛由模式派生）；
    /// 老服务器继续用旧页面，否则它会既没有统一状态也没有可用的写入协议。这里
    /// 没有"旧教练 vs 新教练"的选择器 —— 用户看不到两个引擎，也不会被要求
    /// "先结束一个再创建另一个"。
    var usesUnifiedTrainingPage: Bool { usesCoachLoopContract || isCoachLoopManaged }

    /// 统一训练页的纯展示状态（判定全部在 `TrainingPlanUnifiedPolicy`）。
    var trainingPlanUnifiedView: TrainingPlanUnifiedView {
        TrainingPlanUnifiedPolicy.view(
            snapshot: trainingPlanStore.unified,
            issue: trainingPlanStore.unifiedIssue,
            isRefreshing: trainingPlanStore.isRefreshingUnified,
            isReferenceOnly: trainingPlanStore.unified != nil && !trainingPlanStore.unifiedIsCurrent,
            deviceCoordinationPending: hasPendingPlanReceipts || hasInterruptedSchedule || scheduleStorageIssue,
            now: now()
        )
    }
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
    /// 2026-10-18（事故复盘 P0-3）：当前打开训练的**补齐状态**
    /// （`GET /v1/workouts/:id/freshness`：facts / analysis / series[].state / completeness）。
    ///
    /// 与 detail/series **并行**取，一起失效；**刻意不落缓存** —— 它描述的是"此刻还在补
    /// 什么"，缓存它只会让一份过期的"已完整"冒充现状，而那正是这次事故里用户看到的假话。
    private(set) var selectedFreshness: WorkoutFreshnessResponse?
    private(set) var isLoading = false
    private(set) var isRefreshing = false
    private(set) var isOffline = false
    private(set) var isTodayAvailable: Bool {
        get { trainingPlanStore.isCurrent }
        set {
            guard !newValue else { return }
            // 2026-10-18（事故复盘 P0-3）：store 被作废时，在飞的计划读同样失效，
            // 否则下一次刷新会复用一个注定被 store 拒绝的读。
            cancelInFlightPlanRefresh()
            trainingPlanStore.invalidate()
        }
    }
    var canConfirmToday: Bool {
        guard let today else { return false }
        return hasKnownCurrentCoachState && !planPersistenceFailed &&
            today.recommendation.planRevision == currentPlanRevision && isTodayAvailable &&
            UserDataNoticePolicy.isCurrentDay(today.today.localDate, timezone: today.timezone, now: now())
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
    var isLoadingWorkoutPlan: Bool { trainingPlanStore.isRefreshing }
    private(set) var workoutPlanError: String?
    private(set) var isRegeneratingPlan = false
    private(set) var isSavingGoals = false
    var isRefreshingPlan: Bool { trainingPlanStore.isRefreshing }
    private(set) var isSyncingPlan = false
    private var planMutationEpoch = UUID()
    private var saveGoalsRequestID = UUID()
    private var refreshQueued = false
    private var refreshHandshakeQueued = false
    /// 2026-10-18（事故复盘 P0-3）：计划读的单飞句柄。
    ///
    /// `refreshPlanState` 是客户端唯一会触发 coach-loop 重计算的入口（服务端实测
    /// 13.4s/条，且与所有读共用一条主线程）。同一时刻只允许一条在飞，重复调用复用
    /// 它的结果而不是再发一条教练闭环读。`cancelInFlightPlanRefresh()` 在配置/身份/
    /// 计划代次变化时取消它并清句柄，避免旧 scope 的结果写回或被下一次刷新复用。
    private var planRefreshTask: Task<Bool, Never>?
    private var planRefreshID: UUID?
    /// v2 统一训练状态读的单飞句柄（与执行快照读分开）。
    ///
    /// 两条读的成功标准不同（见 `TrainingPlanStore.refreshUnifiedPlan`），所以各自
    /// 单飞、各自取消。页面可能同时触发 `.task` 与 `.refreshable`，复用同一份在飞
    /// 结果，避免把一次页面出现放大成两条读。
    private var unifiedRefreshTask: Task<Bool, Never>?
    private var unifiedRefreshID: UUID?
    /// 训练列表读的"新请求取消旧请求"句柄与代次：旧任务被取消后既不写结果，
    /// 也不清 `isLoadingWorkouts`（见 `refreshWorkouts`）。
    private var workoutRefreshTask: Task<Bool, Never>?
    private var workoutReadGeneration = 0
    var isPlanBusy: Bool { isSavingGoals || isLockingSession || isRegeneratingPlan || isSyncingPlan || isUpdatingRunCoach }
    var currentPlanRevision: Int { trainingPlanStore.revision }
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
        trainingPlanStore.executablePlan
    }

    private var hasKnownCurrentCoachState: Bool {
        trainingPlanStore.knownCoachState
    }

    /// True when the last Watch acknowledgement refers to a plan that is no
    /// longer current. This is intentionally independent of connectivity: a
    /// stale local Watch schedule can be withdrawn without fetching a new plan.
    var watchNeedsClear: Bool {
        watchLedger != nil && (watchLedger?.scope != cacheScope || currentWorkoutPlan == nil || watchNeedsUpdate)
    }

    func watchPlanNeedsUpdate(_ plan: MobileWorkoutPlanResponse?) -> Bool {
        if let token = isCoachLoopManaged ? coachLoop?.executionToken : trainingPlanStore.metadata?.coherenceToken,
           let ledger = watchLedger, ledger.coherenceToken != token { return true }
        guard let revision = lastWatchRevision else {
            guard let ledger = watchLedger else { return false }
            guard let plan else { return !ledger.entries.isEmpty }
            return ledger.scope != cacheScope || ledger.revision != currentPlanRevision ||
                ledger.revision != plan.planRevision || ledger.requiresWithdrawal == true ||
                ledger.fingerprint != PlanFingerprint.make(days: plan.days, timezone: plan.timezone,
                    hour: Self.storedScheduleHour(scope: cacheScope), completed: completedWeekDates)
        }
        guard let plan else { return true }
        return currentPlanRevision != revision || plan.planRevision != revision ||
            PlanFingerprint.make(days: plan.days, timezone: plan.timezone, hour: Self.storedScheduleHour(scope: cacheScope), completed: completedWeekDates) !=
            PlanFingerprint.make(days: lastWatchDays ?? [], timezone: lastWatchTimezone ?? "", hour: lastWatchHour ?? -1, completed: lastWatchCompleted ?? [])
    }
    var workoutSessionType: String? {
        didSet {
            guard oldValue != workoutSessionType else { return }
            workoutRequestID = UUID()
            // 2026-10-18（事故复盘 P0-3）：筛选切换就是"新请求"——旧列表读必须真正
            // 取消（只换 requestID 挡得住结果，挡不住还在服务端排队的那条网络请求）。
            cancelWorkoutReads()
            isLoadingWorkouts = false
            workouts = []
            workoutTotal = 0
            loadCachedWorkouts()
        }
    }
    private var workoutRequestID = UUID()
    private var detailRequestID = UUID()
    /// 2026-10-18（事故复盘 P0-6）：打开会话的自动重取句柄（350ms 合并窗口）。
    ///
    /// 一次同步成功可能连着改两次 `dataUpdatedGeneration`（本批 + 回前台补刷），
    /// 而每次重取是三条接口；句柄让同一波里的第二次调用复用第一次的结果，
    /// 不把 burst 变成 N 倍读。
    private var openWorkoutReloadTask: Task<Bool, Never>?
    private var openWorkoutReloadID: UUID?
    private var lockRequestID = UUID()
    private var regeneratePlanRequestID = UUID()
    private var planSyncRequestID = UUID()
    private var planSyncBaseURL: URL?
    private var planSyncToken = ""
    var planPersistenceFailed: Bool { trainingPlanStore.persistenceFailed }
    var planWriteAcknowledgement: PlanWriteAcknowledgement? { trainingPlanStore.acknowledgement }
    private(set) var watchLedger: PlanWatchLedger?
    private(set) var watchState: PlanWatchState = .unknown
    private var lastWatchCompleted: Set<String>?
    private(set) var interruptedSchedule: PlanScheduleOperationJournal?
    private(set) var scheduleStorageIssue = false

    /// Dates `/v1/mobile/today` reports as already trained.
    ///
    /// `/v1/mobile/workout-plan` carries those same dates as prescriptions, so
    /// the week panel has to be told which rows are history rather than work
    /// still owed. Not a view decision — the rule lives here, not in a skin.
    var completedWeekDates: Set<String> {
        Set((today?.weekPlan ?? []).compactMap { $0.completedWorkoutId != nil ? $0.localDate : nil })
    }

    /// 2026-10-18（审查 P2-10）：训练提醒的唯一输入。旧实现直接传
    /// `currentWorkoutPlan` + `canConfirmToday`，而教练闭环下 `today == nil`
    /// ⇒ 永远不排程。这里显式区分两种合同，并由纯函数决定权威计划与可用性。
    var reminderContext: TrainingReminderContext {
        TrainingReminderPolicy.context(
            isCurrent: trainingPlanStore.isCurrent,
            persistenceFailed: planPersistenceFailed,
            legacyToday: today,
            legacyPlan: currentWorkoutPlan,
            completedDates: completedWeekDates,
            coachLoop: coachLoop,
            now: now()
        )
    }

    private var configurationID = UUID()
    private var cacheScope: String
    private let workoutPageSize = 30

    init(session: ServerSession, api: RaiAPIClient? = nil, now: @escaping () -> Date = Date.init) {
        self.now = now
        let resolvedAPI = api ?? RaiAPIClient()
        let cache = CacheStore()
        self.api = resolvedAPI
        self.cache = cache
        self.session = session
        let baseURL = session.serverURL ?? URL(fileURLWithPath: "/")
        let knownHandshake = Self.loadHandshake(for: baseURL)
        self.handshake = knownHandshake
        let scope = CacheStore.scope(baseURL: baseURL, handshake: knownHandshake)
        self.cacheScope = scope
        self.trainingPlanStore = TrainingPlanStore(cache: cache, api: resolvedAPI, scope: scope, now: now)
        restorePlanSafetyState()
        watchLedger = cache.watchLedger()
        scheduleStateChanged()
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
        // 2026-10-18（事故复盘 P0-3）：配置已换，在飞的训练列表读属于旧配置。
        cancelWorkoutReads()
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
                    Task {
                        // 2026-10-18（事故复盘 P0-3）：排队重跑加 ~350ms 合并窗口。
                        // 同一波 burst（回前台 + 同步成功 + 进页面）会在前一次刷新还没
                        // 回来时排入多次重跑；旧实现"完成即立刻重跑"等于在 burst 里再
                        // 叠一轮 coach-loop/四连读。窗口期间又来的调用照旧走
                        // `isRefreshing` 守卫排队，不会并发起第二条刷新。
                        try? await Task.sleep(nanoseconds: 350_000_000)
                        guard !Task.isCancelled, configuration == self.configurationID else { return }
                        await self.refreshAll(requestHandshake: handshake)
                    }
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
        async let pendingPlanState = refreshPlanState()
        async let pendingStatistics = api.statistics(baseURL: baseURL, token: token)
        async let pendingTrends = api.trends(baseURL: baseURL, token: token)
        let planSucceeded = await pendingPlanState
        // 每个面板记录**失败类别**（2026-10-15 审查 🟡-B2/B3）："解码失败"（契约漂移）
        // 与"连不上/服务端错"对用户的含义相反，不能再在同一个 `try? == nil` 里折叠；
        // 且分母必须是全部 4 个面板（此前 workouts 未计入，`failedPanels == 4` 是死分支）。
        var panelOutcomes: [ReadPanelOutcome] = []
        panelOutcomes.append(planSucceeded ? .ok : Self.planPanelOutcome(trainingPlanStore.issue))
        do {
            let fetchedStatistics = try await pendingStatistics
            statistics = fetchedStatistics
            recordCache(fetchedStatistics, key: "statistics")
            panelOutcomes.append(.ok)
        } catch {
            panelOutcomes.append(Self.panelOutcome(for: error))
        }
        do {
            let fetchedTrends = try await pendingTrends
            trends = fetchedTrends
            recordCache(fetchedTrends, key: "trends")
            panelOutcomes.append(.ok)
        } catch {
            panelOutcomes.append(Self.panelOutcome(for: error))
        }
        let workoutsSucceeded = await refreshWorkouts()
        guard isCurrent() else { return }
        panelOutcomes.append(workoutsSucceeded ? .ok : workoutReadOutcome)
        // 归并规则集中在纯函数里（`ReadPanelTally.of`，有回归逐组合钉住）：
        // 2026-10-18（深度审查 P3-26）修正了"`decodingOnly` 把 `.validation` 也算成契约漂移"
        // —— 混合失败时会误导用户去升级 App，而真实原因是这一份计划快照的安全字段不可信。
        let tally = Self.ReadPanelTally.of(panelOutcomes)
        let failedPanels = tally.failed
        isOffline = !tally.anySucceeded && !tally.serverAnswered
        // 2026-10-18（事故复盘 P0-3）：一次 refreshAll 全失败**不再**把 isReachable
        // 打回 false。失败判定交给 ServerSession 的 3 次探针阈值（`markUnreachable`）；
        // 否则服务端仅仅是慢了一次，isReachable=false 就会把探针间隔从 30s 收紧到
        // ~5s 并禁用同步入口（TechSyncStatus），等于用一次失败制造更多请求。
        if tally.anySucceeded || tally.serverAnswered { session.isReachable = true }
        if failedPanels > 0 {
            // 刻意不在这里 `loadCachedData()`：那会把刚刚成功的那几项也推回旧值，
            // 等于用一次部分失败抹掉一次部分成功。首启的空态由 `bootstrap()`
            // 的 `loadCachedData()` 兜底。
            if tally.validationOnly {
                errorMessage = "计划快照未通过安全校验（身份、日期、窗口或摘要不一致），已拒绝作为当前安排；其余数据已刷新。请稍后重试或检查服务端状态。"
            } else if failedPanels == 4 && tally.decodingOnly {
                errorMessage = "数据格式与当前版本不兼容（4 项均未能解析），请升级应用或检查服务端版本。"
            } else if failedPanels == 4 && tally.serverAnswered {
                // 混合形态（部分安全校验失败 + 部分解码失败）：既不能说"升级应用"，也不能说
                // "连不上"。如实说明"服务端有答复但内容不可用"。
                errorMessage = "有数据未能通过校验或解析，已保留上次结果；请稍后重试，若持续出现请导出计划诊断。"
            } else if failedPanels == 4 {
                errorMessage = "核心数据均未能更新，当前显示的是上次结果。"
            } else if tally.decodingOnly {
                errorMessage = "有 \(failedPanels) 项数据未能更新（数据格式与当前版本不兼容），其余已刷新。"
            } else {
                errorMessage = "有 \(failedPanels) 项数据未能更新，其余已刷新。"
            }
        }
        // 2026-10-18（审查 P2-9）：整合合同（snapshot 或 coachLoop）的教练摘要已经
        // 在 refreshPlanState 内读取；再调用 refreshRunCoach 会重复一次完整计划读取。
        // 旧合同才需要独立的 run-coach 刷新。
        if goals?.runCoach != nil, !usesIntegratedPlanContract { await refreshRunCoach() }
    }

    @discardableResult
    func refreshRunCoach() async -> Bool {
        // 2026-10-18（审查 P2-9）：能力判定单源。新教练合同（coachLoop）与聚合快照
        // 都意味着"完整计划读取"由 `TrainingPlanStore.refresh` 负责；不能再只按
        // `planSnapshotContractVersion` 分叉，否则混合能力组合会混读旧 run-coach。
        if usesIntegratedPlanContract { return await refreshPlanState() }
        guard !isLoadingRunCoach, !isPlanBusy, let baseURL = session.serverURL else { return false }
        let configuration = configurationID
        let token = session.apiToken
        let mutation = planMutationEpoch
        let requestID = UUID()
        runCoachRequestID = requestID
        isLoadingRunCoach = true
        defer { if runCoachRequestID == requestID { isLoadingRunCoach = false } }
        func isCurrent() -> Bool {
            configuration == configurationID && baseURL == session.serverURL && token == session.apiToken &&
                runCoachRequestID == requestID && mutation == planMutationEpoch && !Task.isCancelled
        }
        do {
            let value = try await api.runCoach(baseURL: baseURL, token: token)
            guard isCurrent(), value.revision >= currentPlanRevision else { return false }
            trainingPlanStore.acceptCoach(value)
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
            return true
        } catch {
            guard isCurrent() else { return false }
            runCoachError = friendlyMessage(error)
            return false
        }
    }

    @discardableResult
    func changeRunCoach(action: String, config: MobileRunCoachConfig? = nil, expectedRevision: Int? = nil, editorSessionID: String? = nil) async -> Bool {
        if isCoachLoopManaged {
            guard config == nil, ["refresh", "pause", "resume", "end"].contains(action) else {
                runCoachError = "当前使用新版教练合同，请在新版训练偏好中修改。"; return false
            }
            return await changeCoachLoop(action: action, expectedRevision: expectedRevision, editorSessionID: editorSessionID)
        }
        guard editorSessionID == nil || editorSessionID == feedbackSessionID else { return false }
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
            let value: MobileRunCoachResponse = try await publishPlan(route: "coach",
                input: MobileRunCoachCommand(expectedRevision: revision, action: action, config: config), baseURL: baseURL, token: token, isCurrent: isCurrent)
            guard isCurrent() else { return false }
            acknowledgePlanWrite(revision: value.revision, action: action, coach: value)
            finishPlanPublication()
            trainingPlanStore.acceptCoach(value)
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
    func changeCoachLoop(action: String, preferences: CoachLoopPreferences? = nil, acceptedPolicyHash: String? = nil,
                         expectedRevision: Int? = nil, editorSessionID: String? = nil) async -> Bool {
        guard editorSessionID == nil || editorSessionID == feedbackSessionID else { return false }
        guard handshake?.coachLoopContractVersion == 1, handshake?.planPublicationContractVersion == 1,
              !isPlanBusy, !isOffline, let baseURL = session.serverURL, let loop = coachLoop,
              trainingPlanStore.isCurrent, expectedRevision == nil || expectedRevision == loop.revision else {
            runCoachError = "请先联网读取当前教练合同；未提交。"; return false
        }
        if action == "enable" {
            scheduleStateChanged()
            guard !scheduleStorageIssue, !hasInterruptedSchedule, !hasPendingPlanReceipts,
                  watchLedger?.entries.isEmpty != false else {
                runCoachError = "旧系统排期或未登记回执尚未协调，请先核验／撤回并登记；未转换模式。"
                return false
            }
        }
        let configuration = configurationID; let token = session.apiToken; let requestID = UUID()
        saveGoalsRequestID = requestID; isUpdatingRunCoach = true
        defer { if saveGoalsRequestID == requestID { isUpdatingRunCoach = false } }
        func valid() -> Bool {
            configuration == configurationID && baseURL == session.serverURL && token == session.apiToken &&
                requestID == saveGoalsRequestID && !Task.isCancelled
        }
        do {
            let command = CoachLoopCommand(contractVersion: 1, operationId: UUID().uuidString, operationScope: loop.scope,
                expectedRevision: loop.revision, expectedFactsHash: loop.factsHash, action: action,
                acceptedPolicyHash: acceptedPolicyHash, settings: preferences)
            let value: CoachLoopResponse = try await publishPlan(route: "coach-loop", input: command,
                baseURL: baseURL, token: token, isCurrent: valid)
            guard valid() else { return false }
            planMutationEpoch = UUID()
            // 2026-10-18（事故复盘 P0-3）：代次变化后旧的计划读不再有权写入。
            cancelInFlightPlanRefresh()
            trainingPlanStore.acceptCoachLoopWrite(value); finishPlanPublication()
            runCoachError = nil
            let refreshed = await refreshPlanState()
            guard valid() else { return false }
            if !refreshed { runCoachError = "教练命令已保存，但当前执行快照尚未确认；请重读，不要重新发布。" }
            return true
        } catch {
            guard valid() else { return false }
            runCoachError = friendlyMessage(error)
            if case RaiAPIClientError.server(let code, _, _) = error,
               ["coach_facts_changed", "mobile_goals_revision_conflict"].contains(code) { _ = await refreshPlanState() }
            return false
        }
    }

    /// Saving subjective evidence and adapting the plan are separate commands.
    /// Lost replies retry the exact operation and payload, never a new UUID.
    func saveCoachFeedback(fields: CoachLoopFeedbackCommand.Fields? = nil, retract: CoachLoopFeedback? = nil, retry: Bool = false) async -> Bool {
        guard !isPlanBusy, !isOffline, handshake?.coachLoopContractVersion == 1,
              let loop = coachLoop, let baseURL = session.serverURL else { return false }
        let pending = cache.pendingCoachFeedback(scope: cacheScope)
        guard !pending.isFailure else { runCoachError = "反馈操作记录无法读取，请恢复存储，不要重新提交。"; return false }
        let previous = pending.value ?? nil
        if previous != nil && !retry { runCoachError = "上次反馈结果尚未确认，请先重试原反馈。"; return false }
        guard retry ? previous != nil : (fields != nil || retract != nil) else { return false }
        let command = previous ?? CoachLoopFeedbackCommand(operationId: UUID().uuidString, operationScope: loop.scope,
            id: retract?.id ?? UUID().uuidString, expectedRevision: retract?.revision ?? 0,
            action: retract == nil ? "save" : "retract", consent: true, fields: fields)
        guard command.operationScope == loop.scope else { runCoachError = "原反馈属于其他数据集，未重放。"; return false }
        let scope = cacheScope; let configuration = configurationID; let token = session.apiToken
        guard cache.saveCoachFeedback(command, scope: scope) else { return false }
        isUpdatingRunCoach = true
        defer { if configuration == configurationID { isUpdatingRunCoach = false } }
        do {
            let result = try await api.coachFeedback(command, baseURL: baseURL, token: token)
            guard scope == cacheScope, configuration == configurationID, token == session.apiToken,
                  baseURL == session.serverURL, !Task.isCancelled else { return false }
            guard cache.saveCoachFeedback(nil, scope: scope) else {
                runCoachError = "反馈已保存，本地操作确认未持久化，请重试原反馈。"; return false
            }
            cancelInFlightPlanRefresh()
            trainingPlanStore.invalidate()
            let refreshed = await refreshPlanState()
            runCoachError = !refreshed ? "反馈已保存，读取失败；尚未刷新训练安排。" :
                result.refreshRequired ? "反馈已保存；有效安全限制立即生效，训练安排需单独刷新。" : nil
            return true
        } catch {
            guard scope == cacheScope, configuration == configurationID else { return false }
            // 终局白名单（审查 🟡-C4）：并入 `coach_scope_mismatch`（这份反馈属于另一个
            // 数据集，同一份字节重试永远失败）。留在"重试原反馈"路径会把账目永久卡住。
            if case RaiAPIClientError.server(let code, _, let status) = error, (400..<500).contains(status),
               PlanMutationDisposition.isTerminalCoachFeedbackError(code) {
                guard cache.saveCoachFeedback(nil, scope: scope) else {
                    runCoachError = "反馈被拒绝，但操作记录无法确认，请恢复存储。"; return false
                }
                _ = await refreshPlanState()
                runCoachError = "反馈未保存：" + friendlyMessage(error)
                return false
            }
            runCoachError = "反馈结果尚未确认，请重试原反馈：" + friendlyMessage(error)
            return false
        }
    }

    func refreshCoachPrediction() async {
        guard !isPlanBusy, !isOffline, let loop = coachLoop, let baseURL = session.serverURL else { return }
        let scope = cacheScope; let token = session.apiToken; let configuration = configurationID
        isUpdatingRunCoach = true
        defer { if configuration == configurationID { isUpdatingRunCoach = false } }
        do {
            let result = try await api.refreshCoachPrediction(scope: loop.scope, baseURL: baseURL, token: token)
            guard scope == cacheScope, configuration == configurationID, token == session.apiToken,
                  baseURL == session.serverURL, !Task.isCancelled else { return }
            runCoachError = result.status == "published" ? nil : "预测摘要不可用：需要兼容的已发布数据快照。"
            _ = await refreshPlanState()
        } catch {
            guard scope == cacheScope, configuration == configurationID else { return }
            runCoachError = friendlyMessage(error)
        }
    }

    /// 失败面板的分类工具：解码失败与网络/服务端失败的含义相反，不能折叠成一件事。
    private static func panelOutcome(for error: Error) -> ReadPanelOutcome {
        if case RaiAPIClientError.decoding = error { return .decoding }
        return .failure
    }

    private static func planPanelOutcome(_ issue: PlanReadIssue?) -> ReadPanelOutcome {
        switch issue?.code {
        case .contractMismatch: return .decoding
        case .snapshotValidationFailed: return .validation
        default: return .failure
        }
    }

    private var workoutReadOutcome: ReadPanelOutcome = .failure

    /// 2026-10-18（事故复盘 P0-3）：新请求取消旧请求。
    ///
    /// 旧实现只换 `workoutRequestID`：迟到响应不会覆盖新结果（守卫仍然有效），但
    /// 那条**网络请求**还在服务端排队 —— 服务端被慢查询占住时，一次筛选切换或多
    /// 一次刷新就能叠出两条并发读。现在旧任务的 `Task` 被 `cancel()`（URLSession
    /// 会随 Task 取消真正断开连接）；旧任务的 defer 与结果写入仍由
    /// `workoutRequestID` + `!Task.isCancelled` 双重守卫，所以它既不清掉新请求的
    /// `isLoadingWorkouts`，也不写 `isOffline`/`workoutReadOutcome`。调用方被取消
    /// （如视图消失）时，取消同样转发给内层任务。
    @discardableResult
    func refreshWorkouts() async -> Bool {
        guard session.serverURL != nil else { return false }
        workoutRefreshTask?.cancel()
        workoutReadGeneration &+= 1
        let generation = workoutReadGeneration
        let task = Task { () -> Bool in await self.performWorkoutRefresh() }
        workoutRefreshTask = task
        return await withTaskCancellationHandler {
            let result = await task.value
            // 只有最新代次能清句柄：旧任务的完成不得让新任务"失去句柄"（那样下一次
            // 刷新就无法取消它了）。
            if workoutReadGeneration == generation { workoutRefreshTask = nil }
            return result
        } onCancel: {
            task.cancel()
        }
    }

    private func performWorkoutRefresh() async -> Bool {
        guard let baseURL = session.serverURL else { return false }
        let requestID = UUID()
        workoutRequestID = requestID
        let scope = cacheScope
        let token = session.apiToken
        let filter = workoutSessionType
        let key = workoutsCacheKey
        workoutListError = nil
        workoutReadOutcome = .failure
        isLoadingWorkouts = true
        // 清 spinner 只属于"仍然是当前代次"的任务：被新请求取代后，spinner 归新请求管。
        defer { if workoutRequestID == requestID { isLoadingWorkouts = false } }
        do {
            let response = try await api.workouts(
                baseURL: baseURL, token: token, limit: workoutPageSize,
                offset: 0, sessionType: filter
            )
            // 结果写入同样只允许当前代次（`workoutRequestID`）+ 未被取消的任务做。
            guard workoutRequestID == requestID, scope == cacheScope,
                  baseURL == session.serverURL, token == session.apiToken,
                  !Task.isCancelled else { return false }
            workouts = response.items
            workoutTotal = response.total
            workoutReadOutcome = .ok
            recordCache(response, key: key)
            return true
        } catch {
            guard workoutRequestID == requestID, scope == cacheScope,
                  baseURL == session.serverURL, token == session.apiToken,
                  !Task.isCancelled else { return false }
            isOffline = true
            workoutReadOutcome = Self.panelOutcome(for: error)
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
        // freshness 不落缓存：它只回答"此刻还在补什么"，旧值比没有更糟。
        selectedFreshness = nil
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
        // 2026-10-18（事故复盘 P0-3）：详情、时序、补齐状态**并行**取。
        // 串行时详情页要等两条读各一个 RTT；freshness 只是补状态，更不该排在任何一条之后
        // （它决定"该不该继续自动重取"，晚到就等于重取判据晚到）。
        async let detailRequest = api.workoutDetail(id: id, baseURL: baseURL, token: token)
        async let seriesRequest = api.workoutSeries(id: id, baseURL: baseURL, token: token)
        async let freshnessRequest = api.workoutFreshness(id: id, baseURL: baseURL, token: token)
        let detail: WorkoutDetailResponse
        do {
            detail = try await detailRequest
        } catch {
            guard isCurrent() else { return }
            workoutDetailError = friendlyMessage(error)
            return
        }
        guard isCurrent() else { return }
        selectedWorkout = detail
        recordCache(detail, key: "workout-detail-\(id)")
        do {
            let series = try await seriesRequest
            guard isCurrent() else { return }
            selectedSeries = series
            recordCache(series, key: "workout-series-\(id)")
        } catch {
            guard isCurrent() else { return }
            workoutDetailError = "时序数据未能更新，可下拉重试。"
        }
        // freshness 是**补状态**，不是详情页的前置条件：老服务端没有这个端点、或这一次
        // 读失败，都只让它缺席（`nil` ⇒ 展示层按"没有证据"处理），绝不把整页报成失败。
        guard let freshness = try? await freshnessRequest, isCurrent() else { return }
        selectedFreshness = freshness
    }

    /// 2026-10-18（事故复盘 P0-6）：同步成功 / 回到前台后，重取**当前打开的那条训练**。
    ///
    /// 事故直接成因 D10：每批成功只触发 `refreshAll()`，而它**不碰**
    /// `selectedWorkout` / `selectedSeries` —— 服务端 12:30:23Z 就收下了 stride 482 条，
    /// 而 App 直到 12:31:55Z 才第一次读新详情：中间用户看到的是旧页面，只能下拉或退出重进。
    ///
    /// 三条边界（复盘 §6.1 P0-6 写死）：
    ///   1. 只在**有打开会话**时重取；
    ///   2. 只在**判定为 stale** 时重取（`WorkoutFreshnessPresentation.shouldReload`）：
    ///      freshness 仍 partial / 分析未发布 / 最近 6 小时结束 / 时序为空；
    ///      已完整的老训练不会被每一代次都重读三条接口；
    ///   3. **仅前台 + 350ms 合并窗口**：后台窗口里发 UI 级读会跨过后台到期点被系统挂起
    ///      （`NativeViews` 里 -1001 的同源说明），而同一波里的第二次调用复用第一次的 Task。
    ///
    /// - Parameters:
    ///   - isForeground: 调用方按 `scenePhase` 判定 —— 后台不发起 UI 级读。
    ///   - coalescing: 合并窗口（秒）。回归用 `.zero` 把窗口从时序里拿掉。
    /// - Returns: 真的发起了重取时为 `true`。
    @discardableResult
    func reloadOpenWorkoutIfStale(isForeground: Bool, coalescing: TimeInterval = 0.35) async -> Bool {
        guard isForeground, let detail = selectedWorkout else { return false }
        guard WorkoutFreshnessPresentation.shouldReload(
            endedAt: detail.workout.endedAt,
            publishStatus: detail.workout.analysisPublishStatus,
            freshness: selectedFreshness,
            series: selectedSeries,
            now: now()
        ) else { return false }
        if let inFlight = openWorkoutReloadTask { return await inFlight.value }
        let id = detail.workout.id
        let reloadID = UUID()
        let window = UInt64(max(0, coalescing) * 1_000_000_000)
        let task = Task { [weak self] () -> Bool in
            if window > 0 {
                // 合并窗口。`Task.sleep` 在调用方任务被取消（详情页消失 / 切走）时抛出，
                // 直接放弃这次重取 —— 不留下"页面已经不在却还在发请求"的尾巴。
                do { try await Task.sleep(nanoseconds: window) } catch { return false }
            }
            guard let self, !Task.isCancelled else { return false }
            // 窗口里用户可能已经切到别的训练：那条训练有自己的 `.task`，这里不越权。
            guard self.selectedWorkout?.workout.id == id else { return false }
            await self.loadWorkout(id: id)
            return true
        }
        openWorkoutReloadTask = task
        openWorkoutReloadID = reloadID
        let reloaded = await task.value
        if openWorkoutReloadID == reloadID {
            openWorkoutReloadTask = nil
            openWorkoutReloadID = nil
        }
        return reloaded
    }

    /// 2026-10-18（事故复盘 P0-3）：详情页**可见期间**的有界前台轮询。
    ///
    /// 只在 `TechWorkoutDetailView` 的 `.task` 里调用：页面消失或 App 进入后台时该任务被
    /// 取消，`Task.sleep` 抛出即停止 —— 这就是"不新增后台机制"的落地形态（没有定时器、
    /// 没有 BGTask、没有 observer）。次数与间隔由 `WorkoutFreshnessPollPolicy` 钉住
    /// （2/5/10/15 秒，最多 4 次，一波 ≈32 秒）。
    ///
    /// 与 `reloadOpenWorkoutIfStale` 的分工：那个由**同步代次**驱动（数据到服务端了），
    /// 这个由**详情页还开着**驱动（用户正盯着"数据仍在补齐"的横幅）。两者都不轮询后台。
    func pollOpenWorkoutFreshnessWhileVisible(id: String) async {
        var attempts = 0
        while WorkoutFreshnessPollPolicy.shouldContinue(
            attempts: attempts,
            isPartial: WorkoutFreshnessPresentation.isPartial(selectedFreshness),
            openWorkoutID: selectedWorkout?.workout.id,
            expectedID: id
        ) {
            let delay = WorkoutFreshnessPollPolicy.delaySeconds(afterAttempt: attempts + 1)
            do {
                try await Task.sleep(nanoseconds: UInt64(max(0, delay) * 1_000_000_000))
            } catch {
                return
            }
            guard !Task.isCancelled, selectedWorkout?.workout.id == id else { return }
            attempts += 1
            await loadWorkout(id: id)
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
        weekPlan: [MobileGoalsPlanItem],
        editorSessionID: String? = nil
    ) async -> Bool {
        guard let current = goals else { return false }
        return await persistGoals(UpdateMobileGoalsRequest(
            expectedRevision: expectedRevision,
            easyDurationFloorFraction: easyDurationFloorFraction,
            qualitySessionCap: qualitySessionCap,
            raceTarget: current.raceTarget,
            weekPlan: current.weekPlanReplanRequired == true ? nil : weekPlan
        ), editorSessionID: editorSessionID)
    }

    /// Only changes the race target; omitted weekly-plan fields remain untouched.
    func saveRaceTarget(_ target: MobileRaceTarget?, expectedRevision: Int, editorSessionID: String? = nil) async -> Bool {
        guard goals != nil else { return false }
        return await persistGoals(UpdateMobileGoalsRequest(
            expectedRevision: expectedRevision,
            easyDurationFloorFraction: nil,
            qualitySessionCap: nil,
            raceTarget: target,
            weekPlan: nil
        ), editorSessionID: editorSessionID)
    }

    private func persistGoals(_ request: UpdateMobileGoalsRequest, editorSessionID: String? = nil) async -> Bool {
        guard editorSessionID == nil || editorSessionID == feedbackSessionID else { return false }
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
            let updated: MobileGoalsResponse = try await publishPlan(route: "goals", input: request, baseURL: baseURL, token: token, isCurrent: isCurrent)
            guard isCurrent() else { return false }
            acknowledgePlanWrite(revision: updated.revision, action: "goals", goals: updated)
            finishPlanPublication()
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
            let updated: MobileGoalsResponse = try await publishPlan(route: "lock",
                input: LockMobileSessionRequest(action: relock ? "relock" : "lock", expectedRevision: current.recommendationRevision),
                baseURL: baseURL, token: token, isCurrent: isCurrent)
            guard isCurrent() else { return false }
            acknowledgePlanWrite(revision: updated.revision, action: relock ? "relock" : "lock", goals: updated)
            finishPlanPublication()
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
        await refreshPlanState()
    }

    /// Requests a deterministic coach preview.
    /// Only confirmPlanPreview persists it; creating or cancelling a preview
    /// leaves the runner's stored week unchanged.
    @discardableResult
    func createWeeklyPlanPreview() async -> Bool {
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
                PreviewWeeklyPlanRequest(expectedRevision: revision),
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
        guard !isPlanBusy, !isOffline, preview.revision == goals?.revision, preview.candidateId == planPreview?.candidateId,
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
            let result: MobileWeeklyPlanGenerationResponse = try await publishPlan(route: "confirm",
                input: ConfirmWeeklyPlanRequest(candidateId: preview.candidateId, expectedRevision: preview.revision), baseURL: baseURL, token: token, isCurrent: isCurrent)
            guard isCurrent() else { return false }
            acknowledgePlanWrite(revision: result.revision, action: "preview-confirm")
            finishPlanPublication()
            planPreview = nil
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
        lastWatchSyncAt = now()
        lastWatchCompleted = completedWeekDates
        watchState = .verifiedCurrent
    }

    func recordWatchClearFailure(_ outcome: PlanWatchClearOutcome) {
        if outcome.deviceUnsupported { watchState = .unsupported }
        else if outcome.superseded { watchState = .unknown }
        else if !outcome.authorized { watchState = .denied }
        else { watchState = .stale }
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
        restorePlanSafetyState()
        trainingPlanStore.loadCache()
    }

    private var workoutsCacheKey: String {
        "workouts-\(workoutSessionType ?? "all")"
    }

    private var workoutPlanCacheKey: String { "workout-plan" }

    /// 读缓存并在**解码损坏**时自愈（删掉损坏行、下一次联网重建）——
    /// 损坏行留在库里只会每次启动重复解不开，且此前没有任何告警（审查 B-🔡3）。
    private func readCacheHealing<Value: Codable>(_ type: Value.Type, key: String) -> CachedValue<Value>? {
        if let value = cache.read(type, scope: cacheScope, key: key) { return value }
        if cache.lastReadIssue == .corruptPayload { cache.remove(scope: cacheScope, key: key) }
        return nil
    }

    private func loadCachedData() {
        isTodayAvailable = false
        restorePlanSafetyState()
        trainingPlanStore.loadCache()
        // 每个 key 只读一次：原先为了拿 cachedAt 又重复读了一遍，10 个 key 变成 20 次查询。
        let cachedStatistics = readCacheHealing(MobileStatisticsResponse.self, key: "statistics")
        let cachedTrends = readCacheHealing(MobileTrendsResponse.self, key: "trends")
        let cachedPredictions = readCacheHealing(NativePredictionResponse.self, key: "predictions")
        let cachedZones = readCacheHealing(NativeTrainingZonesCurrentResponse.self, key: "training-zones")
        statistics = cachedStatistics?.value
        trends = cachedTrends?.value
        predictions = cachedPredictions?.value
        predictionLastCacheAt = cachedPredictions?.cachedAt
        if cachedPredictions != nil {
            predictionLoadState = .stale(
                lastSuccessAt: cachedPredictions?.cachedAt,
                message: "当前显示的是缓存中的预测，等待刷新。"
            )
        }
        dashboard = readCacheHealing(NativeDashboardResponse.self, key: "dashboard")?.value
        trainingZones = cachedZones?.value
        trainingStatistics = readCacheHealing(NativeTrainingStatisticsOverviewResponse.self, key: "training-statistics")?.value
        loadCachedWorkouts()
        // 缓存新鲜度：陈旧数据不隐藏，由 TechFreshnessBanner 显式告知用户，因此这里不设硬 TTL。
        lastCacheUpdate = [
            trainingPlanStore.cachedAt,
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
        let changed = nextScope != cacheScope
        if changed {
            clearPresentation()
        }
        self.handshake = handshake
        cacheScope = nextScope
        // 2026-10-18（事故复盘 P0-3）：`configure` 会作废 store 自己的 requestID/epoch，
        // 在飞的计划读注定写不进去 —— 让单飞句柄一起失效，别让下一次刷新复用它。
        cancelInFlightPlanRefresh()
        trainingPlanStore.configure(scope: nextScope, clear: changed)
        restorePlanSafetyState()
        scheduleStateChanged()
        if changed {
            watchLedger = cache.watchLedger()
            watchState = .unknown
        }
    }

    private func clearPresentation() {
        workoutRequestID = UUID()
        // 2026-10-18（事故复盘 P0-3）：清展示层时取消在飞的训练列表读。
        cancelWorkoutReads()
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
        trainingPlanStore.configure(scope: cacheScope, clear: true)
        statistics = nil
        trends = nil
        workoutPlanError = nil
        runCoachError = nil
        predictions = nil
        dashboard = nil
        trainingZones = nil
        trainingStatistics = nil
        workouts = []
        workoutTotal = 0
        selectedWorkout = nil
        selectedSeries = nil
        selectedFreshness = nil
        // 2026-10-18（事故复盘 P0-6）：配置/scope 变了，在飞的自动重取属于旧配置。
        openWorkoutReloadTask?.cancel()
        openWorkoutReloadTask = nil
        openWorkoutReloadID = nil
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
        trainingPlanStore.configure(scope: cacheScope, clear: true)
        refreshQueued = false
        refreshHandshakeQueued = false
        lockRequestID = UUID()
        regeneratePlanRequestID = UUID()
        isLockingSession = false
        isRegeneratingPlan = false
        planMessage = nil
        planPreview = nil
        lastWatchRevision = nil
        lastWatchSyncAt = nil
        lastWatchDays = nil
        lastWatchTimezone = nil
        lastWatchHour = nil
        lastWatchCompleted = nil
        watchState = .unknown
    }

    private func invalidatePlanReads() {
        planMutationEpoch = UUID()
        runCoachRequestID = UUID()
        isLoadingRunCoach = false
        // 2026-10-18（事故复盘 P0-3）：单飞的 in-flight 任务必须一起失效，否则旧
        // scope/旧代次的读结果会回来覆盖 ack 之后的展示状态，或让下一次刷新复用
        // 一个已被 store 作废的读。
        cancelInFlightPlanRefresh()
        trainingPlanStore.invalidate()
    }

    /// 2026-10-18（事故复盘 P0-3）：让"在飞的计划读"失效并真正取消。
    ///
    /// 单飞复用的前提是"那条读还写得进去"：凡是 store 身份/代次/缓存权威变化
    /// （写确认、配置切换、scope 切换、缓存重载、待确认发布作废）都必须走这里。
    /// 只依赖 store 自己的 `requestID`/`epoch` 也能挡住结果写入，但会让调用方白等
    /// 一条已经注定失败的读，并让下一次刷新复用它。
    private func cancelInFlightPlanRefresh() {
        planRefreshTask?.cancel()
        planRefreshTask = nil
        planRefreshID = nil
        // 统一状态读与执行快照读共享同一批身份/代次前提，必须一起作废：
        // 否则一次合同读会带着旧 scope 的结果回来，把页面从"需刷新"翻回"当前"。
        unifiedRefreshTask?.cancel()
        unifiedRefreshTask = nil
        unifiedRefreshID = nil
    }

    /// 2026-10-18（事故复盘 P0-3）：让"在飞的训练列表读"失效并真正取消。
    private func cancelWorkoutReads() {
        workoutReadGeneration &+= 1
        workoutRefreshTask?.cancel()
        workoutRefreshTask = nil
    }

    private func acceptGoals(_ value: MobileGoalsResponse) {
        trainingPlanStore.acceptGoals(value)
    }

    /// Writes refresh only their dependent surfaces. Older full-page reads cannot
    /// undo the acknowledgement, and unrelated statistics never delay feedback.
    ///
    /// 2026-10-18（事故复盘 P0-3）：单飞。重复调用直接复用在飞 `Task` 的结果，
    /// 不再发第二条教练闭环读；只有最新代次的任务在完成后清句柄。
    @discardableResult
    func refreshPlanState() async -> Bool {
        if let task = planRefreshTask { return await task.value }
        guard let baseURL = session.serverURL else { return false }
        let configuration = configurationID
        let token = session.apiToken
        let mutation = planMutationEpoch
        let id = UUID()
        planRefreshID = id
        let task = Task { () -> Bool in
            let complete = await self.trainingPlanStore.refresh(baseURL: baseURL, token: token, handshake: self.handshake) {
                configuration == self.configurationID && token == self.session.apiToken &&
                    baseURL == self.session.serverURL && mutation == self.planMutationEpoch
            }
            // 迟到的读不得改写新配置/新代次下的展示状态（旧实现没有这道守卫）。
            // 2026-10-18（事故复盘 P0-3 复查）：取消与句柄归属也必须进同一道守卫 ——
            // 写确认/反馈/待确认发布这些**不改 epoch** 的入口会取消在飞读；被取消的读
            // 若继续写 `workoutPlanError`/`isReachable`，就会抹掉新读刚写入的失败提示，
            // 或把一次全失败刷新后的离线状态翻回在线。
            guard !Task.isCancelled, self.planRefreshID == id,
                  configuration == self.configurationID, token == self.session.apiToken,
                  baseURL == self.session.serverURL, mutation == self.planMutationEpoch else {
                return false
            }
            self.workoutPlanError = complete ? nil : self.trainingPlanStore.issue?.message
            if self.trainingPlanStore.serviceReachable { self.isOffline = false; self.session.isReachable = true }
            if complete { self.lastCacheUpdate = self.trainingPlanStore.cachedAt }
            return complete && self.currentWorkoutPlan != nil
        }
        planRefreshTask = task
        let result = await task.value
        if planRefreshID == id {
            planRefreshTask = nil
            planRefreshID = nil
        }
        return result
    }

    /// v2 统一训练状态的读（训练页唯一的状态来源）。
    ///
    /// 刻意不改写 `workoutPlanError`/`availability`：那两个字段描述的是**执行快照**，
    /// 而这条读回答的是"现在是什么模式、准入是否就绪、七日意图是什么"。合同升级
    /// 提示只出现在统一页自己的状态里，不污染今日页的执行失败文案。
    @discardableResult
    func refreshUnifiedTrainingPlan() async -> Bool {
        if let task = unifiedRefreshTask { return await task.value }
        guard let baseURL = session.serverURL else { return false }
        let configuration = configurationID
        let token = session.apiToken
        let id = UUID()
        unifiedRefreshID = id
        let task = Task { () -> Bool in
            let complete = await self.trainingPlanStore.refreshUnifiedPlan(
                baseURL: baseURL, token: token, handshake: self.handshake) {
                configuration == self.configurationID && token == self.session.apiToken &&
                    baseURL == self.session.serverURL
            }
            guard !Task.isCancelled, self.unifiedRefreshID == id,
                  configuration == self.configurationID, token == self.session.apiToken,
                  baseURL == self.session.serverURL else {
                return false
            }
            if self.trainingPlanStore.serviceReachable {
                self.isOffline = false
                self.session.isReachable = true
            }
            return complete
        }
        unifiedRefreshTask = task
        let result = await task.value
        if unifiedRefreshID == id {
            unifiedRefreshTask = nil
            unifiedRefreshID = nil
        }
        return result
    }

    /// Device scheduling shares the mutation gate with saves and generation.
    func beginPlanSync(allowOffline: Bool = false) -> UUID? {
        guard !isPlanBusy, (allowOffline || !isOffline), (allowOffline || !hasPendingPlanPublication) else { return nil }
        isSyncingPlan = true
        planSyncBaseURL = session.serverURL
        planSyncToken = session.apiToken
        planSyncRequestID = UUID()
        return planSyncRequestID
    }

    func isCurrentPlanSync(_ id: UUID) -> Bool {
        id == planSyncRequestID && isSyncingPlan && planSyncBaseURL == session.serverURL &&
            planSyncToken == session.apiToken && !Task.isCancelled
    }
    func endPlanSync(_ id: UUID) { if id == planSyncRequestID { isSyncingPlan = false } }


    private func restorePlanSafetyState() {
        trainingPlanStore.restoreSafety()
    }

    private func acknowledgePlanWrite(revision: Int, action: String, goals: MobileGoalsResponse? = nil, coach: MobileRunCoachResponse? = nil) {
        invalidatePlanReads()
        trainingPlanStore.acknowledge(revision: revision, action: action, goals: goals, coach: coach)
        if planPersistenceFailed { errorMessage = trainingPlanStore.issue?.message }
    }

    var planPresentation: PlanPresentationSnapshot {
        trainingPlanStore.presentation(offline: isOffline)
    }

    func planSyncSnapshot(_ id: UUID) -> PlanSyncSnapshot? {
        if let loop = coachLoop, isCoachLoopManaged {
            guard isCurrentPlanSync(id), !planPersistenceFailed, trainingPlanStore.isCurrent,
                  let plan = currentWorkoutPlan, !loop.refreshRequired,
                  goals?.revision == loop.revision,
                  UserDataNoticePolicy.isCurrentDay(loop.today.day.localDate, timezone: loop.timezone, now: now()) else { return nil }
            return .init(scope: cacheScope, configuration: configurationID, revision: loop.revision,
                days: plan.days, timezone: loop.timezone, reminderHour: Self.storedScheduleHour(scope: cacheScope),
                completedDates: [], localDate: loop.today.day.localDate, windowDays: 1, leaseID: id,
                coherenceToken: loop.executionToken, windowStart: loop.today.day.localDate, windowEnd: loop.today.day.localDate,
                serverIdentity: loop.scope, coachLoop: loop.receiptContext)
        }
        guard isCurrentPlanSync(id), !planPersistenceFailed, let plan = currentWorkoutPlan,
              goals?.revision == plan.planRevision, let today = planPresentation.today, isTodayAvailable,
              today.timezone == plan.timezone,
              today.today.localDate == UserDataNoticePolicy.localDate(now: now(), timezone: plan.timezone) else { return nil }
        return PlanSyncSnapshot(scope: cacheScope, configuration: configurationID, revision: plan.planRevision,
            days: plan.days, timezone: plan.timezone, reminderHour: Self.storedScheduleHour(scope: cacheScope),
            completedDates: completedWeekDates, localDate: today.today.localDate, windowDays: plan.windowDays, leaseID: id,
            coherenceToken: trainingPlanStore.metadata?.coherenceToken, windowStart: plan.windowStart, windowEnd: plan.windowEnd,
            serverIdentity: handshake.map { .init(serverId: $0.serverId, athleteId: $0.athleteId, datasetEpoch: $0.datasetEpoch) })
    }

    func isCurrentPlanSync(_ snapshot: PlanSyncSnapshot) -> Bool {
        planSyncSnapshot(snapshot.leaseID)?.matchesForExecution(snapshot) == true
    }

    var planSyncNow: Date { now() }

    var hasPendingPlanPublication: Bool {
        let result = cache.pendingPublication(scope: cacheScope)
        return result.isFailure || (result.value ?? nil) != nil
    }

    private func publishPlan<Input: Encodable, Result: Decodable>(route: String, input: Input, baseURL: URL, token: String, isCurrent: () -> Bool) async throws -> Result {
        guard isCurrent() else { throw CancellationError() }
        let scope = cacheScope
        let encoded = try JSONEncoder().encode(input)
        // 2026-10-18（审查 P3-17）：安全解包并给出可诊断错误，编码形状变化不能
        // 在主线程 `as!` 直接 trap（发布路径是整个计划写的入口）。
        guard let objectValue = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] else {
            throw RaiAPIClientError.decoding("发布请求无法编码为 JSON 对象")
        }
        var object = objectValue
        let operationID = UUID().uuidString
        let durable = handshake?.planPublicationContractVersion == 1
        if durable {
            let existing = cache.pendingPublication(scope: scope)
            guard !existing.isFailure, (existing.value ?? nil) == nil else {
                throw RaiAPIClientError.server(code: "plan_publication_pending", message: "上次发布结果尚未确认，请先确认原操作，不要重复发布。", status: 409)
            }
            object["operationId"] = operationID
            if let handshake {
                object["operationScope"] = ["serverId": handshake.serverId, "athleteId": handshake.athleteId, "datasetEpoch": handshake.datasetEpoch]
            }
        }
        let payload = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let pending = PendingPlanPublication(operationId: operationID, route: route, payload: payload, preparedAt: now())
        if durable, !cache.savePublication(pending, scope: scope) {
            throw RaiAPIClientError.server(code: "plan_publication_storage_unavailable", message: "无法持久化发布意图，尚未提交。", status: 409)
        }
        // 2026-10-18（事故复盘 P0-3）：写在飞时旧的计划读不再有权写入展示状态。
        cancelInFlightPlanRefresh()
        trainingPlanStore.invalidate()
        do { return try await api.replayPlanPublication(pending, baseURL: baseURL, token: token) }
        catch {
            if durable, case RaiAPIClientError.server(let code, _, let status) = error, (400..<500).contains(status), !code.hasPrefix("plan_operation_") {
                _ = cache.savePublication(nil, scope: scope)
            }
            if durable, !(error is CancellationError) { planMessage = "发布结果尚未确认；请查询原操作，重试不会提高 expectedRevision。" }
            throw error
        }
    }

    private func finishPlanPublication() {
        if !planPersistenceFailed, !cache.savePublication(nil, scope: cacheScope) {
            planMessage = "已保存，但本地操作结果记录未清除；请确认原操作，不要重新发布。"
        }
    }

    private func resolvePendingPublication<Result: Decodable>(_ pending: PendingPlanPublication, baseURL: URL, token: String, isCurrent: () -> Bool) async throws -> Result {
        guard isCurrent() else { throw CancellationError() }
        let scope = cacheScope
        let response: PlanPublicationResult<Result> = try await api.planOperation(id: pending.operationId, baseURL: baseURL, token: token)
        guard isCurrent() else { throw CancellationError() }
        guard response.operationId == pending.operationId else { throw RaiAPIClientError.decoding("发布查询返回了其他操作的结果") }
        if response.status == "committed", let result = response.result { return result }
        if response.status == "scopeMismatch" {
            // 🔴 终局（审查 🔴-1）：该操作属于其他数据集，同一份载荷永远不可能在当前
            // 身份下重放成功 ⇒ **先作废本地账目再抛**。不作废时守卫
            // `plan_publication_pending` 会永久拒绝本 scope 的全部计划写与手表排期
            // （`clearCache` 碰不到 `app_metadata`，UI 无出口）。
            _ = cache.savePublication(nil, scope: scope)
            throw RaiAPIClientError.server(code: "plan_operation_scope_mismatch",
                message: "该操作属于其他数据集，本地待确认发布已作废；当前数据集可重新发布。", status: 409)
        }
        if response.status == "notFound" {
            do { return try await api.replayPlanPublication(pending, baseURL: baseURL, token: token) }
            catch {
                // 非 `plan_operation_*` 的 4xx：服务端没有留下该操作行（请求被拒），
                // 重放没有意义；`plan_operation_*` 中**终局**的三个码同样作废。其余
                // （未来新增的 `plan_operation_*`）保持保守：保留账目，由「放弃本次未确认发布」
                // 的显式出口兜底（审查 🔴-1）。
                if case RaiAPIClientError.server(let code, _, let status) = error, (400..<500).contains(status),
                   !code.hasPrefix("plan_operation_") || PlanMutationDisposition.isTerminalPlanPublicationError(code) {
                    _ = cache.savePublication(nil, scope: scope)
                }
                throw error
            }
        }
        if response.status == "expired" {
            // 终局（同 scopeMismatch）：保留期已过 ⇒ 不存在任何可重放的可能。
            _ = cache.savePublication(nil, scope: scope)
            throw RaiAPIClientError.server(code: "plan_operation_expired",
                message: "该操作已过保留期，本地待确认发布已作废；如需继续请重新发布。", status: 410)
        }
        throw RaiAPIClientError.decoding("未知的发布操作状态，原操作不会重放")
    }

    func resolvePlanPublication() async -> String {
        guard !isPlanBusy, !isOffline, handshake?.planPublicationContractVersion == 1, let baseURL = session.serverURL else {
            return "请连接支持持久操作查询的原服务后确认。"
        }
        let result = cache.pendingPublication(scope: cacheScope)
        guard !result.isFailure else { return "发布账目无法读取，不能当作无操作；请恢复本地存储。" }
        guard let pending = result.value ?? nil else { return "没有待确认发布。" }
        let scope = cacheScope; let configuration = configurationID; let token = session.apiToken
        let requestID = UUID(); saveGoalsRequestID = requestID
        isSavingGoals = true
        defer { if saveGoalsRequestID == requestID { isSavingGoals = false } }
        func valid() -> Bool { requestID == saveGoalsRequestID && scope == cacheScope && configuration == configurationID && token == session.apiToken && baseURL == session.serverURL && !Task.isCancelled }
        do {
            switch pending.route {
            case "coach-loop":
                let value: CoachLoopResponse = try await resolvePendingPublication(pending, baseURL: baseURL, token: token, isCurrent: valid)
                guard valid() else { return "连接已变化，请在原服务确认结果。" }
                planMutationEpoch = UUID()
                // 2026-10-18（事故复盘 P0-3）：代次变化后旧的计划读不再有权写入。
                cancelInFlightPlanRefresh()
                trainingPlanStore.acceptCoachLoopWrite(value)
            case "coach":
                let value: MobileRunCoachResponse = try await resolvePendingPublication(pending, baseURL: baseURL, token: token, isCurrent: valid)
                guard valid() else { return "连接已变化，请在原服务确认结果。" }
                acknowledgePlanWrite(revision: value.revision, action: "operation-recovery", coach: value)
            case "confirm":
                let value: MobileWeeklyPlanGenerationResponse = try await resolvePendingPublication(pending, baseURL: baseURL, token: token, isCurrent: valid)
                guard valid() else { return "连接已变化，请在原服务确认结果。" }
                acknowledgePlanWrite(revision: value.revision, action: "operation-recovery")
                planPreview = nil
            default:
                let value: MobileGoalsResponse = try await resolvePendingPublication(pending, baseURL: baseURL, token: token, isCurrent: valid)
                guard valid() else { return "连接已变化，请在原服务确认结果。" }
                acknowledgePlanWrite(revision: value.revision, action: "operation-recovery", goals: value)
            }
            finishPlanPublication()
            let refreshed = await refreshPlanState()
            return refreshed ? "原操作已保存，完整计划已刷新；没有再次发布。" : "原操作已保存，等待完整计划刷新；不要重复发布。"
        } catch {
            // 终局码的账目已在 `resolvePendingPublication` 里作废，其文案自述了这一结果
            // （再加"尚未确认"前缀会与事实矛盾；审查 🔴-1）。
            if case RaiAPIClientError.server(let code, _, _) = error,
               PlanMutationDisposition.isTerminalPlanPublicationError(code) {
                return friendlyMessage(error)
            }
            return "原操作结果尚未确认：" + friendlyMessage(error)
        }
    }

    /// 显式放弃一个**既不能重放、也不在已知终局码内**的未确认发布（审查 🔴-1 的逃生阀）。
    ///
    /// 只在 UI 上作为二级破坏性操作暴露：清除的是**本地**账目，服务端操作行仍保留在
    /// 操作账本中供人工核对；本动作不声明该操作从未生效，放弃后应刷新完整计划核对。
    func abandonPendingPlanPublication() -> String {
        guard !isPlanBusy else { return "当前有操作进行中，请稍后再试。" }
        guard cache.savePublication(nil, scope: cacheScope) else {
            return "放弃失败：本地账目无法清除；请恢复本地存储后重试。"
        }
        planMessage = "已放弃本次未确认发布（服务端记录保留在操作账本中）。如担心该操作曾生效，请刷新完整计划核对。"
        return planMessage ?? ""
    }

    var hasPendingPlanReceipts: Bool {
        let result = cache.pendingPlanReceiptsResult(scope: cacheScope)
        return result.isFailure || !(result.value ?? []).isEmpty
    }

    /// Foreground explicit retry only. The original UUID/idempotency key and
    /// exported structure survive a lost server reply.
    func retryPlanSyncReceipts() async -> String {
        guard !isOffline, !isPlanBusy else { return "请连接服务后重试登记。" }
        guard let leaseID = beginPlanSync() else { return "另一计划操作或未确认发布尚未结束，请稍后重试。" }
        defer { endPlanSync(leaseID) }
        let result = cache.pendingPlanReceiptsResult(scope: cacheScope)
        guard !result.isFailure else { return "待登记账目无法读取，原数据保留，不能覆盖为空；请先恢复存储。" }
        let pending = result.value ?? []
        return await recordPlanSyncReceipts(pending, leaseID: leaseID) ?? "已登记上次核验日期。"
    }

    func recordPlanSyncReceipts(_ receipts: [PlanSyncReceipt], snapshot: PlanSyncSnapshot? = nil, leaseID: UUID? = nil) async -> String? {
        guard !receipts.isEmpty else { return nil }
        let scope = cacheScope
        let configuration = configurationID
        let token = session.apiToken
        guard let baseURL = session.serverURL else { return "系统日程已核验，但服务地址未配置，回执未登记。" }
        func current() -> Bool {
            scope == cacheScope && configuration == configurationID && token == session.apiToken &&
            baseURL == session.serverURL && !Task.isCancelled &&
            (snapshot.map { isCurrentPlanSync($0) } ?? true)
            && (leaseID.map { isCurrentPlanSync($0) } ?? true)
        }
        func matchingLedger(for receipt: PlanSyncReceipt) -> PlanWatchLedger? {
            guard let ledger = watchLedger, ledger.scope == scope, ledger.revision == receipt.revision,
                  ledger.entries.contains(where: { PlanReceiptMatcher.matches(receipt: receipt, entry: $0) }) else { return nil }
            return ledger
        }
        let retained = cache.pendingPlanReceiptsResult(scope: scope)
        guard !retained.isFailure else { return "待登记账目无法读取，停止登记并保留原数据。" }
        var pending = retained.value ?? []
        for receipt in receipts where !pending.contains(where: { $0.idempotencyKey == receipt.idempotencyKey && $0.localDate == receipt.localDate }) { pending.append(receipt) }
        var persisted = cache.savePendingPlanReceipts(pending, scope: scope)
        var staleReceipts = false
        var historicalReceipts = false
        var terminalRejections = 0
        for receipt in receipts {
            guard current() else { break }
            do {
                var wire = receipt
                // Older servers reject unknown fields; optional handshake
                // capability permits staggered updates without blind 400 retries.
                if wire.coachLoop != nil {
                    guard handshake?.coachLoopContractVersion == 1 else {
                        throw RaiAPIClientError.decoding("服务不支持原教练排期回执，不能降级或改写")
                    }
                } else if handshake?.planReceiptContractVersion != 2 {
                    if wire.lifecycleEvent != nil && wire.lifecycleEvent != "verified" { continue }
                    wire.useLegacyContract(metadata: handshake?.planReceiptMetadata == true)
                }
                let response = try await api.recordPlanSync(wire, baseURL: baseURL, token: token)
                guard current() else { break }
                if response.matchesCurrent == false, receipt.lifecycleEvent == "verified" {
                    if var ledger = matchingLedger(for: receipt) {
                        staleReceipts = true
                        watchState = .stale
                        ledger.requiresWithdrawal = true; watchLedger = ledger
                        if !cache.saveWatchLedger(ledger) { persisted = false }
                    } else { historicalReceipts = true }
                }
                pending.removeAll { $0.idempotencyKey == receipt.idempotencyKey && $0.localDate == receipt.localDate }
                if var ledger = matchingLedger(for: receipt) {
                    ledger.registeredDates = Array(Set(ledger.registeredDates + [receipt.localDate])).sorted()
                    watchLedger = ledger
                    if !cache.saveWatchLedger(ledger) { persisted = false }
                }
                if !cache.savePendingPlanReceipts(pending, scope: scope) { persisted = false }
            } catch {
                guard current() else { break }
                // 2026-10-18（审查 P2-6 收尾）：`503 + Retry-After` 现为
                // `.retryableServer`，同样携带真实服务端 code；不能退化成 "network"。
                let code = (error as? RaiAPIClientError)?.serverCode ?? "network"
                // 🔴 终局拒绝（审查 🟡-C1）：内容级 / 身份级不可通过 —— 同一份字节重放永远失败。
                // 此前只特判 scope_mismatch 且**只标记账本、不作废回执** ⇒
                // `hasPendingPlanReceipts` 恒真 ⇒ 教练启用（:421-424）被永久锁死。
                // 终局 ⇒ 作废该条回执 + 如实告知；瞬时失败仍走下方"保留重试"。
                if PlanMutationDisposition.isTerminalPlanReceiptError(code) {
                    if receipt.lifecycleEvent == "verified", var ledger = matchingLedger(for: receipt) {
                        staleReceipts = true; watchState = .stale
                        ledger.requiresWithdrawal = true; watchLedger = ledger
                        if !cache.saveWatchLedger(ledger) { persisted = false }
                    }
                    terminalRejections += 1
                    pending.removeAll { $0.idempotencyKey == receipt.idempotencyKey && $0.localDate == receipt.localDate }
                    if !cache.savePendingPlanReceipts(pending, scope: scope) { persisted = false }
                    cache.recordPlanDiagnostic(.init(at: now(), name: "receipt_terminal_rejected", scopeDigest: scope,
                        operationId: receipt.operationId, revision: receipt.revision, owed: nil, confirmed: nil, errorCode: code))
                    continue
                }
                cache.recordPlanDiagnostic(.init(at: now(), name: "receipt_retry_failed", scopeDigest: scope,
                    operationId: receipt.operationId, revision: receipt.revision, owed: nil, confirmed: nil, errorCode: code))
            }
        }
        if !persisted { return "系统日程结果与服务端登记分别处理；本地待登记账目未持久化，请检查存储后重试。" }
        let failures = receipts.filter { receipt in pending.contains { $0.idempotencyKey == receipt.idempotencyKey && $0.localDate == receipt.localDate } }.count
        if terminalRejections > 0 {
            // 终局拒绝已作废（审查 🟡-C1）：文案必须说"不再重试"，与下方"可前台重试"分开 ——
            // 后者只服务瞬时失败；混用会把用户永久留在失败的重试里。
            return "\(terminalRejections) 天的系统日程回执被服务端终局拒绝（数据校验冲突），已作废不再重试；请撤回旧排期后重新同步手表。"
                + (failures > 0 ? "另有 \(failures) 天仍待登记。" : "")
        }
        if staleReceipts { return "已登记历史核验，但服务端事实已变化，不计当前覆盖；请撤回或更新。" + (failures > 0 ? "另有 \(failures) 天仍待登记。" : "") }
        if historicalReceipts { return "历史核验已登记，不计当前覆盖；当前系统排期状态未变。" + (failures > 0 ? "另有 \(failures) 天仍待登记。" : "") }
        return failures == 0 ? nil : "\(failures) 天的系统日程回执未在服务端登记；可前台重试，系统排期核验结果不因此作废。"
    }

    var watchStatusLabel: String {
        if scheduleStorageIssue { return "安全账目无法读取，停止替换排期" }
        if interruptedSchedule != nil { return "排期操作中断，需前台核验／撤回" }
        if watchLedger?.requiresWithdrawal == true { return "中断排期尚未确认撤回" }
        if let ledger = watchLedger, ledger.scope != cacheScope { return "上次为其他服务排期，需核验／撤回" }
        if [.verifiedCurrent, .partial, .empty].contains(watchState) && watchNeedsUpdate { return PlanWatchState.stale.label }
        return watchState.label
    }

    var hasInterruptedSchedule: Bool { interruptedSchedule != nil || scheduleStorageIssue }

    func scheduleStateChanged() {
        let result = cache.scheduleJournalResult()
        scheduleStorageIssue = result.isFailure || cache.watchLedgerResult().isFailure || cache.pendingPlanReceiptsResult(scope: cacheScope).isFailure
        interruptedSchedule = result.value.flatMap { $0.terminal ? nil : $0 }
    }

    func exportPlanDiagnostics() -> URL? { cache.exportPlanDiagnostics() }

    func diagnoseSchedule(_ outcome: PlanWatchSyncOutcome, journal: PlanScheduleJournal) {
        cache.recordPlanDiagnostic(.init(at: now(), name: outcome.cleanupVerified ? "schedule_readback" : "withdrawal_unverified",
            scopeDigest: journal.operation.scope, operationId: journal.operation.operationId.uuidString,
            revision: journal.operation.goalsRevision, owed: outcome.offered, confirmed: outcome.scheduled,
            errorCode: outcome.storageError != nil ? "storage_unavailable" : !outcome.verified ? "schedule_readback_mismatch" : nil))
    }

    func makeScheduleJournal(snapshot: PlanSyncSnapshot) -> PlanScheduleJournal? {
        scheduleStateChanged()
        guard !hasInterruptedSchedule, !planPersistenceFailed else { return nil }
        let previous = watchLedger?.scope == snapshot.scope ? watchLedger?.entries ?? [] : []
        return PlanScheduleJournal(storage: cache, snapshot: snapshot, previousEntries: previous)
    }

    func makeClearJournal() -> PlanScheduleJournal? {
        scheduleStateChanged()
        guard !scheduleStorageIssue else { return nil }
        if let interruptedSchedule { return PlanScheduleJournal(storage: cache, operation: interruptedSchedule) }
        let snapshot = PlanSyncSnapshot(scope: watchLedger?.scope ?? cacheScope, configuration: configurationID, revision: watchLedger?.revision ?? currentPlanRevision, days: [],
            timezone: "Asia/Shanghai", reminderHour: Self.storedScheduleHour(scope: cacheScope), completedDates: [],
            localDate: UserDataNoticePolicy.localDate(now: now(), timezone: "Asia/Shanghai"), windowDays: 7, leaseID: planSyncRequestID)
        return PlanScheduleJournal(storage: cache, snapshot: snapshot, previousEntries: watchLedger?.entries ?? [])
    }

    func interruptedScheduleJournal() -> PlanScheduleJournal? {
        scheduleStateChanged()
        guard !scheduleStorageIssue, let interruptedSchedule else { return nil }
        return PlanScheduleJournal(storage: cache, operation: interruptedSchedule)
    }

    func enrichPlanReceipts(_ receipts: [PlanSyncReceipt], snapshot: PlanSyncSnapshot, operationID: UUID) -> [PlanSyncReceipt] {
        guard let coherence = snapshot.coherenceToken, let identity = snapshot.serverIdentity else { return receipts }
        // 2026-10-18（深度审查 P3-27）：摘要算不出来时保留 legacy 形状是**故意**的降级
        // （服务端按旧信息级登记，不会 422），但它此前**零痕迹** —— 线上只会表现为"这天的
        // 执行证据缺失"，没人知道是降级。这里按批次记一条计划诊断（导出诊断可见）。
        var downgraded = 0
        let enriched = receipts.map { receipt -> PlanSyncReceipt in
            // 2026-10-18（审查 P2-13）：实际导出结构若含不可量化数值，摘要无法计算。
            // 不猜测目标：保留 legacy 形状（服务端按旧信息级登记），而不是发一条
            // 摘要为 nil 的 v2 回执被 422 终局拒绝。
            guard let digest = try? PlanFingerprint.prescriptionDigest(kind: receipt.kind, structure: receipt.structure) else {
                downgraded += 1
                return receipt
            }
            var value = receipt
            value.contractVersion = 2; value.scope = identity; value.operationId = operationID.uuidString
            value.coherenceToken = coherence; value.verifiedAt = ISO8601DateFormatter().string(from: now())
            value.timezone = snapshot.timezone; value.prescriptionDigest = digest
            value.lifecycleEvent = "verified"
            value.coachLoop = snapshot.coachLoop
            return value
        }
        if downgraded > 0 {
            cache.recordPlanDiagnostic(.init(
                at: now(), name: "receipt_summary_unavailable", scopeDigest: snapshot.scope,
                operationId: operationID.uuidString, revision: snapshot.revision,
                owed: receipts.count, confirmed: receipts.count - downgraded,
                errorCode: "plan_receipt_summary_unavailable"))
        }
        return enriched
    }

    private func lifecycleReceipts(_ ledger: PlanWatchLedger?, event: String) -> [PlanSyncReceipt] {
        (ledger?.receipts ?? []).filter { $0.contractVersion == 2 }.map { original in
            var value = original
            value.lifecycleEvent = event
            value.verifiedAt = ISO8601DateFormatter().string(from: now())
            value.idempotencyKey = (value.workoutID ?? "") + ":" + event
            return value
        }
    }

    func commitWatchResult(_ outcome: PlanWatchSyncOutcome, snapshot: PlanSyncSnapshot, journal: PlanScheduleJournal, receipts: [PlanSyncReceipt]) -> Bool {
        guard outcome.didAttemptClear else {
            if outcome.deviceUnsupported { watchState = .unsupported }
            else if !outcome.authorized && !outcome.superseded { watchState = .denied }
            scheduleStateChanged()
            return true
        }
        guard outcome.clearVerified, isCurrentPlanSync(snapshot) else { scheduleStateChanged(); return false }
        let ledger = PlanWatchLedger(scope: snapshot.scope, revision: snapshot.revision, entries: outcome.confirmedEntries,
            fingerprint: PlanFingerprint.make(days: snapshot.days, timezone: snapshot.timezone, hour: snapshot.reminderHour, completed: snapshot.completedDates),
            reminderHour: snapshot.reminderHour, confirmedAt: now(), registeredDates: [], receipts: receipts, coherenceToken: snapshot.coherenceToken)
        let events = lifecycleReceipts(watchLedger, event: "replaced")
        guard journal.finish(ledger: ledger, receipts: receipts + events, verified: outcome.verified) else {
            scheduleStateChanged(); return false
        }
        watchLedger = ledger
        watchState = outcome.verified ? (outcome.offered == 0 ? .empty : .verifiedCurrent) : .partial
        if outcome.verified && outcome.offered > 0, let plan = currentWorkoutPlan { recordWatchAcknowledgement(plan: plan, scheduleHour: snapshot.reminderHour) }
        scheduleStateChanged()
        return true
    }

    func recordScheduleLifecycle(event: String, ledger: PlanWatchLedger?) async {
        let receipts = lifecycleReceipts(ledger, event: event)
        guard let ledger else { return }
        let previous = cache.pendingPlanReceiptsResult(scope: ledger.scope)
        guard !previous.isFailure else { scheduleStorageIssue = true; return }
        var pending = (previous.value ?? []).filter { value in
            !ledger.entries.contains { $0.workoutID.uuidString == value.workoutID } ||
                (value.lifecycleEvent != nil && value.lifecycleEvent != "verified")
        }
        for receipt in receipts where !pending.contains(where: { $0.idempotencyKey == receipt.idempotencyKey }) { pending.append(receipt) }
        guard cache.savePendingPlanReceipts(pending, scope: ledger.scope) else { scheduleStorageIssue = true; return }
        if ledger.scope == cacheScope, !isOffline { _ = await recordPlanSyncReceipts(receipts) }
    }

    func commitScheduleWithdrawal(journal: PlanScheduleJournal, previous: PlanWatchLedger?, empty: Bool) -> Bool {
        guard journal.finishWithdrawal(ledger: nil, receipts: lifecycleReceipts(previous, event: "withdrawn")) else {
            scheduleStateChanged()
            return false
        }
        watchLedger = nil
        lastWatchSyncAt = now()
        lastWatchRevision = nil; lastWatchDays = nil; lastWatchTimezone = nil; lastWatchHour = nil; lastWatchCompleted = nil
        watchState = empty ? .empty : .stale
        scheduleStateChanged()
        return true
    }

    func recordRecoveredSchedule(_ outcome: PlanWatchSyncOutcome, journal: PlanScheduleJournal, withdraw: Bool) async -> String {
        guard outcome.authorized, !outcome.superseded, outcome.storageError == nil, outcome.validationError == nil else { return outcome.report }
        if withdraw || journal.operation.clearAll {
            guard outcome.cleanupVerified else { return "未能确认撤回，风险账目保留；请检查手表后重试。" }
            let previous = watchLedger
            guard commitScheduleWithdrawal(journal: journal, previous: previous, empty: outcome.clearVerified) else {
                return "撤回已读回，但确认账目未能原子提交；请重新核验。"
            }
            return "原操作条目已核验撤回；请在配对手表确认。"
        }
        let operation = journal.operation
        let previousLedger = watchLedger
        let receipts = operation.items.filter { item in outcome.confirmedEntries.contains(item.entry) }.map { item in
            var receipt = PlanSyncReceipt(localDate: item.entry.localDate, kind: item.kind, revision: operation.goalsRevision,
                structure: item.structure, workoutID: item.entry.workoutID.uuidString, scheduledAt: ISO8601DateFormatter().string(from: item.entry.scheduledAt),
                idempotencyKey: item.entry.workoutID.uuidString)
            if let identity = operation.serverIdentity, let coherence = operation.coherenceToken {
                receipt.contractVersion = 2; receipt.scope = identity; receipt.coherenceToken = coherence
                receipt.operationId = operation.operationId.uuidString; receipt.verifiedAt = ISO8601DateFormatter().string(from: now())
                receipt.timezone = operation.timezone; receipt.prescriptionDigest = item.prescriptionDigest; receipt.lifecycleEvent = "verified"
                receipt.coachLoop = operation.coachLoop
            }
            return receipt
        }
        if operation.scope == cacheScope, !isOffline { _ = await refreshPlanState() }
        let current = operation.scope == cacheScope && trainingPlanStore.isCurrent &&
            operation.goalsRevision == currentPlanRevision && operation.coherenceToken != nil &&
            operation.coherenceToken == (isCoachLoopManaged ? coachLoop?.executionToken : trainingPlanStore.metadata?.coherenceToken)
        let ledger = PlanWatchLedger(scope: operation.scope, revision: operation.goalsRevision, entries: outcome.confirmedEntries,
            fingerprint: current ? PlanFingerprint.make(days: workoutPlan?.days ?? [], timezone: operation.timezone, hour: operation.reminderHour, completed: completedWeekDates) : "",
            reminderHour: operation.reminderHour, confirmedAt: now(), registeredDates: [], requiresWithdrawal: !current, receipts: receipts, coherenceToken: operation.coherenceToken)
        // A repeated partial recovery may already have a new ledger. Only the
        // original replacement targets may receive termination events.
        let events = previousLedger?.scope == operation.scope ? lifecycleReceipts(previousLedger, event: "replaced").filter { receipt in
            operation.previousEntries.contains { PlanReceiptMatcher.matches(receipt: receipt, entry: $0) }
        } : []
        guard journal.finish(ledger: ledger, receipts: receipts + events, verified: outcome.verified) else {
            return "系统日程已读回，但确认账目未持久化，仍需重新核验。"
        }
        watchLedger = ledger
        watchState = current && outcome.verified ? .verifiedCurrent : .stale
        return "原操作核验 \(outcome.scheduled)/\(outcome.offered) 项。" + (current ? "可显式重试登记回执。" : "与当前计划尚未确认一致，请撤回或更新。")
    }

    func recordWatchInterrupted(_ outcome: PlanWatchSyncOutcome, snapshot: PlanSyncSnapshot, journal: PlanScheduleJournal) {
        watchState = .stale
        guard outcome.didAttemptClear || !outcome.submittedEntries.isEmpty else {
            _ = journal.cancelBeforeSideEffect(ledger: watchLedger)
            scheduleStateChanged()
            return
        }
        if outcome.cleanupVerified && outcome.clearVerified {
            if !commitScheduleWithdrawal(journal: journal, previous: watchLedger, empty: true) {
                errorMessage = "撤回已读回，但操作账目未能原子提交；请重新核验。"
            }
            return
        }
        let ledger = PlanWatchLedger(scope: snapshot.scope, revision: snapshot.revision,
            entries: outcome.submittedEntries + journal.operation.previousEntries, fingerprint: "", reminderHour: snapshot.reminderHour,
            confirmedAt: now(), registeredDates: [], requiresWithdrawal: true, receipts: watchLedger?.receipts)
        watchLedger = ledger
        _ = journal.persist(.withdrawalRequired)
        if !cache.saveWatchLedger(ledger) {
            errorMessage = "本次旧条目未能确认撤回，且本地撤回风险记录未持久化；请立即显式撤回并检查手表。"
        }
        scheduleStateChanged()
    }

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
            errorMessage = planPersistenceFailed && planWriteAcknowledgement != nil
                ? "服务端已保存，本地确认记录未持久化。旧执行缓存已禁用，请联网刷新；本地存储不可用时无法保证重启安全。"
                : "数据已读取，但离线缓存未能保存。请检查设备存储空间。"
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
