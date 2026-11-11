import Combine
import Foundation
import ReaderCore
import XfyunCore

// ---------------------------------------------------------------------------
// 口语记录云同步记录层（2026-10-28 决策：记录跟账号走，语音偏好/音频不入云）。
// 对齐 Windows src/lib/speakRecords.ts + packages/learning-core/src/relay.ts。
//
// 两个同步集合，复用既有 SyncEngine /v1/sync 管线（协议零新增，SyncStore 的
// LOCAL_COLLECTIONS 白名单含集合名）：
// - speak-sessions：保留完整文字、提示、上下文、表达建议和发音报告，
//   供另一设备按保存步骤续练；仅剥离音频字节和源设备私有路径。
// - speak-assessments：跟读/发音评测记录。{id, source, lang, refText,
//   total/accuracy/fluency/standard, words[{w,s}], sessionId?, at}；source：
//   reader=阅读室跟读、review=复习、coach=口语陪练（含只练差词）；words 是
//   逐词精简结果（可截断），**录音/base64 音频字段禁止出现在任何 push 载荷**。
//
// 体量护栏（与服务端 SYNC_COLLECTION_MAX_BYTES 对齐）：
// - 单条同步 ≤64KB：超限完整会话仍保留本机并明确提示，不裁真实尝试。
// - 每用户每集合滚动保留最近 500 条：入队时超出部分本地转 tombstone（删除
//   随同步传播到其他端；tombstone 计 0 字节并释放配额，服务端不拒收）。
//
// 游客（未登录）：入队/裁剪是纯本地文件操作（零网络请求）；触发同步前先查
// 登录态，未登录直接跳过——记录仅本地，无任何登录墙。
//
// 平台差异：推送 originDevice 报 "mac"（Windows 报 "windows"；服务端对该
// 字段透传不校验，报真实平台是协议语义）。
// ---------------------------------------------------------------------------

/// 口语对话记录集合名（服务端 SYNC_COLLECTIONS / 本地白名单同名）。
let speakSessionsCollection = "speak-sessions"
/// 跟读评测记录集合名。
let speakAssessmentsCollection = "speak-assessments"

/// 单条记录体积上限（字节）：与服务端 SYNC_COLLECTION_MAX_BYTES 一致。
let speakRecordMaxBytes = 64 * 1024
/// 每集合滚动保留条数（超出本地裁剪：最旧条目转 tombstone）。
let speakRecordMaxLive = 500
/// 评测记录逐词精简结果的最大词数（超出丢尾）。
let assessMaxWords = 64
/// 评测摘要参考文本上限；完整会话文字不适用。
let speakTextMaxChars = 1000

/// 会话记录的开放载荷形状（保留未知业务字段，故用 JSON 字典承载；
/// Windows SpeakSessionRecord 的 `[key:string]:unknown` 对应物）。
typealias SpeakSessionRecordPayload = [String: Any]

// ---------------------------------------------------------------------------
// 音频剥离 / 载荷深合并：唯一基准在 ReaderCore（RelayEntities.swift，对齐
// packages/learning-core/src/relay.ts）；此处保留旧名作薄转发（既有测试与
// 调用点不动）。
// ---------------------------------------------------------------------------

/// 递归剥离音频字节与源设备私有路径键（音频红线：录音/base64 音频字段
/// 禁止出现在任何 push 载荷）。Preserve feedback and source snapshots.
/// Oversize records stay local; never discard attempts.
func syncWithoutAudio(_ value: Any?) -> Any? {
    withoutAudio(value)
}

// ---------------------------------------------------------------------------
// speak-sessions：会话精简记录
// ---------------------------------------------------------------------------

/// Codable 值 → JSON 字典（投影/入队的通用桥）。
private func speakJSONObject<T: Encodable>(_ value: T) -> [String: Any] {
    guard let data = try? JSONEncoder().encode(value),
          let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        return [:]
    }
    return object
}

