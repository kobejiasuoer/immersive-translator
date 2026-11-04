import XCTest
@testable import ReaderCore

/// 官方口语场景目录缓存（official_speak_scenarios.json）：missing→空、roundtrip＋camelCase
/// （"schemaVersion":1 且无 schema_version）、corrupt 中文「损坏」、v99「版本不兼容」、
/// 非数组载荷拒绝、原子写无 .tmp 残留、空文件→空。对齐 Windows scenario_catalog.rs:143-233。
final class ScenarioCacheStoreTests: XCTestCase {
    private var tmpDirs: [URL] = []

    override func tearDown() {
        for dir in tmpDirs {
            try? FileManager.default.removeItem(at: dir)
        }
        tmpDirs = []
        super.tearDown()
    }

    private func makeStore() -> ScenarioCacheStore {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("scenario-cache-\(UUID().uuidString)", isDirectory: true)
        tmpDirs.append(dir)
        return ScenarioCacheStore(baseDirectory: dir)
    }

    func testMissingCacheFileIsEmpty() throws {
        let store = makeStore()
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.fileURL.path))
        XCTAssertTrue(try store.read().isEmpty)
    }

    func testEmptyFileIsEmpty() throws {
        let store = makeStore()
        try FileManager.default.createDirectory(at: store.baseDirectory, withIntermediateDirectories: true)
        try "  \n".write(to: store.fileURL, atomically: true, encoding: .utf8)
        XCTAssertTrue(try store.read().isEmpty)
    }

    func testRoundtripCamelCase() throws {
        let store = makeStore()
        let first: [String: Any] = ["id": "off_demo", "title": "点咖啡"]
        let second: [String: Any] = ["id": "off_travel", "source": "official"]
        let payload = String(decoding: try JSONSerialization.data(withJSONObject: [first, second]), as: UTF8.self)
        try store.write(scenariosJson: payload)

        let back = try store.read()
        XCTAssertEqual(back.count, 2)
        XCTAssertEqual((back[0] as? [String: Any])?["id"] as? String, "off_demo")
        XCTAssertEqual((back[0] as? [String: Any])?["title"] as? String, "点咖啡")
        XCTAssertEqual((back[1] as? [String: Any])?["source"] as? String, "official")
        // 文件名与顶层 schemaVersion 序列化为 camelCase
        XCTAssertEqual(store.fileURL.lastPathComponent, "official_speak_scenarios.json")
        let text = try String(contentsOf: store.fileURL, encoding: .utf8)
        XCTAssertTrue(text.contains("\"schemaVersion\":1"), text)
        XCTAssertFalse(text.contains("schema_version"), text)
        XCTAssertTrue(text.contains("\"scenarios\":["), text)
    }

    func testCorruptCacheIsError() throws {
        let store = makeStore()
        try FileManager.default.createDirectory(at: store.baseDirectory, withIntermediateDirectories: true)
        try "不是 JSON".write(to: store.fileURL, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try store.read()) { error in
            XCTAssertTrue("\(error.localizedDescription)".contains("损坏"), "\(error)")
            XCTAssertTrue("\(error.localizedDescription)".contains("官方口语场景缓存损坏"), "\(error)")
        }
    }

    func testVersionMismatchIsError() throws {
        let store = makeStore()
        try FileManager.default.createDirectory(at: store.baseDirectory, withIntermediateDirectories: true)
        try "{\"schemaVersion\":99,\"scenarios\":[]}".write(to: store.fileURL, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try store.read()) { error in
            let message = error.localizedDescription
            XCTAssertTrue(message.contains("版本不兼容"), message)
            XCTAssertTrue(message.contains("请升级应用后再打开"), message)
        }
    }

    func testWriteRejectsNonArrayPayload() throws {
        XCTAssertThrowsError(try ScenarioCacheStore.parseScenariosPayload("{\"a\":1}")) { error in
            XCTAssertTrue(error.localizedDescription.contains("JSON 数组"), "\(error)")
            XCTAssertEqual(error.localizedDescription, "场景目录载荷必须是 JSON 数组")
        }
        XCTAssertEqual(try ScenarioCacheStore.parseScenariosPayload("[{\"id\":\"off_demo\"}]").count, 1)
        XCTAssertTrue(try ScenarioCacheStore.parseScenariosPayload("[]").isEmpty)
        // 经 store.write 同样拒绝且不落文件
        let store = makeStore()
        XCTAssertThrowsError(try store.write(scenariosJson: "{\"a\":1}"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.fileURL.path))
    }

    func testWriteAtomicNoTmpLeftover() throws {
        let store = makeStore()
        let tmp = store.fileURL.appendingPathExtension("tmp")
        try store.write(scenariosJson: "[]")
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.fileURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: tmp.path), "写盘后不应残留 \(tmp.path)")
        XCTAssertTrue(try store.read().isEmpty)
        // 整体替换（全量快照，无合并）
        try store.write(scenariosJson: "[{\"id\":\"off_a\"}]")
        XCTAssertEqual(try store.read().count, 1)
        try store.write(scenariosJson: "[{\"id\":\"off_b\"}]")
        let back = try store.read()
        XCTAssertEqual(back.count, 1)
        XCTAssertEqual((back[0] as? [String: Any])?["id"] as? String, "off_b")
        XCTAssertFalse(FileManager.default.fileExists(atPath: tmp.path))
    }
}
