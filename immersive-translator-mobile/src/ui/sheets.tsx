import { openPractice } from "../screens/LearningHome";
/**
 * 底部 sheet 集（§2.2）——词典/词块卡（两级查询 #40/#41）、Aa 面板、语速、
 * 本篇菜单、文内搜索、退出复习确认、陪练小结、直译导出、导入四路、只练差词。
 * 可下拉关闭（治 I6）：>120px 或快速下拉释放关闭（§1.8）。
 */
import { useEffect, useRef, useState } from "react";
import { actions, getState, speak, toast, useApp } from "../store";
import { Icon } from "./icons";
import { Seg } from "./kit";
import { useNav } from "./nav";
import { chatStream, llmConfigured, lookupWord } from "../services/translate";
import { useCloud } from "../services/cloud";
import { canContinueDictionaryLogin } from "../services/authGate";
import { isTauri, readClipboard, shareText, writeClipboard } from "../services/device";
import { norm } from "../core/judge";
import { EXAM_TAGS, LIB_ARTICLES, libMeta, libToday, libToArticle, type LibArticle } from "../core/library";
import { buildSummaryPrompt } from "../core/speak";
import type { ChatTurn } from "../core/demo";
import { getShadowDiffWords, type ShadowDiffWord } from "../core/shadowState";
import { saveSession } from "../core/sessions";
import type { Article } from "../core/types";
import type { DictEntry, DictSenses, Sheet } from "../store";

/* ---------- iOS 键盘避让（治 sheets-2） ----------
   WKWebView 键盘弹起不缩排版视口：fixed bottom:0 的弹层（文内搜索结果、粘贴导入按钮）
   被键盘盖住下半部，需收起键盘才能看到/点到。监听 visualViewport：可视高度与排版视口
   之差 >120px 视为键盘（排除地址栏收缩噪声），写入 --kb-inset 让 .sheet 抬升。
   jsdom/无 visualViewport 环境自动跳过，--kb-inset 回退 0px。 */
if (typeof window !== "undefined" && window.visualViewport) {
  const vv = window.visualViewport;
  const applyKbInset = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--kb-inset", kb > 120 ? `${Math.round(kb)}px` : "0px");
  };
  vv.addEventListener("resize", applyKbInset);
  vv.addEventListener("scroll", applyKbInset);
}

/** txt 字节 → 文本（治 sheets-8 剩余半项）：BOM 识别（UTF-8/UTF-16）→ UTF-8 试解，
 *  出 U+FFFD（多字节序列被劈坏）则按 GB18030（GBK 超集，中文 txt 常见编码）重读——
 *  此前 readAsText 恒按 UTF-8，GBK 文件非 ASCII 部分整篇变替换符并照常入库。 */
function decodeTextFile(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("gb18030").decode(bytes);
  } catch {
    return utf8; // 两边都解不动：保底原 UTF-8 结果，不静默丢文件
  }
}

/* sheet 种类 → 读屏名称（U-17：role=dialog 的 aria-label） */
const SHEET_TITLES: Record<Sheet["kind"], string> = {
  dict: "词典",
  aa: "排版",
  rate: "语速",
  more: "本篇菜单",
  search: "文内搜索",
  confirm: "退出复习",
  summary: "陪练小结",
  export: "导出双语记录",
  import: "导入",
  diffwords: "只练差词",
};

export function SheetHost({ inert = false }: { inert?: boolean }) {
  const sheet = useApp((s) => s.sheet);
  const sheetElRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ sy: 0, dy: 0, t0: 0, on: false, taken: false });

  /* U-21（＝M-06＋P-15）：下拉关闭挂 sheet 根——iOS 半模态「任意位置下拉」；
     scrollTop>0 让位滚动、dy<0 忽略、首次 dy>6 才接管（防点击误判），
     释放 >120px 或 >0.4px/ms 快速轻扫即关（§1.8），否则 280ms 弹回。 */
  useEffect(() => {
    const el = sheetElRef.current;
    if (!el || !sheet) return;
    /* 打开时清掉上次拖拽中断残留的 inline 样式（治 sheets-7）：拖拽期间弹层被他途
       关闭（如第二根手指点遮罩）时 up 永不执行，inline transition/transform 残留在
       .sheet 上——下次打开任何弹层都会错位下移且丢失开窗动画。 */
    el.style.transition = "";
    el.style.transform = "";

    const swallowClick = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
    };

    function down(e: PointerEvent) {
      drag.current = { sy: e.clientY, dy: 0, t0: performance.now(), on: true, taken: false };
      const scroller = (e.target as HTMLElement).closest(".sheet-body");
      /* 内容已下滚：手势让位给滚动 */
      if (scroller && scroller.scrollTop > 0) {
        drag.current.on = false;
        return;
      }
    }
    function move(e: PointerEvent) {
      if (!drag.current.on) return;
      const dy = e.clientY - drag.current.sy;
      if (dy < 0) return; /* 上滑交给滚动 */
      if (!drag.current.taken) {
        if (dy < 6) return; /* 死区：Aa ± 等点击不误判 */
        drag.current.taken = true;
        if (el) el.style.transition = "none";
      }
      drag.current.dy = dy;
      if (el) el.style.transform = `translateY(${dy}px)`;
    }
    function up() {
      if (!drag.current.on) return;
      drag.current.on = false;
      const dt = performance.now() - drag.current.t0;
      const v = drag.current.dy / Math.max(1, dt); /* px/ms */
      if (el) {
        el.style.transition = "";
        el.style.transform = "";
      }
      if (drag.current.taken) {
        /* 拖过的手势吞掉随后的 click，防误触底下按钮 */
        window.addEventListener("click", swallowClick, { capture: true, once: true });
      }
      if (drag.current.dy > 120 || (drag.current.taken && v > 0.4)) actions.setSheet(null);
    }
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("click", swallowClick, { capture: true });
    };
  }, [sheet]);

  const open = sheet !== null;
  return (
    <>
      <div className={`sheet-dim ${open ? "on" : ""}`} aria-hidden="true" onClick={() => actions.setSheet(null)} />
      <div ref={sheetElRef} inert={inert || undefined} role="dialog" aria-modal="true" aria-label={sheet ? SHEET_TITLES[sheet.kind] : undefined} className={`sheet ${open ? "on" : ""}`}>
        <div className="sheet-grab">
          <i />
        </div>
        <div className="sheet-body">{sheet && <SheetContent sheet={sheet} />}</div>
      </div>
    </>
  );
}

