import Foundation

/// 计划写路径的「终局答复 ⇒ 作废本地账目」判据（2026-10-15 审查 🔴-1 / 🟡-C1 / 🟡-C4）。
///
/// 共同根因：客户端对服务端返回的**终局状态 / 终局拒绝码**未执行本地持久化账目作废，
/// 于是本地前置守卫（`plan_publication_pending` / `hasPendingPlanReceipts` / 反馈账目）
/// 永久拦截后续写操作，UI 无出口（`clearCache` 只清 `cache_entries`、碰不到
/// `app_metadata`，见 `CacheStore.swift:373-378`）。
///
/// 判据的边界（为什么是白名单，而不是"4xx 皆终局"）：
/// - 401/408/423/429/5xx 是**瞬时**失败，重试方向安全，必须保留账目；
/// - 名单里的码是**内容级 / 身份级**终局：同一份字节重放永远不可能通过，
///   保留只会把本地写路径锁死、并把用户留在"重试永远失败"的提示里。
///
/// 三组名单都只收**服务端可产出**的稳定码（出处逐条标注）；服务端改码时改这里一处，
/// 并由 `ModelRegression` 的纯判据用例与 `check-direct-sync-contract-parity.py`
/// （拒收码全集钉死）共同兜底。
nonisolated enum PlanMutationDisposition {
    /// 计划发布的终局码（`plan-operations/:id` 查询状态与重放拒绝共用一个集合）。
    ///
    /// - `plan_operation_scope_mismatch` / `plan_operation_expired`：
    ///   `apps/api/src/mobile-goals.ts:255/260`（查询状态 `scopeMismatch`/`expired`）
    ///   与 `:274/280`（重放路径同语义抛错）。
    /// - `plan_operation_key_conflict`：`apps/api/src/mobile-goals.ts:279`
    ///   （同一 operationId 用于不同请求 ⇒ 本地留存的这份载荷永远不可能被接受）。
    /// - `coach_loop_contract_required`（2026-10-18 深度审查 P3-19）：
    ///   `apps/api/src/server.ts:418` 的 preHandler 对**受教练合同管理**的数据集拒绝一切
    ///   legacy 写路由（`/v1/mobile/goals`、`/v1/mobile/workout-plan/**` 等），恒 409。
    ///   同一份 legacy 载荷在该数据集上重放**永远不可能成功**，而保留账目会把
    ///   `hasPendingPlanPublication` 永久钉住（用户再也无法发布新计划）。
    /// - `legacy_surface_retired`（2026-10-21，PR-01）：产品已退役 `/goals`、
    ///   `/run-coach`、`/workout-plan/preview|confirm|generate`（`server.ts`
    ///   `retiredLegacyRoutes`），旧载荷重放只会得到 410。它不是一次"结果未知"，
    ///   必须视为终局并关闭 pending 发布；系统排期账目/回执/水位不在清除范围内。
    static let terminalPlanPublicationErrorCodes: Set<String> = [
        "plan_operation_scope_mismatch",
        "plan_operation_expired",
        "plan_operation_key_conflict",
        "coach_loop_contract_required",
        "legacy_surface_retired"
    ]

    /// 手表排期回执的**内容级**终局拒绝码（同一份字节重放永远失败）。
    ///
    /// - `plan_receipt_scope_mismatch`：`apps/api/src/server.ts:1225`；
    /// - `plan_receipt_contract_mismatch` / `plan_receipt_date_invalid` /
    ///   `plan_receipt_evidence_mismatch`：`apps/api/src/server.ts:1219/1224/1230`；
    /// - `plan_receipt_key_conflict`：`apps/api/src/mobile-goals.ts:494/510`；
    /// - `coach_receipt_contract_mismatch` / `coach_receipt_evidence_mismatch`：
    ///   `apps/api/src/coach-loop-device-sync.ts:19/25`（教练回执通道的同族码）。
    /// - `coach_loop_contract_required`（2026-10-18 深度审查 P3-19）：
    ///   `apps/api/src/server.ts:418` 的 preHandler 覆盖 `/v1/mobile/workout-plan/**`
    ///   （前缀匹配）⇒ **受教练合同管理**的数据集上，legacy 回执 POST 恒 409。同一份回执
    ///   在管理期内不可能被接受；保留它会让 `hasPendingPlanReceipts` 恒真、把教练启用与
    ///   后续写路径永久锁死（用户无出口）。
    ///
    /// ⚠️ 仍**不**收 `plan_snapshot_changed` / `coach_snapshot_changed` / `database_busy`：
    /// 那些 503 是"读期间事实变化，可安全重读"，恰恰必须保留账目（`TrainingPlanStore`
    /// 还会按 `Retry-After` 退避重读）。
    ///
    /// ⚠️ 刻意**不**收 `coach_receipt_unknown_schedule` / `coach_receipt_unknown_prescription`
    /// （`coach-loop-device-sync.ts:45/56`）：它们依赖服务端"当时的已发布事实"，
    /// 服务端状态推进后同一份回执有可能通过，不属于内容级终局 —— 保留重试是安全方向。
    static let terminalPlanReceiptErrorCodes: Set<String> = [
        "plan_receipt_scope_mismatch",
        "plan_receipt_contract_mismatch",
        "plan_receipt_date_invalid",
        "plan_receipt_evidence_mismatch",
        "plan_receipt_key_conflict",
        "coach_receipt_contract_mismatch",
        "coach_receipt_evidence_mismatch",
        "coach_loop_contract_required"
    ]

    /// 教练反馈的终局拒绝码：原白名单（`NativeAppModel` 内联数组，2026-10-15 前）
    /// 并入 `coach_scope_mismatch`（`apps/api/src/coach-loop-routes.ts:41`）——
    /// 它表示"这份反馈属于另一个数据集"，同一份字节重试永远失败（审查 🟡-C4）。
    static let terminalCoachFeedbackErrorCodes: Set<String> = [
        "coach_feedback_invalid",
        "coach_feedback_revision_conflict",
        "coach_feedback_not_found",
        "FST_ERR_VALIDATION",
        "coach_scope_mismatch"
    ]

    static func isTerminalPlanPublicationError(_ code: String) -> Bool {
        terminalPlanPublicationErrorCodes.contains(code)
    }

    /// HTTP 410 is the protocol-level "gone" answer: whatever the server calls it,
    /// the same request can never succeed again. Unknown 410 codes are therefore
    /// terminal too (PR-01: "未知 410 同样不进入自动重试"), while 409/429/503 stay
    /// retryable because they can describe a state that may later change.
    static func isTerminalPlanPublicationStatus(_ status: Int) -> Bool {
        status == 410
    }

    static func isTerminalPlanReceiptError(_ code: String) -> Bool {
        terminalPlanReceiptErrorCodes.contains(code)
    }

    static func isTerminalCoachFeedbackError(_ code: String) -> Bool {
        terminalCoachFeedbackErrorCodes.contains(code)
    }
}
