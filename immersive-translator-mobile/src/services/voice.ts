/**
 * 语音服务（services/voice.ts）—— 讯飞三链路（IAT 听写 / ISE 评测 / TTS 合成）
 * 的前端封装，批次二各屏消费；命令契约见 A1（asr_start/asr_push/asr_finish/asr_abort/
 * xfyun_ise_assess/xfyun_tts_speak）。
 *
 * 铁律：先 await listen() 成功再触发对应 invoke（事件监听先于命令，防首包丢失）。
 * 凭据：VoiceCfg 从 getState().settings（voiceAppId/voiceApiKey/voiceApiSecret）组装。
 */

import { getState } from "../store";
import { invoke, invokeRaw, isTauri, reportDiag } from "./device";

/** 讯飞凭据（Rust 侧 serde camelCase 对齐：voice: VoiceCfg）。 */
export interface VoiceCfg {
  appId: string;
  apiKey: string;
  apiSecret: string;
}

function voiceCfg(): VoiceCfg {
  const s = getState().settings;
  return { appId: s.voiceAppId.trim(), apiKey: s.voiceApiKey.trim(), apiSecret: s.voiceApiSecret.trim() };
}

/** 讯飞凭据已配置（听写/评测/讯飞合成引擎的可用前提）。 */
export function voiceConfigured(): boolean {
  const c = voiceCfg();
  return isTauri() && !!c.appId && !!c.apiKey && !!c.apiSecret;
}

/** Edge 在线音色建议列表（空值 = 按文本语言自动：中文晓晓 / 英文 Ava）。
 *  对齐 mac EdgeTts.voiceSuggestions / Windows EDGE_TTS_VOICE_SUGGESTIONS。 */
export const EDGE_VOICE_SUGGESTIONS: [string, string][] = [
  ["", "自动 · 中文句晓晓 / 英文句 Ava（默认）"],
  ["en-US-AvaNeural", "Ava · 英语女声，自然"],
  ["en-US-AndrewNeural", "Andrew · 英语男声，自然"],
  ["en-US-EmmaNeural", "Emma · 英语女声，温和"],
  ["en-US-BrianNeural", "Brian · 英语男声，沉稳"],
  ["en-US-JennyNeural", "Jenny · 英语女声，亲切"],
  ["en-US-GuyNeural", "Guy · 英语男声，新闻"],
  ["en-US-AvaMultilingualNeural", "Ava · 多语种女声"],
  ["zh-CN-XiaoxiaoNeural", "晓晓 · 中文女声"],
  ["zh-CN-YunxiNeural", "云希 · 中文男声，阳光"],
  ["zh-CN-YunyangNeural", "云扬 · 中文男声，新闻"],
  ["zh-CN-XiaoyiNeural", "晓伊 · 中文女声，活泼"],
  ["zh-CN-YunjianNeural", "云健 · 中文男声，有力"],
];

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function newSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* 降级手拼 */
  }
  return "asr-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/* ---------- IAT 流式听写 ---------- */

export interface AsrSession {
  /** 推送 PCM16LE/16k/单声道分块（base64；任意长度，Rust 内部切 1280B 帧）。 */
  push: (pcmB64: string) => void;
  /** 结束收流：发 status=2 结束帧，返回最终文本；失败上抛中文错误串。 */
  finish: () => Promise<string>;
  /** 异常收尾：直接关 WS、静默清理（不等结果）。 */
  abort: () => void;
}

export interface AsrSessionHandlers {
  /** 每次识别增量（text=按 sn last-write-wins 合并后的累计文本）。 */
  onDelta: (text: string, final: boolean) => void;
}

/**
 * 建听写会话：先 listen('asr-delta') 成功再 invoke('asr_start')（事件监听铁律）。
 * 事件按 sessionId 过滤；asr_start/push/abort 失败转发诊断汇（不中断调用方 UI 流）。
 */
