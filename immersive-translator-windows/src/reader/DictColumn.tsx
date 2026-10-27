/**
 * 右侧解析面板 .side（2026-10-26 阅读页重构，原型 prototypes/reader-room-
 * redesign-2026-10-26.html .side 三态）：「句子解析 / 查词 / 本章生词」三 Tab
 * + 当前句号。根类 .reader-dict / .spatial-lens-card 沿用（宽度与定位续命）。
 *
 * 「句子解析」Tab 三态（数据由 ReaderApp 驱动，本组件纯展示 + 速览现算）：
 *   idle 速览——当前句词数/短语数由 activeSentence.en/chunks 现算，关键词
 *   chips 用词块文本（点击走完整查词），品牌绿 CTA「AI 解析这一句 E」为
 *   唯一解析入口（正文浮层不再重复）+ 自动解析开关（本地态，不落盘）；
 *   loading 骨架屏；done 三区——句子主干（.lens-spine）/结构拆解 clauses
 *   平铺伪树（缩进 + 左侧连线装饰，悬停回标正文）/常用句型（.lens-pattern）
 *   + 重新解析。clauses 数据是平铺 {tag,snippet,desc} 无父子层级，从属关系
 *   用缩进+连线示意（验收口径降级，见蓝图）。
 *
 * 「查词」Tab 完整保留原词典栏逻辑：词条 serif + 音标 + 发音 / 词性+释义 /
 * 原句卡 / 常用搭配 / 词形变化 / 加入生词本 + 复制；词块走即时卡（无 LLM）。
 * 「本章生词」Tab：chapterVocab（ReaderApp 按当前文章 id 过滤的 VocabWord[]）。
 */

import { useEffect, useState, type CSSProperties } from "react";
import { IconClose, IconCopy, IconLocate, IconSparkles, IconStar, IconVolume } from "../ui/icons";
import type { ReaderDictEntry } from "../core/readerDict";
import {
  CHUNK_TYPE_LABELS,
  type SentenceChunk,
  type SentencePair,
  type VocabCollocation,
  type VocabWord,
} from "../core/readerTypes";
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

/** 解析面板模式：句子解析 / 查词 / 本章生词。 */
export type LensMode = "xray" | "lex" | "vocab";

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
  // ---- 三态解析面板 ----
  /** 当前 Tab（句子解析 / 查词 / 本章生词）。 */
  lensMode: LensMode;
  onLensMode: (mode: LensMode) => void;
  /** 光标句序号（头部「第 N 句」与解析请求定位）。 */
  activeIdx: number;
  /** 当前句（ReaderApp 契约：article.sentences[activeIdx]；速览词数/短语数/关键词的唯一数据通道）。 */
  activeSentence?: SentencePair | null;
  /** 本章生词（ReaderApp 按当前文章 id 过滤；「本章生词」Tab 数据源）。 */
  chapterVocab?: readonly VocabWord[] | null;
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

