import Foundation

// ---------------------------------------------------------------------------
// 沉浸云语音卡的视图状态机（对齐 Windows src/lib/voice/gatewayViewState.ts，
// 契约 §三.6 全部分支，纯函数可单测）。
//
// 输入是页面已有的原始信号（能力拉取中/失败码/me/config voice 段/402 事件），
// 输出是卡片渲染所需的单一视图状态：caps 相位 + 缺失能力 + 配额视图。
// 文案同样收敛在这里（状态行 / 能力卡徽标），UI 层不重复写分支。
//
// 配额两来源（§三.7）：me/config 下发 quota 字段 → 常驻余量条；
// 未下发 → 402/WSS quota_exceeded 事件式兜底（quotaEvents 只记 resource 裸值）。
// ---------------------------------------------------------------------------

/// 三项能力（与服务端资源一一对应；展示名见 capabilityLabels）。
typealias VoiceCapabilityKey = VoiceQuotaKey

/// 能力卡相位（§三.6：能力下发中/可用/部分可用/未开通/登录失效/网络失败/封禁）。
enum VoiceCapsPhase: Equatable {
    case loading
    case full
    case partial
    case noneCase
    /// 登录失效（token_invalid/token_reused/token_expired/unauthorized），单列不并入网络失败。
    case authRequired
    case error
    case banned
}

struct VoiceGatewayView: Equatable {
    var caps: VoiceCapsPhase
    /// 归约消费的错误码原样带回（authRequired 态的状态行按码查文案；诊断用）。
    var errorCode: String?
    /// partial 时缺失的能力（ttsVoices 空 / asrLanguages 空 / iseEnabled=false）。
    var missing: [VoiceCapabilityKey]
    /// 常驻配额（me/config quota 字段；未下发为 nil → 402 事件式兜底）。
    var quota: VoiceQuotaMap?
    /// 配额耗尽（常驻 remaining===0，或兜底收到过 quota_exceeded 事件）。
    var exhausted: Bool
    /// 已耗尽功能的展示名（「本月朗读额度已用完」插值与明细行用）。
    var exhaustedLabels: [String]
}

struct VoiceGatewayInput {
    /// 能力拉取进行中（含登录后的首次下发）。
    var loading: Bool
    /// 能力拉取失败的错误码；网络类归 "network_error"，nil = 无失败。
    var errorCode: String?
    var caps: VoiceCapabilities?
    /// quota_exceeded 事件里的 resource 裸值（tts_chars / asr_seconds / ise_calls）。
    var quotaEvents: [String]
}

let allVoiceCapabilities: [VoiceCapabilityKey] = [.tts, .asr, .ise]

/// 能力名（全名：状态行「沉浸云云端朗读暂未开放」与部分可用 hint 用）。
let capabilityLabels: [VoiceCapabilityKey: String] = [
    .tts: "云端朗读",
    .asr: "口语识别",
    .ise: "跟读打分",
]

/// 状态行 / 部分可用文案里的短名。
let capabilityShortLabels: [VoiceCapabilityKey: String] = [
    .tts: "朗读",
    .asr: "识别",
    .ise: "跟读打分",
]

/// 402/WSS 事件的 resource 裸值 → 展示名（含 tts_chars→「朗读」这类短名别名；
/// 对齐 Windows gatewayViewState.ts:99-101 直接 quotaFeatureLabel(resource)——
/// 裸值本身带下划线后缀，必须走 quotaFeatureLabel 归一，不能用 capabilityLabels 查表）。
private func quotaEventLabel(_ resource: String) -> String {
    quotaFeatureLabel(resource)
}

private func emptyQuotaView() -> (quota: VoiceQuotaMap?, exhausted: Bool, exhaustedLabels: [String]) {
    (nil, false, [])
}

