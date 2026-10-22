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
    /// 当前透镜卡正在展示的 pron 时间戳（变化时重选最差词）。
    @State private var lensPronAt: Int64?
    /// 口语页是否借用了全局抽屉的接线（收起时还给阅读室）。
    @State private var drillBorrowed = false

    init(vm: ReaderViewModel, controller: SpeakViewController) {
        self.vm = vm
        self.controller = controller
        self.drill = vm.drill
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
            wireDependencies()
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

                groupLabel("日常与职场模拟场景", trailing: "点击即可开始")
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

                if !controller.recentSessions.isEmpty {
                    groupLabel("继续上次的对话", trailing: nil)
                    ForEach(controller.recentSessions.prefix(3)) { session in
                        recentRow(session)
                    }
                }
            }
            .padding(20)
        }
        .background(palette.background)
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

    private func groupLabel(_ title: String, trailing: String?) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(palette.textSecondary)
            Spacer()
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
            action: { controller.start(scenario: .smalltalk, difficulty: selectedDifficulty, context: ctx) }
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
                    scenario: .smalltalk, difficulty: selectedDifficulty,
                    context: .vocab(wordIds: dueVocabWords.map(\.id))
                )
            }
        )
    }

    private func dailyScenarioCard(_ id: SpeakScenarioId) -> some View {
        let scenario = scenarioOf(id)
        return scenarioCard(
            icon: id == .interview ? "briefcase.fill" : id == .ordering ? "fork.knife" : id == .travel ? "airplane" : "bubble.left",
            tag: id == .interview ? "职场高频" : id == .ordering ? "生活实用" : id == .travel ? "出行必备" : "轻松开口",
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

    private var conversationPage: some View {
        HStack(spacing: 0) {
            dialogueColumn
            Divider().opacity(0.6)
            pronunciationLens
                .frame(width: 292)
                .background(palette.surfaceAlt.opacity(0.5))
        }
        .background(palette.background)
    }

    private var dialogueColumn: some View {
        VStack(spacing: 0) {
            // M-03：声波舞台卡（.harmonic-stage-card，原型 html:837-860）——
            // 口语页唯一的「生命感」元素：谐波画布铺底，切换场景 / 标题 / 目标词
            // chips 收进卡内，与 Windows SpeakView.tsx:1175-1223 对齐。
            harmonicStage
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 16)

            ScrollViewReader { proxy in
                ScrollView {
                    // 原型 .sonic-turns-scroll gap: 20
                    VStack(spacing: 20) {
                        if let session = controller.session {
                            ForEach(session.turns) { turn in
                                turnBubble(turn)
                                    .id(turn.id)
                            }
                        }
                        if controller.phase == .thinking {
                            thinkingBubble
                        }
                        if controller.phase == .transcribing {
                            HStack {
                                Text("…识别你刚才说的…")
                                    .font(.system(size: 11))
                                    .foregroundColor(palette.textTertiary)
                                Spacer()
                            }
                            .padding(.horizontal, 4)
                        }
                        // 跟读报告卡（SPEAK-7）：评分后从落盘 attempts 派生，跟读录音/
                        // 评测中不显示（正被新一轮覆盖，SpeakView.tsx:650-653 同语义）。
                        if let report = lastShadowReport, let target = shadowTarget {
                            HStack {
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
                            HStack {
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
                    .padding(16)
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

            if case .error(let message) = controller.phase {
                errorBanner(message)
            }

            Divider().opacity(0.5)
            controlBar
        }
    }

    /// 声波舞台卡：122pt 高 / 20 圆角玻璃，画布 opacity .72 铺底不拦事件；
    /// 左侧「切换场景 + 场景标题 + 目标词 chips」，右侧「重听 AI 这句」。
    private var harmonicStage: some View {
        ZStack {
            HarmonicCanvas(phase: controller.phase, level: controller.level)
                .opacity(0.72)
                .allowsHitTesting(false)
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 10) {
                        Button {
                            controller.backToEntry()
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "chevron.left").font(.system(size: 10, weight: .semibold))
                                Text("切换场景").font(.system(size: 12))
                            }
                        }
                        .buttonStyle(.plain)
                        .foregroundColor(palette.accent)
                        if let s = controller.session {
                            Text("\(speakSceneTitle(s)) · \(difficultyOf(s.difficulty).label)难度")
                                .font(.system(size: 13, weight: .semibold))
                                .lineLimit(1)
                                .help(speakSceneTitle(s))
                        }
                    }
                    if !contextTargets.isEmpty {
                        stageTargetChips
                    }
                }
                Spacer(minLength: 12)
                replayButton
            }
            .padding(.horizontal, 22)
        }
        .frame(height: 122, alignment: .center)
        .glassCard(palette: palette, radius: 20)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("声波舞台：\(controller.session.map(speakSceneTitle) ?? "")")
    }

    private var replayButton: some View {
        Button {
            controller.replayLast()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "speaker.wave.2").font(.system(size: 11))
                Text("重听 AI 这句").font(.system(size: 11.5))
            }
        }
        .buttonStyle(.plain)
        .foregroundColor(palette.textSecondary)
        .disabled(controller.phase == .recording || controller.phase == .transcribing || controller.phase == .thinking)
        .help("重听 AI 最新一句")
    }

    /// 舞台卡内的目标词 chips（.lex-target-chip，html:873-891；≤6 个）：
    /// ○ 待练习 = glass-elevated 底 + 发丝边；✓ 已用上 = teal-soft 底 + teal 边 600 字重。
    /// 中文释义收进悬浮说明，chips 保持一行能放下的密度；点击 toast 说明。
    private var stageTargetChips: some View {
        FlowLayout(spacing: 8, lineSpacing: 6) {
            ForEach(contextTargets.prefix(6), id: \.word.id) { target in
                let done = hitTargetIds.contains(target.word.id)
                Button {
                    vm.showToast("今日练习词块：\(target.word.word) — 在对话中自然说出即可完成")
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: done ? "checkmark" : "circle")
                            .font(.system(size: 8, weight: .bold))
                        Text(target.word.word)
                            .font(.system(size: 12, weight: done ? .semibold : .regular, design: .serif))
                    }
                    .foregroundColor(done ? palette.sonicTeal : palette.textSecondary)
                    .padding(.horizontal, 11)
                    .padding(.vertical, 4)
                    .background(
                        Capsule().fill(done ? palette.sonicTealSoft : palette.glassElevated)
                            .overlay(Capsule().strokeBorder(done ? palette.sonicTeal : palette.glassBorderStrong))
                    )
                }
                .buttonStyle(.plain)
                .help(
                    "\(target.word.word)\(target.zh.isEmpty ? "" : " · \(target.zh)")"
                        + (done ? " — 已用上" : " — 在对话中自然说出即可完成")
                )
                .accessibilityLabel("\(done ? "已用上" : "待练习")：\(target.word.word)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 对话轮（原型 html:901-930）：AI 轮直接落在画布上（无底卡），用户轮是
    /// .dialogue-turn.mine——18 圆角 glass-elevated + shadow-pill，最大宽 58ch；
    /// 排版三级：英文 19pt 衬线 / 行距 1.58、中文提示 13.5、speaker 行 11.5。
    private func turnBubble(_ turn: SpeakTurn) -> some View {
        let isUser = turn.role == .user
        return HStack {
            if isUser { Spacer(minLength: 24) }
            if isUser {
                turnContent(turn)
                    .padding(.vertical, 16)
                    .padding(.horizontal, 20)
                    .frame(maxWidth: 560, alignment: .trailing)
                    .glassCard(palette: palette, radius: 18, elevated: true)
            } else {
                turnContent(turn)
                    .frame(maxWidth: 580, alignment: .leading)
                    .padding(.horizontal, 2)
            }
            if !isUser { Spacer(minLength: 24) }
        }
    }

    @ViewBuilder
    private func turnContent(_ turn: SpeakTurn) -> some View {
        let isUser = turn.role == .user
        VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
            if isUser {
                HStack(spacing: 8) {
                    Text("我的回答 · 点击右侧单词查看发音细节")
                        .font(.system(size: 11.5))
                        .foregroundColor(palette.textTertiary)
                    if let pron = turn.pron {
                        Text(String(format: "发音得分 %.1f / 5.0", pron.total))
                            .font(.system(size: 11.5, weight: .semibold).monospacedDigit())
                            .foregroundColor(palette.accent)
                    }
                }
            } else {
                Text("AI 陪练 · \(scenarioOf(controller.session?.scenario ?? .smalltalk).label)")
                    .font(.system(size: 11.5))
                    .foregroundColor(palette.textTertiary)
            }
            Text(turn.text)
                .font(.system(size: 19, design: .serif))
                .lineSpacing(7)
                .foregroundColor(palette.text)
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.leading)
            if let hint = turn.hintZh {
                Text(hint)
                    .font(.system(size: 13.5))
                    .foregroundColor(palette.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // 历史 assistant 轮的跟读摘要行；最新一轮由对话流末尾的报告卡承担，不重复
            //（SpeakView.tsx:1260 `!isLastAssistant && …`）。
            if turn.role == .assistant, turn.id != lastAssistantTurnId {
                if let attempts = turn.shadowAttempts, !attempts.isEmpty {
                    Text("跟读过 \(attempts.count) 次 · 最好 \(String(format: "%.1f", attempts.map(\.total).max() ?? 0))")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(palette.textSecondary)
                } else if let score = turn.shadowScore {
                    Text("跟读 \(String(format: "%.1f", score)) 分\(score < 4.2 ? " · 可以再试一次" : "")")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(score < 4.2 ? palette.warn : palette.ok)
                }
            }
            if let diff = turn.coachDiff, !diff.segs.isEmpty {
                coachDiffBlock(diff, turnText: turn.text)
            }
        }
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
                if controller.streaming.en.isEmpty {
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

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundColor(palette.err)
            Text(message)
                .font(.system(size: 11))
                .foregroundColor(palette.err)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button("知道了") { controller.clearError() }
                .controlSize(.small)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(palette.err.opacity(0.08))
    }

    // MARK: - 底部控制条

    private var micTitle: String {
        switch controller.phase {
        case .recording: return "正在听你说——停顿约 1.5 秒自动发送，再点一下立即说完"
        case .speaking: return "点击插话（会打断播报）"
        default: return "点击开始说话，停顿自动发送"
        }
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

    private var phaseHint: String {
        switch controller.phase {
        case .recording: return "正在听你说…停顿约 1.5 秒自动发送"
        case .transcribing: return "识别中…"
        case .thinking: return "对方回复中…"
        case .speaking: return "对方说话中 · 点击麦克风可插话"
        default: return "点击麦克风说话（英语）→ AI 回复带中文提示与表达改进"
        }
    }

    private var controlBar: some View {
        VStack(spacing: 6) {
            HStack(spacing: 12) {
                micButton
                if controller.phase == .recording {
                    levelBar(controller.level)
                    Text(String(format: "%.1fs", Double(controller.elapsedMs) / 1000))
                        .font(.system(size: 10.5).monospacedDigit())
                        .foregroundColor(palette.textTertiary)
                    Button("说完了") { controller.toggleMic() }
                        .controlSize(.small)
                        .buttonStyle(.borderedProminent)
                }
                Text(phaseHint)
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                if controller.phase == .thinking {
                    Button("跳过回复") { controller.skipReply() }
                        .controlSize(.small)
                        .help("不等这次回复了，接着说下一句")
                }
                shadowButton
                reviewButton
            }
            // REVIEW-05：10 → 11pt。常驻提示不低于 macOS 辅助字号下限 11pt
            //（Windows 网页 10px 在非 Retina 外接屏上发虚；px 值当上限而非下限）。
            Text("「跟读打分」照 AI 最新一句读，报告卡会告诉你差在哪；右侧「发音详情」看你每轮发言的逐词得分")
                .font(.system(size: 11))
                .foregroundColor(palette.textTertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(palette.surface)
    }

    /// 点击开麦按钮：idle/error/speaking 点击即开麦（speaking 打断播报插话）；
    /// 录音中再点 = 立即说完；识别/回复中禁用。
    private var micButton: some View {
        let recording = controller.phase == .recording
        return Button {
            controller.toggleMic()
        } label: {
            ZStack {
                Circle()
                    .fill(recording ? palette.err : palette.accent)
                    .frame(width: 40, height: 40)
                    .shadow(color: (recording ? palette.err : palette.accent).opacity(0.35), radius: recording ? 8 : 4)
                Image(systemName: recording ? "stop.fill" : "mic.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.white)
            }
        }
        .buttonStyle(.plain)
        .disabled(!canToggleMic)
        .opacity(canToggleMic ? 1 : 0.4)
        .help(micTitle)
        .accessibilityLabel(recording ? "说完（点击结束录音）" : "点击开始说话")
    }

    private var shadowButton: some View {
        Button {
            if controller.phase == .shadowRecording {
                controller.finishShadowRecord()
            } else {
                controller.beginShadowRecord()
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "waveform.badge.mic").font(.system(size: 11))
                Text(shadowLabel).font(.system(size: 11.5))
            }
        }
        .buttonStyle(.plain)
        .foregroundColor(palette.accent)
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

    /// 跟读按钮文案（对齐 SpeakView.tsx:1395-1405）：录音中「说完」/ 评分中 /
    /// 已出分「跟读 X 分 · 再跟读」/ 异常卡在场「跟读失败 · 重试」/ 缺省「跟读打分」。
    private var shadowLabel: String {
        switch controller.phase {
        case .shadowRecording: return "说完（跟读）"
        case .shadowAssessing: return "评分中…"
        default:
            if let total = lastShadowReport?.totals.last {
                return String(format: "跟读 %.1f 分 · 再跟读", total)
            }
            if controller.shadowFailure != nil {
                return "跟读失败 · 重试"
            }
            return "跟读打分"
        }
    }

    private var reviewButton: some View {
        Button {
            controller.stopSpeaking()
            reviewShown = true
        } label: {
            HStack(spacing: 4) {
                Circle().fill(palette.accent).frame(width: 5, height: 5)
                Text("结束本轮并复盘").font(.system(size: 11.5))
            }
        }
        .buttonStyle(.plain)
        .foregroundColor(hasAssessments && !drillOpen ? palette.accent : palette.textTertiary)
        .disabled(!hasAssessments || drillOpen)
        .help(hasAssessments
            ? "复盘本轮跟读中没掌握的词，确认后加入生词本"
            : "还没有跟读记录——先「跟读打分」一次再来复盘")
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

    // MARK: - 发音详情透镜卡（右侧常驻）

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

    private var pronunciationLens: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("发音详情").font(.system(size: 12.5, weight: .semibold))
                Spacer()
                Text("逐音标打分")
                    .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                    .foregroundColor(palette.accent)
            }
            Divider().opacity(0.6)
            if let pron = lastPron {
                lensSections(pron)
                    .onChange(of: pron.at) { newAt in
                        selectWorstWordIfNeeded(newAt: newAt)
                    }
                    .onAppear {
                        selectWorstWordIfNeeded(newAt: pron.at)
                    }
            } else {
                Text("点选单词查看发音细节")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundColor(palette.textSecondary)
                Text("还没有你的发音评分——说一句话（或配好讯飞评测凭据后再说一句），这里会给出逐词得分、逐音标拆解和慢速示范。")
                    .font(.system(size: 11))
                    .foregroundColor(palette.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: 8))
                Spacer()
            }
        }
        .padding(14)
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

    @ViewBuilder
    private func lensSections(_ pron: ShadowAttempt) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                // 总分 + 词着色句
                HStack {
                    Text("点选单词查看发音细节")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundColor(palette.textSecondary)
                    Spacer()
                    Text(String(format: "%.1f / 5.0", pron.total))
                        .font(.system(size: 11, weight: .semibold).monospacedDigit())
                        .foregroundColor(palette.accent)
                }
                pronMarkedSentence(pron)

                if let sel = pronSel, let word = pron.words[safe: sel.wordIdx] {
                    selectedWordSection(word, sel: sel)
                }

                // 逐词得分曲线
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("逐词得分对比")
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundColor(palette.textSecondary)
                        Spacer()
                        Text("虚线：5 分基准")
                            .font(.system(size: 9.5))
                            .foregroundColor(palette.textTertiary)
                    }
                    wordScoreChart(wordScorePath(pron.words), words: pron.words)
                    Text("连线是这一轮每个词的真实得分（点击圆点同步选中上方单词）")
                        .font(.system(size: 9.5))
                        .foregroundColor(palette.textTertiary)
                }
                .padding(9)
                .background(palette.surface, in: RoundedRectangle(cornerRadius: 8))
                Spacer(minLength: 0)
            }
        }
    }

    /// 词着色句（可点选同步透镜卡选词）。
    private func pronMarkedSentence(_ pron: ShadowAttempt) -> some View {
        let wordsXF = pron.words.map { $0.xfyunWordScore }
        let marks = mapWordsToText(text: lastPronText, words: wordsXF)
        return FlowLayout(lineSpacing: 4) {
            ForEach(Array(pronTokens(text: lastPronText, marks: marks, wordsXF: wordsXF).enumerated()), id: \.offset) { _, token in
                if let (mark, wordIdx) = token.markWithIndex {
                    Button {
                        pronSel = PronSelection(wordIdx: wordIdx, phoneIdx: 0)
                    } label: {
                        pronWordText(token.text, quality: mark.quality, selected: pronSel?.wordIdx == wordIdx)
                    }
                    .buttonStyle(.plain)
                    .help(mark.quality == .missed ? "漏读了" : String(format: "%.1f 分 · 点击看音标拆解", mark.score))
                } else {
                    Text(verbatim: token.text)
                        .font(.system(size: 13, design: .serif))
                        .foregroundColor(palette.text)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private struct PronToken {
        let text: String
        /// 词 token：命中的 mark + 在 pron.words 里的下标。
        let markWithIndex: (XfyunCore.WordMark, Int)?
    }

    /// 按 marks 的 start/end 切原句；词 token 通过 WordScore 等值回找 pron.words 下标
    /// （marks 与 pronWords 不一定一一对应：增读词被过滤、对不上原文的词被丢弃）。
    private func pronTokens(text: String, marks: [XfyunCore.WordMark], wordsXF: [WordScore]) -> [PronToken] {
        var out: [PronToken] = []
        let ns = text as NSString
        var pos = 0
        var usedIdx = Set<Int>()
        for m in marks {
            guard m.start >= pos, m.end <= ns.length, m.end > m.start else { continue }
            if m.start > pos {
                out.append(PronToken(text: ns.substring(with: NSRange(location: pos, length: m.start - pos)), markWithIndex: nil))
            }
            var wordIdx: Int?
            if let w = m.word, let idx = wordsXF.firstIndex(of: w), !usedIdx.contains(idx) {
                usedIdx.insert(idx)
                wordIdx = idx
            }
            out.append(PronToken(
                text: ns.substring(with: NSRange(location: m.start, length: m.end - m.start)),
                markWithIndex: wordIdx.map { (m, $0) }
            ))
            pos = m.end
        }
        if pos < ns.length {
            out.append(PronToken(text: ns.substring(from: pos), markWithIndex: nil))
        }
        return out
    }

    @ViewBuilder
    private func pronWordText(_ text: String, quality: XfyunCore.WordQuality, selected: Bool) -> some View {
        let color: Color = {
            switch quality {
            case .good: return palette.ok
            case .ok: return palette.warn
            case .bad, .missed: return palette.err
            }
        }()
        Text(verbatim: text)
            .font(.system(size: 13, weight: selected ? .semibold : .regular, design: .serif))
            .foregroundColor(color)
            .padding(.horizontal, 2)
            .padding(.vertical, 1)
            .background(
                RoundedRectangle(cornerRadius: 3)
                    .fill(selected ? color.opacity(0.14) : (quality == .missed ? palette.err.opacity(0.10) : Color.clear))
            )
            .overlay(alignment: .bottom) {
                if quality == .bad || quality == .missed {
                    Rectangle()
                        .stroke(palette.err.opacity(0.55), style: StrokeStyle(lineWidth: 1, dash: quality == .bad ? [2, 2] : []))
                        .frame(height: 1.5)
                        .offset(y: 1)
                }
            }
    }

    /// 选中词的音素药丸 + 舌位建议 + 慢速示范/重读。
    private func selectedWordSection(_ word: ShadowWord, sel: PronSelection) -> some View {
        let phones = word.sylls.flatMap(\.phones)
        let selPhone = phones[safe: sel.phoneIdx]
        return VStack(alignment: .leading, spacing: 7) {
            Text("音标拆解 · \(word.content)（\(String(format: "%.1f", word.totalScore)) 分）")
                .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                .foregroundColor(palette.textSecondary)
            if phones.isEmpty {
                Text("这个词没有返回音标明细")
                    .font(.system(size: 10.5))
                    .foregroundColor(palette.textTertiary)
            } else {
                FlowLayout(lineSpacing: 4) {
                    ForEach(Array(phones.enumerated()), id: \.offset) { idx, phone in
                        let active = idx == sel.phoneIdx
                        Button {
                            pronSel = PronSelection(wordIdx: sel.wordIdx, phoneIdx: idx)
                        } label: {
                            Text(verbatim: phone.content)
                                .font(.system(size: 12, design: .serif))
                                .foregroundColor(active ? .white : palette.textSecondary)
                                .padding(.horizontal, 9)
                                .padding(.vertical, 3.5)
                                .background(
                                    Capsule().fill(active ? palette.accent : palette.surface)
                                        .overlay(Capsule().strokeBorder(active ? palette.accent : palette.border))
                                )
                        }
                        .buttonStyle(.plain)
                        .help("音素 \(phone.content) — 点击看针对性建议")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Text("发音建议（/\(selPhone?.content ?? "")/）：")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(palette.text)
            Text(selPhone.map { phoneTip($0.content) } ?? "点上面的音素看针对性建议")
                .font(.system(size: 11))
                .foregroundColor(palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button {
                    controller.speakWordSlow(word.content)
                } label: {
                    Text("慢速示范 (0.75×)").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .help("按当前 TTS 引擎原生慢速合成示范：Edge 走 SSML prosody -25%、讯飞走 speed 38；系统语音或云不可用时按 0.75× 朗读")
                Button {
                    controller.speakWord(word.content)
                } label: {
                    Text("重读这个词")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .padding(9)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 8))
    }

    /// 逐词得分 SVG 折线（5 分基准虚线 + 点圆点同步选词）。
    private func wordScoreChart(_ path: ReaderCore.WordScorePath, words: [ShadowWord]) -> some View {
        ZStack(alignment: .topLeading) {
            // 基准虚线（5 分）
            Path { p in
                p.move(to: CGPoint(x: 12, y: path.baselineY))
                p.addLine(to: CGPoint(x: path.width - 12, y: path.baselineY))
            }
            .stroke(style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
            .foregroundColor(palette.border)
            // 得分折线
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

// MARK: - 声波舞台画布（.harmonic-stage-card 的 #harmonicCanvas）

/// TimelineView 驱动的三层谐波（teal / accent / indigo 三色、波长与相速各异，
/// 两端正弦包络收敛不撞边）：idle 低幅呼吸；录音 / 跟读振幅吃 controller.level
/// 真实麦克风电平；播报态跟 TTS 说话包络起伏。系统「减弱动态效果」开启时
/// 暂停时间轴，只画静态一帧（apple-design §14：减弱 ≠ 没有反馈）。
private struct HarmonicCanvas: View {
    let phase: SpeakViewController.Phase
    let level: Float
    @Environment(\.readerPalette) private var palette

    private var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    /// 目标振幅（0…1）。
    private func amplitude(at t: Double) -> Double {
        switch phase {
        case .recording, .shadowRecording:
            return 0.14 + Double(min(max(level, 0), 1)) * 0.82
        case .speaking:
            return 0.46 + 0.16 * sin(t * 2.6) + 0.08 * sin(t * 7.3)
        case .thinking, .transcribing, .shadowAssessing:
            return 0.18 + 0.06 * sin(t * 1.6)
        default:
            return 0.11 + 0.05 * sin(t * 0.9)
        }
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: reduceMotion)) { timeline in
            Canvas { ctx, size in
                let t = timeline.date.timeIntervalSinceReferenceDate
                let amp = amplitude(at: t)
                let midY = size.height / 2
                let swing = Double(size.height) * 0.30
                let layers: [(speed: Double, wave: Double, scale: Double, width: CGFloat, color: Color)] = [
                    (1.9, 88, 1.0, 2.2, palette.sonicTeal.opacity(0.55)),
                    (-1.3, 132, 0.66, 1.6, palette.accent.opacity(0.5)),
                    (3.1, 56, 0.4, 1.0, palette.clauseIndigo.opacity(0.35))
                ]
                for layer in layers {
                    var path = Path()
                    var x: CGFloat = 0
                    var first = true
                    while x <= size.width {
                        let u = Double(x / max(size.width, 1))
                        let envelope = sin(.pi * u)
                        let phaseArg = Double(x) / layer.wave + t * layer.speed
                        let y = midY + CGFloat(sin(phaseArg) * amp * envelope * swing * layer.scale)
                        let point = CGPoint(x: x, y: y)
                        if first {
                            path.move(to: point)
                            first = false
                        } else {
                            path.addLine(to: point)
                        }
                        x += 3
                    }
                    ctx.stroke(path, with: .color(layer.color), style: StrokeStyle(lineWidth: layer.width, lineCap: .round, lineJoin: .round))
                }
            }
        }
        .accessibilityHidden(true)
    }
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
