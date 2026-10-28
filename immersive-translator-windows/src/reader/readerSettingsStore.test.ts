// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { resolveLegacyTtsMigrationAllowed } from "./readerSettingsStore";

describe("resolveLegacyTtsMigrationAllowed（全局/文章级旧覆盖共用）", () => {
  it("任一讯飞凭据存在 → 允许迁移", async () => {
    const allowed = await resolveLegacyTtsMigrationAllowed({
      hasAnyXfyunCredential: vi.fn().mockResolvedValue(true),
      isLoggedIn: vi.fn().mockResolvedValue(false),
    });
    expect(allowed).toBe(true);
  });

  it("已登录沉浸云（无讯飞凭据）→ 允许迁移", async () => {
    const allowed = await resolveLegacyTtsMigrationAllowed({
      hasAnyXfyunCredential: vi.fn().mockResolvedValue(false),
      isLoggedIn: vi.fn().mockResolvedValue(true),
    });
    expect(allowed).toBe(true);
  });

  it("无凭据且未登录 → 不迁移，保留旧 xfyun 语义", async () => {
    const allowed = await resolveLegacyTtsMigrationAllowed({
      hasAnyXfyunCredential: vi.fn().mockResolvedValue(false),
      isLoggedIn: vi.fn().mockResolvedValue(false),
    });
    expect(allowed).toBe(false);
  });

  it("探测失败（DPAPI/登录态不可用）按无该项处理，不迁移", async () => {
    const allowed = await resolveLegacyTtsMigrationAllowed({
      hasAnyXfyunCredential: vi.fn().mockRejectedValue(new Error("DPAPI unavailable")),
      isLoggedIn: vi.fn().mockRejectedValue(new Error("no backend")),
    });
    expect(allowed).toBe(false);
  });
});
