import Foundation

/// 「这一页的候选游标现在能不能提交」——判定结果。
///
/// 为什么是二态 + 理由，而不是一个 `Bool`：`false` 有四种**完全不同**的原因
/// （阻塞阶段 / 根本没回执 / 回执没提交 / 老服务端不认这套协议），而它们的运维含义
/// 与用户可见后果都不一样。压成 `Bool` 之后，日志里只剩"没推进"，
/// 于是"老服务端一直在 hold"与"服务端提交失败"分不开 —— 前者要等升级，后者要重试。
nonisolated enum DirectSyncCursorDecision: Equatable, Sendable {
    case advance
    case hold(reason: String)
}

/// §5.1 / §10.1 / §10.2 的游标闸门：**每页游标只在对应持久回执之后推进**。
///
/// 它存在的理由是一条已经付过代价的纪律：`HealthKitSync` 过去只看服务端那个单一
/// `succeeded`，把"这一批字节被收下了"直接当成"可以提交游标了"。而 §10.2 明确写着
/// **老客户端的单一 `succeeded` 不能被解释成"最新分析已完成"** —— 更危险的是反方向：
/// 一个 `receiving` / `validating` 的批次也会有一段"看起来成功了"的窗口，
/// 一旦据此推进游标，那段窗口再也不会被重读（§5.1「不把"导出过一批"当作
/// HealthKit 通知已全部处理」）。
///
/// 刻意住在纯 Foundation 里：`HealthKitSync.swift` 不被任何回归脚本编译，
/// 判据留在那里就只能靠真机复现。
nonisolated enum DirectSyncCursorPolicy {
    /// `hold` 的四种理由。它们是**对外契约**（T3 的接线、回归断言、诊断日志都在读），
    /// 改名等于改判据。
    ///
    /// - `blocked`：阶段本身不允许推进（锁屏 / 等凭证）。
    /// - `no_receipt`：手里没有任何回执 —— 老服务端的 `succeeded` 不算回执。
    /// - `not_committed`：有回执，但事实还没持久提交。
    /// - `server_contract_missing`：服务端没宣告 `factsAnalysisContractVersion`。
    static let blockedReason = "blocked"
    static let noReceiptReason = "no_receipt"
    static let notCommittedReason = "not_committed"
    static let serverContractMissingReason = "server_contract_missing"

    /// 这一页的候选游标能不能提交成已提交游标。
    ///
    /// 判定顺序就是优先级，且前两条**必须**在最前：
    ///   1. `SyncPhase.mayAdvanceAnchor`：「阻塞态绝不推进 anchor」这条不变式的唯一出处是
    ///      `SyncPhase`（文档 §3.4「绝对严禁视为空数据 (0 Workouts) 推进 Anchor!」）。
    ///      在这里再抄一份阻塞阶段清单，就等于赌 `SyncPhase` 永远不会有第三个阻塞态 ——
    ///      一旦有了，本闸门会**静默地**放行它，而代价正是那条不变式想拦住的东西。
    ///   2. 没有候选游标要提交就放行：这条判据住在这里而不是调用方的 `if`，否则
    ///      "没有游标"这条路径永远不被任何断言走过 —— 闸门本身要能回答"现在不用提交"。
    ///
    /// 第三条 `requiresReceipt` 是**语义入签名**，不是让调用点各自短路：
    ///   - `false` = 这一页的游标**不依赖**服务端确认（老行为）。最典型的例子是
    ///     `POST /v1/imports/inspect` 回 `unchanged`（服务端明确回答"这批不必导入"）：
    ///     那条路径上**没有新回执可等**，若照样要求回执就会 `.hold(no_receipt)` ——
    ///     水位与游标一个字都不写，下一轮服务端照样回 `unchanged` ⇒ **自锁**，
    ///     而且永远好不了（没有哪一轮会突然变出一个回执）。
    ///   - `true` = 这一页的游标"只有服务端确认过才敢提交"，走下面四条回执判据（§10.2）。
    ///
    /// ⚠️ 为什么不写成 `receipt == nil && requiresReceipt`：那是把两件事挤进一个布尔。
    /// `requiresReceipt` 说的是"这一页**适不适用**回执协议"，与"回执到没到"无关；
    /// 混起来之后，"不适用"与"还没到"在日志里再也分不开 —— 前者永远不该重试，
    /// 后者应该等下一轮。
    ///
    /// - Parameters:
    ///   - serverContractVersion: `/v1/handshake` 的 `factsAnalysisContractVersion`。
    ///     `nil` / 小于 `DirectSyncReceipt.factsAnalysisContractVersion` 都算"老服务端"：
    ///     它不认这套协议，它的 `succeeded` 不得冒充回执（§10.2）。
    ///   - receipt: 服务端 `summary.directSync`。`nil` = 没拿到。
    ///   - pendingCursorsPresent: 这一页是否有候选游标要提交。
    ///   - requiresReceipt: 这一页的候选游标是否"只有服务端确认后才敢提交"。
    ///     只有 `true` 时下面四条回执判据才适用 —— 传 `false` 的调用点必须能说出
    ///     "这一页为什么不需要回执"，因为那正是"不推进游标就永远推不动"的那一类路径。
    ///   - phase: 当前同步阶段，只用来取那条既有不变式。
    static func decision(
        serverContractVersion: Int?,
        receipt: DirectSyncReceipt?,
        pendingCursorsPresent: Bool,
        requiresReceipt: Bool,
        phase: SyncPhase
    ) -> DirectSyncCursorDecision {
        guard SyncPhase.mayAdvanceAnchor(phase) else { return .hold(reason: blockedReason) }
        if !pendingCursorsPresent { return .advance }
        // 不适用回执协议的页面：老行为的出口，必须在任何回执判据**之前**。
        guard requiresReceipt else { return .advance }
        guard let receipt else { return .hold(reason: noReceiptReason) }
        guard receipt.isCommitted else { return .hold(reason: notCommittedReason) }
        // 能力位与回执**一起**看：服务端给了回执却没宣告能力位，是一份自相矛盾的回答
        // （旧版本 / 中间层 / 回放）。推进游标是不可逆的，这里只往安全方向倒。
        guard let version = serverContractVersion else {
            return .hold(reason: serverContractMissingReason)
        }
        guard version >= DirectSyncReceipt.factsAnalysisContractVersion else {
            return .hold(reason: serverContractMissingReason)
        }
        return .advance
    }

    /// 「后台待办意图还要不要留着」= 这一轮**还没 drain 完**。
    ///
    /// §5.1 的原文是「仍有下一页时持久保存 `needsContinuation`，再发下一批」，
    /// 而 §10.2 补了一句它的后果：「连续分页尚未 drain 完时，不清空后台待办意图」。
    /// 两者是同一条判据的两面。
    ///
    /// - Parameters:
    ///   - hasMorePages: 刚刚读完的那一页是否还有下一页。
    ///   - receipt: 这一批的持久回执。
    ///   - deletionOnlyPage: 刚刚读完的那一页是否是"删除-only"（`added` 为空、`deleted` 非空）。
    ///   - requiresReceipt: 这一**轮**是不是"只有拿到持久回执才算确认过"。
    ///     `false` = 这一轮根本不等回执（老服务端 §10.2「保留旧等待含义」，或服务端明确回答
    ///     "这批不必导入"的 `unchanged` 收尾）—— 那种轮次里不存在"未确认批次"，若照样返回
    ///     `true`，每一轮都清不掉后台意图 = **无限重跑**（每轮白读一次 HealthKit）。
    ///
    /// 🔴 **删除-only 页面不是 EOF**（§5.1 原文）。它带回的是 HealthKit 变更集里的一批删除，
    /// 而"这一页没有新增"不能推出"这类样本已经读完"。把删除-only 当 EOF，等于把后面
    /// 还没读到的新增整段跳过 —— 而且跳过之后**没有任何症状**：下一轮从已提交游标起步，
    /// 那些样本不会出现在任何一次查询里。
    ///
    /// 代价只是多查一页：`deletionOnlyPage` 描述的是**刚消费完**的那一页，
    /// 下一次 anchored query 会从它的 `next` 之后起步，若真的到底了就会返回空页
    /// （两个集合都空 ⇒ 既不是 deletion-only，也没有下一页）⇒ 这时才判为 drain 完。
    /// 所以这里不会自锁。
    ///
    /// 回执那一侧同理：**未确认的批次不得当作已 drain**。`nil`（没回执）与
    /// `rejected` / `applying` 一样都算未确认 —— "服务端还没说这批事实落盘了"，
    /// 后台意图一旦清空，用户不打开 App 就再也没人接着发下一批。
    ///
    /// ⚠️ `requiresReceipt == false` **只豁免回执那一条**，两条分页判据照旧生效：
    /// §5.1 的「仍有下一页时持久保存 `needsContinuation`」讲的是 HealthKit **读**到哪儿了，
    /// 与服务端认不认这套协议无关。把它一起豁免掉，等于"换了老服务端之后分页规则静默失效"
    /// —— 而 §5.1 的记录/字节预算一旦落地，`hasMorePages` 就不再恒为假了。
    static func continuationNeeded(
        hasMorePages: Bool,
        receipt: DirectSyncReceipt?,
        deletionOnlyPage: Bool,
        requiresReceipt: Bool
    ) -> Bool {
        if hasMorePages { return true }
        if deletionOnlyPage { return true }
        guard requiresReceipt else { return false }
        guard let receipt, receipt.isCommitted else { return true }
        return false
    }

    /// 给展示层的**语义**通知。刻意不带文案字符串（§10.3 的六句用户文案属于展示层）。
    ///
    /// 为什么要有 `factsSavedAnalysisNotRequired` 这个独立 case，而不是把它并进
    /// `factsSavedAnalysisPublished`：`not_required` 说的是「本批在结构上不影响分析」，
    /// 不是「分析已更新」（§9.1）。并起来会让用户看到一句**关于分析的假话**。
    ///
    /// ⚠️ 上面这几处引用刻意用「」而不是 ASCII 双引号：§10.3 那六句是**展示层的文案**，
    /// 而 `check-direct-sync-status-copy.py` 靠"哪个文件的代码里出现了带引号的整句"来认
    /// 文案持有者。注释里用 ASCII 双引号逐字引用那些句子，与真实的 Swift 字符串字面量
    /// 在文本上同形，任何不做注释剥离的扫描都会把本文件算成第二个文案持有者（假阳）。
    nonisolated enum DirectSyncNotice: Equatable, Sendable {
        /// 事实还在收 / 还在写。§10.3 的「正在保存新增与更正记录」。
        case savingFacts
        /// 事实已保存，分析另有状态。带上原始状态是为了让展示层区分排队与运行中。
        case factsSavedAnalysisPending(DirectSyncAnalysisStatus)
        case factsSavedAnalysisFailed
        case factsSavedAnalysisPublished
        /// 本批不影响分析 —— **不是**「分析已更新」。
        case factsSavedAnalysisNotRequired
    }

    /// 回执 → 通知。`nil` 表示"没有可说的话"。
    ///
    /// 两种情况返回 `nil`，都不许编一句话：
    ///   1. 没有回执（老服务端 / 还没拿到）—— 缺信息时说什么都是猜（§10.2）；
    ///   2. `rejected` —— 事实**没有**保存，本枚举的每一句都以"已保存"或"正在保存"开头，
    ///      一句都不能用。这条失败由调用方自己的错误通道负责，不能借这里的话术糊过去。
    static func notice(for receipt: DirectSyncReceipt?) -> DirectSyncNotice? {
        guard let receipt else { return nil }
        switch receipt.ingestStatus {
        case .receiving, .validating, .applying:
            return .savingFacts
        case .rejected:
            return nil
        case .committed:
            switch receipt.analysisStatus {
            case .notRequired: return .factsSavedAnalysisNotRequired
            case .queued, .running: return .factsSavedAnalysisPending(receipt.analysisStatus)
            case .published: return .factsSavedAnalysisPublished
            case .failed: return .factsSavedAnalysisFailed
            }
        }
    }

    /// 分析那一半的**终态对账**：把 `GET /v1/jobs/:id` 的终态折成一个可展示的分析状态。
    ///
    /// 为什么必须另开一条通道：回执里的 `analysisStatus` 是服务端 **COMMIT 时刻**的快照
    /// （直连车道恒写 `queued`，见 `apps/api/src/direct-sync-ingest.ts`），而
    /// `readImportReceiptInDatabase` 只写不改 —— 分析跑完之后**没有任何东西**会把回执改成
    /// `published` / `failed`。所以 §10.3 的「分析已更新」与「健康数据已保存，分析更新失败，
    /// 可重试分析」两句，只靠回执**永远不可达**；补上这一格，它们才第一次有真值来源。
    ///
    /// 🔴 **不许把回执改写**（§8.5）：本函数只**返回一个结论**，回执那份"服务端当时提交了什么"
    /// 的记录保持逐字节不变。调用方把结论存到**另一个**槽里（`SyncTaskStore` 的对账槽），
    /// 界面上"事实已保存"与"分析到哪了"因此是两个独立结论，不会互相冒充（§9.1）。
    ///
    /// ## 语义：只有拿到终态才改写
    ///
    /// - `jobStatus` 取值来自服务端 `recompute_jobs.status`（`GET /v1/jobs/:id` 的读侧投影，
    ///   `apps/api/src/data.ts` 的 `mapJobFromDomain`）。词表是
    ///   `queued` / `running` / `succeeded` / `failed` / `cancelled`：
    ///   * `succeeded` ⇒ `.published`（分析真的发布了）；
    ///   * `failed` **且** `jobFailed` ⇒ `.failed`（`.failed` 会被展示成"可重试分析"，
    ///     而**取消**不是失败 —— 见下一条，两者必须分开）；
    ///   * `queued` / `running` ⇒ `nil`（还在跑，"没问到终态"不许被当成任何结论）；
    ///   * `cancelled` ⇒ `nil`：§10.1 的「raw提交后用户取消分析：不宣称raw已撤销；只停止分析，
    ///     保留待更新提示」。把取消说成"分析更新失败，可重试分析"是**另一句话**，而且是错的；
    ///   * 认不出的字面量 / `nil` ⇒ `nil`。服务端将来加状态时，客户端的方向必须是"继续等"，
    ///     不是"猜一个"（与 `DirectSyncAnalysisStatus` 解码故意不兜底同源）。
    ///
    /// ## 两个"不改写"的保护
    ///
    /// 1. **回执没提交就不对账**：`ingestStatus != committed` 时事实那一半还没有结论，
    ///    此刻谈分析毫无意义。
    /// 2. **已经在终态的分析状态不会被 `succeeded` 覆盖成另一种**：
    ///    * `not_required` —— 服务端在入口就证明了本批**结构上不可能**动到分析（§9.1）。
    ///      它是"本批没有分析任务"，不是"分析跑完了"；用一次 `succeeded` 把它改写成
    ///      `.published`，会让界面说一句**关于分析的假话** —— 而这正是这个 case 存在的
    ///      全部理由。生产路径上 `not_required` 的批次也没有 `analysisJobId`（服务端写 `null`），
    ///      根本不会走到这里；这一格是**结构性防线**，不是样本观察。
    ///    * `published` / `failed` —— 已经确认过的终态不被一次**滞后读**打回去。
    ///      到达顺序不受我们控制（对账请求可能与前一轮同步交错），"新一点的读"不等于
    ///      "更新的结论"。
    ///
    /// ⚠️ 与 `notice(for:)` 的分工：本函数只回答"分析那一半现在是什么"，**不产出任何文案**。
    /// 展示层拿它替换进回执副本再过 `notice(for:)` —— "哪种回执说什么话"因此仍只有一份判据。
    ///
    /// - Parameters:
    ///   - receipt: 这一批的持久回执。
    ///   - jobStatus: `GET /v1/jobs/:id` 的 `status`；`nil` = 没问到。
    ///   - jobFailed: 该任务是不是**执行失败**（`error.code == task_failed`）。刻意与
    ///     `jobStatus` 分开："取消"与"失败"在服务端都是任务停下来了，但对用户是两件事。
    static func reconcileAnalysis(
        receipt: DirectSyncReceipt?,
        jobStatus: String?,
        jobFailed: Bool
    ) -> DirectSyncAnalysisStatus? {
        guard let receipt, receipt.isCommitted else { return nil }
        // 已经确认过的结论不被改写（不倒退、也不"改写语义"）。
        //
        // 🔴 `notRequired` 与 `published` / `failed` **同类**，这一格是无条件的，不许靠
        // "调用方不会给出这种输入"来省掉：`not_required` 是**第一类终态**（"本批在结构上
        // 不可能影响分析"，§9.1），它**不是**"分析还没出结果"。今天生产路径上确实到不了这里
        // （服务端对 `record-only` 写 `analysisJobId: null`，对账根本不会发起），但那是**结构性
        // 论证**，不是判据：将来任何一个新入口（回填、重放、或一次误配的 `analysisJobId`）
        // 给出这个组合时，`break` 会让一次 `succeeded` 把"本批无需分析"改写成「分析已更新」——
        // 一句关于分析的假话直接送到用户面前，而这正是 §9.1 点名的失效形态。
        // 防线写成无条件，代价是零。
        switch receipt.analysisStatus {
        case .published, .failed, .notRequired: return nil
        case .queued, .running: break
        }
        switch jobStatus {
        case "succeeded": return .published
        case "failed": return jobFailed ? .failed : nil
        default: return nil
        }
    }
}

