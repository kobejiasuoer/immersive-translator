// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  CUSTOM_PROVIDER_ID,
  adoptMisplacedSingleKey,
  hasValidSettings,
  loadSettingsFullAsync,
  parseKeyVault,
  persistHotkeyField,
  persistSettingsTransaction,
  providerIdFor,
  saveSettingsFullAsync,
  type AppSettings,
} from "./settingsStore";
import { PLATFORM_PROVIDER_ID } from "../core/providerPresets";
import { authServerBaseUrl, secretGet, secretSet } from "./tauriBridge";

vi.mock("./tauriBridge", () => ({
  authServerBaseUrl: vi.fn(),
  secretGet: vi.fn(),
  secretSet: vi.fn(),
}));

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

const STORAGE_KEY = "immersive-translator-settings";
const PROD_BASE = "https://www.prismspace.online";
const PROD_GATEWAY = `${PROD_BASE}/v1/chat/completions`;

describe("沉浸云 providerId 识别（load/save 全链路）", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(authServerBaseUrl).mockResolvedValue(PROD_BASE);
    vi.mocked(secretGet).mockResolvedValue("");
    vi.mocked(secretSet).mockResolvedValue(undefined);
  });

  it("读取时把沉浸云 endpoint 识别为 immersive-cloud 并通过 hasValidSettings（v0.10.3 曾降级为 custom 导致划词被挡）", async () => {
    // 模拟 v0.10.3 落盘的坏数据：endpoint 是生产网关，providerId 却被写成 custom
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ endpoint: PROD_GATEWAY, providerId: "custom", model: "glm-4.7" }),
    );

    const { settings } = await loadSettingsFullAsync();

    expect(settings.providerId).toBe(PLATFORM_PROVIDER_ID);
    expect(hasValidSettings(settings)).toBe(true);
  });

  it("保存时持久化 immersive-cloud（而非 custom），空 Key 落在沉浸云桶", async () => {
    await saveSettingsFullAsync(
      makeSettings({ providerId: PLATFORM_PROVIDER_ID, endpoint: PROD_GATEWAY, apiKey: "" }),
      {},
    );

    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(raw.providerId).toBe(PLATFORM_PROVIDER_ID);
    expect(raw).not.toHaveProperty("apiKey");
    expect(secretSet).toHaveBeenLastCalledWith(
      JSON.stringify({ [PLATFORM_PROVIDER_ID]: "" }),
    );
  });

  it("沉浸云未开放（base 为 null）时按自定义接口处理，维持旧行为", async () => {
    vi.mocked(authServerBaseUrl).mockResolvedValue(null);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ endpoint: PROD_GATEWAY, providerId: "custom" }),
    );

    const { settings } = await loadSettingsFullAsync();

    expect(settings.providerId).toBe(CUSTOM_PROVIDER_ID);
    expect(hasValidSettings(settings)).toBe(false);
  });
});

describe("parseKeyVault", () => {
  it("returns an empty vault for empty content", () => {
    expect(parseKeyVault("", "openai")).toEqual({});
    expect(parseKeyVault("   ", "openai")).toEqual({});
  });

  it("parses a per-provider vault and drops invalid entries", () => {
    const vault = parseKeyVault(
      JSON.stringify({ openai: "sk-a", deepseek: "", ollama: 42 }),
      "openai",
    );
    expect(vault).toEqual({ openai: "sk-a" });
  });

  it("treats a legacy plaintext key as the fallback provider's bucket", () => {
    expect(parseKeyVault("sk-legacy-key", "deepseek")).toEqual({ deepseek: "sk-legacy-key" });
  });

  it("treats non-object JSON as a legacy plaintext key", () => {
    expect(parseKeyVault('["sk-x"]', CUSTOM_PROVIDER_ID)).toEqual({ [CUSTOM_PROVIDER_ID]: '["sk-x"]' });
  });
});

describe("providerIdFor", () => {
  it("always infers from the endpoint, ignoring a stale saved providerId", () => {
    expect(
      providerIdFor({
        endpoint: "https://api.deepseek.com/chat/completions",
        providerId: "openai",
      } as Pick<AppSettings, "endpoint">),
    ).toBe("deepseek");
  });

  it("infers the provider from the endpoint when providerId is missing", () => {
    expect(
      providerIdFor({ endpoint: "https://api.deepseek.com/chat/completions" }),
    ).toBe("deepseek");
  });

  it("falls back to custom for unknown endpoints", () => {
    expect(providerIdFor({ endpoint: "https://my-proxy.example.com/v1" })).toBe(
      CUSTOM_PROVIDER_ID,
    );
  });
});

