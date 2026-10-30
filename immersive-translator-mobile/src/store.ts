/**
 * 身份隔离的学习状态仓储，沿用 spike 的 actions API。
 *  · 浏览器用 IndexedDB，原生用 Rust SQLite；启动 hydrate 与旧数据迁移先于页面显示。
 *  · 新增 reviewStats（#52 三处同源）、settings/history/notes/reader 切片。
 *  · 左滑删除 = 移除 + 快照入 trash，5s 后真正提交；撤销恢复快照（评审要点 7②）。
 *  · 首次打开只提供明确的入门样文，不制造收藏、练习或复习历史。
 */
import { useSyncExternalStore } from "react";
import type { Article, VocabWord } from "./core/types";
import { createPersistence, type Repository, type CommitInput } from "./core/persistence";
import { canonicalJson, initialSrs, mergePracticeTask, reduceReviewEvents, stampPracticeTask, type ReviewEvent } from "../../packages/learning-core/src/index";
import type { PracticeTask } from "./services/practice";
import type { SpeakSession } from "./core/sessions";
import type { GlossaryPair } from "./core/glossary";
import { DEMO_SLOW, DEMO_TREES, type ChatTurn } from "./core/demo";
import { type ReviewGrade } from "./core/srs";
import { haptic, invokeRaw, isTauri, reportDiag, scheduleDailyReminder } from "./services/device";
import { cloudAvailable, speakCloud } from "./services/voice";

export type Theme = "light" | "dark";
export type ThemePref = Theme | "system";
export type Tab = "today" | "practice" | "shelf" | "vocab" | "me";

export interface ReaderPrefs {
  mode: "bi" | "en" | "zh";
  mask: boolean;
  fs: number;
  topic: "paper" | "black";
  chunkMark: boolean;
  rate: number;
}

export interface Settings {
  themePref: ThemePref;
  provider: string;
  /** API Key 已入系统钥匙串（真机）：true 时 localStorage 不再落明文（persistable 置空） */
  keyStored: boolean;
  /** API Key 仅在内存和当前资料的系统钥匙串中保存。 */
  apiKey: string;
  /** 接口地址覆盖；空 = 用 provider 预设（custom 时必填） */
  baseUrl: string;
  /** 模型名覆盖；空 = 用 provider 预设 */
  model: string;
  /** 讯飞三件套（语音链路）；三件是否已入系统钥匙串：true 时 localStorage 不落明文（U-11 与模型 Key 同路径） */
  voiceAppId: string;
  voiceApiKey: string;
  voiceApiSecret: string;
  voiceKeyStored: boolean;
  /** 云朗读引擎：edge = 微软 Edge 在线（神经音色，免费无凭据，默认）；xfyun = 讯飞合成（需三件套） */
  ttsEngine: "edge" | "xfyun";
  /** Edge 音色 ShortName；空 = 按文本语言自动（中文晓晓 / 英文 Ava） */
  edgeVoice: string;
  conn: "idle" | "loading" | "ok" | "fail";
  connMsg: string;
  dir: "e2c" | "c2e" | "auto";
  style: "plain" | "faith" | "eleg";
  /** 全局正文缩放档（U-15/WCAG 1.4.4）：1=标准 1.15=大 1.3=特大；写 --fs-scale 到 :root 供正文类 calc 消费 */
  fsScale: number;
  stream: boolean;
  voice: boolean;
  daily: boolean;
  dnd: boolean;
  remindTime: string;
  goal: string;
}

export interface HistoryItem {
  id: string;
  src: string;
  en: string;
  zh: string;
  time: string;
  star: boolean;
}

export interface NoteItem {
  id: string;
  title: string;
  sub: string;
  body: string;
  insight: string;
  createdAt?: number;
  updatedAt?: number;
  taskId?: string;
  attemptId?: string;
  sourceArticleId?: string;
  sourceSentenceIdx?: number;
}

export interface DictSenses {
  pos: string;
  cn: string;
}

export interface DictEntry {
  type: "word" | "chunk" | "missing";
  word: string;
  chunkType?: string;
  phonetic?: string;
  senses: DictSenses[];
  pattern?: string;
  trap?: string;
  sentence?: string;
  articleId?: string;
  sentIdx?: number;
  saved: boolean;
}

export type Sheet =
  | { kind: "dict"; entry: DictEntry }
  | { kind: "aa" }
  | { kind: "rate" }
  | { kind: "more" }
  | { kind: "search" }
  | { kind: "confirm" }
  | { kind: "summary"; sceneId: string; scene: string; turns: number; secs: number; me: number; chat: ChatTurn[] }
  | { kind: "export"; cards: { t: string; en: string; zh: string }[]; secs: number }
  | { kind: "import"; tab: "lib" | "paste" | "link" | "file" }
  | { kind: "diffwords" };

export interface Trash {
  kind: "vocab" | "article" | "history" | "note";
  index: number;
  vocab?: VocabWord;
  article?: Article;
  item?: HistoryItem;
  note?: NoteItem;
}

export interface Stats {
  clearedToday: number;
  /** 今日已清过的卡片 id（去重计数：forgot 10 分钟回流再清不重复 +1，folio 分母不漂移，治 state-5） */
  clearedIds: string[];
  streak: number;
  lastReviewStreakDay?: string;
  week: { review: number; add: number; trap: number };
  day: string;
  /** 本周归属（ISO 周一口径 "年-周"）：hydrate 时变化 → week 三项归零（自然周重置） */
  weekKey: string;
}

/** 诊断事件（services 层上报；环形 30 条、不落盘，诊断页消费） */
export interface DiagItem {
  time: number;
  kind: string;
  msg: string;
}

export interface AppState {
  tasks: PracticeTask[];
  reviewEvents: ReviewEvent[];
  sessions: SpeakSession[];
  glossary: GlossaryPair[];
  speakDifficulty: "easy" | "medium" | "hard";
  theme: Theme;
  onboarded: boolean;
  tab: Tab;
  vocab: VocabWord[];
  articles: Article[];
  /** 阅读进度：articleId → 已读到的句 idx（#42 断点续读） */
  progress: Record<string, number>;
  settings: Settings;
  history: HistoryItem[];
  notes: NoteItem[];
  stats: Stats;
  reader: ReaderPrefs;
  sheet: Sheet | null;
  trash: Trash | null;
  clip: { en: string; zh: string; ts: number } | null;
  /** 阅读定位请求（词典卡「定位回读」） */
  readerTarget: { articleId: string; sent: number; nonce: number } | null;
  /** 阅读内打开的文章 id（词典卡原句/分享等需要知道上下文） */
  readingArticleId: string | null;
  /** 应用内通知横幅（60s 自动收起由 App 计时，§3.14） */
  banner: { title: string; body: string; at: number } | null;
  /** 最近一次评分（5s 撤销用，治 I7）；counted=本次评分是否计入了当日清卡数（回流卡不重复计）；
      wasTrap=本次评分是否计入过 week.trap（撤销时同步回滚，治 state-7 虚高）；
      prevWrongAt=评分前该词的 lastWrongAt（撤销时还原判错标记，治 ux-cross-1）。 */
  lastGrade: { id: string; eventId?: string; prevDueAt: number; counted?: boolean; wasTrap?: boolean; prevWrongAt?: number | null } | null;
  /** 「重新遮住全部译文」信号（nonce，仅会话内；ReaderScreen 监听后清空 revealed，治 P-25） */
  remaskAt: number;
  /** 深链/分享扩展送入的待处理文本（#share?text=… / ita://share?text=…；ShareScreen 消费，仅会话内不落盘） */
  shareIn: { text: string; source: string } | null;
  /** 诊断事件环形队列（上限 30，不落盘；registerDiagSink → pushDiag） */
  diag: DiagItem[];
  /** 「今晚不再提醒」snooze 时间戳：showBanner 当晚（自然日口径）不再弹，次日恢复；随状态持久化 */
  snoozedAt: number;
}

/* ---------- 演示初值（标注演示口径；仅供首次启动/跳过 Onboarding） ---------- */
function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 昨日的 dayKey（跨天顺延判定用：仅昨日有清才保留 streak，隔整天未清即断）。 */
function yesterdayKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return todayKey(d);
}

