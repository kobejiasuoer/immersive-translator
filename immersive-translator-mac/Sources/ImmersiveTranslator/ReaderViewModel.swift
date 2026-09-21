import SwiftUI
import Combine
import ReaderCore

/// 沉浸阅读室组合根（ReaderApp.tsx 的 Mac 对应物）。
///
/// 职责：加载数据（文章/生词/设置）、驱动翻译管线（段级流式 + 单段重试 +
/// 手改译文）、词典栏、遮罩、复习入口与全部入口状态。落盘走 ReaderStore，
/// 文章保存带 700ms 防抖。
@MainActor
final class ReaderViewModel: ObservableObject {
    enum Route: Equatable {
        case reading
        case review
        case notes
        case speak
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

    // ---- 数据 ----
    @Published var globalSettings: ReaderSettings
    @Published var articleList: [ArticleSummary] = []
    @Published var article: Article?
    @Published var vocabWords: [VocabWord] = []
    @Published var reviewLog: ReviewLogFile = .empty
    @Published var route: Route = .reading
    @Published var toast: String = ""
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

    let store: ReaderStore
    private let chat: ReaderChatClient
    let playback = ReaderPlaybackEngine()
    private var cancellables = Set<AnyCancellable>()
    private var saveTask: Task<Void, Never>?
    private var translationTask: Task<Void, Never>?
    private var translationRunID = 0
    private var toastTask: Task<Void, Never>?
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
    private let leadSpeaker = LeadSpeaker()
    /// 口语陪练控制器（R3）。
    let speak = SpeakViewController()


    init(settingsStore: SettingsStore, store: ReaderStore = .shared) {
        self.store = store
        self.chat = ReaderChatClient(settingsStore: settingsStore)
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
            self?.leadSpeaker.speak(text, rate: ShadowAssessController.leadRate, completion: done)
        }
        assess.stopLead = { [weak self] in
            self?.leadSpeaker.stop()
        }
        assess.onAdvance = { [weak self] in
            self?.playback.continueAfterShadowing()
        }
        playback.$shadowingWait
            .dropFirst()
            .removeDuplicates()
            .sink { [weak self] waiting in
                guard let self else { return }
                let settings = self.effectiveSettings
                if waiting, settings.shadowingMode, settings.shadowingAssess {
                    self.assess.begin(idx: self.activeSentenceIdx)
                } else {
                    self.assess.cancelAssess()
                }
            }
            .store(in: &cancellables)
    }

    private func handlePlaybackEvent(_ event: ReaderPlaybackEngine.Event) {
        switch event {
        case .activeIdx(let idx):
            activeSentenceIdx = idx
        case .finished:
            let id = article?.id ?? ""
            let lookups = dictLookupCounts[id] ?? 0
            let added = vocabWords.filter { $0.source.articleId == id }.count
            showToast("本篇读完 🎉 共查词 \(lookups) 次 · 生词本新增 \(added) 个")
        case .failed(let message):
            showToast("朗读失败：\(message)")
        }
    }

