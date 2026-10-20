import Foundation

/// P2-3（2026-10-18 同步诊断）：一批导出的**通道计数**。
///
/// 为什么需要它：诊断时最大的盲区是"每批 4500 条里到底谁占的"——服务端只能看到
/// `insertedRecordCount` 总数，客户端则连类型直方图都没有，只能从预算数学反推
/// "900 条窗口份额 + 642 条补读份额装不满 4500 ⇒ 一定是 anchor/重放填的"。
/// 本类型把**每批各通道写入条数 / 写入类型数 / 重放中类型数**写成计数往下传，
/// 日志与任务行都能回答"这一批是谁在填预算"。
///
/// 🔴 边界：**只写计数，不写样本值、UUID、日期或类型以外的任何内容**。它不是健康数据，
/// 是同步自身的度量。字段全部 `Int` + `Codable`：任务行跨进程恢复时还能把"这批带来了什么"
/// 带到恢复轮（`loadTask` 解不开的代价是整批任务消失，见 `SyncTaskState` 头注释）。
nonisolated struct ExportChannelCounts: Codable, Equatable, Sendable {
    /// 正式 anchor/历史重放段写入的记录数。
    var anchorRecords: Int = 0
    /// 近 48h 窗口 pass 写入的记录数。
    var windowRecords: Int = 0
    /// 跑步动态「迟到样本」补读（两趟合计）写入的记录数。
    var backfillRecords: Int = 0
    /// workout 定向补齐窗口（P0-4）写入的记录数。
    var workoutWindowRecords: Int = 0
    /// 本批真正写进 export.xml 的记录类型数。
    var writtenTypes: Int = 0
    /// 本批开始时处于历史重放/首读（`needsHistoryRead` 或没有游标）的类型数。
    var replayingTypes: Int = 0
    /// P1-1：本批因服务端覆盖探测而**跳过重放历史**的类型数。
    var historySkippedTypes: Int = 0
    /// 本批处理的 workout 补齐窗口数（整窗查询完成 = 记一次尝试）。
    var workoutWindows: Int = 0
    /// 其中本批收口的窗口数。
    var workoutWindowsCompleted: Int = 0

    static let zero = ExportChannelCounts()

    init(
        anchorRecords: Int = 0,
        windowRecords: Int = 0,
        backfillRecords: Int = 0,
        workoutWindowRecords: Int = 0,
        writtenTypes: Int = 0,
        replayingTypes: Int = 0,
        historySkippedTypes: Int = 0,
        workoutWindows: Int = 0,
        workoutWindowsCompleted: Int = 0
    ) {
        self.anchorRecords = anchorRecords
        self.windowRecords = windowRecords
        self.backfillRecords = backfillRecords
        self.workoutWindowRecords = workoutWindowRecords
        self.writtenTypes = writtenTypes
        self.replayingTypes = replayingTypes
        self.historySkippedTypes = historySkippedTypes
        self.workoutWindows = workoutWindows
        self.workoutWindowsCompleted = workoutWindowsCompleted
    }

    /// 日志口径（只计数；`NSLog` 直接用，避免各处手拼格式串再漂移）。
    var logLine: String {
        "anchor=\(anchorRecords) window=\(windowRecords) backfill=\(backfillRecords) "
            + "workoutWindow=\(workoutWindowRecords) types=\(writtenTypes) replay=\(replayingTypes) "
            + "historySkipped=\(historySkippedTypes) windows=\(workoutWindows)(done \(workoutWindowsCompleted))"
    }
}

