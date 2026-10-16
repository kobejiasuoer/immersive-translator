/**
 * 登录窗口（label=login，420×560）：验证码主流程（自动建号）+ 密码页签。
 * 状态机：邮箱页 → 验证码页（60s 重发倒计时，localStorage 持久化恢复）→ 成功 → 自动关窗。
 * 错误文案唯一出口 authErrorText（设计 §3）；banned 阻断、rate_limited 倒计时禁用不自动重试。
 * 已登录时显示兜底卡片（设计 §6 LoginView 行）。
 * 视觉对齐 prototypes/windows-login-redesign-2026-09-27.html（品牌条带 + 分段控件）。
 */
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { authErrorText, retryAfterSecondsOf } from "../lib/authErrorText";
import {
  authGetStatus,
  authLoginPassword,
  authSendOtp,
  authVerifyOtp,
  settingsOpenTab,
  type AuthStatus,
} from "../lib/tauriBridge";
import { useResendCooldown } from "../lib/useResendCooldown";
import { IconAlert, IconCheck, IconInfo } from "../ui/icons";

type LoginTab = "otp" | "password";
/** 邮箱页/验证码页属于 otp 流；password 为密码页签独立视图。 */
type LoginViewName = "email" | "code" | "password" | "success";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMPTY_CELLS = ["", "", "", "", "", ""];

function validEmail(v: string): boolean {
  return EMAIL_RE.test(v.trim());
}

/** 关闭登录窗（Rust 命令侧兜底之外的前端兜底）。 */
function closeSelf(): Promise<void> {
  return getCurrentWindow().close().catch(() => {
    window.close();
  });
}

