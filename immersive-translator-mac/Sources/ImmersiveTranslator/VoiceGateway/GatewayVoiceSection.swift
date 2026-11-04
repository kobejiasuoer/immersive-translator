import SwiftUI

// ---------------------------------------------------------------------------
// 语音页右列 · 沉浸云模式（对齐 Windows src/views/GatewayVoiceSection.tsx，
// 契约 §三.6/§三.7/§三.8；文案逐字复刻，控件按 Mac 既有 SwiftUI 风格——规格 §四差异 10）。
//
// - 账号卡：未登录给登录入口（onLogin 由父级处理），已登录回显邮箱 +
//   「管理账号」（切账号分区）；令牌由客户端自动携带续期，无任何凭据配置。
// - 能力卡：状态机归约结果（reduceVoiceGatewayView）渲染
//   读取中 / 未开通 / 部分可用 / 额度用尽 / 全部可用；网络失败与封禁是独立整卡。
// - 本月额度：me/config 下发 quota 字段 → 常驻余量明细；未下发 → 平时只给说明，
//   收到 quota_exceeded（402/WSS 事件经 onQuotaEvent 上抛）后切换「额度用尽」+ 兑换入口。
// - 一键测试：三行灯（跟读打分 / 云端朗读 / 口语识别）+ 汇总条，行内可单独重测。
//   跟读打分用打包的真实英文样本打 ISE（耗 1 次评分额度，§三.9）；朗读短句合成
//   不播放；识别用同一样本转写（耗少量秒数）。均经 VoiceGateway 消费口，不碰帧协议。
// ---------------------------------------------------------------------------

/// 一键测试样本的固定英文句（assets/voice/README.md：样本内容的唯一真源）。
let gatewaySampleRefText = "The quick brown fox jumps over the lazy dog."
/// 朗读通道探测用的极短句（正常计字符额度，量级可忽略）。
let gatewayTtsProbeText = "Hello."

/// 申诉入口：两个仓库均未定义申诉页/客服渠道（Windows 同款 null 占位），
/// 上线前由运维回填；为 nil 时按钮置灰占位（契约 §三.6 封禁态要求该按钮存在）。
let gatewayAppealURL: String? = nil

/// 测试样本 base64（懒加载 + 缓存；样本是打包的合成音频，无隐私、可复用）。
/// 从产品侧暴露（Bundle.module 在测试 target 里指向测试包，拿不到资源）。
enum GatewayIseSample {
    static var cached: String?

    static func assetURL() -> URL? {
        // SwiftPM .process 会把 Resources/voice/ 下资源平铺进 bundle 根，
        // 两个位置都探测（子目录优先，防 SPM 行为变化）。
        return Bundle.module.url(forResource: "ise-test-sample", withExtension: "pcm", subdirectory: "voice")
            ?? Bundle.module.url(forResource: "ise-test-sample", withExtension: "pcm")
    }

    static func assetData() throws -> Data {
        guard let url = assetURL(), let data = try? Data(contentsOf: url) else {
            throw VoiceError(code: "unknown", message: "测试样本加载失败")
        }
        return data
    }

    static func loadBase64() throws -> String {
        if let cached { return cached }
        let base64 = bytesToBase64(try assetData())
        cached = base64
        return base64
    }

    static func resetCacheForTests() {
        cached = nil
    }
}

/// 测试失败的展示文案：VoiceError 走 §二映射表，其余（网络/未接线）落通用兜底。
private func testErrorText(_ error: Error) -> String {
    let info = voiceErrorMessage(error as? VoiceErrorLike ?? VoiceError(code: "unknown"))
    return info.text.isEmpty ? "服务暂时不可用，请稍后再试" : info.text
}

/// JS `Number.prototype.toFixed(1)` 同口径（一键测试「总分 4.3」「约 1.7 秒」文案）：
/// 与 printf 只在二进制精确的 .x5 平局上不同——JS 取较大的 n（4.25 → "4.3"），
/// printf 按偶数舍入（4.25 → "4.2"）。精确平局 ⇔ x×4 为奇整数（分母只能是 4）。
func jsToFixed1(_ value: Double) -> String {
    guard value.isFinite else { return String(value) }
    if value < 0 {
        let positive = jsToFixed1(-value)
        return positive == "0.0" ? "-0.0" : "-\(positive)"
    }
    let quadrupled = value * 4
    if quadrupled.rounded() == quadrupled, quadrupled.truncatingRemainder(dividingBy: 2) == 1 {
        return String(format: "%.1f", (value * 10).rounded(.up) / 10)
    }
    return String(format: "%.1f", value)
}

