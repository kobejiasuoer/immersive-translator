import Foundation

// ---------------------------------------------------------------------------
// 学习接力正文实体编解码（packages/learning-core/src/relay.ts 的 Swift 等价实现；
// Rust 参照 learning_store.rs project_article / revision / scrub）。
//
// v2 载荷复用 reading-articles 集合，分三类实体：
// - content-chunk：`chunk:<articleId>:<contentRevision>:<batchHash>`，句子按
//   262144 字节目标分批，正文不可变（译文/标注变化即换 ID）；
// - article manifest：原文章去 sentences/progress，带 v:2 / kind / contentRevision / chunkIds；
// - progress：`progress:<articleId>:<deviceId>`，locator.sentenceId 稳定定位。
// 音频字节、本机路径一律不进载荷（withoutAudio）。
// ---------------------------------------------------------------------------

/// 正文实体（RelayEntity）。payload 以 JSON 字典承载，未知字段原样保留。
public struct RelayEntity: Equatable {
    public var id: String
    public var schemaVersion: Int
    public var payload: JSONObject
    public var updatedAt: Int64
    public var deleted: Bool

    public init(id: String, schemaVersion: Int = 2, payload: JSONObject, updatedAt: Int64, deleted: Bool = false) {
        self.id = id
        self.schemaVersion = schemaVersion
        self.payload = payload
        self.updatedAt = updatedAt
        self.deleted = deleted
    }

    public static func == (lhs: RelayEntity, rhs: RelayEntity) -> Bool {
        lhs.id == rhs.id && lhs.schemaVersion == rhs.schemaVersion && lhs.updatedAt == rhs.updatedAt
            && lhs.deleted == rhs.deleted && LearningJSON.equal(lhs.payload, rhs.payload)
    }
}

public enum RelayError: Error, LocalizedError, Equatable {
    case invalidOptions
    case sentenceExceedsChunkLimit(Int)

    public var errorDescription: String? {
        switch self {
        case .invalidOptions: return "Invalid relay options"
        case let .sentenceExceedsChunkLimit(idx): return "Sentence exceeds content chunk limit: \(idx)"
        }
    }
}

/// 内容分块默认目标字节数。
public let relayDefaultChunkTargetBytes = 262_144

// MARK: - 音频剥离

/// 私有音频/本机路径键黑名单（比较一律小写）。
private let relayPrivateAudioKeys: Set<String> = [
    "audio", "audiob64", "audiobase64", "audio_base64", "pcmb64", "pcm",
    "pcm_base64", "wavb64", "wav", "blob", "audiofile", "audiopath", "localpath",
]

/// 黑名单键判定：精确命中，或 JSON Pointer 形态键（`/a/b`，`~1`→`/`、`~0`→`~` 还原后）
/// 任一路径段命中——fieldShadow 里藏的音频键同样剥除。
public func isPrivateAudioKey(_ key: String) -> Bool {
    if relayPrivateAudioKeys.contains(key.lowercased()) { return true }
    guard key.hasPrefix("/") else { return false }
    return key.dropFirst().split(separator: "/", omittingEmptySubsequences: false).contains { part in
        let restored = part
            .replacingOccurrences(of: "~1", with: "/")
            .replacingOccurrences(of: "~0", with: "~")
            .lowercased()
        return relayPrivateAudioKeys.contains(restored)
    }
}

/// 递归剥离音频字节与源设备私有路径键（relay.ts:54-59 / Rust scrub）。
/// clipId / deviceId 等引用字段保留——原录音只留在录制它的设备。
public func withoutAudio(_ value: Any?) -> Any? {
    guard let value = LearningJSON.unwrap(value) else { return nil }
    if let array = value as? [Any] {
        return array.map { withoutAudio($0) ?? NSNull() }
    }
    guard let dict = value as? JSONObject else { return value }
    var out: JSONObject = [:]
    for (key, child) in dict where !isPrivateAudioKey(key) && !LearningJSON.isUndefined(child) {
        out[key] = withoutAudio(child)
    }
    return out
}

/// 字典版本（调用方已知是对象时免再转型）。
public func withoutAudioObject(_ dict: JSONObject) -> JSONObject {
    (withoutAudio(dict) as? JSONObject) ?? [:]
}

// MARK: - 深度保留合并

