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

// MARK: - 报告卡 / 异常卡令牌（逐值对账 reader.css，ShadowReportBridgeTests 核对）

/// 跟读报告卡与异常卡的尺寸/动效令牌。阅读室与口语页同一套观感，值逐项对账
/// Windows reader.css：.speak-report-card（3793-3807）、@keyframes rc-in（3809-3818）、
/// .speak-report-err（4214-4240）。
enum ShadowCardTokens {
    // .speak-report-card：12 圆角 / padding 12px 14px 11px / gap 9 / 1px 发丝边 /
    // box-shadow 0 1px 3px rgba(16,24,40,.05)（CSS 模糊半径 3px ≈ SwiftUI radius 1.5）
    static let reportCornerRadius: CGFloat = 12
    static let reportPadding = EdgeInsets(top: 12, leading: 14, bottom: 11, trailing: 14)
    static let reportSpacing: CGFloat = 9
    static let reportShadowOpacity: Double = 0.05
    static let reportShadowRadius: CGFloat = 1.5
    static let reportShadowY: CGFloat = 1

    // @keyframes rc-in：.38s cubic-bezier(.2,.9,.3,1.15)，from translateY(8px) scale(.985) opacity 0
    static let enterDuration: Double = 0.38
    static let enterCurve: (c0x: Double, c0y: Double, c1x: Double, c1y: Double) = (0.2, 0.9, 0.3, 1.15)
    static let enterOffsetY: CGFloat = 8
    static let enterScale: CGFloat = 0.985
    /// 「减弱动态效果」时的替代：仅淡入（apple-design §14）。
    static let enterReducedDuration: Double = 0.2

    // .speak-report-err：10 圆角 / padding 9px 12px / gap 6 / border-left 3px / 12.5px 正文 / line-height 1.65
    static let failureCornerRadius: CGFloat = 10
    static let failurePadding = EdgeInsets(top: 9, leading: 12, bottom: 9, trailing: 12)
    static let failureSpacing: CGFloat = 6
    static let failureAccentLineWidth: CGFloat = 3
    static let failureFontSize: CGFloat = 12.5
    /// line-height 1.65 × 12.5px ≈ 20.6pt 行高 → 行距 ≈ 8pt 的一半取 4（SwiftUI lineSpacing 为行间附加值）。
    static let failureLineSpacing: CGFloat = 4

    /// 卡片入场动画（随系统减弱动态效果切换）。
    static func enterAnimation(reduceMotion: Bool) -> Animation {
        reduceMotion
            ? .easeOut(duration: enterReducedDuration)
            : .timingCurve(enterCurve.c0x, enterCurve.c0y, enterCurve.c1x, enterCurve.c1y, duration: enterDuration)
    }

    /// 卡片入场过渡（减弱动态效果时只留淡入）。
    static func enterTransition(reduceMotion: Bool) -> AnyTransition {
        reduceMotion
            ? .opacity
            : .opacity.combined(with: .offset(y: enterOffsetY)).combined(with: .scale(scale: enterScale))
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
        // M-02：底部改悬浮走带胶囊（bottom 18 + 高约 50）后抬高，报告卡不压胶囊。
        .padding(.bottom, 88)
    }
}

// MARK: - 报告卡（数据驱动主体，阅读室与口语页共用）

/// 报告卡动作集（SPEAK-7）：把卡与宿主解耦——阅读室接 vm.assess*，口语页接
/// SpeakViewController 的跟读动作。所有动作由宿主保证「先停播报、与主麦克风互斥」。
struct ShadowReportActions {
    /// 🎤 再跟读整句。
    var again: () -> Void
    /// 🎯 只练差词：宿主负责把 bad+missed 前 4 词开进差词抽屉（body 已算好 entries）。
    var drill: (_ entries: [ShadowDrillController.Entry]) -> Void
    /// 🔊 听领读（整句示范播报）。
    var hearModel: () -> Void
    /// ▶ 听我的录音；nil = 无录音可放（按钮禁用，Windows onHearMine 传 null 同义）。
    var hearMine: (() -> Void)?
    /// 弹层「🔊 听这个词」。
    var speakWord: (_ word: String) -> Void
    /// 弹层「🎯 练这个词」：收弹层后开抽屉并把该词置顶。
    var drillWord: (_ word: String) -> Void
    /// 右上 ✕ 收卡；nil = 不显示（口语页报告卡常驻到下一轮，Windows 同款无 ✕）。
    var dismiss: (() -> Void)?
}

