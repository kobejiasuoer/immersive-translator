import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 语音偏好存储与迁移推断单测（对齐 Windows settingsStore.voicePrefs.test.ts
// 行为向量的 Mac 落点）：
// - 迁移推断：任一凭据槽位存在→xfyun（ASR-only 也算）；全空→gateway；
//   已存值优先（不探测凭据）；推断值只展示不落盘。
// - 即时保存：点卡即写盘、立即可读回；三键独立不触碰其余设置。
// - 不点亮保存条：SettingsSaveSnapshot 不含三字段（stripVoicePrefs 语义）。
// Mac 差异：三字段是独立 UserDefaults 键（非 Windows 的单 JSON 合并），「只合并
// 三字段、不带出明文 apiKey」由键隔离天然保证；「无效 JSON 抛错不写盘」无对应
// 形态（无 JSON blob）。
// ---------------------------------------------------------------------------

final class VoicePrefsTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName = ""

    override func setUp() {
        super.setUp()
        suiteName = "voice-prefs-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: 迁移推断（inferVoiceProvider 纯函数）

    func testInferAnyCredentialSlotGivesXfyun() {
        XCTAssertEqual(inferVoiceProvider(.init(iseMain: true, ttsOwn: false, asrOwn: false)), .xfyun)
        XCTAssertEqual(inferVoiceProvider(.init(iseMain: false, ttsOwn: true, asrOwn: false)), .xfyun)
        XCTAssertEqual(inferVoiceProvider(.init(iseMain: false, ttsOwn: false, asrOwn: true)), .xfyun, "ASR-only 也算（高级覆盖用户）")
    }

    func testInferEmptyGivesGateway() {
        XCTAssertEqual(inferVoiceProvider(.none), .gateway)
    }

    // MARK: 生效服务商：已存值优先；未存按凭据推断

    func testStoredProviderWinsWithoutProbe() {
        XCTAssertEqual(resolveInitialVoiceProvider(stored: .gateway, presence: .init(iseMain: true, ttsOwn: true, asrOwn: true)), .gateway)
        XCTAssertEqual(resolveInitialVoiceProvider(stored: .xfyun, presence: .none), .xfyun)
        // 非法已存值按未存处理（走推断）。
        XCTAssertEqual(resolveInitialVoiceProvider(stored: nil, presence: .none), .gateway)
    }

    func testUnstoredInfersFromPresence() {
        XCTAssertEqual(resolveInitialVoiceProvider(stored: nil, presence: .init(iseMain: true, ttsOwn: false, asrOwn: false)), .xfyun)
        XCTAssertEqual(resolveInitialVoiceProvider(stored: nil, presence: .none), .gateway)
    }

    func testStoredProviderDoesNotProbeCredentials() {
        // 对齐 Windows「已存 gateway / xfyun 时直接采用，不探测凭据」。
        var probes = 0
        func probe() -> XfyunCredentialPresenceSnapshot {
            probes += 1
            return .init(iseMain: true, ttsOwn: false, asrOwn: false)
        }
        XCTAssertEqual(resolveInitialVoiceProvider(stored: .gateway, presence: probe()), .gateway)
        XCTAssertEqual(resolveInitialVoiceProvider(stored: .xfyun, presence: probe()), .xfyun)
        XCTAssertEqual(probes, 0, "已存值不探测")
        XCTAssertEqual(resolveInitialVoiceProvider(stored: nil, presence: probe()), .xfyun)
        XCTAssertEqual(probes, 1, "未存过才探测")
    }

    // MARK: 即时保存：写盘立即可读回；三键互不触碰

    func testImmediatePersistRoundTrip() {
        XCTAssertNil(VoicePrefsStore.loadProvider(defaults: defaults))
        VoicePrefsStore.saveProvider(.gateway, defaults: defaults)
        XCTAssertEqual(VoicePrefsStore.loadProvider(defaults: defaults), .gateway)
        VoicePrefsStore.saveProvider(.xfyun, defaults: defaults)
        XCTAssertEqual(VoicePrefsStore.loadProvider(defaults: defaults), .xfyun)

        XCTAssertNil(VoicePrefsStore.loadGatewayVoice(defaults: defaults))
        VoicePrefsStore.saveGatewayVoice("v2", defaults: defaults)
        XCTAssertEqual(VoicePrefsStore.loadGatewayVoice(defaults: defaults), "v2")
        // 空串音色按未存处理（用服务端默认音色）。
        VoicePrefsStore.saveGatewayVoice("", defaults: defaults)
        XCTAssertNil(VoicePrefsStore.loadGatewayVoice(defaults: defaults))

        // 缺省 true；显式 false 可存可读；从未写入时 true。
        XCTAssertEqual(VoicePrefsStore.loadIseEnabled(defaults: defaults), true)
        VoicePrefsStore.saveIseEnabled(false, defaults: defaults)
        XCTAssertEqual(VoicePrefsStore.loadIseEnabled(defaults: defaults), false)
        // 换音色不触碰 provider / ise 开关（键独立）。
        XCTAssertEqual(VoicePrefsStore.loadProvider(defaults: defaults), .xfyun)
    }

    func testInvalidStoredProviderValueTreatedAsUnstored() {
        defaults.set("telepathy", forKey: VoicePrefsStore.providerKey)
        XCTAssertNil(VoicePrefsStore.loadProvider(defaults: defaults))
    }

    // MARK: 登录成功瞬间自动切云（对齐 Windows Settings.tsx:176-185）

    @MainActor
    func testLoginAutoSwitchWritesGatewayAndBumpsNoticeOnce() {
        _ = KeychainStore.deleteAllProviderAPIKeySlots()
        let saved = UserDefaults.standard.string(forKey: VoicePrefsStore.providerKey)
        defer {
            if let saved {
                UserDefaults.standard.set(saved, forKey: VoicePrefsStore.providerKey)
            } else {
                UserDefaults.standard.removeObject(forKey: VoicePrefsStore.providerKey)
            }
        }
        let store = SettingsStore()
        store.voiceProvider = .xfyun
        let before = store.voiceAutoSwitchNoticeSerial
        let snapshot = SettingsSaveSnapshot.capture(from: store)
        // 停在讯飞 → 切 gateway 即时落盘 + 轻提示序号递增（讯飞凭据不动）。
        XCTAssertTrue(store.applyLoginVoiceAutoSwitch())
        XCTAssertEqual(store.voiceProvider, .gateway)
        XCTAssertEqual(VoicePrefsStore.loadProvider(), .gateway)
        XCTAssertEqual(store.voiceAutoSwitchNoticeSerial, before + 1)
        XCTAssertEqual(SettingsSaveSnapshot.capture(from: store), snapshot, "自动切云不点亮保存条")
        // 已是 gateway：无感（不再提示）。
        XCTAssertFalse(store.applyLoginVoiceAutoSwitch())
        XCTAssertEqual(store.voiceAutoSwitchNoticeSerial, before + 1)
        // 从未存过（nil）也按「≠ gateway」切换并提示（Windows settings.voiceProvider !== "gateway"）。
        UserDefaults.standard.removeObject(forKey: VoicePrefsStore.providerKey)
        store.voiceProvider = nil
        XCTAssertTrue(store.applyLoginVoiceAutoSwitch())
        XCTAssertEqual(VoicePrefsStore.loadProvider(), .gateway)
        XCTAssertEqual(store.voiceAutoSwitchNoticeSerial, before + 2)
    }

    // MARK: 不点亮保存条（快照不含三字段，对齐 stripVoicePrefs）

    @MainActor
    func testSnapshotExcludesVoicePrefsFields() {
        _ = KeychainStore.deleteAllProviderAPIKeySlots()
        let store = SettingsStore()
        store.voiceProvider = nil
        store.voiceGatewayVoice = nil
        store.voiceGatewayIseEnabled = true
        let before = SettingsSaveSnapshot.capture(from: store)
        // 改三个语音偏好字段：快照不变（不脏 → 不触发自动保存确认）。
        store.voiceProvider = .gateway
        store.voiceGatewayVoice = "v1"
        store.voiceGatewayIseEnabled = false
        let after = SettingsSaveSnapshot.capture(from: store)
        XCTAssertEqual(before, after, "语音偏好是即时保存字段，不进保存条 dirty 比较")
        // 写盘语义：store 赋值即落 UserDefaults（立即可读回）。
        XCTAssertEqual(VoicePrefsStore.loadProvider(), .gateway)
        XCTAssertEqual(VoicePrefsStore.loadGatewayVoice(), "v1")
        XCTAssertEqual(VoicePrefsStore.loadIseEnabled(), false)
        // 还原现场（不污染其它用例）。
        UserDefaults.standard.removeObject(forKey: VoicePrefsStore.providerKey)
        UserDefaults.standard.removeObject(forKey: VoicePrefsStore.gatewayVoiceKey)
        UserDefaults.standard.removeObject(forKey: VoicePrefsStore.gatewayIseEnabledKey)
    }
}
