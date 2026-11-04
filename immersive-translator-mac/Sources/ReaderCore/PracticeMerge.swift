import Foundation

// ---------------------------------------------------------------------------
// 练习任务离线合并（packages/learning-core/src/practiceMerge.ts 的 Swift 等价实现；
// Rust 参照 learning_store.rs merge_practice_fields / merge_practice_payload）。
//
// 寄存器代数：任务/attempt 的每个叶字段是一个 LWW 寄存器，键是 JSON Pointer
// 路径（`~`→`~0`、`/`→`~1`），时钟存 `fieldUpdatedAt`；无值但有时钟 = 显式清除；
// 相等时钟用规范 JSON 按 Unicode scalar 序稳定决胜（undefined 的哨兵为 U+10FFFF）；
// 类型冲突时不可见的旧值存 `fieldShadow`，保证任意合并顺序收敛。
// attempts 按 id 并集、`createdAt/id` 稳定排序；`removedAttemptIds` 单调并集且删除优先。
// ---------------------------------------------------------------------------

public enum PracticeMergeError: Error, LocalizedError, Equatable {
    case taskIDsDiffer

    public var errorDescription: String? {
        switch self {
        case .taskIDsDiffer: return "Practice task IDs differ"
        }
    }
}

/// 顶层不进寄存器的键（时钟/影子/集合字段另行处理）。
private let practiceIgnoredKeys: Set<String> = ["updatedAt", "fieldUpdatedAt", "fieldShadow", "attempts", "removedAttemptIds"]

/// undefined 的编码哨兵（U+10FFFF，排在一切规范 JSON 之后）。
private let practiceUndefinedSentinel = "\u{10FFFF}"

/// 寄存器：逻辑时钟 + 值（nil = undefined，即清除）。
private struct PracticeRegister {
    var at: Int64
    var value: Any?
}

private typealias PracticeRegisters = [String: PracticeRegister]

/// 逻辑时间：有限非负数字取整，否则 0（practiceMerge.ts time）。
func practiceTime(_ value: Any?) -> Int64 {
    guard let number = LearningJSON.number(value), number.isFinite, number >= 0 else { return 0 }
    return number >= 9.2e18 ? Int64.max : Int64(number)
}

private func practiceClocks(_ row: JSONObject) -> JSONObject {
    LearningJSON.object(row["fieldUpdatedAt"]) ?? [:]
}

private func practiceEscape(_ key: String) -> String {
    key.replacingOccurrences(of: "~", with: "~0").replacingOccurrences(of: "/", with: "~1")
}

private func practiceParts(_ path: String) -> [String] {
    path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map {
        $0.replacingOccurrences(of: "~1", with: "/").replacingOccurrences(of: "~0", with: "~")
    }
}

/// 规范 JSON（键 Unicode scalar 序、滤 undefined）。
private func practiceStable(_ value: Any?) -> String {
    LearningJSON.stringify(value, keyOrder: .scalar)
}

private func practiceEncoded(_ value: Any?) -> String {
    LearningJSON.isUndefined(value) ? practiceUndefinedSentinel : practiceStable(value)
}

/// 行 → 叶路径映射（对象递归到叶；空对象 / 数组 / 标量是叶）。
private func practiceFlatten(_ row: JSONObject) -> [String: Any] {
    var result: [String: Any] = [:]
    func visit(_ value: Any?, _ path: String) {
        guard let value = LearningJSON.unwrap(value) else { return }
        if let fields = value as? JSONObject, fields.keys.contains(where: { !LearningJSON.isUndefined(fields[$0]) }) {
            for key in fields.keys {
                visit(fields[key], "\(path)/\(practiceEscape(key))")
            }
        } else {
            result[path] = value
        }
    }
    for key in row.keys where !practiceIgnoredKeys.contains(key) {
        visit(row[key], "/\(practiceEscape(key))")
    }
    return result
}

