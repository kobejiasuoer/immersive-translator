/**
 * 笔记与复习域主体（proto-parity-2026-11-01 · vault 域）：
 * 今日复习 = 续学行（v2-resume-review，进行中复习轮时出现）+ due 卡（v2-due-card：eyebrow +
 * 「现在有 N 条可复习」大数字 + 首次/到期/时长拆分 + 三模式 chips + 模式说明 + 角标说明）+
 * 待强化卡（v2-reinforcement：warn 时间 tag + 说明 + 词行）+ 下一次复习安排卡（v2-next-review）+
 * 掌握阶段三格（v2-word-stats：刚收集/眼熟/能说出口 + 衬线大数字）+ 这一轮要见面的表达 +
 * 学习提醒行（v2-reminder-row → ReminderSheet）。
 * 生词本 = 搜索框（放大镜 + × 清空）+ 排序下拉 +「+ 记生词」pill + 阶段/类型 chips（accent 实底
 * 选中 + 清除全部筛选）+ 计数行 + 合并词条卡（衬线词 + chev + 音标 + 阶段 tag + 释义 + 来源·查词次数）
 * + 顶部撤销条（v2-undo-row）+ 加词抽屉（五字段 + 类型下拉 + 保存并查看词条）。
 * 我的笔记 = 类型筛选 chips（含计数）+「✏️ 写一条学习笔记」block pill + 合并笔记卡（tag + 来源·时间
 * meta + 标题 + 摘要 + 链接行，口语纠偏 tag 为 accent-soft）。
 * 全部只读派生自既有 store 数据，不新增同步字段；移除走词条详情确认抽屉 + 既有 5s 撤销 toast。
 * 复检 r1：掌握阶段读「我对这个词的感觉」自评（useVocabFeels，未自评回退 srs 推导）；
 * 最早一条待强化到点时实时重算并 toast 提示（原型「快进十分钟」返场的真实时间版）；
 * 复习模式选择跨页面保留（原型 APP.ui.vault.mode）。
 */
import { useEffect, useMemo, useState } from "react";
import { actions, activeRepository, getState, toast, useApp, type AppState } from "../../store";
import { Icon } from "../../ui/icons";
import { useNav } from "../../ui/nav";
import { ReadingDrawer } from "../reading/Drawer";
import { ReviewScheduleSheet } from "./ReviewScheduleSheet";
import { CorrectionDetail } from "./CorrectionDetail";
import { ReminderSheet } from "./ReminderSheet";
import { AddLearningNoteSheet } from "./AddLearningNoteSheet";
import { WordDetailSheet } from "./WordDetailSheet";
import { useVocabFeels } from "./feels";
import { consumeVaultSection, subscribeVaultSection, type VaultSection } from "./sectionGate";
import { formatDueAt, pendingReinforcements, phoneticLabel, savedCorrections, stageBucketOf, STAGE_BUCKET_LABEL, timeLabel, vocabDerived, type StageBucket, type VocabDerived } from "./derive";
import type { SavedCorrection } from "./derive";

type SortKey = "recent" | "lookups" | "alpha";
type ReviewMode = "cloze" | "listen" | "speak";
/* 原型 V2_LEARN_MODES（html:2747）：三模式标签与说明。 */
const REVIEW_MODES: [ReviewMode, string, string][] = [
  ["cloze", "填空回忆", "从原句里回忆表达"],
  ["listen", "听音辨认", "先听音，再核对文字"],
  ["speak", "开口使用", "用这个表达试着说一句"],
];
/* 复习模式跨页面保留（原型 v2LaunchReview 写回 APP.ui.vault.mode，html:2910）：从复习页返回
   今日复习时模式 chips 停在上次所选，不回落到「填空回忆」。仅内存 UI 状态，不落盘。 */
let lastReviewMode: ReviewMode = "cloze";

