import { useSyncExternalStore } from "react";
import type { Article, VocabWord } from "./core/types";
import { DEMO_ARTICLES, DEMO_VOCAB } from "./core/data";

export type Theme = "light" | "dark" | "sepia" | "oled";
export const THEME_LABEL: Record<Theme, string> = { light: "浅色", dark: "深色", sepia: "护眼", oled: "纯黑" };

export interface SheetEntry {
  word: string;
  kind: "word" | "chunk";
  chunkType?: string;
  phonetic?: string;
  senses: { pos: string; cn: string }[];
  pattern?: string;
  trap?: string;
  sentence?: string;
  saved: boolean;
}

interface AppState {
  theme: Theme;
  vocab: VocabWord[];
  articles: Article[];
  sheet: SheetEntry | null;
}

let state: AppState = {
  theme: "light",
  vocab: [...DEMO_VOCAB],
  articles: [...DEMO_ARTICLES],
  sheet: null,
};

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => sel(state),
    () => sel(state),
  );
}

export const actions = {
  setTheme(theme: Theme) {
    state = { ...state, theme };
    document.documentElement.dataset.theme = theme;
    emit();
  },
  setSheet(sheet: SheetEntry | null) {
    state = { ...state, sheet };
    emit();
  },
  saveWord(entry: SheetEntry, kind: "word" | "chunk") {
    if (state.vocab.some((v) => v.word.toLowerCase() === entry.word.toLowerCase())) return;
    state = {
      ...state,
      vocab: [
        {
          id: entry.word.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          word: entry.word,
          kind,
          chunkType: kind === "chunk" ? entry.chunkType : undefined,
          phonetic: entry.phonetic,
          senses: entry.senses.length ? entry.senses : [{ pos: "", cn: "（spike：未接入词典）" }],
          pattern: entry.pattern,
          trap: entry.trap,
          sourceArticleId: "trees",
          sourceSentenceIdx: 0,
          dueAt: Date.now(),
        },
        ...state.vocab,
      ],
      sheet: null,
    };
    emit();
    toast(`已收藏「${entry.word}」`);
  },
  deleteWord(id: string) {
    state = { ...state, vocab: state.vocab.filter((v) => v.id !== id), sheet: null };
    emit();
  },
  gradeWord(id: string, dueAt: number) {
    state = { ...state, vocab: state.vocab.map((v) => (v.id === id ? { ...v, dueAt } : v)) };
    emit();
  },
};

/* ---------- toast ---------- */
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(msg: string) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2200);
}

/* ---------- TTS（Web Speech；spike S3a 路线：先验证 WebView 原生支持） ---------- */
let voiceEn: SpeechSynthesisVoice | null = null;
function pickVoice() {
  if (!("speechSynthesis" in window)) return;
  const vs = speechSynthesis.getVoices().filter((v) => /^en(-|_)/i.test(v.lang));
  voiceEn = vs.find((v) => /Google US|Natural|Samantha|Zira/i.test(v.name)) || vs[0] || null;
}
if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}
export const ttsEvents = { start: 0, end: 0 };

/**
 * 朗读一句话；onend 在部分 WKWebView 里不可靠，用「估计时长兜底」双保险，
 * 兜底触发时 console.warn（spike 观察点：真机上兜底命中率）。
 */
export function speak(text: string, rate = 1, onend?: () => void): void {
  if (!("speechSynthesis" in window)) {
    onend?.();
    return;
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = rate;
  if (voiceEn) u.voice = voiceEn;
  let settled = false;
  const done = (via: string) => {
    if (settled) return;
    settled = true;
    if (via === "fallback") console.warn(`[tts] onend 未触发，兜底接管: "${text.slice(0, 30)}…"`);
    onend?.();
  };
  u.onstart = () => ttsEvents.start++;
  u.onend = () => {
    ttsEvents.end++;
    done("onend");
  };
  u.onerror = () => done("error");
  // 估计时长：词数 × ~380ms/词 / rate，加 1200ms 余量
  const estMs = (text.split(/\s+/).length * 380) / Math.max(0.5, rate) + 1200;
  setTimeout(() => done("fallback"), estMs);
  speechSynthesis.speak(u);
}
export function stopSpeak() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}
