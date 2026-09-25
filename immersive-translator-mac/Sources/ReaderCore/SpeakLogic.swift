import Foundation

/// 口语陪练的纯逻辑层（R3）：场景/难度元数据、对话 prompt、回复解析、会话数据类型。
/// 对齐 src/core/speakLogic.ts；会话同时是 speak_store 的存储格式（camelCase）。
/// 对话轮：用户说（ASR 英文转写）→ AI 回复（1-3 句口语英文 + 一行中文提示）
/// → 可选跟读（ISE 打分挂在 assistant 轮上）。SRS/生词数据不经过这里。

public let speakSchemaVersion = 1

public enum SpeakScenarioId: String, Codable, Equatable, CaseIterable {
    case ordering
    case interview
    case travel
    case smalltalk
}

public enum SpeakDifficulty: String, Codable, Equatable, CaseIterable {
    case easy
    case medium
    case hard
}

public struct SpeakScenario: Equatable, Identifiable {
    public var id: SpeakScenarioId
    public var label: String
    public var emoji: String
    /// LLM 的场景角色设定（你扮演…）。
    public var brief: String
    /// 开场白（AI 第一轮，避免用户先开口冷启动）。
    public var opener: String
    public var openerZh: String

    public init(id: SpeakScenarioId, label: String, emoji: String, brief: String, opener: String, openerZh: String) {
        self.id = id
        self.label = label
        self.emoji = emoji
        self.brief = brief
        self.opener = opener
        self.openerZh = openerZh
    }
}

public let speakScenarios: [SpeakScenario] = [
    SpeakScenario(
        id: .ordering, label: "点餐", emoji: "🍜",
        brief: "在英语餐厅点餐，你扮演友善的服务员，帮用户完成点单、推荐菜品、确认订单",
        opener: "Hi there! Welcome in. What can I get started for you today?",
        openerZh: "你好，欢迎光临！今天想吃点什么？（试着说：I'd like… / Can I have…）"
    ),
    SpeakScenario(
        id: .interview, label: "面试", emoji: "💼",
        brief: "英文面试模拟，你扮演温和的面试官，围绕自我介绍、经历、优缺点提问，一次只问一个问题",
        opener: "Good morning, thanks for coming in. Could you start by telling me a little about yourself?",
        openerZh: "早上好，先做个自我介绍吧。（提示：I'm currently… / I used to work…）"
    ),
    SpeakScenario(
        id: .travel, label: "旅行", emoji: "✈️",
        brief: "旅行场景（机场、酒店、问路、购物），你扮演当地工作人员或热心路人",
        opener: "Good afternoon! You look a little lost — is there anything I can help you with?",
        openerZh: "下午好！看你想问路？（提示：Excuse me, how can I get to…）"
    ),
    SpeakScenario(
        id: .smalltalk, label: "寒暄", emoji: "☕️",
        brief: "朋友间日常寒暄闲聊（天气、周末、近况、兴趣），你扮演老朋友，语气轻松",
        opener: "Hey! Long time no see. How has your week been going?",
        openerZh: "嘿，好久不见！这周过得怎么样？（提示：Pretty good, I… / Not bad, just…）"
    ),
]

public struct SpeakDifficultyInfo: Equatable {
    public var id: SpeakDifficulty
    public var label: String
    public var note: String
}

public let speakDifficulties: [SpeakDifficultyInfo] = [
    SpeakDifficultyInfo(id: .easy, label: "轻松", note: "用最简单的词汇和短句，放慢节奏，多给鼓励"),
    SpeakDifficultyInfo(id: .medium, label: "日常", note: "日常口语表达，正常语速"),
    SpeakDifficultyInfo(id: .hard, label: "进阶", note: "表达丰富地道，可以自然追问细节，接近母语者"),
]

public func scenarioOf(_ id: SpeakScenarioId) -> SpeakScenario {
    speakScenarios.first { $0.id == id } ?? speakScenarios[0]
}

public func difficultyOf(_ id: SpeakDifficulty) -> SpeakDifficultyInfo {
    speakDifficulties.first { $0.id == id } ?? speakDifficulties[1]
}

