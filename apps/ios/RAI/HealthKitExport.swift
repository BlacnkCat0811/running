#if os(iOS)
import CoreLocation
import CryptoKit
import Foundation
import HealthKit

nonisolated struct HealthKitExportResult: Sendable {
    let zipURL: URL
    let workoutCount: Int
    let recordCount: Int
    let deletionCount: Int
    /// 本轮**装进载荷**的 route 文件数。
    ///
    /// ⚠️ 语义漂移：自 T1（按 workout 定频）起，本字段为「**本轮实际查询到的 workout 数**」，
    /// 不再等于「窗口内有轨迹的 workout 数」。两者在降频后**必然不同**（跳过的 workout
    /// 即使有轨迹也不再计入），且这个差值**没有任何报错**。
    ///
    /// 当前唯一消费点 `HealthKitSync.exportMessage` 只用它做「是不是一份什么都没读到的空导出」
    /// 的三个判据之一（另外两个是 `workoutCount` / `recordCount`，任一非 0 即不误判），
    /// 所以如今它变小不会把用户引向错误的提示 —— 它**不是 bug**。
    ///
    /// 🔴 真正的风险在未来：若有人加 UI 想展示「今天导出了几条轨迹」，直接读本字段会得到一个
    /// **偏小**的数 —— 不抛错、不触发告警，只是静静地错。真要展示这一项，必须换用
    /// 「窗口内有轨迹的 workout 数」的口径另算，不要复用本字段。
    ///
    /// 字段名保留不动：改名会波及门禁与测试，而这里只是文档债。
    let routeCount: Int
    let warnings: [String]
    let maxEndDate: Date?
    let exportedThrough: Date
    let workoutAnchor: Data?
    let recordCursors: Data
    let sourceScope: String
    /// 本轮**实际查询过**的 workout 的伴生 Route 状态（键 = 小写化的 workout uuid）。
    ///
    /// 只装"相对传入的 `routeStates` 发生了变化"的那些。被跳过的 workout 不在里面 ——
    /// 它的状态一个字都没改，写回去也只是把同样的值再写一遍。
    ///
    /// 它**不由导出侧落盘**：导出跑在脱离主线程的上下文里，而 `SyncTaskStore` 是
    /// `@MainActor`。回传成值、由主线程侧在一次成功收尾里写下去。
    let routeStates: [String: RouteSyncRecord]
    /// 本轮最后一个低频候选。即使 workout 暂不可读，也推进遍历位置，不伪造观测。
    let routeDiscoveryCursor: String?
    /// 本轮**为什么**被单批预算停住（S2.5 观测，2026-10-14）；`nil` = 没被预算停住。
    ///
    /// `hasMorePages` 由它派生（**不**再单独存一个 Bool）—— 同一事实存两份就会出现
    /// "说没被截断、其实被截断了"这种**类型上排除不掉**的不一致。
    /// 三种形态互不替代：`.recordPage` = 整页放不下、停在页首（**正常分批**）；
    /// `.recordNone` = 连一条都放不进剩余额度、该类型本轮零进展；`.routeFile` = 轨迹文件放不下。
    let budgetStopReason: BudgetStopReason?
    /// 本批产物里 `export.xml` 的**实际字节数**（= 盘上文件大小，与服务端
    /// `statSync(export.xml).size` 同口径）。
    ///
    /// 存在的唯一理由 = P2b 的**本地自校验**：上传前拿它与服务端硬上界比一次，
    /// 超了就缩预算重导，而不是把一份必被 400 的产物发出去。
    let xmlBytes: Int
    /// 本批产物里 GPX 轨迹的**实际字节和**（= 各 GPX 盘上字节之和，与服务端
    /// `inputTreeCheck` 的累加口径一致）。同上，只服务 P2b。
    let routeBytes: Int
    /// **本批未能发送的删除余量**（R3b）：下一批的输入 = 这里。
    ///
    /// 与 `budgetStopReason` **正交**：即使 `hasMorePages == false`（记录页全部读完），
    /// 删除仍可能装不下（一页的 `deletedObjects` 不随 limit 缩小）—— 消费方
    /// （`HealthKitSync`）必须把它**持久进 `sync_pending_deletions` 槽**，
    /// 且 `saveTask` 的 `needsContinuation` 要并入 `!pendingDeletions.isEmpty`
    /// （"还有未发送的工作"与"还有未读的页"同族）。
    let pendingDeletions: DirectSyncPendingDeletions
    /// B2：下一批的**类型轮转起点**（`descriptors` 下标）。半批被预算截断时，本批从
    /// `typeRotationStart` 开始、读到第 k 个类型停下 ⇒ 下一批从 `(起点 + k) % 类型数`
    /// 开始 —— 每批都换起点，任何类型都不会因为长期排在尾部而饿死。
    let nextTypeRotationStart: Int

    /// 单批预算停住的形态（S2.5）。**不是错误**：分批是设计行为。
    nonisolated enum BudgetStopReason: String, Sendable {
        /// 记录侧：整页放不下，停在页首。
        case recordPage
        /// 记录侧：连一条都放不进剩余额度（该类型本轮零进展）。
        case recordNone
        /// route 侧：轨迹文件放不进剩余额度（本轮不再取新轨迹，状态不动）。
        case routeFile
        /// workout 侧（R4b，2026-10-16）：整页 workout 的 XML 放不进剩余字节账 ——
        /// 停在**页首**（整页不写、页 anchor 不推进），下一批重来。
        case workoutBytes
    }

    /// 本轮是否还有未读的页（= 被预算停住）。
    ///
    /// 🔴 `false` **不**等于"全部类型都读到底"（可能只是本轮预算够用 + 各类型都读到了空页）
    /// —— 续传判定永远以 (hasMorePages, 回执) 合取为准（`DirectSyncCursorPolicy.continuationNeeded`）。
    var hasMorePages: Bool { budgetStopReason != nil }
}

/// 删除额度的**可变分配器**已挪到 `DirectSyncBatchBudget.swift`（R3b）：
/// 修正理由 = 预算回归**不编译**本文件（HealthKit 依赖），而分配器是纯逻辑、
/// 必须有可执行的判据。

nonisolated enum HealthKitExportError: LocalizedError, Equatable {
    case unavailable
    case notAuthorized
    /// The system has never asked the user for read access, and the request came
    /// back without a decision. Kept apart from `notAuthorized` because the two
    /// need different advice: one is "go flip a switch", the other is "the prompt
    /// never reached you".
    case authorizationUndecided
    /// The store could not answer whether read access was ever requested:
    /// `statusForAuthorizationRequest` threw, or it reported
    /// `HKAuthorizationRequestStatusUnknown`. Distinct from
    /// `authorizationUndecided` because nothing was asked — there is no prompt to
    /// wait for — and distinct from a decision, because an unreadable state is an
    /// *error*, not an answer. Mapping it to "decided" is how an unauthorized
    /// device went on to export an empty archive and report a successful sync.
    case authorizationCheckFailed
    /// 设备锁屏、或开机后尚未首次解锁：健康数据库被硬件级加密锁住，**任何**读取都会被拒。
    ///
    /// 单独立一个 case，而不是让它落进 `error.localizedDescription` 的兜底 —— 那条路的可见后果是
    /// 界面上出现一段系统英文错误，而调用方也无从判断"这是暂时读不到"还是"真的坏了"。
    /// 两者的正确处置完全相反（解锁后自动重跑 vs. 报失败并让用户去处理），
    /// 文档 §3.4 要求这两条路彻底分开，理由见 `HealthSyncBlockedRecovery`。
    case databaseLocked
    case missingRecordAnchor
    case invalidRecordAnchor
    case invalidWorkoutAnchor

    var errorDescription: String? {
        switch self {
        case .unavailable:
            return "这台设备没有 Apple 健康数据"
        case .notAuthorized:
            return "未获得 Apple 健康读取权限。请在 iPhone 设置 → 健康 → 数据访问与设备 中打开 RAI。"
        case .authorizationUndecided:
            return "系统没有给出 Apple 健康读取授权结果。请重新打开 RAI 并点一次「同步健康」；"
                + "若仍无反应，请删除 App 重装。"
        case .authorizationCheckFailed:
            return "无法确认 Apple 健康读取授权状态（健康数据未响应）。请稍后重试；"
                + "若反复出现，请在 iPhone 设置 → 健康 → 数据访问与设备 中确认 RAI 已获得读取权限。"
        case .missingRecordAnchor:
            return "健康记录查询未返回可恢复游标，请重试同步。"
        case .invalidRecordAnchor:
            return "健康记录增量游标无法读取，本次未自动重读全部历史。请使用「重新导入全部」恢复。"
        case .invalidWorkoutAnchor:
            return "跑步增量游标无法读取，本次未自动重读全部历史。请使用「重新导入全部」恢复。"
        case .databaseLocked:
            // 用户不需要做任何事，所以文案刻意不含"请重试"之外的动作项 ——
            // 设备一解锁就会自动继续（见 `RaiStartup.observeProtectedDataAvailability`）。
            return "设备已锁定，暂时无法读取 Apple 健康数据。解锁后将自动继续同步。"
        }
    }
}

/// Whether the user has answered the read prompt at all.
///
/// HealthKit deliberately never tells an app whether *read* access was granted —
/// only that the question has been asked. That is still the difference that
/// matters here: `notDetermined` means every later query returns an empty set,
/// which used to be exported as "0 次跑步" and reported as a successful sync.
nonisolated enum HealthKitReadAuthorization: String, Sendable {
    case unavailable
    case notDetermined
    case decided
    /// The store could not answer the question at all: the status query threw, or
    /// it returned `HKAuthorizationRequestStatusUnknown`. Kept apart from
    /// `decided` because it is an error state, not an answer — the export must
    /// not run on a state we failed to read.
    case unknown

    var isUndecided: Bool { self == .notDetermined }
}

nonisolated private final class QueryContinuation<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?
    private var store: HKHealthStore?
    private var query: HKQuery?
    private var cancelled = false

    func set(_ continuation: CheckedContinuation<T, Error>) {
        lock.lock()
        guard !cancelled else {
            lock.unlock()
            continuation.resume(throwing: CancellationError())
            return
        }
        self.continuation = continuation
        lock.unlock()
    }

    func execute(_ query: HKQuery, on store: HKHealthStore) {
        lock.lock()
        guard !cancelled else {
            lock.unlock()
            return
        }
        self.store = store
        self.query = query
        lock.unlock()
        store.execute(query)
        // Cancellation can race in the narrow window before `execute`. In that
        // case `cancel()` has already completed the continuation; stop once more
        // after registration so the late-started query cannot keep running.
        lock.lock()
        let shouldStop = cancelled
        lock.unlock()
        if shouldStop {
            store.stop(query)
        }
    }

    func resume(returning value: T) {
        lock.lock()
        let item = continuation
        continuation = nil
        store = nil
        query = nil
        lock.unlock()
        item?.resume(returning: value)
    }

    func resume(throwing error: Error) {
        lock.lock()
        let item = continuation
        continuation = nil
        store = nil
        query = nil
        lock.unlock()
        item?.resume(throwing: error)
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let item = continuation
        continuation = nil
        let activeStore = store
        let activeQuery = query
        store = nil
        query = nil
        lock.unlock()
        if let activeQuery {
            activeStore?.stop(activeQuery)
        }
        item?.resume(throwing: CancellationError())
    }
}

nonisolated private final class WarningBag: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []

    func add(_ message: String) {
        lock.lock()
        defer { lock.unlock() }
        if !items.contains(message) {
            items.append(message)
        }
    }

    var snapshot: [String] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }
}

