/**
 * 屏 E · 口语陪练（v0.8 场景中心版）：选场景 → 免长按开麦对话 → 表达改进。
 *
 * 入口页 .scenario-hub-scroll：置顶「聊刚读的章节」「今日生词造句闯关」两张
 * 语境卡（真实数据：bookContext / dueVocabWords），下接四个日常场景大卡与
 * 「官方场景库」（目录紧凑卡 + 分类筛选/展开）、「我的场景」分组（紧凑卡；
 * A1 场景目录，装载失败/为空时分组不渲染）。
 * 对话页 .sonic-studio-grid：场景条（目标词进度 + 听力模式）+ 目标词 chips
 * + 对话流 + 底部输入区（点击/空格开麦、Esc 取消；core/vad.ts 静音自动收）
 * → 讯飞听写 → LLM 四行回复（EN/ZH/BETTER/TIP）→ 用户气泡下渲染词级增删对比
 * （.editorial-diff-block）；同一录音异步送 ISE 发音评测写入 user 轮 pron，
 * 右侧「发音详情」透镜卡（词着色 / 音素药丸 / 逐词得分曲线 / 慢速示范）。
 * 命中语境目标词自动按 easy 档完成 SRS（onGradeVocab 记 spokenAt）。
 *
 * 跟读子流程（ShadowReport 卡 + 只练差词抽屉 + 结束复盘弹层）原样共存。
 * 降级原则：断麦/断网/凭据缺失都给中文提示 + 逃生门，ISE 失败只降级不阻塞。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  buildSpeakSystemPrompt,
  buildSpeakUserInput,
  computeCoachDiff,
  difficultyOf,
  lastAssistantText,
  listOfficialScenarios,
  listUserScenarios,
  newSpeakSession,
  parseAssistantReply,
  scenarioOf,
  textHitsTarget,
  type CoachSeg,
  type ShadowAttempt,
  type SpeakContextTarget,
  type SpeakDifficulty,
  type SpeakScenario,
  type SpeakScenarioCategory,
  type SpeakScenarioId,
  type SpeakSession,
  type SpeakSessionContext,
} from "../core/speakLogic";
import { transcribeSpeech } from "../core/xfyunAsr";
import {
  appendScenarioTargetsToPrompt,
  hitKeyPhrases,
  userScenarioTargets,
} from "../core/scenarioForge";
import {
  evaluateSentence,
  mapWordsToText,
  type IseCredentials,
  type PronunciationResult,
  type WordMark,
} from "../core/pronunciation";
import { startMicRecorder, type MicRecorderHandle } from "../core/micRecorder";
import { createVadDetector, type VadDetector } from "../core/vad";
import { loadAsrCredentials, loadIseCredentials } from "../lib/iseCredentials";
import {
  evaluatePronunciation,
  pcm16kToBase64,
  resolveVoiceRoute,
  transcribeBatch,
  voiceErrorDisplayText,
} from "../lib/voice";
import { loadSpeakListenMode, saveSpeakListenMode } from "./readerSettingsStore";
import { track } from "../lib/analytics";
import { speakListSessions, speakSaveSession } from "../lib/speakStore";
import {
  enqueueSessionRecordSilently,
  listSessionRecords,
  mergeSessionsWithRecords,
  recordAssessmentSilently,
  syncSpeakRecordsSilently,
  type SpeakSessionRecord,
} from "../lib/speakRecords";
import {
  OFFICIAL_CATALOG_BADGE,
  officialCatalogSource,
  preloadScenarioCatalog,
  refreshOfficialScenarioCatalog,
} from "../lib/scenarioCatalog";
import { cancelTranslation, openSettings, settingsOpenTab } from "../lib/tauriBridge";
import {
  filterScenarioPreview,
  findTargetSpans,
  friendlyNotice,
  micTip,
  nextTargetKey,
  scenarioCategoryCounts,
  scenarioSummary,
  scoreTone,
  targetProgress,
  worstPhoneIdx,
  type ScenarioFilter,
  type Span,
} from "../core/speakUi";
import {
  ListeningRow,
  PronPanel,
  SpeakMic,
  SpeakNotice,
  SpeakSceneBar,
  TargetChips,
  UserSentence,
  type NoticeAction,
  type TargetChipItem,
} from "./SpeakParts";
import type { VocabWord } from "../core/readerTypes";
import type { NoteTranslateFn } from "./VocabNoteDialog";
import { ShadowReport, type DrillEntry } from "./ShadowReport";
import { ShadowDrill } from "./ShadowDrill";
import { SpeakReviewDialog } from "./SpeakReviewDialog";
import { SpeakScenarioEditor } from "./SpeakScenarioEditor";
import {
  IconBookOpen,
  IconCheck,
  IconClock,
  IconEye,
  IconList,
  IconLocate,
  IconSparkles,
  IconStar,
  IconVolume,
} from "../ui/icons";

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

/** 官方/用户场景卡 tag 位的分类词（无法穷举图标映射，tag 位放 emoji 或分类词兜底）。 */
const CATEGORY_TAG_ZH: Record<SpeakScenarioCategory, string> = {
  daily: "日常",
  travel: "旅行",
  workplace: "职场",
  academic: "学术",
  custom: "自定义",
};

