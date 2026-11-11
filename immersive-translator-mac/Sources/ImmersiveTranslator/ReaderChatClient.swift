import Foundation
import ProviderCore
import ReaderCore

/// 阅读室专用 Chat Completions 客户端：自定义系统提示词 + 流式增量回调。
///
/// 与浮窗 TranslationClient（固定提示词、面板状态机）分工；这里复用同一份
/// SettingsStore 的 endpoint/model/API Key，并做与 Windows translation.rs 一致的
/// 思考模式兼容（智谱 thinking.type=disabled、DeepSeek/Qwen enable_thinking=false）
/// 与 `<think>` 噪声剥离。
@MainActor
final class ReaderChatClient {
    enum ReaderChatError: LocalizedError {
        case invalidEndpoint
        case missingAPIKey
        /// `retryAfterSeconds`：429 时服务端 `Retry-After` 头的秒数（阅读室段级
        /// 退避按它等待，ParagraphTranslate.planTranslateRetry），非限流错误为 nil。
        case http(status: Int, message: String, retryAfterSeconds: Int?)
        case empty
        case invalid(String)

        var errorDescription: String? {
            switch self {
            case .invalidEndpoint: return "接口地址无效，请在设置里检查。"
            case .missingAPIKey: return "缺少 API Key，请在设置里填写。"
            case let .http(status, message, retryAfterSeconds):
                if let retryAfterSeconds {
                    return "翻译接口返回 HTTP \(status)（\(retryAfterSeconds)s 后可重试）。\(message)"
                }
                return "翻译接口返回 HTTP \(status)。\(message)"
            case .empty: return "接口返回空内容。"
            case let .invalid(preview): return "接口返回内容无法解析：\(preview)"
            }
        }
    }

    private let settingsStore: SettingsStore
    /// 沉浸云账号令牌来源（App 注入 ServerAuthClient.accountAccessToken，与浮窗
    /// TranslationClient 同法，auth-1）。nil = 未接线（旧调用方），沉浸云下按
    /// 401 归一处理。非沉浸云 provider 不取令牌。
    private let accountTokenSource: PlatformAccountTokenSource?

    init(settingsStore: SettingsStore, accountTokenSource: PlatformAccountTokenSource? = nil) {
        self.settingsStore = settingsStore
        self.accountTokenSource = accountTokenSource
    }

    struct Configuration {
        let url: URL
        let apiKey: String
        let model: String
        /// 沉浸云平台 provider：鉴权走账号令牌、endpoint 由 resolveBaseURL 派生。
        /// 默认 false 兼容既有测试直构（第三方 Key 直连语义）。
        var isPlatformProvider: Bool = false
    }

