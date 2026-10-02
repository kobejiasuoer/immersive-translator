import Foundation
import SwiftUI
import ReaderCore
import XfyunCore

// MARK: - 差词训练控制器

/// 只练差词（ShadowDrill.tsx:35-259 的 Mac 对应物）：报告卡的动作落点。
/// 逐词「领读 → 跟读 → 出分」，练完回整句再跟读；自带录音/评测（单词一次送
/// ISE），与主跟读互斥——抽屉只在干净 failed 相位可开（主控制器无活动
/// recorder），打开时遮罩盖住 PlayBar 挡掉再试/领读/跳过。
@MainActor
final class ShadowDrillController: ObservableObject {
    /// 一个待练词：原句切片（保留大小写）+ 整句评测时的词明细。
    struct Entry: Equatable {
        let text: String
        let mark: XfyunCore.WordMark
    }

    enum Step: Equatable {
        case idle
        case recording
        case evaluating
        case result(score: Double, improved: Bool)
    }

    struct State: Equatable {
        var shown = false
        var idx = 0
        var step: Step = .idle
        var level: Float = 0
        /// 每词练完的分，nil = 没练（跳过）。
        var scores: [Double?] = []
    }

    @Published private(set) var state = State()

    /// 单词跟读上限 8s（ShadowDrill.tsx:27；无 VAD，与 Windows 一致）。
    static let maxWordMs = 8_000
    /// 静音护栏：峰值阈值与最小样本（0.5s@16k，ts:71-72）。
    static let minPeak: Float = 0.01
    static let minSamples = 8_000

    private var entries: [Entry] = []
    private var recorder: MicRecorder?

    var onSpeakWord: (String) -> Void = { _ in }   // vm.speakWord（word 音轨领读）
    var onToast: (String) -> Void = { _ in }       // vm.showToast
    /// 全部练完 → 回整句再跟读（vm.assessRetry）。
    var onDone: () -> Void = {}

    var entryCount: Int { entries.count }
    func entry(at idx: Int) -> Entry? {
        entries[safe: idx]
    }

    // MARK: - 开关

    /// 打开抽屉：置 shown、idx=0、scores 清空。
    func open(entries: [Entry]) {
        guard !entries.isEmpty else { return }
        self.entries = entries
        state = State(shown: true, idx: 0, step: .idle, level: 0, scores: entries.map { _ in nil })
    }

    /// 弹层「练这个词」：lowercase 匹配把该词提到队首（对齐 ShadowReport.tsx:232-237）。
    func open(entries: [Entry], preferring word: String) {
        guard !entries.isEmpty else { return }
        var list = entries
        if let i = list.firstIndex(where: { $0.text.lowercased() == word.lowercased() }) {
            let picked = list.remove(at: i)
            list.insert(picked, at: 0)
        }
        open(entries: list)
    }

    /// ✕ 退出词练：收麦，回报告卡（failed 态）。
    func close() {
        guard state.shown || recorder != nil else { return }
        recorder?.cancel()
        recorder = nil
        state.shown = false
        state.step = .idle
        state.level = 0
    }

    // MARK: - 逐词动作

    /// 🔊 领读（word 音轨，不打断句子朗读）。
    func speakEntry() {
        guard state.shown, let entry = entries[safe: state.idx] else { return }
        onSpeakWord(entry.text)
    }

    /// 🎤 开录：点一下开录、再点一下结束（Windows 文案写「按住」、实际 onClick 两态）。
    func startWord() {
        guard state.shown, state.step == .idle else { return }
        state.step = .recording
        state.level = 0
        Task { [weak self] in
            guard let self else { return }
            do {
                let rec = try await MicRecorder.start(deviceUID: MicDevicePreference.selectedUID) { [weak self] event in
                    Task { @MainActor [weak self] in
                        self?.handleLevel(event)
                    }
                }
                // 等待授权/启动期间抽屉已关或已点结束：作废这次录音
                guard self.state.shown, self.state.step == .recording, self.recorder == nil else {
                    rec.cancel()
                    return
                }
                self.recorder = rec
            } catch {
                guard self.state.shown, self.state.step == .recording, self.recorder == nil else { return }
                self.state.step = .idle
                self.onToast("麦克风打不开：\((error as? LocalizedError)?.errorDescription ?? "\(error)")")
            }
        }
    }

