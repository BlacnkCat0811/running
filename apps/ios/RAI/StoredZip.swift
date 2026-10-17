import Foundation
import zlib

nonisolated enum StoredZip {
    static func write(files: [(name: String, url: URL)], to url: URL) throws {
        try Task.checkCancellation()
        // 🔴 R04（2026-10-16 复查）：**重复路径 = 接收端拒收的形态**（ZIP 里两个条目同名，
        // 服务端 `gpx-parser`/接收器按路径集合校验 ⇒ 整批被拒）。写入器是**最后一道防线**：
        // 静默去重会把上游的清单错误藏起来，所以这里**失败关闭** —— 上游必须保证清单唯一
        // （`HealthKitExport` 的批次级路线清单按相对路径跨页去重）。
        var seenNames = Set<String>()
        for file in files {
            guard seenNames.insert(file.name).inserted else {
                throw StoredZipError.duplicateEntry(file.name)
            }
        }
        let fileManager = FileManager.default
        let temporaryURL = url.deletingLastPathComponent()
            .appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        defer { try? fileManager.removeItem(at: temporaryURL) }

        guard fileManager.createFile(atPath: temporaryURL.path, contents: nil) else {
            throw StoredZipError.outputCreationFailed
        }

        let output = try FileHandle(forWritingTo: temporaryURL)
        do {
            var offset: UInt64 = 0
            var centralEntries: [CentralEntry] = []
            centralEntries.reserveCapacity(files.count)

            for file in files {
                try Task.checkCancellation()
                let nameData = Data(file.name.utf8)
                guard nameData.count <= Int(UInt16.max), offset <= UInt64(UInt32.max) else {
                    throw StoredZipError.fileTooLarge
                }

                let compressedURL = temporaryURL
                    .deletingLastPathComponent()
                    .appendingPathComponent(".\(UUID().uuidString).deflate")
                defer { try? fileManager.removeItem(at: compressedURL) }
                let stats = try compressFile(at: file.url, to: compressedURL)
                let useCompressed = stats.compressedSize > 0
                    && stats.compressedSize < stats.uncompressedSize
                let method: UInt16 = useCompressed ? 8 : 0
                let payloadSize = useCompressed ? stats.compressedSize : stats.uncompressedSize

                let header = localHeader(
                    nameData: nameData,
                    method: method,
                    crc: stats.crc,
                    compressedSize: payloadSize,
                    uncompressedSize: stats.uncompressedSize
                )
                try output.write(contentsOf: header)
                offset += UInt64(header.count)

                if useCompressed {
                    offset += try copyFile(at: compressedURL, to: output)
                } else {
                    offset += try copyFile(at: file.url, to: output)
                }
                guard offset <= UInt64(UInt32.max) else {
                    throw StoredZipError.fileTooLarge
                }

                centralEntries.append(CentralEntry(
                    nameData: nameData,
                    method: method,
                    crc: stats.crc,
                    compressedSize: payloadSize,
                    uncompressedSize: stats.uncompressedSize,
                    localOffset: offset - UInt64(header.count) - payloadSize
                ))
            }

            guard centralEntries.count <= Int(UInt16.max) else {
                throw StoredZipError.fileTooLarge
            }
            let centralOffset = offset
            for entry in centralEntries {
                try Task.checkCancellation()
                let central = centralHeader(entry)
                try output.write(contentsOf: central)
                offset += UInt64(central.count)
            }
            let centralSize = offset - centralOffset
            guard centralOffset <= UInt64(UInt32.max), centralSize <= UInt64(UInt32.max) else {
                throw StoredZipError.fileTooLarge
            }
            let end = endOfCentralDirectory(
                entryCount: centralEntries.count,
                centralSize: UInt32(centralSize),
                centralOffset: UInt32(centralOffset)
            )
            try Task.checkCancellation()
            try output.write(contentsOf: end)
            try output.synchronize()
            try output.close()

            try Task.checkCancellation()
            if fileManager.fileExists(atPath: url.path) {
                _ = try fileManager.replaceItemAt(url, withItemAt: temporaryURL)
            } else {
                try fileManager.moveItem(at: temporaryURL, to: url)
            }
        } catch {
            try? output.close()
            throw error
        }
    }

    private static func u16(_ value: UInt16) -> [UInt8] {
        [UInt8(value & 0xFF), UInt8((value >> 8) & 0xFF)]
    }

    private static func u32(_ value: UInt32) -> [UInt8] {
        [
            UInt8(value & 0xFF),
            UInt8((value >> 8) & 0xFF),
            UInt8((value >> 16) & 0xFF),
            UInt8((value >> 24) & 0xFF)
        ]
    }

    private struct FileStats {
        let crc: UInt32
        let compressedSize: UInt64
        let uncompressedSize: UInt64
    }

    private struct CentralEntry {
        let nameData: Data
        let method: UInt16
        let crc: UInt32
        let compressedSize: UInt64
        let uncompressedSize: UInt64
        let localOffset: UInt64
    }

    enum StoredZipError: Error, Equatable {
        case compressionFailed
        case fileTooLarge
        case outputCreationFailed
        /// R04：清单里出现两个同名条目 —— 这是接收器拒收的形态，必须在写入任何字节之前失败
        /// （由上游的批次级清单去重保证它不可达；它是"上游错了也别把坏 ZIP 发出去"的兜底）。
        case duplicateEntry(String)
    }

    private static func compressFile(at sourceURL: URL, to destinationURL: URL) throws -> FileStats {
        let fileManager = FileManager.default
        guard fileManager.createFile(atPath: destinationURL.path, contents: nil) else {
            throw StoredZipError.outputCreationFailed
        }
        let source = try FileHandle(forReadingFrom: sourceURL)
        let destination = try FileHandle(forWritingTo: destinationURL)
        defer {
            try? source.close()
            try? destination.close()
        }

        var stream = z_stream()
        let initStatus = deflateInit2_(
            &stream,
            Z_DEFAULT_COMPRESSION,
            Z_DEFLATED,
            -MAX_WBITS,
            MAX_MEM_LEVEL,
            Z_DEFAULT_STRATEGY,
            ZLIB_VERSION,
            Int32(MemoryLayout<z_stream>.size)
        )
        guard initStatus == Z_OK else { throw StoredZipError.compressionFailed }
        defer { deflateEnd(&stream) }

        let chunkSize = 64 * 1024
        var outputBuffer = Data(repeating: 0, count: chunkSize)
        var checksum: uLong = 0
        var uncompressedSize: UInt64 = 0
        var compressedSize: UInt64 = 0

        while let input = try source.read(upToCount: chunkSize), !input.isEmpty {
            try Task.checkCancellation()
            uncompressedSize += UInt64(input.count)
            input.withUnsafeBytes { buffer in
                if let baseAddress = buffer.bindMemory(to: Bytef.self).baseAddress {
                    checksum = zlib.crc32(checksum, baseAddress, uInt(buffer.count))
                }
            }

            try input.withUnsafeBytes { sourceBuffer in
                guard let source = sourceBuffer.bindMemory(to: Bytef.self).baseAddress else {
                    throw StoredZipError.compressionFailed
                }
                stream.next_in = UnsafeMutablePointer(mutating: source)
                stream.avail_in = uInt(sourceBuffer.count)
                while stream.avail_in > 0 {
                    try Task.checkCancellation()
                    var status: Int32 = Z_OK
                    let produced = outputBuffer.withUnsafeMutableBytes { destinationBuffer -> Int in
                        stream.next_out = destinationBuffer.bindMemory(to: Bytef.self).baseAddress
                        stream.avail_out = uInt(destinationBuffer.count)
                        status = zlib.deflate(&stream, Z_NO_FLUSH)
                        return destinationBuffer.count - Int(stream.avail_out)
                    }
                    if produced > 0 {
                        try destination.write(contentsOf: outputBuffer.prefix(produced))
                        compressedSize += UInt64(produced)
                    }
                    guard status == Z_OK else { throw StoredZipError.compressionFailed }
                }
            }
        }

        var status: Int32 = Z_OK
        repeat {
            try Task.checkCancellation()
            let produced = outputBuffer.withUnsafeMutableBytes { destinationBuffer -> Int in
                stream.next_out = destinationBuffer.bindMemory(to: Bytef.self).baseAddress
                stream.avail_out = uInt(destinationBuffer.count)
                status = zlib.deflate(&stream, Z_FINISH)
                return destinationBuffer.count - Int(stream.avail_out)
            }
            if produced > 0 {
                try destination.write(contentsOf: outputBuffer.prefix(produced))
                compressedSize += UInt64(produced)
            }
        } while status == Z_OK
        guard status == Z_STREAM_END else { throw StoredZipError.compressionFailed }
        try destination.synchronize()

        guard checksum <= uLong(UInt32.max), compressedSize <= UInt64(UInt32.max), uncompressedSize <= UInt64(UInt32.max) else {
            throw StoredZipError.fileTooLarge
        }
        return FileStats(
            crc: UInt32(checksum),
            compressedSize: compressedSize,
            uncompressedSize: uncompressedSize
        )
    }

    private static func copyFile(at sourceURL: URL, to destination: FileHandle) throws -> UInt64 {
        let source = try FileHandle(forReadingFrom: sourceURL)
        defer { try? source.close() }
        let chunkSize = 64 * 1024
        var copied: UInt64 = 0
        while let chunk = try source.read(upToCount: chunkSize), !chunk.isEmpty {
            try Task.checkCancellation()
            try destination.write(contentsOf: chunk)
            copied += UInt64(chunk.count)
        }
        return copied
    }

    private static func localHeader(
        nameData: Data,
        method: UInt16,
        crc: UInt32,
        compressedSize: UInt64,
        uncompressedSize: UInt64
    ) -> Data {
        var header = Data()
        header.append(contentsOf: [0x50, 0x4b, 0x03, 0x04])
        header.append(contentsOf: u16(20))
        header.append(contentsOf: u16(0x0800))
        header.append(contentsOf: u16(method))
        header.append(contentsOf: u16(0))
        header.append(contentsOf: u16(0))
        header.append(contentsOf: u32(crc))
        header.append(contentsOf: u32(UInt32(compressedSize)))
        header.append(contentsOf: u32(UInt32(uncompressedSize)))
        header.append(contentsOf: u16(UInt16(nameData.count)))
        header.append(contentsOf: u16(0))
        header.append(nameData)
        return header
    }

    private static func centralHeader(_ entry: CentralEntry) -> Data {
        var central = Data()
        central.append(contentsOf: [0x50, 0x4b, 0x01, 0x02])
        central.append(contentsOf: u16(20))
        central.append(contentsOf: u16(20))
        central.append(contentsOf: u16(0x0800))
        central.append(contentsOf: u16(entry.method))
        central.append(contentsOf: u16(0))
        central.append(contentsOf: u16(0))
        central.append(contentsOf: u32(entry.crc))
        central.append(contentsOf: u32(UInt32(entry.compressedSize)))
        central.append(contentsOf: u32(UInt32(entry.uncompressedSize)))
        central.append(contentsOf: u16(UInt16(entry.nameData.count)))
        central.append(contentsOf: u16(0))
        central.append(contentsOf: u16(0))
        central.append(contentsOf: u16(0))
        central.append(contentsOf: u16(0))
        central.append(contentsOf: u32(0))
        central.append(contentsOf: u32(UInt32(entry.localOffset)))
        central.append(entry.nameData)
        return central
    }

    private static func endOfCentralDirectory(
        entryCount: Int,
        centralSize: UInt32,
        centralOffset: UInt32
    ) -> Data {
        var end = Data()
        end.append(contentsOf: [0x50, 0x4b, 0x05, 0x06])
        end.append(contentsOf: u16(0))
        end.append(contentsOf: u16(0))
        end.append(contentsOf: u16(UInt16(entryCount)))
        end.append(contentsOf: u16(UInt16(entryCount)))
        end.append(contentsOf: u32(centralSize))
        end.append(contentsOf: u32(centralOffset))
        end.append(contentsOf: u16(0))
        return end
    }
}
