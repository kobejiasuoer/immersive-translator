import AppKit
import SwiftUI

// ---------------------------------------------------------------------------
// 登录窗（对齐 Windows src/views/LoginView.tsx 420×560）：
// 验证码主流程（自动建号）+ 密码页签。
// 状态机：邮箱页 → 验证码页（60s 重发倒计时，UserDefaults 持久化恢复）→
// 成功 → 900ms 自动关窗。
// 错误文案唯一出口 authErrorText（ServerAuth.swift）；banned 阻断、
// rate_limited 倒计时禁用不自动重试；已登录时显示兜底卡片直达账号设置。
//
// 视觉令牌取自 prototypes/windows-workbench-v08-2026-10-15.html：
// 浅色 = warm-archival（暖纸 #F6F3EC + 赤陶 #C84B31 + 墨阶 + 发丝线），
// 深色 = obsidian-sonic（#0E1014 + 橘赤 #E26D52）；衬线展示字体在 macOS 上
// 由 system serif design 落到 Songti SC（CJK）/Times（拉丁）。
// 控件骨架译为原生手感：系统窗口、Esc 关窗、回车提交、原生焦点环语义、
// 按钮 100ms 按压反馈（damping 1.0 无过冲）、tab 切换 300ms 弹性。
//
// 接线（App.swift）：AppDelegate.loginController 持有唯一实例；菜单「账号登录...」
// 未登录时 show()，已登录时走 openAccountSettings() → 设置窗「账号」分区；
// onOpenAccountSettings 回调即 SettingsWindowController.showAccountSection()。
// ---------------------------------------------------------------------------

// MARK: - 主题令牌（对照原型 :root / [data-theme] 逐项）

private struct LoginTheme {
    let paper: Color
    let elevated: Color
    let fieldBackground: Color
    let hairline: Color
    let ink1: Color
    let ink2: Color
    let ink3: Color
    let ink4: Color
    let accent: Color
    let accentSoft: Color
    let accentHover: Color
    let err: Color
    let errSoft: Color

    static func resolve(_ scheme: ColorScheme) -> LoginTheme {
        scheme == .dark
            ? LoginTheme(
                paper: Color(red: 0x0E / 255, green: 0x10 / 255, blue: 0x14 / 255),
                elevated: Color(red: 0x1D / 255, green: 0x20 / 255, blue: 0x28 / 255),
                fieldBackground: Color(red: 0x17 / 255, green: 0x1A / 255, blue: 0x21 / 255),
                hairline: Color.white.opacity(0.12),
                ink1: Color(red: 0xF4 / 255, green: 0xF2 / 255, blue: 0xED / 255),
                ink2: Color(red: 0xB9 / 255, green: 0xB5 / 255, blue: 0xAC / 255),
                ink3: Color(red: 0x7E / 255, green: 0x7B / 255, blue: 0x73 / 255),
                ink4: Color(red: 0x4D / 255, green: 0x4B / 255, blue: 0x45 / 255),
                accent: Color(red: 0xE2 / 255, green: 0x6D / 255, blue: 0x52 / 255),
                accentSoft: Color(red: 0xE2 / 255, green: 0x6D / 255, blue: 0x52 / 255).opacity(0.16),
                accentHover: Color(red: 0xEA / 255, green: 0x82 / 255, blue: 0x66 / 255),
                err: Color(red: 0xF0 / 255, green: 0x68 / 255, blue: 0x68 / 255),
                errSoft: Color(red: 0xF0 / 255, green: 0x68 / 255, blue: 0x68 / 255).opacity(0.16)
            )
            : LoginTheme(
                paper: Color(red: 0xF6 / 255, green: 0xF3 / 255, blue: 0xEC / 255),
                elevated: Color.white.opacity(0.92),
                fieldBackground: Color.white,
                hairline: Color(red: 0x17 / 255, green: 0x16 / 255, blue: 0x14 / 255).opacity(0.12),
                ink1: Color(red: 0x17 / 255, green: 0x16 / 255, blue: 0x14 / 255),
                ink2: Color(red: 0x4A / 255, green: 0x47 / 255, blue: 0x40 / 255),
                ink3: Color(red: 0x7A / 255, green: 0x75 / 255, blue: 0x6C / 255),
                ink4: Color(red: 0xAC / 255, green: 0xA6 / 255, blue: 0x9B / 255),
                accent: Color(red: 0xC8 / 255, green: 0x4B / 255, blue: 0x31 / 255),
                accentSoft: Color(red: 0xC8 / 255, green: 0x4B / 255, blue: 0x31 / 255).opacity(0.11),
                accentHover: Color(red: 0xB3 / 255, green: 0x43 / 255, blue: 0x2C / 255),
                err: Color(red: 0xB9 / 255, green: 0x1C / 255, blue: 0x1C / 255),
                errSoft: Color(red: 0xB9 / 255, green: 0x1C / 255, blue: 0x1C / 255).opacity(0.10)
            )
    }
}

// MARK: - 窗口控制器

@MainActor
final class LoginWindowController: NSWindowController {
    private let auth: ServerAuthClient
    private let onOpenAccountSettings: () -> Void
    /// SwiftUI 视图关窗回调的延迟绑定盒（init 时 window 尚未存在）。
    private let closeBox = CloseBox()

