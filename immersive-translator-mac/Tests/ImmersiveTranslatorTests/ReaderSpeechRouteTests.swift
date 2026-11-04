import XCTest
import ReaderCore
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 阅读室朗读路由单测（对齐 Windows readerSpeechRoute.test.ts 行为向量）：
// ReaderCore 纯路由（edge/local 直达；旧 xfyun 有凭据走讯飞无凭据回落本地，
// 不经新守卫；cloud+gateway 守卫过→网关；cloud+xfyun→讯飞/本地；cloud 守卫不
// 过→静默 Edge+回落决策）+ 应用层取数与回落文案（非配额回落文案无动作位、
// 配额带重置+redeem）。
// ---------------------------------------------------------------------------

final class ReaderSpeechRouteTests: XCTestCase {
    private var savedProvider: String?

    override func setUp() {
        super.setUp()
        savedProvider = UserDefaults.standard.string(forKey: VoicePrefsStore.providerKey)
        VoiceRoute.resetForTests()
    }

    override func tearDown() {
        if let savedProvider {
            UserDefaults.standard.set(savedProvider, forKey: VoicePrefsStore.providerKey)
        } else {
            UserDefaults.standard.removeObject(forKey: VoicePrefsStore.providerKey)
        }
        VoiceLoginProbe.provider = { false }
        VoiceRoute.resetForTests()
        VoiceGatewayRuntime.shared.resetForTests()
        super.tearDown()
    }

    private func installCaps(_ caps: VoiceCapabilities?) -> () async throws -> Any {
        {
            if let caps {
                var voice: [String: Any] = [
                    "ttsVoices": caps.ttsVoices.map { ["id": $0.id, "label": $0.label] },
                    "asrLanguages": caps.asrLanguages,
                    "iseEnabled": caps.iseEnabled,
                ]
                if let quota = caps.quota {
                    var quotaJSON: [String: Any] = [:]
                    for (key, entry) in quota {
                        var item: [String: Any] = [:]
                        if let remaining = entry.remaining { item["remaining"] = remaining }
                        if let allowance = entry.allowance { item["allowance"] = allowance }
                        if let resetsAt = entry.resetsAt { item["resetsAt"] = resetsAt }
                        quotaJSON[key.rawValue] = item
                    }
                    voice["quota"] = quotaJSON
                }
                return ["voice": voice]
            }
            return [String: Any]()
        }
    }

    private func fullCaps(quota: [String: Any] = [:]) -> VoiceCapabilities {
        parseVoiceCapabilities([
            "voice": [
                "ttsVoices": [["id": "v1", "label": "一"]],
                "asrLanguages": ["en_us", "zh_cn"],
                "iseEnabled": true,
                "quota": quota,
            ] as [String: Any],
        ])
    }

    /// 本地时区 ISO 串（quotaResetText 按本地月日）。
    private func localISO(month: Int, day: Int) -> String {
        var components = DateComponents()
        components.year = 2026
        components.month = month
        components.day = day
        components.hour = 12
        let date = Calendar.current.date(from: components)!
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = .current
        return formatter.string(from: date)
    }

    // MARK: ReaderCore 纯路由

    func testEdgeAndLocalGoDirect() {
        XCTAssertEqual(routeReaderSpeech(provider: .edge, xfyunReady: false, voiceRoute: .off(hint: "x", quotaResetsAt: nil, quotaRemaining: nil)).engine, .edge)
        XCTAssertEqual(routeReaderSpeech(provider: .local, xfyunReady: true, voiceRoute: .gateway).engine, .sapi)
    }

    func testLegacyXfyunDoesNotTouchNewGuard() {
        // 有凭据走讯飞；无凭据回落本地——两种结果都不带回落决策。
        let ready = routeReaderSpeech(provider: .xfyun, xfyunReady: true, voiceRoute: .gateway)
        XCTAssertEqual(ready.engine, .xfyun)
        XCTAssertNil(ready.fallback)
        let notReady = routeReaderSpeech(provider: .xfyun, xfyunReady: false, voiceRoute: .off(hint: "h", quotaResetsAt: nil, quotaRemaining: nil))
        XCTAssertEqual(notReady.engine, .sapi)
        XCTAssertNil(notReady.fallback)
    }

