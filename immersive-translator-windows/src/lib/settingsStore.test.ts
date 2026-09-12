import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  CUSTOM_PROVIDER_ID,
  adoptMisplacedSingleKey,
  parseKeyVault,
  persistHotkeyField,
  persistSettingsTransaction,
  providerIdFor,
  type AppSettings,
} from "./settingsStore";

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

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
