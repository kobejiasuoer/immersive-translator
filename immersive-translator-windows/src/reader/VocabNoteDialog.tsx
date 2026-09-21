/**
 * 学词笔记生成弹窗（R3）：生词本 → LLM 流式整理「记忆诊断式」复习笔记。
 *
 * 流程：选词（默认全选未掌握，可由笔记库「滚进新笔记」预选）→ 连同出处例句/
 * 词块/错题统计交给 LLM → 流式上屏（可取消）→ 完成后校验词条无幻觉 →
 * 自动存入笔记库（notes/ 目录，永不覆盖旧文件）。定位是「复习笔记」，
 * 不改 SRS 数据与调度。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildNoteMaterials,
  buildNoteSystemPrompt,
  buildNoteUserInput,
  defaultNoteSelection,
  NOTE_MASTERED_INTERVAL_DAYS,
  noteBaseName,
  verifyNoteWords,
} from "../core/noteBuilder";
import { cancelTranslation, saveTextFile } from "../lib/tauriBridge";
import { noteSave, readerGetArticle } from "../lib/readerStore";
import type { Article, NoteMeta, VocabWord } from "../core/readerTypes";

/** 与 ReaderApp.requestTranslate 同签名（tag 路由 + 流式 onDelta + 可取消）。 */
export type NoteTranslateFn = (
  input: string,
  systemPrompt: string,
  tag: string,
  onDelta?: (text: string) => void,
) => Promise<{ status: "done" | "error" | "cancelled"; text: string }>;

interface Props {
  words: VocabWord[];
  requestTranslate: NoteTranslateFn;
  onClose: () => void;
  /** 预选词条（笔记库「滚进新笔记」）；缺省按未掌握默认选。 */
  preselect?: string[];
  /** 自动入库成功（用户点了「在笔记库打开」）。 */
  onSaved?: (meta: NoteMeta) => void;
}

type Phase = "select" | "generating" | "done" | "cancelled" | "error";

