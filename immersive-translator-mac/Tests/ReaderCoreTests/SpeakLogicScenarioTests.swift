import XCTest
@testable import ReaderCore

/// 口语场景体系（A1）：内置场景迁移逐字基线、三桶合并查找与回退、注册表替换规则、
/// isSpeakScenarioLike 矩阵、SpeakSession.scenario 字符串化的存取兼容。
/// 行为向量对齐 Windows src/core/speakLogic.test.ts:255-418 与 speak_store.rs
/// `unknown_scenario_id_survives_roundtrip`。
final class SpeakLogicScenarioTests: XCTestCase {
    override func setUp() {
        super.setUp()
        // 注册表是进程级可变态，逐例清空防串扰（speakLogic.test.ts beforeEach 同款做法）
        registerOfficialScenarios([])
        registerUserScenarios([])
    }

    /// 合法场景构造器（必填字段给默认值，overrides 覆盖）。
    private func makeScenario(
        _ id: String, source: SpeakScenarioSource = .official, title: String? = nil,
        category: SpeakScenarioCategory = .daily, keyPhrases: [String]? = nil,
        emoji: String? = nil, openerZh: String? = nil
    ) -> SpeakScenario {
        SpeakScenario(
            id: id, source: source, title: title ?? "title-\(id)", emoji: emoji, category: category,
            aiRole: "aiRole-\(id)", keyPhrases: keyPhrases, opener: "opener-\(id)", openerZh: openerZh,
            updatedAt: 1
        )
    }

    private func byId(_ id: String) -> SpeakScenario {
        speakScenarios.first { $0.id == id }!
    }

    // MARK: - 内置场景迁移逐字基线（label→title、brief→aiRole，文案一字不动）

    func testBuiltinTitleAiRoleOpenerOpenerZhVerbatim() {
        XCTAssertEqual(byId("ordering").title, "点餐")
        XCTAssertEqual(byId("ordering").aiRole, "在英语餐厅点餐，你扮演友善的服务员，帮用户完成点单、推荐菜品、确认订单")
        XCTAssertEqual(byId("ordering").opener, "Hi there! Welcome in. What can I get started for you today?")
        XCTAssertEqual(byId("ordering").openerZh, "你好，欢迎光临！今天想吃点什么？（试着说：I'd like… / Can I have…）")
        XCTAssertEqual(byId("ordering").emoji, "🍜")

        XCTAssertEqual(byId("interview").title, "面试")
        XCTAssertEqual(byId("interview").aiRole, "英文面试模拟，你扮演温和的面试官，围绕自我介绍、经历、优缺点提问，一次只问一个问题")
        XCTAssertEqual(byId("interview").opener, "Good morning, thanks for coming in. Could you start by telling me a little about yourself?")
        XCTAssertEqual(byId("interview").openerZh, "早上好，先做个自我介绍吧。（提示：I'm currently… / I used to work…）")
        XCTAssertEqual(byId("interview").emoji, "💼")

        XCTAssertEqual(byId("travel").title, "旅行")
        XCTAssertEqual(byId("travel").aiRole, "旅行场景（机场、酒店、问路、购物），你扮演当地工作人员或热心路人")
        XCTAssertEqual(byId("travel").opener, "Good afternoon! You look a little lost — is there anything I can help you with?")
        XCTAssertEqual(byId("travel").openerZh, "下午好！看你想问路？（提示：Excuse me, how can I get to…）")
        XCTAssertEqual(byId("travel").emoji, "✈️")

        XCTAssertEqual(byId("smalltalk").title, "寒暄")
        XCTAssertEqual(byId("smalltalk").aiRole, "朋友间日常寒暄闲聊（天气、周末、近况、兴趣），你扮演老朋友，语气轻松")
        XCTAssertEqual(byId("smalltalk").opener, "Hey! Long time no see. How has your week been going?")
        XCTAssertEqual(byId("smalltalk").openerZh, "嘿，好久不见！这周过得怎么样？（提示：Pretty good, I… / Not bad, just…）")
        XCTAssertEqual(byId("smalltalk").emoji, "☕️")
    }

