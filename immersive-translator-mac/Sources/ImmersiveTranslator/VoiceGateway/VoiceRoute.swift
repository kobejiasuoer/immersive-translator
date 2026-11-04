import Foundation

// ---------------------------------------------------------------------------
// 消费点路由守卫（对齐 Windows src/lib/voice/voiceRoute.ts，契约 §三.5 硬性
// 契约，防存量回归）。
//
// voiceProvider=gateway 仅在「已登录 && 能力可用 && 未配额耗尽」时对消费点生效；
// 不满足时给出回落原因与引导文案：TTS 静默回落 edge/本地引擎（EDGE_FALLBACK_NOTICE），
// ASR/ISE 入口按态禁用并给「登录沉浸云即用」引导。
// provider=xfyun（存量讯飞用户）不经守卫、直接走原直连路径（契约 §四：零改动保留）。
//
// 纯归约（reduceVoiceRoute）与异步取数（resolveVoiceRoute）分开：归约穷举单测，
// 取数侧 loggedIn 每次现查（内存态，毫秒级）；caps 带 30s TTL 缓存
// （me/config 是 HTTPS 往返，不能每句现拉；服务端配额字段未下发时的实时性
// 由调用时的 402 错误文案兜底，不在这里追）。
// ---------------------------------------------------------------------------

/// 消费能力（tts/asr/ise，与服务端配额资源一一对应；与能力/配额键同一枚举）。
typealias VoiceRouteAbility = VoiceQuotaKey

/// 不走 gateway 的回落原因（provider=xfyun 是显式选择，reason 保持 nil）。
enum VoiceRouteFallback: Equatable {
    case notLoggedIn
    /// 能力拉取失败且错误码是 banned（封禁，不暗示重试）。
    case banned
    /// 能力未拉到（网络/取数失败）。
    case capsUnavailable
    /// 能力拉到了但服务端未为本账号开通语音（voice 段缺失）。
    case voiceNotConfigured
    case quotaExhausted
    case capabilityMissing
    case iseTurnedOff
}

/// 消费点引擎去向：gateway=网关客户端；xfyun=存量讯飞直连；off=入口禁用/回落。
enum VoiceRouteEngine: Equatable {
    case gateway
    case xfyun
    case off
}

struct VoiceRouteDecision: Equatable {
    var engine: VoiceRouteEngine
    var reason: VoiceRouteFallback?
    /// 用户可见引导（简体中文）；off 且 hint=nil 时调用方静默处理。
    var hint: String?
    /// 配额耗尽时携带常驻 resetsAt，供朗读回落提示复用统一错误映射。
    var quota: VoiceQuotaRemaining?

    init(engine: VoiceRouteEngine, reason: VoiceRouteFallback? = nil, hint: String? = nil, quota: VoiceQuotaRemaining? = nil) {
        self.engine = engine
        self.reason = reason
        self.hint = hint
        self.quota = quota
    }

    static let gateway = VoiceRouteDecision(engine: .gateway)
    static let xfyun = VoiceRouteDecision(engine: .xfyun)
}

/// 守卫归约的输入信号（全部可从 UI 态/能力下发获得；纯函数可单测）。
struct VoiceRouteSignals {
    var loggedIn: Bool
    /// nil = 未拉到能力（网络失败/未登录拉取被拒等）。
    var caps: VoiceCapabilities?
    /// 能力拉取失败的错误码（AuthError.code，banned 单列；其余归网络失败）。
    /// nil = 拉取成功。与 caps 不同时成立：失败侧 caps 恒 nil。
    var capsError: String?
    /// 402/WSS quota_exceeded 事件的 resource 裸值（tts_chars 等；事件式兜底来源）。
    var quotaEvents: [String]
    var ability: VoiceRouteAbility
    /// asr 要求的具体语种；不给则只看 asrLanguages 是否为空。
    var asrLang: VoiceAsrLang?
    /// 本地跟读打分开关（voiceGatewayIseEnabled）已关闭；仅 ability=ise 时消费。
    var iseLocalOff: Bool

