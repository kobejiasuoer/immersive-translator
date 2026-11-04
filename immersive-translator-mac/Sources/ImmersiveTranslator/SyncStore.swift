import Foundation

// ---------------------------------------------------------------------------
// 云同步（升级计划 A0）通用同步实体的本地存储门面：集合白名单 + 存储原语
//（list / put / replace / 每集合版本号游标）。对齐 Windows src-tauri/src/sync.rs
// 的本地存储层（7fc6abd 起 sync_store_* 命令全部委托 learning_store）。
//
// 分层约定（与 Windows 一致）：
// - 传输与鉴权在 ServerAuth（withAuth 管线，令牌不离开进程——红线 D4/D5 的
//   Mac 等效物）；**非 2xx 是协议数据不是错误**（404 白名单外、409 冲突、
//   413 超限、429 限流都由 SyncEngine 按协议处置），传输原样带回
//   `{status, body, retryAfterSeconds}`；只有网络/致命鉴权错误才 throw。
// - 协议逻辑（游标推进、LWW 合并、409/429/413 处置）在 SyncEngine.swift；
//   本模块只提供存储原语。
//
// 两种后端，同一门面：
// - **生产**：`SyncStore.learningBacked(LearningStore)`——SQLite 权威
//   （LearningStore.putTransaction 含 dirty-LWW 深防与 practice 合并，与
//   Windows learning_store::put 同语义）；命名空间由 LearningStore 持有方按
//   登录态驱动（`guest` / `account-<user.id 字节 hex>`，auth.rs:955
//   set_account(&user.id) 同源）。
// - **JSON 回退**（未接线：单测 / 极早期）：`<baseDirectory>/sync/<namespace>/
//   <collection>.json` + `sync/<namespace>/cursors.json`，沿用 NoteStore/
//   SpeakStore 的落盘模式（串行锁 + 原子重写 + schemaVersion 校验 + 只豁免
//   文件不存在）；命名空间公式与生产同源（syncNamespace(forUserId:)）。
// ---------------------------------------------------------------------------

/// 本地同步存储 schema 版本（损坏/未来版本一律报错，绝不静默清数据）。
let syncStoreSchemaVersion = 1

/// 本地允许持久化的集合（与服务端 SYNC_COLLECTIONS 白名单对齐；集合名直接进
/// 文件路径，白名单即路径校验，防任意文件名读写/穿越）。
/// speak-sessions/speak-assessments：口语对话与跟读评测记录（2026-10-28 决策，
/// 记录跟账号走；入队/裁剪纯本地，游客零网络——协议在 SpeakRecords.swift）。
let syncLocalCollections: [String] = [
    "history",
    "reading-articles",
    "reading-vocab",
    "notes",
    "glossary",
    "settings",
    "speak-scenarios",
    "speak-sessions",
    "speak-assessments",
    "review-events",
]

/// 集合名白名单校验（Windows sync.rs validate_collection 对应物）。
func syncValidateCollection(_ collection: String) -> Bool {
    syncLocalCollections.contains(collection)
}

/// 账号命名空间（防多账号串数据）：`account-<user.id 字节 hex>`；未登录 `guest`。
/// 输入是 **user.id 而非邮箱**——Windows auth.rs:955 `set_account(Some(&user.id))`
/// 与 Mac 生产 LearningStore.setAccount(userId:) 同源；公式直接复用
/// LearningStore.accountNamespace，JSON 回退与 SQLite 生产只有一套命名空间。
func syncNamespace(forUserId userId: String?) -> String {
    guard let userId else { return "guest" }
    return LearningStore.accountNamespace(userId)
}

/// 同步存储错误（沿用 NoteStoreError 形态：一句话中文 message）。
struct SyncStoreError: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }

    init(_ message: String) {
        self.message = message
    }
}

// ---------------------------------------------------------------------------
// JSON 工具（JSONSerialization 值域：字典/数组/字符串/NSNumber/NSNull）
// ---------------------------------------------------------------------------

/// JSON 数字提取（严格排除布尔——JS `typeof true !== "number"` 的对应物）。
func syncJSONNumber(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber else { return nil }
    if number === kCFBooleanTrue || number === kCFBooleanFalse { return nil }
    return number.doubleValue
}

/// JSON 整数提取（有限、无小数部分、安全范围内；JS Number.isSafeInteger 对应物）。
func syncJSONInt64(_ value: Any?) -> Int64? {
    guard let n = syncJSONNumber(value), n.isFinite else { return nil }
    let rounded = n.rounded()
    guard n == rounded, abs(n) < 9_007_199_254_740_992 else { return nil }
    return Int64(n)
}

