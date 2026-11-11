import AppKit
import SwiftUI
import ReaderCore
import XfyunCore

// MARK: - 「笔记与复习」四态容器（2026-10-26 改版，VaultPage.tsx 的 Mac 对应物）
//
// 三栏 rail | stage | board；专注态（focus）rail/board 与顶栏中岛隐藏、单列居中。
// 四态（VaultPlayMode）：home 复习首页（stage-head + 开始复习 Hero + 待复习胶带列表）·
// notes 全部笔记（stage 内嵌既有 ReaderNotesView）· focus 专注复习（退出 Esc + 进度条 +
// 轮转三卡）· export 导出（范围预过滤 + 包含 chips 只作用于预览 + 预览/源码 seg）。
// 业务语义零改动：评分链 vm.gradeVocab / vm.gradeSpoken / recall 分桶逐字透传；
// 导出 buildVaultMarkdown 纯函数不改；队列语义（due = focusIds 或全局到期、评分即出队、
// Esc 退出只切档不清 focusIds）与 ReaderApp 完全一致。
// 数据全部来自真实存储（vocabWords / reviewLog / speak sessions），无演示常量。

struct ReaderVaultView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette
    /// rail 两组筛选（source × type 联合驱动首页列表；rail 自身只出计数不出现词面）。
    @State private var source: VaultSourceFilter = .all
    @State private var type: VaultTypeFilter = .all
    /// 首页胶带揭开态（entry id 集；点击揭开/再贴上反复自测）。
    @State private var peeled: Set<String> = []
    /// 首页「给点提示」已展开的条目。
    @State private var hinted: Set<String> = []
    /// 专注复习会话（队列/游标/轮转/防重入）。
    @StateObject private var focus = VaultFocusModel()

    var body: some View {
        ZStack(alignment: .bottom) {
            if vm.vaultPlayMode == .focus {
                focusLayout
            } else {
                wideLayout
            }
            vaultSwitchBar
        }
        .onAppear {
            focus.rebuild(vm: vm)
            installKeys()
        }
        .onDisappear {
            vm.reviewKeyHandler = nil
        }
        .onChange(of: vm.vaultPlayMode) { _ in
            installKeys()
            if vm.vaultPlayMode == .focus { focus.rebuild(vm: vm) }
        }
        .onChange(of: vm.focusReviewIds) { _ in
            // 加练批次变化（开口命中 drain、看板靶向加练、rail 退出）只换队列，
            // 会话进度（step/上一关结果/已评去重）保留——Windows 同语义。
            focus.rebuild(vm: vm)
        }
        .onChange(of: vm.vocabWords) { _ in
            focus.rebuild(vm: vm)
        }
    }

    // MARK: 宽态：三栏 rail | stage | board

    private var wideLayout: some View {
        HStack(alignment: .top, spacing: 0) {
            VaultRailView(vm: vm, source: $source, type: $type)
                .frame(width: 210)
                .frame(maxHeight: .infinity, alignment: .top)
            Divider().opacity(0.4)
            ScrollView {
                stage
                    .padding(20)
                    .frame(maxWidth: 760, alignment: .leading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider().opacity(0.4)
            ScrollView {
                VaultBoardView(vm: vm)
                    .padding(16)
            }
            .frame(width: 320)
            .frame(maxHeight: .infinity)
        }
        .padding(.bottom, 52)  // 底部快捷切换器让位
    }

    // MARK: 专注态：rail/board 隐藏、单列居中（Windows data-vault-view="focus"）

    private var focusLayout: some View {
        ScrollView {
            FocusStageView(vm: vm, focus: focus)
                .padding(.vertical, 18)
                .frame(maxWidth: 680, alignment: .leading)
                .frame(maxWidth: .infinity)
        }
        .padding(.bottom, 52)
    }

    // MARK: stage 分派（focus→FocusStage、export→ExportStage、否则 HomeStage）

    @ViewBuilder
    private var stage: some View {
        switch vm.vaultPlayMode {
        case .home, .notes:
            // HomeStage 同时承载 home / notes 两档（VaultPage.tsx:372-532）：stage-head
            //（seg「今日复习 / 全部笔记」+「导出笔记」）两档常驻；notes 档在其下内嵌笔记库，
            // 无 Hero / 胶带列表。
            HomeStageView(
                vm: vm,
                source: source,
                type: type,
                peeled: $peeled,
                hinted: $hinted
            )
        case .export:
            VaultExportStage(vm: vm)
        case .focus:
            EmptyView()
        }
    }

    // MARK: 底部快捷切换器（.vault-switch，aria「复习状态快捷切换」）

    private var vaultSwitchBar: some View {
        HStack(spacing: 2) {
            ForEach(
                [ReaderViewModel.VaultPlayMode.home, .focus, .export],
                id: \.self
            ) { mode in
                switchTab(mode)
            }
        }
        .padding(3)
        .background(Capsule().fill(palette.glassElevated))
        .overlay(Capsule().strokeBorder(palette.glassBorderStrong, lineWidth: 1))
        .shadow(color: palette.shadowPill, radius: 10, y: 4)
        .padding(.bottom, 10)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("复习状态快捷切换")
    }

    private func switchTab(_ mode: ReaderViewModel.VaultPlayMode) -> some View {
        let active = vm.vaultPlayMode == mode
        return Button {
            // focus 态常驻（等效「退出」）：只切档不清 focusIds，专注队列续跑。
            withAnimation(ReaderMotion.islandTab) { vm.vaultPlayMode = mode }
        } label: {
            Text(mode.switchLabel ?? "")
                .font(.system(size: 11.5, weight: active ? .semibold : .medium))
                .foregroundColor(active ? palette.onInk : palette.textSecondary)
                .padding(.horizontal, 12)
                .frame(height: 24)
                .background(Capsule().fill(active ? palette.text : Color.clear))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(mode.switchLabel ?? "")
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    // MARK: 键位（home Enter；focus Tab/H/Enter/1–3；Esc 退出由 vm.exitFocusModeOnEscape 统一处理）

    private func installKeys() {
        vm.reviewKeyHandler = { event in handleVaultKey(event) }
    }

    private func handleVaultKey(_ event: NSEvent) -> Bool {
        // typing 守卫看阅读室自己的窗口（与 vm.handleKeyDown 同源；NSApp.keyWindow 可能是别的窗）。
        let typing = ReaderViewModel.textInputHasFocus(in: vm.attachedWindow ?? NSApp.keyWindow)
        return Self.dispatchVaultKey(event, vm: vm, focus: focus, typing: typing)
    }

    /// 「笔记与复习」档位键位派发（静态可单测；Windows VaultPage.tsx:186-200,:807-854）：
    /// home 态 Enter = 开始复习（typing 守卫 + activeDue 非空）；focus 态交给
    /// VaultFocusModel.handleKey（Tab 不受 typing 守卫，由它逐键位施加）。
    static func dispatchVaultKey(_ event: NSEvent, vm: ReaderViewModel, focus: VaultFocusModel, typing: Bool) -> Bool {
        if vm.vaultPlayMode == .home {
            // due = activeDue：focusIds 非空时为该批词（ReaderApp.tsx:2067-2070）。
            guard !typing, event.keyCode == 36 || event.keyCode == 76, !vm.reviewQueue.isEmpty else { return false }
            withAnimation(ReaderMotion.islandTab) { vm.vaultPlayMode = .focus }
            return true
        }
        if vm.vaultPlayMode == .focus {
            return focus.handleKey(event, vm: vm, typing: typing)
        }
        return false
    }
}

// MARK: - 左栏 rail（VocabListPanel.tsx VaultRail 的 Mac 对应物）
//
// 内容来源组（全部 / 各文章《title》 / 划词收藏 / 口语纠偏，带计数）× 类型组
// （单词 / 词块 / 短语，toggle 取消）。rail DOM 不出现任何词面（防泄答案）；
// 未整理提示 + 「去处理」；加练横幅「剩 N」+ 退出。

struct VaultRailView: View {
    @ObservedObject var vm: ReaderViewModel
    @Binding var source: VaultSourceFilter
    @Binding var type: VaultTypeFilter
    @Environment(\.readerPalette) private var palette

    private var counts: VaultRailCounts {
        vaultRailCounts(
            due: vm.reviewQueue,
            speakSessions: vm.speakSessions,
            articleTitle: { vm.articleTitle(articleId: $0) }
        )
    }

    /// 来源分组标签：标题解析得到 →《title》；解析不到（原文已删）→「原文不可用 · N」
    /// 序号区分多组（对齐 Windows VocabListPanel VaultRail 的 unavailable 计数），
    /// 不再误标「未命名文章」。
    private static func sourceGroupLabels(
        _ groups: [VaultRailCounts.ArticleGroup]
    ) -> [(id: String, label: String, count: Int)] {
        var unavailable = 0
        return groups.map { g in
            if let title = g.title, !title.isEmpty {
                return (g.id, "《\(title)》", g.count)
            }
            unavailable += 1
            return (g.id, "\(vaultSourceUnavailableLabel) · \(unavailable)", g.count)
        }
    }

    var body: some View {
        let counts = counts
        let groupLabels = Self.sourceGroupLabels(counts.articleGroups)
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                if let focusCount = vm.focusReviewIds?.count, focusCount > 0 {
                    focusBanner(focusCount)
                }
                sectionTitle("内容来源 · 待复习")
                railItem(label: "全部", count: counts.total, active: source == .all) {
                    source = .all
                }
                ForEach(groupLabels, id: \.id) { group in
                    railItem(
                        label: group.label,
                        count: group.count,
                        active: source == .article(group.id)
                    ) {
                        source = .article(group.id)
                    }
                }
                railItem(label: "划词收藏", count: counts.popupCount, active: source == .popup) {
                    source = .popup
                }
                railItem(label: "口语纠偏", count: counts.speakCount, active: source == .speak) {
                    source = .speak
                }
                sectionTitle("类型 · 待复习")
                railItem(label: "单词", count: counts.wordCount, active: type == .word, pressed: true) {
                    // toggle 取消：再点同一档回全部（VocabListPanel.tsx:103-113）。
                    type = type == .word ? .all : .word
                }
                railItem(label: "词块 / 短语", count: counts.chunkCount, active: type == .chunk, pressed: true) {
                    type = type == .chunk ? .all : .chunk
                }
                if vm.vocabWords.isEmpty {
                    Text("在阅读里查词收藏，复习从这里开始。")
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                        .padding(.top, 10)
                }
                if vm.unnotedWordCount > 0 {
                    railNote(count: vm.unnotedWordCount)
                }
            }
            .padding(14)
        }
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10.5, weight: .semibold))
            .foregroundColor(palette.textTertiary)
            .padding(.top, 10)
            .padding(.bottom, 4)
    }

    private func railItem(label: String, count: Int, active: Bool, pressed: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(label)
                    .font(.system(size: 11.5, weight: active ? .semibold : .medium))
                    .foregroundColor(active ? palette.text : palette.textSecondary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text("\(count)")
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundColor(palette.textTertiary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(active ? palette.accentSoft : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label + "，\(count) 条")
        .accessibilityAddTraits(active && pressed ? [.isSelected] : [])
    }

    /// 加练横幅：剩 N + 退出（退出回全局到期队列，Windows onExitFocus）。
    private func focusBanner(_ count: Int) -> some View {
        HStack {
            Text("加练 · 只测笔记仍错词（剩 \(count)）")
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundColor(palette.warn)
                .lineLimit(1)
            Spacer(minLength: 6)
            Button("退出") {
                vm.exitFocus()
            }
            .font(.system(size: 10.5, weight: .semibold))
            .buttonStyle(.link)
            .help("回到全部到期队列")
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(palette.warnSoft))
        .padding(.bottom, 6)
    }

    /// 未整理提示：有 N 条内容未整理，可能不是词汇（如命令行）。+ 去处理。
    private func railNote(count: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("有 \(count) 条内容未整理，可能不是词汇（如命令行）。")
                .font(.system(size: 10.5))
                .foregroundColor(palette.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            Button("去处理") {
                vm.openNoteDialog()
            }
            .font(.system(size: 10.5, weight: .semibold))
            .buttonStyle(.link)
        }
        .padding(.top, 10)
    }
}

// MARK: - 复习首页（HomeStage：stage-head + Hero + 胶带列表；notes 档内嵌笔记库）

private struct HomeStageView: View {
    @ObservedObject var vm: ReaderViewModel
    let source: VaultSourceFilter
    let type: VaultTypeFilter
    @Binding var peeled: Set<String>
    @Binding var hinted: Set<String>
    @Environment(\.readerPalette) private var palette

    /// 列表条目：到期队列（已按 dueAt 排序）+ 口语纠偏轮。
    /// due = activeDue：focusIds 非空时为该批词（无视到期），Esc 回首页仍显示加练批次。
    private var entries: [VaultListEntry] {
        buildVaultListEntries(
            due: vm.reviewQueue,
            speakSessions: vm.speakSessions,
            sourceSentence: { vm.sourceSentence(articleId: $0, sentenceIdx: $1) },
            articleTitle: { vm.articleTitle(articleId: $0) }
        )
    }

    private var visible: [VaultListEntry] {
        filterVaultListEntries(entries, source: source, type: type)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            stageHead
            if vm.vaultPlayMode == .notes {
                // notes 档：`.vault-notes-embed` 内嵌既有笔记库（VaultPage.tsx:462-464），
                // 无 Hero / 胶带列表。
                ReaderNotesView(vm: vm)
                    .frame(minHeight: 520)
            } else {
                hero
                listSection
            }
        }
    }

    // MARK: stage-head（seg 双档 + 导出笔记）

    private var stageHead: some View {
        HStack(spacing: 12) {
            HStack(spacing: 2) {
                segButton("今日复习", active: vm.vaultPlayMode == .home) {
                    vm.vaultPlayMode = .home
                }
                segButton("全部笔记", active: vm.vaultPlayMode == .notes) {
                    vm.vaultPlayMode = .notes
                }
            }
            .padding(2)
            .background(Capsule().fill(palette.background))
            .overlay(Capsule().strokeBorder(palette.glassBorder, lineWidth: 1))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("笔记与复习档位")
            Spacer(minLength: 8)
            Button {
                vm.vaultPlayMode = .export
            } label: {
                Label("导出笔记", systemImage: "arrow.down.doc")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundColor(palette.text)
                    .padding(.horizontal, 10)
                    .frame(height: 26)
                    .background(Capsule().strokeBorder(palette.glassBorderStrong, lineWidth: 1))
            }
            .buttonStyle(.plain)
        }
    }

    private func segButton(_ title: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 11.5, weight: active ? .semibold : .medium))
                .foregroundColor(active ? palette.text : palette.textTertiary)
                .padding(.horizontal, 12)
                .frame(height: 24)
                .background {
                    if active {
                        Capsule()
                            .fill(palette.glassElevated)
                            .shadow(color: Color.black.opacity(0.08), radius: 3, y: 1)
                    }
                }
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    // MARK: 开始复习 Hero

    private var hero: some View {
        let due = vm.reviewQueue
        let total = due.count
        let minutes = vaultMinutes(total)
        let chips = vaultHeroModeChips(
            due: due,
            sourceSentence: { vm.sourceSentence(articleId: $0, sentenceIdx: $1) }
        )
        return HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text(total > 0 ? "今天有 \(total) 条要复习" : "今天没有要复习的了")
                    .font(readerFont(19, .semibold, pair: vm.effectiveSettings.fontPair))
                    .foregroundColor(palette.text)
                Text(total > 0
                    ? "预计 \(minutes) 分钟 · 都是你最近读到、收藏过的表达"
                    : "到期的表达会按记忆曲线回来——明天再来，或去阅读室继续攒新词。")
                    .font(.system(size: 12))
                    .foregroundColor(palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    modeChip("填空", on: chips.cloze && total > 0)
                    modeChip("听音", on: chips.dictation && total > 0)
                    modeChip("开口", on: total > 0)
                }
            }
            Spacer(minLength: 12)
            VStack(alignment: .trailing, spacing: 5) {
                Button {
                    withAnimation(ReaderMotion.islandTab) { vm.vaultPlayMode = .focus }
                } label: {
                    Label("开始复习", systemImage: ReaderIcons.play)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 16)
                        .frame(height: 32)
                        .background(Capsule().fill(total > 0 ? palette.accent : palette.ink4))
                }
                .buttonStyle(.plain)
                .disabled(total == 0)
                .help(total > 0 ? "进入专注复习" : "今天没有要复习的了")
                if total > 0 {
                    Text("按 Enter 也可以开始")
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(palette.glassSurface.opacity(0.6)))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(palette.glassBorder, lineWidth: 1))
    }

    private func modeChip(_ text: String, on: Bool) -> some View {
        Text(text)
            .font(.system(size: 10.5, weight: on ? .semibold : .medium))
            .foregroundColor(on ? palette.accent : palette.textTertiary)
            .padding(.horizontal, 8)
            .padding(.vertical, 2.5)
            .background(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(on ? palette.accentSoft : palette.glassBorder.opacity(0.4))
            )
    }

    // MARK: 待复习胶带列表

    private var anyPeeled: Bool { visible.contains { peeled.contains($0.id) } }

    private var listSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("先自己想一想，点胶带看答案")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(palette.textSecondary)
                Spacer(minLength: 8)
                if !visible.isEmpty {
                    Button(anyPeeled ? "全部盖住" : "全部揭开") {
                        peeled = anyPeeled ? [] : Set(visible.map(\.id))
                    }
                    .font(.system(size: 11.5))
                    .buttonStyle(.link)
                }
            }
            if visible.isEmpty {
                Text("这个筛选下还没有条目。在阅读里查词收藏、或去口语里练几轮，条目会出现在这里。")
                    .font(.system(size: 12))
                    .foregroundColor(palette.textTertiary)
                    .padding(.vertical, 28)
                    .frame(maxWidth: .infinity)
            } else {
                ForEach(visible) { entry in
                    if entry.kind == .word, let word = entry.word {
                        VaultWordItemRow(
                            entry: entry,
                            word: word,
                            peeled: peeled.contains(entry.id),
                            hinted: hinted.contains(entry.id),
                            palette: palette,
                            fontPair: vm.effectiveSettings.fontPair,
                            onToggle: { toggle(&peeled, entry.id) },
                            onToggleHint: { toggle(&hinted, entry.id) },
                            onGrade: { grade in vm.gradeVocab(word, grade, mode: .recognition, verdict: nil) },
                            onSpeakSentence: { vm.speakRecallSentence($0) },
                            onSpeakWord: { vm.speakWord($0) },
                            onPractice: { vm.practiceVocabSpeak(word) }
                        )
                    } else {
                        VaultSpeakItemRow(
                            entry: entry,
                            peeled: peeled.contains(entry.id),
                            palette: palette,
                            onToggle: { toggle(&peeled, entry.id) },
                            onSpeak: { vm.speakWord($0) }
                        )
                    }
                    Rectangle().fill(palette.glassBorder).frame(height: 1)
                }
            }
        }
    }

    private func toggle(_ set: inout Set<String>, _ id: String) {
        if set.contains(id) { set.remove(id) } else { set.insert(id) }
    }
}