    init(
        loggedIn: Bool,
        caps: VoiceCapabilities?,
        capsError: String? = nil,
        quotaEvents: [String] = [],
        ability: VoiceRouteAbility,
        asrLang: VoiceAsrLang? = nil,
        iseLocalOff: Bool = false
    ) {
        self.loggedIn = loggedIn
        self.caps = caps
        self.capsError = capsError
        self.quotaEvents = quotaEvents
        self.ability = ability
        self.asrLang = asrLang
        self.iseLocalOff = iseLocalOff
    }
}

/// TTS 守卫不通过时的回落标注（契约 §三.5：「已临时使用 Edge 朗读」）。
let edgeFallbackNotice = "已临时使用 Edge 朗读"

/// 配额耗尽（常驻 remaining===0，或 402 事件按 resource 别名归并命中）。
private func quotaExhausted(caps: VoiceCapabilities, quotaEvents: [String], ability: VoiceRouteAbility) -> Bool {
    if let entry = caps.quota?[ability], entry.remaining == 0 {
        return true
    }
    return quotaEvents.contains { quotaResourceKey($0) == ability }
}

/// 守卫归约：优先级 未登录 > 封禁 > 能力不可用（网络） > 未开通 > 配额耗尽 > 本地跟读
/// 开关 > 能力缺失 > 放行。封禁/未开通与网络失败分开给文案（契约 §二：banned→
/// 「账号已被封禁」不暗示重试；voice_not_configured→「语音功能暂未开通」），
/// 措辞取自 gatewayViewState 状态行 / voiceErrors 映射表的既有文案，不另写第三份。
/// 能力缺失语义与语音页部分可用同源（ttsVoices 空 / asrLanguages 空或不含所需
/// 语种 / iseEnabled=false），文案直接复用能力名，两处不写两份。
func reduceVoiceRoute(_ signals: VoiceRouteSignals) -> VoiceRouteDecision {
    let s = signals
    if !s.loggedIn {
        return VoiceRouteDecision(engine: .off, reason: .notLoggedIn, hint: "登录沉浸云即用")
    }
    if s.capsError == "banned" {
        return VoiceRouteDecision(engine: .off, reason: .banned, hint: "账号已被封禁")
    }
    if s.caps == nil {
        return VoiceRouteDecision(
            engine: .off,
            reason: .capsUnavailable,
            hint: "暂无法连接沉浸云语音，请检查网络后重试"
        )
    }
    let caps = s.caps!
    if !caps.available {
        // 已登录但 me/config 无 voice 段：服务端尚未为本账号开通语音
        // （voice_not_configured），不给「重试/查网络」类误导（none 态同口径）。
        return VoiceRouteDecision(engine: .off, reason: .voiceNotConfigured, hint: "语音功能暂未开通")
    }
    if quotaExhausted(caps: caps, quotaEvents: s.quotaEvents, ability: s.ability) {
        return VoiceRouteDecision(
            engine: .off,
            reason: .quotaExhausted,
            hint: "本月\(capabilityShortLabels[s.ability]!)额度已用完，可在「设置 → 账号」用兑换码补足",
            quota: caps.quota?[s.ability] ?? nil
        )
    }
    if s.ability == .ise, s.iseLocalOff {
        return VoiceRouteDecision(
            engine: .off,
            reason: .iseTurnedOff,
            hint: "跟读打分已在设置里关闭，可在「设置 → 语音」重新开启"
        )
    }
    let missing =
        (s.ability == .tts && caps.ttsVoices.isEmpty)
        || (s.ability == .asr
            && (caps.asrLanguages.isEmpty
                || (s.asrLang != nil && !caps.asrLanguages.contains(s.asrLang!.rawValue))))
        || (s.ability == .ise && !caps.iseEnabled)
    if missing {
        return VoiceRouteDecision(
            engine: .off,
            reason: .capabilityMissing,
            hint: "沉浸云\(capabilityLabels[s.ability]!)暂未开放"
        )
    }
    return .gateway
}

// ---------------------------------------------------------------------------
// 异步取数
// ---------------------------------------------------------------------------

/// 登录态现查通道（生产由 AppDelegate 接线 serverAuth.status；未接线按未登录
/// 保守处理，对齐 Windows authGetStatus 每次现查）。
enum VoiceLoginProbe {
    static var provider: () async -> Bool = { false }
}

