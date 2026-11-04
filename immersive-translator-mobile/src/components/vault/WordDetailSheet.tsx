/**
 * 词条详情底部抽屉（proto-parity · sheet-word-detail / sheet-word-edit / sheet-word-remove，
 * 原型 SHEETS.wordDetail/wordEdit/wordRemove，html:2858-2889）：
 * 抽屉头词头（28px 衬线词 + 圆形发音钮 + 音标 + 类型 tag + 释义）→「我对这个词的感觉」三档
 * （刚收集/眼熟/能说出口，选中 accent 实底白字）→ 原句 trunk（accent-soft，词高亮）→
 * 我的助记与例句（编辑进二级编辑抽屉）→ 复习安排卡（暂停/现在练一次）→ 学习记录时间线 →
 * 底部「🎤用这个表达说一句」主按钮 +「移除词条」→ 移除两钮确认抽屉（保留词条/确认移除）。
 * 我的例句为设备本地数据（local.vocabExample，同 local.vocabFeel 口径：不进同步载荷）。
 * 生词本/复习安排/搜索/复习星标等入口均以抽屉打开；词典卡「查看词条」保留既有 push 页
 * （WordDetailPage，同内容整页形态）。
 * 复检 r1：编辑/移除为「替换式」单层抽屉（原型 openSheet 入栈即替换显示，back 回到词条详情）——
 * 打开编辑/移除时收起词条详情抽屉，取消后再展开；词头下缘分隔线（原型 .sh-head border-bottom）；
 * 自评 chips 未自评时高亮当前推导阶段（原型每个词恒有 stage）。
 */
import { useEffect, useState } from "react";
import { actions, activeRepository, commitRepository, getState, profileIdentity, speak, toast, useApp } from "../../store";
import { useNav } from "../../ui/nav";
import { Icon } from "../../ui/icons";
import { ReadingDrawer } from "../reading/Drawer";
import { openPractice } from "../../screens/LearningHome";
import { BUCKET_FEEL, FEEL_KEYS, formatDueAt, GRADE_LABEL, MODE_LABEL, phoneticLabel, stageBucketOf, timeLabel, vocabDerived, type Feel } from "./derive";
import { FEEL_EVENT } from "./feels";
import type { VocabWord } from "../../core/types";

/* 原型「我对这个词的感觉」三档（html:2863-2864）：存储键沿用 local.vocabFeel 既有
   forgot/hard/easy（主观自评标记，不参与同步），仅展示文案对齐原型阶段命名。 */
const FEELS: { key: Feel; label: string }[] = [
  { key: "forgot", label: "刚收集" },
  { key: "hard", label: "眼熟" },
  { key: "easy", label: "能说出口" },
];

/* 释义与词性合写字段（原型 w.pos「n. 志愿者（复数）」）：保存时拆出行首词性前缀。 */
const POS_PREFIX = /^((?:[a-z]{1,6}\.)(?:\s*\/\s*[a-z]{1,6}\.)*|phrasal|idiom|collocation|pattern)\s+(\S[\s\S]*)$/i;

