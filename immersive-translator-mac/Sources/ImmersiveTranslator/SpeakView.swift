import SwiftUI
import ReaderCore
import XfyunCore

/// 口语陪练视图（R3 + v0.8 场景中心）：入口页（语境卡 ×2 + 日常场景 ×4 +
/// 最近会话）+ 对话环（点击开麦 / 教练批改 / 发音详情透镜卡）。
/// 对齐 Windows SpeakView.tsx（v0.8 场景中心版）的结构与交互：
/// - 入口页置顶「结合正在读的内容」组：book 卡（正在共读·第 N 章 + 开场白预览）
///   与 vocab 卡（N 词待用 + 前 3 目标词）；无在读书章/无待复习词时整组隐藏。
/// - 对话环：点击开麦（播报中点击 = 打断插话；VAD 静音 1.5s 自动收）→
///   LLM 四行回复；用户气泡下渲染「表达改进建议」词级增删对比 + TIP 点评 +
///   「＋ 存为笔记」（命中目标词预选）。
/// - 语境会话顶部目标词 chips（✓已用上 / ○待练习）；命中自动按 easy 档过 SRS。
/// - 右侧常驻「发音详情」透镜卡：总分、词着色句点选、音素药丸 + 舌位建议、
///   慢速示范 0.75×/重读词、逐词得分折线（点圆点同步选词）。
/// - 跟读打分（SPEAK-7/13）：评分后对话流末尾渲染与阅读室同款的报告卡（从落盘
///   attempts 派生，动作 = 再跟读 / 只练差词 → 全局抽屉 / 听领读 / 听我的录音）；
///   异常时渲染四类可行动卡（没听到声音 / 读的不是这句 / 环境吵 / 没评上）。
/// - 结束复盘（SpeakReviewView）原样共存。

struct SpeakView: View {
    @ObservedObject var vm: ReaderViewModel
    @ObservedObject var controller: SpeakViewController
    /// 全局差词抽屉（vm.drill）：口语页直接观察它——打开时主麦克风/跟读/复盘入口禁用
    ///（与 Windows `disabled={... || drill !== null}` 同义），收起时把接线还给阅读室。
    @ObservedObject private var drill: ShadowDrillController
    @Environment(\.readerPalette) private var palette
    @State private var reviewShown = false
    /// 复盘弹层关掉之后要接的动作（完成页「生成复习笔记 / 去复习」）：
    /// 在 onDismiss 里执行，保证上一个 sheet 完全收起后再开下一个。
    @State private var pendingAfterReview: PendingAfterReview?
    /// 入口页选定的对话难度（语境卡与日常卡共用）。
    @State private var selectedDifficulty: SpeakDifficulty = .medium
    /// 发音详情：选中的词/音素下标（换 pron 时自动跳到最差词）。
    @State private var pronSel: PronSelection?
    /// 右栏「逐词得分曲线」展开态（Windows details 默认收起）。
    @State private var curveExpanded = false
    /// 当前透镜卡正在展示的 pron 时间戳（变化时重选最差词）。
    @State private var lensPronAt: Int64?
    /// 口语页是否借用了全局抽屉的接线（收起时还给阅读室）。
    @State private var drillBorrowed = false
    /// 场景目录服务（A1）：官方目录来源三态徽标随 officialSource 重渲染。
    @ObservedObject private var catalog: ScenarioCatalogService
    /// 目录分组的渲染快照（preload / refresh / 编辑器保存后各 set 一次；对齐 Windows extraLists）。
    @State private var officialScenarios: [SpeakScenario] = []
    @State private var userScenarios: [SpeakScenario] = []
    /// 官方场景库的分类筛选 + 展开态（纯本地 UI 状态，不持久化；切分类回到收起态）。
    @State private var officialFilter: ScenarioFilter = .all
    @State private var officialExpanded = false
    /// 场景编辑器（A2）：nil = 关闭；initial nil = 新建，非 nil = 编辑该场景。
    @State private var editorState: ScenarioEditorState?

    @MainActor
    init(vm: ReaderViewModel, controller: SpeakViewController, catalog: ScenarioCatalogService) {
        self.vm = vm
        self.controller = controller
        self.drill = vm.drill
        self.catalog = catalog
        _relayPanelModel = StateObject(wrappedValue: PracticeRelayViewModel(
            environment: Self.relayEnvironment(controller: controller, vm: vm)
        ))
    }

    /// 编辑器弹层的身份（sheet(item:) 需要 Identifiable；每次打开新建一份）。
    private struct ScenarioEditorState: Identifiable {
        let id = UUID()
        let initial: SpeakScenario?
    }

    private enum PendingAfterReview {
        case noteDialog(ids: [String])
        case goReview
    }

    struct PronSelection: Equatable {
        var wordIdx: Int
        var phoneIdx: Int
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
        .onAppear {
            controller.refreshRecent()
            controller.syncRecordsOnEntry()
            wireDependencies()
            loadScenarioCatalog()
        }
        // 离开口语页：抽屉是口语页借用的就一并收起（Windows 的 drill 渲染在 SpeakView
        // 内部，卸载即消失）并归还接线，避免 onDone 残留指向口语控制器。
        .onDisappear {
            if drillBorrowed {
                vm.drill.close()
                restoreDrillWiring()
            }
        }
        // 口语页借用的全局抽屉收起（练完 onDone / ✕ 退出 / 换句清场）时，
        // 把 onSpeakWord/onToast/onDone 还给阅读室的缺省接线，避免残留改写
        //（阅读室报告卡再开抽屉时 onDone 会错误指向口语控制器）。
        .onChange(of: drill.state.shown) { shown in
            if !shown, drillBorrowed {
                restoreDrillWiring()
            }
        }
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
        // 场景编辑器（A2）：入口全在入口页（「＋ 新建场景」/ 卡片「编辑」）。
        .sheet(item: $editorState) { state in
            SpeakScenarioEditorView(
                initial: state.initial,
                chat: { [weak controller] system, input in
                    guard let controller else { throw FileImportError("翻译服务不可用") }
                    return try await controller.chatProvider(system, input) { _ in }
                },
                syncStore: SpeakSyncCenter.shared.records?.store,
                onToast: { [weak vm] in vm?.showToast($0) },
                onSaved: { onScenarioSaved() },
                onClose: { editorState = nil }
            )
        }
    }

    /// 挂载时装载场景目录（A1，对齐 Windows SpeakView.tsx:391-398）：先 preload（官方
    /// 缓存+同步的用户场景），再拉取官方目录（每次进口语视图都拉，无节流；404/断网
    /// 全静默）。装载前后各 set 一次，保证目录到达后入口网格刷新出分组。
    private func loadScenarioCatalog() {
        Task { @MainActor in
            await catalog.preloadScenarioCatalog()
            refreshScenarioLists()
            await catalog.refreshOfficialScenarioCatalog()
            refreshScenarioLists()
        }
    }

    private func refreshScenarioLists() {
        officialScenarios = listOfficialScenarios()
        userScenarios = listUserScenarios()
    }

    /// 编辑器保存成功（A2）：直接读内存注册表刷新「我的场景」分组——preload 是
    /// once 单飞永久缓存，保存后重跑无效，必须 register（编辑器内）+ 显式 set。
    private func onScenarioSaved() {
        userScenarios = listUserScenarios()
    }

    /// 接线外部依赖（第 2 波可上移到 ReaderViewModel 统一挂载）：
    /// 生词本供数 / 命中目标词按 easy 档记 SRS（附带 spokenAt）/ 轻提示 /
    /// 全局差词抽屉（SPEAK-7：口语页借用，练完回整句跟读）/ 当前 TTS 引擎（SPEAK-8）。
    private func wireDependencies() {
        controller.attach(SpeakViewController.Dependencies(
            vocabWords: { [weak vm] in vm?.vocabWords ?? [] },
            gradeSpokenVocab: { [weak vm] word in
                var spoken = word
                spoken.spokenAt = Int64(Date().timeIntervalSince1970 * 1000)
                vm?.gradeVocab(spoken, .easy, mode: .recognition, verdict: nil)
            },
            toast: { [weak vm] in vm?.showToast($0) },
            openDrill: { [weak vm, weak controller] entries, preferring in
                borrowDrill(vm: vm, controller: controller)
                guard let vm else { return }
                if let preferring {
                    vm.drill.open(entries: entries, preferring: preferring)
                } else {
                    vm.drill.open(entries: entries)
                }
            },
            drillActive: { [weak vm] in vm?.drill.state.shown ?? false },
            // 口语页播报/单词/慢速示范跟随设置里的 TTS 引擎（与阅读室领读同源：
            // ReaderViewModel.assess.leadProvider 传 effectiveSettings.ttsProvider），
            // Edge 选中时慢速示范才真正走 SSML prosody -25%。
            ttsProvider: { [weak vm] in vm?.effectiveSettings.ttsProvider ?? .xfyun }
        ))
    }

    /// 口语页借用全局抽屉：词发音走口语控制器（与对话同一 LeadSpeaker，对齐 Windows
    /// 抽屉 onSpeakWord={speakWord}）；练完回整句再跟读（drillDone → startShadow，
    /// SpeakView.tsx:864-868）。onDone 先把接线还给阅读室再开麦——onDone 触发时抽屉
    /// 已收起，onChange 也会还一次（幂等）。
    private func borrowDrill(vm: ReaderViewModel?, controller: SpeakViewController?) {
        guard let vm else { return }
        drillBorrowed = true
        vm.drill.onSpeakWord = { [weak controller] word in controller?.speakWord(word) }
        vm.drill.onToast = { [weak vm] in vm?.showToast($0) }
        vm.drill.onDone = { [weak vm, weak controller] in
            if let vm {
                vm.drill.onDone = { [weak vm] in vm?.assessRetry() }
            }
            controller?.shadowDrillDone()
        }
    }

    /// 还原阅读室的缺省接线（ReaderViewModel.init 的 drill 接线；口语页借用后归还）。
    private func restoreDrillWiring() {
        drillBorrowed = false
        vm.drill.onSpeakWord = { [weak vm] in vm?.speakWord($0) }
        vm.drill.onToast = { [weak vm] in vm?.showToast($0) }
        vm.drill.onDone = { [weak vm] in vm?.assessRetry() }
    }

    /// 有没有可复盘的跟读数据（一次都没跟读过时复盘入口禁用）。
    private var hasAssessments: Bool {
        controller.session?.turns.contains {
            $0.role == .assistant && !($0.shadowAttempts ?? []).isEmpty
        } ?? false
    }

    /// 系统「减弱动态效果」：卡片入场只留淡入，谐波画布静止一帧。
    private var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    /// 跟读目标 = 最新 assistant 句（报告卡词着色底本与 marks 对齐同源）。
    private var shadowTarget: String? {
        controller.session.flatMap { lastAssistantText($0.turns) }
    }

