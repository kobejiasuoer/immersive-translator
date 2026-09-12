import { useRef, useState, type ChangeEvent } from "react";
import type { Article } from "../core/types";
import { DEMO_ARTICLES, makeStressArticle } from "../core/data";
import { toast } from "../store";

/**
 * 书架：演示文章 + 压测文章（S2）+ 文件导入（S5）。
 * 浏览器里导入走 <input type=file>；真机上同一路径（document picker 由 WKWebView file input 唤起）。
 */
export default function ShelfScreen({ onOpenArticle }: { onOpenArticle: (a: Article) => void }) {
  const [stress] = useState(() => makeStressArticle(75));
  const fileRef = useRef<HTMLInputElement>(null);

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const j = JSON.parse(String(r.result));
        const nArticles = Array.isArray(j.articles) ? j.articles.length : 0;
        const nWords = j.vocab?.words?.length ?? 0;
        toast(`解析成功：${nArticles} 篇文章 · ${nWords} 词条（spike：不合并）`);
      } catch (err) {
        toast(`解析失败：${(err as Error).message}`);
      }
    };
    r.readAsText(f);
  }

  return (
    <div className="screen">
      <div className="pagehead">
        <div className="large-title">书架</div>
        <div className="page-sub">spike：S2 性能 / S5 导入</div>
      </div>

      <div className="card" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <div style={{ width: 42, height: 42, borderRadius: 12, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>↑</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14.5, fontWeight: 600 }}>导入同步文件（S5）</div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>选 .json → 解析计数</div>
        </div>
        <button className="btn sm" onClick={() => fileRef.current?.click()}>
          选择文件
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={onFile} />
      </div>

      <div className="sect-label">压测（S2）</div>
      <button className="card" style={{ width: "100%", textAlign: "left", marginBottom: 12 }} onClick={() => onOpenArticle(stress)}>
        <div className="serif-en" style={{ fontSize: 16, fontWeight: 600 }}>
          {stress.title}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>
          {stress.sentences.length} 句全量渲染 · 观察右上角角标（首屏渲染 ms）
        </div>
      </button>

      <div className="sect-label">演示文章</div>
      {DEMO_ARTICLES.map((a) => (
        <button key={a.id} className="card" style={{ width: "100%", textAlign: "left", marginBottom: 12 }} onClick={() => onOpenArticle(a)}>
          <div className="serif-en" style={{ fontSize: 16, fontWeight: 600 }}>
            {a.title}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 2 }}>{a.titleCn} · {a.sentences.length} 句</div>
        </button>
      ))}
    </div>
  );
}
