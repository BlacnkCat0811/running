import Foundation
import zlib

nonisolated enum StoredZip {
    static func write(files: [(name: String, url: URL)], to url: URL) throws {
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
            try output.write(contentsOf: end)
            try output.synchronize()
            try output.close()

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

    static func write(entries: [(name: String, data: Data)], to url: URL) throws {
        var localOffset: UInt32 = 0
        var locals = Data()
        var centrals = Data()
        for entry in entries {
            let nameData = Data(entry.name.utf8)
            let crc = crc32(entry.data)
            // ZIP method 8 is raw deflate (RFC 1951). zlib-wrapped bytes
            // (compress2) will fail in the Node extractor.
            let compressed = deflate(entry.data)
            let (storedData, method): (Data, UInt16) =
                compressed.count > 0 && compressed.count < entry.data.count
                    ? (compressed, 8)
                    : (entry.data, 0)
            let size = UInt32(storedData.count)
            let uncompressedSize = UInt32(entry.data.count)
            var local = Data()
            local.append(contentsOf: [0x50, 0x4b, 0x03, 0x04])
            local.append(contentsOf: u16(20))
            local.append(contentsOf: u16(0))
            local.append(contentsOf: u16(method))
            local.append(contentsOf: u16(0))
            local.append(contentsOf: u16(0))
            local.append(contentsOf: u32(crc))
            local.append(contentsOf: u32(size))
            local.append(contentsOf: u32(uncompressedSize))
            local.append(contentsOf: u16(UInt16(nameData.count)))
            local.append(contentsOf: u16(0))
            local.append(nameData)
            local.append(storedData)
            var central = Data()
            central.append(contentsOf: [0x50, 0x4b, 0x01, 0x02])
            central.append(contentsOf: u16(20))
            central.append(contentsOf: u16(20))
            central.append(contentsOf: u16(0))
            central.append(contentsOf: u16(method))
            central.append(contentsOf: u16(0))
            central.append(contentsOf: u16(0))
            central.append(contentsOf: u32(crc))
            central.append(contentsOf: u32(size))
            central.append(contentsOf: u32(uncompressedSize))
            central.append(contentsOf: u16(UInt16(nameData.count)))
            central.append(contentsOf: u16(0))
            central.append(contentsOf: u16(0))
            central.append(contentsOf: u16(0))
            central.append(contentsOf: u16(0))
            central.append(contentsOf: u32(0))
            central.append(contentsOf: u32(localOffset))
            central.append(nameData)
            locals.append(local)
            centrals.append(central)
            localOffset += UInt32(local.count)
        }
        var end = Data()
        end.append(contentsOf: [0x50, 0x4b, 0x05, 0x06])
        end.append(contentsOf: u16(0))
        end.append(contentsOf: u16(0))
        end.append(contentsOf: u16(UInt16(entries.count)))
        end.append(contentsOf: u16(UInt16(entries.count)))
        end.append(contentsOf: u32(UInt32(centrals.count)))
        end.append(contentsOf: u32(localOffset))
        end.append(contentsOf: u16(0))
        try (locals + centrals + end).write(to: url, options: .atomic)
    }

    private static func deflate(_ data: Data) -> Data {
        guard !data.isEmpty else { return Data() }
        return data.withUnsafeBytes { sourceBuffer in
            guard let source = sourceBuffer.bindMemory(to: Bytef.self).baseAddress else {
                return Data()
            }
            var stream = z_stream()
            stream.next_in = UnsafeMutablePointer(mutating: source)
            stream.avail_in = uInt(data.count)
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
            guard initStatus == Z_OK else { return Data() }
            defer { deflateEnd(&stream) }

            let chunkSize = 16 * 1024
            var output = Data()
            var buffer = [UInt8](repeating: 0, count: chunkSize)
            var status: Int32
            repeat {
                status = buffer.withUnsafeMutableBytes { destBuffer in
                    stream.next_out = destBuffer.bindMemory(to: Bytef.self).baseAddress
                    stream.avail_out = uInt(destBuffer.count)
                    return zlib.deflate(&stream, Z_FINISH)
                }
                let produced = chunkSize - Int(stream.avail_out)
                if produced > 0 {
                    output.append(contentsOf: buffer.prefix(produced))
                }
            } while status == Z_OK
            return status == Z_STREAM_END ? output : Data()
        }
    }

    private static func crc32(_ data: Data) -> UInt32 {
        data.withUnsafeBytes { buffer in
            let pointer = buffer.bindMemory(to: Bytef.self).baseAddress
            return UInt32(zlib.crc32(0, pointer, uInt(buffer.count)))
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

    private enum StoredZipError: Error {
        case compressionFailed
        case fileTooLarge
        case outputCreationFailed
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
