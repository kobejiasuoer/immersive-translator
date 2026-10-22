import { describe, it, expect } from "vitest";
import {
  PROVIDER_PRESETS,
  isLocalhostEndpoint,
  normalizeEndpoint,
  findMatchingPreset,
  PLATFORM_PROVIDER_ID,
  PLATFORM_DEV_BASE_URL,
  platformEndpoint,
} from "./providerPresets";

describe("PROVIDER_PRESETS", () => {
  it("includes core presets aligned with Mac", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("deepseek");
    expect(ids).toContain("zhipu");
    expect(ids).toContain("ollama");
    expect(ids).toContain(PLATFORM_PROVIDER_ID);
  });

  it("every preset has id/displayName/endpoint/model", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.id).toBeTruthy();
      expect(p.displayName).toBeTruthy();
      // 沉浸云例外：endpoint/model 由服务端 base 与 /v1/me/config 动态决定
      if (p.id === PLATFORM_PROVIDER_ID) continue;
      expect(p.endpoint).toMatch(/^https?:\/\//);
      expect(p.model).toBeTruthy();
    }
  });

  it("ids are unique", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("local presets allow empty API key", () => {
    const ollama = PROVIDER_PRESETS.find((p) => p.id === "ollama")!;
    expect(ollama.allowEmptyApiKey).toBe(true);
    const openai = PROVIDER_PRESETS.find((p) => p.id === "openai")!;
    expect(openai.allowEmptyApiKey ?? false).toBe(false);
  });

  it("platform preset allows empty API key (uses account token)", () => {
    const platform = PROVIDER_PRESETS.find((p) => p.id === PLATFORM_PROVIDER_ID)!;
    expect(platform.allowEmptyApiKey).toBe(true);
  });
});

describe("platformEndpoint", () => {
  it("derives the gateway URL from the server base", () => {
    expect(platformEndpoint(PLATFORM_DEV_BASE_URL)).toBe(
      "http://127.0.0.1:8090/v1/chat/completions",
    );
    expect(platformEndpoint("https://api.example.com/")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(platformEndpoint("  https://api.example.com/// ")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
  });
});

describe("isLocalhostEndpoint", () => {
  it("detects localhost / 127.0.0.1 / ::1", () => {
    expect(isLocalhostEndpoint("http://localhost:11434/v1/chat/completions")).toBe(true);
    expect(isLocalhostEndpoint("http://127.0.0.1:1234/v1/chat/completions")).toBe(true);
    expect(isLocalhostEndpoint("http://[::1]:8000/v1/chat/completions")).toBe(true);
  });

  it("rejects remote endpoints", () => {
    expect(isLocalhostEndpoint("https://api.openai.com/v1/chat/completions")).toBe(false);
    expect(isLocalhostEndpoint("https://localhost.evil.example/v1/chat/completions")).toBe(false);
    expect(isLocalhostEndpoint("https://127.0.0.1.evil.example/v1/chat/completions")).toBe(false);
    expect(isLocalhostEndpoint("")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isLocalhostEndpoint("HTTP://LOCALHOST:11434/v1/chat/completions")).toBe(true);
  });
});

describe("normalizeEndpoint", () => {
  it("preserves query parameters while completing the path", () => {
    expect(normalizeEndpoint("https://api.example.com/v1?api_key=secret&debug=1#local")).toBe(
      "https://api.example.com/v1/chat/completions?api_key=secret&debug=1",
    );
  });

  it("supports the Zhipu base path", () => {
    expect(normalizeEndpoint("https://open.bigmodel.cn/api/paas/v4")).toBe(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    );
  });
});

describe("findMatchingPreset", () => {
  it("matches by endpoint ignoring trailing slash", () => {
    const p = findMatchingPreset("https://api.openai.com/v1/chat/completions/");
    expect(p?.id).toBe("openai");
  });

  it("matches case-insensitively", () => {
    const p = findMatchingPreset("https://API.OPENAI.COM/v1/chat/completions");
    expect(p?.id).toBe("openai");
  });

  it("returns undefined for custom endpoints", () => {
    expect(findMatchingPreset("https://my-proxy.example.com/v1/chat/completions")).toBeUndefined();
  });

  it("returns undefined for empty endpoint", () => {
    expect(findMatchingPreset("")).toBeUndefined();
    expect(findMatchingPreset("   ")).toBeUndefined();
  });

  it("matches the platform endpoint when provided", () => {
    const pe = platformEndpoint("http://127.0.0.1:8090");
    expect(findMatchingPreset(pe, pe)?.id).toBe(PLATFORM_PROVIDER_ID);
    expect(findMatchingPreset(pe + "/", pe)?.id).toBe(PLATFORM_PROVIDER_ID);
    // 未传 platformEndpoint 时平台地址不匹配任何静态预设
    expect(findMatchingPreset(pe)).toBeUndefined();
    // 其他 endpoint 不因传了 platformEndpoint 而误匹配
    expect(findMatchingPreset("https://api.openai.com/v1/chat/completions", pe)?.id).toBe("openai");
  });
});
