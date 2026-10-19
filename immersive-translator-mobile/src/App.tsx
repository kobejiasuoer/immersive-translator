/**
 * 应用外壳 —— 5 Tab（§2.1）+ push 栈（§2.2，320ms push/pop）+ 底部 sheet +
 * 应用内通知横幅（60s 无操作自动收起 §3.14）+ 首启 Onboarding + 深链（ita:// 等价 hash）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { actions, flushPersist, getState, reviewStats, rolloverIfDue, toast, useApp } from "./store";
import { Icon } from "./ui/icons";
import { NavCtx, type Nav, type PushName, type PushProps } from "./ui/nav";
import { SheetHost } from "./ui/sheets";
import { haptic, invoke, onDeepLink, readClipboard, registerDiagSink } from "./services/device";
/* 静态导入（非动态 chunk）：诊断模块共享 store/voice 模块，动态 import 会让
   rollup 给入口 chunk 加 export 门面，jsdom 冒烟的 new Function 执行不了 */
import { runTtsSelftest } from "./services/selftest";

import TodayScreen from "./screens/TodayScreen";
import PracticeScreen from "./screens/PracticeScreen";
import ShelfScreen from "./screens/ShelfScreen";
import VocabScreen from "./screens/VocabScreen";
import MeScreen from "./screens/MeScreen";
import ReaderScreen from "./screens/ReaderScreen";
import ReviewScreen from "./screens/ReviewScreen";
import QuickReview from "./screens/QuickReview";
import TranslateScreen from "./screens/TranslateScreen";
import CameraScreen from "./screens/CameraScreen";
import ShadowScreen from "./screens/ShadowScreen";
import CaptionScreen from "./screens/CaptionScreen";
import { SpeakChat, SpeakScenes } from "./screens/SpeakScreens";
import { NotesGen, NotesLib, NoteDetail } from "./screens/NotesScreens";
import { AboutScreen, DiagScreen, GlossaryScreen, HistoryScreen, ShareScreen } from "./screens/MiscScreens";
import { SetLookScreen, SetModelScreen, SetPrefScreen, SetRemindScreen, SetVoiceScreen } from "./screens/SettingsScreens";
import OnboardingScreen from "./screens/OnboardingScreen";
import SpikeScreen from "./screens/SpikeScreen";
import type { Article } from "./core/types";
import type { SpeakSession } from "./core/sessions";

interface Entry {
  id: number;
  name: PushName;
  props: PushProps;
  entered: boolean;
  closing: boolean;
}

const TABS: { key: "today" | "practice" | "shelf" | "vocab" | "me"; label: string; icon: string }[] = [
  { key: "today", label: "今天", icon: "today" },
  { key: "practice", label: "练", icon: "wave" },
  { key: "shelf", label: "书架", icon: "shelf" },
  { key: "vocab", label: "生词", icon: "mark" },
  { key: "me", label: "我的", icon: "me" },
];

