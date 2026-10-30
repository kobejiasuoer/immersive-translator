import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { actions, initializeStore } from "./store";
import "./ui/tokens.css";
import "./ui/base.css";
import "./ui/learning.css";
import { cloudState, restoreCloud } from "./services/cloud";
import { startSync } from "./services/sync";
import { recoverPendingGuestClaim } from "./services/authGate";

/**
 * 全局渲染兜底（治 shell-6）：push 栈里 20+ 个屏幕任意一个渲染期抛错，
 * 没有边界会卸载整棵根树 → 白屏无提示无恢复。此处兜底并给两条出路：
 *  · 重试：清错误态重挂载 App（push 栈随之清空，从当前 Tab 顶重进）；
 *  · 回阅读：重挂载前经 store 动作切回阅读 Tab（store 在 React 树外，白屏时仍可用）。
 * 崩溃信息入诊断汇（随 store 落盘，真机可事后拉库归因）。
 */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: string | null }> {
  state: { err: string | null } = { err: null };

  static getDerivedStateFromError(err: unknown) {
    return { err: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: unknown, info: React.ErrorInfo) {
    const where = info.componentStack
      ?.split("\n")
      .map((s) => s.trim())
      .filter(Boolean)[0];
    actions.pushDiag({
      time: Date.now(),
      kind: "react",
      msg: `渲染崩溃：${err instanceof Error ? err.message : String(err)}${where ? `（${where}）` : ""}`,
    });
  }

  reset(toReading: boolean) {
    if (toReading) actions.setTab("today");
    this.setState({ err: null });
  }

  render() {
    if (this.state.err === null) return this.props.children;
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 99,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 32px",
          background: "var(--bg)",
          textAlign: "center",
        }}
      >
        <div className="serif" style={{ fontSize: 24, fontWeight: 600, lineHeight: "34px" }}>
          页面出了点问题
        </div>
        <div className="meta" style={{ marginTop: 10, wordBreak: "break-all" }}>
          {this.state.err.slice(0, 160)}
        </div>
        <button className="btn" style={{ marginTop: 26, width: 200 }} onClick={() => this.reset(false)}>
          重试
        </button>
        <button className="btn-ghost tlink" style={{ marginTop: 10, width: 200, border: "1px solid var(--hairline-strong)" }} onClick={() => this.reset(true)}>
          回阅读
        </button>
      </div>
    );
  }
}

const root = ReactDOM.createRoot(document.getElementById("root")!);
let disposed = false;
let stopSync: (() => void) | null = null;
async function boot() {
  if (disposed) return;
  root.render(<div className="boot-state"><h1>沉浸阅读室</h1><p>正在载入这台设备的学习资料…</p></div>);
  try {
    await restoreCloud();
    if (disposed) return;
    await initializeStore(cloudState().account?.id ?? "guest");
    if (disposed) return;
    await recoverPendingGuestClaim();
    if (disposed) return;
    root.render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);
    stopSync = startSync();
  } catch(error) {
    if (disposed) return;
    root.render(<div className="boot-state" role="alert"><h1>资料暂时未能载入</h1><p>{error instanceof Error ? error.message : String(error)}</p><p>现有资料仍保留，没有重置。</p><button className="btn" onClick={() => void boot()}>重试载入</button></div>);
  }
}
const onStorageError = (event: Event) => {
  const message = String((event as CustomEvent).detail);
  root.render(<div className="boot-state" role="alert"><h1>本地保存遇到问题</h1><p>{message}</p><p>请保留当前窗口。为避免覆盖资料，已停止后续写入。</p><button className="btn" onClick={() => location.reload()}>重新载入已保存资料</button></div>);
};
window.addEventListener("mobile-storage-error", onStorageError);
void boot();

/* WKWebView 需要页面有过触摸监听才激活 :active 按压态（U-23）——挂一个空监听即可，
   被动不参与滚动冲突 */
const onTouchStart = () => {};
document.addEventListener("touchstart", onTouchStart, { passive: true });
if (import.meta.hot) import.meta.hot.dispose(() => {
  disposed = true;
  stopSync?.();
  window.removeEventListener("mobile-storage-error", onStorageError);
  document.removeEventListener("touchstart", onTouchStart);
  root.unmount();
});