/// JSON 序列化字节（服务端口径：JSON 字符串的 UTF-8 长度；nil → "null" 4 字节，
/// 对齐 JS `JSON.stringify(payload ?? null)`）。
func syncJSONData(_ value: Any?) -> Data? {
    guard let value else { return Data("null".utf8) }
    if value is NSNull { return Data("null".utf8) }
    if JSONSerialization.isValidJSONObject(value) {
        return try? JSONSerialization.data(
            withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]
        )
    }
    // 标量片段（字符串/数字/布尔）：借单元素数组编码后去括号（escapeJSONString 同法）。
    if JSONSerialization.isValidJSONObject([value]),
       let data = try? JSONSerialization.data(
           withJSONObject: [value], options: [.sortedKeys, .withoutEscapingSlashes]
       ), data.count >= 2 {
        return Data(data.dropFirst().dropLast())
    }
    return nil
}

/// JSON 字符串化（字节计数 / push 请求体构造共用；失败返回 nil）。
func syncJSONStringify(_ value: Any?) -> String? {
    guard let data = syncJSONData(value) else { return nil }
    return String(data: data, encoding: .utf8)
}

/// JSON 字节数（上限护栏判定；不可序列化按 0 计，后续 push 预检自然拦截）。
func syncJSONBytes(_ value: Any?) -> Int {
    syncJSONData(value)?.count ?? 0
}

/// JSON 值是否布尔（NSNumber 在 JSONSerialization 里同时承载布尔与数字，
/// 需按 CFBoolean 区分——JS `typeof true !== "number"` 的对应物）。
private func syncIsBoolean(_ value: Any) -> Bool {
    guard let number = value as? NSNumber else { return false }
    return number === kCFBooleanTrue || number === kCFBooleanFalse
}

/// JSON 值相等（数值口径 5 与 5.0 相等；布尔不与数字相等；字典/数组递归）。
func syncJSONEqual(_ lhs: Any?, _ rhs: Any?) -> Bool {
    if lhs == nil, rhs == nil { return true }
    guard let l = lhs, let r = rhs else { return false }
    let lBool = syncIsBoolean(l), rBool = syncIsBoolean(r)
    if lBool || rBool {
        guard lBool && rBool else { return false }
        return (l as! NSNumber).isEqual(r)
    }
    if let ln = l as? NSNumber, let rn = r as? NSNumber {
        return ln.doubleValue == rn.doubleValue
    }
    if let ls = l as? String, let rs = r as? String { return ls == rs }
    if l is NSNull, r is NSNull { return true }
    if let la = l as? [Any], let ra = r as? [Any] {
        return la.count == ra.count && zip(la, ra).allSatisfy { syncJSONEqual($0, $1) }
    }
    if let ld = l as? [String: Any], let rd = r as? [String: Any] {
        return ld.count == rd.count
            && ld.allSatisfy { key, value in syncJSONEqual(value, rd[key]) }
    }
    return false
}

// ---------------------------------------------------------------------------
// 本地同步实体
// ---------------------------------------------------------------------------

/// 本地同步实体（与服务端 WireEntity 的差集：多 `baseVersion`/`dirty`，
/// 少 `version`——服务端版本即 baseVersion 的同步值）。
///
/// 序列化键 camelCase，与 Windows sync.rs StoredSyncEntity 一字不差：
/// `id / baseVersion / updatedAt / deleted / schemaVersion / originDevice /
/// payload / dirty`；originDevice 与 payload 为 nil 时省略键（serde
/// skip_serializing_if 对应物），dirty 缺省 false。
struct StoredSyncEntity {
    var id: String
    /// 上次同步到的服务端版本；0 = 本地新建从未推送。
    var baseVersion: Int64
    /// 客户端逻辑时间（毫秒）——LWW 由客户端比较，服务端只透传。
    var updatedAt: Int64
    var deleted: Bool
    var schemaVersion: Int64
    var originDevice: String?
    /// 活实体业务数据（JSON 值）；tombstone 为 nil（线路上为 null）。
    var payload: Any?
    /// 本地新建/修改/软删除置 true；push accepted 后由引擎清零。
    var dirty: Bool

    init(
        id: String,
        baseVersion: Int64,
        updatedAt: Int64,
        deleted: Bool,
        schemaVersion: Int64,
        originDevice: String?,
        payload: Any?,
        dirty: Bool
    ) {
        self.id = id
        self.baseVersion = baseVersion
        self.updatedAt = updatedAt
        self.deleted = deleted
        self.schemaVersion = schemaVersion
        self.originDevice = originDevice
        self.payload = payload
        self.dirty = dirty
    }

