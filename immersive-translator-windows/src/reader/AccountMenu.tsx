/**
 * 账号入口（2026-11-12，原型 reader-account-entry-2026-11-11）：
 * 顶栏 shell-tools 末段的三态触发器 + 账号菜单。
 *
 * 三态触发器（authStatus 由 ReaderApp 从 auth_get_status / auth-state-changed 同步）：
 * - 游客（loggedIn=false 且无 notice）：「登录」pill（accent 软底）→ 现有登录窗；
 * - 失效（loggedIn=false 且有 notice）：「重新登录」警示 pill（warn 软底）——
 *   Rust 失效广播不带 user（auth.rs emit_fatal_if_needed），拿不到邮箱只能给重新登录；
 * - 成员（loggedIn=true）：28px 圆形头像（昵称/邮箱首字母）。
 * - authStatus 为 null（读取中）：触发器用中性置灰态（is-loading，title=正在读取登录状态…），
 *   不冒充游客「登录」——首个状态来自 auth_get_status 异步返回，返回前成员不该闪现登录 pill；
 *   菜单头部沿用「正在读取登录状态…」口径（SettingsDrawer 先例）。
 *
 * 菜单几何照 .reader-theme-menu（12px 圆角 / border-strong / --shadow-float，宽 292）；
 * 交互照 ReaderThemePicker：document pointerdown 外点关闭、stopPropagation 键盘隔离、
 * Esc/Tab/ArrowUp-Down/Home-End/焦点回归。退出登录用菜单内确认面板两步走（照原型），
 * 确认后走 authLogout（失败保持登录态并 toast，AccountSection 口径）。
 * 演示控制条 / 日志行 / 登录窗外框不落地：登录走现有登录窗（openLoginWindow）。
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  IconAlertCircle,
  IconChevronDown,
  IconClock,
  IconCrop,
  IconMic,
  IconUser,
} from "../ui/icons";
import {
  authLogout,
  openHistory,
  openLiveCaption,
  openLoginWindow,
  openOcrOverlay,
  settingsOpenTab,
  type AuthStatus,
} from "../lib/tauriBridge";
import { openQuickReview } from "../lib/reminder";
import { authErrorText, authNoticeText } from "../lib/authErrorText";
import { loadSettings } from "../lib/settingsStore";

interface Props {
  authStatus: AuthStatus | null;
  /** 快速复习徽标：与「笔记与复习」island-counter 同源（dueVocab），>0 才显示。 */
  dueNow: number;
  /** 菜单动作反馈走阅读室 toast（ReaderApp showToast）。 */
  onToast: (message: string) => void;
}

/** 账号与额度（原型 id-card 图标；icons.tsx 暂缺，照 ShelfPage 本地图标先例内联）。 */
function IconIdCard({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="11" r="2" />
      <path d="M15 9h3M15 13h3M6 16a3 3 0 0 1 6 0" />
    </svg>
  );
}

/** 快速复习（原型 flashcards 图标；icons.tsx 暂缺）。 */
function IconCards({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="7" width="14" height="14" rx="2" />
      <path d="M7 3h12a2 2 0 0 1 2 2v12" />
    </svg>
  );
}

