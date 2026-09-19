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
