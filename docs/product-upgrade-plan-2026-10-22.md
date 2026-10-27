# 沉浸阅读室 · 阅读市场与口语场景库 升级计划书

- 版本：v1.1（2026-10-22，替换 v1.0）
- 状态：待审阅，未开工
- 范围：痛点一「阅读市场」、痛点二「口语场景太少 / 不能自定义」
- 口径：现状描述均附代码位置，已逐条核对；估算类数字均标注「估算」或「待验证」

## 0. v1.0 → v1.1 修订说明

| # | v1.0 的说法 | 核对结果 | 本版处理 |
|---|---|---|---|
| 1 | 阅读室要新增「URL 导入」tab | 已存在：`ImportDialog.tsx:64` 五个 tab（lib/epub/file/url/paste），`UrlTab` 在 :512，走本地 Rust `reader_fetch_url`（`lib/webExtract.ts:20`），不经服务端 | 从计划中删除 |
| 2 | 「epub 已预留枚举但未实现」作为痛点证据 | 错误。`core/bookImport.ts` 是完整 EPUB 解析（分章 / DRM 检测 / 无目录兜底），`EpubTab` 在 `ImportDialog.tsx:816`；`readerTypes.ts:12` 的注释已过时 | 痛点一重新定义（§1.2）；注释顺手修 |
| 3 | 口语 UI 在 `mobile/src/speak/*` | 路径不存在，实际是 `mobile/src/screens/SpeakScreens.tsx` | 全文路径重核 |
| 4 | 口语场景只在 mobile | 三端都有，且各自硬编码同样 4 个场景：Windows `core/speakLogic.ts:15,29`、Mac `ReaderCore/SpeakLogic.swift`、mobile `core/speak.ts:13,28` | 新增三端矩阵（§5），场景结构收敛到 `contracts/` |
| 5 | P0 是 URL 导入，正文又说先做场景库 | 自相矛盾 | 统一为：场景库 P0，阅读市场 P1 |
| 6 | `SPEAK_SCENE_META = await loadScenarios()` | 会破坏现有同步调用（`sceneMetaOf` / `scenarioOf`），且无离线兜底 | 改为「内置兜底 + 本地缓存 + 后台刷新」（§2.2） |
| 7 | 用户场景 CRUD 全部上服务端，含 ScenarioDialogue 示例对话表 | 现有陪练是 LLM 自由对话，不需要脚本；客户端代码中未搜到 `/v1/sync` 调用 | 砍掉对话表；自定义场景先存本地，服务端只做官方场景只读目录 |
| 8 | 陪练每场约 3k token | 每轮请求带历史轮次，累计随轮次二次增长 | 改为公式，约 7k（估算，§4.1） |
| 9 | 讯飞 ISE「￥0.6/次」 | 单位看错：原文是 0.6 分/次 = ￥0.006/次（`voice-roadmap.md:68`，20 万次 1200 元）；且陪练走 ASR 不走 ISE（`SpeakScreens.tsx:286`），ISE 只用于跟读 | 更正，并补上漏算的 ASR 成本（§4.1） |
| 10 | RSS 抓 BBC / Medium 全文入库 | 与「选开放许可源」自相矛盾；服务端聚合境外新闻在境内还涉及新闻信息服务许可 | 书只收公版；资讯改为用户自加订阅、客户端本地抓取（§3） |
| 11 | DAU +30%、7 日留存 +15% 等目标 | 无基线、无依据，且埋点全仓未落地 | 删除；先埋点、跑两周基线再定目标（§8） |
| 12 | 「立即启动 ICP 备案」 | 生产已上线，备案状态未能核实 | 改为待确认项（§7） |

## 1. 现状（已核对）

### 1.1 已有能力

| 能力 | 证据 |
|---|---|
| 服务端 M0–M5 + R1–R9 已上线：账号、LLM 网关、语音网关、同步、计费、管理台 | 服务端 `PROGRESS.md`；`apps/api/src/modules/` 下 11 个模块 |
| 配额四维度已覆盖陪练的全部消耗 | `quota.constants.ts:2`：llm_tokens / tts_chars / asr_seconds / ise_calls |
| 阅读室导入五通道：内置文库 / EPUB / 文件 / URL / 粘贴 | `ImportDialog.tsx:64` |
| 内置文库 6 篇，均来自 Standard Ebooks 公版；头注释写明「文库扩容走服务端（v2.0）」 | `core/library.ts:1-7` |
| 陪练是 LLM 自由对话（场景 = 角色设定 + 开场白），不是固定脚本 | `speakLogic.ts:192` / `speak.ts:87` `buildSpeakSystemPrompt` |
| 陪练已有「目标词命中」判定，可作为场景关键表达的落点 | `speakLogic.ts:340` `textHitsTarget` |
| 同步协议的集合白名单可扩展，目前 6 项 | 服务端 `sync-protocol.ts:10` |

