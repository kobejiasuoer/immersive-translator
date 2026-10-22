import SwiftUI
import AppKit
import AVFoundation
import ReaderCore
import XfyunCore

/// 快速复习迷你窗（托盘/提醒卡直达）。对齐 Windows QuickReviewApp：
/// - 只做识别 + 完形（听写留阅读室）；‹ › / ←→ / 圆点自由切卡，不评分也能跳。
/// - 每卡 UI 状态独立保留；识别卡 Space 双向翻面反复自测。
/// - 已评卡可改评（按进窗时原 SRS 重算不叠加）；首评打卡一次，改评留在原地。
/// - 评分即落盘收起不丢；结束页（连续打卡、完成/未评统计、打开阅读室）；Esc 收起。
/// - REV-7：完形判分答案 = 句中词块原文（与 ReaderReviewView.chunkBlank 同语义），
///   绝不传挖空后的整句——close 档与阅读室一致生效。
/// - REV-8：dueAt 升序、←→/Space/1-4/Esc 键盘、识别卡发音（失败归因+重试+设置）、
///   来源标签、两级提示阶梯（词数按空格分词）、直译陷阱行、已评间隔文案、
///   判分后才出现评分、空态/收工页文案与圆点已评态。

@MainActor
final class QuickReviewWindowController {
    private var window: NSWindow?
    /// vm 由 controller 持有（单窗口单 vm）：重开窗不新建，靠 show 时 reload 作废上次会话。
    private var vm: QuickReviewViewModel?
    /// 本窗键盘监听（←/→/Space/1-4/Esc；装一次，只在迷你窗为 key 时消费事件）。
    private var keyMonitor: Any?

    func show() {
        if window == nil {
            let vm = QuickReviewViewModel()
            vm.onDismiss = { [weak self] in self?.hide() }
            let view = QuickReviewView(vm: vm)
            let w = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 440, height: 640),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            w.title = "快速复习"
            w.contentView = NSHostingView(rootView: view)
            w.level = .floating
            w.isReleasedWhenClosed = false
            self.vm = vm
            window = w
        }
        installKeyMonitor()
        // 每次进窗先重拉到期词（对齐 Windows：show 即重建卡片，不复用上次会话的旧到期卡）。
        vm?.reload()
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Esc / 标题栏 ✕ / 完成按钮：收起不退出（进度已落盘，随时回来续）。
    func hide() {
        window?.orderOut(nil)
    }

    /// REV-8②：键盘 ←/→ 切卡（输入框聚焦不劫持）、识别卡 Space 双向翻面、
    /// 1–4 评分（判分/翻面后才生效）、Esc 收起。只在迷你窗自己是 key 时消费。
    private func installKeyMonitor() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, let window = self.window, NSApp.keyWindow === window else { return event }
            return self.vm?.handleKey(event) == true ? nil : event
        }
    }
}

@MainActor
final class QuickReviewViewModel: ObservableObject {
    /// 卡片形态：完形（词块且句中可定位）或识别（其余，含降级）。
    enum Mode {
        case cloze
        case recognition
    }

    struct Card {
        var word: VocabWord
        var mode: Mode
        /// 完形句与译文（识别卡的书证也用它；nil = 无句素材）。
        var sentence: String?
        var sentenceZh: String?
        /// REV-8④：卡面来源标签（文章·第N句 / 收藏时例句 / 划词收藏）。
        var sourceLabel: String
        /// 进窗时的 SRS 快照（改评重算不叠加）。
        var baseSrs: VocabSrsState
        var revealed = false
        var graded: ReviewGrade?
        var answer = ""
        var verdict: RecallVerdict?
        /// 完形提示阶梯（① 释义 ② 槽位；对齐 Windows 两级）。
        var hintLevel = 0
    }

    @Published var cards: [Card] = []
    @Published var pos = 0
    @Published var finished = false
    @Published var streak = 0
    /// Esc / 完成按钮收起窗口（controller 注入）。
    var onDismiss: (() -> Void)?

    init() {
        reload()
    }

