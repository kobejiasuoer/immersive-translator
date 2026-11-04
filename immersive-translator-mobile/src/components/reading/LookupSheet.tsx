/**
 * 手动查询表达抽屉（reading-parity · 原型 SHEETS.readWordSearch）。
 * 单字段 + 长度校验（非空、≤80 字符）；提交复用既有 dict sheet（setSheet），
 * 以当前句为语境（sentence/articleId/sentIdx 随词条带过去，词典卡真实 LLM 查询走 lookupWord）。
 */
import { useEffect, useState } from "react";
import { actions, getState, toast } from "../../store";
import { norm } from "../../core/judge";
import type { Article } from "../../core/types";
import { ReadingDrawer } from "./Drawer";

const MAX_QUERY = 80;

export function LookupSheet({
  open,
  onClose,
  article,
  sentIdx,
}: {
  open: boolean;
  onClose: () => void;
  article: Article;
  sentIdx: number;
}) {
  const [query, setQuery] = useState("");
  const sentence = article.sentences[sentIdx];

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  if (!sentence) return null;

  function submit() {
    const word = query.trim();
    if (!word) {
      toast("先输入一个词或词块");
      return;
    }
    if (word.length > MAX_QUERY) {
      toast("请选一个较短的词或词块");
      return;
    }
    onClose();
    /* 手动查询与点词同链路（原型 lexiconInfo 口径）：先解析内容预置词条/已收藏词，
       未命中才进「词典未收录」卡（模型兜底为真实 LLM 请求，无静态词典）。 */
    const key = norm(word);
    const keyBase = key.endsWith("s") ? key.slice(0, -1) : key;
    const saved = getState().vocab.find(v => norm(v.word) === key || norm(v.word) === keyBase);
    if (saved) {
      actions.setSheet({ kind: "dict", entry: { type: saved.kind === "chunk" ? "chunk" : "word", word: saved.word, chunkType: saved.chunkType, phonetic: saved.phonetic, senses: saved.senses, example: typeof saved.example === "string" ? saved.example : undefined, sentence: sentence.en, articleId: article.id, sentIdx, saved: true } });
      return;
    }
    const term = (article.termMeta || []).find((t) => norm(t.w) === key || norm(t.w) === keyBase);
    if (term) {
      actions.setSheet({
        kind: "dict",
        entry: {
          type: "word",
          word: term.w,
          phonetic: term.ph,
          senses: [{ pos: term.pos, cn: term.cn }],
          sentence: sentence.en,
          articleId: article.id,
          sentIdx,
          saved: false,
        },
      });
      return;
    }
    actions.setSheet({
      kind: "dict",
      entry: {
        type: "missing",
        word,
        senses: [],
        sentence: sentence.en,
        articleId: article.id,
        sentIdx,
        saved: false,
      },
    });
  }

  return (
    <ReadingDrawer open={open} onClose={onClose} label="查询表达">
      <div className="sheet-title plain">查一个词或词块</div>
      <p className="sheet-note">输入你在原句中看到的表达。</p>
      {/* 说明区与表单区之间 hairline 分隔（原型 .sh-head 底边线口径） */}
      <hr className="hr" style={{ margin: "0 0 14px" }} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="overline" htmlFor="reading-lookup-query" style={{ display: "block", letterSpacing: "0.06em" }}>
          英文表达
        </label>
        <input
          id="reading-lookup-query"
          className="input"
          value={query}
          maxLength={MAX_QUERY}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="例如 take a break"
          autoComplete="off"
        />
        {/* 主按钮纯文字（原型 readWordSearch 无图标，html:1819）；原型同态无 disabled——
            空输入点击走 toast 引导（html:1848「先输入一个词或词块」），按钮保持 accent 实底可用态 */}
        <button className="btn" type="submit">
          查看表达
        </button>
      </form>
    </ReadingDrawer>
  );
}
