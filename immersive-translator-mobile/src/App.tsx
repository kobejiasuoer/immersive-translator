/**
 * 应用外壳 —— 阅读/口语/笔记与复习三标签 + push 栈 + 底部 sheet +
 * 系统学习提醒 + 首启 Onboarding + 深链（ita:// 等价 hash）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { actions, getState, profileIdentity, flushPersist, rolloverIfDue, toast, useApp } from "./store";
import { NavCtx, type Nav, type PushName, type PushProps } from "./ui/nav";
import { attachEdgeBack } from "./ui/edgeBack";
import { SheetHost } from "./ui/sheets";
import { haptic, invoke, onDeepLink, registerDiagSink } from "./services/device";
/* 静态导入（非动态 chunk）：诊断模块共享 store/voice 模块，动态 import 会让
   rollup 给入口 chunk 加 export 门面，jsdom 冒烟的 new Function 执行不了 */
import { cloudState } from "./services/cloud";
import { runTtsSelftest } from "./services/selftest";

import ReaderScreen from "./screens/ReaderScreen";
import ReviewScreen from "./screens/ReviewScreen";
import QuickReview from "./screens/QuickReview";
import { NotesGen, NotesLib, NoteDetail } from "./screens/NotesScreens";
import { DiagScreen, GlossaryScreen, HistoryScreen } from "./screens/MiscScreens";
import { SetLookScreen, SetModelScreen, SetPrefScreen, SetRemindScreen, SetVoiceScreen } from "./screens/SettingsScreens";
import OnboardingScreen from "./screens/OnboardingScreen";
import GlassNav from "./ui/GlassNav";
import { ReadingHome, SpeakingHome, LearningVault, WordDetail, LearningNote, LearningSearch, WordbookScreen } from "./screens/LearningHome";
import LearningImport from "./screens/LearningImport";
import { LearningLibrary, LearningFeeds } from "./screens/LearningDiscover";
import { LearningPractice } from "./screens/LearningPractice";
import AccountScreen, { LoginHost } from "./screens/AccountScreen";
import GoalSheetHost from "./components/account/GoalSheet";
import { useGoalSource } from "./components/account/goalGate";
import { useAccountOpen } from "./components/account/accountGate";
import { useLoginIntent } from "./services/authGate";
import type { Article } from "./core/types";
import { acknowledgeNotificationAction, reconcileStudyNotifications, takeNotificationAction, type NotificationAction } from "./services/studyNotifications";

interface Entry {
  id: number;
  owner: string;
  name: PushName;
  props: PushProps;
  entered: boolean;
  closing: boolean;
}

/** App Group 交接队列项（lib.rs share_handoff::ShareQueueItem 的 JSON 形状，receivedAt 毫秒） */
interface ShareQueueItem {
  id: string;
  kind: "text" | "url";
  text: string;
  receivedAt: number;
}

const TABS = [{ key: "today" }, { key: "practice" }, { key: "vocab" }] as const;

/* push 页名称 → 读屏名称（U-17：.push 根 role=dialog 的 aria-label；与各屏 PNav 标题同口径；
   account 已撤出 push 栈——原型 SHEETS.account 为底部抽屉，由 AccountScreen+accountGate 承担） */
const PUSH_TITLES: Record<PushName, string> = { learningPractice: "口语练习", learningImport: "导入自己的内容", learningWord: "表达详情", learningNote: "学习笔记", learningSearch: "搜索",
  learningLibrary: "精选经典书库", learningFeeds: "英文资讯订阅", learningWordbook: "生词本",
  reader: "阅读",
  review: "复习",
  quick: "快速复习",
  notes: "生成笔记",
  noteslib: "笔记库",
  notedetail: "笔记详情",
  history: "历史",
  glossary: "生词本",
  diag: "诊断",
  setModel: "账号服务",
  setPref: "偏好设置",
  setVoice: "语音与朗读",
  setRemind: "提醒设置",
  setLook: "外观",
  onboarding: "欢迎使用",
};

