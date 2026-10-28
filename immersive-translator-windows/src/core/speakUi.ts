/**
 * 口语陪练页的纯展示逻辑（无 React / 无 IO，可单测）：
 * 目标词进度、「下一个该用的词」、报错文案的可行动分类、句内目标词高亮、5 分制换算。
 */

import {
  textHitsTarget,
  type SpeakScenario,
  type SpeakScenarioCategory,
} from "./speakLogic";

export interface TargetProgress {
  hit: number;
  total: number;
  /** 0–100 整数，进度条宽度。 */
  pct: number;
  label: string;
}

/** 目标词进度；没有目标词（普通场景）返回 null，场景条不画进度。 */
export function targetProgress(hit: number, total: number): TargetProgress | null {
  if (!(total > 0)) return null;
  const h = Math.min(total, Math.max(0, Math.floor(hit)));
  return { hit: h, total, pct: Math.round((h / total) * 100), label: `已用上 ${h} / ${total} 个词` };
}

/** 按传入顺序找第一个还没用上的词，用来高亮「这一题最贴合的词」。 */
export function nextTargetKey(keys: readonly string[], hit: ReadonlySet<string>): string | null {
  for (const k of keys) {
    if (!hit.has(k)) return k;
  }
  return null;
}

export type NoticeKind = "mic" | "credential" | "redeem" | "network" | "other";

export interface FriendlyNotice {
  kind: NoticeKind;
  /** 给用户看的一句话。 */
  message: string;
  /** 原始报错，仅供悬浮提示/排查；与 message 相同时省略。 */
  detail?: string;
}

/**
 * 把本轮失败的原始文案归类为可行动提示。
 * 只做归类与措辞软化，不吞信息：原文放进 detail。
 */
export function friendlyNotice(raw: string): FriendlyNotice {
  const text = raw.trim();
  // 两种原因要分开说：打不开 = 权限/设备问题；没听到 = 声音太小或选错设备。
  if (text.includes("麦克风打不开")) {
    return {
      kind: "mic",
      message: "没能打开麦克风。请确认系统允许本应用使用麦克风，或在设置里换一个麦克风。",
      detail: text,
    };
  }
  if (text.includes("没听到声音")) {
    return {
      kind: "mic",
      message: "没听清这句，可能是声音偏小或麦克风选错了。离麦克风近一点再说一次。",
      detail: text,
    };
  }
  if (text.includes("未配置") && text.includes("凭据")) {
    return { kind: "credential", message: text };
  }
  // 沉浸云额度用尽（§二 quota_exceeded，含路由守卫的额度 hint 与
  // voiceErrorDisplayText 拼好的重置时间）：给「兑换更多额度」动作位。
  if (text.includes("额度已用完")) {
    return { kind: "redeem", message: text };
  }
  if (text.startsWith("语音识别失败") || text.startsWith("回复生成失败")) {
    return { kind: "network", message: "网络好像不太稳，这一句没送出去。再说一次试试。", detail: text };
  }
  return { kind: "other", message: text };
}

export interface Span {
  start: number;
  end: number;
}

/**
 * 目标词/词块在原文里的命中区间（半开 [start, end)，字符下标）。
 * 判定不另写一套：把原文按 textHitsTarget 同款分词切成词，对每个「目标词数」
 * 大小的窗口直接调 textHitsTarget——高亮与芯片打勾口径由构造保证一致。
 */
