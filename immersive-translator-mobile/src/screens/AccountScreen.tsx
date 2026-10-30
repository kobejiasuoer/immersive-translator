import { useEffect, useRef, useState } from "react";
import { syncNow, useSyncStatus } from "../services/sync";
import { actions, getState, switchProfile } from "../store";
import { cancelLogin, completeLogin, ensureAccount, useLoginIntent } from "../services/authGate";
import { cloudState, loadCloudConfig, login, logout, requestOtp, useCloud } from "../services/cloud";
import { useNav } from "../ui/nav";
export function LoginHost() {
  const intent = useLoginIntent();
  const [email, setEmail] = useState(""), [credential, setCredential] = useState("");
  const [mode, setMode] = useState<"otp" | "password">("otp");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [sent, setSent] = useState(false), [claim, setClaim] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!intent) return;
    const previous = document.activeElement as HTMLElement | null;
    const timer = setTimeout(() => panel.current?.querySelector<HTMLElement>("input,button")?.focus(), 0);
    return () => { clearTimeout(timer); previous?.focus({ preventScroll: true }); };
  }, [intent]);
  if (!intent) return null;
  const state = getState();
  async function submit() {
    setError(""); setBusy(true);
    try { await login(email, credential, mode); setClaim(true); } catch (e) { setError(String(e instanceof Error ? e.message : e)); } finally { setBusy(false); }
  }
  async function finish(bring: boolean) {
    setBusy(true); setError("");
    try { await completeLogin(bring); setClaim(false); setCredential(""); void loadCloudConfig().catch(() => undefined); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <div className="account-overlay" role="dialog" aria-modal="true" aria-label="邮箱登录"><div className="account-panel" ref={panel} onKeyDown={e => {
    if (e.key !== "Tab") return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') || [])];
    if (!items.length) return;
    if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1)?.focus(); }
    else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0].focus(); }
  }}><button className="tlink" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await cancelLogin(); setClaim(false); setCredential(""); } catch (failure) { setError(String(failure)); } finally { setBusy(false); } }}>先继续本地体验</button><p className="overline">沉浸阅读室 · 账号</p><h1>{claim ? "把这些积累，带到账号里？" : "登录后，继续刚才那一步"}</h1><p className="meta">{intent.reason || "本地阅读与收藏无需登录。云端处理和跨设备接力需要账号。"}</p>{claim ? <><div className="learning-card">{state.vocab.length} 条生词 · {state.notes.length} 条笔记 · {state.tasks.length} 次练习</div><button className="btn" disabled={busy} onClick={() => void finish(true)}>带入这些记录并继续</button><button className="btn-ghost" disabled={busy} onClick={() => void finish(false)}>暂不带入全部记录</button><p className="meta">暂不带入时，只复制当前任务及原文以继续本次操作；其他资料仍留在游客空间。</p></> : <form onSubmit={e => { e.preventDefault(); void submit(); }}><label>邮箱<input className="input" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label><div className="learning-seg"><button type="button" className={mode === "otp" ? "on" : ""} onClick={() => { setMode("otp"); setCredential(""); }}>验证码</button><button type="button" className={mode === "password" ? "on" : ""} onClick={() => { setMode("password"); setCredential(""); }}>密码</button></div><label>{mode === "otp" ? "邮箱验证码" : "密码"}<input className="input" required type={mode === "password" ? "password" : "text"} autoComplete={mode === "otp" ? "one-time-code" : "current-password"} value={credential} onChange={e => setCredential(e.target.value)} /></label>{mode === "otp" && <button type="button" className="btn-ghost" disabled={busy || Date.now() < cooldown} onClick={async () => { setBusy(true); setError(""); try { await requestOtp(email); setSent(true); setCooldown(Date.now() + 60000); setTimeout(() => setCooldown(0),60000); } catch(e) { setError(String(e)); } finally { setBusy(false); } }}>{sent ? "重新发送验证码" : "发送验证码"}</button>}<button className="btn" disabled={busy}>{busy ? "正在处理…" : "登录并继续"}</button></form>}{error && <p role="alert" className="learning-error">{error}</p>}</div></div>;
}
export default function AccountScreen() {
  const nav = useNav(); const { account, config } = useCloud(); const sync = useSyncStatus(); const [error,setError] = useState("");
  return <><div className="learning-head"><button className="tlink" onClick={nav.pop}>返回</button><h1>账号与设置</h1></div><div className="learning-body"><section className="learning-card"><h2>{account?.nickname || account?.email || "本地体验"}</h2><p>{account ? "本机记录按账号隔离，退出后仍然保留。" : "样文阅读、收藏与复习可以直接开始。"}</p>{!account && <button className="btn" onClick={() => void ensureAccount({reason:"登录账号，在 iPhone 和 Windows 之间继续学习。"})}>邮箱登录</button>}<small>{config ? "已获取账号服务能力" : "尚未连接云服务"}</small></section>{account && <section className="learning-card" aria-live="polite"><h2>跨设备接力</h2><p>{sync.phase === "syncing" ? "正在同步学习资料…" : sync.phase === "offline" ? "当前离线，资料保留在本机" : sync.phase === "error" ? "本次同步未完成，本机资料已保留" : sync.lastSyncedAt ? "最近同步：" + new Date(sync.lastSyncedAt).toLocaleString() : "等待首次同步"}</p><small>{sync.pending} 项等待上传 · 录音原声仅在录制设备保存</small>{sync.message && <p role="status">{sync.message}</p>}<button className="btn-ghost" disabled={sync.phase === "syncing"} onClick={() => void syncNow().catch(e => setError(String(e)))}>立即同步</button></section>}{([[ "setPref","阅读与翻译"],["setVoice","语音与口音"],["setRemind","复习提醒"],["setLook","主题与字号"],["history","翻译记录"],["glossary","术语表"],["diag","诊断与本地保存状态"]] as const).map(([route,label]) => <button key={route} className="learning-row" onClick={() => nav.push(route)}>{label}<span>›</span></button>)}{account && <button className="btn-ghost" onClick={async () => { try { await logout(); await switchProfile("guest",false); actions.setOnboarded(); nav.popAll(); } catch(e) { setError(String(e)); } }}>退出账号</button>}{error && <p role="alert">{error}</p>}<small>服务：{cloudState().baseUrl}</small></div></>;
}
