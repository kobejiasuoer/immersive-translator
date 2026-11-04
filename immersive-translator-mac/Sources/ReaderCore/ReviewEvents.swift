import Foundation

// ---------------------------------------------------------------------------
// 不可变复习事件与确定性归并（packages/learning-core/src/reviewEvents.ts 的
// Swift 等价实现；Rust 参照 learning_store.rs reduce_word / active_events）。
//
// 事件以 JSON 字典承载（与同步实体 payload 同形，未知字段原样保留）：
// `{v:2,id,wordId,deviceId,reviewedAt,kind:"grade"|"undo",mode,generation?,grade?,
//   recall?:{bucket,answer?,expected?},supersedesEventId?,reversesEventId?,day?}`。
// baseline 是迁移时的真实 SRS 快照，绝不伪造历史事件。
// ---------------------------------------------------------------------------

public enum ReviewEventError: Error, LocalizedError, Equatable {
    case invalidEvent
    /// 同 ID 不同内容：不可变记录冲突（文案与 Windows 完全一致，含事件 id）。
    case immutableConflict(String)

    public var errorDescription: String? {
        switch self {
        case .invalidEvent: return "Invalid review event"
        case let .immutableConflict(id): return "Immutable review event conflict: \(id)"
        }
    }
}

/// 归并结果：演进后的 SRS、生效（winner）事件、错题分桶。
public struct ReviewReduction {
    public var srs: VocabSrsState
    public var activeEvents: [JSONObject]
    public var recall: RecallStat

    public init(srs: VocabSrsState, activeEvents: [JSONObject], recall: RecallStat) {
        self.srs = srs
        self.activeEvents = activeEvents
        self.recall = recall
    }
}

private let reviewGradeNames: Set<String> = ["forgot", "hard", "good", "easy"]
private let recallBucketNames: Set<String> = ["pass", "wrong", "trap"]
private let dayPattern = try! NSRegularExpression(pattern: "^\\d{4}-\\d{2}-\\d{2}$")

/// `isReviewEvent` 形状校验（reviewEvents.ts:10-19 逐条）。
public func isReviewEvent(_ value: Any?) -> Bool {
    guard let v = LearningJSON.object(value) else { return false }
    guard LearningJSON.number(v["v"]) == 2 else { return false }
    for key in ["id", "wordId", "deviceId", "mode"] {
        guard let text = LearningJSON.string(v[key]), !text.isEmpty else { return false }
    }
    guard let reviewedAt = LearningJSON.number(v["reviewedAt"]), reviewedAt.isFinite, reviewedAt >= 0 else {
        return false
    }
    if !LearningJSON.isUndefined(v["generation"]) {
        guard let generation = LearningJSON.string(v["generation"]), !generation.isEmpty else { return false }
    }
    if !LearningJSON.isUndefined(v["day"]) {
        guard let day = LearningJSON.string(v["day"]),
              dayPattern.firstMatch(in: day, range: NSRange(day.startIndex..., in: day)) != nil else {
            return false
        }
    }
    let id = LearningJSON.string(v["id"]) ?? ""
    let kind = LearningJSON.string(v["kind"])
    if kind == "undo" {
        guard let reverses = LearningJSON.string(v["reversesEventId"]) else { return false }
        return reverses != id && !LearningJSON.truthy(v["grade"]) && !LearningJSON.truthy(v["supersedesEventId"])
    }
    guard kind == "grade",
          let grade = LearningJSON.string(v["grade"]), reviewGradeNames.contains(grade),
          !LearningJSON.truthy(v["reversesEventId"]) else {
        return false
    }
    if !LearningJSON.isUndefined(v["supersedesEventId"]) {
        guard let supersedes = LearningJSON.string(v["supersedesEventId"]), supersedes != id else { return false }
    }
    if LearningJSON.isUndefined(v["recall"]) { return true }
    guard let recall = LearningJSON.object(v["recall"]) else { return false }
    let bucket = LearningJSON.string(recall["bucket"]) ?? String(describing: LearningJSON.unwrap(recall["bucket"]) ?? "undefined")
    return recallBucketNames.contains(bucket)
}

/// 规范 JSON（键 UTF-16 序、滤 undefined），复习事件不可变比较与 contentRevision
/// 的哈希输入（reviewEvents.ts:20-24）。
public func canonicalJSON(_ value: Any?) -> String {
    LearningJSON.stringify(value, keyOrder: .utf16)
}

/// 事件排序键：reviewedAt 升序，再按 id 字节序（ASCII UUID 下与
/// `localeCompare(id, "en")` 一致）。
private func reviewEventOrder(_ a: JSONObject, _ b: JSONObject) -> Bool {
    let ta = LearningJSON.number(a["reviewedAt"]) ?? 0
    let tb = LearningJSON.number(b["reviewedAt"]) ?? 0
    if ta != tb { return ta < tb }
    let ia = LearningJSON.string(a["id"]) ?? ""
    let ib = LearningJSON.string(b["id"]) ?? ""
    return Array(ia.utf8).lexicographicallyPrecedes(Array(ib.utf8))
}

