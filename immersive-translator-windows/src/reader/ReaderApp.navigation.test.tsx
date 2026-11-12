// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderApp } from "./ReaderApp";
import { DEFAULT_SETTINGS } from "../lib/settingsStore";
import { DEFAULT_READER_SETTINGS, type Article, type ArticleSummary, type BookMeta } from "../core/readerTypes";
import { initialSrs } from "../core/readerSrs";
import { actAsync, createHarness, findButton, setInputValue, type Harness } from "../views/authTestHarness";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  listenerGroups: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  pendingSettingsTab: null as string | null,
  hide: vi.fn(() => Promise.resolve()),
  speak: vi.fn(() => Promise.resolve(1)),
  gatewayConfig: null as (() => { voice?: string; rate: number }) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (event: { payload: unknown }) => void) => {
    let handlers = mocks.listenerGroups.get(event);
    if (!handlers) {
      handlers = new Set();
      mocks.listenerGroups.set(event, handlers);
      mocks.listeners.set(event, (payload) => {
        for (const listener of [...(mocks.listenerGroups.get(event) ?? [])]) listener(payload);
      });
    }
    handlers.add(handler);
    return Promise.resolve(() => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        mocks.listenerGroups.delete(event);
        mocks.listeners.delete(event);
      }
    });
  },
  emit: (event: string, payload: unknown) => {
    mocks.listeners.get(event)?.({ payload });
    return Promise.resolve();
  },
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.11.1") }));
vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: () => Promise.resolve(false),
  enable: () => Promise.resolve(),
  disable: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "reader",
    onCloseRequested: () => Promise.resolve(() => undefined),
    hide: mocks.hide,
  }),
}));
vi.mock("../lib/learningRelay", () => ({
  syncLearningRecordsSilently: () => Promise.resolve([]),
}));
// 保留真实播放游标/复位逻辑，只替换音频输出基础设施。
vi.mock("./speechEngine", () => {
  const engine = {
    speak: mocks.speak,
    stopTrack: () => Promise.resolve(),
    onEnded: () => () => undefined,
    prefetch: () => undefined,
  };
  return {
    createSapiEngine: () => engine,
    createXfyunEngine: () => engine,
    createEdgeEngine: () => engine,
    createGatewayEngine: (getConfig: () => { voice?: string; rate: number }) => {
      mocks.gatewayConfig = getConfig;
      return engine;
    },
    createSpeechDispatcher: () => engine,
  };
});

const CHAPTER: Article = {
  id: "classic-chapter-2",
  bookId: "classic-short-stories",
  chapterIdx: 1,
  title: "The Lantern on the Hill",
  titleCn: "山上的灯笼",
  titleCnState: "done",
  sourceType: "epub",
  wordCount: 80,
  createdAt: 1,
  lastReadAt: 2,
  progress: { sentenceIdx: 2, percent: 50, secondsListened: 60 },
  chunkState: "done",
  sentences: [
    { idx: 0, paragraphIdx: 0, en: "The village was quiet after sunset.", zh: "日落后村庄很安静。", zhState: "done" },
    { idx: 1, paragraphIdx: 0, en: "A lantern shone on the distant hill.", zh: "远处山上亮着一盏灯笼。", zhState: "done" },
    { idx: 2, paragraphIdx: 1, en: "Mara decided to follow the narrow path.", zh: "玛拉决定沿着窄路走。", zhState: "done" },
    { idx: 3, paragraphIdx: 1, en: "She carried a letter in her coat pocket.", zh: "她的外套口袋里有一封信。", zhState: "done" },
    { idx: 4, paragraphIdx: 2, en: "At the gate, a familiar voice called her name.", zh: "门口一个熟悉的声音叫了她的名字。", zhState: "done" },
  ],
};

const BOOK: BookMeta = {
  id: "classic-short-stories",
  title: "Classic Short Stories",
  author: "Various Authors",
  createdAt: 1,
  lastReadAt: 2,
  chapters: [
    { id: "classic-chapter-1", title: "The Winter Garden", wordCount: 80, sentenceCount: 5 },
    { id: CHAPTER.id, title: CHAPTER.title, wordCount: CHAPTER.wordCount, sentenceCount: CHAPTER.sentences.length },
  ],
  progress: { chapterId: CHAPTER.id, sentenceIdx: 2, percent: 50 },
  secondsListened: 60,
  radar: { kaoyan: 0, cet4: 0, cet6: 0 },
};

