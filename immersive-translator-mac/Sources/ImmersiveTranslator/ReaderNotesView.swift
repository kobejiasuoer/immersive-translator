import SwiftUI
import AppKit
import ReaderCore

// MARK: - 笔记库（R2/R3）：复习笔记的留存与阅读视图
//
// 结构与书架/复习同构——左栏目录（按「今天 / 更早」分组），主区是渲染后的
// 「一页纸」：本篇速览（朱批）、记忆诊断词条卡（批语 + 批改记号 + 下次怎么测）、
// AI 复盘区（闭环链路 + 「阅」章）。对齐 Windows NotesView.tsx。

struct ReaderNotesView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            notesList
                .frame(width: 240)
            Divider().opacity(0.5)
            NotesSheetView(vm: vm)
        }
        .frame(maxHeight: .infinity)
        .onAppear {
            vm.refreshNotes()
        }
    }

    // MARK: 左栏目录

    private var wordById: [String: VocabWord] {
        Dictionary(uniqueKeysWithValues: vm.vocabWords.map { ($0.id, $0) })
    }

    private var notesList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    Text("笔记库").font(.system(size: 13, weight: .semibold))
                    Text("\(vm.notes.count)")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundColor(palette.textTertiary)
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.top, 12)
                .padding(.bottom, 6)

                if vm.notes.isEmpty {
                    Text("笔记库还是空的。\n在阅读里攒生词，随时能一键整理成复习笔记，自动存在这里。")
                        .font(.system(size: 11.5))
                        .foregroundColor(palette.textTertiary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .fixedSize(horizontal: false, vertical: true)
                }

                ForEach(groupedNotes, id: \.label) { group in
                    Text(group.label)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundColor(palette.textTertiary)
                        .padding(.horizontal, 12)
                        .padding(.top, 8)
                        .padding(.bottom, 3)
                    ForEach(group.items) { note in
                        NoteItemView(
                            note: note,
                            active: note.file == vm.activeNoteFile,
                            weakLive: stillWeakCount(note),
                            palette: palette
                        )
                        .onTapGesture { vm.selectNote(file: note.file) }
                        .contextMenu {
                            Button("删除这篇笔记", role: .destructive) {
                                vm.deleteNote(file: note.file)
                            }
                        }
                    }
                }

                Divider().opacity(0.5)
                    .padding(.vertical, 8)

                VStack(alignment: .leading, spacing: 6) {
                    Button {
                        vm.openNoteDialog()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "plus").font(.system(size: 11, weight: .semibold))
                            Text("生成新笔记").font(.system(size: 12.5))
                            Spacer()
                            let unnoted = vm.unnotedWordCount
                            if unnoted > 0 {
                                Text("\(unnoted) 词未整理")
                                    .font(.system(size: 9.5, weight: .semibold))
                                    .foregroundColor(.white)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 1)
                                    .background(Color.orange)
                                    .clipShape(Capsule())
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundColor(palette.accent)

                    Button {
                        vm.openReview()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: ReaderIcons.book).font(.system(size: 12))
                            Text("生词本复习").font(.system(size: 12.5))
                            Spacer()
                            let dueNow = vm.stats.dueNow
                            if dueNow > 0 {
                                Text("\(dueNow)")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundColor(.white)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 1)
                                    .background(palette.err)
                                    .clipShape(Capsule())
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundColor(palette.text)

                    let stats = vm.stats
                    let todayTotal = stats.reviewedToday + stats.dueNow
                    Text(todayTotal > 0
                        ? "今日复习 \(stats.reviewedToday) / \(todayTotal) · 连续打卡 \(stats.streak) 天"
                        : "今日没有到期生词了。")
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
            }
        }
        .background(palette.surfaceAlt)
    }

    private struct GroupedNotes {
        let label: String
        let items: [NoteMeta]
    }

    private var groupedNotes: [GroupedNotes] {
        let todayKey = dayKey(nowMs: Int64(Date().timeIntervalSince1970 * 1000))
        let today = vm.notes.filter { dayKey(nowMs: $0.createdAt) == todayKey }
        let earlier = vm.notes.filter { dayKey(nowMs: $0.createdAt) != todayKey }
        var groups: [GroupedNotes] = []
        if !today.isEmpty { groups.append(GroupedNotes(label: "今天", items: today)) }
        if !earlier.isEmpty { groups.append(GroupedNotes(label: "更早", items: earlier)) }
        return groups
    }

    /// 一篇笔记当前仍错的词数（实时；词已从生词本删除则不计）。
    private func stillWeakCount(_ note: NoteMeta) -> Int {
        guard note.replay != nil else { return 0 }
        return note.wordIds.filter { id in
            guard let w = wordById[id] else { return false }
            return isStillWeak(w)
        }.count
    }
}

