import Foundation
import ReaderCore
import SQLite3

// ---------------------------------------------------------------------------
// SQLite 权威学习存储（Windows src-tauri/src/learning_store.rs 的 Swift 等价实现）。
//
// 分层语义逐条对齐：
// - 域文件快照（files 表）与同步 outbox（entities 表）**单事务**提交；事务外
//   导出兼容 JSON 文件（先写 *.learning.tmp 再替换），导出失败只发
//   learning-export-warning 通知，数据不回滚。
// - 账号命名空间：`guest` / `account-<user.id 的 UTF-8 字节十六进制>`；expected
//   不符 → 「账号已切换，本次操作已取消」（同步引擎与鉴权层的第二道防线）。
// - commit 时从域文件 JSON 派生 outbox 实体（projectArticle / ensureBaseline /
//   enqueue / tombstone），旧客户端不认识的嵌套字段经 merge_unknown 保留；
//   put/replay 走 practice-task 字段时钟合并，删除优先（终态）。
// - 本机录音走 audio_clips / audio_chunks 两表（16k 单声道 PCM 分块），音频字节
//   永不进同步载荷；WAV 头 16kHz/16bit/mono 字节精确。
// - 平台差异：单进程直调（Rust 经 Tauri IPC），方法仍带 expectedNamespace 参数
//   并在入口校验，防线不减（规格 §4-12）；SQLite 经系统 SQLite3（零第三方依赖）。
// ---------------------------------------------------------------------------

/// 存储错误（一句话中文 message，与 Rust 端 Err(String) 同形）。
struct LearningStoreError: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }

    init(_ message: String) {
        self.message = message
    }
}

/// 域文件读取失败（NotFound 由调用方豁免——对齐 Rust io::ErrorKind::NotFound）。
struct LearningFileNotFoundError: Error {
    init() {}
}

// MARK: - 通知名（Windows Tauri/window CustomEvent 的 NotificationCenter 对应物）

extension Notification.Name {
    /// 兼容文件导出失败（数据已入库，仅提示可稍后重试导出）。
    static let learningExportWarning = Notification.Name("learning-export-warning")
    /// 一轮学习接力同步完成（userInfo["results"] = 本轮 [SyncSummary]，对齐
    /// learningRelay.ts CustomEvent detail: results）。
    static let learningSyncComplete = Notification.Name("learning-sync-complete")
    /// 练习接力列表行被点开（payload = 练习任务 JSON 字典）。
    static let practiceRelaySelect = Notification.Name("practice-relay-select")
    /// 「回到原文这句」（payload = {articleId, sentenceIdx}）。
    static let readerRelaySource = Notification.Name("reader-relay-source")
}

// MARK: - SQLite 连接（每次操作新开连接 + WAL + busy_timeout 5s，对齐 Rust）

final class LearningSQLiteConnection {
    private var handle: OpaquePointer?

    init(path: URL) throws {
        try? FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
        var pointer: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path.path, &pointer, flags, nil) == SQLITE_OK, let pointer else {
            let message = pointer.map { String(cString: sqlite3_errmsg($0)) } ?? "无法打开数据库"
            sqlite3_close(pointer)
            throw LearningStoreError("无法打开学习数据库 \(path.lastPathComponent): \(message)")
        }
        handle = pointer
        sqlite3_busy_timeout(pointer, 5_000)
        try execBatch(Self.schemaSQL)
    }

    deinit {
        if let handle { sqlite3_close(handle) }
    }

    /// 表结构逐表逐列对齐 learning_store.rs:133-138 与 :1466（音频两表按需建，
    /// 这里一并建上——IF NOT EXISTS 幂等）。
    static let schemaSQL = """
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS files(namespace TEXT NOT NULL,path TEXT NOT NULL,content TEXT,PRIMARY KEY(namespace,path));
    CREATE TABLE IF NOT EXISTS entities(namespace TEXT NOT NULL,collection TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(namespace,collection,id));
    CREATE TABLE IF NOT EXISTS cursors(namespace TEXT NOT NULL,collection TEXT NOT NULL,cursor INTEGER NOT NULL,PRIMARY KEY(namespace,collection));
    CREATE TABLE IF NOT EXISTS audio_clips(namespace TEXT NOT NULL,id TEXT NOT NULL,status TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(namespace,id));
    CREATE TABLE IF NOT EXISTS audio_chunks(namespace TEXT NOT NULL,id TEXT NOT NULL,sequence INTEGER NOT NULL,pcm BLOB NOT NULL,PRIMARY KEY(namespace,id,sequence));
    """

    func execBatch(_ sql: String) throws {
        var error: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(handle, sql, nil, nil, &error) == SQLITE_OK else {
            let message = error.map { String(cString: $0) } ?? "SQL 执行失败"
            if let error { sqlite3_free(error) }
            throw LearningStoreError(message)
        }
    }

    private func prepare(_ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw LearningStoreError(String(cString: sqlite3_errmsg(handle)))
        }
        return statement
    }

    private func bind(_ statement: OpaquePointer, _ params: [Any?]) throws {
        let transient = unsafeBitCast(OpaquePointer(bitPattern: -1), to: sqlite3_destructor_type.self)
        for (index, param) in params.enumerated() {
            let i = Int32(index + 1)
            if param == nil || (param.map { $0 is NSNull } ?? true) {
                sqlite3_bind_null(statement, i)
            } else if let text = param as? String {
                sqlite3_bind_text(statement, i, text, -1, transient)
            } else if let number = param as? Int64 {
                sqlite3_bind_int64(statement, i, number)
            } else if let number = param as? Int {
                sqlite3_bind_int64(statement, i, Int64(number))
            } else if let data = param as? Data {
                _ = data.withUnsafeBytes { buffer in
                    sqlite3_bind_blob(statement, i, buffer.baseAddress, Int32(buffer.count), transient)
                }
            } else if let number = param as? Double {
                sqlite3_bind_double(statement, i, number)
            } else {
                throw LearningStoreError("不支持的 SQLite 绑定类型: \(type(of: param))")
            }
        }
    }

    /// 写语句（INSERT/UPDATE/DELETE）。
    func run(_ sql: String, _ params: [Any?]) throws {
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        try bind(statement, params)
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw LearningStoreError(String(cString: sqlite3_errmsg(handle)))
        }
    }

    /// 查询：行 → 列值数组（String / Int64 / Data / nil）。
    func query(_ sql: String, _ params: [Any?]) throws -> [[Any?]] {
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        try bind(statement, params)
        var rows: [[Any?]] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            let count = sqlite3_column_count(statement)
            var row: [Any?] = []
            row.reserveCapacity(Int(count))
            for column in 0..<count {
                switch sqlite3_column_type(statement, column) {
                case SQLITE_TEXT:
                    row.append(String(cString: sqlite3_column_text(statement, column)))
                case SQLITE_INTEGER:
                    row.append(sqlite3_column_int64(statement, column))
                case SQLITE_BLOB:
                    if let bytes = sqlite3_column_blob(statement, column), let size = Int(exactly: sqlite3_column_bytes(statement, column)), size > 0 {
                        row.append(Data(bytes: bytes, count: size))
                    } else {
                        row.append(Data())
                    }
                case SQLITE_FLOAT:
                    row.append(sqlite3_column_double(statement, column))
                default:
                    row.append(nil)
                }
            }
            rows.append(row)
        }
        return rows
    }

    /// 标量查询首行首列。
    func scalar(_ sql: String, _ params: [Any?]) throws -> Any? {
        try query(sql, params).first?.first ?? nil
    }

    func transaction<T>(_ body: () throws -> T) throws -> T {
        try execBatch("BEGIN IMMEDIATE")
        do {
            let value = try body()
            try execBatch("COMMIT")
            return value
        } catch {
            try? execBatch("ROLLBACK")
            throw error
        }
    }
}

// MARK: - 存储器

/// SQLite 权威学习存储。线程安全：内部递归锁包裹全部操作（生产由
/// `LearningStore.shared` 单例持有；测试注入临时目录）。
final class LearningStore {
    /// 应用支持目录下的根（guest 域文件直接在根，账号域在 learning/<ns> 子目录）。
    let rootDirectory: URL
    /// 通知出口（生产 NotificationCenter.default；测试可注入以捕获导出警告）。
    let center: NotificationCenter
    /// 可注入时钟（Rust now() 的对应物）。
    var now: () -> Int64
    /// 设备 ID 前缀（平台差异 §4-2：Windows "windows"，Mac "mac"）。
    let devicePrefix = "mac"
    /// 数据库文件名（对齐 learning.sqlite3）。
    static let databaseFileName = "learning.sqlite3"
    static let deviceIDFileName = "learning_device_id"

    private let lock = NSRecursiveLock()
    private var accountNamespace: String = "guest"

