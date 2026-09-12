/**
 * Provider 预设。只保留主流服务商（6 云端 + 1 本地），点击套用 endpoint + 默认模型。
 * 每个预设附带常用模型列表（models，设置页生成模型下拉建议，仍可自由输入）、
 * keyUrl（服务商控制台获取 Key 的直达页面）、mark（列表徽标字）。
 */

export interface ProviderPreset {
  id: string;
  displayName: string;
  endpoint: string;
  model: string;
  /** 列表徽标字；缺省取 displayName 首字符。 */
  mark?: string;
  /** 常用模型列表，设置页用于 datalist 建议。 */
  models?: string[];
  /** 服务商控制台里创建 API Key 的页面。 */
  keyUrl?: string;
  /** 本地 localhost 接口允许留空 API Key。 */
  allowEmptyApiKey?: boolean;
  /** 厂商类型，用于思考模式兼容等特殊处理。 */
  vendor?:
    | "openai"
    | "deepseek"
    | "zhipu"
    | "gemini"
    | "openrouter"
    | "siliconflow"
    | "dashscope"
    | "groq"
    | "xai"
    | "moonshot"
    | "ollama"
    | "lmstudio"
    | "vllm";
  /** 一句话说明，展示在选中服务商的下方。 */
  hint?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    displayName: "DeepSeek",
    mark: "D",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    keyUrl: "https://platform.deepseek.com/api_keys",
    vendor: "deepseek",
    hint: "国内直连，性价比高。如遇推理模型噪声，会自动关闭思考模式。",
  },
  {
    id: "zhipu",
    displayName: "智谱 GLM",
    mark: "智",
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4-flash",
    models: ["glm-4-flash", "glm-4-plus", "glm-4-air"],
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    vendor: "zhipu",
    hint: "GLM-4-Flash 免费，国内直连速度快。会自动关闭思考模式。",
  },
  {
    id: "dashscope",
    displayName: "通义千问",
    mark: "通",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen-plus",
    models: ["qwen-plus", "qwen-turbo", "qwen-max"],
    keyUrl: "https://bailian.console.aliyun.com/?apiKey=1#/api-key",
    vendor: "dashscope",
    hint: "阿里云百炼，使用兼容模式路径。",
  },
  {
    id: "moonshot",
    displayName: "Kimi",
    mark: "K",
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    model: "moonshot-v1-8k",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    vendor: "moonshot",
    hint: "月之暗面 Kimi，长上下文，适合长文翻译。",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    mark: "O",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
    keyUrl: "https://platform.openai.com/api-keys",
    vendor: "openai",
    hint: "官方接口，国内直连不稳定，建议配置代理。",
  },
  {
    id: "gemini",
    displayName: "Google Gemini",
    mark: "G",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"],
    keyUrl: "https://aistudio.google.com/app/apikey",
    vendor: "gemini",
    hint: "使用 OpenAI 兼容路径，国内需代理。",
  },
  {
    id: "ollama",
    displayName: "Ollama",
    mark: "Ol",
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "llama3.2",
    models: ["llama3.2", "qwen3:8b", "deepseek-r1:8b"],
    vendor: "ollama",
    allowEmptyApiKey: true,
    hint: "本机运行，数据不出机器。先 `ollama serve`，再 `ollama pull llama3.2`。",
  },
];

/** 判断 endpoint 是否指向本地地址（允许留空 API Key）。 */
export function isLocalhostEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

/** 规范化 endpoint；query 保留，fragment 丢弃，与 Rust 后端保持一致。 */
export function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    let path = url.pathname.replace(/\/+$/, "");
    const lowerPath = path.toLowerCase();
    if (lowerPath.endsWith("/chat/completions")) {
      // Already complete.
    } else if (lowerPath.endsWith("/v1") || lowerPath.endsWith("/api/paas/v4")) {
      path += "/chat/completions";
    } else {
      path += "/v1/chat/completions";
    }
    url.pathname = path;
    url.hash = "";
    return url.toString();
  } catch {
    const fallback = trimmed.replace(/\/+$/, "");
    if (fallback.toLowerCase().endsWith("/chat/completions")) return fallback;
    if (fallback.toLowerCase().endsWith("/v1")) return `${fallback}/chat/completions`;
    return `${fallback}/v1/chat/completions`;
  }
}

/** 查找与当前 endpoint 匹配的预设（用于高亮"当前选中"）。 */
export function findMatchingPreset(endpoint: string): ProviderPreset | undefined {
  const normalized = endpoint.trim().replace(/\/+$/, "").toLowerCase();
  if (normalized === "") return undefined;
  return PROVIDER_PRESETS.find(
    (p) => p.endpoint.replace(/\/+$/, "").toLowerCase() === normalized,
  );
}
