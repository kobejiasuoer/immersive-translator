# Mac 1:1 移植规格：翻译 429 自动退避与失败原因透出（zhError 全链路）

- 对齐基线：Windows commit `bc0f625f7a4e4ebb073b3881d063dca15fa9734d`（feat(app): 翻译 429 自动退避与失败原因透出——zhError 契约/存储/UI 全链路 + 标题失败原因 + 中途切文清 chip），提交信息与文件清单已用 `git show bc0f625 --stat` 核实。
- 本文所有 Windows 锚点均为**当前 main 工作区实证行号**（不是 diff 行号），逐条读过原文。
- 服务端说明：任务书提到的 `immersive-translator-server/` 目录在本工作区**不存在**（`ls` 仓库根核实，只有 immersive-translator-windows / -mac / -mobile / packages / contracts / website / prototypes 等）。翻译 429 在本功能里是**客户端侧对上游 LLM 网关的 HTTP 状态码识别**，不依赖服务端改动；涉契约处以 `contracts/reading-room.schema.json` 为准（已实证）。Mac 端阅读室翻译走 `ReaderChatClient`（API Key 直连第三方 OpenAI 兼容端点，无沉浸云 gateway 分支），服务端无涉。

---

## 1. Windows 行为规格

### 1.1 功能入口与交互流

**入口（自动管线）**：打开/导入文章后 `openArticle` 调 `ensureTranslated(migratedArticle)`（`immersive-translator-windows/src/reader/ReaderApp.tsx:1238`）。`ensureTranslated`（`ReaderApp.tsx:849`）先校验翻译配置，未配置则 toast `先在设置里配置翻译接口，译文才会自动生成` 并直接返回（`ReaderApp.tsx:852-854`）；否则按 `paragraphIdx` 把 `zhState === "pending"` 的句子分组成段（`ReaderApp.tsx:859-866`），置「翻译中」chip `{done:0, total:pendingGroups.length}`（`ReaderApp.tsx:874`，注意 total **不含**标题），然后：

1. **标题**（`titleCnState === "pending"` 时）：单发一次 `requestTranslate(input.title, buildTitleTranslateSystemPrompt(target), tag)`（`ReaderApp.tsx:876-878`）。成功 → 清 `titleCnError`（`ReaderApp.tsx:880`）并写 `titleCn/titleCnState:"done"`（空行回落 `failed`）；error → `setTitleCnError(readerParagraphErrorText(res.httpStatus))`（`ReaderApp.tsx:889`）+ `titleCnState:"failed"`（`ReaderApp.tsx:890`）。**标题不参与 429 退避**——它只发一次，失败即止。
2. **段落循环**：整篇共享一个退避计数 `let runBackoffs = 0`（`ReaderApp.tsx:894-896`，注释明确「跨段共享；手动重试发起的新 run 从 0 重新起算」）。每段处理前先做 **B1 检查**：`articleRef.current?.id !== input.id`（中途切到别的文章）→ `setTranslating(null)` 清 chip 再 `return`（`ReaderApp.tsx:898-903`）。
3. **段内 429 退避循环**（`ReaderApp.tsx:924-948`）：首次请求 tag = `rp{++translateSeqRef}`；之后
   ```ts
   for (let wait; (wait = planTranslateRetry({
     httpStatus: res.status === "error" ? res.httpStatus : null,
     groupRetries, runBackoffs,
   })) !== null; ) {
     groupRetries += 1; runBackoffs += 1;
     await new Promise<void>((r) => window.setTimeout(r, wait));   // 固定 20s
     if (articleRef.current?.id !== input.id) { setTranslating(null); return; }  // 退避期间切走：先清 chip 再退出（ReaderApp.tsx:940-944）
     tag = `rp${++translateSeqRef.current}`;                        // 重试换新 tag 防事件误路由（ReaderApp.tsx:946）
     res = await requestTranslate(paraInput, systemPrompt, tag, onDelta);  // systemPrompt/onDelta 与首次相同
   }
   ```
