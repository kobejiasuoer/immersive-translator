# Mac 1:1 移植规格：B3 资讯订阅（feed 抓取 / FeedTab 第 7 tab）+ 发现书库 + 导入正文 5 万截断

- 对齐基线（五个 Windows commit，`git show --stat` 已逐一核实）：
  - `557e9cc` feat(reader): 书目目录传输与下载命令（discover.rs + tauriBridge + discoverCatalog，GET /v1/books 目录 + GET /v1/books/{id}/download 镜像下载）
  - `7aa33cc` feat(reader): B3 资讯订阅——reader_fetch_feed 抓取命令（feed.rs）
  - `f0c0472` feat(reader): 阅读室「发现」页与导入管线衔接（DiscoverTab + ImportDialog 注入接力）
  - `6784bcd` feat(reader): B3 资讯订阅——订阅列表/推荐清单/FeedTab 第 7 tab（feedCatalog/feedStore/FeedTab）
  - `1a6ebe6` feat(reader): 导入正文 5 万字符截断 + 推荐订阅源复测收编
  - 入口关联：`1c5205d`（书架三列直达 + ImportDialog `initialTab`，Windows 书架发现/订阅入口所在提交，`git log -S "shelf-disc-card"` 核实）
- 本文所有 Windows/Mac 锚点均为**当前 main 工作区实证行号**（非 diff 行号），逐条读过原文。
- **服务端说明**：任务书提到的 `immersive-translator-server/` 目录在本工作区**不存在**（`ls` 仓库根核实：只有 immersive-translator-windows / -mac / -mobile / packages / contracts / website / prototypes / docs 等；`git log --all -- "immersive-translator-server"` 亦无历史）。/v1/books 契约以下列两处为准：① 客户端侧实证（`discover.rs` 的查询参数/信封注释、`discoverCatalog.ts` 的 15 键行形状与信封解析）；② `docs/product-upgrade-plan-2026-10-22.md:126`（B1 服务端规格：`books` 表 + `GET /v1/books` 搜索筛选 + `GET /v1/books/:id/download` 下载镜像文件）。`contracts/` 目录无 books schema（已 grep 核实）。
- Mac 端现状：`Sources/ImmersiveTranslator/ReaderIntakeSheet.swift` 固定 5 入口（`ReaderIntakeSheet.swift:5-7` 注释、`:26-32` IntakeTab 枚举）；全仓 `grep -rn "RSS|订阅|Feed|feed" Sources` 在阅读室范围内零命中（仅 Vad/Speak 等无关命中）；`grep truncated|50_000|capText` 零命中——**无订阅/Feed/目录下载/5 万截断，须全部新建**。

---

## 1. Windows 行为规格

### 1.1 功能入口与交互流

#### 1.1.1 导入弹窗七 tab（FeedTab 为第 7 tab）

`ImportDialog.tsx:70` 定义 `type TabId = "lib" | "epub" | "file" | "url" | "paste" | "discover" | "feed"`；tab 条按序渲染七枚按钮（`ImportDialog.tsx:174-183`）：

```
["lib","内置文库"], ["epub","EPUB / 长书"], ["file","本地文件"], ["url","网页链接"],
["paste","粘贴文本"], ["discover","发现书库"], ["feed","资讯订阅"]
```

条件渲染（`ImportDialog.tsx:200-232`）：`tab === "discover"` 挂 `DiscoverTab`，`onDeliver(file, bookId)` 回调内**同帧两步 setState**（`ImportDialog.tsx:223-231`）：`setPendingEpub({ file, sourceBookId: bookId })` + `setTab("epub")`；`tab === "feed"` 挂 `FeedTab`，传 `onImport`（ReaderApp.importPaste 接力）与 `onSwitchToPaste`（`setTab("paste")`）。

**发现页 → EPUB 管线注入接力**（`ImportDialog.tsx:114-116` 的 `pendingEpub` 状态 + `:833-837` 的 `EpubTabInjected { file, sourceBookId? }`）：`EpubTab` 挂载时经 effect 消费注入（`ImportDialog.tsx:905-910`）——`injectedRef` 防重入（StrictMode 双挂载/重选文件均不重复解析），先 `onInjectedConsumed()`（清 pendingEpub）再 `parse(file, sourceBookId)`；`sourceBookId` 进 `EpubPreviewState`（`:831`）并在确认导入时透传进 `BookImportDraft.sourceBookId`（`:943`）。既有本地导入不传 `injected`，行为零变化。

**弹窗初始 tab 直达**：`ReaderApp.tsx:282` `importInitialTab` 状态（缺省 `"lib"`）；`openImport(tab?)`（`ReaderApp.tsx:376-379`）以运行时白名单 `IMPORT_OPEN_TABS`（`:214-222`，七值数组）拦非 tab 值后置初始 tab 并开弹窗；ImportDialog 条件挂载 + 每次重开重置该值（`:2672-2684`）。书架三列入口（`ShelfPage.tsx:642-666`）：`精选经典`→`onOpenImport("discover")`、`英文资讯订阅`→`onOpenImport("feed")`、`导入自己的内容`→`onOpenImport("lib")`。

#### 1.1.2 发现书库（DiscoverTab，B2 前端）

`DiscoverTab.tsx:54-334`，交互流：

1. **挂载**（`:125-142`）：埋 `discover_view`（云端 track）→ 订阅 `books:download:progress` 进度事件（函数式 `setDownload` 按 `bookId` 匹配更新；`disposed` flag 防 unlisten promise 竞态）→ `fetchPage({ pageToLoad: 1, append: false })`。
2. **目录态机**：`loading / ready / error`；`fetchPage`（`:76-121`）调 `booksList({ q, grade, page, perPage: 20 })`（PAGE_SIZE=20，`:36`）。非 200 → `discoverListErrorText(http)`；200 → `parseBooksPage(http.body)`，null → `DISCOVER_BODY_ERROR_TEXT`。`append=true`（加载更多）失败只记 `moreError` 不动已加载内容。
3. **筛选**：`qDraft` 受控值与 `applied {q, grade}` 生效口径分离（`:63-65`）——Enter 或点「搜索」才 `applySearch()`（`:144-148`）；切难度 select 即 `changeGrade()`（`:150-156`）；两者都重拉 page 1。加载更多从 `page+1` 继续（`:162-164`），按钮仅当 `list.length < total` 显示。
4. **下载**（`:167-200`）：同一时刻至多一个在途（`if (download) return` + 全部下载按钮 `disabled={!!download}` 防连点触发 429）。流程：`booksDownload(book.id)` → 非 200 行内错 `discoverDownloadErrorText`；200 → `bytesFromBase64(http.body)`（throw → 行内「下载的数据损坏，请重试」）→ `verifyEpubSha256(bytes, book.sha256)`（false → 行内「下载的文件校验失败，请重新下载」）→ `onDeliver(epubFileOf(book, bytes), book.id)` 切 epub tab。**断点语义**：base64/校验失败留在本页行内不上抛半成品；parseEpub 失败由 EpubTab 既有 error 卡片兜底。
5. **进度展示**：`dl.total > 0` 时 `"{received} / {total}…"`（如 `0.5 MB / 0.8 MB…`），`total===0`（无 content-length）时 `"下载中…{received}"`（`:289-294`）。

#### 1.1.3 资讯订阅（FeedTab，B3）

`FeedTab.tsx:108-557`，交互流：

