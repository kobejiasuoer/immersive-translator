/**
 * 跟读报告开发预览（shadow-preview.html 专用，不进生产构建）：
 * 真实 ShadowReport / ShadowDrill 组件 + mock 评测数据（ISE 真实返回结构），
 * 浏览器里人工验收与截图。评测/录音需要 Tauri 环境，在浏览器里不可用属预期。
 */

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ShadowReport, type DrillEntry } from "./ShadowReport";
import { ShadowDrill } from "./ShadowDrill";
import { mapWordsToText, type PronunciationResult, type WordScore } from "../core/pronunciation";
import "../styles.css";
import "./reader.css";

// 开发预览专用：渲染期错误直接钉在页面上（无控制台可看时的逃生门）
for (const kind of ["error", "unhandledrejection"] as const) {
  window.addEventListener(kind, (e) => {
    const msg = e instanceof ErrorEvent ? `${e.message} @ ${e.filename}:${e.lineno}` : String((e as PromiseRejectionEvent).reason);
    const d = document.createElement("div");
    d.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:999;background:#dc2626;color:#fff;font:12px monospace;padding:6px 10px;white-space:pre-wrap";
    d.textContent = `${kind}: ${msg}`;
    document.body.appendChild(d);
  });
}

const TARGET =
  "Sure! One large oat milk latte coming up — that'll be four fifty. Would you like anything else today?";

function w(content: string, totalScore: number, dpMessage = 0, sylls: WordScore["sylls"] = []): WordScore {
  return { content, totalScore, dpMessage, sylls };
}

/** latte 的真实音素结构（gwpp 惩罚最大的是 aa）。 */
const LATTE_SYLLS: WordScore["sylls"] = [
  {
    content: "l aa t ey",
    syllScore: 2.1,
    serrMsg: 0,
    phones: [
      { content: "l", dpMessage: 0, gwpp: -0.01 },
      { content: "aa", dpMessage: 0, gwpp: -1.9 },
      { content: "t", dpMessage: 0, gwpp: -0.05 },
      { content: "ey", dpMessage: 0, gwpp: -0.1 },
    ],
  },
];

const FIFTY_SYLLS: WordScore["sylls"] = [
  {
    content: "f ih f t iy",
    syllScore: 2.6,
    serrMsg: 0,
    phones: [
      { content: "f", dpMessage: 0, gwpp: -0.02 },
      { content: "ih", dpMessage: 0, gwpp: -1.2 },
      { content: "f", dpMessage: 0, gwpp: -0.03 },
      { content: "t", dpMessage: 0, gwpp: -0.04 },
      { content: "iy", dpMessage: 0, gwpp: -0.06 },
    ],
  },
];

/** 第 2 次：4.1，差 0.1 过关，短板流畅度。 */
const WORDS_FAIL: WordScore[] = [
  w("Sure", 4.8),
  w("One", 4.6),
  w("large", 4.7),
  w("oat", 4.9),
  w("milk", 4.4),
  w("latte", 2.4, 0, LATTE_SYLLS),
  w("coming", 4.3),
  w("up", 4.5),
  w("that'll", 4.2),
  w("be", 4.8),
  w("four", 4.0),
  w("fifty", 2.8, 0, FIFTY_SYLLS),
  w("Would", 4.4),
  w("you", 4.9),
  w("like", 4.6),
  w("anything", 3.6),
  w("else", 0, 16), // 漏读
  w("today", 4.7),
];

/** 第 3 次：4.7 过关，差词都上来了。 */
const WORDS_PASS: WordScore[] = WORDS_FAIL.map((x) =>
  x.content === "latte" ? { ...x, totalScore: 4.5 } : x.content === "fifty" ? { ...x, totalScore: 4.6 } : x.content === "anything" ? { ...x, totalScore: 4.4 } : x.content === "else" ? w("else", 4.4) : x,
);

const RESULT_FAIL: PronunciationResult = {
  total: 4.1,
  accuracy: 4.3,
  fluency: 3.4,
  standard: 4.2,
  integrity: 4.6,
  isRejected: false,
  exceptInfo: null,
  words: WORDS_FAIL,
};

const RESULT_PASS: PronunciationResult = {
  ...RESULT_FAIL,
  total: 4.7,
  accuracy: 4.8,
  fluency: 4.6,
  integrity: 5,
  words: WORDS_PASS,
};

function drillEntries(target: string, result: PronunciationResult): DrillEntry[] {
  const marks = mapWordsToText(target, result.words);
  return marks
    .filter((m) => m.quality === "bad" || m.quality === "missed")
    .slice(0, 4)
    .map((m) => ({ text: target.slice(m.start, m.end), mark: m }));
}

type Mode = "fail" | "pass" | "rejected" | "novoice";

const MODE_LABELS: Record<Mode, string> = {
  fail: "4.1 差一点",
  pass: "4.7 过关",
  rejected: "乱读",
  novoice: "没声音",
};

