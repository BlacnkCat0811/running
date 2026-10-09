import Foundation
import CryptoKit

/// ZIP 字节处理不继承 App 的默认 MainActor 隔离；调用方只拿结果写同步日志。
nonisolated enum HealthSyncArchive {
    static let chunkSize = 64 * 1024

    struct PreparedArchive: Sendable {
        let payloadHash: String
        let zipURL: URL
        /// 同名文件可能已经属于一个可恢复任务，取消时不能顺手删掉它。
        let isNewFile: Bool

        func discardIfUncommitted() {
            if isNewFile { try? FileManager.default.removeItem(at: zipURL) }
        }
    }

    static func zipName(for payloadHash: String) -> String { "upload-\(payloadHash).zip" }

    /// 一次分块读取同时计算 SHA256 与复制，完整写入后才发布按哈希命名的文件。
    /// `onChunk` 可观察处理进度；回调同样在 worker 上执行，不能操作 UI。
    static func prepare(
        _ sourceURL: URL,
        in folderURL: URL,
        onChunk: @escaping @Sendable (Int) -> Void = { _ in }
    ) async throws -> PreparedArchive {
        try await HealthSyncCancellation.runDetached(
            priority: .utility,
            onCancelledResult: { $0.discardIfUncommitted() }
        ) { () async throws -> PreparedArchive in
            try prepareFile(sourceURL, in: folderURL, onChunk: onChunk)
        }
    }

    /// 仅旧 payload 没有文件名时需要重验哈希；也必须离开 MainActor。
    static func fileHash(
        _ url: URL,
        onChunk: @escaping @Sendable (Int) -> Void = { _ in }
    ) async throws -> String {
        let hash = try await HealthSyncCancellation.runDetached(priority: .utility) {
            var hasher = SHA256()
            try readChunks(url) { chunk in
                hasher.update(data: chunk)
                onChunk(chunk.count)
            }
            return hex(hasher.finalize())
        }
        try Task.checkCancellation()
        return hash
    }

    static func protect(_ url: URL) {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = url
        try? mutable.setResourceValues(values)
        #if os(iOS)
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: url.path
        )
        #endif
    }

    private static func prepareFile(
        _ sourceURL: URL,
        in folderURL: URL,
        onChunk: @Sendable (Int) -> Void
    ) throws -> PreparedArchive {
        try Task.checkCancellation()
        let manager = FileManager.default
        try manager.createDirectory(at: folderURL, withIntermediateDirectories: true)
        protect(folderURL)
        let stagingURL = folderURL.appendingPathComponent("upload-\(UUID().uuidString).tmp")
        defer { try? manager.removeItem(at: stagingURL) }
        guard manager.createFile(atPath: stagingURL.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        // 临时副本也含健康数据，不等发布后才应用文件保护。
        protect(stagingURL)
        let output = try FileHandle(forWritingTo: stagingURL)
        defer { try? output.close() }
        var hasher = SHA256()
        try readChunks(sourceURL) { chunk in
            hasher.update(data: chunk)
            onChunk(chunk.count)
            try Task.checkCancellation()
            try output.write(contentsOf: chunk)
        }
        try output.synchronize()
        try output.close()
        let payloadHash = hex(hasher.finalize())
        let durableURL = folderURL.appendingPathComponent(zipName(for: payloadHash))
        let isNewFile = !manager.fileExists(atPath: durableURL.path)
        try Task.checkCancellation()
        // 不先删旧文件：读写失败或取消不能破坏已经可续传的同名归档。
        if isNewFile {
            try manager.moveItem(at: stagingURL, to: durableURL)
        } else {
            _ = try manager.replaceItemAt(durableURL, withItemAt: stagingURL)
        }
        protect(durableURL)
        try? manager.removeItem(at: sourceURL)
        // 发布后的取消由 runDetached 的 onCancelledResult 回收，避免“晚到成功”留下孤儿。
        return PreparedArchive(payloadHash: payloadHash, zipURL: durableURL, isNewFile: isNewFile)
    }

    private static func readChunks(_ url: URL, consume: (Data) throws -> Void) throws {
        try Task.checkCancellation()
        let input = try FileHandle(forReadingFrom: url)
        defer { try? input.close() }
        // Foundation 的临时对象也逐块释放，不让 autorelease 生命周期覆盖整个大归档。
        while try autoreleasepool(invoking: {
            try Task.checkCancellation()
            guard let chunk = try input.read(upToCount: chunkSize), !chunk.isEmpty else { return false }
            try Task.checkCancellation()
            try consume(chunk)
            return true
        }) {}
        try Task.checkCancellation()
    }

    private static func hex(_ digest: SHA256.Digest) -> String {
        digest.map { String(format: "%02x", $0) }.joined()
    }
}
