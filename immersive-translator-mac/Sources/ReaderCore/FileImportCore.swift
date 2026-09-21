import Foundation

/// 本地文件导入的纯逻辑部分：文件类型识别、编码探测、PDF 行合并、难度估值。
/// 对齐 src/core/fileImport.ts 与 ImportDialog.tsx 的 estimateLevel。
/// docx 的 zip/XML 抽取见 DocxTextExtractor.swift；PDF 的 PDFKit 读取在应用层。

public enum ImportFileKind: String, Equatable {
    case txt
    case docx
    case pdf

    public var label: String {
        switch self {
        case .txt: return "文本文件"
        case .docx: return "Word 文档"
        case .pdf: return "PDF"
        }
    }
}

/// 带中文提示的导入失败；message 直接进导入弹窗的失败态。
public struct FileImportError: Error, LocalizedError {
    public var message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
}

public func detectImportFileKind(fileName: String) -> ImportFileKind? {
    let lower = fileName.lowercased()
    if lower.hasSuffix(".txt") { return .txt }
    if lower.hasSuffix(".docx") { return .docx }
    if lower.hasSuffix(".pdf") { return .pdf }
    return nil
}

/// 文件来源 → ArticleSourceType；txt 维持既有 paste。
public func importKindSourceType(_ kind: ImportFileKind) -> ArticleSourceType {
    switch kind {
    case .pdf: return .pdf
    case .docx: return .docx
    case .txt: return .paste
    }
}

/// 文件名去扩展名做默认标题。
public func fileTitleOf(fileName: String) -> String {
    let base = fileName
        .replacingOccurrences(of: #"\.[^.]+$"#, with: "", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return base.isEmpty ? fileName : base
}

// 纯文本 4MB 与粘贴页一致；docx/pdf 常嵌图片与字体子集（不影响文本抽取），
// 放宽到 32MB（仍拒绝大部头扫描件）。
let maxTextFileBytes = 4 * 1024 * 1024
let maxDocFileBytes = 32 * 1024 * 1024

public func maxBytesForKind(_ kind: ImportFileKind) -> Int {
    kind == .txt ? maxTextFileBytes : maxDocFileBytes
}

/// 抽出的文件正文。
public struct ExtractedFileText: Equatable {
    public var kind: ImportFileKind
    public var text: String
    /// PDF 页数（其他格式缺省）。
    public var pages: Int?

    public init(kind: ImportFileKind, text: String, pages: Int? = nil) {
        self.kind = kind
        self.text = text
        self.pages = pages
    }
}

/// 按字节探测编码解码文本文件：UTF-8（含 BOM）/ UTF-16（BOM）/ GBK 兜底。
/// 中文 Windows 记事本「ANSI」编码的 .txt 是常见场景，按 UTF-8 直读会整篇乱码。
public func decodeTextBytes(_ bytes: Data) -> String {
    let array = [UInt8](bytes)
    // BOM 优先
    if array.count >= 3, array[0] == 0xEF, array[1] == 0xBB, array[2] == 0xBF {
        return decodeCString(Array(array[3...]), encoding: .utf8) ?? ""
    }
    if array.count >= 2, array[0] == 0xFF, array[1] == 0xFE {
        return decodeCString(Array(array[2...]), encoding: .utf16LittleEndian) ?? ""
    }
    if array.count >= 2, array[0] == 0xFE, array[1] == 0xFF {
        return decodeCString(Array(array[2...]), encoding: .utf16BigEndian) ?? ""
    }
    // 严格 UTF-8：GBK 字节序列几乎必然非法，据此区分两种常见编码。
    if let strict = decodeStrictUTF8(array) {
        return strict
    }
    // GB18030（GBK 超集）兜底；解码出替换字符则退回宽松 UTF-8。
    if let gbk = decodeCString(array, encoding: .gb18030_2000), !gbk.contains("\u{FFFD}") {
        return gbk
    }
    return decodeCString(array, encoding: .utf8) ?? ""
}

private func decodeCString(_ bytes: [UInt8], encoding: String.Encoding) -> String? {
    String(bytes: bytes, encoding: encoding)
}

extension String.Encoding {
    /// GB18030（GBK 超集；Foundation 没有常量，kCFStringEncodingGB_18030_1980 = 0x0631）。
    static let gb18030_2000: String.Encoding = {
        let cf = CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(0x0631))
        return String.Encoding(rawValue: cf)
    }()
}

/// 严格 UTF-8 校验：任何非法字节序列返回 nil（对齐 TextDecoder fatal 模式）。
private func decodeStrictUTF8(_ bytes: [UInt8]) -> String? {
    var decoder = UTF8()
    var iterator = bytes.makeIterator()
    var scalars = String.UnicodeScalarView()
    while true {
        switch decoder.decode(&iterator) {
        case .scalarValue(let v):
            scalars.append(v)
        case .emptyInput:
            return String(scalars)
        case .error:
            return nil
        }
    }
}

/// 行 → 段落文本：行尾 "word-" 且下一行小写开头时去连字符拼接（跨行断词），
/// 其余行以空格相连。整页合成一个段落 —— PDF 里行内句号不等于段落结束，
/// 段落结构无从可靠恢复，交给 splitSentences 按句界切分即可。
public func joinPdfLines(_ lines: [String]) -> String {
    var parts: [String] = []
    for raw in lines {
        let line = raw.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if line.isEmpty { continue }
        // 行尾 "word-" 且下一行小写开头 → 去连字符拼接（跨行断词）
        if let prev = parts.last,
           prev.count >= 2,
           prev.hasSuffix("-"),
           let prevLast = prev.dropLast().last,
           prevLast.isASCII, prevLast.isLetter,
           let first = line.first,
           first.isASCII, first.isLetter, first.isLowercase {
            parts[parts.count - 1] = String(prev.dropLast()) + line
        } else {
            parts.append(line)
        }
    }
    return parts.joined(separator: " ")
        .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

/// 是否存在可读文字（判定文本层，而非页码/装饰字符）。
public func hasMeaningfulText(_ text: String) -> Bool {
    if text.range(of: #"[A-Za-z]{2,}"#, options: .regularExpression) != nil { return true }
    if text.range(of: #"[\u{4e00}-\u{9fff}]{2,}"#, options: .regularExpression) != nil { return true }
    return false
}

/// 难度估值（平均句长）：≤13 A2 / ≤17 B1 / ≤22 B2 / 其余 C1。
public func estimateLevel(text: String, sentences: Int) -> String {
    let words = countWords(text)
    if sentences == 0 || words == 0 { return "B1" }
    let avgLen = Double(words) / Double(sentences)
    if avgLen <= 13 { return "A2" }
    if avgLen <= 17 { return "B1" }
    if avgLen <= 22 { return "B2" }
    return "C1"
}

/// 导入预览统计：词数 / 段数 / 估时（135 wpm）/ 难度。
public struct IntakePreviewStats: Equatable {
    public var words: Int
    public var paras: Int
    public var minutes: Int
    public var level: String

    public init(text: String) {
        let words = countWords(text)
        let paras = splitParagraphs(text).count
        let sentenceCount = splitParagraphs(text).reduce(0) { $0 + $1.sentences.count }
        self.words = words
        self.paras = paras
        self.minutes = max(1, Int((Double(words) / 135.0).rounded()))
        self.level = estimateLevel(text: text, sentences: max(1, sentenceCount))
    }
}
