/**
 * store v3 —— 演进自 spike 内存态（§6.3）：
 *  · 保持 actions API 形状（setTheme/setSheet/saveWord/deleteWord/gradeWord），
 *    底层换 localStorage 持久化 + 启动 hydrate（版本化，可迁移；Rust SQLite 为真机落点）。
 *  · 新增 reviewStats（#52 三处同源）、settings/history/notes/reader 切片。
 *  · 左滑删除 = 移除 + 快照入 trash，5s 后真正提交；撤销恢复快照（评审要点 7②）。
 *  · 演示数据仅未改动时兜底，标注「演示」；DEMO_VOCAB/DEMO_ARTICLES 沿用 core 数据。
 */
import { useSyncExternalStore } from "react";
import type { Article, VocabWord } from "./core/types";
import { DEMO_VOCAB } from "./core/data";
import { DEMO_SLOW, DEMO_TREES, type ChatTurn } from "./core/demo";
import { GRADE_INTERVALS, type ReviewGrade } from "./core/srs";
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
  /** API Key 明文（内存态；真机入钥匙串后仅会话内持有。keyStored=false 时明文兜底 localStorage——浏览器态/迁移失败，Key 不丢） */
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

interface AppState {
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
  lastGrade: { id: string; prevDueAt: number; counted?: boolean; wasTrap?: boolean; prevWrongAt?: number | null } | null;
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
    vocab: [...DEMO_VOCAB],
    articles: [DEMO_TREES, DEMO_SLOW],
    progress: { trees: 7, slow: 0 },
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
      daily: true,
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
const STORE_VERSION = 3;
/** API Key 的钥匙串条目 key（Rust keychain.rs service="ita.secrets"，account 即此值）。 */
const KEYCHAIN_APIKEY = "apiKey";
/** 讯飞三件套的钥匙串条目 key（U-11：与模型 Key 同路径，不再明文落 localStorage）。 */
const KEYCHAIN_VOICE_APPID = "voiceAppId";
const KEYCHAIN_VOICE_KEY = "voiceApiKey";
const KEYCHAIN_VOICE_SECRET = "voiceApiSecret";

function persistable(s: AppState) {
  return {
    version: STORE_VERSION,
    theme: s.theme,
    onboarded: s.onboarded,
    vocab: s.vocab,
    articles: s.articles,
    progress: s.progress,
    /* B6 ①：API Key 只存钥匙串——keyStored（已入钥匙串）时落盘置空，localStorage 不再明文；
       未入钥匙串（浏览器态/迁移失败）保留明文兜底，Key 不丢（见 setApiKey/启动迁移）。
       U-11：讯飞三件套同路径，voiceKeyStored 时三件一并置空。 */
    settings: {
      ...s.settings,
      apiKey: s.settings.keyStored ? "" : s.settings.apiKey,
      voiceAppId: s.settings.voiceKeyStored ? "" : s.settings.voiceAppId,
      voiceApiKey: s.settings.voiceKeyStored ? "" : s.settings.voiceApiKey,
      voiceApiSecret: s.settings.voiceKeyStored ? "" : s.settings.voiceApiSecret,
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
  if (raw.version !== STORE_VERSION) return null;
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
      theme,
      onboarded: Boolean(raw.onboarded),
      tab: "today",
      vocab: (raw.vocab as VocabWord[]) || base.vocab,
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

function hydrate(): AppState {
  let s = demoState();
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null") as Record<string, unknown> | null;
    if (raw) {
      const migrated = migrate(raw);
      if (migrated) {
        s = migrated;
        /* 跨零点：streak 只在 finishReviewStreak（退出完成页）累加，此处仅判定保留或清零——
           昨日有清且上次活跃日就是昨天 → 保留（昨天已 +1 过）；否则清零（隔整天未打开/昨日没清）。
           治双重累加：此前这里再 +1，同一天清完被记两次（N 天记成 2N-1）。 */
        if (s.stats.day !== todayKey()) {
          s.stats = {
            ...s.stats,
            streak: s.stats.clearedToday > 0 && s.stats.day === yesterdayKey() ? s.stats.streak : 0,
            clearedToday: 0,
            clearedIds: [],
            day: todayKey(),
          };
        }
        /* 自然周重置（治缺口：原逻辑只处理 streak/clearedToday）：ISO 周变化 → 本周三项归零。
           streak/clearedToday 仍按日口径独立判定，互不影响。 */
        if (s.stats.weekKey !== isoWeekKey()) {
          s.stats = { ...s.stats, week: { review: 0, add: 0, trap: 0 }, weekKey: isoWeekKey() };
        }
      } else {
        /* 版本不符/字段损坏回退演示态前，先把原始数据备份到 .bak 键：随后 demo 态的首次落盘
           会覆盖主键，没有这份备份用户数据就无迹可寻（治 state-4 整包覆盖丢失）。 */
        try {
          localStorage.setItem(STORE_KEY + ".bak", JSON.stringify(raw));
        } catch {
          /* 存储满/隐私模式：尽力而为 */
        }
      }
    }
  } catch {
    /* 坏数据兜底演示态 */
  }
  /* B6 ①：浏览器态无钥匙串——keyStored/voiceKeyStored 复位 false，防老数据 stored=true 时
     persistable 置空把 localStorage 里唯一一份明文 Key 抹掉（真机由启动迁移维护）。 */
  if (!isTauri()) s.settings = { ...s.settings, keyStored: false, voiceKeyStored: false };
  return s;
}

let state: AppState = hydrate();
state.theme = resolveTheme(state.settings.themePref);

function resolveTheme(pref: ThemePref): Theme {
  if (pref === "system") {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return pref;
}

const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  listeners.forEach((l) => l());
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(persistable(state)));
    } catch {
      /* 存储满/隐私模式静默 */
    }
  }, 200);
}

