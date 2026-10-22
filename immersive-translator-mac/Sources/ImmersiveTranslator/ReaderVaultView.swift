import AppKit
import SwiftUI
import ReaderCore
import XfyunCore

// MARK: - 「笔记与复习」三合一容器（v0.8 Phase 4 · VaultPage 的 Mac 对应物）

/// 顶栏三档玩法切换（记忆胶带手账 / 3 分钟快刷闯关 / Markdown 笔记导出）+
/// 右侧常驻「我的内化看板」；.review/.notes 两条兼容路由共用本容器
///（openReview 落挑战档、openNotes 落 md 档、导航岛跨视图进入保留上次档位）。
/// 数据全部来自真实存储（vocabWords / reviewLog / speak sessions），无演示常量。
struct ReaderVaultView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette
    /// md 档「笔记库回看」弹层（Windows vault-notes-overlay）。
    @State private var notesOpen = false
    /// 挑战档会话队列与游标（REV-12）：上提到容器层，左栏词表与闯关舞台共用——
    /// 词表序号 = 舞台「第 N / M 关」，点词改游标即跳卡（Windows reviewPos 共享语义）。
    @State private var challengeQueue: [VocabWord] = []
    @State private var challengePos = 0

    var body: some View {
        VStack(spacing: 0) {
            topBar
            HStack(alignment: .top, spacing: 0) {
                if vm.vaultPlayMode == .challenge {
                    // 生词本词表（Windows VocabListPanel · 232px 左栏壳）：挑战档专属。
                    VocabListPanelView(
                        vm: vm,
                        queue: challengeQueue,
                        pos: challengePos,
                        onJumpToCard: { index in
                            guard challengeQueue.indices.contains(index) else { return }
                            withAnimation(ReaderMotion.islandTab) { challengePos = index }
                        },
                        onExitFocus: { vm.focusReviewIds = nil }
                    )
                    .frame(width: 232)
                    .frame(maxHeight: .infinity)
                    .transition(.move(edge: .leading).combined(with: .opacity))
                    Divider().opacity(0.4)
                }
                ScrollView {
                    mainArea
                        .padding(20)
                        .frame(maxWidth: 760, alignment: .leading)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                Divider().opacity(0.4)
                ScrollView {
                    VaultDashboard(vm: vm)
                        .padding(16)
                }
                .frame(width: 300)
                .frame(maxHeight: .infinity)
            }
        }
        .overlay {
            if notesOpen {
                notesOverlay
            }
        }
        .onAppear {
            // .notes 兼容路由 = md 档（openNotes 已设；这里兜底路由直推的场景）。
            if vm.route == .notes { vm.vaultPlayMode = .md }
            if vm.activeNoteFile != nil { notesOpen = true }
        }
        .onChange(of: vm.route) { route in
            if route == .notes { vm.vaultPlayMode = .md }
        }
        .onChange(of: vm.activeNoteFile) { file in
            // 生成弹窗「在笔记库打开」：vault 已挂载时（onAppear 不会再触发）也弹回看层。
            if file != nil { notesOpen = true }
        }
    }

    // MARK: 顶栏（三档玩法 + tape 计数）

    private var topBar: some View {
        HStack(spacing: 12) {
            // M-08：三档切换改用透镜卡同款「胶囊槽 + 白底浮起」激活态
            //（原型 .lens-mode-switch / .lens-mode-btn.active，html:602-625）——
            // 与同窗导航岛、透镜卡「句子解析/查词」说同一种「选中」语言；
            // accent 只留给角标、主按钮和当前句。
            HStack(spacing: 2) {
                ForEach([ReaderViewModel.VaultPlayMode.tape, .challenge, .md], id: \.self) { mode in
                    modeTab(mode)
                }
            }
            .padding(3)
            .background(Capsule().fill(palette.background))
            .overlay(Capsule().strokeBorder(palette.glassBorder, lineWidth: 1))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("笔记与复习玩法切换")

            if vm.vaultPlayMode == .tape {
                let coached = vm.speakSessions.reduce(0) { n, s in
                    n + s.turns.filter { $0.role == .user && $0.coachDiff != nil }.count
                }
                Text("生词 \(vm.vocabWords.count) 词 · 口语改进 \(coached) 条")
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundColor(palette.textTertiary)
            }
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
    }

    private func modeTab(_ mode: ReaderViewModel.VaultPlayMode) -> some View {
        let active = vm.vaultPlayMode == mode
        return Button {
            withAnimation(ReaderMotion.islandTab) {
                vm.vaultPlayMode = mode
            }
        } label: {
            Text(mode.label)
                .font(.system(size: 12, weight: active ? .semibold : .medium))
                .foregroundColor(active ? palette.text : palette.textTertiary)
                .padding(.horizontal, 12)
                .frame(height: 26)
                .background {
                    // .lens-mode-btn.active：glass-elevated 白底 + 2px 6px 轻投影
                    if active {
                        Capsule()
                            .fill(palette.glassElevated)
                            .shadow(color: Color.black.opacity(0.08), radius: 3, y: 1)
                    }
                }
                .clipShape(Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help("切换到「\(mode.label)」")
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    @ViewBuilder
    private var mainArea: some View {
        switch vm.vaultPlayMode {
        case .tape:
            VaultTapeNotebook(vm: vm)
        case .challenge:
            VaultChallengeStage(vm: vm, queue: $challengeQueue, pos: $challengePos)
        case .md:
            VaultMarkdownExport(vm: vm, onOpenNotes: { notesOpen = true })
        }
    }

    // MARK: 笔记库回看弹层

    private var notesOverlay: some View {
        ZStack(alignment: .topTrailing) {
            Rectangle()
                .fill(.ultraThinMaterial)
                .ignoresSafeArea()
                .onTapGesture { notesOpen = false }
            VStack(spacing: 0) {
                ReaderNotesView(vm: vm)
                    .frame(maxWidth: 960, maxHeight: .infinity)
            }
            .padding(24)
            .background(palette.surface)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(palette.glassBorderStrong))
            .shadow(color: palette.shadowSpatial, radius: 18, y: 8)
            .padding(28)
            Button("收起笔记库") { notesOpen = false }
                .controlSize(.small)
                .padding(10)
        }
        .transition(.opacity.combined(with: .scale(scale: 0.98)))
    }
}

// MARK: - 内化三阶（ReaderCore masteryStage 统一派生，Windows readerSrs 同源）

// MARK: - 模式 1：记忆胶带手账（REV-2）

/// 手账行数据（生词原句行 + 口语改进行）。
struct VaultTapeEntry: Identifiable {
    enum Kind { case word, speak }

    let id: String
    let kind: Kind
    /// 归档键（all 之外）：article:<id> / popup / speak。
    let archiveKey: String
    let category: String
    // 生词行
    var word: VocabWord?
    var pre: String = ""
    var blank: String = ""
    var post: String = ""
    var sentenceEn: String?
    var sentenceZh: String?
    /// 胶带覆盖层提示：「释义（首字母…）」。
    var hint: String = ""
    var tip: String = ""
    // 口语行
    var original: String = ""
    var segs: [CoachSeg] = []
    var better: String = ""
    var note: String?
}

/// 手账条目构建：生词按 dueAt 升序 + 口语带 coachDiff 的 user 轮（真实数据）。
func buildVaultTapeEntries(
    words: [VocabWord],
    speakSessions: [SpeakSession],
    sourceSentence: (String, Int) -> (en: String, zh: String?)?,
    articleTitle: (String) -> String?
) -> [VaultTapeEntry] {
    var entries: [VaultTapeEntry] = []
    for w in words.sorted(by: { $0.srs.dueAt < $1.srs.dueAt }) {
        // 原句取回（与导出同款回退）：articleId 非空优先原文通道，文章被删取不到
        // 时回退词条自带例句；划词收藏直接用例句。
        let fromArticle: (en: String, zh: String?)? = w.source.articleId.isEmpty
            ? nil
            : sourceSentence(w.source.articleId, w.source.sentenceIdx)
        let src = fromArticle ?? w.example.map { (en: $0.en, zh: $0.zh) }
        var pre = ""
        var blank = w.word
        var post = ""
        if let src, !src.en.isEmpty, let range = findChunkRange(src.en, w.word) {
            pre = substring16(src.en, 0, range.start)
            blank = substring16(src.en, range.start, range.end)
            post = substring16(src.en, range.end, Array(src.en.utf16).count)
        }
        let title = w.source.articleId.isEmpty ? nil : articleTitle(w.source.articleId)
        entries.append(VaultTapeEntry(
            id: "w:\(w.id)",
            kind: .word,
            archiveKey: w.source.articleId.isEmpty ? "popup" : "article:\(w.source.articleId)",
            category: title != nil ? "\(title!) · 核心词块" : "划词收藏 · 核心词块",
            word: w,
            pre: pre,
            blank: blank,
            post: post,
            sentenceEn: src?.en,
            sentenceZh: src?.zh,
            hint: "\(w.senses.first?.cn ?? w.word)（\(firstLetters(blank))）",
            tip: [w.pattern, w.trap].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        ))
    }
    for session in speakSessions {
        for (idx, turn) in session.turns.enumerated() where turn.role == .user {
            guard let coach = turn.coachDiff else { continue }
            let better = coach.segs
                .filter { $0.t != .del }
                .map(\.v)
                .joined(separator: " ")
                .trimmingCharacters(in: .whitespaces)
            guard !better.isEmpty else { continue }
            let date = Date(timeIntervalSince1970: Double(turn.at) / 1000)
            let comps = Calendar.current.dateComponents([.month, .day], from: date)
            entries.append(VaultTapeEntry(
                id: "s:\(session.id):\(idx)",
                kind: .speak,
                archiveKey: "speak",
                category: "口语表达改进记录 · \(comps.month ?? 1)月\(comps.day ?? 1)日",
                original: turn.text,
                segs: coach.segs,
                better: better,
                note: coach.note
            ))
        }
    }
    return entries
}

/// UTF-16 子串（findChunkRange 的偏移是 UTF-16；越界收敛不崩）。
func substring16(_ s: String, _ start: Int, _ end: Int) -> String {
    let units = Array(s.utf16)
    let a = min(max(0, start), units.count)
    let b = min(max(a, end), units.count)
    guard a < b else { return "" }
    return String(decoding: units[a..<b], as: UTF16.self)
}

struct VaultTapeNotebook: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette
    /// 已揭开的胶带（entry id 集；点击切换反复自测）。
    @State private var peeled: Set<String> = []
    @State private var archive = "all"

    private var entries: [VaultTapeEntry] {
        buildVaultTapeEntries(
            words: vm.vocabWords,
            speakSessions: vm.speakSessions,
            sourceSentence: { vm.sourceSentence(articleId: $0, sentenceIdx: $1) },
            articleTitle: { vm.articleTitle(articleId: $0) }
        )
    }

    private var visible: [VaultTapeEntry] {
        archive == "all" ? entries : entries.filter { $0.archiveKey == archive }
    }

    private var archiveOptions: [(value: String, label: String)] {
        var counts: [String: Int] = [:]
        var labels: [String: String] = [:]
        for e in entries {
            counts[e.archiveKey, default: 0] += 1
            if labels[e.archiveKey] == nil { labels[e.archiveKey] = e.category }
        }
        var out: [(String, String)] = [("all", "全部（\(entries.count) 条）")]
        for (key, label) in labels {
            out.append((key, "\(label)（\(counts[key] ?? 0) 条）"))
        }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("1 分钟遮罩自测手账 · 告别死板背单词卡")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(palette.textTertiary)
                        .monospacedDigit()
                    Text("生词原句 & 口语纠偏手账")
                        .font(readerFont(19, .semibold, pair: vm.effectiveSettings.fontPair))
                        .foregroundColor(palette.text)
                }
                Spacer()
                Text("点击琥珀色胶带即可刮开自测")
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundColor(palette.textTertiary)
            }

            HStack(spacing: 10) {
                Picker("按来源归档", selection: $archive) {
                    ForEach(archiveOptions, id: \.value) { option in
                        Text(option.label).tag(option.value)
                    }
                }
                .pickerStyle(.menu)
                .frame(maxWidth: 320)
                Spacer()
                Button("全部盖上胶带自测") { peeled.removeAll() }
                    .controlSize(.small)
                Button("全部揭开") { peeled = Set(visible.map(\.id)) }
                    .controlSize(.small)
            }

            if visible.isEmpty {
                Text("这里还没有手账条目。在阅读里查词收藏、或去口语里练几轮，胶带条目会自动出现在这里。")
                    .font(.system(size: 12.5))
                    .foregroundColor(palette.textTertiary)
                    .padding(.vertical, 40)
                    .frame(maxWidth: .infinity)
            } else {
                // M-05：整份手账装进一张 22 圆角「手账纸」玻璃大卡
                //（.notebook-sheet-card，html:1005-1012）；条目行落在同一张纸上，
                // 行间只以发丝线分隔（.tape-entry-row 的 border-bottom）。
                VStack(spacing: 0) {
                    ForEach(Array(visible.enumerated()), id: \.element.id) { idx, entry in
                        tapeRow(entry)
                        if idx < visible.count - 1 {
                            Rectangle().fill(palette.glassBorder).frame(height: 1)
                        }
                    }
                }
                .padding(.vertical, 8)
                .padding(.horizontal, 28)
                .glassCard(palette: palette, radius: 22, heavyShadow: true)
            }
        }
    }

    @ViewBuilder
    private func tapeRow(_ entry: VaultTapeEntry) -> some View {
        if entry.kind == .word, let word = entry.word {
            VaultTapeWordRow(
                entry: entry,
                word: word,
                peeled: peeled.contains(entry.id),
                palette: palette,
                fontPair: vm.effectiveSettings.fontPair,
                onToggle: { toggle(entry.id) },
                onListen: {
                    if let en = entry.sentenceEn, !en.isEmpty {
                        vm.speakRecallSentence(en)
                    } else {
                        vm.speakWord(word.word)
                    }
                },
                onPass: { vm.gradeVocab(word, .good, mode: .recognition, verdict: nil) },
                onPractice: { vm.practiceVocabSpeak(word) }
            )
        } else {
            VaultTapeSpeakRow(
                entry: entry,
                peeled: peeled.contains(entry.id),
                palette: palette,
                onToggle: { toggle(entry.id) },
                onListen: { vm.speakWord(entry.better) }
            )
        }
    }

    private func toggle(_ id: String) {
        withAnimation(.timingCurve(0.16, 1, 0.3, 1, duration: 0.22)) {
            if peeled.contains(id) { peeled.remove(id) } else { peeled.insert(id) }
        }
    }
}