/// 行 → 寄存器表：叶值 + fieldShadow 里的隐藏值 + 只有时钟没有值的清除寄存器。
/// 时钟来源优先级：路径显式时钟 → 旧根字段时钟 → fallback。
private func practiceRegisters(_ row: JSONObject, fallback: Int64) -> PracticeRegisters {
    var values = practiceFlatten(row)
    if let shadows = LearningJSON.object(row["fieldShadow"]) {
        for (path, value) in shadows where path.hasPrefix("/") {
            if let value = LearningJSON.unwrap(value) {
                values[path] = value
            }
        }
    }
    let clocks = practiceClocks(row)
    var result: PracticeRegisters = [:]
    for (path, value) in values {
        let root = practiceParts(path).first ?? ""
        let explicit = practiceTime(clocks[path])
        let legacy = practiceTime(clocks[root])
        result[path] = PracticeRegister(at: explicit > 0 ? explicit : (legacy > 0 ? legacy : fallback), value: value)
    }
    for (key, at) in clocks {
        let path = key.hasPrefix("/") ? key : "/\(practiceEscape(key))"
        if result[path] == nil && (key.hasPrefix("/") || LearningJSON.isUndefined(row[key])) {
            result[path] = PracticeRegister(at: practiceTime(at), value: nil)
        }
    }
    return result
}

/// 寄存器全序：时钟升序，再按编码值 scalar 序。
private func practiceRank(_ a: PracticeRegister, _ b: PracticeRegister) -> Int {
    if a.at != b.at { return a.at < b.at ? -1 : 1 }
    return LearningJSON.scalarCompare(practiceEncoded(a.value), practiceEncoded(b.value))
}

/// 按路径把值写进嵌套字典（中间非对象一律换成 {}）。
private func practiceAssign(_ target: inout JSONObject, _ keys: ArraySlice<String>, _ value: Any) {
    guard let key = keys.first else { return }
    if keys.count == 1 {
        target[key] = value
        return
    }
    var child = LearningJSON.object(target[key]) ?? [:]
    practiceAssign(&child, keys.dropFirst(), value)
    target[key] = child
}

/// 寄存器表 → 可见行（含 updatedAt / fieldUpdatedAt / fieldShadow）。
private func practiceMaterialize(_ regs: PracticeRegisters, updatedAt: Int64) -> JSONObject {
    let all = regs.map { ($0.key, $0.value) }
    func blocked(_ path: String, _ reg: PracticeRegister) -> Bool {
        all.contains { p, r in path.hasPrefix(p + "/") && practiceRank(r, reg) >= 0 }
    }
    var visible: [String: Any] = [:]
    for (path, reg) in all {
        guard let value = reg.value else { continue }
        if blocked(path, reg) { continue }
        let descendant = all.contains { p, r in
            p.hasPrefix(path + "/") && r.value != nil && practiceRank(r, reg) > 0 && !blocked(p, r)
        }
        if !descendant {
            visible[path] = value
        }
    }
    var result: JSONObject = [:]
    for path in LearningJSON.sortedKeys(Array(visible.keys), order: .scalar) {
        practiceAssign(&result, practiceParts(path)[...], visible[path]!)
    }
    var clocks: JSONObject = [:]
    var shadows: JSONObject = [:]
    var latest = updatedAt
    for (path, reg) in all {
        clocks[path] = reg.at
        latest = max(latest, reg.at)
        if let value = reg.value, visible[path] == nil {
            shadows[path] = value
        }
    }
    result["updatedAt"] = latest
    result["fieldUpdatedAt"] = clocks
    // 隐藏的前缀/叶值少见；保留它们以避免与顺序相关的类型切换。
    if !shadows.isEmpty {
        result["fieldShadow"] = shadows
    }
    return result
}

