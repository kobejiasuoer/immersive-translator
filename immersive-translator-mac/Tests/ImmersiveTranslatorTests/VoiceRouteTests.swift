import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 消费点路由守卫单测（对齐 Windows voiceRoute.test.ts 行为向量：归约优先级
// 逐态（未登录即使有能力仍 off；banned 与网络失败分开；voice 段缺失不给重试
// 误导；配额常驻与事件别名两路；能力缺失三种；ise 本地开关；三项各验一次
// 放行）；EDGE_FALLBACK_NOTICE 字面量；xfyun 不查登录/能力；gateway 未登录省
// 一次 me/config；caps TTL 缓存、失败不缓存）。
// ---------------------------------------------------------------------------

final class VoiceRouteTests: XCTestCase {
    override func tearDown() {
        VoiceRoute.resetForTests()
        super.tearDown()
    }

    private func caps(
        available: Bool = true,
        voices: [VoiceTtsVoice] = [VoiceTtsVoice(id: "v1", label: "一")],
        languages: [String] = ["en_us", "zh_cn"],
        iseEnabled: Bool = true,
        quota: VoiceQuotaMap? = nil
    ) -> VoiceCapabilities {
        VoiceCapabilities(available: available, ttsVoices: voices, asrLanguages: languages, iseEnabled: iseEnabled, quota: quota)
    }

    private func signals(
        loggedIn: Bool = true,
        caps: VoiceCapabilities? = nil,
        capsError: String? = nil,
        quotaEvents: [String] = [],
        ability: VoiceRouteAbility,
        asrLang: VoiceAsrLang? = nil,
        asrMode: VoiceAsrMode? = nil,
        iseLocalOff: Bool = false
    ) -> VoiceRouteSignals {
        VoiceRouteSignals(
            loggedIn: loggedIn,
            caps: caps,
            capsError: capsError,
            quotaEvents: quotaEvents,
            ability: ability,
            asrLang: asrLang,
            asrMode: asrMode,
            iseLocalOff: iseLocalOff
        )
    }

    // MARK: EDGE_FALLBACK_NOTICE 字面量

    func testEdgeFallbackNoticeLiteral() {
        XCTAssertEqual(edgeFallbackNotice, "已临时使用 Edge 朗读")
    }

    // MARK: 归约优先级逐态

    func testNotLoggedInBeatsEverything() {
        let decision = reduceVoiceRoute(signals(
            loggedIn: false, caps: caps(), ability: .tts
        ))
        XCTAssertEqual(decision.engine, .off)
        XCTAssertEqual(decision.reason, .notLoggedIn)
        XCTAssertEqual(
            decision.hint,
            "请先登录，再检查云语音是否开放；也可在「设置 → 语音」使用讯飞"
        )
    }

    /// 登录失效类错误码单列（Windows 300247a）：不再落「查网络」，hint 走
    /// voiceErrorMessage 映射（token_expired 静默文案为空 → 兜底句）。
    func testAuthExpiredErrorCodesGiveReloginHints() {
        for code in ["token_invalid", "unauthorized", "token_reused", "token_expired"] {
            let decision = reduceVoiceRoute(signals(caps: nil, capsError: code, ability: .tts))
            XCTAssertEqual(decision.engine, .off, code)
            XCTAssertEqual(decision.reason, .notLoggedIn, code)
            XCTAssertFalse(decision.hint?.isEmpty ?? true, code)
            XCTAssertNotEqual(decision.hint, "暂无法连接沉浸云语音，请检查网络后重试", code)
        }
        XCTAssertEqual(
            reduceVoiceRoute(signals(caps: nil, capsError: "token_invalid", ability: .tts)).hint,
            "登录已失效，请重新登录"
        )
    }

    func testVoiceNotConfiguredAndAccountChangedErrorCodes() {
        let notConfigured = reduceVoiceRoute(signals(caps: nil, capsError: "voice_not_configured", ability: .tts))
        XCTAssertEqual(notConfigured.engine, .off)
        XCTAssertEqual(notConfigured.reason, .voiceNotConfigured)
        XCTAssertEqual(notConfigured.hint, "语音功能暂未开通")
        let changed = reduceVoiceRoute(signals(caps: nil, capsError: "voice_account_changed", ability: .tts))
        XCTAssertEqual(changed.engine, .off)
        XCTAssertEqual(changed.reason, .capsUnavailable)
        XCTAssertEqual(changed.hint, "账号已切换，请重新操作")
    }