/// 一轮对话。user.text 是 ASR 转写；assistant.text 是英文回复。
public struct SpeakTurn: Codable, Equatable, Identifiable {
    public enum Role: String, Codable {
        case user
        case assistant
    }

    public var id: String { "\(role.rawValue)-\(at)" }
    public var role: Role
    public var text: String
    /// assistant 轮的中文提示（这句意思 + 怎么接话）。
    public var hintZh: String?
    /// assistant 轮的跟读分（5 分制 ISE；nil = 没测）。
    /// 兼容字段：等于最新一次 attempt 的总分（UI 直读它）。
    public var shadowScore: Double?
    /// 跟读报告历史（最新在末尾；旧会话无此字段）。重复跟读 append 而不是覆盖，
    /// 口语复盘的跨尝试规则（R2/R5）依赖完整历史。
    public var shadowAttempts: [ShadowAttempt]?
    /// Unix 毫秒。
    public var at: Int64

    public init(
        role: Role, text: String, hintZh: String? = nil, shadowScore: Double? = nil,
        shadowAttempts: [ShadowAttempt]? = nil, at: Int64
    ) {
        self.role = role
        self.text = text
        self.hintZh = hintZh
        self.shadowScore = shadowScore
        self.shadowAttempts = shadowAttempts
        self.at = at
    }

    enum CodingKeys: String, CodingKey {
        case role, text, hintZh, shadowScore, shadowAttempts, at
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = try c.decode(Role.self, forKey: .role)
        text = try c.decode(String.self, forKey: .text)
        hintZh = try c.decodeIfPresent(String.self, forKey: .hintZh)
        shadowScore = try c.decodeIfPresent(Double.self, forKey: .shadowScore)
        shadowAttempts = try c.decodeIfPresent([ShadowAttempt].self, forKey: .shadowAttempts)
        at = try c.decodeIfPresent(Int64.self, forKey: .at) ?? 0
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(role, forKey: .role)
        try c.encode(text, forKey: .text)
        try c.encodeIfPresent(hintZh, forKey: .hintZh)
        try c.encodeIfPresent(shadowScore, forKey: .shadowScore)
        try c.encodeIfPresent(shadowAttempts, forKey: .shadowAttempts)
        try c.encode(at, forKey: .at)
    }
}

// MARK: - 跟读报告（落盘结构，对齐 contracts speakShadowAttempt / Windows speak_store.rs）

/// 每轮最多保留的跟读报告数（更旧的挤掉；对齐 Windows SpeakView 的 slice(-10)）。
public let speakMaxShadowAttemptsPerTurn = 10

/// 一次跟读评测报告（分数均为 5 分制）。
public struct ShadowAttempt: Codable, Equatable, Sendable {
    /// Unix 毫秒。
    public var at: Int64
    public var total: Double
    public var accuracy: Double
    public var fluency: Double
    /// 完整度：漏读/增读会拉低（跟丢护栏用它）。
    public var integrity: Double
    public var words: [ShadowWord]

    public init(
        at: Int64, total: Double, accuracy: Double, fluency: Double,
        integrity: Double, words: [ShadowWord]
    ) {
        self.at = at
        self.total = total
        self.accuracy = accuracy
        self.fluency = fluency
        self.integrity = integrity
        self.words = words
    }

    enum CodingKeys: String, CodingKey {
        case at, total, accuracy, fluency, integrity, words
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decodeIfPresent(Int64.self, forKey: .at) ?? 0
        total = try c.decodeIfPresent(Double.self, forKey: .total) ?? 0
        accuracy = try c.decodeIfPresent(Double.self, forKey: .accuracy) ?? 0
        fluency = try c.decodeIfPresent(Double.self, forKey: .fluency) ?? 0
        integrity = try c.decodeIfPresent(Double.self, forKey: .integrity) ?? 5
        words = try c.decodeIfPresent([ShadowWord].self, forKey: .words) ?? []
    }
}