private struct NoteItemView: View {
    let note: NoteMeta
    let active: Bool
    let weakLive: Int
    let palette: ReaderPalette

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(NoteTimeFormatter.format(note.createdAt))
                        .font(.system(size: 11.5, weight: active ? .semibold : .regular))
                    if note.partial {
                        Text("未完成")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundColor(.orange)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 0.5)
                            .background(Color.orange.opacity(0.15))
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                }
                HStack(spacing: 4) {
                    Text("\(note.words) 词条")
                        .font(.system(size: 10.5))
                        .foregroundColor(palette.textTertiary)
                    if note.replay != nil {
                        if weakLive > 0 {
                            Text("· \(weakLive) 词仍错")
                                .font(.system(size: 10.5))
                                .foregroundColor(palette.err)
                        } else {
                            Text("· 已全过 ✓")
                                .font(.system(size: 10.5))
                                .foregroundColor(palette.ok)
                        }
                    }
                }
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(active ? palette.accent.opacity(0.1) : Color.clear)
        .contentShape(Rectangle())
    }
}

// MARK: - 主区：一页纸

private struct NotesSheetView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    var body: some View {
        Group {
            if let active = vm.activeNote {
                notePage(active)
            } else {
                emptyState
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Text("📓").font(.system(size: 36))
            Text("笔记库还是空的").font(.system(size: 14, weight: .semibold))
            Text("在阅读里查词、点词块，选「加入生词本」——\n攒下的词和你的错题记录，会一起整理成复习笔记，自动存在这里。")
                .font(.system(size: 11.5))
                .foregroundColor(palette.textTertiary)
                .multilineTextAlignment(.center)
            Button("去生词本攒词") { vm.openReview() }
                .controlSize(.small)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var wordById: [String: VocabWord] {
        Dictionary(uniqueKeysWithValues: vm.vocabWords.map { ($0.id, $0) })
    }

    private func notePage(_ active: (meta: NoteMeta, parsed: ParsedNote)) -> some View {
        let meta = active.meta
        let parsed = active.parsed
        let date = NoteTimeFormatter.format(meta.createdAt)
        let dateLabel = date.hasPrefix("今天") ? "今天整理的复习笔记" : "\(date.components(separatedBy: " ").first ?? date)整理的复习笔记"
        let words = meta.wordIds.compactMap { wordById[$0] }
        let wordCount = meta.wordIds.filter { wordById[$0]?.effectiveKind != .chunk }.count
        let chunkCount = meta.wordIds.filter { wordById[$0]?.effectiveKind == .chunk }.count
        return ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(dateLabel)
                            .font(.system(size: 15, weight: .semibold, design: .serif))
                        if meta.partial {
                            Text("生成被取消 · 此为已完成部分")
                                .font(.system(size: 9.5))
                                .foregroundColor(.orange)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(Color.orange.opacity(0.12))
                                .clipShape(RoundedRectangle(cornerRadius: 3))
                        }
                    }
                    Text("\(date) · \(meta.words) 词条（单词 \(wordCount) · 词块 \(chunkCount)） · 已自动保存")
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                }
                Divider()

                if !parsed.glance.isEmpty {
                    noteSection("先看这里") {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(Array(parsed.glance.enumerated()), id: \.offset) { _, g in
                                NoteInline.attributed(g)
                                    .font(.system(size: 12, design: .serif))
                                    .foregroundColor(Color(red: 0.62, green: 0.16, blue: 0.16))
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(palette.surfaceAlt)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }

                ForEach(Array(parsed.sections.enumerated()), id: \.offset) { _, sec in
                    noteSection(sec.title) {
                        VStack(spacing: 10) {
                            ForEach(Array(sec.cards.enumerated()), id: \.offset) { _, card in
                                NoteEntryCard(
                                    card: card,
                                    word: findWordByHeading(card.word, in: words),
                                    palette: palette,
                                    onSpeak: { text in vm.speakWord(text) }
                                )
                            }
                        }
                    }
                }

                NoteReplayArea(vm: vm, meta: meta, wordById: wordById)
            }
            .padding(24)
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(palette.background.opacity(0.5))
    }

    @ViewBuilder
    private func noteSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 12, weight: .semibold, design: .serif))
                .foregroundColor(palette.textTertiary)
            content()
        }
    }
}

