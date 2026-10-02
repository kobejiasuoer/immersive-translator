import Foundation
import CryptoKit

// MARK: - Edge 在线语音合成（微软 Edge 浏览器「大声朗读」同源服务，逆向接口）
//
// XfyunCore 定位为「第三方语音服务协议层」：讯飞之外，微软 Edge 在线合成
// （免费无凭据）的协议细节也落在这一层。对齐 src/core/edgeTts.ts：
// - 端点：wss + TrustedClientToken（公开常量）+ Sec-MS-GEC（防滥用签名）+
//   Sec-MS-GEC-Version。Sec-MS-GEC = SHA-256 大写十六进制(ticks + TOKEN)，
//   ticks 为对齐到 5 分钟窗口的 Windows filetime——本机时钟偏差 >5 分钟即 403，
//   失败后用 voices 接口的 Date 头校准一次再重试。
// - 握手要求 User-Agent：mac 端 URLSession 不会自动携带浏览器 UA，必须显式设置
//   （主版本与 Sec-MS-GEC-Version 对齐；服务端只校验格式）。
// - 帧序列：连上发两条文本帧（speech.config 指定 mp3 输出；ssml 带 voice/prosody），
//   语速恒 +0%（变速由播放端 AVAudioPlayer 承担，与讯飞引擎同一策略）。
// - 响应：二进制帧 = 2 字节大端头长 + 头文本（含 Path:audio）+ mp3 净荷，逐帧累加；
//   文本帧含 Path:turn.end 收尾。
// - 免费无凭据，但属非官方接口：微软可能收紧，引擎链里必须有本地系统语音兜底
//   （回落语义在 ReaderPlaybackEngine.speakCloud，不在本层）。
//
// 注意：与讯飞 XfyunWebSocketSession.run（JSON 帧 + code!=0 + status==2）不同构，
// 不复用；只借鉴其 TaskGroup 超时竞速骨架。

/// Edge 在线合成的协议常量（逐字对齐 edgeTts.ts）。
public enum EdgeTts {
    /// 逆向自浏览器的公开客户端令牌（非机密）。
    public static let trustedClientToken = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
    /// 随 Chromium 主版本走；服务端只校验格式，过大版本号无副作用（edge-tts 同款策略）。
    public static let secMsGecVersion = "1-143.0.3650.75"
    public static let wssURL =
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
    /// voices 列表接口：校准时钟用（只读响应 Date 头，不解析列表）。
    public static let voicesURL =
        "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list"
    public static let outputFormat = "audio-24khz-48kbitrate-mono-mp3"
    /// 单次合成的整体超时（20s 无结果视为失败）。
    public static let requestTimeout: TimeInterval = 20
    /// 握手 UA：Chromium 143 的 macOS Edge 串，主版本与 secMsGecVersion 的 143 对齐。
    public static let userAgent =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.3650.75"
    /// Windows filetime 纪元差（1601-01-01 与 1970-01-01 之间）与每秒 tick 数。
    public static let winEpochSeconds = 11_644_473_600
    public static let ticksPerSecond = 10_000_000
    /// 签名对齐窗口：token 在每个 5 分钟窗口内有效。
    public static let tokenWindowSeconds = 300

    /// 中文句缺省音色：晓晓。
    public static let defaultVoice = "zh-CN-XiaoxiaoNeural"
    /// 英文句缺省音色：Ava。
    public static let defaultVoiceEn = "en-US-AvaNeural"

    /// 设置抽屉「Edge 音色」输入框的建议列表（对齐 EDGE_TTS_VOICE_SUGGESTIONS）。
    public static let voiceSuggestions: [(voice: String, label: String)] = [
        ("en-US-AvaNeural", "Ava · 英语女声，自然（默认）"),
        ("en-US-AndrewNeural", "Andrew · 英语男声，自然"),
        ("en-US-EmmaNeural", "Emma · 英语女声，温和"),
        ("en-US-BrianNeural", "Brian · 英语男声，沉稳"),
        ("en-US-JennyNeural", "Jenny · 英语女声，亲切"),
        ("en-US-GuyNeural", "Guy · 英语男声，新闻"),
        ("en-US-AvaMultilingualNeural", "Ava · 多语种女声"),
        ("zh-CN-XiaoxiaoNeural", "晓晓 · 中文女声（默认）"),
        ("zh-CN-YunxiNeural", "云希 · 中文男声，阳光"),
        ("zh-CN-YunyangNeural", "云扬 · 中文男声，新闻"),
        ("zh-CN-XiaoyiNeural", "晓伊 · 中文女声，活泼"),
        ("zh-CN-YunjianNeural", "云健 · 中文男声，有力"),
    ]
}