export function VocabNoteDialog({ words, requestTranslate, onClose, preselect, onSaved }: Props) {
  const [phase, setPhase] = useState<Phase>("select");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(preselect?.length ? preselect : [...defaultNoteSelection(words)]),
  );
  const [noteText, setNoteText] = useState("");
  const [error, setError] = useState("");
  const [verify, setVerify] = useState<{ ok: boolean; unknownHeadings: string[] } | null>(null);
  const [savedMeta, setSavedMeta] = useState<NoteMeta | null>(null);
  const [saveError, setSaveError] = useState("");
  const seqRef = useRef(0);
  /** 当前生成请求的 tag：取消只掐掉自己的流，不误伤并发的词块标注/字幕翻译。 */
  const tagRef = useRef("");
  const streamRef = useRef<HTMLPreElement | null>(null);
  /** 保存用的词条集合（生成时定格，完成态的保存/打开都基于它）。 */
  const chosenRef = useRef<VocabWord[]>([]);

  const unmastered = useMemo(
    () => words.filter((w) => w.srs.intervalDays < NOTE_MASTERED_INTERVAL_DAYS),
    [words],
  );
  const mastered = useMemo(
    () => words.filter((w) => w.srs.intervalDays >= NOTE_MASTERED_INTERVAL_DAYS),
    [words],
  );

  // Esc 关闭（生成中先当一次取消用）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (phase === "generating") void cancelTranslation(tagRef.current);
      else onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, onClose]);

  // 流式时贴底滚动
  useEffect(() => {
    const el = streamRef.current;
    if (el && phase === "generating") el.scrollTop = el.scrollHeight;
  }, [noteText, phase]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** 生成完成/取消后自动入库；失败的半篇也存（partial 标记）。 */
  const persist = useCallback(
    async (text: string, partial: boolean): Promise<NoteMeta | null> => {
      const chosen = chosenRef.current;
      try {
        return await noteSave(noteBaseName(), text, {
          createdAt: Date.now(),
          words: chosen.length,
          partial,
          wordIds: chosen.map((w) => w.id),
          replay: null,
          updatedAt: Date.now(),
        });
      } catch (e) {
        console.error("[reader] note save failed", e);
        setSaveError(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [],
  );

  const generate = useCallback(async () => {
    const chosen = words.filter((w) => selected.has(w.id));
    if (chosen.length === 0) return;
    chosenRef.current = chosen;
    setPhase("generating");
    setNoteText("");
    setError("");
    setVerify(null);
    setSavedMeta(null);
    setSaveError("");
    try {
      // 拉出处文章例句（失败不阻塞：材料里例句缺省，LLM 不许编）
      const articles = new Map<string, Pick<Article, "sentences">>();
      const ids = [...new Set(chosen.map((w) => w.source.articleId).filter(Boolean))];
      await Promise.all(
        ids.map(async (id) => {
          const a = await readerGetArticle(id).catch(() => null);
          if (a) articles.set(id, a);
        }),
      );
      const materials = buildNoteMaterials(chosen, articles);
      const tag = `note${++seqRef.current}`;
      tagRef.current = tag;
      const res = await requestTranslate(
        buildNoteUserInput(materials),
        buildNoteSystemPrompt(),
        tag,
        (t) => setNoteText(t),
      );
      if (res.status === "done") {
        setNoteText(res.text);
        setVerify(verifyNoteWords(res.text, chosen));
        setPhase("done");
        setSavedMeta(await persist(res.text, false));
      } else if (res.status === "cancelled") {
        const partial = res.text.trim().length > 0;
        setNoteText(res.text);
        setPhase("cancelled");
        if (partial) setSavedMeta(await persist(res.text, true));
      } else {
        setError(res.text);
        setPhase("error");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [words, selected, requestTranslate, persist]);

  const copyNote = useCallback(async () => {
    await navigator.clipboard.writeText(noteText);
  }, [noteText]);

  const exportNote = useCallback(async () => {
    const name = savedMeta?.file ?? `${noteBaseName()}.md`;
    await saveTextFile(name, noteText);
  }, [noteText, savedMeta]);

  const openInLibrary = useCallback(() => {
    if (savedMeta) onSaved?.(savedMeta);
  }, [savedMeta, onSaved]);

  const selectedCount = selected.size;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && phase !== "generating") onClose();
      }}
    >
      <div className="reader-import-modal reader-note-modal" role="dialog" aria-modal="true" aria-label="生成复习笔记">
        <div className="reader-import-head">
          <div>
            <h3>生成复习笔记</h3>
            <p>
              {phase === "select"
                ? `从生词本挑词（默认选未掌握的 ${unmastered.length} 个），连同例句、词块与错题记录交给 AI 做记忆诊断`
                : "笔记由你的生词本和错题记录整理而来 —— 只用你真实攒下的词，不会编造"}
            </p>
          </div>
          {phase !== "generating" && (
            <button className="reader-tb-btn" onClick={onClose} title="关闭 (Esc)">
              ✕
            </button>
          )}
        </div>

        {phase === "select" && (
          <div className="reader-note-select">
            {unmastered.length > 0 && (
              <>
                <div className="note-group-head">
                  未掌握 · {unmastered.length}
                  <button
                    className="note-group-toggle"
                    onClick={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        const allIn = unmastered.every((w) => next.has(w.id));
                        for (const w of unmastered) {
                          if (allIn) next.delete(w.id);
                          else next.add(w.id);
                        }
                        return next;
                      })
                    }
                  >
                    全选/全不选
                  </button>
                </div>
                <div className="note-word-grid">
                  {unmastered.map((w) => (
                    <label key={w.id} className={`note-word${selected.has(w.id) ? " on" : ""}`}>
                      <input
                        type="checkbox"
                        checked={selected.has(w.id)}
                        onChange={() => toggle(w.id)}
                      />
                      <span className="t">{w.word}</span>
                      {w.kind === "chunk" && <span className="q-kind">块</span>}
                    </label>
                  ))}
                </div>
              </>
            )}
            {mastered.length > 0 && (
              <>
                <div className="note-group-head">
                  已掌握 · {mastered.length}
                  <span className="note-group-sub">已较熟，默认不进笔记</span>
                </div>
                <div className="note-word-grid">
                  {mastered.map((w) => (
                    <label key={w.id} className={`note-word${selected.has(w.id) ? " on" : ""}`}>
                      <input
                        type="checkbox"
                        checked={selected.has(w.id)}
                        onChange={() => toggle(w.id)}
                      />
                      <span className="t">{w.word}</span>
                      {w.kind === "chunk" && <span className="q-kind">块</span>}
                    </label>
                  ))}
                </div>
              </>
            )}
            <div className="reader-import-foot">
              <span className="note-selected-count">已选 {selectedCount} 个词条</span>
              <button
                className="btn btn-primary"
                disabled={selectedCount === 0}
                onClick={() => void generate()}
              >
                开始生成
              </button>
            </div>
          </div>
        )}

        {(phase === "generating" || phase === "done" || phase === "cancelled") && (
          <div className="reader-note-stream-wrap">
            <pre className="reader-note-stream" ref={streamRef}>
              {noteText || "正在等待模型输出…"}
              {phase === "generating" && <span className="note-caret" aria-hidden />}
            </pre>
            <div className="reader-note-foot">
              <div className="reader-note-status">
                {phase === "generating" && "整理中…（会流式上屏）"}
                {phase === "cancelled" &&
                  (noteText.trim()
                    ? "已取消 —— 上面是已生成的部分"
                    : "已取消 —— 还没生成任何内容，未存入笔记库")}
                {phase === "done" && verify && (
                  verify.ok ? (
                    <span className="note-ok">✓ 校验通过：笔记词条均来自生词本</span>
                  ) : (
                    <span className="note-warn">
                      ⚠ 有 {verify.unknownHeadings.length} 个标题未在生词本找到：
                      {verify.unknownHeadings.join("、")}（可能是模型改写了词头，注意核对）
                    </span>
                  )
                )}
                {savedMeta && <span className="note-ok"> · 已自动存入笔记库</span>}
                {!savedMeta && saveError && <span className="note-warn"> · 存入笔记库失败：{saveError}（仍可复制/另存为）</span>}
              </div>
              <div className="reader-note-actions">
                {phase === "generating" ? (
                  <button
                    className="btn btn-secondary"
                    onClick={() => void cancelTranslation(tagRef.current)}
                  >
                    取消生成
                  </button>
                ) : (
                  <>
                    <button className="btn btn-secondary" onClick={() => void copyNote()}>
                      复制
                    </button>
                    <button
                      className="btn btn-secondary"
                      disabled={!noteText.trim()}
                      onClick={() => void exportNote()}
                    >
                      另存为…
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={!savedMeta}
                      onClick={openInLibrary}
                    >
                      在笔记库打开
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="reader-import-body">
            <div className="intake-fail">
              <div className="t">笔记生成失败</div>
              <div className="d">{error || "请检查翻译接口配置后重试"}</div>
              <div className="intake-fail-btns">
                <button className="btn btn-secondary" onClick={() => void generate()}>
                  重试
                </button>
                <button className="btn btn-secondary" onClick={() => setPhase("select")}>
                  返回选词
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
