# 语音设置两套入口合并：语音同源中枢（voiceSource Hub）设计与落地说明

- 日期：2026-11-11
- 配套交互原型：`docs/voice-settings-merge-prototype-2026-11-11.html`（单文件，双击浏览器打开即可）
- 性质：设计说明 + 落地建议。本文所引代码行号均在 2026-11-11 对 `immersive-translator-windows/` 工作区静态核对过；**本次未运行应用本体、未跑 vitest / tsc / cargo**（原型本身的 JS 语法检查与浏览器交互冒烟测试除外，见 §6.4）。

---

## 1. 背景与问题（两套设置现状）

同一个 Tauri 桌面应用（沉浸口语）里，语音设置有两个入口：

- **入口A＝「沉浸阅读室」主窗口右侧的「阅读设置」抽屉**（`src/reader/SettingsDrawer.tsx`，reader 窗）：提醒/免打扰/每日目标之外，有一组语音设置——朗读引擎（分段：Edge 在线 / 云音色 / 系统语音）、音色来源、本地音色下拉、语速、每句停顿、跟读模式开关、跟读评测开关、过关阈值、读完自动开麦开关、静音断句、麦克风下拉。
- **入口B＝右击托盘图标打开的「沉浸口语设置」窗口 →「语音」页**（`src/views/Settings.tsx` + `src/views/VoiceSettingsTab.tsx` 等，settings 窗）：朗读（音色下拉如 xiaoyan·小燕＋试听）、语音转文字（状态＋支持语言＋测试识别）、跟读评分（评分开关＋测试评分）——语音页唯一的本地开关是跟读评分（`GatewayVoiceSection.tsx:277`，VoiceSettingsTab 仅 `onToggleIse` 一条接线 :1134）——下方还有连接测试、验证当前配置与本月剩余额度。

两个窗口是两个 Tauri WebView（`tauri.conf.json` 中 `settings` / `reader` 两个窗口配置，同一 index.html bundle、无 per-window url，`App.tsx` 按 `getCurrentWindow().label` 路由），因此同 origin 共享 localStorage，但**没有任何针对语音设置的跨窗口通知机制**。由此产生四个已被逐一核实的真实问题：

| # | 问题 | 证据（2026-11-11 核对） |
|---|---|---|
| ① | 抽屉「音色来源」等状态是**挂载一次性快照**，B 改动后 A 界面不感知，重挂载才刷新 | `SettingsDrawer.tsx:131` 挂载时 `resolveInitialVoiceProvider(loadSettings().voiceProvider)`；:99-155 的 effect 只挂了登录态监听（:145），不监听任何语音变更事件 |
| ② | 跟读评测是 **AND 链、开关散在两处**：A 侧 `shadowingMode && shadowingAssess` × B 侧 `voiceGatewayIseEnabled`（仅在沉浸云链路被消费：`voiceRoute.ts:206-213` 非 gateway 提前返回讯飞引擎，:227/:128 的 `iseLocalOff` 只在 gateway 分支生效）× 服务端能力，任一关掉都不打分，两处 UI 无互相提示 | `ReaderApp.tsx:602`（assessEnabled）× `voiceRoute.ts:227`（`iseLocalOff` 现读）× `voiceRoute.ts:92-150`（服务端归约）；现有提示只有 `voiceRoute.ts:132`「跟读打分已在设置里关闭…」一句 |
| ③ | 抽屉两处凭据徽标（合成/评测）**不监听 `xfyun:creds-updated`**，B 存完凭据要等抽屉重挂载才刷新徽标 | 徽标查询在 `SettingsDrawer.tsx:593-607` / :762-778，挂载查一次；`xfyun:creds-updated` 的既有消费点为 `ReaderApp.tsx:1456-1463`（引擎凭据缓存）、`VoiceSettingsTab.tsx:104`（设置页徽标）、`XfyunVoiceSection.tsx:213`（自身徽标/回显/探测灯重置）三处，抽屉（SettingsDrawer）没有订阅 |
| ④ | **Rust 数据丢失隐患（界面上看不见）**：`ReaderSettingsOverride` 缺 3 个字段，文章级 Edge 音色/随读抽查覆盖被 serde 往返静默剥离 | `src-tauri/src/reader_store.rs:105-161` 恰 25 字段，无 `edge_voice_zh/edge_voice_en/spot_quiz_mode`；本次运行 `grep -rn "deny_unknown_fields" src-tauri/src` 零命中、`grep -n "edge_voice\|edgeVoice\|spot_quiz" reader_store.rs` 零命中；TS 侧合并逻辑在消费这三项（`readerTypes.ts:401-402`），:431-433 注释自证「字段名不一致会被 serde 静默剥离，文章保存即丢设置」 |

