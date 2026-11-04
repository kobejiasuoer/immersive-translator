import Foundation

// ---------------------------------------------------------------------------
// 兑换码核销传输与文案映射（语音云契约 §三.10 / 决策 5）：POST /v1/redeem。
// 对齐 Windows src-tauri/src/redeem.rs + src/views/RedeemCard.tsx。
//
// - 认证零代码：传输经 ServerAuthClient 的 withAuth 管线——base URL 解析、
//   Bearer 会话令牌附带、401 token_expired 单飞刷新后重放一次，与云同步
//   （SyncEngine）同一条管线；令牌不离开进程（红线 D4/D5 的 Mac 等效物）。
// - 非 2xx 是协议数据不是错误（redeem.rs 同口径）：`redeem_code_not_found /
//   expired / used` 等错误信封原样带回，文案映射在 redeemErrorText；
//   只有网络/致命鉴权错误才 throw。未登录时 withAuth 零网络即 unauthorized，
//   调用方落「兑换失败，请稍后再试」兜底（账号页只在已登录分支挂载本入口）。
// ---------------------------------------------------------------------------

/// 服务端 AppError 信封 `{error:{code,…}}` 的宽松解析；非 JSON/malformed → nil。
func redeemErrorCodeOf(_ response: AuthHttpResponse) -> String? {
    guard let data = response.body.data(using: .utf8),
          let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let error = parsed["error"] as? [String: Any],
          let code = error["code"] as? String, !code.isEmpty else {
        // 非 JSON（代理页/网关文本等）：按未知码落兜底文案
        return nil
    }
    return code
}

/// 兑换错误码 → 用户文案（契约 §三.10：仅三个业务码有专属文案，其余与
/// 网络/未登录/参数不规范一律落兜底；**绝不透传服务端 message**）。
func redeemErrorText(_ response: AuthHttpResponse) -> String {
    switch redeemErrorCodeOf(response) {
    case "redeem_code_not_found":
        return "兑换码不存在"
    case "redeem_code_expired":
        return "兑换码已过期"
    case "redeem_code_used":
        return "兑换码已被使用"
    default:
        return "兑换失败，请稍后再试"
    }
}

// ---------------------------------------------------------------------------
// 提交状态机（Windows RedeemCard.tsx:50-116；拆成可单测的 ObservableObject）
// ---------------------------------------------------------------------------

/// 兑换提交相位（message 只在 success / error 两相有值）。
enum RedeemPhase: Equatable {
    case idle
    case submitting
    case success
    case error
}

/// 兑换码提交状态机：`idle → submitting → success | error`——submitting 全控件
/// 禁用，success 清空输入允许连兑，error 保留输入可改后重试；trim 后的码才
/// 上送；reject 只可能是网络/致命鉴权（AuthError），统一兜底文案。
@MainActor
final class RedeemModel: ObservableObject {
    @Published var code = ""
    @Published private(set) var phase: RedeemPhase = .idle
    @Published private(set) var message: String?

    /// 传输通道（生产 = ServerAuthClient.redeem；单测注入假通道）。
    private let redeem: (String) async throws -> AuthHttpResponse

    init(redeem: @escaping (String) async throws -> AuthHttpResponse) {
        self.redeem = redeem
    }

    var submitting: Bool { phase == .submitting }

    var canSubmit: Bool {
        !submitting && !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func handleSubmit() {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !submitting, !trimmed.isEmpty else { return }
        phase = .submitting
        message = nil
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let response = try await self.redeem(trimmed)
                if (200..<300).contains(response.status) {
                    self.phase = .success
                    self.message = "兑换成功，额度已到账"
                    self.code = ""
                } else {
                    self.phase = .error
                    self.message = redeemErrorText(response)
                }
            } catch {
                // reject 只可能是网络/致命鉴权（AuthError）：统一兜底文案（契约 §二 通用）。
                self.phase = .error
                self.message = "兑换失败，请稍后再试"
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 口语页通知分类（Windows src/core/speakUi.ts friendlyNotice 的 redeem 档）
// ---------------------------------------------------------------------------

enum SpeakNoticeKind: Equatable {
    case mic
    case credential
    /// 沉浸云额度用尽（§二 quota_exceeded，含路由守卫的额度 hint 与
    /// voiceErrorDisplayText 拼好的重置时间）→「兑换更多额度」动作位。
    case redeem
    case network
    case other
}

struct SpeakFriendlyNotice: Equatable {
    let kind: SpeakNoticeKind
    /// 给用户看的一句话（redeem 档 message 原样不改写——带重置时间或兑换
    /// 指路的两种形态都命中）。
    let message: String
}

/// 把本轮失败的原始文案归类为可行动提示（Windows 1:1 只移植本域需要的
/// redeem 档：文案含「额度已用完」→ redeem，其余归 other 原样展示）。
func speakFriendlyNotice(_ raw: String) -> SpeakFriendlyNotice {
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.contains("额度已用完") {
        return SpeakFriendlyNotice(kind: .redeem, message: text)
    }
    return SpeakFriendlyNotice(kind: .other, message: text)
}
