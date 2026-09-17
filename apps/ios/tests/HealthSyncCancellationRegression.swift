import Foundation

@main
struct HealthSyncCancellationRegression {
    static func main() async throws {
        try await parentCancellationStopsDetachedWorker()
        try await parentCancellationStopsAsyncDetachedWorker()
        try await cancelledAsyncResultReleasesTransientArtifact()
        try await cancellationWinsOverLateSuccess()
        try await taskOwnerEnforcesSingleFlight()
        try await storedZipCancellationDoesNotPublishArchive()
        try cancellationGateBlocksPostCancelSideEffects()
        print("Health sync cancellation regression tests passed")
    }

    private static func parentCancellationStopsDetachedWorker() async throws {
        let observed = LockedFlag()
        let task = Task {
            try await HealthSyncCancellation.runDetached {
                while !Task.isCancelled {
                    Thread.sleep(forTimeInterval: 0.005)
                }
                observed.set()
                throw CancellationError()
            }
        }
        try await Task.sleep(for: .milliseconds(30))
        task.cancel()
        do {
            _ = try await task.value
            throw RegressionFailure("cancelled parent unexpectedly returned a value")
        } catch is CancellationError {
            // Expected.
        }
        try require(observed.value, "detached worker did not observe parent cancellation")
    }

    private static func cancellationWinsOverLateSuccess() async throws {
        let started = LockedFlag()
        let task = Task {
            try await HealthSyncCancellation.runDetached {
                started.set()
                Thread.sleep(forTimeInterval: 0.08)
                return 42
            }
        }
        while !started.value {
            try await Task.sleep(for: .milliseconds(1))
        }
        task.cancel()
        do {
            _ = try await task.value
            throw RegressionFailure("late worker success overrode cancellation")
        } catch is CancellationError {
            // Expected.
        }
    }

    private static func parentCancellationStopsAsyncDetachedWorker() async throws {
        let observed = LockedFlag()
        let task = Task {
            try await HealthSyncCancellation.runDetached {
                do {
                    try await Task.sleep(for: .seconds(30))
                    return 1
                } catch is CancellationError {
                    observed.set()
                    throw CancellationError()
                }
            }
        }
        try await Task.sleep(for: .milliseconds(30))
        task.cancel()
        do {
            _ = try await task.value
            throw RegressionFailure("async detached worker ignored parent cancellation")
        } catch is CancellationError {
            // Expected.
        }
        try require(observed.value, "async detached worker did not observe cancellation")
    }

    private static func cancelledAsyncResultReleasesTransientArtifact() async throws {
        let started = LockedFlag()
        let cleaned = LockedFlag()
        let task = Task {
            try await HealthSyncCancellation.runDetached(
                onCancelledResult: { _ in cleaned.set() }
            ) {
                started.set()
                try? await Task.sleep(for: .milliseconds(80))
                return 1
            }
        }
        while !started.value {
            try await Task.sleep(for: .milliseconds(1))
        }
        task.cancel()
        do {
            _ = try await task.value
            throw RegressionFailure("cancelled async result escaped without cleanup")
        } catch is CancellationError {
            // Expected.
        }
        try require(cleaned.value, "cancelled async result did not release its transient artifact")
    }

    @MainActor
    private static func taskOwnerEnforcesSingleFlight() async throws {
        let owner = HealthSyncTaskOwner()
        let firstStarted = LockedFlag()
        let firstCancelled = LockedFlag()
        let secondStarted = LockedFlag()
        let first = Task { @MainActor in
            await owner.run {
                firstStarted.set()
                while !Task.isCancelled {
                    await Task.yield()
                }
                firstCancelled.set()
            }
        }
        while !firstStarted.value {
            await Task.yield()
        }
        let acceptedSecond = await owner.run {
            secondStarted.set()
        }
        try require(!acceptedSecond, "task owner accepted a concurrent sync")
        try require(!secondStarted.value, "rejected concurrent sync still executed")
        try require(owner.cancel(), "task owner had no task to cancel")
        _ = await first.value
        try require(firstCancelled.value, "owned task did not receive explicit cancellation")
        try require(!owner.isRunning, "task owner did not release the completed task")
    }

    private static func cancellationGateBlocksPostCancelSideEffects() throws {
        var uploadStarted = false
        var watermarkAdvanced = false
        do {
            try HealthSyncCancellation.check(manuallyCancelled: true)
            uploadStarted = true
            watermarkAdvanced = true
        } catch is CancellationError {
            // Expected.
        }
        try require(!uploadStarted, "cancelled sync crossed the upload gate")
        try require(!watermarkAdvanced, "cancelled sync advanced its watermark")
    }

    private static func storedZipCancellationDoesNotPublishArchive() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-health-sync-cancel-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = directory.appendingPathComponent("large.xml")
        let archive = directory.appendingPathComponent("cancelled.zip")
        try Data(repeating: 0x41, count: 64 * 1024 * 1024).write(to: source)

        let started = LockedFlag()
        let task = Task.detached {
            started.set()
            try StoredZip.write(files: [("large.xml", source)], to: archive)
        }
        while !started.value {
            try await Task.sleep(for: .milliseconds(1))
        }
        try await Task.sleep(for: .milliseconds(5))
        task.cancel()
        do {
            try await task.value
            throw RegressionFailure("cancelled ZIP creation unexpectedly completed")
        } catch is CancellationError {
            // Expected.
        }
        try require(
            !FileManager.default.fileExists(atPath: archive.path),
            "cancelled ZIP creation published a partial archive"
        )
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw RegressionFailure(message) }
    }
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = false

    var value: Bool {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func set() {
        lock.lock()
        storage = true
        lock.unlock()
    }
}

private struct RegressionFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
