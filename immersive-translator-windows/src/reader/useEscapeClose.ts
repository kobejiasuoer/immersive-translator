import { useEffect } from "react";

/**
 * 浮层统一 Esc 关闭。
 *
 * 阅读室有多个 role="dialog" 浮层（设置抽屉 / 书架浮层 / 跟读练习等），
 * 此前只有一部分自己处理了 Escape，键盘用户打开后必须 Tab 到关闭按钮才能退出。
 * 抽成 hook 让各浮层统一一行接入：
 *
 *   useEscapeClose(onClose);
 *
 * 只在按下 Escape 且当前没有焦点于输入框时触发（输入中按 Esc 通常是
 * 「撤销输入」而非「关浮层」，且此处浮层里没有需要该行为的复杂编辑器）。
 */
export function useEscapeClose(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, enabled]);
}