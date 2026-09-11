/**
 * 屏 C · 词典栏：正文列右侧 380px 固定栏（永不遮挡正文）。
 * 词条 26px serif + 音标 + 发音 / 词性+释义 / 原句卡（第 N 句定位）/
 * 常用搭配 3 条 / 词形变化 / 加入生词本 + 复制。
 * 词块（正文点下划线短语）走即时卡：无 LLM 调用，数据来自标注结果，
 * 可发音 / 收藏 / 详查词典（详查才走 LLM）。
 */

import { IconClose, IconCopy, IconLocate, IconStar, IconVolume } from "../ui/icons";
import type { ReaderDictEntry } from "../core/readerDict";
import { CHUNK_TYPE_LABELS, type SentenceChunk } from "../core/readerTypes";

export type DictPanelState =
  | { status: "closed" }
  | { status: "chunk"; chunk: SentenceChunk; sentenceIdx: number; sourceSentence: string }
  | { status: "loading"; query: string; sentenceIdx: number; sourceSentence: string }
  | { status: "ready"; query: string; entry: ReaderDictEntry; sentenceIdx: number; sourceSentence: string }
  | { status: "notAWord"; query: string; sentenceIdx: number; sourceSentence: string }
  | { status: "error"; query: string; sentenceIdx: number; sourceSentence: string; message: string };

interface Props {
  state: DictPanelState;
  inVocab: boolean;
  onSpeak: (text: string) => void;
  onAddVocab: () => void;
  onLocate: (sentenceIdx: number) => void;
  /** 词块即时卡「详查词典」：走完整 LLM 词条查询。 */
  onLookup: (text: string, sentenceIdx: number) => void;
  onClose: () => void;
}

export function DictColumn({ state, inVocab, onSpeak, onAddVocab, onLocate, onLookup, onClose }: Props) {
  if (state.status === "closed") return null;

  const headWord = state.status === "chunk" ? state.chunk.text : state.query;

  return (
    <aside className="reader-dict" role="dialog" aria-label={`词典：${headWord}`}>
      <div className="head">
        <div className="grow">
          <div className="dict-word">{headWord}</div>
          {state.status === "ready" && state.entry.phonetic && (
            <div className="phon-row">
              <span>/{state.entry.phonetic.replace(/^\/|\/$/g, "")}/</span>
              <button className="reader-tb-btn" style={{ width: 24, height: 24 }} onClick={() => onSpeak(state.query)} title="发音">
                <IconVolume size={13} />
              </button>
            </div>
          )}
          {state.status === "chunk" && (
            <div className="phon-row">
              <span className="chunk-type-badge">{CHUNK_TYPE_LABELS[state.chunk.chunkType]}</span>
              <button className="reader-tb-btn" style={{ width: 24, height: 24 }} onClick={() => onSpeak(state.chunk.text)} title="发音">
                <IconVolume size={13} />
              </button>
            </div>
          )}
        </div>
        <button className="reader-tb-btn" onClick={onClose} title="关闭词典栏">
          <IconClose size={14} />
        </button>
      </div>

      {state.status === "loading" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="skeleton-line" style={{ width: "40%" }} />
          <div className="skeleton-line" style={{ width: "92%" }} />
          <div className="skeleton-line" style={{ width: "78%" }} />
        </div>
      )}

      {state.status === "notAWord" && (
        <div className="dict-empty">「{state.query}」不像一个词条——试试划选更短的词组，或单击单个单词。</div>
      )}

      {state.status === "error" && (
        <div className="dict-empty">
          查询失败：{state.message}
          <div style={{ marginTop: 6 }}>
            <button className="btn btn-secondary btn-sm" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      )}

      {state.status === "chunk" && (
        <>
          <div>
            <div className="section-label">释义</div>
            <div className="senses">
              <div className="sense">{state.chunk.gloss}</div>
            </div>
          </div>

          {state.chunk.pattern && (
            <div>
              <div className="section-label">记法</div>
              <div className="chunk-pattern">{state.chunk.pattern}</div>
            </div>
          )}

          {state.chunk.trap && (
            <div>
              <div className="section-label">直译陷阱</div>
              <div className="chunk-trap">{state.chunk.trap}</div>
            </div>
          )}

          <div>
            <div className="section-label">原句</div>
            <div
              className="source-card"
              onClick={() => onLocate(state.sentenceIdx)}
              title="点击定位到这一句"
            >
              {state.sourceSentence}
              <span className="loc">
                <IconLocate size={10} style={{ verticalAlign: -1, marginRight: 3 }} />
                第 {state.sentenceIdx + 1} 句 · 点击定位
              </span>
            </div>
          </div>

          <div className="dict-actions">
            <button className="btn btn-primary btn-sm" onClick={onAddVocab} disabled={inVocab}>
              <IconStar size={12} filled={inVocab} />
              {inVocab ? "已在生词本" : "收藏词块"}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => onLookup(state.chunk.text, state.sentenceIdx)}
              title="查完整词条（音标、多义项、搭配）"
            >
              详查词典
            </button>
          </div>
        </>
      )}

      {state.status === "ready" && (
        <>
          <div>
            <div className="section-label">释义</div>
            <div className="senses">
              {state.entry.senses.map((s, i) => (
                <div className="sense" key={i}>
                  {s.pos && <span className="pos">{s.pos}</span>}
                  {s.cn}
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="section-label">原句</div>
            <div
              className="source-card"
              onClick={() => onLocate(state.sentenceIdx)}
              title="点击定位到这一句"
            >
              {state.sourceSentence}
              <span className="loc">
                <IconLocate size={10} style={{ verticalAlign: -1, marginRight: 3 }} />
                第 {state.sentenceIdx + 1} 句 · 点击定位
              </span>
            </div>
          </div>

          {state.entry.collocations && state.entry.collocations.length > 0 && (
            <div>
              <div className="section-label">常用搭配</div>
              <div className="coll-list">
                {state.entry.collocations.map((c, i) => (
                  <div className="coll" key={i}>
                    {c.en}
                    <span className="cn">{c.cn}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {state.entry.forms && state.entry.forms.length > 0 && (
            <div>
              <div className="section-label">词形变化</div>
              <div className="forms">{state.entry.forms.join(" · ")}</div>
            </div>
          )}

          <div className="dict-actions">
            <button className="btn btn-primary btn-sm" onClick={onAddVocab} disabled={inVocab}>
              <IconStar size={12} filled={inVocab} />
              {inVocab ? "已在生词本" : "加入生词本"}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                const e = state.status === "ready" ? state.entry : null;
                if (!e) return;
                const text = [e.word, ...e.senses.map((s) => `${s.pos} ${s.cn}`.trim())]
                  .filter(Boolean)
                  .join("\n");
                void navigator.clipboard.writeText(text);
              }}
              title="复制词条"
            >
              <IconCopy size={12} />
              复制
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
