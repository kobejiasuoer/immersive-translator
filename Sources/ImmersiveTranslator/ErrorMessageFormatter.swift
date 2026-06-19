import Foundation

enum TranslationErrorIssue {
    case apiKey
    case modelName
    case endpoint
    case billing
    case rateLimit
    case permission
    case region
    case requestParameter
    case streamCompatibility
    case localModelMissing
    case gatewayHTML
    case contentPolicy
    case textTooLong
    case timeout
    case serviceUnavailable

    static func classify(statusCode: Int?, message: String?) -> TranslationErrorIssue? {
        let lowercased = message?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""

        if containsAny(lowercased, ["model not found, try pulling", "try pulling it first", "ollama pull"]) {
            return .localModelMissing
        }
        if containsAny(lowercased, [
            "invalid api key",
            "incorrect api key",
            "api key is invalid",
            "api key not valid",
            "api_key_invalid",
            "invalid api-key",
            "invalid_api_key",
            "missing api key",
            "api key required",
            "api key is required",
            "request is missing api key",
            "invalid token",
            "missing token",
            "token required",
            "invalid_key",
            "unauthorized",
            "authentication failed",
            "authentication required",
            "invalid authentication",
            "missing authorization",
            "authorization header missing",
            "missing authorization header",
            "no authorization header",
            "authorization bearer",
            "bearer token required",
            "bearer token is required",
            "no auth credentials",
            "no authentication credentials",
            "缺少 api key",
            "缺少apikey",
            "api key 不能为空",
            "缺少授权",
            "缺少认证",
            "未提供认证"
        ]) {
            return .apiKey
        }
        if containsAny(lowercased, ["rate limit", "rate_limit", "too many requests", "requests per", "tokens per", "rpm", "tpm", "限流", "频率过高"]) {
            return .rateLimit
        }
        if containsAny(lowercased, [
            "insufficient_quota",
            "insufficient quota",
            "quota exceeded",
            "quota exhausted",
            "quota has been exhausted",
            "out of credits",
            "no credits",
            "credit balance",
            "credits exhausted",
            "free quota",
            "trial quota",
            "trial credits",
            "billing hard limit",
            "account balance",
            "prepaid balance",
            "payment required",
            "payment method",
            "recharge",
            "credit",
            "balance",
            "billing",
            "payment",
            "欠费",
            "余额",
            "余额不足",
            "账户余额",
            "可用额度不足",
            "剩余额度不足",
            "额度不足",
            "额度已用完",
            "免费额度",
            "试用额度",
            "试用额度已用完",
            "请充值",
            "充值",
            "账单",
            "计费",
            "未付费"
        ]) {
            return .billing
        }
        if containsAny(lowercased, ["model_not_found", "model not found", "does not exist", "unknown model", "invalid model", "model name", "not found for api version", "模型不存在", "模型不存在或无权访问"]) {
            return .modelName
        }
        if containsAny(lowercased, [
            "context length",
            "context_length",
            "context_length_exceeded",
            "maximum context",
            "max context",
            "maximum number of tokens",
            "too many tokens",
            "tokens exceed",
            "token limit",
            "prompt token",
            "prompt is too long",
            "input too long",
            "input is too long",
            "request too large",
            "payload too large",
            "body too large",
            "exceeds the limit",
            "exceeded maximum",
            "reduce the length",
            "maximum content length",
            "文本过长",
            "输入过长",
            "请求体过大",
            "超出上下文",
            "超过上下文",
            "超过最大长度",
            "超过最大 token"
        ]) {
            return .textTooLong
        }
        if containsAny(lowercased, ["content_filter", "content filter", "content management policy", "responsibleaipolicyviolation", "safety policy", "safety system", "safety settings", "blocked by policy", "violates policy", "policy violation", "moderation", "jailbreak", "sensitive content", "unsafe content", "内容安全", "安全策略", "内容策略", "合规策略", "敏感内容", "违规内容", "审核未通过"]) {
            return .contentPolicy
        }
        if containsAny(lowercased, ["region", "country", "geographic", "territory", "unsupported location", "地区", "区域", "合规"]) {
            return .region
        }
        if containsAny(lowercased, ["permission", "forbidden", "access denied", "not allowed", "not authorized", "permission denied", "scope", "project", "not enabled", "has not been used", "无权限", "未开通", "没有权限"]) {
            return .permission
        }
        if containsAny(lowercased, [
            "cannot post",
            "cannot get",
            "cannot put",
            "cannot head",
            "no route",
            "route not found",
            "route not matched",
            "no endpoint",
            "endpoint not found",
            "invalid endpoint",
            "404 page",
            "404 not found",
            "page not found",
            "wrong endpoint",
            "invalid url",
            "invalid path",
            "path not found",
            "path does not exist",
            "no handler for",
            "接口地址",
            "接口路径",
            "路径不存在"
        ]) {
            return .endpoint
        }
        if containsAny(lowercased, ["unsupported stream", "stream not supported", "streaming is not supported", "stream_options", "stream mode"]) {
            return .streamCompatibility
        }
        if containsAny(lowercased, ["unsupported", "unrecognized", "extra fields", "unknown parameter", "invalid parameter", "thinking", "do_sample", "max_tokens", "请求参数", "不支持的参数"]) {
            return .requestParameter
        }
        if containsAny(lowercased, [
            "gateway timeout",
            "upstream timeout",
            "upstream timed out",
            "origin timed out",
            "origin did not respond",
            "connection timed out",
            "request timed out",
            "read timed out",
            "operation timed out",
            "a timeout occurred",
            "timeout occurred",
            "超时",
            "请求超时",
            "响应超时",
            "上游超时",
            "网关超时"
        ]) {
            return .timeout
        }
        if containsAny(lowercased, [
            "bad gateway",
            "service unavailable",
            "temporarily unavailable",
            "temporary unavailable",
            "server unavailable",
            "server busy",
            "server overloaded",
            "overloaded",
            "upstream error",
            "upstream connect error",
            "upstream service unavailable",
            "origin error",
            "origin unreachable",
            "origin is unreachable",
            "web server is down",
            "connection refused",
            "connect refused",
            "服务暂时不可用",
            "服务不可用",
            "服务器繁忙",
            "服务繁忙",
            "上游错误",
            "上游服务异常"
        ]) {
            return .serviceUnavailable
        }
        switch statusCode {
        case 522, 524:
            return .timeout
        case 520, 521, 523:
            return .serviceUnavailable
        default:
            break
        }
        if containsAny(lowercased, ["html page", "html 页面", "<html", "<!doctype", "cloudflare", "nginx", "not a json"]) {
            return .gatewayHTML
        }

        switch statusCode {
        case 401:
            return .apiKey
        case 402:
            return .billing
        case 403:
            return .permission
        case 408, 504, 522, 524:
            return .timeout
        case 413:
            return .textTooLong
        case 429:
            return .rateLimit
        case 451:
            return .region
        case 502, 503, 520, 521, 523:
            return .serviceUnavailable
        default:
            if let statusCode, 500...599 ~= statusCode {
                return .serviceUnavailable
            }
            return nil
        }
    }

