import SwiftUI
import AppKit
import UniformTypeIdentifiers
import ReaderCore

// MARK: - 学词笔记生成弹窗
//
// 流程：选词（默认全选未掌握，可由笔记库「滚进新笔记」预选）→ 连同出处例句/
// 词块/错题统计交给 LLM → 流式上屏（可取消）→ 完成后校验词条无幻觉 →
// 自动存入笔记库（notes/ 目录，永不覆盖旧文件）。对齐 Windows VocabNoteDialog.tsx。

struct ReaderNoteDialogView: View {
    @ObservedObject var vm: ReaderViewModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.readerPalette) private var palette

    private enum Phase: Equatable {
        case select
        case generating
        case done
        case cancelled
        case error(String)
    }

    @State private var phase: Phase = .select
    @State private var selected = Set<String>()
    @State private var noteText = ""
    @State private var verify: (ok: Bool, unknownHeadings: [String])?
    @State private var savedMeta: NoteMeta?
    @State private var saveError = ""
    @State private var generateTask: Task<Void, Never>?
    /// 生成时定格的词条（完成态的保存/打开都基于它）。
    @State private var chosenWords: [VocabWord] = []

    private var unmastered: [VocabWord] {
        vm.vocabWords.filter { $0.srs.intervalDays < noteMasteredIntervalDays }
    }

    private var mastered: [VocabWord] {
        vm.vocabWords.filter { $0.srs.intervalDays >= noteMasteredIntervalDays }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            Group {
                switch phase {
                case .select:
                    selectPhase
                case .generating, .done, .cancelled:
                    streamPhase
                case .error(let message):
                    errorPhase(message)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: 620, height: 560)
        .onAppear {
            if selected.isEmpty {
                selected = vm.noteDialogPreselect.isEmpty
                    ? defaultNoteSelection(vm.vocabWords)
                    : Set(vm.noteDialogPreselect)
            }
        }
        .onDisappear {
            generateTask?.cancel()
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("生成复习笔记").font(.system(size: 15, weight: .semibold))
                Text(phase == .select
                    ? "从生词本挑词（默认选未掌握的 \(unmastered.count) 个），连同例句、词块与错题记录交给 AI 做记忆诊断"
                    : "笔记由你的生词本和错题记录整理而来 —— 只用你真实攒下的词，不会编造")
                    .font(.system(size: 11.5))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            if phase != .generating {
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

    // MARK: 选词

    private var selectPhase: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if !unmastered.isEmpty {
                        groupHead(
                            title: "未掌握 · \(unmastered.count)",
                            toggleTitle: "全选/全不选",
                            words: unmastered
                        )
                        wordGrid(unmastered)
                    }
                    if !mastered.isEmpty {
                        Text("已掌握 · \(mastered.count)（已较熟，默认不进笔记）")
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundColor(.secondary)
                            .padding(.top, 6)
                        wordGrid(mastered)
                    }
                }
                .padding(16)
            }
            Divider()
            HStack {
                Text("已选 \(selected.count) 个词条")
                    .font(.system(size: 11.5))
                    .foregroundColor(.secondary)
                Spacer()
                Button("开始生成") {
                    startGenerate()
                }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(selected.isEmpty)
            }
            .padding(12)
        }
    }

    private func groupHead(title: String, toggleTitle: String, words: [VocabWord]) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundColor(.secondary)
            Button(toggleTitle) {
                let allIn = words.allSatisfy { selected.contains($0.id) }
                for w in words {
                    if allIn { selected.remove(w.id) } else { selected.insert(w.id) }
                }
            }
            .controlSize(.small)
            Spacer()
        }
    }

    private func wordGrid(_ words: [VocabWord]) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(minimum: 130), spacing: 6), count: 3), spacing: 6) {
            ForEach(words) { w in
                Button {
                    if selected.contains(w.id) {
                        selected.remove(w.id)
                    } else {
                        selected.insert(w.id)
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: selected.contains(w.id) ? "checkmark.square.fill" : "square")
                            .font(.system(size: 11))
                            .foregroundColor(selected.contains(w.id) ? .accentColor : .secondary)
                        Text(w.word)
                            .font(.system(size: 11.5))
                            .lineLimit(1)
                        if w.effectiveKind == .chunk {
                            Text("块")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundColor(.white)
                                .padding(.horizontal, 3)
                                .padding(.vertical, 0.5)
                                .background(Color.purple)
                                .clipShape(RoundedRectangle(cornerRadius: 3))
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(
                        selected.contains(w.id)
                            ? Color.accentColor.opacity(0.12)
                            : Color.secondary.opacity(0.06)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: 生成 / 流式

    private var streamPhase: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    Text(noteText.isEmpty ? "正在等待模型输出…" : noteText)
                        .font(.system(size: 12, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                        .id("note-stream")
                }
                .onChange(of: noteText) { _ in
                    proxy.scrollTo("note-stream", anchor: .bottom)
                }
            }
            Divider()
            HStack(alignment: .top, spacing: 12) {
                statusLine
                Spacer()
                actions
            }
            .padding(12)
        }
    }

    @ViewBuilder
    private var statusLine: some View {
        VStack(alignment: .leading, spacing: 2) {
            if phase == .generating {
                Text("整理中…（会流式上屏）")
                    .font(.system(size: 11.5))
                    .foregroundColor(.secondary)
            } else if phase == .cancelled {
                Text(noteText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? "已取消 —— 还没生成任何内容，未存入笔记库"
                    : "已取消 —— 上面是已生成的部分")
                    .font(.system(size: 11.5))
                    .foregroundColor(.secondary)
            } else if phase == .done, let verify {
                if verify.ok {
                    Text("✓ 校验通过：笔记词条均来自生词本\(savedMeta != nil ? " · 已自动存入笔记库" : "")")
                        .font(.system(size: 11.5))
                        .foregroundColor(.green)
                } else {
                    Text("⚠ 有 \(verify.unknownHeadings.count) 个标题未在生词本找到：\(verify.unknownHeadings.joined(separator: "、"))（可能是模型改写了词头，注意核对）")
                        .font(.system(size: 11.5))
                        .foregroundColor(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if !saveError.isEmpty {
                Text("存入笔记库失败：\(saveError)（仍可复制/另存为）")
                    .font(.system(size: 11))
                    .foregroundColor(.orange)
            }
        }
    }

    @ViewBuilder
    private var actions: some View {
        if phase == .generating {
            Button("取消生成") {
                generateTask?.cancel()
            }
            .controlSize(.small)
        } else {
            HStack {
                Button("复制") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(noteText, forType: .string)
                }
                .controlSize(.small)
                Button("另存为…") {
                    exportNote()
                }
                .controlSize(.small)
                .disabled(noteText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button("在笔记库打开") {
                    if let savedMeta {
                        vm.openSavedNote(meta: savedMeta)
                    }
                }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
                .disabled(savedMeta == nil)
            }
        }
    }

    private func errorPhase(_ message: String) -> some View {
        VStack(spacing: 10) {
            Text("笔记生成失败")
                .font(.system(size: 14, weight: .semibold))
            Text(message.isEmpty ? "请检查翻译接口配置后重试" : message)
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("重试") { startGenerate() }
                    .controlSize(.small)
                Button("返回选词") { phase = .select }
                    .controlSize(.small)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: 动作

    private func startGenerate() {
        let chosen = vm.vocabWords.filter { selected.contains($0.id) }
        guard !chosen.isEmpty else { return }
        chosenWords = chosen
        phase = .generating
        noteText = ""
        verify = nil
        savedMeta = nil
        saveError = ""

        // 拉出处文章例句（失败不阻塞：材料里例句缺省，LLM 不许编）
        var articles: [String: [SentencePair]] = [:]
        let ids = Set(chosen.map(\.source.articleId).filter { !$0.isEmpty })
        for id in ids {
            if let article = (try? vm.store.getArticle(id: id)) ?? nil {
                articles[id] = article.sentences
            }
        }
        let materials = buildNoteMaterials(chosen, articlesById: articles)
        let system = buildNoteSystemPrompt()
        let input = buildNoteUserInput(materials)

        generateTask = Task {
            do {
                let text = try await vm.streamChat(systemPrompt: system, userText: input) { delta in
                    Task { @MainActor in
                        noteText = delta
                    }
                }
                await MainActor.run {
                    noteText = text
                    verify = verifyNoteWords(text, words: chosen)
                    phase = .done
                    savedMeta = persist(text, partial: false)
                }
            } catch is CancellationError {
                let partialText = noteText
                let hasPartial = !partialText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                Task { @MainActor in
                    phase = .cancelled
                    if hasPartial {
                        savedMeta = persist(partialText, partial: true)
                    }
                }
            } catch {
                let message = (error as? LocalizedError)?.errorDescription ?? "\(error)"
                Task { @MainActor in
                    phase = .error(message)
                }
            }
        }
    }

    /// 生成完成/取消后自动入库；失败的半篇也存（partial 标记）。
    private func persist(_ text: String, partial: Bool) -> NoteMeta? {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        do {
            return try vm.noteStore.save(
                baseName: noteBaseName(),
                content: text,
                meta: NoteMeta(
                    createdAt: now,
                    words: chosenWords.count,
                    partial: partial,
                    wordIds: chosenWords.map(\.id),
                    updatedAt: now
                )
            )
        } catch {
            saveError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            return nil
        }
    }

    private func exportNote() {
        let panel = NSSavePanel()
        var types: [UTType] = [.plainText]
        if let md = UTType(filenameExtension: "md") { types.append(md) }
        panel.allowedContentTypes = types
        panel.nameFieldStringValue = savedMeta?.file ?? "\(noteBaseName()).md"
        if panel.runModal() == .OK, let url = panel.url {
            try? noteText.data(using: .utf8)?.write(to: url, options: .atomic)
        }
    }
}
