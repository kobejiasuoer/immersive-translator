# 学习接力 v2（Learning Relay）— Mac 1:1 移植规格

- 基线 commit：`7fc6abd`（feat(windows): 学习接力 v2——共享 learning-core 包、练习接力视图、跨端同步与账号防串）。
- 证据标注：所有 `path:line` 均为本会话实测读到的行号；测试结论标注实际执行过的命令。
- 服务端注意：`immersive-translator-server/` 目录**不存在于本仓库**（本会话 `ls` → No such file or directory；`git ls-files` 无任何 server 文件；`docs/mobile-impl-acceptance-2026-10-31.md:244` 亦记录同样事实）。§1.4 的端点契约由 `contracts/learning-relay-v2.md` + Windows 双端实现（`src-tauri/src/sync.rs`、`src/lib/syncEngine.ts`）+ 手机端实现（`immersive-translator-mobile/src/services/sync.ts`、`cloud.ts`）三方交叉实证推导，**未经服务端源码核实**。

---

## 1. Windows 行为规格

### 1.1 功能入口与交互流

学习接力 v2 由五块组成：共享逻辑包、学习数据存储（SQLite+命名空间）、练习接力视图、跨端同步引擎、账号防串守卫。

**A. 共享逻辑基准 `packages/learning-core`（TS，跨端逻辑唯一基准）**

| 模块 | 职责 | 关键锚点 |
| --- | --- | --- |
| `srs.ts` | 四档 SRS：初始 ease 2.5，delta forgot −0.2 / hard −0.15 / good 0 / easy +0.15，ease 夹 [1.3, 2.8]；intervalDays forgot→0 否则 `max(prev, {hard:1, good:3, easy:7})`；dueAt = now + 档位毫秒（600000/86400000/259200000/604800000）；reps+1；forgot 时 lapses+1 | `packages/learning-core/src/srs.ts:1-13` |
| `reviewEvents.ts` | `isReviewEvent` 校验（v===2、id/wordId/deviceId/mode 非空串、reviewedAt 有限非负、day 匹配 `^\d{4}-\d{2}-\d{2}$`、undo 必须带 reversesEventId 且无 grade/supersedes、grade 的 grade ∈ 四档且无 reversesEventId、supersedesEventId ≠ 自身、recall.bucket ∈ pass/wrong/trap）；`canonicalJson`（键排序、滤 undefined）；`reduceReviewEvents`：按 ID 去重（同 ID 不同内容抛 `Immutable review event conflict: <id>`）→ 过滤 wordId+generation（无 generation 的事件只归 `legacy-` 代）→ `reviewedAt/id` 排序 → 逆向禁用 undo/supersede 目标 → 同根并发改评只留一个 winner → 从 baseline 逐事件 gradeSrs + recall 分桶（total/byMode/lastAt） | `packages/learning-core/src/reviewEvents.ts:10-19,20-24,26-55` |
| `relay.ts` | 正文实体编解码：`contentRevision`（去句子顶层派生 `id` + `withoutAudio` 后 canonicalJson，FNV-1a 32 位按 **UTF-16 code units** 遍历，`h=2166136261`，`h^=unit; h=Math.imul(h,16777619)`，`(h>>>0).toString(36)`）；`sentenceId = <articleId>:s<idx>`；`entitiesFromArticle`（默认 targetBytes 262144，deviceId 空/目标 <1024 抛错；单句超限抛 `Sentence exceeds content chunk limit: <idx>`；产出 content-chunk（id=`chunk:<articleId>:<rev>:<batchHash>`）+ article manifest（去 sentences/progress，带 v:2/kind/contentRevision/chunkIds）+ progress（id=`progress:<articleId>:<deviceId>`，locator.sentenceId，lastReadAt，sentenceIdx/percent/secondsListened）；`articleFromEntities`（manifest 缺任一 chunk/revision 不符 → null，**不落半成品**；progress 取同 revision里 lastReadAt 最大者）；`mergeRelayPayload`（按 id/idx 对齐的深度保留合并）；`withoutAudio`（递归删除 14 个私有音频键 `audio/audiob64/audiobase64/audio_base64/pcmb64/pcm/pcm_base64/wavb64/wav/blob/audiofile/audiopath/localpath`，键名小写匹配，JSON Pointer 路径也检查） | `packages/learning-core/src/relay.ts:6-12,13-16,17-31,32-40,41-53,54-59` |
| `practiceMerge.ts` | 练习任务字段时钟合并：`stampPracticeTask(previous,next,at)` 只给真正变化的叶字段盖逻辑时钟（`max(at, prevClock+1)`），对象提升为新子字段另加高于祖先清除时钟的 tick；`mergePracticeTask(existing,incoming)`（ID 不同抛 `Practice task IDs differ`；attempts 按 id 并集、按 `createdAt/id` 稳定排序；`removedAttemptIds` 单调并集、删除优先并从显示里滤除）；`mergePracticePayload(existing,incoming)`（双方 kind==="practice-task" 且 task.id 相同才合并，否则 null；信封 endedAt=updatedAt=max；任何一侧 tombstone 不得进此函数——在调用方拦截）。寄存器代数：JSON Pointer 叶路径（`~`→`~0`、`/`→`~1`）、旧根字段 key 兼容读取、无时钟回退 task.updatedAt、相等时钟用 canonical 值按 **Unicode scalar 顺序**稳定决胜（undefined 的编码哨兵为 U+10FFFF 私用区字符 `"\u{10FFFF}"`）、无值但有时钟=显式清除且清除同钟优先、类型冲突的不可见旧值存 `fieldShadow` | `packages/learning-core/src/practiceMerge.ts:97-140,17-19,46,75-96,7-16` |
| `recallJudge.ts` | 产出式判分内核（纯函数）：normalizeAnswer、levenshtein、judgeCloze（perfect→trap→close→wrong；close = 去冠词相等或编辑距离 ≤ max(1,⌊len/6⌋)）、wordDiff（LCS 词级 ok/miss/extra）、wordHitRate（≥0.85 close）、judgeDictation、routeRecallMode（chunk→cloze；intervalDays≥1→dictation；否则 recognition）、verdictToSuggestedGrade（perfect→easy, close→good, trap/wrong→forgot）、firstLetters | `packages/learning-core/src/recallJudge.ts:28-35,38-56,92-102,122-178,186-209` |

Windows 侧 `src/core/readerSrs.ts:12-13` 与 `src/core/recallJudge.ts:1` 已收敛为该包的**转出口**（re-export），自有实现删除。

**B. Rust 学习存储 `learning_store.rs`（Windows 本地权威）**