    init(auth: ServerAuthClient, onOpenAccountSettings: @escaping () -> Void) {
        self.auth = auth
        self.onOpenAccountSettings = onOpenAccountSettings
        let box = closeBox
        let view = LoginView(
            auth: auth,
            onOpenAccountSettings: onOpenAccountSettings,
            onClose: { box.close() }
        )
        let hosting = NSHostingController(rootView: view)
        let window = LoginPanelWindow(contentViewController: hosting)
        window.title = "账号登录"
        window.styleMask = [.titled, .closable, .miniaturizable]
        window.setContentSize(NSSize(width: 420, height: 560))
        window.minSize = NSSize(width: 420, height: 560)
        window.maxSize = NSSize(width: 420, height: 560)
        window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(red: 0x0E / 255, green: 0x10 / 255, blue: 0x14 / 255, alpha: 1)
                : NSColor(red: 0xF6 / 255, green: 0xF3 / 255, blue: 0xEC / 255, alpha: 1)
        }
        super.init(window: window)
        closeBox.close = { [weak self] in
            self?.window?.performClose(nil)
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show() {
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}

/// Esc 关窗（macOS 对话框约定：Esc = 取消/关闭）。
private final class LoginPanelWindow: NSWindow {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.type == .keyDown,
           event.keyCode == 53,
           event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(.capsLock).isEmpty {
            performClose(self)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

private final class CloseBox {
    var close: () -> Void = {}
    func callAsFunction() { close() }
}

// MARK: - 登录视图（状态机对齐 LoginView.tsx）

private enum LoginTab: Hashable {
    case otp
    case password
}

/// 对齐 LoginView.tsx:24 —— 邮箱页/验证码页属于 otp 流；password 为密码页签
/// 独立视图；success 两条流共用。view 与 tab 分离：banned 回邮箱页不改 tab。
private enum LoginViewName: Hashable {
    case email
    case code
    case password
    case success
}

private struct LoginBanner: Equatable {
    enum Kind { case err, ok }
    let kind: Kind
    let text: String
}

private struct LoginView: View {
    let auth: ServerAuthClient
    let onOpenAccountSettings: () -> Void
    let onClose: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    private var theme: LoginTheme { LoginTheme.resolve(colorScheme) }

    @State private var tab: LoginTab = .otp
    @State private var view: LoginViewName = .email
    @State private var email = ""
    @State private var password = ""
    @State private var code = ""
    /// 错码清空 + 重聚焦第一格的信号（每 +1 触发一次 representable 重置）。
    @State private var otpResetToken = 0
    /// 提交后邮箱非法时显示红 hint（§8.2 邮箱输入页）。
    @State private var emailHint = false
    @State private var sending = false
    @State private var verifying = false
    @State private var loggingIn = false
    @State private var banner: LoginBanner?
    /// banned 阻断态：禁用提交，仅「返回修改邮箱」可清（§3）。
    @State private var banned = false
    /// rate_limited 剩余秒（读 retry-after，到 0 自动恢复，不自动重试）。
    @State private var rateUntil = 0
    /// 已登录兜底卡片（打开登录窗时账号已在）。
    @State private var existing: AuthStatus?

    @State private var cooldownRemaining = 0
    private let cooldownTracker = OtpCooldownTracker(storage: UserDefaults.standard)

    @FocusState private var emailFieldFocused: Bool
    @FocusState private var passwordFieldFocused: Bool

    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var normalizedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var emailInvalid: Bool { !validEmail(normalizedEmail) }
    private var codeValue: String { code }

    var body: some View {
        VStack(spacing: 0) {
            brandBand
            Divider().overlay(theme.hairline).frame(height: 1)
            ScrollView {
                VStack(spacing: 14) {
                    if let banner {
                        bannerView(banner)
                    }
                    if let existing, view != .success {
                        existingCard(existing)
                    } else {
                        if view != .success {
                            tabs
                        }
                        switch view {
                        case .email:
                            emailView
                        case .code:
                            codeView
                        case .password:
                            passwordView
                        case .success:
                            successView
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(theme.paper)
        .onAppear(perform: bootstrapState)
        .onReceive(ticker) { _ in
            if rateUntil > 0 {
                rateUntil -= 1
            }
            cooldownRemaining = cooldownTracker.remaining(email: normalizedEmail)
        }
        .onChange(of: email) { _ in
            if validEmail(normalizedEmail) {
                emailHint = false
            }
            cooldownRemaining = cooldownTracker.remaining(email: normalizedEmail)
        }
        .onChange(of: view) { newView in
            if newView == .success {
                // §8.2 登录成功态：短暂反馈后 900ms 自动关窗。
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 900_000_000)
                    onClose()
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // 品牌条带（对照 login-band：印记 + 衬线标题 + 副题 + 文A 水印）
    // ------------------------------------------------------------------

    private var brandBand: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(theme.accent)
                Text("译")
                    .font(.system(size: 16, weight: .bold, design: .serif))
                    .foregroundColor(.white)
            }
            .frame(width: 30, height: 30)
            VStack(alignment: .leading, spacing: 3) {
                Text("沉浸翻译")
                    .font(.system(size: 20, weight: .semibold, design: .serif))
                    .foregroundColor(theme.ink1)
                Text("登录后同步生词本、阅读进度与偏好设置")
                    .font(.system(size: 12))
                    .foregroundColor(theme.ink3)
            }
            Spacer(minLength: 8)
            (Text("文").font(.system(size: 30, weight: .regular, design: .serif))
                + Text("A").font(.system(size: 30, weight: .semibold, design: .serif)).italic()
            )
            .foregroundColor(theme.accent)
            .opacity(0.32)
            .padding(.trailing, 2)
        }
        .padding(.horizontal, 20)
        .padding(.top, 18)
        .padding(.bottom, 14)
    }

    // ------------------------------------------------------------------
    // 横幅（错误/成功红绿条）
    // ------------------------------------------------------------------

    private func bannerView(_ banner: LoginBanner) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: banner.kind == .ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .font(.system(size: 12))
                .foregroundColor(banner.kind == .ok ? theme.accent : theme.err)
                .padding(.top, 1)
            Text(banner.text)
                .font(.system(size: 12))
                .foregroundColor(theme.ink2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(banner.kind == .ok ? theme.accentSoft : theme.errSoft)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(banner.kind == .ok ? theme.accent.opacity(0.25) : theme.err.opacity(0.25), lineWidth: 1)
        )
    }

    // ------------------------------------------------------------------
    // 页签（对照 login-tabs 分段控件）
    // ------------------------------------------------------------------

    private var tabs: some View {
        HStack(spacing: 2) {
            tabButton("验证码登录", id: .otp)
            tabButton("密码登录", id: .password)
        }
        .padding(3)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(theme.ink1.opacity(colorScheme == .dark ? 0.06 : 0.05))
        )
    }

    private func tabButton(_ title: String, id: LoginTab) -> some View {
        let selected = tab == id
        return Button {
            switchTab(id)
        } label: {
            Text(title)
                .font(.system(size: 13, weight: selected ? .semibold : .regular))
                .foregroundColor(selected ? theme.ink1 : theme.ink3)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(selected ? theme.elevated : Color.clear)
                        .shadow(color: Color.black.opacity(colorScheme == .dark ? 0.4 : 0.08), radius: selected ? 3 : 0, y: 1)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(.spring(response: 0.3, dampingFraction: 1.0), value: tab)
    }

    // ------------------------------------------------------------------
    // 邮箱页
    // ------------------------------------------------------------------

    private var emailView: some View {
        VStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("邮箱地址")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(theme.ink2)
                TextField("you@example.com", text: $email)
                    .textFieldStyle(.plain)
                    .focused($emailFieldFocused)
                    .disabled(banned)
                    .onSubmit { handleSendOtp() }
                    .font(.system(size: 13))
                    .autocorrectionDisabled()
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(theme.fieldBackground)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(
                                emailHint && emailInvalid ? theme.err : theme.hairline,
                                lineWidth: 1
                            )
                    )
                if emailHint && emailInvalid {
                    Text("请输入有效的邮箱地址")
                        .font(.system(size: 11))
                        .foregroundColor(theme.err)
                }
            }
            PrimaryActionButton(
                title: sendButtonTitle,
                theme: theme,
                isBusy: sending
            ) {
                handleSendOtp()
            }
            .disabled(sendDisabled)
            HStack(spacing: 6) {
                Label("未注册的邮箱将在验证后自动创建账号", systemImage: "info.circle")
                    .font(.system(size: 11))
                    .foregroundColor(theme.ink3)
                    .labelStyle(.titleAndIcon)
                    .imageScale(.small)
                Spacer()
                if banned {
                    Button("返回修改邮箱") { clearBanned() }
                        .font(.system(size: 12))
                        .foregroundColor(theme.accent)
                        .buttonStyle(.plain)
                }
            }
        }
    }

    private var sendButtonTitle: String {
        if rateUntil > 0 { return "请 \(rateUntil) 秒后再试" }
        if cooldownRemaining > 0 { return "获取验证码（\(cooldownRemaining)s）" }
        if sending { return "发送中…" }
        return "获取验证码"
    }

    private var sendDisabled: Bool {
        sending || banned || rateUntil > 0 || cooldownRemaining > 0 || emailInvalid
    }

    // ------------------------------------------------------------------
    // 验证码页
    // ------------------------------------------------------------------

    private var codeView: some View {
        VStack(spacing: 14) {
            HStack(spacing: 0) {
                Text("验证码已发送至 ")
                    .font(.system(size: 12))
                    .foregroundColor(theme.ink3)
                Text(normalizedEmail)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(theme.ink1)
            }
            .frame(maxWidth: .infinity)
            OtpCodeFieldView(
                code: $code,
                resetToken: otpResetToken,
                onSubmit: { handleVerify() }
            )
            .frame(height: 48)
            .padding(.top, 2)
            PrimaryActionButton(
                title: verifying ? "登录中…" : "登 录",
                theme: theme,
                isBusy: verifying
            ) {
                handleVerify()
            }
            .disabled(verifying || rateUntil > 0 || codeValue.count < 6)
            HStack(spacing: 6) {
                GhostActionButton(
                    title: cooldownRemaining > 0 ? "重新发送（\(cooldownRemaining)s）" : "重新发送",
                    theme: theme
                ) {
                    handleResend()
                }
                .disabled(sending || cooldownRemaining > 0)
                Text("·")
                    .font(.system(size: 12))
                    .foregroundColor(theme.ink4)
                Button("换一个邮箱") { backToEmail() }
                    .font(.system(size: 12))
                    .foregroundColor(theme.accent)
                    .buttonStyle(.plain)
            }
        }
    }

    // ------------------------------------------------------------------
    // 密码页签
    // ------------------------------------------------------------------

    private var passwordView: some View {
        VStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("邮箱地址")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(theme.ink2)
                TextField("you@example.com", text: $email)
                    .textFieldStyle(.plain)
                    .disabled(banned)
                    .autocorrectionDisabled()
                    .font(.system(size: 13))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(theme.fieldBackground)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(theme.hairline, lineWidth: 1)
                    )
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("密码")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(theme.ink2)
                SecureField("输入密码", text: $password)
                    .textFieldStyle(.plain)
                    .focused($passwordFieldFocused)
                    .disabled(banned)
                    .onSubmit { handlePasswordLogin() }
                    .font(.system(size: 13))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(theme.fieldBackground)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(theme.hairline, lineWidth: 1)
                    )
                Text("从未设置过密码的账号，请改用验证码登录")
                    .font(.system(size: 11))
                    .foregroundColor(theme.ink3)
            }
            PrimaryActionButton(
                title: rateUntil > 0 ? "请 \(rateUntil) 秒后再试" : (loggingIn ? "登录中…" : "登 录"),
                theme: theme,
                isBusy: loggingIn
            ) {
                handlePasswordLogin()
            }
            .disabled(loggingIn || banned || rateUntil > 0 || emailInvalid || password.isEmpty)
            HStack {
                Text("忘记密码？可在验证码登录后随时设置密码（后续迭代）")
                    .font(.system(size: 11))
                    .foregroundColor(theme.ink3)
                Spacer()
            }
        }
    }

