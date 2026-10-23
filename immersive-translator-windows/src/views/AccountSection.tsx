/**
 * 设置页「账号」tab（docs/windows-auth-design-2026-09-26.md §6/§8.2）。
 * - 未登录：空态卡 + 「登录」按钮（open_login_window）；notice 失效状态条（D8 warn 条）
 * - 已登录：头像/昵称/邮箱/plan 徽标、当前设备行（只读）、注册时间、
 *   云端配置手动重拉（D7：登录后自动拉取在 Rust 侧 fire-and-forget，失败仅 log）、
 *   口语场景云同步（升级计划 A0：双向同步 speak-scenarios 集合，手动触发）
 * - 登出：auth_logout；clear 失败（storage_error）保持登录态 + 红条（§5.3/P13）
 * - 状态机：挂载 auth_get_status + 监听 auth-state-changed（启动静默续登录 /
 *   登录/登出后的状态更新由 Rust 事件驱动，前端不建第二份账号存储）
 */
import { useCallback, useEffect, useState } from "react";
import { authErrorText, authNoticeText } from "../lib/authErrorText";
import {
  authFetchServerConfig,
  authGetStatus,
  authLogout,
  listenAuthStateChanged,
  openLoginWindow,
  type AuthStatus,
} from "../lib/tauriBridge";
import { syncNow, type SyncSummary } from "../lib/syncEngine";
import { IconAlert, IconCheck } from "../ui/icons";

export interface AccountStatusState {
  /** null = 读取中。权威在 Rust（内存态 + DPAPI），前端只有这份事件驱动副本。 */
  status: AuthStatus | null;
  /** 登出等本地动作后的主动刷新（事件广播之外的双保险）。 */
  refresh: () => Promise<void>;
}

/**
 * 账号状态机：挂载拉一次 auth_get_status + 监听 auth-state-changed 自刷新。
 * Settings 侧栏 conn-chip 与本组件共用。
 */
export function useAccountStatus(): AccountStatusState {
  const [status, setStatus] = useState<AuthStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await authGetStatus());
    } catch (e) {
      // 契约：auth_get_status 不会 Err；异常时保持读取中兜底显示。
      console.error("[account] get status failed", e);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unlistenP = listenAuthStateChanged((s) => setStatus(s));
    return () => {
      void unlistenP.then((u) => u());
    };
  }, [refresh]);

  return { status, refresh };
}

/** 昵称展示兜底：null/空白昵称 → 邮箱 @ 前缀（Rust nickname: Option<String>）。 */
function displayName(user: NonNullable<AuthStatus["user"]>): string {
  const nick = user.nickname?.trim() ?? "";
  if (nick) return nick;
  const email = user.email.trim();
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email || "未命名用户";
}

/** 头像圆内的字符：昵称（或邮箱）首字符。 */
function avatarGlyph(user: NonNullable<AuthStatus["user"]>): string {
  const source = user.nickname?.trim() || user.email.trim();
  return source ? source.charAt(0).toUpperCase() : "·";
}

/** 注册时间展示（AuthUser.createdAt，ISO → YYYY-MM-DD）。 */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 口语场景同步结果一句话（成功给计数，失败给原因；跳过项只报数量）。 */
function syncSummaryText(s: SyncSummary): string {
  if (!s.ok) return `同步失败：${s.error ?? "未知错误"}`;
  const parts = [`拉取 ${s.pulled} 项`, `推送 ${s.pushed} 项`];
  if (s.conflicts > 0) parts.push(`冲突处理 ${s.conflicts} 次`);
  if (s.keptLocal > 0) parts.push(`本地较新保留 ${s.keptLocal} 项`);
  if (s.skipped.length > 0) parts.push(`跳过 ${s.skipped.length} 项`);
  return `同步完成（${parts.join("，")}）`;
}

