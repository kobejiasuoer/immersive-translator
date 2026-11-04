import XCTest
import ReaderCore
@testable import ImmersiveTranslator

/// 场景编辑器状态机（SpeakScenarioEditorModel）单测，对齐 Windows
/// src/reader/SpeakScenarioEditor.test.tsx 12 例的可下沉部分：手填保存全链路（dirty 实体＋
/// 立即注册＋刷新＋via:manual）；必填校验不落库不关弹窗；保存失败表单保留；生成成功（围栏）
/// 预填可编辑 via:generate 且埋点先 result 后 create；解析失败保留原话回 input；接口失败原话
/// 保留 {ok:false}（无 parseError 键）；取消半截 JSON 不进表单；Esc 生成中取消不关弹窗；
/// 半改表单→返回→再失败→手填入口半改值仍在；usedGenerate 复位；编辑保存 id 不变 baseVersion
/// 读回整桶合并不清其它不发 create；读回失败中止保存。
@MainActor
final class SpeakScenarioEditorLogicTests: XCTestCase {
    private struct TestError: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private final class Probe {
        var events: [TelemetryEvent] = []
        var toasts: [String] = []
        var puts: [[StoredSyncEntity]] = []
        var listCalls = 0
        var savedCalls = 0
        var closeCalls = 0
    }

    private actor Gate {
        private var waiters: [CheckedContinuation<String, Error>] = []
        func wait() async throws -> String {
            try await withCheckedThrowingContinuation { waiters.append($0) }
        }
        func open(_ value: String) {
            let all = waiters
            waiters = []
            all.forEach { $0.resume(returning: value) }
        }
        var waiting: Int { waiters.count }
    }

    override func setUp() {
        super.setUp()
        registerUserScenarios([])
        registerOfficialScenarios([])
    }

    private func userScenario(_ id: String, keyPhrases: [String]? = nil, emoji: String? = nil) -> SpeakScenario {
        SpeakScenario(
            id: id, source: .user, title: "t-\(id)", emoji: emoji, category: .custom,
            aiRole: "role-\(id)", keyPhrases: keyPhrases, opener: "opener-\(id)", updatedAt: 1_000
        )
    }

    private func makeModel(
        initial: SpeakScenario? = nil,
        generate: @escaping (String, String) async throws -> String = { _, _ in "" },
        list: @escaping () throws -> [StoredSyncEntity] = { [] },
        putError: Error? = nil,
        now: Int64 = 2_000
    ) -> (SpeakScenarioEditorModel, Probe) {
        let probe = Probe()
        let model = SpeakScenarioEditorModel(
            initial: initial,
            dependencies: .init(
                generate: generate,
                syncStoreList: { probe.listCalls += 1; return try list() },
                syncStorePut: { entities in
                    if let putError { throw putError }
                    probe.puts.append(entities)
                },
                track: { probe.events.append($0) },
                toast: { probe.toasts.append($0) },
                now: { now }
            ),
            onSaved: { probe.savedCalls += 1 },
            onClose: { probe.closeCalls += 1 }
        )
        return (model, probe)
    }

    private func names(_ probe: Probe) -> [String] { probe.events.map(\.name) }

    private func event(_ probe: Probe, _ name: String) -> [TelemetryEvent] { probe.events.filter { $0.name == name } }

    private let cleanJSON = """
    {"title":"合同续约谈判","category":"workplace","aiRole":"你扮演德国客户的采购经理","userRole":"中方销售","goal":"守住价格","keyPhrases":["close the deal","meet halfway"],"opener":"Good morning! Shall we start with the pricing?","openerZh":"早上好，先谈价格？"}
    """

    // MARK: - 手填保存全链路

