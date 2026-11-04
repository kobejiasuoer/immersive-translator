import XCTest
@testable import ReaderCore

/// 随读抽查选槽与文案的纯逻辑向量（对齐 Windows src/core/clozeSlots.ts + ReadingView.cloze.test.tsx
/// 的夹具：句 0 词块槽「making up its mind」（带陷阱）、句 1 生词再现槽「slumbered」、
/// 句 2 未读（watermark = 1）即使有词块也不挖）。
final class ClozeSlotsTests: XCTestCase {
    private let sentences: [SentencePair] = [
        SentencePair(
            idx: 0, paragraphIdx: 0,
            en: "The tide is still making up its mind.",
            zh: "潮水仍在犹豫。", zhState: .done,
            chunks: [SentenceChunk(text: "making up its mind", chunkType: .idiom, gloss: "下定决心", trap: "making its mind")]
        ),
        SentencePair(idx: 1, paragraphIdx: 1, en: "For forty years the town slumbered.", zh: "小镇沉睡。", zhState: .done),
        SentencePair(
            idx: 2, paragraphIdx: 2,
            en: "Now cranes swing over the locks again.",
            zh: "吊臂转动。", zhState: .done,
            chunks: [SentenceChunk(text: "swing over", chunkType: .phrasal, gloss: "在…上空转动")]
        ),
    ]

    private func spans(knownIds: Set<String> = ["slumbered"]) -> [Int: [ChunkSpan]] {
        var map: [Int: [ChunkSpan]] = [:]
        for s in sentences {
            let list = buildSentenceSpans(s.en, s.chunks, knownIds: knownIds)
            if !list.isEmpty { map[s.idx] = list }
        }
        return map
    }

    func testPicksOnlyReadSentencesWithinWatermark() {
        let slots = pickClozeSlots(spansBySentence: spans(), sentences: sentences, watermark: 1)
        XCTAssertEqual(Set(slots.keys), [0, 1], "句 0 词块槽 + 句 1 known 槽；句 2 未读不挖")

        let chunkSlot = slots[0]!
        XCTAssertEqual(chunkSlot.answer, "making up its mind")
        XCTAssertEqual(chunkSlot.trap, "making its mind")
        XCTAssertEqual(chunkSlot.gloss, "下定决心")
        XCTAssertFalse(chunkSlot.isKnown)
        XCTAssertNil(chunkSlot.vocabId)
        XCTAssertEqual(chunkSlot.id, "0:\(chunkSlot.start)", "id = 句号:起点")

        let knownSlot = slots[1]!
        XCTAssertEqual(knownSlot.answer, "slumbered")
        XCTAssertTrue(knownSlot.isKnown)
        XCTAssertEqual(knownSlot.vocabId, "slumbered", "known 槽经 normalizeWordKey 定位生词本记录")
        XCTAssertNil(knownSlot.trap)
    }

    func testWatermarkZeroPicksOnlyFirstSentenceAndWatermarkCoversUnread() {
        XCTAssertEqual(Set(pickClozeSlots(spansBySentence: spans(), sentences: sentences, watermark: 0).keys), [0])
        XCTAssertEqual(
            Set(pickClozeSlots(spansBySentence: spans(), sentences: sentences, watermark: 2).keys), [0, 1, 2],
            "读到句 2 后它的词块也可挖"
        )
    }

    func testOneSlotPerParagraphPrefersKnownOverTrapChunkOverChunk() {
        // 同段三句：普通词块 / 带陷阱词块 / 生词再现 → 段内只留 known；段内比较跨句。
        let para: [SentencePair] = [
            SentencePair(idx: 0, paragraphIdx: 0, en: "They set up camp.", chunks: [SentenceChunk(text: "set up", chunkType: .phrasal, gloss: "搭建")]),
            SentencePair(idx: 1, paragraphIdx: 0, en: "It took root fast.", chunks: [SentenceChunk(text: "took root", chunkType: .idiom, gloss: "扎根", trap: "took roots")]),
            SentencePair(idx: 2, paragraphIdx: 0, en: "The town slumbered."),
        ]
        var byIdx: [Int: [ChunkSpan]] = [:]
        for s in para { byIdx[s.idx] = buildSentenceSpans(s.en, s.chunks, knownIds: ["slumbered"]) }
        let known = pickClozeSlots(spansBySentence: byIdx, sentences: para, watermark: 2)
        XCTAssertEqual(known.count, 1)
        XCTAssertEqual(known[2]?.answer, "slumbered", "known 权重最高")

        // 去掉 known：带陷阱词块胜出。
        byIdx[2] = buildSentenceSpans(para[2].en, nil, knownIds: [])
        let trap = pickClozeSlots(spansBySentence: byIdx, sentences: para, watermark: 2)
        XCTAssertEqual(trap.count, 1)
        XCTAssertEqual(trap[1]?.answer, "took root", "带陷阱词块 > 普通词块")
    }

