import Foundation
import ReaderCore

// ---------------------------------------------------------------------------
// 云同步协议引擎（升级计划 A0）：拉取游标推进、LWW 合并、409/429/413 处置。
// 对齐 Windows src/lib/syncEngine.ts（协议决策层，全部逻辑可用注入的假传输与
// 内存/临时目录 store 单测覆盖——Mac 依赖经 SyncEngineDependencies 注入）。
//
// 与服务端 M4 协议（apps/api/src/modules/sync）对齐的关键语义：
// - `since` 是版本号游标（非时间戳），版本号空间**跨集合共享**——每集合各存各的
//   cursor；追平判据是 `hasMore === false`，不是 cursor === serverVersion。
// - 首次全量（since=0）时 tombstone 也会下发，必须按 deleted:true 落地删除。
// - push 409 整批原子拒绝：批次是重试单元；`server === null` 表示服务端从未
//   见过该实体（baseVersion 0 重推）；有快照则 LWW——本地 updatedAt **严格**
//   更新才携 serverVersion 重推，否则（含相等，server-wins 防乒乓）采纳服务端。
// - updatedAt 是客户端逻辑时间，服务端只透传——LWW 完全依赖两端时钟可信。
// - 单实体 payload ≤ 512KB；speak-sessions / speak-assessments 双集合特配
//   64KB（字节口径与服务端一致：payload JSON 的 UTF-8 长度，tombstone 计 0）。
// - pull/push 共用 per-user 120/min 限流桶：429 按 retryAfterSeconds 退避，
//   最多等 3 次，超限本次失败（下次再试）。
// ---------------------------------------------------------------------------

// MARK: - 线路类型（服务端 sync-protocol 的 Swift 镜像）

/// 服务端下发的实体形态。updatedAt 是 ISO 字符串；payload 活实体非 null、
/// tombstone 为 null。
struct SyncWireEntity {
    let id: String
    let version: Int64
    let updatedAt: String
    let deleted: Bool
    let schemaVersion: Int64
    let originDevice: String?
    let payload: Any?

    init(
        id: String, version: Int64, updatedAt: String, deleted: Bool,
        schemaVersion: Int64, originDevice: String?, payload: Any?
    ) {
        self.id = id
        self.version = version
        self.updatedAt = updatedAt
        self.deleted = deleted
        self.schemaVersion = schemaVersion
        self.originDevice = originDevice
        self.payload = payload
    }

    /// 宽松解码（脏行交给上层形状守卫整条丢弃，这里只拆信封）。
    init?(jsonObject object: [String: Any]) {
        guard let id = object["id"] as? String,
              let version = syncJSONInt64(object["version"]),
              let updatedAt = object["updatedAt"] as? String,
              let deleted = object["deleted"] as? Bool,
              let schemaVersion = syncJSONInt64(object["schemaVersion"]) else { return nil }
        self.id = id
        self.version = version
        self.updatedAt = updatedAt
        self.deleted = deleted
        self.schemaVersion = schemaVersion
        self.originDevice = object["originDevice"] as? String
        let rawPayload = object["payload"]
        self.payload = (rawPayload == nil || rawPayload is NSNull) ? nil : rawPayload
    }

    func jsonObject() -> [String: Any] {
        [
            "id": id,
            "version": version,
            "updatedAt": updatedAt,
            "deleted": deleted,
            "schemaVersion": schemaVersion,
            "originDevice": originDevice ?? NSNull(),
            "payload": payload ?? NSNull(),
        ]
    }
}

struct SyncPullPage {
    /// 信封里的集合名 / 服务端全局版本号：协议文档含此两字段，但引擎不消费，
    /// 解码口径与 Windows 一致——只校验 entities 数组、cursor 整数、hasMore 布尔
    ///（syncEngine.ts:234），缺 collection/serverVersion 不算响应无效。
    let collection: String?
    let serverVersion: Int64?
    let cursor: Int64
    let hasMore: Bool
    let entities: [SyncWireEntity]

