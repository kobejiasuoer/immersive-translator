import Foundation

/// 跟读报告的诊断逻辑（纯函数，报告卡与差词训练共用阈值语义）。
/// 对齐 src/core/shadowDiagnose.ts：
///
/// 把评测结果 + 词着色变成「差的分差在哪、怎么补」：
/// - 短板维度：准确度/流畅度/完整度里缺口最大的那个
/// - 差词/漏词清单：直接来自词着色四档
/// - 徽章判定：过关 / 差一点（差 X 过关）/ 再练练
/// 文案由规则拼装，不调 LLM；展示层（报告卡）只管排版。
///
/// 为保 ReaderCore 零依赖，诊断输入模型（ShadowDiagResult / ShadowDiagMark）
/// 在此自带；XfyunCore 类型由应用层一一桥接（ShadowReportView.swift）。

/// 过关阈值（5 分制）；与阅读室跟读评测默认门槛一致（shadowDiagnose.ts:14）。
public let shadowPassScore: Double = 4.2

/// 短板要显著到这个缺口才点名（避免三项都 4.5+ 还硬挑一个，ts:48）。
private let weakGapMin = 0.4
/// 差词/漏词合并的最大数量（再多练不过来，先聚焦，ts:51）。
private let maxDrillWords = 4

/// 诊断维度（shadowDiagnose.ts:41-45 DIM_LABELS 内聚到枚举上）。
public enum ShadowDimKind: String, CaseIterable, Equatable, Hashable, Sendable {
    case accuracy, fluency, integrity

    public var label: String {
        switch self {
        case .accuracy: return "准确度"
        case .fluency: return "流畅度"
        case .integrity: return "完整度"
        }
    }
}

/// 徽章种类：过关 / 差一点（贴着阈值）/ 明显不足。
public enum ShadowBadgeKind: String, Equatable, Sendable {
    case pass, almost, fail
}

/// 诊断句片段的强调色。
public enum ShadowSegmentKind: String, Equatable, Sendable {
    case strong, warn, err
}

/// 诊断句片段（kind 决定报告卡强调色；shadowDiagnose.ts:20-23）。
public struct ShadowDiagSegment: Equatable, Sendable {
    public var text: String
    /// nil = 普通文案。
    public var kind: ShadowSegmentKind?

    public init(text: String, kind: ShadowSegmentKind? = nil) {
        self.text = text
        self.kind = kind
    }
}

/// 音素（gwpp 为 GOP 逐音素惩罚值，绝对值越大问题越大）。
public struct ShadowDiagPhone: Equatable, Sendable {
    public var content: String
    public var gwpp: Double

    public init(content: String, gwpp: Double) {
        self.content = content
        self.gwpp = gwpp
    }
}

/// 词明细（音素弹层/差词训练用）。Windows 用 word.sylls[].phones[]，但音节边界
/// 在报告卡与抽屉里从未使用（ShadowReport.tsx:303 / ShadowDrill.tsx:157 均 flatMap），
/// 所以这里拍平成 phones，桥接层负责展平——有意简化，非遗漏。
public struct ShadowDiagWord: Equatable, Sendable {
    public var content: String
    public var phones: [ShadowDiagPhone]

    public init(content: String, phones: [ShadowDiagPhone]) {
        self.content = content
        self.phones = phones
    }
}

/// 词着色四档（与 XfyunCore.WordQuality 同义；为保 ReaderCore 零依赖另行声明，
/// 桥接层一一映射）。
public enum ShadowDiagQuality: String, Equatable, Hashable, Sendable {
    case good, ok, bad, missed
}

/// 诊断输入的一个词（quality/score 必备；word 缺省 = 对不上原文的词）。
public struct ShadowDiagMark: Equatable, Sendable {
    public var quality: ShadowDiagQuality
    public var score: Double
    public var word: ShadowDiagWord?

    public init(quality: ShadowDiagQuality, score: Double, word: ShadowDiagWord? = nil) {
        self.quality = quality
        self.score = score
        self.word = word
    }
}

/// 诊断输入的评测结果（对齐 PronunciationResult 的诊断所需子集；standard 不参与诊断）。
public struct ShadowDiagResult: Equatable, Sendable {
    public var total: Double
    public var accuracy: Double
    public var fluency: Double
    public var integrity: Double
    public var isRejected: Bool
    /// 正常为 nil。
    public var exceptInfo: String?