/// 两行字段合并（寄存器按全序取大）。公开供存储层 / 测试复用
/// （Rust merge_practice_fields 对应物）。
public func mergePracticeFields(_ a: JSONObject, _ b: JSONObject, fallbackA: Int64, fallbackB: Int64) -> JSONObject {
    var regs = practiceRegisters(a, fallback: fallbackA)
    for (path, reg) in practiceRegisters(b, fallback: fallbackB) {
        if let old = regs[path] {
            if practiceRank(reg, old) > 0 { regs[path] = reg }
        } else {
            regs[path] = reg
        }
    }
    return practiceMaterialize(
        regs,
        updatedAt: max(max(practiceTime(a["updatedAt"]), practiceTime(b["updatedAt"])), max(fallbackA, fallbackB))
    )
}

/// 只给真正变化的叶字段盖章；无可见/影子值的时钟即字段清除。
/// 对象提升（旧父标量被清、同一编辑写入子字段）时给新叶比父清除更晚的逻辑 tick。
private func practiceStampFields(_ previous: JSONObject?, _ next: JSONObject, at: Int64, fallback: Int64) -> JSONObject {
    var regs = previous.map { practiceRegisters($0, fallback: fallback) }
        ?? practiceRegisters(next, fallback: practiceTime(next["updatedAt"]))
    let before = practiceFlatten(previous ?? [:])
    let after = practiceFlatten(next)
    for path in Set(before.keys).union(after.keys) {
        if previous == nil || practiceEncoded(before[path]) != practiceEncoded(after[path]) {
            let bumped = previous != nil ? (regs[path]?.at ?? 0) + 1 : 0
            regs[path] = PracticeRegister(at: max(practiceTime(at), bumped), value: after[path])
        }
    }
    for (path, value) in after {
        if previous != nil, practiceEncoded(before[path]) == practiceEncoded(value) { continue }
        let ancestors = regs.filter { path.hasPrefix($0.key + "/") }.map { $0.value.at + 1 }
        guard var reg = regs[path] else { continue }
        reg.at = max(reg.at, ancestors.max() ?? reg.at)
        regs[path] = reg
    }
    return practiceMaterialize(regs, updatedAt: max(practiceTime(at), practiceTime(previous?["updatedAt"])))
}

/// 读取字符串 id 集合（removedAttemptIds）。
private func practiceStringIDs(_ value: Any?) -> [String] {
    (LearningJSON.array(value) ?? []).compactMap { LearningJSON.string($0) }
}

private func practiceIDText(_ value: Any?) -> String {
    if let text = LearningJSON.string(value) { return text }
    guard let value = LearningJSON.unwrap(value) else { return "undefined" }
    if value is NSNull { return "null" }
    if let number = LearningJSON.number(value) { return LearningJSON.numberString(number) }
    return String(describing: value)
}

/// 盖章：以产生该编辑的 previous 为基准，只给变化字段盖 `max(at, prevClock+1)`。
/// attempts 逐条按 id 对位盖章；removedAttemptIds 单调并集并从 attempts 里滤除。
public func stampPracticeTask(previous: JSONObject?, next: JSONObject, at: Int64) -> JSONObject {
    var result = practiceStampFields(previous, next, at: at, fallback: practiceTime(previous?["updatedAt"]))
    let oldAttempts = (LearningJSON.array(previous?["attempts"]) ?? []).compactMap { LearningJSON.object($0) }
    var attempts = (LearningJSON.array(next["attempts"]) ?? []).compactMap { LearningJSON.object($0) }.map { attempt -> JSONObject in
        let old = oldAttempts.first { candidate in
            let lhs = LearningJSON.unwrap(candidate["id"]), rhs = LearningJSON.unwrap(attempt["id"])
            if lhs == nil && rhs == nil { return true }
            return lhs != nil && rhs != nil && LearningJSON.equal(lhs, rhs)
        }
        let oldClock = practiceTime(old?["updatedAt"])
        return practiceStampFields(old, attempt, at: at, fallback: oldClock > 0 ? oldClock : practiceTime(previous?["updatedAt"]))
    }
    let removed = Set(practiceStringIDs(previous?["removedAttemptIds"]) + practiceStringIDs(next["removedAttemptIds"]))
    if !removed.isEmpty {
        result["removedAttemptIds"] = LearningJSON.sortedKeys(Array(removed), order: .scalar)
        attempts = attempts.filter { !removed.contains(practiceIDText($0["id"])) }
    }
    result["attempts"] = attempts
    return result
}

