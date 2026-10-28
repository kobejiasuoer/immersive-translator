# 立项 prompt · 口语对话记录 + 跟读评测记录 云同步

> 日期 2026-10-28。对应产品决策:docs/voice-cloud-decisions-2026-10-28.md 决策 6 后半(voiceProvider 不入云同步已实现;口语对话记录与评测记录**必须**纳入云同步)。
> 用法:新开会话,把下面整个代码块的内容发给 agent。客户端:`D:\workspace\immersive-translator\immersive-translator-windows`,服务端:`D:\workspace\immersive-translator-server`。

````
# 任务:口语对话记录 + 跟读评测记录 纳入多端云同步

产品要求(2026-10-28 决策):用户换设备后,口语对话记录与跟读评测记录要跟着账号走;同时 voiceProvider 等本地偏好**不得**入云同步(主批次已实现,本任务是另一半)。好消息:服务端已有多端同步基建,本任务是往既有协议里加两个集合,不是设计新协议。

## 第一步:核实现状(两仓线索,以实际代码为准)
- 服务端同步基建:apps/api/src/modules/sync/——sync-protocol.ts 定义 SYNC_COLLECTIONS 白名单(history/reading-articles/reading-vocab/notes/glossary/settings/speak-scenarios)、PushEntityDto{id, baseVersion, updatedAt} 乐观并发、pull since/limit、tombstone 与水位;schemas 在 prisma/schema.prisma(SyncCounter/SyncEntity)。
- 先例参考:「speak-scenarios」(口语场景库)已经走完整同步链路——服务端入白名单的校验方式、客户端入队/推送/拉取合并管线,全部照它做。
- 客户端记录现状:localStorage 范式见 src/reader/feedStore.ts(KEY + JSON + 类型守卫丢脏行);口语对话在 src/reader/SpeakView.tsx,跟读评测在 src/reader/useShadowAssess.ts(→ ShadowReport.tsx / ReviewView.tsx / ShadowDrill.tsx);grep "speak-scenarios" 找到客户端既有同步层(sdk/客户端模块)并复用,不另写同步管线。
- 契约与决策:docs/voice-cloud-implementation-contract-2026-10-28.md(§五 硬约束:录音不落盘)、docs/voice-cloud-decisions-2026-10-28.md(决策 6)。

## 目标
1. 新增两个同步集合:speak-sessions(口语对话记录)、speak-assessments(跟读评测记录)。
2. 记录 schema(先定字段再写码,写进交付):
   - speak-sessions:id(uuid)、场景引用 id、开始/结束时间、对话轮次数组({role:"user"|"assistant", text, at});**音频一律不同步**。
   - speak-assessments:id、来源(跟读/复习/陪练)、参考文本、语种、评分摘要(total/accuracy/fluency/standard)、逐词精简结果(可截断)、时间戳;**录音音频一律不同步、不落盘**。
   - 体量护栏:单条 ≤64KB、单用户每集合滚动保留最近 500 条(超出本地裁剪 + 服务端不拒收),写进 schema 校验与文档。
3. 服务端:两集合入 SYNC_COLLECTIONS 白名单 + 每集合体积/形状校验(sync.service 照 speak-scenarios 的方式)+ jest 单测(协议层复用,不另写一套;apps/api 下 node node_modules/jest/bin/jest.js --silent --runInBand)。
4. 客户端:记录写入路径接既有同步层(本地写 + 变更入队),删除走 tombstone;多端冲突按协议 baseVersion 乐观并发(最后写入胜出);未登录(游客)行为完全不变,记录仅本地,不新增任何登录墙。
5. 边界(硬性):voiceProvider/本地偏好不入同步——settings 集合既有「凭据字段上送前剔除」的同款处理;录音文件、base64 音频字段禁止出现在任何 push 载荷。
6. 不 git commit、不改版本号、不新增 npm 依赖;界面无新文案(同步是静默的,失败不打扰,顶多设置页账号区一行同步状态可后续另批)。

## 交付
1. 实施方案:两个 schema、服务端校验点、客户端接入点(写入/删除/合并),全部引用 file:line。
2. 两仓代码 + 单测:服务端 jest(白名单/校验/体积护栏)、客户端 vitest(schema 往返、本地裁剪、tombstone、冲突合并)。
3. 验证说明:双端模拟场景——A 端写 3 条 → B 端首拉全量;两端各改同一条 → 最后写入胜出;A 端删 1 条 → B 端 tombstone 生效;游客全程无网络请求。

````

## 口径说明(为什么这样设计)

- **复用既有协议而非新设计**:服务端 SyncEntity 乐观并发、tombstone、水位都是现成的,`speak-scenarios` 是完整先例——新集合 = 白名单 + 校验 + 客户端适配器,风险和体量都小一个量级。
- **音频绝不同步**:契约 §五 已定录音不落盘;同步的只有文本与评分,天然绕开隐私与大载荷问题。
- **滚动保留 500 条**:同步集合要有体量上限,否则多端长期使用会把 SyncEntity 表推大;500 条对个人学习记录够用且可调。
- **游客零变化**:同步只对已登录用户生效,这是「登录才有价值」的又一动机,但不制造新的登录墙。