    // ------------------------------------------------------------------
    // 成功态 / 已登录兜底卡
    // ------------------------------------------------------------------

    private var successView: some View {
        VStack(spacing: 10) {
            ZStack {
                Circle()
                    .strokeBorder(theme.accent, lineWidth: 1.5)
                    .frame(width: 56, height: 56)
                Image(systemName: "checkmark")
                    .font(.system(size: 24, weight: .medium))
                    .foregroundColor(theme.accent)
            }
            .padding(.top, 10)
            Text("登录成功")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(theme.ink1)
            Text("窗口即将自动关闭，账号信息可在「设置 → 账号」中查看")
                .font(.system(size: 12))
                .foregroundColor(theme.ink3)
                .multilineTextAlignment(.center)
            SecondaryActionButton(title: "进入账号管理", theme: theme) {
                onOpenAccountSettings()
                onClose()
            }
            .padding(.top, 6)
        }
        .frame(maxWidth: .infinity)
    }

    private func existingCard(_ existing: AuthStatus) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "person.crop.circle.fill")
                .font(.system(size: 30))
                .foregroundColor(theme.accent)
                .padding(.top, 8)
            Text("已登录")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(theme.ink1)
            Text(existing.user?.nickname ?? existing.user?.email ?? "")
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(theme.ink2)
            Text("账号信息与登出请在「设置 → 账号」管理")
                .font(.system(size: 12))
                .foregroundColor(theme.ink3)
            HStack(spacing: 10) {
                PrimaryActionButton(title: "打开账号设置", theme: theme, isBusy: false) {
                    onOpenAccountSettings()
                    onClose()
                }
                SecondaryActionButton(title: "使用其他账号登录", theme: theme) {
                    self.existing = nil
                }
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    // ------------------------------------------------------------------
    // 交互（对齐 LoginView.tsx 的 handler 逐条）
    // ------------------------------------------------------------------

    private func bootstrapState() {
        cooldownRemaining = cooldownTracker.remaining(email: normalizedEmail)
        emailFieldFocused = true
        // 挂载时检查登录态：已登录则显示兜底卡片，不打扰已登录用户重走流程。
        Task { @MainActor in
            let snapshot = await auth.manager.getStatus()
            if snapshot.loggedIn {
                existing = snapshot
            }
        }
    }

    /// 错误落 UI：banner 文案 + banned 阻断 + rate_limited 秒数。
    private func applyAuthError(_ error: AuthError) {
        let mapped = authErrorText(error)
        banner = LoginBanner(kind: .err, text: mapped.text)
        if mapped.code == "banned" {
            // §3：回到邮箱页，禁用提交，仅保留「返回修改邮箱」清错误态。
            banned = true
            view = .email
        }
        if mapped.code == "rate_limited" {
            if let seconds = error.retryAfterSeconds, seconds > 0 {
                rateUntil = seconds
            }
        }
    }

    private func handleSendOtp() {
        // D10：关窗重开落回邮箱页时，持久化冷却同样生效（服务端静默不发恒回
        // {ok:true}，不拦会让用户误以为已重发）。
        guard !(sending || banned || rateUntil > 0 || cooldownRemaining > 0) else { return }
        let address = normalizedEmail
        guard validEmail(address) else {
            emailHint = true
            emailFieldFocused = true
            return
        }
        sending = true
        banner = nil
        Task { @MainActor in
            defer { sending = false }
            do {
                try await auth.sendOTP(email: address)
                code = ""
                otpResetToken += 1
                view = .code
                cooldownTracker.markSent(email: address)
                cooldownRemaining = OtpCooldown.cooldownSeconds
            } catch let error as AuthError {
                // service_unavailable / network_error：停邮箱页红条，按钮恢复可重试（§3）。
                applyAuthError(error)
            } catch {
                banner = LoginBanner(kind: .err, text: authErrorText(.local("unknown", "未知错误")).text)
            }
        }
    }

    private func handleResend() {
        guard !(sending || cooldownRemaining > 0) else { return }
        sending = true
        banner = nil
        Task { @MainActor in
            defer { sending = false }
            do {
                try await auth.sendOTP(email: normalizedEmail)
                cooldownTracker.markSent(email: normalizedEmail)
                cooldownRemaining = OtpCooldown.cooldownSeconds
            } catch let error as AuthError {
                applyAuthError(error)
            } catch {
                banner = LoginBanner(kind: .err, text: authErrorText(.local("unknown", "未知错误")).text)
            }
        }
    }

    private func handleVerify() {
        guard !(verifying || rateUntil > 0 || codeValue.count < 6) else { return }
        verifying = true
        banner = nil
        Task { @MainActor in
            defer { verifying = false }
            do {
                _ = try await auth.verifyOTP(email: normalizedEmail, code: codeValue)
                view = .success
            } catch let error as AuthError {
                banner = LoginBanner(kind: .err, text: authErrorText(error).text)
                let mapped = authErrorText(error)
                if mapped.code == "otp_invalid" {
                    // §3：停验证码页，清空码输入并聚焦，保留重发按钮。
                    code = ""
                    otpResetToken += 1
                } else if mapped.code == "banned" {
                    banned = true
                    view = .email
                } else if mapped.code == "rate_limited" {
                    if let seconds = error.retryAfterSeconds, seconds > 0 {
                        rateUntil = seconds
                    }
                }
                // storage_error（流程中止）/ network_error（可重试）：停验证码页红条。
            } catch {
                banner = LoginBanner(kind: .err, text: authErrorText(.local("unknown", "未知错误")).text)
            }
        }
    }

    private func handlePasswordLogin() {
        guard !(loggingIn || banned || rateUntil > 0) else { return }
        let address = normalizedEmail
        guard validEmail(address) else {
            banner = LoginBanner(kind: .err, text: "请输入有效的邮箱地址")
            return
        }
        guard !password.isEmpty else { return }
        loggingIn = true
        banner = nil
        Task { @MainActor in
            defer { loggingIn = false }
            do {
                _ = try await auth.loginPassword(email: address, password: password)
                view = .success
            } catch let error as AuthError {
                banner = LoginBanner(kind: .err, text: authErrorText(error).text)
                let mapped = authErrorText(error)
                if mapped.code == "invalid_credentials" {
                    // §3：停密码页签，清空并选中密码框。
                    password = ""
                    passwordFieldFocused = true
                } else if mapped.code == "banned" {
                    banned = true
                    view = .email
                } else if mapped.code == "rate_limited" {
                    if let seconds = error.retryAfterSeconds, seconds > 0 {
                        rateUntil = seconds
                    }
                }
            } catch {
                banner = LoginBanner(kind: .err, text: authErrorText(.local("unknown", "未知错误")).text)
            }
        }
    }

    private func switchTab(_ next: LoginTab) {
        tab = next
        banner = nil
        view = next == .otp ? .email : .password
        if next == .otp {
            emailFieldFocused = true
        } else {
            passwordFieldFocused = true
        }
    }

    /// 「换一个邮箱」：回邮箱页，保留已填邮箱。
    private func backToEmail() {
        view = .email
        banner = nil
        emailFieldFocused = true
    }

    /// banned 阻断态的「返回修改邮箱」：清阻断与错误态，回可编辑（§3）。
    private func clearBanned() {
        banned = false
        banner = nil
        emailFieldFocused = true
    }
}

