import Foundation

/// 讯飞语音评测（流式版 ISE）+ 结果解析（跟读评测）。对齐 src/core/pronunciation.ts。
/// - wss://ise-api.xfyun.cn/v2/open-ise，HMAC 签名鉴权。
/// - 首帧 ssb：business.text = '\uFEFF[content]\n' + 评测文本（明文 UTF-8，非 base64）。
/// - 音频帧 1280B/帧（≈40ms），aue=raw；结束帧 aus=4/status=2。
/// - 结果 XML 为 base64 分片，data.status==2 时拼接解码。
/// - en_vip/read_sentence 分数为 5 分制；word 层有 total_score 与 dp_message
///   （0 正常 / 16 漏读 / 32 增读 / 64 回读 / 128 替换）。

public enum XfyunIse {
    public static let host = "ise-api.xfyun.cn"
    static let path = "/v2/open-ise"
}

/// 音素级结果（gwpp 是 GOP 逐音素惩罚值，绝对值越大问题越大）。
public struct PhoneScore: Equatable, Sendable {
    public var content: String
    public var dpMessage: Int
    public var gwpp: Double

    public init(content: String, dpMessage: Int, gwpp: Double) {
        self.content = content
        self.dpMessage = dpMessage
        self.gwpp = gwpp
    }
}

/// 音节级结果。
public struct SyllScore: Equatable, Sendable {
    public var content: String
    public var syllScore: Double
    public var serrMsg: Int
    public var phones: [PhoneScore]

    public init(content: String, syllScore: Double, serrMsg: Int, phones: [PhoneScore]) {
        self.content = content
        self.syllScore = syllScore
        self.serrMsg = serrMsg
        self.phones = phones
    }
}

/// 词级结果（content 是识别出的词，位置是音频帧，不是字符）。
public struct WordScore: Equatable, Sendable {
    public var content: String
    public var totalScore: Double
    public var dpMessage: Int
    public var sylls: [SyllScore]

    public init(content: String, totalScore: Double, dpMessage: Int, sylls: [SyllScore] = []) {
        self.content = content
        self.totalScore = totalScore
        self.dpMessage = dpMessage
        self.sylls = sylls
    }
}

/// 一次跟读评测结果（分数均为 5 分制）。
public struct PronunciationResult: Equatable, Sendable {
    public var total: Double
    public var accuracy: Double
    public var fluency: Double
    public var standard: Double
    public var isRejected: Bool
    /// 异常码字符串（"28673" 无语音/音量小、"28676" 乱说、"28680" 信噪比低…）；正常为 nil。
    public var exceptInfo: String?
    public var words: [WordScore]

    public init(
        total: Double, accuracy: Double, fluency: Double, standard: Double,
        isRejected: Bool, exceptInfo: String?, words: [WordScore]
    ) {
        self.total = total
        self.accuracy = accuracy
        self.fluency = fluency
        self.standard = standard
        self.isRejected = isRejected
        self.exceptInfo = exceptInfo
        self.words = words
    }
}

public enum WordQuality: String, Sendable {
    case good
    case ok
    case bad
    case missed
}

/// 词在原文中的字符区间与着色档位（mapWordsToText 产出）。
public struct WordMark: Equatable, Sendable {
    public var start: Int
    public var end: Int
    public var quality: WordQuality
    public var score: Double

    public init(start: Int, end: Int, quality: WordQuality, score: Double) {
        self.start = start
        self.end = end
        self.quality = quality
        self.score = score
    }
}

// MARK: - PCM

/// Float32 [-1,1] → Int16 PCM 字节（小端）。
public func floatToPcm16Bytes(_ samples: [Float]) -> Data {
    var data = Data(capacity: samples.count * 2)
    for s in samples {
        let clamped = max(-1, min(1, s))
        let scaled = clamped < 0 ? Int16(clamped * 32768.0) : Int16(clamped * 32767.0)
        withUnsafeBytes(of: scaled.littleEndian) { data.append(contentsOf: $0) }
    }
    return data
}

// MARK: - 结果 XML 解析

