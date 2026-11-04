import SwiftUI
import ReaderCore

/// 口语场景编辑器（升级计划 A2 §2.3/§2.4）的 SwiftUI 视图层：三态 input/generating/form。
/// 状态机与全部文案在 SpeakScenarioEditorModel（对齐 Windows SpeakScenarioEditor.tsx；
/// Windows modal → Mac Sheet，属平台必然差异——窗口体系不同，文案与语义逐字一致）。
struct SpeakScenarioEditorView: View {
    @Environment(\.readerPalette) private var palette
    /// StateObject：父级重渲染（toast/控制器状态变化）时视图结构体重建，状态机必须跨重建存活
    ///（idea 与 form 任何路径不清空的硬性约束）。
    @StateObject private var model: SpeakScenarioEditorModel

    init(
        initial: SpeakScenario?,
        chat: @escaping (String, String) async throws -> String,
        syncStore: SyncStore?,
        onToast: @escaping (String) -> Void,
        onSaved: @escaping () -> Void,
        onClose: @escaping () -> Void
    ) {
        let store = syncStore
        _model = StateObject(wrappedValue: SpeakScenarioEditorModel(
            initial: initial,
            dependencies: .init(
                generate: chat,
                syncStoreList: {
                    guard let store else { return [] }
                    return try await Task.detached(priority: .utility) { try store.list(userScenarioCollection) }.value
                },
                syncStorePut: { entities in
                    guard let store else {
                        throw SyncStoreError("同步存储未就绪，请稍后重试")
                    }
                    try await Task.detached(priority: .utility) { try store.put(userScenarioCollection, entities) }.value
                },
                track: { ReaderTelemetry.track($0) },
                toast: onToast
            ),
            onSaved: onSaved,
            onClose: onClose
        ))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            Divider().opacity(0.5)
            switch model.phase {
            case .input: inputBody
            case .generating: generatingBody
            case .form: formBody
            }
        }
        .padding(16)
        .frame(width: 520)
        .background(palette.surface)
        .onExitCommand { model.handleEscape() }
        .interactiveDismissDisabled(model.phase == .generating || model.saving)
    }

    // MARK: 头部（标题 + 按态副题 + 关闭）

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
                Text(model.dialogTitle)
                    .font(.system(size: 15, weight: .semibold, design: .serif))
                Text(model.dialogSubtitle)
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
            }
            Spacer()
            if model.phase != .generating, !model.saving {
                Button {
                    model.onClose()
                } label: {
                    Text("✕").font(.system(size: 12, weight: .semibold))
                }
                .buttonStyle(.plain)
                .foregroundColor(palette.textSecondary)
                .help("关闭 (Esc)")
            }
        }
    }

    // MARK: input：一句话设想

    private var inputBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .topLeading) {
                TextEditor(text: $model.idea)
                    .font(.system(size: 13))
                    .frame(height: 96)
                    .scrollContentBackground(.hidden)
                    .background(palette.background, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(palette.border))
                    .onChange(of: model.idea) { _ in model.clampIdea() }
                    .accessibilityLabel("一句话设想")
                if model.idea.isEmpty {
                    Text("例如：下周要跟德国客户谈合同续约，对方想压价 10%\n（一句话即可，AI 会帮你展开成完整的口语场景卡）")
                        .font(.system(size: 12))
                        .foregroundColor(palette.textTertiary)
                        .padding(.horizontal, 6)
                        .padding(.top, 8)
                        .allowsHitTesting(false)
                }
            }
            HStack {
                Spacer()
                Text("\(model.idea.utf16.count)/\(SpeakScenarioEditorModel.maxIdeaLength)")
                    .font(.system(size: 10.5).monospacedDigit())
                    .foregroundColor(palette.textTertiary)
            }
            if !model.genError.isEmpty {
                errorText(model.genError)
            }
            HStack {
                Button {
                    model.skipToManual()
                } label: {
                    Text("跳过，手动填写")
                        .frame(maxWidth: .infinity)
                }
                .controlSize(.regular)
                Button {
                    Task { await model.generate() }
                } label: {
                    Text("生成场景")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!model.canGenerate)
            }
        }
    }

    // MARK: generating：spinner + 回显 + 取消

    private var generatingBody: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                ProgressView().controlSize(.regular)
                VStack(alignment: .leading, spacing: 3) {
                    Text("正在生成场景卡（角色设定、开场白与目标短语）…")
                        .font(.system(size: 12))
                    Text("「\(model.idea.trimmingCharacters(in: .whitespacesAndNewlines))」")
                        .font(.system(size: 11.5))
                        .foregroundColor(palette.textTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack {
                Button("取消生成") {
                    model.cancelGenerate()
                }
                .controlSize(.regular)
            }
        }
        .padding(.vertical, 6)
    }

    // MARK: form：九字段表单

    private var formBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            editorField("场景名 *") {
                TextField("例如：合同续约谈判", text: $model.form.title)
            }
            .accessibilityLabel("场景名")

            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("分类").font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(palette.textSecondary)
                    Picker("", selection: $model.form.category) {
                        ForEach(SpeakScenarioCategory.allCases, id: \.self) { category in
                            Text(speakScenarioCategoryTag(category)).tag(category)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("分类")
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("开场白中文提示").font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(palette.textSecondary)
                    TextField("一句话说明开场白意思", text: $model.form.openerZh)
                        .accessibilityLabel("开场白中文提示")
                }
            }

            editorField("AI 角色与情境设定 *（≤300 字）") {
                limitedEditor(text: $model.form.aiRole, limit: scenarioMaxAiRoleLength,
                              placeholder: "AI 扮演谁、在什么情境里、什么语气，例如：你扮演德国客户的采购经理，态度友善但想压价 10%，围绕合同续约谈判")
            }
            .accessibilityLabel("AI 角色与情境设定")

            editorField("你的角色（≤200 字）") {
                TextField("例如：供应商一方的销售代表", text: $model.form.userRole)
                    .onChange(of: model.form.userRole) { _ in
                        model.form.userRole = scenarioClamp(model.form.userRole, scenarioMaxUserRoleLength)
                    }
            }
            .accessibilityLabel("你的角色")

            editorField("练习目标（≤200 字）") {
                TextField("例如：守住报价、争取更长合同期", text: $model.form.goal)
                    .onChange(of: model.form.goal) { _ in
                        model.form.goal = scenarioClamp(model.form.goal, scenarioMaxGoalLength)
                    }
            }
            .accessibilityLabel("练习目标")

            editorField("目标短语（≤\(SpeakScenarioEditorModel.maxKeyPhrases) 条，建议在对话中用出的英文词块）") {
                phraseRows
            }

            editorField("英文开场白 *") {
                limitedEditor(text: $model.form.opener, limit: nil,
                              placeholder: "AI 的第一句英文，1-2 句自然口语，结尾留出接话空间，例如：Good to see you again. Shall we start with the pricing?")
            }
            .accessibilityLabel("英文开场白")

            if !model.saveError.isEmpty {
                errorText(model.saveError)
            }
            HStack {
                Button {
                    model.backToInput()
                } label: {
                    Text("← 返回重新生成")
                        .frame(maxWidth: .infinity)
                }
                Button {
                    Task { await model.save() }
                } label: {
                    Text(model.saving ? "保存中…" : "保存场景")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.saving)
            }
        }
    }

    /// 目标短语动态行（逐行 ✕ 删除；「＋ 添加短语」到 8 条 disabled）。
    private var phraseRows: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(model.form.keyPhrases.indices, id: \.self) { idx in
                HStack(spacing: 6) {
                    TextField("例如：close the deal", text: Binding(
                        get: { model.form.keyPhrases.indices.contains(idx) ? model.form.keyPhrases[idx] : "" },
                        set: { model.setPhrase(idx, $0) }
                    ))
                    .accessibilityLabel("目标短语")
                    Button {
                        model.removePhrase(idx)
                    } label: {
                        Text("✕").font(.system(size: 11, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .foregroundColor(palette.textSecondary)
                    .help("删除这条短语")
                    .accessibilityLabel("删除短语")
                }
            }
            Button("＋ 添加短语") {
                model.addPhrase()
            }
            .controlSize(.small)
            .disabled(!model.canAddPhrase)
        }
    }

    // MARK: 小部件

    private func editorField<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundColor(palette.textSecondary)
            content()
        }
    }

    /// 多行文本域（placeholder 覆盖 + 可选上限截断）。
    private func limitedEditor(text: Binding<String>, limit: Int?, placeholder: String) -> some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: text)
                .font(.system(size: 12.5))
                .frame(minHeight: 64, maxHeight: 96)
                .scrollContentBackground(.hidden)
                .background(palette.background, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(palette.border))
                .onChange(of: text.wrappedValue) { _ in
                    guard let limit else { return }
                    let clamped = scenarioClamp(text.wrappedValue, limit)
                    if clamped != text.wrappedValue { text.wrappedValue = clamped }
                }
            if text.wrappedValue.isEmpty {
                Text(placeholder)
                    .font(.system(size: 11.5))
                    .foregroundColor(palette.textTertiary)
                    .padding(.horizontal, 6)
                    .padding(.top, 8)
                    .allowsHitTesting(false)
            }
        }
    }

    private func errorText(_ message: String) -> some View {
        Text(message)
            .font(.system(size: 11))
            .foregroundColor(palette.err)
            .fixedSize(horizontal: false, vertical: true)
    }
}