1. **挂载**（`:182-189`）：埋 `feed_view`（本地 trackEvent，空 props）→ 对 `fetchedAt` 距今超过 **FRESH_TTL_MS = 10 分钟**（`:54`）的订阅自动刷新（全部新鲜则零网络）。
2. **refreshFeeds(targets, cache)**（`:149-177`）：`Promise.allSettled` 并行拉取，单源失败不阻断其他；成功源写缓存 `{ entries, fetchedAt: Date.now() }`，失败源 id 聚进 `failedFeedIds`（工具行「N 个订阅刷新失败」+ 重试只补失败源）。`parseFeedXml` 返回 null（源站给了非 feed 内容）按该源失败计。
3. **addFeed(rawUrl)**（`:193-239`，手添输入与推荐勾选共用）：`normalizeFeedUrl` 归一化 → 空或 `adding` 中直接返回 → `findFeedByUrl` 查重命中给 `FEED_DUPLICATE_TEXT` 不发网络 → `readerFetchFeed(url)` 拉一次校验可达 → `parseFeedXml` null 给 `FEED_PARSE_ERROR_TEXT`（[] 是合法空 feed 照常入库）→ 取 feed 自报 channel title（`feedTitleOf`，取不到以 host 兜底命名）→ 入库 `FeedSubscription { id: newFeedId(), url, title, addedAt }` 并**立即写条目缓存（首拉即缓存）**→ 清空输入。失败 catch 给 `feedInvokeErrorText(e)`（Rust 中文 message 直显）。
4. **removeFeed(id)**（`:242-256`）：连同其条目缓存一起清；从 `failedFeedIds` 移除；若正打开的文章属于该订阅则关预览。
5. **手动刷新**（`:493-519`）：按钮无条件全量 `refreshFeeds(feeds, cache)`（新鲜缓存也重拉）；刷新中 disabled 且文案变「正在刷新…」。
6. **合并列表**（`:310-321`）：`mergeFeedEntries(feeds.map(...))`——盖 feedId/feedTitle 溯源、按 publishedAt 降序（缺省回退该源 fetchedAt）、截前 100 条。
7. **点开文章**（`:259-272`）：`openArticle(entry)` → `readerFetchUrl(entry.link)` 抓正文 → 预览卡（UrlTab 同链）。loading 骨架「正在抓取正文…」；error 卡「没能读取这篇文章」+ 原因 + 「返回列表 / 重试 / 切到粘贴文本」。
8. **确认导入**（`:300-308`）：先埋 `feed_import`（本地 trackEvent，props `{ host: pv.host }`——**发起导入意图**口径），再 `onImport(pv.text, pv.title, { sourceType: "url", sourceUrl: openEntry.link, level: pvStats.level })`。之后的 importPaste 链路与 URL tab 共用。

#### 1.1.4 导入正文 5 万字符截断（1a6ebe6）

Rust `web_extract.rs` 的 `reader_fetch_url` 在正文提取后调 `cap_text_chars(&text, MAX_ARTICLE_CHARS)`（`web_extract.rs:67`，纯文本路径 `:321` 同样截断）——**整段保留截断**：段落以 `"\n\n"` 切分，段落间分隔符计入预算（join 后总长严格 ≤ max_chars），超限在段落边界截断并标 `truncated: true`；**首段恒保留**（宁多勿空，单段超限也原样返回不标 truncated）。`FetchedArticle` 带 `truncated` 字段（`web_extract.rs:24-25`）。前端三处预览卡显示同一句提示：UrlTab（`ImportDialog.tsx:643`）、FeedTab（`FeedTab.tsx:393`）：

```
{preview.truncated && <div className="epub-pv-note">原文过长，仅导入前 50,000 字符</div>}
```

门槛检查按原文全量词数（截断不影响付费墙判定，`web_extract.rs:66`）。

### 1.2 UI 状态与用户可见文案（原样抄录，供逐字复刻）

**弹窗头部**（ImportDialog.tsx:166-167，Mac 已有同款 `ReaderIntakeSheet.swift:92-93`）：
```
添加阅读内容
从文库挑一篇、导入整本 EPUB、导入 Word / PDF 文件、抓一篇网页文章，或粘贴自己的文本 —— 入库后逐句精读，生词自动进生词本
```

**书架发现三列**（ShelfPage.tsx:643-665）：
```
发现更多可读内容
精选经典 / 按难度和考纲词表挑选公版名著与短篇
英文资讯订阅 / 订阅常用新闻源，每天自动收到可读短文
导入自己的内容 / 网址、文件或粘贴文本，自动拆句并翻译
```

**发现书库 tab**（DiscoverTab.tsx）：

| 位置 | 文案（逐字） | 行号 |
|---|---|---|
| 搜索框 placeholder / aria-label | `搜索书名 / 作者` | :209-210 |
| 难度 select aria-label | `难度筛选`；选项 `全部难度` / `入门`(easy) / `进阶`(medium) / `挑战`(hard) | :219-227 |
| 搜索按钮 | `搜索` | :228-230 |
| 目录骨架 | `正在加载书库目录…` | :239 |
| 目录级错误卡 | 标题 `没能加载书库`；副文 errorText；按钮 `重试` | :245-250 |
| 计数 | `共 {total.toLocaleString()} 本` | :257 |
| 卡片 | 封面 emoji（缺省 `📘`）、书名、作者、难度 chip（`GRADE_LABELS[grade] ?? grade`）、`{wordCount.toLocaleString()} 词`、`formatFileSize(fileSizeBytes)`、description、`许可：{licenseName}`（title=licenseUrl） | :263-286 |
| 下载按钮 | `下载 · {formatFileSize(fileSizeBytes)}`；在途禁用 | :307-313 |
| 下载进度 | total>0：`{fmt(received)} / {fmt(total)}…`；total=0：`下载中…{fmt(received)}` | :290-294 |
| 下载错误 | 行内红字 + 按钮 `重新下载` | :295-305 |
| 加载更多 | `正在加载…` / `加载更多（{list.length}/{total}）` | :326 |

**资讯订阅 tab**（FeedTab.tsx）：

| 位置 | 文案（逐字） | 行号 |
|---|---|---|
| 添加输入框 placeholder / aria-label | `粘贴 RSS/Atom 订阅地址` / `订阅地址` | :431-432 |
| 添加按钮 | `添加`；进行中 `正在添加…`；输入空或 adding 中 disabled | :434-440 |
| 添加错误行 | addError + `重试`（重发 lastAddUrl） | :442-449 |
| 订阅 chip | 标题 + `✕`（aria-label `删除订阅 {title}`、title `删除这个订阅`、chip title=url） | :453-464 |
| 推荐区标题 | `推荐订阅 · 美国政府公开源` | :470 |
| 推荐行 | title + note + 按钮 `添加` / 已在列表 `已添加`（disabled） | :472-489 |
| 工具行 | `刷新` / `正在刷新…`；`更新于 {relativeTime}`；`{n} 个订阅刷新失败` + `重试` | :493-518 |
| 空态（无订阅） | `先添加一个 RSS/Atom 订阅地址，或从下方推荐列表勾选几个` | :522 |
| 空态（有订阅无文章） | `订阅源暂时没有文章`（FEED_EMPTY_TEXT）；无缓存且刷新中显示骨架 `正在刷新订阅…` | :524-533 |
| 文章行 | 源名（feedTitle）+ 可点标题 + 摘要（>120 字截 `…`）+ 相对时间 | :536-552 |
| 文章预览 loading | `正在抓取正文…` | :341 |
| 文章预览 error | `没能读取这篇文章` + pvError + `返回列表` / `重试` / `切到粘贴文本` | :350-363 |
| 文章预览卡 | `{pv.host} · 来自订阅「{openEntry.feedTitle}」`；级别 chip + `{words} 词 · {paras} 段 · 约 {minutes} 分钟`；覆盖行 `覆盖{goal}大纲词 {total} · {n} 个你还没掌握`；摘要 `{text.slice(0,180)}…`；按钮 `返回列表` / `加入书架并开始阅读` | :385-411 |
| 截断提示 | `原文过长，仅导入前 50,000 字符`（`pv.truncated` 时，epub-pv-note 样式） | :393 |
| 相对时间 | `<60s 刚刚`；`<1h {n} 分钟前`；`<1d {n} 小时前`；否则 `{n} 天前` | :100-106 |

**feed 错误文案常量**（feedCatalog.ts）：
- `FEED_PARSE_ERROR_TEXT` = `无法解析这份订阅源，请确认地址指向 RSS/Atom 订阅（不是普通网页）`（:59-60）
- `FEED_EMPTY_TEXT` = `订阅源暂时没有文章`（:63）
- `FEED_DUPLICATE_TEXT` = `这个订阅已在列表中`（:66）
- `feedInvokeErrorText(err)` = `err instanceof Error ? err.message : String(err)`（:71-73，绝不引入网关错误映射）

