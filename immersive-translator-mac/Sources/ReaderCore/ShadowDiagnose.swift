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

/// 常见问题音素的纠音提示（ARPAbet 码 → 人话），25 条对齐 Windows PHONE_TIPS
/// 全量（shadowDiagnose.ts:161-187）。只覆盖中国学习者的高频坑；没命中的
/// 音素由弹层兜底文案处理。
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
    "ao": "长元音『奥』：舌后部抬一点、嘴拢圆，喉咙里共鸣（thought 的元音）",
    "ey": "双元音：从『诶』滑向『衣』，前重后轻，下巴逐渐收拢（late 的元音）",
    "uh": "中央松元音（schwa）：舌头放松平放口中，轻而短促，不要读成饱满的『啊』",
    "b": "浊塞音：双唇先闭紧，声带先振动再爆破放开，几乎不送气",
    "d": "浊塞音：舌尖抵上齿龈，声带先振动再弹开；词尾不要多出一个『特』",
    "g": "浊塞音：舌后部抵住软腭，声带先振动再放开，不送气",
    "s": "舌尖接近上齿龈，气流细而平地摩擦出来；不要把整个舌面抬起来",
    "sh": "舌面稍抬、双唇略撮圆，摩擦比『斯』更宽更闷（ship 的开头）",
    "z": "声带振动的 s；词尾不要读成『斯』",
]

/// phoneTips 覆盖的音素键（25 个，对齐 Windows PHONE_TIPS 全量；单测断言用）。
public let phoneTipKeys: Set<String> = Set(phoneTips.keys)

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

// MARK: - 跟读异常可行动卡片（SPEAK-13，对齐 SpeakView.tsx:729-779 分类 + 1604-1669 文案）

/// 跟读评测异常的四类（Windows ShadowErrorKind 去掉空串档，SpeakView.tsx:68）。
public enum ShadowFailureKind: String, Equatable, Sendable {
    /// 乱读：ISE 判定读的不是这句话（is_rejected）。
    case rejected
    /// 没听到声音：评分前峰值/时长兜底，或 ISE 28673（无语音/音量小）。
    case novoice
    /// 环境有点吵：ISE 28680（信噪比低）。
    case noisy
    /// 这次没评上：其他评测异常码 / 评测请求抛错（网络、服务）。
    case except
}

/// 异常卡上的动作（按钮语义；标题随卡片种类变化，由 ShadowFailureCard.actions 给出）。
public enum ShadowFailureActionKind: Equatable, Sendable {
    /// 🔊 听领读（整句播报示范）。
    case hearModel
    /// 🎤 再跟读 / 重新跟读 / 再试一次（重新开麦跟读）。
    case again
}

/// 异常卡上的一个按钮：动作语义 + 展示标题 + 是否主按钮（rc-btn.primary）。
public struct ShadowFailureAction: Equatable, Sendable {
    public var kind: ShadowFailureActionKind
    public var title: String
    public var primary: Bool

    public init(kind: ShadowFailureActionKind, title: String, primary: Bool) {
        self.kind = kind
        self.title = title
        self.primary = primary
    }
}

/// 一张可行动异常卡（标题 / 正文 / 按钮组），文案逐字对齐 Windows ShadowErrorCard。
/// 展示层只管排版：kind 决定左边线/底色变体（rejected = warn 色，其余 = 中性 novoice 变体）。
public struct ShadowFailureCard: Equatable, Sendable {
    public var kind: ShadowFailureKind
    public var title: String
    public var body: String
    public var actions: [ShadowFailureAction]

    public init(kind: ShadowFailureKind, title: String, body: String, actions: [ShadowFailureAction]) {
        self.kind = kind
        self.title = title
        self.body = body
        self.actions = actions
    }
}

/// 评分前兜底的阈值（对齐 finishShadow 的 peak<0.01 / MIN_UTTERANCE_SAMPLES=16000×0.5，
/// SpeakView.tsx:80-81,736-741）。
public let shadowPrecheckMinPeak: Float = 0.01
public let shadowPrecheckMinSamples = 16_000 / 2

/// 录音峰值（每 16 个采样取一个，对齐 SpeakView.tsx:737 的步进扫描）。
public func shadowRecordingPeak(_ samples: [Float]) -> Float {
    var peak: Float = 0
    var i = 0
    while i < samples.count {
        peak = max(peak, abs(samples[i]))
        i += 16
    }
    return peak
}

/// 评分前的录音体检：静音（峰值不足）或过短 → novoice 卡，不送评测、不烧额度；
/// 体检通过返回 nil。Mac 把 Windows 的一行「没听到声音」错误文本升级为同款 novoice 卡
///（SPEAK-13 验收：静音跟读 →「没听到你的声音」卡＋重新跟读）。
public func shadowPrecheckFailureCard(
    sampleCount: Int,
    peak: Float,
    minSamples: Int = shadowPrecheckMinSamples,
    minPeak: Float = shadowPrecheckMinPeak
) -> ShadowFailureCard? {
    guard peak < minPeak || sampleCount < minSamples else { return nil }
    return shadowFailureCard(.novoice)
}