// MARK: - 词条卡

private struct NoteEntryCard: View {
    let card: ParsedCard
    let word: VocabWord?
    let palette: ReaderPalette
    let onSpeak: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
            remark
            if !card.senses.isEmpty { sensesRow }
            if let anchor = card.anchor {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("记")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(.white)
                        .frame(width: 16, height: 16)
                        .background(Color(hue: 0.58, saturation: 0.55, brightness: 0.52))
                        .clipShape(RoundedRectangle(cornerRadius: 3))
                    NoteInline.attributed(anchor)
                        .font(.system(size: 12))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let example = card.example {
                VStack(alignment: .leading, spacing: 2) {
                    Text(example)
                        .font(.system(size: 12.5, design: .serif))
                        .foregroundColor(palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let word, !word.source.articleId.isEmpty {
                        Text("出自收藏 · 复习时作为出语境")
                            .font(.system(size: 10))
                            .foregroundColor(palette.textTertiary)
                    }
                }
                .padding(.leading, 8)
                .overlay(alignment: .leading) {
                    Rectangle().fill(palette.textTertiary.opacity(0.3)).frame(width: 2)
                }
            }
            if !card.collos.isEmpty { colloRows }
            if let next = card.nextTest {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("下次怎么测")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(palette.accent)
                    Text(next.mode)
                        .font(.system(size: 11, weight: .semibold))
                    NoteInline.attributed(next.tip)
                        .font(.system(size: 11.5))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.accent.opacity(0.07))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(12)
        .background(palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(palette.textTertiary.opacity(0.15))
        )
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let word {
                Button {
                    onSpeak(word.word)
                } label: {
                    Text(card.word)
                        .font(.system(size: 14.5, weight: .semibold, design: .serif))
                        .foregroundColor(palette.text)
                }
                .buttonStyle(.plain)
                .help("朗读")
            } else {
                Text(card.word)
                    .font(.system(size: 14.5, weight: .semibold, design: .serif))
            }
            if let phonetic = word?.phonetic {
                Text(phonetic)
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
            }
            Text(posLabel)
                .font(.system(size: 10.5))
                .foregroundColor(palette.textTertiary)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(palette.surfaceAlt)
                .clipShape(RoundedRectangle(cornerRadius: 3))
            if let ticks = NoteTick.marks(for: word?.recall) {
                HStack(spacing: 1) {
                    ForEach(Array(ticks.marks.enumerated()), id: \.offset) { _, ok in
                        Text(ok ? "✓" : "✗")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(ok ? palette.ok : palette.err)
                    }
                }
                .help("批改记号：✗ 没想起/踩陷阱，✓ 通过")
                Text(ticks.label)
                    .font(.system(size: 10))
                    .foregroundColor(palette.textTertiary)
            }
            Spacer()
        }
    }

    private var posLabel: String {
        if word?.effectiveKind == .chunk { return "词块" }
        let pos = card.senses.first { $0.pos != nil }?.pos ?? ""
        let named: [String: String] = [
            "n.": "名词", "v.": "动词", "adj.": "形容词", "adv.": "副词",
            "prep.": "介词", "phr.": "短语",
        ]
        if let label = named[pos] { return label }
        return pos.isEmpty ? "词条" : String(pos.dropLast())
    }

    private var diagnose: (ok: Bool, text: String) {
        if let d = card.diagnose { return d }
        // 无批语时用数据兜底一条（宁短勿编）。
        let bad = (word?.recall?.total.wrong ?? 0) + (word?.recall?.total.trap ?? 0)
        if let recall = word?.recall {
            return (bad == 0, recall.total.pass + recall.total.wrong + recall.total.trap == 0
                ? "还没有复习记录，首次测试安排在到期日。"
                : "复习过但本篇没有诊断结论——先过一遍下面的记法。")
        }
        return (true, "还没有复习记录，首次测试安排在到期日。")
    }