    /// 解码：必要信封字段（entities/cursor/hasMore）不齐返回 nil（→「同步拉取
    /// 响应无效」）。实体行缺必需字段（id/version/updatedAt/deleted/schemaVersion）
    /// 时整页同样返回 nil：Windows 把行原样交给 sync_store_put，Rust
    /// StoredSyncEntity 反序列化失败 → 本页不落库、游标不推进、本次同步失败、下次
    /// 重试；绝不能像丢脏行那样静默跳过却推进游标（被跳过的变更将永久丢失）。
    /// 失败文案平台差异：Windows 透出 Tauri IPC 反序列化原文，Mac 报引擎自身的
    /// 「同步拉取响应无效」。
    init?(body: String) {
        guard let data = body.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let cursor = syncJSONInt64(object["cursor"]),
              let hasMore = object["hasMore"] as? Bool,
              let rawEntities = object["entities"] as? [Any] else { return nil }
        var entities: [SyncWireEntity] = []
        entities.reserveCapacity(rawEntities.count)
        for raw in rawEntities {
            guard let row = raw as? [String: Any],
                  let entity = SyncWireEntity(jsonObject: row),
                  syncParseISOMilliseconds(entity.updatedAt) != nil else { return nil }
            entities.append(entity)
        }
        self.collection = object["collection"] as? String
        self.serverVersion = syncJSONInt64(object["serverVersion"])
        self.cursor = cursor
        self.hasMore = hasMore
        self.entities = entities
    }
}

struct SyncConflictEntry {
    let reason: String?
    let id: String
    let serverVersion: Int64
    let server: SyncWireEntity?
}

// MARK: - 常量（与服务端 SYNC_* 对齐）

enum SyncEngineLimits {
    static let pullPageLimit: Int64 = 500
    static let pushBatch = 200
    static let maxEntityBytes = 512 * 1024
    /// 拉取页数上限（400 页 × 500 = 20 万实体，防异常服务端把客户端拖死）。
    static let maxPullPages = 400
    /// 409 冲突后整批重推的最大轮数。
    static let maxConflictRounds = 3
    /// 429 退避等待的最大次数（超过则本次同步失败，下次再试）。
    static let maxRateLimitWaits = 3
    /// 推送请求体上限（字节）。
    static let pushBodyMaxBytes = 2 * 1024 * 1024
}

/// 推送 originDevice 标识（服务端按设备维度透传用于多端溯源；平台差异：
/// Windows 报 "windows"，Mac 必须报真实平台 "mac"）。
let syncOriginDevice = "mac"

/// speak-sessions / speak-assessments 双集合的单条特配上限（= 服务端
/// SYNC_COLLECTION_MAX_BYTES 双集合特配 65536；其余集合 512KB）。
let syncSpeakCollectionMaxBytes = 65_536

// MARK: - 汇总

struct SyncEntitySkip {
    let id: String
    let reason: String
}

struct SyncSummary {
    var ok = true
    /// 拉取到的实体数（含 tombstone）。
    var pulled = 0
    /// 采纳服务端版本的实体数。
    var appliedRemote = 0
    /// 本地较新而保留待推的实体数。
    var keptLocal = 0
    /// push accepted 的实体数。
    var pushed = 0
    /// 409 冲突处理次数。
    var conflicts = 0
    /// 无法推送被跳过的实体（超限/无 payload 等，保留本地）。
    var skipped: [SyncEntitySkip] = []
    /// 失败原因（ok=false 时非空）。
    var error: String?

    static func failure(_ message: String) -> SyncSummary {
        var summary = SyncSummary()
        summary.ok = false
        summary.error = message
        return summary
    }
}

// MARK: - 错误信封解析

/// 统一错误形状 `{error:{code, message, details?}}` 的宽松解析（解析失败映射
/// 本地伪码；Windows syncEngine.ts errorOf 对应物）。
private struct SyncErrorEnvelope {
    let code: String
    let message: String
    let details: [String: Any]
}

private func syncErrorOf(_ response: AuthHttpResponse) -> SyncErrorEnvelope {
    var code = "unknown"
    var message = "HTTP \(response.status)"
    var details: [String: Any] = [:]
    if let data = response.body.data(using: .utf8),
       let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
       let error = object["error"] as? [String: Any] {
        if let parsed = error["code"] as? String { code = parsed }
        if let parsed = error["message"] as? String { message = parsed }
        if let parsed = error["details"] as? [String: Any] { details = parsed }
    }
    return SyncErrorEnvelope(code: code, message: message, details: details)
}

// MARK: - ISO 时间（线路 updatedAt 是 ISO 字符串，本地是 Unix 毫秒）

private let syncISOWithFraction: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

private let syncISOPlain: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
}()

/// ISO 字符串 → Unix 毫秒（兼容带/不带毫秒；失败 nil）。JS Date.parse 对应物。
func syncParseISOMilliseconds(_ text: String) -> Int64? {
    if let date = syncISOWithFraction.date(from: text) ?? syncISOPlain.date(from: text) {
        return Int64(date.timeIntervalSince1970 * 1000)
    }
    return nil
}

