import { useApp } from "../store";
import type { Article } from "../core/types";

export default function TodayScreen({ onStartReview, onOpenArticle }: { onStartReview: () => void; onOpenArticle: (a: Article) => void }) {
  const vocab = useApp((s) => s.vocab);
  const articles = useApp((s) => s.articles);
  const due = vocab.filter((v) => v.dueAt <= Date.now());
  const dueW = due.filter((v) => v.kind !== "chunk").length;
  const resume = articles[0];

  return (
    <div className="screen">
      <div className="pagehead">
        <div className="large-title">今天</div>
        <div className="page-sub">spike 工程 · 数据为演示数据，不落盘</div>
      </div>
      <div className="card">
        <div style={{ fontFamily: '"Source Serif 4",Georgia,serif', fontSize: 72, fontWeight: 600, lineHeight: 0.95 }}>
          {due.length}
          <small style={{ fontSize: 22, color: "var(--text-3)", fontWeight: 400, marginLeft: 6 }}>待复习</small>
        </div>
        <div style={{ marginTop: 8, fontSize: 13, color: "var(--text-2)" }}>
          单词 {dueW} · 词块 {due.length - dueW}
        </div>
        <div style={{ height: 14 }} />
        <button className="btn" onClick={onStartReview}>
          开始复习
        </button>
      </div>

      <div className="sect-label">继续阅读</div>
      <button className="card" style={{ width: "100%", textAlign: "left" }} onClick={() => resume && onOpenArticle(resume)}>
        <div className="serif-en" style={{ fontSize: 16, fontWeight: 600 }}>
          {resume?.title}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>
          {resume?.sentences.length} 句 · 63%
        </div>
        <div style={{ height: 4, borderRadius: 2, background: "var(--border)", marginTop: 8 }}>
          <div style={{ height: "100%", width: "63%", background: "var(--accent)", borderRadius: 2 }} />
        </div>
      </button>
    </div>
  );
}