    func testManualSaveWritesDirtyEntityRegistersAndTracksManual() async throws {
        let (model, probe) = makeModel(now: 5_000)
        XCTAssertEqual(model.phase, .input)
        model.skipToManual()
        XCTAssertEqual(model.phase, .form)

        model.form.title = "面试冲刺"
        model.form.aiRole = "你扮演温和的面试官"
        model.form.opener = "Hi, shall we begin?"
        await model.save()

        // 新建路径不读 store（baseVersion 恒 0）
        XCTAssertEqual(probe.listCalls, 0)
        XCTAssertEqual(probe.puts.count, 1)
        let e = try XCTUnwrap(probe.puts.first?.first)
        XCTAssertNotNil(e.id.range(of: #"^usr_[0-9a-f-]{36}$"#, options: .regularExpression), e.id)
        XCTAssertEqual(e.baseVersion, 0)
        XCTAssertTrue(e.dirty)
        XCTAssertFalse(e.deleted)
        XCTAssertEqual(e.schemaVersion, 1)
        XCTAssertEqual(e.originDevice, "mac")
        XCTAssertEqual(e.updatedAt, 5_000)
        let payload = try XCTUnwrap(e.payload as? [String: Any])
        XCTAssertEqual(payload["source"] as? String, "user")
        XCTAssertEqual(payload["title"] as? String, "面试冲刺")
        XCTAssertEqual(payload["aiRole"] as? String, "你扮演温和的面试官")
        XCTAssertEqual(payload["opener"] as? String, "Hi, shall we begin?")
        XCTAssertEqual((payload["updatedAt"] as? NSNumber)?.int64Value, 5_000)
        XCTAssertEqual(payload["category"] as? String, "custom")
        // 可选字段空值不落库
        XCTAssertNil(payload["userRole"])
        XCTAssertNil(payload["keyPhrases"])
        XCTAssertNil(payload["goal"])
        XCTAssertNil(payload["openerZh"])
        XCTAssertEqual(Set(payload.keys), ["id", "source", "title", "category", "aiRole", "opener", "updatedAt"])

        // 注册表立即生效（保存后「我的场景」分组可见、会话可用的根）
        XCTAssertTrue(listUserScenarios().map(\.id).contains(e.id))
        XCTAssertEqual(scenarioOf(e.id).title, "面试冲刺")
        XCTAssertEqual(probe.savedCalls, 1)
        XCTAssertEqual(probe.closeCalls, 1)
        XCTAssertEqual(probe.toasts, ["场景已保存"])
        XCTAssertEqual(event(probe, "scenario_create").first?.props, ["via": .string("manual")])
        XCTAssertFalse(model.saving)
    }

    func testSaveRequiresTitleRoleOpener() async {
        let (model, probe) = makeModel()
        model.skipToManual()
        model.form.aiRole = "r"
        model.form.opener = "o"
        await model.save()
        XCTAssertEqual(model.saveError, "请填写：场景名")
        XCTAssertTrue(probe.puts.isEmpty)
        XCTAssertEqual(probe.closeCalls, 0)
        XCTAssertEqual(model.phase, .form)

        model.form.aiRole = "   "
        model.form.opener = ""
        await model.save()
        XCTAssertEqual(model.saveError, "请填写：场景名、AI 角色设定、英文开场白")
        XCTAssertTrue(probe.puts.isEmpty)
        XCTAssertTrue(probe.events.isEmpty)
    }

    func testSaveFailureKeepsFormAndStaysOpen() async {
        let (model, probe) = makeModel(putError: TestError(message: "disk full"))
        model.skipToManual()
        model.form.title = "T"
        model.form.aiRole = "R"
        model.form.opener = "O"
        model.form.keyPhrases = ["close the deal"]
        await model.save()
        XCTAssertEqual(model.saveError, "保存失败：disk full")
        XCTAssertEqual(model.form.title, "T")
        XCTAssertEqual(model.form.keyPhrases, ["close the deal"])
        XCTAssertEqual(probe.closeCalls, 0)
        XCTAssertEqual(probe.savedCalls, 0)
        XCTAssertFalse(model.saving)
        XCTAssertTrue(listUserScenarios().isEmpty, "落库失败不进注册表")
        XCTAssertTrue(event(probe, "scenario_create").isEmpty)
    }

    func testSaveClampsAndTrimsPerContract() async throws {
        let (model, probe) = makeModel()
        model.skipToManual()
        model.form.title = "  T  "
        model.form.aiRole = String(repeating: "a", count: 400)
        model.form.userRole = String(repeating: "u", count: 250)
        model.form.goal = String(repeating: "g", count: 250)
        model.form.opener = " O "
        model.form.openerZh = " 中文 "
        model.form.keyPhrases = ["", " p1 ", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"]
        await model.save()
        let payload = try XCTUnwrap(probe.puts.first?.first?.payload as? [String: Any])
        XCTAssertEqual(payload["title"] as? String, "T")
        XCTAssertEqual((payload["aiRole"] as? String)?.count, 300)
        XCTAssertEqual((payload["userRole"] as? String)?.count, 200)
        XCTAssertEqual((payload["goal"] as? String)?.count, 200)
        XCTAssertEqual(payload["opener"] as? String, "O")
        XCTAssertEqual(payload["openerZh"] as? String, "中文")
        XCTAssertEqual(payload["keyPhrases"] as? [String], ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"])
    }

    // MARK: - 一句话生成

    func testGenerateSuccessWithFencePrefillsFormAndTracksOrder() async throws {
        let (model, probe) = makeModel(generate: { system, input in
            XCTAssertEqual(system, buildScenarioGenSystemPrompt())
            XCTAssertEqual(input, buildScenarioGenUserInput("下周要跟德国客户谈合同续约"))
            return "```json\n\(self.cleanJSON)\n```"
        })
        model.idea = "下周要跟德国客户谈合同续约"
        await model.generate()

        XCTAssertEqual(model.phase, .form)
        XCTAssertTrue(model.usedGenerate)
        XCTAssertEqual(model.form.title, "合同续约谈判")
        XCTAssertEqual(model.form.category, .workplace)
        XCTAssertEqual(model.form.keyPhrases, ["close the deal", "meet halfway"])
        XCTAssertEqual(model.form.openerZh, "早上好，先谈价格？")
        XCTAssertEqual(model.idea, "下周要跟德国客户谈合同续约", "原话保留")
        // 预填可编辑
        model.form.title = "合同续约谈判（改）"
        await model.save()
        let payload = try XCTUnwrap(probe.puts.first?.first?.payload as? [String: Any])
        XCTAssertEqual(payload["title"] as? String, "合同续约谈判（改）")
        XCTAssertEqual(payload["keyPhrases"] as? [String], ["close the deal", "meet halfway"])
        XCTAssertEqual(names(probe), ["scenario_generate_result", "scenario_create"])
        XCTAssertEqual(probe.events[0].props, ["ok": .bool(true)])
        XCTAssertEqual(probe.events[1].props, ["via": .string("generate")])
    }

    func testGenerateParseFailureKeepsIdeaAndReportsParseError() async {
        let (model, probe) = makeModel(generate: { _, _ in "Sure! Tell me more about what you want to practice." })
        model.idea = "原话"
        model.form.title = "半填"
        await model.generate()
        XCTAssertEqual(model.phase, .input)
        XCTAssertEqual(model.idea, "原话")
        XCTAssertEqual(model.form.title, "半填", "解析失败不碰表单")
        XCTAssertEqual(model.genError, "生成结果格式异常（未能解析出场景卡），请重试或改用手动填写")
        XCTAssertEqual(probe.events.map(\.name), ["scenario_generate_result"])
        XCTAssertEqual(probe.events[0].props, ["ok": .bool(false), "parseError": .string("no_json")])
        XCTAssertFalse(model.usedGenerate)
    }

    func testGenerateParseErrorTextsVerbatim() async {
        let cases: [(String, String, String)] = [
            ("", "生成结果为空，请重试", "empty"),
            ("{\"aiRole\":\"r\",\"opener\":\"o\"}", "生成结果缺少必要字段（场景名/角色设定/开场白），请重试或改用手动填写", "missing_required"),
            ("{\"title\":\"x\",\"nested\":{\"a\":1}", "生成结果格式异常（未能解析出场景卡），请重试或改用手动填写", "bad_json"),
        ]
        for (raw, text, code) in cases {
            let (model, probe) = makeModel(generate: { _, _ in raw })
            model.idea = "i"
            await model.generate()
            XCTAssertEqual(model.genError, text)
            XCTAssertEqual(probe.events.last?.props["parseError"], .string(code))
        }
    }

    func testGenerateApiFailureKeepsIdeaTracksOkFalseWithoutParseError() async {
        let (model, probe) = makeModel(generate: { _, _ in throw TestError(message: "服务不可用") })
        model.idea = "原话"
        await model.generate()
        XCTAssertEqual(model.phase, .input)
        XCTAssertEqual(model.idea, "原话")
        XCTAssertEqual(model.genError, "生成失败：服务不可用")
        XCTAssertEqual(probe.events.map(\.name), ["scenario_generate_result"])
        XCTAssertEqual(probe.events[0].props, ["ok": .bool(false)])
        XCTAssertNil(probe.events[0].props["parseError"])
    }

    func testGenerateCancelledHalfJSONNeverEntersForm() async {
        let gate = Gate()
        let (model, probe) = makeModel(generate: { _, _ in try await gate.wait() })
        model.idea = "原话"
        model.form.title = "原表单"
        let generation = Task { await model.generate() }
        var polls = 0
        while await gate.waiting == 0, polls < 200 {
            polls += 1
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertEqual(model.phase, .generating)
        model.cancelGenerate()
        // 半截累计文本（合法 JSON 前缀）回来：绝不当成功解析
        await gate.open("{\"title\":\"半截\",\"aiRole\":\"r\",\"opener\":\"o\"}")
        await generation.value
        XCTAssertEqual(model.phase, .input)
        XCTAssertEqual(model.genError, "已取消，可重试或手动填写")
        XCTAssertEqual(model.idea, "原话")
        XCTAssertEqual(model.form.title, "原表单")
        XCTAssertEqual(probe.events.map(\.name), ["scenario_generate_result"])
        XCTAssertEqual(probe.events[0].props, ["ok": .bool(false)])
        XCTAssertEqual(probe.closeCalls, 0)
    }

    func testEscapeDuringGeneratingCancelsWithoutClosing() async {
        let gate = Gate()
        let (model, probe) = makeModel(generate: { _, _ in try await gate.wait() })
        model.idea = "原话"
        let generation = Task { await model.generate() }
        var polls = 0
        while await gate.waiting == 0, polls < 200 {
            polls += 1
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        model.handleEscape()
        XCTAssertEqual(probe.closeCalls, 0, "生成中 Esc 当取消用，不关弹窗")
        await gate.open("whatever")
        await generation.value
        XCTAssertEqual(model.phase, .input)
        XCTAssertEqual(model.genError, "已取消，可重试或手动填写")
        // 非生成态 Esc → 关闭
        model.handleEscape()
        XCTAssertEqual(probe.closeCalls, 1)
    }

    // MARK: - 失败路径的表单保留（写入白名单）

    func testHalfEditedFormSurvivesBackAndFailedRegenerate() async {
        var attempt = 0
        let (model, _) = makeModel(generate: { _, _ in
            attempt += 1
            return attempt == 1 ? self.cleanJSON : "no json here"
        })
        model.idea = "i"
        await model.generate()
        XCTAssertEqual(model.phase, .form)
        model.form.title = "半改"
        model.form.keyPhrases.append("extra phrase")
        model.backToInput()
        XCTAssertEqual(model.phase, .input)
        XCTAssertEqual(model.idea, "i")
        await model.generate()
        XCTAssertEqual(model.phase, .input)
        XCTAssertFalse(model.genError.isEmpty)
        model.skipToManual()
        XCTAssertEqual(model.form.title, "半改", "半改值未被任何路径清空")
        XCTAssertEqual(model.form.keyPhrases, ["close the deal", "meet halfway", "extra phrase"])
    }

    func testUsedGenerateResetsOnManualEntry() async throws {
        let (model, probe) = makeModel(generate: { _, _ in self.cleanJSON })
        model.idea = "i"
        await model.generate()
        XCTAssertTrue(model.usedGenerate)
        model.backToInput()
        model.skipToManual()
        XCTAssertFalse(model.usedGenerate)
        await model.save()
        XCTAssertEqual(event(probe, "scenario_create").first?.props, ["via": .string("manual")])
    }

    // MARK: - 编辑既有用户场景

    func testEditSaveKeepsIdReadsBaseVersionMergesBucketNoCreate() async throws {
        let a = userScenario("usr_A", keyPhrases: ["close the deal"], emoji: "🤝")
        let b = userScenario("usr_B")
        registerUserScenarios([a, b])
        let (model, probe) = makeModel(
            initial: a,
            list: {
                [StoredSyncEntity(
                    id: "usr_A", baseVersion: 7, updatedAt: 1_000, deleted: false, schemaVersion: 1,
                    originDevice: "windows", payload: a.jsonObject(), dirty: false
                )]
            },
            now: 9_000
        )
        XCTAssertEqual(model.phase, .form)
        XCTAssertEqual(model.form.title, a.title, "initial 预填")
        XCTAssertEqual(model.form.keyPhrases, ["close the deal"])
        XCTAssertEqual(model.dialogTitle, "编辑场景")

        model.form.title = "场景A改"
        await model.save()

        XCTAssertEqual(probe.listCalls, 1)
        XCTAssertEqual(probe.puts.count, 1)
        let e = try XCTUnwrap(probe.puts.first?.first)
        XCTAssertEqual(e.id, "usr_A")
        XCTAssertEqual(e.baseVersion, 7)
        XCTAssertTrue(e.dirty)
        let payload = try XCTUnwrap(e.payload as? [String: Any])
        XCTAssertEqual(payload["title"] as? String, "场景A改")
        XCTAssertEqual((payload["updatedAt"] as? NSNumber)?.int64Value, 9_000)
        XCTAssertEqual(payload["emoji"] as? String, "🤝", "规格外字段原样保留")
        XCTAssertEqual(payload["keyPhrases"] as? [String], ["close the deal"])

        // 整桶合并：B 未被清掉、A 已更新
        let registered = listUserScenarios()
        XCTAssertEqual(registered.map(\.id).sorted(), ["usr_A", "usr_B"])
        XCTAssertEqual(registered.first { $0.id == "usr_A" }?.title, "场景A改")
        XCTAssertEqual(probe.savedCalls, 1)
        XCTAssertEqual(probe.closeCalls, 1)
        XCTAssertEqual(probe.toasts, ["场景已更新"])
        XCTAssertTrue(event(probe, "scenario_create").isEmpty, "编辑保存不发 scenario_create")
    }

    func testEditReadBackFailureAbortsSave() async {
        let a = userScenario("usr_A")
        let (model, probe) = makeModel(initial: a, list: { throw TestError(message: "ipc down") })
        await model.save()
        XCTAssertTrue(probe.puts.isEmpty, "不静默落 baseVersion 0")
        XCTAssertEqual(model.saveError, "读取本地同步数据失败：ipc down，请重试")
        XCTAssertEqual(model.form.title, a.title)
        XCTAssertEqual(probe.closeCalls, 0)
        XCTAssertFalse(model.saving)
    }

    // MARK: - 目标短语动态行 / 一句话上限

    func testPhraseRowsCapAtEight() {
        let (model, _) = makeModel()
        model.skipToManual()
        for _ in 0..<10 { model.addPhrase() }
        XCTAssertEqual(model.form.keyPhrases.count, 8)
        XCTAssertFalse(model.canAddPhrase)
        model.setPhrase(0, "close the deal")
        model.removePhrase(7)
        XCTAssertEqual(model.form.keyPhrases.count, 7)
        XCTAssertEqual(model.form.keyPhrases[0], "close the deal")
        XCTAssertTrue(model.canAddPhrase)
    }

    func testIdeaClampedTo200AndCanGenerate() {
        let (model, _) = makeModel()
        XCTAssertFalse(model.canGenerate)
        model.idea = "   "
        XCTAssertFalse(model.canGenerate)
        model.idea = String(repeating: "想", count: 250)
        model.clampIdea()
        XCTAssertEqual(model.idea.utf16.count, 200)
        XCTAssertTrue(model.canGenerate)
        XCTAssertEqual(SpeakScenarioEditorModel.maxIdeaLength, 200)
    }

    func testDialogSubtitlesVerbatim() async {
        let (model, _) = makeModel(generate: { _, _ in "" })
        XCTAssertEqual(model.dialogTitle, "新建场景")
        XCTAssertEqual(model.dialogSubtitle, "用一句话描述你想练的场景，AI 帮你生成场景卡；也可以跳过直接手动填写")
        model.skipToManual()
        XCTAssertEqual(model.dialogSubtitle, "生成结果可以再修改；标 * 的字段必填")
    }
}