**feed 抓取（Rust feed.rs）的中文 message**（reject 直显）：
- URL 解析失败：`这不是有效的订阅地址`（feed.rs:22）
- scheme 非 http/https：`只支持 http/https 订阅源`（feed.rs:24）
- 401/403：`这个订阅源需要登录或拒绝了访问（{status}）`（feed.rs:34）
- 其余非 2xx：`订阅源返回了 {status}`（feed.rs:37）
- 超 2MB（两级门禁共用）：`订阅内容超过 2MB，已取消`（feed.rs:17）
- 网络初始化失败：`网络初始化失败: {e}`；发送失败：`打不开这个订阅源（{e}）——检查网络或地址后重试`；读取失败：`读取订阅内容失败: {e}`（feed.rs:67,72,83）

**discover 错误文案函数**（discoverCatalog.ts）：
- `discoverListErrorText`（:152-157）：400→`请求参数异常，请更新应用后重试；若持续出现请反馈`；404→`书库暂时无法访问（404），请稍后再试`；429→`操作过于频繁，请 {n} 秒后再试`（秒数缺失/非正则`操作过于频繁，请稍后再试`，:144-148）；其余→`服务暂时不可用，请稍后再试`
- `DISCOVER_BODY_ERROR_TEXT` = `书库数据异常，请稍后重试；若持续出现请更新应用`（:160）
- `discoverDownloadErrorText`（:164-170）：404→`这本书当前不可下载，请稍后再试或换一本`；400→`请求参数异常，请更新应用后重试；若持续出现请反馈`；401→`登录已失效，请重新登录`；429→同上插值；其余→`服务暂时不可用，请稍后再试`
- `discoverInvokeErrorText`（:174-179）：AuthError `code === "platform_unavailable"`→`书库服务暂未开放，请稍后再试`；其余走 `authErrorText(err).text`（`network_error`→`网络连接失败，请检查网络后重试`，authErrorText.ts:57）
- DiscoverTab 行内常量：base64 损坏→`下载的数据损坏，请重试`（DiscoverTab.tsx:183）；sha256 不匹配→`下载的文件校验失败，请重新下载`（:188）
- Rust 本地伪信封：id 预校验不合式时 body 为 `{"error":{"code":"validation_error","message":"书目 id 不合法"}}`、status=400（discover.rs:291-298）；`platform_unavailable` reject message `书库服务暂未开放`（discover.rs:236）

**入库 toast**（ReaderApp.tsx:1535，Mac 已有同款 `ReaderViewModel.swift:966`）：`` 已导入《{title}》· {n} 章 ``。

### 1.3 数据结构与本地存储

**FeedEntryItem**（feedCatalog.ts:22-35）：
```ts
{ feedId: string; feedTitle: string; title: string; link: string;
  summary: string; publishedAt: number | null }   // parseFeedXml 产物中 feedId/feedTitle 为空串，由 merge/缓存写入方补齐
```

**RecommendedFeed**（feedCatalog.ts:39-44）：`{ title, url, note }`。**RECOMMENDED_FEEDS**（:100-125）固定四条（2026-10-25 施工复测定稿，实测不通过的源宁缺勿滥，剔除记录见 :75-99 注释）：
1. NASA News Releases — `https://www.nasa.gov/news-release/feed/` — `NASA 官方新闻稿，航天任务报道，日更数条，英语难度适中`
2. CDC Online Newsroom — `https://tools.cdc.gov/api/v2/resources/media/132608.rss` — `美国疾控中心新闻稿，公共健康主题，句子规范适合泛读`
3. NIST News — `https://www.nist.gov/news-events/news/rss.xml` — `美国国家标准与技术研究院，科技/计量新闻，周更 2-4 条，适合精读`
4. Energy Department News — `https://www.energy.gov/rss` — `美国能源部新闻，能源科技与科研进展，周更数条`

**FeedEntriesBundle**（:47-53）：`{ feedId, feedTitle, fetchedAt, entries }`；`FEED_MERGE_LIMIT = 100`（:56）。

**FeedSubscription / FeedCacheEntry**（feedStore.ts:17-31）：
```ts
FeedSubscription { id: string /* crypto.randomUUID，降级 feed-{ts36}-{rand} */; url: string /* 归一化后 */;
                  title: string; addedAt: number }
FeedCacheEntry   { entries: FeedEntryItem[]; fetchedAt: number }   // Record<feedId, FeedCacheEntry>
```
localStorage 两个键（:13-14）：`immersive-translator-reader-feeds`（订阅数组）、`immersive-translator-reader-feed-entries`（条目缓存 Record）。读取逐行类型守卫丢脏行（缺 id/url 的订阅行、缺 title/link 的条目行只丢该行，feedStore.ts:42-69）；坏 JSON/坏形状回默认（[] / {}，:72-126）；save 一律 try/catch ignore。**刻意不用 sync_store_*（不推服务端，「不经服务端」是 B3 验收点）**。

**DiscoverBook / DiscoverPage**（discoverCatalog.ts:17-41）——服务端 BookView 的 15 键形状（description/wordCount 空时整体省键）：
```ts
DiscoverBook  { id, title, author, description?, wordCount?, grade /* easy|medium|hard */, category,
                language, coverEmoji, source, sourceUrl, licenseName, licenseUrl,
                fileSizeBytes: number, sha256: string }
DiscoverPage  { books: DiscoverBook[]; total: number; page: number; perPage: number }
GRADE_LABELS  { easy: "入门", medium: "进阶", hard: "挑战" }   // :44-48
```

**桥接类型**（tauriBridge.ts）：`BooksListQuery`（:624-632，q/language/category/source/grade/page/perPage 全可选）；`SyncHttpText { status: number; body: string; retryAfterSeconds: number | null }`（:535-539）；`BooksDownloadResult`（:637-641，与 Rust 一字不差，`status===200` 时 body 为 EPUB 字节 base64，非 200 为错误信封 JSON 文本）；`BooksDownloadProgress { bookId, received, total }`（:644-648，total=0 表示无 content-length）。

**FetchedArticle**（webExtract.ts:9-20）：`{ url, host, title, text, truncated?: boolean }`（truncated：正文超 50,000 字符被整段截断时 true）。

**BookImportDraft.sourceBookId**（bookImport.ts:72-79）：可选；`discoverImportProps(draft)` 纯函数：`draft.sourceBookId ? { bookId } : null`（本地导入不埋 discover_import，绝不把「发起导入」当「下载入库成功」）。

**埋点通道**（重要区分）：
- `discover_view`（空 props）/ `discover_import`（`{ bookId }`）走**云端** `track`（analytics.ts:62-72，POST /v1/events + Bearer，白名单 analytics.ts:44-57，未登录/失败静默）；DiscoverTab 挂载埋 view（DiscoverTab.tsx:126），ReaderApp 入库成功回调埋 import（ReaderApp.tsx:1536-1538）。
- `feed_view`（空 props）/ `feed_import`（`{ host }`）走**本地** `trackEvent`（telemetry.ts:16，telemetry_log_event → logs/reader-events.jsonl，纯本地零网络）；FeedTab 挂载/确认导入时埋（FeedTab.tsx:183, 302）。

### 1.4 网络端点与请求/响应契约

> 服务端源码不在本工作区；以下契约以客户端实证代码 + docs/product-upgrade-plan-2026-10-22.md:126 重建。

#### GET /v1/books（公版书目录，匿名只读）

