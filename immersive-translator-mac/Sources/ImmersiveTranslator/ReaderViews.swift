import SwiftUI
import UniformTypeIdentifiers
import ReaderCore

// MARK: - 主题环境

private struct ReaderPaletteKey: EnvironmentKey {
    static let defaultValue: ReaderPalette = .palette(for: .light)
}

extension EnvironmentValues {
    var readerPalette: ReaderPalette {
        get { self[ReaderPaletteKey.self] }
        set { self[ReaderPaletteKey.self] = newValue }
    }
}

// MARK: - 根视图

struct ReaderRootView: View {
    @ObservedObject var vm: ReaderViewModel

    var body: some View {
        let settings = vm.effectiveSettings
        let palette = ReaderPalette.palette(for: settings.theme)
        VStack(spacing: 0) {
            ReaderTopBarView(vm: vm)
            if settings.showProgress, let article = vm.article, !settings.zenMode {
                InkProgressBar(percent: article.progress.percent)
            }
            ReaderBodyView(vm: vm)
            if vm.route == .reading, !settings.zenMode {
                PlayBarView(vm: vm)
            }
        }
        .background(palette.background)
        .overlay(alignment: .bottom) {
            if vm.route == .reading, settings.zenMode {
                ZenControlsView(vm: vm).padding(.bottom, 20)
            }
        }
        .environment(\.readerPalette, palette)
        .environment(\.colorScheme, palette.colorScheme)
        .overlay(alignment: .bottom) {
            if !vm.toast.isEmpty {
                ReaderToast(text: vm.toast)
            }
        }
        .sheet(isPresented: $vm.importSheetShown) {
            ReaderImportSheet(vm: vm)
        }
        .sheet(isPresented: $vm.noteDialogShown) {
            ReaderNoteDialogView(vm: vm)
        }
        .overlay {
            if vm.settingsDrawerShown {
                ReaderSettingsDrawer(vm: vm)
            }
        }
        .onChange(of: vm.activeSentenceIdx) { idx in
            vm.noteReadProgress(idx: idx)
        }
    }
}

// MARK: - 顶栏

struct ReaderTopBarView: View {
    @ObservedObject var vm: ReaderViewModel
    @State private var searchActive = false
    @State private var searchText = ""
    @FocusState private var searchFocused: Bool

    var body: some View {
        let palette = ReaderPalette.palette(for: vm.effectiveSettings.theme)
        HStack(spacing: 8) {
            Text("阅")
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(.white)
                .frame(width: 22, height: 22)
                .background(palette.accent)
                .clipShape(RoundedRectangle(cornerRadius: 5))
            Text("沉浸阅读室")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(palette.text)
            if let article = vm.article {
                Text(article.title)
                    .font(.system(size: 12))
                    .foregroundColor(palette.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(article.title)
            }
            Spacer(minLength: 12)
            if searchActive {
                TextField("在本文中检索…", text: $searchText)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 200)
                    .focused($searchFocused)
                    .font(.system(size: 12))
                    .onSubmit { vm.searchInArticle(searchText) }
                    .onExitCommand {
                        searchActive = false
                        searchText = ""
                    }
            }
            toolButton(palette: palette, icon: ReaderIcons.search, active: searchActive, help: "全文检索（Enter 跳转，Esc 关闭）") {
                searchActive.toggle()
                if searchActive { searchFocused = true }
            }
            toolButton(palette: palette, text: vm.effectiveSettings.theme.label, help: "主题：\(vm.effectiveSettings.theme.label)（点击切换）") {
                let themes = ReaderTheme.allCases
                let current = themes.firstIndex(of: vm.effectiveSettings.theme) ?? 0
                let next = themes[(current + 1) % themes.count]
                vm.patchSettings { settings in settings.theme = next }
            }
            toolButton(palette: palette, icon: ReaderIcons.gear, active: vm.settingsDrawerShown, help: "阅读设置") {
                vm.settingsDrawerShown = true
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(palette.surface)
    }

    private func toolButton(
        palette: ReaderPalette,
        icon: String? = nil,
        text: String? = nil,
        active: Bool = false,
        help: String,
        action: @escaping () -> Void
    ) -> some View {
        Group {
            if let icon {
                Image(systemName: icon).font(.system(size: 12))
            } else {
                Text(text ?? "").font(.system(size: 12))
            }
        }
        .foregroundColor(active ? .white : palette.textSecondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(active ? palette.accent : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 5))
        .contentShape(Rectangle())
        .onHover { hover in
            if hover, !active {
                withAnimation(.easeIn(duration: 0.05)) {}
            }
        }
        .help(help)
        .buttonStyle(.plain)
        .onTapGesture(perform: action)
    }
}

struct InkProgressBar: View {
    let percent: Double
    @Environment(\.readerPalette) private var palette

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Rectangle()
                    .fill(palette.border.opacity(0.3))
                Rectangle()
                    .fill(palette.accent)
                    .frame(width: geo.size.width * min(1, max(0, percent / 100)))
            }
        }
        .frame(height: 2)
    }
}

// MARK: - 主体（左栏 + 舞台 + 词典栏）

struct ReaderBodyView: View {
    @ObservedObject var vm: ReaderViewModel

    var body: some View {
        let settings = vm.effectiveSettings
        HStack(alignment: .top, spacing: 0) {
            if !settings.zenMode {
                ReaderShelfView(vm: vm)
                    .frame(width: 240)
                Divider().opacity(0.5)
            }
            if vm.route == .reading {
                ReadingStageView(vm: vm)
                if vm.dict.isOpen {
                    Divider().opacity(0.5)
                    DictColumnView(vm: vm)
                        .frame(width: 320)
                }
            } else if vm.route == .review {
                ReviewView(vm: vm)
            } else {
                ReaderNotesView(vm: vm)
            }
        }
        .frame(maxHeight: .infinity)
    }
}

// MARK: - 书架（左栏）

struct ReaderShelfView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    var body: some View {
        let stats = vm.stats
        let dueNow = stats.dueNow
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("书架")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(palette.text)
                Spacer()
                Button {
                    vm.importSheetShown = true
                } label: {
                    Image(systemName: ReaderIcons.plus).font(.system(size: 11, weight: .semibold))
                }
                .buttonStyle(.plain)
                .foregroundColor(palette.textSecondary)
                .help("导入文章（粘贴 / 打开 .txt）")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            ScrollView {
                VStack(spacing: 2) {
                    if vm.articleList.isEmpty {
                        Text("还没有文章。\n在网页或文档里选中文字，点浮窗上的「发送到阅读室」，或使用菜单栏的「沉浸阅读室」。")
                            .font(.system(size: 12))
                            .foregroundColor(palette.textTertiary)
                            .lineSpacing(4)
                            .padding(.horizontal, 12)
                            .padding(.top, 8)
                    }
                    ForEach(vm.articleList) { summary in
                        ShelfRow(
                            summary: summary,
                            active: summary.id == vm.article?.id,
                            onSelect: { vm.openArticle(id: summary.id) },
                            onDelete: { vm.deleteArticle(id: summary.id) }
                        )
                    }
                }
                .padding(.horizontal, 8)
            }

