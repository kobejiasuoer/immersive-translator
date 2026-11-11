/**
 * 句子解析抽屉（reading-parity · 原型 SHEETS.sentence，html:1805-1814）。
 * 点句打开；朗读保留在动作行（听原句 / 跟读这句 / 修改译文）；
 * 头部 eyebrow = accent 绿「第 N 句 · 书名」；译文按遮罩口径走「点开看译文」斜纹占位条；
 * 无译文句的机器翻译入口收进本抽屉（正文不再逐句插「翻译这句」链接）。
 * 三页签：句子解析（内容预置解析 doc.parse 优先直出，html:1810；其余句走真实 LLM 请求，
 * 失败/无数据降级为原句 + 引导，禁止静态假解析）、
 * 本句生词（本篇收藏 ∩ 原句命中，真实 vocab）、本篇词汇（本篇收藏全部）。
 */
import { useEffect, useRef, useState } from "react";
import { actions, activeRepository, effectiveSentenceZh, useApp, type DictEntry } from "../../store";
import { Icon } from "../../ui/icons";
import { norm } from "../../core/judge";
import type { Article, ArticleTerm, VocabWord } from "../../core/types";
import { ReadingDrawer, DrawerTabs } from "./Drawer";
import { parseSentence, type SentenceParse } from "./sentenceParse";
import { EnglishHelp } from "./EnglishHelp";
import { vocabMeaning } from "../../core/vocabMeaning";

type Tab = "parse" | "words" | "vocab";