/// 邮箱校验（与 Windows EMAIL_RE 同式：宽松单 @ + 顶域）。
private func validEmail(_ value: String) -> Bool {
    let pattern = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"
    return value.range(of: pattern, options: .regularExpression) != nil
}

// MARK: - 按钮族（按压即时反馈 + hover 细节；spring damping 1.0 无过冲）

private struct PrimaryActionButton: View {
    let title: String
    let theme: LoginTheme
    let isBusy: Bool
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                }
                Text(title)
                    .font(.system(size: 13, weight: .medium))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
        }
        .buttonStyle(PressScaleButtonStyle(fill: hovering ? theme.accentHover : theme.accent, textColor: .white))
        .onHover { hovering = $0 && !isBusy }
    }
}

private struct SecondaryActionButton: View {
    let title: String
    let theme: LoginTheme
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(hovering ? theme.ink1 : theme.ink2)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 9)
        }
        .buttonStyle(PressScaleButtonStyle(fill: hovering ? theme.elevated : theme.fieldBackground, textColor: hovering ? theme.ink1 : theme.ink2))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(theme.hairline, lineWidth: 1)
        )
        .onHover { hovering = $0 }
    }
}

private struct GhostActionButton: View {
    let title: String
    let theme: LoginTheme
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(theme.accent)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(theme.accentSoft)
                )
        }
        .buttonStyle(PressScaleButtonStyle(fill: theme.accentSoft, textColor: theme.accent))
    }
}

