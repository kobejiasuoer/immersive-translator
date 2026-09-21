import XCTest
@testable import ReaderCore

/// 口语陪练（P5）：场景元数据 / prompt 构造 / 回复解析 / 会话构造。

final class SpeakTests: XCTestCase {
    func testScenarioAndDifficultyLookup() {
        XCTAssertEqual(scenarioOf(.ordering).label, "点餐")
        XCTAssertEqual(scenarioOf(.travel).emoji, "✈️")
        XCTAssertEqual(difficultyOf(.hard).label, "进阶")
        XCTAssertEqual(difficultyOf(.easy).note.contains("简单"), true)
    }

    func testNewSpeakSessionOpensWithAssistantOpener() {
        let s = newSpeakSession(.interview, .medium, now: 1000)
        XCTAssertEqual(s.turns.count, 1)
        XCTAssertEqual(s.turns[0].role, .assistant)
        XCTAssertEqual(s.turns[0].text, scenarioOf(.interview).opener)
        XCTAssertEqual(s.turns[0].hintZh, scenarioOf(.interview).openerZh)
        XCTAssertTrue(s.id.hasPrefix("s"))
        XCTAssertEqual(s.createdAt, 1000)
    }

    func testBuildSpeakSystemPromptContainsScenarioBrief() {
        let prompt = buildSpeakSystemPrompt(.ordering, .easy)
        XCTAssertTrue(prompt.contains("服务员"))
        XCTAssertTrue(prompt.contains("最简单"))
        XCTAssertTrue(prompt.contains("\"EN: \""))
        XCTAssertTrue(prompt.contains("\"ZH: \""))
    }

    func testBuildSpeakUserInputRollsRecentTurns() {
        let turns = [
            SpeakTurn(role: .assistant, text: "Hello!", at: 1),
            SpeakTurn(role: .user, text: "Hi.", at: 2),
        ]
        let input = buildSpeakUserInput(turns, "I want coffee")
        XCTAssertTrue(input.contains("你: Hello!"))
        XCTAssertTrue(input.contains("我: Hi."))
        XCTAssertTrue(input.hasSuffix("请给出你的下一轮回复（EN: + ZH: 两行）。"))
    }

    func testParseAssistantReplyStandardTwoLines() {
        let (en, zh) = parseAssistantReply("EN: Sure, one latte coming up! Anything else?\nZH: 好的拿铁马上来，还要别的吗（可以说 That's all）")
        XCTAssertEqual(en, "Sure, one latte coming up! Anything else?")
        XCTAssertEqual(zh, "好的拿铁马上来，还要别的吗（可以说 That's all）")
    }

    func testParseAssistantReplyTolerantForms() {
        // 全角冒号 + 代码块围栏
        let (en1, zh1) = parseAssistantReply("```\nEN：Here you go.\nZH：给你。\n```")
        XCTAssertEqual(en1, "Here you go.")
        XCTAssertEqual(zh1, "给你。")
        // 只有 EN（ZH 缺省）
        let (en2, zh2) = parseAssistantReply("EN: Just water, please.")
        XCTAssertEqual(en2, "Just water, please.")
        XCTAssertEqual(zh2, "")
        // 完全没有标记：全文当英文，不丢内容
        let (en3, _) = parseAssistantReply("No markers at all here.")
        XCTAssertEqual(en3, "No markers at all here.")
        // 多余空白折叠
        let (en4, _) = parseAssistantReply("EN:  multiple   spaces  ")
        XCTAssertEqual(en4, "multiple spaces")
    }

    func testLastAssistantText() {
        let turns = [
            SpeakTurn(role: .assistant, text: "First.", at: 1),
            SpeakTurn(role: .user, text: "ok", at: 2),
            SpeakTurn(role: .assistant, text: "Second.", at: 3),
        ]
        XCTAssertEqual(lastAssistantText(turns), "Second.")
        XCTAssertNil(lastAssistantText([SpeakTurn(role: .user, text: "x", at: 4)]))
    }

    func testSpeakSessionCodableRoundtrip() throws {
        var turn = SpeakTurn(role: .assistant, text: "Hello", hintZh: "你好", at: 42)
        turn.shadowScore = 4.3
        let session = SpeakSession(
            id: "s1", scenario: .smalltalk, difficulty: .hard,
            turns: [turn, SpeakTurn(role: .user, text: "hi", at: 43)],
            createdAt: 42, updatedAt: 43
        )
        let encoder = JSONEncoder()
        let data = try encoder.encode(session)
        let json = String(data: data, encoding: .utf8) ?? ""
        XCTAssertTrue(json.contains("\"hintZh\""))
        XCTAssertTrue(json.contains("\"shadowScore\""))
        XCTAssertTrue(json.contains("\"smalltalk\""))
        XCTAssertTrue(json.contains("\"createdAt\""))
        XCTAssertFalse(json.contains("\"role\":\"assistant\",\"text\":\"hi\""))  // user 轮无 hint
        let back = try JSONDecoder().decode(SpeakSession.self, from: data)
        XCTAssertEqual(back, session)
    }

    func testSpeakSessionsFileToleratesMissingFields() throws {
        let json = #"{"schemaVersion":1,"sessions":[]}"#
        let file = try JSONDecoder().decode(SpeakSessionsFile.self, from: Data(json.utf8))
        XCTAssertEqual(file.schemaVersion, 1)
        XCTAssertTrue(file.sessions.isEmpty)
    }
}