export function SentenceSheet({
  open,
  onClose,
  article,
  sentIdx,
  mask,
  revealed,
  onReveal,
  onHear,
  onFollow,
  onEdit,
  onManualLookup,
  onTranslate,
  translating,
  translationError,
  translationDraft,
  translationUnconfigured,
}: {
  open: boolean;
  onClose: () => void;
  article: Article;
  sentIdx: number;
  mask: boolean;
  revealed: boolean;
  onReveal: () => void;
  onHear: () => void;
  onFollow: () => void;
  onEdit: () => void;
  onManualLookup: () => void;
  /** 无译文句的机器翻译入口（正文不再插逐句链接，入口收进点句抽屉）。 */
  onTranslate?: () => void;
  translating?: boolean;
  translationError?: string;
  translationDraft?: string;
  translationUnconfigured?: boolean;
}) {
  const [tab, setTab] = useState<Tab>("parse");
  const sentence = article.sentences[sentIdx];
  const zhOverride = useApp((s) => s.sentenceZh[article.id]);
  const zh = sentence ? effectiveSentenceZh(zhOverride, sentIdx, sentence.zh) : null;
  const vocab = useApp((s) => s.vocab);

  /* 听读和查词不触发收费解析；用户明确请求后才联网。成功结果随本地资料缓存。 */
  const [phase, setPhase] = useState<"idle" | "loading" | "done" | "fail">("idle");
  const [result, setResult] = useState<SentenceParse | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const cached = useApp(s => s.sentenceParseCache[article.id]?.[String(sentIdx)]);
  const contentParse = sentence?.parse ?? (cached?.en === sentence?.en ? cached?.result : null);

  useEffect(() => {
    generation.current++;
    requestController.current?.abort();
    requestController.current = null;
    setPhase("idle");
    setError("");
    setResult(null);
    return () => {
      generation.current++;
      requestController.current?.abort();
      requestController.current = null;
    };
    // 依赖取句子的英文原句（primitive）：文章对象因别句译文回填被替换时不重发解析请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, article.id, sentIdx, sentence?.en]);

  /* 重开/换句时页签回到解析 */
  useEffect(() => {
    if (open) setTab("parse");
  }, [open, sentIdx]);

  if (!sentence) return null;
  const lower = sentence.en.toLowerCase();
  const inSentence = (word: string) => !!norm(word) && new RegExp(`(?:^|[^a-z0-9])${norm(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`, "i").test(lower);
  const articleWords = vocab.filter((w) => w.sourceArticleId === article.id);
  /* 内容预置词条（原型 doc.terms）：本句命中的进「本句生词」，全部进「本篇词汇」并按
     收藏态展示 ✓/＋（原型 html:1809-1811，未收藏预置词为 + 号态）。 */
  const terms = article.termMeta || [];
  const termSaved = (w: string) => vocab.some((v) => norm(v.word) === norm(w));
  const sentenceTerms = terms.filter((t) => inSentence(t.w));
  const sentenceWords = vocab.filter((w) => w.sourceArticleId === article.id && inSentence(w.word) && !sentenceTerms.some(t => norm(t.w) === norm(w.word)));
  const vocabOnlyWords = articleWords.filter((w) => !terms.some((t) => norm(t.w) === norm(w.word)));

  function openWord(w: VocabWord) {
    const entry: DictEntry = {
      type: w.kind === "chunk" ? "chunk" : "word",
      word: w.word,
      chunkType: w.chunkType,
      phonetic: w.phonetic,
      senses: w.senses,
      sentence: sentence.en,
      articleId: article.id,
      sentIdx,
      saved: true,
    };
    actions.setSheet({ kind: "dict", entry });
  }

  /** 预置词条 → 词典卡（未收藏态：可收藏/练一句，词典卡 collect 走真实 saveWord）。 */
  function openTerm(t: ArticleTerm) {
    const entry: DictEntry = {
      type: "word",
      word: t.w,
      phonetic: t.ph,
      senses: [{ pos: t.pos, cn: t.cn }],
      sentence: sentence.en,
      articleId: article.id,
      sentIdx,
      saved: termSaved(t.w),
    };
    actions.setSheet({ kind: "dict", entry });
  }

  function request() {
    if (phase === "loading") return;
    const version = ++generation.current;
    const controller = new AbortController();
    requestController.current?.abort();
    requestController.current = controller;
    const repository = activeRepository();
    setPhase("loading");
    setError("");
    parseSentence(sentence.en, controller.signal)
      .then((parsed) => {
        if (version !== generation.current || controller.signal.aborted) return;
        setResult(parsed);
        setPhase("done");
        /* 登录可能认领访客文章，服务已校验账号；仅在同一原句仍存在时缓存。 */
        if (activeRepository() === repository || repository.identity === "guest") actions.cacheSentenceParse(article.id, sentIdx, sentence.en, parsed);
      })
      .catch((cause: unknown) => {
        if (version !== generation.current || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setPhase("fail");
      });
  }

  return (
    <ReadingDrawer open={open} onClose={onClose} label="阅读帮助">
      <div className="reader-sentence-help">
      <div className="reader-help-heading"><h2>理解这句</h2><small>第 {sentIdx + 1} 句</small></div>
      <p className="reader-help-sentence" lang="en">{sentence.en}</p>
      <EnglishHelp request={{ kind: "sentence", text: sentence.en, sentence: sentence.en, articleId: article.id }} />
      {zh && (mask && !revealed ? (
        <button className="reader-translation-toggle" onClick={onReveal}><Icon name="translate" size={16}/>查看中文意思</button>
      ) : (
        <div className="reader-help-translation"><p lang="zh">{zh}</p>{mask && <button className="reader-translation-toggle" onClick={onReveal}>收起中文意思</button>}</div>
      ))}
      {translating && <div className="reader-translation-status" role="status">正在翻译这句…{translationDraft && <p className="reader-translation-draft">{translationDraft}</p>}</div>}
      {translationError && <p className="reader-translation-error" role="alert">{translationError}</p>}
      {translationUnconfigured && <p className="reader-translation-status" role="status">尚未设置翻译服务，可在账号与设置中配置。</p>}
      {onTranslate && <button className="reader-translation-toggle" disabled={translating} onClick={onTranslate}>{translating ? "正在翻译…" : translationError || translationUnconfigured ? "重试翻译" : zh ? "重新翻译" : "翻译这句"}</button>}
      {zhOverride?.[String(sentIdx)] && <p className="sheet-note">你的修改优先显示；重新翻译会保留这份修改。</p>}
      <div className="reader-help-actions">
        <button onClick={onHear}><Icon name="speaker" size={15}/>听原句</button>
        <button onClick={onFollow}><Icon name="wave" size={15}/>跟读这句</button>
        <button onClick={onEdit}><Icon name="pen" size={15}/>修改译文</button>
      </div>

      <DrawerTabs
        className="sh-tabs"
        value={tab}
        items={[
          ["parse", "句子结构"],
          ["words", "本句生词"],
          ["vocab", "本篇词汇"],
        ]}
        onChange={setTab}
        ariaLabel="句子工具"
      />

      {tab === "parse" && (
        <div aria-label="句子解析结果">
          {contentParse ? (
            /* 内容预置解析（原型 doc.parse → .trunk + .parts，html:1810）：主干 accent-soft 卡 +
               成分列表（绿底白字标签，子成分按 level 缩进挂左线） */
            <div>
              <div className="v2-trunk">
                <small>句子主干</small>
                <div className="trunk-en serif">{contentParse.trunk}</div>
              </div>
              <div className="v2-parts">
                {contentParse.parts.map((p, i) => (
                  <div key={i} className={`v2-part${p.level ? " sub" : ""}`}>
                    <span className="k">{p.label}</span>
                    <div className="v">{p.text}</div>
                    {p.note && <div className="d">{p.note}</div>}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <>
              {phase === "idle" && <div>
                <p className="sheet-note">需要理解句子结构时，再请求解析。听原句和跟读可以直接使用。</p>
                <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)", marginTop: 8 }} onClick={request}>解析这句</button>
              </div>}
              {phase === "loading" && (
                <div role="status">
                  <div className="skel" style={{ marginTop: 12 }} />
                  <div className="skel" style={{ width: "72%" }} />
                  <div className="skel" style={{ width: "58%" }} />
                  <p className="meta">正在解析这一句…</p>
                </div>
              )}
              {phase === "fail" && (
                <div>
                  {/* 原句已在抽屉头部展示（原型 fail 态不再重复「原句」卡），仅保留引导 + 重试 */}
                  <p className="sheet-note">
                    {(error || "解析暂不可用").replace(/。+$/, "")}。先按句意阅读；需要时可在正文中选中词组，再点「解释」，或补充自己的译文。
                  </p>
                  <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)", marginTop: 8 }} onClick={request}>
                    重试解析
                  </button>
                </div>
              )}
              {phase === "done" && result && (
                <div>
                  {result.zh && (
                    <div className="v2-trunk">
                      <small>整句翻译</small>
                      <p style={{ fontSize: 15, lineHeight: 1.8, margin: "2px 0 0" }}>{result.zh}</p>
                    </div>
                  )}
                  <div className="v2-trunk">
                    <small>句子主干</small>
                    <div className="trunk-en serif">{result.trunk}</div>
                  </div>
                  <div className="v2-parts">
                    {result.parts.map((p, i) => (
                      <div key={i} className="v2-part">
                        <span className="k">{p.label}</span>
                        <div className="v">{p.text}</div>
                        {p.note && <div className="d">{p.note}</div>}
                      </div>
                    ))}
                  </div>
                  <p className="meta" style={{ marginTop: 10 }}>
                    解析由 AI 生成，仅供参考。
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === "words" && (
        <div aria-label="本句生词">
          {/* 内容预置词条（原型 doc.terms 命中本句）+ 本句已收藏词，词性前缀随释义（原型 term.pos） */}
          {sentenceTerms.map((t) => (
            <button key={`term-${t.w}`} className="v2-sentence-word" onClick={() => openTerm(t)}>
              <b className="serif">{t.w}</b>
              <Icon name="chevr" size={15} />
              <span className="def">{`${t.pos} ${t.cn}`.trim()}</span>
            </button>
          ))}
          {sentenceWords.map((w) => (
            <button key={w.id} className="v2-sentence-word" onClick={() => openWord(w)}>
              <b className="serif">{w.word}</b>
              <Icon name="chevr" size={15} />
              <span className="def">
                {vocabMeaning(w)}
              </span>
            </button>
          ))}
          {!sentenceTerms.length && !sentenceWords.length && (
            <p className="sheet-note">这句没有已收藏的生词。在正文中选中词或词组，再点「解释」即可查看并收藏，也可用「查一个词或词块」手动查询。</p>
          )}
          <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)", width: "100%", marginTop: 10 }} onClick={onManualLookup}>
            查一个词或词块
          </button>
        </div>
      )}

      {tab === "vocab" && (
        <div aria-label="本篇词汇">
          <p className="sheet-note">取自这篇内容，可选择自己想积累的表达。</p>
          {/* 预置词条全列（未收藏 + / 已收藏 ✓，原型 html:1811 findWord 分支）+ 非预置的收藏词 */}
          {terms.map((t) => (
            <button key={`vocab-${t.w}`} className="v2-sentence-word" onClick={() => openTerm(t)}>
              <b className="serif">{t.w}</b>
              <Icon name={termSaved(t.w) ? "check" : "plus"} size={15} />
              <span className="def">{`${t.pos} ${t.cn}`.trim()}</span>
            </button>
          ))}
          {vocabOnlyWords.map((w) => (
            <button key={w.id} className="v2-sentence-word" onClick={() => openWord(w)}>
              <b className="serif">{w.word}</b>
              <Icon name="check" size={15} />
              <span className="def">
                {vocabMeaning(w)}
              </span>
            </button>
          ))}
          {!terms.length && !vocabOnlyWords.length && (
            <p className="sheet-note" style={{ margin: 0 }}>
              这篇还没有收藏的表达。阅读时选中词或词组，再点「解释」查看并收藏，就能在这里复习。
            </p>
          )}
        </div>
      )}
      </div>
    </ReadingDrawer>
  );
}
