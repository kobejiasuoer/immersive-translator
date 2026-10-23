# 沉浸式阅读/口语学习产品升级 · 实施交接文档

**交接日期**: 2026-10-22  
**计划书**: `docs/product-upgrade-plan-2026-10-22.md` (v1.1-final)  
**状态**: 已拍板，准备开工

---

## 📋 给实施 AI 的 Prompt

```
你好！我需要你实施一个已经规划好的产品升级计划。

## 项目背景

这是一个沉浸式英语学习应用，有三端（Windows/Mac/mobile），技术栈：
- 前端: Tauri 2 + React + TypeScript
- 后端: NestJS + Prisma + PostgreSQL + Redis（已完成 M0-M5 所有基建）
- 仓库结构:
  - 前端: `D:\workspace\immersive-translator` (monorepo: immersive-translator-windows/mac/mobile)
  - 后端: `D:\workspace\immersive-translator-server`
  - 契约: `contracts/` 目录

## 完整计划书

请先阅读 `docs/product-upgrade-plan-2026-10-22.md`（v1.1-final），这是经过代码现状核实和决策拍板的完整计划。

## 你要做的事

按路线图 §6 实施 **Phase 0 → A0 → A1 → A2 → A3 → B1 → B2 → B3**，共 9-10 周工作量。

### 🎯 当前任务: Phase 0（本周，3-5天）

Phase 0 是所有后续工作的前置条件，包含 4 项任务：

#### 任务 1: 埋点最小集落地

**目标**: 补全计划书 §8 定义的事件埋点，让成功指标可测量。

**背景**: 
- 代码库全仓埋点为零（`docs/ux-remediation-plan-2026-09-18.md` 已指出 UX-6 埋点未落地）
- 后端已有 `usage_events` 表，但只记录配额消耗，不记录用户行为路径

**需要实现的事件**（按计划书 §8）:
```typescript
// 口语场景相关
track('speak_session_start', { scenarioId: string, scenarioSource: 'builtin' | 'official' | 'user' })
track('speak_session_end', { scenarioId: string, turns: number, durationSeconds: number })
track('scenario_create', { via: 'generate' | 'manual' })
track('scenario_generate_result', { ok: boolean, parseError?: string })

