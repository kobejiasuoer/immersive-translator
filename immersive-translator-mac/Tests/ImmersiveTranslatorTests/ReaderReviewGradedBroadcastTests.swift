import XCTest
import ReaderCore
@testable import ImmersiveTranslator

/// QA BUG-011 防回归：快速复习窗评分后阅读室「笔记与复习」不刷新——
/// 已评词仍显示到期、可被重复复习（sqlite 已落库、阅读室窗口是旧状态）。
/// 根因 = QuickReviewWindow.grade 落库后只刷托盘角标，无跨窗广播；阅读室 VM
/// 只订阅 .readerVocabAdded/.learningSyncComplete，评分不属二者。
/// 修复 = 新增 .readerReviewGraded 广播（grade 两条落库路径都发）+ 阅读室 VM
/// 订阅后 refreshVocab。本用例验证订阅侧接线：后台改库 → 广播 → VM 状态更新
/// （已评词退出到期队列）。发帖侧在 QuickReviewWindow.grade（走 ReaderStore.shared
/// 真实用户库，不适合单测直评，由构建 + 全量套件与 GUI 复测覆盖）。
final class ReaderReviewGradedBroadcastTests: XCTestCase {

    private final class StubChat: ReaderChatChannel {
        var glossaryText: String { "" }
        var customStyle: String { "" }
        func configuration() throws -> ReaderChatClient.Configuration {
            throw ReaderChatClient.ReaderChatError.missingAPIKey
        }
        func resolveTarget(for sample: String) -> String { "简体中文" }
        func complete(systemPrompt: String, userText: String) async throws -> String { "" }
        func completeStreaming(
            systemPrompt: String,
            userText: String,
            onDelta: @escaping (String) -> Void
        ) async throws -> String {
            throw ReaderChatClient.ReaderChatError.missingAPIKey
        }
    }

    private let nowMs = Int64(Date().timeIntervalSince1970 * 1_000)

    @MainActor
    private func makeVM() -> ReaderViewModel {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("review-graded-broadcast-\(UUID().uuidString)", isDirectory: true)
        return ReaderViewModel(chat: StubChat(), store: ReaderStore(baseDirectory: dir))
    }

    @MainActor
    private func waitUntil(
        _ what: String,
        timeoutMs: Int = 2_000,
        _ cond: @escaping @MainActor () -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1_000)
        while Date() < deadline {
            if cond() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("等待「\(what)」超时")
    }

    /// 后台把词改成「已评完（到期时间推到未来）」，再发 .readerReviewGraded：
    /// 阅读室 VM 必须刷新词表——该词退出到期队列（评分前它显示到期）。
    @MainActor
    func testReaderReviewGradedRefreshesVocabAndDueQueue() async throws {
        let vm = makeVM()
        let word = VocabWord(
            id: "graded-w1",
            word: "resilient",
            kind: .word,
            senses: [VocabSense(pos: "adj.", cn: "有韧性的")],
            source: VocabSource(articleId: "", sentenceIdx: 0),
            srs: VocabSrsState(dueAt: nowMs - 10_000), // 到期
            addedAt: nowMs
        )
        try vm.store.saveVocabWord(word)
        vm.refreshVocab()
        XCTAssertTrue(vm.vocabWords.contains { $0.id == "graded-w1" }, "前置：词已在阅读室词表")
        XCTAssertTrue(vm.dueWords.contains { $0.id == "graded-w1" }, "前置：评分前该词显示到期")

        // 模拟快速复习窗评分落库（gradeVocabWord/saveVocabWord 归并后的快照）：
        // dueAt 推到 30 天后 = 不再到期。
        var graded = word
        graded.srs = VocabSrsState(intervalDays: 30, reps: 1, dueAt: nowMs + 30 * 24 * 3_600 * 1_000)
        try vm.store.saveVocabWord(graded)

        NotificationCenter.default.post(
            name: .readerReviewGraded,
            object: nil,
            userInfo: ["wordId": "graded-w1"]
        )

        await waitUntil("评分广播后的词表刷新") {
            vm.vocabWords.first { $0.id == "graded-w1" }?.srs.dueAt == graded.srs.dueAt
        }
        XCTAssertFalse(vm.dueWords.contains { $0.id == "graded-w1" }, "已评词不得继续显示到期")
    }

    /// 对照组：不发广播时后台落库不会自动进场（锁定广播是唯一触发源，
    /// 防止测试因别的隐式刷新路径而假绿）。
    @MainActor
    func testWithoutBroadcastVocabStaysStale() async throws {
        let vm = makeVM()
        let word = VocabWord(
            id: "stale-w1",
            word: "stubborn",
            kind: .word,
            senses: [VocabSense(pos: "adj.", cn: "顽固的")],
            source: VocabSource(articleId: "", sentenceIdx: 0),
            srs: VocabSrsState(dueAt: nowMs + 60_000),
            addedAt: nowMs
        )
        try vm.store.saveVocabWord(word)
        vm.refreshVocab()
        XCTAssertEqual(vm.vocabWords.count, 1)

        var second = word
        second.id = "stale-w2"
        second.word = "obstinate"
        try vm.store.saveVocabWord(second)

        // 短暂等待：无广播、无其他触发源 → 不应出现任何刷新。
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(vm.vocabWords.count, 1, "无广播时词表应保持旧状态（BUG-011 的病灶本身）")
    }
}