/// 按压 0.98 缩放（100ms ease-out，apple-design「反馈落在按下瞬间」）；
/// disabled 态由外部 .disabled() 控制，样式层不重复处理。
private struct PressScaleButtonStyle: ButtonStyle {
    let fill: Color
    let textColor: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(textColor)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(fill)
            )
            .opacity(configuration.isPressed ? 0.92 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
    }
}

// MARK: - 六格验证码输入（AppKit 控件：粘贴分发/退格回清/自动进焦/回车提交）
//
// 对照 LoginView.tsx onCellInput/onCellKeyDown/onCellPaste 逐条：
// - 单字符输入：取最后一位数字，自动进焦下一格；
// - 多字符（粘贴）：提取数字从第 0 格填起，聚焦 min(count,5)；
// - 空格退格：清上一格并回焦；
// - 回车：提交。
// 用 NSTextField 而非 SwiftUI TextField：粘贴分发与退格回清需要 field editor
// 层的 doCommandBy: 拦截，SwiftUI 封装拿不到这层语义。

private struct OtpCodeFieldView: NSViewRepresentable {
    @Binding var code: String
    var resetToken: Int
    var onSubmit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> OtpCellsRootView {
        let view = OtpCellsRootView()
        context.coordinator.attach(root: view, representable: self)
        return view
    }

    func updateNSView(_ view: OtpCellsRootView, context: Context) {
        context.coordinator.sync(with: self, root: view)
    }

    final class Coordinator: NSObject, NSTextFieldDelegate {
        private weak var root: OtpCellsRootView?
        private var onCodeChange: ((String) -> Void)?
        private var onSubmitHandler: (() -> Void)?
        private var lastResetToken = 0

