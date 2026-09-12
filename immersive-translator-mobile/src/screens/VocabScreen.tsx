import { useMemo, useState } from "react";
import { useApp, actions } from "../store";
import { norm } from "../core/judge";

export default function VocabScreen() {
  const vocab = useApp((s) => s.vocab);
  const [kind, setKind] = useState<"word" | "chunk">("chunk");
  const [q, setQ] = useState("");

  const list = useMemo(() => {
    let l = vocab.filter((v) => (v.kind || "word") === kind);
    if (q) l = l.filter((v) => norm(v.word).includes(norm(q)));
    return l;
  }, [vocab, kind, q]);

  const countOf = (k: "word" | "chunk") => vocab.filter((v) => (v.kind || "word") === k).length;
  const now = Date.now();

  return (
    <div className="screen">
      <div className="pagehead">
        <div className="large-title">生词本</div>
        <div className="page-sub">演示数据 · spike 不落盘</div>
      </div>
      <div style={{ display: "flex", gap: 2, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 11, padding: 2 }}>
        {(["word", "chunk"] as const).map((k) => (
          <button
            key={k}
            style={{
              flex: 1,
              height: 32,
              border: "none",
              borderRadius: 9,
              background: kind === k ? "var(--surface)" : "transparent",
              boxShadow: kind === k ? "var(--shadow-card)" : "none",
              fontWeight: kind === k ? 600 : 400,
              fontSize: 13,
            }}
            onClick={() => setKind(k)}
          >
            {k === "word" ? "单词" : "词块"} {countOf(k)}
          </button>
        ))}
      </div>
      <div style={{ height: 10 }} />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索单词或词块"
        style={{ width: "100%", height: 38, borderRadius: 11, border: "1px solid var(--border)", background: "var(--surface-2)", padding: "0 12px", fontSize: 15, outline: "none" }}
      />
      <div className="sect-label">{kind === "word" ? "WORDS" : "CHUNKS"}</div>
      <div className="card" style={{ padding: "2px 12px" }}>
        {list.length === 0 && <div style={{ textAlign: "center", color: "var(--text-3)", fontSize: 13, padding: "34px 0" }}>没有匹配的词条</div>}
        {list.map((v) => (
          <button
            key={v.id}
            className="row"
            onClick={() =>
              actions.setSheet({
                word: v.word,
                kind: v.kind || "word",
                chunkType: v.chunkType,
                phonetic: v.phonetic,
                senses: v.senses,
                pattern: v.pattern,
                trap: v.trap,
                saved: true,
              })
            }
          >
            <span className={`dot ${v.dueAt <= now ? "" : "ok"}`} />
            <span className="rt">
              <span className="t1" style={{ display: "flex", gap: 7, alignItems: "center" }}>
                <span className="serif-en" style={{ fontSize: 17 }}>
                  {v.word}
                </span>
                {v.chunkType && <span className="badge">{v.chunkType}</span>}
              </span>
              <span className="t2" style={{ display: "block" }}>
                {v.senses[0]?.cn}
              </span>
            </span>
            <span style={{ fontSize: 11, color: v.dueAt <= now ? "var(--err)" : "var(--text-4)", flex: "none" }}>
              {v.dueAt <= now ? "到期" : `${Math.round((v.dueAt - now) / 86400000)} 天后`}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
