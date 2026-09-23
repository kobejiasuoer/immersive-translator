# 录音直译 v2 实施方案：系统声音实时字幕 + 录音复盘

> 日期：2026-09-23 · 状态：v0.1 草案（待评审拍板）
> 输入：对现有「录音直译」（R4）的场景重定义讨论 —— 麦克风-only 设计导致视频/会议场景不可用（声音明明在电脑里，却要外放再收音）；新增「外国人会议/面试后复盘」需求（导入录音 → 双语转写 → 总结 → 按说话人评测）。
> 结论先行：**拆成两个特性共一条管线**——R5「录音复盘」先做（纯复用现有管线 + 一个新 API 模块，最快见效），R4v2「系统声音实时字幕」随后（需要一个 Rust 侧 loopback spike）；终态合体为「会议副驾」：会中双通道实时双语字幕、会后一键复盘报告。

---

## 0. 结论速览

| 决策点 | 推荐 | 备选 | 一句话理由 |
|---|---|---|---|
| 特性拆分 | R5 录音复盘（导入文件→复盘报告）+ R4v2 系统声音字幕，共享「转写→翻译→报告」管线 | 一个大特性 | R5 不碰 Rust 音频采集，能最快交付完整闭环；R4v2 依赖 loopback spike |
| 实施顺序 | **R5 → R4v2 → 合体** | R4v2 先行 | R5 全部是既有模式的复用；R4v2 的 wasapi 采集有外部风险，先 spike 再排期 |
| 长音频转写 | 讯飞「语音转写」API（说话人分离 + 时间戳），**客户端放 Rust 侧**（reqwest） | TS fetch | HTTPS 接口在 WebView 里有 CORS 墙；`translate_stream`/`probe_https` 已验证 Rust HTTP 路子。鉴权/字段/计费两代协议并存，**M0 spike 定型** |
| 音频格式策略 | **原始文件直接上传**（转写 API 常规接受 wav/mp3/aac/m4a 等，M0 实测确认），不满足时再用 symphonia（纯 Rust 解码）转 wav | ffmpeg sidecar | app 至今零二进制依赖，ffmpeg 会给安装包加几十 MB；symphonia 零体积兜底 |
| 复盘翻译 | 按「说话人轮次（turn）」分批翻译，不走逐句 | 逐句（现状 live-caption 模式） | 一小时会议几百句，逐句 = 几百次 LLM 调用；turn 分批可降一个数量级 |
| 报告生成 | 复用 `translate_stream`，LLM **直出 markdown**（流式渲染进报告视图） | 结构化 JSON 再渲染 | 省一层解析与容错；markdown 本来就是导出格式 |
| 存储 | 新增 `replay_store.rs`，JSON 文件 + `schemaVersion`（沿用 speak/history 模式），音频原件拷入 `app_data_dir/replay/` | sqlite | 与全部现有 store 一致；先不进 contracts（Windows 内部格式，Mac 对齐时再契约化） |
| 系统声音采集 | Rust `wasapi` crate 环回采集（整个混音输出），事件推 PCM 到前端复用 `LiveSegmenter` | 按进程环回（Win10 2004+） | 全局混音是 OBS「桌面声音」同款方案，覆盖一切应用；按进程留作增强 |
| 窗口策略 | R5 新窗口 `meeting-replay`；R4v2 先在现有 `live-caption` 窗口加「声音来源」选择器，独立悬浮细条留到合体阶段 | 一步做悬浮细条 | live-caption 窗口本就 always-on-top；细条窗口涉及点击穿透/排版，非 MVP 必须 |

里程碑：**M0 spike（并行三项，含决策门）→ M1 录音复盘 MVP → M1.5 报告与评测 → M2 系统声音字幕 → M3 会议副驾合体**。详见 §5。

---

## 1. 背景：问题不是场景选错，是输入源做死了

现有「录音直译」（R4，`live-caption` 窗口）链路：

```
getUserMedia(麦克风) → AudioContext(16k) → LiveSegmenter(VAD 分句)
  → transcribeSpeech(讯飞流式听写 iat) → translate_stream(句级 LLM 翻译) → 双语滚动
```

三个宣传场景里有两个天然不成立：