export function WordDetailSheet({ wordId, onClose, inlineUndo = false }: { wordId: string; onClose: () => void; inlineUndo?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const word = useApp((s) => s.vocab.find((w) => w.id === wordId));
  return (
    <>
      <ReadingDrawer open={!!word && !editing && !removing} onClose={onClose} label="词条详情">
        {word && <WordDetailBody word={word} onEdit={() => setEditing(true)} onRemove={() => setRemoving(true)} />}
      </ReadingDrawer>
      {word && editing && <WordEditSheet word={word} onClose={() => setEditing(false)} />}
      {word && removing && <WordRemoveSheet word={word} inlineUndo={inlineUndo} onClose={() => setRemoving(false)} onRemoved={onClose} />}
    </>
  );
}

/** 词条详情主体（抽屉与 push 页共用）。 */
export function WordDetailBody({ word, onEdit, onRemove }: { word: VocabWord; onEdit: () => void; onRemove: () => void }) {
  const nav = useNav();
  const reviewEvents = useApp((s) => s.reviewEvents);
  const tasks = useApp((s) => s.tasks);
  const articles = useApp((s) => s.articles);
  const [feel, setFeel] = useState<Feel | null>(null);
  const [example, setExample] = useState("");

  useEffect(() => {
    let alive = true;
    const identity = profileIdentity();
    void Promise.all([
      activeRepository().get<{ feel: Feel; at: number }>("local.vocabFeel", word.id),
      activeRepository().get<{ example: string }>("local.vocabExample", word.id),
    ])
      .then(([feelRow, exampleRow]) => {
        if (!alive || identity !== profileIdentity()) return;
        if (feelRow && !feelRow.deleted && feelRow.payload && FEEL_KEYS.includes(feelRow.payload.feel)) setFeel(feelRow.payload.feel);
        if (exampleRow && !exampleRow.deleted && exampleRow.payload) setExample(exampleRow.payload.example || "");
      })
      .catch((error) => toast(String(error)));
    return () => {
      alive = false;
    };
  }, [word.id]);

  const derived = vocabDerived({ vocab: [word], reviewEvents, tasks }).get(word.id);
  const timeline = [...(derived?.events ?? [])].slice(-7).reverse();
  const article = word.sourceArticleId ? articles.find((a) => a.id === word.sourceArticleId) : undefined;
  const sentence = article?.sentences[word.sourceSentenceIdx];
  const kindLabel = (word.kind ?? "word") === "chunk" ? "词块" : "单词";
  const phonetic = phoneticLabel(word.phonetic);
  /* 原型每个词恒有阶段（w.stage）：未自评时高亮当前推导阶段，自评后以自评为准。 */
  const activeFeel: Feel = feel ?? BUCKET_FEEL[stageBucketOf(word)];

  function chooseFeel(key: Feel) {
    const identity = profileIdentity();
    const payload = { feel: key, at: Date.now() };
    setFeel(key);
    void commitRepository({ records: [{ collection: "local.vocabFeel", id: word.id, payload }] })
      .then(() => {
        if (identity !== profileIdentity()) toast("账号已切换，这次自评保存在原账号。");
        else window.dispatchEvent(new Event(FEEL_EVENT));
      })
      .catch((error) => toast(String(error)));
  }

  function backToSource() {
    const a = getState().articles.find((x) => x.id === word.sourceArticleId);
    if (!a) {
      toast("原文尚未同步到这台设备");
      return;
    }
    actions.locateReader(a.id, word.sourceSentenceIdx);
    nav.push("reader", { articleId: a.id });
  }

  /* 复习状态文案（原型 v2WordStatus 口径，html:2805-2811）：已暂停复习 / 待强化 · 时间 /
     新收集 · 可开始首轮复习 / 复习已到期 / 下次复习 · 时间。 */
  const now = Date.now();
  const status = word.paused
    ? "已暂停复习"
    : derived?.lastGrade === "forgot" && word.dueAt > now
      ? `待强化 · ${formatDueAt(word.dueAt, now)}`
      : word.dueAt <= now
        ? (word.srs?.reps ?? 0) === 0
          ? "新收集 · 可开始首轮复习"
          : "复习已到期"
        : `下次复习 · ${formatDueAt(word.dueAt, now)}`;

  return (
    <>
      <div className="v2-word-hero">
        <div className="v2-word-line">
          <b className="en">{word.word}</b>
          <button className="ibtn" aria-label={`听 ${word.word} 的发音`} onClick={() => speak(word.word)}>
            <Icon name="speaker" size={18} />
          </button>
        </div>
        <div className="v2-word-meta">
          {phonetic && <span className="en">{phonetic}</span>}
          <span className="learning-tag">{kindLabel}</span>
        </div>
        <p>{word.senses.map((s) => `${s.pos} ${s.cn}`.trim()).join("；")}</p>
      </div>

      <div className="v2-word-detail">
        <div className="v2-learning-title"><b>我对这个词的感觉</b></div>
        <div className="v2-learning-filters" role="group" aria-label="我对这个词的感觉">
          {FEELS.map((f) => (
            <button key={f.key} className={`learning-chip${activeFeel === f.key ? " on" : ""}`} aria-pressed={activeFeel === f.key} onClick={() => chooseFeel(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
        <p className="v2-learning-caption">“能说出口”表示你自评能主动使用，可随时调整。</p>

        <div className="v2-word-context">
          <small>原句 · {article?.title || "手动记录"}</small>
          <div className="en" lang="en">
            {sentence?.en ? highlight(sentence.en, word.word) : word.pattern || "还没有记录原句"}
          </div>
          {sentence?.zh && <p>{sentence.zh}</p>}
          {article && (
            <button className="btn-ghost" style={{ width: "100%", border: "1px solid var(--hairline-strong)" }} onClick={backToSource}>
              回到《{article.title}》第 {word.sourceSentenceIdx + 1} 句 <Icon name="right" size={14} />
            </button>
          )}
        </div>

        <div className="v2-learning-title">
          <b>我的助记与例句</b>
          <button className="btn-ghost" style={{ width: "auto", minWidth: 96, border: "1px solid var(--hairline-strong)" }} onClick={onEdit}>
            <Icon name="pen" size={14} />
            编辑
          </button>
        </div>
        <div className="v2-word-personal learning-card">
          <p>{word.note || "还没有助记，可以用自己的话解释这个词。"}</p>
          {example && (
            <div className="en" lang="en">
              {highlight(example, word.word)}
            </div>
          )}
        </div>

        <div className="v2-word-schedule learning-card">
          <b>{status}</b>
          <p className="meta" style={{ margin: "5px 0 0" }}>
            已复习 {word.srs?.reps ?? 0} 次 · 当前间隔 {word.srs?.intervalDays ?? 0} 天 · 查词 {derived?.lookups ?? 0} 次 · 开口 {derived?.spoken ?? 0} 次
          </p>
          <div className="v2-learning-actions">
            <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)" }} onClick={() => actions.updateWord(word.id, { paused: !word.paused })}>
              {word.paused ? "恢复复习" : "暂停复习"}
            </button>
            {!word.paused && (
              <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)" }} onClick={() => nav.push("review", { wordId: word.id })}>
                现在练一次
              </button>
            )}
          </div>
        </div>

        <div className="v2-learning-title">
          <b>学习记录</b>
          <span>查词 {derived?.lookups ?? 0} · 开口 {derived?.spoken ?? 0}</span>
        </div>
        <div className="v2-timeline">
          {timeline.length ? (
            timeline.map((e) => (
              <p key={e.id} className="v2-tl-node">
                <b>
                  {MODE_LABEL[e.mode] ?? e.mode} · {e.grade ? GRADE_LABEL[e.grade] : "已记录"}
                </b>
                <small>{timeLabel(e.reviewedAt)}</small>
              </p>
            ))
          ) : (
            <p className="v2-learning-caption">刚刚收藏，从第一次复习开始。</p>
          )}
        </div>

        <button
          className="btn v2-word-practice"
          style={{ width: "100%" }}
          onClick={() =>
            void openPractice(nav, {
              mode: "word",
              title: word.word,
              word: word.word,
              reference: `用 ${word.word} 说一句自己的话。`,
              source: { articleId: word.sourceArticleId, sentenceIdx: word.sourceSentenceIdx },
            })
          }
        >
          <Icon name="mic" size={15} />
          用这个表达说一句
        </button>
        <button className="btn-ghost v2-word-remove" aria-label="移除词条" onClick={onRemove}>
          <Icon name="trash" size={15} />
          移除词条
        </button>
      </div>
    </>
  );
}

/** 词条编辑抽屉（原型 SHEETS.wordEdit，html:2871-2879）：释义与词性必填 + 助记与用法 +
 *  我的例句（选填，设备本地 local.vocabExample）。保存后保留原句来源，toast 报真实结果。 */
export function WordEditSheet({ word, onClose }: { word: VocabWord; onClose: () => void }) {
  /* 「释义与词性」合写（原型 d.pos = w.pos「n. 志愿者（复数）」，html:3093）：预填带词性前缀。 */
  const [meaning, setMeaning] = useState(word.senses.map((s) => `${s.pos} ${s.cn}`.trim()).join("；"));
  const [note, setNote] = useState(word.note || "");
  const [example, setExample] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void activeRepository()
      .get<{ example: string }>("local.vocabExample", word.id)
      .then((row) => {
        if (!alive) return;
        setExample(row && !row.deleted && row.payload ? row.payload.example || "" : "");
      })
      .catch(() => setExample(""));
    return () => {
      alive = false;
    };
  }, [word.id]);

  function save() {
    const text = meaning.trim();
    if (!text) {
      setError("请写下这个词的释义。");
      return;
    }
    /* 行首词性前缀拆回 pos（n. / phr. / adj. / phrasal …），其余为中文释义；无前缀则只存释义。 */
    const hit = text.match(POS_PREFIX);
    actions.updateWord(word.id, { senses: [hit ? { pos: hit[1], cn: hit[2].trim() } : { pos: "", cn: text }], note: note.trim() || undefined });
    if (example !== null) {
      void commitRepository({ records: [{ collection: "local.vocabExample", id: word.id, payload: { example: example.trim() } }] }).catch((e) => toast(String(e)));
    }
    setError("");
    toast("已保存，原句来源也保留了");
    onClose();
  }

  return (
    <ReadingDrawer open={example !== null} onClose={onClose} label={`编辑 ${word.word}`}>
      <div className="v2-sh-head">
        <div className="sheet-title plain">编辑 {word.word}</div>
        <p className="v2-learning-caption">保留原句来源，写下更适合自己的理解。</p>
      </div>
      <div style={{ marginTop: 12 }}>
        <label htmlFor="v2-word-edit-pos" style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--ink-2)", marginBottom: 5 }}>
          释义与词性
        </label>
        <input id="v2-word-edit-pos" className="input" value={meaning} maxLength={500} onChange={(e) => { setMeaning(e.target.value); setError(""); }} aria-label="释义与词性" />
      </div>
      <div style={{ marginTop: 12 }}>
        <label htmlFor="v2-word-edit-note" style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--ink-2)", marginBottom: 5 }}>
          助记与用法
        </label>
        <textarea id="v2-word-edit-note" className="input" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} aria-label="助记与用法" />
      </div>
      {example !== null && (
        <div style={{ marginTop: 12 }}>
          <label htmlFor="v2-word-edit-example" style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--ink-2)", marginBottom: 5 }}>
            我的例句（选填）
          </label>
          <textarea id="v2-word-edit-example" className="input" rows={3} maxLength={2000} value={example} onChange={(e) => setExample(e.target.value)} aria-label="我的例句" />
        </div>
      )}
      {error && <div className="v2-field-error" role="alert">{error}</div>}
      <div className="v2-learning-actions" style={{ marginTop: 16 }}>
        <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)" }} onClick={onClose}>
          取消
        </button>
        <button className="btn" onClick={save}>
          保存修改
        </button>
      </div>
    </ReadingDrawer>
  );
}

