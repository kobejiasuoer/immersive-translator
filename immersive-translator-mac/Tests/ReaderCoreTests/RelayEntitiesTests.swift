import XCTest
@testable import ReaderCore

// ---------------------------------------------------------------------------
// 正文实体编解码单测（对齐 Windows src/core/learningRelay.test.ts
// 「learning relay immutable content」7 向量 + Rust utf16_revision_matches_typescript_fixture）。
// ---------------------------------------------------------------------------

final class RelayEntitiesTests: XCTestCase {
    private let article: JSONObject = [
        "id": "a", "title": "A", "createdAt": 1, "lastReadAt": 20,
        "progress": ["sentenceIdx": 1, "percent": 50, "secondsListened": 4],
        "sentences": [
            ["idx": 0, "paragraphIdx": 0, "en": "Hello 😀", "zh": NSNull(), "zhState": "pending"],
            ["idx": 1, "paragraphIdx": 0, "en": "World", "zh": "世界", "zhState": "done",
             "chunks": [["text": "World", "custom": ["level": 2]]]],
        ],
    ]

    private func kind(_ entity: RelayEntity) -> String? {
        LearningJSON.string(entity.payload["kind"])
    }

    func testRoundTripsChunksUnknownFieldsAndStableSentenceLocation() throws {
        let entities = try entitiesFromArticle(article, deviceId: "phone")
        let restored = try XCTUnwrap(articleFromEntities(id: "a", entities: entities))
        let sentences = try XCTUnwrap(restored["sentences"] as? [JSONObject])
        XCTAssertTrue(LearningJSON.equal(sentences[1]["chunks"], (article["sentences"] as! [JSONObject])[1]["chunks"]))
        XCTAssertTrue(LearningJSON.equal(restored["progress"], article["progress"]))
        XCTAssertEqual(LearningJSON.number(restored["lastReadAt"]), 20)
        XCTAssertEqual(LearningJSON.string(sentences[1]["id"]), "a:s1")
        // 三件套：chunk + manifest + progress，ID 规则逐字
        XCTAssertEqual(entities.map(kind), ["content-chunk", "article", "progress"])
        XCTAssertEqual(entities[1].id, "a")
        XCTAssertEqual(entities[2].id, "progress:a:phone")
        XCTAssertTrue(entities[0].id.hasPrefix("chunk:a:"))
        XCTAssertEqual(LearningJSON.string((entities[2].payload["locator"] as? JSONObject)?["sentenceId"]), "a:s1")
    }

    func testNeverMaterializesMissingContentChunks() throws {
        let entities = try entitiesFromArticle(article, deviceId: "phone")
        XCTAssertNil(articleFromEntities(id: "a", entities: entities.filter { kind($0) != "content-chunk" }))
        // 修订不符的 chunk 同样不落半成品
        var stale = entities
        stale[0].payload["contentRevision"] = "other"
        XCTAssertNil(articleFromEntities(id: "a", entities: stale))
        // tombstone 的 chunk 视为缺失
        var deleted = entities
        deleted[0].deleted = true
        XCTAssertNil(articleFromEntities(id: "a", entities: deleted))
    }

    func testTranslationAndAnnotationEditsCreateNewImmutableChunkIdentity() throws {
        let before = try entitiesFromArticle(article, deviceId: "phone")
        var edited = article
        edited["sentences"] = (article["sentences"] as! [JSONObject]).map { sentence -> JSONObject in
            var s = sentence
            s["zh"] = "新译文"
            s["zhState"] = "done"
            return s
        }
        let after = try entitiesFromArticle(edited, deviceId: "phone")
        XCTAssertNotEqual(before[0].id, after[0].id)
        XCTAssertTrue(LearningJSON.equal(before.last?.payload["locator"], after.last?.payload["locator"]))
    }

    func testCanonicalKeysAndUTF16EmojiHashingAreDeterministic() {
        let a: JSONObject = ["idx": 0, "paragraphIdx": 0, "en": "😀", "zh": NSNull(), "zhState": "pending"]
        let shuffled: JSONObject = ["zhState": "pending", "zh": NSNull(), "en": "😀", "paragraphIdx": 0, "idx": 0, "id": "derived"]
        XCTAssertEqual(contentRevision([a]), contentRevision([shuffled]))
        XCTAssertEqual(contentRevision([a]), "1mzjf0s")  // 与 TS / Rust 固定 fixture 锁死
        var changed = a
        changed["zh"] = "中文"
        XCTAssertNotEqual(contentRevision([a]), contentRevision([changed]))
    }