- SQLite 权威，域文件快照 + outbox 变更**单事务**提交（`learning_store.rs:1-2`）。库文件 `app_data_dir/learning.sqlite3`，`PRAGMA journal_mode=WAL; synchronous=FULL; busy_timeout=5s`；表：`files(namespace,path,content)`、`entities(namespace,collection,id,body)`、`cursors(namespace,collection,cursor)`、`audio_clips(namespace,id,status,metadata)`、`audio_chunks(namespace,id,sequence,pcm)`（`learning_store.rs:128-138,1459-1466`）。
- 账号命名空间：`guest` 或 `account-<user.id 的 UTF-8 字节逐字节十六进制>`（`learning_store.rs:60-85`）。`verify_namespace(expected)` 不匹配 → `"账号已切换，本次操作已取消"`（:86-91）；路径校验 `verify_path` 越界/含 `..`/guest 落 `learning/` 前缀 → `"账号已切换，原学习路径的操作已取消"`（:116-127）。账号数据目录 `app_data_dir/learning/<namespace>`，guest 直接在根（:103-115）。
- 设备 ID：`app_data_dir/learning_device_id` 文件，首次生成 `windows-<pid hex>-<now ms hex>`（:163-179）。
- 写路径 `commit/commit_many`：域文件 JSON 与旧稿做 `preserve_practice_tasks`（练习任务信封永不被旧客户端写剥离，:186-200）+ `merge_unknown`（未知字段保留，:201-225）→ `derive()` 从文件派生 outbox 实体 → 单事务落 files+entities → 事务外导出兼容文件（先写 `*.learning.tmp` 再 rename），导出失败仅 `eprintln` + 事件 `learning-export-warning`（payload `{message:"学习记录已保存，兼容文件导出失败，可稍后重试导出", path}`），**数据不回滚**（:1387-1442）。
- `derive()`（:1272-1386）：articles → `project_article`（chunk/manifest/progress 三类实体，与 relay.ts 同规则，chunk 上限 262144 字节、单句超限抛 `"Single sentence exceeds sync chunk limit"`）；words → `ensure_baseline`（缺 baseline 用当前 srs、缺 baselineRecall 用当前 recall、缺 generation 写 `legacy-<addedAt||createdAt||0>`，:387-409）后 enqueue `reading-vocab`；books → `kind:"book"`、`contentRevision:"book-<createdAt>"`、chapters 补 articleId；sessions → scrub + v:2 + startedAt/endedAt 后 enqueue `speak-sessions`（超限也完整入队不裁剪，:1320-1342）；文件中消失的行 → tombstone；`.md` 笔记 → `notes` 实体 `{v:2,id,meta,content}`。
- `enqueue`（:1056-1089）：与旧 payload merge_unknown 后内容未变则跳过；updated_at = `max(新值, 旧.updated_at+1)`；baseVersion 沿用旧值；schemaVersion=2；dirty=true。`tombstone`（:1090-1116）：payload 置 None、updated_at=`max(now, 旧+1)`、dirty=true。
- `put`（sync 应用层，:973-1036）：`review-events` 同 ID 不同 payload → `"Immutable review event conflict"`；`speak-sessions` 走 `merge_practice_entity`（Rust 版字段时钟合并，任一侧 deleted 时删除优先且保持 dirty，:229-354）；本地 dirty 且较新（或同刻不同内容）→ 保留本地仅吸收 baseVersion；replace 模式先保留全部 dirty、DELETE 全表后重放（pending 里缺席者 baseVersion 归 0）；游标只增；随后 `hydrate`。
- `hydrate`（:616-797）：把实体表投影回域文件——`reading-vocab` → `reader_vocab.json`（words=实体 payload）+ `hydrate_reviews`；`review-events` → `hydrate_reviews`（:565-615：baselineReviewLog 缺省从旧 reviewLog 迁移；逐词 `reduce_word`（Rust 版四档演进，常量与 srs.ts 完全一致，:491-564）并回写实体；reviewLog 按 baseline 天数 + active 事件 day 计数重建）；`reading-articles` → manifest+chunk+progress 组装（chunk 缺失/revision 不符 → **沿用旧域文件版本，不写半成品**，:674-695；progress 取同 revision lastReadAt 最大者恢复 sentenceIdx）；`notes` → `notes/<id>` Markdown（`---\n<meta JSON>\n---\n<content>`，id 含 `/ \ :` 的跳过）；`speak-sessions` → `reader_speak_sessions.json`（补 createdAt/updatedAt）。
- `adopt_guest`（:856-972）：仅当当前 namespace 是 guest；先 `learning_migrate`；单事务把 guest 的 files（按域文件 LWW 合并 `merge_domain_files`，md 同名冲突改 `<stem>-guest-<now>.md`）+ entities（目标已有更新的跳过，否则 baseVersion 沿目标/0、dirty=true）+ audio_clips/audio_chunks 全部划入目标账号命名空间，删除 guest 的 entities/cursors，然后按 5 个集合 hydrate。**只消费活跃游客库；从账号 A 切 B 绝不把 A 带入 B**。
- `learning_commit_review`（:1595-1660）：校验 event（v===2、wordId 匹配）；同 ID 事件已存在且内容相同 → 直接 Ok，不同 → `"Immutable review event conflict"`；merge_unknown 后 ensure_baseline；把全部事件+新事件 reduce_word；单事务：reader_vocab.json 快照 + enqueue reading-vocab + enqueue review-events + hydrate_reviews。
- `learning_migrate`（:1661-1742）：把已存在的 4 个域 JSON + books/notes 目录文件逐个 commit 入库；再导入旧 `sync/<collection>.json`（10 个集合白名单）中本地没有的实体。
- `learning_audio`（:1448-1594）：clipId 空或 >512 → `"Invalid clip id"`。`begin`（metadata 冲突 → `"Clip id collision"`）；`append`（base64 PCM，字节非空/偶数/≤1MiB，序号必须等于已有 count 且状态 recording，重传同序号同字节 OK、不同 → `"Audio sequence collision"`，累计 >20MiB → `"Recording exceeds 20 MiB"`）；`finalize`（标记 ready，返回 byteLength）；`read`（拼全部 PCM，空 → `"没有录到有效声音，已保留当前记录"`；组装 16kHz/16bit/单声道 WAV，返回 `{clipId,status,metadata,durationMs(=len*1000/32000),pcmB64,wavB64}`）；`delete`。跨命名空间读取 → `"原录音仅保存在录制它的设备，这台设备没有原声"`（:1496）。

**C. 同步引擎（前端 `syncEngine.ts` + `learningRelay.ts`，Rust 只做传输/存储原语）**

- `syncNow(collection, options)`（`syncEngine.ts:444-447`）：模块级 promise 队列串行；运行前解析 namespace（options.namespace 或 `learningNamespace()`），若与当前 `learningNamespace()` 不同 → 抛 `"账号已切换，本次同步已取消"`；finally 清空 activeNamespace/options。namespace 透传给所有桥调用（Rust `verify_namespace` 二次守卫）。
- 拉取 `pullAll`（:226-294）：`since` 游标（版本号非时间戳）；limit = `min(500, maxPullLimit||500)`；200 校验（entities 数组、cursor 整数且 ≥ 当前、hasMore 布尔；hasMore 且 cursor 未推进 → `"同步游标未推进"`；形状坏 → `"同步拉取响应无效"`）。cursor===0 时进入**全量暂存模式**：全部页面暂存，最后一页 `syncStoreReplace` 原子替换（保留 dirty；speak-sessions 逐条 practiceEntity 合并）。增量模式逐条：speak-sessions 先 practiceEntity；本地 dirty 且 updatedAt 更新 → 保留本地仅吸收 baseVersion（keptLocal）；否则采纳服务端（appliedRemote）。429 退避 `min(retryAfterSeconds*1000, details.retryAfterMs, 15000)` 默认 1000ms，最多等 3 次后抛 `"同步拉取被限流（429），已等待 3 次仍未通过，请稍后再试"`；`stale_cursor/staleCursor` → 全量重来（全量期间再次失效 → `"全量同步期间游标再次失效"`）；400 页上限 → `"同步拉取页数超过 400，中止（服务端数据异常）"`。
- 推送 `pushDirty`（:300-331）：活实体缺 payload → skip `"活实体缺少 payload，无法推送"`；schemaVersion 不在协商白名单 → skip `"服务端不支持 schemaVersion <v>，完整记录保留在本机"`；字节数（`JSON.stringify(payload)` UTF-8，tombstone 计 0，:162-165）超 `maxEntityBytes`（speak 两集合 65536、其余 512KB）→ skip `"payload 超过 <max> 字节上限（<实际> 字节），完整记录保留在本机"`。批 = `min(200, maxPushEntities)` 且请求体 ≤ `maxBodyBytes`（默认 2MiB），单实体仍超 → skip `"实体连同同步信封超过请求容量，完整记录保留在本机"`。
- `pushBatch`（:333-433）：200 → 逐条与最新本地比较（**ack 旧稿不得覆盖在途新编辑**：updatedAt/payload/deleted 有变 → 保留最新且 dirty）；409 → `details.conflicts[]`；`reason==="immutable_entity"` → 抛 `"不可变学习记录冲突，已保留本地待同步数据"`；`server===null` 幽灵 → baseVersion=0 重推；speak-sessions 先 practiceEntity 合并；否则本地 updatedAt 更新 → 携 serverVersion 重推，服务端较新/相等 → 采纳（防乒乓）；3 轮不收敛 → skip `"冲突 3 轮未收敛，留待下次同步"`；413 `payload_too_large`（details.entityId）→ 剔除该实体 skip `"服务端判定 payload 超限"`；429 同上（`"同步推送被限流（429），…"`）。
- `learningRelay.ts:4-27`：`syncLearningRecords` 单飞（running 去重）：未登录 → `"登录后才能同步学习资料"`；`config.sync.protocolVersion!==2` → `"服务端尚不支持学习接力协议 v2，请升级后同步"`；namespace 捕获后两次复核（变了 → `"账号已切换，同步已取消"`）；`learning_migrate`；按序同步 7 集合 `["reading-articles","reading-vocab","notes","review-events","speak-scenarios","speak-sessions","speak-assessments"]`，仅当 `config.sync.collections[c].schemaVersions` 含 2，options 携带 `{namespace, ...sync 顶层, ...collections[c]}`；完成后 `window.dispatchEvent("learning-sync-complete")`。`syncLearningRecordsSilently` 吞错打日志。

**D. 复习入口改造（readerGradeVocab / readerUndoReview）**