### 1.2 真正的缺口

- 痛点一不是「导入不了」，是「不知道读什么」。五个导入通道都在，缺的是内容的发现与供给：用户得自己去找公版 EPUB 或文章链接。
- 痛点二是场景写死在代码常量里，4 个场景在三端各写一遍。加一个场景要发三端版本，用户也没法描述自己真实的职场处境（我是谁、对面是谁、要谈成什么）。
- 埋点为零。`reading-room-feature-proposal.md` §8 已指出 UX-6 埋点未落地，后面所有成功指标都依赖它。

### 1.3 优先级

1. P0 口语场景库（痛点二）：纯增量，不碰内容版权；三端陪练链路都已完整，只差「场景从哪来」这一环；直接回应「职场场景要更具体、最好能自定义」。
2. P1 阅读市场（痛点一）：书目市场可以做，资讯部分受版权和资质约束，形态要收窄（§3）。
3. P2 社区（公开分享、评分、审核队列）：受合规前置条件约束，本期不排期。

## 2. P0：口语场景库

### 2.1 场景数据结构（三端唯一事实来源）

新增 `contracts/speak-scenario.schema.json`，与 `reading-room.schema.json` 同一管理方式：

```ts
interface SpeakScenario {
  id: string;                 // 内置沿用 "ordering" 等；官方 "off_xxx"；用户 "usr_<uuid>"
  source: "builtin" | "official" | "user";
  title: string;              // 「季度汇报被老板追问数据」
  emoji?: string;
  category: "daily" | "travel" | "workplace" | "academic" | "custom";
  aiRole: string;             // AI 扮演谁、什么性格（≤300 字）
  userRole?: string;          // 用户是谁（≤200 字）
  goal?: string;              // 这场对话要达成什么（≤200 字）
  keyPhrases?: string[];      // 希望练到的表达（≤8 条，接 textHitsTarget）
  opener: string;             // AI 开场白（英文）
  openerZh?: string;
  defaultDifficulty?: "easy" | "medium" | "hard";
  updatedAt: number;
}
```

`userRole` / `goal` / `keyPhrases` 是新增字段，「职场场景更具体」靠的就是这三个：同样是「谈判」，外贸销售对德国采购，和程序员对产品经理争排期，是两种完全不同的对话。现有 4 个场景映射为 `source: "builtin"`，`brief` 字段并入 `aiRole`。

### 2.2 加载方式（替代 v1.0 的 top-level await）

- 内置 4 场景保留在代码里，作为兜底，不删。
- `SpeakScenarioId` 联合类型改为 `string`（Windows `speakLogic.ts:15`、mobile `speak.ts:13`、Mac 同步改）。
- `scenarioOf(id)` 保持同步签名，从「内置 ∪ 缓存的官方目录 ∪ 本地用户场景」合并查找，找不到时回退第一个内置场景（与现有 `?? SPEAK_SCENE_META[0]` 行为一致）。
- 官方目录：启动时读本地缓存，后台拉 `GET /v1/scenarios`，有更新才替换缓存；离线、首启、接口失败时只显示内置场景加用户场景。

### 2.3 自定义场景：「一句话生成」+ 表单微调

用户填结构化表单门槛高，这是 v1.0 风险表里「用户不愿创建场景」的根源。所以编辑器以生成为主：

1. 用户输入一句话，例如「下周要跟德国客户谈合同续约，对方想压价 10%」。
2. 走现有 LLM 调用路径，要求按 §2.1 的字段输出 JSON（aiRole / userRole / goal / keyPhrases / opener / openerZh / category）。
3. 结果进入可编辑表单，用户改完再保存。也可以跳过生成直接手填。
4. 解析失败时保留用户原话，回到空白表单，不静默丢弃。

