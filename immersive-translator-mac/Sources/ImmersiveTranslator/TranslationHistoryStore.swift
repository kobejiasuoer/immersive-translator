import AppKit
import SwiftUI
import UniformTypeIdentifiers
import ReaderCore

enum TranslationSource: String, Codable {
    case selection
    case screenshotOCR
    case retry
    case panel

    var displayName: String {
        switch self {
        case .selection:
            return "选中文本"
        case .screenshotOCR:
            return "截图 OCR"
        case .retry:
            return "重新翻译"
        case .panel:
            return "浮窗"
        }
    }
}

struct TranslationRecord: Identifiable, Codable, Equatable {
    let id: UUID
    var createdAt: Date
    var original: String
    var translation: String
    var targetLanguage: String
    var source: TranslationSource
    var isFavorite: Bool
}

struct TranslationHistoryExportResult {
    let count: Int
    let url: URL

    var fileName: String {
        url.lastPathComponent
    }

    var formatName: String {
        switch url.pathExtension.lowercased() {
        case "json":
            return "JSON"
        case "md", "markdown":
            return "Markdown"
        case "txt", "text":
            return "纯文本"
        default:
            return "CSV"
        }
    }

    var path: String {
        url.path
    }
}

struct TranslationHistoryDeletedRecord {
    let record: TranslationRecord
    let index: Int
}

@MainActor
final class TranslationHistoryStore: ObservableObject {
    @Published private(set) var records: [TranslationRecord] = []

    private let fileURL: URL
    private let maxRecords = 500

    init() {
        fileURL = Self.makeHistoryURL()
        records = Self.loadRecords(from: fileURL)
    }

    @discardableResult
    func add(original: String, translation: String, targetLanguage: String, source: TranslationSource) -> TranslationRecord? {
        let cleanOriginal = original.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanTranslation = translation.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanOriginal.isEmpty, !cleanTranslation.isEmpty else {
            return nil
        }

        if let index = records.firstIndex(where: { isSameText($0.original, cleanOriginal) && isSameText($0.translation, cleanTranslation) }) {
            var record = records.remove(at: index)
            record.createdAt = Date()
            record.targetLanguage = targetLanguage
            record.source = source
            records.insert(record, at: 0)
            save()
            return record
        }

        let record = TranslationRecord(
            id: UUID(),
            createdAt: Date(),
            original: cleanOriginal,
            translation: cleanTranslation,
            targetLanguage: targetLanguage,
            source: source,
            isFavorite: false
        )
        records.insert(record, at: 0)
        if records.count > maxRecords {
            records.removeLast(records.count - maxRecords)
        }
        save()
        return record
    }

    func isFavorite(original: String, translation: String) -> Bool {
        records.first {
            isSameText($0.original, original) && isSameText($0.translation, translation)
        }?.isFavorite ?? false
    }

    @discardableResult
    func toggleFavorite(original: String, translation: String, targetLanguage: String, source: TranslationSource) -> Bool {
        let cleanOriginal = original.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanTranslation = translation.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanOriginal.isEmpty, !cleanTranslation.isEmpty else {
            return false
        }

        if let index = records.firstIndex(where: { isSameText($0.original, cleanOriginal) && isSameText($0.translation, cleanTranslation) }) {
            records[index].isFavorite.toggle()
            save()
            return records[index].isFavorite
        }

        let record = TranslationRecord(
            id: UUID(),
            createdAt: Date(),
            original: cleanOriginal,
            translation: cleanTranslation,
            targetLanguage: targetLanguage,
            source: source,
            isFavorite: true
        )
        records.insert(record, at: 0)
        if records.count > maxRecords {
            records.removeLast(records.count - maxRecords)
        }
        save()
        return record.isFavorite
    }

    func toggleFavorite(recordID: UUID) {
        guard let index = records.firstIndex(where: { $0.id == recordID }) else { return }
        records[index].isFavorite.toggle()
        save()
    }

    @discardableResult
    func delete(recordID: UUID) -> TranslationHistoryDeletedRecord? {
        guard let index = records.firstIndex(where: { $0.id == recordID }) else {
            return nil
        }
        let record = records.remove(at: index)
        save()
        return TranslationHistoryDeletedRecord(record: record, index: index)
    }

    func restoreDeletedRecord(_ deleted: TranslationHistoryDeletedRecord) {
        records.removeAll { $0.id == deleted.record.id }
        let insertionIndex = min(max(deleted.index, 0), records.count)
        records.insert(deleted.record, at: insertionIndex)
        if records.count > maxRecords {
            records.removeLast(records.count - maxRecords)
        }
        save()
    }

    func clearHistoryKeepingFavorites() {
        records.removeAll { !$0.isFavorite }
        save()
    }

    func export(records recordsToExport: [TranslationRecord], to url: URL) throws -> TranslationHistoryExportResult {
        let exportURL = url.pathExtension.isEmpty ? url.appendingPathExtension("csv") : url
        let data = try Self.exportData(for: recordsToExport, pathExtension: exportURL.pathExtension)
        try data.write(to: exportURL, options: [.atomic])

        return TranslationHistoryExportResult(count: recordsToExport.count, url: exportURL)
    }

    func exportText(records recordsToExport: [TranslationRecord], fileExtension: String) throws -> String {
        let data = try Self.exportData(
            for: recordsToExport,
            pathExtension: fileExtension,
            includeCSVByteOrderMark: false
        )
        return String(decoding: data, as: UTF8.self)
    }

    func markdownSnippet(for record: TranslationRecord) -> String {
        let formatter = ISO8601DateFormatter()
        return Self.markdownRecordLines(for: record, index: nil, formatter: formatter)
            .joined(separator: "\n") + "\n"
    }

