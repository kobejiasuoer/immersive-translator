/**
 * 口语陪练开发预览（speak-preview.html 专用，不进生产构建）：
 * 真实 SpeakView + mock 的 Tauri invoke / TTS / 麦克风流，浏览器里验收四个状态。
 * 用法：?s=idle|rec|done|err  &theme=light|dark|sepia|oled
 * 评测/听写/LLM 需要网络与凭据，这里不接，预览只覆盖界面与本地状态逻辑。
 */

import { createRoot } from "react-dom/client";
import { SpeakView } from "./SpeakView";
import type { SpeakSession } from "../core/speakLogic";
import type { WordScore } from "../core/pronunciation";
import type { ReaderTheme, VocabWord } from "../core/readerTypes";
import { initialSrs } from "../core/readerSrs";
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

const params = new URLSearchParams(location.search);
const STATE = params.get("s") ?? "idle";
// ?listen=1：先把听力模式偏好写进 localStorage 再挂组件（组件初始化时读取）
if (params.get("listen") === "1") {
  try {
    localStorage.setItem("immersive-translator-speak-listen-mode", "1");
  } catch {
    /* ignore */
  }
}
const THEME = (params.get("theme") ?? "light") as ReaderTheme;

// ---------- 假数据：与截图里的「今日生词造句闯关」一致 ----------

const NOW = Date.now();
const TARGETS: [string, string][] = [
  ["volunteers", "志愿者（volunteer 的复数形式）"],
  ["inconsistent with", "与……不一致"],
  ["standardize", "使标准化；使符合统一标准"],
  ["inconsistency", "不一致；矛盾；前后不一致之处"],
  ["fix a command", "修复命令"],
];
const VOCAB: VocabWord[] = TARGETS.map(([word, cn]) => ({
  id: word,
  word,
  senses: [{ pos: "n.", cn }],
  source: { articleId: "a1", sentenceIdx: 0 },
  srs: initialSrs(NOW),
  addedAt: NOW,
}));

const w = (content: string, totalScore: number, sylls: WordScore["sylls"] = []): WordScore => ({
  content,
  totalScore,
  dpMessage: 0,
  sylls,
});
/** guide 的结尾 /d/ 被吞：gwpp 惩罚最大的是 d。 */
const GUIDE_SYLLS: WordScore["sylls"] = [
  {
    content: "g ay d",
    syllScore: 3.0,
    serrMsg: 0,
    phones: [
      { content: "g", dpMessage: 0, gwpp: -0.02 },
      { content: "ay", dpMessage: 0, gwpp: -0.1 },
      { content: "d", dpMessage: 0, gwpp: -1.6 },
    ],
  },
];
const USER_TEXT = "I would give all the volunteers the same guide, so their answers are not inconsistent with each other.";
const DONE_SESSION: SpeakSession = {
  id: "preview-session",
  scenario: "smalltalk",
  difficulty: "medium",
  createdAt: NOW - 120_000,
  updatedAt: NOW - 30_000,
  context: { kind: "vocab", wordIds: TARGETS.map(([word]) => word) },
  turns: [
    {
      role: "assistant",
      text: "Imagine you're organizing a weekend book fair. You have a lot of volunteers, but they keep giving visitors different answers. What would you do about it?",
      hintZh: "想象你在组织周末书市，志愿者给访客的答案总不一样。你会怎么办？",
      at: NOW - 120_000,
    },
    {
      role: "user",
      text: USER_TEXT,
      at: NOW - 60_000,
      pron: {
        at: NOW - 60_000,
        total: 4.2,
        accuracy: 4.0,
        fluency: 4.4,
        integrity: 5,
        words: [
          w("I", 4.8), w("would", 4.6), w("give", 4.5), w("all", 4.7), w("the", 4.4), w("volunteers", 4.2),
          w("the", 4.5), w("same", 4.6), w("guide", 3.0, GUIDE_SYLLS), w("so", 4.7), w("their", 4.1),
          w("answers", 3.4), w("are", 4.6), w("not", 4.8), w("inconsistent", 4.3), w("with", 4.5),
          w("each", 4.6), w("other", 4.4),
        ],
      },
    },
    {
      role: "assistant",
      text: "That's a smart move. And if a visitor complains about a mistake, how would you standardize the way your team handles it?",
      hintZh: "这招很聪明。如果有访客投诉出了错，你会怎样统一团队的处理方式？",
      at: NOW - 30_000,
    },
  ],
};

// ---------- mock：Tauri invoke / TTS / 麦克风 ----------

