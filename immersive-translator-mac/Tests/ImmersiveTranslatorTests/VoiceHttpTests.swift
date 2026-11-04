import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 语音网关 HTTP 公共层单测（对齐 Windows voiceRest.test.ts 的传输断言 + Rust
// voice.rs tests + auth.rs quota_header_whitelist_only_passes_x_quota）：
// method/path 白名单（非 GET/POST 拒、/v1/voice/ 外 / ".." 穿越拒、大小写归一
// 放行）；错误信封解析与 HTTP 状态兜底；402 从 x-quota-* 头补 remaining；
// x-quota-* 之外响应头不出传输层；buildWsUrl http→ws。
// ---------------------------------------------------------------------------

final class VoiceHttpTests: XCTestCase {
    override func tearDown() {
        VoiceGatewayRuntime.shared.resetForTests()
        super.tearDown()
    }

    // MARK: 白名单（voice.rs 同规则）

    func testWhitelistAcceptsKnownVoicePathsAndMethods() {
        for (method, path) in [
            ("POST", "/v1/voice/ticket"),
            ("POST", "/v1/voice/asr"),
            ("POST", "/v1/voice/ise"),
            ("GET", "/v1/voice/quota"),
            ("get", "/v1/voice/asr"), // 大小写归一
        ] {
            XCTAssertNoThrow(try VoiceRequestValidator.validate(method: method, path: path), "\(method) \(path) 应放行")
        }
    }

    func testWhitelistRejectsMethodsOutsideTransportType() {
        for method in ["DELETE", "PUT", "PATCH", ""] {
            XCTAssertThrowsError(try VoiceRequestValidator.validate(method: method, path: "/v1/voice/asr")) { error in
                XCTAssertEqual((error as? VoiceError)?.code, "voice_request_invalid", method)
            }
        }
    }

    func testWhitelistRejectsPathsOutsideVoiceNamespace() {
        for path in ["/v1/auth/login", "/v1/voice", "/v1/sync/vocab/pull", "/v1/voice/../../auth", "v1/voice/asr"] {
            XCTAssertThrowsError(try VoiceRequestValidator.validate(method: "POST", path: path)) { error in
                XCTAssertEqual((error as? VoiceError)?.code, "voice_request_invalid", path)
            }
        }
    }

    func testVoiceRequestUnwiredThrowsProgrammingError() async {
        VoiceGatewayRuntime.shared.resetForTests()
        do {
            _ = try await voiceRequest(method: "POST", path: "/v1/voice/ticket")
            XCTFail("未接线应抛编程错误")
        } catch {
            XCTAssertEqual((error as? VoiceError)?.code, "voice_request_invalid")
        }
    }

    func testVoiceRequestPassesArgsThroughAndReturnsResponseVerbatim() async throws {
        // 对齐 Windows voiceRuntimeIpc.test.ts「接线后逐参透传 + 应答原样带回；无 body 落 null」。
        var seen: [(String, String, String?)] = []
        VoiceGatewayRuntime.shared.install(http: { method, path, body in
            seen.append((method, path, body))
            return AuthHttpResponse(status: 402, retryAfterSeconds: 9, body: "{\"x\":1}", headers: ["x-quota-tts_chars-remaining": "0"])
        })
        let response = try await voiceRequest(method: "POST", path: "/v1/voice/asr", bodyJson: "{\"lang\":\"en_us\"}")
        XCTAssertEqual(seen.count, 1)
        XCTAssertEqual(seen[0].0, "POST")
        XCTAssertEqual(seen[0].1, "/v1/voice/asr")
        XCTAssertEqual(seen[0].2, "{\"lang\":\"en_us\"}")
        XCTAssertEqual(response.status, 402, "非 2xx 是协议数据不是错误：原样带回")
        XCTAssertEqual(response.retryAfterSeconds, 9)
        XCTAssertEqual(response.body, "{\"x\":1}")
        XCTAssertEqual(response.headers, ["x-quota-tts_chars-remaining": "0"])
        _ = try await voiceRequest(method: "POST", path: "/v1/voice/ticket")
        XCTAssertNil(seen[1].2, "无 body 落 nil")
        // 白名单外路径在发出前就被拒（不触达传输层）。
        do {
            _ = try await voiceRequest(method: "POST", path: "/v1/auth/refresh")
            XCTFail("白名单外应拒")
        } catch {
            XCTAssertEqual((error as? VoiceError)?.code, "voice_request_invalid")
        }
        XCTAssertEqual(seen.count, 2)
    }

    // MARK: 信封解析与状态兜底

    func testErrorEnvelopeParsedWithDetailsAndRetryAfter() {
        let error = errorFromHttpResponse(
            429,
            body: "{\"error\":{\"code\":\"rate_limited\",\"message\":\"m\",\"details\":{}}}",
            retryAfterSeconds: 7
        )
        XCTAssertEqual(error.code, "rate_limited")
        XCTAssertEqual(error.retryAfterSeconds, 7)
    }

    func testStatusFallbackWhenEnvelopeMissingOrNotJson() {
        XCTAssertEqual(errorFromHttpResponse(401, body: "<html>", retryAfterSeconds: nil, headers: [:]).code, "unauthorized")
        XCTAssertEqual(errorFromHttpResponse(402, body: "{\"no\":\"envelope\"}", retryAfterSeconds: nil, headers: [:]).code, "quota_exceeded")
        XCTAssertEqual(errorFromHttpResponse(429, body: "", retryAfterSeconds: nil, headers: [:]).code, "rate_limited")
        XCTAssertEqual(errorFromHttpResponse(502, body: "Bad Gateway", retryAfterSeconds: nil, headers: [:]).code, "upstream_error")
        XCTAssertEqual(errorFromHttpResponse(418, body: "teapot", retryAfterSeconds: nil, headers: [:]).code, "unknown")
        // 空 code 也走状态兜底
        XCTAssertEqual(errorFromHttpResponse(402, body: "{\"error\":{\"code\":\"\",\"message\":\"m\"}}", retryAfterSeconds: nil, headers: [:]).code, "quota_exceeded")
    }