播放路由本身不受①影响——阅读室每次 speak/评测**现读** localStorage（`voiceRoute.ts:206`），所以「播放跟不跟服务商」是即时的；陈旧的是**界面**。这正是问题难察觉的原因：功能看起来正常，只是设置页显示骗人。

---

## 2. 两套语音设置逐项对照表

> 「生效时机」「合并处理」两列为本次结论；行号引用同上节核对口径。

| 设置项 | 入口A（阅读室抽屉） | 入口B（设置中心·语音页） | 数据同源关系 | 合并处理 |
|---|---|---|---|---|
| 语音服务商（用谁家的语音：沉浸云/讯飞） | 无写控件；只读状态展示「音色来源」（gateway=登录态+去语音页按钮 `SettingsDrawer.tsx:509-551`；xfyun=凭据状态+设置按钮 :552-609）。值来自挂载快照（:131） | radio 卡二选一（`VoiceSettingsTab.tsx:199-239`）→ `Settings.tsx:1132` `applyVoicePrefs`（:256-264）→ `saveVoicePrefs`（`settingsStore.ts:341-347`）写 `immersive-translator-settings` 的 `voiceProvider`（:52） | **同一份数据，单写多读**：唯一写点在设置中心；阅读室播放现读所以路由即时跟随，但抽屉 UI 是挂载快照 | 维持单源；阅读室侧照旧只留展示+跳转，**不给 `voiceProvider` 开第二个写点** |
| 朗读引擎档位（Edge 在线/云音色/系统语音） | 分段控件写 `ttsProvider="edge"\|"cloud"\|"local"`（`SettingsDrawer.tsx:435-459`；旧值 xfyun 显示为云音色选中 :446），存 reader-settings 全局+文章覆盖双写（`ReaderApp.tsx:852-864`） | 无 | **不同份**：`reader-settings` 的 `ttsProvider`（四值，`readerTypes.ts:263`）与 `AppSettings.voiceProvider`（二值，`settingsStore.ts:16`）独立存储，仅语义耦合——`ttsProvider==="cloud"` 时才经 `resolveVoiceRoute` 读 `voiceProvider` 定 gateway/xfyun（`readerSpeechRoute.ts:30-48`） | 两字段语义强耦合，归约必须单点存在（`resolveVoiceRoute`），UI 只显示归约结果 |
| 朗读音色·沉浸云（voiceGatewayVoice） | 无（gateway 分支明写「音色在语音页选择，此处不重复配置」`SettingsDrawer.tsx:532-550`）；但播放时直读：`ReaderApp.tsx:501` `gatewayCfgRef.current={ voice: loadSettings().voiceGatewayVoice }` | 沉浸云段「朗读」行 select（选项来自服务端 caps.ttsVoices，`GatewayVoiceSection.tsx:270-273`）→ `Settings.tsx:1133` → `saveVoicePrefs` | **同一份数据**：单份存储、B 唯一写点、A 只读消费；生效依赖 ReaderApp 渲染时重读 ref，无专用广播 | 已是理想形态（单写多读）；本次把「渲染时机重读」升级为订阅 |
| 朗读音色·讯飞中文发音人（cloudVoice，xiaoyan 系） | 文本输入+datalist（建议列表含「xiaoyan · 小燕」`xfyunTts.ts:56-64`；渲染 `SettingsDrawer.tsx:584-590`；输入本体 :554-569），存 reader-settings 全局+文章覆盖 | 无（`XfyunVoiceSection.tsx:284-388` 只有凭据三件套+连接检查；「xiaoyan·小燕」文案在入口B唯一出现处是服务端 caps 下发的沉浸云音色下拉选项 label） | **不同份**：cloudVoice（讯飞 vcn，reader-settings）与 voiceGatewayVoice（沉浸云，immersive-translator-settings）两个字段、两个键，互不同步，切换服务商音色不迁移 | 「音色各存一份」的唯一实质重叠；维持 A 独管 + 语义桥归约 |
| 朗读音色·讯飞英文发音人（cloudVoiceEn，默认 catherine） | 文本输入+datalist（`SettingsDrawer.tsx:570-592`；默认 `readerTypes.ts:312`） | 无 | 仅 A 有 | 与 cloudVoice 同命运 |
| 朗读音色·Edge（edgeVoiceZh/edgeVoiceEn，默认 zh-CN-XiaoxiaoNeural / en-US-AvaNeural） | 两个文本输入+datalist（`SettingsDrawer.tsx:462-500`），存 reader-settings 全局+文章覆盖 | 无 | 仅 A 有 | ⚠ Rust `ReaderSettingsOverride`（`reader_store.rs:105-160`）没有这两个字段，文章级覆盖被 `reader_save_article` 的 serde 往返静默剥离 → 配套修复 |
| 本地系统音色（voice，SAPI） | 下拉（`ttsVoices()` 命令枚举，`SettingsDrawer.tsx:612-630`，仅 ttsProvider=local 可用） | 无 | 仅 A 有 | 引擎本地细节，维持 A 独管 |
| 语速（rate，0.5–2.0× 步进 0.05） | range（`SettingsDrawer.tsx:631-646`；范围常量 `readerTypes.ts:355-356`） | 无 | 仅 A 有 | 无重叠 |
| 每句停顿（sentencePauseMs，0–2000ms 步进 100） | range（`SettingsDrawer.tsx:647-662`） | 无 | 仅 A 有 | 无重叠 |
| 跟读模式（shadowingMode，默认 false） | 开关（`SettingsDrawer.tsx:663-674`） | 无 | 仅 A 有 | 无重叠 |
| 跟读评测开关（shadowingAssess） | 开关，`disabled={!shadowingMode}`（`SettingsDrawer.tsx:675-690`）；实际生效还需 `assessEnabled = shadowingMode && shadowingAssess`（`ReaderApp.tsx:602`） | 无独立同义开关；语义相关的 `voiceGatewayIseEnabled` 见下行 | **不同份且不同步**：A 管「阅读室要不要评测」，B 管「沉浸云评分能力本地开关」，评测时叠加判定（`useShadowAssess.ts:129` → `resolveVoiceRoute("ise")` → `voiceRoute.ts:227` `iseLocalOff`），任一关掉都不打分，两处 UI 无互相提示 | **最高优先澄清项**：合并后用生效态投影+双向提示收敛，让「为什么不打分」从查两处变看一处 |
| 跟读评测参数（过关阈值 shadowingPassScore / 读完自动开麦 shadowingAutoMic / 静音断句 shadowingSilenceMs，默认 4.2/true/1500 `readerTypes.ts:319-321`） | 三个控件（`SettingsDrawer.tsx:691-743`） | 无 | 仅 A 有 | 无重叠 |
| 跟读评分本地开关（voiceGatewayIseEnabled，默认 true） | 无控件；仅被消费：`resolveVoiceRoute("ise")` 每次现读（`voiceRoute.ts:227`），关掉时评测入口报「跟读打分已在设置里关闭」（:132） | switch「评分已开启/关闭」（`GatewayVoiceSection.tsx:275-280`）→ `Settings.tsx:1134` → `saveVoicePrefs` | **同一份数据**，B 唯一写点、A 侧按次现读即时生效 | 维持单源；消费点在 A 侧（`useShadowAssess.ts:129`、`SpeakView.tsx:731,1041`） |
| 麦克风设备偏好（immersive-translator-mic-device） | 下拉（`SettingsDrawer.tsx:744-761`），不进 ReaderSettings；`ReaderApp.tsx:2843-2846` 即时保存，独立 localStorage 键（`readerSettingsStore.ts:65`） | 无 | 仅 A 有；机器本地偏好，刻意不入 schema、不随文章 | 保持独立键，合并 UI 时也不并进可同步设置 |
| 讯飞凭据（ise 三件套 + tts/asr 独立覆盖，共九个 DPAPI 槽 `iseCredentials.ts:20-36`） | 无写控件；只读徽标（:593-607 / :762-778），挂载查一次、不监听 `xfyun:creds-updated` | 唯一写点：`XfyunVoiceSection.tsx` 主凭据三段输入+保存（:300-317 → saveIseCredentials :263）与高级覆盖（:350-385），存 DPAPI named secrets，保存成功 emit "xfyun:creds-updated"（:268,422,441） | **同一份数据**（DPAPI 命名 secret 单源），A 读 B 写 | 已合并完成，维持；本次给 A 侧徽标补 creds-updated 订阅 |
| 试听/测试识别/测试评分按钮 + 连接检查 + 本月额度 | 无 | `GatewayVoiceSection.tsx` 三行真实探测（FEATURE_COPY :31-35，探测 :151-186）与「连接测试与本月额度」details（:292-321，summary :294、本月剩余额度 :313）；`XfyunVoiceSection.tsx` 检查连接（:319-348，无额度 UI）；全部运行时 state 不落盘 | 仅 B 有；无持久化 | 纯运行时 UI，可随面板自由移动 |
| （非语音，同面板）提醒组：每日复习提醒/提醒时间/免打扰/免打扰时段/每日目标 | 开关/步进器（`SettingsDrawer.tsx:357-432`），走 `reminderGetConfig/reminderSetConfig`（:107-111, :157-166），存 Rust 侧 `app_data_dir/review_reminder.json`（`review_reminder.rs:173-179`） | 无 | 仅 A 有；抽屉里唯一走 Rust 文件的组 | 不搬迁；若未来重构抽屉注意它的存储不同 |
| （非语音，同面板）复习模式 reviewMode | 分段控件（`SettingsDrawer.tsx:336-355`），`patchReviewMode` 只写全局不写文章覆盖（`ReaderApp.tsx:2437-2445`） | 无 | 仅 A 有；「只全局」例外 | 合并不受影响 |

