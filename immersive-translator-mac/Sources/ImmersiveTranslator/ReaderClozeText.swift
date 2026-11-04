import AppKit
import SwiftUI
import ReaderCore

// MARK: - 随读抽查在正文里的渲染（ReadingView.tsx:520-593 renderSpanSeg 的 TextKit 对应物）
//
// Windows 在句内 span 处原位渲染 `<input class="cloze-input">`（未答）或 `.cloze-done`
//（已答：错答删除线 + 答案 + 印章 + 朱批）。Mac 正文是 NSTextView（对照行 ReaderTextView /
// 画报流 ProseFlowTextView），行内可交互控件没有 DOM 等价物，用两层实现：
// - 文本层：槽位原文整段替换为一个附件字符（U+FFFC），附件 cell 画出槽位的盒子
//  （待答 = 胶带底虚线框 / 已答 = 错答 + 答案 + 第二行朱批），尺寸与 Windows CSS 同口径，
//   正文随之回流（行高/换行与 inline-block 行为一致）；
// - 覆盖层：SwiftUI 在附件字符的 bounding rect 上叠输入框 + 「?」提示钮（待答）或印章
//  （已答，绝对定位 top:-0.72em right:-8px 的旋转徽章）。
// 替换造成原文坐标 ≠ 渲染坐标，ClozeSplice 负责双向映射（词块点击 / 句定位 / 帧回报）。

/// 挖空槽在某个文本块里的渲染态（偏移为该块原文坐标：对照行 = 句内；画报流 = 拼接坐标）。
struct ClozeRenderMark: Equatable {
    let id: String
    let start: Int
    let end: Int
    let answer: String
    let isKnown: Bool
    let verdict: RecallVerdict?
    /// 已答时的原输入（错答显示删除线）。
    let input: String?
    /// 答错时的朱批（陷阱 · … / 释义 · …）。
    let note: String?
    /// 按住 H：待答槽透出答案幽灵字。
    let peeked: Bool

    var range: NSRange { NSRange(location: start, length: max(0, end - start)) }
    var pending: Bool { verdict == nil }
}

/// 原文坐标 ↔ 渲染坐标映射：每个槽位把 range.length 个字符折成 1 个附件字符。
struct ClozeSplice: Equatable {
    struct Replacement: Equatable {
        /// 原文坐标的被替换范围。
        let range: NSRange
        /// 该附件字符在渲染串中的位置。
        let renderedLocation: Int
    }

    let replacements: [Replacement]
    static let identity = ClozeSplice(replacements: [])

    /// 由升序排列的原文范围构造（互不重叠；越界/重叠的由调用方先过滤）。
    init(originalRanges: [NSRange]) {
        var delta = 0
        var list: [Replacement] = []
        for r in originalRanges.sorted(by: { $0.location < $1.location }) {
            list.append(Replacement(range: r, renderedLocation: r.location + delta))
            delta += 1 - r.length
        }
        replacements = list
    }

    private init(replacements: [Replacement]) {
        self.replacements = replacements
    }

    var isIdentity: Bool { replacements.isEmpty }

    /// 原文位置 → 渲染位置（作为范围起点：落在槽内取附件字符位置）。
    func renderedStart(_ p: Int) -> Int {
        var delta = 0
        for r in replacements {
            if NSMaxRange(r.range) <= p {
                delta += 1 - r.range.length
            } else if r.range.location < p {
                return r.renderedLocation
            } else {
                break
            }
        }
        return p + delta
    }

    /// 原文位置 → 渲染位置（作为范围终点：落在槽内取附件字符之后）。
    func renderedEnd(_ p: Int) -> Int {
        var delta = 0
        for r in replacements {
            if NSMaxRange(r.range) <= p {
                delta += 1 - r.range.length
            } else if r.range.location < p {
                return r.renderedLocation + 1
            } else {
                break
            }
        }
        return p + delta
    }

    func renderedRange(_ range: NSRange) -> NSRange {
        let s = renderedStart(range.location)
        let e = renderedEnd(NSMaxRange(range))
        return NSRange(location: s, length: max(0, e - s))
    }

    /// 渲染位置 → 原文位置（附件字符上取槽位起点）。
    func originalIndex(_ rendered: Int) -> Int {
        var delta = 0
        for r in replacements {
            if rendered < r.renderedLocation { break }
            if rendered == r.renderedLocation { return r.range.location }
            delta += 1 - r.range.length
        }
        return rendered - delta
    }
}

