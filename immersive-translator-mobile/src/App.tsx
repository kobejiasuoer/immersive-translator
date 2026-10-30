/**
 * 应用外壳 —— 阅读/口语/笔记与复习三标签 + push 栈 + 底部 sheet +
 * 应用内通知横幅（60s 无操作自动收起 §3.14）+ 首启 Onboarding + 深链（ita:// 等价 hash）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { actions, flushPersist, reviewStats, rolloverIfDue, toast, useApp } from "./store";
import { Icon } from "./ui/icons";
import { NavCtx, useNav, type Nav, type PushName, type PushProps } from "./ui/nav";
import { SheetHost } from "./ui/sheets";
import { haptic, invoke, onDeepLink, registerDiagSink } from "./services/device";
/* 静态导入（非动态 chunk）：诊断模块共享 store/voice 模块，动态 import 会让
   rollup 给入口 chunk 加 export 门面，jsdom 冒烟的 new Function 执行不了 */
import { runTtsSelftest } from "./services/selftest";

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
import GlassNav from "./ui/GlassNav";
import { ReadingHome, SpeakingHome, LearningVault, WordDetail, LearningNote, LearningSearch } from "./screens/LearningHome";
import LearningImport from "./screens/LearningImport";
import { LearningPractice } from "./screens/LearningPractice";
import AccountScreen, { LoginHost } from "./screens/AccountScreen";
import { useLoginIntent } from "./services/authGate";
import type { Article } from "./core/types";
import type { SpeakSession } from "./core/sessions";

interface Entry {
  id: number;
  name: PushName;
  props: PushProps;
  entered: boolean;
  closing: boolean;
}

const TABS = [{ key: "today" }, { key: "practice" }, { key: "vocab" }] as const;

/* push 页名称 → 读屏名称（U-17：.push 根 role=dialog 的 aria-label；与各屏 PNav 标题同口径） */
const PUSH_TITLES: Record<PushName, string> = { learningPractice: "口语练习", account: "账号与设置", learningImport: "加入阅读", learningWord: "表达详情", learningNote: "学习笔记", learningSearch: "搜索",
  reader: "阅读",
  review: "复习",
  quick: "快速复习",
  translate: "翻译",
  camera: "拍译",
  scenes: "口语场景",
  chat: "口语陪练",
  shadow: "跟读",
  caption: "录音直译",
  notes: "生成笔记",
  noteslib: "笔记库",
  notedetail: "笔记详情",
  history: "历史",
  glossary: "生词本",
  diag: "诊断",
  about: "关于",
  setModel: "模型服务",
  setPref: "偏好设置",
  setVoice: "语音服务",
  setRemind: "提醒设置",
  setLook: "外观",
  onboarding: "欢迎使用",
  share: "分享",
};