/// 会话 → 同步精简记录（SpeakSession 的同步投影：startedAt=createdAt、
/// endedAt=updatedAt、v:2 版本标记；turns 保留完整反馈字段）。超 64KB 抛错，
/// 完整记录保留本机，**绝不裁剪真实练习轮次**。
func speakSessionRecordFrom(_ session: SpeakSession) throws -> SpeakSessionRecordPayload {
    var record = (syncWithoutAudio(speakJSONObject(session)) as? [String: Any]) ?? [:]
    record["v"] = 2
    record["id"] = session.id
    record["scenario"] = session.scenario
    record["difficulty"] = session.difficulty.rawValue
    record["startedAt"] = session.createdAt
    record["endedAt"] = session.updatedAt
    if syncJSONBytes(record) > speakRecordMaxBytes {
        throw SyncStoreError("口语记录超过 64KB 同步上限，完整记录仍保留在本机，请分段练习后再同步")
    }
    return record
}

/// 云端记录 → 富会话（createdAt=startedAt、updatedAt=max(startedAt, endedAt)、
/// turns 浅拷贝；兼容旧最小投影）。scenario 自 A1 起为裸 String：官方/用户场景
/// id（off_/usr_）的记录照常还原；仍还原不了的脏行返回 nil 由调用方丢弃，不崩溃。
func speakSessionFromRecord(_ record: SpeakSessionRecordPayload) -> SpeakSession? {
    guard let startedAt = syncJSONInt64(record["startedAt"]),
          let endedAt = syncJSONInt64(record["endedAt"]) else { return nil }
    var dict = record
    dict["createdAt"] = startedAt
    dict["updatedAt"] = max(startedAt, endedAt)
    guard let data = syncJSONData(dict) else { return nil }
    return try? JSONDecoder().decode(SpeakSession.self, from: data)
}

/// 运行时形状守卫（同步数据进门校验，脏行整条丢弃——feedStore 范式）。
func isSpeakSessionRecordLike(_ value: Any?) -> Bool {
    guard let record = value as? [String: Any] else { return false }
    guard let id = record["id"] as? String, !id.isEmpty,
          record["scenario"] is String,
          let difficulty = record["difficulty"] as? String,
          ["easy", "medium", "hard"].contains(difficulty),
          let startedAt = syncJSONNumber(record["startedAt"]), startedAt.isFinite,
          let endedAt = syncJSONNumber(record["endedAt"]), endedAt.isFinite,
          let turns = record["turns"] as? [Any] else {
        return false
    }
    return turns.allSatisfy { turn in
        guard let turn = turn as? [String: Any] else { return false }
        let role = turn["role"] as? String
        return (role == "user" || role == "assistant")
            && turn["text"] is String
            && syncJSONNumber(turn["at"]) != nil
    }
}

// ---------------------------------------------------------------------------
// speak-assessments：评测记录
// ---------------------------------------------------------------------------

/// 评测来源：reader=阅读室跟读、review=复习、coach=口语陪练（含只练差词）。
enum SpeakAssessmentSource: String {
    case reader
    case review
    case coach
}

/// 逐词精简结果：词面（≤64 字符）+ 得分（丢音节/音素明细，可截断）。
struct SpeakAssessmentWord {
    let w: String
    let s: Double
}

/// 跟读/发音评测记录（评分摘要 + 逐词精简；音频永不上云）。
struct SpeakAssessmentRecord {
    let id: String
    let source: SpeakAssessmentSource
    let lang: String
    let refText: String
    let total: Double
    let accuracy: Double
    let fluency: Double
    let standard: Double
    let words: [SpeakAssessmentWord]
    /// coach 来源关联的会话 id（reader/review 来源缺省）。
    let sessionId: String?
    let at: Int64

    init(
        id: String,
        source: SpeakAssessmentSource,
        lang: String,
        refText: String,
        total: Double,
        accuracy: Double,
        fluency: Double,
        standard: Double,
        words: [SpeakAssessmentWord],
        sessionId: String?,
        at: Int64
    ) {
        self.id = id
        self.source = source
        self.lang = lang
        self.refText = refText
        self.total = total
        self.accuracy = accuracy
        self.fluency = fluency
        self.standard = standard
        self.words = words
        self.sessionId = sessionId
        self.at = at
    }

