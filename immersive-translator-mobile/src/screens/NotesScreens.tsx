/**
 * 复习笔记三屏（push）—— §3.15：流式生成可停 → 入库；笔记库 + AI 复盘 + 只测仍错词加练。
 * 笔记只汇总今天的复习，不改 SRS 排程（#53/#54）。
 * 生成口径（demo 16 实化）：
 *  · 已配置模型 → llm_chat 真流式（chatStream，onDelta 累计上屏），输出末行「建议：…」解析为 insight；
 *  · 未配置 / 请求失败 / 手动停止 → buildNoteDraft 本地统计模板（数据本就真实），
 *    并明示「本地统计（…）」来源，不再用 60ms/3 字打字机假装流式。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { actions, reviewStats, toast, useApp } from "../store";
import { Icon } from "../ui/icons";
import { PNav, SwipeRow } from "../ui/kit";
import { useNav } from "../ui/nav";
import { buildCard } from "../core/queue";
import { chatStream, llmConfigured, type ChatStream } from "../services/translate";
import type { Article, VocabWord } from "../core/types";

interface NoteDraft {
  overline: string;
  sub: string;
  body: string;
  insight: string;
}

/** 按当天日期 + 今日已清 + 本周陷阱/复习量 + 未来两天到期词生成笔记草稿（本地统计模板，数据真实）。 */
function buildNoteDraft(cleared: number, streak: number, weekTrap: number, weekReview: number, vocab: VocabWord[]): NoteDraft {
  const now = new Date();
  const nowMs = now.getTime();
  const dateStr = `${now.getMonth() + 1}月${now.getDate()}日`;
  const upcoming = vocab
    .filter((v) => v.dueAt > nowMs && v.dueAt <= nowMs + 2 * 86400_000)
    .sort((a, b) => a.dueAt - b.dueAt);
  const names = upcoming.slice(0, 3).map((v) => v.word);
  const trapLine =
    weekTrap > 0
      ? `直译陷阱本周命中 ${weekTrap} 次，多出在「动词 + 介词」的搭配上，复习时先回想整句，再对照中文释义。`
      : "本周还没有命中直译陷阱，搭配记得很牢，保持。";
  const upLine = names.length
    ? `未来两天有 ${upcoming.length} 个词将到期（${names.join("、")}${upcoming.length > 3 ? " 等" : ""}），建议明晚优先过一遍。`
    : "未来两天暂无新到期词，可以用「先清一张」保持手感。";
  const body = `今天清了 ${cleared} 张复习卡，本周累计复习 ${weekReview} 张。${trapLine}${upLine}已连续打卡 ${streak} 天，节奏稳住了。`;
  const insight =
    weekTrap > 0
      ? "AI 复盘 · 陷阱集中在动词搭配上；把搭配读出声、动手写一遍，比默看更管用。"
      : "AI 复盘 · 本周零陷阱命中；新收藏的词当晚就清一遍，印象最深。";
  return {
    overline: `${dateStr} · 复习 ${cleared} 张`,
    sub: `复习 ${cleared} 张 · 陷阱 ${weekTrap}`,
    body,
    insight,
  };
}

/* ---------- AI 复盘 prompt（本地实现；契约口径为 core/speak.ts buildNotesPrompt，B1 产出后统一） ---------- */

/** 喂给模型的真实数据摘要（全部取自 store 当天状态，不编造）。 */
interface NotesFacts {
  date: string;
  cleared: number;
  streak: number;
  weekReview: number;
  weekAdd: number;
  weekTrap: number;
  dueNow: number;
  /** 未来两天将到期的词（带中文释义，供模型点名）。 */
  upcoming: string[];
  /** 最近收的词（生词本新词在前）。 */
  recent: string[];
}

const NOTES_SYSTEM_PROMPT = [
  "你是一位英语学习复盘教练。根据用户当天的真实学习数据，用中文写一篇 120–200 字的复习笔记。",
  "要求：",
  "- 只依据给出的数据，不编造数据里没有的事实；",
  "- 先讲今天清了多少张卡、整体节奏，再讲数据里最值得注意的一件事（直译陷阱、到期词或新收词）；",
  "- 末行单独一行，以「建议：」开头，给一条明天就能执行的具体行动。",
].join("\n");

