import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 语音网关错误码 → 文案映射单测（对齐 Windows src/lib/voice/voiceErrors.test.ts
// 行为向量：§二表逐行 kind/action/retryable、final 切换、unauthorized 归一、
// token_reused 与 authErrorText 同文案、quotaDetailsOf 防御、功能名插值、
// 文案不泄漏服务端 message）。
// ---------------------------------------------------------------------------

final class VoiceErrorsTests: XCTestCase {
    private func error(_ code: String, details: [String: Any] = [:], retryAfterSeconds: Int? = nil) -> VoiceError {
        VoiceError(code: code, message: "内部提示别外泄", details: details, retryAfterSeconds: retryAfterSeconds)
    }

    // MARK: §二表逐行

    func testTokenExpiredIsSilentRetry() {
        let info = voiceErrorMessage(error("token_expired"))
        XCTAssertEqual(info.text, "")
        XCTAssertEqual(info.kind, .silent)
        XCTAssertEqual(info.action, .retry)
        XCTAssertTrue(info.retryable)
    }

    func testTokenInvalidRelogin() {
        let info = voiceErrorMessage(error("token_invalid"))
        XCTAssertEqual(info.text, "登录已失效，请重新登录")
        XCTAssertEqual(info.kind, .message)
        XCTAssertEqual(info.action, .relogin)
        XCTAssertFalse(info.retryable)
    }

    func testUnauthorizedNormalizedToTokenInvalid() {
        let info = voiceErrorMessage(error("unauthorized"))
        XCTAssertEqual(info.text, "登录已失效，请重新登录")
        XCTAssertEqual(info.action, .relogin)
        XCTAssertFalse(info.retryable)
    }

    func testTokenReusedMatchesAuthErrorTextWording() {
        let info = voiceErrorMessage(error("token_reused"))
        XCTAssertEqual(info.text, "检测到登录凭据异常复用，该账号已在所有设备安全下线，请重新登录")
        XCTAssertEqual(info.action, .relogin)
        XCTAssertFalse(info.retryable)
        // 与 Mac authErrorText 表的 token_reused 同文案（ServerAuth.swift 映射表）。
        let authText = authErrorText(AuthError(code: "token_reused", message: "m", httpStatus: nil, retryAfterSeconds: nil))
        XCTAssertEqual(info.text, authText.text)
    }

    func testBannedAppeal() {
        let info = voiceErrorMessage(error("banned"))
        XCTAssertEqual(info.text, "账号已被封禁")
        XCTAssertEqual(info.action, .appeal)
        XCTAssertFalse(info.retryable)
    }

    func testVoiceTicketInvalidTwoPhase() {
        let retrying = voiceErrorMessage(error("voice_ticket_invalid"))
        XCTAssertEqual(retrying.text, "连接不稳定，正在重试…")
        XCTAssertTrue(retrying.retryable)
        let final = voiceErrorMessage(error("voice_ticket_invalid"), final: true)
        XCTAssertEqual(final.text, "请稍后再试")
        XCTAssertEqual(final.action, .retry)
        XCTAssertFalse(final.retryable)
    }

    func testQuotaExceededInterpolatesFeatureLabel() {
        XCTAssertEqual(
            voiceErrorMessage(error("quota_exceeded", details: ["resource": "tts_chars"])).text,
            "本月朗读额度已用完"
        )
        XCTAssertEqual(
            voiceErrorMessage(error("quota_exceeded", details: ["resource": "asr_seconds"])).text,
            "本月口语识别额度已用完"
        )
        XCTAssertEqual(
            voiceErrorMessage(error("quota_exceeded", details: ["resource": "ise_calls"])).text,
            "本月跟读打分额度已用完"
        )
        XCTAssertEqual(
            voiceErrorMessage(error("quota_exceeded", details: ["resource": "llm_tokens"])).text,
            "本月对话额度已用完"
        )
        // 未知/缺失资源 → 兜底「语音」；动作恒 redeem。
        XCTAssertEqual(voiceErrorMessage(error("quota_exceeded")).text, "本月语音额度已用完")
        XCTAssertEqual(voiceErrorMessage(error("quota_exceeded", details: ["resource": "mystery"])).text, "本月语音额度已用完")
        XCTAssertEqual(voiceErrorMessage(error("quota_exceeded")).action, .redeem)
        XCTAssertFalse(voiceErrorMessage(error("quota_exceeded")).retryable)
    }