    /// 结束录音 → 送评（ShadowDrill.tsx:53-103 同构，复用现有协议层）。
    func finishWord() {
        guard state.step == .recording else { return }
        guard let rec = recorder else {
            // 录音还没就绪（授权等待期就点了结束）：回 idle，录音起来后会被作废
            state.step = .idle
            return
        }
        recorder = nil
        let idx = state.idx
        guard let entry = entries[safe: idx] else {
            state.step = .idle
            return
        }
        state.step = .evaluating
        Task { [weak self] in
            guard let self else { return }
            let pcm = rec.stop()
            await MainActor.run {
                self.settle(pcm: pcm, entry: entry, idx: idx)
            }
        }
    }

    /// 下一个词；末词 → 回整句再跟读。
    func next() {
        advance()
    }

    /// 跳过当前词；末词 → 回整句再跟读（Windows next/skip 两分支同语义）。
    func skip() {
        advance()
    }

    // MARK: - 内部

    private func handleLevel(_ event: MicLevelEvent) {
        guard state.step == .recording else { return }
        state.level = event.level
        if event.elapsedMs >= Self.maxWordMs {
            finishWord()
        }
    }

    /// 评审修正（v2 规格遗漏）：末词分支必须**先收抽屉再 onDone**——
    /// onDone 接 vm.assessRetry() 会立即开主评测录音，若抽屉还盖在评测条上，
    /// 抽屉里的大录音按钮仍可点，再点会叠加第二个 AVAudioEngine 输入 tap
    /// （MicRecorder 每实例自带 engine）与主评测录音争用。Windows 上由父级
    /// 负责：drillDone 先 setDrill(null) 卸载 sheet 再 startShadow
    /// （SpeakView.tsx:606-610，sheet 渲染挂在 {drill && …}）。
    private func advance() {
        if state.idx + 1 < entries.count {
            recorder?.cancel()
            recorder = nil
            state.idx += 1
            state.step = .idle
            state.level = 0
        } else {
            close()   // 先卸 sheet、收麦
            onDone()  // 再回整句重录
        }
    }

    private func settle(pcm: [Float], entry: Entry, idx: Int) {
        guard state.shown, state.step == .evaluating, state.idx == idx else { return }
        // 静音护栏（对齐 ts:70-75：隔 16 取样求峰值）
        var peak: Float = 0
        var i = 0
        while i < pcm.count {
            peak = max(peak, abs(pcm[i]))
            i += 16
        }
        if peak < Self.minPeak || pcm.count < Self.minSamples {
            state.step = .idle
            onToast("没听到声音，离麦克风近一点")
            return
        }
        guard let creds = XfyunCredentialsStore.shared.creds(for: .ise) else {
            state.step = .idle
            onToast("未配置讯飞评测凭据：设置 → 语音")
            return
        }
        let pcmData = floatToPcm16Bytes(pcm)
        Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await assessPronunciation(text: entry.text, pcm: pcmData, creds: creds)
                await MainActor.run {
                    guard self.state.shown, self.state.step == .evaluating, self.state.idx == idx else { return }
                    if result.isRejected || result.exceptInfo != nil {
                        self.state.step = .idle
                        self.onToast("这个没听清，再试一次（读准一点、声音大一点）")
                        return
                    }
                    self.state.scores[idx] = result.total
                    self.state.step = .result(score: result.total, improved: result.total > entry.mark.score)
                }
            } catch {
                await MainActor.run {
                    guard self.state.shown, self.state.step == .evaluating, self.state.idx == idx else { return }
                    self.state.step = .idle
                    self.onToast("评测失败：\((error as? LocalizedError)?.errorDescription ?? "\(error)")")
                }
            }
        }
    }
}

// MARK: - 差词抽屉挂载

/// 差词抽屉挂载 wrapper：直观察 drill 控制器（v2 刷新架构）——录音电平 ~23Hz
/// 只重渲抽屉子树，不进 vm。遮罩盖住底部 PlayBar，天然达成「抽屉占用麦克风时
/// 主按钮不可点」（Windows drill-backdrop inset:0 同语义）。
struct ShadowDrillOverlay: View {
    @ObservedObject private var drill: ShadowDrillController
    private let vm: ReaderViewModel

    init(vm: ReaderViewModel) {
        self.drill = vm.drill
        self.vm = vm
    }