    private var remark: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(diagnose.ok ? "批 · 为什么记住了" : "批 · 为什么记不住")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(diagnose.ok ? palette.ok : Color(red: 0.62, green: 0.16, blue: 0.16))
                NoteInline.attributed(diagnose.text)
                    .font(.system(size: 12))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let trace = NoteTrace.line(for: word?.recall) {
                Text(trace)
                    .font(.system(size: 10))
                    .foregroundColor(palette.textTertiary)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            diagnose.ok
                ? palette.ok.opacity(0.07)
                : Color(red: 0.62, green: 0.16, blue: 0.16).opacity(0.07)
        )
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private var sensesRow: some View {
        HStack(spacing: 0) {
            ForEach(Array(card.senses.enumerated()), id: \.offset) { item in
                senseText(item.element, isLast: item.offset == card.senses.count - 1)
            }
            Spacer()
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func senseText(_ s: (pos: String?, text: String), isLast: Bool) -> Text {
        var t: Text
        if let pos = s.pos, !pos.isEmpty {
            t = Text("\(pos) ")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(palette.accent)
            t = t + Text(s.text).font(.system(size: 12))
        } else {
            t = Text(s.text).font(.system(size: 12))
        }
        if !isLast {
            t = t + Text("；").font(.system(size: 12))
        }
        return t
    }

    private var colloRows: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(card.collos.enumerated()), id: \.offset) { _, c in
                HStack(spacing: 6) {
                    Text(c.k)
                        .font(.system(size: 9.5, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 0.5)
                        .background(palette.accent.opacity(0.7))
                        .clipShape(RoundedRectangle(cornerRadius: 3))
                    Text(c.en)
                        .font(.system(size: 11.5, weight: .medium))
                    Text(c.zh)
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                }
            }
        }
    }
}

// MARK: - AI 复盘区

private struct NoteReplayArea: View {
    @ObservedObject var vm: ReaderViewModel
    let meta: NoteMeta
    let wordById: [String: VocabWord]
    @Environment(\.readerPalette) private var palette

    /// 复盘后又产生了新的复习记录 → 可以再复盘。
    private var hasNewData: Bool {
        meta.wordIds.contains { id in
            guard let w = wordById[id], let lastAt = w.recall?.lastAt else { return false }
            return lastAt > meta.updatedAt
        }
    }

