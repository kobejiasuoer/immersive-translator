/**
 * 屏 C · 右侧透镜卡（v0.8）：圆角悬浮毛玻璃卡 + 「句子解析 / 查词」双 Tab。
 *
 * 「查词」Tab 完整保留原词典栏逻辑：词条 26px serif + 音标 + 发音 /
 * 词性+释义 / 原句卡（第 N 句定位）/ 常用搭配 / 词形变化 / 加入生词本 +
 * 复制；词块（正文点下划线短语）走即时卡：无 LLM 调用，数据来自标注结果。
 *
 * 「句子解析」Tab 展示 ReaderApp 层的 xray 数据（translateStream 请求，
 * tag 前缀 rx）：句子主干 / 结构拆解（悬停回标左侧原文片段）/ 常用句型。
 * 本组件纯展示，全部状态由 ReaderApp 驱动。
 */

import { IconClose, IconCopy, IconLocate, IconStar, IconVolume } from "../ui/icons";
import type { ReaderDictEntry } from "../core/readerDict";
import { CHUNK_TYPE_LABELS, type SentenceChunk, type VocabCollocation } from "../core/readerTypes";
import { normalizeWordKey } from "../core/articleBuilder";
import type { SentenceXray } from "../core/sentenceXray";

export type DictPanelState =
  | { status: "closed" }
  | { status: "chunk"; chunk: SentenceChunk; sentenceIdx: number; sourceSentence: string }
  | { status: "loading"; query: string; sentenceIdx: number; sourceSentence: string }
  | { status: "ready"; query: string; entry: ReaderDictEntry; sentenceIdx: number; sourceSentence: string }
  | { status: "notAWord"; query: string; sentenceIdx: number; sourceSentence: string }
  | { status: "error"; query: string; sentenceIdx: number; sourceSentence: string; message: string };

/** 句子解析数据状态（ReaderApp 持有，tag 前缀 rx 的 translateStream 请求）。 */
export interface LensXrayState {
  status: "loading" | "ready" | "error";
  /** 解析对象的全局句序号。 */
  sentenceIdx: number;
  data: SentenceXray | null;
}

/** 透镜卡模式：句子解析 / 查词。 */
export type LensMode = "xray" | "lex";

interface Props {
  state: DictPanelState;
  inVocab: boolean;
  /** 生词本归一化 id 集（搭配行收藏态判定）。 */
  knownIds: ReadonlySet<string>;
  /** 当前文章的书级来源（「《书名》·第 N 章」；短文缺省不显示）。 */
  bookSource?: string | null;
  onSpeak: (text: string) => void;
  onAddVocab: () => void;
  /** 常用搭配行一键收藏为词块。 */
  onAddCollVocab: (coll: VocabCollocation) => void;
  onLocate: (sentenceIdx: number) => void;
  /** 词块即时卡「详查词典」：走完整 LLM 词条查询。 */
  onLookup: (text: string, sentenceIdx: number) => void;
  onClose: () => void;
  // ---- v0.8 双模透镜卡 ----
  /** 当前 Tab（句子解析 / 查词）。 */
  lensMode: LensMode;
  onLensMode: (mode: LensMode) => void;
  /** 光标句序号（头部「第 N 句」与解析请求定位）。 */
  activeIdx: number;
  /** 句子解析数据（null = 本窗口还没请求过）。 */
  xray: LensXrayState | null;
  /** 句子解析请求进行中。 */
  xrayBusy: boolean;
  /** 请求解析第 idx 句（走 translateStream，ReaderApp 层发请求）。 */
  onOpenXray: (idx: number) => void;
  /** 结构拆解悬停：回标左侧原文片段（离开传 null）。 */
  onHoverClause: (snippet: string | null) => void;
  /** 「用这个句型练口语」：带入句切口语陪练。 */
  onPracticeSentence: (idx: number) => void;
}

