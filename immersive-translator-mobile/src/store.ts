/**
 * 身份隔离的学习状态仓储，沿用 spike 的 actions API。
 *  · 浏览器用 IndexedDB，原生用 Rust SQLite；启动 hydrate 与旧数据迁移先于页面显示。
 *  · 新增 reviewStats（#52 三处同源）、settings/history/notes/reader 切片。
 *  · 左滑删除 = 移除 + 快照入 trash，5s 后真正提交；撤销恢复快照（评审要点 7②）。
 *  · 首次打开只提供明确的入门样文，不制造收藏、练习或复习历史。
 */
import { useSyncExternalStore } from "react";
import type { Article, SentenceParseContent, VocabWord } from "./core/types";
import { createPersistence, type Repository, type CommitInput } from "./core/persistence";
import { canonicalJson, initialSrs, mergePracticeTask, reduceReviewEvents, stampPracticeTask, type ReviewEvent } from "../../packages/learning-core/src/index";
import type { PracticeTask } from "./services/practice";
import type { SpeakSession } from "./core/sessions";
import type { GlossaryPair } from "./core/glossary";
import { DEMO_STARTER, type ChatTurn } from "./core/demo";
import { curatedFeedDocs } from "./core/curated";
import { sourceBookTitleOf } from "./core/readingLibrary";
import { repairSentenceBoundaries, sentenceBoundaryKey } from "./core/repairSentenceBoundaries";
import { type ReviewGrade } from "./core/srs";
import { haptic, isTauri, reportDiag } from "./services/device";
import { prepareAudioPlayback, speakCloud, voiceErrorText } from "./services/voice";
import { cloudState } from "./services/cloud";
import { ensureAccount } from "./services/authGate";

export type Theme = "light" | "dark";
export type ThemePref = Theme | "system";
export type Tab = "today" | "practice" | "shelf" | "vocab" | "me";

export interface ReaderPrefs {
  /** 历史对照偏好保留用于兼容；新版正文始终英文，译文按需在帮助中展示。 */
  mode: "bi" | "en" | "zh";
  mask: boolean;
  fs: number;
  /** 阅读主题档（visual-theme-cleanup：第三档 sepia=纸书暖黄，经运行所有者授权扩联合）。
      旧持久化数据只有 paper/black，纯放宽无迁移；sepia 由 App 级 data-theme=sepia 全局生效。 */
  topic: "paper" | "sepia" | "black";
  chunkMark: boolean;
  rate: number;
  /** 阅读行距档（原型阅读设置口径：1.55 紧凑 / 1.78 舒适 / 2 宽松）。 */
  lh: number;
  /** 阅读新手引导条已收起（原型 APP.ui.coachDismissed；持久化避免每次进阅读器复现）。 */
  coachDismissed?: boolean;
}