    func testBuiltinSourceCategoryUpdatedAt() {
        XCTAssertEqual(speakScenarios.count, 4)
        for s in speakScenarios {
            XCTAssertEqual(s.source, .builtin)
            XCTAssertEqual(s.updatedAt, builtinScenarioUpdatedAt)
        }
        // Date.UTC(2026, 0, 1) = 2026-01-01T00:00:00Z
        XCTAssertEqual(builtinScenarioUpdatedAt, 1_767_225_600_000)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let date = Date(timeIntervalSince1970: TimeInterval(builtinScenarioUpdatedAt) / 1000)
        let parts = cal.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        XCTAssertEqual([parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second], [2026, 1, 1, 0, 0, 0])
        XCTAssertEqual(byId("ordering").category, .daily)
        XCTAssertEqual(byId("interview").category, .workplace)
        XCTAssertEqual(byId("travel").category, .travel)
        XCTAssertEqual(byId("smalltalk").category, .daily)
    }

    /// 迁移前（label/brief 版本）真实跑出的 buildSpeakSystemPrompt(id, easy) 全串快照
    ///（从 Windows speakLogic.test.ts:260-273 的 JSON 基线逐字生成）：迁移后输出必须
    /// 与这四条全串相等——system prompt 逐字不变的最后防线。
    func testBuildSpeakSystemPromptEasySnapshotsByteEqual() {
        for (id, expected) in Self.expectedPromptEasy {
            XCTAssertEqual(buildSpeakSystemPrompt(id, .easy), expected, "场景 \(id) 的系统提示应逐字节相等")
        }
    }

    // MARK: - 三桶合并查找与回退

    func testOfficialBucketHit() {
        registerOfficialScenarios([makeScenario("off_demo", title: "官方演示")])
        XCTAssertEqual(scenarioOf("off_demo").title, "官方演示")
        XCTAssertEqual(scenarioOf("off_demo").source, .official)
    }

    func testUserBucketHit() {
        registerUserScenarios([makeScenario("usr_uuid-1", source: .user, title: "我的机场值机")])
        XCTAssertEqual(scenarioOf("usr_uuid-1").title, "我的机场值机")
        XCTAssertEqual(scenarioOf("usr_uuid-1").source, .user)
    }

    func testCollisionPriorityBuiltinOverOfficialOverUser() {
        // official 注册与内置同 id 的伪造场景 → 内置赢（且撞车项根本不进桶）
        registerOfficialScenarios([makeScenario("ordering", title: "伪造点餐")])
        XCTAssertEqual(scenarioOf("ordering").title, "点餐")
        XCTAssertEqual(listOfficialScenarios(), [])
        // official 与 user 同 id → official 赢
        registerOfficialScenarios([makeScenario("off_dup", title: "official 版")])
        registerUserScenarios([makeScenario("off_dup", source: .user, title: "user 版")])
        XCTAssertEqual(scenarioOf("off_dup").title, "official 版")
    }

    func testUnknownIdFallsBackToFirstBuiltinEvenWhenRegistryNonEmpty() {
        XCTAssertEqual(scenarioOf("nope").id, "ordering")
        registerOfficialScenarios([makeScenario("off_demo")])
        registerUserScenarios([makeScenario("usr_x", source: .user)])
        XCTAssertEqual(scenarioOf("nope").id, "ordering")
    }

    func testInvalidItemsFilteredOutOfBucket() {
        // 缺必填（title 空）的项不进桶，scenarioOf 走回退
        registerOfficialScenarios([
            makeScenario("off_x", title: ""),
            makeScenario("off_ok"),
        ])
        XCTAssertEqual(listOfficialScenarios().map(\.id), ["off_ok"])
        XCTAssertEqual(scenarioOf("off_x").id, "ordering")
    }

    func testListOrderIsRegistrationOrderAndFirstDuplicateWins() {
        registerOfficialScenarios([makeScenario("off_a"), makeScenario("off_b")])
        registerUserScenarios([makeScenario("usr_1", source: .user), makeScenario("usr_2", source: .user)])
        XCTAssertEqual(listOfficialScenarios().map(\.id), ["off_a", "off_b"])
        XCTAssertEqual(listUserScenarios().map(\.id), ["usr_1", "usr_2"])
        // 桶内同 id：先出现的赢
        registerOfficialScenarios([
            makeScenario("off_a", title: "第一"),
            makeScenario("off_a", title: "第二"),
        ])
        XCTAssertEqual(listOfficialScenarios().count, 1)
        XCTAssertEqual(scenarioOf("off_a").title, "第一")
    }

