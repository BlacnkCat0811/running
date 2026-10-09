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
        lastBackgroundRunAt: Date? = nil
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
    }

    /// 落盘的那个字符串 → 闭集取值。老 payload 的 `recomputing` 在这里归一到 `importing`。
    var resolvedPhase: SyncPhase { SyncPhase.migrate(phase) }

    /// 这份 payload 是不是 P1 之后写出来的（有文件名就算）。
    ///
    /// 恢复分支要靠它决定"能不能按文件名直接找到本地批次"——老 payload 没有这个键，
    /// 只能回退到历史上唯一用过的那个名字，并且**必须重算哈希**才能确认批次对得上。
    var hasNamedArtifacts: Bool { zipFileName != nil || multipartFileName != nil }
}
