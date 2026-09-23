# immersive-translator-server · 从 0 到 1 执行 Prompt

> 日期：2026-09-22 · 用途：交给另一个 AI 在新目录从零实现服务端
> 配套使用 [`server-architecture-plan-2026-09-22.md`](./server-architecture-plan-2026-09-22.md)（架构规格）

## 一、交接材料清单（先把这些带过去，再投 Prompt）

新项目目录建议 `D:\workspace\immersive-translator-server`，开工前放入：

| 材料 | 来源 | 放到新仓库的位置 |
|---|---|---|
| 本 Prompt | 本文件 | 直接粘贴给 AI（或存 `docs/kickoff-prompt.md`） |
| 架构规格（唯一事实来源） | `docs/server-architecture-plan-2026-09-22.md` | `docs/architecture.md` |
| 讯飞协议参考实现（TS，只读参考不编译） | `immersive-translator-windows/src/core/` 下的 `xfyunAuth.ts`、`xfyunTts.ts`、`xfyunAsr.ts`、`pronunciation.ts` | `docs/reference/` |
| 语音上游迁移路线（背景知识，可选） | `docs/voice-alternatives-research-2026-09-22.md` | `docs/reference/`（可选） |

## 二、使用方式（给用户自己的说明）

1. **推荐节奏**：让 AI 按里程碑顺序做（M0 → M1 → M2 → M3 → M4 → M5），每个里程碑结束它会停下来汇报验收——你核对后说「继续」再进下一个。想激进一点也可以让它连跑，但**每个里程碑的验收标准必须人工过一遍再合并**。
2. **跨会话续传**：Prompt 要求 AI 维护 `PROGRESS.md`。换会话/换 AI 时，重新投本 Prompt + 一句「先读 PROGRESS.md，从断点继续」即可。
3. **只有你能做的事**（AI 做不了，也不阻塞开发）：买域名、办 ICP 备案、服务器初始化（装 Docker）、注册 DeepSeek/讯飞账号拿真实 Key、开通 SMTP 邮件服务。开发期全部用 mock 和 `.env.example` 占位，上线前再填真值。
4. **边界**：这个 Prompt 只做服务端仓库。客户端改动（登录 UI、`official` Provider 预设、语音切网关）留在本仓库另开需求卡，别让服务端 AI 跨仓库动客户端代码。

## 三、执行 Prompt（以下整体复制给新 AI）

````markdown
你在 D:\workspace\immersive-translator-server 目录从零构建一个生产级后端服务 immersive-translator-server（私有仓库）。这是一个已立项、架构已拍板的项目，你的职责是**忠实实现**，不是重新设计。

【必读材料（动手前先完整读一遍）】
1. `docs/architecture.md` —— 架构规格，唯一事实来源。需求（§2）、模块划分（§3.2）、聚合层设计（§3.4）、子系统设计（§6）、数据模型（§7）、API（§8）、里程碑（§10）全部以此为准。文档中标注「已拍板」的决策不得更改。
2. `docs/reference/xfyun*.ts` —— 讯飞 TTS/ASR/ISE 的客户端参考实现（WebSocket + HMAC-SHA256 鉴权、帧协议、评分字段形状）。你实现讯飞适配器时以它们为协议参考，但注意：参考代码跑在浏览器/Node 客户端，你要重写为服务端适配器并对接 §3.4 的接口。

【技术栈（已定，不得更换）】
TypeScript(strict) + NestJS 10（Fastify adapter）+ Prisma + PostgreSQL 16 + Redis 7 + BullMQ + ws + undici + zod(+zod-to-openapi) + argon2 + jest 单测 + supertest e2e + pnpm + docker-compose + Caddy 2 + GitHub Actions。管理台 UI 用 React Admin 5（放 apps/admin，Vite 构建）。

【总工作原则（每一条都是硬约束）】
1. **里程碑制**：按 M0→M1→M2→M3→M4→M5 顺序做。完成当前里程碑的全部验收标准后【STOP】：输出改动文件清单、逐条验收结果（附证据：测试名/命令输出）、已知遗留问题，然后停下等人工确认，未经确认不得开始下一个里程碑。
2. **断点续传**：仓库根维护 `PROGRESS.md`（当前里程碑、已完成项、决策记录、TODO、已知问题）。每完成一个任务就更新它。
3. **配置优先，无密钥开发**：所有上游凭据、额度数值、路由表、SMTP 配置全部走环境变量（`.env.example` 完整列出并注释）或数据库；代码里绝不出现真实 Key。没有真实凭据时，用 mock 上游（见下）完成开发和测试。
4. **Mock-first 测试**：每个上游适配器都有对应的 mock 实现同接口（LLM mock 要能产出 SSE 流含 usage 尾包；语音 mock 要能跑 WSS 帧往返），e2e 一律打 mock。真实上游验证通过 env 开关（如 `E2E_LIVE=1` + 真 Key）才启用，默认关闭。
5. **测试红线**：核心逻辑（配额并发、刷新令牌轮换与复用检测、同步冲突、适配器协议转换）必须有测试；每个里程碑 CI 全绿（lint + test + build）才算完成。
6. **安全红线**：日志绝不记录用户翻译/语音正文（pino redaction）；上游 Key 用 AES-256-GCM 加密落库（主密钥来自 env）；管理员与用户账号体系、令牌完全隔离；.env 永不入库（.gitignore + .env.example）。
7. **与文档冲突时**：停下来说明差异和你的建议，等人工裁决，不要擅自改架构。
8. 注释密度与命名向 NestJS 社区惯例看齐；不为「顺手重构」扩大范围；不做架构文档「不做」清单里的事（§2.3）。