    func reload() {
        guard let file = try? ReaderStore.shared.getVocabFile() else {
            cards = []
            finished = false
            return
        }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        // REV-8①：到期卡按 dueAt 升序（最紧急在前），与阅读室队列同序。
        let due = dueVocab(file.words, now: now)
        var cache: [String: Article?] = [:]
        cards = due.map { prepare($0, cache: &cache) }
        pos = 0
        finished = false
        streak = reviewStats(file.words, file.reviewLog, nowMs: now).streak
    }

    /// 组装一张卡：smart 路由词块→完形（句缺失/定位不到降级识别）；其余→识别
    ///（听写需要连播语境，留阅读室——对齐 Windows prepareCards）。
    private func prepare(_ word: VocabWord, cache: inout [String: Article?]) -> Card {
        var mode: Mode = routeRecallMode(word, .smart) == .cloze ? .cloze : .recognition
        var sentence: String?
        var sentenceZh: String?
        var sourceLabel = "划词收藏"

        let articleId = word.source.articleId
        if !articleId.isEmpty {
            let cached: Article? = {
                if let article = cache[articleId] { return article }
                let loaded = (try? ReaderStore.shared.getArticle(id: articleId)) ?? nil
                cache[articleId] = .some(loaded)
                return loaded
            }()
            if let article = cached,
               let pair = article.sentences[safe: word.source.sentenceIdx] {
                sentence = pair.en
                sentenceZh = pair.zh
                sourceLabel = "\(article.title) · 第 \(word.source.sentenceIdx + 1) 句"
            }
        } else if let example = word.example {
            sentence = example.en
            sentenceZh = example.zh
            sourceLabel = "收藏时例句"
        }

        if mode == .cloze, sentence == nil || findChunkRange(sentence ?? "", word.word) == nil {
            mode = .recognition // 句子缺失或词块已改写：降级为识别
        }
        return Card(
            word: word,
            mode: mode,
            sentence: sentence,
            sentenceZh: sentenceZh,
            sourceLabel: sourceLabel,
            baseSrs: word.srs
        )
    }

    var current: Card? {
        cards.indices.contains(pos) ? cards[pos] : nil
    }

    var isCloze: Bool {
        current?.mode == .cloze
    }

    func moveTo(_ delta: Int) {
        guard !cards.isEmpty else { return }
        pos = min(cards.count - 1, max(0, pos + delta))
    }

    func jump(to index: Int) {
        guard cards.indices.contains(index) else { return }
        pos = index
    }

    func revealToggle() {
        guard cards.indices.contains(pos) else { return }
        cards[pos].revealed.toggle()
    }

    func hint() {
        guard cards.indices.contains(pos), cards[pos].mode == .cloze else { return }
        cards[pos].hintLevel = min(2, cards[pos].hintLevel + 1)
    }

    /// REV-7：判分答案 = 句中词块原文（findChunkRange 定位的 substring；
    /// 与 ReaderReviewView.chunkBlank 同语义），accepted 兜底词条原形。
    static func clozeAnswer(sentence: String?, word: String) -> String {
        guard let sentence, let range = findChunkRange(sentence, word) else { return word }
        let units = Array(sentence.utf16)
        let start = min(range.start, units.count)
        let end = min(range.end, units.count)
        guard start < end else { return word }
        return String(decoding: units[start..<end], as: UTF16.self)
    }

    func submitCloze() {
        guard cards.indices.contains(pos) else { return }
        let input = cards[pos].answer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cards[pos].verdict == nil, !input.isEmpty else { return }
        let card = cards[pos]
        let answer = Self.clozeAnswer(sentence: card.sentence, word: card.word.word)
        cards[pos].verdict = judgeCloze(
            input,
            answer,
            options: JudgeOptions(trap: card.word.trap, accepted: [card.word.word])
        )
        cards[pos].revealed = true
    }

    /// 「想不出来直接看答案」：按 wrong 判分并翻面（可与 ClozeCard「看答案」共用语义）。
    func submitClozeForceReveal() {
        guard cards.indices.contains(pos) else { return }
        cards[pos].verdict = .wrong
        cards[pos].revealed = true
    }