/// 槽位 cell 的配色/字号（由 ReaderPalette 换算；两种文本视图共用）。
struct ClozeCellStyle {
    let bodyFont: NSFont
    let ink1: NSColor
    let ink3: NSColor
    let accent: NSColor
    let ok: NSColor
    let warn: NSColor
    let err: NSColor
    let tapeBg: NSColor
    let tapeInk: NSColor

    /// 作答字体：衬线斜体 0.92em（`.cloze-input` font-style italic）。
    var inputFont: NSFont {
        let size = bodyFont.pointSize * 0.92
        let base = NSFont.systemFont(ofSize: size)
        let descriptor = base.fontDescriptor.withDesign(.serif)?.withSymbolicTraits(.italic)
        return descriptor.flatMap { NSFont(descriptor: $0, size: size) } ?? base
    }

    /// 朱批字体：衬线斜体 13px（`.cloze-note`）。
    var noteFont: NSFont {
        let base = NSFont.systemFont(ofSize: 13)
        let descriptor = base.fontDescriptor.withDesign(.serif)?.withSymbolicTraits(.italic)
        return descriptor.flatMap { NSFont(descriptor: $0, size: 13) } ?? base
    }

    func verdictColor(_ verdict: RecallVerdict) -> NSColor {
        switch verdict {
        case .perfect: return ok
        case .close: return warn
        case .trap, .wrong: return err
        }
    }
}

/// 由色板换算 cell 配色（两种正文文本视图共用）。
func clozeCellStyle(font: NSFont, palette: ReaderPalette) -> ClozeCellStyle {
    ClozeCellStyle(
        bodyFont: font,
        ink1: NSColor(palette.text),
        ink3: NSColor(palette.textTertiary),
        accent: NSColor(palette.accent),
        ok: NSColor(palette.ok),
        warn: NSColor(palette.warn),
        err: NSColor(palette.err),
        tapeBg: NSColor(palette.tapeBg),
        tapeInk: NSColor(palette.tapeInk)
    )
}

/// 待答槽（`.cloze-input` 外观）：胶带底 + 2px 虚线底边、3px 上圆角；按住 H（peeked）
/// 透出答案幽灵字（ink-3 斜体，`.cloze.peeked::after`）。输入框本体由 SwiftUI 覆盖层承载。
/// 宽 = max(len,5)ch × 0.62 + 18px（content）+ 14 padding + 4 margin；高 = 1.32em。
final class ClozeBlankCell: NSTextAttachmentCell {
    let style: ClozeCellStyle
    let answer: String
    let ghost: String?

    init(style: ClozeCellStyle, answer: String, ghost: String?) {
        self.style = style
        self.answer = answer
        self.ghost = ghost
        super.init(textCell: "")
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Windows `calc(max(len,5)ch * 0.62 + 18px)` + padding 0 7px + `.cloze` margin 0 2px。
    static func boxWidth(answer: String, inputFont: NSFont) -> CGFloat {
        let ch = ("0" as NSString).size(withAttributes: [.font: inputFont]).width
        let len = CGFloat(max(answer.count, 5))
        return len * ch * 0.62 + 18 + 14
    }

    static func boxHeight(inputFont: NSFont) -> CGFloat {
        (inputFont.pointSize * 1.32).rounded(.up)
    }

    override func cellSize() -> NSSize {
        let font = style.inputFont
        return NSSize(
            width: Self.boxWidth(answer: answer, inputFont: font) + 4,
            height: Self.boxHeight(inputFont: font)
        )
    }

    override func cellBaselineOffset() -> NSPoint {
        let font = style.inputFont
        let h = Self.boxHeight(inputFont: font)
        let content = font.ascender - font.descender
        let pad = max(0, (h - content) / 2)
        return NSPoint(x: 0, y: -(pad - font.descender))
    }

    override func wantsToTrackMouse() -> Bool { false }

    override func draw(withFrame cellFrame: NSRect, in controlView: NSView?) {
        let box = cellFrame.insetBy(dx: 2, dy: 0)
        // 3px 3px 0 0 上圆角胶带底。
        let path = NSBezierPath()
        let r: CGFloat = 3
        path.move(to: NSPoint(x: box.minX, y: box.maxY))
        path.line(to: NSPoint(x: box.minX, y: box.minY + r))
        path.appendArc(withCenter: NSPoint(x: box.minX + r, y: box.minY + r), radius: r, startAngle: 180, endAngle: 270)
        path.line(to: NSPoint(x: box.maxX - r, y: box.minY))
        path.appendArc(withCenter: NSPoint(x: box.maxX - r, y: box.minY + r), radius: r, startAngle: 270, endAngle: 360)
        path.line(to: NSPoint(x: box.maxX, y: box.maxY))
        path.close()
        style.tapeBg.setFill()
        path.fill()
        // 2px 虚线底边（tape-ink）。
        let dash = NSBezierPath()
        dash.move(to: NSPoint(x: box.minX, y: box.maxY - 1))
        dash.line(to: NSPoint(x: box.maxX, y: box.maxY - 1))
        dash.lineWidth = 2
        dash.setLineDash([3, 2], count: 2, phase: 0)
        style.tapeInk.setStroke()
        dash.stroke()
        // 幽灵答案（按住 H）。
        if let ghost, !ghost.isEmpty {
            let attrs: [NSAttributedString.Key: Any] = [.font: style.inputFont, .foregroundColor: style.ink3]
            let size = (ghost as NSString).size(withAttributes: attrs)
            let origin = NSPoint(x: box.midX - size.width / 2, y: box.midY - size.height / 2)
            (ghost as NSString).draw(at: origin, withAttributes: attrs)
        }
    }
}

/// 已答槽：`[错答删除线] 答案`（tape 底 + 判定色点线下划线）+ 第二行朱批（陷阱 · / 释义 ·，
/// 衬线斜体 13px、accent 色、左缩 26px）。印章由覆盖层画（绝对定位，允许盖到上一行）。
final class ClozeDoneCell: NSTextAttachmentCell {
    let style: ClozeCellStyle
    let answer: String
    let wrongInput: String?
    let note: String?
    let verdict: RecallVerdict