    /// 实时仍错词（从没测过 或 错+陷阱 > 过）：加练队列只排这些。
    private var stillWeakIds: [String] {
        meta.wordIds.filter { id in
            guard let w = wordById[id] else { return false }
            return isStillWeak(w)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("AI 复盘").font(.system(size: 12, weight: .semibold, design: .serif))
                if let replay = meta.replay {
                    Text("生成后复习 \(replay.rounds) 轮 · 最近一次 \(NoteTimeFormatter.format(replay.lastAt))")
                        .font(.system(size: 10.5))
                        .foregroundColor(palette.textTertiary)
                    Spacer()
                    Text(chipText(replay))
                        .font(.system(size: 10.5))
                        .foregroundColor(palette.textTertiary)
                } else {
                    Text("这篇笔记还没有复盘记录")
                        .font(.system(size: 10.5))
                        .foregroundColor(palette.textTertiary)
                    Spacer()
                }
            }

            loopSteps(done: meta.replay != nil ? 7 : 4)

            if let replay = meta.replay {
                Text(replay.verdict)
                    .font(.system(size: 12.5, design: .serif))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(10)
                    .overlay(alignment: .topTrailing) {
                        Text("阅")
                            .font(.system(size: 13, weight: .bold, design: .serif))
                            .foregroundColor(Color(red: 0.62, green: 0.16, blue: 0.16))
                            .padding(4)
                            .overlay(
                                RoundedRectangle(cornerRadius: 4)
                                    .strokeBorder(Color(red: 0.62, green: 0.16, blue: 0.16), style: StrokeStyle(lineWidth: 1.4))
                            )
                            .rotationEffect(.degrees(-8))
                            .padding(.trailing, 6)
                            .padding(.top, 8)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.surfaceAlt)
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                if !replay.weak.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(replay.weak.enumerated()), id: \.offset) { _, wk in
                            let matched = findWordByHeading(wk.w, in: meta.wordIds.compactMap { wordById[$0] })
                            let chip = weakChip(for: matched)
                            HStack(spacing: 8) {
                                Text(wk.w)
                                    .font(.system(size: 12, weight: .semibold))
                                Text(wk.why)
                                    .font(.system(size: 11.5))
                                    .foregroundColor(palette.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer()
                                Text(chip.text)
                                    .font(.system(size: 9.5, weight: .semibold))
                                    .foregroundColor(chip.tone == .done ? palette.ok : (chip.tone == .fair ? palette.warn : palette.err))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 1.5)
                                    .background(
                                        (chip.tone == .done ? palette.ok : (chip.tone == .fair ? Color.orange : palette.err)).opacity(0.12)
                                    )
                                    .clipShape(Capsule())
                            }
                        }
                    }
                }

                HStack(spacing: 8) {
                    Text("仍错的词可以滚进下一篇笔记（默认勾选）。")
                        .font(.system(size: 10.5))
                        .foregroundColor(palette.textTertiary)
                    Spacer()
                    if hasNewData {
                        Button(vm.noteReplayBusy ? "复盘中…" : "重新复盘") {
                            vm.generateReplay(for: meta)
                        }
                        .controlSize(.small)
                        .disabled(vm.noteReplayBusy)
                    }
                    Button("只测仍错的词\(stillWeakIds.isEmpty ? "" : "（\(stillWeakIds.count)）")") {
                        vm.startFocusReview(ids: stillWeakIds)
                    }
                    .controlSize(.small)
                    .disabled(stillWeakIds.isEmpty)
                    .help("只排这篇笔记仍错的词，不用等到期")
                    Button("把仍错词滚进新笔记") {
                        vm.openNoteDialog(preselect: stillWeakIds)
                    }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
                    .disabled(stillWeakIds.isEmpty)
                }
            } else {
                HStack(spacing: 8) {
                    Text("复习一轮后回来，这里会出现：哪些词过了、哪些还在错、下一步测什么。")
                        .font(.system(size: 10.5))
                        .foregroundColor(palette.textTertiary)
                    Spacer()
                    if hasNewData {
                        Button(vm.noteReplayBusy ? "复盘中…" : "生成复盘") {
                            vm.generateReplay(for: meta)
                        }
                        .controlSize(.small)
                        .buttonStyle(.borderedProminent)
                        .disabled(vm.noteReplayBusy)
                    }
                    Button("开始复习\(hasNewData || stillWeakIds.count != meta.wordIds.count ? stillWeakSuffix : "")") {
                        vm.startFocusReview(ids: stillWeakIds.isEmpty ? meta.wordIds : stillWeakIds)
                    }
                    .controlSize(.small)
                    .disabled(!hasNewData && stillWeakIds.isEmpty)
                }
            }
        }
        .padding(12)
        .background(palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(palette.textTertiary.opacity(0.15))
        )
    }

    private var stillWeakSuffix: String {
        guard !stillWeakIds.isEmpty, stillWeakIds.count < meta.wordIds.count else { return "" }
        return "（只测仍错的 \(stillWeakIds.count) 个）"
    }

    private func chipText(_ replay: NoteReplay) -> String {
        var text = "\(replay.passed) 词已过 · \(replay.stillWeak) 仍错"
        if replay.stillWeak > 0, stillWeakIds.isEmpty {
            text += " · 现在全过了"
        } else if !stillWeakIds.isEmpty, stillWeakIds.count != replay.stillWeak {
            text += " · 现在 \(stillWeakIds.count) 词仍错"
        }
        return text
    }

    private func weakChip(for word: VocabWord?) -> (text: String, tone: Tone) {
        let trap = word?.recall?.total.trap ?? 0
        let wrong = word?.recall?.total.wrong ?? 0
        let pass = word?.recall?.total.pass ?? 0
        let bad = trap + wrong
        if bad + pass > 0, bad <= pass { return ("已过 ✓", .done) }
        if trap > 0 { return ("踩陷阱", .bad) }
        if wrong >= 2 { return ("多次答错", .bad) }
        return ("仍在错", .fair)
    }

    enum Tone { case bad, fair, done }

    /// 闭环链路：done = 当前推进到的环节数。
    private func loopSteps(done: Int) -> some View {
        let steps: [(String, String)] = [
            ("📖", "阅读发现"), ("✎", "自动记录"), ("🔍", "AI 诊断"), ("📝", "复习笔记"),
            ("⏱", "间隔复习"), ("✓", "再测"), ("♻", "更新薄弱点"),
        ]
        return HStack(spacing: 2) {
            ForEach(Array(steps.enumerated()), id: \.offset) { idx, s in
                HStack(spacing: 2) {
                    Text(s.0).font(.system(size: 9))
                    Text(s.1).font(.system(size: 9.5))
                }
                .foregroundColor(idx < done ? palette.accent : palette.textTertiary.opacity(0.6))
                if idx < steps.count - 1 {
                    Text("›").font(.system(size: 9)).foregroundColor(palette.textTertiary.opacity(0.4))
                }
            }
        }
    }
}