    /// 最新 assistant 轮的跟读报告（Windows SpeakView.tsx:650-678 lastReport）：统一从
    /// 落盘 attempts 派生——刚评完与重开旧会话走同一条路；跟读录音/评测中不显示。
    private var lastShadowReport: ShadowAttemptReport? {
        guard let session = controller.session, let target = shadowTarget else { return nil }
        switch controller.phase {
        case .shadowRecording, .shadowAssessing:
            return nil
        default:
            break
        }
        for turn in session.turns.reversed() where turn.role == .assistant {
            guard let attempts = turn.shadowAttempts, !attempts.isEmpty else { return nil }
            return shadowAttemptReport(target: target, attempts: attempts)
        }
        return nil
    }

    /// 全局差词抽屉打开时占用麦克风：开麦 / 跟读 / 复盘入口一并禁用
    ///（SpeakView.tsx:1232,1390 `disabled={… || drill !== null}`）。
    private var drillOpen: Bool { drill.state.shown }

    /// 最新 assistant 轮的 id（该轮的跟读摘要由报告卡承担，气泡内不重复）。
    private var lastAssistantTurnId: String? {
        controller.session?.turns.last(where: { $0.role == .assistant })?.id
    }

    // MARK: - 入口页（场景中心）

    /// 「聊刚读的章节」卡的语境：只有书章给出（短文无章节概念）。
    private var bookCardContext: SpeakSessionContext? {
        speakBookContext(article: vm.article, book: vm.currentBook)
    }

    /// 今日待复习生词（造句闯关卡 + 目标词；最多 8 个）。
    private var dueVocabWords: [VocabWord] {
        Array(vm.dueWords.prefix(8))
    }

    /// 今日收集的词块数（语境组标签右侧的真实计数）。
    private var todayChunkCount: Int {
        let cal = Calendar.current
        return vm.vocabWords.filter {
            cal.isDateInToday(Date(timeIntervalSince1970: TimeInterval($0.addedAt) / 1000))
        }.count
    }

    private var entryPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("选择口语练习场景")
                            .font(.system(size: 20, weight: .semibold, design: .serif))
                        Text("可以围绕你刚读完的章节和生词开口练习，也可以任选日常或职场话题模拟对话")
                            .font(.system(size: 11.5))
                            .foregroundColor(palette.textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    difficultySwitch
                }
                if !controller.hasASR {
                    credentialHint
                }

                if bookCardContext != nil || !dueVocabWords.isEmpty {
                    groupLabel(
                        "结合正在读的内容（推荐 · 用出来自动完成复习）",
                        trailing: todayChunkCount > 0 ? "今日已收 \(todayChunkCount) 个词块" : "在对话中用起来就算复习"
                    )
                    // featured 双列 1.15fr / 0.85fr（原型 .scenario-featured-grid，
                    // html:731-735）；只有一张语境卡时占满整行。
                    if let bookCtx = bookCardContext, !dueVocabWords.isEmpty {
                        WeightedHStack(weights: [1.15, 0.85], spacing: 16) {
                            bookContextCard(bookCtx)
                            vocabContextCard
                        }
                    } else if let bookCtx = bookCardContext {
                        bookContextCard(bookCtx)
                    } else if !dueVocabWords.isEmpty {
                        vocabContextCard
                    }
                }

                // 日常组标签：目录 fallback（官方桶空）时挂「内置场景」徽标（SpeakView.tsx:1496-1498）
                groupLabel(
                    "日常与职场模拟场景",
                    trailing: "点击即可开始",
                    badge: catalog.officialSource == .fallback ? officialCatalogBadge(.fallback) : nil
                )
                // 日常 4 列网格（原型 .scenario-daily-grid，html:736-739；
                // Windows SpeakView.tsx:1102 同构），不再单列竖摞。
                LazyVGrid(
                    columns: Array(repeating: GridItem(.flexible(), spacing: 14), count: 4),
                    spacing: 14
                ) {
                    ForEach(speakScenarioCardOrder, id: \.self) { id in
                        dailyScenarioCard(id)
                    }
                }

                // 官方场景库分组（目录非空时才渲染；SpeakView.tsx:1521-1579）
                if !officialScenarios.isEmpty {
                    officialCatalogGroup
                }

                // 「我的场景」（A2 起标签行常显：空分组也提供「＋ 新建场景」入口）
                myScenariosGroup

                if !controller.recentSessions.isEmpty {
                    groupLabel("继续上次的对话", trailing: nil)
                    ForEach(controller.recentSessions.prefix(3)) { session in
                        recentRow(session)
                    }
                }