    func testEligibilityShape() {
        // <3 字符 / >4 词 / 含数字符号 的跨度不挖。
        let s = [
            SentencePair(idx: 0, paragraphIdx: 0, en: "Go on then.", chunks: [SentenceChunk(text: "on", chunkType: .phrasal, gloss: "继续")]),
            SentencePair(idx: 1, paragraphIdx: 1, en: "She kept an eye on the kids all day.", chunks: [SentenceChunk(text: "kept an eye on the kids", chunkType: .idiom, gloss: "照看")]),
            SentencePair(idx: 2, paragraphIdx: 2, en: "Call 911 now.", chunks: [SentenceChunk(text: "Call 911", chunkType: .collocation, gloss: "报警")]),
            SentencePair(idx: 3, paragraphIdx: 3, en: "He will make do with less.", chunks: [SentenceChunk(text: "make do", chunkType: .idiom, gloss: "将就")]),
        ]
        var byIdx: [Int: [ChunkSpan]] = [:]
        for p in s { byIdx[p.idx] = buildSentenceSpans(p.en, p.chunks, knownIds: []) }
        let slots = pickClozeSlots(spansBySentence: byIdx, sentences: s, watermark: 9)
        XCTAssertEqual(Set(slots.keys), [3], "只有「make do」合格")
    }

    func testVerdictToGradeCapsAtGood() {
        XCTAssertEqual(clozeVerdictToGrade(.perfect), .good, "即时回忆不记 easy")
        XCTAssertEqual(clozeVerdictToGrade(.close), .hard)
        XCTAssertEqual(clozeVerdictToGrade(.trap), .forgot)
        XCTAssertEqual(clozeVerdictToGrade(.wrong), .forgot)
    }

    func testVerdictLabelsAndHintPenalty() {
        XCTAssertEqual(clozeVerdictLabel(.perfect), "命中")
        XCTAssertEqual(clozeVerdictLabel(.close), "接近")
        XCTAssertEqual(clozeVerdictLabel(.trap), "陷阱")
        XCTAssertEqual(clozeVerdictLabel(.wrong), "未中")
        XCTAssertEqual(clozeApplyHintPenalty(.perfect, usedHint: true), .close, "用过提示的命中降档为接近")
        XCTAssertEqual(clozeApplyHintPenalty(.perfect, usedHint: false), .perfect)
        XCTAssertEqual(clozeApplyHintPenalty(.trap, usedHint: true), .trap, "只有 perfect 降档")
    }

    func testToastAndNoteAndA11yCopy() {
        XCTAssertEqual(clozeToastLabel(isKnown: true, verdict: .perfect), "已记入复习 · 良好")
        XCTAssertEqual(clozeToastLabel(isKnown: true, verdict: .close), "已记入复习 · 良好")
        XCTAssertEqual(clozeToastLabel(isKnown: true, verdict: .trap), "已记入复习 · 需复习")
        XCTAssertEqual(clozeToastLabel(isKnown: true, verdict: .wrong), "已记入复习 · 需复习")
        XCTAssertEqual(clozeToastLabel(isKnown: false, verdict: .perfect), "抽查完成")

        let slots = pickClozeSlots(spansBySentence: spans(), sentences: sentences, watermark: 1)
        XCTAssertEqual(clozeNoteText(slots[0]!), "陷阱 · making its mind", "有陷阱讲陷阱")
        XCTAssertNil(clozeNoteText(slots[1]!), "known 槽无陷阱无释义 → 无朱批")
        var glossOnly = slots[0]!
        glossOnly.trap = nil
        XCTAssertEqual(clozeNoteText(glossOnly), "释义 · 下定决心")

        XCTAssertEqual(clozeInputAccessibilityLabel(slots[0]!), "补全挖空的词块：m… u… i… m…")
        XCTAssertEqual(clozeInputAccessibilityLabel(slots[1]!), "补全挖空的生词：s…")
    }

    func testTallyAndMeterText() {
        let slots = pickClozeSlots(spansBySentence: spans(), sentences: sentences, watermark: 1)
        let empty = clozeTally(slots: slots, verdicts: [:])
        XCTAssertEqual(empty, ClozeTally(hit: 0, close: 0, trap: 0, done: 0, todo: 2))
        XCTAssertEqual(clozeMeterText(empty), "抽查 0 命中 · 0 接近 · 0 陷阱 · 剩 2")

        let one = clozeTally(slots: slots, verdicts: [slots[0]!.id: .perfect])
        XCTAssertEqual(clozeMeterText(one), "抽查 1 命中 · 0 接近 · 0 陷阱 · 剩 1")

        let both = clozeTally(slots: slots, verdicts: [slots[0]!.id: .trap, slots[1]!.id: .wrong])
        XCTAssertEqual(both, ClozeTally(hit: 0, close: 0, trap: 1, done: 2, todo: 0), "未中计入 done 不计入三档")
    }
}