// MARK: - 展示工具

enum NoteTimeFormatter {
    /// 「今天 HH:mm」/「M月d日 HH:mm」。
    static func format(_ ms: Int64, now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        let nowDate = Date(timeIntervalSince1970: Double(now) / 1000)
        var cal = Calendar.current
        cal.timeZone = .current
        let hm = DateFormatter()
        hm.dateFormat = "HH:mm"
        let sameDay = cal.isDate(date, inSameDayAs: nowDate)
        if sameDay { return "今天 \(hm.string(from: date))" }
        let md = DateFormatter()
        md.dateFormat = "M月d日"
        return "\(md.string(from: date)) \(hm.string(from: date))"
    }
}

enum NoteTick {
    /// 批改记号：✗（没想起/踩陷阱）在前，✓ 在后。
    static func marks(for recall: RecallStat?) -> (marks: [Bool], label: String)? {
        guard let recall else { return nil }
        let total = recall.total.pass + recall.total.wrong + recall.total.trap
        let hits = recall.total.wrong + recall.total.trap
        guard total > 0 else { return nil }
        var marks = Array(repeating: false, count: hits) + Array(repeating: true, count: total - hits)
        if marks.count > 12 {
            // 太长只保留最近 12 个（末尾）
            marks = Array(marks.suffix(12))
        }
        let label = hits == 0 ? "连过 \(total) 次" : hits == total ? "全错" : "\(total) 次里错 \(hits)"
        return (marks, label)
    }
}

enum NoteTrace {
    /// 判分轨迹行：识别 ✓✓ · 完形 ✗✗ · 最近一次：9月16日 08:40
    static func line(for recall: RecallStat?) -> String? {
        guard let recall else { return nil }
        var parts: [String] = []
        for (mode, st) in recall.byMode.sorted(by: { $0.key < $1.key }) {
            let bad = st.wrong + st.trap
            let marks = String(repeating: "✗", count: min(bad, 4)) + String(repeating: "✓", count: min(st.pass, 4))
            if !marks.isEmpty {
                parts.append("\(modeLabel(mode)) \(marks)")
            }
        }
        if let lastAt = recall.lastAt {
            parts.append("最近一次：\(NoteTimeFormatter.format(lastAt))")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func modeLabel(_ mode: String) -> String {
        switch mode {
        case "recognition": return "识别"
        case "cloze": return "完形"
        case "dictation": return "听写"
        default: return mode
        }
    }
}

/// 批注文本内联渲染：**加粗** → 粗体，`code` 去记号。
enum NoteInline {
    static func attributed(_ text: String) -> Text {
        // `code` 先去记号
        let cleaned = text.replacingOccurrences(of: #"`([^`]+)`"#, with: "$1", options: .regularExpression)
        var result = Text("")
        var rest = Substring(cleaned)
        while !rest.isEmpty {
            if let range = rest.range(of: #"\*\*([^*]+)\*\*"#, options: .regularExpression) {
                result = result + Text(rest[rest.startIndex..<range.lowerBound])
                let inner = String(rest[range]).replacingOccurrences(of: "**", with: "")
                result = result + Text(inner).bold()
                rest = rest[range.upperBound...]
            } else {
                result = result + Text(rest)
                rest = rest[rest.endIndex...]
            }
        }
        return result
    }
}