export default function App() {
  const tab = useApp((s) => s.tab);
  const st = useApp(reviewStats);
  const onboarded = useApp((s) => s.onboarded);
  const articles = useApp((s) => s.articles);
  const bannerState = useApp((s) => s.banner);
  const rdBlack = useApp((s) => s.reader.topic === "black");

  /* ---------- push 栈 ---------- */
  const stackRef = useRef<Entry[]>([]);
  const [stack, setStack] = useState<Entry[]>([]);
  const idRef = useRef(0);
  /** 600ms 同名防重入（P-54：双击行叠两层复习页）；pop/popAll 清守卫，不误伤「返回后再进」 */
  const lastPushRef = useRef<{ name: PushName; at: number } | null>(null);
  const sync = useCallback(() => setStack([...stackRef.current]), []);

  const nav: Nav = {
    push: (name, props = {}) => {
      const now = Date.now();
      const last = lastPushRef.current;
      if (last && last.name === name && now - last.at < 600) return;
      lastPushRef.current = { name, at: now };
      const entry: Entry = { id: ++idRef.current, name, props, entered: false, closing: false };
      stackRef.current = [...stackRef.current, entry];
      sync();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          entry.entered = true;
          sync();
        }),
      );
      haptic("light");
    },
    pop: () => {
      lastPushRef.current = null;
      const last = stackRef.current[stackRef.current.length - 1];
      if (!last) return;
      last.closing = true;
      sync();
      setTimeout(() => {
        stackRef.current = stackRef.current.filter((e) => e.id !== last.id);
        sync();
      }, 330);
    },
    popAll: () => {
      lastPushRef.current = null;
      if (!stackRef.current.length) return;
      stackRef.current.forEach((e) => (e.closing = true));
      sync();
      const ids = stackRef.current.map((e) => e.id);
      setTimeout(() => {
        stackRef.current = stackRef.current.filter((e) => !ids.includes(e.id));
        sync();
      }, 330);
    },
    replace: (name, props = {}) => {
      const entry: Entry = { id: ++idRef.current, name, props, entered: true, closing: false };
      stackRef.current = [...stackRef.current.slice(0, -1), entry];
      sync();
      haptic("light");
    },
  };

  /* ---------- 深链（#quick / #translate / #vocab / #shelf / #share?text=…；
     ita://share?text=… 经 onDeepLink（iOS 系统分享/浏览器地址栏）；通知深链落点 §3.14） ---------- */
  useEffect(() => {
    const h = window.location.hash.replace(/^#/, "");
    if (h === "quick") nav.push("quick", { fromNotify: true });
    else if (h === "translate") nav.push("translate");
    else if (h === "vocab" || h === "shelf") actions.setTab(h);
    else if (h === "share" || h.startsWith("share?")) {
      const text = new URLSearchParams(h.slice("share".length).replace(/^\?/, "")).get("text");
      actions.setShareIn(text ? { text, source: "hash" } : null);
      nav.push("share");
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
          nav.push("share");
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

  /* ---------- 剪贴板自动检测（demo 12）：回前台（visibilitychange visible / bfcache pageshow）读一次——
     新文本 ≠ 当前 clip.en、长度 8..5000 → setClip(text, "")（zh 空串，点翻译走真实链路）；
     同一文本 60s 节流。iOS 粘贴许可由系统弹窗，拒绝 → readClipboard 返 null 静默。 ---------- */
  useEffect(() => {
    let lastText = "";
    let lastAt = 0;
    let alive = true;
    const check = async () => {
      const text = await readClipboard();
      if (!alive || !text) return;
      const t = text.trim();
      if (t.length < 8 || t.length > 5000) return;
      const now = Date.now();
      if (t === lastText && now - lastAt < 60_000) return;
      if (getState().clip?.en === t) return;
      lastText = t;
      lastAt = now;
      actions.setClip(t, "");
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        /* 回前台先重算跨天/跨周（治 state-2）：iOS 切后台保活跨零点回来，
           clearedToday/week 不能仍是昨日口径；幂等，当天已对齐时无操作 */
        rolloverIfDue();
        void check();
      } else if (document.visibilityState === "hidden") {
        /* 离前台立即落盘（治 state-8）：200ms 防抖定时器在挂起的 WKWebView 里不会跑 */
        flushPersist();
      }
    };
    const onPage = (e: PageTransitionEvent) => {
      if (e.persisted) void check(); /* bfcache 恢复视为回前台；首次加载不读 */
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", onPage);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", onPage);
    };
  }, []);

  /* ---------- 诊断队列（demo 20 数据半）：services 层异常经 registerDiagSink 汇入 store 环形 30 条 ---------- */
  useEffect(() => {
    registerDiagSink((e) => actions.pushDiag(e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- 真机 TTS 自检（ITA_SELFTEST=1 启动门禁；正常使用恒 false 零影响） ---------- */
  useEffect(() => {
    void invoke<boolean>("selftest_active").then((on) => {
      if (on) void runTtsSelftest();
    });
  }, []);

  /* ---------- 切 Tab 收起 push 盖层（P-46：toast「去看看」setTab 后真正离开盖层、落地目标 Tab） ---------- */
  const tabRef = useRef(tab);
  useEffect(() => {
    if (tabRef.current === tab) return;
    tabRef.current = tab;
    if (stackRef.current.length) nav.popAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  /* ---------- 应用内横幅：60s「无操作」自动收起（§3.14 / 评审要点 7③）——
     任意 pointerdown 重置计时，用户持续操作时不干等（P-01 及 P-15/24/49/58 同源） ---------- */
  useEffect(() => {
    if (!bannerState) return;
    let t = setTimeout(() => actions.closeBanner(), 60000);
    const bump = () => {
      clearTimeout(t);
      t = setTimeout(() => actions.closeBanner(), 60000);
    };
    document.addEventListener("pointerdown", bump, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", bump, true);
    };
  }, [bannerState?.at]);

  const bannerShown = useRef(false);
  const bannerDeferred = useRef(false);
  useEffect(() => {
    if (bannerShown.current || !onboarded) return;
    const t = setTimeout(() => {
      if (st.due <= 0) {
        bannerShown.current = true;
        return;
      }
      if (stackRef.current.length) {
        bannerDeferred.current = true; /* push 盖层开着不弹出（P-01），回到底层再补弹 */
        return;
      }
      bannerShown.current = true;
      actions.showBanner();
    }, 8000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarded]);

  /* 被 push 盖层压住的到期提醒：栈清空后补弹一次 */
  useEffect(() => {
    if (!bannerDeferred.current || stack.length) return;
    bannerDeferred.current = false;
    if (st.due > 0 && !bannerState) {
      bannerShown.current = true;
      actions.showBanner();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stack.length]);

  /* ---------- push 内容解析 ---------- */
  function view(e: Entry) {
    const p = e.props;
    switch (e.name) {
      case "reader": {
        const article = (p.article as Article | undefined) || articles.find((a) => a.id === p.articleId);
        return article ? <ReaderScreen article={article} /> : <Missing onBack={nav.pop} />;
      }
      case "review":
        return <ReviewScreen wordId={p.wordId as string | undefined} from={p.from as string | undefined} cards={p.cards as never} />;
      case "quick":
        return <QuickReview wordId={p.wordId as string | undefined} fromNotify={p.fromNotify as boolean | undefined} />;
      case "translate":
        return <TranslateScreen src={p.src as string | undefined} srcText={p.srcText as string | undefined} />;
      case "camera":
        return <CameraScreen />;
      case "scenes":
        return <SpeakScenes />;
      case "chat":
        return <SpeakChat scene={p.scene as string | undefined} resumeSession={p.resumeSession as SpeakSession | undefined} />;
      case "shadow":
        return <ShadowScreen fromArticle={p.fromArticle as string | undefined} sentIdx={p.sentIdx as number | undefined} />;
      case "caption":
        return <CaptionScreen />;
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
      case "about":
        return <AboutScreen />;
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
      case "share":
        return <ShareScreen />;
      case "spike":
        return <SpikeScreen />;
      default:
        return <Missing onBack={nav.pop} />;
    }
  }

  return (
    <NavCtx.Provider value={nav}>
      <div className="app">
        {TABS.map((t) => (
          <div key={t.key} className={`pane ${tab === t.key ? "on" : ""}`}>
            {t.key === "today" && <TodayScreen />}
            {t.key === "practice" && <PracticeScreen />}
            {t.key === "shelf" && <ShelfScreen />}
            {t.key === "vocab" && <VocabScreen />}
            {t.key === "me" && <MeScreen />}
          </div>
        ))}

        <nav className="tabbar">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`tab ${tab === t.key ? "on" : ""}`}
              aria-label={t.label}
              onClick={() => {
                haptic("light");
                actions.setTab(t.key);
              }}
            >
              <Icon name={t.icon} size={25} />
              {t.key === "vocab" && st.due > 0 && <span className="tbadge num">{st.due}</span>}
              <span>{t.label}</span>
            </button>
          ))}
        </nav>

        {/* push 栈（阅读页携带阅读主题作用域 token） */}
        {stack.map((e) => (
          <div
            key={e.id}
            className={`push ${e.entered && !e.closing ? "in" : ""} ${e.closing ? "out" : ""} ${e.name === "reader" && rdBlack ? "rd-black" : ""}`}
          >
            {view(e)}
          </div>
        ))}

        {/* 首启 Onboarding（不可返回，三步后进今天） */}
        {!onboarded && (
          <div className="push in">
            <OnboardingScreen />
          </div>
        )}

        {/* 通知横幅 */}
        {bannerState && (
          <div className="banner on">
            <div className="bt">
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <span className="bico">
                  <Icon name="mark" size={16} />
                </span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{bannerState.title}</div>
                  <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 1 }}>{bannerState.body}</div>
                </div>
              </div>
              <button className="iconbtn" aria-label="关闭" style={{ width: 28, height: 28 }} onClick={() => actions.closeBanner()}>
                <Icon name="close" size={14} />
              </button>
            </div>
            <div className="brow2">
              <button
                className="bbtn"
                onClick={() => {
                  actions.closeBanner();
                  nav.push("quick", { fromNotify: true });
                }}
              >
                先清一张
              </button>
              <button
                className="bbtn later"
                onClick={() => {
                  actions.snoozeBanner();
                  toast("今晚不再提醒 · 角标保留");
                }}
              >
                稍后
              </button>
            </div>
          </div>
        )}

        <SheetHost />
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