4. **收尾分桶**：done → `parseParagraphResponse` 对齐成功则逐句 `zhState:"done"`（`ReaderApp.tsx:949-959`）；**对齐失败（parse 得 null）→ `markParagraphFailed(sentences)` 不带原因**（`ReaderApp.tsx:960-961`，zhError 落 undefined）；cancelled → 部分解析救回可救句子、其余 failed（无原因，`ReaderApp.tsx:963-977`）；error → `markParagraphFailed(sentences, readerParagraphErrorText(res.httpStatus))`（`ReaderApp.tsx:978-980`）。每段完成 `done += 1`，未到最后一段更新 chip，最后一段置 null（`ReaderApp.tsx:981-982`）；循环外再兜底 `setTranslating(null)`（`ReaderApp.tsx:984`），随后 `ensureAnnotated()`（`ReaderApp.tsx:986`）。

**手动重试入口**：
- 段落：`retryParagraph(paragraphIdx)`（`ReaderApp.tsx:1002-1022`）先把该段 failed 句重置 `{ zh: null, zhState: "pending", zhError: undefined }`（**清 zhError 在此**，`ReaderApp.tsx:1008`），再 `ensureTranslated(仅该段 sentences)` → 新 run，`runBackoffs` 从 0 重算，退避循环同样生效。
- 标题：`retryTitle()`（`ReaderApp.tsx:1024-1029`）先 `setTitleCnError(null)`（`ReaderApp.tsx:1025`），置 `titleCnState:"pending"` 后 `ensureTranslated({..., titleCnState:"pending", sentences: []})` 只重跑标题。

**httpStatus 的来路（结构化状态码，绝不匹配响应文本）**：Rust `translate_stream` 发 `translation:error` 事件，负载 `ErrorEvent { kind: "http"|"network"|"timeout"|"empty"|"invalid", status: Option<u16>, body, elapsed_ms, tag }`（`immersive-translator-windows/src-tauri/src/translation.rs:109-118`）：
- HTTP 非 2xx：`status: Some(真实状态码)` + body 原文（`translation.rs:493-508`）——429/401/500 都走这里；
- 沉浸云平台请求但未登录：**客户端自拟信封** `kind:"http", status:Some(401)`，body 为合成 JSON（`translation.rs:384-397`）；平台 401 且 code=token_expired 时单飞刷新后重放一次，其余 401 原样抛（`translation.rs:444-489`）；
- 网络/超时/地址无效：`status: None`（`translation.rs:330-341`、`355-368`）。
前端 `onTranslationError` 把 `e.status` 一并传给 `p.onError(e.body || \`HTTP ${e.status ?? ""}\`, e.status)`（`ReaderApp.tsx:611-616`）；`requestTranslate` 的 Promise 结果带 `httpStatus`，超时(180s)/未配置/调用异常的 httpStatus 一律 `null`（`ReaderApp.tsx:630-682`，超时 652、未配置 662）。

### 1.2 UI 状态与用户可见文案（原样抄录）

**段落失败行（prose 浮层与 parallel 两分支代码逐字相同）**，`immersive-translator-windows/src/reader/ReadingView.tsx:701-708`（prose-pop）与 `:754-761`（parallel）：

```
本段翻译失败
{s.zhError ? <span style={{ fontSize: 11, opacity: 0.8 }}>{s.zhError}</span> : null}
<button onClick={() => props.onRetryParagraph(s.paragraphIdx)}>重试本段</button>
```
- 行容器 `.pair-failed-row`：`display:inline-flex; gap:8px; color:var(--err); font-size:12px`，按钮 accent 色 12px（`src/reader/reader.css:620-639`）。原因小字 = 错误色、11px、opacity 0.8；**zhError 缺省时渲染与旧行为完全一致（无小字）**。