export function VaultBody() {
  const state = useApp((s) => s);
  const [section, setSection] = useState<VaultSection>("today");
  const [correction, setCorrection] = useState<SavedCorrection | null>(null);
  const feels = useVocabFeels();
  /* 实时到期：最早一条待强化（forgot 10 分钟回流窗）到点时重算 pending/due（原型 fast-forward 后
     待强化卡收起、due 卡回到「现在有 N 条可复习」），vault 页在前台时 toast 提示。 */
  const [clock, setClock] = useState(0);

  useEffect(() => {
    const applySection = () => {
      const next = consumeVaultSection();
      if (next) setSection(next);
    };
    const unsubscribe = subscribeVaultSection(applySection);
    /* 入口可能在本组件挂载或 effect 订阅前触发；内存意图补上这一段事件空窗。 */
    applySection();
    return unsubscribe;
  }, []);

  const derived = useMemo(() => vocabDerived(state), [state]);
  const pending = useMemo(() => pendingReinforcements(state), [state.vocab, state.reviewEvents, clock]); // eslint-disable-line react-hooks/exhaustive-deps
  const corrections = useMemo(() => savedCorrections(state), [state.tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const next = pending[0]?.dueAt;
    if (!next) return;
    const timer = window.setTimeout(() => {
      setClock((c) => c + 1);
      /* 原型 toast「演示时间已前进十分钟，待巩固内容现在可复习」（html:1750）由看板「快进十分钟」演示时钟
         触发，前半句描述的是演示动作；App 无演示时钟、由真实 10 分钟回流窗到点触发，前半句取等价的真实陈述
         「十分钟已过」（复检 r2 vault-today-fast-forward，有出处的有意偏差）。 */
      if (getState().tab === "vocab" && !document.querySelector(".push-scrim.on")) toast("十分钟已过，待巩固内容现在可复习", { icon: "clock" });
    }, Math.min(Math.max(0, next - Date.now()) + 80, 2147483000));
    return () => window.clearTimeout(timer);
  }, [pending]);

  /* 标签页内整页：独立纠偏详情（ui/nav.tsx 不在本阶段文件范围，不新增 push 名）。
     原型 VIEWS.correction（html:2996-3004）是整页（无 rhead/无底部导航）——挂 fixed 整层
     盖住笔记与复习页头与 tabbar，形态与练习复盘内打开的纠偏层一致。 */
  if (correction) return <div className="correction-layer"><CorrectionDetail task={correction.task} attempt={correction.attempt} onBack={() => setCorrection(null)} /></div>;

  const bucketCounts: Record<StageBucket, number> = { fresh: 0, familiar: 0, spoken: 0 };
  for (const w of state.vocab) bucketCounts[stageBucketOf(w, feels.get(w.id))]++;

  return (
    <main className="learning-body">
      <div className="learning-seg soft v2-vault-seg">
        {([["today", "今日复习"], ["words", `生词本 ${state.vocab.length}`], ["notes", "我的笔记"]] as ["today" | "words" | "notes", string][]).map(([key, label]) => (
          <button key={key} className={section === key ? "on" : ""} onClick={() => setSection(key)}>
            {label}
          </button>
        ))}
      </div>

      {section === "today" ? (
        <TodaySection state={state} pending={pending} bucketCounts={bucketCounts} derived={derived} onGoWords={() => setSection("words")} />
      ) : section === "words" ? (
        <WordbookBody />
      ) : (
        <NotesSection corrections={corrections} state={state} onOpenCorrection={setCorrection} />
      )}
    </main>
  );
}

/* ---------- 今日复习 ---------- */

