import Foundation
import Compression

/// 最小 zip 读取器（仅列表 + 读单文件），供 docx 解析使用。
/// docx 是标准 zip：中央目录定位条目 → 本地头校验 → 解压（deflate/stored）。
/// 不支持 zip64 与加密——超过这些能力的文件在 docx 场景不存在。

struct ZipEntry {
    var fileName: String
    var compressedSize: Int
    var uncompressedSize: Int
    var compressionMethod: UInt16
    var localHeaderOffset: Int
}

enum ZipArchiveError: Error, LocalizedError {
    case notAZipFile
    case entryNotFound(String)
    case unsupported(String)

    var errorDescription: String? {
        switch self {
        case .notAZipFile: return "不是有效的 zip 文件（缺少中央目录）"
        case .entryNotFound(let name): return "zip 里找不到 \(name)"
        case .unsupported(let what): return "不支持的 zip 特性：\(what)"
        }
    }
}

struct ZipArchive {
    var data: Data

    init(_ data: Data) throws {
        self.data = data
        guard try readEntryCount() >= 0 else { throw ZipArchiveError.notAZipFile }
    }

    // ---- 小端读取 ----

    private func u16(at offset: Int) -> Int {
        let v = UInt16(data[data.startIndex + offset]) | (UInt16(data[data.startIndex + offset + 1]) << 8)
        return Int(v)
    }

    private func u32(at offset: Int) -> Int {
        let v = UInt32(data[data.startIndex + offset])
            | (UInt32(data[data.startIndex + offset + 1]) << 8)
            | (UInt32(data[data.startIndex + offset + 2]) << 16)
            | (UInt32(data[data.startIndex + offset + 3]) << 24)
        return Int(v)
    }

    private func bytes(at offset: Int, length: Int) -> [UInt8] {
        Array(data[data.startIndex + offset ..< data.startIndex + offset + length])
    }

    /// End of Central Directory：从尾部向回找签名 0x06054b50（注释区最长 65535）。
    private func locateEOCD() throws -> Int {
        let count = data.count
        guard count >= 22 else { throw ZipArchiveError.notAZipFile }
        let scanStart = max(0, count - 22 - 65535)
        var offset = count - 22
        while offset >= scanStart {
            if u32(at: offset) == 0x06054b50 {
                return offset
            }
            offset -= 1
        }
        throw ZipArchiveError.notAZipFile
    }

    private func centralDirectoryOffset() throws -> Int {
        let eocd = try locateEOCD()
        // 偏移 16 = 中央目录起始偏移（低 32 位；zip64 拒绝）
        if u32(at: eocd + 16) == 0xFFFFFFFF || u32(at: eocd + 12) == 0xFFFF {
            throw ZipArchiveError.unsupported("zip64")
        }
        return u32(at: eocd + 16)
    }

    private func readEntryCount() throws -> Int {
        _ = try locateEOCD()
        return 0
    }

    func entries() throws -> [ZipEntry] {
        var dirOffset = try centralDirectoryOffset()
        let eocd = try locateEOCD()
        let entryCount = u16(at: eocd + 10)
        var result: [ZipEntry] = []
        for _ in 0..<entryCount {
            guard u32(at: dirOffset) == 0x02014b50 else { break }
            let method = UInt16(u16(at: dirOffset + 10))
            let compressedSize = u32(at: dirOffset + 20)
            let uncompressedSize = u32(at: dirOffset + 24)
            let nameLength = u16(at: dirOffset + 28)
            let extraLength = u16(at: dirOffset + 30)
            let commentLength = u16(at: dirOffset + 32)
            let localOffset = u32(at: dirOffset + 42)
            let nameBytes = bytes(at: dirOffset + 46, length: nameLength)
            let name = String(bytes: nameBytes, encoding: .utf8) ?? String(bytes: nameBytes, encoding: .ascii) ?? ""
            result.append(ZipEntry(
                fileName: name,
                compressedSize: compressedSize,
                uncompressedSize: uncompressedSize,
                compressionMethod: method,
                localHeaderOffset: localOffset
            ))
            dirOffset += 46 + nameLength + extraLength + commentLength
        }
        return result
    }

    /// 读出单个文件内容（按文件名精确匹配）。
    func readFile(named name: String) throws -> Data {
        guard let entry = try entries().first(where: { $0.fileName == name }) else {
            throw ZipArchiveError.entryNotFound(name)
        }
        // 本地头：0x04034b50 + 固定 30 字节 + 文件名 + 额外字段
        let lo = entry.localHeaderOffset
        guard u32(at: lo) == 0x04034b50 else { throw ZipArchiveError.notAZipFile }
        let nameLength = u16(at: lo + 26)
        let extraLength = u16(at: lo + 28)
        let dataOffset = lo + 30 + nameLength + extraLength
        let raw = Data(bytes(at: dataOffset, length: entry.compressedSize))
        switch entry.compressionMethod {
        case 0:
            return raw
        case 8:
            // zip 的 method 8 = raw deflate（无 zlib 头），Apple COMPRESSION_ZLIB 恰好就是 raw deflate。
            guard entry.uncompressedSize > 0 else { return Data() }
            var out = Data(count: entry.uncompressedSize)
            let written = out.withUnsafeMutableBytes { destPtr -> Int in
                raw.withUnsafeBytes { srcPtr -> Int in
                    compression_decode_buffer(
                        destPtr.bindMemory(to: UInt8.self).baseAddress!, entry.uncompressedSize,
                        srcPtr.bindMemory(to: UInt8.self).baseAddress!, entry.compressedSize,
                        nil, COMPRESSION_ZLIB
                    )
                }
            }
            guard written == entry.uncompressedSize else {
                throw ZipArchiveError.unsupported("解压后大小与目录记录不符")
            }
            return out
        default:
            throw ZipArchiveError.unsupported("压缩方法 \(entry.compressionMethod)")
        }
    }
}