/// 从事件集合里算出生效事件（reviewEvents.ts:35-47）：逆序把 undo/supersede 目标
/// 禁用；同根并发改评只留一个 winner；返回按时间排序的 winner。
public func activeReviewEvents(_ sorted: [JSONObject]) -> [JSONObject] {
    var disabled = Set<String>()
    var index = sorted.count - 1
    while index >= 0 {
        let event = sorted[index]
        let id = LearningJSON.string(event["id"]) ?? ""
        if !disabled.contains(id) {
            let kind = LearningJSON.string(event["kind"])
            let target = LearningJSON.string(event[kind == "undo" ? "reversesEventId" : "supersedesEventId"])
            if let target, sorted[0..<index].contains(where: {
                LearningJSON.string($0["id"]) == target && LearningJSON.string($0["kind"]) == "grade"
            }) {
                disabled.insert(target)
            }
        }
        index -= 1
    }
    let grades = sorted.filter { LearningJSON.string($0["kind"]) == "grade" }
    var roots: [String: String] = [:]
    for event in grades {
        let id = LearningJSON.string(event["id"]) ?? ""
        if let supersedes = LearningJSON.string(event["supersedesEventId"]), let root = roots[supersedes] {
            roots[id] = root
        } else {
            roots[id] = id
        }
    }
    var winners: [String: JSONObject] = [:]
    for event in grades {
        let id = LearningJSON.string(event["id"]) ?? ""
        if !disabled.contains(id) {
            winners[roots[id] ?? id] = event
        }
    }
    return winners.values.sorted(by: reviewEventOrder)
}

/// 从真实 baseline 快照逐事件演进 SRS 与错题分桶（reviewEvents.ts:26-55）。
/// - 同 ID 不同内容抛 `immutableConflict`；形状不合法抛 `invalidEvent`。
/// - 只收 wordId 相同且代际匹配的事件：无 generation 的旧事件只归 `legacy-` 代。
public func reduceReviewEvents(
    baseline: VocabSrsState,
    input: [JSONObject],
    wordId: String,
    generation: String?,
    baselineRecall: RecallStat? = nil
) throws -> ReviewReduction {
    var unique: [String: JSONObject] = [:]
    for event in input {
        guard isReviewEvent(event) else { throw ReviewEventError.invalidEvent }
        let id = LearningJSON.string(event["id"]) ?? ""
        if let existing = unique[id], canonicalJSON(existing) != canonicalJSON(event) {
            throw ReviewEventError.immutableConflict(id)
        }
        unique[id] = event
    }
    let events = unique.values.filter { event in
        guard LearningJSON.string(event["wordId"]) == wordId else { return false }
        let eventGeneration = LearningJSON.string(event["generation"])
        if eventGeneration == generation { return true }
        return eventGeneration == nil && (generation?.hasPrefix("legacy-") ?? false)
    }.sorted(by: reviewEventOrder)
    let active = activeReviewEvents(events)
    var srs = baseline
    var recall: RecallStat
    if let baselineRecall {
        recall = baselineRecall
    } else {
        recall = RecallStat(total: RecallModeStat(), byMode: [:], lastAt: nil)
    }
    for event in active {
        guard let gradeName = LearningJSON.string(event["grade"]), let grade = ReviewGrade(rawValue: gradeName) else { continue }
        let reviewedAt = Int64(LearningJSON.number(event["reviewedAt"]) ?? 0)
        srs = gradeSrs(srs, grade, now: reviewedAt)
        if let recallInfo = LearningJSON.object(event["recall"]),
           let bucket = LearningJSON.string(recallInfo["bucket"]),
           let mode = LearningJSON.string(event["mode"]) {
            var counts = recall.byMode[mode] ?? RecallModeStat()
            bump(&counts, bucket)
            recall.byMode[mode] = counts
            bump(&recall.total, bucket)
            recall.lastAt = reviewedAt
        }
    }
    return ReviewReduction(srs: srs, activeEvents: active, recall: recall)
}

private func bump(_ counts: inout RecallModeStat, _ bucket: String) {
    switch bucket {
    case "pass": counts.pass += 1
    case "wrong": counts.wrong += 1
    case "trap": counts.trap += 1
    default: break
    }
}

// MARK: - SRS 快照 ↔ JSON（存储层以 JSON 字典承载词条时使用）

extension VocabSrsState {
    /// JSON 字典 → SRS（缺省值与 Rust ensure_baseline 的缺省快照一致）。
    public init(json: Any?) {
        let dict = LearningJSON.object(json) ?? [:]
        self.init(
            ease: LearningJSON.number(dict["ease"]) ?? 2.5,
            intervalDays: LearningJSON.number(dict["intervalDays"]) ?? 0,
            reps: Int(LearningJSON.number(dict["reps"]) ?? 0),
            dueAt: Int64(LearningJSON.number(dict["dueAt"]) ?? 0),
            lapses: Int(LearningJSON.number(dict["lapses"]) ?? 0)
        )
    }

    public var jsonObject: JSONObject {
        ["ease": ease, "intervalDays": intervalDays, "reps": reps, "dueAt": dueAt, "lapses": lapses]
    }
}

extension RecallModeStat {
    public init(json: Any?) {
        let dict = LearningJSON.object(json) ?? [:]
        self.init(
            pass: Int(LearningJSON.number(dict["pass"]) ?? 0),
            wrong: Int(LearningJSON.number(dict["wrong"]) ?? 0),
            trap: Int(LearningJSON.number(dict["trap"]) ?? 0)
        )
    }

    public var jsonObject: JSONObject { ["pass": pass, "wrong": wrong, "trap": trap] }
}

extension RecallStat {
    /// JSON 字典 → 错题记录（非对象视为空记录）。
    public init(json: Any?) {
        let dict = LearningJSON.object(json) ?? [:]
        var byMode: [String: RecallModeStat] = [:]
        for (key, value) in LearningJSON.object(dict["byMode"]) ?? [:] {
            byMode[key] = RecallModeStat(json: value)
        }
        self.init(
            total: RecallModeStat(json: dict["total"]),
            byMode: byMode,
            lastAt: LearningJSON.int64(dict["lastAt"])
        )
    }

    public var jsonObject: JSONObject {
        var out: JSONObject = [
            "total": total.jsonObject,
            "byMode": byMode.mapValues { $0.jsonObject },
        ]
        if let lastAt { out["lastAt"] = lastAt }
        return out
    }
}
