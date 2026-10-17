import Foundation

/// 同步阶段的闭集 —— 这是全仓 `phase` 取值的**唯一来源**。
///
/// 为什么要有它：`phase` 此前是裸字符串，取值散在 `HealthKitSync.swift` 里，而
/// `HealthSyncLifecycle.persistedPhases` 另抄了一份同名单。两份清单靠人记得同步，
/// 失效方式还是静默的（多了个阶段没人管）—— 重复的"全集"正是本项目复发最多的一类缺陷。
/// 现在 `persistedPhases` 与 `terminalPhases` 都由这里派生，跑不出第二次。
///
/// 权威语义表（含"允许跨会话"那一列）见 `docs/IOS_NATIVE_SYNC_PROTOCOL.md`。
nonisolated enum SyncPhase: String, CaseIterable, Sendable {
    /// 没有持久化任务。
    case idle
    /// 授权检查 + HealthKit 导出中。
    case collecting
    /// ZIP 已落盘、`payloadHash` 已算，还没上传。
    case exported
    /// multipart 已就绪，传输在途。
    case uploading
    /// 服务端已收下这一批（`sourceId` 已落盘），`inspect` / `startImport` 还没完成。
    ///
    /// 🔴 它存在的唯一理由是 D1：把这个状态与 `importing` 分开，才能让"批次已上传但
    /// 导入未发起"与"导入已在服务端跑"在恢复时有不同的处置。今天两者被混写成同一个
    /// 字符串，于是恢复分支只能靠猜。
    case uploaded
    /// `jobId` 已落盘，等服务端终态。
    case importing
    /// 只在**老 payload** 里出现：旧客户端把"服务端已在算"写成这个值。
    ///
    /// 客户端不再写入它 —— 语义与 `importing` 完全相同，留着两种写法只会制造
    /// "同一件事两个值"的恢复分支。`migrate` 会把它归一到 `.importing`。
    case recomputing

    /// 🔴 设备锁屏、或开机后尚未首次解锁：HealthKit 数据库被硬件级加密锁死，**读不到任何东西**。
    ///
    /// 为什么不复用 `failed`（这是这个取值存在的全部理由）：锁屏是**暂时的**外部条件，
    /// 解锁后同一份工作可以原样重跑；而 `failed` 会做两件错事 ——
    ///   1. 界面对用户说"同步失败"，可用户什么都没做错，而且解锁后不会自动恢复；
    ///   2. 更要命的是它把下一个改动的思路引向"这次没读到数据"⇒ 顺手当成 0 条记录处理。
    /// 文档 §3.4 的原文是「绝对严禁视为空数据 (0 Workouts) 推进 Anchor!」
    ///
    /// rawValue 用蛇形是为了与文档 §3.1 的状态机表逐字对齐；其余取值恰好都是单词，
    /// 所以此前看不出这个差别。⚠️ 带显式 rawValue 的 `case` 会让结构门禁那句按行抓
    /// `case <name>` 的正则漏掉它 —— 门禁侧已同步放宽（`check-background-capabilities.py`）。
    case deferredProtectedData = "deferred_protected_data"

    /// 批次凭证失效（HTTP 401/403）：这一批的**字节完好**，缺的只是通道。
    ///
    /// 与 `SyncUploadRecovery` 的纪律一致：**不确定性的拒绝要留着批次，确定性的拒绝才删批次**。
    /// 401 属于前者（换到有效凭证后，同一份字节用同一个 batchId 重传就能幂等命中）。
    /// 单独立一个阶段还多一层收益：文档 §3.3 要求后台**不得**对 401 自动无限重试，
    /// 而"当前卡在等凭证"这件事必须能被持久表达，否则下次唤醒除了再撞一次 401 无事可做。
    case authRequired = "auth_required"

    case succeeded
    case failed
    case cancelled

    /// 已经结束、不会自己变好的阶段。
    static let terminal: Set<SyncPhase> = [.idle, .succeeded, .failed, .cancelled]

    /// 只可能出现在老 payload 里的取值：客户端的写入点已经不产出它们。
    ///
    /// 结构门禁用它来配平"枚举全集 == 会被写出来的字面量全集"—— 少了这条例外，
    /// 一个只为迁移而存在的取值会被误判成"没人写、可以删"。
    static let legacyOnly: Set<SyncPhase> = [.recomputing]

    /// 不是终态、但**手里没有任何在飞的工作**：正在等一个外部条件（解锁／有效凭证）。
    ///
    /// 为什么单列成一组：这两个阶段是**唯一**值得被"外部事件"主动叫醒的 ——
    ///   - `deferredProtectedData` 由 `protectedDataDidBecomeAvailable`（用户解锁）唤醒；
    ///   - `authRequired` 由"回到前台且凭证已就绪"唤醒。
    /// 其余阶段要么已经结束，要么本来就在跑（在跑的那个不需要谁再来叫一次），
    /// 把它们一并叫醒只会换来一次白读 HealthKit 的导出。
    ///
    /// ⚠️ 它**不是** `terminal`：这两个阶段都允许跨会话续接，而且必须能被恢复动作改写。
    static let blocked: Set<SyncPhase> = [.deferredProtectedData, .authRequired]

    var isTerminal: Bool { Self.terminal.contains(self) }

    var isBlocked: Bool { Self.blocked.contains(self) }

    /// 🔴 **不变式：处于阻塞阶段时，客户端绝不允许把 candidate anchor 提交成 committed anchor。**
    ///
    /// 文档 §3.4 的原话是「绝对严禁视为空数据 (0 Workouts) 推进 Anchor!」—— 这两个阶段的
    /// 共同点正是"这一次**没读到**数据"（锁屏）与"这一次**没送达**数据"（401），
    /// 而两者都**不是**"数据没有变化"的证据。把"没读到"当成"没有变化"，等于把那段
    /// 还没导出的健康数据**永久**跳过：下次查询从 committed anchor 起步，它们再也不会被看见。
    ///
    /// 判据写成派生函数而不是一条注释，是为了让它在**可执行**的回归里被断言
    /// （`HealthSyncBlockedRecoveryRegression`）—— `HealthKitSync.swift` 不被任何回归编译。
    static func mayAdvanceAnchor(_ phase: SyncPhase) -> Bool { !blocked.contains(phase) }

    /// 这个阶段的任务**允许跨会话**续接。
    ///
    /// 判据不是"磁盘上能不能留住东西"，而是"下次唤醒能不能直接从这一步接着做"：
    /// - `importing`：`jobId` 是**服务端**的记录，客户端拿着它就能把结果接回来 ⇒ 可以。
    /// - `exported` / `uploading` / `uploaded`：这三步同属一个原子单元
    ///   （`upload → inspect → startImport`）。中断了就下次**整体重做** ——
    ///   上传靠 `X-RAI-Sync-Batch` 幂等，不会产生第二份来源。
    var canSpanSessions: Bool { self == .importing }

    /// 老 payload / 服务端自述的字符串 → 闭集取值。
    ///
    /// 未知取值一律落到 `.idle`：一个认不出来的字符串说明这份 payload 不属于当前
    /// 版本的协议，把它当成"有任务"比当成"没任务"危险得多。
    static func migrate(_ legacy: String) -> SyncPhase {
        guard let phase = SyncPhase(rawValue: legacy) else { return .idle }
        return phase == .recomputing ? .importing : phase
    }
}