    /// 判分/翻面已给出 → 评分条可用（REV-8⑧：完形未提交判分时不可评分）。
    var gradedShown: Bool {
        guard let card = current else { return false }
        return card.mode == .recognition ? card.revealed : card.verdict != nil
    }

    func grade(_ grade: ReviewGrade) {
        guard cards.indices.contains(pos) else { return }
        var card = cards[pos]
        let first = card.graded == nil
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        card.graded = grade
        var updated = card.word
        // 改评：一律按进窗时原 SRS 重算，不叠加
        updated.srs = gradeSrs(card.baseSrs, grade, now: now)
        // 错题分桶：完形按判分，识别卡按评分；recall 只在首次累加（改评不重复记）
        if first {
            let mode: RecallMode = card.mode == .cloze ? .cloze : .recognition
            let bucket = recallBucket(mode: mode, judged: card.verdict, grade: grade)
            updated.recall = recordRecallStat(card.word.recall, mode: mode, bucket: bucket, nowMs: now)
        } else {
            updated.recall = card.word.recall
        }
        _ = try? ReaderStore.shared.saveVocabWord(updated)
        // 首评打卡一次（对齐 Windows applyGrade：first ? readerRecordReview : null）
        if first {
            _ = try? ReaderStore.shared.recordReview(day: dayKey(nowMs: now))
            if let file = try? ReaderStore.shared.getVocabFile() {
                streak = reviewStats(file.words, file.reviewLog, nowMs: now).streak
            }
        }
        cards[pos] = card
        ReviewTouchpointManager.shared.refreshBadge()
        // 首评才前进（尾卡评完即收工）；回看改评留在原地
        if first {
            if pos + 1 < cards.count {
                pos += 1
            } else {
                finished = true
            }
        }
    }

    var gradedCount: Int { cards.filter { $0.graded != nil }.count }

    // MARK: - 键盘（REV-8②）

    /// 输入框聚焦时不劫持箭头/空格（SwiftUI 文本编辑器的 field editor 是 NSTextView）。
    private var isTyping: Bool {
        NSApp.keyWindow?.firstResponder is NSTextView
    }

    @discardableResult
    func handleKey(_ event: NSEvent) -> Bool {
        // Esc：收起（进度已保存）——无论哪张卡、是否输入态都生效。
        if event.keyCode == 53 {
            onDismiss?()
            return true
        }
        guard !finished, current != nil else { return false }
        let typing = isTyping
        if !typing, event.keyCode == 123 { // ←
            moveTo(-1)
            return true
        }
        if !typing, event.keyCode == 124 { // →
            moveTo(1)
            return true
        }
        guard let key = event.charactersIgnoringModifiers else { return false }
        if ["1", "2", "3", "4"].contains(key), gradedShown {
            grade(ReviewGrade.allCases[Int(key)! - 1])
            return true
        }
        if !typing, key == " ", current?.mode == .recognition {
            revealToggle()
            return true
        }
        return false
    }
}

// MARK: - 发音（REV-8③：失败归因 + 重试 + 打开设置）

