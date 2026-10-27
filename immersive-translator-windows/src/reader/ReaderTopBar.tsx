/**
 * 顶部外壳三段（2026-10-26 阅读页重构，原型 .topbar grid 1fr auto 1fr）：
 * 左 .shell-brand（monogram「I」→ onHome + 书架抽屉触发器：书架 · 当前书名）
 * 中 .shell-tabs（阅读 / 口语 / 笔记与复习 三档，vault 档角标 =
 *   待复习词 + 未整理进笔记的生词）
 * 右 .shell-tools（全文检索 · 主题循环 · 阅读设置抽屉）
 * 布局与皮肤规则见 reader.css「外壳重构 2026-10-26」横幅（.shell-* 全局骨架，
 * folio 视图平面白胶囊）；根类 .floating-top-stage 保留（矮窗规则续命）。
 * 视图菜单（§7）仍由本文件导出——ReaderApp 在 viewMenuAnchor 处挂载，
 * PlayBar 只通过 onOpenViewMenu 回调触发。
 */

import { useEffect, useRef, useState } from "react";
import {
  IconBookOpen,
  IconCheck,
  IconClose,
  IconMic,
  IconNotebook,
  IconSearch,
  IconSettings,
} from "../ui/icons";
import type { ContrastMode, ReaderSettings, ReaderTheme } from "../core/readerTypes";

/** 导航岛三档（阅读视图内部路由 shelf/review/notes 由 ReaderApp 归并映射）。 */
export type IslandSurface = "reading" | "speak" | "vault";

interface Props {
  articleName: string | null;
  settings: ReaderSettings;
  /** 当前高亮档（reading|shelf→阅读、speak→口语、review|notes|vault→笔记与复习）。 */
  view: IslandSurface;
  /** 待复习词数（vault 档角标的一半口径）。 */
  dueNow: number;
  /** 未整理进任何笔记的生词数（vault 档角标的另一半口径）。 */
  unnotedCount: number;
  onPatchSettings: (patch: Partial<ReaderSettings>) => void;
  onOpenDrawer: () => void;
  onSearch: (query: string) => void;
  /** 点 monogram「I」：回到整页书架（书架是首页）。 */
  onHome: () => void;
  onNavigate: (surface: IslandSurface) => void;
  /** 左上书卷胶囊：弹出 / 收起书架浮层。 */
  onToggleFolio: () => void;
  /** 专注复习态（仅 vault+focus）：隐藏中心导航岛，对齐原型 focus 态。 */
  focusMode?: boolean;
}

const THEME_CYCLE: ReaderTheme[] = ["light", "dark", "sepia", "oled"];

