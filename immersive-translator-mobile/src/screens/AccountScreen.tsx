/**
 * 邮箱登录、资料认领与「账号与设置」面板。
 * 登录和新账号引导共用推入页，学习偏好在账号的子抽屉中调整。
 * 同步状态来自真实同步服务，忘记密码时使用验证码登录。
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { syncNow, useSyncStatus } from "../services/sync";
import { actions, getState, switchProfile, useApp } from "../store";
import { cancelLogin, completeLogin, ensureAccount, useLoginIntent } from "../services/authGate";
import { CloudError, loadCloudConfig, login, logout, requestOtp, useCloud } from "../services/cloud";
import { useNav } from "../ui/nav";
import { Icon } from "../ui/icons";
import { openGoal, useGoalSource } from "../components/account/goalGate";
import { closeAccount, useAccountOpen } from "../components/account/accountGate";
import { OtpHelpSheet, CodeLoginSheet } from "../components/account/LoginSheets";
import { PrivacySheet, ServiceSheet } from "../components/account/PolicySheets";
import { SyncRulesSheet } from "../components/account/SyncRulesSheet";
import { SignOutSheet } from "../components/account/SignOutSheet";
import { SheetShell } from "../components/account/SheetShell";
import { SettingsSheet } from "../components/reading/SettingsSheet";
import { VoiceSettingsSheet } from "../components/speaking/VoiceSettingsSheet";

const OTP_COOLDOWN_MS = 30000;

/**
 * 认证失败 → 错误条规范文案（对照原型 v2SendCode html:1949-1950、v2VerifyOtp html:1969、
 * ACT['do-login'] html:2173），错误条不透出原始异常（如浏览器「TypeError: Failed to fetch」）：
 * · 连接不到服务——浏览器 fetch 失败抛 TypeError（离线 / 跨域拦截 / 断网），原生网络层失败为
 *   CloudError status 0（services/cloud.ts httpRequest）——按原型离线分支给文案；
 * · 服务端拒绝密码：/v1/auth/login 返回 401 invalid_credentials（实测「邮箱或密码不正确」）→
 *   原型「密码不正确。可以重试，或改用验证码登录。」；网络失败不冒充密码错误；
 * · 其余服务端错误（验证码错误或过期、限流等）保留服务端中文 message——真实原因。
 */
function authErrorCopy(error: unknown, action: "send" | "password" | "otp"): string {
  const unreachable = error instanceof TypeError || (error instanceof CloudError && error.status === 0);
  if (unreachable) return action === "send" ? "当前无法连接。记录仍保存在本机，你可以先继续体验。"
    : action === "password" ? "当前无法验证，请联网后重试。" : "当前无法验证，请联网后重试。你的输入已保留。";
  if (action === "password" && error instanceof CloudError && (error.status === 401 || error.code === "invalid_credentials")) return "密码不正确。可以重试，或改用验证码登录。";
  return error instanceof Error ? error.message : String(error);
}