        func attach(root: OtpCellsRootView, representable: OtpCodeFieldView) {
            self.root = root
            onCodeChange = { value in representable.code = value }
            onSubmitHandler = { representable.onSubmit() }
            root.fields.forEach { $0.delegate = self }
            root.onCodeChange = { [weak self] value in
                self?.onCodeChange?(value)
            }
            root.onSubmit = { [weak self] in
                self?.onSubmitHandler?()
            }
            lastResetToken = representable.resetToken
            root.applyTheme()
            // 进入验证码页即聚焦第一格（Windows LoginView.tsx:86-89 的
            // useEffect(view==='code' → cellRefs[0].focus()) 同款）。makeNSView 时
            // 视图尚未挂到窗口，交给 viewDidMoveToWindow 在入窗后下一拍聚焦。
            root.requestInitialFocus()
        }

        func sync(with representable: OtpCodeFieldView, root: OtpCellsRootView) {
            onCodeChange = { value in representable.code = value }
            onSubmitHandler = { representable.onSubmit() }
            if root.currentCode() != representable.code {
                // 外部清空/填充（错码重置等）
                root.setCells(representable.code)
            }
            if lastResetToken != representable.resetToken {
                lastResetToken = representable.resetToken
                root.resetAndFocusFirst()
            }
            root.applyTheme()
        }

        // MARK: NSTextFieldDelegate

        func controlTextDidChange(_ obj: Notification) {
            guard let root, let field = obj.object as? OtpCellField else { return }
            let digits = field.stringValue.filter { $0.isNumber }
            if digits.count > 1 {
                // 粘贴（多字符）：对照 onCellPaste——从第 0 格填起。
                let text = String(digits.prefix(6))
                root.setCells(text)
                root.focusCell(min(text.count, 5))
            } else {
                let digit = String(digits.suffix(1))
                root.setDigit(digit, at: field.index)
                if !digit.isEmpty, field.index < OtpCellsRootView.cellCount - 1 {
                    root.focusCell(field.index + 1)
                }
            }
        }

        func controlTextDidBeginEditing(_ obj: Notification) {
            guard let root, let field = obj.object as? OtpCellField else { return }
            root.focusedIndex = field.index
            root.applyTheme()
        }

        func controlTextDidEndEditing(_ obj: Notification) {
            guard let root else { return }
            root.focusedIndex = nil
            root.applyTheme()
        }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            guard let root else { return false }
            switch commandSelector {
            case #selector(NSResponder.insertNewline(_:)):
                root.onSubmit?()
                return true
            case #selector(NSResponder.deleteBackward(_:)):
                // 空格上按退格：清上一格并回焦（原型 bindCodeCells 同款）。
                if let field = control as? OtpCellField,
                   field.stringValue.isEmpty,
                   field.index > 0 {
                    root.setDigit("", at: field.index - 1)
                    root.focusCell(field.index - 1)
                    return true
                }
                return false
            default:
                return false
            }
        }
    }
}

/// 六格容器：NSStackView 横排 + 焦点/主题状态。
private final class OtpCellsRootView: NSView {
    static let cellCount = 6
    static let cellWidth: CGFloat = 42
    static let cellHeight: CGFloat = 48
    static let cellSpacing: CGFloat = 8

    var onCodeChange: ((String) -> Void)?
    var onSubmit: (() -> Void)?

    private(set) var fields: [OtpCellField] = []
    private(set) var digits: [String] = Array(repeating: "", count: cellCount)
    var focusedIndex: Int?
    /// 首次入窗后聚焦第 0 格的待办标记（attach 时置位）。
    private var wantsInitialFocus = false

