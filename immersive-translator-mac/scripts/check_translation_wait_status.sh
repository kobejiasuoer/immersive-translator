#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_PATH="$ROOT_DIR/Sources/ImmersiveTranslator/App.swift"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ImmersiveTranslator-translation-wait-status.XXXXXX")"
CHECK_PATH="$TMP_DIR/TranslationWaitStatusCheck.swift"
BINARY_PATH="$TMP_DIR/check_translation_wait_status"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

{
    printf 'import Foundation\n\n'
    awk '
        /^struct TranslationWaitStatusText / { printing = 1 }
        /^@MainActor/ { printing = 0 }
        printing { print }
    ' "$SOURCE_PATH"
    cat <<'SWIFT'

@main
private struct TranslationWaitStatusCheck {
    static func main() {
        var failures: [String] = []

        expect(
            TranslationWaitStatusText.formatSeconds(1.234) == "1.2s",
            "formats elapsed seconds to one decimal",
            failures: &failures
        )

        assertStatus(
            name: "pre-connection streaming",
            status: TranslationWaitStatusText.preConnection(elapsed: 2.2, waitsForFirstToken: true),
            translationSnippets: ["正在连接翻译服务", "网络", "代理", "DNS"],
            messageSnippets: ["已等待 2.2s"],
            failures: &failures
        )

        assertStatus(
            name: "pre-connection non-streaming",
            status: TranslationWaitStatusText.preConnection(elapsed: 2.2, waitsForFirstToken: false),
            translationSnippets: ["非流式模式", "完整译文"],
            messageSnippets: ["正在连接翻译服务"],
            failures: &failures
        )

        assertStatus(
            name: "pre-connection long wait streaming",
            status: TranslationWaitStatusText.preConnection(elapsed: 9.5, waitsForFirstToken: true),
            translationSnippets: ["仍没有连上", "代理", "限流", "取消", "直连"],
            messageSnippets: ["连接响应很慢", "建议取消重试"],
            failures: &failures
        )

        assertStatus(
            name: "connected streaming",
            status: TranslationWaitStatusText.connected(elapsed: 0.8, waitsForFirstToken: true),
            translationSnippets: ["连接耗时 0.8s", "首个片段", "模型排队", "代理缓冲"],
            messageSnippets: ["等待首字返回", "连接 0.8s"],
            failures: &failures
        )

        assertStatus(
            name: "connected non-streaming",
            status: TranslationWaitStatusText.connected(elapsed: 0.8, waitsForFirstToken: false),
            translationSnippets: ["完整译文", "一次性显示"],
            messageSnippets: ["等待完整译文", "连接 0.8s"],
            failures: &failures
        )

        assertStatus(
            name: "active stream without visible text",
            status: TranslationWaitStatusText.streamActiveWithoutVisibleText(elapsed: 3.3),
            translationSnippets: ["流式连接保持活跃", "SSE 心跳", "角色事件", "空白片段", "当前已等待 3.3s"],
            messageSnippets: ["流式连接活跃", "等待首个可见文字"],
            failures: &failures
        )

        assertStatus(
            name: "active stream wait after connection",
            status: TranslationWaitStatusText.streamActiveWithoutVisibleText(elapsed: 4.3, connectionElapsed: 0.8),
            translationSnippets: ["连接后已等待 3.5s", "总计已等待 4.3s"],
            messageSnippets: ["连接后 3.5s", "总计 4.3s"],
            failures: &failures
        )

        assertStatus(
            name: "waiting for visible text",
            status: TranslationWaitStatusText.waitingForVisibleText(elapsed: 3.4),
            translationSnippets: ["还没有可见文字", "角色信息", "空白片段", "代理正在缓冲"],
            messageSnippets: ["等待首个可见文字", "3.4s"],
            failures: &failures
        )

        assertStatus(
            name: "post-connection first token",
            status: TranslationWaitStatusText.postConnectionWait(elapsed: 5.0, waitsForFirstToken: true),
            translationSnippets: ["首个片段还没回来", "模型排队", "服务商生成慢"],
            messageSnippets: ["仍在等待首字", "5.0s"],
            failures: &failures
        )

        assertStatus(
            name: "post-connection first token breakdown",
            status: TranslationWaitStatusText.postConnectionWait(
                elapsed: 5.0,
                waitsForFirstToken: true,
                connectionElapsed: 0.8
            ),
            translationSnippets: ["连接后已等待 4.2s", "总计已等待 5.0s", "模型排队"],
            messageSnippets: ["仍在等待首字", "连接后 4.2s", "总计 5.0s"],
            failures: &failures
        )

        assertStatus(
            name: "post-connection stream events no text",
            status: TranslationWaitStatusText.postConnectionWait(
                elapsed: 5.0,
                waitsForFirstToken: true,
                receivedStreamEventsWithoutVisibleText: true
            ),
            translationSnippets: ["持续返回流式事件", "仍没有可见文字", "角色事件", "空白片段"],
            messageSnippets: ["已收到流式事件", "等待可见文字"],
            failures: &failures
        )

        assertStatus(
            name: "post-connection non-streaming",
            status: TranslationWaitStatusText.postConnectionWait(elapsed: 5.0, waitsForFirstToken: false),
            translationSnippets: ["完整译文还没返回", "非流式模式", "长段落"],
            messageSnippets: ["仍在等待完整译文", "5.0s"],
            failures: &failures
        )

        expect(
            TranslationWaitStatusText.streamingProgressMessage(
                isFinal: false,
                firstVisibleTokenElapsed: nil
            ) == "正在流式显示译文",
            "streaming message before first visible token",
            failures: &failures
        )

        expect(
            TranslationWaitStatusText.streamingProgressMessage(
                isFinal: false,
                firstVisibleTokenElapsed: 4.5
            ).contains("偏慢"),
            "streaming message marks slow first token",
            failures: &failures
        )

        expect(
            TranslationWaitStatusText.streamingProgressMessage(
                isFinal: true,
                firstVisibleTokenElapsed: 1.2
            ) == "译文已经准备好 · 首字 1.2s",
            "final streaming message includes first-token timing",
            failures: &failures
        )

        let ocrStreamingSuccess = TranslationWaitStatusText.successMessage(
            unchanged: false,
            includesOCRPreflight: true,
            translationElapsed: 5.5,
            preflightElapsed: 0.4,
            connectionElapsed: 0.7,
            firstVisibleTokenElapsed: 4.2,
            usedStreaming: true
        )
        expect(
            ["OCR 0.4s", "连接 0.7s", "首字 4.2s", "连接后 3.5s", "翻译 5.5s", "首字等待偏长", "连接后仍等了 3.5s"].allSatisfy(ocrStreamingSuccess.contains),
            "success message includes OCR/connection/first-token/connected-wait/translation timing and slow first-token hint",
            failures: &failures
        )

        let slowConnectionSuccess = TranslationWaitStatusText.successMessage(
            unchanged: false,
            includesOCRPreflight: false,
            translationElapsed: 3.0,
            preflightElapsed: 0,
            connectionElapsed: 3.2,
            firstVisibleTokenElapsed: nil,
            usedStreaming: true
        )
        expect(
            slowConnectionSuccess.contains("连接入口偏慢"),
            "success message explains slow connection",
            failures: &failures
        )

        let slowNonStreamingSuccess = TranslationWaitStatusText.successMessage(
            unchanged: false,
            includesOCRPreflight: false,
            translationElapsed: 6.4,
            preflightElapsed: 0,
            connectionElapsed: 0.4,
            firstVisibleTokenElapsed: nil,
            usedStreaming: false
        )
        expect(
            slowNonStreamingSuccess.contains("非流式完整返回较慢"),
            "success message explains slow non-streaming response",
            failures: &failures
        )

        expect(
            TranslationWaitStatusText.successMessage(
                unchanged: true,
                includesOCRPreflight: false,
                translationElapsed: 0.2,
                preflightElapsed: 0,
                connectionElapsed: nil,
                firstVisibleTokenElapsed: nil,
                usedStreaming: true
            ).contains("译文与原文相同"),
            "unchanged success message is preserved",
            failures: &failures
        )

        if failures.isEmpty {
            print("ok: translation wait status cases passed")
        } else {
            fputs("error: translation wait status regression\n\n\(failures.joined(separator: "\n\n"))\n", stderr)
            exit(1)
        }
    }

    private static func assertStatus(
        name: String,
        status: TranslationWaitStatusText,
        translationSnippets: [String],
        messageSnippets: [String],
        failures: inout [String]
    ) {
        for snippet in translationSnippets where !status.translation.contains(snippet) {
            failures.append(
                """
                \(name)
                missing translation snippet: \(snippet)
                actual translation: \(status.translation)
                """
            )
        }
        for snippet in messageSnippets where !status.message.contains(snippet) {
            failures.append(
                """
                \(name)
                missing message snippet: \(snippet)
                actual message: \(status.message)
                """
            )
        }
        if status.translation.contains("正在处理") || status.message.contains("正在处理") {
            failures.append(
                """
                \(name)
                status regressed to generic processing text
                translation: \(status.translation)
                message: \(status.message)
                """
            )
        }
    }

    private static func expect(_ condition: Bool, _ name: String, failures: inout [String]) {
        if !condition {
            failures.append(name)
        }
    }
}
SWIFT
} > "$CHECK_PATH"

if ! grep -q "TranslationWaitStatusText" "$CHECK_PATH"; then
    echo "error: failed to extract TranslationWaitStatusText from $SOURCE_PATH" >&2
    exit 1
fi

swiftc -parse-as-library "$CHECK_PATH" -o "$BINARY_PATH"
"$BINARY_PATH"