    func testBannedSeparateFromNetworkFailure() {
        let banned = reduceVoiceRoute(signals(caps: nil, capsError: "banned", ability: .tts))
        XCTAssertEqual(banned.reason, .banned)
        XCTAssertEqual(banned.hint, "账号已被封禁")
        let network = reduceVoiceRoute(signals(caps: nil, capsError: "network_error", ability: .tts))
        XCTAssertEqual(network.reason, .capsUnavailable)
        XCTAssertEqual(network.hint, "暂无法连接沉浸云语音，请检查网络后重试")
    }

    func testVoiceSegmentMissingGivesNoRetryHint() {
        let decision = reduceVoiceRoute(signals(caps: caps(available: false), ability: .tts))
        XCTAssertEqual(decision.reason, .voiceNotConfigured)
        XCTAssertEqual(decision.hint, "语音功能暂未开通")
    }

    func testQuotaExhaustedStandingAndEventAliases() {
        // 常驻 remaining===0
        let standing = reduceVoiceRoute(signals(
            caps: caps(quota: [.tts: VoiceQuotaRemaining(remaining: 0, allowance: 500, resetsAt: "2026-11-30T16:00:00.000Z")]),
            ability: .tts
        ))
        XCTAssertEqual(standing.reason, .quotaExhausted)
        XCTAssertEqual(standing.hint, "本月朗读额度已用完，可在「设置 → 账号」用兑换码补足")
        XCTAssertEqual(standing.quota?.resetsAt, "2026-11-30T16:00:00.000Z")
        // 402 事件 resource 别名（asr_seconds → asr；ise_calls → ise）
        let eventAsr = reduceVoiceRoute(signals(caps: caps(), quotaEvents: ["asr_seconds"], ability: .asr))
        XCTAssertEqual(eventAsr.reason, .quotaExhausted)
        XCTAssertEqual(eventAsr.hint, "本月识别额度已用完，可在「设置 → 账号」用兑换码补足")
        let eventIse = reduceVoiceRoute(signals(caps: caps(), quotaEvents: ["ise_calls"], ability: .ise))
        XCTAssertEqual(eventIse.reason, .quotaExhausted)
        // 未命中的资源不拦
        XCTAssertEqual(reduceVoiceRoute(signals(caps: caps(), quotaEvents: ["asr_seconds"], ability: .tts)).engine, .gateway)
    }

    func testIseLocalSwitchOff() {
        let decision = reduceVoiceRoute(signals(caps: caps(), ability: .ise, iseLocalOff: true))
        XCTAssertEqual(decision.reason, .iseTurnedOff)
        XCTAssertEqual(decision.hint, "跟读打分已在设置里关闭，可在「设置 → 语音」重新开启")
        // 仅 ise 消费；tts/asr 不受影响
        XCTAssertEqual(reduceVoiceRoute(signals(caps: caps(), ability: .tts, iseLocalOff: true)).engine, .gateway)
    }

    func testCapabilityMissingThreeWays() {
        XCTAssertEqual(
            reduceVoiceRoute(signals(caps: caps(voices: []), ability: .tts)).hint,
            "沉浸云云端朗读暂未开放"
        )
        XCTAssertEqual(
            reduceVoiceRoute(signals(caps: caps(languages: ["zh_cn"]), ability: .asr, asrLang: .en_us)).hint,
            "沉浸云口语识别暂未开放"
        )
        XCTAssertEqual(
            reduceVoiceRoute(signals(caps: caps(languages: []), ability: .asr)).hint,
            "沉浸云口语识别暂未开放"
        )
        XCTAssertEqual(
            reduceVoiceRoute(signals(caps: caps(iseEnabled: false), ability: .ise)).hint,
            "沉浸云跟读打分暂未开放"
        )
    }