    var statusMessage: String {
        switch self {
        case .apiKey:
            return "API Key 未通过认证"
        case .modelName:
            return "模型名或模型权限异常"
        case .endpoint:
            return "接口地址或路径异常"
        case .billing:
            return "余额或额度不足"
        case .rateLimit:
            return "请求被限流"
        case .permission:
            return "账号或模型权限不足"
        case .region:
            return "区域或合规限制"
        case .requestParameter:
            return "请求参数不兼容"
        case .streamCompatibility:
            return "流式或参数不兼容"
        case .localModelMissing:
            return "本地模型未下载"
        case .gatewayHTML:
            return "接口返回网页或网关页"
        case .contentPolicy:
            return "内容被安全策略拦截"
        case .textTooLong:
            return "文本超过接口限制"
        case .timeout:
            return "网络或服务商响应超时"
        case .serviceUnavailable:
            return "服务商暂时不可用"
        }
    }

    var settingsTitle: String? {
        switch self {
        case .apiKey:
            return "检查 API Key"
        case .modelName:
            return "检查模型名"
        case .endpoint, .gatewayHTML:
            return "检查接口地址"
        case .billing:
            return "检查余额/额度"
        case .rateLimit:
            return "检查限流/额度"
        case .permission, .region:
            return "检查权限/区域"
        case .requestParameter, .streamCompatibility:
            return "检查模型/接口"
        case .localModelMissing:
            return "检查 Ollama 模型"
        case .contentPolicy:
            return "调整文本内容"
        case .textTooLong:
            return "调整文本长度"
        case .timeout:
            return "检查网络/超时"
        case .serviceUnavailable:
            return "切换服务商预设"
        }
    }