public struct EdgeTtsOptions: Equatable, Sendable {
    /// Edge 音色 ShortName；空串 = 缺省音色（中文句晓晓 / 英文句由引擎选）。
    public var voice: String

    public init(voice: String = EdgeTts.defaultVoice) {
        self.voice = voice
    }
}

public enum EdgeTtsError: Error, LocalizedError, Equatable {
    case emptyText
    case timeout
    case connectionRejected
    case partialAudio
    case emptyAudio

    public var errorDescription: String? {
        switch self {
        case .emptyText: return "合成文本为空"
        case .timeout: return "语音合成超时（20s 无结果）"
        case .connectionRejected: return "连接被拒：网络不可达或服务暂不可用"
        // 微调 Windows 原文「中断」→「断开」：让 classifyTtsError 的网络正则命中，归因落网络类。
        case .partialAudio: return "连接提前断开（音频不完整）"
        case .emptyAudio: return "合成返回空音频"
        }
    }
}

// MARK: - 缓存键

/// 缓存键 = edge:voice|text（语速不入键，变速由播放端承担；空音色回落缺省音色）。
public func edgeCacheKey(text: String, opts: EdgeTtsOptions) -> String {
    "edge:\(opts.voice.isEmpty ? EdgeTts.defaultVoice : opts.voice)|\(text)"
}

// MARK: - 请求帧构造（纯函数，单测可及）

/// ssml 文本帧：voice 嵌入 + prosody 恒 +0%（变速由播放端承担）。
/// 文本做 &/</> 转义后嵌入；locale 取音色前两段。
public func buildEdgeSsmlMessage(voice: String, text: String, requestId: String, timestamp: String) -> String {
    var locale = voice.split(separator: "-").prefix(2).joined(separator: "-")
    if locale.isEmpty { locale = "en-US" }
    let safe = text
        .replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
    let ssml =
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='\(locale)'>" +
        "<voice name='\(voice)'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>\(safe)</prosody></voice></speak>"
    return (
        "X-RequestId:\(requestId)\r\nContent-Type:application/ssml+xml\r\n" +
        "X-Timestamp:\(timestamp)\r\nPath:ssml\r\n\r\n\(ssml)"
    )
}

/// speech.config 文本帧：指定 mp3 输出格式（24kHz 48kbit 单声道）。
public func buildEdgeSpeechConfigMessage(timestamp: String) -> String {
    let payload: [String: Any] = [
        "context": [
            "synthesis": [
                "audio": [
                    "metadataoptions": [
                        "sentenceBoundaryEnabled": "false",
                        "wordBoundaryEnabled": "true",
                    ],
                    "outputFormat": EdgeTts.outputFormat,
                ],
            ],
        ],
    ]
    return (
        "X-Timestamp:\(timestamp)\r\nContent-Type:application/json; charset=utf-8\r\n" +
        "Path:speech.config\r\n\r\n\(XfyunJSON.encode(payload))"
    )
}

/// 解析一条二进制帧：返回 mp3 净荷（非音频帧返回 nil）。
/// 帧结构：2 字节大端头长 + 头文本（须含 Path:audio）+ 音频字节。
public func parseEdgeBinaryFrame(_ data: Data) -> Data? {
    let buf = [UInt8](data)
    guard buf.count >= 2 else { return nil }
    let headerLen = (Int(buf[0]) << 8) | Int(buf[1])
    guard 2 + headerLen <= buf.count else { return nil }
    guard let header = String(data: Data(buf[2..<(2 + headerLen)]), encoding: .utf8),
          header.contains("Path:audio") else { return nil }
    return Data(buf[(2 + headerLen)...])
}

// MARK: - Sec-MS-GEC 签名

/// 计算签名用的 filetime ticks：对齐到 5 分钟窗口（对齐 edge-tts 算法）。
/// Int 为 64 位精确整数（ticks ≈ 1.16e17 < Int64.max）。
public func edgeTokenTicks(nowMs: Double, skewSeconds: Int) -> Int {
    var seconds = Int(nowMs / 1000) + skewSeconds + EdgeTts.winEpochSeconds
    seconds -= seconds % EdgeTts.tokenWindowSeconds
    return seconds * EdgeTts.ticksPerSecond
}

