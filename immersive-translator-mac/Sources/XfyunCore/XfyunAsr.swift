import Foundation

/// 讯飞流式听写（IAT）：16k PCM → 文本。对齐 src/core/xfyunAsr.ts。
/// - wss://iat-api.xfyun.cn/v2/iat，business.sub="iat"、domain="iat"。
/// - 首帧带 common/business + data(status=0)；音频帧 1280B/帧 base64(raw)；
///   结束帧 data.status=2。
/// - 结果 JSON：data.result.ws[].cw[].w 逐词拼接；sn 是段序号（last-write-wins，
///   按 sn 排序合并）；data.status=2 表示全部结束。
/// - 单次听写上限 60s（调用方自行限制在 15s 内）。

public enum XfyunAsr {
    public static let host = "iat-api.xfyun.cn"
    public static let path = "/v2/iat"
    /// 讯飞听写业务错误码 → 用户能看懂的话（详见会话层公共表）。
    static let frameBytes = 1280
}

public enum AsrLanguage: String, Sendable {
    case en_us
    case zh_cn
}

public struct IatSegment: Equatable {
    public var sn: Int
    public var text: String

    public init(sn: Int, text: String) {
        self.sn = sn
        self.text = text
    }
}

/// 从一条 IAT 结果消息（已解析的 JSON 对象）里取一段转写；非结果消息返回 nil。
public func extractIatSegment(payload: [String: Any]) -> IatSegment? {
    guard let data = payload["data"] as? [String: Any],
          let result = data["result"] as? [String: Any],
          let sn = result["sn"] as? Int,
          let ws = result["ws"] as? [[String: Any]] else { return nil }
    var text = ""
    for word in ws {
        // cw 是候选列表，第一个是最佳候选
        if let cw = word["cw"] as? [[String: Any]],
           let best = cw.first?["w"] as? String {
            text += best
        }
    }
    return IatSegment(sn: sn, text: text)
}

/// 按 sn 归并各段（后到覆盖先到），返回完整转写。
public func mergeIatSegments(_ segments: [Int: String]) -> String {
    segments
        .sorted { $0.key < $1.key }
        .map(\.value)
        .joined()
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

/// 首帧（common + business + data.status=0）。
public func buildIatFirstFrame(language: AsrLanguage) -> String {
    XfyunJSON.encode([
        "business": [
            "sub": "iat",
            "domain": "iat",
            "language": language.rawValue,
            "accent": "mandarin",
            "vad_eos": 1200,
            "ptt": 1,
        ],
        "data": [
            "status": 0,
            "format": "audio/L16;rate=16000",
            "encoding": "raw",
            "audio": "",
        ],
    ])
}

/// 音频帧（1280B/帧 base64(raw)，status=1）。
public func buildIatAudioFrame(_ piece: Data) -> String {
    XfyunJSON.encode([
        "data": [
            "status": 1,
            "format": "audio/L16;rate=16000",
            "encoding": "raw",
            "audio": piece.base64EncodedString(),
        ],
    ])
}

/// 结束帧（status=2）。
public func buildIatEndFrame() -> String {
    XfyunJSON.encode([
        "data": [
            "status": 2,
            "format": "audio/L16;rate=16000",
            "encoding": "raw",
            "audio": "",
        ],
    ])
}

public enum XfyunAsrError: Error, LocalizedError, Equatable {
    case emptyRecording
    case timeout(seconds: Int)

    public var errorDescription: String? {
        switch self {
        case .emptyRecording: return "录音数据为空"
        case .timeout(let s): return "识别超时（\(s)s 未返回）"
        }
    }
}

/// 整段语音（16k/16bit/单声道 PCM）→ 文本。
public func transcribeSpeech(
    pcm: Data,
    language: AsrLanguage,
    creds: XfyunCredentials,
    timeout: TimeInterval = 30
) async throws -> String {
    guard !pcm.isEmpty else { throw XfyunAsrError.emptyRecording }
    let url = XfyunAuth.buildAuthURL(host: XfyunAsr.host, path: XfyunAsr.path, creds: creds)

    var frames: [String] = []
    var offset = 0
    let bytes = [UInt8](pcm)
    while offset < bytes.count {
        let end = min(offset + XfyunAsr.frameBytes, bytes.count)
        frames.append(buildIatAudioFrame(Data(bytes[offset..<end])))
        offset = end
    }

    let segments = SegmentsBox()
    _ = try await XfyunWebSocketSession.run(
        url: url,
        firstFrame: buildIatFirstFrame(language: language),
        extraFrames: frames + [buildIatEndFrame()],
        timeout: timeout
    ) { obj in
        if let seg = extractIatSegment(payload: obj) {
            segments.put(seg.sn, seg.text)
        }
    } finish: { _ in
        return true
    }
    return mergeIatSegments(segments.all())
}

/// 线程安全的段收集器（会话回调在后台任务执行）。
final class SegmentsBox: @unchecked Sendable {
    private let lock = NSLock()
    private var map: [Int: String] = [:]

    func put(_ sn: Int, _ text: String) {
        lock.lock()
        defer { lock.unlock() }
        map[sn] = text
    }

    func all() -> [Int: String] {
        lock.lock()
        defer { lock.unlock() }
        return map
    }
}
