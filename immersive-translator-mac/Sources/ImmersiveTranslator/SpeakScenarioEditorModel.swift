import Foundation
import ReaderCore

/// 口语场景编辑器的状态机（升级计划 A2 §2.3/§2.4；视图层 SpeakScenarioEditorView
/// 只做渲染）：以「一句话生成」为主、手填为辅，保存进本地 speak-scenarios 同步集合
/// （SyncStore 落 dirty 实体，跨设备由用户在账户页手动「立即同步」）。
/// 对齐 Windows src/reader/SpeakScenarioEditor.tsx 的三态流转、文案、校验与保存语义。
///
/// 三态流转：input（一句话设想）→ generating（LLM 生成，可取消）→ form（可编辑
/// 表单，也可跳过生成直接手填）。提示词隔离（§2.4）：系统提示由客户端模板固定
/// （buildScenarioGenSystemPrompt 零参数，不可能混入用户输入），用户原话只作为
/// <scenario-idea> 分隔的数据进 input 侧。
///
/// 失败路径统一保留用户原话与已填表单（硬性约束）：idea 只有一个写入来源（用户
/// 键入），form 只有三个（initial 预填 / 解析成功预填 / 用户逐字段键入）——
/// 解析失败、接口失败、取消、返回重新生成、保存失败一律不碰这两个 state；
/// 「跳过，手动填写」只切态并显示当前 form（绝不重置）。
@MainActor
final class SpeakScenarioEditorModel: ObservableObject {
    /// 失败不是独立态：是 input 态 + genError 文案。
    enum Phase: Equatable {
        case input
        case generating
        case form
    }

    /// 表单态（9 字段；keyPhrases 动态行，空行保存时剔除）。
    struct Form: Equatable {
        var title = ""
        var category: SpeakScenarioCategory = .custom
        var aiRole = ""
        var userRole = ""
        var goal = ""
        var keyPhrases: [String] = []
        var opener = ""
        var openerZh = ""

        /// 编辑既有场景的表单预填（initial 打开时一次性写入）。
        static func of(initial sc: SpeakScenario) -> Form {
            Form(
                title: sc.title,
                category: sc.category,
                aiRole: sc.aiRole,
                userRole: sc.userRole ?? "",
                goal: sc.goal ?? "",
                keyPhrases: sc.keyPhrases ?? [],
                opener: sc.opener,
                openerZh: sc.openerZh ?? ""
            )
        }

        /// 生成草稿的表单预填（解析成功路径；可选字段钉死为空串/空数组）。
        static func of(draft: ScenarioGenDraft) -> Form {
            Form(
                title: draft.title,
                category: draft.category,
                aiRole: draft.aiRole,
                userRole: draft.userRole,
                goal: draft.goal,
                keyPhrases: draft.keyPhrases,
                opener: draft.opener,
                openerZh: draft.openerZh
            )
        }
    }

    /// 外部依赖（生产走 ReaderViewModel 的 chat 通道 + SpeakSyncCenter 的 SyncStore；测试注入）。
    struct Dependencies {
        /// 一句话生成（system, input）→ 模型最终文本。不传 onDelta（JSON 流式上屏无意义）。
        /// 取消 = 取消承载任务；半截累计文本绝不当成功解析。
        var generate: (_ system: String, _ input: String) async throws -> String
        /// 读回本地 speak-scenarios 集合（编辑路径取 baseVersion）。
        var syncStoreList: () async throws -> [StoredSyncEntity]
        /// 落 dirty 实体进 speak-scenarios 集合。
        var syncStorePut: ([StoredSyncEntity]) async throws -> Void
        var track: (TelemetryEvent) -> Void = { ReaderTelemetry.track($0) }
        var toast: (String) -> Void = { _ in }
        /// 时钟（updatedAt）。
        var now: () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
        /// 新建场景 id：usr_<uuid>（小写，对齐 crypto.randomUUID）。
        var newId: () -> String = { "usr_\(UUID().uuidString.lowercased())" }
    }

    /// 契约 keyPhrases maxItems（speak-scenario.schema.json）。
    static let maxKeyPhrases = scenarioMaxKeyPhrases
    /// 一句话设想防呆上限（视图层截断，§2.4；按 JS length 即 UTF-16 单元计）。
    static let maxIdeaLength = 200

    /// 编辑既有用户场景时非 nil；nil = 新建。
    let initial: SpeakScenario?
    @Published private(set) var phase: Phase
    /// 一句话原话——任何失败路径绝不清空（硬性约束的根）。
    @Published var idea = ""
    @Published private(set) var genError = ""
    @Published var form: Form
    /// 保存的表单内容是否源自最后一次成功生成的预填（via 埋点口径）。
    @Published private(set) var usedGenerate = false
    @Published private(set) var saveError = ""
    @Published private(set) var saving = false