    // MARK: - isSpeakScenarioLike 矩阵

    private func baseJSON() -> [String: Any] {
        [
            "id": "off_t", "source": "official", "title": "title-off_t", "category": "daily",
            "aiRole": "aiRole-off_t", "opener": "opener-off_t", "updatedAt": 1,
        ]
    }

    func testIsSpeakScenarioLikeMatrix() {
        // 全字段合法（含可选）true
        var full = baseJSON()
        full["emoji"] = "🍜"
        full["openerZh"] = "zh"
        full["keyPhrases"] = ["a", "b"]
        XCTAssertTrue(isSpeakScenarioLike(full))
        // 只给必填（可选项全缺）仍合法
        XCTAssertTrue(isSpeakScenarioLike(baseJSON()))
        // 缺任一必填
        for key in ["id", "source", "title", "category", "aiRole", "opener", "updatedAt"] {
            var broken = baseJSON()
            broken.removeValue(forKey: key)
            XCTAssertFalse(isSpeakScenarioLike(broken), "缺 \(key) 应判非法")
        }
        // 类型错
        var idNum = baseJSON(); idNum["id"] = 42
        XCTAssertFalse(isSpeakScenarioLike(idNum))
        var badSource = baseJSON(); badSource["source"] = "unknown"
        XCTAssertFalse(isSpeakScenarioLike(badSource))
        var badCategory = baseJSON(); badCategory["category"] = "other"
        XCTAssertFalse(isSpeakScenarioLike(badCategory))
        var strUpdated = baseJSON(); strUpdated["updatedAt"] = "1767225600000"
        XCTAssertFalse(isSpeakScenarioLike(strUpdated))
        var boolUpdated = baseJSON(); boolUpdated["updatedAt"] = true
        XCTAssertFalse(isSpeakScenarioLike(boolUpdated), "布尔不是 number")
        // 空串 / null / 非对象
        var emptyTitle = baseJSON(); emptyTitle["title"] = ""
        XCTAssertFalse(isSpeakScenarioLike(emptyTitle))
        XCTAssertFalse(isSpeakScenarioLike(nil))
        XCTAssertFalse(isSpeakScenarioLike(NSNull()))
        XCTAssertFalse(isSpeakScenarioLike("ordering"))
        // 读侧不按 maxLength/maxItems 拒收（限长是写入端约束）
        var long = baseJSON()
        long["aiRole"] = String(repeating: "a", count: 400)
        long["keyPhrases"] = Array(repeating: "p", count: 12)
        XCTAssertTrue(isSpeakScenarioLike(long))
    }

    func testScenarioJSONRoundtripViaJsonObject() throws {
        let sc = makeScenario("usr_a", source: .user, category: .custom, keyPhrases: ["close the deal"], emoji: "🤝", openerZh: "zh")
        let json = sc.jsonObject()
        XCTAssertEqual(json["source"] as? String, "user")
        XCTAssertEqual(json["category"] as? String, "custom")
        XCTAssertNil(json["userRole"], "可选 nil 不写键")
        XCTAssertEqual(SpeakScenario(jsonObject: json), sc)
        // Codable 往返（SyncStore payload / 缓存经 JSONSerialization，同形状）
        let data = try JSONEncoder().encode(sc)
        XCTAssertEqual(try JSONDecoder().decode(SpeakScenario.self, from: data), sc)
        let dict = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(dict["goal"])
        XCTAssertEqual(dict["keyPhrases"] as? [String], ["close the deal"])
    }

    // MARK: - SpeakSession.scenario 字符串化（对齐 speak_store.rs:349-366）

