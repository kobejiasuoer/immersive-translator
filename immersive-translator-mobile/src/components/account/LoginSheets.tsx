/**
 * 邮箱验证码帮助与登录。忘记密码时走真实验证码登录，不展示没有服务端支持的改密表单。
 */
import { useEffect, useState } from "react";
import { SheetShell } from "./SheetShell";
import { login, requestOtp } from "../../services/cloud";
import { Icon } from "../../ui/icons";

const OTP_COOLDOWN_MS = 30000;

export function OtpHelpSheet({ onSwitchToPassword, onClose }: { onSwitchToPassword?: () => void; onClose: () => void }) {
  return <SheetShell label="没有收到验证码" title="没有收到验证码？" onClose={onClose}>
    <div className="v2-guide-lines">
      <p><b>1</b> 确认邮箱没有输错。</p>
      <p><b>2</b> 请查看垃圾邮件，并检查邮箱是否已满。</p>
      <p><b>3</b> 等待约 30 秒，再重新获取。</p>
    </div>
    <button className="btn" onClick={onClose}>返回检查账号</button>
    {onSwitchToPassword && <button className="tlink ob-full-link" onClick={() => { onSwitchToPassword(); onClose(); }}>改用密码登录</button>}
  </SheetShell>;
}

export function CodeLoginSheet({ email, onClose, onVerified }: { email: string; onClose: () => void; onVerified?: () => void }) {
  const [account, setAccount] = useState(email);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [sent, setSent] = useState(false);
  const [cooldownAt, setCooldownAt] = useState(0), [left, setLeft] = useState(0);
  const [help, setHelp] = useState(false);
  /* OTP 冷却 30s 逐秒显示（与 LoginHost 同口径）：到点自动清零并停表 */
  useEffect(() => {
    if (!cooldownAt) { setLeft(0); return; }
    const remaining = () => Math.max(0, Math.ceil((cooldownAt - Date.now()) / 1000));
    setLeft(remaining());
    const interval = setInterval(() => { const n = remaining(); setLeft(n); if (n <= 0) clearInterval(interval); }, 1000);
    return () => clearInterval(interval);
  }, [cooldownAt]);
  async function submit() {
    if (!sent) { setError("请先向这个账号获取验证码。"); return; }
    if (!/^\d{6}$/.test(code)) { setError("请输入完整的 6 位验证码。"); return; }
    setBusy(true); setError("");
    try { await login(account, code, "otp"); onVerified?.(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function send() {
    setBusy(true); setError("");
    try { await requestOtp(account); setSent(true); setCooldownAt(Date.now() + OTP_COOLDOWN_MS); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }
  return <SheetShell label="验证码登录" title="忘记密码？用验证码登录" sub="验证邮箱后即可登录，无需输入密码。" inert={help} onClose={onClose}>
    <form className="v2-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <div className="ob-field">
        <div className="ob-field-row"><label htmlFor="reset-account">邮箱</label></div>
        <input id="reset-account" className="input" type="email" autoComplete="email" required value={account} onChange={e => { setAccount(e.target.value); setSent(false); setCode(""); setError(""); }} placeholder="name@example.com" />
      </div>
      <div className="ob-field">
        <div className="ob-field-row">
          <label htmlFor="reset-code">验证码</label>
          <span className="ob-hint">{sent ? `请查看 ${account}` : "6 位数字"}</span>
        </div>
        <div className="ob-code-row">
          <input id="reset-code" className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value)} placeholder="输入验证码" />
          <button type="button" className="btn-ghost" disabled={busy || left > 0 || !account.trim()} onClick={() => void send()}>{left > 0 ? `${left} 秒后重发` : sent ? "重新获取" : "获取验证码"}</button>
        </div>
        <button type="button" className="tlink ob-code-help" onClick={() => setHelp(true)}>收不到验证码？</button>
      </div>
      {error && <p role="alert" className="v2-form-error"><Icon name="info" size={14} />{error}</p>}
      <button className="btn" disabled={busy}>{busy ? "正在处理…" : "验证并登录"}</button>
    </form>
    <button type="button" className="tlink ob-full-link" onClick={onClose}>返回登录</button>
    {help && <OtpHelpSheet onClose={() => setHelp(false)} />}
  </SheetShell>;
}
