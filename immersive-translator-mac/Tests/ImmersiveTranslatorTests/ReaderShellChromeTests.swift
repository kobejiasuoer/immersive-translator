import XCTest
import SwiftUI
import ReaderCore
import XfyunCore
@testable import ImmersiveTranslator

/// SHELL-CHROME 批次的应用层单测：
/// 1）ReaderPalette 的底色/主色与三套氛围主题令牌逐值一致（SHELL-4 验收）；
/// 2）关窗停播（SHELL-6）：ReaderWindowController.windowWillClose → VM.handleWindowWillClose
///    → ReaderPlaybackEngine.stop() 的引擎语义——播放中 stop 后 playing/shadowingWait
///    立即复位，且句子上下文保留（重开窗口续读的前提）；
/// 3）R2-READ 浮层 Esc 统一派发链（SHELL-10/READ-10）与播放胶囊键盘滑杆（READ-6）：
///    vm.handleKeyDown 的 Esc 分支（差词抽屉 → 设置抽屉 → 书架浮层，一次只收最上层）、
///    输入焦点守卫（useEscapeClose 语义：输入中 Esc 交还系统）、滑杆聚焦时的翻句键。
final class ReaderShellChromeTests: XCTestCase {
    // MARK: - 调色板与令牌对账

    private func assertColor(_ color: Color, equals token: ReaderColorToken, _ message: String) {
        let ns = NSColor(color).usingColorSpace(.sRGB)
        XCTAssertNotNil(ns, message)
        let rgb = token.rgb
        XCTAssertNotNil(rgb, message)
        XCTAssertEqual(ns!.redComponent, rgb!.r, accuracy: 0.002, message)
        XCTAssertEqual(ns!.greenComponent, rgb!.g, accuracy: 0.002, message)
        XCTAssertEqual(ns!.blueComponent, rgb!.b, accuracy: 0.002, message)
        XCTAssertEqual(ns!.alphaComponent, token.alpha, accuracy: 0.002, message)
    }

    func testPaletteBackgroundAndAccentFollowTokens() {
        for theme in ReaderTheme.allCases {
            let tokens = ReaderThemeTokens.tokens(for: theme)
            let palette = ReaderPalette.palette(for: theme)
            assertColor(palette.background, equals: tokens.canvasBg, "\(theme) 底色应等于 canvasBg 令牌")
            assertColor(palette.accent, equals: tokens.accent, "\(theme) 主色应等于 accent 令牌")
            assertColor(palette.text, equals: tokens.ink1, "\(theme) 墨一级应等于 ink-1 令牌")
            assertColor(palette.textSecondary, equals: tokens.ink2, "\(theme) 墨二级应等于 ink-2 令牌")
        }
    }

    func testDarkThemesUseDarkColorScheme() {
        XCTAssertEqual(ReaderPalette.palette(for: .dark).colorScheme, .dark)
        XCTAssertEqual(ReaderPalette.palette(for: .oled).colorScheme, .dark)
        XCTAssertEqual(ReaderPalette.palette(for: .light).colorScheme, .light)
        XCTAssertEqual(ReaderPalette.palette(for: .sepia).colorScheme, .light)
    }

    // MARK: - SHELL-6：关窗停播（引擎语义）

    @MainActor
    func testWindowCloseStopsPlaybackAndKeepsContext() {
        let engine = ReaderPlaybackEngine()
        // 本地引擎：测试不碰网络；一句短文本足够把引擎带进 playing。
        engine.updateContext(
            texts: ["Close the window while reading.", "Second sentence."],
            settings: .init(rate: 1, voice: "", sentencePauseMs: 0, shadowingMode: false, ttsProvider: .local)
        )
        engine.toggle()
        XCTAssertTrue(engine.playing, "toggle 后应处于播放态")

        // 关窗反应（windowWillClose → handleWindowWillClose → stop）核心语义：
        // 立即停播、跟读等待复位、句子上下文原样保留。
        engine.stop()
        XCTAssertFalse(engine.playing, "stop 后 playing 应立即复位（声音不能在窗口消失后继续）")
        XCTAssertFalse(engine.shadowingWait, "stop 后跟读等待应复位（收麦路径由 shadowingWait 订阅触发）")
        XCTAssertEqual(engine.sentenceCount, 2, "stop 不应清掉句子上下文（重开窗口续读的前提）")

        // 停止后可以再次播放：状态机没有被 stop 打死。
        engine.toggle()
        XCTAssertTrue(engine.playing)
        engine.stop()
    }