---

## 3. 为什么会有两套

1. **历史分层不同源。** `reader-settings`（阅读设置）诞生于阅读室功能线，管「怎么读」：引擎档位、发音人、语速停顿、跟读训练参数，天然带「全局默认 + 文章覆盖」双写语义（`ReaderApp.tsx:852-864`：同一 patch 同时写 `immersive-translator-reader-settings` 全局键与当前文章 `settings`，文章经 700ms 防抖 `reader_save_article` 落盘，生效值 = `mergeReaderSettings(全局, 文章覆盖)`，`readerTypes.ts:368-438`）。`immersive-translator-settings`（应用设置）管「用谁家的服务」：账号、服务商、云端音色、评分能力开关，点卡即写盘、不走保存条、不进云同步（`settingsStore.ts:341-347` 注释、`stripVoicePrefs` :292-297 剔除 dirty 比较）。
2. **沉浸云语音是后来者。** 2026-10-28 的语音云化决策（`docs/voice-cloud-decisions-2026-10-28.md`，硬契约 8：阅读室 TTS 支线零回归）把「服务商/云音色/评分开关」放进设置中心统一管理，阅读室通过现读 localStorage 跟随——当时选择了「播放时现读」而非「UI 订阅」，于是功能正确、界面陈旧。
3. **Mac 对齐规格把抽屉文案钉死了。** `docs/mac-parity-specs-2026-11-01/voice.md` 已把抽屉的「讯飞 vcn 两输入 + 凭据状态」「音色在语音页选择，此处不重复配置」等文案逐字固定（voice.md:35, :125, :141, :246, :309）。任何「把发音人收编进设置中心」的方案等于改规范、逼 Mac 端回同步。

