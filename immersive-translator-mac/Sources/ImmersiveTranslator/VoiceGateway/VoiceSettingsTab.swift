import SwiftUI

// ---------------------------------------------------------------------------
// 设置页「语音」tab 双栏（对齐 Windows src/views/VoiceSettingsTab.tsx，契约
// §三.1/§三.6/§三.7；文案逐字复刻，控件按 Mac 既有 SwiftUI 风格——规格 §四差异 10）：
//
// - 左列：「沉浸云语音」官方大卡（platform-card）+「自带凭据 · 高级」下的讯飞行；
//   右列随选中切换（GatewayVoiceSection 云能力卡 / 既有 XfyunVoiceSettingsSection 原样保留）。
// - 选中即即时保存（voiceProvider，didSet 直写 UserDefaults，不点亮保存条）；
//   与 LLM providerId 解耦；不纳入云同步。
// - 迁移推断（§三.3）：未存过 voiceProvider 时按讯飞凭据存在性取默认，只展示不落盘。
// - 官方云未开放（platformBase=null）：Windows 整组隐藏；Mac resolveBaseURL 恒有值
//   （规格 §四差异 7），cloudOpen 恒真，保留双态文案的另一态于注释。
// - 能力下发：登录后拉一次 getVoiceCapabilities()，视图状态经 reduceVoiceGatewayView
//   归约；失败码只有 banned 单列（封禁整卡），其余并入「网络失败」。
// ---------------------------------------------------------------------------

struct VoiceSettingsTab: View {
    @ObservedObject var settingsStore: SettingsStore
    @ObservedObject var serverAuth: ServerAuthClient
    @ObservedObject private var xfyunStore = XfyunCredentialsStore.shared
    /// 「登录沉浸云」按钮 → AppDelegate.openLoginWindow（登录态翻转由
    /// serverAuth.$status 驱动能力下发）。
    let onOpenLogin: () -> Void
    /// 「管理账号」→ 账号分区。
    let onOpenAccount: () -> Void
    /// 「兑换更多额度」→ 账号分区兑换码卡。
    let onOpenRedeem: () -> Void

    /// 官方云是否开放。Mac 无 null 态（ServerAuthConfiguration.resolveBaseURL
    /// 恒返回值），恒真；Windows platformBase===null 时官方分组整体隐藏。
    private let cloudOpen = true

    @State private var inferred: VoiceProvider?
    @State private var caps: VoiceCapabilities?
    @State private var capsLoading = false
    @State private var capsError: String?
    @State private var reloadNonce = 0
    /// 402/WSS quota_exceeded 事件（资源裸值），配额常驻字段未下发时的兜底来源。
    @State private var quotaEvents: [String] = []
    @State private var guideDismissed = false
    @State private var openingLogin = false
    /// 能力拉取代数（对齐 Windows effect 的 active 标志：登出/重试后迟到的旧结果丢弃）。
    @State private var capsGeneration = 0

    private var loggedIn: Bool { serverAuth.status.loggedIn }
    private var email: String { serverAuth.status.user?.email ?? "" }

    /// 生效服务商：未存过用推断值；推断在 arrive 前按 gateway 骨架（对齐 Windows
    /// `?? inferred ?? "gateway"`）；官方云未开放强制讯飞的分支见 cloudOpen 注释——
    /// Mac 恒开放。
    private var provider: VoiceProvider {
        settingsStore.voiceProvider ?? inferred ?? .gateway
    }

    private var view: VoiceGatewayView {
        reduceVoiceGatewayView(
            VoiceGatewayInput(
                loading: capsLoading,
                errorCode: capsError,
                caps: caps,
                quotaEvents: quotaEvents
            )
        )
    }

    private var status: (tone: VoiceStatusTone, text: String) {
        voiceGatewayStatusLine(view, loggedIn: loggedIn, email: email)
    }

