import XCTest
import Compression
@testable import ReaderCore

/// 内容进水口（P1）：考试词表覆盖 / 网页正文提取 / 文件导入核心 / docx·zip / 文库轮换。

final class IntakeTests: XCTestCase {
    // MARK: - 考试词表覆盖（examCoverage.ts 对齐）

    private let wordlists = ExamWordlists(
        kaoyan: ["study", "run", "box", "plan", "be", "child"],
        cet4: ["book", "read"],
        cet6: ["legacy"]
    )

    func testExamTokenize() {
        XCTAssertEqual(examTokenize("Hello, World! It's fine."), ["hello", "world", "it's", "fine"])
        XCTAssertEqual(examTokenize("don’t stop"), ["don't", "stop"])
        XCTAssertEqual(examTokenize("数字123 mixed456"), ["mixed"])
    }

    func testLemmaCandidates() {
        XCTAssertEqual(lemmaCandidates(of: "studies").last, "study")
        XCTAssertTrue(lemmaCandidates(of: "boxes").contains("box"))
        XCTAssertTrue(lemmaCandidates(of: "running").contains("run"))
        XCTAssertTrue(lemmaCandidates(of: "planned").contains("plan"))
        XCTAssertTrue(lemmaCandidates(of: "were").contains("be"))
        XCTAssertTrue(lemmaCandidates(of: "children").contains("child"))
        XCTAssertEqual(lemmaCandidates(of: "class"), ["class"])  // ss 不去 s
    }

    func testCoveredWordsWithInflection() {
        let hit = coveredWords(in: "The children studied the boxes. They were running to plan.", goal: .kaoyan, wordlists: wordlists)
        XCTAssertEqual(hit, ["study", "child", "box", "be", "run", "plan"])
    }

    private func vocab(_ id: String, intervalDays: Double) -> VocabWord {
        var srs = VocabSrsState(ease: 2.5, intervalDays: intervalDays, reps: 1, dueAt: 0, lapses: 0)
        srs.intervalDays = intervalDays
        return VocabWord(
            id: id,
            word: id,
            source: VocabSource(articleId: "", sentenceIdx: 0),
            srs: srs,
            addedAt: 0
        )
    }

    func testCoverageForTextUnmastered() {
        // study 未掌握（<7 天），box 已掌握（≥7 天），read 不在 kaoyan 词表
        let cov = coverageForText(
            "The children studied the boxes and read books.",
            goal: .kaoyan,
            vocab: [vocab("study", intervalDays: 1), vocab("box", intervalDays: 7), vocab("read", intervalDays: 0)],
            wordlists: wordlists
        )
        XCTAssertEqual(cov.total, 3)  // study child box（read/book 不在考研集合）
        XCTAssertEqual(cov.unmastered, 1)
    }

    func testWordInGoalList() {
        XCTAssertTrue(wordInGoalList("Book", goal: .cet4, wordlists: wordlists))
        XCTAssertFalse(wordInGoalList("book", goal: .cet6, wordlists: wordlists))
    }

    // MARK: - 网页正文提取（web_extract.rs 对齐）

    private let long1 = "Reading is the process of taking in the sense or meaning of letters, symbols, or sentence structure, especially by the eye or by touch. For educators and researchers, reading is a multifaceted process involving such areas as word recognition, orthography, alphabetics, phonics, and phonemic awareness."
    private let long2 = "Reading is typically an individual activity done silently, although on occasion a person reads out loud for other listeners; the act of reading aloud for one's own use is known as subvocalization. Against this background, the reading comprehension of students is a major focus of modern schooling."

    func testExtractArticleStripsNoise() {
        let html = """
        <html><head><title>Reading - Wikipedia</title>
        <style>.nav{display:none}</style></head>
        <body>
        <nav><a>Home</a><a>Menu</a><a>About us</a></nav>
        <script>var x = 1;</script>
        <h1>Reading</h1>
        <p>\(long1)</p>
        <p>\(long2)</p>
        </body></html>
        """
        guard case .success(let article) = extractArticle(finalURL: "https://en.wikipedia.org/wiki/Reading", html: html, minWords: 20) else {
            return XCTFail("应成功")
        }
        XCTAssertEqual(article.host, "en.wikipedia.org")
        XCTAssertEqual(article.title, "Reading")
        XCTAssertTrue(article.text.contains("Reading is the process"))
        XCTAssertFalse(article.text.contains("Home"))
        XCTAssertFalse(article.text.contains("var x"))
        XCTAssertTrue(article.text.contains("subvocalization"))
    }

