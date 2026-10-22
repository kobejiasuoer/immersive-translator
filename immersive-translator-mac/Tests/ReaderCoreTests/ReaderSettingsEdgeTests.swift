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

    // MARK: - v0.8 画报字段（spotlightMode / spreadLayout）三向量

    /// 向量 1：缺省回落——老 JSON 无这两个字段，读出来 nil，生效值 false / prose。
    func testSpreadAndSpotlightDefaultToNilAndFallBack() throws {
        XCTAssertNil(ReaderSettings.default.spotlightMode)
        XCTAssertNil(ReaderSettings.default.spreadLayout)
        XCTAssertEqual(ReaderSettings.default.spotlightEnabled, false)
        XCTAssertEqual(ReaderSettings.default.effectiveSpreadLayout, .prose)

        // 老数据：JSON 完全没有 v0.8 字段 → 双向兼容，合并后仍是缺省。
        let legacy = #"{"contrastMode":"en","fontSize":19}"#
        let override = try ReaderFileCodec.decode(ReaderSettingsOverride.self, from: Data(legacy.utf8))
        XCTAssertNil(override.spotlightMode)
        XCTAssertNil(override.spreadLayout)
        let merged = mergeReaderSettings(.default, override)
        XCTAssertEqual(merged.spotlightEnabled, false)
        XCTAssertEqual(merged.effectiveSpreadLayout, .prose)
        XCTAssertEqual(merged.contrastMode, .en)
    }

    /// 向量 2：合法覆盖——merge 应用、patch 产出、全局落盘回读闭环。
    func testSpreadAndSpotlightLegalOverrideRoundtrip() throws {
        var override = ReaderSettingsOverride()
        override.spreadLayout = "parallel"
        override.spotlightMode = true
        let merged = mergeReaderSettings(.default, override)
        XCTAssertTrue(merged.spotlightEnabled)
        XCTAssertEqual(merged.effectiveSpreadLayout, .parallel)

        // patch 只含变化字段，apply 回覆盖后再合并保持。
        var base = ReaderSettings.default
        base.spotlightMode = true
        base.spreadLayout = .parallel
        let patch = readerSettingsPatch(from: ReaderSettings.default, to: base)
        XCTAssertEqual(patch["spotlightMode"] as? Bool, true)
        XCTAssertEqual(patch["spreadLayout"] as? String, "parallel")

        var applied = ReaderSettingsOverride()
        applied.apply(patch: patch)
        XCTAssertEqual(mergeReaderSettings(.default, applied), mergeReaderSettings(.default, override))

        // 全局设置真实落盘路径：存 ReaderSettings → 读 ReaderSettingsOverride → 合并。
        let data = try ReaderFileCodec.encode(base)
        let reread = try ReaderFileCodec.decode(ReaderSettingsOverride.self, from: data)
        let remerged = mergeReaderSettings(.default, reread)
        XCTAssertTrue(remerged.spotlightEnabled)
        XCTAssertEqual(remerged.effectiveSpreadLayout, .parallel)

        // 归位回 nil 时 patch 写出生效默认值（false / prose）。
        let resetPatch = readerSettingsPatch(from: base, to: ReaderSettings.default)
        XCTAssertEqual(resetPatch["spotlightMode"] as? Bool, false)
        XCTAssertEqual(resetPatch["spreadLayout"] as? String, "prose")
    }

    /// 向量 3：非法值忽略——spreadLayout 非法字符串不落，回落缺省 prose。
    func testSpreadLayoutIllegalValueIgnored() throws {
        var override = ReaderSettingsOverride()
        override.spreadLayout = "diagonal"  // schema 枚举外
        let merged = mergeReaderSettings(.default, override)
        XCTAssertEqual(merged.effectiveSpreadLayout, .prose)
        XCTAssertNil(merged.spreadLayout)

        // 坏 JSON 字段解码不炸、类型不符也不落（Bool 塞 String 位 / 反之）。
        let raw = #"{"spreadLayout":42,"spotlightMode":"yes"}"#
        let bad = try ReaderFileCodec.decode(ReaderSettingsOverride.self, from: Data(raw.utf8))
        XCTAssertNil(bad.spreadLayout)
        XCTAssertNil(bad.spotlightMode)

        // 枚举与标签（刊头开关文案对齐 Windows ReadingView.tsx:585）。
        XCTAssertEqual(SpreadLayout.prose.label, "段落")
        XCTAssertEqual(SpreadLayout.parallel.label, "双语对照")
        XCTAssertEqual(SpreadLayout.prose.next, .parallel)
        XCTAssertEqual(SpreadLayout.parallel.next, .prose)
    }
}