- **base URL**：Rust `api_base_url`（discover.rs:82-86）= `TokenManager.gateway_endpoint()` 剥固定后缀 `/v1/chat/completions`；`gateway_endpoint`（auth.rs:894-898）= `{base}/v1/chat/completions` 且自带 `platform_available` 门控（auth.rs:159 PLATFORM_PUBLIC、:190-192；未开放期返回 None → discover reject `platform_unavailable`「书库服务暂未开放」）。
- **鉴权（可选 Bearer，刻意不用 with_auth）**：两端点服务端匿名只读；`with_optional_bearer`（discover.rs:171-180）取到登录令牌就带 `Bearer`（仅限流配额加成），取不到走匿名；**绝不能因取票失败而拒绝请求**；不做 401 刷新重放。未登录 = 发现页完整可用（不隐藏/不置灰/不提示登录）。
- **查询参数**（`build_query_pairs`，discover.rs:115-142）：`q/language/category/source/grade` 五筛选 **trim 后非空才进对**（空串/纯空白过滤，值随 trim 后发送）；`page` 缺省 1 且 `max(1)`；`perPage` 缺省 20、`clamp(1, 100)`。编码交给 URL 查询序列化（不手拼字符串）。
- **超时/UA**：目录 30s（LIST_TIMEOUT_SECS，discover.rs:38）；UA `ImmersiveTranslator/{CARGO_PKG_VERSION}`（discover.rs:162，部分下载服务拒绝无 UA 请求）。
- **响应**：`SyncHttpText { status, body, retryAfterSeconds }` 原样透传——**非 2xx 是数据不是异常**（400 参数非法 / 404 / 429 由前端按状态给中文文案）。200 的 body 为信封 JSON：`{ data: BookView[], total: number, page: number, perPage: number }`；非 2xx 的 body 为服务端 AppError 错误信封 JSON 文本 `{"error":{"code":"...","message":"..."}}`。
- **仅 reject 的情形**：网络失败（`network_error`，message `网络请求失败: {e}` / `读取响应失败: {e}`）、沉浸云未开放（`platform_unavailable`）。reject 前照 sync.rs 形态广播 `emit_fatal_if_needed`（实为 no-op，discover.rs:217-220）。
- **retry-after 解析**（discover.rs:151-156）：取头 → str → trim → u64，任何一步失败按无头处理。

#### GET /v1/books/{id}/download（镜像 EPUB，匿名可读）

- **id 本地预校验（防穿越第一道）**（discover.rs:92-108）：与服务端 `BOOK_ID_PATTERN`（`^[a-z0-9]+(-[a-z0-9]+)*$`）+ 限长 **128** 对齐（BOOK_ID_MAX_LENGTH，discover.rs:42）：非空、≤128、`-` 分段、每段仅 ascii 小写字母/数字。不合式**不发网络**，直接返回 `BooksDownloadResult { status: 400, body: {"error":{"code":"validation_error","message":"书目 id 不合法"}}, retryAfterSeconds: null }`（400 也是数据不是 reject）。
- **超时**：300s（DOWNLOAD_TIMEOUT_SECS，discover.rs:40，单本最大 18.4MB 慢网余量）。
- **应答分流（先判 status 再分流，discover.rs:313-361）**：`status != 200` → body 按文本透传（服务端非 2xx 回 JSON 错误信封不回二进制）；`status == 200` → **流式收字节**，每满 **256KB（262,144）** 经事件 `books:download:progress` 报一次 `{ bookId, received, total }`（节流公式 `received - last_emitted >= 262_144`，discover.rs:145-147；total=content-length 缺省 0），收完**补发终值**（保证 UI 至少收到一次 received==total）；字节 **base64 编码跨 IPC**（案 A：不落盘、不做 Rust sha256；screenshot.rs 先例，discover.rs:355-356）。
- **完整性双保险（前端）**：`bytesFromBase64`（atob 逐字节，discoverCatalog.ts:109-114，非法输入抛错由调用方 catch）+ `verifyEpubSha256`（SubtleCrypto SHA-256 hex 小写与目录 `sha256` 比对，discoverCatalog.ts:119-129；**expected 非法（非 64 位 hex）或摘要能力不可用返回 true 放行**——校验是旁路防线不构成硬门槛；不匹配返回 false）。
- **`epubFileOf(book, bytes)`**（discoverCatalog.ts:133-135）：构造 `new File([bytes], "{book.id}.epub", { type: "application/epub+zip" })` 喂既有 parseEpub 管线（bookId 天然满足后缀与非法字符约束）。
- **`formatFileSize(bytes)`**（:138-141）：`≥524288 → "{x.x} MB"`（一位小数）；否则 `"{max(1, round(bytes/1024))} KB"`。

#### reader_fetch_feed（feed 抓取命令，feed.rs:57-90）

- **匿名直连用户提供的源站**：不拼网关、不带任何登录令牌、不做致命错误广播、无 AppHandle/State（feed.rs:1-9 刻意不抄 discover.rs 网关挂法；「不经服务端」是 B3 验收点）。
- **URL 门禁**（feed_url_error，feed.rs:21-27）：trim 首尾空白后 `Url::parse`，解析失败 → `这不是有效的订阅地址`；scheme 非 http/https（file/javascript/ftp…）→ `只支持 http/https 订阅源`。
- **UA**：浏览器 UA `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36`（feed.rs:61-64，用户自添源站常有 Cloudflare 等 403 非浏览器 UA，刻意不用 discover.rs 的产品 UA）；**20s 超时**（feed.rs:65）。
- **状态门禁**（status_error_text，feed.rs:31-40）：401/403 → `这个订阅源需要登录或拒绝了访问（{status}）`；其余非 2xx → `订阅源返回了 {status}`；2xx 放行。**无 content-type 门禁**（RSS 源响应头五花八门；「重定向到 HTML 页」的形状门禁在 TS 解析层做）。
- **大小门禁 2MB 两级**（content_length_gate，feed.rs:45-50）：`MAX_FEED_BYTES = 2_000_000`；第一级 content-length 头已知且 `> 2MB` 直接拒（不读 body）；第二级头未知（chunked）读满后按文本长度复查同一上限（`>` 才拒，恰 2MB 放行）。
- **resolve**：原始 feed XML 字符串（未解析；RSS/Atom 解析全在 TS 侧 feedCatalog）。

#### feed XML 解析契约（feedCatalog.ts）

- `parseFeedXml(xml)`（:219-227）：非字符串/空白 → null；`DOMParser("text/xml")` 严格解析，无 `<parsererror>` → `entriesFromDoc(strict)`；有 parsererror → 降级 `"text/html"` 宽松重解析一次（容忍 CDATA 外的 HTML 实体），再 `entriesFromDoc(loose)`。
- `isFeedShaped(doc)`（:181-187）：有 `<channel>` 或 `<feed>` 或 `<rss>` 才算 feed 形状（普通网页 → null，「重定向到 HTML 页」门禁）。
- `entriesFromDoc`（:191-212）：RSS `<item>` + Atom `<entry>` 并取；**缺 title 或 link 只丢该条不整份失败**；summary 一律 `textContent` 纯文本（绝不 innerHTML，XSS 防线），取 `description | summary | content` 首个非空。
- `entryLink(el)`（:155-169）：Atom `href` 属性优先（`rel=alternate` 优先，其次任一带 href），其次文本节点 `<link>`；text/html 降级路径下扫条目直接子文本节点里的 `^https?://` 兜底。
- `entryPublishedAt(el)`（:172-177）：`pubDate | pubdate | published | updated` 首个非空，`Date.parse` 失效返回 null。
- `feedTitleOf(doc)`（:231-237）：RSS `channel/title` 或 Atom `feed/title`，取不到空串（调用方以 host 兜底）。
- `mergeFeedEntries(perFeed)`（:244-256）：每条盖 bundle 的 feedId/feedTitle；排序键 `publishedAt ?? bundle.fetchedAt` 降序；截前 100。
- `normalizeFeedUrl(url)`（:128-132）：trim + 去尾部 `/+`；`findFeedByUrl(feeds, url)`（:136-140）按归一化 URL 查重。

### 1.5 边界与错误处理