    // MARK: - R2-READ 公共夹具：vm（替身 LLM 通道 + 临时目录落盘，不碰 Keychain/网络/用户数据）与合成按键

    /// FIFO 闸门（同 SpeakViewControllerRaceTests）：异步通道在 wait() 处悬停，测试按序
    /// open(_:)/abort(_:) 放行一个等待者——这就是「在途查词请求」的可控替身。
    private actor Gate<Value> {
        private var waiters: [CheckedContinuation<Value, Error>] = []
        private var backlog: [Value] = []

        func wait() async throws -> Value {
            if !backlog.isEmpty { return backlog.removeFirst() }
            return try await withCheckedThrowingContinuation { waiters.append($0) }
        }

        func open(_ value: Value) {
            if waiters.isEmpty {
                backlog.append(value)
            } else {
                waiters.removeFirst().resume(returning: value)
            }
        }

        /// 让最早的等待者以错误返回（URLSession 被 Task.cancel 时抛 cancelled 的替身）。
        func abort(_ error: Error) {
            guard !waiters.isEmpty else { return }
            waiters.removeFirst().resume(throwing: error)
        }

        var waiting: Int { waiters.count }
    }

    /// LLM 通道替身：`SettingsStore()` 初始化会读 Keychain——xctest 不在钥匙串条目 ACL 上时
    /// 弹授权窗把测试挂死（本批实测），因此 vm 级用例一律注入它；complete 挂在闸门上。
    private final class StubChat: ReaderChatChannel {
        let gate = Gate<String>()
        var glossaryText: String { "" }
        var customStyle: String { "" }
        func configuration() throws -> ReaderChatClient.Configuration {
            throw ReaderChatClient.ReaderChatError.missingAPIKey
        }
        func resolveTarget(for sample: String) -> String { "简体中文" }
        func complete(systemPrompt: String, userText: String) async throws -> String {
            try await gate.wait()
        }
        func completeStreaming(
            systemPrompt: String,
            userText: String,
            onDelta: @escaping (String) -> Void
        ) async throws -> String {
            throw ReaderChatClient.ReaderChatError.missingAPIKey
        }
    }

    @MainActor
    private func makeVM(chat: StubChat = StubChat()) -> ReaderViewModel {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("r2-read-shell-\(UUID().uuidString)", isDirectory: true)
        return ReaderViewModel(chat: chat, store: ReaderStore(baseDirectory: dir))
    }