/// 琥珀胶带（.memory-tape）：默认遮盖（覆盖层「点击揭开 · 提示」），点击揭开/再贴上。
/// 键盘可达（原生 Button：Space/Enter 触发）。
private struct VaultTapeChip: View {
    let text: String
    let hint: String
    let peeled: Bool
    let palette: ReaderPalette
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Text(text)
                    .font(.system(size: 14.5, weight: .semibold, design: .serif))
                    .foregroundColor(palette.accent)
                    .opacity(peeled ? 1 : 0)
                if !peeled {
                    Text("点击揭开 · \(hint)")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(palette.tapeInk)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 2)
            .background(peeled ? palette.accentSoft : palette.tapeBg)
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(
                        peeled ? Color.clear : palette.tapeBorder,
                        style: StrokeStyle(lineWidth: 1, dash: [4, 3])
                    )
            )
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("点击揭开或重新贴上胶带")
    }
}

/// 三阶胶囊（.stage-pill）：s1 暖 / s2 靛 / s3 青绿（原型配色）。
private struct VaultStagePill: View {
    let stage: MasteryStage
    let palette: ReaderPalette

    var body: some View {
        let (bg, fg, label) : (Color, Color, String) = {
            switch stage {
            case .s1: return (palette.warnSoft, palette.warn, stage.tapeLabel)
            case .s2: return (palette.clauseIndigoSoft, palette.clauseIndigo, stage.tapeLabel)
            case .s3: return (palette.sonicTealSoft, palette.sonicTeal, stage.tapeLabel)
            }
        }()
        return Text(label)
            .font(.system(size: 10, weight: .semibold))
            .foregroundColor(fg)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(bg)
            .clipShape(Capsule())
    }
}

