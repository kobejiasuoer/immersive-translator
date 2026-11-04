import XCTest
import ReaderCore
@testable import ImmersiveTranslator

/// 「笔记与复习」四态与入口映射（2026-10-26 改版，§2.4 测试组 1；对齐 Windows
/// VaultPage.test.tsx「三态入口与 Hero」组 + ReaderApp.tsx:1807-1842 入口函数）：
/// - openReview → home、openNotes → notes、startFocusReview → focus、导出 → export；
/// - 导航岛 vault 档进入不重置档位（已在 vault 内跨视图保留）；
/// - Esc 只切档不清 focusReviewIds（专注队列续跑）；
/// - 底部切换器三档文案（复习首页 / 专注复习 / 导出）。
final class ReaderVaultFourStateTests: XCTestCase {
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

    @MainActor
    private func makeVM() -> ReaderViewModel {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("vault-four-state-\(UUID().uuidString)", isDirectory: true)
        return ReaderViewModel(chat: StubChat(), store: ReaderStore(baseDirectory: dir))
    }

    private func keyDown(_ keyCode: UInt16, _ characters: String) -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: 0, context: nil, characters: characters,
            charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode
        )!
    }

    private var escape: NSEvent { keyDown(53, "\u{1B}") }

    // MARK: - 四值路由 + 四态枚举

    @MainActor
    func testRouteIsFourValuedAndVaultKindFolds() {
        // review/notes 旧路由已删除：Route 只剩 shelf/reading/speak/vault（ReaderApp.tsx:155）。
        XCTAssertEqual(ReaderViewModel.Route.vault.kind, .vault)
        XCTAssertEqual(IslandSurface(folding: ReaderViewModel.Route.vault.kind), .vault)
        XCTAssertEqual(ReaderRouteKind.allCases, [.shelf, .reading, .speak, .vault])
        // 顶栏面名：vault →「笔记与复习」。
        XCTAssertEqual(ReaderRouteKind.vault.surfaceTitle(articleTitle: nil), "笔记与复习")
        XCTAssertEqual(ReaderRouteKind.vault.folioTriggerLabel(articleTitle: nil), "书架 · 笔记与复习")
    }

    @MainActor
    func testVaultPlayModeDefaultsToHome() {
        let vm = makeVM()
        XCTAssertEqual(vm.vaultPlayMode, .home, "Windows vaultMode 初值 home")
        XCTAssertEqual(vm.route, .shelf, "启动默认整页书架")
        XCTAssertEqual(ReaderViewModel.VaultPlayMode.allCases, [.home, .notes, .focus, .export])
    }

    // MARK: - 入口映射

    @MainActor
    func testOpenReviewLandsHome() {
        let vm = makeVM()
        vm.vaultPlayMode = .export
        vm.focusReviewIds = ["x"]
        vm.openReview()
        XCTAssertEqual(vm.route, .vault)
        XCTAssertEqual(vm.vaultPlayMode, .home, "goReview → vaultMode home")
        XCTAssertNil(vm.focusReviewIds, "复习入口清加练批次（Windows goReview setFocusIds(null)）")
        XCTAssertEqual(vm.reviewPos, 0)
    }

    @MainActor
    func testOpenNotesLandsNotes() {
        let vm = makeVM()
        vm.openNotes()
        XCTAssertEqual(vm.route, .vault)
        XCTAssertEqual(vm.vaultPlayMode, .notes, "goNotes → vaultMode notes")
    }

    @MainActor
    func testStartFocusReviewLandsFocusWithIds() {
        let vm = makeVM()
        vm.startFocusReview(ids: ["take root", "unwind"])
        XCTAssertEqual(vm.route, .vault)
        XCTAssertEqual(vm.vaultPlayMode, .focus, "startFocusReview → vaultMode focus")
        XCTAssertEqual(vm.focusReviewIds, ["take root", "unwind"])
        XCTAssertEqual(vm.reviewPos, 0)
    }

    @MainActor
    func testStartFocusReviewEmptyIdsToastsAndStays() {
        let vm = makeVM()
        vm.route = .reading
        vm.startFocusReview(ids: [])
        XCTAssertEqual(vm.toast, "这篇笔记的词这一轮都通过了，没有要补的")
        XCTAssertEqual(vm.route, .reading, "空数组不切视图")
        XCTAssertNil(vm.focusReviewIds)
    }

    @MainActor
    func testExportModeIsReachableAndSwitchLabels() {
        let vm = makeVM()
        vm.openReview()
        // 首页「导出笔记」按钮 → onModeChange("export")：档位切换不动路由。
        vm.vaultPlayMode = .export
        XCTAssertEqual(vm.route, .vault)
        XCTAssertEqual(vm.vaultPlayMode, .export)
        // 底部快捷切换器三档文案（notes 不在切换器里）。
        XCTAssertEqual(ReaderViewModel.VaultPlayMode.home.switchLabel, "复习首页")
        XCTAssertEqual(ReaderViewModel.VaultPlayMode.focus.switchLabel, "专注复习")
        XCTAssertEqual(ReaderViewModel.VaultPlayMode.export.switchLabel, "导出")
        XCTAssertNil(ReaderViewModel.VaultPlayMode.notes.switchLabel)
    }

    // MARK: - 导航岛进入不重置档位

    @MainActor
    func testNavigateToVaultKeepsCurrentMode() {
        let vm = makeVM()
        vm.openReview()
        vm.vaultPlayMode = .export
        vm.navigate(to: .vault)
        XCTAssertEqual(vm.vaultPlayMode, .export, "已在 vault 内：navigateSurface(vault) 不重置 vaultMode")
        XCTAssertEqual(vm.route, .vault)

        // 跨视图进入也保留上次档位（离开 vault 不重置）。
        vm.openSpeak()
        XCTAssertEqual(vm.route, .speak)
        vm.navigate(to: .vault)
        XCTAssertEqual(vm.route, .vault)
        XCTAssertEqual(vm.vaultPlayMode, .export, "跨视图回 vault 保留上次档位")
    }

    @MainActor
    func testVaultFocusModeFlagOnlyWhenVaultAndFocus() {
        let vm = makeVM()
        vm.startFocusReview(ids: ["a"])
        XCTAssertTrue(vm.vaultFocusMode, "vault + focus → 顶栏中岛隐藏的 focusMode")
        vm.vaultPlayMode = .home
        XCTAssertFalse(vm.vaultFocusMode)
        vm.vaultPlayMode = .focus
        vm.route = .reading
        XCTAssertFalse(vm.vaultFocusMode, "离开 vault 路由不算 focusMode")
    }

    // MARK: - Esc 只切档不清 focusIds

    @MainActor
    func testEscapeExitsFocusModeKeepingFocusIds() {
        let vm = makeVM()
        vm.startFocusReview(ids: ["take root"])
        XCTAssertTrue(vm.handleKeyDown(escape), "focus 态 Esc 应被消费")
        XCTAssertEqual(vm.vaultPlayMode, .home, "Esc → onModeChange(home)")
        XCTAssertEqual(vm.focusReviewIds, ["take root"], "Esc 只切档不清 focusIds（专注队列续跑）")
        XCTAssertEqual(vm.route, .vault)
        // 再按 Esc：无浮层、非 focus → 不消费。
        XCTAssertFalse(vm.handleKeyDown(escape))
    }

    @MainActor
    func testEscapeClosesOverlayBeforeExitingFocus() {
        // 浮层链在前：设置抽屉开着时第一次 Esc 收抽屉，focus 态不受影响。
        let vm = makeVM()
        vm.startFocusReview(ids: ["take root"])
        vm.settingsDrawerShown = true
        XCTAssertTrue(vm.handleKeyDown(escape))
        XCTAssertFalse(vm.settingsDrawerShown)
        XCTAssertEqual(vm.vaultPlayMode, .focus, "第一次 Esc 只收最上层浮层")
        XCTAssertTrue(vm.handleKeyDown(escape))
        XCTAssertEqual(vm.vaultPlayMode, .home, "第二次 Esc 退出专注")
    }

    // MARK: - 显式退出加练 / 离开 vault 清批次

    @MainActor
    func testExitFocusAndLeavingVaultClearFocusIds() {
        let vm = makeVM()
        vm.startFocusReview(ids: ["take root"])
        vm.exitFocus()
        XCTAssertNil(vm.focusReviewIds, "rail「退出」回全局到期队列")

        vm.startFocusReview(ids: ["take root"])
        vm.openReading()
        XCTAssertNil(vm.focusReviewIds, "goReading 清加练批次（Windows goReading setFocusIds(null)）")
        vm.startFocusReview(ids: ["take root"])
        vm.openShelf()
        XCTAssertNil(vm.focusReviewIds, "goShelf 清加练批次")
    }
}
