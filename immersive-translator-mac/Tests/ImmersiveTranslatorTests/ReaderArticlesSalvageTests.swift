import XCTest
import ReaderCore
@testable import ImmersiveTranslator

/// 文章库同步分块污染抢救自愈（对齐 Windows reader_store.rs
/// articles_file_polluted_by_sync_chunks_is_salvaged_and_healed /
/// fully_corrupt_articles_json_is_an_error_not_salvaged）：
/// 事故——v2 同步 hydrate 把缺 id 的 content-chunk 分块写进文章数组 → 整库解码失败
/// （keyNotFound "id" at articles[1]）→ 书架空、导入与打开文章必失败。期望：合法文章
/// 全部抢救、坏条目剔除、读一次回写自愈；JSON 整体损坏报错，绝不静默清空。
final class ReaderArticlesSalvageTests: XCTestCase {
    /// 临时目录 store（learning 未接线 = 纯文件 IO，不碰用户数据）。
    private func makeStore() throws -> (ReaderStore, URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("reader-articles-salvage-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return (ReaderStore(baseDirectory: dir), dir)
    }

    private func write(_ text: String, to dir: URL) throws {
        try Data(text.utf8).write(to: dir.appendingPathComponent("reader_articles.json"))
    }

    private func readRaw(_ dir: URL) throws -> String {
        try String(contentsOf: dir.appendingPathComponent("reader_articles.json"), encoding: .utf8)
    }

    /// 真实事故形状：合法文章 + 本文分块 + 孤儿分块（articleId 键控、无 id）。
    private let pollutedJSON = """
    {
      "schemaVersion": 1,
      "articles": [
        {
          "id": "a1", "title": "T", "titleCnState": "done", "sourceType": "paste",
          "wordCount": 1, "createdAt": 0, "lastReadAt": 0,
          "progress": { "sentenceIdx": 0, "percent": 0, "secondsListened": 0 },
          "sentences": [{ "idx": 0, "paragraphIdx": 0, "en": "Hi.", "zh": null, "zhState": "pending" }]
        },
        {
          "v": 2, "kind": "content-chunk", "articleId": "a1", "contentRevision": "125pf3a",
          "sentences": [{ "en": "Hi.", "id": "a1:s0", "idx": 0, "paragraphIdx": 0 }]
        },
        {
          "v": 2, "kind": "content-chunk", "articleId": "gone", "contentRevision": "x",
          "sentences": [{ "en": "Bye.", "id": "gone:s0", "idx": 0, "paragraphIdx": 0 }]
        }
      ]
    }
    """

    /// 合法文章抢救回来 + 分块剔除 + 读一次回写自愈。
    func testArticlesPollutedBySyncChunksSalvagedAndHealed() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try write(pollutedJSON, to: dir)

        XCTAssertEqual(try store.listArticles().map(\.id), ["a1"], "合法文章抢救回来，分块剔除")

        // 回写自愈：文件里不再有分块，整库可直接解码。
        let healed = try readRaw(dir)
        XCTAssertFalse(healed.contains("content-chunk"), healed)
        XCTAssertNoThrow(try ReaderFileCodec.decode(ArticlesFile.self, from: Data(healed.utf8)))
        XCTAssertEqual(try store.getArticle(id: "a1")?.sentences.count, 1)
    }

    /// 用户可见场景（导入失败 toast）：被污染的库上导入新文章必须成功，旧文章不丢。
    func testSaveArticleOnPollutedLibrarySucceedsAndKeepsGoodArticles() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try write(pollutedJSON, to: dir)

        XCTAssertNoThrow(try store.saveArticle(Article(id: "new", title: "News", createdAt: 1, lastReadAt: 1)))
        XCTAssertEqual(Set(try store.listArticles().map(\.id)), ["a1", "new"])
    }

    /// 整体坏 JSON 报错（绝不静默清空、不回写坏文件）。
    func testCorruptArticlesJSONReportsInsteadOfSilentClear() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        let broken = "{\"schemaVersion\":1,\"articles\":[{\"id\":"
        try write(broken, to: dir)

        XCTAssertThrowsError(try store.listArticles(), "整体坏 JSON 必须报错")
        // 保存同样报错且不回写：坏文件保持原样，不会被「空库 + 新文章」覆盖。
        XCTAssertThrowsError(try store.saveArticle(Article(id: "new", title: "N", createdAt: 1, lastReadAt: 1)))
        XCTAssertEqual(try readRaw(dir), broken)
    }
}
