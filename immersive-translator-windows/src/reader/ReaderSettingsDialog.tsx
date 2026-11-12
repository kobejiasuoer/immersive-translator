import { useCallback, useEffect, useRef } from "react";
import { Settings, type SettingsTab } from "../views/Settings";
import { ReaderSettingsContent, type ReaderSettingsContentProps } from "./SettingsDrawer";

interface Props extends Omit<ReaderSettingsContentProps, "onOpenSettingsTab"> {
  open: boolean;
  /** 等待 ReaderApp 完成阅读配置读取及旧语音设置迁移，避免默认值覆盖已存配置。 */
  readingReady: boolean;
  initialTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onClose: () => void;
  /** 原生 dialog 真正关闭后调用，供阅读室归还入口焦点。 */
  onClosed?: () => void;
  onReset: () => void;
  onVoicePrefsChanged: () => void;
  articleTitle?: string;
}

/** 保持设置表单挂载以保留草稿；原生模态框负责焦点圈定、背景隔离与关闭后归还焦点。 */
export function ReaderSettingsDialog({
  open, readingReady, initialTab, onTabChange, onClose, onClosed, onReset, onVoicePrefsChanged, articleTitle,
  ...readingProps
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const escapeHandlerRef = useRef<(() => void) | null>(null);
  const registerEscapeHandler = useCallback((handler: (() => void) | null) => {
    escapeHandlerRef.current = handler;
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) {
      dialog.close();
      onClosed?.();
    }
  }, [onClosed, open]);

  return (
    <dialog
      ref={dialogRef}
      className="reader-settings-dialog"
      aria-label="设置"
      aria-modal="true"
      // Esc 交给 Settings：录制快捷键或确认弹窗期间不能关闭整个设置界面。
      onCancel={(event) => {
        event.preventDefault();
        escapeHandlerRef.current?.();
      }}
    >
      <Settings
        initialTab={initialTab}
        visible={open}
        onClose={onClose}
        onTabChange={onTabChange}
        onEscapeRef={registerEscapeHandler}
        onVoicePrefsChanged={onVoicePrefsChanged}
        renderReading={(navigate) => (
          <>
            <header className="set-pagehead">
              <div className="set-pagehead-text">
                <h2>阅读与练习</h2>
                <p>{articleTitle
                  ? `阅读偏好即时保存，同时应用于默认值与当前文章《${articleTitle}》。`
                  : "设置阅读版式、朗读、跟读与复习习惯，修改即时保存。"}</p>
              </div>
            </header>
            {readingReady ? (
              <>
                {open && <ReaderSettingsContent {...readingProps} onOpenSettingsTab={navigate} />}
                <div className="reader-settings-reset">
                  <button className="btn btn-secondary" onClick={onReset}>恢复阅读默认</button>
                </div>
              </>
            ) : (
              <p className="field-hint" role="status">正在读取阅读设置…</p>
            )}
          </>
        )}
      />
    </dialog>
  );
}