/// Sec-MS-GEC 签名：SHA-256("\(ticks)\(TOKEN)") 大写十六进制。
public func secMsGecToken(ticks: Int) -> String {
    let input = "\(ticks)\(EdgeTts.trustedClientToken)"
    let digest = SHA256.hash(data: Data(input.utf8))
    return digest.map { String(format: "%02X", $0) }.joined()
}

/// 拼 wss 握手地址（query 含签名，逐字对齐 edgeTts.ts:188-190）。
func buildEdgeWssURL(nowMs: Double, skewSeconds: Int) -> String {
    let gec = secMsGecToken(ticks: edgeTokenTicks(nowMs: nowMs, skewSeconds: skewSeconds))
    var components = URLComponents(string: EdgeTts.wssURL)!
    components.queryItems = [
        URLQueryItem(name: "TrustedClientToken", value: EdgeTts.trustedClientToken),
        URLQueryItem(name: "Sec-MS-GEC", value: gec),
        URLQueryItem(name: "Sec-MS-GEC-Version", value: EdgeTts.secMsGecVersion),
    ]
    return components.url?.absoluteString ?? EdgeTts.wssURL
}

/// JS `new Date().toString()` 形态的时间戳（X-Timestamp 头用）：
/// "Mon Sep 29 2026 10:30:00 GMT+0800 (China Standard Time)"。
func jsDateTimestamp(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "EEE MMM d yyyy HH:mm:ss 'GMT'ZZZ"
    let base = formatter.string(from: date)
    let zone = TimeZone.current
    let nameLocale = Locale(identifier: "en_US_POSIX")
    let name = zone.isDaylightSavingTime()
        ? (zone.localizedName(for: .daylightSaving, locale: nameLocale) ?? zone.identifier)
        : (zone.localizedName(for: .standard, locale: nameLocale) ?? zone.identifier)
    return "\(base) (\(name))"
}

// MARK: - 传输会话抽象（注入缝：单测用脚本传输替身，真实现不进单测）

/// 一条 Edge WebSocket 消息（URLSession 消息级重组后的一条完整 WS 消息）。
public enum EdgeTtsMessage: Sendable {
    case text(String)
    case data(Data)
}

/// 合成会话的传输抽象：connect(URL 由合成函数拼好，query 含 Sec-MS-GEC) →
/// 发两条文本帧 → 循环 receive 直到 turn.end。协议化是单测可注桩的前提
/// （URLSessionWebSocketTask 非 open 类不可替身）。
public protocol EdgeTtsTransport: AnyObject {
    func connect(url: String) async throws
    func send(_ text: String) async throws
    func receive() async throws -> EdgeTtsMessage
    func close()
}

/// EdgeTtsTransport 的生产实现：URLSessionWebSocketTask，握手带 Edge UA
/// （服务端拒无 UA 的握手，mac 端 URLSession 不会自动携带，必须显式设置）。
public final class URLSessionEdgeTtsTransport: EdgeTtsTransport, @unchecked Sendable {
    private var task: URLSessionWebSocketTask?

    public init() {}

    public func connect(url: String) throws {
        guard let components = URLComponents(string: url), let requestURL = components.url else {
            throw EdgeTtsError.connectionRejected
        }
        var request = URLRequest(url: requestURL)
        request.timeoutInterval = EdgeTts.requestTimeout
        request.setValue(EdgeTts.userAgent, forHTTPHeaderField: "User-Agent")
        let task = URLSession.shared.webSocketTask(with: request)
        self.task = task
        task.resume()
    }

    public func send(_ text: String) async throws {
        guard let task else { throw EdgeTtsError.connectionRejected }
        try await task.send(.string(text))
    }

    public func receive() async throws -> EdgeTtsMessage {
        guard let task else { throw EdgeTtsError.connectionRejected }
        while true {
            let message = try await task.receive()
            switch message {
            case .string(let text):
                return .text(text)
            case .data(let data):
                return .data(data)
            @unknown default:
                continue
            }
        }
    }

    public func close() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }
}

// MARK: - 时钟校准

/// 用 voices 接口响应的 Date 头校准时钟（URLSession 头字段大小写不敏感，比浏览器稳）。
/// 失败返回 nil——离线/接口不可用时保持原样重试或直接报错。
public func calibrateEdgeClockSkew() async -> Int? {
    var components = URLComponents(string: EdgeTts.voicesURL)!
    components.queryItems = [
        URLQueryItem(name: "trustedclienttoken", value: EdgeTts.trustedClientToken),
    ]
    var request = URLRequest(url: components.url!)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = EdgeTts.requestTimeout
    guard let (_, response) = try? await URLSession.shared.data(for: request),
          let http = response as? HTTPURLResponse,
          let dateText = http.value(forHTTPHeaderField: "Date") else { return nil }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "GMT")
    formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
    guard let serverDate = formatter.date(from: dateText) else { return nil }
    let skew = (serverDate.timeIntervalSince1970 - Date().timeIntervalSince1970).rounded()
    return Int(skew)
}

