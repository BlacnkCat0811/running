import Foundation

/// §10.1 的原始事实接收状态。
///
/// 🔴 **它与"分析是否更新"是两个独立结论**（`docs/SQLITE_DIRECT_SYNC_DESIGN.md` §1.4 / §9.1）。
/// `committed` 只说这一批事实已经持久提交，它**不**意味着派生分析已经跟上；把两者压回
/// 一个布尔，就等于把「committed + `analysisStatus = queued`」说成"全都好了"。
///
/// 取值与 `packages/contracts/src/direct-sync.ts` 的 `INGEST_STATUSES` **逐字逐序**一致。
/// 服务端加状态时这里必须一起改 —— 而下面这套解码**故意不写兜底**：
/// `String` 原始值的合成解码器对认不出的字面量抛 `dataCorrupted`，这正是要的方向。
/// 反过来（兜底成某个已知值，尤其兜成 `committed`）会让一个**尚未提交**的批次被当成
/// 已提交，于是游标跟着推进，那段窗口再也不会被重读。解码失败只会让回执消失，
/// 而上游拿到"没有回执"时的处置是 `.hold`，方向安全。
nonisolated enum DirectSyncIngestStatus: String, Codable, CaseIterable, Sendable {
    case receiving
    case validating
    case applying
    case committed
    case rejected
}

/// §10.1 的派生分析状态。取值与 `ANALYSIS_STATUSES` **逐字逐序**一致。
///
/// 🔴 `not_required` 是"本批在结构上不影响分析"，**不是**"分析已完成"；只有 `published`
/// 才是。两者在这里是两个 case，消费方无法用"非失败即完成"的写法把它们混起来（§9.1）。
nonisolated enum DirectSyncAnalysisStatus: String, Codable, CaseIterable, Sendable {
    case notRequired = "not_required"
    case queued
    case running
    case published
    case failed
}

/// 把 5 个分析取值折成 4 个**语义**结论，供展示层判断「该不该说分析已更新」。
///
/// 为什么不是直接把 `DirectSyncAnalysisStatus` 递出去：`notRequired` 与 `published` 在
/// 状态机上都是终态，但只有 `published` 能说「分析已更新」（§9.1）。给一个折过的闭集，
/// "`not_required` 当作 `published` 显示"这件事就得**显式写出来**才可能发生，
/// 而不是靠调用方记得区分两个相邻的字符串。
///
/// ⚠️ 引用 §10.3 的文案时用「」而不是 ASCII 双引号：那六句是展示层的文案，而
/// `check-direct-sync-status-copy.py` 靠"代码里出现了带引号的整句"认文案持有者 ——
/// 注释里用 ASCII 双引号逐字引用那些句子，与真实字符串字面量文本同形，会制造假阳。
nonisolated enum DirectSyncAnalysisOutcome: Equatable, Sendable {
    /// 本批不影响分析。**不等于**「分析已更新」。
    case notRequired
    /// `queued` / `running`：事实已保存，分析还没出结果。
    case pending
    /// 分析已发布到本批对应的版本。
    case published
    case failed
}

/// §10.1 的直连回执本体（服务端 `summary.directSync`）。
///
/// 字段形状的唯一出处是 `packages/contracts/src/direct-sync.ts` 的 `DirectSyncReceipt`：
/// `receiptId` / `dependencyGeneration` / `publishedReleaseId` / `parentBatchId` 一个不少，
/// 而 `routeReceipts` **刻意不在**（PR3 才有生产者，详见该文件的长注释）——
/// 未知键被忽略，所以它将来加进来不会让这份解码失败。
///
/// 为什么三个"没有值"的字段是 `Optional` 而不是空串：合同写的是 `string | null`，
/// 「本批不影响分析」与「影响分析的版本是空字符串」是两件事（`direct-sync.ts:44`）。
/// 🔴 因此这里一律 `decodeIfPresent` —— 用 `decode` 会让 `null` 变成解码失败，
/// 而那份回执明明是一份**合法且已提交**的回执。
///
/// ⚠️ 比对 `RaiHandshake` 那一族"能力位"多出来的 `Encodable`：不是随手加的。
/// `SyncTaskState` 是 `Codable`，`lastReceipt` 要跟着它落盘（§10.1 的"重启丢进度：
/// 从主库 receipt/analysis jobs 恢复"），而它的 `encode(to:)` 是合成的 ⇒ 只声明
/// `Decodable` 会让整个 iOS 目标编译不过。
/// P0-3：本批记录计数（服务端 `summary.directSync.records`）。
nonisolated struct DirectSyncRecordCounts: Codable, Equatable, Sendable {
    let parsed: Int
    let inserted: Int
    let unchanged: Int
}