    private func save() {
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(records)
            try data.write(to: fileURL, options: [.atomic])
        } catch {
            NSLog("Failed to save translation history: \(error.localizedDescription)")
        }
    }

    private func isSameText(_ lhs: String, _ rhs: String) -> Bool {
        lhs.trimmingCharacters(in: .whitespacesAndNewlines) == rhs.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func loadRecords(from url: URL) -> [TranslationRecord] {
        guard let data = try? Data(contentsOf: url) else {
            return []
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([TranslationRecord].self, from: data)) ?? []
    }

    private static func exportData(
        for records: [TranslationRecord],
        pathExtension: String,
        includeCSVByteOrderMark: Bool = true
    ) throws -> Data {
        switch pathExtension.lowercased() {
        case "json":
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            encoder.dateEncodingStrategy = .iso8601
            return try encoder.encode(records)
        case "md", "markdown":
            return markdownData(for: records)
        case "txt", "text":
            return plainTextData(for: records)
        default:
            return csvData(for: records, includeByteOrderMark: includeCSVByteOrderMark)
        }
    }

    private static func csvData(for records: [TranslationRecord], includeByteOrderMark: Bool = true) -> Data {
        let formatter = ISO8601DateFormatter()
        let rows = records.map { record in
            [
                record.id.uuidString,
                formatter.string(from: record.createdAt),
                record.source.displayName,
                record.targetLanguage,
                record.isFavorite ? "true" : "false",
                record.original,
                record.translation
            ].map(csvEscape).joined(separator: ",")
        }
        let text = ([
            ["id", "created_at", "source", "target_language", "favorite", "original", "translation"].joined(separator: ",")
        ] + rows).joined(separator: "\n")
        let prefix = includeByteOrderMark ? "\u{FEFF}" : ""
        return Data((prefix + text + "\n").utf8)
    }

    private static func csvEscape(_ value: String) -> String {
        let escaped = value.replacingOccurrences(of: "\"", with: "\"\"")
        if escaped.contains(",") || escaped.contains("\n") || escaped.contains("\r") || escaped.contains("\"") {
            return "\"\(escaped)\""
        }
        return escaped
    }

    private static func markdownData(for records: [TranslationRecord]) -> Data {
        let formatter = ISO8601DateFormatter()
        let sourceSummary = countSummary(records.map { $0.source.displayName })
        let targetLanguageSummary = countSummary(records.map { cleanSummaryLabel($0.targetLanguage, fallback: "未指定") })
        var lines: [String] = [
            "# Immersive Translator History",
            "",
            "- Exported at: \(formatter.string(from: Date()))",
            "- Exported records: \(records.count)",
            "- Favorites: \(records.filter(\.isFavorite).count)",
            "- Sources: \(sourceSummary)",
            "- Target languages: \(targetLanguageSummary)",
            ""
        ]

        for (index, record) in records.enumerated() {
            lines.append(contentsOf: markdownRecordLines(for: record, index: index + 1, formatter: formatter))
            lines.append("")
        }

        return Data((lines.joined(separator: "\n") + "\n").utf8)
    }

    private static func markdownRecordLines(
        for record: TranslationRecord,
        index: Int?,
        formatter: ISO8601DateFormatter
    ) -> [String] {
        let favorite = record.isFavorite ? " · favorite" : ""
        let prefix = index.map { "\($0). " } ?? ""
        return [
            "## \(prefix)\(formatter.string(from: record.createdAt)) · \(record.source.displayName) · \(record.targetLanguage)\(favorite)",
            "",
            "### Original",
            markdownCodeBlock(record.original),
            "",
            "### Translation",
            markdownCodeBlock(record.translation)
        ]
    }

    private static func plainTextData(for records: [TranslationRecord]) -> Data {
        let formatter = ISO8601DateFormatter()
        let sourceSummary = countSummary(records.map { $0.source.displayName })
        let targetLanguageSummary = countSummary(records.map { cleanSummaryLabel($0.targetLanguage, fallback: "未指定") })
        let header = """
        Immersive Translator History
        Exported at: \(formatter.string(from: Date()))
        Records: \(records.count)
        Favorites: \(records.filter(\.isFavorite).count)
        Sources: \(sourceSummary)
        Target languages: \(targetLanguageSummary)
        """
        let chunks = records.enumerated().map { index, record in
            let favorite = record.isFavorite ? " / favorite" : ""
            return """
            #\(index + 1) \(formatter.string(from: record.createdAt)) / \(record.source.displayName) / \(record.targetLanguage)\(favorite)

            Original:
            \(record.original)

            Translation:
            \(record.translation)
            """
        }
        return Data((header + "\n\n---\n\n" + chunks.joined(separator: "\n\n---\n\n") + "\n").utf8)
    }

    private static func countSummary(_ labels: [String], limit: Int = 6) -> String {
        let counts = labels.reduce(into: [String: Int]()) { partialResult, label in
            let cleanLabel = cleanSummaryLabel(label, fallback: "未指定")
            partialResult[cleanLabel, default: 0] += 1
        }
        let sortedCounts = counts.sorted { left, right in
            if left.value != right.value {
                return left.value > right.value
            }
            return left.key.localizedStandardCompare(right.key) == .orderedAscending
        }
        guard !sortedCounts.isEmpty else { return "无" }

        var parts = sortedCounts.prefix(limit).map { "\($0.key) \($0.value)" }
        let hiddenCount = sortedCounts.dropFirst(limit).map(\.value).reduce(0, +)
        if hiddenCount > 0 {
            parts.append("其他 \(hiddenCount)")
        }
        return parts.joined(separator: ", ")
    }

    private static func cleanSummaryLabel(_ label: String, fallback: String) -> String {
        let clean = label.trimmingCharacters(in: .whitespacesAndNewlines)
        return clean.isEmpty ? fallback : clean
    }

    private static func markdownCodeBlock(_ text: String) -> String {
        let fence = markdownFence(for: text)
        return "\(fence)\n\(text)\n\(fence)"
    }

    private static func markdownFence(for text: String) -> String {
        var longestRun = 0
        var currentRun = 0

        for character in text {
            if character == "`" {
                currentRun += 1
                longestRun = max(longestRun, currentRun)
            } else {
                currentRun = 0
            }
        }

        return String(repeating: "`", count: max(3, longestRun + 1))
    }

    private static func makeHistoryURL() -> URL {
        let baseURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
        return baseURL
            .appendingPathComponent("ImmersiveTranslator", isDirectory: true)
            .appendingPathComponent("translation-history.json")
    }
}