export function createAsrSession(language: "en_us" | "zh_cn", h: AsrSessionHandlers): AsrSession {
  const sessionId = newSessionId();
  let unlisten: (() => void) | null = null;
  let settled = false;
  /** asr_start 就绪前的推送排队（上限 ~2s，防句首丢失）。 */
  let ready = false;
  const pending: string[] = [];
  const MAX_PENDING = 16;

  const cleanup = () => {
    settled = true;
    ready = true; // 排队路径不再积压
    pending.length = 0;
    unlisten?.();
    unlisten = null;
  };

  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ sessionId: string; text: string; final: boolean }>("asr-delta", (e) => {
        if (settled || e.payload?.sessionId !== sessionId) return;
        h.onDelta(e.payload.text, e.payload.final);
      });
      await invokeRaw("asr_start", { language, sessionId, voice: voiceCfg() });
      ready = true;
      for (const b64 of pending.splice(0)) void invoke("asr_push", { sessionId, pcmB64: b64 });
    } catch (err) {
      reportDiag("asr", `听写会话建立失败：${errMsg(err)}`);
      cleanup();
    }
  })();

  return {
    push: (pcmB64: string) => {
      if (settled) return;
      if (!ready) {
        if (pending.length < MAX_PENDING) pending.push(pcmB64);
        return;
      }
      void invoke("asr_push", { sessionId, pcmB64 });
    },
    finish: async () => {
      /* 失败也要 cleanup（治 rust-tts-3）：此前 invokeRaw 抛错时 cleanup 被跳过——
         unlisten 永不移除、settled 恒 false，弱网下每次识别失败泄漏一个全局 asr-delta 监听器 */
      try {
        const text = await invokeRaw<string>("asr_finish", { sessionId });
        return text || "";
      } finally {
        cleanup();
      }
    },
    abort: () => {
      cleanup();
      void invoke("asr_abort", { sessionId });
    },
  };
}

/* ---------- ISE 跟读评测 ---------- */

export interface IsePhoneTS {
  content: string;
  dpMessage?: number | null;
  gwpp?: number | null;
}

export interface IseWordTS {
  content: string;
  totalScore?: number | null;
  /** 0 正常 / 16 漏读 / 32 增读 / 64 回读 / 128 替换。 */
  dpMessage: number;
  phones?: IsePhoneTS[] | null;
}

export interface IseResultTS {
  totalScore: number;
  accuracyScore: number;
  fluencyScore: number;
  standardScore: number;
  integrityScore: number;
  isRejected: boolean;
  exceptInfo?: string | null;
  /** 按文档序原样返回（着色在前端做）。 */
  words: IseWordTS[];
}

/** 句子发音评测；错误上抛 Rust 侧中文错误串（28673 未听到声音等已映射）。 */
export function assessSentence(text: string, pcmB64: string): Promise<IseResultTS> {
  return invokeRaw<IseResultTS>("xfyun_ise_assess", { text, pcmB64, voice: voiceCfg() });
}

/* ---------- 云 TTS（讯飞合成 → decodeAudioData 播放） ---------- */

export interface CloudSpeech {
  stop: () => void;
  done: Promise<void>;
}

/* ---------- 音频上下文（iOS 解锁语义） ----------
   播放：共享 AudioContext 单例；可能因在手势外创建而 suspended——audioCtx() 内
   尝试 resume，另挂一次性 pointerdown「解锁仪式」（手势外创建的 ctx WebKit 常拒绝
   后续 resume，需在手势内 start 一声静音强制激活音频管线）。
   解码：一律走 OfflineAudioContext——不依赖手势/运行态；suspended 的线上 ctx 在
   WebKit 上 decodeAudioData 会挂起不返回，预取路径会整个卡死。 */
let sharedCtx: AudioContext | null = null;
let decodeCtx: OfflineAudioContext | null = null;

function audioCtx(): AudioContext {
  if (!sharedCtx || sharedCtx.state === "closed") sharedCtx = new AudioContext();
  if (sharedCtx.state === "suspended") void sharedCtx.resume().catch(() => undefined);
  return sharedCtx;
}

/** 等共享 ctx 回 running（录音刚结束时 iOS 会把非录音 ctx 打成 interrupted，WebKit
 *  的自动恢复有竞态窗——此刻 start() 是静默排队、播放看门狗把 done「假落定」，表现为
 *  「合成成功、流程走完，但全程没声音」）。interrupted 只能等系统恢复；suspended 每轮
 *  经 audioCtx() 主动 resume；等待中解锁仪式可能重建 ctx——每轮重取当前实例。 */
async function awaitRunningCtx(maxMs: number): Promise<AudioContext> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const ctx = audioCtx();
    if (ctx.state === "running" || Date.now() >= deadline) return ctx;
    await new Promise<void>((resolve) => {
      let settled = false;
      const fin = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ctx.removeEventListener("statechange", fin);
        } catch {
          /* 旧 WebView 无监听 API：纯轮询 */
        }
        resolve();
      };
      const timer = setTimeout(fin, 120);
      try {
        ctx.addEventListener("statechange", fin);
      } catch {
        /* 同上 */
      }
    });
  }
}

