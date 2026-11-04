import Foundation

/// 口语陪练的纯逻辑层（R3）：场景/难度元数据、对话 prompt、回复解析、会话数据类型。
/// 对齐 src/core/speakLogic.ts；会话同时是 speak_store 的存储格式（camelCase）。
/// 对话轮：用户说（ASR 英文转写）→ AI 回复（1-3 句口语英文 + 一行中文提示）
/// → 可选跟读（ISE 打分挂在 assistant 轮上）。SRS/生词数据不经过这里。

public let speakSchemaVersion = 1

/// 场景 id：内置沿用 "ordering"|"interview"|"travel"|"smalltalk"；官方 "off_" 前缀；
/// 用户 "usr_" 前缀（usr_<uuid>）。A1（契约 v1.2.0）起放开为 String，旧会话 JSON
/// 与存储/契约零破坏（4 个内置 id 仍是合法值）。对齐 Windows speakLogic.ts:18。
public typealias SpeakScenarioId = String

public enum SpeakDifficulty: String, Codable, Equatable, CaseIterable, Sendable {
    case easy
    case medium
    case hard
}

/// 场景来源（与 Windows analytics.ts 的 ScenarioSource 字面量一致）。
public enum SpeakScenarioSource: String, Codable, Equatable, CaseIterable, Sendable {
    case builtin
    case official
    case user
}

/// 场景分类（契约 $defs/scenarioCategory）。
public enum SpeakScenarioCategory: String, Codable, Equatable, CaseIterable, Sendable {
    case daily
    case travel
    case workplace
    case academic
    case custom
}

/// 内置 4 场景统一的迁移基准 updatedAt（Unix 毫秒；= Windows `Date.UTC(2026, 0, 1)`
/// = 2026-01-01T00:00:00Z；测试逐字基线断言用）。
public let builtinScenarioUpdatedAt: Int64 = 1_767_225_600_000

