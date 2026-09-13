import AppKit
import SwiftUI
import ReaderCore

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
        let container = nsView.textContainer ?? NSTextContainer()
        if abs(container.size.width - width) > 0.5 {
            container.size = NSSize(width: width, height: 0)
            nsView.layoutManager?.ensureLayout(for: container)
        }
        let used = nsView.layoutManager?.usedRect(for: container) ?? .zero
        return CGSize(width: width, height: max(used.height, font.pointSize * 1.2) + 2)
    }

    private func updateText(in view: ReaderTextView) {
        let storage = view.textStorage ?? NSTextStorage()
        let attributed = NSMutableAttributedString(string: text)
        let full = NSRange(location: 0, length: (text as NSString).length)
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
        for mark in marks {
            let range = NSRange(location: mark.start, length: max(1, mark.end - mark.start))
            guard range.location + range.length <= full.length else { continue }
            let color = mark.kind == .known ? knownUnderlineColor : chunkUnderlineColor
            attributed.addAttribute(.underlineStyle, value: NSUnderlineStyle.patternDash.rawValue, range: range)
            attributed.addAttribute(.underlineColor, value: color, range: range)
            attributed.addAttribute(.cursor, value: NSCursor.pointingHand, range: range)
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
        let source = string as NSString
        guard index < source.length else { return nil }
        let wordChars = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'-’")
        var start = index
        var end = index
        // 命中词边界（空格/标点）时向后包含一个字符
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
