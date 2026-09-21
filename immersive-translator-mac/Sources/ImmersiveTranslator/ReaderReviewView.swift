import AppKit
import SwiftUI
import ReaderCore

/// 生词本左栏词表（复习态）：到期队列带序号（可点跳卡），其余按到期时间只读排列。
struct VocabListPanelView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    /// 复习队列：笔记加练批次优先，否则普通到期队列。
    private var due: [VocabWord] { vm.reviewQueue }
    private var later: [VocabWord] {
        let dueIds = Set(due.map(\.id))
        return vm.vocabWords
            .filter { !dueIds.contains($0.id) }
            .sorted { $0.srs.dueAt < $1.srs.dueAt }
    }

    var body: some View {
        let stats = vm.stats
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("生词本")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(palette.text)
                Spacer()
                Text("\(vm.vocabWords.count)")
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    if vm.vocabWords.isEmpty {
                        Text("还没有生词。\n在阅读里查词或点词块，选「加入生词本」，就会出现在这里。")
                            .font(.system(size: 12))
                            .foregroundColor(palette.textTertiary)
                            .lineSpacing(4)
                            .padding(.horizontal, 12)
                            .padding(.top, 8)
                    }
                    if !due.isEmpty {
                        groupLabel("待复习 · \(due.count)")
                    }
                    ForEach(Array(due.enumerated()), id: \.element.id) { index, word in
                        dueRow(index: index, word: word)
                    }
                    if !later.isEmpty {
                        groupLabel("稍后再来 · \(later.count)")
                    }
                    ForEach(later, id: \.id) { word in
                        HStack {
                            Text(word.word)
                                .font(.system(size: 12.5))
                                .foregroundColor(palette.textSecondary)
                                .lineLimit(1)
                            Spacer()
                            Text(nextDueLabel(word.srs.dueAt))
                                .font(.system(size: 10.5))
                                .foregroundColor(palette.textTertiary)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                        .help("还没到期")
                    }
                }
                .padding(.horizontal, 8)
            }

            Divider().opacity(0.5)
            VStack(alignment: .leading, spacing: 6) {
                Button {
                    vm.openReading()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: ReaderIcons.book).font(.system(size: 12))
                        Text("沉浸式阅读").font(.system(size: 12.5))
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundColor(palette.text)

                let todayTotal = stats.reviewedToday + due.count
                Text(todayTotal > 0
                    ? "今日复习 \(stats.reviewedToday) / \(todayTotal) · 连续打卡 \(stats.streak) 天"
                    : "今日没有到期生词了。")
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .background(palette.surfaceAlt)
    }

    private func groupLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10.5, weight: .semibold))
            .foregroundColor(palette.textTertiary)
            .padding(.leading, 4)
            .padding(.top, 8)
    }

    private func dueRow(index: Int, word: VocabWord) -> some View {
        let active = index == vm.reviewPos
        return Button {
            vm.reviewPos = index
        } label: {
            HStack(spacing: 6) {
                Text("\(index + 1)")
                    .font(.system(size: 10, weight: .semibold).monospacedDigit())
                    .foregroundColor(active ? .white : palette.textTertiary)
                    .frame(width: 16, height: 16)
                    .background(active ? palette.accent : Color.clear)
                    .clipShape(Circle())
                Text(word.word)
                    .font(.system(size: 12.5))
                    .foregroundColor(active ? palette.accent : palette.text)
                    .lineLimit(1)
                if word.effectiveKind == .chunk {
                    Text("块")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(palette.knownColor)
                }
                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(active ? palette.accent.opacity(0.12) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(active ? "当前卡片" : "跳到第 \(index + 1) 张")
    }
}

/// 下次见面时间：10分钟后 / 5小时后 / 3天后 / 超过一个月给日期。
private func nextDueLabel(_ dueAt: Int64) -> String {
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    let minutes = Int((dueAt - now) / 60000)
    if minutes < 60 { return "\(max(1, minutes))分钟后" }
    if minutes < 24 * 60 { return "\(Int((Double(minutes) / 60).rounded()))小时后" }
    let days = Int((Double(minutes) / (24 * 60)).rounded())
    if days < 30 { return "\(days)天后" }
    let formatter = DateFormatter()
    formatter.dateFormat = "M/d"
    return formatter.string(from: Date(timeIntervalSince1970: Double(dueAt) / 1000))
}

// MARK: - 复习主视图

/// 屏 D · 生词本复习流：产出式复习（识别翻卡 / 完形填空 / 听写）。
/// reviewMode = smart 时按卡路由：词块→完形 · 熟词（间隔≥1天）→听写 · 新词→识别。
/// 判分在 ReaderCore.RecallJudge（纯本地）；判定只映射为「建议档」描边，
/// 四档评分以白话呈现（没想起/很勉强/想起来了/很轻松）。
struct ReviewView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    /// 听写卡除首次自动朗读外的重播次数。
    fileprivate static let dictationReplays = 3

    // ---- 卡片内状态（每张卡重置） ----
    @State private var flipped = false
    @State private var input = ""
    @State private var hints = 0
    @State private var cnShown = false
    @State private var verdict: RecallVerdict?
    @State private var replays = ReviewView.dictationReplays
    @State private var gradedThisRound = Set<String>()
    @State private var results: [RecallResult] = []
    @FocusState private var inputFocused: Bool

    struct RecallResult {
        let wordId: String
        let mode: RecallMode
        let judged: RecallVerdict?
        let grade: ReviewGrade
    }

    /// 复习队列：笔记加练批次优先，否则普通到期队列。
    private var due: [VocabWord] { vm.reviewQueue }
    private var current: VocabWord? {
        guard !due.isEmpty else { return nil }
        let pos = min(max(0, vm.reviewPos), due.count - 1)
        return due[pos]
    }

    /// 当前卡的形态与句子素材（smart 路由 + 降级）。
    private var effective: (mode: RecallMode, source: (en: String, zh: String?)?) {
        guard let word = current else { return (.recognition, nil) }
        let routed = routeRecallMode(word, vm.effectiveSettings.reviewMode)
        let fromArticle = vm.sourceSentence(articleId: word.source.articleId, sentenceIdx: word.source.sentenceIdx)
        let exampleSource = word.example.map { (en: $0.en, zh: $0.zh) }
        let source = fromArticle ?? exampleSource
        guard routed != .recognition, let source, !source.en.isEmpty else {
            return (.recognition, nil)
        }
        // 完形还要求词块文本在句中可定位；定位不到降级为识别卡。
        if routed == .cloze, findChunkRange(source.en, word.word) == nil {
            return (.recognition, nil)
        }
        return (routed, source)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            statsColumn
                .frame(width: 210)
                .padding(.top, 16)
                .padding(.leading, 8)
            Divider().opacity(0.4)
            cardColumn
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear { installKeys() }
        .onDisappear { vm.reviewKeyHandler = nil }
        .onChange(of: vm.vocabWords.count) { _ in
            vm.reviewPos = 0
            gradedThisRound = Set()
        }
        .onChange(of: current?.id) { _ in
            resetCardState()
            // 听写卡进入即自动朗读一次（word 音轨，不打断句子朗读）
            if effective.mode == .dictation, let word = current, let source = effective.source,
               !gradedThisRound.contains("\(word.id)#spoke") {
                gradedThisRound.insert("\(word.id)#spoke")
                vm.speakRecallSentence(source.en)
            }
        }
        .onChange(of: vm.effectiveSettings.reviewMode) { _ in
            resetCardState()
        }
    }

    private func resetCardState() {
        flipped = false
        input = ""
        hints = 0
        cnShown = false
        verdict = nil
        replays = ReviewView.dictationReplays
    }

    private func installKeys() {
        vm.reviewKeyHandler = { event in
            handleKey(event)
        }
    }

    private func handleKey(_ event: NSEvent) -> Bool {
        guard current != nil else { return false }
        // 输入框聚焦时交给输入框（SwiftUI 已处理），这里只处理全局键。
        if let responder = NSApp.keyWindow?.firstResponder, responder is NSTextView || responder is NSTextField {
            return false
        }
        let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
        let gradeable = effective.mode == .recognition ? flipped : verdict != nil
        if ["1", "2", "3", "4"].contains(key), gradeable, let word = current {
            let grade: ReviewGrade = key == "1" ? .forgot : key == "2" ? .hard : key == "3" ? .good : .easy
            submitGrade(grade, for: word)
            return true
        }
        if key == " " || key == "return" {
            if effective.mode == .recognition {
                if !flipped {
                    flipped = true
                    return true
                }
                if key == " ", let word = current {
                    vm.speakWord(word.word)
                    return true
                }
                return false
            }
            if let v = verdict, key == "return", let word = current {
                submitGrade(verdictToSuggestedGrade(v), for: word)
                return true
            }
            if effective.mode == .dictation, verdict == nil, key == " ", replays > 0, let source = effective.source {
                replays -= 1
                vm.speakRecallSentence(source.en)
                return true
            }
            return false
        }
        if key == "h", effective.mode == .cloze, verdict == nil {
            hints = min(3, hints + 1)
            return true
        }
        return false
    }

    private func submitGrade(_ grade: ReviewGrade, for word: VocabWord) {
        guard !gradedThisRound.contains(word.id) else { return }
        gradedThisRound.insert(word.id)
        results.append(RecallResult(wordId: word.id, mode: effective.mode, judged: verdict, grade: grade))
        vm.gradeVocab(word, grade, mode: effective.mode, verdict: verdict)
    }

    // MARK: - 左列（统计）

    private var statsColumn: some View {
        let stats = vm.stats
        let distTotal = max(1, stats.distribution.learning + stats.distribution.familiar + stats.distribution.mastered)
        return VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(stats.reviewedToday)/\(stats.reviewedToday + due.count)")
                    .font(.system(size: 22, weight: .bold).monospacedDigit())
                    .foregroundColor(palette.text)
                Text("今日复习（到期 \(due.count) 词待复习）")
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("\(stats.streak)")
                    .font(.system(size: 22, weight: .bold).monospacedDigit())
                    .foregroundColor(palette.text)
                Text("连续打卡天数")
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("掌握度分布 · 共 \(stats.total) 词")
                    .font(.system(size: 10.5, weight: .bold))
                    .foregroundColor(palette.textTertiary)
                distRow(name: "学习中", value: stats.distribution.learning, total: distTotal, color: palette.warn)
                distRow(name: "渐熟", value: stats.distribution.familiar, total: distTotal, color: palette.accent)
                distRow(name: "掌握", value: stats.distribution.mastered, total: distTotal, color: palette.ok)
                Text("单词 \(stats.totalWords)（到期 \(stats.dueWords)）· 词块 \(stats.totalChunks)（到期 \(stats.dueChunks)）")
                    .font(.system(size: 10.5))
                    .foregroundColor(palette.textTertiary)
                    .lineSpacing(2)
            }

            if vm.focusReviewIds != nil {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 5) {
                        Image(systemName: "bolt.fill")
                            .font(.system(size: 10))
                            .foregroundColor(palette.warn)
                        Text("加练中 · 只测笔记仍错的词")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(palette.warn)
                    }
                    Button("退出加练，回到到期队列") {
                        vm.focusReviewIds = nil
                        vm.reviewPos = 0
                    }
                    .font(.system(size: 10.5))
                    .controlSize(.small)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.warn.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            VStack(alignment: .leading, spacing: 6) {
                Button {
                    vm.openNoteDialog()
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "square.and.pencil")
                            .font(.system(size: 11))
                        Text("生成复习笔记")
                            .font(.system(size: 11.5))
                        Spacer()
                        let unnoted = vm.unnotedWordCount
                        if unnoted > 0 {
                            Text("\(unnoted) 未整理")
                                .font(.system(size: 9.5, weight: .semibold))
                                .foregroundColor(.white)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 0.5)
                                .background(Color.orange)
                                .clipShape(Capsule())
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundColor(palette.accent)

                Button {
                    vm.openNotes()
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "books.vertical")
                            .font(.system(size: 11))
                        Text("笔记库")
                            .font(.system(size: 11.5))
                        Spacer()
                        if !vm.notes.isEmpty {
                            Text("\(vm.notes.count)")
                                .font(.system(size: 9.5, weight: .semibold))
                                .foregroundColor(palette.textTertiary)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundColor(palette.text)
            }
        }
        .padding(.horizontal, 12)
    }

    private func distRow(name: String, value: Int, total: Int, color: Color) -> some View {
        HStack(spacing: 6) {
            Text(name)
                .font(.system(size: 11))
                .foregroundColor(palette.textSecondary)
                .frame(width: 40, alignment: .leading)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(palette.border.opacity(0.3))
                    Capsule().fill(color).frame(width: geo.size.width * CGFloat(value) / CGFloat(total))
                }
            }
            .frame(height: 5)
            Text("\(value)")
                .font(.system(size: 11).monospacedDigit())
                .foregroundColor(palette.textSecondary)
                .frame(width: 22, alignment: .trailing)
        }
    }

    // MARK: - 卡片列

    private var cardColumn: some View {
        ScrollView {
            VStack(spacing: 12) {
                modeSwitch
                if let word = current {
                    let pos = min(max(0, vm.reviewPos), due.count - 1)
                    switch effective.mode {
                    case .recognition:
                        RecognitionCardView(
                            word: word,
                            flipped: flipped,
                            pos: pos,
                            total: due.count,
                            sourceLabel: metaSource(word),
                            sentence: vm.sourcePreview(articleId: word.source.articleId, sentenceIdx: word.source.sentenceIdx) ?? word.example?.en,
                            palette: palette,
                            fontPair: vm.effectiveSettings.fontPair,
                            onFlip: { flipped = true },
                            onUnflip: { flipped = false },
                            onSpeak: { vm.speakWord(word.word) },
                            onJump: { vm.jumpToSource(articleId: word.source.articleId, sentenceIdx: word.source.sentenceIdx) },
                            onGrade: { submitGrade($0, for: word) }
                        )
                    case .cloze:
                        ClozeCardView(
                            word: word,
                            source: effective.source,
                            input: $input,
                            hints: hints,
                            cnShown: cnShown,
                            verdict: verdict,
                            pos: min(max(0, vm.reviewPos), due.count - 1),
                            total: due.count,
                            sourceLabel: metaSource(word),
                            palette: palette,
                            fontPair: vm.effectiveSettings.fontPair,
                            focused: $inputFocused,
                            onInputFocus: { inputFocused = true },
                            onHint: { hints = min(3, hints + 1) },
                            onRevealCn: { cnShown = true },
                            onSubmit: { submitCloze(word: word) },
                            onGiveUp: { verdict = .wrong },
                            onJump: { vm.jumpToSource(articleId: word.source.articleId, sentenceIdx: word.source.sentenceIdx) },
                            onGrade: { submitGrade($0, for: word) }
                        )
                    case .dictation:
                        DictationCardView(
                            word: word,
                            source: effective.source,
                            input: $input,
                            verdict: verdict,
                            replays: replays,
                            pos: min(max(0, vm.reviewPos), due.count - 1),
                            total: due.count,
                            sourceLabel: metaSource(word),
                            palette: palette,
                            fontPair: vm.effectiveSettings.fontPair,
                            focused: $inputFocused,
                            onReplay: { replayDictation(word: word) },
                            onSubmit: { submitDictation(word: word) },
                            onGiveUp: { verdict = .wrong },
                            onJump: { vm.jumpToSource(articleId: word.source.articleId, sentenceIdx: word.source.sentenceIdx) },
                            onGrade: { submitGrade($0, for: word) }
                        )
                    }
                } else if due.isEmpty, !results.isEmpty {
                    SummaryPanelView(results: results, palette: palette) {
                        results = []
                        gradedThisRound = gradedThisRound.filter { !$0.contains("#spoke") }
                    }
                } else {
                    donePanel
                }
            }
            .padding(20)
            .frame(maxWidth: 720, alignment: .leading)
        }
    }

    private func metaSource(_ word: VocabWord) -> String {
        if let title = vm.articleTitle(articleId: word.source.articleId) {
            return "来自「\(title)」· 第 \(word.source.sentenceIdx + 1) 句"
        }
        return "来自划词收藏"
    }

    private var donePanel: some View {
        VStack(spacing: 8) {
            Text(vm.stats.total == 0 ? "生词本还是空的" : "今日复习完成 🎉")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(palette.text)
            Text(vm.stats.total == 0
                ? "在阅读室里查词并点击「加入生词本」，复习卡会出现在这里。"
                : "没有到期的生词了。明天再来看看，或去阅读室继续攒新词。")
                .font(.system(size: 12.5))
                .foregroundColor(palette.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }

    // MARK: - 卡片动作

    private func submitCloze(word: VocabWord) {
        guard verdict == nil, let source = effective.source, !input.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        let blank = chunkBlank(source.en, word.word) ?? ""
        verdict = judgeCloze(
            input,
            blank,
            options: JudgeOptions(trap: word.trap, accepted: [word.word])
        )
    }

    private func submitDictation(word: VocabWord) {
        guard verdict == nil, let source = effective.source, !input.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        verdict = judgeDictation(input, source.en, options: JudgeOptions(trap: word.trap))
    }

    private func replayDictation(word: VocabWord) {
        guard let source = effective.source else { return }
        if verdict == nil {
            guard replays > 0 else { return }
            replays -= 1
        }
        vm.speakRecallSentence(source.en)
    }

    // MARK: - 模式切换

    private var modeSwitch: some View {
        let mode = vm.effectiveSettings.reviewMode
        return HStack(spacing: 10) {
            Picker("复习模式", selection: Binding(
                get: { mode },
                set: { value in vm.patchSettings { $0.reviewMode = value } }
            )) {
                ForEach(ReviewModeSetting.allCases, id: \.self) { option in
                    Text(option.label).tag(option)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 320)
            Text(mode.description)
                .font(.system(size: 11))
                .foregroundColor(palette.textTertiary)
            Spacer()
        }
    }
}

/// 在原句里定位要挖空的目标（完形卡）；定位不到返回 nil。
private func chunkBlank(_ sentence: String, _ phrase: String) -> String? {
    guard let range = findChunkRange(sentence, phrase) else { return nil }
    return substring(sentence, range)
}

private func substring(_ s: String, _ range: ReaderCore.TextRange) -> String {
    let units = Array(s.utf16)
    let start = min(range.start, units.count)
    let end = min(range.end, units.count)
    guard start < end else { return "" }
    return String(decoding: units[start..<end], as: UTF16.self)
}

// MARK: - 词条版式小件

private struct CardMeta: View {
    let pill: String
    let tone: Color?
    let source: String
    let pos: Int
    let total: Int
    let palette: ReaderPalette

    var body: some View {
        HStack(spacing: 8) {
            Text(pill)
                .font(.system(size: 10.5, weight: .bold))
                .foregroundColor(tone == nil ? .white : (tone ?? .white))
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(tone == nil ? palette.accent : (tone?.opacity(0.15) ?? palette.accent))
                .clipShape(Capsule())
            Text(source)
                .font(.system(size: 11))
                .foregroundColor(palette.textTertiary)
            Spacer()
            Text("\(pos + 1) / \(total)")
                .font(.system(size: 11).monospacedDigit())
                .foregroundColor(palette.textTertiary)
        }
    }
}

private struct WordHead: View {
    let word: VocabWord
    let flipped: Bool
    let palette: ReaderPalette
    let fontPair: ReaderFontPair
    let onSpeak: () -> Void
    let onCollapse: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(word.word)
                    .font(readerFont(26, .semibold, pair: fontPair))
                    .foregroundColor(palette.text)
                if word.effectiveKind == .chunk, let chunkType = word.chunkType {
                    Text(chunkType.label)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(palette.knownColor)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(palette.knownColor.opacity(0.12))
                        .clipShape(Capsule())
                }
            }
            HStack(spacing: 10) {
                if let phonetic = word.phonetic {
                    Text("/\(phonetic.trimmingCharacters(in: CharacterSet(charactersIn: "/")))/")
                        .font(.system(size: 12.5))
                        .foregroundColor(palette.textTertiary)
                }
                Button(action: onSpeak) {
                    Image(systemName: ReaderIcons.speaker).font(.system(size: 13))
                }
                .buttonStyle(.plain)
                .foregroundColor(palette.accent)
                .help("发音（空格）")
                if let onCollapse {
                    Button("遮住释义", action: onCollapse)
                        .buttonStyle(.link)
                        .font(.system(size: 11.5))
                }
            }
        }
    }
}

