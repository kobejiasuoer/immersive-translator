# P0 执行 Prompt · 验收 + 修复 + 发布 0.6.0

> **使用方法（这节不用投喂）**：整份投喂给有仓库读写权限的 AI（Codex / Claude Code / WorkBuddy 均可）。前置阅读：`docs/product-audit-report-2026-09-15.md`（体检报告，本 prompt 的所有问题编号 A1/B1/B2/§6 等均指向它）。整个 P0 预计 3–5 个工作日，一次投喂、一口气做完。其中「阶段 0」的硬件验收项和「阶段 2」的发布上传可能需要你本人配合（麦克风/扬声器/签名凭据），AI 会列清单交还。

---

## 使命

仓库里躺着一批**已实现、已过 vitest（379 passed）但从未提交、从未发布**的代码：R1（docx/pdf 导入）、R2（学词笔记）、R3（口语陪练）、R4（录音直译）、影子跟读评测、云 TTS。种子用户实测的是没有这些功能的 v0.5.2——她反馈的最大痛点（Word/PDF 导入）其实已经写完了。

你的任务：**把这笔欠账发出去**。顺序为：真机验收 + 提交代码 → 落地 6 项 P0 修复与埋点 → 构建、发布 0.6.0 → 产出种子用户复测清单。完成后，体检报告里「留存设计 2.0 分」的两大死因（首启无呈现、回访链无自启）和「零埋点盲飞」全部解除。

开工前先读：`docs/product-audit-report-2026-09-15.md` 全文、`docs/next-requirements-2026-09-15.md`（R1–R4 需求卡与验收标准）。若代码现状与报告描述有出入，**以代码为准**并记录差异。

## 阶段 0 · 提交与真机验收（1 天内）

1. `git status` 核对：当前工作区有 60+ 个未提交文件（`speak_store.rs`、`fileImport.ts`、`SpeakView.tsx`、`livecaption/`、`VocabNoteDialog.tsx` 等 untracked + 一批 modified）。
2. **分模块提交**，每个模块一个 commit，切出可回滚的里程碑（建议切法：① R1 导入（fileImport/ImportDialog/pdfjsLoader/readerTypes/schema 同步）② R2 学词笔记（noteBuilder/VocabNoteDialog/file_export.rs）③ R3 口语陪练（SpeakView/speakLogic/speak_store.rs/xfyunAsr/xfyunAuth/micRecorder）④ 影子跟读+发音评测（pronunciation/useShadowAssess/iseCredentials）⑤ 云 TTS（xfyunTts/speechEngine/usePlayback/XfyunVoiceSection）⑥ R4 录音直译（liveCaption/LiveCaptionApp）⑦ spike 脚本与文档（spike/、docs/、prototypes/）⑧ 其余杂项）。
3. **真机验收**：按 `docs/next-requirements-2026-09-15.md` 各需求卡验收标准，`pnpm tauri dev` 逐条走查。能自动验的自动验；**硬件链路（麦克风采集、扬声器播放、跟读打分）无法自动验的，列成「人工验收清单」交还用户**，不要跳过不报。
4. 验收中发现的缺陷：P0 级（挡流程）当场修复后再提交；P1/P2 记录到 `docs/p0-issues.md`，不顺手展开修。

## 阶段 1 · P0 修复与埋点（6 张需求卡，逐卡一个 commit）

### P0-A 首启引导窗（解决 A1/D2，体检报告 §1.3/§4.2）

**现状锚点**：`src-tauri/tauri.conf.json:14-127`（8 窗全 `visible:false`，首启零呈现）；`src/views/Settings.tsx:371-391`（三步 welcome 卡——全应用唯一新手引导，复用其逻辑与文案）；`src/core/library.ts`（内置文库「今日一篇」，作零门槛试读内容）；marker 文件先例 `app_data_dir/hotkey.txt`（`lib.rs:502-518`）。

**范围**：
1. 首次启动显示一次性轻量引导（独立小窗或 settings 窗首路由，二选一，自行按最合理默认决定并记录）：三张卡片——①热键表（划词 Ctrl+Shift+Q / 截图 Ctrl+Shift+E / 阅读室 Ctrl+Shift+R，附一句「在任意软件里选中文字试试」）②「配置翻译接口」按钮（深链 settings 配 Key 流程）③「用内置文章试试阅读室」按钮（直接开 library 今日一篇）。
2. 老用户判定：`secrets.json` 已存在 LLM Key 或 `reader_articles.json` 非空 → 视为老用户，升级后首启**不弹**。
3. 关闭时写 marker（`app_data_dir/onboarding-done.json`），之后不再弹。

**验收**：全新数据目录首启可见且三按钮可用；关闭后重启不弹；模拟老用户（预置 Key 文件）升级首启不弹；`pnpm test`/`pnpm build` 绿。
**不做**：多步向导、动效、视频教程。

### P0-B 托盘左键行为（解决 A1）

**现状锚点**：`src-tauri/src/lib.rs:1148-1177`（托盘 builder 链无 `on_tray_icon_event`，左键无任何响应）；托盘菜单定义 `lib.rs:1132-1146`。

**范围**：左键单击弹出托盘菜单（TrayIconEvent Click → show context menu）；若库版本不支持左键直接弹菜单，则左键打开阅读室窗口（自行决定并记录，验收标准不变：左键必有响应）。右键行为保持不变。

**验收**：左键单击必有可见响应；右键菜单不受影响；`cargo test` 绿。

### P0-C 开机自启开关（解决 A2）

