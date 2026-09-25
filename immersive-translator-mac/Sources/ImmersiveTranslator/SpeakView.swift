import SwiftUI
import ReaderCore
import XfyunCore

/// 口语陪练视图（R3）：入口页（4 场景 × 3 难度 + 最近会话）+ 对话环。
/// 对齐 Windows SpeakView.tsx 的结构与交互：
/// - 按住说话（松手送识别；播报中可插话打断）
/// - assistant 气泡（英文 serif + 中文提示 + 跟读分）
/// - 最近 assistant 轮跟读打分（ISE 5 分制，<4.2 提示再试）

struct SpeakView: View {
    @ObservedObject var vm: ReaderViewModel
    @ObservedObject var controller: SpeakViewController
    @Environment(\.readerPalette) private var palette
    @State private var reviewShown = false
    /// 复盘弹层关掉之后要接的动作（完成页「生成复习笔记 / 去复习」）：
    /// 在 onDismiss 里执行，保证上一个 sheet 完全收起后再开下一个。
    @State private var pendingAfterReview: PendingAfterReview?

    private enum PendingAfterReview {
        case noteDialog(ids: [String])
        case goReview
    }

    var body: some View {
        Group {
            if controller.session == nil {
                entryPage
            } else {
                conversationPage
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { controller.refreshRecent() }
        .sheet(isPresented: $reviewShown, onDismiss: {
            switch pendingAfterReview {
            case .noteDialog(let ids):
                vm.openNoteDialog(preselect: ids)
            case .goReview:
                vm.openReview()
            case nil:
                break
            }
            pendingAfterReview = nil
        }) {
            if let session = controller.session {
                SpeakReviewView(
                    vm: vm,
                    session: session,
                    onGenerateNote: { pendingAfterReview = .noteDialog(ids: $0); reviewShown = false },
                    onGoReview: { pendingAfterReview = .goReview; reviewShown = false }
                )
            }
        }
    }

    /// 有没有可复盘的跟读数据（一次都没跟读过时复盘入口禁用）。
    private var hasAssessments: Bool {
        controller.session?.turns.contains {
            $0.role == .assistant && !($0.shadowAttempts ?? []).isEmpty
        } ?? false
    }

    // MARK: - 入口页

    private var entryPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("口语陪练").font(.system(size: 16, weight: .semibold))
                        Text("选个场景开口说——AI 扮演对方，每句带中文提示，说完还能跟读打分")
                            .font(.system(size: 11.5))
                            .foregroundColor(palette.textTertiary)
                    }
                    Spacer()
                }
                if !controller.hasASR {
                    credentialHint
                }
                ForEach(speakScenarios) { scenario in
                    scenarioCard(scenario)
                }
                if !controller.recentSessions.isEmpty {
                    Text("最近会话").font(.system(size: 12, weight: .semibold)).foregroundColor(palette.textTertiary)
                    ForEach(controller.recentSessions.prefix(3)) { session in
                        recentRow(session)
                    }
                }
            }
            .padding(20)
        }
        .background(palette.background)
    }

    private var credentialHint: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundColor(palette.warn)
            Text("需要「语音评测/听写」凭据才能对话与打分：设置 → 语音（评测凭据可复用给听写）")
                .font(.system(size: 11))
                .foregroundColor(palette.warn)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.warn.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    @State private var selectedDifficulty: SpeakDifficulty = .medium

    private func scenarioCard(_ scenario: SpeakScenario) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(scenario.emoji).font(.system(size: 22))
                VStack(alignment: .leading, spacing: 1) {
                    Text(scenario.label).font(.system(size: 13.5, weight: .semibold))
                    Text(scenario.brief)
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
            }
            Text("“\(scenario.opener)”")
                .font(.system(size: 11.5, design: .serif))
                .foregroundColor(palette.textSecondary)
                .lineLimit(1)
            HStack(spacing: 6) {
                ForEach(SpeakDifficulty.allCases, id: \.self) { d in
                    let info = difficultyOf(d)
                    Button {
                        controller.start(scenario: scenario.id, difficulty: d)
                    } label: {
                        Text(info.label)
                            .font(.system(size: 11, weight: selectedDifficulty == d ? .semibold : .regular))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 4)
                            .background(selectedDifficulty == d ? palette.accent.opacity(0.16) : palette.surfaceAlt)
                            .foregroundColor(selectedDifficulty == d ? palette.accent : palette.textSecondary)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .help(info.note)
                }
                Spacer()
            }
        }
        .padding(12)
        .background(palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(palette.textTertiary.opacity(0.12)))
    }

    private func recentRow(_ session: SpeakSession) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 11))
                .foregroundColor(palette.textTertiary)
            VStack(alignment: .leading, spacing: 1) {
                Text("\(scenarioOf(session.scenario).label) · \(difficultyOf(session.difficulty).label) · \(session.turns.count) 轮")
                    .font(.system(size: 11.5))
                if let last = session.turns.last {
                    Text(last.text)
                        .font(.system(size: 10.5))
                        .foregroundColor(palette.textTertiary)
                        .lineLimit(1)
                }
            }
            Spacer()
            Button("重开") { controller.resume(session) }
                .controlSize(.small)
        }
        .padding(8)
        .background(palette.surfaceAlt)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    // MARK: - 对话页

    private var conversationPage: some View {
        let scenario = controller.session.map { scenarioOf($0.scenario) }
        return VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button {
                    controller.backToEntry()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left").font(.system(size: 10, weight: .semibold))
                        Text("换场景").font(.system(size: 12))
                    }
                }
                .buttonStyle(.plain)
                .foregroundColor(palette.accent)
                Text("\(scenario?.emoji ?? "") \(scenario?.label ?? "") · \(controller.session.map { difficultyOf($0.difficulty).label } ?? "")")
                    .font(.system(size: 12.5, weight: .semibold))
                Spacer()
                if case .error(let message) = controller.phase {
                    Text(message)
                        .font(.system(size: 10.5))
                        .foregroundColor(palette.err)
                        .lineLimit(1)
                        .help(message)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)

            Divider().opacity(0.5)

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 10) {
                        if let session = controller.session {
                            ForEach(session.turns) { turn in
                                turnBubble(turn)
                                    .id(turn.id)
                            }
                        }
                        if controller.phase == .thinking {
                            thinkingBubble
                        }
                    }
                    .padding(16)
                }
                .onChange(of: controller.session?.turns.count) { _ in
                    if let last = controller.session?.turns.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }

            Divider().opacity(0.5)
            controlBar
        }
        .background(palette.background)
    }

    private func turnBubble(_ turn: SpeakTurn) -> some View {
        let isUser = turn.role == .user
        return HStack {
            if isUser { Spacer(minLength: 60) }
            VStack(alignment: isUser ? .trailing : .leading, spacing: 3) {
                Text(turn.text)
                    .font(.system(size: 13, design: .serif))
                    .foregroundColor(palette.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let hint = turn.hintZh {
                    Text(hint)
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let score = turn.shadowScore {
                    Text("跟读 \(String(format: "%.1f", score)) 分\(score < 4.2 ? " · 可以再试一次" : "")")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundColor(score < 4.2 ? palette.warn : palette.ok)
                }
            }
            .padding(10)
            .background(isUser ? palette.accent.opacity(0.12) : palette.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            if !isUser { Spacer(minLength: 60) }
        }
    }

    private var thinkingBubble: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                if controller.streaming.en.isEmpty {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("对方正在输入…").font(.system(size: 11.5)).foregroundColor(palette.textTertiary)
                    }
                } else {
                    Text(controller.streaming.en)
                        .font(.system(size: 13, design: .serif))
                        .opacity(0.7)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(10)
            .background(palette.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            Spacer(minLength: 60)
        }
    }

    // MARK: - 底部控制

    private var controlBar: some View {
        HStack(spacing: 12) {
            // 按住说话：按下开始、松手结束（DragGesture 最小距离 0）
            ZStack {
                RoundedRectangle(cornerRadius: 10)
                    .fill(holdActive ? palette.err : palette.accent)
                    .frame(width: 128, height: 38)
                VStack(spacing: 1) {
                    Image(systemName: holdActive ? "mic.fill" : "mic")
                        .font(.system(size: 13))
                    Text(holdLabel).font(.system(size: 10.5, weight: .semibold))
                }
                .foregroundColor(.white)
            }
            .opacity(canHold ? 1 : 0.4)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        if canHold, !holdActive {
                            holdActive = true
                            controller.beginHold()
                        }
                    }
                    .onEnded { _ in
                        if holdActive {
                            holdActive = false
                            controller.endHold()
                        }
                    }
            )
            .help("按住说英语，松手送识别；播报中可以插话打断")

            if controller.phase == .holding {
                levelBar(controller.level)
                Text(String(format: "%.1fs", Double(controller.elapsedMs) / 1000))
                    .font(.system(size: 10.5).monospacedDigit())
                    .foregroundColor(palette.textTertiary)
            }

            Spacer()

            if controller.phase == .thinking {
                Button("跳过回复") { controller.skipReply() }
                    .controlSize(.small)
            }
            if controller.phase == .speaking {
                Button("停止播报") { controller.stopSpeaking() }
                    .controlSize(.small)
            }
            Button {
                controller.replayLast()
            } label: {
                Image(systemName: "speaker.wave.2").font(.system(size: 12))
            }
            .buttonStyle(.plain)
            .foregroundColor(palette.textSecondary)
            .help("重听最近一句")

            Button {
                controller.beginShadowRecord()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "waveform.badge.mic").font(.system(size: 11))
                    Text("跟读打分").font(.system(size: 11.5))
                }
            }
            .buttonStyle(.plain)
            .foregroundColor(palette.accent)
            .disabled(controller.phase != .idleTurn)
            .help("照最近一句 AI 的话重录一遍，讯飞评测打分")

            // 结束本轮并复盘：跟读弱词 → 确认后加入生词本（无跟读记录时禁用）
            Button {
                controller.stopSpeaking()
                reviewShown = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "text.badge.checkmark").font(.system(size: 11))
                    Text("结束本轮并复盘").font(.system(size: 11.5))
                }
            }
            .buttonStyle(.plain)
            .foregroundColor(hasAssessments ? palette.accent : palette.textTertiary)
            .disabled(!hasAssessments)
            .help(hasAssessments
                ? "复盘本轮跟读中没掌握的词，确认后加入生词本"
                : "还没有跟读记录——先「跟读打分」一次再来复盘")

            if controller.phase == .shadowRecording {
                Button("说完") { controller.finishShadowRecord() }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
                levelBar(controller.level)
            }
            if controller.phase == .shadowAssessing {
                ProgressView().controlSize(.mini)
                Text("评测中…").font(.system(size: 11)).foregroundColor(palette.textTertiary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(palette.surface)
    }

    @State private var holdActive = false

    private var canHold: Bool {
        switch controller.phase {
        case .idleTurn, .error:
            return controller.hasASR
        default:
            return false
        }
    }

    private var holdLabel: String {
        switch controller.phase {
        case .holding: return "松手发送"
        case .transcribing: return "识别中…"
        default: return "按住说话"
        }
    }

    private func levelBar(_ level: Float) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(palette.surfaceAlt)
                Capsule()
                    .fill(level > 0.05 ? palette.ok : palette.warn)
                    .frame(width: max(4, min(1, Double(level)) * geo.size.width))
            }
        }
        .frame(width: 48, height: 5)
    }
}
