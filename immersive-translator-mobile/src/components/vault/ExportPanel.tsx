/**
 * 导出三选项（vault-review-parity）：JSON 备份（既有行为）/ Markdown 文件 / 复制 Markdown。
 * Markdown 文件名 immersive-learning-YYYY-MM-DD；内容含生词阶段/来源/原句/助记/复习安排、
 * 口语纠偏与笔记全文——全部只读自真实数据。每个动作带成功/失败状态条与重试，不静默吞错。
 */
import { useRef, useState } from "react";
import { flushPersist, useApp, type AppState } from "../../store";
import { invokeRaw, isTauri, shareText, writeClipboard } from "../../services/device";
import { ReadingDrawer } from "../reading/Drawer";
import { formatDueAt, savedCorrections, stageOf, STAGE_LABEL, vocabDerived } from "./derive";
import { Icon } from "../../ui/icons";
import { chineseVocabMeaning, contextExplanationOf } from "../../core/vocabMeaning";

function exportDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function markdownExport(s: AppState, now = Date.now()): string {
  const derived = vocabDerived(s);
  const lines: string[] = [];
  lines.push(`# 沉浸学习导出 · ${exportDate()}`, "");
  lines.push(`生词 ${s.vocab.length} 条 · 口语纠偏 ${savedCorrections(s).length} 条 · 笔记 ${s.notes.length} 篇`, "");
  if (s.vocab.length) {
    lines.push("## 生词本", "");
    for (const w of s.vocab) {
      const d = derived.get(w.id);
      const article = w.sourceArticleId ? s.articles.find((a) => a.id === w.sourceArticleId) : undefined;
      const sent = article?.sentences[w.sourceSentenceIdx];
      lines.push(`### ${w.word}${w.phonetic ? ` \`${w.phonetic}\`` : ""} · ${STAGE_LABEL[stageOf(w)]}`);
      const chinese = chineseVocabMeaning(w), english = contextExplanationOf(w.contextExplanation);
      if (chinese) lines.push(`- 释义：${chinese}`);
      if (english) {
        lines.push(`- 英文解释：${english.meaning}`, `  - 对应语境：${english.sentence}`);
        if (english.example) lines.push(`  - 英文例句：${english.example}`);
      }
      if (article) lines.push(`- 来源：《${article.title}》第 ${w.sourceSentenceIdx + 1} 句`);
      if (sent) {
        lines.push(`- 原句：${sent.en}`);
        if (sent.zh) lines.push(`  - 译文：${sent.zh}`);
      }
      if (w.note) lines.push(`- 助记：${w.note.replace(/\n/g, " ")}`);
      lines.push(`- 复习安排：${w.paused ? "已暂停" : formatDueAt(w.dueAt, now)} · 复习 ${d?.lookups ?? 0} 次 · 开口 ${d?.spoken ?? 0} 次`);
      lines.push("");
    }
  }
  const corrections = savedCorrections(s);
  if (corrections.length) {
    lines.push("## 口语纠偏", "");
    for (const { task, attempt } of corrections) {
      lines.push(`### ${attempt.feedback!.improved.replace(/\n/g, " ")}`);
      lines.push(`- 原话：${attempt.text.replace(/\n/g, " ")}`);
      lines.push(`- 原因：${attempt.feedback!.explanation.replace(/\n/g, " ")}`);
      lines.push(`- 来自这次练习：${task.title}（${new Date(attempt.createdAt).toLocaleString("zh-CN")}）`);
      lines.push("");
    }
  }
  if (s.notes.length) {
    lines.push("## 笔记", "");
    for (const note of s.notes) {
      lines.push(`### ${note.title}`, "", note.body, "");
    }
  }
  return lines.join("\n");
}

type ExportStatus = { state: "idle" | "run" | "ok" | "fail"; msg?: string };

