import XCTest
import ReaderCore

/// SentencePair.zhError 的 Codable 往返与老数据兼容——对齐 Windows
/// reader_store.rs zh_error_roundtrip_and_legacy_load（camelCase 键落盘、
/// nil 键不落盘、老数据无字段加载不报错）。契约：reading-room.schema.json
/// $defs/sentencePair.properties.zhError，可选字段，schemaVersion 维持 1。
final class SentencePairZhErrorTests: XCTestCase {
    private static let fallbackText = "翻译服务暂时不可用，请稍后点重试"

    /// 带 zhError 的句子往返保留；老数据（无 zhError 字段）解码不报错且为 nil；
    /// 序列化输出 camelCase 键、None 键不落盘。
    func testZhErrorRoundtripAndLegacyLoad() throws {
        XCTAssertEqual(readerSchemaVersion, 1, "可选字段不 bump schemaVersion")
        let legacy = """
        {
          "schemaVersion": 1,
          "articles": [{
            "id": "zh-error-a1",
            "title": "Tide",
            "titleCnState": "pending",
            "createdAt": 0,
            "lastReadAt": 0,
            "sentences": [
              {"idx": 0, "paragraphIdx": 0, "en": "One.", "zh": null, "zhState": "failed",
               "zhError": "\(Self.fallbackText)"},
              {"idx": 1, "paragraphIdx": 0, "en": "Two.", "zh": null, "zhState": "failed"}
            ]
          }]
        }
        """
        let file = try JSONDecoder().decode(ArticlesFile.self, from: Data(legacy.utf8))
        XCTAssertEqual(file.articles[0].sentences[0].zhError, Self.fallbackText)
        XCTAssertNil(
            file.articles[0].sentences[1].zhError,
            "老数据（无 zhError 字段）加载不报错且 zhError 为 nil"
        )

        let data = try ReaderFileCodec.encode(file)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let articles = try XCTUnwrap(obj["articles"] as? [[String: Any]])
        let sentences = try XCTUnwrap(articles[0]["sentences"] as? [[String: Any]])
        XCTAssertEqual(
            sentences[0]["zhError"] as? String,
            Self.fallbackText,
            "camelCase 键 zhError 落盘"
        )
        XCTAssertNil(sentences[1]["zhError"], "zhError 为 nil 时键不落盘（对齐 serde skip_serializing_if）")

        // 编码结果再解码一次：往返不丢。
        let redecoded = try JSONDecoder().decode(ArticlesFile.self, from: data)
        XCTAssertEqual(redecoded.articles[0].sentences[0].zhError, Self.fallbackText)
        XCTAssertNil(redecoded.articles[0].sentences[1].zhError)
    }

    /// init 默认值：不带 zhError 构造的句子字段为 nil（老调用点零破坏）。
    func testInitializerDefaultsZhErrorToNil() {
        let pair = SentencePair(idx: 0, paragraphIdx: 0, en: "One.", zhState: .failed)
        XCTAssertNil(pair.zhError)
        let withReason = SentencePair(
            idx: 1,
            paragraphIdx: 0,
            en: "Two.",
            zhState: .failed,
            zhError: Self.fallbackText
        )
        XCTAssertEqual(withReason.zhError, Self.fallbackText)
    }
}