/** 组 AI 复盘的用户输入（真实 stats/vocab 摘要）。 */
function buildNotesPrompt(f: NotesFacts): string {
  const lines = [
    `日期：${f.date}`,
    `今日已清复习卡：${f.cleared} 张`,
    `连续打卡：${f.streak} 天`,
    `本周累计复习 ${f.weekReview} 张 · 新收词 ${f.weekAdd} 个 · 直译陷阱命中 ${f.weekTrap} 次`,
    `当前待清到期卡：${f.dueNow} 张`,
  ];
  if (f.upcoming.length) lines.push(`未来两天将到期：${f.upcoming.join("、")}`);
  if (f.recent.length) lines.push(`近期新收词：${f.recent.join("、")}`);
  lines.push("请据此生成今天的复习笔记。");
  return lines.join("\n");
}

/** 输出末行「建议：…」→ insight；解析不出则全文并入 body、insight 置空（不造假建议）。 */
function parseInsight(full: string): { body: string; insight: string } {
  const lines = full.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*建议\s*[：:]\s*(.*)$/);
    if (!m) continue;
    const advice = m[1].trim();
    const body = lines.filter((_, j) => j !== i).join("\n").trim();
    if (!body || !advice) return { body: full.trim(), insight: "" };
    return { body, insight: `AI 复盘 · ${advice}` };
  }
  return { body: full.trim(), insight: "" };
}

