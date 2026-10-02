import SwiftUI
import UniformTypeIdentifiers
import ReaderCore

// MARK: - 导入弹窗（内容进水口）：五个入口
//
// 内置文库（默认）/ 整本 EPUB·长书 / 本地文件（docx·pdf·txt）/ 网页链接抓取 / 粘贴文本。
// 对齐 Windows ImportDialog.tsx：
// - 文库：今日一篇 hero + 分级书单，覆盖数随「考试目标」联动（考研/四级/六级），
//   未掌握数与生词本 SRS 状态同源（intervalDays < 7）。
// - EPUB/长书：整本书导入建书——拖入 .epub（或长 .txt/.docx/.pdf）→ 解析目录
//   分章 → 章列表勾选 → 预览书名/作者/总词数/时长/覆盖 → 确认整本入库，
//   落盘走 ReaderStore.saveBook（books/<bookId>.json）。
// - 文件：docx 抽正文段落、pdf 抽文本层（PDFKit），扫描件/无文本层给明确报错
//   引导走粘贴，预览后入库。
// - 链接：应用层抓正文（去导航/广告），预览（词数/时长/难度/覆盖），
//   失败态给出原因与「切到粘贴文本」退路。
// - 粘贴：原有能力原样保留。⌘↩ 直接开始（粘贴页）。