/// 状态机归约：优先级 封禁 > 登录失效 > 未开通（voice_not_configured）> 网络失败 >
/// 下发中 > 未开通（能力全缺）> 部分/全可用；配额耗尽不改动 caps 相位（能力仍可用），
/// 只叠在视图上（原型状态 7 同口径），且已缺失能力的耗尽不再叠标签。
func reduceVoiceGatewayView(_ input: VoiceGatewayInput) -> VoiceGatewayView {
    let errorCode = input.errorCode
    if errorCode == "banned" {
        return VoiceGatewayView(caps: .banned, errorCode: errorCode, missing: [], quota: nil, exhausted: false, exhaustedLabels: [])
    }
    // 登录失效类错误码单列 authRequired（Windows 300247a：不再与网络失败并成一句「查网络」）。
    if ["token_invalid", "unauthorized", "token_reused", "token_expired"].contains(errorCode ?? "") {
        return VoiceGatewayView(caps: .authRequired, errorCode: errorCode, missing: [], quota: nil, exhausted: false, exhaustedLabels: [])
    }
    if errorCode == "voice_not_configured" {
        // 错误路径的未开通：三项全缺（与 caps.available=false 同态）。
        return VoiceGatewayView(caps: .noneCase, errorCode: errorCode, missing: allVoiceCapabilities, quota: nil, exhausted: false, exhaustedLabels: [])
    }
    if errorCode != nil {
        return VoiceGatewayView(caps: .error, errorCode: errorCode, missing: [], quota: nil, exhausted: false, exhaustedLabels: [])
    }
    if input.loading || input.caps == nil {
        return VoiceGatewayView(caps: .loading, errorCode: errorCode, missing: [], quota: nil, exhausted: false, exhaustedLabels: [])
    }
    guard let caps = input.caps else {
        fatalError("上面已判空，不可达")
    }
    if !caps.available {
        // 已登录但 me/config 无 voice 段：服务端尚未为本账号开通语音（voice_not_configured）。
        return VoiceGatewayView(caps: .noneCase, errorCode: errorCode, missing: allVoiceCapabilities, quota: nil, exhausted: false, exhaustedLabels: [])
    }
    let missing = allVoiceCapabilities.filter { key in
        switch key {
        case .tts: return caps.ttsVoices.isEmpty
        case .asr: return asrLanguagesFor(caps).isEmpty
        case .ise: return !caps.iseEnabled
        }
    }
    // 三项全缺等同未开放（「none」态，不给部分可用的误导）。
    if missing.count == allVoiceCapabilities.count {
        return VoiceGatewayView(caps: .noneCase, errorCode: errorCode, missing: missing, quota: nil, exhausted: false, exhaustedLabels: [])
    }

    // 常驻来源：下发 quota 里 remaining===0 的资源（已缺失的能力跳过——未开放谈不上
    // 「用完」）；兜底来源：402/WSS 事件。按插入序去重（对齐 JS Set 语义）；
    // 事件 resource 可归一成能力键的用能力全名，未知资源走 quotaFeatureLabel 兜底。
    var exhaustedLabels: [String] = []
    func addLabel(_ label: String) {
        if !exhaustedLabels.contains(label) { exhaustedLabels.append(label) }
    }
    if let quota = caps.quota {
        for key in allVoiceCapabilities {
            if let entry = quota[key], entry.remaining == 0, !missing.contains(key) {
                addLabel(capabilityLabels[key]!)
            }
        }
    }
    for resource in input.quotaEvents {
        if let key = quotaResourceKey(resource) {
            if !missing.contains(key) { addLabel(capabilityLabels[key]!) }
        } else {
            addLabel(quotaEventLabel(resource))
        }
    }
    return VoiceGatewayView(
        caps: missing.isEmpty ? .full : .partial,
        errorCode: errorCode,
        missing: missing,
        quota: caps.quota,
        exhausted: !exhaustedLabels.isEmpty,
        exhaustedLabels: exhaustedLabels
    )
}

