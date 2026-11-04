import XCTest
import ReaderCore
@testable import ImmersiveTranslator

/// 书架发现三列直达与 openImport(tab:) 白名单（§2.4 测试组 6；对齐 Windows
/// ReaderApp.tsx:211-222 IMPORT_OPEN_TABS + :376-379 openImport 与 ShelfPage.tsx:642-666）：
/// - 白名单外的值（含 onClick 直传事件对象的等效输入：任意非 tab 字符串 / nil）回落 lib；
/// - 三列 tab 参数 discover / feed / lib 逐值透传；无书空卡直达 epub；
/// - 每次重开弹窗以注入 tab 为初值（ReaderImportSheet.IntakeTab(importTab:) 映射）。
final class ShelfDiscDirectAccessTests: XCTestCase {
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
            .appendingPathComponent("shelf-disc-\(UUID().uuidString)", isDirectory: true)
        return ReaderViewModel(chat: StubChat(), store: ReaderStore(baseDirectory: dir))
    }

    // MARK: - 白名单（纯逻辑）

    func testResolveImportOpenTabWhitelist() {
        for tab in ReaderImportTab.allCases {
            XCTAssertEqual(resolveImportOpenTab(tab.rawValue), tab, "白名单内逐值透传：\(tab.rawValue)")
        }
        XCTAssertEqual(resolveImportOpenTab(nil), .lib, "缺省文库")
        // onClick 直传事件对象的等效输入：任意不在集合里的字符串一律回落 lib。
        XCTAssertEqual(resolveImportOpenTab("[object MouseEvent]"), .lib)
        XCTAssertEqual(resolveImportOpenTab(""), .lib)
        XCTAssertEqual(resolveImportOpenTab("LIB"), .lib, "大小写不匹配也按非法值处理")
        XCTAssertEqual(ReaderImportTab.allCases.map(\.rawValue), ["lib", "epub", "file", "url", "paste", "discover", "feed"])
    }

    // MARK: - vm.openImport(tab:)

    @MainActor
    func testOpenImportDefaultsToLibAndShowsSheet() {
        let vm = makeVM()
        vm.openImport()
        XCTAssertTrue(vm.importSheetShown)
        XCTAssertEqual(vm.importInitialTab, .lib)
    }

    @MainActor
    func testOpenImportPassesDiscoverFeedLib() {
        let vm = makeVM()
        // 发现三列：精选经典 → discover、英文资讯订阅 → feed、导入自己的内容 → lib。
        vm.openImport(tab: "discover")
        XCTAssertEqual(vm.importInitialTab, .discover)
        vm.openImport(tab: "feed")
        XCTAssertEqual(vm.importInitialTab, .feed)
        vm.openImport(tab: "lib")
        XCTAssertEqual(vm.importInitialTab, .lib)
        // 无书空卡直达 epub。
        vm.openImport(tab: "epub")
        XCTAssertEqual(vm.importInitialTab, .epub)
    }

    @MainActor
    func testOpenImportRejectsIllegalValueFallsBackToLib() {
        let vm = makeVM()
        vm.openImport(tab: "discover")
        XCTAssertEqual(vm.importInitialTab, .discover)
        // 非法值：回落 lib（不能把上一次的 discover 留着，也不能让弹窗 tab 全不命中）。
        vm.openImport(tab: "[object MouseEvent]")
        XCTAssertEqual(vm.importInitialTab, .lib)
        XCTAssertTrue(vm.importSheetShown)
    }

    @MainActor
    func testFolioImportEntryUsesDefaultLibAndClosesFolio() {
        let vm = makeVM()
        vm.openImport(tab: "feed")
        vm.folioOpen = true
        vm.openImportFromFolio()
        XCTAssertEqual(vm.importInitialTab, .lib, "书架浮层「＋ 导入文件」不带 tab → 缺省文库")
        XCTAssertFalse(vm.folioOpen)
        XCTAssertTrue(vm.importSheetShown)
    }

    // MARK: - 弹窗初值映射（每次重开以注入 tab 为初值）

    func testIntakeTabMapsEverySevenValues() {
        XCTAssertEqual(ReaderImportSheet.IntakeTab(importTab: .lib), .lib)
        XCTAssertEqual(ReaderImportSheet.IntakeTab(importTab: .epub), .epub)
        XCTAssertEqual(ReaderImportSheet.IntakeTab(importTab: .file), .file)
        XCTAssertEqual(ReaderImportSheet.IntakeTab(importTab: .url), .url)
        XCTAssertEqual(ReaderImportSheet.IntakeTab(importTab: .paste), .paste)
        XCTAssertEqual(ReaderImportSheet.IntakeTab(importTab: .discover), .discover)
        XCTAssertEqual(ReaderImportSheet.IntakeTab(importTab: .feed), .feed)
        // tab 条列渲染照抄 Windows 七档文案。
        XCTAssertEqual(
            ReaderImportSheet.IntakeTab.allCases.map(\.rawValue),
            ["内置文库", "EPUB / 长书", "本地文件", "网页链接", "粘贴文本", "发现书库", "资讯订阅"]
        )
    }
}