    /// 线路载荷（sessionId 缺省不出现——Windows 展开语义）。
    var payload: [String: Any] {
        var out: [String: Any] = [
            "id": id,
            "source": source.rawValue,
            "lang": lang,
            "refText": refText,
            "total": total,
            "accuracy": accuracy,
            "fluency": fluency,
            "standard": standard,
            "words": words.map { ["w": $0.w, "s": $0.s] },
            "at": at,
        ]
        if let sessionId { out["sessionId"] = sessionId }
        return out
    }

    /// 宽松还原（listAssessmentRecords 用；字段不齐返回 nil）。
    init?(payload: [String: Any]) {
        guard let id = payload["id"] as? String, !id.isEmpty,
              let sourceRaw = payload["source"] as? String,
              let source = SpeakAssessmentSource(rawValue: sourceRaw),
              let lang = payload["lang"] as? String,
              let refText = payload["refText"] as? String,
              let total = syncJSONNumber(payload["total"]),
              let accuracy = syncJSONNumber(payload["accuracy"]),
              let fluency = syncJSONNumber(payload["fluency"]),
              let standard = syncJSONNumber(payload["standard"]),
              let rawWords = payload["words"] as? [Any],
              let at = syncJSONInt64(payload["at"]) else { return nil }
        var words: [SpeakAssessmentWord] = []
        for raw in rawWords {
            guard let row = raw as? [String: Any],
                  let w = row["w"] as? String,
                  let s = syncJSONNumber(row["s"]) else { return nil }
            words.append(SpeakAssessmentWord(w: w, s: s))
        }
        self.id = id
        self.source = source
        self.lang = lang
        self.refText = refText
        self.total = total
        self.accuracy = accuracy
        self.fluency = fluency
        self.standard = standard
        self.words = words
        self.sessionId = payload["sessionId"] as? String
        self.at = at
    }
}

/// 评测入队输入（评测结果 + 来源与参考文本；now/lang 可注入，单测确定性）。
struct SpeakAssessmentInput {
    let result: PronunciationResult
    let source: SpeakAssessmentSource
    let refText: String
    var sessionId: String? = nil
    var lang: String? = nil
    var now: Int64? = nil
}

/// 会话 id 同款风格的随机 base36 尾巴（`Math.random().toString(36).slice(2,8)`）。
private func syncRandomBase36(_ count: Int) -> String {
    let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")
    return String((0..<count).map { _ in alphabet.randomElement()! })
}

/// 评测结果 → 精简记录：四分摘要 + 逐词 {词面(≤64 字符), 得分}（截 64 个）、
/// 参考文本截 1000 字、id 前缀 `sa` + 时间 36 进制 + 随机尾。
func speakAssessmentRecordFrom(_ input: SpeakAssessmentInput) -> SpeakAssessmentRecord {
    let at = input.now ?? Int64(Date().timeIntervalSince1970 * 1000)
    let words = input.result.words.prefix(assessMaxWords).map {
        SpeakAssessmentWord(w: String($0.content.prefix(64)), s: $0.totalScore)
    }
    return SpeakAssessmentRecord(
        id: "sa\(String(at, radix: 36))\(syncRandomBase36(6))",
        source: input.source,
        lang: input.lang ?? "en",
        refText: String(input.refText.prefix(speakTextMaxChars)),
        total: input.result.total,
        accuracy: input.result.accuracy,
        fluency: input.result.fluency,
        standard: input.result.standard,
        words: Array(words),
        sessionId: input.sessionId,
        at: at
    )
}

/// 运行时形状守卫（脏行整条丢弃）。
func isSpeakAssessmentRecordLike(_ value: Any?) -> Bool {
    guard let record = value as? [String: Any] else { return false }
    guard let id = record["id"] as? String, !id.isEmpty,
          let source = record["source"] as? String,
          SpeakAssessmentSource(rawValue: source) != nil,
          record["lang"] is String,
          record["refText"] is String,
          let total = syncJSONNumber(record["total"]), total.isFinite,
          let accuracy = syncJSONNumber(record["accuracy"]), accuracy.isFinite,
          let fluency = syncJSONNumber(record["fluency"]), fluency.isFinite,
          let standard = syncJSONNumber(record["standard"]), standard.isFinite,
          let words = record["words"] as? [Any],
          syncJSONNumber(record["at"]) != nil else {
        return false
    }
    return words.allSatisfy { word in
        guard let word = word as? [String: Any] else { return false }
        return word["w"] is String && syncJSONNumber(word["s"]) != nil
    }
}

