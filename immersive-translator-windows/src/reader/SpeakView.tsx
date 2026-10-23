/**
 * 屏 E · 口语陪练（v0.8 场景中心版）：选场景 → 免长按开麦对话 → 表达改进。
 *
 * 入口页 .scenario-hub-scroll：置顶「聊刚读的章节」「今日生词造句闯关」两张
 * 语境卡（真实数据：bookContext / dueVocabWords），下接四个日常场景卡。
 * 对话页 .sonic-studio-grid：#harmonicCanvas 60fps 声波（振幅吃真实麦克风
 * 电平与播报状态）+ 免长按点击开麦（core/vad.ts 静音自动收）→ 讯飞听写
 * → LLM 四行回复（EN/ZH/BETTER/TIP）→ 用户气泡下渲染词级增删对比
 * （.editorial-diff-block）；同一录音异步送 ISE 发音评测写入 user 轮 pron，
 * 右侧「发音详情」透镜卡（词着色 / 音素药丸 / 逐词得分曲线 / 慢速示范）。
 * 命中语境目标词自动按 easy 档完成 SRS（onGradeVocab 记 spokenAt）。
 *
 * 跟读子流程（ShadowReport 卡 + 只练差词抽屉 + 结束复盘弹层）原样共存。
 * 降级原则：断麦/断网/凭据缺失都给中文提示 + 逃生门，ISE 失败只降级不阻塞。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  buildSpeakSystemPrompt,
  buildSpeakUserInput,
  computeCoachDiff,
  difficultyOf,
  lastAssistantText,
  newSpeakSession,
  parseAssistantReply,
  scenarioOf,
  textHitsTarget,
  type CoachSeg,
  type ShadowAttempt,
  type SpeakContextTarget,
  type SpeakDifficulty,
  type SpeakScenarioId,
  type SpeakSession,
  type SpeakSessionContext,
} from "../core/speakLogic";
import { transcribeSpeech } from "../core/xfyunAsr";
import {
  evaluateSentence,
  mapWordsToText,
  type PronunciationResult,
} from "../core/pronunciation";
import { startMicRecorder, type MicRecorderHandle } from "../core/micRecorder";
import { createVadDetector, type VadDetector } from "../core/vad";
import { loadAsrCredentials, loadIseCredentials } from "../lib/iseCredentials";
import { track } from "../lib/analytics";
import { speakListSessions, speakSaveSession } from "../lib/speakStore";
import { cancelTranslation, openSettings } from "../lib/tauriBridge";
import { phoneTip, wordScorePath } from "../core/shadowDiagnose";
import type { VocabWord } from "../core/readerTypes";
import type { NoteTranslateFn } from "./VocabNoteDialog";
import { ShadowReport, MarkedWords, PhonemeRow, type DrillEntry } from "./ShadowReport";
import { ShadowDrill } from "./ShadowDrill";
import { SpeakReviewDialog } from "./SpeakReviewDialog";
import { IconBookOpen, IconList, IconLocate, IconMic, IconSparkles, IconStar, IconClock, IconVolume } from "../ui/icons";

/** 一轮里的阶段（主对话环）。 */
type RoundPhase =
  | "idle" // 等用户开麦
  | "recording" // 点击开麦后说话中（VAD 静音自动收）
  | "asr" // 识别转写中
  | "thinking" // LLM 回复生成中（流式）
  | "speaking" // TTS 播报中
  | "error"; // 本轮失败（显示重试）

/** 跟读子状态（独立于主环，只对最新 assistant 轮开放）。 */
type ShadowPhase = "idle" | "recording" | "evaluating" | "done" | "error";

/** 需要专门卡片化（可行动文案）的评测异常；空串 = 普通错误文本。 */
type ShadowErrorKind = "rejected" | "novoice" | "noisy" | "except" | "";

interface ShadowState {
  phase: ShadowPhase;
  /** 需要卡片化文案的评测异常种类；空串 = 无。 */
  errorKind: ShadowErrorKind;
  /** 普通错误文本（麦克风/网络/凭据）。 */
  error: string;
}

const SHADOW_IDLE: ShadowState = { phase: "idle", errorKind: "", error: "" };

const MAX_UTTERANCE_MS = 15000;
const MIN_UTTERANCE_SAMPLES = 16000 * 0.5;
/** 免长按开麦的静音断句时长（说完停顿即自动发送）。 */
const TALK_SILENCE_MS = 1500;

/** 「带入口语的语境」（ReaderApp.pendingSpeak 的联合形态，形状 Phase 2 定死）。 */
export type PendingSpeakContext =
  | { kind: "book"; articleId: string; sentenceIdx: number }
  | { kind: "vocab" }
  | null;

/** 日常场景卡的展示文案（原型定稿直白中文；标签/标题/描述，非演示数据）。 */
const SCENARIO_CARDS: Record<SpeakScenarioId, { tag: string; title: string; desc: string }> = {
  interview: {
    tag: "职场高频",
    title: "英文面试",
    desc: "扮演温和的面试官，围绕自我介绍、项目经历、优缺点逐轮提问并帮你润色回答。",
  },
  ordering: {
    tag: "生活实用",
    title: "餐厅点餐",
    desc: "在英文餐厅点单、询问今日特色菜、表达忌口偏好与结账沟通。",
  },
  travel: {
    tag: "出行必备",
    title: "旅行问路与入住",
    desc: "涵盖机场值机、酒店前台办理入住、在陌生城市向当地人问路。",
  },
  smalltalk: {
    tag: "轻松开口",
    title: "日常闲聊寒暄",
    desc: "像老朋友一样聊聊这周过得怎么样、周末计划、天气或最近看的一本书。",
  },
};

/** 日常场景卡的展示顺序（原型：面试 → 点餐 → 旅行 → 寒暄）。 */
const SPEAK_SCENARIO_ORDER: SpeakScenarioId[] = ["interview", "ordering", "travel", "smalltalk"];

const SCENARIO_CARD_ICONS: Record<SpeakScenarioId, ComponentType<{ size?: number }>> = {
  interview: IconStar,
  ordering: IconList,
  travel: IconLocate,
  smalltalk: IconClock,
};

/** 语境会话（book/vocab）的开场白：模板 + 真实数据插值（与 SPEAK_SCENARIOS
 * 的静态开场白同一性质，不引入演示内容）。 */
function contextOpener(context: SpeakSessionContext): { text: string; hintZh: string } {
  if (context.kind === "book") {
    const lead = context.excerpt[0] ? ` Starting from: “${context.excerpt[0]}”` : "";
    return {
      text: `Let's talk about Chapter ${context.chapterIdx + 1} of “${context.bookTitle}”.${lead} What struck you most so far?`,
      hintZh: `来聊聊《${context.bookTitle}》第 ${context.chapterIdx + 1} 章——试着在回答里用上你刚收集的词块。`,
    };
  }
  return {
    text: "Let's put your target words to work today. I'll ask about real-life situations — just answer naturally and try to use them.",
    hintZh: "生词造句闯关开始：回答 AI 的生活化提问时，用上待复习的词就算过关。",
  };
}