struct VoiceRouteDeps {
    /// 生效服务商读取（缺省 = 语音偏好存储 + 迁移推断；异常按 xfyun 兜底）。
    var resolveProvider: () async throws -> VoiceProvider = {
        resolveInitialVoiceProvider(stored: VoicePrefsStore.loadProvider())
    }
    var isLoggedIn: () async -> Bool = { await VoiceLoginProbe.provider() }
    var fetchCaps: () async throws -> VoiceCapabilities = { try await getVoiceCapabilities() }
    var iseEnabled: () -> Bool = { VoicePrefsStore.loadIseEnabled() }
}

/// caps 带 TTL 缓存（30s）；失败不缓存且错误码原样带回（banned 由归约单列成
/// 封禁文案，不再与网络失败并成一句「查网络」）。
enum VoiceRoute {
    static let capsTTLSeconds: TimeInterval = 30

    /// 缓存与时钟跨消费点（阅读室 / 录音直译 / 语音页）并发读写：锁保护。
    private static let lock = NSLock()
    private static var capsCache: (at: Date, caps: VoiceCapabilities)?
    private static var clock: () -> Date = { Date() }

    static func setClockForTests(_ clock: @escaping () -> Date) {
        lock.lock()
        defer { lock.unlock() }
        self.clock = clock
    }

    /// 单测隔离/登出后强制重拉。
    static func resetForTests() {
        lock.lock()
        defer { lock.unlock() }
        capsCache = nil
        clock = { Date() }
    }

    private static func cachedCaps() -> VoiceCapabilities? {
        lock.lock()
        defer { lock.unlock() }
        guard let cache = capsCache, clock().timeIntervalSince(cache.at) < capsTTLSeconds else { return nil }
        return cache.caps
    }

    private static func storeCaps(_ caps: VoiceCapabilities) {
        lock.lock()
        defer { lock.unlock() }
        capsCache = (clock(), caps)
    }

    static func fetchCaps(deps: VoiceRouteDeps = VoiceRouteDeps()) async -> (caps: VoiceCapabilities?, errorCode: String?) {
        if let cached = cachedCaps() {
            return (cached, nil)
        }
        do {
            let caps = try await deps.fetchCaps()
            storeCaps(caps)
            return (caps, nil)
        } catch let error as VoiceError {
            return (nil, error.code.isEmpty ? "network_error" : error.code)
        } catch let error as AuthError {
            return (nil, error.code.isEmpty ? "network_error" : error.code)
        } catch {
            return (nil, "network_error")
        }
    }

    /// 消费点入口：生效服务商（已存值优先，否则按讯飞凭据迁移推断）为 xfyun 时
    /// 不经守卫直接放行存量路径；为 gateway 时现查登录态与能力归约。
    /// 不抛错：登录态/能力取数失败都折算成保守的 off（带引导），不会挡住 xfyun 用户。
    static func resolve(
        _ ability: VoiceRouteAbility,
        asrLang: VoiceAsrLang? = nil,
        deps: VoiceRouteDeps = VoiceRouteDeps()
    ) async -> VoiceRouteDecision {
        // 偏好读取/推断整体兜底：拿不到生效服务商时按存量讯飞路径处理（零回归
        // 优先，与「守卫只负责拦 gateway、不负责拦存量」的边界一致）。
        let provider: VoiceProvider
        do {
            provider = try await deps.resolveProvider()
        } catch {
            provider = .xfyun
        }
        guard provider == .gateway else {
            return .xfyun
        }
        let loggedIn = await deps.isLoggedIn()
        // 未登录时归约必然落到 notLoggedIn，不必再拉能力（省一次 me/config 往返）。
        let fetched = loggedIn ? await fetchCaps(deps: deps) : (caps: nil as VoiceCapabilities?, errorCode: nil as String?)
        return reduceVoiceRoute(
            VoiceRouteSignals(
                loggedIn: loggedIn,
                caps: fetched.caps,
                capsError: fetched.errorCode,
                // 402 事件由调用点在错误文案里兜底（§二映射），守卫只看常驻配额。
                quotaEvents: [],
                ability: ability,
                asrLang: asrLang,
                iseLocalOff: ability == .ise && !deps.iseEnabled()
            )
        )
    }
}