// ---------------------------------------------------------------------------
// 记录层门面：入队（本地写 + dirty）/ 滚动裁剪 / tombstone 删除 / 读取 / 合并
// ---------------------------------------------------------------------------

/// 活实体超出的最旧部分 → tombstone 批次（保留 baseVersion，payload 置空，
/// updatedAt 取裁剪时刻——晚于被裁记录的逻辑时间，LWW 下删除可传播）。
func speakOverflowTombstones(live: [StoredSyncEntity], now: Int64) -> [StoredSyncEntity] {
    guard live.count >= speakRecordMaxLive else { return [] }
    let sorted = live.sorted { $0.updatedAt < $1.updatedAt }  // 旧 → 新
    let overflow = live.count - speakRecordMaxLive + 1
    return sorted.prefix(overflow).map { entity in
        StoredSyncEntity(
            id: entity.id,
            baseVersion: entity.baseVersion,
            updatedAt: max(now, entity.updatedAt + 1),
            deleted: true,
            schemaVersion: entity.schemaVersion,
            originDevice: entity.originDevice,
            payload: nil,
            dirty: true
        )
    }
}

/// 口语记录同步门面（Windows speakRecords.ts 模块导出的对应物）。入队/裁剪/
/// list 全是本地文件操作（零网络）；同步触发先查登录态（游客直接跳过）。
/// store 自带串行锁，任意线程安全。
final class SpeakRecordsSyncer {
    let store: SyncStore
    let engine: SyncEngine
    /// 登录态读取（nil = 读取失败——宁可不同步也不出网）。
    private let loginStatus: () -> AuthStatus?
    /// 命名空间读取（BUG-030）：入队/删除每次操作前采集一次，list → put 全程
    /// 作为 expectedNamespace 携带——账号切换窗口内存储层 verifyNamespace 直接
    /// 取消本次写入，实体绝不落错命名空间（对照 SyncEngine.syncNow 采集
    /// deps.namespace()、ReaderStore.gradeVocabWord 采集 currentNamespace 同策略；
    /// 登出后误写的 guest 行会在下次登录被 adoptGuest 并入账号，跨账号串扰）。
    /// 默认走 store 门面（JSON 回退布局的命名空间由 setAccount 驱动、读取准确）；
    /// learningBacked 布局下 SyncStore 门面不跟随登录态，由 SpeakSyncCenter
    /// 注入 LearningStore.currentNamespace。
    private let currentNamespace: () -> String

    init(
        store: SyncStore,
        engine: SyncEngine,
        loginStatus: @escaping () -> AuthStatus?,
        currentNamespace: (() -> String)? = nil
    ) {
        self.store = store
        self.engine = engine
        self.loginStatus = loginStatus
        self.currentNamespace = currentNamespace ?? { store.currentNamespace() }
    }

    // MARK: 入队 / 裁剪

    private func enqueueRecord(collection: String, id: String, updatedAt: Int64, payload: [String: Any]) throws {
        let namespace = currentNamespace()
        let stored = try store.list(collection, expectedNamespace: namespace)
        let existing = stored.first { $0.id == id }
        let entity = StoredSyncEntity(
            id: id,
            baseVersion: existing?.baseVersion ?? 0,  // 已同步过则沿用，避免无谓 409
            updatedAt: updatedAt,
            deleted: false,
            schemaVersion: max(2, existing?.schemaVersion ?? 0),
            originDevice: syncOriginDevice,
            payload: syncWithoutAudio(mergeRelayPayload(existing: existing?.payload, incoming: payload)),
            dirty: true
        )
        // 滚动裁剪：入队后活实体数 ≤ 500（新实体自身不参与裁剪候选）
        let tombstones = speakOverflowTombstones(
            live: stored.filter { !$0.deleted && $0.id != id },
            now: updatedAt
        )
        try store.put(
            collection,
            tombstones.isEmpty ? [entity] : [entity] + tombstones,
            expectedNamespace: namespace
        )
    }