// MARK: - 首页词条行（VaultWordItem：防剧透——未揭开时译文/释义/评分带一律不渲染）

private struct VaultWordItemRow: View {
    let entry: VaultListEntry
    let word: VocabWord
    let peeled: Bool
    let hinted: Bool
    let palette: ReaderPalette
    let fontPair: ReaderFontPair
    let onToggle: () -> Void
    let onToggleHint: () -> Void
    let onGrade: (ReviewGrade) -> Void
    let onSpeakSentence: (String) -> Void
    let onSpeakWord: (String) -> Void
    let onPractice: () -> Void

    private var gloss: String {
        word.senses
            .map { $0.pos.isEmpty ? $0.cn : "\($0.pos) \($0.cn)" }
            .joined(separator: "；")
    }

    private var wordCount: Int {
        entry.blank.trimmingCharacters(in: .whitespaces)
            .split(separator: " ").count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(word.kind == .chunk ? "词块" : "单词")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(palette.accent)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1.5)
                    .background(Capsule().fill(palette.accentSoft))
                Text(entry.sourceLabel)
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
                Spacer(minLength: 0)
            }
            // 原句行：pre + 胶带（blank）+ post。
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text(entry.pre)
                VaultTapeChip(
                    text: entry.blank,
                    hint: "\(word.senses.first?.cn ?? word.word)（\(firstLetters(entry.blank))）",
                    peeled: peeled,
                    palette: palette,
                    action: onToggle
                )
                .padding(.horizontal, 3)
                Text(entry.post)
            }
            .font(readerFont(15, .regular, pair: fontPair))
            .foregroundColor(palette.text)
            .lineSpacing(4)
            .fixedSize(horizontal: false, vertical: true)

            // 防剧透：未揭开时译文/词典行/评分带一律不渲染（VaultPage.tsx:585）。
            if peeled {
                VStack(alignment: .leading, spacing: 6) {
                    if let zh = entry.sentenceZh, !zh.isEmpty {
                        Text(zh)
                            .font(.system(size: 12))
                            .foregroundColor(palette.textTertiary)
                    }
                    Text(gloss.isEmpty ? word.word : "\(word.word) · \(gloss)")
                        .font(.system(size: 12.5))
                        .foregroundColor(palette.text)
                        .fixedSize(horizontal: false, vertical: true)
                    VaultGradeBandRow(palette: palette, onGrade: onGrade)
                }
            }

            HStack(spacing: 10) {
                if !peeled {
                    Button(action: onToggleHint) {
                        Label("给点提示", systemImage: "questionmark.circle")
                            .font(.system(size: 11))
                    }
                    .buttonStyle(.link)
                    .accessibilityAddTraits(hinted ? [.isSelected] : [])
                }
                if hinted, !peeled {
                    // 提示行不露答案本身（首字母截断）。
                    Text("首字母：\(firstLetters(entry.blank))（\(wordCount) 词）")
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                }
                Spacer(minLength: 0)
                Button {
                    if let en = entry.sentenceEn, !en.isEmpty {
                        onSpeakSentence(en)
                    } else {
                        onSpeakWord(word.word)
                    }
                } label: {
                    Label("听原句", systemImage: ReaderIcons.speaker)
                        .font(.system(size: 11))
                }
                .buttonStyle(.link)
                Button(action: onPractice) {
                    Label("去口语里用一次", systemImage: "mic")
                        .font(.system(size: 11))
                }
                .buttonStyle(.link)
            }
        }
        .padding(.vertical, 12)
    }
}

