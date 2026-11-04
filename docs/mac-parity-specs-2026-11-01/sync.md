# 云同步（口语记录双集合）与兑换码 · Mac 1:1 移植规格（sync）

勘察日期：2026-11-01。对齐基准：Windows commit `6630aa7`（口语记录云同步：speak-sessions / speak-assessments 两集合同步 + 账户页多集合汇总）与 `c1e2ca7`（redeem_code 命令 + 账户页 RedeemCard + 额度用尽提示动作位），并覆盖两提交之后仓库内已实证的现行代码形态（含 v2 学习接力的 namespace 加固对本领域的交叉影响）。所有锚点均在本机实读源码核实（path:line 为当前工作区实读位置）。

**命名勘误（重要）**：6630aa7 提交信息写「speak-attempts 两集合」，但实际落地的集合名是 **`speak-assessments`**（`immersive-translator-windows/src/lib/speakRecords.ts:32`，Rust 白名单同步 `immersive-translator-windows/src-tauri/src/sync.rs:37`）。本规格以代码为准，一律用 `speak-assessments`；提交信息中的 `speak-attempts` 是旧称，Mac 侧不得采用。

**服务端代码不在本仓**：`immersive-translator-server/` 目录在本仓库不存在（`ls` 根目录实证：只有 immersive-translator-windows / -mac / -mobile / packages / contracts / docs 等；`git log --all -- "*apps/api*"` 无任何记录）。网络契约依据：①客户端两侧实现（Windows Rust/TS 是协议的唯一在仓镜像）；②`docs/server-architecture-plan-2026-09-22.md` §6.4/§6.5/§7；③`docs/voice-cloud-implementation-contract-2026-10-28.md` §二/§三.10；④`docs/speaking-records-sync-implementation-2026-10-28.md`（含服务端改动清单，指向仓外 `apps/api/src/modules/sync/`）。服务端字段以这些文档+客户端实现为准，本规格不虚构任何仓外代码。

---

## 1. Windows 行为规格

### 1.0 总体架构与分层（协议零新增）

- 复用既有 M4 同步协议（`/v1/sync`，baseVersion 乐观并发 + tombstone + 版本号游标水位），只新增两个集合名，不改任何协议字段（`docs/speaking-records-sync-implementation-2026-10-28.md:3`）。
- 三层分层（`immersive-translator-windows/src-tauri/src/sync.rs:1-14`）：
  1. **传输命令**（Rust `sync_pull`/`sync_push`/`redeem_code`）挂在 `TokenManager::with_auth` 上——base URL 解析、Bearer 会话令牌附带、401 `token_expired` 单飞刷新后重放一次全部继承 auth.rs；令牌永不跨 IPC（红线 D4/D5）。**非 2xx 是协议数据不是错误**：命令原样带回 `{status, body, retryAfterSeconds}`；只有网络/致命鉴权错误才 reject（`sync.rs:6-8`、`redeem.rs:6-9`）。
  2. **协议逻辑**（游标推进、LWW 合并、409/429/413 处置）在前端 `src/lib/syncEngine.ts`。
  3. **记录层**（投影/守卫/入队/裁剪/tombstone/合并/静默同步）在 `src/lib/speakRecords.ts`，业务侧全部经它，不另写同步管线。
- Rust 本地集合白名单 `LOCAL_COLLECTIONS`（`sync.rs:28-39`，同时是文件名/路径白名单，防任意文件名读写）：`history, reading-articles, reading-vocab, notes, glossary, settings, speak-scenarios, speak-sessions, speak-assessments, review-events`。白名单守卫有单测（`sync.rs:488-503`：`../../etc/passwd`、`unknown`、`a/b`、`` 空串必须拒绝）。
- v2 交叉影响（现行代码）：`sync_store_put/list/cursor_get/cursor_set/replace` 命令实际落盘到 SQLite `learning_store`（`sync.rs:302-318` 委托 `crate::learning_store::put/list/cursor`），并带 `expected_namespace` 账号防串参数；`learning_store.rs:1712-1723` 迁移期把旧 `sync/<collection>.json` 导入 SQLite。保存会话时 Rust `derive()` 会在同一事务内把 `reader_speak_sessions.json` 的增删改导出为 speak-sessions 集合的 enqueue/tombstone（`learning_store.rs:1320-1336` enqueue、`:1341-1360` tombstone），pull 落库后 `hydrate()` 反向把集合实体回写为领域文件快照（`learning_store.rs:774-798`：缺 `createdAt/updatedAt` 时用 `startedAt/endedAt` 回填）。Mac 见 §2/§4 的取舍。

### 1.1 数据结构与常量（逐字段）

**本地同步实体 `StoredSyncEntity`**（`sync.rs:60-75`，camelCase 序列化，与前端 `tauriBridge.ts:543` 一字不差；与服务端 WireEntity 的差集：多 `baseVersion`/`dirty`，少 `version`）：

```ts
{
  id: string;
  baseVersion: number;   // 上次同步到的服务端版本；0 = 本地新建从未推送
  updatedAt: number;     // 客户端逻辑时间（毫秒）——LWW 由客户端比较，服务端只透传
  deleted: boolean;
  schemaVersion: number;
  originDevice?: string;
  payload?: unknown;     // 活实体业务数据；tombstone 为 undefined（线路上为 null）
  dirty: boolean;        // 新建/修改/软删除置 true；push accepted 后清零
}
```

**服务端下发实体 `WireEntity`**（`syncEngine.ts:41-49`）：`{ id, version, updatedAt(ISO 字符串), deleted, schemaVersion, originDevice: string|null, payload }`。

**集合常量与体量护栏**（`speakRecords.ts:30-41`，与服务端对齐，见 `docs/speaking-records-sync-implementation-2026-10-28.md:48-54`）：

| 常量 | 值 | 含义 |
|---|---|---|
| `SPEAK_SESSIONS_COLLECTION` | `"speak-sessions"` | 口语对话记录集合名 |
| `SPEAK_ASSESSMENTS_COLLECTION` | `"speak-assessments"` | 跟读评测记录集合名 |
| `SPEAK_RECORD_MAX_BYTES` | `64 * 1024` | 单条同步上限（= 服务端 SYNC_COLLECTION_MAX_BYTES 双集合特配 65536；其余集合 512KB） |
| `SPEAK_RECORD_MAX_LIVE` | `500` | 每集合滚动保留条数（超出本地裁剪转 tombstone；tombstone 计 0 字节、释放配额，服务端不拒收） |
| `ASSESS_MAX_WORDS` | `64` | 评测逐词精简结果最大词数（超出丢尾；词面另截 64 字符） |
| `TEXT_MAX_CHARS` | `1000` | 旧独立评测摘要参考文本上限（完整会话文字不适用） |

**speak-sessions 记录 `SpeakSessionRecord`**（`speakRecords.ts:48-63`；SpeakSession 富会话的**精简投影**，保留完整文字、提示、上下文、表达建议和发音报告，供另一设备按保存步骤续练；仅剥离音频字节与源设备私有路径）：