所以两套入口不是事故，而是「阅读默认层」与「服务能力层」的合理分工；缺的只是把分工**显式化**并把跨窗口一致性补上。

---

## 4. 候选方案与选型理由

评审共比较三案，评委裁决选定**方案三：语音同源中枢（voiceSource Hub）**。

### 方案一：全收编进设置中心（抽屉只留跳转）
把发音人、语速等全部搬进「语音」页。**弃**：与 Mac 规格 voice.md 钉死的抽屉文案直接冲突，等于改规范；且失去「文章级覆盖」的就近入口。

### 方案二：抽屉全搬进阅读室（设置中心只留凭据）
把服务商、云音色等写权搬进抽屉。**弃**：需要跨两个 localStorage 键的手搓「原子」双写（仓内无跨键事务原语；`settingsStore.persistSettingsTransaction` :205-227 只覆盖 settings+DPAPI secret）；`saveGlobalReaderSettings`（`readerSettingsStore.ts:33-39`）是整包写，两个 WebView 渲染进程 read-modify-write 同键存在丢更新窗口；还有旧文章覆盖遮蔽全局默认的「改了没反应」错觉（见 §5.4）。

### 方案三（选定）：双面板形态不变，数据层三步归一
不合并面板、不迁移存储键。新增 `voiceSettingsHub` 模块统一「单写点规则 + 变更广播 + 生效值归约」，复用仓内已验证的跨窗口事件先例（`xfyun:creds-updated`：`XfyunVoiceSection.tsx:268` 全局 emit → `ReaderApp.tsx:1456-1463`、`VoiceSettingsTab.tsx:104` 跨窗消费）。评委裁决理由概要：