export function ReaderTopBar({
  articleName,
  settings,
  view,
  dueNow,
  unnotedCount,
  onPatchSettings,
  onOpenDrawer,
  onSearch,
  onHome,
  onNavigate,
  onToggleFolio,
  focusMode = false,
}: Props) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const themeLabel: Record<ReaderTheme, string> = {
    light: "纸书",
    dark: "深色",
    sepia: "护眼",
    oled: "纯黑",
  };

  function cycleTheme() {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(settings.theme) + 1) % THEME_CYCLE.length];
    onPatchSettings({ theme: next });
  }

  function submitSearch() {
    const q = query.trim();
    if (q) onSearch(q);
  }

  const vaultCount = dueNow + unnotedCount;

  return (
    <header className={`floating-top-stage${focusMode ? " vault-focus-top" : ""}`}>
      <div className="shell-brand">
        <button
          type="button"
          className="monogram-seal"
          onClick={onHome}
          title="回到书架"
          aria-label="回到书架"
        >
          I
        </button>
        <button
          type="button"
          className="folio-drawer-trigger"
          onClick={onToggleFolio}
          title="打开书架浮层（切换书 / 短文，继续读）"
          aria-haspopup="dialog"
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
          </svg>
          <span className="folio-trigger-name">书架{articleName ? ` · ${articleName}` : ""}</span>
          <span className="folio-caret" aria-hidden>
            ▾
          </span>
        </button>
      </div>

      <nav className="shell-tabs" aria-label="主导航">
        <button
          type="button"
          className={`island-tab${view === "reading" ? " active" : ""}`}
          onClick={() => onNavigate("reading")}
          aria-current={view === "reading" ? "page" : undefined}
        >
          <IconBookOpen size={14} />
          <span>阅读</span>
        </button>
        <button
          type="button"
          className={`island-tab${view === "speak" ? " active" : ""}`}
          onClick={() => onNavigate("speak")}
          aria-current={view === "speak" ? "page" : undefined}
        >
          <IconMic size={14} />
          <span>口语</span>
        </button>
        <button
          type="button"
          className={`island-tab${view === "vault" ? " active" : ""}`}
          onClick={() => onNavigate("vault")}
          aria-current={view === "vault" ? "page" : undefined}
          title="生词复习与笔记都在这一档"
        >
          <IconNotebook size={14} />
          <span>笔记与复习</span>
          {vaultCount > 0 && <span className="island-counter">{vaultCount}</span>}
        </button>
      </nav>

      <div className="shell-tools">
        {searchOpen && (
          <input
            ref={searchInputRef}
            className="island-search-input"
            placeholder="在本文中检索…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitSearch();
              if (e.key === "Escape") {
                setSearchOpen(false);
                setQuery("");
              }
            }}
            onBlur={() => {
              if (!query.trim()) setSearchOpen(false);
            }}
            aria-label="在本文中检索"
          />
        )}
        <button
          type="button"
          className={`pill-Ghost-btn${searchOpen ? " active-lens" : ""}`}
          onClick={() => setSearchOpen((v) => !v)}
          title="全文检索（Enter 跳转，Esc 关闭）"
          aria-label="全文检索"
        >
          <IconSearch size={14} />
        </button>
        <button
          type="button"
          className="pill-Ghost-btn"
          onClick={cycleTheme}
          title={`主题：${themeLabel[settings.theme]}（点击切换）`}
          aria-label={`切换主题，当前${themeLabel[settings.theme]}（点击切换）`}
        >
          <span>主题：{themeLabel[settings.theme]}</span>
        </button>
        <button
          type="button"
          className="pill-Ghost-btn"
          onClick={onOpenDrawer}
          title="阅读设置"
          aria-label="阅读设置"
        >
          <IconSettings size={14} />
        </button>
      </div>
    </header>
  );
}

/** 视图菜单（§7）——由播放条「视图」按钮挂载。 */
export function ViewMenu({
  anchorRect,
  settings,
  onPatchSettings,
  onClose,
}: {
  anchorRect: { top: number; right: number };
  settings: ReaderSettings;
  onPatchSettings: (patch: Partial<ReaderSettings>) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const CONTRAST: ContrastMode[] = ["en", "dual", "zh"];
  const contrastLabel: Record<ContrastMode, string> = { en: "仅英文", dual: "对照", zh: "仅中文" };
  const nextContrast = CONTRAST[(CONTRAST.indexOf(settings.contrastMode) + 1) % CONTRAST.length];

  return (
    <div
      className="reader-pop reader-fade"
      ref={ref}
      style={{ bottom: window.innerHeight - anchorRect.top + 6, left: anchorRect.right - 220 }}
      role="menu"
    >
      <button className="reader-menu-item" role="menuitem" onClick={() => onPatchSettings({ contrastMode: nextContrast })}>
        <span className="check" />
        对照模式
        <span className="value">{contrastLabel[settings.contrastMode]}</span>
      </button>
      <button
        className="reader-menu-item"
        role="menuitemcheckbox"
        aria-checked={settings.maskTranslation}
        onClick={() => onPatchSettings({ maskTranslation: !settings.maskTranslation })}
      >
        <span className="check">{settings.maskTranslation ? <IconCheck size={13} /> : null}</span>
        译文遮罩 · 自测
      </button>
      <button
        className="reader-menu-item"
        role="menuitemcheckbox"
        aria-checked={settings.showProgress}
        onClick={() => onPatchSettings({ showProgress: !settings.showProgress })}
      >
        <span className="check">{settings.showProgress ? <IconCheck size={13} /> : null}</span>
        显示阅读进度
      </button>
      <div className="reader-menu-sep" />
      <button
        className="reader-menu-item"
        role="menuitemcheckbox"
        aria-checked={settings.zenMode}
        onClick={() => onPatchSettings({ zenMode: !settings.zenMode })}
      >
        <span className="check">{settings.zenMode ? <IconCheck size={13} /> : null}</span>
        禅模式 · 隐藏侧栏与播放条
      </button>
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "2px 4px 0" }}>
        <button
          className="reader-tb-btn"
          style={{ width: 24, height: 24 }}
          onClick={onClose}
          title="关闭菜单"
          aria-label="关闭视图菜单"
        >
          <IconClose size={12} />
        </button>
      </div>
    </div>
  );
}