- **目录级 vs 下载级双口径**：目录失败整块换 intake-fail 卡片（含重试）；下载失败换行内红字 + 重新下载；绝不白屏。
- **加载更多失败**：只记 `moreError`（列表下方一行），已加载内容不动（DiscoverTab.tsx:88-115）。
- **单下载在途**：任一下载进行中，全部下载按钮 disabled（防连点 429，DiscoverTab.tsx:70-72 注释）。
- **卸载竞态**：DiscoverTab 卸载时 `disposed = true; unlisten?.()`——进度事件 unlisten promise 晚到也不泄漏（DiscoverTab.tsx:126-141）。
- **feed null/[] 语义分离**：null=不是订阅（填错成普通网页）；[]=订阅暂无文章（照常入库，列表态走 FEED_EMPTY_TEXT，FeedTab.tsx:207-211）。
- **刷新失败聚合**：allSettled 单源失败不阻断，failedFeedIds 聚合计数 + 只补失败源的重试（FeedTab.tsx:163-174, 502-517）。
- **删除级联**：删订阅连同缓存、失败列表、打开中的预览一起清（FeedTab.tsx:242-256）。
- **截断算法边界**（cap_text_chars，web_extract.rs:30-44）：分隔符计入预算；首段恒保留；恰好放得下（含分隔符）不标 truncated；join 后总长严格 ≤ max_chars。
- **Windows 不做的**：无 setInterval 常驻轮询（切 tab 即卸载，FeedTab.tsx:10 注释）；订阅数据不进云同步；feed 抓取不带任何鉴权。

### 1.6 相关 Windows 单测及其行为向量

**Rust（cargo test）**：
- `feed.rs` tests（feed.rs:98-179）7 例：`url_gate_accepts_valid_http_and_https`（trim 后可用）、`url_gate_rejects_non_url_string`（`这不是有效的订阅地址` 逐字）、`url_gate_rejects_non_http_schemes`（file/javascript/ftp + 带空白 file:// 均 `只支持 http/https 订阅源`）、`length_gate_passes_unknown_and_under_limit`（None 放行、1,999,999 放行）、`length_gate_rejects_over_limit_on_both_sides`（恰 2,000,000 放行、2,000,001 → `订阅内容超过 2MB，已取消`）、`status_text_gives_dedicated_copy_for_401_and_403`、`status_text_includes_code_for_other_non_2xx` + `status_text_passes_2xx_through`。
- `discover.rs` tests（discover.rs:370-517）8 例：`book_id_accepts_slug_forms`（`alice`/`the-art-of-war-2`/恰 128 字符 ok）、`book_id_rejects_invalid_forms`（大写/`../etc/passwd`/空格/空/`a--b`/`a.epub`/129 字符全拒）、`query_pairs_defaults_page_1_per_page_20`、`query_pairs_blank_filters_dropped_and_values_kept`（空串过滤、`"po e"` 原值保留）、`query_pairs_passthrough_and_clamp`（grade 透传、page 0→1、perPage 500→100、perPage 0→1）、`progress_emits_every_256kb`（262,143 不报/262,144 报/增量 137,856 不报/恰 262,144 报/400,001 不报）、`retry_after_header_parsed_leniently`（37/无头/`soon`/` 42 `）、`download_result_serializes_camel_case`（`"retryAfterSeconds"` 无 snake_case）。
- `web_extract.rs` cap tests（web_extract.rs:396-451）：`cap_truncates_at_paragraph_boundary`（`"12345\n\n67890\n\nabc"` 限 10 → `"12345"` + truncated；`"12345\n\n6789"` 限 12 → 全保留不 truncated）、`cap_keeps_first_paragraph_even_if_over_limit`（单段 12 字限 5 → 原样返回不 truncated）、`cap_keeps_short_text_unchanged`、`extract_article_truncates_long_body`（40 段 ×250 词 ≈ 60,038 字符 → truncated=true、≤50,000、首段 HEADMARKER 保留、末段 TAILMARKER 消失）。

**TS（vitest）**：
- `feedCatalog.test.ts`（21 例，73-295）：RSS 2.0 字段解析/丢行；Atom href+published/updated、无日期 null；坏 XML→null、合法 HTML 页→null、空串→null、`&nbsp;` 实体 feed 走 text/html 降级成功、合法 0 条目→[]；feedTitleOf 三态；merge 降序/溯源/截 100 留最新/空输入；normalizeFeedUrl、findFeedByUrl 尾斜杠命中；RECOMMENDED_FEEDS ≥2 项 URL https 唯一/≥4 项/四源 URL 逐字锁定/全 .gov host；三文案常量逐字；feedInvokeErrorText 三分支。
- `feedStore.test.ts`（13 例，41-158）：空库 []、round-trip、坏 JSON []、非数组 []、逐行脏数据丢行好行保留、**落盘键名逐字断言**（`immersive-translator-reader-feeds` / `immersive-translator-reader-feed-entries`）；缓存空 {}、round-trip 含 publishedAt=null、坏 JSON {}、顶层数组/null {}、单源形状坏丢该源、条目缺 title/link 丢该条。
- `FeedTab.test.tsx`（15 例，194-477）：挂载即埋 feed_view + 空态与推荐区；手添成功链（归一化入库、chips 与列表渲染）；网络失败中文 message+重试且不入库；解析失败文案；重复添加不再发请求；推荐勾选即添加、按钮转「已添加」禁用；预置后「已添加」禁用；删除订阅回到空态；过期缓存自动刷新写回；**TTL 内二次挂载零请求** + 空条目 FEED_EMPTY_TEXT；手动刷新无条件全量；单源失败不阻断 + 重试只补失败源；点文章全链 onImport 参数 toEqual（sourceType/sourceUrl/level）+ feed_import 埋点；**truncated=true 显示「原文过长」、无标记不显示**；抓取失败 fail 卡 + 返回列表。
- `DiscoverTab.test.tsx`（14 例，165-373）：挂载埋 discover_view；装载成功卡片渲染；q 筛选 Enter 参数透传；grade 切换重拉 page 1；加载更多累计与按钮计数文案；进度 `{received:524288,total:812546}` → `0.5 MB / 0.8 MB…`；下载成功 onDeliver 收到 File 与 bookId；404 行内「当前不可下载」+ 重新下载；429 无秒数文案；reject network_error 文案；sha256 不匹配拦截；列表 reject intake-fail；200 坏 body「书库数据异常」；卸载取消进度订阅。
- `ImportDialog.test.tsx`（7 例 B2/B3 相关，203-380）：发现→下载→切 epub→parseEpub 真实解析→预览→draft 含 sourceBookId；parse 失败（`base64('not a zip')`）→ EpubTab error 卡；下载 404 停留发现 tab 行内错误无白屏；无注入直切 epub tab 回归冒烟；**七 tab 标签均渲染**；UrlTab truncated 提示；FeedTab 点开文章走导入管线 onImport 带 url 链参数。
- `discoverCatalog.test.ts`（15 例，44-199）：15 键全字段解析；缺省键 undefined；丢行不整页失败；坏信封 null；base64 已知向量往返；真摘要 true/篡改一位 false/非法 expected true 放行；epubFileOf 文件名与 type；formatFileSize（524288→`0.5 MB`、300000→`293 KB`）；**四个文案函数逐字断言**（含 401 下载文案、platform_unavailable 专属文案走 authErrorText 真实现兜底）。
- `tauriBridge.test.ts` 契约（290-372）：`books_list` 七键逐字透传、缺省全 undefined；`books_download` 404 信封原样 resolves + 200 base64 一例；`onBooksDownloadProgress` 事件名/payload 转发/unlisten 透传；`reader_fetch_feed` 命令名/参数恰为 `{ url }`（多出任何鉴权键即失败）/resolve 字符串原样透传；reject 原样透传（桥接层不做映射/catch）。
- `bookImport.test.ts`：`discoverImportProps` 分流两例（带 sourceBookId → `{ bookId }`；缺省 → null）。

---

## 2. Mac 落点设计