export function ExportPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useApp((s) => s);
  const [status, setStatus] = useState<ExportStatus>({ state: "idle" });
  const lastAction = useRef<null | (() => Promise<void>)>(null);

  async function run(label: string, work: () => Promise<void>) {
    lastAction.current = () => run(label, work);
    setStatus({ state: "run" });
    try {
      await work();
      setStatus({ state: "ok", msg: label });
    } catch (error) {
      setStatus({ state: "fail", msg: error instanceof Error ? error.message : String(error) });
    }
  }

  /* 成功条文案（复检 r1 · 原型 v2ExportDownload/v2ExportCopy，html:3051,3062）：写明生成的文件名；
     原生端走系统分享面板，如实写「已交给系统分享」而非「已发起下载」。 */
  const savedLabel = (file: string) => (isTauri() ? `已生成 ${file} 并交给系统分享，可以保存或发送。` : `已生成 ${file} 并发起下载。若未保存，可以再次下载。`);

  const exportJson = () =>
    run(savedLabel("learning-backup.json"), async () => {
      await flushPersist();
      const data = JSON.stringify({ format: "learning-backup", version: 2, exportedAt: Date.now(), articles: state.articles, vocab: state.vocab, notes: state.notes, reviewEvents: state.reviewEvents, tasks: state.tasks }, null, 2);
      if (isTauri()) {
        await invokeRaw("share_text", { title: "learning-backup-json", text: data });
        return;
      }
      downloadBlob("learning-backup.json", data, "application/json");
    });

  const exportMarkdown = () =>
    run(savedLabel(`immersive-learning-${exportDate()}.md`), async () => {
      const md = markdownExport(state);
      const name = `immersive-learning-${exportDate()}`;
      if (isTauri()) {
        const shared = await shareText(`${name}.md`, md);
        if (!shared) throw new Error("系统分享面板取消或失败，可改用「复制 Markdown」");
        return;
      }
      downloadBlob(`${name}.md`, md, "text/markdown");
    });

  const copyMarkdown = () =>
    run("Markdown 已复制，可以粘贴到笔记工具。", async () => {
      const ok = await writeClipboard(markdownExport(state));
      if (!ok) throw new Error("剪贴板不可用，请改用导出 Markdown 文件");
    });

  return (
    <ReadingDrawer open={open} onClose={onClose} label="导出学习资料">
      {/* 抽屉头（原型 .sh-head：17px 无衬线粗体 + 计数说明 + 下缘分隔线，html:417,3022） */}
      <div className="v2-sh-head">
        <div className="sheet-title plain">把学习记录带走</div>
        <p className="v2-learning-caption">
          {state.vocab.length} 条生词 · {state.notes.length} 条笔记 · {state.vocab.length} 条复习安排
        </p>
      </div>
      <div className="v2-export-options">
        <button className="learning-row" onClick={() => void exportJson()}>
          <span className="ic">
            <Icon name="share" size={16} />
          </span>
          <span className="tx">
            <b>下载 JSON 备份</b>
            <small>完整保留生词、助记、纠偏及复习时间</small>
          </span>
          <Icon name="right" size={15} />
        </button>
        <button className="learning-row" onClick={() => void exportMarkdown()}>
          <span className="ic">
            <Icon name="note" size={16} />
          </span>
          <span className="tx">
            <b>下载 Markdown 笔记</b>
            <small>适合在笔记工具中继续整理和阅读</small>
          </span>
          <Icon name="right" size={15} />
        </button>
        <button className="learning-row" onClick={() => void copyMarkdown()}>
          <span className="ic">
            <Icon name="copy" size={16} />
          </span>
          <span className="tx">
            <b>复制 Markdown</b>
            <small>直接粘贴到自己的笔记里</small>
          </span>
          <Icon name="right" size={15} />
        </button>
      </div>
      {status.state !== "idle" && (
        <p
          role="status"
          aria-live="polite"
          className={status.state === "fail" ? "learning-notice" : "v2-export-success"}
          style={{ marginTop: 14, textAlign: "left" }}
        >
          {status.state === "run" ? "正在导出…" : status.state === "ok" ? status.msg : `导出失败：${status.msg}`}
          {status.state === "fail" && lastAction.current && (
            <>
              {" "}
              <button className="tlink" onClick={() => void lastAction.current!()}>
                重试
              </button>
            </>
          )}
        </p>
      )}
    </ReadingDrawer>
  );
}

function downloadBlob(name: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