struct ReaderImportSheet: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var tab: IntakeTab = .lib
    @State private var goal: ExamGoal = IntakeService.shared.examGoal

    enum IntakeTab: String, CaseIterable {
        case lib = "内置文库"
        case epub = "EPUB / 长书"
        case file = "本地文件"
        case url = "网页链接"
        case paste = "粘贴文本"
    }

    /// 书架上已有的文库条目 id（sourceUrl 形如 "library:<id>"）。
    private var shelfLibIds: Set<String> {
        var ids = Set<String>()
        for summary in vm.articleList {
            if let sourceUrl = summary.article.sourceUrl, sourceUrl.hasPrefix("library:") {
                ids.insert(String(sourceUrl.dropFirst("library:".count)))
            }
        }
        return ids
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            tabBar
            Divider()
            Group {
                switch tab {
                case .lib:
                    IntakeLibraryTab(vm: vm, goal: $goal, shelfLibIds: shelfLibIds) {
                        dismiss()
                    }
                case .epub:
                    IntakeBookTab(vm: vm, goal: $goal, onImported: {
                        dismiss()
                    }) {
                        tab = .paste
                    }
                case .file:
                    IntakeFileTab(vm: vm, goal: $goal, onImported: {
                        dismiss()
                    }) {
                        tab = .paste
                    }
                case .url:
                    IntakeUrlTab(vm: vm, goal: $goal, onImported: {
                        dismiss()
                    }) {
                        tab = .paste
                    }
                case .paste:
                    IntakePasteTab(vm: vm) {
                        dismiss()
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: 640, height: 600)
        .onChange(of: goal) { newValue in
            IntakeService.shared.examGoal = newValue
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("添加阅读内容").font(.system(size: 15, weight: .semibold))
                Text("从文库挑一篇、导入整本 EPUB、导入 Word / PDF 文件、抓一篇网页文章，或粘贴自己的文本 —— 入库后逐句精读，生词自动进生词本")
                    .font(.system(size: 11.5))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.secondary)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
        }
        .padding(16)
    }

    private var tabBar: some View {
        HStack(spacing: 4) {
            ForEach(IntakeTab.allCases, id: \.self) { item in
                Button {
                    tab = item
                    // 本地埋点：切到「EPUB / 长书」tab（对齐 Windows ImportDialog 的
                    // epub_import_intent，初始 tab 是内置文库，进 epub 必经此处）。
                    if item == .epub {
                        ReaderTelemetry.track(.epubImportIntent(entry: "tab"))
                    }
                } label: {
                    Text(item.rawValue)
                        .font(.system(size: 12, weight: tab == item ? .semibold : .regular))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(
                            tab == item
                                ? Color.accentColor.opacity(0.14)
                                : Color.clear
                        )
                        .foregroundColor(tab == item ? .accentColor : .secondary)
                        .clipShape(RoundedRectangle(cornerRadius: 7))
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }
}

// MARK: - 考试目标行（文件 / URL / 文库共用）

struct IntakeGoalRow: View {
    @Binding var goal: ExamGoal

    var body: some View {
        HStack(spacing: 6) {
            Text("按考试目标看覆盖：")
                .font(.system(size: 11.5))
                .foregroundColor(.secondary)
            ForEach(ExamGoal.allCases, id: \.self) { g in
                Button {
                    goal = g
                } label: {
                    Text(g.label)
                        .font(.system(size: 11.5, weight: goal == g ? .semibold : .regular))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 3)
                        .background(
                            goal == g ? Color.orange.opacity(0.18) : Color.secondary.opacity(0.1)
                        )
                        .foregroundColor(goal == g ? .orange : .secondary)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
    }
}

// MARK: - 内置文库

private struct IntakeLibraryTab: View {
    @ObservedObject var vm: ReaderViewModel
    @Binding var goal: ExamGoal
    let shelfLibIds: Set<String>
    let onImported: () -> Void

    private var hero: IntakeLibraryItem? {
        todayLibraryItem(IntakeService.shared.library)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let hero {
                    IntakeLibraryHero(
                        item: hero,
                        cov: coverageForText(hero.text, goal: goal, vocab: vm.vocabWords, wordlists: IntakeService.shared.wordlists),
                        goal: goal,
                        owned: shelfLibIds.contains(hero.id)
                    ) {
                        importItem(hero)
                    }
                }
                IntakeGoalRow(goal: $goal)
                bookList
                Text("文库文本取自公版书（Standard Ebooks 整理本）；覆盖数 = 篇内出现的大纲词个数，橙色为你生词本里还没掌握的。更多篇目与词表陆续接入。")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(16)
        }
    }

    private var bookList: some View {
        VStack(spacing: 8) {
            ForEach(IntakeService.shared.library.filter { $0.id != hero?.id }) { item in
                IntakeLibraryRow(
                    item: item,
                    cov: coverageForText(item.text, goal: goal, vocab: vm.vocabWords, wordlists: IntakeService.shared.wordlists),
                    goal: goal,
                    owned: shelfLibIds.contains(item.id)
                ) {
                    importItem(item)
                }
            }
        }
    }

    private func importItem(_ item: IntakeLibraryItem) {
        onImported()
        vm.importText(
            item.text,
            title: item.en,
            meta: ImportMeta(
                sourceType: .paste,
                sourceUrl: "library:\(item.id)",
                level: item.level,
                titleCn: "\(item.cn) · \(item.author)"
            )
        )
    }
}

private struct IntakeLibraryHero: View {
    let item: IntakeLibraryItem
    let cov: CoverageStats
    let goal: ExamGoal
    let owned: Bool
    let onImport: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Text(String(item.en.prefix(1)))
                .font(.system(size: 26, weight: .bold, design: .serif))
                .foregroundColor(.white)
                .frame(width: 56, height: 56)
                .background(
                    LinearGradient(
                        colors: [Color(hue: 0.08, saturation: 0.55, brightness: 0.82), Color(hue: 0.02, saturation: 0.5, brightness: 0.68)],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    )
                )
                .clipShape(RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(item.level)
                        .font(.system(size: 10.5, weight: .semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.blue.opacity(0.14))
                        .foregroundColor(.blue)
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                    Text("今日一篇 · 每天换一篇，按你的生词本挑")
                        .font(.system(size: 10.5))
                        .foregroundColor(.secondary)
                }
                Text(item.en)
                    .font(.system(size: 16, weight: .semibold, design: .serif))
                Text("\(item.cn) · \(item.author)")
                    .font(.system(size: 11.5))
                    .foregroundColor(.secondary)
                Text("“\(item.quote)”")
                    .font(.system(size: 11.5, design: .serif))
                    .foregroundColor(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    Text("\(goal.label)大纲词 \(cov.total)")
                        .font(.system(size: 11))
                    if cov.unmastered > 0 {
                        Text("· \(cov.unmastered) 个未掌握")
                            .font(.system(size: 11))
                            .foregroundColor(.orange)
                    }
                    Text("\(item.words) 词 · 约 \(item.minutes) 分钟")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                }
                HStack(spacing: 10) {
                    Button {
                        onImport()
                    } label: {
                        Text(owned ? "已在书架" : "开始阅读")
                            .font(.system(size: 12, weight: .semibold))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 6)
                            .background(Color.accentColor)
                            .foregroundColor(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 7))
                    }
                    .buttonStyle(.plain)
                    .disabled(owned)
                    Text(
                        cov.unmastered > 0
                            ? "其中 \(cov.unmastered) 个词在你的生词本里"
                            : "与你的生词本几乎没有重合，适合轻松读"
                    )
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
                }
            }
        }
        .padding(14)
        .background(Color.secondary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

private struct IntakeLibraryRow: View {
    let item: IntakeLibraryItem
    let cov: CoverageStats
    let goal: ExamGoal
    let owned: Bool
    let onImport: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Text(item.level)
                .font(.system(size: 10.5, weight: .semibold))
                .frame(width: 34)
                .padding(.vertical, 2)
                .background(Color.blue.opacity(0.14))
                .foregroundColor(.blue)
                .clipShape(RoundedRectangle(cornerRadius: 5))
            VStack(alignment: .leading, spacing: 1) {
                Text(item.en)
                    .font(.system(size: 13, weight: .medium, design: .serif))
                Text("\(item.cn) · \(item.author)")
                    .font(.system(size: 11))
                    .foregroundColor(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 1) {
                Text("\(item.words) 词")
                    .font(.system(size: 11))
                Text("约 \(item.minutes) 分钟")
                    .font(.system(size: 10.5))
                    .foregroundColor(.secondary)
            }
            Text("\(goal.label)大纲词 \(cov.total) · \(cov.unmastered) 未掌握")
                .font(.system(size: 11))
                .foregroundColor(cov.unmastered > 0 ? .orange : .secondary)
            Button {
                onImport()
            } label: {
                Text(owned ? "已在书架" : "加入书架")
                    .font(.system(size: 11.5))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(owned ? Color.clear : Color.accentColor.opacity(0.12))
                    .foregroundColor(owned ? .secondary : .accentColor)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .strokeBorder(owned ? Color.secondary.opacity(0.3) : Color.accentColor.opacity(0.4))
                    )
            }
            .buttonStyle(.plain)
            .disabled(owned)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Color.secondary.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 9))
    }
}