/// 跟读报告卡主体（ShadowReport.tsx 的 Mac 对应物）：总分/徽章 → 维度条 → 诊断句 →
/// 词着色原句（点词音素弹层）→ 动作行。数据全由调用方给（阅读室 = assess 控制器，
/// 口语页 = 落盘 ShadowAttempt），布局尺寸对照 reader.css 的 .speak-report-card
///（3793-3823：12/14/11/14 padding、12 圆角、surface 底 + 发丝边 + 浅投影、9 间距）。
struct ShadowReportCardBody: View {
    let result: XfyunCore.PronunciationResult
    let marks: [XfyunCore.WordMark]
    /// 历次总分（含本次，最新在末尾）——「第 n 次跟读」/ 历次 chips。
    let attemptTotals: [Double]
    let passScore: Double
    /// 词着色底本（与 marks 的 start/end 同源；空 = 无从着色）。
    let target: String
    let actions: ShadowReportActions
    @Environment(\.readerPalette) private var palette
    /// 维度条入场宽度动画（对齐 Windows transition:width .8s）。
    @State private var dimBarMounted = false

    var body: some View {
        let diag = diagnoseShadow(
            result.shadowDiag,
            marks.map(\.shadowDiagMark),
            passScore: passScore
        )
        VStack(alignment: .leading, spacing: ShadowCardTokens.reportSpacing) {
            header(diag: diag)
            dimBars(weakDim: diag.weakDim)
            diagSentence(diag)
            ShadowMarkedSentence(target: target, marks: marks, actions: actions)
            actionRow(diag)
        }
        .padding(ShadowCardTokens.reportPadding)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: ShadowCardTokens.reportCornerRadius))
        .overlay(RoundedRectangle(cornerRadius: ShadowCardTokens.reportCornerRadius).stroke(palette.border, lineWidth: 1))
        .shadow(
            color: .black.opacity(ShadowCardTokens.reportShadowOpacity),
            radius: ShadowCardTokens.reportShadowRadius,
            y: ShadowCardTokens.reportShadowY
        )
    }

    // ---- 头部：总分 + 徽章 + 第 n 次跟读 + 历次 chips + ✕ ----

    private func header(diag: ShadowDiagnosis) -> some View {
        let attemptNo = attemptTotals.count
        let prev: Double? = attemptNo >= 2 ? attemptTotals[attemptNo - 2] : nil
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
            if let dismiss = actions.dismiss {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: ReaderIcons.close)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(palette.textTertiary)
                }
                .buttonStyle(.plain)
                .help("收起报告卡（评测条仍在，下次跟读再弹）")
            }
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
            ForEach(Array(attemptTotals.enumerated()), id: \.offset) { i, total in
                let isCurrent = i == attemptTotals.count - 1
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

    private func dimBars(weakDim: ShadowDimKind?) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach([ShadowDimKind.accuracy, .fluency, .integrity], id: \.self) { dim in
                let score = dimScore(dim)
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

    private func dimScore(_ dim: ShadowDimKind) -> Double {
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
                actions.again()
            } label: {
                Text("🎤 再跟读整句")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)

            if !diag.drillWords.isEmpty {
                Button {
                    actions.drill(shadowDrillEntries(target: target, marks: marks))
                } label: {
                    Text("🎯 只练 \(diag.drillWords.count) 个词")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }

            ShadowLinkButton(title: "🔊 听领读") {
                actions.hearModel()
            }
            ShadowLinkButton(title: "▶ 听我的录音", disabled: actions.hearMine == nil) {
                actions.hearMine?()
            }
            Spacer(minLength: 0)
        }
    }
}

// MARK: - 报告卡（阅读室挂载：数据直读 assess 控制器）

