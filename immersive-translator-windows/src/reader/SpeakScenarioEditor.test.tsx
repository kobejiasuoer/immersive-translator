// @vitest-environment jsdom
// 场景编辑器（A2）组件测试：三态流转、保存全链路（speak-scenarios dirty 实体
// 字段断言）、解析/接口/取消/保存四类失败路径的原话与表单保留（验收②/硬性
// 约束4）、usedGenerate 复位、编辑路径 baseVersion 读回与整桶合并、Esc 取消。
// mock ../lib/tauriBridge（syncStoreList/syncStorePut/cancelTranslation +
// authTrackEvent——track 走真实 analytics，埋点断言落在 authTrackEvent 上）；
// scenarioForge 的解析函数用真实实现（宽容解析链路随组件一起被测到）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  listUserScenarios,
  registerUserScenarios,
  type SpeakScenario,
} from "../core/speakLogic";
import { SpeakScenarioEditor, type SpeakScenarioEditorProps } from "./SpeakScenarioEditor";
import type { StoredSyncEntity } from "../lib/tauriBridge";

// vi.hoisted：mock 工厂与测试用同一组 vi.fn 实例（scenarioCatalog.test.ts 先例）
const mocks = vi.hoisted(() => ({
  syncStoreList: vi.fn(),
  syncStorePut: vi.fn(),
  cancelTranslation: vi.fn(),
  authTrackEvent: vi.fn(),
  scenarioCacheRead: vi.fn(),
  scenarioCacheWrite: vi.fn(),
  scenarioFetchOfficial: vi.fn(),
}));

vi.mock("../lib/tauriBridge", () => mocks);

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 生成成功的完整草稿（ fenced JSON 的内容；字段全量）。 */
const DRAFT = {
  title: "合同续约谈判",
  category: "workplace",
  aiRole: "你扮演德国客户的采购经理，态度友善但想压价 10%",
  userRole: "供应商一方的销售代表",
  goal: "守住报价并争取更长合同期",
  keyPhrases: ["close the deal", "run behind schedule"],
  opener: "Good to see you again. Shall we start with the pricing?",
  openerZh: "又见面了，从价格谈起吧",
};

/** 带代码围栏的模型输出（宽容解析须剥围栏后命中最外层 JSON）。 */
function fencedDraft(): string {
  return "```json\n" + JSON.stringify(DRAFT) + "\n```";
}

/** 合法用户场景。 */
function userScenario(id: string, overrides: Partial<SpeakScenario> = {}): SpeakScenario {
  return {
    id,
    source: "user",
    title: `场景-${id}`,
    category: "custom",
    aiRole: `role-${id}`,
    opener: `opener-${id}`,
    updatedAt: 1000,
    ...overrides,
  };
}

/** 任意 vi.fn 实例（测试桩）；与真实签名做交集，渲染与断言两头都可用。 */
type AnyMock = ReturnType<typeof vi.fn>;

interface TestProps extends SpeakScenarioEditorProps {
  requestTranslate: SpeakScenarioEditorProps["requestTranslate"] & AnyMock;
  onToast: SpeakScenarioEditorProps["onToast"] & AnyMock;
  onSaved: SpeakScenarioEditorProps["onSaved"] & AnyMock;
  onClose: SpeakScenarioEditorProps["onClose"] & AnyMock;
}

function baseProps(overrides?: Partial<TestProps>): TestProps {
  const defaults = {
    requestTranslate: vi.fn(async () => ({ status: "error" as const, text: "未配置翻译接口" })),
    onToast: vi.fn(),
    onSaved: vi.fn(),
    onClose: vi.fn(),
  };
  // vi.fn 的 Mock 类型与交集签名之间的 variance 繁琐，测试桩直接断言收口
  return { ...defaults, ...overrides } as TestProps;
}

interface Mount {
  root: Root;
  container: HTMLDivElement;
  rerender(props: TestProps): void;
  unmount(): void;
}

