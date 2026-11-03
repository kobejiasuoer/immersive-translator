// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReaderApp } from "./ReaderApp";
import { DEFAULT_SETTINGS } from "../lib/settingsStore";
import { DEFAULT_READER_SETTINGS, type Article, type ArticleSummary, type BookMeta } from "../core/readerTypes";
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
