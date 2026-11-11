import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 沉浸云语音卡视图状态机单测（对齐 Windows gatewayViewState.test.ts 行为向量：
// 封禁优先于一切；其余失败码归网络失败；loading/none/full/partial 三种缺失；
// 常驻 remaining===0 判耗尽；402 事件别名并入且去重；状态行文案逐态断言；
// quotaLine 单位（字/秒/次）与「—」占位；resetsAt→「M 月 D 日重置」、非法 null）。
// ---------------------------------------------------------------------------

final class GatewayViewStateTests: XCTestCase {
    private func caps(
        available: Bool = true,
        voices: [VoiceTtsVoice] = [VoiceTtsVoice(id: "v1", label: "一")],
        languages: [String] = ["en_us"],
        iseEnabled: Bool = true,
        quota: VoiceQuotaMap? = nil
    ) -> VoiceCapabilities {
        VoiceCapabilities(available: available, ttsVoices: voices, asrLanguages: languages, iseEnabled: iseEnabled, quota: quota)
    }

    private func input(
        loading: Bool = false,
        errorCode: String? = nil,
        caps: VoiceCapabilities? = nil,
        quotaEvents: [String] = []
    ) -> VoiceGatewayInput {
        VoiceGatewayInput(loading: loading, errorCode: errorCode, caps: caps, quotaEvents: quotaEvents)
    }

    // MARK: 相位归约

    func testBannedWinsOverEverything() {
        let view = reduceVoiceGatewayView(input(loading: true, errorCode: "banned", caps: caps(), quotaEvents: ["tts_chars"]))
        XCTAssertEqual(view.caps, .banned)
        XCTAssertFalse(view.exhausted)
    }

    func testOtherErrorCodesCollapseToErrorPhase() {
        for code in ["network_error", "rate_limited", "who_knows"] {
            XCTAssertEqual(reduceVoiceGatewayView(input(errorCode: code, caps: nil)).caps, .error, code)
        }
    }

    /// 登录失效类错误码单列 authRequired（Windows 300247a：不再并入网络失败）。
    func testAuthErrorCodesCollapseToAuthRequiredPhase() {
        for code in ["token_invalid", "unauthorized", "token_reused", "token_expired"] {
            let view = reduceVoiceGatewayView(input(errorCode: code, caps: nil))
            XCTAssertEqual(view.caps, .authRequired, code)
            XCTAssertEqual(view.errorCode, code)
        }
    }

    func testVoiceNotConfiguredErrorCodeIsNonePhaseWithAllMissing() {
        let view = reduceVoiceGatewayView(input(errorCode: "voice_not_configured", caps: nil))
        XCTAssertEqual(view.caps, .noneCase)
        XCTAssertEqual(view.missing, allVoiceCapabilities)
    }

    func testLoadingWhileCapsNil() {
        XCTAssertEqual(reduceVoiceGatewayView(input(loading: true, caps: caps())).caps, .loading)
        XCTAssertEqual(reduceVoiceGatewayView(input(loading: false, caps: nil)).caps, .loading)
    }

    func testNoneWhenVoiceSegmentMissing() {
        let view = reduceVoiceGatewayView(input(caps: caps(available: false)))
        XCTAssertEqual(view.caps, .noneCase)
        XCTAssertEqual(view.missing, allVoiceCapabilities, "未开通时三项全缺")
    }

    /// 三项全缺（能力下发齐全但全空）等同未开放，不给 partial 的误导。
    func testAllMissingCollapsesToNonePhase() {
        let view = reduceVoiceGatewayView(input(caps: caps(voices: [], languages: [], iseEnabled: false)))
        XCTAssertEqual(view.caps, .noneCase)
        XCTAssertEqual(view.missing, allVoiceCapabilities)
    }

    func testPartialMissingCombinations() {
        // 三种缺失各自成 partial；多项缺失并列。
        let noTts = reduceVoiceGatewayView(input(caps: caps(voices: [])))
        XCTAssertEqual(noTts.caps, .partial)
        XCTAssertEqual(noTts.missing, [.tts])
        let noAsr = reduceVoiceGatewayView(input(caps: caps(languages: [])))
        XCTAssertEqual(noAsr.missing, [.asr])
        let noIse = reduceVoiceGatewayView(input(caps: caps(iseEnabled: false)))
        XCTAssertEqual(noIse.missing, [.ise])
        let two = reduceVoiceGatewayView(input(caps: caps(voices: [], iseEnabled: false)))
        XCTAssertEqual(two.missing, [.tts, .ise])
        XCTAssertEqual(reduceVoiceGatewayView(input(caps: caps())).caps, .full)
    }

    // MARK: 配额双来源 + 去重