let harness: Harness | null;
let chapterResult: Article | null;
let chapterError: Error | null;
let booksResult: BookMeta[];
let scrollToDescriptor: PropertyDescriptor | undefined;
let showModalDescriptor: PropertyDescriptor | undefined;
let closeDialogDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.listenerGroups.clear();
  mocks.pendingSettingsTab = null;
  mocks.gatewayConfig = null;
  localStorage.clear();
  localStorage.setItem("immersive-translator-settings", JSON.stringify({
    ...DEFAULT_SETTINGS,
    endpoint: "http://localhost:8080/v1/chat/completions",
    model: "local-test-model",
  }));
  localStorage.setItem("immersive-translator-reader-settings", JSON.stringify(DEFAULT_READER_SETTINGS));
  scrollToDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    value: () => undefined,
  });
  showModalDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
  closeDialogDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) { this.setAttribute("open", ""); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) { this.removeAttribute("open"); },
  });
  harness = null;
  chapterResult = structuredClone(CHAPTER);
  chapterError = null;
  booksResult = [structuredClone(BOOK)];
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "reader_list_books": return structuredClone(booksResult);
      case "reader_list_articles": return [];
      case "reader_get_article":
        if (chapterError) throw chapterError;
        return args?.id === CHAPTER.id ? chapterResult : null;
      case "reader_get_vocab": return { words: [], reviewLog: { schemaVersion: 1, days: [] } };
      case "note_list":
      case "speak_list_sessions": return [];
      case "reader_read_seconds_today": return 0;
      case "reminder_get_config": return {
        enabled: true, minuteOfDay: 1200, dndEnabled: true, dndStartMin: 1380,
        dndEndMin: 480, readGoalMin: 10, lastShownDay: "",
      };
      case "tts_voices": return [];
      case "ocr_models_ready": return true;
      case "is_store_packaged": return false;
      case "get_active_hotkeys": return [DEFAULT_SETTINGS.hotkey, DEFAULT_SETTINGS.ocrHotkey, DEFAULT_SETTINGS.readerHotkey];
      case "settings_take_pending_tab": {
        const tab = mocks.pendingSettingsTab;
        mocks.pendingSettingsTab = null;
        return tab;
      }
      case "reader_save_article": {
        const saved = structuredClone(args?.article as Article);
        const { sentences, ...summary } = saved;
        return { ...summary, sentenceCount: sentences.length };
      }
      case "reader_save_book_meta": return undefined;
      case "auth_get_status": return { loggedIn: false, user: null, notice: null };
      case "auth_server_base_url":
      case "take_pending_reader_import":
      case "take_pending_open_book": return null;
      case "secret_get": return "";
      case "secret_set": return undefined;
      case "open_login_window": return undefined;
      case "tray_refresh_badge":
      case "telemetry_log_event":
      case "auth_track_event": return undefined;
      default: throw new Error(`Unexpected IPC command: ${command}`);
    }
  });
});

afterEach(() => {
  harness?.unmount();
  harness = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (scrollToDescriptor) Object.defineProperty(Element.prototype, "scrollTo", scrollToDescriptor);
  else Reflect.deleteProperty(Element.prototype, "scrollTo");
  if (showModalDescriptor) Object.defineProperty(HTMLDialogElement.prototype, "showModal", showModalDescriptor);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (closeDialogDescriptor) Object.defineProperty(HTMLDialogElement.prototype, "close", closeDialogDescriptor);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  document.getElementById("reader-webfonts")?.remove();
});

async function mount(): Promise<Harness> {
  harness = createHarness();
  harness.render(<ReaderApp />);
  await actAsync(() => undefined);
  expect(harness.container.querySelector(".shelf-page")).not.toBeNull();
  return harness;
}

async function continueReading(h: Harness): Promise<void> {
  await actAsync(() => findButton(h.container, "继续读 · 第 2 章第 3 句").click());
}

function deferInitialBooks(currentBooks: BookMeta[] = []) {
  const defaultInvoke = mocks.invoke.getMockImplementation()!;
  let finish!: (books: BookMeta[]) => void;
  const initialBooks = new Promise<BookMeta[]>((resolve) => {
    finish = resolve;
  });
  let readCount = 0;
  mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (command === "reader_list_books") {
      readCount += 1;
      return readCount === 1 ? initialBooks : Promise.resolve(structuredClone(currentBooks));
    }
    return defaultInvoke(command, args);
  });
  return { finish: (books: BookMeta[]) => finish(books), reads: () => readCount };
}

