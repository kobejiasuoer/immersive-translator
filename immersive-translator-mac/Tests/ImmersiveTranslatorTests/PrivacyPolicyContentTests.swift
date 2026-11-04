import XCTest
@testable import ImmersiveTranslator

/// 关于页「隐私政策」卡（对齐 Windows PrivacyPolicyCard.test.tsx 三个用例 + privacyPolicy.ts 文案）：
/// 1）默认收起：卡标题「隐私政策」、不渲染正文、按钮「查看完整政策」；
/// 2）展开：六节标题与正文、联系方式都在，按钮变「收起」；
/// 3）再点收起：正文移除，按钮回「查看完整政策」；
/// 另加文案保真：更新日期 / 导语 / 六节 / 联系方式与 Windows privacyPolicy.ts 逐字一致（含源文件直接对账）。
///
/// XCTest 无法宿主渲染 SwiftUI：正文按 `disclosure.isOpen` 条件渲染由视图代码保证，
/// 这里覆盖披露状态机（PrivacyPolicyDisclosure）与视图所用的全部文案常量。
final class PrivacyPolicyContentTests: XCTestCase {

    // MARK: - Windows 用例 1「默认收起：只有摘要，不含正文」

    func testDefaultCollapsedShowsSummaryOnly() {
        XCTAssertEqual(PrivacyPolicyContent.cardTitle, "隐私政策")
        XCTAssertEqual(PrivacyPolicyContent.cardSubtitle, "数据怎么收集、怎么使用（更新于 2026年10月26日）")

        let disclosure = PrivacyPolicyDisclosure()
        XCTAssertFalse(disclosure.isOpen, "默认收起：不渲染正文")
        XCTAssertEqual(disclosure.actionTitle, "查看完整政策")
    }

    // MARK: - Windows 用例 2「展开：六节正文 + 联系方式都在，按钮变「收起」」

    func testExpandShowsSixSectionsAndContactAndFlipsButton() {
        var disclosure = PrivacyPolicyDisclosure()
        disclosure.toggle()
        XCTAssertTrue(disclosure.isOpen, "点「查看完整政策」后渲染正文")
        XCTAssertEqual(disclosure.actionTitle, "收起")

        // 展开态正文纯文本 = 导语 + 六节「标题：正文」+ 联系方式（视图同一拼接规则，
        // 等价 Windows `.about-privacy-body` 的 textContent）。
        let body = (
            [PrivacyPolicyContent.intro]
                + PrivacyPolicyContent.sections.map { "\($0.title)：\($0.body)" }
                + [PrivacyPolicyContent.contact]
        ).joined(separator: "\n")
        XCTAssertEqual(PrivacyPolicyContent.sections.count, 6)
        for section in PrivacyPolicyContent.sections {
            XCTAssertTrue(body.contains(section.title), "缺少节标题：\(section.title)")
            XCTAssertTrue(body.contains(String(section.body.prefix(20))), "缺少节正文：\(section.title)")
        }
        XCTAssertTrue(body.contains("github.com/kobejiasuoer/immersive-translator/issues"))
    }

    // MARK: - Windows 用例 3「再点收起：正文移除」

    func testCollapseAgainRemovesBody() {
        var disclosure = PrivacyPolicyDisclosure()
        disclosure.toggle()
        XCTAssertTrue(disclosure.isOpen)
        disclosure.toggle()
        XCTAssertFalse(disclosure.isOpen, "再点「收起」：正文移除")
        XCTAssertEqual(disclosure.actionTitle, "查看完整政策")
        XCTAssertEqual(disclosure, PrivacyPolicyDisclosure(), "回到与新建一致的默认收起态")
    }

    // MARK: - 文案保真（Windows privacyPolicy.ts 逐字）