/// 词级评测明细（content 是识别出的词）。
public struct ShadowWord: Codable, Equatable, Sendable {
    public var content: String
    public var totalScore: Double
    /// 0 正常 / 16 漏读 / 32 增读 / 64 回读 / 128 替换。
    public var dpMessage: Int
    public var sylls: [ShadowSyll]

    public init(content: String, totalScore: Double, dpMessage: Int, sylls: [ShadowSyll] = []) {
        self.content = content
        self.totalScore = totalScore
        self.dpMessage = dpMessage
        self.sylls = sylls
    }

    enum CodingKeys: String, CodingKey {
        case content, totalScore, dpMessage, sylls
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        content = try c.decodeIfPresent(String.self, forKey: .content) ?? ""
        totalScore = try c.decodeIfPresent(Double.self, forKey: .totalScore) ?? 0
        dpMessage = try c.decodeIfPresent(Int.self, forKey: .dpMessage) ?? 0
        sylls = try c.decodeIfPresent([ShadowSyll].self, forKey: .sylls) ?? []
    }
}

/// 音节级评测明细。
public struct ShadowSyll: Codable, Equatable, Sendable {
    public var content: String
    public var syllScore: Double
    public var serrMsg: Int
    public var phones: [ShadowPhone]

    public init(content: String, syllScore: Double, serrMsg: Int, phones: [ShadowPhone] = []) {
        self.content = content
        self.syllScore = syllScore
        self.serrMsg = serrMsg
        self.phones = phones
    }

    enum CodingKeys: String, CodingKey {
        case content, syllScore, serrMsg, phones
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        content = try c.decodeIfPresent(String.self, forKey: .content) ?? ""
        syllScore = try c.decodeIfPresent(Double.self, forKey: .syllScore) ?? 0
        serrMsg = try c.decodeIfPresent(Int.self, forKey: .serrMsg) ?? 0
        phones = try c.decodeIfPresent([ShadowPhone].self, forKey: .phones) ?? []
    }
}

/// 音素级评测明细（ARPAbet 音素码 + GOP 惩罚值）。
public struct ShadowPhone: Codable, Equatable, Sendable {
    public var content: String
    public var dpMessage: Int
    public var gwpp: Double

    public init(content: String, dpMessage: Int, gwpp: Double) {
        self.content = content
        self.dpMessage = dpMessage
        self.gwpp = gwpp
    }

    enum CodingKeys: String, CodingKey {
        case content, dpMessage, gwpp
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        content = try c.decodeIfPresent(String.self, forKey: .content) ?? ""
        dpMessage = try c.decodeIfPresent(Int.self, forKey: .dpMessage) ?? 0
        gwpp = try c.decodeIfPresent(Double.self, forKey: .gwpp) ?? 0
    }
}

/// 一次陪练会话（本地保存，可重开上次对话）。
public struct SpeakSession: Codable, Equatable, Identifiable {
    public var id: String
    public var scenario: SpeakScenarioId
    public var difficulty: SpeakDifficulty
    public var turns: [SpeakTurn]
    /// Unix 毫秒。
    public var createdAt: Int64
    public var updatedAt: Int64

