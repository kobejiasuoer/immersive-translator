/**
 * 导入弹窗（内容进水口）：三个入口 —— 内置文库（默认）/ 网页链接抓取 / 粘贴文本。
 *
 * - 文库：今日一篇 hero + 分级书单，覆盖数随「考试目标」联动（考研/四级/六级），
 *   未掌握数与生词本 SRS 状态同源（intervalDays < 7）。
 * - 链接：Rust 端抓正文（去导航/广告），前端展示预览（词数/时长/难度/覆盖），
 *   失败态给出原因与「切到粘贴文本」退路。
 * - 粘贴：原有能力原样保留。Ctrl+Enter 直接开始（粘贴页）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { countWords, detectTitleFromText } from "../core/articleBuilder";
import { splitParagraphs } from "../core/sentenceSplit";
import {
  LIBRARY,
  todayLibraryItem,
  type LibraryItem,
} from "../core/library";
import {
  coverageForText,
  EXAM_GOALS,
  EXAM_GOAL_LABELS,
  type ExamGoal,
} from "../core/examCoverage";
import { readerFetchUrl } from "../lib/webExtract";
import type { ArticleSourceType, ArticleSummary, VocabWord } from "../core/readerTypes";

export interface ImportMeta {
  sourceType?: ArticleSourceType;
  sourceUrl?: string;
  level?: string;
  titleCn?: string;
}

interface Props {
  vocabWords: VocabWord[];
  articles: ArticleSummary[];
  onImport: (text: string, title?: string, meta?: ImportMeta) => void;
  onClose: () => void;
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const GOAL_STORAGE_KEY = "intake-exam-goal";

type TabId = "lib" | "url" | "paste";

interface UrlPreview {
  url: string;
  host: string;
  title: string;
  text: string;
}

function estimateLevel(text: string, sentences: number): string {
  const words = countWords(text);
  if (sentences === 0 || words === 0) return "B1";
  const avgLen = words / sentences;
  if (avgLen <= 13) return "A2";
  if (avgLen <= 17) return "B1";
  if (avgLen <= 22) return "B2";
  return "C1";
}

export function ImportDialog({ vocabWords, articles, onImport, onClose }: Props) {
  const [tab, setTab] = useState<TabId>("lib");
  const [goal, setGoal] = useState<ExamGoal>(() => {
    const saved = localStorage.getItem(GOAL_STORAGE_KEY);
    return saved && (EXAM_GOALS as string[]).includes(saved) ? (saved as ExamGoal) : "kaoyan";
  });
  const shelfLibIds = useMemo(
    () =>
      new Set(
        articles
          .map((a) => (a.sourceUrl?.startsWith("library:") ? a.sourceUrl.slice("library:".length) : null))
          .filter((x): x is string => !!x),
      ),
    [articles],
  );

  useEffect(() => {
    localStorage.setItem(GOAL_STORAGE_KEY, goal);
  }, [goal]);

  // Esc 关闭（粘贴页的 Ctrl+Enter 在子组件里处理）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const importLibraryItem = useCallback(
    (item: LibraryItem) => {
      onImport(item.text, item.en, {
        sourceType: "paste",
        sourceUrl: `library:${item.id}`,
        level: item.level,
        titleCn: `${item.cn} · ${item.author}`,
      });
    },
    [onImport],
  );

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="reader-import-modal reader-intake-modal" role="dialog" aria-modal="true" aria-label="添加阅读内容">
        <div className="reader-import-head">
          <div>
            <h3>添加阅读内容</h3>
            <p>从文库挑一篇、抓一篇网页文章，或粘贴自己的文本 —— 入库后逐句精读，生词自动进生词本</p>
          </div>
          <button className="reader-tb-btn" onClick={onClose} title="关闭 (Esc)">
            ✕
          </button>
        </div>
        <div className="reader-intake-tabs" role="tablist">
          {(
            [
              ["lib", "内置文库"],
              ["url", "网页链接"],
              ["paste", "粘贴文本"],
            ] as [TabId, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "on" : ""}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "lib" && (
          <LibraryTab
            goal={goal}
            onGoalChange={setGoal}
            vocabWords={vocabWords}
            shelfLibIds={shelfLibIds}
            onImportItem={importLibraryItem}
          />
        )}
        {tab === "url" && <UrlTab onImport={onImport} onSwitchToPaste={() => setTab("paste")} />}
        {tab === "paste" && <PasteTab onImport={onImport} />}
      </div>
    </div>
  );
}

// ---------------- 内置文库 ----------------

function LibraryTab({
  goal,
  onGoalChange,
  vocabWords,
  shelfLibIds,
  onImportItem,
}: {
  goal: ExamGoal;
  onGoalChange: (g: ExamGoal) => void;
  vocabWords: VocabWord[];
  shelfLibIds: Set<string>;
  onImportItem: (item: LibraryItem) => void;
}) {
  const hero = todayLibraryItem();
  const heroCov = coverageForText(hero.text, goal, vocabWords);
  const rest = LIBRARY.filter((i) => i.id !== hero.id);
  return (
    <div className="reader-import-body reader-intake-body">
      <div className="intake-hero">
        <div className="intake-hero-mark" aria-hidden>
          {hero.en.charAt(0)}
        </div>
        <div className="intake-hero-body">
          <div className="intake-hero-chips">
            <span className="intake-lvl">{hero.level}</span>
            <span className="intake-hero-note">今日一篇 · 每天换一篇，按你的生词本挑</span>
          </div>
          <h4 className="serif">{hero.en}</h4>
          <div className="intake-hero-cn">
            {hero.cn} · {hero.author}
          </div>
          <p className="intake-hero-quote serif">{hero.quote}</p>
          <div className="intake-hero-meta">
            <span className="intake-cov">
              {EXAM_GOAL_LABELS[goal]}大纲词 {heroCov.total}
              {heroCov.unmastered > 0 && (
                <em> · {heroCov.unmastered} 个未掌握</em>
              )}
            </span>
            <span>
              {hero.words.toLocaleString()} 词 · 约 {hero.minutes} 分钟
            </span>
          </div>
          <div className="intake-hero-foot">
            <button
              className="btn btn-primary"
              disabled={shelfLibIds.has(hero.id)}
              onClick={() => onImportItem(hero)}
            >
              {shelfLibIds.has(hero.id) ? "已在书架" : "开始阅读"}
            </button>
            <span className="intake-hero-why">
              {heroCov.unmastered > 0
                ? `其中 ${heroCov.unmastered} 个词在你的生词本里`
                : "与你的生词本几乎没有重合，适合轻松读"}
            </span>
          </div>
        </div>
      </div>

      <div className="intake-goal-row">
        <span className="intake-goal-label">按考试目标看覆盖：</span>
        {EXAM_GOALS.map((g) => (
          <button
            key={g}
            className={`intake-goal-chip${goal === g ? " on" : ""}`}
            onClick={() => onGoalChange(g)}
          >
            {EXAM_GOAL_LABELS[g]}
          </button>
        ))}
      </div>

      <div className="intake-booklist">
        {rest.map((item) => {
          const cov = coverageForText(item.text, goal, vocabWords);
          const owned = shelfLibIds.has(item.id);
          return (
            <div className="intake-book-row" key={item.id}>
              <span className="intake-lvl">{item.level}</span>
              <div className="intake-book-main">
                <span className="intake-book-title serif">{item.en}</span>
                <span className="intake-book-cn">
                  {item.cn} · {item.author}
                </span>
              </div>
              <span className="intake-book-meta">
                {item.words.toLocaleString()} 词
                <br />约 {item.minutes} 分钟
              </span>
              <span className="intake-book-cov">
                {EXAM_GOAL_LABELS[goal]}大纲词 {cov.total} · <em>{cov.unmastered} 未掌握</em>
              </span>
              <button className="btn btn-secondary btn-sm" disabled={owned} onClick={() => onImportItem(item)}>
                {owned ? "已在书架" : "加入书架"}
              </button>
            </div>
          );
        })}
      </div>
      <div className="intake-lib-foot">
        文库文本取自公版书（Standard Ebooks 整理本）；覆盖数 = 篇内出现的大纲词个数，
        <em>橙色</em>为你生词本里还没掌握的。更多篇目与词表陆续接入。
      </div>
    </div>
  );
}

// ---------------- 网页链接 ----------------

function UrlTab({
  onImport,
  onSwitchToPaste,
}: {
  onImport: (text: string, title?: string, meta?: ImportMeta) => void;
  onSwitchToPaste: () => void;
}) {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<"idle" | "loading" | "preview" | "error">("idle");
  const [preview, setPreview] = useState<UrlPreview | null>(null);
  const [error, setError] = useState("");
  const [vocabWords, setVocabWords] = useState<VocabWord[]>([]);
  const [goal, setGoal] = useState<ExamGoal>(() => {
    const saved = localStorage.getItem(GOAL_STORAGE_KEY);
    return saved && (EXAM_GOALS as string[]).includes(saved) ? (saved as ExamGoal) : "kaoyan";
  });

  useEffect(() => {
    // 覆盖数要跟生词本对齐；弹窗生命周期短，直接拉一次即可。
    import("../lib/readerStore")
      .then((m) => m.readerGetVocab())
      .then((f) => setVocabWords(f.words ?? []))
      .catch(() => undefined);
  }, []);

  const valid = /^https?:\/\/.+\..+/.test(url.trim());

  const doFetch = useCallback(async () => {
    const target = url.trim();
    if (!valid || phase === "loading") return;
    setPhase("loading");
    setError("");
    try {
      const res = await readerFetchUrl(target);
      setPreview({ url: target, host: res.host, title: res.title, text: res.text });
      setPhase("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [url, valid, phase]);

  const stats = useMemo(() => {
    if (!preview) return null;
    const words = countWords(preview.text);
    const paras = splitParagraphs(preview.text);
    const sentenceCount = paras.reduce((n, p) => n + p.sentences.length, 0);
    return {
      words,
      paras: paras.length,
      minutes: Math.max(1, Math.round(words / 135)),
      level: estimateLevel(preview.text, Math.max(1, sentenceCount)),
    };
  }, [preview]);

  const cov = useMemo(
    () => (preview && goal ? coverageForText(preview.text, goal, vocabWords) : null),
    [preview, goal, vocabWords],
  );

  if (phase === "loading") {
    return (
      <div className="reader-import-body reader-intake-body">
        <div className="intake-skel">
          <div className="intake-skel-line w40" />
          <div className="intake-skel-line w85" />
          <div className="intake-skel-line w85" />
          <div className="intake-skel-line w60" />
          <div className="intake-skel-phase">正在抓取正文、去掉导航与广告…</div>
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="reader-import-body reader-intake-body">
        <div className="intake-fail">
          <div className="t">没能读取这个链接</div>
          <div className="d">{error}</div>
          <div className="intake-fail-btns">
            <button className="btn btn-secondary" onClick={() => setPhase("idle")}>
              返回重试
            </button>
            <button className="btn btn-secondary" onClick={onSwitchToPaste}>
              切到粘贴文本
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "preview" && preview && stats && cov) {
    return (
      <div className="reader-import-body reader-intake-body">
        <div className="intake-goal-row" style={{ marginTop: 0 }}>
          <span className="intake-goal-label">按考试目标看覆盖：</span>
          {EXAM_GOALS.map((g) => (
            <button key={g} className={`intake-goal-chip${goal === g ? " on" : ""}`} onClick={() => setGoal(g)}>
              {EXAM_GOAL_LABELS[g]}
            </button>
          ))}
        </div>
        <div className="intake-preview">
          <div className="intake-pv-src">{preview.host} · 正文已按段落清洗</div>
          <div className="intake-pv-title serif">{preview.title}</div>
          <div className="intake-pv-meta">
            <span className="intake-lvl">{stats.level}</span>
            <span>
              {stats.words.toLocaleString()} 词 · {stats.paras} 段 · 约 {stats.minutes} 分钟
            </span>
          </div>
          <div className="intake-pv-cov">
            覆盖{EXAM_GOAL_LABELS[goal]}大纲词 <b>{cov.total}</b>
            {cov.unmastered > 0 && (
              <em>
                {" "}
                · {cov.unmastered} 个你还没掌握
              </em>
            )}
          </div>
          <p className="intake-pv-snippet serif">{preview.text.slice(0, 180)}…</p>
          <div className="intake-pv-foot">
            <button
              className="btn btn-primary"
              onClick={() =>
                onImport(preview.text, preview.title, {
                  sourceType: "url",
                  sourceUrl: preview.url,
                  level: stats.level,
                })
              }
            >
              加入书架并开始阅读
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="reader-import-body reader-intake-body">
      <div className="intake-url-row">
        <input
          type="text"
          spellCheck={false}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void doFetch();
          }}
          placeholder="粘贴文章链接，如 https://en.wikipedia.org/wiki/Reading"
          aria-label="文章链接"
        />
        <button className="btn btn-primary" disabled={!valid} onClick={() => void doFetch()}>
          抓取正文
        </button>
      </div>
      <div className="intake-url-hint">支持新闻、博客、维基百科等公开网页；需要登录或付费墙的抓不到，会告诉你原因。</div>
    </div>
  );
}

// ---------------- 粘贴文本（现状保留） ----------------

function PasteTab({ onImport }: { onImport: (text: string, title?: string, meta?: ImportMeta) => void }) {
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
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [submit]);

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
          <button className="btn btn-secondary" onClick={submit} disabled={!trimmed}>
            开始阅读
          </button>
        </div>
      </div>
    </div>
  );
}
