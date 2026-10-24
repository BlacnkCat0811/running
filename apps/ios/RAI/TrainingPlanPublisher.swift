import Foundation
import Observation

/// A command journal shares the existing durable pending row with legacy writes.
/// It never invokes WorkoutKit. Network cancellation leaves the original intent.
@Observable @MainActor final class TrainingPlanPublisher {
    enum Phase: String { case idle, previewing, previewReady, persistingIntent, submitting, querying,
        committedAwaitingRead, ready, needsPreview, invalidated, retired, storageFailure }
    struct Context: Equatable {
        let baseURL: URL
        let cacheScope: String
        let identity: PlanReceiptScope
        let sessionID: UUID
        // In-memory comparison only. Credentials never enter the journal or diagnostics.
        let credential: String
    }
    private(set) var phase: Phase = .idle
    private(set) var preview: TrainingPlanCommandPreview?
    private(set) var message: String?
    private var draft: TrainingPlanCommandPreviewRequest?
    private var context: Context?
    private var generation = UUID()
    private var runningGeneration: UUID?
    private let api: RaiAPIClient
    private let persistence: any TrainingPlanCommandPersistence
    private let now: () -> Date
    var isBusy: Bool { runningGeneration != nil }
    var executionBlocked: Bool { isBusy || [.committedAwaitingRead, .storageFailure].contains(phase) }