    private static let noteLineHeight: CGFloat = 13 * 1.5
    private static let noteTop: CGFloat = 2
    private static let noteBottom: CGFloat = 8
    private static let noteIndent: CGFloat = 26

    init(style: ClozeCellStyle, answer: String, wrongInput: String?, note: String?, verdict: RecallVerdict) {
        self.style = style
        self.answer = answer
        self.wrongInput = wrongInput
        self.note = note
        self.verdict = verdict
        super.init(textCell: "")
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private var answerAttrs: [NSAttributedString.Key: Any] {
        [.font: style.bodyFont, .foregroundColor: style.ink1]
    }

    private var wrongAttrs: [NSAttributedString.Key: Any] {
        [
            .font: style.bodyFont,
            .foregroundColor: style.err.withAlphaComponent(0.85),
            .strikethroughStyle: NSUnderlineStyle.single.rawValue,
            .strikethroughColor: style.err.withAlphaComponent(0.85)
        ]
    }

    private var noteAttrs: [NSAttributedString.Key: Any] {
        [.font: style.noteFont, .foregroundColor: style.accent]
    }

    private var row1Height: CGFloat { (style.bodyFont.ascender - style.bodyFont.descender).rounded(.up) }
    private var noteBlockHeight: CGFloat {
        (note?.isEmpty == false) ? Self.noteTop + Self.noteLineHeight + Self.noteBottom : 0
    }
    private var wrongWidth: CGFloat {
        guard let wrongInput, !wrongInput.isEmpty else { return 0 }
        return (wrongInput as NSString).size(withAttributes: wrongAttrs).width + 4
    }
    private var answerWidth: CGFloat { (answer as NSString).size(withAttributes: answerAttrs).width + 4 }
    private var noteWidth: CGFloat {
        guard let note, !note.isEmpty else { return 0 }
        return Self.noteIndent + (note as NSString).size(withAttributes: noteAttrs).width
    }

    override func cellSize() -> NSSize {
        NSSize(
            width: max(wrongWidth + answerWidth, noteWidth) + 4,
            height: row1Height + noteBlockHeight
        )
    }

    override func cellBaselineOffset() -> NSPoint {
        NSPoint(x: 0, y: -(-style.bodyFont.descender + noteBlockHeight))
    }

    override func wantsToTrackMouse() -> Bool { false }

    override func draw(withFrame cellFrame: NSRect, in controlView: NSView?) {
        var x = cellFrame.minX + 2
        let rowTop = cellFrame.minY
        if let wrongInput, !wrongInput.isEmpty {
            (wrongInput as NSString).draw(at: NSPoint(x: x, y: rowTop), withAttributes: wrongAttrs)
            x += wrongWidth
        }
        // 答案：tape 底（radius 3，padding 0 2px）+ 判定色点线下划线（1.5px，offset 3px）。
        let box = NSRect(x: x, y: rowTop, width: answerWidth, height: row1Height)
        style.tapeBg.setFill()
        NSBezierPath(roundedRect: box, xRadius: 3, yRadius: 3).fill()
        (answer as NSString).draw(at: NSPoint(x: x + 2, y: rowTop), withAttributes: answerAttrs)
        let baselineY = rowTop + style.bodyFont.ascender
        let underline = NSBezierPath()
        underline.move(to: NSPoint(x: box.minX, y: baselineY + 3))
        underline.line(to: NSPoint(x: box.maxX, y: baselineY + 3))
        underline.lineWidth = 1.5
        underline.setLineDash([1.5, 2], count: 2, phase: 0)
        style.verdictColor(verdict).setStroke()
        underline.stroke()
        // 朱批第二行。
        if let note, !note.isEmpty {
            let origin = NSPoint(x: cellFrame.minX + 2 + Self.noteIndent, y: rowTop + row1Height + Self.noteTop)
            (note as NSString).draw(at: origin, withAttributes: noteAttrs)
        }
    }
}

/// 把原文坐标的属性串按挖空槽替换为附件字符，返回映射。调用方先在原文坐标把全部属性
///（底色/下划线/字距…）加好再调本函数——NSMutableAttributedString 替换时自动顺移后续属性。
enum ClozeTextRendering {
    @discardableResult
    static func splice(
        into attributed: NSMutableAttributedString,
        marks: [ClozeRenderMark],
        style: ClozeCellStyle
    ) -> ClozeSplice {
        let full = attributed.length
        // 越界 / 空 / 重叠的槽位丢弃（同段一槽，正常不会重叠；防御脏数据）。
        var accepted: [ClozeRenderMark] = []
        for mark in marks.sorted(by: { $0.start < $1.start }) {
            let r = mark.range
            guard r.length > 0, NSMaxRange(r) <= full else { continue }
            if let last = accepted.last, NSMaxRange(last.range) > r.location { continue }
            accepted.append(mark)
        }
        guard !accepted.isEmpty else { return .identity }
        for mark in accepted.reversed() {
            let attachment = NSTextAttachment()
            if let verdict = mark.verdict {
                let bad = verdict == .trap || verdict == .wrong
                attachment.attachmentCell = ClozeDoneCell(
                    style: style,
                    answer: mark.answer,
                    wrongInput: bad ? mark.input : nil,
                    note: bad ? mark.note : nil,
                    verdict: verdict
                )
            } else {
                attachment.attachmentCell = ClozeBlankCell(
                    style: style,
                    answer: mark.answer,
                    ghost: mark.peeked ? mark.answer : nil
                )
            }
            let piece = NSMutableAttributedString(attachment: attachment)
            piece.addAttributes([.font: style.bodyFont], range: NSRange(location: 0, length: piece.length))
            attributed.replaceCharacters(in: mark.range, with: piece)
        }
        return ClozeSplice(originalRanges: accepted.map(\.range))
    }
}

// MARK: - SwiftUI 覆盖层（输入框 + ? 提示 / 印章）与胶带 toast 层

/// 待答槽覆盖层：行内输入（非受控，Enter 判分 / Esc 失焦 / 点击不冒泡到句定位）+
/// 「?」首字母提示钮（悬停或聚焦时出现；点击填入首字母并聚焦、记 usedHint）。
struct ClozeInputOverlay: View {
    let slot: ClozeSlot
    let fontSize: CGFloat
    let peeked: Bool
    let palette: ReaderPalette
    let onCommit: (String) -> Void
    /// 返回要填入输入框的首字母串。
    let onHint: () -> String
    @State private var text = ""
    @State private var hover = false
    @FocusState private var focused: Bool