    private func waitWaiters(_ gate: Gate<String>, _ n: Int, _ what: String, timeoutMs: Int = 2_000) async {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        while Date() < deadline {
            if await gate.waiting >= n { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        let waiting = await gate.waiting
        XCTFail("等待「\(what)」超时：waiters=\(waiting)，期望 ≥ \(n)")
    }

    private func waitUntil(_ what: String, timeoutMs: Int = 2_000, _ cond: @escaping @MainActor () -> Bool) async {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        while Date() < deadline {
            if await cond() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("等待「\(what)」超时")
    }

    /// 给已放行的在途任务一点时间跑完写回/丢弃分支。
    private func settle() async {
        try? await Task.sleep(nanoseconds: 80_000_000)
    }

    /// 合成 keyDown（NSEvent.keyCode 为准；characters 给函数键的 Unicode 以贴近真实事件）。
    private func keyDown(_ keyCode: UInt16, _ characters: String) -> NSEvent {
        let event = NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: characters,
            charactersIgnoringModifiers: characters,
            isARepeat: false,
            keyCode: keyCode
        )
        XCTAssertNotNil(event, "合成按键事件失败 keyCode=\(keyCode)")
        return event!
    }

    private var escape: NSEvent { keyDown(53, "\u{1B}") }
    private var leftArrow: NSEvent { keyDown(123, "\u{F702}") }
    private var rightArrow: NSEvent { keyDown(124, "\u{F703}") }
    private var downArrow: NSEvent { keyDown(125, "\u{F701}") }
    private var upArrow: NSEvent { keyDown(126, "\u{F700}") }
    private var home: NSEvent { keyDown(115, "\u{F729}") }
    private var end: NSEvent { keyDown(119, "\u{F72B}") }
    private var pageUp: NSEvent { keyDown(116, "\u{F72C}") }
    private var pageDown: NSEvent { keyDown(121, "\u{F72D}") }

    /// 一条可开差词抽屉的最小词目（整句评测里一个 bad 词）。
    private func drillEntry(_ text: String = "word") -> ShadowDrillController.Entry {
        ShadowDrillController.Entry(
            text: text,
            mark: WordMark(start: 0, end: text.count, quality: .bad, score: 2.5)
        )
    }

    /// 30 句短文（滑杆用例需要跨 PageUp/PageDown ±10 与首尾跳转的长度）。
    private func thirtySentenceArticle() -> Article {
        Article(
            id: "r2-read-article",
            title: "Keyboard scrubber",
            createdAt: 0,
            lastReadAt: 0,
            sentences: (0..<30).map { SentencePair(idx: $0, paragraphIdx: 0, en: "Sentence \($0).") }
        )
    }

    // MARK: - SHELL-10：差词抽屉 Esc 关闭（ShadowDrill.tsx:161 useEscapeClose）

    @MainActor
    func testEscapeClosesDrillDrawerAndConsumesEvent() {
        let vm = makeVM()
        vm.drill.open(entries: [drillEntry()])
        XCTAssertTrue(vm.drill.state.shown, "前置：抽屉已开")

        XCTAssertTrue(vm.handleKeyDown(escape), "差词抽屉开着按 Esc 应消费事件（返回 true）")
        XCTAssertFalse(vm.drill.state.shown, "差词抽屉应已关闭")
        XCTAssertEqual(vm.drill.state.step, .idle, "关抽屉同时复位步骤（收麦语义）")

        XCTAssertFalse(vm.handleKeyDown(escape), "没有可收的浮层时 Esc 不消费（route=shelf）")
    }

    // MARK: - READ-10：设置抽屉 Esc 收起（SettingsDrawer.tsx:141 useEscapeClose）

    @MainActor
    func testEscapeClosesSettingsDrawerAndConsumesEvent() {
        let vm = makeVM()
        vm.settingsDrawerShown = true

        XCTAssertTrue(vm.handleKeyDown(escape), "设置抽屉开 → Esc 应被消费")
        XCTAssertFalse(vm.settingsDrawerShown, "设置抽屉应收起")
    }

    @MainActor
    func testEscapeClosesSettingsDrawerOnAnyRoute() {
        // 齿轮在顶栏，任何路由都能开抽屉：Esc 派发不依赖 route（笔记与复习路由也要能收）。
        for route in [ReaderViewModel.Route.shelf, .reading, .review, .notes, .speak] {
            let vm = makeVM()
            vm.route = route
            vm.settingsDrawerShown = true
            XCTAssertTrue(vm.handleKeyDown(escape), "\(route)：Esc 应收设置抽屉")
            XCTAssertFalse(vm.settingsDrawerShown, "\(route)：抽屉应已收起")
        }
    }

    // MARK: - SHELL-10/READ-10：多浮层同开，一次只收最上层（差词抽屉 → 设置抽屉 → 书架浮层）

    @MainActor
    func testEscapeDismissesOnlyTopmostOverlayPerPress() {
        let vm = makeVM()
        vm.folioOpen = true
        vm.settingsDrawerShown = true
        vm.drill.open(entries: [drillEntry()])

        XCTAssertTrue(vm.handleKeyDown(escape))
        XCTAssertFalse(vm.drill.state.shown, "第 1 次 Esc：只收最上层的差词抽屉")
        XCTAssertTrue(vm.settingsDrawerShown, "设置抽屉不受第 1 次 Esc 影响")
        XCTAssertTrue(vm.folioOpen, "书架浮层不受第 1 次 Esc 影响")

        XCTAssertTrue(vm.handleKeyDown(escape))
        XCTAssertFalse(vm.settingsDrawerShown, "第 2 次 Esc：收设置抽屉")
        XCTAssertTrue(vm.folioOpen, "书架浮层仍开（设置抽屉在其上层）")

        XCTAssertTrue(vm.handleKeyDown(escape))
        XCTAssertFalse(vm.folioOpen, "第 3 次 Esc：收书架浮层（第一轮已落地的分支仍在链上）")

        XCTAssertFalse(vm.handleKeyDown(escape), "第 4 次 Esc：无浮层可收，不消费")
    }

    @MainActor
    func testEscapeWithFolioAndSettingsDrawerClosesSettingsFirst() {
        let vm = makeVM()
        vm.folioOpen = true
        vm.settingsDrawerShown = true
        XCTAssertTrue(vm.handleKeyDown(escape))
        XCTAssertFalse(vm.settingsDrawerShown, "书架与设置抽屉同开时 Esc 只收设置抽屉（上层优先）")
        XCTAssertTrue(vm.folioOpen)
    }

    // MARK: - SHELL-10：输入焦点守卫（useEscapeClose.ts:12-13：输入中 Esc 是撤销输入，不关浮层）

    @MainActor
    func testTextInputFocusPredicate() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 240, height: 120),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        XCTAssertFalse(ReaderViewModel.textInputHasFocus(in: nil), "无窗口：不算输入焦点")
        XCTAssertFalse(ReaderViewModel.textInputHasFocus(in: window), "窗口自身是第一响应者：不算输入焦点")

        let textView = NSTextView(frame: NSRect(x: 0, y: 0, width: 240, height: 120))
        window.contentView = textView
        XCTAssertTrue(window.makeFirstResponder(textView), "前置：NSTextView 成为第一响应者")
        XCTAssertTrue(ReaderViewModel.textInputHasFocus(in: window), "NSTextView 聚焦应判为输入焦点")

        let textField = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        window.contentView = textField
        XCTAssertTrue(window.makeFirstResponder(textField), "前置：NSTextField 成为第一响应者（装入字段编辑器）")
        XCTAssertTrue(ReaderViewModel.textInputHasFocus(in: window), "NSTextField/字段编辑器聚焦应判为输入焦点")

        XCTAssertTrue(window.makeFirstResponder(nil))
        XCTAssertFalse(ReaderViewModel.textInputHasFocus(in: window), "焦点交回窗口后不再算输入焦点")
    }