- **架构契合**：纯增量，不碰 Mac 对齐规格；与 2026-10-28 决策、voice.md §1.3 分层口径一致，属补完规范而非另起架构。
- **数据冲突**：不新增任何写点（方案一/二都会开第二写点）。
- **落地成本**：hub 模块 + 三处订阅改造 + Rust 补 3 字段，最小。
- **首次使用**：把两个已核实的真实伤害（挂载快照陈旧、AND 链两处打架）变成现场可见的提示；两侧拓扑本就互补且已有互相指路的文案（`SettingsDrawer.tsx:539`、`VoiceSettingsTab.tsx:275`、抽屉 :677 评测 tooltip）。

---

## 5. 选定方案详述

### 5.1 信息架构：逻辑三层、物理五份存储不动

```
L0 服务能力层（唯一写点：入口B 设置中心·语音页）
   voiceProvider（gateway|xfyun）· voiceGatewayVoice · voiceGatewayIseEnabled
   讯飞凭据九槽（DPAPI）· 连接测试/试听/额度（运行时，不落盘）
   存储：localStorage "immersive-translator-settings"（settingsStore.ts:52，点卡即写盘 :341-347）

L1 阅读默认层（唯一写点：入口A 阅读设置抽屉）
   ttsProvider 档位（edge|local|cloud|xfyun旧值）· Edge音色×2 · 讯飞发音人×2 · 本地音色
   语速 · 每句停顿 · 跟读模式/评测/阈值/自动开麦/静音断句 · 麦克风（独立键）
   存储：localStorage "immersive-translator-reader-settings"（readerSettingsStore.ts:17）
        + "immersive-translator-mic-device"（:65，刻意不进 schema）

L2 文章覆盖层（跟随文章，A 写）
   Article.settings → app_data_dir/reader_articles.json（reader_store.rs:185、:476、:789）
   生效值 = mergeReaderSettings(L1, L2)，文章覆盖优先（readerTypes.ts:368-438）
   例外：reviewMode 只写全局（ReaderApp.tsx:2437-2445）

跨层语义桥（只许归约函数单点存在，UI 只显示归约结果）：
   L1「云音色」档 → resolveVoiceRoute 现读 L0.voiceProvider（voiceRoute.ts:206、readerSpeechRoute.ts:30-48）
   跟读评测生效 = shadowingMode && shadowingAssess && L0.voiceGatewayIseEnabled && 服务端能力
```

不合并存储键的理由：`git log -S` 复核 reader-settings 键仅两次提交（创建与账号切换竞态修复），合并键会破坏竞态防护语义与文章覆盖 schema，收益低风险高。

### 5.2 两入口职责划分

**入口A（阅读室右侧抽屉）——形态与控件全部保留，只改三处：**

1. 「朗读」组顶部新增一行**「当前链路」生效态摘要**，由 hub 订阅实时刷新，替代挂载快照。文案口径：`云音色 · 沉浸云 · 已登录`／`云音色 · 讯飞 · 合成凭据已配置 ✓`／`云音色 · 讯飞 · 合成凭据未配置 · 播放回落系统语音`／`Edge 在线 · 免费直连`／`系统语音 · 离线可用`；读取中沿用现有「读取中…」口径（`SettingsDrawer.tsx:515`）。回落口径与 `readerSpeechRoute.ts:38-41/:46-48`、voice.md:35 对齐：讯飞缺 TTS 凭据回落**本地系统语音**（SAPI）；gateway 守卫 off（未登录/封禁/额度耗尽/能力未开通/网络失败等）时临时回落 Edge 并带回落决策。
2. 云音色分支的音色来源/合成凭据/评测凭据徽标改为**「挂载 + voice:prefs-changed + xfyun:creds-updated」三触发重查**（现状 `SettingsDrawer.tsx:99-155` 只查一次；Props :67 的 `onXfyunTtsCredsSaved` 是声明未用的死 prop，可顺手清掉）。
3. 跟读评测开关旁，当抽屉侧跟读模式与跟读评测均开、且当前走沉浸云链路（voiceProvider=gateway）而 `voiceGatewayIseEnabled=false` 时显示条件提示行：**「跟读打分已在 设置 → 语音 关闭，这里开着也不会打分」+ 按钮「去开启」**（复用 `settingsOpenTab("voice")`，后端双路径 `lib.rs:713-722` 已核实：窗口存在 emit `settings:navigate-tab`，否则写 pending 再开窗）。两个限定缺一不可：提示还需 `shadowingMode` 开（否则评测入口本身置灰）；`voiceGatewayIseEnabled` 只在沉浸云链路被消费（`voiceRoute.ts:206-213` 非 gateway 提前返回讯飞引擎，:227/:128 的 `iseLocalOff` 仅 gateway 分支生效），讯飞直连（自带凭据）用户与该开关无关，不提示。该提示行之下常驻一行**「打分链」生效态投影 chips**（跟读模式 → 跟读评测 → 评分开关（设置中心）→ 登录/凭据+服务端能力，断环显红 ✗）——把「为什么不打分」从查两处变看一处，与提示行同属评测语义的行内投影，不新增段落。

