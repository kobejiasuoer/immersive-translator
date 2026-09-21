/**
 * 讯飞语音评测（流式版 ISE）客户端 + 结果解析（跟读评测）。
 *
 * 协议要点（与 spike/ise_spike.mjs 实调验证一致）：
 * - wss://ise-api.xfyun.cn/v2/open-ise，HMAC-SHA256 签名鉴权（host/date/authorization）。
 * - 首帧 ssb：business.text = '\uFEFF[content]\n' + 评测文本（明文 UTF-8，非 base64）。
 * - 音频帧 1280B/帧（≈40ms），aue=raw；结束帧 aus=4/status=2。
 * - 结果 XML 为 base64 分片，data.status===2 时拼接解码。
 * - en_vip/read_sentence 分数为 5 分制；word 层有 total_score 与 dp_message
 *   （0 正常 / 16 漏读 / 32 增读 / 64 回读 / 128 替换）。
 *
 * 本模块纯浏览器环境可用（crypto.subtle + WebSocket），不依赖 Tauri。
 */

import { buildXfyunAuthUrl } from "./xfyunAuth";

export interface IseCredentials {
  appId: string;
  apiKey: string;
  apiSecret: string;
}

/** 音素级结果（gwpp 是 GOP 逐音素惩罚值，绝对值越大问题越大）。 */
export interface PhoneScore {
  content: string;
  dpMessage: number;
  gwpp: number;
}

/** 音节级结果。 */
export interface SyllScore {
  content: string;
  syllScore: number;
  serrMsg: number;
  phones: PhoneScore[];
}

/** 词级结果（content 是识别出的词，位置是音频帧，不是字符）。 */
export interface WordScore {
  content: string;
  totalScore: number;
  dpMessage: number;
  sylls: SyllScore[];
}

/** 一次跟读评测结果（分数均为 5 分制）。 */
export interface PronunciationResult {
  total: number;
  accuracy: number;
  fluency: number;
  standard: number;
  isRejected: boolean;
  /** 异常码字符串（"28673" 无语音/音量小、"28676" 乱说、"28680" 信噪比低…）；正常为 null。 */
  exceptInfo: string | null;
  words: WordScore[];
}

export type WordQuality = "good" | "ok" | "bad" | "missed";

/** 词在原文中的字符区间与着色档位（mapWordsToText 产出）。 */
export interface WordMark {
  start: number;
  end: number;
  quality: WordQuality;
  score: number;
}

const ISE_HOST = "ise-api.xfyun.cn";

/** 讯飞业务错误码 → 用户能看懂的话。 */
const ISE_CODE_MESSAGES: Record<number, string> = {
  10163: "评测参数错误",
  10160: "请求数据非法",
  10161: "音频 base64 解码失败",
  10313: "APPID 与 API Key 不匹配",
  11200: "讯飞语音评测服务未授权（控制台确认已开通）",
  11201: "评测调用次数超限",
  40007: "音频解码失败（采样率应为 16k/16bit/单声道）",
  48195: "评测文本格式错误",
  48205: "没有评测到音频",
  68675: "语音数据异常",
  68676: "读的内容和句子差太远（乱读）",
};

// ---------- 鉴权（与在线合成共用 xfyunAuth 的 HMAC 签名） ----------

export async function buildIseAuthUrl(creds: IseCredentials): Promise<string> {
  return buildXfyunAuthUrl(ISE_HOST, "/v2/open-ise", creds);
}

// ---------- PCM ----------

/** Float32 [-1,1] → Int16 PCM。 */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ---------- 结果 XML 解析 ----------

function attrMap(attrString: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of attrString.matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) map[m[1]] = m[2];
  return map;
}

function num(map: Record<string, string>, key: string): number {
  const v = Number(map[key]);
  return Number.isFinite(v) ? v : 0;
}

function parseSylls(inner: string): SyllScore[] {
  const out: SyllScore[] = [];
  for (const m of inner.matchAll(/<syll\b([^>]*)>([\s\S]*?)<\/syll>/g)) {
    const attrs = attrMap(m[1]);
    const phones: PhoneScore[] = [];
    for (const p of m[2].matchAll(/<phone\b([^>]*)>([\s\S]*?)<\/phone>/g)) {
      const pa = attrMap(p[1]);
      phones.push({ content: pa.content ?? "", dpMessage: Number(pa.dp_message ?? 0), gwpp: Number(pa.gwpp ?? 0) });
    }
    for (const p of m[2].matchAll(/<phone\b([^>]*?)\/>/g)) {
      const pa = attrMap(p[1]);
      phones.push({ content: pa.content ?? "", dpMessage: Number(pa.dp_message ?? 0), gwpp: Number(pa.gwpp ?? 0) });
    }
    out.push({ content: attrs.content ?? "", syllScore: Number(attrs.syll_score ?? 0), serrMsg: Number(attrs.serr_msg ?? 0), phones });
  }
  return out;
}

