/**
 * 账号域抽屉底座（account-onboarding-parity / proto-parity-2026-11-01）。
 * 与 LoginHost 同一套 account-overlay/account-panel 视觉（面板底色不同：本抽屉=surface，
 * 登录主面板=bg，对齐原型 .sheet 与 .view 的底色分工）；createPortal 挂 body。
 * 打开时聚焦首个可操作元素，关闭还原焦点（与 LoginHost 的焦点归还同口径）。
 * 不复用 ui/sheets.tsx 的 SheetHost：新 sheet kind 的渲染开关在彼处，本阶段文件范围外。
 * proto-parity-2026-11-01：对齐原型抽屉三段 chrome（html:1719 + .grab/.sh-head/.sh-body）——
 * 抓手 / 标题行（title 左 + × 右）/ 标题下分隔线 / 内容滚动区；title 可选（无标题时保留
 * 原 grab+× 行为，供无头抽屉使用）。head 不随内容滚动（flex 列 + .acct-body 滚动）。
 */
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../ui/icons";

export function SheetShell({ label, title, sub, zIndex = 130, inert, onClose, children }: {
  label: string;
  /** 标题行文字（原型 .sh-head>b）；缺省时退化为纯 grab+× 行 */
  title?: string;
  /** 标题下的灰色引导句（原型 .sh-head .muted） */
  sub?: string;
  /** 面板层级：子抽屉（规则/隐私/找回密码等）默认 130；账号主抽屉传 118（低于学习方向推入页 126） */
  zIndex?: number;
  /** 上层模态（学习方向推入页/登录推入页）打开时锁住本抽屉，焦点不穿透 */
  inert?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const timer = setTimeout(() => panel.current?.querySelector<HTMLElement>("input:not(:disabled),button:not(:disabled)")?.focus({ preventScroll: true }), 0);
    return () => { clearTimeout(timer); previous?.focus({ preventScroll: true }); };
  }, []);
  return createPortal(
    <div className="account-overlay" style={{ zIndex }} role="dialog" aria-modal="true" aria-label={label} inert={inert || undefined}>
      <div className="account-panel sheet-panel" ref={panel}>
        <div className="sheet-top">
          <div className="sheet-grab" aria-hidden="true">
            <i />
          </div>
          {title === undefined && (
            <button type="button" className="sheet-x" aria-label="关闭当前面板" onClick={onClose}>
              <Icon name="close" size={18} />
            </button>
          )}
        </div>
        {title !== undefined && (
          <div className="acct-head">
            <div className="acct-head-tx">
              <b>{title}</b>
              {sub && <p>{sub}</p>}
            </div>
            <button type="button" className="sheet-x" aria-label="关闭当前面板" onClick={onClose}>
              <Icon name="close" size={18} />
            </button>
          </div>
        )}
        <div className="acct-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