    func testRateLimitedRetryable() {
        let info = voiceErrorMessage(error("rate_limited"))
        XCTAssertEqual(info.text, "请求太频繁，请稍后再试")
        XCTAssertEqual(info.action, .retry)
        XCTAssertTrue(info.retryable)
    }

    func testIseDisabledSilent() {
        let info = voiceErrorMessage(error("ise_disabled"))
        XCTAssertEqual(info.text, "")
        XCTAssertEqual(info.kind, .silent)
        XCTAssertNil(info.action)
        XCTAssertFalse(info.retryable)
    }

    func testVoiceNotConfigured() {
        let info = voiceErrorMessage(error("voice_not_configured"))
        XCTAssertEqual(info.text, "语音功能暂未开通")
        XCTAssertNil(info.action)
        XCTAssertFalse(info.retryable)
    }

    func testVoiceTextTooLongInternal() {
        let info = voiceErrorMessage(error("voice_text_too_long"))
        XCTAssertEqual(info.text, "")
        XCTAssertEqual(info.kind, .internalCase)
        XCTAssertEqual(info.action, .retry)
        XCTAssertTrue(info.retryable)
    }

    func testInvalidStateAndSessionTooLong() {
        for code in ["voice_invalid_state", "voice_session_too_long"] {
            let info = voiceErrorMessage(error(code))
            XCTAssertEqual(info.text, "单次最长 60 秒，请重新开始", code)
            XCTAssertEqual(info.action, .retry)
            XCTAssertTrue(info.retryable)
        }
    }

    func testUpstreamTwoPhase() {
        for code in ["upstream_error", "upstream_timeout"] {
            XCTAssertEqual(voiceErrorMessage(error(code)).text, "服务暂时不可用，正在重试", code)
            XCTAssertTrue(voiceErrorMessage(error(code)).retryable, code)
            XCTAssertEqual(voiceErrorMessage(error(code), final: true).text, "请稍后再试", code)
            XCTAssertFalse(voiceErrorMessage(error(code), final: true).retryable, code)
        }
    }

    func testVoiceDisconnectedTwoPhase() {
        XCTAssertEqual(voiceErrorMessage(error("voice_disconnected")).text, "网络中断，正在重连…")
        XCTAssertEqual(voiceErrorMessage(error("voice_disconnected"), final: true).text, "网络连接不稳定，请稍后再试")
    }

    func testNetworkError() {
        let info = voiceErrorMessage(error("network_error"))
        XCTAssertEqual(info.text, "网络连接失败，请检查网络后重试")
        XCTAssertTrue(info.retryable)
    }

    func testUnknownFallsBackSafely() {
        let info = voiceErrorMessage(error("who_knows"))
        XCTAssertEqual(info.text, "服务暂时不可用，请稍后再试")
        XCTAssertEqual(info.action, .retry)
        XCTAssertFalse(info.retryable)
    }

    // MARK: 文案不泄漏服务端 message（所有 code 一律）

    func testNeverLeaksServerMessage() {
        let allCodes = [
            "token_expired", "token_invalid", "token_reused", "banned", "voice_ticket_invalid",
            "quota_exceeded", "rate_limited", "ise_disabled", "voice_not_configured",
            "voice_text_too_long", "voice_invalid_state", "voice_session_too_long",
            "upstream_error", "upstream_timeout", "voice_disconnected", "network_error",
            "teapot", "",
        ]
        for code in allCodes {
            let info = voiceErrorMessage(error(code))
            XCTAssertFalse(info.text.contains("内部提示别外泄"), code)
        }
    }

