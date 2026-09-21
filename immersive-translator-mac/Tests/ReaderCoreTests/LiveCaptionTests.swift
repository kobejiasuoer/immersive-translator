import XCTest
@testable import ReaderCore

/// 录音直译（P6）：VAD 分句器 / 方向与 prompt / 双语导出。

final class LiveCaptionTests: XCTestCase {
    // MARK: - 分句器

    private func chunk(level: Float, ms: Double, sampleRate: Double = 16_000) -> [Float] {
        let count = Int(ms / 1000 * sampleRate)
        let amp: Float = level * 1.8  // 平滑前的瞬时幅值近似
        return [Float](repeating: amp, count: count)
    }

    func testSegmenterSilenceThenSpeechThenSilence() {
        let seg = LiveSegmenter(options: SegmenterOptions(silenceMs: 900, minMs: 600, maxMs: 12_000))
        // 静音不起句
        XCTAssertNil(seg.push(chunk: chunk(level: 0.001, ms: 300), level: 0.001))
        XCTAssertFalse(seg.speaking)
        // 说话 1s（电平 0.05）
        XCTAssertNil(seg.push(chunk: chunk(level: 0.05, ms: 1000), level: 0.05))
        XCTAssertTrue(seg.speaking)
        // 静音 1s > 900ms：收句
        let out = seg.push(chunk: chunk(level: 0.001, ms: 1000), level: 0.001)
        XCTAssertNotNil(out)
        XCTAssertEqual(out?.count, Int(2000.0 / 1000 * 16_000))
        XCTAssertFalse(seg.speaking)
    }

    func testSegmenterTooShortNoiseDiscarded() {
        let seg = LiveSegmenter(options: SegmenterOptions(silenceMs: 900, minMs: 600))
        // 短杂音 300ms 后静音：不足最短成句时长，丢弃
        XCTAssertNil(seg.push(chunk: chunk(level: 0.05, ms: 300), level: 0.05))
        XCTAssertNil(seg.push(chunk: chunk(level: 0.001, ms: 1000), level: 0.001))
        XCTAssertFalse(seg.speaking)
    }

    func testSegmenterMaxForceTake() {
        let seg = LiveSegmenter(options: SegmenterOptions(silenceMs: 5000, maxMs: 2000))
        var out: [Float]? = nil
        var elapsed = 0.0
        while out == nil && elapsed < 3000 {
            out = seg.push(chunk: chunk(level: 0.06, ms: 200), level: 0.06)
            elapsed += 200
        }
        XCTAssertNotNil(out)
    }

    func testSegmenterFlushHalfSentence() {
        let seg = LiveSegmenter()
        XCTAssertNil(seg.push(chunk: chunk(level: 0.05, ms: 500), level: 0.05))
        XCTAssertTrue(seg.speaking)
        let half = seg.flush()
        XCTAssertNotNil(half)
        XCTAssertNil(seg.flush())  // 复位后再 flush 无产出
    }

    // MARK: - 方向 / prompt

    func testDirectionHelpers() {
        XCTAssertEqual(CaptionDirection.zh2en.asrLanguage, "zh_cn")
        XCTAssertEqual(CaptionDirection.en2zh.asrLanguage, "en_us")
        XCTAssertEqual(CaptionDirection.zh2en.swapped, .en2zh)
        XCTAssertEqual(CaptionDirection.en2zh.targetLabel, "简体中文")
    }

    func testBuildCaptionSystemPrompt() {
        XCTAssertTrue(buildCaptionSystemPrompt(direction: .zh2en).contains("英文"))
        XCTAssertTrue(buildCaptionSystemPrompt(direction: .en2zh).contains("简体中文"))
        XCTAssertTrue(buildCaptionSystemPrompt(direction: .zh2en).contains("语音识别"))
    }

    // MARK: - 导出

    private var sampleSegments: [CaptionSegment] {
        [
            CaptionSegment(id: 0, source: "今天天气不错", target: "Nice weather today.", state: .done, at: 1),
            CaptionSegment(id: 1, source: "我们去公园吧", target: nil, state: .failed, at: 2),
            CaptionSegment(id: 2, source: "  ", target: nil, state: .done, at: 3),  // 空句跳过
        ]
    }

    func testBuildCaptionMarkdown() {
        let md = buildCaptionMarkdown(sampleSegments, meta: CaptionExportMeta(direction: .zh2en, startedAt: 1_789_500_000_000, endedAt: 1_789_501_800_000))
        XCTAssertTrue(md.hasPrefix("# 录音直译 · 2026-09-16"))
        XCTAssertTrue(md.contains("方向：中 → 英 · 时长约 30 分钟 · 3 句"))
        XCTAssertTrue(md.contains("- 今天天气不错"))
        XCTAssertTrue(md.contains("  - Nice weather today."))
        XCTAssertTrue(md.contains("- 我们去公园吧"))
        XCTAssertFalse(md.contains("-   "))  // 空白句不导出
    }

    func testBuildCaptionPlainText() {
        let text = buildCaptionPlainText(sampleSegments, meta: CaptionExportMeta(direction: .en2zh, startedAt: 1, endedAt: 61_000))
        XCTAssertTrue(text.hasPrefix("录音直译（英 → 中）"))
        XCTAssertTrue(text.contains("今天天气不错\n\nNice weather today."))
    }

    func testCaptionFileName() {
        let name = captionFileName(now: 1_789_500_000_000, ext: "md")
        XCTAssertTrue(name.hasPrefix("录音直译-2026-09-16-"))
        XCTAssertTrue(name.hasSuffix(".md"))
    }
}
