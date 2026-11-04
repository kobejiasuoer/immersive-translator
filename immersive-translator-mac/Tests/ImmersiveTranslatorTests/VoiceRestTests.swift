import XCTest
import XfyunCore
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 语音 REST 单测（对齐 Windows voiceRest.test.ts 行为向量，假传输注入）：
// 请求体形状；402 信封 + 头补 remaining；401 文案；429 retryAfter 透传；非 JSON
// 按状态兜底不透传 body；ise 评分原形状（integrity 兜底 5、异常 words 过滤）；
// ise_disabled silent / banned appeal。
// ---------------------------------------------------------------------------

final class VoiceRestTests: XCTestCase {
    /// 记录请求的假传输：按调用顺序回放预设应答。
    private final class FakeTransport {
        var requests: [(method: String, path: String, body: String?)] = []
        private var responses: [AuthHttpResponse]
        private var index = 0

        init(_ responses: [AuthHttpResponse]) {
            self.responses = responses
        }

        func install() {
            VoiceGatewayRuntime.shared.install(http: { [weak self] method, path, body in
                guard let self else { throw VoiceError(code: "unknown", message: "gone") }
                self.requests.append((method, path, body))
                defer { self.index += 1 }
                return self.responses[min(self.index, self.responses.count - 1)]
            })
        }
    }

    override func tearDown() {
        VoiceGatewayRuntime.shared.resetForTests()
        super.tearDown()
    }

    private func envelope(_ code: String, message: String = "m", details: String = "{}") -> String {
        "{\"error\":{\"code\":\"\(code)\",\"message\":\"\(message)\",\"details\":\(details)}}"
    }

    // MARK: asr 请求体形状 + 成功解析