// MARK: - 首页口语纠偏行（VaultSpeakItem：原话 + diff；无评分带）

private struct VaultSpeakItemRow: View {
    let entry: VaultListEntry
    let peeled: Bool
    let palette: ReaderPalette
    let onToggle: () -> Void
    let onSpeak: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("口语纠偏")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(palette.clauseIndigo)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1.5)
                    .background(Capsule().fill(palette.clauseIndigoSoft))
                Text(entry.dateLabel)
                    .font(.system(size: 11))
                    .monospacedDigit()
                    .foregroundColor(palette.textTertiary)
                Spacer(minLength: 0)
            }
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text("你原本说：\(entry.original)")
                    .font(.system(size: 12.5))
                    .foregroundColor(palette.textTertiary)
                Text(" → 地道说法：")
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundColor(palette.textSecondary)
                segsView
            }
            .fixedSize(horizontal: false, vertical: true)

            // 揭开后 note 展示；无评分带（VaultPage.tsx:679）。
            if peeled, let note = entry.note, !note.isEmpty {
                Text(note)
                    .font(.system(size: 12))
                    .foregroundColor(palette.textTertiary)
            }

            HStack {
                Spacer(minLength: 0)
                Button {
                    onSpeak(entry.better)
                } label: {
                    Label("听地道说法", systemImage: ReaderIcons.speaker)
                        .font(.system(size: 11))
                }
                .buttonStyle(.link)
            }
        }
        .padding(.vertical, 12)
    }

    /// diff 渲染：del 删除线 / ins 胶带 / keep 原样。
    @ViewBuilder
    private var segsView: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            ForEach(Array(entry.segs.enumerated()), id: \.offset) { _, seg in
                switch seg.t {
                case .del:
                    Text(seg.v)
                        .strikethrough()
                        .font(.system(size: 13))
                        .foregroundColor(palette.textTertiary.opacity(0.6))
                case .ins:
                    VaultTapeChip(
                        text: seg.v,
                        hint: "新说法（\(firstLetters(seg.v))）",
                        peeled: peeled,
                        palette: palette,
                        action: onToggle
                    )
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

/// 琥珀胶带（.memory-tape）：默认遮盖（覆盖层带释义+首字母提示），点击揭开/再贴上。
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

/// 三档评分带（VaultGradeBandRow）：没记住 / 有点模糊 / 记住了 + vaultNextLabel 副行；
/// 建议档高亮；title 快捷键 1–3。
struct VaultGradeBandRow: View {
    let palette: ReaderPalette
    var suggested: ReviewGrade? = nil
    let onGrade: (ReviewGrade) -> Void

    var body: some View {
        HStack(spacing: 8) {
            ForEach(vaultGradeBands, id: \.grade) { band in
                bandButton(band)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("评分")
    }

    private func bandButton(_ band: VaultGradeBand) -> some View {
        Button {
            onGrade(band.grade)
        } label: {
            VStack(spacing: 1) {
                Text(band.name)
                    .font(.system(size: 12, weight: suggested == band.grade ? .semibold : .medium))
                    .foregroundColor(palette.text)
                Text(vaultNextLabel(band.grade))
                    .font(.system(size: 9.5))
                    .foregroundColor(palette.textTertiary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity)
            .background(suggested == band.grade ? palette.accent.opacity(0.12) : palette.surfaceAlt)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(suggested == band.grade ? palette.accent : palette.border, lineWidth: suggested == band.grade ? 1.6 : 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("快捷键 \(band.key)")
    }
}

// MARK: - 专注复习（FocusStage：退出 Esc + 进度条 + 轮转三卡）

private struct FocusStageView: View {
    @ObservedObject var vm: ReaderViewModel
    @ObservedObject var focus: VaultFocusModel
    @Environment(\.readerPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            focusTop
            if let outcome = focus.session.outcome {
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
                .accessibilityElement(children: .combine)
            }
            if let word = focus.current {
                card(word)
            } else {
                donePanel
            }
        }
        .onChange(of: focus.current?.id) { _ in
            focus.resetCard()
            focus.autoSpeakDictationIfNeeded(vm: vm)
        }
    }

    /// focus-top：退出 Esc + 进度条 + n/m。
    private var focusTop: some View {
        let total = focus.queue.count
        let percent = VaultFocusSession.progressPercent(pos: focus.pos, total: total)
        return HStack(spacing: 10) {
            Button {
                withAnimation(ReaderMotion.islandTab) { vm.vaultPlayMode = .home }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: ReaderIcons.close).font(.system(size: 10, weight: .semibold))
                    Text("退出")
                    Text("Esc")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(palette.glassBorder)
                        .clipShape(RoundedRectangle(cornerRadius: 3))
                }
                .font(.system(size: 11.5, weight: .medium))
                .foregroundColor(palette.textSecondary)
            }
            .buttonStyle(.plain)
            .help("退出专注复习（专注队列保留）")
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(palette.glassBorderStrong)
                    Capsule()
                        .fill(palette.accent)
                        .frame(width: max(0, geo.size.width * CGFloat(percent) / 100))
                        .animation(ReaderMotion.islandTab, value: percent)
                }
            }
            .frame(height: 5)
            Text(VaultFocusSession.counterText(pos: focus.pos, total: total))
                .font(.system(size: 11).monospacedDigit())
                .foregroundColor(palette.textTertiary)
        }
    }

    @ViewBuilder
    private func card(_ word: VocabWord) -> some View {
        let sourceLabel = vaultFocusSourceLabel(
            articleId: word.source.articleId,
            articleTitle: vm.articleTitle(articleId: word.source.articleId)
        )
        switch focus.effectiveKind(vm: vm) {
        case .cloze:
            VaultFocusClozeCard(
                word: word,
                spec: focus.spec(vm: vm),
                input: $focus.input,
                hints: focus.hints,
                verdict: focus.verdict,
                sourceLabel: sourceLabel,
                palette: palette,
                fontPair: vm.effectiveSettings.fontPair,
                onHint: { focus.hints = min(2, focus.hints + 1) },
                onSubmit: { focus.submitCloze(vm: vm) },
                onGiveUp: { focus.verdict = .wrong },
                onJump: {
                    vm.jumpToSource(articleId: word.source.articleId, sentenceIdx: word.source.sentenceIdx)
                },
                onGrade: { focus.grade($0, vm: vm) }
            )
        case .dictation:
            VaultChallengeDictationCard(
                word: word,
                source: focus.source(vm: vm),
                input: $focus.input,
                verdict: focus.verdict,
                replays: focus.replays,
                pos: focus.pos,
                total: focus.queue.count,
                sourceLabel: sourceLabel,
                palette: palette,
                onReplay: { focus.replayDictation(vm: vm) },
                onSubmit: { focus.submitDictation(vm: vm) },
                onGiveUp: { focus.verdict = .wrong },
                onJump: {
                    vm.jumpToSource(articleId: word.source.articleId, sentenceIdx: word.source.sentenceIdx)
                },
                onGrade: { focus.grade($0, vm: vm) }
            )
        case .speak:
            VaultSpeakChallengeCard(
                word: word,
                sample: focus.source(vm: vm)?.en,
                pos: focus.pos,
                total: focus.queue.count,
                sourceLabel: sourceLabel,
                palette: palette,
                fontPair: vm.effectiveSettings.fontPair,
                onPass: { focus.passSpeak(vm: vm) },
                onGiveUp: { focus.skip(vm: vm) },
                onSpeakSample: { vm.speakRecallSentence($0) }
            )
            .id(word.id)  // 换词重置录音/打字状态
        }
    }

    /// 完成态（队列空）：完成文案 + 副行 + 三按钮。
    private var donePanel: some View {
        VStack(spacing: 10) {
            Text(vm.stats.total == 0 ? "生词本还是空的" : "本轮复习完成 🎉")
                .font(.system(size: 17, weight: .semibold))
                .foregroundColor(palette.text)
            Text(vm.stats.total == 0
                ? "在阅读室里查词并点击「加入生词本」，复习卡会出现在这里。"
                : "这一批都过了。整理成笔记，或回阅读室继续攒新词。")
                .font(.system(size: 12.5))
                .foregroundColor(palette.textSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button("回复习首页") {
                    withAnimation(ReaderMotion.islandTab) { vm.vaultPlayMode = .home }
                }
                .controlSize(.small)
                Button("回阅读室") {
                    vm.openReading()
                }
                .controlSize(.small)
                Button("整理成笔记") {
                    vm.openNoteDialog()
                }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(.vertical, 48)
        .frame(maxWidth: .infinity)
    }
}

// MARK: - 专注会话模型（队列 / 游标 / 轮转 / 防重入；可单测）

@MainActor
final class VaultFocusModel: ObservableObject {
    @Published var session = VaultFocusSession()
    @Published var queue: [VocabWord] = []
    @Published var pos = 0
    // ---- 卡片内状态（每张卡重置） ----
    @Published var input = ""
    @Published var hints = 0
    @Published var verdict: RecallVerdict?
    @Published var replays = VaultFocusModel.dictationReplays
    /// 听写卡自动朗读去重。
    var spokeIds: Set<String> = []
    static let dictationReplays = 3

    var current: VocabWord? {
        queue.indices.contains(pos) ? queue[pos] : nil
    }

    /// 队列 = focusIds 批次或全局到期（vm.reviewQueue 同源）。
    func rebuild(vm: ReaderViewModel) {
        let next = vm.reviewQueue
        queue = next
        pos = VaultFocusSession.settledPos(pos, total: queue.count)
    }

    func resetCard() {
        input = ""
        hints = 0
        verdict = nil
        replays = Self.dictationReplays
    }

    // MARK: 形态与素材

    func source(vm: ReaderViewModel) -> (en: String, zh: String?)? {
        guard let word = current else { return nil }
        return ReaderVaultView.entrySource(word, vm: vm)
    }

    /// 当前卡实际形态（原句缺失降级开口；完形还需能定位到挖空范围）。
    func effectiveKind(vm: ReaderViewModel) -> VaultFocusCardKind {
        guard let word = current else { return .speak }
        let src = source(vm: vm)
        let blankFound = src.map { VaultFocusModel.blankRange($0.en, word.word) != nil } ?? false
        return vaultFocusEffectiveKind(
            desired: session.desiredKind,
            hasSentence: src?.en.isEmpty == false,
            blankFound: blankFound
        )
    }

    /// 完形 spec：pre/blank/post 切分。
    func spec(vm: ReaderViewModel) -> (sentence: String, zh: String?, pre: String, blank: String, post: String)? {
        guard let word = current, let src = source(vm: vm), !src.en.isEmpty,
              let range = VaultFocusModel.blankRange(src.en, word.word) else { return nil }
        return (
            sentence: src.en,
            zh: src.zh,
            pre: substring16(src.en, 0, range.start),
            blank: substring16(src.en, range.start, range.end),
            post: substring16(src.en, range.end, Array(src.en.utf16).count)
        )
    }

    static func blankRange(_ sentence: String, _ word: String) -> ReaderCore.TextRange? {
        findChunkRange(sentence, word)
    }

    // MARK: 提交 / 重播

    func submitCloze(vm: ReaderViewModel) {
        guard verdict == nil, let word = current, let spec = spec(vm: vm),
              !input.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        verdict = judgeCloze(
            input,
            spec.blank,
            options: JudgeOptions(trap: word.trap, accepted: [word.word])
        )
    }

    func submitDictation(vm: ReaderViewModel) {
        guard verdict == nil, let word = current, let src = source(vm: vm),
              !input.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        verdict = judgeDictation(input, src.en, options: JudgeOptions(trap: word.trap))
    }

    func replayDictation(vm: ReaderViewModel) {
        guard let src = source(vm: vm) else { return }
        if verdict == nil {
            guard replays > 0 else { return }
            replays -= 1
        }
        vm.speakRecallSentence(src.en)
    }

    /// 听写卡进入即自动朗读一次（word 音轨，不打断句子朗读）。
    func autoSpeakDictationIfNeeded(vm: ReaderViewModel) {
        guard let word = current, effectiveKind(vm: vm) == .dictation,
              let src = source(vm: vm), !spokeIds.contains(word.id) else { return }
        spokeIds.insert(word.id)
        vm.speakRecallSentence(src.en)
    }

    // MARK: 评分 / 开口 / 放弃

    /// 普通评分（三档带 / 听写四档带）：防重入 → 落盘（vm.gradeVocab 一条链含
    /// recall 分桶）→ 加练批次 drain → 词出队游标收拢。
    @discardableResult
    func grade(_ g: ReviewGrade, vm: ReaderViewModel) -> Bool {
        guard let word = current else { return false }
        // 先取本卡形态（session.grade 会推进 step，之后再算就成下一关的形态了）。
        let kind = effectiveKind(vm: vm)
        guard session.grade(wordId: word.id, word: word.word, grade: g) else { return false }
        let mode: RecallMode
        switch kind {
        case .cloze: mode = .cloze
        case .dictation: mode = .dictation
        case .speak: mode = .recognition
        }
        vm.gradeVocab(word, g, mode: mode, verdict: mode == .recognition ? nil : verdict)
        drain(word, vm: vm)
        return true
    }

    /// 开口卡命中目标词：easy 档 + spokenAt（vm.gradeSpoken）+ drain。
    @discardableResult
    func passSpeak(vm: ReaderViewModel) -> Bool {
        guard let word = current,
              session.passSpeak(wordId: word.id, word: word.word) else { return false }
        vm.gradeSpoken(word)
        drain(word, vm: vm)
        return true
    }

    /// 放弃（跳过不评分）：词不离队，游标手动推进（末尾回绕）。
    func skip(vm: ReaderViewModel) {
        guard let word = current else { return }
        pos = session.skip(word: word.word, pos: pos, total: queue.count)
    }

    /// 评分/开口后：词出队 + 加练批次同步 drain（Windows gradeAndDrainFocus）+
    /// 队列耗尽收拢 pos=0。
    private func drain(_ word: VocabWord, vm: ReaderViewModel) {
        queue.removeAll { $0.id == word.id }
        if vm.focusReviewIds != nil {
            vm.focusReviewIds = vm.focusReviewIds?.filter { $0 != word.id }
        }
        pos = VaultFocusSession.settledPos(pos, total: queue.count)
    }

    // MARK: 键位（Tab 下一级提示 / H 同 Tab / Enter 提交·采纳 / 1–3 直选；仅完形卡）

    func handleKey(_ event: NSEvent, vm: ReaderViewModel, typing: Bool) -> Bool {
        guard current != nil else { return false }
        // VaultPage.tsx:821 `if (effKind !== "cloze" || !spec || !current) return;`：
        // 听写卡 / 开口卡不接全局键——听写卡 Enter 由输入框自己提交、判分后只走四档
        // GradeFooter 点击（建议档可为 easy，不经 vaultSuggested 收敛）；开口卡走录音链。
        guard effectiveKind(vm: vm) == .cloze, spec(vm: vm) != nil else { return false }
        guard let key = event.charactersIgnoringModifiers?.lowercased() else { return false }
        // Tab 不受 typing 守卫：完形答题时它就是「下一级提示」。
        if event.keyCode == 48 {  // Tab
            if verdict == nil, hints < 2 {
                hints = min(2, hints + 1)
                return true
            }
            return false
        }
        guard !typing else { return false }
        if key == "h", verdict == nil, hints < 2 {
            hints = min(2, hints + 1)
            return true
        }
        if event.keyCode == 36 || event.keyCode == 76 {  // Return / 小键盘 Enter
            if verdict == nil {
                submitCloze(vm: vm)
                return true
            }
            // 已判分 → 采纳建议档（easy 收敛 good，不是 easy）。
            grade(vaultSuggested(verdict!), vm: vm)
            return true
        }
        if verdict != nil, ["1", "2", "3"].contains(key) {
            // 数字直选三档（VAULT_GRADE_BANDS key 契约）。
            if let band = vaultGradeBands.first(where: { $0.key == key }) {
                grade(band.grade, vm: vm)
                return true
            }
        }
        return false
    }
}

// MARK: - 专注完形卡（FocusCloze：26px 衬线大句 + 两级提示阶梯 + 三档评分带）

struct VaultFocusClozeCard: View {
    let word: VocabWord
    let spec: (sentence: String, zh: String?, pre: String, blank: String, post: String)?
    @Binding var input: String
    let hints: Int
    let verdict: RecallVerdict?
    let sourceLabel: String
    let palette: ReaderPalette
    let fontPair: ReaderFontPair
    let onHint: () -> Void
    let onSubmit: () -> Void
    let onGiveUp: () -> Void
    let onJump: () -> Void
    let onGrade: (ReviewGrade) -> Void
    /// 行内输入框焦点（Windows BlankInput autoFocus：进卡即聚焦）。
    @FocusState private var inputFocused: Bool

    private var graded: Bool { verdict != nil }
    private var wordCount: Int {
        (spec?.blank ?? "").trimmingCharacters(in: .whitespaces)
            .split(separator: " ").count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let spec {
                HStack(spacing: 8) {
                    Text("填空")
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundColor(palette.accent)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(palette.accentSoft))
                    Text(sourceLabel)
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                    Spacer(minLength: 0)
                }
                // 26px 衬线大句（Windows .q-sent）。
                sentence(spec)
                if !graded {
                    hintLadder(spec)
                } else if let verdict {
                    VaultVerdictPanel(verdict: verdict, palette: palette, onJump: onJump) {
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
                        Text(spec.blank + (spec.blank != word.word ? "（词条原形：\(word.word)）" : ""))
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(palette.text)
                    }
                    answerRowGraded(verdict: verdict)
                }
                if !graded {
                    answerRowPending
                }
                HStack {
                    Text("提示不会显示答案本身")
                    Spacer(minLength: 12)
                    Text("提交后选择「记住了 / 模糊 / 没记住」")
                }
                .font(.system(size: 10.5))
                .foregroundColor(palette.textTertiary)
            }
        }
        .padding(.vertical, 24)
        .padding(.horizontal, 28)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(palette.glassSurface)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(palette.glassBorderStrong, lineWidth: 1)
        )
        .shadow(color: palette.shadowPill, radius: 12, y: 6)
    }

    /// 大句：pre + 挖空（未答 = 行内输入框 BlankInput / 已判分 = 结果配色）+ post。
    /// 未答态用行内流布局把 pre 词、输入框、post 词排成可换行的一句（Windows `.q-sent`
    /// 里 `<BlankInput>` 是 inline 元素，与前后文同流）。
    @ViewBuilder
    private func sentence(_ spec: (sentence: String, zh: String?, pre: String, blank: String, post: String)) -> some View {
        let bigFont = readerFont(26, .regular, pair: fontPair)
        if let verdict {
            let color: Color = verdict == .perfect ? palette.ok : (verdict == .close ? palette.warn : palette.err)
            (Text(spec.pre + "　") + Text(spec.blank).foregroundColor(color).underline() + Text("　" + spec.post))
                .font(bigFont)
                .foregroundColor(palette.text)
                .lineSpacing(6)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            InlineFlowLayout(itemSpacing: 7, lineSpacing: 12) {
                ForEach(Array(Self.tokens(spec.pre).enumerated()), id: \.offset) { token in
                    Text(token.element).font(bigFont).foregroundColor(palette.text)
                }
                VaultBlankInput(
                    text: $input,
                    palette: palette,
                    fontPair: fontPair,
                    focused: $inputFocused,
                    onSubmit: onSubmit
                )
                ForEach(Array(Self.tokens(spec.post).enumerated()), id: \.offset) { token in
                    Text(token.element).font(bigFont).foregroundColor(palette.text)
                }
            }
            .onAppear { inputFocused = true }
            .onChange(of: word.id) { _ in inputFocused = true }
        }
    }

    /// 按空白切词（行内流的最小排版单元；空串不产出 token）。
    static func tokens(_ text: String) -> [String] {
        text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    }

    /// 两级提示阶梯（提示 1 整句译文 / 提示 2 首字母与长度；都不显示答案本身）。
    @ViewBuilder
    private func hintLadder(_ spec: (sentence: String, zh: String?, pre: String, blank: String, post: String)) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            hintStep(lv: "提示 1", shown: hints >= 1) {
                if let zh = spec.zh, !zh.isEmpty {
                    Text("译文：\(zh)")
                } else {
                    Text("这篇没有配译文")
                }
            } collapsed: {
                Text("整句译文")
            }
            hintStep(lv: "提示 2", shown: hints >= 2) {
                Text("首字母与长度：\(firstLetters(spec.blank))（\(wordCount) 词）")
            } collapsed: {
                Text("首字母与长度")
            }
        }
    }

    @ViewBuilder
    private func hintStep<Expanded: View, Collapsed: View>(
        lv: String,
        shown: Bool,
        @ViewBuilder expanded: () -> Expanded,
        @ViewBuilder collapsed: () -> Collapsed
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(lv)
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(palette.accent)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(palette.accent.opacity(0.1))
                .clipShape(Capsule())
            if shown {
                expanded()
                    .font(.system(size: 12))
                    .foregroundColor(palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                collapsed()
                    .font(.system(size: 12))
                    .foregroundColor(palette.textTertiary)
                Button("展开", action: onHint)
                    .font(.system(size: 11, weight: .semibold))
                    .buttonStyle(.link)
            }
        }
    }

    /// 未答操作行：提交 / 我不会 + 键位提示（Enter 提交 / Tab 下一级提示）。
    private var answerRowPending: some View {
        HStack(spacing: 10) {
            Button(action: onSubmit) {
                Text("提交")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundColor(.white)
                    .padding(.horizontal, 16)
                    .frame(height: 30)
                    .background(Capsule().fill(input.trimmingCharacters(in: .whitespaces).isEmpty ? palette.ink4 : palette.accent))
            }
            .buttonStyle(.plain)
            .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty)
            Button("我不会", action: onGiveUp)
                .font(.system(size: 12.5, weight: .medium))
                .buttonStyle(.bordered)
            HStack(spacing: 8) {
                keyHint("Enter", "提交")
                keyHint("Tab", "下一级提示")
            }
            Spacer(minLength: 0)
        }
    }

    /// 已判分操作行：三档评分带（建议档高亮）+ 键位 Enter {建议档} / 1–3 直选。
    private func answerRowGraded(verdict: RecallVerdict) -> some View {
        let suggest = vaultSuggested(verdict)
        let bandName = vaultGradeBands.first { $0.grade == suggest }?.name ?? ""
        return VStack(alignment: .leading, spacing: 8) {
            VaultGradeBandRow(palette: palette, suggested: suggest, onGrade: onGrade)
            HStack(spacing: 12) {
                keyHint("Enter", bandName)
                HStack(spacing: 3) {
                    keyCap("1")
                    Text("–")
                    keyCap("3")
                    Text("直选")
                }
                .font(.system(size: 10.5))
                .foregroundColor(palette.textTertiary)
            }
        }
    }

    private func keyHint(_ key: String, _ label: String) -> some View {
        HStack(spacing: 3) {
            keyCap(key)
            Text(label)
        }
        .font(.system(size: 10.5))
        .foregroundColor(palette.textTertiary)
    }

    private func keyCap(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .padding(.horizontal, 4).padding(.vertical, 1)
            .background(palette.glassBorder)
            .clipShape(RoundedRectangle(cornerRadius: 3))
    }
}

