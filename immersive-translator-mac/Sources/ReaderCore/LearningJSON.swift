import Foundation

// ---------------------------------------------------------------------------
// 学习接力共享逻辑的 JSON 值工具（packages/learning-core 三模块的 Swift 等价实现
// 共用的底座）。值域沿用 JSONSerialization：[String: Any] / [Any] / String /
// NSNumber / Bool / NSNull；`nil`（含 Optional.none 装进 Any）代表 JS 的 undefined，
// NSNull 代表 JSON null——两者在寄存器代数里语义不同，全程区分。
//
// 字符串化刻意手写而不用 JSONSerialization / JSONEncoder：contentRevision 的
// FNV-1a 哈希、chunk 分块字节数、复习事件不可变比较都要与 JS `JSON.stringify`
// 逐字节一致（键序、转义、数字格式），任何运行时差异都会让 chunk ID 跨端分叉。
// ---------------------------------------------------------------------------

/// JSON 对象（JSONSerialization 字典）。
public typealias JSONObject = [String: Any]

public enum LearningJSON {
    // MARK: 取值

    /// 解开 Any 里包着的 Optional（`dict["k"] = Optional.none as Any` 这类坑）；
    /// 返回 nil 即 JS undefined。
    public static func unwrap(_ value: Any?) -> Any? {
        guard let value else { return nil }
        if case Optional<Any>.none = value { return nil }
        let mirror = Mirror(reflecting: value)
        if mirror.displayStyle == .optional {
            return mirror.children.first.map { unwrap($0.value) } ?? nil
        }
        return value
    }

    /// 是否 JS undefined（缺失）。
    public static func isUndefined(_ value: Any?) -> Bool {
        unwrap(value) == nil
    }

    /// 是否 JSON null。
    public static func isNull(_ value: Any?) -> Bool {
        unwrap(value) is NSNull
    }

    /// 字典（JS `typeof v === "object" && v !== null && !Array.isArray(v)`）。
    public static func object(_ value: Any?) -> JSONObject? {
        unwrap(value) as? JSONObject
    }

    public static func array(_ value: Any?) -> [Any]? {
        unwrap(value) as? [Any]
    }

    public static func string(_ value: Any?) -> String? {
        unwrap(value) as? String
    }

    /// 布尔判定（NSNumber 同时承载布尔与数字，按 CFBoolean 类型区分——
    /// JS `typeof true !== "number"` 的对应物）。
    public static func isBool(_ value: Any?) -> Bool {
        guard let number = unwrap(value) as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    public static func bool(_ value: Any?) -> Bool? {
        guard isBool(value), let number = unwrap(value) as? NSNumber else { return nil }
        return number.boolValue
    }

    /// 数字（排除布尔；JS `typeof v === "number"`）。
    public static func number(_ value: Any?) -> Double? {
        guard let number = unwrap(value) as? NSNumber, !isBool(number) else { return nil }
        return number.doubleValue
    }

    /// 整数（有限且无小数部分）。
    public static func int64(_ value: Any?) -> Int64? {
        guard let n = number(value), n.isFinite, n == n.rounded(), abs(n) < 9_223_372_036_854_775_000 else { return nil }
        return Int64(n)
    }

    /// JS 真值判定（`!v` 的反面）：undefined/null/false/0/NaN/"" 为假。
    public static func truthy(_ value: Any?) -> Bool {
        guard let value = unwrap(value) else { return false }
        if value is NSNull { return false }
        if let b = bool(value) { return b }
        if let n = number(value) { return n != 0 && !n.isNaN }
        if let s = value as? String { return !s.isEmpty }
        return true
    }

    // MARK: 相等

    /// 深相等（JS 结构相等口径：数值按值、布尔不与数字相等、undefined 只等于
    /// undefined、null 只等于 null）。
    public static func equal(_ lhs: Any?, _ rhs: Any?) -> Bool {
        let l = unwrap(lhs), r = unwrap(rhs)
        if l == nil && r == nil { return true }
        guard let l, let r else { return false }
        if l is NSNull || r is NSNull { return l is NSNull && r is NSNull }
        let lb = isBool(l), rb = isBool(r)
        if lb || rb { return lb && rb && bool(l) == bool(r) }
        if let ln = number(l), let rn = number(r) { return ln == rn }
        if let ls = l as? String, let rs = r as? String { return ls == rs }
        if let la = l as? [Any], let ra = r as? [Any] {
            return la.count == ra.count && zip(la, ra).allSatisfy { equal($0, $1) }
        }
        if let ld = l as? JSONObject, let rd = r as? JSONObject {
            let lk = ld.keys.filter { !isUndefined(ld[$0]) }
            let rk = rd.keys.filter { !isUndefined(rd[$0]) }
            guard Set(lk) == Set(rk) else { return false }
            return lk.allSatisfy { equal(ld[$0], rd[$0]) }
        }
        return false
    }

    // MARK: 字符串化（JS JSON.stringify 逐字节对齐）

    /// 键排序口径。
    public enum KeyOrder {
        /// `Object.keys(v).sort()`：UTF-16 code unit 序（reviewEvents.ts canonicalJson）。
        case utf16
        /// Unicode scalar 序（practiceMerge.ts compare；等价 Rust UTF-8 字节序）。
        case scalar
    }

    /// JS `JSON.stringify(string)`：仅转义 `"` `\` 与 < 0x20 的控制字符
    /// （\b \f \n \r \t 用短记法，其余 \u00xx 小写十六进制），非 ASCII 原样输出。
    public static func quote(_ text: String) -> String {
        var out = "\""
        out.reserveCapacity(text.utf8.count + 2)
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
        return out
    }

    /// JS `Number.prototype.toString()`（JSON.stringify 的数字输出）：整数不带小数点，
    /// 非有限为 null，-0 为 0，指数阈值 1e21 / 1e-6，指数不补零（1e-7 而非 1e-07）。
    public static func numberString(_ value: Double) -> String {
        if !value.isFinite { return "null" }
        if value == 0 { return "0" }
        // 2^53 以内的整数直接按整数打印；更大的整数走最短数字串 + 补零
        // （JS (2**60).toString() === "1152921504606847000"，不是精确展开）。
        if value == value.rounded(), abs(value) < 9_007_199_254_740_992 {
            return String(format: "%.0f", value)
        }
        // Swift 的 description 给出最短可往返数字串（与 JS 同为最短表示），
        // 这里只把科学计数法的阈值与格式重排成 JS 规则。
        let negative = value < 0
        let text = "\(abs(value))"
        var digits = ""
        var exponent = 0
        if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            let mantissa = String(text[..<e])
            exponent = Int(text[text.index(after: e)...]) ?? 0
            let parts = mantissa.split(separator: ".", omittingEmptySubsequences: false)
            let intPart = String(parts[0])
            let fracPart = parts.count > 1 ? String(parts[1]) : ""
            digits = intPart + fracPart
            exponent += intPart.count
        } else {
            let parts = text.split(separator: ".", omittingEmptySubsequences: false)
            let intPart = String(parts[0])
            let fracPart = parts.count > 1 ? String(parts[1]) : ""
            if intPart == "0" {
                let stripped = fracPart.drop(while: { $0 == "0" })
                exponent = -(fracPart.count - stripped.count)
                digits = String(stripped)
            } else {
                digits = intPart + fracPart
                exponent = intPart.count
            }
        }
        while digits.hasSuffix("0") && digits.count > 1 { digits.removeLast() }
        // 此时 value = 0.digits × 10^exponent，n = exponent，k = digits.count
        let k = digits.count
        let n = exponent
        var body: String
        if k <= n && n <= 21 {
            body = digits + String(repeating: "0", count: n - k)
        } else if 0 < n && n <= 21 {
            let idx = digits.index(digits.startIndex, offsetBy: n)
            body = String(digits[..<idx]) + "." + String(digits[idx...])
        } else if -6 < n && n <= 0 {
            body = "0." + String(repeating: "0", count: -n) + digits
        } else {
            let e = n - 1
            let sign = e < 0 ? "-" : "+"
            if k == 1 {
                body = digits + "e" + sign + String(abs(e))
            } else {
                body = String(digits.first!) + "." + String(digits.dropFirst()) + "e" + sign + String(abs(e))
            }
        }
        return negative ? "-" + body : body
    }