export function LoginView() {
  const [tab, setTab] = useState<LoginTab>("otp");
  const [view, setView] = useState<LoginViewName>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [cells, setCells] = useState<string[]>(EMPTY_CELLS);
  /** 提交后邮箱非法时显示红 hint（§8.2 邮箱输入页）。 */
  const [emailHint, setEmailHint] = useState(false);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [banner, setBanner] = useState<{ kind: "err" | "ok"; text: string } | null>(null);
  /** banned 阻断态：禁用提交，仅「返回修改邮箱」可清（§3）。 */
  const [banned, setBanned] = useState(false);
  /** rate_limited 剩余秒（读 retry-after，到 0 自动恢复，不自动重试）。 */
  const [rateUntil, setRateUntil] = useState(0);
  /** 已登录兜底卡片（打开 login 窗时账号已在）。 */
  const [existing, setExisting] = useState<AuthStatus | null>(null);

  const cooldown = useResendCooldown(email.trim());
  const emailRef = useRef<HTMLInputElement | null>(null);
  const pwdRef = useRef<HTMLInputElement | null>(null);
  const cellRefs = useRef<Array<HTMLInputElement | null>>([]);

  const codeValue = cells.join("");

  // 挂载时检查登录态：已登录则显示兜底卡片，不打扰已登录用户重走流程。
  useEffect(() => {
    let active = true;
    void authGetStatus()
      .then((s) => {
        if (active && s.loggedIn) setExisting(s);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // rate_limited 倒计时：每秒 -1，归零停表（§4.5：不自动重试）。
  useEffect(() => {
    if (rateUntil <= 0) return;
    const timer = window.setInterval(() => setRateUntil((r) => (r > 0 ? r - 1 : 0)), 1000);
    return () => window.clearInterval(timer);
  }, [rateUntil > 0]);

  // 进入验证码页聚焦第一格。
  useEffect(() => {
    if (view === "code") cellRefs.current[0]?.focus();
  }, [view]);

  // 登录成功：短暂反馈后自动关窗（§8.2 登录成功态）。
  useEffect(() => {
    if (view !== "success") return;
    const timer = window.setTimeout(() => void closeSelf(), 900);
    return () => window.clearTimeout(timer);
  }, [view === "success"]);

  /** 错误落 UI：banner 文案 + banned 阻断 + rate_limited 秒数。 */
  function applyAuthError(err: unknown): void {
    const m = authErrorText(err);
    setBanner({ kind: "err", text: m.text });
    if (m.code === "banned") {
      // §3：回到邮箱页，禁用提交，仅保留「返回修改邮箱」清错误态。
      setBanned(true);
      setView("email");
    }
    if (m.code === "rate_limited") {
      const secs = retryAfterSecondsOf(err);
      if (secs !== null) setRateUntil(secs);
    }
  }

  async function handleSendOtp(): Promise<void> {
    // D10：关窗重开落回邮箱页时，持久化冷却同样生效（服务端静默不发恒回
    // {ok:true}，不拦会让用户误以为已重发）。
    if (sending || banned || rateUntil > 0 || cooldown.remaining > 0) return;
    const addr = email.trim();
    if (!validEmail(addr)) {
      setEmailHint(true);
      emailRef.current?.focus();
      return;
    }
    setSending(true);
    setBanner(null);
    try {
      await authSendOtp(addr);
      setCells(EMPTY_CELLS);
      setView("code");
      cooldown.start();
    } catch (err) {
      // service_unavailable / network_error：停邮箱页红条，按钮恢复可重试（§3）。
      applyAuthError(err);
    } finally {
      setSending(false);
    }
  }

  async function handleResend(): Promise<void> {
    if (sending || cooldown.remaining > 0) return;
    setSending(true);
    setBanner(null);
    try {
      await authSendOtp(email.trim());
      cooldown.start();
    } catch (err) {
      applyAuthError(err);
    } finally {
      setSending(false);
    }
  }

  async function handleVerify(): Promise<void> {
    if (verifying || rateUntil > 0 || codeValue.length < 6) return;
    setVerifying(true);
    setBanner(null);
    try {
      await authVerifyOtp(email.trim(), codeValue);
      setView("success");
    } catch (err) {
      const m = authErrorText(err);
      setBanner({ kind: "err", text: m.text });
      if (m.code === "otp_invalid") {
        // §3：停验证码页，清空码输入并聚焦，保留重发按钮。
        setCells(EMPTY_CELLS);
        cellRefs.current[0]?.focus();
      } else if (m.code === "banned") {
        setBanned(true);
        setView("email");
      } else if (m.code === "rate_limited") {
        const secs = retryAfterSecondsOf(err);
        if (secs !== null) setRateUntil(secs);
      }
      // storage_error（流程中止）/ network_error（可重试）：停验证码页红条。
    } finally {
      setVerifying(false);
    }
  }

  async function handlePasswordLogin(): Promise<void> {
    if (loggingIn || banned || rateUntil > 0) return;
    const addr = email.trim();
    if (!validEmail(addr)) {
      setBanner({ kind: "err", text: "请输入有效的邮箱地址" });
      return;
    }
    if (!password) return;
    setLoggingIn(true);
    setBanner(null);
    try {
      await authLoginPassword(addr, password);
      setView("success");
    } catch (err) {
      const m = authErrorText(err);
      setBanner({ kind: "err", text: m.text });
      if (m.code === "invalid_credentials") {
        // §3：停密码页签，清空并选中密码框。
        setPassword("");
        pwdRef.current?.focus();
        pwdRef.current?.select();
      } else if (m.code === "banned") {
        setBanned(true);
        setView("email");
      } else if (m.code === "rate_limited") {
        const secs = retryAfterSecondsOf(err);
        if (secs !== null) setRateUntil(secs);
      }
    } finally {
      setLoggingIn(false);
    }
  }

  function switchTab(next: LoginTab): void {
    setTab(next);
    setBanner(null);
    setView(next === "otp" ? "email" : "password");
  }

  /** 「换一个邮箱」：回邮箱页，保留已填邮箱。 */
  function backToEmail(): void {
    setView("email");
    setBanner(null);
  }

  /** banned 阻断态的「返回修改邮箱」：清阻断与错误态，回可编辑（§3）。 */
  function clearBanned(): void {
    setBanned(false);
    setBanner(null);
    emailRef.current?.focus();
  }

  function onEmailKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter") void handleSendOtp();
  }

  function onCellInput(idx: number, raw: string): void {
    const digit = raw.replace(/\D/g, "").slice(-1);
    setCells((prev) => {
      const next = [...prev];
      next[idx] = digit;
      return next;
    });
    if (digit && idx < 5) cellRefs.current[idx + 1]?.focus();
  }

  function onCellKeyDown(idx: number, e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter") {
      void handleVerify();
      return;
    }
    // 空格上按退格：清上一格并回焦（原型 bindCodeCells 同款）。
    if (e.key === "Backspace" && !cells[idx] && idx > 0) {
      e.preventDefault();
      setCells((prev) => {
        const next = [...prev];
        next[idx - 1] = "";
        return next;
      });
      cellRefs.current[idx - 1]?.focus();
    }
  }

  function onCellPaste(e: ClipboardEvent<HTMLInputElement>): void {
    e.preventDefault();
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!text) return;
    setCells(EMPTY_CELLS.map((_, i) => text[i] ?? ""));
    cellRefs.current[Math.min(text.length, 5)]?.focus();
  }

  function onPwdKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter") void handlePasswordLogin();
  }

  const emailInvalid = email.length > 0 && !validEmail(email);
  const sendDisabled =
    sending || banned || rateUntil > 0 || cooldown.remaining > 0 || !validEmail(email);

  return (
    <div className="login-shell">
      <header className="login-band">
        <div className="login-band-row">
          <span className="login-band-logo" aria-hidden>
            译
          </span>
          <h1 className="login-band-title">沉浸翻译</h1>
        </div>
        <p className="login-band-sub">登录后同步生词本、阅读进度与偏好设置</p>
        <span className="login-band-glyph" aria-hidden="true">
          文<em>A</em>
        </span>
      </header>
      <div className="login-body">
        {banner && (
          <div className={`login-banner ${banner.kind}`} role="alert">
            {banner.kind === "ok" ? <IconCheck size={14} /> : <IconAlert size={14} />}
            <span>{banner.text}</span>
          </div>
        )}

        {existing && view !== "success" ? (
          <div className="login-existing">
            <span className="login-existing-icon" aria-hidden>
              ◐
            </span>
            <h4>已登录</h4>
            <p className="login-existing-who">
              {existing.user?.nickname ?? existing.user?.email ?? ""}
            </p>
            <p className="login-existing-hint">账号信息与登出请在「设置 → 账号」管理</p>
            <div className="login-existing-actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  void settingsOpenTab("account");
                  void closeSelf();
                }}
              >
                打开账号设置
              </button>
              <button className="btn btn-secondary" onClick={() => setExisting(null)}>
                使用其他账号登录
              </button>
            </div>
          </div>
        ) : (
          <>
            {view !== "success" && (
              <div className="login-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={tab === "otp"}
                  className={tab === "otp" ? "active" : ""}
                  onClick={() => switchTab("otp")}
                >
                  验证码登录
                </button>
                <button
                  role="tab"
                  aria-selected={tab === "password"}
                  className={tab === "password" ? "active" : ""}
                  onClick={() => switchTab("password")}
                >
                  密码登录
                </button>
              </div>
            )}

            {view === "email" && (
              <div className="login-view">
                <div className="login-field">
                  <label htmlFor="login-email">邮箱地址</label>
                  <input
                    id="login-email"
                    ref={emailRef}
                    type="email"
                    className={`input${emailHint && emailInvalid ? " invalid" : ""}`}
                    placeholder="you@example.com"
                    autoComplete="off"
                    spellCheck={false}
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (validEmail(e.target.value)) setEmailHint(false);
                    }}
                    onKeyDown={onEmailKeyDown}
                    disabled={banned}
                  />
                  {emailHint && emailInvalid && <span className="login-field-hint err">请输入有效的邮箱地址</span>}
                </div>
                <button
                  className="btn btn-primary btn-block"
                  disabled={sendDisabled}
                  onClick={() => void handleSendOtp()}
                >
                  {rateUntil > 0
                    ? `请 ${rateUntil} 秒后再试`
                    : cooldown.remaining > 0
                      ? `获取验证码（${cooldown.remaining}s）`
                      : sending
                        ? "发送中…"
                        : "获取验证码"}
                </button>
                <div className="login-foot">
                  <span className="login-foot-note">
                    <IconInfo size={13} />
                    未注册的邮箱将在验证后自动创建账号
                  </span>
                  {banned && (
                    <button type="button" className="linklike" onClick={clearBanned}>
                      返回修改邮箱
                    </button>
                  )}
                </div>
              </div>
            )}

            {view === "code" && (
              <div className="login-view">
                <p className="code-target">
                  验证码已发送至 <b>{email.trim()}</b>
                </p>
                <div className="code-cells">
                  {cells.map((c, i) => (
                    <input
                      key={i}
                      ref={(el) => {
                        cellRefs.current[i] = el;
                      }}
                      inputMode="numeric"
                      maxLength={1}
                      autoComplete="one-time-code"
                      aria-label={`验证码第 ${i + 1} 位`}
                      value={c}
                      className={c ? "filled" : ""}
                      onChange={(e) => onCellInput(i, e.target.value)}
                      onKeyDown={(e) => onCellKeyDown(i, e)}
                      onPaste={onCellPaste}
                    />
                  ))}
                </div>
                <div className="code-gap" />
                <button
                  className="btn btn-primary btn-block"
                  disabled={verifying || rateUntil > 0 || codeValue.length < 6}
                  onClick={() => void handleVerify()}
                >
                  {verifying ? "登录中…" : "登 录"}
                </button>
                <div className="login-foot">
                  <button
                    type="button"
                    className="btn btn-ghost btn-resend"
                    disabled={sending || cooldown.remaining > 0}
                    onClick={() => void handleResend()}
                  >
                    {cooldown.remaining > 0 ? `重新发送（${cooldown.remaining}s）` : "重新发送"}
                  </button>
                  <span className="login-foot-sep">·</span>
                  <button type="button" className="linklike" onClick={backToEmail}>
                    换一个邮箱
                  </button>
                </div>
              </div>
            )}

            {view === "password" && (
              <div className="login-view">
                <div className="login-field">
                  <label htmlFor="login-email2">邮箱地址</label>
                  <input
                    id="login-email2"
                    type="email"
                    className="input"
                    placeholder="you@example.com"
                    autoComplete="off"
                    spellCheck={false}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={banned}
                  />
                </div>
                <div className="login-field">
                  <label htmlFor="login-pwd">密码</label>
                  <input
                    id="login-pwd"
                    ref={pwdRef}
                    type="password"
                    className="input"
                    placeholder="输入密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={onPwdKeyDown}
                    disabled={banned}
                  />
                  <span className="login-field-hint">从未设置过密码的账号，请改用验证码登录</span>
                </div>
                <div className="code-gap" />
                <button
                  className="btn btn-primary btn-block"
                  disabled={
                    loggingIn || banned || rateUntil > 0 || !validEmail(email) || !password
                  }
                  onClick={() => void handlePasswordLogin()}
                >
                  {rateUntil > 0 ? `请 ${rateUntil} 秒后再试` : loggingIn ? "登录中…" : "登 录"}
                </button>
                <div className="login-foot">
                  <span className="login-foot-note">忘记密码？可在验证码登录后随时设置密码（后续迭代）</span>
                </div>
              </div>
            )}

            {view === "success" && (
              <div className="success-pane">
                <span className="success-big" aria-hidden>
                  <IconCheck size={26} />
                </span>
                <h4>登录成功</h4>
                <p>窗口即将自动关闭，账号信息可在「设置 → 账号」中查看</p>
                <div className="success-actions">
                  <button
                    className="btn btn-secondary"
                    onClick={() => {
                      void settingsOpenTab("account");
                      void closeSelf();
                    }}
                  >
                    进入账号管理
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