private struct VaultTapeWordRow: View {
    let entry: VaultTapeEntry
    let word: VocabWord
    let peeled: Bool
    let palette: ReaderPalette
    let fontPair: ReaderFontPair
    let onToggle: () -> Void
    let onListen: () -> Void
    let onPass: () -> Void
    let onPractice: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(entry.category)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(palette.textTertiary)
                VaultStagePill(stage: masteryStage(word), palette: palette)
                Spacer()
            }
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text(entry.pre)
                VaultTapeChip(text: entry.blank, hint: entry.hint, peeled: peeled, palette: palette, action: onToggle)
                    .padding(.horizontal, 3)
                Text(entry.post)
            }
            .font(readerFont(15, .regular, pair: fontPair))
            .foregroundColor(palette.text)
            .lineSpacing(4)
            .fixedSize(horizontal: false, vertical: true)

            if let zh = entry.sentenceZh, !zh.isEmpty {
                Text(zh)
                    .font(.system(size: 12))
                    .foregroundColor(palette.textTertiary)
            }

            HStack(spacing: 10) {
                Text(entry.tip.isEmpty ? "首字母：\(firstLetters(entry.blank))" : "提示：\(entry.tip)")
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
                    .lineLimit(1)
                Spacer()
                Button {
                    onListen()
                } label: {
                    Label("听原句", systemImage: ReaderIcons.speaker)
                        .font(.system(size: 11.5))
                }
                .buttonStyle(.link)
                Button {
                    onPass()
                } label: {
                    Label("秒懂过关", systemImage: "checkmark")
                        .font(.system(size: 11.5, weight: .semibold))
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                Button("去口语里用一次 →") { onPractice() }
                    .buttonStyle(.link)
                    .font(.system(size: 11.5))
            }
        }
        // M-05：行落在「手账纸」大卡上（.tape-entry-row：padding 16 0 + 发丝线分隔），
        // 不再自带实底小卡。
        .padding(.vertical, 16)
    }
}

private struct VaultTapeSpeakRow: View {
    let entry: VaultTapeEntry
    let peeled: Bool
    let palette: ReaderPalette
    let onToggle: () -> Void
    let onListen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(entry.category)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(palette.textTertiary)
                Text("熟悉中 · 替代中式表达")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(palette.clauseIndigo)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(palette.clauseIndigoSoft)
                    .clipShape(Capsule())
                Spacer()
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("你原本说：\(entry.original)")
                    .font(.system(size: 12.5))
                    .foregroundColor(palette.textTertiary)
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    Text("→ 地道说法：")
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundColor(palette.textSecondary)
                    segsView
                }
                .fixedSize(horizontal: false, vertical: true)
            }

            if let note = entry.note, !note.isEmpty {
                Text(note)
                    .font(.system(size: 12))
                    .foregroundColor(palette.textTertiary)
            }

            HStack(spacing: 10) {
                Text("在口语里替换掉上面的说法，胶带遮住先自己回忆")
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
                Spacer()
                Button {
                    onListen()
                } label: {
                    Label("听地道说法", systemImage: ReaderIcons.speaker)
                        .font(.system(size: 11.5))
                }
                .buttonStyle(.link)
            }
        }
        // M-05：同 VaultTapeWordRow——落在手账纸大卡上的行。
        .padding(.vertical, 16)
    }

    /// 改写行：ins 片段贴胶带遮盖，del 片段弱化划线，keep 原样。
    @ViewBuilder
    private var segsView: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            ForEach(Array(entry.segs.enumerated()), id: \.offset) { _, seg in
                switch seg.t {
                case .del:
                    Text(seg.v)
                        .strikethrough()
                        .foregroundColor(palette.textTertiary.opacity(0.6))
                        .font(.system(size: 13))
                case .ins:
                    VaultTapeChip(text: seg.v, hint: "新说法（\(firstLetters(seg.v))）", peeled: peeled, palette: palette, action: onToggle)
                        .padding(.horizontal, 3)
                case .keep:
                    Text("\(seg.v) ")
                        .font(.system(size: 13.5, weight: .medium))
                        .foregroundColor(palette.text)
                }
            }
        }
    }
}

// MARK: - 模式 2：3 分钟快刷闯关（REV-3）

/// 闯关轮转：完形 → 听写 → 开口（每评一关 step+1；原句缺失时完形/听写降级开口卡）。
private let vaultChallengeRotation: [RecallMode] = [.cloze, .dictation, .recognition]

