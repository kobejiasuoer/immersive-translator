import AppKit
import SwiftUI
import ReaderCore
import XfyunCore

/// 正文文本块的高度测量：用独立的 TextKit 栈按给定宽度离屏排版。
/// 不能借正文视图自己的 textContainer 来测——它开了 widthTracksTextView，
/// SwiftUI 首次测量时视图还没有宽度，手动改容器尺寸会被回写成 0，
/// usedRect 拿不到行片高度，整块会塌成一行并与后续块叠画。
enum ReaderTextMeasurer {
    static func height(of attributed: NSAttributedString, width: CGFloat) -> CGFloat {
        let storage = NSTextStorage(attributedString: attributed)
        let layoutManager = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: width, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layoutManager.addTextContainer(container)
        storage.addLayoutManager(layoutManager)
        layoutManager.ensureLayout(for: container)
        return layoutManager.usedRect(for: container).height
    }
}

/// 正文英文句的 NSTextView 互操作：
/// - 划选文本（mouseup 判定）→ 查短语；
/// - 无选区单击 → 词定位查单词；
/// - 词块/生词再现跨度以虚线下划线标注，点击出即时卡（M4 注入数据）。
struct ReaderSentenceText: NSViewRepresentable {
    /// UTF-16 偏移的渲染跨度（由 buildSentenceSpans + splitBySpans 预先计算）。
    struct SpanMark {
        let start: Int
        let end: Int
        let kind: ChunkSpan.Kind
        let chunk: SentenceChunk?
    }

    let text: String
    let font: NSFont
    let textColor: NSColor
    let lineSpacing: CGFloat
    let chunkUnderlineColor: NSColor
    let knownUnderlineColor: NSColor
    let marks: [SpanMark]
    let onSelection: (String) -> Void
    let onWordClick: (String) -> Void
    var onChunkClick: ((SentenceChunk) -> Void)?
    /// 跟读评测的词级着色（UTF-16 偏移；nil = 无评测结果）。
    var assessMarks: [WordMark]?
    /// 透镜卡悬停中的意群片段：命中本句时整句只渲染这一个回标标记，
    /// 词块/生词虚线与跟读着色全部让位（decorateEn hovered 分支，优先级最高；
    /// 对照行与画报流共用同一语义，prose/parallel 都能回标）。
    var hoveredClause: String?
    /// 意群回标色（从句靛蓝 / 其软底）；nil = 不启用回标通道。
    var clauseIndigoColor: NSColor?
    var clauseIndigoSoftColor: NSColor?

    func makeNSView(context: Context) -> ReaderTextView {
        let view = ReaderTextView(frame: .zero)
        view.isEditable = false
        view.isSelectable = true
        view.isRichText = true
        view.isAutomaticLinkDetectionEnabled = false
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.textContainer?.widthTracksTextView = true
        view.textContainer?.lineFragmentPadding = 0
        view.autoresizingMask = [.width]
        view.onSelection = { selection in
            self.onSelection(selection)
        }
        view.onWordClick = { word in
            self.onWordClick(word)
        }
        view.onChunkClick = { chunk in
            self.onChunkClick?(chunk)
        }
        updateText(in: view)
        return view
    }

    func updateNSView(_ view: ReaderTextView, context: Context) {
        view.onSelection = { selection in self.onSelection(selection) }
        view.onWordClick = { word in self.onWordClick(word) }
        view.onChunkClick = { chunk in self.onChunkClick?(chunk) }
        updateText(in: view)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, _ nsView: ReaderTextView, _ context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        let height = nsView.measuredHeight(forWidth: width)
        return CGSize(width: width, height: max(height, font.pointSize * 1.2) + 2)
    }