type Win = Window & { __TAURI_INTERNALS__?: unknown };
(window as Win).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  unregisterCallback: () => undefined,
  invoke: async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    switch (cmd) {
      case "speak_list_sessions":
        return STATE === "done" ? [DONE_SESSION] : [];
      case "speak_save_session":
        return args?.session ?? null;
      case "scenario_cache_read":
      case "sync_store_list":
        return [];
      case "scenario_fetch_official":
        return { status: 404, body: "", retryAfterSeconds: null };
      case "secret_exists":
        return false;
      case "secret_get":
        return "";
      default:
        return null;
    }
  },
};

/** 合成的「说话」音：带 2.5Hz 起伏的 180Hz 音，让录音电平有真实的涨落。 */
function fakeMicStream(): MediaStream {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  osc.frequency.value = 180;
  const gain = ctx.createGain();
  gain.gain.value = 0.3;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 2.5;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.25;
  lfo.connect(lfoGain).connect(gain.gain);
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();
  lfo.start();
  void ctx.resume();
  return dest.stream;
}
if (navigator.mediaDevices) {
  navigator.mediaDevices.getUserMedia = async () => {
    if (STATE === "err") throw new DOMException("Permission denied", "NotAllowedError");
    return fakeMicStream();
  };
}

// TTS stub：400ms 后回 ended，让 speaking → idle 的状态机真实走一遍
const endedHandlers = new Set<(e: { gen: number; track: string }) => void>();
let gen = 0;
const speakEn = async (): Promise<number> => {
  const mine = ++gen;
  window.setTimeout(() => endedHandlers.forEach((h) => h({ gen: mine, track: "sentence" })), 400);
  return mine;
};
const subscribeSpeakEnded = (h: (e: { gen: number; track: string }) => void) => {
  endedHandlers.add(h);
  return () => void endedHandlers.delete(h);
};

function showToast(msg: string) {
  const d = document.createElement("div");
  d.style.cssText =
    "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99;font-size:12px;color:var(--ink-1);background:var(--glass-elevated);border:1px solid var(--glass-border-strong);padding:6px 14px;border-radius:999px;box-shadow:var(--shadow-pill)";
  d.textContent = msg;
  document.body.appendChild(d);
  window.setTimeout(() => d.remove(), 2200);
}

function Preview() {
  return (
    <div className="reader-root" data-theme={THEME}>
      <div className="reader-body">
        <SpeakView
          requestTranslate={async () => ({ status: "error", text: "预览环境不接 LLM" })}
          speakEn={speakEn}
          speakWordSlow={speakEn}
          subscribeSpeakEnded={subscribeSpeakEnded}
          stopSpeak={() => undefined}
          micDeviceId=""
          onToast={showToast}
          onBack={() => showToast("返回（演示）")}
          vocabWords={VOCAB}
          onVocabSaved={() => undefined}
          onGenerateNote={() => showToast("生成笔记（演示）")}
          onGoReview={() => showToast("去复习（演示）")}
          bookContext={null}
          dueVocabWords={VOCAB}
          // done 态要从「最近会话」恢复，其余态直接带语境开会
          pendingSpeak={STATE === "done" ? null : { kind: "vocab" }}
          onGradeVocab={() => undefined}
          onOpenReaderSettings={() => showToast("打开设置抽屉（演示）")}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);

// ---------- 把真实组件带进目标状态（只点真实按钮，不改组件内部状态） ----------

function whenFound(selector: string, then: (el: HTMLElement) => void, timeoutMs = 8000) {
  const started = Date.now();
  const timer = window.setInterval(() => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) {
      window.clearInterval(timer);
      then(el);
    } else if (Date.now() - started > timeoutMs) {
      window.clearInterval(timer);
    }
  }, 120);
}

// ?do=space@1500,esc@2600：到点往 window 发真实键盘事件，验证口语页自管的快捷键。
// 目标取 body（焦点不在按钮/输入框上的常态）；kbd 事件走 window 监听，与真实按键同路径。
for (const step of (params.get("do") ?? "").split(",").filter(Boolean)) {
  const [name, at] = step.split("@");
  const key = name === "space" ? " " : name === "esc" ? "Escape" : name;
  window.setTimeout(() => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key, code: name === "space" ? "Space" : key, bubbles: true, cancelable: true }),
    );
  }, Number(at) || 0);
}

if (STATE === "done") {
  whenFound(".recent-session-row", (el) => el.click());
} else if (STATE === "rec" || STATE === "err") {
  // 开场白播报 stub 400ms 后回 idle，再点麦克风
  whenFound(".speak-mic", () => window.setTimeout(() => document.querySelector<HTMLElement>(".speak-mic")?.click(), 900));
}