/// 阅读室报告卡：assess 控制器 → 数据驱动主体的薄壳（结果/词着色/尝试历史/录音留存
/// 均来自 ShadowAssessController；结果与词着色也供 AssessStripView 评测条复用）。
private struct ShadowReportCard: View {
    private let vm: ReaderViewModel
    @ObservedObject private var assess: ShadowAssessController

    init(vm: ReaderViewModel) {
        self.vm = vm
        self.assess = vm.assess
    }

    var body: some View {
        if let result = assess.state.result {
            ShadowReportCardBody(
                result: result,
                marks: assess.state.marks,
                attemptTotals: assess.attemptTotals,
                passScore: vm.effectiveSettings.shadowingPassScore,
                target: vm.assessTargetSentence ?? "",
                actions: ShadowReportActions(
                    again: { vm.assessRetry() },
                    drill: { entries in vm.drill.open(entries: entries) },
                    hearModel: { vm.assessLead() },
                    hearMine: assess.lastAttemptPcm == nil
                        ? nil
                        : { vm.playAssessRecording() },
                    speakWord: { vm.speakWord($0) },
                    drillWord: { word in vm.openDrill(preferring: word) },
                    dismiss: { assess.dismissReport() }
                )
            )
        }
    }
}

// MARK: - 落盘 attempts → 报告卡视图数据（SPEAK-7：口语页复用）

/// 落盘跟读 attempts 派生的报告卡数据（Windows SpeakView.tsx:650-678 lastReport：
/// 渲染统一从落盘派生——刚评完与重开旧会话走同一条路）。result 为末次 attempt 的
/// 视图重建（isRejected=false / exceptInfo=nil：进 attempts 的必是干净结果）。
struct ShadowAttemptReport: Equatable {
    /// 末次尝试时间戳（报告卡重挂载 key，换新一轮即重渲）。
    let attemptAt: Int64
    /// 本轮全部尝试的总分（含本次，最新在末尾）。
    let totals: [Double]
    let result: XfyunCore.PronunciationResult
    let marks: [XfyunCore.WordMark]
}

/// attempts 非空时派生报告卡数据；空/无末次返回 nil。
func shadowAttemptReport(target: String, attempts: [ShadowAttempt]) -> ShadowAttemptReport? {
    guard let last = attempts.last else { return nil }
    let words = last.words.map(\.xfyunWordScore)
    return ShadowAttemptReport(
        attemptAt: last.at,
        totals: attempts.map(\.total),
        result: PronunciationResult(
            total: last.total,
            accuracy: last.accuracy,
            fluency: last.fluency,
            standard: last.total,
            integrity: last.integrity,
            isRejected: false,
            exceptInfo: nil,
            words: words
        ),
        marks: mapWordsToText(text: target, words: words)
    )
}

// MARK: - 词着色原句（四档全着色 + 点词音素弹层）

/// 报告卡的词着色原句：按 marks 的 start/end 切原句（空隙为普通文案，词为着色词），
/// FlowLayout 逐词换行。四档样式逐条对齐 reader.css:4024-4042：
/// good→ok 绿字 / ok→warn 黄字 / bad→err+点状下划线 / missed→err+实线下划线+err 12% 底。
/// 可点（弹层）仅 quality != good（ShadowReport.tsx:263）。
/// 切句底本 target 必须与 marks 对齐同源（阅读室 = vm.assessTargetSentence；口语页 =
/// 最新 assistant 句）。
private struct ShadowMarkedSentence: View {
    /// 对齐底本（空 = 无从着色，整块不渲染）。
    let target: String
    let marks: [XfyunCore.WordMark]
    let actions: ShadowReportActions
    @Environment(\.readerPalette) private var palette
    /// 当前弹出音素层的词（token id；NSPopover 原生处理点外部/Esc 关闭）。
    @State private var activeToken: Int?

    private struct Token: Identifiable {
        let id: Int
        let text: String
        let mark: XfyunCore.WordMark?   // nil = 普通间隙
    }