    var body: some View {
        Group {
            if drill.state.shown {
                ZStack(alignment: .bottom) {
                    Color.black.opacity(0.32)
                        .contentShape(Rectangle())
                        // 点击遮罩不关闭（Windows backdrop 无点击关闭）：退出走 ✕/结束
                    ShadowDrillSheet(vm: vm)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
        }
        .animation(.easeOut(duration: 0.22), value: drill.state.shown)
    }
}

// MARK: - 差词抽屉

/// 差词抽屉 sheet（ShadowDrill.tsx:159-254 + reader.css:4259-4456）：
/// head（进度点）→ 词卡 + tip → 电平条 → 动作行。
private struct ShadowDrillSheet: View {
    private let vm: ReaderViewModel
    @ObservedObject private var drill: ShadowDrillController
    @Environment(\.readerPalette) private var palette

    init(vm: ReaderViewModel) {
        self.vm = vm
        self.drill = vm.drill
    }

    var body: some View {
        if let entry = drill.entry(at: drill.state.idx) {
            VStack(alignment: .leading, spacing: 0) {
                head
                    .padding(.bottom, 13)
                drillBody(entry)
                levelBar
                    .padding(.top, 12)
                    .padding(.bottom, 11)
                actions(entry)
            }
            .padding(EdgeInsets(top: 16, leading: 22, bottom: 18, trailing: 22))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                TopRoundedRect(radius: 16)
                    .fill(palette.surface)
                    .overlay(alignment: .top) {
                        // 顶部 1px 描边（css border-top: border-strong）
                        Rectangle().fill(palette.border).frame(height: 1)
                    }
            )
        }
    }

    // ---- head：标题 + 进度点 + 进度文案 + ✕ ----

    private var head: some View {
        HStack(spacing: 10) {
            Text("只练差的词")
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundColor(palette.text)
            HStack(spacing: 5) {
                ForEach(0..<drill.entryCount, id: \.self) { i in
                    Circle()
                        .fill(dotColor(i))
                        .frame(width: 7, height: 7)
                }
            }
            Text("\(drill.state.idx + 1) / \(drill.entryCount) · 练完回整句")
                .font(.system(size: 11.5))
                .foregroundColor(palette.textTertiary)
            Spacer(minLength: 8)
            Button {
                drill.close()
            } label: {
                Image(systemName: ReaderIcons.close)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(palette.textTertiary)
            }
            .buttonStyle(.plain)
            .help("退出词练")
        }
    }

    /// 进度点：练完 ok 色 → 当前 accent 色 → 未练 border 色。
    private func dotColor(_ i: Int) -> Color {
        if i < drill.state.idx { return palette.ok }
        if i == drill.state.idx { return palette.accent }
        return palette.border
    }

    // ---- body：左词卡（词/上次分/音素）+ 右 tip ----

    private func drillBody(_ entry: ShadowDrillController.Entry) -> some View {
        let diagWord = entry.mark.shadowDiagMark.word
        let worst = worstPhoneOf(diagWord)
        let phones = diagWord?.phones ?? []
        return HStack(alignment: .center, spacing: 26) {
            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: entry.text)
                    .font(.system(size: 24, weight: .semibold, design: .serif))
                    .foregroundColor(palette.text)
                Text(entry.mark.quality == .missed ? "整句里漏读了它" : String(format: "上次 %.1f 分", entry.mark.score))
                    .font(.system(size: 12.5))
                    .foregroundColor(palette.textTertiary)
                if !phones.isEmpty {
                    ShadowPhoneRow(phones: phones, worst: worst)
                        .frame(maxWidth: 300, alignment: .leading)
                        .padding(.top, 4)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .layoutPriority(1.25)
            .padding(EdgeInsets(top: 13, leading: 15, bottom: 13, trailing: 15))
            .background(palette.surfaceAlt, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))

            drillTip(entry, worst: worst)
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
        }
    }

    /// 右侧 tip：missed → 整句带上就好；有 worst → 纠音提示加粗；否则兜底。
    @ViewBuilder
    private func drillTip(_ entry: ShadowDrillController.Entry, worst: ReaderCore.ShadowDiagPhone?) -> some View {
        Group {
            if entry.mark.quality == .missed {
                Text("先听一遍怎么读，") + Text("下一轮整句把它带上").bold() + Text("就好。")
            } else if let worst {
                Text(verbatim: phoneTip(worst.content)).bold()
            } else {
                Text("对照领读慢速跟两遍，注意口型。")
            }
        }
        .font(.system(size: 12))
        .foregroundColor(palette.textSecondary)
        .lineSpacing(4)
    }