    func testCloudFollowsVoiceRouteOutcome() {
        XCTAssertEqual(routeReaderSpeech(provider: .cloud, xfyunReady: true, voiceRoute: .gateway).engine, .gateway)
        XCTAssertEqual(routeReaderSpeech(provider: .cloud, xfyunReady: true, voiceRoute: .xfyun).engine, .xfyun)
        XCTAssertEqual(routeReaderSpeech(provider: .cloud, xfyunReady: false, voiceRoute: .xfyun).engine, .sapi)
        let off = routeReaderSpeech(provider: .cloud, xfyunReady: true, voiceRoute: .off(hint: "登录沉浸云即用", quotaResetsAt: nil, quotaRemaining: nil))
        XCTAssertEqual(off.engine, .edge, "守卫不过静默回落 Edge（不弹登录墙、不中断阅读）")
        XCTAssertEqual(off.fallback?.hint, "登录沉浸云即用")
    }

    // MARK: 应用层取数（resolveReaderSpeechRoute）

    func testCloudGatewayGuardPassesToGatewayEngine() async {
        VoicePrefsStore.saveProvider(.gateway)
        VoiceLoginProbe.provider = { true }
        VoiceGatewayRuntime.shared.install(http: nil, serverConfig: installCaps(fullCaps()))
        let routed = await resolveReaderSpeechRoute(provider: .cloud, xfyunReady: false)
        XCTAssertEqual(routed.engine, .gateway)
        XCTAssertNil(routed.fallback)
    }

    func testCloudXfyunProviderUsesLegacyPath() async {
        VoicePrefsStore.saveProvider(.xfyun)
        var loginProbes = 0
        VoiceLoginProbe.provider = {
            loginProbes += 1
            return true
        }
        let routed = await resolveReaderSpeechRoute(provider: .cloud, xfyunReady: true)
        XCTAssertEqual(routed.engine, .xfyun)
        XCTAssertNil(routed.fallback)
        XCTAssertEqual(loginProbes, 0, "xfyun 不查登录态（零回归）")
    }

    func testCloudGuardOffFallsBackToEdgeSilently() async throws {
        VoicePrefsStore.saveProvider(.gateway)
        VoiceLoginProbe.provider = { false } // 未登录 → off(notLoggedIn)
        let routed = await resolveReaderSpeechRoute(provider: .cloud, xfyunReady: true)
        XCTAssertEqual(routed.engine, .edge)
        let notice = try XCTUnwrap(routed.fallback)
        XCTAssertEqual(notice.message, "已临时使用 Edge 朗读：登录沉浸云即用")
        XCTAssertFalse(notice.redeemAction, "非配额回落无动作位")
    }

    func testCloudQuotaFallbackCarriesResetAndRedeemAction() async throws {
        VoicePrefsStore.saveProvider(.gateway)
        VoiceLoginProbe.provider = { true }
        let resetISO = localISO(month: 11, day: 1)
        let caps = fullCaps(quota: ["tts": ["remaining": 0, "allowance": 500, "resetsAt": resetISO]])
        VoiceGatewayRuntime.shared.install(http: nil, serverConfig: installCaps(caps))
        let routed = await resolveReaderSpeechRoute(provider: .cloud, xfyunReady: false)
        XCTAssertEqual(routed.engine, .edge)
        let notice = try XCTUnwrap(routed.fallback)
        XCTAssertEqual(
            notice.message,
            "已临时使用 Edge 朗读：本月朗读额度已用完，11 月 1 日重置"
        )
        XCTAssertTrue(notice.redeemAction, "配额回落带兑换动作位")
    }

