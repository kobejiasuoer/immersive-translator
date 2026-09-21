import Foundation

/// docx 正文抽取：解 zip 读 word/document.xml，流式 XML 解析抽段落。
/// 对齐 mammoth extractRawText 的纯文本输出（段落间以空行分隔），
/// 后续交给 splitParagraphs 切段。不做排版还原，只保证句子流完整。

public enum DocxTextExtractor {
    /// 从 docx 文件字节抽正文段落文本；失败给中文可读原因。
    public static func extractText(data: Data) throws -> String {
        let archive: ZipArchive
        do {
            archive = try ZipArchive(data)
        } catch {
            throw FileImportError(
                "Word 解析失败：\((error as? LocalizedError)?.errorDescription ?? "\(error)")。请确认是 .docx（旧版 .doc 请先在 Word 里另存为 .docx）。"
            )
        }
        let xmlData: Data
        do {
            xmlData = try archive.readFile(named: "word/document.xml")
        } catch {
            throw FileImportError(
                "Word 解析失败：找不到正文（word/document.xml）。请确认是 .docx（旧版 .doc 请先在 Word 里另存为 .docx）。"
            )
        }
        let parser = DocxXMLParser()
        let delegate = XMLParser(data: xmlData)
        delegate.delegate = parser
        guard delegate.parse() else {
            throw FileImportError("Word 解析失败：\(delegate.parserError?.localizedDescription ?? "文档结构异常")。请确认文件未损坏。")
        }
        let text = parser.result.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            throw FileImportError("这个 Word 文档里没有抽到正文段落（可能只有图片/表格）。")
        }
        return text
    }
}

/// XMLParser 委托：w:p 结束 = 段落；w:t 文本累积；w:br / w:tab 折成空白。
private final class DocxXMLParser: NSObject, XMLParserDelegate {
    var result = ""
    private var paragraphText = ""
    private var inText = false

    func parser(
        _ parser: XMLParser,
        didStartElement elementName: String,
        namespaceURI: String?,
        qualifiedName qName: String?,
        attributes attributeDict: [String: String] = [:]
    ) {
        let name = elementName
        if name == "w:t" {
            inText = true
        } else if name == "w:br" || name == "w:cr" {
            paragraphText += "\n"
        } else if name == "w:tab" {
            paragraphText += "\t"
        }
    }

    func parser(
        _ parser: XMLParser,
        didEndElement elementName: String,
        namespaceURI: String?,
        qualifiedName qName: String?
    ) {
        if elementName == "w:t" {
            inText = false
        } else if elementName == "w:p" {
            let trimmed = paragraphText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                if !result.isEmpty { result += "\n\n" }
                result += trimmed
            }
            paragraphText = ""
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        if inText {
            paragraphText += string
        }
    }
}