存储与同步：

- **自定义场景存本地**，用同步协议跨设备（决策点 4：必须进 MVP）。
- **A0 前置任务**：Windows 客户端接入 `/v1/sync/pull` 和 `/v1/sync/push`，服务端 `SYNC_COLLECTIONS` 加 `speak-scenarios`（`sync-protocol.ts:10`），单实体 512KB 上限对场景绰绰有余。
- Mac / mobile 现状未核实，如已接入同步则 A4 只需加集合；如未接入则工作量同 A0。
- 计量：生成调用计入现有 llm_tokens，不新增配额维度。

### 2.4 提示词隔离

- 系统级规则（EN/ZH 两行格式、语音识别容错、不输出额外内容）由客户端模板固定，用户字段只作为带分隔符的「场景资料」插入，各字段限长（见 §2.1）。
- 私有场景：风险可接受。作者本来就控制自己的输入，且 `parseAssistantReply`（`speakLogic.ts:258`）对不合格输出已有宽容降级。
- 公开分享：别人写的 aiRole 可能藏指令，风险在这里。所以公开分享放到 P2，前提是服务端审核加同一套模板隔离。

### 2.5 官方场景目录（服务端只读）

- 一张 `speak_scenarios` 表，字段同 §2.1，加 `status`（draft/published/archived）、`sortOrder`、`version`。Prisma 迁移按仓库惯例附 down.sql。
- `GET /v1/scenarios?since=<version>`：只返回 published，带版本号做增量缓存；公开目录允许匿名读，挂现有匿名端点限流。
- 管理台新增「口语场景」资源页（CRUD + 上下架），变更写 AdminAuditLog，与 Provider / 路由页同一套模式。
- 首批约 30 个场景，以职场为主（汇报、跨部门对齐、客户谈判、面试追问、绩效面谈、电话会议等），由管理台录入。之后上新场景不用发客户端版本。

## 3. P1：阅读市场

「书」和「资讯」的版权与资质条件完全不同，必须分开做。

| | 书目市场 | 资讯订阅 |
|---|---|---|
| 内容来源 | 公版书（Standard Ebooks / Project Gutenberg） | 用户自己添加的 RSS 订阅 |
| 抓取位置 | 服务端入库元信息 | 客户端本地抓取，与现有 URL 导入同性质 |
| 服务端是否存全文 | 只存元信息和下载地址（是否镜像 EPUB 见 §7 决策点 3） | 不存，服务端不参与 |
| 理由 | 公版可以合法分发，与 `library.ts` 现有口径一致 | 英文资讯大多有版权；服务端聚合境外新闻在境内涉及互联网新闻信息服务许可，个人主体通常拿不到（建议确认）；VOA 等源在境内服务器也无法直连 |

### 3.1 书目市场

- 服务端：`books` 表（标题 / 作者 / 简介 / 词数 / 粗分级 / 分类 / 封面 / **EPUB 镜像存储路径** / 来源 / 许可），`GET /v1/books` 搜索和筛选，`GET /v1/books/:id/download` 下载镜像文件（决策点 3：服务端镜像）。全文搜索用 PostgreSQL `tsvector`，几千本的量级不需要 Elasticsearch。
- 入库：沿用 `scripts/build-intake-assets.mjs` 的思路，写成服务端批处理脚本或 BullMQ 一次性任务。EPUB 文件存服务端对象存储或本地文件系统（按部署环境定）。
- 客户端：导入窗或书架加「发现」入口。选中一本书后从 `/v1/books/:id/download` 下载 EPUB，直接交给现有 `EpubTab` / `bookImport.ts` 管线。章节预览、选书雷达、入库都是现成的，市场本质上是导入管线前面加一个目录页。
- 个人化难度（生词本未掌握词密度）继续在客户端算，因为生词本在本地。服务端只给词数和粗分级。
- 待验证：Standard Ebooks 和 Gutenberg 对批量抓取的条款（Gutenberg 禁止对主站自动批量爬取，应使用官方目录文件或镜像）。

### 3.2 资讯订阅

- 用户添加 RSS 地址，客户端定期拉取标题和摘要；点开一篇时复用现有 `reader_fetch_url` 抽正文。
- 需要新增一个抓取 feed 原始 XML 的 Rust 命令：`reader_fetch_url` 返回的是抽取后的正文，不是 feed 本身。加上订阅列表的本地存储和 UI。
- 产品内可以附一份「推荐订阅」清单（只选许可明确的源），用户自行勾选添加。服务端不做聚合。