/** 移除确认抽屉（原型 SHEETS.wordRemove，html:2889）：标题「移除 X？」+ 说明 +
 *  「保留词条」outline 与「确认移除」warn 双钮；确认走既有 deleteWord（5s 撤销窗不变）。
 *  inlineUndo：从生词本列表移除时由顶部撤销条承担撤销，toast 不再内嵌撤销钮（原型 html:3114）。
 *  onRemoved：词条删除后的宿主收尾（关详情抽屉 / push 页 pop）。 */
export function WordRemoveSheet({ word, onClose, onRemoved, inlineUndo = false }: { word: VocabWord; onClose: () => void; onRemoved: () => void; inlineUndo?: boolean }) {
  return (
    <ReadingDrawer open onClose={onClose} label={`移除 ${word.word}`}>
      <div className="v2-sh-head">
        <div className="sheet-title plain">移除 {word.word}？</div>
      </div>
      <p className="v2-learning-copy">词条与对应复习任务会一起移除。关联的口语纠偏笔记仍会保留，移除后可在生词本撤销。</p>
      <div className="v2-learning-actions" style={{ marginTop: 16 }}>
        <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)" }} onClick={onClose}>
          保留词条
        </button>
        <button
          className="btn v2-danger"
          onClick={() => {
            onClose();
            onRemoved();
            actions.deleteWord(word.id, { inlineUndo });
          }}
        >
          确认移除
        </button>
      </div>
    </ReadingDrawer>
  );
}