// MARK: - 封面 dataURL ↔ NSImage（书卡 / 预览共用）

enum BookCoverImage {
    /// dataURL（data:image/png;base64,...）→ NSImage；失败返回 nil。
    static func image(fromDataURL dataUrl: String?) -> NSImage? {
        guard let dataUrl, let commaIdx = dataUrl.firstIndex(of: ",") else { return nil }
        guard let data = Data(base64Encoded: String(dataUrl[dataUrl.index(after: commaIdx)...])) else {
            return nil
        }
        return NSImage(data: data)
    }

    /// 封面缩小为 ≤160×240 的 JPEG dataURL（书卡/索引保持轻量；
    /// 对齐 Windows downscaleCoverDataUrl，失败返回 nil 由调用方退回原图或无封面）。
    static func downscaleToDataUrl(_ dataUrl: String, maxW: CGFloat = 160, maxH: CGFloat = 240) -> String? {
        guard let image = image(fromDataURL: dataUrl) else { return nil }
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }
        let scale = min(maxW / size.width, maxH / size.height, 1)
        let w = max(1, round(size.width * scale))
        let h = max(1, round(size.height * scale))
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(w),
            pixelsHigh: Int(h),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { return nil }
        rep.size = NSSize(width: w, height: h)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(
            in: NSRect(origin: .zero, size: NSSize(width: w, height: h)),
            from: NSRect(origin: .zero, size: size),
            operation: .copy,
            fraction: 1.0
        )
        NSGraphicsContext.restoreGraphicsState()
        guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.72]) else {
            return nil
        }
        return "data:image/jpeg;base64,\(jpeg.base64EncodedString())"
    }
}

// MARK: - 选书雷达的人话判定（口径：未掌握词占命中大纲词的比例）

func radarVerdict(unmastered: Int, covered: Int) -> String {
    if unmastered <= 0 { return "偏易 · 适合泛读冲刺" }
    let ratio = Double(unmastered) / Double(max(1, covered))
    if ratio <= 0.15 { return "略高于你的水平 · 适合精读" }
    if ratio <= 0.4 { return "偏难 · 挑战阅读，多用遮罩自测" }
    return "远超当前水平 · 建议先从分级文库起步"
}

func minutesLabel(_ minutes: Int) -> String {
    if minutes >= 60 { return "约 \(minutes / 60) 小时 \(minutes % 60) 分钟" }
    return "约 \(minutes) 分钟"
}

// MARK: - EPUB / 长书（整本书导入建书）

private struct IntakeBookTab: View {
    @ObservedObject var vm: ReaderViewModel
    @Binding var goal: ExamGoal
    let onImported: () -> Void
    let onSwitchToPaste: () -> Void

    private struct PreviewState {
        var book: EpubBook
        var fileName: String
        /// 勾选的章下标（默认全选；确认导入时只导所选）。
        var selected: Set<Int>
        /// 缩小后的封面 dataURL。
        var cover: String?
    }

    private enum Phase {
        case idle
        case parsing
        case preview(PreviewState)
        case error(String)
    }

    @State private var phase: Phase = .idle
    @State private var dragOver = false
    @State private var fileImporterShown = false

