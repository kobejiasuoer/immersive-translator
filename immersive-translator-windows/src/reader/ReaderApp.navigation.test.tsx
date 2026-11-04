// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderApp } from "./ReaderApp";
import { DEFAULT_SETTINGS } from "../lib/settingsStore";
import { DEFAULT_READER_SETTINGS, type Article, type ArticleSummary, type BookMeta } from "../core/readerTypes";
import { initialSrs } from "../core/readerSrs";
import { actAsync, createHarness, findButton, type Harness } from "../views/authTestHarness";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return Promise.resolve(() => mocks.listeners.delete(event));
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "reader",
    onCloseRequested: () => Promise.resolve(() => undefined),
    hide: () => Promise.resolve(),
  }),
}));
vi.mock("../lib/learningRelay", () => ({
  syncLearningRecordsSilently: () => Promise.resolve([]),
}));
// 保留真实播放游标/复位逻辑，只替换音频输出基础设施。
vi.mock("./speechEngine", () => {
  const engine = {
    speak: () => Promise.resolve(1),
    stopTrack: () => Promise.resolve(),
    onEnded: () => () => undefined,
    prefetch: () => undefined,
  };
  return {
    createSapiEngine: () => engine,
    createXfyunEngine: () => engine,
    createEdgeEngine: () => engine,
    createGatewayEngine: () => engine,
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.listeners.clear();
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
      case "reminder_get_config": return { readGoalMin: 10 };
      case "auth_get_status": return { loggedIn: false, user: null, notice: null };
      case "auth_server_base_url":
      case "take_pending_reader_import":
      case "take_pending_open_book": return null;
      case "secret_get": return "";
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
