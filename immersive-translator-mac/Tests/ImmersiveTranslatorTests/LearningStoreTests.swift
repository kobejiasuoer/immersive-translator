import XCTest
@testable import ImmersiveTranslator
@testable import ReaderCore

// ---------------------------------------------------------------------------
// SQLite 权威学习存储单测（对齐 Windows learning_store.rs:1743-1928 的 14 向量 +
// adoptGuest 单向迁移 + commitReview 不可变冲突 + audio begin/append/finalize/read）。
// 每个用例独立临时目录 + 独立 LearningStore 实例（不碰真实应用数据）。
// ---------------------------------------------------------------------------

final class LearningStoreTests: XCTestCase {
    private var tmpDirs: [URL] = []

    override func tearDown() {
        for dir in tmpDirs {
            try? FileManager.default.removeItem(at: dir)
        }
        tmpDirs = []
        super.tearDown()
    }

    private func tempRoot(_ label: String) -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("learning-store-tests-\(UUID().uuidString)-\(label)", isDirectory: true)
        tmpDirs.append(dir)
        return dir
    }

    private func makeStore(_ label: String, user: String? = nil) -> LearningStore {
        let store = LearningStore(rootDirectory: tempRoot(label), center: NotificationCenter())
        store.setAccount(userId: user)
        return store
    }

    private func practiceFixture(_ at: Int64, _ attempts: [Any]) -> JSONObject {
        ["kind": "practice-task", "id": "task", "updatedAt": at, "task": ["id": "task", "updatedAt": at, "draft": "", "attempts": attempts]]
    }

    private func practiceEntity(payload: Any?, deleted: Bool, dirty: Bool) -> StoredSyncEntity {
        StoredSyncEntity(id: "task", baseVersion: 1, updatedAt: 20, deleted: deleted, schemaVersion: 2, originDevice: nil, payload: payload, dirty: dirty)
    }

    // MARK: 命名空间与路径安全（Rust account_names_are_isolated_and_path_safe）

    func testAccountNamesAreIsolatedAndPathSafe() throws {
        let store = makeStore("ns-a")
        store.setAccount(userId: "../a")
        let a = store.currentNamespace()
        store.setAccount(userId: "b")
        XCTAssertNotEqual(a, store.currentNamespace())
        XCTAssertFalse(a.contains("/"))
        XCTAssertEqual(a, "account-\(Data("../a".utf8).map { String(format: "%02x", $0) }.joined())")
        // expected 不符：文案逐字
        XCTAssertThrowsError(try store.verifyNamespace("account-beef")) { error in
            XCTAssertEqual((error as? LearningStoreError)?.message, "账号已切换，本次操作已取消")
        }
        XCTAssertNoThrow(try store.verifyNamespace(store.currentNamespace()))
        XCTAssertNoThrow(try store.verifyNamespace(nil))
    }

    func testGuestPathGuardRejectsLearningPrefix() throws {
        let store = makeStore("path-guard")
        let url = store.rootDirectory.appendingPathComponent("learning").appendingPathComponent("account-x").appendingPathComponent("x.json")
        XCTAssertThrowsError(try store.writePath(url, "{}")) { error in
            XCTAssertEqual((error as? LearningStoreError)?.message, "账号已切换，原学习路径的操作已取消")
        }
    }

    // MARK: 设备 ID（mac-<pid hex>-<now ms hex>，持久化只生成一次）

    func testDeviceIDFormatAndPersistence() throws {
        let store = makeStore("device")
        let id = try store.deviceId()
        XCTAssertTrue(id.hasPrefix("mac-"), id)
        let parts = id.dropFirst(4).split(separator: "-")
        XCTAssertEqual(parts.count, 2)
        XCTAssertNotNil(UInt64(parts[0], radix: 16))
        XCTAssertNotNil(UInt64(parts[1], radix: 16))
        XCTAssertEqual(try store.deviceId(), id)
        // 文件确实存在
        let persisted = try String(contentsOf: store.rootDirectory.appendingPathComponent("learning_device_id"), encoding: .utf8)
        XCTAssertEqual(persisted, id)
    }

    // MARK: schema 与 PRAGMA（files/entities/cursors/audio 两表；WAL + synchronous=FULL）

    func testSchemaAndPragmas() throws {
        let store = makeStore("schema")
        let db = try LearningSQLiteConnection(path: store.rootDirectory.appendingPathComponent("learning.sqlite3"))
        let journal = try db.scalar("PRAGMA journal_mode", [])
        XCTAssertEqual(journal as? String, "wal")
        let synchronous = try db.scalar("PRAGMA synchronous", [])
        XCTAssertEqual((synchronous as? Int64), 2)  // FULL = 2
        for table in ["files", "entities", "cursors", "audio_clips", "audio_chunks"] {
            let count = try db.scalar(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", [table]
            ) as? Int64
            XCTAssertEqual(count, 1, table)
        }
    }

    // MARK: 事务回滚（Rust failure_rolls_back_snapshot_and_outbox）

    func testFailureRollsBackSnapshotAndOutbox() throws {
        let root = tempRoot("rollback")
        let db = try LearningSQLiteConnection(path: root.appendingPathComponent("learning.sqlite3"))
        XCTAssertThrowsError(try db.transaction {
            try db.run("INSERT INTO files(namespace,path,content) VALUES('guest','x','{}')", [])
            try db.run("INSERT INTO entities(namespace,collection,id,body) VALUES('guest','notes','x','{}')", [])
            try db.run("INSERT INTO definitely_missing_table VALUES(1)", [])
        })
        XCTAssertEqual(try db.scalar("SELECT count(*) FROM files", []) as? Int64, 0)
        XCTAssertEqual(try db.scalar("SELECT count(*) FROM entities", []) as? Int64, 0)
    }

    // MARK: 未知字段保留（Rust unknown_fields_survive_legacy_writes）

    func testUnknownFieldsSurviveLegacyWrites() {
        let old: JSONObject = ["id": "x", "task": ["source": "reader"], "turns": [["id": "t", "audioDevice": "phone", "text": "old"]]]
        var next: JSONObject = ["id": "x", "turns": [["id": "t", "text": "new"]]]
        LearningStore.mergeUnknown(old, &next)
        XCTAssertEqual(LearningJSON.string(LearningJSON.object(next["task"])?["source"]), "reader")
        let turns = LearningJSON.array(next["turns"]) ?? []
        let row = LearningJSON.object(turns[0]) ?? [:]
        XCTAssertEqual(LearningJSON.string(row["audioDevice"]), "phone")
        XCTAssertEqual(LearningJSON.string(row["text"]), "new")
    }

    // MARK: 练习任务信封不被旧写回剥离（Rust legacy_session_retention…）

    func testLegacySessionRetentionNeverDeletesPracticeTasks() {
        let old: JSONObject = ["sessions": [["id": "practice", "kind": "practice-task", "task": ["draft": "saved", "attempts": [["id": "try", "feedback": ["message": "retained"]]]]]]]
        var next: JSONObject = ["sessions": [["id": "normal", "turns": [] as [Any]]]]
        LearningStore.preservePracticeTasks(old, &next)
        LearningStore.preservePracticeTasks(old, &next)
        let sessions = LearningJSON.array(next["sessions"]) ?? []
        XCTAssertEqual(sessions.count, 2)
        let practice = LearningJSON.object(LearningJSON.object(sessions[1])?["task"]) ?? [:]
        XCTAssertEqual(LearningJSON.string(practice["draft"]), "saved")
    }

    // MARK: practice 实体合并（Rust merge_practice_entity 向量）

    func testPracticeTransactionMergeMarksUnionDirtyAndAckClearsIt() {
        let local = practiceEntity(payload: practiceFixture(20, [["id": "windows"]]), deleted: false, dirty: true)
        var remote = practiceEntity(payload: practiceFixture(30, [["id": "phone"]]), deleted: false, dirty: false)
        remote.baseVersion = 8
        let merged = LearningStore.mergePracticeEntity(local, remote)!
        XCTAssertTrue(merged.dirty)
        XCTAssertEqual(merged.baseVersion, 8)
        let mergedTask = LearningJSON.object(LearningJSON.object(merged.payload ?? [:])?["task"]) ?? [:]
        let attempts = LearningJSON.array(mergedTask["attempts"]) ?? []
        XCTAssertEqual(attempts.count, 2)
        var accepted = merged
        accepted.dirty = false
        accepted.baseVersion = 9
        let ack = LearningStore.mergePracticeEntity(merged, accepted)!
        XCTAssertFalse(ack.dirty)
        XCTAssertEqual(ack.baseVersion, 9)
    }

    func testPracticeRemovalIDsAndEntityTombstonesPreventResurrection() {
        let live = practiceEntity(payload: practiceFixture(30, [["id": "cancelled", "clipId": "local"]]), deleted: false, dirty: true)
        var removed = practiceEntity(payload: nil, deleted: true, dirty: false)
        removed.baseVersion = 9
        XCTAssertTrue(LearningStore.mergePracticeEntity(live, removed)!.deleted)
        let restored = LearningStore.mergePracticeEntity(removed, live)!
        XCTAssertTrue(restored.deleted)
        XCTAssertTrue(restored.dirty)
        XCTAssertEqual(restored.baseVersion, 9)
    }

    // MARK: legacy 事件重放不改写不可变载荷（Rust legacy_events_replay…）

    func testLegacyEventsReplayWithoutModifyingImmutablePayloads() throws {
        let old: JSONObject = ["v": 2, "id": "old", "wordId": "w", "deviceId": "phone", "reviewedAt": 10, "kind": "grade", "grade": "good", "mode": "cloze", "recall": ["bucket": "pass"]]
        var word: JSONObject = [
            "id": "w", "addedAt": 1, "generation": "legacy-1",
            "baseline": ["ease": 2.5, "intervalDays": 0, "reps": 5, "lapses": 0, "dueAt": 0],
            "baselineRecall": ["total": ["pass": 4, "wrong": 2, "trap": 0], "byMode": [:] as JSONObject],
        ]
        LearningStore.reduceWord(&word, [old])
        XCTAssertEqual(LearningJSON.number(LearningJSON.object(word["srs"])?["reps"]), 6)
        XCTAssertEqual(LearningJSON.number(LearningJSON.object(LearningJSON.object(word["recall"])?["total"])?["pass"]), 5)
        let undo: JSONObject = ["id": "undo", "wordId": "w", "generation": "legacy-1", "reviewedAt": 20, "kind": "undo", "mode": "recognition", "reversesEventId": "old"]
        LearningStore.reduceWord(&word, [old, undo])
        XCTAssertEqual(LearningJSON.number(LearningJSON.object(word["srs"])?["reps"]), 5)
        XCTAssertEqual(LearningJSON.number(LearningJSON.object(LearningJSON.object(word["recall"])?["total"])?["pass"]), 4)
        word["generation"] = "new-generation"
        LearningStore.reduceWord(&word, [old])
        XCTAssertEqual(LearningJSON.number(LearningJSON.object(word["srs"])?["reps"]), 5)
        XCTAssertNil(old["generation"])  // 原事件 payload 不被改写
    }

    // MARK: 超大 session 完整入库不裁剪（Rust oversized_sessions_remain_whole…）

    func testOversizedSessionsRemainWholeInSnapshotAndOutbox() throws {
        let store = makeStore("oversize")
        let payload: JSONObject = ["sessions": [["id": "large", "createdAt": 1, "updatedAt": 2, "scenario": "practice", "difficulty": "medium", "turns": [["role": "user", "text": String(repeating: "x", count: 70000), "at": 2]]]]]
        try store.commit(store.rootDirectory.appendingPathComponent("reader_speak_sessions.json"), LearningJSON.stringify(payload))
        let rows = try store.list("speak-sessions")
        XCTAssertEqual(rows.count, 1)
        XCTAssertTrue(rows[0].dirty)
        let text = LearningJSON.string(
            LearningJSON.array(LearningJSON.object(rows[0].payload)?["turns"])?.first
                .flatMap { LearningJSON.object($0)?["text"] }
        )
        XCTAssertEqual(text?.count, 70000)
    }

    // MARK: commit 派生三件套 + 缺 chunk 沿用旧域文件 + tombstone

    func testCommitDerivesArticleEntitiesAndTombstonesRemovedWords() throws {
        let store = makeStore("derive")
        let articlesURL = store.rootDirectory.appendingPathComponent("reader_articles.json")
        let article: JSONObject = [
            "id": "a", "title": "A", "createdAt": 1, "lastReadAt": 20,
            "progress": ["sentenceIdx": 1, "percent": 50, "secondsListened": 4],
            "sentences": [
                ["idx": 0, "paragraphIdx": 0, "en": "Hello", "zh": NSNull(), "zhState": "pending"],
                ["idx": 1, "paragraphIdx": 0, "en": "World", "zh": "世界", "zhState": "done"],
            ],
        ]
        try store.commit(articlesURL, LearningJSON.stringify(["schemaVersion": 1, "articles": [article]]))
        let articleEntities = try store.list("reading-articles")
        XCTAssertEqual(
            Set(articleEntities.compactMap { LearningJSON.string(LearningJSON.object($0.payload)?["kind"]) }),
            Set(["content-chunk", "article", "progress"])
        )
        let manifest = articleEntities.first { LearningJSON.string(LearningJSON.object($0.payload)?["kind"]) == "article" }
        XCTAssertEqual(manifest?.id, "a")
        let progressID = "progress:a:\(try store.deviceId())"
        XCTAssertTrue(articleEntities.contains { $0.id == progressID })
        // 导出兼容文件已落盘（事务外导出）
        XCTAssertTrue(FileManager.default.fileExists(atPath: articlesURL.path))
        // 生词：ensure_baseline 注入 baseline / baselineRecall / generation
        let vocabURL = store.rootDirectory.appendingPathComponent("reader_vocab.json")
        try store.commit(vocabURL, LearningJSON.stringify(["schemaVersion": 1, "words": [["id": "w", "word": "word", "addedAt": 5, "srs": ["ease": 2.5, "intervalDays": 0, "reps": 0, "dueAt": 0, "lapses": 0]]]]))
        let vocab = try store.list("reading-vocab")
        XCTAssertEqual(vocab.count, 1)
        XCTAssertEqual(LearningJSON.string(LearningJSON.object(vocab[0].payload)?["generation"]), "legacy-5")
        XCTAssertNotNil(LearningJSON.object(vocab[0].payload)?["baseline"])
        XCTAssertNotNil(LearningJSON.object(vocab[0].payload)?["baselineRecall"])
        // 删词 → tombstone
        try store.commit(vocabURL, LearningJSON.stringify(["schemaVersion": 1, "words": [] as [Any]]))
        let rows = try store.list("reading-vocab")
        XCTAssertEqual(rows.count, 1)
        XCTAssertTrue(rows[0].deleted)
        XCTAssertTrue(rows[0].dirty)
        XCTAssertNil(rows[0].payload)
    }

    func testHydrateKeepsPreviousDomainFileWhenChunkMissing() throws {
        let store = makeStore("missing-chunk")
        let articlesURL = store.rootDirectory.appendingPathComponent("reader_articles.json")
        let oldArticle: JSONObject = [
            "id": "a", "title": "旧稿", "createdAt": 1, "lastReadAt": 20,
            "progress": ["sentenceIdx": 0, "percent": 0, "secondsListened": 0],
            "sentences": [["idx": 0, "paragraphIdx": 0, "en": "Old", "zh": NSNull(), "zhState": "pending"]],
        ]
        try store.commit(articlesURL, LearningJSON.stringify(["schemaVersion": 1, "articles": [oldArticle]]))
        // 拉下来的 manifest 引用缺失 chunk → hydrate 沿用旧域文件版本
        let manifest: JSONObject = [
            "v": 2, "kind": "article", "id": "a", "title": "新稿", "createdAt": 1, "lastReadAt": 30,
            "contentRevision": "rev", "chunkIds": ["chunk:a:rev:missing"] as [Any],
        ]
        try store.storePut("reading-articles", [
            StoredSyncEntity(id: "a", baseVersion: 2, updatedAt: 30, deleted: false, schemaVersion: 2, originDevice: "phone", payload: manifest, dirty: false),
        ])
        let text = try store.readPath(articlesURL)
        let file = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? JSONObject ?? [:]
        let articles = LearningJSON.array(file["articles"]) ?? []
        XCTAssertEqual(LearningJSON.string(LearningJSON.object(articles.first ?? [:])?["title"]), "旧稿")
    }

    // MARK: review-events 不可变冲突（put / commitReview 双侧）

    func testImmutableReviewEventConflicts() throws {
        let store = makeStore("immutable")
        let event: JSONObject = ["v": 2, "id": "e1", "wordId": "w", "deviceId": "mac", "reviewedAt": 10, "kind": "grade", "grade": "good", "mode": "cloze", "generation": "g"]
        try store.storePut("review-events", [
            StoredSyncEntity(id: "e1", baseVersion: 0, updatedAt: 10, deleted: false, schemaVersion: 2, originDevice: "mac", payload: event, dirty: true),
        ])
        // 同 ID 同内容幂等
        try store.storePut("review-events", [
            StoredSyncEntity(id: "e1", baseVersion: 0, updatedAt: 10, deleted: false, schemaVersion: 2, originDevice: "mac", payload: event, dirty: false),
        ])
        var changed = event
        changed["grade"] = "easy"
        XCTAssertThrowsError(try store.storePut("review-events", [
            StoredSyncEntity(id: "e1", baseVersion: 0, updatedAt: 10, deleted: false, schemaVersion: 2, originDevice: "mac", payload: changed, dirty: false),
        ])) { error in
            XCTAssertEqual((error as? LearningStoreError)?.message, "Immutable review event conflict")
        }
    }

    // MARK: commitReview（词快照 + 事件入队 + reviewLog 重建）

    private func seedVocab(_ store: LearningStore) throws {
        let vocabURL = store.rootDirectory.appendingPathComponent("reader_vocab.json")
        let word: JSONObject = [
            "id": "w", "word": "word", "addedAt": 1,
            "srs": ["ease": 2.5, "intervalDays": 0, "reps": 0, "dueAt": 0, "lapses": 0],
        ]
        try store.commit(vocabURL, LearningJSON.stringify(["schemaVersion": 1, "words": [word], "reviewLog": ["schemaVersion": 1, "days": [] as [Any]]]))
    }

    func testCommitReviewReducesWordAndRebuildsReviewLog() throws {
        let store = makeStore("commit-review")
        try seedVocab(store)
        let event: JSONObject = [
            "v": 2, "id": "ev1", "wordId": "w", "deviceId": try store.deviceId(), "reviewedAt": Int64(1_700_000_000_000),
            "day": "2026-11-01", "kind": "grade", "grade": "good", "mode": "cloze", "generation": "legacy-1", "recall": ["bucket": "pass"],
        ]
        let word: JSONObject = [
            "id": "w", "word": "word", "addedAt": 1, "generation": "legacy-1",
            "srs": ["ease": 2.5, "intervalDays": 0, "reps": 0, "dueAt": 0, "lapses": 0],
        ]
        let merged = try store.commitReview(word: word, event: event, expectedNamespace: store.currentNamespace())
        XCTAssertEqual(LearningJSON.number(LearningJSON.object(merged["srs"])?["reps"]), 1)
        XCTAssertEqual(LearningJSON.number(LearningJSON.object(LearningJSON.object(merged["recall"])?["total"])?["pass"]), 1)
        // reviewLog 由事件 day 重建
        let text = try store.readPath(store.rootDirectory.appendingPathComponent("reader_vocab.json"))
        let file = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? JSONObject ?? [:]
        let days = LearningJSON.array(LearningJSON.object(file["reviewLog"])?["days"]) ?? []
        XCTAssertEqual(LearningJSON.string(LearningJSON.object(days.first ?? [:])?["day"]), "2026-11-01")
        XCTAssertEqual(LearningJSON.number(LearningJSON.object(days.first ?? [:])?["count"]), 1)
        // baselineReviewLog 缺省迁移：原 reviewLog 保留
        XCTAssertNotNil(LearningJSON.object(file["baselineReviewLog"]))
        // 同 ID 同内容幂等；不同内容冲突
        let same = try store.commitReview(word: word, event: event, expectedNamespace: store.currentNamespace())
        XCTAssertEqual(LearningJSON.number(LearningJSON.object(same["srs"])?["reps"]), 1)
        var changed = event
        changed["grade"] = "easy"
        XCTAssertThrowsError(try store.commitReview(word: word, event: changed, expectedNamespace: store.currentNamespace())) { error in
            XCTAssertEqual((error as? LearningStoreError)?.message, "Immutable review event conflict")
        }
    }

    // MARK: adoptGuest 单向迁移（guest→账号；A→B 永不发生）

    func testAdoptGuestMovesGuestDataIntoAccountOnce() throws {
        let store = makeStore("adopt")
        try seedVocab(store)
        // 游客录音一段
        _ = try store.audio(action: "begin", clipId: "clip-1", metadata: ["taskId": "t"])
        try store.audio(action: "append", clipId: "clip-1", sequence: 0, data: Data([1, 2, 3, 4]).base64EncodedString())
        let account = "user-1"
        try store.adoptGuest(userId: account)
        store.setAccount(userId: account)
        let ns = LearningStore.accountNamespace(account)
        XCTAssertEqual(store.currentNamespace(), ns)
        // 词条进了账号命名空间且 dirty（待推送）
        let vocab = try store.list("reading-vocab", expectedNamespace: ns)
        XCTAssertEqual(vocab.count, 1)
        XCTAssertTrue(vocab[0].dirty)
        XCTAssertEqual(vocab[0].baseVersion, 0)
        // 游客实体已清空、录音划入账号
        store.setAccount(userId: nil)
        XCTAssertEqual(try store.list("reading-vocab").count, 0)
        store.setAccount(userId: account)
        _ = try store.audio(action: "read", clipId: "clip-1", expectedNamespace: ns)
        // 已登录后再次 adopt：非 guest 命名空间 → 无操作（绝不把 A 带入 B）
        try store.adoptGuest(userId: "user-2")
        store.setAccount(userId: "user-2")
        let other = try store.list("reading-vocab", expectedNamespace: LearningStore.accountNamespace("user-2"))
        XCTAssertEqual(other.count, 0)
    }

    // MARK: 本机录音（begin/append/finalize/read；WAV 头 16kHz/16bit/mono 精确）

    func testAudioLifecycleAndWAVHeader() throws {
        let store = makeStore("audio")
        let clipId = "clip-\(UUID().uuidString)"
        // clip id 边界
        XCTAssertThrowsError(try store.audio(action: "begin", clipId: "")) { XCTAssertEqual(($0 as? LearningStoreError)?.message, "Invalid clip id") }
        XCTAssertThrowsError(try store.audio(action: "begin", clipId: String(repeating: "x", count: 513))) { XCTAssertEqual(($0 as? LearningStoreError)?.message, "Invalid clip id") }
        _ = try store.audio(action: "begin", clipId: clipId, metadata: ["taskId": "t"])
        // metadata 冲突
        XCTAssertThrowsError(try store.audio(action: "begin", clipId: clipId, metadata: ["taskId": "other"])) { XCTAssertEqual(($0 as? LearningStoreError)?.message, "Clip id collision") }
        _ = try store.audio(action: "begin", clipId: clipId, metadata: ["taskId": "t"])  // 同 metadata 幂等
        // 无效分块：奇数字节
        XCTAssertThrowsError(try store.audio(action: "append", clipId: clipId, sequence: 0, data: Data([1, 2, 3]).base64EncodedString())) { XCTAssertEqual(($0 as? LearningStoreError)?.message, "Invalid audio chunk") }
        let pcm = Data([1, 2, 3, 4, 5, 6])
        let result = try store.audio(action: "append", clipId: clipId, sequence: 0, data: pcm.base64EncodedString()) as? JSONObject
        XCTAssertEqual(LearningJSON.number(result?["nextSequence"]), 1)
        // 同序号同字节重传 OK；不同字节冲突
        _ = try store.audio(action: "append", clipId: clipId, sequence: 0, data: pcm.base64EncodedString())
        XCTAssertThrowsError(try store.audio(action: "append", clipId: clipId, sequence: 0, data: Data([9, 9, 9, 9]).base64EncodedString())) { XCTAssertEqual(($0 as? LearningStoreError)?.message, "Audio sequence collision") }
        // 跳号拒绝
        XCTAssertThrowsError(try store.audio(action: "append", clipId: clipId, sequence: 5, data: Data([1, 2]).base64EncodedString()))
        // 20MiB 上限：1MiB × 20 成功，第 21 块拒绝
        let bigClip = "clip-big-\(UUID().uuidString)"
        _ = try store.audio(action: "begin", clipId: bigClip)
        let oneMiB = Data(count: 1_048_576)
        for index in 0..<20 {
            _ = try store.audio(action: "append", clipId: bigClip, sequence: Int64(index), data: oneMiB.base64EncodedString())
        }
        XCTAssertThrowsError(try store.audio(action: "append", clipId: bigClip, sequence: 20, data: Data([1, 2]).base64EncodedString())) { error in
            XCTAssertEqual((error as? LearningStoreError)?.message, "Recording exceeds 20 MiB")
        }
        // finalize + read：WAV 头逐字节断言
        let finalized = try store.audio(action: "finalize", clipId: clipId) as? JSONObject
        XCTAssertEqual(LearningJSON.string(finalized?["status"]), "ready")
        XCTAssertEqual(LearningJSON.number(finalized?["byteLength"]), Double(pcm.count))
        let read = try store.audio(action: "read", clipId: clipId) as? JSONObject
        let wav = Data(base64Encoded: LearningJSON.string(read?["wavB64"]) ?? "") ?? Data()
        func le32(_ offset: Int) -> UInt32 {
            let bytes = [UInt8](wav.subdata(in: offset..<offset + 4))
            return UInt32(bytes[0]) | UInt32(bytes[1]) << 8 | UInt32(bytes[2]) << 16 | UInt32(bytes[3]) << 24
        }
        XCTAssertEqual(String(data: wav.prefix(4), encoding: .ascii), "RIFF")
        XCTAssertEqual(String(data: wav.subdata(in: 8..<12), encoding: .ascii), "WAVE")
        XCTAssertEqual(String(data: wav.subdata(in: 12..<16), encoding: .ascii), "fmt ")
        XCTAssertEqual(le32(24), 16_000)  // 采样率
        XCTAssertEqual(le32(28), 32_000)  // 字节率 = 16k × 2
        XCTAssertEqual([UInt8](wav.subdata(in: 22..<24)), [1, 0])  // 单声道
        XCTAssertEqual([UInt8](wav.subdata(in: 34..<36)), [16, 0])  // 16bit
        XCTAssertEqual(LearningJSON.number(read?["durationMs"]), Double(Int64(pcm.count) * 1000 / 32000))  // 整数除法与 Rust 同口径
        XCTAssertEqual(Data(base64Encoded: LearningJSON.string(read?["pcmB64"]) ?? ""), pcm)
        // 跨命名空间读取
        store.setAccount(userId: "someone")
        XCTAssertThrowsError(try store.audio(action: "read", clipId: clipId)) { error in
            XCTAssertEqual((error as? LearningStoreError)?.message, "原录音仅保存在录制它的设备，这台设备没有原声")
        }
        // 空录音 read（clip 存在但没有任何 PCM 分块）
        let emptyClip = "clip-empty-\(UUID().uuidString)"
        _ = try store.audio(action: "begin", clipId: emptyClip)
        XCTAssertThrowsError(try store.audio(action: "read", clipId: emptyClip)) { error in
            XCTAssertEqual((error as? LearningStoreError)?.message, "没有录到有效声音，已保留当前记录")
        }
        // delete 后再 read：clip 行已删 →「原录音仅保存在录制它的设备…」
        _ = try store.audio(action: "delete", clipId: emptyClip)
        XCTAssertThrowsError(try store.audio(action: "read", clipId: emptyClip)) { error in
            XCTAssertEqual((error as? LearningStoreError)?.message, "原录音仅保存在录制它的设备，这台设备没有原声")
        }
    }

    // MARK: 兼容文件导出失败不回滚数据，仅发 learning-export-warning

    func testExportFailureKeepsDataAndEmitsWarning() throws {
        let store = makeStore("export-fail")
        try seedVocab(store)
        let center = NotificationCenter()
        var warnings: [String] = []
        let observer = center.addObserver(forName: .learningExportWarning, object: nil, queue: nil) { note in
            warnings.append(note.userInfo?["message"] as? String ?? "")
        }
        defer { center.removeObserver(observer) }
        // files 表已有该域文件的快照（hydrate 落的）；把导出用的 tmp 路径
        // （reader_vocab.learning.tmp）换成目录——commit 的读（files 表优先）
        // 与 derive 都成功，只有事务外导出的写失败。
        let exporting = LearningStore(rootDirectory: store.rootDirectory, center: center)
        let tmpPath = exporting.rootDirectory.appendingPathComponent("reader_vocab.learning.tmp")
        try FileManager.default.createDirectory(at: tmpPath, withIntermediateDirectories: true)
        let vocabURL = exporting.rootDirectory.appendingPathComponent("reader_vocab.json")
        try exporting.commit(
            vocabURL,
            LearningJSON.stringify(["schemaVersion": 1, "words": [["id": "w", "word": "word", "addedAt": 1, "srs": ["ease": 2.5, "intervalDays": 0, "reps": 0, "dueAt": 0, "lapses": 0]]], "reviewLog": ["schemaVersion": 1, "days": [] as [Any]]])
        )
        XCTAssertEqual(warnings, ["学习记录已保存，兼容文件导出失败，可稍后重试导出"])
        // 数据已入库（不回滚）
        let rows = try exporting.list("reading-vocab")
        XCTAssertEqual(rows.count, 1)
        let text = try exporting.readPath(vocabURL)
        XCTAssertTrue(text.contains("\"id\":\"w\""))
    }

    // MARK: 游标

    func testCursorRoundtripAndOnlyIncreases() throws {
        let store = makeStore("cursor")
        XCTAssertEqual(try store.cursorGet("reading-vocab"), 0)
        try store.storePut("reading-vocab", [], cursor: 7)
        XCTAssertEqual(try store.cursorGet("reading-vocab"), 7)
        try store.storePut("reading-vocab", [], cursor: max(0, -3))
        XCTAssertEqual(try store.cursorGet("reading-vocab"), 0)
    }
}

