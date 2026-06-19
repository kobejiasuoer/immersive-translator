#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_PATH="$ROOT_DIR/Sources/ImmersiveTranslator/ErrorMessageFormatter.swift"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ImmersiveTranslator-error-classification.XXXXXX")"
CHECK_PATH="$TMP_DIR/ErrorClassificationCheck.swift"
BINARY_PATH="$TMP_DIR/check_error_classification"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

{
    printf 'import Foundation\n'
    cat <<'SWIFT'

enum TranslationClientError: LocalizedError {
    case invalidEndpoint
    case missingAPIKey
    case badResponse(statusCode: Int, message: String?)
    case emptyTranslation
    case invalidResponse(preview: String?)
}

enum SelectedTextReaderError: LocalizedError {
    case generic
}

enum OCRError: LocalizedError {
    case generic
}

enum UpdateCheckError: Error {
    case missingUpdateSource
    case invalidUpdateSource
    case badResponse(statusCode: Int)
    case invalidManifest
    case invalidManifestField(field: String, value: String, reason: String)
    case invalidManifestURL(field: String, value: String)
    case insecureManifestURL(field: String, value: String)
}

enum UpdateDownloadError: Error {
    case badResponse(statusCode: Int)
    case invalidChecksum
    case packageSizeMismatch(expected: Int64, actual: Int64)
    case checksumMismatch(expected: String, actual: String)
    case cannotPrepareDestination
    case cannotExtractPackage(reason: String)
    case missingAppBundle
    case multipleAppBundles(paths: [String])
    case missingAppMetadata(field: String)
    case bundleIdentifierMismatch(expected: String, actual: String)
    case versionMismatch(expected: String, actual: String)
    case buildMismatch(expected: String, actual: String)
    case missingExecutable(executable: String)
    case invalidCodeSignature(reason: String)
}

enum UpdateInstallPreparationError: LocalizedError {
    case generic
}

SWIFT
    awk '
        /^enum TranslationErrorIssue / { printing = 1 }
        printing { print }
    ' "$SOURCE_PATH"
    cat <<'SWIFT'

@main
private struct ErrorClassificationCheck {
    private struct Case {
        let name: String
        let statusCode: Int?
        let message: String?
        let expected: TranslationErrorIssue?
    }

    static func main() {
        let classificationCases: [Case] = [
            Case(
                name: "openai content filter",
                statusCode: 400,
                message: "The response was filtered due to the content_filter policy.",
                expected: .contentPolicy
            ),
            Case(
                name: "azure responsible ai policy",
                statusCode: 400,
                message: "ResponsibleAIPolicyViolation: This prompt was blocked by policy.",
                expected: .contentPolicy
            ),
            Case(
                name: "chinese content safety",
                statusCode: 400,
                message: "内容安全审核未通过，请调整敏感内容后重试。",
                expected: .contentPolicy
            ),
            Case(
                name: "rate limit stays rate limit",
                statusCode: 429,
                message: "Rate limit exceeded for requests per minute.",
                expected: .rateLimit
            ),
            Case(
                name: "billing stays billing",
                statusCode: 402,
                message: "insufficient_quota: out of credits",
                expected: .billing
            ),
            Case(
                name: "payment required stays billing",
                statusCode: 402,
                message: "Payment required: add a payment method or increase your billing hard limit.",
                expected: .billing
            ),
            Case(
                name: "trial quota exhausted stays billing",
                statusCode: 400,
                message: "Your trial quota has been exhausted and no credits remain.",
                expected: .billing
            ),
            Case(
                name: "chinese recharge hint stays billing",
                statusCode: 200,
                message: "账户余额不足，请充值后继续调用。",
                expected: .billing
            ),
            Case(
                name: "missing authorization header is api key",
                statusCode: 401,
                message: "Missing Authorization header",
                expected: .apiKey
            ),
            Case(
                name: "bearer token required is api key",
                statusCode: 401,
                message: "Bearer token required for this endpoint",
                expected: .apiKey
            ),
            Case(
                name: "chinese missing api key is api key",
                statusCode: 200,
                message: "缺少 API Key，请在请求头中提供认证信息。",
                expected: .apiKey
            ),
            Case(
                name: "model not found stays model",
                statusCode: 404,
                message: "model_not_found: model does not exist",
                expected: .modelName
            ),
            Case(
                name: "context length exceeded",
                statusCode: 400,
                message: "context_length_exceeded: This model's maximum context length is 8192 tokens.",
                expected: .textTooLong
            ),
            Case(
                name: "payload too large without status",
                statusCode: nil,
                message: "Payload too large: reduce the length of the messages.",
                expected: .textTooLong
            ),
            Case(
                name: "node proxy cannot post is endpoint",
                statusCode: 404,
                message: "Cannot POST /v1/chat/completions",
                expected: .endpoint
            ),
            Case(
                name: "plain 404 not found is endpoint",
                statusCode: 404,
                message: "404 Not Found: no handler for /v1/chat/completions",
                expected: .endpoint
            ),
            Case(
                name: "model not found stays model despite 404",
                statusCode: 404,
                message: "model_not_found: model does not exist",
                expected: .modelName
            ),
            Case(
                name: "cloudflare 524 is timeout not html",
                statusCode: 524,
                message: "Cloudflare error 524: a timeout occurred",
                expected: .timeout
            ),
            Case(
                name: "cloudflare 521 is service unavailable not html",
                statusCode: 521,
                message: "Cloudflare error 521: web server is down",
                expected: .serviceUnavailable
            ),
            Case(
                name: "upstream timeout text without status",
                statusCode: nil,
                message: "upstream timed out while reading response header from upstream",
                expected: .timeout
            ),
            Case(
                name: "server busy text without status",
                statusCode: nil,
                message: "The upstream service is temporarily unavailable because the server is overloaded.",
                expected: .serviceUnavailable
            )
        ]

        var failures: [String] = []
        for testCase in classificationCases {
            let actual = TranslationErrorIssue.classify(
                statusCode: testCase.statusCode,
                message: testCase.message
            )
            if actual != testCase.expected {
                failures.append(
                    """
                    \(testCase.name)
                    expected: \(String(describing: testCase.expected))
                    actual: \(String(describing: actual))
                    """
                )
            }
        }

        let messageCases: [(name: String, error: TranslationClientError, expectedSnippets: [String])] = [
            (
                name: "html invalid response",
                error: .invalidResponse(preview: "<!doctype html><html><title>Login</title><body>Cloudflare captcha</body></html>"),
                expectedSnippets: ["网页或网关页", "Cloudflare", "响应预览"]
            ),
            (
                name: "non utf8 invalid response",
                error: .invalidResponse(preview: "<non-utf8>"),
                expectedSnippets: ["不是 UTF-8 JSON", "代理、网关"]
            ),
            (
                name: "json wrong shape invalid response",
                error: .invalidResponse(preview: #"{"ok":true,"data":[]}"#),
                expectedSnippets: ["返回了 JSON", "结构不是 OpenAI Chat Completions"]
            ),
            (
                name: "plain text invalid response",
                error: .invalidResponse(preview: "upstream health check: ok"),
                expectedSnippets: ["非 JSON 文本", "响应预览"]
            ),
            (
                name: "missing preview invalid response",
                error: .invalidResponse(preview: nil),
                expectedSnippets: ["返回格式不符合预期", "Chat Completions"]
            ),
            (
                name: "http 200 error json model hint",
                error: .badResponse(statusCode: 200, message: "model_not_found: model does not exist"),
                expectedSnippets: ["接口连通成功", "模型名不存在", "接口原始提示"]
            ),
            (
                name: "http 200 error json billing hint",
                error: .badResponse(statusCode: 200, message: "insufficient_quota: out of credits"),
                expectedSnippets: ["接口连通成功", "余额、额度或计费状态问题", "接口原始提示"]
            ),
            (
                name: "http 200 missing authorization header api key hint",
                error: .badResponse(statusCode: 200, message: "Missing Authorization header"),
                expectedSnippets: ["接口连通成功", "API Key 无效或不属于当前接口", "接口原始提示"]
            ),
            (
                name: "zhipu provider hint",
                error: .badResponse(statusCode: 403, message: "open.bigmodel.cn permission denied for model glm-5.2"),
                expectedSnippets: ["智谱预设", "https://open.bigmodel.cn/api/paas/v4/chat/completions", "智谱开放平台", "GLM 模型权限"]
            ),
            (
                name: "http 200 error json text too long hint",
                error: .badResponse(statusCode: 200, message: "context_length_exceeded: prompt tokens exceed the maximum number of tokens"),
                expectedSnippets: ["接口连通成功", "上下文、Token 或请求体大小限制", "缩小 OCR/选中文本范围", "接口原始提示"]
            ),
            (
                name: "http 413 text too long hint",
                error: .badResponse(statusCode: 413, message: "request body too large"),
                expectedSnippets: ["这段文本对当前接口来说太长", "分批翻译", "请求体大小限制"]
            ),
            (
                name: "http 404 cannot post endpoint hint",
                error: .badResponse(statusCode: 404, message: "Cannot POST /v1/chat/completions"),
                expectedSnippets: ["没有找到接口或模型", "接口地址不对", "Chat Completions", "接口原始提示"]
            ),
            (
                name: "http 524 cloudflare timeout hint",
                error: .badResponse(statusCode: 524, message: "Cloudflare error 524: a timeout occurred"),
                expectedSnippets: ["Cloudflare/网关层超时", "开启流式显示", "切换低延迟预设", "接口原始提示"]
            ),
            (
                name: "http 521 cloudflare origin hint",
                error: .badResponse(statusCode: 521, message: "Cloudflare error 521: web server is down"),
                expectedSnippets: ["无法连接上游服务", "服务商源站异常", "切换服务商预设", "接口原始提示"]
            )
        ]

        for testCase in messageCases {
            let actual = ErrorMessageFormatter.message(for: testCase.error)
            for snippet in testCase.expectedSnippets where !actual.contains(snippet) {
                failures.append(
                    """
                    \(testCase.name)
                    missing snippet: \(snippet)
                    actual: \(actual)
                    """
                )
            }
        }

        let updateMessage = ErrorMessageFormatter.message(
            for: UpdateCheckError.insecureManifestURL(
                field: "download_url",
                value: "http://example.com/ImmersiveTranslator.zip"
            )
        )
        for snippet in ["HTTPS 加载", "HTTP 地址", "下载包和发布说明也托管到 HTTPS"] where !updateMessage.contains(snippet) {
            failures.append(
                """
                update insecure url message
                missing snippet: \(snippet)
                actual: \(updateMessage)
                """
            )
        }

        let networkCases: [(name: String, error: URLError, expectedSnippets: [String])] = [
            (
                name: "ollama local connection failure",
                error: urlError(
                    .cannotConnectToHost,
                    failingURL: "http://localhost:11434/v1/chat/completions"
                ),
                expectedSnippets: ["无法连接到本地翻译接口", "Ollama", "ollama list", "ollama pull", "localhost:11434"]
            ),
            (
                name: "lm studio local connection failure",
                error: urlError(
                    .cannotConnectToHost,
                    failingURL: "http://localhost:1234/v1/chat/completions"
                ),
                expectedSnippets: ["无法连接到本地翻译接口", "LM Studio", "Start Server", "identifier", "localhost:1234"]
            ),
            (
                name: "vllm local timeout",
                error: urlError(
                    .timedOut,
                    failingURL: "http://127.0.0.1:8000/v1/chat/completions"
                ),
                expectedSnippets: ["本地翻译接口响应超时", "vLLM", "vllm serve", "/v1/models", "127.0.0.1:8000"]
            ),
            (
                name: "unknown local port fallback",
                error: urlError(
                    .cannotConnectToHost,
                    failingURL: "http://localhost:9001/v1/chat/completions"
                ),
                expectedSnippets: ["本地 OpenAI 兼容服务", "服务进程", "/v1/chat/completions", "localhost:9001"]
            )
        ]

        for testCase in networkCases {
            let actual = ErrorMessageFormatter.message(for: testCase.error)
            for snippet in testCase.expectedSnippets where !actual.contains(snippet) {
                failures.append(
                    """
                    \(testCase.name)
                    missing snippet: \(snippet)
                    actual: \(actual)
                    """
                )
            }
        }

        if failures.isEmpty {
            print("ok: error classification cases passed (\(classificationCases.count)); invalid response messages passed (\(messageCases.count)); network messages passed (\(networkCases.count))")
        } else {
            fputs("error: error classification regression\n\n\(failures.joined(separator: "\n\n"))\n", stderr)
            exit(1)
        }
    }

    private static func urlError(_ code: URLError.Code, failingURL: String) -> URLError {
        let url = URL(string: failingURL)!
        return URLError(
            code,
            userInfo: [
                NSURLErrorFailingURLErrorKey: url,
                "NSErrorFailingURLStringKey": failingURL
            ]
        )
    }
}
SWIFT
} > "$CHECK_PATH"

if ! grep -q "TranslationErrorIssue" "$CHECK_PATH"; then
    echo "error: failed to extract TranslationErrorIssue from $SOURCE_PATH" >&2
    exit 1
fi

if ! grep -q "ErrorMessageFormatter" "$CHECK_PATH"; then
    echo "error: failed to extract ErrorMessageFormatter from $SOURCE_PATH" >&2
    exit 1
fi

swiftc -parse-as-library "$CHECK_PATH" -o "$BINARY_PATH"
"$BINARY_PATH"