    /// 保存成功后父级刷新「我的场景」分组。
    let onSaved: () -> Void
    let onClose: () -> Void

    private let deps: Dependencies
    /// 在途生成任务（取消生成 / Esc 取消用）。
    private var generateTask: Task<String, Error>?

    init(
        initial: SpeakScenario? = nil,
        dependencies: Dependencies,
        onSaved: @escaping () -> Void = {},
        onClose: @escaping () -> Void = {}
    ) {
        self.initial = initial
        self.deps = dependencies
        self.onSaved = onSaved
        self.onClose = onClose
        self.phase = initial == nil ? .input : .form
        self.form = initial.map(Form.of(initial:)) ?? Form()
    }

    var editing: Bool { initial != nil }

    /// 弹窗标题：编辑场景 / 新建场景。
    var dialogTitle: String { editing ? "编辑场景" : "新建场景" }

    /// 弹窗副题（按态）。
    var dialogSubtitle: String {
        switch phase {
        case .input: return "用一句话描述你想练的场景，AI 帮你生成场景卡；也可以跳过直接手动填写"
        case .generating: return "正在根据你的一句话设想生成场景卡…"
        case .form: return "生成结果可以再修改；标 * 的字段必填"
        }
    }

    /// 一句话设想是否可生成（trim 后非空）。
    var canGenerate: Bool {
        !idea.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// 一句话设想按上限截断（视图 onChange 调用，对齐 textarea maxLength）。
    func clampIdea() {
        let clamped = scenarioClamp(idea, Self.maxIdeaLength)
        if clamped != idea { idea = clamped }
    }

    /// 解析失败的中文文案（对齐蓝图失败路径统一规则）。
    static func genErrorText(_ error: ScenarioGenParseError) -> String {
        switch error {
        case .empty: return "生成结果为空，请重试"
        case .missingRequired: return "生成结果缺少必要字段（场景名/角色设定/开场白），请重试或改用手动填写"
        case .noJson, .badJson: return "生成结果格式异常（未能解析出场景卡），请重试或改用手动填写"
        }
    }

    // MARK: - 一句话生成

    /// 一句话生成：解析只用最终文本；半截取消文本绝不当成功。
    func generate() async {
        let text = idea.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, phase != .generating else { return }
        phase = .generating
        genError = ""
        let input = buildScenarioGenUserInput(text)
        let system = buildScenarioGenSystemPrompt()
        let task = Task { try await deps.generate(system, input) }
        generateTask = task
        defer { if generateTask == task { generateTask = nil } }
        do {
            let raw = try await task.value
            if task.isCancelled {
                // 半截累计文本绝不当成功解析；原话与表单都不动
                finishCancelled()
                return
            }
            switch parseScenarioGenResponse(raw) {
            case .ok(let draft):
                // 唯一的 form 写入来源（b）：用户主动生成并成功拿到新草稿，整体替换
                form = .of(draft: draft)
                usedGenerate = true
                phase = .form
                deps.track(.scenarioGenerateResult(ok: true))
            case .failed(let error, _):
                deps.track(.scenarioGenerateResult(ok: false, parseError: error.rawValue))
                genError = Self.genErrorText(error)
                phase = .input
            }
        } catch is CancellationError {
            finishCancelled()
        } catch {
            if task.isCancelled {
                finishCancelled()
                return
            }
            deps.track(.scenarioGenerateResult(ok: false))
            genError = "生成失败：\((error as? LocalizedError)?.errorDescription ?? "\(error)")"
            phase = .input
        }
    }

    private func finishCancelled() {
        deps.track(.scenarioGenerateResult(ok: false))
        genError = "已取消，可重试或手动填写"
        phase = .input
    }

    /// 「取消生成」/ 生成中 Esc：取消在途任务，不关弹窗。
    func cancelGenerate() {
        generateTask?.cancel()
    }

    /// 手填入口「跳过，手动填写」：只切态 + via 复位（表单内容原样显示，绝不重置）。
    func skipToManual() {
        usedGenerate = false
        phase = .form
    }

    /// 「← 返回重新生成」：只切态（不碰 idea 与 form）。
    func backToInput() {
        phase = .input
    }

    /// Esc：生成中先当一次取消用，保存中不误关。
    func handleEscape() {
        if phase == .generating {
            cancelGenerate()
        } else if !saving {
            onClose()
        }
    }

    // MARK: - 目标短语动态行

    func setPhrase(_ idx: Int, _ value: String) {
        guard form.keyPhrases.indices.contains(idx) else { return }
        form.keyPhrases[idx] = value
    }

    func removePhrase(_ idx: Int) {
        guard form.keyPhrases.indices.contains(idx) else { return }
        form.keyPhrases.remove(at: idx)
    }

    var canAddPhrase: Bool { form.keyPhrases.count < Self.maxKeyPhrases }

    func addPhrase() {
        guard canAddPhrase else { return }
        form.keyPhrases.append("")
    }

    // MARK: - 保存

    /// 必填 trim 校验：缺失字段名列表（场景名 / AI 角色设定 / 英文开场白）。
    static func missingRequired(_ form: Form) -> [String] {
        var missing: [String] = []
        if form.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { missing.append("场景名") }
        if form.aiRole.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { missing.append("AI 角色设定") }
        if form.opener.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { missing.append("英文开场白") }
        return missing
    }

    /// 由表单构造场景卡（可选字段空值不写入；长度按契约 maxLength/maxItems 双保险
    /// clamp；编辑路径保留 initial 的 id/defaultDifficulty/emoji）。
    static func buildScenario(form: Form, initial: SpeakScenario?, id: String, updatedAt: Int64) -> SpeakScenario {
        let trim = { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines) }
        let cleanPhrases = form.keyPhrases.map(trim).filter { !$0.isEmpty }
        let userRole = trim(form.userRole)
        let goal = trim(form.goal)
        let openerZh = trim(form.openerZh)
        return SpeakScenario(
            id: initial?.id ?? id,
            source: .user,
            title: trim(form.title),
            emoji: initial?.emoji,
            category: form.category,
            aiRole: scenarioClamp(trim(form.aiRole), scenarioMaxAiRoleLength),
            userRole: userRole.isEmpty ? nil : scenarioClamp(userRole, scenarioMaxUserRoleLength),
            goal: goal.isEmpty ? nil : scenarioClamp(goal, scenarioMaxGoalLength),
            keyPhrases: cleanPhrases.isEmpty ? nil : Array(cleanPhrases.prefix(maxKeyPhrases)),
            opener: trim(form.opener),
            openerZh: openerZh.isEmpty ? nil : openerZh,
            defaultDifficulty: initial?.defaultDifficulty,
            updatedAt: updatedAt
        )
    }

