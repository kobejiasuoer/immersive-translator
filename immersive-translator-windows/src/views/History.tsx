import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  historyList,
  historyToggleFavorite,
  historyDelete,
  historyClearNonFavorites,
  historyExport,
  type HistoryRecord,
  type ExportFormat,
} from "../lib/tauriBridge";
import {
  IconSearch,
  IconStar,
  IconTrash,
  IconCopy,
  IconCopyAll,
  IconCheck,
  IconClock,
  IconCrop,
  IconChevronDown,
  IconAlert,
} from "../ui/icons";
import { ConfirmDialog } from "../ui/ConfirmDialog";

type FavFilter = "all" | "favorites";

type ConfirmAction =
  | { mode: "deleteOne"; id: string }
  | { mode: "deleteBatch"; ids: string[] }
  | { mode: "clearNonFavorites" }
  | null;

/**
 * 翻译历史窗口。对齐 Mac TranslationHistoryView：
 * - 搜索（原文/译文/语言/来源；支持「收藏」「未收藏」「ocr」关键词）
 * - 收藏 / 取消收藏
 * - 删除单条 / 清空非收藏
 * - 导出 CSV / JSON / Markdown / 纯文本
 */
export function History() {
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [query, setQuery] = useState("");
  const [favFilter, setFavFilter] = useState<FavFilter>("all");
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  /** 批量选择：卡片勾选集合。 */
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  /** 待确认的危险操作。 */
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenP = win.onCloseRequested((event) => {
      event.preventDefault();
      void win.hide();
    });
    return () => {
      void unlistenP.then((u) => u());
    };
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const list = await historyList(query);
      const shown = favFilter === "favorites" ? list.filter((r) => r.isFavorite) : list;
      setRecords(shown);
      // 结果变化后，把选择集里已不存在的 id 清理掉
      setSelection((prev) => {
        if (prev.size === 0) return prev;
        const keep = new Set<string>();
        for (const r of shown) if (prev.has(r.id)) keep.add(r.id);
        return keep.size === prev.size ? prev : keep;
      });
    } catch (e) {
      showToast(`加载失败：${e}`, false);
    } finally {
      setLoading(false);
    }
  }

  // 首次加载 + 收藏筛选变化时刷新
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favFilter]);

  // 搜索输入防抖（避免每次按键都查）
  useEffect(() => {
    const t = setTimeout(() => void refresh(), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function showToast(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 2000);
  }

  async function handleToggleFav(id: string) {
    await historyToggleFavorite(id);
    await refresh();
  }

  // ---- 选择集操作 ----
  const hasRecords = records.length > 0;
  const selectedRecords = records.filter((r) => selection.has(r.id));
  const allSelected = hasRecords && selection.size === records.length;

  function toggleSelect(id: string) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelection(allSelected ? new Set() : new Set(records.map((r) => r.id)));
  }

  async function copySelectedTranslations() {
    const text = selectedRecords.map((r) => r.translation).join("\n\n");
    await navigator.clipboard.writeText(text);
    showToast(`已复制 ${selectedRecords.length} 条译文`);
  }

  // ---- 危险操作：先弹内嵌确认 ----
  function handleDelete(id: string) {
    setConfirmAction({ mode: "deleteOne", id });
  }

  function handleDeleteSelected() {
    if (selectedRecords.length === 0) return;
    setConfirmAction({ mode: "deleteBatch", ids: selectedRecords.map((r) => r.id) });
  }

  function handleClearNonFavorites() {
    setConfirmAction({ mode: "clearNonFavorites" });
  }

  async function runConfirmedAction() {
    const action = confirmAction;
    setConfirmAction(null);
    if (!action) return;
    try {
      if (action.mode === "deleteOne") {
        await historyDelete(action.id);
        showToast("已删除");
      } else if (action.mode === "deleteBatch") {
        for (const id of action.ids) await historyDelete(id);
        showToast(`已删除 ${action.ids.length} 条`);
      } else {
        const n = await historyClearNonFavorites();
        showToast(`已清空 ${n} 条`);
      }
    } catch (e) {
      showToast(`操作失败：${e}`, false);
    } finally {
      setSelection(new Set());
      await refresh();
    }
  }

  async function handleExport(format: ExportFormat) {
    try {
      const text = await historyExport(query || null, favFilter === "favorites", format);
      await navigator.clipboard.writeText(text);
      showToast(`已复制到剪贴板（${format.toUpperCase()}）`);
    } catch (e) {
      showToast(`导出失败：${e}`, false);
    }
  }

  return (
    <div className="history-page">
      {/* 顶部：搜索 + 筛选 */}
      <div className="history-toolbar">
        <div className="search-box">
          <IconSearch size={14} />
          <input
            className="input"
            placeholder="搜索原文 / 译文 / 语言，或输入「收藏」「ocr」"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="seg">
          <button
            className={favFilter === "all" ? "active" : ""}
            onClick={() => setFavFilter("all")}
          >
            全部
          </button>
          <button
            className={favFilter === "favorites" ? "active" : ""}
            onClick={() => setFavFilter("favorites")}
          >
            <IconStar size={12} filled />
            收藏
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: "var(--text-3)" }}>
          {loading ? "加载中…" : `${records.length} 条`}
        </span>
      </div>

      {/* 次栏：选择 / 导出 / 清空 */}
      <div className="history-subbar">
        {hasRecords && (
          <label
            className="favCheck"
            style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", marginRight: 4 }}
          >
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleSelectAll}
            />
            全选
          </label>
        )}
        <span>导出 / 复制：</span>
        <button className="btn btn-ghost btn-sm" onClick={() => void handleExport("csv")}>
          CSV
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => void handleExport("json")}>
          JSON
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => void handleExport("markdown")}>
          Markdown
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => void handleExport("text")}>
          纯文本
        </button>
        <div style={{ flex: 1 }} />
        <button
          className="btn btn-ghost btn-sm"
          style={{ color: "var(--err)" }}
          onClick={() => void handleClearNonFavorites()}
          disabled={!hasRecords}
        >
          <IconTrash size={12} />
          清空未收藏
        </button>
      </div>

      {/* 批量操作条：勾选后出现 */}
      {selectedRecords.length > 0 && (
        <div className="history-subbar" style={{ background: "var(--accent-softer)", borderTop: "none" }}>
          <span style={{ color: "var(--accent)", fontWeight: 600 }}>
            已选 {selectedRecords.length} 条
          </span>
          <div style={{ flex: 1 }} />
          <button className="btn btn-secondary btn-sm" onClick={() => void copySelectedTranslations()}>
            <IconCopy size={12} />
            复制所选译文
          </button>
          <button
            className="btn btn-outline-danger btn-sm"
            onClick={handleDeleteSelected}
          >
            <IconTrash size={12} />
            删除所选
          </button>
        </div>
      )}

      {/* 列表 */}
      <div className="history-list">
        {loading && (
          <div className="empty">
            <div className="spinner" style={{ margin: "0 auto" }} />
          </div>
        )}
        {!loading && !hasRecords && (
          <div className="empty">
            {query || favFilter === "favorites" ? (
              <>
                <IconSearch size={26} />
                <div className="empty-title">没有匹配的记录</div>
                换个关键词或筛选条件试试
              </>
            ) : (
              <>
                <IconClock size={26} />
                <div className="empty-title">还没有翻译历史</div>
                选中文本按热键翻译后，会记录在这里
              </>
            )}
          </div>
        )}
        {!loading &&
          records.map((r) => (
            <HistoryCard
              key={r.id}
              record={r}
              selected={selection.has(r.id)}
              onToggleSelect={() => toggleSelect(r.id)}
              onToggleFav={() => handleToggleFav(r.id)}
              onDelete={() => handleDelete(r.id)}
              onCopied={(msg) => showToast(msg)}
            />
          ))}
      </div>

      {toast && (
        <div className="toast">
          {toast.ok ? <IconCheck size={13} /> : <IconAlert size={13} />}
          {toast.msg}
        </div>
      )}

      <ConfirmDialog
        open={confirmAction !== null}
        title={
          confirmAction?.mode === "clearNonFavorites"
            ? "清空未收藏记录"
            : confirmAction?.mode === "deleteBatch"
              ? `删除所选 ${confirmAction.ids.length} 条记录`
              : "删除这条记录"
        }
        message={
          confirmAction?.mode === "clearNonFavorites" ? (
            <>将删除所有<strong>未收藏</strong>的翻译历史，此操作不可撤销。</>
          ) : confirmAction?.mode === "deleteBatch" ? (
            <>将永久删除选中的 {confirmAction.ids.length} 条记录，此操作不可撤销。</>
          ) : (
            <>将永久删除这条记录，此操作不可撤销。</>
          )
        }
        confirmText="删除"
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => void runConfirmedAction()}
      />
    </div>
  );
}