> 原则：Windows 的「Rust 命令层 + TS 解析层」在 Mac 落成「应用层 Service（URLSession）+ ReaderCore 纯函数层」——与 Mac 既有 `IntakeService.fetchArticle`（IntakeService.swift:125-180，应用层 URLSession）+ `ReaderCore/WebExtract.swift`（纯函数）的分层完全同构。纯函数全部下沉 ReaderCore 以便 XCTest 直测（Mac 无 jsdom 组件测试基建，行为向量以纯函数/Service 单测覆盖——`Tests/ReaderCoreTests/IntakeTests.swift` 既有先例）。

### 2.1 新建文件

| 文件 | 内容 | Windows 对应 |
|---|---|---|
| `Sources/ReaderCore/FeedCatalog.swift` | `FeedEntryItem`/`RecommendedFeed`/`FeedEntriesBundle`/`FEED_MERGE_LIMIT=100`、`RECOMMENDED_FEEDS` 四条（含剔除记录注释）、三文案常量、`feedInvokeErrorText`、`normalizeFeedUrl`/`findFeedByUrl`、`parseFeedXml`（XMLParser 严格 → 宽松降级 → isFeedShaped 门禁；`feedTitleOf`）、`mergeFeedEntries` | feedCatalog.ts 全文件 |
| `Sources/ReaderCore/DiscoverCatalog.swift` | `DiscoverBook`/`DiscoverPage`/`GRADE_LABELS`、`parseBooksPage`（JSONSerialization 信封 + 逐行守卫）、`verifyEpubSha256`（CryptoKit SHA256，expected 非 64 位 hex 或失败放行 true）、`formatFileSize`、四个文案函数（platform_unavailable 专属 + 其余走 `authErrorText`） | discoverCatalog.ts 全文件 |
| `Sources/ReaderCore/FeedGates.swift`（或并入 FeedCatalog） | `feedURLError`（trim + scheme 白名单）、`statusErrorText`、`contentLengthGate`（2,000,000 两级）纯函数 | feed.rs:21-50 |
| `Sources/ReaderCore/DiscoverGates.swift`（或并入 DiscoverCatalog） | `validateBookId`（slug 白名单 + 限长 128）、`buildQueryPairs`（trim 过滤/page max(1)/perPage clamp 1…100）、`shouldEmitProgress`（`received - last >= 262_144`）、`parseRetryAfter` 宽松解析 | discover.rs:92-156 |
| `Sources/ImmersiveTranslator/DiscoverService.swift` | `booksList(query)` / `booksDownload(bookId, onProgress:)`：URLSession，base = `ServerAuthConfiguration.resolveBaseURL()`，可选 Bearer（`try? await auth.manager.getAccessToken()` 成功才带，失败走匿名，绝不因取票失败拒绝），UA `ImmersiveTranslator/{CFBundleShortVersionString}`，目录 30s / 下载 300s；非 2xx 是数据（`AuthHttpResponse { status, retryAfterSeconds, body }` 同构 `SyncHttpText`，ServerAuth.swift:86-90）；下载 200 流式收字节（URLSession bytes 或 `expectedContentLength`+data，每满 256KB 回调 `{bookId, received, total}` + 收完补终值），字节以 `Data` 直接返回（无 base64 跨 IPC 步骤）；id 预校验不合式本地返回 400 信封 | discover.rs 命令层 |
| `Sources/ImmersiveTranslator/FeedStore.swift` | `FeedSubscription`/`FeedCacheEntry` + load/save（UserDefaults 两键 `immersive-translator-reader-feeds` / `immersive-translator-reader-feed-entries`，键名逐字对齐 Windows localStorage；坏 JSON/坏形状回默认、逐行守卫丢脏行、save 失败静默） | feedStore.ts |
| `Tests/ReaderCoreTests/FeedCatalogTests.swift` | 见 2.4 | feedCatalog.test.ts |
| `Tests/ReaderCoreTests/DiscoverCatalogTests.swift` | 见 2.4 | discoverCatalog.test.ts |
| `Tests/ReaderCoreTests/FeedStoreTests.swift` | 见 2.4（注入 UserDefaults suite） | feedStore.test.ts |
| `Tests/ReaderCoreTests/DiscoverServiceTests.swift`（纯函数部分） | 见 2.4 | discover.rs tests |

### 2.2 修改文件（附证据行号）

1. **`Sources/ReaderCore/WebExtract.swift`**：`FetchedArticle`（:8-20）加 `public var truncated: Bool = false`（可选语义对齐 webExtract.ts:19）；新增 `public let maxArticleChars = 50_000` + `public func capTextChars(_ text: String, maxChars: Int) -> (String, Bool)`（整段保留、分隔符计入预算、首段恒保留——逐句对齐 web_extract.rs:30-44）；`extractArticle`（:25-40）在词数门槛判定**之后**截断并回填 truncated。
2. **`Sources/ImmersiveTranslator/IntakeService.swift`**：`fetchArticle`（:125-180）html 抽取路径与 text/plain 路径（:167-179）都过 `capTextChars`；新增 `fetchFeed(url: String) async throws -> String`——复用同文件 URLSession 模式（:114-121 浏览器 UA + 20s 超时），依次过 `feedURLError`/状态门禁/2MB 两级门禁（`HTTPURLResponse.expectedContentLength` 已知且 >2MB 先拒；读满按 `data.count` 复查），reject 抛 `FileImportError(中文)`。
3. **`Sources/ReaderCore/BookImport.swift`**：`BookImportDraft`（:89-116）加 `public var sourceBookId: String?`（init 缺省 nil，向后兼容）；`buildBookImportDraft`（:385-405）加 `sourceBookId: String? = nil` 参数透传；新增 `public func discoverImportProps(_ draft: BookImportDraft) -> [String: String]?`。
4. **`Sources/ImmersiveTranslator/ReaderIntakeSheet.swift`**：
   - `IntakeTab` 枚举（:26-32）加 `case discover = "发现书库"`、`case feed = "资讯订阅"`（七 tab，顺序对齐 ImportDialog.tsx:174-183）；
   - `ReaderImportSheet` 加 `@State pendingEpub: EpubTabInjected?` 与 `initialTab: IntakeTab = .lib` 入参（对齐 ImportDialog `initialTab` 契约，ImportDialog.tsx:61-65）；body switch（:51-80）加两 case：discover 的 `onDeliver` 同帧 `pendingEpub = …; tab = .epub`（SwiftUI 同一 render cycle 内两状态同帧生效，对齐 ImportDialog.tsx:225-229 注释）；epub case 传 `injected: pendingEpub` + `onInjectedConsumed: { pendingEpub = nil }`；
   - `IntakeBookTab`（:452-836）加 `injected`/`onInjectedConsumed` 入参与一次性消费（`injectedConsumed` flag 防重入，对齐 ImportDialog.tsx:874-910）；`PreviewState`（:458-465）加 `sourceBookId: String?`，`confirmImport`（:733-758）透传进 `buildBookImportDraft`；
   - 新增 `IntakeDiscoverTab` / `IntakeFeedTab` 两个 private struct（状态机、交互流、文案照 §1.1/§1.2 逐字复刻）；
   - `IntakeUrlTab` 预览卡（:1131-1190）加 truncated 提示行（对齐 ImportDialog.tsx:643）。
5. **`Sources/ImmersiveTranslator/ReaderViewModel.swift`**：`importSheetShown`（:222）旁加 `importSheetTab: IntakeTab = .lib` + `func openImport(tab: IntakeTab = .lib)`（含白名单语义：tab 值来自枚举天然受限，对齐 ReaderApp.tsx:376-379）；`importBook`（:926-970）入库成功 toast 后（:966）补 `discoverImportProps(draft)` 非空则埋 discover_import（对齐 ReaderApp.tsx:1536-1538）。
6. **`Sources/ImmersiveTranslator/ReaderViews.swift`**：sheet 挂载（:78-80）传 initialTab；`ShelfHomeView`（:889 起）在书卡区后补「发现更多可读内容」三列卡（:642-666 的 Mac 对应，`vm.openImport(tab: .discover/.feed/.lib)`）；既有「导入」按钮（:959-973）改走 `vm.openImport()`（缺省 lib，行为不变）。
7. **`Sources/ReaderCore/TelemetryEvent.swift`**：工厂区（:93-157）加 `feedView()`（name `feed_view`，空 props）、`feedImport(host: String)`（name `feed_import`，props `{host}`）、`discoverView()`（name `discover_view`）、`discoverImport(bookId: String)`（name `discover_import`，props `{bookId}`）——事件名与字段名逐字对齐 Windows。
8. **`Sources/ImmersiveTranslator/ReaderTelemetry.swift`**：无需改（`track` :9-14 直接可用）；discover_view/discover_import 在 Mac 走本地 JSONL（Windows 走云端 /v1/events，见 §4 平台差异与风险）。

