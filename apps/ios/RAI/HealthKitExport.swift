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
    /// O02/WP-11：本批**新登记**的待查路线（页交付后生效）。它们是"训练 XML 已交付、
    /// 锚已推进、但 route 查询被预算挡住"且**没有状态行**的 UUID —— 没有这条待办，
    /// 它们重启后永久不可发现。调用方**超前登记**（崩在提交前只会让待办早到、下批多查
    /// 一次，绝不丢）。
    let pendingRouteTodos: [PendingRouteTodo]
    /// O02/WP-11：本批**已成功交付**（fetch 完成）的待办 UUID，可从队列移除。
    /// 🔴 调用方必须在**批次持久提交成功之后**才移除 —— 载荷未被接受时移除会让那些
    /// 「无状态行」的 UUID 再也回不来。
    let completedRouteTodos: [String]

    /// P0-4（2026-10-18 同步诊断）：本批**新登记/刷新**的 workout 定向补齐窗口。
    ///
    /// 登记时机与路线待办同一条纪律 —— **先表后锚**：调用方必须在任务行持久化锚点**之前**
    /// 把这些窗口写进 `sync_pending_workout_windows`（`store.upsertWorkoutBackfillWindows`）。
    /// 崩在这之后任何一步只会让窗口早到（下批多查一次，幂等），绝不会丢：锚的提交链在
    /// 任务行与回执之后。
    let workoutWindowRegistrations: [WorkoutBackfillWindow]

    /// P0-4：本批**已经跑过整窗查询**的窗口记账（重试时刻/样本数/稳定计数/收口）。
    ///
    /// 🔴 只允许在**批次成功提交之后**写回（`markSuccess` → `commitSuccess` 之后），
    /// 与路线待办/删除余量同一条「成功后才结算」纪律。失败/取消的批次不写 ⇒ 下批重跑
    /// 同一窗口（重复样本由服务端按 UUID 幂等吸收）。
    let workoutWindowUpdates: [WorkoutBackfillWindow]

    /// P2-3：本批各通道的计数（只写计数，不写样本值）。
    let channelCounts: ExportChannelCounts

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
    /// 本地同步状态库不可读（不是游标损坏）：继续跑只能退化成"没有水位"，即全历史重读。
    /// 明确阻塞并要求修复，比"静默全量"安全（2026-10-17 边界收紧）。
    case stateStoreUnreadable
    /// R04：打包前自校验发现同一路径出现两次（ZIP 接收器拒收的形态）。
    /// 上游（批次级路线清单）本应去重；走到这里说明它有缺口 —— 当场失败、保留可恢复状态。
    case duplicateArtifactPath(String)
    /// R04：打包前自校验发现清单引用了一个不存在的文件（页级暂存被误清、或渲染与写盘
    /// 不同步）。同样当场失败，绝不把缺文件的载荷发出去。
    case missingArtifact(String)

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
            return "健康记录增量游标已损坏，本次未推进、也未重读历史。请在设置页点「修复增量游标」。"
        case .invalidWorkoutAnchor:
            return "跑步增量游标已损坏，本次未推进、也未重读历史。请在设置页点「修复增量游标」。"
        case .stateStoreUnreadable:
            return "本地同步状态库暂时无法读取，已停止同步以免误读成「从未同步过」而重读全部历史。请解锁设备后重试；若仍失败，请重装应用（服务端数据不受影响）。"
        case .databaseLocked:
            // 用户不需要做任何事，所以文案刻意不含"请重试"之外的动作项 ——
            // 设备一解锁就会自动继续（见 `RaiStartup.observeProtectedDataAvailability`）。
            return "设备已锁定，暂时无法读取 Apple 健康数据。解锁后将自动继续同步。"
        case .duplicateArtifactPath(let name):
            return "本次同步产物出现重复路径（\(name)），已停止上传以免被服务端拒收。请重试同步。"
        case .missingArtifact(let name):
            return "本次同步产物缺少文件（\(name)），已停止上传。请重试同步。"
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
    ///   - budget: 单批载荷预算（S2.1/S2.5）。**写前判定**：整页先渲染进内存、判定通过才落盘
    ///     ⇒ 单批字节严格 ≤ 预算。截断时停在**页首**（整页不提交、锚点不推进），结果
    ///     `budgetStopReason != nil`。默认取保守值 —— 调用点漏传时宁小勿大（多分几批），绝不超界。
    static func exportArchive(
        from startDate: Date?,
        workoutAnchor: Data?,
        recordCursors: Data? = nil,
        routeStates: [String: RouteSyncRecord] = [:],
        routeDiscoveryCursor: String? = nil,
        /// 用户点名的**定点重试**（§4.2 步骤 6）：只重开这些 UUID 的阻塞/退避，
        /// 其余待办原样保留。空集 = 没有定点重试（默认）。
        routeRetryWorkoutIDs: Set<String> = [],
        budget: DirectSyncBatchBudget = .conservative,
        pendingDeletions: DirectSyncPendingDeletions = .empty,
        // O02/WP-11 + R07：待查路线队列（上一批登记、尚未查询的 workout）。它们会被
        // **定点查询**（与 rediscovery 同一条 `knownRunningWorkouts` 通道）；完整观测后
        // 回传 `completedRouteTodos`（由调用方在**提交成功后**移除）。R07 起这里传的是
        // **完整待办对象**（含调度状态）：
        //   - 只有 `RouteTodoScheduler` 判为**可执行**的子集才进入本批的发现通道与查询
        //     （blocked-size 与未到期的 retry-wait 不查 —— 不再对同一份不可装入的 GPX
        //     无限续批）；
        //   - 每条被实际尝试的待办按结局回传调度更新（读取失败 ⇒ 有界退避；确认超满额
        //     ⇒ size 阻塞 + 预算指纹），由调用方在导出后写回（"超前登记"同款纪律）。
        pendingRouteTodos: [PendingRouteTodo] = [],
        /// P0-4：workout 级定向补齐窗口（上一批登记、尚未收口）。导出在**迟到补读/48h 窗口/
        /// 历史重放之前**对到期窗口做全类型有界查询；本批的登记/记账分别在返回值的两个数组里，
        /// 由调用方按"先表后锚 / 成功后才结算"两条纪律落盘。
        workoutBackfillWindows: [WorkoutBackfillWindow] = [],
        /// P1-1：服务端覆盖表（`GET /v1/sync/coverage` 的归一结果）。空 = 老服务端/探测失败
        /// ⇒ 历史段回落全量重放。只在 `historyFromScratch` / `historyResume` 段使用。
        coverage: [String: SyncCoveragePolicy.TypeCoverage] = [:],
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
        // O01（WP-10）：**查询页 = 交付单位**（旧实现把 anchor 推到"查询流末尾"，被预算
        // 截断的页随锚前推**永久丢失**）。页循环在下方：每页独立"查询 → 渲染 → 写前判定"，
        // 判定通过才推进 `deliveredAnchor`；放不下就缩 `pageLimit` 从同一页起点重查。
        let storedWorkoutAnchor = workoutAnchor.flatMap(decodeAnchor)
        guard workoutAnchor == nil || storedWorkoutAnchor != nil else {
            throw HealthKitExportError.invalidWorkoutAnchor
        }
        var workoutPredicates = [HKQuery.predicateForWorkouts(with: .running)]
        if storedWorkoutAnchor == nil, let startDate {
            workoutPredicates.append(HKQuery.predicateForSamples(withStart: startDate, end: nil, options: .strictStartDate))
        }
        let workoutPredicate = NSCompoundPredicate(andPredicateWithSubpredicates: workoutPredicates)
        // 附加集合（发现通道，**不消费 anchor**）：近期回填（14 天）× rediscovery 定点。
        // O01：它们并入**第一个成功交付的页**（缩 limit 重查复用同一份结果；rediscovery 只在
        // 第一次查询后算一次 —— 它要看"本批第一页已见到的 workout"来排除候选）。
        var attachmentWorkouts: [HKWorkout] = []
        var rediscovery: [String] = []
        var attachmentsPending = true
        // 页循环状态：`anchorBefore` 是当前页的查询起点；`deliveredAnchor` 只随"完整交付的
        // 页"推进（初值 = 上一批确认的锚；一页都没交付时原样回传 —— 绝不提前）。
        var anchorBefore = storedWorkoutAnchor
        var deliveredAnchor = storedWorkoutAnchor
        var pageLimit = Self.workoutPageLimit
        // 删除池：workout 删除随**完整交付的页**逐页并入（`HKAnchoredObjectQuery` 的 limit
        // 不约束 `deletedObjects` ⇒ 缩 limit 重查会重复返回同一批删除，按 UUID 去重）。
        // WP-12 的三分预扣随之移到页循环之后 —— 那时 fresh 集合才完整。
        var freshWorkoutIds: [String] = []
        var freshWorkoutIdSet = Set<String>()
        // O02/WP-11 + R07：待办路线 —— `pendingTodoByUUID` 是**注入**的（上一批登记的，
        // 用于在 fetch 成功后回传"可移除"、并作为调度记账的底稿）；`newRouteTodos` 是本批
        // 新登记的（**页交付后才生效**，与 route 状态/文件同进同退）。
        //
        // R07：**本批可执行子集**（有界 + 公平序）—— `blocked-size` 与未到期的 `retry-wait`
        // 既不进发现通道、也不会被 fetch（否则"满额也装不下"的路线每轮被重读一遍，无限续批）。
        // 显式重扫（"重新导入全部"）是用户明确重试 ⇒ 把全部待办复位 ready 后放行。
        let pendingTodoByUUID: [String: PendingRouteTodo]
        let pendingRouteTodoSet: Set<String>
        let executableTodos: [PendingRouteTodo]
        let retryWorkoutIDs = Set(routeRetryWorkoutIDs.map { $0.lowercased() })
        do {
            // 🔴 §4.2 步骤 6：定点重试。点名的 UUID 即使**没有待办**也要临时登记一条 ——
            // 否则 `todo == nil` 会让它服从状态机降频（settled 未到期 ⇒ 不查），
            // 用户在界面上点了"重试"，实际什么也没发生。
            var allTodos = pendingRouteTodos
            for uuid in retryWorkoutIDs where !allTodos.contains(where: { $0.workoutUUID == uuid }) {
                allTodos.append(PendingRouteTodo(
                    workoutUUID: uuid, reason: .routeBudget, createdAt: routeNow
                ))
            }
            pendingTodoByUUID = Dictionary(uniqueKeysWithValues: allTodos.map {
                ($0.workoutUUID, $0)
            })
            pendingRouteTodoSet = Set(pendingTodoByUUID.keys)
            // 定点重试走 `reopened`（清阻塞/退避），但**只对那几条** —— 全量重扫才会重开整队。
            let candidates = retryWorkoutIDs.isEmpty
                ? allTodos
                : allTodos.map {
                    retryWorkoutIDs.contains($0.workoutUUID)
                        ? RouteTodoScheduler.reopened($0) : $0
                }
            executableTodos = RouteTodoScheduler.executable(
                candidates, now: routeNow,
                maxRouteBytes: budget.maxRouteBytes, maxRouteFiles: budget.maxRouteFiles
            )
        }
        let executableTodoIDs = Set(executableTodos.map(\.workoutUUID))
        // 调度记账底稿：被实际尝试的待办按结局更新（见页内 `switch fetch.outcome`）。
        var todoUpdates: [String: PendingRouteTodo] = Dictionary(
            uniqueKeysWithValues: executableTodos.map { ($0.workoutUUID, $0) }
        )
        var newRouteTodos: [String: PendingRouteTodo] = [:]
        var completedRouteTodos: [String] = []
        // P0-4：workout 定向补齐窗口。`workoutWindowByUUID` 是**注入的**已登记窗口（用于
        // 判断"窗口是否变宽、要不要重开"）；`windowRegistrations` 是本批新登记/刷新的输出，
        // **页交付后才生效**（与路线待办同进同退：页被拒时下一批从同一锚点重查，不会把同一次
        // 变更登记两次）。
        // 用 reduce 而不是 `Dictionary(uniqueKeysWithValues:)`：后者在重复键上**崩溃**，
        // 而这里的输入来自磁盘（损坏/重复行只该退化成"以最后一条为准"）。
        var workoutWindowByUUID: [String: WorkoutBackfillWindow] = [:]
        for window in workoutBackfillWindows {
            workoutWindowByUUID[window.workoutUUID] = window
        }
        var windowRegistrations: [String: WorkoutBackfillWindow] = [:]

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
        // 🔴 R04（2026-10-16 复查）：**批次级路线清单** —— 按相对路径**跨页去重**（同名时
        // 后页版本原子替换前页的引用）。旧形态是页交付时 `files.append(contentsOf: pageRouteFiles)`：
        // 页 1 的"附件"版本与页 N 的"正式流"版本引用同一 `workout-routes/<uuid>_1.gpx`
        // ⇒ ZIP 里同路径两个条目 ⇒ 接收器整批拒收（复查的最小夹具已复现）。
        // XML 侧同 UUID 的重复渲染由接收端既有语义承接（同一 syncIdentifier 出现两次 =
        // 后者生效），这里只保证**文件清单**唯一。合并规则住 `RouteBatchFileList`（可单测）。
        var routeBatchFiles = RouteBatchFileList()

        try write(xml, """
        <?xml version="1.0" encoding="UTF-8"?>
        <HealthData locale="zh_CN">
          <ExportDate value="\(appleDate(Date()))"/>
          \(meElement(store: store))
        """)

        // O01（WP-10）**页循环**：查询一页 → 渲染（写前字节闸门在页边境界定）→ 判定。
        // 判定通过才写、才推进 `deliveredAnchor`；放不下先缩 `pageLimit` 从同一 `anchorBefore`
        // 重查（逐级降到单条）；连单条都放不下 ⇒ 可见阻塞（整页不写、锚不推进）。
        var workoutStop: HealthKitExportResult.BudgetStopReason?
        while true {
            // R04：本页的产物写进**页级独立临时目录** —— 拒绝页/缩页重试里的一切写入与
            // 回滚（包括 `routeEntries` 的"装不下 ⇒ 删掉本轮已写分片"）都只作用于这一支
            // 私有目录，**永不触碰已接受页引用的文件**（旧形态共用同一个 `workout-routes/`：
            // 重试里的一次超预算回滚可以删掉页 1 已接受、且已进清单的 GPX）。
            // 页交付后目录保留（批次清单引用它）；页被拒时删除（下一轮换新目录重来）。
            let pageStaging = directory.appendingPathComponent(
                ".page-staging-\(UUID().uuidString)", isDirectory: true
            )
            try FileManager.default.createDirectory(at: pageStaging, withIntermediateDirectories: true)
            let page = try await workoutPage(
                store: store, anchor: anchorBefore, predicate: workoutPredicate, limit: pageLimit
            )
            try Task.checkCancellation()
            let streamDone = page.added.isEmpty && page.deleted.isEmpty
            // 附加集合懒计算（只一次；EOF 页也要算 —— 发现通道与锚无关）。
            if attachmentsPending {
                attachmentsPending = false
                let seen = Set(page.added.map(routeFileWorkoutId))
                rediscovery = RouteSyncStateMachine.rediscoveryCandidates(
                    existing: Array(routeStates.values),
                    currentWorkoutUUIDs: seen,
                    changedWorkoutUUIDs: seen,
                    now: routeNow,
                    cursor: routeDiscoveryCursor
                )
                // O02/WP-11 + R07：rediscovery 候选**并入待办队列的可执行子集** —— 后者是
                // "没有状态行"的 UUID 的**唯一**发现通道（`rediscoveryCandidates` 只遍历已有
                // 状态行，从没查过的历史训练不在其中；这正是 O02 修正的缺口）。
                // R07：只并**可执行**的待办 —— blocked-size 与退避未到期的 UUID 不进发现
                // 通道，因此不会每轮被重新取回、重读同一份不可装入的 GPX。
                let dueIDs = Set(rediscovery).union(executableTodoIDs)
                let historicalIDs = dueIDs.sorted().filter { !seen.contains($0) }
                var discovered: [HKWorkout] = []
                if !historicalIDs.isEmpty {
                    // 按有限 UUID 集合定点取 workout，不使用最近窗口，更不扫描全部历史。
                    discovered += try await knownRunningWorkouts(store: store, uuids: historicalIDs)
                }
                if storedWorkoutAnchor != nil {
                    // 近期回填（14 天）：近期窗口只负责发现"迟到的轨迹"，与锚是否覆盖无关。
                    let backfillStart = (startDate ?? Date()).addingTimeInterval(-routeBackfillWindow)
                    let recentPredicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
                        HKQuery.predicateForWorkouts(with: .running),
                        HKQuery.predicateForSamples(withStart: backfillStart, end: nil, options: .strictStartDate)
                    ])
                    let recent: [HKWorkout] = try await samples(
                        type: .workoutType(), predicate: recentPredicate, store: store
                    )
                    discovered += recent
                }
                attachmentWorkouts = discovered
            }
            if streamDone {
                // 流已尽：锚可安全推进到末尾（没有任何未消费的流变更）。剩下的只有附件页。
                deliveredAnchor = page.next
                if attachmentWorkouts.isEmpty {
                    // R04：本页没有产出（空附件页）⇒ 页级暂存目录没有内容，删掉它。
                    try? FileManager.default.removeItem(at: pageStaging)
                    break
                }
            }
            // 页数组 = 本页 added ∪ 附加集合（后者交付后即清空）；同一比较器排序（确定性）。
            var merged = Dictionary(uniqueKeysWithValues: page.added.map {
                (routeFileWorkoutId($0), $0)
            })
            for workout in attachmentWorkouts { merged[routeFileWorkoutId(workout)] = workout }
            let workouts = merged.values.sorted {
                $0.startDate == $1.startDate
                    ? $0.uuid.uuidString < $1.uuid.uuidString : $0.startDate < $1.startDate
            }
            let changedWorkoutIDs = Set(page.added.map(routeFileWorkoutId))
            var pageText = ""
            var pageRouteFiles: [(name: String, url: URL)] = []
            var pageRouteDecisions: [String: RouteSyncRecord] = [:]
            var pageRouteBytes = 0
            var pageRouteCount = 0
            var pageExported: [HKWorkout] = []
            var pageNewTodos: [String: PendingRouteTodo] = [:]
            var pageCompletedTodos: [String] = []
            // P0-4：本页登记的 workout 补齐窗口（页交付后才并入批次输出）。
            var pageWindowRegistrations: [String: WorkoutBackfillWindow] = [:]
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
            let hasWorkoutChange = changedWorkoutIDs.contains(routeKey)
            // P0-4（2026-10-18 同步诊断）：一条**正在变更**的训练 ⇒ 为它登记/刷新定向补齐窗口。
            //
            // 为什么必须在**这里**（workout 页）而不是记录段：`hasWorkoutChange` 正是"这条
            // workout 出现在本批变更流里"的唯一判据，而它的 endDate 是窗口上界的来源。
            // 只给最近 7 天内结束的训练登记（更老的由历史重放自己覆盖，也不该因元数据变化
            // 被反复登记）；窗口 [start−5min, end+5min] 覆盖跑前恢复与跑后迟到样本。
            if hasWorkoutChange,
               let registered = WorkoutBackfillScheduler.register(
                   workoutUUID: routeKey,
                   startDate: workout.startDate,
                   endDate: workout.endDate,
                   existing: workoutWindowByUUID[routeKey],
                   now: routeNow
               ) {
                // 同批多页可能再次看到同一条 workout：以最新登记为准（页交付才落入输出）。
                workoutWindowByUUID[routeKey] = registered
                pageWindowRegistrations[routeKey] = registered
            }
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
            // 🔴 B02（2026-10-17）：所有来源（正式页 / 近期回填 / rediscovery / 待办）在
            // fetch 之前统一过 `RouteQueryPolicy`。
            //
            // 旧条件把四个放行口**并排**写在这里：`previous.status != .settled`、
            // `hasWorkoutChange`、`rediscoveryIDs`、`executableTodoIDs`（全量重扫标志已删除）。
            // 于是同一条已被调度器判为 `blocked-size` / 未到期 `retry-wait` 的 UUID，
            // 只要被"近期窗口"或"正式页变更"重新发现一次，就绕过调度读一遍那份装不下的
            // GPX —— 调度器本身没错，错在它不是唯一入口。
            let queryDecision = RouteQueryPolicy.decide(
                todo: pendingTodoByUUID[routeKey],
                existing: previous,
                now: routeNow,
                maxRouteBytes: budget.maxRouteBytes,
                maxRouteFiles: budget.maxRouteFiles,
                hasWorkoutChange: hasWorkoutChange,
                // §4.2 步骤 6：定点重试只重开这一条；其他 UUID 的退避/阻塞不受影响。
                isExplicitRetry: retryWorkoutIDs.contains(routeKey),
                routeBudgetExhausted: routeBudgetExhausted
            )
            if queryDecision.executes {
                // R07：`executableTodoIDs` 是第四条件的**定点补查**通道 —— 待办被调度为
                // 可执行时不服从 `settled` 的降频（否则"有待办 + 已有状态行"的组合会每轮
                // 被发现、每轮被跳过，卡在队列里永远不查）。
                let fetch = try await routeEntries(
                    for: workout,
                    store: store,
                    // R04：页级暂存目录（不是批次目录）—— 本条的一切写入与"装不下 ⇒ 删
                    // 本轮分片"的回滚都只作用于本页私有文件；已接受页的产物不受影响。
                    directory: pageStaging,
                    warnings: warnings,
                    budget: budget,
                    usedRouteBytes: routeBytes + pageRouteBytes,
                    usedRouteFiles: routeCount + pageRouteCount
                )
                // An observation hash is not a server acknowledgement: a prior
                // GPX may still be pending after a quota refusal. Keep bounded
                // route retries until the protocol can acknowledge each route.
                // Switches on the **discriminated outcome**, never on `!budgetExhausted`:
                // a failed read (`RouteFetch.empty`) also has `budgetExhausted == false`,
                // and treating it as "done" used to drop the only retry lead (R03).
                // R07 同时修正归类：余额不足写 `routeBudget`、确实超满额才写 `routeOversized`。
                switch fetch.outcome {
                case .oversized:
                    // 整条轨迹装不进剩余额度：`routeEntries` 已把本轮分片回滚 ⇒ 零文件、
                    // 状态一个字不动；且**已知**该 workout 自身就超过满额预算 —— 额度重置
                    // 也装不下它。静默跳过会让用户永远不知道有数据没同步（P2-3），如实上报。
                    routeFiles = []
                    routeStopReason = .routeFile
                    // O02/WP-11 + R07：登记/更新为**持久 size 阻塞**（含**当时**的预算能力
                    // 指纹）—— 下批不再自动重读同一份不可装入的 GPX；只有能力提高或
                    // 用户显式重试（`reopened`）才重开。"整条超满额"的阻塞态也要有可见性。
                    // 记账走 `todoUpdates`（导出后立即落盘）：这是与页无关的事实，
                    // 不随页的交付/拒绝回退。
                    let oversizedBase = pendingTodoByUUID[routeKey] ?? PendingRouteTodo(
                        workoutUUID: routeKey, reason: .routeOversized, createdAt: routeNow
                    )
                    todoUpdates[routeKey] = RouteTodoScheduler.afterOversized(
                        oversizedBase, now: routeNow,
                        maxRouteBytes: budget.maxRouteBytes, maxRouteFiles: budget.maxRouteFiles
                    )
                    warnings.add("有一条跑步轨迹超过单批上限，暂未同步：\(routeKey)；已保留其同步状态")
                case .budgetDeferred:
                    // 余额不足（本轮分片已回滚、状态不动）：下批满额可再试 —— 不是"超满额"。
                    // R07：这条**不**改调度状态（余额不足不是这条路线的属性；已在队列里的
                    // 保持原状态 —— `todoUpdates` 底稿里已有它的现值）。只登记新发现的。
                    routeFiles = []
                    routeStopReason = .routeFile
                    pageNewTodos[routeKey] = PendingRouteTodo(
                        workoutUUID: routeKey, reason: .routeBudget, createdAt: routeNow
                    )
                case .unreadable:
                    // 🔴 R03：读取失败 ≠ 完成。待办**保留**（不记入 completed），状态一个字不动。
                    // `RouteFetch.empty`（授权拒绝 / 无数据 / 部分分段失败）曾经因为
                    // `budgetExhausted == false` 落进"完成"分支：那条路线的唯一重试线索被删掉，
                    // 而**无状态行**的 UUID 只能靠待办队列被发现（`rediscoveryCandidates`
                    // 只遍历已有状态行）⇒ 重启后永久不可发现。下轮由状态行的重查间隔、
                    // 发现队列或这条待办再次重试（读取失败本身是安全的：零文件、零状态推进）。
                    routeFiles = []
                    // R07：读取暂不可用 ⇒ **有界退避**（尝试 +1、`nextRetryAt` 由调度器给出）。
                    // 🔴 R03 的注释说过"普通 workout 的失败由状态行与发现队列的常规节奏重试"。
                    // 那个前提在**首次读取就失败**时不成立：它没有状态行（`rediscoveryCandidates`
                    // 只遍历已有状态行）、不在待办队列里、14 天近期窗口又够不到它，而 anchor
                    // 已经越过它 —— 四条发现通道同时关闭，这条路线永久不可发现（第三轮，2026-10-17）。
                    // 现在：首次失败也登记持久待办，按同一套有界退避定点重试。
                    let unreadable = RouteTodoScheduler.afterUnreadableFailure(
                        existing: pendingTodoByUUID[routeKey],
                        now: routeNow,
                        workoutUUID: routeKey
                    )
                    if pendingTodoByUUID[routeKey] == nil {
                        // 新登记与页交付同进同退：页被拒时下一批从同一 anchor 重查，
                        // 不会把同一次失败计成两次尝试。
                        pageNewTodos[routeKey] = unreadable
                    } else {
                        todoUpdates[routeKey] = unreadable
                    }
                case .observation(let observation):
                    // P1-3（2026-10-18 同步诊断）：**内容没变就不再重发 GPX**。
                    // 判据是纯函数（`RouteDeliveredContent`，回归逐组合钉着）：
                    // 摘要与"服务端已确认交付的那一版"相同、workout 没变更、也不是用户点名的
                    // 显式重试 ⇒ `routeFiles = []`。这同时让 workout XML 回到
                    // `hasWorkoutChange || !routeFiles.isEmpty` 的"无变更不输出"形态。
                    //
                    // 🔴 `deliveredHash` 只在**批次成功提交之后**写入（下面把它装进
                    // `pageRouteDecisions`，由 `markSuccess` 的路线结算事务落盘）。上传/导入
                    // 失败的批次不产生交付证据 ⇒ 下一轮照旧重发（ADR-004 决策二：删产物/
                    // 提交的顺序与"没确认 ≠ 已交付"同源）。
                    let includeGPX = RouteDeliveredContent.shouldIncludeGPX(
                        observation: observation,
                        deliveredHash: previous.deliveredHash,
                        workoutChanged: hasWorkoutChange,
                        isExplicitRetry: retryWorkoutIDs.contains(routeKey)
                    )
                    routeFiles = includeGPX ? fetch.entries : []
                    // O02/WP-11：这条待办路线**查过了** —— 记入可移除（页交付后才生效；
                    // 移除本身由调用方在**批次持久提交成功之后**、与状态落盘同一个本地
                    // 短事务里执行 —— 见 `SyncTaskStore.upsertRouteStates(removePendingTodos:)`）。
                    if pendingRouteTodoSet.contains(routeKey) {
                        pageCompletedTodos.append(routeKey)
                    }
                    if includeGPX {
                        // 预算按**字节**累计，口径 = 盘上 GPX 的 UTF-8 字节数（服务端 `statSync` 同口径）。
                        // 取 `fetch.bytes`（写文件时算好的 `document.utf8.count`）而不是回头再 `statSync`：
                        // 值与盘上逐字节同一次，且和 `entries` 严格同进同退。
                        pageRouteBytes += fetch.bytes
                    }
                    var nextRouteState = RouteSyncStateMachine.decide(
                        existing: previous,
                        observation: observation,
                        now: routeNow,
                        hasWorkoutChange: hasWorkoutChange
                    ).nextState
                    // 交付摘要随观测一起进候选：本批提交成功之后才成为"服务端已有这一版"的证据。
                    // 跳过重发时保持旧摘要（服务端本来就持有一模一样的内容）。
                    if includeGPX, let deliveredHash = observation.routeHash, !deliveredHash.isEmpty {
                        nextRouteState.deliveredHash = deliveredHash
                    }
                    pageRouteDecisions[routeKey] = nextRouteState
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
                // O02/WP-11：**区分两种跳过** —— 预算拒绝（本应查 ⇒ 登记持久待办，下批从
                // 待办队列定点补查）与调度/状态机决定不查（有记忆、不算待办）。
                //
                // 🔴 R07 步骤 9：已有待办必须**原样带旧对象**。用三字段新构造的 todo 会把
                // `schedState` / `attemptCount` / `nextRetryAt` / `blockedBudgetFingerprint`
                // 清成 NULL ⇒ 读侧按 ready 解释 ⇒ 退避与 size 阻塞每批被意外复位 ——
                // 那正是"无限续批"复发的方式。
                if case .deferred(reason: .routeBudget) = queryDecision,
                   RouteSyncStateMachine.shouldQuery(
                       existing: previous,
                       now: routeNow,
                       hasWorkoutChange: hasWorkoutChange
                   ) {
                    pageNewTodos[routeKey] = pendingTodoByUUID[routeKey] ?? PendingRouteTodo(
                        workoutUUID: routeKey, reason: .routeBudget, createdAt: routeNow
                    )
                }
            }
            // The recent window and bounded historical queue only discover late
            // routes. Without a workout change or a GPX retry, omit workout XML.
            guard hasWorkoutChange || !routeFiles.isEmpty else { continue }
            // R4b：本页先渲染进**内存缓冲** —— 写前字节闸门在页边境界定，
            // 整页放不下时一个字都不落盘（见页尾的 `budget.accepts`）。
            pageExported.append(workout)
            pageRouteCount += routeFiles.count
            pageRouteFiles.append(contentsOf: routeFiles)
            pageText += workoutXML(workout, routeNames: routeFiles.map(\.name))
        }
        // 页收尾：同一字节账判定。放不下 ⇒ 先缩查询页从同一 `anchorBefore` 重查；连单条
        // 都放不下才是有观测的阻塞（整页不写、锚不推进）。
        let pageBytes = pageText.utf8.count
        guard budget.accepts(xmlBytes: xml.offsetInFile, records: recordCount,
                             pageBytes: pageBytes, pageRecords: 0) else {
            // R04：被拒页的页级暂存目录整支删除 —— 它含本页已渲染但未交付的一切路线
            // 产物；已接受页的文件在**各自**的目录里，物理上不可能被这次删除碰到。
            try? FileManager.default.removeItem(at: pageStaging)
            if let shrunk = WorkoutPageShrink.nextLimit(after: pageLimit) {
                // 整页放不下 ⇒ 缩查询页从**同一** `anchorBefore` 重查（更小页更可能放得下）。
                pageLimit = shrunk
                continue
            }
            // 连单条都放不下 ⇒ 可见阻塞：整页不写、锚不推进（下一批从同一 anchorBefore 重来）。
            workoutStop = .workoutBytes
            break
        }
        try write(xml, pageText)
        for (key, value) in pageRouteDecisions { routeDecisions[key] = value }
        exportedWorkouts.append(contentsOf: pageExported)
        routeCount += pageRouteCount
        routeBytes += pageRouteBytes
        // R04：页交付 ⇒ 把本页路线文件并入**批次级清单**，按相对路径去重 —— 同名的后写
        // 版本**原子替换**前页的引用（"正式流版本优先"；不"遇到重复就丢弃后者"）。
        // 页级暂存目录继续保留：清单里的 `url` 指向它，打包时读的就是这里的版本。
        routeBatchFiles.merge(pageRouteFiles)
        // O01：页**完整交付** ⇒ 锚推进 + 本页删除并入池（未交付页的删除不进池、随锚一起
        // 回退，下批从同一 `anchorBefore` 重来 —— 与锚推进严格同进退）。
        for object in page.deleted where freshWorkoutIdSet.insert(object.uuid.uuidString).inserted {
            freshWorkoutIds.append(object.uuid.uuidString)
        }
        // O02/WP-11：待办同样"页级生效" —— 页交付后新登记才并入、已查完的才记入可移除
        // （被拒页的两种记录都随锚一起回退，下批重来）。
        for (uuid, todo) in pageNewTodos { newRouteTodos[uuid] = todo }
        for (uuid, window) in pageWindowRegistrations { windowRegistrations[uuid] = window }
        completedRouteTodos.append(contentsOf: pageCompletedTodos)
        if !streamDone { deliveredAnchor = page.next; anchorBefore = page.next }
        attachmentWorkouts = []
        pageLimit = Self.workoutPageLimit
        if streamDone { break }
        }

        // WP-12/WP-10：删除三分预扣（固定顺序：旧槽 → 本批 workout → 本批 record）。
        // 🔴 顺序不是风格：workout 删除必须**先于** record 删除占额 —— 否则 record 侧会在
        // drain 里把额度吃光。WP-10 改点：这里的 fresh 集合来自"已完整交付的页"（删除池），
        // 未交付页的删除随锚回退、下批重来（守恒式见 `DirectSyncDeletionPartition`）。
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

        // ⚠️ 这一句**刻意不并入** `DirectSyncCopy.readingIncrement`：它同时是
        // `apps/ios/tests/check-background-capabilities.py` 切出「逐 workout 轨迹循环」的
        // 定界符（`route_loop_end`，整行匹配）。改字会让那条既有门禁**新增一条失败**，而本批
        // 不改任何 .py —— 想统一它必须与那条门禁同批改。它本身是「读取」的细节文案，
        // 不属于 §10.3 明令移除的三句。
        await onProgress("正在读取心率与恢复数据")
        try Task.checkCancellation()
        let records = try await writeGlobalRecords(
            store: store, cursorData: recordCursors,
            xml: xml, warnings: warnings, budget: budget,
            deletionAllocation: allocation,
            // B2：轮转起点透传。2026-10-17 起**窗口 pass 与正式段共用同一个起点**（旧实现
            // 窗口恒从下标 0 开始，预算总被前几个高频类型用光，排尾的跑步动态类型被挤掉）。
            typeRotationStart: typeRotationStart,
            // P0-4：到期窗口（导出开始前从 store 读出 **+ 本批已交付页新登记的**）。
            // A1：只并入"页已交付"的登记（`windowRegistrations` 的写入点就是交付点），
            // 被拒页的窗口不进快照，下一批从同一锚点重来。
            workoutWindows: WorkoutBackfillScheduler.batchSnapshot(
                persisted: workoutBackfillWindows,
                acceptedPageRegistrations: Array(windowRegistrations.values)
            ),
            // P1-1：服务端覆盖表（空 = 老服务端/失败 ⇒ 历史段回落全量重放）。
            coverage: coverage,
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
        // R04：页面阶段收集的路线文件**在此一次并入**（按首次出现顺序；同名已在页交付时
        // 被后页版本替换）。顺序 = 页序（确定性）；路径集合在下面自校验唯一。
        files.append(contentsOf: routeBatchFiles.files)
        files.append(("sync-manifest.json", manifestURL))

        // R04 步骤 6：**打包前自校验** —— 路径集合唯一 + 每个引用真实存在。
        // 这是上游的明确判据（不是靠 ZIP 写入器兜底）：唯一性破了就当场失败、保留可恢复
        // 状态（任务行与产物都还在，下一次同步从同一份本地产物接着走）——绝不把一份
        // 必被接收器拒收的载荷发出去。
        do {
            var seenArtifactNames = Set<String>()
            for file in files {
                guard seenArtifactNames.insert(file.name).inserted else {
                    throw HealthKitExportError.duplicateArtifactPath(file.name)
                }
                guard FileManager.default.fileExists(atPath: file.url.path) else {
                    throw HealthKitExportError.missingArtifact(file.name)
                }
            }
        }

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
        // R07：待办调度的最终输出 = 被尝试待办的结局更新 ∪ 本批新登记（新登记覆盖）。
        var finalRouteTodos = todoUpdates
        for (uuid, todo) in newRouteTodos { finalRouteTodos[uuid] = todo }
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
            // O01（WP-10）：候选锚 = **最后完整交付页**的页锚（不是查询流末尾；被截断的页
            // 绝不随锚前推）。nil = 首装且一页都没交付（下批从全量重来 —— 重复导出但不丢）。
            workoutAnchor: deliveredAnchor.flatMap(encodeAnchor),
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
            nextTypeRotationStart: records.nextTypeRotationStart,
            // O02/WP-11 + R07：排序输出（表键 `(scope, uuid)`，顺序只影响确定性，不影响语义）。
            // 🔴 R07：输出 = **调度更新**（`finalRouteTodos`：被尝试待办的结局 + 显式重开的
            // 复位）∪ 本批新登记；同名时新登记覆盖（较新的判定）。旧的 `blocked-size`/退避
            // 行**原样带着调度字段**回传 ⇒ 调用方 upsert 时不会把它们清成 ready（否则
            // 退避/阻塞每批被意外复位 = 把 R07 要治的"无限续批"放回来）。
            pendingRouteTodos: finalRouteTodos.values.sorted { $0.workoutUUID < $1.workoutUUID },
            completedRouteTodos: completedRouteTodos,
            // P0-4：登记（先表后锚）与整窗查询记账（成功后才结算）分开输出 —— 两者落盘
            // 时机不同，合成一个数组会让"失败批次也把重试时刻推进"这种错误无法表达。
            workoutWindowRegistrations: WorkoutBackfillScheduler.normalized(Array(windowRegistrations.values)),
            workoutWindowUpdates: WorkoutBackfillScheduler.normalized(records.windowUpdates),
            channelCounts: records.counts
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

    /// P1-1：记录类型的**稳定标识集**（服务端覆盖探测的 `types` 参数，也是游标表的键）。
    ///
    /// 与 `recordSampleTypes` 同源（数量类型 + 睡眠分类）；特征类型（性别/生日）没有游标，
    /// 不参与覆盖探测。顺序按标识排序（确定性：同一请求每次参数相同，便于服务端缓存）。
    static var recordTypeIdentifiers: [String] {
        recordSampleTypes.map(\.identifier)
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

    /// 单页查询（O01/WP-10）：从 `anchor` 起把 anchored 流取**一页**（最多 `limit` 条样本）。
    ///
    /// 返回的 `next` 是**消费该页后**的候选锚 —— 只有"整页交付"后才允许提交（页循环负责；
    /// 旧 `runningWorkouts` 把整个流查到末尾、把**末尾锚**直接回传，被预算截断的页就永久丢了）。
    ///
    /// 🔴 `HKAnchoredObjectQuery` 的 `limit` 约束**样本**（`deletedObjects` 不随 limit 缩小
    /// —— 缩页重查会重复返回同一批删除，调用侧按 UUID 去重）。
    ///
    /// 错误转换与旧实现逐条同语义：授权失败 / 锁屏**绝不伪装成"空数据"**。
    private static func workoutPage(
        store: HKHealthStore,
        anchor: HKQueryAnchor?,
        predicate: NSPredicate,
        limit: Int
    ) async throws -> (added: [HKWorkout], deleted: [HKDeletedObject], next: HKQueryAnchor) {
        do {
            return try await anchoredWorkouts(
                store: store,
                anchor: anchor,
                predicate: predicate,
                limit: limit
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
        xml: FileHandle,
        warnings: WarningBag,
        budget: DirectSyncBatchBudget,
        deletionAllocation: DirectSyncDeletionAllocation,
        // B2：类型轮转起点（由 `exportArchive` 透传；见该函数参数说明）。
        typeRotationStart: Int,
        // P0-4：workout 级定向补齐窗口（已登记、未收口；由 `exportArchive` 透传）。
        workoutWindows: [WorkoutBackfillWindow],
        // P1-1：服务端覆盖表（空 = 老服务端/探测失败 ⇒ 历史段回落全量重放）。
        coverage: [String: SyncCoveragePolicy.TypeCoverage],
        onProgress: @escaping @Sendable (String) async -> Void
    ) async throws -> (
        count: Int, cursors: Data, deleted: [[String: String]],
        budgetStopReason: HealthKitExportResult.BudgetStopReason?,
        nextTypeRotationStart: Int,
        // P0-4：本批整窗查询的记账（成功后才由调用方结算）。
        windowUpdates: [WorkoutBackfillWindow],
        // P2-3：各通道计数（只写计数）。
        counts: ExportChannelCounts
    ) {
        // Corrupt cursors fail closed. They are never silently turned into a
        // window query; a missing type starts from nil and reads all history.
        var cursors = try cursorData.map {
            try JSONDecoder().decode([String: HealthKitRecordCursor].self, from: $0)
        } ?? [:]
        let now = Date()
        var count = 0
        // P2-3（2026-10-18 同步诊断）：本批各通道的计数（只写计数、不写样本值）。
        // 它回答诊断里最大的盲区 —— "每批 4500 条里到底是谁占的"：只有服务端
        // `insertedRecordCount` 时，只能从份额数学反推"900 窗口 + 642 补读装不满 4500，
        // 所以一定是 anchor/重放填的"。有了这些计数，日志与任务行能直接给出结论。
        var channelCounts = ExportChannelCounts()
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
        // 本批真正写进 XML 的类型（只用于末尾的"该有却没有"可见告警，不参与任何控制流）。
        var writtenTypes: Set<String> = []
        // 迟到补读在**本批**已经完整覆盖过的类型：48h 窗口 pass 对它们可以跳过
        // （补读是"最新优先"，最近 48h 必在其覆盖内 —— 这是 O05 步骤 5 的批内去重）。
        // 🔴 刻意与 `writtenTypes` 分开：workout 补齐窗口只写"一次训练的时间窗"，
        // 它写过的类型**不**代表近 48h 已覆盖；拿 `writtenTypes` 去挡 48h 窗口会漏掉
        // 该类型在训练窗口之外的近期样本。
        var windowCoveredTypes: Set<String> = []
        // 本批**窗口 pass 真正查过**的类型（O05 门控之后），以及其中**查回空**的类型。
        // 告警必须用"查过且为空"，不能用 `writtenTypes`：被 `needsHistoryRead` 门控掉的类型
        // 没查过、被 20% 份额挤掉的类型是"没写完"，都不能算"该有却没有"。
        var windowEligible: Set<String> = []
        var windowReturnedEmpty: Set<String> = []
        // 2026-10-17：**跑步动态迟到样本**的一次性按日期补读（`LateDynamicsBackfill`）。
        //
        // 为什么单独一条通道：Apple Watch → iPhone 的样本传输可能晚于 B1 的近 48h 窗口
        // （2026-10-14 的跑步实测踩中：10-16 的两次窗口查询都返回空，样本 10-17 才出现在
        // 手机健康 App 里，而那时窗口下界已经越过那天）。窗口过期后锚点流又排在历史重放
        // 队尾，两条通道都够不着 ⇒ 只能按**日期**补一次。
        //
        // 四条纪律与窗口 pass 同源：
        //   ① 有界 + 最新优先（`recentSamples` 按 startDate 降序、单类型 ≤ `LateDynamicsBackfill.limit`）；
        //   ② **写前判定**：整页装不下就整页不写、**不推进记账**（下一批重试）；
        //   ③ 🔴 空页**不记账**（`PageOutcome.retry`）：HealthKit 对未授权读、或样本尚未从手表
        //      同步到手机时都只返回空、不报错。把一次空查询当成"补过了"会把这条唯一的恢复
        //      通道自己关死 —— 那正是 2026-10-14 事故的同类形态（当时窗口查询也返回空，
        //      却把该时段记成了"已交付"，之后永远不再覆盖）。成功/截断才记账。
        //   ④ 只服务**已建立游标**的类型（首装由历史重放从头读，不需要补读）。
        //   ⑤ **独立预算份额 + 两趟结构**（2026-10-18 深度审查 P2-06）：补读**第一趟**排在
        //      窗口与 anchor 循环之前，但只允许用批预算的 15%（`lateBackfillShare`），
        //      窗口 20% ⇒ anchor 流至少保留 65%。**第二趟（top-up）**在 anchor 循环之后、
        //      只受"剩余全量预算"约束：anchor 流与窗口都已跑完，剩下没花掉的额度本来就闲着。
        //      🔴 为什么必须两趟而不是只加份额：份额会把单批补读压到 642 条，而 4 个类型的
        //      14 天窗口在高密度跑者身上是 10⁴~10⁵ 条 ⇒ 只靠份额要上百批才收敛，等于把
        //      "anchor 被饿"换成"补读永远补不完"。两趟里第二趟在稳态（anchor 已追平、预算
        //      几乎全闲）能一次用掉整批，收敛回到个位数批次，同时第一趟保证重放期也不被饿。
        //   ⑥ **窗口下界固定**（P3-22）：分页跨多批时复用 `lateBackfillWindowStart`，不再每批
        //      用新的 `now` 重算 —— 否则前缘漂移，最老一小段从未读过却被记成已覆盖。
        //
        // 重复发送是无害的：同一 UUID 可能也被同批的历史重放再发一次，服务端按
        // `RAIHealthKitSampleUUID` 身份幂等（last-wins），且本函数从不推进正式 anchor。
        let lateBackfillShare = DirectSyncBatchBudget.lateBackfillShare(of: budget)

        // ── P0-4（2026-10-18 同步诊断）：workout 级定向补齐窗口 ─────────────────────
        //
        // 位置是**判据的一部分**：必须在迟到补读 / 48h 窗口 / 正式 anchor 重放**之前**跑。
        // 理由与 B1 窗口、10-17 补读同源且更强 —— 重放期 anchor 流每批都会把预算用满，
        // 任何排在它后面的通道都会被饿死；而这条通道服务的正是"刚跑完、样本还在从手表往
        // 手机里落"的那个窗口（2026-10-18 实测：6km 跑步跑完 3 分钟只到了 4 类样本，
        // speed/power/cadence 等是后续 36–72 h 才陆续到达的）。
        //
        // 三条纪律：
        //   ① **全类型**：遍历所有 quantity descriptors（不只是 4 类跑步动态）；
        //   ② **有界 + 独立份额**（25%，`workoutWindowShare`）：单窗口单类型 limit 1500，
        //      单批最多 `passBatchLimit` 条窗口，页大小按剩余份额收窄 —— 装不下就整页不写、
        //      该窗口本轮**不记账**（下批重试），绝不把正式流饿死；
        //   ③ **不推进正式 anchor**：用 `recentSamples`（无锚点 + 时间谓词）查询，只写载荷。
        //      与 48h 窗口/正式段可能写出同一批样本是**有意接受**的：服务端按
        //      `RAIHealthKitSampleUUID` last-wins 幂等，而这条通道有 7 天上限与重试序列。
        let workoutWindowShare = DirectSyncBatchBudget.workoutWindowShare(of: budget)
        var workoutWindowUpdates: [WorkoutBackfillWindow] = []
        var workoutWindowShareBytes = 0
        var workoutWindowShareRecords = 0
        // 只对 quantity 类型做窗口查询：睡眠是分类样本、与"一次跑步的时序"无关。
        let windowQuantityDescriptors: [(HKSampleType, HKUnit?, String, String?)] =
            descriptors.filter { $0.1 != nil }
        for window in WorkoutBackfillScheduler.due(workoutWindows, now: now) {
            // 份额已耗尽 ⇒ 本批不再处理更多窗口（它们保持到期状态，下批优先）。
            guard workoutWindowShareBytes < workoutWindowShare.maxBytes,
                  workoutWindowShareRecords < workoutWindowShare.maxRecords else { break }
            var observedSamples = 0
            var windowCompleted = true
            for (type, unit, xmlType, xmlUnit) in windowQuantityDescriptors {
                try Task.checkCancellation()
                let estimate = workoutWindowShareRecords > 0
                    ? max(1, workoutWindowShareBytes / workoutWindowShareRecords) : 512
                let pageLimit = DirectSyncBatchBudget.shareLimitedPageSize(
                    pageLimit: WorkoutBackfillScheduler.perTypeLimit,
                    shareBytesLeft: workoutWindowShare.maxBytes - workoutWindowShareBytes,
                    shareRecordsLeft: workoutWindowShare.maxRecords - workoutWindowShareRecords,
                    estimatePerRecord: estimate
                )
                guard pageLimit > 0 else { windowCompleted = false; break }
                let predicate = HKQuery.predicateForSamples(
                    withStart: window.windowStart, end: window.windowEnd, options: .strictStartDate
                )
                do {
                    let samples: [HKSample] = try await recentSamples(
                        type: type, predicate: predicate, limit: pageLimit, store: store
                    )
                    observedSamples += samples.count
                    if !samples.isEmpty {
                        let page = try renderedRecordPage(
                            added: samples, deleted: [], xmlType: xmlType, unit: unit, xmlUnit: xmlUnit
                        )
                        // 写前判定（与两个子通道同一个 `acceptsWithin`）：整页放不下 ⇒
                        // 本窗口本轮**不记账**（样本已查询但不写，下批重来；服务端幂等）。
                        guard DirectSyncBatchBudget.acceptsWithin(
                            budget: budget,
                            share: workoutWindowShare,
                            shareBytesUsed: workoutWindowShareBytes,
                            shareRecordsUsed: workoutWindowShareRecords,
                            xmlBytes: xml.offsetInFile, records: count,
                            pageBytes: page.data.count, pageRecords: page.recordCount
                        ) else { windowCompleted = false; break }
                        try xml.write(contentsOf: page.data)
                        count += page.recordCount
                        workoutWindowShareBytes += page.data.count
                        workoutWindowShareRecords += page.recordCount
                        writtenTypes.insert(xmlType)
                    }
                } catch {
                    // 与类型循环同口径：授权/无数据 ⇒ 该类型按"空"处理（其余类型照查），
                    // 库不可达 ⇒ 抛（绝不把锁屏当成空窗口）。
                    if isAuthorizationError(error) || isNoDataError(error) { continue }
                    if isDatabaseInaccessible(error) { throw HealthKitExportError.databaseLocked }
                    throw error
                }
            }
            guard windowCompleted else {
                // 预算/份额把这一趟切断了：**不记账**（下批从同一窗口重来）。
                // 已写出的样本不回滚（载荷是追加写的），服务端按 UUID 幂等吸收重复。
                break
            }
            let updated = WorkoutBackfillScheduler.afterPass(
                window, observedSamples: observedSamples, now: now
            )
            workoutWindowUpdates.append(updated)
            channelCounts.workoutWindows += 1
            channelCounts.workoutWindowRecords += observedSamples
            if updated.isCompleted { channelCounts.workoutWindowsCompleted += 1 }
        }

        /// 跑一趟补读（见 ⑤）。`enforceShare == true`：用独立份额；`false`：用剩余全量预算。
        func runLateBackfill(enforceShare: Bool) async throws {
            var usedBytes = 0
            var usedRecords = 0
            let limitBytes: Int
            let limitRecords: Int
            if enforceShare {
                limitBytes = lateBackfillShare.maxBytes
                limitRecords = lateBackfillShare.maxRecords
            } else {
                // top-up：本批还没用掉的额度就是这一趟的"份额"。
                // 取 `Int(min(...))` 而不是无符号相减：`offsetInFile` 可能已超过预算。
                limitBytes = max(0, budget.maxXmlBytes - Int(min(xml.offsetInFile, UInt64(budget.maxXmlBytes))))
                limitRecords = max(0, budget.maxRecords - count)
            }
            guard limitBytes > 0, limitRecords > 0 else { return }
            for (type, unit, xmlType, xmlUnit) in descriptors {
                guard LateDynamicsBackfill.types.contains(xmlType) else { continue }
                guard let before = cursors[xmlType],
                      LateDynamicsBackfill.needs(cursor: before, now: now) else { continue }
                try Task.checkCancellation()
                // ⑤ 的一半：本页取数上限必须**收进本趟额度**（否则满页 1500 条永远放不进
                // 642 条的份额 ⇒ 补读被自己的闸门锁死，零进展）。每记录字节估计优先用本趟
                // 已写均值，本趟还没写过就用偏大的保守值（高估只会让页更小，不会超额度）。
                let estimatePerRecord = usedRecords > 0 ? max(1, usedBytes / usedRecords) : 512
                let pageLimit = DirectSyncBatchBudget.shareLimitedPageSize(
                    pageLimit: LateDynamicsBackfill.limit,
                    shareBytesLeft: limitBytes - usedBytes,
                    shareRecordsLeft: limitRecords - usedRecords,
                    estimatePerRecord: estimatePerRecord
                )
                // 额度已用尽 ⇒ 本趟不再补读（下一批重新给满额；与 `drain` 的页首收手同族）。
                guard pageLimit > 0 else { continue }
                // 分页上界：上一批被单类型上限截断时，本批只读 `[windowStart, before)` 那段 ——
                // "14 天里跑步很多"也不会因为只取"最新 1500 条"而漏掉更老的那次跑步。
                // 下界优先取持久化的固定起点（P3-22），只有第一页才用 `now − lookback`。
                let windowStart = LateDynamicsBackfill.windowStart(cursor: before, now: now)
                let pageUpperBound = before.lateBackfillBefore ?? now
                do {
                    let late: [HKSample] = try await recentSamples(
                        type: type,
                        predicate: HKQuery.predicateForSamples(
                            withStart: windowStart,
                            end: pageUpperBound,
                            options: .strictStartDate
                        ),
                        limit: pageLimit,
                        store: store
                    )
                    // 只有真的到了**单类型上限**（而不是被份额收窄）才提示：份额收窄是正常分批。
                    if late.count >= LateDynamicsBackfill.limit {
                        warnings.add("近 14 天跑步动态补读命中单类型上限（\(xmlType)）：下一批继续读更老的一段")
                    }
                    if !late.isEmpty {
                        let page = try renderedRecordPage(
                            added: late, deleted: [], xmlType: xmlType, unit: unit, xmlUnit: xmlUnit
                        )
                        // 份额 + 全量预算**双闸门**（P2-06）：任一不满足都整页不写、不记账。
                        guard DirectSyncBatchBudget.acceptsWithin(
                            budget: budget,
                            share: (maxBytes: limitBytes, maxRecords: limitRecords),
                            shareBytesUsed: usedBytes,
                            shareRecordsUsed: usedRecords,
                            xmlBytes: xml.offsetInFile, records: count,
                            pageBytes: page.data.count, pageRecords: page.recordCount
                        ) else { continue }   // 装不下 ⇒ 不记账，下一批重试
                        try xml.write(contentsOf: page.data)
                        count += page.recordCount
                        usedBytes += page.data.count
                        usedRecords += page.recordCount
                        channelCounts.backfillRecords += page.recordCount
                        writtenTypes.insert(xmlType)
                        windowCoveredTypes.insert(xmlType)
                    }
                    switch LateDynamicsBackfill.pageOutcome(
                        returned: late.count,
                        // 截断判据用**本页实际取数上限**：被额度收窄的页命中它就是"还有更老的一段"。
                        truncated: late.count >= pageLimit,
                        oldestSample: late.map(\.startDate).min(),
                        windowStart: windowStart,
                        paging: before.lateBackfillBefore != nil
                    ) {
                    case .completed:
                        cursors[xmlType] = HealthKitRecordCursor(
                            anchor: before.anchor,
                            historyReadAt: before.historyReadAt,
                            historyReplayPhase: before.historyReplayPhase,
                            recentWindowReadAt: before.recentWindowReadAt,
                            lateBackfillAt: now,
                            lateBackfillBefore: nil,
                            lateBackfillWindowStart: nil,   // 整窗已覆盖 ⇒ 下次补读重新取窗口
                            // P1-1：覆盖下界是**历史重放段**的记账，补读重建必须透传（同上）。
                            historyCoverageFloor: before.historyCoverageFloor
                        )
                    case .nextPage(let nextPageUpperBound):
                        cursors[xmlType] = HealthKitRecordCursor(
                            anchor: before.anchor,
                            historyReadAt: before.historyReadAt,
                            historyReplayPhase: before.historyReplayPhase,
                            recentWindowReadAt: before.recentWindowReadAt,
                            lateBackfillAt: before.lateBackfillAt,
                            lateBackfillBefore: nextPageUpperBound,
                            // 固定下界（P3-22）：后续页复用这次的开场值，绝不随批次前移。
                            lateBackfillWindowStart: windowStart,
                            historyCoverageFloor: before.historyCoverageFloor
                        )
                    case .retry:
                        // 🔴 空页**不记账**（与 ③ 同一条纪律）：HealthKit 对未授权读取、或样本
                        // 还没从手表同步到手机时都只返回空、不报错。把一次空查询当成"补过了"，
                        // 这条唯一的恢复通道就被自己关死 —— 升级后第一次同步若恰好碰上权限
                        // 未开/样本未到，就再也补不回来。
                        continue
                    }
                } catch {
                    // 与类型循环同口径：授权/无数据 ⇒ 跳过该类型（下批重试）；库不可达 ⇒ 抛。
                    if isAuthorizationError(error) || isNoDataError(error) { continue }
                    if isDatabaseInaccessible(error) { throw HealthKitExportError.databaseLocked }
                    throw error
                }
            }
        }
        // 第一趟：份额内（保证 anchor 流保底）。
        try await runLateBackfill(enforceShare: true)
        // B1（2026-10-16）**近期窗口 pass**：每个类型先用一次**有界**查询把近 48h 数据送到
        // —— 历史重放可能持续数天，而训练详情/恢复评估要用的近期心率/睡眠不能排在队尾。
        // 🔴 四条纪律：
        //   ① 窗口**独立于正式 anchor**（它自己记账在 `recentWindowReadAt`；正式锚只由下面的
        //      历史/增量段推进）；
        //   ② 窗口**绝不**把整批预算吃光 —— 装不下就跳过该类型（不推进记账，下批重试），
        //      历史段照跑（`continue`，不是 `break`）；
        //   ③ 删除事件**不**由窗口负责（无锚点查询看不到删除；删除仍归增量流/历史段）；
        //   ④ WP-13（O05）：窗口只在"确有初始化/积压"时启用，且有**独立份额**（见下）。
        var windowBytesUsed = 0
        var windowRecordsUsed = 0
        // 2026-10-17：窗口 pass 也按**持久化轮转起点**环绕（O05 步骤 4「窗口类型公平调度」）。
        // 旧实现恒从描述符下标 0 开始：份额固定时，能在这批拿到窗口的永远是前几个高频类型，
        // 排尾的低频类型（跑步动态、睡眠）要等前面全部"当场无数据"才轮得到。
        // ⚠️ 这不是 2026-10-14 那次的成因（那次是 HealthKit 对这两类查回空，且当时批内
        // 余量充足 —— 见 deliverables/RUNNING_POWER_GCT_MISSING_2026-10-17.md §二.3/§四），
        // 它是一条**独立的防饿死**修正；轮转起点由 B2 的 `typeRotationStart` 透传。
        for offset in 0..<descriptors.count {
            let index = (typeRotationStart + offset) % descriptors.count
            let (type, unit, xmlType, xmlUnit) = descriptors[index]
            try Task.checkCancellation()
            let previousWindow = cursors[xmlType]
            // 本批刚被「迟到样本补读」整页覆盖过（补读是"最新优先"⇒ 最近 48h 必在其中）：
            // 再走窗口只会在同一份 `export.xml` 里把同一批样本写第二遍（O05 步骤 5 的批内
            // 去重；服务端虽然按 UUID 幂等，但没必要白占预算）。
            guard !windowCoveredTypes.contains(xmlType) else { continue }
            // WP-13（O05，步骤 1-2）：窗口只为"重放期"服务 —— 该类型**首装**（无游标）或
            // **历史重放还没做完**（复用正式循环同源的生产判据 `needsHistoryRead`，含显式
            // force）时才补读近窗。稳态（普通增量）下正式流本身就近实时，每批补读窗口
            // 只是白花查询与预算。
            let needsRecentWindow = previousWindow == nil
                || previousWindow!.needsHistoryRead()
            guard needsRecentWindow else { continue }
            windowEligible.insert(xmlType)
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
                // WP-13（O05，步骤 6）：命中单类型上限只说明**窗口可能被截断**，如实记入
                // warnings（其余部分由正式流补齐 —— 窗口是加速器，不是唯一通道）。
                // 截断仍推进水位（页面是"最新优先"，更早的部分交给锚点流）；但见下面的
                // 2026-10-17 修正：**空窗**不再推进。
                if recent.isEmpty { windowReturnedEmpty.insert(xmlType) }
                if recent.count >= Self.recentWindowLimit {
                    warnings.add("近期窗口查询命中单类型上限（\(xmlType)）：该窗口可能被截断，其余由增量流补齐")
                }
                var windowWritten = false
                if !recent.isEmpty {
                    let page = try renderedRecordPage(
                        added: recent, deleted: [], xmlType: xmlType, unit: unit, xmlUnit: xmlUnit
                    )
                    // 同一字节账 + **窗口独立份额**（WP-13/O05：窗口 ≤ 总预算 20%，正式流保留
                    // ≥80%；窗口自己的份额用满就跳过该类型 —— 剩余份额不回流给窗口超用）。
                    // 判据统一走 `DirectSyncBatchBudget.acceptsWithin`（与补读通道同一个函数，
                    // 2026-10-18 审查 P2-06：两条子通道此前各写一份内联判定，补读那份漏了份额）。
                    let windowShare = DirectSyncBatchBudget.recentWindowShare(of: budget)
                    if DirectSyncBatchBudget.acceptsWithin(
                        budget: budget, share: windowShare,
                        shareBytesUsed: windowBytesUsed, shareRecordsUsed: windowRecordsUsed,
                        xmlBytes: xml.offsetInFile, records: count,
                        pageBytes: page.data.count, pageRecords: page.recordCount
                    ) {
                        try xml.write(contentsOf: page.data)
                        count += page.recordCount
                        windowBytesUsed += page.data.count
                        windowRecordsUsed += page.recordCount
                        channelCounts.windowRecords += page.recordCount
                        writtenTypes.insert(xmlType)
                        windowWritten = true
                    }
                }
                // 2026-10-17 修正：只有**整页真的写进本批**才算"这段已交付" —— 判据统一走
                // `RecentWindowAccounting.nextMark`：空窗 / 装不下的页一律 `written: 0` ⇒
                // 返回 `nil` ⇒ 不重建游标、水位原地不动。空结果只说明"此刻没有数据"，不等于
                // "这段时间已交付"：样本迟到（Apple Watch → iPhone 传输延迟）时，只有靠下一批
                // 用同一个窗口再查一次才能捡回。旧实现把空窗也记成 `now`，窗口下界随之越过
                // 那段时间 ⇒ 该类型永远不再覆盖它 —— 2026-10-14 跑步的功率/触地时间就是这样
                // 从"晚一点到"变成"永远缺失"的。空查询不写字节，成本只是多一次 `HKSampleQuery`
                // （代价量化见 `RecentWindowAccounting` 头注释：重放期每批每空类型 1 次）。
                if let previousWindow,
                   let mark = RecentWindowAccounting.nextMark(
                       written: windowWritten ? recent.count : 0, now: now) {
                    cursors[xmlType] = HealthKitRecordCursor(
                        anchor: previousWindow.anchor,
                        historyReadAt: previousWindow.historyReadAt,
                        historyReplayPhase: previousWindow.historyReplayPhase,
                        recentWindowReadAt: mark,
                        lateBackfillAt: previousWindow.lateBackfillAt,
                        lateBackfillBefore: previousWindow.lateBackfillBefore,
                        // P3-22：补读的分页/窗口记账必须**透传**。这两处重建都在补读循环之后，
                        // 少带一个字段就等于把本批刚写下的分页位置清掉（下一批重读同一页）。
                        lateBackfillWindowStart: previousWindow.lateBackfillWindowStart,
                        // P1-1：覆盖下界同理（历史段跨多批续读时必须沿用同一个下界）。
                        historyCoverageFloor: previousWindow.historyCoverageFloor
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
        // 2026-10-17：**"该有却没有"的可见性**。跑步动态在同一个窗口里出现「配速/步幅/
        // 垂直振幅有数据、功率/触地时间没有」时，此前整条链**零痕迹**（空结果不写 warning、
        // 回执也不带类型信息），排查只能靠线上库反推。
        // 判据必须落在「本批**真的查了**、且**查回空**」的类型上（`windowReturnedEmpty`）：
        // 被 O05 门控掉的类型没查过、被 20% 份额挤掉的类型是"没写完"而不是"没有数据"，
        // 都不能算"该有却没有"（否则会把预算问题误报成权限问题）。
        // 这里只加一条提示，不改任何控制流。
        let dynamicsSilent = ["HKQuantityTypeIdentifierRunningPower",
                              "HKQuantityTypeIdentifierRunningGroundContactTime"]
            .filter { windowReturnedEmpty.contains($0) }
        let dynamicsSiblingsWritten = ["HKQuantityTypeIdentifierRunningSpeed",
                                       "HKQuantityTypeIdentifierRunningStrideLength",
                                       "HKQuantityTypeIdentifierRunningVerticalOscillation"]
            .contains { writtenTypes.contains($0) }
        if !dynamicsSilent.isEmpty && dynamicsSiblingsWritten {
            warnings.add("本次同步没有跑步功率/触地时间样本（其余跑步动态有）；"
                + "若健康 App 该时段有数据，请检查本 App 的读取权限，或在设置里重试同步")
        }
        // 2026-10-18（深度审查 P3-24）：**稳态**下的同一条缺口不能只靠上面那段。
        // 上面那段要求窗口 pass 真的查过该类型，而窗口 pass 只在重放/首装期启用 ⇒
        // 事故当时与之后的稳态增量（游标已建立、无重放）永远走不到这条判据，"又缺了"
        // 依旧零痕迹。稳态这里改为**非用户可见**诊断（只进 NSLog），判据同样要求
        // "功率/触地时间本批一条都没写、但同族其它跑步动态写了" —— 用户侧告警保持克制，
        // 避免把预算/时序问题当成权限问题反复弹给用户。
        // 判据本体是纯函数（`LateDynamicsBackfill.steadyStateGapDiagnostics`），有回归钉住。
        for line in LateDynamicsBackfill.steadyStateGapDiagnostics(writtenTypes: writtenTypes) {
            NSLog("%@", line)
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
            guard previous == nil || decoded != nil else {
                throw HealthKitExportError.invalidRecordAnchor
            }
            let history = previous == nil || decoded == nil
                || previous!.needsHistoryRead()
            do {
                // 本轮的段计划由 `RecordReplayPlan`（纯逻辑，回归逐组合钉着）决定：
                // 初次重放 = 先增量段（保住删除事件）再历史段（从头）；上轮中断在历史段 =
                // 只续历史段断点。这里只做接线。
                let resumingHistoryPhase = previous?.historyReplayPhase == .history
                // P1-1（2026-10-18 同步诊断）：服务端覆盖探测给出的**历史段查询下界**。
                // 只有"确实要重放"的类型才有意义；稳态增量哪怕拿到覆盖点也不会用它
                // （下层 `segmentFloor` 只把下界交给历史段）。
                let coverageFloor = SyncCoveragePolicy.historyFloor(
                    type: xmlType, coverage: coverage, now: now
                )
                let coverageRestart = SyncCoveragePolicy.shouldRestartHistory(
                    cursor: previous, floor: coverageFloor
                )
                let segments = RecordReplayPlan.segments(
                    decodedAvailable: decoded != nil,
                    history: history,
                    resumingHistoryPhase: resumingHistoryPhase,
                    coverageRestart: coverageRestart
                )
                let starts: [HKQueryAnchor?] = segments.map { segment in
                    switch segment {
                    case .incremental, .historyResume: return decoded
                    case .historyFromScratch: return nil
                    }
                }
                var next: HKQueryAnchor?
                var interruptedPhase: HealthKitRecordCursor.HistoryReplayPhase?
                // 中断时**实际使用**的覆盖下界（见 `runSegment`）。必须记实际值而不是
                // `coverageFloor`：P1-1 的"空结果回落"会用**无谓词**重跑同一段，而续读
                // 必须沿用与锚点同源的谓词 —— 记错会让下一批换谓词、从页首重来。
                var interruptedCoverageFloor: Date?
                // 本类型**本轮最后一次实际查询**用的下界。P1-1 的"谓词粘住"靠它：历史段跑完
                // 之后游标也要继续带着同一个下界（下一批的增量查询沿用），绝不能清成 nil。
                var currentQueryFloor: Date? = SyncCoveragePolicy.allowsHistorySkip
                    ? previous?.historyCoverageFloor : nil
                // 本类型是否出现过"一段一页都没读"（S2.5）。
                var stoppedBeforePage = false
                if history { channelCounts.replayingTypes += 1 }
                if coverageFloor != nil, segments.contains(.historyFromScratch) {
                    channelCounts.historySkippedTypes += 1
                }
                // 每一段的查询下界（P1-1）：
                //   - `.incremental`：**沿用该类型已持久化的覆盖下界**。谓词一旦用过就"粘住"——
                //     `HKQueryAnchor` 与 predicate 的绑定关系 Apple 没有承诺"可换谓词"，所以
                //     用覆盖下界建立的锚点，之后的增量查询必须继续带同一个 `startDate` 谓词，
                //     不能切回 `predicate: nil`（切回是未定义行为；真机症状会是漏数据/整段重读）。
                //     下界之前的样本本来就按覆盖探测的取舍放弃（诊断 §7.4）。
                //   - `.historyFromScratch`：优先用**已持久化**的下界（锚点/谓词同源），
                //     否则用本轮覆盖探测给出的 `coverageFloor`（可空 ⇒ 旧的全量重放）。
                //   - `.historyResume`：必须沿用上一轮持久化的下界 —— 否则续读会从页首重来。
                func segmentFloor(_ segment: RecordReplayPlan.Segment) -> Date? {
                    // 🔴 A7 闸门（2026-10-19）：覆盖表证明不了区间连续 ⇒ 连**历史遗留在游标上的**
                    // 下界也一并作废。只挡住"新算出的下界"是不够的：一旦某个旧构建把下界写进
                    // 游标，下一批会从 `previous?.historyCoverageFloor` 把它捡回来继续用。
                    guard SyncCoveragePolicy.allowsHistorySkip else { return nil }
                    switch segment {
                    case .incremental: return previous?.historyCoverageFloor
                    case .historyFromScratch: return previous?.historyCoverageFloor ?? coverageFloor
                    case .historyResume: return previous?.historyCoverageFloor
                    }
                }
                /// 跑一段 drain。`floor` 显式传入（P1-1 的空结果回落会用它再跑一次无谓词版本）。
                func runSegment(index: Int, floor: Date?) async throws -> Bool {
                    currentQueryFloor = floor
                    // 🔴 写前判定（S2.5）：整页先渲染进内存，`budget.accepts` 通过才落盘。
                    let outcome = try await HealthKitRecordCursor.drain(
                        from: starts[index],
                        pageLimit: recordPageLimit,
                        query: { anchor, limit in
                            try await anchoredRecords(
                                store: store, type: type, anchor: anchor, limit: limit,
                                // P1-1：只给历史段传下界；nil = 保持 predicate 为 nil（默认）。
                                startDate: floor
                            )
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
                            // P2-3：正式 anchor/重放段写入的条数（只写计数）。
                            channelCounts.anchorRecords += page.recordCount
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
                            segments: segments, interruptedIndex: index)
                        // 续读要与锚点用**同一个**谓词：`floor` 就是刚才那次查询真正用的下界。
                        interruptedCoverageFloor = floor
                        return false
                    }
                    return true
                }
                for segmentIndex in segments.indices {
                    let segment = segments[segmentIndex]
                    let completed = try await runSegment(index: segmentIndex, floor: segmentFloor(segment))
                    if !completed { break }
                    // P1-1 **空结果安全回落**：带覆盖下界的历史段一条都没返回（服务端说覆盖过、
                    // 手机上这条时间线却查不到），它可能连锚点都建立不了。这时用**无谓词**
                    // 从 nil 重跑同一段（= 旧的全量重放）—— 宁可多读一次，也不把整批变成
                    // `missingRecordAnchor` 失败，更不允许游标因此永不建立。
                    // 只在"零提交 + 未触预算"时发生；有提交就一定已经有锚点。
                    if segment == .historyFromScratch,
                       segmentFloor(segment) != nil,
                       !stoppedBeforePage,
                       next == nil {
                        interruptedPhase = nil
                        budgetStopReason = nil
                        _ = try await runSegment(index: segmentIndex, floor: nil)
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
                    recentWindowReadAt: previous?.recentWindowReadAt,
                    // 2026-10-17：补读记账同样**透传**（上一段可能刚把它写成 `now`）。
                    // 新建游标保持 `nil`（= 还没补过）：首装/游标被清后，等这个类型读完第一页
                    // 出现游标，下一批再补一次近 14 天 —— 代价是一批重复记录（服务端按 UUID
                    // 幂等），换来的是"任何一次漏投都有一条确定的按日期恢复路径"。
                    lateBackfillAt: previous?.lateBackfillAt,
                    lateBackfillBefore: previous?.lateBackfillBefore,
                    // 2026-10-18（P3-22）：补读窗口下界也必须透传 —— 补读循环在本次构造
                    // **之前**就可能把 `lateBackfillWindowStart` 写进 `cursors[...]`（`previous`
                    // 读到的就是那时的值）。不带上会把它清成 nil ⇒ 下一批重新取 `now − 14d`，
                    // 前缘漂移的旧缺陷原样复现。
                    lateBackfillWindowStart: previous?.lateBackfillWindowStart,
                    // P1-1（Lead 复核修正）：覆盖下界**一旦用过就持久保留** —— 该类型之后
                    // **所有** anchor 查询（增量段也是）都必须带同一个 `startDate` 谓词。
                    // 中断时记"实际用的下界"；否则记本轮最后一次查询用的下界（历史段跑完
                    // 也保留）。⛔ 不要在历史段完成后清成 nil：换谓词用旧锚点没有文档保证。
                    // 唯一清除路径 = 显式「修复增量游标」（清掉该类型整条游标）。
                    historyCoverageFloor: interruptedPhase == .history
                        ? interruptedCoverageFloor : currentQueryFloor
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
        // 第二趟（top-up，见 ⑤）：anchor 流与窗口 pass 都已跑完，没花掉的额度本来就闲着 ⇒
        // 补读一次性用掉，让 14 天窗口在**少量批次**内收敛（只用份额时会拉成上百批）。
        // 只有 anchor 流**没被预算停住**时才 top-up：被停住说明额度确实用完了，再查一次
        // 只会多花 HealthKit 查询、一条也写不进去。
        if budgetStopReason == nil {
            try await runLateBackfill(enforceShare: false)
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let deleted = deletions.keys.sorted().flatMap { type in
            deletions[type]!.sorted().map { ["type": type, "uuid": $0] }
        }
        // B2：下一批的轮转起点 = 本批已开始处理的类型数（环绕推进；全批完成时回到原起点）。
        let nextRotation = (typeRotationStart + processedTypeCount) % max(1, descriptors.count)
        // P2-3：收口本批计数（类型数取最终写入集合；只写计数）。
        channelCounts.writtenTypes = writtenTypes.count
        if channelCounts.workoutWindows > 0 {
            NSLog("[RAI] workout 补齐窗口：本批处理 %d 条（收口 %d 条）",
                  channelCounts.workoutWindows, channelCounts.workoutWindowsCompleted)
        }
        if channelCounts.historySkippedTypes > 0 {
            NSLog("[RAI] 覆盖探测跳过已入库历史：本批 %d 个类型使用 knownUntil−24h 作为历史起点",
                  channelCounts.historySkippedTypes)
        }
        return (count, try encoder.encode(cursors), deleted, budgetStopReason, nextRotation,
                WorkoutBackfillScheduler.normalized(workoutWindowUpdates), channelCounts)
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

    /// 一页**变更流**（新增 + 删除 + 下一页锚点）。
    ///
    /// - Parameter startDate: P1-1（2026-10-18 同步诊断）的**历史段覆盖下界**。
    ///   `nil` = 查全流（旧行为，也是增量段的唯一形态）；非 nil = 只在历史段使用，
    ///   谓词为 `startDate >= 下界`，用于跳过服务端已覆盖的历史。
    ///
    ///   🔴 只在 `.historyFromScratch` / `.historyResume` 段传非 nil（调用点
    ///   `writeGlobalRecords` 的 `segmentFloor`）：增量段按事件时间过滤会**永久漏掉**
    ///   老样本的更正与删除事件 —— 那正是「历史变更不得按事件时间过滤」这条不变式的形态。
    ///   覆盖下界**一旦用过就持久保留**（"谓词粘住"）：该类型之后**所有** anchor 查询
    ///   （含增量段）都继续带同一个 `startDate` 谓词 —— 锚点与谓词必须同源，换谓词没有
    ///   文档保证（见 `HealthKitRecordCursor.historyCoverageFloor`）。
    ///
    ///   ⚠️ 谓词与锚点**必须同源**：`HKAnchoredObjectQuery` 的锚点是"变更序"位置，续读若
    ///   换了谓词就会从页首重来（每批空转）。所以中断在历史段时 `historyCoverageFloor`
    ///   随游标持久化，下一批沿用同一个下界。
    private static func anchoredRecords(
        store: HKHealthStore, type: HKSampleType, anchor: HKQueryAnchor?, limit: Int,
        startDate: Date? = nil
    ) async throws -> (added: [HKSample], deleted: [HKDeletedObject], next: HKQueryAnchor) {
        let box = QueryContinuation<(added: [HKSample], deleted: [HKDeletedObject], next: HKQueryAnchor)>()
        // P1-1：历史段的覆盖下界 → 事件时间谓词（只在有下界时构造，默认保持 nil）。
        let predicate: NSPredicate? = startDate.map {
            HKQuery.predicateForSamples(withStart: $0, end: nil, options: .strictStartDate)
        }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            let result = try await withCheckedThrowingContinuation { continuation in
                box.set(continuation)
                let query = HKAnchoredObjectQuery(type: type, predicate: predicate, anchor: anchor, limit: limit) {
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

        /// 🔴 R03（2026-10-16 复查）：路线的**结局面** —— 不再让调用方用
        /// `!budgetExhausted` 这个布尔补集去近似"成功"。
        ///
        /// 缺陷形态（复查证据："`observation == nil` 的失败结果进入完成分支"）：
        /// `RouteFetch.empty`（授权拒绝 / 无数据 / 部分分段失败的**读取失败**）的
        /// `budgetExhausted == false` ⇒ 旧调用侧把它读成"查完了" ⇒ 把待办从队列里移除 ——
        /// 而**没有状态行**的 UUID 只能靠待办队列被发现（`rediscoveryCandidates` 只遍历
        /// 已有状态行）⇒ 那条路线重启后永久不可发现。
        ///
        /// 四态互斥且穷尽；调用方 `switch` 它，漏判在编译期可见。
        var outcome: Outcome {
            if budgetExhausted { return oversized ? .oversized : .budgetDeferred }
            if let observation { return .observation(observation) }
            return .unreadable
        }

        nonisolated enum Outcome {
            /// 完整观测（含"零个点"的**合法零点**）：可以推进状态、可以把待办记入完成候选。
            case observation(RouteObservation)
            /// 暂不可读（读取失败；`RouteFetch.empty`）：状态一个字不动、待办**保留**
            ///（删掉它 = 把唯一的重试线索删掉）。
            case unreadable
            /// 余额不足（本轮的 workout 已按分片回滚）：登记/保留待办，下批满额可再试。
            case budgetDeferred
            /// 这条轨迹**按满额预算也装不下**：登记待办 + 可见警告，不无限前台重试。
            case oversized
        }
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
        let routesDirectory = directory.appendingPathComponent("workout-routes", isDirectory: true)
        try FileManager.default.createDirectory(at: routesDirectory, withIntermediateDirectories: true)
        // 🔴 流式写出（第三轮，2026-10-17）：旧实现先把整段路线拼成一个 `String`、算完字节
        // 再判预算 —— 一条 24 小时越野在"判定不通过"之前就已经付出整串内存。现在逐点写、
        // 逐点累计字节与 SHA256，每 512 点判一次预算，超限当场停读。
        // 产物与旧的 `gpx(_:)` 逐字节相同（格式串只有 `RouteGpxWriter.pointXML` 一份实现）。
        let writer = RouteGpxWriter(
            directory: directory,
            workoutId: routeFileWorkoutId(workout),
            maxRouteBytes: budget.maxRouteBytes,
            maxRouteFiles: budget.maxRouteFiles,
            usedRouteBytes: usedRouteBytes,
            usedRouteFiles: usedRouteFiles
        )
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
                writer.abort()
                if isDatabaseInaccessible(error) { throw HealthKitExportError.databaseLocked }
                throw error
            }
            guard !locations.isEmpty else { continue }
            try Task.checkCancellation()
            do {
                for location in locations {
                    try writer.append(RouteGpxPoint(location))
                }
                try writer.endSegment()
            } catch let stop as RouteGpxBudgetStop {
                // 装不下 ⇒ **整个 workout 的轨迹一起放弃**：半条轨迹比没有更坏
                // （xml 不声明它 ⇒ 载荷里会多出一个无主文件）。
                writer.abort()
                return RouteFetch(entries: [], observation: nil, bytes: 0,
                                  budgetExhausted: true, oversized: stop == .oversized)
            } catch {
                writer.abort()
                if isDatabaseInaccessible(error) { throw HealthKitExportError.databaseLocked }
                throw error
            }
        }
        // 部分段读取失败也不输出不完整路线，不以它覆盖已有 GPX 或积累稳定证据。
        guard complete else {
            writer.abort()
            return .empty
        }
        // 查询成功且没有任何条目 ⇒ 观测是"0 个点、没有摘要"。摘要用 `nil` 而不是空 SHA256 的十六进制：
        // 后者是一个"看起来像内容摘要"的值，会让"没有轨迹"和"有一段空轨迹"变成两回事。
        let written = try writer.finish()
        let observation = RouteObservation(
            pointCount: written.pointCount,
            routeHash: written.routeHash
        )
        return RouteFetch(entries: written.entries, observation: observation, bytes: written.bytes,
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

    /// 把一组点组合成一份 GPX 文档。**仅供回归做字节对照**：生产路径走 `RouteGpxWriter` 的流式写出，
    /// 两者共用同一份逐点格式（`RouteGpxWriter.pointXML`），所以"流式 == 组合"是可断言的。
    private static func gpx(_ locations: [CLLocation]) throws -> String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        var xml = RouteGpxWriter.header
        for location in locations {
            try Task.checkCancellation()
            xml += RouteGpxWriter.pointXML(RouteGpxPoint(location), iso: iso)
        }
        xml += RouteGpxWriter.footer
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

    /// 供修复入口判断"这个锚还解不解得开"（与导出侧**同一个**解码实现）。
    static func anchorIsReadable(_ data: Data) -> Bool {
        decodeAnchor(data) != nil
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

/// `CLLocation` → `RouteGpxPoint`。
///
/// 旧格式里"精度/速度/航向为负"就等于**省略该字段**（不是写 `-1`）。这里把它们映射成 `nil`，
/// 保持字节一致；负精度的点仍然保留时间与坐标，这是 Apple 的"不可信定位"的常见形态。
private extension RouteGpxPoint {
    nonisolated init(_ location: CLLocation) {
        self.init(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            elevationMeters: location.verticalAccuracy >= 0 ? location.altitude : nil,
            timestamp: location.timestamp,
            speedMetersPerSecond: location.speed >= 0 ? location.speed : nil,
            courseDegrees: location.course >= 0 ? location.course : nil,
            horizontalAccuracyMeters: location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : nil,
            verticalAccuracyMeters: location.verticalAccuracy >= 0 ? location.verticalAccuracy : nil
        )
    }
}
#endif