private struct MeaningBlock: View {
    let senses: [VocabSense]
    let palette: ReaderPalette
    let fontPair: ReaderFontPair

    var body: some View {
        if !senses.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(senses.enumerated()), id: \.offset) { _, sense in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if !sense.pos.isEmpty {
                            Text(sense.pos)
                                .font(.system(size: 11.5, weight: .medium))
                                .foregroundColor(palette.accent)
                        }
                        Text(sense.cn)
                            .font(readerFont(15, .medium, pair: fontPair))
                            .foregroundColor(palette.text)
                    }
                }
            }
        }
    }
}

private struct UsageBlock: View {
    let word: VocabWord
    let palette: ReaderPalette

    var body: some View {
        if word.effectiveKind == .chunk, word.pattern != nil || word.trap != nil {
            VStack(alignment: .leading, spacing: 4) {
                if let pattern = word.pattern {
                    usageRow(label: "记法", value: pattern, valueFont: .system(size: 13, design: .serif), color: palette.textSecondary)
                }
                if let trap = word.trap {
                    usageRow(label: "直译陷阱", value: trap, valueFont: .system(size: 12.5), color: palette.err)
                }
            }
        }
    }

    private func usageRow(label: String, value: String, valueFont: Font, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(.system(size: 10.5))
                .foregroundColor(palette.textTertiary)
                .frame(width: 52, alignment: .leading)
            Text(value)
                .font(valueFont)
                .foregroundColor(color)
            Spacer(minLength: 0)
        }
    }
}