                // 练习接力（跨设备续练；Windows SpeakView.tsx:1632-1633 同位置：
                // 最近会话之后、场景编辑器之前）。无任务时两个组件都不渲染。
                PracticeRelayList(environment: relayEnvironment) { task in
                    relayPanelModel.select(task)
                }
                PracticeRelayView(model: relayPanelModel)
            }
            .padding(20)
        }
        .background(palette.background)
    }

    /// 练习接力面板模型（入口页常驻一个；列表行点击直接 select，与 Windows
    /// practice-relay-select 事件同语义）。
    @StateObject private var relayPanelModel: PracticeRelayViewModel

    /// 练习接力生产环境（SpeakSyncCenter 启动接线后 serverAuth 必在；测试/极早期
    /// 回退空客户端——一切云入口走未登录分支，零网络）。
    private var relayEnvironment: PracticeRelayEnvironment {
        Self.relayEnvironment(controller: controller, vm: vm)
    }

    private static func relayEnvironment(controller: SpeakViewController, vm: ReaderViewModel) -> PracticeRelayEnvironment {
        PracticeRelayEnvironment.production(
            learning: LearningStore.shared,
            serverAuth: SpeakSyncCenter.shared.serverAuth ?? ServerAuthClient(),
            translate: { prompt, system, _ in
                let text = try await controller.chatProvider(system, prompt) { _ in }
                return PracticeRelayTranslateResult(status: "done", text: text)
            },
            speakEn: { text in
                await MainActor.run { controller.speakRelayReference(text) }
            },
            onToast: { message in
                Task { @MainActor in vm.showToast(message) }
            }
        )
    }

    // MARK: 官方场景库 / 我的场景（目录层，紧凑卡）

    /// 官方场景库：组标签 + 三态徽标 + 分类 chips（只出实际有场景的分类、固定序）+
    /// 紧凑卡网格（收起且超过 8 张只渲染前 8 张）+「展开全部 N 个」/「收起」。
    private var officialCatalogGroup: some View {
        let counts = scenarioCategoryCounts(officialScenarios)
        let preview = filterScenarioPreview(officialScenarios, filter: officialFilter, expanded: officialExpanded)
        return VStack(alignment: .leading, spacing: 10) {
            groupLabel("官方场景库", trailing: officialCatalogBadge(catalog.officialSource))
            HStack(spacing: 4) {
                filterChip("全部 \(officialScenarios.count)", active: officialFilter == .all) {
                    pickOfficialFilter(.all)
                }
                ForEach(counts, id: \.category) { item in
                    filterChip(
                        "\(speakScenarioCategoryTag(item.category)) \(item.count)",
                        active: officialFilter == .category(item.category)
                    ) {
                        pickOfficialFilter(.category(item.category))
                    }
                }
            }
            .padding(2)
            .background(Capsule().fill(palette.surfaceAlt))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("官方场景分类筛选")
            compactGrid(preview.visible, editable: false)
            if preview.hasMore || officialExpanded {
                Button {
                    officialExpanded.toggle()
                } label: {
                    Text(officialExpanded ? "收起" : "展开全部 \(preview.total) 个")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(palette.accent)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(officialExpanded ? [.isSelected] : [])
                .accessibilityValue(officialExpanded ? "已展开" : "已收起")
            }
        }
    }

    /// 切分类回到收起态（SpeakView.tsx pickFilter）。
    private func pickOfficialFilter(_ filter: ScenarioFilter) {
        officialFilter = filter
        officialExpanded = false
    }

    private func filterChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 11, weight: active ? .semibold : .regular).monospacedDigit())
                .padding(.horizontal, 10)
                .padding(.vertical, 3)
                .background(active ? palette.accent.opacity(0.16) : Color.clear)
                .foregroundColor(active ? palette.accent : palette.textSecondary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(active ? [.isSelected] : [])
    }

    /// 「我的场景」：标签行常显（空分组也有）；有场景时 trailing「多端同步」＋恒显「＋ 新建场景」；
    /// 卡片同紧凑卡，外加「编辑」pill。
    private var myScenariosGroup: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("我的场景")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(palette.textSecondary)
                Spacer()
                if !userScenarios.isEmpty {
                    Text("多端同步")
                        .font(.system(size: 10.5))
                        .foregroundColor(palette.textTertiary)
                }
                Button {
                    editorState = ScenarioEditorState(initial: nil)
                } label: {
                    Text("＋ 新建场景")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(palette.accent)
                }
                .buttonStyle(.plain)
            }
            .padding(.top, 6)
            if !userScenarios.isEmpty {
                compactGrid(userScenarios, editable: true)
            }
        }
    }

    /// 紧凑卡网格（官方库 / 我的场景共用）；editable 时外层包「编辑」pill。
    private func compactGrid(_ list: [SpeakScenario], editable: Bool) -> some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 4),
            spacing: 12
        ) {
            ForEach(list) { sc in
                ZStack(alignment: .topTrailing) {
                    CompactScenarioCard(sc: sc, palette: palette) {
                        controller.start(scenario: sc.id, difficulty: sc.defaultDifficulty ?? selectedDifficulty)
                    }
                    if editable {
                        Button {
                            editorState = ScenarioEditorState(initial: sc)
                        } label: {
                            Text("编辑")
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundColor(palette.accent)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(Capsule().fill(palette.accentSoft))
                        }
                        .buttonStyle(.plain)
                        .padding(8)
                        .help("编辑这个场景")
                    }
                }
            }
        }
    }

    private var difficultySwitch: some View {
        HStack(spacing: 4) {
            Text("对话难度：").font(.system(size: 11)).foregroundColor(palette.textTertiary)
            HStack(spacing: 2) {
                ForEach(SpeakDifficulty.allCases, id: \.self) { d in
                    let active = selectedDifficulty == d
                    Button {
                        selectedDifficulty = d
                    } label: {
                        Text(difficultyOf(d).label)
                            .font(.system(size: 11, weight: active ? .semibold : .regular))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 3)
                            .background(active ? palette.accent.opacity(0.16) : Color.clear)
                            .foregroundColor(active ? palette.accent : palette.textSecondary)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .help(difficultyOf(d).note)
                }
            }
            .padding(2)
            .background(Capsule().fill(palette.surfaceAlt))
        }
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

    private func groupLabel(_ title: String, trailing: String?, badge: String? = nil) -> some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(palette.textSecondary)
            Spacer()
            if let badge {
                Text(badge)
                    .font(.system(size: 10.5))
                    .foregroundColor(palette.textTertiary)
            }
            if let trailing {
                Text(trailing)
                    .font(.system(size: 10.5))
                    .foregroundColor(palette.textTertiary)
            }
        }
        .padding(.top, 6)
    }

    /// 语境卡/日常卡的公共骨架：20 圆角玻璃卡（原型 .scenario-card，html:741-765）
    /// ——glass-surface + blur + 发丝边 + 顶内高光 + shadow-pill；hover 200ms 弹性
    /// 升起 2pt → glass-elevated + 深一档边 + shadow-spatial。tag 图标一律 SF Symbols
    ///（handoff 红线 4：禁止 emoji 充当系统图标）。
    private func scenarioCard<Content: View>(
        icon: String,
        tag: String,
        tagTone: ScenarioTagTone,
        title: String,
        @ViewBuilder desc: () -> Content,
        openerPreview: String,
        action: @escaping () -> Void
    ) -> some View {
        ScenarioCard(
            icon: icon,
            tag: tag,
            tone: tagTone,
            title: title,
            openerPreview: openerPreview,
            palette: palette,
            action: action,
            desc: desc
        )
    }

    /// book 语境卡：正在共读 · 第 N 章 + 章节开场白预览。
    private func bookContextCard(_ ctx: SpeakSessionContext) -> some View {
        let opener = speakContextOpener(ctx)
        let chapterNo: Int
        if case let .book(_, _, idx, _) = ctx { chapterNo = idx + 1 } else { chapterNo = 1 }
        let title: String
        if case let .book(bookTitle, _, _, _) = ctx { title = bookTitle } else { title = "" }
        return scenarioCard(
            icon: "book.fill",
            tag: "正在共读 · 第 \(chapterNo) 章",
            tagTone: .accent,
            title: "聊刚读的《\(title)》",
            desc: {
                Text("AI 围绕第 \(chapterNo) 章剧情与你互动讨论，引导你在回答中自然用出本章刚查过的词块。")
            },
            openerPreview: opener.text,
            action: { controller.start(scenario: "smalltalk", difficulty: selectedDifficulty, context: ctx) }
        )
    }

    /// vocab 语境卡：N 词待用 + 前 3 目标词。
    private var vocabContextCard: some View {
        scenarioCard(
            icon: "sparkles",
            tag: "生词本联动 · \(dueVocabWords.count) 词待用",
            tagTone: .teal,
            title: "今日生词造句闯关",
            desc: {
                (Text("不用死背单词卡——AI 出生活化情境提问，你只要在回答里用对今天待复习的生词，即算复习过关。")
                 + Text(" 今天的目标：").fontWeight(.semibold)
                 + Text(dueVocabWords.prefix(3).map(\.word).joined(separator: "、")).fontWeight(.semibold)
                    .foregroundColor(palette.textSecondary))
            },
            openerPreview: speakContextOpener(.vocab(wordIds: [])).text,
            action: {
                controller.start(
                    scenario: "smalltalk", difficulty: selectedDifficulty,
                    context: .vocab(wordIds: dueVocabWords.map(\.id))
                )
            }
        )
    }

    private func dailyScenarioCard(_ id: SpeakScenarioId) -> some View {
        let scenario = scenarioOf(id)
        return scenarioCard(
            icon: id == "interview" ? "briefcase.fill" : id == "ordering" ? "fork.knife" : id == "travel" ? "airplane" : "bubble.left",
            tag: speakScenarioCardTag(id),
            tagTone: .neutral,
            title: speakScenarioCardTitle(id),
            desc: { Text(speakScenarioCardDesc(id)) },
            openerPreview: scenario.opener,
            action: { controller.start(scenario: id, difficulty: selectedDifficulty) }
        )
    }

    private func recentRow(_ session: SpeakSession) -> some View {
        let pronScores = session.turns.compactMap(\.pron).map(\.total)
        let avg = pronScores.isEmpty
            ? nil
            : pronScores.reduce(0, +) / Double(pronScores.count)
        return RecentSessionRow(
            title: speakSceneTitle(session),
            subtitle:
                "\(difficultyOf(session.difficulty).label)难度 · 已聊 \(session.turns.count / 2) 轮"
                + (avg.map { String(format: " · 发音均分 %.1f", $0) } ?? ""),
            palette: palette,
            action: { controller.resume(session) }
        )
    }

    // MARK: - 对话页（声波工作室）

    /// 语境会话的目标词（chips / 存笔记预选共用）。
    private var contextTargets: [(word: VocabWord, zh: String)] {
        speakContextTargets(context: controller.session?.context, vocabWords: vm.vocabWords)
    }

    /// 目标词在本会话里是否已被用出（扫历史 user 轮，重开会话也保真）。
    private var hitTargetIds: Set<String> {
        guard let session = controller.session else { return [] }
        return speakHitTargetIds(turns: session.turns, targets: contextTargets)
    }

    // ---- 用户场景的 keyPhrases → 目标短语（A2 独立新通道，不碰语境 targets/SRS） ----
    // 只对 source == user 的场景产出（内置/官方/语境会话恒 []，现状零变化）；
    // 命中只打勾（chips done 态），不接 gradeSpokenVocab、不进生词库。
    private var scenarioPhrases: [String] {
        guard let session = controller.session else { return [] }
        return userScenarioTargets(session.scenario).map(\.word)
    }

    private var scenarioHits: Set<String> {
        hitKeyPhrases(turns: controller.session?.turns ?? [], keyPhrases: scenarioPhrases)
    }

    /// 目标词 chip（语境目标词与用户场景短语两条通道合并展示，命中判定各走各的：
    /// 前者按 VocabWord.id 驱动 SRS，后者只打勾；对齐 SpeakView.tsx:1259-1276）。
    struct TargetChipItem: Identifiable, Equatable {
        var key: String
        var word: String
        var zh: String
        var done: Bool
        /// 点击 chip 时的 toast 文案。
        var toast: String
        var id: String { key }
    }

    private var targetItems: [TargetChipItem] {
        let hits = hitTargetIds
        let phraseHits = scenarioHits
        return contextTargets.prefix(6).map { target in
            TargetChipItem(
                key: target.word.id,
                word: target.word.word,
                zh: target.zh,
                done: hits.contains(target.word.id),
                toast: "今日练习词块：\(target.word.word) — 在对话中自然说出即可完成"
            )
        } + scenarioPhrases.map { phrase in
            TargetChipItem(
                key: phrase,
                word: phrase,
                zh: "",
                done: phraseHits.contains(phrase),
                toast: "本场景目标短语：\(phrase) — 在对话中自然说出即可"
            )
        }
    }

    /// 场景条目标词进度（无目标词不画）。
    private var stageProgress: SpeakTargetProgress? {
        let items = targetItems
        return targetProgress(hit: items.filter(\.done).count, total: items.count)
    }

    /// 建议下一个试的词（第一个还没用上的）；nil = 全部用上。
    private var nextChipKey: String? {
        let items = targetItems
        return nextTargetKey(items.map(\.key), hit: Set(items.filter(\.done).map(\.key)))
    }

    /// 一句话里的目标词命中：句内高亮区间 + 用上了几个不同的目标词
    /// （判定复用 textHitsTarget，与 chips 打勾一致；对齐 SpeakView.tsx analyzeTargets）。
    private func analyzeTargets(_ text: String) -> (spans: [TargetSpan], count: Int) {
        var spans: [TargetSpan] = []
        var count = 0
        for item in targetItems {
            let found = findTargetSpans(text, item.word)
            if !found.isEmpty { count += 1 }
            spans.append(contentsOf: found)
        }
        return (spans.sorted { $0.start < $1.start }, count)
    }

    private var conversationPage: some View {
        // Windows .sonic-studio-grid：左「对话舞台」卡 + 右「发音反馈」卡，间距 24；
        // 面板宽三档随窗口收缩（reader.css ≥1440→460 / 基表 410 / ≤1199→340）。
        GeometryReader { geo in
            HStack(spacing: 24) {
                speakStage
                pronunciationPanel
                    .frame(width: panelWidth(for: geo.size.width))
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 14)
        .background(palette.background)
    }

    /// 右栏宽度三档（mac 以对话页内容宽近似 Windows 视口宽，含 24 间距等差）。
    private func panelWidth(for contentWidth: CGFloat) -> CGFloat {
        if contentWidth >= 1408 { return 460 }
        if contentWidth >= 1168 { return 410 }
        return 340
    }

    /// 左列对话舞台（Windows .speak-stage）：场景条 / 目标词条 / 对话流 / 失败提示 /
    /// 控制条自上而下装进同一张玻璃卡，分区用发丝线分界。
    private var speakStage: some View {
        VStack(spacing: 0) {
            sceneBar
            if !targetItems.isEmpty {
                targetsStrip
            }
            dialogueScroll
            if case .error(let message) = controller.phase {
                noticeBar(message)
            }
            composer
        }
        .glassCard(palette: palette, radius: 20)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("口语对话：\(controller.session.map(speakSceneTitle) ?? "")")
    }

    /// 场景条（.speak-scene）：在练什么、难度、目标词进度与听力开关，一行讲清。
    private var sceneBar: some View {
        HStack(spacing: 12) {
            SpeakTextButton(title: "← 切换场景", palette: palette) {
                controller.backToEntry()
            }
            .help("回到场景中心")
            if let s = controller.session {
                Text(speakSceneTitle(s))
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(palette.text)
                    .lineLimit(1)
                    .help(speakSceneTitle(s))
                Text("\(difficultyOf(s.difficulty).label)难度")
                    .font(.system(size: 11.5))
                    .foregroundColor(palette.textTertiary)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 1)
                    .background(Capsule().strokeBorder(palette.glassBorderStrong))
            }
            if let progress = stageProgress {
                stageProgressView(progress)
            }
            Spacer(minLength: 12)
            listenModeToggle
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .overlay(alignment: .bottom) {
            Rectangle().fill(palette.glassBorder).frame(height: 1)
        }
    }

    /// 目标词进度（.speak-bar）：110×6 细条 + 「已用上 {hit} / {total} 个词」。
    private func stageProgressView(_ progress: SpeakTargetProgress) -> some View {
        HStack(spacing: 8) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(palette.background)
                    Capsule()
                        .fill(palette.sonicTeal)
                        .frame(width: geo.size.width * CGFloat(progress.pct) / 100)
                }
            }
            .frame(width: 110, height: 6)
            Text(progress.label)
                .font(.system(size: 12.5).monospacedDigit())
                .foregroundColor(palette.textSecondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(progress.label)
        .accessibilityValue("\(progress.hit) / \(progress.total)")
    }

    /// 听力模式开关（.speak-listen-toggle / .speak-switch）：28×16 迷你开关，on 态 teal。
    private var listenModeToggle: some View {
        Button {
            controller.toggleListenMode()
        } label: {
            HStack(spacing: 7) {
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(controller.listenMode ? palette.sonicTeal : palette.ink4)
                        .frame(width: 28, height: 16)
                    Circle()
                        .fill(Color.white)
                        .frame(width: 12, height: 12)
                        .offset(x: controller.listenMode ? 14 : 2)
                }
                Text("听力模式")
                    .font(.system(size: 12.5, weight: controller.listenMode ? .semibold : .regular))
                    .foregroundColor(controller.listenMode ? palette.text : palette.textSecondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("听力模式：AI 的话先只听不看——答完一句自动显示原文，也可点「看原文」随时查看")
        .accessibilityLabel("听力模式")
        .accessibilityAddTraits(controller.listenMode ? [.isSelected] : [])
        .accessibilityValue(controller.listenMode ? "开" : "关")
    }

    /// 目标词条（.speak-targets）：画布底横条；done=teal-soft 打勾、next=accent 描边。
    private var targetsStrip: some View {
        let nextKey = nextChipKey
        return HStack(spacing: 8) {
            Text("本轮目标词")
                .font(.system(size: 12))
                .foregroundColor(palette.textTertiary)
            ForEach(targetItems) { item in
                targetChip(item, next: item.key == nextKey)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .background(palette.background)
        .overlay(alignment: .bottom) {
            Rectangle().fill(palette.glassBorder).frame(height: 1)
        }
    }

    /// 目标词 chip（.speak-chip）：状态用颜色 + 勾号双编码，中文释义随行展示。
    private func targetChip(_ item: TargetChipItem, next: Bool) -> some View {
        let done = item.done
        return Button {
            vm.showToast(item.toast)
        } label: {
            HStack(spacing: 6) {
                ZStack {
                    Circle()
                        .fill(done ? palette.sonicTeal : Color.clear)
                        .overlay(Circle().strokeBorder(done ? palette.sonicTeal : palette.ink4, lineWidth: 1.5))
                    if done {
                        Image(systemName: "checkmark")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundColor(.white)
                    }
                }
                .frame(width: 16, height: 16)
                Text(item.word)
                    .font(.system(size: 14, weight: done ? .semibold : .regular, design: .serif))
                    .foregroundColor(done ? palette.sonicTeal : palette.text)
                if !item.zh.isEmpty {
                    Text(item.zh)
                        .font(.system(size: 12))
                        .foregroundColor(palette.textTertiary)
                }
            }
            .padding(.leading, 6)
            .padding(.trailing, 12)
            .padding(.vertical, 3)
            .background(
                Capsule()
                    .fill(done ? palette.sonicTealSoft : palette.glassElevated)
                    .overlay(Capsule().strokeBorder(done ? Color.clear : (next ? palette.accent : palette.glassBorderStrong)))
            )
            .shadow(color: next ? palette.accentSoft : Color.clear, radius: 3)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help("\(item.word) — 在对话中自然说出即可完成")
        .accessibilityLabel("\(done ? "已用上" : "待练习")：\(item.word)\(item.zh.isEmpty ? "" : " · \(item.zh)")")
    }

    /// 对话流（.sonic-turns-scroll）：AI 在左（无气泡），你在右（气泡），gap 20。
    private var dialogueScroll: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let session = controller.session {
                        ForEach(Array(session.turns.enumerated()), id: \.element.id) { idx, turn in
                            turnBubble(turn, index: idx)
                                .id(turn.id)
                        }
                    }
                    if controller.phase == .thinking {
                        thinkingBubble
                    }
                    if controller.phase == .transcribing {
                        Text("…识别你刚才说的…")
                            .font(.system(size: 11.5))
                            .foregroundColor(palette.textTertiary)
                    }
                    if controller.phase == .recording {
                        listeningRow
                    }
                    // 跟读报告卡（SPEAK-7）：评分后从落盘 attempts 派生，跟读录音/
                    // 评测中不显示（正被新一轮覆盖，SpeakView.tsx:650-653 同语义）。
                    if let report = lastShadowReport, let target = shadowTarget {
                        HStack(alignment: .bottom) {
                            ShadowReportCardBody(
                                result: report.result,
                                marks: report.marks,
                                attemptTotals: report.totals,
                                passScore: shadowPassScore,
                                target: target,
                                actions: ShadowReportActions(
                                    again: { controller.retryShadow() },
                                    drill: { entries in
                                        controller.openShadowDrill(entries: entries)
                                    },
                                    hearModel: { controller.hearShadowModel() },
                                    hearMine: controller.lastShadowPcm == nil
                                        ? nil
                                        : { controller.hearShadowMine() },
                                    speakWord: { controller.speakWord($0) },
                                    drillWord: { word in
                                        let entries = shadowDrillEntries(target: target, marks: report.marks)
                                        controller.openShadowDrill(entries: entries, preferring: word)
                                    },
                                    dismiss: nil
                                )
                            )
                            .id("shadow-report")
                            .transition(ShadowCardTokens.enterTransition(reduceMotion: reduceMotion))
                            Spacer(minLength: 0)
                        }
                    }
                    // 跟读异常可行动卡（SPEAK-13）：四类文案与按钮，替代一行 errorBanner。
                    if let failure = controller.shadowFailure {
                        HStack(alignment: .bottom) {
                            ShadowFailureCardView(
                                card: failure,
                                perform: { controller.performShadowFailureAction($0) },
                                onDismiss: nil
                            )
                            .transition(ShadowCardTokens.enterTransition(reduceMotion: reduceMotion))
                            Spacer(minLength: 0)
                        }
                        .id("shadow-failure")
                    }
                }
                .padding(.top, 6)
                .padding(.horizontal, 22)
                .padding(.bottom, 20)
                // 报告卡/异常卡入场：rc-in 曲线（reader.css @keyframes rc-in：0.38s
                // cubic-bezier(.2,.9,.3,1.15)，自底 8pt + 0.985 缩放 + 淡入）；
                // 「减弱动态效果」时只留淡入（apple-design §14：减弱 ≠ 没有反馈）。
                .animation(ShadowCardTokens.enterAnimation(reduceMotion: reduceMotion), value: lastShadowReport?.attemptAt)
                .animation(ShadowCardTokens.enterAnimation(reduceMotion: reduceMotion), value: controller.shadowFailure)
            }
            .onChange(of: controller.session?.turns.count) { _ in
                if let last = controller.session?.turns.last {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
            .onChange(of: lastShadowReport?.attemptAt) { _ in
                withAnimation { proxy.scrollTo("shadow-report", anchor: .bottom) }
            }
            .onChange(of: controller.shadowFailure) { _ in
                if controller.shadowFailure != nil {
                    withAnimation { proxy.scrollTo("shadow-failure", anchor: .bottom) }
                }
            }
        }
    }

    /// 录音中行（.speak-live）：右对齐「正在听你说…」+ 电平波形 + 自动发送说明。
    private var listeningRow: some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack(spacing: 10) {
                Text("正在听你说…")
                    .font(.system(size: 12.5))
                    .foregroundColor(palette.textTertiary)
                HStack(spacing: 3) {
                    ForEach(0..<5, id: \.self) { i in
                        Capsule()
                            .fill(palette.err)
                            .frame(width: 3, height: waveHeight(index: i))
                            .animation(.linear(duration: 0.09), value: controller.level)
                    }
                }
                .frame(height: 18, alignment: .center)
            }
            Text("停顿约 1.5 秒自动发送 · 也可以点麦克风立即发送")
                .font(.system(size: 12))
                .foregroundColor(palette.textTertiary)
        }
        .frame(maxWidth: 560, alignment: .trailing)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("正在听你说")
    }

    /// 五根电平柱的高度（对齐 .speak-wave i 的 2n/3 规则；level ×3 增益同源）。
    private func waveHeight(index: Int) -> CGFloat {
        let lv = Double(min(1, max(0, controller.level * 3)))
        switch index {
        case 1, 3: return 4 + 10 * lv
        case 2: return 5 + 16 * lv
        default: return 4 + 14 * lv
        }
    }

    /// 对话轮：AI 轮直接落在卡面上（无底卡，左对齐），用户轮是 .dialogue-turn.mine——
    /// 18/18/4/18 圆角 glass-elevated 气泡 + shadow-pill 右对齐，最大宽 58ch。
    @ViewBuilder
    private func turnBubble(_ turn: SpeakTurn, index: Int) -> some View {
        if turn.role == .user {
            HStack(alignment: .bottom) {
                Spacer(minLength: 24)
                userTurnCard(turn)
            }
        } else {
            assistantTurn(turn, index: index)
        }
    }

    /// AI 轮（.dialogue-turn）：speaker 行 + 19pt 衬线英文 + 中文提示 + 历史跟读摘要
    /// + 表达改进建议块；最新一轮的跟读摘要由流末报告卡承担（SpeakView.tsx:1260 不重复）。
    /// 听力模式：未揭开的 AI 轮遮原文（答完自动揭/点「看原文」手动揭；重开的历史会话
    /// 全部已揭），遮罩保高度不引起滚动跳动（SpeakView.tsx:1724-1773）。
    private func assistantTurn(_ turn: SpeakTurn, index: Int) -> some View {
        let veiled = controller.isTurnVeiled(index)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                Text("AI 陪练 · \(scenarioOf(controller.session?.scenario ?? "smalltalk").title)")
                    .font(.system(size: 11.5))
                    .foregroundColor(palette.textTertiary)
                Spacer(minLength: 12)
                SpeakTextAction(title: "重听", icon: "speaker.wave.2", palette: palette) {
                    controller.replayTurn(turn.text)
                }
                .disabled(controller.phase == .recording || controller.phase == .transcribing)
                .help("重听这句")
                if veiled {
                    SpeakTextAction(title: "看原文", icon: "eye", palette: palette) {
                        controller.revealTurn(index)
                    }
                    .help("显示这句原文")
                }
            }
            Text(turn.text)
                .font(.system(size: 19, design: .serif))
                .lineSpacing(7)
                .foregroundColor(palette.text)
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.leading)
                .modifier(ListenVeil(on: veiled))
            if let hint = turn.hintZh {
                Text(hint)
                    .font(.system(size: 13.5))
                    .foregroundColor(palette.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .modifier(ListenVeil(on: veiled))
            }
            // 历史 assistant 轮的跟读摘要（.speak-shadow-score：ok 色粗体小字）。
            if turn.id != lastAssistantTurnId {
                if let attempts = turn.shadowAttempts, !attempts.isEmpty {
                    Text("跟读过 \(attempts.count) 次 · 最好 \(String(format: "%.1f", attempts.map(\.total).max() ?? 0))")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(palette.ok)
                        .padding(.top, 2)
                } else if let score = turn.shadowScore {
                    Text(String(format: "跟读 %.1f / 5", score))
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(palette.ok)
                        .padding(.top, 2)
                }
            }
            if let diff = turn.coachDiff, !diff.segs.isEmpty {
                coachDiffBlock(diff, turnText: turn.text)
            }
        }
        .frame(maxWidth: 580, alignment: .leading)
    }

    /// 用户轮气泡（.dialogue-turn.mine）：18pt 衬线英文（目标词高亮 + 发音弱词着色）
    /// + meta 药丸行；最新 pron 轮的弱词可点选同步右栏。
    private func userTurnCard(_ turn: SpeakTurn) -> some View {
        let analysis = analyzeTargets(turn.text)
        let isPronTurn = turn.id == lastPronTurn?.id
        let marks = isPronTurn ? lastPronMarks : []
        return VStack(alignment: .trailing, spacing: 8) {
            userSentence(turn.text, spans: analysis.spans, marks: marks, pickable: isPronTurn)
            HStack(spacing: 6) {
                if analysis.count > 0 {
                    speakMetaPill("用上 \(analysis.count) 个目标词", icon: "checkmark", fg: palette.sonicTeal, bg: palette.sonicTealSoft)
                }
                if let pron = turn.pron {
                    let tone = scoreToneOf(pron.total)
                    speakMetaPill(String(format: "发音 %.1f / 5.0", pron.total), icon: nil, fg: toneColor(tone), bg: toneSoftColor(tone))
                }
            }
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 18)
        .frame(maxWidth: 560, alignment: .trailing)
        .background(
            UserBubbleShape()
                .fill(palette.glassElevated)
                .background(.regularMaterial, in: UserBubbleShape())
        )
        .overlay(UserBubbleShape().stroke(palette.glassBorderStrong, lineWidth: 1))
        .shadow(color: palette.shadowPill, radius: 12, y: 5)
    }

    /// 用户句（.speak-user-text + UserSentence）：目标词区间 teal 加粗；发音弱词按档位
    /// 加线（ok=warn / bad=err / missed=err-soft 底），最新 pron 轮的弱词可点选同步右栏。
    private func userSentence(_ text: String, spans: [TargetSpan], marks: [XfyunCore.WordMark], pickable: Bool) -> some View {
        let ns = text as NSString
        let markSpans = marks.map { TargetSpan(start: $0.start, end: $0.end) }
        let segments = annotateSegments(text, marks: markSpans, targets: spans)
        return FlowLayout(spacing: 0, lineSpacing: 5) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, seg in
                let piece = ns.substring(with: NSRange(location: seg.start, length: seg.end - seg.start))
                let mark = seg.markIdx >= 0 ? marks[seg.markIdx] : nil
                Group {
                    if let mark, mark.quality != .good {
                        weakWord(mark, text: piece, pickable: pickable)
                    } else if seg.target {
                        Text(verbatim: piece)
                            .fontWeight(.semibold)
                            .foregroundColor(palette.sonicTeal)
                    } else {
                        Text(verbatim: piece)
                            .foregroundColor(palette.text)
                    }
                }
                .font(.system(size: 18, design: .serif))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 发音弱词（.speak-seg.wd-*）：文字不换色只加线；missed 补 err-soft 底；
    /// 右栏当前选中的词叠 warn-soft 圆角底（.speak-seg.sel）。
    private func weakWord(_ mark: XfyunCore.WordMark, text: String, pickable: Bool) -> some View {
        let idx = pickable ? pronWordIdx(of: mark) : nil
        let selected = idx != nil && pronSel?.wordIdx == idx
        let lineColor: Color = mark.quality == .ok ? palette.warn : palette.err
        return Group {
            if let idx {
                Button {
                    pronSel = PronSelection(wordIdx: idx, phoneIdx: 0)
                } label: {
                    weakWordLabel(mark, text: text, lineColor: lineColor, selected: selected)
                }
                .buttonStyle(.plain)
                .help(mark.quality == .missed ? "漏读了 · 点击看细节" : String(format: "%.1f 分 · 点击看细节", mark.score))
            } else {
                weakWordLabel(mark, text: text, lineColor: lineColor, selected: selected)
            }
        }
    }

    private func weakWordLabel(_ mark: XfyunCore.WordMark, text: String, lineColor: Color, selected: Bool) -> some View {
        Text(verbatim: text)
            .foregroundColor(palette.text)
            .padding(.horizontal, 1)
            .background(
                RoundedRectangle(cornerRadius: 3)
                    .fill(selected ? palette.warnSoft : (mark.quality == .missed ? palette.errSoft : Color.clear))
            )
            .overlay(alignment: .bottom) {
                // Windows 用波浪下划线（wavy 1.5px / offset 4）；SwiftUI 无原生波浪，
                // 以 1.5pt 实线近似（同阅读室 xray 词标线语言）。
                Rectangle()
                    .fill(lineColor.opacity(0.85))
                    .frame(height: 1.5)
                    .offset(y: -3)
            }
            .contentShape(Rectangle())
    }

    /// 用户轮 meta 药丸（.speak-pill）：hit=teal / 发音分按档位着色。
    private func speakMetaPill(_ text: String, icon: String?, fg: Color, bg: Color) -> some View {
        HStack(spacing: 5) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 9, weight: .bold))
            }
            Text(text)
                .font(.system(size: 12, weight: .semibold).monospacedDigit())
        }
        .foregroundColor(fg)
        .padding(.horizontal, 10)
        .padding(.vertical, 2)
        .background(Capsule().fill(bg))
    }

    /// 最新 pron 轮的词标记（句内着色与右栏选词共用同源 mapWordsToText）。
    private var lastPronMarks: [XfyunCore.WordMark] {
        guard let pron = lastPron else { return [] }
        return mapWordsToText(text: lastPronText, words: pron.words.map(\.xfyunWordScore))
    }

    /// 右栏「需要注意的词」数（非 good 档；0 时提示「没有明显问题」）。
    private var weakCount: Int {
        lastPronMarks.filter { $0.quality != .good }.count
    }

    /// WordMark 回找 pron.words 下标（mapWordsToText 的 word 字段等值匹配；
    /// 增读词被过滤、对不上原文的词被丢弃，找不到返回 nil）。
    private func pronWordIdx(of mark: XfyunCore.WordMark) -> Int? {
        guard let w = mark.word else { return nil }
        return lastPron?.words.firstIndex { $0.xfyunWordScore == w }
    }

    /// 用户气泡下的「表达改进建议」块（原型 .editorial-diff-block，html:932-935）：
    /// 只用一道顶发丝线与正文分界，无底色卡片。词级增删对比 + TIP + 「＋ 存为笔记」。
    private func coachDiffBlock(_ diff: CoachDiff, turnText: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text("表达改进建议")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundColor(palette.knownColor)
                Spacer()
                Button {
                    // 命中目标词预选（语境会话时）
                    let hitIds = contextTargets
                        .filter { textHitsTarget(turnText, $0.word.word) }
                        .map(\.word.id)
                    vm.openNoteDialog(preselect: hitIds)
                } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "plus").font(.system(size: 8.5, weight: .bold))
                        Text("存为笔记").font(.system(size: 10.5))
                    }
                    .foregroundColor(palette.knownColor)
                }
                .buttonStyle(.plain)
                .help("把这轮的表达改进建议存进笔记（命中的目标词已预选）")
            }
            coachDiffSegs(diff.segs)
            if let note = diff.note {
                Text(note)
                    .font(.system(size: 10.5))
                    .foregroundColor(palette.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.top, 12)
        .overlay(alignment: .top) {
            Rectangle().fill(palette.glassBorder).frame(height: 1)
        }
    }

    /// 词级对比（原型 .diff-del-span / .diff-ins-span，html:937-949）：
    /// del = err 删除线 75% 透明；ins = teal 正向色 + teal-soft 底 4 圆角 600 字重
    /// 小胶囊——teal 在整套令牌里是「正向 / 已用上」，accent 只留给品牌与当前句
    /// （同页目标词 done 态同为 teal，两种语义不再打架）；keep 原样。逐段流式换行。
    private func coachDiffSegs(_ segs: [CoachSeg]) -> some View {
        FlowLayout(spacing: 5, lineSpacing: 4) {
            ForEach(Array(segs.enumerated()), id: \.offset) { _, seg in
                switch seg.t {
                case .del:
                    Text(verbatim: seg.v)
                        .strikethrough(true, color: palette.err.opacity(0.75))
                        .foregroundColor(palette.err.opacity(0.75))
                case .ins:
                    Text(verbatim: seg.v)
                        .fontWeight(.semibold)
                        .foregroundColor(palette.sonicTeal)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(RoundedRectangle(cornerRadius: 4).fill(palette.sonicTealSoft))
                case .keep:
                    Text(verbatim: seg.v)
                }
            }
        }
        .font(.system(size: 12.5, design: .serif))
        .foregroundColor(palette.text)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var thinkingBubble: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                // 听力模式下不流式上屏回复原文，避免抢在 TTS 前被看到（SpeakView.tsx:1872-1879）
                if controller.listenMode {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("…对方回复中…").font(.system(size: 11.5)).foregroundColor(palette.textTertiary)
                    }
                } else if controller.streaming.en.isEmpty {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("…在想你该怎么说…").font(.system(size: 11.5)).foregroundColor(palette.textTertiary)
                    }
                } else {
                    Text(controller.streaming.en)
                        .font(.system(size: 19, design: .serif))
                        .opacity(0.7)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 2)
            Spacer(minLength: 24)
        }
    }

    /// 失败提示条（.speak-notice）：warn-soft 底 + 可行动按钮，只在真的失败后出现；
    /// redeem 类给「兑换更多额度」，其余给「再试一次」（Windows retryFromNotice 同义：
    /// 清错后直接重开麦克风），✕ 关闭 = dismiss。
    private func noticeBar(_ message: String) -> some View {
        let kind = speakFriendlyNotice(message).kind
        return HStack(spacing: 10) {
            Image(systemName: "exclamationmark.circle")
                .font(.system(size: 14))
                .foregroundColor(palette.warn)
            Text(message)
                .font(.system(size: 12.5))
                .foregroundColor(palette.warn)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            HStack(spacing: 6) {
                if kind == .redeem {
                    noticeActionButton("兑换更多额度", primary: true) {
                        (NSApp.delegate as? AppDelegate)?.openAccountRedeem()
                    }
                } else {
                    noticeActionButton("再试一次", primary: true) {
                        controller.clearError()
                        if controller.hasASR {
                            controller.toggleMic()
                        }
                    }
                    .help("重开麦克风再说一次")
                }
                Button {
                    controller.clearError()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(palette.warn)
                        .padding(3)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("关闭提示")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(palette.warnSoft))
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
    }

    /// 提示条动作按钮（.speak-notice-actions button）：primary = accent 实底白字。
    private func noticeActionButton(_ title: String, primary: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12))
                .foregroundColor(primary ? Color.white : palette.text)
                .padding(.horizontal, 10)
                .padding(.vertical, 3)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(primary ? palette.accent : palette.glassElevated)
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(primary ? Color.clear : palette.glassBorderStrong))
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - 底部控制条

    private var micTitle: String {
        controller.phase == .recording
            ? "说完后再点一下立即发送"
            : "点击开始说话，停顿自动发送"
    }

    private var canToggleMic: Bool {
        guard !drillOpen else { return false }  // 词练抽屉占用麦克风
        switch controller.phase {
        case .idleTurn, .error, .speaking, .recording:
            return controller.hasASR
        default:
            return false
        }
    }

    /// 麦克风下方一句话提示（Windows speakUi.micTip）。
    private var micTipText: String {
        if controller.phase == .shadowRecording || controller.phase == .shadowAssessing {
            return "正在跟读评分，完成后再回答"
        }
        switch controller.phase {
        case .recording: return "说完后再点一下发送"
        case .transcribing: return "识别中…"
        case .thinking: return "对方回复中…"
        case .speaking: return "对方说话中 · 点击麦克风可插话"
        case .error: return "点一下麦克风再说一次"
        default:
            let hasSpoken = controller.session?.turns.contains { $0.role == .user } ?? false
            return hasSpoken ? "点击麦克风继续回答" : "点击麦克风用英语回答"
        }
    }

    /// 控制条（.speak-composer）：左「跟读/重听」、中麦克风主按钮 + 提示、右收尾动作。
    private var composer: some View {
        Grid(alignment: .center, horizontalSpacing: 16, verticalSpacing: 0) {
            GridRow {
                HStack(spacing: 8) {
                    shadowButton
                    SpeakGhostButton(title: "重听", icon: "speaker.wave.2", palette: palette) {
                        controller.replayLast()
                    }
                    .disabled(controller.phase == .recording || controller.phase == .transcribing || controller.phase == .thinking)
                    .help("重听 AI 最新一句")
                }
                .gridColumnAlignment(.leading)
                VStack(spacing: 6) {
                    micButton
                    Text(micTipText)
                        .font(.system(size: 12))
                        .foregroundColor(palette.textTertiary)
                        .lineLimit(1)
                        .help(micTipText)
                }
                HStack(spacing: 8) {
                    if controller.phase == .thinking {
                        SpeakGhostButton(title: "跳过回复", palette: palette) {
                            controller.skipReply()
                        }
                        .help("不等这次回复了，接着说下一句")
                    }
                    finishButton
                }
                .gridColumnAlignment(.trailing)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 16)
        .overlay(alignment: .top) {
            Rectangle().fill(palette.glassBorder).frame(height: 1)
        }
    }

    /// 点击开麦按钮（.speak-mic）：idle/error/speaking 点击即开麦（speaking 打断播报
    /// 插话）；录音中再点 = 立即说完；识别/回复中禁用。64 圆，待机品牌色、录音语义红
    /// + 电平光圈（说话越响圈越大）。
    private var micButton: some View {
        let recording = controller.phase == .recording
        let lv = Double(min(1, max(0, controller.level * 3)))
        return Button {
            controller.toggleMic()
        } label: {
            Image(systemName: recording ? "stop.fill" : "mic.fill")
                .font(.system(size: 22, weight: .medium))
                .foregroundColor(.white)
                .frame(width: 64, height: 64)
                .background(Circle().fill(recording ? palette.err : palette.accent))
                .shadow(color: recording ? palette.errSoft : Color.clear, radius: 4 + 14 * lv)
                .shadow(color: recording ? palette.err.opacity(0.35) : palette.shadowPill,
                        radius: recording ? 18 : 12, y: recording ? 6 : 5)
                .contentShape(Circle())
                .animation(.linear(duration: 0.09), value: controller.level)
        }
        .buttonStyle(.plain)
        .disabled(!canToggleMic)
        .opacity(canToggleMic ? 1 : 0.55)
        .help(micTitle)
        .accessibilityLabel(recording ? "说完（点击发送）" : "点击开始说话")
    }

    /// 跟读按钮（.speak-btn）：照 AI 最新一句读，讯飞评测打分。
    private var shadowButton: some View {
        SpeakGhostButton(title: shadowLabel, palette: palette) {
            if controller.phase == .shadowRecording {
                controller.finishShadowRecord()
            } else {
                controller.beginShadowRecord()
            }
        }
        .disabled(shadowDisabled)
        .help("照着 AI 最新一句读，讯飞评测打分")
    }

    private var shadowDisabled: Bool {
        guard !drillOpen else { return true }  // 词练抽屉占用麦克风（SpeakView.tsx:1390）
        switch controller.phase {
        case .idleTurn, .speaking, .error, .shadowRecording:
            return false
        default:
            return true
        }
    }

    /// 跟读按钮文案（对齐 SpeakView.tsx:1906-1914）：录音中「松开结束跟读」/ 评分中 /
    /// 已出分「跟读 X 分 · 再跟读」/ 异常卡在场「再跟读一次」/ 缺省「跟读这句」。
    private var shadowLabel: String {
        switch controller.phase {
        case .shadowRecording: return "松开结束跟读"
        case .shadowAssessing: return "评分中…"
        default:
            if let total = lastShadowReport?.totals.last {
                return String(format: "跟读 %.1f 分 · 再跟读", total)
            }
            if controller.shadowFailure != nil {
                return "再跟读一次"
            }
            return "跟读这句"
        }
    }

    /// 收尾动作（.speak-finish）：无边框文字按钮，无跟读数据时禁用（Windows 同文案）。
    private var finishButton: some View {
        SpeakTextButton(title: "结束并复盘 →", palette: palette) {
            controller.stopSpeaking()
            reviewShown = true
        }
        .opacity(hasAssessments && !drillOpen ? 1 : 0.5)
        .disabled(!hasAssessments || drillOpen)
        .help(hasAssessments
            ? "复盘本轮跟读中没掌握的词，确认后加入生词本"
            : "还没有跟读记录——先「跟读这句」一次再来复盘")
    }

    // MARK: - 发音反馈面板（右栏常驻，Windows .speak-panel / PronPanel）

    /// 最新带 pron 的 user 轮（pron 引用在会话其它更新间保持稳定，选中态不重置）。
    private var lastPronTurn: SpeakTurn? {
        guard let session = controller.session else { return nil }
        for turn in session.turns.reversed() where turn.pron != nil {
            return turn
        }
        return nil
    }

    private var lastPron: ShadowAttempt? { lastPronTurn?.pron }
    private var lastPronText: String { lastPronTurn?.text ?? "" }

    /// 右栏三段玻璃卡：head（这句的发音）/ body（空态预览或总分+选词卡+曲线）/ foot。
    private var pronunciationPanel: some View {
        VStack(spacing: 0) {
            panelHead
            panelBody
            panelFoot
        }
        .glassCard(palette: palette, radius: 22, heavyShadow: true)
    }

    private var panelHead: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(lastPron != nil ? "这句的发音" : "发音反馈")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(palette.text)
            Spacer(minLength: 8)
            Text(lastPron != nil ? "点句中标色的词看细节" : "每说一句自动更新")
                .font(.system(size: 11.5))
                .foregroundColor(palette.textTertiary)
        }
        .padding(.horizontal, 18)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .overlay(alignment: .bottom) {
            Rectangle().fill(palette.glassBorder).frame(height: 1)
        }
    }

    @ViewBuilder
    private var panelBody: some View {
        if let pron = lastPron {
            ScrollView {
                panelPronSections(pron)
                    .onChange(of: pron.at) { newAt in
                        selectWorstWordIfNeeded(newAt: newAt)
                    }
                    .onAppear {
                        selectWorstWordIfNeeded(newAt: pron.at)
                    }
            }
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    panelPreviewRow(icon: "star", text: "整句总分，准确 / 流利 / 完整三项")
                    panelPreviewRow(icon: "highlighter", text: "读得不准的词会在你的句子里标色")
                    panelPreviewRow(icon: "arrow.down.forward.square", text: "点那个词，看哪个音偏了、听慢速示范")
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
    }

    /// 空态预览行（.speak-panel-preview）：28px 图标方块 + 一句说明。
    private func panelPreviewRow(icon: String, text: String) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundColor(palette.textTertiary)
                .frame(width: 28, height: 28)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(palette.background))
            Text(text)
                .font(.system(size: 13))
                .foregroundColor(palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }

    private var panelFoot: some View {
        HStack(spacing: 0) {
            Text("发音评分由讯飞提供 · ")
            Button {
                (NSApp.delegate as? AppDelegate)?.openVoiceSettings()
            } label: {
                Text("凭据设置")
                    .underline()
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("讯飞评测/听写凭据在主窗口 设置 → 语音 里集中配置")
        }
        .font(.system(size: 11.5))
        .foregroundColor(palette.textTertiary)
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .overlay(alignment: .top) {
            Rectangle().fill(palette.glassBorder).frame(height: 1)
        }
    }

    /// 新评测到达：默认选中得分最低的词（含漏读 0 分）。
    private func selectWorstWordIfNeeded(newAt: Int64) {
        guard newAt != lensPronAt, let pron = lastPron else { return }
        lensPronAt = newAt
        guard !pron.words.isEmpty else {
            pronSel = nil
            return
        }
        var worst = 0
        for (i, w) in pron.words.enumerated() where w.totalScore < pron.words[worst].totalScore {
            worst = i
        }
        pronSel = PronSelection(wordIdx: worst, phoneIdx: 0)
    }

    /// 已出分区（.speak-panel-body 内容）：总分圆环 + 三项分条 + 选中词卡 + 逐词曲线。
    private func panelPronSections(_ pron: ShadowAttempt) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 16) {
                scoreRing(total: pron.total)
                VStack(spacing: 7) {
                    scoreSubBar("准确", value: pron.accuracy, help: "准确度：每个音发得准不准")
                    scoreSubBar("流利", value: pron.fluency, help: "流畅度：语速与停顿是否自然")
                    scoreSubBar("完整", value: pron.integrity, help: "完整度：有没有漏词、添词")
                }
            }
            .padding(.top, 2)
            if let sel = pronSel, let word = pron.words[safe: sel.wordIdx] {
                panelWordSection(word, sel: sel)
            } else {
                Text(weakCount == 0 ? "这句没有明显读错的词，继续保持。" : "点你句子里标色的词，看具体哪个音偏了。")
                    .font(.system(size: 12.5))
                    .foregroundColor(palette.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            panelCurve(pron)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    /// 总分圆环（.speak-ring）：conic 进度环 + 内嵌 glass-elevated 圆。
    private func scoreRing(total: Double) -> some View {
        let tone = scoreToneOf(total)
        return ZStack {
            Circle().fill(palette.background)
            Circle()
                .trim(from: 0, to: scorePctOf(total) / 100)
                .stroke(toneColor(tone), style: StrokeStyle(lineWidth: 7, lineCap: .butt))
                .rotationEffect(.degrees(-90))
            Circle()
                .fill(palette.glassElevated)
                .padding(7)
            VStack(spacing: 0) {
                Text(String(format: "%.1f", total))
                    .font(.system(size: 18, weight: .semibold).monospacedDigit())
                    .foregroundColor(palette.text)
                Text("/ 5")
                    .font(.system(size: 10))
                    .foregroundColor(palette.textTertiary)
            }
        }
        .frame(width: 68, height: 68)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(String(format: "总分 %.1f / 5", total))
    }

    /// 三项分条（.speak-sub）：30 标签 + 5px 进度条 + 数值。
    private func scoreSubBar(_ label: String, value: Double, help: String) -> some View {
        let tone = scoreToneOf(value)
        return HStack(spacing: 8) {
            Text(label)
                .font(.system(size: 12))
                .foregroundColor(palette.textSecondary)
                .frame(width: 30, alignment: .leading)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(palette.background)
                    Capsule()
                        .fill(toneColor(tone))
                        .frame(width: geo.size.width * scorePctOf(value) / 100)
                }
            }
            .frame(height: 5)
            Text(String(format: "%.1f", value))
                .font(.system(size: 12).monospacedDigit())
                .foregroundColor(palette.textSecondary)
                .frame(width: 26, alignment: .trailing)
        }
        .help(help)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label) \(String(format: "%.1f", value))")
    }

    /// 选中词卡（.speak-word）：词头 + 音素药丸网格 + 舌位建议 + 示范动作。
    private func panelWordSection(_ word: ShadowWord, sel: PronSelection) -> some View {
        let phones = word.sylls.flatMap(\.phones)
        let selPhone = phones[safe: sel.phoneIdx]
        let tone = scoreToneOf(word.totalScore)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(word.content)
                    .font(.system(size: 20, design: .serif))
                    .foregroundColor(palette.text)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(String(format: "%.1f 分", word.totalScore))
                    .font(.system(size: 13, weight: .semibold).monospacedDigit())
                    .foregroundColor(toneColor(tone))
            }
            if phones.isEmpty {
                Text("这个词没有返回音标明细")
                    .font(.system(size: 12.5))
                    .foregroundColor(palette.textTertiary)
            } else {
                LazyVGrid(
                    columns: [
                        GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8),
                        GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8),
                    ],
                    spacing: 8
                ) {
                    ForEach(Array(phones.enumerated()), id: \.offset) { idx, phone in
                        phonemeNode(phone, selected: idx == sel.phoneIdx) {
                            pronSel = PronSelection(wordIdx: sel.wordIdx, phoneIdx: idx)
                        }
                    }
                }
                Text(selPhone.map { String(format: "/%@/：%@", $0.content, phoneTip($0.content)) } ?? "点上面的音素看针对性建议")
                    .font(.system(size: 13))
                    .foregroundColor(palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                SpeakGhostButton(title: "慢速示范", icon: "speaker.wave.2", palette: palette) {
                    controller.speakWordSlow(word.content)
                }
                .help("云引擎按 0.75× 原生慢速合成示范；本地语音走普通朗读")
                SpeakGhostButton(title: "重读这个词", palette: palette) {
                    controller.speakWord(word.content)
                }
            }
        }
        .padding(.top, 16)
        .overlay(alignment: .top) {
            Rectangle().fill(palette.glassBorder).frame(height: 1)
        }
    }

    /// 音素药丸节点（.phoneme-node）：gwpp → ok/warn/bad 着色 + 状态行，选中描边。
    private func phonemeNode(_ phone: ReaderCore.ShadowPhone, selected: Bool, onSelect: @escaping () -> Void) -> some View {
        let status = phoneStatusOf(phone.gwpp)
        return Button(action: onSelect) {
            VStack(spacing: 2) {
                Text("/\(phone.content)/")
                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
                    .foregroundColor(palette.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(status.label)
                    .font(.system(size: 10))
                    .foregroundColor(palette.textTertiary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(status.bg(palette))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(status.border(palette)))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(palette.text.opacity(selected ? 1 : 0), lineWidth: 2)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("点击查看这个音素的发音建议")
    }

    /// 逐词得分曲线（.speak-curve，Windows details 默认收起）。
    private func panelCurve(_ pron: ShadowAttempt) -> some View {
        DisclosureGroup(isExpanded: $curveExpanded) {
            VStack(alignment: .leading, spacing: 6) {
                wordScoreChart(wordScorePath(pron.words), words: pron.words)
                Text("虚线是 5 分基准；点圆点同步选中上方单词。")
                    .font(.system(size: 12.5))
                    .foregroundColor(palette.textTertiary)
            }
            .padding(.top, 8)
        } label: {
            Text("逐词得分曲线")
                .font(.system(size: 12.5))
                .foregroundColor(palette.textTertiary)
        }
        .padding(.top, 14)
        .overlay(alignment: .top) {
            Rectangle().fill(palette.glassBorder).frame(height: 1)
        }
    }

    /// 逐词得分折线（.word-score-svg：画布底圆角框 + 5 分基准虚线 + 点圆点同步选词）。
    private func wordScoreChart(_ path: ReaderCore.WordScorePath, words: [ShadowWord]) -> some View {
        ZStack(alignment: .topLeading) {
            Path { p in
                p.move(to: CGPoint(x: 12, y: path.baselineY))
                p.addLine(to: CGPoint(x: path.width - 12, y: path.baselineY))
            }
            .stroke(style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
            .foregroundColor(palette.glassBorderStrong)
            if path.points.count > 1 {
                Path { p in
                    p.move(to: CGPoint(x: path.points[0].x, y: path.points[0].y))
                    for pt in path.points.dropFirst() {
                        p.addLine(to: CGPoint(x: pt.x, y: pt.y))
                    }
                }
                .stroke(palette.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round))
            }
            ForEach(Array(path.points.enumerated()), id: \.offset) { i, pt in
                let active = pronSel?.wordIdx == i
                Button {
                    pronSel = PronSelection(wordIdx: i, phoneIdx: 0)
                } label: {
                    Circle()
                        .fill(active ? palette.accent : palette.textSecondary)
                        .frame(width: active ? 7 : 4.5, height: active ? 7 : 4.5)
                }
                .buttonStyle(.plain)
                .position(x: pt.x, y: pt.y)
                .help(words[safe: i].map { String(format: "%@ · %.1f 分", $0.content, $0.totalScore) } ?? "")
            }
        }
        .frame(width: path.width, height: path.height)
        .frame(maxWidth: .infinity)
        .padding(6)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(palette.background))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(palette.glassBorder))
    }

    // MARK: - 5 分制着色（Windows speakUi.scoreTone / scorePct 同阈值 ≥4 / ≥3）

    private func scoreToneOf(_ score5: Double) -> SpeakScoreTone {
        guard score5.isFinite else { return .bad }
        if score5 >= 4 { return .good }
        if score5 >= 3 { return .ok }
        return .bad
    }

    /// 5 分制 → 0–100（圆环/进度条），越界夹取，非有限数按 0。
    private func scorePctOf(_ score5: Double) -> Double {
        guard score5.isFinite else { return 0 }
        return Double(Int(min(5, max(0, score5)) * 20))
    }

    private func toneColor(_ tone: SpeakScoreTone) -> Color {
        switch tone {
        case .good: return palette.sonicTeal
        case .ok: return palette.warn
        case .bad: return palette.err
        }
    }

    private func toneSoftColor(_ tone: SpeakScoreTone) -> Color {
        switch tone {
        case .good: return palette.sonicTealSoft
        case .ok: return palette.warnSoft
        case .bad: return palette.errSoft
        }
    }
}

