import { useState } from "react";
import { useApp, actions, THEME_LABEL, speak, stopSpeak, ttsEvents, type Theme } from "../store";

/**
 * 我的 —— spike 自检面板：
 *  S3a TTS：Web Speech 事件计数（onstart/onend 命中率、耗时）；
 *  S4  BYOK：从 WebView 直连 LLM API，观察 CORS / 网络结果；
 *  主题四套（token 已去 color-mix，iOS 16.0 安全）。
 */
export default function MeScreen() {
  const theme = useApp((s) => s.theme);
  const [ttsTick, setTtsTick] = useState(0);
  const [ttsBusy, setTtsBusy] = useState(false);

  const [endpoint, setEndpoint] = useState("https://api.deepseek.com/chat/completions");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("deepseek-chat");
  const [netResult, setNetResult] = useState("");

  async function testFetch() {
    setNetResult("请求中…");
    const t0 = performance.now();
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: ok" }], max_tokens: 8 }),
      });
      const ms = Math.round(performance.now() - t0);
      const body = await res.text();
      setNetResult(`HTTP ${res.status} · ${ms}ms · ${body.slice(0, 120)}`);
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      setNetResult(`失败（${ms}ms）：${(err as Error).message} —— 若为 CORS/TypeError，spike 记录为「WebView fetch 直连不可行，需走 Rust http 插件」`);
    }
  }

  return (
    <div className="screen">
      <div className="pagehead">
        <div className="large-title">我的</div>
        <div className="page-sub">spike 自检：S3a TTS · S4 BYOK 网络</div>
      </div>

      <div className="sect-label">主题（S7：四主题 + 无 color-mix）</div>
      <div className="card" style={{ display: "flex", gap: 8 }}>
        {(Object.keys(THEME_LABEL) as Theme[]).map((t) => (
          <button key={t} className={`btn sm ${theme === t ? "" : "ghost"}`} onClick={() => actions.setTheme(t)}>
            {THEME_LABEL[t]}
          </button>
        ))}
      </div>

      <div className="sect-label">TTS 自检（S3a · Web Speech）</div>
      <div className="card">
        <div style={{ display: "flex", gap: 10 }}>
          <button
            className="btn sm"
            onClick={() => {
              setTtsBusy(true);
              speak("The idea of car-free streets took root after the summer of heatwaves.", 1, () => {
                setTtsBusy(false);
                setTtsTick((n) => n + 1);
              });
            }}
            disabled={ttsBusy}
          >
            {ttsBusy ? "播放中…" : "播放测试句"}
          </button>
          <button className="btn sm ghost" onClick={() => stopSpeak()}>
            停止
          </button>
        </div>
        <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.8 }}>
          onstart 事件：<b>{ttsEvents.start}</b> · onend 事件：<b>{ttsEvents.end}</b>（渲染 {ttsTick} 次）
          <br />
          若 onend 恒为 0 而播放正常 → 说明走了兜底定时器，spike 记录「WebView onend 不可靠」。
        </div>
      </div>

      <div className="sect-label">BYOK 网络测试（S4）</div>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="endpoint" style={inputStyle} spellCheck={false} />
        <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API Key（仅本页内存，不存储）" type="password" style={inputStyle} spellCheck={false} />
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model" style={inputStyle} spellCheck={false} />
        <button className="btn sm" onClick={testFetch} disabled={!apiKey}>
          发送测试请求
        </button>
        {netResult && (
          <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.7, wordBreak: "break-all" }}>{netResult}</div>
        )}
      </div>

      <div className="sect-label">spike 备忘</div>
      <div className="card" style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.9 }}>
        书架 → 压测文章：全量渲染 600 句，看右上角角标。
        <br />
        复习：完形卡（键盘弹起遮挡检查）。
        <br />
        结果记录进 docs/mobile-spike-report.md。
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  height: 38,
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--surface-2)",
  padding: "0 12px",
  fontSize: 16,
  outline: "none",
};