private struct CollocationBlock: View {
    let items: [VocabCollocation]?
    let palette: ReaderPalette

    var body: some View {
        if let items, !items.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text("常用搭配")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundColor(palette.textTertiary)
                ForEach(Array(items.enumerated()), id: \.offset) { _, coll in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(coll.en)
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundColor(palette.text)
                        Text(coll.cn)
                            .font(.system(size: 11.5))
                            .foregroundColor(palette.textTertiary)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }
}

/// 书证（原句）：识别卡正面把目标挖空（只给语境），背面高亮目标。整块可点回原文。
private struct ContextBlock: View {
    let sentence: String?
    let target: String
    let revealed: Bool
    let palette: ReaderPalette
    var onJump: (() -> Void)?
    var emptyText: String?

    var body: some View {
        Group {
            if let sentence {
                let range = findChunkRange(sentence, target)
                let pre = range.map { substring(sentence, ReaderCore.TextRange(start: 0, end: $0.start)) } ?? sentence
                let mid = range.map { substring(sentence, $0) } ?? ""
                let post = range.map { substring(sentence, ReaderCore.TextRange(start: $0.end, end: Array(sentence.utf16).count)) } ?? ""
                VStack(alignment: .leading, spacing: 4) {
                    (Text(pre)
                        + Text(mid.isEmpty ? "" : (revealed ? mid : String(repeating: "﹍", count: max(3, mid.count / 2))))
                            .foregroundColor(revealed ? palette.accent : palette.textTertiary)
                        + Text(post))
                        .font(.system(size: 12.5))
                        .foregroundColor(palette.textSecondary)
                        .lineSpacing(3)
                    if onJump != nil {
                        Label("回到原文", systemImage: ReaderIcons.locate)
                            .font(.system(size: 10.5))
                            .foregroundColor(palette.accent)
                    }
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.surfaceAlt)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
                .onTapGesture { onJump?() }
            } else if let emptyText {
                Text(emptyText)
                    .font(.system(size: 12))
                    .foregroundColor(palette.textTertiary)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.surfaceAlt)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}

// MARK: - 评分带

private struct GradeBar: View {
    let suggest: ReviewGrade?
    let ask: String
    let palette: ReaderPalette
    let onGrade: (ReviewGrade) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(ask)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(palette.text)
            HStack(spacing: 8) {
                ForEach(Array(ReviewGrade.allCases.enumerated()), id: \.element) { index, grade in
                    gradeButton(grade: grade, key: "\(index + 1)", suggested: suggest == grade)
                }
            }
            if suggest != nil {
                Text("↩ 采纳「\(suggest?.label ?? "")」档 · 1–4 改选")
                    .font(.system(size: 10.5))
                    .foregroundColor(palette.textTertiary)
            }
        }
    }