    // MARK: JSON 往返（文件布局用；键序随 sortedKeys 稳定）

    /// 实体 → JSON 对象（camelCase 键；nil 字段省略）。
    func jsonObject() -> [String: Any] {
        var out: [String: Any] = [
            "id": id,
            "baseVersion": baseVersion,
            "updatedAt": updatedAt,
            "deleted": deleted,
            "schemaVersion": schemaVersion,
        ]
        if let originDevice { out["originDevice"] = originDevice }
        if let payload { out["payload"] = payload }
        if dirty { out["dirty"] = true }
        return out
    }

    /// JSON 对象 → 实体（宽松：缺 originDevice/payload/dirty 视为 nil/nil/false）。
    static func fromJSONObject(_ object: [String: Any]) -> StoredSyncEntity? {
        guard let id = object["id"] as? String,
              let baseVersion = syncJSONInt64(object["baseVersion"]),
              let updatedAt = syncJSONInt64(object["updatedAt"]),
              let deleted = object["deleted"] as? Bool,
              let schemaVersion = syncJSONInt64(object["schemaVersion"]) else { return nil }
        let rawPayload = object["payload"]
        let payload: Any? = (rawPayload == nil || rawPayload is NSNull) ? nil : rawPayload
        return StoredSyncEntity(
            id: id,
            baseVersion: baseVersion,
            updatedAt: updatedAt,
            deleted: deleted,
            schemaVersion: schemaVersion,
            originDevice: object["originDevice"] as? String,
            payload: payload,
            dirty: object["dirty"] as? Bool ?? false
        )
    }
}

// ---------------------------------------------------------------------------
// 存储器
// ---------------------------------------------------------------------------

/// 同步实体本地存储：接线 LearningStore 后即 SQLite 权威（Windows 7fc6abd 起
/// sync.rs 的 sync_store_* 命令全部委托 learning_store——本类保留同一门面 API，
/// 生产走 LearningStore；未接线（历史测试）回退 JSON 文件布局）。
/// 线程安全：内部串行锁包裹「读-改-写」全程（Windows STORE_LOCK 对应物）。
final class SyncStore {
    /// 基目录（默认应用支持目录；测试可注入临时目录；仅 JSON 回退布局使用）。
    let baseDirectory: URL
    /// SQLite 权威存储（接线后 list/put/replace/cursor 全部走它；nil = JSON 回退）。
    private var learning: LearningStore?
    /// 当前账号命名空间（Windows learning_store 的 NAMESPACE + set_account
    /// 对应物：登录态变化由持有方在主线程驱动 setAccount，读取全程持锁）。
    private var accountNamespace: String = "guest"
    /// 写盘串行锁（读-改-写全程持锁，防并发丢更新）。
    private let lock = NSLock()

    init(baseDirectory: URL? = nil) {
        if let baseDirectory {
            self.baseDirectory = baseDirectory
        } else {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? FileManager.default.temporaryDirectory
            self.baseDirectory = support.appendingPathComponent("ImmersiveTranslator", isDirectory: true)
        }
    }

    /// 生产构造：全部原语委托 SQLite 权威学习存储（命名空间由 LearningStore
    /// 持有方驱动；JSON 门面的 setAccount 成为无操作）。
    static func learningBacked(_ learning: LearningStore) -> SyncStore {
        let store = SyncStore()
        store.learning = learning
        return store
    }

    /// 登录态变化时切换命名空间（userId nil = 未登录 guest；Windows
    /// learning_store::set_account(Some(&user.id)) 对应物）。
    /// 接线 LearningStore 后命名空间由其持有方驱动（同样按 user.id），此调用
    /// 仅作用于 JSON 回退布局。
    func setAccount(userId: String?) {
        lock.lock()
        defer { lock.unlock() }
        guard learning == nil else { return }
        accountNamespace = syncNamespace(forUserId: userId)
    }

    /// 当前命名空间（Windows learning_store::namespace 对应物）。
    func currentNamespace() -> String {
        lock.lock()
        defer { lock.unlock() }
        return namespaceAssumingLocked()
    }

    /// 命名空间读取（调用方必须已持锁——NSLock 非递归，不可重入）。
    private func namespaceAssumingLocked() -> String {
        accountNamespace
    }

