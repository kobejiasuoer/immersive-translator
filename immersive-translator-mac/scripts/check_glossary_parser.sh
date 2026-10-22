#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PARSER_PATH="$ROOT_DIR/Sources/ImmersiveTranslator/GlossaryParser.swift"
SETTINGS_PATH="$ROOT_DIR/Sources/ImmersiveTranslator/Settings.swift"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ImmersiveTranslator-glossary-parser.XXXXXX")"
CHECK_PATH="$TMP_DIR/GlossaryParserCheck.swift"
BINARY_PATH="$TMP_DIR/check_glossary_parser"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

{
    cat "$PARSER_PATH"
    awk '
        /^private struct GlossarySummary / { printing = 1 }
        /^struct SettingsSaveSnapshot/ { printing = 0 }
        /^final class SettingsWindowController/ { printing = 0 }
        printing { print }
    ' "$SETTINGS_PATH"
    cat <<'SWIFT'

@main
private struct GlossaryParserCheck {
    static func main() {
        checkImportReader()
        checkParsing()
        checkPromptLimitAndCleaning()
        checkSummaryCounts()
        print("ok: glossary parser cases passed")
    }

    private static func checkImportReader() {
        let utf8BOM = Data([0xEF, 0xBB, 0xBF]) + Data("BOM term = 已去除 BOM\n".utf8)
        expect(
            try! GlossaryImportReader.text(from: utf8BOM) == "BOM term = 已去除 BOM\n",
            "UTF-8 BOM should be stripped from imported glossary text"
        )

        let utf16LE = "UTF16LE term = 小端\n".data(using: .utf16LittleEndian)!
        expect(
            try! GlossaryImportReader.text(from: utf16LE) == "UTF16LE term = 小端\n",
            "UTF-16 little-endian glossary files without BOM should import"
        )

        let utf16BEWithBOM = Data([0xFE, 0xFF]) + "UTF16BE term = 大端\n".data(using: .utf16BigEndian)!
        expect(
            try! GlossaryImportReader.text(from: utf16BEWithBOM) == "UTF16BE term = 大端\n",
            "UTF-16 big-endian glossary files with BOM should import"
        )

        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("glossary-import-reader-\(UUID().uuidString).tsv")
        try! utf16LE.write(to: tempURL)
        defer { try? FileManager.default.removeItem(at: tempURL) }
        expect(
            try! GlossaryImportReader.text(from: tempURL) == "UTF16LE term = 小端\n",
            "glossary import reader should decode text from URLs"
        )

        do {
            _ = try GlossaryImportReader.text(from: Data([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]))
            expect(false, "binary-looking data should not import as glossary text")
        } catch GlossaryImportReaderError.unsupportedEncoding {
            // expected
        } catch {
            expect(false, "unexpected binary import error: \(error)")
        }
    }

    private static func checkParsing() {
        let text = """
        \u{FEFF}source,target
        ImmersiveTranslator = 沉浸式翻译器
        API Key -> API 密钥
        "rate, limit","限流，速率限制"
        "stream delta","流式片段","备注列仅本地保留"
        “model, name”，「模型名称」
        Product|产品
        Bob's term,Bob 的术语
        // comment
        bad row without delimiter
        API Key: 凭证
        """
        let result = GlossaryParser.parse(text)
        expect(result.nonEmptyLineCount == 11, "unexpected non-empty count: \(result.nonEmptyLineCount)")
        expect(result.ignoredLineCount == 3, "header, comment, and bad row should be ignored: \(result.ignoredLineCount)")
        expect(
            result.ignoredLineSamples == ["第 10 行：bad row without delimiter"],
            "ignored samples should show actionable bad rows only: \(result.ignoredLineSamples)"
        )
        expect(result.mappings.count == 8, "unexpected raw mapping count: \(result.mappings.count)")
        expect(result.duplicateSources == ["api key"], "duplicate source should be normalized case-insensitively: \(result.duplicateSources)")

        let effective = result.effectiveMappings
        expect(effective.count == 7, "duplicate effective mapping should be collapsed: \(effective.count)")
        expect(effective.contains(GlossaryMapping(id: 1, source: "ImmersiveTranslator", target: "沉浸式翻译器")), "equal sign mapping missing")
        expect(effective.contains(GlossaryMapping(id: 3, source: "rate, limit", target: "限流，速率限制")), "quoted CSV mapping with comma missing")
        expect(effective.contains(GlossaryMapping(id: 4, source: "stream delta", target: "流式片段")), "quoted CSV mapping with extra local note column missing")
        expect(effective.contains(GlossaryMapping(id: 5, source: "model, name", target: "模型名称")), "localized quote/comma mapping missing")
        expect(effective.contains(GlossaryMapping(id: 6, source: "Product", target: "产品")), "pipe mapping missing")
        expect(effective.contains(GlossaryMapping(id: 7, source: "Bob's term", target: "Bob 的术语")), "apostrophe inside an unquoted field should not start quote mode")
        expect(effective.contains(GlossaryMapping(id: 10, source: "API Key", target: "凭证")), "last duplicate should win")

        let promptText = GlossaryParser.promptText(from: text)
        expect(promptText.contains("rate, limit -> 限流，速率限制"), "prompt should keep quoted comma mapping")
        expect(promptText.contains("stream delta -> 流式片段"), "prompt should keep first two CSV columns when note columns exist")
        expect(!promptText.contains("备注列仅本地保留"), "prompt should not send extra CSV note columns")
        expect(promptText.contains("API Key -> 凭证"), "prompt should use last duplicate")
        expect(!promptText.contains("API Key -> API 密钥"), "prompt should omit overwritten duplicate")

        let tabularImport = GlossaryParser.parse("""
        TSV term\tTSV 译法\t本地备注
        CSV blank extra,CSV 空备注,
        Missing Target,,note should not become target
        """)
        expect(tabularImport.mappings.count == 2, "CSV/TSV imports should use the first two columns and ignore later note columns: \(tabularImport.mappings)")
        expect(tabularImport.ignoredLineCount == 1, "empty second column should stay invalid instead of using a note column: \(tabularImport.ignoredLineCount)")
        expect(tabularImport.effectiveMappings.contains(GlossaryMapping(id: 0, source: "TSV term", target: "TSV 译法")), "TSV row with local note column missing")
        expect(tabularImport.effectiveMappings.contains(GlossaryMapping(id: 1, source: "CSV blank extra", target: "CSV 空备注")), "CSV row with blank extra column missing")

        let semicolonWithHeader = GlossaryParser.parse("""
        source;target;note
        latency;延迟;UI terminology
        first token;首字
        """)
        expect(semicolonWithHeader.ignoredLineCount == 1, "semicolon header should be ignored: \(semicolonWithHeader.ignoredLineCount)")
        expect(semicolonWithHeader.effectiveMappings.count == 2, "semicolon CSV with header should import mappings: \(semicolonWithHeader.effectiveMappings)")
        expect(semicolonWithHeader.effectiveMappings.contains(GlossaryMapping(id: 1, source: "latency", target: "延迟")), "semicolon CSV row with note column missing")
        expect(semicolonWithHeader.effectiveMappings.contains(GlossaryMapping(id: 2, source: "first token", target: "首字")), "semicolon CSV two-column row missing")

        let semicolonWithoutHeader = GlossaryParser.parse("""
        Provider preset;服务商预设
        gateway timeout;网关超时
        This is a normal sentence; it should not become a terminology table by itself.
        """)
        expect(semicolonWithoutHeader.effectiveMappings.count == 2, "semicolon glossary without header should require repeated table-like rows: \(semicolonWithoutHeader.effectiveMappings)")
        expect(semicolonWithoutHeader.ignoredLineCount == 1, "long semicolon sentence should be ignored: \(semicolonWithoutHeader.ignoredLineCount)")
        expect(semicolonWithoutHeader.effectiveMappings.contains(GlossaryMapping(id: 0, source: "Provider preset", target: "服务商预设")), "semicolon glossary term missing")
        expect(semicolonWithoutHeader.effectiveMappings.contains(GlossaryMapping(id: 1, source: "gateway timeout", target: "网关超时")), "second semicolon glossary term missing")

        let singleSemicolonSentence = GlossaryParser.parse("Use streaming carefully; slow providers may still queue requests.")
        expect(singleSemicolonSentence.mappings.isEmpty, "single prose sentence with semicolon should not be parsed as a mapping")
        expect(singleSemicolonSentence.ignoredLineCount == 1, "single semicolon prose line should be ignored")

        let cappedSamples = GlossaryParser.parse("""
        bad one
        bad two
        bad three
        bad four
        """).ignoredLineSamples
        expect(cappedSamples.count == 3, "ignored samples should cap at 3: \(cappedSamples)")
        expect(cappedSamples.last == "第 3 行：bad three", "ignored samples should preserve source line numbers: \(cappedSamples)")
    }

    private static func checkPromptLimitAndCleaning() {
        let longText = (1...82)
            .map { "Term\($0) = 译法\($0)" }
            .joined(separator: "\n")
        let promptLines = GlossaryParser.promptText(from: longText)
            .components(separatedBy: .newlines)
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        expect(promptLines.count == GlossaryParser.promptMappingLimit, "prompt should cap request mappings at 80")
        expect(promptLines.last == "Term80 -> 译法80", "prompt should stop at Term80, got \(promptLines.last ?? "<nil>")")

        let cleaned = GlossaryParser.cleanedText(from: """
        # note
        Foo = 旧
        Foo = 新
        "Bar, Baz","巴尔，巴兹"
        "With Note","只保留译法","备注不要进入清理结果"
        invalid
        """)
        expect(
            cleaned == """
            Foo = 新
            Bar, Baz = 巴尔，巴兹
            With Note = 只保留译法
            """,
            "cleaned text should remove comments/bad rows and keep last duplicate:\n\(cleaned)"
        )
    }

    private static func checkSummaryCounts() {
        let text = (1...82)
            .map { "Term\($0) = 译法\($0)" }
            .joined(separator: "\n")
            + "\nTerm1 = 最新译法\nnot a mapping"
        let summary = GlossarySummary.make(from: text)
        expect(summary.nonEmptyLineCount == 84, "summary non-empty count mismatch: \(summary.nonEmptyLineCount)")
        expect(summary.mappingCount == 83, "summary raw mapping count mismatch: \(summary.mappingCount)")
        expect(summary.effectiveMappingCount == 82, "summary effective mapping count mismatch: \(summary.effectiveMappingCount)")
        expect(summary.requestMappingCount == 80, "summary request mapping count should be capped: \(summary.requestMappingCount)")
        expect(summary.overflowMappingCount == 2, "summary overflow count mismatch: \(summary.overflowMappingCount)")
        expect(summary.ignoredLineCount == 1, "summary ignored count mismatch: \(summary.ignoredLineCount)")
        expect(summary.ignoredLineSamples == ["第 84 行：not a mapping"], "summary ignored samples mismatch: \(summary.ignoredLineSamples)")
        expect(summary.duplicateSources == ["term1"], "summary duplicate source mismatch: \(summary.duplicateSources)")
        expect(summary.lastRequestMapping?.source == "Term80", "last request mapping should be Term80")
        expect(summary.firstOverflowMapping?.source == "Term81", "first overflow mapping should be Term81")
    }

    private static func expect(_ condition: Bool, _ message: String) {
        guard condition else {
            fputs("error: glossary parser regression\n\(message)\n", stderr)
            exit(1)
        }
    }
}
SWIFT
} > "$CHECK_PATH"

if ! grep -q "GlossaryParser" "$CHECK_PATH" || ! grep -q "GlossarySummary" "$CHECK_PATH"; then
    echo "error: failed to extract glossary helpers" >&2
    exit 1
fi

swiftc -parse-as-library "$CHECK_PATH" -o "$BINARY_PATH"
"$BINARY_PATH"