    private func gradeButton(grade: ReviewGrade, key: String, suggested: Bool) -> some View {
        Button {
            onGrade(grade)
        } label: {
            VStack(spacing: 2) {
                Text(grade.label)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundColor(palette.text)
                Text(grade.nextLabel)
                    .font(.system(size: 10))
                    .foregroundColor(palette.textTertiary)
                Text(key)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(palette.textTertiary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity)
            .background(suggested ? palette.accent.opacity(0.12) : palette.surfaceAlt)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(suggested ? palette.accent : palette.border, lineWidth: suggested ? 1.6 : 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private func gradeAsk(_ mode: RecallMode) -> String {
    switch mode {
    case .recognition: return "翻面前，你想出意思了吗？"
    case .cloze: return "这个空，你答上来了吗？"
    case .dictation: return "这一句，你写出来了吗？"
    }
}

private struct VerdictPanel<Content: View>: View {
    let verdict: RecallVerdict
    let palette: ReaderPalette
    var onJump: (() -> Void)?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verdict.headline)
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundColor(verdictColor)
            content
            if let onJump {
                Button("回到原文", action: onJump)
                    .buttonStyle(.link)
                    .font(.system(size: 11.5))
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(verdictColor.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var verdictColor: Color {
        switch verdict {
        case .perfect: return palette.ok
        case .close: return palette.warn
        case .trap: return palette.err
        case .wrong: return palette.err
        }
    }
}

// MARK: - 识别卡

private struct RecognitionCardView: View {
    let word: VocabWord
    let flipped: Bool
    let pos: Int
    let total: Int
    let sourceLabel: String
    let sentence: String?
    let palette: ReaderPalette
    let fontPair: ReaderFontPair
    let onFlip: () -> Void
    let onUnflip: () -> Void
    let onSpeak: () -> Void
    let onJump: () -> Void
    let onGrade: (ReviewGrade) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CardMeta(pill: "识别", tone: palette.textTertiary, source: sourceLabel, pos: pos, total: total, palette: palette)
            WordHead(
                word: word,
                flipped: flipped,
                palette: palette,
                fontPair: fontPair,
                onSpeak: onSpeak,
                onCollapse: flipped ? onUnflip : nil
            )
            Divider().opacity(0.5)
            if flipped {
                VStack(alignment: .leading, spacing: 12) {
                    MeaningBlock(senses: word.senses, palette: palette, fontPair: fontPair)
                    ContextBlock(
                        sentence: sentence,
                        target: word.word,
                        revealed: true,
                        palette: palette,
                        onJump: sentence != nil ? onJump : nil,
                        emptyText: word.example == nil ? "（原句已随文章删除）" : nil
                    )
                    UsageBlock(word: word, palette: palette)
                    CollocationBlock(items: word.collocations, palette: palette)
                }
                GradeBar(suggest: nil, ask: gradeAsk(.recognition), palette: palette, onGrade: onGrade)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text(sentence != nil ? "先想想它在句中的意思" : "想好意思了吗？")
                        .font(.system(size: 12.5))
                        .foregroundColor(palette.textSecondary)
                    ContextBlock(sentence: sentence, target: word.word, revealed: false, palette: palette)
                }
                Button(action: onFlip) {
                    Text("翻面 · 看释义")
                        .frame(maxWidth: .infinity)
                }
                .controlSize(.large)
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.space, modifiers: [])
            }
        }
        .padding(18)
        .background(palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(palette.border))
    }
}

// MARK: - 完形卡

private struct ClozeCardView: View {
    let word: VocabWord
    let source: (en: String, zh: String?)?
    @Binding var input: String
    let hints: Int
    let cnShown: Bool
    let verdict: RecallVerdict?
    let pos: Int
    let total: Int
    let sourceLabel: String
    let palette: ReaderPalette
    let fontPair: ReaderFontPair
    var focused: FocusState<Bool>.Binding
    let onInputFocus: () -> Void
    let onHint: () -> Void
    let onRevealCn: () -> Void
    let onSubmit: () -> Void
    let onGiveUp: () -> Void
    let onJump: () -> Void
    let onGrade: (ReviewGrade) -> Void

    private var blank: String? {
        source.flatMap { chunkBlank($0.en, word.word) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CardMeta(pill: "完形", tone: palette.accent, source: sourceLabel, pos: pos, total: total, palette: palette)

            if let source, let blank {
                clozeSentence(source: source, blank: blank)
                if let zh = source.zh {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("中文提示：").font(.system(size: 12)).foregroundColor(palette.textTertiary)
                        Text(cnShown ? zh : maskChinese(zh))
                            .font(.system(size: 12))
                            .foregroundColor(cnShown ? palette.textSecondary : palette.textTertiary.opacity(0.5))
                            .contentShape(Rectangle())
                            .onTapGesture { if !cnShown { onRevealCn() } }
                    }
                }
                if verdict == nil {
                    hintLadder(blank: blank)
                    submitRow
                } else if let verdict {
                    VerdictPanel(verdict: verdict, palette: palette, onJump: onJump) {
                        if verdict == .close {
                            Text("你写的：\(input.trimmingCharacters(in: .whitespaces))")
                                .font(.system(size: 12))
                                .foregroundColor(palette.textSecondary)
                        }
                        if verdict == .trap {
                            Text("你写了 \(input.trimmingCharacters(in: .whitespaces)) —— \(word.trap ?? "这是常见的直译错误")")
                                .font(.system(size: 12))
                                .foregroundColor(palette.textSecondary)
                        }
                        Text(blank + (blank != word.word ? "（词条原形：\(word.word)）" : ""))
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(palette.text)
                    }
                    GradeBar(suggest: verdictToSuggestedGrade(verdict), ask: gradeAsk(.cloze), palette: palette, onGrade: onGrade)
                }
            }
        }
        .padding(18)
        .background(palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(palette.border))
        .onAppear { onInputFocus() }
    }

    private func clozeSentence(source: (en: String, zh: String?), blank: String) -> some View {
        let range = findChunkRange(source.en, word.word)
        let pre = range.map { substring(source.en, ReaderCore.TextRange(start: 0, end: $0.start)) } ?? source.en
        let post = range.map { substring(source.en, ReaderCore.TextRange(start: $0.end, end: Array(source.en.utf16).count)) } ?? ""
        return VStack(alignment: .leading, spacing: 8) {
            clozeText(pre: pre, blank: blank, post: post)
                .font(readerFont(16, .regular, pair: fontPair))
                .foregroundColor(palette.text)
                .lineSpacing(4)
                .textSelection(.enabled)
        }
    }

    /// 单条 Text 拼接：挖空处为输入回显（下划线）或判分答案。
    private func clozeText(pre: String, blank: String, post: String) -> Text {
        let base = Text(pre + "　")
        if let verdict {
            let color: Color = verdict == .perfect ? palette.ok : (verdict == .close ? palette.warn : palette.err)
            return base + Text(blank).foregroundColor(color).underline() + Text("　" + post)
        }
        let typed = input.isEmpty ? "　　　　" : input
        return base + Text(typed).underline().foregroundColor(palette.accent) + Text("　" + post)
    }



    private func hintLadder(blank: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if hints >= 1, let gloss = word.senses.first?.cn {
                hintRow(tag: "提示 1", text: gloss)
            }
            if hints >= 2 {
                hintRow(tag: "提示 2", text: "\(firstLetters(blank))（\(blank.trimmingCharacters(in: .whitespaces).split(separator: " ").count) 词）")
            }
            if hints >= 3 {
                if let pattern = word.pattern {
                    hintRow(tag: "槽位记法", text: pattern)
                } else if let zh = source?.zh {
                    hintRow(tag: "中文句", text: zh)
                } else if let phonetic = word.phonetic {
                    hintRow(tag: "音标", text: "/\(phonetic)/")
                }
            }
            if hints < 3 {
                Button("再给一点提示（H）", action: onHint)
                    .buttonStyle(.link)
                    .font(.system(size: 11.5))
            }
        }
    }