function mountEditor(props: TestProps): Mount {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<SpeakScenarioEditor {...props} />));
  return {
    root,
    container,
    rerender: (next: TestProps) => act(() => root.render(<SpeakScenarioEditor {...next} />)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").trim();
}

function findButton(container: HTMLElement, includes: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll("button")].find((b) => textOf(b).includes(includes));
  if (!btn) throw new Error(`button not found: ${includes}`);
  return btn as HTMLButtonElement;
}

function ideaArea(m: Mount): HTMLTextAreaElement {
  const el = m.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="一句话设想"]');
  if (!el) throw new Error("idea textarea not found");
  return el;
}

function fieldInput(m: Mount, ariaLabel: string): HTMLInputElement {
  const el = m.container.querySelector<HTMLInputElement>(`input[aria-label="${ariaLabel}"]`);
  if (!el) throw new Error(`input not found: ${ariaLabel}`);
  return el;
}

function fieldTextarea(m: Mount, ariaLabel: string): HTMLTextAreaElement {
  const el = m.container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${ariaLabel}"]`);
  if (!el) throw new Error(`textarea not found: ${ariaLabel}`);
  return el;
}

/** jsdom 下改受控输入的值（原生 setter + input 事件，React 才会接收）。 */
function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 埋点里某事件的全部调用。 */
function trackCalls(event: string): unknown[][] {
  return mocks.authTrackEvent.mock.calls.filter(([e]) => e === event);
}

let mount: Mount | undefined;

beforeEach(() => {
  mocks.syncStoreList.mockReset().mockResolvedValue([]);
  mocks.syncStorePut.mockReset().mockResolvedValue(undefined);
  mocks.cancelTranslation.mockReset().mockResolvedValue(undefined);
  mocks.authTrackEvent.mockReset().mockResolvedValue(undefined);
  // 用户桶整桶清空（registerUserScenarios([]) = 全量替换为空），用例间互不串桶
  registerUserScenarios([]);
});

afterEach(() => {
  mount?.unmount();
  mount = undefined;
});

