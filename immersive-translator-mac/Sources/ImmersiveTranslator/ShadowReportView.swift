import AVFoundation
import SwiftUI
import ReaderCore
import XfyunCore

// MARK: - XfyunCore → ReaderCore 桥接（应用层唯一能同时见两个模块的地方）

extension XfyunCore.PronunciationResult {
    /// 诊断所需子集直传（standard 不参与诊断）。
    var shadowDiag: ReaderCore.ShadowDiagResult {
        ReaderCore.ShadowDiagResult(
            total: total, accuracy: accuracy, fluency: fluency, integrity: integrity,
            isRejected: isRejected, exceptInfo: exceptInfo
        )
    }
}

extension XfyunCore.WordQuality {
    /// 一一映射（四档同义；ReaderCore 零依赖所以另行声明）。
    var shadowDiagQuality: ReaderCore.ShadowDiagQuality {
        switch self {
        case .good: return .good
        case .ok: return .ok
        case .bad: return .bad
        case .missed: return .missed
        }
    }
}

extension XfyunCore.WordMark {
    /// word: WordScore → ShadowDiagWord（音节边界不参与展示，展平成 phones）。
    var shadowDiagMark: ReaderCore.ShadowDiagMark {
        ReaderCore.ShadowDiagMark(
            quality: quality.shadowDiagQuality,
            score: score,
            word: word.map { w in
                ReaderCore.ShadowDiagWord(
                    content: w.content,
                    phones: w.sylls.flatMap { syl in
                        syl.phones.map { ReaderCore.ShadowDiagPhone(content: $0.content, gwpp: $0.gwpp) }
                    }
                )
            }
        )
    }
}

/// 「干净结果」门槛：!isRejected && exceptInfo == nil（isIsePass 的前两项语义，
/// XfyunIse.swift:324-326）。被拒/无语音/信噪比差的结果：不弹报告卡、不进
/// attemptTotals（对齐 Windows SpeakView.tsx:508-527「不计入 attempts（不污染趋势）」）。
func isCleanIseResult(_ result: XfyunCore.PronunciationResult) -> Bool {
    !result.isRejected && result.exceptInfo == nil
}

/// 差词训练清单：四档 bad+missed 按出现序前 4 个，词原文取原句切片（保留大小写，
/// 对齐 ShadowReport.tsx:281-286）。target 必须与对齐底本同源：assessTargetSentence
/// 即 article?.sentences[safe: idx]?.en——marks 的 start/end 是对该串的 UTF-16 偏移。
func shadowDrillEntries(target: String, marks: [XfyunCore.WordMark]) -> [ShadowDrillController.Entry] {
    let ns = target as NSString
    return marks
        .filter { $0.quality == .bad || $0.quality == .missed }
        .prefix(4)
        .compactMap { m in
            guard m.start >= 0, m.end <= ns.length, m.end > m.start else { return nil }
            return ShadowDrillController.Entry(
                text: ns.substring(with: NSRange(location: m.start, length: m.end - m.start)),
                mark: m
            )
        }
}

// MARK: - 录音回放器

/// 「听我的录音」回放器：16k Float32 PCM → 内存 WAV（44 字节 RIFF 头）→ AVAudioPlayer。
/// 与 LeadSpeaker/朗读引擎并行出声无冲突（同 LeadSpeaker.swift 的 AVAudioPlayer 用法）。
@MainActor
final class ShadowRecordingPlayer: NSObject, AVAudioPlayerDelegate, ObservableObject {
    @Published private(set) var playing = false
    private var player: AVAudioPlayer?

    /// 空数据/播放失败静默（Windows hearMine 同语义）。
    func play(_ pcm: [Float], sampleRate: Int = 16_000) {
        stop()
        guard !pcm.isEmpty else { return }
        guard let p = try? AVAudioPlayer(data: Self.wavData(pcm: pcm, sampleRate: sampleRate), fileTypeHint: AVFileType.wav.rawValue) else {
            return
        }
        p.delegate = self
        player = p
        playing = true
        p.play()
    }

