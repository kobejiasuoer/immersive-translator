import XCTest
import SwiftUI
@testable import ImmersiveTranslator

/// R2-PANEL 批次（PANEL-9/10/11/12）的应用层单测：
/// - PANEL-11：复制双语格式对齐 Windows `${original}\n\n${translation}`；原文块默认展开。
/// - PANEL-12：品牌行来源 chip 的来源映射与系统语义色；状态点随状态供色、几何/时长对账 Windows .dot-pulse。
/// - PANEL-9：历史窗批量选择纯逻辑（裁剪/全选/顺序/空行连接）与批量删除逐条走现有单删路径。
final class TranslationPanelR2PanelTests: XCTestCase {
    // MARK: - PANEL-11 复制格式 / 原文默认展开

    func testBilingualCopyIsPlainOriginalBlankLineTranslation() {
        let text = TranslationPanelCopyFormat.bilingual(original: "Hello world", translation: "你好，世界")
        XCTAssertEqual(text, "Hello world\n\n你好，世界", "应为 原文、空行、译文 的纯文本")
        XCTAssertFalse(text.contains("原文："), "不应再带「原文：」标签前缀")
        XCTAssertFalse(text.contains("译文："), "不应再带「译文：」标签前缀")
    }

    func testBilingualCopyKeepsMultilineBodiesIntact() {
        let text = TranslationPanelCopyFormat.bilingual(original: "line 1\nline 2", translation: "第一行\n第二行")
        XCTAssertEqual(text, "line 1\nline 2\n\n第一行\n第二行")
        XCTAssertEqual(text.components(separatedBy: "\n\n").count, 2, "原文与译文之间恰好一处空行分隔")
    }

    @MainActor
    func testOriginalBlockExpandedByDefault() {
        let model = TranslationPanelModel()
        XCTAssertTrue(model.showOriginal, "done 态原文 DisclosureGroup 默认展开（PANEL-11）")
        XCTAssertEqual(model.sourceChip, .none, "未设置来源前不显示来源 chip")
    }

    // MARK: - PANEL-12 来源 chip / 状态点

    func testSourceChipMapsTranslationSources() {
        XCTAssertEqual(TranslationPanelSourceChip.make(from: nil), .none)
        XCTAssertEqual(TranslationPanelSourceChip.make(from: .screenshotOCR), .ocr)
        XCTAssertEqual(TranslationPanelSourceChip.make(from: .selection), .selection)
        XCTAssertEqual(TranslationPanelSourceChip.make(from: .retry), .selection, "重译仍是划词流程")
        XCTAssertEqual(TranslationPanelSourceChip.make(from: .panel), .selection, "浮窗内发起仍按划词来源展示")
    }

    func testSourceChipLabelsAndSemanticTints() {
        XCTAssertEqual(TranslationPanelSourceChip.selection.label, "划词")
        XCTAssertEqual(TranslationPanelSourceChip.ocr.label, "OCR")
        XCTAssertEqual(TranslationPanelSourceChip.none.label, "")
        // Windows chip-blue（accent）/ chip-amber（warn）→ Mac 系统强调色 / orange 语义色。
        XCTAssertEqual(TranslationPanelSourceChip.selection.tint, Color.accentColor)
        XCTAssertEqual(TranslationPanelSourceChip.ocr.tint, Color.orange)
        XCTAssertFalse(TranslationPanelSourceChip.selection.help.isEmpty)
        XCTAssertFalse(TranslationPanelSourceChip.ocr.help.isEmpty)
    }

    func testStatusDotColorFollowsPanelStatus() {
        XCTAssertEqual(TranslationPanelStatusDot.color(for: .loading), Color.blue, "loading 蓝")
        XCTAssertEqual(TranslationPanelStatusDot.color(for: .success), Color.green, "done 绿")
        XCTAssertEqual(TranslationPanelStatusDot.color(for: .error), Color.red, "error 红")
        XCTAssertEqual(TranslationPanelStatusDot.color(for: .warning), Color.orange)
        XCTAssertNotEqual(
            TranslationPanelStatusDot.color(for: .loading),
            TranslationPanelStatusDot.color(for: .success),
            "状态点颜色必须随状态变化"
        )
    }

    func testStatusDotGeometryMatchesWindowsDotPulse() {
        // Windows styles.css .panel-title .dot-pulse：6px 圆点；@keyframes pulse 1.6s。
        XCTAssertEqual(TranslationPanelStatusDot.diameter, 6)
        XCTAssertEqual(TranslationPanelStatusDot.pulseDuration, 1.6, accuracy: 0.0001)
        XCTAssertGreaterThan(TranslationPanelStatusDot.haloScale, 1, "呼吸光晕向外扩散")
    }

    // MARK: - PANEL-9 批量选择纯逻辑

    private func makeRecord(_ original: String, _ translation: String, favorite: Bool = false) -> TranslationRecord {
        TranslationRecord(
            id: UUID(),
            createdAt: Date(),
            original: original,
            translation: translation,
            targetLanguage: "中文",
            source: .selection,
            isFavorite: favorite
        )
    }