    // MARK: quotaDetailsOf 防御

    func testQuotaDetailsOfDefensive() {
        // 合法 details
        let details = quotaDetailsOf(error("quota_exceeded", details: [
            "resource": "tts_chars", "remaining": 3.0, "allowance": 500.0, "resetsAt": "2026-11-01T00:00:00.000Z",
        ]))
        XCTAssertEqual(details.resource, "tts_chars")
        XCTAssertEqual(details.remaining, 3)
        XCTAssertEqual(details.allowance, 500)
        XCTAssertEqual(details.resetsAt, "2026-11-01T00:00:00.000Z")
        // 异常类型：非法归 nil / 空串归 nil
        let bad = quotaDetailsOf(error("quota_exceeded", details: [
            "resource": 42, "remaining": "x", "allowance": Double.nan, "resetsAt": "",
        ]))
        XCTAssertNil(bad.resource)
        XCTAssertNil(bad.remaining)
        XCTAssertNil(bad.allowance)
        XCTAssertNil(bad.resetsAt)
        // JSON 布尔不是数（JSONSerialization 下 true 是 NSNumber，须排除）。
        let boolDetails = try! JSONSerialization.jsonObject(with: Data("{\"remaining\":true,\"allowance\":false}".utf8)) as! [String: Any]
        let fromBool = quotaDetailsOf(error("quota_exceeded", details: boolDetails))
        XCTAssertNil(fromBool.remaining)
        XCTAssertNil(fromBool.allowance)
        // 无 details（AuthError 形状）→ 全空
        let empty = quotaDetailsOf(AuthError(code: "quota_exceeded", message: "m", httpStatus: 402, retryAfterSeconds: nil))
        XCTAssertEqual(empty, .empty)
    }

    // MARK: 功能名插值 + 兜底

    func testQuotaFeatureLabel() {
        XCTAssertEqual(quotaFeatureLabel("tts_chars"), "朗读")
        XCTAssertEqual(quotaFeatureLabel("asr_seconds"), "口语识别")
        XCTAssertEqual(quotaFeatureLabel("ise_calls"), "跟读打分")
        XCTAssertEqual(quotaFeatureLabel("llm_tokens"), "对话")
        XCTAssertEqual(quotaFeatureLabel("whatever"), "语音")
        XCTAssertEqual(quotaFeatureLabel(nil), "语音")
    }

    // MARK: voiceErrorDisplayText（消费点展示）

    func testDisplayTextRedeemAppendsReset() {
        let text = voiceErrorDisplayText(error("quota_exceeded", details: [
            "resource": "tts_chars", "resetsAt": localMidnightISO(month: 11, day: 1),
        ]))
        XCTAssertEqual(text, "本月朗读额度已用完，11 月 1 日重置")
    }

    func testDisplayTextRedeemWithoutResetPointsToRedeemEntry() {
        let text = voiceErrorDisplayText(error("quota_exceeded", details: ["resource": "ise_calls"]))
        XCTAssertEqual(text, "本月跟读打分额度已用完，可在「设置 → 账号」用兑换码补足")
    }

    func testDisplayTextPassesThroughNonRedeemAndSilent() {
        XCTAssertEqual(voiceErrorDisplayText(error("banned")), "账号已被封禁")
        XCTAssertEqual(voiceErrorDisplayText(error("token_expired")), "")
        XCTAssertEqual(voiceErrorDisplayText(error("voice_text_too_long")), "")
    }

    // MARK: 工具

    /// 构造「本地时区当天」ISO 串（quotaResetText 用本地月日，测试不随时区漂移）。
    private func localMidnightISO(month: Int, day: Int) -> String {
        var components = DateComponents()
        components.year = 2026
        components.month = month
        components.day = day
        components.hour = 0
        components.minute = 30
        let date = Calendar.current.date(from: components)!
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = .current
        return formatter.string(from: date)
    }
}