// MARK: - 导出（ExportStage：范围预过滤 + 包含 chips 只作用预览 + 预览/源码 seg）

struct VaultExportStage: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette
    @State private var scope: VaultExportScope = .week
    @State private var inclEx = true
    @State private var inclDef = true
    @State private var inclIpa = false
    @State private var inclNote = true
    @State private var tab: Tab = .preview
    @State private var copied = false
    @State private var copyToken = 0
    @State private var saveError: String?

    private enum Tab {
        case preview, source
    }

    private var dateKey: String {
        dayKey(nowMs: Int64(Date().timeIntervalSince1970 * 1000))
    }

    /// 范围筛选只在调用侧预过滤（buildVaultMarkdown 纯函数与三段结构零改动）。
    private var filteredWords: [VocabWord] {
        filterVaultExportWords(
            vm.vocabWords,
            scope: scope,
            nowMs: Int64(Date().timeIntervalSince1970 * 1000)
        )
    }

    private var filteredSessions: [SpeakSession] {
        filterVaultExportSessions(
            vm.speakSessions,
            scope: scope,
            nowMs: Int64(Date().timeIntervalSince1970 * 1000)
        )
    }

    private var markdown: String {
        buildVaultMarkdown(
            words: filteredWords,
            sourceSentence: { vm.sourceSentence(articleId: $0, sentenceIdx: $1) },
            speakSessions: filteredSessions,
            dateKey: dateKey
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            stageHead
            // `.exp > h2`（VaultPage.tsx:1219）：导出区标题。
            Text("导出学习笔记")
                .font(readerFont(20, .semibold, pair: vm.effectiveSettings.fontPair))
                .foregroundColor(palette.text)
                .accessibilityAddTraits(.isHeader)
            options
            if let saveError {
                Text("保存失败：\(saveError)")
                    .font(.system(size: 11.5))
                    .foregroundColor(palette.err)
            }
            tabBar
            switch tab {
            case .source:
                ScrollView {
                    Text(markdown)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundColor(palette.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: .infinity)
            case .preview:
                preview
            }
        }
    }

    /// stage-head：← 返回复习 + 复制 Markdown（已复制 2.4s）+ 保存为 .md。
    private var stageHead: some View {
        HStack(spacing: 10) {
            Button {
                withAnimation(ReaderMotion.islandTab) { vm.vaultPlayMode = .home }
            } label: {
                Text("← 返回复习")
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundColor(palette.textSecondary)
            }
            .buttonStyle(.plain)
            Spacer(minLength: 8)
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(markdown, forType: .string)
                copied = true
                copyToken += 1
                let token = copyToken
                Task {
                    try? await Task.sleep(nanoseconds: 2_400_000_000)
                    guard token == copyToken else { return }  // 连点：由后一次计时复位
                    copied = false
                }
            } label: {
                Label(copied ? "已复制" : "复制 Markdown", systemImage: copied ? "checkmark" : ReaderIcons.copy)
                    .font(.system(size: 11.5))
            }
            .controlSize(.small)
            Button {
                save()
            } label: {
                Label("保存为 .md", systemImage: "arrow.down.doc")
                    .font(.system(size: 11.5, weight: .semibold))
            }
            .controlSize(.small)
            .buttonStyle(.borderedProminent)
        }
    }

    /// 范围 / 包含 chips。
    private var options: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("范围")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundColor(palette.textSecondary)
                ForEach(VaultExportScope.allCases, id: \.self) { s in
                    chip(s.label, on: scope == s) { scope = s }
                }
            }
            HStack(spacing: 8) {
                Text("包含")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundColor(palette.textSecondary)
                chip("原句", on: inclEx) { inclEx.toggle() }
                chip("释义", on: inclDef) { inclDef.toggle() }
                chip("音标", on: inclIpa) { inclIpa.toggle() }
                chip("用法提示", on: inclNote) { inclNote.toggle() }
            }
        }
    }

    private func chip(_ text: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(text)
                .font(.system(size: 11, weight: on ? .semibold : .medium))
                .foregroundColor(on ? palette.onInk : palette.textSecondary)
                .padding(.horizontal, 10)
                .frame(height: 22)
                .background(Capsule().fill(on ? palette.text : palette.glassBorder.opacity(0.4)))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? [.isSelected] : [])
    }

    /// 预览/源码 seg + 共 N 条。
    private var tabBar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 2) {
                segTab("预览", active: tab == .preview) { tab = .preview }
                segTab("Markdown 源码", active: tab == .source) { tab = .source }
            }
            .padding(2)
            .background(Capsule().fill(palette.background))
            .overlay(Capsule().strokeBorder(palette.glassBorder, lineWidth: 1))
            Spacer(minLength: 8)
            Text("共 \(filteredWords.count) 条")
                .font(.system(size: 11).monospacedDigit())
                .foregroundColor(palette.textTertiary)
        }
    }

    private func segTab(_ title: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 11.5, weight: active ? .semibold : .medium))
                .foregroundColor(active ? palette.text : palette.textTertiary)
                .padding(.horizontal, 12)
                .frame(height: 24)
                .background {
                    if active {
                        Capsule()
                            .fill(palette.glassElevated)
                            .shadow(color: Color.black.opacity(0.08), radius: 3, y: 1)
                    }
                }
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    /// 预览（包含 chips 只作用于这一层，不影响 Markdown 源）：
    /// h3 `{dateKey} 英语精读笔记` + 词条 word / 音标（ipa 开）/ 释义 / 原句 / 用法。
    private var preview: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("\(dateKey) 英语精读笔记")
                    .font(.system(size: 15, weight: .semibold, design: .serif))
                    .foregroundColor(palette.text)
                ForEach(filteredWords) { w in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(w.word)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(palette.text)
                            if inclIpa, let phonetic = w.phonetic, !phonetic.isEmpty {
                                Text("/\(phonetic.trimmingCharacters(in: CharacterSet(charactersIn: "/")))/")
                                    .font(.system(size: 11))
                                    .foregroundColor(palette.textTertiary)
                            }
                            if inclDef {
                                let gloss = w.senses
                                    .map { $0.pos.isEmpty ? $0.cn : "\($0.pos) \($0.cn)" }
                                    .joined(separator: "；")
                                if !gloss.isEmpty {
                                    Text(gloss)
                                        .font(.system(size: 12))
                                        .foregroundColor(palette.textSecondary)
                                        .lineLimit(2)
                                }
                            }
                        }
                        if inclEx, let src = ReaderVaultView.entrySource(
                            w,
                            vm: vm
                        ), !src.en.isEmpty {
                            Text(src.en)
                                .font(.system(size: 12, design: .serif))
                                .italic()
                                .foregroundColor(palette.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if inclNote {
                            let usage = [w.pattern, w.trap].compactMap { $0 }.filter { !$0.isEmpty }
                            if !usage.isEmpty {
                                Text("用法：\(usage.joined(separator: " · "))")
                                    .font(.system(size: 11))
                                    .foregroundColor(palette.textTertiary)
                            }
                        }
                    }
                    .padding(.bottom, 4)
                }
                if filteredWords.isEmpty {
                    Text("这个范围内还没有可导出的词条。")
                        .font(.system(size: 12))
                        .foregroundColor(palette.textTertiary)
                        .padding(.vertical, 28)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: .infinity)
    }

    /// 保存为 .md：NSSavePanel（默认文件名 `{dateKey}-学习笔记.md`）；失败行就地展示。
    private func save() {
        saveError = nil
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.plainText]
        panel.allowsOtherFileTypes = true  // 保留 .md 扩展名（规格 §4-6）
        panel.nameFieldStringValue = vaultExportFileName(dateKey: dateKey)
        let markdownText = markdown
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            do {
                try markdownText.write(to: url, atomically: true, encoding: .utf8)
            } catch {
                saveError = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            }
        }
    }
}

