import Foundation

/// B07 pure execution-review policy.
///
/// All wording and eligibility rules live here so the regression can pin the
/// distinctions that are easy to lose in a view: pending confirmation is neither
/// completed nor incomplete, `partial` is not `unknown`, and a missing execution
/// view means "unknown" rather than an empty history.
enum TrainingPlanExecutionPolicy {
    enum Tone: Equatable { case neutral, positive, warning, danger }

    struct Review: Equatable {
        let statusTitle: String
        let statusDetail: String
        let tone: Tone
        let planSummary: String
        let actualLines: [String]
        let doseText: String
        let stimulusText: String
        let completionText: String
        let claimsCompletion: Bool
        let reasonTexts: [String]
    }

    struct HistoryRow: Equatable, Identifiable {
        let sessionId: String
        let localDate: String
        let kind: String
        let statusTitle: String
        let detail: String
        let tone: Tone
        var id: String { sessionId }
    }

    static let associationValues: Set<String> = ["unlinked", "pending_confirmation", "confirmed", "invalidated"]
    static let lifecycles: Set<String> = ["pending", "completed", "partial", "skipped", "cancelled"]
    static let doseStatuses: Set<String> = ["met", "partial", "not_met", "not_assessable"]
    static let stimulusStatuses: Set<String> = ["matched", "too_hard", "too_easy", "not_assessable"]
    static let completionValues: Set<String> = ["confirmed", "known_not_met", "unconfirmed", "not_applicable"]
    static let observationValues: Set<String> = ["observed", "unknown"]
    static let evidenceLevels: Set<String> = ["measured_steps", "reconstructed_segments", "summary_only", "none"]
    static let candidateEvidence: Set<String> = ["verified_identity", "needs_confirmation"]

    private static let zone = TimeZone(identifier: TrainingPlanUnifiedPolicy.businessTimeZone)
        ?? TimeZone(secondsFromGMT: 8 * 3600) ?? TimeZone.current

    // MARK: - Wire validation

    /// Returns a readable failure reason, or nil when the candidate page is
    /// bound to exactly the current session/instance/revisions.
    static func validate(
        _ response: TrainingPlanExecutionCandidatesResponse,
        identity: PlanReceiptScope,
        planInstanceId: String,
        sessionId: String,
        sessionRevision: Int,
        executionRevision: Int,
        expectedStateRevision: Int
    ) -> String? {
        guard response.contractVersion == 1 else { return "执行候选合同版本不受支持" }
        guard response.scope == identity, !identity.serverId.isEmpty, !identity.athleteId.isEmpty,
              !identity.datasetEpoch.isEmpty else { return "执行候选来自其他数据域" }
        guard response.planInstanceId == planInstanceId else { return "执行候选属于其他计划实例" }
        guard response.sessionId == sessionId else { return "执行候选属于其他课程" }
        guard response.sessionRevision == sessionRevision else { return "课程修订已变化，请重读后再选" }
        guard response.executionRevision == executionRevision else { return "执行修订已变化，请重读后再选" }
        guard response.stateRevision == expectedStateRevision else { return "计划状态已变化，请重读后再选" }
        guard isValidLocalDate(response.rangeStart), isValidLocalDate(response.rangeEnd),
              response.rangeStart <= response.rangeEnd else { return "候选日期范围无效" }
        guard dayDistance(from: response.rangeStart, to: response.rangeEnd) <= 31 else {
            return "候选范围超过 31 天"
        }
        if let cursor = response.nextCursor, cursor.isEmpty { return "候选分页游标为空" }
        var seen = Set<String>()
        for candidate in response.candidates {
            guard !candidate.trainingSessionId.isEmpty,
                  seen.insert(candidate.trainingSessionId).inserted else { return "候选实际训练重复或缺失身份" }
            guard !candidate.sourceFactDigest.isEmpty else { return "候选缺少源事实摘要" }
            guard candidateEvidence.contains(candidate.evidence) else { return "候选证据类型未知" }
            guard let start = instant(candidate.startedAt), let end = instant(candidate.endedAt), start <= end else {
                return "候选起止时间无效"
            }
            if let distance = candidate.distanceMeters, (!distance.isFinite || distance < 0) { return "候选距离无效" }
            if let duration = candidate.durationSeconds, (!duration.isFinite || duration < 0) { return "候选时长无效" }
        }
        return nil
    }

