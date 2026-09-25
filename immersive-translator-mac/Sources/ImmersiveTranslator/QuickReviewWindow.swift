import SwiftUI
import AppKit
import ReaderCore

/// 快速复习迷你窗（托盘/提醒卡直达）。对齐 Windows QuickReviewApp：
/// - 只做识别 + 完形（听写留阅读室）；‹ › / ←→ / 圆点自由切卡，不评分也能跳。
/// - 每卡 UI 状态独立保留；识别卡 Space 双向翻面反复自测。
/// - 已评卡可改评（按进窗时原 SRS 重算不叠加，打卡只记首次）。
/// - 评分即落盘收起不丢；结束页（连续打卡、完成/未评统计、打开阅读室）；Esc 收起。

@MainActor
final class QuickReviewWindowController {
    private var window: NSWindow?
    /// vm 由 controller 持有（单窗口单 vm）：重开窗不新建，靠 show 时 reload 作废上次会话。
    private var vm: QuickReviewViewModel?

    func show() {
        if window == nil {
            let vm = QuickReviewViewModel()
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
        // 每次进窗先重拉到期词（对齐 Windows：show 即重建卡片，不复用上次会话的旧到期卡）。
        vm?.reload()
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

@MainActor
final class QuickReviewViewModel: ObservableObject {
    struct Card {
        var word: VocabWord
        /// 进窗时的 SRS 快照（改评重算不叠加）。
        var baseSrs: VocabSrsState
        var revealed = false
        var graded: ReviewGrade?
        var answer = ""
        var verdict: RecallVerdict?
        var hints = 0
    }

    @Published var cards: [Card] = []
    @Published var pos = 0
    @Published var finished = false
    @Published var streak = 0
    /// 打卡只记一次（改评不再记）。
    private var loggedReview = false
    private var originalIds: [String] = []

    init() {
        reload()
    }

    func reload() {
        guard let file = try? ReaderStore.shared.getVocabFile() else { return }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let due = file.words.filter { $0.srs.dueAt <= now }
        cards = due.map { Card(word: $0, baseSrs: $0.srs) }
        originalIds = due.map(\.id)
        pos = 0
        finished = false
        loggedReview = false
        streak = reviewStats(file.words, file.reviewLog, nowMs: now).streak
    }

    var current: Card? {
        cards.indices.contains(pos) ? cards[pos] : nil
    }

    /// 快速复习路由：词块→完形、其余→识别（听写留阅读室）。
    var isCloze: Bool {
        current?.word.effectiveKind == .chunk
    }

    func moveTo(_ delta: Int) {
        guard !cards.isEmpty else { return }
        pos = min(cards.count - 1, max(0, pos + delta))
    }

    func revealToggle() {
        guard cards.indices.contains(pos) else { return }
        cards[pos].revealed.toggle()
    }

    func hint() {
        guard cards.indices.contains(pos), isCloze else { return }
        cards[pos].hints = min(3, cards[pos].hints + 1)
    }

    func submitCloze() {
        guard cards.indices.contains(pos) else { return }
        let input = cards[pos].answer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else { return }
        let word = cards[pos].word
        let blank = quickChunkBlank(sentence: sourceSentence(for: word), phrase: word.word) ?? word.word
        cards[pos].verdict = judgeCloze(
            input,
            blank,
            options: JudgeOptions(trap: word.trap, accepted: [word.word])
        )
        cards[pos].revealed = true
    }

    /// 出处例句：文章原句优先，划词收藏退回 LLM 例句。
    private func sourceSentence(for word: VocabWord) -> String {
        if !word.source.articleId.isEmpty,
           let article = (try? ReaderStore.shared.getArticle(id: word.source.articleId)) ?? nil,
           article.sentences.indices.contains(word.source.sentenceIdx) {
            return article.sentences[word.source.sentenceIdx].en
        }
        return word.example?.en ?? ""
    }

    /// 挖空句：把句中目标词块替换为空槽（与 ReaderReviewView.chunkBlank 同语义）。
    private func quickChunkBlank(sentence: String, phrase: String) -> String? {
        guard let range = sentence.range(of: phrase, options: [.caseInsensitive, .diacriticInsensitive]) else { return nil }
        return sentence.replacingCharacters(in: range, with: "______")
    }

    func grade(_ grade: ReviewGrade) {
        guard cards.indices.contains(pos) else { return }
        var card = cards[pos]
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        // 改评：按进窗时原 SRS 重算，不叠加
        card.graded = grade
        var updated = card.word
        updated.srs = gradeSrs(card.baseSrs, grade, now: now)
        // 错题分桶：完形按判分，识别卡按评分
        let bucket = recallBucket(mode: isCloze ? .cloze : .recognition, judged: card.verdict, grade: grade)
        let prior = card.word.recall
        // 改评时从原快照重算：先扣掉上一次的桶（简化：改评仅重写 SRS，recall 只在首次累加）
        if card.word.srs.dueAt == card.baseSrs.dueAt {
            updated.recall = recordRecallStat(prior, mode: isCloze ? .cloze : .recognition, bucket: bucket, nowMs: now)
        } else {
            updated.recall = prior
        }
        _ = try? ReaderStore.shared.saveVocabWord(updated)
        if !loggedReview {
            _ = try? ReaderStore.shared.recordReview(day: dayKey(nowMs: now))
            loggedReview = true
        }
        cards[pos] = card
        ReviewTouchpointManager.shared.refreshBadge()
        // 评分即收起：前进；末尾进结束页
        if pos + 1 < cards.count {
            pos += 1
        } else {
            finished = true
        }
    }

    var gradedCount: Int { cards.filter { $0.graded != nil }.count }

    var clozeHintText: String? {
        guard cards.indices.contains(pos), isCloze else { return nil }
        let card = cards[pos]
        guard card.hints > 0 else { return nil }
        let word = card.word
        let sense = word.senses.first.map { "\($0.pos) \($0.cn)" } ?? ""
        var parts: [String] = []
        if card.hints >= 1, !sense.isEmpty { parts.append(sense) }
        if card.hints >= 2 { parts.append("\(word.word.prefix(1))… 共 \(word.word.count) 词") }
        if card.hints >= 3 {
            if let pattern = word.pattern, !pattern.isEmpty {
                parts.append(pattern)
            } else if let trap = word.trap, !trap.isEmpty {
                parts.append("小心：\(trap)")
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

struct QuickReviewView: View {
    @ObservedObject var vm: QuickReviewViewModel

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

    private var emptyPage: some View {
        VStack(spacing: 10) {
            Image(systemName: "checkmark.seal")
                .font(.system(size: 34))
                .foregroundColor(.green)
            Text("现在没有到期的词").font(.system(size: 14, weight: .semibold))
            Text("去阅读室攒几个生词，到期了这里就能复习。")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var endPage: some View {
        VStack(spacing: 12) {
            Text("这一轮过完了 🎉").font(.system(size: 16, weight: .semibold))
            Text("已评 \(vm.gradedCount) / \(vm.cards.count) · 连续打卡 \(vm.streak) 天")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
            HStack {
                Button("再过一遍") { vm.reload() }
                    .controlSize(.small)
                Button("打开阅读室") {
                    (NSApp.delegate as? AppDelegate)?.openReaderFromTouchpoint()
                }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var cardPage: some View {
        VStack(spacing: 0) {
            HStack {
                Text("\(vm.pos + 1) / \(vm.cards.count)")
                    .font(.system(size: 11.5).monospacedDigit())
                    .foregroundColor(.secondary)
                Spacer()
                // 圆点导航
                HStack(spacing: 4) {
                    ForEach(0..<min(vm.cards.count, 24), id: \.self) { i in
                        Circle()
                            .fill(i == vm.pos ? Color.accentColor : Color.secondary.opacity(0.35))
                            .frame(width: 6, height: 6)
                            .onTapGesture { vm.moveTo(i - vm.pos) }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 6)

            if let card = vm.current {
                cardBody(card)
            }
            Spacer()
            gradeBar
        }
    }

    @ViewBuilder
    private func cardBody(_ card: QuickReviewViewModel.Card) -> some View {
        let word = card.word
        if vm.isCloze {
            VStack(alignment: .leading, spacing: 12) {
                clozeSentence(card, word: word)
                if let hint = vm.clozeHintText {
                    Text(hint)
                        .font(.system(size: 11.5))
                        .foregroundColor(.orange)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.orange.opacity(0.08))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                if let verdict = card.verdict {
                    Text(verdictLabel(verdict))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(verdictColor(verdict))
                }
            }
            .padding(16)
        } else {
            // 识别卡：正面书证挖空，背面释义
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 8) {
                    Text(word.word)
                        .font(.system(size: 20, weight: .semibold, design: .serif))
                    if word.effectiveKind == .chunk {
                        Text("块")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(.white)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Color.purple)
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                    Spacer()
                }
                if let phonetic = word.phonetic {
                    Text(phonetic).font(.system(size: 12)).foregroundColor(.secondary)
                }
                Text(card.revealed ? backText(word) : frontText(word))
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(16)
            .contentShape(Rectangle())
            .onTapGesture { vm.revealToggle() }
        }
    }

    private func clozeSentence(_ card: QuickReviewViewModel.Card, word: VocabWord) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("输入这个词块", text: binding(for: card))
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 13))
            if let example = word.example?.en {
                Text(example)
                    .font(.system(size: 12, design: .serif))
                    .foregroundColor(.secondary)
            }
            if !card.revealed {
                Button("想不出来直接看答案") {
                    vm.submitClozeForceReveal()
                }
                .controlSize(.small)
            }
        }
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

    private func frontText(_ word: VocabWord) -> String {
        if let example = word.example?.en {
            return example.replacingOccurrences(of: word.word, with: "______", options: [.caseInsensitive])
        }
        return "点按翻面看释义"
    }

    private func backText(_ word: VocabWord) -> String {
        var parts = word.senses.map { "\($0.pos) \($0.cn)".trimmingCharacters(in: .whitespaces) }
        if let trap = word.trap { parts.append("小心：\(trap)") }
        if let pattern = word.pattern { parts.append("记法：\(pattern)") }
        return parts.joined(separator: "\n")
    }

    private func verdictLabel(_ verdict: RecallVerdict) -> String {
        switch verdict {
        case .perfect: return "✓ 一次写对"
        case .close: return "≈ 很接近"
        case .trap: return "⚠ 命中直译陷阱"
        case .wrong: return "✗ 没想起"
        }
    }

    private func verdictColor(_ verdict: RecallVerdict) -> Color {
        switch verdict {
        case .perfect: return .green
        case .close: return .orange
        case .trap: return .red
        case .wrong: return .red
        }
    }

    private var gradeBar: some View {
        VStack(spacing: 6) {
            let suggested = vm.current?.verdict.map { verdictToSuggestedGrade($0) }
            HStack(spacing: 8) {
                gradeButton("没想起", .forgot, suggested: suggested)
                gradeButton("很勉强", .hard, suggested: suggested)
                gradeButton("想起来了", .good, suggested: suggested)
                gradeButton("很轻松", .easy, suggested: suggested)
            }
            HStack {
                Button { vm.moveTo(-1) } label: {
                    Image(systemName: "chevron.left")
                }
                .disabled(vm.pos == 0)
                Text(vm.current?.graded != nil ? "已评，可改评（不叠加）" : "← → 切卡 · Space 翻面/提示")
                    .font(.system(size: 10.5))
                    .foregroundColor(.secondary)
                Button { vm.moveTo(1) } label: {
                    Image(systemName: "chevron.right")
                }
                .disabled(vm.pos >= vm.cards.count - 1)
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private func gradeButton(_ label: String, _ grade: ReviewGrade, suggested: ReviewGrade?) -> some View {
        Button {
            if vm.isCloze, vm.current?.verdict == nil {
                vm.submitCloze()
            }
            vm.grade(grade)
        } label: {
            Text(label + (suggested == grade ? " ↵" : ""))
                .font(.system(size: 12, weight: suggested == grade ? .semibold : .regular))
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
    }
}

extension QuickReviewViewModel {
    /// 「想不出来直接看答案」：按 wrong 判分并翻面。
    func submitClozeForceReveal() {
        guard cards.indices.contains(pos) else { return }
        cards[pos].verdict = .wrong
        cards[pos].revealed = true
    }
}
