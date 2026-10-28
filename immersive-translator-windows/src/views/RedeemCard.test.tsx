// @vitest-environment jsdom
// 兑换码卡片（语音云契约 §三.10 / 决策 5）：错误映射 + 提交状态机。
// 传输经 tauriBridge.redeemCode（Rust with_auth 附带 Bearer，前端无 fetch 可
// mock），按 AccountSection.test.tsx 同先例 mock tauriBridge。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { RedeemCard, redeemErrorCodeOf, redeemErrorText } from "./RedeemCard";
import {
  actAsync,
  createHarness,
  findButton,
  setInputValue,
  type Harness,
} from "./authTestHarness";
import { redeemCode, type SyncHttpText } from "../lib/tauriBridge";

vi.mock("../lib/tauriBridge", () => ({
  redeemCode: vi.fn(),
}));

const mockedRedeem = vi.mocked(redeemCode);

function resp(status: number, body: string): SyncHttpText {
  return { status, body, retryAfterSeconds: null };
}

/** 服务端 AppError 信封（错误码语义/状态码与 redeem.service.ts 对齐）。 */
function appErrorResp(status: number, code: string): SyncHttpText {
  return resp(status, JSON.stringify({ error: { code, message: "服务端原文不进 UI" } }));
}

beforeEach(() => {
  vi.resetAllMocks();
});

/** 挂载 + 冲刷微任务。 */
async function mountCard(): Promise<Harness> {
  const h = createHarness();
  h.render(<RedeemCard />);
  await actAsync(() => undefined);
  return h;
}

function inputOf(h: Harness): HTMLInputElement {
  const input = h.container.querySelector("input");
  if (!input) throw new Error("redeem input not found");
  return input as HTMLInputElement;
}

describe("redeemErrorText 错误映射", () => {
  it("三个业务码逐字映射（契约 §三.10）", () => {
    expect(redeemErrorText(appErrorResp(404, "redeem_code_not_found"))).toBe("兑换码不存在");
    expect(redeemErrorText(appErrorResp(410, "redeem_code_expired"))).toBe("兑换码已过期");
    expect(redeemErrorText(appErrorResp(409, "redeem_code_used"))).toBe("兑换码已被使用");
  });

  it("其余错误码（validation_error / 未知码）一律落兜底文案", () => {
    expect(redeemErrorText(appErrorResp(422, "validation_error"))).toBe("兑换失败，请稍后再试");
    expect(redeemErrorText(appErrorResp(500, "internal_error"))).toBe("兑换失败，请稍后再试");
  });

  it("非 JSON / 非 AppError 信封 body → 兜底文案，错误码解析为 null", () => {
    expect(redeemErrorCodeOf(resp(502, "<html>Bad Gateway</html>"))).toBeNull();
    expect(redeemErrorCodeOf(resp(200, "null"))).toBeNull();
    expect(redeemErrorText(resp(502, "<html>Bad Gateway</html>"))).toBe("兑换失败，请稍后再试");
  });
});

describe("RedeemCard 提交状态机", () => {
  it("锚点与初始态：外层 id=account-redeem，空输入禁用提交", async () => {
    const h = await mountCard();

    expect(h.container.querySelector("#account-redeem")).not.toBeNull();
    const submit = findButton(h.container, "兑换");
    expect(submit.disabled).toBe(true);
    h.unmount();
  });

  it("idle → submitting：按钮「兑换中…」+ 输入/按钮全禁用，透传 trim 后的码", async () => {
    const h = await mountCard();
    let resolveSubmit: ((r: SyncHttpText) => void) | null = null;
    mockedRedeem.mockImplementationOnce(
      () =>
        new Promise<SyncHttpText>((resolve) => {
          resolveSubmit = resolve;
        }),
    );

    act(() => setInputValue(inputOf(h), "  abcd-efgh-jklm-npqr  "));
    await actAsync(() => findButton(h.container, "兑换").click());

    expect(mockedRedeem).toHaveBeenCalledTimes(1);
    expect(mockedRedeem).toHaveBeenCalledWith("abcd-efgh-jklm-npqr");
    expect(findButton(h.container, "兑换中…").disabled).toBe(true);
    expect(inputOf(h).disabled).toBe(true);

    await actAsync(() => {
      resolveSubmit!(resp(200, JSON.stringify({ code: "x", amount: 1 })));
    });
    h.unmount();
  });

  it("submitting → success：ok 条「兑换成功，额度已到账」，输入清空允许连兑", async () => {
    const h = await mountCard();
    mockedRedeem.mockResolvedValueOnce(resp(200, JSON.stringify({ grantId: "g1" })));

    act(() => setInputValue(inputOf(h), "ABCD-EFGH-JKLM-NPQR"));
    await actAsync(() => findButton(h.container, "兑换").click());

    expect(h.container.querySelector(".msg-bar.ok")?.textContent).toContain("兑换成功，额度已到账");
    expect(inputOf(h).value).toBe("");
    // 回到可再提交的 idle：输入空则按钮禁用，文案复位「兑换」
    expect(findButton(h.container, "兑换").disabled).toBe(true);
    h.unmount();
  });

  it("submitting → error：not_found 映射「兑换码不存在」，输入保留可重试", async () => {
    const h = await mountCard();
    mockedRedeem.mockResolvedValueOnce(appErrorResp(404, "redeem_code_not_found"));

    act(() => setInputValue(inputOf(h), "ABCD-EFGH-JKLM-NPQR"));
    await actAsync(() => findButton(h.container, "兑换").click());

    expect(h.container.querySelector(".msg-bar.err")?.textContent).toContain("兑换码不存在");
    expect(inputOf(h).value).toBe("ABCD-EFGH-JKLM-NPQR");
    expect(findButton(h.container, "兑换").disabled).toBe(false);
    h.unmount();
  });

  it("expired / used 在组件内同样逐字映射（err 条）", async () => {
    const h = await mountCard();
    mockedRedeem.mockResolvedValueOnce(appErrorResp(410, "redeem_code_expired"));
    act(() => setInputValue(inputOf(h), "ABCD-EFGH-JKLM-NPQR"));
    await actAsync(() => findButton(h.container, "兑换").click());
    expect(h.container.querySelector(".msg-bar.err")?.textContent).toContain("兑换码已过期");

    mockedRedeem.mockResolvedValueOnce(appErrorResp(409, "redeem_code_used"));
    await actAsync(() => findButton(h.container, "兑换").click());
    expect(h.container.querySelector(".msg-bar.err")?.textContent).toContain("兑换码已被使用");
    h.unmount();
  });

  it("网络失败（redeemCode reject）→ 兜底文案「兑换失败，请稍后再试」", async () => {
    const h = await mountCard();
    mockedRedeem.mockRejectedValueOnce({
      code: "network_error",
      message: "",
      httpStatus: null,
      retryAfterSeconds: null,
    });

    act(() => setInputValue(inputOf(h), "ABCD-EFGH-JKLM-NPQR"));
    await actAsync(() => findButton(h.container, "兑换").click());

    expect(h.container.querySelector(".msg-bar.err")?.textContent).toContain("兑换失败，请稍后再试");
    expect(findButton(h.container, "兑换").disabled).toBe(false);
    h.unmount();
  });

  it("回车等效提交（canSubmit 时）", async () => {
    const h = await mountCard();
    mockedRedeem.mockResolvedValueOnce(resp(200, "{}"));

    const input = inputOf(h);
    act(() => setInputValue(input, "ABCD-EFGH-JKLM-NPQR"));
    await actAsync(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    expect(mockedRedeem).toHaveBeenCalledTimes(1);
    h.unmount();
  });
});