nonisolated struct DirectSyncReceipt: Codable, Equatable, Sendable {
    /// 客户端认得的回执合同版本，与 T1 在 `/v1/handshake` 宣告的
    /// `factsAnalysisContractVersion: 1`（`apps/api/src/server.ts`，声明在
    /// `packages/api-contracts/src/index.ts`）是同一个数字。
    ///
    /// 🔴 这是**下界**，不是"精确匹配"：`DirectSyncCursorPolicy.decision` 的判据是
    /// `serverContractVersion >= 本常量`（`DirectSyncCursorPolicy.swift`）。
    ///
    /// 方向刻意选成"抬版本仍放行"：本客户端已经能读懂的那几个字面量
    /// （`ingestStatus` / `analysisStatus` 的取值集）不会因为服务端**追加**字段而变坏 ——
    /// 未知键被 JSONDecoder 忽略；而真读不懂的字面量由**枚举解码本身**拦下
    /// （`DirectSyncReceipt.init(from:)` 对认不出的取值抛 `dataCorrupted`），
    /// 那条路径的结果是"这份回执不存在"⇒ 调用方 `.hold("no_receipt")`，方向同样安全。
    ///
    /// ⚠️ 反过来把判据写成 `==` 才是危险的：服务端发一次仅新增字段的次要版本，
    /// 所有老客户端就会**永久 hold**（游标不推进、窗口被反复重导）。两害相权，
    /// 取"抬版本放行、由解码兜住读不懂的内容"。
    static let factsAnalysisContractVersion = 1

    /// 这一批事实在服务端的接收状态。**必填**：缺了它这份回执不构成任何结论。
    let ingestStatus: DirectSyncIngestStatus
    /// 这一批的持久回执 id，与 `ImportJobResponse.id` 相同。
    ///
    /// 必填的理由是"重启后对账"（§10.1）：`loadTask` 恢复出来的任务要靠它认出
    /// "我上次等的是哪一批"，缺了它就只能重新导出一次。
    let receiptId: String
    /// 本批对应的分析状态。**必填**，理由同上：缺了它，"分析另行跟踪"（§10.2）
    /// 就没有跟踪对象了。
    let analysisStatus: DirectSyncAnalysisStatus
    /// 影响分析的依赖版本；本批不影响分析时为 `nil`（**不是**空串占位）。
    let dependencyGeneration: String?
    /// 当前可读的分析发布 id；本批没有发布新分析时为 `nil`。
    let publishedReleaseId: String?
    /// 大包分片时的父批 id；未分片为 `nil`（§5.2）。
    let parentBatchId: String?
    /// P0-3：本批记录计数；老服务端省略 ⇒ nil。用于同步结果自解释（新增/重复）。
    let records: DirectSyncRecordCounts?

    init(
        ingestStatus: DirectSyncIngestStatus,
        receiptId: String,
        analysisStatus: DirectSyncAnalysisStatus,
        dependencyGeneration: String? = nil,
        publishedReleaseId: String? = nil,
        parentBatchId: String? = nil,
        records: DirectSyncRecordCounts? = nil
    ) {
        self.ingestStatus = ingestStatus
        self.receiptId = receiptId
        self.analysisStatus = analysisStatus
        self.dependencyGeneration = dependencyGeneration
        self.publishedReleaseId = publishedReleaseId
        self.parentBatchId = parentBatchId
        self.records = records
    }

    private enum CodingKeys: String, CodingKey {
        case ingestStatus, receiptId, analysisStatus
        case dependencyGeneration, publishedReleaseId, parentBatchId, records
    }

    /// 显式解码，好让"哪些键必须在"写在代码里（合成解码器的行为等价，但看不见边界）。
    ///
    /// 🔴 三个必填键用 `decode`：**不许**给它们兜一个默认值。一份缺 `ingestStatus` 的
    /// 回执如果被"兜成成功"，我们就把一个未知状态当成了已提交。
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ingestStatus = try container.decode(DirectSyncIngestStatus.self, forKey: .ingestStatus)
        receiptId = try container.decode(String.self, forKey: .receiptId)
        analysisStatus = try container.decode(DirectSyncAnalysisStatus.self, forKey: .analysisStatus)
        dependencyGeneration = try container.decodeIfPresent(String.self, forKey: .dependencyGeneration)
        publishedReleaseId = try container.decodeIfPresent(String.self, forKey: .publishedReleaseId)
        parentBatchId = try container.decodeIfPresent(String.self, forKey: .parentBatchId)
        records = try container.decodeIfPresent(DirectSyncRecordCounts.self, forKey: .records)
    }

    /// 这一批的原始事实是否已经持久提交 —— **只**回答事实那一半（§1.4）。
    ///
    /// 命名刻意不叫 `isComplete` / `isSuccess`：它一个字节都没有说分析的事。
    var isCommitted: Bool { ingestStatus == .committed }

    /// 分析那一半的结论，见 `DirectSyncAnalysisOutcome`。
    var analysisOutcome: DirectSyncAnalysisOutcome {
        switch analysisStatus {
        case .notRequired: return .notRequired
        case .queued, .running: return .pending
        case .published: return .published
        case .failed: return .failed
        }
    }
}