```ts
{
  [key: string]: unknown;   // 保留未知业务字段（mergeRelayPayload 合并语义）
  id: string;               // 会话 id（newSpeakSessionId 生成）
  scenario: string;
  difficulty: "easy" | "medium" | "hard";
  startedAt: number;        // = createdAt（Unix 毫秒）
  endedAt: number;          // = updatedAt（最后活动时间，LWW 时钟）
  turns: { role: "user" | "assistant"; text: string; at: number }[];  // 实际载荷保留轮次完整字段
  v: 2;                     // 投影时补的版本标记（sessionRecordFrom，speakRecords.ts:72-85）
}
```

投影算法（`speakRecords.ts:72-85`）：`{...withoutAudio(s), v:2, id, scenario, difficulty, startedAt:createdAt, endedAt:updatedAt, turns: turns.map(withoutAudio)}`；`withoutAudio` 递归剔除音频/本地路径键（黑名单：`audio, audiob64, audiobase64, audio_base64, pcmb64, pcm, pcm_base64, wavb64, wav, blob, audiofile, audiopath, localpath`，及以 `/` 开头的路径形态键，`packages/learning-core/src/relay.ts:54-59`）。**超过 64KB 抛错**（消息见 §1.6），完整记录保留本机，绝不裁剪真实轮次。

还原（`speakRecords.ts:88-98`）：`sessionFromRecord` 把云端记录恢复成富会话，`createdAt=startedAt`、`updatedAt=max(startedAt, endedAt)`，turns 浅拷贝。

**speak-assessments 记录 `SpeakAssessmentRecord`**（`speakRecords.ts:132-154`；每评测一条、永不更新）：

```ts
{
  id: string;               // `sa${at.toString(36)}${Math.random().toString(36).slice(2,8)}`（会话 id 同款风格）
  source: "reader" | "review" | "coach";  // reader=阅读室跟读、review=复习、coach=口语陪练（含只练差词）
  lang: string;             // 当前恒 "en"（缺省 "en"）
  refText: string;          // 截 1000 字符
  total: number; accuracy: number; fluency: number; standard: number;  // 四分摘要
  words: { w: string; s: number }[];  // 逐词 {词面(≤64字符), 得分}，≤64 词可截断；丢音节/音素明细
  sessionId?: string;       // coach 来源关联会话 id（reader/review 缺省）
  at: number;
}
```

**运行时形状守卫**（同步数据进门校验，脏行整条丢弃——feedStore 范式）：
- `isSpeakSessionRecordLike`（`speakRecords.ts:101-126`）：对象、`id` 非空 string、`scenario` string、`difficulty ∈ {easy,medium,hard}`、`startedAt/endedAt` 有限 number、`turns` 数组且每项 `role ∈ {user,assistant}` + `text` string + `at` number。
- `isSpeakAssessmentRecordLike`（`speakRecords.ts:189-213`）：`id` 非空、`source` 三值枚举、`lang/refText` string、四分数值有限、`words` 数组每项 `{w:string, s:number}`、`at` number。

### 1.2 本地入队 / 滚动裁剪 / tombstone

`enqueueRecord`（`speakRecords.ts:239-261`）：
1. `syncStoreList(collection)` 取现有实体；同 id 存在则沿用其 `baseVersion`（避免无谓 409）。
2. 新实体 `updatedAt = 记录时间`、`deleted=false`、`schemaVersion = max(2, existing?.schemaVersion ?? 0)`、`originDevice = "windows"`、`payload = withoutAudio(mergeRelayPayload(existing?.payload, 新payload))`（深合并保留未知字段，`relay.ts:41-53`）、`dirty = true`。
3. **滚动裁剪**（`overflowTombstones`，`speakRecords.ts:221-237`）：入队后活实体（排除新实体自身与已删实体）> 500 时，最旧的 `length - 500 + 1` 条转 tombstone——保留 `baseVersion`/`schemaVersion`/`originDevice`、`payload=undefined`、`deleted=true`、`dirty=true`、`updatedAt = max(now, 原值+1)`（保证晚于被裁记录逻辑时间，LWW 下删除可传播）。
4. `syncStorePut(collection, [entity, ...tombstones])` 一次写入——**入队/裁剪是纯本地 IPC，零网络请求**。

入口（`speakRecords.ts:263-291`）：`enqueueSessionRecord(session)`（LWW 时钟 = 会话 updatedAt）、`enqueueAssessment(input)`、以及组件侧 fire-and-forget 包装 `enqueueSessionRecordSilently` / `recordAssessmentSilently`（本地写失败只吞掉，不影响对话/评测流程）。

删除（`speakRecords.ts:295-320`）：`deleteSessionRecord` / `deleteAssessmentRecord` 走 tombstone（保留 baseVersion、payload 置空、`updatedAt=max(now, 原值+1)`）；本就无实体或已是 tombstone 返回 `false`（无状态变化）。

**现行 Windows v2 生产漏斗**（6630aa7 之后演进，实证）：TS 侧 `enqueueSessionRecordSilently` 已无生产调用方（全仓 grep 仅测试引用）；会话入队改由 Rust `derive()` 在保存领域文件 `reader_speak_sessions.json` 的同一事务内完成（`SpeakView.tsx:447-458` persist 只调 `speakSaveSession`，注释「Rust commits the local session and its sync outbox in one transaction」；`speak_store.rs:246-267` → `learning_store::commit` → `derive`）。评测入队仍是 TS 侧 `recordAssessmentSilently` 四个落点（见 §1.4）。

### 1.3 同步协议引擎（syncNow，复用不改协议）

`syncEngine.ts` 关键常量（`:80-89`）：`PULL_PAGE_LIMIT=500`、`PUSH_BATCH=200`、`MAX_ENTITY_BYTES=512KB`（**speak-sessions/speak-assessments 特配 64KB**，`:310`）、`MAX_PULL_PAGES=400`、`MAX_CONFLICT_ROUNDS=3`、`MAX_RATE_LIMIT_WAITS=3`、`ORIGIN_DEVICE="windows"`；push 请求体上限 2MB。

`syncNow(collection)`（`:444-447`）：全局串行队列；先 `pullAll` 再 `pushDirty`；**不抛错**——失败汇总进 `SyncSummary` 返回（调用方据此展示，已落地部分保留，下次续传）。

`SyncSummary`（`:103-119`）：`{ ok, pulled(含tombstone), appliedRemote, keptLocal, pushed, conflicts, skipped:[{id,reason}], error }`。

