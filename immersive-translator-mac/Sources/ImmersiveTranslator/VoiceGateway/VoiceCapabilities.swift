import Foundation

// ---------------------------------------------------------------------------
// 能力下发（对齐 Windows src/lib/voice/voiceCapabilities.ts，契约 §一/§四）：
// GET /v1/me/config 的 voice 段。
//
// 复用既有鉴权通道（AuthTokenManager.withAuth——惰性刷新/401 单飞刷新重放
// 全在传输层，不自建第二套）。配额余量字段：解析按
// 「voice.quota.{tts|tts_chars|asr|asr_seconds|ise|ise_calls}」容错匹配；
// 字段未上线时 quota=nil，UI 走 402 事件式兜底，字段上线自动点亮常驻余量条。
// 鉴权类失败（AuthError）原样抛出，文案走既有 authErrorText。
// ---------------------------------------------------------------------------

struct VoiceTtsVoice: Equatable {
    let id: String
    let label: String
}

struct VoiceQuotaRemaining: Equatable {
    var remaining: Double?
    var allowance: Double?
    /// ISO 时刻（UTC 自然月末）；服务端字段未下发时为 nil。
    var resetsAt: String?

    init(remaining: Double? = nil, allowance: Double? = nil, resetsAt: String? = nil) {
        self.remaining = remaining
        self.allowance = allowance
        self.resetsAt = resetsAt
    }
}

enum VoiceQuotaKey: String, CaseIterable, Equatable {
    case tts
    case asr
    case ise
}

typealias VoiceQuotaMap = [VoiceQuotaKey: VoiceQuotaRemaining]

struct VoiceCapabilities: Equatable {
    /// voice 段是否存在且形状合法（官方云未开通/旧服务端为 false）。
    let available: Bool
    /// 音色表（默认音色排第一，服务端已排序，原样透传）。
    let ttsVoices: [VoiceTtsVoice]
    /// ASR 可用语种（消费点 lang 只能取其中）。
    let asrLanguages: [String]
    /// 新服务端按调用方式分别下发；nil = 旧服务端未下发，兼容回退 asrLanguages。
    let asrStreamingLanguages: [String]?
    let asrBatchLanguages: [String]?
    let iseEnabled: Bool
    /// 配额余量（服务端字段上线前为 nil）。
    let quota: VoiceQuotaMap?

    init(
        available: Bool,
        ttsVoices: [VoiceTtsVoice],
        asrLanguages: [String],
        asrStreamingLanguages: [String]? = nil,
        asrBatchLanguages: [String]? = nil,
        iseEnabled: Bool,
        quota: VoiceQuotaMap?
    ) {
        self.available = available
        self.ttsVoices = ttsVoices
        self.asrLanguages = asrLanguages
        self.asrStreamingLanguages = asrStreamingLanguages
        self.asrBatchLanguages = asrBatchLanguages
        self.iseEnabled = iseEnabled
        self.quota = quota
    }

    static let empty = VoiceCapabilities(
        available: false, ttsVoices: [], asrLanguages: [], iseEnabled: false, quota: nil
    )
}

/// ASR 消费点的调用方式（批量转写 / 流式识别；能力按方式分语种下发）。
enum VoiceAsrMode: Equatable {
    case batch
    case stream
}

/// 按调用方式取 ASR 可用语种：分语种字段缺省时兼容回退 asrLanguages；
/// **明确的空数组不回退**（该方式确实无可用语种，对齐 Windows asrLanguagesFor）。
func asrLanguagesFor(_ caps: VoiceCapabilities, mode: VoiceAsrMode = .batch) -> [String] {
    switch mode {
    case .batch: return caps.asrBatchLanguages ?? caps.asrLanguages
    case .stream: return caps.asrStreamingLanguages ?? caps.asrLanguages
    }
}

/// 402/WSS 事件的 resource 裸值（tts_chars 等）归一成配额键；未知资源返回 nil。
func quotaResourceKey(_ resource: String) -> VoiceQuotaKey? {
    let aliases: [String: VoiceQuotaKey] = [
        "tts": .tts, "tts_chars": .tts,
        "asr": .asr, "asr_seconds": .asr,
        "ise": .ise, "ise_calls": .ise,
    ]
    return aliases[resource]
}

