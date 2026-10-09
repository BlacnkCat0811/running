import Foundation
import CryptoKit

@main
struct HealthSyncArchiveRegression {
    @MainActor
    static func main() async throws {
        try await knownHashesAndExactBytes()
        try await chunkedWorkLeavesMainActorResponsive()
        try await cancellationDuringCopyPreservesExistingArchive()
        try await cancellationDuringHashStopsReading()
        try await cancellationBeforeStartDoesNotCreateArtifacts()
        try await lateCancellationDiscardsOnlyNewArchive()
        try await failedReadDoesNotPublishPartialArchive()
        try await uncommittedCleanupPreservesPreviouslySavedArchive()
        print("Health sync archive regression tests passed")
    }

    private static func knownHashesAndExactBytes() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let vectors: [(Data, String)] = [
            (Data(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
            (Data("abc".utf8), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        ]
        for (index, vector) in vectors.enumerated() {
            let source = fixture.directory.appendingPathComponent("vector-\(index).zip")
            try vector.0.write(to: source)
            let hash = try await HealthSyncArchive.fileHash(source)
            try require(hash == vector.1, "streamed SHA256 does not match a known vector")
            let prepared = try await HealthSyncArchive.prepare(source, in: fixture.artifacts)
            try require(prepared.payloadHash == vector.1, "copied ZIP has a different hash")
            try require(
                prepared.zipURL.lastPathComponent == "upload-\(vector.1).zip",
                "persistent filename changed the batch identity"
            )
            try require(try Data(contentsOf: prepared.zipURL) == vector.0, "ZIP bytes changed during persistence")
            try require(prepared.isNewFile, "new archive was not marked for uncommitted cleanup")
            try require(!FileManager.default.fileExists(atPath: source.path), "successful preparation leaked its source")
        }
    }

    @MainActor
    private static func chunkedWorkLeavesMainActorResponsive() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let data = fixture.multiChunkData
        try data.write(to: fixture.source)
        let gate = ChunkGate()
        let task = Task { @MainActor in
            try await HealthSyncArchive.prepare(fixture.source, in: fixture.artifacts) {
                gate.recordAndWait($0)
            }
        }
        defer { gate.release(); task.cancel() }
        try await waitForChunk(gate)
        // worker 尚被回调挡住，但 MainActor 已经能处理本次检查（不靠“文件够大”的计时猜测）。
        MainActor.assertIsolated()
        try require(!gate.snapshot.timedOut, "file work blocked MainActor until the worker timed out")
        try require(gate.snapshot.offMainThread, "ZIP hashing/copying ran on the main thread")
        let staged = try FileManager.default.contentsOfDirectory(atPath: fixture.artifacts.path)
        try require(staged.count == 1 && staged[0].hasSuffix(".tmp"), "partial copy was published as a durable ZIP")
        gate.release()
        let prepared = try await task.value
        let stats = gate.snapshot
        try require(stats.chunks > 1 && stats.bytes == data.count, "ZIP was not processed in complete chunks")
        try require(stats.maxChunk <= HealthSyncArchive.chunkSize, "a read exceeded the bounded chunk size")
        try require(prepared.payloadHash == digest(data), "multi-chunk hash differs from one-shot SHA256")
        try require(try Data(contentsOf: prepared.zipURL) == data, "multi-chunk persistence changed ZIP bytes")
        try require(
            try FileManager.default.contentsOfDirectory(atPath: fixture.artifacts.path) == [prepared.zipURL.lastPathComponent],
            "successful preparation left a staging file"
        )
    }

    @MainActor
    private static func cancellationDuringCopyPreservesExistingArchive() async throws {
        // 两种所有权：新文件不能残留；已经属于旧任务的同名文件不能丢失。
        for existing in [false, true] {
            let fixture = try Fixture()
            defer { fixture.remove() }
            let data = fixture.multiChunkData
            try data.write(to: fixture.source)
            let durable = fixture.artifacts.appendingPathComponent(HealthSyncArchive.zipName(for: digest(data)))
            if existing {
                try FileManager.default.createDirectory(at: fixture.artifacts, withIntermediateDirectories: true)
                try data.write(to: durable)
            }
            let gate = ChunkGate(blockAtChunk: 2)
            let task = Task { @MainActor in
                try await HealthSyncArchive.prepare(fixture.source, in: fixture.artifacts) {
                    gate.recordAndWait($0)
                }
            }
            defer { gate.release(); task.cancel() }
            try await waitForChunk(gate, count: 2)
            let stagingName = try FileManager.default.contentsOfDirectory(atPath: fixture.artifacts.path)
                .first { $0.hasSuffix(".tmp") }
            try require(stagingName != nil, "copy never created its staging file")
            if let stagingName {
                let attributes = try FileManager.default.attributesOfItem(
                    atPath: fixture.artifacts.appendingPathComponent(stagingName).path
                )
                try require(
                    (attributes[.size] as? NSNumber)?.intValue == HealthSyncArchive.chunkSize,
                    "cancellation fixture did not reach a partially written copy"
                )
            }
            task.cancel()
            gate.release()
            do {
                _ = try await task.value
                throw RegressionFailure("cancelled archive preparation returned a late success")
            } catch is CancellationError {}
            try require(gate.snapshot.chunks == 2, "copy kept reading after parent cancellation")
            try require(FileManager.default.fileExists(atPath: fixture.source.path), "cancelled copy deleted its source")
            let names = try FileManager.default.contentsOfDirectory(atPath: fixture.artifacts.path)
            try require(names == (existing ? [durable.lastPathComponent] : []), "cancelled copy leaked a partial/new archive")
            if existing {
                try require(try Data(contentsOf: durable) == data, "cancelled copy damaged the previous resumable ZIP")
            }
        }
    }

    @MainActor
    private static func cancellationDuringHashStopsReading() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try fixture.multiChunkData.write(to: fixture.source)
        let gate = ChunkGate()
        let task = Task { @MainActor in
            try await HealthSyncArchive.fileHash(fixture.source) { gate.recordAndWait($0) }
        }
        defer { gate.release(); task.cancel() }
        try await waitForChunk(gate)
        try require(gate.snapshot.offMainThread, "legacy archive hash ran on the main thread")
        task.cancel()
        gate.release()
        do {
            _ = try await task.value
            throw RegressionFailure("cancelled legacy hash returned a digest")
        } catch is CancellationError {}
        try require(gate.snapshot.chunks == 1, "legacy hash kept reading after cancellation")
        try require(FileManager.default.fileExists(atPath: fixture.source.path), "legacy hash mutated its input")
    }