### 3.3 不变的部分

Windows 的个人 URL 导入保持本地抽取：离线可用，不耗服务端配额。`/v1/extract` 留给没有本地抽取能力的端。

## 4. 成本与计量

### 4.1 陪练单场成本（估算）

`buildSpeakUserInput(turns, userText)`（`speakLogic.ts:234`）入参是全部轮次，每轮请求都带历史（是否截断待确认），所以累计输入随轮次二次增长：

- LLM：系统提示约 200 token，每轮新增约 80 token。第 k 轮输入 ≈ 200 + 80k，10 轮累计输入约 6.4k、输出约 0.8k，合计约 7k token/场。v1.0 的 3k 低估了 2–3 倍。
- ASR：用户每轮说约 6 秒，约 60 秒/场。v1.0 漏算。
- TTS（若走云 TTS）：AI 每轮 1–3 句，约 1.5k 字符/场。v1.0 漏算。
- ISE：陪练不用，只有跟读用，单价 ￥0.006/次。

### 4.2 建模方式

- 不再拍一个总量数字，改为按「每活跃用户每月成本 = 场次 × (LLM + ASR + TTS 单价)」建模。
- 先把服务端 `PRICE_TABLE_JSON` 填上真实单价（PROGRESS.md 遗留项：上游成本默认记 0）。填上之后，现有运营看板就能按 provider 给出真实成本，比任何估算都准。
- 只有走官方云的用户产生平台成本，自带 Key 的用户为 0。各端哪些调用走官方网关、哪些走 BYOK，需确认。
- 场景生成、书目浏览的成本可忽略。EPUB 如果由服务端镜像，要计入带宽和存储。

## 5. 三端覆盖（决策点 1：首发 Windows）

| 功能 | Windows | Mac | mobile |
|---|---|---|---|
| 陪练（现有） | `reader/SpeakView.tsx` | `SpeakView.swift` | `screens/SpeakScreens.tsx` |
| 场景去硬编码 + 官方目录 | **A1 首发** | A4 | A4 |
| 自定义场景编辑器 + 同步 | **A0 + A2 首发** | A4 | A4 |
| 书目市场 | **B2 首发** | 后续 | 后续（mobile 是否已有 EPUB 导入，未核实） |
| 资讯订阅 | **B3 首发** | 后续 | 后续 |

## 6. 路线图（单人，四个代码库加管理台；周数为粗估）

| 阶段 | 内容 | 粗估 | 验收 |
|---|---|---|---|
| **Phase 0（本周）** | 埋点最小集（§8）；填 `PRICE_TABLE_JSON`；修 `readerTypes.ts:12` 过时注释 | 3–5 天 | 事件能落库；看板出真实成本 |
| **A0（前置）** | Windows 客户端同步接入：调用 `/v1/sync/pull`、`/v1/sync/push`，集合白名单加 `speak-scenarios` | 1 周 | 本地场景能跨设备同步；与服务端 M4 协议对齐 |
| **A1** | `contracts/speak-scenario.schema.json`；Windows 场景 id 改 string、合并查找（内置 ∪ 官方缓存 ∪ 本地）、内置兜底 | 3 天 | 原 4 场景行为不变；断网和首启可用；单测覆盖合并与回退 |
| **A2** | Windows 编辑器 + 一句话生成 + 本地存储（`speak-scenarios` 集合） | 4–5 天 | 生成结果可编辑保存；解析失败不丢用户原话；生成解析有单测 |
| **A3** | 服务端 `speak_scenarios` + `GET /v1/scenarios` + 管理台页 + 首批约 30 场景 | 4 天 | e2e（嵌入式 PG）覆盖增量版本和只返回 published；审计可查 |
| **A4** | Mac / mobile 移植 A0–A2 | 1.5–2 周 | 三端同一份契约，共享测试样例；场景跨端同步 |
| **B1** | 服务端 `books` 表 + EPUB 镜像存储 + 入库脚本 + `GET /v1/books` + `GET /v1/books/:id/download` | 1.5 周 | 镜像 EPUB 可下载；公版来源与许可字段齐全；搜索和筛选有 e2e |
| **B2** | Windows「发现」页，接入 `EpubTab` 管线 | 1 周 | 从发现→下载→预览→入库全链路走通；失败有中文原因 |
| **B3** | Windows 资讯订阅（feed 抓取命令 + 订阅列表 + 推荐清单） | 1 周 | 订阅、刷新、点开导入走通；不经服务端 |