final class TranslationHistoryWindowController: NSWindowController {
    private let historyStore: TranslationHistoryStore
    private let onRetranslate: (TranslationRecord) -> Void
    private let onAddVocab: (TranslationRecord) async throws -> CollectVocabOutcome
    private let onSendToReader: (TranslationRecord) async throws -> Void

    init(
        historyStore: TranslationHistoryStore,
        onRetranslate: @escaping (TranslationRecord) -> Void,
        onAddVocab: @escaping (TranslationRecord) async throws -> CollectVocabOutcome,
        onSendToReader: @escaping (TranslationRecord) async throws -> Void
    ) {
        self.historyStore = historyStore
        self.onRetranslate = onRetranslate
        self.onAddVocab = onAddVocab
        self.onSendToReader = onSendToReader
        let view = TranslationHistoryView(
            historyStore: historyStore,
            onRetranslate: onRetranslate,
            onAddVocab: onAddVocab,
            onSendToReader: onSendToReader
        )
        let hosting = NSHostingController(rootView: view)
        let window = NSWindow(contentViewController: hosting)
        window.title = "翻译历史"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.setContentSize(NSSize(width: 760, height: 560))
        window.minSize = NSSize(width: 520, height: 380)
        window.isReleasedWhenClosed = false
        super.init(window: window)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show() {
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}

private enum HistoryFilter: String, CaseIterable, Identifiable {
    case all
    case favorites

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all:
            return "全部"
        case .favorites:
            return "收藏"
        }
    }
}

private enum HistoryExportScope: String, CaseIterable, Identifiable {
    case selected
    case visible
    case all
    case favorites

    var id: String { rawValue }

    var title: String {
        switch self {
        case .selected:
            return "选中记录"
        case .visible:
            return "当前列表"
        case .all:
            return "全部历史"
        case .favorites:
            return "收藏"
        }
    }

    var fileSuffix: String {
        switch self {
        case .selected:
            return "selected"
        case .visible:
            return "visible"
        case .all:
            return "history"
        case .favorites:
            return "favorites"
        }
    }
}

private enum HistoryExportFormat: String, CaseIterable, Identifiable {
    case csv
    case json
    case markdown
    case plainText

    var id: String { rawValue }

    var title: String {
        switch self {
        case .csv:
            return "CSV"
        case .json:
            return "JSON"
        case .markdown:
            return "Markdown"
        case .plainText:
            return "纯文本"
        }
    }

    var fileExtension: String {
        switch self {
        case .csv:
            return "csv"
        case .json:
            return "json"
        case .markdown:
            return "md"
        case .plainText:
            return "txt"
        }
    }

    var contentType: UTType {
        switch self {
        case .csv:
            return .commaSeparatedText
        case .json:
            return .json
        case .markdown:
            return UTType(filenameExtension: "md") ?? .plainText
        case .plainText:
            return .plainText
        }
    }

    var acceptedFileExtensions: Set<String> {
        switch self {
        case .csv:
            return ["csv"]
        case .json:
            return ["json"]
        case .markdown:
            return ["md", "markdown"]
        case .plainText:
            return ["txt", "text"]
        }
    }

    func normalizedURL(for url: URL) -> URL {
        let extensionName = url.pathExtension.lowercased()
        if acceptedFileExtensions.contains(extensionName) {
            return url
        }
        let baseURL = extensionName.isEmpty ? url : url.deletingPathExtension()
        return baseURL.appendingPathExtension(fileExtension)
    }
}

private enum HistoryExportFileName {
    static func make(
        fileSuffix: String,
        records: [TranslationRecord],
        format: HistoryExportFormat,
        date: Date = Date()
    ) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmm"