gateway 分支文案维持规范逐字不动（voice.md:125 钉死）：「音色在语音页选择，此处不重复配置」+「去语音页配置」/「去语音页登录」（现状 `SettingsDrawer.tsx:539-548` 即合规）；xfyun 分支的云音色中/英两输入与文章覆盖能力原样保留、不收窄。

**入口B（托盘 → 设置中心 → 语音页）——全部写点原样保留，只加两处：**

1. 每次 `applyVoicePrefs`（`Settings.tsx:256-264`，:1132-1134 三处接线）落盘后**经 hub 广播** `voice:prefs-changed`（现状写完无任何通知，全仓 grep 证实无 voice 变更事件）。
2. 评分开关旁补一行**只读投影**：「阅读室跟读评测的开关在 阅读室 → 阅读设置 抽屉；两处都开启才会打分」——该投影与评分开关同住沉浸云卡内、仅沉浸云链路显示（与真实 UI 结构一致；讯飞直连路径不经过该开关）——只给投影不开第二写点。

**用户想改某项去哪（速查）：**

| 想改什么 | 去哪 |
|---|---|
| 换服务商 / 沉浸云音色 / 评分能力开关 / 讯飞凭据 / 查额度、连接 | B（设置中心 → 语音） |
| 换引擎档位 / 任何发音人 / 语速 / 停顿 / 跟读参数 / 麦克风 | A（阅读室 → 阅读设置抽屉） |
| 排查「为什么不打分」 | 任一侧的链路提示直接指出关闭的那一环（现状需查两处 + 服务端归约） |

### 5.3 数据层与跨窗口同步（voiceSettingsHub）

新增 `src/lib/voiceSettingsHub.ts`，三职责：

1. **写 API**：`writeVoicePrefs`（包 `saveVoicePrefs` + 广播；B→A 主方向）、`writeReaderVoice`（包全局层写 + 广播；为 `QuickReviewApp.tsx:22,60` 等第三消费者预留，优先级低于 B→A）。
2. **订阅 API**：`listen("voice:prefs-changed")`。**事件协议（须写入 docs 决策文档并回链 Mac 规格附录，作为跨端共同契约）**：
   - payload 只带 `{ scopes, from, rev }`，**不带值**——回执方一律重读存储，防事件与存储竞态；
   - `from === 当前窗口 label` 则忽略回声；
   - `rev` 单调计数防乱序；
   - 新增语音字段必须进 hub 写 API + 登记 scope，漏了就复现不同步（以 hub 单文件 + 约定缓解）。
3. **派生投影**：`effectiveShadowAssess`、`currentVoiceChain`，复用 `resolveInitialVoiceProvider` / `resolveVoiceRoute` 既有纯归约。

**硬前提（评委 mustFix-2）**：ReaderApp 全局层目前只在挂载时加载一次（`ReaderApp.tsx:1378-1383`），storage 事件仅用来清配额回落标记（:505-512），外部对 reader-settings 键的写入对 React 态不可见。**hub 订阅收到事件后必须重跑 `loadGlobalReaderSettings` 并 `setGlobalSettings`**，否则抽屉与 effectiveSettings 仍陈旧，「秒级一致」落空。

**凭据同步不另造轮子（mustFix-7）**：继续走既有 `xfyun:creds-updated`（emit 点 `XfyunVoiceSection.tsx:268,422,441`），hub 不重复封装；抽屉两处徽标补订阅即可。

**监听器生命周期（mustFix-5）**：照抄 `SettingsDrawer.tsx:99-155` 的 `active` 标志 + `unlisten` 模式，并与 `lib.rs:345-369` 的窗口缺失现场重建对齐（settings 窗 hide 不销毁、挂载一生一次，`Settings.tsx:195` 注释自证；重建场景 React 重挂载会重新注册，重点防旧窗 unlisten 泄漏与重复回调）。

**播放链路改造（mustFix-4）**：`gatewayCfgRef` 从「渲染时重读」（`ReaderApp.tsx:500-501`）改为订阅刷新，触及播放链路，撞硬契约 8（阅读室 TTS 零回归，`voice-cloud-decisions-2026-10-28.md:55-57`）——落地时必须全量回归 + 真机双窗手测，不能拿单文件测试充当全量。