    var allowsRetry: Bool {
        switch self {
        case .rateLimit, .timeout, .serviceUnavailable:
            return true
        case .apiKey, .modelName, .endpoint, .billing, .permission, .region, .requestParameter, .streamCompatibility, .localModelMissing, .gatewayHTML, .contentPolicy, .textTooLong:
            return false
        }
    }

    var diagnosticNextStep: String {
        switch self {
        case .apiKey:
            return "重新粘贴 API Key，并确认 Key 属于当前服务商、项目和接口地址。"
        case .modelName:
            return "核对模型名和账号可用模型；最稳妥是重新点一次对应 Provider 预设后再验证。"
        case .endpoint:
            return "核对接口地址是否是 Chat Completions 路径；如果用预设，重新点一次服务商预设。"
        case .billing:
            return "到服务商控制台检查余额、账单状态、免费额度或项目配额是否用完。"
        case .rateLimit:
            return "稍后重试，或降低连续翻译频率，并检查服务商 RPM/TPM、并发和额度限制。"
        case .permission:
            return "检查当前账号、项目、API Key 是否有模型调用权限；必要时切换到已开通模型。"
        case .region:
            return "检查账号区域、模型可用区域和服务条款；必要时切换服务商或可用地区。"
        case .requestParameter:
            return "检查模型名和兼容接口参数；可先换用对应 Provider 预设再验证一次。"
        case .streamCompatibility:
            return "先关闭流式显示再验证；如果成功，说明当前兼容接口不支持流式或相关参数。"
        case .localModelMissing:
            return "如果使用 Ollama，先运行 `ollama pull <模型名>`，并确认本机服务和模型名一致。"
        case .gatewayHTML:
            return "接口返回了网页或网关页；检查地址是否填成控制台网页、代理登录页或普通 API 根路径。"
        case .contentPolicy:
            return "服务商安全策略拒绝了这段内容；建议缩小选区、删除敏感片段，或拆成更小段后再翻译。"
        case .textTooLong:
            return "缩小 OCR/选中文本范围，或按自然段分批翻译；也可以换用支持更长上下文的模型。"
        case .timeout:
            return "检查网络、代理和服务商入口；慢请求可开启流式显示减少等待感。"
        case .serviceUnavailable:
            return "服务商侧异常概率较高；稍后重试，或临时切换到另一个低延迟预设。"
        }
    }

    var detailHint: String {
        switch self {
        case .apiKey:
            return "更具体地看，服务商提示像是 API Key 无效或不属于当前接口。建议重新复制 Key，并确认没有把不同服务商、项目或区域的 Key 混用。"
        case .modelName:
            return "更具体地看，服务商提示像是模型名不存在、拼写不对，或当前账号没有该模型权限。建议从设置里的预设重新选择一次，或到服务商控制台核对模型名。"
        case .endpoint:
            return "更具体地看，服务商提示像是接口地址不对。请确认地址最终指向 OpenAI Chat Completions 兼容路径，例如 `/v1/chat/completions` 或服务商文档中的等效路径。"
        case .billing:
            return "更具体地看，服务商提示像是余额、额度或计费状态问题。建议到服务商控制台检查余额、套餐、免费额度和欠费状态。"
        case .rateLimit:
            return "更具体地看，服务商提示像是触发了限流。可以稍后再试，降低连续翻译频率，或检查 RPM/TPM 和并发限制。"
        case .permission:
            return "更具体地看，服务商提示像是账号、项目或 API Key 没有调用权限。建议检查模型权限、区域限制和 API Key 所属项目。"
        case .region:
            return "更具体地看，服务商提示像是区域、合规或账号地区限制。建议检查当前账号可用区域、模型开放范围和服务条款。"
        case .requestParameter:
            return "更具体地看，服务商可能不兼容某些请求参数。可以换用对应服务商预设，或检查模型是否支持当前 Chat Completions 参数。"
        case .streamCompatibility:
            return "更具体地看，当前接口可能不兼容流式模式。可以先关闭流式显示再试，或换用支持 SSE 流式返回的服务商预设。"
        case .localModelMissing:
            return "如果你用的是本地 Ollama，通常需要先运行 `ollama pull <模型名>`，并确认设置里的模型名和本机模型列表一致。"
        case .gatewayHTML:
            return "更具体地看，返回内容像是网页或网关页面，而不是 JSON。请确认接口地址没有填成控制台网页、反向代理登录页或普通 API 根路径。"
        case .contentPolicy:
            return "更具体地看，服务商的内容安全或合规策略拒绝处理这段文本。建议缩小 OCR/选中文本范围、去掉触发策略的敏感片段，或分段翻译上下文。"
        case .textTooLong:
            return "更具体地看，当前文本超过了模型或接口的上下文、Token 或请求体大小限制。建议缩小 OCR/选中文本范围、按自然段分批翻译，或换用更长上下文模型。"
        case .timeout:
            return "更具体地看，请求在网络、代理、服务商入口或模型排队阶段耗时过久。可以稍后重试，或开启流式显示减少等待感。"
        case .serviceUnavailable:
            return "更具体地看，服务商或中间网关暂时不可用。通常是服务商拥塞、代理超时或上游模型排队，可以稍后重试或切换预设。"
        }
    }

