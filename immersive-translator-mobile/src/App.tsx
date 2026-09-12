import { useState } from "react";
import { useApp, actions } from "./store";
import TodayScreen from "./screens/TodayScreen";
import VocabScreen from "./screens/VocabScreen";
import ShelfScreen from "./screens/ShelfScreen";
import MeScreen from "./screens/MeScreen";
import ReaderScreen from "./screens/ReaderScreen";
import ReviewScreen from "./screens/ReviewScreen";
import type { Article } from "./core/types";

type Tab = "today" | "vocab" | "shelf" | "me";

const ICONS: Record<Tab, string> = {
  today: `<path d="M13 2 4.8 13.2h5.7L9.3 22l8.9-11.2h-5.7z"/>`,
  vocab: `<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21z"/><path d="M4 18.5V21"/><path d="M9 7.5h7"/>`,
  shelf: `<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13.5 9 5 9-5"/>`,
  me: `<circle cx="12" cy="8" r="3.6"/><path d="M5 20c1.4-3.4 3.9-5 7-5s5.6 1.6 7 5"/>`,
};

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("today");
  const [reader, setReader] = useState<Article | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const sheet = useApp((s) => s.sheet);
  const vocab = useApp((s) => s.vocab);
  const dueN = vocab.filter((v) => v.dueAt <= Date.now()).length;

  return (
    <div className="app">
      {reviewing ? (
        <ReviewScreen onExit={() => setReviewing(false)} />
      ) : (
        <>
          <div className={activeTab === "today" ? "" : "hidden"}>
            <TodayScreen onStartReview={() => setReviewing(true)} onOpenArticle={(a) => setReader(a)} />
          </div>
          <div className={activeTab === "vocab" ? "" : "hidden"}>
            <VocabScreen />
          </div>
          <div className={activeTab === "shelf" ? "" : "hidden"}>
            <ShelfScreen onOpenArticle={(a) => setReader(a)} />
          </div>
          <div className={activeTab === "me" ? "" : "hidden"}>
            <MeScreen />
          </div>

          <nav className="tabbar">
            {(Object.keys(ICONS) as Tab[]).map((t) => (
              <button key={t} className={`tab ${activeTab === t ? "on" : ""}`} onClick={() => setActiveTab(t)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: ICONS[t] }} />
                <span>{({ today: "今天", vocab: "生词", shelf: "书架", me: "我的" } as Record<Tab, string>)[t]}</span>
                {t === "vocab" && dueN > 0 && <span className="tbadge">{dueN}</span>}
              </button>
            ))}
          </nav>
        </>
      )}

      {reader && <ReaderScreen article={reader} onClose={() => setReader(null)} />}

      {sheet && (
        <>
          <div className="dim" onClick={() => actions.setSheet(null)} />
          <div className="sheet">
            <div className="grabber" />
            <div className="d-head">
              <span className="w serif-en">{sheet.word}</span>
              {sheet.chunkType ? <span className="badge">{sheet.chunkType}</span> : <span className="badge">单词</span>}
              <button className="icon-btn" onClick={() => console.log("speak", sheet.word)}>
                🔊
              </button>
            </div>
            <div className="d-senses">
              {sheet.senses.map((s, i) => (
                <div key={i}>
                  <i style={{ color: "var(--text-3)", marginRight: 5 }}>{s.pos}</i>
                  {s.cn}
                </div>
              ))}
            </div>
            {sheet.pattern && (
              <div style={{ marginTop: 10, fontSize: 13, color: "var(--text-2)" }}>
                槽位记法：<i className="serif-en">{sheet.pattern}</i>
              </div>
            )}
            {sheet.trap && (
              <div className="d-trap">
                ⚠ <b>直译陷阱</b>：{sheet.trap}
              </div>
            )}
            {sheet.sentence && (
              <div style={{ marginTop: 12, borderLeft: "2px solid var(--border-strong)", padding: "8px 12px", fontSize: 13, color: "var(--text-2)" }} className="serif-en">
                {sheet.sentence}
              </div>
            )}
            <div className="d-actions">
              {sheet.saved ? (
                <button className="btn ghost" disabled style={{ color: "var(--ok)", borderColor: "transparent", background: "var(--ok-soft)" }}>
                  ✓ 已在生词本
                </button>
              ) : (
                <>
                  <button className="btn" onClick={() => actions.saveWord(sheet, "word")}>
                    收进生词本
                  </button>
                  <button className="btn ghost" onClick={() => actions.saveWord(sheet, "chunk")}>
                    收为词块
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