            Divider().opacity(0.5)
            VStack(alignment: .leading, spacing: 6) {
                Button {
                    vm.openReview()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: ReaderIcons.book).font(.system(size: 12))
                        Text("生词本复习").font(.system(size: 12.5))
                        Spacer()
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

                let todayTotal = stats.reviewedToday + dueNow
                Text(todayTotal > 0
                    ? "今日复习 \(stats.reviewedToday) / \(todayTotal) · 连续打卡 \(stats.streak) 天"
                    : "今日没有到期生词，去阅读里攒几个吧。")
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .background(palette.surfaceAlt)
    }
}

private struct ShelfRow: View {
    let summary: ArticleSummary
    let active: Bool
    let onSelect: () -> Void
    let onDelete: () -> Void
    @Environment(\.readerPalette) private var palette
    @State private var hover = false

    var body: some View {
        HStack(spacing: 6) {
            Text(summary.article.title)
                .font(.system(size: 12.5))
                .foregroundColor(active ? palette.accent : palette.text)
                .lineLimit(1)
                .truncationMode(.tail)
            Text("\(Int(summary.article.progress.percent.rounded()))%")
                .font(.system(size: 10.5))
                .foregroundColor(palette.textTertiary)
            if hover {
                Button(action: confirmDelete) {
                    Image(systemName: ReaderIcons.trash)
                        .font(.system(size: 10))
                        .foregroundColor(palette.textTertiary)
                }
                .buttonStyle(.plain)
                .help("删除文章")
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            active ? palette.accent.opacity(0.12) : (hover ? palette.border.opacity(0.25) : Color.clear)
        )
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture(perform: onSelect)
    }

    private func confirmDelete() {
        let alert = NSAlert()
        alert.messageText = "删除《\(summary.article.title)》？"
        alert.informativeText = "生词本不受影响。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "删除")
        alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn {
            onDelete()
        }
    }
}

// MARK: - 阅读舞台

struct ReadingStageView: View {
    @ObservedObject var vm: ReaderViewModel
    @State private var editingIdx: Int?
    @State private var editDraft = ""

    var body: some View {
        Group {
            if let article = vm.article {
                ReaderScroll(article: article, vm: vm, editingIdx: $editingIdx, editDraft: $editDraft)
            } else {
                EmptyStateView {
                    vm.importSheetShown = true
                }
            }
        }
    }
}

private struct RowFramesKey: PreferenceKey {
    typealias Value = [Int: CGFloat]

    static var defaultValue: [Int: CGFloat] = [:]

    static func reduce(value: inout [Int: CGFloat], nextValue: () -> [Int: CGFloat]) {
        value.merge(nextValue()) { _, new in new }
    }
}

private struct ReaderScroll: View {
    let article: Article
    @ObservedObject var vm: ReaderViewModel
    @Binding var editingIdx: Int?
    @Binding var editDraft: String
    @Environment(\.readerPalette) private var palette
    @State private var containerHeight: CGFloat = 600

    private var settings: ReaderSettings { vm.effectiveSettings }

    /// 滚到哪读到哪：视口上三分之一高度处的那一句为「当前句」。
    private func adoptViewportFrames(_ frames: [Int: CGFloat]) {
        let line = containerHeight / 3
        let above = frames.filter { $0.value <= line }
        let candidate = above.keys.max() ?? frames.keys.min()
        guard let idx = candidate else { return }
        DispatchQueue.main.async {
            vm.viewportMoved(to: idx)
        }
    }

    var body: some View {
        GeometryReader { outer in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if settings.maskTranslation {
                            MaskBarView(vm: vm)
                        }
                        ArticleHeader(article: article, vm: vm)
                        ArticleRows(
                            article: article,
                            vm: vm,
                            editingIdx: $editingIdx,
                            editDraft: $editDraft
                        )
                    }
                    .padding(.top, 18)
                    .padding(.bottom, 60)
                }
                .coordinateSpace(name: "readerScroll")
                .onPreferenceChange(RowFramesKey.self) { frames in
                    adoptViewportFrames(frames)
                }
                .onChange(of: vm.activeSentenceIdx) { idx in
                    proxy.scrollTo(idx, anchor: .center)
                }
                .onChange(of: vm.searchMatchIdx) { idx in
                    guard let idx else { return }
                    proxy.scrollTo(idx, anchor: .center)
                }
            }
            .onAppear { containerHeight = outer.size.height }
            .onChange(of: outer.size.height) { containerHeight = $0 }
        }
    }
}

/// 句对行列表（独立结构体，减轻主 body 的类型推断负担）。
private struct ArticleRows: View {
    let article: Article
    @ObservedObject var vm: ReaderViewModel
    @Binding var editingIdx: Int?
    @Binding var editDraft: String

    var body: some View {
        ForEach(article.sentences, id: \.idx) { pair in
            row(for: pair)
        }
    }

    private func row(for pair: SentencePair) -> some View {
        let isParaStart = pair.idx == 0
            || article.sentences[pair.idx - 1].paragraphIdx != pair.paragraphIdx
        return SentenceRowView(
            vm: vm,
            pair: pair,
            isParaStart: isParaStart,
            isActive: pair.idx == vm.activeSentenceIdx,
            isSearchMatch: pair.idx == vm.searchMatchIdx,
            editing: editingIdx == pair.idx,
            editDraft: $editDraft,
            onStartEdit: {
                editDraft = pair.zh ?? ""
                editingIdx = pair.idx
            },
            onCancelEdit: { editingIdx = nil },
            onCommitEdit: {
                let text = editDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                editingIdx = nil
                if !text.isEmpty { vm.editTranslation(idx: pair.idx, zh: text) }
            }
        )
        .id(pair.idx)
        .background(
            GeometryReader { geo in
                Color.clear.preference(
                    key: RowFramesKey.self,
                    value: [pair.idx: geo.frame(in: .named("readerScroll")).minY]
                )
            }
        )
        .padding(.horizontal, 24)
        .padding(.bottom, paragraphGap(after: pair) ? 18 : 6)
    }

    private func paragraphGap(after pair: SentencePair) -> Bool {
        guard pair.idx + 1 < article.sentences.count else { return true }
        return article.sentences[pair.idx + 1].paragraphIdx != pair.paragraphIdx
    }
}