    /// Validates one optional execution row. The store already validates the
    /// enclosing sessions view; this keeps the execution-specific invariants in
    /// one place for previews and tests.
    static func validate(execution: TrainingPlanSessionExecution, session: TrainingPlanSessionsView.Session) -> String? {
        guard execution.sessionId == session.sessionId else { return "执行行与课程身份不一致" }
        guard execution.executionRevision >= 0 else { return "执行修订不能为负" }
        guard associationValues.contains(execution.association) else { return "关联状态未知" }
        guard execution.prescriptionSessionRevision > 0,
              execution.prescriptionSessionRevision <= session.sessionRevision else {
            return "执行处方修订不可信"
        }
        guard instant(execution.availableAt) != nil else { return "执行行可得时间无效" }
        switch execution.association {
        case "unlinked":
            guard execution.trainingSessionId == nil, execution.sourceFactDigest == nil else {
                return "未关联执行行不应携带实际训练"
            }
        case "confirmed":
            guard let id = execution.trainingSessionId, !id.isEmpty,
                  let digest = execution.sourceFactDigest, !digest.isEmpty,
                  execution.executionRevision > 0 else {
                return "已确认关联缺少实际训练身份或摘要"
            }
        default:
            if let id = execution.trainingSessionId, id.isEmpty { return "执行训练身份为空" }
            if let digest = execution.sourceFactDigest, digest.isEmpty { return "执行摘要为空" }
            if (execution.trainingSessionId == nil) != (execution.sourceFactDigest == nil) {
                return "执行训练身份与摘要必须同时存在或同时缺省"
            }
        }
        if let assessment = execution.assessment {
            guard !assessment.version.isEmpty, assessment.policyStatus == "candidate",
                  isValidLocalDate(assessment.localDate), instant(assessment.asOf) != nil,
                  observationValues.contains(assessment.observation),
                  evidenceLevels.contains(assessment.evidenceLevel),
                  doseStatuses.contains(assessment.dose.status),
                  stimulusStatuses.contains(assessment.stimulus.status),
                  completionValues.contains(assessment.completion),
                  ["matched", "ambiguous", "unmatched"].contains(assessment.association.status) else {
                return "执行评价字段不可信"
            }
        }
        return nil
    }

    // MARK: - Presentation

    static func review(
        session: TrainingPlanSessionsView.Session,
        execution: TrainingPlanSessionExecution?,
        executionsKnown: Bool,
        linkedCandidate: TrainingPlanExecutionCandidate? = nil
    ) -> Review {
        let plan = planSummary(session.prescription)
        guard executionsKnown else {
            return .init(statusTitle: "执行视图未知", statusDetail: "当前服务没有返回执行关联视图；不能据此判断已完成或未完成。",
                tone: .neutral, planSummary: plan, actualLines: ["实际：未知（不是空历史）"],
                doseText: "剂量：未知（没有执行评价视图）", stimulusText: "刺激：未知（没有执行评价视图）",
                completionText: "完成评价：未知", claimsCompletion: false,
                reasonTexts: reasonTexts(execution?.reasonCodes ?? []))
        }
        guard let execution else {
            return .init(statusTitle: "尚未关联实际训练",
                statusDetail: "没有当前关联行；这不等于没有跑步，也不等于课程未完成。",
                tone: .neutral, planSummary: plan, actualLines: actualLines(execution: nil, linkedCandidate: nil),
                doseText: "剂量：尚未评估（未知）", stimulusText: "刺激：尚未评估（未知）",
                completionText: "完成评价：尚未评估", claimsCompletion: false, reasonTexts: [])
        }
        let status: (String, String, Tone)
        switch execution.association {
        case "confirmed":
            status = ("已关联实际训练", "计划与实际已唯一关联。", .positive)
        case "pending_confirmation":
            status = ("待确认实际训练", "服务端找到候选但不会自动确认；确认前不宣称完成或未完成。", .warning)
        case "invalidated":
            status = ("关联已失效", "源事实变化或关联冲突使当前结论失效；旧处方与旧评价仍可追溯，需重新确认或撤回。", .danger)
        default:
            status = ("尚未关联实际训练", "没有有效关联；这不等于没有跑步，也不等于课程未完成。", .neutral)
        }
        let assessment = execution.assessment
        let lifecycleText = lifecycleSummary(session.lifecycle, association: execution.association)
        let dose = doseText(assessment)
        let stimulus = stimulusText(assessment)
        let completion = completionText(assessment)
        let claims = execution.association == "confirmed" && ["completed", "partial"].contains(session.lifecycle)
        var details = [lifecycleText]
        if lifecycleText.contains("待确认") || lifecycleText.contains("不一致") { details.append("完成结论待确认") }
        let statusDetail = details.isEmpty ? status.1 : status.1 + " " + details.joined(separator: "；")
        return .init(statusTitle: status.0,
            statusDetail: statusDetail,
            tone: status.2, planSummary: plan,
            actualLines: actualLines(execution: execution, linkedCandidate: linkedCandidate),
            doseText: dose, stimulusText: stimulus, completionText: completion,
            claimsCompletion: claims, reasonTexts: reasonTexts(execution.reasonCodes))
    }

