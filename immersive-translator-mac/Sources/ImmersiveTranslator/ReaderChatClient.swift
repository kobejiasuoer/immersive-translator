import Foundation
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
        case http(status: Int, message: String)
        case empty
        case invalid(String)

        var errorDescription: String? {
            switch self {
            case .invalidEndpoint: return "接口地址无效，请在设置里检查。"
            case .missingAPIKey: return "缺少 API Key，请在设置里填写。"
            case let .http(status, message): return "翻译接口返回 HTTP \(status)。\(message)"
            case .empty: return "接口返回空内容。"
            case let .invalid(preview): return "接口返回内容无法解析：\(preview)"
            }
        }
    }

    private let settingsStore: SettingsStore

    init(settingsStore: SettingsStore) {
        self.settingsStore = settingsStore
    }

    struct Configuration {
        let url: URL
        let apiKey: String
        let model: String
    }

    @MainActor
    func configuration() throws -> Configuration {
        let apiKey = (KeychainStore.apiKey(for: settingsStore.activeProviderID) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let endpoint = settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = TranslationClient.chatCompletionsURL(from: endpoint) else {
            throw ReaderChatError.invalidEndpoint
        }
        if apiKey.isEmpty, TranslationClient.requiresAPIKey(for: url) {
            throw ReaderChatError.missingAPIKey
        }
        var model = settingsStore.activeProvider.model.trimmingCharacters(in: .whitespacesAndNewlines)
        if model.isEmpty { model = "gpt-4o-mini" }
        return Configuration(url: url, apiKey: apiKey, model: model)
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
        if !config.apiKey.isEmpty {
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
            throw ReaderChatError.http(status: http.statusCode, message: message)
        }
        // 兼容某些网关对 stream=false 仍回 SSE 的情况
        let text = Self.parseBufferedResponse(from: data)
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
        if !config.apiKey.isEmpty {
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
        for try await delta in Self.streamDeltas(request: request, apiKey: config.apiKey) {
            accumulated += delta
            onDelta(accumulated)
        }
        let cleaned = Self.stripThinkTags(accumulated).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { throw ReaderChatError.empty }
        return cleaned
    }

    // MARK: - SSE 解析

    /// 逐段产出流式可见文本（`data:` 行 → choices[].delta.content，宽容多种键名）。
    static func streamDeltas(
        request: URLRequest,
        apiKey: String
    ) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        var body = Data()
                        for try await byte in bytes { body.append(byte) }
                        let message = TranslationResponseErrorParser.message(from: body) ?? ""
                        throw ReaderChatError.http(status: http.statusCode, message: message)
                    }
                    var lineBuffer = Data()
                    for try await byte in bytes {
                        if byte == 0x0A { // \n
                            if let delta = consumeSSELine(lineBuffer) {
                                continuation.yield(delta)
                            }
                            lineBuffer = Data()
                        } else {
                            lineBuffer.append(byte)
                        }
                    }
                    if let delta = consumeSSELine(lineBuffer) {
                        continuation.yield(delta)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// 处理一行 SSE；返回该行携带的可见文本（无则 nil）。
    private static func consumeSSELine(_ raw: Data) -> String? {
        guard var line = String(data: raw, encoding: .utf8) else { return nil }
        if line.hasSuffix("\r") { line.removeLast() }
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("data:") else { return nil }
        let payload = trimmed.dropFirst("data:".count).trimmingCharacters(in: .whitespaces)
        if payload == "[DONE]" { return nil }
        guard let data = payload.data(using: .utf8) else { return nil }
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
    static func parseBufferedResponse(from data: Data) -> String {
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
            if let delta = consumeSSELine(Data(line.utf8)) {
                out += delta
            }
        }
        return out
    }
}