        let safeSuffix = safeFileNameComponent(fileSuffix, fallback: "history", maxLength: 24)
        let descriptor = descriptor(for: records)
        let dateText = formatter.string(from: date)
        return "immersive-translator-\(safeSuffix)-\(descriptor)-\(dateText).\(format.fileExtension)"
    }

    private static func descriptor(for records: [TranslationRecord]) -> String {
        guard let firstRecord = records.first else { return "empty" }
        guard records.count == 1 else { return "\(records.count)-items" }

        let translation = firstRecord.translation.trimmingCharacters(in: .whitespacesAndNewlines)
        let original = firstRecord.original.trimmingCharacters(in: .whitespacesAndNewlines)
        let rawDescriptor = translation.isEmpty ? original : translation
        return safeFileNameComponent(
            rawDescriptor,
            fallback: firstRecord.source.displayName,
            maxLength: 42
        )
    }

    private static func safeFileNameComponent(
        _ value: String,
        fallback: String,
        maxLength: Int
    ) -> String {
        let compact = value
            .replacingOccurrences(of: #"[\p{C}/\\:*?"<>|：｜]+"#, with: "-", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: "-", options: .regularExpression)
            .replacingOccurrences(of: #"-{2,}"#, with: "-", options: .regularExpression)
            .trimmingCharacters(in: fileNameTrimCharacters)

        let limited = String(compact.prefix(maxLength))
            .replacingOccurrences(of: #"-{2,}$"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: fileNameTrimCharacters)
        guard !limited.isEmpty else {
            return fallback
        }
        return limited
    }

    private static let fileNameTrimCharacters = CharacterSet(charactersIn: ".-_ ")
}

struct TranslationHistoryView: View {
    @ObservedObject var historyStore: TranslationHistoryStore
    let onRetranslate: (TranslationRecord) -> Void
    /// 「加入生词本」公共实现（CollectActions）。结果由调用方写入 exportMessage。
    let onAddVocab: (TranslationRecord) async throws -> CollectVocabOutcome
    /// 「送到阅读室」公共实现。结果由调用方写入 exportMessage。
    let onSendToReader: (TranslationRecord) async throws -> Void
    @State private var filter: HistoryFilter = .all
    @State private var searchText = ""
    @State private var selectedRecordID: UUID?
    @State private var exportMessage = ""
    @State private var lastExportResult: TranslationHistoryExportResult?
    @State private var recentlyDeletedRecord: TranslationHistoryDeletedRecord?
    /// 「加入生词本」进行中的记录（行按钮转 spinner 并 disabled；状态不随 hover 消失）。
    @State private var vocabBusyRecordIDs: Set<UUID> = []
    /// 「送到阅读室」进行中的记录。
    @State private var sendBusyRecordIDs: Set<UUID> = []
    /// 本次窗口会话里已成功加入生词本的记录（按钮置为已入册态）。
    @State private var vocabSavedRecordIDs: Set<UUID> = []
    @FocusState private var isSearchFocused: Bool
    private let historySearchDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()
    private let historySearchDayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
    private let historySearchTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.dateFormat = "HH:mm"
        return formatter
    }()
    private let historySearchISOFormatter = ISO8601DateFormatter()

    private var visibleRecords: [TranslationRecord] {
        let filtered: [TranslationRecord]
        switch filter {
        case .all:
            filtered = historyStore.records
        case .favorites:
            filtered = historyStore.records.filter(\.isFavorite)
        }

        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return filtered }
        return filtered.filter { recordMatchesSearch($0, query: query) }
    }

    private var favoriteRecords: [TranslationRecord] {
        historyStore.records.filter(\.isFavorite)
    }

    private var selectedRecord: TranslationRecord? {
        guard let selectedRecordID else { return nil }
        return visibleRecords.first { $0.id == selectedRecordID }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            headerBar
            searchBar
            recordList
            footerBar
            shortcutHint
        }
        .padding(20)
        .onAppear {
            isSearchFocused = true
            selectFirstVisibleRecordIfNeeded()
        }
        .onDeleteCommand(perform: deleteSelectedRecord)
        .onChange(of: visibleRecords.map(\.id)) { _ in
            ensureValidSelection()
        }
    }

    private var headerBar: some View {
        HStack {
            Text("翻译历史")
                .font(.title2.weight(.semibold))
            Spacer()
            Picker("", selection: $filter) {
                ForEach(HistoryFilter.allCases) { item in
                    Text(item.title).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 160)
        }
    }

    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("搜索原文、译文、来源、日期、OCR、收藏/未收藏", text: $searchText)
                .textFieldStyle(.plain)
                .focused($isSearchFocused)
            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .help("清空搜索")
            }
            Button {
                isSearchFocused = true
            } label: {
                Text("⌘F")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .keyboardShortcut("f", modifiers: .command)
            .help("聚焦搜索")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    @ViewBuilder
    private var recordList: some View {
        if visibleRecords.isEmpty {
            Spacer()
            Text(emptyStateText)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
            Spacer()
        } else {
            List(selection: $selectedRecordID) {
                ForEach(visibleRecords) { record in
                    recordRow(record)
                        .tag(record.id)
                }
            }
            .listStyle(.inset)
        }
    }

    private var footerBar: some View {
        HStack {
            historyCountText
            exportStatusView
            Spacer()
            historyNavigationActions
            selectedRecordActions
            exportMenu
            Button("清空非收藏历史") {
                confirmClearHistoryKeepingFavorites()
            }
            .disabled(historyStore.records.allSatisfy(\.isFavorite))
        }
    }

    private var historyCountText: some View {
        HStack(spacing: 8) {
            Text("\(historyStore.records.count) 条记录")
            if !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("当前显示 \(visibleRecords.count) 条")
            }
            if selectedRecord != nil {
                Text("已选中 1 条")
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private var exportStatusView: some View {
        if !exportMessage.isEmpty {
            HStack(spacing: 5) {
                Text(exportMessage)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(lastExportResult?.path ?? exportMessage)

                if let lastExportResult {
                    Button {
                        NSWorkspace.shared.activateFileViewerSelecting([lastExportResult.url])
                        recentlyDeletedRecord = nil
                    } label: {
                        Image(systemName: "folder")
                    }
                    .buttonStyle(.borderless)
                    .help("在 Finder 中显示 \(lastExportResult.fileName)")

                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(lastExportResult.path, forType: .string)
                        recentlyDeletedRecord = nil
                        exportMessage = "已复制导出路径：\(lastExportResult.fileName)"
                    } label: {
                        Image(systemName: "doc.on.clipboard")
                    }
                    .buttonStyle(.borderless)
                    .help("复制导出路径")
                }

                if recentlyDeletedRecord != nil {
                    Button("撤销") {
                        restoreRecentlyDeletedRecord()
                    }
                    .buttonStyle(.borderless)
                    .keyboardShortcut("z", modifiers: .command)
                    .help("⌘Z 恢复刚删除的历史记录")
                }
            }
        }
    }

    private var historyNavigationActions: some View {
        HStack(spacing: 6) {
            Button {
                selectAdjacentRecord(offset: -1)
            } label: {
                Label("上一条", systemImage: "chevron.up")
            }
            .controlSize(.small)
            .keyboardShortcut(.upArrow, modifiers: .command)
            .help("⌘↑ 选择上一条可见历史")
            .disabled(visibleRecords.isEmpty)

            Button {
                selectAdjacentRecord(offset: 1)
            } label: {
                Label("下一条", systemImage: "chevron.down")
            }
            .controlSize(.small)
            .keyboardShortcut(.downArrow, modifiers: .command)
            .help("⌘↓ 选择下一条可见历史")
            .disabled(visibleRecords.isEmpty)
        }
    }

    @ViewBuilder
    private var selectedRecordActions: some View {
        if let selectedRecord {
            Button("重新翻译") {
                retranslateHistoryRecord(selectedRecord)
            }
            .keyboardShortcut("r", modifiers: .command)

            Button("复制选中译文") {
                copyHistoryText(selectedRecord.translation, label: "选中译文")
            }
            .keyboardShortcut("c", modifiers: [.command, .shift])

            Button("复制选中原文") {
                copyHistoryText(selectedRecord.original, label: "选中原文")
            }
            .keyboardShortcut("c", modifiers: [.command, .option])

            Button("复制原文和译文") {
                copyHistoryText(combinedHistoryText(for: selectedRecord), label: "选中原文和译文")
            }
            .keyboardShortcut("c", modifiers: [.command, .option, .shift])

            Button("复制 Markdown") {
                copyHistoryText(historyStore.markdownSnippet(for: selectedRecord), label: "选中 Markdown")
            }
            .keyboardShortcut("m", modifiers: [.command, .option])

            Button(selectedRecord.isFavorite ? "取消收藏" : "收藏") {
                toggleSelectedFavorite()
            }
            .keyboardShortcut("s", modifiers: [.command, .option])

            Button("导出选中 CSV") {
                exportRecords(.selected, format: .csv)
            }
            .keyboardShortcut("e", modifiers: [.command, .option])
        }
    }

    private var exportMenu: some View {
        Menu {
            ForEach(HistoryExportScope.allCases) { scope in
                exportMenuItem(scope)
            }
        } label: {
            Label("导出", systemImage: "square.and.arrow.up")
        }
        .disabled(historyStore.records.isEmpty)
    }

    @ViewBuilder
    private func exportMenuItem(_ scope: HistoryExportScope) -> some View {
        let count = recordsForExport(scope).count
        let title = "\(scope.title)（\(count) 条）"
        Menu(title) {
            ForEach(HistoryExportFormat.allCases) { format in
                Button(format.title) {
                    exportRecords(scope, format: format)
                }
                .disabled(count == 0)
            }

            Divider()

            Menu("复制为") {
                ForEach(HistoryExportFormat.allCases) { format in
                    Button(format.title) {
                        copyExportRecords(scope, format: format)
                    }
                    .disabled(count == 0)
                }
            }

            if scope == .selected {
                Divider()
                Button("快速导出 CSV") {
                    exportRecords(scope, format: .csv)
                }
                .disabled(count == 0)
            }
        }
        .disabled(count == 0)
    }

    private var shortcutHint: some View {
        Text("快捷键：⌘F 搜索 · ⌘↑/⌘↓ 切换记录 · ⌘R 重新翻译 · ⌘⇧C 复制译文 · ⌘⌥C 复制原文 · ⌘⌥⇧C 复制组合 · ⌘⌥M 复制 Markdown · ⌘⌥S 收藏 · ⌘⌥E 导出选中 · Delete 删除 · ⌘Z 撤销删除")
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .lineLimit(1)
            .truncationMode(.tail)
    }

    private var emptyStateText: String {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !query.isEmpty {
            return "没有匹配“\(query)”的历史。可以搜索原文、译文、来源、目标语言、日期、时间、OCR、收藏或未收藏。"
        }
        return filter == .favorites ? "还没有收藏。" : "还没有翻译历史。"
    }

    private func recordRow(_ record: TranslationRecord) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(record.source.displayName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(record.createdAt.formatted(date: .numeric, time: .shortened))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !record.targetLanguage.isEmpty {
                    Text(record.targetLanguage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    toggleFavorite(record)
                } label: {
                    Image(systemName: record.isFavorite ? "star.fill" : "star")
                }
                .buttonStyle(.borderless)
                .help(record.isFavorite ? "取消收藏" : "收藏")

                Button {
                    copyHistoryText(record.translation, label: "译文")
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .help("复制译文")

                Button {
                    copyHistoryText(record.original, label: "原文")
                } label: {
                    Image(systemName: "doc.text")
                }
                .buttonStyle(.borderless)
                .help("复制原文")

                if isVocabCandidate(record) {
                    Button {
                        addRecordToVocab(record)
                    } label: {
                        if vocabBusyRecordIDs.contains(record.id) {
                            ProgressView()
                                .controlSize(.mini)
                                .frame(width: 14, height: 14)
                        } else {
                            Image(systemName: vocabSavedRecordIDs.contains(record.id) ? "text.book.closed.fill" : "text.book.closed")
                        }
                    }
                    .buttonStyle(.borderless)
                    .disabled(vocabBusyRecordIDs.contains(record.id) || vocabSavedRecordIDs.contains(record.id))
                    .help(
                        vocabSavedRecordIDs.contains(record.id)
                            ? "已在生词本"
                            : (vocabBusyRecordIDs.contains(record.id) ? "正在查询词条并生成例句…" : "加入生词本")
                    )
                }

                if canSendToReader(record) {
                    Button {
                        sendRecordToReader(record)
                    } label: {
                        if sendBusyRecordIDs.contains(record.id) {
                            ProgressView()
                                .controlSize(.mini)
                                .frame(width: 14, height: 14)
                        } else {
                            Image(systemName: "book")
                        }
                    }
                    .buttonStyle(.borderless)
                    .disabled(sendBusyRecordIDs.contains(record.id))
                    .help(sendBusyRecordIDs.contains(record.id) ? "正在送到阅读室…" : "送到阅读室")
                }

                Button {
                    deleteHistoryRecord(record)
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
                .help("删除")
            }

            Text(record.translation)
                .font(.system(size: 15))
                .lineSpacing(4)
                .lineLimit(5)
                .textSelection(.enabled)

            Text(record.original)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .lineSpacing(3)
                .lineLimit(4)
                .textSelection(.enabled)
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .onTapGesture {
            selectedRecordID = record.id
        }
        .contextMenu {
            recordContextMenu(record)
        }
    }

    @ViewBuilder
    private func recordContextMenu(_ record: TranslationRecord) -> some View {
        Button {
            retranslateHistoryRecord(record)
        } label: {
            Label("重新翻译原文", systemImage: "arrow.clockwise")
        }

        if isVocabCandidate(record) {
            Button {
                addRecordToVocab(record)
            } label: {
                Label("加入生词本", systemImage: "text.book.closed")
            }
            .disabled(vocabBusyRecordIDs.contains(record.id) || vocabSavedRecordIDs.contains(record.id))
        }

        if canSendToReader(record) {
            Button {
                sendRecordToReader(record)
            } label: {
                Label("送到阅读室", systemImage: "book")
            }
            .disabled(sendBusyRecordIDs.contains(record.id))
        }

        Divider()

        Button {
            selectedRecordID = record.id
            copyHistoryText(record.translation, label: "译文")
        } label: {
            Label("复制译文", systemImage: "doc.on.doc")
        }

        Button {
            selectedRecordID = record.id
            copyHistoryText(record.original, label: "原文")
        } label: {
            Label("复制原文", systemImage: "doc.text")
        }

        Button {
            selectedRecordID = record.id
            copyHistoryText(combinedHistoryText(for: record), label: "原文和译文")
        } label: {
            Label("复制原文和译文", systemImage: "doc.text.below.ecg")
        }

        Button {
            selectedRecordID = record.id
            copyHistoryText(historyStore.markdownSnippet(for: record), label: "Markdown 片段")
        } label: {
            Label("复制 Markdown 片段", systemImage: "doc.richtext")
        }

        Divider()

        Button {
            toggleFavorite(record, selecting: true)
        } label: {
            Label(record.isFavorite ? "取消收藏" : "收藏", systemImage: record.isFavorite ? "star.slash" : "star")
        }

        Menu("导出此条") {
            ForEach(HistoryExportFormat.allCases) { format in
                Button(format.title) {
                    selectedRecordID = record.id
                    exportSingleRecord(record, format: format)
                }
            }

            Divider()

            Menu("复制为") {
                ForEach(HistoryExportFormat.allCases) { format in
                    Button(format.title) {
                        selectedRecordID = record.id
                        copyExportHistoryRecords(
                            [record],
                            scopeTitle: "当前记录",
                            format: format
                        )
                    }
                }
            }
        }

        Divider()

        Button {
            deleteHistoryRecord(record)
        } label: {
            Label("删除", systemImage: "trash")
        }
    }

    private func copyHistoryText(_ text: String, label: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        lastExportResult = nil
        recentlyDeletedRecord = nil
        exportMessage = "已复制\(label)"
    }

    private func retranslateHistoryRecord(_ record: TranslationRecord) {
        let original = record.original.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !original.isEmpty else {
            lastExportResult = nil
            recentlyDeletedRecord = nil
            exportMessage = "这条历史没有可重新翻译的原文"
            return
        }

        selectedRecordID = record.id
        lastExportResult = nil
        recentlyDeletedRecord = nil
        exportMessage = "正在用当前设置重新翻译这条原文"
        onRetranslate(record)
    }

    // MARK: - 串联入口：加入生词本 / 送到阅读室

    /// 阅读室面向英文精读：中文原文一律不显示串联入口（looksMostlyChinese）。
    private func canSendToReader(_ record: TranslationRecord) -> Bool {
        !looksMostlyChinese(record.original)
    }

    /// 生词入口再叠加 isLookupText：整句/段落不像词条，不误收为一个生词。
    /// 双条件对齐 Windows History.tsx 的 isVocabCandidate。
    private func isVocabCandidate(_ record: TranslationRecord) -> Bool {
        canSendToReader(record) && isLookupText(record.original)
    }

    /// 加入生词本：公共 CollectActions（词典查词条 + 例句生成并行、合并落库保留
    /// SRS 进度）。进行中转 spinner 并 disabled，结果写入底部状态条。
    private func addRecordToVocab(_ record: TranslationRecord) {
        guard !vocabBusyRecordIDs.contains(record.id),
              !vocabSavedRecordIDs.contains(record.id) else { return }
        vocabBusyRecordIDs.insert(record.id)
        lastExportResult = nil
        recentlyDeletedRecord = nil
        exportMessage = "正在查询词条并生成例句…"
        Task { @MainActor in
            defer { vocabBusyRecordIDs.remove(record.id) }
            do {
                let outcome = try await onAddVocab(record)
                vocabSavedRecordIDs.insert(record.id)
                exportMessage = CollectActions.vocabResultMessage(outcome)
            } catch {
                let message = (error as? LocalizedError)?.errorDescription ?? "\(error)"
                exportMessage = "加入生词本失败：\(message)"
            }
        }
    }

    /// 送到阅读室：公共入口（可导入性校验 + 打开阅读室，建文交给阅读室导入管线）。
    private func sendRecordToReader(_ record: TranslationRecord) {
        guard !sendBusyRecordIDs.contains(record.id) else { return }
        sendBusyRecordIDs.insert(record.id)
        lastExportResult = nil
        recentlyDeletedRecord = nil
        exportMessage = "正在送到阅读室…"
        Task { @MainActor in
            defer { sendBusyRecordIDs.remove(record.id) }
            do {
                try await onSendToReader(record)
                exportMessage = "已送到阅读室"
            } catch {
                let message = (error as? LocalizedError)?.errorDescription ?? "\(error)"
                exportMessage = "送到阅读室失败：\(message)"
            }
        }
    }

    private func combinedHistoryText(for record: TranslationRecord) -> String {
        """
        原文：
        \(record.original)

        译文：
        \(record.translation)
        """
    }

    private func toggleSelectedFavorite() {
        guard let selectedRecord else { return }
        toggleFavorite(selectedRecord)
    }

    private func toggleFavorite(_ record: TranslationRecord, selecting: Bool = false) {
        if selecting {
            selectedRecordID = record.id
        }
        historyStore.toggleFavorite(recordID: record.id)
        lastExportResult = nil
        recentlyDeletedRecord = nil
        exportMessage = record.isFavorite ? "已取消收藏" : "已收藏"
    }

    private func deleteSelectedRecord() {
        guard let selectedRecord else { return }
        let deleted = historyStore.delete(recordID: selectedRecord.id)
        recentlyDeletedRecord = deleted
        selectedRecordID = nil
        lastExportResult = nil
        exportMessage = deletedMessage(for: selectedRecord, fallback: "已删除选中记录")
    }

    private func deleteHistoryRecord(_ record: TranslationRecord) {
        let deleted = historyStore.delete(recordID: record.id)
        recentlyDeletedRecord = deleted
        if selectedRecordID == record.id {
            selectedRecordID = nil
        }
        lastExportResult = nil
        exportMessage = deletedMessage(for: record, fallback: "已删除记录")
    }

    private func restoreRecentlyDeletedRecord() {
        guard let deleted = recentlyDeletedRecord else { return }
        historyStore.restoreDeletedRecord(deleted)
        selectedRecordID = deleted.record.id
        lastExportResult = nil
        recentlyDeletedRecord = nil
        exportMessage = "已恢复：\(recordSummary(deleted.record))"
    }

    private func validateSelectedRecord() {
        guard let selectedRecordID else { return }
        if !visibleRecords.contains(where: { $0.id == selectedRecordID }) {
            self.selectedRecordID = nil
        }
    }

    private func ensureValidSelection() {
        guard !visibleRecords.isEmpty else {
            selectedRecordID = nil
            return
        }

        if let selectedRecordID,
           visibleRecords.contains(where: { $0.id == selectedRecordID }) {
            return
        }

        selectedRecordID = visibleRecords.first?.id
    }

    private func selectFirstVisibleRecordIfNeeded() {
        guard selectedRecordID == nil else {
            ensureValidSelection()
            return
        }
        selectedRecordID = visibleRecords.first?.id
    }

    private func selectAdjacentRecord(offset: Int) {
        guard !visibleRecords.isEmpty else {
            selectedRecordID = nil
            lastExportResult = nil
            exportMessage = "当前没有可选择的历史"
            return
        }

        let currentIndex = selectedRecordID
            .flatMap { id in visibleRecords.firstIndex { $0.id == id } }
        let startIndex = offset < 0 ? visibleRecords.count : -1
        let rawIndex = (currentIndex ?? startIndex) + offset
        let clampedIndex = min(max(rawIndex, 0), visibleRecords.count - 1)

        if currentIndex == clampedIndex {
            lastExportResult = nil
            exportMessage = offset < 0 ? "已经是第一条可见历史" : "已经是最后一条可见历史"
            return
        }

        selectedRecordID = visibleRecords[clampedIndex].id
        lastExportResult = nil
        let direction = offset < 0 ? "上一条" : "下一条"
        exportMessage = "已选中\(direction)：\(recordSummary(visibleRecords[clampedIndex]))"
    }

    private func recordsForExport(_ scope: HistoryExportScope) -> [TranslationRecord] {
        switch scope {
        case .selected:
            return selectedRecord.map { [$0] } ?? []
        case .visible:
            return visibleRecords
        case .all:
            return historyStore.records
        case .favorites:
            return favoriteRecords
        }
    }

    private func recordMatchesSearch(_ record: TranslationRecord, query: String) -> Bool {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedQuery.isEmpty else { return true }

        if let favoriteMatch = favoriteSearchMatch(for: normalizedQuery) {
            return record.isFavorite == favoriteMatch
        }

        return searchableTokens(for: record).contains { token in
            token.localizedCaseInsensitiveContains(normalizedQuery)
        }
    }

    private func favoriteSearchMatch(for query: String) -> Bool? {
        let lowercased = query.lowercased()
        if ["未收藏", "未加星", "unstarred", "not favorite", "not starred"].contains(lowercased) {
            return false
        }
        if ["收藏", "已收藏", "加星", "favorite", "favorites", "star", "starred"].contains(lowercased) {
            return true
        }
        return nil
    }

    private func searchableTokens(for record: TranslationRecord) -> [String] {
        var tokens = [
            record.original,
            record.translation,
            record.targetLanguage,
            record.source.displayName,
            record.isFavorite ? "收藏 已收藏 favorite starred star" : "未加星 unstarred",
            historySearchDateFormatter.string(from: record.createdAt),
            historySearchDayFormatter.string(from: record.createdAt),
            historySearchTimeFormatter.string(from: record.createdAt),
            historySearchISOFormatter.string(from: record.createdAt)
        ]

        if record.source == .screenshotOCR {
            tokens.append("OCR 截图")
        }
        return tokens
    }

    private func exportRecords(_ scope: HistoryExportScope, format: HistoryExportFormat) {
        let records = recordsForExport(scope)
        guard !records.isEmpty else {
            lastExportResult = nil
            recentlyDeletedRecord = nil
            exportMessage = emptyExportMessage(for: scope)
            return
        }

        exportHistoryRecords(
            records,
            scopeTitle: scope.title,
            fileSuffix: scope.fileSuffix,
            format: format
        )
    }

    private func exportSingleRecord(_ record: TranslationRecord, format: HistoryExportFormat) {
        exportHistoryRecords(
            [record],
            scopeTitle: "当前记录",
            fileSuffix: "record",
            format: format
        )
    }

    private func copyExportRecords(_ scope: HistoryExportScope, format: HistoryExportFormat) {
        let records = recordsForExport(scope)
        guard !records.isEmpty else {
            lastExportResult = nil
            recentlyDeletedRecord = nil
            exportMessage = emptyExportMessage(for: scope)
            return
        }

        copyExportHistoryRecords(
            records,
            scopeTitle: scope.title,
            format: format
        )
    }

    private func copyExportHistoryRecords(
        _ records: [TranslationRecord],
        scopeTitle: String,
        format: HistoryExportFormat
    ) {
        do {
            let text = try historyStore.exportText(records: records, fileExtension: format.fileExtension)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            lastExportResult = nil
            recentlyDeletedRecord = nil
            exportMessage = "已复制 \(scopeTitle)：\(records.count) 条 \(format.title)"
        } catch {
            lastExportResult = nil
            recentlyDeletedRecord = nil
            exportMessage = "复制失败：\(error.localizedDescription)"
        }
    }

    private func exportHistoryRecords(
        _ records: [TranslationRecord],
        scopeTitle: String,
        fileSuffix: String,
        format: HistoryExportFormat
    ) {
        guard !records.isEmpty else {
            exportMessage = "\(scopeTitle)为空"
            lastExportResult = nil
            recentlyDeletedRecord = nil
            return
        }

        let panel = NSSavePanel()
        panel.title = "导出翻译历史 - \(scopeTitle) - \(format.title)"
        panel.nameFieldStringValue = HistoryExportFileName.make(
            fileSuffix: fileSuffix,
            records: records,
            format: format
        )
        panel.allowedContentTypes = [format.contentType]
        panel.canCreateDirectories = true

        panel.begin { response in
            guard response == .OK, let url = panel.url else {
                exportMessage = "已取消导出 \(scopeTitle)"
                lastExportResult = nil
                recentlyDeletedRecord = nil
                return
            }
            Task { @MainActor in
                exportMessage = "正在导出 \(scopeTitle) \(format.title)..."
                lastExportResult = nil
                recentlyDeletedRecord = nil
                do {
                    let exportURL = format.normalizedURL(for: url)
                    let result = try historyStore.export(records: records, to: exportURL)
                    lastExportResult = result
                    exportMessage = "已导出 \(scopeTitle)：\(result.fileName) · \(result.count) 条 \(result.formatName)"
                    NSWorkspace.shared.activateFileViewerSelecting([result.url])
                } catch {
                    exportMessage = "导出失败：\(error.localizedDescription)"
                    lastExportResult = nil
                }
            }
        }
    }

    private func emptyExportMessage(for scope: HistoryExportScope) -> String {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        switch scope {
        case .selected:
            if visibleRecords.isEmpty {
                return query.isEmpty
                    ? "当前没有可选择的历史，先完成一次翻译后再导出。"
                    : "当前搜索没有结果，清空搜索或换个关键词后再导出。"
            }
            return "请先选中一条历史，再导出选中记录。"
        case .visible:
            if !query.isEmpty {
                return "当前列表为空：没有匹配“\(query)”的历史，清空搜索或换个关键词后再导出。"
            }
            return filter == .favorites ? "当前收藏列表为空，先收藏记录后再导出。" : "当前列表为空，先完成一次翻译后再导出。"
        case .all:
            return "还没有翻译历史，先完成一次翻译后再导出。"
        case .favorites:
            return "还没有收藏记录，先点星标收藏后再导出。"
        }
    }

    private func confirmClearHistoryKeepingFavorites() {
        let removableCount = historyStore.records.filter { !$0.isFavorite }.count
        guard removableCount > 0 else {
            exportMessage = "没有可清空的非收藏历史"
            lastExportResult = nil
            recentlyDeletedRecord = nil
            return
        }

        let alert = NSAlert()
        alert.messageText = "清空 \(removableCount) 条非收藏历史？"
        alert.informativeText = "收藏记录会保留。这个操作不能撤销。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "清空")
        alert.addButton(withTitle: "取消")

        guard alert.runModal() == .alertFirstButtonReturn else { return }
        historyStore.clearHistoryKeepingFavorites()
        lastExportResult = nil
        recentlyDeletedRecord = nil
        exportMessage = "已清空 \(removableCount) 条非收藏历史，收藏已保留"
    }

    private func recordSummary(_ record: TranslationRecord) -> String {
        let translation = record.translation.trimmingCharacters(in: .whitespacesAndNewlines)
        let original = record.original.trimmingCharacters(in: .whitespacesAndNewlines)
        let source = translation.isEmpty ? original : translation
        guard !source.isEmpty else { return record.source.displayName }
        return String(source.prefix(24))
    }

    private func deletedMessage(for record: TranslationRecord, fallback: String) -> String {
        let summary = recordSummary(record)
        return summary.isEmpty ? fallback : "已删除：\(summary)"
    }

}