// MARK: - 遮罩条

struct MaskBarView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    var body: some View {
        let sentences = vm.article?.sentences ?? []
        let peek = vm.peekAll
        let maskable = sentences.filter { $0.zh != nil }.count
        let revealed = sentences.filter { $0.zh != nil && ($0.revealed == true || peek) }.count
        HStack(spacing: 10) {
            Image(systemName: ReaderIcons.eyeOff)
                .font(.system(size: 11))
                .foregroundColor(palette.accent)
            Text("译文遮罩")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(palette.text)
            Text("\(revealed) / \(maskable) 已揭开")
                .font(.system(size: 12))
                .foregroundColor(palette.textSecondary)
            Text("点单句揭开 / 再点遮住 · 按住 H 临时显示全部")
                .font(.system(size: 11))
                .foregroundColor(palette.textTertiary)
            Spacer()
            if revealed < maskable {
                Button("全部揭开") { vm.revealAll() }
                    .controlSize(.small)
            }
            if revealed > 0 {
                Button("全部遮住") { vm.maskAll() }
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 8)
        .background(palette.accent.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 24)
        .padding(.bottom, 8)
        .frame(maxWidth: 760)
    }
}

// MARK: - 文章头

struct ArticleHeader: View {
    let article: Article
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(article.title)
                .font(readerFont(24, .semibold, pair: vm.effectiveSettings.fontPair))
                .foregroundColor(palette.text)
            if let titleCn = article.titleCn {
                Text(titleCn)
                    .font(readerFont(16, .regular, pair: vm.effectiveSettings.fontPair))
                    .foregroundColor(palette.textSecondary)
            } else if article.titleCnState == .failed {
                HStack(spacing: 8) {
                    Text("标题翻译失败")
                        .font(.system(size: 12))
                        .foregroundColor(palette.err)
                    Button("重试") { vm.retryTitle() }
                        .buttonStyle(.link)
                        .font(.system(size: 12))
                }
            } else if vm.translating != nil {
                SkeletonLine(width: 220)
                    .padding(.vertical, 4)
            }
            HStack(spacing: 8) {
                Text("\(article.wordCount) 词 · \(article.sentences.count) 句")
                    .font(.system(size: 12))
                    .foregroundColor(palette.textTertiary)
                if let translating = vm.translating {
                    progressChip("翻译中 \(translating.done)/\(translating.total) 段")
                }
                if vm.translating == nil, let chunking = vm.chunking {
                    progressChip("词块标注中 \(chunking.done)/\(chunking.total) 批")
                }
                let resumeIdx = article.progress.sentenceIdx
                if resumeIdx > 0, resumeIdx < article.sentences.count, vm.translating == nil {
                    Button("上次读到第 \(resumeIdx + 1) 句 · 点击继续") {
                        vm.jumpTo(idx: resumeIdx)
                    }
                    .buttonStyle(.link)
                    .font(.system(size: 12))
                }
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 16)
        .frame(maxWidth: 760, alignment: .leading)
    }

    private func progressChip(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .medium))
            .foregroundColor(palette.warn)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(palette.warn.opacity(0.12))
            .clipShape(Capsule())
    }
}

struct SkeletonLine: View {
    let width: CGFloat
    @Environment(\.readerPalette) private var palette

    var body: some View {
        RoundedRectangle(cornerRadius: 4)
            .fill(palette.border.opacity(0.4))
            .frame(width: width, height: 10)
            .opacity(0.7)
    }
}

// MARK: - 句对行

struct SentenceRowView: View {
    @ObservedObject var vm: ReaderViewModel
    let pair: SentencePair
    let isParaStart: Bool
    let isActive: Bool
    let isSearchMatch: Bool
    let editing: Bool
    @Binding var editDraft: String
    let onStartEdit: () -> Void
    let onCancelEdit: () -> Void
    let onCommitEdit: () -> Void

    @Environment(\.readerPalette) private var palette
    @State private var hoverCN = false

