import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { actions } from "./store";
import "./ui/tokens.css";
import "./ui/base.css";

/**
 * 全局渲染兜底（治 shell-6）：push 栈里 20+ 个屏幕任意一个渲染期抛错，
 * 没有边界会卸载整棵根树 → 白屏无提示无恢复。此处兜底并给两条出路：
 *  · 重试：清错误态重挂载 App（push 栈随之清空，从当前 Tab 顶重进）；
 *  · 回今天：重挂载前经 store 动作切回今天 Tab（store 在 React 树外，白屏时仍可用）。
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

  reset(toToday: boolean) {
    if (toToday) actions.setTab("today");
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
          回今天
        </button>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

/* WKWebView 需要页面有过触摸监听才激活 :active 按压态（U-23）——挂一个空监听即可，
   被动不参与滚动冲突 */
document.addEventListener(
  "touchstart",
  () => {},
  { passive: true },
);