struct VaultChallengeStage: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    private struct Outcome: Equatable {
        let word: String
        let text: String
    }

    // ---- 队列与会话状态 ----
    /// 会话队列（容器持有：左栏词表共用，序号 = 关数；REV-12）。
    @Binding var queue: [VocabWord]
    /// 当前关游标（容器持有：左栏点词即跳卡）。
    @Binding var pos: Int
    /// 轮转步（每评/跳一关 +1）。
    @State private var step = 0
    @State private var outcome: Outcome?
    /// 评分防重入：评分后到队列刷新的间隙同一张卡只允许评一次。
    @State private var gradedIds: Set<String> = []
    /// 听写卡自动朗读去重。
    @State private var spokeIds: Set<String> = []
    /// 本轮判分记录（REV-9 完成摘要：四格统计 + 错题预选）；进入舞台时清零。
    @State private var results: [ReviewView.RecallResult] = []

    // ---- 卡片内状态（每张卡重置） ----
    @State private var input = ""
    @State private var hints = 0
    @State private var cnShown = false
    @State private var verdict: RecallVerdict?
    @State private var replays = VaultChallengeStage.dictationReplays
    @FocusState private var inputFocused: Bool
    static let dictationReplays = 3

    private var current: VocabWord? {
        queue.indices.contains(pos) ? queue[pos] : nil
    }

    private enum CardKind {
        case cloze, dictation, speak
    }

    /// 当前卡的形态与句子素材（原句缺失/定位不到时完形/听写降级为开口卡）。
    private var effective: (kind: CardKind, source: (en: String, zh: String?)?) {
        guard let word = current else { return (.speak, nil) }
        let desired = vaultChallengeRotation[step % vaultChallengeRotation.count]
        let fromArticle = vm.sourceSentence(articleId: word.source.articleId, sentenceIdx: word.source.sentenceIdx)
        let source = fromArticle ?? word.example.map { (en: $0.en, zh: $0.zh) }
        if desired == .recognition || source == nil || source?.en.isEmpty != false {
            return (.speak, nil)
        }
        if let source, desired == .dictation {
            return (.dictation, source)
        }
        if let source, findChunkRange(source.en, word.word) != nil {
            return (.cloze, source)
        }
        return (.speak, nil)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Text(kindBadge)
                    .font(.system(size: 10.5, weight: .bold))
                    .foregroundColor(palette.onInk)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(palette.accent)
                    .clipShape(Capsule())
                Text("第 \(min(pos + 1, max(queue.count, 1))) / \(max(queue.count, 1)) 关")
                    .font(.system(size: 11.5).monospacedDigit())
                    .foregroundColor(palette.textTertiary)
                if vm.focusReviewIds != nil {
                    Text("加练中")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(palette.warn)
                }
                Spacer()
            }

            if let outcome {
                // 上一关结果条（vault-outcome-strip）
                HStack(spacing: 4) {
                    Text("上一关：")
                    Text(outcome.word).fontWeight(.semibold)
                    Text(outcome.text)
                }
                .font(.system(size: 12))
                .foregroundColor(palette.textSecondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.accentSofter)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            if let word = current {
                card(word)
            } else if !results.isEmpty {
                // 本轮评完：结果摘要 + 黄金出口（REV-9；与 ReviewView 同一张摘要卡）
                summaryPanel
            } else {
                donePanel
            }
        }
        .onAppear {
            rebuildQueue(resetSession: true)
            installKeys()
        }
        .onDisappear {
            vm.reviewKeyHandler = nil
        }
        .onChange(of: vm.focusReviewIds) { _ in
            // 加练批次变化只换队列（开口命中的 drain、看板靶向加练都会改 focusIds），
            // 会话进度（step/上一关结果/已评去重）保留——Windows ChallengeStage 的
            // 这些状态同样跨 due 变化存活。
            rebuildQueue(resetSession: false)
        }
        .onChange(of: current?.id) { _ in
            resetCardState()
            autoSpeakDictationIfNeeded()
        }
        .onChange(of: effective.kind) { _ in
            autoSpeakDictationIfNeeded()
        }
    }

    private var kindBadge: String {
        switch effective.kind {
        case .cloze: return "完形 · 原句挖空"
        case .dictation: return "听音 · 听整句写整句"
        case .speak: return "开口 · 说一句直接过关"
        }
    }

    private func rebuildQueue(resetSession: Bool) {
        queue = vm.reviewQueue
        pos = min(pos, max(0, queue.count - 1))
        if queue.isEmpty { pos = 0 }
        if resetSession {
            outcome = nil
            gradedIds = []
            spokeIds = []
            results = []
        }
        resetCardState()
    }

    private func resetCardState() {
        input = ""
        hints = 0
        cnShown = false
        verdict = nil
        replays = Self.dictationReplays
    }

    /// 听写卡进入即自动朗读一次（word 音轨，不打断句子朗读）。
    private func autoSpeakDictationIfNeeded() {
        guard let word = current, effective.kind == .dictation, let source = effective.source,
              !spokeIds.contains(word.id) else { return }
        spokeIds.insert(word.id)
        vm.speakRecallSentence(source.en)
    }

    // MARK: 卡片

    @ViewBuilder
    private func card(_ word: VocabWord) -> some View {
        let sourceLabel = metaSource(word)
        switch effective.kind {
        case .cloze:
            VaultChallengeClozeCard(
                word: word,
                source: effective.source,
                input: $input,
                hints: hints,
                cnShown: cnShown,
                verdict: verdict,
                pos: pos,
                total: queue.count,
                sourceLabel: sourceLabel,
                palette: palette,
                fontPair: vm.effectiveSettings.fontPair,
                focused: $inputFocused,
                onHint: { hints = min(3, hints + 1) },
                onRevealCn: { cnShown = true },
                onSubmit: { submitCloze(word) },
                onGiveUp: { verdict = .wrong },
                onJump: { vm.jumpToSource(articleId: word.source.articleId, sentenceIdx: word.source.sentenceIdx) },
                onGrade: { grade($0, word: word) }
            )
        case .dictation:
            VaultChallengeDictationCard(
                word: word,
                source: effective.source,
                input: $input,
                verdict: verdict,
                replays: replays,
                pos: pos,
                total: queue.count,
                sourceLabel: sourceLabel,
                palette: palette,
                focused: $inputFocused,
                onReplay: { replayDictation(word) },
                onSubmit: { submitDictation(word) },
                onGiveUp: { verdict = .wrong },
                onJump: { vm.jumpToSource(articleId: word.source.articleId, sentenceIdx: word.source.sentenceIdx) },
                onGrade: { grade($0, word: word) }
            )
        case .speak:
            VaultSpeakChallengeCard(
                word: word,
                sample: vm.sourceSentence(articleId: word.source.articleId, sentenceIdx: word.source.sentenceIdx)?.en
                    ?? word.example?.en,
                pos: pos,
                total: queue.count,
                sourceLabel: sourceLabel,
                palette: palette,
                fontPair: vm.effectiveSettings.fontPair,
                onPass: { passSpeak(word) },
                onGiveUp: { skipCurrent() },
                onSpeakSample: { vm.speakRecallSentence($0) }
            )
            .id(word.id)  // 换词重置录音/打字状态
        }
    }

    private func metaSource(_ word: VocabWord) -> String {
        if let title = vm.articleTitle(articleId: word.source.articleId) {
            return "来自「\(title)」· 第 \(word.source.sentenceIdx + 1) 句"
        }
        return "来自划词收藏"
    }

    // MARK: 判分与推进

    private func submitCloze(_ word: VocabWord) {
        guard verdict == nil, let source = effective.source,
              !input.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        let blank = VaultChallengeClozeCard.blankText(source.en, word.word) ?? word.word
        verdict = judgeCloze(input, blank, options: JudgeOptions(trap: word.trap, accepted: [word.word]))
    }

    private func submitDictation(_ word: VocabWord) {
        guard verdict == nil, let source = effective.source,
              !input.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        verdict = judgeDictation(input, source.en, options: JudgeOptions(trap: word.trap))
    }

    private func replayDictation(_ word: VocabWord) {
        guard let source = effective.source else { return }
        if verdict == nil {
            guard replays > 0 else { return }
            replays -= 1
        }
        vm.speakRecallSentence(source.en)
    }

    /// 评分落盘（gradeVocab 刷新队列数据；快照移除当前词 → 游标自然指向下一关）。
    private func grade(_ g: ReviewGrade, word: VocabWord) {
        guard !gradedIds.contains(word.id) else { return }
        gradedIds.insert(word.id)
        let mode: RecallMode
        switch effective.kind {
        case .cloze: mode = .cloze
        case .dictation: mode = .dictation
        case .speak: mode = .recognition
        }
        let judged: RecallVerdict? = mode == .recognition ? nil : verdict
        vm.gradeVocab(word, g, mode: mode, verdict: judged)
        results.append(ReviewView.RecallResult(wordId: word.id, mode: mode, judged: judged, grade: g))
        outcome = Outcome(word: word.word, text: "已按「\(g.label)」完成")
        step += 1
        queue.removeAll { $0.id == word.id }
        if pos >= queue.count { pos = 0 }
        if vm.focusReviewIds != nil {
            // 加练队列里任意评分都把词移出批次（对齐 Windows gradeAndDrainFocus），
            // 左栏横幅「剩 N」与队列同步；onChange(focusReviewIds) 重建队列但保留会话。
            vm.focusReviewIds = vm.focusReviewIds?.filter { $0 != word.id }
        }
    }

    /// 开口卡命中目标词：easy 档 + spokenAt（内化三阶最高档）。
    private func passSpeak(_ word: VocabWord) {
        guard !gradedIds.contains(word.id) else { return }
        gradedIds.insert(word.id)
        if vm.focusReviewIds != nil {
            // 加练队列里开口命中：同样按 easy+spokenAt 落盘，并把词移出队列
            //（对齐 Windows gradeSpokenAndDrainFocus）。
            vm.focusReviewIds = vm.focusReviewIds?.filter { $0 != word.id }
        }
        vm.gradeSpoken(word)
        results.append(ReviewView.RecallResult(wordId: word.id, mode: .recognition, judged: nil, grade: .easy))
        outcome = Outcome(word: word.word, text: "开口命中 · 已按「很轻松」完成并记一次口语表达")
        step += 1
        queue.removeAll { $0.id == word.id }
        if pos >= queue.count { pos = 0 }
    }

    /// 放弃（跳过不评分）：词不离队，游标手动推进（末尾回绕）。
    private func skipCurrent() {
        guard let word = current else { return }
        outcome = Outcome(word: word.word, text: "跳过（未评分）")
        step += 1
        if queue.count > pos + 1 {
            pos += 1
        } else {
            pos = 0
        }
    }

    /// 本轮闯关完成摘要（REV-9 黄金出口）：复用 ReviewView 的 SummaryPanelView——
    /// 四格判分统计 +「把这轮错题整理成笔记」（预选本轮 wrong/close/trap 词，无错题禁用）
    /// +「去笔记库看复盘」；下方保留「回手账自测」出口（Windows vault-done-panel）。
    private var summaryPanel: some View {
        VStack(spacing: 10) {
            SummaryPanelView(
                results: results,
                palette: palette,
                title: "本轮闯关完成 🎉",
                onRestart: {
                    results = []
                    gradedIds = []
                },
                onGenerateNote: { ids in vm.openNoteDialog(preselect: ids) },
                onOpenNotes: { vm.openNotes() }
            )
            Button("回手账自测") {
                withAnimation(ReaderMotion.islandTab) { vm.vaultPlayMode = .tape }
            }
            .controlSize(.small)
        }
        .transition(.opacity.combined(with: .scale(scale: 0.98)))
    }

    private var donePanel: some View {
        VStack(spacing: 10) {
            Text(vm.stats.total == 0 ? "生词本还是空的" : "本轮闯关完成 🎉")
                .font(.system(size: 17, weight: .semibold))
                .foregroundColor(palette.text)
            Text(vm.stats.total == 0
                 ? "在阅读室里查词并点击「加入生词本」，闯关卡会出现在这里。"
                 : "这一批都过了。换个玩法，或回阅读室继续攒新词。")
                .font(.system(size: 12.5))
                .foregroundColor(palette.textSecondary)
                .multilineTextAlignment(.center)
            HStack(spacing: 10) {
                Button("回手账自测") {
                    withAnimation(ReaderMotion.islandTab) { vm.vaultPlayMode = .tape }
                }
                    .controlSize(.small)
                Button("整理成笔记") { vm.openNoteDialog() }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(.vertical, 48)
        .frame(maxWidth: .infinity)
    }

    // MARK: 键盘（1-4 评分 · ↩ 采纳建议档 · Space 听写重播 · H 提示；输入框聚焦不劫持）

    private func installKeys() {
        vm.reviewKeyHandler = { event in
            handleKey(event)
        }
    }

    private func handleKey(_ event: NSEvent) -> Bool {
        guard current != nil else { return false }
        if let responder = NSApp.keyWindow?.firstResponder, responder is NSTextView || responder is NSTextField {
            return false
        }
        guard let key = event.charactersIgnoringModifiers?.lowercased() else { return false }
        let gradeable = effective.kind == .speak || verdict != nil
        if ["1", "2", "3", "4"].contains(key), gradeable, let word = current {
            let picked: ReviewGrade = key == "1" ? .forgot : key == "2" ? .hard : key == "3" ? .good : .easy
            grade(picked, word: word)
            return true
        }
        if key == "return", let v = verdict, let word = current {
            grade(verdictToSuggestedGrade(v), word: word)
            return true
        }
        if key == "h", effective.kind == .cloze, verdict == nil {
            hints = min(3, hints + 1)
            return true
        }
        if key == " ", effective.kind == .dictation, verdict == nil, replays > 0 {
            replays -= 1
            if let source = effective.source {
                vm.speakRecallSentence(source.en)
            }
            return true
        }
        return false
    }
}

// MARK: - 闯关完形卡（判分链路与阅读室/迷你窗同向量：judgeCloze(输入, 句中词块原文)）

private struct VaultChallengeClozeCard: View {
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
    let onHint: () -> Void
    let onRevealCn: () -> Void
    let onSubmit: () -> Void
    let onGiveUp: () -> Void
    let onJump: () -> Void
    let onGrade: (ReviewGrade) -> Void

    /// 句中被挖空的词块原文（判分答案；与 ReaderReviewView.chunkBlank 同语义）。
    static func blankText(_ sentence: String, _ phrase: String) -> String? {
        guard let range = findChunkRange(sentence, phrase) else { return nil }
        return substring16(sentence, range.start, range.end)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VaultCardMeta(pill: "完形", tone: palette.accent, source: sourceLabel, pos: pos, total: total, palette: palette)
            if let source, let blank = Self.blankText(source.en, word.word) {
                sentence(source: source, blank: blank)
                if let zh = source.zh, !zh.isEmpty {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("中文提示：").font(.system(size: 12)).foregroundColor(palette.textTertiary)
                        Text(cnShown ? zh : "＿＿＿＿")
                            .font(.system(size: 12))
                            .foregroundColor(cnShown ? palette.textSecondary : palette.textTertiary.opacity(0.5))
                            .contentShape(Rectangle())
                            .onTapGesture { if !cnShown { onRevealCn() } }
                    }
                }
                if verdict == nil {
                    hintLadder(blank: blank)
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
                } else if let verdict {
                    VaultVerdictPanel(verdict: verdict, palette: palette, onJump: onJump) {
                        if verdict == .close {
                            Text("你写的：\(input.trimmingCharacters(in: .whitespaces))")
                                .font(.system(size: 12))
                                .foregroundColor(palette.textSecondary)
                        }
                        Text(blank + (blank != word.word ? "（词条原形：\(word.word)）" : ""))
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(palette.text)
                    }
                    VaultGradeBar(suggest: verdictToSuggestedGrade(verdict), ask: "这个空，你答上来了吗？", palette: palette, onGrade: onGrade)
                }
            }
        }
        // M-05：闯关大卡套 .challenge-stage-box 材质（html:1080-1089）——
        // 22 圆角 glass-elevated + shadow-spatial + 发丝边 + 顶内高光。
        .padding(.vertical, 24)
        .padding(.horizontal, 28)
        .glassCard(palette: palette, radius: 22, elevated: true, heavyShadow: true)
        .onAppear { focused.wrappedValue = true }
    }

    private func sentence(source: (en: String, zh: String?), blank: String) -> some View {
        let range = findChunkRange(source.en, word.word)
        let pre = range.map { substring16(source.en, 0, $0.start) } ?? source.en
        let post = range.map { substring16(source.en, $0.end, Array(source.en.utf16).count) } ?? ""
        let base = Text(pre + "　")
        let mid: Text
        if let verdict {
            let color: Color = verdict == .perfect ? palette.ok : (verdict == .close ? palette.warn : palette.err)
            mid = Text(blank).foregroundColor(color).underline()
        } else {
            let typed = input.isEmpty ? "　　　　" : input
            mid = Text(typed).underline().foregroundColor(palette.accent)
        }
        return (base + mid + Text("　" + post))
            .font(readerFont(16, .regular, pair: fontPair))
            .foregroundColor(palette.text)
            .lineSpacing(4)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func hintLadder(blank: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if hints >= 1, let gloss = word.senses.first?.cn {
                hintRow(tag: "提示 1", text: gloss)
            }
            if hints >= 2 {
                hintRow(tag: "提示 2", text: "\(firstLetters(blank))（\(blank.split(separator: " ").count) 词）")
            }
            if hints >= 3 {
                if let pattern = word.pattern {
                    hintRow(tag: "槽位记法", text: pattern)
                } else if let zh = source?.zh {
                    hintRow(tag: "中文句", text: zh)
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
}

// MARK: - 闯关听写卡

private struct VaultChallengeDictationCard: View {
    let word: VocabWord
    let source: (en: String, zh: String?)?
    @Binding var input: String
    let verdict: RecallVerdict?
    let replays: Int
    let pos: Int
    let total: Int
    let sourceLabel: String
    let palette: ReaderPalette
    var focused: FocusState<Bool>.Binding
    let onReplay: () -> Void
    let onSubmit: () -> Void
    let onGiveUp: () -> Void
    let onJump: () -> Void
    let onGrade: (ReviewGrade) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VaultCardMeta(pill: "听写", tone: palette.knownColor, source: sourceLabel, pos: pos, total: total, palette: palette)
            if let source {
                HStack(spacing: 10) {
                    Button(action: onReplay) {
                        Text(verdict != nil ? "再听一遍" : (replays < VaultChallengeStage.dictationReplays ? "重播句子" : "播放句子"))
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
                                .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty)
                            Button("听不出，看句子", action: onGiveUp)
                                .controlSize(.small)
                        }
                    }
                } else if let verdict {
                    VaultVerdictPanel(verdict: verdict, palette: palette, onJump: onJump) {
                        let diff = wordDiff(input, source.en)
                        let answerWords = max(1, source.en.split(separator: " ").count)
                        let hit = Int((Double(diff.filter { $0.status == .ok }.count) / Double(answerWords)) * 100)
                        Text("词级命中 \(hit)%")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(palette.textSecondary)
                        Text(source.en)
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundColor(palette.text)
                    }
                    VaultGradeBar(suggest: verdictToSuggestedGrade(verdict), ask: "这一句，你写出来了吗？", palette: palette, onGrade: onGrade)
                }
            }
        }
        // M-05：闯关大卡套 .challenge-stage-box 材质（html:1080-1089）——
        // 22 圆角 glass-elevated + shadow-spatial + 发丝边 + 顶内高光。
        .padding(.vertical, 24)
        .padding(.horizontal, 28)
        .glassCard(palette: palette, radius: 22, elevated: true, heavyShadow: true)
        .onAppear { focused.wrappedValue = true }
    }
}