    private func updateText(in view: ReaderTextView) {
        let storage = view.textStorage ?? NSTextStorage()
        let full = NSRange(location: 0, length: (text as NSString).length)
        // 悬停意群回标：定位不到（或没传通道）= nil，本句按常规渲染。
        let clauseRange: NSRange? = hoveredClause.flatMap { clause -> NSRange? in
            guard !clause.isEmpty, let hit = findChunkRange(text, clause) else { return nil }
            return NSRange(location: hit.start, length: hit.end - hit.start)
        }
        // 渲染签名：未命中句的 clauseKey 恒为 "none"，悬停片段变化不触发其重建。
        let signature = [
            text,
            "\(font.fontName)|\(font.pointSize)|\(lineSpacing)|\(textColor)",
            marks.map { "\($0.start)-\($0.end)-\($0.kind == .known)" }.joined(separator: ";"),
            "\((assessMarks ?? []).count)",
            clauseRange.map { "clause:\($0.location)-\($0.length)" } ?? "none"
        ].joined(separator: "§")
        guard signature != view.renderSignature else { return }
        view.renderSignature = signature

        let attributed = NSMutableAttributedString(string: text)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = lineSpacing
        paragraph.paragraphSpacing = 0
        attributed.addAttributes(
            [
                .font: font,
                .foregroundColor: textColor,
                .paragraphStyle: paragraph,
                .cursor: NSCursor.iBeam
            ],
            range: full
        )
        if let markRange = clauseRange,
           let indigo = clauseIndigoColor, let soft = clauseIndigoSoftColor {
            // 命中：整句只渲染这一个标记（优先级高于词块着色/跟读着色），
            // 词块点击命中同步清空（span 已不存在，不可再点）。
            attributed.addAttribute(.backgroundColor, value: soft, range: markRange)
            attributed.addAttribute(.underlineStyle, value: NSUnderlineStyle.thick.rawValue, range: markRange)
            attributed.addAttribute(.underlineColor, value: indigo, range: markRange)
            view.markedChunks = []
            view.textWasManuallySet = false
            storage.setAttributedString(attributed)
            view.textWasManuallySet = true
            view.needsLayout = true
            view.invalidateIntrinsicContentSize()
            return
        }
        for mark in marks {
            let range = NSRange(location: mark.start, length: max(1, mark.end - mark.start))
            guard range.location + range.length <= full.length else { continue }
            let color = mark.kind == .known ? knownUnderlineColor : chunkUnderlineColor
            attributed.addAttribute(.underlineStyle, value: NSUnderlineStyle.patternDash.rawValue, range: range)
            attributed.addAttribute(.underlineColor, value: color, range: range)
            attributed.addAttribute(.cursor, value: NSCursor.pointingHand, range: range)
        }
        // 跟读评测着色：good 绿 / ok 黄 / bad 红 / missed 灰底纹（漏读）。
        for mark in assessMarks ?? [] {
            let range = NSRange(location: mark.start, length: max(1, mark.end - mark.start))
            guard range.location + range.length <= full.length else { continue }
            let bg: NSColor
            switch mark.quality {
            case .good: bg = NSColor.systemGreen.withAlphaComponent(0.22)
            case .ok: bg = NSColor.systemYellow.withAlphaComponent(0.28)
            case .bad: bg = NSColor.systemRed.withAlphaComponent(0.20)
            case .missed: bg = NSColor.systemGray.withAlphaComponent(0.30)
            }
            attributed.addAttribute(.backgroundColor, value: bg, range: range)
        }
        view.markedChunks = marks.compactMap { mark in
            guard let chunk = mark.chunk else { return nil }
            let range = NSRange(location: mark.start, length: max(1, mark.end - mark.start))
            guard range.location + range.length <= full.length else { return nil }
            return (range, chunk)
        }
        view.textWasManuallySet = false
        storage.setAttributedString(attributed)
        view.textWasManuallySet = true
        view.needsLayout = true
        view.invalidateIntrinsicContentSize()
    }
}

/// 记录「用户主动选区」的 NSTextView：
/// mouseUp 有选区 → onSelection；无选区单击 → 词定位 onWordClick。
final class ReaderTextView: NSTextView {
    var onSelection: ((String) -> Void)?
    var onWordClick: ((String) -> Void)?
    var onChunkClick: ((SentenceChunk) -> Void)?
    var markedChunks: [(range: NSRange, chunk: SentenceChunk)] = []
    /// setAttributedString 会清空选区并触发 selection 通知；置位期间不当作用户划选。
    var textWasManuallySet = true
    /// 上次渲染输入签名（内容/字号/颜色/跨度/意群命中）：相同则跳过重建，
    /// 悬停片段变化时未命中句不重排。
    var renderSignature = ""
    /// 按（渲染签名, 宽度）缓存的离屏测量高度；内容或宽度变了才重排。
    private var heightCache: (signature: String, width: CGFloat, height: CGFloat)?

