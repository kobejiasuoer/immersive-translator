import XCTest
import ReaderCore
@testable import ImmersiveTranslator

/// 翻译 429 自动退避与失败原因透出（vm 级）——Mac 先行版语义（2026-11-05
/// Happy Prince 批量判死复盘）：仅结构化 429 触发重试、等待优先服务端
/// Retry-After、连续 429 熔断 + 整篇预算按段数比例，预算耗尽**整篇暂停**（句子
/// 保持 pending + toast「继续翻译」），不再把剩余段逐个判死；失败按状态码三桶
/// 写 zhError、parse 对齐失败不写原因、手动重试清 zhError 开新 run。
/// 复用 ReaderShellChromeTests 的夹具思路（替身通道 + 临时目录落盘，不碰 Keychain/网络）。
final class ReaderTranslateBackoffTests: XCTestCase {
    private static let text429 = "翻译请求太频繁，已重试仍被限流，稍后点重试"
    private static let text401 = "翻译接口返回 401：请到 设置 → 模型服务 检查 API Key 与接口地址，或切换服务商再试"
    private static let textFallback = "翻译服务暂时不可用，请稍后点重试"

    // MARK: - 夹具

    /// 脚本盒（actor）：流式/非流式各一条队列，按序吐出结果并计数。
    private actor ScriptBox {
        private var script: [Result<String, Error>] = []
        private(set) var calls = 0

        func enqueue(_ result: Result<String, Error>) {
            script.append(result)
        }

        func next() throws -> String {
            calls += 1
            guard let first = script.first else {
                throw ReaderChatClient.ReaderChatError.missingAPIKey
            }
            script.removeFirst()
            switch first {
            case .success(let text): return text
            case .failure(let error): throw error
            }
        }

        var queued: Int { script.count }
    }

    /// LLM 通道替身：标题走 title 盒、段落流式走 stream 盒；配置恒有效，
    /// isPlatform 可切换（限速用例：沉浸云判定来自 Configuration.isPlatformProvider）。
    private final class ScriptedChat: ReaderChatChannel {
        let titleBox = ScriptBox()
        let streamBox = ScriptBox()
        var isPlatform = false
        var glossaryText: String { "" }
        var customStyle: String { "" }

        func configuration() throws -> ReaderChatClient.Configuration {
            ReaderChatClient.Configuration(
                url: URL(string: "https://gateway.example/v1/chat/completions")!,
                apiKey: "test-key",
                model: "test-model",
                isPlatformProvider: isPlatform
            )
        }

        func resolveTarget(for sample: String) -> String { "简体中文" }

        func complete(systemPrompt: String, userText: String) async throws -> String {
            try await titleBox.next()
        }

        func completeStreaming(
            systemPrompt: String,
            userText: String,
            onDelta: @escaping (String) -> Void
        ) async throws -> String {
            try await streamBox.next()
        }
    }

    /// 在途闸门：段落流式请求挂在 wait() 上（记录请求原文），测试 open(_:) 放行。
    private actor StreamGate {
        private var waiters: [CheckedContinuation<String, Error>] = []
        private(set) var requests: [String] = []

        func wait(_ userText: String) async throws -> String {
            requests.append(userText)
            return try await withCheckedThrowingContinuation { waiters.append($0) }
        }

        func open(_ value: String) {
            guard !waiters.isEmpty else { return }
            waiters.removeFirst().resume(returning: value)
        }

        var waiting: Int { waiters.count }
    }

    /// 可中途「清空接口配置」的通道替身：configured=false 时 configuration() 抛错
    ///（= 未配置 / 读配置失败，ensureTranslated 首个 guard 早退 toast）；段落请求挂闸门。
    private final class SwitchableChat: ReaderChatChannel {
        let gate = StreamGate()
        @MainActor var configured = true
        var glossaryText: String { "" }
        var customStyle: String { "" }

        @MainActor
        func configuration() throws -> ReaderChatClient.Configuration {
            guard configured else { throw ReaderChatClient.ReaderChatError.missingAPIKey }
            return ReaderChatClient.Configuration(
                url: URL(string: "https://gateway.example/v1/chat/completions")!,
                apiKey: "test-key",
                model: "test-model"
            )
        }