// MARK: - 修订复核补测（学习接力 1:1 差距逐条落位）

/// 写穿出口记录器（断言 SpeakStore 是否另行入队 / 发 tombstone）。
private final class RecordingSpeakOutbox: SpeakSyncOutbox {
    private(set) var enqueued: [String] = []
    private(set) var deleted: [String] = []
    func enqueueSessionRecordSilently(_ session: SpeakSession) { enqueued.append(session.id) }
    func deleteSessionRecordSilently(id: String) { deleted.append(id) }
}

extension LearningStoreTests {
    // MARK: projectArticle 侧 UTF-16 revision 固定 fixture（Rust utf16_revision_matches_typescript_fixture）

    func testUTF16RevisionMatchesTypeScriptFixtureThroughProjectArticle() throws {
        let store = makeStore("utf16-revision")
        let url = store.rootDirectory.appendingPathComponent("reader_articles.json")
        func manifestRevision(zh: Any) throws -> String? {
            let article: JSONObject = [
                "id": "a", "title": "A", "createdAt": 1, "lastReadAt": 0,
                "sentences": [["idx": 0, "paragraphIdx": 0, "en": "😀", "zh": zh, "zhState": "pending"] as JSONObject],
            ]
            try store.commit(url, LearningJSON.stringify(["schemaVersion": 1, "articles": [article]]))
            let manifest = try store.list("reading-articles").first { $0.id == "a" }
            return LearningJSON.string(LearningJSON.object(manifest?.payload)?["contentRevision"])
        }
        XCTAssertEqual(try manifestRevision(zh: NSNull()), "1mzjf0s")
        let changed = try XCTUnwrap(try manifestRevision(zh: "中文"))
        XCTAssertNotEqual(changed, "1mzjf0s")
        // chunk ID 带 revision：译文变化 → 新 chunk ID（同 ID 必同 payload）
        let chunkIds = try store.list("reading-articles").map(\.id).filter { $0.hasPrefix("chunk:a:") }
        XCTAssertTrue(chunkIds.contains { $0.hasPrefix("chunk:a:1mzjf0s:") }, "\(chunkIds)")
        XCTAssertTrue(chunkIds.contains { $0.hasPrefix("chunk:a:\(changed):") }, "\(chunkIds)")
    }

