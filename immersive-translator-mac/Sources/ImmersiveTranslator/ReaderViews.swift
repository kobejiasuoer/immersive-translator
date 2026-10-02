import SwiftUI
import UniformTypeIdentifiers
import ReaderCore
import XfyunCore

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
        .overlay {
            if vm.bookTocShown, let book = vm.currentBook {
                BookTocView(vm: vm, book: book)
            }
        }
        .overlay {
            if let chapterEnd = vm.chapterEnd {
                ChapterEndCardView(vm: vm, summary: chapterEnd)
            }
        }
        // 跟读报告卡（failed 相位浮在 PlayBar 上方）与差词抽屉（遮罩盖住 PlayBar）：
        // 均 wrapper 直观察控制器（ShadowReportOverlay / ShadowDrillOverlay），
        // 不依赖 vm 重渲；抽屉在报告卡之上。
        .overlay(alignment: .bottom) {
            ShadowReportOverlay(vm: vm)
        }
        .overlay {
            ShadowDrillOverlay(vm: vm)
        }
        // toast 置顶：差词抽屉的提示（没听到声音/未配置凭据…）不能被抽屉 sheet 盖住
        .overlay(alignment: .bottom) {
            if !vm.toast.isEmpty {
                ReaderToast(text: vm.toast, action: vm.toastAction)
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
            } else if vm.route == .speak {
                SpeakView(vm: vm, controller: vm.speak)
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
    /// 阅读目标配置（ReviewTouchpointManager.config.readGoalMin；提醒设置组同源）。
    @ObservedObject private var touchpoint = ReviewTouchpointManager.shared
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
                .help("导入文章 / 整本 EPUB")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            ScrollView {
                VStack(spacing: 2) {
                    if !vm.bookList.isEmpty {
                        ForEach(vm.bookList) { book in
                            BookShelfRow(
                                book: book,
                                active: vm.article?.bookId == book.id,
                                onSelect: { vm.openBookAt(bookId: book.id) },
                                onDelete: { vm.deleteBook(bookId: book.id) }
                            )
                        }
                        if !vm.articleList.isEmpty {
                            Text("短文")
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundColor(palette.textTertiary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 4)
                                .padding(.top, 8)
                        }
                    }
                    if vm.bookList.isEmpty && vm.articleList.isEmpty {
                        Text("还没有文章。\n点右上角 ＋ 导入整本 EPUB，或在网页或文档里选中文字，点浮窗上的「发送到阅读室」，或使用菜单栏的「沉浸阅读室」。")
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
                    vm.openSpeak()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "bubble.left.and.bubble.right").font(.system(size: 12))
                        Text("口语陪练").font(.system(size: 12.5))
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundColor(palette.text)
                .help("场景对话开口说：点餐 / 面试 / 旅行 / 寒暄")

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

                ShelfTodayCard(
                    reviewedToday: stats.reviewedToday,
                    dueNow: dueNow,
                    streak: stats.streak,
                    readSecondsToday: vm.readSecondsToday,
                    goalMin: touchpoint.config.readGoalMin,
                    onGoReview: { vm.openReview() }
                )
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .background(palette.surfaceAlt)
    }
}

/// 今日已读 M/N 分钟 + 目标进度条（每日阅读目标；对齐 Windows TodayCard 的 today-read）。
private struct ReadingGoalProgress: View {
    /// 今日已读秒数（M 按分钟四舍五入展示）。
    let seconds: Double
    let goalMin: Int
    @Environment(\.readerPalette) private var palette

    private var minutes: Int { max(0, Int((seconds / 60).rounded())) }
    private var percent: Double {
        goalMin > 0 ? min(1, max(0, seconds / (Double(goalMin) * 60))) : 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("今日已读 \(minutes)/\(goalMin) 分钟")
                .font(.system(size: 11))
                .foregroundColor(palette.textTertiary)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(palette.border.opacity(0.5))
                    Capsule()
                        .fill(percent >= 1 ? palette.ok : palette.accent)
                        .frame(width: max(0, geo.size.width * percent))
                }
            }
            .frame(height: 4)
        }
        .help("阅读时长：朗读播放与停留阅读均计入")
        .accessibilityElement(children: .combine)
        .accessibilityLabel("今日已读 \(minutes) 分钟，目标 \(goalMin) 分钟")
    }
}