// MARK: - 开口造句过关卡（REV-4：录音 → VAD 静音自动收 → 讯飞 ASR → 命中即过关）

/// 「开口造句过关」：看目标词 + 参考例句，点麦克风说一句包含目标词的话——
/// 录音（MicRecorder + VadDetector 1.4s 静音自动收，再点立即收）→ 讯飞听写转写
/// → textHitsTarget 命中即 onPass（easy 档 + spokenAt）；未命中给识别文本 + 再试/放弃；
/// 全程静音不算一次尝试；ASR 凭据缺失降级为打字造句（judgeCloze 宽容判分，perfect/close 过）。
private struct VaultSpeakChallengeCard: View {
    let word: VocabWord
    let sample: String?
    let pos: Int
    let total: Int
    let sourceLabel: String
    let palette: ReaderPalette
    let fontPair: ReaderFontPair
    let onPass: () -> Void
    let onGiveUp: () -> Void
    let onSpeakSample: (String) -> Void

    private enum Phase: Equatable {
        case idle, recording, recognizing, miss, failed
    }

    @State private var phase: Phase = .idle
    @State private var typedMode = false
    @State private var typed = ""
    @State private var typedVerdict: RecallVerdict?
    @State private var transcript = ""
    @State private var errorText = ""
    @State private var recorder: MicRecorder?
    @State private var vad: VadDetector?
    /// 收麦去重（VAD 自动收与手动收并发只走一条）。
    @State private var finishing = false
    @FocusState private var typedFocused: Bool

