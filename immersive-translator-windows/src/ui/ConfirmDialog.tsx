import { useEffect, useRef } from "react";
import { IconAlert, IconAlertCircle } from "./icons";

/**
 * 应用内确认弹窗（替代原生 window.confirm）。
 * 观感与主题统一、键盘可操作：Esc 取消、Tab 聚焦安全。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = "确定",
  cancelText = "取消",
  danger = true,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    // 打开后聚焦到「确定」，避免误触取消类快捷键
    const t = window.setTimeout(() => confirmRef.current?.focus(), 30);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        // 点击遮罩空白处 = 取消
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="modal" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className={`modal-title${danger ? " danger" : ""}`}>
          {danger ? <IconAlertCircle size={17} /> : <IconAlert size={17} />}
          {title}
        </div>
        <div className="modal-body">{message}</div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onCancel}>
            {cancelText}
          </button>
          <button
            ref={confirmRef}
            className={danger ? "btn btn-danger-solid" : "btn btn-primary"}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