- `readerStore.ts:60-70`：`readerGradeVocab(word, grade, mode="recognition", recall?, supersedesEventId?)` —— 捕获 namespace；并行取 reading-vocab、review-events 实体与 deviceId；baseline/generation 从已存实体回退（`legacy-<addedAt>`）；day=本地 `YYYY-MM-DD`；构造事件 `{v:2,id:cryptoUUID,wordId,deviceId,reviewedAt,day,kind:"grade",grade,mode,generation,recall?,supersedesEventId?}`；`reduceReviewEvents` 归并后调 `learning_commit_review`；返回事件 id。
- `readerStore.ts:72-79`：`readerUndoReview(word, eventId)` —— 无 baseline 抛 `"No review baseline"`；事件 `{kind:"undo",reversesEventId}`；同样归并提交。
- 调用点：主复习流 `ReaderApp.tsx:1757`（recall 分桶从判分上下文传入）；快捷复习 `QuickReviewApp.tsx:149-156`（改评用 `gradeEventIds` Map 传 supersedesEventId，首评后本地 reviewLog 打卡仍走 `recordReview` UI 层 + `readerStats` 取 streak）。
- Rust `learning_commit_review` 内部同样 reduce（双保险），srs/recall 结果以 Rust 落库为准。

**E. 练习接力视图 `PracticeRelayView.tsx`（挂载于口语页）**

- 挂载：`SpeakView.tsx:120,1632-1633`——`<PracticeRelayList>` + `<PracticeRelayView>` 挂在口语页内容流。
- `PracticeRelayList`（:18-30）：读 `speak-sessions` 实体，过滤 `!deleted && payload.kind==="practice-task"`，取 `.task` 经 `isTask` 校验，按 updatedAt 倒序；**无任务时不渲染任何面板**；有任务渲染组标题「继续口语练习」+ 最多 3 行 `recent-session-row`，点击 `window.dispatchEvent("practice-relay-select", task)`；`learning-sync-complete` 事件与 `auth-state-changed` 事件触发刷新，读失败 → toast `"口语练习列表暂时无法读取，请稍后重试。"`。
- `PracticeRelayView`（:33-72）：选中任务后渲染练习面板。刷新逻辑：远端同 ID 任务 updatedAt 更新且本地无草稿未录音 → 静默替换为远端版（:39）。账号切换（auth-state-changed）：epoch++、取消录音、清任务；若登录且 `before==="guest"||before===ns` → 从新命名空间找同 ID 任务恢复并重放挂起的 pending 动作；否则提示 `"登录成功；练习仍在原本机空间，请返回原账号后继续。"`（:40）。
- `save`（:41-57）：以**产生该编辑的 UI 版本**为 previous 盖章（不用更新的远端快照）；读旧实体，`old?.deleted` → 抛 `"这组练习已删除，请新建练习后继续。"`；组信封 `{v:2,id,kind:"practice-task",scenario:"practice",difficulty:"medium",turns:[],createdAt,updatedAt,startedAt,endedAt,task:stamped}`；`withoutAudio(mergePracticePayload(old?.payload, envelope) ?? mergePracticePayload(envelope,envelope))`；实体 `updatedAt=max(next.updatedAt,(old?.updatedAt??0)+1)`、dirty、originDevice=本机 deviceId；payload >65536 字节 → notice `"完整回答和反馈已保存在本机；本组超过云同步容量，请另开一组继续练习。"`（数据照存）。
- `cloud(action)`（:59）：未登录 → 挂起动作 + notice `"登录后将继续刚才的操作，草稿和录音已保存在本机。"` + 打开登录窗；namespace 变了 → 抛 `"账号已切换，请重新打开练习"`。
- 动作：`feedback`（:60，翻译接口产出 JSON `{message,improved,explanation,usedTarget}`，校验失败 `"反馈格式不完整，回答已保留"`；成功 notice `"建议已保存，可在另一台设备继续"` + 静默同步）；`submit`（:61，草稿非空，attempt `{id:UUID,step,text,deviceId,status:"draft",createdAt,reference:reference(t)}`）；`beginRecording/finishRecording`（:63-64，`learning_audio begin`→attempt(status recording)→麦克分块 append→45s 上限→finalize→attempt(recorded)→notice `"原录音已保存在这台 Windows，可回听、转文字或评测发音。"`，失败 `"录音片段仍保留：<错误>"`）；`recognize`（:65，read→transcribeBatch→写 draft，空文本 `"没有识别出文字，录音已保留"`，成功 `"转写已保存，确认文字后再提交表达建议。"`）；`assess`（:66，必须有冻结 reference（`"这次录音缺少冻结原句，不能评测发音"`），read→evaluatePronunciation，isRejected → `"评测未通过：<exceptInfo||"声音不足">"`，否则 `"真实发音评测结果已保存"` + 静默同步）；`play`（:67，read→wavB64→Audio 播放）。epoch/namespace 双重复核贯穿所有云回调（旧响应直接丢弃）。
- UI（:69-71）：标题、`第 N / M 步 · 已完成，可回看|已从保存位置恢复`、参考句 blockquote、「听 TTS 示范」、有 source 时「回到原文这句」（→ 事件 `reader-relay-source`，由 `ReaderApp.tsx:1902` 接：取文章失败 → `"原文已删除，练习仍保留完整参考句和反馈"`，成功则跳阅读并定位 sentenceIdx）；attempt 卡片（文字/`已保存录音，尚未转写`/反馈三行/发音行）；`a.deviceId===device.current` 才有「回听原录音/转成文字/真实发音评测」，否则固定文案 `"原录音保存在录制设备；此处可继续查看文字和反馈。"`；草稿 textarea（maxLength 900）；按钮「录制本机原声|结束并保存录音」「确认文字，获取表达建议」「保存并进入下一步|完成这组练习」。
- 口语记录层 `speakRecords.ts`：speak-sessions 入队 `withoutAudio(mergeRelayPayload(existing, new))`、schemaVersion≥2、500 条滚动裁剪转 tombstone（:221-261）；列表合并时 `kind==="practice-task"` 的行**排除**出普通会话（:353-355）；游客入队/裁剪零网络（:364-376）。

**F. 账号防串（auth.rs 事件化 + 命名空间守卫）**

- 登录/登出/状态命令全部广播 Tauri 事件 `auth-state-changed`（`AuthStatus{loggedIn,user,notice}`，auth.rs:928-947）。
- `after_login_success`（auth.rs:951-971）：`adopt_guest(user.id)`（失败仅日志，游客数据保留）→ `set_account(user.id)` → 广播已登录 → fire-and-forget 拉 `/v1/me/config` 落盘 `server_config.json`（:973-994）。`auth_logout` → `set_account(None)`（:1034）；`auth_get_status` → 按结果 `set_account`（:1054）。
- `with_auth_for_namespace(method,path,body,expected)`（auth.rs:616-687）：发送前 `verify_namespace` + 内存态用户命名空间与所用 token 双校验（不符 → 本地伪码 `account_changed`，message `"账号已切换，本次同步已取消"`，**不出网**）；401 token_expired 刷新重放路径同样先复核（:661-663）。`sync_pull/sync_push` 透传 `expectedNamespace`（sync.rs:108-177）。

### 1.2 UI 状态与用户可见文案（原样抄录）

练习接力面板（PracticeRelayView.tsx）：

| 场景 | 文案（逐字） |
| --- | --- |
| 分组标题 | `继续口语练习` |
| 列表行副文案 | `已完成 · 可回看` / `第 {step+1} 步` |
| 列表行动作 | `查看练习 →` / `继续练习 →` |
| 返回按钮 | `‹ 练习列表` |
| 步行文案 | `第 {step+1} / {steps?.length??1} 步 · 已完成，可回看` 或 `第 {step+1} / {steps?.length??1} 步 · 已从保存位置恢复` |
| 参考句播报 | `听 TTS 示范` |
| 回原文 | `回到原文这句`；原文不存在 toast `原文已删除，练习仍保留完整参考句和反馈` |
| 录音按钮 | `录制本机原声` / `结束并保存录音` |
| 提交按钮 | `确认文字，获取表达建议` |
| 步进按钮 | `保存并进入下一步` / `完成这组练习` |
| 反馈按钮 | `获取表达建议` |
| 本机录音操作 | `回听原录音`、`转成文字`、`真实发音评测` |
| 异机录音说明 | `原录音保存在录制设备；此处可继续查看文字和反馈。` |
| 空文字占位 | `已保存录音，尚未转写` |
| 发音行 | `本次发音评测未通过` 或 `发音 {total}/5 · 准确 {accuracy} · 流利 {fluency}` |
| 草稿框 | aria-label `练习回答草稿`，placeholder `填写回答，或录音后确认转写`，maxLength 900 |

Notice/toast（PracticeRelayView.tsx / learningRelay.ts / syncEngine.ts / learning_store.rs）：

