/**
 * Provider 预设。对齐 Mac 版 Settings 内置的预设卡片。
 * 每个预设包含：显示名、endpoint、默认模型、是否需要 API Key（本地接口可留空）、
 * 模型说明、延迟排查提示。
 */

export interface ProviderPreset {
  id: string;
  displayName: string;
  endpoint: string;
  model: string;
  /** 模型说明，展示在预设卡片下方。 */
  modelNote?: string;
  /** 本地 localhost 接口允许留空 API Key。 */
  allowEmptyApiKey?: boolean;
  /** 厂商类型，用于思考模式兼容等特殊处理。 */
  vendor?: "openai" | "deepseek" | "zhipu" | "gemini" | "openrouter" | "siliconflow" | "dashscope" | "groq" | "xai" | "moonshot" | "ollama" | "lmstudio" | "vllm";
  /** 延迟排查 / 使用提示。 */
  hint?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    displayName: "OpenAI · GPT-4o Mini",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    vendor: "openai",
    hint: "官方接口，延迟取决于网络。国内直连可能不稳定，建议配置代理。",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek V3",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
    vendor: "deepseek",
    hint: "国产高性价比。如遇推理模型噪声，会自动关闭思考模式。",
  },
  {
    id: "zhipu",
    displayName: "智谱 · GLM-4 Flash",
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4-flash",
    vendor: "zhipu",
    hint: "免费额度充足，速度快。会自动关闭思考模式。",
  },
  {
    id: "gemini",
    displayName: "Google · Gemini Flash",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-2.0-flash",
    vendor: "gemini",
    hint: "使用 OpenAI 兼容路径。国内需代理。",
  },
  {
    id: "openrouter",
    displayName: "OpenRouter · Auto",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "openrouter/auto",
    vendor: "openrouter",
    hint: "聚合多家模型，自动路由。需 OpenRouter API Key。",
  },
  {
    id: "siliconflow",
    displayName: "SiliconFlow · GLM-4",
    endpoint: "https://api.siliconflow.cn/v1/chat/completions",
    model: "THUDM/glm-4-9b-chat",
    vendor: "siliconflow",
    hint: "硅基流动，国内加速。需 SiliconFlow API Key。",
  },
  {
    id: "dashscope",
    displayName: "阿里云百炼 · Qwen Plus",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen-plus",
    vendor: "dashscope",
    hint: "通义千问，使用兼容模式路径。",
  },
  {
    id: "groq",
    displayName: "Groq · Llama 3.3 70B",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    vendor: "groq",
    hint: "超低延迟推理。需 Groq API Key。",
  },
  {
    id: "xai",
    displayName: "xAI · Grok",
    endpoint: "https://api.x.ai/v1/chat/completions",
    model: "grok-2-latest",
    vendor: "xai",
    hint: "xAI Grok。需 xAI API Key。",
  },
  {
    id: "moonshot",
    displayName: "Moonshot · Kimi",
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    model: "moonshot-v1-8k",
    vendor: "moonshot",
    hint: "Kimi，长上下文。需 Moonshot API Key。",
  },
  {
    id: "ollama",
    displayName: "本地 · Ollama",
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "llama3.2",
    vendor: "ollama",
    allowEmptyApiKey: true,
    hint: "先在终端运行 `ollama serve` 并 `ollama pull llama3.2`。无需 API Key。",
  },
  {
    id: "lmstudio",
    displayName: "本地 · LM Studio",
    endpoint: "http://localhost:1234/v1/chat/completions",
    model: "model-identifier",
    vendor: "lmstudio",
    allowEmptyApiKey: true,
    hint: "在 LM Studio 里启动本地 Server，模型名替换为已加载模型的 identifier。",
  },
  {
    id: "vllm",
    displayName: "本地 · vLLM",
    endpoint: "http://localhost:8000/v1/chat/completions",
    model: "served-model-name",
    vendor: "vllm",
    allowEmptyApiKey: true,
    hint: "运行 `vllm serve <模型名>`，模型名替换为 /v1/models 返回的 ID。",
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
