import XCTest
import XfyunCore
import ReaderCore
@testable import ImmersiveTranslator

/// 跟读报告桥接与门槛：XfyunCore → ReaderCore 三层打通 / 干净结果门槛 /
/// 差词清单切片与置顶 / 录音 WAV 构造（对齐 Windows shadowDiagnose.test 主场景）。
final class ShadowReportBridgeTests: XCTestCase {
    // MARK: - 构造辅助

    private func word(_ content: String, _ totalScore: Double, dp: Int = 0) -> WordScore {
        WordScore(content: content, totalScore: totalScore, dpMessage: dp)
    }

    private func iseResult(
        total: Double,
        accuracy: Double = 4,
        fluency: Double = 4,
        isRejected: Bool = false,
        exceptInfo: String? = nil
    ) -> PronunciationResult {
        PronunciationResult(
            total: total, accuracy: accuracy, fluency: fluency, standard: total,
            integrity: 5, isRejected: isRejected, exceptInfo: exceptInfo, words: []
        )
    }

    /// Windows shadowDiagnose.test 主场景的同一组词（含标点原句，验证切片对齐）。
    private let target = "The quick brown fox jumps over the lazy dog."

    private func mainWords() -> [WordScore] {
        [
            word("the", 5),
            word("quick", 4.7),
            word("brown", 0, dp: 16),   // 漏读
            word("fox", 2.5),           // 差词
            word("jumps", 3.5),         // ok
            word("over", 5),
            word("the", 5),
            word("lazy", 4.9),
            word("dog", 4.7),
        ]
    }

    // MARK: - 三层打通（mapWordsToText → 桥接 → diagnoseShadow）

    func testBridgeToDiagnosisMainScenario() {
        let words = mainWords()
        let marks = mapWordsToText(text: target, words: words)
        XCTAssertEqual(marks.count, 9)
        // 四档映射齐全（含 good→.good，v2 修订要求的着色档不缺）
        XCTAssertEqual(
            Set(marks.map { $0.quality.shadowDiagQuality }),
            Set([ShadowDiagQuality.good, .ok, .bad, .missed])
        )
        // 词明细经 word 字段补齐后一路带入（fox 的桥接词仍是 fox）
        XCTAssertEqual(marks.first { $0.quality == .bad }?.word?.content, "fox")

        let result = PronunciationResult(
            total: 4.1, accuracy: 4.3, fluency: 3.4, standard: 4.1,
            integrity: 4.6, isRejected: false, exceptInfo: nil, words: words
        )
        let d = diagnoseShadow(result.shadowDiag, marks.map(\.shadowDiagMark))
        XCTAssertEqual(d.badge, "差 0.1 过关")
        XCTAssertEqual(d.badgeKind, .almost)
        XCTAssertEqual(d.weakDim, .fluency)
        XCTAssertEqual(d.drillWords, ["fox", "brown"])
        XCTAssertEqual(d.badCount, 1)
        XCTAssertEqual(d.missedCount, 1)
        let joined = d.segments.map(\.text).joined()
        XCTAssertTrue(joined.contains("流畅度 3.4"))
        XCTAssertTrue(joined.contains("fox"))
        XCTAssertTrue(joined.contains("漏读了 brown"))
    }

    // MARK: - 干净结果门槛

    func testIsCleanIseResultGate() {
        XCTAssertFalse(isCleanIseResult(iseResult(total: 4.5, isRejected: true)))
        XCTAssertFalse(isCleanIseResult(iseResult(total: 4.5, exceptInfo: "28673")))
        XCTAssertFalse(isCleanIseResult(iseResult(total: 4.5, exceptInfo: "28680")))
        XCTAssertFalse(isCleanIseResult(iseResult(total: 4.5, exceptInfo: "28676")))
        XCTAssertTrue(isCleanIseResult(iseResult(total: 4.5)))
    }

    // MARK: - 差词训练清单