    func testOgTitleWinsAndShortLinesDropped() {
        let html = """
        <html><head><meta property="og:title" content="真实标题 | 某站点"><title>wrong</title></head>
        <body><p>Share</p><p>Subscribe to our newsletter for updates</p>
        <p>\(long1)</p>
        <p>\(long2)</p></body></html>
        """
        guard case .success(let article) = extractArticle(finalURL: "https://example.com/a", html: html, minWords: 20) else {
            return XCTFail("应成功")
        }
        XCTAssertEqual(article.title, "真实标题")
        XCTAssertFalse(article.text.contains("Subscribe"))
        XCTAssertTrue(article.text.contains("Reading is the process"))
    }

    func testTinyBodyRejectedAsPaywallLike() {
        let html = "<html><body><p>Subscribe to continue reading.</p></body></html>"
        guard case .failure(let err) = extractArticle(finalURL: "https://example.com/p", html: html) else {
            return XCTFail("应失败")
        }
        XCTAssertTrue(err.message.contains("付费墙"))
    }

    func testDecodeEntities() {
        XCTAssertEqual(decodeHTMLEntities("A &amp; B &quot;q&quot; &#8212; &#x27;"), "A & B \"q\" — '")
    }

    func testHostOf() {
        XCTAssertEqual(hostOf("https://a.b.example.com/path?q=1"), "a.b.example.com")
        XCTAssertEqual(hostOf("not a url"), "not a url")
    }

    // MARK: - 文件导入核心（fileImport.ts 对齐）

    func testDetectImportFileKind() {
        XCTAssertEqual(detectImportFileKind(fileName: "a.TXT"), .txt)
        XCTAssertEqual(detectImportFileKind(fileName: "b.DocX"), .docx)
        XCTAssertEqual(detectImportFileKind(fileName: "c.pdf"), .pdf)
        XCTAssertNil(detectImportFileKind(fileName: "d.doc"))
        XCTAssertNil(detectImportFileKind(fileName: "e.epub"))
    }

    func testFileTitleAndSourceType() {
        XCTAssertEqual(fileTitleOf(fileName: "My Article.pdf"), "My Article")
        XCTAssertEqual(fileTitleOf(fileName: ".hidden"), ".hidden")
        XCTAssertEqual(importKindSourceType(.txt), .paste)
        XCTAssertEqual(importKindSourceType(.docx), .docx)
        XCTAssertEqual(importKindSourceType(.pdf), .pdf)
    }

    func testDecodeTextBytesUTF8AndBOMs() {
        XCTAssertEqual(decodeTextBytes(Data("hello 你好".utf8)), "hello 你好")
        let utf8Bom = Data([0xEF, 0xBB, 0xBF]) + Data("hi".utf8)
        XCTAssertEqual(decodeTextBytes(utf8Bom), "hi")
        let utf16le = Data([0xFF, 0xFE]) + "好".data(using: .utf16LittleEndian)!
        XCTAssertEqual(decodeTextBytes(utf16le), "好")
    }

    func testDecodeTextBytesGBKFallback() {
        // "你好" 的 GBK 编码：C4 E3 BA C3 —— 严格 UTF-8 校验失败后按 GB18030 解。
        let gbk = Data([0xC4, 0xE3, 0xBA, 0xC3])
        XCTAssertEqual(decodeTextBytes(gbk), "你好")
    }

    func testJoinPdfLinesDehyphenation() {
        XCTAssertEqual(
            joinPdfLines(["Reading is the pro-", "cess of taking in words."]),
            "Reading is the process of taking in words."
        )
        // 下一行大写开头不拼接
        XCTAssertEqual(
            joinPdfLines(["state-of-", "The-art"]),
            "state-of- The-art"
        )
        XCTAssertEqual(joinPdfLines(["  ", "a b", ""]), "a b")
    }

    func testHasMeaningfulText() {
        XCTAssertTrue(hasMeaningfulText("Hello world"))
        XCTAssertTrue(hasMeaningfulText("中文内容"))
        XCTAssertFalse(hasMeaningfulText("123 456 ."))
    }

