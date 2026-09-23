/**
 * 朗读引擎抽象：usePlayback 及各处发音统一走 SpeechEngine，
 * 本地 SAPI（Rust tts.rs）与在线合成（讯飞 / Edge，前端 WS + <audio>）可切换。
 *
 * 语义对齐现有 SAPI 行为：
 * - speak 返回 gen（代数）；ended 事件（自然播完或被打断）带同一 gen，
 *   调用方用「最新 gen 匹配」丢弃过期事件。
 * - stopTrack 停指定音轨并触发 ended（播放引擎靠 epoch 守卫忽略）。
 * - 云引擎额外提供 prefetch：只合成进缓存不播放，用于预取下一句消除句间等待。
 *
 * 云引擎的语速/音色策略：
 * - 语速恒由 audio.playbackRate 变速承担——合成只有 1× 一份，
 *   切语速不重新合成、缓存跨语速命中（见 xfyunTts.ts / edgeTts.ts）。
 * - 音色按句子语言二选：中文句/英文句各配一个，与本地 SAPI 的中/外文启发式对齐。
 * - 讯飞与 Edge 共用 createCloudEngine 播放层（gen/打断/预取语义一致），差异只在合成函数。
 */

import {
  onTtsEnded,
  ttsSpeakAdvanced,
  ttsStopTrack,
  type ReaderSpeakOptions,
  type TtsTrack,
} from "../lib/tauriBridge";
import {
  DEFAULT_TTS_VCN,
  DEFAULT_TTS_VCN_EN,
  synthesizeXfyunTts,
  type XfyunTtsCredentials,
} from "../core/xfyunTts";
import {
  DEFAULT_EDGE_VOICE,
  DEFAULT_EDGE_VOICE_EN,
  synthesizeEdgeTts,
} from "../core/edgeTts";

export type EndedEvent = { gen: number; track: string };

export interface SpeechEngine {
  /** 启动成功返回代数；失败拒绝 Promise，不发送 ended。 */
  speak(text: string, chinese: boolean, opts: ReaderSpeakOptions): Promise<number>;
  stopTrack(track: TtsTrack): Promise<void>;
  /** 合成进缓存（云引擎能力；本地引擎无操作）。 */
  prefetch?(text: string, chinese: boolean, opts: ReaderSpeakOptions): void;
  onEnded(handler: (e: EndedEvent) => void): () => void;
}