    init(api: RaiAPIClient, persistence: any TrainingPlanCommandPersistence, now: @escaping () -> Date = Date.init) {
        self.api = api; self.persistence = persistence; self.now = now
    }
    func invalidate() {
        generation = UUID(); runningGeneration = nil; preview = nil; draft = nil; context = nil
        phase = .invalidated; message = nil
    }
    func cancelPreview() {
        // Only an in-flight preview is disposable. Submission/query generations
        // own a durable journal and must still be allowed to acknowledge results.
        guard !isBusy || phase == .previewing else { return }
        if phase == .previewing { runningGeneration = nil }
        generation = UUID(); preview = nil; draft = nil
        if phase != .committedAwaitingRead && phase != .storageFailure { phase = .idle }
    }
    func matchesPreview(action: TrainingPlanCommandAction, raceGoal: TrainingPlanRaceGoalDraft?) -> Bool {
        phase == .previewReady && draft?.action == action && draft?.raceGoal == raceGoal && preview != nil
    }
    private func valid(_ captured: Context, _ id: UUID, _ isCurrent: () -> Bool) -> Bool {
        context == captured && generation == id && isCurrent()
    }
    private static func instant(_ value: String) -> Date? {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    func makePreview(_ request: TrainingPlanCommandPreviewRequest, context: Context,
                     isCurrent: () -> Bool) async -> Bool {
        guard !isBusy, isCurrent(), request.operationScope == context.identity else { return false }
        self.context = context; generation = UUID(); let id = generation
        runningGeneration = id
        defer { if runningGeneration == id { runningGeneration = nil } }
        draft = nil; preview = nil; phase = .previewing; message = nil
        do {
            let value = try await api.previewTrainingPlanCommand(request, baseURL: context.baseURL, token: context.credential)
            guard valid(context, id, isCurrent) else { return false }
            guard value.contractVersion == 2, value.expectedStateRevision == request.expectedStateRevision,
                  Self.instant(value.expiresAt).map({ $0 > now() }) == true else {
                throw RaiAPIClientError.decoding("预览版本或有效期不可信，请重新预览。")
            }
            draft = request; preview = value; phase = .previewReady
            return true
        } catch {
            guard valid(context, id, isCurrent) else { return false }
            rejectPreview(error); return false
        }
    }
    func confirm(context: Context, isCurrent: () -> Bool) async -> TrainingPlanCommandResult? {
        guard !isBusy, self.context == context, isCurrent(), let draft, let preview,
              Self.instant(preview.expiresAt).map({ $0 > now() }) == true else {
            if !isBusy { phase = .needsPreview; message = "预览已失效，请保留草稿并重新预览。" }; return nil
        }
        let request = TrainingPlanCommandRequest(operationId: UUID().uuidString, operationScope: context.identity,
            expectedStateRevision: draft.expectedStateRevision, candidateId: preview.candidateId,
            action: draft.action, raceGoal: draft.raceGoal)
        return await persistAndSubmit(request, route: "training-command", context: context, isCurrent: isCurrent)
    }
    func refresh(revision: Int, context: Context, isCurrent: () -> Bool) async -> TrainingPlanCommandResult? {
        guard !isBusy, isCurrent() else { return nil }
        self.context = context; generation = UUID(); preview = nil; draft = nil
        let request = TrainingPlanRefreshRequest(operationId: UUID().uuidString, operationScope: context.identity, expectedStateRevision: revision)
        return await persistAndSubmit(request, route: "training-refresh", context: context, isCurrent: isCurrent)
    }
    private func persistAndSubmit<Value: Encodable>(_ request: Value, route: String, context: Context,
                                                    isCurrent: () -> Bool) async -> TrainingPlanCommandResult? {
        let id = generation
        runningGeneration = id
        defer { if runningGeneration == id { runningGeneration = nil } }
        do {
            let pending = persistence.pendingPublication(scope: context.cacheScope)
            guard !pending.isFailure, (pending.value ?? nil) == nil else {
                phase = .querying; message = "原操作结果尚待确认，请查询原操作。"; return nil
            }
            // Encode exactly once; all retries use these same Data bytes.
            let data = try JSONEncoder().encode(request)
            let envelope = try JSONDecoder().decode(TrainingPlanRefreshRequest.self, from: data)
            let intent = PendingPlanPublication(operationId: envelope.operationId, route: route, payload: data, preparedAt: now())
            phase = .persistingIntent
            guard persistence.savePublication(intent, scope: context.cacheScope) else {
                // No HTTP request was sent. Require a fresh preview, but keep
                // the editor retryable after storage recovers. storageFailure
                // is reserved for an unresolved acknowledgement or cleanup.
                preview = nil; draft = nil; phase = .needsPreview
                message = "发布意图未能落盘，尚未发送；存储恢复后请重新预览并确认。"; return nil
            }
            phase = .submitting
            let result = try await api.submitTrainingPlanCommand(intent, baseURL: context.baseURL, token: context.credential)
            guard valid(context, id, isCurrent) else { return nil }
            return try acknowledge(result, pending: intent, context: context)
        } catch {
            guard valid(context, id, isCurrent) else { return nil }
            // Even a cancelled HTTP task may already have committed. Keep the row.
            rejectSubmission(error, context: context); return nil
        }
    }
    func recover(context: Context, mayReplay: Bool, isCurrent: () -> Bool) async -> TrainingPlanCommandResult? {
        guard !isBusy, isCurrent() else { return nil }
        self.context = context; generation = UUID(); let id = generation
        runningGeneration = id
        defer { if runningGeneration == id { runningGeneration = nil } }
        let stored = persistence.pendingPublication(scope: context.cacheScope)
        guard !stored.isFailure else { phase = .storageFailure; message = "发布账目不可读，不能当作没有操作。"; return nil }
        guard let pending = stored.value ?? nil, ["training-command", "training-refresh"].contains(pending.route) else { return nil }
        phase = .querying; message = nil
        var attemptedReplay = false
        do {
            let envelope = try JSONDecoder().decode(TrainingPlanRefreshRequest.self, from: pending.payload)
            guard envelope.contractVersion == 2, envelope.operationScope == context.identity,
                  envelope.operationId == pending.operationId else {
                throw RaiAPIClientError.decoding("原操作属于其他身份或合同，不能在当前服务查询或重放。")
            }
            let query: PlanPublicationResult<TrainingPlanCommandResult> = try await api.planOperation(
                id: pending.operationId, baseURL: context.baseURL, token: context.credential)
            guard valid(context, id, isCurrent) else { return nil }
            guard query.operationId == pending.operationId else { throw RaiAPIClientError.decoding("查询返回其他操作") }
            switch query.status {
            case "committed":
                guard let result = query.result else { throw RaiAPIClientError.decoding("已保存操作缺少结果") }
                return try acknowledge(result, pending: pending, context: context)
            case "notFound":
                guard mayReplay, !Task.isCancelled else { message = "原操作未找到；当前只读，保留账目等待确认。"; phase = .needsPreview; return nil }
                if pending.route == "training-command" {
                    let command = try JSONDecoder().decode(TrainingPlanCommandRequest.self, from: pending.payload)
                    let expiry = command.candidateId.firstIndex(of: ":").flatMap { Self.instant(String(command.candidateId[command.candidateId.index(after: $0)...])) }
                    guard expiry.map({ $0 > now() }) == true else {
                        return try closeRejected(pending, context: context, message: "原操作未执行，预览已过期；请重新预览并确认。")
                    }
                }
                attemptedReplay = true
                let result = try await api.submitTrainingPlanCommand(pending, baseURL: context.baseURL, token: context.credential)
                guard valid(context, id, isCurrent) else { return nil }
                return try acknowledge(result, pending: pending, context: context)
            case "expired", "scopeMismatch":
                return try closeRejected(pending, context: context, message: "原操作已过期或属于其他数据域，账目已关闭；请核对历史后重新预览。")
            default: throw RaiAPIClientError.decoding("未知操作状态，原操作不会重放。")
            }
        } catch {
            guard valid(context, id, isCurrent) else { return nil }
            if attemptedReplay || (error as? RaiAPIClientError)?.httpStatus == 410 { rejectSubmission(error, context: context) }
            else { reject(error) }
            return nil
        }
    }
    private func acknowledge(_ result: TrainingPlanCommandResult, pending: PendingPlanPublication, context: Context) throws -> TrainingPlanCommandResult {
        guard result.contractVersion == 2, result.operationId == pending.operationId, result.stateRevision > 0, result.goalsRevision >= 0 else {
            throw RaiAPIClientError.decoding("写确认身份或版本不可信，保留原操作。")
        }
        guard persistence.saveTrainingPlanCommandWatermark(.init(stateRevision: result.stateRevision,
            goalsRevision: result.goalsRevision), scope: context.cacheScope) else {
            phase = .storageFailure; message = "服务端已保存，本地确认未能落盘；请查询原操作，不能新增执行。"; return result
        }
        phase = .committedAwaitingRead; preview = nil; draft = nil
        message = "已保存，等待完整状态刷新；不要重复提交。"
        return result
    }
    func finishRead(context: Context) -> Bool {
        guard self.context == context, phase == .committedAwaitingRead else { return false }
        guard persistence.savePublication(nil, scope: context.cacheScope) else {
            phase = .storageFailure; message = "已保存并重读，但操作账目未清除；请查询原操作。"; return false
        }
        phase = .ready; message = "已保存并刷新。"; return true
    }
    private func closeRejected(_ pending: PendingPlanPublication, context: Context, message: String) throws -> TrainingPlanCommandResult? {
        guard persistence.savePublication(nil, scope: context.cacheScope) else {
            phase = .storageFailure; self.message = "终局操作账目未能关闭，请恢复存储。"; return nil
        }
        phase = .needsPreview; self.message = message; return nil
    }
    /// A preview is stateless: a failure here never created a server operation or
    /// a local journal row. Do not reuse the submission wording ("结果尚未确认").
    private func rejectPreview(_ error: Error) {
        if let apiError = error as? RaiAPIClientError, let status = apiError.httpStatus {
            if status == 410 { phase = .retired }
            else if status == 409 || status == 422 { phase = .needsPreview }
            else { phase = .idle }
            message = apiError.localizedDescription
        } else {
            phase = .idle
            message = "预览未完成，尚未发送任何写入；请检查连接后重试。"
        }
    }
    private func reject(_ error: Error) {
        if let apiError = error as? RaiAPIClientError, let status = apiError.httpStatus {
            if status == 410 { phase = .retired }
            else if status == 409 || status == 422 { phase = .needsPreview }
            else { phase = .querying }
            message = apiError.localizedDescription
        } else {
            phase = .querying; message = "结果尚未确认，请查询原操作；关闭页面不会撤销服务端提交。"
        }
    }
    private func rejectSubmission(_ error: Error, context: Context) {
        reject(error)
        guard let status = (error as? RaiAPIClientError)?.httpStatus, [409, 410, 422].contains(status) else { return }
        guard persistence.savePublication(nil, scope: context.cacheScope) else {
            phase = .storageFailure; message = "操作已被拒绝，但本地账目未能关闭；请恢复存储。"; return
        }
        preview = nil; draft = nil
        if status == 409 && (error as? RaiAPIClientError)?.serverCode != "coach_policy_changed" {
            message = "当前状态或候选已变化。草稿仍保留，请重读后重新预览并确认。"
        }
        if status == 410 { message = "该接口已退役，本地待确认操作已关闭；请更新后重新预览。" }
    }
}