/// 圆环/分条/药丸共用的三档着色（good=teal / ok=warn / bad=err）。
enum SpeakScoreTone {
    case good, ok, bad
}

// MARK: - 听力模式遮罩

/// 听力模式遮罩（reader.css .listen-veil：blur 9px / opacity .85 / 不可选不可点），
/// 保高度不引起滚动跳动；辅助功能隐藏（aria-hidden 对应物）。
private struct ListenVeil: ViewModifier {
    let on: Bool

    func body(content: Content) -> some View {
        content
            .blur(radius: on ? 9 : 0)
            .opacity(on ? 0.85 : 1)
            .allowsHitTesting(!on)
            .accessibilityHidden(on)
    }
}

// MARK: - 目录紧凑卡（「官方场景库」「我的场景」共用）

/// 目录紧凑卡（对齐 Windows CompactScenarioCard）：分类+emoji 标签、标题、2 行摘要
/// （goal 优先，缺位回退 aiRole）、difficulty 小标签；开场白预览挪到悬浮提示
/// 逐字 `开场白：“{opener}”`。点击行为与大卡一致（start(sc.id, defaultDifficulty ?? 当前难度)）。
private struct CompactScenarioCard: View {
    let sc: SpeakScenario
    let palette: ReaderPalette
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 0) {
                    Text("\(speakScenarioCategoryTag(sc.category))\(sc.emoji.map { " \($0)" } ?? "")")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundColor(palette.textSecondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2.5)
                        .background(
                            Capsule().fill(palette.background)
                                .overlay(Capsule().strokeBorder(palette.glassBorder, lineWidth: 1))
                        )
                    Spacer(minLength: 0)
                }
                Text(sc.title)
                    .font(.system(size: 15, weight: .semibold, design: .serif))
                    .foregroundColor(palette.text)
                    .lineLimit(1)
                Text(scenarioSummary(sc))
                    .font(.system(size: 11.5))
                    .lineSpacing(2)
                    .foregroundColor(palette.textSecondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Spacer(minLength: 0)
                if let difficulty = sc.defaultDifficulty {
                    Text("\(difficultyOf(difficulty).label)难度")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(palette.textSecondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(
                            Capsule().fill(palette.background)
                                .overlay(Capsule().strokeBorder(palette.glassBorder, lineWidth: 1))
                        )
                }
            }
            .padding(.vertical, 14)
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: 128, maxHeight: .infinity, alignment: .topLeading)
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .modifier(GlassCardStyle(
                palette: palette,
                radius: 16,
                elevated: hover,
                heavyShadow: hover,
                borderColor: hover ? palette.textSecondary.opacity(0.55) : nil
            ))
        }
        .buttonStyle(.plain)
        .offset(y: hover ? -2 : 0)
        .onHover { h in
            withAnimation(.timingCurve(0.16, 1, 0.3, 1, duration: 0.2)) { hover = h }
        }
        .help("开场白：“\(sc.opener)”")
        .accessibilityLabel("\(speakScenarioCategoryTag(sc.category))：\(sc.title)")
    }
}

