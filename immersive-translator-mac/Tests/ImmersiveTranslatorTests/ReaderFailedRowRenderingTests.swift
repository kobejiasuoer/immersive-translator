import XCTest
import SwiftUI
import ReaderCore
@testable import ImmersiveTranslator

/// 段落/标题失败行的原因小字渲染——对齐 Windows ReadingView.cloze.test.tsx:191-249
/// （prose 与 parallel 两分支：zhError 有值 → 文案出现；nil → 不出现、与旧行为
/// 一致；「重试本段」按钮文案与回调 paragraphIdx 不变）与 ReadingView.tsx:1071-1081
/// （标题失败行全角括号包裹原因、0.85 透明度）。
///
/// 取证方式：SwiftUI Text 不落 AppKit 子视图、无障碍树在无窗口服务的测试进程
/// 不实例化、离屏 hosting 的 PDF 文本层不稳定（三种途径均实证过取不到/时有时
/// 无），因此对视图 body 做 Mirror 遍历取 Text 内容——Text 的描述含字符串原文
/// 与透明度（如 "80% #B91C1CFF"），可确定性地断言「文案出现 + 透明度正确」。
/// 「点击重试本段」同法：从渲染出的 Button 取 action 闭包调用恰一次（等价 Windows
/// `btn.click()`），按请求记录断言回调恰调一次、参数为 paragraphIdx 0。
/// 依赖 SwiftUI 私有结构描述格式，OS 升级可能需要跟随调整（测试层取舍）。
final class ReaderFailedRowRenderingTests: XCTestCase {
    private static let zhError429 = "翻译请求太频繁，已重试仍被限流，稍后点重试"
    private static let titleError401 = "翻译接口返回 401：请到 设置 → 模型服务 检查 API Key 与接口地址，或切换服务商再试"

    // MARK: - 夹具（同 ReaderShellChromeTests：替身通道 + 临时目录，不碰 Keychain/网络）

    /// 段落请求记录（重试按钮「恰调一次、参数为 paragraphIdx」的取证面）。
    private actor RequestLog {
        private(set) var requests: [String] = []
        func append(_ userText: String) { requests.append(userText) }
    }

