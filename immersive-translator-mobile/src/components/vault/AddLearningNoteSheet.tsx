/**
 * 写/编辑学习笔记底部抽屉（proto-parity · SHEETS.addLearningNote，html:3009-3012）：
 * 标题「写一条学习笔记」（编辑态「编辑学习笔记」）+ 标题（选填，placeholder「今天学到的小发现」）
 * + 内容 textarea +「保存笔记」。草稿沿用 useLocalDraft（draft 回归同键位不变）；
 * 编辑既有笔记由笔记阅读态页头编辑笔进入。复检 r1：内容为空报「写下内容后再保存。」（原型 v2-note-save）。
 */
import { useState } from "react";
import { actions, activeRepository, flushPersist, toast, useApp } from "../../store";
import { useLocalDraft } from "../../core/useLocalDraft";
import { ReadingDrawer } from "../reading/Drawer";

export function AddLearningNoteSheet({ id, open, onClose }: { id?: string; open: boolean; onClose: () => void }) {
  const target = activeRepository();
  const note = useApp((s) => s.notes.find((n) => n.id === id));
  const [draft, setDraft, ready, clearDraft] = useLocalDraft("note:" + (id || "new"), { title: note?.title || "", body: note?.body || "" });
  const { title, body } = draft;
  const [error, setError] = useState("");
  const setTitle = (title: string) => setDraft((d) => ({ ...d, title }));
  const setBody = (body: string) => {
    setError("");
    setDraft((d) => ({ ...d, body }));
  };

  function save() {
    if (target !== activeRepository()) {
      toast("账号已切换，请重新打开笔记");
      return;
    }
    /* 原型 v2-note-save（html:3195-3197）：内容为空不落库，表单内报错。 */
    if (!body.trim()) {
      setError("写下内容后再保存。");
      return;
    }
    actions.saveNote({ ...note, id: id || crypto.randomUUID(), title: title || "学习笔记", body, sub: note?.sub || "我的心得", insight: note?.insight || "", createdAt: note?.createdAt || Date.now() });
    void flushPersist()
      .then(clearDraft)
      .then(() => {
        toast("笔记已保存");
        onClose();
      })
      .catch((e) => toast(String(e)));
  }

  return (
    <ReadingDrawer open={open && ready} onClose={onClose} label={id ? "编辑学习笔记" : "写一条学习笔记"}>
      {/* 抽屉头（原型 .sh-head：17px 无衬线粗体 + 下缘分隔线，html:417,3011） */}
      <div className="v2-sh-head">
        <div className="sheet-title plain">{id ? "编辑学习笔记" : "写一条学习笔记"}</div>
      </div>
      <div style={{ marginTop: 12 }}>
        <label htmlFor="v2-note-title" style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--ink-2)", marginBottom: 5 }}>
          标题（选填）
        </label>
        <input id="v2-note-title" className="input" value={title} maxLength={100} placeholder="今天学到的小发现" onChange={(e) => setTitle(e.target.value)} aria-label="标题（选填）" />
      </div>
      <div style={{ marginTop: 12 }}>
        <label htmlFor="v2-note-text" style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--ink-2)", marginBottom: 5 }}>
          内容
        </label>
        <textarea id="v2-note-text" className="input" rows={7} maxLength={6000} required value={body} onChange={(e) => setBody(e.target.value)} aria-label="内容" />
      </div>
      {error && (
        <div className="v2-field-error" role="alert">
          {error}
        </div>
      )}
      <button className="btn" style={{ width: "100%", marginTop: 16 }} onClick={save}>
        保存笔记
      </button>
    </ReadingDrawer>
  );
}