    private static var importTypes: [UTType] {
        var types: [UTType] = []
        if let epub = UTType(filenameExtension: "epub") ?? UTType(mimeType: "application/epub+zip") {
            types.append(epub)
        }
        types.append(contentsOf: [.plainText, .text, .pdf])
        if let docx = UTType(filenameExtension: "docx") ?? UTType("org.openxmlformats-officedocument.wordprocessingml.document") {
            types.append(docx)
        }
        return types
    }

    var body: some View {
        Group {
            switch phase {
            case .idle:
                dropZone
            case .parsing:
                parsingView
            case .error(let message):
                failView(message: message)
            case .preview(let state):
                previewView(state)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .fileImporter(
            isPresented: $fileImporterShown,
            allowedContentTypes: Self.importTypes,
            allowsMultipleSelection: false
        ) { result in
            if let url = try? result.get().first {
                parse(url: url)
            }
        }
    }

    private var dropZone: some View {
        VStack(spacing: 10) {
            Image(systemName: "book.closed")
                .font(.system(size: 30))
                .foregroundColor(.secondary)
            Text("拖入整本 .epub 电子书，或点击选择")
                .font(.system(size: 13, weight: .medium))
            Text("本地解析目录与章节正文，导入后按章精读：自动分章、断点续读、全书生词进复习闭环。\n受 DRM 保护的书无法解析（不会产出空书）；.mobi / .azw3 请先用 Calibre 转成 .epub。长 .txt / .docx / .pdf 也会按内容长度自动分节建书。")
                .font(.system(size: 11))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(24)
        .frame(maxWidth: 480)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(
                    dragOver ? Color.accentColor : Color.secondary.opacity(0.4),
                    style: StrokeStyle(lineWidth: 1.2, dash: [6, 4])
                )
                .background(
                    RoundedRectangle(cornerRadius: 12)
                        .fill(dragOver ? Color.accentColor.opacity(0.07) : Color.secondary.opacity(0.04))
                )
        )
        .contentShape(Rectangle())
        .onTapGesture { fileImporterShown = true }
        .onDrop(of: [.fileURL], isTargeted: $dragOver) { providers in
            guard let provider = providers.first else { return false }
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                DispatchQueue.main.async {
                    if let url { parse(url: url) }
                }
            }
            return true
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var parsingView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("正在解析电子书（目录 / 章节正文 / 封面）…")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func failView(message: String) -> some View {
        VStack(spacing: 10) {
            Text("没能读取这本电子书")
                .font(.system(size: 14, weight: .semibold))
            Text(message)
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("返回重选文件") { phase = .idle }
                    .controlSize(.small)
                Button("切到粘贴文本") {
                    phase = .idle
                    onSwitchToPaste()
                }
                    .controlSize(.small)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func previewView(_ state: PreviewState) -> some View {
        let book = state.book
        let fullText = book.chapters.map(\.text).joined(separator: "\n\n")
        let cov = coverageForText(fullText, goal: goal, vocab: vm.vocabWords, wordlists: IntakeService.shared.wordlists)
        let selectedCount = state.selected.count
        return ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                IntakeGoalRow(goal: $goal)
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .top, spacing: 12) {
                        Group {
                            if let coverImage = BookCoverImage.image(fromDataURL: state.cover) {
                                Image(nsImage: coverImage)
                                    .resizable()
                                    .aspectRatio(contentMode: .fill)
                            } else {
                                Text(String(book.title.prefix(1)).uppercased())
                                    .font(.system(size: 20, weight: .bold, design: .serif))
                                    .foregroundColor(.white)
                            }
                        }
                        .frame(width: 44, height: 64)
                        .background(
                            LinearGradient(
                                colors: [Color(hue: 0.08, saturation: 0.55, brightness: 0.82), Color(hue: 0.02, saturation: 0.5, brightness: 0.68)],
                                startPoint: .topLeading, endPoint: .bottomTrailing
                            )
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 7))
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(state.fileName) · 解析完成")
                                .font(.system(size: 11))
                                .foregroundColor(.secondary)
                            Text(book.title)
                                .font(.system(size: 15, weight: .semibold, design: .serif))
                            HStack(spacing: 8) {
                                if !book.author.isEmpty {
                                    Text(book.author)
                                        .font(.system(size: 11.5))
                                        .foregroundColor(.secondary)
                                }
                                Text("\(book.chapters.count) 章 · \(book.totalWords) 词 · \(minutesLabel(book.minutes))")
                                    .font(.system(size: 11.5))
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                    if !book.tocUsed, let notice = book.fallbackNotice {
                        Text("⚠︎ \(notice)")
                            .font(.system(size: 11))
                            .foregroundColor(.orange)
                    }
                    Text("覆盖\(goal.label)大纲词 \(cov.total)\(cov.unmastered > 0 ? " · 其中 \(cov.unmastered) 个你还没掌握" : "")")
                        .font(.system(size: 11.5))
                        .foregroundColor(cov.unmastered > 0 ? .orange : .secondary)
                    + Text("　\(radarVerdict(unmastered: cov.unmastered, covered: cov.total))")
                        .font(.system(size: 11.5))
                        .foregroundColor(.secondary)

                    HStack {
                        Text("选择要导入的章（默认全选）")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(.secondary)
                        Spacer()
                        Button("全选") { selectAllChapters() }
                            .controlSize(.small)
                        Button("清空") { selectNoneChapters() }
                            .controlSize(.small)
                    }
                    chapterList(state)
                    HStack {
                        Spacer()
                        Button("重新选择文件") { phase = .idle }
                            .controlSize(.small)
                        Button("导入所选 \(selectedCount) 章") {
                            confirmImport(state)
                        }
                            .controlSize(.small)
                            .buttonStyle(.borderedProminent)
                            .disabled(selectedCount == 0)
                    }
                }
                .padding(14)
                .background(Color.secondary.opacity(0.05))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .padding(16)
        }
    }

    private func chapterList(_ state: PreviewState) -> some View {
        let book = state.book
        return VStack(spacing: 2) {
            ForEach(book.chapters.indices, id: \.self) { i in
                let on = state.selected.contains(i)
                Button {
                    toggleChapter(i)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: on ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 12))
                            .foregroundColor(on ? .accentColor : .secondary)
                        Text(book.chapters[i].title)
                            .font(.system(size: 12.5, design: .serif))
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer()
                        Text("\(book.chapters[i].wordCount) 词 · \(minutesLabel(max(1, Int((Double(book.chapters[i].wordCount) / 135.0).rounded()))))")
                            .font(.system(size: 10.5))
                            .foregroundColor(.secondary)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(on ? Color.accentColor.opacity(0.08) : Color.clear)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxHeight: 220)
    }

    private func toggleChapter(_ idx: Int) {
        guard case .preview(var current) = phase else { return }
        if current.selected.contains(idx) {
            current.selected.remove(idx)
        } else {
            current.selected.insert(idx)
        }
        phase = .preview(current)
    }

    private func selectAllChapters() {
        guard case .preview(var current) = phase else { return }
        current.selected = Set(current.book.chapters.indices)
        phase = .preview(current)
    }

    private func selectNoneChapters() {
        guard case .preview(var current) = phase else { return }
        current.selected = []
        phase = .preview(current)
    }

    private func confirmImport(_ state: PreviewState) {
        let chapters = state.book.chapters.enumerated()
            .filter { state.selected.contains($0.offset) }
            .map { BookImportChapter(title: $0.element.title, text: $0.element.text) }
        // 章文本全为空时不产空书（buildBookImportDraft 返回 nil；此时不埋点，
        // 对齐 Windows chapters.length === 0 直接 return）。
        guard let draft = buildBookImportDraft(
            title: state.book.title,
            author: state.book.author.isEmpty ? nil : state.book.author,
            cover: state.cover,
            chapters: chapters,
            wordlists: IntakeService.shared.wordlists
        ) else {
            vm.showToast("没有可导入的章节内容")
            return
        }
        // 本地埋点：确认导入成功路径（对齐 Windows book_import_result ok:true）。
        ReaderTelemetry.track(.bookImportResult(
            ok: true,
            chapterCount: draft.chapters.count,
            wordCount: draft.totalWords,
            tocUsed: state.book.tocUsed
        ))
        onImported()
        vm.importBook(draft)
    }

    private func parse(url: URL) {
        // 本地埋点：选中文件开始解析（对齐 Windows book_import_attempt；
        // 文件大小读不到时省略该键，不阻断解析、不发 0）。
        ReaderTelemetry.track(.bookImportAttempt(fileSizeBytes: fileSizeBytes(of: url)))
        phase = .parsing
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try Self.parseBook(url: url) }
            DispatchQueue.main.async {
                switch result {
                case .success(let state):
                    phase = .preview(state)
                case .failure(let error):
                    let message = (error as? LocalizedError)?.errorDescription ?? "\(error)"
                    // 本地埋点：解析失败（对齐 Windows book_import_result ok:false，
                    // failReason 在工厂内截断到 60 字符）。
                    ReaderTelemetry.track(.bookImportResult(ok: false, failReason: message))
                    phase = .error(message)
                }
            }
        }
    }

    /// 文件字节数（埋点用；读不到时返回 nil，由工厂省略该键）。
    private func fileSizeBytes(of url: URL) -> Int? {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs?[.size] as? NSNumber)?.intValue
    }

