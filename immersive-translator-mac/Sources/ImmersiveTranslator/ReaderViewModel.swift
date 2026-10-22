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
    /// 顶部导航岛三档由 `islandSurface` 归并高亮（shelf/reading→阅读、review/notes→笔记与复习）。
    enum Route: Equatable {
        case shelf
        case reading
        case review
        case notes
        case speak

        /// ReaderCore 的纯数据镜像（导航岛归并 / 面名计算走核心函数，可单测）。
        var kind: ReaderRouteKind {
            switch self {
            case .shelf: return .shelf
            case .reading: return .reading
            case .review: return .review
            case .notes: return .notes
            case .speak: return .speak
            }
        }
    }

    /// 「笔记与复习」三档玩法（v0.8 VaultPlayMode）：记忆胶带手账 /
    /// 3 分钟快刷闯关 / Markdown 笔记导出。跨视图进入保留上次档位；
    /// 显式入口各自落档——复习类入口落挑战档（对齐 Windows goReview），
    /// 笔记库入口落 md 档（goNotes），托盘「生词本」→ 挑战档。
    enum VaultPlayMode: String, Equatable {
        case tape
        case challenge
        case md

        var label: String {
            switch self {
            case .tape: return "记忆胶带手账（点按自测）"
            case .challenge: return "3 分钟快刷闯关（填空 / 听音 / 开口）"
            case .md: return "Markdown 笔记导出"
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
        }
    }
    /// 「笔记与复习」当前玩法档（三合一容器顶栏高亮来源；Windows 初始 tape）。
    @Published var vaultPlayMode: VaultPlayMode = .tape
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
    @Published var translating: StepProgress?
    @Published var chunking: ChunkProgress?
    @Published var dict: DictPanel = .closed
    @Published var searchMatchIdx: Int?
    @Published var activeSentenceIdx: Int = 0
    @Published var peekAll = false
    @Published var importSheetShown = false
    @Published var settingsDrawerShown = false
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
    private var translationRunID = 0
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
    /// 笔记存储（与 ReaderStore 同一应用支持目录下的 notes/）。
    let noteStore = NoteStore()
    /// 跟读评测状态机（shadowingMode + shadowingAssess 时接管跟读等待）。
    let assess = ShadowAssessController()
    /// 差词训练控制器（报告卡「只练 N 个词」落点；UI 直观察它，不经 vm 转发）。
    let drill = ShadowDrillController()
    /// 「听我的录音」回放器（最近一次跟读录音，内存 PCM）。
    private let shadowPlayer = ShadowRecordingPlayer()
    private let leadSpeaker = LeadSpeaker()
    /// 口语陪练控制器（R3）。
    let speak = SpeakViewController()


    /// 生产入口（ReaderWindowController）：LLM 通道由 SettingsStore 驱动的 ReaderChatClient。
    convenience init(settingsStore: SettingsStore, store: ReaderStore = .shared) {
        self.init(chat: ReaderChatClient(settingsStore: settingsStore), store: store)
    }

    /// 指定初始化器：注入 LLM 通道。单测用替身通道——`SettingsStore()` 初始化会读
    /// Keychain，xctest 不在钥匙串条目 ACL 上时会弹授权窗把测试挂死（R2-READ 实测），
    /// 所以 vm 级用例一律走这里，不碰 Keychain / 网络。
    init(chat: any ReaderChatChannel, store: ReaderStore = .shared) {
        self.store = store
        self.chat = chat
        self.globalSettings = store.loadGlobalReaderSettings()

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
        NotificationCenter.default.publisher(for: .readerArticleAdded)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.refreshArticleList() }
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
        mergeReaderSettings(globalSettings, article?.settings)
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
    func bootstrap(pendingImportText: String? = nil, openReview: Bool = false, openBookId: String? = nil) {
        globalSettings = store.loadGlobalReaderSettings()
        refreshVocab()
        refreshBooks()
        refreshNotes()  // 「笔记与复习」角标（到期 + 未整理）启动即准
        let list = (try? store.listArticles()) ?? []
        articleList = list
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
        if let file = try? store.getVocabFile() {
            vocabWords = file.words
            reviewLog = file.reviewLog
            readSecondsToday = readingSeconds(
                in: file.readingLog ?? [],
                day: dayKey(nowMs: Int64(Date().timeIntervalSince1970 * 1000))
            )
            loadSourceArticles(ids: file.words.map(\.source.articleId))
            ReviewTouchpointManager.shared.refreshBadge()
        }
    }

    // MARK: - 文章打开 / 列表

    func refreshArticleList() {
        articleList = (try? store.listArticles()) ?? []
    }

    func refreshBooks() {
        bookList = (try? store.listBooks()) ?? []
    }

    func openArticle(id: String) {
        guard let full = (try? store.getArticle(id: id)) ?? nil else { return }
        settleReadingSeconds()  // 上一章的未落盘秒数先写库；本章用时重新累计
        translationTask?.cancel()
        translationRunID += 1
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
        runTranslationPipeline(for: full.id)
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
        translationTask?.cancel()
        translationRunID += 1
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

    /// 书卡/导入后进书：直达书级断点章（断点章缺失时回落第一章）。
    func openBookAt(bookId: String) {
        guard let book = bookList.first(where: { $0.id == bookId }), !book.chapters.isEmpty else { return }
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
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard !Task.isCancelled, let self else { return }
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
        translationTask?.cancel()
        translationRunID += 1
        let runID = translationRunID
        translationTask = Task { [weak self] in
            await self?.ensureTranslated(articleID: articleID, runID: runID)
        }
    }

    private func isCurrentRun(_ articleID: String, _ runID: Int) -> Bool {
        article?.id == articleID && runID == translationRunID
    }

    private func ensureTranslated(articleID: String, runID: Int) async {
        guard let input = article, input.id == articleID else { return }
        let configured = (try? chat.configuration()) != nil
        guard configured else {
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
        if !titlePending, pendingGroups.isEmpty {
            await MainActor.run { self.translating = nil }
            return
        }

        await MainActor.run {
            self.translating = StepProgress(done: 0, total: pendingGroups.count + (titlePending ? 1 : 0))
        }

        func patch(_ mutate: @escaping (inout Article) -> Void) {
            guard isCurrentRun(articleID, runID) else { return }
            self.scheduleSave(mutate: mutate)
        }

        if titlePending {
            do {
                let cn = try await chat.complete(
                    systemPrompt: buildTitleTranslateSystemPrompt(target: target),
                    userText: input.title
                )
                let line = cn
                    .components(separatedBy: .newlines)
                    .first?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                patch { a in
                    if !line.isEmpty {
                        a.titleCn = line
                        a.titleCnState = .done
                    } else {
                        a.titleCnState = .failed
                    }
                }
            } catch {
                patch { $0.titleCnState = .failed }
            }
            await MainActor.run {
                if isCurrentRun(articleID, runID) {
                    self.translating?.done += 1
                }
            }
        }

        for (_, sentences) in pendingGroups {
            guard isCurrentRun(articleID, runID) else { return }
            await translateParagraph(sentences, target: target, articleID: articleID, runID: runID)
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

    private func translateParagraph(
        _ sentences: [SentencePair],
        target: String,
        articleID: String,
        runID: Int
    ) async {
        let expected = sentences.count
        let numberedInput = buildParagraphRequestInput(sentences.map(\.en))
        let systemPrompt = buildParagraphTranslateSystemPrompt(
            targetLanguage: target,
            customStyle: chat.customStyle,
            glossaryText: chat.glossaryText
        )

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
            guard let parsed = parseParagraphResponse(finalText, expectedCount: expected) else {
                patchGroup { st in
                    var next = st
                    next.zhState = .failed
                    return next
                }
                return
            }
            patchGroup { st in
                var next = st
                if let i = sentences.firstIndex(where: { $0.idx == st.idx }) {
                    next.zh = parsed[i]
                    next.zhState = .done
                }
                return next
            }
        } catch {
            guard isCurrentRun(articleID, runID) else { return }
            patchGroup { st in
                var next = st
                next.zhState = .failed
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
        var marked = 0
        var anyError = false
        var done = 0
        for batch in batches {
            guard article?.id == articleID else { return } // 切走文章，整批终止
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

    /// 单段重试：把该段失败句重置回 pending 后单独重跑。
    func retryParagraph(_ paragraphIdx: Int) {
        scheduleSave { a in
            a.sentences = a.sentences.map { st in
                guard st.paragraphIdx == paragraphIdx, st.zhState == .failed else { return st }
                var next = st
                next.zh = nil
                next.zhState = .pending
                return next
            }
        }
        guard let current = article else { return }
        translationTask?.cancel()
        translationRunID += 1
        let runID = translationRunID
        let target = chat.resolveTarget(for: current.sentences.first?.en ?? current.title)
        let group = current.sentences.filter { $0.paragraphIdx == paragraphIdx && $0.zhState == .pending }
        guard !group.isEmpty else { return }
        translating = StepProgress(done: 0, total: 1)
        translationTask = Task { [weak self] in
            await self?.translateParagraph(group, target: target, articleID: current.id, runID: runID)
            await MainActor.run {
                if self?.isCurrentRun(current.id, runID) == true { self?.translating = nil }
            }
        }
    }

    func retryTitle() {
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
        bookSaveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            guard !Task.isCancelled, let self else { return }
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

    /// 透镜卡 / 折叠卡 / 刊头「用这句（围绕本章）练口语」：记 pendingSpeak book
    /// 意图再进口语（ReaderApp.tsx:1625 practiceSentence 的 pendingSpeak 通道，
    /// 消费在 openSpeak）：该句进摘要首位，口语侧开场白自然从这句聊起。
    func practiceSentence(idx: Int) {
        guard let current = article,
              let en = current.sentences[safe: idx]?.en,
              !en.isEmpty else { return }
        pendingSpeak = PendingSpeakIntent(kind: .book(articleId: current.id, sentenceIdx: idx))
        openSpeak()
        showToast("已带入第 \(idx + 1) 句进入口语对话")
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

    /// 复习卡「回到原文」：切到阅读视图并定位该句。
    func jumpToSource(articleId: String, sentenceIdx: Int) {
        guard !articleId.isEmpty else { return }
        if article?.id == articleId {
            route = .reading
        } else {
            openArticle(id: articleId)
        }
        jumpTo(idx: sentenceIdx)
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
    func gradeVocab(
        _ word: VocabWord,
        _ grade: ReviewGrade,
        mode: RecallMode,
        verdict: RecallVerdict?
    ) {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var graded = word
        graded.srs = gradeSrs(word.srs, grade, now: now)
        let bucket = recallBucket(mode: mode, judged: verdict, grade: grade)
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
        focusReviewIds = nil
        if !keepFolio { folioOpen = false }
        route = .shelf
    }

    func openReading() {
        focusReviewIds = nil
        route = .reading
    }

    func openReview() {
        focusReviewIds = nil
        // 复习类入口统一落挑战档（对齐 Windows goReview → vault·challenge；
        // 托盘/菜单「生词本」经 bootstrap(openReview:) 走到这里）。
        vaultPlayMode = .challenge
        route = .review
        reviewPos = 0
        loadSourceArticles(ids: vocabWords.map(\.source.articleId))
        refreshNotes()  // 「N 未整理」角标需要笔记覆盖数据
        refreshSpeakSessions()  // 手账口语改进行
    }

    /// 进入「笔记与复习」档但保留上次玩法档（导航岛第三档；Windows
    /// navigateSurface(vault) 已在 vault 内不重置模式）。
    func openVault() {
        route = .review
        loadSourceArticles(ids: vocabWords.map(\.source.articleId))
        refreshNotes()
        refreshSpeakSessions()
    }

    /// 导航岛三档路由（对齐 ReaderApp.tsx:1647 navigateSurface）：切档先收书架浮层；
    /// 阅读档没有打开的文章时续读最近一篇/一本（都没有才落空态）；
    /// 「笔记与复习」档已在 review/notes 内时不重置（Windows「已在 vault 不重置玩法档」）。
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
            if route == .review || route == .notes { return }
            openVault()
        }
    }

    /// 导航岛当前高亮档（shelf/reading→阅读、speak→口语、review/notes→笔记与复习）。
    var islandSurface: IslandSurface {
        IslandSurface(folding: route.kind)
    }

    /// 「笔记与复习」档角标 = 到期数 + 未整理数；收藏 / 评分 / 生成笔记后随 @Published 数据实时变。
    var vaultBadge: Int {
        vaultBadgeCount(dueNow: stats.dueNow, unnotedCount: unnotedWordCount)
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

    /// 书架浮层「＋ 导入文件」：开导入向导并收起浮层（Windows FolioSheet onOpenImport + onClose）。
    func openImportFromFolio() {
        folioOpen = false
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

    /// 笔记复盘区「只测仍错的词」：只排这批词，不等到期。
    func startFocusReview(ids: [String]) {
        guard !ids.isEmpty else {
            showToast("这篇笔记的词这一轮都通过了，没有要补的")
            return
        }
        focusReviewIds = ids
        reviewPos = 0
        // 弱项加练直落挑战档（对齐 Windows onStartFocusReview → vaultMode challenge）。
        vaultPlayMode = .challenge
        route = .review
    }

    // MARK: - 笔记库

    func openNotes() {
        focusReviewIds = nil
        // 笔记库入口落 md 档（对齐 Windows goNotes → vault·md），.notes 路由兼容保留。
        vaultPlayMode = .md
        route = .notes
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
        focusReviewIds = nil
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

    func deleteNote(file: String) {
        _ = try? noteStore.delete(file: file)
        if activeNoteFile == file {
            activeNoteFile = nil
            activeNote = nil
        }
        refreshNotes()
        showToast("笔记已删除")
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
    /// 而非「关浮层」）。窗口控制器派发层已挡第一道（ReaderWindowController 的本地
    /// 监听对 NSTextView/NSTextField 聚焦时直接放行系统），这里挡第二道——
    /// vm 被单测或其他入口直接调用时语义一致。
    static func textInputHasFocus(in window: NSWindow?) -> Bool {
        guard let responder = window?.firstResponder else { return false }
        return responder is NSTextView || responder is NSTextField
    }

    /// 浮层 Esc 统一收尾（SHELL-10 / READ-10）：一次只收最上层，层序按 ReaderRootView
    /// 的 overlay 叠放——差词抽屉（ShadowDrill.tsx:161）→ 阅读设置抽屉
    ///（SettingsDrawer.tsx:141）→ 书架浮层（ReaderShelf.tsx:45，第一轮已落地）。
    /// 返回 true = 已消费；false = 没有可收的浮层。
    @discardableResult
    func dismissTopOverlayOnEscape() -> Bool {
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
        if event.keyCode == Self.escapeKeyCode {
            // 焦点在输入框：不收浮层，交还系统行为（撤销输入/取消编辑）。
            if Self.textInputHasFocus(in: attachedWindow) { return false }
            if dismissTopOverlayOnEscape() { return true }
        }
        if route == .review || route == .notes {
            // 「笔记与复习」三合一容器（review/notes 两条兼容路由共用一套键盘处理，
            // 由当前档位的视图注入）。
            return reviewKeyHandler?(event) ?? false
        }
        guard route == .reading else { return false }
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
            peekAll = true
            return true
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
        toastAction = action
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_200_000_000)
            guard !Task.isCancelled else { return }
            self?.toast = ""
            self?.toastAction = nil
        }
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