/** ISO 周口径（周一为一周之始）："年-周"，如 2026-40；自然周重置的判定键。 */
function isoWeekKey(d = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7; /* 周日=7（ISO 周从周一起算） */
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); /* 对齐到本周周四，跨年周归属随之确定 */
  const week = Math.ceil(((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-${week}`;
}

function demoState(): AppState {
  return {
    theme: window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    onboarded: false,
    tab: "today",
    vocab: [],
    tasks: [], reviewEvents: [], sessions: [], glossary: [], speakDifficulty: "easy",
    articles: [DEMO_TREES, DEMO_SLOW].map(a => ({ ...a, sourceType: "sample" as const })),
    progress: {},
    settings: {
      themePref: "system",
      provider: "openai",
      keyStored: false,
      apiKey: "",
      baseUrl: "",
      model: "",
      voiceAppId: "",
      voiceApiKey: "",
      voiceApiSecret: "",
      voiceKeyStored: false,
      ttsEngine: "edge",
      edgeVoice: "",
      conn: "idle",
      connMsg: "",
      dir: "e2c",
      style: "plain",
      fsScale: 1,
      stream: true,
      voice: false,
      daily: false,
      dnd: false,
      remindTime: "21:30",
      goal: "读外刊与原版书",
    },
    /* 统计基线归零（治 demo 14/15）：不再播种演示历史与虚高统计；DEMO_VOCAB/DEMO_TREES/DEMO_SLOW 为内容种子保留 */
    history: [],
    notes: [],
    stats: { clearedToday: 0, clearedIds: [], streak: 0, week: { review: 0, add: 0, trap: 0 }, day: todayKey(), weekKey: isoWeekKey() },
    reader: { mode: "bi", mask: false, fs: 19, topic: "paper", chunkMark: true, rate: 1 },
    sheet: null,
    trash: null,
    /* 剪贴板默认空（§3.1「检测到新文本才显示」）——不再无条件塞演示 CLIP，空态今天页剪贴板块随之隐藏（治 P-06） */
    clip: null,
    readerTarget: null,
    readingArticleId: null,
    banner: null,
    lastGrade: null,
    remaskAt: 0,
    shareIn: null,
    diag: [],
    snoozedAt: 0,
  };
}

/* ---------- 持久化（版本化 hydrate；旧版本/坏数据 → 演示态） ---------- */
const STORE_KEY = "ita.v3.state";
const STORE_VERSION = 4;
/** API Key 的钥匙串条目 key（Rust keychain.rs service="ita.secrets"，account 即此值）。 */
const KEYCHAIN_APIKEY = "apiKey";
/** 讯飞三件套的钥匙串条目 key（U-11：与模型 Key 同路径，不再明文落 localStorage）。 */
const KEYCHAIN_VOICE_APPID = "voiceAppId";
const KEYCHAIN_VOICE_KEY = "voiceApiKey";
const KEYCHAIN_VOICE_SECRET = "voiceApiSecret";
let credentialQueue: Promise<unknown> = Promise.resolve();
const profileSecret = (identity: string, key: string) => `mobile.profile.${encodeURIComponent(identity)}.${key}`;
function credentialWork<T>(work: () => Promise<T>): Promise<T> {
  const next = credentialQueue.catch(() => undefined).then(work); credentialQueue = next; return next;
}
async function readCredential(identity: string, key: string): Promise<string | null> {
  return credentialWork(async () => {
    const scoped = profileSecret(identity, key);
    const value = await invokeRaw<string | null>("secret_get", { key: scoped });
    if (value !== null || identity !== "guest") return value;
    const legacy = await invokeRaw<string | null>("secret_get", { key });
    if (legacy !== null) { await invokeRaw("secret_put", {key: scoped, value: legacy}); await invokeRaw("secret_delete", {key}); }
    return legacy;
  });
}

function persistable(s: AppState) {
  return {
    version: STORE_VERSION,
    tasks: s.tasks, reviewEvents: s.reviewEvents, sessions: s.sessions, glossary: s.glossary, speakDifficulty: s.speakDifficulty,
    theme: s.theme,
    onboarded: s.onboarded,
    vocab: s.vocab,
    articles: s.articles,
    progress: s.progress,
    /* Secrets never enter the snapshot, including browser preview and failed Keychain writes. */
    settings: {
      ...s.settings,
      apiKey: "",
      voiceAppId: "",
      voiceApiKey: "",
      voiceApiSecret: "",
    },
    history: s.history,
    notes: s.notes,
    stats: s.stats,
    reader: s.reader,
    /* 剪贴板快照随状态持久化：重启后仍是「刚复制」的那条，而不是每次塞回演示句（治 P-06） */
    clip: s.clip,
    /* 诊断汇落盘（尾部 30 条）：真机问题要拔线拉库看，仅会话内等于没埋仪器 */
    diag: s.diag.slice(-30),
    /* snooze 需跨重启生效（当晚不再弹）；shareIn 仅会话内，不落盘 */
    snoozedAt: s.snoozedAt,
  };
}

function migrate(raw: Record<string, unknown>): AppState | null {
  if (raw.version !== 3 && raw.version !== STORE_VERSION) return null;
  if (![raw.vocab, raw.articles, raw.history, raw.notes].every(Array.isArray)) return null;
  const base = demoState();
  try {
    const themePref = (raw.settings as Settings | undefined)?.themePref;
    const theme: Theme =
      raw.theme === "dark" ? "dark" : raw.theme === "light" ? "light" : /* 旧 spike 主题 */ "light";
    /* 旧数据无 weekKey → 本周视为需重置（week 归零、weekKey 补当前）；有则原样带入，由 hydrate 判定是否跨周 */
    const rawStats = (raw.stats as Partial<Stats>) || {};
    const stats: Stats = {
      ...base.stats,
      ...rawStats,
      clearedIds: Array.isArray(rawStats.clearedIds) ? rawStats.clearedIds : [],
      week: rawStats.weekKey ? { ...base.stats.week, ...(rawStats.week || {}) } : { ...base.stats.week },
      weekKey: rawStats.weekKey || base.stats.weekKey,
    };
    return {
      ...base,
      tasks: Array.isArray(raw.tasks) ? raw.tasks as PracticeTask[] : [],
      reviewEvents: Array.isArray(raw.reviewEvents) ? raw.reviewEvents as ReviewEvent[] : [],
      sessions: Array.isArray(raw.sessions) ? raw.sessions as SpeakSession[] : [],
      glossary: Array.isArray(raw.glossary) ? raw.glossary as GlossaryPair[] : [],
      speakDifficulty: raw.speakDifficulty === "medium" || raw.speakDifficulty === "hard" ? raw.speakDifficulty : "easy",
      theme,
      onboarded: Boolean(raw.onboarded),
      tab: "today",
      vocab: (raw.vocab as VocabWord[]).map(word => {
        const baseline = word.srsBaseline ?? word.baseline ?? word.srs ?? initialSrs(word.dueAt);
        const hasEvents = Array.isArray(raw.reviewEvents) && (raw.reviewEvents as ReviewEvent[]).some(event => event.wordId === word.id);
        return { ...word, generation: word.generation ?? `legacy-${word.addedAt ?? word.createdAt ?? 0}`, srsBaseline: baseline as VocabWord["srsBaseline"], baseline, baselineRecall: word.baselineRecall ?? (hasEvents ? undefined : word.recall) ?? {total:{pass:0,wrong:0,trap:0},byMode:{}} };
      }),
      articles: (raw.articles as Article[]) || base.articles,
      progress: (raw.progress as Record<string, number>) || base.progress,
      settings: { ...base.settings, ...((raw.settings as Partial<Settings>) || {}), themePref: themePref || "system" },
      history: (raw.history as HistoryItem[]) || base.history,
      notes: (raw.notes as NoteItem[]) || base.notes,
      stats,
      reader: { ...base.reader, ...((raw.reader as Partial<ReaderPrefs>) || {}) },
      sheet: null,
      trash: null,
      /* 诊断汇：读旧数据尾部（真机拉库诊断用；坏数据/超长截断到 30 条） */
      diag: Array.isArray(raw.diag) ? (raw.diag as AppState["diag"]).slice(-30) : [],
      /* 读用户真实剪贴板快照，没有就是 null（不回退演示 CLIP，治 P-06） */
      clip: (raw.clip as { en: string; zh: string; ts: number } | null | undefined) ?? null,
      readerTarget: null,
      readingArticleId: null,
      banner: null,
      lastGrade: null,
      remaskAt: 0,
      shareIn: null,
      snoozedAt: typeof raw.snoozedAt === "number" ? raw.snoozedAt : 0,
    };
  } catch {
    return null;
  }
}

let state: AppState = demoState();
let repository: Repository | null = null;
let revision = 0;
let writeQueue: Promise<void> = Promise.resolve();
let profileQueue: Promise<unknown> = Promise.resolve();
let persistenceFailure: unknown = null;
export function activeRepository(): Repository {
  if (!repository) throw new Error("本地资料尚未载入");
  return repository;
}
export function profileIdentity(): string { return activeRepository().identity; }
function enqueue(work: () => Promise<void>, target = activeRepository()): Promise<void> {
  const next = writeQueue.then(async () => {
    if (repository !== target) throw new DOMException("本地资料已切换", "AbortError");
    if (persistenceFailure) throw persistenceFailure;
    await work();
  });
  writeQueue = next;
  void next.catch(error => {
    if (repository !== target) return;
    persistenceFailure = error;
    window.dispatchEvent(new CustomEvent("mobile-storage-error", { detail: String(error) }));
  });
  return next;
}
export function commitRepository(input: Omit<CommitInput, "expectedRevision">): Promise<void> {
  const target = activeRepository();
  return enqueue(async () => {
    const result = await target.commit({ ...input, expectedRevision: revision });
    revision = result.revision;
  }, target);
}
export function replaceSyncedState(patch: Partial<AppState> | ((current: AppState) => Partial<AppState>), extra: Omit<CommitInput, "expectedRevision" | "state"> = {}, applyIf?: () => boolean): Promise<void> {
  const target = activeRepository();
  return enqueue(async () => {
    if (applyIf && !applyIf()) return;
    const previous = state;
    const changes = typeof patch === "function" ? patch(previous) : patch;
    const next = { ...previous, ...changes };
    state = next;
    try {
      const result = await target.commit({ ...extra, expectedRevision: revision, state: persistable(next) });
      revision = result.revision; listeners.forEach(fn => fn());
    } catch (error) {
      // Preserve later user edits; undo only fields still owned by this failed patch.
      const rollback: Partial<AppState> = {};
      for (const key of Object.keys(changes) as (keyof AppState)[]) {
        if (state[key] === next[key]) Object.assign(rollback, { [key]: previous[key] });
      }
      state = { ...state, ...rollback };
      listeners.forEach(fn => fn());
      throw error;
    }
  }, target);
}

function resolveTheme(pref: ThemePref): Theme {
  if (pref === "system") {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return pref;
}

const listeners = new Set<() => void>();
function emit() {
  listeners.forEach(fn => fn());
  if (!repository) return;
  void commitRepository({ state: persistable(state) });
  window.dispatchEvent(new Event("mobile-state-change"));
}
export async function flushPersist(): Promise<void> {
  // Include mutations queued while an earlier durable write was in flight.
  let pending: Promise<void>;
  do { pending = writeQueue; await pending; } while (pending !== writeQueue);
}
function serializeProfile<T>(work: () => Promise<T>): Promise<T> {
  const next = profileQueue.catch(() => undefined).then(work); profileQueue = next; return next;
}

export async function initializeStore(identity = "guest"): Promise<void> {
  await serializeProfile(async () => { await initializeStoreNow(identity); });
}
interface ProfileSwitchOptions { valid?: () => boolean; retainSheet?: { sheet: Sheet; valid: () => boolean } }
async function initializeStoreNow(identity: string, options: ProfileSwitchOptions = {}): Promise<AppState | null> {
  if (repository) await flushPersist();
  if (options.valid && !options.valid()) throw new DOMException("资料切换已取消", "AbortError");
  if (repository?.identity === identity) return state;
  const next = await createPersistence(identity);
  try {
    const snapshot = await next.loadSnapshot<Record<string, unknown>>();
    let loaded = demoState();
    let nextRevision = snapshot.revision;
    if (snapshot.state) {
      const restored = migrate(snapshot.state);
      if (!restored) throw new Error("本地资料版本或内容异常，原资料已保留；未重置成样例");
      loaded = restored;
    } else {
      const raw = identity === "guest" ? localStorage.getItem(STORE_KEY) : null;
      if (raw) {
        const legacy = migrate(JSON.parse(raw));
        if (!legacy) throw new Error("旧版资料无法迁移，原始资料已保留");
        const keys = [[KEYCHAIN_APIKEY, legacy.settings.apiKey], [KEYCHAIN_VOICE_APPID, legacy.settings.voiceAppId], [KEYCHAIN_VOICE_KEY, legacy.settings.voiceApiKey], [KEYCHAIN_VOICE_SECRET, legacy.settings.voiceApiSecret]];
        if (keys.some(([, value]) => value)) {
          if (!isTauri()) throw new Error("旧资料含服务密钥，请在原生应用迁移到系统钥匙串；原资料未改动");
          for (const [key, value] of keys) if (value) await credentialWork(() => invokeRaw("secret_put", { key: profileSecret(identity, key), value }));
        }
        loaded = legacy;
        const sessions = localStorage.getItem("ita.v3.speak.sessions");
        const glossary = localStorage.getItem("ita.v3.glossary");
        loaded.sessions = sessions ? JSON.parse(sessions) : [];
        loaded.glossary = glossary ? JSON.parse(glossary) : [];
        if (!Array.isArray(loaded.sessions) || !Array.isArray(loaded.glossary)) throw new Error("旧版附属资料损坏，原资料未改动");
        const safe = persistable(loaded);
        nextRevision = (await next.migrateLegacy({ migrationId: "v3-to-v4", entries: { [STORE_KEY]: JSON.stringify(safe), "ita.v3.speak.sessions": sessions, "ita.v3.glossary": glossary }, state: safe })).revision;
        for (const key of [STORE_KEY, STORE_KEY + ".bak", "ita.v3.speak.sessions", "ita.v3.glossary", "ita.v3.speak.diff"]) localStorage.removeItem(key);
      } else nextRevision = (await next.saveSnapshot(persistable(loaded), nextRevision)).revision;
    }
    if (isTauri()) {
      const keys = [KEYCHAIN_APIKEY, KEYCHAIN_VOICE_APPID, KEYCHAIN_VOICE_KEY, KEYCHAIN_VOICE_SECRET];
      const values = await Promise.all(keys.map(key => readCredential(identity, key).catch(error => { if(import.meta.env.DEV && String(error).includes("SECURE_STORAGE_UNSUPPORTED")) return null; throw error; })));
      loaded.settings = { ...loaded.settings, apiKey: values[0] || "", voiceAppId: values[1] || "", voiceApiKey: values[2] || "", voiceApiSecret: values[3] || "", keyStored: true, voiceKeyStored: true };
    }
    // Loading the target store can take time. Drain writes produced in the old
    // profile during that time before closing it and resetting the queue.
    if (repository) await flushPersist();
    if (options.valid && !options.valid()) throw new DOMException("资料切换已取消", "AbortError");
    const previous = repository ? state : null;
    const retained = options.retainSheet;
    if (retained && state.sheet === retained.sheet && retained.valid()) loaded.sheet = retained.sheet;
    repository?.close(); repository = next; revision = nextRevision; persistenceFailure = null; writeQueue = Promise.resolve();
    state = loaded; state.theme = resolveTheme(state.settings.themePref);
    applyThemeDom(state.theme); applyFsDom(state.settings.fsScale); rolloverIfDue();
    listeners.forEach(fn => fn());
    window.dispatchEvent(new Event("mobile-profile-change"));
    return previous;
  } catch (error) { next.close(); throw error; }
}

export function deviceId(): string {
  let id = localStorage.getItem("mobile.device.id");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("mobile.device.id", id); }
  return id;
}
export async function switchProfile(identity: string, bringGuest: boolean, options: ProfileSwitchOptions = {}): Promise<void> {
  const claim = bringGuest && identity !== "guest" ? await prepareGuestClaim(identity, true) : null;
  await serializeProfile(async () => {
  await initializeStoreNow(identity, options);
  if (claim) {
    await replaceSyncedState(current => mergeGuestClaim(current, claim.state));
    window.dispatchEvent(new Event("mobile-state-change"));
  }
  });
  if (claim) await finishGuestClaim(identity);
}

type GuestClaimState = Pick<AppState, "articles" | "vocab" | "notes" | "tasks" | "reviewEvents" | "sessions" | "history" | "glossary" | "progress">;
export interface GuestClaim { version: 1; accountId: string; state: GuestClaimState }
const GUEST_CLAIMS = "local-guest-claims";
/** Move selected guest data into an account-bound recovery record atomically.
 * The record survives a crash between the two profile repositories' commits. */
export async function prepareGuestClaim(accountId: string, all: boolean, selection: { taskId?: string; articleId?: string } = {}, valid: () => boolean = () => true, recoverOnly = false): Promise<GuestClaim | null> {
  if (!accountId || accountId === "guest") throw new Error("认领需要有效账号");
  return serializeProfile(async () => {
    const live = repository?.identity === "guest";
    if (live) await flushPersist();
    if (!valid()) throw new DOMException("资料认领已取消", "AbortError");
    const guest = live ? activeRepository() : await createPersistence("guest");
    try {
      const previous = await guest.get<GuestClaim>(GUEST_CLAIMS, accountId);
      if (!valid()) throw new DOMException("资料认领已取消", "AbortError");
      let reserved: GuestClaim | null = null;
      if (previous && !previous.deleted && previous.payload) {
        const claim = previous.payload;
        if (claim.version !== 1 || claim.accountId !== accountId || !claim.state || ![claim.state.articles,claim.state.tasks,claim.state.vocab,claim.state.notes,claim.state.reviewEvents,claim.state.sessions,claim.state.history,claim.state.glossary].every(Array.isArray)) throw new Error("待认领资料损坏，原资料已保留");
        reserved = claim;
      }
      if (!live || recoverOnly) return reserved;
      let claim: GuestClaim | null = reserved;
      const records: NonNullable<CommitInput["records"]> = [];
      await replaceSyncedState(current => {
      const task = current.tasks.find(row => row.id === selection.taskId);
      const articleId = selection.articleId ?? task?.source?.articleId;
      const articles = all ? current.articles : current.articles.filter(row => row.id === articleId);
      const tasks = all ? current.tasks : task ? [task] : [];
      const selected: GuestClaimState = { articles, tasks, vocab: all ? current.vocab : [], notes: all ? current.notes : [], reviewEvents: all ? current.reviewEvents : [], sessions: all ? current.sessions : [], history: all ? current.history : [], glossary: all ? current.glossary : [], progress: all ? current.progress : Object.fromEntries(Object.entries(current.progress).filter(([id]) => id === articleId)) };
      if (![selected.articles,selected.tasks,selected.vocab,selected.notes,selected.reviewEvents,selected.sessions,selected.history,selected.glossary].some(rows => rows.length) && !Object.keys(selected.progress).length) return {};
      // The existing recovery batch already belongs to this account. Extend it
      // with the current explicit selection, atomically with removing that
      // selection from guest; a retry cannot drop either login's source task.
      const {onboarded: _onboarded, ...combined} = mergeGuestClaim(reserved?.state ?? {articles:[],tasks:[],vocab:[],notes:[],reviewEvents:[],sessions:[],history:[],glossary:[],progress:{}}, selected);
      claim = { version: 1, accountId, state: combined };
      const samples = demoState();
      const remainingArticles = current.articles.filter(row => !articles.some(item => item.id === row.id));
      // Sample text remains available, with the claimed reading/translation state reset.
      const sampleIds = new Set(articles.filter(row => row.sourceType === "sample").map(row => row.id));
      remainingArticles.push(...samples.articles.filter(row => sampleIds.has(row.id)));
      records.push({ collection: GUEST_CLAIMS, id: accountId, payload: claim, expectedVersion: previous?.version ?? 0 });
      return { articles: remainingArticles, tasks: current.tasks.filter(row => !tasks.some(item => item.id === row.id)), progress: Object.fromEntries(Object.entries(current.progress).filter(([id]) => !articles.some(row => row.id === id))), ...(all ? { vocab: [], notes: [], reviewEvents: [], sessions: [], history: [], glossary: [], stats: samples.stats, clip: null, trash: null, lastGrade: null } : {}) };
      }, {records}, valid);
      if (!valid()) throw new DOMException("资料认领已取消", "AbortError");
      return claim;
    } finally { if (!live) guest.close(); }
  });
}
export function mergeGuestClaim(current: GuestClaimState, guest: GuestClaimState): GuestClaimState & { onboarded: true } {
  const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
  const copyId = (id: string, value: unknown) => {
    let hash = 2166136261;
    const text = canonicalJson(value);
    for (let i=0;i<text.length;i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash,16777619); }
    return id.slice(0,90) + "~guest-" + (hash>>>0).toString(36);
  };
  const merge = <T extends { id: string }>(left: T[], right: T[], combine?: (old:T,row:T)=>T): T[] => {
    const result = [...left];
    for (const row of right) {
      const index = result.findIndex(old=>old.id===row.id);
      if (index<0) { result.push(row); continue; }
      if (same(result[index],row)) continue;
      if (combine) { result[index]=combine(result[index],row); continue; }
      const id=copyId(row.id,row), previous=result.find(old=>old.id===id);
      if (previous && !same(previous,{...row,id})) throw new Error("访客冲突副本 ID 重复，原资料仍保留");
      if (!previous) result.push({...row,id});
    }
    return result;
  };
  const sampleContent = (article:Article) => ({title:article.title,titleCn:article.titleCn,sentences:article.sentences,paragraphStarts:article.paragraphStarts});
  const articleIds = new Map<string,string>(), articles = [...current.articles];
  for (const row of guest.articles) {
    const index=articles.findIndex(old=>old.id===row.id), old=articles[index];
    const sample=demoState().articles.find(item=>item.id===row.id);
    if (index<0) { articles.push(row); articleIds.set(row.id,row.id); }
    else if (same(old,row)) articleIds.set(row.id,row.id);
    else if (sample && same(sampleContent(old),sampleContent(sample))) { articles[index]=row;articleIds.set(row.id,row.id); }
    else if (same(sampleContent(old),sampleContent(row))) { articles[index]={...old,lastReadAt:Math.max(old.lastReadAt??0,row.lastReadAt??0)};articleIds.set(row.id,row.id); }
    else {
      const id=copyId(row.id,row), copy={...row,id};
      const previous=articles.find(item=>item.id===id);
      if(previous&&!same(previous,copy))throw new Error("文章冲突副本 ID 重复，原资料仍保留");
      if(!previous)articles.push(copy);
      articleIds.set(row.id,id);
    }
  }
  const articleId = (id:string|undefined) => id ? articleIds.get(id)??id : id;
  const tasks = guest.tasks.map(row=>({...row,...(row.source?{source:{...row.source,articleId:articleId(row.source.articleId)!}}:{})}));
  const notes = guest.notes.map(row=>({...row,...(row.sourceArticleId?{sourceArticleId:articleId(row.sourceArticleId)}:{})}));
  const vocab = guest.vocab.map(row=>({...row,sourceArticleId:articleId(row.sourceArticleId)!}));
  const vocabIds = new Map(vocab.map(row=>{const old=current.vocab.find(item=>item.id===row.id);return [row.id,old&&!same(old,row)?copyId(row.id,row):row.id];}));
  const reviewEvents = guest.reviewEvents.map(row=>({...row,wordId:vocabIds.get(row.wordId)??row.wordId}));
  for(const row of reviewEvents){const old=current.reviewEvents.find(item=>item.id===row.id);if(old&&!same(old,row))throw new Error("复习事件 ID 内容冲突，访客资料仍保留待恢复");}
  const progress = {...current.progress};
  for(const [id,value] of Object.entries(guest.progress)){const target=articleId(id)!;progress[target]=Math.max(progress[target]??0,value);}
  return { articles, vocab: merge(current.vocab,vocab), notes: merge(current.notes,notes), tasks: merge(current.tasks,tasks,mergePracticeTask), reviewEvents: [...current.reviewEvents,...reviewEvents.filter(row=>!current.reviewEvents.some(old=>old.id===row.id))], sessions: merge(current.sessions,guest.sessions), history: merge(current.history,guest.history), glossary: [...current.glossary,...guest.glossary.filter(pair=>!current.glossary.some(old=>same(old,pair)))], progress, onboarded: true };
}
export async function finishGuestClaim(accountId: string, valid: () => boolean = () => true): Promise<void> {
  await serializeProfile(async () => {
    if (!valid() || repository?.identity !== accountId) throw new DOMException("资料认领已取消", "AbortError");
    const guest = await createPersistence("guest");
    try {
      const claim = await guest.get<GuestClaim>(GUEST_CLAIMS,accountId);
      if (!claim || claim.deleted) return;
      if (claim.payload?.accountId !== accountId) throw new Error("认领账号不匹配");
      const snapshot = await guest.loadSnapshot();
      await guest.commit({ expectedRevision: snapshot.revision, records: [{collection:GUEST_CLAIMS,id:accountId,payload:null,deleted:true,expectedVersion:claim.version}] });
    } finally { guest.close(); }
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** React 外读状态（services 层组 LLM cfg 用）。 */
export function getState(): AppState {
  return state;
}

/** 回前台跨天/跨周重算（App.tsx 在 visibilitychange visible 时调用；与 hydrate 同一段判定，幂等）。
    此前只在冷启动 hydrate 执行：iOS 切后台保活跨零点回来，clearedToday/week 仍是昨日口径、
    新清卡继续累进昨日计数，下次冷启动还会把今天的清卡误判为「昨日有清」多留一天 streak（治 state-2）。 */
export function rolloverIfDue(): void {
  const dayNow = todayKey();
  const weekNow = isoWeekKey();
  if (state.stats.day === dayNow && state.stats.weekKey === weekNow) return;
  let stats = state.stats;
  if (stats.day !== dayNow) {
    stats = {
      ...stats,
      streak: stats.clearedToday > 0 && stats.day === yesterdayKey() ? stats.streak : 0,
      clearedToday: 0,
      clearedIds: [],
      day: dayNow,
    };
  }
  if (stats.weekKey !== weekNow) {
    stats = { ...stats, week: { review: 0, add: 0, trap: 0 }, weekKey: weekNow };
  }
  state = { ...state, stats };
  emit();
}

export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => sel(state),
    () => sel(state),
  );
}

/** 系统主题跟随（settings.themePref === "system" 时生效）。 */
if (typeof window !== "undefined" && window.matchMedia) {
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (state.settings.themePref === "system") {
        state = { ...state, theme: resolveTheme("system") };
        applyThemeDom(state.theme);
        emit();
      }
    });
  } catch {
    /* 旧 WebView 无 addEventListener，忽略 */
  }
}

function applyThemeDom(theme: Theme) {
  const root = document.documentElement;
  /* U-31：换肤瞬间抑制成片颜色 transition（否则旧色拖影约 300ms）；双 rAF 后恢复普通交互动画 */
  root.classList.add("theme-switch");
  root.dataset.theme = theme;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      root.classList.remove("theme-switch");
    }),
  );
}

/** 全局正文缩放档落 DOM（U-15/WCAG 1.4.4）：正文类尺寸经 calc(px * var(--fs-scale)) 消费。 */
function applyFsDom(scale: number) {
  document.documentElement.style.setProperty("--fs-scale", String(scale));
}

/* ---------- 派生：reviewStats（#52 今天页 folio / hero / 生词页组头同源） ---------- */
export interface ReviewStats {
  due: number;
  dueWords: number;
  dueChunks: number;
  cleared: number;
  total: number;
  minutes: number;
  streak: number;
  week: { review: number; add: number; trap: number };
}

/* 按引用缓存（state 不可变替换），保证 useSyncExternalStore 快照稳定；
   附 30s 时效（治 state-6）：due 按 Date.now() 计算，此前缓存只认引用——页面停留期间
   forgot 卡 10 分钟后重新到期，hero/角标仍显示旧值，直到下一次任意 action 才恢复。 */
let statsCache: { src: AppState; at: number; out: ReviewStats } | null = null;

export function reviewStats(s: AppState): ReviewStats {
  const now = Date.now();
  if (statsCache && statsCache.src === s && now - statsCache.at < 30_000) return statsCache.out;
  const dueList = s.vocab.filter((v) => !v.paused && v.dueAt <= now);
  const dueWords = dueList.filter((v) => v.kind !== "chunk").length;
  const out: ReviewStats = {
    due: dueList.length,
    dueWords,
    dueChunks: dueList.length - dueWords,
    cleared: s.stats.clearedToday,
    total: dueList.length + s.stats.clearedToday,
    minutes: Math.max(2, Math.ceil(dueList.length * 0.7)),
    streak: s.stats.streak,
    week: s.stats.week,
  };
  statsCache = { src: s, at: now, out };
  return out;
}

/* ---------- actions（保持 API 形状，§6.3①） ---------- */
export const actions = {
  setTheme(theme: Theme) {
    state = { ...state, theme, settings: { ...state.settings, themePref: theme } };
    applyThemeDom(theme);
    emit();
  },
  setThemePref(pref: ThemePref) {
    const theme = resolveTheme(pref);
    state = { ...state, theme, settings: { ...state.settings, themePref: pref } };
    applyThemeDom(theme);
    emit();
  },
  setTab(tab: Tab) {
    state = { ...state, tab: tab === "shelf" || tab === "me" ? "today" : tab };
    emit();
  },
  setOnboarded() {
    state = { ...state, onboarded: true };
    emit();
  },
  setSheet(sheet: Sheet | null) {
    state = { ...state, sheet };
    emit();
    /* toast 可能先于 sheet 出现（评分 → 立刻退出）：sheet 开合时重新让位/复位 */
    requestAnimationFrame(repositionToasts);
    setTimeout(repositionToasts, 340);
  },
  setReaderPrefs(patch: Partial<ReaderPrefs>) {
    state = { ...state, reader: { ...state.reader, ...patch } };
    emit();
  },
  setSettings(patch: Partial<Settings>) {
    const settings = { ...state.settings, ...patch };
    state = { ...state, settings };
    if (patch.remindTime !== undefined || patch.daily !== undefined) {
      scheduleDailyReminder(settings.remindTime, settings.daily);
    }
    if (patch.fsScale !== undefined) applyFsDom(patch.fsScale);
    emit();
  },

  /* Per-profile secure writes are serialized so an older keystroke cannot
     overwrite a newer value. Browser preview keeps secrets in memory only. */
  setApiKey(v: string) {
    const next = v.trim();
    const target = repository, identity = target?.identity ?? "guest";
    state = { ...state, settings: { ...state.settings, apiKey: v, keyStored: false } };
    emit();
    if (!isTauri()) return;
      void credentialWork(() => next ? invokeRaw<void>("secret_put", { key: profileSecret(identity, KEYCHAIN_APIKEY), value: next }) : invokeRaw<void>("secret_delete", { key: profileSecret(identity, KEYCHAIN_APIKEY) }))
        .then(() => {
          /* 输入又变了（旧请求晚到）→ 放弃本次标记，以最新输入为准 */
          if (repository !== target || getState().settings.apiKey.trim() !== next) return;
          state = { ...state, settings: { ...state.settings, keyStored: true } };
          emit();
        })
        .catch((err: unknown) => {
          if (repository !== target) return;
          actions.pushDiag({
            time: Date.now(),
            kind: "keychain",
            msg: `Key 存入钥匙串失败，仅本次会话可用，未持久保存：${err instanceof Error ? err.message : String(err)}`,
          });
        });
  },

  /* ---------- U-11：讯飞三件套唯一写入口（与模型 Key 同路径） ----------
     真机：任一凭据非空即三件 secret_put 入钥匙串，成功后 voiceKeyStored=true（落盘置空）；
     失败仅本次会话可用。浏览器预览不持久保存凭据。 */
  setVoiceCreds(voiceAppId: string, voiceApiKey: string, voiceApiSecret: string) {
    const target = repository, identity = target?.identity ?? "guest";
    const next = [voiceAppId.trim(), voiceApiKey.trim(), voiceApiSecret.trim()];
    state = { ...state, settings: { ...state.settings, voiceAppId, voiceApiKey, voiceApiSecret, voiceKeyStored: false } };
    emit();
    if (!isTauri()) return;
      void credentialWork(async () => {
        const keys = [KEYCHAIN_VOICE_APPID,KEYCHAIN_VOICE_KEY,KEYCHAIN_VOICE_SECRET];
        for (let index=0;index<keys.length;index++) { const key = profileSecret(identity,keys[index]); if (next[index]) await invokeRaw<void>("secret_put", {key,value:next[index]}); else await invokeRaw<void>("secret_delete", {key}); }
      })
        .then(() => {
          /* 输入又变了（旧请求晚到）→ 放弃本次标记，以最新输入为准 */
          const cur = getState().settings;
          if (repository !== target || cur.voiceAppId.trim() !== next[0] || cur.voiceApiKey.trim() !== next[1] || cur.voiceApiSecret.trim() !== next[2]) return;
          state = { ...state, settings: { ...state.settings, voiceKeyStored: true } };
          emit();
        })
        .catch((err: unknown) => {
          if (repository !== target) return;
          actions.pushDiag({
            time: Date.now(),
            kind: "keychain",
            msg: `讯飞凭据存入钥匙串失败，仅本次会话可用，未持久保存：${err instanceof Error ? err.message : String(err)}`,
          });
        });
  },

  /* 收词：出处为真实参数（§6.3④，替代 spike 的 sourceArticleId:"trees" 硬编码） */
  saveWord(
    entry: {
      word: string;
      kind: "word" | "chunk";
      chunkType?: string;
      phonetic?: string;
      senses: DictSenses[];
      pattern?: string;
      trap?: string;
    },
    kind: "word" | "chunk",
    source?: { articleId: string; sentIdx: number },
  ) {
    if (state.vocab.some((v) => v.word.toLowerCase() === entry.word.toLowerCase())) return;
    const w: VocabWord = {
      id: entry.word.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Math.random().toString(36).slice(2, 6),
      word: entry.word,
      kind,
      chunkType: kind === "chunk" ? entry.chunkType : undefined,
      phonetic: entry.phonetic,
      senses: entry.senses.length ? entry.senses : [{ pos: "", cn: "（暂无释义，待下次查询补上）" }],
      pattern: entry.pattern,
      trap: entry.trap,
      sourceArticleId: source?.articleId || state.readingArticleId || "",
      sourceSentenceIdx: source?.sentIdx ?? 0,
      dueAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(), generation: crypto.randomUUID(), srs: initialSrs(Date.now()),
    };
    state = {
      ...state,
      vocab: [w, ...state.vocab],
      stats: { ...state.stats, week: { ...state.stats.week, add: state.stats.week.add + 1 } },
    };
    emit();
    /* U-19：收词触感（规格：收词=light；真机轻微单脉冲，浏览器 vibrate 静默失败） */
    haptic("light");
    toast(`已收藏「${entry.word}」`, { action: "去看看", onAction: () => actions.setTab("vocab") });
  },

  /* 删除 = 先从 UI 移除 + 快照入 trash，5s 后真正提交；撤销恢复（评审要点 7②） */
  deleteWord(id: string) {
    const idx = state.vocab.findIndex((v) => v.id === id);
    if (idx < 0) return;
    const snap = state.vocab[idx];
    commitTrash();
    state = { ...state, vocab: state.vocab.filter((v) => v.id !== id), trash: { kind: "vocab", index: idx, vocab: snap } };
    emit();
    startTrashTimer();
    toast(`已移出生词本 · ${snap.word}`, { action: "撤销", onAction: () => actions.undoTrash() });
  },
  deleteArticle(id: string) {
    const idx = state.articles.findIndex((a) => a.id === id);
    if (idx < 0) return;
    const snap = state.articles[idx];
    commitTrash();
    state = { ...state, articles: state.articles.map(a => a.id === id ? { ...a, archived: true, updatedAt: Date.now() } : a), trash: { kind: "article", index: idx, article: snap } };
    emit();
    startTrashTimer();
    toast(`已移出书架 · ${snap.title}`, { action: "撤销", onAction: () => actions.undoTrash() });
  },
  deleteHistory(id: string) {
    const idx = state.history.findIndex((h) => h.id === id);
    if (idx < 0) return;
    const snap = state.history[idx];
    commitTrash();
    state = { ...state, history: state.history.filter((h) => h.id !== id), trash: { kind: "history", index: idx, item: snap } };
    emit();
    startTrashTimer();
    toast("已删除这条记录", { action: "撤销", onAction: () => actions.undoTrash() });
  },
  /** 删除笔记（与生词/文章同款 trash + 5s 撤销；笔记库左滑触发）。 */
  deleteNote(id: string) {
    const idx = state.notes.findIndex((n) => n.id === id);
    if (idx < 0) return;
    const snap = state.notes[idx];
    commitTrash();
    state = { ...state, notes: state.notes.filter((n) => n.id !== id), trash: { kind: "note", index: idx, note: snap } };
    emit();
    startTrashTimer();
    toast(`已删除笔记 · ${snap.title}`, { action: "撤销", onAction: () => actions.undoTrash() });
  },
  undoTrash() {
    const t = state.trash;
    if (!t) return;
    if (t.kind === "vocab" && t.vocab) {
      const vocab = [...state.vocab];
      vocab.splice(Math.min(t.index, vocab.length), 0, t.vocab);
      state = { ...state, vocab, trash: null };
    } else if (t.kind === "article" && t.article) {
      const articles = state.articles.map(article => article.id === t.article!.id ? { ...article, archived: !!t.article!.archived, updatedAt: Date.now() } : article);
      state = { ...state, articles, trash: null };
    } else if (t.kind === "history" && t.item) {
      const history = [...state.history];
      history.splice(Math.min(t.index, history.length), 0, t.item);
      state = { ...state, history, trash: null };
    } else if (t.kind === "note" && t.note) {
      const notes = [...state.notes];
      notes.splice(Math.min(t.index, notes.length), 0, t.note);
      state = { ...state, notes, trash: null };
    }
    hideToast();
    emit();
  },

  /* 评分：每张即落盘（与快速复习同源 #29）；lastGrade 支持 5s 撤销（治 I7） */
  gradeWord(id: string, dueAt: number) {
    state = { ...state, vocab: state.vocab.map((v) => (v.id === id ? { ...v, dueAt } : v)) };
    emit();
  },
  gradeVocab(id: string, grade: ReviewGrade, extra?: { eventId?: string; trap?: boolean; mode?: string; answer?: string; expected?: string; bucket?: "pass" | "wrong" | "trap" }): string | undefined {
    const prev = state.vocab.find((v) => v.id === id);
    if (!prev) return;
    if (extra?.eventId) {
      const old = state.reviewEvents.find(event => event.id === extra.eventId);
      if (old) {
        if (old.kind !== "grade" || old.wordId !== id || old.grade !== grade || old.mode !== (extra.mode ?? "recognition") || old.generation !== prev.generation || old.recall?.bucket !== extra.bucket || old.recall?.answer !== extra.answer || old.recall?.expected !== extra.expected) throw new Error("复习事件 ID 已用于其他评分，请恢复原记录后继续");
        return old.id;
      }
    }
    const event: ReviewEvent = { v: 2, id: extra?.eventId ?? crypto.randomUUID(), wordId: id, deviceId: deviceId(), reviewedAt: Date.now(), kind: "grade", grade, day: new Date().toLocaleDateString("en-CA"), mode: extra?.mode ?? "recognition", ...(extra?.bucket ? { recall: { bucket:extra.bucket,answer:extra.answer,expected:extra.expected } } : {}), generation: prev.generation };
    const events = [...state.reviewEvents, event];
    const baseline = prev.srsBaseline ?? (prev.baseline as typeof prev.srs) ?? prev.srs ?? initialSrs(prev.dueAt);
    const baselineRecall = (prev.baselineRecall ?? (state.reviewEvents.some(e => e.wordId === id) ? undefined : prev.recall)) as ReturnType<typeof reduceReviewEvents>["recall"] | undefined;
    const { srs, recall } = reduceReviewEvents(baseline, events, id, prev.generation, baselineRecall);
    const dueAt = srs.dueAt;
    /* 同一张卡当日只计一次清卡/复习：forgot 10 分钟回流再清不重复计数，
       folio「已清 N/M」分母不再随回流变大（治 state-5；上限 200 防异常增长）。 */
    const counted = !state.stats.clearedIds.includes(id);
    /* 判错落账（治 ux-cross-1）：forgot / 陷阱评分记 lastWrongAt，
       「只测仍错」按此构卡（判分建议 JUDGE_SUGGEST 把 wrong/trap 都映射 forgot） */
    const isWrong = grade === "forgot" || !!extra?.trap;
    state = {
      ...state,
      reviewEvents: events,
      vocab: state.vocab.map((v) =>
        v.id === id ? { ...v, srs, srsBaseline: baseline, baseline, baselineRecall: baselineRecall ?? { total: {pass:0,wrong:0,trap:0},byMode:{} }, recall, updatedAt: Date.now(), dueAt, ...(isWrong ? { lastWrongAt: Date.now() } : {}) } : v,
      ),
      stats: {
        ...state.stats,
        clearedToday: state.stats.clearedToday + (counted ? 1 : 0),
        clearedIds: counted ? [...state.stats.clearedIds, id].slice(-200) : state.stats.clearedIds,
        week: {
          ...state.stats.week,
          review: state.stats.week.review + (counted ? 1 : 0),
          trap: state.stats.week.trap + (extra?.trap && counted ? 1 : 0),
        },
      },
      lastGrade: prev
        ? { id, eventId: event.id, prevDueAt: prev.dueAt, counted, wasTrap: !!(extra?.trap && counted), prevWrongAt: prev.lastWrongAt ?? null }
        : null,
    };
    emit();
    return event.id;
  },
  undoGrade() {
    const lg = state.lastGrade;
    if (!lg) return;
    if (lg.eventId) {
      const word = state.vocab.find(v => v.id === lg.id);
      if (!word) return;
      const event: ReviewEvent = { v: 2, id: crypto.randomUUID(), wordId: word.id, deviceId: deviceId(), reviewedAt: Date.now(), kind: "undo", mode: "recognition", generation: word.generation, reversesEventId: lg.eventId };
      const events = [...state.reviewEvents, event];
      const { srs, recall } = reduceReviewEvents(word.srsBaseline ?? initialSrs(lg.prevDueAt), events, word.id, word.generation, word.baselineRecall as ReturnType<typeof reduceReviewEvents>["recall"] | undefined);
      const dec = lg.counted === false ? 0 : 1;
      state = { ...state, reviewEvents: events, vocab: state.vocab.map(v => v.id === word.id ? { ...v, srs, recall, dueAt: srs.dueAt, lastWrongAt: lg.prevWrongAt ?? undefined, updatedAt: Date.now() } : v), stats: { ...state.stats, clearedToday: Math.max(0, state.stats.clearedToday-dec), clearedIds: dec ? state.stats.clearedIds.filter(id => id !== word.id) : state.stats.clearedIds, week: { ...state.stats.week, review: Math.max(0,state.stats.week.review-dec), trap: Math.max(0,state.stats.week.trap-(lg.wasTrap?1:0)) } }, lastGrade: null };
      emit(); return;
    }
    /* 只有确实计过数的那次才回退（回流卡的重复评分没计数，撤销也不该减成负数）；
       trap 同步回滚（治 state-7：撤销评分后本周「直译陷阱」不再虚高到跨周） */
    const dec = lg.counted === false ? 0 : 1;
    state = {
      ...state,
      vocab: state.vocab.map((v) =>
        v.id === lg.id ? { ...v, dueAt: lg.prevDueAt, lastWrongAt: lg.prevWrongAt ?? undefined } : v,
      ),
      stats: {
        ...state.stats,
        clearedToday: Math.max(0, state.stats.clearedToday - dec),
        clearedIds: dec ? state.stats.clearedIds.filter((x) => x !== lg.id) : state.stats.clearedIds,
        week: {
          ...state.stats.week,
          review: Math.max(0, state.stats.week.review - dec),
          trap: Math.max(0, state.stats.week.trap - (lg.wasTrap ? 1 : 0)),
        },
      },
      lastGrade: null,
    };
    emit();
  },

  setProgress(articleId: string, sent: number) {
    if ((state.progress[articleId] ?? -1) === sent) return;
    state = { ...state, progress: { ...state.progress, [articleId]: sent }, articles: state.articles.map(a => a.id === articleId ? { ...a, lastReadAt: Date.now(), updatedAt: Date.now() } : a) };
    emit();
  },
  /** 段级翻译回填（#35：导入文章 zh=null → 翻译管线逐句补齐）。 */
  fillSentenceZh(articleId: string, sentIdx: number, zh: string) {
    state = {
      ...state,
      articles: state.articles.map((a) =>
        a.id === articleId
          ? { ...a, sentences: a.sentences.map((s) => (s.idx === sentIdx && s.zhState !== "edited" ? { ...s, zh, zhState: "machine" as const } : s)) }
          : a,
      ),
    };
    emit();
  },
  addArticle(a: Article) {
    state = { ...state, articles: [{ ...a, createdAt: a.createdAt ?? Date.now(), updatedAt: Date.now() }, ...state.articles.filter(old => old.id !== a.id)] };
    emit();
  },
  setReading(articleId: string | null) {
    state = { ...state, readingArticleId: articleId };
    emit();
  },
  /** 「重新遮住全部译文」（MoreSheet 调用）：notify ReaderScreen 清空已揭示句（治 P-25） */
  remaskReader() {
    state = { ...state, remaskAt: Date.now() };
    emit();
  },
  locateReader(articleId: string, sent: number) {
    state = { ...state, readerTarget: { articleId, sent, nonce: Date.now() } };
    emit();
  },
  addHistory(item: { src: string; en: string; zh: string; time?: string; star?: boolean }) {
    const full: HistoryItem = { id: "h" + Date.now(), time: item.time || "刚刚", star: false, ...item };
    state = { ...state, history: [full, ...state.history] };
    emit();
  },
  async upsertTask(task: PracticeTask): Promise<void> {
    await replaceSyncedState(current => ({ tasks: [stampPracticeTask(current.tasks.find(t => t.id === task.id), task, Date.now()), ...current.tasks.filter(t => t.id !== task.id)] }));
    window.dispatchEvent(new Event("mobile-state-change"));
  },
  updateWord(id: string, patch: Partial<VocabWord>) {
    state = { ...state, vocab: state.vocab.map(w => w.id === id ? { ...w, ...patch, id, updatedAt: Date.now() } : w) }; emit();
  },
  setSessions(sessions: SpeakSession[]) { state = { ...state, sessions }; emit(); },
  setGlossary(glossary: GlossaryPair[]) { state = { ...state, glossary }; emit(); },
  setSpeakDifficulty(speakDifficulty: AppState["speakDifficulty"]) { state = { ...state, speakDifficulty }; emit(); },
  saveNote(note: NoteItem) { state = { ...state, notes: [{ ...note, updatedAt: Date.now() }, ...state.notes.filter(n => n.id !== note.id)] }; emit(); },
  addNote(n: Omit<NoteItem, "id">) {
    state = { ...state, notes: [{ id: crypto.randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), ...n }, ...state.notes] };
    emit();
  },
  setClip(en: string, zh: string) {
    state = { ...state, clip: { en, zh, ts: Date.now() } };
    emit();
  },
  /** 深链送入的分享文本（App 外壳写入，ShareScreen 消费后置 null）。 */
  setShareIn(share: { text: string; source: string } | null) {
    state = { ...state, shareIn: share };
    emit();
  },
  /** 诊断事件入队（环形 30 条；registerDiagSink 转发，不落盘）。 */
  pushDiag(e: DiagItem) {
    state = { ...state, diag: [...state.diag, e].slice(-30) };
    emit();
  },
  showBanner() {
    /* 「稍后」snooze：当晚（自然日口径）静默，次日恢复——不再纯 toast 假装 */
    if (state.snoozedAt && todayKey(new Date(state.snoozedAt)) === todayKey()) return;
    const st = reviewStats(state);
    const body = st.due > 0 ? `${st.due} 个生词到期 · 约 ${st.minutes} 分钟清完` : "今天的复习已清完 · 明晚见";
    state = { ...state, banner: { title: "今晚的复习提醒", body, at: Date.now() } };
    emit();
  },
  /** 横幅「稍后」：关横幅 + 记录 snooze（当晚不再弹）。 */
  snoozeBanner() {
    state = { ...state, banner: null, snoozedAt: Date.now() };
    emit();
  },
  closeBanner() {
    state = { ...state, banner: null };
    emit();
  },
  /** 结束一轮完整复习：streak +1（当日全部清完时由调用方判定 due===0）。
      全库唯一累加点——hydrate 跨天只保留/清零、不再 +1（治双重累加）。 */
  finishReviewStreak() {
    const day = todayKey();
    if (state.stats.lastReviewStreakDay === day) return;
    state = { ...state, stats: { ...state.stats, streak: state.stats.streak + 1, lastReviewStreakDay: day } };
    emit();
  },
  async completeReviewSession(draftId: string, countStreak: boolean) {
    await replaceSyncedState(current => {
      const day = todayKey();
      return countStreak && current.stats.lastReviewStreakDay !== day
        ? { stats: { ...current.stats, streak: current.stats.streak + 1, lastReviewStreakDay: day } }
        : {};
    }, { records: [{ collection: "local.review", id: draftId, payload: null, deleted: true }] });
  },
};

/* ---------- 内部：trash 提交计时 ---------- */
let trashTimer: ReturnType<typeof setTimeout> | null = null;
function startTrashTimer() {
  if (trashTimer) clearTimeout(trashTimer);
  trashTimer = setTimeout(commitTrash, 5000);
}
function commitTrash() {
  if (trashTimer) {
    clearTimeout(trashTimer);
    trashTimer = null;
  }
  if (state.trash) {
    state = { ...state, trash: null };
    emit();
  }
}

/* ---------- toast（支持撤销/跳转动作，5s 撤销窗） ---------- */
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export interface ToastOpts {
  action?: string;
  onAction?: () => void;
  duration?: number;
}
/* sheet 打开时 toast 上移让位，关闭时复位（验收 #4：不与 sheet 文字互相遮挡）。
   U-22：让位量改走 --toast-lift（.toast.on 的 translateY 消费），复用 200ms transform 过渡，
   不再直写 style.bottom 瞬移；sheet 的 offsetHeight 已含其安全区 padding，与 bottom 常量
   96+12 相减抵消，无需读 env。 */
function repositionToasts() {
  const sheet = document.querySelector<HTMLElement>(".sheet.on");
  document.querySelectorAll<HTMLElement>(".toast").forEach((t) => {
    t.style.setProperty("--toast-lift", sheet ? `${Math.round(84 - sheet.offsetHeight)}px` : "0px");
  });
}
export function toast(msg: string, opts: ToastOpts = {}) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = document.createElement("div");
  t.className = "toast";
  /* U-29（WCAG 4.1.3）：读屏播报动态消息；中性/成功用 status（收藏、撤销、跳转提示） */
  t.setAttribute("role", "status");
  const span = document.createElement("span");
  span.textContent = msg;
  t.appendChild(span);
  if (opts.action) {
    const b = document.createElement("button");
    b.className = "undo";
    b.textContent = opts.action;
    b.addEventListener("click", () => {
      opts.onAction?.();
      t.remove();
    });
    t.appendChild(b);
  }
  const tl = document.createElement("i");
  tl.className = "tl";
  t.appendChild(tl);
  document.body.appendChild(t);
  repositionToasts();
  requestAnimationFrame(() => t.classList.add("on"));
  const dur = opts.duration ?? (opts.action ? 5000 : 2200);
  tl.style.transition = "none";
  tl.style.transform = "scaleX(1)";
  void tl.offsetWidth;
  tl.style.transition = `transform ${dur}ms linear`;
  tl.style.transform = "scaleX(0)";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove("on");
    setTimeout(() => t.remove(), 240);
  }, dur);
}
export function hideToast() {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  if (toastTimer) clearTimeout(toastTimer);
}

/* ---------- TTS（云优先路由 gap g6：凭据齐全（真机）→ services/voice speakCloud 云 TTS，
   失败降级 speechSynthesis 并报诊断；无凭据 → 本地 speechSynthesis 原路径，保留估时兜底双保险） ---------- */
let voiceEn: SpeechSynthesisVoice | null = null;
let voiceZh: SpeechSynthesisVoice | null = null;
function pickVoice() {
  if (!("speechSynthesis" in window)) return;
  const vs = speechSynthesis.getVoices();
  const en = vs.filter((v) => /^en(-|_)/i.test(v.lang));
  voiceEn = en.find((v) => /Google US|Natural|Samantha|Zira/i.test(v.name)) || en[0] || null;
  const zh = vs.filter((v) => /^zh(-|_)/i.test(v.lang));
  voiceZh = zh[0] || null;
}
if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}
/** spike S3a 观察点：onstart/onend 命中计数（我的 → spike 自检消费；云路径不经过 speechSynthesis，不计数）。 */
export const ttsEvents = { start: 0, end: 0 };

/** 云播报停止句柄（stopSpeak 中断云播报；done 结束后置空）。 */
let cloudStopper: (() => void) | null = null;

/** 本地 speechSynthesis 路径（onend + 估时兜底双保险，spike S3a 已验证）——
    也是云 TTS 失败后的降级落点。 */
function speakLocal(text: string, rate: number, onend: (() => void) | undefined, lang: "en" | "zh"): void {
  if (!("speechSynthesis" in window)) {
    onend?.();
    return;
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === "zh" ? "zh-CN" : "en-US";
  u.rate = rate;
  const v = lang === "zh" ? voiceZh : voiceEn;
  if (v) u.voice = v;
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
  const perUnit = lang === "zh" ? 260 : 380;
  const estMs = (text.split(/\s+|(?=[\u4e00-\u9fff])/).length * perUnit) / Math.max(0.5, rate) + 1200;
  setTimeout(() => done("fallback"), estMs);
  speechSynthesis.speak(u);
}

/** 云播报代数：speak 每次递增——旧句被打断后迟到的 done 一律按「已被取代」丢弃。 */
let speakToken = 0;

/** 朗读统一入口（签名/语义不变，内部云优先路由 gap g6）：
    讯飞凭据齐（真机）→ speakCloud 云 TTS，成败与时长以 done→onend 为准，不做估时兜底；
    云失败 → reportDiag 上报后降级本地 speechSynthesis（估时兜底仅在此路径生效）；
    无凭据/浏览器 → 直接本地 speechSynthesis。
    注：不走 voice.ts 的 speakWithFallback 而用契约内 speakCloud({stop,done})——
    stopSpeak 需要云句柄才能中断在播音轨（speakWithFallback 返回 void 拿不到句柄）；
    「云优先→失败降级+诊断」语义与其等价（其早期版本降级会回调 store.speak，委托即互调环）。 */
export function speak(text: string, rate = 1, onend?: () => void, lang: "en" | "zh" = "en"): void {
  if (repository?.identity !== "guest" && cloudAvailable()) {
    const token = ++speakToken;
    cloudStopper?.();
    cloudStopper = null;
    const h = speakCloud(text, undefined, rate);
    cloudStopper = h.stop;
    h.done
      .then(() => {
        /* 连续朗读打断旧句的竞态（治 state-3）：stop() 让旧 src 触发 onended、旧 done 以成功落定，
           若不拦，旧回调会把新句的 cloudStopper 清空（stopSpeak 停不掉新句）并误触旧 onend
           （跟读领读 phase 被翻回 idle）。token 不匹配 = 旧句已被取代，直接丢弃。 */
        if (token !== speakToken) return;
        cloudStopper = null;
        onend?.();
      })
      .catch((err: unknown) => {
        /* 被打断的旧合成迟到的失败：不降级重播旧文本（否则叠成双声） */
        if (token !== speakToken) return;
        const msg = err instanceof Error ? err.message : String(err);
        reportDiag("tts", `云 TTS 失败，已降级系统朗读：${msg}`);
        cloudStopper = null;
        speakLocal(text, rate, onend, lang);
      });
    return;
  }
  speakLocal(text, rate, onend, lang);
}
export function stopSpeak() {
  speakToken++; /* 已停止：在途云句迟到的 done/onend 一律视为被打断，不再回调 */
  cloudStopper?.();
  cloudStopper = null;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

/* ---------- 首次主题/字号档落 DOM ---------- */
applyThemeDom(state.theme);
applyFsDom(state.settings.fsScale);

/* 启动标记：随诊断汇落盘（每次启动一条）——拉库时既证明持久化链路工作，
   又能把后续 TTS 事件对上具体哪次会话（真机无声问题的分阶段定位依赖它）。 */
actions.pushDiag({
  time: Date.now(),
  kind: "boot",
  msg: `启动 · ${isTauri() ? "真机" : "浏览器"} · 朗读引擎 ${state.settings.ttsEngine}${state.settings.edgeVoice ? `（${state.settings.edgeVoice}）` : ""}`,
});
