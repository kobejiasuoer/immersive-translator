import AppKit
import Carbon
import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 状态栏菜单结构锚定（规格 tray.md §2.1 表；§三验收 1/2/3 的自动化等价）：
// 文案逐字、顺序、分组（动作 | 入口 | 退出）、快捷键提示形态在此钉死，
// 防后续改动漂移出 Windows §8.1 基准。目检项（渲染字形、深浅色）另需人工。
// ---------------------------------------------------------------------------

// AppDelegate 是 @MainActor 隔离，纯函数 statusMenuEntries 随宿主类型在主 actor。
@MainActor
final class StatusMenuStructureTests: XCTestCase {
    private func entries(dueCount: Int = 0) -> [AppDelegate.StatusMenuEntry] {
        AppDelegate.statusMenuEntries(
            selectionShortcut: .optionSpace,
            ocrShortcut: .controlOptionSpace,
            readerShortcut: .controlOptionR,
            dueCount: dueCount
        )
    }

    private func title(_ entry: AppDelegate.StatusMenuEntry) -> String {
        if case .action(let title, _, _, _) = entry.kind { return title }
        return "────────"
    }

    private func key(of entry: AppDelegate.StatusMenuEntry) -> (String, NSEvent.ModifierFlags?)? {
        if case .action(_, _, let key, let modifiers) = entry.kind, let key { return (key, modifiers) }
        return nil
    }

    /// 验收 1+2：全表逐字锚定——动作组六项无内部分隔 → 一条分隔线 → 入口组六项
    /// → 一条分隔线 → 退出；「截图翻译 (OCR)」更名、六处「...」移除、阅读室不简写。
    func test_structureAndTextMatchSpec() {
        XCTAssertEqual(entries(), [
            .init(kind: .action(title: "翻译选中文本", selector: NSSelectorFromString("menuTranslateSelection"), key: " ", modifiers: [.option])),
            .init(kind: .action(title: "截图翻译 (OCR)", selector: NSSelectorFromString("menuTranslateScreenshot"), key: " ", modifiers: [.control, .option])),
            .init(kind: .action(title: "快速复习", selector: NSSelectorFromString("openQuickReview"), key: nil, modifiers: nil)),
            .init(kind: .action(title: "生词本", selector: NSSelectorFromString("openVocabReview"), key: nil, modifiers: nil)),
            .init(kind: .action(title: "录音直译", selector: NSSelectorFromString("toggleLiveCaption"), key: nil, modifiers: nil)),
            .init(kind: .action(title: "沉浸阅读室", selector: NSSelectorFromString("openReader"), key: "r", modifiers: [.control, .option])),
            .init(kind: .separator),
            .init(kind: .action(title: "账号登录", selector: NSSelectorFromString("openAccount"), key: nil, modifiers: nil)),
            .init(kind: .action(title: "翻译历史", selector: NSSelectorFromString("openHistory"), key: nil, modifiers: nil)),
            .init(kind: .action(title: "检查更新", selector: NSSelectorFromString("menuCheckForUpdates"), key: nil, modifiers: nil)),
            .init(kind: .action(title: "设置", selector: NSSelectorFromString("openSettings"), key: ",", modifiers: nil)),
            .init(kind: .action(title: "使用引导", selector: NSSelectorFromString("showOnboarding"), key: nil, modifiers: nil)),
            .init(kind: .action(title: "检查权限", selector: NSSelectorFromString("checkPermissions"), key: nil, modifiers: nil)),
            .init(kind: .separator),
            .init(kind: .action(title: "退出", selector: NSSelectorFromString("quit"), key: "q", modifiers: nil)),
        ])
    }

    /// 验收 1 的分组不变式：全表恰好两条分隔线，位置在动作组后（index 6）与退出前。
    func test_groupIntegrity_exactlyTwoSeparators() {
        let all = entries()
        let separatorIndexes = all.indices.filter { all[$0].kind == .separator }
        XCTAssertEqual(separatorIndexes, [6, 13])
    }

    /// 验收 5：「快速复习」随到期数动态变「快速复习（N 到期）」（Windows
    /// review_reminder.rs:147-152 逐字）。
    func test_quickReviewDynamicTitle() {
        XCTAssertEqual(title(entries(dueCount: 6)[2]), "快速复习（6 到期）")
        XCTAssertEqual(title(entries(dueCount: 0)[2]), "快速复习")
    }

    /// 验收 3 兜底：不可映射热键回落「标题 + 两空格 + hint」内嵌，且不带原生 key。
    func test_unmappableShortcutFallsBackToEmbeddedHint() {
        let fallback = AppDelegate.statusMenuEntries(
            selectionShortcut: HotKeyShortcut(keyCode: 0, modifiers: UInt32(optionKey), keyLabel: "Unknown"),
            ocrShortcut: .controlOptionSpace,
            readerShortcut: .controlOptionR,
            dueCount: 0
        )
        XCTAssertEqual(title(fallback[0]), "翻译选中文本  Option + Unknown")
        XCTAssertNil(key(of: fallback[0]))
    }
}
