import Foundation
import OSLog

enum TranslationClientError: LocalizedError {
    case invalidEndpoint
    case missingAPIKey
    case badResponse(statusCode: Int, message: String?)
    case emptyTranslation
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .invalidEndpoint:
            return "接口地址不是有效 URL。"
        case .missingAPIKey:
            return "还没有配置 API Key。"
        case .badResponse(let statusCode, _):
            return "翻译接口返回 HTTP \(statusCode)。"
        case .emptyTranslation:
            return "接口返回了空翻译。"
        case .invalidResponse:
            return "接口返回格式不符合预期。"
        }
    }
}

struct TranslationResult {
    let text: String
    let elapsed: TimeInterval
    let model: String
}

struct TranslationProgress {
    let text: String
    let elapsed: TimeInterval
    let isFinal: Bool
}

final class TranslationClient {
    private let logger = Logger(subsystem: "local.immersive-translator.mvp", category: "TranslationClient")
    private let settingsStore: SettingsStore

    init(settingsStore: SettingsStore) {
        self.settingsStore = settingsStore
    }

    @MainActor
    func translate(text: String) async throws -> String {
        try await translateWithMetadata(text: text).text
    }

    @MainActor
    func translateWithMetadata(text: String) async throws -> TranslationResult {
        try await performTranslation(text: text, stream: false, onProgress: nil)
    }

    @MainActor
    func translateStreaming(
        text: String,
        onProgress: @escaping @MainActor (TranslationProgress) -> Void
    ) async throws -> TranslationResult {
        try await performTranslation(text: text, stream: true, onProgress: onProgress)
    }