    private static func containsAny(_ text: String, _ needles: [String]) -> Bool {
        needles.contains { text.contains($0) }
    }
}

enum ErrorMessageFormatter {
    static func message(for error: Error) -> String {
        if let translationError = error as? TranslationClientError {
            return translationMessage(for: translationError)
        }

        if let selectedTextError = error as? SelectedTextReaderError {
            return selectedTextError.localizedDescription
        }

        if let ocrError = error as? OCRError {
            return ocrError.localizedDescription
        }

        if let updateError = error as? UpdateCheckError {
            return updateMessage(for: updateError)
        }

        if let updateDownloadError = error as? UpdateDownloadError {
            return updateDownloadMessage(for: updateDownloadError)
        }

        if let updateInstallPreparationError = error as? UpdateInstallPreparationError {
            return updateInstallPreparationError.localizedDescription
        }

        if let urlError = error as? URLError {
            return networkMessage(for: urlError)
        }

        if error is DecodingError {
            return "翻译接口返回格式不符合预期。请确认接口地址是 OpenAI Chat Completions 兼容格式。"
        }

        return "操作没有完成。请检查网络、权限和设置后重试。\n\n详细信息：\(error.localizedDescription)"
    }

    private static func translationMessage(for error: TranslationClientError) -> String {
        switch error {
        case .invalidEndpoint:
            return "接口地址不是有效 URL。请在设置里检查接口地址。"
        case .missingAPIKey:
            return "还没有配置 API Key。请先打开设置并填入 OpenAI 或兼容服务的 API Key。"
        case .badResponse(let statusCode, let message):
            var lines: [String]
            switch statusCode {
            case 200:
                lines = ["接口连通成功，但服务商在 JSON 正文里返回了错误。请按下面的原始提示检查 API Key、模型名、额度/限流或账号权限。"]
            case 400:
                lines = ["翻译服务认为请求格式不正确。请先检查模型名是否支持 Chat Completions、接口地址是否匹配服务商文档。"]
            case 401:
                lines = ["API Key 没有通过认证。请检查 Key 是否复制完整、是否属于当前服务商，以及是否仍然有效。"]
            case 402:
                lines = ["账号余额或套餐额度不足。请到服务商控制台检查余额、欠费状态或订阅额度。"]
            case 403:
                lines = ["服务商拒绝访问。API Key 可能没有调用权限，或该模型/区域没有开通。"]
            case 404:
                lines = ["没有找到接口或模型。请重点检查接口地址是否是 Chat Completions 路径，以及模型名是否拼写正确。"]
            case 408:
                lines = ["翻译请求超时。可以稍后重试，或检查网络连接。"]
            case 409:
                lines = ["服务商认为当前请求状态冲突。可能是同一账号并发、任务状态或临时服务端状态异常，可以稍后重试。"]
            case 413:
                lines = ["这段文本对当前接口来说太长。请缩小选区、分段翻译，或换用支持更长上下文的模型。"]
            case 415:
                lines = ["服务商不接受当前请求格式。请确认接口地址是 Chat Completions 兼容路径，且服务商支持 JSON 请求。"]
            case 422:
                lines = ["服务商无法处理当前参数。常见原因是模型名不支持某个参数、流式模式不兼容，或兼容接口不接受当前请求字段。"]
            case 426:
                lines = ["服务商要求升级连接协议。请确认接口地址使用 HTTPS，并检查代理或网关是否过旧。"]
            case 429:
                lines = ["请求被限流。可能是调用太频繁、并发过高、额度耗尽，或服务商临时拥塞。"]
            case 451:
                lines = ["服务商因区域、合规或账号限制拒绝了请求。请检查当前账号可用区域和服务条款。"]
            case 504:
                lines = ["翻译请求在网关或上游服务处超时。通常是服务商入口、代理或上游模型响应太慢，可以稍后重试、开启流式显示或切换低延迟预设。"]
            case 522, 524:
                lines = ["翻译请求在 Cloudflare/网关层超时。通常是服务商入口、代理或上游模型响应太慢，可以稍后重试、开启流式显示或切换低延迟预设。"]
            case 502, 503:
                lines = ["翻译服务或中间网关暂时不可用。通常是服务商拥塞、代理超时或上游模型排队，可以稍后重试或切换服务商。"]
            case 520, 521, 523:
                lines = ["Cloudflare/网关无法连接上游服务。通常是服务商源站异常、代理配置或网络路径问题，可以稍后重试或切换服务商预设。"]
            case 500...599:
                lines = ["翻译服务暂时不可用。通常是服务商侧错误或模型繁忙，可以稍后重试或切换预设。"]
            default:
                lines = ["翻译接口返回 HTTP \(statusCode)。请检查 API Key、模型名和接口地址。"]
            }
            let cleanMessage = message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if let issue = TranslationErrorIssue.classify(statusCode: statusCode, message: cleanMessage) {
                lines.append(issue.detailHint)
            }
            if let hint = providerSpecificHint(from: cleanMessage) {
                lines.append(hint)
            }
            if !cleanMessage.isEmpty {
                lines.append("接口原始提示：\(cleanMessage)")
            }
            return lines.joined(separator: "\n\n")
        case .emptyTranslation:
            return "翻译接口返回了空结果。可以重新翻译一次，或换一个模型/关闭流式显示试试。"
        case .invalidResponse(let preview):
            return invalidResponseMessage(preview: preview)
        }
    }

