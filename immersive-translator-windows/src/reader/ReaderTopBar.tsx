/**
 * 顶部外壳三段（2026-10-26 阅读页重构，原型 .topbar grid 1fr auto 1fr）：
 * 左 .shell-brand（monogram「I」→ onHome + 书架抽屉触发器：书架 · 当前书名）
 * 中 .shell-tabs（阅读 / 口语 / 笔记与复习 三档，vault 档角标 =
 *   待复习词 + 未整理进笔记的生词）
 * 右 .shell-tools（全文检索 · 主题选择 · 阅读设置抽屉）
 * 布局与皮肤规则见 reader.css「外壳重构 2026-10-26」横幅（.shell-* 全局骨架，
 * 四视图共用平面胶囊）；根类 .floating-top-stage 保留（矮窗规则续命）。
 * 视图菜单（§7）仍由本文件导出——ReaderApp 在 viewMenuAnchor 处挂载，
 * PlayBar 只通过 onOpenViewMenu 回调触发。
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  IconBookOpen,
  IconCheck,
  IconChevronDown,
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

const THEME_OPTIONS: { value: ReaderTheme; label: string; description: string; surface: string; ink: string }[] = [
  { value: "light", label: "纸书", description: "温暖纸面", surface: "#F6F3EC", ink: "#171614" },
  { value: "dark", label: "深色", description: "柔和深灰", surface: "#0E1014", ink: "#F4F2ED" },
  { value: "sepia", label: "护眼", description: "灰绿底色", surface: "#EEF1EF", ink: "#131B18" },
  { value: "oled", label: "纯黑", description: "更低亮度", surface: "#0a0a0b", ink: "#F4F2ED" },
];

function ReaderThemePicker({ theme, onSelect }: { theme: ReaderTheme; onSelect: (theme: ReaderTheme) => void }) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const initialFocusRef = useRef<number | null>(null);
  const closeOnBlurRef = useRef(false);
  const menuId = useId();
  const selectedIndex = Math.max(0, THEME_OPTIONS.findIndex((option) => option.value === theme));
  const selected = THEME_OPTIONS[selectedIndex];

  useEffect(() => {
    if (!open) return;
    optionRefs.current[initialFocusRef.current ?? selectedIndex]?.focus();
    initialFocusRef.current = null;
    function onPointerDown(event: PointerEvent) {
      if (!pickerRef.current?.contains(event.target as Node)) {
        closeOnBlurRef.current = false;
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, selectedIndex]);

  function openMenu(index = selectedIndex) {
    initialFocusRef.current = index;
    closeOnBlurRef.current = false;
    setOpen(true);
  }

  function closeMenu(returnFocus = false) {
    closeOnBlurRef.current = false;
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function selectTheme(value: ReaderTheme) {
    onSelect(value);
    closeMenu(true);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    // ReaderApp 的播放快捷键只排除输入控件；主题按钮和选项自行隔离键盘事件。
    event.stopPropagation();
    if (event.key === "Tab") {
      // 等默认焦点移动产生 blur 后关闭，避免提前移除选项导致 Tab 丢失落点。
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
    const focusedIndex = optionRefs.current.findIndex((option) => option === event.target);
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (focusedIndex >= 0 && open) selectTheme(THEME_OPTIONS[focusedIndex].value);
      else if (open) closeMenu();
      else openMenu();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    let nextIndex = focusedIndex >= 0 ? focusedIndex : selectedIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = THEME_OPTIONS.length - 1;
    else if (open) {
      nextIndex = (nextIndex + (event.key === "ArrowDown" ? 1 : -1) + THEME_OPTIONS.length) % THEME_OPTIONS.length;
    }
    if (open) optionRefs.current[nextIndex]?.focus();
    else openMenu(nextIndex);
  }

  return (
    <div
      ref={pickerRef}
      className="reader-theme-picker"
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        // H 可能在正文按下；放行释放事件，让 ReaderApp 清理临时揭示状态。
        if (event.key !== "h" && event.key !== "H") event.stopPropagation();
      }}
      onBlur={(event) => {
        if (closeOnBlurRef.current || !event.currentTarget.contains(event.relatedTarget as Node)) closeMenu();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="reader-theme-trigger"
        data-theme-trigger
        aria-label={`阅读主题：${selected.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? closeMenu() : openMenu())}
      >
        <span className="reader-theme-trigger-label">主题</span>
        <span className="reader-theme-dot" style={{ background: selected.surface }} aria-hidden />
        <span>{selected.label}</span>
        <IconChevronDown size={12} />
      </button>
      {open && (
        <div className="reader-theme-menu" role="menu" id={menuId} aria-labelledby={`${menuId}-title`}>
          <div className="reader-theme-menu-title" id={`${menuId}-title`}>阅读主题</div>
          {THEME_OPTIONS.map((option, index) => (
            <button
              key={option.value}
              ref={(element) => { optionRefs.current[index] = element; }}
              type="button"
              role="menuitemradio"
              tabIndex={-1}
              className="reader-theme-option"
              data-theme-option={option.value}
              aria-checked={theme === option.value}
              onClick={() => selectTheme(option.value)}
            >
              <span className="reader-theme-swatch" style={{ background: option.surface, color: option.ink }} aria-hidden>Aa</span>
              <span className="reader-theme-option-text"><span>{option.label}</span><small>{option.description}</small></span>
              <span className="reader-theme-check" aria-hidden>{theme === option.value ? <IconCheck size={15} /> : null}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
        <ReaderThemePicker theme={settings.theme} onSelect={(theme) => onPatchSettings({ theme })} />
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
