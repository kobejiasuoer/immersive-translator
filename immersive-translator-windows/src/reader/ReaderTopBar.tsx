/**
 * 顶栏 56px（屏 A）：Logo · 沉浸阅读室 | 文章名 …… 搜索 · 主题 · 帮助。
 * 视图菜单（§7）从顶栏展开：对照模式 / 译文遮罩 / 显示阅读进度 / 禅模式。
 */

import { useEffect, useRef, useState } from "react";
import {
  IconCheck,
  IconClose,
  IconHelp,
  IconSearch,
  IconSettings,
} from "../ui/icons";
import type { ContrastMode, ReaderSettings, ReaderTheme } from "../core/readerTypes";

interface Props {
  articleName: string | null;
  settings: ReaderSettings;
  onPatchSettings: (patch: Partial<ReaderSettings>) => void;
  onOpenDrawer: () => void;
  onSearch: (query: string) => void;
}

const THEME_CYCLE: ReaderTheme[] = ["light", "dark", "sepia", "oled"];

export function ReaderTopBar({ articleName, settings, onPatchSettings, onOpenDrawer, onSearch }: Props) {
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // 点击浮层外部关闭。
  useEffect(() => {
    if (!viewMenuOpen && !helpOpen) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (anchorRef.current && !anchorRef.current.contains(target)) {
        setViewMenuOpen(false);
        setHelpOpen(false);
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [viewMenuOpen, helpOpen]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const themeLabel: Record<ReaderTheme, string> = {
    light: "浅色",
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

  return (
    <header className="reader-topbar">
      <span className="reader-logo" aria-hidden>
        阅
      </span>
      <span className="reader-appname">沉浸阅读室</span>
      {articleName && (
        <span className="reader-article-name" title={articleName}>
          {articleName}
        </span>
      )}
      <div className="spacer" />
      <div className="reader-pop-anchor" ref={anchorRef} style={{ display: "flex", alignItems: "center", gap: 2 }}>
        {searchOpen && (
          <input
            ref={searchInputRef}
            className="input"
            style={{ width: 180, height: 28, padding: "3px 8px" }}
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
          className={`reader-tb-btn${searchOpen ? " active" : ""}`}
          onClick={() => setSearchOpen((v) => !v)}
          title="全文检索（Enter 跳转，Esc 关闭）"
        >
          <IconSearch size={15} />
        </button>
        <button
          className="reader-tb-btn reader-theme-btn"
          onClick={cycleTheme}
          title={`主题：${themeLabel[settings.theme]}（点击切换）`}
        >
          {themeLabel[settings.theme]}
        </button>
        <button
          className={`reader-tb-btn${helpOpen ? " active" : ""}`}
          onClick={() => setHelpOpen((v) => !v)}
          title="帮助与快捷键"
        >
          <IconHelp size={15} />
        </button>
        <button className="reader-tb-btn" onClick={onOpenDrawer} title="阅读设置">
          <IconSettings size={15} />
        </button>

        {helpOpen && (
          <div className="reader-pop reader-help-pop" style={{ top: 40, right: 0 }}>
            <div style={{ fontWeight: 700, marginBottom: 4, color: "var(--text-1)" }}>快捷键</div>
            <div>
              <span className="kbd">Space</span> / <span className="kbd">K</span> 播放 · 暂停
            </div>
            <div>
              <span className="kbd">J</span> 下一句 · <span className="kbd">L</span> 上一句
            </div>
            <div>
              <span className="kbd">H</span>（按住）临时揭开全部译文
            </div>
            <div>
              <span className="kbd">Esc</span> 关闭浮层
            </div>
            <div style={{ marginTop: 6, color: "var(--text-3)" }}>
              译文遮罩开启时，朗读只高亮英文；点单句揭开，再点一次重新遮住。
            </div>
          </div>
        )}
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
        >
          <IconClose size={12} />
        </button>
      </div>
    </div>
  );
}