/// 分析终态对账的**持久**结论（`SyncTaskStore.sync_analysis_reconcile` 槽的 payload）。
///
/// ## 为什么要有这么一个独立的持久槽
///
/// `markSuccess` 的 `commitSuccess` 在**同一个事务**里做「水位前进 + 任务行清空」
/// （`SyncTaskStore.commitSuccess` 的自述："要么都成、要么都不成"）。而终态对账按设计发生在
/// **游标提交之后** —— 那一刻 `sync_tasks` 里那一行已经没了。于是：
///
/// * 结论**不能**住在 `SyncTaskState`（在飞任务的 payload）里，否则它活得比任务短：
///   要么把刚清掉的任务行写回去（界面又说"还卡着一批"，污染后台意图判据），
///   要么把对账挪到 `commitSuccess` 之前（一次**已经成功入库**的同步会被一个展示动作报成失败）。
/// * 结论也**不能**只住在内存里：App 在"分析还在跑"时被杀，重启后就没有任何东西
///   记得"该去问哪条任务"了 —— §10.3 的「分析已更新」于是又要等下一次完整同步才可能出现，
///   而 §10.1 的「重启丢进度：从主库 receipt/analysis jobs 恢复」要求的正是**不依赖 runtime**。
///
/// 所以它单独落盘，按 `scope` 索引，与 `sync_record_cursors` / `sync_route_discovery` 并列。
/// 生命周期与任务行**无关**：任务收尾了它还在，直到同一 scope 的下一批把它覆盖。
///
/// ## 字段语义
///
/// * `receiptId` —— 这份结论说的是**哪一批**。没有它，"重启后接着问"会问错批次。
/// * `analysisJobId` —— 要问的那条 `recompute_jobs` 任务。`nil` = 本批不登记分析
///   （`record-only`：服务端如实写 `null`）⇒ 没有要跟踪的东西。
/// * `analysisStatus` —— 回执 COMMIT 时刻快照 + 已经对账到的终态。**终态一旦到达就不再变**：
///   重试/回退会让界面把一句已经确认过的话又改回"更新中"。
/// * `ingestStatus` —— 事实那一半。`committed` 之外一律不进行对账：事实还没落盘时谈分析毫无意义。
///
/// ⚠️ `nonisolated` 与本文件其他类型同源：本仓有编译面开启 `-default-isolation MainActor`
/// （见 `apps/ios/tests/run-model-tests.sh` 的 WorkoutKit 那一组），不写它会让这个类型只在
/// 主 actor 上可用，而读写它的 `SyncTaskStore` 是**非隔离**的存储层。
nonisolated struct DirectSyncAnalysisReconcile: Codable, Equatable, Sendable {
    /// 该批次持久回执的 id（= `DirectSyncReceipt.receiptId`）。
    let receiptId: String
    /// 事实那一半，取 `DirectSyncIngestStatus` 的原始值。
    let ingestStatus: DirectSyncIngestStatus
    /// 分析那一半的**当前**结论。
    var analysisStatus: DirectSyncAnalysisStatus
    /// 要跟踪的分析任务；`nil` = 本批没有分析任务。
    let analysisJobId: String?
    /// 最近一次写下这份结论的时刻（`Date`，与 `SyncTaskState` 同一套编码策略）。
    ///
    /// `var` 而不是 `let`：它是**观察时间**，不参与"要不要对账"的判据，但诊断时必须有 ——
    /// 否则"这条结论是什么时候问到的"只能靠猜，而它正是"分析更新中"挂了多久的唯一线索。
    var observedAt: Date

    /// 分析是不是已经到终态（`published` / `failed`）。
    ///
    /// `not_required` **不算终态分析**：它说的是"本批结构上不影响分析"（§9.1），
    /// 不是"分析跑完了"。把它并进终态，界面上"分析已更新"与"本批无需分析"就会变成同一格。
    var hasTerminalAnalysis: Bool {
        analysisStatus == .published || analysisStatus == .failed
    }

    /// 还需不需要去问一次终态。
    ///
    /// 两个前提缺一不可：**事实已提交**（否则分析那一半没有任何意义）且**存在要问的任务 id**。
    /// 第三个条件是分析还没到终态。`nil` / 空串的 id 一律算"没有任务"：空串会让
    /// 对账去请求 `/v1/jobs/`，那是一条**恒 404** 的路径，而它的症状是"永远问不到终态"，
    /// 与"分析还在跑"在界面上长得一模一样。
    var needsReconcile: Bool {
        guard !hasTerminalAnalysis else { return false }
        guard ingestStatus == .committed else { return false }
        guard let analysisJobId, !analysisJobId.isEmpty else { return false }
        return true
    }
}