**标题失败行**，`ReadingView.tsx:1071-1081`：
```
标题翻译失败
{props.titleCnError ? <span style={{ opacity: 0.85 }}>（{props.titleCnError}）</span> : null}
<button ... onClick={props.onRetryTitle}>重试</button>
```
- 容器 `color: var(--err); fontSize: 13`；原因用**全角括号**包裹、opacity 0.85。

**失败原因文案（按 HTTP 状态码三桶定稿，绝不透传上游消息）**，`immersive-translator-windows/src/core/errorMessageFormatter.ts:462-471`：
| status | 文案（逐字） |
|---|---|
| 429 | `翻译请求太频繁，已重试仍被限流，稍后点重试` |
| 401 | `登录状态已失效，请到 设置 → 账号 重新登录` |
| 其它/null/undefined（500、超时、未配置等） | `翻译服务暂时不可用，请稍后点重试` |

注释原文（`errorMessageFormatter.ts:462-466`）：401 桶同时覆盖「平台未登录合成 401」与上游真 401；兜底桶同时覆盖未配置与 180s 超时——已接受的取舍。

**「翻译中」chip**：`翻译中 {done}/{total} 段`（`ReadingView.tsx:842-846`）。

**退避参数**，`immersive-translator-windows/src/core/paragraphTranslate.ts:106-129`：
- `TRANSLATE_BACKOFF_WAIT_MS = 20_000`（固定 20s，注释「服务端 Retry-After 本轮不接线」）
- `TRANSLATE_MAX_GROUP_RETRIES = 1`（每段最多自动重试 1 次，不含首次）
- `TRANSLATE_MAX_RUN_BACKOFFS = 6`（整篇退避总次数上限，最坏 +2 分钟）
- `planTranslateRetry({httpStatus, groupRetries, runBackoffs}) -> number | null`：非 429 → null；groupRetries≥1 → null；runBackoffs≥6 → null；否则 20000。

### 1.3 数据结构与本地存储

- **TS 类型**：`SentencePair.zhError?: string`，注释「段落失败原因（按 HTTP 状态码定稿的中文文案；重试成功后清空）」（`immersive-translator-windows/src/core/readerTypes.ts:66-67`）。
- **契约**：`contracts/reading-room.schema.json` `$defs/sentencePair.properties.zhError`，`{"type":"string","description":"段落失败原因（按 HTTP 状态码定稿的中文文案；重试成功后清空）"}`（`contracts/reading-room.schema.json:113-116`）；非 required，可选字段对老数据零破坏、schemaVersion 维持 1（契约头描述 `:5`）。**契约已含 zhError，Mac 无需改契约，只需实现**。
- **Rust 存储**：`SentencePair.zh_error: Option<String>`，`#[serde(default, skip_serializing_if = "Option::is_none")]`（`immersive-translator-windows/src-tauri/src/reader_store.rs:87-89`）；保存走 `reader_save_article`（`reader_store.rs:699`）。前端 `patchArticle → scheduleSave`（700ms 防抖）→ `readerSaveArticle`（`ReaderApp.tsx:704-722`）。
- **瞬态（不落盘）**：`titleCnError` 是 React state，重启后只剩「标题翻译失败」无原因（`ReaderApp.tsx:276` 注释）。
- **zhError 生命周期**：仅 HTTP 错误桶写入（markParagraphFailed，`ReaderApp.tsx:988-997`）；parse 对齐失败与 cancelled 兜底 failed **不写**；`retryParagraph` 重置 pending 时清空（`ReaderApp.tsx:1008`）；重试成功句子被覆盖为 done（此时 zhError 已在重置时清掉）。

### 1.4 网络端点与请求/响应契约