    static func planSummary(_ day: MobilePlannedDay) -> String {
        "计划：\(sessionName(day.kind)) · \(day.localDate) · \(distance(day.distanceKm))"
    }

    static func lifecycleSummary(_ lifecycle: String, association: String) -> String {
        switch lifecycle {
        case "completed":
            return association == "confirmed" ? "课程状态：已完成" : "课程状态与关联不一致，不宣称完成"
        case "partial":
            return association == "confirmed" ? "课程状态：部分完成（剂量不足）" : "课程状态与关联不一致，不宣称完成"
        case "skipped":
            return association == "confirmed" ? "课程状态冲突：已跳过但有确认关联，需核对" : "课程状态：已明确跳过"
        case "cancelled": return "课程状态：已取消"
        default:
            return association == "confirmed" ? "课程状态：已关联，等待课程完成确认" : "课程状态：待执行"
        }
    }

    static func doseText(_ assessment: WorkoutExecutionAssessment?) -> String {
        guard let assessment else { return "剂量：尚未评估（未知）" }
        if assessment.observation == "unknown" { return "剂量：无法评估（没有实际观测）" }
        switch assessment.dose.status {
        case "met": return "剂量：达标"
        case "partial": return "剂量：不足（partial，只记录实际完成的部分）"
        case "not_met": return "剂量：未达标"
        case "not_assessable": return "剂量：无法评估（证据不足，不是未完成）"
        default: return "剂量：未知"
        }
    }

    static func stimulusText(_ assessment: WorkoutExecutionAssessment?) -> String {
        guard let assessment else { return "刺激：尚未评估（未知）" }
        if assessment.observation == "unknown" || assessment.evidenceLevel == "none" {
            return "刺激：无法评估（没有实际观测）"
        }
        switch assessment.stimulus.status {
        case "matched": return "刺激：匹配"
        case "too_hard": return "刺激：偏强（不奖励过量执行）"
        case "too_easy": return "刺激：偏弱"
        case "not_assessable": return "刺激：无法评估（原始信号或步骤不足）"
        default: return "刺激：未知"
        }
    }

    static func completionText(_ assessment: WorkoutExecutionAssessment?) -> String {
        guard let assessment else { return "完成评价：尚未评估" }
        switch assessment.completion {
        case "confirmed": return "完成评价：确认完成"
        case "known_not_met": return "完成评价：明确未达标"
        case "unconfirmed": return "完成评价：未确认（不是未完成）"
        case "not_applicable": return "完成评价：不适用"
        default: return "完成评价：未知"
        }
    }

    static func actualLines(execution: TrainingPlanSessionExecution?, linkedCandidate: TrainingPlanExecutionCandidate?) -> [String] {
        var lines: [String] = []
        if let candidate = linkedCandidate {
            lines.append("实际：\(dateTime(candidate.startedAt)) → \(dateTime(candidate.endedAt))")
            lines.append("实际距离/时长：\(distanceMeters(candidate.distanceMeters)) · \(duration(candidate.durationSeconds))")
        } else if let assessment = execution?.assessment {
            if let meters = assessment.dose.observedDistanceMeters {
                lines.append("实际距离：\(distanceMeters(meters))（来自执行评价）")
            } else {
                lines.append("实际距离：未知")
            }
            if let seconds = assessment.dose.observedWorkSeconds {
                lines.append("实际工作时段：\(duration(seconds))（来自执行评价）")
            } else {
                lines.append("实际时长：未知")
            }
            lines.append("起止时间：执行视图未提供；可在候选列表查看")
        } else {
            lines.append("实际：尚未关联或未知")
        }
        return lines
    }

    static func candidateEvidenceText(_ evidence: String) -> String {
        switch evidence {
        case "verified_identity": return "可验证身份（仍需你确认）"
        case "needs_confirmation": return "需人工确认"
        default: return "证据未知"
        }
    }