/** 速览行：当前句词数（en 按空白切分）。 */
function countWords(en: string): number {
  const t = en.trim();
  return t ? t.split(/\s+/).length : 0;
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
  activeSentence,
  chapterVocab,
  xray,
  xrayBusy,
  onOpenXray,
  onHoverClause,
  onPracticeSentence,
}: Props) {
  /** 自动解析（本地态不落盘）：翻到新句且本句无解析记录时自动请求一次。 */
  const [autoParse, setAutoParse] = useState(false);

  const headWord = state.status === "chunk" ? state.chunk.text : state.status === "closed" ? "" : state.query;
  /** 数据只对得上它所属的那一句；光标已移走就回到「解析当前句」入口。 */
  const xrayData =
    xray && xray.status === "ready" && xray.data && xray.sentenceIdx === activeIdx ? xray.data : null;
  const xrayFailed = xray != null && xray.sentenceIdx === activeIdx && xray.status === "error";

  useEffect(() => {
    if (!autoParse || lensMode !== "xray" || xrayBusy) return;
    // 本句已有任何记录（loading/ready/error）都不重复请求——错误不自动重试。
    if (xray && xray.sentenceIdx === activeIdx) return;
    onOpenXray(activeIdx);
  }, [autoParse, lensMode, xrayBusy, xray, activeIdx, onOpenXray]);

  const chunkCount = activeSentence?.chunks?.length ?? 0;

  return (
    <aside className="reader-dict spatial-lens-card" aria-label="句子解析与查词">
      <div className="lens-header">
        <div className="lens-mode-switch" role="tablist" aria-label="解析面板模式">
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
          <button
            className={`lens-mode-btn${lensMode === "vocab" ? " active" : ""}`}
            role="tab"
            aria-selected={lensMode === "vocab"}
            onClick={() => onLensMode("vocab")}
            title="阅读本章时收藏的生词与词块"
          >
            本章生词
          </button>
        </div>
        <span className="lens-ref-tag tabular">第 {activeIdx + 1} 句</span>
        {lensMode === "lex" && state.status !== "closed" && (
          <button className="reader-tb-btn" onClick={() => onClose()} title="关闭查词结果" aria-label="关闭查词结果">
            <IconClose size={14} />
          </button>
        )}
      </div>

      <div className="lens-body">
        {lensMode === "xray" ? (
          <>
            {xrayBusy && (
              <div className="lens-loading" aria-live="polite">
                <div className="lens-loading-title">正在解析…</div>
                <div className="skeleton-line" style={{ width: "70%" }} />
                <div className="skeleton-line" style={{ width: "92%" }} />
                <div className="skeleton-line" style={{ width: "56%" }} />
                <div className="skeleton-line" style={{ width: "80%" }} />
                <div className="lens-empty">
                  正在解析第 {xray?.sentenceIdx != null ? xray.sentenceIdx + 1 : activeIdx + 1} 句…
                </div>
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
                <div className="lens-kicker">
                  <span>本句速览</span>
                  <span>第 {activeIdx + 1} 句</span>
                </div>
                <div className="lens-glance serif">
                  {activeSentence
                    ? `第 ${activeIdx + 1} 句 · ${countWords(activeSentence.en)} 词`
                    : `第 ${activeIdx + 1} 句`}
                </div>
                <div className="lens-glance-sub">
                  {activeSentence ? `含 ${chunkCount} 个短语` : "还没解析，点下方按钮看主干与结构拆解"}
                </div>
                {activeSentence && chunkCount > 0 && (
                  <div className="lens-keys">
                    {activeSentence.chunks!.map((c, i) => (
                      <button
                        key={i}
                        className="lens-key serif"
                        onClick={() => onLookup(c.text, activeIdx)}
                        title="点击查这个词块的完整词条"
                      >
                        {c.text}
                      </button>
                    ))}
                  </div>
                )}
                <button className="lens-cta" onClick={() => onOpenXray(activeIdx)}>
                  <IconSparkles size={14} />
                  AI 解析这一句
                  <kbd aria-hidden>E</kbd>
                </button>
                <div className="lens-auto">
                  <button
                    type="button"
                    className="switch"
                    role="switch"
                    aria-checked={autoParse}
                    aria-label="翻到新句子时自动解析"
                    onClick={() => setAutoParse((v) => !v)}
                  />
                  <span>翻到新句子时自动解析</span>
                </div>
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
                    <div className="clause-tree">
                      {xrayData.clauses.map((c, i) => (
                        <div
                          key={i}
                          className="clause-step-item"
                          style={{ "--clause-depth": i } as CSSProperties}
                          tabIndex={0}
                          onMouseEnter={() => onHoverClause(c.snippet)}
                          onMouseLeave={() => onHoverClause(null)}
                          onFocus={() => onHoverClause(c.snippet)}
                          onBlur={() => onHoverClause(null)}
                        >
                          <div className="clause-role">{c.tag}</div>
                          <div className="clause-snippet serif">{c.snippet}</div>
                          <div className="clause-desc">{c.desc}</div>
                        </div>
                      ))}
                    </div>
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
                  <div className="lens-done-actions">
                    <button className="lens-practice-btn" onClick={() => onPracticeSentence(activeIdx)}>
                      用这个句型练口语 →
                    </button>
                    <button className="lens-redo" onClick={() => onOpenXray(activeIdx)} title="重新请求这一句的解析">
                      重新解析
                    </button>
                  </div>
                </div>
              </>
            )}
          </>
        ) : lensMode === "vocab" ? (
          !chapterVocab || chapterVocab.length === 0 ? (
            <div className="dict-empty">
              本章还没有收藏的生词。正文里单击单词、划选短语或点词块虚线收藏后，会出现在这里。
            </div>
          ) : (
            <div className="lens-vocab-list">
              <div className="lens-kicker">
                <span>本章生词</span>
                <span>{chapterVocab.length} 个</span>
              </div>
              {chapterVocab.map((w) => (
                <div key={w.id} className="lens-vocab-row">
                  <button
                    className="lens-vocab-word serif"
                    onClick={() => onLookup(w.word, activeIdx)}
                    title="查这个词的完整词条（音标、多义项、搭配）"
                  >
                    {w.word}
                  </button>
                  <span className="lens-vocab-cn">{w.senses.map((s) => s.cn).join("；")}</span>
                  <button
                    className="reader-tb-btn"
                    style={{ width: 24, height: 24, flex: "none" }}
                    onClick={() => onSpeak(w.word)}
                    title={`朗读 ${w.word}`}
                    aria-label={`朗读 ${w.word}`}
                  >
                    <IconVolume size={13} />
                  </button>
                </div>
              ))}
            </div>
          )
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
                      <button className="reader-tb-btn" style={{ width: 24, height: 24 }} onClick={() => onSpeak(state.query)} title="发音" aria-label={`朗读单词 ${state.query}`}>
                        <IconVolume size={13} />
                      </button>
                    </div>
                  )}
                  {state.status === "chunk" && (
                    <div className="phon-row">
                      <span className="chunk-type-badge">{CHUNK_TYPE_LABELS[state.chunk.chunkType]}</span>
                      <button className="reader-tb-btn" style={{ width: 24, height: 24 }} onClick={() => onSpeak(state.chunk.text)} title="发音" aria-label="朗读这个词块">
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