// MARK: - 合成（单次尝试 + 校准重试编排）

/// 单次合成尝试（不含校准重试）：connect → 发 config/ssml 两条文本帧 →
/// 循环 receive：文本帧含 Path:turn.end 收尾（全空抛 emptyAudio），
/// 二进制帧解析 Path:audio 净荷逐帧累积。错误/超时统一 close。
/// 传输层错误归一为 connectionRejected（无音频）/ partialAudio（已收音频）。
public func synthesizeEdgeTtsOnce(
    text: String,
    opts: EdgeTtsOptions,
    skewSeconds: Int,
    transport: EdgeTtsTransport
) async throws -> Data {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw EdgeTtsError.emptyText }
    let voice = opts.voice.isEmpty ? EdgeTts.defaultVoice : opts.voice

    var chunks: [Data] = []
    do {
        return try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask {
                try await transport.connect(
                    url: buildEdgeWssURL(nowMs: Date().timeIntervalSince1970 * 1000, skewSeconds: skewSeconds)
                )
                let timestamp = jsDateTimestamp(Date())
                try await transport.send(buildEdgeSpeechConfigMessage(timestamp: timestamp))
                try await transport.send(buildEdgeSsmlMessage(
                    voice: voice,
                    text: trimmed,
                    requestId: UUID().uuidString.replacingOccurrences(of: "-", with: ""),
                    timestamp: timestamp
                ))
                while true {
                    switch try await transport.receive() {
                    case .text(let message):
                        guard message.contains("Path:turn.end") else { continue }
                        let total = chunks.reduce(0) { $0 + $1.count }
                        guard total > 0 else { throw EdgeTtsError.emptyAudio }
                        transport.close()
                        return chunks.reduce(Data()) { $0 + $1 }
                    case .data(let frame):
                        if let audio = parseEdgeBinaryFrame(frame) {
                            chunks.append(audio)
                        }
                    }
                }
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(EdgeTts.requestTimeout * 1_000_000_000))
                transport.close()
                throw EdgeTtsError.timeout
            }
            guard let first = try await group.next() else {
                throw EdgeTtsError.connectionRejected
            }
            group.cancelAll()
            return first
        }
    } catch {
        transport.close()
        if error is EdgeTtsError || error is CancellationError {
            throw error
        }
        // 浏览器 WS 拿不到握手 HTTP 状态码：403/断网统一表现为传输失败（edgeTts.ts:211-227）。
        throw chunks.isEmpty ? EdgeTtsError.connectionRejected : EdgeTtsError.partialAudio
    }
}

/// 合成一段文本，返回 mp3 数据与最终生效的时钟偏差（供调用方跨调用复用，
/// 替代 TS 的模块级 calibratedSkewSeconds）。缓存不在本函数（引擎层负责）。
/// 首次失败（多为时钟偏差导致的握手 403）时校准时钟重试一次；
/// 校准返回 nil 或与旧值相同则不重试，重试仍失败也上抛**首次**错误（更接近根因）。
public func synthesizeEdgeTts(
    text: String,
    opts: EdgeTtsOptions,
    skewSeconds: Int,
    transport: EdgeTtsTransport,
    calibrate: (_ previousSkew: Int) async -> Int? = { _ in await calibrateEdgeClockSkew() }
) async throws -> (data: Data, skewSeconds: Int) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw EdgeTtsError.emptyText }
    do {
        let data = try await synthesizeEdgeTtsOnce(
            text: trimmed, opts: opts, skewSeconds: skewSeconds, transport: transport
        )
        return (data, skewSeconds)
    } catch let firstError {
        let newSkew = await calibrate(skewSeconds)
        guard let newSkew, newSkew != skewSeconds else {
            throw firstError
        }
        do {
            let data = try await synthesizeEdgeTtsOnce(
                text: trimmed, opts: opts, skewSeconds: newSkew, transport: transport
            )
            return (data, newSkew)
        } catch {
            throw firstError  // 重试仍失败：上抛首次错误
        }
    }
}