    // ---- 电平条 ----

    private var levelBar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(palette.surfaceAlt)
                Capsule()
                    .fill(palette.accent)
                    .frame(width: geo.size.width * min(1, max(0, Double(drill.state.level))))
            }
        }
        .frame(height: 4)
    }

    // ---- 动作行 ----

    @ViewBuilder
    private func actions(_ entry: ShadowDrillController.Entry) -> some View {
        switch drill.state.step {
        case .result(let score, let improved):
            HStack(spacing: 8) {
                Text(String(format: "%.1f", score))
                    .font(.system(size: 19, weight: .bold, design: .serif))
                    .foregroundColor(improved ? palette.ok : palette.text)
                Text(resultNote(entry, improved: improved))
                    .font(.system(size: 11.5))
                    .foregroundColor(palette.textTertiary)
                Spacer(minLength: 8)
                Button(drill.state.idx + 1 < drill.entryCount ? "下一个词 →" : "回整句再跟读 🎤") {
                    drill.next()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
        case .idle, .recording, .evaluating:
            HStack(spacing: 10) {
                Button {
                    drill.speakEntry()
                } label: {
                    Text("🔊 领读")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)

                holdButton(entry)

                ShadowLinkButton(title: drill.state.idx + 1 < drill.entryCount ? "跳过" : "结束") {
                    drill.skip()
                }
            }
        }
    }

    /// result 态的备注文案（missed / improved / 还差一点，ts:216-221）。
    private func resultNote(_ entry: ShadowDrillController.Entry, improved: Bool) -> String {
        if entry.mark.quality == .missed {
            return "会读它了，回整句时带上"
        }
        if improved {
            return String(format: "比整句里的 %.1f 高", entry.mark.score)
        }
        return "还差一点，注意高亮的音"
    }

    /// 大录音按钮（drill-hold，高 40 圆角 11）：recording→accent 底白字、
    /// evaluating→半透明禁用、否则 accent-softer 底。click-toggle 两态。
    private func holdButton(_ entry: ShadowDrillController.Entry) -> some View {
        let recording = drill.state.step == .recording
        let evaluating = drill.state.step == .evaluating
        let label: String
        if recording {
            label = "跟读中…松开结束"
        } else if evaluating {
            label = "评分中…"
        } else {
            label = entry.mark.quality == .missed ? "🎤 按住读一读它" : "🎤 按住跟读这个词"
        }
        return Button {
            if recording {
                drill.finishWord()
            } else if !evaluating {
                drill.startWord()
            }
        } label: {
            Text(verbatim: label)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(recording ? .white : palette.accent)
                .frame(maxWidth: .infinity, minHeight: 40)
                .background(
                    RoundedRectangle(cornerRadius: 11)
                        .fill(recording ? palette.accent : palette.accent.opacity(0.1))
                        .overlay(
                            RoundedRectangle(cornerRadius: 11)
                                .stroke(recording ? palette.accent : palette.accent.opacity(0.35), lineWidth: 1.5)
                        )
                )
                .opacity(evaluating ? 0.55 : 1)
        }
        .buttonStyle(.plain)
        .disabled(evaluating)
    }
}

/// 底部 sheet 的顶部圆角 16（macOS 13 无 UnevenRoundedRectangle，自绘路径）。
private struct TopRoundedRect: Shape {
    var radius: CGFloat

    func path(in rect: CGRect) -> Path {
        Path { p in
            p.move(to: CGPoint(x: rect.minX, y: rect.maxY))
            p.addLine(to: CGPoint(x: rect.minX, y: rect.minY + radius))
            p.addQuadCurve(
                to: CGPoint(x: rect.minX + radius, y: rect.minY),
                control: CGPoint(x: rect.minX, y: rect.minY)
            )
            p.addLine(to: CGPoint(x: rect.maxX - radius, y: rect.minY))
            p.addQuadCurve(
                to: CGPoint(x: rect.maxX, y: rect.minY + radius),
                control: CGPoint(x: rect.maxX, y: rect.minY)
            )
            p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
            p.closeSubpath()
        }
    }
}
