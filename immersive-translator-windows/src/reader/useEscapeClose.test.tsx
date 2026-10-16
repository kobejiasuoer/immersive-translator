// @vitest-environment jsdom
// 浮层 Esc 关闭（useEscapeClose）的回归用例。
//
// 背景（2026-10-16 审查）：设置抽屉 / 书架浮层 / 跟读练习三处都标了
// role="dialog"，但既没有 aria-modal，也没有 Esc 关闭 —— 键盘用户打开后
// 必须 Tab 到关闭按钮才能退出。修复后需要锁住这个行为，防止回归。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useEscapeClose } from "./useEscapeClose";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pressEscape() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

function mountHook(enabled?: boolean) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const onClose = vi.fn();

  function Probe() {
    useEscapeClose(onClose, enabled);
    return null;
  }

  act(() => root.render(<Probe />));
  return {
    onClose,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("useEscapeClose", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("Escape 触发 onClose", () => {
    const h = mountHook();
    cleanups.push(h.unmount);
    pressEscape();
    expect(h.onClose).toHaveBeenCalledExactlyOnceWith();
  });

  it("enabled=false 时不响应 Escape", () => {
    const h = mountHook(false);
    cleanups.push(h.unmount);
    pressEscape();
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it("其他按键不触发", () => {
    const h = mountHook();
    cleanups.push(h.unmount);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it("卸载后不再响应（监听器已清理，不泄漏）", () => {
    const h = mountHook();
    h.unmount();
    pressEscape();
    expect(h.onClose).not.toHaveBeenCalled();
  });
});