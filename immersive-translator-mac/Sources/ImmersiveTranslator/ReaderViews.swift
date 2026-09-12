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
        }
        .background(palette.background)
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
            } else {
                ReviewPlaceholderView(vm: vm)
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
            marks: [],
            onSelection: { text in vm.lookup(query: text, sentenceIdx: pair.idx) },
            onWordClick: { word in vm.lookup(query: word, sentenceIdx: pair.idx) }
        )
        .frame(maxWidth: 680, alignment: .leading)
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
                    case .ready(let query, let entry, let sentenceIdx):
                        entryBody(entry: entry, sentenceIdx: sentenceIdx)
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
            }
            Spacer()
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

// MARK: - 导入弹窗

struct ReaderImportSheet: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var title = ""
    @State private var fileError = ""
    @State private var fileImporterShown = false

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var detectedTitle: String? { detectTitleFromText(text) }
    private var statsLine: String {
        guard !trimmed.isEmpty else { return "0 词 · 0 段" }
        let words = countWords(trimmed)
        let paras = splitParagraphs(trimmed).count
        return "\(words) 词 · \(paras) 段"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("导入文章").font(.system(size: 15, weight: .semibold))
                    Text("粘贴英文原文，空行自动分段 · 生成句对译文后立即开始精读")
                        .font(.system(size: 11.5))
                        .foregroundColor(.secondary)
                }
                Spacer()
            }
            TextField("标题（可选）：留空则自动识别首行作为标题（≤80 字符且无句末标点）", text: $title)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 12))
            TextEditor(text: $text)
                .font(.system(size: 13))
                .frame(minHeight: 220)
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.secondary.opacity(0.35)))
            if !fileError.isEmpty {
                Text(fileError).font(.system(size: 12)).foregroundColor(.red)
            }
            titleHint
            HStack {
                Text(statsLine).font(.system(size: 11.5)).foregroundColor(.secondary)
                Spacer()
                Button("打开 .txt 文件…") { fileImporterShown = true }
                    .controlSize(.small)
                Button("取消") { dismiss() }
                    .controlSize(.small)
                    .keyboardShortcut(.cancelAction)
                Button("开始阅读") {
                    let chosen = title.trimmingCharacters(in: .whitespacesAndNewlines)
                    let importText = text
                    dismiss()
                    vm.importPaste(importText, title: chosen.isEmpty ? nil : chosen)
                }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(trimmed.isEmpty)
            }
        }
        .padding(16)
        .frame(width: 560)
        .fileImporter(
            isPresented: $fileImporterShown,
            allowedContentTypes: [.plainText, .text],
            allowsMultipleSelection: false
        ) { result in
            if let url = try? result.get().first {
                loadFile(url)
            }
        }
    }

    @ViewBuilder
    private var titleHint: some View {
        let chosen = title.trimmingCharacters(in: .whitespacesAndNewlines)
        Group {
            if !chosen.isEmpty {
                Text("使用你填写的标题：《\(chosen)》")
            } else if let detected = detectedTitle {
                Text("✓ 识别首行为标题：《\(detected)》（可在上方修改）")
            } else if !trimmed.isEmpty {
                Text("首行含句末标点或超长，不作为标题 —— 将从正文自动取一句做标题")
            }
        }
        .font(.system(size: 11.5))
        .foregroundColor(.secondary)
    }

    private func loadFile(_ url: URL) {
        fileError = ""
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            guard data.count <= 4 * 1024 * 1024 else {
                fileError = "文件超过 4MB，请确认是纯文本文章"
                return
            }
            if let content = String(data: data, encoding: .utf8)
                ?? String(data: data, encoding: .isoLatin1) {
                if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    fileError = "文件是空的"
                } else {
                    text = content
                }
            } else {
                fileError = "无法按文本读取该文件"
            }
        } catch {
            fileError = "读取文件失败：\(error.localizedDescription)"
        }
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

/// 复习页占位（复习流实现后替换）。
struct ReviewPlaceholderView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    var body: some View {
        VStack(spacing: 10) {
            let stats = vm.stats
            if stats.total == 0 {
                Text("生词本还是空的")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(palette.text)
                Text("在阅读室里查词并点击「加入生词本」，复习卡会出现在这里。")
                    .font(.system(size: 12.5))
                    .foregroundColor(palette.textSecondary)
            } else {
                Text("复习功能即将开放")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(palette.text)
                Text("当前生词 \(stats.total) 个 · 到期 \(stats.dueNow) 个")
                    .font(.system(size: 12.5))
                    .foregroundColor(palette.textSecondary)
            }
            Button("返回阅读") { vm.openReading() }
                .controlSize(.small)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - 工具

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