### 2.3 与 Mac 既有架构的衔接

- **网络层**：`IntakeService` 的 URLSession + ephemeral + UA + 超时模式（IntakeService.swift:114-121）是 feed 抓取的直接宿主；`DiscoverService` 自建 client（需产品 UA 与 300s 长超时，不复用 20s 的 intake session），鉴权与传输复用 `ServerAuth` 件：`ServerAuthConfiguration.resolveBaseURL()`（ServerAuth.swift:113-124，两层机制与 Windows auth.rs:220-228 同源契约）、可选 Bearer 用 `AuthTokenManager.getAccessToken()`（ServerAuth.swift:463-483，`try?` 吞错走匿名——**绝不用 `withAuth`**，它会因未登录直接 reject，违背匿名端点口径）；错误信封复用 `AuthHttpResponse`（ServerAuth.swift:86-90）与 `authErrorText`（:778-799，文案表与 Windows authErrorText.ts 逐字同源，`network_error`→`网络连接失败，请检查网络后重试` 已就位）。
- **存储层**：`FeedStore` 照 `IntakeService.examGoal`（IntakeService.swift:16-27）用 UserDefaults 保留 Windows 键名（Mac 无 localStorage 的既定替代，先例即键名逐字沿用）；**不接 ReaderStore 云同步链路**（Mac ReaderStore 本就纯本地，Windows 侧刻意不用 sync_store_* 的口径自然成立）。
- **导入管线**：FeedTab 点文章 → `IntakeService.fetchArticle`（已存在）→ 预览卡 → `vm.importText(text, title:, meta: ImportMeta(sourceType: .url, sourceUrl: link, level:))`（ReaderViewModel.swift:1008-1036，与 IntakeUrlTab 确认导入 :1169-1179 同链）；DiscoverTab 下载 → `parseEpub(data:fileName:)`（BookImport.swift:139，fileName 用 `"{bookId}.epub"` 保持扩展名校验）→ `IntakeBookTab` 预览/勾选 → `vm.importBook(draft)`（ReaderViewModel.swift:926）。
- **埋点**：`ReaderTelemetry.track(TelemetryEvent)`（ReaderTelemetry.swift:9-14 → ProviderCore EventTelemetry JSONL）承载 feed_view/feed_import（+ Mac 侧 discover_view/discover_import，见 §4）。
- **UI 惯例**：Phase 枚举状态机 + `failView` + 「切到粘贴文本」退路照 `IntakeUrlTab`（ReaderIntakeSheet.swift:1047-1209）；考试目标行复用 `IntakeGoalRow`（:146-173）；骨架/进度照 `IntakeBookTab.parsingView`（:555-563）。

### 2.4 需补的 Swift 测试清单（与 Windows 单测行为向量对齐）

1. `FeedCatalogTests`（≈21 例向量照 §1.6 feedCatalog.test.ts）：RSS 2.0 字段解析与丢行；Atom href/published、无日期 null；坏 XML→nil、HTML 页→nil、空串→nil、**实体 feed 宽松降级成功**、合法 0 条目→[]（nil 与 [] 语义分离）；feedTitleOf 三态；merge 降序/溯源/截 100/空输入；normalize/findFeedByUrl；RECOMMENDED_FEEDS 四条 URL 逐字 + 全 .gov + https 唯一；三文案常量逐字断言。
2. `DiscoverCatalogTests`（≈15 例）：15 键全字段；缺省键；丢行不整页；坏信封 nil；**CryptoKit 真摘要 true / 篡改一位 false / 非法 expected true 放行**；formatFileSize 边界（524288→`0.5 MB`、300000→`293 KB`）；四文案函数逐字（含 401 下载文案、platform_unavailable 专属、rateLimitedText 秒数有无）。
3. `FeedStoreTests`（≈13 例）：空/round-trip/坏 JSON/坏形状/逐行丢行；**UserDefaults 键名逐字断言**；缓存单源形状坏丢该源、条目缺 title/link 丢该条、publishedAt=null 保真。
4. `DiscoverServiceTests`（纯函数，≈8 例照 discover.rs tests）：validateBookId 七坏一好边界；queryPairs 默认/过滤/clamp；shouldEmitProgress 五断言（262,143/262,144/增量 137,856/524,288/400,001）；parseRetryAfter 四态。
5. `FeedGatesTests`（≈7 例照 feed.rs tests）：URL 门禁 trim/非 URL/非 http scheme 三文案逐字；2MB 门禁 None/1,999,999/2,000,000 放行与 2,000,001 拒（文案逐字）；401/403/404/500/2xx 状态文案。
6. `IntakeTests` 追加（≈5 例照 web_extract.rs cap tests）：截断边界四例 + 长文真抽取 truncated 标记与首段保留/末段消失；`FetchedArticle.truncated` 默认 false 不影响既有断言（Equatable 兼容）。
7. `BookImportTests` 追加：`buildBookImportDraft(sourceBookId:)` 透传 + `discoverImportProps` 分流两例；`IntakeBookTab` 注入一次性消费（解析函数调用计数）以纯函数/可注入闭包形态测。
8. `TelemetryEventTests` 追加：四工厂 name/props 编码逐字（`feed_view`/`feed_import{host}`/`discover_view`/`discover_import{bookId}`）。
9. `ReaderShellChromeTests`（ImmersiveTranslatorTests）追加：`openImport(tab:)` 白名单语义与 importSheetTab 状态；七 tab rawValue 顺序断言（对齐 ImportDialog.test「七 tab 标签均渲染」）。

---

## 3. 逐条验收清单（1:1 保真检查点）

