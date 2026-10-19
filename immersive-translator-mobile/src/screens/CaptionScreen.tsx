/**
 * 录音直译（push）—— 真实链路（B3）：startPcmCapture 采集 → LiveSegmenter 流式分句
 * （套A 经验值照 mac ReaderCore/LiveCaption.swift:72-184；12s maxMs 规避 IAT 60s 上限）
 * → 每句独立一次 IAT 会话（LiveCaptionController.swift:126 口径）流式上屏——
 * asr-delta 节奏即讯飞 sn 增量返回节奏，无 setInterval 打字机 → 收句 finish：
 * 空＝杂音句直接丢弃（:130-139）、失败＝落「（识别失败）」卡保留段位（:143-148）、
 * 非空＝落卡并句级 LLM 翻译回填（:153-176：失败标「（翻译失败）」保留原文）。
 * mono 时间戳 + EN + ZH 每句一卡；字幕段上限 200（mac displayLimit）；
 * 停止/返回 → flush 半句同样走 finish → 导出抽屉（治 P-34）。
 * 未配置讯飞 / getUserMedia 拒绝：不起任何演示流——空页引导「去设置」，
 * 点开始只 toast 如实相告（旧 CAPTION_SCRIPT 演示定时器已删净）。
 */
import { useEffect, useRef, useState } from "react";
import { actions, toast, useApp } from "../store";
import { Icon } from "../ui/icons";
import { PNav } from "../ui/kit";
import { useNav } from "../ui/nav";
import { startPcmCapture, type Capture } from "../services/audio";
import { createAsrSession, voiceConfigured, type AsrSession } from "../services/voice";
import { startTranslate } from "../services/translate";
import { LiveSegmenter } from "../core/vad";

interface CapCard {
  t: string;
  en: string;
  zh: string;
}

/** 字幕段上限（mac LiveCaptionController.displayLimit = 200，超出弃最旧）。 */
const MAX_CARDS = 200;

function mmss(x: number): string {
  const m = Math.floor(x / 60);
  const s = Math.floor(x % 60);
  return `${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}`;
}

/** base64 → Int16Array（onChunk 的 16k PCM16 块喂 LiveSegmenter 用）。 */
function b64ToI16(b64: string): Int16Array {
  const bin = atob(b64);
  const out = new Int16Array(bin.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
  }
  return out;
}

/** 平滑电平（RMS）→ 电平条亮灯数 0..5（静音熄灯、正常说话到顶）。 */
function levelToBars(level: number): number {
  return level <= 0.002 ? 0 : Math.min(5, 1 + Math.floor(level * 100));
}

