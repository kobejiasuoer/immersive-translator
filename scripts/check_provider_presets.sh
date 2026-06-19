#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SETTINGS_SOURCE="$ROOT_DIR/Sources/ImmersiveTranslator/Settings.swift"
CLIENT_SOURCE="$ROOT_DIR/Sources/ImmersiveTranslator/TranslationClient.swift"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ImmersiveTranslator-provider-presets.XXXXXX")"
CHECK_PATH="$TMP_DIR/ProviderPresetsCheck.swift"
BINARY_PATH="$TMP_DIR/check_provider_presets"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

{
    printf 'import Foundation\n\n'
    awk '
        /^struct TranslationProviderPreset[: ]/ { printing = 1 }
        /^private struct ProviderConnectionDiagnostic/ { printing = 0 }
        printing { print }
    ' "$SETTINGS_SOURCE"
    awk '
        /^private enum ProviderDiagnosticKind[: ]/ { printing = 1 }
        /^private enum ProviderConnectionDiagnosticLevel/ { printing = 0 }
        printing { print }
    ' "$SETTINGS_SOURCE"
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

@main
private struct ProviderPresetsCheck {
    static func main() {
        var failures: [String] = []
        let presets = TranslationProviderPreset.all

        expect(presets.count == 3, "provider presets should only expose the three built-in cloud presets", failures: &failures)
        expect(Set(presets.map(\.id)).count == presets.count, "provider preset ids should be unique", failures: &failures)
        expect(Set(presets.map(\.title)).count == presets.count, "provider preset titles should be unique", failures: &failures)

        for preset in presets {
            validatePreset(preset, failures: &failures)
        }

        expect(
            presets.contains { $0.id == "deepseek-v4-flash" && $0.endpoint == "https://api.deepseek.com/chat/completions" && $0.model == "deepseek-v4-flash" },
            "DeepSeek V4 Flash preset should remain available",
            failures: &failures
        )
        expect(
            presets.contains { $0.id == "openai-gpt-5-4-mini" && $0.model == "gpt-5.4-mini" },
            "OpenAI daily-use preset should remain available",
            failures: &failures
        )
        expect(
            presets.contains { $0.id == "zhipu-glm-5-2" && $0.endpoint == "https://open.bigmodel.cn/api/paas/v4/chat/completions" && $0.model == "glm-5.2" },
            "Zhipu GLM-5.2 preset should remain available with the official Chat Completions endpoint",
            failures: &failures
        )
        expect(
            !presets.contains { $0.id == "ollama-llama3-2" || $0.id == "lmstudio-local" || $0.id == "vllm-local" },
            "local provider presets should no longer be exposed as built-in cards",
            failures: &failures
        )

        checkRequiresAPIKeyRules(failures: &failures)
        checkDiagnosticURLRedaction(failures: &failures)
        checkSensitiveQueryDetection(failures: &failures)
        checkConfigurationAdvisor(failures: &failures)
        checkLatencyAssessment(failures: &failures)

        if failures.isEmpty {
            print("ok: provider preset cases passed (\(presets.count) presets)")
        } else {
            fputs("error: provider preset regression\n\n\(failures.joined(separator: "\n\n"))\n", stderr)
            exit(1)
        }
    }

    private static func validatePreset(_ preset: TranslationProviderPreset, failures: inout [String]) {
        let label = "\(preset.id) / \(preset.title)"
        expect(!preset.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "\(label): id should not be empty", failures: &failures)
        expect(!preset.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "\(label): title should not be empty", failures: &failures)
        expect(!preset.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "\(label): model should not be empty", failures: &failures)
        expect(!preset.detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "\(label): detail should explain when to use it", failures: &failures)
        expect(!preset.latencyHint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "\(label): latency hint should not be empty", failures: &failures)

        guard let url = TranslationClient.chatCompletionsURL(from: preset.endpoint) else {
            failures.append("\(label): endpoint is not a valid Chat Completions URL: \(preset.endpoint)")
            return
        }

        expect(url.path.hasSuffix("/chat/completions"), "\(label): normalized URL should end in /chat/completions, got \(url.path)", failures: &failures)

        let host = url.host?.lowercased() ?? ""
        let isLocal = ["localhost", "127.0.0.1", "::1", "0.0.0.0"].contains(host)
        if isLocal {
            expect(!TranslationClient.requiresAPIKey(for: url), "\(label): local endpoint should not require API Key", failures: &failures)
            expect(preset.detail.contains("本地") || preset.latencyHint.contains("本地") || preset.latencyHint.contains("ollama"), "\(label): local preset should explain local-model behavior", failures: &failures)
        } else {
            expect(url.scheme == "https", "\(label): cloud preset should use HTTPS, got \(url.absoluteString)", failures: &failures)
            expect(TranslationClient.requiresAPIKey(for: url), "\(label): cloud endpoint should require API Key", failures: &failures)
        }

        let hintText = preset.latencyHint.lowercased()
        let hasActionableHint = ["慢", "429", "401", "403", "404", "key", "api key", "模型", "权限", "排队", "网络", "延迟", "ollama", "pull"].contains { hintText.contains($0) }
        expect(hasActionableHint, "\(label): latency hint should include an actionable diagnosis cue", failures: &failures)
    }

    private static func checkRequiresAPIKeyRules(failures: inout [String]) {
        let localEndpoints = [
            "http://localhost:11434/v1/chat/completions",
            "http://127.0.0.1:1234/v1",
            "http://0.0.0.0:8000",
            "http://[::1]:11434/v1/chat/completions"
        ]
        for endpoint in localEndpoints {
            expect(!TranslationClient.requiresAPIKey(for: endpoint), "\(endpoint) should not require API Key", failures: &failures)
        }

        let remoteEndpoints = [
            "https://api.openai.com/v1/chat/completions",
            "https://openrouter.ai/api/v1/chat/completions",
            "https://api.deepseek.com/chat/completions"
        ]
        for endpoint in remoteEndpoints {
            expect(TranslationClient.requiresAPIKey(for: endpoint), "\(endpoint) should require API Key", failures: &failures)
        }

        expect(TranslationClient.chatCompletionsURL(from: "https://api.example.com")?.absoluteString == "https://api.example.com/v1/chat/completions", "bare host should normalize to /v1/chat/completions", failures: &failures)
        expect(TranslationClient.chatCompletionsURL(from: "https://api.example.com/v1")?.absoluteString == "https://api.example.com/v1/chat/completions", "/v1 endpoint should normalize to chat completions", failures: &failures)
        expect(TranslationClient.chatCompletionsURL(from: "https://api.example.com/openai")?.absoluteString == "https://api.example.com/openai/chat/completions", "compatibility path should append chat completions", failures: &failures)
        expect(TranslationClient.chatCompletionsURL(from: "not a url") == nil, "invalid endpoint should not normalize", failures: &failures)
    }

    private static func checkDiagnosticURLRedaction(failures: inout [String]) {
        let redacted = TranslationClient.redactedURLString(
            "https://api.example.com/v1/chat/completions?api_key=sk-secret&model=ok&access-token=tok-secret#frag"
        )
        expect(!redacted.contains("sk-secret"), "api_key query value should be redacted: \(redacted)", failures: &failures)
        expect(!redacted.contains("tok-secret"), "access token query value should be redacted: \(redacted)", failures: &failures)
        expect(redacted.contains("api_key=REDACTED"), "redacted URL should keep api_key name for debugging: \(redacted)", failures: &failures)
        expect(redacted.contains("access-token=REDACTED"), "redacted URL should keep access-token name for debugging: \(redacted)", failures: &failures)
        expect(redacted.contains("model=ok"), "non-sensitive query value should be preserved: \(redacted)", failures: &failures)
        expect(redacted.hasSuffix("#frag"), "URL fragment should be preserved: \(redacted)", failures: &failures)

        let googleKey = TranslationClient.redactedURLString(
            "https://example.com/openai/chat/completions?x-goog-api-key=real-key&pretty=true"
        )
        expect(!googleKey.contains("real-key"), "x-goog-api-key should be redacted: \(googleKey)", failures: &failures)
        expect(googleKey.contains("pretty=true"), "safe query items should survive redaction: \(googleKey)", failures: &failures)

        let unchanged = "https://api.example.com/v1/chat/completions?model=gpt&debug=true"
        expect(
            TranslationClient.redactedURLString(unchanged) == unchanged,
            "URL without sensitive query names should stay unchanged",
            failures: &failures
        )
    }

    private static func checkSensitiveQueryDetection(failures: inout [String]) {
        let sensitiveNames = TranslationClient.sensitiveQueryItemNames(
            in: "https://api.example.com/v1/chat/completions?api_key=sk-secret&model=ok&access-token=tok-secret&x-goog-api-key=google-secret"
        )
        expect(
            sensitiveNames == ["api_key", "access-token", "x-goog-api-key"],
            "sensitive query detection should preserve visible names in order: \(sensitiveNames)",
            failures: &failures
        )

        let duplicateNames = TranslationClient.sensitiveQueryItemNames(
            in: "https://api.example.com/v1/chat/completions?token=one&TOKEN=two&model=ok"
        )
        expect(
            duplicateNames == ["token"],
            "sensitive query detection should deduplicate names case-insensitively: \(duplicateNames)",
            failures: &failures
        )

        let safeNames = TranslationClient.sensitiveQueryItemNames(
            in: "https://api.example.com/v1/chat/completions?model=gpt&debug=true&pretty=1"
        )
        expect(
            safeNames.isEmpty,
            "safe query items should not be reported as credentials: \(safeNames)",
            failures: &failures
        )
    }

    private static func checkConfigurationAdvisor(failures: inout [String]) {
        let message = ProviderConfigurationAdvisor.sensitiveQueryItemsMessage(
            for: "https://api.example.com/v1/chat/completions?api_key=sk-secret&token=tok-secret&model=ok"
        )
        expect(
            message?.contains("api_key、token") == true,
            "configuration advisor should list sensitive query names in the settings warning: \(message ?? "<nil>")",
            failures: &failures
        )
        expect(
            message?.contains("API Key 字段") == true,
            "configuration advisor should tell users to move credentials to the API Key field: \(message ?? "<nil>")",
            failures: &failures
        )
        expect(
            message?.contains("自动脱敏") == true,
            "configuration advisor should explain diagnostics/logs are redacted: \(message ?? "<nil>")",
            failures: &failures
        )
        expect(
            ProviderConfigurationAdvisor.sensitiveQueryItemsMessage(
                for: "https://api.example.com/v1/chat/completions?model=gpt&debug=true"
            ) == nil,
            "configuration advisor should not warn for safe query items",
            failures: &failures
        )
    }

    private static func checkLatencyAssessment(failures: inout [String]) {
        expect(
            ProviderLatencyAssessment.make(kind: .connection, elapsed: 1.4, isLocalEndpoint: false)?.label == "连接正常",
            "remote connection under 1.5s should be normal",
            failures: &failures
        )
        expect(
            ProviderLatencyAssessment.make(kind: .connection, elapsed: 2.5, isLocalEndpoint: false)?.label == "连接偏慢",
            "remote connection around 2.5s should be marked slow-ish",
            failures: &failures
        )
        expect(
            ProviderLatencyAssessment.make(kind: .connection, elapsed: 4.5, isLocalEndpoint: false)?.label == "连接很慢",
            "remote connection over 4s should be marked very slow",
            failures: &failures
        )
        expect(
            ProviderLatencyAssessment.make(kind: .translation, elapsed: 2.9, isLocalEndpoint: false)?.label == "短翻译正常",
            "remote short translation under 3s should be normal",
            failures: &failures
        )
        expect(
            ProviderLatencyAssessment.make(kind: .translation, elapsed: 6.0, isLocalEndpoint: false)?.nextStepText?.contains("流式") == true,
            "slow remote short translation should suggest streaming",
            failures: &failures
        )
        expect(
            ProviderLatencyAssessment.make(kind: .translation, elapsed: 13.0, isLocalEndpoint: true)?.nextStepText?.contains("更小模型") == true,
            "very slow local translation should suggest smaller model",
            failures: &failures
        )
        expect(
            ProviderLatencyAssessment.make(kind: .configuration, elapsed: 1.0, isLocalEndpoint: false) == nil,
            "configuration diagnostics should not produce latency assessment",
            failures: &failures
        )
    }

    private static func expect(_ condition: Bool, _ message: String, failures: inout [String]) {
        if !condition {
            failures.append(message)
        }
    }
}
SWIFT
} > "$CHECK_PATH"