### 5.4 冲突处理

- **同键互相覆盖**：靠单写点规则表在源头消灭——voice 三字段只 B 写、reader-settings 全局只 A 写、mic 只 A 写、凭据只 B 写。
- **跨键语义冲突**（ttsProvider × voiceProvider）：由 `resolveVoiceRoute` 单点归约，UI 只显示归约结果（链路行）。
- **AND 链冲突**（抽屉评测 × 中心评分）：靠投影 + 双向提示暴露，归因措辞与 `voiceRoute.ts:132` 同一语气族；两侧提示都说清「哪一环关了、去哪开」，不抄成同一句以免误导。
- **L1/L2 冲突**：维持文章覆盖优先（既有 mergeReaderSettings 语义）。注意「在文章 A 改设置会写进 A 的覆盖、切到文章 B 看到的是 B 自己的旧覆盖」是设计内行为，合并不改它；文案指路只用用户能点到的名词（「设置 → 语音」「阅读室 → 阅读设置」），禁用「同步/hub/设置中心」等内部词。

### 5.5 配套修复（必做，独立 PR 纯正确性）

`reader_store.rs` 的 `ReaderSettingsOverride`（:105-161，恰 25 字段）补 `edge_voice_zh` / `edge_voice_en` / `spot_quiz_mode` 三个 `Option` 字段（照 `spotlight_mode` 先例 :154-160），并照 `settings_spotlight_fields_roundtrip_camel_case` 先例（:1771-1805）补「走真实落盘/读盘 serde 管线」的往返测试。本次核对：`grep -rn "deny_unknown_fields" src-tauri/src` 零命中；TS 侧消费点已在（`readerTypes.ts:401-402, :436`）。**诚实边界：只防增量，已落盘文章里被剥掉的历史值找不回来。**

---

## 6. 原型使用说明

### 6.1 怎么打开
`docs/voice-settings-merge-prototype-2026-11-11.html` 是零依赖单文件，浏览器双击打开即可（本次验收时亦通过本地静态服务器 + 浏览器实测过）。

### 6.2 看什么、点什么

| 视图 | 看什么 | 点什么 |
|---|---|---|
| ① 现状（默认） | 两入口并排；红/橙标签标出语义重叠与陈旧点；底部四张问题卡对应 §1 的 ①②③④ | 在右侧切「讯飞直连」→ 左侧「音色来源」**不变**（挂载快照）→ 点抽屉头部的「重开抽屉（重新挂载）」才变；关掉右侧「评分已开启」→ 左侧评测开关仍显示开、无任何提示 |
| ② 合并后（重点） | 左＝入口A（含新增①链路行/②评测提示+打分链投影/③徽标三触发），右＝入口B（含新增④只读投影）；**任一侧改动，另一侧行内状态即时刷新**（同一份 JS 状态对象模拟数据同源），右下角「跨窗口事件流」显示每条 `voice:prefs-changed {scopes, from, rev}` 与回声抑制说明 | 顶部八个「状态矩阵速切」按钮逐个点（全链开 / 中心关评分 / 抽屉关跟读 / 沉浸云未登录 / 讯飞缺评测凭据 / 讯飞缺合成凭据 / Edge 直连 / 系统语音）——评委 prototypeNotes 要求的验证重点是状态切换矩阵而非排版；中心关评分 → 左侧出现提示行 + 打分链 chips 评分环变红 + 「去开启」按钮（点击后模拟跳转并高亮右侧评分开关）；讯飞缺合成凭据 → 链路行显示「播放回落系统语音」（讯飞缺 TTS 凭据回落本地 SAPI 而非 Edge，`readerSpeechRoute.ts:38-41/:46`）；右侧存讯飞凭据 → 左侧徽标即时变「已配置 ✓」 |

原型不新增段、不新增 tab、不改布局：所有新增都是行内状态行/条件提示，两侧信息密度零上升。

### 6.3 每个区域的「为什么这样放」
每个卡片头部下方有一条绿边「为什么这样放」说明条；每个设置行的悬浮 tooltip（title 属性）解释该行设计与代码依据——与真实应用抽屉用 title 提示的习惯一致。

