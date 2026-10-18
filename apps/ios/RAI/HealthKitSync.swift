import Foundation
import Observation
import CryptoKit
#if os(iOS)
import HealthKit
import UIKit
#endif

/// §10.3 的用户文案表：普通健康同步说给用户听的句子都从这里取。
///
/// 依据 `docs/SQLITE_DIRECT_SYNC_DESIGN.md` §10.3（用户文案）与 §10.2（回执兼容升级）。
/// 为什么集中成一张表：这六句此前分散在多个调用点上，而 `HealthKitSync.swift` **不被任何
/// 回归脚本编译**（见文件末尾的说明）—— 文案退回旧语义时没有任何一条判据看得见。
/// 集中之后，"用户看到哪一句"与"它由哪个入口给出"都能被源码级门禁逐字断言。
///
/// 🔴 不要为了"去重"把 `saved` 与后面两个更长的句子拼起来（`saved + "，分析更新中"`）。
/// 门禁按**逐字字面量**断言六句都在源码里；拼接会让其中两句从源码中消失，判据随即失效。
/// 三句之间的重叠是这张表的形态，不是重复代码。
///
/// ⚠️ 本表只覆盖 §10.3 列出的六句。普通同步里还有几句描述**表外的真实状态**（等待 Apple
/// 健康授权、等待上一次已在服务端跑起来的导入、恢复上次同步任务、把本批产物写到本地），
/// §10.3 既没有给出对应句子、也没有把它们列进"移除"清单，因此原样保留 —— 不凭空造第七句。
nonisolated enum DirectSyncCopy {
    /// 读取阶段：导出跑步记录、心率/恢复数据，以及把本批打包。
    static let readingIncrement = "正在读取健康增量"
    /// 上传阶段：新建批次与「恢复已落盘的批次后继续上传」共用。
    static let uploadingBatch = "正在上传本批数据"
    /// 服务端接收阶段：本批事实与更正落库（§4.2 的那个事务）。
    static let persistingRecords = "正在保存新增与更正记录"

    /// 回执 `ingestStatus == committed` 且 `analysisStatus == not_required`：§9.1 明确
    /// "本批在结构上不影响分析"**不是**"分析已完成"，所以这里不许说成 `analysisPublished`。
    static let saved = "健康数据已保存"
    /// 事实已提交、分析在排队或正在跑（§10.2：分析另行跟踪）。
    static let savedAnalysisUpdating = "健康数据已保存，分析更新中"
    /// 分析已发布。
    static let analysisPublished = "分析已更新"
    /// 事实已保存、分析失败：可重试的是**分析**，不要求用户重新导出 HealthKit（§10.1）。
    static let savedAnalysisFailed = "健康数据已保存，分析更新失败，可重试分析"

    /// 语义通知（`DirectSyncCursorPolicy.DirectSyncNotice`，判据在 T2 那边）→ §10.3 的收尾句。
    ///
    /// `nil` = 本批还没有"已完成"的话可说（事实还在收 / 回执被服务端拒了），调用方必须
    /// 沿用今天的文案。判据刻意留在 T2 的 `notice(for:)`、这里只做"通知 → 句子"的映射：
    /// 两处各判一次"什么算已保存"，迟早会分叉（而分叉的那一天，用户看到的是一句假话）。
    static func completionCopy(for notice: DirectSyncCursorPolicy.DirectSyncNotice) -> String? {
        switch notice {
        case .factsSavedAnalysisNotRequired: return saved
        case .factsSavedAnalysisPending: return savedAnalysisUpdating
        case .factsSavedAnalysisPublished: return analysisPublished
        case .factsSavedAnalysisFailed: return savedAnalysisFailed
        case .savingFacts: return nil
        }
    }

    /// 结论 + 尾注的复合规则：结论只能是"健康数据已保存"这一族，本批计数与导出告警都只做
    /// 尾注 —— 不许把"分析是否更新"与"导入了多少次"混成一个结论（§10.3 的移除语义）。
    static func composed(base: String, notes: [String]) -> String {
        guard !notes.isEmpty else { return base }
        return "\(base)（\(notes.joined(separator: "；"))）"
    }
}

/// P0-6 / P2-3（2026-10-18 同步诊断）：**本批导出的轻量摘要**，供 UI 只读展示。
///
/// 为什么 UI 不能自己拼：本文件里"这一批到底带来了什么"的权威值来自
/// `HealthKitExportResult`（通道计数、预算停因、续页结论）与 `DirectSyncReceipt.records`
/// （服务端算出的新增/重复数），而两者都只在本进程内可见。摘要把它们折成一个值类型，
/// 每批导出完成时写入、`markSuccess` 拿到回执后补齐计数。
///
/// 🔴 三条纪律：
///   1. **只读、不轮询**：它是快照，不是进度流；UI 在 `dataUpdatedGeneration` 变化后读一次。
///   2. **不写健康数据**：只含计数与预算停因，不含样本值/UUID/日期。
///   3. `recordsInserted` / `recordsUnchanged` / `recordsParsed` 在**老服务端没有回执计数**时
///      保持 `nil` —— 绝不用 0 冒充"服务端说本批 0 新增"（那会把"不知道"说成"重复"）。
nonisolated struct ExportSummary: Equatable, Sendable {
    /// 本批 `export.xml` 里的记录条数（客户端口径）。
    let recordCount: Int
    /// 本批交付的训练 XML 条数。
    let workoutCount: Int
    /// 本批**查询过**的 workout 数（routeCount 的历史口径，见 `HealthKitExportResult`）。
    let routeCount: Int
    /// 本批实际发出的删除引用数（manifest 两段之和）。
    let deletionCount: Int
    /// 预算停因（`HealthKitExportResult.BudgetStopReason.rawValue`；`nil` = 没被预算停住）。
    let budgetStopReason: String?
    /// 本批是否还有未读页（= 被预算停住）。与 `hasPendingContinuation` 的"盘上待续槽"互补：
    /// 一个是"刚导出的这一批",一个是"已提交的待续哨兵"。
    let hasMorePages: Bool
    /// 服务端回执的记录计数；老服务端省略 `records` 时三者都 `nil`。
    let recordsParsed: Int?
    let recordsInserted: Int?
    let recordsUnchanged: Int?
    /// P0-4：本批处理/收口的 workout 定向补齐窗口数（只做展示与诊断）。
    let workoutWindowCount: Int
    let workoutWindowCompletedCount: Int
    /// 摘要写入时刻。
    let updatedAt: Date

    init(
        recordCount: Int,
        workoutCount: Int,
        routeCount: Int,
        deletionCount: Int,
        budgetStopReason: String?,
        hasMorePages: Bool,
        recordsParsed: Int? = nil,
        recordsInserted: Int? = nil,
        recordsUnchanged: Int? = nil,
        workoutWindowCount: Int = 0,
        workoutWindowCompletedCount: Int = 0,
        updatedAt: Date
    ) {
        self.recordCount = recordCount
        self.workoutCount = workoutCount
        self.routeCount = routeCount
        self.deletionCount = deletionCount
        self.budgetStopReason = budgetStopReason
        self.hasMorePages = hasMorePages
        self.recordsParsed = recordsParsed
        self.recordsInserted = recordsInserted
        self.recordsUnchanged = recordsUnchanged
        self.workoutWindowCount = workoutWindowCount
        self.workoutWindowCompletedCount = workoutWindowCompletedCount
        self.updatedAt = updatedAt
    }

    /// 回执到达后补齐计数（其余字段原样保留）。
    func withReceiptCounts(parsed: Int, inserted: Int, unchanged: Int) -> ExportSummary {
        ExportSummary(
            recordCount: recordCount,
            workoutCount: workoutCount,
            routeCount: routeCount,
            deletionCount: deletionCount,
            budgetStopReason: budgetStopReason,
            hasMorePages: hasMorePages,
            recordsParsed: parsed,
            recordsInserted: inserted,
            recordsUnchanged: unchanged,
            workoutWindowCount: workoutWindowCount,
            workoutWindowCompletedCount: workoutWindowCompletedCount,
            updatedAt: updatedAt
        )
    }
}

@Observable
@MainActor
final class HealthKitSync {
    var isBusy = false
    var message: String?
    var lastError: String?
    var lastSyncAt: Date?
    var lastWorkoutCount: Int?
    var phase: String = "idle"
    var dataUpdatedGeneration = 0
    private var activeToken = ""
    private var activeScope = "unbound"
    private var activeServerURL: URL?
    private var activeIdentity: RaiHandshake?
    /// 本次**导出起点**观察到的健康数据通知代次。
    ///
    /// 观察点必须在这里，不能放在"后台一轮的开头"：后台一轮完全可能是在**续传一份已经存在
    /// 的 ZIP**（那条分支不重新读 HealthKit），而通知说的是"有这次导出里没有的数据"。
    /// 按一轮的开头确认，等于让一份**早于通知生成**的字节去认领那条通知 —— 那批数据从此
    /// 没人导（要等下一次真实投递或用户手动点）。
    /// 只有"这一次导出真的开始了"才能说"它覆盖了这条通知"；代次比对
    /// （`shouldAcknowledgeIntent`）负责排掉导出期间又新到的那一条。
    private var backgroundIntentInFlight: HealthSyncBackgroundRecovery.IntentObservation?
    /// 本次导出起点观察到的**恢复请求**代次。成因与通知不同（见 `IntentCause`），
    /// 必须分开确认：合成一个槽会让"旧 scope 的导出"顺手删掉"新 scope 还没有批次"这条依据。
    private var backgroundRecoveryInFlight: HealthSyncScopeRecoveryStore.Observation?
    private let taskStore = SyncTaskStore()
    private let api = RaiAPIClient()
    private let syncOwner = HealthSyncTaskOwner()
    /// 本次中止的来源。生命周期中止与用户取消必须可分（理由见 `HealthSyncLifecycle.swift` 文件头）。
    /// 每次 `performSync` 开头重置，否则上一次的手动取消会让下一次在握手后立刻自杀。
    private var cancelCause: SyncCancelCause = .none

    /// 本轮 `BGProcessingTask` 的起点。**只在后台路径设置**（`performBackgroundPass`），
    /// 前台同步永远是 `nil`。
    ///
    /// 它是软预算（`BackgroundRunPolicy.shouldYield`）的执行时钟，唯一消费点在 `waitForJob`
    /// 的轮询里 —— 那里放弃是**零代价**的（`jobId` 已落盘，下次唤醒走 `.resumeJob` 从同一处
    /// 续接）。刻意不接到导出/上传上：那两个阶段被中断要重头来过（GB 级 HealthKit 导出是
    /// 整个流程最贵的一步），"主动收手"在那里不是保守而是自伤。判据本身是纯函数
    /// `BackgroundRunPolicy.shouldYieldPolling`（可被纯逻辑回归编译），这里只持有起点。
    private var backgroundPassStartedAt: Date?

    /// 上一次 `loadTask()` 是否遇到"磁盘上**有** payload 但解不开"。
    ///
    /// 与"没有任务"必须分开：解不开说明磁盘上留着一份属于**别的版本**的进度，把它当成
    /// "没任务"的可见后果是安静地重导整个窗口、计数归零，而 `sync_tasks` 里那一行还在。
    /// 加一个带默认值的非可选字段就会制造这个形态（见 `SyncTaskState` 的说明）。
    private(set) var taskDecodeError: String?

    /// 磁盘上是否留着一批**没走完**的工作。
    ///
    /// 与 `phase` 是两件事：`phase` 是**本次进程内**的自述，重启后回到 `idle`；这个字段
    /// 读的是 `sync_tasks` 里那一行。分开的理由是界面上必须能同时说"上次同步成功"与
    /// "磁盘上还卡着一批" —— 只看 `phase` 时，一次生命周期中断之后的界面会把那批未完成
    /// 的数据显示成"上次健康同步 12:30"，读起来像一切正常。
    ///
    /// 写入点只有两处，都是**进度本身的写点**：`saveTask`（有进度了）与 `clearTask`
    /// （进度没了）。放在别处就会与 `sync_tasks` 的真实内容漂移。
    private(set) var hasPendingTask = false

    /// P0-6（2026-10-18 同步诊断）：盘上是否还有**没读完的页**（待续槽非空），或刚导出的
    /// 本批仍被预算停住（`lastExportSummary.hasMorePages`）。
    ///
    /// 与 `hasPendingTask` 的分工：后者是"磁盘上卡着一批未走完的工作"（任务行/意图），
    /// 本属性回答的是"**这一轮之后还有续页要读**" —— 界面据此在 `.pending` 档说
    /// 「同步尚未完成（还有未读完的页）」，而不是说「同步完成」（诊断 D10 的核心症状：
    /// 任务行提交后即删，75 批待读时界面显示"完成"）。
    ///
    /// ⚠️ 读盘失败不能被当成"没有待续"：`loadContinuation` 读失败返回 nil，而这时正确
    /// 的表态是"还有未完成的工作"（与 `probePendingWork` 的 `.unknown` 同向）。因此
    /// 读盘失败时回落到 `lastExportSummary?.hasMorePages ?? false` 之外，还要看
    /// `hasPendingTask` —— 宁可多显示一句"未完成"，也不要在还有活的时候说"完成"。
    var hasPendingContinuation: Bool {
        if lastExportSummary?.hasMorePages == true { return true }
        if taskStore.loadContinuation(scope: activeScope) != nil { return true }
        // R3b：删除余量非空也是"还有未发完的工作"（`commitSuccess` 在写删除槽时会同时写待续
        // 哨兵，所以这条在正常路径上是冗余的；保留它是为了覆盖手改/老库只有槽没有哨兵的形态）。
        if taskStore.loadPendingDeletions(scope: activeScope) != nil { return true }
        return taskStore.lastError != nil && hasPendingTask
    }

    /// P0-6 / P2-3：本批导出的轻量摘要（**只读**，每批导出完成/成功收尾时更新）。
    ///
    /// UI 的消费点：同步面板尾注、同步详情页「本批」一行、P0-5 的"新增 N / 其余 M 已有"。
    /// `nil` = 本进程还没导出过批次（重启后不保留：它是展示快照，不是持久事实）。
    private(set) var lastExportSummary: ExportSummary?

    /// 本次同步里，当前这批是否已被服务端**确定性拒绝**（`SyncUploadRecovery.abandonBatch`）。
    ///
    /// 它只影响失败之后的收尾：坏批次**不得**被登记成"待重试的失败批次"，
    /// 否则每次同步都会拿同一份字节再撞一次，而服务端的拒绝是确定性的 —— 同步永远好不了。
    private var abandonedBatch = false

    /// 本次同步是否被 §10.2 的游标闸门拦下（`.hold`）：**既没失败、也没有结**。
    ///
    /// 为什么必须单独一个字段：`performSync` 结尾那段"收尾兜底"用
    /// `lastError == nil && phase != failed/cancelled` 判断这一轮结没结，而闸门拦下的一轮
    /// 在那两个通道里**表达不出来** —— 它不是失败（服务端可能已经提交了这批事实），
    /// 但也绝不能算结（候选游标还留着等下一轮确认）。少了这个字段，兜底会清掉任务行、
    /// 删掉本地产物，并把界面改口成"同步成功"。
    ///
    /// 每次 `performSync` 开头重置：它只描述**本轮**，与 `cancelCause` / `abandonedBatch` 同理。
    private var cursorHoldThisRound = false

    var hasCompletedSync: Bool { lastSyncAt != nil }

    var lastSyncAtISO: String? {
        guard let lastSyncAt else { return nil }
        return Self.isoFormatter.string(from: lastSyncAt)
    }

    private static let lastExportEndKey = "rai.hk.lastExportEnd"
    private static let lastSyncAtKey = "rai.hk.lastSyncAt"
    private static let lastWorkoutCountKey = "rai.hk.lastWorkoutCount"
    private static let lastWorkoutAnchorKey = "rai.hk.workoutAnchor"
    private static let lastAutoSyncKey = "rai.hk.lastAutoSync"
    /// 「健康数据变了，等后台有机会就跑一次」的意图位（P2）。
    ///
    /// 与 `lastAutoSyncKey` 是两件事：那个记的是"上一次**成功**同步的时刻"，用来节流
    /// **新的**投递；这个记的是"有一条已经到达但我还没处理的变更"。混用一个键的后果是
    /// 后者会被前者的写入时机（`markSuccess`）意外清掉。
    private static let backgroundIntentKey = "rai.hk.backgroundIntent"
    /// 「在线握手确认权威 scope 变了，新 scope 还没有批次」的恢复请求位。
    ///
    /// 与 `backgroundIntentKey` 分开存是刻意的：合成一个槽之后，一批**旧 scope** 的导出
    /// 成功就会顺手确认掉它，于是新 scope 再也没人重开（现象是后台静默 `nothingToDo`）。
    /// 它同时解决一个崩溃窗口：确认 scope 变了之后，若"登记依据"晚于"发布新身份缓存"，
    /// 进程死在中间就会留下"新身份已发布、盘上却什么都没记"——下一轮纯后台冷启动按新 scope
    /// 读不到任何东西，于是**静默地什么都不做**。
    private static let backgroundRecoveryKey = "rai.hk.backgroundRecovery"
    private static let taskKey = "rai.hk.syncTask"
    /// 预算收敛档位的键（P1b/P2b）。**刻意不放在 `taskKey` 里**：这条记忆唯一发挥
    /// 作用的时刻，正是我们清掉 task 行的那一刻 —— 放进 task 就等于把它一起删了。
    private static let budgetConvergenceKey = "rai.hk.budgetConvergence"
    /// B2（2026-10-16）：记录类型轮转起点的 UserDefaults 键。
    ///
    /// 🔴 为什么不放任务行/内存：历史重放跨越多批**且跨进程**，而"上一批读到哪个类型"
    /// 是跨批记忆；任务行在成功提交时被删除（`commitSuccess`），内存值一重启就没 ——
    /// 与 `budgetConvergenceKey` 同一条"活过 `clearTask()`"的理由。
    private static let recordTypeRotationKey = "rai.hk.recordTypeRotation"
    /// 显式修复使用的**一次性读下界**（不是水位：它只缩小一次导出的查询窗口）。
    ///
    /// 场景：锚损坏、而 `export_end` 从未写过（老行/从未成功提交）。没有它，
    /// 修复后 `lowerBound` 会是 `nil` ⇒ 从零重读全部历史 —— 正是边界要禁止的那件事。
    /// 有水位时**不用**它（真实缺口由水位界定，截断等于丢数据）。
    private static let repairFloorKey = "rai.hk.repairFloor"
    /// 修复下界的窗口：够覆盖"锚坏了但水位丢了"的常见情形，又不会退化成全史。
    private static let repairFloorWindow: TimeInterval = 90 * 24 * 60 * 60
    /// Inclusive overlap so workouts finalized just after the previous export are not missed.
    private static let overlap: TimeInterval = 48 * 60 * 60
    private static let autoSyncInterval: TimeInterval = 15 * 60
    /// 老 payload 时代唯一用过的 ZIP 文件名。新代码按 `upload-<payloadHash>` 命名，
    /// 这个名字只为**读老 payload** 留着。
    private static let legacyZipName = "upload.zip"

    private var backgroundIntentStore: HealthSyncBackgroundIntentStore {
        HealthSyncBackgroundIntentStore(baseKey: Self.backgroundIntentKey)
    }

    private var backgroundRecoveryStore: HealthSyncScopeRecoveryStore {
        HealthSyncScopeRecoveryStore(baseKey: Self.backgroundRecoveryKey)
    }

    /// 批次产物一律**按 `payloadHash` 确定性命名**。
    ///
    /// 这不是命名洁癖：名字里带着哈希，就让"这个文件属于哪一批"由文件名本身回答
    /// （`.zip` 与 `.multipart` 都是），于是恢复时不必对动辄几个 GB 的包重算哈希 ——
    /// 旧实现 `pendingTaskZip` 会对每个候选路径跑一次整文件哈希，代价是几十秒到几分钟。
    static func zipName(for payloadHash: String) -> String { HealthSyncArchive.zipName(for: payloadHash) }

    static func multipartName(for payloadHash: String) -> String { "upload-\(payloadHash).multipart" }

    /// boundary 同样由 `payloadHash` 派生 ⇒ **重建 multipart 会得到字节完全一致的产物**，
    /// 于是"重传"与"重建后再传"在服务端看来是同一批，幂等键也就能生效。
    static func multipartBoundary(for payloadHash: String) -> String { "rai-\(payloadHash.prefix(32))" }

    /// 🔴 设备此刻**能不能**读 HealthKit。
    ///
    /// 锁屏（或开机后尚未首次解锁）时 HealthKit 数据库被硬件级加密锁死，**任何**读取都会被拒。
    /// 抽成一个属性、而不是在两个调用点各写一遍 `UIApplication.shared.isProtectedDataAvailable`：
    /// 这条判据有两处要用（`performSync` 的预检查、`runBackgroundPass` 的后台早退），
    /// 写两遍就有两份语义 —— 而"什么算读不到"恰恰是文档 §3.4 要求**只有一份**的定义。
    ///
    /// 非 iOS 平台没有这个 API，按"可读"处理（那边的导出路径本来也走不通，见 `#else` 分支）。
    private static var isProtectedDataAvailable: Bool {
        #if os(iOS)
        return UIApplication.shared.isProtectedDataAvailable
        #else
        return true
        #endif
    }