    @MainActor
    func configuration() throws -> Configuration {
        let isPlatformProvider = settingsStore.activeProviderID == ProviderProfile.platformProviderID
        // 沉浸云：基址按 ServerAuthConfiguration.resolveBaseURL() 派生（与浮窗
        // TranslationClient 平台分支同构，dev 覆盖文件两通道一致）；预设 endpoint
        // 只是生产缺省展示值，不直接参与请求（auth-1 复核建议项）。
        let endpoint = isPlatformProvider
            ? ServerAuthConfiguration.resolveBaseURL().trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/v1/chat/completions"
            : settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        let apiKey = (KeychainStore.apiKey(for: settingsStore.activeProviderID) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = TranslationClient.chatCompletionsURL(from: endpoint) else {
            throw ReaderChatError.invalidEndpoint
        }
        if apiKey.isEmpty, TranslationClient.requiresAPIKey(for: url) {
            throw ReaderChatError.missingAPIKey
        }
        var model = settingsStore.activeProvider.model.trimmingCharacters(in: .whitespacesAndNewlines)
        // 沉浸云模型由服务端 /v1/me/config 下发，空值原样发送、不走第三方兜底
        //（与 TranslationClient 平台分支同口径）。
        if model.isEmpty, !isPlatformProvider { model = "gpt-4o-mini" }
        return Configuration(url: url, apiKey: apiKey, model: model, isPlatformProvider: isPlatformProvider)
    }

    /// 沉浸云取账号令牌（auth-1/auth-4）。未登录（unauthorized / nil / 空串）与
    /// 鉴权失效统一归一成 HTTP 401：ReaderViewModel.channelHTTPStatus 识别 401
    /// 后走 readerParagraphErrorText 失败行（具体文案由该处统一给定），标题/
    /// 段落/查词三路同一口径；致命码的失效态广播已在
    /// ServerAuthClient.accountAccessToken 完成。
    @MainActor
    private static func platformAccountToken(
        _ source: PlatformAccountTokenSource?
    ) async throws -> String {
        guard let source else {
            throw ReaderChatError.http(status: 401, message: "未登录沉浸云", retryAfterSeconds: nil)
        }
        let bearer: String?
        do {
            bearer = try await source.current()
        } catch let error as AuthError {
            throw ReaderChatError.http(status: 401, message: error.code, retryAfterSeconds: nil)
        }
        guard let bearer, !bearer.isEmpty else {
            throw ReaderChatError.http(status: 401, message: "未登录沉浸云", retryAfterSeconds: nil)
        }
        return bearer
    }

    @MainActor
    var glossaryText: String { settingsStore.glossaryText }

    @MainActor
    var customStyle: String { settingsStore.customPrompt }

    /// 翻译方向：auto 时中文 → English，否则用固定目标语言。
    @MainActor
    func resolveTarget(for sample: String) -> String {
        switch settingsStore.translationDirection {
        case .fixedTarget:
            let target = settingsStore.targetLanguage.trimmingCharacters(in: .whitespacesAndNewlines)
            return target.isEmpty ? "简体中文" : target
        case .autoChineseEnglish:
            return looksMostlyChinese(sample) ? "English" : "简体中文"
        }
    }

    // MARK: - 请求体（思考模式兼容）

    private static func thinkingModeOverrides(endpoint: URL, model: String) -> [String: Any]? {
        let host = endpoint.host()?.lowercased() ?? endpoint.absoluteString.lowercased()
        let m = model.lowercased()

        // 智谱 GLM：思考模型用 thinking.type=disabled。
        if host.contains("bigmodel") || host.contains("zhipu") {
            if m.contains("glm-4.5") || m.contains("glm-4.6") || m.contains("glm-z1") || m.contains("glm-4-plus") || m.contains("glm-5") {
                return ["thinking": ["type": "disabled"]]
            }
        }
        // DeepSeek reasoner：部分网关识别 enable_thinking。
        if host.contains("deepseek"), m.contains("reasoner") {
            return ["enable_thinking": false]
        }
        // 通义千问 Qwen3/QwQ：兼容模式下 enable_thinking=false。
        if host.contains("dashscope") || host.contains("tongyi") || m.contains("qwen") {
            if m.contains("qwen3") || m.contains("qwq") {
                return ["enable_thinking": false]
            }
        }
        return nil
    }

    private static func buildBody(
        url: URL,
        model: String,
        systemPrompt: String,
        userText: String,
        stream: Bool
    ) throws -> Data {
        var body: [String: Any] = [
            "model": model,
            "messages": [
                ["role": "system", "content": systemPrompt],
                // 与 Windows translation.rs 一致：用户文本统一 <text> 包裹
                ["role": "user", "content": "<text>\n\(userText)\n</text>"]
            ],
            "temperature": 0.2,
            "stream": stream
        ]
        if let overrides = thinkingModeOverrides(endpoint: url, model: model) {
            for (key, value) in overrides { body[key] = value }
        }
        return try JSONSerialization.data(withJSONObject: body)
    }

    // MARK: - 剥离 <think> 噪声

    /// 剥离 <think>…</think>（含未闭合的情况）思考噪声。对齐 translation.rs strip_think_tags。
    static func stripThinkTags(_ input: String) -> String {
        guard input.range(of: "<think", options: .caseInsensitive) != nil else { return input }
        var out = ""
        var rest = Substring(input)
        while true {
            guard let startRange = rest.range(of: "<think", options: .caseInsensitive) else {
                out += rest
                break
            }
            out += rest[rest.startIndex..<startRange.lowerBound]
            let afterStart = rest[startRange.upperBound...]
            if let endRange = afterStart.range(of: "</think>", options: .caseInsensitive) {
                rest = afterStart[endRange.upperBound...]
            } else {
                // 未闭合：丢弃后续全部思考内容
                rest = ""
                break
            }
        }
        return out
    }

    // MARK: - 一次性请求（标题 / 词典 / 词块标注）

    /// 非流式完成一次补全；内部流式端点兼容（一次性读完 SSE 也支持）。
    func complete(
        systemPrompt: String,
        userText: String,
        stream: Bool = false
    ) async throws -> String {
        let config = try configuration()
        var request = URLRequest(url: config.url)
        request.httpMethod = "POST"
        request.timeoutInterval = 180
        // 沉浸云：鉴权走账号令牌（Windows「翻译请求自动携带账号令牌，到期自动
        // 续期」同语义，auth-1）；其余 provider 沿用 API Key 直连。
        if config.isPlatformProvider {
            request.setValue("Bearer \(try await Self.platformAccountToken(accountTokenSource))", forHTTPHeaderField: "Authorization")
        } else if !config.apiKey.isEmpty {
            request.setValue("Bearer \(config.apiKey)", forHTTPHeaderField: "Authorization")
        }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try Self.buildBody(
            url: config.url,
            model: config.model,
            systemPrompt: systemPrompt,
            userText: userText,
            stream: stream
        )

        if stream {
            var accumulated = ""
            for try await delta in Self.streamDeltas(request: request, apiKey: config.apiKey) {
                accumulated += delta
            }
            let cleaned = Self.stripThinkTags(accumulated).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cleaned.isEmpty else { throw ReaderChatError.empty }
            return cleaned
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let message = TranslationResponseErrorParser.message(from: data) ?? ""
            throw ReaderChatError.http(
                status: http.statusCode,
                message: message,
                retryAfterSeconds: parseRetryAfter(http.value(forHTTPHeaderField: "Retry-After"))
            )
        }
        // 兼容某些网关对 stream=false 仍回 SSE 的情况
        let text = try Self.parseBufferedResponse(from: data)
        let cleaned = Self.stripThinkTags(text).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { throw ReaderChatError.empty }
        return cleaned
    }

    /// 流式完成一次补全；onDelta 收到的是累计文本（阅读室部分解析按累计设计）。
    func completeStreaming(
        systemPrompt: String,
        userText: String,
        onDelta: @escaping (String) -> Void
    ) async throws -> String {
        let config = try configuration()
        var request = URLRequest(url: config.url)
        request.httpMethod = "POST"
        request.timeoutInterval = 180
        // 同 complete()：沉浸云走账号令牌（auth-1）。
        if config.isPlatformProvider {
            request.setValue("Bearer \(try await Self.platformAccountToken(accountTokenSource))", forHTTPHeaderField: "Authorization")
        } else if !config.apiKey.isEmpty {
            request.setValue("Bearer \(config.apiKey)", forHTTPHeaderField: "Authorization")
        }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.httpBody = try Self.buildBody(
            url: config.url,
            model: config.model,
            systemPrompt: systemPrompt,
            userText: userText,
            stream: true
        )

        var accumulated = ""
        for try await delta in Self.streamDeltas(
            request: request,
            apiKey: config.apiKey,
            watchdogTimeout: ReaderCore.translateWatchdogTimeoutSeconds
        ) {
            accumulated += delta
            onDelta(accumulated)
        }
        // 取消语义（BUG-010）：消费任务被取消时 AsyncThrowingStream 按「流结束」
        // 收尾——上面的循环正常退出、不走 throw。若不在此显式抛 CancellationError：
        // 首字前取消 accumulated 为空 → 落 .empty 被上层渲染成「接口返回空内容」
        // 故障；流式后取消非空 → 截断稿被当完整结果返回并按 partial=false 存档。
        guard !Task.isCancelled else { throw CancellationError() }
        let cleaned = Self.stripThinkTags(accumulated).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { throw ReaderChatError.empty }
        return cleaned
    }

    // MARK: - SSE 解析

    /// 逐段产出流式可见文本（`data:` 行 → choices[].delta.content，宽容多种键名）。
    ///
    /// 活动看门狗（QA BUG-006）：流式响应只受请求级 180s 超时保护——那只覆盖到
    /// 首字节；网关挂起/半开连接在「首字节之后、流不结束」时不会触发任何系统
    /// 超时，逐字节收流会永久 await，正文翻译停在「翻译中 N/M 段」且无终态。
    /// 看门狗按「自上次流增量以来的静默时长」计时（默认 180s，
    /// `ReaderCore.translateWatchdogTimeoutSeconds`），每次 yield/错误/流结束都喂狗；
    /// 慢模型只要还在出字就不会误伤。超时抛 `URLError(.timedOut)`：无结构化
    /// HTTP 状态码 → 走既有「兜底桶」失败文案，段落落 failed、chip 清掉、
    /// 「重试 N 个失败段」恢复入口可用；未配置头时维持原行为（无超时）。
    static func streamDeltas(
        request: URLRequest,
        apiKey: String,
        watchdogTimeout: TimeInterval? = nil
    ) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        var body = Data()
                        for try await byte in bytes { body.append(byte) }
                        let message = TranslationResponseErrorParser.message(from: body) ?? ""
                        throw ReaderChatError.http(
                            status: http.statusCode,
                            message: message,
                            retryAfterSeconds: parseRetryAfter(http.value(forHTTPHeaderField: "Retry-After"))
                        )
                    }
                    // 看门狗只在已配置响应头时启用；nil = 不变行为（旧调用方/测试直调）。
                    guard let watchdogTimeout else {
                        try await Self.pumpSSEBytes(bytes) { delta in
                            continuation.yield(delta)
                        }
                        continuation.finish()
                        return
                    }

