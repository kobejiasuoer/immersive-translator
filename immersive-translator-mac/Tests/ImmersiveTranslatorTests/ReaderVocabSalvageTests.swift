import XCTest
import ReaderCore
@testable import ImmersiveTranslator

/// 生词库中文词块标签抢救自愈（port-10，对齐 Windows 564b6c1 同名用例）：
/// 事故——v2 同步曾把前端 CHUNK_TYPE_LABELS 的中文展示名（「搭配/短语动词/习语/
/// 句式」）当 chunkType 传上云端，回灌后 ChunkType 枚举反序列化失败 → 整库读不出
/// → 加生词必失败、生词列表空白且到期数不显示。期望：可修复词保留（标签修回枚举值）、
/// 坏词剔除、读一次回写自愈；JSON 整体损坏报错，绝不静默清空。
final class ReaderVocabSalvageTests: XCTestCase {
    /// 临时目录 store（learning 未接线 = 纯文件 IO，不碰用户数据）。
    private func makeStore() throws -> (ReaderStore, URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("reader-vocab-salvage-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return (ReaderStore(baseDirectory: dir), dir)
    }

    private func write(_ text: String, to dir: URL) throws {
        try Data(text.utf8).write(to: dir.appendingPathComponent("reader_vocab.json"))
    }

    private let vocabJSON = """
    {
      "schemaVersion": 1,
      "reviewLog": { "schemaVersion": 1, "days": [{ "day": "2026-10-30", "count": 1 }] },
      "words": [
        {
          "id": "attribute-to", "word": "attribute X to Y", "kind": "chunk",
          "chunkType": "句式", "pattern": "attribute X to Y", "trap": "attribute for",
          "senses": [{ "pos": "pattern", "cn": "把 X 归因于 Y" }],
          "source": { "articleId": "trees", "sentenceIdx": 4 },
          "srs": { "ease": 2.5, "intervalDays": 0, "reps": 0, "dueAt": 9, "lapses": 0 },
          "addedAt": 0
        },
        {
          "id": "buffer-against", "word": "buffer against", "kind": "chunk",
          "chunkType": "搭配",
          "senses": [{ "pos": "collocation", "cn": "缓冲，抵御" }],
          "source": { "articleId": "trees", "sentenceIdx": 3 },
          "srs": { "ease": 2.5, "intervalDays": 0, "reps": 0, "dueAt": 9, "lapses": 0 },
          "addedAt": 0
        },
        {
          "id": "unmappable", "word": "garbage entry", "chunkType": "不认识的值",
          "senses": [{ "pos": "", "cn": "修不回来" }],
          "source": { "articleId": "", "sentenceIdx": 0 },
          "srs": { "ease": 2.5, "intervalDays": 0, "reps": 0, "dueAt": 9, "lapses": 0 },
          "addedAt": 0
        }
      ]
    }
    """

    /// 可修复词保留（标签修回枚举值）+ 坏词剔除 + 复习日志整体保留 + 二次读取自愈。
    func testChineseChunkLabelsSalvagedAndHealed() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try write(vocabJSON, to: dir)

        let file = try store.getVocabFile()
        XCTAssertEqual(file.words.count, 2, "两个可修复词保留，坏词剔除")
        XCTAssertEqual(file.words[0].chunkType, .pattern, "中文标签「句式」修回枚举值")
        XCTAssertEqual(file.words[1].chunkType, .collocation, "中文标签「搭配」修回枚举值")
        XCTAssertEqual(file.reviewLog.days.count, 1, "复习日志整体保留")

        // 二次读取自愈：首次读取已把修好的库回写，坏词不再出现。
        let again = try store.getVocabFile()
        XCTAssertEqual(again.words.count, 2)
        XCTAssertFalse(again.words.contains { $0.id == "unmappable" })
    }

    /// 整体坏 JSON 报错（绝不静默清空、不回写坏文件）。
    func testCorruptJSONReportsInsteadOfSilentClear() throws {
        let (store, dir) = try makeStore()
        defer { try? FileManager.default.removeItem(at: dir) }
        try write("{ not-json", to: dir)

        XCTAssertThrowsError(try store.getVocabFile(), "整体坏 JSON 必须报错")
        // 报错路径不回写：坏文件保持原样，后续 saveVocabWord 不会被空库覆盖。
        let raw = try String(contentsOf: dir.appendingPathComponent("reader_vocab.json"), encoding: .utf8)
        XCTAssertTrue(raw.contains("not-json"))
    }
}
