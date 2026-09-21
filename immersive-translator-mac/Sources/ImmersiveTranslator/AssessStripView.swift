import SwiftUI
import ReaderCore

/// 跟读评测条（PlayBar 跟读等待位）：状态文案 + 电平条 + 分数 + 动作按钮。
/// 对齐 Windows AssessStrip：ready（开口跟读）/ recording（电平+计时）/
/// evaluating / leading / passed（✅ 自动下一句）/ failed（分数+再试/领读/跳过）/ error。
struct AssessStripView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.readerPalette) private var palette

    var body: some View {
        let state = vm.assess.state
        HStack(spacing: 10) {
            phaseLabel(state)
            if state.phase == .recording {
                levelBar(state.level)
                Text(String(format: "%.1fs", Double(state.elapsedMs) / 1000))
                    .font(.system(size: 10.5).monospacedDigit())
                    .foregroundColor(palette.textTertiary)
                Button("说完") { vm.assessFinishManually() }
                    .controlSize(.small)
            }
            if state.phase == .ready {
                Button("开口跟读") { vm.assessOpenMic() }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
                Button("跳过") { vm.assessSkip() }
                    .controlSize(.small)
            }
            if state.phase == .failed {
                scoreLabel(state)
                Button("再试") { vm.assessRetry() }
                    .controlSize(.small)
                Button("领读") { vm.assessLead() }
                    .controlSize(.small)
                    .help("慢速示范朗读，听完自动重新开麦")
                Button("跳过") { vm.assessSkip() }
                    .controlSize(.small)
            }
            if state.phase == .error {
                Button("再试") { vm.assessRetry() }
                    .controlSize(.small)
                Button("跳过") { vm.assessSkip() }
                    .controlSize(.small)
            }
        }
    }

    @ViewBuilder
    private func phaseLabel(_ state: ShadowAssessController.State) -> some View {
        switch state.phase {
        case .idle:
            EmptyView()
        case .ready:
            Label("等你开口跟读", systemImage: "mic.badge.xmark")
                .font(.system(size: 11.5))
                .foregroundColor(palette.warn)
        case .recording:
            Label("录音中…", systemImage: "mic.fill")
                .font(.system(size: 11.5))
                .foregroundColor(palette.err)
        case .evaluating:
            HStack(spacing: 5) {
                ProgressView().controlSize(.mini)
                Text("评测中…").font(.system(size: 11.5)).foregroundColor(palette.textSecondary)
            }
        case .leading:
            Label("领读中，听完再跟读", systemImage: "waveform")
                .font(.system(size: 11.5))
                .foregroundColor(palette.accent)
        case .passed:
            Label(String(format: "%.1f 分 · 过关 ✅", state.result?.total ?? 0), systemImage: "checkmark.seal.fill")
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundColor(palette.ok)
        case .failed:
            if let error = state.error {
                Text(error)
                    .font(.system(size: 11.5))
                    .foregroundColor(palette.warn)
                    .lineLimit(1)
            }
        case .error:
            Text(state.error ?? "评测失败")
                .font(.system(size: 11.5))
                .foregroundColor(palette.err)
                .lineLimit(1)
                .help(state.error ?? "")
        }
    }

    @ViewBuilder
    private func scoreLabel(_ state: ShadowAssessController.State) -> some View {
        if let result = state.result {
            HStack(spacing: 4) {
                scoreChip("准", result.accuracy)
                scoreChip("流", result.fluency)
                scoreChip("声", result.standard)
            }
        }
    }

    private func scoreChip(_ label: String, _ value: Double) -> some View {
        Text("\(label) \(String(format: "%.1f", value))")
            .font(.system(size: 10).monospacedDigit())
            .foregroundColor(value >= 4 ? palette.ok : (value >= 3 ? palette.warn : palette.err))
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
        .frame(width: 56, height: 5)
    }
}
