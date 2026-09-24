import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";

// ErrorBoundary 兜住任意窗口的渲染异常（否则直接白屏）：
// 错误页支持重试 / 关闭窗口 / 复制诊断信息。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