    var body: some View {
        let settings = vm.effectiveSettings
        let maskOn = settings.maskTranslation
        let peek = vm.peekAll
        let maskSlot = maskOn && pair.zh != nil && pair.zhState != .failed && !editing
        let maskShown = maskSlot && (pair.revealed == true || peek)

        HStack(alignment: .top, spacing: 10) {
            numberButton
            VStack(alignment: .leading, spacing: 4) {
                sentenceEN(settings: settings)
                cnArea(settings: settings, maskSlot: maskSlot, maskShown: maskShown)
            }
            rowActions(editing: editing)
        }
        .padding(.top, isParaStart ? 14 : 2)
        .padding(.bottom, 4)
        .padding(.leading, 10)
        .padding(.trailing, 12)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(isActive ? palette.activeRow : (isSearchMatch ? palette.warn.opacity(0.1) : Color.clear))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(isSearchMatch ? palette.warn.opacity(0.5) : Color.clear, lineWidth: 1.5)
        )
    }

    private func rowActions(editing: Bool) -> some View {
        VStack(spacing: 6) {
            Button {
                vm.speakSentence(pair.idx)
            } label: {
                Image(systemName: ReaderIcons.speaker)
                    .font(.system(size: 11))
                    .foregroundColor(isActive ? palette.accent : palette.textTertiary)
                    .frame(width: 20, height: 20)
            }
            .buttonStyle(.plain)
            .help(isActive ? "朗读当前句" : "朗读这一句")
            if pair.zh != nil, pair.zhState != .pending, !editing {
                Button {
                    onStartEdit()
                } label: {
                    Image(systemName: ReaderIcons.edit)
                        .font(.system(size: 10))
                        .foregroundColor(palette.textTertiary)
                        .frame(width: 20, height: 20)
                }
                .buttonStyle(.plain)
                .help("手改译文")
            }
        }
    }

    private var numberButton: some View {
        Button {
            vm.jumpTo(idx: pair.idx)
        } label: {
            Text("\(pair.idx + 1)")
                .font(.system(size: 10.5, weight: .medium).monospacedDigit())
                .foregroundColor(isActive ? palette.accent : palette.textTertiary)
                .frame(minWidth: 22, minHeight: 18)
                .background(isActive ? palette.accent.opacity(0.12) : Color.clear)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .help("第 \(pair.idx + 1) 句 · 点击定位")
    }

    /// 词块/生词再现跨度（开关只影响参与合并的候选）。
    private var spanMarks: [ReaderSentenceText.SpanMark] {
        let settings = vm.effectiveSettings
        let spans = buildSentenceSpans(
            pair.en,
            settings.chunkHighlight ? pair.chunks : nil,
            knownIds: settings.showVocabMarks ? vm.knownIds : []
        )
        return spans.compactMap { span in
            ReaderSentenceText.SpanMark(
                start: span.start,
                end: span.end,
                kind: span.kind,
                chunk: span.chunk
            )
        }
    }

    private func sentenceEN(settings: ReaderSettings) -> some View {
        let nsFont = readerNSFont(CGFloat(settings.fontSize), pair: settings.fontPair)
        let lineTarget = (CGFloat(settings.fontSize) / 19.0) * 29 * CGFloat(settings.lineHeight)
        let lineSpacing = max(0, lineTarget - nsFont.pointSize * 1.25)
        return ReaderSentenceText(
            text: pair.en,
            font: nsFont,
            textColor: NSColor(palette.text),
            lineSpacing: lineSpacing,
            chunkUnderlineColor: NSColor(palette.accent),
            knownUnderlineColor: NSColor(palette.knownColor),
            marks: spanMarks,
            onSelection: { text in vm.lookup(query: text, sentenceIdx: pair.idx) },
            onWordClick: { word in vm.lookup(query: word, sentenceIdx: pair.idx) },
            onChunkClick: { chunk in vm.openChunkCard(chunk: chunk, sentenceIdx: pair.idx) }
        )
        .frame(maxWidth: 680, alignment: .leading)
        .help("单击查词，划选查短语；蓝色虚线为词块，点按看释义")
    }

    @ViewBuilder
    private func cnArea(settings: ReaderSettings, maskSlot: Bool, maskShown: Bool) -> some View {
        let cnFont = readerFont((CGFloat(settings.fontSize) / 19.0) * 15, pair: settings.fontPair)
        let lineSpacing = (CGFloat(settings.fontSize) / 19.0) * 24 * CGFloat(settings.lineHeight) - 19
        Group {
            if maskSlot {
                maskBody(settings: settings, maskShown: maskShown, cnFont: cnFont, lineSpacing: lineSpacing)
            } else if pair.zhState == .pending {
                pendingBody(cnFont: cnFont, lineSpacing: lineSpacing)
            } else if pair.zhState == .failed {
                failedBody()
            } else if editing {
                editorBody(cnFont: cnFont)
            } else if let zh = pair.zh {
                Text(zh)
                    .font(cnFont)
                    .foregroundColor(palette.textSecondary)
                    .lineSpacing(max(2, lineSpacing))
                    .contentShape(Rectangle())
                    .onTapGesture { vm.jumpTo(idx: pair.idx) }
                    .help("点中文定位到对应英文句")
            } else {
                EmptyView()
            }
        }
        .frame(maxWidth: 680, alignment: .leading)
    }

    @ViewBuilder
    private func maskBody(settings: ReaderSettings, maskShown: Bool, cnFont: Font, lineSpacing: CGFloat) -> some View {
        if settings.maskStyle == .frost {
            Text(pair.zh ?? "")
                .font(cnFont)
                .foregroundColor(palette.textSecondary)
                .lineSpacing(max(2, lineSpacing))
                .blur(radius: maskShown ? 0 : 7)
                .opacity(maskShown ? 1 : 0.55)
                .contentShape(Rectangle())
                .onTapGesture {
                    if maskShown { vm.mask(pair.idx) } else { vm.reveal(pair.idx) }
                }
                .help(maskShown ? "点按重新遮住" : "点按显示译文")
        } else {
            ZStack(alignment: .leading) {
                if maskShown {
                    Text(pair.zh ?? "")
                        .font(cnFont)
                        .foregroundColor(palette.textSecondary)
                        .lineSpacing(max(2, lineSpacing))
                        .contentShape(Rectangle())
                        .onTapGesture { vm.mask(pair.idx) }
                        .help("点按重新遮住")
                } else {
                    HStack(spacing: 5) {
                        Image(systemName: ReaderIcons.eyeOff).font(.system(size: 10))
                        Text("显示译文").font(.system(size: 11))
                    }
                    .foregroundColor(palette.textTertiary)
                    .padding(.vertical, 3)
                    .padding(.horizontal, 6)
                    .background(hoverCN ? palette.border.opacity(0.3) : Color.clear)
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                    .contentShape(Rectangle())
                    .onHover { hoverCN = $0 }
                    .onTapGesture { vm.reveal(pair.idx) }
                }
            }
            .frame(minHeight: 20)
        }
    }

    @ViewBuilder
    private func pendingBody(cnFont: Font, lineSpacing: CGFloat) -> some View {
        if let zh = pair.zh {
            Text(zh)
                .font(cnFont)
                .foregroundColor(palette.textSecondary.opacity(0.75))
                .lineSpacing(max(2, lineSpacing))
        } else if vm.translating != nil {
            SkeletonLine(width: 140)
        } else {
            Text("译文待生成")
                .font(.system(size: 12))
                .foregroundColor(palette.textTertiary)
        }
    }

    private func failedBody() -> some View {
        HStack(spacing: 10) {
            Text("本段翻译失败")
                .font(.system(size: 12))
                .foregroundColor(palette.err)
            Button("重试本段") { vm.retryParagraph(pair.paragraphIdx) }
                .buttonStyle(.link)
                .font(.system(size: 12))
        }
    }

    private func editorBody(cnFont: Font) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            TextEditor(text: $editDraft)
                .font(cnFont)
                .frame(minHeight: 48)
                .scrollContentBackground(.hidden)
                .padding(4)
                .background(palette.surfaceAlt)
                .cornerRadius(6)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(palette.accent.opacity(0.5)))
            HStack {
                Text("⌘↩ 保存 · Esc 取消")
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
                Spacer()
                Button("取消") { onCancelEdit() }.controlSize(.small)
                Button("保存") { onCommitEdit() }
                    .controlSize(.small)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(editDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }
}

// MARK: - 空态