describe("ReaderApp 书架阅读导航", () => {
  it("启动读取期间显示加载状态，不把尚未返回的数据当作空书架或零到期词", async () => {
    const initial = deferInitialBooks();
    const h = await mount();
    expect(h.container.querySelector('.shelf-page [role="status"]')?.textContent).toContain("正在读取");
    expect(h.container.textContent).not.toContain("还没有书");
    expect(h.container.textContent).not.toContain("今天没有到期生词");
    expect(h.container.querySelector('.shelf-page [role="tablist"]')).toBeNull();
    // 书索引 IPC 未返回时，独立的生词读取已经发起，避免启动串行等待。
    expect(mocks.invoke).toHaveBeenCalledWith("reader_get_vocab");

    await actAsync(() => initial.finish([structuredClone(BOOK)]));
    expect(h.container.querySelector('.shelf-page [role="status"]')).toBeNull();
    expect(h.container.querySelector(".shelf-bookcard h3")?.textContent).toBe(BOOK.title);
  });

  it("启动读取失败显示可见错误，不把读失败解释为没有书", async () => {
    const defaultInvoke = mocks.invoke.getMockImplementation()!;
    let failed = true;
    mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (failed && command === "reader_list_books") return Promise.reject(new Error("book index unavailable"));
      return defaultInvoke(command, args);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await mount();
    expect(h.container.querySelector('.shelf-page [role="alert"]')?.textContent).toContain("读取失败");
    expect(h.container.textContent).not.toContain("还没有书");
    expect(h.container.textContent).not.toContain("今天没有到期生词");
    failed = false;
    await actAsync(() => findButton(h.container, "重新读取").click());
    expect(h.container.querySelector('.shelf-page [role="alert"]')).toBeNull();
    expect(h.container.querySelector(".shelf-bookcard h3")?.textContent).toBe(BOOK.title);
  });

  it("账号身份已确认但语音凭据探测尚未完成时，也开始读取本地书架与生词", async () => {
    const defaultInvoke = mocks.invoke.getMockImplementation()!;
    let finishCredentials!: (secret: string) => void;
    const credentials = new Promise<string>((resolve) => { finishCredentials = resolve; });
    mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "secret_get") return credentials;
      return defaultInvoke(command, args);
    });
    const h = await mount();
    expect(mocks.invoke).toHaveBeenCalledWith("reader_list_articles");
    expect(mocks.invoke).toHaveBeenCalledWith("reader_list_books");
    expect(mocks.invoke).toHaveBeenCalledWith("reader_get_vocab");
    expect(h.container.querySelector('.shelf-page [role="status"]')).not.toBeNull();
    await actAsync(() => finishCredentials(""));
    expect(h.container.querySelector(".shelf-bookcard h3")?.textContent).toBe(BOOK.title);
  });

  it("启动先确认账号学习空间，再读取该账号书架，不能提前读取默认访客空间", async () => {
    const defaultInvoke = mocks.invoke.getMockImplementation()!;
    const status = { loggedIn: true, user: { id: "reader-account-1" }, notice: null };
    let finishIdentity!: (value: typeof status) => void;
    let identityReady = false;
    const identity = new Promise<typeof status>((resolve) => { finishIdentity = resolve; });
    mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "auth_get_status") return identity;
      // 模拟后端 auth_get_status 完成前默认 guest，完成后切换至该账号的数据空间。
      if (command === "reader_list_books" && !identityReady) return Promise.resolve([]);
      return defaultInvoke(command, args);
    });
    const h = await mount();
    expect(h.container.querySelector('.shelf-page [role="status"]')).not.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("reader_list_articles");
    expect(mocks.invoke).not.toHaveBeenCalledWith("reader_list_books");
    expect(mocks.invoke).not.toHaveBeenCalledWith("reader_get_vocab");

    await actAsync(() => { identityReady = true; finishIdentity(status); });
    expect(h.container.querySelector('.shelf-page [role="status"]')).toBeNull();
    expect(h.container.querySelector(".shelf-bookcard h3")?.textContent).toBe(BOOK.title);
  });

  it("切换账号后，旧身份初始化的晚到失败不能覆盖当前账号的成功读取", async () => {
    const defaultInvoke = mocks.invoke.getMockImplementation()!;
    let failIdentity!: (error: Error) => void;
    const initialIdentity = new Promise<unknown>((_resolve, reject) => { failIdentity = reject; });
    let authReads = 0;
    mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "auth_get_status" && ++authReads === 1) return initialIdentity;
      return defaultInvoke(command, args);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await mount();
    await actAsync(() => {
      mocks.listeners.get("auth-state-changed")?.({ payload: { loggedIn: true, user: { id: "reader-account-2" }, notice: null } });
    });
    await actAsync(() => failIdentity(new Error("old identity unavailable")));
    expect(h.container.querySelector('.shelf-page [role="alert"]')).toBeNull();
    expect(h.container.querySelector(".shelf-bookcard h3")?.textContent).toBe(BOOK.title);
  });

  it("身份初始化失败后重新读取仍先确认账号，等待期间不能读取访客书架", async () => {
    const defaultInvoke = mocks.invoke.getMockImplementation()!;
    let authReads = 0;
    mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "auth_get_status" && ++authReads === 1) return Promise.reject(new Error("identity unavailable"));
      return defaultInvoke(command, args);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await mount();
    expect(h.container.querySelector('.shelf-page [role="alert"]')).not.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("reader_list_books");

    const status = { loggedIn: true, user: { id: "reader-account-1" }, notice: null };
    let finishIdentity!: (value: typeof status) => void;
    let identityReady = false;
    const identity = new Promise<typeof status>((resolve) => { finishIdentity = resolve; });
    mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "auth_get_status") return identity;
      if (command === "reader_list_books" && !identityReady) return Promise.resolve([]);
      return defaultInvoke(command, args);
    });
    await actAsync(() => findButton(h.container, "重新读取").click());
    expect(h.container.querySelector('.shelf-page [role="status"]')).not.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("reader_list_articles");
    expect(mocks.invoke).not.toHaveBeenCalledWith("reader_list_books");
    expect(mocks.invoke).not.toHaveBeenCalledWith("reader_get_vocab");
    await actAsync(() => { identityReady = true; finishIdentity(status); });
    expect(h.container.querySelector(".shelf-bookcard h3")?.textContent).toBe(BOOK.title);
  });

  it("真实书卡继续读打开断点章，并在真实阅读页定位到第三句", async () => {
    const h = await mount();
    await continueReading(h);
    expect(mocks.invoke).toHaveBeenCalledWith("reader_get_article", { id: CHAPTER.id });
    expect(h.container.querySelector(".shelf-page")).toBeNull();
    const reading = h.container.querySelector(".reading-spread");
    expect(reading).not.toBeNull();
    expect(reading?.textContent).toContain(CHAPTER.title);
    expect(reading?.querySelector('.prose-sentence.is-current[data-idx="2"]')?.textContent).toContain(CHAPTER.sentences[2].en);
  });

  it("章节正文缺失时刷新书架、移除过期书卡并显示原因，不进入空阅读页", async () => {
    chapterResult = null;
    const h = await mount();
    booksResult = [];
    await continueReading(h);
    expect(mocks.invoke).toHaveBeenCalledWith("reader_get_article", { id: CHAPTER.id });
    expect(h.container.querySelector(".shelf-page")).not.toBeNull();
    expect(h.container.querySelector(".shelf-bookcard")).toBeNull();
    expect(h.container.querySelector(".reading-spread")).toBeNull();
    expect(h.container.textContent).toContain("当前学习空间找不到这篇内容");
  });

  it("读取章节异常时显示可见失败提示", async () => {
    chapterError = new Error("failed to read book chapters");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await mount();
    await continueReading(h);
    expect(h.container.querySelector(".shelf-page")).not.toBeNull();
    expect(h.container.textContent).toContain("打开文章失败");
  });

  it("同步刷新完成后，迟到的初始化响应不能把已删除的书放回书架", async () => {
    const initial = deferInitialBooks();
    const h = await mount();
    expect(initial.reads()).toBe(1);
    await actAsync(() => {
      window.dispatchEvent(new CustomEvent("learning-sync-complete"));
    });
    expect(initial.reads()).toBe(2);
    expect(h.container.querySelector(".shelf-bookcard")).toBeNull();

    await actAsync(() => initial.finish([structuredClone(BOOK)]));
    expect(h.container.querySelector(".shelf-bookcard")).toBeNull();
    expect(h.container.textContent).not.toContain(BOOK.title);
  });

  it("切换账号后，迟到的旧账号初始化响应不能覆盖当前账号的空书架", async () => {
    const initial = deferInitialBooks();
    const h = await mount();
    const authChanged = mocks.listeners.get("auth-state-changed");
    expect(authChanged).toBeDefined();
    await actAsync(() => {
      authChanged?.({ payload: { loggedIn: true, user: { id: "reader-account-2" }, notice: null } });
    });
    expect(initial.reads()).toBe(2);
    expect(h.container.querySelector(".shelf-bookcard")).toBeNull();

    await actAsync(() => initial.finish([structuredClone(BOOK)]));
    expect(h.container.querySelector(".shelf-bookcard")).toBeNull();
    expect(h.container.textContent).not.toContain(BOOK.title);
  });

  it("切换账号后，迟到的旧账号到期词不能覆盖当前账号的复习统计", async () => {
    const defaultInvoke = mocks.invoke.getMockImplementation()!;
    const oldVocab = {
      words: [{ id: "lantern", word: "lantern", senses: [{ pos: "n.", cn: "灯笼" }], source: { articleId: CHAPTER.id, sentenceIdx: 1 }, srs: initialSrs(1), addedAt: 1 }],
      reviewLog: { schemaVersion: 1, days: [] },
    };
    let finishVocab!: (vocab: typeof oldVocab) => void;
    const pendingVocab = new Promise<typeof oldVocab>((resolve) => { finishVocab = resolve; });
    let vocabReads = 0;
    mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "reader_get_vocab" && ++vocabReads === 1) return pendingVocab;
      return defaultInvoke(command, args);
    });
    const h = await mount();
    expect(h.container.querySelector('.shelf-page [role="status"]')).not.toBeNull();
    await actAsync(() => {
      mocks.listeners.get("auth-state-changed")?.({ payload: { loggedIn: true, user: { id: "reader-account-2" }, notice: null } });
    });
    expect(h.container.querySelector(".shelf-statcard")?.textContent).toContain("今天没有到期生词");

    await actAsync(() => finishVocab(oldVocab));
    expect(h.container.querySelector(".shelf-statcard")?.textContent).toContain("今天没有到期生词");
    expect(h.container.querySelector(".shelf-statcard")?.textContent).not.toContain("1 张到期");
  });

  it("当前账号书架已完成读取时，旧账号晚到的失败不能改成错误页", async () => {
    const defaultInvoke = mocks.invoke.getMockImplementation()!;
    let failInitialBooks!: (error: Error) => void;
    const initialBooks = new Promise<BookMeta[]>((_resolve, reject) => { failInitialBooks = reject; });
    let bookReads = 0;
    mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "reader_list_books" && ++bookReads === 1) return initialBooks;
      return defaultInvoke(command, args);
    });
    const h = await mount();
    await actAsync(() => {
      mocks.listeners.get("auth-state-changed")?.({ payload: { loggedIn: true, user: { id: "reader-account-2" }, notice: null } });
    });
    expect(h.container.querySelector(".shelf-bookcard h3")?.textContent).toBe(BOOK.title);
    await actAsync(() => failInitialBooks(new Error("old account index unavailable")));
    expect(h.container.querySelector('.shelf-page [role="alert"]')).toBeNull();
    expect(h.container.querySelector(".shelf-bookcard h3")?.textContent).toBe(BOOK.title);
  });

  it("章节读取期间切换账号，迟到的旧账号正文不能再进入阅读页", async () => {
    const h = await mount();
    const defaultInvoke = mocks.invoke.getMockImplementation()!;
    let finishChapter!: (article: Article) => void;
    const pendingChapter = new Promise<Article>((resolve) => {
      finishChapter = resolve;
    });
    mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "reader_get_article") return pendingChapter;
      return defaultInvoke(command, args);
    });
    await continueReading(h);
    expect(mocks.invoke).toHaveBeenCalledWith("reader_get_article", { id: CHAPTER.id });
    booksResult = [];
    await actAsync(() => {
      mocks.listeners.get("auth-state-changed")?.({
        payload: { loggedIn: true, user: { id: "reader-account-2" }, notice: null },
      });
    });
    expect(h.container.querySelector(".shelf-bookcard")).toBeNull();

    await actAsync(() => finishChapter(structuredClone(CHAPTER)));
    expect(h.container.querySelector(".shelf-page")).not.toBeNull();
    expect(h.container.querySelector(".reading-spread")).toBeNull();
    expect(h.container.textContent).not.toContain(CHAPTER.title);
    expect(mocks.invoke).not.toHaveBeenCalledWith("telemetry_log_event", expect.objectContaining({ name: "book_open" }));
  });

  it("文章新增事件读取列表时换账号，迟到的旧列表不能触发旧文章读取或导航", async () => {
    const h = await mount();
    const defaultInvoke = mocks.invoke.getMockImplementation()!;
    let finishArticles!: (articles: ArticleSummary[]) => void;
    const oldArticles = new Promise<ArticleSummary[]>((resolve) => {
      finishArticles = resolve;
    });
    let articleReads = 0;
    mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "reader_list_articles") {
        articleReads += 1;
        return articleReads === 1 ? oldArticles : Promise.resolve([]);
      }
      return defaultInvoke(command, args);
    });
    const articleAdded = mocks.listeners.get("reader:article-added");
    expect(articleAdded).toBeDefined();
    await actAsync(() => articleAdded?.({ payload: null }));
    expect(articleReads).toBe(1);
    booksResult = [];
    await actAsync(() => {
      mocks.listeners.get("auth-state-changed")?.({
        payload: { loggedIn: true, user: { id: "reader-account-2" }, notice: null },
      });
    });
    expect(articleReads).toBe(2);

    const { sentences, ...summary } = CHAPTER;
    await actAsync(() => finishArticles([{ ...summary, sentenceCount: sentences.length }]));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "reader_get_article")).toHaveLength(0);
    expect(h.container.querySelector(".shelf-page")).not.toBeNull();
    expect(h.container.querySelector(".reading-spread")).toBeNull();
    expect(h.container.textContent).not.toContain(CHAPTER.title);
  });

  it("同步时笔记读取失败仍提交成功书架，迟到的初始化旧书不能覆盖它", async () => {
    const currentBook: BookMeta = {
      ...BOOK,
      id: "current-short-stories",
      title: "Current Short Stories",
      chapters: [{ id: "current-story", title: "A Current Story", wordCount: 40, sentenceCount: 2 }],
      progress: { chapterId: "current-story", sentenceIdx: 0, percent: 0 },
    };
    const initial = deferInitialBooks([currentBook]);
    const invokeWithBooks = mocks.invoke.getMockImplementation()!;
    const noteError = new Error("note list unavailable");
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "note_list") return Promise.reject(noteError);
      return invokeWithBooks(command, args);
    });
    const h = await mount();
    await actAsync(() => {
      window.dispatchEvent(new CustomEvent("learning-sync-complete"));
    });
    expect(initial.reads()).toBe(2);
    expect(h.container.querySelector(".shelf-bookcard h3")?.textContent).toBe(currentBook.title);
    expect(logError).toHaveBeenCalledWith("[reader] relay refresh failed", noteError);

    await actAsync(() => initial.finish([structuredClone(BOOK)]));
    expect(h.container.querySelector(".shelf-bookcard h3")?.textContent).toBe(currentBook.title);
    expect(h.container.textContent).not.toContain(BOOK.title);
  });
});