    func testLegacyXfyunProviderSkipsProbesEntirely() async {
        var loginProbes = 0
        VoiceLoginProbe.provider = {
            loginProbes += 1
            return true
        }
        let routed = await resolveReaderSpeechRoute(provider: .xfyun, xfyunReady: false)
        XCTAssertEqual(routed.engine, .sapi)
        XCTAssertEqual(loginProbes, 0, "旧 xfyun 不经新守卫")
    }

    // MARK: 回落文案构造（readerEdgeFallbackNotice / quotaFallbackDecision）

    func testQuotaFallbackNoticeFromRuntimeError() {
        let resetISO = localISO(month: 12, day: 1)
        let error = VoiceError(
            code: "quota_exceeded",
            details: ["resource": "tts_chars", "remaining": 0.0, "resetsAt": resetISO]
        )
        let notice = readerEdgeFallbackNoticeForQuota(error)
        XCTAssertEqual(notice.message, "已临时使用 Edge 朗读：本月朗读额度已用完，12 月 1 日重置")
        XCTAssertTrue(notice.redeemAction)
        // 无 resetsAt：指向兑换入口。
        let noReset = readerEdgeFallbackNoticeForQuota(VoiceError(code: "quota_exceeded", details: ["resource": "tts_chars"]))
        XCTAssertEqual(noReset.message, "已临时使用 Edge 朗读：本月朗读额度已用完，可在「设置 → 账号」用兑换码补足")
        XCTAssertTrue(noReset.redeemAction)
    }

    // MARK: 旧 xfyun 迁移允许判定（对齐 Windows readerSettingsStore.test.ts）

    func testLegacyMigrationAllowedWithAnyXfyunCredential() {
        XCTAssertTrue(LegacyTtsMigration.resolveAllowed(hasAnyXfyunCredential: { true }, isLoggedIn: { false }))
    }

    func testLegacyMigrationAllowedWhenLoggedInWithoutCredentials() {
        XCTAssertTrue(LegacyTtsMigration.resolveAllowed(hasAnyXfyunCredential: { false }, isLoggedIn: { true }))
    }

    func testLegacyMigrationNotAllowedWithoutCredentialsAndLoggedOut() {
        XCTAssertFalse(LegacyTtsMigration.resolveAllowed(hasAnyXfyunCredential: { false }, isLoggedIn: { false }))
    }

    func testLegacyMigrationProbeFailuresCountAsAbsent() {
        struct Unavailable: Error {}
        XCTAssertFalse(LegacyTtsMigration.resolveAllowed(
            hasAnyXfyunCredential: { throw Unavailable() },
            isLoggedIn: { throw Unavailable() }
        ), "探测失败（Keychain/登录态不可用）按无该项处理，不迁移")
        XCTAssertTrue(LegacyTtsMigration.resolveAllowed(
            hasAnyXfyunCredential: { throw Unavailable() },
            isLoggedIn: { true }
        ))
    }

    @MainActor
    func testEffectiveSettingsMigrationKeepsXfyunWhenNotAllowed() {
        // 不允许迁移：旧 xfyun 保留（继续「缺凭据→本地回落」，不串 Edge）；允许：升格 cloud。
        defer { LegacyTtsMigration.resetForTests() }
        var settings = ReaderSettings.default
        settings.ttsProvider = .xfyun
        LegacyTtsMigration.allowed = false
        var kept = settings
        ReaderViewModel.migrateLegacyTtsProviderInPlace(settings: &kept)
        XCTAssertEqual(kept.ttsProvider, .xfyun)
        LegacyTtsMigration.allowed = true
        var migrated = settings
        ReaderViewModel.migrateLegacyTtsProviderInPlace(settings: &migrated)
        XCTAssertEqual(migrated.ttsProvider, .cloud)
        // edge/local/cloud 永不改写。
        for provider in [TtsProvider.edge, .local, .cloud] {
            var other = settings
            other.ttsProvider = provider
            ReaderViewModel.migrateLegacyTtsProviderInPlace(settings: &other)
            XCTAssertEqual(other.ttsProvider, provider)
        }
    }