/** 本地 SAPI 引擎：现行为的薄封装（Rust tts.rs，双音轨 + gen 代数）。 */
export function createSapiEngine(): SpeechEngine {
  const handlers: Array<(e: EndedEvent) => void> = [];
  let listening = false;
  function ensureListen() {
    if (listening) return;
    listening = true;
    void onTtsEnded((e) => {
      // Rust 事件 track 可选缺省（sentence 语义），这里归一成非空。
      handlers.forEach((fn) => fn({ gen: e.gen, track: e.track ?? "sentence" }));
    });
  }
  return {
    speak: (text, chinese, opts) => ttsSpeakAdvanced(text, chinese, opts),
    stopTrack: (track) => ttsStopTrack(track),
    onEnded(handler) {
      ensureListen();
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
  };
}

/** 云引擎读到的实时配置（ReaderApp 渲染期同步 ref）。 */
export interface XfyunEngineConfig {
  /** 中文句发音人；空串 = xiaoyan。 */
  vcnZh: string;
  /** 英文句发音人；空串回退 vcnZh（沿用用户旧选择），再回退 catherine。 */
  vcnEn: string;
  /** 兜底语速（speak opts 未带时用）。 */
  rate: number;
  creds: XfyunTtsCredentials | null;
}

/**
 * 按句子语言选 vcn：中文句不回退英文音色（英文音色读中文更怪），
 * 英文句回退中文音色以尊重「只填了一个云音色」的旧配置。
 */
function pickVcn(cfg: XfyunEngineConfig, chinese: boolean): string {
  if (chinese) return cfg.vcnZh || DEFAULT_TTS_VCN;
  return cfg.vcnEn || cfg.vcnZh || DEFAULT_TTS_VCN_EN;
}

/** 云引擎对合成器的最小依赖：按句子语言合成 mp3 Blob + 兜底语速。 */
export interface CloudEngineDeps {
  /** 合成失败拒绝 Promise（原始错误上抛），不发送 ended。 */
  synthesize: (text: string, chinese: boolean) => Promise<Blob>;
  /** speak opts 未带语速时的兜底。 */
  fallbackRate: () => number;
}

/**
 * 云合成引擎通用播放层：合成 1× mp3 → 复用的 <audio> 变速播放，gen 独立大偏移计数。
 * 讯飞（WS+签名）与 Edge（免费逆向接口）共用；差异只在上面的 synthesize。
 */
function createCloudEngine(deps: CloudEngineDeps): SpeechEngine {
  // 大偏移：与 SAPI 的 gen 计数空间隔离，防止切换引擎时旧 gen 意外匹配。
  let genCounter = 1_000_000;
  const handlers: Array<(e: EndedEvent) => void> = [];
  /** 每音轨当前在播的 <audio>（gen 匹配才有效）；teardown / 被顶替后置空。 */
  const players: Record<string, { el: HTMLAudioElement; gen: number; url: string } | null> = {
    sentence: null,
    word: null,
  };
  /**
   * 每音轨「当前生效的代数」：speak 同步登记、stopTrack 清空。合成是异步的，
   * 迟到的那份 blob 落地前必须核对它仍是最新代数——否则停止/切句后 1~3 秒
   * 出现幽灵播放，乱序完成时旧句还会顶掉正在播的新句。
   */
  const trackGen: Record<string, number | null> = { sentence: null, word: null };

  function fireEnded(e: EndedEvent) {
    handlers.forEach((fn) => fn(e));
  }

  /** 停掉音轨并释放元素，返回被停掉那代的 gen；空闲音轨返回 null。 */
  function teardownTrack(track: string): number | null {
    trackGen[track] = null;
    const cur = players[track];
    if (!cur) return null;
    const gen = cur.gen;
    cur.el.onended = null;
    cur.el.pause();
    cur.el.removeAttribute("src"); // 释放解码资源
    URL.revokeObjectURL(cur.url);
    players[track] = null;
    return gen;
  }

  async function speak(text: string, chinese: boolean, opts: ReaderSpeakOptions): Promise<number> {
    const track = opts.track ?? "sentence";
    const gen = ++genCounter;
    const rate = Math.min(4, Math.max(0.25, opts.rate ?? deps.fallbackRate() ?? 1));
    teardownTrack(track); // 新朗读打断旧朗读
    trackGen[track] = gen; // 同步登记：此后只有本代数能在这个音轨落地
    // 启动失败交给调用方 catch；此时调用方尚未登记 gen，不能用 ended 通知失败。
    const blob = await deps.synthesize(text, chinese);
    if (trackGen[track] !== gen) {
      // 合成期间被 stopTrack / 新的朗读顶替：静默丢弃（不播、不发 ended、不报错），
      // 仍 resolve gen——调用方靠自己的纪元/代数守卫消化过期结果。
      return gen;
    }
    const el = new Audio();
    const url = URL.createObjectURL(blob);
    players[track] = { el, gen, url };
    el.onended = () => {
      if (players[track]?.gen === gen) fireEnded({ gen, track });
    };
    el.preservesPitch = true; // 变速不变调
    el.playbackRate = rate;
    el.src = url;
    try {
      await el.play();
    } catch (err) {
      // 释放失败音频，但不能清理并发启动的新一代播放器。
      if (players[track]?.gen === gen) teardownTrack(track);
      throw err;
    }
    return gen;
  }

  return {
    speak,
    stopTrack: async (track) => {
      const gen = teardownTrack(track);
      if (gen !== null) fireEnded({ gen, track });
    },
    prefetch: (text, chinese) => {
      // 只合成 1× 进双层缓存；语速在播放时刻才决定，预取与任何语速共享。
      void deps.synthesize(text, chinese).catch(() => undefined);
    },
    onEnded(handler) {
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
  };
}

/** 讯飞在线合成引擎（凭据在 getCfg 里，缺失时 speak 拒绝）。 */
export function createXfyunEngine(getCfg: () => XfyunEngineConfig): SpeechEngine {
  return createCloudEngine({
    synthesize: (text, chinese) => {
      const cfg = getCfg();
      if (!cfg.creds) {
        throw new Error("未配置讯飞合成凭据，请在设置中检查语音配置");
      }
      return synthesizeXfyunTts(text, { vcn: pickVcn(cfg, chinese) }, cfg.creds);
    },
    fallbackRate: () => getCfg().rate,
  });
}

/** Edge 引擎读到的实时配置（ReaderApp 渲染期同步 ref）。 */
export interface EdgeEngineConfig {
  /** 中文句音色（ShortName）；空串 = zh-CN-XiaoxiaoNeural。 */
  voiceZh: string;
  /** 英文句音色；空串 = en-US-AvaNeural。 */
  voiceEn: string;
  /** 兜底语速（speak opts 未带时用）。 */
  rate: number;
}

/**
 * 按句子语言选 Edge 音色：与讯飞同语义——中文句不回退英文音色，
 * 英文句空配置回退中文音色再回退默认（英文音色读英文，缺省体验最优）。
 */
function pickEdgeVoice(cfg: EdgeEngineConfig, chinese: boolean): string {
  if (chinese) return cfg.voiceZh || DEFAULT_EDGE_VOICE;
  return cfg.voiceEn || cfg.voiceZh || DEFAULT_EDGE_VOICE_EN;
}

/** Edge 在线合成引擎：免费无凭据，开箱即用（服务可用性靠 SAPI 兜底）。 */
export function createEdgeEngine(getCfg: () => EdgeEngineConfig): SpeechEngine {
  return createCloudEngine({
    synthesize: (text, chinese) =>
      synthesizeEdgeTts(text, { voice: pickEdgeVoice(getCfg(), chinese) }),
    fallbackRate: () => getCfg().rate,
  });
}

/**
 * 引擎调度器：speak 路由到当前生效引擎（凭据缺失回落本地）；
 * stopTrack 停所有引擎的该音轨（切换引擎时旧音频不残留）；
 * ended 事件聚合转发。
 */
export function createSpeechDispatcher(getActive: () => SpeechEngine): SpeechEngine {
  const handlers: Array<(e: EndedEvent) => void> = [];
  const attached = new Set<SpeechEngine>();
  function attach(engine: SpeechEngine) {
    if (attached.has(engine)) return;
    attached.add(engine);
    void engine.onEnded((e) => {
      handlers.forEach((fn) => fn(e));
    });
  }
  return {
    speak: (text, chinese, opts) => {
      const engine = getActive();
      attach(engine);
      return engine.speak(text, chinese, opts);
    },
    stopTrack: async (track) => {
      attached.forEach((engine) => void engine.stopTrack(track));
    },
    prefetch: (text, chinese, opts) => {
      getActive().prefetch?.(text, chinese, opts);
    },
    onEnded(handler) {
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
  };
}