/// 任务合并：ID 不同抛错；字段走寄存器代数；attempts 按 id 并集（每条先自归一再
/// 两两合并）、按 createdAt/id 稳定排序；removedAttemptIds 单调并集且删除优先。
public func mergePracticeTask(existing a: JSONObject, incoming b: JSONObject) throws -> JSONObject {
    guard let id = LearningJSON.string(a["id"]), LearningJSON.string(b["id"]) == id else {
        throw PracticeMergeError.taskIDsDiffer
    }
    let ta = practiceTime(a["updatedAt"]), tb = practiceTime(b["updatedAt"])
    var result = mergePracticeFields(a, b, fallbackA: ta, fallbackB: tb)
    let removed = Set(practiceStringIDs(a["removedAttemptIds"]) + practiceStringIDs(b["removedAttemptIds"]))
    var attempts: [String: JSONObject] = [:]
    for (task, fallback) in [(a, ta), (b, tb)] {
        for attempt in (LearningJSON.array(task["attempts"]) ?? []).compactMap({ LearningJSON.object($0) }) {
            guard let attemptId = LearningJSON.string(attempt["id"]), !removed.contains(attemptId) else { continue }
            let own = practiceTime(attempt["updatedAt"])
            let clock = own > 0 ? own : fallback
            let normalized = mergePracticeFields(attempt, attempt, fallbackA: clock, fallbackB: clock)
            if let old = attempts[attemptId] {
                attempts[attemptId] = mergePracticeFields(
                    old, normalized,
                    fallbackA: practiceTime(old["updatedAt"]),
                    fallbackB: practiceTime(normalized["updatedAt"])
                )
            } else {
                attempts[attemptId] = normalized
            }
        }
    }
    result["attempts"] = attempts.values.sorted { x, y in
        let cx = practiceTime(x["createdAt"]), cy = practiceTime(y["createdAt"])
        if cx != cy { return cx < cy }
        return LearningJSON.scalarCompare(practiceIDText(x["id"]), practiceIDText(y["id"])) < 0
    }
    if !removed.isEmpty {
        result["removedAttemptIds"] = LearningJSON.sortedKeys(Array(removed), order: .scalar)
    }
    return result
}

/// 信封合并：双方 kind 都是 practice-task 且 task.id 相同才合并，否则 nil
/// （nil 表示它们不是同一练习信封的两个活版本）。endedAt=updatedAt=max。
/// 任一侧 tombstone 不得进此函数——由调用方拦截。
public func mergePracticePayload(existing: Any?, incoming: Any?) -> JSONObject? {
    guard let a = LearningJSON.object(existing), let b = LearningJSON.object(incoming),
          LearningJSON.string(a["kind"]) == "practice-task", LearningJSON.string(b["kind"]) == "practice-task",
          let aTask = LearningJSON.object(a["task"]), let bTask = LearningJSON.object(b["task"]),
          let id = LearningJSON.string(aTask["id"]), LearningJSON.string(bTask["id"]) == id else {
        return nil
    }
    let ta = practiceTime(a["updatedAt"]), tb = practiceTime(b["updatedAt"])
    var envelopeA = a, envelopeB = b
    envelopeA.removeValue(forKey: "task")
    envelopeB.removeValue(forKey: "task")
    envelopeA["endedAt"] = max(ta, tb)
    envelopeB["endedAt"] = max(ta, tb)
    var result = mergePracticeFields(envelopeA, envelopeB, fallbackA: ta, fallbackB: tb)
    let task = (try? mergePracticeTask(existing: aTask, incoming: bTask)) ?? aTask
    result["task"] = task
    let updatedAt = max(max(ta, tb), practiceTime(task["updatedAt"]))
    result["updatedAt"] = updatedAt
    result["endedAt"] = updatedAt
    return result
}
