import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 能力下发解析单测（对齐 Windows src/lib/voice/voiceCapabilities.test.ts 行为
// 向量：完整 voice 段透传 / 缺段 available=false / quota 别名归一 / 异常条目
// 逐条过滤（label 缺失回落 id）/ getVoiceCapabilities 走注入的 me/config 通道、
// AuthError 原样抛）。
// ---------------------------------------------------------------------------

final class VoiceCapabilitiesTests: XCTestCase {
    override func tearDown() {
        VoiceGatewayRuntime.shared.resetForTests()
        super.tearDown()
    }

    private func capsJSON(
        voices: String = "[{\"id\":\"v1\",\"label\":\"音色一\"},{\"id\":\"v2\",\"label\":\"音色二\"}]",
        languages: String = "[\"en_us\",\"zh_cn\"]",
        iseEnabled: Bool = true,
        quota: String? = nil
    ) -> [String: Any] {
        var voice: [String: Any] = [
            "ttsVoices": jsonString(voices),
            "asrLanguages": jsonString(languages),
            "iseEnabled": iseEnabled,
        ]
        if let quota {
            voice["quota"] = jsonString(quota)
        }
        return ["voice": voice]
    }

    /// JSON 字符串再解析回对象（模拟服务端 JSON 结构，避免字面量里塞字符串对象）。
    private func jsonString(_ raw: String) -> Any {
        let data = raw.data(using: .utf8)!
        return try! JSONSerialization.jsonObject(with: data)
    }

    // MARK: 完整 voice 段透传

    func testFullSegmentPassthrough() {
        let caps = parseVoiceCapabilities(capsJSON(quota: "{\"tts\":{\"remaining\":10,\"allowance\":null,\"resetsAt\":\"2026-12-01T00:00:00.000Z\"}}"))
        XCTAssertTrue(caps.available)
        XCTAssertEqual(caps.ttsVoices.map(\.id), ["v1", "v2"])
        XCTAssertEqual(caps.ttsVoices.map(\.label), ["音色一", "音色二"])
        XCTAssertEqual(caps.asrLanguages, ["en_us", "zh_cn"])
        XCTAssertTrue(caps.iseEnabled)
        XCTAssertEqual(caps.quota?[.tts]?.remaining, 10)
        XCTAssertEqual(caps.quota?[.tts]?.resetsAt, "2026-12-01T00:00:00.000Z")
    }

    // MARK: 分语种 ASR 能力（300247a asrBatchLanguages/asrStreamingLanguages）

    func testAsrLanguagesSplitFieldsParseAndFallback() {
        // 新服务端：两字段都下发，按调用方式取。
        let split = parseVoiceCapabilities(capsJSON(
            voices: "[]",
            languages: "[\"en_us\"]",
            iseEnabled: true
        ))
        // 旧服务端（未下发）→ nil，asrLanguagesFor 回退 asrLanguages。
        XCTAssertNil(split.asrBatchLanguages)
        XCTAssertNil(split.asrStreamingLanguages)
        XCTAssertEqual(asrLanguagesFor(split, mode: .batch), ["en_us"])
        XCTAssertEqual(asrLanguagesFor(split, mode: .stream), ["en_us"])

        var voice = capsJSON()
        voice["voice"] = jsonString(
            "{\"ttsVoices\":[],\"asrLanguages\":[\"en_us\"],"
                + "\"asrBatchLanguages\":[\"en_us\",\"zh_cn\"],\"asrStreamingLanguages\":[],\"iseEnabled\":true}"
        )
        let parsed = parseVoiceCapabilities(voice)
        XCTAssertEqual(parsed.asrBatchLanguages, ["en_us", "zh_cn"])
        // 明确的空数组不回退（流式确实无可用语种）。
        XCTAssertEqual(parsed.asrStreamingLanguages, [])
        XCTAssertEqual(asrLanguagesFor(parsed, mode: .batch), ["en_us", "zh_cn"])
        XCTAssertTrue(asrLanguagesFor(parsed, mode: .stream).isEmpty)
    }

    // MARK: 缺 voice 段 → available=false 全空

    func testMissingSegmentGivesEmptyUnavailable() {
        XCTAssertEqual(parseVoiceCapabilities(nil), .empty)
        XCTAssertEqual(parseVoiceCapabilities([String: Any]()), .empty)
        let caps = parseVoiceCapabilities(["voice": NSNull()])
        XCTAssertFalse(caps.available)
        XCTAssertTrue(caps.ttsVoices.isEmpty)
        XCTAssertTrue(caps.asrLanguages.isEmpty)
        XCTAssertFalse(caps.iseEnabled)
        XCTAssertNil(caps.quota)
    }

    // MARK: quota 键别名归一（tts/tts_chars/asr/asr_seconds/ise/ise_calls）

