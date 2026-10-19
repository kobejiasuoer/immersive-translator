/**
 * 生词（Tab 4）—— §3.4：SRS 队列本体。
 * 到期分组（无红点，到期 = 墨点 +「现在」）、单词/词块行、搜索、
 * 左滑删除（撤销 toast）、点行 → 对应复习卡（#50）、整理成笔记（#53）。
 */
import { useState } from "react";
import { actions, useApp } from "../store";
import { Icon } from "../ui/icons";
import { SwipeRow, dayDiffLabel } from "../ui/kit";
import { useNav } from "../ui/nav";
import type { VocabWord } from "../core/types";

function VocabRow({ v }: { v: VocabWord }) {
  const nav = useNav();
  const due = v.dueAt <= Date.now();
  return (
    <SwipeRow innerClass="vmain" onDelete={() => actions.deleteWord(v.id)}>
      <div
        className="grow"
        style={{ minWidth: 0 }}
        onClick={() => nav.push("review", { wordId: v.id, from: "vocab" })}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="vword">{v.word}</span>
          <span className="pos-badge">{v.kind === "chunk" ? v.chunkType || "词块" : "单词"}</span>
        </div>
        <div className="vgloss">{v.senses[0]?.cn}</div>
      </div>
      <div className="vtime">
        {due && <span className="dot-due" />}
        <span style={{ color: due ? "var(--ink-2)" : undefined }}>{due ? "现在" : dayDiffLabel(v.dueAt)}</span>
      </div>
    </SwipeRow>
  );
}

export default function VocabScreen() {
  const nav = useNav();
  const vocab = useApp((s) => s.vocab);
  const [seg, setSeg] = useState<"due" | "all">("due");
  const [q, setQ] = useState("");

  const now = Date.now();
  const dueList = vocab.filter((v) => v.dueAt <= now);
  /* 搜索：trim+toLowerCase 原样匹配词条与释义（P-53）——判分用 norm() 会把中文清成空串恒放行全部，不可复用 */
  const query = q.trim().toLowerCase();
  const list = vocab.filter(
    (v) =>
      (seg === "all" || v.dueAt <= now) &&
      (!query ||
        v.word.toLowerCase().includes(query) ||
        v.senses.some((s) => s.cn.toLowerCase().includes(query))),
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="h1" style={{ marginTop: 10 }}>
          生词
        </div>
        <button
          className="iconbtn"
          aria-label="笔记库"
          style={{ width: 40, height: 40, marginTop: 12 }}
          onClick={() => nav.push("noteslib")}
        >
          <Icon name="note" size={19} />
        </button>
      </div>
      <button
        className="btn-ghost"
        style={{ border: "1px solid var(--hairline-strong)", marginTop: 10 }}
        onClick={() => nav.push("quick")}
      >
        <Icon name="bolt" size={15} />
        快速复习 · 先清一张
      </button>
      <div className="seg-line">
        <div className="seg" style={{ flex: 1 }}>
          <button className={seg === "due" ? "on" : ""} onClick={() => setSeg("due")}>
            到期 {dueList.length}
          </button>
          <button className={seg === "all" ? "on" : ""} onClick={() => setSeg("all")}>
            全部 {vocab.length}
          </button>
        </div>
      </div>
      <div className="search" style={{ marginTop: 12 }}>
        <Icon name="search" size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索生词与词块" />
      </div>

      {vocab.length === 0 ? (
        <div style={{ textAlign: "center", padding: "80px 24px 0" }}>
          <div className="serif" style={{ fontSize: 20, fontWeight: 600, lineHeight: "30px" }}>
            在阅读里点任何一个词，
            <br />
            都能收进来
          </div>
          <button
            className="btn-ghost"
            style={{ border: "1px solid var(--hairline-strong)", marginTop: 16 }}
            onClick={() => actions.setTab("shelf")}
          >
            去书架
          </button>
        </div>
      ) : seg === "due" ? (
        <>
          {(() => {
            const due = list.filter((v) => v.dueAt <= now);
            const later = list.filter((v) => v.dueAt > now);
            return (
              <>
                {due.length === 0 ? (
                  query ? (
                    /* 搜索无匹配 ≠ 已清空（治 home-4）：此前到期段下搜索不匹配会误报
                       「今天的到期已清空」，与 tab 角标「到期 N」自相矛盾 */
                    <div className="ghead">
                      <span className="overline">没有匹配的生词</span>
                    </div>
                  ) : (
                    <div className="ghead">
                      <span className="ok-line">
                        <Icon name="check" size={15} />
                        今天的到期已清空
                      </span>
                      {/* 清空态保留入口（治 home-8）：到期清空后组头换成 ✓ 态，
                          「整理成笔记」随之消失，生词页再无此入口 */}
                      <span className="tlink" style={{ fontSize: 13 }} onClick={() => nav.push("notes")}>
                        整理成笔记
                      </span>
                    </div>
                  )
                ) : (
                  <div className="ghead">
                    <span className="overline">今天到期 · {due.length}</span>
                    <span className="tlink" style={{ fontSize: 13 }} onClick={() => nav.push("notes")}>
                      整理成笔记
                    </span>
                  </div>
                )}
                {due.map((v) => (
                  <VocabRow key={v.id} v={v} />
                ))}
                {later.length > 0 && (
                  <>
                    <div className="ghead">
                      <span className="overline">之后</span>
                    </div>
                    {later.map((v) => (
                      <VocabRow key={v.id} v={v} />
                    ))}
                  </>
                )}
              </>
            );
          })()}
        </>
      ) : list.length === 0 ? (
        <div className="meta" style={{ textAlign: "center", padding: "40px 0" }}>
          没有匹配的生词
        </div>
      ) : (
        list.map((v) => <VocabRow key={v.id} v={v} />)
      )}
      <div style={{ height: 24 }} />
    </div>
  );
}