    #if os(iOS)
    private var observerStore: HKHealthStore?
    private var observers: [HKObserverQuery] = []
    private var onObserverChange: (@MainActor () async -> Void)?
    #endif

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 600
        configuration.waitsForConnectivity = true
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return RaiURLSession.make(configuration: configuration)
    }()

    /// 后台额度看门狗的安全余量（秒）：剩余后台时间低于该值就主动收尾，
    /// 抢在系统 expiration handler（约 30s 临近到期才回调）与 OOM 收杀之前。
    /// 见 `performSync` 里的 `budgetWatchdog`。
    private static let backgroundTimeSafetyMargin: TimeInterval = 5

    // MARK: 由系统搬运字节的那条路（P2-4）

    /// 把一批字节交给**系统**搬运。
    ///
    /// 为什么不能直接用上面那个 `session`：`.ephemeral` 的传输活不过进程挂起，而一次全量导出
    /// 可以是几个 GB、`beginBackgroundTask` 只给约 30 秒 —— 切一次后台就得从头再来。
    /// 带 identifier 的 background session 由系统持有，进程被杀也照常传完
    /// （职责与三条语义差异见 `RaiBackgroundUploadSession` 的文件头）。
    ///
    /// 非 iOS 平台保留当前会话：`background(withIdentifier:)` 那条路只有 iOS 有。
    private func uploadToSystem(
        _ request: URLRequest,
        from file: URL,
        payloadHash: String
    ) async throws -> (Data, URLResponse) {
        #if os(iOS)
        return try await RaiBackgroundUploadSession.shared.upload(
            request: request, fromFile: file, payloadHash: payloadHash
        )
        #else
        _ = payloadHash
        return try await session.upload(for: request, fromFile: file)
        #endif
    }

    /// 盘点系统手上还挂着哪些传输，并把没人在等结局的那些取消掉。
    ///
    /// 调用点恰好三处，都在"我方准备发起（或重新打算发起）一次上传之前"：
    /// `performSync` 推导下一步之前、`runBackgroundPass` 决定这一轮推进哪一步之前，
    /// 以及后台任务被系统唤起时的 `handleEnterBackground`（走的是 `systemUploadInFlight` 那条快速路）。
    ///
    /// 为什么必须跑：没人在等的那些传输，其结局我方**永远拿不回来**（服务端没有按批次查来源的
    /// 接口，证据见 `BackgroundUploadReattach`），而它占着的那个 batchId 正是这一轮要用的。
    /// 取消它，让这一轮用盘上那份 multipart 重传：`boundary` 由 `payloadHash` 派生 ⇒ 逐字节相同
    /// ⇒ 服务端按归档字节比对走幂等分支，返回**同一条**来源（`import-sources.ts:323-331`）。
    /// 不取消则是两份同样的字节同时打向服务端，其中一份必然撞 `import_upload_busy`（429）
    /// —— 等于用服务端当限流器。
    ///
    /// 判据（`BackgroundUploadReattach`）是纯函数、有执行者；这里只做"跑一次 + 留一行日志 +
    /// 把盘上那句已经不成立的自述改回来"。日志不是装饰：真机验收（计划 §11.3）靠它把
    /// "系统压根没把任务重挂起来"（`foundAny == false`）与"重挂了但属于别的批次"
    /// （`cancelledCurrentBatch == 0` 而 `cancelledOthers > 0`）分开 —— 只看"有没有取消"，
    /// 这两件事长得一模一样，而它们指向完全不同的修复方向。
    private func reconcileSystemUploads(_ task: SyncTaskState?) async {
        #if os(iOS)
        let report = await RaiBackgroundUploadSession.shared.reattachOrphans(
            currentPayloadHash: task?.payloadHash
        )
        if report.foundAny {
            Self.report(
                "reattached system uploads: kept \(report.keptAwaited) awaited, "
                    + "cancelled \(report.cancelledCurrentBatch) for the current batch, "
                    + "\(report.cancelledOthers) from other batches"
            )
        }
        // 盘上说"字节归系统"、而系统手上已经没有任何属于这一批的传输（刚被取消，或本来就没有）
        // ⇒ 那次传输已经结束而我方没有它的结局。把这个字段拉回与事实一致。
        if let task, !systemUploadInFlight(payloadHash: task.payloadHash) {
            clearStaleUploadState(task)
        }
        #else
        _ = task
        #endif
    }

    /// 把停在 `inFlight` 的自述改回 `pending`（"下次会重传"）。
    ///
    /// 🔴 **这不是判据。** 判据是 `BackgroundUploadReattach`，已经在调用点执行完毕；这里只是不让
    /// 盘上留一句已经站不住的谎话 —— `uploadState` 会被真机排查读到，而"停在 `inFlight`"
    /// 正是那个会让下一个人（或下一版代码）以为"字节归系统、不许碰"的形状，也就是活锁的来源。
    ///
    /// 写失败**不中止同步**（它不承载任何判据），但必须留痕：静默吞掉写失败正是
    /// `SyncTaskStore` 那套设计要消灭的形态。
    private func clearStaleUploadState(_ task: SyncTaskState) {
        guard task.uploadState == .inFlight else { return }
        var updated = task
        updated.uploadState = .pending
        updated.uploadTaskId = nil
        updated.uploadCompletedAt = nil
        do {
            try saveTask(updated)
        } catch {
            Self.report("failed to reset a stale uploadState: \(friendlyMessage(error))")
        }
    }

    /// 本进程内、**同步**可读的"系统正在为这一批搬字节"。
    ///
    /// 给 `handleEnterBackground` 用：切后台的处理必须在几十毫秒内返回，不能去等 `getAllTasks`。
    /// 与 `reconcileSystemUploads` 的分工是"快速判空 vs 权威盘点"，两者共用同一份内部登记，
    /// 所以不会出现"一个说有、一个说没有"。
    private func systemUploadInFlight(payloadHash: String?) -> Bool {
        #if os(iOS)
        guard let payloadHash else { return false }
        return RaiBackgroundUploadSession.shared.hasInFlightUpload(forPayloadHash: payloadHash)
        #else
        _ = payloadHash
        return false
        #endif
    }

    init() {
        lastSyncAt = nil
        lastWorkoutCount = nil
    }

    func syncIfNeeded(to serverURL: URL?, apiToken: String = "", force: Bool = false) async {
        guard let serverURL else { return }
        // 恢复上下文与读盘都放进单飞所有权里：若另一 server URL 的前台/后台同步已经在跑，
        // `run` 会在碰任何 active* 字段之前拒绝本轮，避免跨服务端覆盖活动上下文。
        _ = await syncOwner.run { [weak self] in
            guard let self else { return }
            guard self.prepareJournalForExecution() else { return }
            self.restoreBackgroundContext(for: serverURL)
            let urlScope = Self.urlScope(for: serverURL)
            // 🔴 卡在阻塞态时，节流不该挡住恢复（文档 §3.3 / §3.4）。
            // 判据必须读**盘上**那份自述：进程重启后内存 phase 回到 idle，阻塞态只在任务行里。
            let persistedTask = self.loadTask()
            let persistedPhase = persistedTask?.resolvedPhase
            let isBlocked = persistedPhase?.isBlocked ?? SyncPhase.migrate(self.phase).isBlocked
            // 🔴 只差"拿 `jobId` 问服务端一次"的任务同样不该被节流挡下。
            //
            // 15 分钟节流存在的唯一理由是"别白读 HealthKit"（整个流程里最贵的一步），
            // 而 `.waitJob` 整个动作就是一次 `GET /v1/import-jobs/<id>` —— 与一次握手同量级。
            // 挡下它的可见后果正是"服务端早已算完、界面一直停在未走完"：2026-10-11 线上实测，
            // App 被挂起期间服务端 08:06:01 已经把导入跑完，而回到前台这一轮会被 15 分钟
            // 窗口挡在门外，于是没有任何人去把那个结局接回来。
            //
            // 判据与 `performSync` 里选分支用的是**同一个** `SyncAtomicUnit.nextStep`
            // （`isServerReconciliationOnly`），不另写一份"什么算便宜"。
            let isLedgerResume = persistedTask.map {
                SyncAtomicUnit.nextStep(
                    sourceId: $0.sourceId,
                    jobId: $0.jobId,
                    // `jobId` 一在就短路，这两个入参不影响结论；传 `false` 只是因为这里
                    // 读本地产物要碰 `activeServerURL` 与本进程的文件系统，而这一步不需要。
                    hasZip: false,
                    hasMultipart: false
                ).isServerReconciliationOnly
            } ?? false
            if !force, !isBlocked, !isLedgerResume {
                let key = self.scopedKey(Self.lastAutoSyncKey, scope: urlScope)
                let last = UserDefaults.standard.object(forKey: key) as? Date
                if let last, Date().timeIntervalSince(last) < Self.autoSyncInterval { return }
            }
            await self.performSync(to: serverURL, apiToken: apiToken)
        }
    }

    /// 用户主动取消（同步按钮 / App Intent）。**这是唯一会产出 `phase == "cancelled"` 的路径。**
    ///
    /// 🔴 **这里不再丢弃意图位。** 旧版本丢的是"本轮预先登记"的那一代，而那一代当时由
    /// `performBackgroundPass` **凭空合成**（有旧任务就当作有新数据）。合成被删掉之后
    /// （见 `performBackgroundPass`），这里剩下的就只有**真实投递**的通知 —— 而人工取消
    /// 中止的是"这一趟"，不是"这条通知所代表的变更"。把它删掉，那批健康数据就只能等下一次
    /// 投递或用户手动点同步；保留它只是让下一轮后台重试一次（代价远小于"静默丢一次变更"）。
    func cancelSync() {
        guard syncOwner.cancel() || isBusy else { return }
        cancelCause = .manual
        finishCancelled()
    }

    /// 生命周期中止：系统收回执行时间（`beginBackgroundTask` 到期）或 App 切到后台。
    ///
    /// 与 `cancelSync()` 的唯一区别在**记录方式**：这里不写 `"cancelled"`，而是把 `phase`
    /// 落回它本来的可续接阶段，下次唤醒按持久化字段接着跑。取消动作本身是一样的。
    func suspendForLifecycle() {
        guard syncOwner.cancel() || isBusy else { return }
        cancelCause = .lifecycle
        finishCancelled()
    }

    /// 进入后台时对"在飞的工作"的处置。判据是纯函数 `HealthSyncLifecycle.enterBackground`。
    ///
    /// 刻意不在这里做任何网络或 HealthKit 工作：切后台的处理必须在几十毫秒内返回。
    func handleEnterBackground() {
        // 🔴 刷新"磁盘上还有没有没走完的批次"必须放在 `isBusy` 守卫**之前**：
        // 需要它更新的正是"在飞的工作刚被中断"这个时刻，而那一刻 `isBusy` 可能已经归 false。
        //
        // 两个来源，刻意分开取：
        //   - **探针**按本次会话的服务端现读（不认 `activeScope`、不补写迁移数据）。
        //     这里用 `loadTask()` 是错的：切后台这一刻 `activeScope` 可能还指向用户**刚刚切走**
        //     的那个服务端，于是界面会拿 A 的结论去说 B 有没有待办。
        //     `.unknown`（读盘失败 / 归属不明）算"有" —— 那正是"界面显示一切正常、磁盘上却
        //     卡着一批"的由来。
        //   - **在飞的那一趟**用它自己的上下文（`active*` 就是那次同步写下的），不能被用户刚
        //     切换到的服务端覆盖；否则下面的 `hasUploadTask` 会去问另一批的 `payloadHash`。
        let pending = activeServerURL.flatMap { probePendingWork(for: $0) }
        let inFlightTask: SyncTaskState? = isBusy ? loadTask() : nil
        hasPendingTask = inFlightTask != nil || (pending?.hasUnfinishedWork ?? false)
        guard isBusy else { return }
        switch HealthSyncLifecycle.enterBackground(
            phase: phase,
            isBusy: isBusy,
            hasJobId: inFlightTask?.jobId != nil,
            // 字节归系统时（background URLSession 还在搬这一批）⇒ 一根手指都不许碰，
            // 连 `stopResumable` 都不能落 —— 中止的是"等结果"，不是"搬字节"
            // （两条路的区别见 `RaiBackgroundUploadSession.abandonWaiting`）。
            hasUploadTask: systemUploadInFlight(payloadHash: inFlightTask?.payloadHash)
        ) {
        case .doNothing:
            break
        case .keepWorking:
            // `performSync` 自己持有 `beginBackgroundTask` 的续期额度，让它把在飞的那一步跑完。
            // 额度到期由 expiration handler 走 `suspendForLifecycle()`，不是这里。
            break
        case .stopResumable:
            // 等服务端出结果（`jobId` 已落盘）时后台轮询零收益（服务端没有推送机制），
            // 立刻收手并保留 `jobId` 交给下次唤醒续接 —— 这不是取消。
            suspendForLifecycle()
        }
    }

    /// 注册 HealthKit 观察者。**每次启动都必须调用一次**（Apple 的要求）。
    ///
    /// 调用点只有一处：`RaiStartup.registerSyncEntryPoints`（`AppDelegate.swift`），
    /// 由 `didFinishLaunching` 驱动。原先这里是 `guard observers.isEmpty` + 视图层
    /// `onAppear` 调用 —— 那个组合的问题不在守卫，而在**入口的位置**：视图没出现就完全
    /// 没有观察者。守卫因此被删掉（它只会掩盖"有人又挂回视图层"这件事），改成由结构门禁
    /// 钉住"调用点恰好一处"。
    ///
    /// 名字里刻意不带 `foreground`：P2 之后观察者要在后台唤醒路径上同样生效。
    func startObservingHealthChanges(onChange: @escaping @MainActor () async -> Void) {
        #if os(iOS)
        onObserverChange = onChange
        guard HKHealthStore.isHealthDataAvailable() else { return }
        let store = HKHealthStore()
        observerStore = store
        let types: [(HKSampleType, NSPredicate?)] = [
            (.workoutType(), HKQuery.predicateForWorkouts(with: .running)),
            // Route 可独立于 workout 晚到；通知走既有节流/后台意图链路，
            // 历史路线由有界低频队列重新发现，不在回调中重扫全部历史。
            (HKSeriesType.workoutRoute(), nil)
        ] + HealthKitExport.recordSampleTypes.map { ($0, nil) }
        observers = types.map { sampleType, predicate in
            HKObserverQuery(sampleType: sampleType, predicate: predicate) { [weak self] _, completion, _ in
                // 🔴 `completion()` 必须在**任何 `await`／`Task`／状态守卫之前**调用。
                // HealthKit 连续 3 次没收到它会**永久停掉**这个类型的投递 ——
                // 现象是"第一次能唤醒，之后再也不唤醒"，而且毫无报错。
                completion()
                Task { @MainActor in
                    // 这里**刻意不判** `applicationState`（P2 之前判过）。
                    // 判在哪跑不是观察者的事：派发方（`RaiStartup` 注册的回调，判据在
                    // `SyncDeliveryPolicy`）才知道前台该当场跑、后台该记下意图交给
                    // `BGProcessingTask`。观察者提前 return 等于把后台唤醒整个吞掉。
                    await self?.onObserverChange?()
                }
            }
        }
        // 后台投递必须**逐个类型**开。`enableBackgroundDelivery` 的完成回调是
        // 唯一的失败信号：被拒（缺 entitlement、用户关了"后台 App 刷新"、被 MDM 限制）
        // 时 `success == false`，**绝不能用 `try?` / `_ =` 吞掉** ——
        // 那样现象是"后台永远不唤醒"，而代码里看不出任何问题。
        //
        // 频率取 `.hourly`：`.immediate` 会被系统按进程/类型重度节流，而且与本仓自己的
        // `SyncDeliveryPolicy.throttle`（15 min）冲突 —— 投递来了也会被自己的节流挡掉，
        // 白白消耗一次唤醒额度。跑步数据在天级尺度上补齐就够。
        for (sampleType, _) in types {
            let identifier = sampleType.identifier
            store.enableBackgroundDelivery(for: sampleType, frequency: .hourly) { success, error in
                guard !success else { return }
                Self.report("enableBackgroundDelivery failed for \(identifier): "
                    + (error.map { String(describing: $0) } ?? "no error given"))
            }
        }
        observers.forEach { store.execute($0) }
        #endif
    }

    /// 没有用户界面的失败要留下痕迹。
    ///
    /// `NSLog` 而不是 `print`：这是发布路径上的诊断，不是控制台噪音 ——
    /// 与 `SyncTaskStore.report` 同一个理由。真机验收（计划 §11 V1）就是靠
    /// `[RAI]` 前缀在 Xcode 控制台里过滤出这些行的。
    ///
    /// `nonisolated`：调用点之一是 `enableBackgroundDelivery` 的 `@Sendable` 完成回调，
    /// 它在非隔离上下文里跑；默认隔离（`-default-isolation MainActor`）会把没有标注的
    /// 静态方法算成 MainActor 隔离的，于是这里会报 actor 越界 —— 而它只调 `NSLog`，不碰任何状态。
    nonisolated private static func report(_ message: String) {
        #if os(iOS)
        NSLog("[RAI] %@", message)
        #else
        print("[RAI] \(message)")
        #endif
    }

    /// 跑一次同步。**返回值 = "这一次真的被跑起来了吗"**，由 `HealthSyncTaskOwner` 的单飞闸门决定。
    ///
    /// 🔴 后台路径必须用上这个返回值（`BackgroundRunPolicy.reportedSuccess`）：与前台同步
    /// 撞车时这一轮被**静默拒绝**，而 BGTask 那侧只看得到"handler 返回了"。报成功等于告诉系统
    /// "这个 App 的后台预算够用"，于是以后每次派活都撞在同一个闸门上 —— 而 nginx 那一侧
    /// 全程没有任何 uploads。
    ///
    /// `@discardableResult` 是为了让既有的前台调用点（`TechSyncStatus` / `TechViews` /
    /// `RootView` / `SyncHealthIntent`）一个字都不用改。
    @discardableResult
    func sync(
        to serverURL: URL?, apiToken: String = "",
        /// §4.2 步骤 6：对指定 workout UUID 的小范围重试（保留全部 anchor）。
        /// 空数组 = 普通同步。**这是唯一的重试通道** —— 全量重导入口已于 2026-10-17 删除。
        routeRetryWorkoutIDs: [String] = []
    ) async -> Bool {
        await syncOwner.run { [weak self] in
            guard let self else { return }
            guard self.prepareJournalForExecution() else { return }
            await self.performSync(
                to: serverURL, apiToken: apiToken,
                routeRetryWorkoutIDs: routeRetryWorkoutIDs
            )
        }
    }

    /// 旧服务端页面仍可能发 `syncHealth full:true`：明确拒绝并说明替代入口。
    ///
    /// 静默忽略是最坏的一种"成功" —— 用户看到按钮消失/无反应，会以为重导已经跑过。
    func rejectFullImportRequest() {
        lastError = "「重新导入全部」已停用：它会清空已提交的增量游标。请改用设置页的「修复增量游标」。"
        message = nil
    }

    /// 显式修复**损坏的增量游标**（只清坏掉的那一个）。
    ///
    /// 与已删除的「重新导入全部」的区别只有一条，但它是本质的：**范围**。
    /// 这里不删 `sync_state` 整行、不清其它类型、不写水位；`export_end` 原样保留，
    /// 所以下一次导出仍从真实缺口开始，而不是从零重读全部历史。
    func repairSyncCursor() async {
        await syncOwner.run { [weak self] in
            guard let self else { return }
            guard !self.isBusy else { return }
            var repaired: [String] = []

            let state = self.taskStore.loadState(scope: self.activeScope)
            if self.taskStore.lastError != nil {
                self.lastError = HealthKitExportError.stateStoreUnreadable.errorDescription
                self.message = nil
                return
            }
            if let anchor = state?.workoutAnchor, !HealthKitExport.anchorIsReadable(anchor) {
                guard self.taskStore.clearWorkoutAnchor(scope: self.activeScope) else {
                    self.lastError = self.taskStore.lastError ?? "修复跑步游标失败"
                    self.message = nil
                    return
                }
                // 老键一起删：`sync_state` 有行时不会回退读它，但迁移期还没写过行的设备会。
                UserDefaults.standard.removeObject(forKey: self.scopedKey(Self.lastWorkoutAnchorKey))
                repaired.append("跑步")
            }

            if let payload = self.taskStore.loadRecordCursors(scope: self.activeScope) {
                if let cursors = try? JSONDecoder().decode([String: HealthKitRecordCursor].self, from: payload) {
                    let broken = cursors
                        .filter { !HealthKitExport.anchorIsReadable($0.value.anchor) }
                        .map(\.key).sorted()
                    if !broken.isEmpty {
                        guard self.taskStore.clearRecordCursors(broken, scope: self.activeScope) else {
                            self.lastError = self.taskStore.lastError ?? "修复记录游标失败"
                            self.message = nil
                            return
                        }
                        repaired.append("记录（\(broken.count) 类）")
                    }
                } else {
                    // 整包 JSON 解不开 ⇒ 所有类型都没有可用锚点。清这一行仍然是"只清游标"：
                    // 不碰任务行、不碰 `export_end`。
                    let allTypes = ((try? JSONSerialization.jsonObject(with: payload)) as? [String: Any])
                        .map { Array($0.keys) } ?? []
                    guard self.taskStore.clearRecordCursors(allTypes, scope: self.activeScope) else {
                        self.lastError = self.taskStore.lastError ?? "修复记录游标失败"
                        self.message = nil
                        return
                    }
                    repaired.append("记录（全部类型，游标包已损坏）")
                }
            } else if self.taskStore.lastError != nil {
                self.lastError = HealthKitExportError.stateStoreUnreadable.errorDescription
                self.message = nil
                return
            }

            // 预算收敛档位原本也由「重新导入全部」复位；现在归修复入口 ——
            // 否则一次历史超界会把档位永久折半（`clearBudgetConvergence` 没有第二个调用点）。
            self.clearBudgetConvergence()
            // 锚坏了、水位也没了：给**下一次导出**一个有界下界（一次性，不进水位）。
            // 有水位时不用它 —— 真实缺口由水位界定。
            if state?.exportEnd == nil {
                UserDefaults.standard.set(
                    Date().addingTimeInterval(-Self.repairFloorWindow),
                    forKey: self.scopedKey(Self.repairFloorKey)
                )
            }
            self.lastError = nil
            self.phase = SyncPhase.idle.rawValue
            self.message = repaired.isEmpty
                ? "没有发现损坏的增量游标，未做任何修改。"
                : "已修复增量游标：\(repaired.joined(separator: "、"))。已同步数据与其它类型不受影响。"
        }
    }

    /// 记下"健康数据变了，等后台有机会就跑一次"。
    ///
    /// 为什么不能只靠 `submit`：`applicationDidEnterBackground` 每次切后台都会 submit 一次
    /// （请求是一次性的），而"切后台"不等于"数据变了"。没有这个意图位，一个**过期的**待发请求
    /// 在数据没变时落到 BGTask 上会变成一次白读 HealthKit 的全量导出 —— 那是最贵的一步。
    func recordBackgroundIntent(for serverURL: URL? = nil) {
        guard let url = serverURL ?? activeServerURL else { return }
        backgroundIntentStore.record(scope: Self.urlScope(for: url))
    }

    private func backgroundIntentObservation(for serverURL: URL) -> HealthSyncBackgroundRecovery.IntentObservation? {
        backgroundIntentStore.observe(scope: Self.urlScope(for: serverURL))
    }

    private func backgroundRecoveryObservation(for serverURL: URL) -> HealthSyncScopeRecoveryStore.Observation? {
        backgroundRecoveryStore.observe(urlScope: Self.urlScope(for: serverURL), targetScope: activeScope)
    }

    /// 🔴 记下**导出起点**观察到的两个代次。前台与后台共用这一处 ⇒ 确认逻辑也就只有一份。
    ///
    /// 为什么必须在这一刻而不是"本轮开始时"：`performSync` 有两条**不重新读 HealthKit** 的
    /// 恢复分支（`inspect` 续接、重传已落盘的 ZIP）。它们用的是**早于通知**生成的字节，
    /// 没有资格替那条通知背书。把它们的位置当作观察点，那批新数据就再也没人导。
    private func observeBackgroundIntentsForExportStart(for serverURL: URL) {
        backgroundIntentInFlight = backgroundIntentObservation(for: serverURL)
        backgroundRecoveryInFlight = backgroundRecoveryObservation(for: serverURL)
    }

    private func clearBackgroundIntentObservations() {
        backgroundIntentInFlight = nil
        backgroundRecoveryInFlight = nil
    }

    /// 只确认导出起点看到的那一代；期间新到的 HealthKit 通知会写入新 UUID，必须留下。
    /// 两个成因**分别**确认：合在一起确认会让一次旧 scope 的成功顺手删掉另一条依据。
    private func acknowledgeBackgroundIntent(
        checkpoint: HealthSyncBackgroundRecovery.DurableCheckpoint
    ) {
        _ = backgroundIntentStore.acknowledge(backgroundIntentInFlight, checkpoint: checkpoint)
        _ = backgroundRecoveryStore.acknowledge(
            backgroundRecoveryInFlight, targetScope: activeScope, checkpoint: checkpoint
        )
    }

    /// 🔴 **只读**待办探针：按**目标 URL** 现读一份盘上快照。
    ///
    /// 它只回答一个问题：「**这个服务端**在盘上还有没有没走完的活儿，或者一条待处理的通知」。
    /// 调度（要不要再排一轮）与完成回执（报成功还是失败）都必须由它决定，不能用 `HealthKitSync`
    /// 上的展示标志 —— 那些标志属于**最后一次**写它的那次同步，而"用户刚切换服务端"与
    /// "单飞闸门拒绝了这一轮"这两个时刻，标志描述的恰恰不是同一件事。
    ///
    /// 为什么不能直接拿 `loadTask()` 当探针（三条，每条都是可见缺陷）：
    ///   1. 它认的是 `activeScope`，而不是"这个 URL" —— 切服务端之后那属于另一次同步；
    ///   2. 它会把老的 `UserDefaults` 候选**补写**回 `sync_tasks`——探针不许有副作用；
    ///   3. 它把"读不出来"记成 `taskDecodeError`，而调用方据此把它当成"没有任务"。
    ///
    /// 不改 `active*`、不迁移旧任务、不重开数据库、不删任何文件、不碰系统上传。
    ///
    /// - Returns: 快照；`serverURL == nil` 时返回 `nil`（没有目标就没有"这个目标有没有活儿"）。
    func probePendingWork(for serverURL: URL?) -> HealthSyncBackgroundRecovery.PendingWork? {
        guard let serverURL else { return nil }
        #if os(iOS)
        let identity = CacheStore.loadHandshake(baseURL: serverURL)
        #else
        let identity: RaiHandshake? = nil
        #endif
        let urlScope = Self.urlScope(for: serverURL)
        let authoritativeScope = identity.map { Self.syncScope(for: serverURL, identity: $0) }
        // 两个候选 scope 都要看，顺序是"权威在前"：`syncScope` 上是本次身份的行；URL scope 上是
        // 「还没握过手 / 老版本」留下的行（`loadTask()` 的 UserDefaults 回退正是为它们写的）。
        var scopedTaskFound = false
        var readFailed = false
        for scope in [authoritativeScope, urlScope].compactMap({ $0 }) where !scopedTaskFound && !readFailed {
            switch taskStore.hasTask(scope: scope) {
            case .some(true): scopedTaskFound = true
            case .some(false): break
            case .none: readFailed = true
            }
        }
        // 库里"有没有归属不明的行"只在身份未知时才需要问：身份已知时本目标的结论已经确定，
        // 别的 scope 上那一行不属于它（与 `loadTask()` / `taskMatches` 的口径一致）。
        var storesAnyTask = false
        if !readFailed && !scopedTaskFound {
            switch taskStore.hasAnyTask() {
            case .some(true): storesAnyTask = true
            case .some(false): storesAnyTask = false
            case .none: readFailed = true
            }
        }
        return HealthSyncBackgroundRecovery.PendingWork(
            serverURL: serverURL.absoluteString,
            urlScope: urlScope,
            scope: authoritativeScope ?? urlScope,
            verdict: HealthSyncBackgroundRecovery.pendingWorkVerdict(
                identityKnown: identity != nil,
                scopedTaskFound: scopedTaskFound,
                storesAnyTask: storesAnyTask,
                readFailed: readFailed
            ),
            hasIntent: backgroundIntentStore.hasIntent(scope: urlScope),
            hasRecoveryRequest: backgroundRecoveryStore.hasRequest(urlScope: urlScope),
            // 待续页槽（S2.3）：读失败按"没有待续"处理 —— 后果只是前台少续几轮
            // （后台路径由"意图"与 `needsAnotherRound` 兜底），不是数据正确性问题。
            // scope 口径与 `loadRecordCursors` 一致（权威 scope 优先）。
            hasPendingContinuation: taskStore.loadContinuation(scope: authoritativeScope ?? urlScope) != nil
        )
    }

    /// 后台一轮（由 `BGProcessingTask` 驱动）。判据全部来自纯函数，这里只做接线。
    ///
    /// 顺序与理由：
    ///   1. 先读盘上的任务行 —— `hasPendingTask` 的真实来源（它同时决定报给系统的成败）。
    ///   2. `BackgroundRunPolicy.action` 决定这一轮推进哪一段。**一次后台运行只推进一个批次**。
    ///   3. 只有 `.startFreshSync` 才允许重新导出，而它要求**盘上没有任务行**（见该函数说明）。
    ///
    /// 🔴 **返回值是本轮收工时按本次目标现读的快照**（`probePendingWork`）。调用方的重排与
    /// 完成回执必须用它，不能用 `HealthKitSync` 上的展示标志：单飞闸门拒绝掉的那一轮
    /// 一个字段都没碰过，而那些标志属于另一次同步。
    @discardableResult
    func runBackgroundPass(
        to serverURL: URL?,
        apiToken: String
    ) async -> HealthSyncBackgroundRecovery.PendingWork? {
        guard let serverURL else { return nil }
        // 与 `syncIfNeeded` 一样，先取得单飞所有权，再恢复/覆盖 active*。若前台正在同步另一
        // server URL，本轮会在任何上下文字段变化之前被拒绝。
        let accepted = await syncOwner.run { [weak self] in
            guard let self else { return }
            guard self.prepareJournalForExecution() else { return }
            await self.performBackgroundPass(to: serverURL, apiToken: apiToken)
        }
        if !accepted {
            // 🔴 被拒绝**不等于**"没事可做"。前台的另一个目标正握着所有权 ⇒ 本轮没改过任何
            // 字段，而 `hasPendingTask` 描述的是那个目标。拿它报成败就是拿别人的结论给自己打分
            // —— 而单飞被拒正是"报了成功、系统照样派活、每次都撞同一个闸门"那条活锁的来源。
            Self.report("background pass: single-flight gate rejected this round; reading this target's own snapshot")
        }
        return probePendingWork(for: serverURL)
    }

    /// Called once at each accepted single-flight entry, before any task read.
    /// An unavailable journal is retried once; a failure leaves its rows and
    /// intent untouched, and the read-only probe reports `.unknown`.
    private func prepareJournalForExecution() -> Bool {
        guard taskStore.reopenIfUnavailable() else {
            hasPendingTask = true
            lastError = taskStore.lastError ?? "同步进度数据库暂不可用，请稍后重试。"
            message = nil
            phase = SyncPhase.failed.rawValue
            return false
        }
        return true
    }

    private func performBackgroundPass(to serverURL: URL, apiToken: String) async {
        // 后台软预算的起点。只有**后台路径**会走到这里（前台 `performSync` 由按钮/观察者驱动，
        // 不经过 `runBackgroundPass`）⇒ `waitForJob` 里的 `shouldYieldPolling` 天然只对后台生效。
        backgroundPassStartedAt = Date()
        defer { backgroundPassStartedAt = nil }
        restoreBackgroundContext(for: serverURL)
        let task = loadTask()
        if taskStore.lastError != nil {
            // 读取失败不是“没有任务”：保留待办/失败状态，避免向 BGTask 报一个空队列成功。
            hasPendingTask = true
            lastError = taskStore.lastError
            phase = SyncPhase.failed.rawValue
            return
        }
        hasPendingTask = task != nil
        // 🔴 卡在阻塞态（等解锁 / 等凭证）时，后台这一轮**什么都不做**（文档 §3.3 / §3.4）。
        //
        // 为什么需要这一道：`BackgroundRunPolicy.action` 只看"盘上还有没有没走完的批次"，
        // 于是锁屏时它会派一次注定读不到 HealthKit 的导出、等凭证时它会派一次注定 401 的上传。
        // 两次都会"正常失败"，然后因为批次还在而**再排下一轮** —— 每 15 分钟一次的活锁，
        // 代价是反复白读 HealthKit（整个流程里最贵的一步）。
        //
        // ⚠️ 早退**不**影响重排（`RaiStartup.runBackgroundTask` 里的 `shouldResubmit` 照旧）：
        // 唤醒这两个阶段的是外部条件，但"谁来发现条件已经满足"只能靠重排 —— 解锁通知在
        // App 已被系统杀掉时是收不到的。
        let persistedPhase = task?.resolvedPhase ?? SyncPhase.migrate(phase)
        if persistedPhase.isBlocked {
            Self.report("background pass: skipped, waiting on an external condition (\(persistedPhase.rawValue))")
            return
        }
        // 🔴 先问系统，再信盘上那一行。`task.uploadState == .inFlight` 只是"我方曾经把它交出去过"
        // 的记录 —— 它**不会**因为系统传完（或进程被杀）而改变，所以拿它当判据时，每一轮唤醒都会
        // 说"字节归系统"（`.awaitSystemUpload` ⇒ 什么都不做），而 `shouldResubmit` 又因为
        // "盘上有任务"一直为真 ⇒ 系统持续派活、持续空转。那是**活锁**，不是保守。
        // 盘点顺带会把盘上那句已经不成立的自述改回来（`clearStaleUploadState`）。
        // 离线握手只用于恢复/闸门：这里不改任务、不碰系统上传；真正盘点在 performSync 的
        // 在线握手之后执行。否则陈旧 dataset epoch 会让旧 scope 的行被当成权威任务来改写。
        //
        // 🔴 意图只在**盘上没有任务行**时驱动一轮全新的同步。
        //
        // 旧版本在这里"有任务却没有意图"时**凭空合成**一条新数据意图（`recordBackgroundIntent`）。
        // 它已被删掉，两个方向都错：
        //   - 旧任务本身就是重试依据（`SyncAtomicUnit` 从盘上那份字节接着走），不需要伪造一条
        //     "有新数据"的通知；
        //   - 合成出来的意图代表一条**不存在**的投递，而它的确认点只在**导出起点**
        //     （`observeBackgroundIntentsForExportStart`）⇒ 下一轮若走的是续传分支，它永远
        //     不会被确认，反而会在批次走完之后把一轮"续传"变成一次**多余的导出**
        //     （白读 HealthKit，整个流程里最贵的一步）。
        //
        // "scope 变了、新 scope 还没有批次"那一类依据**不在这里登记**：它由在线握手确认
        // （见 `performSync` 里的 `recordBackgroundRecoveryRequest`），因为只有握手才知道
        // 权威身份。已有的意图/恢复请求也不在这里消费 —— 确认点只有一个，就在导出起点。
        //
        // 两个成因一起决定 `wantsFreshSync`（都表示"这个目标需要跑一轮"），而**有没有任务行**
        // 决定跑的是哪一段：有任务行 ⇒ `runAtomicUnit` / `resumeJob`。
        let hasNotification = backgroundIntentObservation(for: serverURL) != nil
        let hasRecoveryRequest = backgroundRecoveryStore.hasRequest(urlScope: Self.urlScope(for: serverURL))
        let wantsFresh = task == nil && (hasNotification || hasRecoveryRequest)
        // 🔴 R1（2026-10-15）：没有任务行时，"待续页"也必须能驱动一轮。待续页产生于一次
        // **成功提交之后**（`commitSuccess` 删掉任务行、同时写 `sync_continuation` 槽），
        // 形态恰好是"无任务行 + 无通知/恢复请求 + 有续页"。旧实现只认通知/恢复请求 ⇒
        // `.nothingToDo` 收工，而 `needsAnotherRound` 又因待续标记持续为真 ⇒ BGTask 反复
        // 重排却不推进（活锁）。scope 与 `loadTask()` 同口径（`activeScope`）。
        let wantsContinuation = task == nil
            && taskStore.loadContinuation(scope: activeScope) != nil
        let action = BackgroundRunPolicy.action(
            hasTask: task != nil,
            jobId: task?.jobId,
            // 只认"本进程还在等它结局"的那些。用词要准：这个入参喂的是 `.awaitSystemUpload`
            // （"一根手指都不许碰"），而唯一该不碰的情形是**另一次同步正挂在那个 continuation 上**
            // （后台一轮撞见前台同步在传）。刚盘点出来的孤儿**不是**不碰的理由 —— 它们已经被取消，
            // 这一轮该做的是用盘上的字节重传，让服务端幂等命中同一份来源。
            hasBackgroundUploadTask: systemUploadInFlight(payloadHash: task?.payloadHash),
            wantsFreshSync: wantsFresh,
            wantsContinuation: wantsContinuation
        )
        // 后台一轮「被派发了但什么都没做」与「压根没被派发」在服务端看是同一件事（都没有请求）。
        // 这一行把它们分开，也是排查活锁（每轮唤醒都落在 `.awaitSystemUpload`）的唯一入口。
        Self.report("background pass: action=\(String(describing: action))")
        switch action {
        case .nothingToDo, .awaitSystemUpload:
            // `.nothingToDo`：没有待办 ⇒ 立刻收工，报成功。
            // `.awaitSystemUpload`：字节归系统 ⇒ 一根手指都不许碰，连 `inspect` 都不做。
            return
        case .runAtomicUnit, .resumeJob, .startFreshSync, .resumeContinuation:
            // 观察点不在这里：通知只在**导出起点**被认领（`performSync` 里那条
            // `observeBackgroundIntentsForExportStart`）。放在这里等于让两条"不重新读 HealthKit"
            // 的恢复分支替通知背书 —— 它们用的是早于通知生成的字节。
            await performSync(to: serverURL, apiToken: apiToken)
        }
        // 握手失败时 `performSync` 会把 activeScope 暂时退回 URL scope。恢复离线候选上下文，
        // 让旧任务仍能驱动重排；握手成功时 activeIdentity 非空，绝不覆盖权威 scope。
        if activeIdentity == nil { restoreBackgroundContext(for: serverURL) }
        // 收工前重读一次：`performSync` 可能已经把任务清掉（`clearTask`）或新建了一个。
        // 用调用前的快照去报成败会在"这一轮正好做完了"时把成功报成失败。
        let remainingTask = loadTask()
        if taskStore.lastError != nil {
            hasPendingTask = true
            lastError = taskStore.lastError
            phase = SyncPhase.failed.rawValue
        } else {
            hasPendingTask = remainingTask != nil
        }
    }

    private func performSync(
        to serverURL: URL?, apiToken: String,
        routeRetryWorkoutIDs: [String] = []
    ) async {
        guard !isBusy else { return }
        guard let serverURL else {
            lastError = "请先连接 RAI 服务"
            message = nil
            return
        }
        // 上一次中止的来源只属于上一次。不重置的话，用户取消过一次之后，
        // 下一次同步会在握手后第一个 checkCancellation() 处立刻自杀。
        cancelCause = .none
        abandonedBatch = false
        taskDecodeError = nil
        // 闸门拦下的一轮只属于那一轮；不重置的话，下一次同步会被上一轮的 `.hold` 一直
        // 挡在"收尾兜底"之外（任务行永远不清，界面永远停在未结态）。
        cursorHoldThisRound = false
        #if os(iOS)
        isBusy = true
        let previousServerURL = activeServerURL
        activeServerURL = serverURL
        activeScope = Self.urlScope(for: serverURL)
        activeIdentity = nil
        if previousServerURL?.absoluteString != serverURL.absoluteString {
            lastSyncAt = nil
            lastWorkoutCount = nil
        }
        phase = SyncPhase.collecting.rawValue
        activeToken = apiToken
        lastError = nil
        message = "正在请求 Apple 健康权限"
        let previousIdleTimerState = UIApplication.shared.isIdleTimerDisabled
        UIApplication.shared.isIdleTimerDisabled = true
        var backgroundTask = UIBackgroundTaskIdentifier.invalid
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "rai-health-sync") {
            // 系统收回时间 ≠ 用户取消。这里必须走 lifecycle：写 "cancelled" 会让下一次同步的
            // `checkCancellation()` 把系统的决定当成用户意图，从此永久卡死。
            self.suspendForLifecycle()
            if backgroundTask != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTask)
                backgroundTask = .invalid
            }
        }
        // 🔴 主动看门狗（2026-09-24，OOM 崩溃溯源）：系统的 expiration handler 在"临近到期"
        // 才被调用，内存吃紧时可能已经来不及，等于把 30 秒红线交给系统回调的准时性。
        // 这里每秒盯一次剩余后台额度，一旦进入安全余量就走同一条 lifecycle 收尾 ——
        // endBackgroundTask 从"指望系统准时"变成"自己盯表"。前台时额度不消耗
        // （backgroundTimeRemaining 为 .greatestFiniteMagnitude），对 GB 级前台导出零影响。
        let budgetWatchdog = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            // Timer is scheduled from this @MainActor method on the main run loop,
            // but its @Sendable callback does not inherit actor isolation.
            MainActor.assumeIsolated {
                guard UIApplication.shared.applicationState != .active,
                      backgroundTask != .invalid,
                      UIApplication.shared.backgroundTimeRemaining < Self.backgroundTimeSafetyMargin
                else { return }
                self.suspendForLifecycle()
                if backgroundTask != .invalid {
                    UIApplication.shared.endBackgroundTask(backgroundTask)
                    backgroundTask = .invalid
                }
            }
        }
        defer {
            budgetWatchdog.invalidate()
            isBusy = false
            // 意图的两个观察槽只对**本次同步**有效。放在这里而不是某个成功分支：它必须覆盖
            // 所有出口（早退、抛错、取消），否则一次残留会让**下一次**同步的 `saveTask` /
            // `markSuccess` 去确认一条本轮根本没看到的通知。
            clearBackgroundIntentObservations()
            UIApplication.shared.isIdleTimerDisabled = previousIdleTimerState
            if backgroundTask != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTask)
                // 收尾后立刻归位：防止迟到的 expiration handler 对同一个 id 二次 end。
                backgroundTask = .invalid
            }
        }
        // 取消必须在任何网络/HealthKit 工作前生效。本函数不是 throwing，不能写 `try`；
        // 原先的 `try? Task.checkCancellation()` 会把取消错误直接吞掉，检查形同虚设。
        guard !Task.isCancelled else { finishCancelled(); return }
        // 🔴 锁屏预检查（文档 §3.4）。设备锁屏、或开机后尚未首次解锁时，HealthKit 数据库被
        // 硬件级加密锁死 —— 这里在动 HealthKit（以及握手）**之前**就拦下来，落一个可续接的
        // 阻塞态，而不是等第一次查询失败再报错。
        //
        // 为什么不能只靠 `HealthKitExport` 抛错兜底：那条路要到第一次查询才生效，而更早的
        // `readAuthorizationState()` 在锁屏时同样读不到状态（返回 `.unknown`），于是这里会先
        // 落一个 `failed` —— 用户看到一次"同步失败"，而解锁之后什么都不会自己发生。
        //
        // 位置刻意选在 `defer` 之后（`isBusy` 与续期额度都会被正确释放），也刻意在握手之前
        // （锁屏时那次握手没有任何用处，代价却是一次完整的网络往返）。
        if !Self.isProtectedDataAvailable {
            phase = HealthSyncBlockedRecovery.phase(for: .protectedData).rawValue
            message = HealthKitExportError.databaseLocked.localizedDescription
            lastError = nil
            // 记下"有事没做完"：`phase` 只活在进程内，而锁屏期间系统随时可能把 App 杀掉；
            // 磁盘上这份意图位是进程重启之后**唯一**还记得"该同步、但没同步成"的东西。
            recordBackgroundIntent()
            return
        }
        let identity: RaiHandshake
        do {
            identity = try await api.handshake(baseURL: serverURL, token: apiToken)
            try checkCancellation()
        } catch {
            if handleCancellation(error) { return }
            lastError = friendlyMessage(error)
            message = nil
            phase = SyncPhase.failed.rawValue
            return
        }
        let authoritativeScope = Self.syncScope(for: serverURL, identity: identity)
        #if os(iOS)
        HealthSyncIdentityPublisher.publish(identity, baseURL: serverURL)
        #endif
        activeScope = authoritativeScope
        activeIdentity = identity
        lastSyncAt = UserDefaults.standard.object(forKey: scopedKey(Self.lastSyncAtKey)) as? Date
        if UserDefaults.standard.object(forKey: scopedKey(Self.lastWorkoutCountKey)) != nil {
            lastWorkoutCount = UserDefaults.standard.integer(forKey: scopedKey(Self.lastWorkoutCountKey))
        }
        // A failed journal read is not an empty queue. Do not overwrite an
        // unresolved batch (or advance its anchor) while storage is unavailable.
        _ = loadTask()
        if let journalError = taskStore.lastError {
            hasPendingTask = true
            lastError = journalError
            phase = SyncPhase.failed.rawValue
            message = nil
            return
        }
        // 磁盘上**有**进度但解不开，与"没有进度"必须分开处理。
        //
        // 当成"没有任务"的可见后果是：安静地重导整个窗口、把 `lastWorkoutCount` 归零，
        // 而 `sync_tasks` 里那一行还在 —— 看起来就是一次普通的成功同步。所以这里如实报错，
        // 并把那份进度**清掉**（它已经不可用，留着会让每次同步都撞同一个错误）。
        // 下一次同步从干净状态开始，正常跑完。
        if taskDecodeError != nil {
            guard discardUnreadableTask() else { return }
            lastError = taskDecodeError
            message = nil
            return
        }
        // 🔴 B01（2026-10-17）：先补上一次"提交成功但结算未完成"的路线候选。
        // 它只动 `sync_route_state` / `sync_pending_routes`，不读 HealthKit、不动水位 ——
        // 放在推导下一步之前，是为了让"待办已结算"成为本轮导出看得见的事实。
        settlePendingRouteCommit()
        // 🔴 在推导"下一步做什么"**之前**盘点系统手上的传输。放在后面等于让
        // `SyncAtomicUnit.nextStep` 在"字节已经归系统"的情况下再发起一次上传 ——
        // 两份同样的字节同时打向服务端，其中一份必然撞 `import_upload_busy`（429）。
        // 取消掉它们不会丢东西：盘上的 multipart 还在，且 `boundary` 由 `payloadHash` 派生
        // ⇒ 重传的字节逐字节相同 ⇒ 服务端幂等命中同一条来源。
        await reconcileSystemUploads(loadTask())
        // 下一步由**字段**推导（`SyncAtomicUnit.nextStep`），不按 `phase` 字符串猜。
        // 猜错过一次：2026-09-22 那一版把"批次已上传、导入没发起"与"导入已在跑"写成同一个
        // `importing`，于是恢复分支只能二选一，线上的表现是 nginx 里再也没有 uploads。
        let restoredTask = loadTask()
        // 进度写点已在 `saveTask`/`clearTask` 里维护这个标志；这里补一次是为了让**重启后
        // 第一次读盘**也反映到界面上（`loadTask` 是唯一能看见磁盘上旧进度的地方）。
        hasPendingTask = restoredTask != nil
        // P2-3：恢复轮把任务行里的**本批通道计数**打出来（只写计数）。这样"崩在提交前的
        // 那一批带来了什么"在日志里仍可回答，不必重读一遍 HealthKit 才能知道。
        if let restored = restoredTask, let restoreCounts = restored.lastExportCounts {
            Self.logExportCounts(restoreCounts, scope: activeScope)
        }
        if restoredTask?.pendingRecordCursors != nil, (identity.healthKitRecordSyncVersion ?? 0) < 2 {
            // A backend downgrade must not acknowledge a saved v2 archive while
            // silently ignoring its typed deletion events. Keep the same batch
            // and cursors until the server can apply its protocol again.
            lastError = "服务端尚不支持完整健康记录增量，已保留待同步批次；请先升级服务端。"
            phase = SyncPhase.failed.rawValue
            message = nil
            return
        }
        let restoredZip: URL?
        do {
            if let restoredTask {
                restoredZip = try await persistedZipURL(restoredTask)
            } else {
                restoredZip = nil
            }
            try checkCancellation()
        } catch {
            if handleCancellation(error) { return }
            lastError = friendlyMessage(error)
            phase = SyncPhase.failed.rawValue
            message = nil
            return
        }
        let unitStep = SyncAtomicUnit.nextStep(
            sourceId: restoredTask?.sourceId,
            jobId: restoredTask?.jobId,
            hasZip: restoredZip != nil,
            hasMultipart: restoredTask.flatMap { persistedMultipartURL(for: $0) } != nil
        )
        // 🔴 「拿着 `jobId` 等终态」是这套状态机里**唯一**允许跨会话的一段，而它此前
        // 在生产里没有任何消费点：`SyncAtomicUnit.nextStep` 会正确返回 `.waitJob`，
        // 但下面两个分支只认 `.inspect` 与 `.upload`，于是带 `jobId` 的任务**直接坠进
        // 导出路径**。后果不是报错，而是三件静默的坏事一起发生（2026-10-11 线上实测）：
        //   1. 重读一遍 HealthKit（整个流程最贵的一步），而服务端其实早就算完了；
        //   2. 紧接着的 `saveTask` 会用一份 `sourceId: nil, jobId: nil` 的新任务**盖掉**旧行
        //      ⇒ 那个还在服务端跑（或已成功）的 job 再也没人接，来源靠 24h TTL 回收；
        //   3. 界面永远停在"更新尚未完成"——用户以为同步失败，其实服务端早已成功。
        //
        // 这个分支就是那条缺失的消费点。它与 `.inspect` 分支共用 `HealthSyncResumePolicy`
        // 的失败分类（同一个 `terminalJobCode` 语义），所以两条"拿服务端结论"的路不会分叉。
        if let restored = restoredTask, unitStep == .waitJob, let jobId = restored.jobId {
            do {
                // 如实写 `importing`：这一刻的事实就是"服务端在算，我在等"，而不是盘上那行
                // 老自述（可能停在 `recomputing` 之类的历史值上）。
                phase = SyncPhase.importing.rawValue
                message = "正在等待服务端完成上次导入"
                // ⚠️ 这里**刻意不**认领后台意图（`observeBackgroundIntentsForExportStart`）。
                // 那条通道的确认点只在**导出起点**：本分支不重新读 HealthKit，用的是早于
                // 通知生成的字节，没有资格替那条通知背书 —— 在这里确认，导出期间到达的
                // 那批新数据就再也没人导。（`markSuccess` 里的确认会读到 `nil` 观察槽，是空操作。）
                let finished = try await waitForJob(id: jobId, on: serverURL)
                removeTaskArtifacts(payloadHash: restored.payloadHash)
                try markSuccess(
                    message: resumedImportMessage(job: finished),
                    exportEnd: restored.exportEnd,
                    workoutCount: restored.workoutCount,
                    advanceWatermark: restored.exportEnd != nil,
                    clearWatermark: restored.exportEnd == nil,
                    anchor: restored.pendingAnchor,
                    recordCursors: restored.pendingRecordCursors,
                    hasMorePages: restored.needsContinuation ?? false,
                    // 🔴 B01：恢复轮只认任务行里的**候选**（观测 + 完成 UUID）。
                    // 老任务没有候选 ⇒ `nil` ⇒ 不结算、**不删待办**（安全分支）。
                    routeCommit: restored.routeCommit,
                    // WP-12（O03）：恢复轮的提交必须把任务行里那份删除余量解析出来 ——
                    // 遗漏它是 R3b 的两处缺陷之一（同内容的批次在其它分支会写槽、这里不会）。
                    pendingDeletions: try Self.restoredCommitDeletions(from: restored),
                    receipt: finished.summary?.directSync,
                    // 这一轮真的跑过导入作业（`startImport` → `waitForJob`），配得上的回执
                    // 会随这次 `finished` 一起到 —— 服务端宣告了能力位才等它（老服务端 §10.2
                    // 「保留旧等待含义」：它不会给我们回执，等就是自锁）。
                    requiresReceipt: directSyncNegotiated,
                    // 对账要用 `summary.analysisJobId`（服务端把那一批登记的分析任务交出来）：
                    // 回执里的 `analysisStatus` 是 COMMIT 快照（恒 `queued`），
                    // 只有这个 id 能让客户端在收尾之后问到一个**终态**（§10.3）。
                    job: finished
                )
                return
            } catch {
                if handleCancellation(error) { return }
                let httpError = error as? SyncHTTPError
                if HealthSyncResumePolicy.disposition(
                    statusCode: httpError?.statusCode,
                    errorCode: httpError?.code
                ) == .keepTask {
                    // 轮询超时 / 瞬时读不到：`jobId` 留着，下次唤醒从同一处接着等。
                    // 这**不是**"任务失败"，是"还没拿到结局"——与 `.inspect` 分支同一条纪律。
                    lastError = friendlyMessage(error)
                    message = nil
                    phase = SyncPhase.failed.rawValue
                    return
                }
                // 这个 job 不可能再等出结果了（服务端说它已终结，或这条 id 它已经不认）。
                // 先清掉那一行，否则下次同步会从同一个 `jobId` 进来、拿到同一个结局。
                guard clearTask() else { return }
                if httpError?.code == HealthSyncResumePolicy.terminalJobCode {
                    // 任务跑完并明确失败：如实报出去。失败若是确定性的，当场再导一次只是白跑。
                    lastError = friendlyMessage(error)
                    message = nil
                    phase = SyncPhase.failed.rawValue
                    return
                }
                // 服务端已经不认这个 job 了（没有终结任务挡路）：除了重走一遍没有别的路。
                // `clearTask()` 已经把旧行清掉，所以下面会从一次干净的导出开始。
                phase = SyncPhase.collecting.rawValue
                message = nil
            }
        } else if let restored = restoredTask, unitStep == .inspect, let sourceId = restored.sourceId {
            do {
                phase = restored.resolvedPhase.rawValue
                message = "正在恢复上次同步任务"
                let inspection = try await inspect(sourceId: sourceId, on: serverURL)
                try checkCancellation()
                if inspection.status == "unchanged" {
                    let cleaned = try await deleteUpload(sourceId: sourceId, on: serverURL)
                    // ⚠️ 顺序有讲究：**先删本地产物，再提交**。反过来的话（提交成功、
                    // 进程在删文件前被杀）会留下"没有任务行、却有一份多 GB 的 ZIP/multipart"
                    // 的孤儿 —— 而本仓没有任何 GC 会回收它（`removeTaskArtifacts` 之外
                    // 只有 `removeAllTaskArtifacts`，其唯一调用点在 payload 解不开时）。
                    // 现在这个顺序被杀只会留下"行还在、字节没了"，由 `SyncAtomicUnit`
                    // 的字段推导回到 `.export` 重导一次：多花时间，不丢数据、不漏磁盘。
                    removeTaskArtifacts(payloadHash: restored.payloadHash)
                    try markSuccess(
                        message: "Apple 健康数据已是最新" + (cleaned ? "" : Self.cleanupNoteSuffix),
                        exportEnd: restored.exportEnd,
                        workoutCount: restored.workoutCount,
                        advanceWatermark: restored.exportEnd != nil,
                        clearWatermark: restored.exportEnd == nil,
                        anchor: restored.pendingAnchor,
                        recordCursors: restored.pendingRecordCursors,
                        hasMorePages: restored.needsContinuation ?? false,
                        routeCommit: restored.routeCommit,
                        // WP-12（O03）：从任务行恢复删除余量（统一入口；损坏 ⇒ 报错保留任务）。
                        pendingDeletions: try Self.restoredCommitDeletions(from: restored),
                        // 服务端回的是 `unchanged`：它明确回答"这批**不必导入**"，那是对
                        // **已存在批次**的确认（§10.1「COMMIT 后回复丢失 ⇒ 返回同一成功」），
                        // 这一轮**没有新回执可等**。照旧要求回执 ⇒ `.hold("no_receipt")` ⇒
                        // 水位与游标一个字都不写 ⇒ 下一轮照样 `unchanged` ⇒ **自锁**。
                        // 推进水位与游标是这条路径的既有语义（ADR-004 的"清产物后提交"）。
                        requiresReceipt: false
                    )
                    return
                }
                // 走到这里 `jobId` **必然**是空的：带 `jobId` 的任务在上面那个 `.waitJob`
                // 分支就返回了。原先这里还留着一个 `if let existing = restored.jobId` 的回退，
                // 那是 `.waitJob` 分支缺席时代的产物 —— 它已经**不可达**（`.inspect` 的前置
                // 条件就是 `jobId == nil`），留着只会让下一个人以为"上传之后还有可能在等服务端"。
                try checkCancellation()
                let job = try await startImport(sourceId: sourceId, on: serverURL)
                try checkCancellation()
                try updateTask(jobId: job.id, phase: .importing)
                let jobId = job.id
                // `waitForJob` 只在 `succeeded` 时返回，其余终态都抛错 ⇒ 走到下一行就是成功。
                // 返回值**要接住**：§10.2 的持久回执就在这一次响应里，收尾文案与游标闸门
                // 都靠它（旧代码把它丢掉，于是这条恢复分支永远说不出"健康数据已保存"）。
                let finished = try await waitForJob(id: jobId, on: serverURL)
                removeTaskArtifacts(payloadHash: restored.payloadHash)
                try markSuccess(
                    message: resumedBranchMessage(fallback: "已从上次同步任务恢复", job: finished),
                    exportEnd: restored.exportEnd,
                    workoutCount: restored.workoutCount,
                    advanceWatermark: restored.exportEnd != nil,
                    clearWatermark: restored.exportEnd == nil,
                    anchor: restored.pendingAnchor,
                    recordCursors: restored.pendingRecordCursors,
                    hasMorePages: restored.needsContinuation ?? false,
                    routeCommit: restored.routeCommit,
                    // WP-12（O03）：与 `.waitJob` 分支同一处补漏 —— 恢复轮必须透传余量。
                    pendingDeletions: try Self.restoredCommitDeletions(from: restored),
                    receipt: finished.summary?.directSync,
                    // 这一轮真的跑过导入作业（`startImport` → `waitForJob`），配得上的回执
                    // 会随这次 `finished` 一起到 —— 服务端宣告了能力位才等它（老服务端 §10.2
                    // 「保留旧等待含义」：它不会给我们回执，等就是自锁）。
                    requiresReceipt: directSyncNegotiated,
                    // 对账要用 `summary.analysisJobId`（服务端把那一批登记的分析任务交出来）：
                    // 回执里的 `analysisStatus` 是 COMMIT 快照（恒 `queued`），
                    // 只有这个 id 能让客户端在收尾之后问到一个**终态**（§10.3）。
                    job: finished
                )
                return
            } catch {
                if handleCancellation(error) { return }
                let httpError = error as? SyncHTTPError
                let disposition = HealthSyncResumePolicy.disposition(
                    statusCode: httpError?.statusCode,
                    errorCode: httpError?.code
                )
                if disposition == .keepTask {
                    lastError = friendlyMessage(error)
                    message = nil
                    phase = SyncPhase.failed.rawValue
                    return
                }
                // 🔴 P1b：本批**字节自身**超了服务端单批上限 ⇒ 先把预算收敛一档再清任务。
                // 顺序不能反：`clearTask()` 之后"这一批"就不存在了，而收敛必须活过它，
                // 否则下次同步会用同一个量级产出同一份必被拒的产物（每次白读一遍 HealthKit）。
                // 收敛到上限仍被拒时，把确定性失败**如实报出去**、不再默默重导。
                if disposition == .convergeBudget {
                    let advanced = loadBudgetConvergence().advanced()
                    saveBudgetConvergence(advanced)
                    if advanced.isExhausted {
                        // 🔴 P2-2b（2026-10-15）：到顶即**终态失败**，不再继续当场重导。
                        // 上文注释说"到顶就把确定性失败如实报出去、不再默默重导"，但实现此前
                        // 缺这个 return：流程会继续落到 `phase = collecting` 用同一档位再导一遍，
                        // 形成"每次同步重撞 400"的活锁。到顶后**保留任务行**（不清）：下一次
                        // 同步只重放一次便宜的 inspect 并在此处停下（不再白读 HealthKit）。
                        lastError = "健康数据单批始终超过服务端上限，已停止自动重导；请稍后手动重试或联系维护者。"
                        message = nil
                        phase = SyncPhase.failed.rawValue
                        return
                    }
                }
                // 这个 task 不可能恢复了，先清掉它。留着它的后果不是"下次说不定能成"，
                // 而是下一次同步仍会从上面那句 `inspect(sourceId:)` 进来、拿到同一个 404：
                // 2026-09-22 线上实测，此后 nginx 日志里**再没有出现过任何 uploads**。
                guard clearTask() else { return }
                if httpError?.code == HealthSyncResumePolicy.terminalJobCode {
                    // 任务已经跑完并明确失败：把错误如实报出去。失败若是确定性的，
                    // 在这次点击里再悄悄跑一遍导入只是白跑一次；下一次同步从干净状态开始。
                    lastError = friendlyMessage(error)
                    message = nil
                    phase = SyncPhase.failed.rawValue
                    return
                }
                // 服务端已经没有这份暂存上传了（`sourceId` 已失效，且没有终结的任务挡路）：
                // 除了重新走一遍没有别的路，所以当场继续，而不是把这次点击留成一个错误提示
                // —— 「同步健康」按钮 / 前台自动同步都会立刻再撞同一个 404。
                // `clearTask()` 已经把它清掉，所以下面两个恢复分支都会自己跳过。
                phase = SyncPhase.collecting.rawValue
                message = nil
            }
        } else if let restored = restoredTask, unitStep == .upload, let persisted = restoredZip {
            do {
                phase = SyncPhase.uploading.rawValue
                // §10.3：续传已落盘的批次走同一条上传文案（`uploadingBatch`），不区分"恢复"这种内部差异。
                message = DirectSyncCopy.uploadingBatch
                // 大包上传不做自动重试：600s 超时 ×3 最坏阻塞 30 分钟，超过整个导入窗口，
                // 也远超 iOS 后台任务的执行时限。**multipart 与 ZIP 都已落盘**，所以失败
                // 不再是"白读一次 HealthKit"—— 下次同步会从这里接着传，且用的是同一个
                // `batchId`（服务端幂等命中同一份来源，不产生第二份）。
                let sourceId = try await uploadWithRecovery(
                    zipURL: persisted,
                    payloadHash: restored.payloadHash,
                    to: serverURL
                )
                try checkCancellation()
                // 🔴 上传一返回就落 `uploaded`（"服务端已收下、导入还没发起"），
                // 而不是直接落 `importing`。中间这一态是 D1 的全部依据：`inspect` 与
                // `startImport` 之间才是"原子单元的中间"。少了它，恢复时又只能靠猜。
                phase = SyncPhase.uploaded.rawValue
                try updateTask(sourceId: sourceId, phase: .uploaded, uploadState: .completed)
                message = DirectSyncCopy.persistingRecords
                let inspection = try await withRetry {
                    try await self.inspect(sourceId: sourceId, on: serverURL)
                }
                try checkCancellation()
                if inspection.status == "unchanged" {
                    let cleaned = try await deleteUpload(sourceId: sourceId, on: serverURL)
                    removeTaskArtifacts(payloadHash: restored.payloadHash)
                    try markSuccess(
                        message: "Apple 健康数据已是最新" + (cleaned ? "" : Self.cleanupNoteSuffix),
                        exportEnd: restored.exportEnd,
                        workoutCount: restored.workoutCount,
                        advanceWatermark: restored.exportEnd != nil,
                        clearWatermark: restored.exportEnd == nil,
                        anchor: restored.pendingAnchor,
                        recordCursors: restored.pendingRecordCursors,
                        hasMorePages: restored.needsContinuation ?? false,
                        routeCommit: restored.routeCommit,
                        // WP-12（O03）：从任务行恢复删除余量（统一入口；损坏 ⇒ 报错保留任务）。
                        pendingDeletions: try Self.restoredCommitDeletions(from: restored),
                        // 服务端回的是 `unchanged`：它明确回答"这批**不必导入**"，那是对
                        // **已存在批次**的确认（§10.1「COMMIT 后回复丢失 ⇒ 返回同一成功」），
                        // 这一轮**没有新回执可等**。照旧要求回执 ⇒ `.hold("no_receipt")` ⇒
                        // 水位与游标一个字都不写 ⇒ 下一轮照样 `unchanged` ⇒ **自锁**。
                        // 推进水位与游标是这条路径的既有语义（ADR-004 的"清产物后提交"）。
                        requiresReceipt: false
                    )
                } else {
                    try checkCancellation()
                    phase = SyncPhase.importing.rawValue
                    message = DirectSyncCopy.persistingRecords
                    let job = try await withRetry {
                        try await self.startImport(sourceId: sourceId, on: serverURL)
                    }
                    try checkCancellation()
                    try updateTask(jobId: job.id, phase: .importing)
                    // 与 `.inspect` 续接分支同一条纪律：接住这次响应，回执要从它身上取。
                    let finished = try await waitForJob(id: job.id, on: serverURL)
                    removeTaskArtifacts(payloadHash: restored.payloadHash)
                    try markSuccess(
                        message: resumedBranchMessage(fallback: "已从保存的健康数据批次恢复导入", job: finished),
                        exportEnd: restored.exportEnd,
                        workoutCount: restored.workoutCount,
                        advanceWatermark: restored.exportEnd != nil,
                        clearWatermark: restored.exportEnd == nil,
                        anchor: restored.pendingAnchor,
                        recordCursors: restored.pendingRecordCursors,
                        hasMorePages: restored.needsContinuation ?? false,
                        routeCommit: restored.routeCommit,
                        // WP-12（O03）：从任务行恢复删除余量（统一入口；损坏 ⇒ 报错保留任务）。
                        pendingDeletions: try Self.restoredCommitDeletions(from: restored),
                        receipt: finished.summary?.directSync,
                        // 同上：`.upload` 恢复分支也真的等了一个 `jobId` 的终态。
                        requiresReceipt: directSyncNegotiated,
                        // 对账要用 `summary.analysisJobId`（服务端把那一批登记的分析任务交出来）：
                        // 回执里的 `analysisStatus` 是 COMMIT 快照（恒 `queued`），
                        // 只有这个 id 能让客户端在收尾之后问到一个**终态**（§10.3）。
                        job: finished
                    )
                }
                return
            } catch {
                if handleCancellation(error) { return }
                lastError = friendlyMessage(error)
                message = nil
                phase = SyncPhase.failed.rawValue
                // 不登记任何"待重试批次"：**进度本身就是那条记录**。失败时它被刻意留着
                // （phase 停在 `exported` 或 `uploaded`），`SyncAtomicUnit.nextStep` 下次会
                // 从同一份本地产物接着走，用的是同一个 `payloadHash` 作为 batchId。
                // 唯一例外是确定性坏批次 —— 那时 `uploadWithRecovery` 已经把产物删掉了。
                return
            }
        }
        // `batchHash` = 本次成功落盘的那一批的 `payloadHash`。只在成功收尾时用来删本地产物
        // （`zipName` / `multipartName` 都由它派生）—— 失败路径刻意不删：那正是续传的全部依据。
        var batchHash: String?
        var transientExportURL: URL?
        var uncommittedArchive: HealthSyncArchive.PreparedArchive?
        do {
            // Asking is not the same as being answered. HealthKit returns without
            // an error when the user refuses read access — later queries just yield
            // nothing — so an empty export used to be indistinguishable from "not
            // authorized" and was reported as a successful sync of 0 runs. Ask for
            // the request status instead and stop with a cause the user can act on.
            let authorization = try await HealthKitExport.readAuthorizationState()
            try checkCancellation()
            switch authorization {
            case .unavailable:
                lastError = HealthKitExportError.unavailable.localizedDescription
                message = nil
                phase = SyncPhase.failed.rawValue
                return
            case .notDetermined:
                lastError = HealthKitExportError.authorizationUndecided.localizedDescription
                message = nil
                phase = SyncPhase.failed.rawValue
                return
            case .unknown:
                // The store could not say whether access was ever requested. An
                // empty export from here would be a guess dressed as a success, so
                // stop with a cause the runner can act on instead.
                lastError = HealthKitExportError.authorizationCheckFailed.localizedDescription
                message = nil
                phase = SyncPhase.failed.rawValue
                return
            case .decided:
                break
            }
            try checkCancellation()
            // 🔴 2026-10-17（边界收紧）：「重新导入全部」已**删除**，不是隐藏。
            //
            // 旧分支会 `forgetState` 删整行 `sync_state`、删老锚键、清预算档位，然后从零
            // 重取全部历史。它与"永不自动清空游标、不做全量同步"的边界直接冲突，而且它是
            // **唯一**会把 `sync_state` 整行删掉的地方 —— 留着它，边界就只是一句 UI 约定。
            // 现在恢复入口只有一个：显式「修复增量游标」（`repairSyncCursor`），只清坏掉的
            // 那一个游标，`export_end` 与其它类型原样保留。服务端的数据重建走服务器侧 CLI
            // 导入，不经过手机同步。
            // 🔴 这里原先还有第三个恢复分支：「UserDefaults 里记着一个失败 ZIP ⇒ 直接重传它」。
            // 它已随 P1 删除，理由是它**与 `SyncAtomicUnit` 覆盖同一件事、判据却各不相同**：
            // 它用 `try? fileHash(...)` 现算 batchId（哈希失败 ⇒ 静默不发幂等头 ⇒ 服务端每次
            // 新建一份来源 ⇒ 同一份数据被反复导入），还把**绝对路径**写进 UserDefaults
            // （`SyncTaskState` 的说明里已经写明这是不安全的形状）。
            // 现在是单一机制：失败时进度留在 `sync_tasks` 里（phase 停在 `exported` /
            // `uploaded`），下次由 `SyncAtomicUnit.nextStep` 从同一份本地产物接着走。
            // 锚与导出水位都从 `loadCommittedState()` 一处取 —— 这是**唯一**的读取点。
            // 改造前它们各自直接读 `UserDefaults`（这里三处 + `markSuccess` 一写），
            // 而"两套真相"的全部代价都来自读取点分散：漏改一处就静默分裂。
            let committed = try loadCommittedState()
            let lastExportEnd = committed?.exportEnd
            let repairFloor = UserDefaults.standard
                .object(forKey: scopedKey(Self.repairFloorKey)) as? Date
            if lastExportEnd != nil, repairFloor != nil {
                // 水位回来了 ⇒ 一次性下界没有意义了（留着只会在下次水位丢失时误导）。
                UserDefaults.standard.removeObject(forKey: scopedKey(Self.repairFloorKey))
            }
            // 有水位：读真实缺口（可能很长，但那是真实的未同步集合）；
            // 没水位：只有修复显式写下的有界下界，否则才是首装的无下界。
            let lowerBound: Date? = lastExportEnd.map { $0.addingTimeInterval(-Self.overlap) }
                ?? repairFloor
            let anchor = committed?.workoutAnchor
            // 伴生 Route 状态必须在**导出开始之前**整批读出来：导出跑在脱离主线程的上下文里
            // （`HealthSyncCancellation.runDetached`），那里碰不了 `@MainActor` 的 `taskStore`。
            // 表很小（每 workout 一行），整表读比"导出中发现一个 uuid 再跨 actor 回来查"更省。
            // 读失败（`isAvailable == false`）时是空字典 ⇒ 每个 workout 都按首查处理，
            // 方向安全：多查一次，不会漏读轨迹。
            let recordCursors = taskStore.loadRecordCursors(scope: activeScope)
            if let error = taskStore.lastError { throw SyncHTTPError(message: error) }
            guard (identity.healthKitRecordSyncVersion ?? 0) >= 2 else {
                throw SyncHTTPError(message: "服务端尚不支持完整健康记录增量，请先升级服务端。")
            }
            let routeStates = taskStore.loadRouteStates(scope: activeScope)
            let routeDiscoveryCursor = taskStore.loadRouteDiscoveryCursor(scope: activeScope)
            if let error = taskStore.lastError { throw SyncHTTPError(message: error) }
            // O02/WP-11：待查路线队列（上一批登记、尚未查询的 = 没有状态行的 UUID）。
            // 与 rediscovery 同一条定点查询通道消费；本批查完的回传在提交后移除。
            let pendingRouteTodos = taskStore.loadPendingRoutes(scope: activeScope)
            if let error = taskStore.lastError { throw SyncHTTPError(message: error) }
            // R3b：删除溢出的旧槽（上一批没发完的删除）。损坏当空 + 不阻断 —— 写入路径带
            // readBack 断言，损坏本不该发生；为它卡死同步链反而更糟。
            let pendingDeletionsData = taskStore.loadPendingDeletions(scope: activeScope)
            if let error = taskStore.lastError { throw SyncHTTPError(message: error) }
            let pendingDeletions = pendingDeletionsData
                .flatMap { try? JSONDecoder().decode(DirectSyncPendingDeletions.self, from: $0) } ?? .empty
            // P0-4：workout 级定向补齐窗口（上一批登记的「刚完成的训练」时间窗）。
            // 与 routeStates 同一条理由在导出**开始前**整批读出（导出跑在脱离主线程的上下文，
            // 碰不了 `@MainActor` 的 store）；读失败时为空 ⇒ 本批不补窗口，方向安全
            // （窗口待办留在表里，下一批再读）。
            let workoutBackfillWindows = taskStore.loadWorkoutBackfillWindows(scope: activeScope)
            if let error = taskStore.lastError { throw SyncHTTPError(message: error) }
            // P1-1（2026-10-18 同步诊断）：服务端覆盖探测。
            //
            // 触发条件（缺一不可）：服务端宣告了 `syncCoverageVersion >= 1`、且确实有类型需要
            // 历史重放（游标缺失或上轮重放未完成）。稳态增量不花这次请求。
            // 失败/老服务端 ⇒ 覆盖表为空 ⇒ 导出回落全量重放；**绝不让探测失败中断同步**。
            var coverage: [String: SyncCoveragePolicy.TypeCoverage] = [:]
            if (identity.syncCoverageVersion ?? 0) >= 1 {
                let decodedCursors = recordCursors
                    .flatMap { try? JSONDecoder().decode([String: HealthKitRecordCursor].self, from: $0) }
                    ?? [:]
                let recordTypes = HealthKitExport.recordTypeIdentifiers
                if SyncCoveragePolicy.needsCoverageQuery(cursors: decodedCursors, types: recordTypes) {
                    do {
                        let response = try await api.syncCoverage(
                            types: recordTypes, baseURL: serverURL, token: apiToken
                        )
                        try checkCancellation()
                        // datasetEpoch 是覆盖数据的身份：与握手权威值不一致时**不用**它
                        // （跨数据集复用覆盖点会跳过一段服务端其实没有的历史 ⇒ 方向错误）。
                        if response.datasetEpoch == identity.datasetEpoch {
                            coverage = Self.coverageTable(from: response)
                            NSLog("[RAI] 覆盖探测：%d 个类型可用，历史段将跳过服务端已覆盖部分",
                                  coverage.count)
                        } else {
                            NSLog("[RAI] 覆盖探测的 datasetEpoch 与握手不一致，回落全量重放")
                        }
                    } catch {
                        // 老服务端 / 网络失败 / 取消以外的错误：只留一行诊断，回落到全量重放。
                        // （取消由外层 `handleCancellation` 处理 —— 这里不再区分。）
                        NSLog("[RAI] 覆盖探测失败，回落全量历史重放：%@", String(describing: error))
                    }
                }
            }
            // `runDetached` 的闭包是 `@Sendable`：被捕获的 `var coverage` 必须先冻结成不可变
            // 快照（Swift 6 语言模式下"捕获可变变量进并发闭包"是错误，不是警告）。
            let coverageSnapshot = coverage
            let onProgress: @Sendable (String) async -> Void = { [weak self] status in
                await MainActor.run { [weak self] in
                    // 任何来源的中止一旦发生就不再发布晚到的进度：原因分类只影响 phase 怎么写，
                    // 不影响"中止后不要覆盖用户看到的文案"这条规则。
                    guard let self, !Task.isCancelled, self.cancelCause == .none else { return }
                    self.message = status
                }
            }
            // 🔴 **导出起点**：就在这里认领意图与恢复请求。
            //
            // 只有"这一次导出真的开始了"才能说"它覆盖了那条通知"，而代次比对
            // （`shouldAcknowledgeIntent`）负责排掉导出期间又新到的那一条 —— 那条必须留到下一轮。
            // 放在这里而不是"后台一轮的开头"，是因为上面那两条恢复分支（`inspect` 续接、
            // 重传已落盘的 ZIP）**不重新读 HealthKit**：拿它们的位置当观察点，会让一批早于
            // 通知生成的字节去认领那条通知，那批新数据从此没人导。
            // 前台与后台都经过这里 ⇒ 确认逻辑只有一份。
            observeBackgroundIntentsForExportStart(for: serverURL)
            // 单批预算（S2.1）：用本次握手宣告的 bounds 收敛（×0.9）；老服务端缺字段
            // ⇒ `from` 回落保守常量。超界此前是"静默回退候选链路"（整库备份 + 两次
            // 全库校验，线上 9.9–13.3 min），分批之后正常同步的每批都 ≤ 上界。
            // 🔴 再叠一层**跨批收敛**（P1b）：服务端拒过"这个量级"之后，下一次不能再用
            // 同一个量级重导 —— 收敛档位存在 `budgetConvergenceKey` 里，活过 `clearTask()`。
            let baseBudget = loadBudgetConvergence()
                .apply(to: DirectSyncBatchBudget.from(bounds: identity.directSyncBounds))
            let exported = try await HealthSyncCancellation.runDetached(
                priority: .userInitiated,
                onCancelledResult: { result in
                    try? FileManager.default.removeItem(at: result.zipURL)
                }
            ) {
                // 🔴 P2b 本地自校验：产物如果**真的**超了服务端硬上界，就把它留在本地、
                // 缩一档预算重导 —— 而不是发出去换一个 400（那会连带卡死恢复链，见 P1b）。
                // 判据是纯函数（`DirectSyncBatchBudget.exceedsServerBounds`）；与 `accepts`
                // 的分工：后者比的是**我方预算**，前者比的是**服务端上界本身**。
                // 有界：最多 `DirectSyncBudgetConvergence.maxSteps` 档，到顶就如实报出去。
                var attempt = 0
                while true {
                    let attemptBudget = DirectSyncBudgetConvergence(steps: attempt).apply(to: baseBudget)
                    let produced = try await HealthKitExport.exportArchive(
                        from: lowerBound,
                        workoutAnchor: anchor,
                        recordCursors: recordCursors,
                        routeStates: routeStates,
                        routeDiscoveryCursor: routeDiscoveryCursor,
                        // §4.2 步骤 6：定点重试只重开这些 UUID（全量重扫通道已随
                        // 「重新导入全部」一起删除）。
                        routeRetryWorkoutIDs: Set(routeRetryWorkoutIDs.map { $0.lowercased() }),
                        budget: attemptBudget,
                        // R3b：上一批没发完的删除（旧槽）。本批先发它，再发新删除；
                        // 仍装不下的余量在 `produced.pendingDeletions` 回传。
                        pendingDeletions: pendingDeletions,
                        // O02/WP-11 + R07：待办队列（**完整对象**，含调度状态）——导出层
                        // 据此决定"本批可执行子集"（blocked/退避未到期的不查）并按结局回传
                        // 调度更新；登记/移除仍由本函数在提交前后按既有纪律执行。
                        pendingRouteTodos: Array(pendingRouteTodos.values),
                        // P0-4：到期窗口（导出在迟到补读/48h 窗口/历史重放之前先查它们）。
                        workoutBackfillWindows: Array(workoutBackfillWindows.values),
                        // P1-1：覆盖表（空 = 回落全量重放）。
                        coverage: coverageSnapshot,
                        // B2：类型轮转起点（上一批读到的位置；让历史重放无类型饿死）。
                        typeRotationStart: self.loadRecordTypeRotation(),
                        onProgress: onProgress
                    )
                    guard let bounds = identity.directSyncBounds,
                          attemptBudget.exceedsServerBounds(
                              bounds: bounds,
                              xmlBytes: produced.xmlBytes,
                              // ⚠️ 用**删除配额**（与服务端 `:439-443` 同口径），不是 XML 记录条数
                              // —— 后者在直连车道不受服务端约束（P3b）。反了会把合法载荷反复重导。
                              deletions: produced.deletionCount,
                              routeBytes: produced.routeBytes,
                              routeFiles: produced.routeCount
                          ) else { return produced }
                    // 这一份产物必被拒：先删掉再重导，别把中间产物留在 tmp。
                    try? FileManager.default.removeItem(at: produced.zipURL)
                    attempt += 1
                    guard attempt < DirectSyncBudgetConvergence.maxSteps else {
                        // P2-2a（2026-10-15）：带**专用本地 code** —— 外层兜底 catch 据此把"耗尽"
                        // 落进跨批收敛档（否则下一轮仍从旧档重导、白读一遍 HealthKit）。
                        throw SyncHTTPError(
                            message: "健康数据单批始终超过服务端上限，本次同步已停止；请稍后重试或联系维护者。",
                            code: DirectSyncBudgetConvergence.exhaustedErrorCode
                        )
                    }
                }
            }
            transientExportURL = exported.zipURL
            try checkCancellation()
            // P2-3：本批通道计数只进日志（**只写计数**，不含样本值/UUID/日期）。
            Self.logExportCounts(exported.channelCounts, scope: activeScope)
            // P0-4：窗口的**超前登记**（先表后锚）—— 与路线待办同一条纪律：崩在随后任何一步
            // 只会让窗口早到（下批多查一次，幂等），绝不会丢；锚的提交链在任务行与回执之后。
            guard taskStore.upsertWorkoutBackfillWindows(
                exported.workoutWindowRegistrations, scope: activeScope
            ) else {
                throw SyncHTTPError(message: taskStore.lastError ?? "workout 补齐窗口未能写入")
            }
            // P0-6 / P2-3：UI 只读快照。回执计数由 `markSuccess` 在服务端确认后补齐。
            lastExportSummary = Self.exportSummary(from: exported)
            // 只把 scope 目录快照交给 worker；分块哈希/复制/原子发布都不触碰 MainActor 状态。
            message = "正在保存健康数据批次"
            let prepared = try await HealthSyncArchive.prepare(exported.zipURL, in: artifactFolder())
            uncommittedArchive = prepared
            transientExportURL = nil
            try checkCancellation()
            // O02/WP-11：待办路线的**超前登记**（先表后锚）—— 本批被预算挡住、没有状态行的
            // UUID 必须在下批可发现。崩在随后任何一步只会让待办早到（下批多查一次、upsert
            // 幂等），绝不会丢：锚的提交链在任务行与回执之后。
            guard taskStore.upsertPendingRoutes(exported.pendingRouteTodos, scope: activeScope) else {
                throw SyncHTTPError(message: taskStore.lastError ?? "路线待办未能写入")
            }
            let payloadHash = prepared.payloadHash
            let persisted = prepared.zipURL
            batchHash = payloadHash
            let pendingAnchor = exported.workoutAnchor
            // `exported` = "ZIP 已落盘、`payloadHash` 已算，还没上传"。写它而不是直接写
            // `uploading`，是为了让"有一份本地产物等着被发送"成为**可持久表达**的状态：
            // 崩溃在这个窗口里时，下次唤醒靠它知道不需要重读 HealthKit。
            phase = SyncPhase.exported.rawValue
            try saveTask(SyncTaskState(
                target: serverURL.absoluteString,
                serverId: identity.serverId,
                athleteId: identity.athleteId,
                datasetEpoch: identity.datasetEpoch,
                protocolVersion: identity.syncProtocolVersion,
                phase: SyncPhase.exported.rawValue,
                sourceId: nil,
                jobId: nil,
                payloadHash: payloadHash,
                pendingAnchor: pendingAnchor,
                pendingRecordCursors: exported.recordCursors,
                pendingRouteDiscoveryCursor: exported.routeDiscoveryCursor,
                exportEnd: exported.exportedThrough,
                workoutCount: exported.workoutCount,
                multipartFileName: Self.multipartName(for: payloadHash),
                zipFileName: Self.zipName(for: payloadHash),
                multipartBoundary: Self.multipartBoundary(for: payloadHash),
                uploadState: .pending,
                // 导出层的"还有未读页"写进任务行（S2.3）：中途崩溃/挂起后，恢复轮从
                // 任务行透传进 `markSuccess`（提交时再落 `sync_continuation` 槽）。
                // 不写它的话，恢复轮只能传 false —— 一次被预算截断的导出会在崩溃后
                // 静默失去"还有页"的记忆。
                //
                // R3b：删除余量与它**同族**（都是"导出态"），走同一条透传通道 ——
                // 少了它，恢复轮的提交会把余量当空、那批删除随锚点推进永久丢失。
                needsContinuation: exported.hasMorePages || !exported.pendingDeletions.isEmpty,
                // WP-12（O03）：**空也编码**（显式空对象）—— 恢复轮据此把"清槽"执行掉。
                // 旧的 `isEmpty ? nil` 让空余量伪装成"未记录"（老任务语义）⇒ 恢复轮不更新
                // 旧槽 ⇒ 已发完的删除被反复重发。只有**老任务缺键**才表示"未记录，不更新"。
                pendingDeletions: try? JSONEncoder().encode(exported.pendingDeletions),
                // R03：本批"已交付、待提交后结算"的路线待办随任务行落盘 —— 恢复轮（崩在
                // 导出完成与提交成功之间）凭它把待办从队列里结算掉；缺键（老任务）=
                // 没有完成证明 ⇒ 恢复轮不移除（残留只多查一次，安全方向）。
                completedRouteTodos: exported.completedRouteTodos,
                // 🔴 B01（2026-10-17）：把**完整观测**与完成 UUID 一起持久化。只存 UUID 的
                // 形态让恢复轮只能删待办、写不出状态 —— 那条路线会从两条发现通道同时消失
                // （见 `RouteCommitCandidate`）。候选在**上传之前**就落盘：崩在提交成功与
                // 结算完成之间时，本地仍有一份可执行的结算证据，不必重读 HealthKit。
                routeCommit: Self.routeCommitCandidate(
                    scope: activeScope, batchId: payloadHash, exported: exported
                ),
                // P2-3：本批通道计数随任务行落盘 —— 恢复轮把它原样带进日志与摘要，
                // 于是"崩在提交前的一批带来了什么"不必重读 HealthKit 才能回答。
                lastExportCounts: exported.channelCounts
            ))
            // B2：轮转起点在**导出成功之后**立刻落盘（与任务行同批；即使随后上传失败，
            // 下一轮从新起点继续 —— 起点只影响"从哪个类型先读"，多走一步无害）。
            saveRecordTypeRotation(exported.nextTypeRotationStart)
            // 日志落盘后产物归可恢复任务所有；之后取消或上传失败都必须保留它。
            uncommittedArchive = nil
            try checkCancellation()
            phase = SyncPhase.uploading.rawValue
            // §10.3 的进度文案不再带次数：这一批的次数是**尾注**（收尾那句的括号里），
            // 进度说的只是 `uploadingBatch` 那一句。
            message = DirectSyncCopy.uploadingBatch
            let sourceId = try await uploadWithRecovery(
                zipURL: persisted,
                payloadHash: payloadHash,
                to: serverURL
            )
            try checkCancellation()
            // 上传一返回就落 `uploaded`，理由同恢复分支：这是 D1 的中间态。
            phase = SyncPhase.uploaded.rawValue
            try updateTask(sourceId: sourceId, phase: .uploaded, uploadState: .completed)
            message = DirectSyncCopy.persistingRecords
            let inspection = try await withRetry {
                try await self.inspect(sourceId: sourceId, on: serverURL)
            }
            try checkCancellation()
            if inspection.status == "unchanged" {
                let cleaned = try await deleteUpload(sourceId: sourceId, on: serverURL)
                // 先删本地产物、再提交。反过来的话，提交成功而进程死在删文件之前，
                // 留下的就是"没有任务行、却有一份多 GB 的 ZIP"的孤儿（本仓没有回收它的人）。
                // 现在这个顺序被杀只会退回 `.export` 重导一次：多花时间，不丢数据、不漏磁盘。
                removeTaskArtifacts(payloadHash: payloadHash)
                try markSuccess(
                    message: exportMessage(base: "Apple 健康数据已是最新", exported: exported)
                        + (cleaned ? "" : Self.cleanupNoteSuffix),
                    exportEnd: exported.exportedThrough,
                    workoutCount: exported.workoutCount,
                    advanceWatermark: true,
                    anchor: pendingAnchor,
                    recordCursors: exported.recordCursors,
                    hasMorePages: exported.hasMorePages,
                    routeCommit: Self.routeCommitCandidate(
                        scope: activeScope, batchId: payloadHash, exported: exported
                    ),
                    // R3b：本批算出的删除余量（可能为空 = 清旧槽）。
                    pendingDeletions: exported.pendingDeletions,
                    // P0-4：本批窗口的整窗查询记账（成功后才结算）。
                    workoutWindowUpdates: exported.workoutWindowUpdates,
                    // 同两条恢复分支：`unchanged` 是对已存在批次的确认，没有新回执可等。
                    requiresReceipt: false
                )
            } else {
                try checkCancellation()
                phase = SyncPhase.importing.rawValue
                message = DirectSyncCopy.persistingRecords
                let job = try await withRetry {
                    try await self.startImport(sourceId: sourceId, on: serverURL)
                }
                try checkCancellation()
                try updateTask(sourceId: sourceId, jobId: job.id, phase: .importing)
                let finished = try await waitForJob(id: job.id, on: serverURL)
                removeTaskArtifacts(payloadHash: payloadHash)
                try markSuccess(
                    message: importMessage(exported: exported, job: finished),
                    exportEnd: exported.exportedThrough,
                    workoutCount: exported.workoutCount,
                    advanceWatermark: true,
                    anchor: pendingAnchor,
                    recordCursors: exported.recordCursors,
                    hasMorePages: exported.hasMorePages,
                    routeCommit: Self.routeCommitCandidate(
                        scope: activeScope, batchId: payloadHash, exported: exported
                    ),
                    // R3b：本批算出的删除余量（可能为空 = 清旧槽）。
                    pendingDeletions: exported.pendingDeletions,
                    // P0-4：本批窗口的整窗查询记账（成功后才结算）。
                    workoutWindowUpdates: exported.workoutWindowUpdates,
                    receipt: finished.summary?.directSync,
                    // 这一轮真的跑过导入作业（`startImport` → `waitForJob`），配得上的回执
                    // 会随这次 `finished` 一起到 —— 服务端宣告了能力位才等它（老服务端 §10.2
                    // 「保留旧等待含义」：它不会给我们回执，等就是自锁）。
                    requiresReceipt: directSyncNegotiated,
                    // 对账要用 `summary.analysisJobId`（服务端把那一批登记的分析任务交出来）：
                    // 回执里的 `analysisStatus` 是 COMMIT 快照（恒 `queued`），
                    // 只有这个 id 能让客户端在收尾之后问到一个**终态**（§10.3）。
                    job: finished
                )
            }
        } catch {
            if let uncommittedArchive {
                // 取消中的清理不能再走带取消闸门的 runDetached，否则清理本身会被跳过。
                await Task.detached(priority: .utility) {
                    uncommittedArchive.discardIfUncommitted()
                }.value
            }
            if let transientExportURL {
                await Task.detached(priority: .utility) {
                    try? FileManager.default.removeItem(at: transientExportURL)
                }.value
            }
            if handleCancellation(error) { return }
            // 🔴 **兜底 catch 不许覆盖更具体的结论。** 这一段此前无条件写 `failed`，于是
            // "锁屏"与"等凭证"这两个**非失败**结论会被抹掉 —— 而它们各自都有正确的落点
            // （阻塞态）与各自的恢复路径（解锁通知 / 前台重新拿到凭证）。
            // 判据顺序也重要：先判阻塞，再落 `failed`。
            if let exportError = error as? HealthKitExportError, exportError == .databaseLocked {
                // 预检查通过之后设备才被锁上 —— 锁屏可以发生在任意两次 await 之间。
                phase = HealthSyncBlockedRecovery.phase(for: .protectedData).rawValue
                message = HealthKitExportError.databaseLocked.localizedDescription
                lastError = nil
                recordBackgroundIntent()
                return
            }
            if error is SyncCredentialRequiredError {
                // `uploadWithRecovery` 已经落好了 `auth_required` 与文案（它知道当时是哪个
                // 响应、盘上哪一批），这里只负责**不要**把它覆盖成失败。
                return
            }
            // 🔴 P2-2a（2026-10-15）：P2b 的**重导循环耗尽**（本地信号）必须把"已到顶"落进
            // 跨批收敛档 —— 否则下一轮同步从旧档位重新导出、重跑同一耗尽循环，每次都白读
            // 一遍 HealthKit（GB 级，全流程最贵一步）。耗尽态 = 满档；幂等，重复触发无害。
            if (error as? SyncHTTPError)?.code == DirectSyncBudgetConvergence.exhaustedErrorCode {
                saveBudgetConvergence(DirectSyncBudgetConvergence(steps: DirectSyncBudgetConvergence.maxSteps))
            }
            phase = SyncPhase.failed.rawValue
            lastError = friendlyMessage(error)
            message = nil
            // 与恢复分支同理：失败时**不登记**任何"待重试批次"，进度留在 `sync_tasks` 里
            // 就够了（phase 停在 `exported` 或 `uploaded`，下次由 `SyncAtomicUnit` 接着走）。
            // 确定性坏批次连本地产物都已被 `uploadWithRecovery` 删掉，下一次从新导出开始。
        }
        // 收尾兜底。正常情况下两个成功分支已经在 `markSuccess` 里**一次事务**把
        // 「水位前进 + 任务行清空」做完了（`SyncTaskStore.commitSuccess`），所以到这里的
        // `clearTask()` 是删 0 行的幂等调用。留着它的理由是"将来有人加一条不抛错、也没走
        // `markSuccess` 的提前返回"——那种形态下盘上会留着一行，界面会一直说"还卡着一批"。
        //
        // ⚠️ 清本地产物**只能在成功路径上发生**。中止路径（`handleCancellation` 返回 true）
        // 在这之前就已经 `return` 了，所以这里多出来的 phase 判断是第二道锁：
        // 它挡的是"将来有人加一条不抛错的提前返回"，那种形态下会把一份**还没发出去**的
        // 批次连字节一起删掉 —— 而 `phase` 是唯一能反映这件事的字段。
        //
        // 🔴 还要算上被游标闸门拦下的一轮（`cursorHoldThisRound`）：它**既没失败、也没结**，
        // 上面那两个通道都看不见它。漏掉它的后果是任务行与候选游标被清掉、界面改口"成功"，
        // 而 §10.2 要的恰恰是"未确认的批次留着等下一轮"。
        let settled = !cursorHoldThisRound && lastError == nil && phase != SyncPhase.failed.rawValue
            && phase != SyncPhase.cancelled.rawValue
        if settled {
            if let batchHash { removeTaskArtifacts(payloadHash: batchHash) }
            guard clearTask() else { return }
            phase = SyncPhase.succeeded.rawValue
        }
        // 🔴 分析终态对账：**收尾之后**才做，而且**只在这一轮已经收尾**时做。
        //
        // 位置的两条理由：
        //   * `markSuccess` 的 `commitSuccess`（游标提交）已经跑完 —— 这一行以下改不了
        //     "原始事实已保存"这个结论，它只能改`message`那句给人看的话（§14.2 A17）；
        //   * 被游标闸门拦下的那一轮（`cursorHoldThisRound`）与失败/取消都进不了 `settled`，
        //     所以这里天然只覆盖"真的收到了持久回执"的那一轮。
        //
        // 同步整体被取消时不再发这一次请求：用户刚刚按下取消，再补一个网络往返既违背他的
        // 意图，也会在后台额度紧张时抢时间（能省则省，而这一句结论下一轮照样会有）。
        if settled, !Task.isCancelled, !cursorHoldThisRound,
           let serverURL = activeServerURL, !activeToken.isEmpty {
            await reconcilePendingAnalysis(serverURL: serverURL, apiToken: activeToken)
        }
        #else
        lastError = "读取 Apple 健康只能在 iPhone 上进行"
        #endif
    }

    func dismissStatus() {
        if !isBusy {
            message = nil
            lastError = nil
        }
    }

    /// 中止的落点。落点判据本身在 `HealthSyncLifecycle.phaseAfterStop`（纯函数，有执行者）——
    /// 这个文件不被任何回归脚本编译，写在这里的行为没人能断言。
    private func finishCancelled() {
        guard let next = HealthSyncLifecycle.phaseAfterStop(cause: cancelCause, current: phase) else {
            // 阶段早已结束，本次中止没有新信息可记；不动 phase / lastError，
            // 免得把失败原因抹成 idle、让用户看不到为什么失败。
            return
        }
        lastError = nil
        phase = next
        message = cancelCause == .manual ? "同步已取消" : "同步已暂停，下次连接继续"
    }

    private func checkCancellation() throws {
        try HealthSyncCancellation.check(manuallyCancelled: cancelCause == .manual)
    }

    @discardableResult
    private func handleCancellation(_ error: Error) -> Bool {
        let urlError = error as? URLError
        guard error is CancellationError || urlError?.code == .cancelled || Task.isCancelled else {
            return false
        }
        finishCancelled()
        return true
    }

    /// 服务端有没有宣告 §10.2 的回执能力（`/v1/handshake` 的 `factsAnalysisContractVersion`）。
    ///
    /// 它是调用点决定 `requiresReceipt` 的唯一依据：**宣告了** = 这一轮跑过导入作业时应该
    /// 能等到一份持久回执；**没宣告** = 老服务端，§10.2 的原文是「保留旧等待含义」——
    /// 拿它的 `succeeded` 去等一份永远不会来的回执，只会让游标再也推不动（自锁）。
    ///
    /// ⚠️ 判据只到"有没有宣告"这一层，**不在这里判版本下界**：`false` 与 `true` 的语义差别
    /// 是"适不适用这套判据"，而不是"值够不够新"。值 `>= 1` 的比较住在
    /// `DirectSyncCursorPolicy.decision` 里（那正是 `server_contract_missing` 存在的理由：
    /// 给了回执却宣告了一个过低的能力位，是一份自相矛盾的回答，方向只能往安全处倒）。
    private var directSyncNegotiated: Bool {
        activeIdentity.flatMap(HealthSyncIdentityPublisher.directSyncCapabilityVersion) != nil
    }

    /// 恢复轮的删除余量（**唯一入口**，WP-12 / O03）：损坏 ⇒ 抛错、保留任务。
    ///
    /// 三态语义见 `RestoredPendingDeletions`；这里只把 `corrupted` 翻译成用户可见的失败 ——
    /// 抛出 ⇒ `markSuccess` 不会删任务行、anchor 不推进，下一轮可重试或人工处置。
    /// 静默按空推进会把那批删除永久丢失（任务行已删、余量没进槽）。
    private static func restoredCommitDeletions(
        from task: SyncTaskState
    ) throws -> DirectSyncPendingDeletions? {
        switch DirectSyncPendingDeletions.restoredFromTask(task.pendingDeletions) {
        case .notRecorded:
            return nil
        case .decoded(let deletions):
            return deletions
        case .corrupted:
            throw SyncHTTPError(
                message: "同步任务中的删除余量记录已损坏；为避免漏发删除，本轮不提交（任务已保留）"
            )
        }
    }

    /// 成功收尾：**一次事务**把「水位前进/清空 + 任务行清空」落下去，然后才更新展示字段。
    ///
    /// 与改造前的区别（V2.1 规范 §2 原则 3「单状态源真相」）：
    ///   - anchor 与导出水位此前写在 `UserDefaults`、任务行写在 `sync_tasks`（SQLite）⇒
    ///     「这次同步已提交」被拆成**跨两个存储的两步写**；
    ///   - `clearExportWatermark()` 与 `markSuccess(advanceWatermark:)` 此前是一对调用
    ///     （四个恢复分支各一次），中间又是一条崩溃窗口；
    ///   - 现在两者都进 `SyncTaskStore.commitSuccess` 的同一个事务，"清空"用
    ///     `clearWatermark:` 表达，不再有独立的第二次调用。
    ///
    /// 🔴 提交前先过 `SyncStateCommitPlan.mayCommit` —— **阻塞态绝不推进 anchor**。
    /// 这条不变式此前在 `SyncPhase` 里定义、在 `HealthSyncBlockedRecovery` 里转发、在回归里
    /// 自比，却**没有任何生产调用点**：真正拦住它的是 `performSync` 里两处提前 `return`，
    /// 而那两处是"锁屏/等凭证该怎么办"的副产品，不是"anchor 该怎么写"的判据。
    /// 挂到这里之后，它才第一次出现在 anchor 的写入路径上。
    /// - Parameter routeCommit: 本批路线证据（观测 + 完成待办 + 发现游标）。导出轮传本批
    ///   刚算出的候选；恢复轮传任务行里的候选；没有路线的批次传 `nil`（= 不结算，
    ///   **不等于**"删光待办"）。老任务没有候选 ⇒ 一条待办都不删（§3.2 步骤 9）。
    /// - Parameter receipt: 服务端 `summary.directSync` 的持久回执（§10.1）。`nil` = 没拿到
    ///   （老服务端 / 旧候选链路 / 本次没有导入任务）—— 调用方**必须**沿用今天的文案，
    ///   并把游标交给闸门去判，不许把单一 `succeeded` 当成回执（§10.2）。
    /// - Parameter requiresReceipt: 这一轮的水位/游标是不是**只有在拿到服务端持久回执之后才敢
    ///   提交**（§10.2）。传 `false` 的调用点必须说得出"这一轮为什么没有新回执可等"：
    ///   * 老服务端（能力位缺失，见 `directSyncNegotiated`）—— §10.2「保留旧等待含义」；
    ///   * `POST /v1/imports/inspect` 回 `unchanged` 的收尾 —— 服务端明确回答"这批不必导入"，
    ///     那是对**已存在批次**的确认（§10.1「COMMIT 后回复丢失 ⇒ 返回同一成功」），
    ///     本地"清产物后提交"的顺序本身就是 ADR-004 的要求，没有新回执可等。
    ///   这两种路径若照旧要求回执，就会 `.hold("no_receipt")` ⇒ 水位与游标一个字都不写 ⇒
    ///   下一轮服务端照样回 `unchanged` ⇒ **自锁**。
    ///   默认取安全侧（`true`）：新增调用点忘了写就会走回执判据，而不会静默推进游标。
    /// - Parameter hasMorePages: 本轮的导出是否因**单批预算**截断而"还有未读页"（S2.1）。
    ///   导出轮传 `exported.hasMorePages`；恢复轮从任务行透传 `restored.needsContinuation`；
    ///   默认 `false`（这一轮没有新导出，且盘上也没有悬着的续页）。它进
    ///   `continuationNeeded` 决定"这轮之后还要不要接着跑"，并被 `commitSuccess` 落进
    ///   `sync_continuation` 槽（前台补跑与后台唤醒的持久判据）。
    private func markSuccess(
        message: String,
        exportEnd: Date?,
        workoutCount: Int,
        advanceWatermark: Bool,
        clearWatermark: Bool = false,
        anchor: Data? = nil,
        recordCursors: Data? = nil,
        hasMorePages: Bool = false,
        recordWorkoutCount: Bool = true,
        // 🔴 B01（2026-10-17）：本批路线证据 = 观测 + 完成待办 + 发现游标。
        //
        // **无默认值**是刻意的：漏传会让"这一批查过的路线"静默不结算（下一轮重读
        // HealthKit 才发现），而有默认值时编译器不会提醒。恢复轮传任务行里的候选；
        // 导出轮传本批刚算出的候选；没有路线的批次传 `nil` —— 它表示"不结算"，
        // **不是**"删光待办"。
        routeCommit: RouteCommitCandidate?,
        // WP-12（O03）：删除余量。**无默认值**是刻意的 —— 有默认值时"某处调用漏传"会静默
        // 通过（R3b 就漏了 `.waitJob` 与 `.inspect 续接` 两处恢复分支）。三态语义与
        // `SyncTaskStore.commitSuccess` 的同名参数逐字一致：`nil` = 不改旧槽；空 = 清；非空 = 写；
        // 新增调用点必须显式表达属于哪一种（漏传 = 编译失败）。
        pendingDeletions: DirectSyncPendingDeletions?,
        // P0-4（2026-10-18 同步诊断）：本批**整窗查询过**的 workout 补齐窗口记账。
        //
        // 与 `pendingDeletions` 的"无默认值"不同，这里**给默认空数组**是安全的：
        // 漏传的唯一后果是该窗口的下一次检查时刻/收口没有推进 ⇒ 下一批再查一次
        // （服务端按 UUID 幂等吸收重复样本）。恢复轮本来就没有新导出，传空即正确。
        //
        // 🔴 写入时机必须在 `commitSuccess` **之后**（与路线待办同一条"成功后才结算"）：
        // 上传/导入失败的批次不能留下"已经补齐了"的证据。
        workoutWindowUpdates: [WorkoutBackfillWindow] = [],
        // O02/WP-11 + R03：本批已成功交付、可从待办队列移除的 UUID。
        // 🔴 只有**完整观测**（`RouteFetch.Outcome.observation`，含合法零点）才会成为
        // 候选 —— 读取失败（`.unreadable`）绝不进这里（2026-10-16 复查：旧实现对
        // `observation == nil` 的失败结果也记"查完"，把唯一的重试线索删掉）。
        // 🔴 移除只在**提交成功之后**执行，且与路线状态落盘在**同一个本地短事务**里
        // （`SyncTaskStore.upsertRouteStates(removePendingTodos:)`，状态写不进去 ⇒ 待办
        // 原样保留）。
        //
        // 🔴 B01：这个集合现在**只从候选**派生（`RouteCommitSettlement.settle`）。候选为
        // `nil`（老任务 / 本轮没查路线）⇒ 集合为空 ⇒ 一条待办都不删。"只有 UUID 没有观测"
        // 的旧任务因此走安全分支，而不是从 UUID 猜造状态。
        receipt: DirectSyncReceipt? = nil,
        requiresReceipt: Bool = true,
        job: ImportJobResponse? = nil
    ) throws {
        try checkCancellation()
        guard SyncStateCommitPlan.mayCommit(phase: SyncPhase.migrate(phase)) else {
            // 走到这里说明调用点漏了阻塞态的前置返回 —— 而它的后果是**永久丢数据**
            // （把"这次没读到"记成"数据没有变化"，那段健康数据从此不再进入任何一次导出）。
            // 宁可让本次同步失败，也不许把 anchor 推上去。
            phase = SyncPhase.failed.rawValue
            lastError = Self.blockedCommitText
            throw SyncHTTPError(message: lastError ?? "同步处于阻塞状态")
        }
        // 🔴 §10.2 的闸门：**先看回执，再决定要不要提交这一页的候选游标**。
        //
        // 判据不住在这里（住 `DirectSyncCursorPolicy`）的理由与 `SyncPhase` / `HealthSyncBlockedRecovery`
        // 同源：`HealthKitSync.swift` 不被任何回归脚本编译，判据写在这里只能靠真机复现。
        // 这里只负责"把两个维度如实报进去、拿到结论之后怎么办"。
        //
        // 两个维度都是**语义入签名**，刻意不做隐式短路（本批踩过的形态正是"一处豁免、
        // 另一处没豁免"：`needsContinuation` 当时豁免了老服务端，闸门那一侧漏了）：
        //   - `pendingCursorsPresent: recordCursors != nil` = **这一轮有没有 v2 页游标要提交**
        //     （`HealthKitExportResult.recordCursors` / `SyncTaskState.pendingRecordCursors`
        //     那份 blob），与"有没有 anchor"是两件事；
        //   - `requiresReceipt` = 这一轮的游标**是不是只有服务端确认后才敢提交**（见形参说明）。
        //
        // ⚠️ `pendingCursorsPresent` 在本客户端上**恒为真**（`HealthKitExportResult.recordCursors`
        // 非可选）—— 所以真正把"`unchanged` 收尾 / 老服务端"与"跑了导入作业的收尾"分开的，
        // 是 `requiresReceipt` 这一个 Bool，而不是它。
        let directSyncCapabilityVersion = activeIdentity.flatMap(
            HealthSyncIdentityPublisher.directSyncCapabilityVersion
        )
        let cursorDecision = DirectSyncCursorPolicy.decision(
            serverContractVersion: directSyncCapabilityVersion,
            receipt: receipt,
            pendingCursorsPresent: recordCursors != nil,
            requiresReceipt: requiresReceipt,
            phase: SyncPhase.migrate(phase)
        )
        // §5.1 + §10.2：「还要不要接着发下一批」= 这一轮有没有 drain 完。
        // `hasMorePages` 自 S2.1 起**不再恒为假**：导出被单批预算截断时，drain 停在页末尾并
        // 如实报 true（调用方传入；导出轮来自 `HealthKitExportResult.hasMorePages`，
        // 恢复轮从任务行透传 `restored.needsContinuation`）。`deletionOnlyPage` 仍恒为假 ——
        // 它的旧语义（"刚消费完的那一页是删除-only ⇒ 未必到底"）已被 drain 内部消化
        // （删-only 页不是 EOF，继续读到空页为止），预算截断的新停止点由 `hasMorePages` 覆盖。
        // 续接的另一半来自**回执**：未确认的批次不算 drain 完。
        // `requiresReceipt == false` 时那一半也不适用（这一轮没有"未确认批次"这回事），
        // 判据与出口同样住在 `DirectSyncCursorPolicy` 里，这里不另写一份。
        let needsContinuation = DirectSyncCursorPolicy.continuationNeeded(
            hasMorePages: hasMorePages,
            receipt: receipt,
            deletionOnlyPage: false,
            requiresReceipt: requiresReceipt
        )
        if case let .hold(reason) = cursorDecision {
            // §10.2 / §5.1：没有 durable committed receipt 就**不提交**候选游标 ——
            // 提交了它，这一页覆盖的那段窗口再也不会被重读（与 `mayAdvanceAnchor` 同一条纪律，
            // 只是这次的"没读到"换成了"没被确认"）。
            //
            // 具体动作：
            //   1. `anchor` / `recordCursors` **一个字都不写**：不调用 `commitSuccess`，
            //      那一行连同它的候选游标原样留在盘上等下一轮确认；
            //   2. 回执与"仍需续接"写进那一行（§10.1 的「重启丢进度：从主库 receipt /
            //      analysis jobs 恢复」），且这条写入**不认领**后台待办意图
            //      （见 `persistPendingReceipt` 与 `saveTask` 的区别）；
            //   3. 报告**按理由分流** —— `.hold` 的四种理由里只有一种是真的"没成"。
            //
            // 🔴 `cursorHoldThisRound` 必须置：`performSync` 的收尾兜底用
            // `lastError == nil && phase != failed/cancelled` 判"这一轮结了没有"，而闸门拦下的
            // 一轮**既没失败、也没结** —— 那个判据里表达不出来。不置它，兜底会把任务行连同
            // 候选游标一起清掉，界面还会改口说"同步成功"。
            cursorHoldThisRound = true
            // ⚠️ 下面四处赋的是 `self.message`（**给人看**的那句），不是形参 `message`：
            // 形参只是"调用方那句话"的来源，本分支在函数收尾之前就 `return`，
            // 改形参没有任何读者（2026-10-13：这四处写成 `message = …` 直接编译不过）。
            switch reason {
            case DirectSyncCursorPolicy.notCommittedReason:
                // 回执**明确**说这一批的事实还没提交（`receiving` / `validating` / `applying`，
                // 或 `rejected`）：这是真的"没成"，如实报成失败态。
                lastError = Self.uncommittedBatchText
                self.message = lastError
                phase = SyncPhase.failed.rawValue
            case DirectSyncCursorPolicy.noReceiptReason,
                 DirectSyncCursorPolicy.serverContractMissingReason:
                // 这两种**不是失败**（§10.1：COMMIT 后回复丢失 ⇒ 查询同一回执、返回同一成功）：
                // 服务端要么已经收下并提交了这一批、只是回执没带（`serverContractMissing` 走到
                // 这里时 `receipt.isCommitted` 已经为真），要么客户端一个回执都没拿到。
                // 所以**不置 `lastError`、不置 `failed`**：§14.2 A17 要求 raw COMMIT 之后界面
                // 能说"已保存 / 分析更新中"，一句失败会把它盖掉 —— 那等于客户端替服务端
                // 否认一条**已经落盘**的事实。`phase` 也不动：这一轮既没有结，也没有失败。
                if receipt?.isCommitted == true {
                    // 主句仍是调用方那句 §10.3 文案（已提交 ⇒ 事实那一半是真的），
                    // "游标保留待确认"只做**尾注**，不抢主语。
                    self.message = message + Self.cursorHoldNote
                } else {
                    // 一个回执都没有：只说"没被确认"，不说"失败"—— 这件事没有被证伪。
                    self.message = Self.unconfirmedBatchText
                }
            default:
                // `blocked`：上游 `mayCommit` 已经拦过一次，这里用**同一句话**兜底。
                lastError = Self.blockedCommitText
                self.message = lastError
                phase = SyncPhase.failed.rawValue
            }
            persistPendingReceipt(receipt, needsContinuation: needsContinuation)
            return
        }
        let watermark = SyncStateCommitPlan.watermark(
            advance: advanceWatermark,
            clear: clearWatermark,
            exportEnd: exportEnd
        )
        // B01：候选与任务行删除**同一事务**落盘（见 `commitSuccess` 的 `routeSettlement`）。
        // 编码失败 ⇒ 传 `nil`，宁可这一轮不结算（待办保留、下轮重读）也不写半份证据。
        let routeSettlement = routeCommit.flatMap { try? JSONEncoder().encode($0) }
        let committed = HealthSyncBackgroundRecovery.persistThenAcknowledge(
            checkpoint: .syncCommitted,
            persist: { taskStore.commitSuccess(scope: activeScope, anchor: anchor, watermark: watermark, recordCursors: recordCursors, pendingDeletions: pendingDeletions, continuationPending: needsContinuation, routeSettlement: routeSettlement, routeSettlementBatchId: routeCommit?.batchId ?? "") },
            acknowledge: { checkpoint in
                // §10.2「连续分页尚未 drain 完时，不清空后台待办意图」：认领了它，用户不打开
                // App 就再也没人接着发下一批。`persistThenAcknowledge` 因此**不再**无条件确认，
                // 判据就在这一行。
                guard !needsContinuation else { return }
                acknowledgeBackgroundIntent(checkpoint: checkpoint)
            }
        )
        guard committed else {
            throw SyncHTTPError(message: taskStore.lastError ?? "同步进度未能保存")
        }
        // 🔴 游标**已经提交**（上面那个 `guard`），所以从这里往下都不再影响"事实已保存"这个结论。
        // 把"这一批的分析任务"写进**独立于任务行**的对账槽：`commitSuccess` 刚刚把任务行删了，
        // 而分析终态要在提交**之后**才去问 —— 结论必须落在一个活得比任务行长的地方。
        recordPendingAnalysisReconcile(receipt: receipt, job: job)
        // 🔴 「降频记忆」只能在**这次同步已经被判定成功之后**落盘，而且必须排在
        // `commitSuccess` 之后。反过来的话会出现一个不可自愈的窗口：状态机把某个 workout
        // 记成"已稳定、可以少查"，而这一批数据**从未真正交付到服务端**（上传失败、导入失败、
        // 或进程在导入中途被杀）。之后它一路降到 `settled`，服务端要等低频重新发现才能
        // 收到这条轨迹，界面却一直显示同步成功。
        // 反过来（提交成功、记忆没写上）只损失一次"下次再多查一遍"，且下一轮会自己补上。
        //
        // 写失败**不**让本次同步变红：durable 的部分（水位 + 进度）已经提交，这里失败的后果
        // 只是"下一轮重查一次"。但也不静默——`upsertRouteStates` 会把原因推进
        // `taskStore.lastError`，并由 `SQLiteSupport.report` 打出带错误码的日志。
        //
        // 🔴 R03（2026-10-16 复查）：路线状态落盘 + 待办移除 = **同一个本地短事务**
        //（`upsertRouteStates(removePendingTodos:)`）。旧形态是两次独立写：状态落盘失败
        // 只 NSLog、待办照删 —— 那条"读取失败"的路线既没有状态又没了待办，而**无状态行**的
        // UUID 只能靠待办队列被发现（`rediscoveryCandidates` 只遍历已有状态行）⇒ 永久不可
        // 发现。现在状态写不进去 ⇒ 整个事务回滚 ⇒ 待办原样保留（下批重查，幂等）。
        //
        // 🔴 B01（2026-10-17）：结算入口只有 `settlePendingRouteCommit()` —— 它读的是刚写进
        // `sync_route_settlements` 的候选，与"下次启动补结算"走**同一条**代码路径。
        // 这样"提交成功 → 崩溃 → 重启"与"提交成功 → 当场结算"不可能分叉。
        // 结算失败时**保留候选**（不抛错）：durable 的部分已经提交，这里失败的后果只是
        // 下一轮少一次 HealthKit 重读，而不会把一次已保存的同步报成失败。
        settlePendingRouteCommit()
        // P0-4：workout 补齐窗口的**结算**（重试时刻/样本数/收口），排在 `commitSuccess` 之后。
        // 写失败不让本次同步变红：durable 的部分已经提交，这里失败的后果只是窗口下批重跑
        // 一次（服务端按 UUID 幂等）；但**不静默** —— 留一条带原因的诊断。
        if !workoutWindowUpdates.isEmpty,
           !taskStore.upsertWorkoutBackfillWindows(workoutWindowUpdates, scope: activeScope) {
            NSLog("[RAI] workout 补齐窗口结算失败（下批重试）：%@",
                  taskStore.lastError ?? "unknown")
        }
        // P0-6 / P2-3：回执计数只用于展示，**不参与任何提交判据**。
        // 老服务端没有 `records` 字段 ⇒ 三个计数保持 nil（绝不编造 0）。
        if let summary = lastExportSummary, let counts = receipt?.records {
            lastExportSummary = summary.withReceiptCounts(
                parsed: counts.parsed, inserted: counts.inserted, unchanged: counts.unchanged
            )
        }
        // `hasPendingTask` 只在**真的清掉了那一行**之后才翻 —— 它现在与 `clearTask()` 同为
        // 日志清空点，两处是判据要求的全部（多一处就等于界面可以凭空说"没有待办了"）。
        hasPendingTask = false
        // 老键只在**提交成功之后**删：迁移期回退读的正是它们，先删就等于把回退路径拆掉。
        // 老键存在与否同时是"这一 scope 还没迁移"的判据（见 `loadCommittedState`）。
        UserDefaults.standard.removeObject(forKey: scopedKey(Self.lastWorkoutAnchorKey))
        UserDefaults.standard.removeObject(forKey: scopedKey(Self.lastExportEndKey))
        let now = Date()
        // 下面这三个键**刻意留在 `UserDefaults`**：它们丢了都无害（只影响展示与 15 分钟节流），
        // 而搬进来会顺带改掉它们的 scope 语义 —— `lastAutoSyncKey` 用的是 `urlScope`
        // （去端口去 path/query），其余用 `activeScope`，统一 key 会**静默**改掉节流窗口。
        if let activeServerURL {
            UserDefaults.standard.set(now, forKey: scopedKey(Self.lastAutoSyncKey, scope: Self.urlScope(for: activeServerURL)))
        }
        UserDefaults.standard.set(now, forKey: scopedKey(Self.lastSyncAtKey))
        // Only advance a count that is actually known: a restored task carries the
        // count of the run it is finishing, and writing the `0` stand-in for "no
        // count available" would replace a real number with a wrong one.
        if recordWorkoutCount {
            UserDefaults.standard.set(workoutCount, forKey: scopedKey(Self.lastWorkoutCountKey))
            lastWorkoutCount = workoutCount
        }
        lastSyncAt = now
        lastError = nil
        self.message = message
        dataUpdatedGeneration += 1
        phase = SyncPhase.succeeded.rawValue
    }

    /// B01：把导出结果折成**可持久、可结算**的路线候选。
    ///
    /// 为什么在这里装配而不是在导出层：scope 与 `payloadHash`（批次身份）都是同步层的
    /// 事实，导出层刻意不碰身份（它只描述"看到了什么"）。
    ///
    /// ⚠️ `states` 传的是 `exported.routeStates`（**已完整观测**的下一状态），
    /// `completedRouteTodos` 只包含"原本在待办队列里、且本轮 `observation` 成功"的 UUID ——
    /// 读取失败（`.unreadable`）与预算拒绝（`.budgetDeferred`）都不进这两个集合。
    private static func routeCommitCandidate(
        scope: String, batchId: String, exported: HealthKitExportResult
    ) -> RouteCommitCandidate? {
        // 一轮既没有观测、也没有待办要结算 ⇒ 没有候选（不占用结算槽，也不改动旧槽）。
        guard !exported.routeStates.isEmpty || !exported.completedRouteTodos.isEmpty else {
            return nil
        }
        return RouteCommitCandidate(
            scope: scope,
            batchId: batchId,
            states: exported.routeStates,
            completedTodoUUIDs: exported.completedRouteTodos,
            discoveryCursor: exported.routeDiscoveryCursor
        )
    }

    /// P1-1：把服务端覆盖响应归一成 `SyncCoveragePolicy` 的纯值表。
    ///
    /// 只做"字符串 → Date"的解析与类型桥接；**判据**（下界怎么算、什么时候不用）全部住在
    /// 纯逻辑 `SyncCoveragePolicy`（可被回归编译，本文件不被任何回归编译）。
    private static func coverageTable(
        from response: SyncCoverageResponse
    ) -> [String: SyncCoveragePolicy.TypeCoverage] {
        var table: [String: SyncCoveragePolicy.TypeCoverage] = [:]
        for entry in response.types {
            table[entry.type] = SyncCoveragePolicy.TypeCoverage(
                type: entry.type,
                knownUntil: SyncCoveragePolicy.parseTimestamp(entry.knownUntil),
                sampleCount: entry.sampleCount
            )
        }
        return table
    }

    /// P2-3：把本批通道计数写进日志（**只写计数**，不写样本值/UUID/日期）。
    ///
    /// 为什么值得一条固定格式的日志：诊断时"每批 4500 条里谁占的"只能从服务端
    /// `insertedRecordCount` 反推，而那个数字连类型都不带。有了这一行，重放/窗口/补读/
    /// workout 窗口各写了多少条、本批几个类型在重放，可以直接从设备日志读出。
    private static func logExportCounts(_ counts: ExportChannelCounts, scope: String) {
        NSLog("[RAI] 本批通道计数 scope=%@ %@", scope, counts.logLine)
    }

    /// P2-3：导出结果 → UI 只读摘要（回执计数在 `markSuccess` 里补齐）。
    private static func exportSummary(from exported: HealthKitExportResult) -> ExportSummary {
        ExportSummary(
            recordCount: exported.recordCount,
            workoutCount: exported.workoutCount,
            routeCount: exported.routeCount,
            deletionCount: exported.deletionCount,
            budgetStopReason: exported.budgetStopReason?.rawValue,
            hasMorePages: exported.hasMorePages,
            workoutWindowCount: exported.channelCounts.workoutWindows,
            workoutWindowCompletedCount: exported.channelCounts.workoutWindowsCompleted,
            updatedAt: Date()
        )
    }

    /// B01：只凭**本地**结算候选补完上一批的路线结算。
    ///
    /// 它不读 HealthKit、不上传、不动水位 —— 唯一动的是 `sync_route_state` 与
    /// `sync_pending_routes`，两者在 `upsertRouteStates` 的**同一个事务**里同进同退。
    ///
    /// 两条调用路径共用它（这是刻意的）：
    ///   * `markSuccess` 提交成功之后当场结算；
    ///   * `performSync` 开头补上一次"提交成功但进程被杀"留下的候选（§3.2 步骤 8）。
    ///
    /// 失败方向：
    ///   * 候选解不开 ⇒ 清掉它（留着只会每次启动重试同一份坏数据），待办**保留**；
    ///   * 结算无内容（全缺证明）⇒ 清掉候选，待办保留（下一轮重新观测）；
    ///   * 事务失败 ⇒ **保留候选**，下次再来（不重读 HealthKit）。
    @discardableResult
    private func settlePendingRouteCommit() -> Bool {
        guard let data = taskStore.loadRouteSettlement(scope: activeScope) else { return false }
        guard let candidate = try? JSONDecoder().decode(RouteCommitCandidate.self, from: data) else {
            NSLog("[RAI] route settlement payload unreadable; dropping it (todos stay queued)")
            taskStore.clearRouteSettlement(scope: activeScope)
            return false
        }
        let settlement = RouteCommitSettlement.settle(candidate, scope: activeScope)
        if !settlement.unproven.isEmpty {
            // 缺观测的 UUID **不移除**：它们留在待办队列里由下一轮重新发现。
            NSLog(
                "[RAI] route settlement kept %d todo(s) without observation (batch %@)",
                settlement.unproven.count, candidate.batchId
            )
        }
        guard !settlement.isEmpty else {
            taskStore.clearRouteSettlement(scope: activeScope)
            return false
        }
        guard taskStore.upsertRouteStates(
            settlement.states, scope: activeScope,
            discoveryCursor: settlement.discoveryCursor,
            removePendingTodos: settlement.removals
        ) else {
            NSLog("[RAI] route settlement failed (batch %@): %@",
                  candidate.batchId, taskStore.lastError ?? "unknown")
            return false
        }
        taskStore.clearRouteSettlement(scope: activeScope)
        return true
    }

    // MARK: 分析终态对账（§10.2「分析另行跟踪」/ §10.3 后两句文案）

    /// 把"这一批的分析任务"写进**对账槽**（`SyncTaskStore.sync_analysis_reconcile`）。
    ///
    /// 为什么此刻才写、且写在**提交之后**：`commitSuccess` 已经在同一个事务里把任务行删了
    /// （`SyncTaskStore.commitSuccess` 自述"要么都成、要么都不成"），所以从这一行往下，
    /// 盘上唯一还记得"这批分析要跟踪"的地方就是本槽。写在提交**之前**是不行的：
    /// 那一轮的游标还没被确认，事实那一半还没有结论，对账槽会先于事实对外说"已保存"。
    ///
    /// 回执里的 `analysisJobId` 由服务端给出（`ImportJobResponse.summary.analysisJobId`）：
    /// * 非空 ⇒ 这是一条要跟踪的分析任务；
    /// * `null` ⇒ 服务端如实回答"本批不登记分析任务"（`record-only`）⇒ 没有要跟踪的东西；
    /// * 缺键（`nil`）⇒ 老服务端 / 旧候选链路，同样不跟踪。
    ///
    /// 写失败**不抛错**（这是展示/跟踪的记账，不是同步的一部分）：只在日志里留一条。
    /// 让一次**已经成功**的同步因为一句"待对账"没写上而变红，是 §14.2 A17 明确禁止的方向。
    private func recordPendingAnalysisReconcile(receipt: DirectSyncReceipt?, job: ImportJobResponse?) {
        guard let receipt, let jobId = job?.summary?.analysisJobId, !jobId.isEmpty else { return }
        let payload = DirectSyncAnalysisReconcile(
            receiptId: receipt.receiptId,
            ingestStatus: receipt.ingestStatus,
            analysisStatus: receipt.analysisStatus,
            analysisJobId: jobId,
            observedAt: Date()
        )
        guard let data = try? JSONEncoder().encode(payload),
              taskStore.saveAnalysisReconcile(data, scope: activeScope) else {
            NSLog("[RAI] analysis reconcile slot write failed: %@", taskStore.lastError ?? "unknown")
            return
        }
    }

    /// 收尾之后**一次**有界的分析终态对账：问一次 `GET /v1/jobs/:id`，把终态落到对账槽并按它改口。
    ///
    /// ## 它为什么是现在这个样子
    ///
    /// * **只在本次同步已经收尾之后跑**（调用点在 `performSync` 的 `settled` 分支里）。
    ///   这一步是**展示/状态**对账，不是同步的一部分：§14.2 A17 的"raw COMMIT 后可显示
    ///   已保存"那一半已经由 `markSuccess` 定稿，对账只允许在它**之后**改一句结论。
    /// * **一次同步最多一次请求，失败即放弃，不重试、不阻塞**。所以这里没有循环、
    ///   没有 `withRetry`：一个跑不动的对账不该拖住用户的下一次同步，也不该把一次
    ///   成功的同步拖成超时。
    /// * **任何失败都不置 `phase` / `lastError`**：对账拿不到终态的正确表现是"这句结论
    ///   暂时维持不变"（界面继续说「分析更新中」），而不是"同步失败"。这条区分是整轮的要害：
    ///   把一次成功的同步报成失败，比暂时少说一句"分析已更新"严重得多。
    /// * **不改写回执**（§8.5）：回执没有被碰过，这里改的只是对账槽与自己重算的 `message`。
    ///
    /// ⚠️ 已知边界（如实写下来，不在本轮假装解决）：重启之后 `message` 是空的
    /// （它是 `@Observable` 的 runtime 字段），所以"重启后接着对账"要等**下一次同步收尾**
    /// 才会把结论重新说给用户听。对账槽已经把 `receiptId` / `analysisJobId` 存下来了，
    /// 那一步需要的全部信息都在；今天缺的只是一个"冷启动主动对账"的触发点。
    private func reconcilePendingAnalysis(serverURL: URL, apiToken: String) async {
        guard let data = taskStore.loadAnalysisReconcile(scope: activeScope),
              let pending = try? JSONDecoder().decode(DirectSyncAnalysisReconcile.self, from: data),
              pending.needsReconcile, let jobId = pending.analysisJobId else { return }
        // 回执本体没有落盘（`SyncTaskState` 那一行已经随任务清掉了），所以这里按对账槽的
        // 事实重建一份**只用于判据**的回执。它只喂给 `reconcileAnalysis`，不写回任何地方 ——
        // §8.5 说的"消费者不得改写回执"因此仍然成立：我们改的是**副本**。
        // `publishedReleaseId` / `parentBatchId` 用不上（它们不参与分析终态判据），如实填 `nil`。
        let receipt = DirectSyncReceipt(
            ingestStatus: pending.ingestStatus,
            receiptId: pending.receiptId,
            analysisStatus: pending.analysisStatus,
            dependencyGeneration: nil,
            publishedReleaseId: nil,
            parentBatchId: nil
        )
        let status: NativeJobStatus
        do {
            status = try await api.job(id: jobId, baseURL: serverURL, token: apiToken)
        } catch {
            // 拿不到就**什么都不做**：不写槽、不改口、不报错。日志留一条是为了将来
            // "为什么一直停在分析更新中"能查到是网络还是任务真的还在跑。
            // `startedAtMs` 之类的诊断信息这里刻意不打：日志不该出现任务 id 之外的载荷。
            NSLog("[RAI] analysis reconcile request failed (job %@): %@", jobId, String(describing: error))
            return
        }
        // `jobFailed` 的来源：服务端在读侧对失败任务给 `error.code = "task_failed"`
        // （`apps/api/src/data.ts` 的 `mapJobFromDomain`）。**不能**只用 `status == "failed"` 推：
        // 「用户取消」与「执行失败」在服务端都是任务停下来了，而 §10.1 只允许把后者说成
        // "分析更新失败，可重试分析"。
        let jobFailed = status.error?.code == "task_failed"
        guard let reconciled = DirectSyncCursorPolicy.reconcileAnalysis(
            receipt: receipt, jobStatus: status.status, jobFailed: jobFailed
        ) else { return }

        var updated = pending
        updated.analysisStatus = reconciled
        updated.observedAt = Date()
        if let encoded = try? JSONEncoder().encode(updated) {
            // 写失败只是"下次还要再问一遍"，同样不许影响这次同步的结论。
            if !taskStore.saveAnalysisReconcile(encoded, scope: activeScope) {
                NSLog("[RAI] analysis reconcile slot update failed: %@", taskStore.lastError ?? "unknown")
            }
        }
        // 重新算那句话：`markSuccess` 传进来的是**提交前**算好的那一句（当时只能看到
        // `queued`），终态到达之后它必须改成 §10.3 的后两句之一。走**同一个**入口
        // （`directSyncCompletionBase` → `DirectSyncCursorPolicy.notice(for:)` → `DirectSyncCopy`），
        // 所以"哪种回执说什么话"仍然只有一份判据，这里不另写映射。
        if let base = directSyncCompletionBase(receipt: receipt, reconciledAnalysisStatus: reconciled) {
            message = base
        }
    }

    /// 阻塞态兜底：与 `markSuccess` 开头那道 `mayCommit` 守卫用**同一句话**
    /// （走到这里说明调用点漏了阻塞态的前置返回）。
    private static let blockedCommitText = "同步正在等待设备解锁或等待重新登录，本次不推进导出水位。"

    /// `.hold` 的**尾注**（不是主句）：这一批的游标还留着，下次同步接着确认。
    ///
    /// 它只做尾注的理由见 `.hold` 的 `noReceiptReason` / `serverContractMissingReason` 分支：
    /// 事实可能**已经**落盘，"游标待确认"是客户端的对账状态，不该抢"健康数据已保存"的主语。
    private static let cursorHoldNote = "（本批游标保留待确认，下次同步继续确认）"

    /// `.hold` 且**一个回执都没拿到**时的如实说法：没有失败，只是还没被确认。
    ///
    /// 🔴 不许写成"失败"：§10.1 把「COMMIT 后回复丢失」定义为"查询同一回执、返回同一成功"，
    /// 而不是错误。客户端手里没有回执 ≠ 服务端没有提交（这件事**没有被证伪**）。
    private static let unconfirmedBatchText = "本批健康数据还没有被服务端确认，游标已保留待下次确认"

    /// 回执**明确**说这批事实尚未提交（`receiving` / `validating` / `applying` / `rejected`）：
    /// 这一条才配叫"没成"，落失败态。
    private static let uncommittedBatchText = "服务端还没有提交本批事实，本批游标已保留待下次确认。"

    /// 把回执与「仍需续接」写进**已经存在**的任务行，且**不认领**后台待办意图。
    ///
    /// 与 `saveTask` 只差最后那一步，而那一步正是 §10.2 要求的：「连续分页尚未 drain 完时，
    /// 不清空后台待办意图」。`saveTask` 走的是 `persistThenAcknowledge(checkpoint: .taskPersisted)`，
    /// 它在任务落盘的同时把健康数据通知确认掉 —— 在**批次还没被服务端确认**的时候，那条通知
    /// 仍然代表"有一批数据没同步完"，认领了它，用户不打开 App 就再也没人接着发。
    ///
    /// 任务行必须已经存在：`markSuccess` 的每个调用点都在此之前 `saveTask` 过（恢复分支也是
    /// 先从盘上读出来的）。读不到就**什么都不写** —— 没有行可更新不是错误，硬造一行反而会
    /// 让"这一 scope 从未提交过"的判据（`loadCommittedState`）失真。
    ///
    /// 🔴 这里**不**碰 `hasPendingTask`：它不是"进度写点"（本函数也没有新增任何进度），
    /// 而在这个调用点上它必然已经是 `true`（新建路径由 `saveTask` 落，恢复路径由
    /// `performSync` 的 `hasPendingTask = restoredTask != nil` 落）。多一个写入点就等于
    /// 界面可以凭空说"还有一批没走完"——那条计数判据在
    /// `apps/ios/tests/check-background-capabilities.py` 里是按**写入点个数**钉死的。
    private func persistPendingReceipt(_ receipt: DirectSyncReceipt?, needsContinuation: Bool) {
        guard var task = loadTask() else { return }
        task.lastReceipt = receipt
        task.needsContinuation = needsContinuation
        // 单独一个字段而不是读 `lastReceipt?.analysisStatus`：`committed` 之后事实那一半就冻结了，
        // 而分析还在动（`queued → running → published`），T5 的对账会把新终态写在这里。
        task.lastAnalysisStatus = receipt?.analysisStatus
        guard let data = try? JSONEncoder().encode(task) else {
            NSLog("[RAI] pending receipt could not be encoded; the batch stays unconfirmed")
            return
        }
        guard taskStore.save(data, scope: activeScope) else {
            // 写不进去**不改变结论**：游标本来就没提交，任务行还在，下一轮照样会重新确认。
            // 只是这条回执的痕迹丢了 —— 如实记日志，不把整次同步改成"失败得更彻底"。
            NSLog("[RAI] pending receipt write failed: %@", taskStore.lastError ?? "unknown")
            return
        }
    }

    #if os(iOS)
    /// 服务端 `summary` → "这一批新增/更新了几次跑步"；零新增（或根本没有摘要）时返回 `nil`。
    ///
    /// 由调用方决定零新增时说什么，是因为两条收尾路径手上的信息不同：本轮导出那条看得到
    /// `HealthKitExportResult`（本轮读到了几条记录），而**续接 `jobId`** 那条只有服务端摘要
    /// —— 硬合成一个函数会让后者去伪造一份它没有的导出结果。
    private func importedSummaryText(job: ImportJobResponse) -> String? {
        guard let summary = job.summary else { return nil }
        let inserted = summary.insertedWorkouts ?? 0
        let updated = summary.updatedWorkouts ?? 0
        if inserted > 0 && updated > 0 { return "已从 Apple 健康导入 \(inserted) 次、更新 \(updated) 次跑步" }
        if updated > 0 { return "已更新 \(updated) 次跑步" }
        if inserted > 0 { return "已从 Apple 健康导入 \(inserted) 次跑步" }
        return nil
    }

    private func importMessage(exported: HealthKitExportResult, job: ImportJobResponse) -> String {
        // §10.2 / §10.3：**先看回执**。有回执就按回执说（"健康数据已保存…"这一族），
        // 没有回执（老服务端 / 旧候选链路）就**逐字**沿用今天的文案 —— 单一 `succeeded`
        // 不能被解释成"分析已完成"，也不能因为服务端没升级就改口。
        if let base = directSyncCompletionBase(receipt: job.summary?.directSync) {
            return exportMessage(base: base, exported: exported, notes: importCountNotes(job: job))
        }
        let base = importedSummaryText(job: job)
            ?? (job.summary == nil
                ? "已从 Apple 健康导入 \(exported.workoutCount) 次跑步"
                : (exported.recordCount > 0 || exported.deletionCount > 0
                    ? "已同步 Apple 健康记录" : "Apple 健康数据已是最新"))
        return exportMessage(base: base, exported: exported)
    }

    /// 续接一个**已在服务端跑完**的导入（`.waitJob` 分支）时的收尾文案。
    ///
    /// 与 `importMessage` 的差别只有零新增那一格：这条路上没有本轮的
    /// `HealthKitExportResult` 可看，所以只能说"已是最新"，不能替它编一句
    /// "已同步 Apple 健康记录"（那是给"本轮确实读到了记录但没有新增行"用的）。
    /// 回执那一格与 `importMessage` **共用**同一个入口（§10.2：所有恢复分支同一套回执规则）。
    private func resumedImportMessage(job: ImportJobResponse) -> String {
        if let base = directSyncCompletionBase(receipt: job.summary?.directSync) {
            return DirectSyncCopy.composed(base: base, notes: importCountNotes(job: job))
        }
        return importedSummaryText(job: job) ?? "Apple 健康数据已是最新"
    }

    /// 恢复分支（`.inspect` 续接 / 续传已落盘的批次）走到 `waitForJob` 成功之后的收尾文案。
    ///
    /// §10.2 的「所有恢复分支都处理相同 receipt 规则，不能只改新建同步入口」就落在这里：
    /// 这两条分支今天各自说一句"已从…恢复"，那在回执缺席时是**唯一**能说的话（逐字保留），
    /// 而一旦拿到回执，就该与新建入口说同一套话。
    private func resumedBranchMessage(fallback: String, job: ImportJobResponse) -> String {
        guard let base = directSyncCompletionBase(receipt: job.summary?.directSync) else { return fallback }
        return DirectSyncCopy.composed(base: base, notes: importCountNotes(job: job))
    }

    /// 回执（可带一次对账到的分析终态）→ §10.3 的收尾**主句**；`nil` = 不说（没有回执 /
    /// 事实还在收 / 回执被拒），调用方必须沿用今天的文案。
    ///
    /// 形参刻意是 `DirectSyncReceipt` + 一个**可选的分析状态覆盖**，而不是整个
    /// `ImportJobResponse`：回执里的 `analysisStatus` 是服务端 **COMMIT 时刻**的快照
    /// （`apps/api/src/direct-sync-ingest.ts` 写 `queued`），真正到 `published` / `failed`
    /// 要等分析跑完 —— 那一步由 task-5 的**对账**提供（`markSuccess` 之后一次有界的终态查询）。
    /// 收尾文案只认状态，谁拿到终态谁喂进来，本层不负责去挖。
    ///
    /// ⚠️ 今天的生产路径上 `reconciledAnalysisStatus` 恒为 `nil`，而回执本身在 COMMIT 时只会是
    /// `queued` / `not_required` ⇒ `analysisPublished` / `savedAnalysisFailed` 两句**今天不可达**。
    /// 它们是 §10.3 要求的三句之二，**不要因为"没人走"就删掉**：对账落地后由它喂进来。
    private func directSyncCompletionBase(
        receipt: DirectSyncReceipt?,
        reconciledAnalysisStatus: DirectSyncAnalysisStatus? = nil
    ) -> String? {
        // 对账喂进来的终态要过**同一个** `notice(for:)`：把分析状态替换进一份回执副本，
        // 于是"哪种回执该说什么"只有 T2 那一份判据（`DirectSyncNotice`），本层只负责
        // "通知 → §10.3 的句子"。两处各判一次，迟早会分叉。
        let effective: DirectSyncReceipt?
        if let receipt, let reconciledAnalysisStatus {
            effective = DirectSyncReceipt(
                ingestStatus: receipt.ingestStatus,
                receiptId: receipt.receiptId,
                analysisStatus: reconciledAnalysisStatus,
                dependencyGeneration: receipt.dependencyGeneration,
                publishedReleaseId: receipt.publishedReleaseId,
                parentBatchId: receipt.parentBatchId
            )
        } else {
            effective = receipt
        }
        guard let notice = DirectSyncCursorPolicy.notice(for: effective) else { return nil }
        return DirectSyncCopy.completionCopy(for: notice)
    }

    /// 尾注：本批"导入/更新了几次跑步"。
    ///
    /// 它**只能是尾注**：§10.3 要求结论说"健康数据已保存"这一族，把计数与"分析是否更新"
    /// 混成同一个结论正是这一节要移除的旧语义。没有摘要（老服务端）时给出空数组。
    private func importCountNotes(job: ImportJobResponse) -> [String] {
        [importedSummaryText(job: job)].compactMap { $0 }
    }

    private func latestMessage(base: String, warnings: [String]) -> String {
        guard !warnings.isEmpty else { return base }
        return "\(base)（\(warnings.joined(separator: "；"))）"
    }

    /// The line for a finished export, with the empty case named.
    ///
    /// HealthKit answers a *refused* read request exactly like an authorized one
    /// with nothing in it: no error, no warning, an empty archive. `readAuthorizationState`
    /// can only catch the "never asked" case — once the user has answered, allowed
    /// or refused, the status reads `.unnecessary` either way. So when the export
    /// comes back with nothing at all, the honest move is to name the possibility
    /// rather than report "已是最新" over data the app may never have been allowed
    /// to see.
    ///
    /// - Parameter notes: 结论之外的尾注（本批计数）。与 `warnings` 处在**同一对括号**里，
    ///   否则"健康数据已保存，分析更新中（3 次跑步）（一条告警）"会套两层括号。
    private func exportMessage(base: String, exported: HealthKitExportResult, notes: [String] = []) -> String {
        // `routeCount` 自 T1（按 workout 定频）起语义为「本轮**实际查询到**的 workout 数」，
        // 不再等于「窗口内有轨迹的 workout 数」；降频后它必然偏小，但这**不是 bug**。
        // 此处只把三者当成「这一轮有没有读到任何东西」的判据（任一非 0 即非空导出），
        // 所以偏小的值不会误报。⚠️ 将来若要展示「导出了几条轨迹」，**不要**直接读这个字段
        // —— 它会给出一个偏小的数且不报错。详见 `HealthKitExportResult.routeCount` 的声明注释。
        let budgetNotes = exported.budgetStopReason.map {
            [Self.budgetStopNote($0, hasMorePages: exported.hasMorePages)]
        } ?? []
        guard exported.workoutCount == 0, exported.recordCount == 0, exported.routeCount == 0,
              exported.deletionCount == 0 else {
            return latestMessage(base: base, warnings: notes + exported.warnings + budgetNotes)
        }
        return latestMessage(base: base, warnings: notes + exported.warnings + budgetNotes + [Self.emptyExportHint])
    }

    /// 本批被单批预算截断的原因（P2c 可观测，2026-10-15 审查 🟡-A6）。
    ///
    /// 截断是**设计行为**（分批），但此前完全不可见：用户只看到"同步继续转"，
    /// 分不清"正常分批推进"与"卡在收敛耗尽"。作为尾注与计数同处一对括号
    /// （格式与既有 warnings 一致），只在**发生截断的这一轮**出现。
    ///
    /// 🔴 2026-10-18（同步诊断 lane-ios §2.1/§5.5）：`.recordNone` 的旧文案是反话 ——
    /// 满载批（`hasMorePages == true`）里该类型明明写了 4500 条，却说"该类型本轮零进展"。
    /// 两者必须分开：
    ///   * 满载（`hasMorePages`）⇒「本批记录条数已满，剩余记录下一批继续」；
    ///   * 预算有余量却连一条都放不进（`hasMorePages == false`）⇒ 保留"该类型零进展"，
    ///     因为那种情形下它**确实**可能是权限/单条过大等真实原因。
    private static func budgetStopNote(
        _ reason: HealthKitExportResult.BudgetStopReason,
        hasMorePages: Bool
    ) -> String {
        switch reason {
        case .recordPage: return "本批达单批预算，记录按页截断，将分批继续"
        case .recordNone:
            // `.recordNone` = 收缩到 `limit == 1` 仍放不下。两种成因必须分开说：
            // 满载批是"整批满了"（正常分批），有余量时才是"该类型真的零进展"。
            return hasMorePages
                ? "本批记录条数已满，剩余记录下一批继续"
                : "单条记录放不进本批剩余预算，该类型本轮零进展"
        case .routeFile: return "轨迹文件放不进本批剩余预算，本轮未取新轨迹"
        case .workoutBytes: return "本批达单批预算，workout 按页截断，将分批继续"
        }
    }

    private static let emptyExportHint =
        "未读到任何健康数据：若你曾在权限弹窗点过「不允许」，"
        + "请在 iPhone 设置 → 健康 → 数据访问与设备 中打开 RAI 的读取权限。"
    #endif

    /// 上传一批并处理失败。
    ///
    /// 与裸 `upload` 的区别只有一处，但它是 P1 的全部价值：**失败之后本批还能不能用**。
    /// 判据在 `SyncUploadRecovery`（纯函数、有执行者），这里的职责只是把它的结论落成动作。
    ///
    /// 大包上传不做**通用**重试（600s 超时 ×3 最坏阻塞 30 分钟，超过整个导入窗口，也远超
    /// iOS 后台任务的执行时限）。唯一的例外是并发占用：那是"现在不行"，值得当场让一次。
    private func uploadWithRecovery(zipURL: URL, payloadHash: String, to serverURL: URL) async throws -> String {
        do {
            return try await withRetry(attempts: 1) {
                try await self.upload(zipURL: zipURL, to: serverURL, payloadHash: payloadHash)
            }
        } catch {
            // 取消不是"这一批好不好"的证据，不参与分类。
            if error is CancellationError || (error as? URLError)?.code == .cancelled || Task.isCancelled {
                throw CancellationError()
            }
            let httpError = error as? SyncHTTPError
            // 🔴 凭证失效**先判**（文档 §3.3）：它既不该删批次（字节完好），也不该在后台
            // 无限重试（每次唤醒撞同一个 401）。落 `auth_required` 之后，唤醒它的是
            // "前台拿到有效凭证"，而不是时间。
            if SyncUploadRecovery.isCredentialFailure(statusCode: httpError?.statusCode) {
                phase = HealthSyncBlockedRecovery.phase(for: .credential).rawValue
                message = "登录状态已失效，请重新登录后继续同步"
                lastError = nil
                // 盘上那份任务的自述也要跟着改：只改内存变量的话，进程被杀之后"卡在等凭证"
                // 就没了痕迹，下次唤醒除了再撞一次 401 无事可做。
                // ⚠️ `SyncAtomicUnit.nextStep` 只看**字段**（`hasZip` / `hasMultipart`），
                // 所以盘上这个 phase 不改变恢复分支走哪条路 —— 它只是把"为什么停在这里"
                // 如实记下来（给界面与排查用），这也是文档要求"可持久表达的阻塞态"的落点。
                try? updateTask(phase: .authRequired)
                throw SyncCredentialRequiredError()
            }
            let action = SyncUploadRecovery.disposition(
                statusCode: httpError?.statusCode,
                errorCode: httpError?.code
            )
            switch action {
            case .abandonBatch:
                // 这一批的字节不得再被发送 ⇒ multipart（唯一用途是被发送）与 ZIP
                // （用途是重建 multipart 再发送）同时作废。**不是顺手删掉**。
                // 置位之后，失败收尾不会再把它登记成待续传批次 —— 否则每次同步都会
                // 拿同一份字节再撞一次，而服务端的拒绝是确定性的。
                abandonedBatch = true
                removeTaskArtifacts(payloadHash: payloadHash)
                throw error
            case .backOffAndRetry:
                // 并发占用：退避后**同 batchId** 再试一次（幂等键保证不会多出一份来源）。
                message = "服务端正在处理另一项上传，稍后自动重试"
                try? await Task.sleep(for: .seconds(5))
                try checkCancellation()
                do {
                    return try await withRetry(attempts: 1) {
                        try await self.upload(zipURL: zipURL, to: serverURL, payloadHash: payloadHash)
                    }
                } catch {
                    if error is CancellationError || (error as? URLError)?.code == .cancelled || Task.isCancelled {
                        throw CancellationError()
                    }
                    throw error
                }
            case .keepForNextWake:
                throw error
            }
        }
    }

    /// 构建 multipart 并上传。
    ///
    /// 🔴 这里**没有** `defer { removeItem(multipartURL) }`。原先有，那是"上传必须在本次调用内
    /// 结束"这个前提的产物；一旦字节归**系统**所有（P2-4 起走 background URLSession），
    /// 函数返回就删文件等于把续传能力一并删掉。这个文件的生命周期现在由**终结结果**决定：
    /// 成功由 `removeTaskArtifacts` 删，确定性坏批次由 `uploadWithRecovery` 删，
    /// 瞬时失败与生命周期中止留着给下次唤醒续传（续传用的 batchId 不变，服务端幂等命中）。
    ///
    /// 本函数返回**只代表"这次等待结束了"**，不代表"系统不再搬运这批字节"：生命周期中止会把
    /// 等待者摘掉而让传输继续（`RaiBackgroundUploadSession.abandonWaiting`）。所以"字节归谁"
    /// 的判据是 `RaiBackgroundUploadSession.hasInFlightUpload`，不是本函数有没有返回。
    private func upload(zipURL: URL, to serverURL: URL, payloadHash: String) async throws -> String {
        try checkCancellation()
        // boundary 由 `payloadHash` 派生 ⇒ 重建出来的 multipart 与上一次**逐字节相同**。
        // 随机 boundary 会让"重传"变成"一份看起来不同、内容相同的包"。
        let boundary = Self.multipartBoundary(for: payloadHash)
        try ensureArtifactFolder()
        let multipartURL = artifactURL(named: Self.multipartName(for: payloadHash))
        try await HealthSyncCancellation.runDetached(priority: .utility) {
            try writeHealthKitMultipart(zipURL: zipURL, boundary: boundary, to: multipartURL)
        }
        protect(multipartURL)
        try checkCancellation()

        var request = URLRequest(url: endpoint(serverURL, path: "/v1/imports/uploads"))
        addAuthorization(to: &request)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        // 幂等键恒等于 `payloadHash`（sha256 小写 hex，64 位，满足服务端正则
        // `import-routes.ts:42` 的 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`）。
        // 旧代码这里是 `try? fileHash(...)`：哈希失败就**静默地不发这个头**，
        // 于是服务端每次都新建一份来源 ⇒ 同一份数据被反复导入，且没有任何迹象。
        request.setValue(payloadHash, forHTTPHeaderField: "X-RAI-Sync-Batch")
        // 600 s 只对**前台**那条 `session` 有意义：后台 session 永远等待连通，等待期间
        // `timeoutIntervalForRequest` 不生效（`NSURLSession.h:769-771`），真正的约束是它的
        // `timeoutIntervalForResource`（1 小时，见 `RaiBackgroundUploadSession.makeSession`）。
        // 留着这一行不是残留：切回前台路径时它仍然是超时口径的唯一来源。
        request.timeoutInterval = 600
        // 🔴 先落盘"字节正要归系统所有"，**再**把字节交出去。次序反了就会出现一个窗口：
        // 字节已经在系统手上、而盘上还写着 `pending` —— 进程在那个窗口里被杀，下次唤醒会用
        // 同一个 batchId 再传一遍（幂等，白费一次带宽）。反过来（先写 `inFlight` 再交出去）
        // 最坏只是"盘上说在飞、其实没飞"，而那条路由 `clearStaleUploadState` 收尾。
        // 两个方向都不会写坏数据，所以把代价放在便宜的那一侧。
        //
        // 写失败**中止上传**（与 `saveTask` 的纪律一致：写不进去就不能推进网络动作）——
        // 一行进展都记不住的批次，传上去也没人能接住它。
        try updateTask(phase: .uploading, uploadState: .inFlight)
        let (data, response) = try await uploadToSystem(request, from: multipartURL, payloadHash: payloadHash)
        try checkCancellation()
        try throwIfNeeded(response, data: data)
        // 这里**不写** `uploadState = .completed`：调用方紧接着就会用
        // `updateTask(sourceId:phase: .uploaded, uploadState: .completed)` 把 `sourceId` 与自述
        // 一起落盘（`performSync` 的恢复分支与新建分支各一处）。在这里再写一次，既重复，
        // 又会在"上传成功但这次写失败"时制造一条与调用方不一致的中间态。
        return try JSONDecoder().decode(UploadResponse.self, from: data).sourceId
    }

    private func inspect(sourceId: String, on serverURL: URL) async throws -> InspectionResponse {
        try checkCancellation()
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/imports/inspect"))
        addAuthorization(to: &request)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["sourceId": sourceId])
        let (data, response) = try await session.data(for: request)
        try checkCancellation()
        try throwIfNeeded(response, data: data)
        return try JSONDecoder().decode(InspectionResponse.self, from: data)
    }

    private func startImport(sourceId: String, on serverURL: URL) async throws -> ImportJobResponse {
        try await HealthSyncMutationRetry.run(
            isConflict: { error in
                guard let error = error as? SyncHTTPError else { return false }
                return error.statusCode == 409 && error.code == "mutation_conflict"
            },
            onWait: { self.message = "服务端正在处理上一项任务，完成后将自动继续同步" },
            operation: { try await self.submitImport(sourceId: sourceId, on: serverURL) }
        )
    }

    private func submitImport(sourceId: String, on serverURL: URL) async throws -> ImportJobResponse {
        try checkCancellation()
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/import-jobs"))
        addAuthorization(to: &request)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["sourceId": sourceId])
        let (data, response) = try await session.data(for: request)
        try checkCancellation()
        if (response as? HTTPURLResponse)?.statusCode == 409 {
            if let active = try await activeImport(on: serverURL), active.sourceId == sourceId {
                return active
            }
        }
        try throwIfNeeded(response, data: data)
        return try JSONDecoder().decode(ImportJobResponse.self, from: data)
    }

    private func activeImport(on serverURL: URL) async throws -> ImportJobResponse? {
        try checkCancellation()
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/import-jobs/active"))
        addAuthorization(to: &request)
        request.timeoutInterval = 15
        let (data, response) = try await session.data(for: request)
        try checkCancellation()
        try throwIfNeeded(response, data: data)
        if data.isEmpty { return nil }
        return try JSONDecoder().decode(ImportJobResponse?.self, from: data)
    }

    private func deleteUpload(sourceId: String, on serverURL: URL) async throws -> Bool {
        try checkCancellation()
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/import-sources/\(sourceId)"))
        addAuthorization(to: &request)
        request.httpMethod = "DELETE"
        do {
            let (_, response) = try await session.data(for: request)
            try checkCancellation()
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            // 404 means the staging upload is already gone, which is the outcome
            // this call wants — only an uncompromising failure is worth reporting.
            return (200...299).contains(status) || status == 404
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled || Task.isCancelled {
                throw CancellationError()
            }
            // Deliberately not rethrown: the import already landed, and failing the
            // sync over an uncollected temporary would be a worse trade. The caller
            // says so in the message instead of dropping it on the floor.
            return false
        }
    }

    /// Appended when the server took the import but did not confirm deleting the
    /// staging upload. Harmless (it is reclaimed on the next sync) but not silent.
    private static let cleanupNoteSuffix = "（服务端临时上传源未清理，下次同步会回收）"

    private func waitForJob(id: String, on serverURL: URL) async throws -> ImportJobResponse {
        let started = ContinuousClock.now
        let deadline = started.advanced(by: .seconds(30 * 60))
        var idleFailures = 0
        while ContinuousClock.now < deadline {
            try Task.checkCancellation()
            // 🔴 **后台软预算**（`BackgroundRunPolicy.shouldYieldPolling`）：这一轮后台唤醒已经
            // 把它那份额度花掉了。轮询放弃是**零代价**的 —— `jobId` 已落盘，下一次唤醒走
            // `.resumeJob` 从同一处接着等；而继续占着额度只会撞上系统 expiration，被迫在
            // **半途**收手（那才是"写完一半 multipart 就断电"那种位置）。收手走
            // `suspendForLifecycle()`：它把 phase 落回**可续接**阶段，不是 `failed`、也不是
            // 用户取消 —— 与系统收回执行时间是同一条语义。判据在纯函数里，这里只接线。
            #if os(iOS)
            if BackgroundRunPolicy.shouldYieldPolling(
                isBackground: UIApplication.shared.applicationState != .active,
                backgroundStartedAt: backgroundPassStartedAt,
                now: Date()
            ) {
                Self.report("background pass: soft budget reached while polling the import job; yielding this round")
                suspendForLifecycle()
                throw CancellationError()
            }
            #endif
            do {
                let job = try await getJob(id: id, on: serverURL)
                try checkCancellation()
                idleFailures = 0
                // §10.3（S2.4）：只显示服务端的**受控文案**（`message`）。这里曾经有一个
                // `else if !job.phase.isEmpty { message = job.phase }` 的兜底 —— 它会把
                // `receiving`/`activate`/`backup` 这类**英文阶段 token** 原样上屏，而那是服务端的
                // 内部维护语义，不是给用户的话。message 为空时保持上一条文案（宁可停在上一句
                // 真实进度上，也不给用户一个实现细节）。反例夹具见
                // `check-background-mutations.py` 的 `[copy]` 组（写回兜底 ⇒ 门禁红）。
                if !job.message.isEmpty {
                    message = job.message
                }
                switch job.status {
                case "succeeded":
                    return job
                case "failed", "cancelled", "interrupted":
                    // 带上 code 再抛：恢复分支要靠它把「任务已终结」与「瞬时读不到」分开 ——
                    // 终结的任务拿同一个 jobId 再等只是重放同一个错误，那个 task 必须被放弃。
                    throw SyncHTTPError(message: job.error ?? "导入失败", code: HealthSyncResumePolicy.terminalJobCode)
                default:
                    try await Task.sleep(for: HealthSyncPolling.delay(elapsed: started.duration(to: .now)))
                }
            } catch is CancellationError {
                throw CancellationError()
            } catch let error as URLError where error.code == .cancelled {
                throw CancellationError()
            } catch let error as SyncHTTPError {
                let retryable = HealthSyncPolling.shouldRetryHTTP(statusCode: error.statusCode)
                if !retryable {
                    throw error
                }
                idleFailures += 1
                if idleFailures >= 8 {
                    throw error
                }
                message = "导入仍在进行，正在重新连接服务器"
                try await Task.sleep(for: .seconds(2))
            } catch {
                idleFailures += 1
                if idleFailures >= 8 {
                    throw error
                }
                message = "导入仍在进行，正在重新连接服务器"
                try await Task.sleep(for: .seconds(2))
            }
        }
        throw SyncHTTPError(message: "导入超时，请打开「数据与模型」查看任务状态")
    }

    private func getJob(id: String, on serverURL: URL) async throws -> ImportJobResponse {
        try checkCancellation()
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/import-jobs/\(id)"))
        addAuthorization(to: &request)
        request.timeoutInterval = 15
        let (data, response) = try await session.data(for: request)
        try checkCancellation()
        try throwIfNeeded(response, data: data)
        return try JSONDecoder().decode(ImportJobResponse.self, from: data)
    }

    private func endpoint(_ base: URL, path: String) -> URL {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false) ?? URLComponents()
        components.path = path
        components.query = nil
        components.fragment = nil
        return components.url ?? base
    }

    private func addAuthorization(to request: inout URLRequest) {
        if !activeToken.isEmpty { request.setValue("Bearer \(activeToken)", forHTTPHeaderField: "Authorization") }
    }

    private func withRetry<T>(
        attempts: Int = 3,
        operation: @escaping () async throws -> T
    ) async throws -> T {
        var lastError: Error?
        for attempt in 0..<attempts {
            try checkCancellation()
            do {
                return try await operation()
            } catch is CancellationError {
                // 取消不是可重试失败：否则会退避等待后再发一次请求，用户看到"点了取消仍在跑"。
                throw CancellationError()
            } catch let error as URLError where error.code == .cancelled {
                throw CancellationError()
            } catch let error as SyncHTTPError {
                if error.statusCode.map({ (400...499).contains($0) && $0 != 429 }) == true {
                    throw error
                }
                lastError = error
            } catch {
                lastError = error
            }
            if attempt < attempts - 1 {
                try await Task.sleep(for: .seconds(Double(1 << attempt)))
            }
        }
        throw lastError ?? SyncHTTPError(message: "请求失败")
    }

    private func throwIfNeeded(_ response: URLResponse, data: Data) throws {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            if let payload = try? JSONDecoder().decode(APIErrorMessage.self, from: data),
               let message = payload.message, !message.isEmpty {
                throw SyncHTTPError(message: message, statusCode: status, code: payload.code)
            }
            throw SyncHTTPError(message: "服务器返回 HTTP \(status)", statusCode: status)
        }
    }

    // MARK: 本地批次产物（ZIP 与 multipart）

    /// 批次产物一律放在 `Application Support/rai-healthkit-<scope>/`。
    ///
    /// 不能用 `/tmp`（系统会清理，而"续传"的全部前提就是字节还在），也不能用
    /// `Caches`（磁盘紧张时会被系统删）—— 两者的失效方式都是"某天起续传悄悄变成重导"。
    private func artifactFolder() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("rai-healthkit-\(activeScope)", isDirectory: true)
    }

    private func artifactURL(named name: String) -> URL {
        artifactFolder().appendingPathComponent(name)
    }

    private func ensureArtifactFolder() throws {
        try FileManager.default.createDirectory(at: artifactFolder(), withIntermediateDirectories: true)
    }

    /// 批次产物一律 `.completeUntilFirstUserAuthentication`，且不进备份。
    ///
    /// 不能用 `.complete`：锁屏后后台读不到文件，现象是**后台上传偶发
    /// `NSFileReadNoSuchFileError`、解锁后同一操作必成功** —— 最难查的一类不一致
    /// （`friendlyMessage` 里就有这条分支）。与 `CacheStore.swift:46-49`、
    /// `SyncTaskStore.swift:60-71` 保持一致。
    ///
    /// 排除备份的理由是体积：一次全量导出可以是好几个 GB，让 iCloud 备份多背一份
    /// "随时可以重新生成"的字节没有道理。
    private func protect(_ url: URL) {
        HealthSyncArchive.protect(url)
    }

    /// 删掉某一批的全部本地产物。
    ///
    /// 顺带删一次老名字（`upload.zip`）：它是历史版本的产物，留着只会在升级后
    /// 白占一份几个 GB 的空间，而这里是唯一会碰这些文件的地方。
    private func removeTaskArtifacts(payloadHash: String) {
        for url in [
            artifactURL(named: Self.zipName(for: payloadHash)),
            artifactURL(named: Self.multipartName(for: payloadHash)),
            artifactURL(named: Self.legacyZipName)
        ] {
            try? FileManager.default.removeItem(at: url)
        }
    }

    /// 丢掉**整个 scope** 的本地产物。
    ///
    /// 只在"进度读不出来"时用：文件名由 `payloadHash` 派生，而 `payloadHash` 正是
    /// 读不出来的那个字段 —— 没有别的途径能把它们对应回任何一批，留着就是永久孤儿。
    private func removeAllTaskArtifacts() {
        let folder = artifactFolder()
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return }
        for name in names where name.hasPrefix("upload-") || name == Self.legacyZipName {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(name))
        }
    }

    /// 按任务**记录的字段**解析出本地产物，不看目录里有什么。
    ///
    /// 两条纪律：
    ///   - `target` 必须与当前服务器一致 —— 否则会把 A 服务器的批次传给 B；
    ///   - 🔴 老 payload 只存了哈希、没存文件名（`zipFileName == nil`）。名字相同**不代表
    ///     批次相同**：旧 `persistZip` 是覆盖写，崩溃窗口里可能留下"新文件 + 老 task"。
    ///     所以这条回退路径必须校验哈希。代价是一次整文件哈希，且只在**升级时仍有在飞
    ///     任务**这一次付出 —— 其余情况全部靠文件名，零哈希。
    private func persistedZipURL(_ task: SyncTaskState) async throws -> URL? {
        guard task.target == activeServerURL?.absoluteString else { return nil }
        let file = task.zipFileName ?? Self.legacyZipName
        let url = artifactURL(named: file)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        if task.zipFileName == nil {
            do {
                guard try await HealthSyncArchive.fileHash(url) == task.payloadHash else { return nil }
            } catch {
                // 保持旧版本“校验失败不认领文件”的语义，但不能把取消吞成一次重新导出。
                try checkCancellation()
                return nil
            }
        }
        return url
    }

    /// multipart 的名字即使对老 payload 也是可推的（由 `payloadHash` 派生），
    /// 而老版本从来没有持久化过 multipart ⇒ 这条回退在升级场景下恒为 `nil`，不会误判。
    private func persistedMultipartURL(for task: SyncTaskState) -> URL? {
        guard task.target == activeServerURL?.absoluteString else { return nil }
        let file = task.multipartFileName ?? Self.multipartName(for: task.payloadHash)
        let url = artifactURL(named: file)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// 已提交的水位（anchor + 导出水位）。**这是唯一的读取点**，锚与水位的所有读者都走它。
    ///
    /// 真相在 `sync_state`（与任务进度同库同事务）；老 `UserDefaults` 键**只在迁移期**兜底。
    /// 回退判据是"这一 scope 在 `sync_state` 里**还没有行**"，不是"字段是不是空" ——
    /// `anchor` 与 `export_end` 各自都可以合法地是空值（`.keep` / `.clear`），
    /// 拿"值是不是空"当迁移判据，会把一次合法的"清空水位"误读成"还没迁移"从而把老值读回来。
    ///
    /// 「`sync_state` 有行 ⇒ 老键已被删」这条不变式由**写方**保证：`markSuccess` 在提交成功后
    /// 才删老键（`forgetState` 那条「全量重导」路径已于 2026-10-17 删除）。
    ///
    /// 🔴 **读失败必须阻塞，不能退化成"没有水位"**。旧实现返回 nil ⇒ `lowerBound = nil` ⇒
    /// 从零重取全部历史 —— 那是一条自动全量通道，与"永不自动清空游标"的边界冲突。
    /// 只有"确实没有行"（首装 / 换 scope）才是合法的无水位状态。
    private func loadCommittedState() throws -> SyncTaskStore.CommittedState? {
        let committed = taskStore.loadState(scope: activeScope)
        guard taskStore.lastError == nil else {
            throw HealthKitExportError.stateStoreUnreadable
        }
        if let committed { return committed }
        var legacy = SyncTaskStore.CommittedState()
        legacy.workoutAnchor = UserDefaults.standard.data(forKey: scopedKey(Self.lastWorkoutAnchorKey))
        legacy.exportEnd = UserDefaults.standard.object(forKey: scopedKey(Self.lastExportEndKey)) as? Date
        // 两个都没有 ⇒ 返回 nil，与"没有这一行"等价（首装）。
        return legacy == SyncTaskStore.CommittedState() ? nil : legacy
    }

    private func scopedKey(_ key: String) -> String {
        scopedKey(key, scope: activeScope)
    }

    private func scopedKey(_ key: String, scope: String) -> String {
        "\(key).\(scope)"
    }

    /// 预算收敛的**跨批记忆**（P1b/P2b）。
    ///
    /// 🔴 为什么必须独立于 task 行：这条记忆唯一发挥作用的时刻，正是我们**清掉 task 行**
    /// 的那一刻（服务端判定本批超上限 ⇒ 必须重导）。放进 `SyncTaskState` 就等于
    /// `clearTask()` 把"别再撞同一面墙"的记忆一起删掉，于是下一轮用满预算产出同一份
    /// 必被拒的产物 —— 每轮白读一遍 HealthKit（GB 级导出，整个流程最贵的一步）。
    /// 作用域与 task 同源（`activeScope` = 服务端 URL 指纹），换服务端不共享。
    /// B2：记录类型轮转起点（下一个应从哪个 `descriptors` 下标开始读）。
    /// 读不到/损坏 ⇒ 0（等价旧行为：固定从第一个类型开始）—— 轮转是**优化**，不是正确性，
    /// 所以这一侧的失败方向是"回退到旧行为"，而不是"拒绝同步"。
    private func loadRecordTypeRotation() -> Int {
        guard let value = UserDefaults.standard.object(forKey: scopedKey(Self.recordTypeRotationKey)) as? Int,
              value >= 0 else { return 0 }
        return value
    }

    private func saveRecordTypeRotation(_ index: Int) {
        UserDefaults.standard.set(index, forKey: scopedKey(Self.recordTypeRotationKey))
    }

    private func loadBudgetConvergence() -> DirectSyncBudgetConvergence {
        guard let data = UserDefaults.standard.data(forKey: scopedKey(Self.budgetConvergenceKey)),
              let stored = try? JSONDecoder().decode(DirectSyncBudgetConvergence.self, from: data) else {
            return .initial
        }
        return stored
    }

    private func saveBudgetConvergence(_ convergence: DirectSyncBudgetConvergence) {
        guard let data = try? JSONEncoder().encode(convergence) else { return }
        UserDefaults.standard.set(data, forKey: scopedKey(Self.budgetConvergenceKey))
    }

    /// 忘掉收敛（回到满预算）。调用点只有一处：用户显式「重新导入全部」。
    private func clearBudgetConvergence() {
        UserDefaults.standard.removeObject(forKey: scopedKey(Self.budgetConvergenceKey))
    }

    /// The SQLite journal is authoritative. Legacy UserDefaults data is read
    /// only for migration; a failed write must not advance a network operation.
    private func saveTask(_ task: SyncTaskState) throws {
        let data = try JSONEncoder().encode(task)
        let saved = HealthSyncBackgroundRecovery.persistThenAcknowledge(
            checkpoint: .taskPersisted,
            persist: { taskStore.save(data, scope: activeScope) },
            acknowledge: { checkpoint in
                // 🔴 与 `markSuccess` 的 §10.2 同源（R1，2026-10-15）：这份任务行自己写着
                // "还有页没读完"（`needsContinuation == true`）时，**不得**在 `.taskPersisted`
                // 上确认后台待办意图——确认掉之后没人再发下一批，剩下的页永远读不完。
                guard !(task.needsContinuation ?? false) else { return }
                acknowledgeBackgroundIntent(checkpoint: checkpoint)
            }
        )
        guard saved else {
            throw SyncHTTPError(message: taskStore.lastError ?? "同步进度未能保存")
        }
        UserDefaults.standard.removeObject(forKey: scopedKey(Self.taskKey))
        hasPendingTask = true
    }

    private func loadTask() -> SyncTaskState? {
        let decoder = JSONDecoder()
        let journal = taskStore.load(scope: activeScope)
        guard taskStore.lastError == nil else { return nil }
        let candidates: [Data] = [
            journal,
            UserDefaults.standard.data(forKey: scopedKey(Self.taskKey, scope: activeScope)),
            activeServerURL.flatMap { UserDefaults.standard.data(forKey: scopedKey(Self.taskKey, scope: Self.urlScope(for: $0))) }
        ].compactMap { $0 }
        var unreadable = false
        for data in candidates {
            // 🔴 `try?` 在这里是被**刻意**保留下来的：不是所有候选都必须解得出
            // （排在后面的老 UserDefaults 记录本来就可能是别的版本的）。但它不能被
            // 当成"没有任务" —— 那正是 R6 的形态：加一个非可选字段 ⇒ 整份任务解不开 ⇒
            // 老设备升级后首次同步做一次**全量重导**，而 `sync_tasks` 里那一行还在。
            guard let task = try? decoder.decode(SyncTaskState.self, from: data) else {
                unreadable = true
                continue
            }
            guard isCurrentTask(task) else { continue }
            if journal == nil && !taskStore.save(data, scope: activeScope) { return nil }
            return task
        }
        if unreadable {
            taskDecodeError = "发现一份由其他版本 App 写入的同步进度，无法读取，已按新任务重新开始。"
        }
        return nil
    }

    /// 丢掉一份**读不懂**的进度，连同它可能引用过的本地产物。
    ///
    /// 为什么要清：不清的话每次同步都会走到同一个错误上，变成永久失败。为什么可以清：
    /// 读得出来的信息只剩"某个版本的进度曾存在过"，里面的 `jobId` / `payloadHash`
    /// 一个都取不到 —— 留着也不可能续接。清掉之后下一次同步是干净状态。
    private func discardUnreadableTask() -> Bool {
        guard clearTask() else { return false }
        removeAllTaskArtifacts()
        return true
    }

    private func isCurrentTask(_ task: SyncTaskState) -> Bool {
        guard let activeServerURL else { return false }
        let context = HealthSyncBackgroundRecovery.Context(
            serverURL: activeServerURL.absoluteString,
            urlScope: Self.urlScope(for: activeServerURL),
            activeScope: activeScope,
            identity: activeIdentity.map {
                .init(
                    serverId: $0.serverId,
                    athleteId: $0.athleteId,
                    datasetEpoch: $0.datasetEpoch,
                    protocolVersion: $0.syncProtocolVersion,
                    syncScope: activeScope
                )
            }
        )
        return HealthSyncBackgroundRecovery.taskMatches(
            .init(
                target: task.target,
                serverId: task.serverId,
                athleteId: task.athleteId,
                datasetEpoch: task.datasetEpoch,
                protocolVersion: task.protocolVersion
            ),
            context: context
        )
    }

    /// 进度写入的**唯一**入口。
    ///
    /// 形参是 `SyncPhase` 而不是 `String`：阶段闭集的约束因此由编译器执行，而不是靠
    /// 评审时数清单 —— 后者在本仓已经失效过一次（同一份阶段名单被抄成三份）。
    private func updateTask(
        sourceId: String? = nil,
        jobId: String? = nil,
        phase: SyncPhase,
        uploadState: SyncUploadState? = nil
    ) throws {
        guard var task = loadTask() else { throw SyncHTTPError(message: "同步进度无法读取，已停止本次操作") }
        task.sourceId = sourceId ?? task.sourceId
        task.jobId = jobId ?? task.jobId
        task.phase = phase.rawValue
        if let uploadState { task.uploadState = uploadState }
        try saveTask(task)
    }

    @discardableResult
    private func clearTask() -> Bool {
        guard taskStore.clear(scope: activeScope) else {
            lastError = taskStore.lastError ?? "同步进度未能清理，下次连接将重新确认"
            phase = SyncPhase.failed.rawValue
            return false
        }
        UserDefaults.standard.removeObject(forKey: scopedKey(Self.taskKey))
        if let activeServerURL {
            UserDefaults.standard.removeObject(
                forKey: scopedKey(Self.taskKey, scope: Self.urlScope(for: activeServerURL))
            )
        }
        hasPendingTask = false
        return true
    }

    private static func urlScope(for url: URL) -> String {
        let canonical = ServerSession.canonicalURL(url)
        let digest = SHA256.hash(data: Data(canonical.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        return String(digest.prefix(24))
    }

    private static func syncScope(for url: URL, identity: RaiHandshake) -> String {
        HealthSyncIdentityPublisher.syncScope(for: url, identity: identity)
    }

    /// 用 Native 缓存里已有的离线握手恢复后台候选上下文。
    ///
    /// 这里不发网络请求，也不把离线身份当权威：`performSync` 开头仍回到 URL scope，并在真实
    /// handshake 成功后刷新 `activeScope`。它只让冷启动在决策前能看见正确 scope 下的任务。
    private func restoreBackgroundContext(for serverURL: URL) {
        #if os(iOS)
        let identity = CacheStore.loadHandshake(baseURL: serverURL)
        #else
        let identity: RaiHandshake? = nil
        #endif
        let recoveredIdentity = identity.map {
            HealthSyncBackgroundRecovery.Identity(
                serverId: $0.serverId,
                athleteId: $0.athleteId,
                datasetEpoch: $0.datasetEpoch,
                protocolVersion: $0.syncProtocolVersion,
                syncScope: Self.syncScope(for: serverURL, identity: $0)
            )
        }
        guard let context = HealthSyncBackgroundRecovery.context(
            serverURL: serverURL.absoluteString,
            urlScope: Self.urlScope(for: serverURL),
            identity: recoveredIdentity
        ) else { return }
        activeServerURL = serverURL
        activeIdentity = identity
        activeScope = context.activeScope
    }

    private func friendlyMessage(_ error: Error) -> String {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            return "网络中断。请检查 RAI 服务和网络后重试。"
        }
        if nsError.domain == NSCocoaErrorDomain && nsError.code == NSFileReadNoSuchFileError {
            return "本地健康导出文件已丢失，请再点一次「同步健康」。"
        }
        return error.localizedDescription
    }
}

private struct UploadResponse: Decodable {
    let sourceId: String
}

private struct InspectionResponse: Decodable {
    let status: String
}

private struct ImportJobResponse: Decodable {
    let id: String
    let sourceId: String?
    let status: String
    let phase: String
    let message: String
    let error: String?
    let summary: ImportJobSummary?
}

private struct ImportJobSummary: Decodable {
    let insertedWorkouts: Int?
    let updatedWorkouts: Int?
    /// §10.1 / §10.2 的持久回执。**可选**：老服务端不带这个键 ⇒ `nil` = 没有回执，
    /// 于是"游标推不推"由 `DirectSyncCursorPolicy` 决定，文案沿用今天的说法。
    /// 不许给它兜默认值：一份"看起来像回执"的合成物比没有回执危险得多。
    let directSync: DirectSyncReceipt?
    /// 本次分析任务 id，供 task-5 的分析终态对账使用（服务端在回执里带上它）。
    ///
    /// ⚠️ 本文件今天**不消费**它：对账入口由 task-5 接在 `markSuccess` 的提交**之后**
    /// （那一步不许污染"事实已保存"这个结论）。这里先解出来，是为了让服务端补上这个键
    /// 之后 iOS 侧不需要再改一次解码器 —— 未知键会被忽略，所以它在服务端落地前 `nil`。
    let analysisJobId: String?
}

private struct APIErrorMessage: Decodable {
    let message: String?
    let code: String?
}

private struct SyncHTTPError: LocalizedError {
    let message: String
    var statusCode: Int?
    var code: String?
    var errorDescription: String? { message }
}

// `SyncTaskState` 已搬到 `SyncTaskState.swift`：本文件不被任何回归脚本编译，
// 放这里的类型连"能不能读老 payload"都断言不了。


nonisolated private func writeHealthKitMultipart(zipURL: URL, boundary: String, to outputURL: URL) throws {
    try Task.checkCancellation()
    FileManager.default.createFile(atPath: outputURL.path, contents: nil)
    let output = try FileHandle(forWritingTo: outputURL)
    defer { try? output.close() }
    let header = Data("""
    --\(boundary)\r
    Content-Disposition: form-data; name="file"; filename="apple-health-healthkit.zip"\r
    Content-Type: application/zip\r
    \r

    """.utf8)
    try output.write(contentsOf: header)
    try Task.checkCancellation()
    let input = try FileHandle(forReadingFrom: zipURL)
    defer { try? input.close() }
    while true {
        try Task.checkCancellation()
        let chunk = try input.read(upToCount: 1024 * 1024) ?? Data()
        if chunk.isEmpty { break }
        try output.write(contentsOf: chunk)
    }
    try Task.checkCancellation()
    try output.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))
}
