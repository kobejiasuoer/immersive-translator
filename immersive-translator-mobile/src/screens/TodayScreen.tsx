/**
 * 今天（Tab 1）—— §3.1：3 秒回答「今天该干什么」。
 * folio 行（今日已清 N/M + streak，与 hero 同源 reviewStats）→ 主角块
 * （大数字 + 开始复习 + 先清一张）→ 继续阅读 → 剪贴板/拍译两行组 → 练一练 → 本周。
 */
import { actions, reviewStats, toast, useApp } from "../store";
import { Icon } from "../ui/icons";
import { fmtDateCN } from "../ui/kit";
import { useNav } from "../ui/nav";

export default function TodayScreen() {
  const nav = useNav();
  const articles = useApp((s) => s.articles);
  const progress = useApp((s) => s.progress);
  const vocab = useApp((s) => s.vocab);
  const clip = useApp((s) => s.clip);
  const keyStored = useApp((s) => s.settings.keyStored);
  const st = useApp(reviewStats);

  /* 继续阅读：已开始且未读完的文章里取进度最深的一篇——未开始（progress 未写入）不占位，
     读完文不冒充「继续」（口径与书架「继续读」钉标一致，修 P-26 同源虚高） */
  const reading = articles
    .map((a) => ({ a, sent: progress[a.id] ?? 0, started: progress[a.id] !== undefined }))
    .filter((r) => r.started && r.sent < r.a.sentences.length - 1)
    .sort((x, y) => y.sent - x.sent)[0];

  /* 明日预告取真实 SRS 排程：明天 00:00–24:00 内到期的词数（修 P-05） */
  const win0 = new Date();
  win0.setDate(win0.getDate() + 1);
  win0.setHours(0, 0, 0, 0);
  const win1 = new Date();
  win1.setDate(win1.getDate() + 2);
  win1.setHours(0, 0, 0, 0);
  const dueTomorrow = vocab.filter((v) => v.dueAt >= win0.getTime() && v.dueAt < win1.getTime()).length;

  return (
    <div>
      <div className="folio">
        <span>{fmtDateCN()}</span>
        <span>
          今日已清 <b>{st.cleared}/{st.total}</b> · 连续 {st.streak} 天
        </span>
      </div>
      <div className="h1">今天</div>

      {!keyStored && (
        <div className="guide" onClick={() => nav.push("setModel")}>
          <Icon name="bolt" size={15} />
          <span>连上模型服务，翻译与查词就绪 · 去配置</span>
        </div>
      )}

      {st.due > 0 ? (
        <div className="hero">
          <div className="overline">生词到期</div>
          <div className="hero-row">
            <div className="hero-num num">{st.due}</div>
            <div className="hero-side">
              <div className="s1">个生词 · 约 {st.minutes} 分钟</div>
              <div className="s2">单词 {st.dueWords} · 词块 {st.dueChunks}</div>
            </div>
          </div>
          <button className="btn" onClick={() => nav.push("review")}>
            开始复习
          </button>
          <button
            className="btn-ghost tlink"
            style={{ height: 40, fontSize: 14, fontWeight: 500, marginTop: 2 }}
            onClick={() => nav.push("quick")}
          >
            先清一张 · 约 2 分钟
          </button>
        </div>
      ) : (
        <div className="hero">
          <div className="overline">生词到期</div>
          <div className="hero-done">
            <Icon name="check" size={20} />
            今天的复习清完了
          </div>
          <div className="meta" style={{ marginTop: 4 }}>
            {dueTomorrow > 0
              ? `明天将到期 ${dueTomorrow} 个 · 睡前再过一遍更牢固`
              : "明天暂无到期 · 读到好词随手收进生词本"}
          </div>
          <button
            className="btn-ghost"
            style={{ border: "1px solid var(--hairline-strong)", marginTop: 12 }}
            onClick={() => actions.setTab("practice")}
          >
            去练一段
          </button>
        </div>
      )}

      {reading && (
        <>
          <hr className="hr" style={{ marginTop: 12 }} />
          <div
            className="sec press"
            onClick={() => nav.push("reader", { articleId: reading.a.id })}
          >
            <div className="sec-head">
              <span className="overline">继续阅读</span>
              <span className="pct num">
                {Math.round(((reading.sent + 1) / reading.a.sentences.length) * 100)}%
              </span>
            </div>
            <div className="art-title">{reading.a.title}</div>
            <div className="meta art-meta">
              读到第 {reading.sent + 1} 句 · 共 {reading.a.sentences.length} 句 · 还剩{" "}
              {Math.max(1, reading.a.sentences.length - reading.sent - 1)} 分钟
            </div>
            <div className="meter">
              <i style={{ width: `${((reading.sent + 1) / reading.a.sentences.length) * 100}%` }} />
            </div>
          </div>
        </>
      )}

      {clip && (
        <>
          <hr className="hr" style={{ marginTop: 12 }} />
          <div className="sec">
            <div className="sec-head">
              <span className="overline">剪贴板</span>
              <span className="when">{clipWhen(clip.ts)}</span>
            </div>
            <div className="quote" onClick={() => nav.push("translate", { src: "剪贴板", srcText: clip.en })}>
              “{clip.en}”
            </div>
            <div className="quote-actions">
              <span
                className="a"
                onClick={(e) => {
                  e.stopPropagation();
                  nav.push("translate", { src: "剪贴板", srcText: clip.en });
                }}
              >
                翻译
              </span>
              <span className="dot">·</span>
              <span
                className="b"
                onClick={(e) => {
                  e.stopPropagation();
                  /* 标题取剪贴板首句前 42 字（不再硬编码）；存前按标题+来源查重（修 P-02） */
                  const firstSent = (clip.en.match(/[^.!?]+[.!?]+\s*/g) || [clip.en])[0].trim();
                  const title = firstSent.slice(0, 42).trim();
                  if (articles.some((a) => a.title === title && a.titleCn === "来自剪贴板")) {
                    toast("已在书架");
                    return;
                  }
                  /* 切句兜底（治 home-1）：无 .!? 标点时 match 为 null，此前会建出 0 句文章
                     ——阅读页全白、播放越界。改为按换行切，仍无则整段作单句。 */
                  const clipParts = (clip.en.match(/[^.!?]+[.!?]+\s*/g) || clip.en.split(/\n+/))
                    .map((s) => s.trim())
                    .filter(Boolean);
                  const sentences = (clipParts.length ? clipParts : [clip.en.trim()])
                    .filter(Boolean)
                    .map((s, i) => ({ idx: i, paragraphIdx: 0, en: s, zh: null, chunks: [] }));
                  if (sentences.length === 0) {
                    toast("剪贴板内容为空，未能存入书架");
                    return;
                  }
                  actions.addArticle({
                    id: "clip-" + Date.now(),
                    title,
                    titleCn: "来自剪贴板",
                    sentences,
                    paragraphStarts: [0],
                  });
                  /* 不再点击即强切书架；想过去从 toast 的「去看看」自己跳 */
                  toast("已存入书架精读", { action: "去看看", onAction: () => actions.setTab("shelf") });
                }}
              >
                存入书架精读
              </span>
            </div>
            <hr className="hr" style={{ marginTop: 12 }} />
            <div className="cliptwo" onClick={() => nav.push("camera")}>
              <Icon name="cam" size={20} />
              <span className="t">拍译</span>
              <span className="s">拍照识别文字，立即翻译</span>
            </div>
          </div>
        </>
      )}

      <hr className="hr" style={{ marginTop: 12 }} />
      <div className="sec">
        <div className="overline">练一练</div>
        <div className="practice">
          <div className="p-item" onClick={() => nav.push("shadow")}>
            <Icon name="wave" size={20} />
            <div>
              <div className="t">跟读</div>
              {/* 跟读句源已改为文章驱动（B 批次），不再显示写死的「4 句待练」 */}
              <div className="s">跟原文练发音</div>
            </div>
          </div>
          <div className="p-item" onClick={() => nav.push("scenes")}>
            <Icon name="chat" size={20} />
            <div>
              <div className="t">陪练</div>
              <div className="s">4 个场景</div>
            </div>
          </div>
          <div className="p-item" onClick={() => nav.push("caption")}>
            <Icon name="clip" size={20} />
            <div>
              <div className="t">直译</div>
              <div className="s">双语字幕</div>
            </div>
          </div>
        </div>
      </div>

      <hr className="hr" style={{ marginTop: 12 }} />
      <div className="sec" style={{ paddingBottom: 6 }}>
        <div className="overline">本周</div>
        <div className="week">
          <div>
            <div className="w-num num">{st.week.review}</div>
            <div className="w-label">复习</div>
          </div>
          <div>
            <div className="w-num num">{st.week.add}</div>
            <div className="w-label">新词</div>
          </div>
          <div>
            <div className="w-num num">{st.week.trap}</div>
            <div className="w-label">直译陷阱</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 剪贴板相对时间（按 clip.ts，治 P-06：不再永远「刚刚复制」） */
function clipWhen(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "刚刚复制";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前复制`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前复制`;
  return "更早复制";
}