export function LoginHost() {
  const intent = useLoginIntent();
  const [email, setEmail] = useState(""), [credential, setCredential] = useState("");
  const [mode, setMode] = useState<"otp" | "password">("otp");
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [sent, setSent] = useState(false), [claim, setClaim] = useState(false);
  const [cooldownAt, setCooldownAt] = useState(0), [left, setLeft] = useState(0);
  const [entered, setEntered] = useState(false);
  const [help, setHelp] = useState(false), [reset, setReset] = useState(false), [policy, setPolicy] = useState<"privacy" | "service" | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!intent) { setEntered(false); return; }
    const previous = document.activeElement as HTMLElement | null;
    const timer = setTimeout(() => {
      const title = panel.current?.querySelector<HTMLElement>(".nt h1"); /* 推入页对位 App U-17：聚焦页标题 */
      if (title) { title.tabIndex = -1; title.focus({ preventScroll: true }); }
      else panel.current?.querySelector<HTMLElement>("input,button")?.focus();
    }, 0);
    return () => { clearTimeout(timer); previous?.focus({ preventScroll: true }); };
  }, [intent]);
  /* 推入页入场（340ms translateX），认领态抽屉无此动画 */
  useEffect(() => {
    if (!intent || claim) return;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
    return () => cancelAnimationFrame(raf);
  }, [intent, claim]);
  /* OTP 冷却 30s 逐秒显示：到点自动清零并停表 */
  useEffect(() => {
    if (!cooldownAt) { setLeft(0); return; }
    const remaining = () => Math.max(0, Math.ceil((cooldownAt - Date.now()) / 1000));
    setLeft(remaining());
    const timer = setInterval(() => { const next = remaining(); setLeft(next); if (next <= 0) clearInterval(timer); }, 1000);
    return () => clearInterval(timer);
  }, [cooldownAt]);
  if (!intent) return null;
  const state = getState();
  const kind = intent.kind;
  /* 原型 VIEWS.login 为统一推入页（relay/new/upgrade 同构）；认领态（claim，无原型对应）保留抽屉 */
  const pushMode = !claim;
  async function escape() {
    setBusy(true); setError("");
    try { await cancelLogin(); setClaim(false); setCredential(""); } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  }
  async function submit() {
    /* 提交前本地校验（对照原型 v2VerifyOtp 前置口径）：验证码模式下未向该账号获取过验证码，
       直接给表单内错误条，不发网络请求 */
    if (mode === "otp" && !sent) { setError("请先向这个账号获取验证码。"); return; }
    setError(""); setBusy(true);
    try { await login(email, credential, mode); setClaim(true); } catch (e) { setError(authErrorCopy(e, mode === "password" ? "password" : "otp")); } finally { setBusy(false); }
  }
  async function finish(bring: boolean) {
    const completingKind = kind;
    setBusy(true); setError("");
    try {
      await completeLogin(bring); setClaim(false); setCredential(""); void loadCloudConfig().catch(() => undefined);
      if (completingKind === "new") openGoal("login"); /* 新账号登录后推入学习方向页 */
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  const title = claim ? "把这些积累，带到账号里？" : kind === "relay" ? "登录，接续电脑进度" : kind === "new" ? "登录或创建账号" : "保存你的学习记录";
  /* 引言按原型 html:1995：upgrade 用 star 行展示本机已有记录（不带 ensureAccount 的 reason 句），
     relay/new 保留来源说明句 */
  const message = kind === "relay"
    ? intent.reason || "使用电脑端的同一个账号。确认登录后再读取学习记录。"
    : kind === "new"
      ? intent.reason || "手机可以独立开始，账号帮助你在不同设备接着学。"
      : `本机已有 ${state.vocab.length} 条收藏和 ${state.tasks.length} 次口语记录，登录后仍会保留。`;
  function trap(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') || [])];
    if (!items.length) return;
    if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1)?.focus(); }
    else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0]?.focus(); }
  }
  /* 登录方式切换后清空当前凭证与错误。 */
  const form = <form className="ob-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <div className="learning-seg soft ob-auth-tabs">
      <button type="button" className={mode === "otp" ? "on" : ""} onClick={() => { setMode("otp"); setCredential(""); setShowPwd(false); setError(""); }}>验证码</button>
      <button type="button" className={mode === "password" ? "on" : ""} onClick={() => { setMode("password"); setCredential(""); setError(""); }}>密码</button>
    </div>
    <div className="ob-field">
      <div className="ob-field-row"><label htmlFor="login-account">邮箱</label></div>
      <input id="login-account" className="input" type="email" autoComplete="email" required value={email} onChange={e => { setEmail(e.target.value); setSent(false); setCredential(""); setError(""); }} placeholder="name@example.com" />
    </div>
    <div className="ob-field">
      <div className="ob-field-row">
        <label htmlFor="login-cred">{mode === "otp" ? "验证码" : "密码"}</label>
        {mode === "otp"
          ? <span className="ob-hint">{sent ? `请查看 ${email}` : "6 位数字"}</span>
          : <button type="button" className="tlink" onClick={() => setReset(true)}>忘记密码？</button>}
      </div>
      {mode === "otp" ? <div className="ob-code-row">
        <input id="login-cred" className="input" required inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={credential} onChange={e => setCredential(e.target.value)} placeholder="输入验证码" />
        <button type="button" className="btn-ghost" disabled={busy || left > 0} onClick={async () => { setBusy(true); setError(""); try { await requestOtp(email); setSent(true); setCooldownAt(Date.now() + OTP_COOLDOWN_MS); } catch (e) { setError(authErrorCopy(e, "send")); } finally { setBusy(false); } }}>{left > 0 ? `${left} 秒后重发` : sent ? "重新获取" : "获取验证码"}</button>
      </div>
      : <span className="pwd-wrap"><input id="login-cred" className="input" required type={showPwd ? "text" : "password"} autoComplete="current-password" value={credential} onChange={e => setCredential(e.target.value)} placeholder="输入登录密码" />
        <button type="button" className="pwd-eye" aria-label={showPwd ? "隐藏密码" : "显示密码"} onClick={e => { e.preventDefault(); setShowPwd(v => !v); }}><Icon name={showPwd ? "eyeoff" : "eye"} size={19} /></button></span>}
      {mode === "otp" && <button type="button" className="tlink ob-code-help" onClick={() => setHelp(true)}>收不到验证码？</button>}
    </div>
    {error && <p role="alert" className="v2-form-error"><Icon name="info" size={14} />{error}</p>}
    <button className="btn" disabled={busy}>{busy ? "正在处理…" : kind === "new" ? "登录 / 创建账号" : kind === "relay" ? "登录并接续" : "登录并保存记录"}</button>
  </form>;
  const legal = <div className="ob-legal ob-login-legal">
    <p>继续登录表示同意</p>
    <button type="button" className="tlink" onClick={() => setPolicy("service")}>服务协议</button>
    <span>和</span>
    <button type="button" className="tlink" onClick={() => setPolicy("privacy")}>隐私说明</button>
  </div>;
  const sheets = <>
    {help && <OtpHelpSheet onSwitchToPassword={() => { setMode("password"); setCredential(""); setError(""); }} onClose={() => setHelp(false)} />}
    {reset && <CodeLoginSheet email={email} onClose={() => setReset(false)} onVerified={() => { setClaim(true); setCredential(""); }} />}
    {policy === "privacy" && <PrivacySheet onClose={() => setPolicy(null)} />}
    {policy === "service" && <ServiceSheet onClose={() => setPolicy(null)} />}
  </>;
  if (pushMode) return createPortal(<>
    {/* 挂 body（createPortal）：.app（position:fixed）自身是 stacking context，留在 .app 内的
        任何 z-index 都盖不过 body 层的账号抽屉（SheetShell z-118）——登录推入页必须与抽屉同层
        竞争。zIndex 126：盖过首启 Onboarding/push 根页（.push z-40，于 .app 内）与账号抽屉
        （118）；ResetPassword/OtpHelp/协议抽屉（SheetShell z-130）在其上 */}
    <div className={`push${entered ? " in" : ""}`} data-view="login" role="dialog" aria-modal="true" aria-label="登录" ref={panel} style={{ zIndex: 126 }} inert={(help || reset || !!policy) || undefined} onKeyDown={trap}>
      <header className="learning-head nhead">
        <button className="tlink" aria-label="返回" disabled={busy} onClick={() => void escape()}><Icon name="left" size={20} /></button>
        <div className="nt"><h1>{title}</h1><small>学习记录由你决定在哪里保存</small></div>
        <span />
      </header>
      <main className="ob-page-body ob-auth-body">
        <div className="ob-auth-intro"><Icon name={kind === "relay" ? "sync" : kind === "new" ? "lock" : "star"} size={18} /><p>{message}</p></div>
        <div className="learning-card ob-auth-card">{form}</div>
        {legal}
        {/* 原型 continue-without-login（html:1997）：upgrade 意图为「继续本机学习，稍后登录」，
            其余意图为「先不登录，体验第一篇」 */}
        <button type="button" className="tlink ob-full-link" disabled={busy} onClick={() => void escape()}>{kind ? "先不登录，体验第一篇" : "继续本机学习，稍后登录"}</button>
      </main>
    </div>
    {sheets}
  </>, document.body);
  /* 认领态（claim）：登录成功后选择带入哪些记录——无原型对应，保留底部抽屉；
     同样挂 body：zIndex 121 盖过账号抽屉（118），低于 SheetShell 子抽屉（130） */
  return createPortal(<>
    <div className="account-overlay" style={{ zIndex: 121 }} role="dialog" aria-modal="true" aria-label="邮箱登录"><div className="account-panel" ref={panel} inert={(help || reset || !!policy) || undefined} onKeyDown={trap}>
      <button className="tlink" disabled={busy} onClick={() => void escape()}>先继续本地体验</button>
      <h1>{title}</h1>
      <div className="learning-card">{state.vocab.length} 条生词 · {state.notes.length} 条笔记 · {state.tasks.length} 次练习</div>
      <button className="btn" disabled={busy} onClick={() => void finish(true)}>带入这些记录并继续</button>
      <button className="btn-ghost" disabled={busy} onClick={() => void finish(false)}>暂不带入全部记录</button>
      <p className="meta">暂不带入时，只复制当前任务及原文以继续本次操作；其他资料仍留在游客空间。</p>
      {error && <p role="alert" className="v2-form-error"><Icon name="info" size={14} />{error}</p>}
      {legal}
    </div></div>
    {sheets}
  </>, document.body);
}