export function parseIseXml(xml: string): PronunciationResult {
  // 英文题型层级：read_chapter（篇章分）> sentence（句分）> word > syll > phone。
  // is_rejected / except_info 挂在篇章层，句层兜底。
  const sentenceAttrs = xml.match(/<sentence\b([^>]*)>/)
    ? attrMap(xml.match(/<sentence\b([^>]*)>/)![1])
    : {};
  const chapterAttrs = xml.match(/<read_chapter\b([^>]*)>/)
    ? attrMap(xml.match(/<read_chapter\b([^>]*)>/)![1])
    : sentenceAttrs;

  const words: WordScore[] = [];
  // 成对与自闭合两种 word 标签合并按文档序匹配（漏读词常是自闭合）。
  const wordRe = /<word\b([^>]*)>([\s\S]*?)<\/word>|<word\b([^>]*?)\/>/g;
  for (const m of xml.matchAll(wordRe)) {
    const attrs = attrMap(m[1] ?? m[3] ?? "");
    const inner = m[2] ?? "";
    words.push({
      content: attrs.content ?? "",
      totalScore: Number(attrs.total_score ?? 0),
      dpMessage: Number(attrs.dp_message ?? 0),
      sylls: parseSylls(inner),
    });
  }

  const exceptInfo = chapterAttrs.except_info && chapterAttrs.except_info !== "0" ? chapterAttrs.except_info : null;
  return {
    total: num(sentenceAttrs, "total_score"),
    accuracy: num(sentenceAttrs, "accuracy_score"),
    fluency: num(sentenceAttrs, "fluency_score"),
    standard: num(sentenceAttrs, "standard_score"),
    isRejected: chapterAttrs.is_rejected === "true",
    exceptInfo,
    words,
  };
}

// ---------- 识别词 → 原文词对齐（着色用） ----------

