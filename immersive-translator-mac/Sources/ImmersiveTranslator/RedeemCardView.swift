import SwiftUI

/// 语音页「兑换更多额度」的聚焦信号（Windows Settings.openAccountRedeem 80ms 回调
/// 里 `card.focus()` 的对应物）：SettingsView 在同一 80ms 回调里 scrollTo 后递增，
/// RedeemCardView 观察到变化即把键盘焦点移到卡上。走 Environment 而不穿参，
/// 是因为卡挂在 AccountSectionView 之下两层，且登录窗等其他宿主无此信号（缺省 0 不动）。
struct RedeemFocusTickKey: EnvironmentKey {
    static let defaultValue = 0
}

extension EnvironmentValues {
    var redeemFocusTick: Int {
        get { self[RedeemFocusTickKey.self] }
        set { self[RedeemFocusTickKey.self] = newValue }
    }
}

/// 账号页兑换码卡片（语音云契约 §三.10 / 决策 5）：POST /v1/redeem 核销后
/// 增量额度入 quota_grants。语音页配额耗尽的「兑换更多额度」按钮切到账号
/// 分区后按锚点 "account-redeem" 滚动/聚焦到本卡（Windows 外层容器
/// id="account-redeem"、tabIndex={-1} 的对应物——SwiftUI 以 id + 可聚焦 +
/// FocusState 实现：scrollTo 定位、redeemFocusTick 驱动取焦）。
///
/// 提交状态机 idle → submitting → success | error 在 RedeemModel（可单测）：
/// submitting 全控件禁用，success 清空输入允许连兑，error 保留输入可改后
/// 重试；Return 键等效提交（canSubmit 时）。
struct RedeemCardView: View {
    @StateObject private var model: RedeemModel
    @Environment(\.redeemFocusTick) private var redeemFocusTick
    /// 卡容器键盘焦点（Windows `card.focus()` 落点；tabIndex=-1 语义 = 可编程聚焦）。
    @FocusState private var cardFocused: Bool

    /// - Parameter redeem: 传输通道（生产 = ServerAuthClient.redeem；预览/测试注入）。
    init(redeem: @escaping (String) async throws -> AuthHttpResponse) {
        _model = StateObject(wrappedValue: RedeemModel(redeem: redeem))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("兑换码")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            fieldRow
            if let message = model.message {
                messageBar(message, ok: model.phase == .success)
            }
        }
        // 语音页「兑换更多额度」的跳转锚点（SettingsView ScrollViewReader 滚动/聚焦）。
        .id("account-redeem")
        .accessibilityIdentifier("account-redeem")
        .focusable()
        .focused($cardFocused)
        // 与 scrollTo 同一 80ms 回调触发（Settings.swift）：定位 + 取焦同拍。
        .onChange(of: redeemFocusTick) { _ in
            cardFocused = true
        }
    }

    private var fieldRow: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text("兑换额度")
                    .font(.footnote.weight(.medium))
                Text("输入兑换码补足本月额度（形如 XXXX-XXXX-XXXX-XXXX）")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            TextField("请输入兑换码", text: $model.code)
                .textFieldStyle(.roundedBorder)
                .frame(width: 210)
                .font(.system(.footnote, design: .monospaced))
                .disabled(model.submitting)
                // Return 键等效提交（Windows onKeyDown Enter 分支）。
                .onSubmit {
                    if model.canSubmit {
                        model.handleSubmit()
                    }
                }
            Button(model.submitting ? "兑换中…" : "兑换") {
                model.handleSubmit()
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(!model.canSubmit)
        }
    }

    /// 状态条（对齐账号分区 messageBar：成功 checkmark 绿 / 失败叹号红）。
    private func messageBar(_ text: String, ok: Bool) -> some View {
        let tint: Color = ok ? .green : .red
        return HStack(alignment: .top, spacing: 6) {
            Image(systemName: ok ? "checkmark.circle" : "exclamationmark.triangle")
                .foregroundStyle(tint)
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
                .fill(tint.opacity(0.10))
        )
    }
}
