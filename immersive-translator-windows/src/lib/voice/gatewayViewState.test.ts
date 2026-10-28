import { describe, expect, it } from "vitest";
import {
  CAPABILITY_LABELS,
  quotaLine,
  quotaResetText,
  reduceVoiceGatewayView,
  voiceErrorDisplayText,
  voiceGatewayStatusLine,
  type VoiceGatewayInput,
} from "./gatewayViewState";
import type { VoiceCapabilities } from "./voiceCapabilities";

const EMAIL = "hongfei.lin@outlook.com";

function caps(overrides: Partial<VoiceCapabilities> = {}): VoiceCapabilities {
  return {
    available: true,
    ttsVoices: [{ id: "mock-male", label: "男" }],
    asrLanguages: ["en_us"],
    iseEnabled: true,
    quota: null,
    ...overrides,
  };
}

function input(overrides: Partial<VoiceGatewayInput> = {}): VoiceGatewayInput {
  return { loading: false, errorCode: null, caps: caps(), quotaEvents: [], ...overrides };
}

describe("reduceVoiceGatewayView（§三.6 状态机归约）", () => {
  it("封禁优先于一切（红点整卡，无重试）", () => {
    const view = reduceVoiceGatewayView(input({ errorCode: "banned", loading: true }));
    expect(view.caps).toBe("banned");
    expect(view.missing).toEqual([]);
  });

  it("其余失败码归网络失败（含未归类 AuthError）", () => {
    for (const errorCode of ["network_error", "token_invalid", "upstream_error"]) {
      expect(reduceVoiceGatewayView(input({ errorCode })).caps).toBe("error");
    }
  });

  it("下发中 / 尚无结果 → loading", () => {
    expect(reduceVoiceGatewayView(input({ loading: true })).caps).toBe("loading");
    expect(reduceVoiceGatewayView(input({ caps: null })).caps).toBe("loading");
  });

  it("voice 段缺失（available=false）→ 未开通", () => {
    const view = reduceVoiceGatewayView(input({ caps: caps({ available: false }) }));
    expect(view.caps).toBe("none");
    expect(view.missing).toEqual([]);
  });

  it("三项齐备 → full；quota 原样透传（常驻余量条数据源）", () => {
    const quota = { tts: { remaining: 10, allowance: null, resetsAt: null } };
    const view = reduceVoiceGatewayView(input({ caps: caps({ quota }) }));
    expect(view.caps).toBe("full");
    expect(view.missing).toEqual([]);
    expect(view.quota).toEqual(quota);
    expect(view.exhausted).toBe(false);
  });

  it("部分可用三种：ttsVoices 空 / asrLanguages 空 / iseEnabled=false", () => {
    const ttsOnly = reduceVoiceGatewayView(
      input({ caps: caps({ asrLanguages: [], iseEnabled: false }) }),
    );
    expect(ttsOnly.caps).toBe("partial");
    expect(ttsOnly.missing).toEqual(["asr", "ise"]);

    const asrOnly = reduceVoiceGatewayView(
      input({ caps: caps({ ttsVoices: [], iseEnabled: false }) }),
    );
    expect(asrOnly.caps).toBe("partial");
    expect(asrOnly.missing).toEqual(["tts", "ise"]);

    const iseOff = reduceVoiceGatewayView(input({ caps: caps({ iseEnabled: false }) }));
    expect(iseOff.caps).toBe("partial");
    expect(iseOff.missing).toEqual(["ise"]);
  });

  it("常驻配额：remaining===0 判耗尽并给出功能名（§三.6 配额耗尽态）", () => {
    const view = reduceVoiceGatewayView(
      input({
        caps: caps({
          quota: {
            tts: { remaining: 0, allowance: null, resetsAt: null },
            asr: { remaining: 30, allowance: null, resetsAt: null },
          },
        }),
      }),
    );
    expect(view.caps).toBe("full"); // 耗尽不改能力相位，只叠额度视图
    expect(view.exhausted).toBe(true);
    expect(view.exhaustedLabels).toEqual([CAPABILITY_LABELS.tts]);
  });

  it("兜底来源：402/WSS 事件 resource（含 tts_chars 别名）并入耗尽", () => {
    const view = reduceVoiceGatewayView(input({ quotaEvents: ["ise_calls", "tts_chars"] }));
    expect(view.exhausted).toBe(true);
    expect(view.exhaustedLabels).toContain(CAPABILITY_LABELS.ise);
    expect(view.exhaustedLabels).toContain("朗读");
  });

  it("重复事件去重后不再叠加", () => {
    const view = reduceVoiceGatewayView(input({ quotaEvents: ["ise_calls"] }));
    const again = reduceVoiceGatewayView(input({ quotaEvents: ["ise_calls", "ise_calls"] }));
    expect(again.exhaustedLabels).toEqual(view.exhaustedLabels);
  });
});

