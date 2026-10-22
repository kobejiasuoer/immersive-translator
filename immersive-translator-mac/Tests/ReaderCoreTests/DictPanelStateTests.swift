import XCTest
@testable import ReaderCore

/// 浮窗词典预取状态机（PANEL-DOCK 批新增，PanelDictState）：
/// invalid 与 notAWord 分路、失败可重试、notAWord 连带收起生词本入口。
final class DictPanelStateTests: XCTestCase {
    private func makeCard(word: String = "hello") -> DictCardData {
        DictCardData(
            word: word,
            phonetics: [DictPhonetic(label: "UK", value: "həˈləʊ")],
            translation: "你好",
            senses: [DictSense(pos: "int.", gloss: "问候语", examples: [])],
            inflections: "",
            etymology: ""
        )
    }

    // MARK: - begin

    func testBeginDisabledDictStaysHidden() {
        var state = PanelDictState()
        state.apply(.notAWord) // 预置一个非零状态验证复位
        state.begin(query: "hello", dictEnabled: false, lookupLike: true)
        XCTAssertEqual(state.phase, .hidden)
        XCTAssertFalse(state.notAWord, "新流程应复位 notAWord（词典关着时生词本入口仍按文本形状出现）")
    }

    func testBeginNonLookupTextStaysHidden() {
        var state = PanelDictState()
        state.begin(query: "This is a full sentence.", dictEnabled: true, lookupLike: false)
        XCTAssertEqual(state.phase, .hidden)
        XCTAssertEqual(state.query, "")
    }

    func testBeginLookupTextEntersQuerying() {
        var state = PanelDictState()
        state.begin(query: "hello", dictEnabled: true, lookupLike: true)
        XCTAssertEqual(state.phase, .querying)
        XCTAssertEqual(state.query, "hello")
        XCTAssertNil(state.card)
    }

    // MARK: - apply 三分路（card / notAWord / invalid）

    func testApplyCardBecomesReady() {
        var state = PanelDictState()
        state.begin(query: "hello", dictEnabled: true, lookupLike: true)
        let card = makeCard()
        state.apply(.card(card))
        XCTAssertEqual(state.phase, .ready)
        XCTAssertEqual(state.card, card)
    }

    func testApplyNotAWordHidesAndFlags() {
        var state = PanelDictState()
        state.begin(query: "hello", dictEnabled: true, lookupLike: true)
        state.apply(.notAWord)
        XCTAssertEqual(state.phase, .hidden)
        XCTAssertTrue(state.notAWord)
        XCTAssertNil(state.card)
    }

    func testApplyInvalidBecomesRetryableFailure() {
        var state = PanelDictState()
        state.begin(query: "hello", dictEnabled: true, lookupLike: true)
        state.apply(.invalid)
        XCTAssertEqual(state.phase, .failed, "畸形 JSON 是可重试失败，不能按非词条静默收起")
        XCTAssertFalse(state.notAWord, "invalid 不设 notAWord——生词本入口不因此收起")
    }

    func testApplyAfterTerminalPhaseIsIgnored() {
        var state = PanelDictState()
        state.begin(query: "hello", dictEnabled: true, lookupLike: true)
        state.apply(.card(makeCard()))
        state.apply(.notAWord) // 过期响应
        XCTAssertEqual(state.phase, .ready)
        XCTAssertNotNil(state.card)
    }

    // MARK: - fail / retry

    func testNetworkFailureBecomesRetryable() {
        var state = PanelDictState()
        state.begin(query: "hello", dictEnabled: true, lookupLike: true)
        state.fail()
        XCTAssertEqual(state.phase, .failed)
        XCTAssertEqual(state.query, "hello", "失败后保留查询词供重试")
    }

    func testRetryRequeriesSameWord() {
        var state = PanelDictState()
        state.begin(query: "hello", dictEnabled: true, lookupLike: true)
        state.fail()
        state.retry()
        XCTAssertEqual(state.phase, .querying)
        XCTAssertEqual(state.query, "hello")
        XCTAssertNil(state.card)
        // 重试后拿到卡片 → ready（网络恢复后重试可出卡）
        state.apply(.card(makeCard()))
        XCTAssertEqual(state.phase, .ready)
    }

    func testRetryOnlyFromFailed() {
        var state = PanelDictState()
        state.begin(query: "hello", dictEnabled: true, lookupLike: true)
        state.retry() // querying 态重试无效
        XCTAssertEqual(state.phase, .querying)

        state.apply(.notAWord)
        state.retry() // notAWord 收起后无重试入口
        XCTAssertEqual(state.phase, .hidden)
    }

    // MARK: - collapse（接口未配置）

    func testCollapseKeepsNotAWord() {
        var state = PanelDictState()
        state.begin(query: "hello", dictEnabled: true, lookupLike: true)
        state.apply(.notAWord)
        state.collapse()
        XCTAssertEqual(state.phase, .hidden)
        XCTAssertTrue(state.notAWord, "同一词的判定不因配置问题翻案")
        XCTAssertEqual(state.query, "")
    }

    func testBeginResetsNotAWordOnNewTranslation() {
        var state = PanelDictState()
        state.begin(query: "hello", dictEnabled: true, lookupLike: true)
        state.apply(.notAWord)
        XCTAssertTrue(state.notAWord)
        // 同词重译：重新判定（期间生词本入口恢复出现）
        state.begin(query: "hello", dictEnabled: true, lookupLike: true)
        XCTAssertFalse(state.notAWord)
        XCTAssertEqual(state.phase, .querying)
    }