    func testDifferentChunkTargetsNeverReuseAnIDForDifferentPayloads() throws {
        var large = article
        large["sentences"] = (0..<20).map { idx -> JSONObject in
            ["idx": idx, "paragraphIdx": 0, "en": String(repeating: "x", count: 250), "zh": NSNull(), "zhState": "pending"]
        }
        let a = try entitiesFromArticle(large, deviceId: "a", targetBytes: 1024)
        let b = try entitiesFromArticle(large, deviceId: "b", targetBytes: 2048)
        XCTAssertGreaterThan(a.filter { kind($0) == "content-chunk" }.count, b.filter { kind($0) == "content-chunk" }.count)
        for entity in a where kind(entity) == "content-chunk" {
            if let duplicate = b.first(where: { $0.id == entity.id }) {
                XCTAssertTrue(LearningJSON.equal(duplicate.payload, entity.payload))
            }
        }
    }

    func testChunkLimitAndOptionGuards() {
        XCTAssertThrowsError(try entitiesFromArticle(article, deviceId: "")) {
            XCTAssertEqual($0 as? RelayError, .invalidOptions)
        }
        XCTAssertThrowsError(try entitiesFromArticle(article, deviceId: "d", targetBytes: 512)) {
            XCTAssertEqual($0 as? RelayError, .invalidOptions)
        }
        var huge = article
        huge["sentences"] = [["idx": 0, "paragraphIdx": 0, "en": String(repeating: "x", count: 2000), "zh": NSNull(), "zhState": "pending"]]
        XCTAssertThrowsError(try entitiesFromArticle(huge, deviceId: "d", targetBytes: 1024)) { error in
            XCTAssertEqual(error as? RelayError, .sentenceExceedsChunkLimit(0))
            XCTAssertEqual((error as? LocalizedError)?.errorDescription, "Sentence exceeds content chunk limit: 0")
        }
    }

    func testStripsActualAudioBytesButPreservesSourceDeviceReferences() {
        let input: JSONObject = ["task": ["attempts": [[
            "clipId": "clip", "deviceId": "phone", "wavB64": "bytes", "pcmB64": "bytes", "audioB64": "bytes",
            "feedback": ["message": "ok"],
        ]]]]
        let expected: JSONObject = ["task": ["attempts": [["clipId": "clip", "deviceId": "phone", "feedback": ["message": "ok"]]]]]
        XCTAssertTrue(LearningJSON.equal(withoutAudio(input), expected))
    }

    func testScrubsAudioBytesHiddenInLeafRegisterMetadata() {
        let input: JSONObject = [
            "clipId": "local",
            "fieldShadow": ["/audioB64": "secret", "/future/pcm": "secret", "/future/data": ["audio": "secret", "safe": true], "/clipId": "local"],
            "fieldUpdatedAt": ["/audioB64": 10, "/clipId": 10],
        ]
        let expected: JSONObject = [
            "clipId": "local",
            "fieldShadow": ["/future/data": ["safe": true], "/clipId": "local"],
            "fieldUpdatedAt": ["/clipId": 10],
        ]
        XCTAssertTrue(LearningJSON.equal(withoutAudio(input), expected), "\(withoutAudio(input) ?? "nil")")
    }

    func testLegacyProjectionsPreserveNestedUnknownTaskAndAttemptFields() {
        let merged = mergeRelayPayload(
            existing: ["task": ["source": ["articleId": "a"], "attempts": [["id": "t", "future": 1, "text": "old"]]]],
            incoming: ["task": ["attempts": [["id": "t", "text": "new"]]]]
        )
        let expected: JSONObject = ["task": ["source": ["articleId": "a"], "attempts": [["id": "t", "future": 1, "text": "new"]]]]
        XCTAssertTrue(LearningJSON.equal(merged, expected), "\(merged)")
    }
}
