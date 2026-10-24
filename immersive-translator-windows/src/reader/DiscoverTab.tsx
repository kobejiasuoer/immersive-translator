/**
 * 发现书库 tab（升级计划 B2）：服务端公版书目目录 → 选书下载镜像 EPUB →
 * 构造 File 交给 EpubTab 既有管线（parseEpub → 预览 → 入库），本组件只做
 * 「导入管线前面的目录页」，不重复预览/入库逻辑。
 *
 * - 目录：GET /v1/books 匿名只读；q/grade 筛选 + 「加载更多」分页。
 * - 下载：booksDownload 拿 base64 字节 → sha256 校验 → onDeliver(file, bookId)
 *   上抛（ImportDialog 层 setPendingEpub + setTab("epub") 接力）。
 * - 失败双口径：目录级整块换 intake-fail 卡片（含重试），下载级换行内态
 *   （红字 + 重新下载），全部中文文案出自 lib/discoverCatalog.ts，绝不白屏。
 * - 断点语义：base64/校验失败留在本页行内，不上抛半成品；parseEpub 失败由
 *   EpubTab 既有 error 卡片兜底。
 * - 未登录口径：匿名可用，tab 恒可见（与 A1 场景目录一致）；埋点 discover_view
 *   未登录/失败由 track 静默吞掉。每次进入发现 tab 计一次（条件渲染下挂载即
 *   曝光，与 ImportDialog tab 激活埋点同语义，不做 session 去重）。
 */

import { useCallback, useEffect, useState } from "react";
import { track } from "../lib/analytics";
import { booksDownload, booksList, onBooksDownloadProgress } from "../lib/tauriBridge";
import {
  DISCOVER_BODY_ERROR_TEXT,
  bytesFromBase64,
  discoverDownloadErrorText,
  discoverInvokeErrorText,
  discoverListErrorText,
  epubFileOf,
  formatFileSize,
  GRADE_LABELS,
  parseBooksPage,
  verifyEpubSha256,
  type DiscoverBook,
} from "../lib/discoverCatalog";

/** 目录分页大小（服务端默认 20，显式传参固定口径）。 */
const PAGE_SIZE = 20;

interface DownloadState {
  bookId: string;
  received: number;
  total: number;
}

interface DownloadErrorState {
  bookId: string;
  text: string;
}

export interface DiscoverTabProps {
  /** 下载校验通过后上抛：File 交给 parseEpub，bookId 作 sourceBookId 透传到入库埋点。 */
  onDeliver: (file: File, sourceBookId: string) => void;
}

