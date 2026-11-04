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

/// 能力卡相位（§三.6：能力下发中/可用/部分可用/未开通/网络失败/封禁）。
enum VoiceCapsPhase: Equatable {
    case loading
    case full
    case partial
    case noneCase
    case error
    case banned
}

struct VoiceGatewayView: Equatable {
    var caps: VoiceCapsPhase
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

/// 状态机归约：优先级 封禁 > 网络失败 > 下发中 > 未开通 > 部分/全可用；
/// 配额耗尽不改动 caps 相位（能力仍可用），只叠在视图上（原型状态 7 同口径）。
func reduceVoiceGatewayView(_ input: VoiceGatewayInput) -> VoiceGatewayView {
    if input.errorCode == "banned" {
        return VoiceGatewayView(caps: .banned, missing: [], quota: nil, exhausted: false, exhaustedLabels: [])
    }
    if input.errorCode != nil {
        return VoiceGatewayView(caps: .error, missing: [], quota: nil, exhausted: false, exhaustedLabels: [])
    }
    if input.loading || input.caps == nil {
        return VoiceGatewayView(caps: .loading, missing: [], quota: nil, exhausted: false, exhaustedLabels: [])
    }
    guard let caps = input.caps else {
        fatalError("上面已判空，不可达")
    }
    if !caps.available {
        // 已登录但 me/config 无 voice 段：服务端尚未为本账号开通语音（voice_not_configured）。
        return VoiceGatewayView(caps: .noneCase, missing: [], quota: nil, exhausted: false, exhaustedLabels: [])
    }
    let missing = allVoiceCapabilities.filter { key in
        switch key {
        case .tts: return caps.ttsVoices.isEmpty
        case .asr: return caps.asrLanguages.isEmpty
        case .ise: return !caps.iseEnabled
        }
    }

    // 常驻来源：下发 quota 里 remaining===0 的资源；兜底来源：402/WSS 事件。
    // 按插入序去重（对齐 JS Set 语义：常驻在前按 tts/asr/ise 序，事件按到达序）；
    // 事件标签取 quotaFeatureLabel（tts_chars→「朗读」），与常驻全名不合并。
    var exhaustedLabels: [String] = []
    func addLabel(_ label: String) {
        if !exhaustedLabels.contains(label) { exhaustedLabels.append(label) }
    }
    if let quota = caps.quota {
        for key in allVoiceCapabilities {
            if let entry = quota[key], entry.remaining == 0 {
                addLabel(capabilityLabels[key]!)
            }
        }
    }
    for resource in input.quotaEvents {
        addLabel(quotaEventLabel(resource))
    }
    return VoiceGatewayView(
        caps: missing.isEmpty ? .full : .partial,
        missing: missing,
        quota: caps.quota,
        exhausted: !exhaustedLabels.isEmpty,
        exhaustedLabels: exhaustedLabels
    )
}

/// 沉浸云大卡状态行（§三.6 文案表；tone 对应状态点的 ok/off/err）。
func voiceGatewayStatusLine(
    _ view: VoiceGatewayView,
    loggedIn: Bool,
    email: String
) -> (tone: VoiceStatusTone, text: String) {
    if !loggedIn {
        return (.off, "未登录——选中后到右侧登录即可使用")
    }
    switch view.caps {
    case .banned:
        return (.err, "账号已被封禁")
    case .error:
        return (.err, "连接沉浸云失败，请检查网络")
    case .noneCase:
        return (.off, "语音功能暂未开通——账号正常，服务端尚未为本账号开通语音")
    case .partial:
        let present = allVoiceCapabilities.filter { !view.missing.contains($0) }
        let presentText = present.map { capabilityShortLabels[$0]! }.joined(separator: "、")
        let missingText = view.missing.map { capabilityShortLabels[$0]! }.joined(separator: "、")
        return (.off, "已登录 \(email) · \(presentText)可用，\(missingText)未开放")
    case .loading:
        return (.ok, "已登录 \(email) · 正在获取语音能力…")
    case .full:
        if view.exhausted {
            return (.off, "已登录 \(email) · 本月额度已用完")
        }
        return (.ok, "已登录 \(email) · 朗读、识别、跟读打分全部可用")
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