function HistoryCard({
  record,
  selected,
  onToggleSelect,
  onToggleFav,
  onDelete,
  onCopied,
}: {
  record: HistoryRecord;
  selected: boolean;
  onToggleSelect: () => void;
  onToggleFav: () => void;
  onDelete: () => void;
  onCopied: (msg: string) => void;
}) {
  const time = useMemo(() => formatTime(record.createdAt), [record.createdAt]);
  const [expanded, setExpanded] = useState(false);
  const isOcr = record.source === "ocr";

  async function copyTrans() {
    await navigator.clipboard.writeText(record.translation);
    onCopied("已复制译文");
  }
  async function copyBoth() {
    await navigator.clipboard.writeText(`${record.original}\n\n${record.translation}`);
    onCopied("已复制原文+译文");
  }

  return (
    <div className={`history-card${expanded ? " expanded" : ""}${selected ? " selected" : ""}`}>
      <div className="meta">
        <input
          type="checkbox"
          className="hist-select"
          checked={selected}
          onChange={onToggleSelect}
          title={selected ? "取消选择" : "选择"}
        />
        <span className={`chip ${isOcr ? "chip-amber" : "chip-blue"}`}>
          {isOcr ? <IconCrop size={10} /> : <IconSearch size={10} />}
          {isOcr ? "OCR" : "选中"}
        </span>
        <span className="lang">{record.targetLanguage || "—"}</span>
        <span>{time}</span>
        <span className="model">{record.model}</span>
        <span className="chip chip-gray">{(record.elapsedMs / 1000).toFixed(1)}s</span>
        <span className="spacer" />
        <div className="actions">
          <button className="icon-btn" title="复制译文" onClick={() => void copyTrans()}>
            <IconCopy size={14} />
          </button>
          <button className="icon-btn" title="复制原文+译文" onClick={() => void copyBoth()}>
            <IconCopyAll size={14} />
          </button>
          <button
            className={`icon-btn${record.isFavorite ? " active" : ""}`}
            title={record.isFavorite ? "取消收藏" : "收藏"}
            onClick={onToggleFav}
          >
            <IconStar size={14} filled={record.isFavorite} />
          </button>
          <button className="icon-btn" style={{ color: "var(--err)" }} title="删除" onClick={onDelete}>
            <IconTrash size={14} />
          </button>
        </div>
      </div>
      <div className="orig">{record.original}</div>
      <div className="trans">{record.translation}</div>
      <div style={{ display: "flex", justifyContent: "center", marginTop: 2 }}>
        <button
          className="btn btn-ghost btn-sm"
          style={{ fontSize: 11, color: "var(--text-4)" }}
          onClick={() => setExpanded((v) => !v)}
        >
          <IconChevronDown size={12} style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
          {expanded ? "收起" : "展开全文"}
        </button>
      </div>
    </div>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}