// 阅读市场相关
track('discover_view')
track('discover_import', { bookId: string })
track('book_open', { bookId: string, chapterIdx?: number })
```

**技术要求**:
1. 前端埋点统一走一个 `track(event, props)` 函数，调用后端 `POST /v1/events`
2. 后端新增 `events` 表或复用现有表结构，存储：userId, event, properties(JSON), timestamp
3. 管理台运营看板能查询和聚合这些事件

**验收标准**:
- [ ] Windows 端调用 `track()` 能成功入库
- [ ] 管理台能看到事件列表和基础统计
- [ ] 有单元测试覆盖事件存储逻辑

**注意事项**:
- 不要做复杂的实时分析，只要能存能查即可
- properties 用 JSONB 存，不要为每个事件建单独的列
- 先只做 Windows 端，Mac/mobile 移植在 A4

---

#### 任务 2: 填充 PRICE_TABLE_JSON 真实单价

**目标**: 让运营看板显示真实的上游成本。

**背景**: 
- 后端 `PROGRESS.md` 遗留项："上游成本核算默认 0（PRICE_* env 留空、语音单价未接 D3-11）"
- M5 运营看板已经能按 provider 聚合成本，但因为单价为 0，显示的都是 0

**需要做的**:
1. 查阅讯飞/DeepSeek 官方计费文档，获取真实单价：
   - DeepSeek LLM: ￥1/百万 token（输入）、￥2/百万 token（输出）
   - 讯飞 TTS: ￥?/千字符（待查）
   - 讯飞 ASR: ￥?/分钟（待查）
   - 讯飞 ISE: ￥0.006/次（已知，见计划书 §4.1 修正）

2. 在服务端配置文件填入这些单价（环境变量或 AppConfig 表）

3. 确认管理台看板能正确显示成本

**验收标准**:
- [ ] 管理台「运营看板」的成本数字不再全是 0
- [ ] 能按 provider 拆分真实成本
- [ ] 单价来源有文档链接备查

---

#### 任务 3: 修正 readerTypes.ts 过时注释

**位置**: `immersive-translator-windows/src/core/readerTypes.ts:12`

**现状**: 注释写着 `"epub 未实现，仅预留枚举"`

**实际**: `core/bookImport.ts` 已是完整的 EPUB 解析器，`ImportDialog.tsx` 也有 EpubTab

**需要做的**: 把注释改成反映真实情况，例如：
```typescript
/** 一篇文章的来源。epub 为整本书导入（按章分 Article）。 */
export type ArticleSourceType = "paste" | "url" | "epub" | "pdf" | "docx";
```

**验收标准**:
- [ ] 注释准确描述现状
- [ ] 没有其他地方引用了这条过时注释

---

#### 任务 4: （可选）核实几个待验证项

计划书里有几处标注了"待验证"，如果能在 Phase 0 确认，对后续实施有帮助：

1. **各端调用是走官方网关还是 BYOK?**
   - 影响成本建模（任务 2 相关）
   - 核实方法：搜代码里调用 LLM/语音的地方，看凭据从哪来

2. **陪练的历史轮次会不会被截断?**
   - 影响成本估算（计划书 §4.1）
   - 核实方法：读 `buildSpeakUserInput` 实现，看有没有只保留最近 N 轮的逻辑

3. **mobile 能不能导入 EPUB?**
   - 影响 A4 工作量估算
   - 核实方法：搜 mobile 代码里有没有 `bookImport` 或类似逻辑

这些不是 Phase 0 的硬性验收项，但最好能在本周确认。

---

## ⚠️ 重要约束

1. **不要改已有功能的行为**
   - Phase 0 只是补埋点和配置，不动核心逻辑
   - 如果发现代码和计划书描述不符，先报告，不要自己猜测并修改

2. **遵循现有代码风格和架构模式**
   - 后端模块结构参考 `apps/api/src/modules/quota/`（有完整的 controller/service/dto/spec）
   - 前端组件参考 `reader/ImportDialog.tsx` 的模式
   - Prisma 迁移必须附 down.sql（参考 `prisma/migrations/m6_admin_accounts/`）

3. **测试覆盖率 >80%**
   - 新增代码必须有单元测试
   - 后端 e2e 用嵌入式 PG + Redis（参考现有测试）
   - 前端组件测试用 vitest（参考 `*.test.ts` 文件）

4. **变更必须可回滚**
   - 数据库迁移要有 down.sql
   - 配置变更要有默认值兜底
   - 不要删除已有代码，只能新增

---

## 📚 关键文档和代码位置

### 必读文档（按顺序）
1. `docs/product-upgrade-plan-2026-10-22.md` - 完整计划（本文档的上级）
2. `docs/server-architecture-plan-2026-09-22.md` - 后端架构设计
3. `PROGRESS.md` - 服务端已完成的里程碑
4. `contracts/reading-room.schema.json` - 数据契约示例

### 代码地图（Phase 0 会用到的）
- 埋点相关:
  - 前端: 新建 `immersive-translator-windows/src/lib/analytics.ts`
  - 后端: 新建 `apps/api/src/modules/events/`（参考 quota 模块结构）
  - 管理台: 扩展 `apps/admin/src/stats/` 或新建 events 资源页

- 成本配置:
  - `apps/api/.env.example` - 环境变量模板
  - `apps/api/src/modules/gateway-llm/` - LLM 成本计算逻辑
  - `apps/api/src/modules/gateway-voice/` - 语音成本计算逻辑
  - `apps/admin/src/stats/` - 运营看板

- 类型定义:
  - `immersive-translator-windows/src/core/readerTypes.ts` - 任务 3 要改的文件

---

## 🔄 工作流程

### 每完成一个任务
1. 提交一个 commit，遵循约定式提交格式（feat/fix/refactor 等）
2. 确保 lint 和测试通过（`pnpm lint` / `pnpm test`）
3. 更新本文档的验收清单（打勾）
4. 向我汇报完成情况和遇到的问题

### 遇到不确定的情况
1. **先读代码**，看现有实现是怎么做的
2. 在相同模块找参考（例如埋点逻辑可以参考现有的 `usage_events` 怎么入库）
3. 如果代码和计划书冲突，**以代码为准**，但要报告差异
4. 实在无法决策的，列出选项和影响向我请示

### Phase 0 完成后
向我汇报以下内容：
1. 每个任务的完成状态（是否通过验收）
2. 遇到的主要问题和解决方法
3. 与计划书的差异（如果有）
4. 对下一阶段（A0）的准备情况

我会审阅后决定是否进入 A0。

---

## 🎯 Phase 0 验收总清单

> **2026-10-23 收尾更新**：按实际完成情况打勾/标注——做到的附提交号，未做到/部分做到的不打勾并注明原因。
> 提交号索引——主仓 `immersive-translator`：ead4357（埋点）、ec98214（注释）、3a3e99c（v0.10.3 回归修复，评审计入本批六提交之一）；
> 服务端仓 `immersive-translator-server`：025cec8（events 端点）、940f50e（管理台页）、cda41b1（单价配置）。
> 截至本更新：除 3a3e99c 已在远端外，主仓 ead4357 / ec98214 与服务端仓三个提交均未 push（两仓本地分别领先 origin/main 2 / 3 个提交，按约束不 push）。

- [ ] 任务 1: 埋点最小集落地 —— 部分完成（3/4 子项；「覆盖率 >80%」未实测）
  - [x] 前端 track() 函数实现（主仓 ead4357：`immersive-translator-windows/src/lib/analytics.ts` 的 track() + EVENT_NAMES；已埋 speak_session_start / speak_session_end / book_open 三事件；scenario_create / scenario_generate_result / discover_view / discover_import 四事件对应功能 UI 属 A/B 阶段尚不存在，仅定义类型未埋点）
  - [x] 后端 /v1/events 端点实现（服务端仓 025cec8：AnalyticsEvent 新表 + POST /v1/events + 管理侧只读查询，迁移附 down.sql；单测 16 例 + e2e 5 例）
  - [x] 管理台能查看事件列表（服务端仓 940f50e：events 资源页——列表/筛选/分页 + 聚合计数卡；EVENT_CHOICES 与服务端 TRACK_EVENTS 逐字对齐）
  - [ ] 单元测试覆盖率 >80% —— 未实测：全程未跑 coverage 统计、无百分比数据；针对性测试全绿（events 单测 16 例、e2e 5 例、前端 vitest 30 例、cargo auth:: 14 例），但 >80% 一项无数据支撑
  
- [ ] 任务 2: 填充真实单价 —— 部分完成（2/3 子项；「看板显示真实成本」未实测）
  - [x] 查到所有上游真实单价（有文档链接）（服务端仓 cda41b1：DeepSeek flash 输入 2 / 输出 8、v4-pro 9/27 元/百万 token（高峰档、缓存未命中口径），讯飞 TTS 0.004 元/次、ASR 0.0026 元/次、ISE 0.006 元/次；来源 URL 与换算口径录于 apps/api/.env.example 计价表注释 :116/:124/:126/:128）
  - [x] 配置已填入服务端（服务端仓 cda41b1：apps/api/.env.example:129 与 deploy/.env.example:115 计价表模板已载真实价；运行时真实值在本地 apps/api/.env——该文件 gitignored 不入库，生产部署时需同值配到服务器 deploy/.env）
  - [ ] 管理台看板显示真实成本 —— 未实测：任务与评审均无看板页面级验证记录（单价换算已由 env / usage-writer 单测逐条核对），且生产服务器 env 未部署真实价，现网看板仍按旧配置显示
  
- [x] 任务 3: 修正过时注释（主仓 ec98214）
  - [x] readerTypes.ts 注释已更新（ec98214）
  
- [x] 任务 4: （可选）核实待验证项 —— 三项全部确认成立（2026-10-23 核实报告；纯核实无代码提交）
  - [x] 确认各端调用走官方网关还是 BYOK —— 结论：仅 Windows+登录+选沉浸云走平台网关计配额；语音全 BYOK/免费/本地；Mac/Mobile 平台成本贡献为零
  - [x] 确认陪练历史轮次是否截断 —— 结论：三端均只取最近 12 轮（speakLogic.ts:235 / speak.ts:107 / SpeakLogic.swift:638），计划书 §4.1「不截断、二次增长」前提不成立
  - [x] 确认 mobile 是否已有 EPUB 导入 —— 结论：无（无 jszip 及电子书库，导入仅 txt）；A4 需移植解析器并新建书/章数据模型与导入向导

- [ ] 通用要求 —— 3/4 子项（「无破坏性变更」按评审结论存在例外）
  - [x] 所有 lint 通过（2026-10-23 编排方统一执行的两仓门禁通过，含 lint / 测试 / 构建）
  - [x] 所有测试通过（同上门禁；评审本机实测全绿：events 单测 16 例 + env/usage-writer 17 例、vitest 30 例、cargo auth:: 14 例、嵌入式 PG+Redis e2e 5 例。注：门禁跑在当前工作树上，树上另有 2 处与本批无关的未提交改动，评审确认均不影响所审代码路径）
  - [x] 代码已提交，commit 信息清晰（主仓 ead4357 / ec98214 / 3a3e99c；服务端仓 025cec8 / cda41b1 / 940f50e；除 3a3e99c 外均未 push）
  - [ ] 无破坏性变更（已有功能行为不变）—— 按评审结论：整体质量过硬、所报 4 条均为非阻断问题，但其中 3a3e99c（修 v0.10.3 回归）确实改了既有语义、超出「只允许包裹」字面约束（有回归测试兜底），故「已有功能行为不变」字面未完全满足；其余 3 条为缺口性而非破坏性——/v1/events 缺 ActiveUserGuard+限流、真实单价只落 gitignored .env、管理台前端无测试基建

---

## 💡 提示

- **代码优先**: 计划书基于 2026-10-22 的代码现状写的，但代码会继续演进。实施时以实际代码为准。
- **渐进式**: Phase 0 只是打地基，不要试图提前实现 A/B 阶段的功能。
- **沟通**: 遇到任何疑问立即报告，不要自己猜测需求。
- **质量**: 测试覆盖率和代码风格是硬性要求，不要为了赶进度降低质量。

祝顺利！有问题随时找我。
```

---

## 补充说明

这个 prompt 的设计思路：

1. **上下文充足**: 指向了完整计划书，不需要在 prompt 里重复所有细节
2. **任务明确**: Phase 0 的 4 个任务都有清晰的验收标准
3. **约束清晰**: 代码优先、测试覆盖率、不破坏现有功能
4. **引导自主**: 提供了代码地图和参考位置，鼓励 AI 先读代码再动手
5. **反馈机制**: 每个任务完成后汇报，Phase 0 完成后总汇报

你可以把这个 IMPLEMENTATION-HANDOFF.md 文件连同计划书一起交给执行 AI。