    func testShadowDrillEntriesSliceKeepsCaseAndCapsAtFour() {
        // 含标点原句：切片与 marks 偏移逐词对上，保留原大小写
        let marks = mapWordsToText(text: target, words: mainWords())
        let entries = shadowDrillEntries(target: target, marks: marks)
        XCTAssertEqual(entries.map(\.text), ["brown", "fox"])

        // 上限 4（a,b,d,e 差词在前、c,f 漏词在后 → 按出现序聚焦前 4）
        let six = [
            word("a", 1), word("b", 1), word("c", 0, dp: 16),
            word("d", 1), word("e", 1), word("f", 0, dp: 16),
        ]
        let sixMarks = mapWordsToText(text: "a b c d e f", words: six)
        let sixEntries = shadowDrillEntries(target: "a b c d e f", marks: sixMarks)
        XCTAssertEqual(sixEntries.map(\.text), ["a", "b", "c", "d"])
        XCTAssertEqual(sixEntries.count, 4)
    }

    /// preferring（弹层「练这个词」）把该词提到队首。
    @MainActor
    func testDrillOpenPreferringMovesToFront() {
        let marks = mapWordsToText(text: target, words: mainWords())
        let entries = shadowDrillEntries(target: target, marks: marks)
        let drill = ShadowDrillController()
        drill.open(entries: entries, preferring: "FOX")  // lowercase 匹配
        XCTAssertTrue(drill.state.shown)
        XCTAssertEqual(drill.state.idx, 0)
        XCTAssertEqual(drill.entry(at: 0)?.text, "fox")
        XCTAssertEqual(drill.state.scores.count, entries.count)
        XCTAssertEqual(drill.state.scores, [nil, nil])
    }

    /// 评审修正（v2 规格遗漏）：末词 next()/skip() 先收抽屉（shown=false、收麦）
    /// 再触发 onDone——onDone 接 assessRetry 立即开主录音，抽屉若滞留会造成
    /// 双麦克风引擎争用与评测条被盖。
    @MainActor
    func testDrillLastWordClosesSheetBeforeDone() {
        var doneCount = 0
        var shownAtDone = true
        let drill = ShadowDrillController()
        drill.onDone = {
            doneCount += 1
            shownAtDone = drill.state.shown  // onDone 时抽屉必须已经收起
        }
        let entries = [
            ShadowDrillController.Entry(text: "fox", mark: WordMark(start: 0, end: 3, quality: .bad, score: 2.5)),
            ShadowDrillController.Entry(text: "brown", mark: WordMark(start: 4, end: 9, quality: .missed, score: 0)),
        ]
        drill.open(entries: entries)

        // 非末词：只前进，不关抽屉、不触发 onDone
        drill.next()
        XCTAssertEqual(drill.state.idx, 1)
        XCTAssertTrue(drill.state.shown)
        XCTAssertEqual(doneCount, 0)

        // 末词：先收抽屉再 onDone（next 与 skip 同语义）
        drill.next()
        XCTAssertFalse(drill.state.shown)
        XCTAssertEqual(doneCount, 1)
        XCTAssertFalse(shownAtDone)

        drill.open(entries: entries, preferring: "brown")
        XCTAssertEqual(drill.state.idx, 0)
        drill.skip()
        XCTAssertEqual(drill.state.idx, 1)
        drill.skip()
        XCTAssertFalse(drill.state.shown)
        XCTAssertEqual(doneCount, 2)
        XCTAssertFalse(shownAtDone)
    }

    // MARK: - 录音回放 WAV 构造