describe("adoptMisplacedSingleKey", () => {
  it("returns the key to the current provider when the vault holds one misplaced key", () => {
    expect(adoptMisplacedSingleKey({ openai: "sk-ds" }, "deepseek", false)).toEqual({
      deepseek: "sk-ds",
    });
  });

  it("keeps the vault untouched when the single key is already in the right bucket", () => {
    expect(adoptMisplacedSingleKey({ deepseek: "sk-ds" }, "deepseek", false)).toBeNull();
  });

  it("does not touch a multi-provider vault", () => {
    expect(adoptMisplacedSingleKey({ openai: "sk-a", zhipu: "sk-b" }, "deepseek", false)).toBeNull();
  });

  it("never adopts for localhost endpoints (they need no key)", () => {
    expect(adoptMisplacedSingleKey({ openai: "sk-a" }, "ollama", true)).toBeNull();
  });
});

describe("persistSettingsTransaction", () => {
  it("restores the previous raw settings when DPAPI writing fails", async () => {
    let raw: string | null = JSON.stringify({ old: true });
    const writes: Array<string | null> = [];
    const writeSecret = vi.fn(async () => {
      throw new Error("DPAPI unavailable");
    });

    await expect(
      persistSettingsTransaction(
        makeSettings({ apiKey: "new-secret", model: "new-model" }),
        () => raw,
        (next) => {
          writes.push(next);
          raw = next;
        },
        writeSecret,
      ),
    ).rejects.toThrow("DPAPI unavailable");

    expect(writeSecret).toHaveBeenCalledWith("new-secret");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe(JSON.stringify({ old: true }));
    expect(raw).toBe(JSON.stringify({ old: true }));
  });

  it("removes a newly-created raw value when the previous value was absent", async () => {
    let raw: string | null = null;
    const writes: Array<string | null> = [];

    await expect(
      persistSettingsTransaction(
        makeSettings({ apiKey: "secret" }),
        () => raw,
        (next) => {
          writes.push(next);
          raw = next;
        },
        async () => {
          throw "write failed";
        },
      ),
    ).rejects.toBe("write failed");

    expect(writes).toHaveLength(2);
    expect(writes[1]).toBeNull();
    expect(raw).toBeNull();
  });

  it("reports both errors if the settings rollback fails", async () => {
    let writes = 0;

    await expect(
      persistSettingsTransaction(
        makeSettings({ apiKey: "secret" }),
        () => "previous",
        () => {
          writes += 1;
          if (writes === 2) throw new Error("storage locked");
        },
        async () => {
          throw new Error("DPAPI unavailable");
        },
      ),
    ).rejects.toThrow("storage locked");

    expect(writes).toBe(2);
  });

  it("does not attempt DPAPI when localStorage write fails", async () => {
    const writeSecret = vi.fn(async () => undefined);

    await expect(
      persistSettingsTransaction(
        makeSettings(),
        () => "previous",
        () => {
          throw new Error("quota exceeded");
        },
        writeSecret,
      ),
    ).rejects.toThrow("quota exceeded");

    expect(writeSecret).not.toHaveBeenCalled();
  });
});

describe("persistHotkeyField", () => {
  it("updates only the persisted hotkey", () => {
    const previous = {
      endpoint: "https://saved.example.com/v1",
      model: "saved-model",
      customStyle: "saved style",
      hotkey: "Ctrl+Shift+Q",
    };
    let written = "";

    persistHotkeyField(
      "Alt+Shift+T",
      () => JSON.stringify(previous),
      (raw) => {
        written = raw;
      },
    );

    expect(JSON.parse(written)).toEqual({ ...previous, hotkey: "Alt+Shift+T" });
  });

  it("creates default non-sensitive settings when storage is absent", () => {
    let written = "";

    persistHotkeyField(
      "Ctrl+Alt+K",
      () => null,
      (raw) => {
        written = raw;
      },
    );

    const parsed = JSON.parse(written);
    expect(parsed.hotkey).toBe("Ctrl+Alt+K");
    expect(parsed.endpoint).toBe(DEFAULT_SETTINGS.endpoint);
    expect(parsed).not.toHaveProperty("apiKey");
  });

  it("does not retain a legacy plaintext API key", () => {
    let written = "";

    persistHotkeyField(
      "Ctrl+Alt+K",
      () => JSON.stringify({ endpoint: "https://e.com", apiKey: "plaintext" }),
      (raw) => {
        written = raw;
      },
    );

    expect(JSON.parse(written)).toEqual({
      endpoint: "https://e.com",
      hotkey: "Ctrl+Alt+K",
    });
    expect(written).not.toContain("plaintext");
  });

  it("refuses to overwrite malformed persisted settings", () => {
    const writeRaw = vi.fn();

    expect(() => persistHotkeyField("Ctrl+Alt+K", () => "not-json", writeRaw)).toThrow();
    expect(writeRaw).not.toHaveBeenCalled();
  });
});