    func testQuota402BackfillsRemainingFromHeader() {
        // details 有 resource 无 remaining → 专属头补值。
        let error = errorFromHttpResponse(
            402,
            body: "{\"error\":{\"code\":\"quota_exceeded\",\"message\":\"m\",\"details\":{\"resource\":\"tts_chars\"}}}",
            retryAfterSeconds: nil,
            headers: ["x-quota-tts_chars-remaining": "0", "retry-after": "9"]
        )
        XCTAssertEqual(error.code, "quota_exceeded")
        XCTAssertEqual((error.details["remaining"] as? Double), 0)
        // details 无 resource → 任一 x-quota-* 头兜底。
        let fallback = errorFromHttpResponse(
            402,
            body: "{\"error\":{\"code\":\"quota_exceeded\",\"message\":\"m\",\"details\":{}}}",
            retryAfterSeconds: nil,
            headers: ["x-quota-asr_seconds-remaining": "12"]
        )
        XCTAssertEqual((fallback.details["remaining"] as? Double), 12)
        // details 已带 remaining → 不从头覆盖。
        let present = errorFromHttpResponse(
            402,
            body: "{\"error\":{\"code\":\"quota_exceeded\",\"message\":\"m\",\"details\":{\"remaining\": 5}}}",
            retryAfterSeconds: nil,
            headers: ["x-quota-tts_chars-remaining": "0"]
        )
        XCTAssertEqual((present.details["remaining"] as? Double), 5)
        // 头值非数字 → 不补。
        let nan = errorFromHttpResponse(
            402,
            body: "{\"error\":{\"code\":\"quota_exceeded\",\"message\":\"m\",\"details\":{}}}",
            retryAfterSeconds: nil,
            headers: ["x-quota-tts_chars-remaining": "abc"]
        )
        XCTAssertNil(nan.details["remaining"])
    }

    // MARK: 响应头白名单（对齐 Rust quota_header_whitelist_only_passes_x_quota）

    func testQuotaHeaderWhitelistOnlyPassesXQuota() {
        let raw: [AnyHashable: Any] = [
            "x-quota-tts_chars-remaining": "0",
            "X-Quota-ASR_seconds-Remaining": "12",
            "retry-after": "7",
            "x-internal-flag": "secret",
        ]
        let picked = URLSessionAuthTransport.whitelistQuotaHeaders(raw)
        XCTAssertEqual(picked.count, 2, "白名单外头必须全部滤除: \(picked)")
        XCTAssertEqual(picked["x-quota-tts_chars-remaining"], "0")
        XCTAssertEqual(picked["x-quota-asr_seconds-remaining"], "12", "键统一小写")
        XCTAssertNil(picked["retry-after"])
        XCTAssertNil(picked["x-internal-flag"])
    }

    // MARK: WSS URL 拼装

    func testBuildWsUrlHttpToWs() throws {
        VoiceGatewayRuntime.shared.install(http: nil, baseUrlSource: { "http://127.0.0.1:8090" })
        XCTAssertEqual(
            try buildWsUrl(path: "/v1/voice/tts/stream", query: [(key: "ticket", value: "t1")]),
            "ws://127.0.0.1:8090/v1/voice/tts/stream?ticket=t1"
        )
        XCTAssertEqual(
            try buildWsUrl(path: "/v1/voice/asr/stream", query: [(key: "ticket", value: "a b"), (key: "lang", value: "en_us")]),
            "ws://127.0.0.1:8090/v1/voice/asr/stream?ticket=a%20b&lang=en_us"
        )
        VoiceGatewayRuntime.shared.install(http: nil, baseUrlSource: { "https://cloud.example.com/" })
        XCTAssertEqual(
            try buildWsUrl(path: "/v1/voice/tts/stream", query: [(key: "ticket", value: "t")]),
            "wss://cloud.example.com/v1/voice/tts/stream?ticket=t"
        )
    }

    func testBuildWsUrlThrowsWhenBaseMissing() {
        VoiceGatewayRuntime.shared.install(http: nil, baseUrlSource: { nil })
        XCTAssertThrowsError(try buildWsUrl(path: "/x", query: [])) { error in
            XCTAssertEqual((error as? VoiceError)?.code, "voice_not_configured")
        }
    }

    // MARK: requireOkJson

    func testRequireOkJson() throws {
        let ok = AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: "{\"ticket\":\"t\"}")
        XCTAssertEqual(try requireOkJson(ok)["ticket"] as? String, "t")
        let badStatus = AuthHttpResponse(status: 402, retryAfterSeconds: nil, body: "{\"error\":{\"code\":\"quota_exceeded\",\"message\":\"m\"}}")
        XCTAssertThrowsError(try requireOkJson(badStatus)) { error in
            XCTAssertEqual((error as? VoiceError)?.code, "quota_exceeded")
        }
        let notJson = AuthHttpResponse(status: 200, retryAfterSeconds: nil, body: "nope")
        XCTAssertThrowsError(try requireOkJson(notJson)) { error in
            XCTAssertEqual((error as? VoiceError)?.code, "unknown", "2xx 非 JSON 按兜底")
        }
    }
}
