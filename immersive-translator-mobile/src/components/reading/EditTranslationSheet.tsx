/**
 * 修改译文抽屉（reading-parity · 原型 SHEETS.editTranslation）。
 * 保存 = 句级译文覆盖，写本地 profile 的 sentenceZh 表（不进云同步、不改文章 schema）；
 * 空值校验（空提交 toast 拦截）；保存后自动揭示该句（遮罩开启时立即可见）。
 */
import { useEffect, useState } from "react";
import { actions, effectiveSentenceZh, toast, useApp } from "../../store";
import type { Article } from "../../core/types";
import { ReadingDrawer } from "./Drawer";

export function EditTranslationSheet({
  open,
  onClose,
  article,
  sentIdx,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  article: Article;
  sentIdx: number;
  /** 保存成功后由阅读页把该句加入「已揭示」集合（遮罩开启时立即可见）。 */
  onSaved: (sentIdx: number) => void;
}) {
  const sentence = article.sentences[sentIdx];
  const overrides = useApp((s) => s.sentenceZh[article.id]);
  const current = sentence ? effectiveSentenceZh(overrides, sentIdx, sentence.zh) : null;
  const [draft, setDraft] = useState("");

  /* 每次打开/换句：草稿从当前生效译文起稿（覆盖值优先） */
  useEffect(() => {
    if (open) setDraft(current || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, article.id, sentIdx]);

  if (!sentence) return null;

  function save() {
    const text = draft.trim();
    if (!text) {
      toast("译文还没有内容");
      return;
    }
    actions.setSentenceZh(article.id, sentIdx, text.slice(0, 1000));
    onSaved(sentIdx);
    toast("这句译文已保存 · 仅在这台设备生效");
    onClose();
  }

  return (
    <ReadingDrawer open={open} onClose={onClose} label="修改译文">
      <div className="sheet-title plain">修改这一句的译文</div>
      <p className="serif" style={{ fontSize: 16, lineHeight: 1.7, margin: "0 0 10px", overflowWrap: "anywhere" }}>
        {sentence.en}
      </p>
      {/* 白底 + border-strong 描边（原型 .inp，html:151）；原型无说明行，覆盖提示由 toast 承担 */}
      <textarea
        className="input v2-inp"
        rows={4}
        maxLength={1000}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="写下这句你自己的中文译文"
        aria-label="这一句的中文译文"
      />
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)", flex: 1 }} onClick={onClose}>
          取消
        </button>
        <button className="btn" style={{ flex: 1 }} onClick={save} disabled={!draft.trim()}>
          保存译文
        </button>
      </div>
    </ReadingDrawer>
  );
}