**拉取 `pullAll`**（`:226-294`）：
- `since` 是版本号游标（非时间戳），版本号空间跨集合共享，每集合各存各的 cursor；追平判据 `hasMore===false`。
- 首次全量（cursor=0）时 tombstone 也会下发，必须按 `deleted:true` 落地删除。
- 校验：响应无 `entities` 数组 / cursor 非法 / `hasMore` 非布尔 → 抛「同步拉取响应无效」；`hasMore && cursor 未推进` → 「同步游标未推进」。
- 本地 dirty 且 `updatedAt > 服务端`：保留本地内容只吸收服务端版本号（keptLocal+1）；否则采纳服务端（appliedRemote+1）。
- `stale_cursor` 错误码：cursor 归 0 全量重来；全量期间再次失效抛「全量同步期间游标再次失效」。
- 429：按 `retryAfterSeconds`（响应头换算）或 body `details.retryAfterMs` 退避（上限 15s），最多等 3 次，超限抛「同步拉取被限流（429），已等待 3 次仍未通过，请稍后再试」。
- 其他非 200：抛 `同步拉取失败（HTTP {status} {code}）：{message}`。

**推送 `pushDirty`**（`:300-331`）：
- dirty 实体预检：活实体缺 payload → skip「活实体缺少 payload，无法推送」；超 64KB（双集合）→ skip「payload 超过 65536 字节上限（N 字节），完整记录保留在本机」；单实体连同信封超 2MB → skip「实体连同同步信封超过请求容量，完整记录保留在本机」。
- **push 409 整批原子拒绝**（`:359-401`）：批次是重试单元；`conflicts[]` 每项 `{id, serverVersion, server}`——`server===null` 是幽灵实体（服务端从未见过，本地 baseVersion 记忆错误）→ baseVersion 置 0 重推；有快照则 LWW：本地 updatedAt **严格大于**服务端则携新 baseVersion 重推，否则（含相等，server-wins 防乒乓）采纳服务端快照；最多 3 轮，未收敛 skip「冲突 3 轮未收敛，留待下次同步」。
- 413 `payload_too_large`（含 entityId）：剔除该实体重推其余（skip「服务端判定 payload 超限」）。
- push 429：同拉取口径（「同步推送被限流（429）…请稍后再试」）。
- push 200 应答：按 `results[].version` 回写 baseVersion、清 dirty；若本地在推送期间又有并发编辑（updatedAt/payload/deleted 变了），保留最新本地态且 dirty 不清（`:345-357`）。

### 1.4 功能入口与交互流（Windows UI）

**① 口语页挂载静默同步**（`SpeakView.tsx:369-386`）：进入口页先并行拉本地富会话（`speakListSessions`）+ 云端记录（`listSessionRecords`），合并展示「继续上次的对话」前 5 条（展示再截前 3，`:1614`）；随后 `syncSpeakRecordsSilently()`，任一集合 `appliedRemote > 0` 则重拉云端记录刷新一次。未登录直接跳过（零网络）。

**② 会话保存漏斗**（`SpeakView.tsx:447-458`）：每轮对话后 `persist` → `speakSaveSession`（本地富会话照旧）→ 重拉合并；富会话 JSON > 65536 字节时 toast：「完整练习已保存在本机，已超过单条云同步上限；请另开一组继续练习」。

**③ 评测落点 ×4**（每次真实 ISE 结果、非 rejected/异常才入队；音频不上云）：
- `useShadowAssess.ts:172`：source=「reader」，refText=跟读文本（阅读室跟读）。
- `SpeakView.tsx:753-759`：source=「coach」，refText=userText，sessionId=当前用户轮会话 id（发音评测）。
- `SpeakView.tsx:1102-1108`：source=「coach」，refText=跟读目标，sessionId=sessionRef.current?.id（跟读）。
- `ShadowDrill.tsx:126`：source=「coach」，refText=entry.text，无 sessionId（只练差词）。

**④ 账户页多集合同步入口**（`AccountSection.tsx:167-184`）：既有「口语场景云同步」按钮扩为三集合循环 `["speak-scenarios", "speak-sessions", "speak-assessments"]` 顺序 `syncNow`，`mergeSummaries` 把各集合结果并成**一条**汇总反馈（`:98-122`：ok 取与、计数累加、skipped 拼接、error 取首个）。

**⑤ 兑换码全链路**：
- 账户页 RedeemCard（`AccountSection.tsx:318-319` 挂载，已登录分支内）：输入码 → `redeemCode(trimmed)`（`tauriBridge.ts:524`，Rust `redeem_code` → `POST /v1/redeem`，body `{"code":"..."}`，`redeem.rs:21-42`）。
- 提交状态机（`RedeemCard.tsx:50-116`）：`idle → submitting → success | error`；submitting 全控件禁用；success 清空输入允许连兑；error 保留输入可改后重试；Enter 键等效提交（canSubmit 时）。
- 语音页额度用尽动作位：`friendlyNotice` 把含「额度已用完」的文案归类 `kind="redeem"`（`speakUi.ts:69-73`；文案本身由 voiceErrorDisplayText 拼好，属语音云域）；SpeakView 通知动作位「兑换更多额度」→ `settingsOpenTab("account")`（`SpeakView.tsx:1700-1710`）；设置窗内 `openAccountRedeem` 切账号 tab 后 80ms 按 `id="account-redeem"` scrollIntoView+focus（`Settings.tsx:283-291`）；主窗 toast 动作位同款（`ReaderApp.tsx:2806-2817`）。

**⑥ 游客（未登录）行为**（`speakRecords.ts:19-21`、`:364-376`）：入队/裁剪/list 全是本地 IPC 零网络；同步触发先 `authGetStatus`，未登录直接返回 `[]`；**状态读取失败（桥不可用等）宁可不同步也不出网**；Rust 侧双保险：无 token 时 `with_auth` 本地报 unauthorized 不出网。不新增任何登录墙。

### 1.5 网络端点与请求/响应契约

**同步**（`sync.rs:108-177`；服务端规格 `docs/server-architecture-plan-2026-09-22.md:352-366`）：

```
GET  /v1/sync/{collection}/pull?since=<versionCursor>&limit=500    （limit 钳制 1..500，since 钳制 ≥0）
→ 200 PullPage { collection, serverVersion, cursor, hasMore, entities: WireEntity[] }
→ 404 白名单外；409（pull 不产生）；429 {error:{code:"rate_limited", details:{retryAfterMs}}} + Retry-After 头
     （pull/push 共用 per-user 120/min 限流桶，syncEngine.ts:14）

POST /v1/sync/{collection}/push
     body { entities: [{ id, baseVersion, updatedAt(ISO), deleted, schemaVersion, originDevice, payload|null }] }
→ 200 PushOk { collection, serverVersion, results: [{ id, status:"accepted", version }] }
→ 409 { error:{ code, details:{ conflicts: [{ id, serverVersion, reason?, server: WireEntity|null }] } } }
→ 413 { error:{ code:"payload_too_large", details:{ entityId, maxBytes:65536 } } }
→ 429 同上
```