    private func hintRow(tag: String, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(tag)
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(palette.accent)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(palette.accent.opacity(0.1))
                .clipShape(Capsule())
            Text(text)
                .font(.system(size: 12))
                .foregroundColor(palette.textSecondary)
        }
    }

    private var submitRow: some View {
        HStack(spacing: 10) {
            TextField("写出被挖空的部分", text: $input)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 13.5))
                .frame(maxWidth: 320)
                .focused(focused)
                .onSubmit { onSubmit() }
            Button("提交判分", action: onSubmit)
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
                .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty)
            Button("想不出来，直接看答案", action: onGiveUp)
                .controlSize(.small)
        }
    }

    private func maskChinese(_ zh: String) -> String {
        String(zh.map { ch in
            "，。；：、！？ ".contains(ch) ? ch : "＿"
        })
    }
}

// MARK: - 听写卡

private struct DictationCardView: View {
    let word: VocabWord
    let source: (en: String, zh: String?)?
    @Binding var input: String
    let verdict: RecallVerdict?
    let replays: Int
    let pos: Int
    let total: Int
    let sourceLabel: String
    let palette: ReaderPalette
    let fontPair: ReaderFontPair
    var focused: FocusState<Bool>.Binding
    let onReplay: () -> Void
    let onSubmit: () -> Void
    let onGiveUp: () -> Void
    let onJump: () -> Void
    let onGrade: (ReviewGrade) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CardMeta(pill: "听写", tone: palette.knownColor, source: sourceLabel, pos: pos, total: total, palette: palette)