/// 迷你窗独立朗读器：引擎随全局阅读设置（讯飞缺凭据直接归因，不静默换引擎）；
/// 失败经 classifyTtsError 分类展示，可重试、可跳设置。对齐 Windows ttsSpeakAdvanced
/// + classifyTtsError 的迷你窗行为（PanelTtsSpeaker 的同族实现，目标位更简单：单按钮）。
@MainActor
final class QuickReviewSpeaker: NSObject, ObservableObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    @Published var error: TtsErrorInfo?
    @Published private(set) var speaking = false

    private let synth = AVSpeechSynthesizer()
    private var player: AVAudioPlayer?
    private var task: Task<Void, Never>?

    override init() {
        super.init()
        synth.delegate = self
    }

    func speak(_ text: String) {
        error = nil
        stopPlayback()
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        let provider = ReaderStore.shared.loadGlobalReaderSettings().ttsProvider
        speaking = true
        task = Task { [weak self] in
            do {
                let data: Data
                switch provider {
                case .xfyun:
                    guard XfyunTtsEngine.shared.isReady else {
                        throw QuickReviewSpeakerError.credentials
                    }
                    data = try await XfyunTtsEngine.shared.audioData(for: clean)
                case .edge:
                    data = try await EdgeTtsEngine.shared.audioData(for: clean)
                case .local:
                    throw QuickReviewSpeakerError.useLocal
                }
                guard !Task.isCancelled else { return }
                let pcmPlayer = try AVAudioPlayer(data: data, fileTypeHint: AVFileType.mp3.rawValue)
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    self.player = pcmPlayer
                    pcmPlayer.delegate = self
                    pcmPlayer.play()
                }
            } catch {
                guard !Task.isCancelled else { return }
                guard let self else { return }
                if case QuickReviewSpeakerError.useLocal = error {
                    self.speakLocal(clean)
                } else {
                    await MainActor.run { [weak self] in
                        self?.speaking = false
                        self?.error = classifyTtsError(error)
                    }
                }
            }
        }
    }

    private func speakLocal(_ text: String) {
        let utterance = AVSpeechUtterance(string: text)
        let voices = AVSpeechSynthesisVoice.speechVoices()
        let target = looksMostlyChinese(text) ? "zh" : "en"
        utterance.voice = voices.first { $0.language.hasPrefix(target) }
            ?? AVSpeechSynthesisVoice(language: looksMostlyChinese(text) ? "zh-CN" : "en-US")
        synth.speak(utterance)
    }

    private func stopPlayback() {
        task?.cancel()
        task = nil
        synth.stopSpeaking(at: .immediate)
        player?.stop()
        player = nil
        speaking = false
    }

    nonisolated func speechSynthesizer(_: AVSpeechSynthesizer, didFinish _: AVSpeechUtterance) {
        Task { @MainActor [weak self] in self?.speaking = false }
    }

    nonisolated func audioPlayerDidFinishPlaying(_: AVAudioPlayer, successfully _: Bool) {
        Task { @MainActor [weak self] in self?.speaking = false }
    }
}

private enum QuickReviewSpeakerError: Error {
    /// 缺讯飞合成凭据：走 classifyTtsError 归因为凭据类（附「打开设置」）。
    case credentials
    /// 本地引擎：不走云、不报错。
    case useLocal
}

extension QuickReviewSpeakerError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .credentials: return "讯飞合成凭据未配置（设置 → 语音）"
        case .useLocal: return nil
        }
    }
}

// MARK: - 视图

struct QuickReviewView: View {
    @ObservedObject var vm: QuickReviewViewModel
    @StateObject private var speaker = QuickReviewSpeaker()
    @FocusState private var clozeFocused: Bool