    func testTranscribeBatchRequestShapeAndResponse() async throws {
        let fake = FakeTransport([AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: "{\"text\":\"你好\",\"durationMs\":1695}")])
        fake.install()
        let result = try await transcribeBatch(lang: .zh_cn, pcmBase64: "QUJD")
        XCTAssertEqual(result.text, "你好")
        XCTAssertEqual(result.durationMs, 1695)
        // 请求体：POST /v1/voice/asr {lang, audio}
        XCTAssertEqual(fake.requests.count, 1)
        XCTAssertEqual(fake.requests[0].method, "POST")
        XCTAssertEqual(fake.requests[0].path, "/v1/voice/asr")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(fake.requests[0].body?.data(using: .utf8))) as? [String: Any])
        XCTAssertEqual(body["lang"] as? String, "zh_cn")
        XCTAssertEqual(body["audio"] as? String, "QUJD")
        // 与 JSON.stringify({lang, audio}) 逐字一致（键序、base64 的「/」不转义）。
        XCTAssertEqual(fake.requests[0].body, "{\"lang\":\"zh_cn\",\"audio\":\"QUJD\"}")
        let fake3 = FakeTransport([AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: "{\"text\":\"x\"}")])
        fake3.install()
        _ = try await transcribeBatch(lang: .en_us, pcmBase64: "+/8=")
        XCTAssertEqual(fake3.requests[0].body, "{\"lang\":\"en_us\",\"audio\":\"+/8=\"}")
        // durationMs 缺失 → nil
        let fake2 = FakeTransport([AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: "{\"text\":\"hi\"}")])
        fake2.install()
        let result2 = try await transcribeBatch(lang: .en_us, pcmBase64: "QQ==")
        XCTAssertEqual(result2.text, "hi")
        XCTAssertNil(result2.durationMs)
    }

    // MARK: 402 信封 + 头补 remaining

    func testQuota402CarriesHeaderBackfilledRemaining() async {
        let fake = FakeTransport([AuthHttpResponse(
            status: 402,
            retryAfterSeconds: nil,
            body: envelope("quota_exceeded", details: "{\"resource\":\"asr_seconds\"}"),
            headers: ["x-quota-asr_seconds-remaining": "3"]
        )])
        fake.install()
        do {
            _ = try await transcribeBatch(lang: .en_us, pcmBase64: "QQ==")
            XCTFail("402 应抛错")
        } catch let error as VoiceError {
            XCTAssertEqual(error.code, "quota_exceeded")
            XCTAssertEqual((error.details["remaining"] as? Double), 3, "信封缺 remaining 时从头补")
            // §二映射：口语识别额度用完 + redeem 动作。
            let info = voiceErrorMessage(error)
            XCTAssertEqual(info.text, "本月口语识别额度已用完")
            XCTAssertEqual(info.action, .redeem)
        } catch {
            XCTFail("应为 VoiceError: \(error)")
        }
    }

    // MARK: 401 文案（unauthorized 归一）

    func testUnauthorized401MapsToReloginText() async {
        let fake = FakeTransport([AuthHttpResponse(status: 401, retryAfterSeconds: nil, body: "<html>401</html>")])
        fake.install()
        do {
            _ = try await transcribeBatch(lang: .en_us, pcmBase64: "QQ==")
            XCTFail("401 应抛错")
        } catch let error as VoiceError {
            XCTAssertEqual(error.code, "unauthorized")
            XCTAssertEqual(voiceErrorMessage(error).text, "登录已失效，请重新登录")
        } catch {
            XCTFail("应为 VoiceError: \(error)")
        }
    }

    // MARK: 429 retryAfter 透传

    func testRateLimited429PassesRetryAfter() async {
        let fake = FakeTransport([AuthHttpResponse(
            status: 429,
            retryAfterSeconds: 13,
            body: envelope("rate_limited")
        )])
        fake.install()
        do {
            _ = try await evaluatePronunciation(refText: "Hi", lang: .en, pcmBase64: "QQ==")
            XCTFail("429 应抛错")
        } catch let error as VoiceError {
            XCTAssertEqual(error.code, "rate_limited")
            XCTAssertEqual(error.retryAfterSeconds, 13)
        } catch {
            XCTFail("应为 VoiceError: \(error)")
        }
    }

    // MARK: 非 JSON 按状态兜底，不透传 body

    func testNonJsonBodyFallsBackByStatusWithoutLeakingBody() async {
        let fake = FakeTransport([AuthHttpResponse(status: 502, retryAfterSeconds: nil, body: "<html>Bad Gateway</html>")])
        fake.install()
        do {
            _ = try await transcribeBatch(lang: .en_us, pcmBase64: "QQ==")
            XCTFail("502 应抛错")
        } catch let error as VoiceError {
            XCTAssertEqual(error.code, "upstream_error")
            XCTAssertEqual(voiceErrorMessage(error).text, "服务暂时不可用，正在重试")
            XCTAssertFalse(voiceErrorMessage(error).text.contains("Bad Gateway"))
        } catch {
            XCTFail("应为 VoiceError: \(error)")
        }
        // 4xx 非 JSON → unknown 兜底文案。
        let fake400 = FakeTransport([AuthHttpResponse(status: 400, retryAfterSeconds: nil, body: "<html>bad request</html>")])
        fake400.install()
        do {
            _ = try await transcribeBatch(lang: .en_us, pcmBase64: "QQ==")
            XCTFail("400 应抛错")
        } catch let error as VoiceError {
            XCTAssertEqual(error.code, "unknown")
            XCTAssertEqual(voiceErrorMessage(error).text, "服务暂时不可用，请稍后再试")
        } catch {
            XCTFail("应为 VoiceError: \(error)")
        }
    }

    // MARK: ise 评分形状

    func testEvaluatePronunciationRequestShapeAndResult() async throws {
        // 对齐 Windows「请求体 {refText, lang, audio}；评分 JSON 原形状返回（5 分制）」。
        let payload = """
        {"total":4.5,"accuracy":4.6,"fluency":4.2,"standard":4.4,"integrity":4.8,"isRejected":false,"exceptInfo":null,
         "words":[
           {"content":"hello","totalScore":92,"dpMessage":0,
            "sylls":[{"content":"hh","syllScore":90,"serrMsg":0,"phones":[{"content":"hh","dpMessage":-1,"gwpp":2}]}]},
           {"content":"hi","totalScore":88}
         ]}
        """
        let fake = FakeTransport([AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: payload)])
        fake.install()
        let result = try await evaluatePronunciation(refText: "hello hi", lang: .en, pcmBase64: "QUJD")
        XCTAssertEqual(fake.requests[0].method, "POST")
        XCTAssertEqual(fake.requests[0].path, "/v1/voice/ise")
        // 请求体与 JSON.stringify({refText, lang, audio}) 逐字一致（键序相同）。
        XCTAssertEqual(fake.requests[0].body, "{\"refText\":\"hello hi\",\"lang\":\"en\",\"audio\":\"QUJD\"}")
        XCTAssertEqual(result.total, 4.5)
        XCTAssertFalse(result.isRejected)
        XCTAssertEqual(result.pronunciation.accuracy, 4.6)
        XCTAssertEqual(result.pronunciation.fluency, 4.2)
        XCTAssertEqual(result.pronunciation.standard, 4.4)
        XCTAssertEqual(result.pronunciation.integrity, 4.8, "下发 integrity 原样")
        XCTAssertNil(result.pronunciation.exceptInfo)
        XCTAssertEqual(result.pronunciation.words.count, 2)
        XCTAssertEqual(result.pronunciation.words[0].sylls[0].phones[0].content, "hh")
        XCTAssertEqual(result.pronunciation.words[0].sylls[0].phones[0].dpMessage, -1)
        XCTAssertEqual(result.pronunciation.words[0].sylls[0].phones[0].gwpp, 2)
        XCTAssertEqual(result.pronunciation.words[0].sylls[0].syllScore, 90)
        XCTAssertEqual(result.pronunciation.words[1].sylls, [])
        XCTAssertEqual(result.pronunciation.words[1].dpMessage, 0, "dpMessage 缺失兜底 0")
    }

    func testIntegrityFallbackFiveWhenGatewayOmitsIt() async throws {
        // 网关不下发 integrity：句级兜底 5（同本地解析器）。
        let fake = FakeTransport([AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: "{\"total\":3,\"words\":[]}")])
        fake.install()
        let result = try await evaluatePronunciation(refText: "hi", lang: .en, pcmBase64: "QUJD")
        XCTAssertEqual(result.pronunciation.integrity, 5)
        XCTAssertEqual(result.total, 3)
        XCTAssertEqual(result.pronunciation.accuracy, 0, "缺失分项兜底 0")
    }

    func testMalformedWordsFilteredWithoutThrowing() async throws {
        // 对齐 Windows「形状异常的 words 条目被过滤，不抛错」：content 非串 / totalScore
        // 非数 / 非对象剔除；content 为空串仍是字符串（JS typeof 口径）保留。
        let payload = """
        {"total":3,"words":[{"content":"ok","totalScore":80},"junk",null,{},
          {"content":"bad","totalScore":"x"},{"content":"flag","totalScore":true},
          {"content":"","totalScore":1},{"content":"s","totalScore":2,"sylls":[{"content":42},{"content":"y","phones":[{"content":7},{"content":"p"}]}]}]}
        """
        let fake = FakeTransport([AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: payload)])
        fake.install()
        let result = try await evaluatePronunciation(refText: "hi", lang: .en, pcmBase64: "QUJD")
        XCTAssertEqual(result.pronunciation.words.map(\.content), ["ok", "", "s"])
        XCTAssertEqual(result.pronunciation.words[2].sylls.map(\.content), ["y"], "音节 content 非串剔除")
        XCTAssertEqual(result.pronunciation.words[2].sylls[0].phones.map(\.content), ["p"], "音素 content 非串剔除")
    }

    func testIseRejectedFlagAndExceptInfo() async throws {
        let payload = """
        {"total":0,"accuracy":0,"fluency":0,"standard":0,"isRejected":true,"exceptInfo":"28673","words":[]}
        """
        let fake = FakeTransport([AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: payload)])
        fake.install()
        let result = try await evaluatePronunciation(refText: "Hi", lang: .en, pcmBase64: "QQ==")
        XCTAssertTrue(result.isRejected)
        XCTAssertEqual(result.pronunciation.exceptInfo, "28673")
    }

    // MARK: 错误码动作位

    func testIseDisabledSilentAndBannedAppeal() async {
        // 对齐 Windows「403 ise_disabled → silent（隐藏评测入口），banned → 前往申诉」：
        // 走真实 evaluatePronunciation 传输链路，信封 code 原样归一。
        let fake = FakeTransport([
            AuthHttpResponse(status: 403, retryAfterSeconds: nil, body: envelope("ise_disabled", message: "发音评测暂未开放")),
            AuthHttpResponse(status: 403, retryAfterSeconds: nil, body: envelope("banned", message: "账号已被封禁")),
        ])
        fake.install()
        do {
            _ = try await evaluatePronunciation(refText: "hi", lang: .en, pcmBase64: "QUJD")
            XCTFail("403 应抛错")
        } catch let error as VoiceError {
            let mapped = voiceErrorMessage(error)
            XCTAssertEqual(mapped.kind, .silent)
            XCTAssertEqual(mapped.text, "")
        } catch {
            XCTFail("应为 VoiceError: \(error)")
        }
        do {
            _ = try await evaluatePronunciation(refText: "hi", lang: .en, pcmBase64: "QUJD")
            XCTFail("403 应抛错")
        } catch let error as VoiceError {
            XCTAssertEqual(voiceErrorMessage(error).action, .appeal)
            XCTAssertEqual(voiceErrorMessage(error).text, "账号已被封禁")
        } catch {
            XCTFail("应为 VoiceError: \(error)")
        }
    }

    func testIseResponseNotJsonThrowsUnknown() async {
        let fake = FakeTransport([AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: "not json")])
        fake.install()
        do {
            _ = try await evaluatePronunciation(refText: "Hi", lang: .en, pcmBase64: "QQ==")
            XCTFail("非 JSON 2xx 应抛错")
        } catch let error as VoiceError {
            XCTAssertEqual(error.code, "unknown")
        } catch {
            XCTFail("应为 VoiceError: \(error)")
        }
    }
}
