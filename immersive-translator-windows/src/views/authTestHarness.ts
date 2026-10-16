/**
 * 视图交互测试的微型挂载台：react-dom/client + React act，不引入新依赖。
 * 仅被 *.test.tsx 引用，不进应用 bundle（无业务代码 import 它）。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactElement } from "react";

// createRoot + act 组合要求显式声明测试环境（React 19）。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

export interface Harness {
  container: HTMLDivElement;
  render(el: ReactElement): void;
  unmount(): void;
}

/** 挂一个可重复 render 的根（等价 renderHook 的宿主）。 */
export function createHarness(): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  return {
    container,
    render(el: ReactElement) {
      act(() => {
        root.render(el);
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** 异步动作（点击后的 Promise 链）包 act，冲刷微任务并消除 act 警告。 */
export async function actAsync(fn: () => Promise<void> | void): Promise<void> {
  await act(async () => {
    await fn();
  });
}

/** 受控输入赋值：走原生 value setter + input 事件，React 才会认。 */
export function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 按可见文本找按钮（trim 后全等）。 */
export function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn as HTMLButtonElement;
}