/// 载荷深合并（relay.ts:41-53 mergeRelayPayload）：incoming 标量覆盖；对象递归合并；
/// 数组按 id/idx 对位合并（对不上的原样保留）——旧客户端写回不得剥离未知嵌套字段。
public func mergeRelayPayload(existing: Any?, incoming: JSONObject) -> JSONObject {
    let old = LearningJSON.object(existing) ?? [:]
    var result = old
    for (key, value) in incoming {
        result[key] = value
    }
    for (key, value) in incoming {
        let previous = old[key]
        if let dict = LearningJSON.object(value) {
            result[key] = mergeRelayPayload(existing: previous, incoming: dict)
        } else if let array = LearningJSON.array(value), let oldArray = LearningJSON.array(previous) {
            result[key] = array.map { item -> Any in
                guard let row = LearningJSON.object(item) else { return item }
                let match = oldArray.first { candidate in
                    guard let prior = LearningJSON.object(candidate) else { return false }
                    if !LearningJSON.isUndefined(row["id"]), !LearningJSON.isUndefined(prior["id"]),
                       LearningJSON.equal(prior["id"], row["id"]) {
                        return true
                    }
                    if !LearningJSON.isUndefined(row["idx"]), !LearningJSON.isUndefined(prior["idx"]),
                       LearningJSON.equal(prior["idx"], row["idx"]) {
                        return true
                    }
                    return false
                }
                return mergeRelayPayload(existing: match, incoming: row)
            }
        }
    }
    return result
}

// MARK: - 内容修订哈希

/// FNV-1a 32 位，按 **UTF-16 code unit** 遍历规范 JSON（JS charCodeAt / Rust
/// encode_utf16 同口径，含 emoji 代理对），base36 输出。
public func relayRevisionOf(_ value: Any?) -> String {
    let text = canonicalJSON(value)
    var hash: UInt32 = 2_166_136_261
    for unit in text.utf16 {
        hash ^= UInt32(unit)
        hash = hash &* 16_777_619
    }
    return String(hash, radix: 36)
}

/// 句子集合的内容修订：去掉顶层派生 `id`、剥音频后做规范哈希（relay.ts:13-15）。
public func contentRevision(_ sentences: [JSONObject]) -> String {
    let rows = sentences.map { sentence -> Any in
        var content = withoutAudioObject(sentence)
        content.removeValue(forKey: "id")
        return content
    }
    return relayRevisionOf(rows)
}

/// 句子稳定 ID（`<articleId>:s<idx>`；修订号参数保留签名兼容，不参与）。
public func relaySentenceID(articleId: String, revision _: String, idx: Int) -> String {
    "\(articleId):s\(idx)"
}

// MARK: - 文章 → 实体三件套

/// 文章（JSON 字典，含 sentences / progress / createdAt / lastReadAt）→ content-chunk
/// 若干 + manifest + progress（relay.ts:17-31）。
/// - deviceId 空或 targetBytes < 1024 抛 `invalidOptions`；单句超限抛
///   `sentenceExceedsChunkLimit(idx)`。
public func entitiesFromArticle(
    _ article: JSONObject,
    deviceId: String,
    targetBytes: Int = relayDefaultChunkTargetBytes
) throws -> [RelayEntity] {
    guard !deviceId.isEmpty, targetBytes >= 1024 else { throw RelayError.invalidOptions }
    let articleId = LearningJSON.string(article["id"]) ?? ""
    let sentences = (LearningJSON.array(article["sentences"]) ?? []).compactMap { LearningJSON.object($0) }
    let revision = contentRevision(sentences)
    let lastReadAt = LearningJSON.int64(article["lastReadAt"]) ?? 0
    let createdAt = LearningJSON.int64(article["createdAt"]) ?? 0
    let updatedAt = max(lastReadAt, createdAt)
    var chunks: [RelayEntity] = []
    var batch: [JSONObject] = []
    func flush() {
        guard !batch.isEmpty else { return }
        let id = "chunk:\(articleId):\(revision):\(relayRevisionOf(batch))"
        chunks.append(RelayEntity(
            id: id,
            schemaVersion: 2,
            payload: [
                "v": 2,
                "kind": "content-chunk",
                "articleId": articleId,
                "contentRevision": revision,
                "sentences": batch,
            ],
            updatedAt: updatedAt
        ))
        batch = []
    }
    for sentence in sentences {
        var row = withoutAudioObject(sentence)
        let idx = Int(LearningJSON.number(sentence["idx"]) ?? 0)
        if LearningJSON.string(sentence["id"]).map({ !$0.isEmpty }) != true {
            row["id"] = relaySentenceID(articleId: articleId, revision: revision, idx: idx)
        }
        if !batch.isEmpty, LearningJSON.byteCount(batch + [row]) > targetBytes {
            flush()
        }
        if LearningJSON.byteCount(row) > targetBytes {
            throw RelayError.sentenceExceedsChunkLimit(idx)
        }
        batch.append(row)
    }
    flush()
    var meta = withoutAudioObject(article)
    meta.removeValue(forKey: "sentences")
    meta.removeValue(forKey: "progress")
    meta["v"] = 2
    meta["kind"] = "article"
    meta["contentRevision"] = revision
    meta["chunkIds"] = chunks.map(\.id)
    let manifest = RelayEntity(id: articleId, schemaVersion: 2, payload: meta, updatedAt: updatedAt)
    let progressSource = LearningJSON.object(article["progress"]) ?? [:]
    let sentenceIdx = Int(LearningJSON.number(progressSource["sentenceIdx"]) ?? 0)
    var progress: JSONObject = [
        "v": 2,
        "kind": "progress",
        "articleId": articleId,
        "deviceId": deviceId,
        "contentRevision": revision,
        "locator": [
            "sentenceId": (sentenceIdx >= 0 && sentenceIdx < sentences.count
                ? LearningJSON.string(sentences[sentenceIdx]["id"]).flatMap { $0.isEmpty ? nil : $0 } : nil)
                ?? relaySentenceID(articleId: articleId, revision: revision, idx: sentenceIdx),
        ],
        "lastReadAt": lastReadAt,
    ]
    for (key, value) in progressSource {
        progress[key] = value
    }
    let progressEntity = RelayEntity(
        id: "progress:\(articleId):\(deviceId)",
        schemaVersion: 2,
        payload: progress,
        updatedAt: lastReadAt
    )
    return chunks + [manifest, progressEntity]
}