        func resolveTarget(for sample: String) -> String { "简体中文" }

        func complete(systemPrompt: String, userText: String) async throws -> String {
            throw ReaderChatClient.ReaderChatError.missingAPIKey
        }

        func completeStreaming(
            systemPrompt: String,
            userText: String,
            onDelta: @escaping (String) -> Void
        ) async throws -> String {
            try await gate.wait(userText)
        }
    }

    @MainActor
    private func makeVM(chat: any ReaderChatChannel) -> ReaderViewModel {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("reader-backoff-\(UUID().uuidString)", isDirectory: true)
        return ReaderViewModel(chat: chat, store: ReaderStore(baseDirectory: dir))
    }

    /// 一段两句的 pending 文章（标题已翻完，不进标题分支）。
    @MainActor
    private func pendingArticle() -> Article {
        Article(
            id: "backoff-a1",
            title: "Tide",
            titleCn: "潮",
            titleCnState: .done,
            createdAt: 0,
            lastReadAt: 0,
            sentences: [
                SentencePair(idx: 0, paragraphIdx: 0, en: "One sentence."),
                SentencePair(idx: 1, paragraphIdx: 0, en: "Two sentence.")
            ]
        )
    }

    private func waitUntil(
        _ what: String,
        timeoutMs: Int = 3_000,
        _ cond: @escaping @MainActor () async -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
        while Date() < deadline {
            if await cond() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("等待「\(what)」超时")
    }

    // MARK: - 段级 429 退避与失败原因

    /// 持续 429：连续熔断（阈值 10）后**整篇暂停**——句子保持 pending、无 zhError、
    /// 返回 pausedRateLimited（不再逐段判死）。管线级断言见
    /// testPipelinePausesOnSustained429WithToastAndResume。
    @MainActor
    func testPersistent429CircuitBreaksAndLeavesPending() async {
        let chat = ScriptedChat()
        let limited = ReaderChatClient.ReaderChatError.http(status: 429, message: "rate limited", retryAfterSeconds: nil)
        for _ in 0..<ReaderCore.translateMaxConsecutive429 {
            await chat.streamBox.enqueue(.failure(limited))
        }
        let vm = makeVM(chat: chat)
        vm.translateBackoffWaitMsOverride = 10
        let article = pendingArticle()
        vm.article = article
        let group = article.sentences

        let backoffs = ReaderViewModel.TranslateBackoffCounter()
        let outcome = await vm.translateGroupWithBackoff(
            group,
            target: "简体中文",
            articleID: article.id,
            runID: 0,
            backoffs: backoffs,
            totalGroups: 1
        )

        let calls = await chat.streamBox.calls
        XCTAssertEqual(calls, ReaderCore.translateMaxConsecutive429, "连续 429 到熔断阈值即停，不再发请求")
        XCTAssertEqual(outcome, .pausedRateLimited)
        XCTAssertEqual(backoffs.consecutive429s, ReaderCore.translateMaxConsecutive429)
        XCTAssertEqual(backoffs.runBackoffs, ReaderCore.translateMaxConsecutive429 - 1, "熔断那次不计入退避预算")
        for sentence in vm.article?.sentences ?? [] {
            XCTAssertEqual(sentence.zhState, .pending, "暂停不判死：句子保持 pending")
            XCTAssertNil(sentence.zhError, "暂停不写失败原因")
        }
    }

    /// 首 429 后重试成功：句子 done、zhError 为 nil；连续 429 计数清零。
    @MainActor
    func test429ThenSuccessRetriesAndCompletes() async {
        let chat = ScriptedChat()
        await chat.streamBox.enqueue(.failure(ReaderChatClient.ReaderChatError.http(status: 429, message: "rate limited", retryAfterSeconds: nil)))
        await chat.streamBox.enqueue(.success("[1] 第一句译文\n[2] 第二句译文"))
        let vm = makeVM(chat: chat)
        vm.translateBackoffWaitMsOverride = 10
        let article = pendingArticle()
        vm.article = article

        let backoffs = ReaderViewModel.TranslateBackoffCounter()
        backoffs.consecutive429s = 3 // 模拟此前段落的限流残留
        let outcome = await vm.translateGroupWithBackoff(
            article.sentences,
            target: "简体中文",
            articleID: article.id,
            runID: 0,
            backoffs: backoffs,
            totalGroups: 1
        )

        let calls = await chat.streamBox.calls
        XCTAssertEqual(calls, 2, "429 → 等待后重试一次成功")
        XCTAssertEqual(outcome, .finished)
        XCTAssertEqual(backoffs.consecutive429s, 0, "网关放行即清零连续计数")
        XCTAssertEqual(vm.article?.sentences[0].zhState, .done)
        XCTAssertEqual(vm.article?.sentences[0].zh, "第一句译文")
        XCTAssertNil(vm.article?.sentences[0].zhError, "重试成功不残留失败原因")
    }

    /// 非 429（401 / 网络错误）：不退避，直接落对应文案桶。
    @MainActor
    func testNon429FailsImmediatelyWithoutRetry() async {
        let chat401 = ScriptedChat()
        await chat401.streamBox.enqueue(.failure(ReaderChatClient.ReaderChatError.http(status: 401, message: "unauthorized", retryAfterSeconds: nil)))
        let vm401 = makeVM(chat: chat401)
        vm401.translateBackoffWaitMsOverride = 10
        let article401 = pendingArticle()
        vm401.article = article401
        let outcome401 = await vm401.translateGroupWithBackoff(
            article401.sentences,
            target: "简体中文",
            articleID: article401.id,
            runID: 0,
            backoffs: ReaderViewModel.TranslateBackoffCounter(),
            totalGroups: 1
        )
        let calls401 = await chat401.streamBox.calls
        XCTAssertEqual(calls401, 1, "401 不触发退避")
        XCTAssertEqual(outcome401, .finished, "非 429 判死后按正常收尾继续管线")
        XCTAssertEqual(vm401.article?.sentences[0].zhError, Self.text401)

        // 网络错误（URLSession 超时/断网 → 无结构化状态码）→ 兜底桶，同样不退避。
        let chatNet = ScriptedChat()
        await chatNet.streamBox.enqueue(.failure(URLError(.timedOut)))
        let vmNet = makeVM(chat: chatNet)
        vmNet.translateBackoffWaitMsOverride = 10
        let articleNet = pendingArticle()
        vmNet.article = articleNet
        await vmNet.translateGroupWithBackoff(
            articleNet.sentences,
            target: "简体中文",
            articleID: articleNet.id,
            runID: 0,
            backoffs: ReaderViewModel.TranslateBackoffCounter(),
            totalGroups: 1
        )
        let callsNet = await chatNet.streamBox.calls
        XCTAssertEqual(callsNet, 1, "超时/断网（status=nil）不触发退避")
        XCTAssertEqual(vmNet.article?.sentences[0].zhError, Self.textFallback)
    }

    /// parse 对齐失败（HTTP 200 但编号行对不齐）：failed 不带原因。
    @MainActor
    func testParseFailureMarksFailedWithoutReason() async {
        let chat = ScriptedChat()
        // 两句输入、回三行无编号 → 行数对不齐 → parseParagraphResponse 返回 nil。
        await chat.streamBox.enqueue(.success("一行\n两行\n三行"))
        let vm = makeVM(chat: chat)
        vm.translateBackoffWaitMsOverride = 10
        let article = pendingArticle()
        vm.article = article

        await vm.translateGroupWithBackoff(
            article.sentences,
            target: "简体中文",
            articleID: article.id,
            runID: 0,
            backoffs: ReaderViewModel.TranslateBackoffCounter(),
            totalGroups: 1
        )

        let calls = await chat.streamBox.calls
        XCTAssertEqual(calls, 1, "200 但对不齐不是 HTTP 错误，不退避")
        XCTAssertEqual(vm.article?.sentences[0].zhState, .failed)
        XCTAssertNil(vm.article?.sentences[0].zhError, "对齐失败不写失败原因")
    }

    /// 退避等待醒来发现 run 已失效（切到别的文章）：不再重发请求、不写句子状态。
    @MainActor
    func testRunInvalidatedDuringBackoffSkipsRetry() async {
        let chat = ScriptedChat()
        await chat.streamBox.enqueue(.failure(ReaderChatClient.ReaderChatError.http(status: 429, message: "rate limited", retryAfterSeconds: nil)))
        await chat.streamBox.enqueue(.failure(ReaderChatClient.ReaderChatError.http(status: 429, message: "rate limited", retryAfterSeconds: nil)))
        let vm = makeVM(chat: chat)
        vm.translateBackoffWaitMsOverride = 300
        let article = pendingArticle()
        vm.article = article

        let backoffs = ReaderViewModel.TranslateBackoffCounter()
        let task = Task {
            await vm.translateGroupWithBackoff(
                article.sentences,
                target: "简体中文",
                articleID: article.id,
                runID: 0,
                backoffs: backoffs,
                totalGroups: 1
            )
        }
        // 首次请求已返回、任务进入退避等待后切走文章（run 失效）。
        await waitUntil("首次 429 返回") {
            let calls = await chat.streamBox.calls
            return calls == 1
        }
        var another = pendingArticle()
        another.id = "backoff-a2"
        vm.article = another

        await task.value
        let calls = await chat.streamBox.calls
        XCTAssertEqual(calls, 1, "等待醒来 run 已失效：不得重发请求")
        XCTAssertEqual(
            vm.article?.sentences[0].zhState,
            .pending,
            "旧 run 失效后不写任何句子状态（新文章句子保持 pending）"
        )
    }

    /// 管线级暂停：持续 429 熔断 → 清 chip、toast 带动作、句子保持 pending 且
    /// 不再发后续段请求；点 toast「继续翻译」重跑管线，pending 段被重新认领翻完。
    @MainActor
    func testPipelinePausesOnSustained429WithToastAndResume() async {
        let chat = ScriptedChat()
        let limited = ReaderChatClient.ReaderChatError.http(status: 429, message: "rate limited", retryAfterSeconds: nil)
        // 两段文章（每段 1 句）：首段 429 到熔断阈值，剩余帧留给「继续翻译」后的两段。
        var article = pendingArticle()
        article.sentences = [
            SentencePair(idx: 0, paragraphIdx: 0, en: "One sentence."),
            SentencePair(idx: 1, paragraphIdx: 1, en: "Two sentence.")
        ]
        article.title = "Tide"
        article.titleCn = "潮"
        article.titleCnState = .done
        article.chunkState = .done // 避免词块标注分支干扰
        let vm = makeVM(chat: chat)
        vm.translateBackoffWaitMsOverride = 10
        _ = try? vm.store.saveArticle(article)

        for _ in 0..<ReaderCore.translateMaxConsecutive429 {
            await chat.streamBox.enqueue(.failure(limited))
        }
        vm.openArticle(id: article.id)
        await waitUntil("熔断暂停 toast 出现") {
            vm.toast == "翻译请求被限流，已暂停自动翻译"
        }
        XCTAssertNil(vm.translating, "暂停时清掉「翻译中 N/M 段」chip")
        XCTAssertEqual(vm.toastAction?.title, "继续翻译", "toast 携带恢复动作")
        for sentence in vm.article?.sentences ?? [] {
            XCTAssertEqual(sentence.zhState, .pending, "限流暂停不判死")
            XCTAssertNil(sentence.zhError)
        }
        let callsAfterPause = await chat.streamBox.calls
        XCTAssertEqual(callsAfterPause, ReaderCore.translateMaxConsecutive429, "熔断后不再发后续段请求")

        // 「继续翻译」：新 run 预算从 0 起算，剩余帧全部走通。
        await chat.streamBox.enqueue(.success("[1] 第一段译文"))
        await chat.streamBox.enqueue(.success("[1] 第二段译文"))
        vm.toastAction?.handler()
        await waitUntil("恢复后全篇翻完") {
            vm.article?.sentences.allSatisfy { $0.zhState == .done } == true
        }
        XCTAssertNil(vm.translating)
        XCTAssertEqual(vm.article?.sentences[0].zh, "第一段译文")
        XCTAssertEqual(vm.article?.sentences[1].zh, "第二段译文")
    }

    /// 暂停后单段重试仍可恢复补翻（新 run、预算重置）：限流期用户点「重试本段」，
    /// 网关放行后该段翻完，不再依赖整篇管线。
    @MainActor
    func testRetryParagraphRecoversAfterPipelinePause() async {
        let chat = ScriptedChat()
        let limited = ReaderChatClient.ReaderChatError.http(status: 429, message: "rate limited", retryAfterSeconds: nil)
        for _ in 0..<ReaderCore.translateMaxConsecutive429 {
            await chat.streamBox.enqueue(.failure(limited))
        }
        let vm = makeVM(chat: chat)
        vm.translateBackoffWaitMsOverride = 10
        let article = pendingArticle()
        vm.article = article

        let backoffs = ReaderViewModel.TranslateBackoffCounter()
        let outcome = await vm.translateGroupWithBackoff(
            article.sentences,
            target: "简体中文",
            articleID: article.id,
            runID: 0,
            backoffs: backoffs,
            totalGroups: 1
        )
        XCTAssertEqual(outcome, .pausedRateLimited)

        // 暂停态句子 pending；retryParagraph 直接补翻成功（模拟网关已放行）。
        await chat.streamBox.enqueue(.success("[1] 补翻译文一\n[2] 补翻译文二"))
        vm.retryParagraph(0)
        await waitUntil("单段重试翻完") {
            vm.article?.sentences.allSatisfy { $0.zhState == .done } == true
        }
        XCTAssertEqual(vm.article?.sentences[0].zh, "补翻译文一")
        XCTAssertEqual(vm.article?.sentences[1].zh, "补翻译文二")
    }

    /// 翻译中途清空接口配置再切文章（验收 13 / B1 对等）：新文章管线在
    /// 「先在设置里配置翻译接口…」处早退，旧文章的「翻译中 N/M 段」chip 不得残留到
    /// 新文章上（Windows ReaderApp.tsx:898-903 旧 run 先清 chip 再退出）；旧 run 在途
    /// 请求随后返回也不写任何句子状态、不再发请求、不复活 chip。
    @MainActor
    func testSwitchToUnconfiguredArticleMidTranslationClearsChip() async throws {
        let chat = SwitchableChat()
        let vm = makeVM(chat: chat)
        // 词块已标完：旧 run 收尾的 ensureAnnotated 对新文章是空操作，本用例只看翻译 chip。
        var first = pendingArticle()
        first.chunkState = .done
        var second = pendingArticle()
        second.id = "backoff-a2"
        second.title = "Harbor"
        second.chunkState = .done
        _ = try vm.store.saveArticle(first)
        _ = try vm.store.saveArticle(second)

        vm.openArticle(id: first.id)
        await waitUntil("首篇段落请求在途") { await chat.gate.waiting == 1 }
        XCTAssertEqual(vm.translating, ReaderViewModel.StepProgress(done: 0, total: 1), "首篇「翻译中 0/1 段」")

        chat.configured = false
        vm.openArticle(id: second.id)
        await waitUntil("新文章管线未配置早退 toast") {
            vm.toast == "先在设置里配置翻译接口，译文才会自动生成"
        }
        XCTAssertNil(vm.translating, "旧文章的「翻译中」chip 不得残留在新文章上")

        // 放行旧 run 的在途请求：run 已失效，只能静默退出。
        await chat.gate.open("[1] 第一句译文\n[2] 第二句译文")
        try? await Task.sleep(nanoseconds: 200_000_000)
        let requests = await chat.gate.requests
        XCTAssertEqual(requests.count, 1, "旧 run 失效后不再发请求")
        XCTAssertNil(vm.translating, "旧 run 收尾不得复活 chip")
        XCTAssertEqual(vm.article?.id, second.id)
        XCTAssertEqual(
            vm.article?.sentences.map(\.zhState),
            [.pending, .pending],
            "旧 run 不写新文章的句子状态"
        )
        XCTAssertEqual(vm.article?.sentences.compactMap(\.zh), [], "旧 run 不写新文章的译文")
        XCTAssertEqual(vm.article?.sentences.compactMap(\.zhError), [], "旧 run 不写失败原因")
        let storedFirst = try vm.store.getArticle(id: first.id)
        XCTAssertEqual(storedFirst?.sentences.map(\.zhState), [.pending, .pending], "旧文章也不被旧 run 写回")
    }

    // MARK: - 手动重试入口

    /// retryParagraph：failed 句重置 pending 时清 zhError；重试成功后句子 done。
    @MainActor
    func testRetryParagraphClearsErrorAndSucceedsWithBackoff() async {
        let chat = ScriptedChat()
        await chat.streamBox.enqueue(.success("[1] 重试后的译文一\n[2] 重试后的译文二"))
        let vm = makeVM(chat: chat)
        vm.translateBackoffWaitMsOverride = 10
        var article = pendingArticle()
        article.sentences[0].zhState = .failed
        article.sentences[0].zhError = Self.text429
        article.sentences[1].zhState = .failed
        article.sentences[1].zhError = Self.text429
        vm.article = article

        vm.retryParagraph(0)
        // scheduleSave 同步生效：重置 pending 的同时清掉 zhError。
        XCTAssertEqual(vm.article?.sentences[0].zhState, .pending)
        XCTAssertNil(vm.article?.sentences[0].zhError, "重试入口清空失败原因")
        XCTAssertNil(vm.article?.sentences[0].zh, "重置回未翻译")

        await waitUntil("重试成功句子 done") {
            vm.article?.sentences.allSatisfy { $0.zhState == .done } == true
        }
        XCTAssertEqual(vm.article?.sentences[0].zh, "重试后的译文一")
        XCTAssertNil(vm.translating, "单段 run 收尾清 chip")
    }

    /// retryParagraph 再失败：重新写入 zhError（新 run、配额从 0 起算）。
    @MainActor
    func testRetryParagraphRewritesErrorOnSecondFailure() async {
        let chat = ScriptedChat()
        await chat.streamBox.enqueue(.failure(ReaderChatClient.ReaderChatError.http(status: 429, message: "rate limited", retryAfterSeconds: nil)))
        await chat.streamBox.enqueue(.failure(ReaderChatClient.ReaderChatError.http(status: 500, message: "boom", retryAfterSeconds: nil)))
        let vm = makeVM(chat: chat)
        vm.translateBackoffWaitMsOverride = 10
        var article = pendingArticle()
        article.sentences[0].zhState = .failed
        article.sentences[0].zhError = Self.text429
        article.sentences[1].zhState = .failed
        article.sentences[1].zhError = Self.text429
        vm.article = article

        vm.retryParagraph(0)
        await waitUntil("重试后重新落 failed") {
            vm.article?.sentences.allSatisfy { $0.zhState == .failed } == true
        }
        // 新 run 配额重置：首个 429 仍可退避一次，之后 500 直落兜底文案。
        let calls = await chat.streamBox.calls
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(vm.article?.sentences[0].zhError, Self.textFallback, "500 → 兜底桶重写")
    }

    // MARK: - 沉浸云主动限速（Mac 先行）

    /// 两段文章夹具（标题已翻完、词块已标完，只跑段落管线）。
    @MainActor
    private func twoParagraphArticle() -> Article {
        Article(
            id: "backoff-pace",
            title: "Tide",
            titleCn: "潮",
            titleCnState: .done,
            createdAt: 0,
            lastReadAt: 0,
            sentences: [
                SentencePair(idx: 0, paragraphIdx: 0, en: "First paragraph sentence."),
                SentencePair(idx: 1, paragraphIdx: 1, en: "Second paragraph sentence.")
            ],
            chunkState: .done
        )
    }

    /// 沉浸云（isPlatformProvider）下主管线逐请求限速：两段之间至少隔一个
    /// pacing 间隔（网关令牌桶 10 次/分钟，匀速发请求从源头避开 429）。
    @MainActor
    func testPlatformPipelinePacesRequests() async throws {
        let chat = ScriptedChat()
        chat.isPlatform = true
        await chat.streamBox.enqueue(.success("[1] 译文一"))
        await chat.streamBox.enqueue(.success("[1] 译文二"))
        let vm = makeVM(chat: chat)
        vm.translatePacingIntervalMsOverride = 250
        let article = twoParagraphArticle()
        _ = try vm.store.saveArticle(article)

        let started = Date()
        vm.openArticle(id: article.id)
        await waitUntil("两段限速翻完") {
            vm.article?.sentences.allSatisfy { $0.zhState == .done } == true
        }
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertGreaterThanOrEqual(elapsed, 0.22, "第二段请求须等满一个限速间隔")
        XCTAssertEqual(vm.article?.sentences[0].zh, "译文一")
        XCTAssertEqual(vm.article?.sentences[1].zh, "译文二")
    }

    /// 第三方 provider 不限速：同样两段立等可翻（间隔 0 直通）。
    @MainActor
    func testThirdPartyPipelineSkipsPacing() async throws {
        let chat = ScriptedChat()
        chat.isPlatform = false
        await chat.streamBox.enqueue(.success("[1] 译文一"))
        await chat.streamBox.enqueue(.success("[1] 译文二"))
        let vm = makeVM(chat: chat)
        vm.translatePacingIntervalMsOverride = 250 // 非 immersive：覆盖不生效
        let article = twoParagraphArticle()
        _ = try vm.store.saveArticle(article)

        let started = Date()
        vm.openArticle(id: article.id)
        await waitUntil("两段直通翻完") {
            vm.article?.sentences.allSatisfy { $0.zhState == .done } == true
        }
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertLessThan(elapsed, 0.2, "第三方不限速，两段背靠背完成")
    }

    // MARK: - 一键重试全部失败段

    /// retryAllFailed：整篇 failed（限流风暴残留）→ 全部重置 pending → 主管线
    /// 重跑翻完（恢复入口，代替逐段点 85 次「重试本段」）。
    @MainActor
    func testRetryAllFailedResetsAndReTranslates() async throws {
        let chat = ScriptedChat()
        await chat.streamBox.enqueue(.success("[1] 重翻一\n[2] 重翻二"))
        let vm = makeVM(chat: chat)
        vm.translateBackoffWaitMsOverride = 10
        var article = pendingArticle()
        for i in article.sentences.indices {
            article.sentences[i].zhState = .failed
            article.sentences[i].zhError = Self.text429
        }
        _ = try vm.store.saveArticle(article)

        vm.openArticle(id: article.id)
        XCTAssertEqual(vm.failedParagraphCount, 1, "打开不自动重翻：failed 保持")
        vm.retryAllFailed()
        XCTAssertEqual(vm.article?.sentences[0].zhState, .pending, "一键重置回 pending")
        XCTAssertNil(vm.article?.sentences[0].zhError)
        await waitUntil("重跑翻完") {
            vm.article?.sentences.allSatisfy { $0.zhState == .done } == true
        }
        XCTAssertEqual(vm.article?.sentences[0].zh, "重翻一")
        XCTAssertNil(vm.translating)
    }

    // MARK: - 标题失败原因（瞬态）

    /// 标题失败：titleCnError 落 401 文案且 titleCnState=failed；retryTitle 先清
    /// 再重跑，成功后仍为 nil（标题只发一次、不参与 429 退避）。
    @MainActor
    func testTitleFailureSetsTransientErrorAndRetryClears() async {
        let chat = ScriptedChat()
        await chat.titleBox.enqueue(.failure(ReaderChatClient.ReaderChatError.http(status: 401, message: "unauthorized", retryAfterSeconds: nil)))
        await chat.titleBox.enqueue(.success("潮汐"))
        let vm = makeVM(chat: chat)
        vm.translateBackoffWaitMsOverride = 10
        var article = pendingArticle()
        article.titleCn = nil
        article.titleCnState = .pending
        // 句子全部 done + 词块已标完：本用例只走标题分支（不触发段落与标注补跑）。
        article.chunkState = .done
        article.sentences = article.sentences.map { st in
            var next = st
            next.zh = "已译"
            next.zhState = .done
            return next
        }
        vm.article = article

        vm.runTranslationPipeline(for: article.id)
        await waitUntil("标题失败落盘") { vm.article?.titleCnState == .failed }
        XCTAssertEqual(vm.titleCnError, Self.text401, "标题失败原因 = 401 定稿文案")
        let titleCalls = await chat.titleBox.calls
        XCTAssertEqual(titleCalls, 1, "标题只发一次，不参与退避")

        vm.retryTitle()
        XCTAssertNil(vm.titleCnError, "retryTitle 先清失败原因")
        await waitUntil("标题重试成功") { vm.article?.titleCn == "潮汐" }
        XCTAssertNil(vm.titleCnError, "成功后失败原因保持为空")
        XCTAssertEqual(vm.article?.titleCnState, .done)
    }
}