    /// 保存：构造场景卡 →（编辑路径先读回 baseVersion）→ syncStorePut 落 dirty
    /// 实体 → 注册表整桶合并替换 → 通知父级刷新。任何失败都保留表单可重试。
    func save() async {
        guard !saving else { return }
        let missing = Self.missingRequired(form)
        if !missing.isEmpty {
            saveError = "请填写：\(missing.joined(separator: "、"))"
            return
        }
        saveError = ""
        saving = true
        let scenario = Self.buildScenario(form: form, initial: initial, id: deps.newId(), updatedAt: deps.now())
        // 防御断言（理论必过：三个必填都来自非空 trim；防注册表静默丢弃）
        guard isSpeakScenarioLike(scenario) else {
            saveError = "场景数据校验失败，请检查必填字段后重试"
            saving = false
            return
        }
        // 编辑路径先读回 baseVersion（不重置服务端版本）；读回失败 = 中止保存不落库
        var baseVersion: Int64 = 0
        if let initial {
            let stored: [StoredSyncEntity]
            do {
                stored = try await deps.syncStoreList()
            } catch {
                saveError = "读取本地同步数据失败：\((error as? LocalizedError)?.errorDescription ?? "\(error)")，请重试"
                saving = false
                return
            }
            baseVersion = stored.first { $0.id == initial.id }?.baseVersion ?? 0
        }
        let entity = StoredSyncEntity(
            id: scenario.id,
            baseVersion: baseVersion,
            updatedAt: scenario.updatedAt,
            deleted: false,
            schemaVersion: 1,
            originDevice: syncOriginDevice,
            payload: scenario.jsonObject(),
            dirty: true
        )
        do {
            try await deps.syncStorePut([entity])
        } catch {
            saveError = "保存失败：\((error as? LocalizedError)?.errorDescription ?? "\(error)")"
            saving = false
            return
        }
        // 注册表立即生效：registerUserScenarios 是整桶替换，必须合并全量 + 同 id 覆盖
        registerUserScenarios(listUserScenarios().filter { $0.id != scenario.id } + [scenario])
        onSaved()
        // 只有新建发 create（编辑语义是更新）；via=表单内容是否源自最后一次成功生成
        if initial == nil {
            deps.track(.scenarioCreate(via: usedGenerate ? "generate" : "manual"))
        }
        deps.toast(initial != nil ? "场景已更新" : "场景已保存")
        saving = false
        onClose()
    }
}