    public init(id: String, scenario: SpeakScenarioId, difficulty: SpeakDifficulty, turns: [SpeakTurn], createdAt: Int64, updatedAt: Int64) {
        self.id = id
        self.scenario = scenario
        self.difficulty = difficulty
        self.turns = turns
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct SpeakSessionsFile: Codable, Equatable {
    public var schemaVersion: Int
    public var sessions: [SpeakSession]

    public init(schemaVersion: Int = speakSchemaVersion, sessions: [SpeakSession] = []) {
        self.schemaVersion = schemaVersion
        self.sessions = sessions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try c.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? speakSchemaVersion
        sessions = try c.decodeIfPresent([SpeakSession].self, forKey: .sessions) ?? []
    }
}

public func newSpeakSessionId(now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> String {
    let base36 = String(now, radix: 36)
    let rand = String(format: "%06d", Int.random(in: 0..<0xFFFFFF))
    return "s\(base36)\(rand)"
}

public func newSpeakSession(
    _ scenario: SpeakScenarioId,
    _ difficulty: SpeakDifficulty,
    now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
) -> SpeakSession {
    let sc = scenarioOf(scenario)
    return SpeakSession(
        id: newSpeakSessionId(now: now),
        scenario: scenario,
        difficulty: difficulty,
        turns: [
            SpeakTurn(role: .assistant, text: sc.opener, hintZh: sc.openerZh, at: now)
        ],
        createdAt: now,
        updatedAt: now
    )
}

// MARK: - LLM 对话

/// 送 LLM 的系统提示：场景角色 + 严格的 EN/ZH 两行格式。
public func buildSpeakSystemPrompt(_ scenario: SpeakScenarioId, _ difficulty: SpeakDifficulty) -> String {
    let sc = scenarioOf(scenario)
    let diff = difficultyOf(difficulty)
    return [
        "你是用户的英语口语陪练伙伴。场景：\(sc.brief)。难度：\(diff.note)。",
        "",
        "对话规则：",
        "- 每轮回复 1–3 句地道口语英文，像真人一样自然推进场景，结尾尽量给用户留出接话的空间（提问或等待回应）。",
        "- 回复格式必须严格两行：第一行以 \"EN: \" 开头，是你的英文回复；第二行以 \"ZH: \" 开头，是一句简短中文提示（你这句的意思 + 用户可以怎么接）。",
        "- 用户的话来自语音识别，可能有错词，结合上下文善意理解；用户说了中文时，用简单英语温和提醒 TA 试着用英语说。",
        "- 不要输出这两行以外的任何内容（不要代码块、不要解释）。",
    ].joined(separator: "\n")
}

/// 送 LLM 的用户消息：近几轮对话记录 + 本轮用户发言。
public func buildSpeakUserInput(_ turns: [SpeakTurn], _ userText: String) -> String {
    let recent = turns.suffix(12)
    var lines = recent.map { t in
        t.role == .user ? "我: \(t.text)" : "你: \(t.text)"
    }
    lines.append("我: \(userText)")
    return (["对话记录（最新在下）："] + lines + ["", "请给出你的下一轮回复（EN: + ZH: 两行）。"]).joined(separator: "\n")
}

/// 解析模型回复为 { en, zh }。宽容处理：剥代码块围栏；找不到 "ZH:" 时
/// 中文提示置空；整段没有 EN: 标记时把全文当英文回复（不丢内容）。
public func parseAssistantReply(_ raw: String) -> (en: String, zh: String) {
    var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    text = text
        .replacingOccurrences(of: #"^```[a-zA-Z]*\s*"#, with: "", options: [.regularExpression])
        .replacingOccurrences(of: #"\s*```\s*$"#, with: "", options: [.regularExpression])
        .trimmingCharacters(in: .whitespacesAndNewlines)

    func capture(_ pattern: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive, .dotMatchesLineSeparators]) else { return nil }
        let ns = text as NSString
        guard let m = re.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)),
              m.numberOfRanges > 1,
              let r = Range(m.range(at: 1), in: text) else { return nil }
        return String(text[r])
    }

    var en = capture(#"(?:^|\n)\s*EN[:：]\s*([\s\S]*?)(?=\n\s*ZH[:：]|$)"#)
    if en == nil {
        en = text.replacingOccurrences(of: #"(?:^|\n)\s*ZH[:：][\s\S]*$"#, with: "", options: [.regularExpression, .caseInsensitive])
    }
    let zh = capture(#"(?:^|\n)\s*ZH[:：]\s*([\s\S]*)$"#) ?? ""
    let collapse = { (s: String) in
        s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return (collapse(en ?? ""), collapse(zh))
}

/// 会话最近的 assistant 英文（跟读参考文本用）。
public func lastAssistantText(_ turns: [SpeakTurn]) -> String? {
    for turn in turns.reversed() where turn.role == .assistant && !turn.text.trimmingCharacters(in: .whitespaces).isEmpty {
        return turn.text
    }
    return nil
}