    /// 分语种能力（300247a）：batch/stream 字段按方式取；**明确的空数组不回退**
    /// asrLanguages；缺省（旧服务端未下发）兼容回退。
    func testAsrLanguagesSplitByMode() {
        let split = VoiceCapabilities(
            available: true,
            ttsVoices: [VoiceTtsVoice(id: "v1", label: "一")],
            asrLanguages: ["en_us"],
            asrStreamingLanguages: [],
            asrBatchLanguages: ["en_us", "zh_cn"],
            iseEnabled: true,
            quota: nil
        )
        // batch 有英语：放行。
        XCTAssertEqual(reduceVoiceRoute(signals(caps: split, ability: .asr, asrLang: .en_us, asrMode: .batch)).engine, .gateway)
        // stream 明确空数组：不回退 asrLanguages，拦截。
        XCTAssertEqual(reduceVoiceRoute(signals(caps: split, ability: .asr, asrLang: .en_us, asrMode: .stream)).reason, .capabilityMissing)
        // asrMode 缺省 = batch。
        XCTAssertEqual(reduceVoiceRoute(signals(caps: split, ability: .asr, asrLang: .en_us)).engine, .gateway)
        // 未下发分语种字段（旧服务端）：回退 asrLanguages。
        XCTAssertEqual(reduceVoiceRoute(signals(caps: caps(), ability: .asr, asrLang: .en_us, asrMode: .stream)).engine, .gateway)
    }

    func testGatewayPassForAllThreeAbilities() {
        for ability in allVoiceCapabilities {
            XCTAssertEqual(reduceVoiceRoute(signals(caps: caps(), ability: ability)).engine, .gateway)
            XCTAssertEqual(reduceVoiceRoute(signals(caps: caps(), ability: ability)).reason, nil)
        }
    }

    // MARK: 异步取数：xfyun 直放行、gateway 未登录省一次 me/config

    func testXfyunSkipsLoginAndCapsProbe() async {
        var loginProbes = 0
        var capsProbes = 0
        let decision = await VoiceRoute.resolve(
            .asr,
            deps: VoiceRouteDeps(
                resolveProvider: { .xfyun },
                isLoggedIn: {
                    loginProbes += 1
                    return true
                },
                fetchCaps: {
                    capsProbes += 1
                    return self.caps()
                }
            )
        )
        XCTAssertEqual(decision, .xfyun)
        XCTAssertEqual(loginProbes, 0, "xfyun 不查登录态（零回归红线）")
        XCTAssertEqual(capsProbes, 0, "xfyun 不拉能力")
    }

    func testProviderProbeFailureFallsBackToXfyun() async {
        struct Boom: Error {}
        let decision = await VoiceRoute.resolve(
            .tts,
            deps: VoiceRouteDeps(
                resolveProvider: { throw Boom() },
                isLoggedIn: { false }
            )
        )
        XCTAssertEqual(decision, .xfyun)
    }

    func testGatewayNotLoggedInSkipsMeConfig() async {
        var capsProbes = 0
        let decision = await VoiceRoute.resolve(
            .tts,
            deps: VoiceRouteDeps(
                resolveProvider: { .gateway },
                isLoggedIn: { false },
                fetchCaps: {
                    capsProbes += 1
                    return self.caps()
                }
            )
        )
        XCTAssertEqual(decision.reason, .notLoggedIn)
        XCTAssertEqual(capsProbes, 0, "未登录不拉 me/config（省一次往返）")
    }

    func testResolveGatewayHappyPath() async {
        let decision = await VoiceRoute.resolve(
            .tts,
            deps: VoiceRouteDeps(
                resolveProvider: { .gateway },
                isLoggedIn: { true },
                fetchCaps: { self.caps() }
            )
        )
        XCTAssertEqual(decision.engine, .gateway)
    }

    // MARK: 异步取数：Windows resolveVoiceRoute 用例逐条

    func testResolveCapsCachedAcrossAbilities() async {
        var fetches = 0
        let deps = VoiceRouteDeps(
            resolveProvider: { .gateway },
            isLoggedIn: { true },
            fetchCaps: {
                fetches += 1
                return self.caps()
            }
        )
        let first = await VoiceRoute.resolve(.asr, asrLang: .en_us, deps: deps)
        XCTAssertEqual(first.engine, .gateway)
        let second = await VoiceRoute.resolve(.ise, deps: deps)
        XCTAssertEqual(second.engine, .gateway)
        XCTAssertEqual(fetches, 1, "第二次命中 TTL 缓存")
    }

