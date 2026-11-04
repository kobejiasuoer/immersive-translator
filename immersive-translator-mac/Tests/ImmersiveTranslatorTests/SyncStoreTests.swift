import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 同步本地存储单测（对齐 Windows src-tauri/src/sync.rs tests：白名单路径守卫 /
// 游标默认 0 / 按 id 整体替换 / 原子写 / 版本不兼容文案 / 账号命名空间隔离）。
// ---------------------------------------------------------------------------

final class SyncStoreTests: XCTestCase {
    private var tmpDirs: [URL] = []

    override func tearDown() {
        for dir in tmpDirs {
            try? FileManager.default.removeItem(at: dir)
        }
        tmpDirs = []
        super.tearDown()
    }

    private func tempDir(_ label: String) -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("sync-store-tests-\(UUID().uuidString)-\(label)", isDirectory: true)
        tmpDirs.append(dir)
        return dir
    }

    private func entity(_ id: String, updatedAt: Int64, dirty: Bool) -> StoredSyncEntity {
        StoredSyncEntity(
            id: id,
            baseVersion: 0,
            updatedAt: updatedAt,
            deleted: false,
            schemaVersion: 1,
            originDevice: "mac",
            payload: ["title": "t"],
            dirty: dirty
        )
    }

    // MARK: 白名单（同时是文件路径守卫）

    func testLocalCollectionWhitelistGuardsPaths() {
        // LOCAL_COLLECTIONS 同时是文件名白名单：集合名直接进路径，
        // 白名单外（含路径穿越形态）必须拒绝。
        XCTAssertTrue(syncValidateCollection("speak-scenarios"))
        XCTAssertTrue(syncValidateCollection("speak-sessions"))
        XCTAssertTrue(syncValidateCollection("speak-assessments"))
        for collection in syncLocalCollections {
            XCTAssertTrue(syncValidateCollection(collection), collection)
        }
        for bad in ["../../etc/passwd", "unknown", "a/b", ""] {
            XCTAssertFalse(syncValidateCollection(bad), bad)
        }
        // 存储入口同样拒绝（Windows sync_collection_invalid 文案同款）
        let store = SyncStore(baseDirectory: tempDir("whitelist"))
        for bad in ["../../etc/passwd", "unknown", "a/b", ""] {
            XCTAssertThrowsError(try store.list(bad)) { error in
                XCTAssertEqual(
                    (error as? SyncStoreError)?.message,
                    "未知同步集合 \(bad)（本地白名单外）"
                )
            }
        }
    }

    /// Windows 十集合一个不少（历史/阅读文章/生词/笔记/术语表/设置/口语场景/
    /// 口语会话/口语评测/复习事件）。
    func testWhitelistMatchesWindowsTenCollections() {
        XCTAssertEqual(
            syncLocalCollections,
            [
                "history", "reading-articles", "reading-vocab", "notes", "glossary",
                "settings", "speak-scenarios", "speak-sessions", "speak-assessments",
                "review-events",
            ]
        )
    }

    // MARK: 命名空间

    /// 公式与输入都对齐 Windows：learning_store.rs account_namespace 的字节逐个 hex，
    /// 输入是 user.id（auth.rs:955 set_account(Some(&user.id))）而非邮箱；JSON 回退
    /// 与 SQLite 生产（LearningStore.accountNamespace）同源，只有一套命名空间。
    func testNamespaceFormulaMatchesWindowsAndUsesUserId() {
        XCTAssertEqual(syncNamespace(forUserId: nil), "guest")
        XCTAssertEqual(syncNamespace(forUserId: "u1"), "account-7531")
        XCTAssertEqual(syncNamespace(forUserId: "user-a"), "account-757365722d61")
        XCTAssertEqual(syncNamespace(forUserId: "u1"), LearningStore.accountNamespace("u1"), "与生产 SQLite 命名空间同源")
    }

    func testNamespaceIsolationAndSwitchVerification() throws {
        let store = SyncStore(baseDirectory: tempDir("namespace"))
        store.setAccount(userId: "user-a")
        try store.put("speak-sessions", [entity("s1", updatedAt: 100, dirty: true)])
        XCTAssertEqual(try store.list("speak-sessions").count, 1)

        // 切换账号：目录切换，另一账号看不到数据（不串）
        store.setAccount(userId: "user-b")
        XCTAssertEqual(try store.list("speak-sessions").count, 0)
        try store.cursorSet("speak-sessions", 9)
        XCTAssertEqual(try store.cursorGet("speak-sessions"), 9)
        XCTAssertEqual(try store.cursorGet("history"), 0)  // 其余集合游标默认 0

        // 切换后旧命名空间的操作按「账号已切换」取消（Windows verify_namespace 文案）
        XCTAssertThrowsError(
            try store.list("speak-sessions", expectedNamespace: "account-757365722d61")
        ) { error in
            XCTAssertEqual((error as? SyncStoreError)?.message, "账号已切换，本次操作已取消")
        }

        // 未登录（guest）与账号目录互不可见
        store.setAccount(userId: nil)
        XCTAssertEqual(try store.list("speak-sessions").count, 0)
    }

    // MARK: 实体序列化（camelCase 键与 Windows sync.rs 一字不差）

    func testEntitySerializationKeysAreCamelCaseAndOmitNilFields() throws {
        let json = entity("a", updatedAt: 1, dirty: true).jsonObject()
        let text = try XCTUnwrap(syncJSONStringify(json))
        XCTAssertTrue(text.contains("\"id\":\"a\""))
        XCTAssertTrue(text.contains("\"baseVersion\":0"))
        XCTAssertTrue(text.contains("\"updatedAt\":1"))
        XCTAssertTrue(text.contains("\"schemaVersion\":1"))
        XCTAssertTrue(text.contains("\"originDevice\":\"mac\""))
        XCTAssertTrue(text.contains("\"dirty\":true"))

        // nil 字段省略（serde skip_serializing_if 对应物）+ dirty 缺省 false 不落键
        let tombstone = StoredSyncEntity(
            id: "gone", baseVersion: 3, updatedAt: 5, deleted: true,
            schemaVersion: 2, originDevice: nil, payload: nil, dirty: false
        )
        let tombstoneJSON = tombstone.jsonObject()
        XCTAssertNil(tombstoneJSON["payload"])
        XCTAssertNil(tombstoneJSON["originDevice"])
        XCTAssertNil(tombstoneJSON["dirty"])
        let roundtrip = try XCTUnwrap(StoredSyncEntity.fromJSONObject(tombstoneJSON))
        XCTAssertTrue(roundtrip.deleted)
        XCTAssertNil(roundtrip.payload)
        XCTAssertFalse(roundtrip.dirty)
        XCTAssertEqual(roundtrip.baseVersion, 3)
    }

    // MARK: 存储原语

    func testMissingFilesAreEmptyAndCursorDefaultsZero() {
        let store = SyncStore(baseDirectory: tempDir("missing"))
        XCTAssertEqual(try store.cursorGet("speak-sessions"), 0)
        XCTAssertEqual(try store.list("speak-sessions").count, 0)
    }

    func testPutUpsertsByIdAndRoundtrips() throws {
        let store = SyncStore(baseDirectory: tempDir("upsert"))
        try store.put("speak-sessions", [
            entity("a", updatedAt: 100, dirty: true),
            entity("b", updatedAt: 200, dirty: false),
        ])
        // 同 id 覆盖（dirty 更新后的最终状态），新 id 追加
        try store.put("speak-sessions", [entity("a", updatedAt: 300, dirty: false)])
        try store.put("speak-sessions", [entity("c", updatedAt: 50, dirty: true)])

        let loaded = try store.list("speak-sessions")
        XCTAssertEqual(loaded.count, 3)
        let a = try XCTUnwrap(loaded.first { $0.id == "a" })
        XCTAssertEqual(a.updatedAt, 300)
        XCTAssertFalse(a.dirty)
        XCTAssertTrue(loaded.contains { $0.id == "c" })
        // list 契约：updatedAt 倒序
        XCTAssertEqual(loaded.map(\.id), ["a", "b", "c"])
    }

    func testCursorRoundtripPerCollection() throws {
        let store = SyncStore(baseDirectory: tempDir("cursors"))
        try store.cursorSet("speak-scenarios", 42)
        try store.cursorSet("speak-sessions", 7)
        XCTAssertEqual(try store.cursorGet("speak-scenarios"), 42)
        XCTAssertEqual(try store.cursorGet("speak-sessions"), 7)
        // 游标钳制 ≥0（Windows cursor.max(0) 同款）
        try store.cursorSet("speak-sessions", -5)
        XCTAssertEqual(try store.cursorGet("speak-sessions"), 0)
    }

    func testCorruptedFileErrorsInsteadOfClearing() throws {
        let store = SyncStore(baseDirectory: tempDir("corrupt"))
        let path = store.baseDirectory
            .appendingPathComponent("sync/guest/speak-sessions.json")
        try FileManager.default.createDirectory(
            at: path.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try "{not json".write(to: path, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try store.list("speak-sessions")) { error in
            XCTAssertTrue((error as? SyncStoreError)?.message.contains("同步数据损坏") == true)
        }
    }

    func testFutureSchemaVersionIsRejected() throws {
        let store = SyncStore(baseDirectory: tempDir("future"))
        let path = store.baseDirectory
            .appendingPathComponent("sync/guest/speak-sessions.json")
        try FileManager.default.createDirectory(
            at: path.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try #"{"schemaVersion":99,"entities":[]}"#.write(to: path, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try store.list("speak-sessions")) { error in
            XCTAssertEqual(
                (error as? SyncStoreError)?.message,
                "同步数据版本不兼容（文件 v99，应用 v1）。请升级应用后再打开。"
            )
        }
    }

    // MARK: 全量替换保留待推（dirty）实体（learning_store replace 同语义）

    func testReplaceRetainsPendingDirtyEdits() throws {
        let store = SyncStore(baseDirectory: tempDir("replace"))
        // 本地：e1 已同步干净、e2 待推（dirty）、e3 待推且服务端快照里没有
        try store.put("speak-sessions", [
            StoredSyncEntity(id: "e1", baseVersion: 2, updatedAt: 100, deleted: false,
                             schemaVersion: 2, originDevice: "mac", payload: ["v": 2], dirty: false),
            StoredSyncEntity(id: "e2", baseVersion: 0, updatedAt: 500, deleted: false,
                             schemaVersion: 2, originDevice: "mac", payload: ["v": 2, "local": 1], dirty: true),
            StoredSyncEntity(id: "e3", baseVersion: 0, updatedAt: 600, deleted: false,
                             schemaVersion: 2, originDevice: "mac", payload: ["v": 2, "only": 1], dirty: true),
        ])
        // 服务端全量快照：e1（新版本 8）、e2（服务端版 5）、全新 e4
        let snapshot = [
            StoredSyncEntity(id: "e1", baseVersion: 8, updatedAt: 200, deleted: false,
                             schemaVersion: 2, originDevice: nil, payload: ["v": 2, "server": 1], dirty: false),
            StoredSyncEntity(id: "e2", baseVersion: 5, updatedAt: 400, deleted: false,
                             schemaVersion: 2, originDevice: nil, payload: ["v": 2, "server": 2], dirty: false),
            StoredSyncEntity(id: "e4", baseVersion: 6, updatedAt: 700, deleted: false,
                             schemaVersion: 2, originDevice: nil, payload: ["v": 2], dirty: false),
        ]
        try store.replace("speak-sessions", snapshot, cursor: 11)

        let loaded = try store.list("speak-sessions")
        XCTAssertEqual(loaded.count, 4)  // e1 e4 来自快照 + e2 e3 待推保留
        let e1 = try XCTUnwrap(loaded.first { $0.id == "e1" })
        XCTAssertFalse(e1.dirty)
        XCTAssertEqual(e1.baseVersion, 8)
        // e2：本地 dirty 内容保留，吸收快照版本号（keptLocal 口径）
        let e2 = try XCTUnwrap(loaded.first { $0.id == "e2" })
        XCTAssertTrue(e2.dirty)
        XCTAssertEqual(e2.updatedAt, 500)
        XCTAssertEqual(e2.baseVersion, 5)
        XCTAssertTrue(syncJSONEqual(e2.payload, ["v": 2, "local": 1]))
        // e3：快照里没有 → 待推保留、baseVersion 归 0
        let e3 = try XCTUnwrap(loaded.first { $0.id == "e3" })
        XCTAssertTrue(e3.dirty)
        XCTAssertEqual(e3.baseVersion, 0)
        // 游标随 replace 推进
        XCTAssertEqual(try store.cursorGet("speak-sessions"), 11)
    }
}