- 请求由前端 `translateStream({text, endpoint, apiKey, model, systemPrompt, stream, windowLabel:"reader", tag})` invoke Rust `translate_stream`（`immersive-translator-windows/src/lib/tauriBridge.ts:300-303`；`translation.rs:343-348`）；结果经 Tauri 事件 `translation:delta|done|error|cancelled` 回传，监听器 `tauriBridge.ts:306-322`，`ErrorEvent` TS 类型 `{kind, status: number|null, body, elapsedMs, tag}`（`tauriBridge.ts:41-48`）。
- 端点归一化为 `/v1/chat/completions`（`translation.rs:121-153`）；第三方用 API Key Bearer，沉浸云平台用登录令牌（`translation.rs:419-429`）。**429 判定只看 `ErrorEvent.status === 429`**，与端点是谁无关；本工作区无服务端代码可读（目录不存在，已核实），客户端不消费 `Retry-After` 头。
- Mac 对应请求体语义（供参照）：`ReaderChatClient.buildBody` 用户文本 `<text>` 包裹、temperature 0.2（`immersive-translator-mac/Sources/ImmersiveTranslator/ReaderChatClient.swift:101-122`），与 Windows translation.rs 一致。

### 1.5 边界与错误处理

1. **仅结构化 429 触发退避**：500/401/超时/未配置/网络错误（httpStatus null）一律不重试（`paragraphTranslate.ts:125`）。绝不匹配响应文本。
2. **双配额**：每段 ≤1 次自动重试；整篇（一个 run 内）退避等待 ≤6 次；手动重试段落/标题 = 新 run，配额重置。
3. **退避期间切文章**：等待醒来后先查 `articleRef.current?.id !== input.id` → 清 chip 退出，**不再发重试请求**（`ReaderApp.tsx:940-944`）。
4. **B1 修复**：段循环顶部同款检查（`ReaderApp.tsx:898-903`）——`ensureAnnotated` 有 try/finally 兜底而本函数没有，裸 return 会让 chip 永久卡死。
5. **180s 请求超时**：`httpStatus: null` → 不退避，落兜底文案（`ReaderApp.tsx:652`）。
6. **parse 对齐失败**：HTTP 200 但编号行对不齐 → failed 无原因小字（`ReaderApp.tsx:960-961`）。
7. **重试请求复用**：`systemPrompt`/`onDelta`（流式部分解析）与首次完全相同，仅 tag 换新（`ReaderApp.tsx:945-947`）。
8. **老数据兼容**：无 zhError 字段的存量 JSON 正常加载（serde default）。

### 1.6 相关 Windows 单测及其行为向量

已运行：`npx vitest run src/core/paragraphTranslate.test.ts src/core/errorMessageFormatter.test.ts src/reader/ReadingView.cloze.test.tsx`（在 `immersive-translator-windows/` 下）→ **3 个文件 65 个用例全部通过**（16+40+9）。Rust 侧 `cargo test` 未运行（无 target 缓存、Tauri+windows 依赖全量编译过重，且该目录对本任务只读）；其行为向量按源码记录如下。

| 测试 | 位置 | 行为向量 |
|---|---|---|
| `planTranslateRetry` | `src/core/paragraphTranslate.test.ts:78-111` | ① `{429,0,0}` → `20000`（且常量=20_000）；② `{429,1,0}` → null（每段最多 1 次）；③ `{429,0,6}` → null（整篇 ≤6；常量=1/6）；④ `{500,0,0}` → null（非 429）；⑤ `{null,0,0}` → null（超时/未配置等非 HTTP 失败） |
| `readerParagraphErrorText` | `src/core/errorMessageFormatter.test.ts:434-447` | ① 429 → `翻译请求太频繁，已重试仍被限流，稍后点重试`；② 401 → `登录状态已失效，请到 设置 → 账号 重新登录`；③ 500/null/undefined → `翻译服务暂时不可用，请稍后点重试` |
| `ReadingView · 段落失败行` | `src/reader/ReadingView.cloze.test.tsx:191-249` | ① prose 分支：failed 行含「本段翻译失败」+ zhError 原文；按钮文本「重试本段」，点击回调收到 `paragraphIdx=0` 恰一次；② parallel 分支同上；③ zhError 缺省：只有原文案与按钮、无原因小字（行为与旧版一致） |
| `zh_error_roundtrip_and_legacy_load`（未运行） | `src-tauri/src/reader_store.rs:1707-1743` | ① 带 `zhError:"翻译服务暂时不可用，请稍后点重试"` 的 Article JSON 反序列化 → `zh_error = Some(...)`，无字段句 → None；② 序列化回 JSON：camelCase 键 `zhError` 落盘、None 键不落盘；③ 老数据（无 zhError）加载不报错、zh_error=None |