                    let feed = WatchdogFeed(timeout: watchdogTimeout)
                    try await withThrowingTaskGroup(of: Void.self) { group in
                        // 看门狗方：静默超时 → 抛出（终态竞速的一方）。
                        group.addTask {
                            if await feed.run() {
                                throw URLError(.timedOut)
                            }
                        }
                        // 收流方：每个增量喂狗；只有取消或传输错误才会离开。
                        group.addTask {
                            try await Self.pumpSSEBytes(bytes) { delta in
                                feed.activity()
                                continuation.yield(delta)
                            }
                        }
                        // 谁先结束都走这里：正常流结束 → 无错返回；
                        // 传输错误/看门狗超时 → 抛出（子任务随之取消）。
                        do {
                            try await group.next()
                            feed.finish()
                            group.cancelAll()
                        } catch {
                            feed.finish()
                            group.cancelAll()
                            throw error
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// 逐字节收 SSE 并按行产出可见文本（streamDeltas 的共用内层循环）。
    private static func pumpSSEBytes(
        _ bytes: URLSession.AsyncBytes,
        onLineDelta: (String) -> Void
    ) async throws {
        var lineBuffer = Data()
        for try await byte in bytes {
            if byte == 0x0A { // \n
                if let delta = try consumeSSELine(lineBuffer) {
                    onLineDelta(delta)
                }
                lineBuffer = Data()
            } else {
                lineBuffer.append(byte)
            }
        }
        if let delta = try consumeSSELine(lineBuffer) {
            onLineDelta(delta)
        }
    }

    /// 看门狗：`activity()` 喂狗重置静默计时；`run()` 在静默满 timeout 后返回
    ///（由调用方把它转成超时终态）；`finish()` 由先到终态的一方调用，让另一方
    /// 尽快退出。纯内存结构，串行队列保护状态。
    private final class WatchdogFeed: @unchecked Sendable {
        private let timeout: TimeInterval
        private var lastActivity = Date()
        private var finished = false
        private let queue = DispatchQueue(label: "immersive-translator.reader-watchdog")

        init(timeout: TimeInterval) {
            self.timeout = timeout
        }

        /// 静默超时（true）或被 finish 叫停（false）。醒后按队列上的真实静默
        /// 时长复核，避免「喂狗与超时赛跑」时误判。
        func run() async -> Bool {
            while true {
                let (remaining, isFinished) = queue.sync {
                    (max(0, timeout - Date().timeIntervalSince(lastActivity)), finished)
                }
                if isFinished { return false }
                if remaining <= 0 { return true }
                let nanos = UInt64((min(remaining, 0.25) * 1_000_000_000).rounded())
                try? await Task.sleep(nanoseconds: nanos)
                let (expired, isFinished2) = queue.sync {
                    (Date().timeIntervalSince(lastActivity) >= timeout, finished)
                }
                if isFinished2 { return false }
                if expired { return true }
            }
        }

        func activity() {
            queue.sync {
                guard !finished else { return }
                lastActivity = Date()
            }
        }

        /// 一方到达终态（收流结束 / 已抛错 / 看门狗判定超时）后调用。
        func finish() {
            queue.sync {
                finished = true
            }
        }
    }

    /// 处理一行 SSE；返回该行携带的可见文本（无则 nil）。
    /// 错误帧终结流（BUG-032，对齐浮窗 TranslationClient 对同帧型显式抛
    /// badResponse(status:200, message)）：旧实现错误帧 return nil——流中已有部分
    /// 文本时截断稿被当成功结果返回落库，无文本时服务端 message 丢失、只落
    /// 「接口返回空内容」。抛 `.http(status:200,…)` 走既有段级失败/重试链路。
    private static func consumeSSELine(_ raw: Data) throws -> String? {
        guard var line = String(data: raw, encoding: .utf8) else { return nil }
        if line.hasSuffix("\r") { line.removeLast() }
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("data:") else { return nil }
        let payload = trimmed.dropFirst("data:".count).trimmingCharacters(in: .whitespaces)
        if payload == "[DONE]" { return nil }
        guard let data = payload.data(using: .utf8) else { return nil }
        if let message = TranslationResponseErrorParser.message(from: data) {
            throw ReaderChatError.http(status: 200, message: message, retryAfterSeconds: nil)
        }
        return visibleText(fromChunkJSON: data)
    }

    /// 从一条 SSE chunk JSON 中取可见文本；宽容 delta/message/content 等键位。
    static func visibleText(fromChunkJSON data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        if let error = obj["error"] as? [String: Any] {
            let message = (error["message"] as? String) ?? ""
            if !message.isEmpty { return nil } // 错误帧不产文本；让空结果触发 empty 错误
        }
        let choices = obj["choices"] as? [[String: Any]] ?? []
        var out = ""
        for choice in choices {
            if let delta = choice["delta"] as? [String: Any] {
                out += Self.textContent(delta["content"])
                // reasoning_content（推理流）不进可见文本
            }
            if let message = choice["message"] as? [String: Any] {
                out += Self.textContent(message["content"])
            }
            let text = choice["text"] as? String ?? ""
            out += text
        }
        if out.isEmpty, let content = obj["content"] as? String {
            out = content
        }
        return out.isEmpty ? nil : out
    }

    /// content 可能是字符串，也可能是多模态 [{type:"text",text:"..."}] 数组。
    private static func textContent(_ value: Any?) -> String {
        if let s = value as? String { return s }
        if let parts = value as? [[String: Any]] {
            return parts.compactMap { $0["text"] as? String }.joined()
        }
        return ""
    }

    /// 非流式响应 → 文本；顺带兼容整段 SSE。
    /// 200 但响应体整体是错误信封（网关把上游错误包成 200 返回）时抛出服务端
    /// message（BUG-032；对齐浮窗 performBufferedRequest 对同形态先查错误信封、
    /// 再解内容的口径），不再落「接口返回空内容」丢掉服务端 message。
    static func parseBufferedResponse(from data: Data) throws -> String {
        if let message = TranslationResponseErrorParser.message(from: data) {
            throw ReaderChatError.http(status: 200, message: message, retryAfterSeconds: nil)
        }
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let choices = obj["choices"] as? [[String: Any]],
           let first = choices.first {
            if let message = first["message"] as? [String: Any] {
                let text = textContent(message["content"])
                if !text.isEmpty { return text }
            }
            if let delta = first["delta"] as? [String: Any] {
                let text = textContent(delta["content"])
                if !text.isEmpty { return text }
            }
            if let text = first["text"] as? String, !text.isEmpty { return text }
            return ""
        }
        // 可能是整段 SSE：逐行取 delta 拼接。
        guard let text = String(data: data, encoding: .utf8) else { return "" }
        var out = ""
        for line in text.components(separatedBy: .newlines) {
            if let delta = try consumeSSELine(Data(line.utf8)) {
                out += delta
            }
        }
        return out
    }
}