private func attrMap(_ attrString: String) -> [String: String] {
    var map: [String: String] = [:]
    guard let re = try? NSRegularExpression(pattern: #"([a-zA-Z_]+)="([^"]*)""#) else { return map }
    let ns = attrString as NSString
    for m in re.matches(in: attrString, range: NSRange(location: 0, length: ns.length)) {
        guard let k = Range(m.range(at: 1), in: attrString),
              let v = Range(m.range(at: 2), in: attrString) else { continue }
        map[String(attrString[k])] = String(attrString[v])
    }
    return map
}

private func num(_ map: [String: String], _ key: String) -> Double {
    Double(map[key] ?? "") ?? 0
}

private func matchAll(_ text: String, pattern: String) -> [(String, String)] {
    guard let re = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]) else { return [] }
    let ns = text as NSString
    var out: [(String, String)] = []
    for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
        var attrs = ""
        if m.numberOfRanges > 1, let r1 = Range(m.range(at: 1), in: text) {
            attrs = String(text[r1])
        }
        var inner = ""
        if m.numberOfRanges > 2, let r2 = Range(m.range(at: 2), in: text) {
            inner = String(text[r2])
        }
        out.append((attrs, inner))
    }
    return out
}

private func parseSylls(_ inner: String) -> [SyllScore] {
    var out: [SyllScore] = []
    for (attrsRaw, inner) in matchAll(inner, pattern: #"<syll\b([^>]*)>([\s\S]*?)</syll>"#) {
        let attrs = attrMap(attrsRaw)
        var phones: [PhoneScore] = []
        // 成对与自闭合两种 phone 标签
        for (pa, _) in matchAll(inner, pattern: #"<phone\b([^>]*)>([\s\S]*?)</phone>"#) {
            let a = attrMap(pa)
            phones.append(PhoneScore(content: a["content"] ?? "", dpMessage: Int(a["dp_message"] ?? "0") ?? 0, gwpp: Double(a["gwpp"] ?? "0") ?? 0))
        }
        for (pa, _) in matchAll(inner, pattern: #"<phone\b([^>]*?)\s*/>"#) {
            let a = attrMap(pa)
            phones.append(PhoneScore(content: a["content"] ?? "", dpMessage: Int(a["dp_message"] ?? "0") ?? 0, gwpp: Double(a["gwpp"] ?? "0") ?? 0))
        }
        out.append(SyllScore(
            content: attrs["content"] ?? "",
            syllScore: Double(attrs["syll_score"] ?? "0") ?? 0,
            serrMsg: Int(attrs["serr_msg"] ?? "0") ?? 0,
            phones: phones
        ))
    }
    return out
}

