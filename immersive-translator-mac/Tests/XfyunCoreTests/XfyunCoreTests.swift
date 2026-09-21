import XCTest
@testable import XfyunCore

/// 讯飞底座（P3）：鉴权 / TTS 请求帧与缓存 / IAT 解析 / ISE 解析与词对齐。

final class XfyunCoreTests: XCTestCase {
    // MARK: - 鉴权

    func testBuildAuthURLContainsSignedParams() {
        let creds = XfyunCredentials(appId: "app", apiKey: "key123", apiSecret: "secret456")
        let url = XfyunAuth.buildAuthURL(host: "tts-api.xfyun.cn", path: "/v2/tts", creds: creds, now: Date(timeIntervalSince1970: 1_700_000_000))
        XCTAssertTrue(url.hasPrefix("wss://tts-api.xfyun.cn/v2/tts?"))
        XCTAssertTrue(url.contains("authorization="))
        XCTAssertTrue(url.contains("date="))
        XCTAssertTrue(url.contains("host=tts-api.xfyun.cn"))
        // date 是 RFC1123 GMT
        XCTAssertTrue(url.contains("GMT"))
    }

    func testAuthSignatureDeterministic() {
        let creds = XfyunCredentials(appId: "a", apiKey: "k", apiSecret: "s")
        let d = Date(timeIntervalSince1970: 1_789_500_000_000 / 1000)
        let u1 = XfyunAuth.buildAuthURL(host: "ise-api.xfyun.cn", path: "/v2/open-ise", creds: creds, now: d)
        let u2 = XfyunAuth.buildAuthURL(host: "ise-api.xfyun.cn", path: "/v2/open-ise", creds: creds, now: d)
        XCTAssertEqual(u1, u2)
    }

    // MARK: - TTS

    func testBuildTtsRequestFrame() throws {
        let frame = buildTtsRequestFrame(appId: "app1", text: "你好 world", opts: XfyunTtsOptions(vcn: "xiaoyan", volume: 60))
        let obj = try XCTUnwrap(XfyunJSON.parse(frame))
        XCTAssertEqual((obj["common"] as? [String: Any])?["app_id"] as? String, "app1")
        let business = try XCTUnwrap(obj["business"] as? [String: Any])
        XCTAssertEqual(business["aue"] as? String, "lame")
        XCTAssertEqual(business["sfl"] as? Int, 1)
        XCTAssertEqual(business["vcn"] as? String, "xiaoyan")
        XCTAssertEqual(business["speed"] as? Int, 50)  // 恒 1×，变速在播放端
        XCTAssertEqual(business["volume"] as? Int, 60)
        let data = try XCTUnwrap(obj["data"] as? [String: Any])
        XCTAssertEqual(data["status"] as? Int, 2)
        let decoded = Data(base64Encoded: (data["text"] as? String) ?? "")
        XCTAssertEqual(String(data: decoded ?? Data(), encoding: .utf8), "你好 world")
    }