    @MainActor
    private func performTranslation(
        text: String,
        stream: Bool,
        onProgress: (@MainActor (TranslationProgress) -> Void)?
    ) async throws -> TranslationResult {
        let apiKey = settingsStore.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let endpoint = settingsStore.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        let model = settingsStore.model.trimmingCharacters(in: .whitespacesAndNewlines)
        let targetLanguage = settingsStore.targetLanguage.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedModel = model.isEmpty ? "gpt-4o-mini" : model

        guard !apiKey.isEmpty else { throw TranslationClientError.missingAPIKey }
        guard let url = Self.chatCompletionsURL(from: endpoint) else { throw TranslationClientError.invalidEndpoint }
        let startedAt = Date()
        let requestOptions = Self.requestOptions(endpoint: url, model: resolvedModel)
        logger.info("translation.request.start endpoint=\(url.absoluteString, privacy: .public) model=\(resolvedModel, privacy: .public) textLength=\(text.count, privacy: .public) stream=\(stream, privacy: .public)")
        DiagnosticLogger.log("translation.request.start endpoint=\(url.absoluteString) model=\(resolvedModel) textLength=\(text.count) stream=\(stream) thinkingDisabled=\(requestOptions.disableThinking) provider=\(requestOptions.providerName)")

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 18
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let payload = ChatCompletionRequest(
            model: resolvedModel,
            messages: [
                ChatMessage(
                    role: "system",
                    content: """
                    You are a precise translation engine for a macOS immersive reading tool.
                    Translate the user's text into \(targetLanguage.isEmpty ? "简体中文" : targetLanguage).
                    Prefer natural, readable translation for app names, feature names, headings, and CamelCase product-style phrases when their meaning is clear. For example, "ImmersiveTranslator" should become "沉浸式翻译器" in Chinese.
                    Preserve code identifiers, commands, URLs, file paths, API names, Markdown structure, line breaks, and numbers.
                    Return only the translation, with no explanation.
                    """
                ),
                ChatMessage(role: "user", content: text)
            ],
            temperature: 0.2,
            stream: stream,
            thinking: requestOptions.disableThinking ? ThinkingConfig(type: "disabled") : nil,
            doSample: requestOptions.sendDoSample ? false : nil,
            maxTokens: requestOptions.maxTokens
        )

        request.httpBody = try JSONEncoder().encode(payload)

        if stream, let onProgress {
            return try await performStreamingRequest(
                request,
                startedAt: startedAt,
                resolvedModel: resolvedModel,
                onProgress: onProgress
            )
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            let elapsed = Date().timeIntervalSince(startedAt)
            logger.error("translation.request.transport_error elapsed=\(elapsed, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
            DiagnosticLogger.log("translation.request.transport_error elapsed=\(String(format: "%.2f", elapsed)) error=\(error.localizedDescription)")
            throw error
        }
        let elapsed = Date().timeIntervalSince(startedAt)
        if let httpResponse = response as? HTTPURLResponse,
           !(200..<300).contains(httpResponse.statusCode) {
            let message = parseErrorMessage(from: data) ?? "翻译接口返回 HTTP \(httpResponse.statusCode)。"
            logger.error("translation.request.http_error status=\(httpResponse.statusCode, privacy: .public) elapsed=\(elapsed, privacy: .public) message=\(message, privacy: .public)")
            DiagnosticLogger.log("translation.request.http_error status=\(httpResponse.statusCode) elapsed=\(String(format: "%.2f", elapsed)) message=\(message)")
            throw TranslationClientError.badResponse(statusCode: httpResponse.statusCode, message: message)
        }

        let result: ChatCompletionResponse
        if let decoded = try? JSONDecoder().decode(ChatCompletionResponse.self, from: data) {
            logger.info("translation.response.json elapsed=\(elapsed, privacy: .public) bytes=\(data.count, privacy: .public)")
            DiagnosticLogger.log("translation.response.json elapsed=\(String(format: "%.2f", elapsed)) bytes=\(data.count)")
            result = decoded
        } else if let streamed = Self.parseStreamedResponse(from: data) {
            logger.info("translation.response.stream elapsed=\(elapsed, privacy: .public) bytes=\(data.count, privacy: .public)")
            DiagnosticLogger.log("translation.response.stream elapsed=\(String(format: "%.2f", elapsed)) bytes=\(data.count)")
            result = streamed
        } else if Self.isStreamedResponse(data) {
            logger.error("translation.response.empty_stream elapsed=\(elapsed, privacy: .public) bytes=\(data.count, privacy: .public)")
            DiagnosticLogger.log("translation.response.empty_stream elapsed=\(String(format: "%.2f", elapsed)) bytes=\(data.count)")
            throw TranslationClientError.emptyTranslation
        } else {
            let preview = String(data: data.prefix(240), encoding: .utf8) ?? "<non-utf8>"
            logger.error("translation.response.invalid elapsed=\(elapsed, privacy: .public) bytes=\(data.count, privacy: .public) preview=\(preview, privacy: .public)")
            DiagnosticLogger.log("translation.response.invalid elapsed=\(String(format: "%.2f", elapsed)) bytes=\(data.count) preview=\(preview)")
            throw TranslationClientError.invalidResponse
        }
        guard let translation = result.choices.first?.message.content
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !translation.isEmpty else {
            logger.error("translation.response.empty_translation elapsed=\(elapsed, privacy: .public) choices=\(result.choices.count, privacy: .public)")
            DiagnosticLogger.log("translation.response.empty_translation elapsed=\(String(format: "%.2f", elapsed)) choices=\(result.choices.count)")
            throw TranslationClientError.emptyTranslation
        }
        logger.info("translation.request.success elapsed=\(elapsed, privacy: .public) outputLength=\(translation.count, privacy: .public)")
        DiagnosticLogger.log("translation.request.success elapsed=\(String(format: "%.2f", elapsed)) outputLength=\(translation.count)")
        return TranslationResult(text: translation, elapsed: elapsed, model: resolvedModel)
    }

    @MainActor
    private func performStreamingRequest(
        _ request: URLRequest,
        startedAt: Date,
        resolvedModel: String,
        onProgress: @escaping @MainActor (TranslationProgress) -> Void
    ) async throws -> TranslationResult {
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await URLSession.shared.bytes(for: request)
        } catch {
            let elapsed = Date().timeIntervalSince(startedAt)
            logger.error("translation.stream.transport_error elapsed=\(elapsed, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
            DiagnosticLogger.log("translation.stream.transport_error elapsed=\(String(format: "%.2f", elapsed)) error=\(error.localizedDescription)")
            throw error
        }

        if let httpResponse = response as? HTTPURLResponse,
           !(200..<300).contains(httpResponse.statusCode) {
            var errorData = Data()
            for try await byte in bytes {
                errorData.append(byte)
            }
            let message = parseErrorMessage(from: errorData) ?? "翻译接口返回 HTTP \(httpResponse.statusCode)。"
            let elapsed = Date().timeIntervalSince(startedAt)
            logger.error("translation.stream.http_error status=\(httpResponse.statusCode, privacy: .public) elapsed=\(elapsed, privacy: .public) message=\(message, privacy: .public)")
            DiagnosticLogger.log("translation.stream.http_error status=\(httpResponse.statusCode) elapsed=\(String(format: "%.2f", elapsed)) message=\(message)")
            throw TranslationClientError.badResponse(statusCode: httpResponse.statusCode, message: message)
        }

        var content = ""
        var fallbackData = Data()
        var sawStreamLine = false

        for try await rawLine in bytes.lines {
            fallbackData.append(contentsOf: rawLine.utf8)
            fallbackData.append(0x0A)

            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.hasPrefix("data:") else { continue }
            sawStreamLine = true

            let jsonText = line.dropFirst(5).trimmingCharacters(in: .whitespacesAndNewlines)
            if jsonText == "[DONE]" {
                break
            }
            guard let jsonData = jsonText.data(using: .utf8),
                  let chunk = try? JSONDecoder().decode(ChatCompletionStreamChunk.self, from: jsonData) else {
                continue
            }

            let delta = chunk.choices.compactMap { choice in
                choice.delta?.content ?? choice.message?.content
            }.joined()
            guard !delta.isEmpty else { continue }
            content += delta
            onProgress(TranslationProgress(
                text: content,
                elapsed: Date().timeIntervalSince(startedAt),
                isFinal: false
            ))
        }

        let elapsed = Date().timeIntervalSince(startedAt)
        let trimmedContent = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedContent.isEmpty {
            onProgress(TranslationProgress(text: trimmedContent, elapsed: elapsed, isFinal: true))
            logger.info("translation.stream.success elapsed=\(elapsed, privacy: .public) outputLength=\(trimmedContent.count, privacy: .public)")
            DiagnosticLogger.log("translation.stream.success elapsed=\(String(format: "%.2f", elapsed)) outputLength=\(trimmedContent.count)")
            return TranslationResult(text: trimmedContent, elapsed: elapsed, model: resolvedModel)
        }

        if !sawStreamLine,
           let decoded = try? JSONDecoder().decode(ChatCompletionResponse.self, from: fallbackData),
           let translation = decoded.choices.first?.message.content.trimmingCharacters(in: .whitespacesAndNewlines),
           !translation.isEmpty {
            onProgress(TranslationProgress(text: translation, elapsed: elapsed, isFinal: true))
            logger.info("translation.stream.fallback_json elapsed=\(elapsed, privacy: .public) outputLength=\(translation.count, privacy: .public)")
            DiagnosticLogger.log("translation.stream.fallback_json elapsed=\(String(format: "%.2f", elapsed)) outputLength=\(translation.count)")
            return TranslationResult(text: translation, elapsed: elapsed, model: resolvedModel)
        }

        logger.error("translation.stream.empty elapsed=\(elapsed, privacy: .public) bytes=\(fallbackData.count, privacy: .public)")
        DiagnosticLogger.log("translation.stream.empty elapsed=\(String(format: "%.2f", elapsed)) bytes=\(fallbackData.count)")
        throw TranslationClientError.emptyTranslation
    }

    private static func chatCompletionsURL(from endpoint: String) -> URL? {
        guard var components = URLComponents(string: endpoint) else {
            return nil
        }

        let trimmedPath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if trimmedPath.isEmpty {
            components.path = "/v1/chat/completions"
        } else if trimmedPath == "v1" {
            components.path = "/v1/chat/completions"
        } else if !trimmedPath.hasSuffix("chat/completions") {
            components.path = "/" + trimmedPath + "/chat/completions"
        }

        return components.url
    }

    private static func parseStreamedResponse(from data: Data) -> ChatCompletionResponse? {
        guard let text = String(data: data, encoding: .utf8) else {
            return nil
        }

        var content = ""
        for rawLine in text.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.hasPrefix("data:") else { continue }

            let jsonText = line.dropFirst(5).trimmingCharacters(in: .whitespacesAndNewlines)
            guard jsonText != "[DONE]", let jsonData = jsonText.data(using: .utf8) else {
                continue
            }

            if let chunk = try? JSONDecoder().decode(ChatCompletionStreamChunk.self, from: jsonData) {
                content += chunk.choices.compactMap { choice in
                    choice.delta?.content ?? choice.message?.content
                }.joined()
            }
        }

        let trimmedContent = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedContent.isEmpty else {
            return nil
        }
        return ChatCompletionResponse(choices: [
            ChatCompletionResponse.Choice(message: ChatMessage(role: "assistant", content: trimmedContent))
        ])
    }