interface Props {
  requestTranslate: NoteTranslateFn;
  /** TTS 播英文（speechEngine dispatcher 的 speak），resolve 本次朗读代数（配对 tts:ended）。 */
  speakEn: (text: string) => Promise<number>;
  /** 发音详情「慢速示范 0.75×」：word 轨 + 云引擎原生 -25% 合成（缺省回落 speakEn）。 */
  speakWordSlow?: (text: string) => Promise<number>;
  /** 订阅朗读结束事件（返回取消订阅函数；sentence/word 轨都会到达，自行按 track 过滤）。 */
  subscribeSpeakEnded: (handler: (e: { gen: number; track: string }) => void) => () => void;
  /** 停 TTS。 */
  stopSpeak: () => void;
  micDeviceId: string;
  onToast: (msg: string) => void;
  /** 回阅读（口语页没有左栏，给一个明确的返回位）。 */
  onBack?: () => void;
  /** 当前生词本（语境目标词、复盘弹层判重/唤醒标注用）。 */
  vocabWords: VocabWord[];
  /** 复盘合并成功后刷新生词本。 */
  onVocabSaved: (addedIds: string[]) => void | Promise<void>;
  /** 复盘成功视图「生成复习笔记」（带新词 ids 打开笔记生成）。 */
  onGenerateNote: (ids: string[]) => void;
  /** 复盘成功视图「去复习」。 */
  onGoReview: () => void;
  /** ---- v0.8 场景中心 ---- */
  /** 聊刚读的章节卡的数据（article+currentBook 派生）；null = 没有在读文章，卡不渲染。 */
  bookContext?: { articleId: string; title: string; chapterIdx: number; excerpt: string[] } | null;
  /** 今日待复习生词（造句闯关卡 + 目标词块 chips）。 */
  dueVocabWords: VocabWord[];
  /** 带入口语的语境（阅读室「用这句练口语」/手账「去口语里用一次」通道）。 */
  pendingSpeak: PendingSpeakContext;
  /** 用户发言命中目标词：按 easy 档记 SRS（ReaderApp 侧附带 spokenAt）。 */
  onGradeVocab: (word: VocabWord, grade: "easy") => void;
}