nonisolated enum HealthKitExport {
    /// Routes can be attached after a workout is saved. Re-read a bounded
    /// recent window on anchored syncs so late routes are discoverable.
    private static let routeBackfillWindow: TimeInterval = 14 * 24 * 60 * 60

    /// 记录单页的**满页**上限。**可被收缩**（S2.5）：预算放不下整页时，drain 用更小的 `limit`
    /// 重查同一锚点（极限 1 条）—— 这是"每轮至少前进 1 条记录"的兜底，去掉它就退化成死循环。
    private static let recordPageLimit = 1000
    /// R4b（2026-10-16）：workout 侧的分页/渲染页大小。与 `recordPageLimit` 同量级 ——
    /// 页是**字节闸门**的边界（整页渲染进内存判定，放不下就整页不写），不是"取多少条"的
    /// 性能参数。query 级与渲染级共用同一个值。
    private static let workoutPageLimit = 1000
    /// B1（2026-10-16）：近期窗口的**回看时长**与**重叠**。窗口每批先扫一遍，
    /// 让"最近 48 小时"（训练详情/恢复评估的输入）不排在历史重放的队尾。
    /// 6h 重叠覆盖"数据迟到"（样本时间早、写入晚）——与增量流的 overlap 同源思路。
    private static let recentWindowLookback: TimeInterval = 48 * 3600
    private static let recentWindowOverlap: TimeInterval = 6 * 3600
    /// 窗口 pass 的单类型条数上限（query 降序取**最新** N 条）。有界是判据的一部分：
    /// 窗口**绝不**把整批预算吃光（装不下就跳过该类型、下批重试，历史段照跑）。
    private static let recentWindowLimit = 1500

    /// 一页记录的**渲染产物**（S2.5 写前判定）：先渲染进内存，判定通过才落盘。
    ///
    /// `deletions` 与字节一起被"整页原子提交"：被丢弃的那一页的删除事件必须**原样留到下一轮**
    /// （提前记账会让那些删除永久消失 —— 下一轮不会再读到它们）。
    nonisolated private struct RenderedRecordPage {
        let data: Data
        let deletions: [String]
        let recordCount: Int
    }

    /// Asks for read access and reports whether the system actually has an answer.
    ///
    /// `requestAuthorization` is the only call that can show the prompt, and it
    /// never says whether the user answered: on a refusal it returns without an
    /// error and every later query simply yields nothing. Asking the store for the
    /// *request status* before and after is the only way to tell "the user has not
    /// decided" apart from "the user decided, and there is nothing to read" —
    /// without which an unauthorized device exports an empty archive and reports a
    /// successful sync. This is the single entry point for that request; callers
    /// must branch on the result rather than assume the prompt was answered.
    @MainActor
    static func readAuthorizationState(requestingIfNeeded: Bool = true) async throws -> HealthKitReadAuthorization {
        try Task.checkCancellation()
        guard HKHealthStore.isHealthDataAvailable() else { return .unavailable }
        let store = HKHealthStore()
        let before: HKAuthorizationRequestStatus?
        do {
            before = try await store.statusForAuthorizationRequest(toShare: [], read: readTypes)
        } catch {
            if error is CancellationError || Task.isCancelled { throw CancellationError() }
            before = nil
        }
        try Task.checkCancellation()
        if before == .shouldRequest, requestingIfNeeded {
            do {
                try await store.requestAuthorization(toShare: [], read: readTypes)
            } catch {
                if error is CancellationError || Task.isCancelled { throw CancellationError() }
                return .unknown
            }
            try Task.checkCancellation()
        }
        // The query throwing means nothing was learned, so it is not an answer:
        // letting it fall through to `.decided` (as a bare `try?` plus a ternary
        // did) sent an unreadable state straight into a full export that reported
        // success. Fail closed on it.
        let after: HKAuthorizationRequestStatus
        do {
            after = try await store.statusForAuthorizationRequest(toShare: [], read: readTypes)
        } catch {
            if error is CancellationError || Task.isCancelled { throw CancellationError() }
            return .unknown
        }
        try Task.checkCancellation()
        switch after {
        case .shouldRequest:
            return .notDetermined
        case .unnecessary:
            // `.unnecessary` means the question has been answered — allowed or
            // denied, HealthKit will not say which, and it does not have to: a
            // decided store can read whatever it was given.
            return .decided
        case .unknown:
            // Documented as "the status could not be determined because an error
            // occurred" (`HKDefines.h`). An error state is not a decision.
            return .unknown
        @unknown default:
            // A status this build does not know is not a decision either.
            return .unknown
        }
    }

    /// - Parameters:
    ///   - routeStates: 导出**开始前**从 `SyncTaskStore.sync_route_state` 整批读出的伴生状态，
    ///     键是小写化的 workout uuid。传空字典等于"没有任何记忆"，于是每个 workout 都会被
    ///     当作首查（安全方向：多查一次，不会漏）。
    ///   - routeForceRescan: 人工重扫（"重新导入全部"）。所有 workout 的状态复位成
    ///     `.active` 且稳定性清零，于是这一轮**每个** workout 都会重查一次。
    ///   - budget: 单批载荷预算（S2.1/S2.5）。**写前判定**：整页先渲染进内存、判定通过才落盘
    ///     ⇒ 单批字节严格 ≤ 预算。截断时停在**页首**（整页不提交、锚点不推进），结果
    ///     `budgetStopReason != nil`。默认取保守值 —— 调用点漏传时宁小勿大（多分几批），绝不超界。
    static func exportArchive(
        from startDate: Date?,
        workoutAnchor: Data?,
        recordCursors: Data? = nil,
        recordsForceRescan: Bool = false,
        routeStates: [String: RouteSyncRecord] = [:],
        routeDiscoveryCursor: String? = nil,
        routeForceRescan: Bool = false,
        budget: DirectSyncBatchBudget = .conservative,
        pendingDeletions: DirectSyncPendingDeletions = .empty,
        typeRotationStart: Int = 0,
        onProgress: @escaping @Sendable (String) async -> Void
    ) async throws -> HealthKitExportResult {
        try Task.checkCancellation()
        guard HKHealthStore.isHealthDataAvailable() else { throw HealthKitExportError.unavailable }
        let store = HKHealthStore()
        let warnings = WarningBag()
        // 整批共用一个"现在"。逐 workout 取 `Date()` 会让同一份载荷里的判定基准随时间爬，
        // 而 `lastCheckedAt` 会被写回盘上 ⇒ 快照的语义就不再是"这一次看到了什么"。
        let routeNow = Date()
        var routeDecisions: [String: RouteSyncRecord] = [:]
        // §10.3 的读取阶段文案由 `DirectSyncCopy` 单点给出（`HealthKitSync.swift`）：
        // 这段进度是用户看到的「读取」，不是"备份/临时库/换库"。
        await onProgress(DirectSyncCopy.readingIncrement)
        try Task.checkCancellation()
        let workoutBatch = try await runningWorkouts(
            store: store,
            from: startDate,
            anchorData: workoutAnchor
        )
        try Task.checkCancellation()
        // R3b 删除三分预扣（固定顺序：旧槽 → 本批 workout → 本批 record）。
        // 🔴 顺序不是风格：workout 删除（deletedSourceIds）在 `runningWorkouts` 就已定形、
        // 且必须**先于** record 删除占额 —— 否则 record 侧会在 drain 里把额度吃光，
        // workout 侧再溢出就与本批已计入 manifest 的 record 删除**打架**（一份额度算两次）。
        // WP-12（O03）：三段预扣抽成纯函数（`DirectSyncDeletionPartition`），并把它原先
        // `prefix` 截断后**丢弃**的旧槽尾部并入回传余量（守恒式与去重口径见该函数文档）。
        let freshWorkoutIds = workoutBatch.deleted.map { $0.uuid.uuidString }
        let deletionPlan = DirectSyncDeletionPartition.plan(
            pending: pendingDeletions,
            freshWorkoutIds: freshWorkoutIds,
            budget: budget.maxDeletions
        )
        let stashRecordDeletions = deletionPlan.stashRecordDeletions
        let stashWorkoutIds = deletionPlan.stashWorkoutIds
        let keptWorkoutIds = deletionPlan.keptWorkoutIds
        // record 侧按剩余额度截断；本批新溢出经 `allocation.overflow` 回传，与计划里的
        // 旧槽尾部在收尾处合并成完整余量。
        let allocation = DirectSyncDeletionAllocation(remaining: deletionPlan.remainingRecordBudget)
        var merged = Dictionary(uniqueKeysWithValues: workoutBatch.added.map {
            (routeFileWorkoutId($0), $0)
        })
        let rediscovery = routeForceRescan ? [] : RouteSyncStateMachine.rediscoveryCandidates(
            existing: Array(routeStates.values),
            currentWorkoutUUIDs: Set(merged.keys),
            changedWorkoutUUIDs: workoutBatch.changedUUIDs,
            now: routeNow,
            cursor: routeDiscoveryCursor
        )
        let rediscoveryIDs = Set(rediscovery)
        let historicalIDs = rediscovery.filter { merged[$0] == nil }
        if !historicalIDs.isEmpty {
            // 按有限 UUID 集合定点取 workout，不使用最近窗口，更不扫描全部历史。
            let historical = try await knownRunningWorkouts(store: store, uuids: historicalIDs)
            for workout in historical { merged[routeFileWorkoutId(workout)] = workout }
        }
        // R4b：全量集合改名 `allWorkouts`（页数组在页循环里沿用 `workouts` 这个名字 ——
        // 逐 workout 循环的定界符/门禁切片锚在它的 `for` 头上，改名会砸掉那个切片）。
        let allWorkouts = merged.values.sorted {
            $0.startDate == $1.startDate
                ? $0.uuid.uuidString < $1.uuid.uuidString : $0.startDate < $1.startDate
        }

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-hk-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let xmlURL = directory.appendingPathComponent("export.xml")
        FileManager.default.createFile(atPath: xmlURL.path, contents: nil)
        let xml = try FileHandle(forWritingTo: xmlURL)
        defer { try? xml.close() }

        var files: [(name: String, url: URL)] = [("export.xml", xmlURL)]
        var recordCount = 0
        var routeCount = 0
        var routeBytes = 0
        /// route 侧的停因（记录侧的停因在 `records.budgetStopReason`，两者在返回时**取并**）。
        /// 不复用一个变量：两个停因来自两个收集阶段，唯一的合并点是 `HealthKitExportResult` 那一处。
        var routeStopReason: HealthKitExportResult.BudgetStopReason?
        var exportedWorkouts: [HKWorkout] = []

        try write(xml, """
        <?xml version="1.0" encoding="UTF-8"?>
        <HealthData locale="zh_CN">
          <ExportDate value="\(appleDate(Date()))"/>
          \(meElement(store: store))
        """)

        // R4b：**渲染分页**（写前字节闸门落在页边界上）。每页先渲染进内存 → 同一字节账
        // 判定 → 通过才写；拒绝则整页不写、后续页不发（`workoutStop = .workoutBytes`）。
        // 全量集合是 `allWorkouts`，页数组沿用 `workouts`（循环头是门禁切片的定界符）。
        var pageStart = 0
        var workoutStop: HealthKitExportResult.BudgetStopReason?
        while pageStart < allWorkouts.count {
            let pageEnd = min(pageStart + Self.workoutPageLimit, allWorkouts.count)
            let workouts = Array(allWorkouts[pageStart..<pageEnd])
            var pageText = ""
            var pageRouteFiles: [(name: String, url: URL)] = []
            var pageRouteDecisions: [String: RouteSyncRecord] = [:]
            var pageRouteBytes = 0
            var pageRouteCount = 0
            var pageExported: [HKWorkout] = []
        for (index, workout) in workouts.enumerated() {
            try Task.checkCancellation()
            await onProgress("正在读取第 \(index + 1)/\(workouts.count) 次跑步")
            try Task.checkCancellation()
            // 状态的键必须与 GPX 文件名**同源**（都走 `routeFileWorkoutId` ⇒ 小写化）。
            // 导入侧把 route 路径当大小写不敏感的身份，而这条状态是"这条路线的轨迹查过没有"
            // 的记忆 —— 两边写法不一致，记忆就永远命中不了自己的行，表现为"从来没生效过"。
            let routeKey = routeFileWorkoutId(workout)
            let previous = routeStates[routeKey]
                ?? RouteSyncStateMachine.baseline(workoutUUID: routeKey, workoutEndDate: workout.endDate)
            let hasWorkoutChange = workoutBatch.changedUUIDs.contains(routeKey)
            let routeFiles: [(name: String, url: URL)]
            // 🔴 route 预算闸门（2026-10-14，S2 补全）：**先判后取** —— 预算满就不 fetch，
            // `routeDecisions` 不写 ⇒ 状态与文件严格同进同退（未查的 workout 保持原状，
            // 由 `rediscoveryCandidates` 在后续轮次继续发现，cursor 轮转、每轮 ≤ 20 个）。
            // 若改成"fetch 之后丢弃"，状态会先行推进到 settled 而文件永久丢失。
            let routeBudgetExhausted = budget.routeBudgetExhausted(routeBytes: routeBytes + pageRouteBytes, routeFiles: routeCount + pageRouteCount)
            // 预算已满 ⇒ 本批路线到此为止：剩余 workout 一律不再取新轨迹（走 `else` 分支，状态不动）。
            // 记下停因让 `hasMorePages` 为真 ⇒ 调用方续批；未取到的 workout 保持原状态，
            // 由 `rediscoveryCandidates` 在下一轮继续发现。
            if routeBudgetExhausted { routeStopReason = .routeFile }
            if !routeBudgetExhausted && RouteSyncStateMachine.shouldQuery(
                existing: previous,
                now: routeNow,
                isForceManualRescan: routeForceRescan,
                hasWorkoutChange: hasWorkoutChange
            ) && (previous.status != .settled || routeForceRescan || hasWorkoutChange || rediscoveryIDs.contains(routeKey)) {
                let fetch = try await routeEntries(
                    for: workout,
                    store: store,
                    directory: directory,
                    warnings: warnings,
                    budget: budget,
                    usedRouteBytes: routeBytes + pageRouteBytes,
                    usedRouteFiles: routeCount + pageRouteCount
                )
                // An observation hash is not a server acknowledgement: a prior
                // GPX may still be pending after a quota refusal. Keep bounded
                // route retries until the protocol can acknowledge each route.
                if fetch.budgetExhausted {
                    // 整条轨迹装不进剩余额度：`routeEntries` 已把本轮分片回滚 ⇒ 零文件、
                    // 状态一个字不动（与 `else` 分支同语义，只是原因不同）。
                    routeFiles = []
                    routeStopReason = .routeFile
                    // P2-3A：单条轨迹超过**满额**单批预算 —— 额度重置也装不下它。静默跳过会让
                    // 用户永远不知道有数据没同步（2026-10-15 审查 P2-3），这里如实上报。
                    if fetch.oversized {
                        warnings.add("有一条跑步轨迹超过单批上限，暂未同步：\(routeKey)；已保留其同步状态")
                    }
                } else {
                    routeFiles = fetch.entries
                    // 预算按**字节**累计，口径 = 盘上 GPX 的 UTF-8 字节数（服务端 `statSync` 同口径）。
                    // 取 `fetch.bytes`（写文件时算好的 `document.utf8.count`）而不是回头再 `statSync`：
                    // 值与盘上逐字节同一次，且和 `entries` 严格同进同退。
                    pageRouteBytes += fetch.bytes
                    if let observation = fetch.observation {
                        pageRouteDecisions[routeKey] = RouteSyncStateMachine.decide(
                            existing: previous,
                            observation: observation,
                            now: routeNow,
                            isForceManualRescan: routeForceRescan,
                            hasWorkoutChange: hasWorkoutChange
                        ).nextState
                    }
                }
            } else {
                // 跳过：这一轮既不产出任何 route 文件，也不改动状态一个字。
                //
                // 🔴 省略文件是**安全**的，前提是载荷的 manifest 声明了
                // `sourceScope: "healthkit"`（本文件 `:326` 就写着它）⇒ 服务端
                // `resolvePreserveAbsent` 判成 `preserveAbsent: true`
                // （`import-sources.ts:203`），于是 `gpx-parser.ts` 里**所有**"缺席即删除"
                // 的分支（`:306` 的 `pruneOrphanRoutes`、`:328-341` 的 `missing`、
                // `:460-475` 的 `referencedTargets` 清扫）整段不跑，已有的 `route_points`
                // 一个字节都不动。这条前提一旦不成立（例如哪天改成导出全量快照），
                // 这里的省略就会变成"把服务端的轨迹删掉"。
                routeFiles = []
            }
            // The recent window and bounded historical queue only discover late
            // routes. Without a workout change or a GPX retry, omit workout XML.
            guard hasWorkoutChange || routeForceRescan || !routeFiles.isEmpty else { continue }
            // R4b：本页先渲染进**内存缓冲** —— 写前字节闸门在页边境界定，
            // 整页放不下时一个字都不落盘（见页尾的 `budget.accepts`）。
            pageExported.append(workout)
            pageRouteCount += routeFiles.count
            pageRouteFiles.append(contentsOf: routeFiles)
            pageText += workoutXML(workout, routeNames: routeFiles.map(\.name))
        }
        // R4b 页收尾：同一字节账判定 → 通过才写（并在此时才合并路由状态与文件）。
        let pageBytes = pageText.utf8.count
        guard budget.accepts(xmlBytes: xml.offsetInFile, records: recordCount,
                             pageBytes: pageBytes, pageRecords: 0) else {
            workoutStop = .workoutBytes
            break
        }
        try write(xml, pageText)
        for (key, value) in pageRouteDecisions { routeDecisions[key] = value }
        exportedWorkouts.append(contentsOf: pageExported)
        routeCount += pageRouteCount
        routeBytes += pageRouteBytes
        files.append(contentsOf: pageRouteFiles)
        pageStart = pageEnd
        }

        // ⚠️ 这一句**刻意不并入** `DirectSyncCopy.readingIncrement`：它同时是
        // `apps/ios/tests/check-background-capabilities.py` 切出「逐 workout 轨迹循环」的
        // 定界符（`route_loop_end`，整行匹配）。改字会让那条既有门禁**新增一条失败**，而本批
        // 不改任何 .py —— 想统一它必须与那条门禁同批改。它本身是「读取」的细节文案，
        // 不属于 §10.3 明令移除的三句。
        await onProgress("正在读取心率与恢复数据")
        try Task.checkCancellation()
        let records = try await writeGlobalRecords(
            store: store, cursorData: recordCursors, forceHistory: recordsForceRescan,
            xml: xml, warnings: warnings, budget: budget,
            deletionAllocation: allocation,
            // B2：轮转起点透传（窗口 pass 不受轮转影响 —— 它恒扫全部类型）。
            typeRotationStart: typeRotationStart,
            onProgress: onProgress
        )
        recordCount += records.count
        let exportedThrough = Date()
        try write(xml, "\n</HealthData>\n")
        try xml.synchronize()

        let manifestURL = directory.appendingPathComponent("sync-manifest.json")
        // v2 adds type-scoped record UUID deletions. No absence or wall-clock
        // semantics: the same facts still have the same upload content digest.
        let manifest: [String: Any] = [
            "version": 2,
            "sourceScope": "healthkit",
            "sourceEntityType": "HKWorkoutActivityTypeRunning",
            "sourceIds": exportedWorkouts.map(workoutSyncId),
            // R3b：旧槽里能装下的（stash）与本批新删的（kept）一起发；装不下的进
            // `pendingDeletions` 回传（持久到下一批）。两段都要 **sorted**（确定性门禁）。
            "deletedSourceIds": (stashWorkoutIds + keptWorkoutIds).sorted(),
            "deletedRecords": stashRecordDeletions + records.deleted,
            "sampleTypes": ["workout", "sleep", "heart_rate", "hrv", "resting_heart_rate"]
        ]
        let manifestData = try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
        try manifestData.write(to: manifestURL, options: .atomic)
        files.append(("sync-manifest.json", manifestURL))

        // 打包是本批"读取"的最后一步（写出 ZIP 仍属于把这一批准备好），沿用同一条 §10.3 文案。
        await onProgress(DirectSyncCopy.readingIncrement)
        try Task.checkCancellation()
        let zipURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("apple-health-healthkit-\(UUID().uuidString).zip")
        do {
            try StoredZip.write(files: files, to: zipURL)
            try Task.checkCancellation()
        } catch {
            try? FileManager.default.removeItem(at: zipURL)
            throw error
        }
        return HealthKitExportResult(
            zipURL: zipURL,
            workoutCount: exportedWorkouts.count,
            recordCount: recordCount,
            // = 实际发出的删除总数（manifest 两段之和；本地自校验与回执口径）。
            deletionCount: stashRecordDeletions.count + records.deleted.count
                + stashWorkoutIds.count + keptWorkoutIds.count,
            routeCount: routeCount,
            warnings: warnings.snapshot,
            maxEndDate: exportedWorkouts.map(\.endDate).max(),
            exportedThrough: exportedThrough,
            workoutAnchor: workoutBatch.anchor,
            recordCursors: records.cursors,
            sourceScope: "healthkit",
            routeStates: routeDecisions,
            routeDiscoveryCursor: rediscovery.last,
            // 三个收集阶段各有自己的停因，**取并**：workout 侧先发生就报 workout 侧，
            // 其次记录侧，再次 route 侧。同一批里正常不会同时非空，并起来只为在异常组合下也不丢信号。
            budgetStopReason: workoutStop ?? records.budgetStopReason ?? routeStopReason,
            // 实际产物大小（P2b 本地自校验的输入）：这一句在 `</HealthData>` 与
            // `synchronize()` **之后**执行 ⇒ `offsetInFile` 就是最终盘上大小。
            xmlBytes: Int(xml.offsetInFile),
            routeBytes: routeBytes,
            // WP-12（O03）守恒余量 = 旧槽装不下的尾部（record/workout 两段）＋ 本批溢出
            // （record 侧来自 allocation、workout 侧来自 plan）。四段并集满足 partition 的
            // 守恒式：`旧 ∪ 新 = 发送 ∪ 下批`，`发送 ∩ 下批 = ∅`。
            pendingDeletions: DirectSyncPendingDeletions(
                recordDeletions: deletionPlan.pendingRecordDeletions + allocation.overflow,
                workoutIds: deletionPlan.pendingWorkoutIds + deletionPlan.overflowWorkoutIds
            ),
            // B2：下一批的轮转起点（由 `writeGlobalRecords` 算出并回传）。
            nextTypeRotationStart: records.nextTypeRotationStart
        )
    }

    private static var readTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = [
            HKObjectType.workoutType(),
            HKSeriesType.workoutRoute(),
            HKQuantityType.quantityType(forIdentifier: .heartRate)!,
            HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning)!,
            HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!,
            HKQuantityType.quantityType(forIdentifier: .stepCount)!,
            HKQuantityType.quantityType(forIdentifier: .runningSpeed)!,
            HKQuantityType.quantityType(forIdentifier: .runningPower)!,
            HKQuantityType.quantityType(forIdentifier: .runningStrideLength)!,
            HKQuantityType.quantityType(forIdentifier: .runningVerticalOscillation)!,
            HKQuantityType.quantityType(forIdentifier: .runningGroundContactTime)!,
            HKQuantityType.quantityType(forIdentifier: .restingHeartRate)!,
            HKQuantityType.quantityType(forIdentifier: .heartRateVariabilitySDNN)!,
            HKQuantityType.quantityType(forIdentifier: .vo2Max)!,
            HKQuantityType.quantityType(forIdentifier: .bodyMass)!,
            HKQuantityType.quantityType(forIdentifier: .respiratoryRate)!,
            HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!
        ]
        if let recovery = HKQuantityType.quantityType(forIdentifier: .heartRateRecoveryOneMinute) {
            types.insert(recovery)
        }
        if let physicalEffort = HKQuantityType.quantityType(forIdentifier: .physicalEffort) {
            types.insert(physicalEffort)
        }
        if let wrist = HKQuantityType.quantityType(forIdentifier: .appleSleepingWristTemperature) {
            types.insert(wrist)
        }
        if let biologicalSex = HKObjectType.characteristicType(forIdentifier: .biologicalSex) {
            types.insert(biologicalSex)
        }
        if let birth = HKObjectType.characteristicType(forIdentifier: .dateOfBirth) {
            types.insert(birth)
        }
        return types
    }

    /// Observe every authorized record type, not only sleep/HRV/resting HR.
    /// Historical corrections to workout-associated quantities may otherwise
    /// have no workout notification to wake the existing delivery pipeline.
    static var recordSampleTypes: [HKSampleType] {
        readTypes.compactMap { type -> HKSampleType? in
            guard type is HKQuantityType || type is HKCategoryType else { return nil }
            return type as? HKSampleType
        }.sorted { $0.identifier < $1.identifier }
    }

    private static func runningWorkouts(
        store: HKHealthStore,
        from startDate: Date?,
        anchorData: Data?
    ) async throws -> (added: [HKWorkout], deleted: [HKDeletedObject], anchor: Data?, changedUUIDs: Set<String>) {
        let stored = anchorData.flatMap(decodeAnchor)
        guard anchorData == nil || stored != nil else {
            throw HealthKitExportError.invalidWorkoutAnchor
        }
        var predicates = [HKQuery.predicateForWorkouts(with: .running)]
        if stored == nil, let startDate {
            predicates.append(HKQuery.predicateForSamples(withStart: startDate, end: nil, options: .strictStartDate))
        }
        do {
            // R4b（2026-10-16）：query 级分页 —— 单次 `HKAnchoredObjectQuery` 不再无界取回
            // 全部历史 workout（回填期可能上千条）。锚点逐页单调前进、累积到空页为止；
            // 与旧行为语义等价（全量），但每一页都有界，内存峰值与查询时长可控。
            var batchAdded: [HKWorkout] = []
            var batchDeleted: [HKDeletedObject] = []
            var pageAnchor = stored
            let batchPredicate = NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
            while true {
                let page = try await anchoredWorkouts(
                    store: store,
                    anchor: pageAnchor,
                    predicate: batchPredicate,
                    limit: Self.workoutPageLimit
                )
                batchAdded.append(contentsOf: page.added)
                batchDeleted.append(contentsOf: page.deleted)
                pageAnchor = page.next
                if page.added.isEmpty && page.deleted.isEmpty { break }
            }
            let batch = (added: batchAdded, deleted: batchDeleted, next: pageAnchor)
            var merged: [UUID: HKWorkout] = [:]
            for workout in batch.added {
                merged[workout.uuid] = workout
            }
            if stored != nil {
                let backfillStart = (startDate ?? Date()).addingTimeInterval(-routeBackfillWindow)
                let recentPredicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
                    HKQuery.predicateForWorkouts(with: .running),
                    HKQuery.predicateForSamples(withStart: backfillStart, end: nil, options: .strictStartDate)
                ])
                let recent: [HKWorkout] = try await samples(
                    type: .workoutType(),
                    predicate: recentPredicate,
                    store: store
                )
                for workout in recent {
                    merged[workout.uuid] = workout
                }
            }
            let workouts = merged.values.sorted { left, right in
                if left.startDate == right.startDate { return left.uuid.uuidString < right.uuid.uuidString }
                return left.startDate < right.startDate
            }
            // 页循环至少执行一次 ⇒ `pageAnchor` 必然已被 `page.next` 赋过值；
            // `?? fromValue(0)` 只是给类型系统的兜底（不可达 —— 真到底的空页也返回非 nil 锚）。
            let finalAnchor = pageAnchor ?? HKQueryAnchor(fromValue: 0)
            return (
                workouts, batch.deleted, encodeAnchor(finalAnchor),
                Set(batch.added.map(routeFileWorkoutId))
            )
        } catch {
            if isAuthorizationError(error) {
                throw HealthKitExportError.notAuthorized
            }
            // 🔴 锁屏是**暂时**条件，不是"这一批数据坏了"。
            //
            // 这里是"绝不把锁屏当成空数据"的**第二道**锁（第一道是 `HealthKitSync.performSync`
            // 进函数时的 `isProtectedDataAvailable` 预检查，挡的是"进来时就已经锁着"）；
            // 这里挡的是"检查通过之后、查询途中设备被锁上"——锁屏可以发生在任意两次 await 之间，
            // 所以两道都需要，而不是二选一。
            //
            // 注意 `optionalSamples` 只吞 `isAuthorizationError` 与 `isNoDataError`，
            // 而锁屏错误的码与这两个都不同 ⇒ 它一定会抛到这里，不会被静默降级成"空结果"。
            if isDatabaseInaccessible(error) {
                throw HealthKitExportError.databaseLocked
            }
            throw error
        }
    }

    private static func knownRunningWorkouts(store: HKHealthStore, uuids: [String]) async throws -> [HKWorkout] {
        let ids = Set(uuids.compactMap(UUID.init(uuidString:)))
        guard !ids.isEmpty else { return [] }
        let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
            HKQuery.predicateForWorkouts(with: .running),
            HKQuery.predicateForObjects(with: ids)
        ])
        do {
            return try await samples(type: .workoutType(), predicate: predicate, store: store)
        } catch {
            if isDatabaseInaccessible(error) { throw HealthKitExportError.databaseLocked }
            if isAuthorizationError(error) { throw HealthKitExportError.notAuthorized }
            throw error
        }
    }

    private static func workoutXML(_ workout: HKWorkout, routeNames: [String]) -> String {
        let source = workout.sourceRevision.source.name
        let version = workout.sourceRevision.version ?? "1"
        let device = deviceDescription(workout.device) ?? workout.device?.name ?? workout.sourceRevision.productType ?? "Watch"
        let durationMinutes = workout.duration / 60
        let created = workout.startDate
        var body = """

          <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="\(format(durationMinutes))" durationUnit="min" sourceName="\(escape(source))" sourceVersion="\(escape(version))" creationDate="\(appleDate(created))" startDate="\(appleDate(workout.startDate))" endDate="\(appleDate(workout.endDate))" device="\(escape(device))">
            <MetadataEntry key="HKIndoorWorkout" value="\(isIndoor(workout) ? "1" : "0")"/>
        """
        body += "    <MetadataEntry key=\"HKMetadataKeySyncIdentifier\" value=\"\(escape(workoutSyncId(workout)))\"/>\n"
        body += "    <MetadataEntry key=\"RAIHealthKitWorkoutUUID\" value=\"\(escape(workout.uuid.uuidString))\"/>\n"
        body += metadataXML(workout)
        body += workoutStructureDiagnosticXML(workout)
        body += workoutEventXML(workout)
        if let distance = statistic(workout, HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning)!, unit: .meter()) {
            body += statisticXML(
                type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
                workout: workout,
                sum: distance / 1000,
                unit: "km"
            )
        }
        if let energy = statistic(workout, HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!, unit: .kilocalorie()) {
            body += statisticXML(
                type: "HKQuantityTypeIdentifierActiveEnergyBurned",
                workout: workout,
                sum: energy,
                unit: "kcal"
            )
        }
        body += heartRateStatisticXML(workout)
        for name in routeNames {
            body += """
                <WorkoutRoute sourceName="\(escape(source))" sourceVersion="\(escape(version))" creationDate="\(appleDate(created))" startDate="\(appleDate(workout.startDate))" endDate="\(appleDate(workout.endDate))">
                  <FileReference path="\(escape(name))"/>
                </WorkoutRoute>
            """
        }
        body += "  </Workout>"
        return body
    }

    /// A one-off diagnostic for the segment panel (2026-09-15).
    ///
    /// The detail page's 课表分段 panel used to treat the Watch's lap/segment
    /// events as the prescription's steps. A real run then turned out to carry
    /// *two overlapping partitions of the whole workout* (≈1 km and ≈1.6 km),
    /// and nothing downstream can tell which layer each partition came from:
    /// `HKWorkout.workoutEvents` is a single flat list with no parent recorded.
    ///
    /// `HKWorkoutActivity` is the only API that names the layers — and, because an
    /// activity carries no `WorkoutEvent` of its own, it is also the one place a
    /// structured workout's *steps* could be recorded without ever appearing in
    /// the event list. So this answers both questions at once:
    ///
    /// - `activities` non-empty and its boundaries near the prescription's
    ///   steps (start+300 s, start+≈1 281 s) ⇒ the steps are measurable, and the
    ///   panel can stop replaying the plan onto the speed track;
    /// - `activities` empty ⇒ the steps live only inside the Fitness app, and the
    ///   replay is the ceiling. Either answer is decisive; hence one export.
    ///
    /// Shipped as an ordinary `<MetadataEntry>` so it needs no contract, parser or
    /// schema change: it lands in `workouts.metadata_json` and one query reads it.
    /// Offsets are milliseconds from the workout's start — exact, compact, and
    /// independent of how the XML later formats dates.
    private static func workoutStructureDiagnosticXML(_ workout: HKWorkout) -> String {
        let events = workout.workoutEvents ?? []
        let activities = workout.workoutActivities
        // Gated on the runs actually in question: the entry joins the workout's
        // content hash, so emitting it for every workout would mark all ~274 of
        // them updated on the next incremental import for no gain.
        guard !events.isEmpty || !activities.isEmpty else { return "" }
        let startedAt = workout.startDate
        func offsetMs(_ date: Date) -> Int {
            Int(((date.timeIntervalSince(startedAt)) * 1000).rounded())
        }
        func describe(_ event: HKWorkoutEvent) -> [String: Any] {
            [
                "type": eventTypeName(event.type) ?? "unknown",
                "typeRaw": Int(event.type.rawValue),
                "startMs": offsetMs(event.dateInterval.start),
                "durationMs": Int((event.dateInterval.duration * 1000).rounded()),
                // Keys only: an event's metadata values are arbitrary objects, and
                // the keys are what would reveal a Watch-side lap tag (for example
                // `HKMetadataKeyLapLength`, HKMetadata.h:301) if one is present.
                "metadataKeys": event.metadata.map { Array($0.keys).sorted() } ?? []
            ]
        }
        let activityPayload: [[String: Any]] = activities.map { activity in
            [
                // The activity's own identity: two overlapping lap partitions would
                // most plausibly be two activities, and this pairs each partition
                // with the layer that claims it.
                "uuid": activity.uuid.uuidString,
                "startMs": offsetMs(activity.startDate),
                "durationMs": Int((activity.duration * 1000).rounded()),
                "activityTypeRaw": Int(activity.workoutConfiguration.activityType.rawValue),
                "locationRaw": Int(activity.workoutConfiguration.locationType.rawValue),
                // Keys only: the values of an activity's metadata are arbitrary and
                // may not survive JSON serialization, and the keys are what tell us
                // whether watchOS labelled the step.
                "metadataKeys": activity.metadata.map { Array($0.keys).sorted() } ?? [],
                // Note: `HKWorkoutActivity.workoutEvents` is non-optional, unlike
                // `HKWorkout.workoutEvents`.
                "events": activity.workoutEvents.map(describe)
            ]
        }
        let payload: [String: Any] = [
            "activityCount": activities.count,
            "activities": activityPayload,
            "eventCount": events.count,
            "events": events.map(describe)
        ]
        guard
            let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
            let json = String(data: data, encoding: .utf8)
        else { return "" }
        return "    <MetadataEntry key=\"RAIWorkoutStructureDiagV1\" value=\"\(escape(json))\"/>\n"
    }

    private static func workoutEventXML(_ workout: HKWorkout) -> String {
        var body = ""
        for event in workout.workoutEvents ?? [] {
            guard let typeName = eventTypeName(event.type) else { continue }
            var attrs = "type=\"\(typeName)\" date=\"\(appleDate(event.dateInterval.start))\""
            let duration = event.dateInterval.duration
            if duration > 0 {
                attrs += " duration=\"\(format(duration))\" durationUnit=\"s\""
            }
            body += "    <WorkoutEvent \(attrs)/>\n"
        }
        return body
    }


    private static func eventTypeName(_ type: HKWorkoutEventType) -> String? {
        switch type {
        case .pause: return "HKWorkoutEventTypePause"
        case .resume: return "HKWorkoutEventTypeResume"
        case .motionPaused: return "HKWorkoutEventTypeMotionPaused"
        case .motionResumed: return "HKWorkoutEventTypeMotionResumed"
        // Lap and segment are the only event types that carry a nonzero duration
        // (HKWorkout.h), i.e. they are the Watch's own record of structured
        // workout boundaries. Dropping them left every downstream consumer with
        // no choice but the arithmetic kilometre split.
        case .lap: return "HKWorkoutEventTypeLap"
        case .marker: return "HKWorkoutEventTypeMarker"
        case .segment: return "HKWorkoutEventTypeSegment"
        default: return nil
        }
    }

    private static func statistic(
        _ workout: HKWorkout,
        _ type: HKQuantityType,
        unit: HKUnit
    ) -> Double? {
        workout.statistics(for: type)?.sumQuantity()?.doubleValue(for: unit)
            ?? workout.statistics(for: type)?.averageQuantity()?.doubleValue(for: unit)
    }

    private static func heartRateStatisticXML(_ workout: HKWorkout) -> String {
        let type = HKQuantityType.quantityType(forIdentifier: .heartRate)!
        guard let stats = workout.statistics(for: type) else { return "" }
        let unit = HKUnit.count().unitDivided(by: .minute())
        let average = stats.averageQuantity()?.doubleValue(for: unit)
        let minimum = stats.minimumQuantity()?.doubleValue(for: unit)
        let maximum = stats.maximumQuantity()?.doubleValue(for: unit)
        guard average != nil || minimum != nil || maximum != nil else { return "" }
        return statisticXML(
            type: "HKQuantityTypeIdentifierHeartRate",
            workout: workout,
            average: average,
            minimum: minimum,
            maximum: maximum,
            unit: "count/min"
        )
    }

    private static func statisticXML(
        type: String,
        workout: HKWorkout,
        sum: Double? = nil,
        average: Double? = nil,
        minimum: Double? = nil,
        maximum: Double? = nil,
        unit: String
    ) -> String {
        var attrs = "type=\"\(type)\" startDate=\"\(appleDate(workout.startDate))\" endDate=\"\(appleDate(workout.endDate))\" unit=\"\(unit)\""
        if let sum { attrs += " sum=\"\(format(sum))\"" }
        if let average { attrs += " average=\"\(format(average))\"" }
        if let minimum { attrs += " minimum=\"\(format(minimum))\"" }
        if let maximum { attrs += " maximum=\"\(format(maximum))\"" }
        return "    <WorkoutStatistics \(attrs)/>\n"
    }

    private static func writeGlobalRecords(
        store: HKHealthStore,
        cursorData: Data?,
        forceHistory: Bool,
        xml: FileHandle,
        warnings: WarningBag,
        budget: DirectSyncBatchBudget,
        deletionAllocation: DirectSyncDeletionAllocation,
        // B2：类型轮转起点（由 `exportArchive` 透传；见该函数参数说明）。
        typeRotationStart: Int,
        onProgress: @escaping @Sendable (String) async -> Void
    ) async throws -> (
        count: Int, cursors: Data, deleted: [[String: String]],
        budgetStopReason: HealthKitExportResult.BudgetStopReason?,
        nextTypeRotationStart: Int
    ) {
        // Corrupt cursors fail closed. They are never silently turned into a
        // window query; a missing type starts from nil and reads all history.
        var cursors = try cursorData.map {
            try JSONDecoder().decode([String: HealthKitRecordCursor].self, from: $0)
        } ?? [:]
        let now = Date()
        var count = 0
        // 本轮被预算停住的**形态**（S2.5）；`nil` = 没被停住。触顶后**不再开始新类型**，
        // 已读到的部分照常保留（各自游标推进到已提交的页边界）。
        var budgetStopReason: HealthKitExportResult.BudgetStopReason?
        var deletions: [String: Set<String>] = [:]
        var quantities: [(HKQuantityType, HKUnit, String, String)] = [
            (HKQuantityType.quantityType(forIdentifier: .heartRate)!, HKUnit.count().unitDivided(by: .minute()), "HKQuantityTypeIdentifierHeartRate", "count/min"),
            (HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning)!, .meter(), "HKQuantityTypeIdentifierDistanceWalkingRunning", "m"),
            (HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned)!, .kilocalorie(), "HKQuantityTypeIdentifierActiveEnergyBurned", "kcal"),
            (HKQuantityType.quantityType(forIdentifier: .stepCount)!, .count(), "HKQuantityTypeIdentifierStepCount", "count"),
            (HKQuantityType.quantityType(forIdentifier: .runningSpeed)!, HKUnit.meter().unitDivided(by: .second()), "HKQuantityTypeIdentifierRunningSpeed", "m/s"),
            (HKQuantityType.quantityType(forIdentifier: .runningPower)!, HKUnit.watt(), "HKQuantityTypeIdentifierRunningPower", "W"),
            (HKQuantityType.quantityType(forIdentifier: .runningStrideLength)!, .meter(), "HKQuantityTypeIdentifierRunningStrideLength", "m"),
            (HKQuantityType.quantityType(forIdentifier: .runningVerticalOscillation)!, HKUnit.meterUnit(with: .centi), "HKQuantityTypeIdentifierRunningVerticalOscillation", "cm"),
            (HKQuantityType.quantityType(forIdentifier: .runningGroundContactTime)!, HKUnit.secondUnit(with: .milli), "HKQuantityTypeIdentifierRunningGroundContactTime", "ms")
        ]
        if let physicalEffort = HKQuantityType.quantityType(forIdentifier: .physicalEffort) {
            let unit = HKUnit.kilocalorie().unitDivided(by: HKUnit.hour().unitMultiplied(by: .gramUnit(with: .kilo)))
            quantities.append((
                physicalEffort,
                unit,
                "HKQuantityTypeIdentifierPhysicalEffort",
                "kcal/hr·kg"
            ))
        }
        quantities.append(contentsOf: [
            (HKQuantityType.quantityType(forIdentifier: .restingHeartRate)!, HKUnit.count().unitDivided(by: .minute()), "HKQuantityTypeIdentifierRestingHeartRate", "count/min"),
            (HKQuantityType.quantityType(forIdentifier: .heartRateVariabilitySDNN)!, HKUnit.secondUnit(with: .milli), "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", "ms"),
            (HKQuantityType.quantityType(forIdentifier: .vo2Max)!, HKUnit.literUnit(with: .milli).unitDivided(by: HKUnit.gramUnit(with: .kilo).unitMultiplied(by: .minute())), "HKQuantityTypeIdentifierVO2Max", "mL/min·kg"),
            (HKQuantityType.quantityType(forIdentifier: .bodyMass)!, .gramUnit(with: .kilo), "HKQuantityTypeIdentifierBodyMass", "kg"),
            (HKQuantityType.quantityType(forIdentifier: .respiratoryRate)!, HKUnit.count().unitDivided(by: .minute()), "HKQuantityTypeIdentifierRespiratoryRate", "count/min")
        ])
        if let wrist = HKQuantityType.quantityType(forIdentifier: .appleSleepingWristTemperature) {
            quantities.append((
                wrist,
                .degreeCelsius(),
                "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
                "degC"
            ))
        }
        if let recovery = HKQuantityType.quantityType(forIdentifier: .heartRateRecoveryOneMinute) {
            quantities.append((
                recovery,
                HKUnit.count().unitDivided(by: .minute()),
                "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute",
                "count/min"
            ))
        }

        var descriptors: [(HKSampleType, HKUnit?, String, String?)] = quantities.map {
            ($0.0, $0.1, $0.2, $0.3)
        }
        descriptors.append((HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!, nil,
                            "HKCategoryTypeIdentifierSleepAnalysis", nil))
        // B1（2026-10-16）**近期窗口 pass**：每个类型先用一次**有界**查询把近 48h 数据送到
        // —— 历史重放可能持续数天，而训练详情/恢复评估要用的近期心率/睡眠不能排在队尾。
        // 🔴 三条纪律：
        //   ① 窗口**独立于正式 anchor**（它自己记账在 `recentWindowReadAt`；正式锚只由下面的
        //      历史/增量段推进）；
        //   ② 窗口**绝不**把整批预算吃光 —— 装不下就跳过该类型（不推进记账，下批重试），
        //      历史段照跑（`continue`，不是 `break`）；
        //   ③ 删除事件**不**由窗口负责（无锚点查询看不到删除；删除仍归增量流/历史段）。
        for (type, unit, xmlType, xmlUnit) in descriptors {
            try Task.checkCancellation()
            let previousWindow = cursors[xmlType]
            let windowStart = max(
                now.addingTimeInterval(-Self.recentWindowLookback),
                (previousWindow?.recentWindowReadAt ?? .distantPast)
                    .addingTimeInterval(-Self.recentWindowOverlap)
            )
            let windowPredicate = HKQuery.predicateForSamples(
                withStart: windowStart, end: nil, options: .strictStartDate
            )
            do {
                let recent: [HKSample] = try await recentSamples(
                    type: type, predicate: windowPredicate,
                    limit: Self.recentWindowLimit, store: store
                )
                if !recent.isEmpty {
                    let page = try renderedRecordPage(
                        added: recent, deleted: [], xmlType: xmlType, unit: unit, xmlUnit: xmlUnit
                    )
                    // 同一字节账：装不下 ⇒ 该类型窗口本轮跳过（**不**推进记账）。
                    if budget.accepts(xmlBytes: xml.offsetInFile, records: count,
                                      pageBytes: page.data.count, pageRecords: page.recordCount) {
                        try xml.write(contentsOf: page.data)
                        count += page.recordCount
                        // 读完整窗才推进记账（空窗同样推进：避免每批重复空查询）。
                        if let previousWindow {
                            cursors[xmlType] = HealthKitRecordCursor(
                                anchor: previousWindow.anchor,
                                historyReadAt: previousWindow.historyReadAt,
                                historyReplayPhase: previousWindow.historyReplayPhase,
                                recentWindowReadAt: now
                            )
                        }
                    }
                } else if let previousWindow {
                    cursors[xmlType] = HealthKitRecordCursor(
                        anchor: previousWindow.anchor,
                        historyReadAt: previousWindow.historyReadAt,
                        historyReplayPhase: previousWindow.historyReplayPhase,
                        recentWindowReadAt: now
                    )
                }
            } catch {
                // 与类型循环同口径：授权/无数据 ⇒ 跳过该类型窗口（下批重试）；
                // 库不可达 ⇒ 抛（绝不把锁屏当成空窗口）。
                if isAuthorizationError(error) || isNoDataError(error) { continue }
                if isDatabaseInaccessible(error) { throw HealthKitExportError.databaseLocked }
                throw error
            }
        }
        // B2（2026-10-16）：从**持久化的轮转起点**开始环绕 —— 固定序下排尾的类型（睡眠最典型）
        // 在"预算总被前排类型耗尽"时永远读不到。每批换起点，N 批内每个类型都轮到头位。
        // `index` 仍是环绕到的**实际下标**；进度文案改用 `offset + 1`（处理的第几个）。
        var processedTypeCount = 0
        for offset in 0..<descriptors.count {
            let index = (typeRotationStart + offset) % descriptors.count
            let descriptor = descriptors[index]
            // 预算在**上一个类型**停下 ⇒ 本轮不再开始新类型（未处理的类型保持旧游标，
            // `hasMorePages` 冒泡给上层 —— S2.1 的"未处理类型不动"纪律）。
            if budgetStopReason != nil { break }
            processedTypeCount = offset + 1
            let (type, unit, xmlType, xmlUnit) = descriptor
            try Task.checkCancellation()
            // 🔴 逐类型进度。这一段是整轮导出里**最长**的一段 —— 全量历史时单个类型
            // （心率最典型）可以跑上几分钟，而它此前在界面上**一句话都不说**：用户看到的
            // 是一句静止的「正在读取心率与恢复数据」，没有任何东西能区分"还在读"与"已经卡死"
            // （2026-10-11 线上实测：手机端停在这里十几分钟，界面零变化，看起来像冻住）。
            //
            // 位置放在 `checkCancellation()` 之后、真正查询之前：这样每次上报都对应
            // "确实要开始读这一类型了"，而不是一句凭空的乐观话术。
            // ⚠️ 进度文案**不进载荷**：它只走 `onProgress`，`export.xml` / manifest 的字节
            // 由 `check-export-determinism.py` 钉着，加这一段不得改变任何一个字节。
            await onProgress("正在读取健康记录 \(offset + 1)/\(descriptors.count)（已 \(count) 条）")
            let previous = cursors[xmlType]
            let decoded = previous.flatMap { decodeAnchor($0.anchor) }
            guard previous == nil || decoded != nil || forceHistory else {
                throw HealthKitExportError.invalidRecordAnchor
            }
            let history = previous == nil || decoded == nil
                || previous!.needsHistoryRead(now: now, force: forceHistory)
            do {
                // 本轮的段计划由 `RecordReplayPlan`（纯逻辑，回归逐组合钉着）决定：
                // 初次重放 = 先增量段（保住删除事件）再历史段（从头）；上轮中断在历史段 =
                // 只续历史段断点。这里只做接线。
                let resumingHistoryPhase = previous?.historyReplayPhase == .history
                let segments = RecordReplayPlan.segments(
                    decodedAvailable: decoded != nil,
                    history: history,
                    resumingHistoryPhase: resumingHistoryPhase
                )
                let starts: [HKQueryAnchor?] = segments.map { segment in
                    switch segment {
                    case .incremental, .historyResume: return decoded
                    case .historyFromScratch: return nil
                    }
                }
                var next: HKQueryAnchor?
                var interruptedPhase: HealthKitRecordCursor.HistoryReplayPhase?
                // 本类型是否出现过"一段一页都没读"（S2.5）。
                var stoppedBeforePage = false
                for (segmentIndex, start) in starts.enumerated() {
                    // 🔴 写前判定（S2.5）：整页先渲染进内存，`budget.accepts` 通过才落盘。
                    let outcome = try await HealthKitRecordCursor.drain(
                        from: start,
                        pageLimit: recordPageLimit,
                        query: { anchor, limit in
                            try await anchoredRecords(store: store, type: type, anchor: anchor, limit: limit)
                        },
                        render: { added, deleted in
                            try renderedRecordPage(
                                added: added, deleted: deleted,
                                xmlType: xmlType, unit: unit, xmlUnit: xmlUnit
                            )
                        },
                        decide: { page, _ in
                            // 只读不写：判定与收缩估算都基于**已提交**的字节/条数。
                            if budget.accepts(
                                xmlBytes: xml.offsetInFile, records: count,
                                pageBytes: page.data.count, pageRecords: page.recordCount
                            ) {
                                return .accept
                            }
                            return .retryWithLimit(budget.shrinkLimit(
                                pageBytes: page.data.count, pageRecords: page.recordCount,
                                usedXmlBytes: xml.offsetInFile, usedRecords: count
                            ))
                        },
                        commit: { page, _ in
                            // 字节与删除事件**一起**提交：被丢弃的页其删除必须留到下一轮。
                            try xml.write(contentsOf: page.data)
                            // R3b：删除按 `deletionAllocation` 截断——装得下的进本批 manifest，
                            // 装不下的进溢出（回传持久、下一批先发）。**绝不丢弃**：
                            // 锚点随本页推进后，未发送的 uuid 不会再被查询返回。
                            for uuid in page.deletions {
                                if deletionAllocation.allocate(uuid: uuid, type: xmlType) {
                                    deletions[xmlType, default: []].insert(uuid)
                                }
                            }
                            count += page.recordCount
                        }
                    )
                    // 🔴 只在锚点有效时替换：`.historyFromScratch` 段的起点是 `nil`，
                    // 若该段在**页首**就被预算挡住（一页都没读），返回的锚点仍是 `nil`。
                    // 无条件赋值会把一次**正常的分批**变成 `missingRecordAnchor` 整批失败。
                    if let advanced = outcome.anchor { next = advanced }
                    stoppedBeforePage = stoppedBeforePage || outcome.stoppedBeforePage
                    // `.recordNone` 优先：它表示"这一段一条都没读进去"，是更强的信号。
                    if outcome.stoppedBeforePage { budgetStopReason = .recordNone }
                    if outcome.hasMorePages {
                        if budgetStopReason == nil { budgetStopReason = .recordPage }
                        interruptedPhase = RecordReplayPlan.interruptedPhase(
                            segments: segments, interruptedIndex: segmentIndex)
                        break
                    }
                }
                guard let next else {
                    // 🔴 没有可提交的锚点有两种成因，必须分开：
                    //   ① 预算在**页首**把这一段挡住了 ⇒ 这是**正常分批**：该类型的游标原样不动
                    //      （包括"首次读取、还没有游标"），下一批重新来。首次读取的
                    //      `.historyFromScratch` 段起点就是 `nil`，抛错会把分批变成整批失败。
                    //   ② 真读到底却拿不到锚点 ⇒ 异常，按旧行为抛。
                    if stoppedBeforePage { continue }
                    throw HealthKitExportError.missingRecordAnchor
                }
                let encoded = try NSKeyedArchiver.archivedData(withRootObject: next, requiringSecureCoding: true)
                cursors[xmlType] = HealthKitRecordCursor(
                    anchor: encoded,
                    // 重放完成（未被预算截断）才把 `historyReadAt` 推到 `now`；中断时保留旧值 ——
                    // "未完成"由 `historyReplayPhase` 承载，下轮据此续段（R-03 防护）。
                    historyReadAt: (history && interruptedPhase == nil) ? now : (previous?.historyReadAt ?? now),
                    historyReplayPhase: interruptedPhase,
                    // B1：窗口记账必须**透传** —— 窗口 pass 已在本循环之前写过它（`previous`
                    // 读到的就是那时的值）；不带上就会被这次构造覆盖，症状是每批重扫整个 48h 窗。
                    recentWindowReadAt: previous?.recentWindowReadAt
                )
            } catch {
                if isAuthorizationError(error) || isNoDataError(error) {
                    warnings.add("部分健康记录暂不可读取；已保留该类型的同步游标")
                    // Do not advance a denied/unavailable type, even if earlier
                    // pages were read. Retry from the same committed cursor.
                    continue
                }
                if isDatabaseInaccessible(error) { throw HealthKitExportError.databaseLocked }
                throw error
            }
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let deleted = deletions.keys.sorted().flatMap { type in
            deletions[type]!.sorted().map { ["type": type, "uuid": $0] }
        }
        // B2：下一批的轮转起点 = 本批已开始处理的类型数（环绕推进；全批完成时回到原起点）。
        let nextRotation = (typeRotationStart + processedTypeCount) % max(1, descriptors.count)
        return (count, try encoder.encode(cursors), deleted, budgetStopReason, nextRotation)
    }

    /// 一页记录的**渲染**（S2.5 写前判定）：把这一页要写进 `export.xml` 的**全部字节**先在内存里
    /// 拼出来，再交给 `decide` 判定。拼接顺序与逐条写句柄**完全一致**，因此字节**逐字节等价**
    /// （`check-export-determinism.py` / `test:ios:live` 钉着导出的确定性；改这里要重跑那条门禁）。
    private static func renderedRecordPage(
        added: [HKSample],
        deleted: [HKDeletedObject],
        xmlType: String,
        unit: HKUnit?,
        xmlUnit: String?
    ) throws -> RenderedRecordPage {
        var text = ""
        for sample in added.sorted(by: {
            $0.startDate == $1.startDate ? $0.uuid.uuidString < $1.uuid.uuidString : $0.startDate < $1.startDate
        }) {
            try Task.checkCancellation()
            if let sample = sample as? HKQuantitySample, let unit, let xmlUnit {
                text += recordXML(sample, type: xmlType, unit: unit, xmlUnit: xmlUnit)
            } else if let sample = sample as? HKCategorySample {
                var attrs = "type=\"\(xmlType)\" sourceName=\"\(escape(sample.sourceRevision.source.name))\" sourceVersion=\"\(escape(sample.sourceRevision.version ?? "1"))\""
                if let device = deviceDescription(sample.device) { attrs += " device=\"\(escape(device))\"" }
                attrs += " value=\"\(sleepName(sample.value))\" creationDate=\"\(appleDate(sample.startDate))\" startDate=\"\(appleDate(sample.startDate))\" endDate=\"\(appleDate(sample.endDate))\""
                text += "\n          <Record \(attrs)>\(sampleMetadataXML(sample))</Record>"
            } else {
                throw HealthKitExportError.missingRecordAnchor
            }
        }
        return RenderedRecordPage(
            data: Data(text.utf8),
            deletions: deleted.map { $0.uuid.uuidString.lowercased() },
            recordCount: added.count
        )
    }

    private static func anchoredRecords(
        store: HKHealthStore, type: HKSampleType, anchor: HKQueryAnchor?, limit: Int
    ) async throws -> (added: [HKSample], deleted: [HKDeletedObject], next: HKQueryAnchor) {
        let box = QueryContinuation<(added: [HKSample], deleted: [HKDeletedObject], next: HKQueryAnchor)>()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            let result = try await withCheckedThrowingContinuation { continuation in
                box.set(continuation)
                let query = HKAnchoredObjectQuery(type: type, predicate: nil, anchor: anchor, limit: limit) {
                    _, samples, deleted, next, error in
                    if let error { box.resume(throwing: error); return }
                    // 🔴 这条 guard 的**前提**没有被验证过（2026-10-09 审查 🟡5）：查询"没有返回
                    // 任何对象"时 completion 给的 anchor 是否为 nil，只有 Apple 文档一句可读
                    // （读得出 nil 可达），没有实测；同文件的 anchoredWorkouts 对同一情形做了
                    // **相反**处置（HKQueryAnchor(fromValue: 0) 兜底而不是抛错），两处不一致说明
                    // "nil 是硬错误"是当初的选择、不是被证明过的事实。结构门禁钉的是**这个决定**、
                    // 不是它的前提 ⇒ 门禁全绿不等于 nil 不可达。若 nil 真的可达，整批记录同步会
                    // **永久失败**：每轮都在这里抛同一个错、游标永不推进，而界面只显示同步失败、
                    // 不会提示"有记录被跳过"。判定手段＝挑一个**零样本**记录类型跑一次导出，看
                    // completion 是否给出 nil（需真机 + HealthKit 读授权，模拟器替代不了）。
                    // ⚠️ 拿到该结论之前**不要**改成兜 nil：归零会让游标每轮全量重读（另一个
                    // 缺陷），且违反"绝不把读不到当空数据推进 anchor"的既有纪律。
                    // 见 docs/IOS_NATIVE_SYNC_PROTOCOL.md「仍需真机验收的边界」。
                    guard let next else {
                        box.resume(throwing: HealthKitExportError.missingRecordAnchor); return
                    }
                    box.resume(returning: (samples ?? [], deleted ?? [], next))
                }
                box.execute(query, on: store)
            }
            try Task.checkCancellation()
            return result
        } onCancel: { box.cancel() }
    }

    private static func optionalSamples<T: HKSample>(
        type: HKSampleType,
        predicate: NSPredicate?,
        store: HKHealthStore,
        warnings: WarningBag,
        deniedMessage: String
    ) async throws -> [T] {
        do {
            return try await samples(type: type, predicate: predicate, store: store)
        } catch {
            if isAuthorizationError(error) {
                warnings.add(deniedMessage)
                return []
            }
            if isNoDataError(error) {
                return []
            }
            throw error
        }
    }

    /// B1：窗口查询 —— 时间窗内**最新 N 条**（降序 + 有界 limit）。与 `samples` 的差别只有
    /// 两处：`limit` 有界、排序**降序**（近期优先；渲染侧 `renderedRecordPage` 会再按
    /// startDate 升序重排，`export.xml` 的字节确定性不受本排序影响）。
    ///
    /// 🔴 为什么不用 `anchoredRecords`（HKAnchoredObjectQuery）：nil 锚点返回的是**插入序**
    /// 的前 N 条（"最早插入的"），与"近期优先"正好相反；且滚动时间窗与持久 anchor 的
    /// 复用语义不搭（predicate 漂移时结果不可依赖）。窗口用"无锚点 + 滚动谓词"反而简单正确。
    private static func recentSamples<T: HKSample>(
        type: HKSampleType,
        predicate: NSPredicate,
        limit: Int,
        store: HKHealthStore
    ) async throws -> [T] {
        let box = QueryContinuation<[T]>()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            let result = try await withCheckedThrowingContinuation { continuation in
                box.set(continuation)
                let query = HKSampleQuery(
                    sampleType: type,
                    predicate: predicate,
                    limit: limit,
                    sortDescriptors: [
                        NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false),
                        NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
                    ]
                ) { _, samples, error in
                    if let error {
                        box.resume(throwing: error)
                        return
                    }
                    box.resume(returning: (samples as? [T]) ?? [])
                }
                box.execute(query, on: store)
            }
            try Task.checkCancellation()
            return result
        } onCancel: {
            box.cancel()
        }
    }

    private static func samples<T: HKSample>(
        type: HKSampleType,
        predicate: NSPredicate?,
        store: HKHealthStore
    ) async throws -> [T] {
        let box = QueryContinuation<[T]>()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            let result = try await withCheckedThrowingContinuation { continuation in
                box.set(continuation)
                let query = HKSampleQuery(
                    sampleType: type,
                    predicate: predicate,
                    limit: HKObjectQueryNoLimit,
                    // 🔴 Every query is sorted, not just the workout one. The
                    // records this returns are written to `export.xml` in the
                    // order HealthKit hands them over, and an unsorted query
                    // ("unspecified" per the HKSampleQuery docs) is free to
                    // differ between calls. The parsed row set is identical, so
                    // no hash changes — but the **file bytes** do, and
                    // `source_sha256` is a digest of those bytes
                    // (`import-sources.ts` `digestHealthKitExportContent`), so
                    // upload deduplication never sees two identical exports and
                    // the server can never answer `unchanged`.
                    //
                    // `endDate` is only a tie-break: the parser keys rows by id
                    // and never by position, so this can only reorder, never
                    // drop or merge.
                    sortDescriptors: [
                        NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true),
                        NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: true)
                    ]
                ) { _, samples, error in
                    if let error {
                        box.resume(throwing: error)
                        return
                    }
                    box.resume(returning: (samples as? [T]) ?? [])
                }
                box.execute(query, on: store)
            }
            try Task.checkCancellation()
            return result
        } onCancel: {
            box.cancel()
        }
    }

    private static func recordXML(
        _ sample: HKQuantitySample,
        type: String,
        unit: HKUnit,
        xmlUnit: String
    ) -> String {
        let value = sample.quantity.doubleValue(for: unit)
        let source = sample.sourceRevision.source.name
        let version = sample.sourceRevision.version ?? "1"
        var attrs = "type=\"\(type)\" sourceName=\"\(escape(source))\" sourceVersion=\"\(escape(version))\""
        if let device = deviceDescription(sample.device) {
            attrs += " device=\"\(escape(device))\""
        }
        attrs += " unit=\"\(xmlUnit)\" creationDate=\"\(appleDate(sample.startDate))\" startDate=\"\(appleDate(sample.startDate))\" endDate=\"\(appleDate(sample.endDate))\" value=\"\(format(value))\""
        return "\n          <Record \(attrs)>\(sampleMetadataXML(sample))</Record>"
    }

    private static func sampleMetadataXML(_ sample: HKSample) -> String {
        var metadata = sample.metadata ?? [:]
        metadata["RAIHealthKitSampleUUID"] = sample.uuid.uuidString.lowercased()
        return metadata.keys.sorted().compactMap { key in
            guard let value = metadata[key], let serialized = serializeMetadata(value) else { return nil }
            return "<MetadataEntry key=\"\(escape(key))\" value=\"\(escape(serialized))\"/>"
        }.joined()
    }

    /// 一个 workout 的 route 产物：写进载荷的 GPX 条目，以及这一轮的**观测摘要**。
    ///
    /// 观测摘要**不是**从文件名或磁盘反推的，而是在生成 GPX 的那一次顺手算出来的 ——
    /// 反推等于把"轨迹有没有变"这条判据架在"文件还在不在"上，而文件的生命周期只到本次导出结束。
    struct RouteFetch {
        let entries: [(name: String, url: URL)]
        /// nil 是查询未能完成，不能记成零点数或稳定证据。
        let observation: RouteObservation?
        /// 本 workout 已写出的 GPX **字节和**。调用方累加它得到 `routeBytes` —— 自累计而不是
        /// 回头 `statSync`：这里的值就是写文件时用的 `document.utf8.count`，与盘上大小逐字节
        /// 同值，且与 `entries` 严格同进同退。
        let bytes: Int
        /// 本 workout 的轨迹**装不进剩余路线预算**（S2.5 route 侧）。为 `true` 时
        /// `entries` 必为空、`observation` 必为 nil、`bytes` 必为 0、**状态一律不推进**；
        /// 调用方只跳过这一个 workout（后面的照常尝试，不做"一次装不下就全停"）。
        let budgetExhausted: Bool
        /// P2-3A（2026-10-15）：`budgetExhausted` 的**细分**——这条轨迹**自身**就超过满额单批
        /// 预算（`bytes > budget.maxRouteBytes`）。任何后续批次（哪怕满额）都装不下它 ⇒ 不是
        /// "余额暂时不足、下批可再试"，而是"这条轨迹按当前上界永远进不了载荷"。调用方据此
        /// 上报**可见警告**（静默跳过 = 用户永远不知道有数据没同步）。
        let oversized: Bool

        static let empty = RouteFetch(entries: [], observation: nil, bytes: 0, budgetExhausted: false, oversized: false)
    }

    private static func routeEntries(
        for workout: HKWorkout,
        store: HKHealthStore,
        directory: URL,
        warnings: WarningBag,
        budget: DirectSyncBatchBudget,
        usedRouteBytes: Int,
        usedRouteFiles: Int
    ) async throws -> RouteFetch {
        let routes: [HKWorkoutRoute]
        do {
            routes = try await samples(
                type: HKSeriesType.workoutRoute(),
                predicate: HKQuery.predicateForObjects(from: workout),
                store: store
            )
        } catch {
            if isAuthorizationError(error) || isNoDataError(error) {
                warnings.add("路线暂不可读取；已保留路线同步状态")
                return .empty
            }
            if isDatabaseInaccessible(error) { throw HealthKitExportError.databaseLocked }
            throw error
        }
        var entries: [(name: String, url: URL)] = []
        // 本 workout 已写出的**字节**（口径 = 盘上 GPX 的 UTF-8 字节数，与服务端
        // `statSync` 的累计口径一致）。与 `entries` 严格同进同退：判定失败时一起回退。
        var writtenBytes = 0
        let routesDirectory = directory.appendingPathComponent("workout-routes", isDirectory: true)
        try FileManager.default.createDirectory(at: routesDirectory, withIntermediateDirectories: true)
        let workoutId = routeFileWorkoutId(workout)
        var digest = SHA256()
        var pointTotal = 0
        var complete = true
        for route in routes {
            try Task.checkCancellation()
            let locations: [CLLocation]
            do {
                locations = try await routeLocations(route, store: store)
            } catch {
                if isAuthorizationError(error) {
                    warnings.add("未授权读取路线")
                    complete = false
                    continue
                }
                if isNoDataError(error) {
                    complete = false
                    continue
                }
                if isDatabaseInaccessible(error) { throw HealthKitExportError.databaseLocked }
                throw error
            }
            guard !locations.isEmpty else { continue }
            try Task.checkCancellation()
            let document = try gpx(locations)
            let bytes = document.utf8.count
            // 🔴 写前判定（与记录侧同一纪律）：**先算字节、判定放得下，再落盘**。
            // 旧写法"先落盘、由调用方在下一轮判" ⇒ 单批可超额**一整个 GPX 文件**
            // （2026-10-14 真机：route 34,009,725 B / 58 文件，均值 586 KB，最坏可达数 MB）。
            // 装不下 ⇒ **整个 workout 的轨迹一起放弃**，并删掉本轮已写的分片：半条轨迹比没有更坏
            // （xml 不声明它 ⇒ 载荷里会多出一个无主文件）。
            if budget.routeBudgetExhausted(
                routeBytes: usedRouteBytes + writtenBytes + bytes,
                routeFiles: usedRouteFiles + entries.count + 1
            ) {
                for entry in entries { try? FileManager.default.removeItem(at: entry.url) }
                // P2-3A：细分两种放弃 ——「余额暂时不足」（下批满额可再试，保持既有轮转语义）
                // 与「这条轨迹**自身**超过满额预算」（bytes > maxRouteBytes ⇒ 任何批次都装不下）。
                // 后者必须上报可见警告（调用侧），否则用户永远不知道有数据没同步。
                let oversized = bytes > budget.maxRouteBytes
                return RouteFetch(entries: [], observation: nil, bytes: 0,
                                  budgetExhausted: true, oversized: oversized)
            }
            let name = "workout-routes/\(workoutId)_\(entries.count + 1).gpx"
            let url = directory.appendingPathComponent(name)
            try document.write(to: url, atomically: true, encoding: .utf8)
            if FileManager.default.fileExists(atPath: url.path) {
                entries.append((name: name, url: url))
                pointTotal += locations.count
                writtenBytes += bytes
                digest.update(data: Data(document.utf8))
            } else {
                // 2026-10-15（审查 A-🔡1）：写入成功但文件不在（极罕见）⇒ 该条此前被
                // **静默丢弃**（不进 entries、不进 warnings、xml 也不声明它）。给一条可见
                // 警告，避免"单条轨迹没同步"完全没有线索。
                warnings.add("有一条轨迹写入后未找到；本条未计入，已保留其同步状态")
            }
        }
        // 部分段读取失败也不输出不完整路线，不以它覆盖已有 GPX 或积累稳定证据。
        guard complete else {
            for entry in entries { try? FileManager.default.removeItem(at: entry.url) }
            return .empty
        }
        // 查询成功且没有任何条目 ⇒ 观测是"0 个点、没有摘要"。摘要用 `nil` 而不是空 SHA256 的十六进制：
        // 后者是一个"看起来像内容摘要"的值，会让"没有轨迹"和"有一段空轨迹"变成两回事。
        let observation = RouteObservation(
            pointCount: entries.isEmpty ? 0 : pointTotal,
            routeHash: entries.isEmpty ? nil : digest.finalize().map { String(format: "%02x", $0) }.joined()
        )
        return RouteFetch(entries: entries, observation: observation, bytes: writtenBytes,
                          budgetExhausted: false, oversized: false)
    }

    private static func workoutSyncId(_ workout: HKWorkout) -> String {
        let raw = (workout.metadata?[HKMetadataKeySyncIdentifier] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (raw?.isEmpty == false) ? raw! : workout.uuid.uuidString
    }

    private static func routeFileWorkoutId(_ workout: HKWorkout) -> String {
        // Lowercased on purpose. The import pipeline treats route paths as
        // case-insensitive identities, and archive entries must still resolve on
        // case-sensitive hosts (the Linux API). `uuidString` is uppercased.
        workout.uuid.uuidString.lowercased()
    }

    private static func routeLocations(_ route: HKWorkoutRoute, store: HKHealthStore) async throws -> [CLLocation] {
        let box = QueryContinuation<[CLLocation]>()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            let result = try await withCheckedThrowingContinuation { continuation in
                box.set(continuation)
                let lock = NSLock()
                var collected: [CLLocation] = []
                let query = HKWorkoutRouteQuery(route: route) { _, locations, done, error in
                    if let error {
                        box.resume(throwing: error)
                        return
                    }
                    lock.lock()
                    if let locations { collected.append(contentsOf: locations) }
                    let finished = done ? collected : nil
                    lock.unlock()
                    if let finished {
                        box.resume(returning: finished)
                    }
                }
                box.execute(query, on: store)
            }
            try Task.checkCancellation()
            return result
        } onCancel: {
            box.cancel()
        }
    }

    private static func gpx(_ locations: [CLLocation]) throws -> String {
        var xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <gpx version="1.1" creator="RAI">
          <trk><name>RAI HealthKit route</name><trkseg>
        """
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        for location in locations {
            try Task.checkCancellation()
            xml += "\n    <trkpt lat=\"\(location.coordinate.latitude)\" lon=\"\(location.coordinate.longitude)\">"
            if location.verticalAccuracy >= 0 {
                xml += "<ele>\(location.altitude)</ele>"
            }
            xml += "<time>\(iso.string(from: location.timestamp))</time>"
            if location.speed >= 0 { xml += "<speed>\(location.speed)</speed>" }
            if location.course >= 0 { xml += "<course>\(location.course)</course>" }
            if location.horizontalAccuracy >= 0 { xml += "<hAcc>\(location.horizontalAccuracy)</hAcc>" }
            if location.verticalAccuracy >= 0 { xml += "<vAcc>\(location.verticalAccuracy)</vAcc>" }
            xml += "</trkpt>"
        }
        xml += "\n  </trkseg></trk>\n</gpx>\n"
        return xml
    }

    private static func meElement(store: HKHealthStore) -> String {
        var attrs = ""
        if let sex = try? store.biologicalSex() {
            switch sex.biologicalSex {
            case .female: attrs += " biologicalSex=\"HKBiologicalSexFemale\""
            case .male: attrs += " biologicalSex=\"HKBiologicalSexMale\""
            case .other: attrs += " biologicalSex=\"HKBiologicalSexOther\""
            default: break
            }
        }
        if let components = try? store.dateOfBirthComponents(), let date = Calendar.current.date(from: components) {
            attrs += " dateOfBirth=\"\(appleDate(date))\""
        }
        return "<Me\(attrs)/>"
    }

    private static func sleepName(_ value: Int) -> String {
        switch value {
        case HKCategoryValueSleepAnalysis.inBed.rawValue:
            return "HKCategoryValueSleepAnalysisInBed"
        case HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue:
            return "HKCategoryValueSleepAnalysisAsleepUnspecified"
        case HKCategoryValueSleepAnalysis.awake.rawValue:
            return "HKCategoryValueSleepAnalysisAwake"
        case HKCategoryValueSleepAnalysis.asleepCore.rawValue:
            return "HKCategoryValueSleepAnalysisAsleepCore"
        case HKCategoryValueSleepAnalysis.asleepDeep.rawValue:
            return "HKCategoryValueSleepAnalysisAsleepDeep"
        case HKCategoryValueSleepAnalysis.asleepREM.rawValue:
            return "HKCategoryValueSleepAnalysisAsleepREM"
        default:
            return "HKCategoryValueSleepAnalysisAsleepUnspecified"
        }
    }

    private static func metadataXML(_ workout: HKWorkout) -> String {
        guard let metadata = workout.metadata else { return "" }
        var body = ""
        let skip = Set([HKMetadataKeyIndoorWorkout, HKMetadataKeySyncIdentifier])
        // 🔴 Sorted key order is load-bearing, not cosmetic. A Swift `Dictionary`
        // has no stable iteration order, so `for (key, value) in metadata`
        // reshuffles these lines between processes. The lines decide the order in
        // which the parser first sees each key (`addMetadata` creates the array on
        // first sight), i.e. the key order of `workouts.metadata_json` — and that
        // whole object is fed to `stableId("workout_content", …)`. Same run, same
        // data, new `<MetadataEntry>` order ⇒ new content hash ⇒ the incremental
        // importer reports every workout with two or more surviving keys as
        // `updated`, and the model is replayed from the start of the window.
        // That is the "已更新 N 次跑步" symptom on a day with no new runs.
        //
        // Sorting changes no meaning: `addMetadata` / `lastMetadataValue` /
        // `metadataBoolean` all look a value up **by key**, and a Dictionary holds
        // each key once, so only the line order changes.
        for key in metadata.keys.sorted() {
            if skip.contains(key) { continue }
            guard let value = metadata[key] else { continue }
            guard let serialized = serializeMetadata(value) else { continue }
            body += "    <MetadataEntry key=\"\(escape(key))\" value=\"\(escape(serialized))\"/>\n"
        }
        return body
    }

    private static func serializeMetadata(_ value: Any) -> String? {
        if let text = value as? String { return text }
        // A Swift `Bool` bridges to `NSNumber` and is caught here, where
        // `stringValue` already yields "1"/"0" — a later `as? Bool` would never
        // be reached.
        if let number = value as? NSNumber { return number.stringValue }
        if let quantity = value as? HKQuantity {
            if quantity.is(compatibleWith: .degreeCelsius()) {
                return "\(format(quantity.doubleValue(for: .degreeCelsius()))) degC"
            }
            if quantity.is(compatibleWith: .degreeFahrenheit()) {
                return "\(format(quantity.doubleValue(for: .degreeFahrenheit()))) degF"
            }
            if quantity.is(compatibleWith: .percent()) {
                return "\(format(quantity.doubleValue(for: .percent()) * 100)) %"
            }
            if quantity.is(compatibleWith: .meter()) {
                return "\(format(quantity.doubleValue(for: .meter()))) m"
            }
            let mets = HKUnit.kilocalorie().unitDivided(by: HKUnit.hour().unitMultiplied(by: .gramUnit(with: .kilo)))
            if quantity.is(compatibleWith: mets) {
                return "\(format(quantity.doubleValue(for: mets))) kcal/hr·kg"
            }
        }
        return String(describing: value)
    }

    private static func anchoredWorkouts(
        store: HKHealthStore,
        anchor: HKQueryAnchor?,
        predicate: NSPredicate?,
        limit: Int = HKObjectQueryNoLimit
    ) async throws -> (added: [HKWorkout], deleted: [HKDeletedObject], next: HKQueryAnchor) {
        let box = QueryContinuation<(added: [HKWorkout], deleted: [HKDeletedObject], next: HKQueryAnchor)>()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            let result = try await withCheckedThrowingContinuation { continuation in
                box.set(continuation)
                let query = HKAnchoredObjectQuery(
                    type: .workoutType(),
                    predicate: predicate,
                    anchor: anchor,
                    limit: limit
                ) { _, samples, deletedObjects, newAnchor, error in
                    if let error {
                        box.resume(throwing: error)
                        return
                    }
                    box.resume(returning: (
                        added: (samples as? [HKWorkout]) ?? [],
                        deleted: deletedObjects ?? [],
                        next: newAnchor ?? HKQueryAnchor(fromValue: 0)
                    ))
                }
                box.execute(query, on: store)
            }
            try Task.checkCancellation()
            return result
        } onCancel: {
            box.cancel()
        }
    }

    private static func encodeAnchor(_ anchor: HKQueryAnchor) -> Data? {
        try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true)
    }

    private static func decodeAnchor(_ data: Data) -> HKQueryAnchor? {
        try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private static func isIndoor(_ workout: HKWorkout) -> Bool {
        if let value = workout.metadata?[HKMetadataKeyIndoorWorkout] as? Bool { return value }
        if let value = workout.metadata?[HKMetadataKeyIndoorWorkout] as? NSNumber { return value.boolValue }
        return false
    }

    private static func deviceDescription(_ device: HKDevice?) -> String? {
        guard let device else { return nil }
        var parts: [String] = []
        if let name = device.name { parts.append("name:\(name)") }
        if let manufacturer = device.manufacturer { parts.append("manufacturer:\(manufacturer)") }
        if let model = device.model { parts.append("model:\(model)") }
        if let hardware = device.hardwareVersion { parts.append("hardware:\(hardware)") }
        if let software = device.softwareVersion { parts.append("software:\(software)") }
        if parts.isEmpty { return device.name }
        return "<<" + parts.joined(separator: ", ") + ">>"
    }

    private static func isAuthorizationError(_ error: Error) -> Bool {
        let nsError = error as NSError
        guard nsError.domain == HKError.errorDomain else { return false }
        return nsError.code == HKError.Code.errorAuthorizationDenied.rawValue
            || nsError.code == HKError.Code.errorAuthorizationNotDetermined.rawValue
    }

    private static func isNoDataError(_ error: Error) -> Bool {
        let nsError = error as NSError
        guard nsError.domain == HKError.errorDomain else { return false }
        return nsError.code == HKError.Code.errorNoData.rawValue
    }

    /// 设备锁屏 / 开机后未首次解锁时，HealthKit 会以这个错误拒绝**任何**读取。
    ///
    /// 为什么必须与 `isNoDataError` 分开识别（两者的码相邻，很容易顺手合并）：
    ///   - `errorNoData` 的意思是"查询到了，库里就是没有" ⇒ 当成空结果是**对的**；
    ///   - `errorDatabaseInaccessible` 的意思是"现在读不到" ⇒ 当成空结果是
    ///     **把一段真实存在的数据永久跳过**：客户端会据此推进 anchor，而下次查询从
    ///     新水位起步，那段数据再也不会出现在任何一次导出里。
    ///
    /// 文档 §3.4 点名禁止的正是后一条：「绝对严禁视为空数据 (0 Workouts) 推进 Anchor!」
    /// 判据用 `HKError.Code` 而不是硬编码数字：写死 12 会在 SDK 调整枚举时静默失效，
    /// 而这类失效的表现恰好是"又把它当成空数据了"。
    private static func isDatabaseInaccessible(_ error: Error) -> Bool {
        let nsError = error as NSError
        guard nsError.domain == HKError.errorDomain else { return false }
        return nsError.code == HKError.Code.errorDatabaseInaccessible.rawValue
    }

    private static let dateLock = NSLock()
    private static let appleDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss Z"
        return formatter
    }()

    private static func appleDate(_ date: Date) -> String {
        dateLock.lock()
        defer { dateLock.unlock() }
        return appleDateFormatter.string(from: date)
    }

    private static func format(_ value: Double) -> String {
        String(format: "%.4f", value)
    }

    /// XML attribute escaping. Control characters other than tab/newline/carriage
    /// return are illegal in XML 1.0 at any level, so a device name that happens to
    /// carry one would make the whole document unparseable — drop them rather than
    /// let a single stray byte fail the import.
    private static func escape(_ value: String) -> String {
        let legal = value.unicodeScalars.filter { scalar in
            scalar.value == 0x09 || scalar.value == 0x0A || scalar.value == 0x0D
                || scalar.value >= 0x20
        }
        return String(String.UnicodeScalarView(legal))
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    private static func write(_ handle: FileHandle, _ text: String) throws {
        guard let data = text.data(using: .utf8) else { return }
        try handle.write(contentsOf: data)
    }
}
#endif
