import Foundation

/// 讯飞在线语音合成（wss://tts-api.xfyun.cn/v2/tts）。
/// 对齐 src/core/xfyunTts.ts：
/// - 单帧请求：common{app_id} + business{aue:"lame", sfl:1, vcn, tte:"UTF8",
///   speed/volume/pitch 0-100} + data{text: base64, status: 2}。
/// - 响应：流式返回 data.audio（mp3 分片，每帧独立带 padding 的 base64，
///   必须逐帧解码再按字节拼接），累计到 data.status=2 拼完整音频。
/// - 语速策略：恒按 1× 合成（business.speed 固定 50），语速由播放端变速承担
///   （AVAudioPlayer enableRate）——切语速不重新合成、缓存跨语速命中。
/// - 单次文本 base64 前 < 8000 字节；每日 500 次免费。双层缓存避免重听烧额度。

public enum XfyunTts {
    public static let host = "tts-api.xfyun.cn"
    static let path = "/v2/tts"
    /// 官方限制：base64 编码前 < 8000 字节（约 2000 汉字）。
    public static let maxTextBytes = 8000
    /// vcn 缺省发音人（中文句）。
    public static let defaultVcn = "xiaoyan"
    /// 英文句缺省发音人：英文句与中文句分音色，跟读示范不用中文音色读英文。
    public static let defaultVcnEn = "catherine"

    /// 设置抽屉「云音色」输入框的建议列表（完整列表以讯飞控制台为准）。
    public static let voiceSuggestions: [(vcn: String, label: String)] = [
        ("catherine", "catherine · 英语女声"),
        ("xiaoyan", "xiaoyan · 小燕，中文女声（中英混合）"),
        ("x4_xiaoyan", "x4_xiaoyan · 新一代小燕"),
        ("aisjiuxu", "aisjiuxu · 许久，中文男声"),
        ("aisxping", "aisxping · 小萍，中文女声（方言）"),
        ("aisbabyxu", "aisbabyxu · 童声"),
    ]

    /// 合成文本的语言判定（选 cn/en 音色）：CJK 为主判中文。
    public static func looksChinese(_ text: String) -> Bool {
        var cjk = 0
        var latin = 0
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x4E00...0x9FFF, 0x3400...0x4DBF:
                cjk += 1
            case 0x41...0x5A, 0x61...0x7A:
                latin += 1
            default:
                break
            }
        }
        return cjk * 2 >= latin
    }
}

public struct XfyunTtsOptions: Equatable, Sendable {
    /// 发音人：中文句用中文 vcn，英文句用英文 vcn（由引擎按句子语言选择）。
    public var vcn: String
    /// 音量 0–100，默认 50。
    public var volume: Int

    public init(vcn: String = XfyunTts.defaultVcn, volume: Int = 50) {
        self.vcn = vcn
        self.volume = volume
    }
}

public enum XfyunTtsError: Error, LocalizedError, Equatable {
    case emptyText
    case tooLong
    case decodeFailure
    case emptyAudio

    public var errorDescription: String? {
        switch self {
        case .emptyText: return "合成文本为空"
        case .tooLong: return "文本太长（单次 < 8000 字节，请按句朗读）"
        case .decodeFailure: return "音频分片解码失败（base64 非法）"
        case .emptyAudio: return "合成返回空音频"
        }
    }
}

/// 构造一次性请求帧（单测用）。语速恒 1×，变速在播放端。
public func buildTtsRequestFrame(appId: String, text: String, opts: XfyunTtsOptions) -> String {
    let payload: [String: Any] = [
        "common": ["app_id": appId],
        "business": [
            "aue": "lame",  // mp3
            "sfl": 1,  // 流式返回
            "auf": "audio/L16;rate=16000",
            "vcn": opts.vcn.isEmpty ? XfyunTts.defaultVcn : opts.vcn,
            "tte": "UTF8",
            "speed": 50,
            "volume": min(100, max(0, opts.volume)),
            "pitch": 50,
        ],
        "data": [
            "status": 2,
            "text": Data(text.utf8).base64EncodedString(),
        ],
    ]
    return XfyunJSON.encode(payload)
}

/// 缓存键 = vcn|volume|text（语速不入键，变速在播放端）。
public func ttsCacheKey(text: String, opts: XfyunTtsOptions) -> String {
    "\(opts.vcn.isEmpty ? XfyunTts.defaultVcn : opts.vcn)|\(opts.volume)|\(text)"
}

/// L1 内存 LRU 缓存（约一篇短文逐句 + 若干重听）。
public final class TtsLruCache: @unchecked Sendable {
    public static let limit = 80

    private let lock = NSLock()
    private var map: [String: Data] = [:]
    private var order: [String] = []

    public init(limit: Int = TtsLruCache.limit) {
        self.limitCount = limit
    }

    private let limitCount: Int

    public func get(_ key: String) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        guard let hit = map[key] else { return nil }
        if let idx = order.firstIndex(of: key) {
            order.remove(at: idx)
            order.append(key)
        }
        return hit
    }

    public func set(_ key: String, _ value: Data) {
        lock.lock()
        defer { lock.unlock() }
        if map[key] == nil {
            order.append(key)
        } else if let idx = order.firstIndex(of: key) {
            order.remove(at: idx)
            order.append(key)
        }
        map[key] = value
        while order.count > limitCount {
            let oldest = order.removeFirst()
            map.removeValue(forKey: oldest)
        }
    }

    public var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return map.count
    }
}

/// 合成一段文本，返回 mp3 数据（mp3 帧逐帧解码拼接）。
/// 网络直连 wss；命中缓存由上层（XfyunTtsEngine）负责。
public func synthesizeXfyunTts(
    text: String,
    opts: XfyunTtsOptions,
    creds: XfyunCredentials
) async throws -> Data {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw XfyunTtsError.emptyText }
    guard Data(trimmed.utf8).count < XfyunTts.maxTextBytes else { throw XfyunTtsError.tooLong }

    let url = XfyunAuth.buildAuthURL(host: XfyunTts.host, path: XfyunTts.path, creds: creds)
    let frame = buildTtsRequestFrame(appId: creds.appId, text: trimmed, opts: opts)

    var chunks: [Data] = []
    return try await XfyunWebSocketSession.run(
        url: url,
        firstFrame: frame,
        timeout: 20
    ) { obj in
        if let data = obj["data"] as? [String: Any], let audio = data["audio"] as? String {
            guard let piece = Data(base64Encoded: audio) else {
                // 每帧独立带 padding 的 base64，逐帧解码
                return
            }
            chunks.append(piece)
        }
    } finish: { _ in
        let total = chunks.reduce(0) { $0 + $1.count }
        guard total > 0 else { throw XfyunTtsError.emptyAudio }
        return chunks.reduce(Data()) { $0 + $1 }
    }
}