- **看无字幕视频**：声音在电脑里播放，用麦克风收音意味着「外放 + 收噪」，用户吐槽「要准备两台电脑」是准确吐槽。正解是 WASAPI loopback 直接抓系统混音输出。
- **远程会议**：对方的声音走系统输出，同样不经过麦克风。同上。
- **线下面授/访谈**：麦克风模式唯一成立的场景，但手机 App 做得更好，不是差异化。

重新定义后的产品逻辑：

> **「电脑里任何声音」的实时双语字幕（R4v2）+「任何一段录音」的会后复盘产物（R5）**，合体成「英语不好的职场人的会议副驾」：会中帮你听懂（双通道双语字幕，麦克风=我、系统声音=对方，天然分说话人），会后帮你复盘（转写、翻译、总结、我的英语逐段点评）。

与品牌的呼应：网页双语是「沉浸式翻译」的看家本领，声音场景是同一能力在另一媒体上的延伸；竞品缺口明确——Win11 实时字幕不翻译、Edge 翻译字幕只管浏览器内、讯飞听见按分钟收费、Language Reactor/Trancy 只在浏览器里且不做复盘。

## 2. 需求（FR）

**R5 录音复盘（新窗口 `meeting-replay`）**

- FR5.1 导入音频/视频文件（拖拽或选择；手机录音 m4a、Zoom 本地录像 mp4/m4a、wav/mp3 等常见格式），原件拷贝到应用数据目录，过程可取消。
- FR5.2 调讯飞「语音转写」：说话人分离 + 句级时间戳；上传/转写进度可见；失败给出可操作提示（凭据/额度/格式）。
- FR5.3 转写稿视图：按说话人着色分轮次展示，双语对照；用户可指定「哪个说话人是我」、可重命名/合并说话人；点句跳转播放（`<audio>` 播放原件，高亮当前句）。
- FR5.4 一键报告（模式：会议 / 面试 / 自由对话）：
  - 内容侧：要点、达成的决定、待办清单；
  - 我的英语侧（以「我」的发言为输入）：语法与用词问题、更地道的表达建议、口头禅统计、（面试模式）对方问题清单 + 我逐题回答点评与建议答法。
- FR5.5 报告与转写稿可导出 markdown（复用 `save_text_file`）；会话持久化、可删除（连带音频文件）。

**R4v2 系统声音实时字幕（改造 `live-caption` 窗口）**

- FR4.1 声音来源选择器：麦克风 / 系统声音 / 麦克风+系统声音（双通道）。
- FR4.2 系统声音走 Rust 环回采集，事件推 PCM，复用现有 `LiveSegmenter` → iat → 翻译链路，零前端管线改动。
- FR4.3 默认输出设备切换时给出提示并可一键重启采集（MVP）；自动跟随留作增强。
- FR4.4 双通道模式：两路各自分句识别，按来源标记「我 / 对方」，交错显示；停止后可将整场存为复盘会话，直接进 R5 报告流程（M3）。

**横切**

- FRX.1 设置 → 语音：新增「语音转写」服务状态灯 + 一键测试（沿用现有 probe 模式，具体探测端点 M0 定）；凭据沿用「主凭据 + 按服务覆盖」模型，新增 `xfyun_lfasr_*` 槽位，缺省回落主凭据。
- FRX.2 隐私提示：导入/实时模式均上传云端（讯飞转写/听写），UI 明示。
- FRX.3 为未来服务端语音网关预留迁移位：lfasr 模块接口按「可换传输层」设计（见 §4.6）。

## 3. 总体架构与复用盘点

```
                    ┌─ R5 导入文件 ──→ [Rust] lfasr.rs 上传/轮询 ─→ 讯飞语音转写(说话人+时间戳)
                    │                        │ 事件: lfasr:progress
音频输入 ───────────┤                        ▼
                    │                 转写稿(turn 分组, 说话人标注)
                    │                        │ translate_stream(按 turn 批量, tag=mr*)
                    │                        ▼
                    │                 双语转写稿 ──→ 报告(translate_stream, markdown 直出)
                    │                        │
                    │                        ▼
                    │                 [Rust] replay_store.rs (replay_sessions.json + replay/*.m4a)
                    │
                    └─ R4v2 loopback ─→ [Rust] loopback.rs 环回采集 ─→ 事件推 16k PCM
                                            │
                                            ▼ (与麦克风同构)
                                      LiveSegmenter → iat → translate_stream → 双语字幕
                                            │ (M3: 双通道会话)
                                            ▼
                                      replay_store → 同一套报告流程
```