    func stop() {
        player?.stop()
        player = nil
        playing = false
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            self?.playing = false
        }
    }

    /// 纯数据构造：44 字节标准 WAV 头 + Int16 LE 采样（超界钳位 [-1,1]），可单测。
    nonisolated static func wavData(pcm: [Float], sampleRate: Int) -> Data {
        let body = floatToPcm16Bytes(pcm)
        var data = Data(capacity: 44 + body.count)
        func ascii(_ s: String) { data.append(contentsOf: s.utf8) }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        ascii("RIFF")
        u32(UInt32(36 + body.count))       // RIFF 块大小
        ascii("WAVE")
        ascii("fmt ")
        u32(16)                             // fmt 块大小
        u16(1)                              // PCM
        u16(1)                              // 单声道
        u32(UInt32(sampleRate))
        u32(UInt32(sampleRate * 2))         // byteRate = rate × blockAlign
        u16(2)                              // blockAlign = 声道 × 2B
        u16(16)                             // bitsPerSample
        ascii("data")
        u32(UInt32(body.count))
        data.append(body)
        return data
    }
}

// MARK: - 报告卡挂载

/// 报告卡挂载 wrapper（v2 刷新架构）：直观察 assess 控制器——显隐与内容随控制器
/// 变化在本子树重渲，不经 vm（容器只观察 vm，不会因子控制器变化而重渲；录音电平
/// 等 ~23Hz 高频变化也不进 vm，避免阅读室全树重渲）。
struct ShadowReportOverlay: View {
    @ObservedObject private var assess: ShadowAssessController
    private let vm: ReaderViewModel

    init(vm: ReaderViewModel) {
        self.assess = vm.assess
        self.vm = vm
    }

    /// 干净的 failed 相位且卡未被 ✕ 收起才弹：被拒/异常结果不弹卡（评测条错误文案
    /// 照旧），pass 相位不弹卡（过关 650ms 自动进句，弹卡会打断连续朗读）。
    private var showCard: Bool {
        guard assess.state.phase == .failed, !assess.reportDismissed,
              let result = assess.state.result else { return false }
        return isCleanIseResult(result)
    }

    var body: some View {
        Group {
            if showCard {
                ShadowReportCard(vm: vm)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.25), value: showCard)
        .frame(maxWidth: 560, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.bottom, 60)
    }
}

// MARK: - 报告卡

/// 跟读报告卡（ShadowReport.tsx 的 Mac 对应物）：总分/徽章 → 维度条 → 诊断句 →
/// 词着色原句 → 动作行。数据直读 assess 控制器（结果/词着色/尝试历史/录音留存），
/// 布局尺寸对照 reader.css 的 .speak-report-card（3810-3823）。
private struct ShadowReportCard: View {
    private let vm: ReaderViewModel
    @ObservedObject private var assess: ShadowAssessController
    @Environment(\.readerPalette) private var palette
    /// 维度条入场宽度动画（对齐 Windows transition:width .8s）。
    @State private var dimBarMounted = false

    init(vm: ReaderViewModel) {
        self.vm = vm
        self.assess = vm.assess
    }

    private var passScore: Double { vm.effectiveSettings.shadowingPassScore }

    var body: some View {
        if let result = assess.state.result {
            let diag = diagnoseShadow(
                result.shadowDiag,
                assess.state.marks.map(\.shadowDiagMark),
                passScore: passScore
            )
            VStack(alignment: .leading, spacing: 9) {
                header(result: result, diag: diag)
                dimBars(result: result, weakDim: diag.weakDim)
                diagSentence(diag)
                ShadowMarkedSentence(vm: vm, target: vm.assessTargetSentence, marks: assess.state.marks)
                actionRow(diag)
            }
            .padding(EdgeInsets(top: 12, leading: 14, bottom: 11, trailing: 14))
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
            .shadow(color: .black.opacity(0.08), radius: 5, y: 1)
        }
    }

    // ---- 头部：总分 + 徽章 + 第 n 次跟读 + 历次 chips + ✕ ----