struct EmptyStateView: View {
    let onImport: () -> Void
    @Environment(\.readerPalette) private var palette

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: ReaderIcons.book)
                .font(.system(size: 26))
                .foregroundColor(palette.accent)
            Text("把文章搬进阅读室")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(palette.text)
            Text("在任意应用选中文字 → 浮窗弹出 → 点「发送到阅读室」；或直接粘贴导入。")
                .font(.system(size: 12.5))
                .foregroundColor(palette.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
            Button("粘贴导入文章", action: onImport)
                .controlSize(.regular)
                .padding(.top, 6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - 词典栏

struct DictColumnView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    switch vm.dict {
                    case .closed:
                        EmptyView()
                    case .loading(let query, _):
                        Text(query)
                            .font(readerFont(20, .semibold, pair: vm.effectiveSettings.fontPair))
                            .foregroundColor(palette.text)
                        SkeletonLine(width: 120)
                        SkeletonLine(width: 260)
                        SkeletonLine(width: 220)
                    case .notAWord(let query, _):
                        Text("「\(query)」不像一个词条——试试划选更短的词组，或单击单个单词。")
                            .font(.system(size: 12.5))
                            .foregroundColor(palette.textSecondary)
                    case .error(_, _, let message):
                        VStack(alignment: .leading, spacing: 6) {
                            Text("查询失败：\(message)")
                                .font(.system(size: 12.5))
                                .foregroundColor(palette.err)
                            Button("关闭") { vm.dict = .closed }
                                .controlSize(.small)
                        }
                    case .ready(_, let entry, let sentenceIdx):
                        entryBody(entry: entry, sentenceIdx: sentenceIdx)
                    case .chunkCard(let chunk, let sentenceIdx):
                        chunkBody(chunk: chunk, sentenceIdx: sentenceIdx)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 20)
            }
        }
        .padding(.top, 12)
        .background(palette.surface)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(headWord)
                    .font(readerFont(21, .semibold, pair: vm.effectiveSettings.fontPair))
                    .foregroundColor(palette.text)
                if case let .ready(_, entry, _) = vm.dict, let phonetic = entry.phonetic {
                    Text("/\(phonetic.trimmingCharacters(in: CharacterSet(charactersIn: "/")))/")
                        .font(.system(size: 12))
                        .foregroundColor(palette.textTertiary)
                }
                if case let .chunkCard(chunk, _) = vm.dict {
                    Text(chunk.chunkType.label)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(palette.knownColor)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(palette.knownColor.opacity(0.12))
                        .clipShape(Capsule())
                }
            }
            Spacer()
            Button {
                vm.speakWord(headWord)
            } label: {
                Image(systemName: ReaderIcons.speaker).font(.system(size: 11))
            }
            .buttonStyle(.plain)
            .foregroundColor(palette.textSecondary)
            .help("发音")
            Button {
                vm.dict = .closed
            } label: {
                Image(systemName: ReaderIcons.close).font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(.plain)
            .foregroundColor(palette.textSecondary)
            .help("关闭词典栏")
        }
        .padding(.horizontal, 14)
    }

    private var headWord: String {
        switch vm.dict {
        case .closed: return ""
        case .loading(let q, _), .notAWord(let q, _), .error(let q, _, _): return q
        case .ready(let q, _, _): return q
        case .chunkCard(let chunk, _): return chunk.text
        }
    }

    @ViewBuilder
    private func chunkBody(chunk: SentenceChunk, sentenceIdx: Int) -> some View {
        sectionTitle("释义")
        Text(chunk.gloss)
            .font(.system(size: 13))
            .foregroundColor(palette.text)
        if let pattern = chunk.pattern {
            sectionTitle("记法")
            Text(pattern)
                .font(.system(size: 13, design: .serif))
                .foregroundColor(palette.textSecondary)
        }
        if let trap = chunk.trap {
            sectionTitle("直译陷阱")
            Text(trap)
                .font(.system(size: 12.5))
                .foregroundColor(palette.err)
        }
        sectionTitle("原句")
        sourceCard(sentenceIdx: sentenceIdx)
        HStack(spacing: 8) {
            Button {
                vm.addCurrentDictVocab()
            } label: {
                Label(vm.isInVocab ? "已在生词本" : "收藏词块", systemImage: ReaderIcons.starFill)
                    .font(.system(size: 12))
            }
            .controlSize(.small)
            .buttonStyle(.borderedProminent)
            .disabled(vm.isInVocab)
            Button {
                vm.lookup(query: chunk.text, sentenceIdx: sentenceIdx)
            } label: {
                Text("详查词典").font(.system(size: 12))
            }
            .controlSize(.small)
            .help("查完整词条（音标、多义项、搭配）")
        }
    }

    @ViewBuilder
    private func entryBody(entry: ReaderDictEntry, sentenceIdx: Int) -> some View {
        sectionTitle("释义")
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(entry.senses.enumerated()), id: \.offset) { _, sense in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if !sense.pos.isEmpty {
                        Text(sense.pos)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(palette.accent)
                    }
                    Text(sense.cn)
                        .font(.system(size: 13))
                        .foregroundColor(palette.text)
                }
            }
        }

        sourceCard(sentenceIdx: sentenceIdx)

        if let collocations = entry.collocations, !collocations.isEmpty {
            sectionTitle("常用搭配")
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(collocations.enumerated()), id: \.offset) { _, coll in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(coll.en)
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundColor(palette.text)
                        Text(coll.cn)
                            .font(.system(size: 11.5))
                            .foregroundColor(palette.textTertiary)
                        Spacer()
                        let saved = vm.knownIds.contains(normalizeWordKey(coll.en))
                        Button {
                            vm.addCollocationVocab(coll, sentenceIdx: sentenceIdx)
                        } label: {
                            Image(systemName: saved ? ReaderIcons.starFill : ReaderIcons.star)
                                .font(.system(size: 11))
                        }
                        .buttonStyle(.plain)
                        .disabled(saved)
                        .foregroundColor(saved ? palette.warn : palette.textTertiary)
                        .help(saved ? "已在生词本" : "收藏为词块")
                    }
                }
            }
        }

        if let forms = entry.forms, !forms.isEmpty {
            sectionTitle("词形变化")
            Text(forms.joined(separator: " · "))
                .font(.system(size: 12))
                .foregroundColor(palette.textSecondary)
        }

        HStack(spacing: 8) {
            Button {
                vm.addCurrentDictVocab()
            } label: {
                Label(vm.isInVocab ? "已在生词本" : "加入生词本", systemImage: ReaderIcons.starFill)
                    .font(.system(size: 12))
            }
            .controlSize(.small)
            .buttonStyle(.borderedProminent)
            .disabled(vm.isInVocab)
            Button {
                vm.copyDictEntry()
            } label: {
                Label("复制", systemImage: ReaderIcons.copy)
                    .font(.system(size: 12))
            }
            .controlSize(.small)
        }
    }

    private func sourceCard(sentenceIdx: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionTitle("原句")
            Button {
                vm.jumpTo(idx: sentenceIdx)
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(vm.article?.sentences[safe: sentenceIdx]?.en ?? "")
                        .font(.system(size: 12))
                        .foregroundColor(palette.textSecondary)
                        .multilineTextAlignment(.leading)
                    Label("第 \(sentenceIdx + 1) 句 · 点击定位", systemImage: ReaderIcons.locate)
                        .font(.system(size: 10.5))
                        .foregroundColor(palette.accent)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.surfaceAlt)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(palette.textTertiary)
    }
}