    func testResolveCapsFailureNotCachedThenRecovers() async {
        var fail = true
        let deps = VoiceRouteDeps(
            resolveProvider: { .gateway },
            isLoggedIn: { true },
            fetchCaps: {
                if fail { throw URLError(.notConnectedToInternet) }
                return self.caps()
            }
        )
        let down = await VoiceRoute.resolve(.tts, deps: deps)
        XCTAssertEqual(down.engine, .off)
        XCTAssertEqual(down.reason, .capsUnavailable)
        fail = false
        let ok = await VoiceRoute.resolve(.tts, deps: deps)
        XCTAssertEqual(ok.engine, .gateway, "失败不缓存：恢复后下一次重拉成功")
    }

    func testResolveBannedAuthErrorSeparateFromNetwork() async {
        let deps = VoiceRouteDeps(
            resolveProvider: { .gateway },
            isLoggedIn: { true },
            fetchCaps: {
                throw AuthError(code: "banned", message: "stub", httpStatus: 403, retryAfterSeconds: nil)
            }
        )
        let decision = await VoiceRoute.resolve(.ise, deps: deps)
        XCTAssertEqual(decision.engine, .off)
        XCTAssertEqual(decision.reason, .banned)
        XCTAssertEqual(decision.hint, "账号已被封禁")
    }

    func testResolveIseLocalSwitchAndDefaultOn() async {
        var iseOn = false
        let deps = VoiceRouteDeps(
            resolveProvider: { .gateway },
            isLoggedIn: { true },
            fetchCaps: { self.caps() },
            iseEnabled: { iseOn }
        )
        let off = await VoiceRoute.resolve(.ise, deps: deps)
        XCTAssertEqual(off.reason, .iseTurnedOff)
        XCTAssertEqual(off.hint, "跟读打分已在设置里关闭，可在「设置 → 语音」重新开启")
        iseOn = true
        let on = await VoiceRoute.resolve(.ise, deps: deps)
        XCTAssertEqual(on.engine, .gateway)
        // 开关只作用于 ise。
        iseOn = false
        let asr = await VoiceRoute.resolve(.asr, deps: deps)
        XCTAssertEqual(asr.engine, .gateway)
        // 缺省（从未写入）视为开：VoicePrefsStore.loadIseEnabled 未存过为 true。
        let suite = "voice-route-ise-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertTrue(VoicePrefsStore.loadIseEnabled(defaults: defaults))
    }

    func testResolveProviderDefaultReadsStoredPrefs() async {
        // 缺省依赖：已存 xfyun → 直放行 xfyun（不查登录态）。
        let saved = UserDefaults.standard.string(forKey: VoicePrefsStore.providerKey)
        defer {
            if let saved {
                UserDefaults.standard.set(saved, forKey: VoicePrefsStore.providerKey)
            } else {
                UserDefaults.standard.removeObject(forKey: VoicePrefsStore.providerKey)
            }
        }
        VoicePrefsStore.saveProvider(.xfyun)
        var probes = 0
        var deps = VoiceRouteDeps()
        deps.isLoggedIn = {
            probes += 1
            return true
        }
        let decision = await VoiceRoute.resolve(.tts, deps: deps)
        XCTAssertEqual(decision, .xfyun)
        XCTAssertEqual(probes, 0)
    }

    // MARK: caps TTL 缓存 / 失败不缓存

    func testCapsTTLCacheHitAndExpiry() async {
        var clockNow = Date(timeIntervalSince1970: 1_000)
        var fetches = 0
        let deps = VoiceRouteDeps(
            resolveProvider: { .gateway },
            isLoggedIn: { true },
            fetchCaps: {
                fetches += 1
                return self.caps()
            }
        )
        VoiceRoute.setClockForTests { clockNow }
        defer { VoiceRoute.resetForTests() }

        _ = await VoiceRoute.fetchCaps(deps: deps)
        _ = await VoiceRoute.fetchCaps(deps: deps)
        XCTAssertEqual(fetches, 1, "TTL 内命中缓存")

        clockNow = clockNow.addingTimeInterval(29)
        _ = await VoiceRoute.fetchCaps(deps: deps)
        XCTAssertEqual(fetches, 1, "29s < 30s TTL 仍命中")

        clockNow = clockNow.addingTimeInterval(1.5)
        _ = await VoiceRoute.fetchCaps(deps: deps)
        XCTAssertEqual(fetches, 2, "超过 30s 重新拉取")
    }

