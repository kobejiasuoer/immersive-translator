import XCTest
import ReaderCore
@testable import ImmersiveTranslator

/// BUG-008 回归：浮窗「自动隐藏」开启后翻译完成即隐藏（<1s），而非 16 秒。
///
/// 根因：scheduleAutoHideIfNeeded 的倒计时任务用 `try? await Task.sleep` —— 任务被
/// cancel 时 CancellationError 被 try? 吞掉，执行落入 orderOut 隐藏块，而隐藏块从不
/// 检查 Task.isCancelled。生产里终态 show 连发两次（App.swift 流式回调 isFinal 一发 +
/// translateText 成功段再一发），第二次 show 的 scheduleAutoHideIfNeeded 会 cancel
/// 第一次的倒计时 → 第一次的任务立即隐藏浮窗。
///
/// 修复：隐藏前检查 Task.isCancelled（取消 = 整段倒计时作废，由新任务重新计时）。
/// 用注入的短延时驱动真实 TranslationPanelController + NSPanel 走完整路径。
final class TranslationPanelAutoHideTests: XCTestCase {

    // MARK: - 夹具

    @MainActor
    private func makeTemporaryHistoryStore() -> (TranslationHistoryStore, URL) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("autohide-history-\(UUID().uuidString)", isDirectory: true)
        let fileURL = directory.appendingPathComponent("translation-history.json")
        let store = TranslationHistoryStore(fileURL: fileURL)
        return (store, directory)
    }

    @MainActor
    private func makeController(historyStore: TranslationHistoryStore,
                                autoHideEnabled: Bool,
                                delayNanoseconds: UInt64) -> TranslationPanelController {
        // 只影响本浮窗的两个键；SettingsStore() 的其余读取沿用进程域既有值
        //（SettingsDangerZoneTests / VoicePrefsTests 已有 SettingsStore() 进测试的先例）。
        UserDefaults.standard.set(autoHideEnabled, forKey: "translationPanelAutoHide")
        UserDefaults.standard.set(false, forKey: "translationPanelPinned")
        let controller = TranslationPanelController(
            settingsStore: SettingsStore(),
            historyStore: historyStore,
            onRetry: { _ in },
            onShowHistory: {},
            onOpenSettings: {},
            onCancelTranslation: {},
            onOCRConfirm: { _ in },
            onOCRReselect: {},
            onRunQuickAction: { _, _, _ in "" },
            onLookupCard: { _ in nil },
            // 本套用例不会触发生词本入口（无用户交互），回调只差一个合法返回值。
            onAddVocab: { _, _, _ in
                CollectVocabOutcome(
                    status: .merged,
                    word: VocabWord(
                        id: "autohide-fixture",
                        word: "autohide-fixture",
                        source: VocabSource(articleId: "", sentenceIdx: 0),
                        srs: VocabSrsState(dueAt: 0),
                        addedAt: 0
                    ),
                    withExample: false
                )
            },
            onSendToReader: { _ in }
        )
        controller.autoHideDelayNanoseconds = delayNanoseconds
        return controller
    }

    /// 私有 panel 用 Mirror 取（测试代码不加生产访问面）。
    @MainActor
    private func panelOf(_ controller: TranslationPanelController) -> NSPanel? {
        Mirror(reflecting: controller).children
            .compactMap { $0.value as? NSPanel }
            .first
    }

    @MainActor
    private func showSuccessPanel(_ controller: TranslationPanelController) {
        controller.show(
            original: "The quick brown fox",
            translation: "QA-MOCK 译文",
            isLoading: false,
            source: .selection,
            status: .success,
            message: "译文已经准备好。",
            targetLanguage: "简体中文",
            reposition: false
        )
    }

    // MARK: - 用例

    /// 生产复现路径：终态 show 连发两次（App 流式 isFinal + 成功段终态）。
    /// 修复前：第二次 show 的 cancel 让第一次倒计时立即隐藏（完成即隐）。
    /// 修复后：取消只作废旧倒计时，浮窗在最后一次终态 show 后满延时才隐藏。
    @MainActor
    func testSecondFinalShowDoesNotHidePanelImmediately() async throws {
        let (historyStore, directory) = makeTemporaryHistoryStore()
        defer { try? FileManager.default.removeItem(at: directory) }

        let delay: UInt64 = 600_000_000 // 0.6s 短延时
        let controller = makeController(historyStore: historyStore, autoHideEnabled: true, delayNanoseconds: delay)
        defer { controller.dismiss() }

        showSuccessPanel(controller)          // 第一次终态 show（旧代码在此武装 16s 倒计时）
        showSuccessPanel(controller)          // 第二次终态 show（旧代码在此 cancel → 立即隐藏）

        try await Task.sleep(nanoseconds: 200_000_000) // 0.2s：远早于 0.6s 延时
        let panel = panelOf(controller)
        let visible = panel?.isVisible ?? false
        XCTAssertTrue(visible, "连续两次终态 show 后浮窗必须仍然可见（旧代码会在 cancel 后立即 orderOut）")

        try await Task.sleep(nanoseconds: delay) // 满延时后再等一小段
        let visibleAfterDelay = panel?.isVisible ?? false
        XCTAssertFalse(visibleAfterDelay, "最后一次终态 show 满延时后应自动隐藏")
    }

    /// 基线：自动隐藏开启 + 单次终态 show → 满延时隐藏（保证修复没有弄丢隐藏本身）。
    @MainActor
    func testSingleFinalShowHidesAfterFullDelay() async throws {
        let (historyStore, directory) = makeTemporaryHistoryStore()
        defer { try? FileManager.default.removeItem(at: directory) }

        let delay: UInt64 = 500_000_000
        let controller = makeController(historyStore: historyStore, autoHideEnabled: true, delayNanoseconds: delay)
        defer { controller.dismiss() }

        showSuccessPanel(controller)
        try await Task.sleep(nanoseconds: 150_000_000)
        let panel = panelOf(controller)
        XCTAssertEqual(panel?.isVisible ?? false, true, "延时未满前应保持可见")

        try await Task.sleep(nanoseconds: delay + 150_000_000)
        XCTAssertEqual(panel?.isVisible ?? false, false, "满延时后应自动隐藏")
    }

    /// 自动隐藏关闭（或错误卡）时不隐藏：guard 不武装倒计时，cancelled-or-not 都不得 orderOut。
    @MainActor
    func testAutoHideDisabledKeepsPanelVisible() async throws {
        let (historyStore, directory) = makeTemporaryHistoryStore()
        defer { try? FileManager.default.removeItem(at: directory) }

        let controller = makeController(historyStore: historyStore, autoHideEnabled: false, delayNanoseconds: 300_000_000)
        defer { controller.dismiss() }

        showSuccessPanel(controller)
        try await Task.sleep(nanoseconds: 500_000_000)
        let panel = panelOf(controller)
        XCTAssertEqual(panel?.isVisible ?? false, true, "自动隐藏关闭时浮窗应保持可见")
    }
}