    /// 键排序。
    public static func sortedKeys(_ keys: [String], order: KeyOrder) -> [String] {
        switch order {
        case .utf16:
            return keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
        case .scalar:
            return keys.sorted { scalarCompare($0, $1) < 0 }
        }
    }

    /// Unicode scalar 逐位比较（practiceMerge.ts compare 对应物）。
    public static func scalarCompare(_ a: String, _ b: String) -> Int {
        var ia = a.unicodeScalars.makeIterator()
        var ib = b.unicodeScalars.makeIterator()
        while true {
            let x = ia.next(), y = ib.next()
            switch (x, y) {
            case (nil, nil): return 0
            case (nil, _): return -1
            case (_, nil): return 1
            case let (x?, y?):
                if x.value != y.value { return x.value < y.value ? -1 : 1 }
            }
        }
    }

    /// JS `JSON.stringify` 等价（字典键按指定顺序；undefined 值的键省略；
    /// 数组里的 undefined 按 JS 规则写作 null）。顶层 undefined 写作 "null"。
    public static func stringify(_ value: Any?, keyOrder: KeyOrder = .utf16) -> String {
        guard let value = unwrap(value) else { return "null" }
        if value is NSNull { return "null" }
        if let b = bool(value) { return b ? "true" : "false" }
        if let n = number(value) { return numberString(n) }
        if let s = value as? String { return quote(s) }
        if let array = value as? [Any] {
            return "[" + array.map { item -> String in
                isUndefined(item) ? "null" : stringify(item, keyOrder: keyOrder)
            }.joined(separator: ",") + "]"
        }
        if let dict = value as? JSONObject {
            let keys = sortedKeys(dict.keys.filter { !isUndefined(dict[$0]) }, order: keyOrder)
            return "{" + keys.map { quote($0) + ":" + stringify(dict[$0], keyOrder: keyOrder) }.joined(separator: ",") + "}"
        }
        // 其余 Swift 原生类型（Int64 / Double 已被 NSNumber 桥接覆盖）兜底字符串化。
        return quote(String(describing: value))
    }

    /// `JSON.stringify(v)` 的 UTF-8 字节数（服务端/分块字节口径）。
    public static func byteCount(_ value: Any?) -> Int {
        stringify(value).utf8.count
    }

    /// 深拷贝可变字典（JSONSerialization 值都是值类型/不可变，直接返回即可；
    /// 保留此名以表达意图）。
    public static func copy(_ dict: JSONObject) -> JSONObject { dict }
}