    var body: some View {
        Group {
            if vm.cards.isEmpty {
                emptyPage
            } else if vm.finished {
                endPage
            } else {
                cardPage
            }
        }
        .frame(minWidth: 420, minHeight: 600)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    /// REV-8⑨：空态给「打开阅读室 / 完成」出口。
    private var emptyPage: some View {
        VStack(spacing: 10) {
            ZStack {
                Circle().stroke(Color.green.opacity(0.35), lineWidth: 2).frame(width: 56, height: 56)
                Text("✓").font(.system(size: 24, weight: .semibold)).foregroundColor(.green)
            }
            Text("现在没有到期的生词").font(.system(size: 14, weight: .semibold))
            Text("到期了托盘图标会带数字提醒你；现在去阅读里攒几个新词吧。")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
            HStack(spacing: 10) {
                Button("打开阅读室") { openReader() }
                    .controlSize(.small)
                Button("完成") { vm.onDismiss?() }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
            }
            .padding(.top, 4)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// REV-8⑨：收工页统计「没评的仍在到期队列」、圆点显示已评状态。
    private var endPage: some View {
        VStack(spacing: 10) {
            ZStack {
                Circle().stroke(Color.green.opacity(0.35), lineWidth: 2).frame(width: 56, height: 56)
                Text("✓").font(.system(size: 24, weight: .semibold)).foregroundColor(.green)
            }
            Text("今天收工").font(.system(size: 15, weight: .semibold))
            Text("连续打卡 \(vm.streak) 天")
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(.secondary)
            Text(vm.gradedCount >= vm.cards.count
                 ? "这 \(vm.cards.count) 个词都往后推了一轮。明天到期时提醒会再来，也可以随时从托盘点开。"
                 : "本次评了 \(vm.gradedCount) / \(vm.cards.count) 个，没评的仍在到期队列，下次提醒会再来。")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 3) {
                ForEach(vm.cards.indices, id: \.self) { i in
                    Circle()
                        .fill(vm.cards[i].graded != nil ? Color.green : Color.secondary.opacity(0.3))
                        .frame(width: 6, height: 6)
                }
            }
            .padding(.top, 2)
            HStack(spacing: 10) {
                Button("打开阅读室") { openReader() }
                    .controlSize(.small)
                Button("完成") { vm.onDismiss?() }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
            }
            .padding(.top, 4)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func openReader() {
        (NSApp.delegate as? AppDelegate)?.openReaderFromTouchpoint()
        vm.onDismiss?()
    }

    private var cardPage: some View {
        VStack(spacing: 0) {
            navRow
            if let card = vm.current {
                ScrollView {
                    if card.mode == .cloze {
                        clozeCard(card)
                    } else {
                        recognitionCard(card)
                    }
                }
            }
            bottomBar
        }
        // 每张完形卡渲染后聚焦输入框（对齐 Windows inputRef.current?.focus()）。
        .onChange(of: vm.pos) { _ in
            clozeFocused = vm.isCloze
        }
    }

    /// REV-8⑨：圆点可点跳转并显示已评状态。
    private var navRow: some View {
        HStack(spacing: 10) {
            Button {
                clozeFocused = false
                vm.moveTo(-1)
            } label: {
                Image(systemName: "chevron.left")
            }
            .buttonStyle(.borderless)
            .disabled(vm.pos == 0)
            .help("上一张（←）")
            HStack(spacing: 4) {
                ForEach(vm.cards.indices, id: \.self) { i in
                    Circle()
                        .fill(dotColor(i))
                        .frame(width: 6, height: 6)
                        .onTapGesture { vm.jump(to: i) }
                        .help("第 \(i + 1) 张")
                }
            }
            Button {
                clozeFocused = false
                vm.moveTo(1)
            } label: {
                Image(systemName: "chevron.right")
            }
            .buttonStyle(.borderless)
            .disabled(vm.pos >= vm.cards.count - 1)
            .help("下一张（→）")
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 4)
    }

    private func dotColor(_ i: Int) -> Color {
        if vm.cards[i].graded != nil { return .green }
        return i == vm.pos ? .accentColor : Color.secondary.opacity(0.35)
    }

    // MARK: 完形卡

    private func clozeCard(_ card: QuickReviewViewModel.Card) -> some View {
        let word = card.word
        let answer = QuickReviewViewModel.clozeAnswer(sentence: card.sentence, word: word.word)
        return VStack(alignment: .leading, spacing: 12) {
            Text("词块 · 完形")
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundColor(.white)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Color.orange)
                .clipShape(Capsule())

            clozeSentence(card, word: word, answer: answer)

            if card.verdict == nil {
                hintLadder(card, word: word, answer: answer)
                HStack(spacing: 8) {
                    Button("提交判分（↩）") {
                        clozeFocused = false
                        vm.submitCloze()
                    }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
                    .disabled(card.answer.trimmingCharacters(in: .whitespaces).isEmpty)
                    Button("想不出来？看答案") {
                        clozeFocused = false
                        vm.submitClozeForceReveal()
                    }
                    .controlSize(.small)
                }
            } else if let verdict = card.verdict {
                verdictRow(verdict, answer: answer, input: card.answer)
                // REV-8⑥：判分后直译陷阱提示行
                if verdict == .trap, let trap = word.trap, !trap.isEmpty {
                    Text("直译陷阱 · \(trap)")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundColor(.red)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.red.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
            }

            Text(card.sourceLabel)
                .font(.system(size: 11))
                .foregroundColor(.secondary)
                .padding(.top, 2)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { clozeFocused = true }
    }

    /// 句内槽位：判分前输入框嵌进句中；判分后按档着色回显答案（对齐 Windows qr-slot）。
    private func clozeSentence(
        _ card: QuickReviewViewModel.Card,
        word: VocabWord,
        answer: String
    ) -> some View {
        let sentence = card.sentence ?? word.word
        let range = findChunkRange(sentence, word.word)
        let units = Array(sentence.utf16)
        let pre: String
        let post: String
        if let range {
            pre = String(decoding: units[0..<min(range.start, units.count)], as: UTF16.self)
            post = String(decoding: units[min(range.end, units.count)...], as: UTF16.self)
        } else {
            pre = ""
            post = ""
        }
        return HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(pre)
            slotView(card: card, answer: answer)
            Text(post)
        }
        .font(.system(size: 14.5, design: .serif))
        .lineSpacing(4)
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func slotView(card: QuickReviewViewModel.Card, answer: String) -> some View {
        if let verdict = card.verdict {
            let color: Color = verdict == .perfect ? .green : (verdict == .close ? .orange : .red)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                if verdict == .wrong || verdict == .trap {
                    Text(card.answer.isEmpty ? "…" : card.answer)
                        .strikethrough()
                        .foregroundColor(color)
                }
                Text(answer).fontWeight(.semibold).foregroundColor(color)
            }
            .underline()
        } else {
            TextField("填入词块", text: binding(for: card))
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 13))
                .frame(width: max(120, CGFloat(answer.count * 10) + 40))
                .focused($clozeFocused)
                .onSubmit { vm.submitCloze() }
        }
    }

    /// REV-8⑤：两级提示阶梯——① 释义 ② 槽位（首字母 + 分词词数，按空格计数）。
    @ViewBuilder
    private func hintLadder(_ card: QuickReviewViewModel.Card, word: VocabWord, answer: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if card.hintLevel == 0 {
                Button("想不起来？看提示") { vm.hint() }
                    .buttonStyle(.link)
                    .font(.system(size: 11.5))
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("① 释义").font(.system(size: 10.5, weight: .bold)).foregroundColor(.orange)
                    Text(word.senses.first?.cn ?? "（无释义，凭语感试试）")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }
                if card.hintLevel >= 2 {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("② 槽位").font(.system(size: 10.5, weight: .bold)).foregroundColor(.orange)
                        Text(slotHint(word: word, answer: answer))
                            .font(.system(size: 12))
                            .foregroundColor(.secondary)
                    }
                } else {
                    Button("再看一步") { vm.hint() }
                        .buttonStyle(.link)
                        .font(.system(size: 11.5))
                }
            }
        }
    }

    /// 槽位提示：有记法给记法，否则首字母 + 词数（词数 = 空格分词数，非字符数）。
    private func slotHint(word: VocabWord, answer: String) -> String {
        if let pattern = word.pattern, !pattern.isEmpty { return pattern }
        let wordCount = answer
            .trimmingCharacters(in: .whitespaces)
            .split(separator: " ")
            .count
        return "\(answer.prefix(1))…（\(wordCount) 词）"
    }

    private func verdictRow(_ verdict: RecallVerdict, answer: String, input: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(verdict.headline)
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundColor(verdictColor(verdict))
            if verdict == .close {
                Text("你写的：\(input.trimmingCharacters(in: .whitespaces))")
                    .font(.system(size: 11.5))
                    .foregroundColor(.secondary)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(verdictColor(verdict).opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    // MARK: 识别卡

    private func recognitionCard(_ card: QuickReviewViewModel.Card) -> some View {
        let word = card.word
        return VStack(alignment: .leading, spacing: 12) {
            Text(word.effectiveKind == .chunk ? "词块 · 识别" : "单词 · 识别")
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundColor(.white)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Color.purple)
                .clipShape(Capsule())

            HStack(spacing: 8) {
                Text(word.word)
                    .font(.system(size: 21, weight: .semibold, design: .serif))
                // REV-8③：发音按钮 + 失败归因/重试/打开设置
                Button {
                    speaker.speak(word.word)
                } label: {
                    Image(systemName: speaker.speaking ? "speaker.wave.2.fill" : "speaker.wave.2")
                        .font(.system(size: 13))
                }
                .buttonStyle(.borderless)
                .help("发音")
                Spacer()
            }
            if speaker.error != nil {
                speakErrorRow
            }
            if let phonetic = word.phonetic {
                Text(phonetic).font(.system(size: 12)).foregroundColor(.secondary)
            }

            Button {
                vm.revealToggle()
            } label: {
                Text(card.revealed ? "盖住释义" : "显示释义")
                    .font(.system(size: 11.5))
            }
            .buttonStyle(.link)

            if card.revealed {
                VStack(alignment: .leading, spacing: 4) {
                    let senses = word.senses.prefix(3)
                    if senses.isEmpty {
                        Text("（无释义记录，凭印象评分即可）")
                            .font(.system(size: 12.5))
                            .foregroundColor(.secondary)
                    }
                    ForEach(Array(senses.enumerated()), id: \.offset) { _, sense in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            if !sense.pos.isEmpty {
                                Text(sense.pos).font(.system(size: 11.5, weight: .medium)).foregroundColor(.accentColor)
                            }
                            Text(sense.cn).font(.system(size: 13))
                        }
                    }
                    if let trap = word.trap, !trap.isEmpty {
                        Text("直译陷阱 · \(trap)")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundColor(.red.opacity(0.9))
                    }
                }
            }

            Text(card.sourceLabel)
                .font(.system(size: 11))
                .foregroundColor(.secondary)
                .padding(.top, 2)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// REV-8③：发音失败给归因 + 重试 + 打开设置（设置窗独立弹出，不收起本迷你窗）。
    @ViewBuilder
    private var speakErrorRow: some View {
        if let error = speaker.error {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundColor(.orange)
                Text(error.message)
                    .font(.system(size: 11.5))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                if let word = vm.current?.word {
                    Button("重试") { speaker.speak(word.word) }
                        .buttonStyle(.link)
                        .font(.system(size: 11.5))
                }
                if error.allowSettings {
                    Button("打开设置") {
                        (NSApp.delegate as? AppDelegate)?.openSettingsFromReader()
                    }
                    .buttonStyle(.link)
                    .font(.system(size: 11.5))
                }
            }
            .padding(8)
            .background(Color.orange.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
    }

    // MARK: 底部（已评条 + 评分 + 快捷键脚注）

    private var bottomBar: some View {
        VStack(spacing: 6) {
            // REV-8⑦：已评卡显示档位 + 间隔文案（可直接改评）
            if let graded = vm.current?.graded {
                Text("已评分：\(graded.label) · \(graded.nextLabel)（可直接改评）")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
            }
            // REV-8⑧：判分/翻面后才出现评分（识别卡翻面即评；完形卡先提交判分）
            if vm.gradedShown, let card = vm.current {
                let suggested: ReviewGrade? = card.mode == .recognition
                    ? .good
                    : card.verdict.map { verdictToSuggestedGrade($0) }
                HStack(spacing: 8) {
                    ForEach(ReviewGrade.allCases, id: \.self) { grade in
                        Button {
                            vm.grade(grade)
                        } label: {
                            VStack(spacing: 1) {
                                Text(grade.label)
                                    .font(.system(size: 12, weight: suggested == grade ? .semibold : .regular))
                                Text(grade.nextLabel)
                                    .font(.system(size: 9.5))
                                    .foregroundColor(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
            Text(footerHint)
                .font(.system(size: 10.5))
                .foregroundColor(.secondary)
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private var footerHint: String {
        let mode = vm.current?.mode
        let main = mode == .cloze ? "↩ 提交判分" : "Space 翻面"
        return "\(main) · 1–4 评分 · ← → 切卡 · Esc 收起，随时回到桌面"
    }

    private func binding(for card: QuickReviewViewModel.Card) -> Binding<String> {
        Binding(
            get: { vm.cards.indices.contains(vm.pos) ? vm.cards[vm.pos].answer : "" },
            set: { value in
                if vm.cards.indices.contains(vm.pos) {
                    vm.cards[vm.pos].answer = value
                }
            }
        )
    }

    private func verdictColor(_ verdict: RecallVerdict) -> Color {
        switch verdict {
        case .perfect: return .green
        case .close: return .orange
        case .trap: return .red
        case .wrong: return .red
        }
    }
}
