/**
 * 语音 REST(契约 §一/§四):非流式转写 + 发音评测。
 * 隐私红线:录音不落盘缓存;上传失败不自动重试(与 TTS 的重试一次刻意不同)。
 * 错误按服务端信封 code 归一成 VoiceError,文案映射统一走 voiceErrorMessage。
 */

import type { PhoneScore, SyllScore, WordScore } from "../../core/pronunciation";
import type { VoiceAsrLang } from "./voiceAsr";
import { VoiceError } from "./voiceErrors";
import { errorFromHttpResponse, parseJsonBody, requireOkJson, voiceRequest } from "./voiceHttp";

export type VoiceIseLang = "en" | "zh";

export interface AsrBatchResult {
  text: string;
  durationMs: number | null;
}

/** 评测结果(服务端统一成客户端 PronunciationResult 形状;5 分制)。 */
export interface VoiceIseResult {
  total: number;
  accuracy: number;
  fluency: number;
  standard: number;
  /** 完整度(消费点按 PronunciationResult 消费;网关不下发,单句口径兜底 5,
   *  与 core/pronunciation 解析器的句级缺省一致)。 */
  integrity: number;
  isRejected: boolean;
  exceptInfo: string | null;
  words: WordScore[];
}

/** POST /v1/voice/asr {lang, audio(base64 PCM,≤50 秒)} → {text,durationMs}。 */
export async function transcribeBatch(
  lang: VoiceAsrLang,
  pcmBase64: string,
): Promise<AsrBatchResult> {
  const res = await voiceRequest("POST", "/v1/voice/asr", JSON.stringify({ lang, audio: pcmBase64 }));
  const body = requireOkJson(res);
  const text = typeof body["text"] === "string" ? (body["text"] as string) : "";
  const durationMs = typeof body["durationMs"] === "number" ? (body["durationMs"] as number) : null;
  return { text, durationMs };
}

function parseWord(raw: unknown): WordScore | null {
  if (typeof raw !== "object" || raw === null) return null;
  const w = raw as Record<string, unknown>;
  if (typeof w["content"] !== "string" || typeof w["totalScore"] !== "number") return null;
  const sylls = Array.isArray(w["sylls"]) ? (w["sylls"] as unknown[]) : [];
  return {
    content: w["content"],
    totalScore: w["totalScore"],
    dpMessage: typeof w["dpMessage"] === "number" ? (w["dpMessage"] as number) : 0,
    sylls: sylls.filter(
      (s): s is SyllScore =>
        typeof s === "object" && s !== null && typeof (s as SyllScore).content === "string",
    ) as SyllScore[],
  };
}

function parsePhones(raw: unknown): PhoneScore[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is PhoneScore =>
      typeof p === "object" && p !== null && typeof (p as PhoneScore).content === "string",
  ) as PhoneScore[];
}

function parseIseResult(body: Record<string, unknown>): VoiceIseResult {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const words = (Array.isArray(body["words"]) ? (body["words"] as unknown[]) : [])
    .map(parseWord)
    .filter((w): w is WordScore => w !== null);
  // 词内音节补 phones 归一(parseWord 只按形状粗筛,这里逐字段再校一遍)。
  for (const w of words) {
    for (const s of w.sylls) {
      s.phones = parsePhones(s.phones);
    }
  }
  return {
    total: num(body["total"]),
    accuracy: num(body["accuracy"]),
    fluency: num(body["fluency"]),
    standard: num(body["standard"]),
    integrity: num(body["integrity"]) || 5, // 网关不下发 integrity:句级兜底 5(同本地解析器)
    isRejected: body["isRejected"] === true,
    exceptInfo: typeof body["exceptInfo"] === "string" ? (body["exceptInfo"] as string) : null,
    words,
  };
}

/** POST /v1/voice/ise {refText(≤2000 字), lang:"en", audio} → 5 分制评分。 */
export async function evaluatePronunciation(
  refText: string,
  lang: VoiceIseLang,
  pcmBase64: string,
): Promise<VoiceIseResult> {
  const res = await voiceRequest(
    "POST",
    "/v1/voice/ise",
    JSON.stringify({ refText, lang, audio: pcmBase64 }),
  );
  if (res.status < 200 || res.status >= 300) {
    throw errorFromHttpResponse(res.status, res.body, res.retryAfterSeconds, res.headers);
  }
  const body = parseJsonBody(res.body);
  if (body === null) throw new VoiceError("unknown", { message: "评测响应不是 JSON" });
  return parseIseResult(body);
}