    /// 命名空间校验（expectedNamespace 与当前不符即取消——Windows
    /// learning_store::verify_namespace 文案同款，防账号切换后写串数据）。
    /// 调用方必须已持锁。
    private func verifyNamespace(_ expected: String?) throws {
        guard let expected else { return }
        if expected != namespaceAssumingLocked() {
            throw SyncStoreError("账号已切换，本次操作已取消")
        }
    }

    // MARK: 路径

    private func syncDirectory(namespace: String) throws -> URL {
        let dir = baseDirectory
            .appendingPathComponent("sync", isDirectory: true)
            .appendingPathComponent(namespace, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            return dir
        } catch {
            throw SyncStoreError("无法创建同步数据目录: \(error.localizedDescription)")
        }
    }

    /// 集合名直接进文件路径，白名单即路径校验（防任意文件名读写/穿越）。
    private func collectionPath(_ collection: String, namespace: String) throws -> URL {
        guard syncValidateCollection(collection) else {
            throw SyncStoreError("未知同步集合 \(collection)（本地白名单外）")
        }
        return try syncDirectory(namespace: namespace)
            .appendingPathComponent("\(collection).json")
    }

    private func cursorsPath(namespace: String) throws -> URL {
        try syncDirectory(namespace: namespace).appendingPathComponent("cursors.json")
    }

    // MARK: 文件读写（原子：tmp + 替换；损坏/版本不兼容报错不清数据）