    func testQuotaExhaustedFromStandingQuota() {
        let view = reduceVoiceGatewayView(input(caps: caps(quota: [
            .tts: VoiceQuotaRemaining(remaining: 0),
            .asr: VoiceQuotaRemaining(remaining: 30),
        ])))
        XCTAssertEqual(view.caps, .full) // 耗尽不改相位
        XCTAssertTrue(view.exhausted)
        XCTAssertEqual(view.exhaustedLabels, ["云端朗读"])
    }

    func testQuotaEventsAliasesMergedAndDeduped() {
        let view = reduceVoiceGatewayView(input(
            caps: caps(quota: [.tts: VoiceQuotaRemaining(remaining: 0)]),
            quotaEvents: ["tts_chars", "asr_seconds", "asr_seconds"]
        ))
        XCTAssertTrue(view.exhausted)
        // 常驻与事件都归一成能力全名（300247a：tts_chars→「云端朗读」同 asr_seconds→
        // 「口语识别」），按插入序去重（对齐 JS Set 语义）。
        XCTAssertEqual(view.exhaustedLabels, ["云端朗读", "口语识别"])
    }

    /// 已缺失的能力不再叠「额度已用完」（未开放谈不上用完，Windows 同步修复）。
    func testExhaustedLabelsSkipMissingCapabilities() {
        let view = reduceVoiceGatewayView(input(
            caps: caps(voices: [], quota: [.tts: VoiceQuotaRemaining(remaining: 0)]),
            quotaEvents: ["tts_chars"]
        ))
        XCTAssertEqual(view.caps, .partial)
        XCTAssertFalse(view.exhausted, "tts 已缺失，耗尽标签应跳过")
        XCTAssertTrue(view.exhaustedLabels.isEmpty)
    }

    func testQuotaEventsOnlyFallbackSourceWithTtsCharsAlias() {
        // 对齐 Windows「兜底来源：402/WSS 事件 resource（含 tts_chars 别名）并入耗尽」：
        // 无常驻 quota 时，事件单独即可点亮耗尽态（tts_chars 不得被丢弃）。
        let view = reduceVoiceGatewayView(input(caps: caps(), quotaEvents: ["ise_calls", "tts_chars"]))
        XCTAssertTrue(view.exhausted)
        XCTAssertEqual(view.exhaustedLabels, ["跟读打分", "云端朗读"], "事件 resource 归一成能力全名，按到达序")
    }

    func testUnknownEventResourceFallsBackToFeatureLabel() {
        let view = reduceVoiceGatewayView(input(caps: caps(), quotaEvents: ["llm_tokens"]))
        XCTAssertTrue(view.exhausted)
        XCTAssertEqual(view.exhaustedLabels, ["对话"])
    }

    func testRepeatedEventsDeduped() {
        let once = reduceVoiceGatewayView(input(caps: caps(), quotaEvents: ["ise_calls"]))
        let twice = reduceVoiceGatewayView(input(caps: caps(), quotaEvents: ["ise_calls", "ise_calls"]))
        XCTAssertEqual(twice.exhaustedLabels, once.exhaustedLabels)
    }

    func testFullPassesQuotaThroughUnexhausted() {
        // 三项齐备 → full；quota 原样透传（常驻余量条数据源）。
        let quota: VoiceQuotaMap = [.tts: VoiceQuotaRemaining(remaining: 10)]
        let view = reduceVoiceGatewayView(input(caps: caps(quota: quota)))
        XCTAssertEqual(view.caps, .full)
        XCTAssertEqual(view.missing, [])
        XCTAssertEqual(view.quota, quota)
        XCTAssertFalse(view.exhausted)
    }

    func testStatusLineFullExhaustedByEvent() {
        let view = reduceVoiceGatewayView(input(caps: caps(), quotaEvents: ["ise_calls"]))
        let line = voiceGatewayStatusLine(view, loggedIn: true, email: "u@x.y")
        XCTAssertEqual(line.tone, .off)
        XCTAssertEqual(line.text, "本月跟读打分额度已用完")
    }

    func testNoQuotaNoEventsNotExhausted() {
        let view = reduceVoiceGatewayView(input(caps: caps(quota: [.ise: VoiceQuotaRemaining(remaining: 5)])))
        XCTAssertFalse(view.exhausted)
        XCTAssertEqual(view.quota?[.ise]?.remaining, 5)
    }

    // MARK: 状态行文案逐态（300247a：不再带「已登录 \(email)」前缀）

    func testStatusLineLoggedOut() {
        let line = voiceGatewayStatusLine(reduceVoiceGatewayView(input()), loggedIn: false, email: "a@b.c")
        XCTAssertEqual(line.tone, .off)
        XCTAssertEqual(line.text, "未登录，登录后检查语音是否开放")
    }

