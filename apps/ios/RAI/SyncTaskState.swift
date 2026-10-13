import Foundation

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
    /// 分析那一半的**独立**结论（§1.4 / §9.1）。
    ///
    /// 为什么不从 `lastReceipt.analysisStatus` 读：`committed` 之后事实那一半就冻结了，
    /// 而分析还在动（`queued → running → published`）。把进度写回 `lastReceipt` 就得
    /// 改写那份"服务端当时提交了什么"的记录，于是对账时再也分不清
    /// "服务端提交的是这一版分析"还是"客户端后来自己更新过"。两半各存各的，
    /// 才对得上 §10.2 那句"新 iOS 看到 durable committed receipt 即可提交相应游标，
    /// **分析另行跟踪**"。
    var lastAnalysisStatus: DirectSyncAnalysisStatus?

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
        lastAnalysisStatus: DirectSyncAnalysisStatus? = nil
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
        self.lastAnalysisStatus = lastAnalysisStatus
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
        lastAnalysisStatus = try container.decodeIfPresent(
            DirectSyncAnalysisStatus.self, forKey: .lastAnalysisStatus
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
