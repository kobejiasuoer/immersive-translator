// @vitest-environment jsdom
// 关于页隐私政策卡：默认收起、展开全文、六节完整、再点收起。
import { describe, expect, it } from "vitest";
import { PrivacyPolicyCard } from "./PrivacyPolicyCard";
import { PRIVACY_SECTIONS } from "./privacyPolicy";
import { actAsync, createHarness, findButton } from "./authTestHarness";

describe("PrivacyPolicyCard", () => {
  it("默认收起：只有摘要，不含正文", async () => {
    const h = createHarness();
    h.render(<PrivacyPolicyCard />);
    expect(h.container.querySelector(".about-privacy h3")?.textContent).toBe("隐私政策");
    expect(h.container.querySelector(".about-privacy-body")).toBeNull();
    expect(findButton(h.container, "查看完整政策")).toBeTruthy();
    h.unmount();
  });

  it("展开：六节正文 + 联系方式都在，按钮变「收起」", async () => {
    const h = createHarness();
    h.render(<PrivacyPolicyCard />);
    await actAsync(() => findButton(h.container, "查看完整政策").click());
    const body = h.container.querySelector(".about-privacy-body");
    expect(body).toBeTruthy();
    for (const s of PRIVACY_SECTIONS) {
      expect(body!.textContent).toContain(s.title);
      expect(body!.textContent).toContain(s.body.slice(0, 20));
    }
    expect(body!.textContent).toContain("github.com/kobejiasuoer/immersive-translator/issues");
    expect(findButton(h.container, "收起")).toBeTruthy();
    h.unmount();
  });

  it("再点收起：正文移除", async () => {
    const h = createHarness();
    h.render(<PrivacyPolicyCard />);
    await actAsync(() => findButton(h.container, "查看完整政策").click());
    expect(h.container.querySelector(".about-privacy-body")).toBeTruthy();
    await actAsync(() => findButton(h.container, "收起").click());
    expect(h.container.querySelector(".about-privacy-body")).toBeNull();
    h.unmount();
  });
});
