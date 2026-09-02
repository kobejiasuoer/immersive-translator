import { describe, it, expect } from "vitest";
import {
  PROVIDER_PRESETS,
  isLocalhostEndpoint,
  normalizeEndpoint,
  findMatchingPreset,
} from "./providerPresets";

describe("PROVIDER_PRESETS", () => {
  it("includes core presets aligned with Mac", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("deepseek");
    expect(ids).toContain("zhipu");
    expect(ids).toContain("ollama");
  });

  it("every preset has id/displayName/endpoint/model", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.id).toBeTruthy();
      expect(p.displayName).toBeTruthy();
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
});