export interface Settings {
  themePref: ThemePref;
  provider: string;
  /** 旧供应商设置兼容字段；不再使用，迁移时清空。 */
  keyStored: boolean;
  /** 旧版字段，移动端不使用个人服务密钥。 */
  apiKey: string;
  /** 接口地址覆盖；空 = 用 provider 预设（custom 时必填） */
  baseUrl: string;
  /** 模型名覆盖；空 = 用 provider 预设 */
  model: string;
  /** 旧版语音凭据兼容字段；迁移时清空。 */
  voiceAppId: string;
  voiceApiKey: string;
  voiceApiSecret: string;
  voiceKeyStored: boolean;
  /** 旧供应商字段仅保留快照兼容，移动端不再读取或使用。 */
  ttsEngine: "edge" | "xfyun";
  /** 旧音色设置兼容字段；声音改由 ttsVoice 决定。 */
  edgeVoice: string;
  /** 服务器下发的声音 ID；空值使用服务器默认声音。 */
  ttsVoice: string;
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

/** 我的场景（speaking-parity）：名称 ≤32 + 想说清楚什么 ≤120，按「目标/细节/问题」三步生成练习。 */
export interface CustomScene {
  id: string;
  title: string;
  goal: string;
  createdAt: number;
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
  example?: string;
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
  /** 完成必须由用户明确确认，与阅读断点独立保存。 */
  readingCompleted: Record<string, boolean>;
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
  /** 句级译文覆盖（本地 profile 专属，随快照持久化；不进云同步集合、不改 reading-articles schemaVersion）：
   *  articleId → 句 idx（字符串键）→ 用户改定的译文。 */
  sentenceZh: Record<string, Record<string, string>>;
  /** 当日实际到达的句子；跨日重新去重，跳读不补计中间未读句。 */
  readLog: { day: string; count: number; seen: Record<string, number[]> };
  sentenceParseCache: Record<string, Record<string, { en: string; result: SentenceParseContent }>>;
  /** 我的场景（speaking-parity · 本地 profile 专属，随快照持久化，不进云同步集合）。 */
  customScenes: CustomScene[];
  /** 已订阅的精选资讯源 id（proto-parity · 原型 APP.feeds，html:1579）：本地 profile 专属，
      随快照持久化、不进云同步集合；订阅即把该源样例文档（core/curated.ts）加入书架。 */
  curatedFeeds: string[];
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
    /* 首启书架内容种子：原型 DOCUMENTS.starter「A Small Break」（proto-parity-2026-11-01，
       html:1524）——read-fresh 态书架为空（我的内容不渲染）、hero 预览与「开始这篇短文」同源。 */
    articles: [{ ...DEMO_STARTER, sourceType: "sample" as const }],
    progress: {},
    readingCompleted: {},
    settings: {
      themePref: "system",
      provider: "account",
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
      ttsVoice: "",
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
      /* 学习方向默认值随原型 createState goal:'daily'（mobile-accepted-2026-10-29.html:1577）；
         旧持久值「读外刊与原版书」等由 GoalSheet 的 GOAL_LEGACY 映射到新三方向 */
      goal: "日常表达",
    },
    /* 统计基线归零（治 demo 14/15）：不再播种演示历史与虚高统计；DEMO_VOCAB/DEMO_STARTER 为内容种子保留 */
    history: [],
    notes: [],
    stats: { clearedToday: 0, clearedIds: [], streak: 0, week: { review: 0, add: 0, trap: 0 }, day: todayKey(), weekKey: isoWeekKey() },
    /* rate 默认 0.85×：原型 createState settings.speed（html:1578）与播放条语速胶囊一致 */
    reader: { mode: "en", mask: false, fs: 20, topic: "paper", chunkMark: false, rate: 0.85, lh: 1.78 },
    sheet: null,
    trash: null,
    /* 剪贴板默认空（§3.1「检测到新文本才显示」）——不再无条件塞演示 CLIP，空态今天页剪贴板块随之隐藏（治 P-06） */
    clip: null,
    readerTarget: null,
    readingArticleId: null,
    lastGrade: null,
    remaskAt: 0,
    shareIn: null,
    diag: [],
    sentenceZh: {},
    readLog: { day: todayKey(), count: 0, seen: {} },
    sentenceParseCache: {},
    customScenes: [],
    curatedFeeds: [],
  };
}

/* ---------- 持久化（版本化 hydrate；旧版本/坏数据 → 演示态） ---------- */
const STORE_KEY = "ita.v3.state";
const STORE_VERSION = 5;

function persistable(s: AppState) {
  return {
    version: STORE_VERSION,
    tasks: s.tasks, reviewEvents: s.reviewEvents, sessions: s.sessions, glossary: s.glossary, speakDifficulty: s.speakDifficulty,
    theme: s.theme,
    onboarded: s.onboarded,
    vocab: s.vocab,
    articles: s.articles,
    progress: s.progress,
    readingCompleted: s.readingCompleted,
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
    /* 句级译文覆盖与今日已读句数：本地 profile 专属（sync.ts 的 COLLECTIONS 投影不含它们，
       不扩云同步协议）；旧快照缺字段 → migrate 兜底空值 */
    sentenceZh: s.sentenceZh,
    readLog: s.readLog,
    sentenceParseCache: s.sentenceParseCache,
    customScenes: s.customScenes,
    curatedFeeds: s.curatedFeeds,
  };
}