    /// 会话记录入队（每轮保存漏斗调用；LWW 时钟 = 会话 updatedAt）。
    func enqueueSessionRecord(_ session: SpeakSession) throws {
        let record = try speakSessionRecordFrom(session)
        try enqueueRecord(
            collection: speakSessionsCollection,
            id: session.id,
            updatedAt: session.updatedAt,
            payload: record
        )
    }

    /// 评测记录入队（每次评测一条新实体，永不更新）。
    func enqueueAssessment(_ input: SpeakAssessmentInput) throws {
        let record = speakAssessmentRecordFrom(input)
        try enqueueRecord(
            collection: speakAssessmentsCollection,
            id: record.id,
            updatedAt: record.at,
            payload: record.payload
        )
    }

    /// 组件侧 fire-and-forget 入口（静默；本地写失败不影响对话/评测流程）。
    func enqueueSessionRecordSilently(_ session: SpeakSession) {
        let syncer = self
        Task.detached(priority: .utility) {
            _ = try? syncer.enqueueSessionRecord(session)
        }
    }

    /// 组件侧 fire-and-forget 入口（同上）。
    func recordAssessmentSilently(_ input: SpeakAssessmentInput) {
        let syncer = self
        Task.detached(priority: .utility) {
            _ = try? syncer.enqueueAssessment(input)
        }
    }

    // MARK: 删除（tombstone）

    /// 删除走 tombstone（payload 置空、保留 baseVersion；删除随同步传播到其他
    /// 端）。返回是否发生了状态变化（本就无实体/已是 tombstone 则 false）。
    @discardableResult
    func deleteSessionRecord(id: String, now: Int64? = nil) throws -> Bool {
        try tombstoneRecord(collection: speakSessionsCollection, id: id, now: now)
    }

    @discardableResult
    func deleteAssessmentRecord(id: String, now: Int64? = nil) throws -> Bool {
        try tombstoneRecord(collection: speakAssessmentsCollection, id: id, now: now)
    }

    private func tombstoneRecord(collection: String, id: String, now: Int64?) throws -> Bool {
        let stamp = now ?? Int64(Date().timeIntervalSince1970 * 1000)
        let namespace = currentNamespace()
        let stored = try store.list(collection, expectedNamespace: namespace)
        guard let existing = stored.first(where: { $0.id == id }), !existing.deleted else {
            return false
        }
        try store.put(collection, [
            StoredSyncEntity(
                id: id,
                baseVersion: existing.baseVersion,
                updatedAt: max(stamp, existing.updatedAt + 1),
                deleted: true,
                schemaVersion: existing.schemaVersion,
                originDevice: existing.originDevice,
                payload: nil,
                dirty: true
            ),
        ], expectedNamespace: namespace)
        return true
    }

    /// 删除的静默包装（SpeakStore 写穿用）。
    func deleteSessionRecordSilently(id: String) {
        let syncer = self
        Task.detached(priority: .utility) {
            _ = try? syncer.deleteSessionRecord(id: id)
        }
    }

    // MARK: 读取 / 展示合并

    /// 集合内全部记录（tombstone 与形状不符的脏行丢弃）。
    func listSessionRecords() -> [SpeakSessionRecordPayload] {
        guard let stored = try? store.list(speakSessionsCollection) else { return [] }
        return stored
            .filter { !$0.deleted && isSpeakSessionRecordLike($0.payload) }
            .compactMap { $0.payload as? [String: Any] }
    }

    func listAssessmentRecords() -> [SpeakAssessmentRecord] {
        guard let stored = try? store.list(speakAssessmentsCollection) else { return [] }
        return stored
            .filter { !$0.deleted && isSpeakAssessmentRecordLike($0.payload) }
            .compactMap { $0.payload as? [String: Any] }
            .compactMap { SpeakAssessmentRecord(payload: $0) }
    }