// MARK: - 设置抽屉

struct ReaderSettingsDrawer: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    var body: some View {
        let settings = vm.effectiveSettings
        ZStack(alignment: .trailing) {
            Color.black.opacity(0.32)
                .contentShape(Rectangle())
                .onTapGesture { vm.settingsDrawerShown = false }
            HStack {
                Spacer(minLength: 0)
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text("阅读设置").font(.system(size: 14, weight: .semibold))
                        Spacer()
                        Button {
                            vm.settingsDrawerShown = false
                        } label: {
                            Image(systemName: ReaderIcons.close).font(.system(size: 11, weight: .semibold))
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(14)
                    Divider().opacity(0.5)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            groupTitle("版式")
                            segmentedRow("对照模式", contrastOptions, selection: settings.contrastMode) { value in
                                vm.patchSettings { $0.contrastMode = value }
                            }
                            segmentedRow("遮罩样式", maskStyleOptions, selection: settings.maskStyle, disabled: !settings.maskTranslation) { value in
                                vm.patchSettings { $0.maskStyle = value }
                            }
                            stepperRow("正文字号", value: settings.fontSize, range: readerFontSizeMin...readerFontSizeMax) { value in
                                vm.patchSettings { $0.fontSize = value }
                            }
                            sliderRow("行距", value: settings.lineHeight, range: 1...2.4, step: 0.05, format: String(format: "%.2f×", settings.lineHeight)) { value in
                                vm.patchSettings { $0.lineHeight = value }
                            }
                            pickerRow("正文字体", fontOptions, selection: settings.fontPair) { value in
                                vm.patchSettings { $0.fontPair = value }
                            }

                            groupTitle("词块")
                            HStack {
                                rowLabel("自动标注词组")
                                Toggle("", isOn: Binding(
                                    get: { settings.chunkHighlight },
                                    set: { value in vm.patchSettings { $0.chunkHighlight = value } }
                                ))
                                .toggleStyle(.switch)
                                .labelsHidden()
                            }
                            .help("新文章翻译完成后自动标注值得学的词组（会额外消耗接口 token），正文里以蓝色虚线下划线显示，点击看释义并可收藏")
                            HStack {
                                rowLabel("生词再现标记")
                                Toggle("", isOn: Binding(
                                    get: { settings.showVocabMarks },
                                    set: { value in vm.patchSettings { $0.showVocabMarks = value } }
                                ))
                                .toggleStyle(.switch)
                                .labelsHidden()
                            }
                            .help("已收藏的词/词块在正文再次出现时用绿色点线标记，点击可查看")
                            if vm.article?.chunkState != nil {
                                HStack {
                                    rowLabel("重新标注本篇")
                                    Button("重新标注") { vm.reannotateChunks() }
                                        .controlSize(.small)
                                }
                                .help("清空本篇已有标注，重新跑一遍词组标注")
                            }

                            groupTitle("朗读")
                            HStack {
                                rowLabel("引擎")
                                Picker("引擎", selection: Binding(
                                    get: { settings.ttsProvider },
                                    set: { value in vm.patchSettings { $0.ttsProvider = value } }
                                )) {
                                    ForEach(TtsProvider.allCases, id: \.self) { provider in
                                        Text(provider.label).tag(provider)
                                    }
                                }
                                .labelsHidden()
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            if settings.ttsProvider == .xfyun {
                                VStack(alignment: .leading, spacing: 6) {
                                    if !XfyunCredentialsStore.shared.isComplete(.tts) {
                                        HStack(spacing: 5) {
                                            Image(systemName: "exclamationmark.triangle.fill")
                                                .font(.system(size: 10))
                                                .foregroundColor(palette.warn)
                                            Text("讯飞合成凭据未配置，朗读将回落系统语音")
                                                .font(.system(size: 10.5))
                                                .foregroundColor(palette.warn)
                                        }
                                    }
                                    cloudVoiceField(label: "中文音色", text: settings.cloudVoice, placeholder: "xiaoyan") { value in
                                        vm.patchSettings { $0.cloudVoice = value }
                                    }
                                    cloudVoiceField(label: "英文音色", text: settings.cloudVoiceEn, placeholder: "catherine") { value in
                                        vm.patchSettings { $0.cloudVoiceEn = value }
                                    }
                                }
                            } else {
                                voiceRow(selection: settings.voice)
                            }
                            sliderRow("语速", value: settings.rate, range: readerRateMin...readerRateMax, step: 0.05, format: String(format: "%.2f×", settings.rate)) { value in
                                vm.patchSettings { $0.rate = value }
                            }
                            sliderRow("每句停顿", value: settings.sentencePauseMs, range: 0...2000, step: 100, format: String(format: "%.1fs", settings.sentencePauseMs / 1000)) { value in
                                vm.patchSettings { $0.sentencePauseMs = value }
                            }
                            HStack {
                                rowLabel("跟读模式")
                                Toggle("", isOn: Binding(
                                    get: { settings.shadowingMode },
                                    set: { value in vm.patchSettings { $0.shadowingMode = value } }
                                ))
                                .toggleStyle(.switch)
                                .labelsHidden()
                            }
                            if settings.shadowingMode {
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack {
                                        rowLabel("跟读评测")
                                        Toggle("", isOn: Binding(
                                            get: { settings.shadowingAssess },
                                            set: { value in vm.patchSettings { $0.shadowingAssess = value } }
                                        ))
                                        .toggleStyle(.switch)
                                        .labelsHidden()
                                    }
                                    .help("跟读句送讯飞语音评测，达到阈值才放行（凭据在设置 → 语音）")
                                    if settings.shadowingAssess {
                                        sliderRow("过关阈值", value: settings.shadowingPassScore, range: readerAssessPassMin...readerAssessPassMax, step: 0.1, format: String(format: "%.1f 分", settings.shadowingPassScore)) { value in
                                            vm.patchSettings { $0.shadowingPassScore = value }
                                        }
                                        sliderRow("静音断句", value: settings.shadowingSilenceMs, range: readerAssessSilenceMin...readerAssessSilenceMax, step: 100, format: String(format: "%.1fs", settings.shadowingSilenceMs / 1000)) { value in
                                            vm.patchSettings { $0.shadowingSilenceMs = value }
                                        }
                                        HStack {
                                            rowLabel("读完自动开麦")
                                            Toggle("", isOn: Binding(
                                                get: { settings.shadowingAutoMic },
                                                set: { value in vm.patchSettings { $0.shadowingAutoMic = value } }
                                            ))
                                            .toggleStyle(.switch)
                                            .labelsHidden()
                                        }
                                    }
                                }
                            }

                            groupTitle("主题")
                            HStack(spacing: 8) {
                                ForEach(ReaderTheme.allCases, id: \.self) { theme in
                                    themeButton(theme: theme, selected: settings.theme == theme)
                                }
                            }
                        }
                        .padding(14)
                    }
                    Divider().opacity(0.5)
                    HStack {
                        Button("恢复默认") { vm.resetSettings() }
                            .controlSize(.small)
                        Spacer()
                        Button("完成") { vm.settingsDrawerShown = false }
                            .controlSize(.small)
                            .buttonStyle(.borderedProminent)
                            .keyboardShortcut(.defaultAction)
                    }
                    .padding(14)
                }
                .frame(width: 340)
                .background(palette.surface)
            }
        }
    }

    private var contrastOptions: [(ContrastMode, String)] {
        ContrastMode.allCases.map { ($0, $0.label) }
    }
    private var maskStyleOptions: [(MaskStyle, String)] {
        MaskStyle.allCases.map { ($0, $0.label) }
    }
    private var fontOptions: [(ReaderFontPair, String)] {
        ReaderFontPair.allCases.map { ($0, $0.label) }
    }

    private func themeButton(theme: ReaderTheme, selected: Bool) -> some View {
        let p = ReaderPalette.palette(for: theme)
        return Button {
            vm.patchSettings { $0.theme = theme }
        } label: {
            VStack(spacing: 4) {
                RoundedRectangle(cornerRadius: 5)
                    .fill(p.background)
                    .overlay(
                        Text("Aa")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(p.text)
                    )
                    .frame(height: 34)
                    .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(palette.border))
                Text(theme.label).font(.system(size: 11))
            }
            .padding(6)
            .frame(maxWidth: .infinity)
            .background(selected ? palette.accent.opacity(0.15) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }

    @State private var voiceCatalog: [ReaderVoiceInfo] = []

    private func cloudVoiceField(label: String, text: String, placeholder: String, onCommit: @escaping (String) -> Void) -> some View {
        HStack {
            rowLabel(label)
            TextField(placeholder, text: Binding(
                get: { text },
                set: { value in onCommit(value) }
            ))
            .textFieldStyle(.roundedBorder)
            .font(.system(size: 11.5))
            .frame(maxWidth: .infinity)
        }
        .help("讯飞发音人 vcn；建议：catherine（英）、xiaoyan（中）、x4_xiaoyan、aisjiuxu（男）、aisbabyxu（童）")
    }

    private func voiceRow(selection: String) -> some View {
        HStack {
            rowLabel("音色")
            Picker("音色", selection: Binding(
                get: { selection },
                set: { value in vm.patchSettings { $0.voice = value } }
            )) {
                Text("系统默认").tag("")
                ForEach(voiceCatalog, id: \.name) { voice in
                    Text(voice.chinese ? "\(voice.name)（中文）" : voice.name).tag(voice.name)
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)
            .onAppear { voiceCatalog = ReaderVoiceCatalog.voices() }
        }
    }

    private func groupTitle(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 11, weight: .bold))
            .foregroundColor(palette.textTertiary)
            .padding(.top, 4)
    }

    private func rowLabel(_ label: String) -> some View {
        Text(label)
            .font(.system(size: 12.5))
            .foregroundColor(palette.text)
            .frame(width: 90, alignment: .leading)
    }

    private func segmentedRow<T: Hashable>(
        _ label: String,
        _ options: [(T, String)],
        selection: T,
        disabled: Bool = false,
        onChange: @escaping (T) -> Void
    ) -> some View {
        HStack {
            rowLabel(label)
            Picker(label, selection: Binding(get: { selection }, set: { onChange($0) })) {
                ForEach(options, id: \.0) { option in
                    Text(option.1).tag(option.0)
                }
            }
            .pickerStyle(.segmented)
            .disabled(disabled)
            .labelsHidden()
        }
    }

    private func pickerRow<T: Hashable>(
        _ label: String,
        _ options: [(T, String)],
        selection: T,
        onChange: @escaping (T) -> Void
    ) -> some View {
        HStack {
            rowLabel(label)
            Picker(label, selection: Binding(get: { selection }, set: { onChange($0) })) {
                ForEach(options, id: \.0) { option in
                    Text(option.1).tag(option.0)
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func stepperRow(
        _ label: String,
        value: Int,
        range: ClosedRange<Int>,
        onChange: @escaping (Int) -> Void
    ) -> some View {
        HStack {
            rowLabel(label)
            Stepper("\(value)", value: Binding(get: { value }, set: { onChange($0) }), in: range)
                .font(.system(size: 12.5))
        }
    }

    private func sliderRow(
        _ label: String,
        value: Double,
        range: ClosedRange<Double>,
        step: Double,
        format: String,
        onChange: @escaping (Double) -> Void
    ) -> some View {
        HStack {
            rowLabel(label)
            Slider(value: Binding(get: { value }, set: { onChange($0) }), in: range, step: step)
            Text(format)
                .font(.system(size: 11))
                .foregroundColor(palette.textTertiary)
                .frame(width: 44, alignment: .trailing)
        }
    }
}

// MARK: - Toast / 复习占位

struct ReaderToast: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 12.5))
            .foregroundColor(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Color.black.opacity(0.78))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .padding(.bottom, 56)
            .transition(.opacity)
            .animation(.easeInOut(duration: 0.18), value: text)
    }
}