复用资产（已核实）：

| 资产 | 位置 | 复用方式 |
|---|---|---|
| VAD 分句 | `src/core/liveCaption.ts` `LiveSegmenter` | loopback 通道直接喂，零改动 |
| 流式听写 | `src/core/xfyunAsr.ts` | 不动；R5 用的是另一个长音频 API |
| 翻译管线 | `src/lib/translateClient.ts` + Rust `translation.rs` | 新 tag 前缀 `mr`（复盘）、`lcs`（系统字幕），prompt 换新 |
| 凭据模型 | `src/lib/iseCredentials.ts`（主凭据+按服务覆盖+回落） | 加一个 lfasr 槽位 |
| 服务状态灯/一键测试 | `src/views/XfyunVoiceSection.tsx` + Rust `probe_https` | 同模式加一行 |
| 报告 UI 风格 | `src/reader/ShadowReport.tsx`（卡片/维度条/诊断句） | 视觉语言沿用，数据源换 LLM markdown |
| JSON store 模式 | `speak_store.rs`（schemaVersion/锁/原子写/上限） | 照抄结构写 `replay_store.rs` |
| 窗口创建 | `lib.rs` spec 表 + tray 菜单 | 新增 `meeting-replay` 条目 |
| spike 方法论 | `spike/*_spike.mjs`（零依赖 Node 实测协议） | M0 三项 spike |

## 4. 技术设计

### 4.1 R5 录音复盘

**4.1.1 窗口与路由**

`tauri.conf.json` `app.windows[]` 增加隐藏窗口 `meeting-replay`（约 920x640，`always_on_top` 关）；`App.tsx` dispatch 增加分支；`lib.rs` 窗口 spec 表 + tray 菜单（「录音复盘」）+ 可选全局快捷键（沿用 `*_hotkey.txt` 持久化模式）。注意带上 `REBUILD_BROWSER_ARGS`（虽然该窗口不用麦克风，保持一致）。

**4.1.2 导入与格式策略**

- 选择/拖拽文件 → Rust 命令 `replay_import_audio(path)`：拷贝到 `app_data_dir/replay/<uuid>.<ext>`，返回会话 id 与元信息（大小、时长估算可不做，播放器自己知道）。
- **不做本地解码（默认路径）**：讯飞转写常规接受 wav/pcm/mp3/aac/m4a/opus 等，M0 spike 实测格式矩阵；命中即原始文件直接上传。
- **兜底路径**：不接受的格式（或声道/采样率问题）→ Rust 侧 `symphonia`（isomp4 + aac + mp3 + wav feature）解码重封装为 16k 单声道 wav 再上传。纯 Rust、零安装包增量。ffmpeg sidecar 仅在 symphonia 覆盖不住真实用户格式时再立项（决策门见 §5 M0）。
- 上限校验：文件大小（转写 API 常见上限 500MB）与时长（常见 5h），超限给明确报错。具体数值以 spike 实测为准。

**4.1.3 lfasr 客户端（Rust 模块 `src-tauri/src/lfasr.rs`）**

- **为什么在 Rust**：转写是 HTTPS REST（上传分片/建任务/轮询/取结果），WebView fetch 会被 CORS 拦（现有全部讯飞调用走 WebSocket 才幸免；`probe_https` 注释同样结论）。Rust reqwest 无此限制，且大文件分片上传、长轮询本来就该在原生侧。
- 命令：`lfasr_start(sessionId)`（读音频文件 → 分片上传 → 建任务 → 后台轮询）、`lfasr_cancel(sessionId)`。
- 事件：`lfasr:progress { sessionId, phase: "uploading"|"queued"|"transcribing"|"done"|"failed", percent?, message? }`；完成事件携带结构化结果。
- 结果模型（落库格式，camelCase serde，TS 侧 `src/core/replayTypes.ts` 镜像）：

```ts
interface ReplayTranscript {
  segments: { speaker: number; startMs: number; endMs: number; text: string }[];
}
```