export default function CaptionScreen() {
  const nav = useNav();
  /* settings.voice = 讯飞三件套齐全的派生标记（SetVoiceScreen updVoice 实时回写）；
     听写只在真机走 IAT——浏览器即使填了凭据也不是真链路（ShadowScreen 同口径） */
  const voice = useApp((s) => s.settings.voice);
  const asrReady = voice && voiceConfigured();
  const [rec, setRec] = useState(false);
  const [cards, setCards] = useState<CapCard[]>([]);
  const [partial, setPartial] = useState("");
  const [secs, setSecs] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [bars, setBars] = useState(0);
  const [micDenied, setMicDenied] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  /** 卡片真源：stop 后立即读快照开导出抽屉，不等 React 落屏，也不受在途翻译影响。 */
  const cardsRef = useRef<CapCard[]>([]);
  const captureRef = useRef<Capture | null>(null);
  const segmenterRef = useRef<LiveSegmenter | null>(null);
  /** 当前句的 IAT 会话（每句独立一次，收句即 finish 交回最终文本）。 */
  const sessionRef = useRef<AsrSession | null>(null);
  /** 仍有权写 partial 的会话：新句开启/收句清理后，旧会话迟到的 delta 不写屏。 */
  const deltaOwnerRef = useRef<AsrSession | null>(null);
  const levelRef = useRef(0);
  const recStartRef = useRef(0);
  /** 句起距录音开始的毫秒数（落卡时间戳，续录累计）。 */
  const sentStartMsRef = useRef(0);
  /** 轮次令牌：start 在途时 stop/卸载作废迟到回写（ShadowScreen epoch 口径）。 */
  const epochRef = useRef(0);
  const recOnRef = useRef(false);
  /** 停止挥手期丢弃迟到的音频块（capture.cancel 前已在途的消息）。 */
  const stoppingRef = useRef(false);
  const lastSecsRef = useRef(0);
  const lastBarsRef = useRef(0);
  const lastSpeakingRef = useRef(false);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [cards, partial]);

  /* 卸载：作废在途轮次、断采集、中止会话（无定时器可清——演示打字机已删净） */
  useEffect(
    () => () => {
      epochRef.current += 1;
      recOnRef.current = false;
      stoppingRef.current = true;
      captureRef.current?.cancel();
      captureRef.current = null;
      sessionRef.current?.abort();
      sessionRef.current = null;
      deltaOwnerRef.current = null;
      segmenterRef.current = null;
    },
    [],
  );

  /* ---------- 卡片（200 上限，弃最旧） ---------- */

  function appendCard(card: CapCard): void {
    cardsRef.current = [...cardsRef.current, card].slice(-MAX_CARDS);
    setCards(cardsRef.current);
  }

  function patchCard(card: CapCard, zh: string): void {
    if (!cardsRef.current.includes(card)) return; // 已被 200 上限弃掉
    cardsRef.current = cardsRef.current.map((c) => (c === card ? { ...c, zh } : c));
    setCards(cardsRef.current);
  }

  /* ---------- 收句收尾：finish → 落卡/丢弃 → 句级翻译 ---------- */

  /**
   * 收句收尾（LiveCaptionController.swift:126-150 口径）：finish 拿最终文本；
   * 空＝杂音句直接丢弃（不落卡不翻译，:130-139）；失败＝落「（识别失败）」卡
   * 保留段位（:143-148）；非空＝落卡并句级翻译（:153-176：译文回填，
   * 失败标「（翻译失败）」保留原文）。
   */
  async function finalizeSentence(session: AsrSession | null, startMs: number): Promise<void> {
    let text = "";
    let ok = false;
    if (session) {
      try {
        text = (await session.finish()).trim();
        ok = true;
      } catch {
        ok = false; // 中文错误串已由 voice.ts 转发诊断汇
      }
    }
    if (deltaOwnerRef.current === session) {
      deltaOwnerRef.current = null;
      setPartial("");
    }
    if (!ok) {
      appendCard({ t: mmss(startMs / 1000), en: "（识别失败）", zh: "" });
      return;
    }
    if (!text) return; // 杂音句：不落卡不翻译
    const card: CapCard = { t: mmss(startMs / 1000), en: text, zh: "…" };
    appendCard(card);
    /* 等句级翻译落卡再返回（上限 3s，治 speak-3）：stop() 拍导出快照前若不等，
       末句 zh 恒为「…」——ExportSheet 拿的是 cardsRef 当时的数组快照，之后回填进不去。 */
    await new Promise<void>((resolve) => {
      let settled = false;
      const fin = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      setTimeout(fin, 3000);
      startTranslate(text, {
        onDelta: () => undefined, // 句级整句回填，不逐词渲染译文
        onDone: (full) => {
          patchCard(card, full.trim() || "（翻译失败）");
          fin();
        },
        onFail: () => {
          patchCard(card, "（翻译失败）");
          fin();
        },
        onUnconfigured: () => {
          patchCard(card, "（未配置模型服务）");
          fin();
        },
      });
    });
  }

  /* ---------- 逐块：喂 VAD 分句 + 喂当前句 IAT 会话 ---------- */

  function handleChunk(pcmB64: string): void {
    const seg = segmenterRef.current;
    if (!seg || stoppingRef.current) return;
    const sentence = seg.push(b64ToI16(pcmB64), levelRef.current);
    if (seg.speaking && !lastSpeakingRef.current) {
      /* 新句起：记句起时间戳 + 开独立 IAT 会话（每句一次听写） */
      sentStartMsRef.current = Date.now() - recStartRef.current;
      sessionRef.current?.abort(); // 防御：上一会话未清（正常流程不会发生）
      const s = createAsrSession("en_us", {
        onDelta: (text, final) => {
          /* 真流式上屏：节奏即讯飞 sn 增量返回节奏（无 setInterval 打字机）；
             final=true → 清 partial，卡片由 finish 结果落地 */
          if (deltaOwnerRef.current !== s) return;
          setPartial(final ? "" : text);
        },
      });
      sessionRef.current = s;
      deltaOwnerRef.current = s;
      setPartial("");
    }
    /* 句内音频推给当前会话（asr_start 就绪前由 voice.ts 内部排队防句首丢失） */
    sessionRef.current?.push(pcmB64);
    if (sentence) {
      /* 收句：本块已入句缓冲（也已推会话），finish 收尾落卡/丢弃 */
      const s = sessionRef.current;
      const startMs = sentStartMsRef.current;
      sessionRef.current = null;
      void finalizeSentence(s, startMs);
    } else if (!seg.speaking && lastSpeakingRef.current) {
      /* 杂音句被分句器丢弃（<minMs 600）：会话一并丢弃，不落卡 */
      sessionRef.current?.abort();
      sessionRef.current = null;
      if (deltaOwnerRef.current) {
        deltaOwnerRef.current = null;
        setPartial("");
      }
    }
    if (seg.speaking !== lastSpeakingRef.current) {
      lastSpeakingRef.current = seg.speaking;
      setSpeaking(seg.speaking);
    }
    /* 秒表由音频块驱动（块 ≈128ms 一到；停止/返回时按收尾时刻取整） */
    const sec = Math.floor((Date.now() - recStartRef.current) / 1000);
    if (sec !== lastSecsRef.current) {
      lastSecsRef.current = sec;
      setSecs(sec);
    }
  }

  /* ---------- 起停 ---------- */

  async function start(): Promise<void> {
    if (recOnRef.current || stoppingRef.current) return; // 收尾窗口不重启：导出抽屉即将弹出（治 speak-8）
    if (!asrReady) {
      /* 未配置讯飞：不起任何演示流，如实相告（空页另有常驻「去设置」引导） */
      toast("讯飞听写未配置——在「我的 → 语音服务」填入凭据后，开口说字幕实时落", {
        action: "去设置",
        onAction: () => nav.push("setVoice"),
        duration: 4200,
      });
      return;
    }
    const token = epochRef.current;
    recOnRef.current = true;
    stoppingRef.current = false;
    setMicDenied(false);
    setPartial("");
    setSpeaking(false);
    lastSpeakingRef.current = false;
    setBars(0);
    lastBarsRef.current = 0;
    /* 秒表累计：续录从上次停止处接着计（旧版时钟语义） */
    recStartRef.current = Date.now() - lastSecsRef.current * 1000;
    segmenterRef.current = new LiveSegmenter();
    /* 乐观置位：UI 立即进录音态；拿不到麦在回调里复位（mac :81 口径） */
    setRec(true);
    const capture = await startPcmCapture({
      /* 真麦电平：驱动电平条（熄/亮灯数）并随块喂 VAD */
      onLevel: (level) => {
        levelRef.current = level;
        const lit = levelToBars(level);
        if (lit !== lastBarsRef.current) {
          lastBarsRef.current = lit;
          setBars(lit);
        }
      },
      onChunk: handleChunk,
    });
    if (token !== epochRef.current) {
      capture?.cancel(); // 等待授权期间已被停止/卸载
      return;
    }
    if (!capture) {
      /* getUserMedia 拒绝：保留提示、复位录音态，不起演示流 */
      recOnRef.current = false;
      setRec(false);
      segmenterRef.current = null;
      setMicDenied(true);
      return;
    }
    captureRef.current = capture;
  }

  async function stop(): Promise<void> {
    if (!recOnRef.current) return;
    recOnRef.current = false;
    epochRef.current += 1; // 作废在途 start
    stoppingRef.current = true; // 丢弃停止挥手期迟到的块；收尾窗口内也拦住 start() 重启（治 speak-8）
    setSpeaking(false);
    lastSpeakingRef.current = false;
    const cap = captureRef.current;
    captureRef.current = null;
    cap?.cancel();
    const seg = segmenterRef.current;
    segmenterRef.current = null;
    const secsFinal = Math.max(0, Math.round((Date.now() - recStartRef.current) / 1000));
    setSecs(secsFinal);
    lastSecsRef.current = secsFinal;
    /* 攒着的半句交出来（mac stopRecording :85-98）：finish → 落卡/丢弃 → 等末句翻译（≤3s） */
    const half = seg?.flush() ?? null;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (half && session) {
      await finalizeSentence(session, sentStartMsRef.current);
    } else if (session) {
      session.abort(); // 没在说却残留会话（杂音句已丢）：静默清理
    }
    stoppingRef.current = false;
    /* 收尾窗口保持录制态外观，结束后才复位 FAB——快照拍完与抽屉弹出同拍出现 */
    setRec(false);
    actions.setSheet({ kind: "export", cards: cardsRef.current, secs: secsFinal });
  }

  return (
    <>
      <PNav
        title="录音直译"
        /* 录制中返回 = 自动走「停止→导出抽屉」，保住已转写内容，不再静默丢弃（治 P-34） */
        onBack={() => {
          if (rec) void stop();
          else nav.pop();
        }}
        right={
          rec ? (
            <button className="tlink" style={{ fontSize: 15 }} onClick={() => void stop()}>
              停止
            </button>
          ) : undefined
        }
      />
      <div className="pbody" style={{ paddingTop: 0 }}>
        {cards.length === 0 && !rec ? (
          <div className="cap-empty">
            <div style={{ color: "var(--ink-4)", display: "flex", justifyContent: "center" }}>
              <Icon name="clip" size={40} />
            </div>
            {asrReady ? (
              <>
                <div className="t">开口说，字幕实时落</div>
                <div className="d">
                  逐句断行 · 每句一卡，中英对照
                  <br />
                  适合跟读会议、播客与网课
                </div>
              </>
            ) : (
              <>
                <div className="t">讯飞听写未配置</div>
                <div className="d">
                  配置后开口说，字幕实时落
                  <br />
                  逐句断行 · 每句一卡，中英对照
                </div>
                <button className="tlink" style={{ fontSize: 15, marginTop: 14 }} onClick={() => nav.push("setVoice")}>
                  去设置
                </button>
              </>
            )}
            {micDenied && (
              <div className="meta" style={{ marginTop: 10 }}>
                麦克风未授权 · 请在系统设置中开启后重试
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="cap-head">
              <span className="meta num">
                {rec ? "录制中 · " : "已存 "}
                {secs} 秒 · {cards.length} 句
              </span>
              {rec && (
                <span className="cap-levels">
                  {[0, 1, 2, 3, 4].map((k) => (
                    <i key={k} style={{ opacity: k < bars ? 1 : 0.15 }} />
                  ))}
                </span>
              )}
            </div>
            {!rec && micDenied && (
              <div className="meta" style={{ padding: "8px 0 0" }}>
                麦克风未授权 · 请在系统设置中开启后重试
              </div>
            )}
            <div className="cap-list" ref={listRef}>
              {cards.map((c, i) => (
                <div className="cap-card" key={i}>
                  <div className="cap-time">{c.t}</div>
                  <div className="cap-en">{c.en}</div>
                  <div className="cap-zh">{c.zh}</div>
                </div>
              ))}
              {rec && (
                <div className="cap-card">
                  {/* 「正在说」指示 = segmenter.speaking（VAD 判定，非 partial 有无） */}
                  <div className="cap-time">{speaking ? "正在说" : "聆听中"}</div>
                  <div className={speaking ? "cap-en typing-state" : "cap-en"}>
                    {partial}
                    {speaking && <span className="caret" style={{ height: 14 }} />}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {!rec && (
        <button
          className="cap-fab"
          aria-label={cards.length ? "继续录音" : "开始录音"}
          onClick={() => void start()}
        >
          <Icon name="mic" size={28} />
        </button>
      )}
    </>
  );
}
