/**
 * TTS 失败分类：把后端/云引擎抛出的错误串归因到 凭据 / 网络 / 系统 三类，
 * 给出用户能执行的建议文案，并标注是否值得引导去设置页。
 *
 * 覆盖的错误源：
 * - tts.rs（Windows SAPI）：「TTS COM 初始化失败」「创建 SpVoice 失败」「TTS 线程…」
 * - xfyunTts.ts（讯飞在线合成）：「未配置讯飞合成凭据」「语音合成超时」「鉴权…」
 * - edgeTts.ts（Edge 在线合成）：「语音合成超时（20s 无结果）」「签名计算失败」
 * - 浏览器 Audio.play() 被策略阻止的 NotAllowedError 等
 */

export interface TtsErrorInfo {
  kind: "credentials" | "network" | "system" | "unknown";
  /** 面向用户的一句话归因（不含原错误串细节）。 */
  message: string;
  /** 是否值得提供「打开设置」入口（缺凭据时 true）。 */
  allowSettings: boolean;
}

/** 归一化任意 throw 出来的东西为可分类文本。 */
function toText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Error) {
    // NotAllowedError / NotSupportedError 等 DOM 异常名本身就有分类价值
    return `${raw.name}: ${raw.message}`;
  }
  try {
    return String(raw);
  } catch {
    return "未知错误";
  }
}

export function classifyTtsError(raw: unknown): TtsErrorInfo {
  const text = toText(raw);
  const s = text.toLowerCase();

  // 1) 凭据/鉴权：讯飞三元组未配置、Key 无效、握手被拒
  if (
    /凭据|未配置|api[_ ]?key|app[_ ]?id|api[_ ]?secret|鉴权|授权|401|403|handshake|unauthorized|forbidden/.test(
      s,
    )
  ) {
    return {
      kind: "credentials",
      message: "缺少语音凭据：到 设置 → 语音 填一次即可（跟读/朗读/识别共用）",
      allowSettings: true,
    };
  }

  // 2) 网络：在线合成（Edge/讯飞）超时、断连、代理问题
  if (
    /网络|超时|timeout|timed out|connect|websocket|fetch|dns|econn|代理|proxy|offline|tls|ssl|断开|closed|interrupted/.test(
      s,
    )
  ) {
    return {
      kind: "network",
      message: "网络失败：检查网络或代理后重试（离线可换用系统朗读）",
      allowSettings: false,
    };
  }

  // 3) 系统：SAPI/COM 组件异常、无可用音色、播放被安全策略或浏览器策略阻止
  if (
    /com |com初始化|com 初始化|spvoice|sapi|线程|音色|播放|audio|play|阻止|blocked|notallowed|notsupported|系统|synt/.test(
      s,
    )
  ) {
    return {
      kind: "system",
      message: "系统朗读不可用：Windows 语音组件异常或播放被安全策略阻止",
      allowSettings: false,
    };
  }

  // 4) 兜底：保留原始信息前 80 字，方便报障定位
  return {
    kind: "unknown",
    message: `朗读失败：${text.slice(0, 80)}`,
    allowSettings: false,
  };
}