- 说话人分离开关默认开；说话人数不指定（引擎自动）。具体鉴权方案（讯飞转写存在新旧两代协议：旧 `raasr` 分片上传系与新版 `api.xf-yun.com` 签名系）、说话人参数名、结果字段名，**一律以 M0 spike 实测为准**，spike 结论回写本节（沿用 `iat_spike.mjs` 把 `business.sub` 教训写进注释的做法）。
- 凭据：`iseCredentials.ts` 新增 `loadLfasrCredentials()`（`xfyun_lfasr_*` 覆盖 → 主凭据回落）。注意转写与听写是**独立计费产品**，主凭据回落可能报「服务未开通」，错误映射要提示用户去控制台开通（错误码表学 `IAT_CODE_MESSAGES`）。

**4.1.4 转写稿与翻译批处理**

- 展示模型：`segments` 按「说话人变化」聚合成 turn（同一人连续句合并，单 turn 文本上限约 800 字符，超出截断开新 turn——控制单次翻译长度）。
- 翻译：每 turn 一次 `translate_stream`，tag `mr{turnId}`，并发 2（`translateClient` 天然支持多 tag 并发，参照 ReaderApp 多前缀用法）。系统 prompt 复用「同传口吻、容忍 ASR 误识」要点，追加「输入为会议转写，按 turn 翻译，不添加原文没有的内容」。
- 语言方向：自动（转写结果自带语种，prompt 让 LLM 译成目标语言即可），不需要 R4 那种手动 zh2en/en2zh 切换；设置里给默认目标语言（沿用现有翻译目标语言设置）。
- 失败隔离：单 turn 翻译失败标 `failed` 可单独重试，不阻塞整体。

**4.1.5 说话人标注 UX**

转写完成先进入「谁是我」步骤：按说话人分组试听（各取前两句，`<audio>` seek 到对应时间）→ 点选「我」→ 可重命名（我/对方/Interviewer…）→ 可合并误分裂的说话人（diarization 偶尔把同一人拆成两个编号）。标完才允许生成「我的英语」类报告（内容侧报告不依赖标注）。

**4.1.6 报告生成**

- 新模块 `src/core/replayReport.ts`：`buildReplayPrompt(mode, turns, me?)` → system prompt + user payload（只喂必要内容：内容侧喂全量 turn 文本；英语侧只喂「我」的 turn，附口头禅候选词频统计让 LLM 核实）。
- 输出：**markdown 直出**，`translate_stream` 流式回填报告视图（渲染复用阅读室的 markdown 能力；无则最小 markdown 渲染）。模式差异：面试模式额外要求「问题清单 + 逐题回答点评 + 建议答法」小节。
- 报告存进会话（字符串字段），可重新生成（换模式）；连同转写稿导出 `.md`（`buildReplayMarkdown`，参照 `buildCaptionMarkdown` 风格）。
- 长会议 token 控制：全量 turn 超上下文时按时间中点分两段各生成再让 LLM 合并；MVP 先限制「单次报告输入 ≤ 约 1.5h 会议」，超限提示分段。

**4.1.7 存储 `replay_store.rs`**

```rust
struct ReplaySessionsFile { schema_version: u32, sessions: Vec<ReplaySession> }  // schemaVersion = 1
struct ReplaySession {
  id: String, created_at: i64, title: String, audio_ext: String, audio_bytes: u64,
  duration_ms: u64,                        // 首次播放后回填
  transcript: Option<ReplayTranscript>,    // lfasr 结果（含说话人原始编号）
  turns: Vec<ReplayTurn>,                  // 聚合+标注后的展示模型（含翻译与 speaker_label）
  report: Option<ReplayReport>,            // { mode, markdown, generated_at }
}
```

- 文件 `replay_sessions.json`，`STORE_LOCK` + `.json.tmp` 原子写，上限 30 条（超限提示删除，音频占盘大）；删除会话连带删 `replay/<id>.*` 音频。命令：`replay_list / replay_get / replay_save / replay_delete`。
- 暂不进 `contracts/`：单端内部格式，但严格带 `schemaVersion`（对齐 README 约定），Mac 端要支持时再契约化。

### 4.2 R4v2 系统声音实时字幕

**4.2.1 Rust 环回采集 `src-tauri/src/loopback.rs`**