    /// 静默双向同步两个记录集合（口语页入口出现时调用）：未登录直接跳过
    /// （零网络请求），失败只汇总不抛——同步静默，失败不打扰。
    @MainActor
    func syncSpeakRecordsSilently() async -> [SyncSummary] {
        guard let status = loginStatus() else { return [] }  // 读取失败：宁可不同步也不出网
        guard status.loggedIn else { return [] }
        var summaries: [SyncSummary] = []
        for collection in [speakSessionsCollection, speakAssessmentsCollection] {
            summaries.append(await engine.syncNow(collection))  // syncNow 不抛，错误在 summary.error
        }
        return summaries
    }
}

/// 会话列表展示合并：云端精简记录与本地富会话按 id 合并——本地 updatedAt
/// 较新或**相等**时保留本地富会话（同 id 的超集），云端较新（别端续聊过）
/// 则用云端精简版；返回 updatedAt 倒序。带 `kind==="practice-task"` 的行
/// 跳过（Mac 本期无练习接力；忽略不崩溃，避免他端任务在口语列表露头）。
func speakMergeSessionsWithRecords(
    local: [SpeakSession], records: [SpeakSessionRecordPayload]
) -> [SpeakSession] {
    var byId: [String: SpeakSession] = [:]
    for record in records where record["kind"] as? String != "practice-task" {
        guard let id = record["id"] as? String,
              let restored = speakSessionFromRecord(record) else { continue }
        byId[id] = restored
    }
    for session in local {
        if let cloud = byId[session.id], session.updatedAt < cloud.updatedAt {
            continue  // 云端严格较新：用云端精简版
        }
        byId[session.id] = session  // 无云端记录，或本地 ≥ 云端：保留本地富会话
    }
    return byId.values.sorted { $0.updatedAt > $1.updatedAt }
}

// ---------------------------------------------------------------------------
// App 级云同步环境（Windows 全局 tauriBridge IPC 通道的对应物）
// ---------------------------------------------------------------------------

/// 云同步环境单例：持有唯一的 SyncStore（按账号命名空间隔离目录）与
/// SyncEngine（全局串行队列），由 AppDelegate 启动时接线 ServerAuthClient；
/// 未接线（单测/极早期）一切同步入口安全空转（记录仅本地）。
@MainActor
final class SpeakSyncCenter: ObservableObject {
    static let shared = SpeakSyncCenter()

    private(set) var records: SpeakRecordsSyncer?
    /// 启动接线时保存的 ServerAuthClient（练习接力环境构造等非同步消费者用）。
    private(set) var serverAuth: ServerAuthClient?

    private init() {}

    /// 启动接线（AppDelegate.applicationDidFinishLaunching，先于
    /// serverAuth.bootstrap() 调用一次）。存储为 SQLite 权威 LearningStore
    ///（Windows 7fc6abd 起 sync_store_* 全部委托 learning_store 的对应物）；
    /// 命名空间跟随登录态（guest / account-<user.id hex>，由 ServerAuthClient
    /// 驱动 setAccount）。学习接力的旧 JSON 同步目录不在此捕获（此刻必然未
    /// 登录），由 runRelay 每轮按当轮命名空间现算。
    func configure(serverAuth: ServerAuthClient) {
        self.serverAuth = serverAuth
        let learning = LearningStore.shared
        serverAuth.attachLearningStore(learning)
        let store = SyncStore.learningBacked(learning)
        let engine = SyncEngine(dependencies: .production(serverAuth: serverAuth, learning: learning))
        records = SpeakRecordsSyncer(
            store: store,
            engine: engine,
            loginStatus: { [weak serverAuth] in serverAuth?.status },
            // BUG-030：learningBacked 布局下 SyncStore 门面命名空间不跟随登录态，
            // 入队/删除的 expectedNamespace 采集源接 LearningStore.currentNamespace。
            currentNamespace: { learning.currentNamespace() }
        )
        LearningRelaySync.shared.configure(serverAuth: serverAuth, learning: learning, engine: engine)
    }
}