    func testSessionWithUnknownScenarioIdSurvivesRoundtrip() throws {
        for id in ["off_demo", "usr_6f1c2b2e-0d3b-4e4a-9a1c-2c3d4e5f6a7b"] {
            let session = SpeakSession(
                id: "s-\(id)", scenario: id, difficulty: .medium,
                turns: [SpeakTurn(role: .assistant, text: "Hi", at: 1)],
                createdAt: 1, updatedAt: 2
            )
            let data = try JSONEncoder().encode(SpeakSessionsFile(sessions: [session]))
            let back = try JSONDecoder().decode(SpeakSessionsFile.self, from: data)
            XCTAssertEqual(back.sessions.first?.scenario, id)
            XCTAssertEqual(back.sessions.first, session)
        }
    }

    func testLegacyFourValueSessionJSONStillDecodes() throws {
        let legacy = """
        {"schemaVersion":1,"sessions":[
          {"id":"s1","scenario":"ordering","difficulty":"easy","turns":[],"createdAt":1,"updatedAt":1},
          {"id":"s2","scenario":"smalltalk","difficulty":"hard","turns":[],"createdAt":1,"updatedAt":1,
           "context":{"kind":"vocab","wordIds":["w1"]}}
        ]}
        """
        let file = try JSONDecoder().decode(SpeakSessionsFile.self, from: Data(legacy.utf8))
        XCTAssertEqual(file.sessions.map(\.scenario), ["ordering", "smalltalk"])
        XCTAssertEqual(file.sessions[1].context, .vocab(wordIds: ["w1"]))
        // 序列化形态：scenario 是裸字符串值（与旧枚举 rawValue 相同，文件原样兼容）
        let data = try JSONEncoder().encode(file)
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(text.contains("\"scenario\":\"ordering\""))
    }

    func testNewSpeakSessionUsesMergedLookupForOpener() {
        registerUserScenarios([
            SpeakScenario(
                id: "usr_open", source: .user, title: "t", category: .custom, aiRole: "r",
                opener: "Shall we begin?", openerZh: "开始吧", updatedAt: 1
            ),
        ])
        let s = newSpeakSession("usr_open", .easy, now: 7)
        XCTAssertEqual(s.scenario, "usr_open")
        XCTAssertEqual(s.turns[0].text, "Shall we begin?")
        XCTAssertEqual(s.turns[0].hintZh, "开始吧")
        // 未知 id：兜底第一个内置（ordering）的开场白，不崩
        let ghost = newSpeakSession("usr_ghost", .easy, now: 7)
        XCTAssertEqual(ghost.scenario, "usr_ghost")
        XCTAssertEqual(ghost.turns[0].text, speakScenarios[0].opener)
    }

    // MARK: - 场景标题兜底（SpeakView.tsx sceneTitleOf）

    func testSceneTitleFallbackForUnknownAndRegisteredIds() {
        XCTAssertEqual(speakScenarioCardTitle("interview"), "英文面试")
        XCTAssertEqual(speakScenarioCardTitle("ordering"), "餐厅点餐")
        XCTAssertEqual(speakScenarioCardTitle("travel"), "旅行问路与入住")
        XCTAssertEqual(speakScenarioCardTitle("smalltalk"), "日常闲聊寒暄")
        // 目录未装载 / 已删：显示「自定义场景」绝不崩
        XCTAssertEqual(speakScenarioCardTitle("usr_gone"), "自定义场景")
        // 装载后显真名
        registerUserScenarios([makeScenario("usr_gone", source: .user, title: "我的场景")])
        XCTAssertEqual(speakScenarioCardTitle("usr_gone"), "我的场景")
        let session = SpeakSession(id: "s", scenario: "usr_gone", difficulty: .easy, turns: [], createdAt: 1, updatedAt: 1)
        XCTAssertEqual(speakSceneTitle(session), "我的场景")
    }

    func testCategoryTagVerbatim() {
        XCTAssertEqual(SpeakScenarioCategory.allCases.map(speakScenarioCategoryTag), ["日常", "旅行", "职场", "学术", "自定义"])
    }

    // MARK: - Windows speakLogic.test.ts:260-273 的 JSON 基线（逐字生成）