/** 目录紧凑卡（「官方场景库」「我的场景」共用）：分类+emoji 标签、标题、2 行摘要
 *  （goal 优先，CSS line-clamp 截断）、难度小标签；开场白预览挪到 title 提示，
 *  信息不丢。点击行为与大卡一致（onPick = start(sc.id, …)）。 */
function CompactScenarioCard({ sc, onPick }: { sc: SpeakScenario; onPick: () => void }) {
  return (
    <button className="scenario-card compact" title={`开场白：“${sc.opener}”`} onClick={onPick}>
      <div>
        <span className="sc-tag neutral">
          {CATEGORY_TAG_ZH[sc.category]}
          {sc.emoji ? ` ${sc.emoji}` : ""}
        </span>
        <div className="sc-title">{sc.title}</div>
        <p className="sc-desc">{scenarioSummary(sc)}</p>
      </div>
      {sc.defaultDifficulty && (
        <div className="sc-compact-meta">
          <span className="sc-tag neutral">{difficultyOf(sc.defaultDifficulty).label}难度</span>
        </div>
      )}
    </button>
  );
}

/** 语境会话（book/vocab）的开场白：模板 + 真实数据插值（与 SPEAK_SCENARIOS
 * 内置场景及 A1 场景目录的 opener 同一性质，不引入演示内容）。 */
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
  /** 打开阅读室设置抽屉（麦克风选择在那里）；缺省则提示条不显示「检查麦克风」。 */
  onOpenReaderSettings?: () => void;
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
  onOpenReaderSettings,
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
  /** 官方/用户场景分组的数据（A1 场景目录；装载失败/为空=不显示分组，
   *  resume 旧会话的场景名由 scenarioOf 兜底，不依赖这里的 state）。 */
  const [extraLists, setExtraLists] = useState<{ official: SpeakScenario[]; user: SpeakScenario[] }>({
    official: [],
    user: [],
  });
  /** 场景编辑器（A2）：null=关闭；initial=null 新建、非 null 编辑该用户场景。
   *  全部入口（「＋ 新建场景」/卡片「编辑」）都在入口页，编辑器也只挂在入口页。 */
  const [editorState, setEditorState] = useState<{ initial: SpeakScenario | null } | null>(null);
  /** 官方场景库的分类筛选 + 展开态（纯本地 UI 状态，不持久化；切分类回到收起态）。 */
  const [officialFilter, setOfficialFilter] = useState<ScenarioFilter>("all");
  const [officialExpanded, setOfficialExpanded] = useState(false);
  /** 听力模式（先听后看）：开 = 最新一句 AI 的英文/中文提示遮罩，答完或点
   *  「看原文」才显示；偏好记 localStorage（readerSettingsStore），跨会话保留。 */
  const [listenMode, setListenMode] = useState(() => loadSpeakListenMode());
  /** 听力模式下已揭开的 assistant 轮下标（逐轮记忆；换会话/新开时重置）。 */
  const [revealedTurns, setRevealedTurns] = useState<ReadonlySet<number>>(() => new Set());

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
  /** pendingSpeak 已消费的引用（同一 intent 不重复开会）。 */
  const pendingConsumedRef = useRef<PendingSpeakContext>(null);

  // 挂载时拉历史会话（入口页「继续上次的对话」）：本地富会话 + 云端精简记录
  // 合并展示；随后静默云同步（登录后拉云端变更——B 端首拉即见云端记录；游客
  // 零网络请求），有新记录落地时刷新一次列表。
  useEffect(() => {
    void (async () => {
      const [local, records] = await Promise.all([
        speakListSessions().catch(() => [] as SpeakSession[]),
        listSessionRecords(),
      ]);
      const refresh = (rs: SpeakSessionRecord[]) =>
        setRecent(mergeSessionsWithRecords(local, rs).slice(0, 5));
      refresh(records);
      const summaries = await syncSpeakRecordsSilently();
      if (summaries.some((s) => s.appliedRemote > 0)) {
        refresh(await listSessionRecords());
      }
    })();
  }, []);

  // 挂载时装载场景目录（A1）：先 preload（官方缓存+同步的用户场景），再拉取
  // 官方目录（每次进 tab 都拉，无节流；404/断网全静默）。装载前后各 set 一次，
  // 保证目录到达后入口网格刷新出「官方场景库」「我的场景」分组。
  useEffect(() => {
    void (async () => {
      await preloadScenarioCatalog();
      setExtraLists({ official: listOfficialScenarios(), user: listUserScenarios() });
      await refreshOfficialScenarioCatalog();
      setExtraLists({ official: listOfficialScenarios(), user: listUserScenarios() });
    })();
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
    // 本地富会话照旧落盘（Rust speak_store，重开对话的完整数据源）
    void speakSaveSession(next).catch(() => undefined);
    // 云端精简投影入队（本地写 + dirty，游客零网络；音频/跟读报告/提示不上云）
    enqueueSessionRecordSilently(next);
    void (async () => {
      const [list, records] = await Promise.all([
        speakListSessions().catch(() => [] as SpeakSession[]),
        listSessionRecords(),
      ]);
      setRecent(mergeSessionsWithRecords(list, records).slice(0, 5));
    })();
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
      setRevealedTurns(new Set()); // 听力模式：开场白先只听，遮罩从这一轮重新开始
      // 开场白直接播报
      speakRound(s.turns[0].text);
      persist(s);
      // 云端埋点（Phase 0 §8）：新会话开始。scenarioSource 取场景真实来源
      // （A1 官方/用户场景；查不到的场景回退内置，source 天然是 builtin）。
      trackedStartIdRef.current = s.id;
      track("speak_session_start", { scenarioId: scenario, scenarioSource: scenarioOf(scenario).source });
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
      // 听力模式：整段都是历史，原文全部可见，不再遮
      const allSeen = new Set<number>();
      s.turns.forEach((t, i) => {
        if (t.role === "assistant") allSeen.add(i);
      });
      setRevealedTurns(allSeen);
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

  // ---- 用户场景的 keyPhrases → 目标短语（A2 独立新通道，不碰语境 targets/SRS） ----
  // 只对 source==="user" 的场景产出（内置/官方/语境会话恒 []，现状零变化）；
  // 命中只打勾（chips done 态），不接 onGradeVocab、不进生词库。
  const scenarioPhrases = useMemo(
    () => (session ? userScenarioTargets(session.scenario).map((t) => t.word) : []),
    [session],
  );
  const scenarioHits = useMemo(
    () => hitKeyPhrases(session?.turns ?? [], scenarioPhrases),
    [session, scenarioPhrases],
  );

  /** 编辑器保存成功（A2）：直接读内存注册表刷新「我的场景」分组——preload 是
   *  once 单飞永久缓存，保存后重跑无效，必须 register（编辑器内）+ 显式 set。 */
  const onScenarioSaved = useCallback(() => {
    setExtraLists((prev) => ({ ...prev, user: listUserScenarios() }));
  }, []);

  // ---- 听力模式（先听后看） ----

  const toggleListenMode = useCallback(() => {
    setListenMode((on) => {
      const next = !on;
      saveSpeakListenMode(next);
      return next;
    });
  }, []);

  /** 揭开某一轮的原文（看原文按钮 / 答完自动揭共用；已揭开的保持不动）。 */
  const revealTurn = useCallback((idx: number) => {
    setRevealedTurns((prev) => {
      if (prev.has(idx)) return prev;
      const next = new Set(prev);
      next.add(idx);
      return next;
    });
  }, []);

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
    // 语音服务商路由（voiceRoute §三.5）：开麦时已守卫过，这里按态分派并兜住中途变化。
    const route = await resolveVoiceRoute("asr", { asrLang: "en_us" });
    if (route.engine === "off") {
      setPhase("error");
      setRoundError(route.hint ?? "语音识别暂不可用");
      return;
    }
    let creds: IseCredentials | null = null;
    if (route.engine === "xfyun") {
      creds = await loadAsrCredentials().catch(() => null);
      if (!creds) {
        setPhase("error");
        setRoundError("未配置讯飞听写凭据：到 设置 → 语音 里填一次（或复用跟读评测那组）");
        return;
      }
    }
    let userText: string;
    try {
      // gateway：REST 批量转写（pcm 已是 micRecorder 出来的 16k）；xfyun：既有流式听写。
      userText =
        route.engine === "gateway"
          ? (await transcribeBatch("en_us", pcm16kToBase64(pcm, 16000).base64)).text
          : await transcribeSpeech(pcm, "en_us", creds!);
    } catch (e) {
      if (epochRef.current !== epoch) return;
      setPhase("error");
      setRoundError(
        route.engine === "gateway"
          ? // 云端错误按 §二映射（额度/封禁/网络，额度类拼重置时间），非信封错误落通用兜底
            voiceErrorDisplayText(e as { code?: unknown; details?: unknown }) ||
              "服务暂时不可用，请稍后再试"
          : `语音识别失败：${e instanceof Error ? e.message : String(e)}`,
      );
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
    // 听力模式：你已答完这一问，最近一句 AI 原文自动揭开（先听→先说→再对照）
    for (let i = withUser.turns.length - 2; i >= 0; i -= 1) {
      if (withUser.turns[i].role === "assistant") {
        revealTurn(i);
        break;
      }
    }

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

    // 发音评测：同一录音送评测（路由守卫分派：gateway=VoiceClient，xfyun=既有直连；
    // off/失败仅降级：user 轮没有 pron，不阻塞对话）
    void (async () => {
      const iseRoute = await resolveVoiceRoute("ise");
      let result: PronunciationResult | null = null;
      if (iseRoute.engine === "gateway") {
        try {
          result = await evaluatePronunciation(userText, "en", pcm16kToBase64(pcm, 16000).base64);
        } catch {
          return; // 降级：不写 pron
        }
      } else if (iseRoute.engine === "xfyun") {
        const iseCreds = await loadIseCredentials().catch(() => null);
        if (!iseCreds) return;
        try {
          result = await evaluateSentence(pcm, userText, iseCreds);
        } catch {
          return; // 降级：不写 pron
        }
      } else {
        return; // off：守卫不过（未登录/未开通/额度尽），静默跳过不打扰对话
      }
      if (epochRef.current !== epoch) return;
      if (result.isRejected || result.exceptInfo !== null) return; // 异常不计入（同跟读语义）
      // 评测记录入云（speak-assessments，source=coach；仅分数与逐词精简，音频不上云）
      recordAssessmentSilently({
        result,
        source: "coach",
        refText: userText,
        sessionId: withUser.id,
      });
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
    })();

    // LLM 回复（流式上屏）
    setPhase("thinking");
    setLiveReply("");
    const tag = `spk${++tagRef.current}`;
    activeTagRef.current = tag;
    const sysTargets: SpeakContextTarget[] = contextTargetsRef.current.map((w) => ({ word: w.word, zh: w.zh }));
    // 用户场景的 keyPhrases 注入系统提示（A2）：调用侧拼接——空 targets 时
    // appendScenarioTargetsToPrompt 原样返回，内置/语境会话的 prompt 逐字不变
    // （语境 targets 与场景短语天然互斥：语境会话场景恒为 smalltalk）。
    const sceneTargets = userScenarioTargets(withUser.scenario);
    const res = await requestTranslate(
      buildSpeakUserInput(withUser.turns.slice(0, -1), userText),
      appendScenarioTargetsToPrompt(
        buildSpeakSystemPrompt(withUser.scenario, withUser.difficulty, withUser.context, sysTargets),
        sceneTargets,
      ),
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
  }, [onToast, onGradeVocab, patchLastUserTurn, persist, requestTranslate, speakRound, revealTurn]);

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
    setRoundError(""); // 新一轮开始：上一轮的提示条（含「已跳过」这类 idle 态提示）一并收起
    stopSpeak();
    setLevel(0);
    releasePendingRef.current = false;
    finishingRef.current = false;
    const epoch = epochRef.current;
    void (async () => {
      // 入口守卫（voiceRoute §三.5）：gateway 守卫不过 → 不开麦，给「登录沉浸云即用」引导；
      // xfyun 存量用户不经守卫，识别阶段才查凭据（行为不变）。
      const route = await resolveVoiceRoute("asr", { asrLang: "en_us" });
      if (epoch !== epochRef.current) return; // 期间已换场景/跳过
      if (route.engine === "off") {
        setPhase("error");
        setRoundError(route.hint ?? "语音识别暂不可用");
        return;
      }
      setPhase("recording");
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

  /** Esc 取消正在录的这一句（不识别、不进对话）。录音器还在等授权时打标记，由开麦续体丢弃。 */
  const cancelRecording = useCallback(() => {
    if (phase !== "recording" || finishingRef.current) return;
    if (recorderRef.current) {
      recorderRef.current.cancel();
      recorderRef.current = null;
    } else {
      releasePendingRef.current = true;
    }
    vadRef.current = null;
    setLevel(0);
    setPhase("idle");
  }, [phase]);

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
    shadowReleasePendingRef.current = false;
    void (async () => {
      try {
        const recorder = await startMicRecorder({
          deviceId: micDeviceId || undefined,
          onLevel: ({ level: lv, elapsedMs }) => {
            setLevel(lv);
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
    // 跟读评测走路由守卫（voiceRoute §三.5）：gateway=VoiceClient，xfyun=既有直连；
    // off=入口按态禁用——不烧任何额度，给「登录沉浸云即用」等引导。
    const route = await resolveVoiceRoute("ise");
    if (route.engine === "off") {
      setShadow({ ...SHADOW_IDLE, phase: "error", error: route.hint ?? "跟读打分暂不可用" });
      return;
    }
    let result: PronunciationResult;
    if (route.engine === "gateway") {
      try {
        result = await evaluatePronunciation(target, "en", pcm16kToBase64(pcm, 16000).base64);
      } catch (e) {
        setShadow({
          ...SHADOW_IDLE,
          phase: "error",
          // 云端错误按 §二映射（额度类拼重置时间）；非信封错误（网络/未接线）落通用兜底
          error:
            voiceErrorDisplayText(e as { code?: unknown; details?: unknown }) ||
            "服务暂时不可用，请稍后再试",
        });
        return;
      }
    } else {
      const creds = await loadIseCredentials().catch(() => null);
      if (!creds) {
        setShadow({ ...SHADOW_IDLE, phase: "error", error: "未配置讯飞评测凭据：设置 → 语音" });
        return;
      }
      try {
        result = await evaluateSentence(pcm, target, creds);
      } catch (e) {
        setShadow({ ...SHADOW_IDLE, phase: "error", error: e instanceof Error ? e.message : String(e) });
        return;
      }
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

    // 评测记录入云（speak-assessments，source=coach；仅分数与逐词精简，音频不上云）
    recordAssessmentSilently({
      result,
      source: "coach",
      refText: target,
      sessionId: sessionRef.current?.id,
    });

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

  // 新评测到达：默认选中得分最低的词（含漏读 0 分），并展开它最差的那个音素
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
    setPronSel({ wordIdx: worst, phoneIdx: worstPhoneIdx(words[worst]) });
  }, [lastPron]);

  /** 选中一个词：右栏默认展开它最差的音素（而不是永远第 0 个，否则红色音素和下面的建议对不上）。 */
  const selectWord = useCallback(
    (wordIdx: number) => {
      setPronSel({ wordIdx, phoneIdx: worstPhoneIdx(lastPron?.words[wordIdx]) });
    },
    [lastPron],
  );

  const pronWords = lastPron?.words ?? [];
  const pronMarks = useMemo(
    () => (lastPron ? mapWordsToText(lastPronText, lastPron.words) : []),
    [lastPron, lastPronText],
  );
  const selWord = pronSel ? pronWords[pronSel.wordIdx] : undefined;
  const weakCount = pronMarks.filter((m) => m.quality !== "good").length;

  // ---- 目标词 chips / 进度 / 句内高亮（语境目标词与用户场景短语两条通道合并展示，
  // 命中判定各走各的：前者按 VocabWord.id 驱动 SRS，后者只打勾） ----
  const targetItems = useMemo<TargetChipItem[]>(
    () => [
      ...contextTargets.slice(0, 6).map((w) => ({
        key: w.id,
        word: w.word,
        zh: w.zh,
        done: hitTargetIds.has(w.id),
        toast: `今日练习词块：${w.word} — 在对话中自然说出即可完成`,
      })),
      ...scenarioPhrases.map((p) => ({
        key: p,
        word: p,
        done: scenarioHits.has(p),
        toast: `本场景目标短语：${p} — 在对话中自然说出即可`,
      })),
    ],
    [contextTargets, hitTargetIds, scenarioPhrases, scenarioHits],
  );
  const progress = useMemo(
    () => targetProgress(targetItems.filter((t) => t.done).length, targetItems.length),
    [targetItems],
  );
  const nextKey = useMemo(
    () =>
      nextTargetKey(
        targetItems.map((t) => t.key),
        new Set(targetItems.filter((t) => t.done).map((t) => t.key)),
      ),
    [targetItems],
  );
  /** 一句话里的目标词命中：句内高亮区间 + 用上了几个不同的目标词
   *  （判定复用 textHitsTarget，与 chips 打勾一致）。 */
  const analyzeTargets = useCallback(
    (text: string): { spans: Span[]; count: number } => {
      const spans: Span[] = [];
      let count = 0;
      for (const t of targetItems) {
        const found = findTargetSpans(text, t.word);
        if (found.length > 0) count += 1;
        spans.push(...found);
      }
      return { spans: spans.sort((a, b) => a.start - b.start), count };
    },
    [targetItems],
  );

  /** 点句子里标色的词：右栏跳到该词的音素细节（marks 与 pronWords 不一一对应，用词对象引用回找下标）。 */
  const pickMark = useCallback(
    (mark: WordMark) => {
      if (!mark.word || !lastPron) return;
      const idx = lastPron.words.indexOf(mark.word);
      if (idx >= 0) selectWord(idx);
    },
    [lastPron, selectWord],
  );

  // ---- 本轮失败提示（主环错误优先，其次跟读的普通错误文本） ----
  const notice = useMemo(() => {
    if (roundError) return friendlyNotice(roundError);
    if (shadow.phase === "error" && shadow.errorKind === "" && shadow.error) {
      return friendlyNotice(shadow.error);
    }
    return null;
  }, [roundError, shadow.phase, shadow.errorKind, shadow.error]);

  // ---- 快捷键：空格 = 点麦克风（开始/发送），Esc = 取消正在录的这一句 ----
  // ReaderApp 的全局键盘只在阅读视图生效，口语页这里自管。让位规则：正在输入、
  // 焦点在按钮/链接上（空格本就会触发它）、带修饰键、长按重复、任何弹层/抽屉打开。
  useEffect(() => {
    if (!session) return;
    const modalOpen = () => drill !== null || reviewOpen || document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || modalOpen()) return;
      const el = e.target;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Escape") {
        if (phase === "recording") {
          e.preventDefault();
          cancelRecording();
        }
        return;
      }
      if (e.key === " " || e.code === "Space") {
        if (el instanceof HTMLElement && el.closest("button, a, summary, [role='button']")) return;
        e.preventDefault();
        toggleMic();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [session, drill, reviewOpen, phase, toggleMic, cancelRecording]);

  // ---- 场景标题（舞台状态行 / 最近会话行共用） ----
  // 内置场景直取本地卡文案（输出与旧版逐字一致）；off_/usr_ 未知 id 走合并查找
  // （目录未装载/已删的场景短暂显示「自定义场景」，装载后重渲染显真名，绝不崩）。
  const sceneTitleOf = useCallback((s: SpeakSession): string => {
    if (s.context?.kind === "book") return `聊刚读的《${s.context.bookTitle}》第 ${s.context.chapterIdx + 1} 章`;
    if (s.context?.kind === "vocab") return "今日生词造句闯关";
    const known = SCENARIO_CARDS[s.scenario];
    if (known) return known.title;
    const sc = scenarioOf(s.scenario);
    return sc.id === s.scenario ? sc.title : "自定义场景";
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
          {officialCatalogSource() === "fallback" && (
            <span>{OFFICIAL_CATALOG_BADGE.fallback}</span>
          )}
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

        {extraLists.official.length > 0 && (() => {
          // 目录层（B 精简）：分类 chips 只出实际有场景的分类；「全部」收起态只渲染
          // 前 8 张，选了数量不多的分类（≤ 8）则直接全显示，超限才出展开按钮。
          const counts = scenarioCategoryCounts(extraLists.official);
          const { visible, total, hasMore } = filterScenarioPreview(
            extraLists.official,
            officialFilter,
            officialExpanded,
          );
          const pickFilter = (f: ScenarioFilter) => {
            setOfficialFilter(f);
            setOfficialExpanded(false);
          };
          return (
            <>
              <div className="scenario-group-label">
                <span>官方场景库</span>
                <span>{OFFICIAL_CATALOG_BADGE[officialCatalogSource()]}</span>
              </div>
              <div className="lens-mode-switch scenario-filter-switch" role="group" aria-label="官方场景分类筛选">
                <button
                  className={`lens-mode-btn${officialFilter === "all" ? " active" : ""}`}
                  aria-pressed={officialFilter === "all"}
                  onClick={() => pickFilter("all")}
                >
                  全部 {extraLists.official.length}
                </button>
                {counts.map(({ category, count }) => (
                  <button
                    key={category}
                    className={`lens-mode-btn${officialFilter === category ? " active" : ""}`}
                    aria-pressed={officialFilter === category}
                    onClick={() => pickFilter(category)}
                  >
                    {CATEGORY_TAG_ZH[category]} {count}
                  </button>
                ))}
              </div>
              <div className="scenario-compact-grid">
                {visible.map((sc) => (
                  <CompactScenarioCard
                    key={sc.id}
                    sc={sc}
                    onPick={() => start(sc.id, sc.defaultDifficulty ?? difficulty)}
                  />
                ))}
              </div>
              {(hasMore || officialExpanded) && (
                <button
                  className="sc-expand-btn"
                  aria-expanded={officialExpanded}
                  onClick={() => setOfficialExpanded((v) => !v)}
                >
                  {officialExpanded ? "收起" : `展开全部 ${total} 个`}
                </button>
              )}
            </>
          );
        })()}

        {/* 「我的场景」（A2 起标签行常显：空分组也提供「＋ 新建场景」入口） */}
        <div className="scenario-group-label">
          <span>我的场景</span>
          <span className="scenario-group-tools">
            {extraLists.user.length > 0 && <span>多端同步</span>}
            <button className="sc-new-btn" onClick={() => setEditorState({ initial: null })}>
              ＋ 新建场景
            </button>
          </span>
        </div>
        {extraLists.user.length > 0 && (
          <div className="scenario-compact-grid">
            {extraLists.user.map((sc) => (
              // wrapper 承载「编辑」pill（HTML 不允许 button 嵌 button）；
              // 卡片 button 与 start(sc.id,…) 行为与内置/官方卡完全一致
              <div key={sc.id} className="sc-card-wrap">
                <CompactScenarioCard
                  sc={sc}
                  onPick={() => start(sc.id, sc.defaultDifficulty ?? difficulty)}
                />
                <button className="sc-edit-btn" onClick={() => setEditorState({ initial: sc })} title="编辑这个场景">
                  编辑
                </button>
              </div>
            ))}
          </div>
        )}

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

        {/* 场景编辑器（A2）：入口全在入口页，挂载钉死在入口页早退 return 内。
            modal-overlay 是 fixed 定位，挂在滚动容器内视觉仍全屏覆盖。 */}
        {editorState && (
          <SpeakScenarioEditor
            requestTranslate={requestTranslate}
            onToast={onToast}
            onSaved={onScenarioSaved}
            onClose={() => setEditorState(null)}
            initial={editorState.initial ?? undefined}
          />
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
  const shadowBusy = shadow.phase === "recording" || shadow.phase === "evaluating";
  const hasSpoken = session.turns.some((t) => t.role === "user");

  // 提示条的动作：按失败原因给下一步。「再试一次」按来源走主环或跟读；
  // 凭据缺失去主窗口设置；打不开/没声音的麦克风问题额外给「检查麦克风」。
  const noticeFromRound = roundError !== "";
  const dismissNotice = () => {
    if (noticeFromRound) {
      setRoundError("");
      if (phase === "error") setPhase("idle");
    } else {
      setShadow(SHADOW_IDLE);
    }
  };
  const retryFromNotice = () => {
    dismissNotice();
    if (noticeFromRound) toggleMic();
    else startShadow();
  };
  const noticeActions: NoticeAction[] = [];
  if (notice?.kind === "mic" || notice?.kind === "network") {
    noticeActions.push({ label: "再试一次", onClick: retryFromNotice, primary: true });
  }
  if (notice?.kind === "mic" && onOpenReaderSettings) {
    noticeActions.push({ label: "检查麦克风", onClick: onOpenReaderSettings });
  }
  if (notice?.kind === "credential") {
    noticeActions.push({
      label: "去设置",
      onClick: () => void openSettings().catch(() => undefined),
      primary: true,
    });
  }
  // 额度用尽：「兑换更多额度」→ 设置窗账号 tab 兑换码卡（id=account-redeem，
  // Settings.openAccountRedeem 的跨窗同款，定位走既有 settings_open_tab 通道）。
  if (notice?.kind === "redeem") {
    noticeActions.push({
      label: "兑换更多额度",
      onClick: () => void settingsOpenTab("account").catch(() => undefined),
      primary: true,
    });
  }

  const lastTotal = lastReport ? lastReport.totals[lastReport.totals.length - 1] : null;
  // 有没有可复盘的跟读数据（一次都没跟读过时复盘入口禁用）
  const hasAssessments = session.turns.some(
    (t) => t.role === "assistant" && (t.shadowAttempts?.length ?? 0) > 0,
  );

  return (
    <div className="sonic-studio-grid">
      <div className="sonic-dialogue-well">
        <div className="speak-stage">
          <SpeakSceneBar
            title={sceneTitleOf(session)}
            difficultyLabel={difficultyOf(session.difficulty).label}
            progress={progress}
            listenMode={listenMode}
            onBack={backToHub}
            onToggleListen={toggleListenMode}
          />
          <TargetChips items={targetItems} nextKey={nextKey} onPick={(it) => onToast(it.toast)} />

        <div className="sonic-turns-scroll speak-log" ref={scrollRef}>
          {session.turns.map((t, i) => {
            const isLastAssistant = t.role === "assistant" && i === lastAssistantIdx;
            if (t.role === "assistant") {
              // 听力模式：未揭开的 AI 轮遮原文（答完自动揭/点「看原文」手动揭；
              // 重开的历史会话全部已揭）。遮罩保高度，不引起滚动跳动。
              const veiled = listenMode && !revealedTurns.has(i);
              return (
                <div key={i} className="dialogue-turn">
                  <div className="turn-speaker-line">
                    <span>AI 陪练 · {sc.title}</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
                      <button
                        className="text-action-btn"
                        disabled={busy}
                        onClick={() => speakRound(t.text)}
                        title="重听这句"
                      >
                        <IconVolume size={13} /> 重听
                      </button>
                      {veiled && (
                        <button
                          className="text-action-btn"
                          onClick={() => revealTurn(i)}
                          title="显示这句原文"
                        >
                          <IconEye size={13} /> 看原文
                        </button>
                      )}
                    </span>
                  </div>
                  <div
                    className={`turn-prose-en${veiled ? " listen-veil" : ""}`}
                    aria-hidden={veiled || undefined}
                  >
                    {t.text}
                  </div>
                  {t.hintZh && (
                    <div
                      className={`turn-prose-zh${veiled ? " listen-veil" : ""}`}
                      aria-hidden={veiled || undefined}
                    >
                      {t.hintZh}
                    </div>
                  )}
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
            const hits = analyzeTargets(t.text);
            const isPronTurn = t === lastPronTurn;
            return (
              <div key={i} className="dialogue-turn mine">
                <div className="turn-prose-en speak-user-text">
                  <UserSentence
                    text={t.text}
                    marks={isPronTurn ? pronMarks : []}
                    targetSpans={hits.spans}
                    selected={isPronTurn ? selWord : undefined}
                    onPickMark={isPronTurn ? pickMark : undefined}
                  />
                </div>
                {(t.pron || hits.count > 0) && (
                  <div className="speak-turn-meta">
                    {hits.count > 0 && (
                      <span className="speak-pill hit">
                        <IconCheck size={12} />
                        用上 {hits.count} 个目标词
                      </span>
                    )}
                    {t.pron && (
                      <span className={`speak-pill ${scoreTone(t.pron.total)} tabular`}>
                        发音 {t.pron.total.toFixed(1)} / 5.0
                      </span>
                    )}
                  </div>
                )}
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
              <div className="turn-prose-en" style={{ opacity: 0.7 }}>
                {/* 听力模式下不流式上屏回复原文，避免抢在 TTS 前被看到 */}
                {listenMode ? "…对方回复中…" : liveReply || "…在想你该怎么说…"}
              </div>
            </div>
          )}
          {phase === "asr" && (
            <div className="dialogue-turn mine">
              <div className="turn-speaker-line">…识别你刚才说的…</div>
            </div>
          )}
          {phase === "recording" && <ListeningRow level={level} silenceSec={TALK_SILENCE_MS / 1000} />}
        </div>

        {notice && (
          <SpeakNotice
            message={notice.message}
            detail={notice.detail}
            actions={noticeActions}
            onDismiss={dismissNotice}
          />
        )}

        <div className="speak-composer">
          <div className="speak-composer-side">
            <button
              className="speak-btn"
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
                      ? "再跟读一次"
                      : "跟读这句"}
            </button>
            <button
              className="speak-btn"
              disabled={!shadowTarget || busy}
              onClick={() => shadowTarget && speakRound(shadowTarget)}
              title="重听 AI 这句"
            >
              <IconVolume size={14} /> 重听
            </button>
          </div>

          <div className="speak-mic-wrap">
            <SpeakMic
              recording={phase === "recording"}
              level={level}
              disabled={phase === "asr" || phase === "thinking" || drill !== null || shadowBusy}
              title={micTitle}
              ariaLabel={phase === "recording" ? "说完（点击发送）" : "点击开始说话"}
              onClick={toggleMic}
            />
            <span className="speak-mic-tip">{micTip(phase, { shadowBusy, hasSpoken })}</span>
          </div>

          <div className="speak-composer-side end">
            {phase === "thinking" && (
              <button className="speak-btn" onClick={skipReply}>
                跳过回复
              </button>
            )}
            <button
              className="speak-finish"
              disabled={!hasAssessments}
              title={
                hasAssessments
                  ? "复盘本轮跟读中没掌握的词，确认后加入生词本"
                  : "还没有跟读记录——先「跟读这句」一次再来复盘"
              }
              onClick={() => {
                stopSpeak();
                setDrill(null);
                setReviewOpen(true);
              }}
            >
              结束并复盘 →
            </button>
          </div>
        </div>
      </div>
      </div>

      <PronPanel
        pron={lastPron}
        weakCount={weakCount}
        selWordIdx={pronSel?.wordIdx ?? null}
        selPhoneIdx={pronSel?.phoneIdx ?? null}
        onSelectWord={selectWord}
        onSelectPhone={(idx) => setPronSel((s) => (s ? { ...s, phoneIdx: idx } : s))}
        onSpeakSlow={speakWordSlowly}
        onSpeak={speakWord}
        onOpenSettings={() => void openSettings().catch(() => undefined)}
      />

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
