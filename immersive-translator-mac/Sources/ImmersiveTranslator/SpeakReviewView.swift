import SwiftUI
import ReaderCore

// MARK: - 口语复盘弹层
//
// 跟读弱词 → 用户确认 → 批量入生词本。候选来自 extractSpeakVocab（纯规则，
// 无模型参与）；保存走 ReaderViewModel.saveSpeakReviewCandidate（公共
// CollectActions.addTextToVocab：查词典补词性/释义/音标 + 例句，mergeVocabWord
// 保 SRS 不重复添加），已收藏且挣扎/到期的弱词随后唤醒（srs.dueAt 置 now 提到
// 今日复习队列最前）。对齐 Windows SpeakReviewDialog.tsx。

struct SpeakReviewView: View {
    @ObservedObject var vm: ReaderViewModel
    let session: SpeakSession
    /// 完成页「生成复习笔记」：带新词 ids 请求打开笔记生成弹窗（父视图在
    /// 本弹层完全收起后执行，避免 sheet 叠加竞态）。
    var onGenerateNote: ([String]) -> Void = { _ in }
    /// 完成页「去复习」。
    var onGoReview: () -> Void = {}
    @Environment(\.dismiss) private var dismiss
    @Environment(\.readerPalette) private var palette

    private enum Phase: Equatable {
        case pick
        case saving
        case done
        case empty
    }

    private struct DoneInfo: Equatable {
        var addedWords: [String] = []
        var addedIds: [String] = []
        var wakeCount = 0
        var mergedCount = 0
    }

    @State private var phase: Phase = .pick
    @State private var selected = Set<String>()
    @State private var foldOpen = false
    @State private var saveError = ""
    @State private var doneInfo = DoneInfo()
    /// 进入弹层时定格的候选（弹层生命周期内跟读数据不再变化）。
    @State private var extraction = SpeakVocabExtraction(candidates: [], folded: [])

    private var allCandidates: [SpeakVocabCandidate] {
        extraction.candidates + extraction.folded
    }

    private var rounds: Int {
        max(1, (session.turns.count + 1) / 2)
    }

    private var attemptCount: Int {
        session.turns.reduce(0) { $0 + ($1.shadowAttempts?.count ?? 0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            Group {
                switch phase {
                case .empty:
                    emptyPhase
                case .done:
                    donePhase
                case .pick, .saving:
                    pickPhase
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: 620, height: 540)
        .onAppear {
            extraction = extractSpeakVocab(session, vocabWords: vm.vocabWords)
            phase = allCandidates.isEmpty ? .empty : .pick
            for c in allCandidates where c.defaultChecked && c.existing == nil {
                selected.insert(c.id)
            }
        }
    }

    // MARK: 头部

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("本轮复盘").font(.system(size: 15, weight: .semibold))
                Text(subtitle)
                    .font(.system(size: 11.5))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            if phase != .saving {
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
        }
        .padding(16)
    }

    private var subtitle: String {
        var parts = ["练了 \(rounds) 轮 · 跟读了 \(attemptCount) 句"]
        let found = allCandidates.count
        if found > 0 {
            var line = "发现 \(found) 个需要加强的词"
            if !extraction.folded.isEmpty {
                line += "（已折叠 \(extraction.folded.count) 个）"
            }
            parts.append(line)
        }
        return parts.joined(separator: " · ")
    }

    // MARK: 空态（这轮没有弱词）

    private var emptyPhase: some View {
        VStack(spacing: 10) {
            Text("🎉").font(.system(size: 34))
            Text("这轮没有明显拖后腿的词").font(.system(size: 14, weight: .semibold))
            Text("所有跟读词得分 ≥ 4.0，也没有漏读。保持这个状态，去下一轮吧！")
                .font(.system(size: 11.5))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
            Button("继续练习") { dismiss() }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(20)
    }

    // MARK: 选词

    private var pickPhase: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("候选规则：最新一次词分 < 3.5，或有漏读 / 替换（功能词不收）· 最新 ≥ 4.0 视为已攻克 · 临界与纯漏读 1 次的词默认不勾，由你决定")
                .font(.system(size: 10.5))
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)

            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(extraction.candidates, id: \.id) { c in
                        candidateRow(c)
                    }
                    if !extraction.folded.isEmpty {
                        foldSection
                    }
                }
                .padding(16)
            }