    func testTtsCacheKeyExcludesRate() {
        let a = ttsCacheKey(text: "hello", opts: XfyunTtsOptions(vcn: "xiaoyan", volume: 50))
        let b = ttsCacheKey(text: "hello", opts: XfyunTtsOptions(vcn: "xiaoyan", volume: 50))
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, ttsCacheKey(text: "world", opts: XfyunTtsOptions(vcn: "xiaoyan", volume: 50)))
        XCTAssertNotEqual(a, ttsCacheKey(text: "hello", opts: XfyunTtsOptions(vcn: "catherine", volume: 50)))
    }

    func testTtsLruCacheEviction() {
        let cache = TtsLruCache(limit: 3)
        cache.set("a", Data([1]))
        cache.set("b", Data([2]))
        cache.set("c", Data([3]))
        XCTAssertEqual(cache.count, 3)
        _ = cache.get("a")  // 刷新 a 的位置
        cache.set("d", Data([4]))  // 挤掉最旧的 b
        XCTAssertEqual(cache.count, 3)
        XCTAssertNil(cache.get("b"))
        XCTAssertNotNil(cache.get("a"))
        XCTAssertNotNil(cache.get("d"))
    }

    func testLooksChinese() {
        XCTAssertTrue(XfyunTts.looksChinese("这是中文句子"))
        XCTAssertFalse(XfyunTts.looksChinese("This is an English sentence"))
    }

    // MARK: - IAT 解析

    func testExtractIatSegment() {
        let payload: [String: Any] = [
            "code": 0,
            "data": [
                "result": [
                    "sn": 2,
                    "ws": [
                        ["cw": [["w": "你"]]],
                        ["cw": [["w": "好"]]],
                    ],
                ],
                "status": 2,
            ],
        ]
        let seg = extractIatSegment(payload: payload)
        XCTAssertEqual(seg?.sn, 2)
        XCTAssertEqual(seg?.text, "你好")
        // 非结果消息
        XCTAssertNil(extractIatSegment(payload: ["code": 0, "data": ["status": 1]]))
    }

    func testMergeIatSegmentsSortsBySn() {
        let merged = mergeIatSegments([3: "!", 1: "hello ", 2: "world"])
        XCTAssertEqual(merged, "hello world!")
    }

    func testIatFrames() {
        let first = buildIatFirstFrame(language: .zh_cn)
        let obj = XfyunJSON.parse(first)!
        let business = obj["business"] as! [String: Any]
        XCTAssertEqual(business["sub"] as? String, "iat")
        XCTAssertEqual(business["language"] as? String, "zh_cn")

        let audio = buildIatAudioFrame(Data([0x01, 0x02]))
        let aobj = XfyunJSON.parse(audio)!
        let adata = aobj["data"] as! [String: Any]
        XCTAssertEqual(adata["status"] as? Int, 1)
        XCTAssertEqual((adata["audio"] as! String), "AQI=")

        let end = XfyunJSON.parse(buildIatEndFrame())!
        XCTAssertEqual((end["data"] as! [String: Any])["status"] as? Int, 2)
    }

    // MARK: - ISE 解析

    private let sampleXml = """
    <?xml version="1.0" encoding="UTF-8"?>
    <xml_result>
      <read_chapter except_info="0" is_rejected="false" total_score="4.5" />
      <rec_paper>
        <sentence content="the cat sat" total_score="4.2" accuracy_score="4.0" fluency_score="4.4" standard_score="4.1">
          <word content="the" total_score="5" dp_message="0">
            <syll content="the" syll_score="5" serr_msg="0">
              <phone content="dh" dp_message="0" gwpp="0.1" />
            </syll>
          </word>
          <word content="cat" total_score="3" dp_message="0"/>
          <word content="sat" total_score="2" dp_message="0"/>
          <word content="xx" total_score="0" dp_message="32"/>
        </sentence>
      </rec_paper>
    </xml_result>
    """

    func testParseIseXml() {
        let result = parseIseXml(sampleXml)
        XCTAssertEqual(result.total, 4.2, accuracy: 0.001)
        XCTAssertEqual(result.accuracy, 4.0, accuracy: 0.001)
        XCTAssertFalse(result.isRejected)
        XCTAssertNil(result.exceptInfo)
        XCTAssertEqual(result.words.count, 4)
        XCTAssertEqual(result.words[0].content, "the")
        XCTAssertEqual(result.words[0].sylls.count, 1)
        XCTAssertEqual(result.words[0].sylls[0].phones[0].content, "dh")
        XCTAssertEqual(result.words[3].dpMessage, 32)
    }

    func testParseIseXmlRejectedFallsBackToSentenceAttrs() {
        let xml = """
        <xml_result><read_chapter except_info="28673" is_rejected="true"/>
        <sentence content="a" total_score="1.0" accuracy_score="1" fluency_score="1" standard_score="1">
        <word content="a" total_score="1" dp_message="0"/></sentence></xml_result>
        """
        let result = parseIseXml(xml)
        XCTAssertTrue(result.isRejected)
        XCTAssertEqual(result.exceptInfo, "28673")
        XCTAssertEqual(result.total, 1.0, accuracy: 0.001)
    }

    func testMapWordsToTextRepeatedWords() {
        // 重复词（the ... the）：贪心会把第二个识别词配给第一个原文词；DP 保序对齐。
        let text = "the cat saw the bird"
        let words = [
            WordScore(content: "the", totalScore: 5, dpMessage: 0),
            WordScore(content: "cat", totalScore: 4.5, dpMessage: 0),
            WordScore(content: "saw", totalScore: 3.5, dpMessage: 0),
            WordScore(content: "the", totalScore: 2.0, dpMessage: 0),  // 第二个 the 是低分
            WordScore(content: "bird", totalScore: 5, dpMessage: 0),
        ]
        let marks = mapWordsToText(text: text, words: words)
        XCTAssertEqual(marks.count, 5)
        // 最后一个 the（原文第二个 the）应为 bad（2 分）
        let secondThe = marks.first { m in
            let range = text.index(text.startIndex, offsetBy: m.start)..<text.index(text.startIndex, offsetBy: m.end)
            return text[range] == "the" && m.start > 10
        }
        XCTAssertEqual(secondThe?.quality, .bad)
    }

    func testMapWordsToTextMissedAndInserted() {
        let text = "hello world"
        let words = [
            WordScore(content: "hello", totalScore: 5, dpMessage: 0),
            WordScore(content: "world", totalScore: 0, dpMessage: 16),  // 漏读
            WordScore(content: "extra", totalScore: 5, dpMessage: 32),  // 增读：不对齐
        ]
        let marks = mapWordsToText(text: text, words: words)
        XCTAssertEqual(marks.count, 2)
        XCTAssertEqual(marks[0].quality, .good)
        XCTAssertEqual(marks[1].quality, .missed)
    }

    func testIsIsePass() {
        let good = PronunciationResult(total: 4.3, accuracy: 4, fluency: 4, standard: 4, isRejected: false, exceptInfo: nil, words: [])
        XCTAssertTrue(isIsePass(good, passScore: 4.2))
        XCTAssertFalse(isIsePass(good, passScore: 4.5))
        let rejected = PronunciationResult(total: 5, accuracy: 5, fluency: 5, standard: 5, isRejected: true, exceptInfo: nil, words: [])
        XCTAssertFalse(isIsePass(rejected, passScore: 3))
    }

    func testFloatToPcm16Bytes() {
        let data = floatToPcm16Bytes([0, 1, -1, 0.5])
        XCTAssertEqual(data.count, 8)
        let le16: (Int) -> Int = { off in Int(data[data.startIndex + off]) | (Int(data[data.startIndex + off + 1]) << 8) }
        XCTAssertEqual(le16(0), 0)
        XCTAssertEqual(le16(2), 32767)
        XCTAssertEqual(le16(4), -32768 & 0xFFFF)  // Int16 -1 → 0xFFFF
        XCTAssertEqual(le16(6), 16383)  // 0.5 * 32767
    }

    func testIseFrames() throws {
        // 首帧手动拼 JSON（Foundation 解码会剥 BOM，不能 JSON roundtrip 验证 text）
        let raw = buildIseFirstFrame(appId: "app", text: "read this")
        XCTAssertTrue(raw.hasPrefix(#"{"business":{"aue":"raw","#))
        XCTAssertTrue(raw.contains("[content]"))
        XCTAssertTrue(raw.hasPrefix("{\"business\":{\"aue\":\"raw\",\"auf\":\"audio/L16;rate=16000\",\"category\":\"read_sentence\",\"cmd\":\"ssb\",\"ent\":\"en_vip\",\"sub\":\"ise\",\"ttp_skip\":true,\"tte\":\"utf-8\",\"text\":\"\u{FEFF}[content]\\nread this\""))
        let first = try XCTUnwrap(XfyunJSON.parse(raw))
        let business = first["business"] as! [String: Any]
        XCTAssertEqual(business["category"] as? String, "read_sentence")
        XCTAssertEqual(business["aue"] as? String, "raw")

        let audio = XfyunJSON.parse(buildIseAudioFrame(Data([1]), first: true))!
        XCTAssertEqual((audio["business"] as! [String: Any])["aus"] as? Int, 1)
        let audio2 = XfyunJSON.parse(buildIseAudioFrame(Data([1]), first: false))!
        XCTAssertEqual((audio2["business"] as! [String: Any])["aus"] as? Int, 2)
        let end = XfyunJSON.parse(buildIseEndFrame())!
        XCTAssertEqual((end["business"] as! [String: Any])["aus"] as? Int, 4)
        XCTAssertEqual((end["data"] as! [String: Any])["status"] as? Int, 2)
    }

    // MARK: - 凭据模型

    func testCredentialsCompleteness() {
        XCTAssertFalse(XfyunCredentials().isComplete)
        XCTAssertFalse(XfyunCredentials(appId: "a", apiKey: "k", apiSecret: " ").isComplete)
        XCTAssertTrue(XfyunCredentials(appId: "a", apiKey: "k", apiSecret: "s").isComplete)
    }
}