- `口语练习列表暂时无法读取，请稍后重试。`
- `这组练习已删除，请新建练习后继续。`
- `完整回答和反馈已保存在本机；本组超过云同步容量，请另开一组继续练习。`
- `登录后将继续刚才的操作，草稿和录音已保存在本机。`
- `账号已切换，请重新打开练习`
- `反馈未完成，回答已保留`（result.text 兜底）/ `反馈格式不完整，回答已保留`
- `建议已保存，可在另一台设备继续`
- `原录音已保存在这台 Windows，可回听、转文字或评测发音。`（Mac 见 §4 差异 #3）
- `录音片段仍保留：{错误}`
- `没有识别出文字，录音已保留`
- `转写已保存，确认文字后再提交表达建议。`
- `这次录音缺少冻结原句，不能评测发音`
- `评测未通过：{exceptInfo|"声音不足"}` / `真实发音评测结果已保存`
- `登录成功；练习仍在原本机空间，请返回原账号后继续。`
- `登录后才能同步学习资料`
- `服务端尚不支持学习接力协议 v2，请升级后同步`
- `账号已切换，同步已取消`（learningRelay 复核）/ `账号已切换，本次同步已取消`（syncEngine 队列 + auth.rs 守卫）
- `账号已切换，本次操作已取消`（learning_store verify_namespace）/ `账号已切换，原学习路径的操作已取消`（verify_path）
- `同步拉取响应无效`、`同步游标未推进`、`全量同步期间游标再次失效`、`同步拉取页数超过 400，中止（服务端数据异常）`、`同步拉取被限流（429），已等待 3 次仍未通过，请稍后再试`、`同步拉取失败（HTTP {status} {code}）：{message}`、`同步推送被限流（429），…同上`、`同步推送超限（HTTP 413 {code}）：{message}`、`同步推送失败（HTTP {status} {code}）：{message}`
- `活实体缺少 payload，无法推送`、`服务端不支持 schemaVersion {v}，完整记录保留在本机`、`payload 超过 {max} 字节上限（{n} 字节），完整记录保留在本机`、`实体连同同步信封超过请求容量，完整记录保留在本机`、`不可变学习记录冲突，已保留本地待同步数据`、`服务端判定 payload 超限`、`冲突 3 轮未收敛，留待下次同步`
- `学习记录已保存，兼容文件导出失败，可稍后重试导出`（learning-export-warning 事件）、`学习已保存，兼容文件导出失败: {e}`、`学习已保存，兼容文件替换失败: {e}`
- `原录音仅保存在录制它的设备，这台设备没有原声`、`没有录到有效声音，已保留当前记录`、`Recording exceeds 20 MiB`
- 保存复习失败兜底（ReaderApp.tsx:1765）：`保存复习记录失败`
- SRS 档位标签（GRADE_INTERVALS，srs.ts:3-6）：`10 分钟`、`1 天`、`3 天`、`7 天`

### 1.3 数据结构与本地存储

- 实体信封（本地 `StoredSyncEntity`，sync.rs:60-75 / tauriBridge.ts:543-556）：`{id, baseVersion, updatedAt(本地毫秒), deleted, schemaVersion, originDevice?, payload?, dirty}`；线路形态（WireEntity）：`{id, version, updatedAt(ISO 字符串), deleted, schemaVersion, originDevice, payload|null}`；tombstone 线路 payload=null、本地 undefined。转换在 syncEngine.ts:167-203（`Date.parse`/`toISOString`）。
- ReviewEvent（契约 contracts/learning-relay-v2.md:31-39 + reviewEvents.ts:3-8）：`{v:2,id,wordId,deviceId,reviewedAt,kind:"grade"|"undo",mode,generation?,grade?,recall?:{bucket,answer?,expected?},supersedesEventId?,reversesEventId?,day?}`。
- 词条：完整词条 + `baseline`（迁移前真实 SRS）+ `baselineRecall`（真实旧错题统计 `{total:{pass,wrong,trap},byMode,lastAt?}`）+ `generation`（新词条新 generation；旧词 `legacy-<addedAt||createdAt||0>`；删除重加不复用）。
- practice-task 信封（契约 :49-63）：`{v:2,id,kind:"practice-task",scenario:"practice",difficulty:"medium",turns:[],createdAt,updatedAt,startedAt:createdAt,endedAt:updatedAt,task:{id,mode:"word"|"scenario"|"follow",title,reference,word?,source?:{articleId,sentenceIdx},steps?,step,attempts,draft,status:"active"|"paused"|"completed",createdAt,updatedAt,skippedSteps?,removedAttemptIds?,fieldUpdatedAt?,fieldShadow?}}`；attempt `{id,step,text,clipId?,deviceId,feedback?,pronunciation?,status,createdAt,reference?,error?}`。
- reading-articles schemaVersion 2 四类 payload（kind=book/article/content-chunk/progress，字段见 §1.1.A relay.ts 与契约 :16-25）。
- 域文件（兼容导出）：`reader_articles.json`、`reader_books.json`、`books/<id>.json`、`reader_vocab.json`（+baselineReviewLog/reviewLog/readingLog）、`reader_speak_sessions.json`、`notes/*.md`（learning_store.rs:1666-1697、hydrate）。
- 本机录音：`audio_clips/audio_chunks` 两表（PCM 分块，命名空间隔离）；音频字节永不入同步载荷，只同步 `clipId/deviceId` 引用。
- 游标：`cursors(namespace,collection,cursor)`，0=首次全量；版本号空间跨集合共享，每集合各存各（sync.rs:329-331 注释）。
- 集合白名单（sync.rs:28-39）：`history, reading-articles, reading-vocab, notes, glossary, settings, speak-scenarios, speak-sessions, speak-assessments, review-events`。

### 1.4 网络端点与请求/响应契约

（服务端源码不在本仓库；以下由契约与双客户端实现实证推导。）

- `GET /v1/me/config`（Bearer）：`{ ..., sync: { protocolVersion: 2, collections: Record<collection, { schemaVersions: number[], maxEntityBytes: number }>, maxPushEntities: number, maxPullLimit: number, maxBodyBytes: number, ... }, features: { sync?: boolean, ... } }`。依据：Windows `learningRelay.ts:15-23`（读 protocolVersion、collections[c].schemaVersions、把 sync 顶层+集合参数并入 syncNow options，含 maxPullLimit/maxBodyBytes/maxPushEntities/maxEntityBytes）；手机 `cloud.ts:11`、`sync.ts:166`、`sync.ts:317-321`（maxEntityBytes/maxBodyBytes/maxPushEntities 实测消费）。客户端在 protocolVersion !== 2 时拒绝同步（Windows 文案见 §1.2；手机 `当前服务端尚未支持移动端学习同步协议，请先升级服务端`）。
- `GET /v1/sync/{collection}/pull?since={cursor}&limit={1..500}`（Bearer；sync.rs:108-142 把 limit 收敛 clamp(1,500)）：
  - 200 `{collection, serverVersion, cursor, hasMore, entities: WireEntity[]}`；手机端额外接受响应级 `staleCursor:true`（sync.ts:15,239）。
  - 409 `{error:{code:"stale_cursor"}}`（Windows 也接受 `staleCursor` 拼写，syncEngine.ts:287）。
  - 429 `{error:{code:"rate_limited", details:{retryAfterMs?}}}` + 可选响应头 `retry-after`（秒）。
- `POST /v1/sync/{collection}/push`，body `{entities: WireEntity[]}`（WireEntity 此处用 `baseVersion` 替代 `version`，syncEngine.ts:193-203）：
  - 200 `{collection, serverVersion, results: [{id, status:"accepted", version}]}`。
  - 409 `{error:{code:"sync_conflict", details:{conflicts: [{id, serverVersion, server: WireEntity|null, reason?}]}}}`；`reason:"immutable_entity"`（同 ID 复习事件不同内容，服务端拒绝，客户端整体失败保留本地）。
  - 413 `{error:{code:"payload_too_large", details:{entityId, sizeBytes, maxBytes}}}` 或 `{code:"sync_quota_exceeded", details:{usedBytes,deltaBytes,quotaBytes}}`。
  - 404 `{error:{code:"sync_collection_invalid"}}`。
- 认证端点（Mac 已有 ServerAuth 对齐，不重复）：`POST /v1/auth/otp/request|otp/verify|login|refresh|logout`、`GET /v1/me`、`GET /v1/me/config`（auth.rs:689-862；ServerAuth.swift:540-700 同款）。401 仅 `token_expired` 触发单飞刷新重放一次；`token_invalid/token_reused/unauthorized` 清凭据不再刷（auth.rs:657-686）。
- 同步流量挂 `with_auth_for_namespace`：携带 `expectedNamespace`，账号切换即本地取消不出网（auth.rs:616-687）。
- 拉推共用 per-user 120/min 限流桶（syncEngine.ts:14 注释；429 处置见 §1.1.C）。