/// 口语场景（contracts/speak-scenario.schema.json $defs/speakScenario 的 Swift 镜像）。
/// A1 迁移：label→title、brief 并入 aiRole、新增 source/category/updatedAt，
/// 4 个内置场景文案逐字搬运（system prompt 与开场白输出不变）。
/// 可选字段缺省不写入 JSON（与 Windows 编辑器「空值不写入」同口径），读侧宽容
/// （decodeIfPresent，沿用本文件 SpeakTurn 的手法）。
public struct SpeakScenario: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var source: SpeakScenarioSource
    /// 场景名（原 label 逐字迁移）。
    public var title: String
    public var emoji: String?
    public var category: SpeakScenarioCategory
    /// LLM 的场景角色设定（你扮演…；原 brief 逐字并入，≤300 字）。
    public var aiRole: String
    /// 用户角色设定（≤200 字）。
    public var userRole: String?
    /// 本场景的练习目标（≤200 字）。
    public var goal: String?
    /// 关键表达（≤8 条；用户场景的会话目标词由 ScenarioForge 消费）。
    public var keyPhrases: [String]?
    /// 开场白（AI 第一轮，避免用户先开口冷启动）。
    public var opener: String
    /// 开场白中文提示。
    public var openerZh: String?
    public var defaultDifficulty: SpeakDifficulty?
    /// Unix 毫秒。
    public var updatedAt: Int64

    public init(
        id: String,
        source: SpeakScenarioSource,
        title: String,
        emoji: String? = nil,
        category: SpeakScenarioCategory,
        aiRole: String,
        userRole: String? = nil,
        goal: String? = nil,
        keyPhrases: [String]? = nil,
        opener: String,
        openerZh: String? = nil,
        defaultDifficulty: SpeakDifficulty? = nil,
        updatedAt: Int64
    ) {
        self.id = id
        self.source = source
        self.title = title
        self.emoji = emoji
        self.category = category
        self.aiRole = aiRole
        self.userRole = userRole
        self.goal = goal
        self.keyPhrases = keyPhrases
        self.opener = opener
        self.openerZh = openerZh
        self.defaultDifficulty = defaultDifficulty
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case id, source, title, emoji, category, aiRole, userRole, goal, keyPhrases
        case opener, openerZh, defaultDifficulty, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        source = try c.decode(SpeakScenarioSource.self, forKey: .source)
        title = try c.decode(String.self, forKey: .title)
        emoji = try c.decodeIfPresent(String.self, forKey: .emoji)
        category = try c.decode(SpeakScenarioCategory.self, forKey: .category)
        aiRole = try c.decode(String.self, forKey: .aiRole)
        userRole = try c.decodeIfPresent(String.self, forKey: .userRole)
        goal = try c.decodeIfPresent(String.self, forKey: .goal)
        keyPhrases = try c.decodeIfPresent([String].self, forKey: .keyPhrases)
        opener = try c.decode(String.self, forKey: .opener)
        openerZh = try c.decodeIfPresent(String.self, forKey: .openerZh)
        defaultDifficulty = try c.decodeIfPresent(SpeakDifficulty.self, forKey: .defaultDifficulty)
        // updatedAt 契约为整数毫秒；读侧与 Windows `typeof === "number"` 同样宽容小数形态。
        if let ms = try? c.decode(Int64.self, forKey: .updatedAt) {
            updatedAt = ms
        } else {
            updatedAt = Int64(try c.decode(Double.self, forKey: .updatedAt))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(source, forKey: .source)
        try c.encode(title, forKey: .title)
        try c.encodeIfPresent(emoji, forKey: .emoji)
        try c.encode(category, forKey: .category)
        try c.encode(aiRole, forKey: .aiRole)
        try c.encodeIfPresent(userRole, forKey: .userRole)
        try c.encodeIfPresent(goal, forKey: .goal)
        try c.encodeIfPresent(keyPhrases, forKey: .keyPhrases)
        try c.encode(opener, forKey: .opener)
        try c.encodeIfPresent(openerZh, forKey: .openerZh)
        try c.encodeIfPresent(defaultDifficulty, forKey: .defaultDifficulty)
        try c.encode(updatedAt, forKey: .updatedAt)
    }

    /// 从 JSON 对象（缓存文件 / 同步实体 payload 的 JSONSerialization 形态）宽容读取：
    /// 先过 isSpeakScenarioLike 必填校验，可选字段类型不符按缺省处理。
    public init?(jsonObject: Any?) {
        guard isSpeakScenarioLike(jsonObject), let dict = jsonObject as? [String: Any] else { return nil }
        guard let source = SpeakScenarioSource(rawValue: dict["source"] as? String ?? ""),
              let category = SpeakScenarioCategory(rawValue: dict["category"] as? String ?? ""),
              let updatedAt = speakJSONNumber(dict["updatedAt"]) else { return nil }
        self.init(
            id: dict["id"] as? String ?? "",
            source: source,
            title: dict["title"] as? String ?? "",
            emoji: dict["emoji"] as? String,
            category: category,
            aiRole: dict["aiRole"] as? String ?? "",
            userRole: dict["userRole"] as? String,
            goal: dict["goal"] as? String,
            keyPhrases: (dict["keyPhrases"] as? [Any]).map { $0.compactMap { $0 as? String } },
            opener: dict["opener"] as? String ?? "",
            openerZh: dict["openerZh"] as? String,
            defaultDifficulty: (dict["defaultDifficulty"] as? String).flatMap(SpeakDifficulty.init(rawValue:)),
            updatedAt: Int64(updatedAt)
        )
    }

    /// 场景 → JSON 对象（同步实体 payload / 缓存写入用；camelCase 键，可选字段 nil 不写）。
    public func jsonObject() -> [String: Any] {
        var out: [String: Any] = [
            "id": id,
            "source": source.rawValue,
            "title": title,
            "category": category.rawValue,
            "aiRole": aiRole,
            "opener": opener,
            "updatedAt": updatedAt,
        ]
        if let emoji { out["emoji"] = emoji }
        if let userRole { out["userRole"] = userRole }
        if let goal { out["goal"] = goal }
        if let keyPhrases { out["keyPhrases"] = keyPhrases }
        if let openerZh { out["openerZh"] = openerZh }
        if let defaultDifficulty { out["defaultDifficulty"] = defaultDifficulty.rawValue }
        return out
    }
}

/// JSON 数字提取（严格排除布尔，对齐 JS `typeof v === "number"`）。
private func speakJSONNumber(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber else { return nil }
    if number === kCFBooleanTrue || number === kCFBooleanFalse { return nil }
    return number.doubleValue
}