    /// 当前内容在给定宽度下的排版高度（离屏测量，不依赖视图已有宽度）。
    func measuredHeight(forWidth width: CGFloat) -> CGFloat {
        if let cache = heightCache, cache.signature == renderSignature, cache.width == width {
            return cache.height
        }
        guard let storage = textStorage else { return 0 }
        let height = ReaderTextMeasurer.height(of: storage, width: width)
        heightCache = (renderSignature, width, height)
        return height
    }

    /// SwiftUI 布局经 AppKit 约束读取的是 intrinsic 高度（sizeThatFits 协议方法
    /// 在实测中不会被调用）：不提供就会按 0 高布局，整块文字溢出与后续块叠画。
    override var intrinsicContentSize: NSSize {
        guard frame.width > 1 else {
            return NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric)
        }
        let pointSize = (textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)?.pointSize ?? 14
        return NSSize(
            width: NSView.noIntrinsicMetric,
            height: max(measuredHeight(forWidth: frame.width), pointSize * 1.2) + 2
        )
    }

    override func setFrameSize(_ newSize: NSSize) {
        let widthChanged = abs(newSize.width - frame.size.width) > 0.5
        super.setFrameSize(newSize)
        if widthChanged { invalidateIntrinsicContentSize() }
    }

    override func mouseUp(with event: NSEvent) {
        let range = selectedRange
        if range.length > 0, let source = self.string as NSString?,
           range.location + range.length <= source.length {
            let picked = source.substring(with: range)
            if !picked.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                onSelection?(picked)
                super.mouseUp(with: event)
                return
            }
        }
        // 无选区单击：先看是否命中词块下划线，再回落点词
        if range.length == 0 {
            if let chunk = chunkAtMouseLocation(with: event) {
                onChunkClick?(chunk)
            } else if let word = wordAtMouseLocation(with: event) {
                onWordClick?(word)
            }
        }
        super.mouseUp(with: event)
    }

    /// 点击命中词块标注范围 → 出即时卡。
    private func chunkAtMouseLocation(with event: NSEvent) -> SentenceChunk? {
        guard let layoutManager, let container = textContainer, !markedChunks.isEmpty else { return nil }
        let location = convert(event.locationInWindow, from: nil)
        let index = layoutManager.characterIndex(
            for: location,
            in: container,
            fractionOfDistanceBetweenInsertionPoints: nil
        )
        return markedChunks.first {
            index >= $0.range.location && index < NSMaxRange($0.range)
        }?.chunk
    }

    private func wordAtMouseLocation(with event: NSEvent) -> String? {
        guard let layoutManager, let container = textContainer else { return nil }
        let location = convert(event.locationInWindow, from: nil)
        var half: CGFloat = 0.5
        let index = layoutManager.characterIndex(
            for: location,
            in: container,
            fractionOfDistanceBetweenInsertionPoints: &half
        )
        return Self.wordAt(index: index, in: string)
    }

    /// 光标处的完整单词（词边界含连字符/撇号；命中边界时向后含一个字符）。
    static func wordAt(index: Int, in text: String) -> String? {
        let source = text as NSString
        guard index < source.length else { return nil }
        let wordChars = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789’-’")
        var start = index
        var end = index
        if start < source.length,
           !wordChars.contains(UnicodeScalar(source.character(at: start)) ?? UnicodeScalar(32)) {
            if start > 0 { start -= 1; end = start }
        }
        while start > 0, wordChars.contains(UnicodeScalar(source.character(at: start)) ?? UnicodeScalar(32)) {
            start -= 1
        }
        if !wordChars.contains(UnicodeScalar(source.character(at: start)) ?? UnicodeScalar(32)) {
            start = min(start + 1, source.length)
        }
        while end < source.length, wordChars.contains(UnicodeScalar(source.character(at: end)) ?? UnicodeScalar(32)) {
            end += 1
        }
        guard end > start else { return nil }
        let word = source.substring(with: NSRange(location: start, length: end - start)).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !word.isEmpty, word.count <= 40 else { return nil }
        return word
    }
}

// MARK: - 画报段落英文流（v0.8 READ-3：prose 模式的多句连续排版块）

/// 段落流里的一句：全局句号 + 英文 + 在拼接文本中的 UTF-16 起点。
struct ProsePiece: Equatable {
    let idx: Int
    let en: String
    let start: Int
    let isCurrent: Bool
    let failed: Bool
}