            if let source {
                HStack(spacing: 10) {
                    Button(action: onReplay) {
                        Text(verdict != nil ? "再听一遍" : (replays < ReviewView.dictationReplays ? "重播句子" : "播放句子"))
                            .frame(minWidth: 72)
                    }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
                    .disabled(verdict == nil && replays <= 0)
                    Text("可重播 \(replays) 次（Space）")
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                    Spacer()
                    Text("听整句 · 写整句")
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                }

                if verdict == nil {
                    VStack(alignment: .leading, spacing: 10) {
                        TextEditor(text: $input)
                            .font(.system(size: 14))
                            .frame(minHeight: 84)
                            .scrollContentBackground(.hidden)
                            .padding(6)
                            .background(palette.surfaceAlt)
                            .cornerRadius(8)
                            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(palette.border))
                            .focused(focused)
                        HStack {
                            Button("提交判分", action: onSubmit)
                                .controlSize(.small)
                                .buttonStyle(.borderedProminent)
                                .keyboardShortcut(.return, modifiers: [])
                                .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty)
                            Button("听不出，看句子", action: onGiveUp)
                                .controlSize(.small)
                        }
                    }
                } else if let verdict {
                    VerdictPanel(verdict: verdict, palette: palette, onJump: onJump) {
                        let diff = wordDiff(input, source.en)
                        let answerWords = source.en.trimmingCharacters(in: .whitespaces).split(separator: " ").count
                        let hit = Int((Double(diff.filter { $0.status == .ok }.count) / Double(max(1, answerWords))) * 100)
                        Text("词级命中 \(hit)%")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(palette.textSecondary)
                        diffLine(diff)
                        Text("图例：绿=写对 · 黄=漏写 · 红=多写/写错")
                            .font(.system(size: 10))
                            .foregroundColor(palette.textTertiary)
                        Text(source.en)
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundColor(palette.text)
                    }
                    GradeBar(suggest: verdictToSuggestedGrade(verdict), ask: gradeAsk(.dictation), palette: palette, onGrade: onGrade)
                }
            }
        }
        .padding(18)
        .background(palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(palette.border))
        .onAppear {
            focused.wrappedValue = true
        }
    }

    private func diffLine(_ diff: [DiffToken]) -> some View {
        var text = Text("")
        var first = true
        for token in diff {
            if !first {
                text = text + Text(" ")
            }
            first = false
            let color: Color
            switch token.status {
            case .ok: color = palette.ok
            case .miss: color = palette.warn
            case .extra: color = palette.err
            }
            text = text + Text(token.text).foregroundColor(color)
        }
        return text
            .font(.system(size: 13.5))
            .lineSpacing(4)
            .textSelection(.enabled)
    }
}