- 服务端为每用户维护全局单调 `version`；payload 为 opaque blob（不解析内容）；DELETE 语义 = push `{deleted:true, payload:null}` tombstone（保留 90 天后物理清理）；`schemaVersion` 仅记录主版本。
- 集合白名单服务端侧（`docs/speaking-records-sync-implementation-2026-10-28.md:59-67`）：`SYNC_COLLECTIONS += speak-sessions/speak-assessments`；`SYNC_COLLECTION_MAX_BYTES` 双集合特配 65536、其余回退全局 512KB。
- 统一错误形状 `{error:{code, message, details?}}`（`docs/server-architecture-plan-2026-09-22.md:485`）。

**兑换**（`redeem.rs:18-21`；服务端 `docs/server-architecture-plan-2026-09-22.md:343`「兑换码：`POST /v1/redeem {code}` → 增量额度入 quota_grants」；契约 `docs/voice-cloud-implementation-contract-2026-10-28.md:55`）：

```
POST /v1/redeem      body {"code":"XXXX-XXXX-XXXX-XXXX"}    登录态必需
→ 2xx 成功（额度入 quota_grants）
→ 4xx 错误信封原样透传，业务码：redeem_code_not_found / redeem_code_expired / redeem_code_used
→ 429 限流 retry_after_seconds 随应答透传
code 形状校验在服务端 RedeemDto（去空格 + 大写 + XXXX-XXXX-XXXX-XXXX），客户端不重复校验
```

服务端数据模型 `RedeemCode`（`docs/server-architecture-plan-2026-09-22.md:453-461`）：`code(PK) / resource / amount / expiresAt? / batchId? / redeemedBy? / redeemedAt? / createdAt`。

### 1.6 UI 状态与用户可见文案（原样抄录，供逐字复刻）

**账户页·口语场景云同步卡**（`AccountSection.tsx:291-316`）：

| 位置 | 文案 |
|---|---|
| 卡标题 | `口语场景云同步` |
| 字段标签 | `跨设备同步自定义口语场景` |
| 字段提示 | `升级计划 A0：先拉取云端变更再推送本地改动；场景编辑器上线后将自动接入` |
| 按钮（常态/进行中） | `立即同步` / `同步中…` |
| 成功汇总 | `同步完成（拉取 X 项，推送 Y 项）`，追加段（>0 才出现，中文逗号连接）：`冲突处理 N 次`、`本地较新保留 M 项`、`跳过 K 项` |
| 失败汇总 | `同步失败：{error 或 未知错误}` |

**账户页·兑换码卡**（`RedeemCard.tsx:81-114`；外层锚点 `id="account-redeem"`、tabIndex=-1 可聚焦）：

| 位置 | 文案 |
|---|---|
| 卡标题 | `兑换码` |
| 字段标签 | `兑换额度` |
| 字段提示 | `输入兑换码补足本月额度（形如 XXXX-XXXX-XXXX-XXXX）` |
| 输入框 placeholder | `请输入兑换码` |
| 按钮（常态/进行中） | `兑换` / `兑换中…` |
| 成功（ok 条） | `兑换成功，额度已到账` |
| 错误·not_found | `兑换码不存在` |
| 错误·expired | `兑换码已过期` |
| 错误·used | `兑换码已被使用` |
| 错误兜底（未知码/非 JSON/网络 reject/未登录） | `兑换失败，请稍后再试` |

文案映射铁律（`RedeemCard.tsx:35-48`）：仅三个业务码有专属文案，其余一律兜底；**绝不透传服务端 message**。

**口语页**：
- 挂载合并后的「继续上次的对话」行（`SpeakView.tsx:1609-1625`）：`{场景标题} {难度label}难度 · 已聊 {floor(turns/2)} 轮[ · 发音均分 {avg}]`，右侧动作 `继续对话 →`。
- 超限 toast（`SpeakView.tsx:456`）：`完整练习已保存在本机，已超过单条云同步上限；请另开一组继续练习`。
- 保存失败 toast（`SpeakView.tsx:457`）：`练习保存失败：{message}`。
- 额度用尽通知动作位（`SpeakView.tsx:1704`）：按钮 `兑换更多额度`；toast 动作位同文案（`ReaderApp.tsx:2814`）。

**64KB 护栏错误消息**（`speakRecords.ts:83`，入队抛出）：`口语记录超过 64KB 同步上限，完整记录仍保留在本机，请分段练习后再同步`。

**friendlyNotice 分类**（`speakUi.ts:49-78`，redeem 档）：文案含「额度已用完」→ `{kind:"redeem", message:原文}`（message 不改写——带重置时间或兑换指路的两种形态都命中）。

### 1.7 边界与错误处理汇总

1. **音频红线**：录音/base64 音频字段禁止出现在任何 push 载荷——`withoutAudio` 递归剥离 + 测试正则断言（`speakRecords.test.ts:385-406`：push 线路 JSON 不得匹配 `/audio|base64|pcm|blob|data:audio/i`；tombstone 线路 payload 必须为 null）。
2. **64KB**：会话投影超限抛错（消息见上）；推送预检超限 skip（保留本机）；服务端 413 兜底剔除。**永不裁剪真实练习轮次**；单轮完整文字在容量内原样保留。
3. **500 条滚动**：入队触发本地裁剪，tombstone 随同步传播到其他端；不满 500 不产生 tombstone。
4. **多端冲突 LWW**：本地 dirty 且 updatedAt 严格更新 → 保留本地携新 baseVersion 重推；相等取服务端（防乒乓）；展示合并同口径（本地 ≥ 云端保留本地富会话超集，云端严格较新用云端精简版，`speakRecords.ts:345-360`）。
5. **幽灵实体**：409 `server===null` → baseVersion 0 重推。
6. **限流**：pull/push 共用 120/min 桶；429 退避最多 3 次后本次失败（下次再试）。
7. **脏行防御**：pull 进门形状守卫，脏行整条丢弃（list 不返回）。
8. **静默失败**：同步失败只汇总不抛、不打扰；入队失败 fire-and-forget 吞掉；场景目录/会话读取失败回退空列表。
9. **未登录/状态读取失败**：零网络（宁可跳过）。
10. **practice-task 特例**（v2 现行）：`kind==="practice-task"` 的 speak-sessions 实体走 `mergePracticePayload` 终态合并、任务删除对 id 终局（`syncEngine.ts:180-191`、`learning_store.rs:1005-1023`）；`speak_list_sessions` 过滤掉 task 实体（`speak_store.rs:225-241`）；展示合并同样跳过 task（`speakRecords.ts:353-355`）。Mac 本期无练习接力功能，见 §2 说明。

### 1.8 相关 Windows 单测及其行为向量

**`src/lib/speakRecords.test.ts`**（570 行，mock tauriBridge、内存态按集合分桶模拟 sync_store_*，`:1-125`）：