describe("手填保存全链路（验收①）", () => {
  it("跳过生成 → 填必填 → 保存落 speak-scenarios dirty 实体并立即注册、刷新、埋 via:manual", async () => {
    const props = baseProps();
    mount = mountEditor(props);
    const m = mount!;
    act(() => findButton(m.container, "跳过，手动填写").click());

    const t0 = Date.now();
    setValue(fieldInput(m, "场景名"), "面试冲刺");
    setValue(fieldTextarea(m, "AI 角色与情境设定"), "你扮演温和的面试官");
    setValue(fieldTextarea(m, "英文开场白"), "Hi, shall we begin?");
    await act(async () => findButton(m.container, "保存场景").click());

    // 新建路径不读 store（baseVersion 恒 0）
    expect(mocks.syncStoreList).not.toHaveBeenCalled();
    expect(mocks.syncStorePut).toHaveBeenCalledTimes(1);
    const [collection, entities] = mocks.syncStorePut.mock.calls[0] as [string, StoredSyncEntity[]];
    expect(collection).toBe("speak-scenarios");
    const e = entities[0];
    expect(e.id).toMatch(/^usr_[0-9a-f-]{36}$/);
    expect(e.baseVersion).toBe(0);
    expect(e.dirty).toBe(true);
    expect(e.deleted).toBe(false);
    expect(e.schemaVersion).toBe(1);
    expect(e.originDevice).toBe("windows");
    const payload = e.payload as SpeakScenario;
    expect(payload.source).toBe("user");
    expect(payload.title).toBe("面试冲刺");
    expect(payload.aiRole).toBe("你扮演温和的面试官");
    expect(payload.opener).toBe("Hi, shall we begin?");
    expect(payload.updatedAt).toBeGreaterThanOrEqual(t0);
    // 可选字段空值不落库
    expect(payload.userRole).toBeUndefined();
    expect(payload.keyPhrases).toBeUndefined();

    // 注册表立即生效（保存后「我的场景」分组可见、会话可用的根）
    expect(listUserScenarios().map((s) => s.id)).toContain(e.id);
    expect(props.onSaved).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(mocks.authTrackEvent).toHaveBeenCalledWith("scenario_create", { via: "manual" });
  });

  it("必填校验：场景名留空 → 不落库不关弹窗，saveError 指出缺失字段", async () => {
    const props = baseProps();
    mount = mountEditor(props);
    const m = mount!;
    act(() => findButton(m.container, "跳过，手动填写").click());
    setValue(fieldTextarea(m, "AI 角色与情境设定"), "你扮演面试官");
    setValue(fieldTextarea(m, "英文开场白"), "Hi.");
    act(() => findButton(m.container, "保存场景").click());

    expect(mocks.syncStorePut).not.toHaveBeenCalled();
    expect(m.container.textContent).toContain("请填写：场景名");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("保存失败（syncStorePut reject）→ 显示错误、表单内容保留、不关弹窗", async () => {
    mocks.syncStorePut.mockRejectedValue(new Error("disk full"));
    const props = baseProps();
    mount = mountEditor(props);
    const m = mount!;
    act(() => findButton(m.container, "跳过，手动填写").click());
    setValue(fieldInput(m, "场景名"), "旅行问路");
    setValue(fieldTextarea(m, "AI 角色与情境设定"), "role");
    setValue(fieldTextarea(m, "英文开场白"), "Hello.");
    await act(async () => findButton(m.container, "保存场景").click());

    expect(m.container.textContent).toContain("保存失败：disk full");
    expect(fieldInput(m, "场景名").value).toBe("旅行问路");
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe("一句话生成（验收①/②）", () => {
  it("生成成功（带代码围栏）→ 预填表单可编辑 → 保存 via:generate，埋点先 result 后 create", async () => {
    const props = baseProps({
      requestTranslate: vi.fn(async () => ({ status: "done" as const, text: fencedDraft() })),
    });
    mount = mountEditor(props);
    const m = mount!;
    setValue(ideaArea(m), "下周要跟德国客户谈合同续约，对方想压价 10%");
    await act(async () => findButton(m.container, "生成场景").click());

    // 表单出现且各输入框 = 草稿值（宽容解析剥掉了 ```json 围栏）
    expect(fieldInput(m, "场景名").value).toBe(DRAFT.title);
    expect(m.container.querySelector<HTMLSelectElement>('select[aria-label="分类"]')!.value).toBe("workplace");
    expect(fieldTextarea(m, "AI 角色与情境设定").value).toBe(DRAFT.aiRole);
    expect(fieldInput(m, "你的角色").value).toBe(DRAFT.userRole);
    expect(fieldInput(m, "练习目标").value).toBe(DRAFT.goal);
    const phraseInputs = [
      ...m.container.querySelectorAll<HTMLInputElement>('input[aria-label="目标短语"]'),
    ];
    expect(phraseInputs.map((i) => i.value)).toEqual(DRAFT.keyPhrases);
    expect(fieldTextarea(m, "英文开场白").value).toBe(DRAFT.opener);
    expect(fieldInput(m, "开场白中文提示").value).toBe(DRAFT.openerZh);

    // 生成调用参数：系统提示零用户原话（§2.4 隔离由 prompt 纯函数保证），tag 带 scngen 前缀
    const [input, systemPrompt, tag] = (props.requestTranslate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(systemPrompt).not.toContain("德国客户");
    expect(input).toContain("德国客户");
    expect(String(tag)).toMatch(/^scngen\d+$/);

    // 改动后保存：payload 是改后值；via=generate
    setValue(fieldInput(m, "场景名"), "合同续约谈判（改）");
    await act(async () => findButton(m.container, "保存场景").click());
    const [, entities] = mocks.syncStorePut.mock.calls[0] as [string, StoredSyncEntity[]];
    expect((entities[0].payload as SpeakScenario).title).toBe("合同续约谈判（改）");
    expect(mocks.authTrackEvent).toHaveBeenCalledWith("scenario_generate_result", { ok: true });
    expect(mocks.authTrackEvent).toHaveBeenCalledWith("scenario_create", { via: "generate" });
    // 先后顺序：generate_result 在 create 之前
    const events = mocks.authTrackEvent.mock.calls.map(([e]) => e);
    expect(events.indexOf("scenario_generate_result")).toBeLessThan(events.lastIndexOf("scenario_create"));
  });

  it("解析失败（纯文本回复）→ 保留原话、回 input 态、可行动错误文案，埋 ok:false+parseError", async () => {
    const props = baseProps({
      requestTranslate: vi.fn(async () => ({ status: "done" as const, text: "抱歉我不明白" })),
    });
    mount = mountEditor(props);
    const m = mount!;
    setValue(ideaArea(m), "想练机场值机对话");
    await act(async () => findButton(m.container, "生成场景").click());

    expect(ideaArea(m).value).toBe("想练机场值机对话"); // 原话保留（验收②）
    expect(m.container.querySelector('input[aria-label="场景名"]')).toBeNull(); // 未进表单态
    expect(m.container.textContent).toContain("生成结果格式异常");
    expect(mocks.authTrackEvent).toHaveBeenCalledWith("scenario_generate_result", {
      ok: false,
      parseError: "no_json",
    });
  });

  it("接口失败（status:error）→ 原话保留、错误文案含接口原因，埋 {ok:false}（无 parseError 键）", async () => {
    const props = baseProps({
      requestTranslate: vi.fn(async () => ({ status: "error" as const, text: "未配置翻译接口" })),
    });
    mount = mountEditor(props);
    const m = mount!;
    setValue(ideaArea(m), "想练酒店入住");
    await act(async () => findButton(m.container, "生成场景").click());

    expect(ideaArea(m).value).toBe("想练酒店入住");
    expect(m.container.textContent).toContain("生成失败：未配置翻译接口");
    expect(trackCalls("scenario_generate_result")).toEqual([["scenario_generate_result", { ok: false }]]);
  });

  it("取消（status:cancelled 半截 JSON）→ 原话保留、未进表单态，埋 {ok:false}", async () => {
    const props = baseProps({
      requestTranslate: vi.fn(async () => ({ status: "cancelled" as const, text: '半截{"title":' })),
    });
    mount = mountEditor(props);
    const m = mount!;
    setValue(ideaArea(m), "想练电话会议");
    await act(async () => findButton(m.container, "生成场景").click());

    expect(ideaArea(m).value).toBe("想练电话会议");
    expect(m.container.querySelector('input[aria-label="场景名"]')).toBeNull(); // 半截内容不预填
    expect(m.container.textContent).toContain("已取消");
    expect(trackCalls("scenario_generate_result")).toEqual([["scenario_generate_result", { ok: false }]]);
  });

  it("Esc 生成中取消：cancelTranslation 以当前 tag 被调，不关弹窗", async () => {
    const props = baseProps({
      requestTranslate: vi.fn(
        // 永不 resolve：组件停在 generating 态，Esc 只走取消分支
        () => new Promise<{ status: "done" | "error" | "cancelled"; text: string }>(() => undefined),
      ),
    });
    mount = mountEditor(props);
    const m = mount!;
    setValue(ideaArea(m), "想练退税窗口");
    await act(async () => findButton(m.container, "生成场景").click());
    expect(findButton(m.container, "取消生成")).toBeDefined(); // 处于 generating 态

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(mocks.cancelTranslation).toHaveBeenCalledWith("scngen1");
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe("失败路径的表单保留（硬性约束4：写入白名单）", () => {
  it("生成成功→半改表单→返回→再生成失败→手填入口：半改值仍在，未被任何路径清空", async () => {
    const props = baseProps({
      requestTranslate: vi
        .fn()
        .mockResolvedValueOnce({ status: "done" as const, text: fencedDraft() })
        .mockResolvedValueOnce({ status: "done" as const, text: "垃圾" }),
    });
    mount = mountEditor(props);
    const m = mount!;
    setValue(ideaArea(m), "想练商务晚宴");
    await act(async () => findButton(m.container, "生成场景").click()); // 第一次：成功预填
    setValue(fieldInput(m, "场景名"), "谈判改稿"); // 用户半改

    act(() => findButton(m.container, "返回重新生成").click()); // 回 input：idea/form 都保留
    expect(ideaArea(m).value).toBe("想练商务晚宴");
    await act(async () => findButton(m.container, "生成场景").click()); // 第二次：解析失败
    expect(ideaArea(m).value).toBe("想练商务晚宴");

    act(() => findButton(m.container, "跳过，手动填写").click()); // 手填入口 = 只切态不重置
    expect(fieldInput(m, "场景名").value).toBe("谈判改稿");
    expect(fieldTextarea(m, "AI 角色与情境设定").value).toBe(DRAFT.aiRole); // 其余草稿也在
  });

  it("usedGenerate 复位：生成成功→返回→手填入口→保存，via 报 manual（无粘滞误报）", async () => {
    const props = baseProps({
      requestTranslate: vi.fn(async () => ({ status: "done" as const, text: fencedDraft() })),
    });
    mount = mountEditor(props);
    const m = mount!;
    setValue(ideaArea(m), "想练机场转机");
    await act(async () => findButton(m.container, "生成场景").click());
    act(() => findButton(m.container, "返回重新生成").click());
    act(() => findButton(m.container, "跳过，手动填写").click());
    await act(async () => findButton(m.container, "保存场景").click()); // 草稿字段齐全，直接保存

    expect(mocks.syncStorePut).toHaveBeenCalledTimes(1);
    expect(mocks.authTrackEvent).toHaveBeenCalledWith("scenario_create", { via: "manual" });
  });
});

describe("编辑既有用户场景", () => {
  const A = userScenario("usr_A", { keyPhrases: ["close the deal"], emoji: "🤝" });
  const B = userScenario("usr_B");

  it("编辑保存：id 不变、baseVersion 读回不重置、整桶合并不清其它场景、不发 create", async () => {
    registerUserScenarios([A, B]);
    mocks.syncStoreList.mockResolvedValue([
      {
        id: "usr_A",
        baseVersion: 7,
        updatedAt: 1000,
        deleted: false,
        schemaVersion: 1,
        originDevice: "windows",
        payload: A,
        dirty: false,
      },
    ]);
    const props = baseProps();
    mount = mountEditor({ ...props, initial: A });
    const m = mount!;
    expect(fieldInput(m, "场景名").value).toBe(A.title); // initial 预填

    setValue(fieldInput(m, "场景名"), "场景A改");
    await act(async () => findButton(m.container, "保存场景").click());

    expect(mocks.syncStorePut).toHaveBeenCalledTimes(1);
    const [collection, entities] = mocks.syncStorePut.mock.calls[0] as [string, StoredSyncEntity[]];
    expect(collection).toBe("speak-scenarios");
    const e = entities[0];
    expect(e.id).toBe("usr_A"); // 编辑路径 id 不变
    expect(e.baseVersion).toBe(7); // 不重置为 0
    expect(e.dirty).toBe(true);
    const payload = e.payload as SpeakScenario;
    expect(payload.title).toBe("场景A改");
    expect(payload.updatedAt).toBeGreaterThan(1000);
    expect(payload.emoji).toBe("🤝"); // 规格外字段原样保留

    // 整桶合并：B 未被清掉、A 已更新
    const registered = listUserScenarios();
    expect(registered.map((s) => s.id).sort()).toEqual(["usr_A", "usr_B"]);
    expect(registered.find((s) => s.id === "usr_A")!.title).toBe("场景A改");
    expect(props.onSaved).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    // 编辑保存不发 scenario_create（语义是创建而非更新）
    expect(trackCalls("scenario_create")).toEqual([]);
  });

  it("读回失败（syncStoreList reject）→ 中止保存不落库、表单保留、错误可行动", async () => {
    mocks.syncStoreList.mockRejectedValue(new Error("ipc down"));
    const props = baseProps();
    mount = mountEditor({ ...props, initial: A });
    const m = mount!;

    await act(async () => findButton(m.container, "保存场景").click());

    expect(mocks.syncStorePut).not.toHaveBeenCalled(); // 不静默落 baseVersion 0
    expect(m.container.textContent).toContain("读取本地同步数据失败");
    expect(m.container.textContent).toContain("ipc down");
    expect(fieldInput(m, "场景名").value).toBe(A.title); // 表单仍在
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
