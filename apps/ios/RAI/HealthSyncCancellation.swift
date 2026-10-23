import Foundation

nonisolated enum HealthSyncPolling {
    static func delay(elapsed: Duration) -> Duration {
        elapsed < .seconds(30) ? .seconds(2) : .seconds(5)
    }

    static func shouldRetryHTTP(statusCode: Int?) -> Bool {
        guard let statusCode else { return false } // terminal job failure is not a reconnect
        return statusCode == 429 || (500...599).contains(statusCode)
    }
}

/// 「恢复上次同步任务」这条路走不通时，那个持久化的 task 该怎么处置。
///
/// 之所以要有这条判据：`inspect` 收到 404 时若把 task 留着，App 就**再也不会重新上传**。
/// 任务失败时服务端会就地删除那份暂存上传
/// （`apps/api/src/import-source-finalization.ts:35-39` → `cleanupUpload` → `deleteSource`），
/// 而 task 里的 `sourceId` 仍指向它 ⇒ 每次同步都从同一个入口进来、拿到同一个 404、
/// 再原样退出。2026-09-22 线上实际发生：此后 nginx 日志里**再没有出现过任何
/// `POST /v1/imports/uploads`**，只有 `POST /v1/imports/inspect` 的 404 反复。
///
/// ⚠️ `SyncHTTPError` 是 `HealthKitSync.swift` 里的 `private struct`，所以这里只收
/// 拆出来的两个字段；判据是纯函数，回归测试直接钉住（`HealthSyncResumeRegression.swift`）。
nonisolated enum HealthSyncResumePolicy {
    enum Disposition: Equatable {
        /// 这个 task 已经不可能恢复：清掉它，别再拿同一个 `sourceId` / `jobId` 重试。
        case abandonTask
        /// 瞬时失败（网络 / 5xx / 鉴权 / 409 冲突）：保留 task，下次再试。
        case keepTask
        /// 这一批**字节本身**超了服务端单批上限：重发同样的字节只会拿到同样的 400。
        ///
        /// 🔴 必须单独一档，两个方向都不能并：
        ///   - 并进 `.keepTask` ⇒ **永久活锁**：磁盘行的 `sourceId` 留着 ⇒
        ///     `SyncAtomicUnit.nextStep` 恒返回 `.inspect` ⇒ 每次同步都撞同一个 400，
        ///     而 Nginx 里**再也不会出现 `uploads`**（与 2026-09-22 那个 404 死锁同构，
        ///     只是入口从 404 换成了 400）。
        ///   - 并进 `.abandonTask` ⇒ 少了"缩预算"这一步：下次同步用满预算产出同一份
        ///     必被拒的产物 ⇒ 每次白读一遍 HealthKit。
        /// 正确处置 = **收敛预算**（缩一档并记住）+ 清任务行重导。
        case convergeBudget
    }

    /// 服务端明确回答「没有这个暂存上传」。
    static let sourceGoneStatusCode = 404

    /// `waitForJob` 观察到任务已进入终结态（`failed` / `cancelled` / `interrupted`）。
    /// 终结的任务不会自己变好，拿同一个 `jobId` 再等只是重放同一个错误。
    static let terminalJobCode = "import_job_failed"

    /// 服务端对"本批超出单批上限"的稳定码。
    ///
    /// 出处：`apps/api/src/import-worker.ts:128-132`（`xml_exceeds_bounds` /
    /// `manifest_exceeds_bounds` / `deletions_exceed_bounds` / `route_exceeds_bounds`
    /// 四个 reason 一律折成这一个 code）＋ `apps/api/src/routes/import-routes.ts:99-108`
    /// （inspect 用它回 400，并带 `bounds`/`actual`）。契约侧的承诺写在
    /// `packages/api-contracts/src/index.ts:682`（「⇒ 收敛拆批预算后重传」）。
    ///
    /// ⚠️ 这条**不**走 `SyncUploadRecovery.contentRejectionStatuses`：那套集合服务的是
    /// `/v1/imports/uploads` 端点的 400，与 inspect 的 400 是两条路
    /// （inspect 的 catch 里没有任何 contentRejection 消费点，改那边对本缺陷无效）。
    static let batchExceedsBoundsCode = "direct_sync_payload_exceeds_bounds"

    /// 服务端 inspect/preflight 的「**载荷内容不合规**」稳定码（确定性拒绝，P2-7，2026-10-15）。
    ///
    /// 出处：`apps/api/src/import-worker.ts` 的 `laneRefusalFailure` —— `missing_required_files` /
    /// `input_tree_not_allowed` / `missing_record_identity` / `payload_identity_invalid` 四个
    /// **inspect 预检可达**的 reason，加上 worker 内部（摘要算不出来）产出、不经 inspect
    /// 到达的 `payload_identity_unavailable`，共五个 reason 折成这一个 code（前四个由
    /// inspect 的预检 400 返回）。处置 = `.abandonTask`：清任务后客户端会
    /// **重新导出**（输入完整 ⇒ 自愈）；若落 `.keepTask`，sourceId 留着 ⇒ 下次仍从同一句 inspect
    /// 进来、撞同一个 400（与 2026-09-22 的 404 死锁同构）。
    static let inputNotAllowedCode = "direct_sync_input_not_allowed"

    /// P2-6（2026-10-23）：同一路线在一批里被改归多个训练 —— 载荷自相矛盾。
    ///
    /// 重发同一份字节只会得到同一个拒收，因此必须 `.abandonTask`（清任务后重新生成
    /// 同步批次），不能落 `.keepTask` 形成每个同步周期重撞同一失败的活锁。
    static let routeOwnershipConflictCode = "direct_sync_route_ownership_conflict"

    static func disposition(statusCode: Int?, errorCode: String?) -> Disposition {
        // 🔴 先判 code、后判状态码：它是 400 而不是 404，落到下面只会得到 `.keepTask`。
        if errorCode == batchExceedsBoundsCode { return .convergeBudget }
        // P2-7（2026-10-15）：确定性输入拒绝 ⇒ 清任务重导（自愈），不能落 `.keepTask` 活锁。
        if errorCode == inputNotAllowedCode { return .abandonTask }
        // P2-6：确定性的路线归属冲突同样不可重试。
        if errorCode == routeOwnershipConflictCode { return .abandonTask }
        if statusCode == sourceGoneStatusCode { return .abandonTask }
        if errorCode == terminalJobCode { return .abandonTask }
        return .keepTask
    }
}