    func testPrunedSelectionDropsInvisibleIDs() {
        let a = makeRecord("a", "甲")
        let b = makeRecord("b", "乙")
        let gone = makeRecord("c", "丙")
        let pruned = HistoryBatchSelection.pruned([a.id, b.id, gone.id], visibleRecords: [a, b])
        XCTAssertEqual(pruned, [a.id, b.id])
        XCTAssertEqual(HistoryBatchSelection.pruned([], visibleRecords: [a, b]), [])
        XCTAssertEqual(HistoryBatchSelection.pruned([a.id], visibleRecords: []), [])
    }

    func testSelectAllToggleAndAllSelectedDetection() {
        let a = makeRecord("a", "甲")
        let b = makeRecord("b", "乙")
        let visible = [a, b]
        XCTAssertFalse(HistoryBatchSelection.isAllSelected([], visibleRecords: visible))
        XCTAssertFalse(HistoryBatchSelection.isAllSelected([a.id], visibleRecords: visible))
        XCTAssertTrue(HistoryBatchSelection.isAllSelected([a.id, b.id], visibleRecords: visible))
        XCTAssertFalse(HistoryBatchSelection.isAllSelected([a.id], visibleRecords: []), "空列表没有「全选」")

        XCTAssertEqual(HistoryBatchSelection.toggledAll([a.id], visibleRecords: visible), [a.id, b.id], "未全选 → 全选可见")
        XCTAssertEqual(HistoryBatchSelection.toggledAll([a.id, b.id], visibleRecords: visible), [], "已全选 → 清除")
    }

    func testSelectedRecordsKeepVisibleOrderAndTranslationsJoinWithBlankLine() {
        let first = makeRecord("one", "一")
        let second = makeRecord("two", "二")
        let third = makeRecord("three", "三")
        let visible = [first, second, third]
        // Set 无序，取出必须按可见顺序。
        let picked = HistoryBatchSelection.selectedRecords([third.id, first.id], visibleRecords: visible)
        XCTAssertEqual(picked.map(\.id), [first.id, third.id])
        XCTAssertEqual(HistoryBatchSelection.translationsText(for: picked), "一\n\n三", "N 条译文以空行分隔")
        XCTAssertEqual(HistoryBatchSelection.translationsText(for: []), "")
        XCTAssertEqual(HistoryBatchSelection.translationsText(for: [second]), "二")
    }

    func testHistoryBilingualTextMatchesWindowsCopyBoth() {
        let record = makeRecord("Good morning", "早上好")
        XCTAssertEqual(HistoryBatchSelection.bilingualText(for: record), "Good morning\n\n早上好")
    }

    // MARK: - PANEL-9 批量删除逐条走现有单删路径（临时目录，不碰真实历史）

    @MainActor
    private func makeTemporaryStore() -> (TranslationHistoryStore, URL) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("r2-panel-history-\(UUID().uuidString)", isDirectory: true)
        let fileURL = directory.appendingPathComponent("translation-history.json")
        let store = TranslationHistoryStore(fileURL: fileURL)
        return (store, directory)
    }

    @MainActor
    func testBatchDeleteRemovesEachRecordAndPersists() throws {
        let (store, directory) = makeTemporaryStore()
        defer { try? FileManager.default.removeItem(at: directory) }

        let kept = try XCTUnwrap(store.add(original: "keep", translation: "保留", targetLanguage: "中文", source: .selection))
        let gone1 = try XCTUnwrap(store.add(original: "gone one", translation: "删一", targetLanguage: "中文", source: .selection))
        let gone2 = try XCTUnwrap(store.add(original: "gone two", translation: "删二", targetLanguage: "中文", source: .screenshotOCR))
        XCTAssertEqual(store.records.count, 3)

        let deleted = store.delete(recordIDs: [gone1.id, gone2.id, UUID()])
        XCTAssertEqual(deleted, 2, "不存在的 id 静默跳过，只计实际删除条数")
        XCTAssertEqual(store.records.map(\.id), [kept.id])

        // 逐条删除各自落盘：重新加载应只剩保留项。
        let reloaded = TranslationHistoryStore(fileURL: directory.appendingPathComponent("translation-history.json"))
        XCTAssertEqual(reloaded.records.map(\.id), [kept.id])
    }

    @MainActor
    func testSingleDeleteAndRestoreStillWorkAfterBatchAPI() throws {
        let (store, directory) = makeTemporaryStore()
        defer { try? FileManager.default.removeItem(at: directory) }

        let older = try XCTUnwrap(store.add(original: "older", translation: "旧", targetLanguage: "中文", source: .selection))
        let newer = try XCTUnwrap(store.add(original: "newer", translation: "新", targetLanguage: "中文", source: .selection))
        XCTAssertEqual(store.records.map(\.id), [newer.id, older.id])

        // 既有单删路径：返回可撤销记录，位置信息保留。
        let deleted = try XCTUnwrap(store.delete(recordID: older.id))
        XCTAssertEqual(deleted.index, 1)
        XCTAssertEqual(store.records.map(\.id), [newer.id])

        // 既有撤销删除：恢复到原位置。
        store.restoreDeletedRecord(deleted)
        XCTAssertEqual(store.records.map(\.id), [newer.id, older.id])

        // 批量删除空列表是 no-op。
        XCTAssertEqual(store.delete(recordIDs: []), 0)
        XCTAssertEqual(store.records.count, 2)
    }
}