---

## 2. Mac 落点设计

### 2.1 新建/修改文件清单

| 文件 | 动作 | 内容 | 证据 |
|---|---|---|---|
| `immersive-translator-mac/Sources/ReaderCore/ParagraphTranslate.swift` | 修改 | 追加 `public let translateBackoffWaitMs = 20_000`（或 `.seconds(20)` 常量）、`translateMaxGroupRetries = 1`、`translateMaxRunBackoffs = 6` 与 `public func planTranslateRetry(httpStatus:Int?, groupRetries:Int, runBackoffs:Int) -> Int?`（纯函数，逻辑逐行对齐 `paragraphTranslate.ts:120-129`） | 现文件 `:1-123` 全文无退避（已通读） |
| `immersive-translator-mac/Sources/ReaderCore/ReaderModels.swift` | 修改 | `SentencePair` 加 `public var zhError: String?`：init 参数（默认 nil，`:132-148`）、`CodingKeys.case zhError`（`:150-158`）、`decodeIfPresent`（`:160-169`）、`encodeIfPresent`（`:171-181`）——与 revealed/chunks 同款写法，天然满足 roundtrip + 老数据兼容 | 现结构体 `:119-182` 无 zhError |
| `immersive-translator-mac/Sources/ImmersiveTranslator/ErrorMessageFormatter.swift` | 修改 | `enum ErrorMessageFormatter` 加 `static func readerParagraphErrorText(status: Int?) -> String`（429/401/兜底三桶，文案逐字照抄 §1.2 表） | enum 定义 `:418` 起，`classify(statusCode:message:)` 在 `:20`，同为 static 风格 |
| `immersive-translator-mac/Sources/ImmersiveTranslator/ReaderViewModel.swift` | 修改 | ① `@Published var titleCnError: String?`（瞬态，对齐 `ReaderApp.tsx:276`）；② `translateParagraph` 改为返回结果（建议 `private enum ParagraphTranslateOutcome { case done; case failed(httpStatus: Int?); case stale }`），catch 处从 `ReaderChatError.http(let status, _)` 提取状态码，其余错误 status=nil；③ 新增 `private func translateGroupWithBackoff(_:target:articleID:runID:) async`：内含 `var groupRetries = 0`，由调用方传入整篇共享的 `runBackoffs` 计数盒（小 class 或让 `ensureTranslated` 持有并在闭包里 inout-free 递增），循环条件用 `ReaderCore.planTranslateRetry`，等待用 `try await Task.sleep(nanoseconds: UInt64(wait) * 1_000_000)`，醒来先 `guard isCurrentRun` 否则静默退出；④ `ensureTranslated` 标题失败分支设 `titleCnError = ErrorMessageFormatter.readerParagraphErrorText(status:)`（成功清空），段循环改调 `translateGroupWithBackoff`；⑤ `retryParagraph` 重置 failed 句时 `next.zhError = nil`，并同样走带退避的入口（新 run、runBackoffs 归零）；⑥ `retryTitle` 先 `titleCnError = nil` | vm 现状：`translateParagraph` `:1205-1276`（catch `:1268-1275` 无原因落 failed）、`ensureTranslated` `:1127-1203`、`retryParagraph` `:1360-1384`、`retryTitle` `:1386-1392`、`isCurrentRun` `:1123-1125`、`translating` `:216`、任务/代数 `:268-269` |
| `immersive-translator-mac/Sources/ImmersiveTranslator/ReaderViews.swift` | 修改 | ① `failedBody()`（`:2183-2192`）在「本段翻译失败」与按钮之间插入 `if let zhError = pair.zhError { Text(zhError).font(.system(size: 11)).foregroundColor(palette.err.opacity(0.8)) }`；② parallel 分支内联失败行（`:2436-2444`）同款插入；③ `mastheadCnSub` 标题失败（`:1881-1889`）「标题翻译失败」后插入 `if let err = vm.titleCnError { Text("（\(err)）").font(.system(size: 13)).foregroundColor(palette.err.opacity(0.85)) }` | 三处现状均无原因小字（已读原文） |
| （无需改）`contracts/reading-room.schema.json` | — | zhError 已在契约 `:113-116` | 已核实 |
| （无需改）`immersive-translator-mac/Sources/ImmersiveTranslator/ReaderStore.swift` | — | SentencePair Codable 即落盘格式，`saveArticle`（`:129`）/`getArticle`（`:114`）零改动；可选字段不 bump schemaVersion（`ReaderStore.swift:95` 校验沿用） | 已核实 |