/// Unix 毫秒 → ISO 字符串（毫秒精度 "…T12:34:56.789Z"）。JS toISOString 对应物。
func syncFormatISO(_ milliseconds: Int64) -> String {
    let date = Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1000)
    return syncISOWithFraction.string(from: date)
}

// MARK: - 实体换算

/// 单实体字节数（服务端口径：payload JSON 的 UTF-8 长度；tombstone 计 0）。
func syncEntityPayloadBytes(_ entity: StoredSyncEntity) -> Int {
    if entity.deleted { return 0 }
    return syncJSONBytes(entity.payload ?? NSNull())
}

/// 服务端实体 → 本地实体（baseVersion=version；tombstone 不带 payload）。
private func syncWireToStored(_ wire: SyncWireEntity) -> StoredSyncEntity {
    StoredSyncEntity(
        id: wire.id,
        baseVersion: wire.version,
        updatedAt: syncParseISOMilliseconds(wire.updatedAt) ?? 0,
        deleted: wire.deleted,
        schemaVersion: wire.schemaVersion,
        originDevice: wire.originDevice,
        payload: wire.deleted ? nil : wire.payload,
        dirty: false
    )
}

/// 本地实体 → 线路对象（tombstone payload 为 null；originDevice 缺省补 mac）。
private func syncStoredToWireObject(_ entity: StoredSyncEntity) -> [String: Any] {
    [
        "id": entity.id,
        "baseVersion": entity.baseVersion,
        "updatedAt": syncFormatISO(entity.updatedAt),
        "deleted": entity.deleted,
        "schemaVersion": entity.schemaVersion,
        "originDevice": entity.originDevice ?? syncOriginDevice,
        "payload": entity.deleted ? NSNull() : (entity.payload ?? NSNull()),
    ]
}

// MARK: - 依赖注入（协议引擎的全部外部世界；对齐 tauriBridge 的 mock 边界）

struct SyncEngineDependencies {
    /// expectedNamespace 透传给传输层（auth 守卫：账号切换即本地取消不出网）。
    var pull: (_ collection: String, _ since: Int64, _ limit: Int64, _ expectedNamespace: String?) async throws -> AuthHttpResponse
    var push: (_ collection: String, _ entitiesJSON: String, _ expectedNamespace: String?) async throws -> AuthHttpResponse
    var list: (_ collection: String, _ namespace: String?) throws -> [StoredSyncEntity]
    var put: (_ collection: String, _ entities: [StoredSyncEntity], _ namespace: String?) throws -> Void
    var replace: (_ collection: String, _ entities: [StoredSyncEntity], _ cursor: Int64, _ namespace: String?) throws -> Void
    var cursorGet: (_ collection: String, _ namespace: String?) throws -> Int64
    var cursorSet: (_ collection: String, _ cursor: Int64, _ namespace: String?) throws -> Void
    /// 当前账号命名空间（guest / account-<hex>；引擎在运行起点解析并复核）。
    var namespace: () -> String
    /// 429 退避等待（生产真实 sleep；单测注入零等待）。
    var sleep: (_ seconds: TimeInterval) async -> Void = { seconds in
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }
}

extension SyncEngineDependencies {
    /// 生产依赖：ServerAuthClient 鉴权传输（withAuth 管线——401 单飞刷新重放
    /// 一次 + expectedNamespace 二道守卫；非 2xx 原样带回，只有网络/致命鉴权才
    /// throw）+ LearningStore 本地存储（SQLite 权威；learning_store::put 同语义）。
    /// 命名空间由持有方经 store.setAccount 驱动（登录态变化 → 目录切换）。
    static func production(serverAuth: ServerAuthClient, learning: LearningStore) -> SyncEngineDependencies {
        SyncEngineDependencies(
            pull: { collection, since, limit, namespace in
                try await serverAuth.syncPull(collection: collection, since: since, limit: limit, expectedNamespace: namespace)
            },
            push: { collection, entitiesJSON, namespace in
                try await serverAuth.syncPush(collection: collection, entitiesJSON: entitiesJSON, expectedNamespace: namespace)
            },
            list: { collection, namespace in
                try learning.list(collection, expectedNamespace: namespace)
            },
            put: { collection, entities, namespace in
                try learning.storePut(collection, entities, expectedNamespace: namespace)
            },
            replace: { collection, entities, cursor, namespace in
                try learning.storePut(collection, entities, replace: true, cursor: cursor, expectedNamespace: namespace)
            },
            cursorGet: { collection, namespace in
                try learning.cursorGet(collection, expectedNamespace: namespace)
            },
            cursorSet: { collection, cursor, namespace in
                try learning.storePut(collection, [], cursor: max(0, cursor), expectedNamespace: namespace)
            },
            namespace: { learning.currentNamespace() }
        )
    }
}

