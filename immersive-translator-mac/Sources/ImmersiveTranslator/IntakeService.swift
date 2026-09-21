import Foundation
import PDFKit
import ReaderCore

/// 内容进水口的应用层服务：内置文库/考试词表加载（Bundle.module）、
/// 本地文件抽取调度（txt/docx/pdf）、网页正文抓取（URLSession）。
/// 纯逻辑（编码探测 / docx XML / 正文清洗 / 覆盖计算）都在 ReaderCore，可单测。
final class IntakeService {
    static let shared = IntakeService()

    /// 内置文库（6 篇公版书）；bundle 缺文件时为空数组（功能降级不崩）。
    let library: [IntakeLibraryItem]
    /// 考试大纲词表；缺文件时空集合。
    let wordlists: ExamWordlists

    /// 考试目标持久化键（对齐 Windows localStorage intake-exam-goal）。
    static let examGoalKey = "intake-exam-goal"

    var examGoal: ExamGoal {
        get {
            let saved = UserDefaults.standard.string(forKey: Self.examGoalKey)
            return ExamGoal(rawValue: saved ?? "") ?? .kaoyan
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: Self.examGoalKey)
        }
    }

    private init() {
        if let url = Bundle.module.url(forResource: "library", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let items = try? JSONDecoder().decode([IntakeLibraryItem].self, from: data) {
            library = items
        } else {
            library = []
        }
        if let url = Bundle.module.url(forResource: "exam-wordlists", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let lists = ExamWordlists(rawJSON: data) {
            wordlists = lists
        } else {
            wordlists = ExamWordlists(kaoyan: [], cet4: [], cet6: [])
        }
    }

    // MARK: - 本地文件抽取

    /// 解析本地文件为正文文本（txt / docx / pdf）。失败抛 FileImportError（中文可读）。
    func extractTextFromFile(url: URL) throws -> ExtractedFileText {
        let fileName = url.lastPathComponent
        guard let kind = detectImportFileKind(fileName: fileName) else {
            throw FileImportError("仅支持 .txt / .docx / .pdf 文件")
        }
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw FileImportError("读取文件失败：\(error.localizedDescription)")
        }
        let maxBytes = maxBytesForKind(kind)
        if data.count > maxBytes {
            throw FileImportError("文件超过 \(maxBytes / 1024 / 1024)MB 上限，请精简后再导入")
        }
        switch kind {
        case .txt:
            return try extractTxt(data: data)
        case .docx:
            return ExtractedFileText(kind: .docx, text: try DocxTextExtractor.extractText(data: data))
        case .pdf:
            return try extractPdf(data: data)
        }
    }

    private func extractTxt(data: Data) throws -> ExtractedFileText {
        let text = decodeTextBytes(data)
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw FileImportError("文件是空的")
        }
        if text.contains("\u{FFFD}") {
            throw FileImportError(
                "这个文本文件的编码无法识别（解码后存在乱码字符）。\n请在文本编辑里「另存为 → UTF-8」后再导入。"
            )
        }
        return ExtractedFileText(kind: .txt, text: text)
    }

    /// PDFKit 抽文本层：逐页 string → joinPdfLines 跨行断词拼接。
    /// 扫描件/无文本层给明确报错引导走粘贴，绝不静默产出空文章。
    private func extractPdf(data: Data) throws -> ExtractedFileText {
        guard let doc = PDFDocument(data: data) else {
            throw FileImportError("PDF 解析失败：文件可能已损坏或加了密。")
        }
        var pageTexts: [String] = []
        for i in 0..<doc.pageCount {
            guard let page = doc.page(at: i) else { continue }
            let raw = page.string ?? ""
            let lines = raw.components(separatedBy: .newlines)
            let joined = joinPdfLines(lines)
            if !joined.isEmpty { pageTexts.append(joined) }
        }
        let text = pageTexts.filter { !$0.isEmpty }.joined(separator: "\n\n")
        if !hasMeaningfulText(text) {
            throw FileImportError(
                "这个 PDF 提取不到文字（多半是扫描件或图片导出，没有文字层）。\n请改用「粘贴文本」把内容贴进来，或换一个文字版 PDF。"
            )
        }
        return ExtractedFileText(kind: .pdf, text: text, pages: doc.pageCount)
    }

    // MARK: - 网页抓取（对齐 web_extract.rs reader_fetch_url）

    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.httpAdditionalHeaders = [
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        ]
        return URLSession(configuration: config)
    }()

    private static let maxHTMLBytes = 5_000_000

    func fetchArticle(url urlString: String) async throws -> FetchedArticle {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsed = URL(string: trimmed), let scheme = parsed.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            throw FileImportError("这不是有效的网址")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(from: parsed)
        } catch {
            throw FileImportError("打不开这个链接（\(error.localizedDescription)）——检查网络或地址后重试")
        }
        let finalURL = response.url?.absoluteString ?? trimmed
        if let http = response as? HTTPURLResponse {
            if http.statusCode == 401 || http.statusCode == 403 {
                throw FileImportError("这个页面需要登录或拒绝了程序访问。可以在网页里全选复制正文，用「粘贴文本」导入。")
            }
            guard (200..<300).contains(http.statusCode) else {
                throw FileImportError("网站返回了 \(http.statusCode)，抓取失败")
            }
        }
        let contentType = (response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Type")?
            .lowercased() ?? ""
        if contentType.contains("application/pdf") {
            throw FileImportError("这是一份 PDF——请先下载到本地，用「本地文件」导入。")
        }
        if data.count > Self.maxHTMLBytes {
            throw FileImportError("页面太大，超出处理范围")
        }
        if contentType.contains("text/html") || contentType.isEmpty {
            let html = String(data: data, encoding: .utf8)
                ?? String(data: data, encoding: .isoLatin1)
                ?? ""
            switch extractArticle(finalURL: finalURL, html: html) {
            case .success(let article):
                return article
            case .failure(let error):
                throw error
            }
        }
        // text/plain 或其他：按纯文本处理，仍然做长度门禁
        let body = String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .isoLatin1)
            ?? ""
        let text = body
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .joined(separator: "\n\n")
        let words = text.split(whereSeparator: \.isWhitespace).count
        if words < webExtractMinArticleWords {
            throw FileImportError("这个地址没有可读的文章正文。")
        }
        return FetchedArticle(url: finalURL, host: hostOf(finalURL), title: "", text: text)
    }
}
