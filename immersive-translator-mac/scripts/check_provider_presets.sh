#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SETTINGS_SOURCE="$ROOT_DIR/Sources/ImmersiveTranslator/Settings.swift"
CLIENT_SOURCE="$ROOT_DIR/Sources/ImmersiveTranslator/TranslationClient.swift"
PROVIDER_PROFILE_SOURCE="$ROOT_DIR/Sources/ProviderCore/ProviderProfile.swift"
PROVIDER_MIGRATION_SOURCE="$ROOT_DIR/Sources/ProviderCore/ProviderMigration.swift"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ImmersiveTranslator-provider-presets.XXXXXX")"
CHECK_PATH="$TMP_DIR/ProviderPresetsCheck.swift"
BINARY_PATH="$TMP_DIR/check_provider_presets"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

{
    printf 'import Foundation\n\n'
    # Provider presets moved out of Settings.swift into the shared ProviderCore
    # target during the multi-provider migration. Keep this check standalone by
    # compiling the small model source into its temporary harness.
    cat "$PROVIDER_PROFILE_SOURCE"
    cat "$PROVIDER_MIGRATION_SOURCE"
    printf '\n'
    awk '
        /^private enum ProviderConfigurationAdvisor[: ]/ { printing = 1 }
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
        let presets = ProviderProfile.builtinPresets

        expect(presets.count == 3, "provider presets should expose the three built-in cloud providers", failures: &failures)
        expect(Set(presets.map(\.id)).count == presets.count, "provider preset ids should be unique", failures: &failures)
        expect(Set(presets.map(\.displayName)).count == presets.count, "provider preset display names should be unique", failures: &failures)

        for preset in presets {
            validatePreset(preset, failures: &failures)
        }

        expect(
            presets.contains { $0.id == "deepseek" && $0.endpoint == "https://api.deepseek.com/chat/completions" && $0.model == "deepseek-v4-flash" },
            "DeepSeek preset should remain available",
            failures: &failures
        )
        expect(
            presets.contains { $0.id == "openai" && $0.endpoint == "https://api.openai.com/v1/chat/completions" && $0.model == "gpt-5.4-mini" },
            "OpenAI daily-use preset should remain available",
            failures: &failures
        )
        expect(
            presets.contains { $0.id == "zhipu" && $0.endpoint == "https://open.bigmodel.cn/api/paas/v4/chat/completions" && $0.model == "glm-5.2" },
            "Zhipu preset should remain available with the official Chat Completions endpoint",
            failures: &failures
        )
        expect(
            !presets.contains { isLocalEndpoint($0.endpoint) },
            "local provider endpoints should not be exposed as built-in cloud presets",
            failures: &failures
        )

        checkRequiresAPIKeyRules(failures: &failures)
        checkDiagnosticURLRedaction(failures: &failures)
        checkDiagnosticTextRedaction(failures: &failures)
        checkSensitiveQueryDetection(failures: &failures)
        checkConfigurationAdvisor(failures: &failures)
        checkLatencyAssessment(failures: &failures)
        checkProviderMigrationNormalization(failures: &failures)

        if failures.isEmpty {
            print("ok: provider preset cases passed (\(presets.count) presets)")
        } else {
            fputs("error: provider preset regression\n\n\(failures.joined(separator: "\n\n"))\n", stderr)
            exit(1)
        }
    }

    private static func validatePreset(_ preset: ProviderProfile, failures: inout [String]) {
        let label = "\(preset.id) / \(preset.displayName)"
        expect(!preset.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "\(label): id should not be empty", failures: &failures)
        expect(!preset.displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "\(label): display name should not be empty", failures: &failures)
        expect(!preset.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "\(label): model should not be empty", failures: &failures)
        expect(preset.isBuiltin, "\(label): built-in provider should be marked isBuiltin", failures: &failures)
        expect(preset.customModels.isEmpty, "\(label): built-in provider should not persist custom model history", failures: &failures)

        let candidates = preset.modelCandidates
        expect(candidates.contains(preset.model), "\(label): current model should be offered in model candidates", failures: &failures)
        expect(
            !(ProviderProfile.builtinModelCandidates[preset.id] ?? []).isEmpty,
            "\(label): built-in provider should define official model candidates",
            failures: &failures
        )

        guard let url = TranslationClient.chatCompletionsURL(from: preset.endpoint) else {
            failures.append("\(label): endpoint is not a valid Chat Completions URL: \(preset.endpoint)")
            return
        }

        expect(url.path.hasSuffix("/chat/completions"), "\(label): normalized URL should end in /chat/completions, got \(url.path)", failures: &failures)

        expect(!isLocalEndpoint(preset.endpoint), "\(label): built-in cloud preset should not use a local endpoint", failures: &failures)
        expect(url.scheme == "https", "\(label): cloud preset should use HTTPS, got \(url.absoluteString)", failures: &failures)
        expect(TranslationClient.requiresAPIKey(for: url), "\(label): cloud endpoint should require API Key", failures: &failures)
    }

    private static func isLocalEndpoint(_ endpoint: String) -> Bool {
        guard let url = TranslationClient.chatCompletionsURL(from: endpoint),
              let host = url.host?.lowercased() else {
            return false
        }
        return ["localhost", "127.0.0.1", "::1", "0.0.0.0"].contains(host)
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
            "https://visible-user:hidden-password@api.example.com/v1/chat/completions?api_key=sk-secret&model=ok&access-token=tok-secret#hidden-fragment"
        )
        expect(!redacted.contains("visible-user"), "URL userinfo should be removed: \(redacted)", failures: &failures)
        expect(!redacted.contains("hidden-password"), "URL password should be removed: \(redacted)", failures: &failures)
        expect(!redacted.contains("sk-secret"), "api_key query value should be redacted: \(redacted)", failures: &failures)
        expect(!redacted.contains("tok-secret"), "access token query value should be redacted: \(redacted)", failures: &failures)
        expect(!redacted.contains("hidden-fragment"), "URL fragment should be removed: \(redacted)", failures: &failures)
        expect(redacted.contains("api_key=REDACTED"), "redacted URL should keep api_key name for debugging: \(redacted)", failures: &failures)
        expect(redacted.contains("access-token=REDACTED"), "redacted URL should keep access-token name for debugging: \(redacted)", failures: &failures)
        expect(redacted.contains("model=ok"), "non-sensitive query value should be preserved: \(redacted)", failures: &failures)
        expect(redacted.contains("api.example.com/v1/chat/completions"), "host and path should remain useful for diagnostics: \(redacted)", failures: &failures)

        if let credentialURL = URL(string: "https://visible-user:hidden-password@api.example.com/v1/chat/completions?api_key=sk-secret&api-version=2026-01-01&model=ok#hidden-fragment"),
           let diagnosticURL = TranslationClient.unauthenticatedDiagnosticURL(from: credentialURL) {
            let diagnosticText = diagnosticURL.absoluteString
            expect(!diagnosticText.contains("visible-user"), "unauthenticated diagnostic URL should remove userinfo: \(diagnosticText)", failures: &failures)
            expect(!diagnosticText.contains("hidden-password"), "unauthenticated diagnostic URL should remove passwords: \(diagnosticText)", failures: &failures)
            expect(!diagnosticText.contains("api_key"), "unauthenticated diagnostic URL should remove credential query items: \(diagnosticText)", failures: &failures)
            expect(!diagnosticText.contains("hidden-fragment"), "unauthenticated diagnostic URL should remove fragments: \(diagnosticText)", failures: &failures)
            expect(diagnosticText.contains("api-version=2026-01-01"), "unauthenticated diagnostic URL should preserve routing query items: \(diagnosticText)", failures: &failures)
            expect(diagnosticText.contains("model=ok"), "unauthenticated diagnostic URL should preserve non-sensitive query items: \(diagnosticText)", failures: &failures)
        } else {
            failures.append("should build an unauthenticated diagnostic URL from a valid endpoint")
        }

        let googleKey = TranslationClient.redactedURLString(
            "https://example.com/openai/chat/completions?x-goog-api-key=real-key&pretty=true"
        )
        expect(!googleKey.contains("real-key"), "x-goog-api-key should be redacted: \(googleKey)", failures: &failures)
        expect(googleKey.contains("pretty=true"), "safe query items should survive redaction: \(googleKey)", failures: &failures)

        let signedURL = TranslationClient.redactedURLString(
            "https://example.com/openai/chat/completions?x-amz-signature=signed-secret&debug=true"
        )
        expect(!signedURL.contains("signed-secret"), "signature query values should be redacted: \(signedURL)", failures: &failures)
        expect(signedURL.contains("x-amz-signature=REDACTED"), "signature query name should remain visible: \(signedURL)", failures: &failures)

        let unchanged = "https://api.example.com/v1/chat/completions?model=gpt&debug=true"
        expect(
            TranslationClient.redactedURLString(unchanged) == unchanged,
            "URL without sensitive query names should stay unchanged",
            failures: &failures
        )
    }

    private static func checkDiagnosticTextRedaction(failures: inout [String]) {
        let configuredKey = ["opaque", "provider", "credential", "test", "only"].joined(separator: "-")
        let bearerToken = ["bearer", "credential", "test", "only"].joined(separator: "-")
        let assignmentToken = ["assigned", "credential", "test", "only"].joined(separator: "-")
        let opaqueKey = "sk-" + String(repeating: "x", count: 18)
        let jwt = [
            "eyJ" + String(repeating: "a", count: 12),
            String(repeating: "b", count: 16),
            String(repeating: "c", count: 16)
        ].joined(separator: ".")
        let raw = """
        configured=\(configuredKey)
        request=https://url-user:url-password@example.com/v1/chat/completions?api_key=url-secret&model=kept#url-fragment
        Authorization: Bearer \(bearerToken)
        x-api-key=\(assignmentToken)
        opaque=\(opaqueKey)
        jwt=\(jwt)
        """
        let redacted = TranslationClient.redactedDiagnosticText(raw, apiKey: configuredKey, maxLength: nil)

        for secret in [
            configuredKey,
            "url-user",
            "url-password",
            "url-secret",
            "url-fragment",
            bearerToken,
            assignmentToken,
            opaqueKey,
            jwt
        ] {
            expect(!redacted.contains(secret), "diagnostic text should redact \(secret): \(redacted)", failures: &failures)
        }
        expect(redacted.contains("example.com/v1/chat/completions"), "embedded URL host/path should remain visible: \(redacted)", failures: &failures)
        expect(redacted.contains("model=kept"), "embedded URL safe query values should remain visible: \(redacted)", failures: &failures)
        expect(redacted.contains("REDACTED"), "redacted diagnostics should use an explicit marker: \(redacted)", failures: &failures)
        expect(!redacted.contains("\n"), "single diagnostic messages should collapse line breaks", failures: &failures)

        let curlPlaceholder = TranslationClient.redactedDiagnosticText(
            "Authorization: Bearer ${API_KEY}",
            maxLength: nil
        )
        expect(
            curlPlaceholder.contains("Bearer ${API_KEY}"),
            "safe curl placeholder should survive redaction: \(curlPlaceholder)",
            failures: &failures
        )

        let formatted = TranslationClient.redactedDiagnosticText(
            "first line\nAuthorization: Bearer ${API_KEY}\nlast line",
            maxLength: nil,
            collapseWhitespace: false
        )
        expect(
            formatted == "first line\nAuthorization: Bearer ${API_KEY}\nlast line",
            "support bundle redaction should preserve safe multiline formatting: \(formatted)",
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

    private static func checkProviderMigrationNormalization(failures: inout [String]) {
        let canonical = "https://api.openai.com/v1/chat/completions"
        let variants = [
            "  HTTPS://api.openai.com/v1/chat/completions/  ",
            "https://api.openai.com/v1/chat/completions",
            "http://api.openai.com/v1/chat/completions/"
        ]

        for variant in variants {
            expect(
                ProviderMigration.matches(variant, canonical),
                "provider migration should match endpoint spelling variant: \(variant)",
                failures: &failures
            )
        }
        expect(
            ProviderMigration.normalizedHost(canonical) == "api.openai.com",
            "provider migration should strip the canonical Chat Completions path",
            failures: &failures
        )
        expect(
            ProviderMigration.normalizedHost("\(canonical)/?api_key=legacy-secret#debug") == "api.openai.com",
            "provider migration should ignore legacy query and fragment values",
            failures: &failures
        )

        let malformed = ProviderProfile(
            id: " custom-id ",
            displayName: "Custom",
            endpoint: "https://example.com/v1",
            model: "custom-model",
            isBuiltin: false,
            customModels: []
        )
        var activeID = malformed.id
        var copiedCredential = false
        let repaired = ProviderMigration.normalizeStoredProviders(
            ProviderProfile.builtinPresets + [malformed],
            activeProviderID: &activeID,
            onProviderIDChange: { oldID, newID in
                copiedCredential = oldID == malformed.id && newID == "custom-id"
                return true
            }
        )
        expect(copiedCredential, "provider ID repair should migrate the matching credential slot", failures: &failures)
        expect(repaired.last?.id == "custom-id", "unambiguous provider ID whitespace should be normalized", failures: &failures)
        expect(activeID == "custom-id", "active provider should follow a normalized provider ID", failures: &failures)

        var failedCopyActiveID = "custom-id"
        let preserved = ProviderMigration.normalizeStoredProviders(
            ProviderProfile.builtinPresets + [malformed],
            activeProviderID: &failedCopyActiveID,
            onProviderIDChange: { _, _ in false }
        )
        expect(preserved.last?.id == malformed.id, "failed credential copy should preserve the original provider ID", failures: &failures)
        expect(failedCopyActiveID == malformed.id, "active provider should use the retained credential spelling", failures: &failures)
    }

    private static func expect(_ condition: Bool, _ message: String, failures: inout [String]) {
        if !condition {
            failures.append(message)
        }
    }
}
SWIFT
} > "$CHECK_PATH"

if ! grep -q "ProviderProfile" "$CHECK_PATH"; then
    echo "error: failed to extract ProviderProfile from $PROVIDER_PROFILE_SOURCE" >&2
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