describe("ReaderApp 书架首访账号提示条（2026-11-12）", () => {
  it("游客态首次进书架显示提示条，「登录」走现有登录窗", async () => {
    const h = await mount();
    const tip = h.container.querySelector(".shelf-acct-tip");
    expect(tip).not.toBeNull();
    expect(tip?.getAttribute("role")).toBe("note");
    expect(tip?.textContent).toContain("生词和阅读进度目前只保存在这台电脑上");
    // 提示条作用域内找「登录」按钮（顶栏账号触发器同名为「登录」，避免误命中）
    const loginBtn = Array.from(tip!.querySelectorAll<HTMLButtonElement>("button"))
      .find((b) => b.textContent?.trim() === "登录")!;
    await actAsync(() => loginBtn.click());
    expect(mocks.invoke).toHaveBeenCalledWith("open_login_window");
  });

  it("点「不再提示」写 localStorage 并立即消失，重挂载不再出现", async () => {
    const h = await mount();
    expect(h.container.querySelector(".shelf-acct-tip")).not.toBeNull();
    await actAsync(() => h.container.querySelector<HTMLButtonElement>(".shelf-acct-tip-close")!.click());
    expect(localStorage.getItem("reader-acct-tip-dismissed")).toBe("1");
    expect(h.container.querySelector(".shelf-acct-tip")).toBeNull();

    // 模拟重启：同一 localStorage 下重挂载不复活
    h.unmount();
    const h2 = await mount();
    expect(h2.container.querySelector(".shelf-acct-tip")).toBeNull();
  });

  it("登录态下不显示提示条", async () => {
    const defaultInvoke = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "auth_get_status") {
        return Promise.resolve({
          loggedIn: true,
          user: { id: "acct-1", email: "a@b.c", nickname: null, plan: "FREE", createdAt: "1" },
          notice: null,
        });
      }
      return defaultInvoke(command, args);
    });
    const h = await mount();
    expect(h.container.querySelector(".shelf-acct-tip")).toBeNull();
  });

  it("登录已失效（notice 非空）不显示提示条（失效说明在账号菜单头部）", async () => {
    const defaultInvoke = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "auth_get_status") {
        return Promise.resolve({ loggedIn: false, user: null, notice: "session_expired" });
      }
      return defaultInvoke(command, args);
    });
    const h = await mount();
    expect(h.container.querySelector(".shelf-acct-tip")).toBeNull();
  });

  it("已永久关闭（localStorage 置 1）后游客态也不显示", async () => {
    localStorage.setItem("reader-acct-tip-dismissed", "1");
    const h = await mount();
    expect(h.container.querySelector(".shelf-acct-tip")).toBeNull();
  });
});