// MARK: - 实体 → 文章

/// 由实体集合组装文章（relay.ts:32-40）：manifest 引用的任一 chunk 缺失 /
/// 不是 content-chunk / articleId 或 contentRevision 不符 → 返回 nil，**不落半成品**。
/// progress 取同修订里 lastReadAt 最大者（并列按 id 字节序）。
public func articleFromEntities(id: String, entities: [RelayEntity]) -> JSONObject? {
    let live = entities.filter { !$0.deleted }
    guard let manifest = live.first(where: { $0.id == id && LearningJSON.string($0.payload["kind"]) == "article" }) else {
        return nil
    }
    let p = manifest.payload
    guard let chunkIds = LearningJSON.array(p["chunkIds"]) else { return nil }
    let revision = p["contentRevision"]
    var sentences: [JSONObject] = []
    for rawId in chunkIds {
        guard let chunkId = LearningJSON.string(rawId),
              let chunk = live.first(where: { $0.id == chunkId }),
              LearningJSON.string(chunk.payload["kind"]) == "content-chunk",
              LearningJSON.string(chunk.payload["articleId"]) == id,
              LearningJSON.equal(chunk.payload["contentRevision"], revision),
              let rows = LearningJSON.array(chunk.payload["sentences"]) else {
            return nil
        }
        sentences.append(contentsOf: rows.compactMap { LearningJSON.object($0) })
    }
    let positions = live.filter { entity in
        LearningJSON.string(entity.payload["kind"]) == "progress"
            && LearningJSON.string(entity.payload["articleId"]) == id
            && LearningJSON.equal(entity.payload["contentRevision"], revision)
    }.sorted { a, b in
        let la = LearningJSON.number(a.payload["lastReadAt"]) ?? 0
        let lb = LearningJSON.number(b.payload["lastReadAt"]) ?? 0
        if la != lb { return la > lb }
        return Array(a.id.utf8).lexicographicallyPrecedes(Array(b.id.utf8))
    }
    let position = positions.first?.payload
    let locator = LearningJSON.object(position?["locator"])
    let locatorId = LearningJSON.string(locator?["sentenceId"])
    let sentenceIdx = max(0, sentences.firstIndex { LearningJSON.string($0["id"]) == locatorId && locatorId != nil } ?? -1)
    var article = p
    article["id"] = id
    article["title"] = LearningJSON.string(p["title"]) ?? (LearningJSON.truthy(p["title"]) ? String(describing: p["title"]!) : "")
    article["sentences"] = sentences
    article["createdAt"] = LearningJSON.truthy(p["createdAt"]) ? (LearningJSON.number(p["createdAt"]) ?? 0) : Double(manifest.updatedAt)
    article["lastReadAt"] = LearningJSON.truthy(position?["lastReadAt"])
        ? (LearningJSON.number(position?["lastReadAt"]) ?? 0)
        : (LearningJSON.truthy(p["lastReadAt"]) ? (LearningJSON.number(p["lastReadAt"]) ?? 0) : 0)
    article["progress"] = [
        "sentenceIdx": sentenceIdx,
        "percent": LearningJSON.truthy(position?["percent"]) ? (LearningJSON.number(position?["percent"]) ?? 0) : 0,
        "secondsListened": LearningJSON.truthy(position?["secondsListened"]) ? (LearningJSON.number(position?["secondsListened"]) ?? 0) : 0,
    ] as JSONObject
    return article
}