describe("voiceGatewayStatusLine（沉浸云卡状态行文案）", () => {
  it("未登录：琥珀点 + 引导登录", () => {
    const line = voiceGatewayStatusLine(reduceVoiceGatewayView(input()), {
      loggedIn: false,
      email: EMAIL,
    });
    expect(line).toEqual({ tone: "off", text: "未登录——选中后到右侧登录即可使用" });
  });

  it("下发中：已登录 + 正在获取", () => {
    const line = voiceGatewayStatusLine(reduceVoiceGatewayView(input({ loading: true })), {
      loggedIn: true,
      email: EMAIL,
    });
    expect(line).toEqual({ tone: "ok", text: `已登录 ${EMAIL} · 正在获取语音能力…` });
  });

  it("封禁 / 网络失败：红点无重试语义", () => {
    const banned = voiceGatewayStatusLine(reduceVoiceGatewayView(input({ errorCode: "banned" })), {
      loggedIn: true,
      email: EMAIL,
    });
    expect(banned).toEqual({ tone: "err", text: "账号已被封禁" });
    const err = voiceGatewayStatusLine(
      reduceVoiceGatewayView(input({ errorCode: "network_error" })),
      { loggedIn: true, email: EMAIL },
    );
    expect(err).toEqual({ tone: "err", text: "连接沉浸云失败，请检查网络" });
  });

  it("部分可用：列出可用与未开放（短名）", () => {
    const line = voiceGatewayStatusLine(
      reduceVoiceGatewayView(input({ caps: caps({ iseEnabled: false }) })),
      { loggedIn: true, email: EMAIL },
    );
    expect(line).toEqual({
      tone: "off",
      text: `已登录 ${EMAIL} · 朗读、识别可用，跟读打分未开放`,
    });
  });

  it("全部可用 vs 额度用尽（耗尽态优先展示）", () => {
    const full = voiceGatewayStatusLine(reduceVoiceGatewayView(input()), {
      loggedIn: true,
      email: EMAIL,
    });
    expect(full).toEqual({ tone: "ok", text: `已登录 ${EMAIL} · 朗读、识别、跟读打分全部可用` });

    const exhausted = voiceGatewayStatusLine(
      reduceVoiceGatewayView(input({ quotaEvents: ["ise_calls"] })),
      { loggedIn: true, email: EMAIL },
    );
    expect(exhausted).toEqual({ tone: "off", text: `已登录 ${EMAIL} · 本月额度已用完` });
  });
});

describe("quotaLine / quotaResetText（本月额度明细）", () => {
  it("单位与 QuotaService 同源：tts=字、asr=秒、ise=次", () => {
    expect(
      quotaLine({
        tts: { remaining: 123456, allowance: null, resetsAt: null },
        asr: { remaining: 3600, allowance: null, resetsAt: null },
        ise: { remaining: 8, allowance: null, resetsAt: null },
      }),
    ).toBe("朗读 123456 字 · 识别 3600 秒 · 跟读 8 次");
  });

  it("缺失条目落 — 占位", () => {
    expect(quotaLine({ tts: { remaining: 0, allowance: null, resetsAt: null } })).toBe(
      "朗读 0 字 · 识别 — 秒 · 跟读 — 次",
    );
  });

  it("resetsAt → 「M 月 D 日重置」；非法/缺失返回 null", () => {
    expect(quotaResetText("2026-11-01T00:00:00.000Z")).toMatch(/月 1 日重置$/);
    expect(quotaResetText("not-a-date")).toBeNull();
    expect(quotaResetText(null)).toBeNull();
    expect(quotaResetText(undefined)).toBeNull();
  });
});

describe("voiceErrorDisplayText（消费点错误展示，§二 quota_exceeded 动作列）", () => {
  it("额度类：details.resetsAt 拼成重置时间", () => {
    expect(
      voiceErrorDisplayText({
        code: "quota_exceeded",
        details: { resource: "tts_chars", resetsAt: "2026-11-01T00:00:00.000Z" },
      }),
    ).toBe("本月朗读额度已用完，11 月 1 日重置");
  });

  it("额度类：resetsAt 未下发时给「设置 → 账号」兑换码指路（与路由守卫 hint 同措辞）", () => {
    expect(voiceErrorDisplayText({ code: "quota_exceeded", details: { resource: "ise_calls" } })).toBe(
      "本月跟读打分额度已用完，可在「设置 → 账号」用兑换码补足",
    );
    expect(voiceErrorDisplayText("quota_exceeded")).toBe(
      "本月语音额度已用完，可在「设置 → 账号」用兑换码补足",
    );
  });

  it("非额度类原样透传 voiceErrorMessage 文案；silent/internal 返回空串", () => {
    expect(voiceErrorDisplayText("banned")).toBe("账号已被封禁");
    expect(voiceErrorDisplayText({ code: "network_error" })).toBe("网络连接失败，请检查网络后重试");
    // token_expired 是 silent（Rust 单飞刷新吞掉），消费点拿空串走各自兜底。
    expect(voiceErrorDisplayText("token_expired")).toBe("");
  });
});