    func testWavDataHeaderAndClamp() {
        let data = ShadowRecordingPlayer.wavData(pcm: [1.5, -1.5, 0.5], sampleRate: 16_000)
        // 44 字节头 + 2 × 3 采样
        XCTAssertEqual(data.count, 44 + 6)
        XCTAssertEqual(String(data: data.subdata(in: 0..<4), encoding: .ascii), "RIFF")
        XCTAssertEqual(String(data: data.subdata(in: 8..<12), encoding: .ascii), "WAVE")
        XCTAssertEqual(String(data: data.subdata(in: 12..<16), encoding: .ascii), "fmt ")
        func u16(_ off: Int) -> Int {
            Int(data[data.startIndex + off]) | (Int(data[data.startIndex + off + 1]) << 8)
        }
        func u32(_ off: Int) -> Int {
            var v = 0
            for i in stride(from: 3, through: 0, by: -1) {
                v = (v << 8) | Int(data[data.startIndex + off + i])
            }
            return v
        }
        XCTAssertEqual(u32(4), 36 + 6)     // RIFF 块大小 = 36 + dataLen
        XCTAssertEqual(u16(20), 1)         // PCM
        XCTAssertEqual(u16(22), 1)         // 声道 1
        XCTAssertEqual(u32(24), 16_000)    // 采样率
        XCTAssertEqual(u32(28), 32_000)    // byteRate
        XCTAssertEqual(u16(32), 2)         // blockAlign
        XCTAssertEqual(u16(34), 16)        // bits
        XCTAssertEqual(String(data: data.subdata(in: 36..<40), encoding: .ascii), "data")
        XCTAssertEqual(u32(40), 6)         // dataLen = 2 × pcm.count
        // Float 超界钳位 [-1,1]：1.5 → 32767、-1.5 → -32768（0xFFFF）、0.5 → 16383
        XCTAssertEqual(u16(44), 32767)
        XCTAssertEqual(u16(46), (-32768) & 0xFFFF)
        XCTAssertEqual(u16(48), 16383)
    }

    // MARK: SPEAK-7 - 落盘 attempts → 报告卡数据（Windows SpeakView.tsx:650-678 lastReport）

    private func attempt(at: Int64, total: Double, words: [WordScore]) -> ShadowAttempt {
        ShadowAttempt(
            at: at, total: total, accuracy: total, fluency: total - 0.2, integrity: 4.8,
            words: words.map { w in
                ShadowWord(content: w.content, totalScore: w.totalScore, dpMessage: w.dpMessage, sylls: [])
            }
        )
    }

    func testShadowAttemptReportDerivesFromLastAttemptWithAllTotals() throws {
        let attempts = [
            attempt(at: 100, total: 3.1, words: mainWords()),
            attempt(at: 200, total: 4.1, words: mainWords()),
        ]
        let report = try XCTUnwrap(shadowAttemptReport(target: target, attempts: attempts))
        XCTAssertEqual(report.attemptAt, 200)
        XCTAssertEqual(report.totals, [3.1, 4.1])
        // result 由末次 attempt 重建：standard 取 total；进 attempts 的必是干净结果
        XCTAssertEqual(report.result.total, 4.1)
        XCTAssertEqual(report.result.accuracy, 4.1)
        XCTAssertEqual(report.result.fluency, 3.9, accuracy: 0.0001)
        XCTAssertEqual(report.result.integrity, 4.8)
        XCTAssertEqual(report.result.standard, 4.1)
        XCTAssertFalse(report.result.isRejected)
        XCTAssertNil(report.result.exceptInfo)
        XCTAssertEqual(report.result.words.map(\.content), mainWords().map(\.content))
        // marks 与原句对齐（四档齐全、差词/漏词命中）
        XCTAssertEqual(report.marks.count, 9)
        XCTAssertEqual(report.marks.first { $0.quality == .bad }?.word?.content, "fox")
        XCTAssertEqual(report.marks.first { $0.quality == .missed }?.word?.content, "brown")
        // 诊断链路直接可用（报告卡主体同一套输入）
        let diag = diagnoseShadow(report.result.shadowDiag, report.marks.map(\.shadowDiagMark))
        XCTAssertEqual(diag.badge, "差 0.1 过关")
        XCTAssertEqual(diag.drillWords, ["fox", "brown"])
        // 差词清单也从同一 target/marks 切出
        XCTAssertEqual(shadowDrillEntries(target: target, marks: report.marks).map(\.text), ["brown", "fox"])
    }