### 1.5 边界与错误处理

- 不可变复习事件：本地 reduce（reviewEvents.ts:31）与 Rust put/commit（learning_store.rs:1004-1005,1635-1643）双侧拒绝同 ID 不同内容；push 409 `immutable_entity` → 整次同步失败 `"不可变学习记录冲突，已保留本地待同步数据"`（syncEngine.ts:363），本地保留 dirty。不可变事件不允许 tombstone（契约 :41）。
- 删除优先/防复活：practice-task 任一侧 tombstone 终态（syncEngine.ts:180-191 practiceEntity；learning_store.rs:342-354 merge_practice_entity；put:1007-1008）；`removedAttemptIds` 单调并集、删除优先（practiceMerge.ts:105-106,114-126）；重新练习用新任务 ID。已知边界（契约 :73）：服务端清理过期 tombstone 后仅凭「缺失」不能永久防复活，客户端不猜测缺失原因。
- 缺块不落半成品：manifest 引用的任一 content-chunk 缺失或 revision 不符 → articleFromEntities 返回 null、Rust hydrate 沿用旧域文件（relay.ts:33-35、learning_store.rs:653-695）；分页未完整成功不提前替换快照（syncEngine.ts:228-244 全量暂存）。
- 超限不裁剪：单实体超 maxEntityBytes（speak 65536 / 其他 512KB）完整保留本地并给原因，尝试/反馈/文字不丢（syncEngine.ts:310-317；契约 :12；Rust derive 注释 learning_store.rs:1327-1328）。
- ack 旧稿 vs 在途新编辑：push 200 回包与最新本地比较，变了保留最新且 dirty（syncEngine.ts:349-354）；409 合并结果与服务端快照不同 → 保持 dirty 携新 baseVersion 重推（Rust put、practiceMerge dirty 判定 learning_store.rs:349）。
- 事务回滚：域快照+outbox 单事务，任一步失败整体回滚（learning_store.rs:1387-1415；测试 failure_rolls_back_snapshot_and_outbox :1840-1860）。
- 兼容文件导出失败不回滚数据：只发 `learning-export-warning` 事件（learning_store.rs:1416-1441）。
- 音频红线：音频字节/base64/路径/blob 不进同步载荷（withoutAudio 双侧执行 + Rust scrub learning_store.rs:1117-1133 + 测试 practice_shadow_metadata_cannot_transport_private_audio :1814-1817）；`fieldShadow` 里藏的音频键同样被 scrub。
- 游客：可本地阅读/收藏/复习/练习（入队/裁剪零网络）；云动作首次触发时登录并恢复原动作（PracticeRelayView cloud()；speakRecords.ts:364-376）。
- 账号切换：在途请求只能写回捕获的命名空间，否则本地取消（auth 守卫 + syncEngine 队列守卫 + PracticeRelayView epoch 守卫三层）；登录成功 adopt_guest 单向迁移 guest→账号，绝不账号 A→B。
- 服务端协商缺失/版本不支持：不降级裁剪、不伪装成功——集合级 schemaVersions 不含 2 就跳过该集合；协议不是 2 直接报错（learningRelay.ts:16,21）。
- 未知字段：merge_unknown/mergeRelayPayload 保留旧客户端不认识的嵌套字段；旧客户端写回不得剥离（learning_store.rs:201-225、preserve_practice_tasks :186-200）。
- 复习日志真实性：不伪造历史事件；`day` 用于重建真实新复习日志，旧每日历史从 baselineReviewLog 保留（契约 :45；learning_store.rs:571-575,594-613）。

### 1.6 相关 Windows 单测及行为向量（本会话实测运行）

执行命令与结果（在 `immersive-translator-windows/` 下）：
- `npx vitest run src/core/learningRelay.test.ts src/core/practiceMerge.test.ts src/reader/PracticeRelayView.test.tsx` → 3 files / 41 tests 全绿（2026-11-01）。
- `npx vitest run src/lib/syncEngine.test.ts src/lib/speakRecords.test.ts` → 2 files / 51 tests 全绿。
- `cd src-tauri && cargo test --lib learning_store` → **未能运行**：windows 专属依赖 `windows-future`/`windows_core` 在 darwin 编译失败（`cannot find type IMarshal in module windows_core::imp`）。Rust 行为向量以下直接引自源码 `learning_store.rs:1743-1929`，未经本机执行。

**learningRelay.test.ts（14 例）向量**：chunk/未知字段/定位 round-trip（restored.progress 相等、`sentences[1].id==="a:s1"`）；缺 chunk → null 不落半成品；译文/标注变化 → chunk ID 变化而 progress locator 稳定；canonical 键序 + UTF-16 emoji 哈希确定性（`contentRevision([{idx:0,paragraphIdx:0,en:"😀",zh:null,zhState:"pending"}]) === "1mzjf0s"`）；不同 chunk target 不复用 ID（同 ID 必同 payload）；withoutAudio 剥字节留 clipId/deviceId；legacy 投影保留嵌套未知字段；无 generation 旧事件只归 legacy 代；事件乱序/重复确定性归并（reps 稳定）；真实 baseline/recall 快照保留不造假（reps 5→6、recall.total.pass 4→5，且入参对象不被改写）；改评/撤销恢复先前评分不增计数；同根并发改评只算一次；新 generation 不继承旧事件；同 ID 不同 grade 抛 `Immutable`。

**practiceMerge.test.ts（20 例）向量**：fieldShadow 内音频键被 withoutAudio 剥除；双端各追加 attempt 并按 createdAt 稳定排序（old→phone→windows）、合并交换律；同 attempt 的 feedback 与 pronunciation 叶字段独立保留；只给真正编辑的字段盖新钟（未编辑字段保留旧钟）；相等时间戳用 canonical 稳定决胜（"z" 胜）；显式字段清除跨陈旧保存保持；`removedAttemptIds` 防取消复活（stale 设备的 attempt 不回流）；三路离线编辑结合律+幂等；未知嵌套字段保留；等钟嵌套对象任意合并顺序收敛；不同编辑时间的嵌套反馈时钟独立；对象↔标量类型切换经 shadow 收敛；信封只合并同任务 ID（不同 ID/null → 返回 null）、信封扩展字段保留；信封嵌套字段任意顺序收敛；派生字段归一（含缺 endedAt 的旧信封）；对象/标量/数组/清除全组合寄存器代数（9×9×9 笛卡尔）；标量/数组往返后对象恢复且旧子字段不复活。

**PracticeRelayView.test.tsx（7 例）向量**：无练习时不渲染面板；练习行展示 + 后台 `learning-sync-complete` 后刷新到「第 2 步」；选中任务在内容流打开（section 不在列表行内）；游客点云动作 → 弹登录、translate 未调用，登录事件后同命名空间恢复任务、重放挂起动作、feedback 写入 account-a（put 的 expectedNamespace===account-a）、payload.task.attempts[0].feedback 存在；**在途云响应遇切账号被丢弃**（不 put、不显示旧账号反馈、account-b 数据保持空）；在途反馈遇另一设备追加回答 → 保存后双端记录都在（attempts ["attempt-1","phone-added"]）；**远端已删除的任务不被旧 UI 反馈写回**（不 put、显示「这组练习已删除」、实体保持 deleted）。

**syncEngine.test.ts（30 例）向量**：首次空库游标原样落盘；首次全量 dirty=false/baseVersion=服务端版本；分页拉到 hasMore=false；tombstone 覆盖本地活实体（payload 清空）；LWW 本地较新保留内容并随推（keptLocal→pushed）；LWW 服务端较新/相等采纳（防乒乓）；accepted 清 dirty 记版本、tombstone 线路 payload null；409 幽灵（server=null）baseVersion=0 重推；409 服务端较新采纳不重推；409 本地较新携 serverVersion 重推；409 三轮不收敛记 skipped；413 payload_too_large 剔除其余照推；413 sync_quota_exceeded 整次失败；512KB 预检跳过不推（本地保留）；>200 实体分批（200+5）；pull 429 退避重试同页；404 错误码带回；entityPayloadBytes（tombstone 0、中文 3 字节/字）；同 task 双端离线回答在游标 0/10 拉取后都保留并重推（attempts 并集、baseVersion 吸收、dirty 清）；409 携合并结果与服务端版本重推；远端删除不复活（本地 dirty 也 deleted）；本地删除不被远端练习复活（push tombstone 携 baseVersion=30）；全量第二页失败不替换快照/游标（cursor 仍 0、syncStoreReplace 未调用）；staleCursor 全量成功只清 clean 旧记录保留 pending；推送在途新编辑保留 dirty 吸收 ack 版本；不可变事件 409 明确失败本地保留；口语超 64KB 保留本地不发送不截断；按 maxPushEntities/maxBodyBytes 拆批（2 条/1800B → 3 批）；**排队期间切账号取消原账号同步（不出网）**。