    /// 当前文章句文与播放设置同步给引擎。
    private func syncPlaybackContext() {
        let settings = effectiveSettings
        XfyunTtsEngine.shared.updateVoiceConfig(XfyunTtsEngine.VoiceConfig(
            vcnCn: settings.cloudVoice,
            vcnEn: settings.cloudVoiceEn
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

    func stopPlayback() {
        playback.stop()
    }

    /// 朗读某一句（播放条喇叭按钮 / 中文行定位）。
    func speakSentence(_ idx: Int) {
        jumpTo(idx: idx, autoplay: true)
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

    func bootstrap(pendingImportText: String? = nil, openReview: Bool = false) {
        globalSettings = store.loadGlobalReaderSettings()
        refreshVocab()
        let list = (try? store.listArticles()) ?? []
        articleList = list
        if let text = pendingImportText, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            importPaste(text)
            return
        }
        if openReview {
            route = .review
            return
        }
        if let first = list.first {
            openArticle(id: first.id)
        }
    }

    func refreshVocab() {
        if let file = try? store.getVocabFile() {
            vocabWords = file.words
            reviewLog = file.reviewLog
            loadSourceArticles(ids: file.words.map(\.source.articleId))
        }
    }

    // MARK: - 文章打开 / 列表

    func refreshArticleList() {
        articleList = (try? store.listArticles()) ?? []
    }

    func openArticle(id: String) {
        guard let full = (try? store.getArticle(id: id)) ?? nil else { return }
        translationTask?.cancel()
        translationRunID += 1
        route = .reading
        dict = .closed
        searchMatchIdx = nil
        article = full
        activeSentenceIdx = min(full.progress.sentenceIdx, max(0, full.sentences.count - 1))
        sourceCache[full.id] = full
        playback.reset(startIdx: activeSentenceIdx)
        syncPlaybackContext()
        scheduleSave(mutate: { $0.lastReadAt = Int64(Date().timeIntervalSince1970 * 1000) })
        runTranslationPipeline(for: full.id)
    }

    func deleteArticle(id: String) {
        _ = try? store.deleteArticle(id: id)
        refreshArticleList()
        refreshVocab()
        if article?.id == id {
            article = nil
            activeSentenceIdx = 0
            playback.reset(startIdx: 0)
            syncPlaybackContext()
            if let first = articleList.first {
                openArticle(id: first.id)
            }
        }
        showToast("文章已删除")
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
            showToast("已导入「\(built.title)」")
        } catch {
            showToast("导入失败：\((error as? LocalizedError)?.errorDescription ?? "\(error)")")
        }
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

    func jumpTo(idx: Int, autoplay: Bool = false) {
        guard let total = article?.sentences.count, total > 0 else { return }
        let clamped = min(max(0, idx), total - 1)
        playback.jumpTo(clamped, autoplay: autoplay)
        if !playback.playing {
            // 未播放：引擎只移动光标；这里同步高亮（播放中由引擎事件驱动）。
            if clamped != activeSentenceIdx {
                activeSentenceIdx = clamped
            }
        }
    }

    /// 滚动到哪 = 读到哪：未播放（且非跟读等待）时光标跟随视口。
    func viewportMoved(to idx: Int) {
        guard !playback.playing, !playback.shadowingWait else { return }
        if idx != activeSentenceIdx {
            activeSentenceIdx = idx
            playback.setActiveCursor(idx)
        }
    }

    /// 阅读进度（断点续读 + 墨线）。
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
        }
    }

    // MARK: - 词典（屏 C）

    func lookup(query raw: String, sentenceIdx: Int) {
        guard let cleaned = extractSelectionText(raw) else { return }
        let articleID = article?.id ?? ""
        dictLookupCounts[articleID, default: 0] += 1
        dict = .loading(query: cleaned, sentenceIdx: sentenceIdx)
        Task { [weak self] in
            await self?.performLookup(query: cleaned, sentenceIdx: sentenceIdx)
        }
    }

    private func performLookup(query: String, sentenceIdx: Int) async {
        let target = chat.resolveTarget(for: query)
        do {
            let raw = try await chat.complete(
                systemPrompt: buildReaderDictPrompt(targetLanguage: target, glossaryText: chat.glossaryText),
                userText: query
            )
            switch parseReaderDictResponse(raw) {
            case .entry(let entry):
                dict = .ready(query: query, entry: entry, sentenceIdx: sentenceIdx)
            case .notAWord:
                dict = .notAWord(query: query, sentenceIdx: sentenceIdx)
            case .invalid:
                dict = .error(query: query, sentenceIdx: sentenceIdx, message: "返回格式无法解析，请重试")
            }
        } catch {
            dict = .error(query: query, sentenceIdx: sentenceIdx, message: (error as? LocalizedError)?.errorDescription ?? "\(error)")
        }
    }

    var isInVocab: Bool {
        guard let key = dict.query else { return false }
        return vocabWords.contains { $0.id == normalizeWordKey(key) }
    }

    /// 点正文词块下划线 → 即时卡（无 LLM 调用）。
    func openChunkCard(chunk: SentenceChunk, sentenceIdx: Int) {
        dict = .chunkCard(chunk: chunk, sentenceIdx: sentenceIdx)
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
        return sourceCache[articleId]?.title ?? articleList.first { $0.id == articleId }?.article.title
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
        } catch {
            showToast("保存复习记录失败")
        }
    }

    func openReading() {
        focusReviewIds = nil
        route = .reading
    }

    func openReview() {
        focusReviewIds = nil
        route = .review
        reviewPos = 0
        loadSourceArticles(ids: vocabWords.map(\.source.articleId))
        refreshNotes()  // 「N 未整理」角标需要笔记覆盖数据
    }

    /// 笔记复盘区「只测仍错的词」：只排这批词，不等到期。
    func startFocusReview(ids: [String]) {
        guard !ids.isEmpty else {
            showToast("这篇笔记的词这一轮都通过了，没有要补的")
            return
        }
        focusReviewIds = ids
        reviewPos = 0
        route = .review
    }

    // MARK: - 笔记库

    func openNotes() {
        focusReviewIds = nil
        route = .notes
        refreshNotes()
    }

    func openSpeak() {
        focusReviewIds = nil
        route = .speak
        speak.refreshRecent()
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

    // MARK: - 键盘（空格仅阅读器内生效；J/K/L 备选；H 暂显全部译文）

    func handleKeyDown(_ event: NSEvent) -> Bool {
        if route == .review {
            return reviewKeyHandler?(event) ?? false
        }
        guard route == .reading else { return false }
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

    func showToast(_ message: String) {
        toast = message
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_200_000_000)
            guard !Task.isCancelled else { return }
            self?.toast = ""
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