/// 沉浸云大卡状态行（§三.6 文案表；tone 对应状态点的 ok/off/err）。
/// Windows 300247a 起不再带「已登录 \(email)」前缀——登录态由账号分区呈现，
/// 状态行只讲语音本身。email 参数保留对齐 Windows 签名（其 opts.email 同样已不用）。
func voiceGatewayStatusLine(
    _ view: VoiceGatewayView,
    loggedIn: Bool,
    email: String
) -> (tone: VoiceStatusTone, text: String) {
    if !loggedIn {
        return (.off, "未登录，登录后检查语音是否开放")
    }
    switch view.caps {
    case .banned:
        return (.err, "账号已被封禁")
    case .error:
        return (.err, "连接沉浸云失败，请检查网络")
    case .authRequired:
        // 按错误码查既有映射（token_expired 的静默文案为空 → 兜底句）。
        let info = voiceErrorMessage(VoiceError(code: view.errorCode ?? "token_invalid"))
        return (.err, info.text.isEmpty ? "登录已失效，请重新登录" : info.text)
    case .noneCase:
        return (.off, "三项云语音功能暂未开放")
    case .partial:
        let present = allVoiceCapabilities.filter { !view.missing.contains($0) }
        let presentText = present.map { capabilityShortLabels[$0]! }.joined(separator: "、")
        let missingText = view.missing.map { capabilityShortLabels[$0]! }.joined(separator: "、")
        return (.off, "\(presentText)已开放，\(missingText)未开放")
    case .loading:
        return (.off, "正在检查语音服务…")
    case .full:
        if view.exhausted {
            return (.off, "本月\(view.exhaustedLabels.joined(separator: "、"))额度已用完")
        }
        return (.ok, "朗读、识别、跟读打分均已开放")
    }
}

enum VoiceStatusTone {
    case ok
    case off
    case err
}

/// 本月额度明细（单位与 QuotaService 同源：tts=字符、asr=整秒、ise=次）。
func quotaLine(_ quota: VoiceQuotaMap) -> String {
    let units: [VoiceCapabilityKey: (name: String, unit: String)] = [
        .tts: ("朗读", "字"),
        .asr: ("识别", "秒"),
        .ise: ("跟读", "次"),
    ]
    func part(_ key: VoiceCapabilityKey) -> String {
        let (name, unit) = units[key]!
        if let entry = quota[key], let value = entry.remaining {
            return "\(name) \(formatQuotaNumber(value)) \(unit)"
        }
        return "\(name) — \(unit)"
    }
    return "\(part(.tts)) · \(part(.asr)) · \(part(.ise))"
}

/// 余量展示（Int 值不显示小数点，与 JS number 字面一致）。
private func formatQuotaNumber(_ value: Double) -> String {
    value.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(value)) : String(value)
}

/// 重置时间（UTC 自然月末；ISO → 「11 月 1 日重置」，解析失败返回 nil）。
/// 月日取本地时区（对齐 JS Date.getMonth/getDate）。解析口径贴近 JS `new Date(iso)`：
/// 带/不带毫秒的 ISO 时刻、纯日期（按 UTC 零点）均可。
func quotaResetText(_ resetsAt: String?) -> String? {
    guard let resetsAt, !resetsAt.isEmpty else { return nil }
    guard let date = parseVoiceISODate(resetsAt) else { return nil }
    let calendar = Calendar.current
    let components = calendar.dateComponents([.month, .day], from: date)
    guard let month = components.month, let day = components.day else { return nil }
    return "\(month) 月 \(day) 日重置"
}

/// ISO 时刻解析（带毫秒 → 不带毫秒 → 纯日期 UTC）。
func parseVoiceISODate(_ raw: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: raw) { return date }
    if let date = ISO8601DateFormatter().date(from: raw) { return date }
    let dateOnly = ISO8601DateFormatter()
    dateOnly.formatOptions = [.withFullDate]
    dateOnly.timeZone = TimeZone(identifier: "UTC")
    return dateOnly.date(from: raw)
}