**learning_store.rs Rust 测试（10 例，源码 :1752-1928，本机未运行）向量**：practice_merge_keeps_offline_attempts_feedback_and_ise（3 attempts 并集、feedback.message/pronunciation.total/text 独立合并、交换律+幂等）；practice_removal_ids_and_entity_tombstones_prevent_resurrection（removedAttemptIds 删除优先；task tombstone 双向终态且 dirty、baseVersion=9）；practice_clocks_preserve_independent_fields_and_explicit_clears（draft/step/error 独立、显式清除、交换律）；practice_nested_leaf_registers_are_associative（嵌套叶寄存器结合律×2 组）；practice_type_changes_retain_shadow_registers_to_converge（类型切换 shadow 收敛、幂等）；practice_shadow_metadata_cannot_transport_private_audio（scrub 后 fieldShadow 只剩安全字段）；practice_transaction_merge_marks_union_dirty_and_ack_clears_it（并集≠服务端快照→dirty、ack 清）；account_names_are_isolated_and_path_safe（`../a` 十六进制化、无 `/`）；failure_rolls_back_snapshot_and_outbox；unknown_fields_survive_legacy_writes（task.source/turns.audioDevice 保留）；legacy_session_retention_never_deletes_practice_tasks（preserve 幂等、practice-task 不被 50 条裁剪剥离）；utf16_revision_matches_typescript_fixture（`revision([{en:"😀",...}]) === "1mzjf0s"`、中文译文变化→revision 变）；legacy_events_replay_without_modifying_immutable_payloads（legacy 代归属、undo 回退、原事件 payload 不被改写）；oversized_sessions_remain_whole_in_snapshot_and_outbox（70000 字 text 完整入库 dirty）。

**speakRecords.test.ts（21 例）相关向量**：会话投影保留跨设备续练所需提示/发音报告/上下文且不带音频；滚动 500 条裁剪转 tombstone；practice-task 行不进普通会话列表合并。

---

## 2. Mac 落点设计

### 2.1 应新建的 Mac 文件

共享逻辑（放 `Sources/ReaderCore/`，纯 Foundation、无 IO，与既有 ReaderSrs/RecallJudge 同层，Package.swift:36-41 已有 target，无需新增 target）：

1. `Sources/ReaderCore/ReviewEvents.swift` —— Swift 版 `ReviewEvent`、`isReviewEvent`、`canonicalJSON`、`reduceReviewEvents`（基准 `packages/learning-core/src/reviewEvents.ts:3-55`）。canonical JSON 需手写（键按 UTF-16 code unit 排序对齐 JS `Array.prototype.sort` 默认序、滤 undefined、数字格式对齐 JS `JSON.stringify`——见 §4 差异 #8）。
2. `Sources/ReaderCore/RelayEntities.swift` —— `contentRevision`（FNV-1a 32 位，**按 UTF-16 code unit 遍历**，Swift 用 `String.utf16`）、`sentenceID`、`entitiesFromArticle`、`articleFromEntities`、`mergeRelayPayload`、`withoutAudio`（基准 relay.ts:6-59）。注意 JS `charCodeAt` 是 UTF-16 unit，Swift `utf16` 元素同口径（含 emoji 代理对）。
3. `Sources/ReaderCore/PracticeMerge.swift` —— `stampPracticeTask`、`mergePracticeTask`、`mergePracticePayload` 及内部寄存器代数（基准 practiceMerge.ts:97-140；Rust 参考实现 learning_store.rs:229-354，其 BTreeMap 语义更易对齐）。Unicode scalar 比较用 Swift `String` 的 `unicodeScalars` 逐 scalar 比较（对齐 practiceMerge.ts:7-11；Rust 注释明言 UTF-8 序等价）。

应用层（放 `Sources/ImmersiveTranslator/`）：

4. `Sources/ImmersiveTranslator/LearningStore.swift` —— SQLite 权威存储，镜像 learning_store.rs 全部语义：表结构/WAL/busy_timeout（learning_store.rs:133-138）、命名空间（:59-127）、设备 ID（`mac-<pid hex>-<now hex>`，:163-179）、`commit/commitMany`+`derive`+`projectArticle`+`enqueue/tombstone`+`hydrate`+`hydrateReviews`+`reduceWord`+`activeEvents`+`ensureBaseline`（:186-797,1056-1386）、`put`/`cursor`/`list`（:973-1055）、`mergePracticeEntity`（:342-354）、`adoptGuest`（:856-972）、`commitReview`（:1595-1660）、`migrate`（:1661-1742）、`audio(begin/append/read/finalize/delete)` + WAV 组装（:1448-1594）。用系统 `import SQLite3`（零第三方依赖；GRDB 亦可但引入新依赖需另行决策）。数据目录对齐 Mac 既有约定：`~/Library/Application Support/ImmersiveTranslator/`（SpeakStore.swift:16-19 同源），库文件 `learning.sqlite3`、设备 ID 文件 `learning_device_id`、账号子目录 `learning/<namespace>`。
5. `Sources/ImmersiveTranslator/LearningSyncEngine.swift` —— `SyncEngine.syncNow(collection:options:)`（协议决策全量对齐 syncEngine.ts:80-458：常量 500/200/512KB/65536/400 页/3 轮/3 次 429、全量暂存+原子替换、增量 LWW、practiceEntity、409/413/429/stale_cursor 处置、ack 在途保护、字节数口径、namespace 透传与队列取消）+ `syncLearningRecords/silently`（learningRelay.ts:4-27：登录前置、protocolVersion==2、migrate、7 集合按协商过滤、完成后发 `Notification` 名对齐 `learning-sync-complete`）。
6. `Sources/ImmersiveTranslator/PracticeRelayView.swift` —— SwiftUI 版 `PracticeRelayList` + `PracticeRelayView`：无任务不渲染；行「继续口语练习 / 第 N 步 / 继续练习 →」；面板交互与 notice 文案逐字复刻 §1.2；选中/同步完成/账号切换用 NotificationCenter 事件（`practice-relay-select`、`learning-sync-complete`、ServerAuthClient 状态变更）对齐 Windows 的 window CustomEvent；录音走既有 `MicRecorder.swift` + `LearningStore.audio`；「回到原文这句」发 `reader-relay-source` 由 ReaderViewModel 接。
7. `Sources/ImmersiveTranslator/LearningSyncService.swift`（或并入 5）—— 触发面：口语页挂载静默同步（对齐 speakRecords.ts:364-376 / SpeakView.tsx:1632 的挂载位置）、复习评分后静默同步（对齐 PracticeRelayView feedback/assess 后 `syncLearningRecordsSilently`）。

测试（对齐 §1.6 向量）：

8. `Tests/ReaderCoreTests/ReviewEventsTests.swift`
9. `Tests/ReaderCoreTests/RelayEntitiesTests.swift`
10. `Tests/ReaderCoreTests/PracticeMergeTests.swift`
11. `Tests/ImmersiveTranslatorTests/LearningStoreTests.swift`
12. `Tests/ImmersiveTranslatorTests/LearningSyncEngineTests.swift`
13. `Tests/ImmersiveTranslatorTests/PracticeRelayViewTests.swift`（UI 层向量用可注入 store/engine 的 ViewModel 测试承载，等价 Windows jsdom + mock 桥手法）

### 2.2 应修改的 Mac 文件

