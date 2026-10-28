import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { installVoiceHttpTransport } from "./lib/voice/voiceRuntimeIpc";

// 语音网关 REST 通道生产接线（voice_http_request 命令，Rust with_auth 管线）：
// 未接线时换票/批量转写/发音评测一调用就抛「语音网关 HTTP 通道未接线」。
// 全部窗口共用本入口，这里装一次即全覆盖；WSS 与 baseUrl 走默认实现无需接线。
installVoiceHttpTransport();

// ErrorBoundary 兜住任意窗口的渲染异常（否则直接白屏）：
// 错误页支持重试 / 关闭窗口 / 复制诊断信息。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
