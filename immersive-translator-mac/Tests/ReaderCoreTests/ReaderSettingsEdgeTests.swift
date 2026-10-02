import XCTest
@testable import ReaderCore

/// Edge 第三引擎的设置面：TtsProvider.edge / edgeVoiceZh / edgeVoiceEn 的
/// 合并、坏值防御、老数据兼容与 patch 产出（对齐 readerTypes.ts 的 edge 字段）。

final class ReaderSettingsEdgeTests: XCTestCase {
    // MARK: - 默认引擎

    func testEdgeIsDefaultProvider() {
        // 对齐 Windows readerTypes.ts:289「设为默认」；本地兜底语义在播放引擎。
        XCTAssertEqual(ReaderSettings.default.ttsProvider, .edge)
        XCTAssertEqual(ReaderSettings.default.edgeVoiceZh, "")
        XCTAssertEqual(ReaderSettings.default.edgeVoiceEn, "")
        XCTAssertEqual(TtsProvider(rawValue: "edge"), .edge)
        XCTAssertEqual(TtsProvider.edge.label, "Edge 在线")
    }

    // MARK: - 合并

    func testMergeReaderSettingsAppliesEdgeFields() {
        var base = ReaderSettings.default
        base.ttsProvider = .local
        var override = ReaderSettingsOverride()
        override.ttsProvider = "edge"
        override.edgeVoiceZh = "zh-CN-YunxiNeural"
        override.edgeVoiceEn = "en-US-AndrewNeural"
        let merged = mergeReaderSettings(base, override)
        XCTAssertEqual(merged.ttsProvider, .edge)
        XCTAssertEqual(merged.edgeVoiceZh, "zh-CN-YunxiNeural")
        XCTAssertEqual(merged.edgeVoiceEn, "en-US-AndrewNeural")
    }

    func testMergeReaderSettingsRejectsBadProviderValue() {
        let base = ReaderSettings.default
        var override = ReaderSettingsOverride()
        override.ttsProvider = "foo"  // 坏值不落
        let merged = mergeReaderSettings(base, override)
        XCTAssertEqual(merged.ttsProvider, .edge)
    }

    func testLegacyOverrideWithoutEdgeFieldsKeepsDefaults() throws {
        // 老数据：JSON 只带旧字段 → edge 字段解码 nil → 合并后保持默认（双向兼容）
        let json = #"{"ttsProvider":"xfyun","cloudVoice":"xiaoyan"}"#
        let override = try ReaderFileCodec.decode(ReaderSettingsOverride.self, from: Data(json.utf8))
        XCTAssertNil(override.edgeVoiceZh)
        XCTAssertNil(override.edgeVoiceEn)
        let merged = mergeReaderSettings(.default, override)
        XCTAssertEqual(merged.ttsProvider, .xfyun)
        XCTAssertEqual(merged.edgeVoiceZh, "")
        XCTAssertEqual(merged.edgeVoiceEn, "")
    }

    func testGlobalSettingsRoundtripThroughOverride() throws {
        // 全局设置真实落盘路径：存 ReaderSettings → 读 ReaderSettingsOverride → 合并
        var settings = ReaderSettings.default
        settings.edgeVoiceZh = "zh-CN-YunjianNeural"
        settings.edgeVoiceEn = "en-US-BrianNeural"
        let data = try ReaderFileCodec.encode(settings)
        let override = try ReaderFileCodec.decode(ReaderSettingsOverride.self, from: data)
        let merged = mergeReaderSettings(.default, override)
        XCTAssertEqual(merged.ttsProvider, .edge)
        XCTAssertEqual(merged.edgeVoiceZh, "zh-CN-YunjianNeural")
        XCTAssertEqual(merged.edgeVoiceEn, "en-US-BrianNeural")
    }

    // MARK: - patch 产出与应用

    func testReaderSettingsPatchProducesEdgeFieldsOnlyWhenChanged() {
        let old = ReaderSettings.default
        var new = old
        new.ttsProvider = .local
        new.edgeVoiceZh = "zh-CN-XiaoyiNeural"
        let patch = readerSettingsPatch(from: old, to: new)
        XCTAssertEqual(patch["ttsProvider"] as? String, "local")
        XCTAssertEqual(patch["edgeVoiceZh"] as? String, "zh-CN-XiaoyiNeural")
        XCTAssertNil(patch["edgeVoiceEn"])  // 未变化不产出

        // 设置不变 → 空 patch
        XCTAssertTrue(readerSettingsPatch(from: new, to: new).isEmpty)
    }

    func testOverrideApplyPatchAcceptsEdgeFields() {
        var override = ReaderSettingsOverride()
        override.apply(patch: [
            "ttsProvider": "edge",
            "edgeVoiceZh": "zh-CN-YunyangNeural",
            "edgeVoiceEn": "en-US-GuyNeural",
        ])
        XCTAssertEqual(override.ttsProvider, "edge")
        XCTAssertEqual(override.edgeVoiceZh, "zh-CN-YunyangNeural")
        XCTAssertEqual(override.edgeVoiceEn, "en-US-GuyNeural")

        // 合并后生效
        let merged = mergeReaderSettings(.default, override)
        XCTAssertEqual(merged.ttsProvider, .edge)
        XCTAssertEqual(merged.edgeVoiceZh, "zh-CN-YunyangNeural")
        XCTAssertEqual(merged.edgeVoiceEn, "en-US-GuyNeural")
    }
}