function SheetContent({ sheet }: { sheet: Sheet }) {
  switch (sheet.kind) {
    case "dict":
      return <DictSheet key={[sheet.entry.word, sheet.entry.articleId, sheet.entry.sentIdx].join("|")} entry={sheet.entry} />;
    case "aa":
      return <AaSheet />;
    case "rate":
      return <RateSheet />;
    case "more":
      return <MoreSheet />;
    case "search":
      return <SearchSheet />;
    case "confirm":
      return <ConfirmSheet />;
    case "summary":
      return <SummarySheet sceneId={sheet.sceneId} scene={sheet.scene} turns={sheet.turns} secs={sheet.secs} me={sheet.me} chat={sheet.chat} />;
    case "export":
      return <ExportSheet cards={sheet.cards} secs={sheet.secs} />;
    case "import":
      return <ImportSheet tab={sheet.tab} />;
    case "diffwords":
      return <DiffWordsSheet />;
  }
}

/* ---------- 词典卡 / 词块卡（§3.7） ---------- */
function DictSheet({ entry }: { entry: DictEntry }) {
  const nav = useNav();
  const generation = useCloud().generation;
  const requests = useRef(new Set<AbortController>());
  useEffect(() => {
    const active = requests.current;
    return () => { active.forEach(controller => controller.abort()); active.clear(); };
  }, [entry]);
  useEffect(() => {
    for (const controller of requests.current) if (!canContinueDictionaryLogin(entry,controller.signal)) controller.abort();
  }, [generation, entry]);
  const vocab = useApp((s) => s.vocab);
  const articles = useApp((s) => s.articles);
  const [detail, setDetail] = useState(false);
  const [detailDone, setDetailDone] = useState(false);
  const [detailRes, setDetailRes] = useState<{ defs: { pos: string; cn: string }[]; ex?: string } | null>(null);
  const [llm, setLlm] = useState(false);
  const [llmDone, setLlmDone] = useState(false);
  const [llmRes, setLlmRes] = useState<string | null>(null);

  const savedEntry = vocab.find((v) => norm(v.word) === norm(entry.word));
  const saved = entry.saved || !!savedEntry;
  const article: Article | undefined = entry.articleId ? articles.find((a) => a.id === entry.articleId) : undefined;

  function collect() {
    actions.saveWord(
      {
        word: entry.type === "chunk" ? entry.word : entry.word,
        kind: entry.type === "chunk" ? "chunk" : "word",
        chunkType: entry.chunkType,
        phonetic: entry.phonetic,
        senses: entry.senses as DictSenses[],
        pattern: entry.pattern,
        trap: entry.trap,
      },
      entry.type === "chunk" ? "chunk" : "word",
      entry.articleId ? { articleId: entry.articleId, sentIdx: entry.sentIdx ?? 0 } : undefined,
    );
    actions.setSheet(null);
  }

  function remove() {
    if (savedEntry) actions.deleteWord(savedEntry.id);
    actions.setSheet(null);
  }

  function runDetail() {
    if (requests.current.size) return;
    const controller = new AbortController(); requests.current.add(controller);
    setDetail(true); setDetailDone(false);
    void lookupWord(entry.word, controller.signal, entry).then(result => { if (!controller.signal.aborted) setDetailRes(result); }).catch(error => { if (!controller.signal.aborted) setDetailRes({ defs: [{ pos: "查询未完成", cn: error instanceof Error ? error.message : String(error) }] }); }).finally(() => { requests.current.delete(controller); if (!controller.signal.aborted) setDetailDone(true); });
  }

  function runLlm() {
    if (requests.current.size) return;
    const controller = new AbortController(); requests.current.add(controller);
    setLlm(true); setLlmDone(false);
    void lookupWord(entry.word, controller.signal, entry).then(result => { if (!controller.signal.aborted) setLlmRes(result.defs[0]?.cn || "未取得释义"); }).catch(error => { if (!controller.signal.aborted) setLlmRes(error instanceof Error ? error.message : String(error)); }).finally(() => { requests.current.delete(controller); if (!controller.signal.aborted) setLlmDone(true); });
  }

  return (
    <>
      {entry.type === "missing" ? (
        <>
          <div className="dict-head">
            <div style={{ flex: 1 }}>
              <div className="dict-word">{entry.word}</div>
              <div className="meta" style={{ marginTop: 4 }}>
                词典未收录
              </div>
            </div>
            <button className="iconbtn" aria-label="发音" onClick={() => speak(entry.word, 0.9)}>
              <Icon name="speaker" size={19} />
            </button>
          </div>
          <div className="hintbox">这个小词不在内置词典里。可以先收进生词本，或让模型兜底查一次。</div>
          {llmDone ? (
            <div className="sense">
              <span className="pos">模型释义 · 仅供参考</span>
              {llmRes}
            </div>
          ) : llm ? (
            <>
              <div className="skel" style={{ marginTop: 16 }} />
              <div className="skel" style={{ width: "70%" }} />
            </>
          ) : null}
        </>
      ) : (
        <>
          <div className="dict-head">
            <div style={{ flex: 1 }}>
              <div className="dict-word">
                {entry.word}
                {entry.type === "chunk" && <span className="type-badge">{entry.chunkType || "词块"}</span>}
              </div>
              {entry.phonetic && <div className="dict-pho">{entry.phonetic}</div>}
            </div>
            <button className="iconbtn" aria-label="发音" onClick={() => speak(entry.word, 0.9)}>
              <Icon name="speaker" size={19} />
            </button>
          </div>
          {entry.senses.length ? (
            entry.senses.map((s, i) => (
              <div className="sense" key={i}>
                <span className="pos">{s.pos}</span>
                {s.cn}
              </div>
            ))
          ) : (
            <div className="sense" style={{ color: "var(--ink-3)" }}>
              暂无释义
            </div>
          )}
          {entry.pattern && <div className="pattern">{entry.pattern}</div>}
          {entry.trap && <div className="trap-note">直译陷阱 · {entry.trap}</div>}
          {detail && (
            <>
              <hr className="hr" style={{ margin: "16px 0 4px" }} />
              <div className="overline">详细释义 · AI 词典</div>
              {detailDone && detailRes ? (
                <>
                  {detailRes.defs.map((d, i) => (
                    <div className="sense" style={{ fontSize: 15 }} key={i}>
                      <span className="pos">{d.pos}</span>
                      {d.cn}
                    </div>
                  ))}
                  {detailRes.ex && <div className="hintbox">{detailRes.ex}</div>}
                </>
              ) : (
                <>
                  <div className="skel" style={{ marginTop: 12 }} />
                  <div className="skel" style={{ width: "64%" }} />
                </>
              )}
            </>
          )}
        </>
      )}

      {article && entry.sentIdx !== undefined && article.sentences[entry.sentIdx] && (
        <button
          className="src-card"
          onClick={() => {
            actions.locateReader(article.id, entry.sentIdx!);
            actions.setSheet(null);
          }}
        >
          <div className="f">
            来自《{article.title}》 · 第 {entry.sentIdx + 1} 句 · 点按定位回读
          </div>
          <div className="q">{article.sentences[entry.sentIdx].en}</div>
        </button>
      )}

      <button className="btn" style={{margin:"14px 22px",width:"calc(100% - 44px)"}} onClick={()=>{
        if(!saved) collect(); else actions.setSheet(null);
        void openPractice(nav,{mode:"word",title:entry.word,word:entry.word,reference:"用 "+entry.word+" 说一句自己的话。",...(entry.articleId?{source:{articleId:entry.articleId,sentenceIdx:entry.sentIdx??0}}:{})});
      }}>{saved?"用这个表达说一句":"收藏并用它说一句"}</button>
      {/* 已收藏态的「已在生词本」不能当 flex 项与按钮行并排——会把「详细查词典」挤到折行，所以这里只做分支不做统一容器 */}
      {entry.type === "missing" ? (
        <div className="dict-actions">
          <button className="da" disabled={llm && !llmDone} onClick={runLlm}>
            <Icon name="bolt" size={15} />
            模型兜底查一次
          </button>
          <button
            className="da pri"
            onClick={() => {
              actions.saveWord({ word: entry.word, kind: "word", senses: [] }, "word", entry.articleId ? { articleId: entry.articleId, sentIdx: entry.sentIdx ?? 0 } : undefined);
              actions.setSheet(null);
            }}
          >
            仍要收藏 · 暂无释义
          </button>
        </div>
      ) : saved ? (
        <>
          {/* §3.7 已收藏态 =「已在生词本 ✓」+「移除」（移除走撤销 toast，5s 可恢复） */}
          <div className="overline" style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 6, color: "var(--ok)", letterSpacing: "0.06em" }}>
            <Icon name="check" size={13} />
            已在生词本
          </div>
          <div className="dict-actions" style={{ marginTop: 8 }}>
            <button className="da" onClick={remove}>
              <Icon name="trash" size={15} />
              移除
            </button>
            <button className="da" disabled={detail && !detailDone} onClick={runDetail}>
              <Icon name="search" size={15} />
              详细查词典
            </button>
          </div>
        </>
      ) : (
        <div className="dict-actions">
          <button className="da pri" onClick={collect}>
            <Icon name="plus" size={15} />
            收进生词本
          </button>
          <button className="da" disabled={detail && !detailDone} onClick={runDetail}>
            <Icon name="search" size={15} />
            详细查词典
          </button>
        </div>
      )}
    </>
  );
}