    /// 静音自动收麦等待（说完话 1.4s 没声音即收）。
    private static let silenceMs: Double = 1400

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VaultCardMeta(pill: "开口", tone: palette.knownColor, source: sourceLabel, pos: pos, total: total, palette: palette)

            let gloss = word.senses.first?.cn ?? ""
            (
                Text("试着用「")
                + Text(word.word).fontWeight(.semibold).foregroundColor(palette.accent)
                + Text("」" + (gloss.isEmpty ? "" : "（\(gloss)）") + "随口说一句话：")
            )
            .font(.system(size: 13.5))
            .foregroundColor(palette.text)

            if let sample, !sample.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("参考例句（可直接跟读或自由发挥）：")
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("“\(sample)”")
                            .font(readerFont(14, .regular, pair: fontPair))
                            .foregroundColor(palette.textSecondary)
                        Button {
                            onSpeakSample(sample)
                        } label: {
                            Image(systemName: ReaderIcons.speaker).font(.system(size: 12))
                        }
                        .buttonStyle(.borderless)
                        .foregroundColor(palette.accent)
                        .help("朗读参考例句")
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.surfaceAlt)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            if typedMode {
                typedArea
            } else {
                micArea
            }

            if phase == .miss, !transcript.isEmpty {
                missPanel
            }
            if !errorText.isEmpty, phase != .miss {
                Text(errorText)
                    .font(.system(size: 12))
                    .foregroundColor(palette.err)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.errSoft)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        // M-05：开口卡同样走 .challenge-stage-box 玻璃材质。
        .padding(.vertical, 24)
        .padding(.horizontal, 28)
        .glassCard(palette: palette, radius: 22, elevated: true, heavyShadow: true)
        .onDisappear {
            // 卸载保护：录音中切卡/换词直接丢弃，不留悬空麦克风。
            recorder?.cancel()
            recorder = nil
            vad = nil
        }
    }

    // MARK: 麦克风区

    private var micArea: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                toggleMic()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: phase == .recording ? "mic.fill" : "mic")
                    Text(micButtonLabel)
                }
                .frame(maxWidth: .infinity)
            }
            .controlSize(.large)
            .buttonStyle(.borderedProminent)
            .disabled(phase == .recognizing)
            .tint(phase == .recording ? palette.err : nil)

            Button("放弃这题", action: onGiveUp)
                .controlSize(.small)

            Text("说出包含目标词的句子即可，识别命中按「很轻松」完成复习")
                .font(.system(size: 11))
                .foregroundColor(palette.textTertiary)
        }
    }

    private var micButtonLabel: String {
        switch phase {
        case .recording: return "正在听…说完自动收（再点立即收）"
        case .recognizing: return "识别中…"
        default: return "点击开口说一句（说对直接过关）"
        }
    }

    // MARK: 打字降级区（无讯飞听写凭据）

    private var typedArea: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text("打字造一句：")
                    .font(.system(size: 13))
                    .foregroundColor(palette.textSecondary)
                TextField("用 \(word.word) 造一句", text: $typed)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 13.5))
                    .frame(maxWidth: 320)
                    .focused($typedFocused)
                    .onSubmit { submitTyped() }
                Button("提交判分", action: submitTyped)
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
                    .disabled(typedVerdict != nil || typed.trimmingCharacters(in: .whitespaces).isEmpty)
                Button("放弃这题", action: onGiveUp)
                    .controlSize(.small)
            }
            if let typedVerdict {
                VaultVerdictPanel(verdict: typedVerdict, palette: palette, onJump: nil) {
                    Text("你写的：\(typed.trimmingCharacters(in: .whitespaces))（判分规则与完形一致：拼写接近也算过）")
                        .font(.system(size: 12))
                        .foregroundColor(palette.textSecondary)
                    Text(word.word)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(palette.text)
                }
            }
        }
    }

    /// 未命中：给识别文本 + 再试一次（放弃走 micArea 的按钮，不评分）。
    private var missPanel: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("✗ 没说到目标词")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(palette.err)
            Text("识别为：\(transcript)")
                .font(.system(size: 12.5, weight: .medium))
                .foregroundColor(palette.text)
            HStack(spacing: 10) {
                Text(word.word)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(palette.textSecondary)
                Button("再试一次") { retry() }
                    .buttonStyle(.link)
                    .font(.system(size: 11.5))
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.errSoft)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: 录音状态机

    /// 开麦（VAD 1.4s 静音自动收）/ 录音中再点 = 说完手动收。
    private func toggleMic() {
        if typedMode { return }
        if phase == .recording {
            finishRecording()
            return
        }
        if phase == .recognizing { return }
        // 上一轮已收完（idle/failed/miss 都允许重开），解锁新一轮录音。
        finishing = false
        transcript = ""
        errorText = ""
        phase = .recording
        let detector = VadDetector(silenceMs: Self.silenceMs) { _ in
            DispatchQueue.main.async {
                finishRecording()
            }
        }
        vad = detector
        Task { @MainActor in
            do {
                let rec = try await MicRecorder.start(deviceUID: MicDevicePreference.selectedUID) { event in
                    DispatchQueue.main.async {
                        detector.feed(event.level, elapsedMs: event.elapsedMs)
                    }
                }
                guard phase == .recording, recorder == nil else {
                    rec.cancel() // 期间已手动收/切卡：丢弃后到的录音器
                    return
                }
                recorder = rec
            } catch {
                if phase == .recording {
                    phase = .failed
                    errorText = "麦克风打不开（\((error as? LocalizedError)?.errorDescription ?? String(describing: error))）"
                }
            }
        }
    }

    private func finishRecording() {
        guard let rec = recorder, !finishing else { return }
        finishing = true
        recorder = nil
        vad = nil
        phase = .recognizing
        errorText = ""
        let samples = rec.stop()
        Task { @MainActor in
            await process(samples)
        }
    }

    private func process(_ samples: [Float]) async {
        // 静音兜底：没说到话不算一次尝试
        var peak: Float = 0
        var i = 0
        while i < samples.count {
            peak = max(peak, abs(samples[i]))
            i += 16
        }
        if peak < 0.01 {
            phase = .idle
            errorText = "没听到声音——离麦克风近一点再说一次"
            return
        }
        guard let creds = XfyunCredentialsStore.shared.creds(for: .asr) else {
            typedMode = true
            phase = .idle
            errorText = "未配置讯飞听写凭据，改用打字造句（到 设置 → 语音 可补配）"
            return
        }
        do {
            let text = try await transcribeSpeech(
                pcm: floatToPcm16Bytes(samples),
                language: .en_us,
                creds: creds
            )
            if text.isEmpty {
                phase = .idle
                errorText = "没识别出内容，再试一次（尽量用完整的英语句子）"
                return
            }
            transcript = text
            if textHitsTarget(text, word.word) {
                onPass()
            } else {
                phase = .miss
            }
        } catch {
            phase = .failed
            errorText = "语音识别失败：\((error as? LocalizedError)?.errorDescription ?? String(describing: error))"
        }
    }

    private func submitTyped() {
        guard typedVerdict == nil, !typed.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        let verdict = judgeCloze(
            typed,
            word.word,
            options: JudgeOptions(trap: word.trap, accepted: [word.word])
        )
        if verdict == .perfect || verdict == .close {
            onPass()
            return
        }
        typedVerdict = verdict
    }

    private func retry() {
        phase = .idle
        transcript = ""
        errorText = ""
        typedVerdict = nil
        typed = ""
        finishing = false
    }
}