private func quotaKeyAlias(_ key: String) -> VoiceQuotaKey? {
    quotaResourceKey(key)
}

/// 对齐 Windows looseRecord（`typeof v === "object" && v !== null`）：对象原样；
/// 数组在 JS 里同样是 object——按下标字符串键（"0"/"1"/…）视作记录，具名字段一律
/// 取不到；null/数值/字符串/布尔为 nil。只影响畸形数据（如 `voice: []` 判
/// available=true 全空、`quota.tts: []` 判该项全 null），契约形状下与字典解析等价。
private func looseRecord(_ value: Any?) -> [String: Any]? {
    if let record = value as? [String: Any] { return record }
    if let list = value as? [Any] {
        var record: [String: Any] = [:]
        for (index, element) in list.enumerated() {
            record[String(index)] = element
        }
        return record
    }
    return nil
}

private func parseVoices(_ raw: Any?) -> [VoiceTtsVoice] {
    guard let list = raw as? [Any] else { return [] }
    var out: [VoiceTtsVoice] = []
    for item in list {
        guard let rec = looseRecord(item),
              let id = rec["id"] as? String, !id.isEmpty else { continue }
        let labelRaw = rec["label"] as? String
        out.append(VoiceTtsVoice(id: id, label: (labelRaw?.isEmpty == false) ? labelRaw! : id))
    }
    return out
}

private func parseLanguages(_ raw: Any?) -> [String] {
    guard let list = raw as? [Any] else { return [] }
    return list.compactMap { $0 as? String }.filter { !$0.isEmpty }
}

private func parseQuota(_ raw: Any?) -> VoiceQuotaMap? {
    guard let rec = looseRecord(raw) else { return nil }
    var quota: VoiceQuotaMap = [:]
    for (key, value) in rec {
        guard let normalized = quotaKeyAlias(key) else { continue }
        guard let entry = looseRecord(value) else { continue }
        let resetsAtRaw = entry["resetsAt"] as? String
        quota[normalized] = VoiceQuotaRemaining(
            remaining: voiceJsonNumber(entry["remaining"]),
            allowance: voiceJsonNumber(entry["allowance"]),
            resetsAt: (resetsAtRaw?.isEmpty == false) ? resetsAtRaw : nil
        )
    }
    return quota.isEmpty ? nil : quota
}

/// me/config 原始 JSON → 能力形状（纯函数，容错旧服务端/缺失字段）。
func parseVoiceCapabilities(_ raw: Any?) -> VoiceCapabilities {
    guard let root = looseRecord(raw),
          let voice = looseRecord(root["voice"]) else {
        return .empty
    }
    return VoiceCapabilities(
        available: true,
        ttsVoices: parseVoices(voice["ttsVoices"]),
        asrLanguages: parseLanguages(voice["asrLanguages"]),
        // 分语种字段：新服务端按调用方式分别下发；数组才收，缺失/异形保持 nil 回退。
        asrStreamingLanguages: voice["asrStreamingLanguages"] is [Any]
            ? parseLanguages(voice["asrStreamingLanguages"]) : nil,
        asrBatchLanguages: voice["asrBatchLanguages"] is [Any]
            ? parseLanguages(voice["asrBatchLanguages"]) : nil,
        // 对齐 JS `voice.iseEnabled === true`：只认真布尔（数值 1 / "yes" 都不算）。
        iseEnabled: voiceJsonIsTrue(voice["iseEnabled"]),
        quota: parseQuota(voice["quota"])
    )
}

/// 拉取能力（冷启动由 UI 拉一次并缓存展示；本模块不做缓存）。
/// 生产通道经 VoiceGatewayRuntime.serverConfig（ServerAuthClient.fetchServerConfig，
/// 复用既有鉴权管线），未接线时抛编程错误。
func getVoiceCapabilities() async throws -> VoiceCapabilities {
    guard let fetch = VoiceGatewayRuntime.shared.serverConfig else {
        throw VoiceError(code: "voice_request_invalid", message: "语音能力通道未接线（需在应用启动时 installVoiceGatewayRuntime）")
    }
    return parseVoiceCapabilities(try await fetch())
}