/// 画报正文块（一个段落或「当前句切分」后的半段）：
/// 多句在同一个 NSTextView 里连续行内排版（Windows .prose-sentence 行内流的
/// 原生对应物），逐句承载——当前句高亮（accent-soft 底 + 主色下划线）、失败句
/// 错误下划线、专注模式压暗（非当前句 ink×0.36，悬停恢复 0.78，正文内属性直改
/// 不重排）、透镜卡意群悬停回标（clause-indigo 高于词块着色）、词块/生词虚线
/// 跨度、跟读评测着色、64px 首字下沉（首字符被任何标注跨度占用时放弃）。
///
/// 点击语义对齐 ReadingView.tsx handleProseClick：点句定位为当前句；点在单词
/// 上顺带查词；点词块下划线只出即时卡（不打断定位）；划选交 mouseup 查短语。
struct ReaderProseText: NSViewRepresentable {
    /// 段落块的配色/字号令牌（由 ReaderPalette 换算）。
    struct Style {
        let font: NSFont
        let lineSpacing: CGFloat
        let textColor: NSColor
        let accent: NSColor
        let accentSoft: NSColor
        let err: NSColor
        let chunkUnderline: NSColor
        let knownUnderline: NSColor
        let clauseIndigo: NSColor
        let clauseIndigoSoft: NSColor
        /// 首字下沉的展示衬线（.drop-cap 64px italic）。
        let dropCapFont: NSFont

        init(
            font: NSFont, lineSpacing: CGFloat,
            textColor: NSColor, accent: NSColor, accentSoft: NSColor, err: NSColor,
            chunkUnderline: NSColor, knownUnderline: NSColor,
            clauseIndigo: NSColor, clauseIndigoSoft: NSColor, dropCapFont: NSFont
        ) {
            self.font = font
            self.lineSpacing = lineSpacing
            self.textColor = textColor
            self.accent = accent
            self.accentSoft = accentSoft
            self.err = err
            self.chunkUnderline = chunkUnderline
            self.knownUnderline = knownUnderline
            self.clauseIndigo = clauseIndigo
            self.clauseIndigoSoft = clauseIndigoSoft
            self.dropCapFont = dropCapFont
        }
    }

    let pieces: [ProsePiece]
    let style: Style
    /// 词块/生词跨度（UTF-16 偏移已折算到拼接文本坐标系）。
    let marks: [ReaderSentenceText.SpanMark]
    /// 跟读评测词着色（当前句所在块才有；UTF-16 偏移同样折算）。
    var assessMarks: [WordMark]?
    /// 专注模式（spotlight-active）。
    var spotlight: Bool = false
    /// 透镜卡悬停中的意群片段（优先级高于词块着色，回标原文）。
    var hoveredClause: String?
    /// 首字下沉（文章首块且首字符无标注跨度时生效）。
    var dropCap: Bool = false

    let onSelection: (Int, String) -> Void
    let onWordClick: (Int, String) -> Void
    let onChunkClick: (Int, SentenceChunk) -> Void
    let onClickSentence: (Int) -> Void
    /// 布局后回报各句 minY（视图本地坐标；滚动跟随用）。
    var onSentenceFrames: (([Int: CGFloat]) -> Void)?

    /// 拼接文本（句间以空格相连，与行内流一致）。
    static func joinedText(of pieces: [ProsePiece]) -> String {
        pieces.map(\.en).joined(separator: " ")
    }

    func makeNSView(context: Context) -> ProseFlowTextView {
        let view = ProseFlowTextView(frame: .zero)
        view.configureTextView()
        wire(view)
        view.apply(pieces: pieces, style: style, marks: marks, assessMarks: assessMarks,
                   spotlight: spotlight, hoveredClause: hoveredClause, dropCap: dropCap)
        return view
    }

    func updateNSView(_ view: ProseFlowTextView, context: Context) {
        wire(view)
        view.apply(pieces: pieces, style: style, marks: marks, assessMarks: assessMarks,
                   spotlight: spotlight, hoveredClause: hoveredClause, dropCap: dropCap)
    }

