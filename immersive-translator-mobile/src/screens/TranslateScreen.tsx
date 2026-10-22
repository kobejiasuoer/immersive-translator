/**
 * 翻译结果页（push）—— §3.9：来源徽章；原文区（done 态点按编辑 #4，≥17px）；
 * 译文区衬线；状态机三阶段（连接中→等首字→输出中）+ 总耗时；
 * 停止保留已译/重试；动作 chips（#5）；底部常驻：收进生词本/存入书架/朗读。
 */
import { useEffect, useRef, useState } from "react";
import { actions, speak, stopSpeak, toast, useApp } from "../store";
import { Icon } from "../ui/icons";
import { PNav } from "../ui/kit";
import { useNav } from "../ui/nav";
import { startTranslate, type TranslateEngine } from "../services/translate";
import { writeClipboard } from "../services/device";

export interface TranslateProps {
  src?: string;
  srcText?: string;
}

type Phase = "idle" | "connecting" | "streaming" | "done" | "fail" | "unconfigured";

export default function TranslateScreen({ src = "剪贴板", srcText = "" }: TranslateProps) {
  const nav = useNav();
  /* 引擎名优先自定义模型（治 ux-cross-3）：此前只按 provider 查写死型号表，
     自定义模型时状态行永远展示错误型号、误导排查；与「我的」页 model 优先口径一致 */
  const engineName = useApp((s) => {
    if (!s.settings.apiKey.trim()) return "未配置模型";
    const model = s.settings.model.trim();
    return model || engineLabel(s.settings.provider);
  });

  const [text, setText] = useState(srcText);
  const [editing, setEditing] = useState(srcText === "");
  const [editVal, setEditVal] = useState(srcText);
  /* 手动进入（无原文）= 等待输入空态，不伪装「已完成」（治 P-37） */
  const [phase, setPhase] = useState<Phase>(srcText === "" ? "idle" : "connecting");
  const [out, setOut] = useState("");
  const [elapsed, setElapsed] = useState("0.0");
  const [failMsg, setFailMsg] = useState("");
  const engine = useRef<TranslateEngine | null>(null);
  const t0 = useRef(0);

  useEffect(() => {
    if (srcText !== "") run(srcText);
    return () => engine.current?.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function run(source: string) {
    /* 空串护栏：不发引擎、不写 history（治 P-36） */
    if (!source.trim()) return;
    engine.current?.stop();
    setPhase("connecting");
    setOut("");
    setFailMsg("");
    t0.current = performance.now();
    setElapsed("0.0");
    const tick = setInterval(() => {
      if (engine.current) setElapsed(((performance.now() - t0.current) / 1000).toFixed(1));
    }, 100);
    const stopTick = () => clearInterval(tick);
    engine.current = startTranslate(source, {
      onFirst: () => setPhase("streaming"),
      onDelta: (chunk) => setOut(chunk),
      onDone: (full, ms) => {
        stopTick();
        setOut(full);
        setElapsed((ms / 1000).toFixed(1));
        setPhase("done");
        actions.addHistory({ src, en: source, zh: full });
      },
      onFail: (msg) => {
        stopTick();
        setFailMsg(msg);
        setPhase("fail");
      },
      /* 未配置模型：不再产出伪译文，切引导空态（治「演示引擎假装在工作」） */
      onUnconfigured: () => {
        stopTick();
        setOut("");
        setPhase("unconfigured");
      },
    });
  }

  function retranslate() {
    if (!editVal.trim()) {
      toast("先输入要翻译的原文");
      return;
    }
    setText(editVal);
    setEditing(false);
    run(editVal);
  }

  /* 收进生词本（治 P-35）：空文本禁用；≤3 词收藏整段；长文引导进阅读点词收词，杜绝首词垃圾卡 */
  function saveVocab() {
    const t = text.trim();
    if (!t) return;
    if (t.split(/\s+/).filter(Boolean).length > 3) {
      toast("整段太长 · 进入阅读后点词可收单个词");
      return;
    }
    actions.saveWord(
      { word: t, kind: "word", senses: [{ pos: "", cn: "（整段收藏 · 进入阅读后点词可收单个词）" }] },
      "word",
    );
  }

  /* 分句：句末标点优先，尾部无标点兜底；无标点长文按长度切句（治 P-38） */
  function splitSentences(t: string): string[] {
    const parts = (t.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? []).map((s) => s.trim()).filter(Boolean);
    const out: string[] = [];
    for (const p of parts) {
      if (/[.!?]$/.test(p) || p.length <= 80) {
        out.push(p);
        continue;
      }
      let cur = "";
      for (const w of p.split(/\s+/)) {
        if (cur && cur.length + 1 + w.length > 80) {
          out.push(cur);
          cur = w;
        } else {
          cur = cur ? `${cur} ${w}` : w;
        }
      }
      if (cur) out.push(cur);
    }
    return out;
  }

  function toShelf() {
    const t = text.trim();
    const sents = splitSentences(t);
    if (!sents.length) {
      toast("还没有可存入的句子 · 先输入或翻译原文");
      return;
    }
    const id = "tr-" + Date.now();
    actions.addArticle({
      id,
      title: t.split(/[.!?]/)[0]?.trim().slice(0, 42) || "未命名文章",
      titleCn: `来自${src}`,
      sentences: sents.map((s, i) => ({ idx: i, paragraphIdx: 0, en: s, zh: null, chunks: [] })),
      paragraphStarts: [0],
    });
    actions.setTab("shelf");
    nav.popAll();
  }

  /* 复制按结果反馈（治 P-45） */
  async function copyOut() {
    const ok = await writeClipboard(out);
    toast(ok ? "译文已复制" : "复制失败 · 可长按译文手动选择复制");
  }

  return (
    <>
      <PNav title="翻译" onBack={() => { engine.current?.stop(); stopSpeak(); nav.pop(); }} />
      <div className="pbody" style={{ paddingBottom: 120 }}>
        <span className="src-badge">
          <Icon name={src === "拍译" ? "cam" : "clip"} size={12} />
          {src}
        </span>
        {editing ? (
          <>
            <textarea
              className="input"
              rows={3}
              style={{ marginTop: 12 }}
              value={editVal}
              onChange={(e) => setEditVal(e.target.value)}
              placeholder="输入要翻译的原文"
              aria-label="要翻译的原文"
            />
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button className="btn" style={{ flex: 1 }} disabled={!editVal.trim()} onClick={retranslate}>
                重新翻译
              </button>
            </div>
          </>
        ) : (
          <div className="tr-src" onClick={() => { setEditVal(text); setEditing(true); }}>
            {text}
            <span className="meta" style={{ display: "block", marginTop: 4 }}>
              点按原文可修改后重译
            </span>
          </div>
        )}
        <hr className="hr" style={{ margin: "16px 0 0" }} />
        <div className="overline" style={{ marginTop: 14 }}>译文</div>
        {phase === "connecting" && (
          <>
            <div style={{ marginTop: 12 }}>
              <div className="skel" />
              <div className="skel" style={{ width: "82%" }} />
            </div>
            <div className="tr-status">
              <span className="st on">连接模型</span>
              <span className="st-line" />
              <span className="st">等待首字</span>
              <span className="st-line" />
              <span className="st">输出中</span>
            </div>
          </>
        )}
        {phase === "streaming" && (
          <>
            <div className="tr-zh">
              {out}
              <span className="caret" />
            </div>
            <div className="tr-status">
              <span className="st">连接模型</span>
              <span className="st-line" />
              <span className="st">等待首字</span>
              <span className="st-line" />
              <span className="st on">输出中 · {engineName}</span>
              <span className="num">{elapsed}s</span>
            </div>
            <button
              className="btn-ghost"
              style={{ border: "1px solid var(--hairline-strong)", marginTop: 16 }}
              onClick={() => {
                engine.current?.stop();
                setPhase("done");
              }}
            >
              <Icon name="stop" size={14} />
              停止并保留已译
            </button>
          </>
        )}
        {phase === "fail" && (
          <>
            {/* U-13：失败信号由 --err 状态行承担，译文不再缩字号（19px 与 done/streaming 一致） */}
            <div className="tr-zh">{out || "这次没连上模型服务。"}</div>
            <div className="tr-status">
              <span className="st on" style={{ color: "var(--err)" }}>失败 · {failMsg || "网络异常"}</span>
            </div>
            <div className="chips">
              <button className="chip" onClick={() => run(text)}>
                <Icon name="undo" size={13} />
                重试
              </button>
              <button className="chip" onClick={() => nav.push("setModel")}>
                去检查模型服务
              </button>
            </div>
          </>
        )}
        {phase === "unconfigured" && (
          <>
            {/* U-13＋U-09：引导句走正文字号 + ink-3（ink-4 仅 2.1:1，此处是唯一说明文字） */}
            <div className="tr-zh" style={{ color: "var(--ink-3)" }}>
              连接模型服务后开始翻译
            </div>
            <div className="meta" style={{ marginTop: 8 }}>
              填入你自己的 API Key（BYOK）——译文只在本机与模型服务间直连，不经过任何中转。
            </div>
            <div className="chips" style={{ marginTop: 14 }}>
              <button className="chip" onClick={() => nav.push("setModel")}>
                <Icon name="gear" size={13} />
                去配置
              </button>
            </div>
            <div className="tr-status">
              <span className="st on" style={{ color: "var(--ink-3)" }}>未配置模型 · 无译文产出</span>
            </div>
          </>
        )}
        {(phase === "idle" || phase === "done") && (
          <>
            {phase === "done" ? (
              <>
                <div className="tr-zh">{out}</div>
                <div className="tr-status">
                  <span className="st on">
                    已完成 · {engineName} · 用时 {elapsed} 秒
                  </span>
                </div>
              </>
            ) : (
              /* 等待输入空态：不伪装「已完成 · 0.0 秒」（治 P-37） */
              <>
                <div className="tr-zh" style={{ color: "var(--ink-4)" }}>
                  等待输入
                </div>
                <div className="meta" style={{ marginTop: 8 }}>
                  在上方输入原文后点「重新翻译」，译文会显示在这里
                </div>
              </>
            )}
            <div className="chips">
              <button className="chip" disabled={phase !== "done" || !out} onClick={copyOut}>
                <Icon name="copy" size={13} />
                复制译文
              </button>
              <button className="chip" disabled={phase !== "done" || !text.trim()} onClick={() => speak(text, 1)}>
                <Icon name="speaker" size={13} />
                朗读原文
              </button>
              <button className="chip" disabled={phase !== "done" || !text.trim()} onClick={() => run(text)}>
                <Icon name="undo" size={13} />
                重新翻译
              </button>
            </div>
          </>
        )}
      </div>
      <div className="tr-bottom">
        <button className="tb" disabled={!text.trim()} onClick={saveVocab}>
          <Icon name="plus" size={15} />
          收进生词本
        </button>
        <button className="tb" disabled={!text.trim()} onClick={toShelf}>
          <Icon name="shelf" size={15} />
          存入书架
        </button>
        <button
          className="tb pri"
          disabled={!text.trim()}
          onClick={() => {
            speak(text, 1);
          }}
        >
          <Icon name="speaker" size={15} />
          朗读
        </button>
      </div>
    </>
  );
}

function engineLabel(provider: string): string {
  return { openai: "GPT-4o mini", deepseek: "deepseek-chat", zhipu: "glm-4-flash", moonshot: "kimi", silicon: "Qwen2.5-7B", ollama: "llama3.1", custom: "自定义模型" }[provider] || provider;
}