    public init(
        total: Double,
        accuracy: Double,
        fluency: Double,
        integrity: Double,
        isRejected: Bool,
        exceptInfo: String?
    ) {
        self.total = total
        self.accuracy = accuracy
        self.fluency = fluency
        self.integrity = integrity
        self.isRejected = isRejected
        self.exceptInfo = exceptInfo
    }
}

/// 诊断结果。
public struct ShadowDiagnosis: Equatable, Sendable {
    public var pass: Bool
    public var badgeKind: ShadowBadgeKind
    /// 「✓ 过关」「差 0.1 过关」「再练练」。
    public var badge: String
    /// 诊断句片段序列（UI 按 kind 着色拼接）。
    public var segments: [ShadowDiagSegment]
    /// 缺口最大的维度（三项都够好时为 nil）。
    public var weakDim: ShadowDimKind?
    /// 差词+漏词，按出现序，最多 4 个（取 m.word?.content）。
    public var drillWords: [String]
    /// 差词（<3 分）数与漏读词数。
    public var badCount: Int
    public var missedCount: Int
}

/// 把一次评测结果 + 词着色诊断成「差在哪、怎么补」。
public func diagnoseShadow(
    _ result: ShadowDiagResult,
    _ marks: [ShadowDiagMark],
    passScore: Double = shadowPassScore
) -> ShadowDiagnosis {
    // isPass 语义（pronunciation.ts:280-282 的前两项 + 阈值）在 ReaderCore 内重写，
    // 不引 XfyunCore 的 isIsePass。
    let pass = !result.isRejected && result.exceptInfo == nil && result.total >= passScore
    let gap = max(0, passScore - result.total)

    var badWords: [String] = []
    var missedWords: [String] = []
    for m in marks {
        guard let text = m.word?.content, !text.isEmpty else { continue }  // 对不上原文的词跳过
        if m.quality == .bad { badWords.append(text) }
        if m.quality == .missed { missedWords.append(text) }
    }
    // bad 在前是出现序自然结果（bad/missed 各自按 marks 序收集，ts:69）
    let drillWords = Array((badWords + missedWords).prefix(maxDrillWords))

    // 短板维度：三项 gap 降序取首，缺口 ≥ weakGapMin 才点名。
    // max(by:) 平手保留前者 → 与稳定排序的 accuracy/fluency/integrity 序一致。
    let gapItems: [(dim: ShadowDimKind, gap: Double)] = [
        (.accuracy, 5 - result.accuracy),
        (.fluency, 5 - result.fluency),
        (.integrity, 5 - result.integrity),
    ]
    let worst = gapItems.max { $0.gap < $1.gap }
    let weakDim: ShadowDimKind? = (worst?.gap ?? 0) >= weakGapMin ? worst?.dim : nil

    let badgeKind: ShadowBadgeKind = pass ? .pass : (gap <= 0.25 ? .almost : .fail)
    let badge = pass ? "✓ 过关" : (badgeKind == .almost ? String(format: "差 %.1f 过关", gap) : "再练练")

    return ShadowDiagnosis(
        pass: pass,
        badgeKind: badgeKind,
        badge: badge,
        segments: pass
            ? passSegments(marks, badWords: badWords)
            : failSegments(result, weakDim: weakDim, badWords: badWords, missedWords: missedWords),
        weakDim: weakDim,
        drillWords: drillWords,
        badCount: badWords.count,
        missedCount: missedWords.count
    )
}

// MARK: - 内部

private func passSegments(_ marks: [ShadowDiagMark], badWords: [String]) -> [ShadowDiagSegment] {
    // 过关：轻庆祝；如果有紧贴及格线的词（ok 档），顺手点一句
    let shaky = marks
        .filter { $0.quality == .ok }
        .compactMap { $0.word?.content }
        .filter { !$0.isEmpty }
        .prefix(2)
    var out: [ShadowDiagSegment] = [ShadowDiagSegment(text: "整句读得稳，节奏也顺", kind: .strong)]
    if !badWords.isEmpty {
        out.append(ShadowDiagSegment(text: "；"))
        out.append(ShadowDiagSegment(text: "留意一下 \(badWords.joined(separator: "、"))", kind: .warn))
    } else if !shaky.isEmpty {
        out.append(ShadowDiagSegment(text: "；"))
        out.append(ShadowDiagSegment(text: "\(shaky.joined(separator: "、")) 可以更清晰", kind: .warn))
    }
    out.append(ShadowDiagSegment(text: "。"))
    return out
}