/// asrLanguages 成员 → 展示名（服务端契约只有 en_us/zh_cn，其余透传）。
func asrLanguageLabel(_ lang: String) -> String {
    if lang == "en_us" { return "英语" }
    if lang == "zh_cn" { return "中文" }
    return lang
}

/// 状态灯（对齐 Windows LightState idle|testing|ok|bad）。
struct GatewayTestLight: Equatable {
    enum State { case idle, testing, ok, bad }
    var state: State
    var message: String

    static let idle = GatewayTestLight(state: .idle, message: "")
}

/// 三资源恒为同一月末周期（单一月度周期），取任一非空 resetsAt 即可。
private func firstResetsAt(_ quota: VoiceQuotaMap?) -> String? {
    guard let quota else { return nil }
    for key in allVoiceCapabilities {
        if let entry = quota[key], entry.resetsAt != nil {
            return entry.resetsAt
        }
    }
    return nil
}

struct GatewayVoiceSection: View {
    let email: String
    let loggedIn: Bool
    /// 登录窗口已点开、还在打开中（按钮禁用态）。
    let openingLogin: Bool
    let caps: VoiceCapabilities?
    let view: VoiceGatewayView
    let selectedVoice: String?
    let iseEnabled: Bool
    let onLogin: () -> Void
    let onManageAccount: () -> Void
    let onRetryCaps: () -> Void
    /// 「兑换更多额度」→ 账号分区兑换码卡（§三.10）。
    let onOpenRedeem: () -> Void
    let onSelectVoice: (String) -> Void
    let onToggleIse: (Bool) -> Void
    /// 测试中收到 quota_exceeded：上抛 resource（402 事件式兜底的来源之一）。
    let onQuotaEvent: (String) -> Void

    @State private var lights: [VoiceQuotaKey: GatewayTestLight] = [
        .ise: .idle, .tts: .idle, .asr: .idle,
    ]
    @State private var running = false

    private let testRows: [(key: VoiceQuotaKey, label: String, name: String)] = [
        (.ise, "跟读打分", "真实英文样本评测 · 消耗 1 次评分额度"),
        (.tts, "云端朗读", "短句合成探测 · 不播放声音"),
        (.asr, "口语识别", "样本转写探测 · 消耗少量识别秒数"),
    ]