| 用例 | 行为向量 |
|---|---|
| 保留跨设备续练所需的提示、发音报告和上下文，不携带音频 | 投影保留 context/pron/shadowAttempts 等富字段；`JSON.stringify(record)` 不匹配 `/audioB64|pcmB64|wavB64/` |
| 云端记录 → 富会话往返 | id/scenario/difficulty/turns 数/createdAt=startedAt/updatedAt=max(started,ended) |
| 64KB 护栏明确报错，绝不裁剪真实练习轮次 | 200 轮×~800B 必抛 `/64KB/`；session.turns 原样 200 轮不动 |
| 单轮完整文字在容量范围内原样保留 | 3000 字文本不截断 |
| 形状守卫 | 合法过；空 id / difficulty="harder" / role="bot" / endedAt="2000" / null / "s1" 全拒 |
| 评测 → 精简记录 | 四分摘要 + 逐词 {w,s}，丢音素；sessionId 缺省不出现；id `sa` 前缀 |
| 逐词截断 64 / 文本截断 1000 | 超限丢尾/截断 |
| 评测形状守卫 | 坏 source / 非数值分数 / 坏 words 拒 |
| 会话入队 | dirty=true、payload=精简记录、baseVersion 沿用已同步值 |
| 入队全程零网络请求 | syncPull/syncPush 零调用（游客同样可用） |
| 500 条护栏 | 满 500 活实体再入队 → 最旧 1 条转 tombstone（保留 baseVersion、deleted、payload 空） |
| 不满 500 不产生 tombstone | tombstones 为空 |
| 删除走 tombstone | deleted/payload 空/dirty、保留 baseVersion；重复删返回 false |
| push 载荷红线 | tombstone 线路 `{id, deleted:true, payload:null}`；活实体载荷不匹配 `/audio|base64|pcm|blob|data:audio/i` |
| list* 过滤 | tombstone 与 `{nonsense:true}` 脏行丢弃，只剩合法行 |
| 合并 | 本地较新/相等保留本地富会话（shadowAttempts 在）；云端较新用云端精简版；不相交 id 并集；updatedAt 倒序 |
| B 端首拉全量 | A 端 3 条 wire → 落库 baseVersion=version、dirty=false → listSessionRecords 读到 3 条 |
| 双端改同一条 | 本地 dirty updatedAt 5000 vs 服务端 4000 → 409 后携 serverVersion 重推 accepted、dirty 清零、本地内容落库 |
| A 端删 1 条 | B 端 pull 到 deleted:true → 落库 deleted、payload 清空、list 不再返回 |
| 游客未登录 | syncSpeakRecordsSilently 直接跳过，零网络 |
| 登录态读取失败 | 不同步不出网（宁可跳过） |

**`src/views/RedeemCard.test.tsx`**（175 行）：三个业务码逐字映射；`validation_error`/未知码落兜底；非 JSON/非信封 body → 兜底 + 错误码解析 null；锚点 `id=account-redeem` 且空输入禁用提交；submitting 态按钮「兑换中…」+ 输入/按钮全禁用 + 透传 trim 后的码；success「兑换成功，额度已到账」+ 输入清空；error not_found「兑换码不存在」+ 输入保留；expired/used 同映射；redeemCode reject → 「兑换失败，请稍后再试」；Enter 等效提交。

**`src/core/speakUi.test.ts`**（+11 行）：「额度用尽 → redeem」——三种形态（带重置时间「本月朗读额度已用完，11 月 1 日重置」/ 兑换指路「…可在「设置 → 账号」用兑换码补足」/ 识别额度同款）都 `kind==="redeem"` 且 message 含「额度已用完」。

**Rust `sync.rs` 测试**（`sync.rs:488-503`）：`local_collection_whitelist_guards_paths`——`speak-scenarios/speak-sessions/speak-assessments` 通过，`../../etc/passwd / unknown / a/b / ""` 拒绝。

**验证命令**（`docs/speaking-records-sync-implementation-2026-10-28.md:116-124`）：Windows 侧 `npm test`（vitest）、`npx tsc --noEmit`、`cd src-tauri && cargo test`；服务端在仓外 `apps/api`（jest 54 套件，本仓不可跑）。

---

## 2. Mac 落点设计

Mac 现状（均已实证）：账号侧仅有 `ServerAuth.swift` 的 `/v1/auth/*`、`/v1/me`、`/v1/me/config`（`ServerAuth.swift:540-711` 登录登出刷新、`:486-533` withAuth、`:1024-1042` 云端配置重拉/登录后自动拉取）；`LoginWindowController.swift:1207` `AccountSectionView` 已复刻账号卡（profile/登录信息/云端配置/登出），`:1324` 云端配置重拉按钮；`SpeakStore.swift` 本地 JSON 持久化（50 条上限，无上传）；`SpeakViewController.swift:147-149` recentSessions 只读本地；设置窗账号导航 `Settings.swift:1031-1035`/`:1234-1237` 已有「切到账号分区」通道。**没有任何 /v1/sync 与 /v1/redeem 代码。**

### 2.1 新建文件清单

| 文件 | 内容 | Windows 对应 |
|---|---|---|
| `Sources/ImmersiveTranslator/SyncStore.swift` | 本地同步实体存储：`LOCAL_COLLECTIONS` 十集合白名单 + `validateCollection` 路径守卫；`StoredSyncEntity`（camelCase 键，与 `sync.rs:60-75` 一字不差）；每集合一个 `sync/<collection>.json` + `sync/cursors.json`（原子写 tmp+rename，schemaVersion 校验，损坏/版本不兼容报错文案同 `sync.rs:203-207`）；API：`list/put/replace(collection, entities, cursor:)/cursorGet/cursorSet`。可选 `expectedNamespace` 参数（见 §2.3） | `sync.rs:28-39,46-75,194-287` |
| `Sources/ImmersiveTranslator/SyncEngine.swift` | 协议引擎：常量（500/200/64KB 双集合特配/512KB/400 页/3 轮/3 次）、`WireEntity/PullPage/PushOk/SyncConflictEntry` 解码、`SyncSummary`、`pullAll`（含 stale_cursor 重置、首拉全量、429 退避）、`pushDirty`（预检 skip 三态、分批 200/2MB）、`pushBatch`（409 三形态/幽灵实体/413 剔除/429）、`syncNow`（串行队列、不抛错）；错误文案逐字复刻 §1.3/§1.6；`ORIGIN_DEVICE = "mac"` | `syncEngine.ts:41-458` |
| `Sources/ImmersiveTranslator/SpeakRecords.swift` | 记录层：常量、`SpeakSessionRecord/SpeakAssessmentRecord` 与投影/还原、两形状守卫、`withoutAudio`（键黑名单同 `relay.ts:54`）、`enqueue/overflowTombstones/tombstone`、`listSessionRecords/listAssessmentRecords`、`mergeSessionsWithRecords`、`enqueue*/record*Silently`、`deleteSessionRecord/deleteAssessmentRecord`、`syncSpeakRecordsSilently`（先查 `serverAuth.status.loggedIn`） | `speakRecords.ts` 全文件 + `relay.ts:41-59` |
| `Sources/ImmersiveTranslator/RedeemService.swift`（或并入 ServerAuth 扩展） | `POST /v1/redeem`：body `{"code":"…"}`，经 §2.2 的鉴权请求通道；返回 `{status, body, retryAfterSeconds}`；`redeemErrorCodeOf`（宽松解析 `{error:{code}}`，非 JSON → null）+ `redeemErrorText` 三码映射 + 兜底 | `redeem.rs:21-42`、`RedeemCard.tsx:19-48`、`tauriBridge.ts:521-525` |
| `Sources/ImmersiveTranslator/RedeemCardView.swift` | 兑换码卡 SwiftUI 视图：状态机 `idle/submitting/success/error`、文案逐字复刻 §1.6、accessibilityIdentifier `"account-redeem"`、提交中禁用、Return 键提交、success 清空输入 | `RedeemCard.tsx:50-116` |
| `Tests/ImmersiveTranslatorTests/SyncEngineTests.swift` | 见 §2.5 | `syncEngine.test.ts`（同向量） |
| `Tests/ImmersiveTranslatorTests/SpeakRecordsTests.swift` | 见 §2.5 | `speakRecords.test.ts`（同向量） |
| `Tests/ImmersiveTranslatorTests/RedeemTests.swift` | 见 §2.5 | `RedeemCard.test.tsx`（同向量） |
| `Tests/ImmersiveTranslatorTests/SyncStoreTests.swift` | 白名单路径守卫/游标默认 0/原子写/版本不兼容文案 | `sync.rs:488-503` |