/// Wait only for a known mutation conflict, without blocking the main actor or
/// retrying validation/authentication errors. The caller retains its saved batch.
@MainActor
enum HealthSyncMutationRetry {
    static func run<T>(
        timeout: Duration = .seconds(30 * 60),
        delay: Duration = .seconds(2),
        isConflict: (Error) -> Bool,
        onWait: () -> Void,
        operation: () async throws -> T
    ) async throws -> T {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while true {
            try Task.checkCancellation()
            do {
                let result = try await operation()
                try Task.checkCancellation()
                return result
            } catch {
                try Task.checkCancellation()
                guard isConflict(error), ContinuousClock.now < deadline else { throw error }
                onWait()
                try await Task.sleep(for: min(delay, ContinuousClock.now.duration(to: deadline)))
                if ContinuousClock.now >= deadline { throw error }
            }
        }
    }
}

/// Cancellation utilities shared by Health sync work that must leave the main
/// actor (for example, multipart file construction).
nonisolated enum HealthSyncCancellation {
    static func check(manuallyCancelled: Bool = false) throws {
        if manuallyCancelled { throw CancellationError() }
        try Task.checkCancellation()
    }

    static func runDetached<T: Sendable>(
        priority: TaskPriority? = nil,
        operation: @escaping @Sendable () throws -> T
    ) async throws -> T {
        let worker = Task.detached(priority: priority) {
            try Task.checkCancellation()
            let value = try operation()
            try Task.checkCancellation()
            return value
        }
        return try await withTaskCancellationHandler {
            try await worker.value
        } onCancel: {
            worker.cancel()
        }
    }

    static func runDetached<T: Sendable>(
        priority: TaskPriority? = nil,
        onCancelledResult: @escaping @Sendable (T) -> Void = { _ in },
        operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        let worker = Task.detached(priority: priority) {
            try Task.checkCancellation()
            let value = try await operation()
            do {
                try Task.checkCancellation()
            } catch {
                onCancelledResult(value)
                throw error
            }
            return value
        }
        let value = try await withTaskCancellationHandler {
            try await worker.value
        } onCancel: {
            worker.cancel()
        }
        do {
            try Task.checkCancellation()
        } catch {
            onCancelledResult(value)
            throw error
        }
        return value
    }
}

/// Owns the one in-flight Health sync task. The caller that starts a sync and
/// an explicit UI/background cancellation both cancel the same task handle.
@MainActor
final class HealthSyncTaskOwner {
    private var task: Task<Void, Never>?
    private var taskID: UUID?

    var isRunning: Bool { task != nil }

    @discardableResult
    func run(operation: @escaping @MainActor @Sendable () async -> Void) async -> Bool {
        guard task == nil else { return false }
        let id = UUID()
        let worker = Task { @MainActor [weak self] in
            defer { self?.finish(id: id) }
            await operation()
        }
        task = worker
        taskID = id
        await withTaskCancellationHandler {
            await worker.value
        } onCancel: {
            worker.cancel()
        }
        finish(id: id)
        return true
    }

    @discardableResult
    func cancel() -> Bool {
        guard let task else { return false }
        task.cancel()
        return true
    }

    private func finish(id: UUID) {
        guard taskID == id else { return }
        task = nil
        taskID = nil
    }
}
