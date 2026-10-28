/**
 * 账号页兑换码卡片（语音云契约 §三.10 / 决策 5）：POST /v1/redeem 核销后
 * 增量额度入 quota_grants。语音页配额耗尽的「兑换更多额度」按钮切到账号 tab
 * 后按外层容器 id="account-redeem" 聚焦/滚动到本卡。
 *
 * - 传输经 tauriBridge.redeemCode（Rust with_auth 附带 Bearer 会话令牌，
 *   前端零认证代码）；非 2xx 是协议数据，code → 文案映射见 redeemErrorText。
 * - 提交状态机 idle → submitting → success | error：submitting 全控件禁用，
 *   success 清空输入允许连兑，error 保留输入可改后重试。
 */
import { useState } from "react";
import { redeemCode, type SyncHttpText } from "../lib/tauriBridge";
import { IconAlert, IconCheck } from "../ui/icons";

/** 兑换提交相位（message 只在 success / error 两相有值）。 */
export type RedeemPhase = "idle" | "submitting" | "success" | "error";

/** 服务端 AppError 信封 `{error:{code,…}}` 的宽松解析；非 JSON/malformed → null。 */
export function redeemErrorCodeOf(resp: SyncHttpText): string | null {
  try {
    const parsed: unknown = JSON.parse(resp.body);
    if (parsed !== null && typeof parsed === "object") {
      const error = (parsed as { error?: unknown }).error;
      if (error !== null && typeof error === "object") {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string" && code !== "") return code;
      }
    }
  } catch {
    /* 非 JSON（代理页/网关文本等）：按未知码落兜底文案 */
  }
  return null;
}

/** 兑换错误码 → 用户文案（契约 §三.10：仅三个业务码有专属文案，其余与
 *  网络/未登录/参数不规范一律落兜底；绝不透传服务端 message）。 */
export function redeemErrorText(resp: SyncHttpText): string {
  switch (redeemErrorCodeOf(resp)) {
    case "redeem_code_not_found":
      return "兑换码不存在";
    case "redeem_code_expired":
      return "兑换码已过期";
    case "redeem_code_used":
      return "兑换码已被使用";
    default:
      return "兑换失败，请稍后再试";
  }
}

export function RedeemCard() {
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<RedeemPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const submitting = phase === "submitting";
  const canSubmit = !submitting && code.trim() !== "";

  async function handleSubmit(): Promise<void> {
    const trimmed = code.trim();
    if (submitting || trimmed === "") return;
    setPhase("submitting");
    setMessage(null);
    try {
      const resp = await redeemCode(trimmed);
      if (resp.status >= 200 && resp.status < 300) {
        setPhase("success");
        setMessage("兑换成功，额度已到账");
        setCode("");
      } else {
        setPhase("error");
        setMessage(redeemErrorText(resp));
      }
    } catch {
      // reject 只可能是网络/致命鉴权（AuthError）：统一兜底文案（契约 §二 通用）。
      setPhase("error");
      setMessage("兑换失败，请稍后再试");
    }
  }

  return (
    <section className="group-card acct-redeem-panel" id="account-redeem" tabIndex={-1}>
      <div className="acct-card-title">兑换码</div>
      <div className="field-row">
        <div className="field-text">
          <span className="field-label-v2">兑换额度</span>
          <span className="field-hint">输入兑换码补足本月额度（形如 XXXX-XXXX-XXXX-XXXX）</span>
        </div>
        <div className="field-ctrl">
          <input
            className="input mono redeem-input"
            value={code}
            placeholder="请输入兑换码"
            disabled={submitting}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) void handleSubmit();
            }}
          />
          <button
            className="btn btn-primary btn-sm"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
          >
            {submitting ? "兑换中…" : "兑换"}
          </button>
        </div>
      </div>
      {message !== null && (
        <div className={`msg-bar ${phase === "success" ? "ok" : "err"}`} role="status">
          {phase === "success" ? <IconCheck size={14} /> : <IconAlert size={14} />}
          {message}
        </div>
      )}
    </section>
  );
}