    func testPolicyTextMatchesWindowsVerbatim() {
        XCTAssertEqual(PrivacyPolicyContent.updatedAt, "2026年10月26日")
        XCTAssertEqual(
            PrivacyPolicyContent.intro,
            "「沉浸口语」（以下简称“本应用”）是面向语言学习者的桌面应用。我们高度重视你的隐私，说明如下："
        )
        XCTAssertEqual(PrivacyPolicyContent.sections.count, 6, "六节，不多不少")
        XCTAssertEqual(
            PrivacyPolicyContent.sections.map(\.title),
            ["一、麦克风音频", "二、文本内容", "三、屏幕截图（OCR）", "四、本地存储", "五、账号与订阅", "六、你的权利"]
        )
        XCTAssertEqual(
            PrivacyPolicyContent.sections.map(\.body),
            [
                "使用口语跟读、发音评测等功能时，本应用会请求麦克风权限以采集音频，仅用于语音识别与发音评测，不用于广告或与本应用功能无关的用途。",
                "使用翻译、AI 口语对话等功能时，你所提交的文本会通过加密网络连接发送至我们及第三方 AI 服务提供商（如大语言模型、机器翻译与语音合成服务商）进行处理，以生成学习内容与反馈。",
                "使用截图取词或屏幕翻译功能时，截图仅在本地或本次请求中用于识别文字，处理后即行丢弃。",
                "生词本、阅读记录、练习记录与偏好设置默认保存在你的设备本地。仅在你明确开启同步或备份功能时，相关数据才会按你的指示上传。",
                "如你选择登录账号或购买订阅，我们会按服务需要处理你的邮箱、订单等必要信息，用于提供与保障服务。",
                "我们不会出售你的个人信息。你可随时通过卸载应用删除本地数据，或通过下方渠道联系我们删除与账号相关的数据。"
            ]
        )
        XCTAssertEqual(
            PrivacyPolicyContent.contact,
            "联系我们：https://github.com/kobejiasuoer/immersive-translator/issues"
        )
    }

    /// 与 Windows 源文件直接对账：仓库里存在 immersive-translator-windows/src/views/privacyPolicy.ts 时
    /// 逐字段比对，任一端改了政策文本而另一端没跟就失败（单独拷出 mac 包、没有 Windows 目录时跳过）。
    func testPolicyTextMatchesWindowsSourceFile() throws {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // ImmersiveTranslatorTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // immersive-translator-mac
            .deletingLastPathComponent() // 仓库根
        let sourceURL = repoRoot.appendingPathComponent("immersive-translator-windows/src/views/privacyPolicy.ts")
        guard let source = try? String(contentsOf: sourceURL, encoding: .utf8) else {
            throw XCTSkip("未找到 Windows 隐私政策源文件：\(sourceURL.path)")
        }

        XCTAssertEqual(Self.firstQuoted(after: "PRIVACY_POLICY_UPDATED_AT", in: source), PrivacyPolicyContent.updatedAt)
        XCTAssertEqual(Self.firstQuoted(after: "PRIVACY_POLICY_INTRO", in: source), PrivacyPolicyContent.intro)
        XCTAssertEqual(Self.allQuoted(field: "title", in: source), PrivacyPolicyContent.sections.map(\.title))
        XCTAssertEqual(Self.allQuoted(field: "body", in: source), PrivacyPolicyContent.sections.map(\.body))
        XCTAssertEqual(Self.firstQuoted(after: "PRIVACY_CONTACT_TEXT", in: source), PrivacyPolicyContent.contact)
    }

    // MARK: - 夹具：从 privacyPolicy.ts 摘取双引号字面量（该文件不含转义序列）

    /// `export const NAME =\n  "…";` → 引号内文本。
    private static func firstQuoted(after constantName: String, in source: String) -> String? {
        captures(pattern: "\(constantName)\\s*=\\s*\"([^\"]*)\"", in: source).first
    }

    /// `{ title: "…", body: "…" }` 按出现顺序取全部 `field: "…"`。
    private static func allQuoted(field: String, in source: String) -> [String] {
        captures(pattern: "\\b\(field):\\s*\"([^\"]*)\"", in: source)
    }

    private static func captures(pattern: String, in source: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(source.startIndex..., in: source)
        return regex.matches(in: source, range: range).compactMap { match in
            Range(match.range(at: 1), in: source).map { String(source[$0]) }
        }
    }
}