**现状锚点**：全仓无 autostart（报告 A2 零命中证据）；设置窗口「关于」区 `Settings.tsx`（开关落位处）；Cargo.toml 加插件依赖。

**范围**：引入 `tauri-plugin-autostart`；设置「关于」区加「开机自启」开关，**默认关**；状态持久化（沿用现有 settings 持久化通道）；注意 Windows 下自启后应照常进托盘、不弹任何窗口。

**验收**：开启后注销重登/重启系统自启（自动化验不了就列入人工清单）；关闭后不残留注册表 Run 项；`cargo test`+`pnpm test` 绿。
**不做**：静默后台模式选项、延迟启动配置。

### P0-D 快速复习窗旧数据（解决 B1，体验 bug）

**现状锚点**：`src/quickreview/QuickReviewApp.tsx:68-96`（数据加载在空依赖 effect，只跑一次）；`:146-148,364-371`（Esc/✕ 是 hide 不是销毁）；`src-tauri/src/review_reminder.rs:220-224`（托盘重开走复用分支）。

**范围**：监听窗口 show 事件（或 Tauri 窗口焦点/可见性事件）时重拉 `readerGetVocab`；同时订阅 `reader:vocab-added` 与评分事件刷新（与 `ReaderApp.tsx:755-760` 同模式）。

**验收**：阅读室复习完 → 托盘重开迷你窗，列表与完成态为最新；既有单测不回归。

### P0-E TTS 静默失败提示（解决 B2）

**现状锚点**：三处静默失败——`src/reader/usePlayback.ts:100-103`（句子朗读失败仅 console）；`src/reader/speechEngine.ts:98-102`（云 TTS 凭据缺失静默回落）、`:109-113,126-133`（合成失败/播放被拒 fireEnded 静默推进）；UI 错误条样式参考 AssessStrip（`useShadowAssess` 相关样式位）。

**范围**：三处失败路径接 PlayBar 错误条/内嵌提示：「朗读失败」「云 TTS 凭据缺失 → 去设置」（带深链按钮）；区分 SAPI 与讯飞引擎给出对应文案；不中断播放流与页面交互。注意与昨天已修的 SpeakView 重听 gen 配对逻辑（`SpeakView.tsx` subscribeSpeakEnded）兼容，不得破坏。

**验收**：断网 + 删凭据两场景 UI 有可见提示且可停止/继续；正常播放无回归；vitest TTS 相关用例全绿。

### P0-F 本地埋点 + 使用统计（解决 D4「零埋点盲飞」）

**现状锚点**：**事件定义、属性、触发代码位置全部照体检报告 §6 的 15 事件表执行**（`docs/product-audit-report-2026-09-15.md` §6），不自行增删事件。存储与写入模式参照 `reader_store.rs:336-343` 的 tmp+rename 原子写；导出按钮参照 `file_export.rs`/`tauriBridge.ts:225-227` 的 save_text_file 链路。

**范围**：
1. Rust 新增 `metrics_log` command：append 写 `app_data_dir/metrics.jsonl`（每行一个 JSON 事件：ts/name/props）。
2. 前端 `src/lib/metrics.ts` 封装 `track(name, props)`，按报告 §6 表落 15 个事件的触发调用。
3. 设置页「使用统计」摘要：周有效学习会话数、周新增生词、复习完成率（计算口径照报告 §4.5/§5.3），加「导出」按钮。
4. **全部本地，零出网，不带任何用户内容**（事件值只有枚举与数字）。

**验收**：各触发点正常追加 metrics.jsonl；摘要三项计算正确（聚合逻辑配单测）；断网时埋点不影响任何功能。
**不做**：任何网络上报、趋势图、看板美化。

## 阶段 2 · 构建、发布与交还（半天）

1. 收尾门禁：`pnpm test`、`cargo test`、`pnpm build` 全绿。
2. 版本号升 **0.6.0**（package.json / Cargo.toml / tauri.conf.json 三处同步）。
3. `pnpm tauri build` 产 NSIS 安装包。
4. updater 镜像：若工作区可取到 tauri updater 签名私钥则生成 latest.json；**取不到就如实停下**，产出「手动生成 latest.json 的命令清单」交还用户，不要编造签名。
5. GitHub Release：若 `gh` 已认证则创建 **draft** release（不直接 publish，等用户过目）；未认证则给出完整上传步骤。
6. 产出 `docs/p0-selfcheck-2026-09-XX.md` 自检报告，必须包含：每张需求卡验收标准逐条通过情况（附证据/测试名）、已知遗留问题、人工验收清单（麦克风/扬声器/自启/托盘左键）、**给种子用户的复测清单（≤10 条，白话）**：docx/pdf 导入、口语陪练 5 轮对话、录音直译、快速复习、首启引导体验、朗读失败是否有提示等。

## 工作方式（硬约束）

1. **一口气做完**：不要中途停下等确认。悬而未决的分歧按最合理默认决定，并写入 `docs/p0-decisions.md`（每条：决定 + 理由 + 备选）。
2. 每完成阶段 0 与每张 P0 卡各一个 git commit，信息写清对应编号（如 `P0-D: fix quick-review stale data on re-show`）。
3. 不改 R1–R4 已实现的功能行为（验收发现缺陷除外）；不顺手重构无关代码。
4. 关键逻辑（聚合计算、marker 判定、重拉逻辑）配 vitest/cargo 单测。
5. **没做完、验不了、缺凭据的，如实写进自检报告**——宁可留白，不许编造通过。
6. 硬件与系统级验证（麦克风、扬声器、重启自启）无法自动验的，全部集中列「人工验收清单」，交还用户逐项勾选。
