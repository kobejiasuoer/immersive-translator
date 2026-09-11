/**
 * 导入弹窗（替代 window.prompt）：大粘贴区 + 实时词数/段数 + 首行标题
 * 识别预览（可改）+ .txt 文件选择，Ctrl+Enter 直接开始。
 * 书架「+」与空书架首屏统一走这里；热键导入不经弹窗（直接进书架）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { countWords, detectTitleFromText } from "../core/articleBuilder";
import { splitParagraphs } from "../core/sentenceSplit";

interface Props {
  onImport: (text: string, title?: string) => void;
  onClose: () => void;
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;

export function ImportDialog({ onImport, onClose }: Props) {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [fileError, setFileError] = useState("");
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  const trimmed = text.trim();
  const detected = useMemo(() => detectTitleFromText(text), [text]);
  const stats = useMemo(() => {
    if (!trimmed) return null;
    return { words: countWords(trimmed), paras: splitParagraphs(trimmed).length };
  }, [trimmed]);

  const submit = useCallback(() => {
    if (!trimmed) return;
    onImport(text, title.trim() || undefined);
  }, [trimmed, text, title, onImport]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, submit]);

  function pickFile(file: File | undefined) {
    setFileError("");
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setFileError("文件超过 4MB，请确认是纯文本文章");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? "");
      if (content.trim()) setText(content);
      else setFileError("文件是空的");
    };
    reader.onerror = () => setFileError("读取文件失败");
    reader.readAsText(file);
  }

  let chip: React.ReactNode = null;
  const titleDraft = title.trim();
  if (titleDraft) {
    chip = (
      <>
        使用你填写的标题：<b>《{titleDraft}》</b>
      </>
    );
  } else if (detected) {
    chip = (
      <>
        ✓ 识别首行为标题：<b>《{detected}》</b>（可在上方修改）
      </>
    );
  } else if (trimmed) {
    chip = <>首行含句末标点或超长，不作为标题 —— 将从正文自动取一句做标题</>;
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="reader-import-modal" role="dialog" aria-modal="true" aria-label="导入文章">
        <div className="reader-import-head">
          <div>
            <h3>导入文章</h3>
            <p>粘贴英文原文，空行自动分段 · 生成句对译文后立即开始精读</p>
          </div>
          <button className="reader-tb-btn" onClick={onClose} title="关闭 (Esc)">
            ✕
          </button>
        </div>
        <div className="reader-import-body">
          <label className="reader-import-label" htmlFor="reader-import-title">
            标题（可选）
          </label>
          <input
            id="reader-import-title"
            className="reader-import-title-input"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="留空则自动识别首行作为标题（≤80 字符且无句末标点）"
          />
          <textarea
            ref={areaRef}
            className="reader-import-area"
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              "粘贴英文文章…\n\n空行分段；第一行若像标题会自动识别。\n\n例：\nThe Speed of Reading\n\nReading speed was the goal, and comprehension was the test."
            }
          />
          {fileError && <div className="reader-import-error">{fileError}</div>}
          {chip && <div className="reader-import-chip">{chip}</div>}
          <div className="reader-import-meta">
            <span>{stats ? `${stats.words.toLocaleString()} 词 · ${stats.paras} 段` : "0 词 · 0 段"}</span>
            <span>
              <span className="kbd">Ctrl</span>+<span className="kbd">Enter</span> 直接开始
            </span>
          </div>
        </div>
        <div className="reader-import-foot">
          <button className="reader-import-txt-btn" onClick={() => fileRef.current?.click()}>
            打开 .txt 文件…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,text/plain"
            style={{ display: "none" }}
            onChange={(e) => {
              pickFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-secondary" onClick={onClose}>
              取消
            </button>
            <button className="btn btn-primary" disabled={!trimmed} onClick={submit}>
              开始阅读
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