    static func candidateActionTitle(association: String?, session: TrainingPlanSessionsView.Session) -> String {
        if session.lifecycle != "pending" { return "重新关联" }
        switch association {
        case "confirmed": return "改选为这条"
        case "invalidated": return "重新关联为这条"
        default: return "确认关联"
        }
    }

    /// UI may highlight a single candidate for convenience, but never submits it.
    /// Multiple same-day runs must stay ambiguous until the user taps one.
    static func preferredCandidateSelection(_ candidates: [TrainingPlanExecutionCandidate]) -> String? {
        candidates.count == 1 ? candidates[0].trainingSessionId : nil
    }

    static func canSkip(session: TrainingPlanSessionsView.Session,
                        execution: TrainingPlanSessionExecution?,
                        hasCandidates: Bool) -> Bool {
        guard session.lifecycle == "pending", !hasCandidates else { return false }
        guard let execution else { return true }
        return execution.association == "unlinked" && execution.trainingSessionId == nil
    }

    static func canRetract(_ execution: TrainingPlanSessionExecution?) -> Bool {
        guard let execution, ["confirmed", "invalidated"].contains(execution.association),
              let id = execution.trainingSessionId, !id.isEmpty,
              let digest = execution.sourceFactDigest, !digest.isEmpty else { return false }
        return true
    }

    /// Default candidate window is the session day ±2 (server rule). The user may
    /// widen to at most 31 natural days; this returns the maximum symmetric range.
    static func expandedRange(sessionDate: String) -> (start: String, end: String)? {
        guard let start = addDays(sessionDate, -15), let end = addDays(sessionDate, 15) else { return nil }
        return (start, end)
    }

    /// Newer state wins. A different plan instance is legitimate only with a
    /// strictly newer state revision; an old GET can never roll back a new write.
    static func acceptsSnapshot(incomingStateRevision: Int,
                                incomingPlanInstanceId: String?,
                                existingStateRevision: Int,
                                existingPlanInstanceId: String?) -> Bool {
        guard let incomingPlanInstanceId else { return true }
        guard let existingPlanInstanceId, existingPlanInstanceId != incomingPlanInstanceId else {
            return incomingStateRevision >= existingStateRevision
        }
        return incomingStateRevision > existingStateRevision
    }

    /// Managed past-session review. Uses the same unknown-vs-unlinked-vs-pending
    /// distinction as the detail view; never turns a missing row into "未完成".
    static func historyRows(sessions: [TrainingPlanSessionsView.Session],
                            executions: [TrainingPlanSessionExecution]?,
                            businessDate: String,
                            days: Int = 7) -> [HistoryRow] {
        guard isValidLocalDate(businessDate), let start = addDays(businessDate, -max(1, days)) else { return [] }
        return sessions.filter { $0.prescription.localDate < businessDate && $0.prescription.localDate >= start }
            .sorted { $0.prescription.localDate < $1.prescription.localDate }
            .map { session in
                let execution = executions?.first { $0.sessionId == session.sessionId }
                let review = review(session: session, execution: execution, executionsKnown: executions != nil)
                let detail = [review.actualLines.first, review.doseText]
                    .compactMap { $0 }.joined(separator: " · ")
                return .init(sessionId: session.sessionId, localDate: session.prescription.localDate,
                    kind: session.prescription.kind, statusTitle: review.statusTitle,
                    detail: detail, tone: review.tone)
            }
    }

    /// Human-readable copy for the frozen new-route error codes. Returning nil
    /// lets the caller fall back to the server's own message instead of hiding it.
    static func serverErrorMessage(_ code: String) -> String? {
        switch code {
        case "training_execution_source_changed":
            return "源训练记录已变化，当前关联失效；原处方与旧评价保留，请重读后重新确认或撤回。"
        case "training_execution_link_conflict":
            return "这次实际跑步已关联其他课程，不能重复认领；请先在原课程撤回或改选。"
        case "training_execution_revision_conflict":
            return "执行修订已变化，请重读课程与实际后再提交。"
        case "training_state_revision_conflict":
            return "计划状态已变化，请重读后再提交；原草稿仍保留。"
        case "training_session_revision_conflict":
            return "课程修订已变化，请重读后再提交；原草稿仍保留。"
        case "training_execution_commands_disabled":
            return "当前服务未启用执行关联，只能只读查看已有计划。"
        case "training_session_not_editable":
            return "当前课程已完成、部分完成、已跳过、已取消或已被替换，不能直接修改；执行纠错请走关联命令。"
        case "training_scope_mismatch", "training_plan_instance_mismatch":
            return "该操作属于其他数据域或计划实例，不能在当前训练计划下提交。"
        case "training_session_not_found":
            return "当前课程已不存在，请重读训练安排后重试。"
        case "training_session_storage_unavailable":
            return "训练存储暂不可用；结果尚未确认，请查询原操作，不要重复提交。"
        default:
            return nil
        }
    }