    private static func invalidResponseMessage(preview: String?) -> String {
        let cleanPreview = sanitizedResponsePreview(preview)
        guard let cleanPreview else {
            return "翻译接口返回格式不符合预期。请确认接口地址是 OpenAI Chat Completions 兼容格式。"
        }

        if cleanPreview == "<non-utf8>" {
            return "翻译接口返回的内容不是 UTF-8 JSON。请检查代理、网关或服务商兼容接口是否改写了响应，或是否返回了压缩/二进制内容。"
        }

        let lowercased = cleanPreview.lowercased()
        var lines: [String]
        if looksLikeHTMLPreview(lowercased) {
            lines = ["翻译接口返回了网页或网关页，而不是 JSON。请检查接口地址是否填成控制台网页、代理登录页，或缺少 `/v1/chat/completions`。"]
            if containsAny(lowercased, ["cloudflare", "captcha", "access denied", "attention required"]) {
                lines.append("响应内容看起来像 Cloudflare、防火墙或访问验证页面；如果你用了代理/网关，请先确认它允许 API 请求直达服务商。")
            } else if containsAny(lowercased, ["nginx", "gateway", "bad gateway", "upstream"]) {
                lines.append("响应内容看起来像 Nginx 或上游网关页面；请检查反向代理路径和上游服务是否正确。")
            } else if containsAny(lowercased, ["login", "sign in", "signin", "登录"]) {
                lines.append("响应内容看起来像登录页；请确认接口地址不是控制台网页，也没有被代理认证页拦截。")
            }
        } else if looksLikeJSONPreview(cleanPreview) {
            lines = ["翻译接口返回了 JSON，但结构不是 OpenAI Chat Completions 兼容格式。请确认接口路径、模型名和服务商兼容模式是否匹配。"]
        } else {
            lines = ["翻译接口返回了非 JSON 文本。请确认接口地址是 Chat Completions 兼容接口，而不是普通网页、健康检查地址或代理提示页。"]
        }

        lines.append("响应预览：\(cleanPreview)")
        return lines.joined(separator: "\n\n")
    }

    private static func sanitizedResponsePreview(_ preview: String?) -> String? {
        guard let preview else { return nil }
        let compact = preview
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !compact.isEmpty else { return nil }
        let maxLength = 180
        if compact.count > maxLength {
            return "\(compact.prefix(maxLength))..."
        }
        return compact
    }