### 6.4 原型本身的验证情况（2026-11-11 实测）
- `node --check` 对内联脚本整体通过；
- 经本地静态服务器 + 浏览器（1440×1000）实测：现状陈旧快照流（B 切服务商 → A 不变 → 重开抽屉刷新）、合并后链路行解析、中心关评分 → 提示行 + AND 链红环 + B 侧投影、去开启 → 跳转高亮、评分开关开 → 提示消失、引擎切 Edge → 链路行即时变、凭据保存 → A 徽标即时变 + `xfyun:creds-updated` 入事件流、滑杆/下拉的静默更新与 change 广播（rev 单调递增），均通过；两个视图截图目检布局正常。
- 测试中发现并已修复两处原型缺陷：①两视图共存于 DOM 导致动态 id 重复（已按视图加后缀）；②`saveCreds` 未挂到 window 使 inline onclick 静默失效（已挂载）；并补上了此前引用了但未渲染的三个 datalist 建议列表。

---

## 7. 后续落地步骤建议（分期，只到建议）

> 以下为建议顺序，每期独立可验收；本期只做设计，未写任何应用代码。

- **P0（独立 PR，纯正确性，先于一切 UI 工作）**：Rust 补三字段 + 往返测试（§5.5）。验收：`cargo test reader_store`（含新增往返用例）。
- **P1（hub 数据层，无 UI 变化）**：新增 `src/lib/voiceSettingsHub.ts`（写 API / 订阅 API / 派生投影），`applyVoicePrefs` 落盘后接广播；vitest 覆盖归约与回声抑制。验收：`npx vitest run`（全量）+ `npx tsc --noEmit`。
- **P2（入口A 三处行内改造）**：链路行、评测提示行 + 去开启、两处凭据徽标三触发；同时完成 ReaderApp 全局层热重载（mustFix-2）与 gatewayCfgRef 订阅化（mustFix-4）。验收：P1 全量项 + 真机双窗手测三条链路（B 改服务商→A 链路行即时变；B 存凭据→A 徽标即时变；B 关评分→A 提示行出现且评测入口文案正确）。
- **P3（入口B 一处投影 + 文档回链）**：评分开关旁只读投影行；事件契约写入 docs 决策文档并回链 Mac 规格附录（voice.md 附录），作为跨端共同契约。
- **P4（上线前）**：真机双窗实测一次跨窗时序（mustFix-3）——现成载体是 `xfyun:creds-updated` 活链路（设置窗存凭据 → ReaderApp 引擎缓存刷新 + VoiceSettingsTab 徽标刷新），顺路验证「同 bundle 无 per-window url → 同 origin 共享 localStorage」与 WebView2 双窗事件可达性，不必等新事件。清理死 prop `onXfyunTtsCredsSaved`（`SettingsDrawer.tsx:67`）。

---

## 8. 风险与未决问题

1. **事件协议是新增维护面**：以后加语音字段必须记得进 hub 写 API + 登记 scope，漏了就复现不同步；只能靠收敛进 hub 单文件 + 契约文档缓解（§7 P3）。
2. **gatewayCfgRef 改订阅触及播放链路**：撞硬契约 8（阅读室 TTS 零回归），必须全量 `npx vitest run` + `npx tsc --noEmit` + `cargo test reader_store` + 真机双窗手测；本期评审与原型阶段这些均**未运行**，不能拿单文件测试充当全量回归。
3. **监听器生命周期**：须与 `lib.rs:345-369` 的窗口缺失现场重建对齐，漏 unlisten 会重复回调；逐处照抄 active+unlisten 模式。
4. **WebView2 双窗口 localStorage/事件互通本次未实测**（静态推断自同 bundle 同 origin + 既有 storage 监听 + 线上「阅读室跟随语音页服务商」行为已依赖跨窗读值）；设计可行但上线前必须真机验证一次（P4）。
5. **明确放弃「抽屉也能改服务商/云音色」的双向写**：用户在 A 想换音色来源仍需一键跳转。这是防第二写点引入冲突面的刻意取舍，不是遗漏。
6. **Rust 三字段修复只防增量**：已落盘文章里被剥掉的历史 Edge 音色/随读抽查覆盖找不回来，不做数据抢救。
7. **排除项记录**：方案二（抽屉全搬）若未来重启，须先解决 `shadowingAssess`（reader-settings）与 `voiceGatewayIseEnabled`（immersive-translator-settings）分属两键、仓内无跨键事务原语的问题（`settingsStore.persistSettingsTransaction` :205-227 只覆盖 settings+DPAPI secret），以及旧文章覆盖遮蔽全局默认的「改了没反应」错觉。
8. **原型与实现的差距**：原型用单一 JS 状态对象模拟五份存储与两个窗口，事件流的「回执方重读存储」「回声抑制」是文字演示而非真实 Tauri 事件；它验证的是信息架构与状态矩阵，不替代 P4 的真机验证。