    private var voices: [VoiceTtsVoice] { caps?.ttsVoices ?? [] }
    private var languages: [String] { caps?.asrLanguages ?? [] }
    private func missing(_ key: VoiceQuotaKey) -> Bool {
        view.missing.contains(key)
    }
    private var testsAllowed: Bool {
        view.caps == .full || view.caps == .partial
    }
    private var anyTesting: Bool {
        running || lights.values.contains { $0.state == .testing }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            accountCard

            if loggedIn, view.caps == .error {
                networkFailureCard
            }
            if loggedIn, view.caps == .banned {
                bannedCard
            }
            if loggedIn, view.caps != .error, view.caps != .banned {
                capabilityCard
            }
        }
    }

    // MARK: - 卡A 沉浸云账号（模型服务页同构）

    private var accountCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("账号")
                    .font(.system(size: 12.5, weight: .semibold))
                chip(loggedIn ? "已登录" : "未登录", ok: loggedIn)
                Spacer()
            }
            if !loggedIn {
                Text("登录后即可使用：无需申请任何密钥，朗读、识别、跟读打分三个服务共用一个账号，按账号额度计费。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    onLogin()
                } label: {
                    Label(openingLogin ? "正在打开登录窗口…" : "登录沉浸云", systemImage: "person.crop.circle")
                }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
                .disabled(openingLogin)
            } else {
                HStack(spacing: 6) {
                    Image(systemName: "person.crop.circle")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                    Text(email)
                        .font(.system(size: 12.5, weight: .medium))
                }
                Text("语音请求的令牌由客户端自动携带并自动续期，无需配置。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("管理账号", action: onManageAccount)
                    .controlSize(.small)
                    .buttonStyle(.bordered)
            }
        }
        .padding(12)
        .background(Color.secondary.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // MARK: - 网络失败（重试）/ 封禁（无重试）整卡

    private var networkFailureCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("语音能力")
                    .font(.system(size: 12.5, weight: .semibold))
                chip("获取失败", tone: .err)
                Spacer()
            }
            Text("账号登录状态不受影响；网络恢复后重新获取，回到沉浸云语音。")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            redBar("无法连接沉浸云，请检查网络或代理设置。") {
                Button("重试", action: onRetryCaps)
                    .controlSize(.small)
                    .buttonStyle(.bordered)
            }
        }
        .padding(12)
        .background(Color.secondary.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var bannedCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("语音能力")
                    .font(.system(size: 12.5, weight: .semibold))
                chip("已封禁", tone: .err)
                Spacer()
            }
            Text("封禁期间朗读、识别、跟读打分全部停用；申诉通过后自动恢复，无需重新配置。")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            redBar("账号已被封禁，如有疑问请前往申诉。") {
                Button("前往申诉") {
                    if let url = gatewayAppealURL, let link = URL(string: url) {
                        NSWorkspace.shared.open(link)
                    }
                }
                .controlSize(.small)
                .buttonStyle(.bordered)
                .disabled(gatewayAppealURL == nil)
                .help(gatewayAppealURL == nil ? "申诉渠道即将开放" : "")
            }
        }
        .padding(12)
        .background(Color.secondary.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // MARK: - 能力卡（读取中 / 未开通 / 部分可用 / 额度用尽 / 全部可用）

    private var capabilityCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            capabilityCardHead

            // 朗读音色
            fieldRow(label: "朗读音色", hint: "音色由沉浸云统一下发，管理台更新后下次启动生效。") {
                if view.caps == .loading {
                    chip("读取中…", tone: .info)
                } else if view.caps == .noneCase || missing(.tts) {
                    Picker("朗读音色", selection: .constant("暂无可用音色")) {
                        Text("暂无可用音色").tag("暂无可用音色")
                    }
                    .labelsHidden()
                    .frame(width: 252)
                    .disabled(true)
                } else {
                    // 选中值不在列表时回落第一个（服务端默认音色=列表第一项）。
                    let inList = voices.contains { $0.id == selectedVoice }
                    let current = inList ? (selectedVoice ?? "") : (voices.first?.id ?? "")
                    Picker("朗读音色", selection: Binding(
                        get: { current },
                        set: { onSelectVoice($0) }
                    )) {
                        ForEach(voices, id: \.id) { voice in
                            Text(voice.label).tag(voice.id)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 252)
                }
            }

            // 识别语种
            fieldRow(
                label: "识别语种",
                hint: missing(.asr)
                    ? "沉浸云识别暂未开放——录音直译、口语陪练入口不可用。"
                    : "语种由消费场景决定（领读、陪练为英语；录音直译按翻译方向），此处仅展示下发结果。"
            ) {
                if view.caps == .loading {
                    chip("读取中…", tone: .info)
                } else if view.caps == .noneCase || missing(.asr) {
                    chip("暂未开放", tone: .off)
                } else {
                    HStack(spacing: 6) {
                        ForEach(languages, id: \.self) { lang in
                            chip(asrLanguageLabel(lang), tone: .info)
                        }
                    }
                }
            }

            // 跟读打分开关
            fieldRow(
                label: "跟读打分",
                hint: missing(.ise)
                    ? "服务端暂未开放，开通后自动恢复；期间跟读页隐藏评测入口。"
                    : "关闭后，跟读练习只保留原声朗读，不再评分。"
            ) {
                if view.caps == .loading {
                    chip("读取中…", tone: .info)
                } else if view.caps == .noneCase || missing(.ise) {
                    HStack(spacing: 6) {
                        Toggle("跟读打分", isOn: .constant(false))
                            .toggleStyle(.switch)
                            .labelsHidden()
                            .disabled(true)
                        chip("未开放", tone: .off)
                    }
                } else {
                    Toggle("跟读打分", isOn: Binding(
                        get: { iseEnabled },
                        set: { onToggleIse($0) }
                    ))
                    .toggleStyle(.switch)
                    .labelsHidden()
                }
            }

            // 本月额度
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text("本月额度")
                        .font(.system(size: 12.5, weight: .semibold))
                    Spacer()
                    if view.exhausted, view.caps != .loading {
                        Button("兑换更多额度", action: onOpenRedeem)
                            .controlSize(.small)
                            .buttonStyle(.bordered)
                    }
                }
                if view.caps == .loading {
                    Text("读取额度信息…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else if let quota = view.quota {
                    Text(quotaLine(quota))
                        .font(.system(size: 12.5, weight: view.exhausted ? .semibold : .regular))
                        .monospacedDigit()
                        .foregroundStyle(view.exhausted ? Color.orange : Color.primary)
                    Text("\(quotaResetText(firstResetsAt(quota)) ?? "按自然月（UTC）计费")；额度随用随扣，用尽时提醒。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else if view.exhausted {
                    Text("本月\(view.exhaustedLabels.joined(separator: "、"))额度已用完；可用兑换码补足，或等下月自动重置。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("额度随用随扣，按自然月（UTC）计费；用尽时这里会展示余量与重置时间。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            // 一键测试
            fieldRow(
                label: "一键测试",
                hint: "逐项验证朗读、识别、跟读打分通道；评分项消耗 1 次额度。"
            ) {
                Button(anyTesting ? "测试中…" : "一键测试") {
                    runAll()
                }
                .controlSize(.small)
                .buttonStyle(.bordered)
                .disabled(!testsAllowed || anyTesting)
                .help("评分项消耗 1 次额度")
            }

            if testsAllowed {
                testRowsView
            }
        }
        .padding(12)
        .background(Color.secondary.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    /// 能力卡头：相位徽标 + 一句话说明（文案逐态对齐 CapabilityCardHead）。
    private var capabilityCardHead: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Text("语音能力")
                    .font(.system(size: 12.5, weight: .semibold))
                capabilityPhaseChip
                Spacer()
            }
            Text(capabilityHeadHint)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var capabilityPhaseChip: some View {
        switch view.caps {
        case .loading:
            chip("读取中…", tone: .info)
        case .noneCase:
            chip("未开通", tone: .off)
        case .partial:
            chip("部分可用", tone: .warn)
        case .full where view.exhausted:
            chip("额度用尽", tone: .warn)
        default:
            chip("全部可用", ok: true)
        }
    }

    private var capabilityHeadHint: String {
        switch view.caps {
        case .loading:
            return "正在获取本账号的语音能力，通常数秒内完成。"
        case .noneCase:
            return "服务端尚未为本账号开通语音；开通后此卡自动点亮，无需重新配置。"
        case .partial:
            return "\(view.missing.map { capabilityLabels[$0]! }.joined(separator: "、"))暂未开放，其余能力不受影响。"
        case .full where view.exhausted:
            return "能力正常，本月\(view.exhaustedLabels.joined(separator: "、"))额度已用完；重置后自动恢复，不改动你的服务商选择。"
        default:
            return "三项能力由沉浸云统一下发，随账号状态自动更新。"
        }
    }

    // MARK: - 一键测试三行灯

    private var testRowsView: some View {
        let done = lights.values.filter { $0.state != .idle }
        let okCount = done.filter { $0.state == .ok }.count
        let badCount = done.filter { $0.state == .bad }.count
        return VStack(alignment: .leading, spacing: 6) {
            ForEach(testRows, id: \.key) { row in
                testRow(row)
            }
            if !anyTesting, badCount > 0 {
                warnBar("测试完成：\(okCount) 项通过，\(badCount) 项异常——可对未通过项单独「重测」。")
            }
            if !anyTesting, badCount == 0, okCount > 0 {
                okBar("测试完成：已测 \(okCount) 项全部正常。")
            }
        }
        .padding(.bottom, 4)
    }

    private func testRow(_ row: (key: VoiceQuotaKey, label: String, name: String)) -> some View {
        let light = lights[row.key] ?? .idle
        let rowDisabled = missing(row.key)
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Circle()
                    .fill(dotColor(light.state))
                    .frame(width: 9, height: 9)
                Text(row.label)
                    .font(.system(size: 12.5, weight: .semibold))
                Text(rowDisabled ? "服务端暂未开放" : row.name)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Spacer()
                Button(light.state == .testing ? "测试中…" : light.state == .idle ? "测试" : "重测") {
                    runOne(row.key)
                }
                .controlSize(.small)
                .buttonStyle(.bordered)
                .disabled(rowDisabled || anyTesting)
            }
            if !light.message.isEmpty {
                Text(light.message)
                    .font(.footnote)
                    .foregroundStyle(light.state == .ok ? Color.green : Color.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func dotColor(_ state: GatewayTestLight.State) -> Color {
        switch state {
        case .ok: return .green
        case .bad: return .red
        case .testing: return .orange
        case .idle: return Color.secondary.opacity(0.5)
        }
    }

    // MARK: - 探测执行

    /// 统一收口：跑一项探测；quota_exceeded 顺带上抛 resource（402 事件式兜底）。
    private func runProbe(_ key: VoiceQuotaKey) async -> GatewayTestLight {
        do {
            if key == .ise {
                let result = try await evaluatePronunciation(refText: gatewaySampleRefText, lang: .en, pcmBase64: GatewayIseSample.loadBase64())
                if result.isRejected {
                    return GatewayTestLight(state: .bad, message: "样本被判定为无效语音，请重测")
                }
                return GatewayTestLight(state: .ok, message: "评测通道正常（总分 \(jsToFixed1(result.total))）")
            }
            if key == .asr {
                let result = try await transcribeBatch(lang: .en_us, pcmBase64: GatewayIseSample.loadBase64())
                if result.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    return GatewayTestLight(state: .bad, message: "识别结果为空，请重测")
                }
                if let seconds = result.durationMs.map({ $0 / 1000 }) {
                    return GatewayTestLight(state: .ok, message: "识别通道正常（约 \(jsToFixed1(seconds)) 秒）")
                }
                return GatewayTestLight(state: .ok, message: "识别通道正常")
            }
            // tts：短句合成探测，分片不播放（onChunk 空实现）。
            return await withCheckedContinuation { continuation in
                GatewayTts.synthesize(
                    text: gatewayTtsProbeText,
                    voice: nil,
                    volume: nil,
                    onChunk: { _ in },
                    onEnd: {
                        continuation.resume(returning: GatewayTestLight(state: .ok, message: "合成通道正常"))
                    },
                    onError: { error in
                        continuation.resume(returning: GatewayTestLight(state: .bad, message: testErrorText(error)))
                    }
                )
            }
        } catch let error as VoiceError where error.code == "quota_exceeded" {
            let details = quotaDetailsOf(error)
            if let resource = details.resource {
                onQuotaEvent(resource)
            }
            let reset = quotaResetText(details.resetsAt)
            let suffix = reset != nil ? "，\(reset!)" : ""
            return GatewayTestLight(state: .bad, message: "本月\(capabilityLabels[key]!)额度已用完\(suffix)")
        } catch {
            return GatewayTestLight(state: .bad, message: testErrorText(error))
        }
    }

    private func runOne(_ key: VoiceQuotaKey) {
        guard !anyTesting, testsAllowed, !missing(key) else { return }
        lights[key] = GatewayTestLight(state: .testing, message: "")
        Task { @MainActor in
            let light = await runProbe(key)
            lights[key] = light
        }
    }

    private func runAll() {
        guard !anyTesting, testsAllowed else { return }
        running = true
        let keys = testRows.map(\.key).filter { !missing($0) }
        lights = [.ise: .idle, .tts: .idle, .asr: .idle]
        for key in keys {
            lights[key] = GatewayTestLight(state: .testing, message: "")
        }
        // 三项并行（对齐 Windows Promise.all）；全部收尾后一次性落灯（期间各行保持
        //「测试中…」，与 Windows setLights 批量写回同序）。
        Task { @MainActor in
            var results: [(VoiceQuotaKey, GatewayTestLight)] = []
            await withTaskGroup(of: (VoiceQuotaKey, GatewayTestLight).self) { group in
                for key in keys {
                    group.addTask {
                        (key, await self.runProbe(key))
                    }
                }
                for await result in group {
                    results.append(result)
                }
            }
            for (key, light) in results {
                lights[key] = light
            }
            running = false
        }
    }

    // MARK: - 小控件

    private func fieldRow<Control: View>(
        label: String,
        hint: String,
        @ViewBuilder control: () -> Control
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(label)
                    .font(.system(size: 12.5, weight: .semibold))
                Spacer()
                control()
            }
            Text(hint)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private enum ChipTone {
        case ok
        case off
        case warn
        case err
        case info
    }

    private func chip(_ text: String, ok: Bool) -> some View {
        chip(text, tone: ok ? .ok : .warn)
    }

    private func chip(_ text: String, tone: ChipTone) -> some View {
        let (color, background): (Color, Color)
        switch tone {
        case .ok: (color, background) = (.green, .green.opacity(0.12))
        case .off: (color, background) = (.secondary, Color.secondary.opacity(0.14))
        case .warn: (color, background) = (.orange, .orange.opacity(0.14))
        case .err: (color, background) = (.red, .red.opacity(0.12))
        case .info: (color, background) = (Brand.accent, Brand.accent.opacity(0.12))
        }
        return Text(text)
            .font(.system(size: 10.5, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(background, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
    }

    private func redBar<Actions: View>(_ text: String, @ViewBuilder actions: () -> Actions) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundStyle(.red)
            Text(text)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            actions()
        }
        .padding(10)
        .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func warnBar(_ text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundStyle(.orange)
            Text(text)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
        }
        .padding(10)
        .background(Color.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func okBar(_ text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 11))
                .foregroundStyle(.green)
            Text(text)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
        }
        .padding(10)
        .background(Color.green.opacity(0.09), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
