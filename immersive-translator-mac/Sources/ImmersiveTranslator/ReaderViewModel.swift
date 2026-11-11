import SwiftUI
import Combine
import ReaderCore

/// toast 行内动作按钮（朗读失败归因的「打开设置」等）。
struct ToastAction {
    let title: String
    let handler: () -> Void
}

/// 带入口语的语境意图（Windows PendingSpeak：book / vocab 两形态）。
/// 每次点击生成新 id；消费端按 id 去重（同一 intent 不重复开会）。
/// 过期规则（ReaderApp.tsx:530-543）：book 形态切文章即作废；vocab 形态
/// 离开口语页即清（一次性消费）。
struct PendingSpeakIntent: Equatable {
    enum Kind: Equatable {
        /// 阅读室句行「用这句练口语」：以该句为锚带本章语境。
        case book(articleId: String, sentenceIdx: Int)
        /// 手账/看板「去口语里用一次」：目标词提到队首的造句闯关。
        case vocab(wordId: String)
    }

    let id = UUID()
    let kind: Kind

    static func == (lhs: PendingSpeakIntent, rhs: PendingSpeakIntent) -> Bool {
        lhs.id == rhs.id && lhs.kind == rhs.kind
    }
}

/// 阅读室 LLM 通道的最小使用面（ReaderChatClient 被 vm 用到的 6 个成员）。
/// 抽成协议只为可注入：vm 级单测用替身通道（闸门控制在途请求、不碰 Keychain/网络），
/// 生产仍是 ReaderChatClient；行为与签名零变化。
protocol ReaderChatChannel: AnyObject {
    @MainActor var glossaryText: String { get }
    @MainActor var customStyle: String { get }
    @MainActor func configuration() throws -> ReaderChatClient.Configuration
    @MainActor func resolveTarget(for sample: String) -> String
    func complete(systemPrompt: String, userText: String) async throws -> String
    func completeStreaming(
        systemPrompt: String,
        userText: String,
        onDelta: @escaping (String) -> Void
    ) async throws -> String
}

extension ReaderChatClient: ReaderChatChannel {
    /// 协议见证：vm 只用非流式默认档（stream: false），与此前调用等价。
    func complete(systemPrompt: String, userText: String) async throws -> String {
        try await complete(systemPrompt: systemPrompt, userText: userText, stream: false)
    }
}

/// 沉浸阅读室组合根（ReaderApp.tsx 的 Mac 对应物）。
///
/// 职责：加载数据（文章/生词/设置）、驱动翻译管线（段级流式 + 单段重试 +
/// 手改译文）、词典栏、遮罩、复习入口与全部入口状态。落盘走 ReaderStore，
/// 文章保存带 700ms 防抖。
@MainActor
final class ReaderViewModel: ObservableObject {
    /// 阅读室内部路由。v0.8 起书架是首页（启动落 shelf，点书卡/短文进 reading）；
    /// 2026-10-26 改版对齐 Windows `ReaderApp.tsx:155`：原 review/notes 两值删除——
    /// 笔记与复习只有唯一的 `.vault` 容器，玩法档在 `VaultPlayMode` 上。
    /// 顶部导航岛三档由 `islandSurface` 归并高亮（shelf/reading→阅读、speak→口语、vault→笔记与复习）。
    enum Route: Equatable {
        case shelf
        case reading
        case speak
        case vault

        /// ReaderCore 的纯数据镜像（导航岛归并 / 面名计算走核心函数，可单测）。
        var kind: ReaderRouteKind {
            switch self {
            case .shelf: return .shelf
            case .reading: return .reading
            case .speak: return .speak
            case .vault: return .vault
            }
        }
    }

    /// 「笔记与复习」四态（2026-10-26 改版 VaultPage.tsx:75；原 tape/challenge/md 删除）：
    /// - home   复习首页（goReview 入口落此档）；
    /// - notes  全部笔记（goNotes 落此档；stage 内嵌笔记库）；
    /// - focus  专注复习（startFocusReview / Hero「开始复习」落此档）；
    /// - export 导出（首页「导出笔记」按钮落此档）。
    /// 跨视图进入保留上次档位；导航岛 / 底部快捷切换器只切档不清 focusIds。
    enum VaultPlayMode: String, Equatable, CaseIterable {
        case home
        case notes
        case focus
        case export

        /// 底部快捷切换器三档文案（复习首页 / 专注复习 / 导出；notes 不在切换器里，
        /// 由首页 seg「全部笔记」进入）。
        var switchLabel: String? {
            switch self {
            case .home: return "复习首页"
            case .notes: return nil
            case .focus: return "专注复习"
            case .export: return "导出"
            }
        }
    }

    /// 词典栏状态（DictPanelState）。
    enum DictPanel: Equatable {
        case closed
        case loading(query: String, sentenceIdx: Int)
        case ready(query: String, entry: ReaderDictEntry, sentenceIdx: Int)
        case notAWord(query: String, sentenceIdx: Int)
        case error(query: String, sentenceIdx: Int, message: String)
        /// 正文点词块下划线 → 即时卡（无 LLM 调用）。
        case chunkCard(chunk: SentenceChunk, sentenceIdx: Int)

        var isOpen: Bool { self != .closed }

        var query: String? {
            switch self {
            case .closed: return nil
            case .loading(let q, _), .ready(let q, _, _), .notAWord(let q, _), .error(let q, _, _):
                return q
            case .chunkCard(let chunk, _):
                return chunk.text
            }
        }

        var sentenceIdx: Int {
            switch self {
            case .closed: return 0
            case .loading(_, let i), .ready(_, _, let i), .notAWord(_, let i), .error(_, let i, _):
                return i
            case .chunkCard(_, let i):
                return i
            }
        }
    }

    struct StepProgress: Equatable {
        var done: Int
        var total: Int
    }

    /// 词块标注进度（翻译完成后按批跑）。
    struct ChunkProgress: Equatable {
        var done: Int
        var total: Int
    }

    /// 章末小结卡数据（本章查词/收录生词/到期词/用时 + 下一章）。
    /// collected/dueIds 口径 = 归属本章的全部生词（不区分本次阅读是否新增）。
    struct ChapterEndSummary: Equatable {
        let bookId: String
        let bookTitle: String
        let chapterIdx: Int
        let chapterCount: Int
        let lookups: Int
        let collected: Int
        /// 本章用时（会话起止累计，分钟）。
        let minutes: Int
        let nextChapterId: String?
        let nextChapterTitle: String?
        let lastChapter: Bool
        /// 本章生词 id（「整理本章笔记」预选用）。
        let wordIds: [String]
        /// 本章已到期的生词 id（「复习本章」只送这批进加练，不碰其他词的计划）。
        let dueIds: [String]
    }

    /// 短文结课条数据：自然播完末句或手动确认「读完本篇」时的本篇收获快照。
    struct ArticleFinishSummary: Equatable {
        let articleId: String
        let lookups: Int
        /// 本篇收录的词块和生词数。
        let collected: Int
        /// 其中已到期、可立即复习的数量。
        let dueCount: Int
        let wordIds: [String]
        let dueIds: [String]
    }

    // ---- 数据 ----
    @Published var globalSettings: ReaderSettings
    @Published var articleList: [ArticleSummary] = []
    /// 书架的书（索引与元信息，不含章正文；按最近阅读倒序）。
    @Published var bookList: [BookMeta] = []
    /// 书架读取失败态（port-11，对齐 Windows ad2ad68 三态的 error 半边；加载态在
    /// mac 结构性不存在——读盘同步，不做）：任一列表/生词读失败置位、读取成功清除，
    /// 书架页据此显示失败卡 +「重新读取」，不再把读失败冒充「没有内容」。
    @Published var shelfLoadError = false
    /// 带入口语的语境意图（SPEAK-14）。book 形态切文章即作废；vocab 形态
    /// 离开口语页即清；消费在 openSpeak（同一 intent 只开会一次）。
    @Published private(set) var pendingSpeak: PendingSpeakIntent?
    @Published var article: Article? {
        didSet {
            // 带入句过期清理：切到别的文章后旧 book 意图不再有效（消费前保证新鲜）。
            if let current = article,
               case .book(let articleId, _) = pendingSpeak?.kind,
               articleId != current.id {
                pendingSpeak = nil
            }
            // 随读抽查作答态随文章：槽位 id 是 `句号:起点`，换篇不清会把上一篇的印章
            // 错位盖到新篇同号句上（Windows 组件态随 ReadingView 卸载清空，语义等价）。
            if oldValue?.id != article?.id {
                clozeState = [:]
            }
        }
    }
    @Published var vocabWords: [VocabWord] = []
    @Published var reviewLog: ReviewLogFile = .empty
    @Published var route: Route = .shelf {
        didSet {
            // vocab 意图一次性消费：离开口语页即清（再次进口语不重开旧造句会话）。
            if route != .speak, case .vocab = pendingSpeak?.kind {
                pendingSpeak = nil
            }
            // 阅读设置浮层是阅读页组件态：离开阅读视图即收（Windows settingsOpen 随
            // ReadingView 卸载复位）。
            if route != .reading {
                readingSettingsPopShown = false
            }
        }
    }
    /// 「笔记与复习」当前档（四态容器；Windows 初始 home）。
    @Published var vaultPlayMode: VaultPlayMode = .home
    /// 导入弹窗初始 tab（书架发现三列 discover/feed/lib 直达；缺省文库）。
    /// 每次重开都以该值作初值生效（Windows importInitialTab 契约）。
    @Published var importInitialTab: ReaderImportTab = .lib
    /// 口语会话快照（手账口语改进行与 Markdown 导出的数据源；进 vault 时刷新）。
    @Published var speakSessions: [SpeakSession] = []
    /// 弹出式书架浮层（v0.8 FolioSheet）：由顶栏左上「书架 · 书名」触发；
    /// 选中书目 / 发起导入 / 切档位 / Esc / 外点都会收起，删除后保持打开。
    @Published var folioOpen = false
    /// 书架首页「查看目录」指定的书（nil = 回落当前文章所属书）。
    @Published var tocBookId: String?
    @Published var toast: String = ""
    /// toast 行内动作（与 toast 同生同灭；nil = 无按钮）。
    @Published var toastAction: ToastAction?
    /// 标题翻译失败原因（瞬态，不落盘；重启后只剩「标题翻译失败」无原因）。
    /// 对齐 ReaderApp.tsx:276 的 titleCnError React state。
    @Published var titleCnError: String?
    @Published var translating: StepProgress?
    @Published var chunking: ChunkProgress?
    @Published var dict: DictPanel = .closed
    @Published var searchMatchIdx: Int?
    @Published var activeSentenceIdx: Int = 0
    @Published var peekAll = false
    @Published var importSheetShown = false
    @Published var settingsDrawerShown = false
    /// 阅读页工具栏「阅读设置」浮层（ReadingView.tsx settingsOpen）：Windows 由 ReadingView
    /// 自己监听 Esc 关闭（:377-403 键位切分线）；Mac 走 vm 统一 Esc 链，放最上层。
    @Published var readingSettingsPopShown = false
    /// 播放引擎状态的镜像（PlayBar 绑定用）。
    @Published private(set) var playbackPlaying = false
    @Published private(set) var shadowingWait = false
    /// 书内目录弹层（书章文章才有内容；文章头「目录」按钮打开，点章即跳）。
    @Published var bookTocShown = false
    /// 章末小结卡（书章自然播完末句 / 手动「读完本章」后弹出）。
    @Published private(set) var chapterEnd: ChapterEndSummary?
    /// 短文结课条（自然播完或手动「读完本篇」后常驻底部，可关闭）。
    @Published private(set) var finishCard: ArticleFinishSummary?
    /// 今日已读秒数（每日阅读目标追踪，书架今日卡进度条用；recordReading 返回值镜像）。
    @Published private(set) var readSecondsToday: Double = 0

    // ---- v0.8 透镜卡（句子解析 / 查词 双 Tab）----

    /// 右栏透镜卡页签：解析请求/切回 xray；查词动作切 lex（DictColumn.tsx lensMode）。
    enum LensTab: Equatable {
        case xray
        case lex
    }

    /// 句子解析状态（会话内承载，不落盘：句子没变就不用重查）。
    struct XrayLensState: Equatable {
        enum Status: Equatable {
            case loading
            case error
            case ready
        }

        var status: Status
        var sentenceIdx: Int
        var data: SentenceXray?
    }

    @Published var lensTab: LensTab = .xray
    @Published var xray: XrayLensState?
    /// 透镜卡结构拆解悬停中的片段（优先级高于词块着色，回标正文原文）。
    @Published var hoveredClause: String?

    let store: ReaderStore
    private let chat: any ReaderChatChannel
    let playback = ReaderPlaybackEngine()
    private var cancellables = Set<AnyCancellable>()
    private var saveTask: Task<Void, Never>?
    private var bookSaveTask: Task<Void, Never>?
    private var translationTask: Task<Void, Never>?
    /// 单段重试任务（与主管线并发，各自持有引用便于分别取消）。
    private var retryTranslationTask: Task<Void, Never>?
    private var translationRunID = 0
    /// 429 退避等待注入点（单测用短值驱动真实等待路径）：nil = 生产常量
    /// ReaderCore.translateBackoffWaitMs（固定 20s）。
    var translateBackoffWaitMsOverride: Int?
    /// 主动限速间隔注入点（单测用短值）：nil = 生产常量
    /// ReaderCore.translatePacingIntervalMs（沉浸云 6.5s；0 = 关闭限速）。
    var translatePacingIntervalMsOverride: Int?
    private var toastTask: Task<Void, Never>?
    /// 阅读计时：本次打开这篇文章以来的累计秒数（章末小结「本章用时」用，
    /// 切章清零）与未落盘缓冲。
    private var sessionSeconds = 0
    private var readingSecondsBuffer = 0
    private var readingClock: AnyCancellable?
    /// 活跃判定（朗读播放中，或阅读窗为 key 且近 2 分钟有按键/翻句交互）。
    private var readingSession = ReadingSession()
    /// 阅读室窗口（ReaderWindowController 注入；活跃判定要用 isKeyWindow）。
    weak var attachedWindow: NSWindow?
    /// 打开的文章 id 集合里的源文缓存（复习卡回跳展示用）。
    var sourceCache: [String: Article] = [:]
    /// 学习空间基线（port-4 竞态防护）：VM 装载数据时所在的命名空间（bootstrap
    /// 落定）。auth 广播换算的命名空间与基线不同即整轮切换收口；nil = 尚未装载。
    private var authBaselineNamespace: String?
    /// 每篇文章的查词次数（读完统计用）。
    private var dictLookupCounts: [String: Int] = [:]
    /// 复习卡在到期队列中的位置（左栏词表可跳卡）。
    @Published var reviewPos: Int = 0
    /// 复习页键盘处理（由 ReviewView 注入，卡片内状态归它管）。
    var reviewKeyHandler: ((NSEvent) -> Bool)?
    /// 笔记加练队列（笔记复盘区「只测仍错的词」；nil = 普通到期队列）。
    @Published var focusReviewIds: [String]?
    /// 笔记库列表（按创建时间倒序）。
    @Published var notes: [NoteMeta] = []
    /// 当前打开的笔记文件名。
    @Published var activeNoteFile: String?
    /// 当前笔记解析结果（一页纸渲染用）。
    @Published var activeNote: (meta: NoteMeta, parsed: ParsedNote)?
    /// AI 复盘进行中。
    @Published var noteReplayBusy = false
    /// 生成复习笔记弹窗。
    @Published var noteDialogShown = false
    /// 生成弹窗的预选词条（笔记库「滚进新笔记」）。
    @Published var noteDialogPreselect: [String] = []
    /// 笔记存储（与 ReaderStore 同一应用支持目录下的 notes/；init 内按 store 的
    /// 学习存储接线）。
    let noteStore: NoteStore
    /// 跟读评测状态机（shadowingMode + shadowingAssess 时接管跟读等待）。
    let assess = ShadowAssessController()
    /// 差词训练控制器（报告卡「只练 N 个词」落点；UI 直观察它，不经 vm 转发）。
    let drill = ShadowDrillController()
    /// 「听我的录音」回放器（最近一次跟读录音，内存 PCM）。
    private let shadowPlayer = ShadowRecordingPlayer()
    private let leadSpeaker = LeadSpeaker()
    /// 口语陪练控制器（R3）。
    let speak = SpeakViewController()


    /// 生产入口（ReaderWindowController）：LLM 通道由 SettingsStore 驱动的 ReaderChatClient；
    /// accountTokenSource 注入后沉浸云下阅读室请求自动携带账号令牌（auth-1）。
    convenience init(
        settingsStore: SettingsStore,
        store: ReaderStore = .shared,
        accountTokenSource: PlatformAccountTokenSource? = nil
    ) {
        self.init(
            chat: ReaderChatClient(settingsStore: settingsStore, accountTokenSource: accountTokenSource),
            store: store
        )
    }

