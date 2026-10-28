# 口语记录云同步 · 实施方案与验证(2026-10-28)

产品决策(docs/voice-cloud-decisions-2026-10-28.md 决策 6):口语对话记录与跟读评测记录跟账号走,多端云同步;voiceProvider 等本地偏好不入云(主批次已实现)。复用既有 M4 同步协议(/v1/sync,baseVersion 乐观并发 + tombstone + 水位),只新增两个集合,**不设计新协议**。

- 立项:docs/speaking-records-sync-prompt-2026-10-28.md
- 契约:docs/voice-cloud-implementation-contract-2026-10-28.md §五(录音不落盘)

## 一、记录 schema(定稿)

### speak-sessions(口语对话记录)

SpeakSession(富会话,`src/core/speakLogic.ts:262`)的**精简投影**:

```ts
interface SpeakSessionRecord {
  id: string;          // 会话 id(newSpeakSessionId 生成)
  scenario: string;    // 场景引用 id(内置/官方 off_*/用户 usr_*)
  difficulty: "easy" | "medium" | "hard";  // resume 保真所需
  startedAt: number;   // = createdAt(Unix 毫秒)
  endedAt: number;     // = updatedAt(最后活动时间,LWW 时钟)
  turns: { role: "user" | "assistant"; text: string; at: number }[];  // 对话轮次
}
```

**不上云**(投影时剔除):hintZh、shadowAttempts、pron、coachDiff、context(体积与隐私护栏);**音频一律不同步**(录音本就只活在内存)。

### speak-assessments(跟读评测记录)

```ts
type SpeakAssessmentSource = "reader" | "review" | "coach";
// reader=阅读室跟读(useShadowAssess)、review=复习(暂无 ISE 评测,预留)、
// coach=口语陪练(SpeakView 发音评测/跟读/只练差词)

interface SpeakAssessmentRecord {
  id: string;          // sa<时间36进制><随机> 风格,每评测一条、永不更新
  source: SpeakAssessmentSource;
  lang: string;        // 当前恒 "en"
  refText: string;     // 参考文本(≤1000 字符)
  total: number; accuracy: number; fluency: number; standard: number;  // 评分摘要
  words: { w: string; s: number }[];  // 逐词精简结果 {词面,得分},≤64 词,可截断
  sessionId?: string;  // coach 来源关联会话
  at: number;          // 时间戳
}
```

**录音/base64 音频字段禁止出现在任何 push 载荷**(有测试断言红线:`speakRecords.test.ts` push 载荷正则检查)。

### 体量护栏(两端一致)

| 护栏 | 值 | 客户端落点 | 服务端落点 |
|---|---|---|---|
| 单条记录 | ≤64KB | 构建时截断(会话丢最旧轮次≥1、逐词≤64、文本≤1000 字) | SYNC_COLLECTION_MAX_BYTES 413 payload_too_large |
| 滚动保留 | 每集合最近 500 条 | 入队时最旧活实体转 tombstone(本地裁剪) | 不拒收(tombstone 计 0 字节、释放配额) |

服务端 payload 仍为 opaque blob(D5 决策,不解析内容);64KB 是**体积**护栏,形状校验在客户端运行时守卫(`isSpeakSessionRecordLike` / `isSpeakAssessmentRecordLike`,脏行整条丢弃——feedStore 范式)。

## 二、服务端改动(immersive-translator-server)

| 文件 | 改动 |
|---|---|
| `apps/api/src/modules/sync/sync-protocol.ts:23-24` | SYNC_COLLECTIONS 白名单 + speak-sessions/speak-assessments |
| `apps/api/src/modules/sync/sync-protocol.ts:36-44` | SYNC_COLLECTION_MAX_BYTES{两集合:65536} + collectionEntityMaxBytes 回退全局 |
| `apps/api/src/modules/sync/sync.service.ts:95-96` | push 前置校验改用每集合上限(未特配集合仍 512KB) |
| `apps/api/src/modules/sync/sync-protocol.spec.ts` | 白名单断言更新 + 每集合上限单测 |
| `apps/api/src/modules/sync/sync.service.spec.ts`(新增) | 前置校验单测:重复 id 400、双集合 >64KB 413、未特配集合放行、tombstone 计 0 |
| `apps/api/test/sync.e2e-spec.ts` | 白名单用例扩双集合传输层验收 + 64KB 413(E2E_LIVE_DEPS 门控) |
| `apps/api/prisma/schema.prisma:190` / `docs/api.md:208` | 白名单注释/文档更新 |

无 prisma 迁移(collection 是自由字符串)、无 service/controller 结构改动、无新依赖。

## 三、客户端改动(immersive-translator-windows)

核心是新增记录层 `src/lib/speakRecords.ts`(schema+守卫+入队+裁剪+tombstone+合并+静默同步),业务侧全部经它,不另写同步管线:

| 接入点 | 位置 | 说明 |
|---|---|---|
| Rust 本地集合白名单 | `src-tauri/src/sync.rs:28` | LOCAL_COLLECTIONS += 两集合(路径校验+游标校验共用) |
| 记录层(新增) | `src/lib/speakRecords.ts` | 上表全部原语;入队=本地写+dirty,零网络 |
| 会话写入漏斗 | `src/reader/SpeakView.tsx:451` persist | speakSaveSession(本地富会话照旧)+ enqueueSessionRecordSilently(精简投影) |
| 会话列表合并 | `src/reader/SpeakView.tsx:371-385` 挂载 | 本地富会话+云端记录按 id 合并展示,挂载即静默同步 |
| 评测落点×4 | `useShadowAssess.ts:172`(reader)、`SpeakView.tsx:754`(coach·发音)、`SpeakView.tsx:1105`(coach·跟读)、`ShadowDrill.tsx:126`(coach·差词) | 每次真实 ISE 结果(非 rejected/异常)入队一条 |
| 静默同步触发 | `src/reader/ReaderApp.tsx:339` 挂载 + SpeakView 挂载 | syncSpeakRecordsSilently:未登录 authGetStatus 直接跳过,零网络 |
| 手动同步入口 | `src/views/AccountSection.tsx:174` | 既有按钮扩为三集合循环(场景+会话+评测),汇总一句话,无新文案 |

删除走 tombstone:`deleteSessionRecord`/`deleteAssessmentRecord`(speakRecords.ts:299)已具备,UI 删除入口留待后续批次(界面无新文案约束)。多端冲突按协议 baseVersion 乐观并发,客户端 LWW:本地 dirty 且 updatedAt 更新则保留本地并携新 baseVersion 重推,否则采纳服务端(相等也取服务端防乒乓)——引擎既有逻辑,`syncEngine.ts` 未改一行。

## 四、游客(未登录)行为

- 入队/裁剪/list 全是本地 IPC(sync_store_put/list),**零网络请求**(有测试断言);
- 同步触发点先查 auth_get_status,未登录跳过(测试断言 syncPull/syncPush 未被调用);状态读取失败宁可不同步也不出网;
- Rust 侧双保险:sync_pull/sync_push 无 token 时 with_auth 直接本地错误不出网;
- 不新增任何登录墙:游客照常对话/跟读/评测,记录仅本地。

## 五、验证说明(双端模拟)

自动化(已跑通):

| 场景 | 测试 |
|---|---|
| A 端写 3 条 → B 端首拉全量 | `speakRecords.test.ts`「B 端首拉全量」:pull 3 条 wire → 落库 baseVersion/dirty=false → listSessionRecords 可读 |
| 两端各改同一条 → 最后写入胜出 | 「双端改同一条」:本地 dirty updatedAt 5000 vs 服务端快照 4000 → 409 后携 serverVersion 重推 accepted,本地内容落库;引擎级详见 syncEngine.test.ts 409 三形态 |
| A 端删 1 条 → B 端 tombstone 生效 | 「A 端删 1 条」:pull 到 deleted:true → 落库 deleted、payload 清空 → list 不再返回;服务端 e2e「tombstone/复活」覆盖存储侧 |
| 游客全程无网络请求 | 「入队全程零网络请求」「游客未登录零网络」「登录态读取失败不出网」 |
| 体积/滚动护栏 | 64KB 截断(丢最旧轮次)、500 条裁剪(最旧转 tombstone 保留 baseVersion)、tombstone 计 0、payload 无音频字段正则红线 |
| 服务端 64KB 护栏 | sync.service.spec(413+details.maxBytes=65536、未特配集合放行)+ sync-protocol.spec(上限映射/回退)+ e2e(双集合 413、history 同尺寸放行) |

手工双端(真机):
1. 设备 A 登录,口语页进行 2 轮对话 + 1 次跟读;设置→账号→立即同步(或重开阅读室,挂载自动同步)。
2. 设备 B 同账号登录,打开阅读室(挂载自动同步)→ 口语页「继续上次的对话」出现 A 端会话(resume 可续聊,提示/报告为空——投影不含);跟读记录在 sync store(B 端无展示 UI,本批次交付管线)。
3. A、B 同时续聊同一会话后各自同步 → updatedAt 晚的一端内容胜出(另一端下次拉取时覆盖为云端版)。
4. 任一端超出 500 条后继续练习 → 最旧记录被裁剪,下次同步后另一端同步消失(tombstone 传播)。
5. 退出登录:对话/跟读/评测全部照常,任务管理器确认无 /v1/sync 出网请求。

## 六、测试命令

```bash
# 服务端(apps/api)
node node_modules/jest/bin/jest.js --silent --runInBand          # 54 套件 416 用例全绿(e2e 按门控跳过)

# 客户端(immersive-translator-windows)
npm test                                                          # vitest 1107 用例全绿
npx tsc --noEmit                                                  # 类型检查通过
cd src-tauri && cargo test                                        # 140 用例全绿(sync 白名单测试更新)
```