    private func header(result: XfyunCore.PronunciationResult, diag: ShadowDiagnosis) -> some View {
        let attemptNo = assess.attemptTotals.count
        let prev: Double? = attemptNo >= 2 ? assess.attemptTotals[attemptNo - 2] : nil
        let delta: Double? = prev.map { result.total - $0 }
        return HStack(alignment: .center, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(String(format: "%.1f", result.total))
                    .font(.system(size: 30, weight: .semibold, design: .serif))
                    .foregroundColor(palette.text)
                Text("/ 5")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(palette.textTertiary)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: diag.badge)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundColor(badgeColor(diag.badgeKind))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 2.5)
                    .background(badgeColor(diag.badgeKind).opacity(0.15), in: Capsule())
                subline(attemptNo: attemptNo, prev: prev, delta: delta)
            }
            Spacer(minLength: 8)
            if attemptNo >= 2 {
                attemptChips
            }
            Button {
                assess.dismissReport()
            } label: {
                Image(systemName: ReaderIcons.close)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(palette.textTertiary)
            }
            .buttonStyle(.plain)
            .help("收起报告卡（评测条仍在，下次跟读再弹）")
        }
    }

    private func badgeColor(_ kind: ShadowBadgeKind) -> Color {
        switch kind {
        case .pass: return palette.ok
        case .almost: return palette.warn
        case .fail: return palette.err
        }
    }

    /// 「第 n 次跟读」；n≥2 追加「· 上次 X ↑|↓delta」（升 ok / 降 err，rc-sub）。
    @ViewBuilder
    private func subline(attemptNo: Int, prev: Double?, delta: Double?) -> some View {
        HStack(spacing: 0) {
            Text("第 \(attemptNo) 次跟读")
            if let prev, let delta {
                Text(verbatim: " · 上次 \(String(format: "%.1f", prev)) ")
                Text(verbatim: "\(delta >= 0 ? "↑" : "↓")\(String(format: "%.1f", abs(delta)))")
                    .foregroundColor(delta >= 0 ? palette.ok : palette.err)
                    .fontWeight(.semibold)
            }
        }
        .font(.system(size: 11.5))
        .foregroundColor(palette.textTertiary)
    }

    /// 历次分数 chips（rc-chips）：当前次 accent 描边加粗，历史 ≥ 门槛 ok 色。
    private var attemptChips: some View {
        HStack(spacing: 4) {
            ForEach(Array(assess.attemptTotals.enumerated()), id: \.offset) { i, total in
                let isCurrent = i == assess.attemptTotals.count - 1
                Text(String(format: "%.1f", total))
                    .font(.system(size: 10.5).monospacedDigit())
                    .fontWeight(isCurrent ? .bold : .regular)
                    .foregroundColor(
                        isCurrent ? palette.accent : (total >= passScore ? palette.ok : palette.textTertiary)
                    )
                    .padding(.horizontal, 7)
                    .padding(.vertical, 1.5)
                    .background(Capsule().fill(isCurrent ? palette.accent.opacity(0.1) : palette.surfaceAlt))
                    .overlay(Capsule().stroke(isCurrent ? palette.accent.opacity(0.4) : palette.border, lineWidth: 1))
            }
        }
    }

    // ---- 维度条：准确度/流畅度/完整度，weak 维度换 warn + 备注 ----

    private func dimBars(result: XfyunCore.PronunciationResult, weakDim: ShadowDimKind?) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach([ShadowDimKind.accuracy, .fluency, .integrity], id: \.self) { dim in
                let score = dimScore(dim, of: result)
                let weak = weakDim == dim
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text(dim.label)
                            .font(.system(size: 11.5))
                            .foregroundColor(weak ? palette.warn : palette.textSecondary)
                            .frame(width: 42, alignment: .leading)
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(palette.surfaceAlt)
                                Capsule()
                                    .fill(weak ? palette.warn : palette.accent)
                                    .frame(width: dimBarMounted ? geo.size.width * min(1, max(0, score / 5)) : 0)
                            }
                        }
                        .frame(height: 5)
                        Text(String(format: "%.1f", score))
                            .font(.system(size: 11.5, weight: .semibold).monospacedDigit())
                            .foregroundColor(weak ? palette.warn : palette.textSecondary)
                            .frame(width: 30, alignment: .trailing)
                    }
                    if weak {
                        Text(Self.dimNote(dim))
                            .font(.system(size: 11))
                            .foregroundColor(palette.textTertiary)
                    }
                }
                .help(Self.dimTitle(dim))
            }
        }
        .animation(.easeInOut(duration: 0.8), value: dimBarMounted)
        .onAppear {
            // 首帧 0 宽落地后再展开（对齐 ShadowReport.tsx:59-62 的 30ms mounted 延迟）
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) {
                dimBarMounted = true
            }
        }
    }

    private func dimScore(_ dim: ShadowDimKind, of result: XfyunCore.PronunciationResult) -> Double {
        switch dim {
        case .accuracy: return result.accuracy
        case .fluency: return result.fluency
        case .integrity: return result.integrity
        }
    }

    /// 维度行标题（Windows DIM_TITLES，ShadowReport.tsx:358-362）。
    private static func dimTitle(_ dim: ShadowDimKind) -> String {
        switch dim {
        case .accuracy: return "准确度：每个音发得准不准"
        case .fluency: return "流畅度：语速与停顿是否自然"
        case .integrity: return "完整度：有没有漏词、添词"
        }
    }

    /// 短板维度备注（Windows DIM_NOTES，ShadowReport.tsx:364-368）。
    private static func dimNote(_ dim: ShadowDimKind) -> String {
        switch dim {
        case .accuracy: return "有词的发音不够准（见下方红色词）"
        case .fluency: return "语速与停顿：放慢不着急，词与词连贯"
        case .integrity: return "有漏读/吞掉的词（见下方红底词）"
        }
    }

    // ---- 诊断句：片段按 kind 着色拼接（rc-diag / DiagSpan）----

    private func diagSentence(_ diag: ShadowDiagnosis) -> some View {
        diag.segments.reduce(Text("")) { acc, seg in
            switch seg.kind {
            case .strong:
                acc + Text(verbatim: seg.text).foregroundColor(palette.ok).fontWeight(.semibold)
            case .warn:
                acc + Text(verbatim: seg.text).foregroundColor(palette.warn).fontWeight(.semibold)
            case .err:
                acc + Text(verbatim: seg.text).foregroundColor(palette.err).fontWeight(.semibold)
            case nil:
                acc + Text(verbatim: seg.text)
            }
        }
        .font(.system(size: 12.5))
        .foregroundColor(palette.textSecondary)
        .lineSpacing(4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 11)
        .padding(.vertical, 8)
        .background(palette.surfaceAlt, in: RoundedRectangle(cornerRadius: 9))
    }

    // ---- 动作行：再跟读整句 / 只练差词 / 听领读 / 听我的录音 ----

    private func actionRow(_ diag: ShadowDiagnosis) -> some View {
        HStack(spacing: 8) {
            Button {
                vm.assessRetry()
            } label: {
                Text("🎤 再跟读整句")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)

            if !diag.drillWords.isEmpty {
                Button {
                    vm.openDrillFromCard()
                } label: {
                    Text("🎯 只练 \(diag.drillWords.count) 个词")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }

            ShadowLinkButton(title: "🔊 听领读") {
                vm.assessLead()
            }
            ShadowLinkButton(title: "▶ 听我的录音", disabled: assess.lastAttemptPcm == nil) {
                vm.playAssessRecording()
            }
            Spacer(minLength: 0)
        }
    }
}