/// 一次 syncNow 的协商参数（Windows SyncOptions 同形）：集合级 schemaVersions、
/// 各字节/数量上限都来自 GET /v1/me/config 的 sync 段。
struct SyncOptions {
    var namespace: String?
    var maxEntityBytes: Int?
    var maxPushEntities: Int?
    var maxPullLimit: Int?
    var maxBodyBytes: Int?
    var schemaVersions: [Int]?

    init(
        namespace: String? = nil,
        maxEntityBytes: Int? = nil,
        maxPushEntities: Int? = nil,
        maxPullLimit: Int? = nil,
        maxBodyBytes: Int? = nil,
        schemaVersions: [Int]? = nil
    ) {
        self.namespace = namespace
        self.maxEntityBytes = maxEntityBytes
        self.maxPushEntities = maxPushEntities
        self.maxPullLimit = maxPullLimit
        self.maxBodyBytes = maxBodyBytes
        self.schemaVersions = schemaVersions
    }
}

/// 正整数协商（非法/非正回退默认值；Windows positiveLimit 对应物）。
private func syncPositiveLimit(_ value: Int?, _ fallback: Int) -> Int {
    value != nil && value! > 0 ? value! : fallback
}

/// practice-task 双端合并（syncEngine.ts practiceEntity :180-191）：任一侧
/// practice-task 才合并；tombstone 终态（远端删除不复活，本地删除不复活）。
/// 返回 nil 表示不适用练习合并。
func syncPracticeEntity(_ local: StoredSyncEntity?, _ incoming: StoredSyncEntity) -> StoredSyncEntity? {
    guard let local else { return nil }
    let isTask: (Any?) -> Bool = { LearningJSON.string(LearningJSON.object($0)?["kind"]) == "practice-task" }
    if !isTask(local.payload) && !isTask(incoming.payload) { return nil }
    // 任务删除对其 ID 是终态；新建练习用新 ID。
    if incoming.deleted { return incoming }
    if local.deleted {
        var kept = local
        kept.baseVersion = incoming.baseVersion
        kept.dirty = true
        return kept
    }
    guard let localPayload = local.payload, let incomingPayload = incoming.payload,
          let merged = mergePracticePayload(existing: localPayload, incoming: incomingPayload) else {
        return nil
    }
    var result = incoming
    result.payload = merged
    result.updatedAt = max(local.updatedAt, incoming.updatedAt)
    result.dirty = incoming.dirty || !LearningJSON.equal(merged, incomingPayload)
    return result
}

// MARK: - 引擎

/// 云同步协议引擎。syncNow 全局串行（Windows queue 链式 promise 的对应物）：
/// 任何时刻至多一次完整同步在途，后来的排队等待；失败不抛——汇总带回错误，
/// 调用方（UI）据此展示；已落地的部分保留，下次同步续传。
final class SyncEngine {
    private let deps: SyncEngineDependencies
    private let queueLock = NSLock()
    private var queueTail = Task<Void, Never> {}
    /// 运行中的协商参数与命名空间（Windows activeOptions/activeNamespace 对应物）。
    private var activeOptions = SyncOptions()

    init(dependencies: SyncEngineDependencies) {
        self.deps = dependencies
    }

    /// 对一个集合做一次完整的双向同步：先拉取（应用服务端变更 + 推进游标），
    /// 再推送本地 dirty 实体（含新建/修改/软删除）。
    /// 排队期间账号已切换即取消本次同步（Windows syncNow 队列守卫）。
    func syncNow(_ collection: String, options: SyncOptions = SyncOptions()) async -> SyncSummary {
        await enqueue { [weak self] () -> SyncSummary in
            guard let self else { return SyncSummary.failure("同步引擎已释放") }
            // 命名空间在运行起点解析（options 或当前命名空间）并立即复核：
            // 排队期间账号已切换即取消原账号同步。
            let namespace = options.namespace ?? self.deps.namespace()
            self.activeOptions = options
            defer { self.activeOptions = SyncOptions() }
            guard self.deps.namespace() == namespace else {
                return SyncSummary.failure("账号已切换，本次同步已取消")
            }
            return await self.runSync(collection, namespace: namespace)
        }
    }