    func testQuotaKeyAliases() {
        let caps = parseVoiceCapabilities(capsJSON(quota: """
        {"tts_chars":{"remaining":0},"asr_seconds":{"remaining":30,"resetsAt":"2026-11-30T16:00:00.000Z"},"ise_calls":{"remaining":8}}
        """))
        XCTAssertEqual(caps.quota?.count, 3)
        XCTAssertEqual(caps.quota?[.tts]?.remaining, 0)
        XCTAssertNil(caps.quota?[.tts]?.resetsAt)
        XCTAssertEqual(caps.quota?[.asr]?.remaining, 30)
        XCTAssertEqual(caps.quota?[.ise]?.remaining, 8)
        // 未知资源键被忽略；空对象 / 非对象值 → quota=nil
        XCTAssertNil(parseVoiceCapabilities(capsJSON(quota: "{\"llm_tokens\":{\"remaining\":1}}")).quota)
        XCTAssertNil(parseVoiceCapabilities(capsJSON(quota: "[1,2]")).quota)
        // quotaResourceKey：裸值 → 键 / 未知 null
        XCTAssertEqual(quotaResourceKey("tts_chars"), .tts)
        XCTAssertEqual(quotaResourceKey("asr_seconds"), .asr)
        XCTAssertEqual(quotaResourceKey("ise_calls"), .ise)
        XCTAssertEqual(quotaResourceKey("llm_tokens"), nil)
    }

    // MARK: 异常条目过滤

    func testMalformedEntriesFiltered() {
        let caps = parseVoiceCapabilities(capsJSON(
            voices: "[{\"id\":\"\",\"label\":\"无id\"},{\"label\":\"无id字段\"},{\"id\":\"plain\",\"label\":\"\"},42,{\"id\":\"ok\",\"label\":7}]",
            languages: "[\"en_us\",\"\",\"zh_cn\",42,null]"
        ))
        // label 缺失/非字符串回落 id；无 id 整条过滤。
        XCTAssertEqual(caps.ttsVoices, [VoiceTtsVoice(id: "plain", label: "plain"), VoiceTtsVoice(id: "ok", label: "ok")])
        XCTAssertEqual(caps.asrLanguages, ["en_us", "zh_cn"])
    }

    /// 数组容错与 Windows looseRecord（`typeof v === "object" && v !== null`）同口径：
    /// JS 数组也是 object——voice 段为数组判 available=true 全空；quota 条目为数组判
    /// 该项全 null；根为数组取不到 voice → 空能力；数组形音色条目取不到 id → 过滤。
    func testArraysTreatedAsLooseRecordsLikeWindows() {
        let arrayVoice = parseVoiceCapabilities(jsonString("{\"voice\":[]}"))
        XCTAssertEqual(
            arrayVoice,
            VoiceCapabilities(available: true, ttsVoices: [], asrLanguages: [], iseEnabled: false, quota: nil)
        )
        let filledArrayVoice = parseVoiceCapabilities(jsonString("{\"voice\":[{\"ttsVoices\":[{\"id\":\"v1\"}]}]}"))
        XCTAssertTrue(filledArrayVoice.available)
        XCTAssertTrue(filledArrayVoice.ttsVoices.isEmpty, "数组下标键取不到具名字段")

        XCTAssertEqual(parseVoiceCapabilities(jsonString("[{\"voice\":{\"iseEnabled\":true}}]")), .empty)

        let arrayEntry = parseVoiceCapabilities(jsonString("{\"voice\":{\"quota\":{\"tts\":[],\"asr\":7}}}"))
        XCTAssertEqual(arrayEntry.quota, [.tts: VoiceQuotaRemaining(remaining: nil, allowance: nil, resetsAt: nil)])

        let arrayItems = parseVoiceCapabilities(jsonString("{\"voice\":{\"ttsVoices\":[[\"v1\",\"一\"],{\"id\":\"v2\"}]}}"))
        XCTAssertEqual(arrayItems.ttsVoices, [VoiceTtsVoice(id: "v2", label: "v2")])
    }

    func testIseEnabledRequiresStrictBooleanTrue() {
        // 对齐 JS `voice.iseEnabled === true`：字符串 / 数值 1 都不算开。
        for raw in ["\"yes\"", "1", "null"] {
            let caps = parseVoiceCapabilities(jsonString("{\"voice\":{\"ttsVoices\":[],\"asrLanguages\":[],\"iseEnabled\":\(raw)}}"))
            XCTAssertFalse(caps.iseEnabled, raw)
            XCTAssertTrue(caps.available)
        }
        let on = parseVoiceCapabilities(jsonString("{\"voice\":{\"iseEnabled\":true}}"))
        XCTAssertTrue(on.iseEnabled)
        // 配额数值同样不认布尔（true 不当 1）。
        let quota = parseVoiceCapabilities(jsonString("{\"voice\":{\"quota\":{\"tts\":{\"remaining\":true,\"allowance\":500}}}}"))
        XCTAssertNil(quota.quota?[.tts]?.remaining)
        XCTAssertEqual(quota.quota?[.tts]?.allowance, 500)
    }

    // MARK: getVoiceCapabilities 走注入通道

    func testGetVoiceCapabilitiesUsesInjectedServerConfig() async throws {
        var calls = 0
        VoiceGatewayRuntime.shared.install(
            http: nil,
            serverConfig: {
                calls += 1
                return self.capsJSON()
            }
        )
        let caps = try await getVoiceCapabilities()
        XCTAssertTrue(caps.available)
        XCTAssertEqual(calls, 1)
    }

    func testGetVoiceCapabilitiesThrowsWhenNotWired() async {
        VoiceGatewayRuntime.shared.resetForTests()
        do {
            _ = try await getVoiceCapabilities()
            XCTFail("未接线应抛编程错误")
        } catch {
            // 期望：voice_request_invalid（编程错误伪码）
            XCTAssertEqual((error as? VoiceError)?.code, "voice_request_invalid")
        }
    }
}