/** 退出登录（原型 log-out 图标；icons.tsx 暂缺）。 */
function IconLogOut({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

/** 截图翻译 kbd 标签：读设置里的实时热键，改键后菜单不显示过时键位；读不到回退默认。 */
function ocrHotkeyLabel(): string {
  try {
    const hotkey = loadSettings().ocrHotkey;
    if (hotkey && hotkey.trim()) return hotkey;
  } catch {
    /* ignore */
  }
  return "Ctrl+Shift+E";
}

export function AccountMenu({ authStatus, dueNow, onToast }: Props) {
  const [open, setOpen] = useState(false);
  /** 退出登录确认面板（菜单内两步，照原型：先 confirm 再 do/cancel）。 */
  const [confirming, setConfirming] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  /** 打开/回退后的落焦意图（"first"=首个菜单项，"cancel"=确认面板取消键；null=不抢焦点）。 */
  const pendingFocusRef = useRef<"first" | "cancel" | null>(null);
  /** Tab 交默认焦点移动产生 blur 后再关闭，避免提前卸载菜单项让 Tab 丢失落点（照主题选择器）。 */
  const closeOnBlurRef = useRef(false);
  /** 菜单内容换装（菜单↔确认面板）时被移除的聚焦节点可能补发 blur，吞一次防误关。 */
  const blurGuardRef = useRef(false);
  const menuId = useId();

  const loggedIn = authStatus?.loggedIn === true;
  const notice = loggedIn ? null : authStatus?.notice ?? null;
  /** 失效态：Rust 广播 {loggedIn:false, user:null, notice}，拿不到 user 只能给重新登录。 */
  const expired = !loggedIn && notice !== null;
  const user = loggedIn ? authStatus?.user ?? null : null;
  const email = user?.email ?? "";
  const displayName = user?.nickname || (email ? email.split("@")[0] : "") || "已登录";
  const avatarInitial = ((user?.nickname || email).trim().charAt(0) || "·").toUpperCase();

  useEffect(() => {
    if (!open) return;
    const focusTarget = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (focusTarget === "cancel") cancelRef.current?.focus();
    else if (focusTarget === "first") firstMenuItem()?.focus();
    blurGuardRef.current = false;
    function onPointerDown(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) {
        closeOnBlurRef.current = false;
        closeMenu();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, confirming]);

  function firstMenuItem(): HTMLButtonElement | null {
    return (
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]') ??
      menuRef.current?.querySelector<HTMLButtonElement>("button") ??
      null
    );
  }

  function menuItems(): HTMLButtonElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  }

  function openMenu(byKeyboard: boolean) {
    pendingFocusRef.current = byKeyboard ? "first" : null;
    closeOnBlurRef.current = false;
    setConfirming(false);
    setOpen(true);
  }

  function closeMenu(returnFocus = false) {
    closeOnBlurRef.current = false;
    setOpen(false);
    setConfirming(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  /** 菜单动作统一收口：先关菜单，再发调用（失败静默），有文案才 toast（原型口径）。 */
  function runAction(action: () => Promise<unknown>, toast: string) {
    closeMenu();
    void action().catch(() => undefined);
    if (toast) onToast(toast);
  }

  async function doLogout() {
    try {
      await authLogout();
      closeMenu(true);
      onToast("已退出登录，当前是本机书架");
    } catch (error) {
      // 登出失败（如 storage_error）时 Rust 保持登录态（auth.rs §5.3），菜单只提示。
      closeMenu(true);
      onToast(`登出失败：${authErrorText(error).text}`);
    }
  }

  function requestLogout() {
    // 换装成确认面板：吞掉被移除节点可能补发的 blur，落焦取消键（照原型）。
    blurGuardRef.current = true;
    pendingFocusRef.current = "cancel";
    setConfirming(true);
  }

  function cancelLogout() {
    blurGuardRef.current = true;
    pendingFocusRef.current = "first";
    setConfirming(false);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    // ReaderApp 的播放快捷键只排除输入控件；账号控件自行隔离键盘事件。
    event.stopPropagation();
    if (event.key === "Tab") {
      closeOnBlurRef.current = open;
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        closeMenu(true);
      }
      return;
    }
    if (event.target === triggerRef.current) {
      if (!open && (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        openMenu(true);
      }
      return;
    }
    if (!open || confirming) return;
    const items = menuItems();
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next >= 0) {
      event.preventDefault();
      items[next]?.focus();
    }
  }

  const triggerControls = open ? menuId : undefined;

  function renderTrigger() {
    if (loggedIn) {
      return (
        <button
          ref={triggerRef}
          type="button"
          className="acct-trigger is-member"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={triggerControls}
          aria-label={email ? `账号：${email}` : "账号"}
          title={email || "账号"}
          onClick={(event) => (open ? closeMenu() : openMenu(event.detail === 0))}
        >
          <span className="acct-avatar" aria-hidden>{avatarInitial}</span>
        </button>
      );
    }
    if (expired) {
      return (
        <button
          ref={triggerRef}
          type="button"
          className="acct-trigger is-guest is-expired"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={triggerControls}
          title={authNoticeText(notice) ?? "登录已失效"}
          onClick={(event) => (open ? closeMenu() : openMenu(event.detail === 0))}
        >
          <IconAlertCircle size={14} />
          <span className="acct-trigger-label">重新登录</span>
          <IconChevronDown size={11} />
        </button>
      );
    }
    if (authStatus === null) {
      // 读取中：中性置灰 pill，不按游客「登录」渲染（首个状态来自 auth_get_status
      // 异步返回，返回前已登录成员不该闪现「登录」）；菜单仍可打开（头部为读取中口径）。
      return (
        <button
          ref={triggerRef}
          type="button"
          className="acct-trigger is-loading"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={triggerControls}
          aria-label="正在读取登录状态…"
          title="正在读取登录状态…"
          onClick={(event) => (open ? closeMenu() : openMenu(event.detail === 0))}
        >
          <IconUser size={14} />
          <span className="acct-trigger-label">…</span>
          <IconChevronDown size={11} />
        </button>
      );
    }
    return (
      <button
        ref={triggerRef}
        type="button"
        className="acct-trigger is-guest"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={triggerControls}
        title="登录与工具"
        onClick={(event) => (open ? closeMenu() : openMenu(event.detail === 0))}
      >
        <IconUser size={14} />
        <span className="acct-trigger-label">登录</span>
        <IconChevronDown size={11} />
      </button>
    );
  }

  function renderHead() {
    if (loggedIn) {
      return (
        <div className="acct-head">
          <div className="acct-id">
            <span className="acct-avatar acct-avatar-lg" aria-hidden>{avatarInitial}</span>
            <div className="acct-id-text">
              <div className="acct-name">
                {displayName}
                {user?.plan ? <span className="acct-plan">{user.plan}</span> : null}
              </div>
              {email ? <div className="acct-mail">{email}</div> : null}
            </div>
          </div>
        </div>
      );
    }
    if (authStatus === null) {
      return (
        <div className="acct-head">
          <h3>正在读取登录状态…</h3>
          <p>确认后这里会显示账号入口或登录按钮。</p>
        </div>
      );
    }
    if (expired) {
      return (
        <div className="acct-head is-expired-head">
          <h3>
            <IconAlertCircle size={15} />
            <span>{authNoticeText(notice) ?? "登录已失效"}</span>
          </h3>
          <p>书架已切回这台电脑上未登录时的内容。重新登录后回到账号书架，这期间在本机新增的内容会并入账号。</p>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="btn btn-primary acct-block"
            onClick={() => runAction(() => openLoginWindow(), "")}
          >
            重新登录
          </button>
        </div>
      );
    }
    return (
      <div className="acct-head">
        <h3>登录沉浸云</h3>
        <p>生词本、阅读进度和口语记录跨设备同步，还能用云端口语评分和朗读。</p>
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="btn btn-primary acct-block"
          onClick={() => runAction(() => openLoginWindow(), "")}
        >
          登录 / 注册
        </button>
        <small>不登录也能使用全部本地功能</small>
      </div>
    );
  }

  function renderConfirm() {
    return (
      <div className="acct-menu" role="dialog" aria-modal="false" aria-labelledby={`${menuId}-confirm`}>
        <div className="acct-note">
          <h3 id={`${menuId}-confirm`}>退出登录？</h3>
          <p>退出后，阅读室会切回这台电脑上未登录时的书架。账号里的书、生词和笔记不会删除，重新登录即可回来。</p>
          <div className="acct-note-row">
            <button ref={cancelRef} type="button" className="btn btn-sm" onClick={cancelLogout}>
              取消
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => void doLogout()}>
              退出登录
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      className="acct"
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        // H 可能在正文按下；放行释放事件，让 ReaderApp 清理临时揭示状态。
        if (event.key !== "h" && event.key !== "H") event.stopPropagation();
      }}
      onBlur={(event) => {
        if (blurGuardRef.current) {
          blurGuardRef.current = false;
          return;
        }
        if (closeOnBlurRef.current || !event.currentTarget.contains(event.relatedTarget as Node)) closeMenu();
      }}
    >
      {renderTrigger()}
      {open &&
        (confirming ? (
          renderConfirm()
        ) : (
          <div ref={menuRef} className="acct-menu" role="menu" aria-label="账号与应用" id={menuId}>
            {renderHead()}
            {loggedIn && <div className="acct-sep" aria-hidden />}
            {loggedIn && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="acct-mi"
                onClick={() => runAction(() => settingsOpenTab("account"), "已打开设置 · 账号")}
              >
                <IconIdCard />
                <span>账号与额度</span>
                <span className="acct-mi-hint">兑换码</span>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="acct-mi"
              onClick={() => runAction(() => openHistory(), "已打开翻译历史")}
            >
              <IconClock size={15} />
              <span>翻译历史</span>
            </button>
            <div className="acct-sep" aria-hidden />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="acct-mi"
              onClick={() => runAction(() => openOcrOverlay(), "进入截图框选")}
            >
              <IconCrop size={15} />
              <span>截图翻译</span>
              <kbd>{ocrHotkeyLabel()}</kbd>
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="acct-mi"
              onClick={() => runAction(() => openLiveCaption(), "已打开录音直译")}
            >
              <IconMic size={15} />
              <span>录音直译</span>
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="acct-mi"
              onClick={() => runAction(() => openQuickReview(), "已打开快速复习")}
            >
              <IconCards />
              <span>快速复习</span>
              {dueNow > 0 && <span className="acct-mi-due">{dueNow}</span>}
            </button>
            {loggedIn && (
              <>
                <div className="acct-sep" aria-hidden />
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="acct-mi is-quiet"
                  onClick={requestLogout}
                >
                  <IconLogOut />
                  <span>退出登录</span>
                </button>
              </>
            )}
          </div>
        ))}
    </div>
  );
}