describe("ReaderApp 统一设置", () => {
  async function openSettings(h: Harness): Promise<HTMLDialogElement> {
    await actAsync(() => h.container.querySelector<HTMLButtonElement>('.shell-tools [aria-label="设置"]')!.click());
    const dialog = h.container.querySelector<HTMLDialogElement>(".reader-settings-dialog")!;
    expect(dialog.open).toBe(true);
    return dialog;
  }

  async function selectTab(dialog: HTMLDialogElement, label: string): Promise<void> {
    await actAsync(() => findButton(dialog.querySelector<HTMLElement>('[aria-label="设置分类"]')!, label).click());
  }

  it.each(["成功", "失败"])("语音迁移探测%s前不允许改写阅读默认，其他设置分类仍可用", async (result) => {
    const persisted = { ...DEFAULT_READER_SETTINGS, fontSize: 22, theme: "dark", rate: 1.3 };
    localStorage.setItem("immersive-translator-reader-settings", JSON.stringify(persisted));
    const defaultInvoke = mocks.invoke.getMockImplementation()!;
    let finishCredentials!: (value: string) => void;
    let failCredentials!: (error: Error) => void;
    const credentials = new Promise<string>((resolve, reject) => {
      finishCredentials = resolve;
      failCredentials = reject;
    });
    mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "secret_get" && args?.name) return credentials;
      return defaultInvoke(command, args);
    });
    mocks.pendingSettingsTab = "reading";

    const h = await mount();
    const dialog = h.container.querySelector<HTMLDialogElement>(".reader-settings-dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain("正在读取阅读设置…");
    expect(dialog.querySelector('[aria-label="增大字号"]')).toBeNull();
    expect(dialog.textContent).not.toContain("恢复阅读默认");
    expect(JSON.parse(localStorage.getItem("immersive-translator-reader-settings")!)).toEqual(persisted);

    await selectTab(dialog, "模型服务");
    expect(dialog.querySelector('input[list="model-suggestions"]')).not.toBeNull();
    await selectTab(dialog, "账号");
    expect(dialog.querySelector('.set-nav-item[aria-current="page"]')?.textContent).toBe("账号");
    await selectTab(dialog, "阅读与练习");
    expect(dialog.querySelector('[aria-label="增大字号"]')).toBeNull();

    await actAsync(() => {
      if (result === "成功") finishCredentials("");
      else failCredentials(new Error("voice credentials unavailable"));
    });
    expect(dialog.textContent).not.toContain("正在读取阅读设置…");
    expect(dialog.textContent).toContain("恢复阅读默认");
    expect(JSON.parse(localStorage.getItem("immersive-translator-reader-settings")!)).toEqual(persisted);
    await actAsync(() => dialog.querySelector<HTMLButtonElement>('[aria-label="增大字号"]')!.click());
    expect(JSON.parse(localStorage.getItem("immersive-translator-reader-settings")!)).toEqual({ ...persisted, fontSize: 23 });
  });

  it("顶部只留一个设置入口，阅读、模型和语音在同一界面切换", async () => {
    const h = await mount();
    expect(h.container.querySelectorAll('.shell-tools [aria-label="设置"]')).toHaveLength(1);
    const dialog = await openSettings(h);
    expect(h.container.querySelectorAll("dialog")).toHaveLength(1);
    expect(h.container.querySelector(".reader-drawer, .reader-drawer-overlay")).toBeNull();
    expect(dialog.querySelector(".reader-settings-content")).not.toBeNull();
    await actAsync(() => dialog.querySelector<HTMLButtonElement>('[aria-label="增大字号"]')!.click());
    expect(JSON.parse(localStorage.getItem("immersive-translator-reader-settings")!).fontSize).toBe(20);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "reader_save_article")).toBe(false);

    await selectTab(dialog, "模型服务");
    expect(dialog.querySelector('input[list="model-suggestions"]')).not.toBeNull();
    await selectTab(dialog, "语音");
    expect(dialog.querySelector('[aria-label="语音服务商"]')).not.toBeNull();
    await selectTab(dialog, "阅读与练习");
    expect(dialog.querySelector(".reader-settings-content")).not.toBeNull();
    expect(h.container.querySelector(".reader-settings-dialog")).toBe(dialog);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "settings_open_tab" || command === "open_settings")).toBe(false);
  });

  it("关闭再打开仍保留模型草稿，关闭设置不隐藏阅读室", async () => {
    const h = await mount();
    const dialog = await openSettings(h);
    await selectTab(dialog, "模型服务");
    await actAsync(() => setInputValue(dialog.querySelector<HTMLInputElement>('input[list="model-suggestions"]')!, "unsaved-model"));
    expect(JSON.parse(localStorage.getItem("immersive-translator-settings")!).model).toBe("local-test-model");
    await actAsync(() => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click());
    expect(dialog.open).toBe(false);
    expect(mocks.hide).not.toHaveBeenCalled();
    expect(h.container.querySelector(".shelf-page")).not.toBeNull();

    const reopened = await openSettings(h);
    expect(reopened).toBe(dialog);
    await selectTab(reopened, "模型服务");
    expect(reopened.querySelector<HTMLInputElement>('input[list="model-suggestions"]')!.value).toBe("unsaved-model");
  });

  it("挂载与外部通知均消费 pending 分类，已消费通知不能重新弹出设置", async () => {
    mocks.pendingSettingsTab = "voice";
    const h = await mount();
    const dialog = h.container.querySelector<HTMLDialogElement>(".reader-settings-dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector('.set-nav-item[aria-current="page"]')?.textContent).toBe("语音");
    expect(mocks.pendingSettingsTab).toBeNull();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "settings_take_pending_tab")).toHaveLength(1);

    mocks.pendingSettingsTab = "hotkeys";
    await actAsync(() => mocks.listeners.get("settings:navigate-tab")?.({ payload: "provider" }));
    expect(dialog.querySelector('.set-nav-item[aria-current="page"]')?.textContent).toBe("快捷键");
    expect(dialog.querySelector("#hotkey-reader")).not.toBeNull();
    expect(mocks.pendingSettingsTab).toBeNull();
    expect(h.container.querySelectorAll("dialog")).toHaveLength(1);
    await actAsync(() => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click());
    await actAsync(() => mocks.listeners.get("settings:navigate-tab")?.({ payload: "voice" }));
    expect(dialog.open).toBe(false);
  });

  it.each(["顶栏", "阅读页"])("%s入口打开同一个设置窗口，取消后焦点回到入口", async (entry) => {
    const h = await mount();
    await continueReading(h);
    const selector = entry === "顶栏" ? '.shell-tools [aria-label="设置"]' : ".reading-settings-chip";
    const opener = h.container.querySelector<HTMLButtonElement>(selector)!;
    await actAsync(() => { opener.focus(); opener.click(); });
    const dialog = h.container.querySelector<HTMLDialogElement>(".reader-settings-dialog")!;
    expect(dialog.open).toBe(true);
    expect(h.container.querySelectorAll("dialog")).toHaveLength(1);
    expect(h.container.querySelector(".reading-settings-pop, .reader-drawer")).toBeNull();
    expect(dialog.querySelector('.set-nav-item[aria-current="page"]')?.textContent).toBe("阅读与练习");
    await selectTab(dialog, "语音");
    const close = dialog.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!;
    await actAsync(() => { close.focus(); dialog.dispatchEvent(new Event("cancel", { cancelable: true })); });
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(mocks.hide).not.toHaveBeenCalled();

    const other = h.container.querySelector<HTMLButtonElement>(entry === "顶栏" ? ".reading-settings-chip" : '.shell-tools [aria-label="设置"]')!;
    await actAsync(() => { other.focus(); other.click(); });
    expect(h.container.querySelector(".reader-settings-dialog")).toBe(dialog);
    expect(dialog.querySelector('.set-nav-item[aria-current="page"]')?.textContent).toBe("阅读与练习");
    await actAsync(() => { close.focus(); close.click(); });
    expect(document.activeElement).toBe(other);
  });

  it("外部分类请求清除旧入口记录，关闭时不会再次主动聚焦旧入口", async () => {
    const h = await mount();
    const opener = h.container.querySelector<HTMLButtonElement>('.shell-tools [aria-label="设置"]')!;
    await actAsync(() => { opener.focus(); opener.click(); });
    const dialog = h.container.querySelector<HTMLDialogElement>(".reader-settings-dialog")!;
    const focus = vi.spyOn(opener, "focus");
    mocks.pendingSettingsTab = "voice";
    await actAsync(() => mocks.listeners.get("settings:navigate-tab")?.({ payload: "voice" }));
    const close = dialog.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!;
    await actAsync(() => { close.focus(); close.click(); });
    expect(dialog.open).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it("句卡在统一设置里即时生效，切换分类和重开窗口后保留，重建阅读室后复位", async () => {
    const h = await mount();
    await continueReading(h);
    const persisted = localStorage.getItem("immersive-translator-reader-settings");
    const dialog = await openSettings(h);
    const cards = () => dialog.querySelector<HTMLButtonElement>('[aria-label="句卡"]')!;
    expect(cards().getAttribute("aria-checked")).toBe("false");
    await actAsync(() => cards().click());
    expect(h.container.querySelector(".prose-body.sent-cards")).not.toBeNull();
    await selectTab(dialog, "语音");
    await selectTab(dialog, "阅读与练习");
    expect(cards().getAttribute("aria-checked")).toBe("true");
    await actAsync(() => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click());
    await openSettings(h);
    expect(cards().getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("immersive-translator-reader-settings")).toBe(persisted);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "reader_save_article")).toBe(false);

    h.unmount();
    const restarted = await mount();
    await continueReading(restarted);
    expect(restarted.container.querySelector(".prose-body.sent-cards")).toBeNull();
  });

  it("统一设置的排版、专注和抽查沿用原保存通道，对照排版禁用句卡", async () => {
    chapterResult!.sentences[0].chunks = [{ text: "quiet", gloss: "安静的", chunkType: "collocation" }];
    const h = await mount();
    await continueReading(h);
    const dialog = await openSettings(h);
    await actAsync(() => dialog.querySelector<HTMLButtonElement>('[aria-label="句卡"]')!.click());
    await actAsync(() => findButton(dialog.querySelector<HTMLElement>('[aria-label="排版"]')!, "对照").click());
    expect(h.container.querySelector(".parallel-spread-body")).not.toBeNull();
    const cards = dialog.querySelector<HTMLButtonElement>('[aria-label="句卡"]')!;
    expect(cards.disabled).toBe(true);
    expect(cards.getAttribute("aria-checked")).toBe("false");
    await actAsync(() => findButton(dialog.querySelector<HTMLElement>('[aria-label="排版"]')!, "段落").click());
    expect(cards.disabled).toBe(false);
    expect(cards.getAttribute("aria-checked")).toBe("true");
    expect(h.container.querySelector(".prose-body.sent-cards")).not.toBeNull();
    await actAsync(() => dialog.querySelector<HTMLButtonElement>('[aria-label="专注模式"]')!.click());
    expect(h.container.querySelector(".prose-body.spotlight-active")).not.toBeNull();
    expect(h.container.querySelector(".reader-root")?.hasAttribute("data-side-hidden")).toBe(true);
    await actAsync(() => dialog.querySelector<HTMLButtonElement>('[aria-label="随读抽查"]')!.click());
    expect(h.container.querySelector(".cloze")).not.toBeNull();
    await actAsync(async () => { await vi.advanceTimersByTimeAsync(750); });
    const global = JSON.parse(localStorage.getItem("immersive-translator-reader-settings")!);
    expect(global).toMatchObject({ spreadLayout: "prose", spotlightMode: true, spotQuizMode: true });
    expect(global.sentCards).toBeUndefined();
    const savedArticles = mocks.invoke.mock.calls.filter(([command]) => command === "reader_save_article");
    const saved = (savedArticles[savedArticles.length - 1][1] as { article: Article }).article;
    expect(saved.settings).toMatchObject({ spreadLayout: "prose", spotlightMode: true, spotQuizMode: true });
    expect(saved.settings).not.toHaveProperty("sentCards");
    await actAsync(() => dialog.querySelector<HTMLButtonElement>('[aria-label="专注模式"]')!.click());
    await actAsync(() => dialog.querySelector<HTMLButtonElement>('[aria-label="随读抽查"]')!.click());
    expect(h.container.querySelector(".reader-root")?.hasAttribute("data-side-hidden")).toBe(false);
    expect(h.container.querySelector(".prose-body.spotlight-active, .cloze")).toBeNull();
  });

  it("按住 H 时打开设置会遮回译文，在设置内松开 H 后关闭也不会残留显影", async () => {
    localStorage.setItem("immersive-translator-reader-settings", JSON.stringify({ ...DEFAULT_READER_SETTINGS, maskTranslation: true }));
    const h = await mount();
    await continueReading(h);
    expect(h.container.querySelector(".translation-pop")).toBeNull();
    await actAsync(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true })); });
    expect(h.container.querySelector(".translation-pop")).not.toBeNull();
    const dialog = await openSettings(h);
    expect(h.container.querySelector(".translation-pop")).toBeNull();
    await actAsync(() => { dialog.querySelector(".set-shell")!.dispatchEvent(new KeyboardEvent("keyup", { key: "h", bubbles: true })); });
    await actAsync(() => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click());
    expect(h.container.querySelector(".translation-pop")).toBeNull();
    await actAsync(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true })); });
    expect(h.container.querySelector(".translation-pop")).not.toBeNull();
    await actAsync(() => { window.dispatchEvent(new KeyboardEvent("keyup", { key: "h", bubbles: true })); });
    expect(h.container.querySelector(".translation-pop")).toBeNull();
  });

  it("当前文章的字号同步保存到全局与文章，复习模式只保存到全局", async () => {
    const h = await mount();
    await continueReading(h);
    const dialog = await openSettings(h);
    await actAsync(() => dialog.querySelector<HTMLButtonElement>('[aria-label="增大字号"]')!.click());
    await actAsync(() => findButton(dialog.querySelector<HTMLElement>(".reader-settings-content")!, "听写").click());
    await actAsync(async () => { await vi.advanceTimersByTimeAsync(750); });

    const global = JSON.parse(localStorage.getItem("immersive-translator-reader-settings")!);
    expect(global.fontSize).toBe(20);
    expect(global.reviewMode).toBe("dictation");
    const savedArticles = mocks.invoke.mock.calls
      .filter(([command]) => command === "reader_save_article")
      .map(([, args]) => (args as { article: Article }).article);
    expect(savedArticles.length).toBeGreaterThan(0);
    const savedArticle = savedArticles[savedArticles.length - 1];
    expect(savedArticle.settings?.fontSize).toBe(20);
    expect(savedArticle.settings?.reviewMode).toBeUndefined();
    expect(h.container.querySelector<HTMLElement>(".reader-root")!.style.getPropertyValue("--read-en-size-cur")).toBe("20px");
  });

  it("同窗切换云音色即时更新下一次朗读配置，不依赖跨窗口回声", async () => {
    const defaultInvoke = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "auth_get_status") return Promise.resolve({
        loggedIn: true,
        user: { id: "voice-account", email: "voice@example.com", nickname: null, plan: "FREE", createdAt: "1" },
        notice: null,
      });
      if (command === "auth_server_base_url") return Promise.resolve("https://voice.example.com");
      if (command === "auth_fetch_server_config") return Promise.resolve({
        models: ["local-test-model"],
        voice: {
          ttsVoices: [{ id: "voice-a", label: "音色 A" }, { id: "voice-b", label: "音色 B" }],
          asrLanguages: ["en_us"],
          iseEnabled: true,
        },
      });
      return defaultInvoke(command, args);
    });
    const settings = JSON.parse(localStorage.getItem("immersive-translator-settings")!);
    localStorage.setItem("immersive-translator-settings", JSON.stringify({ ...settings, voiceProvider: "gateway", voiceGatewayVoice: "voice-a" }));
    const h = await mount();
    const dialog = await openSettings(h);
    await selectTab(dialog, "语音");
    expect(mocks.gatewayConfig?.().voice).toBe("voice-a");
    const select = dialog.querySelector<HTMLSelectElement>('[aria-label="朗读音色"]')!;
    expect(select.disabled).toBe(false);
    await actAsync(() => {
      select.value = "voice-b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(JSON.parse(localStorage.getItem("immersive-translator-settings")!).voiceGatewayVoice).toBe("voice-b");
    expect(mocks.gatewayConfig?.().voice).toBe("voice-b");
  });

  it("设置打开时阅读快捷键不在背景播放或换句，关闭后恢复", async () => {
    const h = await mount();
    await continueReading(h);
    const dialog = await openSettings(h);
    const currentSentence = () => h.container.querySelector('.prose-sentence.is-current')?.getAttribute("data-idx");
    expect(currentSentence()).toBe("2");
    await actAsync(() => {
      for (const key of [" ", "j", "k"]) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      }
    });
    expect(mocks.speak).not.toHaveBeenCalled();
    expect(currentSentence()).toBe("2");
    await actAsync(() => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click());
    await actAsync(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true })); });
    expect(currentSentence()).toBe("3");
    await actAsync(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })); });
    expect(mocks.speak).toHaveBeenCalledOnce();
  });
});