    private static func looksLikeHTMLPreview(_ lowercasedPreview: String) -> Bool {
        lowercasedPreview.hasPrefix("<!doctype")
            || lowercasedPreview.hasPrefix("<html")
            || lowercasedPreview.contains("<body")
            || lowercasedPreview.contains("</html>")
            || containsAny(lowercasedPreview, ["cloudflare", "nginx", "captcha", "login", "sign in", "signin"])
    }

    private static func looksLikeJSONPreview(_ preview: String) -> Bool {
        preview.hasPrefix("{") || preview.hasPrefix("[")
    }

    private static func providerSpecificHint(from message: String) -> String? {
        let lowercased = message.lowercased()
        guard !lowercased.isEmpty else { return nil }

        if containsAny(lowercased, ["generativelanguage.googleapis.com", "gemini", "not found for api version", "is not found for api version", "google ai", "google api"]) {
            return "如果你用的是 Gemini 预设，请确认地址是 Gemini 的 OpenAI 兼容路径 `/v1beta/openai/chat/completions`，模型名可用，并且当前 API Key 已启用 Gemini API 权限。"
        }

        if containsAny(lowercased, ["openrouter", "openrouter.ai"]) {
            return "如果你用的是 OpenRouter 预设，请确认 API Key 有可用额度，模型 slug 可用；`openrouter/auto` 会路由到可用模型，但仍可能受上游供应商排队影响。"
        }

        if containsAny(lowercased, ["bigmodel", "open.bigmodel.cn", "zhipu", "智谱", "z.ai/api/paas", "glm-5.2", "glm-4-flash"]) {
            return "如果你用的是智谱预设，请确认接口地址是 `https://open.bigmodel.cn/api/paas/v4/chat/completions`，API Key 来自智谱开放平台，并且当前账号已开通所填 GLM 模型权限。"
        }

        if containsAny(lowercased, ["siliconflow", "siliconflow.cn", "硅基流动"]) {
            return "如果你用的是 SiliconFlow 预设，请确认账号已开通该模型，并核对模型名是否和控制台模型广场一致。"
        }

        if containsAny(lowercased, ["dashscope", "aliyuncs", "bailian", "百炼", "qwen"]) {
            return "如果你用的是阿里云百炼预设，请确认 DashScope API Key、模型服务和地域权限已开通；中国站部分三方模型需要先在控制台授权。"
        }

        if containsAny(lowercased, ["api.groq.com", "groqcloud", "groq api", "groq.com"]) {
            return "如果你用的是 Groq 预设，请重点检查 API Key、开发者计划的 RPM/TPM 限制，以及模型名是否仍在 Groq 支持列表内。"
        }

        if containsAny(lowercased, ["api.x.ai", "x-ai", "xai", "grok"]) {
            return "如果你用的是 xAI 预设，请确认接口地址是 `https://api.x.ai/v1/chat/completions`，并核对 Grok 模型名和账号权限。"
        }

        if containsAny(lowercased, ["moonshot", "kimi", "moonshot.cn"]) {
            return "如果你用的是 Kimi / Moonshot 预设，请在控制台确认当前 Key 可调用的模型名；不同账号或地区可用模型可能不同。"
        }

        return nil
    }

    private static func containsAny(_ text: String, _ needles: [String]) -> Bool {
        needles.contains { text.contains($0) }
    }

    private static func updateMessage(for error: UpdateCheckError) -> String {
        switch error {
        case .missingUpdateSource:
            return "当前构建没有配置更新源。正式发布包需要在构建时设置 APP_UPDATE_MANIFEST_URL，指向托管后的 update-manifest.json。"
        case .invalidUpdateSource:
            return "更新源地址不是有效 HTTP/HTTPS URL。请检查 APP_UPDATE_MANIFEST_URL 是否是完整的 HTTPS 地址。"
        case .badResponse(let statusCode):
            return "更新源返回 HTTP \(statusCode)。请确认 update-manifest.json 已上传，或稍后再试。"
        case .invalidManifest:
            return "更新清单格式不正确。请确认 update-manifest.json 包含 version、build、download_url 和 sha256。"
        case .invalidManifestField(let field, let value, let reason):
            return "更新清单里的 \(field) 不可用：\(value)。\(reason) 请检查托管后的 update-manifest.json。"
        case .invalidManifestURL(let field, let value):
            return "更新清单里的 \(field) 不是有效 HTTP/HTTPS 地址或相对路径：\(value)。请检查托管后的 update-manifest.json。"
        case .insecureManifestURL(let field, let value):
            return "更新清单是通过 HTTPS 加载的，但里面的 \(field) 指向 HTTP 地址：\(value)。请把下载包和发布说明也托管到 HTTPS，避免公开更新链路被拦截或替换。"
        }
    }