export function findTargetSpans(text: string, target: string): Span[] {
  const n = target
    .toLowerCase()
    .replace(/[^a-z0-9'\-\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  if (n === 0 || !text) return [];
  const tokens = [...text.matchAll(/[A-Za-z0-9'\-]+/g)].map((m) => ({
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
    word: m[0],
  }));
  const spans: Span[] = [];
  for (let i = 0; i + n <= tokens.length; ) {
    const window = tokens.slice(i, i + n).map((t) => t.word).join(" ");
    if (textHitsTarget(window, target)) {
      spans.push({ start: tokens[i].start, end: tokens[i + n - 1].end });
      i += n; // 区间互不重叠
    } else {
      i += 1;
    }
  }
  return spans;
}

export interface AnnotatedSegment {
  start: number;
  end: number;
  /** 覆盖该段的发音标记在传入数组中的下标；-1 = 无。多个覆盖时取第一个。 */
  markIdx: number;
  /** 该段是否落在目标词命中区间内。 */
  target: boolean;
}

/**
 * 把一句话按「发音标记」与「目标词区间」两层区间的边界切段，相邻且属性相同的段合并。
 * 用来在同一句里同时渲染词着色（发音）和目标词高亮；区间越界时夹到 [0, text.length]。
 */
export function annotateSegments(
  text: string,
  marks: readonly Span[],
  targets: readonly Span[],
): AnnotatedSegment[] {
  const len = text.length;
  if (len === 0) return [];
  const clamp = (v: number) => Math.min(len, Math.max(0, v));
  const bounds = new Set<number>([0, len]);
  for (const s of [...marks, ...targets]) {
    bounds.add(clamp(s.start));
    bounds.add(clamp(s.end));
  }
  const cuts = [...bounds].sort((a, b) => a - b);
  const covers = (s: Span, at: number) => clamp(s.start) <= at && clamp(s.end) > at;
  const out: AnnotatedSegment[] = [];
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    const markIdx = marks.findIndex((m) => covers(m, a));
    const target = targets.some((t) => covers(t, a));
    const last = out[out.length - 1];
    if (last && last.markIdx === markIdx && last.target === target) last.end = b;
    else out.push({ start: a, end: b, markIdx, target });
  }
  return out;
}

/** 讯飞 5 分制 → 0–100 整数（圆环/进度条用），越界夹取，非有限数按 0。 */
export function scorePct(score5: number): number {
  if (!Number.isFinite(score5)) return 0;
  return Math.round(Math.min(5, Math.max(0, score5)) * 20);
}

export type MicPhase = "idle" | "recording" | "asr" | "thinking" | "speaking" | "error";

/** 麦克风按钮下方的一句话提示。跟读占用麦克风时优先说明原因，避免用户点了没反应。 */
export function micTip(phase: MicPhase, opts: { shadowBusy: boolean; hasSpoken: boolean }): string {
  if (opts.shadowBusy) return "正在跟读评分，完成后再回答";
  switch (phase) {
    case "recording":
      return "说完后再点一下发送 · Esc 取消";
    case "asr":
      return "识别中…";
    case "thinking":
      return "对方回复中…";
    case "speaking":
      return "对方说话中 · 点击或按空格可插话";
    case "error":
      return "点击或按空格再说一次";
    default:
      return opts.hasSpoken ? "点击或按空格继续回答" : "点击或按空格用英语回答";
  }
}

/**
 * 一个词展平音素后，gwpp 惩罚最重的那个的下标（右栏默认展开它的建议）。
 * 阈值 -0.4 与 shadowDiagnose.worstPhoneOf 一致；没有明显出错的音素、没有音素、
 * 词缺失时回到第 0 个。并列最差取靠前的。
 */
export function worstPhoneIdx(
  word: { sylls: { phones: { gwpp: number }[] }[] } | undefined,
): number {
  if (!word) return 0;
  let worst = 0;
  let worstGwpp = Infinity;
  let i = 0;
  for (const syl of word.sylls) {
    for (const p of syl.phones) {
      if (p.gwpp < worstGwpp) {
        worstGwpp = p.gwpp;
        worst = i;
      }
      i += 1;
    }
  }
  return worstGwpp <= -0.4 ? worst : 0;
}

export type ScoreTone = "good" | "ok" | "bad";

/** 5 分制 → 着色档。阈值与 pronunciation.mapWordsToText 的词级着色一致（≥4 / ≥3）。 */
export function scoreTone(score5: number): ScoreTone {
  if (!Number.isFinite(score5)) return "bad";
  return score5 >= 4 ? "good" : score5 >= 3 ? "ok" : "bad";
}

// ---- 场景中心目录卡（官方库/我的场景的紧凑卡：摘要取值 + 分类筛选 + 截断） ----

/** 官方库收起态默认渲染的卡片数（「展开全部 N 个」按钮的分界）。 */
export const SCENARIO_PREVIEW_LIMIT = 8;

/** 紧凑卡摘要：优先练习目标 goal（一句话说清这局练什么；官方目录当前 30/30 全量
 *  填充），缺失时回退 aiRole——那是写给 LLM 的角色设定，仅在 goal 缺位时兜底。 */
export function scenarioSummary(sc: Pick<SpeakScenario, "goal" | "aiRole">): string {
  const goal = sc.goal?.trim();
  return goal ? goal : sc.aiRole;
}

/** 分类筛选取值："all" 或某个具体分类。 */
export type ScenarioFilter = "all" | SpeakScenarioCategory;

/** 按固定展示序统计各分类数量，只保留实际有场景的分类（chips 顺序不随数据序漂移）。 */
export function scenarioCategoryCounts(
  list: readonly SpeakScenario[],
): { category: SpeakScenarioCategory; count: number }[] {
  const order: readonly SpeakScenarioCategory[] = ["daily", "travel", "workplace", "academic", "custom"];
  const counts = new Map<SpeakScenarioCategory, number>();
  for (const sc of list) {
    counts.set(sc.category, (counts.get(sc.category) ?? 0) + 1);
  }
  return order
    .filter((category) => (counts.get(category) ?? 0) > 0)
    .map((category) => ({ category, count: counts.get(category) as number }));
}

export interface ScenarioPreview {
  /** 当前应渲染的场景（收起且超限时为注册序前 limit 个）。 */
  visible: SpeakScenario[];
  /** 筛选后的总数（「展开全部 N 个」的 N）。 */
  total: number;
  /** 是否还有没显示的（收起态被截断时为 true，决定展开按钮是否渲染）。 */
  hasMore: boolean;
}

/** 筛选 + 截断：收起且超过 limit 时只渲染前 limit 张（保持注册序 = 服务端目录序）；
 *  展开或数量不多（≤ limit）时全量显示，此时 hasMore=false 不出展开按钮。 */
export function filterScenarioPreview(
  list: readonly SpeakScenario[],
  filter: ScenarioFilter,
  expanded: boolean,
  limit: number = SCENARIO_PREVIEW_LIMIT,
): ScenarioPreview {
  const filtered = filter === "all" ? [...list] : list.filter((sc) => sc.category === filter);
  const visible = expanded || filtered.length <= limit ? filtered : filtered.slice(0, limit);
  return { visible, total: filtered.length, hasMore: visible.length < filtered.length };
}