// MARK: - 场景大厅组件（v0.8 场景中心 · 原型 html:731-821）

/// 场景卡 tag 三态配色（原型 .sc-tag / .sc-tag.teal / .sc-tag.neutral）。
private enum ScenarioTagTone {
    case accent, teal, neutral
}

/// 场景卡（.scenario-card）：20 圆角玻璃 + 20/22 padding；hover 200ms 弹性升起 2pt，
/// 材质从 glass-surface 抬到 glass-elevated、边线加深、投影换 spatial。
/// 内容层次：SF 图标 tag 胶囊 → 20pt 衬线标题 → 13pt 描述 → 顶发丝线 + 斜体开场白。
private struct ScenarioCard<Desc: View>: View {
    let icon: String
    let tag: String
    let tone: ScenarioTagTone
    let title: String
    let openerPreview: String
    let palette: ReaderPalette
    let action: () -> Void
    private let descView: Desc
    @State private var hover = false

    init(
        icon: String,
        tag: String,
        tone: ScenarioTagTone,
        title: String,
        openerPreview: String,
        palette: ReaderPalette,
        action: @escaping () -> Void,
        @ViewBuilder desc: () -> Desc
    ) {
        self.icon = icon
        self.tag = tag
        self.tone = tone
        self.title = title
        self.openerPreview = openerPreview
        self.palette = palette
        self.action = action
        self.descView = desc()
    }