export default function App() {
  const tab = useApp((s) => s.tab);
  const st = useApp(reviewStats);
  const onboarded = useApp((s) => s.onboarded);
  const articles = useApp((s) => s.articles);
  const bannerState = useApp((s) => s.banner);
  const sheet = useApp((s) => s.sheet);

  /* ---------- push 栈 ---------- */
  const stackRef = useRef<Entry[]>([]);
  const [stack, setStack] = useState<Entry[]>([]);
  const idRef = useRef(0);
  /** 600ms 同名防重入（P-54：双击行叠两层复习页）；pop/popAll 清守卫，不误伤「返回后再进」 */
  const lastPushRef = useRef<{ name: PushName; at: number } | null>(null);
  /** U-17：进栈前抓当前焦点，栈清空后归还（中途 pop 回到上一层时聚焦其标题） */
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const sync = useCallback(() => setStack([...stackRef.current]), []);

  const focusPushTitle = useCallback((id: number) => {
    const el = document.querySelector<HTMLElement>(`.push[data-push-id="${id}"] .ttl`);
    if (el) {
      el.tabIndex = -1;
      el.focus({ preventScroll: true });
    }
  }, []);

  const nav: Nav = {
    push: (name, props = {}) => {
      const now = Date.now();
      const last = lastPushRef.current;
      if (last && last.name === name && now - last.at < 600) return;
      lastPushRef.current = { name, at: now };
      lastFocusRef.current = document.activeElement as HTMLElement | null;
      const entry: Entry = { id: ++idRef.current, name, props, entered: false, closing: false };
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
      lastPushRef.current = null;
      const last = stackRef.current[stackRef.current.length - 1];
      if (!last) return;
      last.closing = true;
      sync();
      setTimeout(() => {
        stackRef.current = stackRef.current.filter((e) => e.id !== last.id);
        sync();
        /* U-17：出栈归还焦点——还有上层则聚焦其标题，栈空则还原进栈前位置 */
        const top = stackRef.current[stackRef.current.length - 1];
        if (top) focusPushTitle(top.id);
        else lastFocusRef.current?.focus?.();
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
        lastFocusRef.current?.focus?.();
      }, 330);
    },
    replace: (name, props = {}) => {
      /* U-32：replace 与 push 同款入场（entered:false + 双 rAF），新屏 320ms 滑入、旧屏即刻卸载露 tab 层 */
      const entry: Entry = { id: ++idRef.current, name, props, entered: false, closing: false };
      stackRef.current = [...stackRef.current.slice(0, -1), entry];
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
  };

  /* ---------- 深链（#quick / #translate / #vocab / #shelf / #share?text=…；
     ita://share?text=… 经 onDeepLink（iOS 系统分享/浏览器地址栏）；通知深链落点 §3.14） ---------- */
  useEffect(() => {
    const h = window.location.hash.replace(/^#/, "");
    if (h === "quick") nav.push("quick", { fromNotify: true });
    else if (h === "translate") nav.push("translate");
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

  /* ---------- 应用内横幅：进出场动画与 60s 自动收起都由 BannerHost 承担（U-05/§3.14） ---------- */
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
      case "learningPractice": return <LearningPractice taskId={String(p.taskId)} />;
      case "account": return <AccountScreen />;
      case "learningImport": return <LearningImport />;
      case "learningWord": return <WordDetail id={String(p.id)} />;
      case "learningNote": return <LearningNote id={p.id as string | undefined} />;
      case "learningSearch": return <LearningSearch />;
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
      default:
        return <Missing onBack={nav.pop} />;
    }
  }

  /* U-17：任一模态层（push/sheet/首启）打开时，底层 pane 与 tabbar 一律 inert——
     读屏与点按都无法穿层（sheet 与 push 共用这一套机制） */
  const loginIntent = useLoginIntent();
  const overlayOpen = stack.length > 0 || !!sheet || !onboarded || !!loginIntent;

  return (
    <NavCtx.Provider value={nav}>
      <div className="app">
        {TABS.map((t) => (
          <div key={t.key} className={`pane ${tab === t.key ? "on" : ""}`} inert={overlayOpen || undefined}>
            {t.key === "today" && <ReadingHome />}
            {t.key === "practice" && <SpeakingHome />}
            {t.key === "vocab" && <LearningVault />}
          </div>
        ))}

        <GlassNav hidden={stack.length > 0} inert={overlayOpen} />
        <LoginHost />

        {/* U-37：push 存在期间底层压暗 + tab 栏视差左移，「盖纸」变「推入」 */}
        <div className={`push-scrim ${stack.length > 0 ? "on" : ""}`} />

        {/* push 栈（U-17：dialog 语义；U-07：阅读主题作用域已收敛进 ReaderScreen 正文容器） */}
        {stack.map((e, i) => (
          <div
            key={e.id}
            data-push-id={e.id}
            role="dialog"
            aria-modal="true"
            aria-label={PUSH_TITLES[e.name]}
            className={`push ${e.entered && !e.closing ? "in" : ""} ${e.closing ? "out" : ""}`}
            inert={!!loginIntent || !!sheet || i < stack.length - 1 || undefined}
          >
            {view(e)}
          </div>
        ))}

        {/* 首启 Onboarding（不可返回，三步后进今天） */}
        {!onboarded && (
          <div className="push in" role="dialog" aria-modal="true" aria-label="欢迎使用">
            <OnboardingScreen />
          </div>
        )}

        {/* 通知横幅（U-05：进出场 400ms） */}
        {!loginIntent && <BannerHost />}

        <SheetHost inert={!!loginIntent} />
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

/* 通知横幅（U-05，规格「顶部弹入 400ms」）：挂载先无 .on、双 rAF 后加类播滑入；
   所有关闭路径（手动/稍后/60s 无操作）先摘 .on 播 400ms 收起，420ms 后再清 store——
   「先清一张」的 320ms push 与收起并行。60s「无操作」计时也在这里（任意 pointerdown 重置，§3.14）。 */
function BannerHost() {
  const banner = useApp((s) => s.banner);
  const nav = useNav();
  const [shown, setShown] = useState(false);
  const [closing, setClosing] = useState(false);
  const busyRef = useRef(false);
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!banner) return;
    busyRef.current = false;
    setClosing(false);
    setShown(false);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    return () => cancelAnimationFrame(raf);
  }, [banner?.at]);

  /* 出现后「先清一张」成为第一顺序焦点（U-29：读屏用户可直接激活主动作） */
  useEffect(() => {
    if (banner && shown && !closing) primaryRef.current?.focus({ preventScroll: true });
  }, [banner?.at, shown, closing]);

  const close = useCallback((after?: () => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setClosing(true);
    setTimeout(() => {
      after?.();
      actions.closeBanner();
    }, 420);
  }, []);

  useEffect(() => {
    if (!banner || closing) return;
    let t = setTimeout(() => close(), 60000);
    const bump = () => {
      clearTimeout(t);
      t = setTimeout(() => close(), 60000);
    };
    document.addEventListener("pointerdown", bump, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", bump, true);
    };
  }, [banner?.at, closing, close]);

  if (!banner) return null;
  return (
    <div className={`banner ${shown && !closing ? "on" : ""}`} role="alert">
      <div className="bt">
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="bico">
            <Icon name="mark" size={16} />
          </span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{banner.title}</div>
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 1 }}>{banner.body}</div>
          </div>
        </div>
        {/* U-08：去 28×28 覆写恢复 .iconbtn 44 默认，负 margin 抵消行高位移 */}
        <button className="iconbtn" aria-label="关闭" style={{ margin: "-8px" }} onClick={() => close()}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="brow2">
        <button
          ref={primaryRef}
          className="bbtn"
          onClick={() => {
            close();
            nav.push("quick", { fromNotify: true });
          }}
        >
          先清一张
        </button>
        <button
          className="bbtn later"
          onClick={() =>
            close(() => {
              actions.snoozeBanner();
              toast("今晚不再提醒 · 角标保留");
            })
          }
        >
          稍后
        </button>
      </div>
    </div>
  );
}