    // MARK: verify_path：原始路径含 `..` 一律拒绝（Rust components().any(ParentDir)）

    func testVerifyPathRejectsParentDirComponentEvenWhenResolvedInsideRoot() throws {
        let store = makeStore("parent-dir")
        let sneaky = store.rootDirectory
            .appendingPathComponent("notes")
            .appendingPathComponent("..")
            .appendingPathComponent("reader_vocab.json")
        XCTAssertTrue(sneaky.pathComponents.contains(".."), "前置：URL 未词法消解 `..`")
        XCTAssertThrowsError(try store.writePath(sneaky, "{}")) { error in
            XCTAssertEqual((error as? LearningStoreError)?.message, "账号已切换，原学习路径的操作已取消")
        }
        XCTAssertThrowsError(try store.readPath(sneaky)) { error in
            XCTAssertEqual((error as? LearningStoreError)?.message, "账号已切换，原学习路径的操作已取消")
        }
        // 同一文件走规范路径照常可写
        XCTAssertNoThrow(try store.writePath(
            store.rootDirectory.appendingPathComponent("reader_vocab.json"),
            "{\"schemaVersion\":1,\"words\":[]}"
        ))
    }

    // MARK: 设备 ID：文件在但为空 → "Empty device id"，不重新生成覆写（Rust :171）