### 2.2 修改文件清单（附证据行号）

| 文件 | 改动 |
|---|---|
| `Sources/ImmersiveTranslator/ServerAuth.swift` | ① 在内部 manager 暴露鉴权传输入口：`func authorizedRequest(method:path:body:) async throws -> AuthHttpResponse`，实现即复用既有 `withAuth`（`ServerAuth.swift:486-533`——已含 401 token_expired 单飞刷新重放、fatal 清凭据，红线对齐）。② `ServerAuthClient` 上加瘦封装 `syncPull/syncPush/redeem`（GET/POST 拼 path，query 编码），非 2xx 原样带回。传输复用 `URLSessionAuthTransport`（`ServerAuth.swift:128-176`，已带 retry-after 头解析）。 |
| `Sources/ImmersiveTranslator/LoginWindowController.swift` | `AccountSectionView`（`:1207` 起）已登录分支、`detailRows`（约 `:1300-1330`）之后插两卡：①「口语场景云同步」卡——标题/标签/提示/按钮/汇总文案逐字 §1.6，`handleSyncScenarios` 顺序 await 三集合 `syncNow` 后 `mergeSummaries` 一条反馈（复用既有 `messageBar` 三态 `:1382-1412`，成功 ok 绿/失败 err 红，同 Windows msg-bar 口径）；② `RedeemCardView`。注意 Windows 的汇总/合并函数（`AccountSection.tsx:89-122`）是纯函数，建议提为可测的 `SyncSummaryText.swift` 或放入 SyncEngine 文件供单测。 |
| `Sources/ImmersiveTranslator/SpeakViewController.swift` | ① 入口 `refreshRecent`（`:147-149`）改为「本地富会话 + `listSessionRecords()` 合并」（`mergeSessionsWithRecords`，展示同取前 N）；② 挂载/入口出现时 `syncSpeakRecordsSilently()`，任一 summary `appliedRemote > 0` 重拉刷新（对齐 `SpeakView.tsx:369-386`）；③ 评测入队钩子：发音评测（对齐 `SpeakView.tsx:753-759`）与跟读（`:1102-1108`）在**非 rejected/非异常**结果处 `recordAssessmentSilently(source:.coach, refText:, sessionId:)`；④ 保存路径（`store.saveSession` 各调用点，如 `:163/:415/:479/:521/:551/:833`）后走 `enqueueSessionRecordSilently`（或按 §2.3 的 SpeakStore 写穿设计）；⑤ 超限 toast：富会话 JSON 字节数 > 65536 → 提示文案 §1.6（对齐 `SpeakView.tsx:456`）。 |
| `Sources/ImmersiveTranslator/SpeakView.swift` | 「继续上次的对话」区（`:275-280`）数据源不变（controller.recentSessions 已含合并结果）；通知/错误位补「兑换更多额度」动作（对齐 `SpeakView.tsx:1700-1710`：notice 含「额度已用完」→ 主按钮，点击调设置窗账号导航）。 |
| `Sources/ImmersiveTranslator/ShadowAssessController.swift` | `handleResult`（`:286` 起，真实 ISE 结果落点）加 `recordAssessmentSilently(source:.reader, refText: text)`（对齐 `useShadowAssess.ts:172`；rejected/exceptInfo 非空不计）。 |
| `Sources/ImmersiveTranslator/ShadowDrillView.swift`（或其控制器） | 单词跟读出分处 `recordAssessmentSilently(source:.coach, refText: entry.text)`（对齐 `ShadowDrill.tsx:126`）。 |
| `Sources/ImmersiveTranslator/SpeakStore.swift` | 二选一（见 §2.3）：A. 保持纯本地，入队由 controller 显式调用；B. `saveSession/deleteSession` 内嵌 speak-sessions 入队/tombstone（写穿，对齐 Windows v2 `derive` 的「保存与 outbox 同事务」语义，Swift 无事务则以「同一次串行队列写」近似）。推荐 B（少一个漏接面）。 |
| `Sources/ReaderCore/SpeakLogic.swift` | 若评测入队需要 `PronunciationResult` 的精简映射，`SpeakAssessmentRecord` 构造器放 ReaderCore（纯函数可测）；`SpeakSession`（`:398-434`）不改字段——投影在外层。 |
| `Sources/ImmersiveTranslator/Settings.swift` | 账号分区（`:1447` AccountSectionView）无需结构改动；如需「语音页 → 兑换卡」跳转定位，用 `ScrollViewReader` + `accessibilityIdentifier("account-redeem")` 滚动/聚焦（对齐 `Settings.tsx:283-291` 80ms 延迟 scrollIntoView+focus 语义），导航复用 `SettingsAccountNavigation`（`Settings.swift:976/:1031-1035/:1234-1237`，即 Windows `settings_open_tab("account")` 的对应物，注释自证）。 |

### 2.3 架构衔接与取舍

