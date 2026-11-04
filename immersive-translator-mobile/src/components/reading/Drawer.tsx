/**
 * 阅读域抽屉底座（reading-parity）。
 * 为什么不走全局 SheetHost：新抽屉 kind 的渲染开关在 ui/sheets.tsx（本阶段文件范围外），
 * 这里以 portal 复用同一套 .sheet/.sheet-dim 视觉与键盘避让（--kb-inset），
 * 语义与交互（role=dialog、下拉关闭 >120px 或快速轻扫）与 SheetHost 同口径。
 * z 序：42/43 —— 在 push(40) 之上、全局 sheet(44/45) 之下：抽屉内再开词典卡时词典卡盖在上层。
 * portal 容器挂 .app（而非 body）：.app 是 position:fixed 的层叠上下文，全局词典卡（.app 内 z45）
 * 与本抽屉（body 上 z42/43）分属两个上下文时，词典卡永远画不到抽屉之上——挂进同一上下文恢复既定层序。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../ui/icons";
import { attachSheetDrag } from "../../ui/sheetDrag";

export function ReadingDrawer({
  open,
  onClose,
  label,
  layer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** 读屏名称（role=dialog 的 aria-label）。 */
  label: string;
  /** 账号设置的子抽屉挂到 body，盖过账号面板。 */
  layer?: "account";
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  /* portal 容器：.app（层叠上下文同源，保证词典卡 > 阅读抽屉 > push） */
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(layer === "account" ? document.body : document.querySelector(".app"));
  }, [layer]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel || layer !== "account") return;
    const previous = document.activeElement as HTMLElement | null;
    panel.querySelector<HTMLElement>("button,input,select")?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')];
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    };
    panel.addEventListener("keydown", key);
    return () => { panel.removeEventListener("keydown", key); previous?.focus({ preventScroll: true }); };
  }, [open, layer, host]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    return attachSheetDrag(panel, onClose);
  }, [open, onClose, host]);

  if (!host) return null;
  return createPortal(
    <>
      <div className={`sheet-dim ${open ? "on" : ""}`} style={{ zIndex: layer === "account" ? 130 : 42 }} aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`sheet ${open ? "on" : ""}`}
        style={{ zIndex: layer === "account" ? 131 : 43 }}
        inert={!open || undefined}
      >
        {/* 抽屉基座头部：grab + 右上 X 关闭钮（proto-parity：与原型各抽屉头部一致） */}
        <div className="sheet-top">
          <div className="sheet-grab" aria-hidden="true">
            <i />
          </div>
          <button type="button" className="sheet-x" aria-label="关闭当前面板" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </>,
    host,
  );
}

/** 抽屉内的三页签条（句子解析/本句生词/本篇词汇 等）。 */
export function DrawerTabs<T extends string>({
  value,
  items,
  onChange,
  ariaLabel,
  className,
}: {
  value: T;
  items: [T, string][];
  onChange: (v: T) => void;
  ariaLabel: string;
  /** 附加样式（如 sh-tabs：胶囊容器 + 白底浮起选中态，原型 .sh-tabs）。 */
  className?: string;
}) {
  return (
    <div className={`learning-seg${className ? ` ${className}` : ""}`} role="tablist" aria-label={ariaLabel}>
      {items.map(([v, labelText]) => (
        <button key={v} role="tab" aria-selected={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
          {labelText}
        </button>
      ))}
    </div>
  );
}