    private var tagColors: (fg: Color, bg: Color, border: Color) {
        switch tone {
        case .accent: return (palette.accent, palette.accentSoft, .clear)
        case .teal: return (palette.sonicTeal, palette.sonicTealSoft, .clear)
        case .neutral: return (palette.textSecondary, palette.background, palette.glassBorder)
        }
    }

    var body: some View {
        let colors = tagColors
        Button(action: action) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 0) {
                    HStack(spacing: 6) {
                        Image(systemName: icon)
                            .font(.system(size: 10.5, weight: .semibold))
                        Text(tag)
                            .font(.system(size: 11, weight: .semibold))
                    }
                    .foregroundColor(colors.fg)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 3)
                    .background(
                        Capsule().fill(colors.bg)
                            .overlay(Capsule().strokeBorder(colors.border, lineWidth: 1))
                    )
                    Spacer(minLength: 0)
                }
                Text(title)
                    .font(.system(size: 20, weight: .semibold, design: .serif))
                    .foregroundColor(palette.text)
                    .fixedSize(horizontal: false, vertical: true)
                descView
                    .font(.system(size: 13))
                    .lineSpacing(3)
                    .foregroundColor(palette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Spacer(minLength: 0)
                Text("开场白：“\(openerPreview)”")
                    .font(.system(size: 13, design: .serif).italic())
                    .foregroundColor(palette.textTertiary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 10)
                    .overlay(alignment: .top) {
                        Rectangle().fill(palette.glassBorder).frame(height: 1)
                    }
            }
            .padding(.vertical, 20)
            .padding(.horizontal, 22)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .modifier(GlassCardStyle(
                palette: palette,
                radius: 20,
                elevated: hover,
                heavyShadow: hover,
                borderColor: hover ? palette.textSecondary.opacity(0.55) : nil
            ))
        }
        .buttonStyle(.plain)
        .offset(y: hover ? -2 : 0)
        .onHover { h in
            withAnimation(.timingCurve(0.16, 1, 0.3, 1, duration: 0.2)) { hover = h }
        }
        .help("开始「\(title)」对话")
        .accessibilityLabel("\(tag)：\(title)")
    }
}