    /// 解析电子书 / 长文 → 预览态。epub 走 BookImport.parseEpub；其余走应用层
    /// 抽文（FileImportCore/DocxTextExtractor/PDFKit）+ fallbackSections 分节。
    private static func parseBook(url: URL) throws -> PreviewState {
        let fileName = url.lastPathComponent
        if fileName.lowercased().hasSuffix(".epub") {
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            let data: Data
            do {
                data = try Data(contentsOf: url)
            } catch {
                throw FileImportError("读取文件失败：\(error.localizedDescription)")
            }
            var book = try parseEpub(data: data, fileName: fileName)
            if let rawCover = book.coverDataUrl {
                book.coverDataUrl = BookCoverImage.downscaleToDataUrl(rawCover) ?? rawCover
            }
            return PreviewState(
                book: book,
                fileName: fileName,
                selected: Set(book.chapters.indices),
                cover: book.coverDataUrl
            )
        }
        // 长文：复用本地文件抽取（txt / docx / pdf），再按 ~3000 词分节。
        let extracted = try IntakeService.shared.extractTextFromFile(url: url)
        let chapters = fallbackSections(from: extracted.text)
        guard !chapters.isEmpty else {
            throw FileImportError("没有解析到有效的章节内容，已放弃导入（不会产出空书）。请换一个文件或改走「粘贴文本」。")
        }
        let totalWords = chapters.reduce(0) { $0 + $1.wordCount }
        let book = EpubBook(
            title: fileTitleOf(fileName: fileName),
            author: "",
            coverDataUrl: nil,
            chapters: chapters,
            tocUsed: false,
            fallbackNotice: "长文按内容长度自动分节（每约 3,000 词一节）",
            totalWords: totalWords,
            minutes: max(1, Int((Double(totalWords) / 135.0).rounded()))
        )
        return PreviewState(
            book: book,
            fileName: fileName,
            selected: Set(book.chapters.indices),
            cover: nil
        )
    }
}