/// 原子单元协议（D1 的落地判据）。
///
/// 单元 = `upload → inspect → startImport`，必须在**同一次唤醒内**做完；
/// 允许跨会话的只有"拿着 `jobId` 等终态"这一段。
///
/// 判据刻意只看**字段**（`sourceId` / `jobId` / 本地文件），不看 `phase` 字符串 ——
/// `phase` 是自述，字段才是事实（`HealthSyncLifecycle` 之外的第三条全局不变量）。
/// 这条纪律在 2026-09-22 的线上死锁里已经付过一次代价：当时恢复分支按 `phase` 猜，
/// 于是"批次已上传、导入没发起"与"导入已在跑"分不出来。
nonisolated enum SyncAtomicUnit {
    enum Step: Equatable {
        /// 读 HealthKit 并导出 ZIP（`payloadHash` 随之更新）。
        case export
        /// 构建 multipart（若本地还没有）并上传。
        case upload
        /// `POST /v1/imports/inspect` 核对服务端那份暂存上传。
        case inspect
        /// `POST /v1/import-jobs` 发起导入。
        case startImport
        /// 拿着 `jobId` 等终态。
        case waitJob

        /// 这一步是不是**只差服务端的结局**：不读 HealthKit、也不传字节。
        ///
        /// 唯一的这种步是 `.waitJob` —— 它整个动作就是一次 `GET /v1/import-jobs/<id>`，
        /// 代价与一次握手同量级。
        ///
        /// 为什么单独命名、而不是在调用方写 `jobId != nil`：前台 15 分钟节流的豁免判据
        /// 必须与 `nextStep` **同源**。写成一份独立的 `jobId != nil`，将来 `nextStep` 的
        /// 优先级一变（例如让某个本地文件重新压过 `jobId`），节流那边会**静默地**多放行
        /// 或少放行一步 —— 而"多放行"的那一侧是 GB 级导出。
        var isServerReconciliationOnly: Bool { self == .waitJob }
    }

    /// 由持久化字段推导下一步。
    ///
    /// 判据顺序就是优先级，且**字段优先于阶段文字**：
    ///   1. `jobId` 在 ⇒ 服务端已经在算，只能等它（`.waitJob`）。
    ///   2. `sourceId` 在 ⇒ 先核对那份暂存上传还在不在（`.inspect`）——
    ///      🔴 `inspect` 是 `startImport` 的**强制前置门**：`unchanged` 时若直接建任务，
    ///      会得到一个必然失败的 job（成功导入过的上传会被服务端 retain 记录、删掉目录）。
    ///   3. 本地有 ZIP 或 multipart ⇒ 走 `.upload`（单元的第一步）。
    ///   4. 什么都没有 ⇒ 从 `.export` 开始。
    static func nextStep(
        sourceId: String?,
        jobId: String?,
        hasZip: Bool,
        hasMultipart: Bool
    ) -> Step {
        if jobId != nil { return .waitJob }
        if sourceId != nil { return .inspect }
        if hasMultipart || hasZip { return .upload }
        return .export
    }
}