    @MainActor
    private static func cancellationBeforeStartDoesNotCreateArtifacts() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try fixture.multiChunkData.write(to: fixture.source)
        let task = Task { @MainActor in
            try await HealthSyncArchive.prepare(fixture.source, in: fixture.artifacts)
        }
        task.cancel()
        do {
            _ = try await task.value
            throw RegressionFailure("already-cancelled preparation ran")
        } catch is CancellationError {}
        try require(!FileManager.default.fileExists(atPath: fixture.artifacts.path), "already-cancelled preparation wrote files")
        try require(FileManager.default.fileExists(atPath: fixture.source.path), "already-cancelled preparation deleted its source")
    }

    private static func failedReadDoesNotPublishPartialArchive() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        do {
            _ = try await HealthSyncArchive.prepare(fixture.source, in: fixture.artifacts)
            throw RegressionFailure("missing source unexpectedly produced an archive")
        } catch is CocoaError {}
        try require(
            try FileManager.default.contentsOfDirectory(atPath: fixture.artifacts.path).isEmpty,
            "failed read left a partial persistent archive"
        )
    }

    @MainActor
    private static func lateCancellationDiscardsOnlyNewArchive() async throws {
        for existing in [false, true] {
            let fixture = try Fixture()
            defer { fixture.remove() }
            let data = fixture.multiChunkData
            try data.write(to: fixture.source)
            let durable = fixture.artifacts.appendingPathComponent(HealthSyncArchive.zipName(for: digest(data)))
            if existing {
                try FileManager.default.createDirectory(at: fixture.artifacts, withIntermediateDirectories: true)
                try data.write(to: durable)
            }
            let gate = ChunkGate()
            let source = fixture.source
            let artifacts = fixture.artifacts
            // 使用生产相同的取消结果回收器，在文件发布后、结果返回前确定性制造取消窗口。
            let task = Task { @MainActor in
                try await HealthSyncCancellation.runDetached(
                    onCancelledResult: { (archive: HealthSyncArchive.PreparedArchive) in
                        archive.discardIfUncommitted()
                    }
                ) { () async throws -> HealthSyncArchive.PreparedArchive in
                    let archive = try await HealthSyncArchive.prepare(source, in: artifacts)
                    gate.recordAndWait(0)
                    return archive
                }
            }
            defer { gate.release(); task.cancel() }
            try await waitForChunk(gate)
            try require(FileManager.default.fileExists(atPath: durable.path), "late-cancellation fixture did not publish its ZIP")
            task.cancel()
            gate.release()
            do {
                _ = try await task.value
                throw RegressionFailure("published archive escaped the cancellation result gate")
            } catch is CancellationError {}
            let names = try FileManager.default.contentsOfDirectory(atPath: fixture.artifacts.path)
            try require(names == (existing ? [durable.lastPathComponent] : []), "late result cleanup violated archive ownership")
            if existing {
                try require(try Data(contentsOf: durable) == data, "late result cleanup damaged a resumable archive")
            }
        }
    }

    private static func uncommittedCleanupPreservesPreviouslySavedArchive() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let data = fixture.multiChunkData
        try data.write(to: fixture.source)
        let first = try await HealthSyncArchive.prepare(fixture.source, in: fixture.artifacts)
        try data.write(to: fixture.source)
        let replacement = try await HealthSyncArchive.prepare(fixture.source, in: fixture.artifacts)
        try require(!replacement.isNewFile, "previously saved archive was treated as a newly owned file")
        replacement.discardIfUncommitted()
        try require(try Data(contentsOf: first.zipURL) == data, "late cancellation deleted a previously saved archive")
        // 模拟“文件已发布，但任务日志写失败”：只清理本轮新建、尚无人认领的文件。
        first.discardIfUncommitted()
        try require(!FileManager.default.fileExists(atPath: first.zipURL.path), "journal failure leaked an uncommitted archive")
    }

    private static func waitForChunk(_ gate: ChunkGate, count: Int = 1) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while gate.snapshot.chunks < count && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(1))
        }
        try require(gate.snapshot.chunks >= count, "file worker did not reach the expected chunk")
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        if try !condition() { throw RegressionFailure(message) }
    }
}