- crate：`wasapi`（纯 COM 封装，支持 `Direction::Render` 环回）。流程：取默认渲染端点 → `IAudioClient.Initialize(AUDCLNT_STREAMFLAGS_LOOPBACK)` → 混合格式（通常 44.1/48k float 交错，声道 2）→ 转 16k 单声道（Rust 侧线性重采样 + 声道合并，对齐 `resamplePcmTo16k` 语义）→ 每 ~100ms 一帧事件 `loopback:chunk { f32: Float32Array, level }`。
- 命令：`loopback_start()` / `loopback_stop()`；采集线程独立 `std::thread`（对齐现有窗口重建的线程习惯），stop 走标志位 + 事件 join。
- 设备切换：注册 `IMMNotificationClient` 或（MVP）捕获 `DEVICE_STATE` 变化的简化方案——默认设备变了就发 `loopback:error`，UI 提示「输出设备已切换，点击重启采集」。自动跟随为增强项。
- 按进程环回（`AUDIOCLIENT_PROCESS_LOOPBACK`，Win10 2004+，「只抓 Zoom 的声音」）：接口上预留 `loopback_start(process_id: Option<u32>)`，MVP 不做 UI。

**4.2.2 前端接线（`LiveCaptionApp.tsx` 改造）**

- 来源选择器：`mic | system | mic+system`（mic+system 仅在 M3 前作为「双份字幕」可用，M3 才赋说话人语义）。
- system 通道：监听 `loopback:chunk` → 与 `onChunk` 完全同构地喂一个新的 `LiveSegmenter` → `handleUtterance`（复用）。系统声音没有 VAD 门槛问题吗？有——音乐/静音段由 VAD 挡（现有阈值自适应噪声底）。方向：系统声音默认按「自动语种」或沿用现有方向开关。
- 双通道同时开时 iat 并发连接 ×2，注意凭据 QPS（讯飞听写并发连接数限制，spike 顺带确认；不足则两通道排队错峰）。

**4.2.3 悬浮细条（M3 再做）**

`caption-bar` 窗口：窄长置顶条，只显示最近 1–2 句，可选点击穿透。非 MVP；现有 520x680 的 `live-caption` 窗口本就 always-on_top，足以验证场景。

### 4.3 合体：会议副驾（M3）

- 双通道模式下每句打 `channel: "mic"|"system"` → 停止时拼成 `ReplaySession`（speaker 直接由 channel 映射，无需 diarization、无需「谁是我」步骤）→ 走 §4.1.6 报告流程。
- 音频留存：mic 通道 PCM 本地就有；system 通道由 Rust 侧同步落一份 16k wav（可选开关，注意磁盘占用）。
- 这一步交付的完整故事：「开会时开着它（实时双语字幕帮你听懂），开完一键复盘（报告告诉你今天哪些表达可以更好）。」

### 4.4 服务端迁移预留

`docs/server-architecture-plan-2026-09-22.md` N3 已规划语音网关（服务端适配多家上游、客户端零发版换上游）。本方案两个原则对齐它：

- lfasr Rust 模块的对外接口定义为「`transcribe(session) → events`」，未来把 reqwest+讯飞实现整体替换为网关调用，前端与 store 不动；
- 凭据读取继续走 `iseCredentials` 单点，网关收口后只改这一层。

## 5. 里程碑与发布映射

| 阶段 | 内容 | 出口标准（可演示） | 预估 |
|---|---|---|---|
| **M0 spike（并行）** | ① `spike/lfasr_spike.mjs`：实测鉴权/上传/轮询/说话人字段/格式矩阵/额度与计费口径，结论回写 §4.1.3；② `spike/loopback`（Rust 小 demo 或 mjs 调 wasapi? 否——Rust bin）：抓默认设备混音 dump 成 wav + 记录采样率/缓冲事实；③ 确认 iat 双连接并发是否受限 | 三份 spike 记录进 `spike/README.md`；**决策门**：转写 API 格式矩阵是否免除 symphonia；loopback 延迟与稳定性是否达标（丢帧率、CPU） | 2–4 人日 |
| **M1 复盘 MVP** | 窗口/导入/格式校验、`lfasr.rs` + 进度 UI、turn 聚合 + 批量翻译、双语转写稿 + 说话人标注 + 点句播放、`replay_store`、导出 md | 导入一段真实 30min 双人英文录音 → 5 分钟内得到带说话人的双语转写稿并可播放联动 | 4–6 人日 |
| **M1.5 报告** | `replayReport.ts` 三模式 prompt + 流式 markdown 报告视图 + 会话内持久化/重生成 | 面试录音一键出「问题清单 + 我的逐题点评 + 表达建议」报告 | 2–3 人日 |
| **M2 系统声音字幕** | `loopback.rs` + 来源选择器 + system 通道接线 + 设备切换提示；设置页 lfasr/loopback 状态项 | 播放 YouTube 无字幕视频，live-caption 窗口实时出双语字幕 | 3–5 人日 |
| **M3 会议副驾** | 双通道 + channel→speaker 映射 + 会话落库 + 一键报告；（增强：悬浮细条、按进程环回、自动跟随设备） | 真实远程会议全程开着，会后直接出复盘报告 | 3–5 人日 |