// MARK: - 卡片小件

private struct VaultCardMeta: View {
    let pill: String
    let tone: Color
    let source: String
    let pos: Int
    let total: Int
    let palette: ReaderPalette

    var body: some View {
        HStack(spacing: 8) {
            Text(pill)
                .font(.system(size: 10.5, weight: .bold))
                .foregroundColor(tone)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(tone.opacity(0.15))
                .clipShape(Capsule())
            Text(source)
                .font(.system(size: 11))
                .foregroundColor(palette.textTertiary)
            Spacer()
            Text("\(min(pos + 1, max(total, 1))) / \(max(total, 1))")
                .font(.system(size: 11).monospacedDigit())
                .foregroundColor(palette.textTertiary)
        }
    }
}

private struct VaultVerdictPanel<Content: View>: View {
    let verdict: RecallVerdict
    let palette: ReaderPalette
    var onJump: (() -> Void)?
    @ViewBuilder let content: Content

    private var color: Color {
        switch verdict {
        case .perfect: return palette.ok
        case .close: return palette.warn
        case .trap: return palette.err
        case .wrong: return palette.err
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verdict.headline)
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundColor(color)
            content
            if let onJump {
                Button("回到原文", action: onJump)
                    .buttonStyle(.link)
                    .font(.system(size: 11.5))
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

private struct VaultGradeBar: View {
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
                    button(grade: grade, key: "\(index + 1)", suggested: suggest == grade)
                }
            }
            Text("↩ 采纳「\(suggest?.label ?? "")」档 · 1–4 改选")
                .font(.system(size: 10.5))
                .foregroundColor(palette.textTertiary)
        }
    }

    private func button(grade: ReviewGrade, key: String, suggested: Bool) -> some View {
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

// MARK: - 模式 3：Markdown 笔记导出（ReaderCore VaultExport.buildVaultMarkdown 的界面壳）

struct VaultMarkdownExport: View {
    @ObservedObject var vm: ReaderViewModel
    let onOpenNotes: () -> Void
    @Environment(\.readerPalette) private var palette
    @State private var copied = false
    /// 复制反馈代数：连点时只有最后一次点击的复位生效（2.4s 从最后一次复制算起）。
    @State private var copyToken = 0

    private var markdown: String {
        buildVaultMarkdown(
            words: vm.vocabWords,
            sourceSentence: { vm.sourceSentence(articleId: $0, sentenceIdx: $1) },
            speakSessions: vm.speakSessions,
            dateKey: dayKey(nowMs: Int64(Date().timeIntervalSince1970 * 1000))
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Markdown 结构化学习笔记（可直接复制进 Notion / Obsidian）")
                        .font(readerFont(15.5, .semibold, pair: vm.effectiveSettings.fontPair))
                        .foregroundColor(palette.text)
                    Text("自动汇总自阅读查词、口语表达改进与发音诊断")
                        .font(.system(size: 11.5))
                        .foregroundColor(palette.textTertiary)
                }
                Spacer()
                Button {
                    onOpenNotes()
                } label: {
                    Label("笔记库回看", systemImage: "books.vertical")
                        .font(.system(size: 11.5))
                }
                .controlSize(.small)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(markdown, forType: .string)
                    copied = true
                    copyToken += 1
                    let token = copyToken
                    Task {
                        try? await Task.sleep(nanoseconds: 2_400_000_000)
                        guard token == copyToken else { return } // 期间又复制过：由后一次计时复位
                        copied = false
                    }
                } label: {
                    Label(copied ? "已复制" : "复制 Markdown", systemImage: copied ? "checkmark" : ReaderIcons.copy)
                        .font(.system(size: 11.5))
                }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
            }

            ScrollView {
                Text(markdown)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(palette.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
        }
    }
}

