import XCTest
import ProviderCore
@testable import ImmersiveTranslator

/// 设置中心 IA 文案对账（规格 docs/mac-ui-fix-specs-2026-11-02/settings.md §2.9 第 3 条）：
/// 七分区标题/分组已在 SettingsDangerZoneTests 覆盖，这里补 pageSubtitle 逐字短语、
/// 翻译方向 seg/hint、快捷键三行标题与 hint、账号页副标题（Windows 逐字）。
final class SettingsSectionIATests: XCTestCase {
    // MARK: - 页头副标题（Windows set-pagehead-text p 逐字）

    func testProviderSubtitleMatchesWindowsVerbatim() {
        XCTAssertEqual(
            SettingsSection.provider.pageSubtitle,
            "沉浸云登录即用；其他服务商使用你自己的 API Key，每家密钥分开保存、切换互不影响。"
        )
    }

    func testGlossarySubtitleCarriesSendLimitPhrase() {
        XCTAssertEqual(
            SettingsSection.glossary.pageSubtitle,
            "固定译法。每行一条，翻译时随请求一并发送（最多前 80 条）。"
        )
    }

    func testAccountSubtitleMatchesWindowsVerbatim() {
        // Windows AccountSection.tsx 未登录态逐字（规格 §2.6 第 1 条 + §四.6）。
        XCTAssertEqual(
            SettingsSection.account.pageSubtitle,
            "登录是可选项——翻译、阅读室与复习全部本地可用"
        )
    }

    func testTranslationAndAboutSubtitlesStayAligned() {
        XCTAssertEqual(SettingsSection.translation.pageSubtitle, "目标语言与翻译浮窗的行为。")
        XCTAssertEqual(SettingsSection.about.pageSubtitle, "版本更新、启动与引导。")
    }

    // MARK: - 翻译方向（Windows seg 按钮 + hint 逐字）

    func testTranslationDirectionTitlesMatchWindowsSegments() {
        XCTAssertEqual(TranslationDirection.autoChineseEnglish.title, "自动识别")
        XCTAssertEqual(TranslationDirection.fixedTarget.title, "固定目标语言")
    }

    func testTranslationDirectionDetailsMatchWindowsHints() {
        XCTAssertEqual(
            TranslationDirection.autoChineseEnglish.detail,
            "中文 → English，其他语言 → 简体中文"
        )
        XCTAssertEqual(
            TranslationDirection.fixedTarget.detail,
            "始终翻译为指定的目标语言"
        )
    }

    // MARK: - 快捷键三行（Windows 1150/1151/1161/1162/1171/1172 逐字）

    func testHotkeyRowTitlesAndHintsMatchWindowsVerbatim() {
        XCTAssertEqual(SettingsView.hotkeyRowSpecs.map(\.title), ["翻译热键", "截图 OCR 热键", "阅读室热键"])
        XCTAssertEqual(
            SettingsView.hotkeyRowSpecs.map(\.hint),
            [
                "读取当前选中文字并弹出翻译浮窗",
                "进入截图模式，框选区域后自动识别并翻译",
                "把选中的内容送进沉浸阅读室精读",
            ]
        )
    }

    // MARK: - 服务商预设（模型服务页双栏 IA 的文案来源）

    func testPlatformProviderIdIsImmersiveCloud() {
        XCTAssertEqual(ProviderProfile.platformProviderID, "immersive-cloud")
        XCTAssertTrue(ProviderProfile.builtinPresets.contains { $0.id == ProviderProfile.platformProviderID })
    }
}