- **鉴权传输**：Mac 无 IPC 边界，`ServerAuth` 的 `AuthTransport`（`ServerAuth.swift:93` 协议）+ `withAuth` 就是 Windows `TokenManager::with_auth` 的对应物；令牌不离开进程，红线 D4/D5 等效满足。`AuthHttpResponse`（`:86-91`）已含 `status/body/retryAfterSeconds`，正好是 `SyncHttpText` 形状。
- **协议引擎可测性**：`SyncEngine` 全部依赖（pull/push 传输、store 原语、登录态）走协议注入（对齐 syncEngine「全部逻辑可用 mock 桥单测覆盖」的分层声明，`syncEngine.ts:16-17`）；测试用内存 store + 队列化 fake 传输，复刻 `speakRecords.test.ts:56-125` 的测试台形态。Mac 已有同款先例：`ServerAuthTests.swift:221` 起的 mock transport 测试。
- **namespace（账号防串）取舍**：Windows 现行带 `expectedNamespace`（`learning_store.rs:58-95`，`account-<email hex>`，guest=`guest`；同步前 `learningNamespace()` 校验，切换即取消）。该机制属 v2 学习接力批次（7fc6abd），非 6630aa7 基线。**本规格建议**：`SyncStore` 的 API 预留 `expectedNamespace` 参数并实现 `sync/<namespace>/` 目录隔离（成本极低，防多账号串数据是硬需求）；若学习接力 v2 域另行立项，与之合流。至少必须实现：登出/切换账号后，同步数据目录切换或按账号隔离，不在账号间泄露（Windows 行为基准 `syncEngine.ts:445`「账号已切换，本次同步已取消」）。
- **practice-task 特例不做**：Mac 无练习接力（v2）功能，`kind==="practice-task"` 合并分支（`syncEngine.ts:180-191`）本期不移植；但要**忽略**（不崩溃）：拉到带 `kind` 的 speak-sessions 载荷按普通记录处理（形状守卫天然放行——守卫只查 id/scenario/difficulty/startedAt/endedAt/turns）。展示合并建议同样跳过 `kind==="practice-task"` 行（`speakRecords.ts:353-355` 一行语义），避免未来 Windows/移动端练习任务在 Mac 口语列表露头。
- **review-events 不可变冲突**：Mac 本期不同步 review-events（那是复习域），`immutable_entity` 409 分支可不移植；若 SyncEngine 做成通用的，保留该错误分支文案「不可变学习记录冲突，已保留本地待同步数据」以备后续域接入（对齐 `syncEngine.ts:363`）。

### 2.4 需补的 Swift 测试清单（与 Windows 单测行为向量对齐）

1. **SpeakRecordsTests**（= `speakRecords.test.ts` 全部 22 用例，向量逐条照 §1.8 表）：投影保留富字段且无音频键（JSON 断言不含 `audioB64/pcmB64/wavB64`）；往返；64KB 抛错且轮次原样；3000 字不截断；两形状守卫负/正例全集；评测投影四分+逐词+截断+sessionId 可选；入队 baseVersion 沿用/dirty；**零网络**（fake 传输断言零调用）；500 条裁剪最旧转 tombstone；不满 500 不裁；删除 tombstone+重复删 false；**push 载荷红线**（tombstone `payload:null`；活实体 JSON 不匹配 `/audio|base64|pcm|blob|data:audio/i`）；list 过滤脏行；合并（本地≥云端保超集/云端新用云端/并集/倒序）；B 端首拉 3 条；双端 409 重推落库；tombstone 传播；游客跳过；登录态读取失败不出网。
2. **RedeemTests**（= `RedeemCard.test.tsx` 9 用例）：三码逐字；validation_error/未知码/非 JSON 兜底且 codeOf=null；空输入禁用；submitting 全禁用+trim 透传；success 文案+清空；error 文案+保留输入；reject 兜底；Return 键提交。
3. **SyncEngineTests**（对齐 syncEngine.test.ts 关键向量，本域最小集）：pull 分页 hasMore/cursor 推进；stale_cursor 归零全量；429 退避 3 次上限（错误文案逐字）；409 幽灵实体 baseVersion=0；409 本地新重推/服务端新（含相等）采纳；413 payload_too_large 剔除重推；双集合 64KB 预检 skip 文案；push 200 后并发本地编辑不被旧应答清 dirty。
4. **SyncStoreTests**：白名单 `speak-sessions/speak-assessments` 过、`../../etc/passwd/unknown/a/b/""` 拒；cursor 默认 0；schemaVersion 不兼容报「同步数据版本不兼容（文件 vN，应用 v1）。请升级应用后再打开。」。
5. **汇总文案测试**：`syncSummaryText/mergeSummaries`——成功计数串、失败前缀、跳过/冲突/保留段条件出现（文案逐字 §1.6）。
6. **通知分类测试**：含「额度已用完」三种形态 → redeem 档且 message 原样（对齐 `speakUi.test.ts:74-81`）。
7. **回归门禁**：`swift test`（SwiftPM，Tests/ImmersiveTranslatorTests 等 4 个测试 target 既有布局）全绿；不新增产品代码外的构建步骤。

---

## 3. 逐条验收清单（可逐条判定）

1. Mac 本地同步集合白名单包含 `speak-sessions` 与 `speak-assessments`（及 `speak-scenarios` 等 Windows 同款十集合），白名单同时充当路径校验：`../../etc/passwd`、`unknown`、`a/b`、空串被拒（有测试）。
2. `StoredSyncEntity` 字段名/序列化键与 Windows `sync.rs:60-75` 逐字一致（id/baseVersion/updatedAt/deleted/schemaVersion/originDevice/payload/dirty，camelCase）。
3. speak-sessions 投影保留 hintZh/pron/shadowAttempts/coachDiff/context 等富字段（含 v:2、startedAt=createdAt、endedAt=updatedAt），且载荷 JSON 不含任何音频/本地路径键（正则断言）。
4. speak-assessments 记录字段与取值规则逐字段一致：`sa` 前缀 id、source 三值、lang 缺省 "en"、refText 截 1000、四分数值、words ≤64 个且词面 ≤64 字符、sessionId 仅 coach 带、at 时间戳。
5. 64KB 护栏三处齐全：投影超限抛「口语记录超过 64KB 同步上限，完整记录仍保留在本机，请分段练习后再同步」且不裁轮次；push 预检 skip 文案「payload 超过 65536 字节上限（N 字节），完整记录保留在本机」；口语页保存超限 toast「完整练习已保存在本机，已超过单条云同步上限；请另开一组继续练习」。
6. 500 条滚动裁剪：满 500 再入队最旧转 tombstone（保留 baseVersion、payload 空、dirty、updatedAt 晚于被裁记录）；不满 500 不产生。
7. 删除走 tombstone（deleteSession/deleteAssessment 语义），重复删返回 false；tombstone 随同步传播，B 端拉到后 list 不再返回。
8. 拉取协议：since 为版本号游标、每集合独立 cursor、hasMore 追平、首拉全量含 tombstone、stale_cursor 归零重来、429 退避≤3 次（错误文案逐字）。
9. 推送协议：409 整批原子、幽灵实体 baseVersion=0 重推、LWW 本地严格新才重推（相等取服务端）、≤3 轮、413 剔除单实体重推其余。
10. 游客零网络：未登录入队/裁剪/list 全本地；同步触发先查登录态，未登录或读取失败零网络请求（fake 传输断言零调用）。
11. 口语页挂载先合并展示（本地 ≥ 云端保留本地富会话、云端严格新用云端、并集 updatedAt 倒序）再静默同步，appliedRemote>0 刷新一次。
12. 四个评测落点（阅读室跟读 reader；口语页发音/跟读/只练差词 coach）只在非 rejected/非异常结果入队。
13. 账户页「口语场景云同步」按钮一次同步 `["speak-scenarios","speak-sessions","speak-assessments"]` 三集合并**一条**汇总反馈；成功/失败/跳过文案逐字复刻 §1.6。
14. 兑换码卡全部文案逐字复刻 §1.6（标题/标签/提示/placeholder/按钮/成功/三错误码/兜底）；错误码仅映射三业务码、绝不透传服务端 message。
15. 兑换状态机：idle→submitting→success|error；submitting 全控件禁用 + 按钮「兑换中…」；success 清空输入；error 保留输入；Return 键等效提交。
16. `POST /v1/redeem` 请求体 `{"code":<trim后>}`、经登录态鉴权（401 单飞刷新重放一次语义不回退）；非 2xx 原样带回不 reject；仅网络/致命鉴权才走兜底文案。
17. 通知分类：含「额度已用完」→ redeem 档 + 「兑换更多额度」动作位，点击切到设置账号分区并滚动/聚焦兑换码卡（锚点语义 = Windows `id="account-redeem"`）。
18. 音频红线端到端：任何 push 请求体 JSON 不匹配 `/audio|base64|pcm|blob|data:audio/i`；tombstone 线路 payload 为 null。
19. §2.4 列出的 Swift 测试全部存在且全绿；`swift test` 整体 0 失败。
20. 未登录不出现任何登录墙：口语对话/跟读/评测/记录全部本地照常（行为回归）。