**错误提取说明**：Mac 阅读室链路的 HTTP 状态码已经在 `ReaderChatClient.ReaderChatError.http(status:message:)` 里结构化（非流式 `ReaderChatClient.swift:185-188`、流式 `:239-245`），vm 的 catch 只需 `if case ReaderChatError.http(let s, _) = error`；**不要**去匹配错误 message 文本。URLSession 超时/断网抛 URLError → status=nil → 不退避、落兜底文案（与 Windows `ErrorEvent.status=None` 同构）。`TranslationClient.swift:209/306` 的 `badResponse` 属浮窗面板链路，本功能不经过、不改。

### 2.2 与 Mac 既有架构的衔接

- **请求-响应直连 vs 事件路由**：Windows 用 tag 路由 + 事件回传（`ReaderApp.tsx:598-628`）；Mac `ReaderChatChannel.completeStreaming` 是直接 await（`ReaderViewModel.swift:34-45` 协议、`ReaderChatClient.swift:197-227` 实现）。退避重试在 Mac 就是**再次调用 completeStreaming**（天然新请求），Windows 的「重试换新 tag 防误路由」在 Mac 无对应物、不需要。
- **run 失效机制**：Windows 靠 `articleRef.current?.id !== input.id` 主动检查并自己清 chip（B1）；Mac 靠 `translationTask?.cancel() + translationRunID += 1`（`ReaderViewModel.swift:1114-1121`，`openArticle` `:845-846` 已有）+ `isCurrentRun` 守卫（`:1123-1125`），新文章的管线自行重置/清空 `translating`（`:1145` 或 `:1150`）。退避等待用 `Task.sleep`：中途切文时任务被 cancel，sleep 抛 `CancellationError` → 捕获后 `guard isCurrentRun` 失败静默退出，**不得**把句子标 failed。观察行为与 Windows B1 等价（chip 永不残留旧文章进度）。
- **落盘**：`scheduleSave`（700ms 防抖，`ReaderViewModel.swift:1055-1072`）→ `store.saveArticle`；zhError 随 SentencePair Codable 自动往返，与 Windows `scheduleSave/readerSaveArticle`（`ReaderApp.tsx:704-722`）逐位对齐。
- **设置/登录体系**：不涉 `ReaderSettings`/`ReaderPlaybackEngine`/`SpeakStore`；`ServerAuth` 仅为同步/账号域，Mac 阅读翻译无沉浸云 gateway 分支（`TranslationClient.swift` 仅 API Key Bearer，`:124`；`ReaderChatClient.swift:161-162`），故 Windows 的「平台未登录合成 401」路径在 Mac 不存在——上游真 401 已能落同一文案桶，行为一致。
- **UI**：Mac 视图直接读 `vm.`（无 props 透传链），`titleCnError` 作 `@Published` 即可，不需要 Windows 那种 `ReadingView Props` 透传（对照 `ReadingView.tsx:79-81` + `ReaderApp.tsx:2464-2465`）。