export function AccountSection() {
  const { status, refresh } = useAccountStatus();
  const [loggingOut, setLoggingOut] = useState(false);
  /** 登出失败红条（storage_error 时 Rust 保持登录态，§5.3）。 */
  const [logoutErr, setLogoutErr] = useState<string | null>(null);
  /** 云端配置手动重拉结果。 */
  const [configMsg, setConfigMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [syncingConfig, setSyncingConfig] = useState(false);
  /** 口语场景云同步（A0）状态。 */
  const [scenarioSyncing, setScenarioSyncing] = useState(false);
  const [scenarioSyncMsg, setScenarioSyncMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function handleLogout(): Promise<void> {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutErr(null);
    try {
      await authLogout();
      // 登出后的状态更新：Rust 广播 auth-state-changed，这里再主动刷新兜底。
      await refresh();
      setConfigMsg(null);
    } catch (err) {
      // P13：clear 失败 → Rust 保持登录态；前端同样保持已登录 UI + 红条提示。
      setLogoutErr(`登出失败：${authErrorText(err).text}`);
    } finally {
      setLoggingOut(false);
    }
  }

  async function handleFetchConfig(): Promise<void> {
    if (syncingConfig) return;
    setSyncingConfig(true);
    setConfigMsg(null);
    try {
      await authFetchServerConfig();
      setConfigMsg({ text: "云端配置已拉取并保存", ok: true });
    } catch (err) {
      setConfigMsg({ text: authErrorText(err).text, ok: false });
    } finally {
      setSyncingConfig(false);
    }
  }

  async function handleSyncScenarios(): Promise<void> {
    if (scenarioSyncing) return;
    setScenarioSyncing(true);
    setScenarioSyncMsg(null);
    // syncNow 不抛错（失败汇总带回）；未登录/网络失败在 summary.error 里。
    const summary = await syncNow("speak-scenarios");
    setScenarioSyncMsg({ text: syncSummaryText(summary), ok: summary.ok });
    setScenarioSyncing(false);
  }

  if (status === null) {
    return <p className="acct-loading">正在读取账号状态…</p>;
  }

  const noticeText = authNoticeText(status.notice);

  return (
    <>
      {/* 失效状态条：token_invalid / token_reused 清凭据后的落点，持久显示直到重新登录（D8） */}
      {noticeText !== null && (
        <div className="acct-notice" role="status">
          <IconAlert size={14} />
          <span>{noticeText}</span>
        </div>
      )}

      <header className="set-pagehead">
        <div className="set-pagehead-text">
          <h2>账号</h2>
          <p>
            {status.loggedIn
              ? "账号信息与登录状态"
              : "登录是可选项——翻译、阅读室与复习全部本地可用"}
          </p>
        </div>
      </header>

      {!status.loggedIn || !status.user ? (
        <section className="group-card acct-signin-panel">
          <div className="acct-empty">
            <span className="acct-empty-icon" aria-hidden>
              ◐
            </span>
            <h4>未登录</h4>
            <p>登录后可使用官方翻译服务、同步云端配置；不登录不影响任何本地功能</p>
            <button
              className="btn btn-primary"
              onClick={() => void openLoginWindow().catch((e) => console.error("[account] open login failed", e))}
            >
              登 录
            </button>
          </div>
        </section>
      ) : (
        <div className="account-workspace">
          <section className="group-card acct-profile-panel">
            <div className="acct-row">
              <span className="avatar" aria-hidden>
                {avatarGlyph(status.user)}
              </span>
              <div className="acct-who">
                <div className="acct-name">
                  <span className="acct-nickname">{displayName(status.user)}</span>
                  <span className="plan-badge">{status.user.plan}</span>
                </div>
                <div className="acct-email">{status.user.email}</div>
              </div>
            </div>
          </section>

          <section className="group-card acct-details-panel">
            <div className="acct-card-title">登录信息</div>
            <div className="field-row">
              <div className="field-text">
                <span className="field-label-v2">当前设备</span>
                <span className="field-hint">仅本机登录会话展示（设备名由系统提供）</span>
              </div>
              <div className="field-ctrl">
                <span className="acct-device">
                  Windows · 本机
                  <span className="chip chip-green">当前</span>
                </span>
              </div>
            </div>
            <div className="field-row">
              <div className="field-text">
                <span className="field-label-v2">注册时间</span>
              </div>
              <div className="field-ctrl">
                <span className="acct-registered">{formatDate(status.user.createdAt)}</span>
              </div>
            </div>
            <div className="field-row">
              <div className="field-text">
                <span className="field-label-v2">云端配置</span>
                <span className="field-hint">登录后自动同步；失败可在此手动重拉</span>
              </div>
              <div className="field-ctrl">
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={syncingConfig}
                  onClick={() => void handleFetchConfig()}
                >
                  {syncingConfig ? "同步中…" : "重新拉取"}
                </button>
              </div>
            </div>
            {configMsg && (
              <div className={`msg-bar ${configMsg.ok ? "ok" : "err"}`}>
                {configMsg.ok ? <IconCheck size={14} /> : <IconAlert size={14} />}
                {configMsg.text}
              </div>
            )}
          </section>

          <section className="group-card acct-sync-panel">
            <div className="acct-card-title">口语场景云同步</div>
            <div className="field-row">
              <div className="field-text">
                <span className="field-label-v2">跨设备同步自定义口语场景</span>
                <span className="field-hint">
                  升级计划 A0：先拉取云端变更再推送本地改动；场景编辑器上线后将自动接入
                </span>
              </div>
              <div className="field-ctrl">
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={scenarioSyncing}
                  onClick={() => void handleSyncScenarios()}
                >
                  {scenarioSyncing ? "同步中…" : "立即同步"}
                </button>
              </div>
            </div>
            {scenarioSyncMsg && (
              <div className={`msg-bar ${scenarioSyncMsg.ok ? "ok" : "err"}`}>
                {scenarioSyncMsg.ok ? <IconCheck size={14} /> : <IconAlert size={14} />}
                {scenarioSyncMsg.text}
              </div>
            )}
          </section>

          <section className="group-card acct-security-panel">
            <div className="field-row">
              <div className="field-text">
                <span className="field-hint">
                  退出当前账号后，本地数据（生词本/历史/书架）不受影响
                </span>
              </div>
              <div className="field-ctrl">
                <button
                  className="btn btn-danger"
                  disabled={loggingOut}
                  onClick={() => void handleLogout()}
                >
                  {loggingOut ? "登出中…" : "登出"}
                </button>
              </div>
            </div>
            {logoutErr && (
              <div className="msg-bar err" role="alert">
                <IconAlert size={14} />
                {logoutErr}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