/* 连接态 → 状态卡文案（对照原型 v2SyncText html:2020-2026，状态取自 services/sync 真实相位） */
function syncCardOf(account: boolean, phase: string, pending: number, lastSyncedAt: number | null, message: string | null): { status: string; detail: string; icon: string } {
  if (!account) return { status: "本机已保存", detail: "登录后可将这些记录保存到账号。", icon: "phone" };
  if (phase === "syncing") return { status: "正在同步", detail: appendMessage("本机记录已经保存。", message), icon: "sync" };
  /* 离线相位的 message 恒为传输层错误原文（services/sync run catch 里 phase 与 message 同一次 emit；
     浏览器层 fetch 失败为「TypeError: Failed to fetch」原文），按原型 v2SyncText html:2022 副文为
     单句规范文案——不透出原始异常（同 authErrorCopy 口径），其余相位保留 appendMessage */
  if (phase === "offline") return { status: "本机已保存，待联网同步", detail: "已有内容可以继续读，新增记录仍在这台手机。", icon: "clock" };
  if (phase === "error") return { status: "同步暂未完成", detail: appendMessage("本机记录仍在，可以重试。", message), icon: "info" };
  if (pending > 0) return { status: "记录等待同步", detail: appendMessage(`本机已经保存，${pending} 项更改等待上传。`, message), icon: "clock" };
  if (!lastSyncedAt) return { status: "准备同步", detail: "学习记录会自动保存到账号。", icon: "sync" };
  const date = new Date(lastSyncedAt), now = new Date();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const recent = Date.now() - lastSyncedAt < 60_000 ? "刚刚" : date.toDateString() === now.toDateString() ? `今天 ${time}` : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
  return { status: "已同步", detail: appendMessage(`最近同步：${recent}`, message), icon: "check" };
}
function appendMessage(base: string, message: string | null): string {
  return message ? `${base} ${message}` : base;
}