// MARK: - 本地文件（Word / PDF / txt）

private struct IntakeFileTab: View {
    @ObservedObject var vm: ReaderViewModel
    @Binding var goal: ExamGoal
    let onImported: () -> Void
    let onSwitchToPaste: () -> Void

    private enum Phase {
        case idle
        case parsing
        case preview(ExtractedFileText, fileName: String)
        case error(String)
    }

    @State private var phase: Phase = .idle
    @State private var dragOver = false
    @State private var fileImporterShown = false

    private static var importTypes: [UTType] {
        var types: [UTType] = [.plainText, .text, .pdf]
        if let docx = UTType(filenameExtension: "docx") ?? UTType("org.openxmlformats-officedocument.wordprocessingml.document") {
            types.append(docx)
        }
        return types
    }

    var body: some View {
        Group {
            switch phase {
            case .idle:
                dropZone
            case .parsing:
                parsingView
            case .error(let message):
                failView(title: "没能读取这个文件", message: message) {
                    phase = .idle
                }
            case .preview(let extracted, let fileName):
                previewView(extracted, fileName: fileName)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .fileImporter(
            isPresented: $fileImporterShown,
            allowedContentTypes: Self.importTypes,
            allowsMultipleSelection: false
        ) { result in
            if let url = try? result.get().first {
                parse(url: url)
            }
        }
    }

    private var dropZone: some View {
        VStack(spacing: 10) {
            Image(systemName: "arrow.down.doc")
                .font(.system(size: 30))
                .foregroundColor(.secondary)
            Text("拖入 .docx / .pdf / .txt 文件，或点击选择")
                .font(.system(size: 13, weight: .medium))
            Text("Word 抽正文段落，PDF 提取文字层（扫描件/图片 PDF 不支持，会提示改走粘贴）；.doc 旧格式请先在 Word 里另存为 .docx")
                .font(.system(size: 11))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(24)
        .frame(maxWidth: 480)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(
                    dragOver ? Color.accentColor : Color.secondary.opacity(0.4),
                    style: StrokeStyle(lineWidth: 1.2, dash: [6, 4])
                )
                .background(
                    RoundedRectangle(cornerRadius: 12)
                        .fill(dragOver ? Color.accentColor.opacity(0.07) : Color.secondary.opacity(0.04))
                )
        )
        .contentShape(Rectangle())
        .onTapGesture { fileImporterShown = true }
        .onDrop(of: [.fileURL], isTargeted: $dragOver) { providers in
            guard let provider = providers.first else { return false }
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                DispatchQueue.main.async {
                    if let url { parse(url: url) }
                }
            }
            return true
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var parsingView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("正在抽取正文（Word 取段落，PDF 提取文字层）…")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func previewView(_ extracted: ExtractedFileText, fileName: String) -> some View {
        let stats = IntakePreviewStats(text: extracted.text)
        let cov = coverageForText(extracted.text, goal: goal, vocab: vm.vocabWords, wordlists: IntakeService.shared.wordlists)
        let pagesSuffix = (extracted.kind == .pdf && extracted.pages != nil) ? " · \(extracted.pages!) 页" : ""
        return ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                IntakeGoalRow(goal: $goal)
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(fileName) · \(extracted.kind.label)\(pagesSuffix) 抽取完成")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                    Text(fileTitleOf(fileName: fileName))
                        .font(.system(size: 15, weight: .semibold, design: .serif))
                    HStack(spacing: 10) {
                        Text(stats.level)
                            .font(.system(size: 10.5, weight: .semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.blue.opacity(0.14))
                            .foregroundColor(.blue)
                            .clipShape(RoundedRectangle(cornerRadius: 5))
                        Text("\(stats.words) 词 · \(stats.paras) 段 · 约 \(stats.minutes) 分钟")
                            .font(.system(size: 11.5))
                            .foregroundColor(.secondary)
                    }
                    Text("覆盖\(goal.label)大纲词 \(cov.total)\(cov.unmastered > 0 ? " · \(cov.unmastered) 个你还没掌握" : "")")
                        .font(.system(size: 11.5))
                        .foregroundColor(cov.unmastered > 0 ? .orange : .secondary)
                    Text(String(extracted.text.prefix(180)) + "…")
                        .font(.system(size: 12, design: .serif))
                        .foregroundColor(.secondary)
                        .lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.secondary.opacity(0.06))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    HStack {
                        Spacer()
                        Button("重新选择文件") { phase = .idle }
                            .controlSize(.small)
                        Button("加入书架并开始阅读") {
                            let meta = ImportMeta(
                                sourceType: importKindSourceType(extracted.kind),
                                level: stats.level
                            )
                            let title = fileTitleOf(fileName: fileName)
                            let text = extracted.text
                            onImported()
                            vm.importText(text, title: title, meta: meta)
                        }
                            .controlSize(.small)
                            .buttonStyle(.borderedProminent)
                    }
                }
                .padding(14)
                .background(Color.secondary.opacity(0.05))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .padding(16)
        }
    }

    private func failView(title: String, message: String, onRetry: @escaping () -> Void) -> some View {
        VStack(spacing: 10) {
            Text(title)
                .font(.system(size: 14, weight: .semibold))
            Text(message)
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("返回重试", action: onRetry)
                    .controlSize(.small)
                Button("切到粘贴文本") {
                    phase = .idle
                    onSwitchToPaste()
                }
                    .controlSize(.small)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func parse(url: URL) {
        phase = .parsing
        let fileName = url.lastPathComponent
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try IntakeService.shared.extractTextFromFile(url: url) }
            DispatchQueue.main.async {
                switch result {
                case .success(let extracted):
                    phase = .preview(extracted, fileName: fileName)
                case .failure(let error):
                    phase = .error((error as? LocalizedError)?.errorDescription ?? "\(error)")
                }
            }
        }
    }
}

// MARK: - 网页链接

private struct IntakeUrlTab: View {
    @ObservedObject var vm: ReaderViewModel
    @Binding var goal: ExamGoal
    let onImported: () -> Void
    let onSwitchToPaste: () -> Void

