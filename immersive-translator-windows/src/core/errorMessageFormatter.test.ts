import { describe, it, expect } from "vitest";
import {
  classifyTranslationError,
  buildSanitizedCurl,
  buildDiagnosticReport,
  sanitizeDiagnosticText,
} from "./errorMessageFormatter";

describe("classifyTranslationError", () => {
  it("classifies 401 as API Key problem, not retryable", () => {
    const result = classifyTranslationError({ kind: "http", status: 401, body: "Unauthorized" });
    expect(result.message).toContain("API Key");
    expect(result.retryable).toBe(false);
  });

  it("classifies 403 as permission/auth problem, not retryable", () => {
    const result = classifyTranslationError({ kind: "http", status: 403, body: "" });
    expect(result.message).toContain("权限");
    expect(result.retryable).toBe(false);
  });

  it("classifies 404 as endpoint path problem, not retryable", () => {
    const result = classifyTranslationError({ kind: "http", status: 404, body: "Cannot POST" });
    expect(result.message).toContain("接口地址");
    expect(result.retryable).toBe(false);
  });

  it("classifies 429 as rate limit, retryable", () => {
    const result = classifyTranslationError({ kind: "http", status: 429, body: "" });
    expect(result.message).toContain("限流");
    expect(result.retryable).toBe(true);
  });

  it("classifies 500 as server error, retryable", () => {
    const result = classifyTranslationError({ kind: "http", status: 500, body: "" });
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("服务");
  });

  it("classifies network error as retryable", () => {
    const result = classifyTranslationError({ kind: "network", message: "connection refused" });
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("网络");
  });

  it("classifies timeout as retryable", () => {
    const result = classifyTranslationError({ kind: "timeout" });
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("超时");
  });

  it("classifies empty translation body, not retryable", () => {
    const result = classifyTranslationError({ kind: "emptyTranslation" });
    expect(result.retryable).toBe(false);
  });

  it("classifies 200 HTML response as format problem, not retryable", () => {
    const result = classifyTranslationError({ kind: "http", status: 200, body: "<html>login page</html>" });
    expect(result.retryable).toBe(false);
    expect(result.message).toContain("HTML");
  });

  it("falls back to generic message for unknown status", () => {
    const result = classifyTranslationError({ kind: "http", status: 418, body: "" });
    expect(result.message).toContain("418");
  });

  it("includes preview for invalidResponse", () => {
    const result = classifyTranslationError({ kind: "invalidResponse", preview: "some garbage response" });
    expect(result.message).toContain("some garbage response");
    expect(result.retryable).toBe(false);
  });

  it("sanitizes provider credentials before showing HTTP error bodies", () => {
    const endpoint = "https://user:pass@example.com/v1?api_key=query-secret";
    const apiKey = "opaque-live-key";
    const result = classifyTranslationError(
      {
        kind: "http",
        status: 400,
        body: `{"error":{"message":"failed ${apiKey}","signature":"sig-secret"}}`,
      },
      endpoint,
      apiKey,
    );

    expect(result.message).toContain("failed REDACTED");
    expect(result.message).not.toContain(apiKey);
    expect(result.message).not.toContain("sig-secret");
  });

  it("sanitizes network error text at the UI boundary", () => {
    const safe = sanitizeDiagnosticText(
      "request failed: https://user:pass@example.com/v1?token=secret",
      "https://user:pass@example.com/v1?token=secret",
      "",
    );

    expect(safe).toContain("example.com");
    expect(safe).not.toContain("user");
    expect(safe).not.toContain("pass");
    expect(safe).not.toContain("secret");
  });
});

