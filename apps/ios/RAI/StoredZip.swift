import Foundation
import zlib

enum StoredZip {
    static func write(files: [(name: String, url: URL)], to url: URL) throws {
        let entries = try files.map { file in
            (name: file.name, data: try Data(contentsOf: file.url, options: [.mappedIfSafe]))
        }
        try write(entries: entries, to: url)
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
}