export function SpeakView({
  requestTranslate,
  speakEn,
  speakWordSlow,
  subscribeSpeakEnded,
  stopSpeak,
  micDeviceId,
  onToast,
  onBack,
  vocabWords,
  onVocabSaved,
  onGenerateNote,
  onGoReview,
  bookContext,
  dueVocabWords,
  pendingSpeak,
  onGradeVocab,
}: Props) {
  const [session, setSession] = useState<SpeakSession | null>(null);
  const [difficulty, setDifficulty] = useState<SpeakDifficulty>("medium");
  const [recent, setRecent] = useState<SpeakSession[]>([]);
  const [phase, setPhase] = useState<RoundPhase>("idle");
  const [roundError, setRoundError] = useState("");
  const [liveReply, setLiveReply] = useState("");
  const [shadow, setShadow] = useState<ShadowState>(SHADOW_IDLE);
  /** 只练差词抽屉（打开时遮罩挡住主控制条，与主跟读互斥）。 */
  const [drill, setDrill] = useState<{ entries: DrillEntry[] } | null>(null);
  /** 结束复盘弹层（跟读弱词 → 生词本）。 */
  const [reviewOpen, setReviewOpen] = useState(false);
  /** 有没有可回放的「我的录音」。 */
  const [mineReady, setMineReady] = useState(false);
  const [level, setLevel] = useState(0);
  /** 发音详情：选中的词/音素下标（换 pron 时自动跳到最差词）。 */
  const [pronSel, setPronSel] = useState<{ wordIdx: number; phoneIdx: number } | null>(null);

  const recorderRef = useRef<MicRecorderHandle | null>(null);
  const shadowRecorderRef = useRef<MicRecorderHandle | null>(null);
  /** 最近一次跟读的录音（内存里留到下一次跟读/新回复，供「听我的录音」对照）。 */
  const shadowPcmRef = useRef<Float32Array | null>(null);
  /** 轮次纪元：换场景/跳过/卸载时自增，旧轮的异步结果一律丢弃。 */
  const epochRef = useRef(0);
  /** LLM 请求 tag 序号（只保证唯一，不作失效判定）。 */
  const tagRef = useRef(0);
  /** 在途 LLM 请求的 tag：「跳过回复」只掐掉自己的流，不误伤并发的其他翻译。 */
  const activeTagRef = useRef("");
  /** getUserMedia 授权等待期又点了按钮：录音器就绪后直接丢弃。 */
  const releasePendingRef = useRef(false);
  const shadowReleasePendingRef = useRef(false);
  /** 本轮主对话已收尾（finishUtterance 已取走录音器）：迟到的点击忽略。 */
  const finishingRef = useRef(false);
  /** 免长按开麦的 VAD（静音断句/无话提前收；语义同跟读评测）。 */
  const vadRef = useRef<VadDetector | null>(null);
  const sessionRef = useRef<SpeakSession | null>(null);
  sessionRef.current = session;
  /** 已上报 speak_session_start 的会话 id（云端埋点，Phase 0 §8）：end 事件只对
   *  本次组件生命周期内 start() 过的会话发；resume 的旧会话不算（没发过 start）。 */
  const trackedStartIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 本组件最近一次朗读的代数；null = 当前没有由本组件发起、尚未终结的朗读。 */
  const speakGenRef = useRef<number | null>(null);
  /** speak 已发出但代数还没拿回（云引擎要等合成完才 resolve）。 */
  const speakPendingRef = useRef(false);
  /** 声波舞台：requestAnimationFrame 句柄 / 振幅 / 相位 / 最新真实麦克风电平。 */
  const rafRef = useRef(0);
  const waveAmpRef = useRef(0.16);
  const wavePhaseRef = useRef(0);
  const levelRef = useRef(0);
  /** pendingSpeak 已消费的引用（同一 intent 不重复开会）。 */
  const pendingConsumedRef = useRef<PendingSpeakContext>(null);

  // 挂载时拉历史会话（入口页「继续上次的对话」）
  useEffect(() => {
    void speakListSessions()
      .then((list) => setRecent(list.slice(0, 5)))
      .catch(() => undefined);
  }, []);

  // 新消息后贴底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session?.turns.length, liveReply, phase]);

  // TTS 播完（或被打断/失败）→ speaking 回 idle。按 gen 配对丢弃过期事件；
  // 等代数期间到达的 ended 若匹配旧代数，是新朗读打断旧朗读的收尾，忽略；
  // 其余（合成失败等）视为本次朗读已终结，同样回收状态。
  useEffect(
    () =>
      subscribeSpeakEnded(({ gen, track }) => {
        if (track !== "sentence") return;
        const cur = speakGenRef.current;
        if (speakPendingRef.current) {
          if (cur !== null && gen === cur) return;
        } else if (cur === null || cur !== gen) {
          return; // 过期事件，或别人（如阅读室播放）的事件
        }
        speakPendingRef.current = false;
        speakGenRef.current = null;
        setPhase((p) => (p === "speaking" ? "idle" : p));
      }),
    [subscribeSpeakEnded],
  );

  /** 播一句 AI 英语并推进状态机：speaking →（tts:ended）→ idle。开场白/回复/重听共用。 */
  const speakRound = useCallback(
    (text: string) => {
      setPhase("speaking");
      speakPendingRef.current = true;
      void speakEn(text)
        .then((gen) => {
          if (!speakPendingRef.current) return; // 期间已经 ended（快速失败等），不再记录
          speakPendingRef.current = false;
          speakGenRef.current = gen;
        })
        .catch((e) => {
          speakPendingRef.current = false;
          speakGenRef.current = null;
          setPhase((p) => (p === "speaking" ? "idle" : p));
          onToast(`朗读失败：${e instanceof Error ? e.message : String(e)}`);
        });
    },
    [speakEn, onToast],
  );

  const persist = useCallback((next: SpeakSession) => {
    void speakSaveSession(next)
      .then(() => speakListSessions().then((l) => setRecent(l.slice(0, 5))).catch(() => undefined))
      .catch(() => undefined);
  }, []);

  /** 给最后一个 user 轮补字段（pron / coachDiff 异步落盘共用；读最新会话态再写）。 */
  const patchLastUserTurn = useCallback(
    (patch: { pron?: ShadowAttempt; coachDiff?: SpeakSession["turns"][number]["coachDiff"] }) => {
      const cur = sessionRef.current;
      if (!cur) return;
      const turns = [...cur.turns];
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (turns[i].role === "user") {
          turns[i] = { ...turns[i], ...patch };
          break;
        }
      }
      const next = { ...cur, turns, updatedAt: Date.now() };
      setSession(next);
      sessionRef.current = next;
      persist(next);
    },
    [persist],
  );

  const start = useCallback(
    (scenario: SpeakScenarioId, diff: SpeakDifficulty, context?: SpeakSessionContext) => {
      stopSpeak();
      epochRef.current += 1;
      const s = newSpeakSession(scenario, diff, Date.now(), context);
      const opener = context ? contextOpener(context) : null;
      if (opener) s.turns[0] = { ...s.turns[0], text: opener.text, hintZh: opener.hintZh };
      setSession(s);
      setPhase("idle");
      setRoundError("");
      setShadow(SHADOW_IDLE);
      setDrill(null);
      setMineReady(false);
      setPronSel(null);
      // 开场白直接播报
      speakRound(s.turns[0].text);
      persist(s);
      // 云端埋点（Phase 0 §8）：新会话开始。当前场景均为内置场景；
      // official/user 来源随 A 阶段场景中心引入。
      trackedStartIdRef.current = s.id;
      track("speak_session_start", { scenarioId: scenario, scenarioSource: "builtin" });
    },
    [persist, speakRound, stopSpeak],
  );

  const resume = useCallback(
    (s: SpeakSession) => {
      stopSpeak();
      epochRef.current += 1;
      setSession(s);
      setPhase("idle");
      setRoundError("");
      setShadow(SHADOW_IDLE);
      setDrill(null);
      setMineReady(false);
      setPronSel(null);
      // 重开的旧会话没有配对的 start 事件，不发 end（Phase 0 口径）
      trackedStartIdRef.current = null;
    },
    [stopSpeak],
  );

  /** 云端埋点（Phase 0 §8）：会话结束（回场景中心/卸载共用）。只对已上报
   *  start 的会话发一次 end；turns 取会话 turns 数组长度，时长自 createdAt 起算。 */
  const trackSessionEnd = useCallback(() => {
    const s = sessionRef.current;
    if (!s || trackedStartIdRef.current !== s.id) return;
    trackedStartIdRef.current = null;
    track("speak_session_end", {
      scenarioId: s.scenario,
      turns: s.turns.length,
      durationSeconds: Math.max(0, Math.round((Date.now() - s.createdAt) / 1000)),
    });
  }, []);

  /** 回场景中心（「← 切换场景」）：旧轮丢弃。 */
  const backToHub = useCallback(() => {
    epochRef.current += 1;
    stopSpeak();
    trackSessionEnd();
    setSession(null);
    setPhase("idle");
    setRoundError("");
  }, [stopSpeak, trackSessionEnd]);

  // ---- 语境目标词（chips / 系统提示 / 自动过关共用） ----
  const contextTargets = useMemo<(VocabWord & { zh: string })[]>(() => {
    const ctx = session?.context;
    if (!ctx) return [];
    const zhOf = (w: VocabWord) => w.senses[0]?.cn ?? w.phonetic ?? "";
    if (ctx.kind === "book") {
      return vocabWords.filter((w) => w.source.articleId === ctx.chapterArticleId).map((w) => ({ ...w, zh: zhOf(w) }));
    }
    return ctx.wordIds
      .map((id) => vocabWords.find((w) => w.id === id))
      .filter((w): w is VocabWord => Boolean(w))
      .map((w) => ({ ...w, zh: zhOf(w) }));
  }, [session, vocabWords]);

  const contextTargetsRef = useRef(contextTargets);
  contextTargetsRef.current = contextTargets;

  /** 目标词在本会话里是否已被用出（扫历史 user 轮，重开会话也保真）。 */
  const hitTargetIds = useMemo(() => {
    const ctx = session?.context;
    if (!ctx) return new Set<string>();
    const targets = contextTargets;
    const hits = new Set<string>();
    for (const t of session.turns) {
      if (t.role !== "user" || !t.text) continue;
      for (const w of targets) {
        if (textHitsTarget(t.text, w.word)) hits.add(w.id);
      }
    }
    return hits;
  }, [session, contextTargets]);

  /** 结束录音并推进一轮：ASR →（并行）LLM 四行回复 + ISE 发音评测。 */
  const finishUtterance = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec || finishingRef.current) return;
    finishingRef.current = true;
    recorderRef.current = null;
    vadRef.current = null;
    const epoch = ++epochRef.current;
    setPhase("asr");
    setRoundError("");
    let pcm: Float32Array;
    try {
      pcm = await rec.stop();
    } catch (e) {
      setPhase("error");
      setRoundError(e instanceof Error ? e.message : String(e));
      return;
    }
    // 静音兜底：没说到话不算一轮
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 16) peak = Math.max(peak, Math.abs(pcm[i]));
    if (peak < 0.01 || pcm.length < MIN_UTTERANCE_SAMPLES) {
      setPhase("idle");
      onToast("没听到声音——离麦克风近一点再说一次");
      return;
    }
    const creds = await loadAsrCredentials().catch(() => null);
    if (!creds) {
      setPhase("error");
      setRoundError("未配置讯飞听写凭据：到 设置 → 语音 里填一次（或复用跟读评测那组）");
      return;
    }
    let userText: string;
    try {
      userText = await transcribeSpeech(pcm, "en_us", creds);
    } catch (e) {
      if (epochRef.current !== epoch) return;
      setPhase("error");
      setRoundError(`语音识别失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (epochRef.current !== epoch) return;
    if (!userText) {
      setPhase("idle");
      onToast("没识别出内容，再试一次（尽量用完整的英语句子）");
      return;
    }

    // 记用户轮（会话先落盘，LLM 失败也不丢用户发言）
    const cur0 = sessionRef.current;
    if (!cur0) return;
    const withUser: SpeakSession = {
      ...cur0,
      turns: [...cur0.turns, { role: "user", text: userText, at: Date.now() }],
      updatedAt: Date.now(),
    };
    setSession(withUser);
    sessionRef.current = withUser;
    persist(withUser);

    // 命中语境目标词 → 自动按 easy 档完成 SRS（spokenAt 在 ReaderApp 侧记录）
    const targets = contextTargetsRef.current;
    if (targets.length > 0) {
      const prevTurns = withUser.turns.slice(0, -1);
      const prevHit = new Set<string>();
      for (const t of prevTurns) {
        if (t.role !== "user" || !t.text) continue;
        for (const w of targets) {
          if (!prevHit.has(w.id) && textHitsTarget(t.text, w.word)) prevHit.add(w.id);
        }
      }
      for (const w of targets) {
        if (!prevHit.has(w.id) && textHitsTarget(userText, w.word)) {
          onGradeVocab(w, "easy");
          onToast(`用上了「${w.word}」——已记一次口语表达`);
        }
      }
    }

    // 发音评测：同一录音送 ISE（凭据缺失/失败仅降级：user 轮没有 pron，不阻塞对话）
    void (async () => {
      const iseCreds = await loadIseCredentials().catch(() => null);
      if (!iseCreds) return;
      try {
        const result = await evaluateSentence(pcm, userText, iseCreds);
        if (epochRef.current !== epoch) return;
        if (result.isRejected || result.exceptInfo !== null) return; // 异常不计入（同跟读语义）
        patchLastUserTurn({
          pron: {
            at: Date.now(),
            total: result.total,
            accuracy: result.accuracy,
            fluency: result.fluency,
            integrity: result.integrity,
            words: result.words,
          },
        });
      } catch {
        /* 降级：不写 pron */
      }
    })();

    // LLM 回复（流式上屏）
    setPhase("thinking");
    setLiveReply("");
    const tag = `spk${++tagRef.current}`;
    activeTagRef.current = tag;
    const sysTargets: SpeakContextTarget[] = contextTargetsRef.current.map((w) => ({ word: w.word, zh: w.zh }));
    const res = await requestTranslate(
      buildSpeakUserInput(withUser.turns.slice(0, -1), userText),
      buildSpeakSystemPrompt(withUser.scenario, withUser.difficulty, withUser.context, sysTargets),
      tag,
      (t) => setLiveReply(t),
    );
    if (epochRef.current !== epoch) return; // 已换场景/跳过：丢弃旧轮结果
    if (res.status === "error") {
      setPhase("error");
      setRoundError(`回复生成失败：${res.text}`);
      return;
    }
    const reply = parseAssistantReply(res.text);
    if (!reply.en) {
      setPhase("error");
      setRoundError("回复格式异常，重试一次");
      return;
    }
    // 表达改进建议（BETTER/TIP）回写 user 轮（pron 可能已先落盘，从最新会话态续写）
    if (reply.better) {
      patchLastUserTurn({
        coachDiff: {
          segs: computeCoachDiff(userText, reply.better),
          ...(reply.tip ? { note: reply.tip } : {}),
        },
      });
    }
    const cur = sessionRef.current;
    if (!cur || cur.turns[cur.turns.length - 1]?.role !== "user") return;
    const withAssistant: SpeakSession = {
      ...cur,
      turns: [
        ...cur.turns,
        { role: "assistant", text: reply.en, hintZh: reply.zh, at: Date.now() },
      ],
      updatedAt: Date.now(),
    };
    setSession(withAssistant);
    sessionRef.current = withAssistant;
    persist(withAssistant);
    setLiveReply("");
    setShadow(SHADOW_IDLE);
    setDrill(null);
    setMineReady(false);
    shadowPcmRef.current = null;
    speakRound(reply.en);
  }, [onToast, onGradeVocab, patchLastUserTurn, persist, requestTranslate, speakRound]);

  /** 免长按开麦：点击开始（播报中点击 = 打断插话），VAD 静音自动结束；录音中再点 = 说完。 */
  const toggleMic = useCallback(() => {
    if (drill) return; // 词练抽屉占用麦克风
    if (phase === "recording") {
      if (finishingRef.current) return;
      if (!recorderRef.current) {
        // 录音器还在等授权：标记后由开麦续体丢弃
        releasePendingRef.current = true;
        setPhase("idle");
        return;
      }
      void finishUtterance();
      return;
    }
    if (phase !== "idle" && phase !== "error" && phase !== "speaking") return;
    if (shadow.phase === "recording" || shadow.phase === "evaluating") return; // 跟读占用麦克风
    if (phase === "error") setRoundError("");
    stopSpeak();
    setPhase("recording");
    setLevel(0);
    levelRef.current = 0;
    releasePendingRef.current = false;
    finishingRef.current = false;
    const epoch = epochRef.current;
    void (async () => {
      try {
        const vad = createVadDetector({
          silenceMs: TALK_SILENCE_MS,
          onAutoStop: () => void finishUtterance(),
        });
        vadRef.current = vad;
        const recorder = await startMicRecorder({
          deviceId: micDeviceId || undefined,
          onLevel: ({ level: lv, elapsedMs }) => {
            setLevel(lv);
            levelRef.current = lv;
            vad.feed(lv, elapsedMs);
          },
        });
        if (releasePendingRef.current || epoch !== epochRef.current) {
          // 授权等待期用户已再点了一次（作废）/ 场景已切走：不留悬空录音
          releasePendingRef.current = false;
          recorder.cancel();
          return;
        }
        recorderRef.current = recorder;
      } catch (e) {
        const dom = e as DOMException;
        setPhase("error");
        setRoundError(`麦克风打不开（${dom?.name ?? "错误"}）：${dom?.message ?? e}`);
      }
    })();
  }, [phase, shadow.phase, drill, micDeviceId, finishUtterance, stopSpeak]);

  /** 跳过等待中的 LLM 回复（长等待逃生门）。 */
  const skipReply = useCallback(() => {
    epochRef.current += 1;
    if (activeTagRef.current) void cancelTranslation(activeTagRef.current);
    setLiveReply("");
    setPhase("idle");
    setRoundError("已跳过这次回复，接着说下一句");
  }, []);

  // pendingSpeak：带语境自动开会（阅读室「用这句练口语」/ 手账「去口语里用一次」）
  useEffect(() => {
    if (!pendingSpeak || session || pendingConsumedRef.current === pendingSpeak) return;
    if (pendingSpeak.kind === "book") {
      if (!bookContext || bookContext.articleId !== pendingSpeak.articleId) return; // 过期（切文章由 ReaderApp 清）
      pendingConsumedRef.current = pendingSpeak;
      start("smalltalk", difficulty, {
        kind: "book",
        bookTitle: bookContext.title,
        chapterArticleId: bookContext.articleId,
        chapterIdx: bookContext.chapterIdx,
        excerpt: bookContext.excerpt,
      });
    } else {
      if (dueVocabWords.length === 0) return;
      pendingConsumedRef.current = pendingSpeak;
      start("smalltalk", difficulty, {
        kind: "vocab",
        wordIds: dueVocabWords.slice(0, 8).map((w) => w.id),
      });
    }
  }, [pendingSpeak, session, bookContext, dueVocabWords, difficulty, start]);

  // ---- 跟读（最新 assistant 轮，ISE 打分） ----
  const shadowTarget = useMemo(
    () => (session ? lastAssistantText(session.turns) : null),
    [session],
  );

  /**
   * 最新 assistant 轮的跟读报告（渲染统一从落盘 attempts 派生：
   * 刚评完与重开旧会话走同一条路）。录音/评测中不显示（正被新一轮覆盖）。
   */
  const lastReport = useMemo(() => {
    if (!session || !shadowTarget) return null;
    if (shadow.phase === "recording" || shadow.phase === "evaluating") return null;
    for (let i = session.turns.length - 1; i >= 0; i -= 1) {
      const t = session.turns[i];
      if (t.role !== "assistant") continue;
      const attempts = t.shadowAttempts;
      if (!attempts || attempts.length === 0) return null;
      const last = attempts[attempts.length - 1];
      return {
        attemptAt: last.at,
        totals: attempts.map((a) => a.total),
        view: {
          result: {
            total: last.total,
            accuracy: last.accuracy,
            fluency: last.fluency,
            standard: last.total,
            integrity: last.integrity,
            isRejected: false,
            exceptInfo: null,
            words: last.words,
          } satisfies PronunciationResult,
          marks: mapWordsToText(shadowTarget, last.words),
        },
      };
    }
    return null;
  }, [session, shadow.phase, shadowTarget]);

  const startShadow = useCallback(() => {
    if (!shadowTarget || shadow.phase === "recording" || shadow.phase === "evaluating") return;
    if (drill) return; // 词练抽屉占用麦克风
    if (phase !== "idle" && phase !== "speaking" && phase !== "error") return;
    stopSpeak();
    setShadow({ ...SHADOW_IDLE, phase: "recording" });
    setLevel(0);
    levelRef.current = 0;
    shadowReleasePendingRef.current = false;
    void (async () => {
      try {
        const recorder = await startMicRecorder({
          deviceId: micDeviceId || undefined,
          onLevel: ({ level: lv, elapsedMs }) => {
            setLevel(lv);
            levelRef.current = lv;
            if (elapsedMs >= MAX_UTTERANCE_MS) void finishShadow();
          },
        });
        if (shadowReleasePendingRef.current) {
          // 授权等待期用户已点了结束：这次跟读作废
          shadowReleasePendingRef.current = false;
          recorder.cancel();
          return;
        }
        shadowRecorderRef.current = recorder;
      } catch (e) {
        const dom = e as DOMException;
        setShadow({ ...SHADOW_IDLE, phase: "error", error: `麦克风打不开：${dom?.message ?? e}` });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shadowTarget, shadow.phase, phase, micDeviceId, drill, stopSpeak]);

  const finishShadow = useCallback(async () => {
    const rec = shadowRecorderRef.current;
    if (!rec) {
      // 授权等待期就点了结束；第二次调用直接忽略
      setShadow((s) => {
        if (s.phase !== "recording") return s;
        shadowReleasePendingRef.current = true;
        return SHADOW_IDLE;
      });
      return;
    }
    shadowRecorderRef.current = null;
    const target = shadowTarget;
    if (!target) return;
    setShadow({ ...SHADOW_IDLE, phase: "evaluating" });
    let pcm: Float32Array;
    try {
      pcm = await rec.stop();
    } catch (e) {
      setShadow({ ...SHADOW_IDLE, phase: "error", error: e instanceof Error ? e.message : String(e) });
      return;
    }
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 16) peak = Math.max(peak, Math.abs(pcm[i]));
    if (peak < 0.01 || pcm.length < MIN_UTTERANCE_SAMPLES) {
      setShadow({ ...SHADOW_IDLE, phase: "error", error: "没听到声音，离麦克风近一点" });
      return;
    }
    const creds = await loadIseCredentials().catch(() => null);
    if (!creds) {
      setShadow({ ...SHADOW_IDLE, phase: "error", error: "未配置讯飞评测凭据：设置 → 语音" });
      return;
    }
    let result: PronunciationResult;
    try {
      result = await evaluateSentence(pcm, target, creds);
    } catch (e) {
      setShadow({ ...SHADOW_IDLE, phase: "error", error: e instanceof Error ? e.message : String(e) });
      return;
    }
    // 录音留在内存，报告卡「听我的录音」可回放对照
    shadowPcmRef.current = pcm;
    setMineReady(true);

    // 乱读/无语音/环境差：给可行动的卡片，不计入 attempts（不污染趋势）
    if (result.isRejected) {
      setShadow({ ...SHADOW_IDLE, phase: "error", errorKind: "rejected", error: "" });
      return;
    }
    if (result.exceptInfo === "28673") {
      setShadow({ ...SHADOW_IDLE, phase: "error", errorKind: "novoice", error: "" });
      return;
    }
    if (result.exceptInfo === "28680") {
      setShadow({ ...SHADOW_IDLE, phase: "error", errorKind: "noisy", error: "" });
      return;
    }
    if (result.exceptInfo !== null) {
      setShadow({
        ...SHADOW_IDLE,
        phase: "error",
        errorKind: "except",
        error: `评测异常（${result.exceptInfo}），再试一次`,
      });
      return;
    }

    setShadow({ ...SHADOW_IDLE, phase: "done" });

    // 报告回写会话（找到最后一个 assistant 轮；每轮最多留 10 次）
    const attempt: ShadowAttempt = {
      at: Date.now(),
      total: result.total,
      accuracy: result.accuracy,
      fluency: result.fluency,
      integrity: result.integrity,
      words: result.words,
    };
    const cur = sessionRef.current;
    if (cur && cur.turns.length > 0) {
      const turns = [...cur.turns];
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (turns[i].role === "assistant") {
          turns[i] = {
            ...turns[i],
            shadowAttempts: [...(turns[i].shadowAttempts ?? []), attempt].slice(-10),
            shadowScore: result.total,
          };
          break;
        }
      }
      const next = { ...cur, turns, updatedAt: Date.now() };
      setSession(next);
      sessionRef.current = next;
      persist(next);
    }
  }, [shadowTarget, persist]);

  // ---- 报告卡动作（听/练/回整句） ----

  /** 回放「我的录音」：16k 单声道 PCM 直接进 Web Audio。 */
  const hearMine = useCallback(() => {
    const pcm = shadowPcmRef.current;
    if (!pcm) return;
    try {
      const ctx = new AudioContext();
      const buf = ctx.createBuffer(1, pcm.length, 16000);
      buf.copyToChannel(new Float32Array(pcm), 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => void ctx.close().catch(() => undefined);
      src.start();
    } catch {
      onToast("录音回放失败");
    }
  }, [onToast]);

  /** TTS 读一个词（不进主环状态机；抽屉里用）。 */
  const speakWord = useCallback(
    (w: string) => {
      void speakEn(w).catch((e) => onToast(`朗读失败：${e instanceof Error ? e.message : String(e)}`));
    },
    [speakEn, onToast],
  );

  /** 发音详情「慢速示范 0.75×」：云引擎原生 -25% 合成（缺省回落普通朗读）。 */
  const speakWordSlowly = useCallback(
    (w: string) => {
      const say = speakWordSlow ?? speakEn;
      void say(w).catch((e) => onToast(`朗读失败：${e instanceof Error ? e.message : String(e)}`));
    },
    [speakWordSlow, speakEn, onToast],
  );

  const openDrill = useCallback(
    (entries: DrillEntry[]) => {
      if (entries.length === 0) return;
      stopSpeak();
      setDrill({ entries });
    },
    [stopSpeak],
  );

  const closeDrill = useCallback(() => {
    stopSpeak();
    setDrill(null);
  }, [stopSpeak]);

  /** 词练收尾：回整句跟读。 */
  const drillDone = useCallback(() => {
    stopSpeak();
    setDrill(null);
    startShadow();
  }, [stopSpeak, startShadow]);

  // ---- 声波舞台：60fps 三色正弦叠加，振幅吃真实状态（录音电平/播报/待机） ----
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveStateRef = useRef({ listening: false, playing: false });
  waveStateRef.current = {
    listening: phase === "recording" || shadow.phase === "recording",
    playing: phase === "speaking",
  };
  useEffect(() => {
    const waves = [
      { color: "rgba(200, 75, 49, 0.45)", freq: 0.014, speed: 1.0, amp: 28 },
      { color: "rgba(27, 107, 88, 0.38)", freq: 0.021, speed: -0.7, amp: 22 },
      { color: "rgba(54, 73, 196, 0.25)", freq: 0.01, speed: 1.4, amp: 16 },
    ];
    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return; // 场景中心页没有舞台，跳帧即可
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const { listening, playing } = waveStateRef.current;
      // 录音中吃真实麦克风电平：静音时也留底摆，说话时顶到 0.78 量级
      const micFactor = Math.min(1, 0.45 + levelRef.current * 2.2);
      const targetAmp = listening ? 0.78 * micFactor : playing ? 0.52 : 0.16;
      waveAmpRef.current += (targetAmp - waveAmpRef.current) * 0.08;
      wavePhaseRef.current += listening ? 0.09 : 0.03;
      for (const wv of waves) {
        ctx.beginPath();
        ctx.strokeStyle = wv.color;
        ctx.lineWidth = 2;
        for (let x = 0; x <= w; x += 6) {
          const envelope = Math.sin((x / w) * Math.PI);
          const y =
            h / 2 +
            Math.sin(x * wv.freq + wavePhaseRef.current * wv.speed) * wv.amp * waveAmpRef.current * envelope;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // 组件卸载/切视图时收麦停声。stopSpeak 走 ref、依赖恒为 []：
  // 若直接依赖 prop，ReaderApp 的任何重渲染（翻译流式 delta、自动保存等）
  // 都会执行 cleanup，掐断进行中的录音，松开时报「录音已结束」。
  const stopSpeakRef = useRef(stopSpeak);
  stopSpeakRef.current = stopSpeak;
  useEffect(() => {
    return () => {
      epochRef.current += 1;
      recorderRef.current?.cancel();
      shadowRecorderRef.current?.cancel();
      stopSpeakRef.current();
      // 切走视图 = 会话离开屏幕（SpeakView 条件渲染，session 态随之丢失），
      // 补发 end 埋点；trackSessionEnd 依赖恒为 []、只读 ref，身份稳定。
      trackSessionEnd();
    };
  }, []);

  // ---- 发音详情：最新 user 轮的 pron（pron 对象引用在会话其它更新间保持稳定，
  // 选中态不因落盘刷新被重置） ----
  const lastPronTurn = useMemo(() => {
    if (!session) return null;
    for (let i = session.turns.length - 1; i >= 0; i -= 1) {
      if (session.turns[i].pron) return session.turns[i];
    }
    return null;
  }, [session]);
  const lastPron = lastPronTurn?.pron ?? null;
  const lastPronText = lastPronTurn?.text ?? "";

  // 新评测到达：默认选中得分最低的词（含漏读 0 分）
  useEffect(() => {
    const words = lastPron?.words ?? [];
    if (words.length === 0) {
      setPronSel(null);
      return;
    }
    let worst = 0;
    words.forEach((w, i) => {
      if (w.totalScore < words[worst].totalScore) worst = i;
    });
    setPronSel({ wordIdx: worst, phoneIdx: 0 });
  }, [lastPron]);

  const pronWords = lastPron?.words ?? [];
  const pronMarks = useMemo(
    () => (lastPron ? mapWordsToText(lastPronText, lastPron.words) : []),
    [lastPron, lastPronText],
  );
  const selWord = pronSel ? pronWords[pronSel.wordIdx] : undefined;
  const selPhones = selWord?.sylls.flatMap((s) => s.phones) ?? [];
  const selPhone = pronSel ? selPhones[pronSel.phoneIdx] : undefined;
  const scorePath = useMemo(() => wordScorePath(pronWords), [pronWords]);

  // ---- 场景标题（舞台状态行 / 最近会话行共用） ----
  const sceneTitleOf = useCallback((s: SpeakSession): string => {
    if (s.context?.kind === "book") return `聊刚读的《${s.context.bookTitle}》第 ${s.context.chapterIdx + 1} 章`;
    if (s.context?.kind === "vocab") return "今日生词造句闯关";
    return SCENARIO_CARDS[s.scenario].title;
  }, []);

  /** 今日收集的词块数（场景中心组标签右侧的真实计数）。 */
  const todayChunkCount = useMemo(() => {
    const today = new Date();
    const dayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
    return vocabWords.filter((w) => {
      const d = new Date(w.addedAt);
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` === dayKey;
    }).length;
  }, [vocabWords]);

  /** 用户轮命中的目标词 ids（存为笔记时预选）。 */
  const hitIdsOfTurn = useCallback(
    (text: string): string[] => contextTargets.filter((w) => textHitsTarget(text, w.word)).map((w) => w.id),
    [contextTargets],
  );

  // ---- 入口页（场景中心） ----
  if (!session) {
    const vocabDue = dueVocabWords.slice(0, 8);
    return (
      <div className="scenario-hub-scroll">
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 16,
            paddingBottom: 16,
            borderBottom: "1px solid var(--glass-border-strong)",
          }}
        >
          <div>
            {onBack && (
              <button className="pill-Ghost-btn" style={{ border: "1px solid var(--glass-border-strong)", marginBottom: 8 }} onClick={onBack}>
                ‹ 回到阅读
              </button>
            )}
            <h2 style={{ fontFamily: "var(--font-serif)", fontSize: 32, margin: "0 0 6px", color: "var(--ink-1)" }}>
              选择口语练习场景
            </h2>
            <p style={{ fontSize: 13.5, color: "var(--ink-2)", margin: 0 }}>
              可以围绕你刚读完的章节和生词开口练习，也可以任选日常或职场话题模拟对话
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>对话难度：</span>
            <div className="lens-mode-switch" role="group" aria-label="对话难度">
              <button
                className={`lens-mode-btn${difficulty === "easy" ? " active" : ""}`}
                onClick={() => setDifficulty("easy")}
              >
                轻松
              </button>
              <button
                className={`lens-mode-btn${difficulty === "medium" ? " active" : ""}`}
                onClick={() => setDifficulty("medium")}
              >
                日常
              </button>
              <button
                className={`lens-mode-btn${difficulty === "hard" ? " active" : ""}`}
                onClick={() => setDifficulty("hard")}
              >
                进阶
              </button>
            </div>
          </div>
        </div>

        {(bookContext || vocabDue.length > 0) && (
          <>
            <div className="scenario-group-label">
              <span>结合正在读的内容（推荐 · 用出来自动完成复习）</span>
              <span>{todayChunkCount > 0 ? `今日已收 ${todayChunkCount} 个词块` : "在对话中用出来就算复习"}</span>
            </div>
            <div className="scenario-featured-grid">
              {bookContext && (() => {
                const bookCtx: SpeakSessionContext = {
                  kind: "book",
                  bookTitle: bookContext.title,
                  chapterArticleId: bookContext.articleId,
                  chapterIdx: bookContext.chapterIdx,
                  excerpt: bookContext.excerpt,
                };
                return (
                  <button className="scenario-card" onClick={() => start("smalltalk", difficulty, bookCtx)}>
                    <div>
                      <span className="sc-tag">
                        <IconBookOpen size={13} /> 正在共读 · 第 {bookContext.chapterIdx + 1} 章
                      </span>
                      <div className="sc-title">聊刚读的《{bookContext.title}》</div>
                      <p className="sc-desc">
                        AI 围绕第 {bookContext.chapterIdx + 1} 章剧情与你互动讨论，引导你在回答中自然用出本章刚查过的词块。
                      </p>
                    </div>
                    <div className="sc-opener-preview">开场白：“{contextOpener(bookCtx).text}”</div>
                  </button>
                );
              })()}
              {vocabDue.length > 0 && (
                <button className="scenario-card" onClick={() => start("smalltalk", difficulty, { kind: "vocab", wordIds: vocabDue.map((w) => w.id) })}>
                  <div>
                    <span className="sc-tag teal">
                      <IconSparkles size={13} /> 生词本联动 · {vocabDue.length} 词待用
                    </span>
                    <div className="sc-title">今日生词造句闯关</div>
                    <p className="sc-desc">
                      不用死背单词卡——AI 出生活化情境提问，你只要在回答里用对今天待复习的生词，即算复习过关。
                      {vocabDue.length > 0 && (
                        <>
                          {" "}
                          今天的目标：<strong>{vocabDue.slice(0, 3).map((w) => w.word).join("、")}</strong>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="sc-opener-preview">开场白：“{contextOpener({ kind: "vocab", wordIds: [] }).text}”</div>
                </button>
              )}
            </div>
          </>
        )}

        <div className="scenario-group-label">
          <span>日常与职场模拟场景</span>
          <span>点击即可开始</span>
        </div>
        <div className="scenario-daily-grid">
          {SPEAK_SCENARIO_ORDER.map((id) => {
            const card = SCENARIO_CARDS[id];
            const Icon = SCENARIO_CARD_ICONS[id];
            const sc = scenarioOf(id);
            return (
              <button key={id} className="scenario-card" onClick={() => start(id, difficulty)}>
                <div>
                  <span className="sc-tag neutral">
                    <Icon size={13} /> {card.tag}
                  </span>
                  <div className="sc-title">{card.title}</div>
                  <p className="sc-desc">{card.desc}</p>
                </div>
                <div className="sc-opener-preview">“{sc.opener}”</div>
              </button>
            );
          })}
        </div>

        {recent.length > 0 && (
          <>
            <div className="scenario-group-label">
              <span>继续上次的对话</span>
            </div>
            {recent.slice(0, 3).map((s) => {
              const pronScores = s.turns.flatMap((t) => (t.pron ? [t.pron.total] : []));
              const avg = pronScores.length ? (pronScores.reduce((a, b) => a + b, 0) / pronScores.length).toFixed(1) : null;
              return (
                <button key={s.id} className="recent-session-row" onClick={() => resume(s)}>
                  <span>
                    <strong>{sceneTitleOf(s)}</strong>
                    <span style={{ color: "var(--ink-3)", marginLeft: 8 }}>
                      {difficultyOf(s.difficulty).label}难度 · 已聊 {Math.floor(s.turns.length / 2)} 轮
                      {avg ? ` · 发音均分 ${avg}` : ""}
                    </span>
                  </span>
                  <span style={{ color: "var(--accent)", fontWeight: 600 }}>继续对话 →</span>
                </button>
              );
            })}
          </>
        )}
      </div>
    );
  }

  // ---- 对话页（声波工作室） ----
  const sc = scenarioOf(session.scenario);
  const busy = phase === "recording" || phase === "asr" || phase === "thinking";
  const micTitle =
    phase === "recording"
      ? "正在听你说——停顿约 1.5 秒自动发送，再点一下立即说完"
      : phase === "speaking"
        ? "点击插话（会打断播报）"
        : "点击开始说话，停顿自动发送";

  let lastAssistantIdx = -1;
  for (let i = session.turns.length - 1; i >= 0; i -= 1) {
    if (session.turns[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  const lastTotal = lastReport ? lastReport.totals[lastReport.totals.length - 1] : null;
  // 有没有可复盘的跟读数据（一次都没跟读过时复盘入口禁用）
  const hasAssessments = session.turns.some(
    (t) => t.role === "assistant" && (t.shadowAttempts?.length ?? 0) > 0,
  );

  return (
    <div className="sonic-studio-grid">
      <div className="sonic-dialogue-well">
        <div className="harmonic-stage-card">
          <canvas id="harmonicCanvas" ref={canvasRef} width={760} height={122} />
          <div className="harmonic-overlay-left">
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <button
                className="pill-Ghost-btn"
                style={{ background: "var(--glass-elevated)", border: "1px solid var(--glass-border-strong)", fontWeight: 600, color: "var(--ink-1)" }}
                onClick={backToHub}
              >
                ← 切换场景
              </button>
              <span className="cloud-pulse" aria-hidden />
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-1)" }}>
                当前场景：{sceneTitleOf(session)}
              </span>
              <span className="tabular" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                （{difficultyOf(session.difficulty).label}难度）
              </span>
            </div>
            {contextTargets.length > 0 && (
              <div className="target-chip-row">
                {contextTargets.slice(0, 6).map((w) => {
                  const done = hitTargetIds.has(w.id);
                  return (
                    <span
                      key={w.id}
                      className={`lex-target-chip${done ? " done" : ""}`}
                      title={`${w.word} — 在对话中自然说出即可完成`}
                      onClick={() => onToast(`今日练习词块：${w.word} — 在对话中自然说出即可完成`)}
                    >
                      <span>{done ? "✓ 已用上" : "○ 待练习"}</span>
                      <strong>{w.word}</strong>
                      {w.zh && <span style={{ opacity: 0.75 }}>{w.zh}</span>}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          <div className="harmonic-overlay-right" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {phase === "recording" && (
              <button
                className="pill-Ghost-btn"
                style={{ background: "var(--glass-elevated)", border: "1px solid var(--glass-border-strong)" }}
                onClick={() => void finishUtterance()}
              >
                说完了
              </button>
            )}
            <button
              className={`sonic-play-orb${phase === "recording" ? " rec" : ""}`}
              style={
                phase === "recording"
                  ? { width: 44, height: 44, background: "var(--accent)", color: "#FFF" }
                  : { width: 44, height: 44 }
              }
              onClick={toggleMic}
              disabled={phase === "asr" || phase === "thinking" || drill !== null}
              title={micTitle}
              aria-label={phase === "recording" ? "说完（点击结束录音）" : "点击开始说话"}
            >
              <IconMic size={18} />
            </button>
          </div>
        </div>

        <div className="sonic-turns-scroll speak-log" ref={scrollRef}>
          {session.turns.map((t, i) => {
            const isLastAssistant = t.role === "assistant" && i === lastAssistantIdx;
            if (t.role === "assistant") {
              return (
                <div key={i} className="dialogue-turn">
                  <div className="turn-speaker-line">
                    <span>AI 陪练 · {sc.label}</span>
                    <button
                      className="text-action-btn"
                      disabled={busy}
                      onClick={() => speakRound(t.text)}
                      title="重听这句"
                    >
                      <IconVolume size={13} /> 重听
                    </button>
                  </div>
                  <div className="turn-prose-en">{t.text}</div>
                  {t.hintZh && <div className="turn-prose-zh">{t.hintZh}</div>}
                  {!isLastAssistant && (t.shadowAttempts?.length || typeof t.shadowScore === "number") && (
                    <div className="speak-shadow-score">
                      {t.shadowAttempts?.length
                        ? `跟读过 ${t.shadowAttempts.length} 次 · 最好 ${Math.max(...t.shadowAttempts.map((a) => a.total)).toFixed(1)}`
                        : `跟读 ${(t.shadowScore ?? 0).toFixed(1)} / 5`}
                    </div>
                  )}
                </div>
              );
            }
            return (
              <div key={i} className="dialogue-turn mine">
                <div className="turn-speaker-line tabular">
                  <span>我的回答 · 点击右侧单词查看发音细节</span>
                  {t.pron && (
                    <span style={{ color: "var(--accent)", fontWeight: 600 }}>
                      发音得分 {t.pron.total.toFixed(1)} / 5.0
                    </span>
                  )}
                </div>
                <div className="turn-prose-en">{t.text}</div>
                {t.coachDiff && t.coachDiff.segs.length > 0 && (
                  <div className="editorial-diff-block">
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        fontSize: 11.5,
                        fontWeight: 600,
                        color: "var(--sonic-teal)",
                        marginBottom: 4,
                      }}
                    >
                      <span>表达改进建议</span>
                      <button className="text-action-btn" onClick={() => onGenerateNote(hitIdsOfTurn(t.text))}>
                        ＋ 存为笔记
                      </button>
                    </div>
                    <div style={{ fontFamily: "var(--font-serif)", fontSize: 16, lineHeight: 1.55, color: "var(--ink-1)" }}>
                      {t.coachDiff.segs.map((seg: CoachSeg, j) =>
                        seg.t === "del" ? (
                          <span key={j} className="diff-del-span">{seg.v}</span>
                        ) : seg.t === "ins" ? (
                          <span key={j} className="diff-ins-span">{seg.v}</span>
                        ) : (
                          <span key={j}>{seg.v} </span>
                        ),
                      )}
                    </div>
                    {t.coachDiff.note && (
                      <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 5 }}>{t.coachDiff.note}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {shadowTarget && lastReport && (
            <ShadowReport
              key={`shadow-${lastReport.attemptAt}`}
              target={shadowTarget}
              result={lastReport.view.result}
              marks={lastReport.view.marks}
              attemptTotals={lastReport.totals}
              onAgain={startShadow}
              onDrill={openDrill}
              onHearModel={() => speakRound(shadowTarget)}
              onHearMine={mineReady ? hearMine : null}
              onSpeakWord={speakWord}
            />
          )}
          {shadowTarget && shadow.phase === "error" && shadow.errorKind !== "" && (
            <ShadowErrorCard
              kind={shadow.errorKind}
              detail={shadow.error}
              onHearModel={() => speakRound(shadowTarget)}
              onAgain={startShadow}
            />
          )}
          {phase === "thinking" && (
            <div className="dialogue-turn">
              <div className="turn-prose-en" style={{ opacity: 0.7 }}>{liveReply || "…在想你该怎么说…"}</div>
            </div>
          )}
          {phase === "asr" && (
            <div className="dialogue-turn mine">
              <div className="turn-speaker-line">…识别你刚才说的…</div>
            </div>
          )}
        </div>

        {roundError && (
          <div className="speak-error">
            {roundError}
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setRoundError("");
                setPhase("idle");
              }}
            >
              知道了
            </button>
          </div>
        )}

        <div className="speak-controls in-studio">
          <div className="speak-level-bar" aria-hidden>
            <i style={{ width: `${Math.round(Math.min(1, level) * 100)}%` }} />
          </div>
          <div className="speak-controls-row">
            <span className="speak-phase-hint">
              {phase === "recording"
                ? "正在听你说…停顿约 1.5 秒自动发送"
                : phase === "asr"
                  ? "识别中…"
                  : phase === "thinking"
                    ? "对方回复中…"
                    : phase === "speaking"
                      ? "对方说话中 · 点击麦克风可插话"
                      : "点击麦克风说话（英语）→ AI 回复带中文提示"}
            </span>
            {phase === "thinking" && (
              <button className="btn btn-secondary" onClick={skipReply}>
                跳过回复
              </button>
            )}
            <button
              className="btn btn-secondary"
              disabled={!shadowTarget || busy || drill !== null || shadow.phase === "evaluating"}
              onClick={shadow.phase === "recording" ? finishShadow : startShadow}
              onMouseUp={shadow.phase === "recording" ? finishShadow : undefined}
              title="照着 AI 最新一句读，讯飞评测打分"
            >
              {shadow.phase === "recording"
                ? "松开结束跟读"
                : shadow.phase === "evaluating"
                  ? "评分中…"
                  : shadow.phase === "done" && lastTotal !== null
                    ? `跟读 ${lastTotal.toFixed(1)} 分 · 再跟读`
                    : shadow.phase === "error"
                      ? shadow.errorKind !== ""
                        ? "跟读失败 · 重试"
                        : `跟读失败 · 重试（${shadow.error}）`
                      : "跟读打分"}
            </button>
            <button
              className="speak-replay"
              disabled={!shadowTarget || busy}
              onClick={() => shadowTarget && speakRound(shadowTarget)}
              title="重听 AI 这句"
            >
              重听 AI 这句
            </button>
            <button
              className="speak-review-entry"
              disabled={!hasAssessments}
              title={
                hasAssessments
                  ? "复盘本轮跟读中没掌握的词，确认后加入生词本"
                  : "还没有跟读记录——先「跟读打分」一次再来复盘"
              }
              onClick={() => {
                stopSpeak();
                setDrill(null);
                setReviewOpen(true);
              }}
            >
              <span className="dot" aria-hidden />
              ✦ 结束本轮并复盘
            </button>
          </div>
          {shadow.phase === "error" && shadow.errorKind === "" && (
            <div className="speak-shadow-err">{shadow.error}</div>
          )}
          <div className="speak-hint">
            「跟读打分」照 AI 最新一句读，报告卡会告诉你差在哪；右侧「发音详情」看你每轮发言的逐词得分
          </div>
          <button
            className="speak-creds-toggle"
            onClick={() => void openSettings().catch(() => undefined)}
            title="讯飞评测/听写凭据在主窗口 设置 → 语音 里集中配置"
          >
            讯飞凭据设置
          </button>
        </div>
      </div>

      <aside className="spatial-lens-card" style={{ width: "100%", margin: 0 }}>
        <div className="lens-header">
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>发音详情</span>
          <span className="tabular" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)", fontWeight: 600 }}>
            逐音标打分
          </span>
        </div>
        <div className="lens-body">
          {!lastPron ? (
            <div className="lens-section">
              <div className="lens-kicker">
                <span>点选单词查看发音细节</span>
              </div>
              <div className="lens-empty">
                还没有你的发音评分——说一句话（或配好讯飞评测凭据后再说一句），这里会给出逐词得分、
                逐音标拆解和慢速示范。
              </div>
            </div>
          ) : (
            <>
              <div className="lens-section">
                <div className="lens-kicker">
                  <span>点选单词查看发音细节</span>
                  <span className="tabular" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)", fontWeight: 600 }}>
                    {lastPron.total.toFixed(1)} / 5.0
                  </span>
                </div>
                <div style={{ lineHeight: 2, fontFamily: "var(--font-serif)", fontSize: 17 }}>
                  <MarkedWords
                    target={lastPronText}
                    marks={pronMarks}
                    onClick={(mark) => {
                      // marks 与 pronWords 不一定一一对应（增读词被过滤、对不上原文的词被丢弃），
                      // 用词对象引用回找下标
                      if (!mark.word) return;
                      const idx = pronWords.indexOf(mark.word);
                      if (idx >= 0) setPronSel({ wordIdx: idx, phoneIdx: 0 });
                    }}
                  />
                </div>
              </div>
              {selWord && (
                <div className="lens-section">
                  <div className="lens-kicker tabular">
                    <span>
                      音标拆解 · {selWord.content}（{selWord.totalScore.toFixed(1)} 分）
                    </span>
                  </div>
                  <PhonemeRow
                    phones={selPhones}
                    variant="pills"
                    selectedIdx={pronSel?.phoneIdx ?? null}
                    onSelect={(idx) => setPronSel((s) => (s ? { ...s, phoneIdx: idx } : s))}
                  />
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-1)", marginBottom: 4 }}>
                    发音建议（/{selPhone?.content ?? ""}/）：
                  </div>
                  <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-2)", margin: "0 0 12px" }}>
                    {selPhone ? phoneTip(selPhone.content) : "点上面的音素看针对性建议"}
                  </p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      className="island-tab active"
                      style={{ flex: 1, justifyContent: "center" }}
                      onClick={() => speakWordSlowly(selWord.content)}
                      title="云引擎按 0.75× 原生慢速合成示范；本地语音走普通朗读"
                    >
                      慢速示范 (0.75×)
                    </button>
                    <button
                      className="pill-Ghost-btn"
                      style={{ border: "1px solid var(--glass-border-strong)" }}
                      onClick={() => speakWord(selWord.content)}
                    >
                      重读这个词
                    </button>
                  </div>
                </div>
              )}
              <div className="lens-section">
                <div className="lens-kicker">
                  <span>逐词得分对比</span>
                  <span style={{ fontSize: 11, color: "var(--ink-3)" }}>虚线：5 分基准</span>
                </div>
                <svg
                  className="word-score-svg"
                  viewBox={`0 0 ${scorePath.width} ${scorePath.height}`}
                  role="img"
                  aria-label="逐词得分曲线"
                >
                  <line
                    x1={12}
                    y1={scorePath.baselineY}
                    x2={scorePath.width - 12}
                    y2={scorePath.baselineY}
                    stroke="var(--glass-border-strong)"
                    strokeDasharray="3 3"
                    strokeWidth={1}
                  />
                  <polyline
                    points={scorePath.points.map((p) => `${p.x},${p.y}`).join(" ")}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                  {scorePath.points.map((p, i) => (
                    <circle
                      key={i}
                      cx={p.x}
                      cy={p.y}
                      r={pronSel?.wordIdx === i ? 3.2 : 2}
                      fill={pronSel?.wordIdx === i ? "var(--accent)" : "var(--ink-2)"}
                      onClick={() => setPronSel({ wordIdx: i, phoneIdx: 0 })}
                      style={{ cursor: "pointer" }}
                    />
                  ))}
                </svg>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6 }}>
                  连线是这一轮每个词的真实得分（点击圆点同步选中上方单词）
                </div>
              </div>
            </>
          )}
        </div>
      </aside>

      {drill && (
        <ShadowDrill
          entries={drill.entries}
          micDeviceId={micDeviceId}
          onToast={onToast}
          onSpeakWord={speakWord}
          onClose={closeDrill}
          onDone={drillDone}
        />
      )}

      {reviewOpen && (
        <SpeakReviewDialog
          session={session}
          vocabWords={vocabWords}
          requestTranslate={requestTranslate}
          onSpeakWord={speakWord}
          onToast={onToast}
          onSaved={onVocabSaved}
          onGenerateNote={onGenerateNote}
          onGoReview={onGoReview}
          onClose={() => setReviewOpen(false)}
        />
      )}
    </div>
  );
}

/** 评测异常的可行动卡片（乱读/无声音/环境差），替代冷冰冰的错误码。 */
function ShadowErrorCard({
  kind,
  detail,
  onHearModel,
  onAgain,
}: {
  kind: Exclude<ShadowErrorKind, "">;
  detail: string;
  onHearModel: () => void;
  onAgain: () => void;
}) {
  if (kind === "rejected") {
    return (
      <div className="speak-report-err">
        <div className="re-title">✗ 读的好像不是这句话</div>
        <div>不用灰心——可能句子太长跟丢了。先听一遍领读，照着文字再试一次。</div>
        <div className="rc-actions">
          <button className="rc-btn primary" onClick={onHearModel}>
            🔊 听领读
          </button>
          <button className="rc-btn" onClick={onAgain}>
            🎤 再跟读
          </button>
        </div>
      </div>
    );
  }
  if (kind === "novoice") {
    return (
      <div className="speak-report-err novoice">
        <div className="re-title">· 没听到你的声音</div>
        <div>离麦克风近一点，按住按钮读完这一句再松开。</div>
        <div className="rc-actions">
          <button className="rc-btn primary" onClick={onAgain}>
            🎤 重新跟读
          </button>
        </div>
      </div>
    );
  }
  if (kind === "noisy") {
    return (
      <div className="speak-report-err novoice">
        <div className="re-title">· 环境有点吵</div>
        <div>背景噪音偏大，评测听不清——换个安静些的地方，或离麦克风再近一点。</div>
        <div className="rc-actions">
          <button className="rc-btn primary" onClick={onAgain}>
            🎤 重新跟读
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="speak-report-err novoice">
      <div className="re-title">· 这次没评上</div>
      <div>{detail || "再试一次应该就好。"}</div>
      <div className="rc-actions">
        <button className="rc-btn primary" onClick={onAgain}>
          🎤 再试一次
        </button>
      </div>
    </div>
  );
}