    private static func updateDownloadMessage(for error: UpdateDownloadError) -> String {
        switch error {
        case .badResponse(let statusCode):
            return "更新包下载返回 HTTP \(statusCode)。请稍后重试，或检查下载地址是否已发布。"
        case .invalidChecksum:
            return "更新清单里的 sha256 不是有效格式。请检查 update-manifest.json。"
        case .packageSizeMismatch(let expected, let actual):
            return """
            更新包大小与 update-manifest.json 不一致，请不要安装这个文件。

            manifest：\(ByteCountFormatter.string(fromByteCount: expected, countStyle: .file)) (\(expected) bytes)
            实际下载：\(ByteCountFormatter.string(fromByteCount: actual, countStyle: .file)) (\(actual) bytes)

            这通常表示上传错包、下载被截断，或托管/CDN 仍在返回旧文件。
            """
        case .checksumMismatch(let expected, let actual):
            return """
            更新包校验失败，请不要安装这个文件。

            期望 sha256：\(expected)
            实际 sha256：\(actual)
            """
        case .cannotPrepareDestination:
            return "无法准备 Downloads 下载目录。请检查目录权限后重试。"
        case .cannotExtractPackage(let reason):
            return """
            更新包 sha256 已通过，但无法解压检查 zip 内容，因此不会建议安装。

            原因：\(reason)
            """
        case .missingAppBundle:
            return "更新包 sha256 已通过，但 zip 里没有找到可安装的 `.app`。请检查发布包是否正确生成。"
        case .multipleAppBundles(let paths):
            return """
            更新包 sha256 已通过，但 zip 里发现多个 `.app`，无法安全判断要安装哪一个。

            发现：\(paths.joined(separator: ", "))
            """
        case .missingAppMetadata(let field):
            return "更新包 sha256 已通过，但 zip 里的 App 缺少 \(field)。请重新生成发布包。"
        case .bundleIdentifierMismatch(let expected, let actual):
            return """
            更新包 sha256 已通过，但 zip 里的 App Bundle ID 与当前 App 不一致，因此不会建议安装。

            期望：\(expected)
            实际：\(actual)
            """
        case .versionMismatch(let expected, let actual):
            return """
            更新包 sha256 已通过，但 zip 里的 App 版本号与 update-manifest.json 不一致。

            manifest：\(expected)
            zip 内 App：\(actual)
            """
        case .buildMismatch(let expected, let actual):
            return """
            更新包 sha256 已通过，但 zip 里的 App 构建号与 update-manifest.json 不一致。

            manifest：\(expected)
            zip 内 App：\(actual)
            """
        case .missingExecutable(let executable):
            return "更新包 sha256 已通过，但 zip 里的 App 缺少可执行文件 `\(executable)`。请重新生成发布包。"
        case .invalidCodeSignature(let reason):
            return """
            更新包 sha256 已通过，但 zip 里的 App 代码签名不可验证，因此不会建议安装。

            原因：\(reason)
            """
        }
    }