            Divider()
            HStack(spacing: 12) {
                if saveError.isEmpty {
                    Text("已选 \(selected.count) 个 · 保存时自动查词典补齐释义")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                } else {
                    Text("保存失败：\(saveError)")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(palette.err)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                if phase == .saving {
                    ProgressView().controlSize(.mini)
                    Text("正在合并保存…").font(.system(size: 11.5)).foregroundColor(.secondary)
                }
                Button("稍后处理") { dismiss() }
                    .controlSize(.small)
                    .disabled(phase == .saving)
                Button("✓ 加入生词本（\(selected.count)）") {
                    save()
                }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
                .disabled(selected.isEmpty || phase == .saving)
            }
            .padding(12)
        }
    }

    private var foldSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                foldOpen.toggle()
            } label: {
                HStack(spacing: 4) {
                    Text("另有 \(extraction.folded.count) 个较弱的词 · \(extraction.folded.map(\.word).joined(separator: "、"))")
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                    Image(systemName: foldOpen ? "chevron.up" : "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(.secondary)
                }
            }
            .buttonStyle(.plain)
            if foldOpen {
                ForEach(extraction.folded, id: \.id) { c in
                    candidateRow(c)
                }
            }
        }
    }

    // MARK: 单行候选

    private func candidateRow(_ c: SpeakVocabCandidate) -> some View {
        let isDup = c.existing != nil
        return VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Button {
                    guard !isDup else { return }
                    if selected.contains(c.id) {
                        selected.remove(c.id)
                    } else {
                        selected.insert(c.id)
                    }
                } label: {
                    Image(systemName: selected.contains(c.id) ? "checkmark.square.fill" : (isDup ? "minus.square" : "square"))
                        .font(.system(size: 12))
                        .foregroundColor(isDup ? palette.textTertiary.opacity(0.5) : (selected.contains(c.id) ? .accentColor : palette.textTertiary))
                }
                .buttonStyle(.plain)
                .disabled(isDup)
                .help(isDup ? "已在生词本，不重复添加" : "")
                Text(c.word)
                    .font(.system(size: 13, weight: .semibold, design: .serif))
                    .foregroundColor(isDup ? palette.textSecondary : palette.text)
                candidateTags(c)
                Spacer()
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("“\(c.example.en)”")
                    .font(.system(size: 11.5, design: .serif))
                    .foregroundColor(palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let zh = c.example.zh, !zh.isEmpty {
                    Text(zh)
                        .font(.system(size: 10.5))
                        .foregroundColor(palette.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if isDup {
                    Text("✓ 不重复添加 · 保留你已有的 SRS 复习进度，这句口语原句仅作补充例句\(c.wake ? "；已把它提到今天的复习队列最前" : "")。")
                        .font(.system(size: 10.5))
                        .foregroundColor(palette.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.leading, 21)
        }
        .padding(8)
        .background(isDup ? palette.surfaceAlt.opacity(0.6) : palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(palette.textTertiary.opacity(0.1)))
    }

    @ViewBuilder
    private func candidateTags(_ c: SpeakVocabCandidate) -> some View {
        if let score = c.latestScore {
            tagChip(
                "最新 \(String(format: "%.1f", score)) / 5",
                color: score < 3.5 ? palette.err : palette.warn
            )
        }
        if c.reasons.contains(.missed) {
            tagChip(
                c.latestScore == nil && c.missedCount >= 2 ? "漏读 \(c.missedCount) 次" : "漏读",
                color: palette.err
            )
        }
        if c.reasons.contains(.substituted) {
            tagChip("替换", color: palette.err)
        }
        if let score = c.latestScore, score >= 3.5 {
            tagChip("临界", color: palette.warn)
        }
        if let existing = c.existing {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let days = max(1, Int((now - existing.addedAt) / 86_400_000))
            let wrong = existing.recall?.total.wrong ?? 0
            if c.wake {
                tagChip(
                    "已收藏 \(days) 天 · \(wrong >= 1 ? "复习 \(wrong) 次未过" : "已到期该复习了")",
                    color: palette.accent
                )
            } else {
                tagChip("✓ 已在生词本", color: palette.ok)
            }
        }
    }

    private func tagChip(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 9.5, weight: .semibold))
            .foregroundColor(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.1))
            .clipShape(Capsule())
    }

    // MARK: 完成页

    private var donePhase: some View {
        VStack(spacing: 10) {
            Text("✓")
                .font(.system(size: 16, weight: .bold))
                .foregroundColor(.white)
                .frame(width: 34, height: 34)
                .background(Color.green)
                .clipShape(Circle())
            Text("已加入 \(doneInfo.addedWords.count) 个词").font(.system(size: 14, weight: .semibold))
            Text("已排入复习计划 · 今天就可以复习（SRS）")
                .font(.system(size: 11.5))
                .foregroundColor(.secondary)
            if !doneInfo.addedWords.isEmpty {
                WrappingHStack(horizontalSpacing: 6, verticalSpacing: 6) {
                    ForEach(doneInfo.addedWords, id: \.self) { w in
                        HStack(spacing: 4) {
                            Text(w).font(.system(size: 11.5, weight: .medium))
                            Text("今日")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundColor(palette.accent)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1)
                                .background(palette.accent.opacity(0.12))
                                .clipShape(Capsule())
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(palette.surfaceAlt)
                        .clipShape(Capsule())
                    }
                }
                .padding(.horizontal, 24)
            }
            if doneInfo.mergedCount > 0 || doneInfo.wakeCount > 0 {
                Text([
                    doneInfo.mergedCount > 0 ? "\(doneInfo.mergedCount) 个词已在生词本 · 保留进度仅补例句" : "",
                    doneInfo.wakeCount > 0 ? "已把 \(doneInfo.wakeCount) 个已收藏的弱词提到今天复习队列最前" : "",
                ].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.system(size: 10.5))
                    .foregroundColor(.secondary)
            }
            HStack(spacing: 10) {
                Button("📄 生成复习笔记") {
                    onGenerateNote(doneInfo.addedIds)
                }
                .controlSize(.small)
                .disabled(doneInfo.addedIds.isEmpty)
                Button("▶ 去复习") {
                    onGoReview()
                }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
                Button("继续练习") { dismiss() }
                    .controlSize(.small)
                    .buttonStyle(.plain)
                    .foregroundColor(.secondary)
            }
            .padding(.top, 6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(20)
    }

    // MARK: 保存

    private func save() {
        let chosen = allCandidates.filter { selected.contains($0.id) && $0.existing == nil }
        guard !chosen.isEmpty, phase != .saving else { return }
        phase = .saving
        saveError = ""
        Task {
            do {
                // 并查批量保存（一次一词走公共 CollectActions；失败的按裸词降级，不阻塞）
                var outcomesById: [String: CollectVocabOutcome] = [:]
                outcomesById = try await withThrowingTaskGroup(
                    of: (String, CollectVocabOutcome).self
                ) { group in
                    for c in chosen {
                        group.addTask {
                            (c.id, try await vm.saveSpeakReviewCandidate(c))
                        }
                    }
                    var out: [String: CollectVocabOutcome] = [:]
                    for try await (id, outcome) in group {
                        out[id] = outcome
                    }
                    return out
                }
                // 已收藏且挣扎/到期的弱词提到今日复习队列最前（其余 SRS 字段原样保留）
                let wakeIds = allCandidates.filter { $0.existing != nil && $0.wake }.map(\.id)
                vm.wakeSpeakReviewWords(wakeIds)
                vm.refreshVocab()
                var info = DoneInfo()
                for c in chosen {
                    guard let outcome = outcomesById[c.id] else { continue }
                    switch outcome.status {
                    case .added:
                        info.addedWords.append(outcome.word.word)
                        info.addedIds.append(outcome.word.id)
                    case .merged:
                        info.mergedCount += 1
                    }
                }
                info.wakeCount = wakeIds.count
                doneInfo = info
                phase = .done
                vm.showToast("已加入 \(info.addedWords.count) 个词（生词本）")
            } catch {
                saveError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
                phase = .pick
            }
        }
    }
}

// MARK: - 简易流式布局（完成页词 chip 换行用）

private struct WrappingHStack: Layout {
    var horizontalSpacing: CGFloat = 6
    var verticalSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var height: CGFloat = 0
        var rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                height += rowHeight + verticalSpacing
                x = 0
                rowHeight = 0
            }
            x += size.width + horizontalSpacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: maxWidth == .infinity ? x : maxWidth, height: height + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + verticalSpacing
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + horizontalSpacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