    func testShadowAttemptReportIsNilWithoutAttempts() {
        XCTAssertNil(shadowAttemptReport(target: target, attempts: []))
    }

    func testShadowAttemptReportSingleAttemptHasOneTotal() throws {
        let report = try XCTUnwrap(shadowAttemptReport(target: "hello world", attempts: [
            attempt(at: 5, total: 4.6, words: [word("hello", 4.6), word("world", 4.6)]),
        ]))
        XCTAssertEqual(report.totals, [4.6])
        XCTAssertEqual(report.marks.map(\.quality), [.good, .good])
    }

    // MARK: SPEAK-7/13 - 报告卡与异常卡令牌逐值对账（reader.css）

    /// .speak-report-card（reader.css:3793-3807）：12 圆角 / padding 12 14 11 / gap 9 /
    /// box-shadow 0 1px 3px rgba(16,24,40,.05)。
    func testReportCardTokensMatchReaderCSS() {
        XCTAssertEqual(ShadowCardTokens.reportCornerRadius, 12)
        XCTAssertEqual(ShadowCardTokens.reportPadding.top, 12)
        XCTAssertEqual(ShadowCardTokens.reportPadding.leading, 14)
        XCTAssertEqual(ShadowCardTokens.reportPadding.bottom, 11)
        XCTAssertEqual(ShadowCardTokens.reportPadding.trailing, 14)
        XCTAssertEqual(ShadowCardTokens.reportSpacing, 9)
        XCTAssertEqual(ShadowCardTokens.reportShadowOpacity, 0.05)
        XCTAssertEqual(ShadowCardTokens.reportShadowRadius, 1.5)   // CSS blur 3px ≈ radius 1.5
        XCTAssertEqual(ShadowCardTokens.reportShadowY, 1)
    }

    /// @keyframes rc-in（reader.css:3809-3818）：.38s cubic-bezier(.2,.9,.3,1.15)，
    /// from translateY(8px) scale(.985)；减弱动态效果时只留 0.2s 淡入。
    func testCardEnterMotionTokensMatchRcIn() {
        XCTAssertEqual(ShadowCardTokens.enterDuration, 0.38)
        XCTAssertEqual(ShadowCardTokens.enterCurve.c0x, 0.2)
        XCTAssertEqual(ShadowCardTokens.enterCurve.c0y, 0.9)
        XCTAssertEqual(ShadowCardTokens.enterCurve.c1x, 0.3)
        XCTAssertEqual(ShadowCardTokens.enterCurve.c1y, 1.15)
        XCTAssertEqual(ShadowCardTokens.enterOffsetY, 8)
        XCTAssertEqual(ShadowCardTokens.enterScale, 0.985)
        XCTAssertEqual(ShadowCardTokens.enterReducedDuration, 0.2)
    }

    /// .speak-report-err（reader.css:4214-4240）：10 圆角 / padding 9 12 / gap 6 /
    /// border-left 3px / 12.5px。
    func testFailureCardTokensMatchReaderCSS() {
        XCTAssertEqual(ShadowCardTokens.failureCornerRadius, 10)
        XCTAssertEqual(ShadowCardTokens.failurePadding.top, 9)
        XCTAssertEqual(ShadowCardTokens.failurePadding.leading, 12)
        XCTAssertEqual(ShadowCardTokens.failurePadding.bottom, 9)
        XCTAssertEqual(ShadowCardTokens.failurePadding.trailing, 12)
        XCTAssertEqual(ShadowCardTokens.failureSpacing, 6)
        XCTAssertEqual(ShadowCardTokens.failureAccentLineWidth, 3)
        XCTAssertEqual(ShadowCardTokens.failureFontSize, 12.5)
    }
}