/* ---------- Aa 面板（#36/#38/#48） ---------- */
function AaSheet() {
  const prefs = useApp((s) => s.reader);
  return (
    <>
      <div className="sheet-title">排版</div>
      <div className="aa-row">
        <span className="meta2">字号</span>
        <div className="aa-steps">
          <button aria-label="减小字号" onClick={() => actions.setReaderPrefs({ fs: Math.max(15, prefs.fs - 1) })}>
            A−
          </button>
          <span className="aa-fs num">{prefs.fs}</span>
          <button aria-label="增大字号" onClick={() => actions.setReaderPrefs({ fs: Math.min(24, prefs.fs + 1) })}>
            A+
          </button>
        </div>
      </div>
      <div className="aa-row">
        <span className="meta2">显示</span>
        <Seg
          className="aa-seg"
          ariaLabel="显示模式"
          value={prefs.mode}
          items={[
            ["bi", "对照"],
            ["en", "英文"],
            ["zh", "中文"],
          ]}
          onChange={(mode) => actions.setReaderPrefs({ mode })}
        />
      </div>
      <div className="aa-row">
        <span className="meta2">阅读主题</span>
        <Seg
          className="aa-seg"
          ariaLabel="阅读主题"
          value={prefs.topic}
          items={[
            ["paper", "纸色"],
            ["black", "纯黑"],
          ]}
          onChange={(topic) => actions.setReaderPrefs({ topic })}
        />
      </div>
      <div className="aa-row">
        <span className="meta2">词块标注</span>
        <button className={`switch ${prefs.chunkMark ? "on" : ""}`} role="switch" aria-checked={prefs.chunkMark} onClick={() => actions.setReaderPrefs({ chunkMark: !prefs.chunkMark })}>
          <i />
        </button>
      </div>
      <div className="aa-row">
        <span className="meta2">译文遮罩</span>
        <button className={`switch ${prefs.mask ? "on" : ""}`} role="switch" aria-checked={prefs.mask} onClick={() => actions.setReaderPrefs({ mask: !prefs.mask })}>
          <i />
        </button>
      </div>
      <div className="meta" style={{ marginTop: 6 }}>
        字号与主题只影响阅读正文。
      </div>
    </>
  );
}

