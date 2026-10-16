/**
 * edgeDrm 单测：v2 签名的固定向量对照。
 *
 * 向量由上游 rany2/edge-tts 的 drm.py（2026-10 @ master）对固定时间戳
 * 机器生成——它曾实测通过微软握手（HTTP 101），这里逐字节锁定 TS 移植：
 * 任何常量抄错/运算顺序改动都会打红。勿手工"更新"期望值。
 */

import { describe, expect, it } from "vitest";
import { cs64Digest, secMsGecV2, sha256Modified } from "./edgeDrm";

const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

interface Vector {
  /** 固定 unix 秒（仅注释用）。 */
  ts: number;
  data: string;
  sha: string;
  cs64: string;
  token: string;
}

/** ticks = (ts + 11644473600) 对齐 5 分钟后 ×1e7 的十进制串 + TOKEN。 */
const VECTORS: Vector[] = [
  {
    ts: 1760000000,
    data: `134044734000000000${TOKEN}`,
    sha: "DD68EFB01898B0750C9797D51A5FF93471DFDAE6888A1039D532CBDCCE54545D",
    cs64: "6D50DDDB91812C33",
    token: "6D50DDDB91812C33-DD68EFB01898B0750C9797D51A5FF93471DFDAE6888A1039D532CBDCCE54545D",
  },
  {
    ts: 1700000000,
    data: `133444734000000000${TOKEN}`,
    sha: "F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2",
    cs64: "2CD23A2CA0B2595A",
    token: "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2",
  },
  {
    ts: 0,
    data: `116444736000000000${TOKEN}`,
    sha: "28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6",
    cs64: "52BC7A17B50DFEC9",
    token: "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6",
  },
];

describe("secMsGecV2（上游 drm.py 固定向量）", () => {
  it.each(VECTORS)("ts=$ts：CS64-SHA256 组合 token 逐字节一致", ({ data, token }) => {
    expect(secMsGecV2(new TextEncoder().encode(data))).toBe(token);
  });

  it("魔改 SHA-256 与标准库不同（这是 403 的根因，防止有人改回 subtle.digest）", () => {
    const data = new TextEncoder().encode(VECTORS[0].data);
    const sha = [...sha256Modified(data)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    expect(sha).toBe(VECTORS[0].sha);
  });

  it("cs64Digest 返回两个 u32，小端打包即 16 hex", () => {
    const data = new TextEncoder().encode(VECTORS[1].data);
    const sha = sha256Modified(data);
    const [w0, w1] = cs64Digest(data, sha);
    const pack = (v: number) =>
      [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    expect((pack(w0) + pack(w1)).toUpperCase()).toBe(VECTORS[1].cs64);
  });

  it("被签串过短（<7 字节）拒绝", () => {
    expect(() => sha256Modified(new TextEncoder().encode("short"))).toThrow("7 字节");
  });
});