    private final class StubChat: ReaderChatChannel {
        let log = RequestLog()
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
            await log.append(userText)
            throw ReaderChatClient.ReaderChatError.missingAPIKey
        }
    }

    @MainActor
    private func makeVM(chat: StubChat = StubChat()) -> ReaderViewModel {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("reader-failed-row-\(UUID().uuidString)", isDirectory: true)
        return ReaderViewModel(chat: chat, store: ReaderStore(baseDirectory: dir))
    }

    @MainActor
    private func failedPair(zhError: String?) -> SentencePair {
        SentencePair(
            idx: 0,
            paragraphIdx: 0,
            en: "The tide is still making up its mind.",
            zh: nil,
            zhState: .failed,
            zhError: zhError
        )
    }

    /// 递归遍历视图树收集 Text 描述（含字符串与透明度）；已知子视图类型
    /// 显式下钻其 body（Mirror 只见实例不见展开内容）。
    private func mirrorTexts(_ value: Any) -> [String] {
        var out: [String] = []
        func walk(_ v: Any) {
            if let text = v as? Text {
                out.append(String(describing: text))
                return
            }
            if let row = v as? ReaderFailedRow {
                MainActor.assumeIsolated { walk(row.body) }
                return
            }
            if let row = v as? ReaderTitleFailedRow {
                MainActor.assumeIsolated { walk(row.body) }
                return
            }
            for child in Mirror(reflecting: v).children {
                walk(child.value)
            }
        }
        walk(value)
        return out
    }

    /// 描述形如 `Text(storage: ... "文案" ..., modifiers: [... color(Optional(80% #B91C1CFF))])`。
    private func reasonText(_ texts: [String], containing needle: String) -> String? {
        texts.first { $0.contains(needle) }
    }

    /// 视图树里标签含 `needle` 的 Button 的 action 闭包（下钻规则同 mirrorTexts）。
    /// SwiftUI 私有结构 `Button<Label>.action: ButtonAction.closure: @MainActor () -> ()`
    /// 本机 macOS 26 实证可取；调用闭包 = 点击按钮（与 Text 描述取证同属测试层取舍）。
    private func buttonActions(_ value: Any, label needle: String) -> [@MainActor () -> Void] {
        var out: [@MainActor () -> Void] = []
        func walk(_ v: Any) {
            if v is Text { return }
            if let row = v as? ReaderFailedRow {
                MainActor.assumeIsolated { walk(row.body) }
                return
            }
            if let row = v as? ReaderTitleFailedRow {
                MainActor.assumeIsolated { walk(row.body) }
                return
            }
            let mirror = Mirror(reflecting: v)
            if String(describing: type(of: v)).hasPrefix("Button<") {
                let label = mirror.children.first { $0.label == "label" }.map { String(describing: $0.value) } ?? ""
                let action = mirror.children.first { $0.label == "action" }?.value
                let closure = action.flatMap { Mirror(reflecting: $0).children.first { $0.label == "closure" }?.value }
                if label.contains(needle), let tap = closure as? @MainActor () -> Void {
                    out.append(tap)
                }
                return
            }
            for child in mirror.children {
                walk(child.value)
            }
        }
        walk(value)
        return out
    }

    private func waitUntil(
        _ what: String,
        timeoutMs: Int = 3_000,
        _ cond: @escaping @MainActor () async -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        while Date() < deadline {
            if await cond() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("等待「\(what)」超时")
    }

    /// 两段各一句失败句（paragraphIdx 0 / 1，均带 429 原因）：点第 0 段的重试按钮，
    /// 第 1 段必须原样不动——这是「回调参数 = paragraphIdx 0」的取证面。
    @MainActor
    private func twoFailedParagraphsArticle(id: String) -> Article {
        var other = failedPair(zhError: Self.zhError429)
        other.idx = 1
        other.paragraphIdx = 1
        other.en = "The harbor lights came on one by one."
        var article = Article(
            id: id,
            title: "Tide",
            createdAt: 0,
            lastReadAt: 0,
            sentences: [failedPair(zhError: Self.zhError429), other]
        )
        article.titleCnState = .done
        return article
    }

    /// 真实触发视图里的「重试本段」按钮恰一次，断言与 Windows ReadingView.cloze.test.tsx
    /// `btn.click()` → `onRetryParagraph` toHaveBeenCalledTimes(1) + toHaveBeenCalledWith(0)
    /// 等价：第 0 段同步重置 pending 并清 zhError、第 1 段原样不动、整个重试 run 恰发出
    /// 1 个请求且只含第 0 段原文。
    @MainActor
    private func tapRetryOnceAndAssertParagraphZero(
        in view: Any,
        vm: ReaderViewModel,
        chat: StubChat,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        let actions = buttonActions(view, label: "重试本段")
        XCTAssertEqual(actions.count, 1, "视图里恰有一个「重试本段」按钮", file: file, line: line)
        guard let tap = actions.first else { return }
        let before = await chat.log.requests
        XCTAssertEqual(before, [], "点击前无请求", file: file, line: line)

        tap()

        XCTAssertEqual(vm.article?.sentences[0].zhState, .pending, "按钮回调按 paragraphIdx 0 重置本段", file: file, line: line)
        XCTAssertNil(vm.article?.sentences[0].zhError, "按钮回调清空本段失败原因", file: file, line: line)
        XCTAssertEqual(vm.article?.sentences[1].zhState, .failed, "别段（paragraphIdx 1）不受影响", file: file, line: line)
        XCTAssertEqual(vm.article?.sentences[1].zhError, Self.zhError429, "别段失败原因原样保留", file: file, line: line)
        await waitUntil("重试 run 收尾") {
            vm.translating == nil && vm.article?.sentences[0].zhState == .failed
        }
        let requests = await chat.log.requests
        XCTAssertEqual(
            requests,
            [buildParagraphRequestInput([failedPair(zhError: nil).en])],
            "回调恰被调一次、参数为 paragraphIdx 0（整个重试 run 只发 1 个本段请求）",
            file: file,
            line: line
        )
    }

    // MARK: - 共用失败行 ReaderFailedRow（parallel 与 prose 两分支同源）

    /// 有值：主文案 + zhError 原文（0.8 透明度）+ 重试按钮。
    @MainActor
    func testSharedFailedRowShowsErrorTextWithReason() {
        let vm = makeVM()
        let texts = mirrorTexts(ReaderFailedRow(vm: vm, pair: failedPair(zhError: Self.zhError429)).body)
        let joined = texts.joined(separator: " | ")
        XCTAssertTrue(joined.contains("本段翻译失败"), "失败行主文案；实际=\(joined)")
        XCTAssertTrue(joined.contains(Self.zhError429), "原因小字渲染 zhError 原文；实际=\(joined)")
        XCTAssertTrue(joined.contains("重试本段"), "重试按钮文案不变；实际=\(joined)")
        let reason = reasonText(texts, containing: Self.zhError429)
        XCTAssertTrue(
            reason?.contains("80%") == true,
            "原因小字透明度 0.8（错误色）；实际=\(reason ?? "<nil>")"
        )
    }

    /// 缺省：只有原文案与按钮、无原因小字（行为与旧版一致）。
    @MainActor
    func testSharedFailedRowWithoutErrorRendersExactlyAsBefore() {
        let vm = makeVM()
        let texts = mirrorTexts(ReaderFailedRow(vm: vm, pair: failedPair(zhError: nil)).body)
        let joined = texts.joined(separator: " | ")
        XCTAssertTrue(joined.contains("本段翻译失败"))
        XCTAssertFalse(joined.contains(Self.zhError429), "zhError 缺省时不得渲染原因小字")
        XCTAssertTrue(joined.contains("重试本段"))
        XCTAssertNil(reasonText(texts, containing: Self.zhError429))
    }

    // MARK: - parallel 分支（SentenceRowView 端到端）

    /// 对照行端到端：失败行带原因小字；点「重试本段」恰一次 → 回调收到 paragraphIdx 0。
    @MainActor
    func testParallelFailedRowShowsErrorTextAndRetryCallback() async {
        let chat = StubChat()
        let vm = makeVM(chat: chat)
        let article = twoFailedParagraphsArticle(id: "row-a1")
        vm.article = article
        let pair = article.sentences[0]

        let row = SentenceRowView(
            vm: vm,
            pair: pair,
            isParaStart: true,
            isActive: true,
            isSearchMatch: false,
            editing: false,
            editDraft: .constant(""),
            onStartEdit: {},
            onCancelEdit: {},
            onCommitEdit: {}
        )
        let body = row.body
        let texts = mirrorTexts(body)
        let joined = texts.joined(separator: " | ")
        XCTAssertTrue(joined.contains("本段翻译失败"), "对照行失败主文案；实际=\(joined)")
        XCTAssertTrue(joined.contains(Self.zhError429), "对照行原因小字；实际=\(joined)")
        XCTAssertTrue(joined.contains("重试本段"), "对照行重试按钮；实际=\(joined)")

        await tapRetryOnceAndAssertParagraphZero(in: body, vm: vm, chat: chat)
    }

    /// 对照行 zhError 缺省：无原因小字（端到端）。
    @MainActor
    func testParallelFailedRowWithoutErrorHasNoSmallText() {
        let vm = makeVM()
        let pair = failedPair(zhError: nil)
        let row = SentenceRowView(
            vm: vm,
            pair: pair,
            isParaStart: true,
            isActive: false,
            isSearchMatch: false,
            editing: false,
            editDraft: .constant(""),
            onStartEdit: {},
            onCancelEdit: {},
            onCommitEdit: {}
        )
        let joined = mirrorTexts(row.body).joined(separator: " | ")
        XCTAssertTrue(joined.contains("本段翻译失败"))
        XCTAssertFalse(joined.contains(Self.zhError429), "zhError 缺省时对照行不渲染原因小字")
        XCTAssertTrue(joined.contains("重试本段"))
        XCTAssertEqual(buttonActions(row.body, label: "重试本段").count, 1, "zhError 缺省时重试按钮照常可点")
    }

    // MARK: - prose 分支（TranslationPopView 译文浮层端到端；2026-10-26 白卡重构后当前句译文在浮层里）

    /// 折叠卡端到端：failed 分支渲染共用失败行（主文案 + 原因 + 重试按钮）；
    /// 点「重试本段」恰一次 → 回调收到 paragraphIdx 0。
    @MainActor
    func testProseFoldCardFailedRowShowsErrorText() async {
        let chat = StubChat()
        let vm = makeVM(chat: chat)
        let article = twoFailedParagraphsArticle(id: "fold-a1")
        vm.article = article
        let pair = article.sentences[0]

        let card = TranslationPopView(
            vm: vm,
            pair: pair,
            editing: false,
            editDraft: .constant(""),
            onStartEdit: {},
            onCancelEdit: {},
            onCommitEdit: {}
        )
        let body = card.body
        let joined = mirrorTexts(body).joined(separator: " | ")
        XCTAssertTrue(joined.contains("本段翻译失败"), "浮层失败行主文案；实际=\(joined)")
        XCTAssertTrue(joined.contains(Self.zhError429), "浮层原因小字；实际=\(joined)")
        XCTAssertTrue(joined.contains("重试本段"), "浮层重试按钮；实际=\(joined)")

        await tapRetryOnceAndAssertParagraphZero(in: body, vm: vm, chat: chat)
    }

    /// 折叠卡 zhError 缺省：无原因小字（端到端）。
    @MainActor
    func testProseFoldCardWithoutErrorHasNoSmallText() {
        let vm = makeVM()
        let pair = failedPair(zhError: nil)
        let card = TranslationPopView(
            vm: vm,
            pair: pair,
            editing: false,
            editDraft: .constant(""),
            onStartEdit: {},
            onCancelEdit: {},
            onCommitEdit: {}
        )
        let joined = mirrorTexts(card.body).joined(separator: " | ")
        XCTAssertTrue(joined.contains("本段翻译失败"))
        XCTAssertFalse(joined.contains(Self.zhError429), "zhError 缺省时浮层不渲染原因小字")
        XCTAssertTrue(joined.contains("重试本段"))
        XCTAssertEqual(buttonActions(card.body, label: "重试本段").count, 1, "zhError 缺省时重试按钮照常可点")
    }

    // MARK: - 标题失败行（ReaderTitleFailedRow + 刊头端到端）

    /// 标题失败：主文案 + 全角括号包裹的瞬态原因（0.85 透明度）+「重试」按钮。
    @MainActor
    func testTitleFailedRowShowsReasonInFullWidthParens() {
        let vm = makeVM()
        vm.titleCnError = Self.titleError401

        let withReason = mirrorTexts(ReaderTitleFailedRow(vm: vm).body)
        let joinedReason = withReason.joined(separator: " | ")
        XCTAssertTrue(joinedReason.contains("标题翻译失败"), "标题失败主文案；实际=\(joinedReason)")
        XCTAssertTrue(
            joinedReason.contains("（\(Self.titleError401)）"),
            "原因用全角括号包裹；实际=\(joinedReason)"
        )
        XCTAssertTrue(joinedReason.contains("重试"), "标题重试按钮文案不变；实际=\(joinedReason)")
        let reason = reasonText(withReason, containing: Self.titleError401)
        XCTAssertTrue(
            reason?.contains("85%") == true,
            "标题原因透明度 0.85（错误色）；实际=\(reason ?? "<nil>")"
        )

        // 瞬态清空（retryTitle 先清 titleCnError；重启后同观察面）：只剩主文案与按钮。
        vm.titleCnError = nil
        let withoutReason = mirrorTexts(ReaderTitleFailedRow(vm: vm).body).joined(separator: " | ")
        XCTAssertTrue(withoutReason.contains("标题翻译失败"))
        XCTAssertFalse(
            withoutReason.contains("（\(Self.titleError401)"),
            "titleCnError 为 nil 时不渲染括号原因"
        )
    }

    /// 刊头（ReadingHeadView 端到端）：标题失败态渲染 ReaderTitleFailedRow。
    @MainActor
    func testReadingHeadFailedTitleShowsReason() {
        let vm = makeVM()
        var article = Article(id: "title-a1", title: "Tide", createdAt: 0, lastReadAt: 0, sentences: [])
        article.titleCnState = .failed
        vm.article = article
        vm.titleCnError = Self.titleError401

        let joined = mirrorTexts(ReadingHeadView(article: article, vm: vm).body).joined(separator: " | ")
        XCTAssertTrue(joined.contains("标题翻译失败"), "刊头标题失败主文案；实际=\(joined)")
        XCTAssertTrue(joined.contains("（\(Self.titleError401)）"), "刊头标题失败原因；实际=\(joined)")
        XCTAssertTrue(joined.contains("重试"), "刊头标题重试按钮；实际=\(joined)")
    }
}
