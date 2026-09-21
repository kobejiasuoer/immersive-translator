/**
 * 讯飞合成音频的磁盘缓存（IndexedDB）。
 *
 * xfyunTts.ts 的内存 LRU 是 L1；本模块是 L2，数据落在 WebView 用户数据
 * 目录，应用重启、换文章后仍然命中——重听/复习不再消耗每日免费额度。
 *
 * 设计约束：
 * - 永不阻塞合成主链路：任何 IndexedDB 错误都吞掉（get 返回 null，put 忽略）。
 * - 环境没有 IndexedDB（单测 node 环境、隐私模式）时整体退化为 no-op。
 * - 容量按条数清理（默认 3000 条 ≈ 数百 MB 以内）：每 20 次写入清理一次，
 *   按 lastUsed 升序删最旧；存储占用超标（estimate）时按一半上限再砍。
 */

const DB_NAME = "immersive-reader-tts";
const STORE = "clips";
const MAX_ENTRIES = 3000;
/** 存储占用粗上限（含同源其他数据）；超了就把条数上限减半再清理。 */
const MAX_BYTES = 200 * 1024 * 1024;
/** 每写多少条触发一次清理。 */
const TRIM_EVERY = 20;

interface ClipRecord {
  blob: Blob;
  lastUsed: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
let putCount = 0;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE).createIndex("lastUsed", "lastUsed");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // 打不开就当没有磁盘缓存
      req.onblocked = () => resolve(null);
    });
    // 尽力申请持久存储配额，降低被系统自动回收的概率（结果不影响正确性）。
    void globalThis.navigator?.storage?.persist?.().catch(() => undefined);
  }
  return dbPromise;
}

/** 读缓存；命中顺带刷新 lastUsed（同一事务内 write-behind，只影响下次清理顺序）。 */
export async function diskCacheGet(key: string): Promise<Blob | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.get(key);
    req.onsuccess = () => {
      const rec = req.result as ClipRecord | undefined;
      if (!rec) return resolve(null);
      resolve(rec.blob);
      try {
        store.put({ ...rec, lastUsed: Date.now() }, key);
      } catch {
        /* 已拿到 blob，写回失败无所谓 */
      }
    };
    req.onerror = () => resolve(null);
  });
}

/** 写入一条；每 TRIM_EVERY 次写一次清理。永不 reject。 */
export async function diskCachePut(key: string, blob: Blob): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ blob, lastUsed: Date.now() }, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  putCount += 1;
  if (putCount % TRIM_EVERY === 0) void diskCacheTrim();
}

function countEntries(db: IDBDatabase): Promise<number> {
  return new Promise((resolve) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(0);
  });
}

/** 按 lastUsed 升序删最旧，直到条数进入上限。导出供测试与手动维护。 */
export async function diskCacheTrim(maxEntries = MAX_ENTRIES): Promise<void> {
  const db = await openDb();
  if (!db) return;
  let limit = maxEntries;
  try {
    const est = await globalThis.navigator?.storage?.estimate?.();
    if (est && typeof est.usage === "number" && est.usage > MAX_BYTES) {
      limit = Math.floor(maxEntries / 2);
    }
  } catch {
    /* estimate 不可用就只按条数清理 */
  }
  const excess = (await countEntries(db)) - limit;
  if (excess <= 0) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const cursorReq = tx.objectStore(STORE).index("lastUsed").openCursor();
    let left = excess;
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || left <= 0) return;
      cursor.delete();
      left -= 1;
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}