    func testEstimateLevel() {
        XCTAssertEqual(estimateLevel(text: "", sentences: 0), "B1")
        XCTAssertEqual(estimateLevel(text: "One two three four end.", sentences: 1), "A2")
    }

    func testIntakePreviewStats() {
        let stats = IntakePreviewStats(text: "First paragraph here.\n\nSecond paragraph follows with more words in it.")
        XCTAssertEqual(stats.paras, 2)
        XCTAssertEqual(stats.minutes, 1)
        XCTAssertFalse(stats.level.isEmpty)
    }

    // MARK: - zip / docx

    /// 测试内构造 stored（无压缩）zip：本地头 + 数据 + 中央目录 + EOCD。
    private func makeStoredZip(_ entries: [(name: String, data: Data)]) -> Data {
        var out = Data()
        var central = Data()
        func le16(_ v: Int) -> Data { Data([UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF)]) }
        func le32(_ v: Int) -> Data {
            Data([UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8((v >> 24) & 0xFF)])
        }
        for entry in entries {
            let offset = out.count
            out.append(le32(0x04034b50))
            out.append(le16(20))  // version needed
            out.append(le16(0))   // flags
            out.append(le16(0))   // method = stored
            out.append(le16(0)); out.append(le16(0))  // time / date
            out.append(le32(0))   // crc
            out.append(le32(entry.data.count))
            out.append(le32(entry.data.count))
            out.append(le16(entry.name.utf8.count))
            out.append(le16(0))   // extra len
            out.append(Data(entry.name.utf8))
            out.append(entry.data)

            central.append(le32(0x02014b50))
            central.append(le16(20)); central.append(le16(20))
            central.append(le16(0)); central.append(le16(0))
            central.append(le16(0)); central.append(le16(0))
            central.append(le32(0))
            central.append(le32(entry.data.count))
            central.append(le32(entry.data.count))
            central.append(le16(entry.name.utf8.count))
            central.append(le16(0)); central.append(le16(0)); central.append(le16(0)); central.append(le16(0))
            central.append(le32(0))  // 外部属性
            central.append(le32(offset))
            central.append(Data(entry.name.utf8))
        }
        let centralOffset = out.count
        out.append(central)
        out.append(le32(0x06054b50))
        out.append(le16(0)); out.append(le16(0))
        out.append(le16(entries.count)); out.append(le16(entries.count))
        out.append(le32(central.count))
        out.append(le32(centralOffset))
        out.append(le16(0))
        return out
    }

    func testZipReadStoredEntry() throws {
        let zip = makeStoredZip([
            ("[Content_Types].xml", Data("<Types/>".utf8)),
            ("word/document.xml", Data("<doc/>".utf8)),
        ])
        let archive = try ZipArchive(zip)
        let names = try archive.entries().map(\.fileName)
        XCTAssertEqual(names, ["[Content_Types].xml", "word/document.xml"])
        XCTAssertEqual(try archive.readFile(named: "word/document.xml"), Data("<doc/>".utf8))
        XCTAssertThrowsError(try archive.readFile(named: "missing.txt"))
    }

    func testZipDeflateEntry() throws {
        // 用 zlib 压缩（raw deflate）构造一个 method=8 条目
        let original = Data(String(repeating: "paragraph text repeats. ", count: 40).utf8)
        let deflated = original.withUnsafeBytes { src in
            compressData(src.bindMemory(to: UInt8.self))
        }
        XCTAssertLessThan(deflated.count, original.count)

        var out = Data()
        func le16(_ v: Int) -> Data { Data([UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF)]) }
        func le32(_ v: Int) -> Data {
            Data([UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8((v >> 24) & 0xFF)])
        }
        let localOffset = 0
        out.append(le32(0x04034b50))
        out.append(le16(20)); out.append(le16(0)); out.append(le16(8))  // method = deflate
        out.append(le16(0)); out.append(le16(0)); out.append(le32(0))
        out.append(le32(deflated.count)); out.append(le32(original.count))
        out.append(le16(5)); out.append(le16(0))
        out.append(Data("hello".utf8)); out.append(deflated)
        let centralOffset = out.count
        let centralSize = 46 + 5
        out.append(le32(0x02014b50))
        out.append(le16(20)); out.append(le16(20))
        out.append(le16(0)); out.append(le16(8))
        out.append(le16(0)); out.append(le16(0)); out.append(le32(0))
        out.append(le32(deflated.count)); out.append(le32(original.count))
        out.append(le16(5)); out.append(le16(0)); out.append(le16(0))
        out.append(le16(0)); out.append(le16(0)); out.append(le32(0))
        out.append(le32(localOffset))
        out.append(Data("hello".utf8))
        out.append(le32(0x06054b50))
        out.append(le16(0)); out.append(le16(0)); out.append(le16(1)); out.append(le16(1))
        out.append(le32(centralSize))
        out.append(le32(centralOffset))
        out.append(le16(0))
        let archive = try ZipArchive(out)
        XCTAssertEqual(try archive.readFile(named: "hello"), original)
    }

    func testDocxExtractText() throws {
        let xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body>
            <w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p>
            <w:p><w:r><w:t>Second </w:t><w:t>paragraph.</w:t></w:r></w:p>
            <w:p><w:r><w:br/><w:t>line two</w:t></w:r></w:p>
          </w:body>
        </w:document>
        """
        let zip = makeStoredZip([("word/document.xml", Data(xml.utf8))])
        let text = try DocxTextExtractor.extractText(data: zip)
        XCTAssertEqual(text, "First paragraph.\n\nSecond paragraph.\n\nline two")
    }

    func testDocxRejectsNonZip() {
        XCTAssertThrowsError(try DocxTextExtractor.extractText(data: Data("not a zip".utf8)))
    }

    // MARK: - 文库轮换

    func testLocalDayNumberMatchesTSSemantics() {
        // 2026-09-21 00:30 北京时间（UTC+8）= 2026-09-20 16:30 UTC → 本地日序应为 20 日的序号
        let ts = Int64(1_789_897_800_000)  // 2026-09-20T16:30:00Z
        // 参考实现（TS 语义直译）
        let date = Date(timeIntervalSince1970: Double(ts) / 1000)
        let expected = Int(floor((Double(ts) / 1000.0 + Double(TimeZone.current.secondsFromGMT(for: date))) / 86_400))
        XCTAssertEqual(localDayNumber(now: ts), expected)
    }

    func testTodayLibraryItemRotatesByDay() {
        let items = (0..<3).map { i in
            IntakeLibraryItem(
                id: "b\(i)", en: "Book \(i)", cn: "书\(i)", author: "A", level: "B1",
                words: 100, minutes: 1, quote: "q", sourceUrl: "u", text: "text"
            )
        }
        let a = todayLibraryItem(items, now: 1_000_000_000_000)
        let b = todayLibraryItem(items, now: 1_000_000_000_000 + 86_400_000)
        XCTAssertEqual(a?.id, "b0")
        XCTAssertEqual(b?.id, "b1")
    }

    // MARK: - ArticleBuilder 扩展（titleCn / level）

    func testBuildArticleWithTitleCnSkipsTitleTranslation() {
        let built = buildArticleFromText(
            "The Happy Prince\n\nHigh above the city stood the statue.",
            options: BuildArticleOptions(
                sourceType: .paste,
                sourceUrl: "library:happy-prince",
                now: 123,
                title: "The Happy Prince",
                titleCn: "快乐王子 · Oscar Wilde",
                level: "B1"
            )
        )
        XCTAssertNotNil(built)
        XCTAssertEqual(built?.titleCn, "快乐王子 · Oscar Wilde")
        XCTAssertEqual(built?.titleCnState, .done)
        XCTAssertEqual(built?.level, "B1")
        XCTAssertEqual(built?.sourceUrl, "library:happy-prince")
    }

    func testBuildArticleWithoutTitleCnStaysPending() {
        let built = buildArticleFromText("Plain body text with words.", options: BuildArticleOptions(now: 1))
        XCTAssertNil(built?.titleCn)
        XCTAssertEqual(built?.titleCnState, .pending)
        XCTAssertNil(built?.level)
    }
}

/// 测试用 zlib raw-deflate 压缩（Compression 框架）。
private func compressData(_ input: UnsafeBufferPointer<UInt8>) -> Data {
    let destinationBufferSize = input.count + 1024
    var destinationBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: destinationBufferSize)
    defer { destinationBuffer.deallocate() }
    let written = compression_encode_buffer(
        destinationBuffer, destinationBufferSize,
        input.baseAddress!, input.count,
        nil, COMPRESSION_ZLIB
    )
    return Data(bytes: destinationBuffer, count: written)
}