/// ISE 结果的异常面分类（次序对齐 SpeakView.tsx:759-779）：is_rejected → rejected；
/// 28673 → novoice；28680 → noisy；其他 except_info → except（正文带异常码）；干净结果 nil。
public func shadowResultFailureCard(isRejected: Bool, exceptInfo: String?) -> ShadowFailureCard? {
    if isRejected { return shadowFailureCard(.rejected) }
    switch exceptInfo {
    case nil: return nil
    case "28673"?: return shadowFailureCard(.novoice)
    case "28680"?: return shadowFailureCard(.noisy)
    case let code?: return shadowExceptFailureCard(detail: "评测异常（\(code)），再试一次")
    }
}

/// 评测请求本身抛错（网络/服务/凭据以外的运行期错误）→ except 卡，正文放错误详情；
/// 详情为空回落「再试一次应该就好。」（ShadowErrorCard：`detail || "再试一次应该就好。"`）。
public func shadowExceptFailureCard(detail: String?) -> ShadowFailureCard {
    let trimmed = detail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return ShadowFailureCard(
        kind: .except,
        title: "· 这次没评上",
        body: trimmed.isEmpty ? "再试一次应该就好。" : trimmed,
        actions: [ShadowFailureAction(kind: .again, title: "🎤 再试一次", primary: true)]
    )
}

/// 四类卡的定稿文案与按钮（SpeakView.tsx:1616-1668 逐字）。
public func shadowFailureCard(_ kind: ShadowFailureKind) -> ShadowFailureCard {
    switch kind {
    case .rejected:
        return ShadowFailureCard(
            kind: .rejected,
            title: "✗ 读的好像不是这句话",
            body: "不用灰心——可能句子太长跟丢了。先听一遍领读，照着文字再试一次。",
            actions: [
                ShadowFailureAction(kind: .hearModel, title: "🔊 听领读", primary: true),
                ShadowFailureAction(kind: .again, title: "🎤 再跟读", primary: false),
            ]
        )
    case .novoice:
        return ShadowFailureCard(
            kind: .novoice,
            title: "· 没听到你的声音",
            body: "离麦克风近一点，按住按钮读完这一句再松开。",
            actions: [ShadowFailureAction(kind: .again, title: "🎤 重新跟读", primary: true)]
        )
    case .noisy:
        return ShadowFailureCard(
            kind: .noisy,
            title: "· 环境有点吵",
            body: "背景噪音偏大，评测听不清——换个安静些的地方，或离麦克风再近一点。",
            actions: [ShadowFailureAction(kind: .again, title: "🎤 重新跟读", primary: true)]
        )
    case .except:
        return shadowExceptFailureCard(detail: nil)
    }
}

// MARK: - 逐词得分曲线（对齐 src/core/shadowDiagnose.ts wordScorePath，ts:216-253）

public let wordScorePathWidth: Double = 272
public let wordScorePathHeight: Double = 64

/// 折线上的一个点（分数越高 y 越小；下标与输入词序列一致，供点圆点同步选词）。
public struct WordScorePathPoint: Equatable, Sendable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// 逐词得分折线的几何（SVG 视口 + 基准线 y + 点列）。
public struct WordScorePath: Equatable, Sendable {
    public var width: Double
    public var height: Double
    /// 5 分基准虚线的 y（顶部 padY 处）。
    public var baselineY: Double
    public var points: [WordScorePathPoint]

    public init(width: Double, height: Double, baselineY: Double, points: [WordScorePathPoint]) {
        self.width = width
        self.height = height
        self.baselineY = baselineY
        self.points = points
    }
}

/// 把 ISE 的 words[].totalScore（0–5）变成折线点列：分数越高 y 越小，
/// 等距横排在 [12, width-12] 区间；单词只有 1 个时居中。讯飞 ISE 不返回音高
/// F0 曲线，这里用真实逐词得分当「语调对比」的替代曲线。
public func wordScorePath(_ words: [ShadowWord]) -> WordScorePath {
    let w = wordScorePathWidth
    let h = wordScorePathHeight
    let padX = 12.0
    let padY = 10.0
    let innerW = w - padX * 2
    let innerH = h - padY * 2
    let n = words.count
    let points = words.enumerated().map { i, word in
        let score = min(5.0, max(0.0, word.totalScore))
        let x = n <= 1 ? w / 2 : padX + (innerW * Double(i)) / Double(n - 1)
        let y = padY + innerH * (1 - score / 5)
        return WordScorePathPoint(x: x, y: y)
    }
    return WordScorePath(width: w, height: h, baselineY: padY, points: points)
}