    private enum Phase {
        case idle
        case loading
        case preview(FetchedArticle)
        case error(String)
    }

    @State private var url = ""
    @State private var phase: Phase = .idle
    @State private var fetchTask: Task<Void, Never>?

    private var trimmedURL: String { url.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var isValid: Bool {
        trimmedURL.range(of: #"^https?://.+\..+"#, options: .regularExpression) != nil
    }

    var body: some View {
        Group {
            switch phase {
            case .idle:
                inputView
            case .loading:
                VStack(spacing: 12) {
                    ProgressView()
                    Text("正在抓取正文、去掉导航与广告…")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .error(let message):
                VStack(spacing: 10) {
                    Text("没能读取这个链接")
                        .font(.system(size: 14, weight: .semibold))
                    Text(message)
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button("返回重试") { phase = .idle }
                            .controlSize(.small)
                        Button("切到粘贴文本") {
                            phase = .idle
                            onSwitchToPaste()
                        }
                            .controlSize(.small)
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .preview(let article):
                previewView(article)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onDisappear { fetchTask?.cancel() }
    }

    private var inputView: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                TextField("粘贴文章链接，如 https://en.wikipedia.org/wiki/Reading", text: $url)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12))
                    .onSubmit { startFetch() }
                Button("抓取正文") { startFetch() }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
                    .disabled(!isValid)
            }
            Text("支持新闻、博客、维基百科等公开网页；需要登录或付费墙的抓不到，会告诉你原因。")
                .font(.system(size: 11))
                .foregroundColor(.secondary)
            Spacer()
        }
        .padding(16)
    }

    private func previewView(_ article: FetchedArticle) -> some View {
        let stats = IntakePreviewStats(text: article.text)
        let cov = coverageForText(article.text, goal: goal, vocab: vm.vocabWords, wordlists: IntakeService.shared.wordlists)
        return ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                IntakeGoalRow(goal: $goal)
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(article.host) · 正文已按段落清洗")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                    Text(article.title.isEmpty ? article.host : article.title)
                        .font(.system(size: 15, weight: .semibold, design: .serif))
                    HStack(spacing: 10) {
                        Text(stats.level)
                            .font(.system(size: 10.5, weight: .semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.blue.opacity(0.14))
                            .foregroundColor(.blue)
                            .clipShape(RoundedRectangle(cornerRadius: 5))
                        Text("\(stats.words) 词 · \(stats.paras) 段 · 约 \(stats.minutes) 分钟")
                            .font(.system(size: 11.5))
                            .foregroundColor(.secondary)
                    }
                    Text("覆盖\(goal.label)大纲词 \(cov.total)\(cov.unmastered > 0 ? " · \(cov.unmastered) 个你还没掌握" : "")")
                        .font(.system(size: 11.5))
                        .foregroundColor(cov.unmastered > 0 ? .orange : .secondary)
                    Text(String(article.text.prefix(180)) + "…")
                        .font(.system(size: 12, design: .serif))
                        .foregroundColor(.secondary)
                        .lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.secondary.opacity(0.06))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    HStack {
                        Spacer()
                        Button("加入书架并开始阅读") {
                            let meta = ImportMeta(
                                sourceType: .url,
                                sourceUrl: article.url,
                                level: stats.level
                            )
                            let title = article.title.isEmpty ? nil : article.title
                            let text = article.text
                            onImported()
                            vm.importText(text, title: title, meta: meta)
                        }
                            .controlSize(.small)
                            .buttonStyle(.borderedProminent)
                    }
                }
                .padding(14)
                .background(Color.secondary.opacity(0.05))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .padding(16)
        }
    }