/// 最近会话行（.recent-session-row，html:805-821）：14 圆角 glass-surface，
/// hover 150ms 抬到 glass-elevated + 深边。
private struct RecentSessionRow: View {
    let title: String
    let subtitle: String
    let palette: ReaderPalette
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 1.5) {
                    Text(title)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(palette.text)
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundColor(palette.textTertiary)
                }
                Spacer()
                HStack(spacing: 3) {
                    Text("继续对话")
                    Image(systemName: "arrow.right").font(.system(size: 9, weight: .semibold))
                }
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundColor(palette.accent)
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 16)
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .modifier(GlassCardStyle(
                palette: palette,
                radius: 14,
                elevated: hover,
                heavyShadow: false,
                borderColor: hover ? palette.glassBorderStrong : palette.glassBorder
            ))
        }
        .buttonStyle(.plain)
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
        }
        .help("继续这次对话")
    }
}

/// 按权分配宽度的单行布局（原型 grid-template-columns: 1.15fr 0.85fr 的原生等价，
/// macOS 13 Layout 协议）：子视图宽度按 weights 比例切分，高度统一取最高者（等高卡）。
struct WeightedHStack: Layout {
    var weights: [CGFloat]
    var spacing: CGFloat = 16

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        measure(width: proposal.width, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = measure(width: bounds.width, subviews: subviews)
        for (i, sub) in subviews.enumerated() {
            let frame = result.frames[i]
            sub.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY),
                anchor: .topLeading,
                proposal: ProposedViewSize(width: frame.width, height: result.size.height)
            )
        }
    }

    private func measure(width: CGFloat?, subviews: Subviews) -> (size: CGSize, frames: [CGRect]) {
        let n = subviews.count
        guard n > 0 else { return (.zero, []) }
        let used = (0..<n).map { weights.indices.contains($0) ? weights[$0] : 1 }
        let total = max(used.reduce(0, +), 0.001)
        let totalWidth = width ?? subviews.map { $0.sizeThatFits(.unspecified).width }.reduce(0, +)
        let usable = max(0, totalWidth - spacing * CGFloat(n - 1))
        var frames: [CGRect] = []
        var x: CGFloat = 0
        var height: CGFloat = 0
        for (i, sub) in subviews.enumerated() {
            let w = usable * used[i] / total
            let size = sub.sizeThatFits(ProposedViewSize(width: w, height: nil))
            frames.append(CGRect(x: x, y: 0, width: w, height: size.height))
            height = max(height, size.height)
            x += w + spacing
        }
        return (CGSize(width: max(0, x - spacing), height: height), frames)
    }
}