/** 解码（offline ctx，可在任意时刻调用；带超时兜底防挂死）。 */
function decode(buf: ArrayBuffer): Promise<AudioBuffer> {
  if (!decodeCtx) {
    try {
      // 长度给 4096：部分 WebKit 版本对过短的 offline 构造有兼容问题
      decodeCtx = new OfflineAudioContext(1, 4096, 48000);
    } catch {
      decodeCtx = null; // 旧 WebView 无 offline：回落共享 ctx（手势内调用才可靠）
    }
  }
  const ctx: BaseAudioContext = decodeCtx ?? audioCtx();
  return new Promise<AudioBuffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("音频解码超时")), 8000);
    ctx.decodeAudioData(buf).then(
      (audio) => {
        clearTimeout(timer);
        resolve(audio);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error("音频解码失败"));
      },
    );
  });
}

/** iOS 解锁仪式（首次任意按下）：手势外创建的 AudioContext 在 iOS 上可能永远无法
   resume（v4 实测 resume 不生效仍挂起）——手势内**重建**新上下文替换之，
   并播一声静音激活管线。缓存的 AudioBuffer 与上下文无关，替换后照常可播。 */
function unlockAudioOnce(): void {
  try {
    if (!sharedCtx || sharedCtx.state === "suspended" || sharedCtx.state === "interrupted") {
      const fresh = new AudioContext();
      const dead = sharedCtx;
      sharedCtx = fresh;
      if (dead && dead.state !== "closed") void dead.close().catch(() => undefined);
      const src = fresh.createBufferSource();
      src.buffer = fresh.createBuffer(1, 1, fresh.sampleRate);
      src.connect(fresh.destination);
      src.start(0);
      if (fresh.state === "suspended") void fresh.resume().catch(() => undefined);
      return;
    }
  } catch {
    /* 仪式失败不影响后续播放路径（audioCtx() 还有 resume 兜底） */
  }
}
if (typeof window !== "undefined") {
  try {
    // 不用 once：来电/控制中心会把 ctx 打成 interrupted，任何一次点击都应能自愈重建
    window.addEventListener("pointerdown", unlockAudioOnce, true);
  } catch {
    /* 旧 WebView 无 addEventListener */
  }
}

/** 云朗读是否可达：真机 + （xfyun 引擎需三件套；edge 免凭据）。 */
export function cloudAvailable(): boolean {
  const s = getState().settings;
  return isTauri() && (s.ttsEngine === "xfyun" ? voiceConfigured() : true);
}

/* ---------- 云合成缓存（内存 LRU；键 = 引擎|音色|rate|文本） ----------
   领读/朗读的重复点播（再听一次、差词重练）直接命中已解码 AudioBuffer，秒出声；
   语速在键里——不同倍速各存一份。另设在途表（同键并发只发一次网络请求）：
   陪练边流边读时「预取」与「按序点播」会前后脚到，共享在途 promise 不重复合成。 */
const TTS_CACHE_MAX = 24;
const ttsCache = new Map<string, AudioBuffer>();
const ttsPending = new Set<string>();
const ttsInflight = new Map<string, Promise<AudioBuffer>>();

function cloudKey(text: string, voiceName: string | undefined, speed?: number, forceEngine?: "edge" | "xfyun"): string {
  const s = getState().settings;
  const useXfyun = forceEngine ? forceEngine === "xfyun" : s.ttsEngine === "xfyun" && voiceConfigured();
  const rate = typeof speed === "number" && Number.isFinite(speed) ? speed : 1;
  const voice = useXfyun ? voiceName ?? "auto" : (voiceName ?? s.edgeVoice).trim() || "auto";
  return `${useXfyun ? "xfyun" : "edge"}|${voice}|${rate.toFixed(2)}|${text}`;
}