/* ---------- 语速五档（治 I11） ---------- */
function RateSheet() {
  const rate = useApp((s) => s.reader.rate);
  const items: [number, string][] = [
    [1, "1.0 · 常速"],
    [0.9, "0.9 · 稍慢"],
    [0.8, "0.8 · 慢"],
    [0.72, "0.72 · 领读"],
    [0.6, "0.6 · 很慢"],
  ];
  return (
    <>
      <div className="sheet-title">语速</div>
      <div role="radiogroup" aria-label="朗读语速">
        {items.map(([v, label]) => (
          <button
            key={v}
            role="radio"
            aria-checked={rate === v}
            className="menu-item"
            onClick={() => {
              actions.setReaderPrefs({ rate: v });
              actions.setSheet(null);
              toast(`语速 ${v}×`);
            }}
          >
            <Icon name={rate === v ? "check" : "none"} size={17} />
            <span style={{ flex: 1 }}>{label}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/* ---------- 本篇菜单（···） ---------- */
function MoreSheet() {
  const nav = useNav();
  const mask = useApp((s) => s.reader.mask);
  return (
    <>
      <div className="sheet-title">本篇</div>
      <button className="menu-item" onClick={() => actions.setSheet({ kind: "search" })}>
        <Icon name="search" size={17} />
        文内搜索
      </button>
      <button
        className="menu-item"
        onClick={() => {
          actions.setReaderPrefs({ mask: !mask });
          actions.setSheet(null);
        }}
      >
        <Icon name="eye" size={17} />
        {mask ? "关闭译文遮罩" : "开启译文遮罩"}
      </button>
      <button
        className="menu-item"
        onClick={() => {
          actions.setReaderPrefs({ mask: true });
          actions.remaskReader(); /* 通知 ReaderScreen 清空已揭示句（治 P-25） */
          actions.setSheet(null);
          toast("译文已全部遮住 · 点按逐句揭示");
        }}
      >
        <Icon name="undo" size={17} />
        重新遮住全部译文
      </button>
      <button
        className="menu-item"
        onClick={() => {
          actions.setSheet(null);
          nav.push("share");
        }}
      >
        <Icon name="share" size={17} />
        分享这篇文章
      </button>
    </>
  );
}

/* ---------- 文内搜索（P2 #47） ---------- */
function SearchSheet() {
  const readingId = useApp((s) => s.readingArticleId);
  const articles = useApp((s) => s.articles);
  const article = articles.find((a) => a.id === readingId);
  const [q, setQ] = useState("");
  const query = norm(q);
  const hits = article ? article.sentences.filter((s) => norm(s.en).includes(query) || (s.zh || "").includes(q)) : [];
  return (
    <>
      <div className="sheet-title">文内搜索</div>
      <div className="search">
        <Icon name="search" size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索词或短语" aria-label="搜索词或短语" />
      </div>
      <div style={{ marginTop: 8 }}>
        {!query && <div className="meta" style={{ padding: "10px 0" }}>输入以查找本篇的句子</div>}
        {query &&
          hits.map((s) => (
            <button
              key={s.idx}
              className="menu-item"
              onClick={() => {
                if (article) actions.locateReader(article.id, s.idx);
                actions.setSheet(null);
              }}
            >
              <span className="meta num" style={{ width: 34 }}>
                {s.idx + 1}
              </span>
              <span style={{ flex: 1, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.en}</span>
            </button>
          ))}
        {query && !hits.length && <div className="meta" style={{ padding: "10px 0" }}>本篇没有出现这个词</div>}
      </div>
    </>
  );
}

/* ---------- 退出复习确认 ---------- */
function ConfirmSheet() {
  const nav = useNav();
  return (
    <>
      <div className="sheet-title">退出复习？</div>
      <div className="meta">这一轮的判分已经逐张保存，下次进来接着清。</div>
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)", flex: 1 }} onClick={() => actions.setSheet(null)}>
          继续复习
        </button>
        <button
          className="btn"
          style={{ flex: 1 }}
          onClick={() => {
            actions.setSheet(null);
            nav.popAll();
          }}
        >
          退出
        </button>
      </div>
    </>
  );
}

/* ---------- 陪练小结（#56）——数字来自真实会话，存档真实写入（治 P-40/P-41） ---------- */
function fmtSecs(secs: number): string {
  if (secs < 60) return `${secs} 秒`;
  return `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`;
}

function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** 未配置模型/流式失败时的本地规则兜底尾注。 */
const INSIGHT_UNCONFIGURED_NOTE = "配置模型服务后可获得 AI 会话洞察";

/** 本地规则洞察：基于真实 chat 统计（开口次数、最长一句、可复读句），无任何写死评语。 */
function buildLocalInsight(chat: ChatTurn[], me: number): string {
  const mine = chat.filter((t) => t.who === "me").map((t) => t.en);
  const aiSents = chat.filter((t) => t.who === "ai").map((t) => t.en).filter(Boolean);
  if (!mine.length) {
    return (
      "这一场你还没有开口——陪练的话都留着，随时可以接上。" +
      "下一场试着先说一句完整的短句，开口就是进步。" +
      `（${INSIGHT_UNCONFIGURED_NOTE}）`
    );
  }
  const longest = mine.reduce((a, b) => (wordCount(b) > wordCount(a) ? b : a), "");
  const parts = [`你开口 ${me} 次，最长一句 ${wordCount(longest)} 个词：「${longest}」，先把它读顺。`];
  const rec = aiSents[aiSents.length - 1] || "";
  if (rec) parts.push(`建议跟读陪练这句提问：「${rec}」，照着语调念两遍。`);
  parts.push(`（${INSIGHT_UNCONFIGURED_NOTE}）`);
  return parts.join("");
}

function SummarySheet({
  sceneId,
  scene,
  turns,
  secs,
  me,
  chat,
}: {
  sceneId: string;
  scene: string;
  turns: number;
  secs: number;
  me: number;
  chat: ChatTurn[];
}) {
  const nav = useNav();
  const configured = llmConfigured();
  /* 未配置：直接本地规则文案（不发起请求）；已配置：流式渲染（累计直 set，无打字机） */
  const [insight, setInsight] = useState<string>(() => (configured ? "" : buildLocalInsight(chat, me)));
  const [streaming, setStreaming] = useState(configured);

  useEffect(() => {
    if (!configured) return;
    /* B1 的 buildSummaryPrompt 返回 {system,user}（实际实现口径），system/user 分送 */
    const { system, user } = buildSummaryPrompt(sceneId, chat, { turns, secs, me });
    const ctl = chatStream(
      system,
      [{ role: "user", content: user }],
      {
        onDelta: (cum) => {
          setStreaming(false);
          setInsight(cum);
        },
        onDone: (full) => {
          setStreaming(false);
          setInsight(full);
        },
        /* 失败降级：本地规则 + 配置引导尾注（与未配置同文案口径） */
        onFail: () => {
          setStreaming(false);
          setInsight(buildLocalInsight(chat, me));
        },
      },
    );
    return () => ctl.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="sheet-title">这次陪练</div>
      <div style={{ display: "flex" }}>
        <div style={{ flex: 1 }}>
          <div className="serif num" style={{ fontSize: 26, fontWeight: 600 }}>
            {turns} 轮
          </div>
          <div className="meta">对话轮次</div>
        </div>
        <div style={{ flex: 1 }}>
          <div className="serif num" style={{ fontSize: 26, fontWeight: 600 }}>
            {fmtSecs(secs)}
          </div>
          <div className="meta">用时</div>
        </div>
        <div style={{ flex: 1 }}>
          <div className="serif num" style={{ fontSize: 26, fontWeight: 600 }}>
            {me} 次
          </div>
          <div className="meta">开口</div>
        </div>
      </div>
      <div className="insight" style={{ marginTop: 14 }}>
        {streaming ? "正在生成 AI 洞察…" : insight}
      </div>
      <button
        className="btn"
        style={{ marginTop: 16 }}
        onClick={() => {
          saveSession({ sceneId, scene, turns, secs, me, chat });
          actions.setSheet(null);
          nav.popAll();
          toast(`已存入口语记录 · ${scene} ${turns} 轮`);
        }}
      >
        <Icon name="check" size={16} />
        存入口语记录
      </button>
      {/* 不保存也要离开对话页（治 P-39：setSheet(null) 只关弹层，人还被困在对话里 */}
      <button
        className="btn-ghost"
        style={{ marginTop: 8 }}
        onClick={() => {
          actions.setSheet(null);
          nav.popAll();
        }}
      >
        不保存
      </button>
    </>
  );
}

/* ---------- 直译导出（#60） ---------- */
function ExportSheet({ cards, secs }: { cards: { t: string; en: string; zh: string }[]; secs: number }) {
  const md =
    "# 直译记录 · " +
    new Date().toLocaleDateString("zh-CN") +
    "\n\n" +
    cards.map((c) => `**${c.t}**  \nEN  ${c.en}\nZH  ${c.zh}`).join("\n\n") +
    `\n\n> 由录音直译生成 · ${secs} 秒 · 默认不保留音频`;

  /* 分享：真机走 shareText（Rust share_text → 插件原生分享面板，失败内部回退复制）；
     浏览器保留 navigator.share 三分支（成功/取消/失败复制），toast 均如实（治 P-47 假成功） */
  async function doShare() {
    if (isTauri()) {
      const ok = await shareText("直译记录", md);
      if (ok) {
        actions.setSheet(null);
        toast("已调起系统分享 · Markdown");
      } else {
        /* false = 调起失败（shareText 内已回退复制；复制也失败会进诊断日志） */
        toast("系统分享未完成 · 全文已复制兜底");
      }
      return;
    }
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "直译记录", text: md });
        actions.setSheet(null);
        toast("已通过系统分享发出 · Markdown");
      } catch (err) {
        if ((err as DOMException | undefined)?.name === "AbortError") {
          toast("已取消分享");
        } else {
          const copied = await writeClipboard(md);
          toast(copied ? "系统分享失败 · 全文已复制" : "系统分享失败 · 复制也未成功");
        }
      }
    } else {
      const copied = await writeClipboard(md);
      toast(copied ? "当前环境不支持系统分享 · 全文已复制" : "当前环境不支持系统分享 · 复制失败");
    }
  }

  return (
    <>
      <div className="sheet-title">导出双语记录</div>
      <div className="meta">
        Markdown · {cards.length} 句 · 默认不保留音频
      </div>
      <div className="md-preview" style={{ marginTop: 10 }}>
        {md}
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button
          className="btn-ghost"
          style={{ border: "1px solid var(--hairline-strong)", flex: 1 }}
          onClick={() => {
            /* 等结果再报（治 sheets-5）：writeClipboard 失败返回 false 且不抛——
               此前不等不判就 toast「已复制」，失败时假成功；同文件分享路径早已按 boolean 如实提示 */
            void (async () => {
              const ok = await writeClipboard(md);
              actions.setSheet(null);
              toast(ok ? "双语全文已复制" : "复制未成功，请重试");
            })();
          }}
        >
          <Icon name="copy" size={15} />
          复制
        </button>
        <button
          className="btn"
          style={{ flex: 1 }}
          onClick={() => {
            void doShare();
          }}
        >
          <Icon name="share" size={15} />
          分享
        </button>
      </div>
    </>
  );
}

/* ---------- 导入抽屉（#31–#34）——文库 = core/library 真实全文（B4） ---------- */
function ImportSheet({ tab }: { tab: "lib" | "paste" | "link" | "file" }) {
  const nav = useNav();
  const [localTab, setLocalTab] = useState(tab);
  const [pasteText, setPasteText] = useState("");
  const [linkUrl, setLinkUrl] = useState("https://example.com/city-trees");
  const [linkState, setLinkState] = useState<"idle" | "loading" | "fail">("idle");
  /* 考试筛选：null=全部；点选中的 chip 再点一次取消 */
  const [exam, setExam] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const today = libToday();
  const list = exam ? LIB_ARTICLES.filter((a) => a.exams.includes(exam)) : LIB_ARTICLES;

  function land(a: Article, msg: string) {
    actions.addArticle(a);
    actions.setSheet(null);
    actions.setTab("shelf");
    toast(msg);
  }

  /** 文库篇目 → 书架：全文真实句子（zh=null 走既有翻译管线）。
      同一篇只入一次：入库 id 形如 lib-{libId}-…，书架里已有即拦下——
      重复入库会产生进度互不相通的同名副本（治 algo-4）。 */
  function addLibToShelf(lib: LibArticle) {
    const prefix = `lib-${lib.id}-`;
    if (getState().articles.some((a) => a.id.startsWith(prefix))) {
      toast("已在书架");
      return;
    }
    land(libToArticle(lib), `已加入书架 · ${lib.title} · ${lib.sentences.length} 句全文待翻译`);
  }

  /** 粘贴/链接/文件：外部文本按句切分构建（无演示占位正文）。 */
  function addTextToShelf(id: string, title: string, source: string, en: string) {
    const sents = en.match(/[^.!?]+[.!?]+\s*/g) || [en];
    const a: Article = {
      id,
      title,
      titleCn: `${source}导入`,
      sentences: sents.map((s, i) => ({ idx: i, paragraphIdx: 0, en: s.trim(), zh: null, chunks: [] })),
      paragraphStarts: [0],
    };
    land(a, "已加入书架 · 开始翻译");
  }

  /* 链接抓取的取消/卸载守卫（治 sheets-1）：此前 fetch 只绑 4s 超时——点「取消导入」、
     下拉或点遮罩关弹层后请求继续跑，4s 内成功返回照样落库、强跳 shelf tab、弹「已加入书架」。 */
  const linkAbortRef = useRef<AbortController | null>(null);
  const linkEpochRef = useRef(0);
  useEffect(() => () => linkAbortRef.current?.abort(), []);

  function cancelLinkImport() {
    linkEpochRef.current += 1; // 迟到的成功/失败回调一并作废
    linkAbortRef.current?.abort();
    linkAbortRef.current = null;
    setLinkState("idle");
  }

  function importLink() {
    setLinkState("loading");
    /* 抓取调用点：浏览器直连大概率 CORS 失败 → 退路「改为粘贴」；真机走 Rust fetch */
    const epoch = ++linkEpochRef.current;
    const ctl = new AbortController();
    linkAbortRef.current = ctl;
    const t = setTimeout(() => ctl.abort(), 4000);
    fetch(linkUrl, { signal: ctl.signal })
      .then((r) => {
        clearTimeout(t);
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then((html) => {
        if (epoch !== linkEpochRef.current) return; // 已取消/已重开/弹层已关：丢弃迟到结果
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .slice(0, 4000);
        addTextToShelf("link-" + Date.now(), linkUrl.replace(/^https?:\/\//, "").slice(0, 40), "链接", text);
      })
      .catch(() => {
        clearTimeout(t);
        if (epoch !== linkEpochRef.current) return; // 主动取消不算失败
        setLinkState("fail");
      });
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => addTextToShelf("file-" + Date.now(), f.name.replace(/\.txt$/i, ""), "文件", decodeTextFile(new Uint8Array(r.result as ArrayBuffer)));
    /* 读取失败如实提示（治 sheets-8）：此前只挂 onload，失败零反馈、界面无任何动静 */
    r.onerror = () => toast("读取文件失败，请重试");
    r.readAsArrayBuffer(f);
  }

  return (
    <>
      <div className="sheet-title">导入</div>
      <div className="import-tabs">
        {(
          [
            ["lib", "文库"],
            ["paste", "粘贴"],
            ["link", "链接"],
            ["file", "文件"],
          ] as const
        ).map(([v, label]) => (
          <button key={v} className={localTab === v ? "on" : ""} aria-pressed={localTab === v} onClick={() => setLocalTab(v)}>
            {label}
          </button>
        ))}
      </div>
      {localTab === "lib" && (
        <>
          <div className="overline">今日一篇</div>
          <button className="lib-hero" style={{ marginTop: 8 }} onClick={() => addLibToShelf(today)}>
            <span
              style={{
                width: 54,
                height: 72,
                background: "var(--surface)",
                border: "1px solid var(--hairline)",
                borderRadius: 6,
                flex: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span className="serif" style={{ fontSize: 10, color: "var(--ink-3)", writingMode: "vertical-rl" }}>
                {today.level}
              </span>
            </span>
            <span>
              <span className="t" style={{ display: "block" }}>
                {today.title}
              </span>
              <span className="m" style={{ display: "block" }}>
                {libMeta(today)}
              </span>
              <span className="meta" style={{ display: "block", marginTop: 2 }}>
                今天读它的人，先把它收进来
              </span>
            </span>
          </button>
          <div className="overline" style={{ marginTop: 18 }}>
            书单
          </div>
          <div className="exam-chips" style={{ marginTop: 8 }}>
            {EXAM_TAGS.map((x) => (
              <button
                key={x}
                className="chip"
                aria-pressed={exam === x}
                style={exam === x ? { background: "var(--ink)", color: "var(--on-ink)", borderColor: "var(--ink)" } : undefined}
                onClick={() => setExam(exam === x ? null : x)}
              >
                {x}
              </button>
            ))}
          </div>
          <div style={{ marginTop: 8 }}>
            {list.map((b) => (
              <button key={b.id} className="row" onClick={() => addLibToShelf(b)}>
                <span className="grow">
                  <span className="serif" style={{ display: "block", fontSize: 17, fontWeight: 600 }}>
                    {b.title}
                  </span>
                  <span className="meta" style={{ display: "block" }}>
                    {libMeta(b)}
                  </span>
                </span>
                <Icon name="right" size={15} />
              </button>
            ))}
            {exam && !list.length && (
              <div className="meta" style={{ padding: "10px 0" }}>
                该类别暂未收录 · 再点一次取消筛选
              </div>
            )}
          </div>
        </>
      )}
      {localTab === "paste" && (
        <>
          <button
            className="chip"
            style={{ marginBottom: 10 }}
            onClick={() => {
              void readClipboard().then((t) => {
                if (t) setPasteText(t);
                else toast("读取剪贴板需要授权 · 可手动粘贴");
              });
            }}
          >
            <Icon name="clip" size={13} />
            使用剪贴板内容（刚复制）
          </button>
          <textarea className="input" rows={5} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder="把文章粘贴到这里" aria-label="粘贴文章内容" />
          <button
            className="btn"
            style={{ marginTop: 12 }}
            onClick={() => {
              if (!pasteText.trim()) {
                /* 治 P-27：空粘贴不再静默生成《（粘贴的文章）》占位文 */
                toast("先粘贴内容");
                return;
              }
              addTextToShelf("paste-" + Date.now(), pasteText.trim().slice(0, 36), "粘贴", pasteText);
            }}
          >
            导入书架
          </button>
        </>
      )}
      {localTab === "link" && (
        <>
          <input className="input" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://…" aria-label="文章链接地址" />
          {linkState === "fail" && (
            <div className="degrade" style={{ marginTop: 10 }}>
              <Icon name="bolt" size={14} />
              <span>抓取失败（跨域或超时）· 可以改为粘贴</span>
            </div>
          )}
          <button className="btn" style={{ marginTop: 12 }} onClick={importLink} disabled={linkState === "loading"}>
            {linkState === "loading" ? "抓取中…" : "抓取并导入"}
          </button>
          <button className="tlink" style={{ fontSize: 13, marginTop: 10 }} onClick={() => setLocalTab("paste")}>
            抓取失败？改为粘贴
          </button>
        </>
      )}
      {localTab === "file" && (
        <>
          <button className="row" onClick={() => fileRef.current?.click()}>
            <span className="ico" style={{ color: "var(--ink)" }}>
              <Icon name="shelf" size={19} />
            </span>
            <span className="grow">
              <span style={{ display: "block" }}>从「文件」选择</span>
              <span className="sub" style={{ display: "block" }}>
                支持 txt · docx 与 pdf 即将支持
              </span>
            </span>
            <Icon name="right" size={15} />
          </button>
          <input ref={fileRef} type="file" accept=".txt,text/plain" className="hidden" onChange={onFile} aria-label="选择文本文件" />
        </>
      )}
      <button
        className="meta tlink"
        style={{ marginTop: 14 }}
        onClick={() => {
          cancelLinkImport();
          actions.setSheet(null);
          nav.pop();
        }}
      >
        取消导入
      </button>
    </>
  );
}

/* ---------- 只练差词（#58）——词表来自当轮真实标红（shadowState），治 P-44 ---------- */
function DiffWordsSheet() {
  const words: ShadowDiffWord[] = getShadowDiffWords();
  const [i, setI] = useState(0);
  const [drill, setDrill] = useState(false);

  /* 逐词加练：进入抽屉加练态/切词时自动领读一遍（0.72×，与影子领读同速） */
  useEffect(() => {
    if (drill && words[i]) speak(words[i].word, 0.72);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drill, i]);

  if (!words.length) {
    return (
      <>
        <div className="sheet-title">只练差词</div>
        <div className="meta" style={{ padding: "12px 0" }}>
          这一轮全部过线 · 没有差词要加练
        </div>
      </>
    );
  }

  if (drill) {
    const w = words[i];
    const last = i >= words.length - 1;
    return (
      <>
        <div className="sheet-title">逐词加练</div>
        <div className="aa-row">
          <div>
            <div className="serif" style={{ fontSize: 22, fontWeight: 600 }}>
              {w.word}
            </div>
            <div className="meta">先听领读 · 再自己跟读一遍</div>
          </div>
          <span className="meta num">
            {i + 1} / {words.length}
          </span>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)", flex: 1 }} onClick={() => speak(w.word, 0.6)}>
            <Icon name="slow" size={15} />
            再听领读 · 慢速
          </button>
          <button
            className="btn"
            style={{ flex: 1 }}
            onClick={() => {
              if (last) {
                actions.setSheet(null);
                toast(`加练完成 · ${words.length} 个差词各过一遍领读与跟读`);
              } else {
                setI(i + 1);
              }
            }}
          >
            {last ? "完成加练" : "跟读一遍 · 下一个"}
          </button>
        </div>
        <div className="meta" style={{ marginTop: 10 }}>
          加练在抽屉里逐词进行 · 完成或下拉即可关闭
        </div>
      </>
    );
  }

  const cur = words[i];
  return (
    <>
      <div className="sheet-title">只练差词</div>
      <div className="aa-row">
        <div>
          <div className="serif" style={{ fontSize: 22, fontWeight: 600 }}>
            {cur.word}
          </div>
          <div className="meta">当轮标红 {cur.count} 次 · 来自真实评测结果</div>
        </div>
        <span className="meta num">
          {i + 1} / {words.length}
        </span>
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)", flex: 1 }} onClick={() => setI((x) => (x + 1) % words.length)}>
          换一个
        </button>
        <button
          className="btn"
          style={{ flex: 1 }}
          onClick={() => {
            setI(0);
            setDrill(true);
          }}
        >
          逐词加练
        </button>
      </div>
    </>
  );
}
