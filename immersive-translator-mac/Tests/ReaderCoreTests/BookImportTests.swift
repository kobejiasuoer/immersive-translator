import XCTest
@testable import ReaderCore

/// 整本书导入建书：EPUB 解析（目录分章 / DRM / 封面）、长文分节、
/// 导入草稿雷达实算、书级模型编解码。对齐 src/core/bookImport.test.ts 的关键用例。

final class BookImportTests: XCTestCase {
    // MARK: - 测试用 zip 生成器（stored 条目；reader 只校验结构不校验 CRC）

    private func crc32(_ data: [UInt8]) -> UInt32 {
        var table: [UInt32] = (0..<256).map { i -> UInt32 in
            var c = UInt32(i)
            for _ in 0..<8 {
                c = (c & 1) == 1 ? (0xEDB88320 ^ (c >> 1)) : (c >> 1)
            }
            return c
        }
        var crc: UInt32 = 0xFFFFFFFF
        for byte in data {
            crc = table[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8)
        }
        return crc ^ 0xFFFFFFFF
    }

    /// 最小 zip 写入器：stored 条目 + 中央目录 + EOCD。encryptedNames 置
    /// general purpose bit 0（加密位）。
    private func buildZip(_ files: [(name: String, content: String)], encryptedNames: Set<String> = []) -> Data {
        var out: [UInt8] = []
        struct CentralEntry {
            var nameBytes: [UInt8]
            var flags: UInt16
            var crc: UInt32
            var size: UInt32
            var localOffset: UInt32
        }
        var centrals: [CentralEntry] = []
        for file in files {
            let nameBytes = Array(file.name.utf8)
            let contentBytes = Array(file.content.utf8)
            let crc = crc32(contentBytes)
            let flags: UInt16 = encryptedNames.contains(file.name) ? 0x1 : 0
            let localOffset = UInt32(out.count)
            // 本地头：sig(4) version(2) flags(2) method(2) time(2) date(2) crc(4) sizes(8) nameLen(2) extraLen(2)
            func u16(_ v: Int) -> [UInt8] { [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF)] }
            func u32(_ v: UInt32) -> [UInt8] {
                [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8((v >> 24) & 0xFF)]
            }
            out += u32(0x04034b50)
            out += u16(20)
            out += u16(Int(flags))
            out += u16(0)  // stored
            out += u16(0); out += u16(0)  // time/date
            out += u32(crc)
            out += u32(UInt32(contentBytes.count))
            out += u32(UInt32(contentBytes.count))
            out += u16(nameBytes.count)
            out += u16(0)
            out += nameBytes
            out += contentBytes
            centrals.append(CentralEntry(
                nameBytes: nameBytes, flags: flags, crc: crc,
                size: UInt32(contentBytes.count), localOffset: localOffset
            ))
        }
        let cdStart = UInt32(out.count)
        for entry in centrals {
            func u16(_ v: Int) -> [UInt8] { [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF)] }
            func u32(_ v: UInt32) -> [UInt8] {
                [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8((v >> 24) & 0xFF)]
            }
            out += u32(0x02014b50)
            out += u16(20)  // version made by
            out += u16(20)  // version needed
            out += u16(Int(entry.flags))
            out += u16(0)  // stored
            out += u16(0); out += u16(0)  // time/date
            out += u32(entry.crc)
            out += u32(entry.size)
            out += u32(entry.size)
            out += u16(entry.nameBytes.count)
            out += u16(0)  // extra
            out += u16(0)  // comment
            out += u16(0)  // disk start
            out += u16(0)  // internal attrs
            out += u32(0)  // external attrs
            out += u32(entry.localOffset)
            out += entry.nameBytes
        }
        let cdSize = UInt32(out.count) - cdStart
        func u16(_ v: Int) -> [UInt8] { [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF)] }
        func u32(_ v: UInt32) -> [UInt8] {
            [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8((v >> 24) & 0xFF)]
        }
        out += u32(0x06054b50)
        out += u16(0); out += u16(0)  // disk number
        out += u16(centrals.count); out += u16(centrals.count)
        out += u32(cdSize)
        out += u32(cdStart)
        out += u16(0)  // comment length
        return Data(out)
    }

    private func epubData(_ files: [String: String], encryptedNames: Set<String> = [], name: String = "book.epub") throws -> (Data, String) {
        let ordered = files.map { (name: $0.key, content: $0.value) }.sorted { $0.name < $1.name }
        return (buildZip(ordered, encryptedNames: encryptedNames), name)
    }

    // MARK: - 测试书结构（对齐 bookImport.test.ts）

    private let containerXml = """
    <?xml version="1.0"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>
    """

    private func opfXml(spine: [String], manifestItems: String, extra: String = "") -> String {
        """
        <?xml version="1.0" encoding="utf-8"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>The Call of the Wild</dc:title>
            <dc:creator>Jack London</dc:creator>
            \(extra)
          </metadata>
          <manifest>\(manifestItems)</manifest>
          <spine>\(spine.map { "<itemref idref=\"\($0)\"/>" }.joined())</spine>
        </package>
        """
    }

    private func xhtml(_ body: String) -> String {
        """
        <?xml version="1.0" encoding="utf-8"?>
        <html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>\(body)</body></html>
        """
    }

    private let ch1Body = "<p>Old longings nomadic leap.</p><p>Chafing at custom's chain.</p>"
    private let ch2Body = "<p>Buck did not read the newspapers.</p><p>He did not know that trouble was coming.</p>"

    /// EPUB3 NAV 目录版（与 Windows 测试同一本《野性的呼唤》）。
    private var epub3Files: [String: String] {
        [
            "META-INF/container.xml": containerXml,
            "OEBPS/content.opf": opfXml(
                spine: ["ch1", "ch2"],
                manifestItems: """
                <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
                <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
                <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
                """
            ),
            "OEBPS/ch1.xhtml": xhtml(ch1Body),
            "OEBPS/ch2.xhtml": xhtml(ch2Body),
            "OEBPS/nav.xhtml": """
            <?xml version="1.0"?>
            <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
              <body><nav epub:type="toc"><ol>
                <li><a href="ch1.xhtml">Into the Primitive</a></li>
                <li><a href="ch2.xhtml">The Law of Club and Fang</a></li>
              </ol></nav></body></html>
            """,
        ]
    }

    private func parseEpub(_ files: [String: String], encryptedNames: Set<String> = [], name: String = "book.epub") throws -> EpubBook {
        let (data, fileName) = try epubData(files, encryptedNames: encryptedNames, name: name)
        return try ReaderCore.parseEpub(data: data, fileName: fileName)
    }

    // MARK: - XHTML → 纯文本

    func testExtractXhtmlTextBlockTagsInlineWhitespaceBrAndSkipsScriptStyle() {
        let text = extractXhtmlText(xhtml(
            "<p>Buck did not read the  newspapers.</p>"
                + "<script>evil()</script><style>.x{}</style>"
                + "<p>He had<span>  no </span>need<br/>to fight.</p>"
                + "<div><h2>Chapter II</h2><p>Into the primitive.</p></div>"
        ))
        XCTAssertEqual(
            text,
            "Buck did not read the newspapers.\n\nHe had no need to fight.\n\nChapter II\n\nInto the primitive."
        )
    }

    func testExtractXhtmlTextLooseHTMLFallback() {
        XCTAssertEqual(extractXhtmlText("<html><body><p>Loose<br>markup</p></body></html>"), "Loose markup")
    }

    func testExtractXhtmlTextEmptyDocument() {
        XCTAssertEqual(extractXhtmlText(xhtml("")), "")
    }

    // MARK: - EPUB 解析

    func testParseEpubEpub3NavToc() throws {
        let book = try parseEpub(epub3Files)
        XCTAssertEqual(book.title, "The Call of the Wild")
        XCTAssertEqual(book.author, "Jack London")
        XCTAssertTrue(book.tocUsed)
        XCTAssertEqual(book.chapters.map(\.title), ["Into the Primitive", "The Law of Club and Fang"])
        XCTAssertTrue(book.chapters[0].text.contains("Old longings nomadic leap."))
        XCTAssertTrue(book.chapters[1].text.contains("trouble was coming"))
        XCTAssertGreaterThan(book.totalWords, 0)
        XCTAssertGreaterThanOrEqual(book.minutes, 1)
    }

    func testParseEpubEpub2NcxToc() throws {
        var files = epub3Files
        files["OEBPS/content.opf"] = opfXml(
            spine: ["ch1", "ch2"],
            manifestItems: """
            <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
            <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
            <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
            """,
            extra: "<meta name=\"cover\" content=\"cover-img\"/>"
        )
        files.removeValue(forKey: "OEBPS/nav.xhtml")
        files["OEBPS/toc.ncx"] = """
        <?xml version="1.0"?>
        <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
          <head/><docTitle><text>x</text></docTitle>
          <navMap>
            <navPoint id="n1" playOrder="1"><navLabel><text>卷一 · 第一章</text></navLabel><content src="ch1.xhtml"/></navPoint>
            <navPoint id="n2" playOrder="2"><navLabel><text>第二章</text></navLabel><content src="ch2.xhtml"/></navPoint>
          </navMap>
        </ncx>
        """
        let book = try parseEpub(files)
        XCTAssertTrue(book.tocUsed)
        XCTAssertEqual(book.chapters.map(\.title), ["卷一 · 第一章", "第二章"])
    }

    func testParseEpubMergesMultipleSpineFilesIntoOneTocChapter() throws {
        var files = epub3Files
        files["OEBPS/content.opf"] = opfXml(
            spine: ["p1", "p2", "p3"],
            manifestItems: """
            <item id="p1" href="p1.xhtml" media-type="application/xhtml+xml"/>
            <item id="p2" href="p2.xhtml" media-type="application/xhtml+xml"/>
            <item id="p3" href="p3.xhtml" media-type="application/xhtml+xml"/>
            <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
            """
        )
        files["OEBPS/ch1.xhtml"] = ""
        files.removeValue(forKey: "OEBPS/ch2.xhtml")
        files["OEBPS/p1.xhtml"] = xhtml("<p>Part one first half.</p>")
        files["OEBPS/p2.xhtml"] = xhtml("<p>Part one second half continues here.</p>")
        files["OEBPS/p3.xhtml"] = xhtml("<p>A brand new chapter begins.</p>")
        files["OEBPS/nav.xhtml"] = """
        <?xml version="1.0"?>
        <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
          <body><nav epub:type="toc"><ol>
            <li><a href="p1.xhtml">Merged Chapter</a></li>
            <li><a href="p3.xhtml">Next</a></li>
          </ol></nav></body></html>
        """
        let book = try parseEpub(files)
        XCTAssertEqual(book.chapters.count, 2)
        XCTAssertTrue(book.chapters[0].text.contains("second half"))
        XCTAssertEqual(book.chapters[0].title, "Merged Chapter")
    }

    func testParseEpubMultiLevelTocFlattensWithVolumePrefixAndDedupesBySpine() throws {
        // 多级目录：叶子展平 + 卷名作前缀；同一 spine 文件被父条目与叶子同时
        // 引用时保留首个（后续是重复目录，与 TS flattenToc 的 seen 去重一致）。
        var files = epub3Files
        files["OEBPS/content.opf"] = opfXml(
            spine: ["c1", "c2", "c3"],
            manifestItems: """
            <item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
            <item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>
            <item id="c3" href="text/c3.xhtml" media-type="application/xhtml+xml"/>
            <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
            """
        )
        files["OEBPS/text/c1.xhtml"] = xhtml(ch1Body)
        files["OEBPS/text/c2.xhtml"] = xhtml(ch2Body)
        files["OEBPS/text/c3.xhtml"] = xhtml("<p>Third chapter content.</p>")
        files["OEBPS/nav.xhtml"] = """
        <?xml version="1.0"?>
        <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
          <body><nav epub:type="toc"><ol>
            <li><a href="text/c1.xhtml">Volume One</a>
              <ol>
                <li><a href="text/c1.xhtml">First Part</a></li>
                <li><a href="text/c2.xhtml">Second Part</a></li>
              </ol>
            </li>
            <li><a href="text/c3.xhtml">Volume Two</a></li>
          </ol></nav></body></html>
        """
        let book = try parseEpub(files)
        XCTAssertTrue(book.tocUsed)
        XCTAssertEqual(book.chapters.map(\.title), ["Volume One", "Volume One · Second Part", "Volume Two"])
        XCTAssertTrue(book.chapters[1].text.contains("trouble was coming"))
    }

    func testParseEpubWithoutTocFallsBackToSections() throws {
        let paras = (0..<400).map { "<p>Sentence number \($0) tells a wordy story of travel.</p>" }.joined()
        var files = epub3Files
        files["OEBPS/content.opf"] = opfXml(
            spine: ["c1", "c2"],
            manifestItems: """
            <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
            <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
            """
        )
        files.removeValue(forKey: "OEBPS/nav.xhtml")
        files["OEBPS/c1.xhtml"] = xhtml(paras)
        files["OEBPS/c2.xhtml"] = xhtml(paras)
        let book = try parseEpub(files)
        XCTAssertFalse(book.tocUsed)
        XCTAssertEqual(book.fallbackNotice, "未识别到目录，已按内容长度自动分节")
        XCTAssertGreaterThanOrEqual(book.chapters.count, 2)
        XCTAssertEqual(book.chapters[0].title, "第 1 节")
    }

    func testParseEpubSuspiciousTocCoverageFallsBackToSections() throws {
        func filler(_ seed: String) -> String {
            xhtml((0..<8).map {
                "<p>\(seed) paragraph \($0) wanders through the valley with plenty of words to fill the length threshold required here.</p>"
            }.joined())
        }
        var files = epub3Files
        files["OEBPS/content.opf"] = opfXml(
            spine: ["c1", "c2", "c3"],
            manifestItems: """
            <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
            <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
            <item id="c3" href="c3.xhtml" media-type="application/xhtml+xml"/>
            <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
            """
        )
        files["OEBPS/c1.xhtml"] = filler("Alpha chapter")
        files["OEBPS/c2.xhtml"] = filler("Orphan beta")
        files["OEBPS/c3.xhtml"] = filler("Orphan gamma")
        files["OEBPS/nav.xhtml"] = """
        <?xml version="1.0"?>
        <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
          <body><nav epub:type="toc"><ol><li><a href="c1.xhtml">Only One</a></li></ol></nav></body></html>
        """
        let book = try parseEpub(files)
        XCTAssertFalse(book.tocUsed)
        XCTAssertEqual(book.fallbackNotice, "这本书的目录不完整，已按内容长度自动分节")
        // 内容不丢：回退分节覆盖全部三个文件。
        let all = book.chapters.map(\.text).joined(separator: "\n")
        XCTAssertTrue(all.contains("Orphan beta"))
        XCTAssertTrue(all.contains("Orphan gamma"))
    }

    func testParseEpubRejectsDrmEncryptedContent() {
        var files = epub3Files
        files["META-INF/encryption.xml"] = """
        <?xml version="1.0"?>
        <encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
          <enc:EncryptedData><enc:CipherData><enc:CipherReference URI="OEBPS/ch1.xhtml"/></enc:CipherData></enc:EncryptedData>
        </encryption>
        """
        XCTAssertThrowsError(try parseEpub(files)) { error in
            XCTAssertTrue((error as? FileImportError)?.message.contains("DRM") ?? false)
        }
    }

    func testParseEpubFontOnlyObfuscationIsNotDrm() throws {
        var files = epub3Files
        files["META-INF/encryption.xml"] = """
        <?xml version="1.0"?>
        <encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
          <enc:EncryptedData><enc:CipherData><enc:CipherReference URI="OEBPS/fonts/x.otf"/></enc:CipherData></enc:EncryptedData>
        </encryption>
        """
        let book = try parseEpub(files)
        XCTAssertEqual(book.chapters.count, 2)
    }

    func testParseEpubRejectsNonEpubExtension() {
        XCTAssertThrowsError(try parseEpub(epub3Files, name: "book.mobi")) { error in
            XCTAssertTrue((error as? FileImportError)?.message.contains("仅支持 .epub") ?? false)
        }
    }

    func testParseEpubRejectsBrokenZip() {
        XCTAssertThrowsError(try ReaderCore.parseEpub(data: Data([1, 2, 3, 4, 5]), fileName: "broken.epub")) { error in
            XCTAssertTrue((error as? FileImportError)?.message.contains("EPUB 解析失败") ?? false)
        }
    }

    func testParseEpubRejectsImageOnlyBookWithoutEmptyBook() throws {
        let files: [String: String] = [
            "META-INF/container.xml": containerXml,
            "OEBPS/content.opf": opfXml(
                spine: ["c1"],
                manifestItems: "<item id=\"c1\" href=\"c1.xhtml\" media-type=\"application/xhtml+xml\"/>"
            ),
            "OEBPS/c1.xhtml": xhtml("<div><img src=\"a.png\"/></div>"),
        ]
        XCTAssertThrowsError(try parseEpub(files)) { error in
            XCTAssertTrue((error as? FileImportError)?.message.contains("抽不到正文") ?? false)
        }
    }

    func testParseEpubExtractsCoverAsDataUrl() throws {
        // 1x1 JPEG。
        let jpeg = String(bytes: [
            0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
            0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
        ] as [UInt8], encoding: .isoLatin1)!
        var files = epub3Files
        files["OEBPS/content.opf"] = opfXml(
            spine: ["ch1"],
            manifestItems: """
            <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
            <item id="cover-img" href="cover.jpg" media-type="image/jpeg"/>
            """,
            extra: "<meta name=\"cover\" content=\"cover-img\"/>"
        )
        files["OEBPS/cover.jpg"] = jpeg
        files.removeValue(forKey: "OEBPS/ch2.xhtml")
        files["OEBPS/nav.xhtml"] = """
        <?xml version="1.0"?>
        <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
          <body><nav epub:type="toc"><ol><li><a href="ch1.xhtml">One</a></li></ol></nav></body></html>
        """
        let book = try parseEpub(files)
        XCTAssertTrue(book.coverDataUrl?.hasPrefix("data:image/jpeg;base64,") ?? false)
    }

    func testZipRejectsEncryptedEntryFlag() throws {
        // general purpose bit 0（加密位）置位：ZipArchive 读取时显式拒绝（DRM 载体识别的基础）。
        let zipData = buildZip(
            [("a.txt", "hello")],
            encryptedNames: ["a.txt"]
        )
        let zip = try ZipArchive(zipData)
        let names = try zip.entries().map(\.fileName)
        XCTAssertEqual(names, ["a.txt"])
        XCTAssertTrue(try zip.entries()[0].isEncrypted)
        XCTAssertThrowsError(try zip.readFile(named: "a.txt")) { error in
            guard case ZipArchiveError.entryEncrypted(let name) = error else {
                return XCTFail("应抛 entryEncrypted，实际：\(error)")
            }
            XCTAssertEqual(name, "a.txt")
        }
        // 未加密条目照常可读。
        let plain = try ZipArchive(buildZip([("a.txt", "hello")]))
        XCTAssertEqual(try plain.readFile(named: "a.txt"), Data("hello".utf8))
    }

    // MARK: - zip 路径解析

    func testResolveZipPath() {
        XCTAssertEqual(resolveZipPath("OEBPS/", "ch1.xhtml"), "OEBPS/ch1.xhtml")
        XCTAssertEqual(resolveZipPath("OEBPS/", "ch1.xhtml#frag"), "OEBPS/ch1.xhtml")
        XCTAssertEqual(resolveZipPath("OEBPS/", "../Text/ch1.xhtml"), "Text/ch1.xhtml")
        XCTAssertEqual(resolveZipPath("", "Text/ch1.xhtml"), "Text/ch1.xhtml")
        XCTAssertEqual(resolveZipPath("OEBPS/", "ch%201.xhtml"), "OEBPS/ch 1.xhtml")
        XCTAssertEqual(resolveZipPath("OEBPS/", ""), "")
    }

    // MARK: - 长文分节（txt / docx / pdf 抽文后同法分章）

    func testFallbackSections() {
        let paragraphs = (0..<600).map { i -> String in
            "Paragraph number \(i) shares a modest story about wandering through libraries and learning slowly."
        }.joined(separator: "\n\n")
        let chapters = fallbackSections(from: paragraphs)
        XCTAssertGreaterThanOrEqual(chapters.count, 2)
        XCTAssertEqual(chapters[0].title, "第 1 节")
        XCTAssertEqual(chapters[1].title, "第 2 节")
        // 每节攒满 ~3000 词即切。
        XCTAssertGreaterThanOrEqual(chapters[0].wordCount, fallbackSectionWords)
        // 内容不丢。
        let joined = chapters.map(\.text).joined(separator: "\n\n")
        XCTAssertTrue(joined.contains("Paragraph number 0 "))
        XCTAssertTrue(joined.contains("Paragraph number 599"))
    }

    func testFallbackSectionsShortTextSingleSection() {
        let chapters = fallbackSections(from: "Only a short paragraph here.\n\nAnd another one.")
        XCTAssertEqual(chapters.count, 1)
        XCTAssertEqual(chapters[0].title, "第 1 节")
    }

    // MARK: - 导入草稿（雷达实算）

    private let wordlists = ExamWordlists(
        kaoyan: ["study", "run", "box", "plan", "be", "child"],
        cet4: ["book", "read"],
        cet6: ["legacy"]
    )

    func testRadarForTextComputesAllThreeGoals() {
        let radar = radarForText(
            "The children studied the boxes. They were running to plan. Read the book.",
            wordlists: wordlists
        )
        // child/study/box/be/run/plan 全命中（含屈折回落）。
        XCTAssertEqual(radar.kaoyan, 6)
        XCTAssertEqual(radar.cet4, 2)  // read book
        XCTAssertEqual(radar.cet6, 0)
    }

    func testBuildBookImportDraftComputesRadarTotalsAndMinutes() {
        let draft = buildBookImportDraft(
            title: "A Book",
            author: "An Author",
            chapters: [
                BookImportChapter(title: "c1", text: "Children study and run."),
                BookImportChapter(title: "c2", text: "Read the book, plan the box."),
            ],
            wordlists: wordlists
        )
        XCTAssertNotNil(draft)
        XCTAssertEqual(draft?.title, "A Book")
        XCTAssertEqual(draft?.author, "An Author")
        XCTAssertEqual(draft?.chapters.count, 2)
        XCTAssertEqual(draft?.totalWords, countWords("Children study and run.") + countWords("Read the book, plan the box."))
        XCTAssertEqual(draft?.minutes, max(1, Int((Double(draft?.totalWords ?? 0) / 135.0).rounded())))
        // 雷达按所选章文本实算（含屈折回落）：child/study/run + book/read/plan/box。
        XCTAssertEqual(draft?.radar.kaoyan, 5)
        XCTAssertEqual(draft?.radar.cet4, 2)
        XCTAssertEqual(draft?.radar.cet6, 0)
    }

    func testBuildBookImportDraftEmptyChaptersReturnsNil() {
        XCTAssertNil(buildBookImportDraft(
            title: "Empty", chapters: [BookImportChapter(title: "c1", text: "   ")],
            wordlists: wordlists
        ))
    }

    // MARK: - 书级模型（schema 对齐 + 旧文件兼容）

    private func bookMetaFixture() -> BookMeta {
        BookMeta(
            id: "b1",
            title: "书名",
            author: "作者",
            cover: "data:image/jpeg;base64,QQ==",
            createdAt: 1000,
            lastReadAt: 2000,
            chapters: [
                BookChapterMeta(id: "a1", title: "第一章", wordCount: 100, sentenceCount: 10),
                BookChapterMeta(id: "a2", title: "第二章", wordCount: 120, sentenceCount: 12),
            ],
            progress: BookProgress(chapterId: "a2", sentenceIdx: 3, percent: 40),
            secondsListened: 65.5,
            radar: BookRadar(kaoyan: 7, cet4: 3, cet6: 1)
        )
    }

    func testBookMetaRoundTrip() throws {
        let meta = bookMetaFixture()
        let data = try ReaderFileCodec.encode(meta)
        let decoded = try ReaderFileCodec.decode(BookMeta.self, from: data)
        XCTAssertEqual(decoded, meta)
        // JSON 含全部 required 字段。
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(obj.keys), [
            "id", "title", "author", "cover", "createdAt", "lastReadAt",
            "chapters", "progress", "secondsListened", "radar",
        ])
    }

    func testBookMetaDecodeToleratesOldFilesWithoutOptionalAndRedundantFields() throws {
        // author/cover 是 schema 可选；progress/secondsListened/radar 对旧读取容错。
        let json = """
        {"id":"b1","title":"书名","createdAt":1000,"lastReadAt":2000,
         "chapters":[{"id":"a1","title":"第一章","wordCount":100,"sentenceCount":10}],
         "progress":{"chapterId":"a1","sentenceIdx":0,"percent":0}}
        """
        let meta = try ReaderFileCodec.decode(BookMeta.self, from: Data(json.utf8))
        XCTAssertNil(meta.author)
        XCTAssertNil(meta.cover)
        XCTAssertEqual(meta.secondsListened, 0)
        XCTAssertEqual(meta.radar, BookRadar(kaoyan: 0, cet4: 0, cet6: 0))
        XCTAssertEqual(meta.chapters.count, 1)
        XCTAssertEqual(meta.chapters[0].sentenceCount, 10)
    }

    func testArticleBookFieldsRoundTripAndNilOmitted() throws {
        var article = Article(
            id: "a1", title: "t", createdAt: 1, lastReadAt: 2,
            sentences: [SentencePair(idx: 0, paragraphIdx: 0, en: "Hello.")]
        )
        article.bookId = "b1"
        article.chapterIdx = 0
        let withBook = try ReaderFileCodec.encode(article)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: withBook) as? [String: Any])
        XCTAssertEqual(obj["bookId"] as? String, "b1")
        XCTAssertEqual(obj["chapterIdx"] as? Int, 0)
        XCTAssertEqual(try ReaderFileCodec.decode(Article.self, from: withBook), article)

        // 短文（无书）：编码跳过字段，不给盘上文件引入 null 噪声。
        let short = Article(
            id: "a2", title: "t", createdAt: 1, lastReadAt: 2,
            sentences: [SentencePair(idx: 0, paragraphIdx: 0, en: "Hi.")]
        )
        let shortData = try ReaderFileCodec.encode(short)
        let shortObj = try XCTUnwrap(JSONSerialization.jsonObject(with: shortData) as? [String: Any])
        XCTAssertFalse(shortObj.keys.contains("bookId"))
        XCTAssertFalse(shortObj.keys.contains("chapterIdx"))

        // 旧文件（无 book 字段）解码兼容。
        XCTAssertEqual(try ReaderFileCodec.decode(Article.self, from: shortData).bookId, nil)
    }

    func testBooksFileAndBookFileRoundTrip() throws {
        var article = Article(
            id: "a1", title: "第一章", createdAt: 1, lastReadAt: 2,
            sentences: [SentencePair(idx: 0, paragraphIdx: 0, en: "Hello.")]
        )
        article.bookId = "b1"
        article.chapterIdx = 0
        let booksFile = BooksFile(books: [bookMetaFixture()])
        let bookFile = BookFile(articles: [article])
        XCTAssertEqual(try ReaderFileCodec.decode(BooksFile.self, from: try ReaderFileCodec.encode(booksFile)), booksFile)
        XCTAssertEqual(try ReaderFileCodec.decode(BookFile.self, from: try ReaderFileCodec.encode(bookFile)), bookFile)
    }

    func testBookChapterIndexAndOverallPercent() {
        var book = bookMetaFixture()
        // 断点在第 2 章（idx 1）40% → (1 + 0.4) / 2 = 70%。
        XCTAssertEqual(bookChapterIndexOf(book: book, chapterId: "a2"), 1)
        XCTAssertEqual(bookOverallPercent(book: book), 70)
        // 断点章不在目录 → 回落第 0 章（保留章内 percent，与 TS 公式一致）。
        book.progress.chapterId = "ghost"
        XCTAssertEqual(bookChapterIndexOf(book: book, chapterId: "ghost"), 0)
        XCTAssertEqual(bookOverallPercent(book: book), 20)  // (0 + 40/100) / 2 章
        // 空书 0%。
        book.chapters = []
        XCTAssertEqual(bookOverallPercent(book: book), 0)
    }
}