    func testCapsFailureNotCached() async {
        var fetches = 0
        let deps = VoiceRouteDeps(
            resolveProvider: { .gateway },
            isLoggedIn: { true },
            fetchCaps: {
                fetches += 1
                throw AuthError(code: "network_error", message: "x", httpStatus: nil, retryAfterSeconds: nil)
            }
        )
        let first = await VoiceRoute.fetchCaps(deps: deps)
        XCTAssertNil(first.caps)
        XCTAssertEqual(first.errorCode, "network_error")
        let second = await VoiceRoute.fetchCaps(deps: deps)
        XCTAssertEqual(fetches, 2, "失败不缓存：下一次调用立即重试")
        XCTAssertEqual(second.errorCode, "network_error")
    }

    // MARK: 能力缓存按账号隔离（300247a voice_account_changed）

    func testCapsCacheIsolatedPerAccount() async {
        var fetches = 0
        var currentAccount: String? = "a"
        let deps = VoiceRouteDeps(
            resolveProvider: { .gateway },
            isLoggedIn: { true },
            accountId: { currentAccount },
            fetchCaps: {
                fetches += 1
                return self.caps()
            }
        )
        _ = await VoiceRoute.fetchCaps(deps: deps)
        _ = await VoiceRoute.fetchCaps(deps: deps)
        XCTAssertEqual(fetches, 1, "同账号 TTL 内命中缓存")
        // 切号：旧账号缓存不得喂给新账号。
        currentAccount = "b"
        _ = await VoiceRoute.fetchCaps(deps: deps)
        XCTAssertEqual(fetches, 2, "账号不同即重拉")
        // 切回 A：缓存已被 B 覆盖，同样重拉。
        currentAccount = "a"
        _ = await VoiceRoute.fetchCaps(deps: deps)
        XCTAssertEqual(fetches, 3)
    }

    func testFetchCapsIdentityChangedMidFlightReturnsAccountChanged() async {
        var fetchCount = 0
        var currentAccount: String? = "a"
        let deps = VoiceRouteDeps(
            resolveProvider: { .gateway },
            isLoggedIn: { true },
            accountId: { currentAccount },
            fetchCaps: {
                fetchCount += 1
                // 取数往返期间切号/登出：取数后身份核对失败。
                currentAccount = nil
                return self.caps()
            }
        )
        let result = await VoiceRoute.fetchCaps(deps: deps)
        XCTAssertNil(result.caps)
        XCTAssertEqual(result.errorCode, "voice_account_changed")
        // 失败不缓存：恢复身份后下一次立即重拉。
        currentAccount = "a"
        _ = await VoiceRoute.fetchCaps(deps: deps)
        XCTAssertEqual(fetchCount, 2)
    }

    func testLoggedOutResolveClearsCapsCache() async {
        var fetches = 0
        var loggedIn = true
        let deps = VoiceRouteDeps(
            resolveProvider: { .gateway },
            isLoggedIn: { loggedIn },
            fetchCaps: {
                fetches += 1
                return self.caps()
            }
        )
        let ok = await VoiceRoute.resolve(.tts, deps: deps)
        XCTAssertEqual(ok.engine, .gateway)
        // 登出：归约给未登录，且缓存被清。
        loggedIn = false
        let off = await VoiceRoute.resolve(.tts, deps: deps)
        XCTAssertEqual(off.reason, .notLoggedIn)
        // 重新登录：重拉（旧账号能力不残留）。
        loggedIn = true
        _ = await VoiceRoute.resolve(.tts, deps: deps)
        XCTAssertEqual(fetches, 2, "登出清空缓存：重新登录后重拉")
    }
}
