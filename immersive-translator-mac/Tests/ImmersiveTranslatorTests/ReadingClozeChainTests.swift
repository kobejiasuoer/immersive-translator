import XCTest
import SwiftUI
import ReaderCore
@testable import ImmersiveTranslator

/// 随读抽查整链的应用层向量（§3-15；对齐 ReadingView.cloze.test.tsx 的 6 例 cloze 行为）：
/// - 开关只挖已读句（watermark 内），未读句词块保持普通标注；开关关闭零残留；
/// - Enter 本地判分（陷阱答案出「陷阱」+ 错答记录 + 朱批；known 槽答对 perfect 联动 SRS）；
/// - 首字母提示后命中降档 close；按住 H 显影（peek）；战绩 meter 随判分更新；
/// 另覆盖：ClozeSplice 原文↔渲染坐标映射、键链 typing 守卫（输入框内 Esc 退出专注）、
/// 听写/开口卡不接全局键、home Enter 用 activeDue、FocusCloze 行内输入框存在。
final class ReadingClozeChainTests: XCTestCase {
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
            .appendingPathComponent("reading-cloze-\(UUID().uuidString)", isDirectory: true)
        return ReaderViewModel(chat: StubChat(), store: ReaderStore(baseDirectory: dir))
    }

    private let nowMs = Int64(Date().timeIntervalSince1970 * 1000)

    /// ReadingView.cloze.test.tsx 的同一夹具：句 0 词块槽（带陷阱）、句 1 known 槽、
    /// 句 2 未读词块；watermark（progress.sentenceIdx）= 1。
    @MainActor
    private func seedArticle(_ vm: ReaderViewModel, watermark: Int = 1) -> Article {
        try? vm.store.saveVocabWord(VocabWord(
            id: "slumbered",
            word: "slumbered",
            kind: .word,
            senses: [VocabSense(pos: "v.", cn: "沉睡")],
            source: VocabSource(articleId: "a1", sentenceIdx: 1),
            srs: VocabSrsState(dueAt: nowMs - 10_000),
            addedAt: nowMs
        ))
        vm.refreshVocab()
        let article = Article(
            id: "a1",
            title: "The Town",
            titleCn: "小镇",
            titleCnState: .done,
            wordCount: 40,
            createdAt: 0,
            lastReadAt: 0,
            progress: ArticleProgress(sentenceIdx: watermark, percent: 40),
            sentences: [
                SentencePair(
                    idx: 0, paragraphIdx: 0,
                    en: "The tide is still making up its mind.",
                    zh: "潮水仍在犹豫。", zhState: .done,
                    chunks: [SentenceChunk(text: "making up its mind", chunkType: .idiom, gloss: "下定决心", trap: "making its mind")]
                ),
                SentencePair(idx: 1, paragraphIdx: 1, en: "For forty years the town slumbered.", zh: "小镇沉睡。", zhState: .done),
                SentencePair(
                    idx: 2, paragraphIdx: 2,
                    en: "Now cranes swing over the locks again.",
                    zh: "吊臂转动。", zhState: .done,
                    chunks: [SentenceChunk(text: "swing over", chunkType: .phrasal, gloss: "在…上空转动")]
                ),
            ]
        )
        vm.article = article
        vm.route = .reading
        return article
    }

    @MainActor
    private func quizVM(watermark: Int = 1) -> ReaderViewModel {
        let vm = makeVM()
        seedArticle(vm, watermark: watermark)
        // 直接赋全局设置（不走 patchSettings 落 UserDefaults，测试不碰真实设置）。
        vm.globalSettings = ReaderSettings.default
        vm.globalSettings.spotQuizMode = true
        return vm
    }

    private func keyDown(_ keyCode: UInt16, _ characters: String) -> NSEvent {
        NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: 0, context: nil, characters: characters,
            charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode
        )!
    }

    // MARK: - 选槽与开关

    @MainActor
    func testQuizOnlyDigsReadSentencesAndOffLeavesNoResidue() throws {
        let vm = quizVM()
        let slots = vm.clozeSlots
        XCTAssertEqual(Set(slots.keys), [0, 1], "句 0 词块槽 + 句 1 known 槽；句 2 未读不挖")
        XCTAssertNil(vm.clozeRenderMark(sentenceIdx: 2, offset: 0), "未读句不挖")

        let mark0 = try XCTUnwrap(vm.clozeRenderMark(sentenceIdx: 0, offset: 0))
        XCTAssertEqual(mark0.answer, "making up its mind")
        XCTAssertFalse(mark0.isKnown)
        XCTAssertEqual(mark0.note, "陷阱 · making its mind", "朱批随渲染态就位")

        vm.globalSettings.spotQuizMode = false
        XCTAssertTrue(vm.clozeSlots.isEmpty, "开关关闭：槽位恒为空集，正文零残留")
        XCTAssertNil(vm.clozeRenderMark(sentenceIdx: 0, offset: 0))
    }

    // MARK: - 判分整链

    @MainActor
    func testTrapVerdictOnChunkSlotLeavesSrsUntouched() throws {
        let vm = quizVM()
        let slot = try XCTUnwrap(vm.clozeSlots[0])
        vm.commitCloze(slot, raw: "making its mind")
        let st = try XCTUnwrap(vm.clozeState[slot.id])
        XCTAssertEqual(st.verdict, .trap)
        XCTAssertEqual(st.input, "making its mind", "错答记录（删除线显示用）")
        XCTAssertEqual(st.usedHint, false)
        // 词块槽不联动 SRS：known 槽对应的生词保持初值。
        let word = try XCTUnwrap(vm.vocabWords.first { $0.id == "slumbered" })
        XCTAssertEqual(word.srs.intervalDays, 0)
        XCTAssertNil(word.recall, "不进 recall 分桶")
        let toast = try XCTUnwrap(vm.clozeToasts.first)
        XCTAssertEqual(toast.label, "抽查完成", "词块槽 toast =「抽查完成」")
        XCTAssertEqual(toast.tone, .trap)
    }

    @MainActor
    func testKnownSlotPerfectLinksSrsAsGood() throws {
        let vm = quizVM()
        let slot = try XCTUnwrap(vm.clozeSlots[1])
        vm.commitCloze(slot, raw: "slumbered")
        let st = try XCTUnwrap(vm.clozeState[slot.id])
        XCTAssertEqual(st.verdict, .perfect)
        let word = try XCTUnwrap(vm.vocabWords.first { $0.id == "slumbered" })
        XCTAssertEqual(word.srs.intervalDays, 3, "clozeVerdictToGrade(perfect) = good = 3 天")
        XCTAssertEqual(word.recall?.byMode["cloze"]?.pass ?? 0, 1, "recall 分桶按 cloze 模式记一次 pass")
        XCTAssertEqual(vm.clozeToasts.last?.label, "已记入复习 · 良好")
    }

    @MainActor
    func testHintDowngradesPerfectToClose() throws {
        let vm = quizVM()
        let slot = try XCTUnwrap(vm.clozeSlots[1])
        let letters = vm.useClozeHint(slot)
        XCTAssertEqual(letters, "s…", "首字母提示不露答案")
        vm.commitCloze(slot, raw: "slumbered")
        let st = try XCTUnwrap(vm.clozeState[slot.id])
        XCTAssertEqual(st.verdict, .close, "用过提示的命中降档为接近")
        XCTAssertEqual(st.usedHint, true)
        let word = try XCTUnwrap(vm.vocabWords.first { $0.id == "slumbered" })
        XCTAssertEqual(word.srs.intervalDays, 1, "clozeVerdictToGrade(close) = hard = 1 天")
    }

    @MainActor
    func testPeekOnlyWhilePendingAndMeterUpdates() throws {
        let vm = quizVM()
        let slot0 = try XCTUnwrap(vm.clozeSlots[0])
        let slot1 = try XCTUnwrap(vm.clozeSlots[1])
        XCTAssertEqual(clozeMeterText(vm.clozeTallyNow), "抽查 0 命中 · 0 接近 · 0 陷阱 · 剩 2")

        vm.peekAll = true
        XCTAssertEqual(try XCTUnwrap(vm.clozeRenderMark(sentenceIdx: 1, offset: 0)).peeked, true, "按住 H：待答槽显影")
        vm.commitCloze(slot1, raw: "slumbered")
        XCTAssertFalse(try XCTUnwrap(vm.clozeRenderMark(sentenceIdx: 1, offset: 0)).peeked, "已答槽不再吃 peek")
        vm.peekAll = false
        vm.commitCloze(slot0, raw: "making its mind")
        let tally = vm.clozeTallyNow
        XCTAssertEqual(tally.hit, 1)
        XCTAssertEqual(tally.trap, 1)
        XCTAssertEqual(tally.todo, 0)
        XCTAssertEqual(clozeMeterText(tally), "抽查 1 命中 · 0 接近 · 1 陷阱 · 剩 0")
    }

    @MainActor
    func testSwitchingArticleResetsClozeState() throws {
        let vm = quizVM()
        let slot = try XCTUnwrap(vm.clozeSlots[1])
        vm.commitCloze(slot, raw: "slumbered")
        XCTAssertFalse(vm.clozeState.isEmpty)
        vm.article = Article(id: "a2", title: "Another", createdAt: 1, lastReadAt: 1, sentences: [])
        XCTAssertTrue(vm.clozeState.isEmpty, "槽位 id 是 句号:起点，换篇必须清作答态防错位印章")
    }

    // MARK: - ClozeSplice：原文 ↔ 渲染坐标映射

    func testClozeSpliceMapsAroundAttachments() {
        // 原文 "abc [defg] hij"（槽 defg 4 字 → 1 附件字符）。
        let splice = ClozeSplice(originalRanges: [NSRange(location: 4, length: 4)])
        XCTAssertEqual(splice.originalIndex(4), 4, "渲染 4 = 附件字符位置 → 槽起点")
        XCTAssertEqual(splice.renderedStart(4), 4)
        XCTAssertEqual(splice.renderedEnd(8), 5, "槽终点映到附件字符之后")
        XCTAssertEqual(splice.renderedStart(9), 6, "槽后正文前移 3")
        XCTAssertEqual(splice.originalIndex(6), 9)
        XCTAssertEqual(splice.renderedRange(NSRange(location: 9, length: 4)), NSRange(location: 6, length: 4))
        XCTAssertFalse(splice.isIdentity)
    }

    func testClozeSpliceIdentityAndMultiSlot() {
        XCTAssertTrue(ClozeSplice.identity.isIdentity)
        XCTAssertEqual(ClozeSplice.identity.renderedStart(7), 7)
        XCTAssertEqual(ClozeSplice.identity.originalIndex(7), 7)
        // 两个槽按原文坐标升序构造：第一槽 [2,5) 折成 1 字（净缩 2）→ 第二槽渲染位 9-2=7。
        let splice = ClozeSplice(originalRanges: [NSRange(location: 2, length: 3), NSRange(location: 9, length: 5)])
        XCTAssertEqual(splice.replacements[1].renderedLocation, 7)
        XCTAssertEqual(splice.originalIndex(7), 9, "第二个附件字符位置映回槽起点")
        XCTAssertEqual(splice.originalIndex(8), 14, "附件字符之后映回第二槽之后的正文")
        XCTAssertEqual(splice.renderedEnd(12), 8, "第二槽终点 = 第二附件字符之后")
        XCTAssertEqual(splice.renderedStart(12), 7, "第二槽内起点取附件字符位置")
    }

    // MARK: - 键链 typing 守卫（窗口监视器把全部 keyDown 交给 vm，由 vm 逐键让路）

    @MainActor
    private func windowWithTypingFocus(vm: ReaderViewModel) -> NSWindow {
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
        return window
    }

    @MainActor
    func testReadingGlobalKeysFallThroughWhileTyping() throws {
        let vm = quizVM(watermark: 2)
        vm.activeSentenceIdx = 0
        _ = windowWithTypingFocus(vm: vm)
        // 挖空输入框里打字：Space 不触发连播、J 不翻句、H 不显影（非输入态才接管）。
        XCTAssertFalse(vm.handleKeyDown(keyDown(49, " ")), "Space 应让路给输入框")
        XCTAssertFalse(vm.playbackPlaying)
        XCTAssertFalse(vm.handleKeyDown(keyDown(38, "j")), "J 应让路")
        XCTAssertEqual(vm.activeSentenceIdx, 0)
        XCTAssertFalse(vm.handleKeyDown(keyDown(4, "h")), "H（挖空显影）也应让路")
        XCTAssertFalse(vm.peekAll)
        // 焦点离开输入框后同一按键照常接管。
        XCTAssertTrue(vm.attachedWindow!.makeFirstResponder(nil))
        XCTAssertTrue(vm.handleKeyDown(keyDown(4, "h")))
        XCTAssertTrue(vm.peekAll)
        vm.handleKeyUp(keyDown(4, "h"))
    }

    @MainActor
    func testEscapeAndTabReachFocusModeWhileTyping() throws {
        let vm = makeVM()
        try vm.store.saveVocabWord(VocabWord(
            id: "unwind", word: "unwind", kind: .word,
            senses: [VocabSense(pos: "v.", cn: "放松")],
            source: VocabSource(articleId: "art-unwind", sentenceIdx: 0),
            srs: VocabSrsState(dueAt: nowMs - 10_000),
            addedAt: nowMs
        ))
        vm.sourceCache["art-unwind"] = Article(
            id: "art-unwind", title: "Focus", createdAt: 0, lastReadAt: 0,
            sentences: [SentencePair(idx: 0, paragraphIdx: 0, en: "Time will unwind slowly in the mountains.", zh: "译文", zhState: .done)]
        )
        vm.refreshVocab()
        vm.route = .vault
        vm.vaultPlayMode = .focus
        vm.startFocusReview(ids: ["unwind"])
        _ = windowWithTypingFocus(vm: vm)
        // VaultPage.tsx:814-828：Esc 不受 typing 守卫——输入框内也退出专注。
        XCTAssertTrue(vm.handleKeyDown(keyDown(53, "\u{1b}")))
        XCTAssertEqual(vm.vaultPlayMode, .home)
        XCTAssertEqual(vm.focusReviewIds, ["unwind"], "Esc 只切档不清 focusIds")
        // Tab 的 production 链路：reviewKeyHandler（视图注入）→ dispatchVaultKey → handleKey；
        // 输入框内 Tab = 下一级提示（Windows 同款不受 typing 守卫）。
        vm.vaultPlayMode = .focus
        let focus = VaultFocusModel()
        focus.rebuild(vm: vm)
        vm.reviewKeyHandler = { event in
            ReaderVaultView.dispatchVaultKey(event, vm: vm, focus: focus, typing: true)
        }
        XCTAssertTrue(vm.handleKeyDown(keyDown(48, "\t")))
        XCTAssertEqual(focus.hints, 1, "输入框内 Tab 推进提示阶梯")
    }

    // MARK: - 听写 / 开口卡不接全局键（VaultPage.tsx:821 effKind !== "cloze" → return）

    @MainActor
    private func makeVaultVM(ids: [String], sentence: String, due: Bool = true) throws -> ReaderViewModel {
        let vm = makeVM()
        for (i, id) in ids.enumerated() {
            try vm.store.saveVocabWord(VocabWord(
                id: id, word: id, kind: .word,
                senses: [VocabSense(pos: "v.", cn: "放松")],
                source: VocabSource(articleId: ids.isEmpty ? "" : "art-\(id)", sentenceIdx: 0),
                srs: VocabSrsState(dueAt: due ? nowMs - 10_000 - Int64(i) : nowMs + 3_600_000),
                addedAt: nowMs
            ))
            if !sentence.isEmpty {
                vm.sourceCache["art-\(id)"] = Article(
                    id: "art-\(id)",
                    title: "Focus",
                    createdAt: 0, lastReadAt: 0,
                    sentences: [SentencePair(idx: 0, paragraphIdx: 0, en: sentence, zh: "译文", zhState: .done)]
                )
            }
        }
        vm.refreshVocab()
        return vm
    }

    @MainActor
    func testDictationCardIgnoresGlobalEnterAndDigits() throws {
        let vm = try makeVaultVM(ids: ["unwind", "calm"], sentence: "Time will unwind and calm slowly.")
        let model = VaultFocusModel()
        model.rebuild(vm: vm)
        // 第一关 = 完形：输入 → Enter 提交判分 → Enter 采纳建议档（good）→ 轮转到听写卡。
        XCTAssertEqual(model.effectiveKind(vm: vm), .cloze)
        // dueAt 早者在队首：calm 先出（完形卡），评掉后轮转到 unwind 的听写卡。
        XCTAssertEqual(model.current?.id, "calm")
        model.input = "calm"
        XCTAssertTrue(model.handleKey(keyDown(36, "\r"), vm: vm, typing: false), "未判分 Enter = 提交")
        XCTAssertEqual(model.verdict, .perfect)
        XCTAssertTrue(model.handleKey(keyDown(36, "\r"), vm: vm, typing: false), "已判分 Enter = 采纳建议档")
        XCTAssertEqual(model.session.step, 1, "评完第一关轮转")
        XCTAssertEqual(model.effectiveKind(vm: vm), .dictation)
        model.verdict = .perfect
        // 听写卡已判分：全局 Enter / 数字直选一律不消费（Windows 建议档可为 easy，只走四档点击）。
        XCTAssertFalse(model.handleKey(keyDown(36, "\r"), vm: vm, typing: false))
        XCTAssertFalse(model.handleKey(keyDown(19, "2"), vm: vm, typing: false))
        let unwind = try XCTUnwrap(vm.vocabWords.first { $0.id == "unwind" })
        XCTAssertEqual(unwind.srs.intervalDays, 0, "听写卡不接全局键 → 未评分")
        // 回归护栏：完形卡已判分 Enter 仍采纳建议档（VaultPage.test.tsx「不是 easy」向量）。
        model.session = VaultFocusSession()
        model.rebuild(vm: vm)
        XCTAssertEqual(model.effectiveKind(vm: vm), .cloze)
        model.verdict = .perfect
        XCTAssertTrue(model.handleKey(keyDown(36, "\r"), vm: vm, typing: false))
        let unwindAfter = try XCTUnwrap(vm.vocabWords.first { $0.id == "unwind" })
        XCTAssertEqual(unwindAfter.srs.intervalDays, 3, "完形卡 Enter 采纳 good（不是 easy）")
    }

    @MainActor
    func testHomeEnterUsesActiveDueBatch() throws {
        // 词未到期（全局 dueWords 空）但 focusIds 批次非空 → home Enter 仍可用（activeDue 口径）。
        let vm = try makeVaultVM(ids: ["w1"], sentence: "", due: false)
        XCTAssertTrue(vm.dueWords.isEmpty, "前置：全局无到期")
        vm.startFocusReview(ids: ["w1"])
        XCTAssertTrue(vm.exitFocusModeOnEscape(), "focus → home（保留批次）")
        XCTAssertEqual(vm.vaultPlayMode, .home)
        XCTAssertEqual(vm.reviewQueue.map(\.id), ["w1"], "activeDue = 该批词（ReaderApp.tsx:2067-2070）")
        let before = vm.vocabWords.map { $0.srs.intervalDays }
        let focus = VaultFocusModel()
        focus.rebuild(vm: vm)
        XCTAssertTrue(ReaderVaultView.dispatchVaultKey(keyDown(36, "\r"), vm: vm, focus: focus, typing: false), "home Enter = 开始复习（批次非空）")
        XCTAssertEqual(vm.vaultPlayMode, .focus)
        XCTAssertEqual(vm.vocabWords.map { $0.srs.intervalDays }, before, "Enter 只切档不评分")
    }

    // MARK: - FocusCloze 行内输入框（ReviewView.tsx BlankInput 契约的 Mac 对应物）

    func testBlankInputWidthFollowsWindowsRule() {
        // min(320, max(150, 文本宽 + 30))；空输入量 placeholder（Windows `value || placeholder` 同口径）。
        XCTAssertEqual(VaultBlankInput.width(for: "", fontPair: .serif), VaultBlankInput.width(for: VaultBlankInput.placeholder, fontPair: .serif))
        XCTAssertLessThanOrEqual(VaultBlankInput.width(for: "", fontPair: .serif), 320)
        XCTAssertEqual(VaultBlankInput.width(for: "it", fontPair: .serif), 150, "短词夹到 vault min-width 150")
        XCTAssertGreaterThanOrEqual(VaultBlankInput.width(for: "unwind", fontPair: .serif), 150)
        XCTAssertGreaterThan(
            VaultBlankInput.width(for: "a very long blank phrase indeed", fontPair: .serif), 300
        )
        XCTAssertEqual(VaultBlankInput.placeholder, "写出被挖空的部分")
    }

    @MainActor
    func testFocusClozeCardRendersInlineTextField() throws {
        // 回归护栏：VaultFocusClozeCard 大句里必须有真正的输入框（旧行为曾把 input 当
        // Text 展示导致「提交」永久禁用）。SwiftUI TextField 在 macOS 由 NSTextField 承载。
        let vm = try makeVaultVM(ids: ["unwind"], sentence: "Time will unwind slowly in the mountains.")
        let model = VaultFocusModel()
        model.rebuild(vm: vm)
        XCTAssertEqual(model.effectiveKind(vm: vm), .cloze, "前置：完形卡")
        let card = VaultFocusClozeCard(
            word: try XCTUnwrap(model.current),
            spec: try XCTUnwrap(model.spec(vm: vm)),
            input: Binding(get: { model.input }, set: { model.input = $0 }),
            hints: 0,
            verdict: nil,
            sourceLabel: "来自《Focus》",
            palette: ReaderPalette.palette(for: .light),
            fontPair: .serif,
            onHint: {}, onSubmit: {}, onGiveUp: {}, onJump: {}, onGrade: { _ in }
        )
        let host = NSHostingView(rootView: card.frame(width: 640))
        host.layoutSubtreeIfNeeded()
        let field = firstTextField(in: host, placeholder: VaultBlankInput.placeholder)
        XCTAssertNotNil(field, "完形卡应渲染出「写出被挖空的部分」输入框")
    }

    private func firstTextField(in view: NSView, placeholder: String, depth: Int = 0) -> NSTextField? {
        guard depth < 40 else { return nil }
        if let field = view as? NSTextField, field.placeholderString == placeholder {
            return field
        }
        for sub in view.subviews {
            if let hit = firstTextField(in: sub, placeholder: placeholder, depth: depth + 1) {
                return hit
            }
        }
        return nil
    }
}