function Preview() {
  const [mode, setMode] = useState<Mode>("fail");
  const [drillOpen, setDrillOpen] = useState(false);
  const [toast, setToast] = useState("");

  const say = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 1800);
  };

  const isFail = mode === "fail";
  const result = mode === "pass" ? RESULT_PASS : RESULT_FAIL;
  const marks = mapWordsToText(TARGET, result.words);

  return (
    <div
      className="reader-root"
      data-theme="light"
      style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "8px 14px", fontSize: 12, color: "var(--text-3)", borderBottom: "1px solid var(--border)" }}>
        <span>跟读报告开发预览 · 真实组件 + mock 数据</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
            <button
              key={m}
              className="review-mode-btn"
              style={m === mode ? { background: "var(--accent-soft)", color: "var(--accent)" } : undefined}
              onClick={() => { setMode(m); setDrillOpen(false); }}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </span>
      </div>

      <div className="speak-room" style={{ flex: 1, minHeight: 0 }}>
        <div className="speak-room-head">
          <button className="btn btn-ghost btn-sm">← 换场景</button>
          <span className="speak-room-title">🍜 点餐 · 日常</span>
          <span className="speak-round-count">第 2 轮</span>
        </div>

        <div className="speak-log">
          <div className="speak-bubble assistant">
            <div className="en serif">Hi there! Welcome in. What can I get started for you today?</div>
            <div className="zh">你好，欢迎光临！今天想吃点什么？</div>
          </div>
          <div className="speak-bubble user">
            <div className="en">Hi, I'd like a large latte with oat milk, please.</div>
          </div>
          <div className="speak-bubble assistant">
            <div className="en serif">{TARGET}</div>
            <div className="zh">好嘞，一杯大杯燕麦拿铁——一共四块五。还需要点别的吗？</div>
          </div>

          {(mode === "fail" || mode === "pass") && (
            <ShadowReport
              target={TARGET}
              result={result}
              marks={marks}
              attemptTotals={mode === "pass" ? [3.6, 4.1, 4.7] : [3.6, 4.1]}
              onAgain={() => say("🎤 再跟读整句（演示）")}
              onDrill={(entries) => { setDrillOpen(true); say(`🎯 词练：${entries.map((e) => e.text).join(" / ")}`); }}
              onHearModel={() => say("🔊 播放 AI 领读（演示）")}
              onHearMine={mode === "pass" ? null : () => say("▶ 回放你的录音（演示）")}
              onSpeakWord={(word) => say(`🔊 ${word}（演示）`)}
            />
          )}

          {mode === "rejected" && (
            <div className="speak-report-err">
              <div className="re-title">✗ 读的好像不是这句话</div>
              <div>不用灰心——可能句子太长跟丢了。先听一遍领读，照着文字再试一次。</div>
              <div className="rc-actions">
                <button className="rc-btn primary" onClick={() => say("🔊 播放领读（演示）")}>🔊 听领读</button>
                <button className="rc-btn" onClick={() => say("🎤 再跟读（演示）")}>🎤 再跟读</button>
              </div>
            </div>
          )}

          {mode === "novoice" && (
            <div className="speak-report-err novoice">
              <div className="re-title">· 没听到你的声音</div>
              <div>离麦克风近一点，按住按钮读完这一句再松开。</div>
              <div className="rc-actions">
                <button className="rc-btn primary" onClick={() => say("🎤 重新跟读（演示）")}>🎤 重新跟读</button>
              </div>
            </div>
          )}
        </div>

        <div className="speak-controls">
          <div className="speak-controls-row">
            <button className="speak-hold-btn">按住说话</button>
            <button className="btn btn-secondary">{isFail || mode === "pass" ? `跟读 ${result.total.toFixed(1)} 分 · 再跟读` : "跟读打分"}</button>
            <button className="speak-replay">🔊 重听</button>
          </div>
          <div className="speak-hint">按住说话（英语）→ AI 回复带中文提示；「跟读打分」照 AI 最新一句读，报告卡会告诉你差在哪</div>
        </div>

        {drillOpen && (
          <ShadowDrill
            entries={drillEntries(TARGET, RESULT_FAIL)}
            micDeviceId=""
            onToast={(m) => say(m)}
            onSpeakWord={(word) => say(`🔊 ${word}（演示）`)}
            onClose={() => setDrillOpen(false)}
            onDone={() => { setDrillOpen(false); say("🎤 回整句再跟读（演示）"); }}
          />
        )}
      </div>

      {toast && (
        <div style={{ position: "fixed", left: "50%", bottom: 90, transform: "translateX(-50%)", fontSize: 12, color: "var(--text-2)", background: "var(--surface)", border: "1px solid var(--border-strong)", padding: "6px 14px", borderRadius: 999, boxShadow: "0 4px 14px rgba(16,24,40,.12)" }}>
          {toast}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
