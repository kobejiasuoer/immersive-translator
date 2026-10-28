import { describe, expect, it, vi } from "vitest";
import { createTicketManager, type TicketFetcher, type VoiceTicketIssued } from "./voiceTicket";

/** 受控取票器:按预设序列依次返回票据/错误,记录并发峰值。 */
function controlledFetcher(behaviors: (VoiceTicketIssued | Error)[]) {
  const calls: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let cursor = 0;
  const fetcher: TicketFetcher = vi.fn(() => {
    const step = cursor;
    cursor += 1;
    calls.push(step);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<VoiceTicketIssued>((resolve, reject) => {
      setTimeout(() => {
        inFlight -= 1;
        const behavior = behaviors[step];
        if (behavior instanceof Error) {
          reject(behavior);
          return;
        }
        resolve(behavior ?? { ticket: `t${step + 1}`, expiresAtMs: 0 });
      }, 5);
    });
  });
  return { fetcher, maxInFlight: () => maxInFlight };
}

function ticket(ticketStr: string): VoiceTicketIssued {
  return { ticket: ticketStr, expiresAtMs: 0 };
}

describe("createTicketManager(契约 §一:现调现用 + 单飞,绝不缓存复用)", () => {
  it("并发 acquire:至多一张票请求在途(单飞排队),各调用方拿到各自的新票", async () => {
    const { fetcher, maxInFlight } = controlledFetcher([ticket("t1"), ticket("t2"), ticket("t3")]);
    const manager = createTicketManager(fetcher);
    const [a, b, c] = await Promise.all([manager.acquire(), manager.acquire(), manager.acquire()]);
    // 不复用:一张票只发给一个建连方
    expect(new Set([a, b, c]).size).toBe(3);
    expect(maxInFlight()).toBe(1);
  });

  it("串行 acquire:每次都是新票,绝不缓存复用", async () => {
    const { fetcher, maxInFlight } = controlledFetcher([ticket("a"), ticket("b")]);
    const manager = createTicketManager(fetcher);
    const first = await manager.acquire();
    const second = await manager.acquire();
    expect(first).toBe("a");
    expect(second).toBe("b");
    expect(second).not.toBe(first);
    expect(maxInFlight()).toBe(1);
  });

  it("失败不毒化队列:前一次 reject,下一次照常取到新票", async () => {
    const { fetcher } = controlledFetcher([new Error("network down"), ticket("next")]);
    const manager = createTicketManager(fetcher);
    await expect(manager.acquire()).rejects.toThrow("network down");
    await expect(manager.acquire()).resolves.toBe("next");
  });

  it("并发混合成功失败:每个调用方各得结果,底层仍不并发", async () => {
    const { fetcher, maxInFlight } = controlledFetcher([
      new Error("rate_limited"),
      ticket("ok-1"),
      new Error("rate_limited"),
    ]);
    const manager = createTicketManager(fetcher);
    const results = await Promise.allSettled([
      manager.acquire(),
      manager.acquire(),
      manager.acquire(),
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "rejected"]);
    expect((results[1] as PromiseFulfilledResult<string>).value).toBe("ok-1");
    expect(maxInFlight()).toBe(1);
  });
});