/** 合成 + 解码（带缓存 + 在途共享）。失败 reject（调用方降级/兜底）。 */
async function synthAndDecode(
  text: string,
  voiceName: string | undefined,
  speed?: number,
  forceEngine?: "edge" | "xfyun",
): Promise<AudioBuffer> {
  const key = cloudKey(text, voiceName, speed, forceEngine);
  const hit = ttsCache.get(key);
  if (hit) {
    ttsCache.delete(key); // LRU touch
    ttsCache.set(key, hit);
    return hit;
  }
  const running = ttsInflight.get(key);
  if (running) return running;
  const s = getState().settings;
  const useXfyun = forceEngine ? forceEngine === "xfyun" : s.ttsEngine === "xfyun" && voiceConfigured();
  const rate = typeof speed === "number" && Number.isFinite(speed) ? speed : 1;
  const job = (async () => {
    const r = useXfyun
      ? await invokeRaw<{ audioB64: string; format: string }>("xfyun_tts_speak", {
          text,
          voiceName: voiceName ?? null,
          /* 直传倍率（1 = 常速）：0-100 档位换算在 Rust map_speed（×50 后 clamp）——
             此前端再预换算会被乘两次（1× → 50×50 → clamp 100 恒最快档），治 services-1 */
          speed: rate,
          voice: voiceCfg(),
        })
      : await invokeRaw<{ audioB64: string; format: string }>("edge_tts_speak", {
          text,
          voiceName: (voiceName ?? s.edgeVoice).trim() || null,
          speed: rate,
        });
    if (!r?.audioB64) throw new Error("云 TTS 未返回音频");
    const bin = atob(r.audioB64);
    const buf = new ArrayBuffer(bin.length);
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const audio = await decode(buf);
    ttsCache.set(key, audio);
    if (ttsCache.size > TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value as string);
    return audio;
  })();
  ttsInflight.set(key, job);
  try {
    return await job;
  } finally {
    ttsInflight.delete(key);
  }
}

/** 预取合成进缓存（不播放）：句子出现时后台拉音，用户点播时已命中、秒出声。
 *  失败写诊断（预取失败是「点播无声」的头号线索，不能静默）。 */
export function prefetchCloud(text: string, voiceName?: string, speed?: number): void {
  if (!cloudAvailable() || !text.trim()) return;
  const key = cloudKey(text, voiceName, speed);
  if (ttsCache.has(key) || ttsPending.has(key)) return;
  ttsPending.add(key);
  void synthAndDecode(text, voiceName, speed)
    .catch((e) =>
      reportDiag("tts", `预取失败（${typeof speed === "number" ? `${speed}× ` : ""}「${text.slice(0, 12)}…」）：${errMsg(e)}`),
    )
    .finally(() => ttsPending.delete(key));
}

/** 云 TTS 朗读；失败 done reject（调用方降级 speechSynthesis）。
 *  引擎路由（settings.ttsEngine）：edge（默认，免费无凭据）→ edge_tts_speak，
 *  speed 为语音倍率（1 = 常速）；xfyun（需三件套）→ xfyun_tts_speak，
 *  speed 直传倍率，0-100 档位换算（×50 后 clamp）在 Rust map_speed。
 *  播放用合成 await 之后重取的当前共享 ctx；onended + 估时兜底双保险。音色：edge 用 settings.edgeVoice（空 = 按语言自动）。 */
export function speakCloud(text: string, voiceName?: string, speed?: number): CloudSpeech {
  let stopped = false;
  let src: AudioBufferSourceNode | null = null;
  const done = (async () => {
    let audio: AudioBuffer;
    try {
      audio = await synthAndDecode(text, voiceName, speed);
    } catch (err) {
      /* Edge 失败且讯飞三件套在 → 换引擎再试一次（国内网络 Edge 偶发不可达，别让朗读直接哑掉） */
      if (getState().settings.ttsEngine === "edge" && voiceConfigured()) {
        reportDiag("tts", `Edge 合成失败（${errMsg(err)}），换讯飞引擎重试`);
        audio = await synthAndDecode(text, voiceName, speed, "xfyun");
      } else {
        throw err;
      }
    }
    if (stopped) return;
    /* 合成是网络往返，期间共享 ctx 可能被解锁仪式重建/关闭：await 之后重取当前 ctx，
       别用合成前捕获的旧句柄——旧 ctx 挂起时 start() 静默排队、done 永不落定（治 rust-tts-2）。
       另：录音刚停就播（陪练句队）会撞上 WebKit 会话恢复竞态窗——等 ctx 回 running
       再 start，最多 3s（治「录完就播全无声」）；等待超 150ms 记诊断（头号判别信号）。 */
    const waitFrom = Date.now();
    const ctx = await awaitRunningCtx(3000);
    const waited = Date.now() - waitFrom;
    if (waited > 150) reportDiag("tts", `播放前等待音频上下文恢复 ${waited}ms（终态 ${ctx.state}）`);
    if (ctx.state !== "running") {
      reportDiag("tts", `播放时音频上下文 ${ctx.state}（应为 running）`);
      await ctx.resume().catch(() => undefined);
    }
    /* resume 是异步空窗：停止若落在这里，复查丢弃——被打断的旧朗读迟些照样出声会叠音（治 services-3） */
    if (stopped) return;
    await new Promise<void>((resolve) => {
      src = ctx.createBufferSource();
      src.buffer = audio;
      src.connect(ctx.destination);
      let settled = false;
      const fin = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      src.onended = fin;
      /* 云路径补兜底定时（本地路径早有）：上下文挂起时 onended 不触发、done 永挂，
         调用方 onend 不回。时长按音频实际时长（倍速已在合成侧生效）+ 2.5s 余量 */
      setTimeout(fin, audio.duration * 1000 + 2500);
      src.start();
    });
    reportDiag("tts", `播放完成 · ${audio.duration.toFixed(1)}s`);
  })();
  return {
    stop: () => {
      stopped = true;
      try {
        src?.stop();
      } catch {
        /* 未开始/已停 */
      }
    },
    done,
  };
}