### 2.3 需补的 Swift 测试（与 Windows 单测行为向量一一对齐）

| 新测试 | 放置 | 对齐的 Windows 用例 |
|---|---|---|
| `ParagraphTranslateBackoffTests`：planTranslateRetry 五向量（429/0/0→20000ms；429/1/0→nil；429/0/6→nil；500→nil；nil→nil）+ 三个常量值断言 | `Tests/ReaderCoreTests/`（新文件；纯函数无依赖） | `paragraphTranslate.test.ts:78-111` |
| `readerParagraphErrorText`：429/401/500/nil → 三条文案逐字断言 | `Tests/ImmersiveTranslatorTests/`（新 `ErrorMessageFormatterTests.swift`，`@testable import ImmersiveTranslator`） | `errorMessageFormatter.test.ts:434-447` |
| `SentencePair` zhError Codable 往返 + 老数据：构造带 `zhError` 与不带的 Article JSON，`JSONDecoder` 老数据 zhError=nil 不抛错；`JSONEncoder` 输出 camelCase `zhError` 键、nil 不输出 | `Tests/ReaderCoreTests/`（ReaderModels 属 ReaderCore） | `reader_store.rs:1707-1743` |
| 失败行渲染（视图层）：prose `cnArea→failedBody` 与 parallel 分支各一例：zhError 有值 → 文案出现；nil → 不出现；按钮「重试本段」回调 `retryParagraph(paragraphIdx)`（用现有 vm+StubChat 夹具驱动状态即可，或最小化直接断 `pair.zhError` 注入后的 view 快照） | `Tests/ImmersiveTranslatorTests/`（复用 `ReaderShellChromeTests.swift:77-130` 的 Gate/StubChat/makeVM 夹具） | `ReadingView.cloze.test.tsx:191-249` |
| （建议补充，Windows 未直接覆盖但为回归护栏）vm 级：StubChat 首次抛 `ReaderChatError.http(status: 429, …)`、第二次成功 → 句子最终 done 且 zhError==nil、channel 恰被调 2 次；恒 429 → failed 且 zhError 为 429 文案、恰 2 次调用（退避等待注入短值或把 wait 常量收敛到可注入参数） | 同上 | `planTranslateRetry` + `markParagraphFailed` 组合语义（`ReaderApp.tsx:927-948/979`） |

---

## 3. 逐条验收清单（1:1 保真检查点）

