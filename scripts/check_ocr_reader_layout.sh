#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_PATH="$ROOT_DIR/Sources/ImmersiveTranslator/OCRReader.swift"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ImmersiveTranslator-ocr-reader-layout.XXXXXX")"
CHECK_PATH="$TMP_DIR/OCRReaderLayoutCheck.swift"
BINARY_PATH="$TMP_DIR/check_ocr_reader_layout"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

{
    printf 'import CoreGraphics\nimport Foundation\nimport Darwin\n\n'
    cat <<'SWIFT'
enum OCRRecognitionMode: String, CaseIterable, Identifiable {
    case accurate
    case fast

    var id: String { rawValue }
}

enum OCRLanguagePreset: String, CaseIterable, Identifiable {
    case autoMixed
    case chineseEnglish
    case english
    case japanese
    case korean

    var id: String { rawValue }

    var recognitionLanguages: [String] {
        switch self {
        case .autoMixed:
            return ["en-US", "zh-Hans", "zh-Hant", "ja-JP", "ko-KR"]
        case .chineseEnglish:
            return ["zh-Hans", "zh-Hant", "en-US"]
        case .english:
            return ["en-US"]
        case .japanese:
            return ["ja-JP", "en-US"]
        case .korean:
            return ["ko-KR", "en-US"]
        }
    }

    var fallbackPresets: [OCRLanguagePreset] {
        switch self {
        case .autoMixed:
            return []
        case .japanese:
            return [.autoMixed]
        default:
            return [.autoMixed, .japanese]
        }
    }
}

private let fastRecognitionLanguageFixture = Set(["de-DE", "en-US", "es-ES", "fr-FR", "it-IT", "pt-BR"])

private func supportsAllRecognitionLanguages(_ languages: [String], mode: OCRRecognitionMode) -> Bool {
    guard mode == .fast else { return true }
    return languages.allSatisfy(fastRecognitionLanguageFixture.contains)
}
SWIFT
    awk '
        /^private struct OCRRecognitionAttempt/ { printing = 1 }
        /^private func performRecognition/ { printing = 0 }
        /^private struct OCRLine / { printing = 1 }
        printing { print }
    ' "$SOURCE_PATH"
    cat <<'SWIFT'

private func line(_ text: String, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat = 0.035) -> OCRLine {
    OCRLine(rect: CGRect(x: x, y: y, width: w, height: h), text: text)
}

@main
private struct OCRReaderLayoutCheck {
    private struct Case {
        let name: String
        let lines: [OCRLine]
        let expected: String
    }

    static func main() {
        let cases: [Case] = [
            Case(
                name: "joins single-column hard wraps",
                lines: [
                    line("Immersive translation should feel", x: 0.10, y: 0.82, w: 0.66),
                    line("fast enough that readers stay", x: 0.10, y: 0.77, w: 0.60),
                    line("inside their original flow.", x: 0.10, y: 0.72, w: 0.52)
                ],
                expected: "Immersive translation should feel fast enough that readers stay inside their original flow."
            ),
            Case(
                name: "keeps near two-column text separate",
                lines: [
                    line("Left column starts here", x: 0.08, y: 0.82, w: 0.30),
                    line("and continues below.", x: 0.08, y: 0.77, w: 0.28),
                    line("Right column starts here", x: 0.42, y: 0.82, w: 0.31),
                    line("and should stay separate.", x: 0.42, y: 0.77, w: 0.34)
                ],
                expected: """
                Left column starts here and continues below.

                Right column starts here and should stay separate.
                """
            ),
            Case(
                name: "keeps side metric region separate from main paragraph",
                lines: [
                    line("This wide paragraph spans most", x: 0.08, y: 0.82, w: 0.70),
                    line("of the readable text area.", x: 0.08, y: 0.77, w: 0.52),
                    line("42 ms", x: 0.78, y: 0.72, w: 0.12),
                    line("Latency", x: 0.78, y: 0.67, w: 0.10)
                ],
                expected: """
                This wide paragraph spans most of the readable text area.

                42 ms
                Latency
                """
            ),
            Case(
                name: "still joins same-row word fragments",
                lines: [
                    line("OpenAI", x: 0.10, y: 0.82, w: 0.07),
                    line("API", x: 0.19, y: 0.82, w: 0.04),
                    line("Key", x: 0.25, y: 0.82, w: 0.04)
                ],
                expected: "OpenAI API Key"
            ),
            Case(
                name: "joins wrapped technical tokens without spaces",
                lines: [
                    line("Download from https://example.", x: 0.10, y: 0.82, w: 0.58),
                    line("com/releases/app.zip or contact support@", x: 0.10, y: 0.77, w: 0.70),
                    line("example.com.", x: 0.10, y: 0.72, w: 0.24)
                ],
                expected: "Download from https://example.com/releases/app.zip or contact support@example.com."
            ),
            Case(
                name: "dehyphenates hard-broken words",
                lines: [
                    line("Fast recogn-", x: 0.10, y: 0.82, w: 0.28),
                    line("ition keeps OCR confirmation smooth.", x: 0.10, y: 0.77, w: 0.58)
                ],
                expected: "Fast recognition keeps OCR confirmation smooth."
            ),
            Case(
                name: "preserves compound hyphen breaks",
                lines: [
                    line("The state-of-the-", x: 0.10, y: 0.82, w: 0.34),
                    line("art preview should keep its hyphen.", x: 0.10, y: 0.77, w: 0.56)
                ],
                expected: "The state-of-the-art preview should keep its hyphen."
            ),
            Case(
                name: "preserves common hyphenated prefixes",
                lines: [
                    line("Use non-", x: 0.10, y: 0.82, w: 0.18),
                    line("blocking requests while streaming.", x: 0.10, y: 0.77, w: 0.52)
                ],
                expected: "Use non-blocking requests while streaming."
            ),
            Case(
                name: "joins wrapped bullet item continuations",
                lines: [
                    line("- Capture only the text", x: 0.10, y: 0.82, w: 0.38),
                    line("region around the paragraph", x: 0.12, y: 0.77, w: 0.46),
                    line("- Press Enter to translate", x: 0.10, y: 0.72, w: 0.42)
                ],
                expected: """
                - Capture only the text region around the paragraph
                - Press Enter to translate
                """
            ),
            Case(
                name: "joins bullet continuation after semicolon",
                lines: [
                    line("- Show the first translated token earlier;", x: 0.10, y: 0.82, w: 0.66),
                    line("keep a clear status visible during slow requests", x: 0.12, y: 0.77, w: 0.70),
                    line("- Classify provider errors precisely", x: 0.10, y: 0.72, w: 0.58)
                ],
                expected: """
                - Show the first translated token earlier; keep a clear status visible during slow requests
                - Classify provider errors precisely
                """
            ),
            Case(
                name: "joins wrapped numbered cjk item continuations",
                lines: [
                    line("1. 框选包含完整段落", x: 0.10, y: 0.82, w: 0.34),
                    line("避免截到半行或邻近栏目", x: 0.12, y: 0.77, w: 0.38),
                    line("2. 确认 OCR 预览", x: 0.10, y: 0.72, w: 0.32)
                ],
                expected: """
                1. 框选包含完整段落避免截到半行或邻近栏目
                2. 确认 OCR 预览
                """
            ),
            Case(
                name: "joins cjk numbered continuation after semicolon",
                lines: [
                    line("1. 更早显示首字；", x: 0.10, y: 0.82, w: 0.28),
                    line("慢请求给出明确状态", x: 0.12, y: 0.77, w: 0.32),
                    line("2. 区分接口错误", x: 0.10, y: 0.72, w: 0.28)
                ],
                expected: """
                1. 更早显示首字；慢请求给出明确状态
                2. 区分接口错误
                """
            ),
            Case(
                name: "keeps list item field values separate",
                lines: [
                    line("- Provider:", x: 0.10, y: 0.82, w: 0.22),
                    line("openrouter/auto", x: 0.12, y: 0.77, w: 0.28),
                    line("- Model:", x: 0.10, y: 0.72, w: 0.18),
                    line("openrouter/auto", x: 0.12, y: 0.67, w: 0.28)
                ],
                expected: """
                - Provider:
                openrouter/auto
                - Model:
                openrouter/auto
                """
            ),
            Case(
                name: "preserves table of contents lines",
                lines: [
                    line("Introduction ........ 1", x: 0.10, y: 0.82, w: 0.48),
                    line("OCR workflow ........ 4", x: 0.10, y: 0.77, w: 0.50),
                    line("Release checklist ... 9", x: 0.10, y: 0.72, w: 0.52)
                ],
                expected: """
                Introduction ........ 1
                OCR workflow ........ 4
                Release checklist ... 9
                """
            ),
            Case(
                name: "preserves key value blocks",
                lines: [
                    line("Provider: OpenAI", x: 0.10, y: 0.82, w: 0.30),
                    line("Model: gpt-5-mini", x: 0.10, y: 0.77, w: 0.34),
                    line("Latency: 320 ms", x: 0.10, y: 0.72, w: 0.31)
                ],
                expected: """
                Provider: OpenAI
                Model: gpt-5-mini
                Latency: 320 ms
                """
            )
        ]

        var failures: [String] = []
        let attemptCases: [(String, OCRRecognitionMode, OCRLanguagePreset, [OCRRecognitionAttempt])] = [
            (
                "fast Japanese falls back to accurate Japanese and mixed",
                .fast,
                .japanese,
                [
                    OCRRecognitionAttempt(mode: .accurate, languagePreset: .japanese),
                    OCRRecognitionAttempt(mode: .accurate, languagePreset: .autoMixed)
                ]
            ),
            (
                "Chinese English preset can retry mixed then Japanese",
                .accurate,
                .chineseEnglish,
                [
                    OCRRecognitionAttempt(mode: .accurate, languagePreset: .chineseEnglish),
                    OCRRecognitionAttempt(mode: .accurate, languagePreset: .autoMixed),
                    OCRRecognitionAttempt(mode: .accurate, languagePreset: .japanese)
                ]
            ),
            (
                "English fast stays fast before mixed fallback",
                .fast,
                .english,
                [
                    OCRRecognitionAttempt(mode: .fast, languagePreset: .english),
                    OCRRecognitionAttempt(mode: .accurate, languagePreset: .autoMixed),
                    OCRRecognitionAttempt(mode: .accurate, languagePreset: .japanese)
                ]
            )
        ]

        for attemptCase in attemptCases {
            let actual = makeRecognitionAttempts(mode: attemptCase.1, languagePreset: attemptCase.2)
            if actual != attemptCase.3 {
                failures.append(
                    """
                    \(attemptCase.0)
                    expected attempts:
                    \(attemptCase.3)
                    actual attempts:
                    \(actual)
                    """
                )
            }
        }

        for testCase in cases {
            let actual = mergeLines(testCase.lines)
            if actual != testCase.expected {
                failures.append(
                    """
                    \(testCase.name)
                    expected:
                    \(testCase.expected)
                    actual:
                    \(actual)
                    """
                )
            }
        }

        if failures.isEmpty {
            print("ok: OCR reader layout cases passed (\(cases.count))")
        } else {
            fputs("error: OCR reader layout regression\n\n\(failures.joined(separator: "\n\n"))\n", stderr)
            exit(1)
        }
    }
}
SWIFT
} > "$CHECK_PATH"

if ! grep -q "private func mergeLines" "$CHECK_PATH"; then
    echo "error: failed to extract OCRReader layout helpers from $SOURCE_PATH" >&2
    exit 1
fi

swiftc -parse-as-library "$CHECK_PATH" -o "$BINARY_PATH"
"$BINARY_PATH"