/** 词条详情 push 页（词典卡「查看词条」既有入口沿用）：同主体内容的整页形态。 */
export function WordDetailPage({ id }: { id: string }) {
  const nav = useNav();
  const word = useApp((s) => s.vocab.find((w) => w.id === id));
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <header className="learning-head">
        <button className="tlink" onClick={nav.pop}>
          返回
        </button>
        <h1>这个表达</h1>
        <span style={{ width: 44 }} />
      </header>
      <main className="learning-body">
        {word ? (
          <WordDetailBody word={word} onEdit={() => setEditing(true)} onRemove={() => setRemoving(true)} />
        ) : (
          <>
            <p>词条已移除，关联笔记仍保留。</p>
            <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)" }} onClick={nav.pop}>
              返回
            </button>
          </>
        )}
      </main>
      {word && editing && <WordEditSheet word={word} onClose={() => setEditing(false)} />}
      {word && removing && <WordRemoveSheet word={word} onClose={() => setRemoving(false)} onRemoved={() => nav.pop()} />}
    </>
  );
}

/** 词条在句中的 accent-soft 高亮（原型 v2WordHighlight 口径，html:2865）。 */
function highlight(text: string, word: string) {
  const at = text.toLowerCase().indexOf(word.toLowerCase());
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <span className="rv-hl">{text.slice(at, at + word.length)}</span>
      {text.slice(at + word.length)}
    </>
  );
}