    init(rootDirectory: URL? = nil, center: NotificationCenter = .default) {
        if let rootDirectory {
            self.rootDirectory = rootDirectory
        } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
            self.rootDirectory = base.appendingPathComponent("ImmersiveTranslator", isDirectory: true)
        }
        self.center = center
        self.now = { Int64(Date().timeIntervalSince1970 * 1000) }
    }

    public static let shared = LearningStore()

    // MARK: 账号命名空间（learning_store.rs:59-102）

    /// `account-<user.id 的 UTF-8 字节逐字节十六进制>`（与 Windows 同公式）。
    static func accountNamespace(_ user: String) -> String {
        "account-" + user.utf8.map { String(format: "%02x", $0) }.joined()
    }

    /// 登录态变化驱动命名空间切换（Rust set_account；user.id 非邮箱）。
    func setAccount(userId: String?) {
        lock.lock()
        defer { lock.unlock() }
        accountNamespace = userId.map(Self.accountNamespace) ?? "guest"
    }

    func currentNamespace() -> String {
        lock.lock()
        defer { lock.unlock() }
        return accountNamespace
    }

    /// 命名空间校验（Rust verify_namespace；失败文案逐字）。
    func verifyNamespace(_ expected: String?) throws {
        guard let expected, expected != currentNamespace() else { return }
        throw LearningStoreError("账号已切换，本次操作已取消")
    }

    // MARK: 路径（learning_store.rs:103-127）

    /// 当前命名空间的域数据目录（guest = 根，账号 = learning/<ns>）。
    func dataDirectory() throws -> URL {
        try dataDirectory(namespace: currentNamespace())
    }

    func dataDirectory(namespace: String) throws -> URL {
        let dir = namespace == "guest" ? rootDirectory : rootDirectory
            .appendingPathComponent("learning", isDirectory: true)
            .appendingPathComponent(namespace, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Mac 旧 JSON 同步布局的域目录：`<root>/sync/<namespace>`（与 SyncStore JSON
    /// 回退写入端同公式：guest 即 sync/guest，账号即 sync/account-<user.id hex>，
    /// 不是邮箱）。learning_migrate 的 legacy 导入段据此取旧数据；Windows 旧布局
    /// 是 sync/<collection>.json 平铺，与 Mac 不同，不能照抄 Windows 的目录拼接。
    func legacySyncDirectory(namespace: String) -> URL {
        rootDirectory
            .appendingPathComponent("sync", isDirectory: true)
            .appendingPathComponent(namespace, isDirectory: true)
    }

    /// 路径越界 / 含 `..` / guest 落 learning/ 前缀 → 拒绝（Rust verify_path）。
    func verifyPath(_ url: URL, namespace: String) throws {
        // Rust `path.components().any(ParentDir)` 不做词法归一：原始路径里出现任何
        // `..` 成分一律拒绝（root/a/../b 解析后虽仍在根内也拒）。必须在 standardized
        // 之前检查——标准化会把 `..` 消解掉。
        if url.pathComponents.contains("..") {
            throw LearningStoreError("账号已切换，原学习路径的操作已取消")
        }
        let root = try dataDirectory(namespace: namespace)
        let rootParts = root.standardizedFileURL.pathComponents
        let parts = url.standardizedFileURL.pathComponents
        guard parts.count >= rootParts.count, Array(parts.prefix(rootParts.count)) == rootParts else {
            throw LearningStoreError("账号已切换，原学习路径的操作已取消")
        }
        if namespace == "guest",
           parts.count > rootParts.count,
           parts[rootParts.count] == "learning" {
            throw LearningStoreError("账号已切换，原学习路径的操作已取消")
        }
    }

    // MARK: 设备 ID（learning_store.rs:163-179；平台差异 §4-2）

    /// `mac-<pid hex>-<now ms hex>`，持久化在 learning_device_id，只生成一次。
    /// 文件存在但内容为空 → 报错 "Empty device id"（不重新生成覆写，Rust :171）；
    /// 只有文件不存在才生成。
    func deviceId() throws -> String {
        let url = rootDirectory.appendingPathComponent(Self.deviceIDFileName)
        do {
            let existing = try String(contentsOf: url, encoding: .utf8)
            guard !existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw LearningStoreError("Empty device id")
            }
            return existing
        } catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError {
            // NotFound：首次生成（其余读错误原样抛出）
        }
        let id = "\(devicePrefix)-\(String(format: "%x", ProcessInfo.processInfo.processIdentifier))-\(String(format: "%x", now()))"
        try FileManager.default.createDirectory(at: rootDirectory, withIntermediateDirectories: true)
        try id.write(to: url, atomically: true, encoding: .utf8)
        return id
    }

    // MARK: SQLite 连接与实体行编解码

    private func connection() throws -> LearningSQLiteConnection {
        try LearningSQLiteConnection(path: rootDirectory.appendingPathComponent(Self.databaseFileName))
    }

    private func entityBody(_ entity: StoredSyncEntity) throws -> String {
        var object = entity.jsonObject()
        object["dirty"] = entity.dirty
        return LearningJSON.stringify(object)
    }

    private func decodeEntity(_ body: String) -> StoredSyncEntity? {
        guard let data = body.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? JSONObject else { return nil }
        return StoredSyncEntity.fromJSONObject(object)
    }

    private func putDB(_ db: LearningSQLiteConnection, _ ns: String, _ collection: String, _ entity: StoredSyncEntity) throws {
        try db.run(
            "INSERT INTO entities(namespace,collection,id,body) VALUES(?,?,?,?) ON CONFLICT(namespace,collection,id) DO UPDATE SET body=excluded.body",
            [ns, collection, entity.id, try entityBody(entity)]
        )
    }

    func listDB(_ db: LearningSQLiteConnection, _ ns: String, _ collection: String) throws -> [StoredSyncEntity] {
        try db.query("SELECT body FROM entities WHERE namespace=? AND collection=?", [ns, collection])
            .compactMap { row in (row.first ?? nil).flatMap { $0 as? String } }
            .compactMap { decodeEntity($0) }
    }

    private func snapshotDB(_ db: LearningSQLiteConnection, _ ns: String, _ url: URL, _ value: Any?) throws {
        try db.run(
            "INSERT INTO files(namespace,path,content) VALUES(?,?,?) ON CONFLICT(namespace,path) DO UPDATE SET content=excluded.content",
            [ns, url.path, value.map { LearningJSON.stringify($0) }]
        )
    }

    /// files 表读取（无行 → 兼容读盘；NULL content = 已删除 → nil）。
    func readFileDB(_ db: LearningSQLiteConnection, _ ns: String, _ url: URL) throws -> String? {
        let rows = try db.query("SELECT content FROM files WHERE namespace=? AND path=?", [ns, url.path])
        if let row = rows.first {
            return (row.first ?? nil) as? String
        }
        do {
            return try String(contentsOf: url, encoding: .utf8)
        } catch let error as NSError {
            // 只豁免文件不存在；其余读错误必须报出来（防下一次保存整体清库）。
            if error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError { return nil }
            throw error
        }
    }

    // MARK: 域文件读写入口（Rust read_path / write_path / list_paths 的对应物）

    /// 读域文件：先 files 表（命名空间内），无行回退磁盘；磁盘路径不做前缀强校验
    ///（Rust read_path 的 std::fs::read 兜底分支同口径——域文件始终由 commit 写出）。
    /// NotFound 抛 LearningFileNotFoundError（调用方豁免为空库）。
    func readPath(_ url: URL) throws -> String {
        lock.lock()
        defer { lock.unlock() }
        let ns = currentNamespace()
        try verifyPath(url, namespace: ns)
        let db = try connection()
        let rows = try db.query("SELECT content FROM files WHERE namespace=? AND path=?", [ns, url.path])
        if let row = rows.first {
            guard let content = (row.first ?? nil) as? String else { throw LearningFileNotFoundError() }
            return content
        }
        let hasDisk = FileManager.default.fileExists(atPath: url.path)
        if !hasDisk && url.deletingLastPathComponent().standardizedFileURL.path == (try? dataDirectory(namespace: ns))?.standardizedFileURL.path {
            // 根直下的域文件缺磁盘副本 = 该命名空间从未 commit 过它（Rust NotFound）
            throw LearningFileNotFoundError()
        }
        do {
            return try String(contentsOf: url, encoding: .utf8)
        } catch let error as NSError {
            // 只豁免文件不存在（NotFound → 调用方豁免为空库）；其余读错误必须报
            // 出来（对齐 readFileDB 同策略）：非 UTF-8（code=259）/ 无权限
            //（code=257）若也吞成 NotFound，消费方当空库、下一次保存整体清库。
            if error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError {
                throw LearningFileNotFoundError()
            }
            throw error
        }
    }

    /// 写域文件 = commit（派生 outbox + 导出兼容文件）。
    func writePath(_ url: URL, _ content: String) throws {
        try commit(url, content)
    }

    /// 在本存储互斥锁内执行调用方的一整段「读 → 改 → 写」（BUG-027）。
    /// readPath 与 commit 各自取锁、两者之间锁是放开的：同步 pull 的 storePut 事务
    ///（putTransaction → hydrate 重写域文件快照）可以插进来，随后 commit 拿拉取前读到的
    /// 旧稿经 mergeUnknown 覆盖刚拉下的 srs/recall（新稿已有标量胜出），derive 再以 now()
    /// 重新入队（dirty）推回云端。锁是 NSRecursiveLock：body 内再调 readPath / commit /
    /// list 属同线程重入，不死锁；body 只做本地读写，不得同步等待会反向争用本锁的线程/队列。
    func withExclusiveAccess<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    /// 列目录内的域文件（Rust list_paths：磁盘目录项 ∪ files 表里本命名空间、
    /// 父目录即 dir 的行；content 为 NULL 的行（已删除）从结果剔除）。同步拉下来
    /// 只落 files 表、尚未导出到磁盘的笔记也在列。按路径排序（BTreeSet 口径）。
    func listPaths(_ directory: URL) throws -> [URL] {
        lock.lock()
        defer { lock.unlock() }
        let ns = currentNamespace()
        try verifyPath(directory, namespace: ns)
        let db = try connection()
        let dirPath = directory.standardizedFileURL.path
        var result = Set<String>()
        if let entries = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            for entry in entries {
                result.insert(directory.appendingPathComponent(entry.lastPathComponent).path)
            }
        }
        for row in try db.query("SELECT path,content FROM files WHERE namespace=?", [ns]) {
            guard let path = (row.first ?? nil) as? String else { continue }
            let url = URL(fileURLWithPath: path)
            guard url.deletingLastPathComponent().standardizedFileURL.path == dirPath else { continue }
            if row.count > 1, (row[1] as? String) != nil {
                result.insert(path)
            } else {
                result.remove(path)
            }
        }
        return result.sorted().map { URL(fileURLWithPath: $0) }
    }

    // MARK: 同步原语（Rust list / put / cursor；sync_store_* 命令对应物）

    /// 列出集合全部本地实体（含 tombstone 与 dirty）。
    func list(_ collection: String, expectedNamespace: String? = nil) throws -> [StoredSyncEntity] {
        lock.lock()
        defer { lock.unlock() }
        try verifyNamespace(expectedNamespace)
        return try listDB(connection(), currentNamespace(), collection)
    }

    /// 读取集合游标（版本号；无记录 0 = 首次全量）。
    func cursorGet(_ collection: String, expectedNamespace: String? = nil) throws -> Int64 {
        lock.lock()
        defer { lock.unlock() }
        try verifyNamespace(expectedNamespace)
        let ns = currentNamespace()
        let db = try connection()
        if let value = try db.scalar("SELECT cursor FROM cursors WHERE namespace=? AND collection=?", [ns, collection]) as? Int64 {
            return value
        }
        return 0
    }

    /// 增量落实体（可选推进游标）。
    func storePut(
        _ collection: String,
        _ entities: [StoredSyncEntity],
        replace: Bool = false,
        cursor: Int64? = nil,
        expectedNamespace: String? = nil
    ) throws {
        lock.lock()
        defer { lock.unlock() }
        try verifyNamespace(expectedNamespace)
        let ns = currentNamespace()
        let db = try connection()
        try db.transaction { [self] in
            try self.putTransaction(db, ns, collection, entities, replace: replace, cursor: cursor)
        }
    }

    /// put 的单事务实现（Rust learning_store::put；游标只增，随后 hydrate）。
    private func putTransaction(
        _ db: LearningSQLiteConnection,
        _ ns: String,
        _ collection: String,
        _ entities: [StoredSyncEntity],
        replace: Bool,
        cursor: Int64?
    ) throws {
        let current = try listDB(db, ns, collection)
        let pending = replace ? current.filter(\.dirty) : []
        if replace {
            try db.run("DELETE FROM entities WHERE namespace=? AND collection=?", [ns, collection])
        }
        for incoming in entities {
            var next = incoming
            if let old = current.first(where: { $0.id == incoming.id }) {
                if collection == "review-events" && !LearningJSON.equal(old.payload, next.payload) {
                    throw LearningStoreError("Immutable review event conflict")
                }
                if collection == "speak-sessions", let merged = Self.mergePracticeEntity(old, next) {
                    next = merged
                } else if old.dirty && (old.updatedAt > next.updatedAt
                        || old.updatedAt == next.updatedAt && (!LearningJSON.equal(old.payload, next.payload) || old.deleted != next.deleted)) {
                    next = old
                    next.baseVersion = max(next.baseVersion, incoming.baseVersion)
                }
            }
            try putDB(db, ns, collection, next)
        }
        for var entity in pending {
            if let server = entities.first(where: { $0.id == entity.id }) {
                if collection == "speak-sessions" && Self.mergePracticeEntity(entity, server) != nil {
                    continue
                }
                entity.baseVersion = server.baseVersion
            } else {
                entity.baseVersion = 0
            }
            try putDB(db, ns, collection, entity)
        }
        if let cursor {
            try db.run(
                "INSERT INTO cursors(namespace,collection,cursor) VALUES(?,?,?) ON CONFLICT(namespace,collection) DO UPDATE SET cursor=excluded.cursor",
                [ns, collection, max(0, cursor)]
            )
        }
        if !entities.isEmpty || replace {
            try hydrate(db, namespace: ns, collection: collection)
        }
    }

    // MARK: 不可变复习事件提交（Rust learning_commit_review :1595-1660）

    /// 校验 + 归并 + 单事务提交（词快照 + reading-vocab 入队 + review-events 入队 +
    /// hydrateReviews）。返回归并后的词条 JSON（调用方用于刷新内存态）。
    func commitReview(word: JSONObject, event: JSONObject, expectedNamespace: String?) throws -> JSONObject {
        lock.lock()
        defer { lock.unlock() }
        try verifyNamespace(expectedNamespace)
        let ns = currentNamespace()
        let device = try deviceId()
        guard let id = LearningJSON.string(word["id"]), !id.isEmpty,
              let eventId = LearningJSON.string(event["id"]), !eventId.isEmpty else {
            throw LearningStoreError("Invalid review event")
        }
        guard LearningJSON.number(event["v"]) == 2, LearningJSON.string(event["wordId"]) == id else {
            throw LearningStoreError("Invalid review event")
        }
        let path = try dataDirectory().appendingPathComponent("reader_vocab.json")
        let db = try connection()
        guard let raw = try readFileDB(db, ns, path),
              var file = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? JSONObject,
              var words = file["words"] as? [JSONObject] else {
            throw LearningStoreError("Vocabulary not found")
        }
        guard let position = words.firstIndex(where: { $0["id"] as? String == id }) else {
            throw LearningStoreError("Word no longer exists")
        }
        if let existing = try listDB(db, ns, "review-events").first(where: { $0.id == eventId }) {
            if let payload = existing.payload, LearningJSON.equal(payload, event) {
                return words[position]  // 同内容幂等
            }
            throw LearningStoreError("Immutable review event conflict")
        }
        var next = word
        Self.mergeUnknown(words[position], &next)
        Self.ensureBaseline(&next)
        var events = try listDB(db, ns, "review-events")
            .filter { !$0.deleted }
            .compactMap { LearningJSON.object($0.payload) }.compactMap { $0 }
        events.append(event)
        Self.reduceWord(&next, events)
        words[position] = next
        file["words"] = words
        try db.transaction { [self] in
            try self.snapshotDB(db, ns, path, file)
            try self.enqueueDB(db, ns, "reading-vocab", id: id, payload: next, updatedAt: now(), device: device)
            try self.enqueueDB(db, ns, "review-events", id: eventId, payload: event, updatedAt: now(), device: device)
            try self.hydrateReviews(db, namespace: ns)
        }
        return next
    }

    // MARK: 迁移（Rust learning_migrate :1661-1742）

    /// 迁移完成哨兵行（files 表 path 值）：相对路径永不可能与域文件 url.path
    ///（绝对路径）冲突；content 恒 NULL——adoptGuest 只搬 content 非空的行、
    /// listPaths 只认父目录匹配的行，哨兵行不会被当作域文件。随库共存亡：删
    /// learning.sqlite3 重建后哨兵消失，迁移可重跑。
    private static let migrateMarkerPath = "__learning_migrated__"

    /// 把既有 4 个域 JSON + books/notes 目录逐个 commit 入库；再导入旧 sync/
    /// 目录 JSON 里本地没有的实体。`legacySyncDirectory` 为 Mac 旧 JSON 同步目录
    ///（`sync/<legacyNamespace>`；nil 则按当轮命名空间取 `sync/<ns>`，与
    /// legacySyncDirectory(namespace:) 同公式）。成功完成即落哨兵行，同命名空间
    /// 后续调用短路早退（SQLite 权威后域 JSON 只是 commit 的导出物，盘上不会再
    /// 有新数据源），避免每轮启动/登录全量重推导。
    func migrate(expectedNamespace: String?, legacySyncDirectory: URL? = nil) throws {
        try verifyNamespace(expectedNamespace)
        let initialNamespace = currentNamespace()
        let dir = try dataDirectory()
        let db = try connection()
        // 已迁移短路：哨兵行在 = 本命名空间已完整迁移。全量推导（JSON 解析 +
        // 全集合扫描 + 磁盘重导出）成本随库体积增长，不能每轮启动/登录重付。
        let marker = try db.query("SELECT 1 FROM files WHERE namespace=? AND path=?", [initialNamespace, Self.migrateMarkerPath])
        guard marker.isEmpty else { return }
        for name in ["reader_articles.json", "reader_books.json", "reader_vocab.json", "reader_speak_sessions.json"] {
            let url = dir.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            do {
                let text = try readPath(url)
                try commit(url, text)
            } catch is LearningFileNotFoundError {
                continue
            }
        }
        for sub in ["books", "notes"] {
            let folder = dir.appendingPathComponent(sub, isDirectory: true)
            guard let entries = try? FileManager.default.contentsOfDirectory(
                at: folder, includingPropertiesForKeys: [.isDirectoryKey]
            ) else { continue }
            for url in entries where (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == false {
                do {
                    let text = try readPath(url)
                    try commit(url, text)
                } catch is LearningFileNotFoundError {
                    continue
                }
            }
        }
        lock.lock()
        defer { lock.unlock() }
        try verifyNamespace(initialNamespace)
        let ns = currentNamespace()
        let folder = legacySyncDirectory ?? self.legacySyncDirectory(namespace: ns)
        try db.transaction { [self] in
            for collection in Self.collections {
                let url = folder.appendingPathComponent("\(collection).json")
                // learning_store.rs:1722-1735：只有文件不存在才跳过；读失败 / JSON 解析
                // 失败 / 实体行解码失败一律报错中止 migrate（整个事务回滚，不吞坏数据）。
                guard FileManager.default.fileExists(atPath: url.path) else { continue }
                let raw = try String(contentsOf: url, encoding: .utf8)
                let value = try JSONSerialization.jsonObject(with: Data(raw.utf8), options: [.fragmentsAllowed])
                // 顶层不是对象或缺 entities 数组：Rust `value.get("entities").and_then(as_array)`
                // 为 None，跳过该集合（不是错误）。
                guard let rows = (value as? [String: Any])?["entities"] as? [Any] else { continue }
                let existing = try self.listDB(db, ns, collection)
                for row in rows {
                    guard let object = row as? [String: Any], let entity = StoredSyncEntity.fromJSONObject(object) else {
                        throw LearningStoreError("旧同步数据 \(collection).json 含无法解析的实体，迁移已中止")
                    }
                    if !existing.contains(where: { $0.id == entity.id }) {
                        try self.putDB(db, ns, collection, entity)
                    }
                }
            }
            // 与 legacy 导入同一事务落哨兵：中途失败整体回滚，下轮重新迁移。
            try db.run(
                "INSERT INTO files(namespace,path,content) VALUES(?,?,NULL) ON CONFLICT(namespace,path) DO NOTHING",
                [ns, Self.migrateMarkerPath]
            )
        }
    }

    // MARK: 后台执行（Windows 的 migrate/adopt_guest 跑在 Tauri 命令线程；Mac
    // 调用方在 MainActor，大库时全量推导会卡 UI——专用串行队列挪出去执行。串行
    // 队列同时复刻 Rust 全局 Mutex 的整段互斥语义：并发迁移/并入不交错提交）。

    private static let workQueue = DispatchQueue(
        label: "local.immersive-translator.learning-store.work", qos: .userInitiated
    )

    private func runOffMain<T>(_ work: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            Self.workQueue.async { [self] in
                do {
                    continuation.resume(returning: try work())
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// migrate 的后台包装（学习接力每轮触发用；await 返回后再继续同步）。
    func migrateOffMain(expectedNamespace: String?, legacySyncDirectory: URL? = nil) async throws {
        try await runOffMain { try self.migrate(expectedNamespace: expectedNamespace, legacySyncDirectory: legacySyncDirectory) }
    }

    /// adoptGuest 的后台包装（登录成功收尾用；Rust after_login_success 的
    /// adopt_guest 同样在命令线程执行）。
    func adoptGuestOffMain(userId: String) async throws {
        try await runOffMain { try self.adoptGuest(userId: userId) }
    }

    /// 本地集合白名单（sync.rs LOCAL_COLLECTIONS 同名）。
    static let collections = [
        "history", "reading-articles", "reading-vocab", "notes", "glossary", "settings",
        "speak-scenarios", "speak-sessions", "speak-assessments", "review-events",
    ]

    // MARK: 域文件 → outbox 派生（Rust merge_unknown / preserve_practice_tasks / derive）

    /// 未知字段保留合并（Rust merge_unknown：旧对象逐键——新稿已有键则递归
    ///（标量保留新值），缺失键补旧值；数组按 id/idx 对位递归）。
    static func mergeUnknown(_ old: Any?, _ next: inout JSONObject) {
        guard let previous = LearningJSON.object(old) else { return }
        for (key, value) in previous {
            guard let existing = LearningJSON.unwrap(next[key]) else {
                next[key] = value  // 新稿没有的键：补旧值
                continue
            }
            if var child = LearningJSON.object(existing) {
                mergeUnknown(value, &child)
                next[key] = child
            } else if var rows = LearningJSON.array(existing) {
                mergeUnknownRows(value, &rows)
                next[key] = rows
            }
            // 其余标量：新值保留（对齐 Rust `if let Some(n) = b.get_mut(k)` 分支）
        }
    }

    /// 数组版未知字段合并（derive / commit 内部使用）。
    static func mergeUnknownRows(_ old: Any?, _ next: inout [Any]) {
        guard let oldArray = LearningJSON.array(old) else { return }
        for index in next.indices {
            guard let row = LearningJSON.object(next[index]),
                  let match = oldArray.first(where: { candidate in
                      guard let prior = LearningJSON.object(candidate) else { return false }
                      if !LearningJSON.isUndefined(prior["id"]), LearningJSON.equal(prior["id"], row["id"]) { return true }
                      return !LearningJSON.isUndefined(prior["idx"]) && LearningJSON.equal(prior["idx"], row["idx"])
                  }),
                  var merged = LearningJSON.object(row) else { continue }
            mergeUnknown(match, &merged)
            next[index] = merged
        }
    }

    /// 练习任务信封永不因旧客户端写回被剥离（Rust preserve_practice_tasks）。
    static func preservePracticeTasks(_ old: Any?, _ next: inout JSONObject) {
        guard let before = LearningJSON.array(LearningJSON.object(old)?["sessions"]),
              let after = LearningJSON.array(next["sessions"]) else { return }
        var rows = after
        for task in before
        where LearningJSON.string(LearningJSON.object(task)?["kind"]) == "practice-task" {
            let id = LearningJSON.object(task)?["id"]
            let exists = rows.contains { LearningJSON.equal(LearningJSON.object($0)?["id"], id) }
            if !exists { rows.append(task) }
        }
        next["sessions"] = rows
    }

    /// 词条补齐迁移基线：baseline ← 当前 srs、baselineRecall ← 当前 recall、
    /// generation ← `legacy-<addedAt||createdAt||0>`（Rust ensure_baseline）。
    static func ensureBaseline(_ word: inout JSONObject) {
        if LearningJSON.isUndefined(word["baseline"]) {
            word["baseline"] = LearningJSON.object(word["srs"])
                ?? ["ease": 2.5, "intervalDays": 0, "reps": 0, "lapses": 0, "dueAt": 0]
        }
        if LearningJSON.isUndefined(word["baselineRecall"]) {
            word["baselineRecall"] = LearningJSON.object(word["recall"])
                ?? ["total": ["pass": 0, "wrong": 0, "trap": 0], "byMode": [:] as JSONObject]
        }
        if LearningJSON.isUndefined(word["generation"]) {
            let addedAt = LearningJSON.int64(word["addedAt"])
                ?? LearningJSON.int64(word["createdAt"])
                ?? 0
            word["generation"] = "legacy-\(addedAt)"
        }
    }

    /// 代际匹配：相等，或一侧缺失且另一侧是 legacy-（Rust generations_match）。
    static func generationsMatch(_ a: Any?, _ b: Any?) -> Bool {
        if LearningJSON.equal(a, b) { return true }
        if LearningJSON.isUndefined(a), let text = LearningJSON.string(b) { return text.hasPrefix("legacy-") }
        if LearningJSON.isUndefined(b), let text = LearningJSON.string(a) { return text.hasPrefix("legacy-") }
        return false
    }

    /// 生效事件（Rust active_events：reviewedAt/id 排序 → 逆向禁用 undo/supersede
    /// 目标 → 同根并发改评只留 winner → 时间序）。与 ReaderCore.activeReviewEvents
    /// 同算法，这里面向原始事件集合（未预过滤）。
    static func activeEvents(_ events: [JSONObject]) -> [JSONObject] {
        let sorted = events.sorted { a, b in
            let ta = LearningJSON.int64(a["reviewedAt"]) ?? Int64.min
            let tb = LearningJSON.int64(b["reviewedAt"]) ?? Int64.min
            if ta != tb { return ta < tb }
            return (LearningJSON.string(a["id"]) ?? "") < (LearningJSON.string(b["id"]) ?? "")
        }
        var disabled = Set<String>()
        var index = sorted.count - 1
        while index >= 0 {
            let event = sorted[index]
            let id = LearningJSON.string(event["id"]) ?? ""
            if !disabled.contains(id) {
                let kind = LearningJSON.string(event["kind"])
                if let target = LearningJSON.string(event[kind == "undo" ? "reversesEventId" : "supersedesEventId"]) {
                    let matches = sorted[0..<index].contains { prior in
                        LearningJSON.string(prior["id"]) == target
                            && LearningJSON.string(prior["kind"]) == "grade"
                            && LearningJSON.equal(prior["wordId"], event["wordId"])
                            && generationsMatch(prior["generation"], event["generation"])
                    }
                    if matches { disabled.insert(target) }
                }
            }
            index -= 1
        }
        var roots: [String: String] = [:]
        var winners: [String: JSONObject] = [:]
        for event in sorted {
            guard LearningJSON.string(event["kind"]) == "grade" else { continue }
            let id = LearningJSON.string(event["id"]) ?? ""
            let root = LearningJSON.string(event["supersedesEventId"]).flatMap { roots[$0] } ?? id
            roots[id] = root
            if !disabled.contains(id) {
                winners[root] = event
            }
        }
        return winners.values.sorted { a, b in
            let ta = LearningJSON.int64(a["reviewedAt"]) ?? 0
            let tb = LearningJSON.int64(b["reviewedAt"]) ?? 0
            if ta != tb { return ta < tb }
            return (LearningJSON.string(a["id"]) ?? "") < (LearningJSON.string(b["id"]) ?? "")
        }
    }

    /// 逐词四档演进并回写 srs / recall（Rust reduce_word；常量与 srs.ts 逐值一致）。
    /// recall 按 Rust 的 Value clone 口径以 JSON 字典原地演进：baselineRecall 里旧
    /// 客户端/他端写入的未知字段（顶层与 total / byMode 行内）原样保留，只对命中的
    /// 桶 +1、刷新 lastAt；没有生效事件时 recall 即 baselineRecall 原样。
    static func reduceWord(_ word: inout JSONObject, _ events: [JSONObject]) {
        ensureBaseline(&word)
        let generation = word["generation"]
        var srs = VocabSrsState(json: word["baseline"])
        var recall = LearningJSON.object(word["baselineRecall"])
            ?? ["total": ["pass": 0, "wrong": 0, "trap": 0], "byMode": [:] as JSONObject]
        let selected = events.filter { event in
            LearningJSON.equal(event["wordId"], word["id"])
                && generationsMatch(event["generation"], generation)
        }
        for event in activeEvents(selected) {
            guard let gradeName = LearningJSON.string(event["grade"]), let grade = ReviewGrade(rawValue: gradeName) else { continue }
            let reviewedAt = LearningJSON.int64(event["reviewedAt"]) ?? 0
            srs = gradeSrs(srs, grade, now: reviewedAt)
            if let bucket = LearningJSON.string(LearningJSON.object(event["recall"])?["bucket"]),
               ["pass", "wrong", "trap"].contains(bucket),
               let mode = LearningJSON.string(event["mode"]) {
                var total = LearningJSON.object(recall["total"]) ?? [:]
                total[bucket] = (LearningJSON.int64(total[bucket]) ?? 0) + 1
                recall["total"] = total
                var byMode = LearningJSON.object(recall["byMode"]) ?? [:]
                var counts = LearningJSON.object(byMode[mode]) ?? [:]
                counts[bucket] = (LearningJSON.int64(counts[bucket]) ?? 0) + 1
                byMode[mode] = counts
                recall["byMode"] = byMode
                // Rust `recall["lastAt"] = event["reviewedAt"].clone()`
                recall["lastAt"] = LearningJSON.unwrap(event["reviewedAt"]) ?? NSNull()
            }
        }
        var srsDict = LearningJSON.object(word["baseline"]) ?? [:]
        srsDict["ease"] = srs.ease
        srsDict["intervalDays"] = srs.intervalDays
        srsDict["reps"] = srs.reps
        srsDict["lapses"] = srs.lapses
        srsDict["dueAt"] = srs.dueAt
        word["srs"] = srsDict
        word["recall"] = recall
    }

    // MARK: outbox 入队 / tombstone（Rust enqueue / tombstone :1056-1116）

    private func enqueueDB(
        _ db: LearningSQLiteConnection, _ ns: String, _ collection: String,
        id: String, payload: JSONObject, updatedAt: Int64, device: String
    ) throws {
        let old = try listDB(db, ns, collection).first { $0.id == id }
        var next = payload
        if let previous = old?.payload {
            Self.mergeUnknown(previous, &next)
        }
        if let old, !old.deleted, let previous = old.payload, LearningJSON.equal(previous, next) {
            return  // 内容未变不重排时钟
        }
        let entity = StoredSyncEntity(
            id: id,
            baseVersion: old?.baseVersion ?? 0,
            updatedAt: max(updatedAt, (old.map { $0.updatedAt + 1 }) ?? 0),
            deleted: false,
            schemaVersion: 2,
            originDevice: device,
            payload: next,
            dirty: true
        )
        try putDB(db, ns, collection, entity)
    }

    private func tombstoneDB(_ db: LearningSQLiteConnection, _ ns: String, _ collection: String, id: String, device: String) throws {
        var entity = try listDB(db, ns, collection).first { $0.id == id }
            ?? StoredSyncEntity(id: id, baseVersion: 0, updatedAt: 0, deleted: false, schemaVersion: 2, originDevice: nil, payload: nil, dirty: true)
        entity.deleted = true
        entity.payload = nil
        entity.updatedAt = max(now(), entity.updatedAt + 1)
        entity.dirty = true
        entity.originDevice = device
        try putDB(db, ns, collection, entity)
    }

    // MARK: 文章投影（Rust project_article :1191-1271）

    private func projectArticle(_ db: LearningSQLiteConnection, _ ns: String, _ article: JSONObject, device: String) throws {
        guard let id = LearningJSON.string(article["id"]), !id.isEmpty else {
            throw LearningStoreError("article id")
        }
        guard let sentences = LearningJSON.array(article["sentences"]) else {
            throw LearningStoreError("article sentences")
        }
        var sentenceRows: [JSONObject] = sentences.compactMap { LearningJSON.object($0) }
        let revision = contentRevision(sentenceRows)
        var chunks: [String] = []
        var batch: [JSONObject] = []
        func flush() throws {
            guard !batch.isEmpty else { return }
            let chunkID = "chunk:\(id):\(revision):\(relayRevisionOf(batch))"
            try enqueueDB(
                db, ns, "reading-articles", id: chunkID,
                payload: ["v": 2, "kind": "content-chunk", "articleId": id, "contentRevision": revision, "sentences": batch],
                updatedAt: now(), device: device
            )
            chunks.append(chunkID)
            batch = []
        }
        for sentence in sentenceRows {
            var row = withoutAudioObject(sentence)
            let idx = Int(LearningJSON.number(sentence["idx"]) ?? Double(batch.count))
            if LearningJSON.isUndefined(row["id"]) {
                row["id"] = "\(id):s\(idx)"
            }
            if !batch.isEmpty, LearningJSON.byteCount(batch) + LearningJSON.byteCount(row) > relayDefaultChunkTargetBytes {
                try flush()
            }
            if LearningJSON.byteCount(row) > relayDefaultChunkTargetBytes {
                throw LearningStoreError("Single sentence exceeds sync chunk limit")
            }
            batch.append(row)
        }
        try flush()
        var manifest = withoutAudioObject(article)
        manifest.removeValue(forKey: "sentences")
        manifest.removeValue(forKey: "progress")
        manifest["v"] = 2
        manifest["kind"] = "article"
        manifest["contentRevision"] = revision
        manifest["chunkIds"] = chunks
        try enqueueDB(db, ns, "reading-articles", id: id, payload: manifest, updatedAt: now(), device: device)
        let progressSource = LearningJSON.object(article["progress"]) ?? [:]
        let idx = Int(LearningJSON.number(progressSource["sentenceIdx"]) ?? 0)
        let last = LearningJSON.int64(article["lastReadAt"]) ?? 0
        var progress = progressSource
        progress["v"] = 2
        progress["kind"] = "progress"
        progress["articleId"] = id
        progress["deviceId"] = device
        progress["contentRevision"] = revision
        progress["locator"] = [
            "sentenceId": (idx >= 0 && idx < sentenceRows.count
                ? LearningJSON.string(sentenceRows[idx]["id"]).flatMap { $0.isEmpty ? nil : $0 } : nil)
                ?? "\(id):s\(idx)",
        ]
        progress["lastReadAt"] = last
        try enqueueDB(db, ns, "reading-articles", id: "progress:\(id):\(device)", payload: progress, updatedAt: last, device: device)
    }

    // MARK: derive（Rust derive :1272-1386）

    private func derive(
        _ db: LearningSQLiteConnection, _ ns: String, _ url: URL,
        old: String?, content: String?, device: String
    ) throws {
        let name = url.lastPathComponent
        let before = old.flatMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? JSONObject } ?? [:]
        let value = content.flatMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? JSONObject } ?? [:]
        if let articles = LearningJSON.array(value["articles"]) {
            for raw in articles {
                guard let article = LearningJSON.object(raw) else { continue }
                try projectArticle(db, ns, article, device: device)
            }
        }
        if let words = LearningJSON.array(value["words"]) {
            for raw in words {
                guard var word = LearningJSON.object(raw), let id = LearningJSON.string(word["id"]), !id.isEmpty else { continue }
                Self.ensureBaseline(&word)
                try enqueueDB(db, ns, "reading-vocab", id: id, payload: word, updatedAt: now(), device: device)
            }
        }
        if let books = LearningJSON.array(value["books"]) {
            for raw in books {
                guard var book = LearningJSON.object(raw), let id = LearningJSON.string(book["id"]), !id.isEmpty else { continue }
                book["v"] = 2
                book["kind"] = "book"
                book["contentRevision"] = "book-\(LearningJSON.int64(book["createdAt"]) ?? 0)"
                if var chapters = LearningJSON.array(book["chapters"]) {
                    for index in chapters.indices {
                        guard var chapter = LearningJSON.object(chapters[index]) else { continue }
                        chapter["articleId"] = LearningJSON.isUndefined(chapter["id"]) ? NSNull() : chapter["id"]!
                        chapters[index] = chapter
                    }
                    book["chapters"] = chapters
                }
                try enqueueDB(db, ns, "reading-articles", id: id, payload: book, updatedAt: now(), device: device)
            }
        }
        if let sessions = LearningJSON.array(value["sessions"]) {
            for raw in sessions {
                guard let original = LearningJSON.object(raw), let id = LearningJSON.string(original["id"]), !id.isEmpty else { continue }
                // 完整快照与 pending 实体一起入库；同步引擎报告超限但不阻止本地保存、不裁剪尝试。
                var payload = withoutAudioObject(original)
                payload["v"] = 2
                payload["startedAt"] = LearningJSON.isUndefined(original["createdAt"]) ? 0 : original["createdAt"]!
                payload["endedAt"] = LearningJSON.isUndefined(original["updatedAt"]) ? 0 : original["updatedAt"]!
                let stamp = LearningJSON.int64(original["updatedAt"]) ?? now()
                try enqueueDB(db, ns, "speak-sessions", id: id, payload: payload, updatedAt: stamp, device: device)
            }
        }
        // 新快照里消失的行 → tombstone（删除随同步传播）
        for (field, collection) in [("articles", "reading-articles"), ("books", "reading-articles"), ("words", "reading-vocab"), ("sessions", "speak-sessions")] {
            guard let previousRows = LearningJSON.array(before[field]) else { continue }
            let currentRows = LearningJSON.array(value[field]) ?? []
            for raw in previousRows {
                guard let row = LearningJSON.object(raw), let id = LearningJSON.string(row["id"]), !id.isEmpty else { continue }
                let exists = currentRows.contains { LearningJSON.string(LearningJSON.object($0)?["id"]) == id }
                if !exists {
                    try tombstoneDB(db, ns, collection, id: id, device: device)
                }
            }
        }
        if name.hasSuffix(".md") {
            if let content {
                let lines = content.split(separator: "\n", maxSplits: 3, omittingEmptySubsequences: false)
                guard lines.first.map(String.init) == "---", lines.count >= 2,
                      let metaLine = lines.dropFirst().first.map(String.init),
                      let meta = (try? JSONSerialization.jsonObject(with: Data(metaLine.utf8))) else { return }
                let body = lines.count >= 4 ? String(lines[3]) : ""
                try enqueueDB(db, ns, "notes", id: name, payload: ["v": 2, "id": name, "meta": meta, "content": body], updatedAt: now(), device: device)
            } else {
                try tombstoneDB(db, ns, "notes", id: name, device: device)
            }
        }
    }

    // MARK: commit / commitMany（Rust :1387-1442）

    /// 单文件提交（快照 + outbox 单事务；导出失败仅发通知不回滚）。
    func commit(_ url: URL, _ content: String?) throws {
        try commitMany([(url, content)])
    }

    /// 批量提交（Rust commit_many：域文件 JSON 与旧稿 preserve+merge 后单事务落库）。
    func commitMany(_ writes: [(URL, String?)]) throws {
        lock.lock()
        defer { lock.unlock() }
        let db = try connection()
        let ns = currentNamespace()
        let device = try deviceId()
        var exports: [(url: URL, body: String?)] = []
        try db.transaction { [self] in
            for (url, content) in writes {
                try self.verifyPath(url, namespace: ns)
                let old = try self.readFileDB(db, ns, url)
                var body = content
                if let old {
                    // Rust `if let (Some(old), Some(body)) = (&old, &mut body)`：直接改写
                    // 同一个 body——不能用 `if let var body` 之类的影子绑定（改的只是
                    // 局部副本，files 表会存回未合并的原文，练习任务载荷随写丢失）。
                    if let previous = (try? JSONSerialization.jsonObject(with: Data(old.utf8))) as? JSONObject,
                       var next = body.flatMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? JSONObject } {
                        Self.preservePracticeTasks(previous, &next)
                        Self.mergeUnknown(previous, &next)
                        body = LearningJSON.stringify(next)
                    }
                }
                try self.derive(db, ns, url, old: old, content: body, device: device)
                // files 表存原始 JSON 文本（与 Rust 一致：body 本身入库）。
                try db.run(
                    "INSERT INTO files(namespace,path,content) VALUES(?,?,?) ON CONFLICT(namespace,path) DO UPDATE SET content=excluded.content",
                    [ns, url.path, body]
                )
                exports.append((url, body))
            }
        }
        // 事务外导出兼容文件：失败只发 learning-export-warning，数据不回滚。
        for export in exports {
            do {
                if let body = export.body {
                    try FileManager.default.createDirectory(at: export.url.deletingLastPathComponent(), withIntermediateDirectories: true)
                    let tmp = export.url.deletingPathExtension().appendingPathExtension("learning.tmp")
                    try body.data(using: .utf8)?.write(to: tmp)
                    _ = try FileManager.default.replaceItemAt(export.url, withItemAt: tmp)
                } else {
                    do {
                        try FileManager.default.removeItem(at: export.url)
                    } catch let error as NSError where error.code == NSFileNoSuchFileError || error.code == 4 {
                        // NotFound 豁免
                    }
                }
            } catch {
                center.post(
                    name: .learningExportWarning,
                    object: nil,
                    userInfo: ["message": "学习记录已保存，兼容文件导出失败，可稍后重试导出", "path": export.url.path]
                )
            }
        }
    }

    // MARK: hydrate（Rust :565-797）

    /// 把实体表投影回域文件快照（files 表；磁盘导出仍走 commit 的导出段）。
    func hydrate(_ db: LearningSQLiteConnection, namespace: String, collection: String) throws {
        let dir = try dataDirectory(namespace: namespace)
        let all = try listDB(db, namespace, collection)
        let live = all.filter { !$0.deleted }
        switch collection {
        case "reading-vocab":
            let path = dir.appendingPathComponent("reader_vocab.json")
            var file = (try readFileDB(db, namespace, path))
                .flatMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? JSONObject }
                ?? ["schemaVersion": 1, "reviewLog": ["schemaVersion": 1, "days": [] as [Any]], "readingLog": [] as [Any]]
            file["words"] = live.compactMap { $0.payload }
            try snapshotDB(db, namespace, path, file)
            try hydrateReviews(db, namespace: namespace)
        case "review-events":
            try hydrateReviews(db, namespace: namespace)
        case "reading-articles":
            try hydrateArticles(db, namespace: namespace, dir: dir, live: live)
        case "notes":
            try hydrateNotes(db, namespace: namespace, dir: dir, all: all)
        case "speak-sessions":
            let sessions: [JSONObject] = live.compactMap { LearningJSON.object($0.payload) }.compactMap { $0 }.map { payload in
                var p = payload
                if LearningJSON.isUndefined(p["createdAt"]) {
                    p["createdAt"] = LearningJSON.isUndefined(p["startedAt"]) ? 0 : p["startedAt"]!
                }
                if LearningJSON.isUndefined(p["updatedAt"]) {
                    p["updatedAt"] = LearningJSON.isUndefined(p["endedAt"]) ? 0 : p["endedAt"]!
                }
                return p
            }
            try snapshotDB(db, namespace, dir.appendingPathComponent("reader_speak_sessions.json"), ["schemaVersion": 1, "sessions": sessions])
        default:
            break
        }
    }

    /// 裸文章负载判定（hydrate 重建 reader_articles.json 用；对齐 Windows
    /// is_bare_article_payload）：无 kind 但确是整篇文章（有 id 与 sentences）。
    /// content-chunk（articleId 键控、无 id）与 progress 等投影实体一律排除。
    static func isBareArticlePayload(_ p: JSONObject) -> Bool {
        LearningJSON.array(p["sentences"]) != nil
            && !LearningJSON.isUndefined(p["id"])
            && LearningJSON.isUndefined(p["articleId"])
    }

    /// reading-articles：manifest + chunk + progress 组装；chunk 缺失 / revision
    /// 不符 → 沿用旧域文件版本，不写半成品。
    private func hydrateArticles(
        _ db: LearningSQLiteConnection, namespace: String, dir: URL, live: [StoredSyncEntity]
    ) throws {
        var articles: [JSONObject] = []
        var books: [JSONObject] = []
        for entity in live {
            guard let p = LearningJSON.object(entity.payload) else { continue }
            let kind = LearningJSON.string(p["kind"])
            if kind == "book" {
                var book = p
                if var chapters = LearningJSON.array(book["chapters"]) {
                    for index in chapters.indices {
                        guard var chapter = LearningJSON.object(chapters[index]) else { continue }
                        if LearningJSON.isUndefined(chapter["id"]) {
                            chapter["id"] = LearningJSON.isUndefined(chapter["articleId"]) ? NSNull() : chapter["articleId"]!
                        }
                        chapters[index] = chapter
                    }
                    book["chapters"] = chapters
                }
                books.append(book)
                continue
            }
            if kind != "article" {
                // 宽容分支只收「裸整篇文章」（旧客户端/外部写入的完整载荷原样保留）；
                // content-chunk 同步分块（键为 articleId、无 id）同样带 sentences，
                // 绝不能进文章数组——否则 reader_articles.json 混入缺 id 的对象，整库
                // 解码失败，书架空白、导入与打开文章必失败（对齐 Windows
                // is_bare_article_payload，2026-10-30 同一事故）。
                if Self.isBareArticlePayload(p) {
                    articles.append(p)
                }
                continue
            }
            guard let chunkIds = LearningJSON.array(p["chunkIds"]) else { continue }
            var rows: [JSONObject] = []
            var complete = true
            for rawID in chunkIds {
                guard let cid = LearningJSON.string(rawID),
                      let chunk = LearningJSON.object(live.first(where: { $0.id == cid })?.payload) else {
                    complete = false
                    break
                }
                if LearningJSON.equal(chunk["contentRevision"], p["contentRevision"]) {
                    if let sentences = LearningJSON.array(chunk["sentences"]) {
                        rows.append(contentsOf: sentences.compactMap { LearningJSON.object($0) })
                    } else {
                        complete = false
                    }
                } else {
                    complete = false
                }
            }
            if !complete {
                let bookId = LearningJSON.string(p["bookId"])
                let oldPath = bookId != nil ? dir.appendingPathComponent("books").appendingPathComponent("\(bookId!).json") : dir.appendingPathComponent("reader_articles.json")
                if let raw = try readFileDB(db, namespace, oldPath),
                   let old = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? JSONObject,
                   let previousRows = LearningJSON.array(old["articles"]),
                   let previous = previousRows.first(where: { LearningJSON.string(LearningJSON.object($0)?["id"]) == entity.id }),
                   let previousArticle = LearningJSON.object(previous) {
                    articles.append(previousArticle)
                }
                continue
            }
            var article = p
            let latest = live.compactMap { LearningJSON.object($0.payload) }.compactMap { $0 }
                .filter { payload in
                    LearningJSON.string(payload["kind"]) == "progress"
                        && LearningJSON.string(payload["articleId"]) == entity.id
                        && LearningJSON.equal(payload["contentRevision"], p["contentRevision"])
                }
                .max { a, b in (LearningJSON.int64(a["lastReadAt"]) ?? 0) < (LearningJSON.int64(b["lastReadAt"]) ?? 0) }
            let locator = LearningJSON.string(LearningJSON.object(latest?["locator"])?["sentenceId"])
            let idx = locator.map { text in rows.firstIndex { $0["id"] as? String == text } } ?? nil
            article["sentences"] = rows
            article["lastReadAt"] = latest?["lastReadAt"] ?? 0
            article["progress"] = [
                "sentenceIdx": idx ?? 0,
                "percent": latest?["percent"] ?? 0,
                "secondsListened": latest?["secondsListened"] ?? 0,
            ] as JSONObject
            articles.append(article)
        }
        let shorts = articles.filter {
            let bookId = $0["bookId"]
            return LearningJSON.isUndefined(bookId) || LearningJSON.isNull(bookId)
        }
        try snapshotDB(db, namespace, dir.appendingPathComponent("reader_articles.json"), ["schemaVersion": 1, "articles": shorts])
        for book in books {
            guard let id = LearningJSON.string(book["id"]), !id.isEmpty else { continue }
            let chapters = articles.filter { LearningJSON.string($0["bookId"]) == id }
            let bookDir = dir.appendingPathComponent("books", isDirectory: true)
            try FileManager.default.createDirectory(at: bookDir, withIntermediateDirectories: true)
            try snapshotDB(db, namespace, bookDir.appendingPathComponent("\(id).json"), ["schemaVersion": 1, "articles": chapters])
        }
        try snapshotDB(db, namespace, dir.appendingPathComponent("reader_books.json"), ["schemaVersion": 1, "books": books])
    }

    /// notes → notes/<id> Markdown（`---\n<meta>\n---\n<content>`；id 含 / \ : 跳过）。
    private func hydrateNotes(_ db: LearningSQLiteConnection, namespace: String, dir: URL, all: [StoredSyncEntity]) throws {
        for entity in all {
            if entity.id.contains("/") || entity.id.contains("\\") || entity.id.contains(":") { continue }
            let file = dir.appendingPathComponent("notes").appendingPathComponent(entity.id)
            if entity.deleted {
                try db.run(
                    "INSERT INTO files(namespace,path,content) VALUES(?,?,NULL) ON CONFLICT(namespace,path) DO UPDATE SET content=NULL",
                    [namespace, file.path]
                )
            } else if let p = LearningJSON.object(entity.payload),
                      let meta = p["meta"],
                      let content = LearningJSON.string(p["content"]) {
                let metaText = LearningJSON.stringify(meta)
                let raw = "---\n\(metaText)\n---\n\(content)"
                try db.run(
                    "INSERT INTO files(namespace,path,content) VALUES(?,?,?) ON CONFLICT(namespace,path) DO UPDATE SET content=excluded.content",
                    [namespace, file.path, raw]
                )
            }
        }
    }

    /// 复习域投影：逐词 reduce 回写实体 + 从 baselineReviewLog 与活跃事件 day 重建
    /// reviewLog（历史每日计数不伪造）。
    func hydrateReviews(_ db: LearningSQLiteConnection, namespace: String) throws {
        let dir = try dataDirectory(namespace: namespace)
        let path = dir.appendingPathComponent("reader_vocab.json")
        guard let raw = try readFileDB(db, namespace, path),
              var file = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? JSONObject else {
            return
        }
        if LearningJSON.isUndefined(file["baselineReviewLog"]) {
            file["baselineReviewLog"] = LearningJSON.object(file["reviewLog"])
                ?? ["schemaVersion": 1, "days": [] as [Any]]
        }
        let events = try listDB(db, namespace, "review-events")
            .filter { !$0.deleted }
            .compactMap { LearningJSON.object($0.payload) }.compactMap { $0 }
        var words = file["words"] as? [JSONObject] ?? []
        let vocabEntities = try listDB(db, namespace, "reading-vocab")
        for index in words.indices {
            var word = words[index]
            Self.reduceWord(&word, events)
            words[index] = word
            if var stored = vocabEntities.first(where: { $0.id == (word["id"] as? String) }) {
                stored.payload = word
                try putDB(db, namespace, "reading-vocab", stored)
            }
        }
        file["words"] = words
        var counts: [String: Int64] = [:]
        for day in LearningJSON.array(LearningJSON.object(file["baselineReviewLog"])?["days"]) ?? [] {
            guard let dict = LearningJSON.object(day), let key = LearningJSON.string(dict["day"]) else { continue }
            counts[key] = LearningJSON.int64(dict["count"]) ?? 0
        }
        for event in Self.activeEvents(events) {
            if let day = LearningJSON.string(event["day"]) {
                counts[day, default: 0] += 1
            }
        }
        // BTreeMap 语义：按 day 键排序输出。
        let days = counts.keys.sorted().map { ["day": $0, "count": counts[$0] ?? 0] }
        file["reviewLog"] = ["schemaVersion": 1, "days": days]
        try snapshotDB(db, namespace, path, file)
    }

    // MARK: 游客数据单向并入账号（Rust adopt_guest :856-972）

    /// 只消费活跃游客库；从账号 A 切 B 绝不把 A 带入 B（非 guest 命名空间直接返回）。
    func adoptGuest(userId: String) throws {
        lock.lock()
        defer { lock.unlock() }
        guard currentNamespace() == "guest" else { return }
        try migrate(expectedNamespace: "guest", legacySyncDirectory: legacySyncDirectory(namespace: "guest"))
        guard currentNamespace() == "guest" else { return }
        let db = try connection()
        let target = Self.accountNamespace(userId)
        let destination = rootDirectory
            .appendingPathComponent("learning", isDirectory: true)
            .appendingPathComponent(target, isDirectory: true)
        let device = try deviceId()
        try db.transaction { [self] in
            let fileRows = try db.query("SELECT path,content FROM files WHERE namespace='guest' AND content IS NOT NULL", [])
            for row in fileRows {
                guard let path = row[0] as? String, let body = row[1] as? String else { continue }
                let source = URL(fileURLWithPath: path)
                let rootPrefix = rootDirectory.standardizedFileURL.pathComponents
                let sourceParts = source.standardizedFileURL.pathComponents
                guard sourceParts.count >= rootPrefix.count, Array(sourceParts.prefix(rootPrefix.count)) == rootPrefix else {
                    throw LearningStoreError("Guest library path outside application data")
                }
                var relative = sourceParts.dropFirst(rootPrefix.count)
                var dest = destination
                for part in relative { dest = dest.appendingPathComponent(part) }
                let old = try readFileDB(db, target, dest)
                if source.pathExtension == "md", let old, old != body {
                    let stem = source.deletingPathExtension().lastPathComponent
                    dest = dest.deletingLastPathComponent().appendingPathComponent("\(stem)-guest-\(now()).md")
                }
                let merged = try Self.mergeDomainFiles(existing: old, incoming: body)
                try derive(db, target, dest, old: old, content: merged, device: device)
                try db.run(
                    "INSERT INTO files(namespace,path,content) VALUES(?,?,?) ON CONFLICT(namespace,path) DO UPDATE SET content=excluded.content",
                    [target, dest.path, merged]
                )
                try db.run("UPDATE files SET content=NULL WHERE namespace='guest' AND path=?", [path])
            }
            let collectionRows = try db.query("SELECT DISTINCT collection FROM entities WHERE namespace='guest'", [])
            let collections = collectionRows.compactMap { $0.first as? String }
            for collection in collections {
                for var entity in try listDB(db, "guest", collection) where !entity.deleted {
                    if let old = try listDB(db, target, collection).first(where: { $0.id == entity.id }) {
                        if old.updatedAt >= entity.updatedAt { continue }
                        entity.baseVersion = old.baseVersion
                    } else {
                        entity.baseVersion = 0
                    }
                    entity.dirty = true
                    try putDB(db, target, collection, entity)
                }
            }
            try db.run("DELETE FROM entities WHERE namespace='guest'", [])
            try db.run("DELETE FROM cursors WHERE namespace='guest'", [])
            try db.run("UPDATE audio_clips SET namespace=? WHERE namespace='guest'", [target])
            try db.run("UPDATE audio_chunks SET namespace=? WHERE namespace='guest'", [target])
            for collection in ["reading-articles", "reading-vocab", "review-events", "notes", "speak-sessions"] {
                try hydrate(db, namespace: target, collection: collection)
            }
        }
    }

    /// 域文件 LWW 合并（按 updatedAt/lastReadAt 逐行；Rust merge_domain_files）。
    static func mergeDomainFiles(existing: String?, incoming: String) throws -> String {
        guard let existing else { return incoming }
        guard var result = (try? JSONSerialization.jsonObject(with: Data(existing.utf8))) as? JSONObject,
              let value = (try? JSONSerialization.jsonObject(with: Data(incoming.utf8))) as? JSONObject else {
            return incoming
        }
        for field in ["articles", "words", "books", "sessions"] {
            guard let rows = LearningJSON.array(value[field]) else { continue }
            var target = LearningJSON.array(result[field]) ?? []
            for row in rows {
                let rowDict = LearningJSON.object(row) ?? [:]
                if let index = target.firstIndex(where: { LearningJSON.equal(LearningJSON.object($0)?["id"], rowDict["id"]) }) {
                    let existingRow = LearningJSON.object(target[index]) ?? [:]
                    let beforeStamp = LearningJSON.int64(existingRow["updatedAt"]) ?? LearningJSON.int64(existingRow["lastReadAt"]) ?? 0
                    let afterStamp = LearningJSON.int64(rowDict["updatedAt"]) ?? LearningJSON.int64(rowDict["lastReadAt"]) ?? 0
                    if afterStamp > beforeStamp {
                        var next = rowDict
                        mergeUnknown(existingRow, &next)
                        target[index] = next
                    }
                } else {
                    target.append(row)
                }
            }
            result[field] = target
        }
        return LearningJSON.stringify(result)
    }

    // MARK: practice-task 实体合并（Rust merge_practice_entity :342-354）

    /// 任一侧是 practice-task 才合并；删除优先（tombstone 终态，dirty 保持）。
    /// 返回 nil 表示「不适用练习合并」。
    static func mergePracticeEntity(_ old: StoredSyncEntity, _ incoming: StoredSyncEntity) -> StoredSyncEntity? {
        let isTask: (StoredSyncEntity) -> Bool = { entity in
            LearningJSON.string(LearningJSON.object(entity.payload)?["kind"]) == "practice-task"
        }
        guard isTask(old) || isTask(incoming) else { return nil }
        var result = incoming
        if incoming.deleted { return result }
        if old.deleted {
            result = old
            result.baseVersion = max(old.baseVersion, incoming.baseVersion)
            result.dirty = true
            return result
        }
        guard let oldPayload = old.payload, let incomingPayload = incoming.payload,
              let merged = mergePracticePayload(existing: oldPayload, incoming: incomingPayload) else {
            return nil
        }
        result.dirty = incoming.dirty || !LearningJSON.equal(incomingPayload, merged)
        result.payload = merged
        result.updatedAt = max(old.updatedAt, incoming.updatedAt)
        result.baseVersion = max(old.baseVersion, incoming.baseVersion)
        return result
    }

    // MARK: 本机录音（Rust learning_audio :1448-1594）

    /// 音频分块字节上限（1 MiB）与总量上限（20 MiB）。
    enum LearningAudio {
        static let chunkMaxBytes = 1_048_576
        static let totalMaxBytes = 20 * 1024 * 1024
    }

    /// `begin` 起录 / `append` 追加（base64 PCM，序号严格递增，重传同序号同字节
    /// 幂等）/ `finalize` 标记 ready / `read` 拼全量组装 16kHz/16bit/mono WAV /
    /// `delete` 清除。PCM 分块先落库再云端处理；音频字节永不进同步载荷。
    func audio(
        action: String,
        clipId: String,
        sequence: Int64? = nil,
        data: String? = nil,
        metadata: Any? = nil,
        expectedNamespace: String? = nil
    ) throws -> Any {
        if clipId.isEmpty || clipId.utf8.count > 512 {
            throw LearningStoreError("Invalid clip id")
        }
        lock.lock()
        defer { lock.unlock() }
        try verifyNamespace(expectedNamespace)
        let ns = currentNamespace()
        let db = try connection()
        func getClip() throws -> (status: String, metadata: Any)? {
            let rows = try db.query("SELECT status,metadata FROM audio_clips WHERE namespace=? AND id=?", [ns, clipId])
            guard let row = rows.first, let status = row[0] as? String, let raw = row[1] as? String else { return nil }
            let parsed = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) ?? NSNull()
            return (status, parsed)
        }
        if action == "begin" {
            let value = metadata ?? NSNull()
            if let existing = try getClip() {
                if !LearningJSON.equal(existing.metadata, value) {
                    throw LearningStoreError("Clip id collision")
                }
            } else {
                try db.run(
                    "INSERT INTO audio_clips(namespace,id,status,metadata) VALUES(?,?,'recording',?)",
                    [ns, clipId, LearningJSON.stringify(value)]
                )
            }
            return ["clipId": clipId]
        }
        guard let clip = try getClip() else {
            throw LearningStoreError("原录音仅保存在录制它的设备，这台设备没有原声")
        }
        if action == "append" {
            guard let index = sequence, index >= 0 else { throw LearningStoreError("Invalid audio sequence") }
            guard let data, let bytes = Data(base64Encoded: data) else { throw LearningStoreError("Missing audio chunk") }
            if bytes.isEmpty || bytes.count % 2 != 0 || bytes.count > LearningAudio.chunkMaxBytes {
                throw LearningStoreError("Invalid audio chunk")
            }
            try db.transaction { [self] in
                let stats = try db.query(
                    "SELECT count(*),coalesce(sum(length(pcm)),0) FROM audio_chunks WHERE namespace=? AND id=?",
                    [ns, clipId]
                ).first
                let count = (stats?[0] as? Int64) ?? 0
                let total = (stats?[1] as? Int64) ?? 0
                if index < count {
                    let rows = try db.query(
                        "SELECT pcm FROM audio_chunks WHERE namespace=? AND id=? AND sequence=?",
                        [ns, clipId, index]
                    )
                    let old = (rows.first?.first as? Data) ?? Data()
                    if old != bytes {
                        throw LearningStoreError("Audio sequence collision")
                    }
                } else {
                    if index != count || clip.status != "recording" {
                        throw LearningStoreError("Audio sequence or status conflict")
                    }
                    if total + Int64(bytes.count) > LearningAudio.totalMaxBytes {
                        throw LearningStoreError("Recording exceeds 20 MiB")
                    }
                    try db.run(
                        "INSERT INTO audio_chunks(namespace,id,sequence,pcm) VALUES(?,?,?,?)",
                        [ns, clipId, index, bytes]
                    )
                }
            }
            let count = (try db.query(
                "SELECT count(*) FROM audio_chunks WHERE namespace=? AND id=?", [ns, clipId]
            ).first?[0] as? Int64) ?? 0
            return ["clipId": clipId, "nextSequence": max(count, index + 1)]
        }
        if action == "delete" {
            try db.transaction { [self] in
                try db.run("DELETE FROM audio_chunks WHERE namespace=? AND id=?", [ns, clipId])
                try db.run("DELETE FROM audio_clips WHERE namespace=? AND id=?", [ns, clipId])
            }
            return NSNull()
        }
        var pcm = Data()
        for row in try db.query("SELECT pcm FROM audio_chunks WHERE namespace=? AND id=? ORDER BY sequence", [ns, clipId]) {
            if let chunk = row.first as? Data { pcm.append(chunk) }
        }
        if pcm.isEmpty {
            throw LearningStoreError("没有录到有效声音，已保留当前记录")
        }
        if action == "finalize" {
            try db.run("UPDATE audio_clips SET status='ready' WHERE namespace=? AND id=?", [ns, clipId])
            return ["clipId": clipId, "status": "ready", "byteLength": pcm.count]
        }
        if action != "read" {
            throw LearningStoreError("Unknown audio action")
        }
        let length = UInt32(pcm.count)
        var wav = Data()
        wav.append(Data("RIFF".utf8))
        wav.append(contentsOf: withUnsafeBytes(of: (length + 36).littleEndian) { Data($0) })
        wav.append(Data("WAVEfmt ".utf8))
        wav.append(contentsOf: withUnsafeBytes(of: UInt32(16).littleEndian) { Data($0) })
        wav.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Data($0) })
        wav.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Data($0) })
        wav.append(contentsOf: withUnsafeBytes(of: UInt32(16_000).littleEndian) { Data($0) })
        wav.append(contentsOf: withUnsafeBytes(of: UInt32(32_000).littleEndian) { Data($0) })
        wav.append(contentsOf: withUnsafeBytes(of: UInt16(2).littleEndian) { Data($0) })
        wav.append(contentsOf: withUnsafeBytes(of: UInt16(16).littleEndian) { Data($0) })
        wav.append(Data("data".utf8))
        wav.append(contentsOf: withUnsafeBytes(of: length.littleEndian) { Data($0) })
        wav.append(pcm)
        return [
            "clipId": clipId,
            "status": clip.status,
            "metadata": clip.metadata ?? NSNull(),
            "durationMs": Int64(pcm.count) * 1000 / 32000,
            "pcmB64": pcm.base64EncodedString(),
            "wavB64": wav.base64EncodedString(),
        ]
    }
}