function migrate(raw: Record<string, unknown>): AppState | null {
  if (raw.version !== 3 && raw.version !== 4 && raw.version !== STORE_VERSION) return null;
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
      /* 旧版末句断点无法证明用户确认过完成，保留断点，不推测完成。 */
      readingCompleted: raw.readingCompleted && typeof raw.readingCompleted === "object" ? Object.fromEntries(Object.entries(raw.readingCompleted).filter(([, value]) => typeof value === "boolean")) as Record<string, boolean> : {},
      settings: { ...base.settings, ...((raw.settings as Partial<Settings>) || {}), themePref: themePref || "system", apiKey: "", baseUrl: "", model: "", provider: "account", voiceAppId: "", voiceApiKey: "", voiceApiSecret: "", keyStored: false, voiceKeyStored: false, voice: false, edgeVoice: "" },
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
      lastGrade: null,
      remaskAt: 0,
      shareIn: null,
      /* 阅读域本地字段（reading-parity）：旧快照无值 → 空覆盖表 / 归零的今日计数 */
      sentenceZh: (raw.sentenceZh as AppState["sentenceZh"]) || {},
      /* 历史 high 指标不包含真正读过的句子，不能迁成 seen；旧日计数重置。 */
      readLog: migrateReadLog(raw.readLog),
      sentenceParseCache: migrateSentenceParseCache(raw.sentenceParseCache),
      /* 我的场景（speaking-parity）：旧快照无值 → 空列表 */
      customScenes: Array.isArray(raw.customScenes) ? (raw.customScenes as AppState["customScenes"]).filter(s => s && typeof s.id === "string" && typeof s.title === "string" && typeof s.goal === "string") : [],
      /* 精选资讯源订阅（proto-parity）：旧快照无值 → 空列表 */
      curatedFeeds: Array.isArray(raw.curatedFeeds) ? (raw.curatedFeeds as unknown[]).filter((v): v is string => typeof v === "string") : [],
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

/** Save each proven boundary repair and its recovery data in the same transaction. */
function prepareSentenceRepairs(candidate: AppState, previousState?: AppState) {
  const result = repairSentenceBoundaries(candidate);
  if (!result.repairs.length) return { state: candidate, records: [] as NonNullable<CommitInput["records"]> };
  const now = Date.now();
  const patch = { ...result.patch };
  // A legacy article may arrive again without replacing local-only overlays.
  // Those overlays already use the repaired boundaries and must not shift twice.
  for (const repair of result.repairs) {
    const previousArticle = previousState?.articles.find(article => article.id === repair.articleId);
    if (!previousState || !previousArticle || sentenceBoundaryKey(previousArticle) !== repair.toBoundaryKey) continue;
    const id = repair.articleId;
    if (patch.progress && candidate.progress === previousState.progress) patch.progress[id] = previousState.progress[id];
    if (patch.sentenceZh && candidate.sentenceZh[id] === previousState.sentenceZh[id]) {
      if (previousState.sentenceZh[id]) patch.sentenceZh[id] = previousState.sentenceZh[id]; else delete patch.sentenceZh[id];
    }
    if (patch.sentenceParseCache && candidate.sentenceParseCache[id] === previousState.sentenceParseCache[id]) {
      if (previousState.sentenceParseCache[id]) patch.sentenceParseCache[id] = previousState.sentenceParseCache[id]; else delete patch.sentenceParseCache[id];
    }
    if (patch.readLog && candidate.readLog.seen[id] === previousState.readLog.seen[id]) {
      if (previousState.readLog.seen[id]) patch.readLog.seen[id] = previousState.readLog.seen[id]; else delete patch.readLog.seen[id];
    }
  }
  if (patch.readLog) patch.readLog.count = Object.values(patch.readLog.seen).reduce((count, indices) => count + indices.length, 0);
  if (patch.articles) patch.articles = patch.articles.map(article => article === candidate.articles.find(old => old.id === article.id) ? article : { ...article, updatedAt: now });
  if (patch.vocab) patch.vocab = patch.vocab.map(word => word === candidate.vocab.find(old => old.id === word.id) ? word : { ...word, updatedAt: now });
  if (patch.notes) patch.notes = patch.notes.map(note => note === candidate.notes.find(old => old.id === note.id) ? note : { ...note, updatedAt: now });
  if (patch.tasks) patch.tasks = patch.tasks.map(task => {
    const previous = candidate.tasks.find(old => old.id === task.id);
    return task === previous ? task : { ...stampPracticeTask(previous, task, now), attempts: task.attempts };
  });
  return {
    state: { ...candidate, ...patch },
    records: result.repairs.map(repair => ({ collection: "reader.sentence-repairs", id: `${repair.articleId}:${repair.fromBoundaryKey}:${crypto.randomUUID()}`, payload: { ...repair, repairedAt: now } })),
  };
}
export function replaceSyncedState(patch: Partial<AppState> | ((current: AppState) => Partial<AppState>), extra: Omit<CommitInput, "expectedRevision" | "state"> = {}, applyIf?: () => boolean): Promise<void> {
  const target = activeRepository();
  return enqueue(async () => {
    if (applyIf && !applyIf()) return;
    const previous = state;
    const requested = typeof patch === "function" ? patch(previous) : patch;
    const repaired = prepareSentenceRepairs({ ...previous, ...requested }, previous);
    const next = repaired.state;
    const changes = Object.fromEntries(Object.keys(next).filter(key => next[key as keyof AppState] !== previous[key as keyof AppState]).map(key => [key, next[key as keyof AppState]])) as Partial<AppState>;
    state = next;
    try {
      const result = await target.commit({ ...extra, ...(repaired.records.length ? { records: [...(extra.records ?? []), ...repaired.records] } : {}), expectedRevision: revision, state: persistable(next) });
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
    // Loading the target store can take time. Drain writes produced in the old
    // profile during that time before closing it and resetting the queue.
    if (repository) await flushPersist();
    if (options.valid && !options.valid()) throw new DOMException("资料切换已取消", "AbortError");
    const repaired = prepareSentenceRepairs(loaded);
    if (repaired.records.length) {
      const saved = await next.commit({ expectedRevision: nextRevision, state: persistable(repaired.state), records: repaired.records });
      loaded = repaired.state; nextRevision = saved.revision;
    }
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

type GuestClaimState = Pick<AppState, "articles" | "vocab" | "notes" | "tasks" | "reviewEvents" | "sessions" | "history" | "glossary" | "progress"> & Partial<Pick<AppState, "readingCompleted" | "sentenceParseCache" | "readLog">>;
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
      const selectedIds = new Set(articles.map(a => a.id));
      const selected: GuestClaimState = { articles, tasks, vocab: all ? current.vocab : [], notes: all ? current.notes : [], reviewEvents: all ? current.reviewEvents : [], sessions: all ? current.sessions : [], history: all ? current.history : [], glossary: all ? current.glossary : [], progress: all ? current.progress : Object.fromEntries(Object.entries(current.progress).filter(([id]) => id === articleId)), readingCompleted: Object.fromEntries(Object.entries(current.readingCompleted).filter(([id]) => selectedIds.has(id))), sentenceParseCache: Object.fromEntries(Object.entries(current.sentenceParseCache).filter(([id]) => selectedIds.has(id))), readLog: { ...current.readLog, seen: Object.fromEntries(Object.entries(current.readLog.seen).filter(([id]) => selectedIds.has(id))) } };
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
      const remainingSeen = Object.fromEntries(Object.entries(current.readLog.seen).filter(([id]) => !selectedIds.has(id)));
      return { articles: remainingArticles, tasks: current.tasks.filter(row => !tasks.some(item => item.id === row.id)), progress: Object.fromEntries(Object.entries(current.progress).filter(([id]) => !selectedIds.has(id))), readingCompleted: Object.fromEntries(Object.entries(current.readingCompleted).filter(([id]) => !selectedIds.has(id))), sentenceParseCache: Object.fromEntries(Object.entries(current.sentenceParseCache).filter(([id]) => !selectedIds.has(id))), readLog: { ...current.readLog, seen: remainingSeen, count: Object.values(remainingSeen).reduce((sum, indices) => sum + indices.length, 0) }, ...(all ? { vocab: [], notes: [], reviewEvents: [], sessions: [], history: [], glossary: [], stats: samples.stats, clip: null, trash: null, lastGrade: null } : {}) };
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
  const readingCompleted = { ...current.readingCompleted };
  for (const [id, value] of Object.entries(guest.readingCompleted ?? {})) readingCompleted[articleId(id)!] = value;
  const sentenceParseCache = { ...current.sentenceParseCache };
  for (const [id, value] of Object.entries(guest.sentenceParseCache ?? {})) sentenceParseCache[articleId(id)!] = { ...sentenceParseCache[articleId(id)!], ...value };
  const seen = { ...migrateReadLog(current.readLog).seen };
  for (const [id, indices] of Object.entries(migrateReadLog(guest.readLog).seen)) { const target = articleId(id)!; seen[target] = [...new Set([...(seen[target] ?? []), ...indices])]; }
  const readLog = { day: todayKey(), seen, count: Object.values(seen).reduce((sum, indices) => sum + indices.length, 0) };
  return { articles, vocab: merge(current.vocab,vocab), notes: merge(current.notes,notes), tasks: merge(current.tasks,tasks,mergePracticeTask), reviewEvents: [...current.reviewEvents,...reviewEvents.filter(row=>!current.reviewEvents.some(old=>old.id===row.id))], sessions: merge(current.sessions,guest.sessions), history: merge(current.history,guest.history), glossary: [...current.glossary,...guest.glossary.filter(pair=>!current.glossary.some(old=>same(old,pair)))], progress, readingCompleted, sentenceParseCache, readLog, onboarded: true };
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

/* ---------- 阅读今日计数：只计 markRead 明确到达的句子，每个自然日重新去重。 ---------- */
function migrateSentenceParseCache(value: unknown): AppState["sentenceParseCache"] {
  const cache: AppState["sentenceParseCache"] = {};
  if (!value || typeof value !== "object") return cache;
  for (const [articleId, rawEntries] of Object.entries(value)) {
    if (!rawEntries || typeof rawEntries !== "object") continue;
    const entries: AppState["sentenceParseCache"][string] = {};
    for (const [idx, raw] of Object.entries(rawEntries)) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as { en?: unknown; result?: Partial<SentenceParseContent> };
      if (typeof entry.en !== "string" || !entry.result || typeof entry.result.trunk !== "string" || !Array.isArray(entry.result.parts) || !entry.result.parts.length || !entry.result.parts.every(part => part && typeof part.label === "string" && typeof part.text === "string")) continue;
      entries[idx] = { en: entry.en, result: { trunk: entry.result.trunk, parts: entry.result.parts, ...(typeof entry.result.zh === "string" ? { zh: entry.result.zh } : {}) } };
    }
    if (Object.keys(entries).length) cache[articleId] = entries;
  }
  return cache;
}
function migrateReadLog(value: unknown): AppState["readLog"] {
  const empty = { day: todayKey(), count: 0, seen: {} };
  if (!value || typeof value !== "object") return empty;
  const raw = value as Partial<AppState["readLog"]>;
  if (raw.day !== todayKey() || !raw.seen || typeof raw.seen !== "object") return empty;
  const seen = Object.fromEntries(Object.entries(raw.seen).map(([id, indices]) => [id, Array.isArray(indices) ? [...new Set(indices.filter(idx => Number.isInteger(idx) && idx >= 0))] : []]));
  return { day: raw.day, count: Object.values(seen).reduce((sum, indices) => sum + indices.length, 0), seen };
}
function bumpReadLog(log: AppState["readLog"], articleId: string, sent: number): AppState["readLog"] {
  const day = todayKey();
  const base = log.day === day ? log : { day, count: 0, seen: {} };
  const indices = base.seen[articleId] ?? [];
  if (indices.includes(sent)) return base;
  return { day, count: base.count + 1, seen: { ...base.seen, [articleId]: [...indices, sent] } };
}
/** 今日已读句数（跨日自动归零；书架根页「今日已读 N 句」格的数据源）。 */
export function readTodayCount(s: AppState): number {
  return s.readLog.day === todayKey() ? s.readLog.count : 0;
}

/** 句级显示译文：本地覆盖（sentenceZh[articleId]）优先，回退文章句自带译文。 */
export function effectiveSentenceZh(
  articleOverrides: Record<string, string> | undefined,
  sentIdx: number,
  zh: string | null,
): string | null {
  const value = articleOverrides?.[String(sentIdx)];
  return value ? value : zh;
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

/* ---------- 复习到期派生（vault-review-parity）：导航/角标消费的同源选择器 ----------
   只暴露数据源；角标 UI 本身归 visual-theme-cleanup 阶段（不动 GlassNav）。
   与 reviewStats 同款「按引用 + 30s 时效」缓存：useSyncExternalStore 要求快照引用稳定，
   且 forgot 卡 10 分钟回流期间停留页面不至显示过期值。 */
let dueCache: { src: AppState; at: number; out: VocabWord[] } | null = null;
/** 当前到期（未暂停、dueAt≤now），按 dueAt 升序 —— 复习安排抽屉/下一轮构卡的同一数据源。 */
export function dueReviews(s: AppState): VocabWord[] {
  const now = Date.now();
  if (dueCache && dueCache.src === s && now - dueCache.at < 30_000) return dueCache.out;
  const out = [...s.vocab.filter((v) => !v.paused && v.dueAt <= now)].sort((a, b) => a.dueAt - b.dueAt);
  dueCache = { src: s, at: now, out };
  return out;
}
/** 到期计数（数值快照，供角标/入口行消费；与 reviewStats().due 同口径）。 */
export function dueReviewCount(s: AppState): number {
  return dueReviews(s).length;
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

  /* 订阅精选资讯源（proto-parity · 原型 ACT subscribe-feed，html:2205）：源 id 入订阅表 +
     该源全部样例文档按 id 去重加入书架；toast「已订阅，可以开始阅读」。取消订阅只移除
     订阅关系，已入库文档保留（原型 ACT unsubscribe-feed：「已取消订阅，已有短文保留」）。 */
  subscribeCuratedFeed(id: string) {
    if (!state.curatedFeeds.includes(id)) state = { ...state, curatedFeeds: [...state.curatedFeeds, id] };
    const docs = curatedFeedDocs(id);
    const existing = new Set(state.articles.map((a) => a.id));
    const incoming = docs.filter((d) => !existing.has(d.id));
    const ids = new Set(docs.map(d => d.id));
    state = { ...state, articles: [...incoming, ...state.articles.map(a => ids.has(a.id) && a.archived ? { ...a, archived: false, updatedAt: Date.now() } : a)] };
    emit();
    toast("已加入这组短文，可以开始阅读");
  },
  unsubscribeCuratedFeed(id: string) {
    state = { ...state, curatedFeeds: state.curatedFeeds.filter((f) => f !== id) };
    emit();
    toast("已取消订阅，已有短文保留");
  },
  setSettings(patch: Partial<Settings>) {
    const settings = { ...state.settings, ...patch };
    state = { ...state, settings };
    if (patch.fsScale !== undefined) applyFsDom(patch.fsScale);
    emit();
  },

  /* 收词：出处为真实参数（§6.3④，替代 spike 的 sourceArticleId:"trees" 硬编码） */
  saveWord(
    entry: {
      word: string;
      kind: "word" | "chunk";
      chunkType?: string;
      phonetic?: string;
      senses: DictSenses[];
      example?: string;
      contextExplanation?: VocabWord["contextExplanation"];
      pattern?: string;
      trap?: string;
    },
    kind: "word" | "chunk",
    source?: { articleId: string; sentIdx: number },
  ) {
    const existing = state.vocab.find(v => v.word.trim().toLowerCase() === entry.word.trim().toLowerCase());
    if (existing) {
      if (entry.senses.length || entry.contextExplanation) {
        state = { ...state, vocab: state.vocab.map(v => v.id === existing.id ? { ...v, senses: entry.senses.length ? entry.senses : v.senses, phonetic: entry.phonetic || v.phonetic, example: entry.example || v.example, contextExplanation: entry.contextExplanation || v.contextExplanation, updatedAt: Date.now() } : v) };
        emit();
      }
      return;
    }
    const sourceArticleId = source?.articleId || state.readingArticleId || "";
    const sourceArticle = state.articles.find(article => article.id === sourceArticleId);
    const w: VocabWord = {
      id: entry.word.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Math.random().toString(36).slice(2, 6),
      word: entry.word,
      kind,
      chunkType: kind === "chunk" ? entry.chunkType : undefined,
      phonetic: entry.phonetic,
      senses: entry.senses.length ? entry.senses : [{ pos: "", cn: "（暂无释义，待下次查询补上）" }],
      example: entry.example,
      contextExplanation: entry.contextExplanation,
      pattern: entry.pattern,
      trap: entry.trap,
      sourceArticleId,
      sourceSentenceIdx: source?.sentIdx ?? 0,
      ...(sourceArticle ? { sourceBoundaryKey: sentenceBoundaryKey(sourceArticle) } : {}),
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
    /* 收藏 toast 文案与形态对齐原型 read-collect（无跳转链接，底部深色条） */
    toast("已收藏，今天可以复习，也可以马上说一句");
  },

  /* 删除 = 先从 UI 移除 + 快照入 trash，5s 后真正提交；撤销恢复（评审要点 7②）。
     复检 r1（vault-word-undo，原型 v2-word-remove html:3114）：文案「词条已移除，可在生词本撤销」
     只留 toast 的 ✓ 图标（不再在文本里重复 ✓）；opts.inlineUndo=从生词本列表移除，撤销由生词本
     顶部撤销条承担，toast 不内嵌撤销钮；其余入口（词典卡词条页等看不到撤销条）保留 toast 撤销钮。 */
  deleteWord(id: string, opts: { inlineUndo?: boolean } = {}) {
    const idx = state.vocab.findIndex((v) => v.id === id);
    if (idx < 0) return;
    const snap = state.vocab[idx];
    commitTrash();
    state = { ...state, vocab: state.vocab.filter((v) => v.id !== id), trash: { kind: "vocab", index: idx, vocab: snap } };
    emit();
    startTrashTimer();
    if (opts.inlineUndo) toast("词条已移除，可在生词本撤销");
    else toast("词条已移除，可在生词本撤销", { action: "撤销", onAction: () => actions.undoTrash() });
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
    const article = state.articles.find(a => a.id === articleId);
    if (!article || !Number.isInteger(sent) || sent < 0 || sent >= article.sentences.length) return;
    const now = Date.now();
    if ((state.progress[articleId] ?? -1) === sent && article.lastReadAt && now - article.lastReadAt < 1000) return;
    state = { ...state, progress: { ...state.progress, [articleId]: sent }, articles: state.articles.map(a => a.id === articleId ? { ...a, lastReadAt: now, updatedAt: now } : a) };
    emit();
  },
  markRead(articleId: string, sent: number) {
    const article = state.articles.find(a => a.id === articleId);
    if (!article || !Number.isInteger(sent) || sent < 0 || sent >= article.sentences.length) return;
    const readLog = bumpReadLog(state.readLog, articleId, sent);
    if (readLog === state.readLog) return;
    state = { ...state, readLog };
    emit();
  },
  setCompleted(articleId: string, completed = true) {
    if (!state.articles.some(a => a.id === articleId) || state.readingCompleted[articleId] === completed) return;
    state = { ...state, readingCompleted: { ...state.readingCompleted, [articleId]: completed } };
    emit();
  },
  cacheSentenceParse(articleId: string, sentIdx: number, en: string, result: SentenceParseContent) {
    if (state.articles.find(a => a.id === articleId)?.sentences[sentIdx]?.en !== en) return;
    state = { ...state, sentenceParseCache: { ...state.sentenceParseCache, [articleId]: { ...state.sentenceParseCache[articleId], [String(sentIdx)]: { en, result } } } };
    emit();
  },
  /** 句级译文覆盖（reading-parity）：仅写本地 profile 的 sentenceZh 表，不动文章本体/云同步。 */
  setSentenceZh(articleId: string, sentIdx: number, zh: string) {
    const next = { ...(state.sentenceZh[articleId] || {}) };
    next[String(sentIdx)] = zh;
    state = { ...state, sentenceZh: { ...state.sentenceZh, [articleId]: next } };
    emit();
  },
  /** 保存「我的场景」（speaking-parity）：校验由调用方完成后调用；同名场景不重复入列。 */
  saveCustomScene(scene: { title: string; goal: string }) {
    const title = scene.title.trim(), goal = scene.goal.trim();
    if (!title || !goal) throw new Error("给场景起个名字，再写一句想说清楚的内容。");
    if (state.customScenes.some(s => s.title === title)) return;
    state = { ...state, customScenes: [{ id: `scene-${crypto.randomUUID()}`, title, goal, createdAt: Date.now() }, ...state.customScenes] };
    emit();
  },
  /** 整书移出书架（reading-parity）：全部章节 archived=true、进度与收藏保留；
   *  撤销走既有 5s toast 动作（不重建新撤销系统）。 */
  archiveBook(bookId: string) {
    const chapters = state.articles.filter(a => a.bookId === bookId && !a.archived);
    if (!chapters.length) return;
    const ids = new Set(chapters.map(a => a.id));
    state = { ...state, articles: state.articles.map(a => ids.has(a.id) ? { ...a, archived: true, updatedAt: Date.now() } : a) };
    emit();
    toast(`已移出书架 · ${String(chapters[0].bookTitle || chapters[0].title)} · 阅读进度已保留`, {
      action: "撤销",
      onAction: () => {
        state = { ...state, articles: state.articles.map(a => ids.has(a.id) ? { ...a, archived: false, updatedAt: Date.now() } : a) };
        emit();
      },
    });
  },
  archiveArticle(articleId: string) { actions.deleteArticle(articleId); },
  restoreArticle(articleId: string) {
    state = { ...state, articles: state.articles.map(a => a.id === articleId ? { ...a, archived: false, updatedAt: Date.now() } : a) };
    emit();
  },
  restoreBook(bookId: string) {
    state = { ...state, articles: state.articles.map(a => a.bookId === bookId ? { ...a, archived: false, updatedAt: Date.now() } : a) };
    emit();
  },
  renameArticle(articleId: string, title: string) {
    const value = title.trim().slice(0, 160);
    if (!value) throw new Error("请输入内容名称");
    state = { ...state, articles: state.articles.map(a => a.id === articleId ? { ...a, title: value, updatedAt: Date.now() } : a) };
    emit();
  },
  renameBook(bookId: string, title: string) {
    const value = title.trim().slice(0, 160);
    if (!value) throw new Error("请输入书名");
    state = { ...state, articles: state.articles.map(a => a.bookId === bookId ? { ...a, sourceBookTitle: sourceBookTitleOf(a) || undefined, bookTitle: value, updatedAt: Date.now() } : a) };
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
    await replaceSyncedState(current => {
      const previous = current.tasks.find(t => t.id === task.id);
      const article = task.source && current.articles.find(item => item.id === task.source!.articleId);
      const next = !previous && task.source && article && !task.source.boundaryKey
        ? { ...task, source: { ...task.source, boundaryKey: sentenceBoundaryKey(article) } } : task;
      return { tasks: [stampPracticeTask(previous, next, Date.now()), ...current.tasks.filter(t => t.id !== task.id)] };
    });
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
  /** 前缀图标（原型 toast(text, icon)：默认 check ✓；clock 用于「到时间了」类提示，html:1648,1750）。 */
  icon?: "check" | "clock";
}
const TOAST_ICON: Record<NonNullable<ToastOpts["icon"]>, string> = {
  check: '<path d="M5 12.8l4.4 4.4L19 7.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2.2"/>',
};
/* toast 位置固定在底部（proto-parity-2026-11-01，sheet-lookup-collected：原型 toast 叠在
   抽屉底部按钮上方，html:1039 .toast{bottom:90px}——不再随 sheet 上移让位）。 */
function repositionToasts() {
  document.querySelectorAll<HTMLElement>(".toast").forEach((t) => {
    t.style.setProperty("--toast-lift", "0px");
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
  /* ✓ 前缀图标（原型 .toast .ico 口径；reader-finish-only：深色 toast 左侧✓） */
  const ico = document.createElement("span");
  ico.className = "tico";
  ico.setAttribute("aria-hidden", "true");
  ico.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${TOAST_ICON[opts.icon ?? "check"]}</svg>`;
  t.appendChild(ico);
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
  /* 无动作 toast 默认 3.2s 自动消失（对齐原型 setTimeout(...,3200)；带动作仍 5s 撤销窗） */
  const dur = opts.duration ?? (opts.action ? 5000 : 3200);
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

/* ---------- 账号语音：登录后统一经过服务器 ---------- */
export const ttsEvents = { start: 0, end: 0 };
let cloudStopper: (() => void) | null = null;
let speakToken = 0;

export function speak(text: string, rate = 1, onend?: () => void, _lang: "en" | "zh" = "en", onerror?: () => void): void {
  prepareAudioPlayback();
  const token = ++speakToken;
  cloudStopper?.();
  cloudStopper = null;
  const origin = repository, generation = cloudState().generation;
  void (async () => {
    try {
      const ok = await ensureAccount({ articleId: state.readingArticleId || undefined, reason: "登录后使用朗读和示范语音，当前阅读位置会保留。" });
      if (token !== speakToken) return;
      if (!ok) { onerror?.(); return; }
      const cloud = cloudState();
      if (!cloud.account || repository?.identity !== cloud.account.id) { onerror?.(); return; }
      // Only a completed guest login may carry this operation into another profile.
      if (origin?.identity !== "guest" && (origin !== repository || generation !== cloud.generation)) { onerror?.(); return; }
      const h = speakCloud(text, undefined, rate);
      cloudStopper = h.stop;
      ttsEvents.start++;
      await h.done;
      if (token !== speakToken) return;
      cloudStopper = null;
      ttsEvents.end++;
      onend?.();
    } catch (err) {
      if (token !== speakToken) return;
      cloudStopper = null;
      if (err instanceof DOMException && err.name === "AbortError") { onerror?.(); return; }
      const message = voiceErrorText(err);
      reportDiag("tts", `朗读未完成：${message}`);
      toast(message);
      onerror?.();
    }
  })();
}
export function stopSpeak() {
  speakToken++;
  cloudStopper?.();
  cloudStopper = null;
}

/* ---------- 首次主题/字号档落 DOM ---------- */
applyThemeDom(state.theme);
applyFsDom(state.settings.fsScale);

/* 启动标记：随诊断汇落盘（每次启动一条）——拉库时既证明持久化链路工作，
   又能把后续 TTS 事件对上具体哪次会话（真机无声问题的分阶段定位依赖它）。 */
actions.pushDiag({
  time: Date.now(),
  kind: "boot",
  msg: `启动 · ${isTauri() ? "真机" : "浏览器"} · 账号语音`,
});