/// 书架左栏今日卡（对齐 Windows TodayCard.tsx）：进度环 + 主行 + 副行 +
/// 每日阅读目标条 + 「继续复习」按钮；todayTotal == 0 走空态（空文案 + 目标条）。
/// 无障碍信息由主行文字承载，进度环纯装饰。
private struct ShelfTodayCard: View {
    let reviewedToday: Int
    let dueNow: Int
    let streak: Int
    let readSecondsToday: Double
    let goalMin: Int
    let onGoReview: () -> Void
    @Environment(\.readerPalette) private var palette

    private var todayTotal: Int { reviewedToday + dueNow }

    var body: some View {
        if todayTotal == 0 {
            VStack(alignment: .leading, spacing: 6) {
                Text("今日没有到期生词，去阅读里攒几个吧。")
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
                if goalMin > 0 {
                    ReadingGoalProgress(seconds: readSecondsToday, goalMin: goalMin)
                }
            }
        } else {
            HStack(alignment: .center, spacing: 10) {
                progressRing
                VStack(alignment: .leading, spacing: 4) {
                    Text("今日复习 \(reviewedToday) / \(todayTotal) · 连续打卡 \(streak) 天")
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                    Text(dueNow > 0 ? "还差 \(dueNow) 个清空今天到期" : "今天的到期已清空 ✓")
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                    if goalMin > 0 {
                        ReadingGoalProgress(seconds: readSecondsToday, goalMin: goalMin)
                    }
                    if dueNow > 0 {
                        Button("继续复习", action: onGoReview)
                            .controlSize(.small)
                            .buttonStyle(.borderedProminent)
                    }
                }
            }
        }
    }