// MARK: - 右侧看板（Board：今日进度环 + 三阶分段条 + 28 天热力 + 易错项；focus 态隐藏）

private struct VaultBoardView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    /// due = activeDue（VaultPage 由 ReaderApp 以 due={activeDue} 喂数据）：看板「还差 N 条」
    /// 在加练批次下按批次计。
    private var due: [VocabWord] { vm.reviewQueue }
    private var stageCounts: MasteryStageCounts { masteryStageCounts(vm.vocabWords) }
    /// 易错词：错题（wrong+trap）最多的前 3 个，按错题数降序。
    private var weakWords: [(word: VocabWord, bad: Int)] { weakVocab(vm.vocabWords, limit: 3) }

    /// 三阶图例（STAGE_LEGEND）：刚收集 / 眼熟（读到能懂） / 能说出口。
    private static let stageLegend: [(stage: MasteryStage, label: String)] = [
        (MasteryStage.s1, "刚收集"),
        (MasteryStage.s2, "眼熟（读到能懂）"),
        (MasteryStage.s3, "能说出口"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            progressCard
            stageCard
            heatmapCard
            weakCard
        }
    }

    /// 今日进度：conic 环的等价物 Circle().trim（{reviewedToday}/{todayTotal}）+
    /// 还差 N 条 + 约 X 分钟。
    private var progressCard: some View {
        let stats = vm.stats
        let todayTotal = stats.reviewedToday + due.count
        let pct = todayTotal > 0 ? min(1, Double(stats.reviewedToday) / Double(todayTotal)) : 0
        return card {
            HStack(spacing: 12) {
                ZStack {
                    Circle().stroke(palette.glassBorderStrong, lineWidth: 5)
                    Circle()
                        .trim(from: 0, to: pct)
                        .stroke(palette.accent, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .animation(ReaderMotion.islandTab, value: pct)
                    Text("\(stats.reviewedToday)/\(todayTotal)")
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                        .monospacedDigit()
                        .foregroundColor(palette.text)
                }
                .frame(width: 56, height: 56)
                VStack(alignment: .leading, spacing: 2) {
                    Text("今日进度")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(palette.textTertiary)
                    Text("还差 \(due.count) 条")
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundColor(palette.text)
                    Text("约 \(vaultMinutes(due.count)) 分钟")
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                }
                Spacer(minLength: 0)
            }
        }
    }

    /// 掌握阶段：三色分段条 + 图例 + 各计数（masteryStage 口径不变）。
    private var stageCard: some View {
        let total = max(1, vm.vocabWords.count)
        return card {
            VStack(alignment: .leading, spacing: 6) {
                Text("掌握阶段")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundColor(palette.textTertiary)
                GeometryReader { geo in
                    HStack(spacing: 0) {
                        Rectangle().fill(palette.warn)
                            .frame(width: geo.size.width * Double(stageCounts.s1) / Double(total))
                        Rectangle().fill(palette.clauseIndigo)
                            .frame(width: geo.size.width * Double(stageCounts.s2) / Double(total))
                        Rectangle().fill(palette.sonicTeal)
                            .frame(width: geo.size.width * Double(stageCounts.s3) / Double(total))
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
                    .frame(height: 6)
                    .frame(width: geo.size.width, alignment: .leading)
                }
                .frame(height: 6)
                ForEach(Self.stageLegend, id: \.stage) { row in
                    HStack {
                        Circle()
                            .fill(color(of: row.stage))
                            .frame(width: 7, height: 7)
                        Text(row.label)
                            .font(.system(size: 11))
                            .foregroundColor(palette.textSecondary)
                        Spacer(minLength: 6)
                        Text("\(stageCounts[row.stage])")
                            .font(.system(size: 11, weight: .semibold).monospacedDigit())
                            .foregroundColor(palette.text)
                    }
                }
            }
        }
    }

    /// 近 28 天：热力 28 格（today 格高亮）+ 出勤 / 空态提示。
    private var heatmapCard: some View {
        let buckets = heatBuckets(vm.reviewLog, nowMs: Int64(Date().timeIntervalSince1970 * 1000))
        let attended = buckets.filter { $0.count > 0 }.count
        let todayCount = buckets.first { $0.isToday }?.count ?? 0
        return card {
            VStack(alignment: .leading, spacing: 6) {
                Text("近 28 天")
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundColor(palette.textTertiary)
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
                Text(todayCount == 0 ? "完成第一轮复习，就会点亮今天。" : "出勤 \(attended) 天")
                    .font(.system(size: 11))
                    .monospacedDigit()
                    .foregroundColor(palette.textTertiary)
            }
        }
    }

    /// 易错项靶向加练：错题前 3 + 「1 分钟只练这 N 个易错项」+「去口语里加练 →」。
    private var weakCard: some View {
        card {
            VStack(alignment: .leading, spacing: 8) {
                Text("易错项靶向加练")
                    .font(.system(size: 11.5, weight: .semibold))
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
                        // 看板靶向加练：startFocusReview 直落专注态（Windows 同款两连调用）。
                        vm.startFocusReview(ids: weakWords.map(\.word.id))
                        withAnimation(ReaderMotion.islandTab) { vm.vaultPlayMode = .focus }
                    } label: {
                        Text("1 分钟只练这 \(weakWords.count) 个易错项")
                            .font(.system(size: 11.5, weight: .semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    Button {
                        if let first = weakWords.first {
                            vm.practiceVocabSpeak(first.word)
                        }
                    } label: {
                        Text("去口语里加练 →")
                            .font(.system(size: 11.5))
                    }
                    .buttonStyle(.link)
                }
            }
        }
    }

    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(palette.glassSurface.opacity(0.55)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(palette.glassBorder, lineWidth: 1))
    }

    private func color(of stage: MasteryStage) -> Color {
        switch stage {
        case .s1: return palette.warn
        case .s2: return palette.clauseIndigo
        case .s3: return palette.sonicTeal
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

// MARK: - 词条原句取回（首页/导出/口语条目共用）

extension ReaderVaultView {
    /// articleId 非空优先原文通道，取不到回退词条自带例句（划词收藏直接用例句）。
    static func entrySource(
        _ word: VocabWord,
        vm: ReaderViewModel
    ) -> (en: String, zh: String?)? {
        if !word.source.articleId.isEmpty {
            return vm.sourceSentence(articleId: word.source.articleId, sentenceIdx: word.source.sentenceIdx)
        }
        return word.example.map { (en: $0.en, zh: $0.zh) }
    }
}

// MARK: - UTF-16 子串（findChunkRange 的偏移是 UTF-16；越界收敛不崩）

func substring16(_ s: String, _ start: Int, _ end: Int) -> String {
    let units = Array(s.utf16)
    let a = min(max(0, start), units.count)
    let b = min(max(a, end), units.count)
    guard a < b else { return "" }
    return String(decoding: units[a..<b], as: UTF16.self)
}

// MARK: - 行内挖空输入框（ReviewView.tsx:1002-1047 BlankInput 的 Mac 对应物）
//
// placeholder「写出被挖空的部分」/ aria「被挖空的词块」/ Enter 提交（输入框自接管，
// 全局快捷键让路——否则判分刚落就被同一下 Enter「采纳建议档」）/ 自动聚焦 /
// 宽度随内容：min(320, max(150, 文本宽 + 30))（`.q-sent .cloze-blank-input` min-width 150）。

struct VaultBlankInput: View {
    @Binding var text: String
    let palette: ReaderPalette
    let fontPair: ReaderFontPair
    var focused: FocusState<Bool>.Binding
    let onSubmit: () -> Void

    static let placeholder = "写出被挖空的部分"
    static let fontSize: CGFloat = 26

    /// Windows BlankInput 的宽度规则（useLayoutEffect 量测 + 30，夹到 [150, 320]）。
    static func width(for text: String, fontPair: ReaderFontPair) -> CGFloat {
        let sample = text.isEmpty ? placeholder : text
        let font = readerNSFont(fontSize, pair: fontPair)
        let measured = (sample as NSString).size(withAttributes: [.font: font]).width
        return min(320, max(150, measured + 30))
    }

    var body: some View {
        TextField(
            "",
            text: $text,
            prompt: Text(Self.placeholder).font(.system(size: 14)).italic().foregroundColor(palette.ink4)
        )
        .textFieldStyle(.plain)
        .font(readerFont(Self.fontSize, .regular, pair: fontPair))
        .foregroundColor(palette.text)
        .multilineTextAlignment(.center)
        .autocorrectionDisabled()
        .focused(focused)
        .onSubmit(onSubmit)
        .padding(.horizontal, 8)
        .frame(width: Self.width(for: text, fontPair: fontPair), height: 40)
        .background(
            VaultTopRoundedRect(radius: 6)
                .fill(focused.wrappedValue ? palette.accentSoft : palette.accentSofter)
        )
        .overlay(alignment: .bottom) {
            Rectangle().fill(palette.accent).frame(height: 2)
        }
        .accessibilityLabel("被挖空的词块")
    }
}

/// 只圆上两角的矩形（CSS `border-radius: 6px 6px 0 0`；macOS 13 无 UnevenRoundedRectangle）。
private struct VaultTopRoundedRect: Shape {
    var radius: CGFloat

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let r = min(radius, min(rect.width, rect.height) / 2)
        p.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
        p.addQuadCurve(to: CGPoint(x: rect.minX + r, y: rect.minY), control: CGPoint(x: rect.minX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        p.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + r), control: CGPoint(x: rect.maxX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        p.closeSubpath()
        return p
    }
}

/// 行内流布局（Layout 协议）：子视图按阅读顺序左→右排列、放不下换行，同一行按底边对齐
///（大句文字与行内输入框的近似基线对齐）。FocusCloze 大句「pre 词 + 输入框 + post 词」用。
struct InlineFlowLayout: Layout {
    var itemSpacing: CGFloat = 6
    var lineSpacing: CGFloat = 8

    private struct Row {
        var items: [(index: Int, size: CGSize)] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func rows(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for (index, subview) in subviews.enumerated() {
            let size = subview.sizeThatFits(.unspecified)
            var row = rows[rows.count - 1]
            let extra = row.items.isEmpty ? 0 : itemSpacing
            if !row.items.isEmpty, row.width + extra + size.width > width {
                rows.append(Row())
                row = rows[rows.count - 1]
            }
            row.items.append((index, size))
            row.width += (row.items.count == 1 ? 0 : itemSpacing) + size.width
            row.height = max(row.height, size.height)
            rows[rows.count - 1] = row
        }
        return rows
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 600
        let rows = rows(width: width, subviews: subviews)
        let height = rows.reduce(0) { $0 + $1.height } + CGFloat(max(0, rows.count - 1)) * lineSpacing
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for item in row.items {
                subviews[item.index].place(
                    at: CGPoint(x: x, y: y + row.height - item.size.height),
                    anchor: .topLeading,
                    proposal: ProposedViewSize(item.size)
                )
                x += item.size.width + itemSpacing
            }
            y += row.height + lineSpacing
        }
    }
}

// MARK: - 听写卡（复用既有组件与四档评分带，判分链路零改动）

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
    let onReplay: () -> Void
    let onSubmit: () -> Void
    let onGiveUp: () -> Void
    let onJump: () -> Void
    let onGrade: (ReviewGrade) -> Void
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VaultCardMeta(pill: "听写", tone: palette.knownColor, source: sourceLabel, pos: pos, total: total, palette: palette)
            if let source {
                HStack(spacing: 10) {
                    Button(action: onReplay) {
                        Text(verdict != nil ? "再听一遍" : (replays < VaultFocusModel.dictationReplays ? "重播句子" : "播放句子"))
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
                        // Windows DictationCard textarea（ReviewView.tsx:1114-1130）：placeholder
                        //「听写整句（不区分大小写与标点）」、Enter（非 Shift）提交判分、aria「听写输入」。
                        // Mac 用多行 TextField：Return = onSubmit 提交；换行用 ⌥Return（macOS 多行
                        // 输入框惯例，Windows 为 Shift+Enter——仅修饰键差异，提交语义一致）。
                        TextField("听写整句（不区分大小写与标点）", text: $input, axis: .vertical)
                            .textFieldStyle(.plain)
                            .lineLimit(3...6)
                            .font(.system(size: 14))
                            .autocorrectionDisabled()
                            .padding(8)
                            .frame(minHeight: 84, alignment: .top)
                            .background(palette.surfaceAlt)
                            .cornerRadius(8)
                            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(palette.border))
                            .focused($inputFocused)
                            .onSubmit(onSubmit)
                            .accessibilityLabel("听写输入")
                        HStack(spacing: 10) {
                            Button("提交判分", action: onSubmit)
                                .controlSize(.small)
                                .buttonStyle(.borderedProminent)
                            Button("听不出，看句子", action: onGiveUp)
                                .controlSize(.small)
                            // `.rc-keyhint`：<kbd>Enter</kbd> 提交（ReviewView.tsx:1177-1179）。
                            HStack(spacing: 4) {
                                Text("Enter")
                                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                    .padding(.horizontal, 4).padding(.vertical, 1)
                                    .background(palette.glassBorder)
                                    .clipShape(RoundedRectangle(cornerRadius: 3))
                                Text("提交")
                            }
                            .font(.system(size: 10.5))
                            .foregroundColor(palette.textTertiary)
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
                    // 听写卡保留四档评分带（GRADE_COPY 契约：easy「很轻松」）。
                    VaultGradeBar(suggest: verdictToSuggestedGrade(verdict), ask: "这一句，你写出来了吗？", palette: palette, onGrade: onGrade)
                }
            }
        }
        .padding(.vertical, 24)
        .padding(.horizontal, 28)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(palette.glassSurface)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(palette.glassBorderStrong, lineWidth: 1)
        )
        .shadow(color: palette.shadowPill, radius: 12, y: 6)
        .onAppear { inputFocused = true }
    }
}

// MARK: - 卡片小件（meta / verdict / 四档评分带）

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

// MARK: - 开口造句过关卡（录音 → VAD 静音自动收 → 讯飞 ASR → 命中即过关）

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
        .padding(.vertical, 24)
        .padding(.horizontal, 28)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(palette.glassSurface)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(palette.glassBorderStrong, lineWidth: 1)
        )
        .shadow(color: palette.shadowPill, radius: 12, y: 6)
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