1. 导入弹窗含七个 tab，标签与顺序逐字为「内置文库 / EPUB / 长书 / 本地文件 / 网页链接 / 粘贴文本 / 发现书库 / 资讯订阅」。
2. 书架出现「发现更多可读内容」三列卡，文案逐字对齐 §1.2，点击分别直达 discover/feed/lib 初始 tab。
3. 发现 tab 挂载即上报 discover_view（Mac 本地 JSONL，事件名/props 逐字），且未登录时 tab 恒可见可用（不隐藏/不置灰/不提示登录）。
4. booksList 请求：base 为 `ServerAuthConfiguration.resolveBaseURL()`，路径 `/v1/books`，五筛选 trim 后非空才进查询串，page 缺省 1 且 ≥1，perPage 缺省 20 且 clamp 1…100，UA 为 `ImmersiveTranslator/{版本}`，超时 30s。
5. 已登录时 booksList/booksDownload 带可选 Bearer；未登录或取票失败走匿名完成请求，绝不因取票失败报错。
6. 非 2xx 的目录/下载应答是**数据**不是异常：前端按状态映射 §1.2 的中文文案（400/404/429 插值/其余），429 秒数缺失回落通用文案。
7. 200 但信封解析失败显示整块错误卡「书库数据异常，请稍后重试；若持续出现请更新应用」+ 重试。
8. 下载 id 先过本地白名单预校验（`^[a-z0-9]+(-[a-z0-9]+)*$` ≤128），不合式不发网络、返回 400 信封 `{"error":{"code":"validation_error","message":"书目 id 不合法"}}`。
9. 下载 200 的字节经 SHA-256（CryptoKit）与目录 `sha256` 比对：不匹配行内「下载的文件校验失败，请重新下载」不上抛；expected 非 64 位 hex 或能力不可用放行。
10. 下载进度按每满 262,144 字节回调一次 `{bookId, received, total}` 并在收完补终值；UI 展示 `0.5 MB / 0.8 MB…`，total 未知时 `下载中…0.3 MB`。
11. 同一时刻至多一个下载在途，其余下载按钮禁用。
12. 下载成功后同帧切到「EPUB / 长书」tab 并注入 `<bookId>.epub`，走既有 parseEpub→预览→勾选→入库链；注入只消费一次（防重入），本地文件导入路径行为零变化。
13. 入库草稿带 `sourceBookId`，入库成功 toast 后上报 discover_import `{bookId}`；本地导入不埋。
14. 订阅数据只落本地（UserDefaults 两键名逐字为 `immersive-translator-reader-feeds` / `immersive-translator-reader-feed-entries`），坏 JSON/坏形状回默认、脏行只丢该行、写失败静默，绝不进任何云同步。
15. feed 抓取匿名直连源站：无网关前缀、无 Authorization 头、无任何鉴权键；浏览器 UA + 20s 超时。
16. feed URL 门禁三文案逐字（`这不是有效的订阅地址` / `只支持 http/https 订阅源`），file/javascript/ftp 与带空白变体均被拒。
17. 2MB 两级门禁：content-length 已知超限不读 body 直接拒；未知读满复查；文案 `订阅内容超过 2MB，已取消`。
18. 状态门禁文案逐字：401/403 `这个订阅源需要登录或拒绝了访问（{status}）`；其余非 2xx `订阅源返回了 {status}`；2xx 放行且不做 content-type 拒绝。
19. 解析层：严格 XML 解析失败降级宽松重解析一次；无 channel/feed/rss 标记返回 nil（普通网页门禁）；合法 0 条目返回 []；缺 title/link 只丢该条；summary 只取等价 textContent 纯文本。
20. 添加订阅链：归一化（trim+去尾斜杠）→ 查重 `这个订阅已在列表中`（不发请求）→ 拉取校验 → 频道名（取不到以 host 兜底）→ 入库并立即写缓存 → 清空输入；进行中按钮显示「正在添加…」并禁用。
21. 推荐区四源（NASA/CDC/NIST/Energy）URL 与中文 note 逐字；已添加行按钮「已添加」禁用；勾选走同一添加链。
22. 刷新策略：挂载对 fetchedAt 超 10 分钟的订阅并行自动刷新（单源失败不阻断），TTL 内二次进入零请求；手动「刷新」无条件全量；失败聚合计数「{n} 个订阅刷新失败」+ 只补失败源重试。
23. 合并列表按 publishedAt 降序（缺省回退该源 fetchedAt）、截前 100 条、每条带源名溯源；摘要超 120 字截断加「…」；相对时间文案（刚刚/分钟前/小时前/天前）。
24. 点文章 → 网页正文抓取 → 预览卡（来源行 `{host} · 来自订阅「{feedTitle}」`、词数/段数/分钟、覆盖数、180 字摘要）→「加入书架并开始阅读」以 `{sourceType: url, sourceUrl: 文章 link, level}` 调 importText；同帧埋 feed_import `{host}`。
25. 正文超 50,000 字符时按整段边界截断（分隔符计入预算、首段恒保留、join 后总长 ≤50,000），FetchedArticle.truncated=true，UrlTab 与 FeedTab 预览卡均显示「原文过长，仅导入前 50,000 字符」；未截断不显示。
26. 付费墙判定按原文全量词数（截断不影响「只抓到 N 个词」错误路径）。
27. 所有用户可见错误文案与 §1.2 表格逐字一致，无白屏、无英文裸错误。
28. §2.4 所列 Swift 测试全部落地且通过，行为向量覆盖对应 Windows 单测清单（feed 21+13+15、discover 15+14+8、gates 7、cap 5、契约/埋点若干）。
29. 既有五入口（文库/EPUB/文件/链接/粘贴）行为与文案零变化（回归）。

---

## 4. 平台差异清单（仅平台必然差异）

| # | 差异 | 理由 |
|---|---|---|
| 1 | **IPC 形态**：Windows `books_download` 以 base64 文本跨 Tauri IPC（1.33x 膨胀，screenshot.rs 先例）+ `books:download:progress` 事件；Mac 同进程内直接传 `Data` 字节，进度走回调/AsyncSequence | 无 IPC 边界即无序列化税；字节内容、SHA-256 校验、进度节流公式等可观察行为完全一致 |
| 2 | **base URL 通路**：Windows 经 auth.rs 私有 `resolve_base_url` 唯一 pub 口 `gateway_endpoint()` 剥 `/v1/chat/completions`（auth.rs:894-898）+ `platform_available` 开关（auth.rs:159,190）；Mac 经 `ServerAuthConfiguration.resolveBaseURL()`（ServerAuth.swift:113-124，server_endpoint.json 两层机制同源），无 PLATFORM_PUBLIC 灭灯开关 | 两端 auth.rs/ServerAuth.rs 架构不同；服务契约（同 base 服务 /v1/books）一致。Mac 无 kill-switch 属架构缺口而非行为设计，见风险 |
| 3 | **浏览器 UA 平台段**：feed 抓取 UA 的 `Windows NT 10.0; Win64; x64` 在 Mac 用 `Macintosh; Intel Mac OS X 10_15_7`（Chrome/126 家族其余逐字一致） | UA 平台段应与所在 OS 一致；Mac 既有 `IntakeService.fetchArticle` UA 先例（IntakeService.swift:118）。反爬效果等价 |
| 4 | **XML 解析器**：DOMParser+parsererror+text/html 降级 → Foundation XMLParser 严格 + 手写宽松兜底；`Date.parse` → `DateFormatter(en_US_POSIX, "EEE, dd MMM yyyy HH:mm:ss zzz")` + ISO8601 组合 | 无 DOM API；解析语义（形状门禁/丢行/null vs []）必须逐条等价，仅实现载体不同 |
| 5 | **本地存储**：localStorage → UserDefaults（键名逐字沿用） | 无 localStorage；`IntakeService.examGoalKey` 沿用 Windows 键名的既定先例（IntakeService.swift:17） |
| 6 | **随机 id**：`crypto.randomUUID()` → `UUID().uuidString` | Foundation 无 webcrypto；生成语义相同（降级分支 Mac 不需要） |
| 7 | **文件句柄**：`new File([bytes], "{id}.epub")` → 直接 `Data` + fileName 字符串传 `parseEpub(data:fileName:)` | Swift 无 File blob；`<bookId>.epub` 文件名与扩展名校验行为保持 |
| 8 | **discover 埋点通道**：Windows discover_view/discover_import 走云端 POST /v1/events（白名单+Bearer+静默）；Mac 目前无云端 analytics 客户端，规格落本地 JSONL（事件名/props 逐字相同） | Mac 侧该子系统缺失（grep `v1/events` 零命中）。**非平台必然差异**——若要求云端逐字对齐，可后续用 `ServerAuth.withAuth` 补 /v1/events 客户端；已列入风险 |

---

### 风险与待决

- `immersive-translator-server/` 不在本工作区，/v1/books 契约重建自客户端代码与升级计划文档；若服务端实际信封/字段有出入，以 `discoverCatalog.parseBooksPage` 的容错口径（丢行不整页失败）兜底，但 15 键行形状需在联调时对一次。
- Mac 无 `platform_available` 灭灯开关：Windows 沉浸云未开放期发现页整页关闭（`书库服务暂未开放，请稍后再试`）；Mac `resolveBaseURL` 恒有值（dev 缺省），该错误路径在 Mac 仅在请求构造失败时可达。若需要同款运营开关，须另加配置门（本规格未擅自发明）。
- discover 埋点云端缺口见差异表 #8；feed_view/feed_import 本地 JSONL 两端通道一致，无缺口。
- Windows 组件测试（FeedTab/DiscoverTab/ImportDialog .test.tsx）依赖 jsdom 渲染断言；Mac 无对应基建，行为向量以纯函数 + Service + ViewModel 测试覆盖（§2.4），视图层逐字文案靠验收清单人工比对。