---

## 4. 平台差异清单（仅收录必然差异）

1. **originDevice 标识**：Windows 推送 `originDevice:"windows"`（`syncEngine.ts:89`），Mac 必须为 `"mac"`。理由：服务端按设备维度透传该字段用于多端溯源，报真实平台是协议语义而非文案；Windows 自己的测试夹具就用 `"mac"`（`speakRecords.test.ts:73`），服务端对值不做白名单校验（opaque）。
2. **无 IPC 边界**：Windows 的 Rust 命令桥（tauriBridge invoke）在 Mac 不存在，同步/兑换直接进程内调用 `ServerAuth` 鉴权传输。理由：架构差异；令牌「不跨 IPC」红线在 Mac 以「不离开进程」等效满足，行为不变。
3. **本地存储介质**：Windows 现行为 SQLite（`learning_store`，v2）；Mac 建议 JSON 文件（`sync/<collection>.json + cursors.json`，即 `sync.rs:14` 文档化布局）。理由：Mac SwiftPM 工程无 rusqlite 依赖，且该层对协议与 UI 完全不可见（可观察行为——LWW/tombstone/游标/裁剪/dirty——由验收 1-11 约束不变）。
4. **UI 控件形态**：`msg-bar` → SwiftUI `messageBar`（既有三态，`LoginWindowController.swift:1382-1412`）、`input/button` → SwiftUI TextField/Button、Enter → Return 键、DOM 锚点 `id="account-redeem"` → `accessibilityIdentifier` + ScrollViewReader 滚动聚焦。理由：窗口体系与控件 API 必然不同；文案、状态机、交互时序（80ms 延迟定位、禁用态）必须一致，均已写入验收 13-17。
5. **设置窗导航通道**：Windows `settings_open_tab("account")` IPC → Mac `SettingsAccountNavigation.requestScrollToAccount()`（`Settings.swift:1031-1035`，注释自证为对应物）。理由：跨窗通信机制不同；落点行为（切账号分区）一致。
6. **base URL/数据目录解析**：Windows `app_data_dir()` → Mac `~/Library/Application Support/ImmersiveTranslator`；服务端地址解析各自复用已有 auth 配置（Mac `ServerAuthConfiguration.resolveBaseURL`，`ServerAuth.swift:113`）。理由：系统路径与配置装载必然平台化。

除上述外（含所有用户可见文案、错误处理、协议字段、护栏数值、测试行为向量）**一律不许差异**。

---

## 附：勘察证据索引（Windows / 服务端契约文档）

- 提交：`git show --stat 6630aa7`（8 文件：speakRecords.ts/sync.rs/SpeakView/ShadowDrill/useShadowAssess/ReviewView/AccountSection/speakRecords.test.ts）、`git show --stat c1e2ca7`（5 文件：redeem.rs/RedeemCard.tsx/RedeemCard.test.tsx/speakUi.ts/speakUi.test.ts）。
- 记录层：`immersive-translator-windows/src/lib/speakRecords.ts:1-377`。
- 协议引擎：`immersive-translator-windows/src/lib/syncEngine.ts:41-458`（常量 :80-89、64KB 特配 :310、409 处理 :359-401、syncNow :444-447）。
- Rust 传输/存储：`immersive-translator-windows/src-tauri/src/sync.rs:28-39`（白名单）、`:46-75`（SyncHttpText/StoredSyncEntity）、`:108-177`（sync_pull/sync_push）、`:194-200`（路径守卫）、`:488-503`（白名单测试）。
- Rust 兑换：`immersive-translator-windows/src-tauri/src/redeem.rs:21-42`；桥 `immersive-translator-windows/src/lib/tauriBridge.ts:521-525`。
- v2 学习接力交叉：`immersive-translator-windows/src-tauri/src/learning_store.rs:58-95`（namespace）、`:774-798`（hydrate）、`:969-1043`（put/LWW）、`:1056-1131`（enqueue/tombstone/scrub）、`:1320-1360`（derive sessions）、`:1712-1723`（JSON→SQLite 迁移白名单）；`speak_store.rs:167-267`。
- UI：`AccountSection.tsx:89-122`（汇总合并）、`:167-184`（三集合按钮）、`:291-319`（卡+挂 RedeemCard）；`RedeemCard.tsx:19-116`；`speakUi.ts:35,49-78`；`SpeakView.tsx:369-386,447-458,753-759,1102-1108,1609-1625,1700-1710`；`Settings.tsx:283-291`；`ReaderApp.tsx:222-224,2806-2817`；`ShadowDrill.tsx:126`；`useShadowAssess.ts:172`。
- 共享包：`packages/learning-core/src/relay.ts:41-59`（mergeRelayPayload/withoutAudio）。
- 测试：`speakRecords.test.ts:1-570`（用例名清单实读）、`RedeemCard.test.tsx:50-160`、`speakUi.test.ts:74-81`。
- 服务端契约（仓外代码，以文档为准）：`docs/server-architecture-plan-2026-09-22.md:343`（/v1/redeem）、`:352-366`（/v1/sync 端点与语义）、`:453-461`（RedeemCode 模型）、`:485`（错误形状）；`docs/voice-cloud-implementation-contract-2026-10-28.md:33`（quota_exceeded 文案/动作）、`:55`（§三.10 兑换入口）；`docs/speaking-records-sync-implementation-2026-10-28.md`（schema/护栏/服务端改动清单/验证命令全文）。
