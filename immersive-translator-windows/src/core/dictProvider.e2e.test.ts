import { describe, it, expect } from "vitest";
import { buildDictionaryPrompt } from "./promptBuilder";
import { parseDictResponse } from "./dictCard";

/**
 * 词典卡片 · 真实服务商链路验证（不启动 GUI）。
 *
 * 用与 Rust 端 build_body 相同的请求体发一次真实查词，
 * 走生产同款的 buildDictionaryPrompt + parseDictResponse，
 * 确认你的端点/模型能按契约返回可解析的卡片 JSON。
 *
 * 未设置环境变量时自动跳过，不影响 npm test：
 *   PowerShell:
 *     $env:IT_ENDPOINT="https://api.openai.com/v1/chat/completions"
 *     $env:IT_API_KEY="sk-..."
 *     $env:IT_MODEL="gpt-4o-mini"
 *     npm test -- dictProvider
 *   Git Bash:
 *     IT_ENDPOINT=... IT_API_KEY=... IT_MODEL=... npx vitest run dictProvider
 */
const rawEndpoint = process.env.IT_ENDPOINT?.trim() ?? "";
const apiKey = process.env.IT_API_KEY?.trim() ?? "";
const model = process.env.IT_MODEL?.trim() || "gpt-4o-mini";

/** 与 Rust 端 normalize_endpoint 一致的最小规范化。 */
function normalizeEndpoint(url: string): string {
  const t = url.replace(/\/+$/, "");
  if (t.endsWith("/chat/completions")) return t;
  if (t.endsWith("/v1")) return `${t}/chat/completions`;
  return `${t}/v1/chat/completions`;
}

/** 与 Rust 端 build_body / apply_thinking_mode_compat 保持一致（常见三家）。 */
function buildBody(systemPrompt: string, text: string) {
  const endpoint = normalizeEndpoint(rawEndpoint);
  const body: Record<string, unknown> = {
    model,
    stream: false,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `<text>${text}</text>` },
    ],
  };
  const ep = endpoint.toLowerCase();
  const m = model.toLowerCase();
  if (
    (ep.includes("bigmodel") || ep.includes("zhipu")) &&
    /glm-(4\.5|4\.6|z1|4-plus)/.test(m)
  ) {
    body.thinking = { type: "disabled" };
  } else if (ep.includes("deepseek") && m.includes("reasoner")) {
    body.enable_thinking = false;
  } else if (
    (ep.includes("dashscope") || ep.includes("tongyi") || ep.includes("qwen")) &&
    /qwen3|qwq/.test(m)
  ) {
    body.enable_thinking = false;
  }
  return { endpoint, body };
}

async function chat(text: string): Promise<string> {
  const { endpoint, body } = buildBody(
    buildDictionaryPrompt({ targetLanguage: "简体中文", customStyle: "", glossaryText: "" }),
    text,
  );
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return json.choices?.[0]?.message?.content ?? "";
}

describe.skipIf(!rawEndpoint || !apiKey)("词典卡片 · 真实服务商链路", () => {
  it("英文单词返回可解析卡片（resilient）", async () => {
    const raw = await chat("resilient");
    const result = parseDictResponse(raw, "resilient");
    if (result.kind !== "card") {
      throw new Error(`期望卡片，实际 ${result.kind}。原始响应：${raw.slice(0, 300)}`);
    }
    expect(result.card.word.toLowerCase()).toBe("resilient");
    expect(result.card.senses.length).toBeGreaterThan(0);
  }, 120_000);

  it("中文词返回可解析卡片（机器学习）", async () => {
    const raw = await chat("机器学习");
    const result = parseDictResponse(raw, "机器学习");
    if (result.kind !== "card") {
      throw new Error(`期望卡片，实际 ${result.kind}。原始响应：${raw.slice(0, 300)}`);
    }
    expect(result.card.translation !== "" || result.card.senses.length > 0).toBe(true);
  }, 120_000);

  it("整句触发 not_a_word 逃生通道（自动降级依赖它）", async () => {
    const sentence = "The economy proved remarkably resilient after the crisis.";
    const raw = await chat(sentence);
    const result = parseDictResponse(raw, sentence);
    if (result.kind !== "notAWord") {
      throw new Error(
        `期望 notAWord（整句自动降级依赖此响应），实际 ${result.kind}。` +
          `若你的模型坚持对句子出卡也无害（前端照常展示），只是不会自动降级。原始响应：${raw.slice(0, 300)}`,
      );
    }
  }, 120_000);
});