    private func wire(_ view: ProseFlowTextView) {
        view.onSelection = { onSelection($0, $1) }
        view.onWordClick = { onWordClick($0, $1) }
        view.onChunkClick = { onChunkClick($0, $1) }
        view.onClickSentence = { onClickSentence($0) }
        // NSView layout 发生在 SwiftUI 更新期内；句子帧回报异步派发，
        // 避免 Modifying state during view update。
        view.onSentenceFrames = { frames in
            DispatchQueue.main.async { onSentenceFrames?(frames) }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, _ nsView: ProseFlowTextView, _ context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        let height = nsView.measuredHeight(forWidth: width)
        return CGSize(width: width, height: max(height, style.font.pointSize * 1.2) + 2)
    }
}

/// 段落流渲染 + 交互（NSTextView 子类）。
final class ProseFlowTextView: NSTextView {
    var onSelection: ((Int, String) -> Void)?
    var onWordClick: ((Int, String) -> Void)?
    var onChunkClick: ((Int, SentenceChunk) -> Void)?
    var onClickSentence: ((Int) -> Void)?
    var onSentenceFrames: (([Int: CGFloat]) -> Void)?

    private var pieces: [ProsePiece] = []
    private var style: ReaderProseText.Style?
    private var marks: [ReaderSentenceText.SpanMark] = []
    private var assessMarks: [WordMark] = []
    private var spotlight = false
    private var hoveredClause: String?
    private var dropCapEnabled = false
    /// 专注模式悬停中的句（本地维护，恢复 0.78 时不经 SwiftUI 重排）。
    private var hoveredPieceIdx: Int?
    private var chunkHits: [(range: NSRange, chunk: SentenceChunk, pieceIdx: Int)] = []
    private var renderSignature = ""
    private var lastReportedFrames: [Int: CGFloat] = [:]
    /// 按（渲染签名, 宽度）缓存的离屏测量高度；内容或宽度变了才重排。
    private var heightCache: (signature: String, width: CGFloat, height: CGFloat)?

    /// 当前内容在给定宽度下的排版高度（离屏测量，不依赖视图已有宽度）。
    func measuredHeight(forWidth width: CGFloat) -> CGFloat {
        if let cache = heightCache, cache.signature == renderSignature, cache.width == width {
            return cache.height
        }
        guard let storage = textStorage else { return 0 }
        let height = ReaderTextMeasurer.height(of: storage, width: width)
        heightCache = (renderSignature, width, height)
        return height
    }

    /// SwiftUI 布局经 AppKit 约束读取的是 intrinsic 高度（sizeThatFits 协议方法
    /// 在实测中不会被调用）：不提供就会按 0 高布局，整块文字溢出与后续块叠画。
    override var intrinsicContentSize: NSSize {
        guard frame.width > 1, let style else {
            return NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric)
        }
        return NSSize(
            width: NSView.noIntrinsicMetric,
            height: max(measuredHeight(forWidth: frame.width), style.font.pointSize * 1.2) + 2
        )
    }

    override func setFrameSize(_ newSize: NSSize) {
        let widthChanged = abs(newSize.width - frame.size.width) > 0.5
        super.setFrameSize(newSize)
        if widthChanged { invalidateIntrinsicContentSize() }
    }

    func configureTextView() {
        isEditable = false
        isSelectable = true
        isRichText = true
        isAutomaticLinkDetectionEnabled = false
        drawsBackground = false
        textContainerInset = .zero
        isVerticallyResizable = true
        isHorizontallyResizable = false
        textContainer?.widthTracksTextView = true
        textContainer?.lineFragmentPadding = 0
        autoresizingMask = [.width]
    }

    // MARK: 渲染

    func apply(
        pieces: [ProsePiece],
        style: ReaderProseText.Style,
        marks: [ReaderSentenceText.SpanMark],
        assessMarks: [WordMark]?,
        spotlight: Bool,
        hoveredClause: String?,
        dropCap: Bool
    ) {
        let signature = [
            "\(ReaderProseText.joinedText(of: pieces))",
            "\(style.font.fontName)|\(style.font.pointSize)|\(style.lineSpacing)",
            "\(style.textColor)|\(style.accent)|\(style.accentSoft)|\(style.err)",
            pieces.map { "\($0.idx):\($0.isCurrent ? 1 : 0)\($0.failed ? 1 : 0)" }.joined(separator: ","),
            "\(marks.count)|\(marks.map { "\($0.start)-\($0.end)-\($0.kind == .known)" }.joined(separator: ";"))",
            "\(assessMarks?.count ?? 0)",
            "\(spotlight)", hoveredClause ?? "", "\(dropCap)"
        ].joined(separator: "§")
        guard signature != renderSignature else { return }
        renderSignature = signature
        self.pieces = pieces
        self.style = style
        self.marks = marks
        self.assessMarks = assessMarks ?? []
        self.spotlight = spotlight
        self.hoveredClause = hoveredClause
        self.dropCapEnabled = dropCap
        hoveredPieceIdx = nil
        rebuild()
    }