    // MARK: 串行队列（链式任务：后进的等前一个完成）

    /// 链入串行队列并返回任务（锁只在本同步函数内短暂持有，不跨挂起点）。
    private func chainTask<Outcome>(_ operation: @escaping () async -> Outcome) -> Task<Outcome, Never> {
        queueLock.lock()
        defer { queueLock.unlock() }
        let previous = queueTail
        let task = Task<Outcome, Never> {
            await previous.value
            return await operation()
        }
        queueTail = Task<Void, Never> { _ = await task.value }
        return task
    }

    private func enqueue<Outcome>(_ operation: @escaping () async -> Outcome) async -> Outcome {
        await chainTask(operation).value
    }

    private func runSync(_ collection: String, namespace: String) async -> SyncSummary {
        var summary = SyncSummary()
        do {
            try await pullAll(collection, namespace: namespace, summary: &summary)
            try await pushDirty(collection, namespace: namespace, summary: &summary)
        } catch let error as SyncStoreError {
            summary.ok = false
            summary.error = error.message
        } catch {
            summary.ok = false
            summary.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
        return summary
    }

    // MARK: 拉取

    private func pullAll(_ collection: String, namespace: String, summary: inout SyncSummary) async throws {
        var cursor = try deps.cursorGet(collection, namespace)
        // 首次全量（cursor=0）：整页累积，追平后一次性 replace（原子换快照）。
        var fullSnapshot: [StoredSyncEntity]? = cursor == 0 ? [] : nil
        let limit = Int64(syncPositiveLimit(activeOptions.maxPullLimit, Int(SyncEngineLimits.pullPageLimit)))
        var rateLimitWaits = 0
        var page = 0
        while page < SyncEngineLimits.maxPullPages {
            let response = try await deps.pull(collection, cursor, min(SyncEngineLimits.pullPageLimit, limit), namespace)
            if response.status == 200 {
                guard let pullPage = SyncPullPage(body: response.body) else {
                    throw SyncStoreError("同步拉取响应无效")
                }
                let nextCursor = pullPage.cursor
                let hasMore = pullPage.hasMore
                if nextCursor < cursor { throw SyncStoreError("同步拉取响应无效") }
                if hasMore && nextCursor == cursor { throw SyncStoreError("同步游标未推进") }
                let wires = pullPage.entities

                if fullSnapshot != nil {
                    fullSnapshot!.append(contentsOf: wires.map(syncWireToStored))
                    summary.pulled += wires.count
                    cursor = nextCursor
                    if !hasMore {
                        // 全量快照整体落库（speak-sessions 逐条先做 practice 合并，
                        // 保留 dirty；替换语义在 LearningStore.put(replace:)：
                        // 保留全部 dirty、缺席者 baseVersion 归 0）。
                        let latest = Dictionary(
                            uniqueKeysWithValues: try deps.list(collection, namespace).map { ($0.id, $0) }
                        )
                        let snapshot = fullSnapshot!.map { entity in
                            collection == "speak-sessions" ? (syncPracticeEntity(latest[entity.id], entity) ?? entity) : entity
                        }
                        try deps.replace(collection, snapshot, cursor, namespace)
                        summary.appliedRemote += snapshot.count
                        return
                    }
                    page += 1
                    continue
                }

                var local = Dictionary(
                    uniqueKeysWithValues: try deps.list(collection, namespace).map { ($0.id, $0) }
                )
                var updates: [StoredSyncEntity] = []
                for wire in wires {
                    summary.pulled += 1
                    let wireMs = syncParseISOMilliseconds(wire.updatedAt) ?? 0
                    let merged = collection == "speak-sessions"
                        ? syncPracticeEntity(local[wire.id], syncWireToStored(wire))
                        : nil
                    if let merged {
                        local[wire.id] = merged
                        if merged.dirty {
                            summary.keptLocal += 1
                        } else {
                            summary.appliedRemote += 1
                        }
                    } else if let existing = local[wire.id], existing.dirty, existing.updatedAt > wireMs {
                        // 本地有未推送的更新且更新：保留本地内容，只吸收服务端版本号
                        var kept = existing
                        kept.baseVersion = wire.version
                        local[wire.id] = kept
                        summary.keptLocal += 1
                    } else {
                        local[wire.id] = syncWireToStored(wire)
                        summary.appliedRemote += 1
                    }
                    updates.append(local[wire.id]!)
                }
                if !updates.isEmpty {
                    try deps.put(collection, updates, namespace)
                }
                cursor = nextCursor
                try deps.cursorSet(collection, cursor, namespace)
                if !hasMore { return }
                page += 1
                continue
            }
            if response.status == 429 {
                rateLimitWaits += 1
                if rateLimitWaits > SyncEngineLimits.maxRateLimitWaits {
                    throw SyncStoreError("同步拉取被限流（429），已等待 3 次仍未通过，请稍后再试")
                }
                await deps.sleep(syncWaitSeconds(for: response))
                continue  // 退避后重试同一页（page 不推进）
            }
            let envelope = syncErrorOf(response)
            if envelope.code == "stale_cursor" || envelope.code == "staleCursor" {
                if fullSnapshot != nil && cursor == 0 {
                    throw SyncStoreError("全量同步期间游标再次失效")
                }
                fullSnapshot = []
                cursor = 0
                page += 1
                continue  // 归零全量重来
            }
            throw SyncStoreError(
                "同步拉取失败（HTTP \(response.status) \(envelope.code)）：\(envelope.message)"
            )
        }
        throw SyncStoreError("同步拉取页数超过 \(SyncEngineLimits.maxPullPages)，中止（服务端数据异常）")
    }

    // MARK: 推送

    private func pushDirty(_ collection: String, namespace: String, summary: inout SyncSummary) async throws {
        let all = try deps.list(collection, namespace)
        var pushable: [StoredSyncEntity] = []
        for entity in all {
            guard entity.dirty else { continue }
            if !entity.deleted && (entity.payload == nil) {
                summary.skipped.append(SyncEntitySkip(id: entity.id, reason: "活实体缺少 payload，无法推送"))
                continue
            }
            // 集合级 schemaVersions 协商：服务端不支持该版本就整体跳过（不降级裁剪）
            if let versions = activeOptions.schemaVersions, !versions.contains(Int(entity.schemaVersion)) {
                summary.skipped.append(SyncEntitySkip(
                    id: entity.id,
                    reason: "服务端不支持 schemaVersion \(entity.schemaVersion)，完整记录保留在本机"
                ))
                continue
            }
            let maxBytes = syncPositiveLimit(
                activeOptions.maxEntityBytes,
                collection == "speak-sessions" || collection == "speak-assessments"
                    ? syncSpeakCollectionMaxBytes
                    : SyncEngineLimits.maxEntityBytes
            )
            if syncEntityPayloadBytes(entity) > maxBytes {
                summary.skipped.append(SyncEntitySkip(
                    id: entity.id,
                    reason: "payload 超过 \(maxBytes) 字节上限（\(syncEntityPayloadBytes(entity)) 字节），完整记录保留在本机"
                ))
                continue
            }
            pushable.append(entity)
        }
        guard !pushable.isEmpty else { return }

        // 分批：≤min(200, maxPushEntities) 条且连同信封 ≤maxBodyBytes（默认 2MB）；
        // 单实体超请求容量直接 skip（保留本地）。协商值只能收紧不能放宽——
        // Windows syncEngine.ts:322 `Math.min(PUSH_BATCH, positiveLimit(...))` 同式。
        let batchLimit = min(
            SyncEngineLimits.pushBatch,
            syncPositiveLimit(activeOptions.maxPushEntities, SyncEngineLimits.pushBatch)
        )
        let bodyLimit = syncPositiveLimit(activeOptions.maxBodyBytes, SyncEngineLimits.pushBodyMaxBytes)
        var batch: [StoredSyncEntity] = []
        for entity in pushable {
            if !batch.isEmpty {
                let candidate = batch + [entity]
                let candidateBytes = syncJSONBytes([
                    "entities": candidate.map(syncStoredToWireObject)
                ])
                if candidate.count > batchLimit || candidateBytes > bodyLimit {
                    try await pushBatch(collection, batch, namespace: namespace, summary: &summary)
                    batch = []
                }
            }
            let singleBytes = syncJSONBytes(["entities": [syncStoredToWireObject(entity)]])
            if singleBytes > bodyLimit {
                summary.skipped.append(SyncEntitySkip(
                    id: entity.id,
                    reason: "实体连同同步信封超过请求容量，完整记录保留在本机"
                ))
                continue
            }
            batch.append(entity)
        }
        if !batch.isEmpty {
            try await pushBatch(collection, batch, namespace: namespace, summary: &summary)
        }
    }

    private func pushBatch(
        _ collection: String,
        _ batch: [StoredSyncEntity],
        namespace: String,
        summary: inout SyncSummary
    ) async throws {
        var pending = batch
        var rateLimitWaits = 0
        var round = 0
        while round < SyncEngineLimits.maxConflictRounds {
            let body = syncJSONStringify(["entities": pending.map(syncStoredToWireObject)]) ?? "{}"
            let response = try await deps.push(collection, body, namespace)
            if response.status == 200 {
                let results = Self.parsePushResults(response.body)
                let byVersion = Dictionary(uniqueKeysWithValues: results.map { ($0.id, $0.version) })
                let current = Dictionary(
                    uniqueKeysWithValues: try deps.list(collection, namespace).map { ($0.id, $0) }
                )
                // 旧应答绝不能抹掉推送期间的并发本地编辑：变了就保留最新态且不清
                // dirty；两种情况都吸收应答版本号（Windows：baseVersion 取
                // results[].version、dirty = !!changed）。
                let cleared = pending.map { entity -> StoredSyncEntity in
                    var result = entity
                    var changed = false
                    if let latest = current[entity.id] {
                        changed = latest.updatedAt != entity.updatedAt
                            || latest.deleted != entity.deleted
                            || !syncJSONEqual(latest.payload, entity.payload)
                        if changed { result = latest }
                    }
                    result.baseVersion = byVersion[entity.id] ?? result.baseVersion
                    result.dirty = changed
                    return result
                }
                try deps.put(collection, cleared, namespace)
                summary.pushed += cleared.count
                return
            }
            if response.status == 409 {
                summary.conflicts += 1
                let envelope = syncErrorOf(response)
                let rawConflicts = envelope.details["conflicts"] as? [Any] ?? []
                let conflicts = rawConflicts
                    .compactMap { $0 as? [String: Any] }
                    .compactMap { row -> SyncConflictEntry? in
                        guard let id = row["id"] as? String,
                              let serverVersion = syncJSONInt64(row["serverVersion"]) else { return nil }
                        let reason = row["reason"] as? String
                        let rawServer = row["server"]
                        let server: SyncWireEntity?
                        if rawServer == nil || rawServer is NSNull {
                            server = nil
                        } else if let object = rawServer as? [String: Any] {
                            server = SyncWireEntity(jsonObject: object)
                        } else {
                            server = nil
                        }
                        return SyncConflictEntry(reason: reason, id: id, serverVersion: serverVersion, server: server)
                    }
                // 不可变学习记录（review-events 同 ID 不同内容，服务端 reason
                // immutable_entity）：整次同步失败、本地 dirty 保留（syncEngine.ts:363）。
                if conflicts.contains(where: { $0.reason == "immutable_entity" }) {
                    throw SyncStoreError("不可变学习记录冲突，已保留本地待同步数据")
                }
                var byId = Dictionary(uniqueKeysWithValues: pending.map { ($0.id, $0) })
                let latest = Dictionary(
                    uniqueKeysWithValues: try deps.list(collection, namespace).map { ($0.id, $0) }
                )
                var adopted: [StoredSyncEntity] = []
                for conflict in conflicts {
                    let queued = byId[conflict.id]
                    guard let local = latest[conflict.id] ?? queued else { continue }
                    if conflict.server == nil {
                        // 幽灵实体：服务端从未见过（本地 baseVersion 记忆错误）→ 0 重推
                        var ghost = local
                        ghost.baseVersion = 0
                        byId[conflict.id] = ghost
                        continue
                    }
                    let serverMs = syncParseISOMilliseconds(conflict.server!.updatedAt) ?? 0
                    // speak-sessions 先做 practice-task 字段时钟合并（双端离线回答都保留）
                    let merged = collection == "speak-sessions"
                        ? syncPracticeEntity(local, syncWireToStored(conflict.server!))
                        : nil
                    if let merged {
                        var adoptedMerged = merged
                        adoptedMerged.baseVersion = conflict.serverVersion
                        byId[conflict.id] = adoptedMerged
                        adopted.append(adoptedMerged)
                    } else if local.updatedAt > serverMs {
                        // 本地较新：携新 baseVersion 重推
                        var newer = local
                        newer.baseVersion = conflict.serverVersion
                        byId[conflict.id] = newer
                    } else {
                        // 服务端较新或相等（相等取服务端，防乒乓）：采纳服务端快照
                        let adoptedEntity = syncWireToStored(conflict.server!)
                        byId[conflict.id] = adoptedEntity
                        adopted.append(adoptedEntity)
                    }
                }
                if !adopted.isEmpty {
                    try deps.put(collection, adopted, namespace)
                    summary.appliedRemote += adopted.count
                }
                pending = byId.values.filter { $0.dirty }
                if pending.isEmpty { return }
                round += 1  // 整批原子拒绝：携修正后的 baseVersion 重推
                continue
            }
            if response.status == 429 {
                rateLimitWaits += 1
                if rateLimitWaits > SyncEngineLimits.maxRateLimitWaits {
                    throw SyncStoreError("同步推送被限流（429），已等待 3 次仍未通过，请稍后再试")
                }
                await deps.sleep(syncWaitSeconds(for: response))
                continue  // 退避后重试同批（round 不推进）
            }
            if response.status == 413 {
                let envelope = syncErrorOf(response)
                if envelope.code == "payload_too_large" {
                    // 该实体超限（预检口径与服务端有偏差时兜底）：剔除后重推其余
                    if let entityId = envelope.details["entityId"] as? String {
                        summary.skipped.append(SyncEntitySkip(id: entityId, reason: "服务端判定 payload 超限"))
                        pending = pending.filter { $0.id != entityId }
                        if pending.isEmpty { return }
                        continue  // 同一轮内重推（round 不推进）
                    }
                }
                throw SyncStoreError(
                    "同步推送超限（HTTP 413 \(envelope.code)）：\(envelope.message)"
                )
            }
            let envelope = syncErrorOf(response)
            throw SyncStoreError(
                "同步推送失败（HTTP \(response.status) \(envelope.code)）：\(envelope.message)"
            )
        }
        summary.skipped.append(
            contentsOf: pending.map {
                SyncEntitySkip(id: $0.id, reason: "冲突 \(SyncEngineLimits.maxConflictRounds) 轮未收敛，留待下次同步")
            }
        )
    }

    /// push 200 应答 `results:[{id,status,version}]` 解析（宽松：脏行跳过）。
    private static func parsePushResults(_ body: String) -> [(id: String, version: Int64)] {
        guard let data = body.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let rows = object["results"] as? [Any] else { return [] }
        return rows.compactMap { row -> (String, Int64)? in
            guard let row = row as? [String: Any],
                  let id = row["id"] as? String,
                  let version = syncJSONInt64(row["version"]) else { return nil }
            return (id, version)
        }
    }
}

/// 429 退避秒数：优先响应头换算（秒），其次 body details.retryAfterMs；上限 15s。
private func syncWaitSeconds(for response: AuthHttpResponse) -> TimeInterval {
    if let seconds = response.retryAfterSeconds, seconds > 0 {
        return min(TimeInterval(seconds), 15)
    }
    if let data = response.body.data(using: .utf8),
       let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
       let error = object["error"] as? [String: Any],
       let details = error["details"] as? [String: Any],
       let retryAfterMs = syncJSONNumber(details["retryAfterMs"]), retryAfterMs > 0 {
        return min(retryAfterMs / 1000, 15)
    }
    return 1
}

// ---------------------------------------------------------------------------
// 汇总文案（Windows AccountSection.tsx:87-122 逐字复刻，纯函数可测）
// ---------------------------------------------------------------------------

/// 口语场景同步结果一句话（成功给计数，失败给原因；跳过项只报数量）。
func syncSummaryText(_ summary: SyncSummary) -> String {
    if !summary.ok {
        return "同步失败：\(summary.error ?? "未知错误")"
    }
    var parts = ["拉取 \(summary.pulled) 项", "推送 \(summary.pushed) 项"]
    if summary.conflicts > 0 { parts.append("冲突处理 \(summary.conflicts) 次") }
    if summary.keptLocal > 0 { parts.append("本地较新保留 \(summary.keptLocal) 项") }
    if !summary.skipped.isEmpty { parts.append("跳过 \(summary.skipped.count) 项") }
    return "同步完成（\(parts.joined(separator: "，"))）"
}

/// 多集合同步汇总合并（各集合 syncNow 结果并成一句话的口径：ok 取与、计数
/// 累加、skipped 拼接、error 取首个）。
func mergeSyncSummaries(_ list: [SyncSummary]) -> SyncSummary {
    var merged = SyncSummary()
    for summary in list {
        merged.ok = merged.ok && summary.ok
        merged.pulled += summary.pulled
        merged.appliedRemote += summary.appliedRemote
        merged.keptLocal += summary.keptLocal
        merged.pushed += summary.pushed
        merged.conflicts += summary.conflicts
        merged.skipped.append(contentsOf: summary.skipped)
        if merged.error == nil { merged.error = summary.error }
    }
    return merged
}