// MARK: - 右侧：我的内化看板（Windows InternalizationDashboard）

private struct VaultDashboard: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    private var due: [VocabWord] { vm.dueWords }

    private var stageCounts: MasteryStageCounts {
        masteryStageCounts(vm.vocabWords)
    }

    /// 易错词：错题（wrong+trap）最多的前 3 个，按错题数降序（ReaderCore weakVocab）。
    private var weakWords: [(word: VocabWord, bad: Int)] {
        weakVocab(vm.vocabWords, limit: 3)
    }

    var body: some View {
        let stats = vm.stats
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("我的内化看板")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundColor(palette.text)
                Spacer()
                Text("连续 \(stats.streak) 天")
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundColor(palette.textTertiary)
            }

            // 今日内化进度
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("今日内化进度")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(palette.textTertiary)
                    Spacer()
                    Text("\(stats.reviewedToday) / \(stats.reviewedToday + due.count) 项已完成")
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundColor(palette.textSecondary)
                }
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(palette.border.opacity(0.3))
                        let total = stats.reviewedToday + due.count
                        Capsule()
                            .fill(palette.accent)
                            .frame(width: geo.size.width * CGFloat(total > 0 ? Double(stats.reviewedToday) / Double(total) : 0))
                    }
                }
                .frame(height: 6)
                let dueSpoken = due.filter { $0.spokenAt != nil }.count
                Text("剩余 \(due.count) 项待过关 · 其中 \(dueSpoken) 项已在口语对谈中用出")
                    .font(.system(size: 10.5))
                    .foregroundColor(palette.textTertiary)
            }

            // 词块内化三阶段
            VStack(alignment: .leading, spacing: 6) {
                Text("词块内化三阶段（看见自己的积累）")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(palette.textTertiary)
                ForEach(MasteryStage.allCases, id: \.self) { stage in
                    stageRow(stage: stage, count: stageCounts[stage])
                }
            }

            // 近 28 天学习足迹
            VStack(alignment: .leading, spacing: 6) {
                let buckets = heatBuckets(vm.reviewLog, nowMs: Int64(Date().timeIntervalSince1970 * 1000))
                let attended = buckets.filter { $0.count > 0 }.count
                HStack {
                    Text("近 28 天学习足迹")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(palette.textTertiary)
                    Spacer()
                    Text("出勤 \(attended) 天")
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundColor(palette.textSecondary)
                }
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 14), spacing: 3) {
                    ForEach(buckets, id: \.dayKey) { bucket in
                        RoundedRectangle(cornerRadius: 2)
                            .fill(heatColor(bucket.level))
                            .frame(height: 12)
                            .overlay(
                                RoundedRectangle(cornerRadius: 2)
                                    .strokeBorder(bucket.isToday ? palette.accent : .clear, lineWidth: 1.5)
                            )
                            .help("\(bucket.dayKey) · 复习 \(bucket.count) 次")
                            .accessibilityLabel("\(bucket.dayKey)\(bucket.isToday ? "（今天）" : "") 复习 \(bucket.count) 次")
                    }
                }
            }

            // 易错项靶向加练
            VStack(alignment: .leading, spacing: 8) {
                Text("易错项靶向加练")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(palette.textTertiary)
                if weakWords.isEmpty {
                    Text("暂无错题记录——保持复习，错题会出现在这里。")
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                } else {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(weakWords, id: \.word.id) { entry in
                            HStack(spacing: 4) {
                                Text("•")
                                Text(entry.word.word).fontWeight(.semibold)
                                Text("（错题 \(entry.bad) 次）")
                            }
                            .font(.system(size: 11.5))
                            .foregroundColor(palette.textSecondary)
                        }
                    }
                    Button {
                        vm.startFocusReview(ids: weakWords.map(\.word.id))
                    } label: {
                        Text("1 分钟只练这 \(weakWords.count) 个易错项")
                            .font(.system(size: 11.5, weight: .semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    Button("去口语里加练 →") {
                        if let first = weakWords.first {
                            vm.practiceVocabSpeak(first.word)
                        }
                    }
                        .buttonStyle(.link)
                        .font(.system(size: 11.5))
                }
            }
        }
        // M-05：看板套玻璃材质阶梯（14 圆角 + blur + shadow-pill），三套皮肤
        // 不再只换颜色。
        .padding(16)
        .glassCard(palette: palette, radius: 14)
    }

    private func stageRow(stage: MasteryStage, count: Int) -> some View {
        HStack {
            Text(stage.dashboardLabel)
                .font(.system(size: 11))
                .foregroundColor(palette.textSecondary)
            Spacer()
            VaultStagePill(stage: stage, palette: palette)
                .scaleEffect(0.9, anchor: .trailing)
            Text("\(count) 词")
                .font(.system(size: 11, weight: .semibold).monospacedDigit())
                .foregroundColor(palette.text)
        }
    }

    private func heatColor(_ level: Int) -> Color {
        switch level {
        case 0: return palette.surfaceAlt
        case 1: return palette.sonicTeal.opacity(0.25)
        case 2: return palette.sonicTeal.opacity(0.52)
        default: return palette.sonicTeal
        }
    }
}