    /// 讯飞行 keydot / 右列徽标：nil = 探测中（「读取中…」）。XfyunCredentialsStore
    /// 启动即从 Keychain 装载（无 IPC），凭据非空时才能给出确定态。
    private var xfyunConfigured: Bool? {
        if xfyunStore.credentials.isEmpty { return nil }
        return xfyunStore.hasAnyCredential
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if showSwitchGuide {
                guideBar
            }
            if showNotProvisioned {
                notProvisionedBar
            }

            HStack(alignment: .top, spacing: 14) {
                // ---- 左列：服务商选择 ----
                VStack(alignment: .leading, spacing: 12) {
                    if cloudOpen {
                        providerGroup(title: "官方云服务", subtitle: "沉浸云账号登录即用，三个服务零配置") {
                            platformCard
                        }
                    }
                    providerGroup(title: "自带凭据 · 高级", subtitle: "使用你自己的讯飞开放平台应用与密钥") {
                        xfyunRow
                    }
                }
                .frame(width: 250, alignment: .topLeading)

                // ---- 右列：随选中切换的配置面板 ----
                VStack(alignment: .leading, spacing: 12) {
                    configurationHeader
                    if provider == .gateway {
                        GatewayVoiceSection(
                            email: email,
                            loggedIn: loggedIn,
                            openingLogin: openingLogin,
                            caps: caps,
                            view: view,
                            selectedVoice: settingsStore.voiceGatewayVoice,
                            iseEnabled: settingsStore.voiceGatewayIseEnabled,
                            onLogin: handleLogin,
                            onManageAccount: onOpenAccount,
                            onRetryCaps: { reloadNonce += 1 },
                            onOpenRedeem: onOpenRedeem,
                            onSelectVoice: { settingsStore.voiceGatewayVoice = $0 },
                            onToggleIse: { settingsStore.voiceGatewayIseEnabled = $0 },
                            onQuotaEvent: { resource in
                                if !quotaEvents.contains(resource) {
                                    quotaEvents.append(resource)
                                }
                            }
                        )
                    } else {
                        XfyunVoiceSettingsSection()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }

            Text("之前在阅读室设置抽屉、口语陪练、录音直译里填过的凭据仍然有效（同一套加密存储），无需重复填写。")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .onAppear {
            refreshInferred()
        }
        .onChange(of: settingsStore.voiceProvider) { _ in
            refreshInferred()
        }
        .onChange(of: loggedIn) { _ in
            openingLogin = false
            Task { await reloadCaps() }
        }
        .task(id: reloadNonce) {
            await reloadCaps()
        }
    }

    // MARK: - 状态装载

    /// 迁移推断：未存过选择时按讯飞凭据存在性取默认（任一凭据存在 → 保持 xfyun
    /// 零感知）；已存值以已存值为准。推断结果只展示不落盘。
    private func refreshInferred() {
        if settingsStore.voiceProvider != nil {
            inferred = nil
            return
        }
        inferred = inferVoiceProvider(xfyunStore.presenceSnapshot())
    }

    /// 能力下发：登录后拉一次；重试 / 登出重登由依赖项驱动。
    private func reloadCaps() async {
        capsGeneration += 1
        let generation = capsGeneration
        guard cloudOpen, loggedIn else {
            caps = nil
            capsError = nil
            capsLoading = false
            return
        }
        capsLoading = true
        capsError = nil
        let result: Result<VoiceCapabilities, Error>
        do {
            result = .success(try await getVoiceCapabilities())
        } catch {
            result = .failure(error)
        }
        // 迟到的旧结果（期间登出/重试已发起新一轮）不落 UI。
        guard generation == capsGeneration else { return }
        switch result {
        case .success(let fetched):
            caps = fetched
        case .failure(let error as AuthError):
            capsError = error.code.isEmpty ? "network_error" : error.code
        case .failure(let error as VoiceError):
            capsError = error.code.isEmpty ? "network_error" : error.code
        case .failure:
            capsError = "network_error"
        }
        capsLoading = false
    }

    /// 引导切云条：已登录且三项能力齐备、用户还停在讯飞时提示（可关闭）。
    private var showSwitchGuide: Bool {
        cloudOpen && provider == .xfyun && loggedIn && view.caps == .full && !guideDismissed
    }

    /// 未开通提示条：带重试（重新拉能力）。
    private var showNotProvisioned: Bool {
        cloudOpen && provider == .gateway && view.caps == .noneCase
    }

    private func handleLogin() {
        guard !openingLogin, !loggedIn else { return }
        openingLogin = true
        // 登录成功的状态翻转由 serverAuth.$status 驱动（loggedIn 变化即触发能力下发）。
        Task { @MainActor in
            onOpenLogin()
            // 与 Windows openLoginWindow().finally 对应：登录窗口拉起后复位按钮态
            //（Mac 开窗同步完成，保留短暂「正在打开登录窗口…」反馈后复位；登录态
            // 翻转时 onChange(loggedIn) 也会立即复位）。
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            openingLogin = false
        }
    }

    // MARK: - 左列卡片

    private func providerGroup<Content: View>(title: String, subtitle: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                Text(subtitle)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            content()
        }
    }

    /// 沉浸云语音官方大卡（点卡即保存 voiceProvider=gateway）。
    private var platformCard: some View {
        let selected = provider == .gateway
        return Button {
            selectProvider(.gateway)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Text("云")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Brand.accent)
                    )
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text("沉浸云语音")
                            .font(.system(size: 12.5, weight: .semibold))
                        chipLabel("官方", color: .green)
                        chipLabel("推荐", color: Brand.accent)
                    }
                    Text("登录即用，三服务共用一个账号")
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 5) {
                        Circle()
                            .fill(statusDotColor)
                            .frame(width: 6, height: 6)
                        Text(status.text)
                            .font(.system(size: 10.5))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Brand.accent)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(selected ? Brand.accent.opacity(0.10) : Color.secondary.opacity(0.05))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(selected ? Brand.accent.opacity(0.5) : Color.primary.opacity(0.09), lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("沉浸云语音")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private var statusDotColor: Color {
        switch status.tone {
        case .ok: return .green
        case .off: return .orange
        case .err: return .red
        }
    }

    /// 讯飞行（点行即保存 voiceProvider=xfyun；凭据存在时亮 keydot）。
    private var xfyunRow: some View {
        let selected = provider == .xfyun
        return Button {
            selectProvider(.xfyun)
        } label: {
            HStack(spacing: 10) {
                Text("讯")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color(hue: 0.61, saturation: 0.85, brightness: 0.96))
                    .frame(width: 28, height: 28)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color(hue: 0.61, saturation: 0.85, brightness: 0.96).opacity(0.14))
                    )
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text("讯飞开放平台")
                        .font(.system(size: 12.5, weight: .semibold))
                    Text("跟读打分 / 口语识别 / 云端朗读 · 需自行申请凭据")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 0)
                if xfyunConfigured == true {
                    // keydot：已保存讯飞凭据（Mac 为 Keychain 加密，规格 §四差异 8）。
                    Circle()
                        .fill(Color.green)
                        .frame(width: 7, height: 7)
                        .help("已保存讯飞凭据（Keychain 加密）")
                }
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Brand.accent)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(selected ? Brand.accent.opacity(0.10) : Color.secondary.opacity(0.05))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(selected ? Brand.accent.opacity(0.5) : Color.primary.opacity(0.09), lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("讯飞开放平台")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    /// 点卡即写盘（voiceProvider didSet 直写 UserDefaults，不经保存条）。
    private func selectProvider(_ next: VoiceProvider) {
        guard next != provider else { return }
        settingsStore.voiceProvider = next
    }

    // MARK: - 右列配置面板头

    private var configurationHeader: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(provider == .gateway ? "沉浸云账号" : "讯飞开放平台")
                    .font(.system(size: 15, weight: .semibold))
                Text(provider == .gateway ? "沉浸云语音" : "跟读打分 / 口语识别 / 云端朗读")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if provider == .gateway {
                chipLabel(loggedIn ? "已登录" : "未登录", color: loggedIn ? .green : .orange)
            } else {
                chipLabel(
                    xfyunConfigured == nil ? "读取中…" : (xfyunConfigured! ? "凭据已保存" : "未配置"),
                    color: (xfyunConfigured == true) ? .green : .orange
                )
            }
        }
        .padding(.bottom, 2)
    }

    // MARK: - 提示条

    /// 切云引导条（Windows msg-bar ok：绿色成功调）。
    private var guideBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "info.circle.fill")
                .font(.system(size: 12))
                .foregroundStyle(.green)
            Text("沉浸云已为本账号开通语音能力——点击左侧「沉浸云语音」卡片即可切换，讯飞凭据保留、随时切回。")
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button {
                guideDismissed = true
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("关闭提醒")
        }
        .padding(10)
        .background(Color.green.opacity(0.09), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var notProvisionedBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 12))
                .foregroundStyle(.orange)
            Text("语音功能暂未开通——账号正常，服务端尚未为本账号开通语音。")
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button("重试") {
                reloadNonce += 1
            }
            .controlSize(.small)
            .buttonStyle(.bordered)
        }
        .padding(10)
        .background(Color.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func chipLabel(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 10.5, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
    }
}