    @MainActor
    func testEscapeInTextInputIsHandedBackToSystemAndKeepsOverlays() {
        let vm = makeVM()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 240, height: 120),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        let textView = NSTextView(frame: NSRect(x: 0, y: 0, width: 240, height: 120))
        window.contentView = textView
        XCTAssertTrue(window.makeFirstResponder(textView))
        vm.attachedWindow = window

        vm.settingsDrawerShown = true
        vm.drill.open(entries: [drillEntry()])
        XCTAssertFalse(vm.handleKeyDown(escape), "焦点在输入框：Esc 不消费，交还系统行为")
        XCTAssertTrue(vm.settingsDrawerShown, "设置抽屉不收")
        XCTAssertTrue(vm.drill.state.shown, "差词抽屉不收")

        // 焦点离开输入框后同一按键恢复收浮层。
        XCTAssertTrue(window.makeFirstResponder(nil))
        XCTAssertTrue(vm.handleKeyDown(escape))
        XCTAssertFalse(vm.drill.state.shown, "焦点离开输入框后 Esc 照常收最上层")
        XCTAssertTrue(vm.settingsDrawerShown)
    }

    // MARK: - READ-6：播放胶囊键盘滑杆（PlayBar.tsx:223-257 role=slider 键盘语义）

    @MainActor
    func testScrubberTargetMappingMatchesWindowsPlayBar() {
        let total = 30
        // →/↑ +1，←/↓ −1（四方向两两同义）
        XCTAssertEqual(ReaderViewModel.scrubberTarget(for: rightArrow, idx: 5, total: total), 6)
        XCTAssertEqual(ReaderViewModel.scrubberTarget(for: upArrow, idx: 5, total: total), 6)
        XCTAssertEqual(ReaderViewModel.scrubberTarget(for: leftArrow, idx: 5, total: total), 4)
        XCTAssertEqual(ReaderViewModel.scrubberTarget(for: downArrow, idx: 5, total: total), 4)
        // PageUp/PageDown ±10
        XCTAssertEqual(ReaderViewModel.scrubberTarget(for: pageDown, idx: 5, total: total), 15)
        XCTAssertEqual(ReaderViewModel.scrubberTarget(for: pageUp, idx: 15, total: total), 5)
        // Home/End 首尾
        XCTAssertEqual(ReaderViewModel.scrubberTarget(for: home, idx: 17, total: total), 0)
        XCTAssertEqual(ReaderViewModel.scrubberTarget(for: end, idx: 17, total: total), 29)
        // 边界夹紧（Windows jump() 的 max(0, min(total-1, n))）
        XCTAssertEqual(ReaderViewModel.scrubberTarget(for: leftArrow, idx: 0, total: total), 0)
        XCTAssertEqual(ReaderViewModel.scrubberTarget(for: pageUp, idx: 3, total: total), 0)
        XCTAssertEqual(ReaderViewModel.scrubberTarget(for: rightArrow, idx: 29, total: total), 29)
        XCTAssertEqual(ReaderViewModel.scrubberTarget(for: pageDown, idx: 25, total: total), 29)
        // 非滑杆键 / 无句子 → nil（不接管）
        XCTAssertNil(ReaderViewModel.scrubberTarget(for: keyDown(49, " "), idx: 5, total: total), "空格不是滑杆键")
        XCTAssertNil(ReaderViewModel.scrubberTarget(for: escape, idx: 5, total: total), "Esc 不是滑杆键")
        XCTAssertNil(ReaderViewModel.scrubberTarget(for: rightArrow, idx: 0, total: 0), "无句子时不接管")
    }

    @MainActor
    func testScrubberKeysJumpSentencesWhenFocused() {
        let vm = makeVM()
        vm.article = thirtySentenceArticle()
        vm.route = .reading
        vm.playScrubberFocused = true
        vm.activeSentenceIdx = 5

        XCTAssertTrue(vm.handleKeyDown(rightArrow)); XCTAssertEqual(vm.activeSentenceIdx, 6, "→ +1")
        XCTAssertTrue(vm.handleKeyDown(upArrow));    XCTAssertEqual(vm.activeSentenceIdx, 7, "↑ 与 → 同义")
        XCTAssertTrue(vm.handleKeyDown(leftArrow));  XCTAssertEqual(vm.activeSentenceIdx, 6, "← −1")
        XCTAssertTrue(vm.handleKeyDown(downArrow));  XCTAssertEqual(vm.activeSentenceIdx, 5, "↓ 与 ← 同义")
        XCTAssertTrue(vm.handleKeyDown(pageDown));   XCTAssertEqual(vm.activeSentenceIdx, 15, "PageDown +10")
        XCTAssertTrue(vm.handleKeyDown(pageUp));     XCTAssertEqual(vm.activeSentenceIdx, 5, "PageUp −10")
        XCTAssertTrue(vm.handleKeyDown(end));        XCTAssertEqual(vm.activeSentenceIdx, 29, "End 末句")
        XCTAssertTrue(vm.handleKeyDown(home));       XCTAssertEqual(vm.activeSentenceIdx, 0, "Home 首句")
        // 边界：首句再按 ← 仍消费（Windows 同样 preventDefault）且不越界
        XCTAssertTrue(vm.handleKeyDown(leftArrow));  XCTAssertEqual(vm.activeSentenceIdx, 0)
        XCTAssertTrue(vm.handleKeyDown(pageUp));     XCTAssertEqual(vm.activeSentenceIdx, 0)
    }

    @MainActor
    func testScrubberKeysFallThroughWhenNotFocused() {
        // 未聚焦：方向键/翻页键不接管，照旧流向正文滚动（返回 false、光标不动）。
        let vm = makeVM()
        vm.article = thirtySentenceArticle()
        vm.route = .reading
        vm.playScrubberFocused = false
        vm.activeSentenceIdx = 5

        for event in [rightArrow, leftArrow, upArrow, downArrow, pageUp, pageDown, home, end] {
            XCTAssertFalse(vm.handleKeyDown(event), "未聚焦时 keyCode=\(event.keyCode) 不应被滑杆接管")
        }
        XCTAssertEqual(vm.activeSentenceIdx, 5)
    }

    @MainActor
    func testScrubberKeysNeedReadingRouteAndSentences() {
        let vm = makeVM()
        vm.playScrubberFocused = true
        // 无文章：不接管
        vm.route = .reading
        XCTAssertFalse(vm.handleKeyDown(rightArrow), "无句子时滑杆键不接管")
        // 非阅读路由：不接管（滑杆只在阅读胶囊上）
        vm.article = thirtySentenceArticle()
        vm.route = .shelf
        XCTAssertFalse(vm.handleKeyDown(rightArrow), "非阅读路由不接管")
        XCTAssertEqual(vm.activeSentenceIdx, 0)
    }

    @MainActor
    func testEscapeStillWinsOverScrubberWhenOverlayOpen() {
        // 滑杆聚焦且抽屉开着：Esc 走浮层链、不被滑杆分支吞掉（Esc 不是滑杆键）。
        let vm = makeVM()
        vm.article = thirtySentenceArticle()
        vm.route = .reading
        vm.playScrubberFocused = true
        vm.settingsDrawerShown = true
        XCTAssertTrue(vm.handleKeyDown(escape))
        XCTAssertFalse(vm.settingsDrawerShown)
        XCTAssertEqual(vm.activeSentenceIdx, 0, "Esc 不翻句")
    }

    // MARK: - READ-9：查词防串扰（vm 级：新查词 cancel 旧 Task + 票根写回守卫，ReaderApp.tsx:1377-1420）

    private static let invalidDictMessage = "返回格式无法解析，请重试"

    @MainActor
    func testSlowOlderLookupDoesNotOverrideNewerLookupState() async {
        let chat = StubChat()
        let vm = makeVM(chat: chat)
        vm.article = thirtySentenceArticle()

        vm.lookup(query: "slow", sentenceIdx: 2)
        XCTAssertEqual(vm.dict, .loading(query: "slow", sentenceIdx: 2))
        XCTAssertEqual(vm.lensTab, .lex, "查词发生 → 透镜卡切到查词页签")
        await waitWaiters(chat.gate, 1, "slow 在途")

        vm.lookup(query: "fast", sentenceIdx: 2)   // 新查词：cancel 旧 Task + 领新票根
        XCTAssertEqual(vm.dict, .loading(query: "fast", sentenceIdx: 2))
        await waitWaiters(chat.gate, 2, "fast 在途")

        // FIFO：先放行 slow（旧）——迟到结果必须被丢弃，不覆盖新词的 loading 态
        await chat.gate.open("not json at all")
        await settle()
        XCTAssertEqual(vm.dict, .loading(query: "fast", sentenceIdx: 2), "慢的旧结果不得覆盖新词状态")

        // 再放行 fast → 畸形 JSON → error(fast)：新词自己的结果照常写回
        await chat.gate.open("not json at all")
        await waitUntil("fast 写回 error 态") {
            vm.dict == .error(query: "fast", sentenceIdx: 2, message: Self.invalidDictMessage)
        }
    }

    @MainActor
    func testCancelledOlderLookupErrorPathStaysSilent() async {
        // 旧请求被 cancel 后以错误返回（URLSession cancelled 的替身）：走 catch 分支也不写错误态。
        let chat = StubChat()
        let vm = makeVM(chat: chat)
        vm.article = thirtySentenceArticle()

        vm.lookup(query: "slow", sentenceIdx: 0)
        await waitWaiters(chat.gate, 1, "slow 在途")
        vm.lookup(query: "fast", sentenceIdx: 0)
        await waitWaiters(chat.gate, 2, "fast 在途")

        await chat.gate.abort(URLError(.cancelled))   // 最早的等待者 = slow
        await settle()
        XCTAssertEqual(vm.dict, .loading(query: "fast", sentenceIdx: 0), "被取消的旧请求不得把面板写成 error(slow)")

        await chat.gate.open("not json at all")
        await waitUntil("fast 写回 error 态") {
            vm.dict == .error(query: "fast", sentenceIdx: 0, message: Self.invalidDictMessage)
        }
    }

    @MainActor
    func testLateLookupResultDroppedAfterArticleSwitch() async {
        let chat = StubChat()
        let vm = makeVM(chat: chat)
        vm.article = thirtySentenceArticle()

        vm.lookup(query: "hello", sentenceIdx: 1)
        await waitWaiters(chat.gate, 1, "hello 在途")

        var another = thirtySentenceArticle()
        another.id = "r2-read-another-article"
        vm.article = another

        await chat.gate.open("not json at all")
        await settle()
        XCTAssertEqual(vm.dict, .loading(query: "hello", sentenceIdx: 1), "切文章后迟到结果被丢弃（不写回 error）")
    }

    @MainActor
    func testClosingLensCancelsInFlightLookupAndDropsLateResult() async {
        // 关闭查词页签即不再需要结果：在途请求取消，迟到结果不会把面板重新打开（好过 Windows）。
        let chat = StubChat()
        let vm = makeVM(chat: chat)
        vm.article = thirtySentenceArticle()

        vm.lookup(query: "hello", sentenceIdx: 1)
        await waitWaiters(chat.gate, 1, "hello 在途")
        vm.closeDictLens()
        XCTAssertEqual(vm.dict, .closed)
        XCTAssertEqual(vm.lensTab, .xray)

        await chat.gate.open("not json at all")
        await settle()
        XCTAssertEqual(vm.dict, .closed, "关闭后迟到结果不得重开面板")
        XCTAssertEqual(vm.lensTab, .xray)
    }

    @MainActor
    func testChunkCardTakesOverPanelAndDropsLateLookup() async {
        // 点词块即时卡接管面板：迟到的查词结果不得盖掉即时卡。
        let chat = StubChat()
        let vm = makeVM(chat: chat)
        vm.article = thirtySentenceArticle()

        vm.lookup(query: "hello", sentenceIdx: 1)
        await waitWaiters(chat.gate, 1, "hello 在途")
        let chunk = SentenceChunk(text: "take over", chunkType: .collocation, gloss: "接管")
        vm.openChunkCard(chunk: chunk, sentenceIdx: 1)
        XCTAssertEqual(vm.dict, .chunkCard(chunk: chunk, sentenceIdx: 1))

        await chat.gate.open("not json at all")
        await settle()
        XCTAssertEqual(vm.dict, .chunkCard(chunk: chunk, sentenceIdx: 1), "迟到查词结果不得覆盖即时卡")
    }
}