1. `planTranslateRetry` 仅当 `httpStatus == 429` 且 `groupRetries < 1` 且 `runBackoffs < 6` 返回 20000ms，否则 nil（含 500/null 向量）。
2. 三个常量值分别为 20s / 1 / 6，且不读取服务端 `Retry-After`。
3. `readerParagraphErrorText(429/401/其它与nil)` 三条中文文案与 §1.2 表逐字一致，不透传上游 message。
4. `SentencePair.zhError` 为可选字段：新 JSON 往返保留、nil 不落键、老数据（无 zhError）解码不报错且为 nil——与 `contracts/reading-room.schema.json:113-116` 及 schemaVersion 维持 1 一致。
5. 段落失败行（prose 与 parallel 两分支）在「本段翻译失败」后渲染 zhError 小字（≈11pt、错误色 0.8 透明度），zhError 缺省时与现行为完全一致（无小字）。
6. 「重试本段」按钮文案与回调（paragraphIdx）不变。
7. HTTP 错误导致的段落失败写入 zhError（按状态码三桶）；**parse 对齐失败（200 但编号行对不齐）不写 zhError**。
8. `retryParagraph` 把该段 failed 句重置 pending 时清空 zhError；重试成功句子 zhError 为 nil；重试再失败重新写入。
9. 标题翻译失败时显示 `标题翻译失败（<原因>）`（全角括号、0.85 透明度）+「重试」按钮；`titleCnError` 不落盘，重启后仅「标题翻译失败」。
10. `retryTitle` 与标题重试成功都先清 `titleCnError`；标题不参与 429 退避（只发一次）。
11. 每段最多自动重试 1 次；同一 run 内整篇退避等待 ≤6 次；手动重试开启新 run，配额从 0 重算。
12. 退避等待固定 20s；等待后先检查 run 是否仍有效，失效则退出且不重发请求。
13. 中途切换文章后，「翻译中 N/M 段」chip 立即反映新文章状态，旧 run 不再写任何句子状态（含 zhError），chip 永不残留卡死（B1 对等行为）。
14. 180s 请求超时 / 未配置接口 / 网络错误：不退避，段落落兜底文案。
15. §2.3 前四组 Swift 测试存在并通过，行为向量与 §1.6 表一一对应（运行 `swift test` 对应 target）。
16. 未配置翻译接口时保持现状 toast（Mac 现有「先在设置里配置翻译接口，译文才会自动生成」，`ReaderViewModel.swift:1131`），不改语义。

## 4. 平台差异清单（仅系统必然差异）

1. **重试请求的标识机制**：Windows 事件路由按 tag 识别响应，重试必须换新 tag 防误路由（`ReaderApp.tsx:946`）；Mac 是直接 await 的请求-响应模型，无 tag，重试即重新调用。理由：Windows Rust 网关用 Tauri 事件回传（`translation.rs` emit_to），Mac `ReaderChatClient` 无事件层。
2. **run 失效与 chip 清理机制**：Windows 旧 run 主动检测 `articleRef.id` 变化并自己 `setTranslating(null)`；Mac 用 Task cancel + runID 代数失效，由新文章的管线重置 chip。理由：Mac 侧 `translationTask/translationRunID`（`ReaderViewModel.swift:268-269`）是既定并发架构，SwiftUI 单窗口无 React ref 对应物。可观察行为必须一致（验收 13）。
3. **沉浸云平台 401 合成信封**：Windows translation.rs 对「平台请求未登录」自拟 `status:Some(401)` 信封（`translation.rs:384-397`）并有 token_expired 刷新重放（`:444-489`）；Mac 阅读翻译只有 API Key 直连第三方端点，无平台分支。理由：Mac 尚未接入沉浸云 gateway（`TranslationClient.swift:124` 仅 Bearer apiKey）。后果仅是「合成 401」来源不存在，上游真 401 仍落同一文案桶，用户可见行为一致。
4. **退避等待的取消语义**：Windows `window.setTimeout` 不受取消影响，醒来后查文章 id；Mac `Task.sleep` 在 Task cancel 时立即抛 `CancellationError`，需捕获后按 runID 失效静默退出。理由：Swift 结构化并发取消即抛错。
5. **视图文案注入方式**：Windows 经 React props（`titleCnError?: string`，`ReadingView.tsx:81`）；Mac 经 `@Published` 属性直读。理由：SwiftUI 声明式绑定 vs React props 透传的框架差异；文案与字号/透明度数值不变。

（除此之外——文案、参数、分桶、存储语义、重试配额、chip 行为——一律不许差异。另注：Mac 现有「翻译中」chip total 把标题也计入（`ReaderViewModel.swift:1150`），Windows 不计（`ReaderApp.tsx:874`）；以及 Windows 取消事件可救回部分译文（`ReaderApp.tsx:963-977`）而 Mac 取消走 stale-return——两者均为 bc0f625 之外的**既有**差异，本规格不扩scope修它们，如需对齐另立规格。）
