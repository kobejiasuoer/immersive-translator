#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SETTINGS_SOURCE="$ROOT_DIR/Sources/ImmersiveTranslator/Settings.swift"
CLIENT_SOURCE="$ROOT_DIR/Sources/ImmersiveTranslator/TranslationClient.swift"
ERROR_SOURCE="$ROOT_DIR/Sources/ImmersiveTranslator/ErrorMessageFormatter.swift"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ImmersiveTranslator-provider-body-inspector.XXXXXX")"
CHECK_PATH="$TMP_DIR/ProviderConnectionBodyInspectorCheck.swift"
BINARY_PATH="$TMP_DIR/check_provider_connection_body_inspector"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

{
    printf 'import Foundation\n\n'
    cat <<'SWIFT'

private enum ProviderConnectionDiagnosticLevel: Equatable {
    case idle
    case success
    case warning
    case failure
}

SWIFT
    awk '
        /^enum TranslationErrorIssue / { printing = 1 }
        /^enum ErrorMessageFormatter / { printing = 0 }
        printing { print }
    ' "$ERROR_SOURCE"
    awk '
        /^(private )?enum TranslationResponseErrorParser / { printing = 1 }
        /^private struct RequestOptions / { printing = 0 }
        printing { print }
    ' "$CLIENT_SOURCE"
    awk '
        /^private struct APIErrorResponse([: ]|$)/ { printing = 1 }
        /^private extension String / { printing = 0 }
        printing { print }
    ' "$CLIENT_SOURCE"
    awk '
        /^private extension String / { printing = 1 }
        printing { print }
    ' "$CLIENT_SOURCE"
    cat <<'SWIFT'

private enum TranslationClient {
SWIFT
    awk '
        /^    static func chatCompletionsURL/ { printing = 1 }
        /^    private static func parseStreamedResponse/ { printing = 0 }
        printing { print }
    ' "$CLIENT_SOURCE"
    cat <<'SWIFT'
}
SWIFT
    awk '
        /^private struct ProviderConnectionBodyInspection([: ]|$)/ { printing = 1 }
        /^private struct ProviderConfigurationHint([: ]|$)/ { printing = 0 }
        printing { print }
    ' "$SETTINGS_SOURCE"
    cat <<'SWIFT'

@main
private struct ProviderConnectionBodyInspectorCheck {
    private struct Case {
        let name: String
        let data: Data
        let expectedLevel: ProviderConnectionDiagnosticLevel?
        let expectedSnippets: [String]
    }

    static func main() {
        let cases: [Case] = [
            Case(
                name: "empty body is acceptable",
                data: Data(),
                expectedLevel: nil,
                expectedSnippets: []
            ),
            Case(
                name: "normal json is acceptable",
                data: Data(#"{"object":"list","data":[]}"#.utf8),
                expectedLevel: nil,
                expectedSnippets: []
            ),
            Case(
                name: "error json warns",
                data: Data(#"{"error":{"message":"model_not_found: model does not exist"}}"#.utf8),
                expectedLevel: .warning,
                expectedSnippets: ["错误 JSON", "model_not_found", "判断为「模型名或模型权限异常」", "核对模型名"]
            ),
            Case(
                name: "error json billing gives next step",
                data: Data(#"{"error":{"message":"insufficient_quota: out of credits"}}"#.utf8),
                expectedLevel: .warning,
                expectedSnippets: ["错误 JSON", "余额或额度不足", "检查余额、账单状态"]
            ),
            Case(
                name: "html warns",
                data: Data("<!doctype html><html><body>Login required</body></html>".utf8),
                expectedLevel: .warning,
                expectedSnippets: ["网页或网关页", "Login required"]
            ),
            Case(
                name: "cloudflare timeout text gives timeout next step",
                data: Data("Cloudflare error 524: a timeout occurred".utf8),
                expectedLevel: .warning,
                expectedSnippets: ["网页或网关页", "Cloudflare error 524", "判断为「网络或服务商响应超时」", "开启流式显示"]
            ),
            Case(
                name: "server overloaded text gives service next step",
                data: Data("The upstream service is temporarily unavailable because the server is overloaded.".utf8),
                expectedLevel: .warning,
                expectedSnippets: ["非 JSON 文本", "服务商暂时不可用", "切换到另一个低延迟预设"]
            ),
            Case(
                name: "plain text warns",
                data: Data("healthy".utf8),
                expectedLevel: .warning,
                expectedSnippets: ["非 JSON 文本", "healthy"]
            ),
            Case(
                name: "non utf8 warns",
                data: Data([0xFF, 0xFE, 0xFD]),
                expectedLevel: .warning,
                expectedSnippets: ["不是 UTF-8 JSON"]
            )
        ]

        var failures: [String] = []
        for testCase in cases {
            let inspection = ProviderConnectionBodyInspector.inspect(data: testCase.data, elapsedText: "0.1s")
            if inspection?.level != testCase.expectedLevel {
                failures.append(
                    """
                    \(testCase.name)
                    expected level: \(String(describing: testCase.expectedLevel))
                    actual level: \(String(describing: inspection?.level))
                    """
                )
                continue
            }
            let message = inspection?.message ?? ""
            for snippet in testCase.expectedSnippets where !message.contains(snippet) {
                failures.append(
                    """
                    \(testCase.name)
                    missing snippet: \(snippet)
                    actual message: \(message)
                    """
                )
            }
        }

        if failures.isEmpty {
            print("ok: provider connection body inspector cases passed (\(cases.count))")
        } else {
            fputs("error: provider connection body inspector regression\n\n\(failures.joined(separator: "\n\n"))\n", stderr)
            exit(1)
        }
    }
}
SWIFT
} > "$CHECK_PATH"

if ! grep -q "ProviderConnectionBodyInspector" "$CHECK_PATH"; then
    echo "error: failed to extract ProviderConnectionBodyInspector from $SETTINGS_SOURCE" >&2
    exit 1
fi

if ! grep -q "TranslationErrorIssue" "$CHECK_PATH"; then
    echo "error: failed to extract TranslationErrorIssue from $ERROR_SOURCE" >&2
    exit 1
fi

swiftc -parse-as-library "$CHECK_PATH" -o "$BINARY_PATH"
"$BINARY_PATH"