    var body: some View {
        let size = fontSize * 0.92
        ZStack(alignment: .topTrailing) {
            TextField("", text: $text)
                .textFieldStyle(.plain)
                .font(focused ? .system(size: size, design: .serif) : .system(size: size, design: .serif).italic())
                .foregroundColor(peeked ? .clear : palette.text)
                .multilineTextAlignment(.center)
                .autocorrectionDisabled()
                .focused($focused)
                .onSubmit { onCommit(text) }
                .onExitCommand { focused = false }
                .padding(.horizontal, 7)
                .background(focused ? palette.glassElevated : Color.clear)
                .overlay(alignment: .bottom) {
                    // 聚焦：实线 accent 底边 + 2px accent-soft 投影（`.cloze-input:focus`）。
                    if focused {
                        Rectangle().fill(palette.accent).frame(height: 2)
                            .shadow(color: palette.accentSoft, radius: 0, y: 2)
                    }
                }
                .accessibilityLabel(clozeInputAccessibilityLabel(slot))
            if hover || focused {
                Button {
                    text = onHint()
                    focused = true
                } label: {
                    Text("?")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(palette.textTertiary)
                        .frame(width: 16, height: 16)
                        .background(Circle().fill(palette.glassElevated))
                        .overlay(Circle().strokeBorder(palette.tapeBorder, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .offset(x: 15, y: -13)
                .help("首字母提示（命中会降档为「接近」）")
                .accessibilityLabel("首字母提示")
            }
        }
        .onHover { hover = $0 }
    }
}

/// 已答槽印章（`.cloze-stamp`：mono 10px、1.5px 描边、4px 圆角、旋转 −7°、绝对定位
/// top:-0.72em right:-8px；四档配色 ok/warn/err/ink-3）。
struct ClozeStampOverlay: View {
    let verdict: RecallVerdict
    let palette: ReaderPalette

    private var color: Color {
        switch verdict {
        case .perfect: return palette.ok
        case .close: return palette.warn
        case .trap: return palette.err
        case .wrong: return palette.textTertiary
        }
    }

    private var background: Color {
        switch verdict {
        case .perfect: return palette.sonicTealSoft
        case .close: return palette.warnSoft
        case .trap: return palette.errSoft
        case .wrong: return palette.surface2
        }
    }

    var body: some View {
        Text(clozeVerdictLabel(verdict))
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .kerning(0.6)
            .foregroundColor(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(RoundedRectangle(cornerRadius: 4).fill(palette.glassElevated))
            .background(RoundedRectangle(cornerRadius: 4).fill(background))
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(color, lineWidth: 1.5))
            .rotationEffect(.degrees(-7))
            .fixedSize()
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// 一个文本块上的全部槽位覆盖层：按回报的附件 rect 定位（块本地坐标）。
struct ClozeOverlayLayer: View {
    @ObservedObject var vm: ReaderViewModel
    let marks: [ClozeRenderMark]
    let rects: [String: CGRect]
    let slots: [String: ClozeSlot]
    let fontSize: CGFloat
    let palette: ReaderPalette

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(marks, id: \.id) { mark in
                if let rect = rects[mark.id], let slot = slots[mark.id] {
                    if mark.pending {
                        ClozeInputOverlay(
                            slot: slot,
                            fontSize: fontSize,
                            peeked: mark.peeked,
                            palette: palette,
                            onCommit: { vm.commitCloze(slot, raw: $0) },
                            onHint: { vm.useClozeHint(slot) }
                        )
                        .frame(width: max(0, rect.width - 4), height: rect.height)
                        .offset(x: rect.minX + 2, y: rect.minY)
                    } else if let verdict = mark.verdict {
                        ClozeStampOverlay(verdict: verdict, palette: palette)
                            .frame(width: rect.width + 16, alignment: .trailing)
                            .offset(x: rect.minX - 8, y: rect.minY - fontSize * 0.72)
                    }
                }
            }
        }
    }
}

/// 左下角胶带小条层（`.cloze-toast-layer` aria-live=polite）：每条 `{word} · {label}`，
/// 7px 色点按判定（ok / warn / err / ink-3），胶带底 + 边 + −1.2° 微旋。
struct ClozeToastLayer: View {
    let toasts: [ReaderViewModel.ClozeToast]
    @Environment(\.readerPalette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(toasts) { toast in
                HStack(spacing: 9) {
                    Circle().fill(dot(toast.tone)).frame(width: 7, height: 7)
                    Text("\(toast.word) · \(toast.label)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(palette.tapeInk)
                        .lineLimit(1)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 3).fill(palette.tapeBg))
                .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(palette.tapeBorder, lineWidth: 1))
                .shadow(color: palette.shadowPill, radius: 8, y: 3)
                .rotationEffect(.degrees(-1.2))
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .frame(maxWidth: 340, alignment: .leading)
        .animation(ReaderMotion.hover, value: toasts)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("随读抽查结果")
    }

    private func dot(_ tone: RecallVerdict) -> Color {
        switch tone {
        case .perfect: return palette.ok
        case .close: return palette.warn
        case .trap: return palette.err
        case .wrong: return palette.textTertiary
        }
    }
}