export function DiscoverTab({ onDeliver }: DiscoverTabProps) {
  // 目录级状态机：loading（含换筛选/重试）/ ready / error（整块 intake-fail 卡片）。
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState("");
  const [list, setList] = useState<DiscoverBook[]>([]);
  const [total, setTotal] = useState(0);
  /** 已载页数（加载更多从 page+1 继续）。 */
  const [page, setPage] = useState(0);

  // 筛选：qDraft 是输入框受控值，applied 是已生效口径（Enter/按钮/切难度才生效）。
  const [qDraft, setQDraft] = useState("");
  const [applied, setApplied] = useState<{ q: string; grade: string }>({ q: "", grade: "" });

  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");

  // 下载态：同一时刻至多一个在途（全部下载按钮 disabled 防连点触发 429）。
  const [download, setDownload] = useState<DownloadState | null>(null);
  const [downloadError, setDownloadError] = useState<DownloadErrorState | null>(null);

  /** 拉一页目录。append=false 为整块替换（首拉/筛选/重试），true 为加载更多
   *  （失败只记 moreError 不动已加载内容）。 */
  const fetchPage = useCallback(
    async (opts: { q?: string; grade?: string; pageToLoad: number; append: boolean }) => {
      const { q, grade, pageToLoad, append } = opts;
      if (append) {
        setLoadingMore(true);
        setMoreError("");
      } else {
        setPhase("loading");
      }
      try {
        const http = await booksList({ q, grade, page: pageToLoad, perPage: PAGE_SIZE });
        if (http.status !== 200) {
          const text = discoverListErrorText(http);
          if (append) setMoreError(text);
          else {
            setErrorText(text);
            setPhase("error");
          }
          return;
        }
        const parsed = parseBooksPage(http.body);
        if (!parsed) {
          if (append) setMoreError(DISCOVER_BODY_ERROR_TEXT);
          else {
            setErrorText(DISCOVER_BODY_ERROR_TEXT);
            setPhase("error");
          }
          return;
        }
        setList((prev) => (append ? [...prev, ...parsed.books] : parsed.books));
        setTotal(parsed.total);
        setPage(pageToLoad);
        setPhase("ready");
      } catch (err) {
        const text = discoverInvokeErrorText(err);
        if (append) setMoreError(text);
        else {
          setErrorText(text);
          setPhase("error");
        }
      } finally {
        if (append) setLoadingMore(false);
      }
    },
    [],
  );

  // 挂载：曝光埋点 + 订阅下载进度（函数式 setDownload 按 bookId 匹配更新，
  // disposed flag 防 unlisten promise 竞态——切 tab 即卸载，进度事件不再落地）。
  useEffect(() => {
    track("discover_view", {});
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onBooksDownloadProgress((p) => {
      setDownload((d) => (d && d.bookId === p.bookId ? { bookId: p.bookId, received: p.received, total: p.total } : d));
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    void fetchPage({ pageToLoad: 1, append: false });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [fetchPage]);

  const applySearch = useCallback(() => {
    const q = qDraft.trim();
    setApplied((a) => ({ ...a, q }));
    void fetchPage({ q: q || undefined, grade: applied.grade || undefined, pageToLoad: 1, append: false });
  }, [qDraft, applied.grade, fetchPage]);

  const changeGrade = useCallback(
    (grade: string) => {
      setApplied((a) => ({ ...a, grade }));
      void fetchPage({ q: applied.q || undefined, grade: grade || undefined, pageToLoad: 1, append: false });
    },
    [applied.q, fetchPage],
  );

  const retry = useCallback(() => {
    void fetchPage({ q: applied.q || undefined, grade: applied.grade || undefined, pageToLoad: 1, append: false });
  }, [applied.q, applied.grade, fetchPage]);

  const loadMore = useCallback(() => {
    void fetchPage({ q: applied.q || undefined, grade: applied.grade || undefined, pageToLoad: page + 1, append: true });
  }, [applied.q, applied.grade, page, fetchPage]);

  /** 下载一本书：非 200 / base64 损坏 / sha256 不匹配都留在行内，成功才 onDeliver。 */
  const startDownload = useCallback(
    async (book: DiscoverBook) => {
      if (download) return;
      setDownloadError(null);
      setDownload({ bookId: book.id, received: 0, total: 0 });
      try {
        const http = await booksDownload(book.id);
        if (http.status !== 200) {
          setDownloadError({ bookId: book.id, text: discoverDownloadErrorText(http) });
          setDownload(null);
          return;
        }
        let bytes: Uint8Array;
        try {
          bytes = bytesFromBase64(http.body);
        } catch {
          setDownloadError({ bookId: book.id, text: "下载的数据损坏，请重试" });
          setDownload(null);
          return;
        }
        if (!(await verifyEpubSha256(bytes, book.sha256))) {
          setDownloadError({ bookId: book.id, text: "下载的文件校验失败，请重新下载" });
          setDownload(null);
          return;
        }
        setDownload(null);
        onDeliver(epubFileOf(book, bytes), book.id);
      } catch (err) {
        setDownloadError({ bookId: book.id, text: discoverInvokeErrorText(err) });
        setDownload(null);
      }
    },
    [download, onDeliver],
  );

  return (
    <div className="reader-import-body reader-intake-body discover-body">
      <div className="discover-toolbar">
        <input
          className="discover-search"
          type="text"
          spellCheck={false}
          placeholder="搜索书名 / 作者"
          aria-label="搜索书名 / 作者"
          value={qDraft}
          onChange={(e) => setQDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") applySearch();
          }}
        />
        <select
          className="discover-grade-select"
          aria-label="难度筛选"
          value={applied.grade}
          onChange={(e) => changeGrade(e.target.value)}
        >
          <option value="">全部难度</option>
          <option value="easy">入门</option>
          <option value="medium">进阶</option>
          <option value="hard">挑战</option>
        </select>
        <button className="btn btn-secondary btn-sm" onClick={applySearch}>
          搜索
        </button>
      </div>

      {phase === "loading" && (
        <div className="intake-skel">
          <div className="intake-skel-line w40" />
          <div className="intake-skel-line w85" />
          <div className="intake-skel-line w85" />
          <div className="intake-skel-line w60" />
          <div className="intake-skel-phase">正在加载书库目录…</div>
        </div>
      )}

      {phase === "error" && (
        <div className="intake-fail">
          <div className="t">没能加载书库</div>
          <div className="d">{errorText}</div>
          <div className="intake-fail-btns">
            <button className="btn btn-secondary" onClick={retry}>
              重试
            </button>
          </div>
        </div>
      )}

      {phase === "ready" && (
        <>
          <div className="discover-count">共 {total.toLocaleString()} 本</div>
          <div className="discover-list">
            {list.map((book) => {
              const dl = download && download.bookId === book.id ? download : null;
              const derr = downloadError && downloadError.bookId === book.id ? downloadError : null;
              return (
                <div className="discover-card" key={book.id}>
                  <span className="discover-cover" aria-hidden>
                    {book.coverEmoji || "📘"}
                  </span>
                  <div className="discover-info">
                    <div className="discover-title serif">{book.title}</div>
                    <div className="discover-author">{book.author}</div>
                    <div className="discover-meta">
                      <span className={`discover-grade-chip g-${book.grade}`}>
                        {GRADE_LABELS[book.grade] ?? book.grade}
                      </span>
                      {book.wordCount !== undefined && (
                        <span>{book.wordCount.toLocaleString()} 词</span>
                      )}
                      <span>{formatFileSize(book.fileSizeBytes)}</span>
                    </div>
                    {book.description && (
                      <div className="discover-desc" title={book.description}>
                        {book.description}
                      </div>
                    )}
                    <div className="discover-license" title={book.licenseUrl}>
                      许可：{book.licenseName}
                    </div>
                  </div>
                  <div className="discover-action">
                    {dl ? (
                      <div className="discover-dl-progress">
                        {dl.total > 0
                          ? `${formatFileSize(dl.received)} / ${formatFileSize(dl.total)}…`
                          : `下载中…${formatFileSize(dl.received)}`}
                      </div>
                    ) : derr ? (
                      <>
                        <div className="discover-dl-error">{derr.text}</div>
                        <button
                          className="btn btn-secondary btn-sm"
                          disabled={!!download}
                          onClick={() => void startDownload(book)}
                        >
                          重新下载
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={!!download}
                        onClick={() => void startDownload(book)}
                      >
                        下载 · {formatFileSize(book.fileSizeBytes)}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {list.length < total && (
            <button
              className="btn btn-secondary btn-sm discover-more"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? "正在加载…" : `加载更多（${list.length}/${total}）`}
            </button>
          )}
          {moreError && <div className="discover-more-error">{moreError}</div>}
        </>
      )}
    </div>
  );
}