if ! grep -q "TranslationProviderPreset" "$CHECK_PATH"; then
    echo "error: failed to extract TranslationProviderPreset from $SETTINGS_SOURCE" >&2
    exit 1
fi

if ! grep -q "chatCompletionsURL" "$CHECK_PATH"; then
    echo "error: failed to extract TranslationClient URL helpers from $CLIENT_SOURCE" >&2
    exit 1
fi

if ! awk '/private static func providerNetworkDiagnosticMessage/,/private static func isLocalProviderHost/' "$SETTINGS_SOURCE" | grep -q 'localProviderRecoveryHint(for: url, reason: \.cannotConnect)'; then
    echo "error: provider connection diagnostics should use local endpoint recovery hints for connection failures" >&2
    exit 1
fi

if ! awk '/private static func providerNetworkDiagnosticMessage/,/private static func isLocalProviderHost/' "$SETTINGS_SOURCE" | grep -q 'localProviderRecoveryHint(for: url, reason: \.timeout)'; then
    echo "error: provider connection diagnostics should use local endpoint recovery hints for timeouts" >&2
    exit 1
fi

if ! awk '/private static func localProviderRecoveryHint/,/private static func isLocalProviderHost/' "$SETTINGS_SOURCE" | grep -q 'Ollama'; then
    echo "error: local provider diagnostics should mention Ollama for port 11434" >&2
    exit 1
fi

if ! awk '/private static func localProviderRecoveryHint/,/private static func isLocalProviderHost/' "$SETTINGS_SOURCE" | grep -q 'LM Studio'; then
    echo "error: local provider diagnostics should mention LM Studio for port 1234" >&2
    exit 1
fi

if ! awk '/private static func localProviderRecoveryHint/,/private static func isLocalProviderHost/' "$SETTINGS_SOURCE" | grep -q 'vLLM'; then
    echo "error: local provider diagnostics should mention vLLM for port 8000" >&2
    exit 1
fi

swiftc -parse-as-library "$CHECK_PATH" -o "$BINARY_PATH"
"$BINARY_PATH"