    static func reasonTexts(_ codes: [String]) -> [String] {
        codes.map { code in
            switch code {
            case "training_execution_source_changed": return "源事实已变化，当前关联失效"
            case "training_execution_link_conflict": return "该次实际训练已关联其他课程"
            case "training_execution_revision_conflict": return "执行修订已变化，请重读后重试"
            case "training_execution_association_ambiguous": return "存在多个候选，无法唯一确认"
            case "training_execution_association_unlinked": return "尚未关联实际训练"
            case "source_fact_deleted": return "源训练记录已删除，只能撤回"
            case "prescription_mismatch": return "实际训练与课程处方不匹配"
            case "work_dose_evidence_unavailable": return "缺少可测量的整课剂量证据，剂量无法评估"
            case "work_dose_not_bounded": return "课程工作步骤剂量没有边界，无法核对"
            case "rep_evidence_unavailable": return "缺少可验证的组次证据，无法核对间歇剂量"
            case "stimulus_evidence_unavailable": return "缺少原始信号或分段，刺激无法评估"
            case "segment_boundaries_invalid": return "实测分段边界不连续，不能用于核对"
            case "execution_structure_unavailable": return "课程结构不可用，无法核对剂量"
            case "prescription_not_available": return "开跑前没有可用的课程修订"
            case "training_observation_unknown": return "没有观测到这一天的实际训练"
            case "workout_associated_to_multiple_obligations": return "同一次跑步被多个课程候选引用，需人工选择"
            default: return code.isEmpty ? "未说明原因" : "其他原因：\(code)"
            }
        }
    }

    static func lifecycleText(_ value: String) -> String {
        switch value {
        case "pending": return "计划中"
        case "completed": return "已完成"
        case "partial": return "部分完成"
        case "skipped": return "已跳过"
        case "cancelled": return "已取消"
        default: return value
        }
    }

    // MARK: - Date helpers

    static func isValidLocalDate(_ value: String) -> Bool {
        TrainingPlanUnifiedPolicy.isValidLocalDate(value)
    }

    private static func addDays(_ value: String, _ days: Int) -> String? {
        guard isValidLocalDate(value) else { return nil }
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.timeZone = zone
        parser.dateFormat = "yyyy-MM-dd"
        guard let date = parser.date(from: value) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        guard let shifted = calendar.date(byAdding: .day, value: days, to: date) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: shifted)
    }

    private static func dayDistance(from start: String, to end: String) -> Int {
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.timeZone = zone
        parser.dateFormat = "yyyy-MM-dd"
        guard let startDate = parser.date(from: start), let endDate = parser.date(from: end) else { return .max }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.dateComponents([.day], from: startDate, to: endDate).day ?? .max
    }

    private static func instant(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    private static func dateTime(_ value: String) -> String {
        guard let date = instant(value) else { return value }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.timeZone = zone
        formatter.dateFormat = "M月d日 HH:mm"
        return formatter.string(from: date)
    }

    private static func distance(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "--" }
        return String(format: "%.1f km", locale: Locale(identifier: "en_US_POSIX"), value)
    }

    private static func distanceMeters(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "未知" }
        return value >= 1_000
            ? String(format: "%.2f km", locale: Locale(identifier: "en_US_POSIX"), value / 1_000)
            : String(format: "%.0f m", locale: Locale(identifier: "en_US_POSIX"), value)
    }

    private static func duration(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "未知" }
        let total = max(0, Int(value.rounded()))
        let hours = total / 3600, minutes = (total % 3600) / 60, seconds = total % 60
        if hours > 0 { return "\(hours)小时\(minutes)分" }
        if minutes > 0 { return seconds > 0 ? "\(minutes)分\(seconds)秒" : "\(minutes)分" }
        return "\(seconds)秒"
    }

    private static func sessionName(_ kind: String) -> String {
        switch kind {
        case "easy": return "轻松跑"
        case "steady": return "稳态跑"
        case "tempo": return "节奏跑"
        case "interval": return "间歇跑"
        case "long_run": return "长距离"
        case "race": return "比赛"
        case "recovery": return "恢复跑"
        case "rest": return "休息"
        default: return kind.isEmpty ? "未知训练" : kind
        }
    }
}