/// 传输层的自述状态，与 `phase` **正交**。
///
/// 为什么要单独一个字段：`phase` 说的是"同步走到哪一步"，而上传这件事有两套完全不同的
/// 事实 —— "字节还在我手上"与"字节已经交给系统了"。P2 引入 background URLSession 之后，
/// 后者能在进程被杀之后继续跑，于是"切后台时能不能碰这个上传"只能由它决定。
/// 把它塞进 `phase` 会让阶段数量乘二，而且每个阶段都要重新回答"这个阶段算不算在上传"。
nonisolated enum SyncUploadState: String, Codable, CaseIterable, Sendable {
    /// 还没开始传（multipart 可能已就绪）。
    case pending
    /// 传输在途。P2 之后这个值意味着**字节归系统所有**，生命周期中止不得取消它。
    case inFlight
    /// 服务端已收下（`sourceId` 已落盘）。
    case completed
    /// 这一批已作废（服务端确定性地拒绝），不会再重传。
    case abandoned
}

/// 一次同步的持久化任务。
///
/// 🔴 **新增字段一律 `Optional`，且必须写进显式 `init(from:)`。**
/// `HealthKitSync.loadTask` 用 `try?` 解码：只要有一个字段解不开，整份任务就被当成
/// "没有任务"，**在老设备上表现为升级后首次同步做了一次全量导出**（`lastExportEnd`
/// 之前的窗口被重导），而 `sync_tasks` 表里那一行明明还在。
/// 所以"给个默认值"是**不安全**的写法 —— 非可选属性即使有默认值，合成解码器照样
/// 抛 `keyNotFound`。
///
/// 🔴 **只存文件名，不存绝对路径。** iOS 容器路径里含 UUID，升级/重装后会变；
/// 存了绝对路径的字段在下次启动时就指向一个不存在的文件。
nonisolated struct SyncTaskState: Codable {
    /// payload 形态版本。老 payload 没有这个键 ⇒ `nil`，读的时候按 1 处理。
    static let currentSchemaVersion = 2

    // MARK: 老字段（形态不变，缺键仍然算失败）

    let target: String
    let serverId: String?
    let athleteId: String?
    let datasetEpoch: String?
    let protocolVersion: Int?
    var phase: String
    var sourceId: String?
    var jobId: String?
    let payloadHash: String
    let pendingAnchor: Data?
    /// Opaque per-type v2 cursors. Optional so old pending uploads still resume.
    let pendingRecordCursors: Data?
    /// 有界路线候选队列的位置。续传成功也必须推进，否则后台反复中断会一直困在首批。
    /// Optional + decodeIfPresent 保留旧任务兼容性；仅在交付成功后写入降频记忆。
    let pendingRouteDiscoveryCursor: String?
    let exportEnd: Date?
    let workoutCount: Int

    // MARK: P1 / P2 新字段（全部 Optional）

    var schemaVersion: Int?
    /// `URLSessionTask` 的 `taskIdentifier`。
    ///
    /// 🔴 **当前没有任何写入点，读它的人必须自己确认这一点。** 判据（"系统手上这个传输要不要留"）
    /// 用的是 `RaiBackgroundUploadSession` 内部的 `waiters` / `descriptions` 两张按 identifier 索引的
    /// 表，而 identifier 只在那次 `upload` 调用内部可得 —— 想把它捞出来落盘，得让那个方法在
    /// 非隔离上下文里回调 MainActor，多出一条竞态路径，换来的只是诊断信息。
    /// 留着这个键是为了 payload 形态稳定（删键会让老设备上的判据全错），不是为了现在就用它：
    /// 拿它当"字节归系统"的判据会得到**恒假**，于是每次唤醒都重传一遍。
    var uploadTaskId: Int?
    var uploadSessionIdentifier: String?
    /// 只存文件名（见类型说明）。
    var multipartFileName: String?
    var zipFileName: String?
    /// multipart 的 boundary。恢复时必须沿用同一个，否则 `Content-Type` 与文件内容不匹配。
    var multipartBoundary: String?
    var uploadState: SyncUploadState?
    var uploadRequestedAt: Date?
    var uploadCompletedAt: Date?
    var lastLifecycleStopAt: Date?
    var lastBackgroundRunAt: Date?

    // MARK: PR6 直连回执（全部 Optional）

    /// 这一批的持久回执（§10.1）。
    ///
    /// 为什么要落盘而不是只留在 runtime 里：§10.1 的"重启丢进度"一行要求
    /// **从主库 receipt/analysis jobs 恢复**，而 `HealthKitSync` 的 runtime 状态
    /// 在进程被杀之后什么都不剩。留了 `receiptId` 才能对同一批做持久对账 ——
    /// 也就是 §10.1 的"COMMIT后回复丢失：查询同scope/batch持久receipt，返回同一成功"：
    /// 没有这份记录，同样的一批只能靠**重传字节**去换一个已经存在的结果。
    var lastReceipt: DirectSyncReceipt?
    /// 这一轮是否还没 drain 完（§5.1 / §10.2）。
    ///
    /// 唯一用途是"连续分页尚未 drain 完时，不清空后台待办意图"（§10.2 原文）：
    /// 清空之后，用户不主动打开 App 就再也没人接着发下一批，而"导出过一批"
    /// 并不等于 HealthKit 通知已全部处理（§5.1）。
    ///
    /// `Bool?` 而不是 `Bool`：老 payload 没有这个键，而"没有这个键"与"这一轮没剩下什么"
    /// 是两件事 —— 读的人必须能分清"未记录"与"记录为 false"（见类型顶部的兼容纪律）。
    var needsContinuation: Bool?
    /// 本批删除溢出的**跨轮记忆**（R3b）：导出时算出的余量，供"上传成功前崩溃"的恢复轮
    /// 原样写入 `sync_pending_deletions` 槽 —— 没有它，恢复轮只能提交空余量，
    /// 而那批未发送的删除会随锚点推进**永久丢失**（`needsContinuation` 的同族问题：
    /// 导出态的跨轮记忆）。
    ///
    /// `Data?`（`DirectSyncPendingDeletions` 的 JSON）：与 `needsContinuation` 同样
    /// "缺键 = 未记录"（老 payload 没有它），不是"没有余量"。
    var pendingDeletions: Data?
    /// 分析那一半的**独立**结论（§1.4 / §9.1）。
    ///
    /// 为什么不从 `lastReceipt.analysisStatus` 读：`committed` 之后事实那一半就冻结了，
    /// 而分析还在动（`queued → running → published`）。把进度写回 `lastReceipt` 就得
    /// 改写那份"服务端当时提交了什么"的记录，于是对账时再也分不清
    /// "服务端提交的是这一版分析"还是"客户端后来自己更新过"。两半各存各的，
    /// 才对得上 §10.2 那句"新 iOS 看到 durable committed receipt 即可提交相应游标，
    /// **分析另行跟踪**"。
    var lastAnalysisStatus: DirectSyncAnalysisStatus?

    /// R03（2026-10-16）：本批**已交付、待提交后结算**的路线待办 UUID（跨进程恢复用）。
    ///
    /// 为什么需要它：这些"完成候选"此前只活在导出轮的**内存**里
    ///（`markSuccess(completedRouteTodos:)` 的默认空参数）。崩在"导出完成 → 提交成功"
    /// 之间、由恢复轮提交时，候选丢失 ⇒ 待办残留 ⇒ 下批多查一次（方向安全，但白读
    /// HealthKit 的轨迹是整条链最贵的一步之一）。
    ///
    /// `nil`（老 payload 缺键）= **没有完成证明** ⇒ 恢复轮按"不移除"处理 —— 安全方向与
    /// `pendingDeletions` 同款：残留只会让下批多查一次，绝不丢。
    ///
    /// 🔴 B01（2026-10-17）：本字段**不再单独作为删除依据**。它只保留"当时打算删哪些"的
    /// 诊断信息；真正的结算走 {@link routeCommit}。原因是"完成 UUID"不带观测 —— 恢复轮
    /// 拿着它只能删待办、写不出状态，于是那条路线永久不可发现（见 `RouteCommitCandidate`）。
    var completedRouteTodos: [String]?

    /// B01（2026-10-17）：本批路线观测的**持久提交候选**（§3.2）。
    ///
    /// 与 `completedRouteTodos` 的差别是它带**完整观测**（点数、摘要、状态、检查时刻）。
    /// 恢复轮凭它同时做两件事：
    ///   1. 写 `sync_route_state`（这条路线"查过了"的记忆）；
    ///   2. 删 `sync_pending_routes`（"还没查"的队列）。
    ///
    /// 两者必须由同一份证据驱动，否则"删了待办却没写状态"会让该 UUID 从两条发现通道
    /// 同时消失。`nil`（老 payload / 本轮没查路线）= 不结算、不删待办。
    var routeCommit: RouteCommitCandidate?

    /// P2-3（2026-10-18 同步诊断）：本批各通道的**计数**（`ExportChannelCounts`）。
    ///
    /// 与 `workoutCount` 的分工：那个是"本批交付了几条训练"（展示与对账用），这里是
    /// "这批记录到底是谁在填预算"（重放进度观测用）。恢复轮把它原样带进 `lastExportSummary`
    /// 与日志，于是"崩在提交前的一批带来了什么"不必重读 HealthKit 才能知道。
    ///
    /// `nil`（老 payload 缺键）= 未记录。它不是健康数据，丢了一层也不影响正确性；
    /// 但解码仍然走 `decodeIfPresent`：任何新键都不许让整份任务消失（文件头兼容纪律）。
    var lastExportCounts: ExportChannelCounts?

    /// R3（2026-10-19 复核）：本批**已交付但尚未拿到 committed 回执**的训练窗口分页候选。
    ///
    /// 内容 = `(scope, workout, windowRevision, type)` 的起始确认指纹、候选 anchor、EOF/退避
    /// 状态与下一次探测时刻。三条纪律：
    ///   1. **上传前**随任务行落盘（与 `pendingDeletions` 同一条"导出态"透传通道）；
    ///   2. 所有恢复分支（`.waitJob` / inspect 续接 / 原 ZIP 重传 / 正常新导出）原样透传；
    ///   3. 只有在 `commitSuccess` 的同一事务里、拿到服务端 committed 回执后才落 `sync_workout_type_pages`。
    ///
    /// `nil`（老 payload 缺键）= 本轮没有分页候选；**不是**"清空分页表"。解不开时降级为
    /// `nil`（与 `routeCommit` 同一条兼容纪律：丢掉候选只让下一批重读一页，丢掉整份任务
    /// 会让升级后的首次同步重导整个窗口）。
    var pendingWorkoutPages: [WorkoutWindowPageCommit]?

    init(
        target: String,
        serverId: String? = nil,
        athleteId: String? = nil,
        datasetEpoch: String? = nil,
        protocolVersion: Int? = nil,
        phase: String,
        sourceId: String? = nil,
        jobId: String? = nil,
        payloadHash: String,
        pendingAnchor: Data? = nil,
        pendingRecordCursors: Data? = nil,
        pendingRouteDiscoveryCursor: String? = nil,
        exportEnd: Date? = nil,
        workoutCount: Int,
        schemaVersion: Int? = SyncTaskState.currentSchemaVersion,
        uploadTaskId: Int? = nil,
        uploadSessionIdentifier: String? = nil,
        multipartFileName: String? = nil,
        zipFileName: String? = nil,
        multipartBoundary: String? = nil,
        uploadState: SyncUploadState? = nil,
        uploadRequestedAt: Date? = nil,
        uploadCompletedAt: Date? = nil,
        lastLifecycleStopAt: Date? = nil,
        lastBackgroundRunAt: Date? = nil,
        lastReceipt: DirectSyncReceipt? = nil,
        needsContinuation: Bool? = nil,
        pendingDeletions: Data? = nil,
        lastAnalysisStatus: DirectSyncAnalysisStatus? = nil,
        completedRouteTodos: [String]? = nil,
        routeCommit: RouteCommitCandidate? = nil,
        lastExportCounts: ExportChannelCounts? = nil,
        pendingWorkoutPages: [WorkoutWindowPageCommit]? = nil
    ) {
        self.target = target
        self.serverId = serverId
        self.athleteId = athleteId
        self.datasetEpoch = datasetEpoch
        self.protocolVersion = protocolVersion
        self.phase = phase
        self.sourceId = sourceId
        self.jobId = jobId
        self.payloadHash = payloadHash
        self.pendingAnchor = pendingAnchor
        self.pendingRecordCursors = pendingRecordCursors
        self.pendingRouteDiscoveryCursor = pendingRouteDiscoveryCursor
        self.exportEnd = exportEnd
        self.workoutCount = workoutCount
        self.schemaVersion = schemaVersion
        self.uploadTaskId = uploadTaskId
        self.uploadSessionIdentifier = uploadSessionIdentifier
        self.multipartFileName = multipartFileName
        self.zipFileName = zipFileName
        self.multipartBoundary = multipartBoundary
        self.uploadState = uploadState
        self.uploadRequestedAt = uploadRequestedAt
        self.uploadCompletedAt = uploadCompletedAt
        self.lastLifecycleStopAt = lastLifecycleStopAt
        self.lastBackgroundRunAt = lastBackgroundRunAt
        self.lastReceipt = lastReceipt
        self.needsContinuation = needsContinuation
        self.pendingDeletions = pendingDeletions
        self.lastAnalysisStatus = lastAnalysisStatus
        self.completedRouteTodos = completedRouteTodos
        self.routeCommit = routeCommit
        self.lastExportCounts = lastExportCounts
        self.pendingWorkoutPages = pendingWorkoutPages
    }

    /// 显式解码：老键保持必填，新键一律 `decodeIfPresent`。
    ///
    /// 为什么不能靠合成：合成解码器对 `Optional` 确实用 `decodeIfPresent`，但对非可选
    /// 属性**即使声明了默认值也会 `decode`**，缺键即 `keyNotFound`。这里把"哪些键必须
    /// 在"写成代码，才有人能一眼看出兼容边界在哪。
    ///
    /// 编码策略与老版本完全一致（默认的 `deferredToDate` / 默认 `Data`）：
    /// 换策略会让同一张 `sync_tasks` 表里出现两种时间编码。
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // 这四个是**协议身份**：缺了它们，这份 payload 不属于任何已知版本。
        // 宁可解不开（上层会如实报错），也不要造出一个"目标为空"的任务去连一个
        // 不存在的服务器 —— 后者会退化成一次莫名其妙的握手失败。
        target = try container.decode(String.self, forKey: .target)
        phase = try container.decode(String.self, forKey: .phase)
        payloadHash = try container.decode(String.self, forKey: .payloadHash)
        workoutCount = try container.decode(Int.self, forKey: .workoutCount)
        serverId = try container.decodeIfPresent(String.self, forKey: .serverId)
        athleteId = try container.decodeIfPresent(String.self, forKey: .athleteId)
        datasetEpoch = try container.decodeIfPresent(String.self, forKey: .datasetEpoch)
        protocolVersion = try container.decodeIfPresent(Int.self, forKey: .protocolVersion)
        sourceId = try container.decodeIfPresent(String.self, forKey: .sourceId)
        jobId = try container.decodeIfPresent(String.self, forKey: .jobId)
        pendingAnchor = try container.decodeIfPresent(Data.self, forKey: .pendingAnchor)
        pendingRecordCursors = try container.decodeIfPresent(Data.self, forKey: .pendingRecordCursors)
        pendingRouteDiscoveryCursor = try container.decodeIfPresent(String.self, forKey: .pendingRouteDiscoveryCursor)
        exportEnd = try container.decodeIfPresent(Date.self, forKey: .exportEnd)
        schemaVersion = try container.decodeIfPresent(Int.self, forKey: .schemaVersion)
        uploadTaskId = try container.decodeIfPresent(Int.self, forKey: .uploadTaskId)
        uploadSessionIdentifier = try container.decodeIfPresent(String.self, forKey: .uploadSessionIdentifier)
        multipartFileName = try container.decodeIfPresent(String.self, forKey: .multipartFileName)
        zipFileName = try container.decodeIfPresent(String.self, forKey: .zipFileName)
        multipartBoundary = try container.decodeIfPresent(String.self, forKey: .multipartBoundary)
        uploadState = try container.decodeIfPresent(SyncUploadState.self, forKey: .uploadState)
        uploadRequestedAt = try container.decodeIfPresent(Date.self, forKey: .uploadRequestedAt)
        uploadCompletedAt = try container.decodeIfPresent(Date.self, forKey: .uploadCompletedAt)
        lastLifecycleStopAt = try container.decodeIfPresent(Date.self, forKey: .lastLifecycleStopAt)
        lastBackgroundRunAt = try container.decodeIfPresent(Date.self, forKey: .lastBackgroundRunAt)
        // §10.2「SyncTaskState 新增字段必须 Optional、显式 decodeIfPresent；
        // 保留旧ZIP、batch和续传身份」—— 这三个键一个都不能用 `decode`：
        // 老 payload 没有它们，`decode` 会让整份任务解不开，而 `loadTask` 用 `try?`，
        // 于是"任务消失"，症状是升级后重导整个窗口。上面那些老键保持 `decode` 不变。
        lastReceipt = try container.decodeIfPresent(DirectSyncReceipt.self, forKey: .lastReceipt)
        needsContinuation = try container.decodeIfPresent(Bool.self, forKey: .needsContinuation)
        pendingDeletions = try container.decodeIfPresent(Data.self, forKey: .pendingDeletions)
        lastAnalysisStatus = try container.decodeIfPresent(
            DirectSyncAnalysisStatus.self, forKey: .lastAnalysisStatus
        )
        completedRouteTodos = try container.decodeIfPresent([String].self, forKey: .completedRouteTodos)
        // B01：路线提交候选。**解不开时降级为 `nil`，绝不让它拖垮整份任务。**
        //
        // 理由是本文件顶部那条兼容纪律：`HealthKitSync.loadTask` 用 `try?`，任何一处抛错都会
        // 让整份任务被当成"没有任务" —— 症状是升级后首次同步**重导整个窗口**，而 `sync_tasks`
        // 那一行明明还在。候选只是**可选的结算证据**：丢了它，待办仍在队列里（下一轮重新观测），
        // 而丢掉整份任务是不可接受的。
        //
        // 这与"损坏证据失败关闭"不矛盾：失败关闭发生在**结算**侧（`RouteCommitSettlement`
        // 校验失败 ⇒ 一条待办都不删），不是发生在**解码**侧（解码失败 ⇒ 这一轮不结算）。
        routeCommit = try? container.decodeIfPresent(RouteCommitCandidate.self, forKey: .routeCommit)
        // P2-3：纯计数，解不开也只是少一条观测 —— 与 `routeCommit` 同一条降级纪律。
        lastExportCounts = try? container.decodeIfPresent(ExportChannelCounts.self, forKey: .lastExportCounts)
        // R3：分页候选是"恢复证据"，解不开时降级为 nil（下一批多读一页），绝不让整份任务消失。
        pendingWorkoutPages = try? container.decodeIfPresent(
            [WorkoutWindowPageCommit].self, forKey: .pendingWorkoutPages
        )
    }

    /// 落盘的那个字符串 → 闭集取值。老 payload 的 `recomputing` 在这里归一到 `importing`。
    var resolvedPhase: SyncPhase { SyncPhase.migrate(phase) }

    /// 这份 payload 是不是 P1 之后写出来的（有文件名就算）。
    ///
    /// 恢复分支要靠它决定"能不能按文件名直接找到本地批次"——老 payload 没有这个键，
    /// 只能回退到历史上唯一用过的那个名字，并且**必须重算哈希**才能确认批次对得上。
    var hasNamedArtifacts: Bool { zipFileName != nil || multipartFileName != nil }
}