describe("vendor-aware diagnostics", () => {
  it("detects Gemini API_KEY_INVALID and gives Gemini hint", () => {
    const result = classifyTranslationError({
      kind: "http",
      status: 400,
      body: '{"error":{"code":"API_KEY_INVALID","message":"API key invalid"}}',
    });
    expect(result.message).toContain("Gemini");
  });

  it("detects OpenRouter credit issue (402)", () => {
    const result = classifyTranslationError({
      kind: "http",
      status: 402,
      body: '{"error":{"message":"insufficient credits"}}',
    });
    expect(result.message).toContain("信用额度");
  });

  it("parses server message from error JSON", () => {
    const result = classifyTranslationError({
      kind: "http",
      status: 400,
      body: '{"error":{"message":"model not found"}}',
    });
    expect(result.message).toContain("model not found");
  });

  it("handles 200 OK with embedded error JSON", () => {
    const result = classifyTranslationError({
      kind: "http",
      status: 200,
      body: '{"error":{"message":"quota exceeded"}}',
    });
    expect(result.message).toContain("quota exceeded");
    expect(result.retryable).toBe(false);
  });

  it("gives localhost hint for network error to local endpoint", () => {
    const result = classifyTranslationError(
      { kind: "network", message: "connection refused" },
      "http://localhost:11434/v1/chat/completions",
    );
    expect(result.message).toContain("本地");
    expect(result.message).toContain("Ollama");
  });

  it("gives proxy hint for network error to remote endpoint", () => {
    const result = classifyTranslationError(
      { kind: "network", message: "timeout" },
      "https://api.openai.com/v1/chat/completions",
    );
    expect(result.message).toContain("代理");
  });

  it("detects DeepSeek 402 balance issue", () => {
    const result = classifyTranslationError({
      kind: "http",
      status: 402,
      body: '{"error":{"message":"deepseek balance insufficient"}}',
    });
    expect(result.message).toContain("DeepSeek");
  });
});

describe("buildSanitizedCurl", () => {
  it("redacts the API key", () => {
    const curl = buildSanitizedCurl(
      "https://api.openai.com/v1/chat/completions",
      "sk-secret-12345",
      "gpt-4o-mini",
      "hello",
    );
    expect(curl).toContain("REDACTED");
    expect(curl).not.toContain("sk-secret-12345");
  });

  it("includes endpoint and model", () => {
    const curl = buildSanitizedCurl("https://example.com/v1/chat/completions", "sk-x", "my-model", "hi");
    expect(curl).toContain("curl.exe -X POST --url ");
    expect(curl).toContain("example.com");
    expect(curl).toContain("my-model");
  });

  it("escapes quotes in sample text", () => {
    const curl = buildSanitizedCurl("https://e.com", "sk", "m", 'say "hi"');
    expect(curl).toContain('\\"hi\\"');
  });

  it("keeps PowerShell metacharacters inside quoted arguments", () => {
    const curl = buildSanitizedCurl(
      "https://e.com/api/'quoted'",
      "sk",
      "model'; echo injected",
      "say 'hi'; $(whoami)\nnext line",
    );

    // PowerShell represents an apostrophe inside a single-quoted string as ''.
    expect(curl).toContain("''quoted''");
    expect(curl).toContain("model''; echo injected");
    // JSON encoding keeps the newline in the -d payload rather than creating
    // a second shell command line.
    expect(curl).not.toContain("\nnext line");
    expect(curl).toContain(" `\n  -H ");
    expect(curl).toContain("echo injected");
    expect(curl).toContain("$(whoami)");
  });

  it("redacts credentials embedded in the endpoint", () => {
    const curl = buildSanitizedCurl(
      "https://user:password@example.com/v1/chat/completions?api_key=query-secret&debug=1#token-fragment",
      "sk",
      "m",
      "hi",
    );

    expect(curl).toContain("REDACTED");
    expect(curl).toContain("debug=1");
    expect(curl).not.toContain("password");
    expect(curl).not.toContain("query-secret");
    expect(curl).not.toContain("token-fragment");
  });

  it("shows empty key marker when no key", () => {
    const curl = buildSanitizedCurl("https://e.com", "", "m", "hi");
    expect(curl).toContain("(空)");
  });
});