    private func startFetch() {
        guard isValid else { return }
        let target = trimmedURL
        phase = .loading
        fetchTask = Task {
            do {
                let article = try await IntakeService.shared.fetchArticle(url: target)
                if !Task.isCancelled {
                    phase = .preview(article)
                }
            } catch {
                if !Task.isCancelled {
                    phase = .error((error as? LocalizedError)?.errorDescription ?? "\(error)")
                }
            }
        }
    }
}

// MARK: - 粘贴文本（现状保留）

private struct IntakePasteTab: View {
    @ObservedObject var vm: ReaderViewModel
    let onImported: () -> Void

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
            TextField("标题（可选）：留空则自动识别首行作为标题（≤80 字符且无句末标点）", text: $title)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 12))
            TextEditor(text: $text)
                .font(.system(size: 13))
                .frame(minHeight: 260)
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
                Button("取消") { onImported() }
                    .controlSize(.small)
                    .keyboardShortcut(.cancelAction)
                Button("开始阅读") {
                    let chosen = title.trimmingCharacters(in: .whitespacesAndNewlines)
                    let importText = text
                    onImported()
                    vm.importPaste(importText, title: chosen.isEmpty ? nil : chosen)
                }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(trimmed.isEmpty)
            }
        }
        .padding(16)
        .fileImporter(
            isPresented: $fileImporterShown,
            allowedContentTypes: [.plainText, .text],
            allowsMultipleSelection: false
        ) { result in
            if let url = try? result.get().first {
                loadTxtFile(url)
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

    private func loadTxtFile(_ url: URL) {
        fileError = ""
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            guard data.count <= 4 * 1024 * 1024 else {
                fileError = "文件超过 4MB，请确认是纯文本文章"
                return
            }
            let content = decodeTextBytes(data)
            if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                fileError = "文件是空的"
            } else if content.contains("\u{FFFD}") {
                fileError = "这个文本文件的编码无法识别，请另存为 UTF-8 后再导入"
            } else {
                text = content
            }
        } catch {
            fileError = "读取文件失败：\(error.localizedDescription)"
        }
    }
}