    private static func isStreamedResponse(_ data: Data) -> Bool {
        guard let text = String(data: data, encoding: .utf8) else {
            return false
        }
        return text.components(separatedBy: .newlines).contains { line in
            line.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("data:")
        }
    }

    private static func requestOptions(endpoint: URL, model: String) -> RequestOptions {
        let host = endpoint.host()?.lowercased() ?? ""
        let lowercasedModel = model.lowercased()

        if host.contains("deepseek") || lowercasedModel.hasPrefix("deepseek-") {
            return RequestOptions(
                providerName: "deepseek",
                disableThinking: true,
                sendDoSample: false,
                maxTokens: 1024
            )
        }

        if lowercasedModel.hasPrefix("glm-")
            || host.contains("bigmodel.cn")
            || host.contains("z.ai") {
            return RequestOptions(
                providerName: "zhipu",
                disableThinking: true,
                sendDoSample: true,
                maxTokens: 1024
            )
        }

        return RequestOptions(
            providerName: "openai-compatible",
            disableThinking: false,
            sendDoSample: false,
            maxTokens: nil
        )
    }

    private func parseErrorMessage(from data: Data) -> String? {
        guard let apiError = try? JSONDecoder().decode(APIErrorResponse.self, from: data) else {
            return String(data: data, encoding: .utf8)
        }
        return apiError.error.message
    }
}

private struct RequestOptions {
    let providerName: String
    let disableThinking: Bool
    let sendDoSample: Bool
    let maxTokens: Int?
}

private struct ChatCompletionRequest: Encodable {
    let model: String
    let messages: [ChatMessage]
    let temperature: Double
    let stream: Bool
    let thinking: ThinkingConfig?
    let doSample: Bool?
    let maxTokens: Int?

    enum CodingKeys: String, CodingKey {
        case model
        case messages
        case temperature
        case stream
        case thinking
        case doSample = "do_sample"
        case maxTokens = "max_tokens"
    }
}

private struct ChatMessage: Codable {
    let role: String
    let content: String
}

private struct ThinkingConfig: Encodable {
    let type: String
}

private struct ChatCompletionResponse: Decodable {
    let choices: [Choice]

    struct Choice: Decodable {
        let message: ChatMessage
    }
}

private struct ChatCompletionStreamChunk: Decodable {
    let choices: [Choice]

    struct Choice: Decodable {
        let delta: StreamDelta?
        let message: ChatMessage?
    }

    struct StreamDelta: Decodable {
        let role: String?
        let content: String?
    }
}

private struct APIErrorResponse: Decodable {
    let error: APIError

    struct APIError: Decodable {
        let message: String
    }
}