| 文件 | 修改 | 证据 |
| --- | --- | --- |
| `Sources/ImmersiveTranslator/ServerAuth.swift` | ① `AuthTokenManager` 增加 `withAuthForNamespace(method:path/body:expectedNamespace:)`：发送前 `LearningStore.verifyNamespace` + 内存用户命名空间/所用 token 双校验，不符抛 `AuthError.local("account_changed","账号已切换，本次同步已取消")` 不出网；401 刷新重放路径同样复核（基准 auth.rs:616-687）。② `ServerAuthClient` 登录成功后调 `LearningStore.adoptGuest` + `setAccount`（失败仅日志）再发状态（基准 auth.rs:951-971）；登出/状态查询同步 `setAccount`（auth.rs:1034,1054）。③ `me/config` 落盘 `server_config.json` | Mac 现状：`ServerAuthClient: ObservableObject @Published status`（ServerAuth.swift:914-915）；`withAuth(method:path:body:)`（:486）无命名空间参数；`bootstrap`（:938）已有启动预填 |
| `Sources/ImmersiveTranslator/ReaderViewModel.swift` | `gradeVocab(_:_:mode:verdict:)`（:1819-1843）改造：组 ReviewEvent（含 day/supersedesEventId），调 `LearningStore.commitReview(word:event:expectedNamespace:)`，SRS/recall 结果取 reduce 输出而非直接 `gradeSrs`；失败 toast 保持 `保存复习记录失败` | 现状 :1827 直接 `gradeSrs(word.srs, grade, now:)` |
| `Sources/ImmersiveTranslator/QuickReviewWindow.swift` | `grade(_:)`（:228-236）同上接入 commitReview；改评传 supersedesEventId（对齐 QuickReviewApp.tsx:149-156 的 gradeEventIds 模式） | 现状 :236 直接 `gradeSrs(card.baseSrs,…)` |
| `Sources/ImmersiveTranslator/SpeakView.swift`（或口语容器） | 内容流挂载 `PracticeRelayList` + `PracticeRelayView`（对齐 SpeakView.tsx:120,1632-1633）；挂载时静默同步 | Mac 口语容器为 SpeakViewController/SpeakView |
| `Sources/ImmersiveTranslator/ReaderStore.swift` | 读写经 `LearningStore.commit` 派生 outbox（域文件继续作为兼容导出）；`recordReview`（:348）保留为 UI 打卡，真实每日计数改由 hydrateReviews 重建 | 现状 :297-361 纯 JSON 文件 |
| `Sources/ImmersiveTranslator/SpeakStore.swift` | 会话保存改经 LearningStore enqueue `speak-sessions`（withoutAudio+mergeRelayPayload+500 条裁剪），50 条上限语义保留本地列表；`kind==="practice-task"` 行排除出普通列表（speakRecords.ts:353-355） | 现状 SpeakStore.swift:60-76 纯 JSON |
| `Sources/ImmersiveTranslator/App.swift` | 启动接线：`LearningStore.shared.setAccount(serverAuth.status.user?.id)`、`serverAuth.bootstrap()` 后触发 migrate+（已登录时）静默同步（对齐 lib.rs:1493 `learning_store::init` + auth.rs:1142-1180） | 现状 App.swift:226,342 |
| `Sources/ReaderCore/ReaderSrs.swift` / `RecallJudge.swift` | 收敛为 learning-core 等价实现的唯一基准：gradeSrs 常量已一致（ReaderSrs.swift:36-75），只需删除漂移可能并加对齐测试；不强制改文件名 | 对齐 readerSrs.ts:12-13 / recallJudge.ts:1 转出口策略 |
| `Tests/…` | §2.1-8~13 | — |

### 2.3 与 Mac 既有架构模式的衔接

- **ServerAuth**：复用其可注入 `AuthTransport`（ServerAuth.swift:93）、Keychain 单槽 `AuthTokenStore`（:201）、单飞刷新（:340-444）。新增的 `withAuthForNamespace` 完全照 `withAuth`（:486-538）的闭包结构加 namespace 校验；`SyncHttpText` 语义（非 2xx 是协议数据）直接复用其 `AuthHttpResponse {status,body,retryAfterSeconds}`。
- **登录态事件**：Windows 用 Tauri `auth-state-changed` 事件；Mac 已有 `ServerAuthClient` 的 `@Published status`（ServerAuth.swift:914-915），SwiftUI 视图自动订阅；非 UI 消费者（同步引擎、PracticeRelayViewModel）通过 `objectWillChange`/Combine 订阅，等价 Windows `listenAuthStateChanged`（tauriBridge.ts:712）。
- **存储模式**：Windows reader_store/speak_store 是「原子重写 JSON」，learning_store 是 SQLite+兼容导出双层。Mac ReaderStore/SpeakStore 已是原子重写（ReaderStore.swift:62-67、SpeakStore.swift:43-50）；LearningStore 照搬双层：SQLite 事务权威 + 事务外导出同路径 JSON 文件（沿用 `writeAtomically` 手法），导出失败发 `learning-export-warning` 通知不回滚。
- **练习接力视图**：SwiftUI 声明式，状态机对齐 PracticeRelayView 的 ref 语义（epoch/generation 用 `Int` + 任务取消检查实现）；录音复用 `MicRecorder.swift`，PCM 16k 分块转 base64 追加到 `LearningStore.audio(append:)`；播放用 `AVAudioPlayer` 播 WAV data（等价 PracticeRelayView.tsx:67 的 Audio+wavB64）。判分/评测走既有 Xfyun ISE/翻译通道（ReaderChatClient/TranslationClient）。
- **复习流**：ReaderReviewView/QuickReviewWindow 的评分按钮调用点不变，仅把落库函数换成 commitReview；ReaderVaultView 的错题统计继续读 `word.recall`（由 reduce 重建）。
- **Package.swift**：不需要新 target——共享逻辑进 ReaderCore（纯 Foundation），存储/引擎/视图进 ImmersiveTranslator 可执行 target；测试进现有 ReaderCoreTests / ImmersiveTranslatorTests（Package.swift:50-66）。如希望共享逻辑被 Mac 之外的端复用，可另立 `LearningCore` target，但非必需。

### 2.4 需补的 Swift 测试清单（与 Windows 行为向量对齐）

1. `ReviewEventsTests`：§1.6 learningRelay.test.ts「review event reconstruction」7 向量逐条（legacy 代归属、乱序/重复、真实 baseline、改评/撤销、并发改评、新代际不继承、同 ID 冲突抛错且不改写入参）。
2. `RelayEntitiesTests`：round-trip、缺块 null、译文变化新 chunk ID、**`"1mzjf0s"` 固定 fixture**、chunk target 差异、withoutAudio、mergeRelayPayload 未知字段（§1.6 learningRelay.test.ts 前 8 向量）。
3. `PracticeMergeTests`：practiceMerge.test.ts 全部 20 向量 + Rust practice_* 7 向量（含 shadow 音频 scrub、tombstone 终态、结合律/幂等矩阵）。
4. `LearningStoreTests`：Rust learning_store.rs:1743-1928 的 14 向量（账号隔离与路径安全、事务回滚、未知字段、练习保留、UTF-16 revision fixture、legacy 事件不改写、超大 session 完整入库）+ `adoptGuest` 单向迁移 + `commitReview` 不可变冲突 + `audio` begin/append/finalize/read 边界（含 20MiB 与 WAV 头字节断言）。
5. `LearningSyncEngineTests`：syncEngine.test.ts 30 向量逐条（mock transport + 内存 store，对齐其 beforeEach 测试台手法）。
6. `PracticeRelayViewTests`：PracticeRelayView.test.tsx 7 向量（无任务不渲染、同步完成刷新、选中打开、游客登录恢复挂起动作、**在途切号丢弃旧响应**、在途他端追加回答合并、**远端删除不写回**）。

---

## 3. 逐条验收清单