    private func loadCollectionFile(at path: URL) throws -> [StoredSyncEntity] {
        let text: String
        do {
            text = try String(contentsOf: path, encoding: .utf8)
        } catch {
            return []  // 文件不存在 = 空集合（唯一豁免的错误形态）
        }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return [] }
        guard let data = text.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw SyncStoreError("同步数据损坏（\(path.path)）：无法解析 JSON")
        }
        let fileVersion = syncJSONInt64(object["schemaVersion"]) ?? 0
        if fileVersion != Int64(syncStoreSchemaVersion) {
            throw SyncStoreError(
                "同步数据版本不兼容（文件 v\(fileVersion)，应用 v\(syncStoreSchemaVersion)）。请升级应用后再打开。"
            )
        }
        let rows = object["entities"] as? [Any] ?? []
        return rows.compactMap { $0 as? [String: Any] }.compactMap { StoredSyncEntity.fromJSONObject($0) }
    }

    private func writeCollectionFile(_ entities: [StoredSyncEntity], at path: URL) throws {
        let object: [String: Any] = [
            "schemaVersion": syncStoreSchemaVersion,
            "entities": entities.map { $0.jsonObject() },
        ]
        guard let data = syncJSONData(object) else {
            throw SyncStoreError("序列化同步数据失败")
        }
        try writeAtomically(data, to: path)
    }

    private func loadCursorsFile(at path: URL) throws -> [String: Int64] {
        let text: String
        do {
            text = try String(contentsOf: path, encoding: .utf8)
        } catch {
            return [:]
        }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return [:] }
        guard let data = text.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw SyncStoreError("同步游标损坏（\(path.path)）：无法解析 JSON")
        }
        let fileVersion = syncJSONInt64(object["schemaVersion"]) ?? 0
        if fileVersion != Int64(syncStoreSchemaVersion) {
            throw SyncStoreError(
                "同步游标版本不兼容（文件 v\(fileVersion)，应用 v\(syncStoreSchemaVersion)）。"
            )
        }
        let raw = object["cursors"] as? [String: Any] ?? [:]
        var cursors: [String: Int64] = [:]
        for (collection, value) in raw {
            if let cursor = syncJSONInt64(value) { cursors[collection] = cursor }
        }
        return cursors
    }

    private func writeCursorsFile(_ cursors: [String: Int64], at path: URL) throws {
        let object: [String: Any] = [
            "schemaVersion": syncStoreSchemaVersion,
            "cursors": cursors,
        ]
        guard let data = syncJSONData(object) else {
            throw SyncStoreError("序列化同步游标失败")
        }
        try writeAtomically(data, to: path)
    }

    /// 原子写（tmp + replaceItemAt；SpeakStore/NoteStore 同模式）。
    private func writeAtomically(_ data: Data, to path: URL) throws {
        let tmp = path.appendingPathExtension("tmp")
        do {
            try data.write(to: tmp, options: .atomic)
            _ = try FileManager.default.replaceItemAt(path, withItemAt: tmp)
        } catch {
            throw SyncStoreError("写入 \(path.lastPathComponent) 失败: \(error.localizedDescription)")
        }
    }

    // MARK: 存储原语（Windows sync_store_list/put/replace/cursor_get/cursor_set）

    /// 列出集合的全部本地实体（含 tombstone 与 dirty；updatedAt 倒序）。
    /// 合并/过滤决策在 SyncEngine / SpeakRecords，这里只负责持久化。
    func list(_ collection: String, expectedNamespace: String? = nil) throws -> [StoredSyncEntity] {
        lock.lock()
        defer { lock.unlock() }
        if let learning {
            return try learning.list(collection, expectedNamespace: expectedNamespace)
                .sorted { $0.updatedAt > $1.updatedAt }
        }
        try verifyNamespace(expectedNamespace)
        var entities = try loadCollectionFile(at: collectionPath(collection, namespace: namespaceAssumingLocked()))
        entities.sort { $0.updatedAt > $1.updatedAt }
        return entities
    }

    /// 按 id 整体替换（存在即覆盖、不存在即追加）。不做新旧比较——
    /// LWW 与 dirty 语义由引擎决定后写入最终状态。
    func put(
        _ collection: String,
        _ entities: [StoredSyncEntity],
        expectedNamespace: String? = nil
    ) throws {
        lock.lock()
        defer { lock.unlock() }
        if let learning {
            return try learning.storePut(collection, entities, expectedNamespace: expectedNamespace)
        }
        try verifyNamespace(expectedNamespace)
        let path = try collectionPath(collection, namespace: namespaceAssumingLocked())
        var merged = try loadCollectionFile(at: path)
        for entity in entities {
            if let idx = merged.firstIndex(where: { $0.id == entity.id }) {
                merged[idx] = entity
            } else {
                merged.append(entity)
            }
        }
        try writeCollectionFile(merged, at: path)
    }

    /// 全量快照整体落库（首拉全量完成时原子替换整集合并推进游标）。
    /// 替换期间**保留本地待推（dirty）实体**（Windows sync_store_replace /
    /// learning_store::put(replace) 同语义："retaining pending edits"）——
    /// 快照行按 id 覆盖；快照里没有的 dirty 行以 baseVersion=0 回写，
    /// 有的吸收快照版本号（等价于引擎的 keptLocal 口径）。
    func replace(
        _ collection: String,
        _ entities: [StoredSyncEntity],
        cursor: Int64,
        expectedNamespace: String? = nil
    ) throws {
        lock.lock()
        defer { lock.unlock() }
        if let learning {
            return try learning.storePut(collection, entities, replace: true, cursor: max(0, cursor), expectedNamespace: expectedNamespace)
        }
        try verifyNamespace(expectedNamespace)
        let namespace = namespaceAssumingLocked()
        let path = try collectionPath(collection, namespace: namespace)
        let current = try loadCollectionFile(at: path)
        var snapshot = entities
        let pending = current.filter { $0.dirty }
        for var entity in pending {
            if let server = entities.first(where: { $0.id == entity.id }) {
                entity.baseVersion = server.baseVersion
            } else {
                entity.baseVersion = 0
            }
            if let idx = snapshot.firstIndex(where: { $0.id == entity.id }) {
                snapshot[idx] = entity
            } else {
                snapshot.append(entity)
            }
        }
        try writeCollectionFile(snapshot, at: path)
        var cursors = try loadCursorsFile(at: cursorsPath(namespace: namespace))
        cursors[collection] = max(0, cursor)
        try writeCursorsFile(cursors, at: cursorsPath(namespace: namespace))
    }

    /// 读取集合游标（版本号；无记录默认 0 = 首次全量拉取）。
    func cursorGet(_ collection: String, expectedNamespace: String? = nil) throws -> Int64 {
        lock.lock()
        defer { lock.unlock() }
        if let learning {
            return try learning.cursorGet(collection, expectedNamespace: expectedNamespace)
        }
        try verifyNamespace(expectedNamespace)
        let cursors = try loadCursorsFile(at: cursorsPath(namespace: namespaceAssumingLocked()))
        return cursors[collection] ?? 0
    }

    /// 写入集合游标。每个集合必须各存各的（版本号空间跨集合共享，
    /// 混用会漏拉低版本实体）。
    func cursorSet(_ collection: String, _ cursor: Int64, expectedNamespace: String? = nil) throws {
        lock.lock()
        defer { lock.unlock() }
        if let learning {
            return try learning.storePut(collection, [], cursor: max(0, cursor), expectedNamespace: expectedNamespace)
        }
        try verifyNamespace(expectedNamespace)
        let namespace = namespaceAssumingLocked()
        var cursors = try loadCursorsFile(at: cursorsPath(namespace: namespace))
        cursors[collection] = max(0, cursor)
        try writeCursorsFile(cursors, at: cursorsPath(namespace: namespace))
    }
}