export default function App() {
  useEffect(() => {
    const app = document.querySelector<HTMLElement>(".app");
    return app ? attachEdgeBack(app) : undefined;
  }, []);
  const tab = useApp((s) => s.tab);
  const onboarded = useApp((s) => s.onboarded);
  const articles = useApp((s) => s.articles);
  const reminderSettings = useApp((s) => s.settings);
  const reminderWords = useApp((s) => s.vocab);
  const [notificationAction, setNotificationAction] = useState<NotificationAction | null>(null);
  const handledNotification = useRef<string | null>(null);
  const sheet = useApp((s) => s.sheet);
  const loginIntent = useLoginIntent();
  const accountOpen = useAccountOpen();

  /* ---------- push 栈 ---------- */
  const stackRef = useRef<Entry[]>([]);
  const [entries, setStack] = useState<Entry[]>([]);
  const previousProfile = useRef(profileIdentity());
  const [profileScope, setProfileScope] = useState(profileIdentity());
  const navigationEpoch = useRef(0);
  const stack = entries.filter(entry => entry.owner === tab);
  const idRef = useRef(0);
  /** 600ms 同名防重入（P-54：双击行叠两层复习页）；pop/popAll 清守卫，不误伤「返回后再进」 */
  const lastPushRef = useRef<{ name: PushName; at: number } | null>(null);
  /** U-17：进栈前抓当前焦点，栈清空后归还（中途 pop 回到上一层时聚焦其标题） */
  const lastFocusRef = useRef<Record<string, HTMLElement | null>>({});
  /* mobile-push-change：push 栈变化广播（tab 层页面据此刷新「继续上次复习」等跨页状态） */
  const sync = useCallback(() => {
    setStack([...stackRef.current]);
    window.dispatchEvent(new Event("mobile-push-change"));
  }, []);

  const focusPushTitle = useCallback((id: number) => {
    const el = document.querySelector<HTMLElement>(`.push[data-push-id="${id}"] .ttl, .push[data-push-id="${id}"] .nt h1`);
    if (el && !el.closest(".tab-inactive")) {
      el.tabIndex = -1;
      el.focus({ preventScroll: true });
    }
  }, []);

  const createNav = (owner: string, active = owner === tab): Nav => {
    const epoch = navigationEpoch.current;
    return ({
    active,
    push: (name, props = {}) => {
      if (epoch !== navigationEpoch.current) return;
      const now = Date.now();
      const last = lastPushRef.current;
      if (last && last.name === name && now - last.at < 600) return;
      lastPushRef.current = { name, at: now };
      if (!stackRef.current.some(entry => entry.owner === owner)) lastFocusRef.current[owner] = document.activeElement as HTMLElement | null;
      const entry: Entry = { id: ++idRef.current, owner, name, props, entered: false, closing: false };
      stackRef.current = [...stackRef.current, entry];
      sync();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          entry.entered = true;
          sync();
          focusPushTitle(entry.id);
        }),
      );
      haptic("light");
    },
    pop: () => {
      if (epoch !== navigationEpoch.current) return;
      lastPushRef.current = null;
      const last = stackRef.current.filter(entry => entry.owner === owner).at(-1);
      if (!last) return;
      last.closing = true;
      sync();
      setTimeout(() => {
        stackRef.current = stackRef.current.filter((e) => e.id !== last.id);
        sync();
        /* U-17：出栈归还焦点——还有上层则聚焦其标题，栈空则还原进栈前位置 */
        if (getState().tab !== owner) return;
        const top = stackRef.current.filter(entry => entry.owner === owner).at(-1);
        if (top) focusPushTitle(top.id);
        else lastFocusRef.current[owner]?.focus?.();
      }, 350); /* >.push 340ms 出场过渡，动画收尾后再卸载 */
    },
    popAll: () => {
      if (epoch !== navigationEpoch.current) return;
      lastPushRef.current = null;
      const current = stackRef.current.filter(entry => entry.owner === owner);
      if (!current.length) return;
      current.forEach((e) => (e.closing = true));
      sync();
      const ids = current.map((e) => e.id);
      setTimeout(() => {
        stackRef.current = stackRef.current.filter((e) => !ids.includes(e.id));
        sync();
        if (getState().tab === owner) lastFocusRef.current[owner]?.focus?.();
      }, 350);
    },
    replace: (name, props = {}) => {
      if (epoch !== navigationEpoch.current) return;
      /* U-32：replace 与 push 同款入场（entered:false + 双 rAF），新屏 320ms 滑入、旧屏即刻卸载露 tab 层 */
      const entry: Entry = { id: ++idRef.current, owner, name, props, entered: false, closing: false };
      const previous = stackRef.current.filter(item => item.owner === entry.owner).at(-1);
      stackRef.current = [...stackRef.current.filter(item => item.id !== previous?.id), entry];
      sync();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          entry.entered = true;
          sync();
          focusPushTitle(entry.id);
        }),
      );
      haptic("light");
    },
  }); };
  const nav = createNav(tab);

  // Paper colour belongs to the reader; it must not override system/app appearance.
  const theme = useApp((s) => s.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  /* ---------- 深链（#quick / #vocab / #shelf / #share?text=…；
     ita://share?text=… 经 onDeepLink（iOS 系统分享/浏览器地址栏）；通知深链落点 §3.14） ---------- */
  useEffect(() => {
    const h = window.location.hash.replace(/^#/, "");
    if (h === "quick") nav.push("quick", { fromNotify: true });
    else if (h === "vocab" || h === "shelf") actions.setTab(h === "shelf" ? "today" : "vocab");
    else if (h === "share" || h.startsWith("share?")) {
      const text = new URLSearchParams(h.slice("share".length).replace(/^\?/, "")).get("text");
      actions.setShareIn(text ? { text, source: "hash" } : null);
      nav.push("learningImport");
    }
    if (h) history.replaceState(null, "", location.pathname + location.search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- 系统深链（ita://scheme）：目前承接 share，其余 scheme 忽略 ---------- */
  useEffect(() => {
    const off = onDeepLink((url) => {
      try {
        const u = new URL(url);
        if (u.protocol === "ita:" && u.host === "share") {
          const text = u.searchParams.get("text");
          actions.setShareIn(text ? { text, source: "safari" } : null);
          nav.push("learningImport");
        }
      } catch {
        /* 非法深链静默忽略 */
      }
    });
    return () => {
      if (typeof off === "function") off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Safari 入站分享交接队列（gen/apple ShareExtension 写入 → 此处消费）：
     读 App Group 队列最旧一条，推入既有 learningImport 预览确认流。确认保存后由
     LearningImport 内 share_queue_ack 收尾；返回拒绝则 share_queue_clear + toast。
     恰好一次由「内容寻址 article id（正文哈希）+ ack 删除队列项」共同保证：确认前
     进程被杀则队列项保留，下次启动重新进预览，重复确认也不会产生重复文章。
     消费时机 = 启动 + 回前台（share 时 App 已运行、被系统挂起的场景）；
     队列不可用/为空静默返回，绝不阻塞启动。 ---------- */
  const consumeShareQueue = useCallback(async () => {
    if (!onboarded) return; /* 首启引导未完成不插队 */
    if (loginIntent) return; /* 登录浮层打开时不插队 */
    if (accountOpen) return; /* 账号抽屉打开时不插队（推入页会落在抽屉之下不可见） */
    if (stackRef.current.some(entry => entry.owner === getState().tab)) return; /* 当前区域已有盖层不叠加 */
    const items = await invoke<ShareQueueItem[]>("share_queue_read");
    const item = items?.[0];
    if (!item) return;
    actions.setShareIn({ text: item.text, source: "safari-share" });
    nav.push("learningImport", { shareQueueId: item.id });
  }, [onboarded, loginIntent, accountOpen]);
  useEffect(() => {
    void consumeShareQueue();
  }, [consumeShareQueue]);
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") void consumeShareQueue();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [consumeShareQueue]);

  /* ---------- 剪贴板自动检测（demo 12）：回前台（visibilitychange visible / bfcache pageshow）读一次——
     新文本 ≠ 当前 clip.en、长度 8..5000 → setClip(text, "")（zh 空串，点翻译走真实链路）；
     同一文本 60s 节流。iOS 粘贴许可由系统弹窗，拒绝 → readClipboard 返 null 静默。 ---------- */
  useEffect(() => {
    const onVis = () => { if(document.visibilityState === "visible") rolloverIfDue(); else void flushPersist().catch(error => toast(String(error))); };
    document.addEventListener("visibilitychange",onVis);
    return () => document.removeEventListener("visibilitychange",onVis);
  },[]);

  /* ---------- 诊断队列（demo 20 数据半）：services 层异常经 registerDiagSink 汇入 store 环形 30 条 ---------- */
  useEffect(() => {
    registerDiagSink((e) => actions.pushDiag(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- 真机 TTS 自检（ITA_SELFTEST=1 启动门禁；正常使用恒 false 零影响） ---------- */
  useEffect(() => {
    void invoke<"playback" | "recording" | null>("selftest_mode").then((mode) => {
      if (mode) void runTtsSelftest(mode);
    });
  }, []);

  // A profile switch must discard every section's mounted local state and article props.
  useEffect(() => {
    const clear = () => {
      const next = profileIdentity();
      // A user-triggered guest login deliberately resumes the protected operation.
      const continueGuestLogin = previousProfile.current === "guest" && next === cloudState().account?.id && !!loginIntent;
      stackRef.current = continueGuestLogin ? stackRef.current.filter(entry => entry.owner === getState().tab) : [];
      if (!continueGuestLogin) navigationEpoch.current++;
      previousProfile.current = next; setProfileScope(next);
      lastPushRef.current = null; lastFocusRef.current = {}; sync();
    };
    window.addEventListener("mobile-profile-change", clear);
    return () => window.removeEventListener("mobile-profile-change", clear);
  }, [sync, loginIntent]);

  // Keep each section's mounted navigation tree and local form/scroll state.
  useEffect(() => {
    lastPushRef.current = null;
    const top = stackRef.current.filter(entry => entry.owner === tab).at(-1);
    if (top) requestAnimationFrame(() => focusPushTitle(top.id));
  }, [tab, focusPushTitle]);

  /* OS-owned reminders are restored after hydration and refreshed on foreground.
     Startup never requests permission; the reminder switch owns that request. */
  useEffect(() => {
    // A newly selected profile may not be onboarded yet. It must still cancel
    // schedules inherited from the previous profile, without requesting permission.
    const reconcile = () => void reconcileStudyNotifications(
      onboarded ? reminderSettings : { ...reminderSettings, daily: false },
      onboarded ? reminderWords : [],
    );
    reconcile();
    const visible = () => { if (document.visibilityState === "visible") reconcile(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [onboarded, reminderSettings.daily, reminderSettings.remindTime, reminderSettings.dnd, reminderWords]);

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const consume = async () => {
      const action = await takeNotificationAction();
      if (action && !disposed && handledNotification.current !== `${action.id}:${action.at}`) setNotificationAction(action);
    };
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      void consume();
      if (retry) clearTimeout(retry);
      retry = setTimeout(() => void consume(), 700);
    };
    visible();
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; if (retry) clearTimeout(retry); document.removeEventListener("visibilitychange", visible); };
  }, []);

  /* ---------- push 内容解析 ---------- */
  function view(e: Entry) {
    const p = e.props;
    switch (e.name) {
      case "learningPractice": return <LearningPractice taskId={String(p.taskId)} />;
      case "learningImport": return <LearningImport shareQueueId={p.shareQueueId as string | undefined} />;
      case "learningWord": return <WordDetail id={String(p.id)} />;
      case "learningNote": return <LearningNote id={p.id as string | undefined} />;
      case "learningSearch": return <LearningSearch />;
      case "learningLibrary": return <LearningLibrary />;
      case "learningFeeds": return <LearningFeeds />;
      case "learningWordbook": return <WordbookScreen />;
      case "reader": {
        const article = (p.article as Article | undefined) || articles.find((a) => a.id === p.articleId);
        return article ? <ReaderScreen article={article} /> : <Missing onBack={nav.pop} />;
      }
      case "review":
        return <ReviewScreen wordId={p.wordId as string | undefined} from={p.from as string | undefined} cards={p.cards as never} mode={p.mode as "cloze" | "listen" | "speak" | undefined} />;
      case "quick":
        return <QuickReview wordId={p.wordId as string | undefined} fromNotify={p.fromNotify as boolean | undefined} />;
      case "notes":
        return <NotesGen />;
      case "noteslib":
        return <NotesLib />;
      case "notedetail":
        return <NoteDetail id={p.id as string | undefined} />;
      case "history":
        return <HistoryScreen />;
      case "glossary":
        return <GlossaryScreen />;
      case "diag":
        return <DiagScreen />;
      case "setModel":
        return <SetModelScreen />;
      case "setPref":
        return <SetPrefScreen />;
      case "setVoice":
        return <SetVoiceScreen />;
      case "setRemind":
        return <SetRemindScreen />;
      case "setLook":
        return <SetLookScreen />;
      case "onboarding":
        return <OnboardingScreen />;
      default:
        return <Missing onBack={nav.pop} />;
    }
  }

  /* U-17：任一模态层（push/sheet/首启/登录/学习方向页/账号抽屉）打开时，底层 pane 与 tabbar 一律 inert——
     读屏与点按都无法穿层（sheet 与 push 共用这一套机制） */
  const goalOpen = useGoalSource();
  useEffect(() => {
    if (!notificationAction || !onboarded || loginIntent || accountOpen || goalOpen) return;
    const key = `${notificationAction.id}:${notificationAction.at}`;
    if (handledNotification.current === key) return;
    handledNotification.current = key;
    setNotificationAction(null);
    actions.setSheet(null);
    nav.popAll();
    if (reminderWords.some(word => !word.paused && word.dueAt <= Date.now())) nav.push("quick", { fromNotify: true });
    else nav.push("learningWordbook");
    void acknowledgeNotificationAction(notificationAction);
    // The navigation owner is imperative; stack rerenders must not replay the tap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notificationAction, onboarded, loginIntent, accountOpen, goalOpen]);
  const modalOpen = !!sheet || !onboarded || !!loginIntent || !!goalOpen || accountOpen;
  const overlayOpen = stack.length > 0 || modalOpen;
  const immersiveViews: PushName[] = ["reader", "learningPractice", "review", "quick", "onboarding"];
  const focusedFlow = stack.some(entry => immersiveViews.includes(entry.name));

  return (
    <NavCtx.Provider value={nav}>
      <div className="app">
        {TABS.map((t) => (
          <div key={`${profileScope}-${t.key}`} className={`pane ${tab === t.key ? "on" : ""}`} inert={overlayOpen || undefined}>
            <NavCtx.Provider value={createNav(t.key, t.key === tab && stack.length === 0)}>
            {t.key === "today" && <ReadingHome />}
            {t.key === "practice" && <SpeakingHome />}
            {t.key === "vocab" && <LearningVault />}
            </NavCtx.Provider>
          </div>
        ))}

        <GlassNav hidden={focusedFlow} inert={modalOpen || focusedFlow} />
        <LoginHost />
        {/* 账号抽屉（原型 SHEETS.account：根页页头圆章/本地保存行/阅读页「登录同步」呼出） */}
        <AccountScreen />
        {/* 学习方向页（首启完成 / 新账号登录后推入；账号抽屉「学习方向」行呼出，盖在抽屉上） */}
        <GoalSheetHost />

        {/* U-37：push 存在期间底层压暗 + tab 栏视差左移，「盖纸」变「推入」 */}
        <div className={`push-scrim ${stack.length > 0 ? "on" : ""}`} />

        {/* push 栈（U-17：dialog 语义；U-07：阅读主题作用域已收敛进 ReaderScreen 正文容器） */}
        {entries.map((e) => (
          <div
            key={e.id}
            data-push-id={e.id}
            role={focusedFlow ? "dialog" : "region"}
            aria-modal={focusedFlow && e.owner === tab ? true : undefined}
            aria-label={PUSH_TITLES[e.name]}
            className={`push ${e.entered && !e.closing ? "in" : ""} ${e.closing ? "out" : ""} ${e.owner !== tab ? "tab-inactive" : ""} ${!focusedFlow ? "with-tabbar" : ""}`}
            data-view={e.name} /* 阅读页整页 surface 等视图级令牌挂在 push 根（原型 .view.reading 的对位） */
            inert={modalOpen || e.owner !== tab || e.id !== stack.at(-1)?.id || undefined}
          >
            <NavCtx.Provider value={createNav(e.owner, e.owner === tab && e.id === stack.at(-1)?.id)}>{view(e)}</NavCtx.Provider>
          </div>
        ))}

        {/* 首启 Onboarding（不可返回，三步后进今天） */}
        {!onboarded && (
          <div className="push in" role="dialog" aria-modal="true" aria-label="欢迎使用">
            <OnboardingScreen />
          </div>
        )}
        <SheetHost inert={(!!loginIntent || !!goalOpen) || undefined} />
      </div>
    </NavCtx.Provider>
  );
}

function Missing({ onBack }: { onBack: () => void }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14 }}>
      <div className="serif" style={{ fontSize: 20, fontWeight: 600 }}>
        内容不见了
      </div>
      <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)", maxWidth: 200 }} onClick={onBack}>
        返回
      </button>
    </div>
  );
}