/// 上传这一步失败之后的处置。
///
/// 与 `HealthSyncResumePolicy` 的分工：那个管**恢复分支**里 `inspect` / `startImport`
/// 的失败（源没了 ⇒ 放弃 task），这个管**上传本身**的失败（批次能不能再用）。
/// 两者处于流程的不同位置，判据不重叠 —— 刻意不让它们都去解释 404，那是最容易长出
/// 两份互相矛盾的规则的形状。
///
/// 🔴 **下面每个常量都必须在服务端源码里找得到出处。**
/// 第一版是凭记忆写的，四处全错（`import_upload_busy` 不是 409 而是 429、
/// 批次冲突的 code 不是 `batch_conflict` 而是 `sync_batch_content_mismatch`、
/// 漏了 507 与 `invalid_import_archive`、误以为 5xx 的 code 可用）。
/// 出处：`apps/api/src/routes/import-routes.ts:38-83`（`/v1/imports/uploads` 的全部出口）
/// ＋ `apps/api/src/import-sources.ts:55-89`（错误类型与状态码）
/// ＋ `apps/api/src/api-error.ts:26-31`（**5xx 的 code 被抹成 `internal_error`**）。
/// 改动这里的任何一个集合，都要同步改 `check-background-capabilities.py` 里那一段
/// 跨仓核对 —— 它会把集合里每个字面量拿去服务端源码里找，找不到就红。
nonisolated enum SyncUploadRecovery {
    enum Action: Equatable {
        /// 本批的字节**还可以再发**：ZIP 与 multipart 都留着，
        /// 下次用**同一个** batchId 重传 —— 服务端靠 `X-RAI-Sync-Batch` 幂等命中同一份来源。
        case keepForNextWake
        /// 同上，但这是"现在不行"而不是"这批不行"，值得当场退避后再试一次。
        case backOffAndRetry
        /// 本批的字节**不得再被发送**：重传同样的东西只会拿到同样的拒绝。
        ///
        /// 这个语义直接决定了本地动作：multipart 的唯一用途是"被发送"，ZIP 的用途是
        /// "重建 multipart 再发送"⇒ 两者都作废、都必须删。**不是"顺手删掉"**。
        case abandonBatch
    }

    /// 并发占用：看起来像失败，其实只是"现在不行"。
    ///
    /// 服务端有两处抛它：上传互斥（`import-sources.ts:318`）与"来源被在跑的导入占着"
    /// （`:476`）。后者不在上传路径上，但用同一个 code，所以调用方要靠位置区分。
    static let busyCodes: Set<String> = ["import_upload_busy"]

    /// **明确指向"这一批的字节/形态"**的拒绝码。
    static let contentRejectionCodes: Set<String> = [
        "invalid_sync_batch_id",     // :44 X-RAI-Sync-Batch 格式非法（我方的批次号形态错了）
        "invalid_import_archive",    // import-sources.ts:71-74 zip magic / 解压失败
        "sync_batch_content_mismatch" // import-sources.ts:65-69 同一批次号对应了不同内容
    ]

    /// **明确指向"这一批的字节/形态"**的状态码。
    ///
    /// 该端点上 400/415 的各种出口（无 file、非 zip、multipart 解析失败）说的都是
    /// "你这个请求本身不对"，同样的请求重发不会有别的结果；413 是包超过 4 GiB
    /// （`DEFAULT_LIMITS.maxArchiveBytes`，`import-sources.ts:99`）。
    static let contentRejectionStatuses: Set<Int> = [400, 409, 413, 415]

    /// **凭证**失效的状态码：这一批的字节没问题，缺的只是通道（文档 §3.3）。
    ///
    /// 为什么必须单列成第三类，而不是并进上面任何一个集合：
    ///   - 并进 `contentRejectionCodes` ⇒ 会 `abandonBatch` **删掉一份完全有效的批次**，
    ///     用户修好凭证之后还得重读一次 HealthKit（整个流程里最贵的一步）；
    ///   - 留在默认的 `.keepForNextWake` ⇒ 后台每次唤醒都撞一次同样的 401，永远好不了，
    ///     而这正是文档 §3.3 点名禁止的「自动无限重试」。
    ///
    /// 正确处置是第三种：**保留批次、落 `auth_required`、等前台拿到有效凭证再重传**
    /// （同一个 `batchId` 重传，服务端按归档字节幂等命中同一条来源）。
    ///
    /// ⚠️ 这两个码刻意**不**进 `contentRejectionCodes` / `contentRejectionStatuses`，
    /// 所以 `check-background-capabilities.py` 第 8 节那套"集合里每个字面量都要在服务端源码里
    /// 找得到出处"的核对不覆盖它们：那里核对的是**服务端自造的判定码**，
    /// 而 401/403 是 HTTP 标准码，由 `local-request-security.ts` 的鉴权 hook 产出。
    static let credentialFailureStatuses: Set<Int> = [401, 403]

    /// 这个失败是不是"在等凭证"。
    static func isCredentialFailure(statusCode: Int?) -> Bool {
        guard let statusCode else { return false }
        return credentialFailureStatuses.contains(statusCode)
    }

    static func disposition(statusCode: Int?, errorCode: String?) -> Action {
        // ① "现在不行"最先判：靠 code 与 429 两个入口（服务端实际用的是 429）。
        if let errorCode, busyCodes.contains(errorCode) { return .backOffAndRetry }
        if statusCode == 429 { return .backOffAndRetry }
        // ② 服务端自身的问题。🔴 必须靠**状态码**判：`apiErrorPayload` 把 5xx 的 code
        // 一律抹成 `internal_error`，507（空间不足）也一样 ⇒ 按 code 判会全部漏掉。
        if let statusCode, (500...599).contains(statusCode) { return .keepForNextWake }
        if statusCode == nil {
            // 传输层失败（断网 / 超时 / 连接被拒）。服务端可能已受理但响应丢了，
            // 沿用同一 batchId 让幂等键去决定要不要新建来源。
            return .keepForNextWake
        }
        // ③ 这一批被确定性地拒绝 ⇒ 永不重传。
        if let errorCode, contentRejectionCodes.contains(errorCode) { return .abandonBatch }
        if let statusCode, contentRejectionStatuses.contains(statusCode) { return .abandonBatch }
        // ④ 其余 4xx（401/403/404/…）说的是**通道**不是**字节**：留着本批，
        // 把 token / 地址修好之后用同一个 batchId 重传，比重新导出一次便宜得多。
        // 这条是**有意的默认**：未知 4xx 宁可留着批次也不误删一次有效导出 ——
        // 留着的最坏后果是磁盘上多一个文件，删掉的最坏后果是白读一次 HealthKit。
        return .keepForNextWake
    }
}