    var body: some View {
        if !target.isEmpty {
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
            ShadowWordPopover(
                text: token.text,
                mark: mark,
                onSpeakWord: actions.speakWord,
                onDrillWord: { word in
                    activeToken = nil
                    actions.drillWord(word)
                }
            )
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
/// 动作走闭包（宿主决定是阅读室 vm 还是口语控制器）。
private struct ShadowWordPopover: View {
    let text: String
    let mark: XfyunCore.WordMark
    let onSpeakWord: (String) -> Void
    /// 「练这个词」：宿主先收弹层再开抽屉置顶该词。
    let onDrillWord: (String) -> Void
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
                    onSpeakWord(text)
                } label: {
                    Text("🔊 听这个词").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                if !missed {
                    Button {
                        onDrillWord(text)
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

// MARK: - 跟读异常可行动卡片（SPEAK-13，对齐 SpeakView.tsx:1604-1669 ShadowErrorCard）

/// 跟读异常的可行动卡片：标题 + 一句怎么办 + 动作按钮（听领读 / 再跟读）。
/// 视觉对齐 reader.css:4214-4240 .speak-report-err：1px 发丝边 + 左边 3pt 强调线 +
/// 10 圆角 + 9/12 padding；rejected = warn 左线 + warnSoft 底，其余三类走 .novoice
/// 中性变体（左边 textTertiary + surfaceAlt 底）；标题 600 text、正文 12.5 textSecondary。
struct ShadowFailureCardView: View {
    let card: ShadowFailureCard
    /// 按钮分发（口语控制器 performShadowFailureAction；听领读先停播报）。
    let perform: (ShadowFailureActionKind) -> Void
    /// 收起角标（nil = 无 ✕；口语页与 Windows 一致常驻到下一轮，这里留逃生门）。
    var onDismiss: (() -> Void)?
    @Environment(\.readerPalette) private var palette

    private var accentColor: Color { card.kind == .rejected ? palette.warn : palette.textTertiary }
    private var cardBackground: Color { card.kind == .rejected ? palette.warnSoft : palette.surfaceAlt }

    var body: some View {
        VStack(alignment: .leading, spacing: ShadowCardTokens.failureSpacing) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: card.title)
                    .font(.system(size: ShadowCardTokens.failureFontSize, weight: .semibold))
                    .foregroundColor(palette.text)
                Spacer(minLength: 8)
                if let onDismiss {
                    Button {
                        onDismiss()
                    } label: {
                        Image(systemName: ReaderIcons.close)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(palette.textTertiary)
                    }
                    .buttonStyle(.plain)
                    .help("收起这张卡（点「跟读打分」重新开始）")
                }
            }
            Text(verbatim: card.body)
                .font(.system(size: ShadowCardTokens.failureFontSize))
                .foregroundColor(palette.textSecondary)
                .lineSpacing(ShadowCardTokens.failureLineSpacing)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                ForEach(Array(card.actions.enumerated()), id: \.offset) { _, action in
                    actionButton(action)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(ShadowCardTokens.failurePadding)
        .background(cardBackground, in: RoundedRectangle(cornerRadius: ShadowCardTokens.failureCornerRadius))
        .overlay(
            RoundedRectangle(cornerRadius: ShadowCardTokens.failureCornerRadius).stroke(palette.border, lineWidth: 1)
        )
        .overlay(alignment: .leading) {
            // 左边 3pt 强调线（border-left: 3px）：rejected = warn，其余中性
            RoundedRectangle(cornerRadius: 2)
                .fill(accentColor)
                .frame(width: ShadowCardTokens.failureAccentLineWidth)
                .padding(.vertical, 1)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("跟读提示：\(card.title)")
    }

    /// rc-btn.primary → borderedProminent；rc-btn → bordered（与报告卡动作行同一套控件）。
    @ViewBuilder
    private func actionButton(_ action: ShadowFailureAction) -> some View {
        if action.primary {
            Button {
                perform(action.kind)
            } label: {
                Text(verbatim: action.title)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
        } else {
            Button {
                perform(action.kind)
            } label: {
                Text(verbatim: action.title)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }
}