export function DictColumn({
  state,
  inVocab,
  knownIds,
  bookSource,
  onSpeak,
  onAddVocab,
  onAddCollVocab,
  onLocate,
  onLookup,
  onClose,
  lensMode,
  onLensMode,
  activeIdx,
  xray,
  xrayBusy,
  onOpenXray,
  onHoverClause,
  onPracticeSentence,
}: Props) {
  const headWord = state.status === "chunk" ? state.chunk.text : state.status === "closed" ? "" : state.query;
  /** 数据只对得上它所属的那一句；光标已移走就回到「解析当前句」入口。 */
  const xrayData =
    xray && xray.status === "ready" && xray.data && xray.sentenceIdx === activeIdx ? xray.data : null;
  const xrayFailed = xray != null && xray.sentenceIdx === activeIdx && xray.status === "error";

  return (
    <aside className="reader-dict spatial-lens-card" aria-label="句子解析与查词">
      <div className="lens-header">
        <div className="lens-mode-switch" role="tablist" aria-label="透镜卡模式">
          <button
            className={`lens-mode-btn${lensMode === "xray" ? " active" : ""}`}
            role="tab"
            aria-selected={lensMode === "xray"}
            onClick={() => onLensMode("xray")}
          >
            句子解析
          </button>
          <button
            className={`lens-mode-btn${lensMode === "lex" ? " active" : ""}`}
            role="tab"
            aria-selected={lensMode === "lex"}
            onClick={() => onLensMode("lex")}
          >
            查词
          </button>
        </div>
        <span className="lens-ref-tag tabular">第 {activeIdx + 1} 句</span>
        {lensMode === "lex" && state.status !== "closed" && (
          <button className="reader-tb-btn" onClick={() => onClose()} title="关闭查词结果">
            <IconClose size={14} />
          </button>
        )}
      </div>

      <div className="lens-body">
        {lensMode === "xray" ? (
          <>
            {xrayBusy && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-live="polite">
                <div className="skeleton-line" style={{ width: "40%" }} />
                <div className="skeleton-line" style={{ width: "92%" }} />
                <div className="skeleton-line" style={{ width: "78%" }} />
                <div className="lens-empty">正在解析第 {xray?.sentenceIdx != null ? xray.sentenceIdx + 1 : activeIdx + 1} 句…</div>
              </div>
            )}

            {!xrayBusy && xrayFailed && (
              <div className="dict-empty">
                句子解析失败，稍后再试。
                <div style={{ marginTop: 6 }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => onOpenXray(activeIdx)}>
                    重试
                  </button>
                </div>
              </div>
            )}

            {!xrayBusy && !xrayFailed && !xrayData && (
              <div className="lens-empty-stack">
                <div className="lens-empty">第 {activeIdx + 1} 句还没解析。</div>
                <button className="island-tab active" style={{ width: "100%", justifyContent: "center" }} onClick={() => onOpenXray(activeIdx)}>
                  解析这一句 →
                </button>
                <div className="lens-hint">解析这句的主干、结构拆解与常用句型，拆解悬停可高亮左侧原文。</div>
              </div>
            )}

            {xrayData && (
              <>
                <div className="lens-section">
                  <div className="lens-kicker">
                    <span>句子主干</span>
                    <span>第 {activeIdx + 1} 句</span>
                  </div>
                  <div className="lens-spine serif">“{xrayData.spine}”</div>
                </div>

                <div className="lens-section">
                  <div className="lens-kicker">
                    <span>结构拆解（悬停可高亮左侧原文）</span>
                  </div>
                  {xrayData.clauses.length === 0 ? (
                    <div className="lens-empty">这句没有拆出更多结构。</div>
                  ) : (
                    xrayData.clauses.map((c, i) => (
                      <div
                        key={i}
                        className="clause-step-item"
                        style={{ marginLeft: i * 8 }}
                        onMouseEnter={() => onHoverClause(c.snippet)}
                        onMouseLeave={() => onHoverClause(null)}
                      >
                        <div className="clause-tag">{c.tag}</div>
                        <div className="clause-snippet serif">{c.snippet}</div>
                        <div className="clause-desc">{c.desc}</div>
                      </div>
                    ))
                  )}
                </div>

                <div className="lens-section">
                  <div className="lens-kicker">
                    <span>常用句型</span>
                  </div>
                  {xrayData.pattern ? (
                    <div className="lens-pattern">{xrayData.pattern}</div>
                  ) : (
                    <div className="lens-empty">这句没有值得单独提取的句型。</div>
                  )}
                  <button
                    className="island-tab active"
                    style={{ width: "100%", justifyContent: "center", marginTop: 12 }}
                    onClick={() => onPracticeSentence(activeIdx)}
                  >
                    用这个句型练口语 →
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            {state.status === "closed" && (
              <div className="dict-empty">单击正文里的单词、划选短语，或点词块下划线，这里出词条。</div>
            )}

            {state.status !== "closed" && (
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
              </div>
            )}

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
                      {bookSource ? `${bookSource} · ` : ""}第 {state.sentenceIdx + 1} 句 · 点击定位
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
                      {bookSource ? `${bookSource} · ` : ""}第 {state.sentenceIdx + 1} 句 · 点击定位
                    </span>
                  </div>
                </div>

                {state.entry.collocations && state.entry.collocations.length > 0 && (
                  <div>
                    <div className="section-label">常用搭配</div>
                    <div className="coll-list">
                      {state.entry.collocations.map((c, i) => {
                        const saved = knownIds.has(normalizeWordKey(c.en));
                        return (
                          <div className="coll" key={i}>
                            {c.en}
                            <span className="cn">{c.cn}</span>
                            <button
                              className={`coll-save${saved ? " saved" : ""}`}
                              onClick={() => onAddCollVocab(c)}
                              disabled={saved}
                              title={saved ? "已在生词本" : "收藏为词块"}
                            >
                              <IconStar size={11} filled={saved} />
                            </button>
                          </div>
                        );
                      })}
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
          </>
        )}
      </div>
    </aside>
  );
}