/* ---------- 带降级的朗读（云优先 → speechSynthesis） ---------- */

/* 本地 speechSynthesis 兜底不回环 store.speak（store.speak 云分支已路由到本函数，
   回环会在「填了凭据但非真机」时无限递归）——此处本地实现同语义：
   onend + 估时兜底双保险（对齐 store.speak / spike S3a）。 */
let localVoiceEn: SpeechSynthesisVoice | null = null;
let localVoiceZh: SpeechSynthesisVoice | null = null;
function pickLocalVoice(): void {
  if (!("speechSynthesis" in window)) return;
  const vs = speechSynthesis.getVoices();
  const en = vs.filter((v) => /^en(-|_)/i.test(v.lang));
  localVoiceEn = en.find((v) => /Google US|Natural|Samantha|Zira/i.test(v.name)) || en[0] || null;
  const zh = vs.filter((v) => /^zh(-|_)/i.test(v.lang));
  localVoiceZh = zh[0] || null;
}
if (typeof window !== "undefined" && "speechSynthesis" in window) {
  pickLocalVoice();
  /* addEventListener 而非 onvoiceschanged 赋值：store.speak 已占用后者，避免互相覆盖（iOS 声音晚载） */
  try {
    speechSynthesis.addEventListener("voiceschanged", pickLocalVoice);
  } catch {
    /* 旧 WebView 无 addEventListener，忽略 */
  }
}

function speakLocal(text: string, rate: number, onend: (() => void) | undefined, lang: "en" | "zh"): void {
  if (!("speechSynthesis" in window)) {
    onend?.();
    return;
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === "zh" ? "zh-CN" : "en-US";
  u.rate = rate;
  const v = lang === "zh" ? localVoiceZh : localVoiceEn;
  if (v) u.voice = v;
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    onend?.();
  };
  u.onend = () => done();
  u.onerror = () => done();
  /* 估时兜底：onend 不触发时按字数估算（store.speak 同口径） */
  const perUnit = lang === "zh" ? 260 : 380;
  const estMs = (text.split(/\s+|(?=[\u4e00-\u9fff])/).length * perUnit) / Math.max(0.5, rate) + 1200;
  setTimeout(done, estMs);
  speechSynthesis.speak(u);
}

/** 当前在播的云句柄：新一次朗读顶掉上一次（store.speak「新 speak 顶旧」语义的云侧落点）。 */
let currentCloud: CloudSpeech | null = null;

/**
 * 朗读统一入口：
 *  · 云朗读可达（真机；默认 Edge 免凭据）→ 云 TTS 优先；失败降级 speechSynthesis
 *    并经诊断汇上报。
 *  · 浏览器 → 直接 speechSynthesis（onend + 估时兜底双保险）。
 */
export function speakWithFallback(text: string, rate = 1, onend?: () => void, lang: "en" | "zh" = "en"): void {
  currentCloud?.stop();
  currentCloud = null;
  if (cloudAvailable()) {
    const h = speakCloud(text, undefined, rate);
    currentCloud = h;
    h.done
      .then(() => {
        if (currentCloud === h) currentCloud = null;
        onend?.();
      })
      .catch((err) => {
        if (currentCloud === h) currentCloud = null;
        reportDiag("tts", `云 TTS 失败，已降级系统朗读：${errMsg(err)}`);
        speakLocal(text, rate, onend, lang);
      });
    return;
  }
  speakLocal(text, rate, onend, lang);
}