【部署与运维物（M0 建立，随里程碑完善）】
- `deploy/docker-compose.yml`（api + postgres + redis + caddy）、`deploy/Caddyfile`（自动 TLS；WSS upgrade 代理；/admin 静态托管）
- `.github/workflows/ci.yml`（PR/push：lint+test+build）与 `deploy.yml`（main：构建镜像 → SSH 到服务器 compose 部署 + prisma migrate deploy，服务器地址等全部用 GitHub Secrets）
- `docs/runbook.md`（首次部署、日常发布、回滚、备份恢复演练、上游故障处置）
- 备份：postgres 数据卷每日 pg_dump 脚本

【里程碑任务卡】

■ M0 基建（先做这个）
- pnpm workspace：apps/api（NestJS）+ apps/admin（React Admin 空壳）+ 根 tsconfig/eslint
- Prisma schema 按 architecture.md §7 全量建模（含 AdminUser/RedeemCode/AdminAuditLog）+ 首个 migration
- docker-compose 本地起全套；`GET /healthz`（含 DB/Redis 连通检查）
- pino 结构化日志 + redaction；统一错误过滤器（§8 的 {error:{code,message}} 形状）
- CI/CD workflow；README（定位：见 architecture.md §1 末段「服务端存在的根本理由」）；PROGRESS.md 初始化
- 验收：`pnpm install && pnpm test && pnpm build` 全绿；`docker compose up` 后 healthz 返回 200；CI 在 GitHub 上跑绿

■ M1 账号
- auth 模块：注册/登录/登出/改密/找回（SMTP 抽象 + console provider 占位，验证邮件先落日志）
- argon2id；Access JWT(~15min) + Refresh(~30d) 一次性轮换 + 复用检测吊销全族；设备列表/踢出
- accounts 模块：/v1/me、/v1/me/config（含网关地址与能力表骨架）
- 管理员引导：首个 AdminUser 用 env 引导创建；admin 登录（TOTP）+ 用户列表只读页（React Admin 最小可用）
- 验收：e2e 覆盖「注册→登录→刷新轮换→旧 refresh 复用触发全族吊销→设备踢出」；错误码符合 §8

■ M2 翻译网关
- §3.4 聚合层骨架：LlmAdapter 接口、适配器注册表、ProviderCredential 实例配置（Key 加密存储/权重/启停）
- DeepSeek 适配器（OpenAI 兼容透传 + SSE 流式 + 注入 stream_options.include_usage）+ MockLlmAdapter
- 管线：JWT Guard → 限流 Guard（Redis 令牌桶）→ 配额 Guard（预检预扣）→ 选路（含失败降级）→ undici 转发 → 流后计量（BullMQ 批量写 usage_events）→ 对账任务（hourly）
- /v1/quota；402 quota_exceeded 结构化错误 + x-quota-* 响应头
- 管理台：Provider 凭据 CRUD、路由表编辑、一键拨测（探测 + 一次真实小请求）、AdminAuditLog 记录全部变更
- 验收：mock 上游 e2e 全链路（SSE 流式→计量→配额扣减→超额 402）；并发扣减测试；E2E_LIVE=1 且提供真实 DeepSeek Key 时可用真请求冒烟

■ M3 语音网关
- ticket 鉴权（POST /v1/voice/ticket，60s 单次有效，Redis 防重放）
- §6.3 统一语音协议三类端点：WSS asr/stream、WSS tts/stream、REST ise + REST asr（整段）
- AsrAdapter/TtsAdapter/IseAdapter 接口 + 讯飞三件套适配器（协议见 docs/reference）+ 三件 mock
- WSS 中继：双向 pipe、25s 心跳、上游断开映射为可操作错误码（沿用客户端 1006→可操作提示的经验，错误码表写进 docs/api.md）
- 计量接入 usage_events（tts_chars/asr_seconds/ise_calls）
- 管理台：语音引擎配置（默认引擎/音色表/语种/ISE 开关）
- 验收：mock WSS 上游 e2e 三链路往返；心跳与异常断开有测试；E2E_LIVE=1 可选真讯飞冒烟

■ M4 同步
- sync 模块：pull(since 游标)/push(baseVersion+409)/tombstone(90 天物理清理)/单实体 512KB 限制/每用户容量配额/集合白名单
- DELETE /v1/me（打标 + 异步清数据，Apple 可删号合规）
- 管理台：用户同步占用查看
- 验收：并发 push 冲突测试（同实体双端）；容量超限 413；删号后数据异步清除有测试

■ M5 计费（兑换码）
- RedeemCode：批量生成（资源/额度/有效期/批次）、核销（幂等，一码一用）、过期
- 管理台：兑换码管理 + 运营看板（用量/上游成本/活跃用户/上游健康）
- 验收：并发核销幂等测试；看板数字与 usage_events 对账一致

【最终回报格式（每个里程碑 STOP 时）】
1. 改动/新增文件清单；2. 验收标准逐条通过情况（附证据）；3. PROGRESS.md 已更新；4. 已知问题与建议。

现在从 M0 开始。
````

## 四、可行性评估摘要

| 维度 | 判断 |
|---|---|
| 整体可行性 | **高**。架构文档已到「可直接编码」粒度（接口形状、表结构、API、验收标准齐全），AI 擅长的正是这类规格明确的工程活 |
| 主要风险 | ① 一次喂全量导致 AI 跳步/烂尾 → 用里程碑 STOP 机制约束；② WSS 中继与流式计量是最难点 → 已给协议参考代码 + mock-first；③ 跨会话丢上下文 → PROGRESS.md 断点续传 |
| AI 做不了的 | 域名/备案/服务器初始化/真实 Key/SMTP 开通/最终部署确认——均不阻塞开发（配置化 + mock） |
| 不该交给它的 | 客户端改动（留在本仓库）；架构变更裁决权（prompt 已要求遇冲突停下来问你） |
