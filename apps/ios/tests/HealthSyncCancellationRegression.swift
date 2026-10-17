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
        try duplicateZipEntriesFailClosed()
        try cancellationGateBlocksPostCancelSideEffects()
        try await mutationConflictsWaitAndResume()
        try await mutationWaitHonorsCancellationAndTimeout()
        try pollingPolicy()
        print("Health sync cancellation regression tests passed")
    }

    private static func pollingPolicy() throws {
        try require(HealthSyncPolling.delay(elapsed: .zero) == .seconds(2), "initial polling should be quick")
        try require(HealthSyncPolling.delay(elapsed: .seconds(29)) == .seconds(2), "early polling boundary")
        try require(HealthSyncPolling.delay(elapsed: .seconds(30)) == .seconds(5), "long jobs should poll less")
        try require(HealthSyncPolling.delay(elapsed: .seconds(1800)) == .seconds(5), "slow polling remains bounded")
        for status in [nil, 400, 401, 403, 404, 409] as [Int?] {
            try require(!HealthSyncPolling.shouldRetryHTTP(statusCode: status), "terminal failure was retried")
        }
        for status in [429, 500, 502, 503] {
            try require(HealthSyncPolling.shouldRetryHTTP(statusCode: status), "transient failure was not retried")
        }
    }

    @MainActor
    private static func mutationConflictsWaitAndResume() async throws {
        var attempts = 0
        var waits = 0
        let value = try await HealthSyncMutationRetry.run(
            delay: .milliseconds(1),
            isConflict: { $0 is MutationBusy },
            onWait: { waits += 1 }
        ) {
            attempts += 1
            if attempts < 3 { throw MutationBusy() }
            return 42
        }
        try require(value == 42 && attempts == 3 && waits == 2, "busy import did not resume")
        attempts = 0
        do {
            let _: Int = try await HealthSyncMutationRetry.run(
                isConflict: { $0 is MutationBusy }, onWait: {}
            ) {
                attempts += 1
                throw RegressionFailure("validation error")
            }
            throw RegressionFailure("validation error was swallowed")
        } catch let error as RegressionFailure {
            try require(error.description == "validation error" && attempts == 1, "non-conflict was retried")
        }
    }

    @MainActor
    private static func mutationWaitHonorsCancellationAndTimeout() async throws {
        var attempts = 0
        let waiting = LockedFlag()
        let task = Task { @MainActor in
            let _: Int = try await HealthSyncMutationRetry.run(
                isConflict: { $0 is MutationBusy }, onWait: { waiting.set() }
            ) {
                attempts += 1
                throw MutationBusy()
            }
        }
        while !waiting.value { try await Task.sleep(for: .milliseconds(1)) }
        task.cancel()
        do {
            try await task.value
            throw RegressionFailure("cancelled mutation wait completed")
        } catch is CancellationError {}
        try require(attempts == 1, "mutation was submitted again after cancellation")
        do {
            let _: Int = try await HealthSyncMutationRetry.run(
                timeout: .zero, isConflict: { $0 is MutationBusy }, onWait: {}
            ) { throw MutationBusy() }
            throw RegressionFailure("expired mutation wait completed")
        } catch is MutationBusy {}
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

    /// R04（2026-10-16 复查）：ZIP 写入器对**重复路径**失败关闭。
    ///
    /// 缺陷形态：清单里两个条目同名（页 1 的附件版本与页 N 的正式流版本引用同一
    /// `workout-routes/<uuid>_1.gpx`）⇒ ZIP 里同路径两个条目 ⇒ 接收器整批拒收。
    /// 写入器是最后一道防线：**静默去重会把上游的清单错误藏起来**，所以必须当场失败
    /// ——而且要在写入任何字节之前失败（不产出"看起来正常"的坏 ZIP）。
    private static func duplicateZipEntriesFailClosed() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-health-sync-dupzip-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = directory.appendingPathComponent("first.xml")
        let second = directory.appendingPathComponent("second.xml")
        let archive = directory.appendingPathComponent("duplicate.zip")
        try Data("first".utf8).write(to: first)
        try Data("second".utf8).write(to: second)
        do {
            try StoredZip.write(
                files: [("workout-routes/x_1.gpx", first), ("workout-routes/x_1.gpx", second)],
                to: archive
            )
            throw RegressionFailure("a duplicate entry was silently accepted into the ZIP")
        } catch let error as StoredZip.StoredZipError {
            try require(error == .duplicateEntry("workout-routes/x_1.gpx"),
                        "the duplicate entry did not surface its path")
        }
        try require(
            !FileManager.default.fileExists(atPath: archive.path),
            "a rejected duplicate manifest still published an archive"
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

private struct MutationBusy: Error {}