private struct Fixture {
    let directory: URL
    var artifacts: URL { directory.appendingPathComponent("artifacts", isDirectory: true) }
    var source: URL { directory.appendingPathComponent("export.zip") }
    var multiChunkData: Data {
        Data((0..<(HealthSyncArchive.chunkSize * 3 + 17)).map { UInt8($0 % 251) })
    }

    init() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-health-archive-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    func remove() { try? FileManager.default.removeItem(at: directory) }
}

nonisolated private final class ChunkGate: @unchecked Sendable {
    struct Snapshot {
        var chunks = 0
        var bytes = 0
        var maxChunk = 0
        var offMainThread = true
        var timedOut = false
    }

    private let condition = NSCondition()
    private let blockAtChunk: Int
    private var released = false
    private var storage = Snapshot()

    init(blockAtChunk: Int = 1) { self.blockAtChunk = blockAtChunk }

    var snapshot: Snapshot {
        condition.lock()
        defer { condition.unlock() }
        return storage
    }

    func recordAndWait(_ size: Int) {
        condition.lock()
        defer { condition.unlock() }
        storage.chunks += 1
        storage.bytes += size
        storage.maxChunk = max(storage.maxChunk, size)
        storage.offMainThread = storage.offMainThread && !Thread.isMainThread
        let deadline = Date().addingTimeInterval(5)
        while !released && storage.chunks >= blockAtChunk {
            if !condition.wait(until: deadline) { storage.timedOut = true; break }
        }
    }

    func release() {
        condition.lock()
        released = true
        condition.broadcast()
        condition.unlock()
    }
}

private struct RegressionFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