发布映射（建议）：M1+M1.5 → `v0.7.0`（复盘是完整可卖点）；M2 → `v0.7.x`；M3 → `v0.8.0`。每阶段遵守现有更新器流程（`RELEASE-CHECKLIST.md`）。

## 6. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 讯飞转写与听写独立计费，主凭据回落报「未开通」 | 高 | 错误映射明确指引控制台开通；设置页状态灯提前暴露；spike 实测免费额度口径 |
| 转写 API 新旧协议/字段与预期不符 | 中 | M0 spike 先行，协议细节全部实测回写（本仓既有文化，`business.sub` 教训） |
| 真实格式超出 API 接受范围（如某些 webm/ogg） | 中 | symphonia 兜底转 wav；再不行才评估 ffmpeg sidecar（决策门在 M0） |
| diarization 把同一人拆成多说话人 / 两人混叠 | 中 | 「谁是我」步骤支持合并与重命名；报告只依赖「我」标注正确 |
| CORS/WebView 限制导致 HTTPS 方案返工 | 低 | 已定 Rust 侧 reqwest，与 `translate_stream` 同路径，无浏览器参与 |
| wasapi 环回在独占模式/特殊声卡驱动下取不到流 | 中 | spike 用真实机器覆盖；错误路径 UI 化（提示切共享模式）；备选按进程环回 |
| 系统声音含音乐/噪音导致识别垃圾句 | 低 | VAD 自适应噪声底已挡大部分；后续可加「静音期丢弃」阈值 |
| 长会议报告超 LLM 上下文 | 中 | turn 压缩 + 分段生成合并；MVP 明示单次上限 |
| 音频文件占盘（30 会话 × 上百 MB） | 低 | 会话上限 + 删除连带清理 + 设置页显示占用 |
| 一小时会议翻译 LLM 调用量大（BYOK 费用） | 中 | turn 批量已降一个数量级；提供「只翻我不翻对方/只生成报告不翻译」开关 |

## 7. 测试策略（沿用现有约定）

- 纯函数单测（vitest，`src/core/*.test.ts`）：lfasr 响应解析 → segments（含说话人/时间戳容错）、turn 聚合与截断、`buildReplayPrompt`、`buildReplayMarkdown`、channel→speaker 映射、说话人合并/重命名逻辑。
- Rust 单测（`#[cfg(test)]` 模块内）：`replay_store` 读写/版本/上限/删除连带的音频清理；`lfasr` 的鉴权串构造与响应解析纯函数部分。
- 渲染冒烟：`ReplayApp.render.test.tsx` / 报告视图 `renderToString` 冒烟（对齐 ShadowReport 模式）。
- 实网测试（env 门控自跳过）：`xfyunLfasr.live.test.ts`（`XFYUN_LFASR_*` 环境变量，喂一段合成音频断言说话人字段）；loopback 用 M0 的 demo 工具人工验证。
- 验收脚本化：`spike/lfasr_spike.mjs` 长期保留为协议回归工具。

## 8. 待拍板问题

1. **M0 后定**：symphonia 兜底是否启动（取决于格式矩阵实测）。
2. **产品命名**：「录音复盘」窗口对用户的叫法（候选：录音复盘 / 会议复盘 / 会后复盘），以及是否与「录音直译」在 tray 里合并为一个「语音」组。
3. **报告模式**：MVP 三模式（会议/面试/自由对话）是否裁剪为「会议 + 面试」两种。
4. 是否在 M2 之前先发 M1（v0.7.0 提前拿用户反馈）——推荐是。