// MARK: - 词着色原句（四档全着色 + 点词音素弹层）

/// 报告卡的词着色原句：按 marks 的 start/end 切原句（空隙为普通文案，词为着色词），
/// FlowLayout 逐词换行。四档样式逐条对齐 reader.css:4024-4042：
/// good→ok 绿字 / ok→warn 黄字 / bad→err+点状下划线 / missed→err+实线下划线+err 12% 底。
/// 可点（弹层）仅 quality != good（ShadowReport.tsx:263）。
/// 切句底本 target 与对齐同源：vm.assessTargetSentence（= article.sentences[idx].en）。
private struct ShadowMarkedSentence: View {
    let vm: ReaderViewModel
    /// 对齐底本（nil/空 = 无从着色，整块不渲染）。
    let target: String?
    let marks: [XfyunCore.WordMark]
    @Environment(\.readerPalette) private var palette
    /// 当前弹出音素层的词（token id；NSPopover 原生处理点外部/Esc 关闭）。
    @State private var activeToken: Int?

    private struct Token: Identifiable {
        let id: Int
        let text: String
        let mark: XfyunCore.WordMark?   // nil = 普通间隙
    }

    var body: some View {
        if let target, !target.isEmpty {
            FlowLayout(lineSpacing: 6) {
                ForEach(tokens(target: target)) { token in
                    if let mark = token.mark {
                        // 可点（弹层）仅 quality != good：good 词纯着色，不挂 Button/help
                        //（Windows ShadowReport.tsx:263-269，good 词无 title/onClick）。
                        if mark.quality == .good {
                            wordText(token.text, mark: mark)
                        } else {
                            clickableWord(token, mark: mark)
                        }
                    } else {
                        Text(verbatim: token.text)
                            .font(.system(size: 14.5, design: .serif))
                            .foregroundColor(palette.text)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func tokens(target: String) -> [Token] {
        var out: [Token] = []
        let ns = target as NSString
        var pos = 0
        for m in marks {
            guard m.start >= pos, m.end <= ns.length, m.end > m.start else { continue }
            if m.start > pos {
                out.append(Token(id: out.count, text: ns.substring(with: NSRange(location: pos, length: m.start - pos)), mark: nil))
            }
            out.append(Token(id: out.count, text: ns.substring(with: NSRange(location: m.start, length: m.end - m.start)), mark: m))
            pos = m.end
        }
        if pos < ns.length {
            out.append(Token(id: out.count, text: ns.substring(with: NSRange(location: pos, length: ns.length - pos)), mark: nil))
        }
        return out
    }

    private func clickableWord(_ token: Token, mark: XfyunCore.WordMark) -> some View {
        Button {
            activeToken = token.id
        } label: {
            wordText(token.text, mark: mark)
        }
        .buttonStyle(.plain)
        .help(mark.quality == .missed ? "漏读了" : String(format: "%.1f 分 · 点击看细节", mark.score))
        .popover(
            isPresented: Binding(
                get: { activeToken == token.id },
                set: { if !$0 { activeToken = nil } }
            ),
            attachmentAnchor: .point(.bottom),
            arrowEdge: .bottom
        ) {
            ShadowWordPopover(vm: vm, text: token.text, mark: mark, onClose: { activeToken = nil })
        }
    }

    @ViewBuilder
    private func wordText(_ text: String, mark: XfyunCore.WordMark) -> some View {
        let color: Color = {
            switch mark.quality {
            case .good: return palette.ok
            case .ok: return palette.warn
            case .bad, .missed: return palette.err
            }
        }()
        Text(verbatim: text)
            .font(.system(size: 14.5, design: .serif))
            .foregroundColor(color)
            .padding(.horizontal, 1)
            .background(
                RoundedRectangle(cornerRadius: 3)
                    .fill(mark.quality == .missed ? palette.err.opacity(0.12) : Color.clear)
            )
            .overlay(alignment: .bottom) {
                if mark.quality == .bad || mark.quality == .missed {
                    wordUnderline(dotted: mark.quality == .bad).offset(y: 1)
                }
            }
    }

    @ViewBuilder
    private func wordUnderline(dotted: Bool) -> some View {
        if dotted {
            Rectangle()
                .stroke(palette.err.opacity(0.55), style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
                .frame(height: 1.5)
        } else {
            Rectangle()
                .fill(palette.err.opacity(0.55))
                .frame(height: 1.5)
        }
    }
}

/// 逐词换行的流式布局（macOS 13 Layout 协议）：报告卡词着色原句用，
/// 对齐 Windows renderMarked 的 inline 换行。
struct FlowLayout: Layout {
    /// 词间距（普通间隙自带空格，这里只兜零宽情形）。
    var spacing: CGFloat = 0
    /// 行间距（对齐 reader.css .rc-words line-height:2 的观感）。
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                x = 0
                y += rowHeight + lineSpacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        let width = maxWidth.isFinite ? maxWidth : x
        return CGSize(width: width, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + lineSpacing
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: .unspecified)
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

// MARK: - 点词音素弹层

/// 点词音素弹层（ShadowReport.tsx WordPopover 的 Mac 对应物）：词 + 分数/漏读徽标、
/// 音素行（worst err 底白字）、纠音 tip、听这个词/练这个词。Windows 的手写 portal
/// 定位与点外部/Esc 关闭逻辑由 NSPopover 原生处理，不需要移植。
private struct ShadowWordPopover: View {
    let vm: ReaderViewModel
    let text: String
    let mark: XfyunCore.WordMark
    var onClose: () -> Void = {}
    @Environment(\.readerPalette) private var palette

    var body: some View {
        let diagWord = mark.shadowDiagMark.word
        let worst = worstPhoneOf(diagWord)
        let phones = diagWord?.phones ?? []
        let missed = mark.quality == .missed
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: text)
                    .font(.system(size: 19, weight: .semibold, design: .serif))
                    .foregroundColor(palette.text)
                Spacer(minLength: 8)
                if missed {
                    Text("漏读")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(palette.err)
                } else {
                    Text(String(format: "%.1f", mark.score))
                        .font(.system(size: 12, weight: .bold).monospacedDigit())
                        .foregroundColor(mark.quality == .ok ? palette.warn : palette.err)
                }
            }
            if missed {
                tip {
                    Text("整句里") + Text("没有读到这个词").bold() + Text("——不算读错，下一轮把它带上就好。")
                }
            } else {
                if !phones.isEmpty {
                    ShadowPhoneRow(phones: phones, worst: worst)
                }
                tip {
                    if let worst {
                        Text(verbatim: phoneTip(worst.content)).bold()
                    } else {
                        Text("这个词没有明显出错的音素，整体含糊了一点——对照领读放慢再读一遍。")
                    }
                }
            }
            HStack(spacing: 8) {
                Button {
                    vm.speakWord(text)
                } label: {
                    Text("🔊 听这个词").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                if !missed {
                    Button {
                        onClose()
                        vm.openDrill(preferring: text)
                    } label: {
                        Text("🎯 练这个词").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                }
            }
        }
        .padding(12)
        .frame(width: 264)
    }

    private func tip<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .font(.system(size: 11.5))
            .foregroundColor(palette.textSecondary)
            .lineSpacing(3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .background(palette.surfaceAlt, in: RoundedRectangle(cornerRadius: 8))
    }
}

/// 音素行（弹层与差词抽屉共用）：等分排布，worst 音素 err 底白字（reader.css .ph-row）。
struct ShadowPhoneRow: View {
    let phones: [ReaderCore.ShadowDiagPhone]
    let worst: ReaderCore.ShadowDiagPhone?
    @Environment(\.readerPalette) private var palette

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(phones.enumerated()), id: \.offset) { _, phone in
                let isWorst = worst.map { $0.content == phone.content && $0.gwpp == phone.gwpp } ?? false
                Text(verbatim: phone.content)
                    .font(.system(size: 13, design: .serif))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .foregroundColor(isWorst ? .white : palette.textSecondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 3)
                    .background(
                        RoundedRectangle(cornerRadius: 7)
                            .fill(isWorst ? palette.err : palette.surface)
                            .overlay(RoundedRectangle(cornerRadius: 7).stroke(palette.border, lineWidth: 1))
                    )
            }
        }
    }
}

// MARK: - 链接式小按钮

/// 链接式按钮（Windows rc-link，reader.css:4099-4109）：12pt textTertiary，hover accent，
/// 禁用半透明。
struct ShadowLinkButton: View {
    let title: String
    var disabled: Bool = false
    let action: () -> Void
    @Environment(\.readerPalette) private var palette
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Text(verbatim: title)
                .font(.system(size: 12))
                .foregroundColor(
                    disabled
                        ? palette.textTertiary.opacity(0.45)
                        : (hover ? palette.accent : palette.textTertiary)
                )
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .onHover { hover = $0 }
    }
}