    /// 请求首格聚焦：已在窗口内则下一拍直接聚焦，否则等 viewDidMoveToWindow。
    func requestInitialFocus() {
        wantsInitialFocus = true
        if window != nil {
            performInitialFocusIfNeeded()
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        performInitialFocusIfNeeded()
    }

    private func performInitialFocusIfNeeded() {
        guard wantsInitialFocus, window != nil else { return }
        wantsInitialFocus = false
        DispatchQueue.main.async { [weak self] in
            self?.focusCell(0)
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        let stack = NSStackView(views: (0..<Self.cellCount).map { index in
            let field = OtpCellField()
            field.index = index
            field.setAccessibilityLabel("验证码第 \(index + 1) 位")
            fields.append(field)
            return field
        })
        stack.orientation = .horizontal
        stack.spacing = Self.cellSpacing
        stack.alignment = .centerY
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.topAnchor.constraint(greaterThanOrEqualTo: topAnchor),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor),
        ])
        for field in fields {
            field.widthAnchor.constraint(equalToConstant: Self.cellWidth).isActive = true
            field.heightAnchor.constraint(equalToConstant: Self.cellHeight).isActive = true
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func currentCode() -> String {
        digits.joined()
    }

    /// 设置 idx 格的数字（同步 field 显示）并上报。
    func setDigit(_ digit: String, at index: Int) {
        let clamped = String(digit.filter { $0.isNumber }.suffix(1))
        digits[index] = clamped
        if fields[index].stringValue != clamped {
            fields[index].stringValue = clamped
        }
        onCodeChange?(currentCode())
    }

    /// 整组填充（外部清空 / 粘贴分发）：只取数字前 6 位。
    func setCells(_ text: String) {
        let clean = String(text.filter { $0.isNumber }.prefix(Self.cellCount))
        digits = (0..<Self.cellCount).map { String(clean.map(String.init)[safe: $0] ?? "") }
        for (index, field) in fields.enumerated() {
            let value = digits[index]
            if field.stringValue != value {
                field.stringValue = value
            }
        }
        onCodeChange?(currentCode())
    }

    /// 错码重置：清空 + 聚焦第 0 格（保留重发按钮）。
    func resetAndFocusFirst() {
        setCells("")
        focusCell(0)
    }

    func focusCell(_ index: Int) {
        guard (0..<Self.cellCount).contains(index) else { return }
        window?.makeFirstResponder(fields[index])
        focusedIndex = index
        applyTheme()
    }

    /// 主题（对照 warm-archival / obsidian-sonic 令牌；焦点格描边 accent）。
    func applyTheme() {
        let dark = window?.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let background = dark
            ? NSColor(srgbRed: 0x17 / 255, green: 0x1A / 255, blue: 0x21 / 255, alpha: 1)
            : NSColor.white
        let hairline = dark
            ? NSColor.white.withAlphaComponent(0.14)
            : NSColor(srgbRed: 0x17 / 255, green: 0x16 / 255, blue: 0x14 / 255, alpha: 0.16)
        let accent = dark
            ? NSColor(srgbRed: 0xE2 / 255, green: 0x6D / 255, blue: 0x52 / 255, alpha: 1)
            : NSColor(srgbRed: 0xC8 / 255, green: 0x4B / 255, blue: 0x31 / 255, alpha: 1)
        let ink = dark
            ? NSColor(srgbRed: 0xF4 / 255, green: 0xF2 / 255, blue: 0xED / 255, alpha: 1)
            : NSColor(srgbRed: 0x17 / 255, green: 0x16 / 255, blue: 0x14 / 255, alpha: 1)
        for (index, field) in fields.enumerated() {
            let focused = index == focusedIndex
            field.backgroundColor = background
            field.textColor = digits[index].isEmpty ? ink.withAlphaComponent(0.35) : ink
            field.layer?.cornerRadius = 8
            field.layer?.borderWidth = focused ? 1.5 : 1
            field.layer?.borderColor = (focused ? accent : hairline).cgColor
        }
        needsDisplay = true
    }
}

/// 单格输入框：无边框、层样式、居中数字。
private final class OtpCellField: NSTextField {
    var index: Int = 0

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        isBordered = false
        isBezeled = false
        drawsBackground = true
        backgroundColor = .white
        alignment = .center
        font = .monospacedDigitSystemFont(ofSize: 20, weight: .semibold)
        usesSingleLineMode = true
        focusRingType = .none
        cell?.wraps = false
        cell?.isScrollable = true
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        if result {
            (superview as? OtpCellsRootView)?.focusedIndex = index
            (superview as? OtpCellsRootView)?.applyTheme()
            // 选中已有字符：直接输入即替换（对照原型格子行为）。
            currentEditor()?.selectAll(nil)
        }
        return result
    }

    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        if result {
            (superview as? OtpCellsRootView)?.focusedIndex = nil
            (superview as? OtpCellsRootView)?.applyTheme()
        }
        return result
    }
}

private extension Array where Element == String {
    subscript(safe index: Int) -> String? {
        indices.contains(index) ? self[index] : nil
    }
}

// MARK: - 设置窗「账号」分区（对齐 Windows src/views/AccountSection.tsx:81-254，
// v0.9 分区卡片）。放在本文件：与登录窗同属账号 UI，且 Settings.swift 只做
// 最小接线（标题行 chip + 一行 settingsSection）。样式循设置页既有系统风格。

/// 设置窗「账号」分区导航信号：菜单「账号登录」在已登录时打开设置并定位到
/// 「账号」分区（Windows settings_open_tab("account") 的对应物）。
/// SET-5 新 IA 下消费端改释为「选中账号页签」——SettingsView 订阅 scrollRequestID
/// 切换 activeSection；信号本身仍是「每次请求递增一次」的语义（既有单测覆盖）。
@MainActor
final class SettingsAccountNavigation: ObservableObject {
    @Published private(set) var scrollRequestID = 0

    func requestScrollToAccount() {
        scrollRequestID += 1
    }
}

struct AccountSectionView: View {
    @ObservedObject var serverAuth: ServerAuthClient
    let onOpenLogin: () -> Void

    @State private var loggingOut = false
    /// 登出失败红条（storage_error 时管理器保持登录态，§5.3 / P13）。
    @State private var logoutError: String?
    /// 云端配置手动重拉结果。
    @State private var configMessage: AccountMessage?
    @State private var syncingConfig = false

    private struct AccountMessage: Equatable {
        let text: String
        let ok: Bool
    }

    var body: some View {
        let status = serverAuth.status
        VStack(alignment: .leading, spacing: 12) {
            // 失效状态条：token_invalid / token_reused 清凭据后的落点，持久显示直到重新登录（D8）。
            // Windows acct-notice 是 warn 橙条，与登出失败的红条区分。
            if let notice = authNoticeText(status.notice) {
                messageBar(notice, style: .warn)
            }
            Text(status.loggedIn
                 ? "账号信息与登录状态"
                 : "登录是可选项——翻译、阅读室与复习全部本地可用")
                .font(.footnote)
                .foregroundStyle(.secondary)
            if status.loggedIn, let user = status.user {
                profileRow(user)
                Divider()
                detailRows(user)
                Divider()
                securityRow
            } else {
                signInPanel
            }
        }
    }

    // MARK: 未登录