1. `LearningStore` 命名空间与 Windows 同构：guest=`guest`、账号=`account-<user.id UTF-8 hex>`，`verifyNamespace` 失败文案逐字 `账号已切换，本次操作已取消`（learning_store.rs:60-91）。
2. SQLite schema 与 PRAGMA 逐表逐列一致（files/entities/cursors/audio_clips/audio_chunks；WAL、synchronous=FULL、busy_timeout 5s）（learning_store.rs:133-138,1466）。
3. 设备 ID 格式 `mac-<pid hex>-<now ms hex>` 且持久化在 `learning_device_id`，只生成一次（learning_store.rs:163-179）。
4. `contentRevision` 对 fixture `{idx:0,paragraphIdx:0,en:"😀",zh:null,zhState:"pending"}` 输出 `1mzjf0s`（UTF-16 FNV-1a base36）（relay.ts:7-12；learningRelay.test.ts:11）。
5. 正文实体三件套（chunk/manifest/progress）ID 规则、262144 目标分块、单句超限报错与 Windows 一致（relay.ts:17-31；learning_store.rs:1191-1271）。
6. 缺任一 chunk 或 revision 不符时不得物化半成品文章（hydrate 沿用旧稿）（relay.ts:32-35；learning_store.rs:653-695）。
7. `withoutAudio` 剥除 14 个私有音频键（含 fieldShadow 内嵌路径），保留 clipId/deviceId（relay.ts:54-59；learning_store.rs:1117-1133）。
8. `reduceReviewEvents`：同 ID 不同内容抛错；无 generation 事件只归 `legacy-` 代；undo/supersede 链回退不增计数；同根并发改评只算一次；baseline/baselineRecall 为真实快照不被伪造（reviewEvents.ts:26-55）。
9. SRS 四档常量逐值一致（600000/86400000/259200000/604800000 ms；ease 夹 1.3~2.8；delta −0.2/−0.15/0/+0.15；intervalDays forgot→0 否则 max(prev,1/3/7)）（srs.ts:3-13）。
10. `stampPracticeTask` 只给变化叶字段盖 `max(now, prevClock+1)` 时钟；对象提升子字段时钟高于祖先清除时钟（practiceMerge.ts:81-96）。
11. `mergePracticeTask/Payload`：attempts 按 id 并集、createdAt/id 稳定排序；removedAttemptIds 单调并集删除优先；相等时钟 canonical 稳定决胜；三路合并结合律+幂等（practiceMerge.ts:97-140）。
12. practice-task 任一侧 tombstone 为终态：不与 live payload 合并、保持 dirty、重新练习换新 ID（syncEngine.ts:180-191；learning_store.rs:342-354）。
13. pull 首次全量（cursor=0）暂存全部页后单事务替换并保留 dirty；分页中途失败不替换快照与游标（syncEngine.ts:226-244）。
14. push ack 对应旧稿时保留在途新编辑（dirty、最新 payload），吸收服务端版本（syncEngine.ts:349-354）。
15. 409 `immutable_entity` 整次同步失败，文案逐字 `不可变学习记录冲突，已保留本地待同步数据`，本地 dirty 保留（syncEngine.ts:363）。
16. 超限实体（speak 65536B/其余 512KB）完整保留本地、给出含实际字节数的文案、不发送不截断（syncEngine.ts:310-317）。
17. 按协商 `maxPushEntities/maxBodyBytes/maxPullLimit/maxEntityBytes` 拆批与限页；协议 protocolVersion≠2 或集合 schemaVersions 不含 2 时按 Windows 文案拒绝/跳过（learningRelay.ts:16-23）。
18. 同步集合顺序与门控一致：7 集合、每集合前复核 namespace、完成后发完成通知（learningRelay.ts:20-25）。
19. `withAuthForNamespace` 在账号切换后本地取消（code `account_changed`、文案 `账号已切换，本次同步已取消`），无网络请求（auth.rs:628-641,661-663）。
20. 登录成功先 adoptGuest（guest→账号单向、单事务、音频随迁、A→B 永不发生）再切换命名空间再广播登录态（auth.rs:951-971；learning_store.rs:856-972）。
21. 复习评分经 commitReview：grade 事件带 day/generation/recall，改评带 supersedesEventId，撤销生成 undo 事件；srs/recall 由事件归并重建（readerStore.ts:60-79；learning_store.rs:1595-1660）。
22. 复习日志由 baselineReviewLog+active 事件 day 重建，历史每日计数不伪造（learning_store.rs:565-615）。
23. 本机录音：PCM 分块先落库再云端处理；20MiB 上限、序列冲突拒绝、空音频文案 `没有录到有效声音，已保留当前记录`；WAV 头 16kHz/16bit/mono 字节精确；durationMs=len×1000/32000（learning_store.rs:1448-1594）。
24. 异机录音只显示 `原录音保存在录制设备；此处可继续查看文字和反馈。`，无回听/转写/评测按钮（PracticeRelayView.tsx:71）。
25. 练习接力列表：无任务零渲染；组标题「继续口语练习」；至多 3 行；副文案/动作文案逐字（PracticeRelayView.tsx:22-29）。
26. 练习面板 §1.2 全部按钮与 notice 文案逐字一致（含 64KB 提示、删除提示、登录挂起提示、切号提示、反馈校验提示）。
27. 「回到原文这句」：原文已删 → toast `原文已删除，练习仍保留完整参考句和反馈`；存在 → 跳阅读并定位 sentenceIdx（ReaderApp.tsx:1902）。
28. 游客本地全功能：练习/复习/收藏入队零网络；云动作触发登录并在成功后恢复原动作（PracticeRelayView.tsx:59；speakRecords.ts:364-376）。
29. 保存练习时 previous 取产生编辑的 UI 版本而非更新的远端快照；远端已删除任务保存被拒（PracticeRelayView.tsx:41-57）。
30. §2.4 六组 Swift 测试全部落位并通过，其中固定值向量（`1mzjf0s`、512KB/64KB、400 页/3 轮/3 次、500/200、15s/1s 退避、900 字草稿上限、45s 录音上限、20MiB、500 条滚动、50 条本地会话）逐字面断言。
31. 账号切换瞬间在途云响应被丢弃（不写入新账号、不显示旧账号反馈）、录音被取消、UI 清理（PracticeRelayView.test.tsx:48-54）。
32. 兼容 JSON 导出失败时数据不回滚，仅发 `learning-export-warning`（learning_store.rs:1416-1441）。

---

## 4. 平台差异清单（仅收录平台必然差异）

1. **令牌存储**：Windows DPAPI（auth.rs:283-357），Mac Keychain（ServerAuth.swift:201-233 已有）。理由：OS 凭据保护机制不同；对同步/接力行为无影响，令牌永不进学习数据。
2. **设备标识与 originDevice**：Windows `windows-<pid>-<now>` / fallback 常量 `"windows"`（learning_store.rs:173、syncEngine.ts:89）；Mac 用 `mac-<pid>-<now>` 与 `"mac"`。理由：originDevice 语义就是标设备来源；跨端合并不比较该值，仅展示/音频归属判断（`a.deviceId===device`）用**本机完整 deviceId** 比较，不受影响。
3. **含设备名的文案**：`原录音已保存在这台 Windows，可回听、转文字或评测发音。` 在 Mac 为「这台 Mac」。理由：文案指称当前物理设备；其余文案一律逐字复刻，不得改动。
4. **事件总线**：Windows `window.dispatchEvent`/Tauri event（learning-sync-complete、practice-relay-select、reader-relay-source、auth-state-changed、learning-export-warning）；Mac 用 `NotificationCenter`（ServerAuthClient 已用 `@Published`，非 UI 订阅走 Combine）。理由：进程内广播机制不同；事件名与 payload 保持同名同构。
5. **UI 框架与视觉**：React+reader.css vs SwiftUI+ReaderTheme（ReaderTheme.swift 既有纸感 palette）。理由：渲染体系必然不同；文本、按钮可达性标签、交互状态（busy/recording/disabled 条件）与逻辑必须 1:1，仅视觉 token 随 Mac 主题。
6. **麦克风采集**：Windows Web Audio（micRecorder.ts/pcm16kToBase64）vs `AVAudioEngine`（MicRecorder.swift 已有）。理由：音频 API 不同；落点契约一致：16kHz/16bit/mono PCM 分块 base64 append，先本地后云端。
7. **音频播放**：Web `Audio`+Blob URL vs `AVAudioPlayer`（WAV data）。理由同上；WAV 字节构造完全一致。
8. **JSON/文本细义**：JS `JSON.stringify` 数字格式与 `Array.prototype.sort` 默认 UTF-16 键序 vs Swift `JSONEncoder`；Swift 需手写 canonical JSON 以对齐（含 `-0`、指数记法等边角）。`localeCompare("en")` vs Swift 比较：事件/attempt ID 均为 UUID/`chunk:` ASCII，两种序一致，按字节序实现即可。理由：语言运行时差异；测试用固定 fixture（`1mzjf0s` 等）锁死跨端一致。
9. **UUID 生成**：`crypto.randomUUID()` vs `Foundation.UUID().uuidString`（小写化以对齐）。理由：API 差异，格式语义相同。
10. **日期**：`Date.parse`/`toISOString` vs `ISO8601DateFormatter`（需 `withFractionalSeconds`，JS toISOString 恒毫秒 3 位）。理由：格式化器差异；落库毫秒整数不受影响，仅线路 ISO 字符串需对齐。
11. **Rust 单测不可在 darwin 运行**：`cargo test` 因 windows 专属 crate 编译失败（本会话实测）；Windows 侧 Rust 行为向量须在 Windows CI 上回归。理由：目标平台绑定。
12. **IPC**：Windows 前后端经 Tauri command 传 `expectedNamespace` 做二道守卫；Mac 单进程直接调用，`LearningStore` 方法仍带 `expectedNamespace` 参数并在入口校验（语义等价、防线不减）。理由：架构差异；防线数量与失败文案保持一致。

其余（数据结构、算法、常量、端点、错误文案、测试向量）一律不许差异。

---

### 附：已核实不在本次 1:1 范围的契约文字

`contracts/learning-relay-v2.md:79-81` 描述的「登录时显示游客资料数量、用户选择全部/仅当前任务带入、`local-guest-claims` 待恢复记录、启动恢复屏障」在 Windows 7fc6abd 代码中**不存在**（全仓 grep `local-guest-claims` 零命中；实际实现是 `after_login_success` 无条件 `adopt_guest` 全量带入，auth.rs:951-955）。Mac 1:1 以 Windows 已实现行为为准（adopt_guest 全量迁移）；契约中更细的选择式带入属未实现设计，不在本规格范围。