    func testVoiceRouteOutcomeProjection() {
        XCTAssertEqual(voiceRouteOutcome(of: .gateway), .gateway)
        XCTAssertEqual(voiceRouteOutcome(of: .xfyun), .xfyun)
        let off = voiceRouteOutcome(of: VoiceRouteDecision(engine: .off, reason: .quotaExhausted, hint: "h", quota: VoiceQuotaRemaining(remaining: 0, allowance: 1, resetsAt: "z")))
        XCTAssertEqual(off, .off(hint: "h", quotaResetsAt: "z", quotaRemaining: 0))
    }

    // MARK: 网关朗读失败 toast（对齐 Windows ReaderApp.tsx handleSpeechError 两分支）

    func testGatewayFailureToastForGatewayErrors() {
        // quota_exceeded（首片后异步失败）：§二映射 + 重置时间 + 「兑换更多额度」动作位。
        let resetISO = localISO(month: 12, day: 1)
        let quota = readerSpeechFailureToast(VoiceError(
            code: "quota_exceeded",
            details: ["resource": "tts_chars", "resetsAt": resetISO]
        ))
        XCTAssertEqual(quota, ReaderSpeechFailureToast(message: "朗读失败，已停止：本月朗读额度已用完，12 月 1 日重置", redeemAction: true))
        // 其余网关错误：§二文案、无动作位、不透传服务端原文。
        XCTAssertEqual(
            readerSpeechFailureToast(VoiceError(code: "banned", message: "server says no")),
            ReaderSpeechFailureToast(message: "朗读失败，已停止：账号已被封禁", redeemAction: false)
        )
        XCTAssertEqual(
            readerSpeechFailureToast(VoiceError(code: "upstream_timeout")),
            ReaderSpeechFailureToast(message: "朗读失败，已停止：服务暂时不可用，正在重试", redeemAction: false)
        )
        // silent 类（空文案）落通用兜底。
        XCTAssertEqual(
            readerSpeechFailureToast(VoiceError(code: "token_expired")),
            ReaderSpeechFailureToast(message: "朗读失败，已停止：服务暂时不可用，请稍后再试", redeemAction: false)
        )
    }

    func testGatewayFailureToastForLocalPlaybackErrorsCarriesRetrySuffix() {
        // 云端合成返回空音频：Windows `new Error(...)` → toText「Error: …」→ 兜底类归因，
        // 后缀「（点播放键重试）」，无动作位（ReaderApp.tsx:474-480 逐字）。
        XCTAssertEqual(
            readerSpeechFailureToast(GatewayStreamPlaybackError.emptyAudio),
            ReaderSpeechFailureToast(message: "朗读失败，已停止：朗读失败：Error: 云端合成返回空音频（点播放键重试）", redeemAction: false)
        )
        // 音频设备类（AVAudioEngine NSError）→ 系统类归因 + 后缀。
        let device = NSError(domain: "com.apple.coreaudio.avfaudio", code: -10868)
        XCTAssertEqual(
            readerSpeechFailureToast(device),
            ReaderSpeechFailureToast(message: "朗读失败，已停止：系统朗读不可用：macOS 语音组件异常或播放被中断（点播放键重试）", redeemAction: false)
        )
        // 凭据类归因（allowSettings）→ 后缀带「，或到 设置 → 语音 检查」。
        struct CredentialsMissing: LocalizedError {
            var errorDescription: String? { "语音凭据未配置" }
        }
        XCTAssertEqual(
            readerSpeechFailureToast(CredentialsMissing()),
            ReaderSpeechFailureToast(
                message: "朗读失败，已停止：缺少语音凭据：到 设置 → 语音 填一次即可（跟读/朗读/识别共用）（点播放键重试，或到 设置 → 语音 检查）",
                redeemAction: false
            )
        )
    }
}