/// 解析评测结果 XML。英文题型层级：read_chapter（篇章分）> sentence（句分）> word > syll > phone。
/// is_rejected / except_info 挂在篇章层，句层兜底。
public func parseIseXml(_ xml: String) -> PronunciationResult {
    let sentenceAttrs = matchAll(xml, pattern: #"<sentence\b([^>]*)>"#).first.map { attrMap($0.0) } ?? [:]
    let chapterAttrs = matchAll(xml, pattern: #"<read_chapter\b([^>]*)>"#).first.map { attrMap($0.0) } ?? sentenceAttrs

    var words: [WordScore] = []
    // 成对与自闭合两种 word 标签合并按文档序匹配（漏读词常是自闭合）。
    for (attrsRaw, inner) in matchAll(xml, pattern: #"<word\b([^>]*)>([\s\S]*?)</word>"#) {
        let attrs = attrMap(attrsRaw)
        words.append(WordScore(
            content: attrs["content"] ?? "",
            totalScore: Double(attrs["total_score"] ?? "0") ?? 0,
            dpMessage: Int(attrs["dp_message"] ?? "0") ?? 0,
            sylls: parseSylls(inner)
        ))
    }
    for (attrsRaw, _) in matchAll(xml, pattern: #"<word\b([^>]*?)\s*/>"#) {
        let attrs = attrMap(attrsRaw)
        words.append(WordScore(
            content: attrs["content"] ?? "",
            totalScore: Double(attrs["total_score"] ?? "0") ?? 0,
            dpMessage: Int(attrs["dp_message"] ?? "0") ?? 0,
            sylls: []
        ))
    }

    let except = chapterAttrs["except_info"].flatMap { $0 != "0" ? $0 : nil }
    return PronunciationResult(
        total: num(sentenceAttrs, "total_score"),
        accuracy: num(sentenceAttrs, "accuracy_score"),
        fluency: num(sentenceAttrs, "fluency_score"),
        standard: num(sentenceAttrs, "standard_score"),
        isRejected: chapterAttrs["is_rejected"] == "true",
        exceptInfo: except,
        words: words
    )
}

// MARK: - 识别词 → 原文词对齐（着色用）

func normalizeIseWord(_ s: String) -> String {
    s.lowercased()
        .replacingOccurrences(of: "’", with: "'")
        .replacingOccurrences(of: "'", with: "")
}

/// 把评测返回的词序列映射到原文的字符区间。
/// ISE 的 word 只有音频帧位置，没有字符位置；read_sentence 的强制对齐保持词序。
/// 对齐用保序最大匹配（小规模 DP）：贪心向前扫在重复词（the/to/that）上会把
/// 后出现的识别词抢先配给前面的原文词，着色整体错位。
/// dp=32（增读）原文没有位置，不参与对齐。
public func mapWordsToText(text: String, words: [WordScore]) -> [WordMark] {
    struct Token {
        var start: Int
        var end: Int
        var norm: String
    }

    var tokens: [Token] = []
    if let re = try? NSRegularExpression(pattern: #"[A-Za-z0-9'‘’-]+"#) {
        let ns = text as NSString
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            guard let r = Range(m.range, in: text) else { continue }
            tokens.append(Token(
                start: m.range.location,
                end: m.range.location + m.range.length,
                norm: normalizeIseWord(String(text[r]))
            ))
        }
    }

    let usable = words
        .filter { $0.dpMessage != 32 }
        .map { ($0, normalizeIseWord($0.content)) }
        .filter { !$1.isEmpty }

    let n = usable.count
    let t = tokens.count
    if n == 0 || t == 0 { return [] }

    struct Choice {
        var count: Int
        var take: Bool
        var match: Int
    }
    var memo = [Int: Choice]()

    func best(_ i: Int, _ p: Int) -> Choice {
        if i >= n || p >= t { return Choice(count: 0, take: false, match: -1) }
        let key = i * (t + 1) + p
        if let hit = memo[key] { return hit }
        // 选项 A：这个词对不上（放弃着色）
        var count = best(i + 1, p).count
        var take = false
        var match = -1
        // 选项 B：配到 p 之后第一处同名词
        var k = p
        while k < t, tokens[k].norm != usable[i].1 { k += 1 }
        if k < t {
            let via = best(i + 1, k + 1).count + 1
            if via > count {
                count = via
                take = true
                match = k
            }
        }
        let result = Choice(count: count, take: take, match: match)
        memo[key] = result
        return result
    }

    var marks: [WordMark] = []
    var p = 0
    for i in 0..<n {
        let choice = best(i, p)
        if !choice.take { continue }
        let word = usable[i].0
        let token = tokens[choice.match]
        // dp=16 漏读 → 底纹；dp=128（读成别的词）读是读了但读错 → 按分数着色
        let quality: WordQuality
        if word.dpMessage == 16 {
            quality = .missed
        } else if word.totalScore >= 4 {
            quality = .good
        } else if word.totalScore >= 3 {
            quality = .ok
        } else {
            quality = .bad
        }
        marks.append(WordMark(start: token.start, end: token.end, quality: quality, score: word.totalScore))
        p = choice.match + 1
    }
    return marks
}

/// 过关判定：未乱读且句分达到阈值。
public func isIsePass(_ result: PronunciationResult, passScore: Double) -> Bool {
    !result.isRejected && result.exceptInfo == nil && result.total >= passScore
}

// MARK: - 评测会话

/// 首帧 ssb（评测文本明文 UTF-8，非 base64）。
/// 手动拼 JSON：Foundation 的 JSON 解析会吞掉字符串开头的 U+FEFF（实测
/// 直接写与 `\ufeff` 转义都被剥），而讯飞要求 text 以 BOM 开头——不能走 JSONSerialization。
public func buildIseFirstFrame(appId: String, text: String) -> String {
    func escaped(_ s: String) -> String {
        var out = ""
        for ch in s.unicodeScalars {
            switch ch {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if ch.value < 0x20 {
                    out += String(format: "\\u%04x", ch.value)
                } else {
                    out.unicodeScalars.append(ch)
                }
            }
        }
        return out
    }
    return """
    {"business":{"aue":"raw","auf":"audio/L16;rate=16000","category":"read_sentence","cmd":"ssb","ent":"en_vip","sub":"ise","ttp_skip":true,"tte":"utf-8","text":"\u{FEFF}[content]\\n\(escaped(text))"},"common":{"app_id":"\(escaped(appId))"},"data":{"data":"","status":0}}
    """
}

/// 音频帧（首帧 aus=1、其余 aus=2）。
public func buildIseAudioFrame(_ piece: Data, first: Bool) -> String {
    XfyunJSON.encode([
        "business": ["cmd": "auw", "aus": first ? 1 : 2, "aue": "raw"],
        "data": [
            "status": 1,
            "data": piece.base64EncodedString(),
            "data_type": 1,
            "encoding": "raw",
        ],
    ])
}

/// 结束帧（aus=4 / status=2）。
public func buildIseEndFrame() -> String {
    XfyunJSON.encode([
        "business": ["cmd": "auw", "aus": 4, "aue": "raw"],
        "data": ["status": 2, "data": "", "data_type": 1, "encoding": "raw"],
    ])
}

public enum XfyunIseError: Error, LocalizedError, Equatable {
    case emptyRecording
    case xmlDecodeFailure

    public var errorDescription: String? {
        switch self {
        case .emptyRecording: return "录音数据为空"
        case .xmlDecodeFailure: return "评测结果解码失败"
        }
    }
}

/// 整段跟读音频（16k/16bit/单声道 PCM）→ 评测结果。
public func assessPronunciation(
    text: String,
    pcm: Data,
    creds: XfyunCredentials,
    timeout: TimeInterval = 45
) async throws -> PronunciationResult {
    guard !pcm.isEmpty else { throw XfyunIseError.emptyRecording }
    let url = XfyunAuth.buildAuthURL(host: XfyunIse.host, path: XfyunIse.path, creds: creds)

    var frames: [String] = []
    var offset = 0
    let bytes = [UInt8](pcm)
    var first = true
    while offset < bytes.count {
        let end = min(offset + XfyunAsr.frameBytes, bytes.count)
        frames.append(buildIseAudioFrame(Data(bytes[offset..<end]), first: first))
        first = false
        offset = end
    }

    let box = XmlChunksBox()
    _ = try await XfyunWebSocketSession.run(
        url: url,
        firstFrame: buildIseFirstFrame(appId: creds.appId, text: text),
        extraFrames: frames + [buildIseEndFrame()],
        timeout: timeout
    ) { obj in
        if let data = obj["data"] as? [String: Any], let chunk = data["data"] as? String {
            box.append(chunk)
        }
    } finish: { _ in
        return true
    }
    let joined = box.all()
    guard let xmlData = Data(base64Encoded: joined) else { throw XfyunIseError.xmlDecodeFailure }
    let xmlText = String(data: xmlData, encoding: .utf8) ?? ""
    return parseIseXml(xmlText)
}

/// 线程安全的 base64 分片收集器。
final class XmlChunksBox: @unchecked Sendable {
    private let lock = NSLock()
    private var chunks: [String] = []

    func append(_ chunk: String) {
        lock.lock()
        defer { lock.unlock() }
        chunks.append(chunk)
    }

    func all() -> String {
        lock.lock()
        defer { lock.unlock() }
        return chunks.joined()
    }
}