public let speakScenarios: [SpeakScenario] = [
    SpeakScenario(
        id: "ordering", source: .builtin, title: "点餐", emoji: "🍜", category: .daily,
        aiRole: "在英语餐厅点餐，你扮演友善的服务员，帮用户完成点单、推荐菜品、确认订单",
        opener: "Hi there! Welcome in. What can I get started for you today?",
        openerZh: "你好，欢迎光临！今天想吃点什么？（试着说：I'd like… / Can I have…）",
        updatedAt: builtinScenarioUpdatedAt
    ),
    SpeakScenario(
        id: "interview", source: .builtin, title: "面试", emoji: "💼", category: .workplace,
        aiRole: "英文面试模拟，你扮演温和的面试官，围绕自我介绍、经历、优缺点提问，一次只问一个问题",
        opener: "Good morning, thanks for coming in. Could you start by telling me a little about yourself?",
        openerZh: "早上好，先做个自我介绍吧。（提示：I'm currently… / I used to work…）",
        updatedAt: builtinScenarioUpdatedAt
    ),
    SpeakScenario(
        id: "travel", source: .builtin, title: "旅行", emoji: "✈️", category: .travel,
        aiRole: "旅行场景（机场、酒店、问路、购物），你扮演当地工作人员或热心路人",
        opener: "Good afternoon! You look a little lost — is there anything I can help you with?",
        openerZh: "下午好！看你想问路？（提示：Excuse me, how can I get to…）",
        updatedAt: builtinScenarioUpdatedAt
    ),
    SpeakScenario(
        id: "smalltalk", source: .builtin, title: "寒暄", emoji: "☕️", category: .daily,
        aiRole: "朋友间日常寒暄闲聊（天气、周末、近况、兴趣），你扮演老朋友，语气轻松",
        opener: "Hey! Long time no see. How has your week been going?",
        openerZh: "嘿，好久不见！这周过得怎么样？（提示：Pretty good, I… / Not bad, just…）",
        updatedAt: builtinScenarioUpdatedAt
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

// MARK: - 场景合并注册表（A1：官方目录 + 用户自建场景的内存载体，仅内存不落盘）

/// 运行时形状守卫（缓存/同步来的 JSON 进门校验；对齐 Windows isSpeakScenarioLike）：
/// 非空 string id + source 三枚举 + 非空 title + category 五枚举 + 非空 aiRole +
/// 非空 opener + number updatedAt；可选字段不校验（宽容读取），不按
/// maxLength/maxItems 拒收（限长是写入端约束）。
public func isSpeakScenarioLike(_ value: Any?) -> Bool {
    guard let sc = value as? [String: Any] else { return false }
    guard let id = sc["id"] as? String, !id.isEmpty else { return false }
    guard let source = sc["source"] as? String, SpeakScenarioSource(rawValue: source) != nil else { return false }
    guard let title = sc["title"] as? String, !title.isEmpty else { return false }
    guard let category = sc["category"] as? String, SpeakScenarioCategory(rawValue: category) != nil else { return false }
    guard let aiRole = sc["aiRole"] as? String, !aiRole.isEmpty else { return false }
    guard let opener = sc["opener"] as? String, !opener.isEmpty else { return false }
    guard speakJSONNumber(sc["updatedAt"]) != nil else { return false }
    return true
}

/// 类型化场景的必填非空校验（注册表入桶前的同一道门：枚举字段已由类型保证，
/// 只剩 id/title/aiRole/opener 的 minLength 1）。
public func isSpeakScenarioLike(_ scenario: SpeakScenario) -> Bool {
    !scenario.id.isEmpty && !scenario.title.isEmpty && !scenario.aiRole.isEmpty && !scenario.opener.isEmpty
}

/// 内置 id 集合：官方/用户桶与内置撞车的项直接丢弃（防目录脏数据带 ordering
/// 进来导致入口网格重复渲染；id 前缀 off_/usr_ 天然不撞，规则纯防御）。
let builtinScenarioIds: Set<String> = Set(speakScenarios.map(\.id))

/// 两个仅内存的桶（官方 / 用户），Windows 模块级 Map 的对应物：注册序保持
///（= 缓存文件序 = 服务端目录序 / = sync store 实体序），桶内同 id 保留先出现者。
/// 串行锁：preload/refresh 在任务里写、SwiftUI 在主线程读。
final class SpeakScenarioRegistry: @unchecked Sendable {
    static let shared = SpeakScenarioRegistry()

    private let lock = NSLock()
    private var official: [SpeakScenario] = []
    private var user: [SpeakScenario] = []

    /// 全量替换一个桶：逐项 isSpeakScenarioLike 过滤 + 内置撞车过滤 + 桶内同 id 保留先出现者。
    private static func replaceBucket(_ list: [SpeakScenario]) -> [SpeakScenario] {
        var seen = Set<String>()
        var out: [SpeakScenario] = []
        for sc in list {
            guard isSpeakScenarioLike(sc) else { continue }
            if builtinScenarioIds.contains(sc.id) { continue }
            if seen.contains(sc.id) { continue }
            seen.insert(sc.id)
            out.append(sc)
        }
        return out
    }

    func registerOfficial(_ list: [SpeakScenario]) {
        lock.lock()
        defer { lock.unlock() }
        official = Self.replaceBucket(list)
    }

    func registerUser(_ list: [SpeakScenario]) {
        lock.lock()
        defer { lock.unlock() }
        user = Self.replaceBucket(list)
    }

    func listOfficial() -> [SpeakScenario] {
        lock.lock()
        defer { lock.unlock() }
        return official
    }

    func listUser() -> [SpeakScenario] {
        lock.lock()
        defer { lock.unlock() }
        return user
    }

    func lookup(_ id: String) -> SpeakScenario? {
        lock.lock()
        defer { lock.unlock() }
        return official.first { $0.id == id } ?? user.first { $0.id == id }
    }
}

/// 全量替换官方场景桶（ScenarioCatalogService 装载缓存/拉取结果用）。
public func registerOfficialScenarios(_ list: [SpeakScenario]) {
    SpeakScenarioRegistry.shared.registerOfficial(list)
}

/// 全量替换用户场景桶（A0 同步来的 speak-scenarios 实体 payload）。
public func registerUserScenarios(_ list: [SpeakScenario]) {
    SpeakScenarioRegistry.shared.registerUser(list)
}

/// 官方桶注册序快照（「官方场景库」分组渲染用；=缓存文件序=服务端目录序）。
public func listOfficialScenarios() -> [SpeakScenario] {
    SpeakScenarioRegistry.shared.listOfficial()
}

/// 用户桶注册序快照（「我的场景」分组渲染用；=sync store 实体序）。
public func listUserScenarios() -> [SpeakScenario] {
    SpeakScenarioRegistry.shared.listUser()
}

/// 按 id 查场景（三桶合并查找）：内置（代码常量，永远就绪）→ 官方桶 → 用户桶 →
/// 兜底第一个内置场景（与既有 ?? speakScenarios[0] 行为一致，未知 id 的旧会话
/// resume 不崩）。
public func scenarioOf(_ id: SpeakScenarioId) -> SpeakScenario {
    speakScenarios.first { $0.id == id }
        ?? SpeakScenarioRegistry.shared.lookup(id)
        ?? speakScenarios[0]
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
    /// user 轮：本轮发言的发音评测（同一录音送 ISE；凭据缺失/失败时缺省，
    /// 对齐 contracts speakTurn.pron）。
    public var pron: ShadowAttempt?
    /// user 轮：表达改进建议（LLM 的 BETTER/TIP 两行落盘；旧会话无此字段，
    /// 对齐 contracts coachDiff）。
    public var coachDiff: CoachDiff?
    /// Unix 毫秒。
    public var at: Int64

    public init(
        role: Role, text: String, hintZh: String? = nil, shadowScore: Double? = nil,
        shadowAttempts: [ShadowAttempt]? = nil, pron: ShadowAttempt? = nil,
        coachDiff: CoachDiff? = nil, at: Int64
    ) {
        self.role = role
        self.text = text
        self.hintZh = hintZh
        self.shadowScore = shadowScore
        self.shadowAttempts = shadowAttempts
        self.pron = pron
        self.coachDiff = coachDiff
        self.at = at
    }

    enum CodingKeys: String, CodingKey {
        case role, text, hintZh, shadowScore, shadowAttempts, pron, coachDiff, at
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = try c.decode(Role.self, forKey: .role)
        text = try c.decode(String.self, forKey: .text)
        hintZh = try c.decodeIfPresent(String.self, forKey: .hintZh)
        shadowScore = try c.decodeIfPresent(Double.self, forKey: .shadowScore)
        shadowAttempts = try c.decodeIfPresent([ShadowAttempt].self, forKey: .shadowAttempts)
        pron = try c.decodeIfPresent(ShadowAttempt.self, forKey: .pron)
        coachDiff = try c.decodeIfPresent(CoachDiff.self, forKey: .coachDiff)
        at = try c.decodeIfPresent(Int64.self, forKey: .at) ?? 0
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(role, forKey: .role)
        try c.encode(text, forKey: .text)
        try c.encodeIfPresent(hintZh, forKey: .hintZh)
        try c.encodeIfPresent(shadowScore, forKey: .shadowScore)
        try c.encodeIfPresent(shadowAttempts, forKey: .shadowAttempts)
        try c.encodeIfPresent(pron, forKey: .pron)
        try c.encodeIfPresent(coachDiff, forKey: .coachDiff)
        try c.encode(at, forKey: .at)
    }
}

// MARK: - 表达改进建议（contracts coachDiff）

/// 词级对比片段：keep=两边都有 / del=用户原话里删掉 / ins=地道改写新加。
public struct CoachSeg: Codable, Equatable, Sendable {
    public enum SegKind: String, Codable, Sendable {
        case keep
        case del
        case ins
    }

    public var t: SegKind
    public var v: String

    public init(t: SegKind, v: String) {
        self.t = t
        self.v = v
    }

    enum CodingKeys: String, CodingKey {
        case t, v
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        t = try c.decodeIfPresent(SegKind.self, forKey: .t) ?? .keep
        v = try c.decodeIfPresent(String.self, forKey: .v) ?? ""
    }
}

/// 用户一轮发言的表达改进建议（BETTER 改写的词级增删对比 + TIP 点评）。
public struct CoachDiff: Codable, Equatable, Sendable {
    public var segs: [CoachSeg]
    /// 一句中文点评（模型 TIP 行）；缺省 = 模型没给。
    public var note: String?

    public init(segs: [CoachSeg], note: String? = nil) {
        self.segs = segs
        self.note = note
    }

    enum CodingKeys: String, CodingKey {
        case segs, note
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        segs = try c.decodeIfPresent([CoachSeg].self, forKey: .segs) ?? []
        note = try c.decodeIfPresent(String.self, forKey: .note)
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

/// 会话语境（v0.8 场景中心，contracts speakSessionContext）：book=聊刚读的
/// 章节，vocab=生词造句闯关。A1 起 SpeakScenarioId 已放开为 String（官方/用户
/// 场景可作会话场景），语境仍由这个可选字段承载，老会话无 context 原样可读。
public enum SpeakSessionContext: Equatable, Sendable {
    /// 聊刚读的章节。
    case book(bookTitle: String, chapterArticleId: String, chapterIdx: Int, excerpt: [String])
    /// 今日生词造句闯关（待复习生词 id 列表）。
    case vocab(wordIds: [String])

    enum CodingKeys: String, CodingKey {
        case kind, bookTitle, chapterArticleId, chapterIdx, excerpt, wordIds
    }
}

extension SpeakSessionContext: Codable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        switch kind {
        case "book":
            self = .book(
                bookTitle: try c.decodeIfPresent(String.self, forKey: .bookTitle) ?? "",
                chapterArticleId: try c.decodeIfPresent(String.self, forKey: .chapterArticleId) ?? "",
                chapterIdx: try c.decodeIfPresent(Int.self, forKey: .chapterIdx) ?? 0,
                excerpt: try c.decodeIfPresent([String].self, forKey: .excerpt) ?? []
            )
        case "vocab":
            self = .vocab(wordIds: try c.decodeIfPresent([String].self, forKey: .wordIds) ?? [])
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: c,
                debugDescription: "未知 speakSessionContext.kind：\(kind)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .book(bookTitle, chapterArticleId, chapterIdx, excerpt):
            try c.encode("book", forKey: .kind)
            try c.encode(bookTitle, forKey: .bookTitle)
            try c.encode(chapterArticleId, forKey: .chapterArticleId)
            try c.encode(chapterIdx, forKey: .chapterIdx)
            try c.encode(excerpt, forKey: .excerpt)
        case let .vocab(wordIds):
            try c.encode("vocab", forKey: .kind)
            try c.encode(wordIds, forKey: .wordIds)
        }
    }
}

/// 送进系统提示的目标词（词面 + 一句中文义）。
public struct SpeakContextTarget: Equatable, Sendable {
    public var word: String
    public var zh: String

    public init(word: String, zh: String) {
        self.word = word
        self.zh = zh
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
    /// 会话语境（v0.8）：book/vocab 场景的额外上下文；老会话无此字段。
    public var context: SpeakSessionContext?

    public init(
        id: String, scenario: SpeakScenarioId, difficulty: SpeakDifficulty,
        turns: [SpeakTurn], createdAt: Int64, updatedAt: Int64,
        context: SpeakSessionContext? = nil
    ) {
        self.id = id
        self.scenario = scenario
        self.difficulty = difficulty
        self.turns = turns
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.context = context
    }

    enum CodingKeys: String, CodingKey {
        case id, scenario, difficulty, turns, createdAt, updatedAt, context
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        // 裸 String（旧四值 JSON 天然兼容；off_/usr_ 未知 id 不再让整库 decode 失败，
        // 对齐 Windows speak_store.rs `pub scenario: String`）。
        scenario = try c.decode(String.self, forKey: .scenario)
        difficulty = try c.decode(SpeakDifficulty.self, forKey: .difficulty)
        turns = try c.decode([SpeakTurn].self, forKey: .turns)
        createdAt = try c.decode(Int64.self, forKey: .createdAt)
        updatedAt = try c.decode(Int64.self, forKey: .updatedAt)
        context = try c.decodeIfPresent(SpeakSessionContext.self, forKey: .context)
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
    now: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
    context: SpeakSessionContext? = nil
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
        updatedAt: now,
        context: context
    )
}

// MARK: - 会话语境（v0.8 场景中心）

/// 语境会话（book/vocab）的开场白：模板 + 真实数据插值（与 speakScenarios 的
/// 静态开场白同一性质，不引入演示内容；对齐 Windows contextOpener）。
public func speakContextOpener(_ context: SpeakSessionContext) -> (text: String, hintZh: String) {
    switch context {
    case let .book(bookTitle, _, chapterIdx, excerpt):
        let lead = excerpt.first.flatMap { $0.isEmpty ? nil : " Starting from: “\($0)”" } ?? ""
        return (
            "Let's talk about Chapter \(chapterIdx + 1) of “\(bookTitle)”.\(lead) What struck you most so far?",
            "来聊聊《\(bookTitle)》第 \(chapterIdx + 1) 章——试着在回答里用上你刚收集的词块。"
        )
    case .vocab:
        return (
            "Let's put your target words to work today. I'll ask about real-life situations — just answer naturally and try to use them.",
            "生词造句闯关开始：回答 AI 的生活化提问时，用上待复习的词就算过关。"
        )
    }
}

/// 语境会话的目标词（chips / 系统提示 / SRS 过关共用）：book=本章生词，
/// vocab=会话记录的待复习词；zh 取首个义项（无义项回落音标，对齐 Windows
/// contextTargets 的 zhOf）。
public func speakContextTargets(
    context: SpeakSessionContext?, vocabWords: [VocabWord]
) -> [(word: VocabWord, zh: String)] {
    guard let context else { return [] }
    let zhOf = { (w: VocabWord) in w.senses.first?.cn ?? w.phonetic ?? "" }
    switch context {
    case let .book(_, chapterArticleId, _, _):
        return vocabWords
            .filter { $0.source.articleId == chapterArticleId }
            .map { ($0, zhOf($0)) }
    case let .vocab(wordIds):
        let byId = Dictionary(uniqueKeysWithValues: vocabWords.map { ($0.id, $0) })
        return wordIds.compactMap { byId[$0] }.map { ($0, zhOf($0)) }
    }
}

/// 目标词在本会话里是否已被用出（扫全部 user 轮的命中集合，重开会话也保真）。
public func speakHitTargetIds(turns: [SpeakTurn], targets: [(word: VocabWord, zh: String)]) -> Set<String> {
    var hits = Set<String>()
    for t in turns where t.role == .user && !t.text.isEmpty {
        for target in targets where textHitsTarget(t.text, target.word.word) {
            hits.insert(target.word.id)
        }
    }
    return hits
}

/// 入口页「聊刚读的章节」卡的语境（对齐 ReaderApp.speakBookContext）：只有书章
/// 给出（短文无章节概念，避免「第 1 章」的假上下文）；摘要取章内前三句英文，
/// 整章无句时回落标题。无在读文章 / 非书章返回 nil（卡不渲染）。
public func speakBookContext(article: Article?, book: BookMeta?) -> SpeakSessionContext? {
    guard let article, let book, article.bookId == book.id else { return nil }
    let chapterIdx = article.chapterIdx ?? bookChapterIndexOf(book: book, chapterId: article.id)
    let ens = article.sentences.map(\.en).filter { !$0.isEmpty }
    let excerpt = Array(ens.prefix(3))
    return .book(
        bookTitle: book.title,
        chapterArticleId: article.id,
        chapterIdx: chapterIdx,
        excerpt: excerpt.isEmpty ? [article.title] : excerpt
    )
}

/// 场景标题（语境会话优先；最近会话行与对话页头部共用，对齐 sceneTitleOf）。
public func speakSceneTitle(_ session: SpeakSession) -> String {
    switch session.context {
    case let .book(bookTitle, _, chapterIdx, _):
        return "聊刚读的《\(bookTitle)》第 \(chapterIdx + 1) 章"
    case .vocab:
        return "今日生词造句闯关"
    case nil:
        return speakScenarioCardTitle(session.scenario)
    }
}

/// 日常场景卡的展示标题（原型定稿直白中文；对齐 SCENARIO_CARDS）。内置 id 直取
/// 本地卡文案（输出与旧版逐字一致）；off_/usr_ 未知 id 走合并查找——目录未装载/
/// 已删的场景短暂显示「自定义场景」，装载后重渲染显真名，绝不崩（对齐 Windows
/// SpeakView.tsx sceneTitleOf）。
public func speakScenarioCardTitle(_ id: SpeakScenarioId) -> String {
    switch id {
    case "interview": return "英文面试"
    case "ordering": return "餐厅点餐"
    case "travel": return "旅行问路与入住"
    case "smalltalk": return "日常闲聊寒暄"
    default:
        let sc = scenarioOf(id)
        return sc.id == id ? sc.title : "自定义场景"
    }
}

/// 日常场景卡的展示顺序（原型：面试 → 点餐 → 旅行 → 寒暄）。
public let speakScenarioCardOrder: [SpeakScenarioId] = ["interview", "ordering", "travel", "smalltalk"]

/// 日常场景卡的展示文案（标签/标题/描述，非演示数据）。
public func speakScenarioCardDesc(_ id: SpeakScenarioId) -> String {
    switch id {
    case "interview":
        return "扮演温和的面试官，围绕自我介绍、项目经历、优缺点逐轮提问并帮你润色回答。"
    case "ordering":
        return "在英文餐厅点单、询问今日特色菜、表达忌口偏好与结账沟通。"
    case "travel":
        return "涵盖机场值机、酒店前台办理入住、在陌生城市向当地人问路。"
    case "smalltalk":
        return "像老朋友一样聊聊这周过得怎么样、周末计划、天气或最近看的一本书。"
    default:
        return scenarioOf(id).aiRole
    }
}

/// 日常场景卡 tag 位的短标签（原型 SCENARIO_CARDS.tag）。
public func speakScenarioCardTag(_ id: SpeakScenarioId) -> String {
    switch id {
    case "interview": return "职场高频"
    case "ordering": return "生活实用"
    case "travel": return "出行必备"
    case "smalltalk": return "轻松开口"
    default: return speakScenarioCategoryTag(scenarioOf(id).category)
    }
}

/// 官方/用户场景卡 tag 位的分类词（对齐 Windows CATEGORY_TAG_ZH）。
public func speakScenarioCategoryTag(_ category: SpeakScenarioCategory) -> String {
    switch category {
    case .daily: return "日常"
    case .travel: return "旅行"
    case .workplace: return "职场"
    case .academic: return "学术"
    case .custom: return "自定义"
    }
}

// MARK: - LLM 对话

/// 送 LLM 的系统提示：场景角色 + 严格的 EN/ZH/BETTER/TIP 四行格式 + 可选会话语境
/// （book 注入章节摘要、vocab 注入待复习词表，均诱导用户在回答中用出目标词）。
public func buildSpeakSystemPrompt(
    _ scenario: SpeakScenarioId,
    _ difficulty: SpeakDifficulty,
    context: SpeakSessionContext? = nil,
    targets: [SpeakContextTarget]? = nil
) -> String {
    let sc = scenarioOf(scenario)
    let diff = difficultyOf(difficulty)
    var lines = [
        "你是用户的英语口语陪练伙伴。场景：\(sc.aiRole)。难度：\(diff.note)。",
    ]
    let targetList = (targets ?? []).map { "\($0.word)（\($0.zh)）" }.joined(separator: "、")
    switch context {
    case let .book(bookTitle, _, chapterIdx, excerpt):
        let excerptText = excerpt.joined(separator: " ").trimmingCharacters(in: .whitespaces)
        lines.append(
            "本次对话语境：用户刚读完《\(bookTitle)》第 \(chapterIdx + 1) 章。"
                + (excerptText.isEmpty ? "" : "章节开头摘要：\(excerptText)")
        )
        lines.append("围绕这一章的情节、人物或主题与用户讨论，提问时自然引导用户用出下面这些目标词块。")
        if !targetList.isEmpty {
            lines.append("目标词块（诱导用户在回答中自然用出）：\(targetList)。")
        }
    case .vocab:
        lines.append("本次对话语境：生词造句闯关。")
        if !targetList.isEmpty {
            lines.append(
                "待复习词表：\(targetList)。出生活化情境的提问，诱导用户在回答里用出这些词；用户用对就算过关，及时给正面反馈。"
            )
        }
    case nil:
        break
    }
    lines.append(contentsOf: [
        "",
        "对话规则：",
        "- 每轮回复 1–3 句地道口语英文，像真人一样自然推进场景，结尾尽量给用户留出接话的空间（提问或等待回应）。",
        "- 回复格式必须严格四行：第一行以 \"EN: \" 开头，是你的英文回复；第二行以 \"ZH: \" 开头，是一句简短中文提示（你这句的意思 + 用户可以怎么接）；第三行以 \"BETTER: \" 开头，把用户刚才的发言改写成一个更地道的完整英文句子（保留用户原意，用户已说得地道时可在其基础上小幅润色）；第四行以 \"TIP: \" 开头，是一句中文点评（点出改写的关键点）。",
        "- 用户的话来自语音识别，可能有错词，结合上下文善意理解；用户说了中文时，用简单英语温和提醒 TA 试着用英语说。",
        "- 不要输出这四行以外的任何内容（不要代码块、不要解释）。",
    ])
    return lines.joined(separator: "\n")
}

/// 送 LLM 的用户消息：近几轮对话记录 + 本轮用户发言。
/// 注意：turns 传「已入会话的轮次、不含本轮 user 轮」——本轮发言由 userText
/// 单独拼入，末句在输入里只出现一次（对齐 Windows 调用方传 slice(0, -1)）。
public func buildSpeakUserInput(_ turns: [SpeakTurn], _ userText: String) -> String {
    let recent = turns.suffix(12)
    var lines = recent.map { t in
        t.role == .user ? "我: \(t.text)" : "你: \(t.text)"
    }
    lines.append("我: \(userText)")
    return (["对话记录（最新在下）："] + lines + ["", "请给出你的下一轮回复（EN: / ZH: / BETTER: / TIP: 四行）。"]).joined(separator: "\n")
}

/// parseAssistantReply 的返回：better/tip 缺行时为 nil（旧两行回复完全兼容）。
public struct ParsedAssistantReply: Equatable {
    public var en: String
    public var zh: String
    /// 用户发言的地道改写（BETTER 行）；模型没给时 nil。
    public var better: String?
    /// 一句中文点评（TIP 行）；模型没给时 nil。
    public var tip: String?

    public init(en: String, zh: String, better: String? = nil, tip: String? = nil) {
        self.en = en
        self.zh = zh
        self.better = better
        self.tip = tip
    }
}

/// 解析模型回复为 { en, zh, better?, tip? }。宽容处理：剥代码块围栏；找不到
/// "ZH:" 时中文提示置空；整段没有 EN: 标记时把全文当英文回复（不丢内容）。
/// BETTER/TIP 行缺失时置 nil（老两行格式的回复照常解析）。
/// 与 ts 的一处有意差异：标记冒号后只吃行内空白（[ \t]*），不吞换行——
/// 「BETTER: 」空行紧接 TIP 时 ts 会把下一行误捕获成 better，这里正确得到 nil；
/// 正常回复（含内容另起一行的情况）两边结果一致。
public func parseAssistantReply(_ raw: String) -> ParsedAssistantReply {
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

    let en = capture(#"(?:^|\n)[ \t]*EN[:：][ \t]*([\s\S]*?)(?=\n[ \t]*(?:ZH|BETTER|TIP)[:：]|$)"#)
        ?? text.replacingOccurrences(of: #"(?:^|\n)[ \t]*(?:ZH|BETTER|TIP)[:：][\s\S]*$"#, with: "", options: [.regularExpression, .caseInsensitive])
    let zh = capture(#"(?:^|\n)[ \t]*ZH[:：][ \t]*([\s\S]*?)(?=\n[ \t]*(?:BETTER|TIP)[:：]|$)"#) ?? ""
    let better = capture(#"(?:^|\n)[ \t]*BETTER[:：][ \t]*([\s\S]*?)(?=\n[ \t]*(?:ZH|TIP)[:：]|$)"#)
    let tip = capture(#"(?:^|\n)[ \t]*TIP[:：][ \t]*([\s\S]*?)$"#)
    let collapse = { (s: String) in
        s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    var out = ParsedAssistantReply(en: collapse(en), zh: collapse(zh))
    let betterText = better.map(collapse) ?? ""
    if !betterText.isEmpty { out.better = betterText }
    let tipText = tip.map(collapse) ?? ""
    if !tipText.isEmpty { out.tip = tipText }
    return out
}

// MARK: - 表达改进的词级对比（LCS 对齐）

/// 表达改进对比的词级 token 化（对齐 recallJudge.wordDiff 的切词思路）：
/// 单词（含词中撇号/连字符，don't / long-term 不拆）与标点各算一个 token。
func coachDiffTokens(_ s: String) -> [String] {
    guard let re = try? NSRegularExpression(pattern: #"[A-Za-z0-9'’-]+|[.,!?;:()\"]"#) else { return [] }
    let ns = s as NSString
    return re.matches(in: s, range: NSRange(location: 0, length: ns.length))
        .compactMap { Range($0.range, in: s).map { String(s[$0]) } }
}

/// 用户原话与地道改写的词级增删对比（LCS 对齐）：
/// keep=两边都有；del=只出现在用户原话（建议删掉）；ins=只出现在改写（建议这样说）。
/// 保持两边各自的词序，相邻同状态片段合并。
public func computeCoachDiff(original: String, better: String) -> [CoachSeg] {
    let a = coachDiffTokens(original)
    let b = coachDiffTokens(better)
    let m = a.count
    let n = b.count
    var dp = [[Int]](repeating: [Int](repeating: 0, count: n + 1), count: m + 1)
    if m >= 1 && n >= 1 {
        for i in 1...m {
            for j in 1...n {
                if a[i - 1].lowercased() == b[j - 1].lowercased() {
                    dp[i][j] = dp[i - 1][j - 1] + 1
                } else {
                    dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])
                }
            }
        }
    }
    var rev = [CoachSeg]()
    var i = m
    var j = n
    // 反向回溯时前插；相邻同状态片段合并（与 unshift + 头部合并语义一致）。
    func push(_ t: CoachSeg.SegKind, _ v: String) {
        if let first = rev.first, first.t == t {
            rev[0] = CoachSeg(t: t, v: "\(v) \(first.v)")
        } else {
            rev.insert(CoachSeg(t: t, v: v), at: 0)
        }
    }
    while i > 0 && j > 0 {
        if a[i - 1].lowercased() == b[j - 1].lowercased() {
            push(.keep, b[j - 1])
            i -= 1
            j -= 1
        } else if dp[i - 1][j] >= dp[i][j - 1] {
            push(.del, a[i - 1])
            i -= 1
        } else {
            push(.ins, b[j - 1])
            j -= 1
        }
    }
    while i > 0 {
        push(.del, a[i - 1])
        i -= 1
    }
    while j > 0 {
        push(.ins, b[j - 1])
        j -= 1
    }
    return rev
}

/// 会话最近的 assistant 英文（跟读参考文本用）。
public func lastAssistantText(_ turns: [SpeakTurn]) -> String? {
    for turn in turns.reversed() where turn.role == .assistant && !turn.text.trimmingCharacters(in: .whitespaces).isEmpty {
        return turn.text
    }
    return nil
}