    private func rebuild() {
        guard let style else { return }
        let joined = ReaderProseText.joinedText(of: pieces)
        let attributed = NSMutableAttributedString(string: joined)
        let full = NSRange(location: 0, length: (joined as NSString).length)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = style.lineSpacing
        paragraph.paragraphSpacing = 0
        attributed.addAttributes(
            [
                .font: style.font,
                .foregroundColor: style.textColor,
                .paragraphStyle: paragraph,
                .cursor: NSCursor.iBeam
            ],
            range: full
        )

        // 逐句：聚光压暗 / 当前句高亮 / 失败下划线 / 意群回标。
        var clauseRanges: [NSRange] = []
        for piece in pieces {
            let length = (piece.en as NSString).length
            let range = NSRange(location: piece.start, length: length)
            guard range.location + range.length <= full.length else { continue }
            if piece.isCurrent {
                attributed.addAttribute(.backgroundColor, value: style.accentSoft, range: range)
                attributed.addAttribute(.underlineStyle, value: NSUnderlineStyle.thick.rawValue, range: range)
                attributed.addAttribute(.underlineColor, value: style.accent, range: range)
            } else if piece.failed {
                attributed.addAttribute(.underlineStyle, value: NSUnderlineStyle.thick.rawValue, range: range)
                attributed.addAttribute(.underlineColor, value: style.err, range: range)
            }
            if spotlight, !piece.isCurrent {
                // 聚光压暗（reader.css:6856-6862）：非当前句 ink×0.36 + 微模糊，
                // 悬停恢复 0.78 且去模糊。blur(0.2px) 的 TextKit 原生近似 =
                // 极小半径同色文字阴影（柔边），悬停时移除该属性即「去模糊」。
                let hovered = hoveredPieceIdx == piece.idx
                let alpha: CGFloat = hovered ? 0.78 : 0.36
                attributed.addAttribute(.foregroundColor, value: style.textColor.withAlphaComponent(alpha), range: range)
                if !hovered {
                    attributed.addAttribute(
                        .shadow,
                        value: ProseFlowTextView.dimSofteningShadow(color: style.textColor, alpha: alpha),
                        range: range
                    )
                }
            }
            // 意群回标：整句只渲染这一个标记（优先级高于词块着色）。
            if let clause = hoveredClause, !clause.isEmpty,
               let hit = findChunkRange(piece.en, clause) {
                let markRange = NSRange(location: piece.start + hit.start, length: hit.end - hit.start)
                guard markRange.location + markRange.length <= full.length else { continue }
                attributed.addAttribute(.backgroundColor, value: style.clauseIndigoSoft, range: markRange)
                attributed.addAttribute(.underlineStyle, value: NSUnderlineStyle.thick.rawValue, range: markRange)
                attributed.addAttribute(.underlineColor, value: style.clauseIndigo, range: markRange)
                clauseRanges.append(markRange)
            }
        }

        // 词块/生词虚线（意群回标命中的句子跳过，保持回标唯一视觉）。
        chunkHits = []
        let clausePieces = Set(
            pieces.filter { piece in
                guard let clause = hoveredClause, !clause.isEmpty else { return false }
                return findChunkRange(piece.en, clause) != nil
            }.map(\.idx)
        )
        for mark in marks {
            let range = NSRange(location: mark.start, length: max(1, mark.end - mark.start))
            guard range.location + range.length <= full.length else { continue }
            let owner = pieces.last { $0.start <= mark.start }
            if let ownerIdx = owner?.idx, clausePieces.contains(ownerIdx) { continue }
            let color = mark.kind == .known ? style.knownUnderline : style.chunkUnderline
            attributed.addAttribute(.underlineStyle, value: NSUnderlineStyle.patternDash.rawValue, range: range)
            attributed.addAttribute(.underlineColor, value: color, range: range)
            attributed.addAttribute(.cursor, value: NSCursor.pointingHand, range: range)
            if let chunk = mark.chunk {
                chunkHits.append((range, chunk, owner?.idx ?? 0))
            }
        }

        // 跟读评测着色（UTF-16 偏移已折算到拼接坐标系）。
        for mark in assessMarks {
            let range = NSRange(location: mark.start, length: max(1, mark.end - mark.start))
            guard range.location + range.length <= full.length else { continue }
            let bg: NSColor
            switch mark.quality {
            case .good: bg = NSColor.systemGreen.withAlphaComponent(0.22)
            case .ok: bg = NSColor.systemYellow.withAlphaComponent(0.28)
            case .bad: bg = NSColor.systemRed.withAlphaComponent(0.20)
            case .missed: bg = NSColor.systemGray.withAlphaComponent(0.30)
            }
            attributed.addAttribute(.backgroundColor, value: bg, range: range)
        }

        // 首字下沉：首块首字符，被任何标注跨度占据即放弃（applyDropCap 同口径）。
        if dropCapEnabled, full.length > 0, pieces.first?.start == 0,
           !rangeCovered(NSRange(location: 0, length: 1), marks: attributed) {
            attributed.addAttribute(.font, value: style.dropCapFont, range: NSRange(location: 0, length: 1))
            attributed.addAttribute(.foregroundColor, value: style.accent, range: NSRange(location: 0, length: 1))
            // float 右余白的等价物：字后加 12pt 字距（reader.css .drop-cap padding 12px 0 0）。
            attributed.addAttribute(.kern, value: 12, range: NSRange(location: 0, length: 1))
            attributed.addAttribute(.obliqueness, value: 0.18, range: NSRange(location: 0, length: 1))
        }

        textStorage?.setAttributedString(attributed)
        needsLayout = true
        invalidateIntrinsicContentSize()
        reportSentenceFramesIfNeeded()
    }