    /// 环心「已复习/总数」，进度 = reviewedToday / (reviewedToday + dueNow)。
    private var progressRing: some View {
        let progress = todayTotal > 0 ? Double(reviewedToday) / Double(todayTotal) : 0
        return ZStack {
            Circle()
                .stroke(palette.border.opacity(0.6), lineWidth: 3.5)
            Circle()
                .trim(from: 0, to: progress)
                .stroke(palette.accent, style: StrokeStyle(lineWidth: 3.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text("\(reviewedToday)/\(todayTotal)")
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundColor(palette.text)
        }
        .frame(width: 46, height: 46)
        .accessibilityHidden(true)
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

// MARK: - 书架书卡（整本书：封面 + 章进度 + 断点直达）

private struct BookShelfRow: View {
    let book: BookMeta
    let active: Bool
    let onSelect: () -> Void
    let onDelete: () -> Void
    @Environment(\.readerPalette) private var palette
    @State private var hover = false

    var body: some View {
        let chapterIdx = bookChapterIndexOf(book: book, chapterId: book.progress.chapterId)
        let percent = Int(bookOverallPercent(book: book).rounded())
        HStack(spacing: 8) {
            Group {
                if let cover = BookCoverImage.image(fromDataURL: book.cover) {
                    Image(nsImage: cover)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } else {
                    Text(String(book.title.prefix(1)).uppercased())
                        .font(.system(size: 13, weight: .bold, design: .serif))
                        .foregroundColor(.white)
                }
            }
            .frame(width: 26, height: 38)
            .background(
                LinearGradient(
                    colors: [Color(hue: 0.08, saturation: 0.55, brightness: 0.82), Color(hue: 0.02, saturation: 0.5, brightness: 0.68)],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                )
            )
            .clipShape(RoundedRectangle(cornerRadius: 4))

            VStack(alignment: .leading, spacing: 2) {
                Text(book.title)
                    .font(.system(size: 12.5, weight: .medium, design: .serif))
                    .foregroundColor(active ? palette.accent : palette.text)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(book.title)
                Text("\(book.author.map { "\($0) · " } ?? "")第 \(min(chapterIdx + 1, book.chapters.count))/\(book.chapters.count) 章")
                    .font(.system(size: 10.5))
                    .foregroundColor(palette.textTertiary)
                    .lineLimit(1)
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(palette.border.opacity(0.4))
                        Capsule()
                            .fill(palette.accent)
                            .frame(width: max(0, geo.size.width * CGFloat(percent) / 100))
                    }
                }
                .frame(height: 3)
            }
            Text("\(percent)%")
                .font(.system(size: 10.5))
                .foregroundColor(palette.textTertiary)
            if hover {
                Button(action: confirmDelete) {
                    Image(systemName: ReaderIcons.trash)
                        .font(.system(size: 10))
                        .foregroundColor(palette.textTertiary)
                }
                .buttonStyle(.plain)
                .help("删除这本书（章文章与进度删除，生词保留）")
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
        alert.messageText = "删除《\(book.title)》？"
        alert.informativeText = "将删除全部 \(book.chapters.count) 章内容与这本书的阅读进度，不可恢复；生词本不受影响。"
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
        VStack(spacing: 0) {
            if let article = vm.article {
                ReaderScroll(article: article, vm: vm, editingIdx: $editingIdx, editDraft: $editDraft)
                // 短文结课条：读完后的本篇收获快照，常驻底部直到关闭。
                if let finish = vm.finishCard, article.id == finish.articleId {
                    Divider().opacity(0.5)
                    ReaderFinishBarView(vm: vm, summary: finish)
                }
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

    /// 正文末「读完本篇/本章」按钮（纯手动阅读路径）：与自然播完走同一落点。
    private var finishActionRow: some View {
        HStack(spacing: 10) {
            Button(vm.finishActionLabel) {
                vm.confirmFinishRead()
            }
            .buttonStyle(.borderedProminent)
            Text("已到文章末尾：确认读完，整理本篇收获或稍后复习。")
                .font(.system(size: 11.5))
                .foregroundColor(palette.textTertiary)
        }
        .padding(.top, 20)
        .padding(.horizontal, 24)
        .frame(maxWidth: 760, alignment: .leading)
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
                        if vm.showFinishAction {
                            finishActionRow
                        }
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
                if let bookId = article.bookId, let book = vm.bookList.first(where: { $0.id == bookId }) {
                    HStack(spacing: 6) {
                        Text("《\(book.title)》· 第 \(bookChapterIndexOf(book: book, chapterId: article.id) + 1)/\(book.chapters.count) 章")
                            .font(.system(size: 12))
                            .foregroundColor(palette.textSecondary)
                            .lineLimit(1)
                            .help(book.title)
                        Button {
                            vm.bookTocShown = true
                        } label: {
                            Label("目录", systemImage: "list.bullet")
                                .font(.system(size: 11, weight: .medium))
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .help("本书目录：各章词数与已收藏生词数，点章即跳")
                    }
                }
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
            onChunkClick: { chunk in vm.openChunkCard(chunk: chunk, sentenceIdx: pair.idx) },
            assessMarks: pair.idx == vm.activeSentenceIdx ? vm.assess.state.marks : nil
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
    /// 系统输入设备列表（onAppear 时枚举一次，对齐 Windows 挂载时 listMicDevices）。
    @State private var micDevices: [(uid: String, name: String)] = []

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
                            .help("Edge 在线 = 微软神经音色（免费、无需凭据，默认）；讯飞在线 = 云音色需凭据；本地 = 系统语音（离线可用）")
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
                            } else if settings.ttsProvider == .edge {
                                VStack(alignment: .leading, spacing: 6) {
                                    edgeVoiceField(label: "中文音色", text: settings.edgeVoiceZh, placeholder: EdgeTts.defaultVoice) { value in
                                        vm.patchSettings { $0.edgeVoiceZh = value }
                                    }
                                    edgeVoiceField(label: "英文音色", text: settings.edgeVoiceEn, placeholder: EdgeTts.defaultVoiceEn) { value in
                                        vm.patchSettings { $0.edgeVoiceEn = value }
                                    }
                                    HStack {
                                        rowLabel("服务说明")
                                        Text("免费 · 无需凭据 · 需联网")
                                            .font(.system(size: 11.5))
                                            .foregroundColor(palette.textSecondary)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    .help("Edge 在线合成为微软「大声朗读」同源服务，免费且无需账号；属非官方接口，偶发不可用时朗读自动回落系统语音，也可切回讯飞或本地")
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

                            // 麦克风选择：无条件显示（不嵌进跟读开关块，Windows 该行也在条件块外）。
                            // 跟读评测 / 口语陪练 / 影子跟读生效；录音直译恒用默认。
                            HStack {
                                rowLabel("麦克风")
                                Picker("麦克风", selection: Binding(
                                    get: { MicDevicePreference.savedUID },
                                    set: { MicDevicePreference.save($0) }
                                )) {
                                    Text("系统默认").tag("")
                                    ForEach(micDevices, id: \.uid) { device in
                                        Text(device.name).tag(device.uid)
                                    }
                                }
                                .labelsHidden()
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .help("跟读录音用的麦克风；录不出声音时优先换一个（默认可能选到虚拟声卡）")

                            groupTitle("提醒")
                            ReminderSectionView()

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
        .onAppear {
            // 挂载时枚举一次系统输入设备（仅 CoreAudio 枚举，不触发麦克风权限弹窗）。
            micDevices = MicRecorder.availableMicDevices().map { (uid: $0.uid, name: $0.name) }
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

    /// Edge 音色输入框 + 建议菜单（Menu 弹层替代 Windows 的 input datalist）。
    private func edgeVoiceField(label: String, text: String, placeholder: String, onCommit: @escaping (String) -> Void) -> some View {
        HStack {
            rowLabel(label)
            TextField(placeholder, text: Binding(
                get: { text },
                set: { value in onCommit(value) }
            ))
            .textFieldStyle(.roundedBorder)
            .font(.system(size: 11.5))
            .frame(maxWidth: .infinity)
            Menu {
                ForEach(EdgeTts.voiceSuggestions, id: \.voice) { suggestion in
                    Button(suggestion.label) { onCommit(suggestion.voice) }
                }
            } label: {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(palette.textSecondary)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
        .help("Edge 音色 ShortName（微软神经音色）；留空 = 默认音色（中文晓晓 / 英文 Ava），男声推荐 AndrewNeural。已播句子进缓存（内存+磁盘），重听不再请求网络")
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
    var action: ToastAction?

    var body: some View {
        HStack(spacing: 10) {
            Text(text)
                .font(.system(size: 12.5))
                .foregroundColor(.white)
                .multilineTextAlignment(.leading)
            if let action {
                Button {
                    action.handler()
                } label: {
                    Text(action.title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.black)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 3)
                        .background(Color.white.opacity(0.92), in: Capsule())
                }
                .buttonStyle(.plain)
                .help(action.title)
            }
        }
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
                if vm.shadowingWait, vm.assessActive {
                    AssessStripView(vm: vm, assess: vm.assess)
                } else if vm.shadowingWait {
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

// MARK: - 书内目录弹层

/// 书目录弹层（BookTocModal.tsx 的 Mac 对应物）：这本书有哪些章、每章多少词
/// 多少生词，标注当前章，点章即跳。从文章头章节栏「目录」按钮打开。
struct BookTocView: View {
    @ObservedObject var vm: ReaderViewModel
    let book: BookMeta
    @Environment(\.readerPalette) private var palette

    private var currentChapterId: String? { vm.article?.id }

    private var overallPercent: Int {
        Int(bookOverallPercent(book: book).rounded())
    }

    /// 每章已收藏生词数（VocabWord.source.articleId → BookChapterMeta.id 归堆）。
    private var vocabCountByChapter: [String: Int] {
        var counts: [String: Int] = [:]
        for word in vm.vocabWords {
            counts[word.source.articleId, default: 0] += 1
        }
        return counts
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.32)
                .contentShape(Rectangle())
                .onTapGesture { vm.bookTocShown = false }
            VStack(alignment: .leading, spacing: 0) {
                header
                Divider().opacity(0.5)
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(Array(book.chapters.enumerated()), id: \.element.id) { idx, chapter in
                            BookTocRow(
                                index: idx + 1,
                                chapter: chapter,
                                vocabCount: vocabCountByChapter[chapter.id] ?? 0,
                                current: chapter.id == currentChapterId,
                                onSelect: { vm.openArticle(id: chapter.id) }
                            )
                        }
                    }
                    .padding(10)
                }
            }
            .frame(width: 480, height: 540)
            .background(palette.surface)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.22), radius: 18, y: 6)
            .onExitCommand { vm.bookTocShown = false }
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Group {
                if let cover = BookCoverImage.image(fromDataURL: book.cover) {
                    Image(nsImage: cover)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } else {
                    Text(String(book.title.prefix(1)).uppercased())
                        .font(.system(size: 20, weight: .bold, design: .serif))
                        .foregroundColor(.white)
                }
            }
            .frame(width: 52, height: 74)
            .background(
                LinearGradient(
                    colors: [Color(hue: 0.08, saturation: 0.55, brightness: 0.82), Color(hue: 0.02, saturation: 0.5, brightness: 0.68)],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                )
            )
            .clipShape(RoundedRectangle(cornerRadius: 6))

            VStack(alignment: .leading, spacing: 5) {
                Text("《\(book.title)》")
                    .font(.system(size: 16, weight: .semibold, design: .serif))
                    .foregroundColor(palette.text)
                    .lineLimit(2)
                Text("\(book.author.map { "\($0) · " } ?? "")\(book.chapters.count) 章 · 总进度 \(overallPercent)%")
                    .font(.system(size: 11.5))
                    .foregroundColor(palette.textSecondary)
                Text("考研词 \(book.radar.kaoyan) · 四级词 \(book.radar.cet4) · 六级词 \(book.radar.cet6)")
                    .font(.system(size: 10.5))
                    .foregroundColor(palette.textTertiary)
            }
            Spacer(minLength: 8)
            Button {
                vm.bookTocShown = false
            } label: {
                Image(systemName: ReaderIcons.close)
                    .font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(.plain)
            .foregroundColor(palette.textSecondary)
            .help("关闭目录 (Esc)")
        }
        .padding(16)
    }
}

/// 目录里的单章行：序号 + 章名 + 词数/句数/生词数/当前章。
private struct BookTocRow: View {
    let index: Int
    let chapter: BookChapterMeta
    let vocabCount: Int
    let current: Bool
    let onSelect: () -> Void
    @Environment(\.readerPalette) private var palette
    @State private var hover = false

    private var metaText: String {
        var parts = ["\(chapter.wordCount) 词", "\(chapter.sentenceCount) 句"]
        if vocabCount > 0 { parts.append("\(vocabCount) 生词") }
        if current { parts.append("当前章") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: 10) {
            Text("\(index)")
                .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                .foregroundColor(current ? .white : palette.textTertiary)
                .frame(width: 20, height: 20)
                .background(current ? palette.accent : Color.clear)
                .clipShape(Circle())
            Text(chapter.title)
                .font(.system(size: 12.5, design: .serif))
                .foregroundColor(current ? palette.accent : palette.text)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(chapter.title)
            Spacer(minLength: 8)
            Text(metaText)
                .font(.system(size: 10.5))
                .foregroundColor(palette.textTertiary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            current ? palette.accent.opacity(0.1)
                : (hover ? palette.border.opacity(0.25) : Color.clear)
        )
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture(perform: onSelect)
    }
}

// MARK: - 章末小结卡

/// 书章读完的小结卡（自然播完末句 / 手动「读完本章」触发）：
/// 本章查词、收录生词、到期词、用时，以及下一章 / 复习本章 / 整理笔记入口。
struct ChapterEndCardView: View {
    @ObservedObject var vm: ReaderViewModel
    let summary: ReaderViewModel.ChapterEndSummary
    @Environment(\.readerPalette) private var palette

    var body: some View {
        ZStack {
            Color.black.opacity(0.4)
                .contentShape(Rectangle())
                .onTapGesture { vm.dismissChapterEnd() }
            VStack(spacing: 14) {
                Text("🎉")
                    .font(.system(size: 30))
                Text("第 \(summary.chapterIdx + 1) 章读完")
                    .font(.system(size: 17, weight: .semibold, design: .serif))
                    .foregroundColor(palette.text)
                Text("《\(summary.bookTitle)》 · \(summary.chapterIdx + 1)/\(summary.chapterCount) 章")
                    .font(.system(size: 12))
                    .foregroundColor(palette.textSecondary)
                HStack(spacing: 16) {
                    stat("查词", "\(summary.lookups) 次")
                    stat("本章收录", "\(summary.collected) 词")
                    stat("本章用时", "\(summary.minutes) 分钟")
                }
                if summary.lastChapter {
                    Text("全书读完，恭喜！这些生词都已在复习闭环里了。")
                        .font(.system(size: 11.5))
                        .foregroundColor(palette.ok)
                        .multilineTextAlignment(.center)
                } else if let nextTitle = summary.nextChapterTitle {
                    Text("下一章：\(nextTitle)")
                        .font(.system(size: 11.5))
                        .foregroundColor(palette.textTertiary)
                        .lineLimit(1)
                }
                if summary.collected > 0 || !summary.dueIds.isEmpty {
                    HStack(spacing: 8) {
                        if summary.collected > 0 {
                            Button {
                                vm.noteChapterWords()
                            } label: {
                                Text("整理本章笔记").font(.system(size: 12))
                            }
                            .controlSize(.small)
                            .help("把本章这批词预选进复习笔记生成弹窗")
                        }
                        if !summary.dueIds.isEmpty {
                            Button {
                                vm.reviewChapterWords()
                            } label: {
                                Text("复习本章 \(summary.dueIds.count) 词").font(.system(size: 12))
                            }
                            .controlSize(.small)
                            .buttonStyle(.borderedProminent)
                            .help("只复习本章已到期的词，不打乱其他词的复习计划")
                        }
                    }
                }
                Divider().opacity(0.5)
                HStack(spacing: 8) {
                    Button("留在本章") {
                        vm.dismissChapterEnd()
                    }
                    .controlSize(.small)
                    if summary.nextChapterId != nil {
                        Button("开始下一章") {
                            vm.openNextChapter()
                        }
                        .controlSize(.small)
                        .buttonStyle(.borderedProminent)
                    }
                }
            }
            .padding(22)
            .frame(width: 360)
            .background(palette.surface)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .shadow(color: .black.opacity(0.24), radius: 20, y: 8)
        }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        HStack(spacing: 4) {
            Text(label)
                .font(.system(size: 11.5))
                .foregroundColor(palette.textTertiary)
            Text(value)
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundColor(palette.text)
        }
    }
}

// MARK: - 短文结课条

/// 短文读完的常驻结课条（替代一闪而过的 toast）：本篇收获快照 +
/// 笔记/复习入口，「继续阅读」关闭。只对短文（无 bookId）显示。
struct ReaderFinishBarView: View {
    @ObservedObject var vm: ReaderViewModel
    let summary: ReaderViewModel.ArticleFinishSummary
    @Environment(\.readerPalette) private var palette

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: ReaderIcons.book)
                .font(.system(size: 12))
                .foregroundColor(palette.accent)
            Text(finishText)
                .font(.system(size: 12))
                .foregroundColor(palette.text)
                .lineLimit(1)
            Spacer(minLength: 12)
            if summary.collected > 0 {
                Button {
                    vm.noteFinishCardWords()
                } label: {
                    Text("整理本篇复习笔记").font(.system(size: 12))
                }
                .controlSize(.small)
                .help("把这批词预选进复习笔记生成弹窗")
            }
            if summary.dueCount > 0 {
                Button {
                    vm.reviewFinishCardWords()
                } label: {
                    Text("复习本篇 \(summary.dueCount) 词").font(.system(size: 12))
                }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
                .help("只复习本篇已到期的词，不打乱其他词的复习计划")
            }
            Button("继续阅读") {
                vm.dismissFinishCard()
            }
            .controlSize(.small)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(palette.accent.opacity(0.08))
    }

    private var finishText: String {
        var text = "本篇读完 🎉 共查词 \(summary.lookups) 次 · 收录 \(summary.collected) 个词块和生词"
        if summary.dueCount > 0 {
            text += "，其中 \(summary.dueCount) 个待复习"
        }
        return text
    }
}

/// 提醒设置组（触点管理器的 config，存 review_reminder.json）。
struct ReminderSectionView: View {
    @ObservedObject private var manager = ReviewTouchpointManager.shared
    @Environment(\.readerPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                rowLabelView("每日提醒")
                Toggle("", isOn: Binding(
                    get: { manager.config.enabled },
                    set: { value in manager.config.enabled = value }
                ))
                .toggleStyle(.switch)
                .labelsHidden()
            }
            if manager.config.enabled {
                HStack {
                    rowLabelView("提醒时间")
                    Picker("", selection: Binding(
                        get: { manager.config.minuteOfDay },
                        set: { value in manager.config.minuteOfDay = value }
                    )) {
                        ForEach(stride(from: reminderMinuteOfDayMin, through: reminderMinuteOfDayMax, by: 30).map { $0 }, id: \.self) { minute in
                            Text(reminderMinuteLabel(minute)).tag(minute)
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                HStack {
                    rowLabelView("夜间免打扰")
                    Toggle("", isOn: Binding(
                        get: { manager.config.dndEnabled },
                        set: { value in manager.config.dndEnabled = value }
                    ))
                    .toggleStyle(.switch)
                    .labelsHidden()
                    if manager.config.dndEnabled {
                        Text("\(reminderMinuteLabel(manager.config.dndStartMin)) – \(reminderMinuteLabel(manager.config.dndEndMin))")
                            .font(.system(size: 10.5))
                            .foregroundColor(palette.textTertiary)
                    }
                }
            }
            HStack {
                rowLabelView("阅读目标")
                Picker("", selection: Binding(
                    get: { manager.config.readGoalMin },
                    set: { value in manager.config.readGoalMin = value }
                )) {
                    ForEach([5, 10, 15, 20, 30, 45, 60], id: \.self) { minutes in
                        Text("\(minutes) 分钟/天").tag(minutes)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func rowLabelView(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11.5))
            .foregroundColor(palette.textSecondary)
            .frame(width: 76, alignment: .leading)
    }
}