    // MARK: - 生词本入口可见性

    func testVocabEntryVisibleFollowsLookupShapeAndNotAWord() {
        XCTAssertTrue(PanelDictState.vocabEntryVisible(original: "hello", notAWord: false))
        XCTAssertFalse(PanelDictState.vocabEntryVisible(original: "hello", notAWord: true))
        XCTAssertFalse(PanelDictState.vocabEntryVisible(original: "This is a full sentence.", notAWord: false),
                       "整句文本不出现生词本入口")
        XCTAssertTrue(PanelDictState.vocabEntryVisible(original: "短语查词", notAWord: false),
                      "CJK ≤6 字是词条形状")
    }

    // MARK: - 阅读室查词序号守卫（READ-9，DictLookupSequence）

    func testLookupSequenceBeginIsMonotonic() {
        var seq = DictLookupSequence()
        XCTAssertEqual(seq.latest, 0, "未发过查词时序号为 0")
        XCTAssertEqual(seq.begin(), 1)
        XCTAssertEqual(seq.begin(), 2)
        XCTAssertEqual(seq.latest, 2)
    }

    func testSlowOlderLookupDoesNotOverrideNewerWord() {
        // 连续查两词：慢的旧结果（slow）迟到时面板已被新词（fast）接管。
        var seq = DictLookupSequence()
        let slow = DictLookupSequence.Ticket(runID: seq.begin(), query: "slow", sentenceIdx: 3, articleID: "a1")
        let fast = DictLookupSequence.Ticket(runID: seq.begin(), query: "fast", sentenceIdx: 3, articleID: "a1")
        XCTAssertFalse(seq.accepts(slow, panelLoading: ("fast", 3), currentArticleID: "a1"),
                       "旧词的迟到结果不得覆盖新词的 loading/ready/error 态")
        XCTAssertTrue(seq.accepts(fast, panelLoading: ("fast", 3), currentArticleID: "a1"),
                      "最新请求在面板仍为其 loading 态时允许写回")
    }

    func testSameWordRelookupStillRejectsStaleRun() {
        // 同词同句连查两次：面板参数完全一样，仍以序号分新旧（旧 Task 已被 cancel）。
        var seq = DictLookupSequence()
        let first = DictLookupSequence.Ticket(runID: seq.begin(), query: "hello", sentenceIdx: 0, articleID: "a1")
        let second = DictLookupSequence.Ticket(runID: seq.begin(), query: "hello", sentenceIdx: 0, articleID: "a1")
        XCTAssertFalse(seq.accepts(first, panelLoading: ("hello", 0), currentArticleID: "a1"))
        XCTAssertTrue(seq.accepts(second, panelLoading: ("hello", 0), currentArticleID: "a1"))
    }

    func testPanelMovedOnDropsLateResult() {
        var seq = DictLookupSequence()
        let ticket = DictLookupSequence.Ticket(runID: seq.begin(), query: "hello", sentenceIdx: 0, articleID: "a1")
        // 切句重查：同词换句（sentenceIdx 变）→ 迟到结果作废
        XCTAssertFalse(seq.accepts(ticket, panelLoading: ("hello", 5), currentArticleID: "a1"),
                       "切句后迟到结果被丢弃")
        // 点词块即时卡 / 手动关闭：面板不再是 loading → 作废
        XCTAssertFalse(seq.accepts(ticket, panelLoading: nil, currentArticleID: "a1"),
                       "面板已被即时卡或关闭接管时迟到结果被丢弃")
        // 面板仍是该请求的 loading 态 → 允许
        XCTAssertTrue(seq.accepts(ticket, panelLoading: ("hello", 0), currentArticleID: "a1"))
    }

    func testArticleSwitchDropsLateResult() {
        var seq = DictLookupSequence()
        let ticket = DictLookupSequence.Ticket(runID: seq.begin(), query: "hello", sentenceIdx: 0, articleID: "a1")
        XCTAssertFalse(seq.accepts(ticket, panelLoading: ("hello", 0), currentArticleID: "a2"),
                       "切文章后迟到结果被丢弃")
        XCTAssertFalse(seq.accepts(ticket, panelLoading: ("hello", 0), currentArticleID: nil),
                       "文章被关掉（nil）同样作废")
        XCTAssertTrue(seq.accepts(ticket, panelLoading: ("hello", 0), currentArticleID: "a1"))
    }

    func testLookupSequenceIsIndependentFromPanelPrefetchState() {
        // 词典卡预取链路（TranslationPanel 的 PanelDictState）与阅读室序号守卫互不相干：
        // 序号推进不改预取状态机，预取状态机也不影响序号判定。
        var panel = PanelDictState()
        panel.begin(query: "hello", dictEnabled: true, lookupLike: true)
        var seq = DictLookupSequence()
        let ticket = DictLookupSequence.Ticket(runID: seq.begin(), query: "hello", sentenceIdx: 0, articleID: nil)
        XCTAssertEqual(panel.phase, .querying)
        XCTAssertTrue(seq.accepts(ticket, panelLoading: ("hello", 0), currentArticleID: nil))
        panel.apply(.card(makeCard()))
        XCTAssertEqual(panel.phase, .ready)
        XCTAssertEqual(seq.latest, 1)
    }
}