// MARK: - 工具

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

// MARK: - 播放条（屏 A 底部）

let readerRatePresets: [Double] = [0.75, 1, 1.25, 1.5]

struct PlayBarView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette
    @State private var hoverIdx: Int?
    @State private var dragging = false

    private var total: Int { vm.article?.sentences.count ?? 0 }
    private var idx: Int { vm.activeSentenceIdx }
    private var percent: Double {
        total > 1 ? Double(idx) / Double(total - 1) : 0
    }

    var body: some View {
        HStack(spacing: 14) {
            transport
            progressTrack
            countLabel
            HStack(spacing: 8) {
                if vm.shadowingWait {
                    HStack(spacing: 6) {
                        Text("请跟读当前句").font(.system(size: 11.5)).foregroundColor(palette.warn)
                        Button("继续") { vm.continueAfterShadowing() }
                            .controlSize(.small)
                            .buttonStyle(.borderedProminent)
                    }
                } else {
                    rateButton
                }
                viewMenu
                Button {
                    vm.settingsDrawerShown = true
                } label: {
                    Image(systemName: ReaderIcons.gear).font(.system(size: 12))
                }
                .buttonStyle(.plain)
                .foregroundColor(palette.textSecondary)
                .help("阅读设置")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(palette.surface)
    }

    private var transport: some View {
        HStack(spacing: 10) {
            Button {
                vm.jumpTo(idx: idx - 1)
            } label: {
                Image(systemName: ReaderIcons.prev).font(.system(size: 13))
            }
            .buttonStyle(.plain)
            .disabled(total == 0 || idx <= 0)
            .foregroundColor(palette.text)
            .help("上一句 (L)")

            Button {
                vm.togglePlayback()
            } label: {
                Image(systemName: vm.playbackPlaying ? ReaderIcons.pause : ReaderIcons.play)
                    .font(.system(size: 15))
                    .foregroundColor(.white)
                    .frame(width: 32, height: 32)
                    .background(palette.accent)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(total == 0)
            .help(vm.playbackPlaying ? "暂停 (Space)" : "播放 (Space)")

            Button {
                vm.jumpTo(idx: idx + 1)
            } label: {
                Image(systemName: ReaderIcons.next).font(.system(size: 13))
            }
            .buttonStyle(.plain)
            .disabled(total == 0 || idx >= total - 1)
            .foregroundColor(palette.text)
            .help("下一句 (J)")
        }
    }

    private var progressTrack: some View {
        GeometryReader { geo in
            let width = geo.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(palette.border.opacity(0.5))
                Capsule()
                    .fill(palette.accent)
                    .frame(width: max(0, width * percent))
                if total > 1, total <= 40 {
                    ForEach(1..<total, id: \.self) { i in
                        Rectangle()
                            .fill(palette.surface)
                            .frame(width: 1, height: 6)
                            .offset(x: width * CGFloat(i) / CGFloat(total - 1) - 0.5)
                    }
                }
                Circle()
                    .fill(palette.accent)
                    .frame(width: 11, height: 11)
                    .offset(x: max(0, min(width - 11, width * percent - 5.5)))
            }
            .frame(height: 6, alignment: .center)
            .contentShape(Rectangle().inset(by: -8))
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        dragging = true
                        vm.jumpTo(idx: idxFor(x: value.location.x, width: width))
                    }
                    .onEnded { _ in dragging = false }
            )
            .onContinuousHover { phase in
                switch phase {
                case .active(let location):
                    hoverIdx = idxFor(x: location.x, width: width)
                case .ended:
                    hoverIdx = nil
                @unknown default:
                    break
                }
            }
            .overlay(alignment: .top) {
                if let hoverIdx, !dragging, total > 0,
                   let preview = vm.article?.sentences[safe: hoverIdx]?.en {
                    Text("第 \(hoverIdx + 1) 句 · \(preview)")
                        .font(.system(size: 10.5))
                        .foregroundColor(palette.text)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(palette.surface)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                        .shadow(color: .black.opacity(0.18), radius: 4, y: 1)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: 320, alignment: .leading)
                        .offset(x: hoverOffset(x: width * CGFloat(hoverIdx) / CGFloat(max(1, total - 1)), width: width))
                        .offset(y: -30)
                        .allowsHitTesting(false)
                }
            }
        }
        .frame(height: 22)
        .frame(maxWidth: .infinity)
    }

    private func idxFor(x: CGFloat, width: CGFloat) -> Int {
        guard total > 0, width > 0 else { return 0 }
        let ratio = min(1, max(0, x / width))
        return min(total - 1, Int((ratio * CGFloat(total - 1)).rounded()))
    }

    private func hoverOffset(x: CGFloat, width: CGFloat) -> CGFloat {
        min(0, max(-(x - 140), -width + 150))
    }

    private var countLabel: some View {
        Group {
            if total > 0 {
                Text("\(idx + 1)")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(palette.accent)
                + Text(" ∕ \(total) 句")
                    .font(.system(size: 12))
                    .foregroundColor(palette.textTertiary)
            } else {
                Text("暂无句子")
                    .font(.system(size: 12))
                    .foregroundColor(palette.textTertiary)
            }
        }
    }

    private var rateButton: some View {
        Button {
            let current = readerRatePresets.firstIndex(of: vm.effectiveSettings.rate) ?? 1
            let next = readerRatePresets[(current + 1) % readerRatePresets.count]
            vm.patchSettings { $0.rate = next }
        } label: {
            Text(rateLabel)
        }
        .buttonStyle(.plain)
        .font(.system(size: 12, weight: .medium).monospacedDigit())
        .foregroundColor(palette.text)
        .help("播放语速（更多档位在阅读设置）")
    }

    private var rateLabel: String {
        var text = String(format: "%.2f", vm.effectiveSettings.rate)
        if text.hasSuffix("0") { text.removeLast() }
        return "\(text)×"
    }

    private var viewMenu: some View {
        let settings = vm.effectiveSettings
        let contrasts = ContrastMode.allCases
        let nextContrast = contrasts[(contrasts.firstIndex(of: settings.contrastMode) ?? 0 + 1) % contrasts.count]
        return Menu {
            Button("对照模式：\(nextContrast.label)") {
                vm.patchSettings { $0.contrastMode = nextContrast }
            }
            Button("\(settings.maskTranslation ? "✓" : "") 译文遮罩 · 自测") {
                vm.patchSettings { $0.maskTranslation = !$0.maskTranslation }
            }
            Button("\(settings.showProgress ? "✓" : "") 显示阅读进度") {
                vm.patchSettings { $0.showProgress = !$0.showProgress }
            }
            Divider()
            Button("\(settings.zenMode ? "✓" : "") 禅模式 · 隐藏侧栏与播放条") {
                vm.patchSettings { $0.zenMode = !$0.zenMode }
            }
        } label: {
            Text("视图")
                .font(.system(size: 12))
                .foregroundColor(palette.textSecondary)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }
}

// MARK: - 禅模式浮动控制

struct ZenControlsView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    var body: some View {
        HStack(spacing: 14) {
            Button {
                vm.jumpTo(idx: vm.activeSentenceIdx - 1)
            } label: {
                Image(systemName: ReaderIcons.prev).font(.system(size: 12))
            }
            Button {
                vm.togglePlayback()
            } label: {
                Image(systemName: vm.playbackPlaying ? ReaderIcons.pause : ReaderIcons.play)
                    .font(.system(size: 13))
                    .foregroundColor(.white)
                    .frame(width: 34, height: 34)
                    .background(palette.accent)
                    .clipShape(Circle())
            }
            Button {
                vm.jumpTo(idx: vm.activeSentenceIdx + 1)
            } label: {
                Image(systemName: ReaderIcons.next).font(.system(size: 12))
            }
        }
        .buttonStyle(.plain)
        .foregroundColor(palette.text)
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .background(palette.surface.opacity(0.92))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
    }
}