// MARK: - 口语页小部件（.speak-btn / .text-action-btn / .speak-finish / 气泡形状）

/// .speak-btn：次要动作按钮——glass-elevated 底 + 发丝边，悬停边与字加深。
struct SpeakGhostButton: View {
    let title: String
    var icon: String? = nil
    let palette: ReaderPalette
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: 11))
                }
                Text(title)
                    .font(.system(size: 12.5))
                    .lineLimit(1)
            }
            .foregroundColor(hover ? palette.text : palette.textSecondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(palette.glassElevated)
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(hover ? palette.textTertiary.opacity(0.6) : palette.glassBorderStrong))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
        }
    }
}

/// .text-action-btn：行内文字小按钮（重听 / 看原文），悬停转强调色。
/// （ReaderViews.swift 已有同名 private 组件，此处按口语页字段命名区分。）
struct SpeakTextAction: View {
    let title: String
    let icon: String
    let palette: ReaderPalette
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.system(size: 10.5, weight: .medium))
                Text(title)
                    .font(.system(size: 12, weight: .medium))
            }
            .foregroundColor(hover ? palette.accent : palette.textSecondary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
        }
    }
}

/// .speak-finish / .speak-scene-back：无边框文字按钮，悬停浮起一层画布底。
struct SpeakTextButton: View {
    let title: String
    let palette: ReaderPalette
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12.5))
                .foregroundColor(hover ? palette.text : palette.textSecondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(hover ? palette.glassBorder.opacity(0.7) : Color.clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { h in
            withAnimation(ReaderMotion.hover) { hover = h }
        }
    }
}

/// .dialogue-turn.mine 气泡四角（18/18/4/18，右下收小成「尾巴」，对齐
/// border-radius: 18px 18px 4px 18px）。macOS 13 无 UnevenRoundedRectangle，手绘。
struct UserBubbleShape: Shape {
    var radius: CGFloat = 18
    var tail: CGFloat = 4

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let r = min(radius, min(rect.width, rect.height) / 2)
        p.move(to: CGPoint(x: rect.minX + r, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        p.addArc(center: CGPoint(x: rect.maxX - r, y: rect.minY + r), radius: r,
                 startAngle: .degrees(270), endAngle: .degrees(0), clockwise: false)
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - tail))
        p.addArc(center: CGPoint(x: rect.maxX - tail, y: rect.maxY - tail), radius: tail,
                 startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        p.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
        p.addArc(center: CGPoint(x: rect.minX + r, y: rect.maxY - r), radius: r,
                 startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        p.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
        p.addArc(center: CGPoint(x: rect.minX + r, y: rect.minY + r), radius: r,
                 startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        p.closeSubpath()
        return p
    }
}

/// 音素状态三档（Windows ShadowReport.phoneStatusOf：gwpp ≤ -1 bad / ≤ -0.4 warn / 其余 ok）。
private enum PhoneStatus {
    case ok, warn, bad

    var label: String {
        switch self {
        case .bad: return "需多练"
        case .warn: return "偏弱"
        case .ok: return "还行"
        }
    }

    func bg(_ p: ReaderPalette) -> Color {
        switch self {
        case .bad: return p.errSoft
        case .warn: return p.warnSoft
        case .ok: return p.background
        }
    }

    func border(_ p: ReaderPalette) -> Color {
        switch self {
        case .bad: return p.err
        case .warn: return p.warn
        case .ok: return p.glassBorder
        }
    }
}

private func phoneStatusOf(_ gwpp: Double) -> PhoneStatus {
    if gwpp <= -1.0 { return .bad }
    if gwpp <= -0.4 { return .warn }
    return .ok
}

// MARK: - ReaderCore → XfyunCore 桥接

extension ReaderCore.ShadowWord {
    /// 落盘词明细 → XfyunCore 词明细（mapWordsToText 词对齐共用）。
    var xfyunWordScore: WordScore {
        WordScore(
            content: content,
            totalScore: totalScore,
            dpMessage: dpMessage,
            sylls: sylls.map { syll in
                SyllScore(
                    content: syll.content,
                    syllScore: syll.syllScore,
                    serrMsg: syll.serrMsg,
                    phones: syll.phones.map { PhoneScore(content: $0.content, dpMessage: $0.dpMessage, gwpp: $0.gwpp) }
                )
            }
        )
    }
}