/* 阅读主题档副文（对照原型 SHEETS.account html:2031：dark→夜间深色、sepia→纸书暖黄、缺省→护眼灰绿；
   与阅读设置抽屉 TOPIC_CHOICES 同名，components/reading/SettingsSheet.tsx:27-29） */
const TOPIC_LABELS: Record<string, string> = { paper: "护眼灰绿", sepia: "纸书暖黄", black: "夜间深色" };

/**
 * 账号抽屉（原型 SHEETS.account）：由 accountGate 驱动（根页页头圆章/本地保存行/阅读页
 * 「登录同步」呼出）。子抽屉（同步规则/隐私/退出确认，SheetShell z-130）与学习方向推入页
 * （z-126）盖在本抽屉（z-118）之上；抽屉在上层打开期间 inert，焦点不落入底层。
 */
export default function AccountScreen() {
  const open = useAccountOpen();
  const nav = useNav();
  const { account } = useCloud();
  const sync = useSyncStatus();
  const goalOpen = useGoalSource(); /* 学习方向推入页（z-126）盖在本抽屉（z-118）上时锁焦点 */
  const loginIntent = useLoginIntent();
  const [error, setError] = useState(""), [rules, setRules] = useState(false), [privacy, setPrivacy] = useState(false), [signOut, setSignOut] = useState(false), [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false), [voice, setVoice] = useState(false);
  const vocab = useApp((s) => s.vocab), tasks = useApp((s) => s.tasks), articles = useApp((s) => s.articles);
  const goal = useApp((s) => s.settings.goal);
  const reader = useApp((s) => s.reader);
  const daily = useApp((s) => s.settings.daily), remindTime = useApp((s) => s.settings.remindTime);
  const progress = useApp((s) => s.progress);
  /* 已产生阅读位置的文章即有记录，包括只读过第一句的短文。 */
  const readCount = articles.filter(a => !a.archived && (!!a.lastReadAt || progress[a.id] !== undefined)).length;
  const practiceCount = tasks.reduce((count, task) => count + task.attempts.filter(attempt => attempt.status === "feedback").length, 0);
  async function confirmSignOut() {
    setBusy(true); setError("");
    try { await logout(); await switchProfile("guest", false); actions.setOnboarded(); setSignOut(false); closeAccount(); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  if (!open) return null;
  const card = syncCardOf(!!account, sync.phase, sync.pending, sync.lastSyncedAt, sync.message);
  const name = account ? (account.nickname || account.email?.split("@")[0] || "已登录") : "本机试用";
  /* 推入页目的地（z-40）低于本抽屉（z-118）：跳转前先收抽屉，返回后落在根页；
     学习方向（推入页 z-126 盖抽屉）与子抽屉（z-130）保留抽屉原位 */
  const leave = (route: Parameters<typeof nav.push>[0]) => { closeAccount(); nav.push(route); };
  /* 行清单对照原型 SHEETS.account（html:2031）：学习设置四行（学习方向/阅读设置/语音与口音/
     学习提醒），记录与隐私两行（同步规则/隐私说明，无副文）；不列阅读与翻译/翻译记录/
     术语表/诊断等原型外行（复检 2026-11-01）。阅读设置副文 = 阅读器真实偏好 `${fs}px · 主题名`
     （原型口径 `${APP.settings.fontSize}px · 护眼灰绿`）。 */
  const learningRows: { icon: string; label: string; sub: string; act: () => void }[] = [
    { icon: "target", label: "学习方向", sub: goal, act: () => openGoal("account") },
    { icon: "aa", label: "阅读设置", sub: `${reader.fs}px · ${TOPIC_LABELS[reader.topic] ?? reader.topic}`, act: () => setReading(true) },
    { icon: "wave", label: "语音与朗读", sub: "示范声音、语速与麦克风", act: () => setVoice(true) },
    { icon: "bell", label: "学习提醒", sub: daily ? `每天 ${remindTime}` : "未开启", act: () => leave("setRemind") },
  ];
  const recordRows: { icon: string; label: string; act: () => void }[] = [
    { icon: "sync", label: "同步与本机保存规则", act: () => setRules(true) },
    { icon: "lock", label: "隐私与权限说明", act: () => setPrivacy(true) },
  ];
  const row = (r: { icon: string; label: string; sub?: string; act: () => void }) => (
    <button key={r.label} className="learning-row" onClick={r.act}>
      <span className="v2-row-ic"><Icon name={r.icon} size={17} /></span>
      <span className="v2-row-tx"><b>{r.label}</b>{r.sub && <small>{r.sub}</small>}</span>
      <Icon name="chevr" size={16} />
    </button>
  );
  return <>
    <SheetShell label="账号与设置" title="账号与设置" zIndex={118} inert={!!goalOpen || !!loginIntent || reading || voice || rules || privacy || signOut} onClose={closeAccount}>
      {/* 身份行（原型 .v2-account-head）：43px accent 圆章 + 名称/说明 + 游客/已登录 tag */}
      <div className="v2-account-head">
        <span className="v2-acct-av">{(account ? name : "I").trim().slice(0, 1).toUpperCase()}</span>
        <div>
          <b>{name}</b>
          <small>{account ? account.email : "记录保存在这台手机"}</small>
        </div>
        <span className={`learning-tag${account ? "" : " v2-tag-grey"}`}>{account ? "已登录" : "游客"}</span>
      </div>
      {/* 连接态状态卡（原型 .v2-account-sync，accent-soft）+ 主按钮 */}
      <div className="v2-account-sync" aria-live="polite">
        <Icon name={card.icon} size={17} />
        <div><b>{card.status}</b><small>{card.detail}</small></div>
        {account && sync.phase !== "offline" && <button className="tlink" disabled={sync.phase === "syncing" || busy} onClick={() => void syncNow().catch(e => setError(String(e)))}>{sync.phase === "syncing" ? "同步中…" : "立即同步"}</button>}
      </div>
      {!account && <button className="btn" onClick={() => void ensureAccount({ reason: "登录账号，在手机和电脑之间继续学习。" })}>登录并保存学习记录</button>}
      {/* 三格统计（原型 .v2-account-counts）：裸排衬线大数字 */}
      <div className="v2-account-counts">
        <span><b>{vocab.length}</b> 条收藏</span>
        <span><b>{practiceCount}</b> 次作答</span>
        <span><b>{readCount}</b> 篇阅读记录</span>
      </div>
      <div className="v2-account-h">学习设置</div>
      <div className="v2-account-lst">{learningRows.map(row)}</div>
      <div className="v2-account-h">记录与隐私</div>
      <div className="v2-account-lst">{recordRows.map(row)}</div>
      {account && <button type="button" className="tlink ob-full-link v2-danger-link" disabled={busy} onClick={() => setSignOut(true)}>退出账号</button>}
      {error && <p role="alert" className="v2-form-error"><Icon name="info" size={14} />{error}</p>}
    </SheetShell>
    {rules && <SyncRulesSheet onClose={() => setRules(false)} />}
    {reading && <SettingsSheet open layer="account" onClose={() => setReading(false)} />}
    {voice && <VoiceSettingsSheet open layer="account" onClose={() => setVoice(false)} />}
    {privacy && <PrivacySheet onClose={() => setPrivacy(false)} />}
    {signOut && <SignOutSheet busy={busy} onConfirm={() => void confirmSignOut()} onClose={() => setSignOut(false)} />}
  </>;
}