    func testEmptyDeviceIdFileIsAnErrorAndIsNotRegenerated() throws {
        let store = makeStore("empty-device")
        try FileManager.default.createDirectory(at: store.rootDirectory, withIntermediateDirectories: true)
        let url = store.rootDirectory.appendingPathComponent("learning_device_id")
        try "  \n".write(to: url, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try store.deviceId()) { error in
            XCTAssertEqual((error as? LearningStoreError)?.message, "Empty device id")
        }
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "  \n", "空文件不得被覆写")
    }

    // MARK: migrate：旧 sync JSON 读/解析/实体解码失败一律中止（Rust :1722-1735）

    func testMigrateAbortsOnCorruptLegacySyncFileAndImportsValidOnes() throws {
        let store = makeStore("migrate-corrupt")
        let legacy = store.rootDirectory.appendingPathComponent("sync/guest", isDirectory: true)
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
        let notesFile = legacy.appendingPathComponent("notes.json")
        // ① JSON 解析失败 → 抛错（不再静默跳过）
        try "{not json".write(to: notesFile, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try store.migrate(expectedNamespace: "guest", legacySyncDirectory: legacy))
        // ② 实体行缺必需字段 → 抛错且整个事务回滚（同文件的合法行也不落库）
        let valid: JSONObject = [
            "id": "ok", "baseVersion": 3, "updatedAt": 10, "deleted": false, "schemaVersion": 2,
            "payload": ["v": 2] as JSONObject,
        ]
        try LearningJSON.stringify(["schemaVersion": 1, "entities": [valid, ["id": "broken"] as JSONObject]])
            .write(to: notesFile, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try store.migrate(expectedNamespace: "guest", legacySyncDirectory: legacy)) { error in
            XCTAssertEqual((error as? LearningStoreError)?.message, "旧同步数据 notes.json 含无法解析的实体，迁移已中止")
        }
        XCTAssertEqual(try store.list("notes").count, 0)
        // ③ 顶层不是对象 / 没有 entities 数组：跳过该集合，不是错误
        try "[]".write(to: notesFile, atomically: true, encoding: .utf8)
        XCTAssertNoThrow(try store.migrate(expectedNamespace: "guest", legacySyncDirectory: legacy))
        // ④ 全部合法 → 导入本地没有的实体
        try LearningJSON.stringify(["schemaVersion": 1, "entities": [valid]]).write(to: notesFile, atomically: true, encoding: .utf8)
        try store.migrate(expectedNamespace: "guest", legacySyncDirectory: legacy)
        XCTAssertEqual(try store.list("notes").map(\.id), ["ok"])
    }

    // MARK: reduceWord：baselineRecall 未知字段原样保留（Rust reduce_word Value clone）

    func testReduceWordKeepsUnknownBaselineRecallFields() throws {
        let baselineRecall: JSONObject = [
            "total": ["pass": 4, "wrong": 2, "trap": 0, "legacyNote": "kept"] as JSONObject,
            "byMode": ["cloze": ["pass": 1, "wrong": 0, "trap": 0, "extra": true] as JSONObject] as JSONObject,
            "importedFrom": "phone",
        ]
        var word: JSONObject = [
            "id": "w", "addedAt": 1, "generation": "legacy-1",
            "baseline": ["ease": 2.5, "intervalDays": 0, "reps": 0, "lapses": 0, "dueAt": 0] as JSONObject,
            "baselineRecall": baselineRecall,
        ]
        // 没有生效事件：recall 即 baselineRecall 原样
        LearningStore.reduceWord(&word, [])
        XCTAssertTrue(LearningJSON.equal(word["recall"], baselineRecall))
        let cloze: JSONObject = [
            "v": 2, "id": "e1", "wordId": "w", "deviceId": "mac", "reviewedAt": 50, "kind": "grade",
            "grade": "good", "mode": "cloze", "generation": "legacy-1", "recall": ["bucket": "pass"] as JSONObject,
        ]
        let dictation: JSONObject = [
            "v": 2, "id": "e2", "wordId": "w", "deviceId": "mac", "reviewedAt": 60, "kind": "grade",
            "grade": "forgot", "mode": "dictation", "generation": "legacy-1", "recall": ["bucket": "wrong"] as JSONObject,
        ]
        LearningStore.reduceWord(&word, [cloze, dictation])
        let recall = try XCTUnwrap(LearningJSON.object(word["recall"]))
        XCTAssertEqual(LearningJSON.string(recall["importedFrom"]), "phone")
        let total = try XCTUnwrap(LearningJSON.object(recall["total"]))
        XCTAssertEqual(LearningJSON.string(total["legacyNote"]), "kept")
        XCTAssertEqual(LearningJSON.number(total["pass"]), 5)
        XCTAssertEqual(LearningJSON.number(total["wrong"]), 3)
        let byMode = try XCTUnwrap(LearningJSON.object(recall["byMode"]))
        let clozeRow = try XCTUnwrap(LearningJSON.object(byMode["cloze"]))
        XCTAssertEqual(LearningJSON.bool(clozeRow["extra"]), true)
        XCTAssertEqual(LearningJSON.number(clozeRow["pass"]), 2)
        // 新 mode 行只写命中的桶（Rust 口径）；lastAt = 末个生效事件的 reviewedAt
        XCTAssertTrue(LearningJSON.equal(byMode["dictation"], ["wrong": 1] as JSONObject))
        XCTAssertEqual(LearningJSON.number(recall["lastAt"]), 60)
        // Mac 类型化解码缺键按 0（对齐 reader_store.rs RecallModeStat #[serde(default)]）
        let decoded = try JSONDecoder().decode(RecallStat.self, from: Data(LearningJSON.stringify(recall).utf8))
        XCTAssertEqual(decoded.byMode["dictation"], RecallModeStat(pass: 0, wrong: 1, trap: 0))
        XCTAssertEqual(decoded.total, RecallModeStat(pass: 5, wrong: 3, trap: 0))
    }

    // MARK: ReaderStore 复习提交（readerStore.ts:67 过滤非法事件 / :76 generation 缺失省略）

    private func relayVocabWord() -> VocabWord {
        VocabWord(
            id: "w", word: "word", source: VocabSource(articleId: "", sentenceIdx: 0),
            srs: VocabSrsState(ease: 2.5, intervalDays: 0, reps: 0, dueAt: 0, lapses: 0), addedAt: 5
        )
    }

    func testGradeVocabWordIgnoresMalformedStoredEvents() throws {
        let store = makeStore("grade-filter")
        let reader = ReaderStore(baseDirectory: store.rootDirectory, learning: store)
        let word = relayVocabWord()
        try reader.saveVocabWord(word)
        // 库里混进一条形状非法的事件（旧客户端写坏）：评分不得因此整体失败
        try store.storePut("review-events", [
            StoredSyncEntity(id: "bad", baseVersion: 1, updatedAt: 1, deleted: false, schemaVersion: 2,
                             originDevice: "phone", payload: ["v": 2, "id": "bad"] as JSONObject, dirty: false),
        ])
        let result = try reader.gradeVocabWord(word, grade: .good, mode: .recognition, bucket: .pass, now: 1_700_000_000_000)
        XCTAssertEqual(LearningJSON.number(LearningJSON.object(result.word["srs"])?["reps"]), 1)
        XCTAssertTrue(try store.list("review-events").contains { $0.id == result.eventId })
    }

    func testUndoReviewWordWithoutStoredGenerationOmitsKeyInsteadOfNull() throws {
        let store = makeStore("undo-no-generation")
        let reader = ReaderStore(baseDirectory: store.rootDirectory, learning: store)
        let word = relayVocabWord()
        try reader.saveVocabWord(word)
        let graded = try reader.gradeVocabWord(word, grade: .good, mode: .recognition, bucket: nil, now: 1_700_000_000_000)
        // 摘掉已存词条实体的 generation（readerStore.ts:76 `p.generation === undefined` 情形）
        let db = try LearningSQLiteConnection(path: store.rootDirectory.appendingPathComponent("learning.sqlite3"))
        let rows = try db.query("SELECT body FROM entities WHERE namespace='guest' AND collection='reading-vocab' AND id='w'", [])
        let raw = try XCTUnwrap((rows.first?.first ?? nil) as? String)
        var body = try XCTUnwrap((try JSONSerialization.jsonObject(with: Data(raw.utf8))) as? JSONObject)
        var payload = try XCTUnwrap(LearningJSON.object(body["payload"]))
        payload.removeValue(forKey: "generation")
        body["payload"] = payload
        try db.run(
            "UPDATE entities SET body=? WHERE namespace='guest' AND collection='reading-vocab' AND id='w'",
            [LearningJSON.stringify(body)]
        )
        let undone = try reader.undoReviewWord(word, eventId: graded.eventId, now: 1_700_000_001_000)
        XCTAssertEqual(LearningJSON.number(LearningJSON.object(undone["srs"])?["reps"]), 0, "撤销回到基线")
        let undoEvent = try XCTUnwrap(
            try store.list("review-events").compactMap { LearningJSON.object($0.payload) }
                .first { LearningJSON.string($0["kind"]) == "undo" }
        )
        XCTAssertTrue(LearningJSON.isUndefined(undoEvent["generation"]), "缺失即省略键，绝不写 null")
        XCTAssertTrue(isReviewEvent(undoEvent))
    }

    // MARK: SpeakStore 50 条滚动：practice-task 行绝不 tombstone（speak_store.rs truncate + commit）

    private func relaySpeakSession(_ id: String, at: Int64) -> SpeakSession {
        SpeakSession(
            id: id, scenario: "ordering", difficulty: .easy,
            turns: [SpeakTurn(role: .user, text: "hi \(id)", at: at)], createdAt: at, updatedAt: at
        )
    }

    func testSpeakRollingTrimNeverTombstonesPracticeTasks() throws {
        let store = makeStore("speak-trim")
        // 最旧的一行是练习接力任务（经 put → hydrate 投影进 reader_speak_sessions.json）
        let taskPayload: JSONObject = [
            "v": 2, "id": "task", "kind": "practice-task", "scenario": "practice", "difficulty": "medium",
            "turns": [] as [Any], "createdAt": 1, "updatedAt": 1, "startedAt": 1, "endedAt": 1,
            "task": [
                "id": "task", "title": "T", "mode": "word", "reference": "Hi", "step": 0, "draft": "",
                "status": "active", "createdAt": 1, "updatedAt": 1, "attempts": [] as [Any],
            ] as JSONObject,
        ]
        try store.storePut("speak-sessions", [
            StoredSyncEntity(id: "task", baseVersion: 4, updatedAt: 1, deleted: false, schemaVersion: 2,
                             originDevice: "phone", payload: taskPayload, dirty: false),
        ])
        let speak = SpeakStore(baseDirectory: store.rootDirectory, learning: store)
        let outbox = RecordingSpeakOutbox()
        speak.syncOutbox = outbox
        XCTAssertEqual(SpeakStore.sessionLimit, 50)
        for index in 0..<51 {
            try speak.saveSession(relaySpeakSession("s\(index)", at: Int64(100 + index)))
        }
        // 接线后 commit 是唯一写入方：前端不另行入队、不对裁剪 id 发 tombstone
        XCTAssertEqual(outbox.enqueued, [])
        XCTAssertEqual(outbox.deleted, [])
        let rows = try store.list("speak-sessions")
        let task = try XCTUnwrap(rows.first { $0.id == "task" })
        XCTAssertFalse(task.deleted, "50 条滚动裁剪不得删除练习任务")
        XCTAssertEqual(LearningJSON.string(LearningJSON.object(task.payload)?["kind"]), "practice-task")
        // preserve_practice_tasks + merge_unknown 后写回 files 表的域文件快照里，
        // 任务行的完整载荷（kind/task 字段）原样保留（Rust *body = to_string(next) 口径）
        let fileText = try store.readPath(store.rootDirectory.appendingPathComponent("reader_speak_sessions.json"))
        let fileTask = ((try JSONSerialization.jsonObject(with: Data(fileText.utf8))) as? JSONObject)
            .flatMap { LearningJSON.array($0["sessions"]) }?.compactMap { LearningJSON.object($0) }
            .first { LearningJSON.string($0["id"]) == "task" }
        XCTAssertEqual(LearningJSON.string(fileTask?["kind"]), "practice-task")
        XCTAssertNotNil(LearningJSON.object(fileTask?["task"]))
        // 被裁掉的最旧普通会话由 derive 转 tombstone（删除随同步传播）
        XCTAssertEqual(rows.first { $0.id == "s0" }?.deleted, true)
        XCTAssertEqual(rows.first { $0.id == "s50" }?.deleted, false)
        // 普通会话列表：50 条，练习任务不混入
        let listed = try speak.listSessions()
        XCTAssertEqual(listed.count, 50)
        XCTAssertFalse(listed.contains { $0.id == "task" })
    }

    func testSpeakStoreWithoutLearningKeepsOutboxWriteThrough() throws {
        let speak = SpeakStore(baseDirectory: tempRoot("speak-legacy"))
        let outbox = RecordingSpeakOutbox()
        speak.syncOutbox = outbox
        for index in 0..<51 {
            try speak.saveSession(relaySpeakSession("s\(index)", at: Int64(100 + index)))
        }
        XCTAssertEqual(outbox.enqueued.count, 51)
        XCTAssertEqual(outbox.deleted, ["s0"])
        XCTAssertTrue(try speak.deleteSession(id: "s1"))
        XCTAssertEqual(outbox.deleted, ["s0", "s1"])
    }

    // MARK: 笔记经 LearningStore（reader_store.rs note_* 经 write_path / read_path / list_paths / commit(None)）

    func testNoteStoreCommitsNotesEntityAndListsSyncedNotes() throws {
        let store = makeStore("notes")
        let notes = NoteStore(baseDirectory: store.rootDirectory, learning: store)
        let meta = try notes.save(
            baseName: "学词笔记-2026-11-02", content: "# 正文\n第二行",
            meta: NoteMeta(createdAt: 10, words: 2, wordIds: ["a", "b"])
        )
        XCTAssertEqual(meta.file, "学词笔记-2026-11-02.md")
        // 派生 notes 实体 {v:2,id,meta,content}（derive .md 分支）
        let entity = try XCTUnwrap(try store.list("notes").first { $0.id == meta.file })
        XCTAssertTrue(entity.dirty)
        let payload = try XCTUnwrap(LearningJSON.object(entity.payload))
        XCTAssertEqual(LearningJSON.number(payload["v"]), 2)
        XCTAssertEqual(LearningJSON.string(payload["id"]), meta.file)
        XCTAssertEqual(LearningJSON.string(payload["content"]), "# 正文\n第二行")
        XCTAssertEqual(LearningJSON.number(LearningJSON.object(payload["meta"])?["createdAt"]), 10)
        // 兼容 .md 已导出到磁盘
        let diskURL = store.rootDirectory.appendingPathComponent("notes").appendingPathComponent(meta.file)
        XCTAssertTrue(FileManager.default.fileExists(atPath: diskURL.path))
        // 他端同步来的笔记只落 files 表（hydrate），列表与读取同样可见
        try store.storePut("notes", [
            StoredSyncEntity(
                id: "remote.md", baseVersion: 7, updatedAt: 20, deleted: false, schemaVersion: 2, originDevice: "phone",
                payload: [
                    "v": 2, "id": "remote.md",
                    "meta": ["file": "remote.md", "createdAt": 20, "words": 1] as JSONObject,
                    "content": "来自手机",
                ] as JSONObject,
                dirty: false
            ),
        ])
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.rootDirectory.appendingPathComponent("notes/remote.md").path))
        XCTAssertEqual(try notes.list().map(\.file), ["remote.md", meta.file])
        XCTAssertEqual(try notes.read(file: "remote.md")?.content, "来自手机")
        // 同名不覆盖：files 表里已有的也算存在（dedup_note_path 以 read_path 判）
        let second = try notes.save(baseName: "remote", content: "x", meta: NoteMeta(createdAt: 30, words: 0))
        XCTAssertEqual(second.file, "remote-2.md")
        // 删除：commit(nil) → notes tombstone（dirty）+ 导出文件删除 + 列表剔除
        XCTAssertTrue(try notes.delete(file: meta.file))
        let tomb = try XCTUnwrap(try store.list("notes").first { $0.id == meta.file })
        XCTAssertTrue(tomb.deleted)
        XCTAssertTrue(tomb.dirty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: diskURL.path))
        XCTAssertFalse(try notes.list().contains { $0.file == meta.file })
        // 磁盘上不存在的（仅 files 表）删除返回 false（note_delete 的 path.exists 口径）
        XCTAssertFalse(try notes.delete(file: "remote.md"))
    }
}