private func failSegments(
    _ result: ShadowDiagResult,
    weakDim: ShadowDimKind?,
    badWords: [String],
    missedWords: [String]
) -> [ShadowDiagSegment] {
    var out: [ShadowDiagSegment] = []
    let lost = String(format: "%.1f", 5 - result.total)
    if let weakDim {
        let score: Double
        switch weakDim {
        case .accuracy: score = result.accuracy
        case .fluency: score = result.fluency
        case .integrity: score = result.integrity
        }
        let hint: String
        switch weakDim {
        case .fluency: hint = "（语速与停顿）"
        case .integrity: hint = "（漏词/添词）"
        case .accuracy: hint = ""
        }
        out.append(ShadowDiagSegment(text: "差的 \(lost) 分大头在"))
        out.append(ShadowDiagSegment(text: "\(weakDim.label) \(String(format: "%.1f", score))\(hint)", kind: .warn))
    } else {
        out.append(ShadowDiagSegment(text: "离 5 分还差 \(lost)"))
    }
    var clauses: [ShadowDiagSegment] = []
    if !badWords.isEmpty {
        clauses.append(ShadowDiagSegment(text: "\(badWords.joined(separator: "、")) 发音不准", kind: .err))
    }
    if !missedWords.isEmpty {
        clauses.append(ShadowDiagSegment(text: "漏读了 \(missedWords.joined(separator: "、"))", kind: .err))
    }
    if !clauses.isEmpty {
        out.append(ShadowDiagSegment(text: "；"))
        out.append(contentsOf: interleave(clauses, sep: ShadowDiagSegment(text: "；")))
    }
    out.append(ShadowDiagSegment(text: "。"))
    return out
}

private func interleave(_ items: [ShadowDiagSegment], sep: ShadowDiagSegment) -> [ShadowDiagSegment] {
    var out: [ShadowDiagSegment] = []
    for (i, item) in items.enumerated() {
        if i > 0 { out.append(sep) }
        out.append(item)
    }
    return out
}

// MARK: - 音素纠音提示

/// 常见问题音素的纠音提示（ARPAbet 码 → 人话）。
/// 只覆盖中国学习者的高频坑；没命中的音素由弹层兜底文案处理。
private let phoneTips: [String: String] = [
    "th": "清音 th：舌尖轻放在上下齿之间送气，不是『斯』",
    "dh": "浊音 th：舌尖轻放在上下齿之间、声带振动，不是『兹』",
    "v": "上齿轻咬下唇出声，不要读成 w",
    "w": "双唇拢圆发音，不要读成 v",
    "ng": "舌后部抵住软腭，音从鼻腔出来收尾",
    "l": "舌尖抵上齿龈；在词尾时也要抵到位，不要吞掉",
    "r": "舌头卷起、不碰上颚；不要读成 l",
    "ih": "短促的松元音，快快带过，不要拖长",
    "iy": "长元音，嘴角向两侧拉开",
    "ae": "嘴张大、舌位压低（『啊』和『哎』之间偏『啊』）",
    "aa": "嘴张大、舌后压低，发长『啊』",
    "eh": "短音『诶』，嘴半开",
    "er": "卷舌音，舌头后卷",
    "ay": "双元音『爱』，从 a 滑到 i",
    "aw": "双元音『奥』，从 a 滑到 u",
    "ow": "双元音『欧』，从 o 滑到 u",
    "z": "声带振动的 s；词尾不要读成『斯』",
]

/// 没有针对性提示时的兜底。
public let phoneTipFallback = "对照领读慢速跟两遍，注意口型"

public func phoneTip(_ phone: String) -> String {
    phoneTips[phone] ?? phoneTipFallback
}

/// 一个词里最值得点名的音素（gwpp 惩罚最重且 ≤ -0.4 才算，ts:192-203）。
/// 返回 nil 表示这个词没有明显出错的音素。
public func worstPhoneOf(_ word: ShadowDiagWord?) -> ShadowDiagPhone? {
    guard let word else { return nil }
    var worst: ShadowDiagPhone?
    for p in word.phones {
        if worst == nil || p.gwpp < worst!.gwpp {
            worst = p
        }
    }
    return worst.flatMap { $0.gwpp <= -0.4 ? $0 : nil }
}