    func testStatusLinePhases() {
        XCTAssertEqual(voiceGatewayStatusLine(reduceVoiceGatewayView(input(errorCode: "banned")), loggedIn: true, email: "a@b.c").text, "账号已被封禁")
        XCTAssertEqual(voiceGatewayStatusLine(reduceVoiceGatewayView(input(errorCode: "network_error")), loggedIn: true, email: "a@b.c").text, "连接沉浸云失败，请检查网络")
        XCTAssertEqual(voiceGatewayStatusLine(reduceVoiceGatewayView(input(caps: caps(available: false))), loggedIn: true, email: "a@b.c").text, "三项云语音功能暂未开放")
        XCTAssertEqual(voiceGatewayStatusLine(reduceVoiceGatewayView(input(loading: true)), loggedIn: true, email: "a@b.c").text, "正在检查语音服务…")
        XCTAssertEqual(voiceGatewayStatusLine(reduceVoiceGatewayView(input(loading: true)), loggedIn: true, email: "a@b.c").tone, .off)
        XCTAssertEqual(voiceGatewayStatusLine(reduceVoiceGatewayView(input(caps: caps())), loggedIn: true, email: "a@b.c").text, "朗读、识别、跟读打分均已开放")
    }

    /// authRequired 态按错误码查 voiceErrorMessage 映射；静默文案（token_expired）
    /// 落兜底句。
    func testStatusLineAuthRequired() {
        let invalid = voiceGatewayStatusLine(reduceVoiceGatewayView(input(errorCode: "token_invalid")), loggedIn: true, email: "a@b.c")
        XCTAssertEqual(invalid.tone, .err)
        XCTAssertEqual(invalid.text, "登录已失效，请重新登录")
        let reused = voiceGatewayStatusLine(reduceVoiceGatewayView(input(errorCode: "token_reused")), loggedIn: true, email: "a@b.c")
        XCTAssertEqual(reused.text, "检测到登录凭据异常复用，该账号已在所有设备安全下线，请重新登录")
        let expired = voiceGatewayStatusLine(reduceVoiceGatewayView(input(errorCode: "token_expired")), loggedIn: true, email: "a@b.c")
        XCTAssertEqual(expired.text, "登录已失效，请重新登录")
    }

    func testStatusLinePartialInterpolatesShortNames() {
        let view = reduceVoiceGatewayView(input(caps: caps(voices: [], iseEnabled: false)))
        let line = voiceGatewayStatusLine(view, loggedIn: true, email: "u@x.y")
        XCTAssertEqual(line.text, "识别已开放，朗读、跟读打分未开放")
        XCTAssertEqual(line.tone, .off)
    }

    func testStatusLineFullExhausted() {
        let view = reduceVoiceGatewayView(input(caps: caps(quota: [.tts: VoiceQuotaRemaining(remaining: 0)])))
        XCTAssertEqual(voiceGatewayStatusLine(view, loggedIn: true, email: "u@x.y").text, "本月云端朗读额度已用完")
    }

    // MARK: quotaLine 单位与「—」

    func testQuotaLineUnits() {
        let quota: VoiceQuotaMap = [
            .tts: VoiceQuotaRemaining(remaining: 123456),
            .asr: VoiceQuotaRemaining(remaining: 3600),
            .ise: VoiceQuotaRemaining(remaining: 8),
        ]
        XCTAssertEqual(quotaLine(quota), "朗读 123456 字 · 识别 3600 秒 · 跟读 8 次")
    }

    func testQuotaLinePlaceholders() {
        XCTAssertEqual(
            quotaLine([.tts: VoiceQuotaRemaining(remaining: 0)]),
            "朗读 0 字 · 识别 — 秒 · 跟读 — 次"
        )
        // remaining 为 null（服务端未下发余量）也用 —。
        XCTAssertEqual(
            quotaLine([.asr: VoiceQuotaRemaining(remaining: nil)]),
            "朗读 — 字 · 识别 — 秒 · 跟读 — 次"
        )
    }

    // MARK: quotaResetText

    func testQuotaResetTextFormatsLocalMonthDay() {
        // 本地时区构造日期（quotaResetText 按本地月日，对齐 JS Date.getMonth/getDate）。
        var components = DateComponents()
        components.year = 2026
        components.month = 6
        components.day = 15
        components.hour = 12
        let date = Calendar.current.date(from: components)!
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = .current
        let iso = formatter.string(from: date)
        XCTAssertEqual(quotaResetText(iso), "6 月 15 日重置")
    }

    func testQuotaResetTextInvalidAndMissing() {
        XCTAssertNil(quotaResetText("not-a-date"))
        XCTAssertNil(quotaResetText(""))
        XCTAssertNil(quotaResetText(nil))
    }
}