    /// 指定初始化器：注入 LLM 通道。单测用替身通道——`SettingsStore()` 初始化会读
    /// Keychain，xctest 不在钥匙串条目 ACL 上时会弹授权窗把测试挂死（R2-READ 实测），
    /// 所以 vm 级用例一律走这里，不碰 Keychain / 网络。
    init(chat: any ReaderChatChannel, store: ReaderStore = .shared) {
        self.store = store
        // 笔记与阅读域同一学习存储（接线后 .md 经 commit 派生 notes 实体、随账号
        // 命名空间切目录；单测注入的 ReaderStore 未接线 → 纯文件 IO）。
        self.noteStore = NoteStore(baseDirectory: store.baseDirectory, learning: store.learning)
        self.chat = chat
        self.globalSettings = store.loadGlobalReaderSettings()
        // 旧 xfyun → cloud 迁移（对齐 readerSettingsStore.ts:47-61：启动时判定一次，
        // 允许则旧值升格 cloud 并落盘）。判定探测（Keychain/登录态）只在应用运行时
        // 进行——xctest 无 AppDelegate，跳过探测即迁移不生效（纯谓词在 ReaderCoreTests）。
        // NSApp 是隐式解包可选值，xctest 进程里为 nil，必须可选链访问，否则直接崩。
        if (NSApp?.delegate as? AppDelegate) != nil {
            LegacyTtsMigration.allowed = LegacyTtsMigration.resolveAllowed(
                hasAnyXfyunCredential: { XfyunCredentialsStore.shared.hasAnyCredential },
                isLoggedIn: { AppAuthStatusCenter.shared.status?.loggedIn ?? false }
            )
            let before = globalSettings.ttsProvider
            Self.migrateLegacyTtsProviderInPlace(settings: &globalSettings)
            if globalSettings.ttsProvider != before {
                store.saveGlobalReaderSettings(globalSettings)
            }
        }

        playback.$playing
            .receive(on: RunLoop.main)
            .sink { [weak self] in self?.playbackPlaying = $0 }
            .store(in: &cancellables)
        playback.$shadowingWait
            .receive(on: RunLoop.main)
            .sink { [weak self] in self?.shadowingWait = $0 }
            .store(in: &cancellables)
        playback.onEvent = { [weak self] event in
            self?.handlePlaybackEvent(event)
        }
        // 跨窗刷新广播（对齐 Windows collectActions 的 emit）：浮窗/历史窗口
        // 「加入生词本」后刷新词表（refreshVocab 内部会刷复习角标），
        // 新文章落库后刷新书架。
        NotificationCenter.default.publisher(for: .readerVocabAdded)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.refreshVocab() }
            .store(in: &cancellables)
        // 快速复习窗评分落库后同样刷新词表（BUG-011）：评分改的是到期态，
        // 不在 .readerVocabAdded（新增/合并）语义内，单独广播、同一刷新动作。
        NotificationCenter.default.publisher(for: .readerReviewGraded)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.refreshVocab() }
            .store(in: &cancellables)
        NotificationCenter.default.publisher(for: .readerArticleAdded)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.refreshArticleList() }
            .store(in: &cancellables)
        // 学习接力：一轮同步完成（learning-sync-complete）后刷新词表/书架/书架书籍
        //（对齐 Windows ReaderApp 在 auth-state-changed 后 refresh 的观感——拉到的
        // 生词/文章/复习日志即时进场；书架书籍补进刷新，Windows relay 同样含书架）。
        // 命名空间交错无需专门代际：mac 读盘同步（发起与回写同在主线程），账号切换
        // 若先于此处到达，refresh 读到的已是新空间。
        NotificationCenter.default.publisher(for: .learningSyncComplete)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self else { return }
                self.refreshVocab()
                self.refreshArticleList()
                self.refreshBooks()
            }
            .store(in: &cancellables)
        // 学习空间/账号切换防护（port-4，对齐 Windows 1d31239）：userId 变化（含
        // 登出→guest、换号）即停播、清当前文章与内存数据、回书架，再按新命名空间
        // 重读列表；同一空间的重复广播（续登录/notice 变化）早退。基线在 bootstrap
        // 装载数据时落定（port-12：先等身份再装载）。
        AppAuthStatusCenter.shared.$status
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                self?.observeAuthIdentity(status)
            }
            .store(in: &cancellables)
        // 练习接力「回到原文这句」（Windows ReaderApp.tsx:1902 接 reader-relay-source）：
        // 原文已删（取到 null）→ 固定 toast；存在 → 跳阅读并定位 sentenceIdx；取文章
        // 本身抛错 → toast 错误原文（`.catch(error=>showToast(String(error)))`），不得
        // 冒充「原文已删除」。
        NotificationCenter.default.publisher(for: .readerRelaySource)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] note in
                guard let self,
                      let source = note.userInfo?["source"] as? [String: Any],
                      let articleId = source["articleId"] as? String else { return }
                self.openRelaySource(articleId: articleId, sentenceIdx: (source["sentenceIdx"] as? NSNumber)?.intValue ?? 0)
            }
            .store(in: &cancellables)
        // 兼容文件导出失败（learning-export-warning）：数据已入库，只提示可稍后重试。
        NotificationCenter.default.publisher(for: .learningExportWarning)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] note in
                guard let self, let message = note.userInfo?["message"] as? String else { return }
                self.showToast(message)
            }
            .store(in: &cancellables)
        // 每秒阅读计时：阅读路线且应用前台时累计（播放/静读都算），
        // 15s 批量并入章 Article.progress.secondsListened 与书级 secondsListened。
        readingClock = Timer.publish(every: 1, on: .main, in: .common)
            .autoconnect()
            .sink { [weak self] _ in self?.tickReadingSecond() }
        setupShadowAssess()
        setupSpeak()
    }

    // MARK: - 播放（M2）

    /// 口语陪练接线：LLM 通道复用阅读室的 chat 客户端。
    private func setupSpeak() {
        speak.chatProvider = { [weak self] system, input, onDelta in
            guard let self else {
                throw FileImportError("翻译服务不可用")
            }
            return try await self.chat.completeStreaming(systemPrompt: system, userText: input, onDelta: onDelta)
        }
    }

    /// 跟读评测接线：跟读等待出现时按设置接管，放行时复位。
    private func setupShadowAssess() {
        assess.textsProvider = { [weak self] in
            self?.article?.sentences.map(\.en) ?? []
        }
        assess.configProvider = { [weak self] in
            let s = self?.effectiveSettings
            return (
                s?.shadowingPassScore ?? 4.2,
                s?.shadowingAutoMic ?? true,
                s?.shadowingSilenceMs ?? 1500
            )
        }
        assess.leadProvider = { [weak self] text, done in
            guard let self else { return }
            // 领读与朗读同引擎：Edge/讯飞走云合成，本地走系统语音（对齐 Windows 领读走 speechEngine）。
            self.leadSpeaker.speak(
                text,
                rate: ShadowAssessController.leadRate,
                provider: self.effectiveSettings.ttsProvider,
                completion: done
            )
        }
        assess.stopLead = { [weak self] in
            self?.leadSpeaker.stop()
        }
        assess.onAdvance = { [weak self] in
            self?.playback.continueAfterShadowing()
        }
        // 差词训练接线：词发音走 word 音轨、提示走 toast、练完回整句立即重录
        //（对齐 Windows drillDone → startShadow）。
        drill.onSpeakWord = { [weak self] in self?.speakWord($0) }
        drill.onToast = { [weak self] in self?.showToast($0) }
        drill.onDone = { [weak self] in self?.assessRetry() }
        playback.$shadowingWait
            .dropFirst()
            .removeDuplicates()
            .sink { [weak self] waiting in
                guard let self else { return }
                let settings = self.effectiveSettings
                if waiting, settings.shadowingMode, settings.shadowingAssess {
                    self.assess.begin(idx: self.activeSentenceIdx)
                } else {
                    // 主评测复位（跳过/放行/切句/停止）时强制收词练抽屉（收麦），
                    // 避免抽屉在评测退出后残留可用录音。
                    self.drill.close()
                    self.assess.cancelAssess()
                }
            }
            .store(in: &cancellables)
        // 相位级转发：只服务 assessActive 门（PlayBar 切跟读 UI）与正文词着色
        //（ReaderBodyView 的 assessMarks——词着色随 failed 相位到达、随 retry 清除，
        // 都是相位跳变时刻）。不做全量转发：state 里的 level/elapsedMs 在录音期
        // ~23Hz 变化，全量转发会让阅读室全树以 23Hz 重渲（ReaderSentenceText 每次
        // updateNSView 重建整段 NSAttributedString）；高频变化由直观察控制器的
        // 叶子视图（评测条/报告卡/差词抽屉）就地消化。
        assess.$state
            .map(\.phase)
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
    }

    private func handlePlaybackEvent(_ event: ReaderPlaybackEngine.Event) {
        switch event {
        case .activeIdx(let idx):
            activeSentenceIdx = idx
        case .finished:
            // 「读完」统一落点（引擎只在连续朗读自然播完末句时发布）：
            // 书章 → 章末小结卡；短文 → 底部常驻结课条（替代原先一闪而过的 toast）。
            guard let current = article else { return }
            presentFinish(for: current)
        case .failed(let info):
            // 播放已停止：对齐 Windows「朗读失败，已停止：…」；缺凭据时附「打开设置」。
            showToast("朗读失败，已停止：\(info.message)", action: info.allowSettings ? Self.openSettingsToastAction : nil)
        case .cloudFallback(let info):
            // 云合成失败但已回落本地合成（朗读未断流）：把归因讲清楚。
            showToast("云朗读失败，已换系统朗读：\(info.message)", action: info.allowSettings ? Self.openSettingsToastAction : nil)
        case .gatewayEdgeFallback(let notice):
            // 网关守卫回落 / 配额耗尽转 Edge（ReaderApp.tsx:354-360 同语义；引擎侧已去重）。
            showToast(notice.message, action: notice.redeemAction ? Self.redeemQuotaToastAction : nil)
        case .gatewayFailure(let failure):
            // 网关朗读失败已停止：文案已按 Windows handleSpeechError 两分支拼好（不透传
            // 服务端原文）；仅 quota_exceeded 附「兑换更多额度」，其余无动作位。
            showToast(failure.message, action: failure.redeemAction ? Self.redeemQuotaToastAction : nil)
        }
    }

    /// 朗读归因 toast 的「打开设置」按钮：经 NSApp.delegate 调 AppDelegate 公开方法
    /// （ReaderWindowController 只持有 settingsStore，不持有设置窗引用，
    /// 仿 QuickReviewWindow → openReaderFromTouchpoint 先例）。
    private static let openSettingsToastAction = ToastAction(title: "打开设置") {
        (NSApp.delegate as? AppDelegate)?.openSettingsFromReader()
    }

    // MARK: - 读完落点（章末小结卡 / 短文结课条）

    /// 当前打开文章所属的书（书章模式；短文 nil）。目录弹层与章节栏用。
    var currentBook: BookMeta? {
        guard let bookId = article?.bookId else { return nil }
        return bookList.first { $0.id == bookId }
    }

    /// 目录弹层要展示的书：书架首页「查看目录」指定的那本优先，否则当前文章所属书。
    var tocBook: BookMeta? {
        if let tocBookId, let book = bookList.first(where: { $0.id == tocBookId }) {
            return book
        }
        return currentBook
    }

    /// 书架首页「查看目录」：不必先打开这本书的章就能看目录（对齐 Windows onOpenBookToc）。
    func openBookToc(bookId: String) {
        tocBookId = bookId
        bookTocShown = true
    }

    /// 正文末「读完本章/读完本篇」按钮（纯手动阅读路径）：光标到末句且没在
    /// 播放/跟读等待、也没有已弹的卡时出现，确认后撤下（中途滚过末句不算读完）。
    var showFinishAction: Bool {
        guard route == .reading, let a = article, !a.sentences.isEmpty else { return false }
        return activeSentenceIdx >= a.sentences.count - 1
            && !playbackPlaying
            && !shadowingWait
            && chapterEnd == nil
            && finishCard == nil
    }

    var finishActionLabel: String { article?.bookId != nil ? "读完本章" : "读完本篇" }

    /// 「读完」统一落点（自然播完末句 / 手动点按钮）：书章 → 章末小结卡，短文 → 结课条。
    func presentFinish(for current: Article) {
        if current.bookId != nil {
            showChapterEnd(for: current)
        } else {
            showFinishCard(for: current)
        }
    }

    func confirmFinishRead() {
        guard let current = article else { return }
        presentFinish(for: current)
    }

    /// 章末小结卡：本章查词/收录生词/到期词/用时 + 下一章入口。
    private func showChapterEnd(for a: Article) {
        flushReadingSeconds()
        guard let book = bookList.first(where: { $0.id == a.bookId }) else { return }
        let chapterIdx = a.chapterIdx ?? bookChapterIndexOf(book: book, chapterId: a.id)
        let next = book.chapters[safe: chapterIdx + 1]
        let words = vocabWords.filter { $0.source.articleId == a.id }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let due = words.filter { isDue($0, now: now) }
        chapterEnd = ChapterEndSummary(
            bookId: book.id,
            bookTitle: book.title,
            chapterIdx: chapterIdx,
            chapterCount: book.chapters.count,
            lookups: dictLookupCounts[a.id] ?? 0,
            collected: words.count,
            minutes: Int((Double(sessionSeconds) / 60).rounded()),
            nextChapterId: next?.id,
            nextChapterTitle: next?.title,
            lastChapter: next == nil,
            wordIds: words.map(\.id),
            dueIds: due.map(\.id)
        )
        // 本地埋点：章末小结卡弹出（自然播完与手动「读完本章」的统一落点；
        // 对齐 Windows chapter_complete，secondsRead 为本次打开文章以来的累计秒）。
        ReaderTelemetry.track(.chapterComplete(
            bookId: book.id,
            chapterIdx: chapterIdx,
            lookedUpCount: dictLookupCounts[a.id] ?? 0,
            collectedCount: words.count,
            dueCount: due.count,
            secondsRead: sessionSeconds
        ))
    }

    /// 短文结课条：本篇收获快照 + 笔记/复习入口（替代原先一闪而过的 toast）。
    private func showFinishCard(for a: Article) {
        flushReadingSeconds()
        let words = vocabWords.filter { $0.source.articleId == a.id }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let due = words.filter { isDue($0, now: now) }
        finishCard = ArticleFinishSummary(
            articleId: a.id,
            lookups: dictLookupCounts[a.id] ?? 0,
            collected: words.count,
            dueCount: due.count,
            wordIds: words.map(\.id),
            dueIds: due.map(\.id)
        )
        // 本地埋点：短文结课条弹出（对齐 Windows article_finish）。
        ReaderTelemetry.track(.articleFinish(
            articleId: a.id,
            lookedUpCount: dictLookupCounts[a.id] ?? 0,
            collectedCount: words.count,
            dueCount: due.count
        ))
    }

    func dismissChapterEnd() {
        chapterEnd = nil
    }

    func dismissFinishCard() {
        finishCard = nil
    }

    /// 小结卡「开始下一章」。
    func openNextChapter() {
        guard let next = chapterEnd?.nextChapterId else { return }
        chapterEnd = nil
        openArticle(id: next)
    }

    /// 小结卡「复习本章」：只把这批已到期词送进加练队列，不打乱其他词的复习计划。
    func reviewChapterWords() {
        guard let ids = chapterEnd?.dueIds, !ids.isEmpty else { return }
        chapterEnd = nil
        startFocusReview(ids: ids)
    }

    /// 小结卡「整理本章笔记」：本章词预选进复习笔记生成弹窗。
    func noteChapterWords() {
        guard let ids = chapterEnd?.wordIds, !ids.isEmpty else { return }
        chapterEnd = nil
        openNoteDialog(preselect: ids)
    }

    /// 结课条「复习本篇」。
    func reviewFinishCardWords() {
        guard let ids = finishCard?.dueIds, !ids.isEmpty else { return }
        finishCard = nil
        startFocusReview(ids: ids)
    }

    /// 结课条「整理本篇复习笔记」。
    func noteFinishCardWords() {
        guard let ids = finishCard?.wordIds, !ids.isEmpty else { return }
        finishCard = nil
        openNoteDialog(preselect: ids)
    }

    // MARK: - 阅读计时

    /// 每秒计时：阅读路线且有文章，且处于活跃阅读（朗读播放中，或阅读窗为 key
    /// 且近 2 分钟有按键/翻句交互）时累计；每 15s 批量落盘。
    private func tickReadingSecond() {
        guard route == .reading, article != nil else { return }
        guard readingSession.isCounting(
            playbackPlaying: playbackPlaying,
            windowIsKey: attachedWindow?.isKeyWindow ?? false,
            now: Date.timeIntervalSinceReferenceDate
        ) else { return }
        sessionSeconds += 1
        readingSecondsBuffer += 1
        guard readingSecondsBuffer >= 15 else { return }
        flushReadingSeconds()
    }

    /// 把缓冲秒数同步落盘（不走 700ms 防抖：切章/收尾时这段时长不丢）。
    /// 章内秒数/书级秒数之外，同时并入每日阅读时长 readingLog（对齐 Windows
    /// 每 ~15s 上报 reader_record_reading，朗读播放与停留阅读均计入）。
    private func flushReadingSeconds() {
        guard readingSecondsBuffer > 0, var current = article else { return }
        let seconds = Double(readingSecondsBuffer)
        readingSecondsBuffer = 0
        current.progress.secondsListened += seconds
        article = current
        sourceCache[current.id] = current
        _ = try? store.saveArticle(current)
        if current.bookId != nil {
            scheduleBookMetaSave { meta in
                var next = meta
                next.secondsListened += seconds
                return next
            }
        }
        if let total = try? store.recordReading(day: dayKey(nowMs: Int64(Date().timeIntervalSince1970 * 1000)), seconds: seconds) {
            readSecondsToday = total
            // 本地埋点：阅读时长（Windows telemetry.ts 注释声明了 reading_minutes 但无调用点，
            // mac 在 15s 批量落盘点顺手补齐；seconds 为本批秒数）。
            ReaderTelemetry.track(.readingMinutes(seconds: Int(seconds)))
        }
    }

    /// 切章/清场前收口：未落盘秒数先写库，会话计时清零。
    private func settleReadingSeconds() {
        flushReadingSeconds()
        sessionSeconds = 0
    }

    /// 当前文章句文与播放设置同步给引擎。
    private func syncPlaybackContext() {
        let settings = effectiveSettings
        XfyunTtsEngine.shared.updateVoiceConfig(XfyunTtsEngine.VoiceConfig(
            vcnCn: settings.cloudVoice,
            vcnEn: settings.cloudVoiceEn
        ))
        EdgeTtsEngine.shared.updateVoiceConfig(EdgeTtsEngine.VoiceConfig(
            voiceZh: settings.edgeVoiceZh,
            voiceEn: settings.edgeVoiceEn
        ))
        playback.updateContext(
            texts: article?.sentences.map(\.en) ?? [],
            settings: ReaderPlaybackEngine.Settings(
                rate: settings.rate,
                voice: settings.voice,
                sentencePauseMs: settings.sentencePauseMs,
                shadowingMode: settings.shadowingMode,
                ttsProvider: settings.ttsProvider,
                cloudVoice: settings.cloudVoice,
                cloudVoiceEn: settings.cloudVoiceEn
            )
        )
    }

    func togglePlayback() {
        playback.toggle()
    }

    func continueAfterShadowing() {
        playback.continueAfterShadowing()
    }

    // MARK: - 跟读评测（转发给 AssessStrip）

    /// 评测是否接管跟读等待（PlayBar 决定显示哪个跟读 UI）。
    var assessActive: Bool {
        effectiveSettings.shadowingAssess && assess.state.phase != .idle
    }

    func assessOpenMic() { assess.openMic() }
    func assessRetry() { assess.retry() }
    func assessLead() { assess.lead() }
    func assessSkip() { assess.skip() }
    /// 手动「说完」：结束录音送评测（静音 VAD 之外的路）。
    func assessFinishManually() { assess.finishManually() }

    /// 报告卡切句与差词训练的底本（单一出处，ShadowMarkedSentence 与
    /// shadowDrillEntries 一律用它，不各算各的）。**必须带 .en**：marks 的
    /// start/end 是对 textsProvider 字符串（= article?.sentences.map(\.en)，
    /// 对齐发生在 ShadowAssessController 取句与 mapWordsToText）的 UTF-16 偏移，
    /// 取 zh 或整 pair 都会错位。
    var assessTargetSentence: String? {
        assess.state.sentenceIdx.flatMap { article?.sentences[safe: $0]?.en }
    }

    /// 报告卡「🎯 只练 N 个词」：bad+missed 词按出现序前 4 个进抽屉。
    func openDrillFromCard() {
        guard let target = assessTargetSentence else { return }
        drill.open(entries: shadowDrillEntries(target: target, marks: assess.state.marks))
    }

    /// 点词弹层「🎯 练这个词」：该词（lowercase 匹配）提到队首。
    func openDrill(preferring word: String) {
        guard let target = assessTargetSentence else { return }
        drill.open(entries: shadowDrillEntries(target: target, marks: assess.state.marks), preferring: word)
    }

    /// 「▶ 听我的录音」：回放最近一次跟读的录音（含被拒结果的留存）。
    func playAssessRecording() {
        guard let pcm = assess.lastAttemptPcm else { return }
        shadowPlayer.play(pcm)
    }

    func stopPlayback() {
        playback.stop()
    }

    /// 朗读某一句（播放条喇叭按钮 / 中文行定位）。
    func speakSentence(_ idx: Int) {
        jumpTo(idx: idx, autoplay: true)
    }

    /// 折叠卡「朗读本句」：读完自动停，不连读（Windows once 语义）；
    /// 播放中点当前句 = 停止朗读（ReadingView.tsx:299 speakButton 同一套切换）。
    func speakSentenceOnce(_ idx: Int) {
        if playback.playing && idx == activeSentenceIdx {
            stopPlayback()
        } else {
            jumpTo(idx: idx, autoplay: true, once: true)
        }
    }

    /// 单词/词块发音（独立音轨，不打断句子朗读）。
    func speakWord(_ text: String) {
        playback.speakWord(text)
    }

    /// 听写卡整句朗读：word 音轨 + 稍慢语速，与句子朗读互不打断。
    func speakRecallSentence(_ text: String) {
        playback.speakWord(text, rate: 0.92)
    }

    /// 生词本归一化 id 集（生词再现标记用）。
    var knownIds: Set<String> { Set(vocabWords.map(\.id)) }

    var effectiveSettings: ReaderSettings {
        let merged = mergeReaderSettings(globalSettings, article?.settings)
        // 文章级旧 xfyun 覆盖同样过迁移（ReaderApp.tsx:394-398：mergeReaderSettings
        // + 迁移谓词；不满足迁移条件保留旧「缺凭据→本地回落」语义，不串 Edge）。
        var settings = merged
        Self.migrateLegacyTtsProviderInPlace(settings: &settings)
        return settings
    }

    /// 旧 xfyun → cloud 迁移的落值步骤（纯函数；迁移允许标志为 App 启动判定）。
    static func migrateLegacyTtsProviderInPlace(settings: inout ReaderSettings) {
        settings.ttsProvider = migrateLegacyTtsProviderValue(
            settings.ttsProvider,
            migrationAllowed: LegacyTtsMigration.allowed
        )
    }

    var stats: ReviewStats {
        reviewStats(vocabWords, reviewLog, nowMs: Int64(Date().timeIntervalSince1970 * 1000))
    }

    var dueWords: [VocabWord] {
        dueVocab(vocabWords, now: Int64(Date().timeIntervalSince1970 * 1000))
    }

    // MARK: - 启动加载

    /// 首次打开窗口：加载数据后默认落在整页书架（书架是首页，对齐 Windows
    /// ReaderApp.tsx:206 / 1148）；只有外部推入——热键导入 / 托盘「生词本」/
    /// 提醒卡「继续阅读」——才直接进对应视图。
    /// port-12（对齐 Windows ad2ad68 的 auth_get_status 身份屏障）：装载前先等
    /// 一次身份解析（已解析立即返回）——已登录用户启动不再先读 guest 目录；
    /// 装载完成即落学习空间基线（port-4 切换收口的比对基准）。
    func bootstrap(pendingImportText: String? = nil, openReview: Bool = false, openBookId: String? = nil) async {
        await waitForAuthIdentity()
        globalSettings = store.loadGlobalReaderSettings()
        refreshVocab()
        refreshBooks()
        refreshNotes()  // 「笔记与复习」角标（到期 + 未整理）启动即准
        refreshArticleList()
        authBaselineNamespace = store.learning?.currentNamespace()
        if let text = pendingImportText, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            importPaste(text)
            return
        }
        if openReview {
            self.openReview()  // 参数名遮蔽了同名方法，显式 self
            return
        }
        if let openBookId {
            // 提醒卡「继续阅读」：直达书级断点章。
            openBookAt(bookId: openBookId)
            return
        }
        openShelf()
    }

    /// 身份屏障（port-12；auth_get_status 语义的 Mac 等价物——README 口径：mac
    /// 无该命令，用 ServerAuth 广播快照）：ServerAuthClient.bootstrap 的预填分诊
    /// 完成（已登录广播 / 确认未登录也广播）即有值，等待立即解除；已有值立即返回。
    /// 广播前 setAccount 已生效（ServerAuthClient.publish 顺序），随后读列表读到
    /// 的就是正确命名空间。
    private func waitForAuthIdentity() async {
        if AppAuthStatusCenter.shared.status != nil { return }
        _ = await AppAuthStatusCenter.shared.$status.values.first { $0 != nil }
    }

    /// 上次打开过的内容（书架为空时 nil）：短文按最近阅读倒序取首篇，否则最近读的书。
    /// 点导航岛「阅读」而当前没有打开的文章时用它续读，而不是让人面对空页。
    private func openMostRecentIfAny() -> Bool {
        if let first = articleList.first {
            openArticle(id: first.id)
            return true
        }
        if let book = bookList.first {
            openBookAt(bookId: book.id)
            return true
        }
        return false
    }

    func refreshVocab() {
        do {
            let file = try store.getVocabFile()
            vocabWords = file.words
            reviewLog = file.reviewLog
            readSecondsToday = readingSeconds(
                in: file.readingLog ?? [],
                day: dayKey(nowMs: Int64(Date().timeIntervalSince1970 * 1000))
            )
            loadSourceArticles(ids: file.words.map(\.source.articleId))
            ReviewTouchpointManager.shared.refreshBadge()
            shelfLoadError = false
        } catch {
            // 读失败不再冒充「没有内容」：置错误态供书架页显示失败卡（port-11 对齐
            // Windows ad2ad68 三态的 error 半边；已加载的生词保留不清空）。
            shelfLoadError = true
        }
    }

    // MARK: - 文章打开 / 列表

    func refreshArticleList() {
        do {
            articleList = try store.listArticles()
            shelfLoadError = false
        } catch {
            // 读失败不冒充空书架：置错误态（port-11，对齐 Windows ad2ad68）。
            articleList = []
            shelfLoadError = true
        }
    }

    func refreshBooks() {
        do {
            bookList = try store.listBooks()
            shelfLoadError = false
        } catch {
            bookList = []
            shelfLoadError = true
        }
    }

    /// 书架失败卡的「重新读取」：重跑三路刷新（对齐 Windows ad2ad68 重新读取按钮）。
    func retryShelfLoad() {
        refreshArticleList()
        refreshBooks()
        refreshVocab()
    }

    // MARK: - 学习空间切换（port-4，对齐 Windows 1d31239 auth 变化防护）

    /// auth 广播 → 学习空间判定：命名空间与基线不同（登出→guest、换号、登录）即
    /// 整轮切换收口；同一空间的重复广播（续登录/notice 变化）与首次广播早退——
    /// 基线由 bootstrap 装载数据时落定，首次广播的命名空间若与基线一致就只是确认。
    private func observeAuthIdentity(_ status: AuthStatus?) {
        guard let status else { return }  // 尚无广播：基线等 bootstrap 落定
        let namespace = (status.user?.id).map(LearningStore.accountNamespace) ?? "guest"
        guard namespace != authBaselineNamespace else { return }
        let firstBaseline = authBaselineNamespace == nil
        authBaselineNamespace = namespace
        guard !firstBaseline else { return }
        adoptLearningSpace()
    }

    /// 学习空间切换收口：停播、掐掉在途翻译与防抖落盘、清当前文章与内存数据、
    /// 回书架，再按新命名空间重读三路列表。否则登出/换号后阅读室仍显示上一账号
    /// 的文章/书/生词直到重启（Windows 1d31239 修复的 Mac 对应缺陷）。
    private func adoptLearningSpace() {
        clearOpenArticle()      // 含 invalidateTranslationRun + 停播复位
        saveTask?.cancel()
        bookSaveTask?.cancel()
        articleList = []
        bookList = []
        vocabWords = []
        reviewLog = .empty
        notes = []
        activeNoteFile = nil
        activeNote = nil
        openShelf()
        refreshVocab()
        refreshArticleList()
        refreshBooks()
        refreshNotes()
    }

    /// 打开文章。取不到（换号后学习空间变化 / 已被删除）不再静默返回：给可操作
    /// toast 并刷新双列表，返回 false 供跳句方判定失败不跳（对齐 Windows
    /// 1d31239 openArticle 的「当前学习空间找不到这篇内容…」+ refresh 双列表）。
    @discardableResult
    func openArticle(id: String) -> Bool {
        guard let full = (try? store.getArticle(id: id)) ?? nil else {
            showToast("当前学习空间找不到这篇内容，请确认账号或重新导入。")
            refreshArticleList()
            refreshBooks()
            return false
        }
        settleReadingSeconds()  // 上一章的未落盘秒数先写库；本章用时重新累计
        invalidateTranslationRun()
        route = .reading
        folioOpen = false   // 选中书目即收起书架浮层
        tocBookId = nil     // 目录弹层回落到当前文章所属书
        dict = .closed
        searchMatchIdx = nil
        bookTocShown = false
        chapterEnd = nil
        finishCard = nil
        // 透镜卡整卡复位：切文章后旧解析/悬停回标不再有效（结果不落盘）。
        xray = nil
        hoveredClause = nil
        lensTab = .xray
        article = full
        activeSentenceIdx = min(full.progress.sentenceIdx, max(0, full.sentences.count - 1))
        sourceCache[full.id] = full
        playback.reset(startIdx: activeSentenceIdx)
        syncPlaybackContext()
        scheduleSave(mutate: { $0.lastReadAt = Int64(Date().timeIntervalSince1970 * 1000) })
        if let bookId = full.bookId {
            // 书章打开即记最近阅读（书卡排序依据）。
            scheduleBookMetaSave { meta in
                var next = meta
                next.lastReadAt = Int64(Date().timeIntervalSince1970 * 1000)
                return next
            }
            // 本地埋点：打开书章文章（对齐 Windows 只对书章埋 book_open，短文不埋）。
            ReaderTelemetry.track(.bookOpen(
                bookId: bookId,
                chapterIdx: full.chapterIdx ?? 0,
                sentenceIdx: full.progress.sentenceIdx
            ))
        }
        // 登录恢复自愈（2026-11-05 实测）：登出期间导入/翻译的文章会把整段 401
        // 失败态连同 zhError 一起持久化，而管线只认领 pending——登录成功后这些
        // 段永远停在错误下划线里，整页看起来像样式坏掉。打开文章时若账号已登录，
        // 把登录态类失败（新旧两版 401 文案）复活回 pending 交给管线补翻；第三方
        // Key 的 401 属配置错误、限流/服务不可用属临时态，均保持 Windows 的
        // 手动重试语义，不在此复活。
        if AppAuthStatusCenter.shared.status?.loggedIn == true {
            scheduleSave { a in
                a.sentences = a.sentences.map { st in
                    guard st.zhState == .failed,
                          let error = st.zhError,
                          error.hasPrefix("翻译接口返回 401") || error.hasPrefix("登录状态已失效")
                    else { return st }
                    var next = st
                    next.zh = nil
                    next.zhState = .pending
                    next.zhError = nil
                    return next
                }
            }
        }
        runTranslationPipeline(for: full.id)
        return true
    }

    /// 删短文：删的是当前打开的那篇 → 清空阅读态并回整页书架（对齐 Windows
    /// ReaderApp.tsx:1282-1287 goShelf），不替用户自动翻到另一篇；书架浮层保持打开。
    func deleteArticle(id: String) {
        _ = try? store.deleteArticle(id: id)
        refreshArticleList()
        refreshVocab()
        if article?.id == id {
            clearOpenArticle()
            openShelf(keepFolio: true)
        }
        showToast("文章已删除")
    }

    /// 关闭当前文章的阅读态（删文/删书共用）：停播、清光标、关联弹层一并收起。
    private func clearOpenArticle() {
        invalidateTranslationRun()
        bookTocShown = false
        tocBookId = nil
        chapterEnd = nil
        finishCard = nil
        dict = .closed
        searchMatchIdx = nil
        xray = nil
        hoveredClause = nil
        lensTab = .xray
        article = nil
        activeSentenceIdx = 0
        playback.reset(startIdx: 0)
        syncPlaybackContext()
    }

    // MARK: - 整本书（书卡 / 断点直达 / 删书）

    /// 书卡/导入后进书：直达书级断点章（断点章缺失时回落第一章）。书缺失/无章节
    /// 不再静默返回，分别给可操作文案（对齐 Windows 1d31239 openBookAtBreakpoint）。
    func openBookAt(bookId: String) {
        guard let book = bookList.first(where: { $0.id == bookId }) else {
            showToast("书架内容已更新，请重新选择书籍。")
            return
        }
        guard !book.chapters.isEmpty else {
            showToast("这本书没有可阅读的章节，请重新导入。")
            return
        }
        let target = book.chapters.contains { $0.id == book.progress.chapterId }
            ? book.progress.chapterId
            : book.chapters[0].id
        openArticle(id: target)
    }

    /// 整本入库（EPUB/长书 tab 确认导入）：章文本 → 章 Article（sourceType="epub"）。
    func importBook(_ draft: BookImportDraft) {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let bookId = newBookId(now: now)
        var chapters: [Article] = []
        var metas: [BookChapterMeta] = []
        for (idx, ch) in draft.chapters.enumerated() {
            guard var built = buildArticleFromText(ch.text, options: BuildArticleOptions(
                sourceType: .epub,
                now: now + Int64(idx),
                title: ch.title
            )) else { continue }
            built.bookId = bookId
            built.chapterIdx = metas.count
            chapters.append(built)
            metas.append(BookChapterMeta(
                id: built.id,
                title: built.title,
                wordCount: built.wordCount,
                sentenceCount: built.sentences.count
            ))
        }
        guard !metas.isEmpty else {
            showToast("没有可导入的章节内容")
            return
        }
        let meta = BookMeta(
            id: bookId,
            title: draft.title,
            author: draft.author,
            cover: draft.cover,
            createdAt: now,
            lastReadAt: now,
            chapters: metas,
            progress: BookProgress(chapterId: metas[0].id),
            secondsListened: 0,
            radar: draft.radar
        )
        do {
            bookList = try store.saveBook(meta: meta, articles: chapters)
            refreshArticleList()
            showToast("已导入《\(draft.title)》· \(metas.count) 章")
            // 发现页下载入库成功才埋 discover_import（本地导入草稿无 sourceBookId 不埋；
            // 对齐 Windows ReaderApp.tsx:1536-1538 入库 toast 之后的 discoverImportProps 分流）。
            if let props = discoverImportProps(draft), let bookId = props["bookId"] {
                ReaderTelemetry.track(.discoverImport(bookId: bookId))
            }
            openArticle(id: metas[0].id)
        } catch {
            showToast("导入书籍失败：\((error as? LocalizedError)?.errorDescription ?? "\(error)")")
        }
    }

    /// 删除书 = 删书卡与全部章文章（进度不可恢复），生词一律保留。
    /// 删的是正在读的书 → 回整页书架（与删短文同口径）。
    func deleteBook(bookId: String) {
        let removed = (try? store.deleteBook(bookId: bookId)) ?? false
        guard removed else { return }
        refreshBooks()
        refreshArticleList()
        refreshVocab()
        if tocBookId == bookId {
            tocBookId = nil
            bookTocShown = false
        }
        if article?.bookId == bookId {
            clearOpenArticle()
            openShelf(keepFolio: true)
        }
        showToast("这本书已删除（生词保留）")
    }

    /// 书章 id → 「《书名》·第 N 章」（复习卡/生词来源展示；短文回落标题）。
    func bookChapterLabel(articleId: String) -> String? {
        guard let book = bookList.first(where: { $0.chapters.contains { $0.id == articleId } }) else {
            return nil
        }
        let idx = bookChapterIndexOf(book: book, chapterId: articleId)
        return "《\(book.title)》·第 \(idx + 1) 章"
    }

    // MARK: - 导入

    func importPaste(_ text: String, title: String? = nil) {
        importText(text, title: title, meta: ImportMeta())
    }

    /// 内容进水口统一导入入口（文库 / 文件 / URL / 粘贴四入口共用）。
    func importText(_ text: String, title: String? = nil, meta: ImportMeta = ImportMeta()) {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let explicitTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let explicitCn = meta.titleCn?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let built = buildArticleFromText(text, options: BuildArticleOptions(
            sourceType: meta.sourceType ?? .paste,
            sourceUrl: meta.sourceUrl,
            now: now,
            title: (explicitTitle?.isEmpty ?? true) ? nil : explicitTitle,
            titleCn: (explicitCn?.isEmpty ?? true) ? nil : explicitCn,
            level: meta.level
        )) else {
            showToast("没有识别到正文内容")
            return
        }
        do {
            _ = try store.saveArticle(built)
            refreshArticleList()
            openArticle(id: built.id)
            // 广播新文章（「送到阅读室」等入口建文后，其他阅读室界面刷新书架）。
            NotificationCenter.default.post(
                name: .readerArticleAdded,
                object: nil,
                userInfo: ["articleId": built.id]
            )
            showToast("已导入「\(built.title)」")
        } catch {
            showToast("导入失败：\((error as? LocalizedError)?.errorDescription ?? "\(error)")")
        }
    }

    /// 生成书 id：b + 时间戳 base36 + 随机段（对齐 Windows ReaderApp.importBook）。
    private func newBookId(now: Int64) -> String {
        let digits = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        var value = UInt64(max(0, now))
        var timePart = ""
        repeat {
            timePart.insert(digits[Int(value % 36)], at: timePart.startIndex)
            value /= 36
        } while value > 0
        let rand = String(format: "%06x", Int.random(in: 0..<0x1000000)).prefix(6)
        return "b" + timePart + rand
    }

    // MARK: - 文章落盘（防抖）

    /// 原地修改当前文章并触发防抖保存。
    func scheduleSave(mutate: (inout Article) -> Void) {
        guard var current = article else { return }
        mutate(&current)
        article = current
        sourceCache[current.id] = current
        saveTask?.cancel()
        let id = current.id
        // 学习空间代数守卫（port-4）：防抖落盘可能晚于账号切换，发起时的命名空间
        // 与写入时不一致即丢弃——旧空间的正文不得回写进新空间（对齐 Windows
        // 1d31239 的 seq 代际语义；列表读同步无需逐点 seq，防抖落盘是唯一跨命名窗口）。
        let namespace = store.learning?.currentNamespace()
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard !Task.isCancelled, let self else { return }
            if self.store.learning?.currentNamespace() != namespace { return }
            if let latest = self.article, latest.id == id, let summary = try? self.store.saveArticle(latest) {
                self.articleList = self.articleList
                    .filter { $0.id != summary.id }
                    .inserting(summary, at: 0)
                    .sorted { $0.article.lastReadAt > $1.article.lastReadAt }
            }
        }
    }

    // MARK: - 设置（全局 + 文章覆盖）

    func patchSettings(_ mutate: (inout ReaderSettings) -> Void) {
        let old = globalSettings
        var updated = old
        mutate(&updated)
        clampReaderSettings(&updated)
        globalSettings = updated
        store.saveGlobalReaderSettings(updated)
        syncPlaybackContext()
        // 复习模式只进全局默认，不写文章覆盖。
        var patch = readerSettingsPatch(from: old, to: updated)
        patch.removeValue(forKey: "reviewMode")
        if !patch.isEmpty, article != nil {
            scheduleSave { article in
                var override = article.settings ?? ReaderSettingsOverride()
                override.apply(patch: patch)
                article.settings = override
            }
        }
        // 词块开关从关到开：当前文章立刻补标（scheduleSave 已同步 article）。
        if patch["chunkHighlight"] as? Bool == true, article?.chunkState != .done {
            ensureAnnotated()
        }
    }

    /// 退出禅模式（QA BUG-002）：禅模式隐藏播放条，zenMode 唯一开关「视图」菜单随之不可达，
    /// 禅模式浮动控制的退出入口走这里。不能只靠 patchSettings { $0.zenMode = false }——
    /// 文章覆盖补丁按「全局旧值→新值」求差：全局已是 false、本篇覆盖仍记着 zenMode=true 时
    /// 差分为空、覆盖不动，有效设置仍是禅模式。故全局落 false 后再把本篇覆盖显式落 false。
    func exitZenMode() {
        patchSettings { $0.zenMode = false }
        if article?.settings?.zenMode == true {
            scheduleSave { article in
                var override = article.settings ?? ReaderSettingsOverride()
                override.zenMode = false
                article.settings = override
            }
        }
    }

    func resetSettings() {
        globalSettings = .default
        store.saveGlobalReaderSettings(.default)
        scheduleSave { article in
            var override = ReaderSettingsOverride()
            let patch = readerSettingsPatch(from: ReaderSettings.default, to: ReaderSettings.default)
            override.apply(patch: patch)
            article.settings = override
        }
        showToast("已恢复默认阅读设置")
    }

    // MARK: - 翻译管线（段级流式 + 单段重试 + 手改译文）

    func runTranslationPipeline(for articleID: String) {
        invalidateTranslationRun()
        let runID = translationRunID
        translationTask = Task { [weak self] in
            await self?.ensureTranslated(articleID: articleID, runID: runID)
        }
    }

    /// 让在途翻译 run 失效（切文 / 关文 / 重跑管线 / 单段重试共用）：取消任务、
    /// 代数 +1，并同步清掉「翻译中 N/M 段」chip。旧 run 失效后只会静默退出、不再碰
    /// translating，接管的新 run 需要时自己重新置 chip——于是新文章管线即便在
    /// 「先在设置里配置翻译接口」处早退，也不会残留旧文章进度。对齐 Windows
    /// ReaderApp.tsx:898-903 / 940-944 的 B1 修复（旧 run 先清 chip 再退出）；
    /// Mac 在失效点同步清而不是等旧 run 醒来再清（Task cancel + runID 代数是既定
    /// 并发架构，旧 run 无从得知新 run 是否已置 chip，由它来清会误清新 chip）。
    private func invalidateTranslationRun() {
        translationTask?.cancel()
        retryTranslationTask?.cancel()
        retryTranslationTask = nil
        translationRunID += 1
        translating = nil
    }

    private func isCurrentRun(_ articleID: String, _ runID: Int) -> Bool {
        article?.id == articleID && runID == translationRunID
    }

    private func ensureTranslated(articleID: String, runID: Int) async {
        guard let input = article, input.id == articleID else { return }
        let configured = (try? chat.configuration()) != nil
        guard configured else {
            // 早退不碰 chip：runTranslationPipeline 失效旧 run 时已清掉旧进度，
            // 中途清空配置再切文也不会残留旧文章的「翻译中 N/M 段」。
            showToast("先在设置里配置翻译接口，译文才会自动生成")
            return
        }
        let sample = input.sentences.first?.en ?? input.title
        let target = chat.resolveTarget(for: sample)

        // 待翻段落分组（保序）。
        var groups: [Int: [SentencePair]] = [:]
        for st in input.sentences where st.zhState == .pending {
            groups[st.paragraphIdx, default: []].append(st)
        }
        let pendingGroups = groups.sorted { $0.key < $1.key }
        let titlePending = input.titleCnState == .pending
        // chip 只归当前 run 写（失效点已清旧进度，失效 run 不得再置/清新 run 的 chip）。
        if !titlePending, pendingGroups.isEmpty {
            await MainActor.run {
                if self.isCurrentRun(articleID, runID) { self.translating = nil }
            }
            return
        }

        await MainActor.run {
            guard self.isCurrentRun(articleID, runID) else { return }
            self.translating = StepProgress(done: 0, total: pendingGroups.count + (titlePending ? 1 : 0))
        }

        func patch(_ mutate: @escaping (inout Article) -> Void) {
            guard isCurrentRun(articleID, runID) else { return }
            self.scheduleSave(mutate: mutate)
        }

        // 沉浸云主动限速：平台请求按 6.5s 间隔匀速发（makeTranslatePacer 判别），
        // 从源头避开 10 次/分钟令牌桶；第三方直通。
        let pacer = makeTranslatePacer()

        if titlePending {
            // 限速时隙（title 也占一个令牌；取消 = run 失效，chip 已由失效点清）。
            guard await pacer.awaitSlot() else { return }
            // 标题只发一次、不参与 429 退避（对齐 ReaderApp.tsx:876-890）。
            do {
                let cn = try await chat.complete(
                    systemPrompt: buildTitleTranslateSystemPrompt(target: target),
                    userText: input.title
                )
                let line = cn
                    .components(separatedBy: .newlines)
                    .first?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if isCurrentRun(articleID, runID) { titleCnError = nil }
                patch { a in
                    if !line.isEmpty {
                        a.titleCn = line
                        a.titleCnState = .done
                    } else {
                        a.titleCnState = .failed
                    }
                }
            } catch {
                let status = Self.channelHTTPOutcome(of: error).status
                if isCurrentRun(articleID, runID) {
                    titleCnError = ErrorMessageFormatter.readerParagraphErrorText(status: status)
                }
                patch { $0.titleCnState = .failed }
            }
            await MainActor.run {
                if isCurrentRun(articleID, runID) {
                    self.translating?.done += 1
                }
            }
        }

        // 整篇自动退避计数（429 等待次数 + 连续限流，跨段共享；手动重试发起的
        // 新 run 从 0 重新起算）。预算按待翻段数比例给（translateRunBackoffBudget）。
        let backoffs = TranslateBackoffCounter()
        let totalGroups = pendingGroups.count
        for (_, sentences) in pendingGroups {
            // 中途切文 / 新 run 接管：裸 return 不会卡死 chip——失效点
            //（invalidateTranslationRun）已同步清掉本 run 的 chip（B1 对等）。
            guard isCurrentRun(articleID, runID) else { return }
            // 限速时隙：沉浸云下匀速发请求（间隔内等待；取消 = run 失效静默退出）。
            guard await pacer.awaitSlot(), isCurrentRun(articleID, runID) else { return }
            let groupOutcome = await translateGroupWithBackoff(
                sentences,
                target: target,
                articleID: articleID,
                runID: runID,
                backoffs: backoffs,
                totalGroups: totalGroups
            )
            if groupOutcome == .pausedRateLimited {
                // 限流预算耗尽：清 chip、toast 带「继续翻译」按钮重跑管线
                //（剩余 pending 段会被重新认领）。不写任何失败态——限流是
                // 暂态，判死只会把整篇打成假失败（2026-11-05 Happy Prince 复盘）。
                await MainActor.run {
                    guard self.isCurrentRun(articleID, runID) else { return }
                    self.translating = nil
                    self.showToast(
                        "翻译请求被限流，已暂停自动翻译",
                        action: ToastAction(title: Self.resumeTranslateToastTitle) { [weak self] in
                            self?.runTranslationPipeline(for: articleID)
                        }
                    )
                }
                return
            }
            await MainActor.run {
                if isCurrentRun(articleID, runID) {
                    self.translating?.done += 1
                    if self.translating?.done ?? 0 >= self.translating?.total ?? 0 {
                        self.translating = nil
                    }
                }
            }
        }
        if isCurrentRun(articleID, runID) {
            translating = nil
        }
        // 翻译完成后紧接词块标注（不与翻译并发）。
        ensureAnnotated()
    }

    // MARK: - 段级 429 自动退避（对齐 ReaderApp.tsx:894-997 + paragraphTranslate.ts）

    /// 沉浸云网关主动限速器：平台请求按固定间隔匀速发送（网关令牌桶 10 次/分钟
    /// → 每 6.5s 一个请求），从源头避免 429——串行逐段翻译每段 2~4s 翻完就发
    /// 下一段 ≈ 20 次/分钟，不主动慢下来必然打穿令牌桶。第三方 provider
    /// intervalMs = 0 直通（各家配额远高于此）。与 429 反应式退避互补：
    /// 限速漏网（如同账号多设备并发）仍由 planTranslateRetry 兜底。
    /// Mac 先行（Windows paragraphTranslate.ts 无此层，待跟进对齐）。
    @MainActor
    final class TranslateRequestPacer {
        let intervalMs: Int
        private var nextSlot = Date.distantPast

        init(intervalMs: Int) {
            self.intervalMs = max(0, intervalMs)
        }

        /// 等到下一个可用时隙再返回并占用该时隙；run 被取消（sleep 抛
        /// CancellationError）返回 false，调用方静默退出（chip 已由失效点清掉）。
        func awaitSlot() async -> Bool {
            guard intervalMs > 0 else { return true }
            let now = Date()
            if now < nextSlot {
                let waitMs = Int(ceil(nextSlot.timeIntervalSince(now) * 1000))
                do {
                    try await Task.sleep(nanoseconds: UInt64(max(1, waitMs)) * 1_000_000)
                } catch {
                    return false
                }
            }
            nextSlot = Date().addingTimeInterval(Double(intervalMs) / 1000)
            return true
        }
    }

    /// 按当前通道配置建限速器：沉浸云 → 固定间隔（单测可用 override 注入短值）；
    /// 第三方 → 0 直通（override 不生效，第三方永远不限速）。
    private func makeTranslatePacer() -> TranslateRequestPacer {
        let isPlatform = (try? chat.configuration())?.isPlatformProvider ?? false
        let intervalMs = isPlatform
            ? (translatePacingIntervalMsOverride ?? ReaderCore.translatePacingIntervalMs)
            : 0
        return TranslateRequestPacer(intervalMs: intervalMs)
    }

    /// 整篇翻译 run 共享的退避计数盒：一个 run 内跨段共享退避预算与连续 429
    /// 计数，手动重试发起的新 run 换新盒子从 0 起算。引用语义（class）让
    /// ensureTranslated 持有、各段循环里递增。
    final class TranslateBackoffCounter {
        var runBackoffs = 0
        /// 连续 429 计数：中间任何一次请求走通（done/unaligned，即网关真的
        /// 放行了）就清零；熔断阈值见 ReaderCore.translateMaxConsecutive429。
        var consecutive429s = 0
    }

    /// 一段（含退避循环）的收尾：finished = 已落到终态（成功/判死），管线可
    /// 认领下一段；pausedRateLimited = 429 预算耗尽，整篇暂停——剩余段全部
    /// 保持 pending，由 toast 的「继续翻译」或重开文章恢复。
    enum TranslateGroupOutcome: Equatable {
        case finished
        case pausedRateLimited
    }

    /// 单段一次尝试的三种收尾（对齐 ReaderApp.tsx:949-980 的分桶语义）。
    private enum ParagraphOutcome {
        /// 编号行对齐成功（句子已写 done）。
        case done
        /// HTTP 200 但编号行对不齐 → failed 不带原因。
        case unaligned
        /// 请求错误（结构化 HTTP 状态码与 Retry-After 秒数；均为 nil = 超时/断网/未配置等）。
        case failed(httpStatus: Int?, retryAfterSeconds: Int?)
        /// run 已失效（切文章/新 run 接管）：静默退出，不写任何句子状态。
        case stale
    }

    /// 从通道错误里提结构化 HTTP 状态码与 Retry-After 秒数（超时/断网/未配置
    /// 等非 HTTP 失败 → 均为 nil）。只认 ReaderChatError.http，绝不匹配错误
    /// message 文本。
    private static func channelHTTPOutcome(of error: Error) -> (status: Int?, retryAfterSeconds: Int?) {
        if case ReaderChatClient.ReaderChatError.http(let status, _, let retryAfter) = error {
            return (status, retryAfter)
        }
        return (nil, nil)
    }

    /// 一段的翻译（含 429 自动退避）：按 ReaderCore.planTranslateRetry 决策——
    /// 等待时长优先服务端 Retry-After（clamp 5~60s，无头回退 20s）、连续 429
    /// 熔断、整篇预算按段数比例；预算耗尽返回 pausedRateLimited（当前段与剩余
    /// 段保持 pending，不判死——旧实现固定 6 次预算烧完会把每段逐个标 failed）。
    /// 等待醒来先确认 run 仍有效再重试，失效则退出且不重发请求（对齐
    /// ReaderApp.tsx:924-948）。失败分桶在循环外收尾一次：退避等待期间句子保持
    /// pending（与 Windows 观察面一致，不提前落 failed）。
    /// Windows 侧 planTranslateRetry（每段 ≤1 次 + 固定 20s + 封顶 6 次）语义
    /// 分叉待跟进对齐。
    func translateGroupWithBackoff(
        _ sentences: [SentencePair],
        target: String,
        articleID: String,
        runID: Int,
        backoffs: TranslateBackoffCounter,
        totalGroups: Int
    ) async -> TranslateGroupOutcome {
        // 重试请求复用：系统提示词只构造一次，重试与首次完全相同
        //（对齐 ReaderApp.tsx:945-947 循环外捕获 systemPrompt/onDelta）。
        let systemPrompt = buildParagraphTranslateSystemPrompt(
            targetLanguage: target,
            customStyle: chat.customStyle,
            glossaryText: chat.glossaryText
        )
        var outcome = await attemptParagraph(
            sentences,
            systemPrompt: systemPrompt,
            articleID: articleID,
            runID: runID
        )
        while case let .failed(status, retryAfterSeconds) = outcome {
            if status == 429 { backoffs.consecutive429s += 1 }
            let plan = ReaderCore.planTranslateRetry(
                httpStatus: status,
                retryAfterSeconds: retryAfterSeconds,
                runBackoffs: backoffs.runBackoffs,
                consecutive429s: backoffs.consecutive429s,
                totalGroups: totalGroups
            )
            guard case .wait(let plannerWaitMs) = plan else {
                if plan == .pauseRun {
                    // 预算耗尽：整篇暂停，本段保持 pending（不写失败态）。
                    return .pausedRateLimited
                }
                break // .failNow：非 429，落循环外失败分桶
            }
            backoffs.runBackoffs += 1
            // 单测注入短等待（translateBackoffWaitMsOverride）；生产用 planner 值。
            let waitMs = translateBackoffWaitMsOverride ?? plannerWaitMs
            do {
                try await Task.sleep(nanoseconds: UInt64(waitMs) * 1_000_000)
            } catch {
                // 切文章/手动重试接管：Task 被 cancel，sleep 抛 CancellationError。
                // 静默退出，不把句子标 failed（对齐 Windows 退避期间切文先清 chip 再退出）。
                return .finished
            }
            // 等待醒来先查 run 有效性：失效则不再发重试请求。
            guard isCurrentRun(articleID, runID) else { return .finished }
            outcome = await attemptParagraph(
                sentences,
                systemPrompt: systemPrompt,
                articleID: articleID,
                runID: runID
            )
            if case .failed = outcome {} else {
                backoffs.consecutive429s = 0 // 网关放行（成功或 200 对不齐）即清零
            }
        }
        switch outcome {
        case .done:
            break
        case .unaligned:
            markParagraphFailed(sentences, articleID: articleID, runID: runID, errorText: nil)
        case let .failed(status, _):
            markParagraphFailed(
                sentences,
                articleID: articleID,
                runID: runID,
                errorText: ErrorMessageFormatter.readerParagraphErrorText(status: status)
            )
        case .stale:
            break
        }
        return .finished
    }

    /// 一段的单次请求尝试：流式部分解析 + 完整解析；只写成功态，失败分桶由
    /// translateGroupWithBackoff 收尾（退避循环中不提前落 failed）。
    private func attemptParagraph(
        _ sentences: [SentencePair],
        systemPrompt: String,
        articleID: String,
        runID: Int
    ) async -> ParagraphOutcome {
        let expected = sentences.count
        let numberedInput = buildParagraphRequestInput(sentences.map(\.en))

        func patchGroup(_ transform: (SentencePair) -> SentencePair) {
            guard isCurrentRun(articleID, runID) else { return }
            let ids = Set(sentences.map(\.idx))
            scheduleSave { a in
                a.sentences = a.sentences.map { ids.contains($0.idx) ? transform($0) : $0 }
            }
        }

        do {
            let finalText = try await chat.completeStreaming(
                systemPrompt: systemPrompt,
                userText: numberedInput,
                onDelta: { [weak self] accumulated in
                    // 流式增量：只亮出已完整的编号行（pending 且已有部分译文的句子）。
                    guard let self, self.isCurrentRun(articleID, runID) else { return }
                    let partial = parsePartialNumbered(accumulated, expectedCount: expected)
                    let updates: [(Int, String)] = partial.enumerated().compactMap { i, text in
                        guard let text, !text.isEmpty else { return nil }
                        return (sentences[i].idx, text)
                    }
                    guard !updates.isEmpty else { return }
                    let map = Dictionary(uniqueKeysWithValues: updates)
                    self.scheduleSave { a in
                        a.sentences = a.sentences.map { st in
                            guard st.zhState == .pending, let zh = map[st.idx] else { return st }
                            var next = st
                            next.zh = zh
                            return next
                        }
                    }
                }
            )
            // 完整解析换回；cancelled 时已收到的部分也按完整解析尝试。
            guard isCurrentRun(articleID, runID) else { return .stale }
            guard let parsed = parseParagraphResponse(finalText, expectedCount: expected) else {
                return .unaligned
            }
            patchGroup { st in
                var next = st
                if let i = sentences.firstIndex(where: { $0.idx == st.idx }) {
                    next.zh = parsed[i]
                    next.zhState = .done
                }
                return next
            }
            return .done
        } catch {
            guard isCurrentRun(articleID, runID) else { return .stale }
            let httpOutcome = Self.channelHTTPOutcome(of: error)
            return .failed(
                httpStatus: httpOutcome.status,
                retryAfterSeconds: httpOutcome.retryAfterSeconds
            )
        }
    }

    /// 收尾分桶的 failed 写回：errorText 非 nil 时写 zhError（按状态码定稿的
    /// 文案）；nil 一并清空（parse 对齐失败与 run 失效不写原因）。
    /// 对齐 ReaderApp.tsx:988-997 markParagraphFailed。
    private func markParagraphFailed(
        _ sentences: [SentencePair],
        articleID: String,
        runID: Int,
        errorText: String?
    ) {
        guard isCurrentRun(articleID, runID) else { return }
        let ids = Set(sentences.map(\.idx))
        scheduleSave { a in
            a.sentences = a.sentences.map { st in
                guard ids.contains(st.idx) else { return st }
                var next = st
                next.zhState = .failed
                next.zhError = errorText
                return next
            }
        }
    }

    // MARK: - 词块标注（M4）

    /// 同一时刻只允许一篇文章在标。
    private var annotatingArticleID: String?
    private var chunkingTask: Task<Void, Never>?

    /// 文章翻译完成后按批跑 LLM 词块标注；切走文章即停。
    func ensureAnnotated() {
        guard let a = article else { return }
        guard annotatingArticleID == nil else { return }
        // 设置读实时合并值：开关状态可能来自全局默认或文章覆盖。
        guard mergeReaderSettings(globalSettings, a.settings).chunkHighlight else { return }
        guard a.chunkState != .done, !a.sentences.isEmpty else { return }
        let articleID = a.id
        chunkingTask?.cancel()
        chunkingTask = Task { [weak self] in
            await self?.runChunkAnnotation(articleID: articleID)
        }
    }

    private func runChunkAnnotation(articleID: String) async {
        let batches = chunkBatches((article?.sentences ?? []).map { ChunkBatchItem(idx: $0.idx, en: $0.en) })
        guard !batches.isEmpty else {
            scheduleSave { $0.chunkState = .done }
            return
        }
        let sample = article?.sentences.first?.en ?? article?.title ?? ""
        let target = chat.resolveTarget(for: sample)
        let system = buildChunkAnnotateSystemPrompt(target: target)
        annotatingArticleID = articleID
        defer { annotatingArticleID = nil }
        chunking = ChunkProgress(done: 0, total: batches.count)
        // 词块标注同样走沉浸云网关（令牌桶同一只），与翻译管线同口径限速。
        let pacer = makeTranslatePacer()
        var marked = 0
        var anyError = false
        var done = 0
        for batch in batches {
            guard article?.id == articleID else { return } // 切走文章，整批终止
            guard await pacer.awaitSlot() else { return }
            do {
                let raw = try await chat.complete(systemPrompt: system, userText: buildChunkBatchInput(batch))
                let byIdx = parseChunkResponse(raw, batch: batch)
                if !byIdx.isEmpty {
                    marked += byIdx.values.reduce(0) { $0 + $1.count }
                    let updates = byIdx
                    scheduleSave { a in
                        a.sentences = a.sentences.map { st in
                            guard let chunks = updates[st.idx] else { return st }
                            var next = st
                            next.chunks = chunks
                            return next
                        }
                    }
                }
            } catch {
                anyError = true
            }
            done += 1
            if article?.id != articleID { return }
            chunking = done < batches.count ? ChunkProgress(done: done, total: batches.count) : nil
        }
        scheduleSave { a in
            a.chunkState = (anyError && marked == 0) ? .failed : .done
        }
        if anyError, marked == 0 {
            showToast("词块标注失败，可在设置里重试")
        }
    }

    /// 设置抽屉「重新标注」：清空本篇词块后重跑。
    func reannotateChunks() {
        guard article != nil else { return }
        scheduleSave { a in
            a.chunkState = .pending
            a.sentences = a.sentences.map { st in
                var next = st
                next.chunks = nil
                return next
            }
        }
        ensureAnnotated()
    }

    /// 失败段数量（阅读室状态行的「重试 N 个失败段」入口用）。
    var failedParagraphCount: Int {
        Set((article?.sentences ?? []).filter { $0.zhState == .failed }.map(\.paragraphIdx)).count
    }

    /// 一键重试全部失败段：把所有 failed 句重置回 pending（清 zh/zhError）后
    /// 重跑主管线——限流风暴期整篇判死的恢复入口（逐段点「重试本段」对 85 段
    /// 不可用，2026-11-05 复盘补）。runTranslationPipeline 自带旧 run 失效，
    /// 在跑管线会被新 run 接管。
    func retryAllFailed() {
        guard let current = article, failedParagraphCount > 0 else { return }
        scheduleSave { a in
            a.sentences = a.sentences.map { st in
                guard st.zhState == .failed else { return st }
                var next = st
                next.zh = nil
                next.zhState = .pending
                next.zhError = nil
                return next
            }
        }
        runTranslationPipeline(for: current.id)
    }

    /// 单段重试：把该段失败句重置回 pending（清掉 zhError）后单独补翻。
    /// 不 invalidate 在跑的主管线、不 bump 代数（对齐 Windows ReaderApp.tsx:1027-1047
    /// 的并发补翻语义）：重试与管线共用当前 runID、各写各的段，剩余 pending 段仍由
    /// 主管线认领；旧实现先 invalidate 会掐死在跑管线，剩余段无人认领直到重新打开文章。
    /// 退避配额从 0 重新起算（新计数盒）；chip 只在无在跑管线时展示本段进度，
    /// 不覆盖主管线的 N/M 计数（Windows 重试同样不接管 chip）。
    func retryParagraph(_ paragraphIdx: Int) {
        scheduleSave { a in
            a.sentences = a.sentences.map { st in
                guard st.paragraphIdx == paragraphIdx, st.zhState == .failed else { return st }
                var next = st
                next.zh = nil
                next.zhState = .pending
                next.zhError = nil
                return next
            }
        }
        guard let current = article else { return }
        let runID = translationRunID
        let target = chat.resolveTarget(for: current.sentences.first?.en ?? current.title)
        let group = current.sentences.filter { $0.paragraphIdx == paragraphIdx && $0.zhState == .pending }
        guard !group.isEmpty else { return }
        // 退避预算按全篇待翻段数比例给（单段重试也看整篇规模，而非只有自己）。
        let pendingGroupCount = Set(
            current.sentences.filter { $0.zhState == .pending }.map(\.paragraphIdx)
        ).count
        let ownsChip = translating == nil
        if ownsChip {
            translating = StepProgress(done: 0, total: 1)
        }
        retryTranslationTask = Task { [weak self] in
            let outcome = await self?.translateGroupWithBackoff(
                group,
                target: target,
                articleID: current.id,
                runID: runID,
                backoffs: TranslateBackoffCounter(),
                totalGroups: max(1, pendingGroupCount)
            )
            await MainActor.run {
                // 只清自己置的 chip；主管线的计数归主管线收口。单段重试撞上
                // 限流暂停同理清 chip（句子保持 pending，主面板「重试本段」仍在）。
                if ownsChip, self?.isCurrentRun(current.id, runID) == true { self?.translating = nil }
                if outcome == .pausedRateLimited {
                    self?.showToast("翻译请求被限流，已暂停自动翻译")
                }
            }
        }
    }

    /// 标题重试：先清失败原因，再单独重跑标题（对齐 ReaderApp.tsx:1024-1029）。
    func retryTitle() {
        titleCnError = nil
        scheduleSave { a in
            a.titleCn = nil
            a.titleCnState = .pending
        }
        runTranslationPipeline(for: article?.id ?? "")
    }

    /// 手改译文；刚手改过的句子在遮罩模式下保持可见。
    func editTranslation(idx: Int, zh: String) {
        scheduleSave { a in
            a.sentences = a.sentences.map { st in
                guard st.idx == idx else { return st }
                var next = st
                next.zh = zh
                next.zhState = .edited
                next.revealed = true
                return next
            }
        }
    }

    // MARK: - 遮罩

    func reveal(_ idx: Int) {
        scheduleSave { a in
            a.sentences = a.sentences.map { $0.idx == idx ? $0.withRevealed(true) : $0 }
        }
    }

    func mask(_ idx: Int) {
        scheduleSave { a in
            a.sentences = a.sentences.map { $0.idx == idx ? $0.withRevealed(false) : $0 }
        }
    }

    func revealAll() {
        scheduleSave { a in
            a.sentences = a.sentences.map { $0.zh == nil ? $0 : $0.withRevealed(true) }
        }
    }

    func maskAll() {
        scheduleSave { a in
            a.sentences = a.sentences.map { $0.zh == nil ? $0 : $0.withRevealed(false) }
        }
    }

    // MARK: - 检索 / 定位

    func searchInArticle(_ raw: String) {
        let query = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let sentences = article?.sentences, !query.isEmpty else { return }
        if let hit = sentences.first(where: { $0.en.localizedCaseInsensitiveContains(query) }) {
            searchMatchIdx = hit.idx
            activeSentenceIdx = hit.idx
            showToast("在第 \(hit.idx + 1) 句找到「\(query)」")
        } else {
            showToast("本文没有包含「\(query)」的句子")
        }
    }

    func jumpTo(idx: Int, autoplay: Bool = false, once: Bool = false) {
        guard let total = article?.sentences.count, total > 0 else { return }
        readingSession.noteInteraction(now: Date.timeIntervalSinceReferenceDate)
        let clamped = min(max(0, idx), total - 1)
        playback.jumpTo(clamped, autoplay: autoplay, once: once)
        if !playback.playing {
            // 未播放：引擎只移动光标；这里同步高亮（播放中由引擎事件驱动）。
            if clamped != activeSentenceIdx {
                activeSentenceIdx = clamped
            }
        }
    }

    /// 滚动到哪 = 读到哪：未播放（且非跟读等待）时光标跟随视口。
    func viewportMoved(to idx: Int) {
        readingSession.noteInteraction(now: Date.timeIntervalSinceReferenceDate)
        guard !playback.playing, !playback.shadowingWait else { return }
        if idx != activeSentenceIdx {
            activeSentenceIdx = idx
            playback.setActiveCursor(idx)
        }
    }

    /// 阅读进度（断点续读 + 墨线）。书章同时把断点写回书级 meta
    ///（progress = {chapterId, sentenceIdx, percent}，1.2s 防抖落盘）。
    func noteReadProgress(idx: Int) {
        guard let a = article else { return }
        let total = a.sentences.count
        guard total > 0 else { return }
        let maxIdx = max(a.progress.sentenceIdx, min(idx, total - 1))
        let percent = total > 1 ? (Double(maxIdx) / Double(total - 1)) * 100 : (total == 1 ? 100 : 0)
        if maxIdx != a.progress.sentenceIdx || abs(percent - a.progress.percent) >= 0.5 {
            scheduleSave { article in
                article.lastReadAt = Int64(Date().timeIntervalSince1970 * 1000)
                article.progress.sentenceIdx = maxIdx
                article.progress.percent = percent
            }
            if a.bookId != nil {
                let chapterId = a.id
                let now = Int64(Date().timeIntervalSince1970 * 1000)
                scheduleBookMetaSave { meta in
                    var next = meta
                    next.lastReadAt = now
                    next.progress = BookProgress(chapterId: chapterId, sentenceIdx: maxIdx, percent: percent)
                    return next
                }
            }
        }
    }

    /// 书级 meta 修改（进度/最近阅读）：先改内存 bookList，1.2s 防抖落盘
    ///（对齐 Windows scheduleBookMetaSave 的防抖节奏）。
    func scheduleBookMetaSave(_ updater: (BookMeta) -> BookMeta) {
        guard let bookId = article?.bookId, !bookId.isEmpty,
              let idx = bookList.firstIndex(where: { $0.id == bookId }) else { return }
        let next = updater(bookList[idx])
        bookList[idx] = next
        bookSaveTask?.cancel()
        let id = next.id
        // 学习空间代数守卫（port-4，同 scheduleSave）。
        let namespace = store.learning?.currentNamespace()
        bookSaveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            guard !Task.isCancelled, let self else { return }
            if self.store.learning?.currentNamespace() != namespace { return }
            if let meta = self.bookList.first(where: { $0.id == id }) {
                try? self.store.saveBookMeta(meta)
            }
        }
    }

    // MARK: - 词典（屏 C）

    /// 在途查词请求（READ-9）：新查词先 cancel 旧 Task 再领新票根。
    private var dictTask: Task<Void, Never>?
    /// 查词序号守卫（READ-9）：Windows `rd${++translateSeqRef}` tag 的 Mac 对应物，
    /// 纯逻辑在 ReaderCore/DictPanelCore 供单测。
    private var dictSequence = DictLookupSequence()

    func lookup(query raw: String, sentenceIdx: Int) {
        guard let cleaned = extractSelectionText(raw) else { return }
        let articleID = article?.id ?? ""
        dictLookupCounts[articleID, default: 0] += 1
        // 查词发生 → 透镜卡切到「查词」Tab（ReaderApp.tsx:1389 setLensMode("lex")）。
        lensTab = .lex
        // READ-9 防串扰：新查词先掐掉在途旧请求（Windows requestTranslate 同 tag
        // 前缀自动取消旧请求），再领号；迟到结果由票根在写回前统一过滤。
        dictTask?.cancel()
        let ticket = DictLookupSequence.Ticket(
            runID: dictSequence.begin(),
            query: cleaned,
            sentenceIdx: sentenceIdx,
            articleID: article?.id
        )
        dict = .loading(query: cleaned, sentenceIdx: sentenceIdx)
        dictTask = Task { [weak self] in
            await self?.performLookup(ticket)
        }
    }

    /// 写回守卫：仍是最新请求（序号）＋面板仍是该请求的 loading 态＋文章未切走。
    /// 任一不成立即迟到/被取消结果，丢弃（对齐 xray 守卫的双重判定）。
    private func dictWritebackAllowed(_ ticket: DictLookupSequence.Ticket) -> Bool {
        var panelLoading: (query: String, sentenceIdx: Int)?
        if case .loading(let q, let i) = dict { panelLoading = (q, i) }
        return dictSequence.accepts(ticket, panelLoading: panelLoading, currentArticleID: article?.id)
    }

    private func performLookup(_ ticket: DictLookupSequence.Ticket) async {
        let query = ticket.query
        let sentenceIdx = ticket.sentenceIdx
        let target = chat.resolveTarget(for: query)
        do {
            let raw = try await chat.complete(
                systemPrompt: buildReaderDictPrompt(targetLanguage: target, glossaryText: chat.glossaryText),
                userText: query
            )
            guard dictWritebackAllowed(ticket) else { return } // 迟到/被取代：不覆盖新状态
            switch parseReaderDictResponse(raw) {
            case .entry(let entry):
                dict = .ready(query: query, entry: entry, sentenceIdx: sentenceIdx)
            case .notAWord:
                dict = .notAWord(query: query, sentenceIdx: sentenceIdx)
            case .invalid:
                dict = .error(query: query, sentenceIdx: sentenceIdx, message: "返回格式无法解析，请重试")
            }
        } catch {
            // 被新查词 cancel：新请求已接管面板，静默退出（Windows cancelled 分支不写错误态）。
            if Task.isCancelled { return }
            guard dictWritebackAllowed(ticket) else { return }
            dict = .error(query: query, sentenceIdx: sentenceIdx, message: (error as? LocalizedError)?.errorDescription ?? "\(error)")
        }
    }

    var isInVocab: Bool {
        guard let key = dict.query else { return false }
        return vocabWords.contains { $0.id == normalizeWordKey(key) }
    }

    /// 点正文词块下划线 → 即时卡（无 LLM 调用）；透镜卡同步切「查词」页签。
    /// 面板易主：在途查词请求顺手掐掉（迟到结果本就会被票根守卫丢弃，提前取消省 token）。
    func openChunkCard(chunk: SentenceChunk, sentenceIdx: Int) {
        dictTask?.cancel()
        lensTab = .lex
        dict = .chunkCard(chunk: chunk, sentenceIdx: sentenceIdx)
    }

    /// 透镜卡「查词」页签的关闭：结果收起、页签回落「句子解析」
    ///（DictColumn onClose → setDict(closed) + setLensMode("xray")）。
    /// 关闭即不再需要结果：在途请求一并取消。
    func closeDictLens() {
        dictTask?.cancel()
        dict = .closed
        lensTab = .xray
    }

    // MARK: - 句子解析（v0.8 透镜卡「句子解析」Tab）

    /// 当前句 en 走 chat 通道（Windows translateStream，tag 前缀 rx）请求
    /// 主干/结构拆解/句型。失败只提示不阻塞阅读；结果不落盘；请求期间切文章
    /// 则作废。光标移句后旧数据由展示层按 sentenceIdx == activeSentenceIdx 失效。
    func openXray(idx: Int) {
        guard let current = article,
              let en = current.sentences[safe: idx]?.en,
              !en.isEmpty else { return }
        lensTab = .xray
        xray = XrayLensState(status: .loading, sentenceIdx: idx, data: nil)
        // 未配置翻译接口：可操作提示，不阻塞阅读（ReaderApp.tsx:1425 hasValidSettings 分支）。
        guard (try? chat.configuration()) != nil else {
            xray = XrayLensState(status: .error, sentenceIdx: idx, data: nil)
            showToast("先在设置里配置翻译接口，才能解析句子")
            return
        }
        let articleID = current.id
        let target = chat.resolveTarget(for: en)
        Task { [weak self] in
            guard let self else { return }
            do {
                let raw = try await self.chat.complete(
                    systemPrompt: buildSentenceXraySystemPrompt(targetLang: target),
                    userText: buildSentenceXrayInput(sentence: en)
                )
                guard self.article?.id == articleID else { return } // 切文章，作废
                guard self.xray?.sentenceIdx == idx, self.xray?.status == .loading else { return } // 已被新请求取代
                if let parsed = parseSentenceXrayResponse(raw, sentence: en) {
                    self.xray = XrayLensState(status: .ready, sentenceIdx: idx, data: parsed)
                } else {
                    self.xray = XrayLensState(status: .error, sentenceIdx: idx, data: nil)
                    self.showToast("句子解析结果无法解析，请重试")
                }
            } catch {
                guard self.article?.id == articleID else { return }
                guard self.xray?.sentenceIdx == idx, self.xray?.status == .loading else { return }
                self.xray = XrayLensState(status: .error, sentenceIdx: idx, data: nil)
                self.showToast("句子解析失败，稍后再试")
            }
        }
    }

    /// 透镜卡 / 浮层 / 刊头「用这句练口语」：记 pendingSpeak book
    /// 意图再进口语（ReaderApp.tsx:1843-1853 practiceSentence 的 pendingSpeak 通道，
    /// 消费在 openSpeak）：该句进摘要首位，口语侧开场白自然从这句聊起。
    func practiceSentence(idx: Int) {
        guard let current = article,
              let en = current.sentences[safe: idx]?.en,
              !en.isEmpty else { return }
        pendingSpeak = PendingSpeakIntent(kind: .book(articleId: current.id, sentenceIdx: idx))
        openSpeak()
        showToast("已带入第 \(idx + 1) 句进入口语对话")
    }

    /// 刊头「围绕本章练口语」（ReaderApp.tsx:1855-1865 practiceChapter）：以当前
    /// 光标句为锚带入本章语境，toast 文案与单句带入区分。
    func practiceChapter(idx: Int) {
        guard let current = article,
              let en = current.sentences[safe: idx]?.en,
              !en.isEmpty else { return }
        pendingSpeak = PendingSpeakIntent(kind: .book(articleId: current.id, sentenceIdx: idx))
        openSpeak()
        showToast("已带入本章进入口语对话")
    }

    /// 解析面板对当前句是否处于 idle 速览态：没有本句的 loading/ready/error 记录
    ///（Windows xrayIdle，ReaderApp.tsx:2481-2486）——E 快捷键仅此时触发解析，
    /// 已解析/解析中/解析失败的句子按 E 不再重复发请求（重试走面板内按钮）。
    var xrayIdleForCurrent: Bool {
        xray?.sentenceIdx != activeSentenceIdx
    }

    /// pendingSpeak book 语境（对齐 ReaderApp.tsx:1931-1948 speakBookContext 的
    /// focus 拼装：带入句放摘要首位，其后按章内顺序补到 3 句，去重不重复带入句）。
    /// 短文也允许 book 语境（书名回落文章标题）——比 Windows 仅书章可用更宽，只增不删。
    private func pendingBookContext(focusIdx: Int) -> SpeakSessionContext? {
        guard let current = article,
              let focus = current.sentences[safe: focusIdx]?.en,
              !focus.isEmpty else { return nil }
        let book = currentBook
        let chapterIdx = current.chapterIdx
            ?? book.map { bookChapterIndexOf(book: $0, chapterId: current.id) }
            ?? 0
        var excerpt = [focus]
        for en in current.sentences.map(\.en) where !en.isEmpty && en != focus && excerpt.count < 3 {
            excerpt.append(en)
        }
        return .book(
            bookTitle: book?.title ?? current.title,
            chapterArticleId: current.id,
            chapterIdx: chapterIdx,
            excerpt: excerpt
        )
    }

    /// pendingSpeak 消费（进口语面时执行一次；对齐 SpeakView.tsx:617-638 的挂载消费）：
    /// book 形态过期（当前文章不是意图所指）不触发、意图保留等文章切回或被清理；
    /// vocab 形态目标词已不在生词本则丢弃意图；同一 intent 由 SpeakViewController
    /// 按 id 去重，绝不重复开会。
    private func consumePendingSpeak() {
        guard let intent = pendingSpeak else { return }
        switch intent.kind {
        case .book(let articleId, let sentenceIdx):
            guard article?.id == articleId,
                  let context = pendingBookContext(focusIdx: sentenceIdx) else { return }
            speak.start(pending: intent, context: context)
        case .vocab(let wordId):
            guard vocabWords.contains(where: { $0.id == wordId }) else {
                pendingSpeak = nil
                return
            }
            var ids = [wordId]
            for due in dueWords.prefix(8) where due.id != wordId {
                ids.append(due.id)
            }
            speak.start(pending: intent, context: .vocab(wordIds: ids))
        }
    }

    /// 词块即时卡「收藏词块」/ 搭配收藏共用。
    func addChunkVocab(_ chunk: SentenceChunk, sentenceIdx: Int) {
        guard let currentArticle = article else { return }
        let word = chunkToVocab(
            chunk,
            source: VocabSource(articleId: currentArticle.id, sentenceIdx: sentenceIdx),
            now: Int64(Date().timeIntervalSince1970 * 1000)
        )
        do {
            try store.saveVocabWord(word)
            refreshVocab()
            showToast("已收藏词块：\(word.word)")
        } catch {
            showToast("收藏词块失败")
        }
    }

    func addCurrentDictVocab() {
        guard let currentArticle = article else { return }
        let source = VocabSource(articleId: currentArticle.id, sentenceIdx: dict.sentenceIdx)
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        switch dict {
        case .ready(_, let entry, _):
            let word = entryToVocab(entry, source: source, now: now)
            do {
                try store.saveVocabWord(word)
                refreshVocab()
                showToast("已加入生词本：\(word.word)")
            } catch {
                showToast("加入生词本失败")
            }
        case .chunkCard(let chunk, let idx):
            addChunkVocab(chunk, sentenceIdx: idx)
        case .loading, .notAWord, .error, .closed:
            break
        }
    }

    /// 常用搭配行一键收藏为词块。
    func addCollocationVocab(_ coll: VocabCollocation, sentenceIdx: Int) {
        guard let currentArticle = article else { return }
        let chunk = SentenceChunk(text: coll.en, chunkType: .collocation, gloss: coll.cn)
        let word = chunkToVocab(
            chunk,
            source: VocabSource(articleId: currentArticle.id, sentenceIdx: sentenceIdx),
            now: Int64(Date().timeIntervalSince1970 * 1000)
        )
        do {
            try store.saveVocabWord(word)
            refreshVocab()
            showToast("已收藏搭配：\(word.word)")
        } catch {
            showToast("收藏搭配失败")
        }
    }

    func copyDictEntry() {
        guard case let .ready(query, entry, _) = dict else { return }
        var lines = [entry.word]
        for s in entry.senses {
            let line = "\(s.pos) \(s.cn)".trimmingCharacters(in: .whitespaces)
            if !line.isEmpty { lines.append(line) }
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(lines.joined(separator: "\n"), forType: .string)
        _ = query
    }

    // MARK: - 复习（屏 D，M3 完整实现；openReview 见路由区）

    /// 复习卡回跳/书证需要原句：把相关文章拉进缓存。
    func loadSourceArticles(ids: [String]) {
        for id in Set(ids) where !id.isEmpty && sourceCache[id] == nil {
            if let article = (try? store.getArticle(id: id)) ?? nil {
                sourceCache[id] = article
            }
        }
    }

    /// 复习卡「回到原文」：切到阅读视图并定位该句。打开失败（文章已不在当前
    /// 学习空间）不跳——openArticle 已给 toast 并刷新列表（对齐 Windows bool 契约）。
    func jumpToSource(articleId: String, sentenceIdx: Int) {
        guard !articleId.isEmpty else { return }
        if article?.id == articleId {
            route = .reading
        } else {
            guard openArticle(id: articleId) else { return }
        }
        jumpTo(idx: sentenceIdx)
    }

    /// 练习接力「回到原文这句」落点（ReaderApp.tsx:1902：readerGetArticle 取到 null
    /// → 「原文已删除…」；取文章抛错 → toast 错误原文；存在 → 跳阅读定位该句）。
    func openRelaySource(articleId: String, sentenceIdx: Int) {
        let found: Article?
        do {
            found = try store.getArticle(id: articleId)
        } catch {
            showToast((error as? LocalizedError)?.errorDescription ?? String(describing: error))
            return
        }
        guard found != nil else {
            showToast("原文已删除，练习仍保留完整参考句和反馈")
            return
        }
        jumpToSource(articleId: articleId, sentenceIdx: sentenceIdx)
    }

    /// 来源句（含译文）。
    func sourceSentence(articleId: String, sentenceIdx: Int) -> (en: String, zh: String?)? {
        guard !articleId.isEmpty,
              let sentence = sourceCache[articleId]?.sentences[safe: sentenceIdx] else { return nil }
        return (sentence.en, sentence.zh)
    }

    func sourcePreview(articleId: String, sentenceIdx: Int) -> String? {
        sourceSentence(articleId: articleId, sentenceIdx: sentenceIdx)?.en
    }

    func articleTitle(articleId: String) -> String? {
        guard !articleId.isEmpty else { return nil }
        // 书章（词典卡/复习卡「回到原文」来源文案唯一出口）：统一「《书名》·第 N 章」，
        // 不回落章自身标题；短文回落标题。
        if let label = bookChapterLabel(articleId: articleId) {
            return label
        }
        return sourceCache[articleId]?.title
            ?? articleList.first { $0.id == articleId }?.article.title
    }

    // MARK: - 复习评分

    /// 应用一档评分并落盘：SRS 演进 + 错题分桶 + 复习打卡 + 刷新统计。
    /// mode/verdict 来自复习卡的判分上下文（识别卡 judged=nil 按评分归桶）。
    /// 学习接线路径：不可变评分事件（带 day/generation/recall）→
    /// LearningStore.commitReview，SRS/recall 由事件归并重建（Rust 落库为准）。
    func gradeVocab(
        _ word: VocabWord,
        _ grade: ReviewGrade,
        mode: RecallMode,
        verdict: RecallVerdict?
    ) {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let bucket = recallBucket(mode: mode, judged: verdict, grade: grade)
        if store.learning != nil {
            do {
                _ = try store.gradeVocabWord(word, grade: grade, mode: mode, bucket: bucket, now: now)
                // 复习日志由 hydrateReviews 重建（baselineReviewLog + 活跃事件 day），
                // 不在本地另记一套账。
                if let file = try? store.getVocabFile() {
                    reviewLog = file.reviewLog
                }
                refreshVocab()
                ReviewTouchpointManager.shared.refreshBadge()
            } catch {
                showToast("保存复习记录失败")
            }
            return
        }
        var graded = word
        graded.srs = gradeSrs(word.srs, grade, now: now)
        graded.recall = recordRecallStat(word.recall, mode: mode, bucket: bucket, nowMs: now)
        do {
            try store.saveVocabWord(graded)
            let day = dayKey(nowMs: now)
            reviewLog = (try? store.recordReview(day: day)) ?? reviewLog
            refreshVocab()
            ReviewTouchpointManager.shared.refreshBadge()
        } catch {
            showToast("保存复习记录失败")
        }
    }

    /// 开口命中目标词：按 easy 档落 SRS 并记 spokenAt（内化三阶最高阶的
    /// 数据来源；对齐 Windows gradeSpokenVocab = gradeVocab({...word, spokenAt}, "easy")）。
    /// 评分/打卡/统计刷新全部复用 gradeVocab 的普通链路。
    func gradeSpoken(_ word: VocabWord) {
        var spoken = word
        spoken.spokenAt = Int64(Date().timeIntervalSince1970 * 1000)
        gradeVocab(spoken, .easy, mode: .recognition, verdict: nil)
    }

    /// 手账/看板「去口语里用一次」：pendingSpeak 置 vocab 形态再进口语造句闯关
    /// （Windows pendingSpeak {kind:"vocab"} 通道）。目标词提到队首，再并入今日
    /// 到期词，最多 9 个；vocab 形态一次性消费（离开口语页即清）。
    func practiceVocabSpeak(_ word: VocabWord) {
        pendingSpeak = PendingSpeakIntent(kind: .vocab(wordId: word.id))
        openSpeak()
        showToast("已带「\(word.word)」进入口语造句闯关")
    }

    // MARK: - 路由（v0.8 导航岛三档 + 书架首页 + 书架浮层）

    /// 回整页书架（首页）。keepFolio = 删除后保持浮层打开（Windows 删除契约）。
    func openShelf(keepFolio: Bool = false) {
        exitFocus()
        if !keepFolio { folioOpen = false }
        route = .shelf
    }

    func openReading() {
        exitFocus()
        route = .reading
    }

    /// 复习类入口（托盘/菜单「生词本」经 bootstrap(openReview:) 走到这里）：
    /// 2026-10-26 改版落复习首页档（对齐 Windows goReview → vault·home），
    /// Hero「开始复习」再进专注态。
    func openReview() {
        exitFocus()
        vaultPlayMode = .home
        route = .vault
        reviewPos = 0
        loadSourceArticles(ids: vocabWords.map(\.source.articleId))
        refreshNotes()  // 「N 未整理」角标需要笔记覆盖数据
        refreshSpeakSessions()  // 首页口语纠偏条目与 rail 计数
    }

    /// 进入「笔记与复习」档但保留上次玩法档（导航岛第三档；Windows
    /// navigateSurface(vault) 不重置 vaultMode——已在 vault 内跨视图进入保留上次档位）。
    func openVault() {
        route = .vault
        loadSourceArticles(ids: vocabWords.map(\.source.articleId))
        refreshNotes()
        refreshSpeakSessions()
    }

    /// 导航岛三档路由（对齐 ReaderApp.tsx:1867-1878 navigateSurface）：切档先收书架浮层；
    /// 阅读档没有打开的文章时续读最近一篇/一本（都没有才落空态）；
    /// 「笔记与复习」档已在 vault 内时不重置玩法档。
    func navigate(to surface: IslandSurface) {
        folioOpen = false
        switch surface {
        case .reading:
            if article != nil {
                openReading()
            } else if !openMostRecentIfAny() {
                openReading()
            }
        case .speak:
            openSpeak()
        case .vault:
            if route == .vault { return }
            openVault()
        }
    }

    /// 导航岛当前高亮档（shelf/reading→阅读、speak→口语、vault→笔记与复习）。
    var islandSurface: IslandSurface {
        IslandSurface(folding: route.kind)
    }

    /// 专注复习态（仅 vault + focus）：顶栏中岛隐藏、vault 单列居中（Windows focusMode）。
    var vaultFocusMode: Bool {
        route == .vault && vaultPlayMode == .focus
    }

    /// 「笔记与复习」档角标 = 到期数（未整理数与到期数可能重叠，只算 dueNow；
    /// 未整理数在笔记页「N 词未整理」胶囊独立说明）；收藏 / 评分 / 生成笔记后随
    /// @Published 数据实时变。
    var vaultBadge: Int {
        vaultBadgeCount(dueNow: stats.dueNow)
    }

    /// 顶栏左上触发器文案「书架 · X」的 X：书架页 / 口语陪练 / 笔记与复习 / 当前文章名。
    var surfaceTitle: String? {
        route.kind.surfaceTitle(articleTitle: article?.title)
    }

    /// 左上书卷胶囊完整文案（书架页自身只写「书架」）。
    var folioTriggerLabel: String {
        route.kind.folioTriggerLabel(articleTitle: article?.title)
    }

    func toggleFolio() {
        folioOpen.toggle()
    }

    func closeFolio() {
        folioOpen = false
    }

    /// 书架浮层「＋ 导入文件」：开导入向导（缺省文库 tab）并收起浮层
    ///（Windows FolioSheet onOpenImport 不带 tab + onClose）。
    func openImportFromFolio() {
        openImport(tab: nil)
        folioOpen = false
    }

    /// 打开导入弹窗，可指定直达 tab（书架发现三列 discover/feed/lib、书架浮层与
    /// 阅读页空态不带 tab 落缺省文库）。挂点：FolioSheet/ShelfPage/ReadingView。
    /// 白名单防御（Windows IMPORT_OPEN_TABS，ReaderApp.tsx:376-379）：调用方直传
    /// 控件回调时第一个参数可能是事件对象等非 tab 值——Mac 侧等效输入是任意不在
    /// 白名单里的字符串，一律回落 `lib`；否则弹窗七个 tab 全不命中、只剩头和 tab 条
    ///（2026-10-26 回归的教训）。
    func openImport(tab raw: String? = nil) {
        importInitialTab = resolveImportOpenTab(raw)
        importSheetShown = true
    }

    // MARK: - 关窗（✕ = 先停播再隐藏；对齐 Windows ReaderApp.tsx:1218-1235 onCloseRequested）

    /// 阅读室窗口即将关闭：停朗读 / 收麦 / 取消在途评测与口语对话 / 落盘阅读秒数。
    /// 窗口只隐藏不销毁，文章、进度、光标位置全部保留，重开即续。
    func handleWindowWillClose() {
        playback.stop()            // 句子朗读 + 云播放立刻停；shadowingWait 复位
        leadSpeaker.stop()         // 跟读领读
        shadowPlayer.stop()        // 「听我的录音」回放
        drill.close()              // 差词抽屉（含其录音）
        assess.cancelAssess()      // 跟读评测：弃录音、掐领读、回 idle（收麦）
        speak.cancelAll()          // 口语陪练：在途 ASR/LLM/ISE 与录音一并掐掉
        folioOpen = false
        flushReadingSeconds()      // 未落盘的阅读秒数不丢
    }

    /// 笔记复盘/章末卡/结课条/看板易错项的「只测这批词」：只排这批词，不等到期，
    /// 直落专注态（对齐 Windows startFocusReview → vaultMode focus）。
    func startFocusReview(ids: [String]) {
        guard !ids.isEmpty else {
            showToast("这篇笔记的词这一轮都通过了，没有要补的")
            return
        }
        focusReviewIds = ids
        reviewPos = 0
        vaultPlayMode = .focus
        route = .vault
        // 加练批次的原句要能取到（完形/听写素材）：按词条来源文章拉进缓存。
        let batch = Set(ids)
        loadSourceArticles(ids: vocabWords.filter { batch.contains($0.id) }.map(\.source.articleId))
        refreshSpeakSessions()
    }

    /// 离开复习队列的入口（rail 退出横幅 / 阅读档等）：回全局到期队列。
    /// 注意：focus 态底部切换器/Esc 只切档不清 focusIds（专注队列续跑），
    /// 只有显式退出加练或离开 vault 路由（goShelf/goReading/goSpeak）才清。
    func exitFocus() {
        focusReviewIds = nil
    }

    // MARK: - 笔记库

    /// 笔记库入口：vault「全部笔记」档（对齐 Windows goNotes → vaultMode notes）。
    func openNotes() {
        exitFocus()
        vaultPlayMode = .notes
        route = .vault
        refreshNotes()
        refreshSpeakSessions()
    }

    /// 口语会话快照（手账口语行 / Markdown 导出 / 内化看板共用）。
    func refreshSpeakSessions() {
        speakSessions = (try? speak.store.listSessions()) ?? []
    }

    /// 进口语面（导航岛 / 带入意图共用入口）：切路由后消费 pendingSpeak——
    /// 这是意图开会的唯一落点，保证「带入 → 进面 → 开会」一条链。
    func openSpeak() {
        exitFocus()
        route = .speak
        speak.refreshRecent()
        consumePendingSpeak()
    }

    func refreshNotes() {
        notes = (try? noteStore.list()) ?? []
    }

    /// 还没整理进任何笔记的生词数（生成按钮角标：该整理了）。
    var unnotedWordCount: Int {
        let covered = Set(notes.flatMap { $0.wordIds })
        return vocabWords.filter { !covered.contains($0.id) }.count
    }

    func selectNote(file: String) {
        guard let loaded = try? noteStore.read(file: file) else { return }
        activeNoteFile = file
        activeNote = (loaded.meta, parseNoteMarkdown(loaded.content))
    }

    /// 删除笔记：先弹确认，确认才删（对齐 Windows 7fc7501 后的 ConfirmDialog 契约
    /// 「删除这篇笔记？删除后不可恢复。」，取消不删）；NSAlert 样式与书架/短文
    /// 删除确认一致（ReaderViews confirmDelete）。
    func deleteNote(file: String) {
        let alert = NSAlert()
        alert.messageText = "删除这篇笔记"
        alert.informativeText = "删除这篇笔记？删除后不可恢复。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "删除")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        performDeleteNote(file: file)
    }

    private func performDeleteNote(file: String) {
        // QA BUG-004：旧写法 `_ = try?` 吞掉异常与 false，删除失败也报「笔记已删除」。
        // 对齐 Windows confirmDeleteNote（removed 为真才报已删除）；失败如实提示、不清当前笔记。
        let removed: Bool
        do {
            removed = try noteStore.delete(file: file)
        } catch {
            showToast("删除笔记失败：\((error as? LocalizedError)?.errorDescription ?? String(describing: error))")
            return
        }
        if activeNoteFile == file {
            activeNoteFile = nil
            activeNote = nil
        }
        refreshNotes()
        // false = files 表与磁盘都已没有这篇（如已被同步删除）：刷新列表即可，不谎报。
        showToast(removed ? "笔记已删除" : "这篇笔记已不存在")
    }

    /// 生成弹窗「在笔记库打开」：保存完成后直达。
    func openSavedNote(meta: NoteMeta) {
        noteDialogShown = false
        openNotes()
        selectNote(file: meta.file)
    }

    /// 打开生成弹窗（可带预选：笔记库「滚进新笔记」）。
    func openNoteDialog(preselect: [String] = []) {
        noteDialogPreselect = preselect
        noteDialogShown = true
    }

    // MARK: - 口语复盘入生词本（对齐 Windows SpeakReviewDialog）

    /// 复盘弱词入生词本（单条）：公共 CollectActions.addTextToVocab——查词典补
    /// 词性/释义/音标 + 例句生成并行，mergeVocabWord 合并落库（已有同名词保留 SRS，
    /// 不重复添加）。词典查询失败时降级为裸词保存（例句用本轮 AI 原句，不阻塞
    /// 其余词），对齐 Windows「释义获取失败按裸词收藏」。
    @discardableResult
    func saveSpeakReviewCandidate(_ candidate: SpeakVocabCandidate) async throws -> CollectVocabOutcome {
        do {
            // CollectActions.addTextToVocab 收具体 ReaderChatClient（CollectActions.swift:71，
            // 第 2 波可放宽为 ReaderChatChannel）；生产通道即 ReaderChatClient，转型恒成立。
            // 替身通道（单测）转型失败 → 与词典查询失败同路降级为裸词保存。
            guard let client = chat as? ReaderChatClient else {
                throw ReaderChatClient.ReaderChatError.missingAPIKey
            }
            return try await CollectActions.addTextToVocab(chat: client, rawText: candidate.word)
        } catch {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let word = speakCandidateToVocab(candidate, entry: nil, now: now)
            let added = try ReaderStore.shared.mergeVocabWord(word)
            NotificationCenter.default.post(
                name: .readerVocabAdded,
                object: nil,
                userInfo: ["wordId": word.id]
            )
            return CollectVocabOutcome(status: added ? .added : .merged, word: word, withExample: false)
        }
    }

    /// 复盘「唤醒」：已收藏且挣扎/到期的弱词 srs.dueAt 置 now——
    /// dueVocab 按 dueAt 升序（ReaderSrs），提到今日复习队列最前；其余 SRS 字段原样保留。
    func wakeSpeakReviewWords(_ ids: [String]) {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        for id in ids {
            guard var w = vocabWords.first(where: { $0.id == id }) else { continue }
            w.srs.dueAt = now
            try? store.saveVocabWord(w)
        }
        if !ids.isEmpty { refreshVocab() }
    }

    /// 笔记生成/复盘共用的流式补全通道（弹窗直接调用）。
    func streamChat(
        systemPrompt: String,
        userText: String,
        onDelta: @escaping (String) -> Void
    ) async throws -> String {
        try await chat.completeStreaming(systemPrompt: systemPrompt, userText: userText, onDelta: onDelta)
    }

    /// 生成 AI 复盘并写回笔记 frontmatter；返回是否成功。
    func generateReplay(for meta: NoteMeta) {
        guard !noteReplayBusy else { return }
        noteReplayBusy = true
        Task { [weak self] in
            guard let self else { return }
            defer { self.noteReplayBusy = false }
            let byId = Dictionary(uniqueKeysWithValues: self.vocabWords.map { ($0.id, $0) })
            let noteWords = meta.wordIds.compactMap { byId[$0] }
            guard !noteWords.isEmpty else {
                self.showToast("这篇笔记的词都不在生词本里了")
                return
            }
            let weakIds = meta.wordIds.filter { id in
                guard let w = byId[id] else { return false }
                return isStillWeak(w)
            }
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let dateHint = dayKey(nowMs: meta.createdAt)
            do {
                let raw = try await self.chat.complete(
                    systemPrompt: buildReplaySystemPrompt(),
                    userText: buildReplayInput(noteWords, weakIds: weakIds, noteDateHint: dateHint)
                )
                guard let parsed = parseReplay(raw), verifyReplayWords(parsed, weakWords: weakIds.compactMap { byId[$0] }) else {
                    self.showToast("复盘输出无法解析，请重试")
                    return
                }
                let passed = noteWords.count - weakIds.count
                var replay = NoteReplay(
                    verdict: parsed.verdict,
                    weak: parsed.weak.map { NoteReplay.WeakItem(w: $0.w, why: $0.why) },
                    passed: passed,
                    stillWeak: weakIds.count
                )
                replay.rounds = max(1, (meta.replay?.rounds ?? 0) + (meta.replay == nil ? 0 : 1))
                if let updated = try? self.noteStore.writeReplay(file: meta.file, replay: replay, rounds: replay.rounds, nowMs: now) {
                    self.refreshNotes()
                    if self.activeNoteFile == meta.file {
                        self.selectNote(file: meta.file)
                    }
                    self.showToast("复盘已写回")
                } else {
                    self.showToast("复盘写回失败")
                }
            } catch {
                self.showToast("复盘失败：\((error as? LocalizedError)?.errorDescription ?? String(describing: error))")
            }
        }
    }

    /// 复习视图的当前队列：加练批次优先，否则普通到期队列。
    var reviewQueue: [VocabWord] {
        if let focus = focusReviewIds {
            let byId = Dictionary(uniqueKeysWithValues: vocabWords.map { ($0.id, $0) })
            return focus.compactMap { byId[$0] }
        }
        return dueWords
    }

    // MARK: - 随读抽查（原位挖空微测；ReadingView.tsx:186-214,:492-513 + ReaderApp.tsx:1779-1793）

    /// 槽位作答状态（usedHint 在判分前就要记，verdict 判分后写入）。
    struct ClozeSlotState: Equatable {
        var usedHint = false
        var verdict: RecallVerdict?
        var input: String?
    }

    /// 判分后的胶带小条（左下角，最多 3 条，3.2s 自动退场）。
    struct ClozeToast: Identifiable, Equatable {
        let id: Int
        let word: String
        let label: String
        let tone: RecallVerdict
    }

    @Published var clozeState: [String: ClozeSlotState] = [:]
    @Published private(set) var clozeToasts: [ClozeToast] = []
    private var clozeToastSeq = 0
    private var clozeSlotsCache: (signature: String, slots: [Int: ClozeSlot])?

    /// 随读抽查开关（settings.spotQuizMode 生效值）。
    var clozeQuizOn: Bool { effectiveSettings.spotQuizEnabled }

    /// 已读句的挖空槽（每段一槽）；开关关闭 / 无文章时恒为空集——正文零残留。
    /// 词块/生词跨度与正文标注同源（chunkHighlight / showVocabMarks 只影响参与合并的候选）。
    var clozeSlots: [Int: ClozeSlot] {
        guard clozeQuizOn, let article else { return [:] }
        let settings = effectiveSettings
        let known: Set<String> = settings.showVocabMarks ? knownIds : []
        let watermark = article.progress.sentenceIdx
        var hasher = Hasher()
        hasher.combine(article.id)
        hasher.combine(watermark)
        hasher.combine(settings.chunkHighlight)
        hasher.combine(known)
        for s in article.sentences {
            hasher.combine(s.idx)
            hasher.combine(s.en)
            for chunk in s.chunks ?? [] { hasher.combine(chunk.text) }
        }
        let signature = String(hasher.finalize())
        if let cache = clozeSlotsCache, cache.signature == signature { return cache.slots }
        var spans: [Int: [ChunkSpan]] = [:]
        for s in article.sentences {
            let list = buildSentenceSpans(s.en, settings.chunkHighlight ? s.chunks : nil, knownIds: known)
            if !list.isEmpty { spans[s.idx] = list }
        }
        let slots = pickClozeSlots(spansBySentence: spans, sentences: article.sentences, watermark: watermark)
        clozeSlotsCache = (signature, slots)
        return slots
    }

    /// 战绩（命中 / 接近 / 陷阱 / 已答 / 待答）。
    var clozeTallyNow: ClozeTally {
        var verdicts: [String: RecallVerdict] = [:]
        for (id, st) in clozeState { if let v = st.verdict { verdicts[id] = v } }
        return clozeTally(slots: clozeSlots, verdicts: verdicts)
    }

    /// 某句槽位的渲染态（offset = 该句在所在文本块里的起点：对照行 0 / 画报流拼接坐标）。
    func clozeRenderMark(sentenceIdx: Int, offset: Int) -> ClozeRenderMark? {
        guard let slot = clozeSlots[sentenceIdx] else { return nil }
        let st = clozeState[slot.id]
        return ClozeRenderMark(
            id: slot.id,
            start: slot.start + offset,
            end: slot.end + offset,
            answer: slot.answer,
            isKnown: slot.isKnown,
            verdict: st?.verdict,
            input: st?.input,
            note: clozeNoteText(slot),
            peeked: peekAll && st?.verdict == nil
        )
    }

    /// 提交判分（judgeCloze 本地判；用过提示的 perfect 降档为 close）→ 作答态 → 胶带 toast →
    /// known 槽联动 SRS。Enter 空输入也判（judgeCloze 空串 = wrong，与 Windows 一致）。
    func commitCloze(_ slot: ClozeSlot, raw: String) {
        let verdict0 = judgeCloze(raw, slot.answer, options: JudgeOptions(trap: slot.trap))
        let usedHint = clozeState[slot.id]?.usedHint ?? false
        let verdict = clozeApplyHintPenalty(verdict0, usedHint: usedHint)
        clozeState[slot.id] = ClozeSlotState(
            usedHint: usedHint,
            verdict: verdict,
            input: raw.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        pushClozeToast(slot, verdict)
        clozeVerdict(slot, verdict)
    }

    /// 「?」首字母提示：记 usedHint（命中会降档为「接近」），返回要填进输入框的首字母串。
    @discardableResult
    func useClozeHint(_ slot: ClozeSlot) -> String {
        var st = clozeState[slot.id] ?? ClozeSlotState()
        st.usedHint = true
        clozeState[slot.id] = st
        return firstLetters(slot.answer)
    }

    /// 随读抽查判分 → SRS：只有生词再现槽联动（限幅：即时回忆最高只记 good，见
    /// clozeVerdictToGrade）；词块槽不进生词本，纯在正文里给反馈（ReaderApp.tsx:1779-1793）。
    func clozeVerdict(_ slot: ClozeSlot, _ verdict: RecallVerdict) {
        guard slot.isKnown, let vocabId = slot.vocabId,
              let word = vocabWords.first(where: { $0.id == vocabId }) else { return }
        gradeVocab(word, clozeVerdictToGrade(verdict), mode: .cloze, verdict: verdict)
    }

    private func pushClozeToast(_ slot: ClozeSlot, _ verdict: RecallVerdict) {
        clozeToastSeq += 1
        let key = clozeToastSeq
        let toast = ClozeToast(
            id: key,
            word: slot.answer,
            label: clozeToastLabel(isKnown: slot.isKnown, verdict: verdict),
            tone: verdict
        )
        clozeToasts = Array(clozeToasts.suffix(2)) + [toast]
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_200_000_000)
            guard let self else { return }
            self.clozeToasts.removeAll { $0.id == key }
        }
    }

    // MARK: - 键盘（空格仅阅读器内生效；J/K/L 备选；H 暂显全部译文；Esc 统一收浮层；
    //         滑杆聚焦时方向键/翻页键/Home/End 翻句）

    /// Esc 的 keyCode（NSEvent.keyCode；字符层面 Esc 不可靠，按键码判）。
    private static let escapeKeyCode: UInt16 = 53
    /// READ-6 键盘滑杆的键码（NSEvent.keyCode；Fn+方向键在便携键盘上同样落这些码）。
    private static let leftArrowKeyCode: UInt16 = 123
    private static let rightArrowKeyCode: UInt16 = 124
    private static let downArrowKeyCode: UInt16 = 125
    private static let upArrowKeyCode: UInt16 = 126
    private static let homeKeyCode: UInt16 = 115
    private static let endKeyCode: UInt16 = 119
    private static let pageUpKeyCode: UInt16 = 116
    private static let pageDownKeyCode: UInt16 = 121

    /// 播放条进度条是否持有键盘焦点（READ-6）。PlayBarView 的 FocusState 双向同步；
    /// 聚焦时方向键/翻页键/Home/End 由 handleKeyDown 接管为翻句，失焦后照旧交给
    /// 正文滚动。非 @Published：不驱动渲染，避免焦点变化引发全树重渲。
    var playScrubberFocused = false

    /// 输入焦点守卫（对齐 useEscapeClose.ts:12-13 注释：输入中按 Esc 是「撤销输入」
    /// 而非「关浮层」）。窗口控制器把全部 keyDown 都交到 handleKeyDown，由这里逐键位
    /// 施加 typing 守卫（阅读页全局键让路；vault focus 态 Esc/Tab 例外）——vm 被单测
    /// 或其他入口直接调用时语义一致。
    /// 只认可编辑的 NSTextView（含字段编辑器）或 NSTextField：阅读正文
    /// （ReaderTextView/ProseFlowTextView）是 isEditable=false、isSelectable=true 的
    /// 只读视图，点一下词句就会成为第一响应者；若一并算输入，Space/J/K/L/H/E 会在
    /// 点过正文后全部失效（Windows isTyping 只认 input/textarea/contentEditable，
    /// ReaderApp.tsx:2097-2105）。
    static func textInputHasFocus(in window: NSWindow?) -> Bool {
        guard let responder = window?.firstResponder else { return false }
        if responder is NSTextField {
            return true
        }
        if let textView = responder as? NSTextView {
            return textView.isEditable
        }
        return false
    }

    /// 浮层 Esc 统一收尾（SHELL-10 / READ-10）：一次只收最上层，层序按 ReaderRootView
    /// 的 overlay 叠放——差词抽屉（ShadowDrill.tsx:161）→ 阅读设置抽屉
    ///（SettingsDrawer.tsx:141）→ 书架浮层（ReaderShelf.tsx:45，第一轮已落地）。
    /// 返回 true = 已消费；false = 没有可收的浮层。
    @discardableResult
    func dismissTopOverlayOnEscape() -> Bool {
        // 阅读设置浮层是阅读页内最上层的浮层（ReadingView.tsx:377-403 自己的 Esc 监听）。
        if readingSettingsPopShown {
            readingSettingsPopShown = false
            return true
        }
        if drill.state.shown {
            drill.close()
            return true
        }
        if settingsDrawerShown {
            settingsDrawerShown = false
            return true
        }
        if folioOpen {
            closeFolio()
            return true
        }
        return false
    }

    /// 「笔记与复习」focus 态 Esc = 退出专注（VaultPage.tsx:816-820）：只切档回
    /// 复习首页，不清 focusReviewIds（专注队列续跑，底部切换器「专注复习」可回来）。
    /// 返回 true = 已消费（当前在 vault + focus）。
    @discardableResult
    func exitFocusModeOnEscape() -> Bool {
        guard route == .vault, vaultPlayMode == .focus else { return false }
        vaultPlayMode = .home
        return true
    }

    /// READ-6 键盘滑杆按键 → 目标语（已夹到 0...total-1；nil = 不是滑杆键或无句子）：
    /// →/↑ +1、←/↓ −1（PlayBar.tsx:227-244 的四方向同义）、PageUp/PageDown ±10、
    /// Home 首句、End 末句。
    static func scrubberTarget(for event: NSEvent, idx: Int, total: Int) -> Int? {
        guard total > 0 else { return nil }
        switch event.keyCode {
        case rightArrowKeyCode, upArrowKeyCode:
            return min(total - 1, idx + 1)
        case leftArrowKeyCode, downArrowKeyCode:
            return max(0, idx - 1)
        case pageDownKeyCode:
            return min(total - 1, idx + 10)
        case pageUpKeyCode:
            return max(0, idx - 10)
        case homeKeyCode:
            return 0
        case endKeyCode:
            return total - 1
        default:
            return nil
        }
    }

    func handleKeyDown(_ event: NSEvent) -> Bool {
        let typing = Self.textInputHasFocus(in: attachedWindow)
        if event.keyCode == Self.escapeKeyCode {
            if typing {
                // 焦点在输入框：focus 态 Esc 仍是退出语义（Windows 不受 typing 守卫），
                // 其余场景交还系统行为（撤销输入/取消编辑）。
                return exitFocusModeOnEscape()
            }
            if dismissTopOverlayOnEscape() { return true }
            if exitFocusModeOnEscape() { return true }
        }
        if route == .vault {
            // 「笔记与复习」四态容器（home Enter / focus Tab·H·Enter·1-3 等键位
            // 由当前档位的视图注入；typing 守卫由其按键位施加——Tab 在输入框内仍是下一级提示）。
            return reviewKeyHandler?(event) ?? false
        }
        guard route == .reading else { return false }
        // 阅读页全局键（Space/J/K/L/H/E）在输入框内一律让路（ReaderApp.tsx:2096-2129 非输入态；
        // 挖空输入 / 译文编辑 / 检索框自接管按键）。
        guard !typing else { return false }
        readingSession.noteInteraction(now: Date.timeIntervalSinceReferenceDate)
        // READ-6 键盘滑杆：进度条聚焦时接管翻句键，复用 jumpTo（播放中跳读、
        // 未播放只移光标）；未聚焦时方向键照旧流向正文滚动。
        if playScrubberFocused, let total = article?.sentences.count, total > 0,
           let target = Self.scrubberTarget(for: event, idx: activeSentenceIdx, total: total) {
            jumpTo(idx: target)
            return true
        }
        guard let key = event.charactersIgnoringModifiers?.lowercased() else { return false }
        if key == " " || key == "k" {
            togglePlayback()
            return true
        }
        if key == "j" { jumpTo(idx: activeSentenceIdx + 1); return true }
        if key == "l" { jumpTo(idx: activeSentenceIdx - 1); return true }
        if key == "h" {
            // H 按住显影（Windows ReaderApp.tsx:2122-2124）：仅遮罩或随读抽查开启时
            // 有意义（显影译文 / 挖空答案），其余场景不消费。
            if effectiveSettings.maskTranslation || effectiveSettings.spotQuizEnabled {
                peekAll = true
                return true
            }
            return false
        }
        if key == "e" {
            // E 句子解析（ReaderApp.tsx ReadingView.tsx:396）：仅解析面板 idle
            // 速览态触发，已解析/解析中/失败的句子不重复发请求。
            if article != nil, xrayIdleForCurrent {
                openXray(idx: activeSentenceIdx)
                return true
            }
            return false
        }
        return false
    }

    func handleKeyUp(_ event: NSEvent) {
        guard let key = event.charactersIgnoringModifiers?.lowercased() else { return }
        if key == "h" { peekAll = false }
    }

    // MARK: - Toast

    func showToast(_ message: String, action: ToastAction? = nil) {
        toast = message
        // 主窗 toast 动作位同款（ReaderApp.tsx:2806-2817）：配额耗尽文案自动带上
        // 「兑换更多额度」按钮（分类口径与口语页错误位一致——含「额度已用完」）。
        let resolvedAction = action ?? (speakFriendlyNotice(message).kind == .redeem ? Self.redeemQuotaToastAction : nil)
        toastAction = resolvedAction
        // 带「兑换更多额度」动作的 toast 停留 8s（对齐 ReaderApp.tsx showToast
        // `action ? 8000 : 3200`，08595f3）；其余维持 3.2s。
        let lingering = resolvedAction?.title == Self.redeemQuotaToastAction.title
            || resolvedAction?.title == Self.resumeTranslateToastTitle
        let durationNs: UInt64 = lingering ? 8_000_000_000 : 3_200_000_000
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: durationNs)
            guard !Task.isCancelled else { return }
            self?.toast = ""
            self?.toastAction = nil
        }
    }

    /// 限流暂停 toast 的「继续翻译」按钮：重跑主管线认领剩余 pending 段
    ///（带动作的 toast 与「兑换更多额度」同样停留 8s）。
    private static let resumeTranslateToastTitle = "继续翻译"

    /// 配额耗尽 toast 的「兑换更多额度」按钮：跳设置账号分区兑换码卡（与口语页
    /// 错误位同一落点，AppDelegate.openAccountRedeem）。
    private static let redeemQuotaToastAction = ToastAction(title: "兑换更多额度") {
        (NSApp.delegate as? AppDelegate)?.openAccountRedeem()
    }
}

// MARK: - 小工具

private extension SentencePair {
    func withRevealed(_ value: Bool) -> SentencePair {
        var copy = self
        copy.revealed = value
        return copy
    }
}

private extension Array {
    func inserting(_ element: Element, at index: Int) -> Array {
        var copy = self
        let clamped = Swift.min(Swift.max(0, index), copy.count)
        copy.insert(element, at: clamped)
        return copy
    }
}