    private var signInPanel: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "person.crop.circle")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text("未登录")
                    .font(.body.weight(.semibold))
                Text("登录后可使用官方翻译服务、同步云端配置；不登录不影响任何本地功能")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            Button("登 录") { onOpenLogin() }
                .buttonStyle(.borderedProminent)
        }
    }

    // MARK: 已登录

    private func profileRow(_ user: AuthUser) -> some View {
        HStack(alignment: .center, spacing: 12) {
            ZStack {
                Circle().fill(Color.accentColor)
                Text(Self.avatarGlyph(user))
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(.white)
            }
            .frame(width: 36, height: 36)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(Self.displayName(user))
                        .font(.body.weight(.semibold))
                    Text(user.plan)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.accentColor.opacity(0.14)))
                        .foregroundStyle(Color.accentColor)
                }
                Text(user.email)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Spacer()
        }
    }

    private func detailRows(_ user: AuthUser) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("登录信息")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            fieldRow(label: "当前设备", hint: "仅本机登录会话展示（设备名由系统提供）") {
                HStack(spacing: 6) {
                    Text("macOS · 本机")
                    Text("当前")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.green.opacity(0.16)))
                        .foregroundStyle(.green)
                }
                .font(.footnote)
            }
            fieldRow(label: "注册时间", hint: nil) {
                Text(Self.formatDate(user.createdAt))
                    .font(.footnote)
                    .monospacedDigit()
            }
            fieldRow(label: "云端配置", hint: "登录后自动同步；失败可在此手动重拉") {
                Button(syncingConfig ? "同步中…" : "重新拉取") { handleFetchConfig() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(syncingConfig)
            }
            if let configMessage {
                // 云端配置拉取失败在 Windows 是 .msg-bar.err（红），成功是 ok（绿）。
                messageBar(configMessage.text, style: configMessage.ok ? .ok : .error)
            }
        }
    }

    private var securityRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center) {
                Text("退出当前账号后，本地数据（生词本/历史/书架）不受影响")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 12)
                Button(loggingOut ? "登出中…" : "登出") { handleLogout() }
                    .buttonStyle(.bordered)
                    .tint(.red)
                    .disabled(loggingOut)
            }
            if let logoutError {
                // 登出失败红条（验收口径：storage_error 保持登录态 + 红条，Windows .msg-bar.err）。
                messageBar(logoutError, style: .error)
            }
        }
    }

    // MARK: 零件

    private func fieldRow<Control: View>(
        label: String,
        hint: String?,
        @ViewBuilder control: () -> Control
    ) -> some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.footnote.weight(.medium))
                if let hint {
                    Text(hint)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 12)
            control()
        }
    }

    /// 状态条三态（对齐 Windows：.msg-bar.ok 绿 / .msg-bar.err 红（styles.css
    /// --err #dc2626）、acct-notice 橙 warn）——登出失败与云端配置失败是
    /// err 红条，notice 失效提示是 warn 橙条，不再共用一套橙色。
    private enum AccountBarStyle {
        case ok
        case warn
        case error

        var tint: Color {
            switch self {
            case .ok: return .green
            case .warn: return .orange
            case .error: return .red
            }
        }
    }

    private func messageBar(_ text: String, style: AccountBarStyle) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: style == .ok ? "checkmark.circle" : "exclamationmark.triangle")
                .foregroundStyle(style.tint)
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(style.tint.opacity(0.10))
        )
    }

    // MARK: 动作（对齐 AccountSection.tsx handleLogout / handleFetchConfig）

    private func handleLogout() {
        guard !loggingOut else { return }
        loggingOut = true
        logoutError = nil
        Task { @MainActor in
            defer { loggingOut = false }
            do {
                _ = try await serverAuth.logout()
                configMessage = nil
            } catch let error as AuthError {
                // P13：clear 失败 → 管理器保持登录态；这里同样保持已登录 UI + 红条提示。
                logoutError = "登出失败：\(authErrorText(error).text)"
            } catch {
                logoutError = "登出失败：\(authErrorText(.local("unknown", "")).text)"
            }
        }
    }

    private func handleFetchConfig() {
        guard !syncingConfig else { return }
        syncingConfig = true
        configMessage = nil
        Task { @MainActor in
            defer { syncingConfig = false }
            do {
                _ = try await serverAuth.fetchServerConfig()
                configMessage = AccountMessage(text: "云端配置已拉取并保存", ok: true)
            } catch let error as AuthError {
                configMessage = AccountMessage(text: authErrorText(error).text, ok: false)
            } catch {
                configMessage = AccountMessage(text: authErrorText(.local("unknown", "")).text, ok: false)
            }
        }
    }

    // MARK: 展示工具（AccountSection.tsx:55-79 同式）

    /// 昵称优先；无昵称用邮箱 @ 前段；都没有则「未命名用户」。
    static func displayName(_ user: AuthUser) -> String {
        if let nickname = user.nickname?.trimmingCharacters(in: .whitespacesAndNewlines), !nickname.isEmpty {
            return nickname
        }
        let email = user.email.trimmingCharacters(in: .whitespacesAndNewlines)
        if let at = email.firstIndex(of: "@"), at != email.startIndex {
            return String(email[..<at])
        }
        return email.isEmpty ? "未命名用户" : email
    }

    /// 头像圆内的字符：昵称（或邮箱）首字符大写。
    static func avatarGlyph(_ user: AuthUser) -> String {
        let source = (user.nickname?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
            ?? user.email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = source.first else { return "·" }
        return String(first).uppercased()
    }

    /// 注册时间展示（AuthUser.createdAt，ISO → YYYY-MM-DD；解析失败原样）。
    static func formatDate(_ iso: String) -> String {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        guard let date = withFraction.date(from: iso) ?? plain.date(from: iso) else { return iso }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}