// MARK: - 结果摘要

private struct SummaryPanelView: View {
    let results: [ReviewView.RecallResult]
    let palette: ReaderPalette
    let onRestart: () -> Void

    var body: some View {
        let produced = results.filter { $0.mode != .recognition }
        let recogCount = results.count - produced.count
        func count(_ verdict: RecallVerdict) -> Int {
            produced.filter { $0.judged == verdict }.count
        }
        return VStack(spacing: 12) {
            Text("本轮复习完成 🎉")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(palette.text)
            Text("\(produced.count) 张产出卡（完形/听写）" + (recogCount > 0 ? " · 另完成 \(recogCount) 张识别卡" : ""))
                .font(.system(size: 12.5))
                .foregroundColor(palette.textSecondary)
            HStack(spacing: 10) {
                summaryCell(value: count(.perfect), label: "一次写对", color: palette.ok)
                summaryCell(value: count(.close), label: "接近差一点", color: palette.warn)
                summaryCell(value: count(.trap), label: "直译陷阱", color: palette.err)
                summaryCell(value: count(.wrong), label: "未想起", color: palette.textTertiary)
            }
            Button("清空本轮统计", action: onRestart)
                .controlSize(.small)
        }
        .padding(20)
        .frame(maxWidth: .infinity)
        .background(palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(palette.border))
    }

    private func summaryCell(value: Int, label: String, color: Color) -> some View {
        VStack(spacing: 2) {
            Text("\(value)")
                .font(.system(size: 20, weight: .bold).monospacedDigit())
                .foregroundColor(color)
            Text(label)
                .font(.system(size: 10.5))
                .foregroundColor(palette.textTertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(palette.surfaceAlt)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}