function TodaySection({
  state,
  pending,
  bucketCounts,
  derived,
  onGoWords,
}: {
  state: AppState;
  pending: ReturnType<typeof pendingReinforcements>;
  bucketCounts: Record<StageBucket, number>;
  derived: Map<string, VocabDerived>;
  onGoWords: () => void;
}) {
  const nav = useNav();
  const [mode, setModeState] = useState<ReviewMode>(() => lastReviewMode);
  const setMode = (next: ReviewMode) => {
    lastReviewMode = next;
    setModeState(next);
  };
  const [reminderOpen, setReminderOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [wordSheet, setWordSheet] = useState<string | null>(null);
  const [resume, setResume] = useState<{ done: number; total: number } | null>(null);
  /* push 栈清空（从复习页返回）时重读续学草稿。 */
  const [pushTick, setPushTick] = useState(0);
  useEffect(() => {
    const onPushChange = () => setPushTick((t) => t + 1);
    window.addEventListener("mobile-push-change", onPushChange);
    return () => window.removeEventListener("mobile-push-change", onPushChange);
  }, []);

  /* 续学行（原型 v2-resume-review）：有进行中的复习轮草稿（local.review/current）时出现；
     点击直接进复习页——ReviewScreen 自身会恢复该草稿队列与进度。state 变化（评分/完成回写）
     与 push 栈清空（返回本页）时重读。 */
  useEffect(() => {
    let alive = true;
    void activeRepository()
      .get<{ queue?: unknown[]; pos?: number; finished?: boolean; results?: unknown[] }>("local.review", "current")
      .then((row) => {
        if (!alive) return;
        const draft = row && !row.deleted ? row.payload : null;
        if (draft && Array.isArray(draft.queue) && draft.queue.length && !draft.finished && typeof draft.pos === "number" && draft.pos < draft.queue.length) {
          setResume({ done: Array.isArray(draft.results) ? draft.results.length : draft.pos, total: draft.queue.length });
        } else {
          setResume(null);
        }
      })
      .catch(() => setResume(null));
    return () => {
      alive = false;
    };
  }, [state, pushTick]);

  const due = state.vocab.filter((w) => !w.paused && w.dueAt <= Date.now());
  const fresh = due.filter((w) => (w.srs?.reps ?? 0) === 0).length;
  const nextScheduled = [...state.vocab].filter((w) => !w.paused && w.dueAt > Date.now()).sort((a, b) => a.dueAt - b.dueAt)[0];
  const modeDesc = REVIEW_MODES.find(([key]) => key === mode)?.[2] ?? "";
  const lastGradeForgot = new Set([...derived.entries()].filter(([, d]) => d.lastGrade === "forgot").map(([id]) => id));

  return (
    <>
      {resume && (
        <button className="v2-resume-review" onClick={() => nav.push("review")}>
          <span>
            <Icon name="hist" size={14} />
            继续上次复习
          </span>
          <b>
            已完成 {resume.done} / {resume.total}
            <Icon name="right" size={13} />
          </b>
        </button>
      )}

      <section className="learning-card v2-due-card" style={{ marginTop: 12 }}>
        <span className="v2-eyebrow">你读过的，值得再见一次</span>
        <h3>
          {due.length ? (
            <>
              现在有 <span className="en">{due.length}</span> 条可复习
            </>
          ) : pending.length ? (
            "本轮已完成，还有待强化的表达"
          ) : state.vocab.some((w) => !w.paused) ? (
            "今天暂时没有到期复习"
          ) : (
            "所有词条都已暂停复习"
          )}
        </h3>
        <p>
          {due.length
            ? `首次复习 ${fresh} 条 · 到期回顾 ${due.length - fresh} 条 · 约 ${Math.max(1, Math.ceil(due.length * 0.6))} 分钟`
            : pending.length
              ? `${pending.length} 条在 ${formatDueAt(pending[0].dueAt)} 可再练。`
              : state.vocab.some((w) => !w.paused)
                ? "可以继续阅读，也可以挑一个词再练一次。"
                : "在生词详情中恢复，就会重新进入复习队列。"}
        </p>
        <div className="v2-review-modes" role="group" aria-label="复习模式">
          {REVIEW_MODES.map(([key, label]) => (
            <button key={key} className={`learning-chip${mode === key ? " on" : ""}`} aria-pressed={mode === key} onClick={() => setMode(key)}>
              {label}
            </button>
          ))}
        </div>
        <p className="v2-mode-description">{modeDesc}</p>
        {due.length ? (
          <button className="btn" style={{ width: "100%" }} onClick={() => nav.push("review", { mode })}>
            开始这一轮
          </button>
        ) : (
          <button className="btn" style={{ width: "100%" }} onClick={() => actions.setTab("today")}>
            继续阅读
          </button>
        )}
        <div className="v2-badge-explain">底部角标只表示现在到期的复习条数。</div>
      </section>

      {pending.length > 0 && (
        <section className="learning-card v2-reinforcement">
          <div className="v2-learning-title">
            <b>待强化 {pending.length} 条</b>
            <span className="learning-tag" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
              {formatDueAt(pending[0].dueAt)}
            </span>
          </div>
          <p>刚才没记住的表达，过一会儿再回忆一次。</p>
          {pending.slice(0, 3).map((p) => (
            <button key={p.word.id} className="v2-wait-word" onClick={() => setWordSheet(p.word.id)}>
              <span className="en">{p.word.word}</span>
              <small>{formatDueAt(p.dueAt)}</small>
              <Icon name="right" size={14} />
            </button>
          ))}
        </section>
      )}

      {nextScheduled && (
        <button className="learning-card v2-next-review" onClick={() => setScheduleOpen(true)}>
          <span>
            <b>下一次复习安排</b>
            <small>
              {formatDueAt(nextScheduled.dueAt)} · {nextScheduled.word}
            </small>
          </span>
          <Icon name="right" size={15} />
        </button>
      )}

      <section className="learning-card v2-word-stats">
        {(["fresh", "familiar", "spoken"] as StageBucket[]).map((bucket) => (
          <button
            key={bucket}
            onClick={() => {
              stageFilterSeed = bucket;
              stageFilterSeedAt = Date.now();
              onGoWords();
            }}
          >
            <small>{STAGE_BUCKET_LABEL[bucket]}</small>
            <b>{bucketCounts[bucket]}</b>
          </button>
        ))}
      </section>
      <p className="v2-learning-caption" style={{ marginTop: 8 }}>
        掌握阶段是你的学习感受；刚收集的词也会进入首轮复习。
      </p>

      {due.length > 0 && (
        <>
          <div className="v2-sec-h" style={{ margin: "20px 2px 10px" }}>
            <b>这一轮要见面的表达</b>
            <span>{due.length} 条</span>
          </div>
          <section className="learning-card v2-review-preview">
            {due.slice(0, 4).map((w) => (
              <button key={w.id} onClick={() => setWordSheet(w.id)}>
                <span>
                  <b>{w.word}</b>
                  <small>{w.senses.map((s) => `${s.pos} ${s.cn}`.trim()).join("；")}</small>
                </span>
                <span className="learning-tag">{lastGradeForgot.has(w.id) ? "待强化" : (w.srs?.reps ?? 0) === 0 ? "首次复习" : "到期"}</span>
              </button>
            ))}
          </section>
        </>
      )}

      <button className="v2-reminder-row" onClick={() => setReminderOpen(true)}>
        <Icon name="bell" size={14} />
        <span>{state.settings.daily ? `每日 ${state.settings.remindTime} 提醒学习` : "选一个适合自己的学习时间"}</span>
        <Icon name="right" size={13} />
      </button>

      <ReviewScheduleSheet open={scheduleOpen} onClose={() => setScheduleOpen(false)} />
      <ReminderSheet open={reminderOpen} onClose={() => setReminderOpen(false)} />
      {wordSheet && <WordDetailSheet wordId={wordSheet} onClose={() => setWordSheet(null)} />}
    </>
  );
}

/* 统计三格 → 生词本的跨组件桶筛选传递（同文件内模块级种子，落点页挂载即消费）。 */
let stageFilterSeed: StageBucket | null = null;
let stageFilterSeedAt = 0;

/* ---------- 生词本（tab 内嵌与独立 push 页共用本主体） ---------- */

export function WordbookBody() {
  const state = useApp((s) => s);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [stageFilter, setStageFilter] = useState<StageBucket | "all" | "paused">("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "word" | "chunk">("all");
  const [addOpen, setAddOpen] = useState(false);
  const [wordSheet, setWordSheet] = useState<string | null>(null);
  const trash = state.trash;
  const feels = useVocabFeels();

  /* 掌握阶段三格跳入：带桶筛选落到生词本（模块级种子，仅刚发生时消费）。 */
  useEffect(() => {
    if (stageFilterSeed && Date.now() - stageFilterSeedAt < 1500) {
      setStageFilter(stageFilterSeed);
      stageFilterSeed = null;
    }
  }, []);

  const derived = useMemo(() => vocabDerived(state), [state]);
  const q = query.trim().toLowerCase();
  const list = state.vocab
    .filter((w) => {
      const stageOk = stageFilter === "all" || (stageFilter === "paused" ? w.paused : stageBucketOf(w, feels.get(w.id)) === stageFilter);
      const typeOk = typeFilter === "all" || (w.kind ?? "word") === typeFilter;
      const text = `${w.word} ${w.phonetic ?? ""} ${w.senses.map((s) => s.cn).join(" ")} ${w.note ?? ""}`.toLowerCase();
      return stageOk && typeOk && (!q || text.includes(q));
    })
    .sort((a, b) => {
      if (sort === "alpha") return a.word.toLowerCase().localeCompare(b.word.toLowerCase(), "en");
      if (sort === "lookups") return (derived.get(b.id)?.lookups ?? 0) - (derived.get(a.id)?.lookups ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    });
  const filtered = Boolean(q) || stageFilter !== "all" || typeFilter !== "all";

  return (
    <>
      {trash?.kind === "vocab" && trash.vocab && (
        <div className="v2-undo-row" role="status">
          <span>
            已移除 <b className="en">{trash.vocab.word}</b>
          </span>
          <button onClick={() => actions.undoTrash()}>撤销</button>
        </div>
      )}

      <div className="v2-word-search">
        <Icon name="search" size={15} />
        <input className="input" value={query} type="search" onChange={(e) => setQuery(e.target.value)} placeholder="搜索词、释义、原句或助记" aria-label="搜索生词" />
        {query && (
          <button aria-label="清空搜索" onClick={() => setQuery("")}>
            <Icon name="close" size={15} />
          </button>
        )}
      </div>

      <div className="v2-word-tools">
        <label>
          排序
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="生词排序">
            {([["recent", "最近收藏"], ["lookups", "查词频次"], ["alpha", "字母顺序"]] as [SortKey, string][]).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {/* 原型 v2-word-tools 里的「+ 记生词」是默认 .btn（白底描边 pill，html:2852），非 primary 实底 */}
        <button className="btn-ghost v2-word-add" onClick={() => setAddOpen(true)}>
          <Icon name="plus" size={14} />
          记生词
        </button>
      </div>

      <div className="v2-learning-filters" aria-label="按掌握阶段筛选">
        {([["all", "全部阶段"], ["fresh", "刚收集"], ["familiar", "眼熟"], ["spoken", "能说出口"], ["paused", "已暂停"]] as [StageBucket | "all" | "paused", string][]).map(([key, label]) => (
          <button key={key} className={`learning-chip${stageFilter === key ? " on" : ""}`} aria-pressed={stageFilter === key} onClick={() => setStageFilter(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="v2-learning-filters" aria-label="按词条类型筛选">
        {([["all", "全部类型"], ["word", "单词"], ["chunk", "词块"]] as ["all" | "word" | "chunk", string][]).map(([key, label]) => (
          <button key={key} className={`learning-chip${typeFilter === key ? " on" : ""}`} aria-pressed={typeFilter === key} onClick={() => setTypeFilter(key)}>
            {label}
          </button>
        ))}
        {filtered && (
          <button
            className="v2-clear-filters"
            onClick={() => {
              setQuery("");
              setStageFilter("all");
              setTypeFilter("all");
            }}
          >
            清除全部筛选
          </button>
        )}
      </div>

      <p className="v2-result-count">{filtered ? `符合条件 ${list.length} / 共 ${state.vocab.length} 条` : `共 ${state.vocab.length} 条生词与词块`}</p>

      {list.length ? (
        <section className="learning-card v2-word-list">
          {list.map((w) => {
            const article = w.sourceArticleId ? state.articles.find((a) => a.id === w.sourceArticleId) : undefined;
            const phonetic = phoneticLabel(w.phonetic);
            return (
              <button key={w.id} className="v2-word-item" onClick={() => setWordSheet(w.id)}>
                <span className="v2-word-line">
                  <b className="en">{w.word}</b>
                  <Icon name="right" size={15} />
                </span>
                <span className="v2-word-meta">
                  {phonetic && <span className="en">{phonetic}</span>}
                  <span className="learning-tag">{w.paused ? "已暂停" : STAGE_BUCKET_LABEL[stageBucketOf(w, feels.get(w.id))]}</span>
                </span>
                <span className="v2-word-definition">{w.senses.map((s) => `${s.pos} ${s.cn}`.trim()).join("；")}</span>
                <span className="v2-word-origin">
                  {article?.title || "手动收集"} · 查词 {derived.get(w.id)?.lookups ?? 0} 次
                </span>
              </button>
            );
          })}
        </section>
      ) : (
        <section className="learning-card v2-empty-card">
          <h3>{filtered ? "没有符合条件的词条" : "你的第一条表达，从这里开始"}</h3>
          <p>{filtered ? "试着清除筛选，或把这个表达手动记下来。" : "在阅读时收藏，也可以记下刚刚遇到的一个词。"}</p>
          <button
            className="btn"
            onClick={() => {
              if (filtered) {
                setQuery("");
                setStageFilter("all");
                setTypeFilter("all");
              } else {
                setAddOpen(true);
              }
            }}
          >
            {filtered ? "清除筛选" : "记一个生词"}
          </button>
        </section>
      )}

      <AddWordSheet open={addOpen} onClose={() => setAddOpen(false)} onSaved={(id) => id && setWordSheet(id)} />
      {/* 生词本内移除：顶部 v2-undo-row 承担撤销，toast 不再内嵌撤销钮（原型 v2-word-remove，html:3114） */}
      {wordSheet && <WordDetailSheet wordId={wordSheet} inlineUndo onClose={() => setWordSheet(null)} />}
    </>
  );
}

/* ---------- 我的笔记 ---------- */

function NotesSection({
  state,
  corrections,
  onOpenCorrection,
}: {
  state: AppState;
  corrections: SavedCorrection[];
  onOpenCorrection: (c: SavedCorrection) => void;
}) {
  const nav = useNav();
  const [filter, setFilter] = useState<"all" | "correction" | "word" | "note">("all");
  const [addOpen, setAddOpen] = useState(false);
  const [wordSheet, setWordSheet] = useState<string | null>(null);

  const wordNotes = state.vocab.filter((w) => w.note);
  const records = [
    ...corrections.map((c) => ({
      id: `correction:${c.attempt.id}`,
      type: "correction" as const,
      title: c.attempt.feedback!.improved,
      text: `原话：${c.attempt.text}`,
      src: c.task.title || "口语练习",
      at: c.attempt.feedback!.savedAt ?? c.attempt.createdAt,
      go: () => onOpenCorrection(c),
    })),
    ...wordNotes.map((w) => ({
      id: `word:${w.id}`,
      type: "word" as const,
      title: w.word,
      text: w.note || "",
      src: "生词助记",
      at: w.createdAt ?? w.updatedAt ?? 0,
      go: () => setWordSheet(w.id),
    })),
    ...state.notes.map((n) => ({
      id: `note:${n.id}`,
      type: "note" as const,
      title: n.title || "学习笔记",
      text: n.body,
      src: n.sub || "我的笔记",
      at: n.createdAt ?? n.updatedAt ?? 0,
      go: () => nav.push("learningNote", { id: n.id }),
    })),
  ]
    .filter((r) => filter === "all" || filter === r.type)
    .sort((a, b) => b.at - a.at);
  const counts = { correction: corrections.length, word: wordNotes.length, note: state.notes.length };

  return (
    <>
      <div className="v2-note-toolbar">
        <div className="v2-learning-filters">
          {([["all", "全部"], ["correction", `口语纠偏 ${counts.correction}`], ["word", `生词助记 ${counts.word}`], ["note", `学习笔记 ${counts.note}`]] as ["all" | "correction" | "word" | "note", string][]).map(([key, label]) => (
            <button key={key} className={`learning-chip${filter === key ? " on" : ""}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>
        <button className="btn-ghost" style={{ width: "100%", border: "1px solid var(--hairline-strong)" }} onClick={() => setAddOpen(true)}>
          <Icon name="pen" size={15} />
          写一条学习笔记
        </button>
      </div>

      {records.length ? (
        <section className="learning-card v2-note-list">
          {records.map((r) => (
            <button key={r.id} className="v2-note-item" onClick={r.go}>
              <span className="v2-note-h">
                <span className="learning-tag">{r.type === "correction" ? "口语纠偏" : r.type === "word" ? "生词助记" : "学习笔记"}</span>
                {r.src} · {r.at ? timeLabel(r.at) : "刚刚"}
              </span>
              <b className={r.type === "note" ? "" : "en"}>{r.title}</b>
              <p>{r.text}</p>
              <span className="v2-note-link">
                {r.type === "correction" ? "看改法与原因，再练这句" : r.type === "word" ? "查看对应词条" : "打开笔记"}
                <Icon name="right" size={13} />
              </span>
            </button>
          ))}
        </section>
      ) : (
        <section className="learning-card v2-empty-card">
          <h3>{filter === "all" ? "让自己的心得，有地方可回看" : "这一类还没有笔记"}</h3>
          <p>生词助记与口语纠偏会各自归档，你也可以记下学习时的小发现。</p>
          <button className="btn" onClick={() => setAddOpen(true)}>
            写一条笔记
          </button>
        </section>
      )}

      <AddLearningNoteSheet open={addOpen} onClose={() => setAddOpen(false)} />
      {wordSheet && <WordDetailSheet wordId={wordSheet} onClose={() => setWordSheet(null)} />}
    </>
  );
}

/* ---------- 加词抽屉（原型 SHEETS.addWord，html:2880-2888）：五字段 + 类型下拉 +
   保存并查看词条；必填报错「请填写英文表达与中文释义。」，重复词条先检出再拦。 ---------- */

function AddWordSheet({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (id: string) => void }) {
  const vocab = useApp((s) => s.vocab);
  const [word, setWord] = useState("");
  const [kind, setKind] = useState<"word" | "chunk">("word");
  const [meaning, setMeaning] = useState("");
  const [sentence, setSentence] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const trimmed = word.trim();
  const dup = trimmed ? vocab.find((w) => w.word.toLowerCase() === trimmed.toLowerCase()) : undefined;

  /* 每次打开重置表单（原型 draft 语义：抽屉即新加词）。 */
  useEffect(() => {
    if (open) {
      setWord("");
      setKind("word");
      setMeaning("");
      setSentence("");
      setNote("");
      setError("");
    }
  }, [open]);

  function save() {
    if (!trimmed || !meaning.trim()) {
      setError("请填写英文表达与中文释义。");
      return;
    }
    if (dup) {
      setError(`「${dup.word}」已在生词本，不用重复添加。`);
      return;
    }
    actions.saveWord({ word: trimmed, kind, senses: [{ pos: "", cn: meaning.trim() }], pattern: sentence.trim() || undefined }, kind);
    const created = getState().vocab.find((w) => w.word.toLowerCase() === trimmed.toLowerCase());
    if (note.trim() && created) actions.updateWord(created.id, { note: note.trim() });
    onClose();
    onSaved(created?.id ?? "");
  }

  return (
    <ReadingDrawer open={open} onClose={onClose} label="记一个生词或词块">
      {/* 抽屉头（原型 .sh-head：17px 无衬线粗体标题 + 说明 + 下缘分隔线，html:417,2882） */}
      <div className="v2-sh-head">
        <div className="sheet-title plain">记一个生词或词块</div>
        <p className="v2-learning-caption">保存后加入首轮复习，记录保存在这里。</p>
      </div>
      <div style={{ marginTop: 12 }}>
        <label htmlFor="v2-word-add-text" style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--ink-2)", marginBottom: 5 }}>
          英文表达
        </label>
        <input
          id="v2-word-add-text"
          className="input"
          value={word}
          placeholder="例如 take a break"
          maxLength={160}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => {
            setWord(e.target.value);
            setError("");
          }}
          aria-label="英文表达"
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <label htmlFor="v2-word-add-type" style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--ink-2)", marginBottom: 5 }}>
          类型
        </label>
        <select id="v2-word-add-type" className="input" value={kind} onChange={(e) => setKind(e.target.value as "word" | "chunk")} aria-label="类型">
          <option value="word">单词</option>
          <option value="chunk">词块 / 短语</option>
        </select>
      </div>
      <div style={{ marginTop: 12 }}>
        <label htmlFor="v2-word-add-pos" style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--ink-2)", marginBottom: 5 }}>
          中文释义与词性
        </label>
        <input
          id="v2-word-add-pos"
          className="input"
          value={meaning}
          placeholder="例如 phr. 休息一下"
          maxLength={500}
          onChange={(e) => {
            setMeaning(e.target.value);
            setError("");
          }}
          aria-label="中文释义与词性"
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <label htmlFor="v2-word-add-sent" style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--ink-2)", marginBottom: 5 }}>
          例句（选填）
        </label>
        <textarea id="v2-word-add-sent" className="input" rows={2} maxLength={2000} value={sentence} onChange={(e) => setSentence(e.target.value)} aria-label="例句" />
      </div>
      <div style={{ marginTop: 12 }}>
        <label htmlFor="v2-word-add-note" style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--ink-2)", marginBottom: 5 }}>
          我的助记（选填）
        </label>
        <textarea id="v2-word-add-note" className="input" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} aria-label="我的助记" />
      </div>
      {dup && !error && (
        <p className="v2-learning-caption" style={{ color: "var(--warn)" }}>
          「{dup.word}」已在生词本，不用重复添加。
        </p>
      )}
      {error && (
        <div className="v2-field-error" role="alert">
          {error}
        </div>
      )}
      <button className="btn" style={{ width: "100%", marginTop: 16 }} onClick={save}>
        保存并查看词条
      </button>
    </ReadingDrawer>
  );
}