describe("buildDiagnosticReport", () => {
  it("redacts full API key but shows length and prefix", () => {
    const report = buildDiagnosticReport({
      endpoint: "https://api.openai.com/v1/chat/completions",
      apiKey: "sk-abcdef123456",
      model: "gpt-4o-mini",
      stream: true,
      translationMode: "auto",
      fixedTarget: "",
    });
    expect(report).toContain("长度 15");
    expect(report).toContain("内容已脱敏");
    expect(report).not.toContain("abcdef123456");
  });

  it("redacts endpoint query credentials in every report section", () => {
    const report = buildDiagnosticReport({
      endpoint: "https://e.com/v1?api_key=query-secret&trace=on#token-fragment",
      apiKey: "sk-secret",
      model: "m",
      stream: true,
      translationMode: "auto",
      fixedTarget: "",
    });

    expect(report).toContain("api_key=REDACTED");
    expect(report).toContain("trace=on");
    expect(report).not.toContain("query-secret");
    expect(report).not.toContain("token-fragment");
  });

  it("redacts provider signature query parameters", () => {
    const curl = buildSanitizedCurl(
      "https://storage.example.com/v1?X-Amz-Signature=aws-secret&x-goog-signature=google-secret&trace=1",
      "",
      "m",
      "hi",
    );

    expect(curl).toContain("X-Amz-Signature=REDACTED");
    expect(curl).toContain("x-goog-signature=REDACTED");
    expect(curl).toContain("trace=1");
    expect(curl).not.toContain("aws-secret");
    expect(curl).not.toContain("google-secret");
  });

  it("hides invalid endpoint metadata instead of guessing at secrets", () => {
    const report = buildDiagnosticReport({
      endpoint: "https://user:secret@example .com/#token-fragment",
      apiKey: "",
      model: "m",
      stream: false,
      translationMode: "auto",
      fixedTarget: "",
    });

    expect(report).toContain("(invalid endpoint, hidden)");
    expect(report).not.toContain("secret");
    expect(report).not.toContain("token-fragment");
  });

  it("includes endpoint and model", () => {
    const report = buildDiagnosticReport({
      endpoint: "https://deepseek.com/chat/completions",
      apiKey: "sk-x",
      model: "deepseek-chat",
      stream: false,
      translationMode: "auto",
      fixedTarget: "",
    });
    expect(report).toContain("deepseek.com");
    expect(report).toContain("deepseek-chat");
    expect(report).toContain("流式输出：关");
  });

  it("includes last error when provided", () => {
    const report = buildDiagnosticReport({
      endpoint: "https://e.com",
      apiKey: "sk-x",
      model: "m",
      stream: true,
      translationMode: "auto",
      fixedTarget: "",
      lastError: "HTTP 401 Unauthorized",
    });
    expect(report).toContain("HTTP 401 Unauthorized");
  });

  it("redacts credentials and caps arbitrary last errors", () => {
    const configuredEndpoint =
      "https://user:pass@example.com/v1?api_key=query-secret#fragment";
    const configuredApiKey = "opaque-live-key-value";
    const secretError = [
      "HTTP 401",
      configuredEndpoint,
      `Authorization: Bearer ${configuredApiKey}`,
      "provider echoed sk-another-secret-value",
      "trace=" + "x".repeat(900),
    ].join(" ");
    const report = buildDiagnosticReport({
      endpoint: configuredEndpoint,
      apiKey: configuredApiKey,
      model: "m",
      stream: true,
      translationMode: "auto",
      fixedTarget: "",
      lastError: secretError,
    });

    expect(report).toContain("HTTP 401");
    expect(report).toContain("example.com");
    expect(report).toContain("REDACTED");
    expect(report).toContain("（已截断）");
    expect(report).not.toContain("pass@example.com");
    expect(report).not.toContain("query-secret");
    expect(report).not.toContain("#fragment");
    expect(report).not.toContain(configuredApiKey);
    expect(report).not.toContain("sk-another-secret-value");
  });

  it("redacts credentials from quoted JSON fields in last errors", () => {
    const report = buildDiagnosticReport({
      endpoint: "https://e.com",
      apiKey: "",
      model: "m",
      stream: true,
      translationMode: "auto",
      fixedTarget: "",
      lastError:
        '{"signature":"abcdef123456789","api_key":"opaque-value-12345","message":"failed"}',
    });

    expect(report).toContain('"signature":"REDACTED"');
    expect(report).toContain('"api_key":"REDACTED"');
    expect(report).not.toContain("abcdef123456789");
    expect(report).not.toContain("opaque-value-12345");
  });

  it("shows no-error placeholder", () => {
    const report = buildDiagnosticReport({
      endpoint: "https://e.com",
      apiKey: "",
      model: "m",
      stream: true,
      translationMode: "auto",
      fixedTarget: "",
    });
    expect(report).toContain("（无）");
    expect(report).toContain("未配置");
  });

  it("includes a sanitized curl block", () => {
    const report = buildDiagnosticReport({
      endpoint: "https://e.com",
      apiKey: "sk-secret",
      model: "m",
      stream: true,
      translationMode: "auto",
      fixedTarget: "English",
    });
    expect(report).toContain("curl");
    expect(report).toContain("REDACTED");
    expect(report).toContain("目标：English");
  });
});