    /// 首字符是否已被任何可视标注（下划线/底色/意群标）占用。
    private func rangeCovered(_ head: NSRange, marks attributed: NSAttributedString) -> Bool {
        var covered = false
        attributed.enumerateAttributes(
            in: head,
            options: [.longestEffectiveRangeNotRequired]
        ) { attrs, _, stop in
            if attrs.keys.contains(where: { $0 == .underlineStyle || $0 == .backgroundColor }) {
                covered = true
                stop.pointee = true
            }
        }
        return covered
    }

    // MARK: 句定位

    private func pieceIdx(at charIndex: Int) -> Int? {
        pieces.last { $0.start <= charIndex }?.idx
    }

    private func range(ofPiece idx: Int) -> NSRange? {
        guard let piece = pieces.first(where: { $0.idx == idx }) else { return nil }
        return NSRange(location: piece.start, length: (piece.en as NSString).length)
    }

    // MARK: 交互

    override func mouseUp(with event: NSEvent) {
        let selection = selectedRange
        let source = string as NSString
        if selection.length > 0, selection.location + selection.length <= source.length {
            let picked = source.substring(with: selection)
            if !picked.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                if let idx = pieceIdx(at: selection.location) {
                    onSelection?(idx, picked)
                }
                super.mouseUp(with: event)
                return
            }
        }
        if selection.length == 0 {
            if let hit = chunkAtMouseLocation(with: event) {
                onChunkClick?(hit.pieceIdx, hit.chunk)
            } else {
                guard let idx = pieceIdxAtMouseLocation(with: event) else {
                    super.mouseUp(with: event)
                    return
                }
                // 点句定位；点在单词上顺带查词（handleProseClick）。
                onClickSentence?(idx)
                if let word = wordAtMouseLocation(with: event) {
                    onWordClick?(idx, word)
                }
            }
        }
        super.mouseUp(with: event)
    }

    private func chunkAtMouseLocation(with event: NSEvent) -> (range: NSRange, chunk: SentenceChunk, pieceIdx: Int)? {
        guard let layoutManager, let container = textContainer, !chunkHits.isEmpty else { return nil }
        let location = convert(event.locationInWindow, from: nil)
        let index = layoutManager.characterIndex(
            for: location,
            in: container,
            fractionOfDistanceBetweenInsertionPoints: nil
        )
        return chunkHits.first {
            index >= $0.range.location && index < NSMaxRange($0.range)
        }
    }

    private func pieceIdxAtMouseLocation(with event: NSEvent) -> Int? {
        guard let layoutManager, let container = textContainer else { return nil }
        let location = convert(event.locationInWindow, from: nil)
        let index = layoutManager.characterIndex(
            for: location,
            in: container,
            fractionOfDistanceBetweenInsertionPoints: nil
        )
        return pieceIdx(at: index)
    }

    private func wordAtMouseLocation(with event: NSEvent) -> String? {
        guard let layoutManager, let container = textContainer else { return nil }
        let location = convert(event.locationInWindow, from: nil)
        var half: CGFloat = 0.5
        let index = layoutManager.characterIndex(
            for: location,
            in: container,
            fractionOfDistanceBetweenInsertionPoints: &half
        )
        return ReaderTextView.wordAt(index: index, in: string)
    }

    // MARK: 聚光悬停（压暗句 hover 恢复，属性直改不重排）

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        // 只重建自建的区域（打标识别），不动 NSTextView 系统的选区/光标区域。
        trackingAreas
            .filter { ($0.userInfo?["proseFlow"] as? Bool) == true }
            .forEach { removeTrackingArea($0) }
        addTrackingArea(
            NSTrackingArea(
                rect: visibleRect,
                options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways],
                owner: self,
                userInfo: ["proseFlow": true]
            )
        )
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        guard spotlight else { return }
        guard let idx = pieceIdxAtMouseLocation(with: event),
              let piece = pieces.first(where: { $0.idx == idx }),
              !piece.isCurrent else { return }
        guard hoveredPieceIdx != idx else { return }
        let previous = hoveredPieceIdx
        hoveredPieceIdx = idx
        if let previous {
            restoreAlpha(piece: previous, hovered: false)
        }
        restoreAlpha(piece: idx, hovered: true)
        needsDisplay = true
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        let previous = hoveredPieceIdx
        hoveredPieceIdx = nil
        if let previous {
            restoreAlpha(piece: previous, hovered: false)
            needsDisplay = true
        }
    }

    /// 聚光句的透明度就地改写（当前句/普通句不动）：
    /// 悬停恢复 0.78 并去模糊；移开回落 0.36 并补回柔边。
    private func restoreAlpha(piece idx: Int, hovered: Bool) {
        guard let style, let range = range(ofPiece: idx) else { return }
        guard let piece = pieces.first(where: { $0.idx == idx }), !piece.isCurrent else { return }
        let alpha: CGFloat = hovered ? 0.78 : 0.36
        textStorage?.addAttribute(
            .foregroundColor,
            value: style.textColor.withAlphaComponent(alpha),
            range: range
        )
        if hovered {
            textStorage?.removeAttribute(.shadow, range: range)
        } else {
            textStorage?.addAttribute(
                .shadow,
                value: Self.dimSofteningShadow(color: style.textColor, alpha: alpha),
                range: range
            )
        }
    }

    /// 轻微模糊的阴影柔边（≈ CSS blur(0.2px)：半径 0.6pt、偏移 0.25pt、
    /// 同文字色半透明——只柔化边缘，不产生可见投影位移）。
    private static func dimSofteningShadow(color: NSColor, alpha: CGFloat) -> NSShadow {
        let shadow = NSShadow()
        shadow.shadowColor = color.withAlphaComponent(alpha * 0.55)
        shadow.shadowBlurRadius = 0.6
        shadow.shadowOffset = NSSize(width: 0.25, height: -0.25)
        return shadow
    }

    // MARK: 布局回报（滚动跟随：滚到哪读到哪）

    override func layout() {
        super.layout()
        reportSentenceFramesIfNeeded()
    }

    private func reportSentenceFramesIfNeeded() {
        guard let layoutManager, let container = textContainer, !pieces.isEmpty else { return }
        guard container.size.width > 0 else { return }
        layoutManager.ensureLayout(for: container)
        var frames: [Int: CGFloat] = [:]
        for piece in pieces {
            let charRange = NSRange(location: piece.start, length: max(1, (piece.en as NSString).length))
            let glyphRange = layoutManager.glyphRange(forCharacterRange: charRange, actualCharacterRange: nil)
            guard glyphRange.length > 0 else { continue }
            let rect = layoutManager.lineFragmentRect(
                forGlyphAt: glyphRange.location,
                effectiveRange: nil
            )
            frames[piece.idx] = rect.minY
        }
        guard frames != lastReportedFrames else { return }
        lastReportedFrames = frames
        onSentenceFrames?(frames)
    }
}