**合计约 9–10 周**（Phase 0 + A0–A4 + B1–B3）。决策点 4 选择"必须进 MVP"，A 阶段增加 A0 前置任务。

**P2 社区分享不立项**（决策点 2：个人主体，有合规风险）。

## 7. 需要你拍板的决策点（已拍板，2026-10-22）

| # | 问题 | 决策 |
|---|---|---|
| 1 | 首发端 | ✅ **Windows**。A1–A2、B2–B3 先在 Windows 落地 |
| 2 | 备案主体与类型 | ✅ 个人主体。**P2 社区分享不做**，有合规风险 |
| 3 | EPUB 文件服务端镜像，还是直链源站 | ✅ **服务端镜像**。存储成本可控，下载体验稳定 |
| 4 | 自定义场景跨端同步是否必须进 MVP | ✅ **必须进 MVP**。用户自定义场景要能跨设备 → A 阶段需增加客户端同步接入（约 +1 周） |

## 8. 怎么判断做对了

先埋点跑两周基线，再定数字目标。v1.0 里没有依据的增长目标全部删除。

| 指标 | 回答的问题 |
|---|---|
| 自定义场景渗透率：创建过 ≥1 个自定义场景的陪练用户 / 陪练用户 | 痛点二是否真实存在 |
| 自定义场景练习占比：用自定义场景开始的场次 / 总场次 | 场景是真在用，还是建完就放着 |
| 一句话生成采纳率：生成后保存 / 生成次数 | 生成质量够不够 |
| 官方场景覆盖：被练过的官方场景数 / 上架数 | 首批 30 个场景选得对不对 |
| 发现页导入转化：从发现页导入的书 / 发现页访问 | 痛点一是否真实存在 |
| 市场书 7 日回访率 | 沿用 `reading-room-feature-proposal.md` §8 的 `book_open` 口径 |

Phase 0 最小事件集：`speak_session_start { scenarioSource }`、`speak_session_end { turns }`、`scenario_create { via: "generate" | "manual" }`、`scenario_generate_result { ok }`、`discover_view`、`discover_import { bookId }`、`book_open`。服务端已有的 `usage_events` 能给出陪练用量和活跃数，这些事件补的是行为路径。

## 9. 风险

| 风险 | 应对 |
|---|---|
| 用户不愿自建场景 | 一句话生成降低门槛；首批约 30 个官方职场场景兜底 |
| 生成质量不稳定 | 生成结果必须进可编辑表单；JSON 解析失败回到空白表单并保留原话 |
| 三端场景行为不一致 | 收敛到 `contracts/speak-scenario.schema.json` + 共享测试样例 |
| ~~资讯和公开分享的合规风险~~ | **已规避**：服务端不聚合资讯（客户端订阅）、不做公开分享（决策点 2） |
| 单人维护四个代码库，周期滑动 | 首发只做一端验证；A4、B2–B3 可以按数据决定是否继续 |
| EPUB 镜像带宽和存储成本 | 监控下载量；必要时限速或按配额分档 |

## 10. 下一步

**本周（Phase 0）**:
1. ✅ 拍板四个决策点
2. 埋点最小集落地（§8 事件）
3. 填 `PRICE_TABLE_JSON` 真实单价
4. 修 `readerTypes.ts:12` 过时注释

**下周开始 A0**：Windows 客户端同步接入。

## 修订记录

- v1.0（2026-10-22）：初版。多处现状未核对，见 §0。
- v1.1（2026-10-22）：按代码现状重写。删除已实现的 URL / EPUB 导入项；统一优先级；场景加载改为内置兜底；自定义场景改为本地优先 + 一句话生成；资讯改为客户端订阅；更正 ISE 单价与陪练成本模型；删除无依据的增长目标。
- **v1.1-final（2026-10-22）**：拍板四个决策点。首发 Windows；社区分享不做；EPUB 服务端镜像；场景跨设备同步进 MVP → A 阶段增加 A0 前置任务，总工期 9–10 周。