function normalizeWord(s: string): string {
  return s.toLowerCase().replace(/[’‘]/g, "'").replace(/'/g, "");
}

/**
 * 把评测返回的词序列映射到原文的字符区间。
 * ISE 的 word 只有音频帧位置，没有字符位置；read_sentence 的强制对齐保持词序。
 * 对齐用保序最大匹配（小规模 DP）：贪心向前扫在重复词（the/to/that）上会把
 * 后出现的识别词抢先配给前面的原文词，着色整体错位。
 * dp=32（增读）原文没有位置，不参与对齐。
 */
export function mapWordsToText(text: string, words: WordScore[]): WordMark[] {
  const tokens: { start: number; end: number; norm: string }[] = [];
  const re = /[A-Za-z0-9'‘’-]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ start: m.index, end: m.index + m[0].length, norm: normalizeWord(m[0]) });
  }
  const usable = words
    .filter((w) => w.dpMessage !== 32)
    .map((w) => ({ w, norm: normalizeWord(w.content) }))
    .filter((item) => item.norm !== "");

  // f(i, p) = 从第 i 个识别词、原文指针 p 开始能配出的最多对数；
  // take/match 记录该状态下第 i 个识别词是否被匹配、配到哪个原文下标。
  const n = usable.length;
  const t = tokens.length;
  const memo = new Map<number, { count: number; take: boolean; match: number }>();
  const best = (i: number, p: number): { count: number; take: boolean; match: number } => {
    if (i >= n || p >= t) return { count: 0, take: false, match: -1 };
    const key = i * (t + 1) + p;
    const hit = memo.get(key);
    if (hit) return hit;
    // 选项 A：这个词对不上（放弃着色）
    let count = best(i + 1, p).count;
    let take = false;
    let match = -1;
    // 选项 B：配到 p 之后第一处同名词（最早的匹配给后面留最大余地，
    // 且 DP 会同时探索放弃分支，整体仍是最大匹配）
    let k = p;
    while (k < t && tokens[k].norm !== usable[i].norm) k += 1;

    if (k < t) {
      const via = best(i + 1, k + 1).count + 1;
      if (via > count) {
        count = via;
        take = true;
        match = k;
      }
    }
    const result = { count, take, match };
    memo.set(key, result);
    return result;
  };

  const marks: WordMark[] = [];
  let p = 0;
  for (let i = 0; i < n; i += 1) {
    const choice = best(i, p);
    if (!choice.take) continue; // 对不上（识别歧义/数字读法），放弃这个词的着色
    const { w } = usable[i];
    const token = tokens[choice.match];
    // dp=16 漏读 → 底纹；dp=128（读成别的词）读是读了但读错 → 按分数着色
    const quality: WordQuality =
      w.dpMessage === 16
        ? "missed"
        : w.totalScore >= 4
          ? "good"
          : w.totalScore >= 3
            ? "ok"
            : "bad";
    marks.push({ start: token.start, end: token.end, quality, score: w.totalScore });
    p = choice.match + 1;
  }
  return marks;
}

/** 过关判定：未乱读且句分达到阈值。 */
export function isPass(result: PronunciationResult, passScore: number): boolean {
  return !result.isRejected && result.exceptInfo === null && result.total >= passScore;
}

// ---------- 评测主流程 ----------

function friendlyError(code: number, message: string): string {
  const known = ISE_CODE_MESSAGES[code];
  return known ? `${known}（${code}）` : `评测失败：${message || code}`;
}

/**
 * 评测一句跟读音频。
 * @param pcm16k 16k/16bit 单声道采样的 Float32 形式（[-1,1]）
 * @param text 评测参考文本（英文原句）
 */
export async function evaluateSentence(
  pcm16k: Float32Array,
  text: string,
  creds: IseCredentials,
  opts: { timeoutMs?: number } = {},
): Promise<PronunciationResult> {
  const url = await buildIseAuthUrl(creds);
  const pcm = floatToPcm16(pcm16k);
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);

  return new Promise<PronunciationResult>((resolve, reject) => {
    const ws = new WebSocket(url);
    const base64Chunks: string[] = [];
    let settled = false;
    let lastMessage = "";

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try {
        ws.close(1000, "");
      } catch {
        /* 已关闭 */
      }
      fn();
    };
    const timer = window.setTimeout(() => {
      finish(() => reject(new Error(`评测超时（${(opts.timeoutMs ?? 45000) / 1000}s 未返回，sid=${lastMessage || "-"}）`)));
    }, opts.timeoutMs ?? 45000);

    ws.onerror = () => {
      // HTTP 层错误（401/403）表现为立即 close，消息在 onclose 里补。
    };
    ws.onclose = (ev) => {
      if (!settled) {
        const hint =
          ev.code === 401
            ? "鉴权失败：检查 API Key/API Secret"
            : ev.code === 403
              ? "被拒：IP 白名单或系统时间偏差超 5 分钟"
              : `连接断开（${ev.code}${ev.reason ? " " + ev.reason : ""}）`;
        finish(() => reject(new Error(hint)));
      }
    };
    ws.onmessage = (ev) => {
      const payload = typeof ev.data === "string" ? ev.data : "";
      if (!payload) return;
      let msg: { code?: number; message?: string; sid?: string; data?: { status?: number; data?: string } };
      try {
        msg = JSON.parse(payload);
      } catch {
        return;
      }
      if (typeof msg.code !== "number" || msg.code !== 0) {
        const code = msg.code ?? -1;
        finish(() => reject(new Error(friendlyError(code, msg.message ?? ""))));
        return;
      }
      if (msg.sid) lastMessage = msg.sid;
      if (msg.data?.data) base64Chunks.push(msg.data.data);
      if (msg.data?.status === 2) {
        const xml = atob(base64Chunks.join(""));
        // atob 产出 latin1 字符串，XML 声明是 UTF-8，按字节还原再解码
        const bin = new Uint8Array(xml.length);
        for (let i = 0; i < xml.length; i += 1) bin[i] = xml.charCodeAt(i);
        const xmlText = new TextDecoder().decode(bin);
        finish(() => resolve(parseIseXml(xmlText)));
      }
    };
    ws.onopen = () => {
      const ssb = {
        common: { app_id: creds.appId },
        business: {
          sub: "ise",
          cmd: "ssb",
          ent: "en_vip",
          category: "read_sentence",
          tte: "utf-8",
          ttp_skip: true,
          auf: "audio/L16;rate=16000",
          aue: "raw",
          text: `\uFEFF[content]\n${text}`,
        },
        data: { status: 0, data: "" },
      };
      ws.send(JSON.stringify(ssb));
      // 音频帧：首帧 aus=1、其余 aus=2，最后补空结束帧 aus=4/status=2。
      const FRAME_BYTES = 1280;
      const frames: Uint8Array[] = [];
      for (let off = 0; off < bytes.length; off += FRAME_BYTES) {
        frames.push(bytes.subarray(off, Math.min(off + FRAME_BYTES, bytes.length)));
      }
      if (frames.length === 0) {
        finish(() => reject(new Error("录音数据为空")));
        return;
      }
      frames.forEach((piece, i) => {
        ws.send(
          JSON.stringify({
            business: { cmd: "auw", aus: i === 0 ? 1 : 2, aue: "raw" },
            data: { status: 1, data: bytesToBase64(piece), data_type: 1, encoding: "raw" },
          }),
        );
      });
      ws.send(
        JSON.stringify({
          business: { cmd: "auw", aus: 4, aue: "raw" },
          data: { status: 2, data: "", data_type: 1, encoding: "raw" },
        }),
      );
    };
  });
}