export function NotesGen() {
  const nav = useNav();
  const st = useApp(reviewStats);
  const weekTrap = useApp((s) => s.stats.week.trap);
  const weekReview = useApp((s) => s.stats.week.review);
  const weekAdd = useApp((s) => s.stats.week.add);
  const vocab = useApp((s) => s.vocab);
  /** 挂载时定一次生成模式：已配置模型 → AI 流式；否则本地模板一次性呈现（无打字机）。 */
  const [mode] = useState<"ai" | "local">(() => (llmConfigured() ? "ai" : "local"));
  const [streamed, setStreamed] = useState("");
  const [running, setRunning] = useState(mode === "ai");
  const [done, setDone] = useState(mode === "local");
  /** 数据来源说明：AI 成功为空串；本地/失败/停止明示原因。 */
  const [source, setSource] = useState(mode === "local" ? "本地统计（未配置模型服务）" : "");
  const [blocked, setBlocked] = useState(false);
  const engineRef = useRef<ChatStream | null>(null);
  const startedRef = useRef(false);
  const blockedRef = useRef(false);
  /** AI 输出的最终正文/建议（onDone 或停止时的累计文本解析而来）。 */
  const [aiBody, setAiBody] = useState("");
  const [aiInsight, setAiInsight] = useState("");

  /* 草稿只在进入时按当时数据生成一次（复习数据在流入期间不变）——也是所有降级路径的落点 */
  const draft = useMemo(
    () => buildNoteDraft(st.cleared, st.streak, weekTrap, weekReview, vocab as VocabWord[]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /* P-16：今日无复习记录 → toast 拦截，不生成也不入库（StrictMode 双挂载只拦一次） */
  useEffect(() => {
    if (blockedRef.current) return;
    blockedRef.current = true;
    if (st.cleared > 0) return;
    setBlocked(true);
    toast("今天还没有复习记录，先清几张再来整理笔记");
    /* 定时可清理（治 tools-8）：900ms 内用户点返回会 pop 一次、定时器再 pop 一次，多退一层 */
    const t = setTimeout(() => nav.pop(), 900);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 生成启动：AI 真流式（先 listen 后 invoke 由 chatStream 内部保证）；本地模式已在初始态一次性呈现。
     startedRef 挡 StrictMode 双挂载重复发起；今日无复习（st.cleared<=0）不发起请求（拦截口径同上）。 */
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (mode === "local" || st.cleared <= 0) return;
    const nowMs = Date.now();
    const up = (vocab as VocabWord[])
      .filter((v) => v.dueAt > nowMs && v.dueAt <= nowMs + 2 * 86400_000)
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, 5)
      .map((v) => `${v.word}（${v.senses[0]?.cn || "待补释义"}）`);
    const recent = (vocab as VocabWord[])
      .slice(0, 5)
      .map((v) => `${v.word}（${v.senses[0]?.cn || "待补释义"}）`);
    const facts: NotesFacts = {
      date: draft.overline.split(" · ")[0],
      cleared: st.cleared,
      streak: st.streak,
      weekReview,
      weekAdd,
      weekTrap,
      dueNow: st.due,
      upcoming: up,
      recent,
    };
    engineRef.current = chatStream(
      NOTES_SYSTEM_PROMPT,
      [{ role: "user", content: buildNotesPrompt(facts) }],
      {
        onDelta: (cum) => setStreamed(cum),
        onDone: (full) => {
          const r = parseInsight(full);
          setAiBody(r.body);
          setAiInsight(r.insight);
          setRunning(false);
          setDone(true);
        },
        onFail: (msg) => {
          /* 失败降级本地模板：数据真实，来源明示（不假装 AI 写的） */
          setSource(`本地统计（模型请求失败 · ${msg}）`);
          setRunning(false);
          setDone(true);
        },
      },
    );
    /* 中途返回掐流（治 tools-7）：卸载不 stop 的话 AI 请求在后台跑完（BYOK token 照烧），
       chat-delta 监听器滞留到命令结束；stop 此前只在手动「停止生成」时生效过。 */
    return () => {
      engineRef.current?.stop();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 停止：停在当前累计文本（已有一段就按 AI 文本收尾；还没有内容则回落本地模板）。 */
  function stop() {
    engineRef.current?.stop();
    engineRef.current = null;
    setRunning(false);
    setDone(true);
    if (streamed.trim()) {
      const r = parseInsight(streamed);
      setAiBody(r.body);
      setAiInsight(r.insight);
    } else {
      setSource("本地统计（已停止，未生成内容）");
    }
  }

  const body = aiBody || draft.body;
  const insight = aiInsight || (aiBody ? "" : draft.insight);
  const sub = draft.sub;

  function save() {
    /* 总是入库、标题带日期：按固定标题去重会让笔记库永久封顶 1 篇，
       第二天保存被静默跳过、内容丢失（治 tools-1）；同日重复保存由标题日期自明。 */
    const d = new Date();
    actions.addNote({ title: `今日复习笔记 · ${d.getMonth() + 1}月${d.getDate()}日`, sub, body, insight });
    nav.replace("noteslib");
  }

  /* 拦截态：不展示任何生成内容，等 toast 计时自动返回（口径同旧实现） */
  if (blocked) {
    return (
      <>
        <PNav title="复习笔记" onBack={() => nav.pop()} />
        <div className="pbody" />
      </>
    );
  }

  return (
    <>
      <PNav title="复习笔记" onBack={() => nav.pop()} />
      <div className="pbody">
        <div className="overline">{draft.overline}</div>
        <div className="serif" style={{ fontSize: 22, fontWeight: 600, marginTop: 6 }}>
          今日复习笔记
        </div>
        {source && (
          <div className="meta" style={{ marginTop: 6 }}>
            {source}
          </div>
        )}
        {done ? (
          <div className="note-stream note-body">
            {body.split(/\n+/).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        ) : (
          <div className="note-stream" style={{ whiteSpace: "pre-wrap" }}>
            {streamed}
            <span className="caret" style={{ height: 15 }} />
          </div>
        )}
        {done && !!insight && <div className="insight">{insight}</div>}
        {done ? (
          <button className="btn" style={{ marginTop: 16 }} onClick={save}>
            <Icon name="check" size={16} />
            存入笔记库
          </button>
        ) : (
          running && (
            <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)", marginTop: 14 }} onClick={stop}>
              <Icon name="stop" size={14} />
              停止生成
            </button>
          )
        )}
        <div className="meta" style={{ marginTop: 12 }}>
          笔记只汇总今天的复习，不改 SRS 排程。
        </div>
      </div>
    </>
  );
}

export function NotesLib() {
  const nav = useNav();
  const notes = useApp((s) => s.notes);
  return (
    <>
      <PNav title="笔记库" onBack={() => nav.pop()} />
      <div className="pbody">
        {notes.length === 0 && (
          <>
            <div className="meta" style={{ textAlign: "center", padding: "60px 0" }}>
              复习完一轮，让 AI 帮你把要点整理成笔记。
            </div>
            <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)" }} onClick={() => nav.replace("notes")}>
              生成今天的笔记
            </button>
          </>
        )}
        {notes.map((n) => (
          <SwipeRow key={n.id} onDelete={() => actions.deleteNote(n.id)}>
            <div
              className="row"
              style={{ borderBottom: 0, padding: "10px 0" }}
              onClick={() => nav.push("notedetail", { id: n.id })}
            >
              <span className="ico" style={{ color: "var(--ink)" }}>
                <Icon name="note" size={19} />
              </span>
              <span className="grow" style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 16, fontWeight: 600 }}>{n.title}</span>
                <span className="sub" style={{ display: "block" }}>
                  {n.sub}
                </span>
              </span>
              <Icon name="right" size={15} />
            </div>
          </SwipeRow>
        ))}
      </div>
    </>
  );
}

export function NoteDetail({ id }: { id?: string }) {
  const nav = useNav();
  const notes = useApp((s) => s.notes);
  const note = notes.find((n) => n.id === id);
  const title = note?.title || "复习笔记";
  /* 无入库记录时（陈旧入口）给出口径说明，不再展示写死的假复盘（P-16） */
  const body = note?.body || "这里还没有入库的笔记。完成今天的复习并整理入库后，这里会显示你的真实复盘。";
  const insight = note?.insight || "";
  return (
    <>
      <PNav title={title} onBack={() => nav.pop()} />
      <div className="pbody">
        <div className="note-stream note-body">
          {body.split(/\n+/).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
        {!!insight && <div className="insight">{insight}</div>}
        <DrillWrong />
        <div className="meta" style={{ marginTop: 10 }}>
          加练不改排程，只把这几张再过一遍。
        </div>
      </div>
    </>
  );
}

/** 「只测仍错」的近期窗口：7 天内判过错的词可加练（太久远的错词重新由到期调度接管）。 */
const WRONG_WINDOW_MS = 7 * 86400_000;

function DrillWrong() {
  const nav = useNav();
  const vocab = useApp((s) => s.vocab);
  const articles = useApp((s) => s.articles);
  /* 按判错记录构卡（治 ux-cross-1）：forgot/陷阱评分在 gradeVocab 落 lastWrongAt，
     这里取 7 天内最近判错的词（buildCard 按词/词块自动选卡型）——
     此前实现是「到期队列前 3 张非识别卡」，既不筛「仍错」也把判错的单词排除在外，
     与按钮承诺完全对不上。 */
  const wrongs = (vocab as VocabWord[])
    .filter((v) => v.lastWrongAt && Date.now() - v.lastWrongAt < WRONG_WINDOW_MS)
    .sort((a, b) => (b.lastWrongAt ?? 0) - (a.lastWrongAt ?? 0))
    .slice(0, 3);
  return (
    <button
      className="btn"
      style={{ marginTop: 18, opacity: wrongs.length === 0 ? 0.55 : 1 }}
      disabled={wrongs.length === 0}
      onClick={() => {
        const q = wrongs.map((v) => buildCard(v, articles as Article[]));
        if (q.length === 0) return; // 理论不可达（禁用兜底），防御保留
        nav.replace("review", { cards: q, from: "vocab" });
      }}
    >
      <Icon name="bolt" size={16} />
      {wrongs.length === 0 ? "近 7 天没有判错的词" : `只测仍错的 ${wrongs.length} 张`}
    </button>
  );
}
