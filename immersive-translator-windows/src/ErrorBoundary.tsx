/**
 * 统一 ErrorBoundary：任意窗口（panel/settings/reader/…）的渲染异常不再白屏。
 *
 * 错误页提供三个动作：
 * - 重试：清掉错误状态重新渲染子树（各窗口的挂载 effect 会重新初始化）；
 * - 关闭窗口：按常驻窗口策略 hide（托盘/热键可再次打开）；
 * - 复制诊断：窗口 label + 错误堆栈 + 组件栈 + 版本，便于粘贴报障。
 *
 * 只兜「渲染期」异常；事件回调/异步任务里的错误仍由各模块自行处理
 * （ErrorBoundary 拦不到），因此各调用点 catch 后的展示逻辑保持不变。
 */
import { Component, useCallback, useState, type ErrorInfo, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
  copied: boolean;
}

function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return new URLSearchParams(window.location.search).get("window") ?? "panel";
  }
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, copied: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[error-boundary] render crashed", error, info.componentStack);
    this.setState({ info });
  }

  private reset = () => {
    this.setState({ error: null, info: null, copied: false });
  };

  private closeWindow = () => {
    try {
      const win = getCurrentWindow();
      // 常驻窗口 hide 优先（托盘还能再开）；hide 失败才真关闭。
      void win.hide().catch(() => void win.close());
    } catch {
      void window.close();
    }
  };

  private copyDiagnostics = async () => {
    const version = await getVersion().catch(() => "unknown");
    const { error, info } = this.state;
    const lines = [
      "ImmersiveTranslator 界面诊断",
      `窗口: ${windowLabel()}`,
      `版本: ${version}`,
      `时间: ${new Date().toISOString()}`,
      `UA: ${navigator.userAgent}`,
      `错误: ${error?.name ?? "?"}: ${error?.message ?? "?"}`,
      error?.stack ? `堆栈:\n${error.stack}` : "",
      info?.componentStack ? `组件栈:${info.componentStack}` : "",
    ].filter(Boolean);
    void navigator.clipboard
      .writeText(lines.join("\n"))
      .then(() => this.setState({ copied: true }))
      .catch(() => undefined);
  };

  render() {
    const { error, info, copied } = this.state;
    if (!error) return this.props.children;
    return (
      <ErrorPage
        error={error}
        componentStack={info?.componentStack ?? null}
        copied={copied}
        onRetry={this.reset}
        onClose={this.closeWindow}
        onCopy={this.copyDiagnostics}
      />
    );
  }
}

function ErrorPage({
  error,
  componentStack,
  copied,
  onRetry,
  onClose,
  onCopy,
}: {
  error: Error;
  componentStack: string | null;
  copied: boolean;
  onRetry: () => void;
  onClose: () => void;
  onCopy: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const expand = useCallback(() => setExpanded((v) => !v), []);
  return (
    <div style={S.root}>
      <div style={S.card}>
        <div style={S.badge} aria-hidden>
          !
        </div>
        <h1 style={S.title}>界面出了点问题</h1>
        <p style={S.sub}>
          这个窗口渲染时遇到错误，其余功能不受影响。重试通常可以恢复；若反复出现，请复制诊断信息反馈。
        </p>
        <pre style={S.err}>{expanded ? error.stack || `${error.name}: ${error.message}` : `${error.name}: ${error.message}`}</pre>
        {componentStack && expanded && <pre style={S.err}>{componentStack.trim()}</pre>}
        <div style={S.actions}>
          <button type="button" style={S.primary} onClick={onRetry}>
            重试
          </button>
          <button type="button" style={S.secondary} onClick={onCopy}>
            {copied ? "已复制 ✓" : "复制诊断信息"}
          </button>
          <button type="button" style={S.secondary} onClick={onClose}>
            关闭窗口
          </button>
          <button type="button" style={S.link} onClick={expand}>
            {expanded ? "收起详情" : "查看详情"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 内联样式：不依赖任何窗口的 CSS 上下文（崩溃时全局样式也可能未加载完）。 */
const S: Record<string, React.CSSProperties> = {
  root: {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#f4f5f9",
    color: "#1c2029",
    fontFamily: "'Inter', 'Noto Sans SC', system-ui, sans-serif",
    padding: 24,
    overflow: "auto",
  },
  card: {
    width: "100%",
    maxWidth: 520,
    background: "#fff",
    border: "1px solid #e4e7ee",
    borderRadius: 16,
    padding: "28px 28px 24px",
    boxShadow: "0 12px 40px rgba(28,32,41,0.08)",
    textAlign: "center",
  },
  badge: {
    width: 44,
    height: 44,
    margin: "0 auto 14px",
    borderRadius: "50%",
    background: "#fdecec",
    color: "#d64545",
    fontSize: 24,
    fontWeight: 700,
    lineHeight: "44px",
  },
  title: { margin: "0 0 8px", fontSize: 18, fontWeight: 600 },
  sub: { margin: "0 0 14px", fontSize: 13, lineHeight: 1.7, color: "#4b5261" },
  err: {
    margin: 0,
    padding: 10,
    maxHeight: 120,
    overflow: "auto",
    textAlign: "left",
    fontSize: 11,
    lineHeight: 1.5,
    color: "#7c8494",
    background: "#f8f9fc",
    border: "1px solid #e4e7ee",
    borderRadius: 8,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
  actions: {
    marginTop: 18,
    display: "flex",
    gap: 10,
    justifyContent: "center",
    alignItems: "center",
    flexWrap: "wrap",
  },
  primary: {
    padding: "8px 18px",
    borderRadius: 8,
    border: "none",
    background: "#4c5ff0",
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  secondary: {
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid #e4e7ee",
    background: "#fff",
    color: "#4b5261",
    fontSize: 13,
    cursor: "pointer",
  },
  link: {
    padding: 0,
    border: "none",
    background: "none",
    color: "#7c8494",
    fontSize: 12,
    cursor: "pointer",
    textDecoration: "underline",
  },
};