    private static func networkMessage(for error: URLError) -> String {
        let failingURL = (error.userInfo[NSURLErrorFailingURLErrorKey] as? URL)
            ?? (error.userInfo["NSErrorFailingURLStringKey"] as? String).flatMap(URL.init(string:))
        let isLocalEndpoint = isLocalHost(failingURL?.host)
        let endpoint = endpointDescription(for: failingURL)
        let endpointLine = endpoint.map { "\n\n出问题的主机：\($0)" } ?? ""

        switch error.code {
        case .notConnectedToInternet:
            return "当前没有网络连接。联网后再试一次。"
        case .timedOut:
            if isLocalEndpoint {
                return "本地翻译接口响应超时。\(localEndpointRecoveryHint(for: failingURL, reason: .timeout))\(endpointLine)"
            }
            return "翻译请求超时。可以稍后重试，或在设置里测试当前接口；如果首字等待也很久，通常是网络、代理、DNS 或模型排队。\(endpointLine)"
        case .cannotFindHost:
            return "找不到接口域名。请检查接口地址里的域名是否拼写正确，或当前 DNS/代理是否能解析这个服务商。\(endpointLine)"
        case .dnsLookupFailed:
            return "DNS 解析失败。请检查网络 DNS、代理/VPN，或换一个网络后再试。\(endpointLine)"
        case .cannotConnectToHost:
            if isLocalEndpoint {
                return "无法连接到本地翻译接口。\(localEndpointRecoveryHint(for: failingURL, reason: .cannotConnect))\(endpointLine)"
            }
            return "接口主机可以识别，但连接没有建立。常见原因是服务商入口不可达、代理/VPN 拦截、防火墙拦截，或接口端口不对。\(endpointLine)"
        case .badURL, .unsupportedURL:
            return "接口地址格式不正确。请在设置里填写完整的 HTTPS 地址。"
        case .appTransportSecurityRequiresSecureConnection:
            return "macOS 拦截了非安全连接。请优先使用 HTTPS 接口；如果是本地代理，请确认地址和系统安全策略。\(endpointLine)"
        case .cannotLoadFromNetwork:
            return "当前网络策略不允许加载这个接口。请检查代理、VPN、防火墙或系统网络权限。\(endpointLine)"
        case .badServerResponse:
            return "服务商返回了异常响应。请稍后重试，或检查接口地址是否指向 Chat Completions。\(endpointLine)"
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid:
            return "无法建立安全连接。请检查接口是否使用可信 HTTPS 证书；如果走代理，也请检查代理证书是否被系统信任。\(endpointLine)"
        case .clientCertificateRequired, .clientCertificateRejected:
            return "接口要求客户端证书认证。普通 OpenAI 兼容接口通常不需要证书，请检查代理、网关或企业网络配置。\(endpointLine)"
        case .userAuthenticationRequired:
            return "服务商要求认证。请检查 API Key 是否填写、是否属于当前接口地址。\(endpointLine)"
        case .networkConnectionLost:
            return "网络连接中断。请检查当前网络、代理或 VPN 是否稳定后再试一次。\(endpointLine)"
        case .dataNotAllowed:
            return "系统当前不允许使用数据网络。请检查网络权限、低数据模式或代理/VPN 设置。\(endpointLine)"
        case .cannotParseResponse:
            return "接口响应无法解析。常见原因是地址填到了网页、代理登录页或非 Chat Completions 接口。\(endpointLine)"
        case .httpTooManyRedirects, .redirectToNonExistentLocation:
            return "接口发生异常跳转。请检查地址是否填成控制台网页、登录页、短链，或代理网关是否要求登录。\(endpointLine)"
        default:
            return "网络请求失败。请检查网络连接和接口地址。\(endpointLine)\n\n详细信息：\(error.localizedDescription)"
        }
    }

    private static func endpointDescription(for url: URL?) -> String? {
        guard let host = url?.host, !host.isEmpty else { return nil }
        guard let port = url?.port else { return host }
        return "\(host):\(port)"
    }

    private enum LocalEndpointRecoveryReason {
        case cannotConnect
        case timeout
    }

    private static func localEndpointRecoveryHint(for url: URL?, reason: LocalEndpointRecoveryReason) -> String {
        let actionPrefix: String
        switch reason {
        case .cannotConnect:
            actionPrefix = "请先确认本机服务已启动，端口和路径正确。"
        case .timeout:
            actionPrefix = "请确认本机服务还在运行、模型已加载完成。"
        }

        switch url?.port {
        case 11434:
            return "\(actionPrefix) 这看起来像 Ollama：可先运行 `ollama list` / `ollama pull <模型名>`，并确认路径类似 `http://localhost:11434/v1/chat/completions`。"
        case 1234:
            return "\(actionPrefix) 这看起来像 LM Studio：请在 Developer 里 Start Server、加载模型，并把模型名改成已加载模型的 identifier。"
        case 8000:
            return "\(actionPrefix) 这看起来像 vLLM：请确认 `vllm serve <模型名>` 仍在运行，并检查 `/v1/models` 是否能返回模型列表。"
        default:
            return "\(actionPrefix) 如果是本地 OpenAI 兼容服务，请检查服务进程、端口、防火墙和 `/v1/chat/completions` 路径。"
        }
    }

    private static func isLocalHost(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else { return false }
        return host == "localhost"
            || host == "127.0.0.1"
            || host == "::1"
            || host == "0.0.0.0"
    }
}