/** 立即落盘（App.tsx 在 visibilitychange hidden / pagehide 时调用，治 state-8）：
 *  emit 的 200ms 防抖在 iOS 切后台时 WKWebView 会挂起定时器——评分后立刻切后台/杀 App，
 *  最后一张卡的 dueAt 与统计可能未写盘，重启后该卡重新到期、clearedToday 回退。 */
export function flushPersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(persistable(state)));
  } catch {
    /* 存储满/隐私模式静默 */
  }
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
  const dueList = s.vocab.filter((v) => v.dueAt <= now);
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
    state = { ...state, tab };
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

  /* ---------- B6 ①：API Key 唯一写入口（Key 只存钥匙串） ----------
     真机：值变化即 secret_put 入钥匙串，成功后 keyStored=true（persistable 随之置空，
     localStorage 不再落明文）；失败 → keyStored=false 明文兜底 + 诊断，Key 不丢。
     清空：同步 secret_delete（防下次启动 hydrate 从钥匙串回填复活旧 Key）。
     浏览器：无钥匙串，明文 localStorage 兜底（hydrate 已把 keyStored 复位 false）。 */
  setApiKey(v: string) {
    const prev = state.settings.apiKey.trim();
    const next = v.trim();
    state = { ...state, settings: { ...state.settings, apiKey: v, keyStored: false } };
    emit();
    if (!isTauri()) return;
    if (next) {
      void invokeRaw<void>("secret_put", { key: KEYCHAIN_APIKEY, value: next })
        .then(() => {
          /* 输入又变了（旧请求晚到）→ 放弃本次标记，以最新输入为准 */
          if (getState().settings.apiKey.trim() !== next) return;
          state = { ...state, settings: { ...state.settings, keyStored: true } };
          emit();
        })
        .catch((err: unknown) => {
          actions.pushDiag({
            time: Date.now(),
            kind: "keychain",
            msg: `Key 存入钥匙串失败，暂以明文保存在本机：${err instanceof Error ? err.message : String(err)}`,
          });
        });
    } else if (prev) {
      void invokeRaw<void>("secret_delete", { key: KEYCHAIN_APIKEY }).catch((err: unknown) => {
        actions.pushDiag({
          time: Date.now(),
          kind: "keychain",
          msg: `钥匙串清理失败（下次启动可能回填旧 Key）：${err instanceof Error ? err.message : String(err)}`,
        });
      });
    }
  },

  /* ---------- U-11：讯飞三件套唯一写入口（与模型 Key 同路径） ----------
     真机：任一凭据非空即三件 secret_put 入钥匙串，成功后 voiceKeyStored=true（落盘置空）；
     失败 → voiceKeyStored=false 明文兜底 + 诊断。清空：三件同步 secret_delete。
     浏览器：无钥匙串，明文 localStorage 兜底（hydrate 已把 voiceKeyStored 复位 false）。 */
  setVoiceCreds(voiceAppId: string, voiceApiKey: string, voiceApiSecret: string) {
    const prev = [
      state.settings.voiceAppId.trim(),
      state.settings.voiceApiKey.trim(),
      state.settings.voiceApiSecret.trim(),
    ];
    const next = [voiceAppId.trim(), voiceApiKey.trim(), voiceApiSecret.trim()];
    state = { ...state, settings: { ...state.settings, voiceAppId, voiceApiKey, voiceApiSecret, voiceKeyStored: false } };
    emit();
    if (!isTauri()) return;
    if (next[1] || next[2]) {
      void Promise.all([
        invokeRaw<void>("secret_put", { key: KEYCHAIN_VOICE_APPID, value: voiceAppId }),
        invokeRaw<void>("secret_put", { key: KEYCHAIN_VOICE_KEY, value: voiceApiKey }),
        invokeRaw<void>("secret_put", { key: KEYCHAIN_VOICE_SECRET, value: voiceApiSecret }),
      ])
        .then(() => {
          /* 输入又变了（旧请求晚到）→ 放弃本次标记，以最新输入为准 */
          const cur = getState().settings;
          if (cur.voiceAppId.trim() !== next[0] || cur.voiceApiKey.trim() !== next[1] || cur.voiceApiSecret.trim() !== next[2]) return;
          state = { ...state, settings: { ...state.settings, voiceKeyStored: true } };
          emit();
        })
        .catch((err: unknown) => {
          actions.pushDiag({
            time: Date.now(),
            kind: "keychain",
            msg: `讯飞凭据存入钥匙串失败，暂以明文保存在本机：${err instanceof Error ? err.message : String(err)}`,
          });
        });
    } else if (prev[1] || prev[2]) {
      void Promise.all([
        invokeRaw<void>("secret_delete", { key: KEYCHAIN_VOICE_APPID }),
        invokeRaw<void>("secret_delete", { key: KEYCHAIN_VOICE_KEY }),
        invokeRaw<void>("secret_delete", { key: KEYCHAIN_VOICE_SECRET }),
      ]).catch((err: unknown) => {
        actions.pushDiag({
          time: Date.now(),
          kind: "keychain",
          msg: `讯飞凭据钥匙串清理失败（下次启动可能回填旧值）：${err instanceof Error ? err.message : String(err)}`,
        });
      });
    }
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
      dueAt: Date.now(),
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
    state = { ...state, articles: state.articles.filter((a) => a.id !== id), trash: { kind: "article", index: idx, article: snap } };
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
      const articles = [...state.articles];
      articles.splice(Math.min(t.index, articles.length), 0, t.article);
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
  gradeVocab(id: string, grade: ReviewGrade, extra?: { trap?: boolean }) {
    const prev = state.vocab.find((v) => v.id === id);
    const dueAt = Date.now() + GRADE_INTERVALS[grade].ms;
    /* 同一张卡当日只计一次清卡/复习：forgot 10 分钟回流再清不重复计数，
       folio「已清 N/M」分母不再随回流变大（治 state-5；上限 200 防异常增长）。 */
    const counted = !state.stats.clearedIds.includes(id);
    /* 判错落账（治 ux-cross-1）：forgot / 陷阱评分记 lastWrongAt，
       「只测仍错」按此构卡（判分建议 JUDGE_SUGGEST 把 wrong/trap 都映射 forgot） */
    const isWrong = grade === "forgot" || !!extra?.trap;
    state = {
      ...state,
      vocab: state.vocab.map((v) =>
        v.id === id ? { ...v, dueAt, ...(isWrong ? { lastWrongAt: Date.now() } : {}) } : v,
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
        ? { id, prevDueAt: prev.dueAt, counted, wasTrap: !!(extra?.trap && counted), prevWrongAt: prev.lastWrongAt ?? null }
        : null,
    };
    emit();
  },
  undoGrade() {
    const lg = state.lastGrade;
    if (!lg) return;
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
    state = { ...state, progress: { ...state.progress, [articleId]: sent } };
    emit();
  },
  /** 段级翻译回填（#35：导入文章 zh=null → 翻译管线逐句补齐）。 */
  fillSentenceZh(articleId: string, sentIdx: number, zh: string) {
    state = {
      ...state,
      articles: state.articles.map((a) =>
        a.id === articleId
          ? { ...a, sentences: a.sentences.map((s) => (s.idx === sentIdx ? { ...s, zh } : s)) }
          : a,
      ),
    };
    emit();
  },
  addArticle(a: Article) {
    state = { ...state, articles: [a, ...state.articles] };
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
  addNote(n: Omit<NoteItem, "id">) {
    state = { ...state, notes: [{ id: "n" + Date.now(), ...n }, ...state.notes] };
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
    state = { ...state, stats: { ...state.stats, streak: state.stats.streak + 1 } };
    emit();
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
  if (cloudAvailable()) {
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

/* ---------- B6 ①：启动 Key 迁移/补拉（真机；hydrate 后异步执行） ----------
   · localStorage 有明文（迁移前老数据/上次迁移失败）→ secret_put 入钥匙串，
     成功后 keyStored=true，persistable 落盘即不再带明文（「Key 只存钥匙串」由此成立）；
     失败 → 保留明文兜底 + 诊断，Key 不丢。
   · localStorage 空（已迁移/新设备钥匙串已有）→ secret_get 回填内存态。
   · 浏览器无钥匙串，跳过（明文 localStorage 兜底）。 */
if (isTauri()) {
  void (async () => {
    try {
      const stored = await invokeRaw<string | null>("secret_get", { key: KEYCHAIN_APIKEY });
      const local = getState().settings.apiKey.trim();
      if (local) {
        try {
          await invokeRaw<void>("secret_put", { key: KEYCHAIN_APIKEY, value: local });
          state = { ...state, settings: { ...state.settings, apiKey: local, keyStored: true } };
          emit();
        } catch (err) {
          actions.pushDiag({
            time: Date.now(),
            kind: "keychain",
            msg: `Key 迁移钥匙串失败，继续以明文保存在本机：${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } else if (stored) {
        actions.setSettings({ apiKey: stored, keyStored: true });
      }
    } catch (err) {
      actions.pushDiag({
        time: Date.now(),
        kind: "keychain",
        msg: `钥匙串读取失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  })();

  /* U-11：讯飞三件套启动迁移/回填（与模型 Key 同款逻辑；三件任一在即整组入钥匙串）。 */
  void (async () => {
    try {
      const s = getState().settings;
      const local = [s.voiceAppId, s.voiceApiKey, s.voiceApiSecret];
      if (local.some((v) => v.trim())) {
        await Promise.all([
          invokeRaw<void>("secret_put", { key: KEYCHAIN_VOICE_APPID, value: local[0] }),
          invokeRaw<void>("secret_put", { key: KEYCHAIN_VOICE_KEY, value: local[1] }),
          invokeRaw<void>("secret_put", { key: KEYCHAIN_VOICE_SECRET, value: local[2] }),
        ]);
        const cur = getState().settings;
        if (cur.voiceAppId === local[0] && cur.voiceApiKey === local[1] && cur.voiceApiSecret === local[2]) {
          state = { ...state, settings: { ...state.settings, voiceKeyStored: true } };
          emit();
        }
      } else {
        const stored = await Promise.all([
          invokeRaw<string | null>("secret_get", { key: KEYCHAIN_VOICE_APPID }),
          invokeRaw<string | null>("secret_get", { key: KEYCHAIN_VOICE_KEY }),
          invokeRaw<string | null>("secret_get", { key: KEYCHAIN_VOICE_SECRET }),
        ]);
        if (stored[1] || stored[2]) {
          actions.setSettings({ voiceAppId: stored[0] || "", voiceApiKey: stored[1] || "", voiceApiSecret: stored[2] || "", voiceKeyStored: true });
        }
      }
    } catch (err) {
      actions.pushDiag({
        time: Date.now(),
        kind: "keychain",
        msg: `讯飞凭据钥匙串迁移失败，继续以明文保存在本机：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  })();
}