    private static let expectedPromptEasy: [String: String] = [
        "ordering": "你是用户的英语口语陪练伙伴。场景：在英语餐厅点餐，你扮演友善的服务员，帮用户完成点单、推荐菜品、确认订单。难度：用最简单的词汇和短句，放慢节奏，多给鼓励。\n\n对话规则：\n- 每轮回复 1–3 句地道口语英文，像真人一样自然推进场景，结尾尽量给用户留出接话的空间（提问或等待回应）。\n- 回复格式必须严格四行：第一行以 \"EN: \" 开头，是你的英文回复；第二行以 \"ZH: \" 开头，是一句简短中文提示（你这句的意思 + 用户可以怎么接）；第三行以 \"BETTER: \" 开头，把用户刚才的发言改写成一个更地道的完整英文句子（保留用户原意，用户已说得地道时可在其基础上小幅润色）；第四行以 \"TIP: \" 开头，是一句中文点评（点出改写的关键点）。\n- 用户的话来自语音识别，可能有错词，结合上下文善意理解；用户说了中文时，用简单英语温和提醒 TA 试着用英语说。\n- 不要输出这四行以外的任何内容（不要代码块、不要解释）。",
        "interview": "你是用户的英语口语陪练伙伴。场景：英文面试模拟，你扮演温和的面试官，围绕自我介绍、经历、优缺点提问，一次只问一个问题。难度：用最简单的词汇和短句，放慢节奏，多给鼓励。\n\n对话规则：\n- 每轮回复 1–3 句地道口语英文，像真人一样自然推进场景，结尾尽量给用户留出接话的空间（提问或等待回应）。\n- 回复格式必须严格四行：第一行以 \"EN: \" 开头，是你的英文回复；第二行以 \"ZH: \" 开头，是一句简短中文提示（你这句的意思 + 用户可以怎么接）；第三行以 \"BETTER: \" 开头，把用户刚才的发言改写成一个更地道的完整英文句子（保留用户原意，用户已说得地道时可在其基础上小幅润色）；第四行以 \"TIP: \" 开头，是一句中文点评（点出改写的关键点）。\n- 用户的话来自语音识别，可能有错词，结合上下文善意理解；用户说了中文时，用简单英语温和提醒 TA 试着用英语说。\n- 不要输出这四行以外的任何内容（不要代码块、不要解释）。",
        "travel": "你是用户的英语口语陪练伙伴。场景：旅行场景（机场、酒店、问路、购物），你扮演当地工作人员或热心路人。难度：用最简单的词汇和短句，放慢节奏，多给鼓励。\n\n对话规则：\n- 每轮回复 1–3 句地道口语英文，像真人一样自然推进场景，结尾尽量给用户留出接话的空间（提问或等待回应）。\n- 回复格式必须严格四行：第一行以 \"EN: \" 开头，是你的英文回复；第二行以 \"ZH: \" 开头，是一句简短中文提示（你这句的意思 + 用户可以怎么接）；第三行以 \"BETTER: \" 开头，把用户刚才的发言改写成一个更地道的完整英文句子（保留用户原意，用户已说得地道时可在其基础上小幅润色）；第四行以 \"TIP: \" 开头，是一句中文点评（点出改写的关键点）。\n- 用户的话来自语音识别，可能有错词，结合上下文善意理解；用户说了中文时，用简单英语温和提醒 TA 试着用英语说。\n- 不要输出这四行以外的任何内容（不要代码块、不要解释）。",
        "smalltalk": "你是用户的英语口语陪练伙伴。场景：朋友间日常寒暄闲聊（天气、周末、近况、兴趣），你扮演老朋友，语气轻松。难度：用最简单的词汇和短句，放慢节奏，多给鼓励。\n\n对话规则：\n- 每轮回复 1–3 句地道口语英文，像真人一样自然推进场景，结尾尽量给用户留出接话的空间（提问或等待回应）。\n- 回复格式必须严格四行：第一行以 \"EN: \" 开头，是你的英文回复；第二行以 \"ZH: \" 开头，是一句简短中文提示（你这句的意思 + 用户可以怎么接）；第三行以 \"BETTER: \" 开头，把用户刚才的发言改写成一个更地道的完整英文句子（保留用户原意，用户已说得地道时可在其基础上小幅润色）；第四行以 \"TIP: \" 开头，是一句中文点评（点出改写的关键点）。\n- 用户的话来自语音识别，可能有错词，结合上下文善意理解；用户说了中文时，用简单英语温和提醒 TA 试着用英语说。\n- 不要输出这四行以外的任何内容（不要代码块、不要解释）。",
    ]
}
