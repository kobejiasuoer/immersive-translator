/**
 * 口语陪练会话记录 —— 轻量模块级 localStorage（键 ita.v3.speak.sessions），
 * 独立于 store：陪练存档是功能内数据，不进全局状态（治 P-40 假统计/假列表）。
 * 保存的是「存入口语记录」那一刻的真实对话（chat，LLM 真实回复或 ASR 转写），
 * 最近会话列表与 resume 续接都从这里读（治 P-41 假续接）。
 * B1 起对话无剧本：SpeakSession 不再有 scriptIdx（旧存档里的该字段读入后不消费、
 * 重新保存时自然淘汰，双向兼容）。
 */
import { useSyncExternalStore } from "react";
import type { ChatTurn } from "./demo";
import type { SpeakDifficulty } from "./speak";

export interface SpeakSession {
  id: string;
  /** 场景 id（core/speak.ts SPEAK_SCENE_META 的 id） */
  sceneId: string;
  /** 场景显示名 */
  scene: string;
  /** 气泡条数（对话轮次口径与摘要一致） */
  turns: number;
  /** 会话用时（秒，真实计时） */
  secs: number;
  /** 我方开口次数 */
  me: number;
  at: number;
  /** 结束时的真实气泡流（resume 还原用） */
  chat: ChatTurn[];
}

const KEY = "ita.v3.speak.sessions";
const MAX = 12;

const listeners = new Set<() => void>();
let cache: SpeakSession[] | null = null;

function load(): SpeakSession[] {
  if (cache) return cache;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]") as SpeakSession[];
    cache = Array.isArray(raw) ? raw : [];
  } catch {
    cache = [];
  }
  return cache;
}

function persist(list: SpeakSession[]) {
  cache = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* 存储满/隐私模式静默 */
  }
  listeners.forEach((l) => l());
}

export function listSessions(): SpeakSession[] {
  return load();
}

export function lastSessionByScene(sceneId: string): SpeakSession | null {
  return load().find((s) => s.sceneId === sceneId) || null;
}

/**
 * 保存一条会话存档（真实对话，无剧本位置——剧本时代的 scriptIdx 字段已随类型面一并清除）。
 */
export function saveSession(s: Omit<SpeakSession, "id" | "at">): SpeakSession {
  const full: SpeakSession = {
    sceneId: s.sceneId,
    scene: s.scene,
    turns: s.turns,
    secs: s.secs,
    me: s.me,
    chat: s.chat,
    id: "spk-" + Date.now(),
    at: Date.now(),
  };
  persist([full, ...load()].slice(0, MAX));
  return full;
}

export function subscribeSessions(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** 订阅版列表（快照按引用缓存，供 useSyncExternalStore 稳定渲染）。 */
export function useSpeakSessions(): SpeakSession[] {
  return useSyncExternalStore(subscribeSessions, load, load);
}

/* ---------- 难度偏好（场景页三档 Seg ↔ 对话页 system prompt） ---------- */

const DIFF_KEY = "ita.v3.speak.diff";

/** 上次选择的难度（入门 easy / 进阶 medium / 挑战 hard）；坏值/未选过 → easy。 */
export function loadSpeakDiff(): SpeakDifficulty {
  try {
    const v = localStorage.getItem(DIFF_KEY);
    if (v === "easy" || v === "medium" || v === "hard") return v;
  } catch {
    /* 隐私模式静默 */
  }
  return "easy";
}

export function saveSpeakDiff(d: SpeakDifficulty): void {
  try {
    localStorage.setItem(DIFF_KEY, d);
  } catch {
    /* 静默 */
  }
}

/** 列表时间签：「今天 21:07 / 昨天 / 9月22日」。 */
export function sessionWhen(at: number, now = new Date()): string {
  const d = new Date(at);
  if (d.toDateString() === now.toDateString()) {
    return `今天 ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  const yest = new Date(now.getTime() - 86400000);
  if (d.toDateString() === yest.toDateString()) return "昨天";
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
