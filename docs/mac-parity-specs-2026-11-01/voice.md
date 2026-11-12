# Mac 1:1 移植规格 · 官方语音网关（voice）

日期：2026-11-01。基准：Windows `immersive-translator-windows/` 主批次 commit **4d48d85**（官方语音网关主批次：语音设置双栏 + 登录自动切云 + 实时字幕路由接入）与 **08595f3**（朗读引擎「云音色」升格：讯飞档位跟随语音页 voiceProvider，gateway 走官方网关流式 TTS）。规格输入（Windows 侧唯一规范）：`docs/voice-cloud-implementation-contract-2026-10-28.md`、`docs/reader-tts-provider-upgrade-prompt-2026-10-28.md`。

**服务端仓库说明**：任务描述中的 `immersive-translator-server/` **在本仓库未检出**（仓库根 `ls -la` 无此目录，2026-11-01 实证）。网关端点契约以两处为准：① 契约文档 `docs/voice-cloud-implementation-contract-2026-10-28.md:12-22`（§一 协议摘要，含服务端实现位置参考路径 `apps/api/src/modules/gateway-voice/`）；② Windows 客户端实现（`src/lib/voice/`、`src-tauri/src/voice.rs`）。`contracts/` 目录无语音相关契约（仅 README/learning-relay-v2/reading-room/speak-scenario 四件，已实证）。

---

## 一、Windows 行为规格

### 1.1 功能入口与交互流

四个入口，全部围绕一个本地偏好 `voiceProvider`（"gateway" | "xfyun"）展开：

**(a) 语音设置双栏（设置窗口 →「语音」tab）** — `src/views/VoiceSettingsTab.tsx`（挂载于 `src/views/Settings.tsx:1007-1017`）
- 复刻「模型服务」页的双栏单选同构（provider-workspace：左列服务商选择、右列随选中切换配置面板）。
- 左列两组：「官方云服务」分组下的「沉浸云语音」大卡（platform-card，标 `官方`+`推荐` 双 chip）；「自带凭据 · 高级」分组下的「讯飞开放平台」行（凭据存在时亮 keydot）。
- **点卡即即时保存**（`onSelectProvider` → `applyVoicePrefs` → `saveVoicePrefs` 立即写 localStorage，不经底部保存条，`Settings.tsx:273-282`）；与 LLM providerId 解耦；不纳入云同步。
- 官方云未开放（`platformBase === null`，来自 Rust `auth_server_base_url`）：左列只渲染讯飞行、选中强制讯飞语义、页头保留旧讯飞文案（`VoiceSettingsTab.tsx:72,150-152,165,196-199,231`）。
- 右列云模式 = `GatewayVoiceSection`（账号卡 + 能力卡 + 一键测试，见 1.2）；讯飞模式 = 存量 `XfyunVoiceSection` 三件套原样保留。

**(b) 登录成功瞬间自动切云** — `src/views/Settings.tsx:169-191`
- 监听 `loggedIn` 的 **false→true 边沿**（`prev !== false || !loggedIn` 不触发；启动静默续登录 null→true 不算登录瞬间）。
- 满足边沿且当前 `voiceProvider !== "gateway"`：立即 `applyVoicePrefs({ voiceProvider: "gateway" })` 落盘 + 顶部绿色 msg-bar 轻提示 4 秒（`Settings.tsx:567-572`，文案见 1.2）。
- 讯飞凭据原样保留、随时可切回。已是 gateway 无感。

**(c) 实时字幕（录音直译）路由接入** — `src/livecaption/LiveCaptionApp.tsx`
- 点「开始录音」那一刻调 `resolveVoiceRoute("asr", { asrLang })` 并**定格**在 `routeRef`，整场录音共用（`LiveCaptionApp.tsx:55,191-192`）。
- `engine === "off"` → toast 引导文案、不开麦（`:193-195`）；`engine === "xfyun"` → 查讯飞听写凭据，缺失给存量讯飞文案不开麦（`:197-202`）。
- `engine === "gateway"` → 每句（VAD 分句收尾）走 **REST 批量转写 `transcribeBatch`**（pcm 已 16k，`pcm16kToBase64(pcm, 16000).base64`，`:139-142`）；错误按 §二映射经 `voiceErrorDisplayText` 显示，讯飞分支保留原始 message（`:143-154`）。
- flush 尾句在 route 缺失时补一次 resolve（`:112-117`）。

**(d) 朗读「云音色」档（阅读室设置抽屉）** — `src/reader/SettingsDrawer.tsx:434-459` + `src/reader/readerSpeechRoute.ts`
- 朗读引擎三档 segmented：「Edge 在线」/「云音色」/「系统语音」。存量 `"xfyun"` 值 UI 上并入「云音色」档高亮（`SettingsDrawer.tsx:446-447`），点选写 `"cloud"`。
- 「云音色」来源**跟随语音页 voiceProvider**：抽屉内不重复配置音色，gateway 时显示登录态一行 +「去语音页配置」按钮；xfyun 时显示存量讯飞 vcn 两输入 + 凭据状态（`SettingsDrawer.tsx:509-611`）。
- 运行时路由 `routeReaderSpeech`（`readerSpeechRoute.ts:31-49`）：`edge`→edge 引擎；`local`→SAPI；旧 `xfyun`（未迁移）→有凭据走讯飞、无凭据回落本地；`cloud`→现调 `resolveVoiceRoute("tts")`：gateway 守卫过→网关流式 TTS 引擎；守卫判 xfyun→讯飞/本地；**off→静默回落 Edge 引擎并带回落决策**（不弹登录墙、不中断阅读）。
- 守卫/运行时配额耗尽 → toast「已临时使用 Edge 朗读：…」+「兑换更多额度」动作位；运行时同句转 Edge、后续句直接 Edge（`ReaderApp.tsx:511-531`）。

### 1.2 UI 状态与用户可见文案（原样抄录）

**语音 tab 页头副标题**（`VoiceSettingsTab.tsx:196-199`）：
- 云开放：`云端朗读、口语识别、跟读打分——登录沉浸云即用，无需申请任何密钥；也可使用自己的讯飞凭据。`
- 云未开放：`填一组讯飞凭据，跟读打分、云端朗读、口语识别三个服务共用（需在讯飞控制台为应用开通对应服务）。经 DPAPI 加密存储。`（Mac 对应 Keychain 加密存储）

**左列卡片**（`VoiceSettingsTab.tsx:231-320`）：
- 分组标题：`官方云服务` / 副题 `沉浸云账号登录即用，三个服务零配置`；`自带凭据 · 高级` / 副题 `使用你自己的讯飞开放平台应用与密钥`
- 沉浸云大卡：标记字「云」；标题 `沉浸云语音` + chip `官方`（绿）+ `推荐`（蓝）；描述 `登录即用，三服务共用一个账号`；状态行文案见下
- 讯飞行：标记字「讯」（蓝）；名称 `讯飞开放平台`；meta `跟读打分 / 口语识别 / 云端朗读 · 需自行申请凭据`；keydot title `已保存讯飞凭据（DPAPI 加密）`

**沉浸云卡状态行**（`gatewayViewState.ts:112-143`，tone: ok/off/err）：
- 未登录：`未登录——选中后到右侧登录即可使用`
- banned：`账号已被封禁`；error：`连接沉浸云失败，请检查网络`
- none（未开通）：`语音功能暂未开通——账号正常，服务端尚未为本账号开通语音`
- partial：`已登录 {email} · {可用短名、}可用，{缺失短名、}未开放`
- loading：`已登录 {email} · 正在获取语音能力…`
- full：`已登录 {email} · 朗读、识别、跟读打分全部可用`；配额耗尽：`已登录 {email} · 本月额度已用完`
- 能力名（`gatewayViewState.ts:49-60`）：全名 `云端朗读`/`口语识别`/`跟读打分`；短名 `朗读`/`识别`/`跟读打分`

**右列配置面板头**（`VoiceSettingsTab.tsx:326-340`）：标题 `沉浸云账号`（副题 `沉浸云语音`）或 `讯飞开放平台`；chip：`已登录`/`未登录`（gateway），`凭据已保存`/`未配置`/`读取中…`（xfyun）

**GatewayVoiceSection 账号卡**（`GatewayVoiceSection.tsx:237-276`）：
- 未登录 hint：`登录后即可使用：无需申请任何密钥，朗读、识别、跟读打分三个服务共用一个账号，按账号额度计费。`
- 登录按钮：`登录沉浸云`（打开中：`正在打开登录窗口…`）
- 已登录：回显邮箱 + `语音请求的令牌由客户端自动携带并自动续期，无需配置。` + 按钮 `管理账号`

**网络失败整卡**（`:279-297`）：chip `获取失败`；hint `账号登录状态不受影响；网络恢复后重新获取，回到沉浸云语音。`；红条 `无法连接沉浸云，请检查网络或代理设置。` + 按钮 `重试`

**封禁整卡**（`:298-322`）：chip `已封禁`；hint `封禁期间朗读、识别、跟读打分全部停用；申诉通过后自动恢复，无需重新配置。`；红条 `账号已被封禁，如有疑问请前往申诉。` + 按钮 `前往申诉`（APPEAL_URL 为 null 时置灰，title `申诉渠道即将开放`）

**能力卡头 chip + hint**（`:525-549`）：
- full：`全部可用` / `三项能力由沉浸云统一下发，随账号状态自动更新。`
- loading：`读取中…` / `正在获取本账号的语音能力，通常数秒内完成。`
- none：`未开通` / `服务端尚未为本账号开通语音；开通后此卡自动点亮，无需重新配置。`
- partial：`部分可用` / `{缺失能力全名、}暂未开放，其余能力不受影响。`
- 耗尽：`额度用尽` / `能力正常，本月{功能名、}额度已用完；重置后自动恢复，不改动你的服务商选择。`

**能力卡行**（`:328-461`）：
- 朗读音色：hint `音色由沉浸云统一下发，管理台更新后下次启动生效。`；下拉缺省态 option `暂无可用音色`；选中值不在列表时回落第一个
- 识别语种：hint `语种由消费场景决定（领读、陪练为英语；录音直译按翻译方向），此处仅展示下发结果。`；缺失态 hint `沉浸云识别暂未开放——录音直译、口语陪练入口不可用。`；chip 展示 `英语`(en_us)/`中文`(zh_cn)/透传，缺失态 chip `暂未开放`
- 跟读打分开关：hint `关闭后，跟读练习只保留原声朗读，不再评分。`；缺失态 hint `服务端暂未开放，开通后自动恢复；期间跟读页隐藏评测入口。` + chip `未开放`
- 本月额度：常驻 `朗读 N 字 · 识别 N 秒 · 跟读 N 次`（缺失条目 `—`，`gatewayViewState.ts:146-159`）+ hint `{N 月 N 日重置}；额度随用随扣，用尽时提醒。`（无 resetsAt：`按自然月（UTC）计费；额度随用随扣，用尽时这里会展示余量与重置时间。`）；耗尽态 hint `本月{功能名、}额度已用完；可用兑换码补足，或等下月自动重置。` + 按钮 `兑换更多额度`
- 一键测试按钮：`一键测试`/`测试中…`，title `评分项消耗 1 次额度`；hint `逐项验证朗读、识别、跟读打分通道；评分项消耗 1 次额度。`

**一键测试三行灯**（`:49-53,463-516`）：
- 行文案：`跟读打分` `真实英文样本评测 · 消耗 1 次评分额度`；`云端朗读` `短句合成探测 · 不播放声音`；`口语识别` `样本转写探测 · 消耗少量识别秒数`；行禁用态 `服务端暂未开放`
- 按钮：`测试`/`测试中…`/`重测`
- 成功文案：`评测通道正常（总分 {N}）`、`识别通道正常（约 {N} 秒）`/`识别通道正常`、`合成通道正常`
- 失败文案：`样本被判定为无效语音，请重测`、`识别结果为空，请重测`、quota：`本月{功能名}额度已用完{，N 月 N 日重置}`、其余走 `voiceErrorMessage` 兜底
- 汇总条：`测试完成：{ok} 项通过，{bad} 项异常——可对未通过项单独「重测」。` / `测试完成：已测 {ok} 项全部正常。`

**引导/提示条**：
- 切云引导条（已登录+能力齐备+停在讯飞，可关闭）：`沉浸云已为本账号开通语音能力——点击左侧「沉浸云语音」卡片即可切换，讯飞凭据保留、随时切回。`（`VoiceSettingsTab.tsx:203-215`）
- 未开通提示条 + 重试按钮：`语音功能暂未开通——账号正常，服务端尚未为本账号开通语音。`（`:216-225`）
- 登录自动切云轻提示（4s）：`已切换为沉浸云语音——讯飞凭据已保留，可在「语音」页随时切回`（`Settings.tsx:567-572`）
- 页脚 caption：`之前在阅读室设置抽屉、口语陪练、录音直译里填过的凭据仍然有效（同一套加密存储），无需重复填写。`（`VoiceSettingsTab.tsx:364-366`）

**错误码 → 文案映射表**（`voiceErrors.ts:108-167`，唯一来源，UI 与客户端共用；final=自动重试已用尽）：

| code | 文案 | kind/action/retryable |
|---|---|---|
| `token_expired` | （空） | silent / retry / true |
| `token_invalid`（`unauthorized` 归一） | `登录已失效，请重新登录` | message / relogin / false |
| `token_reused` | `检测到登录凭据异常复用，该账号已在所有设备安全下线，请重新登录` | message / relogin / false |
| `banned` | `账号已被封禁` | message / appeal / false |
| `voice_ticket_invalid` | `连接不稳定，正在重试…`；final `请稍后再试` | message / retry |
| `quota_exceeded` | `本月{朗读|口语识别|跟读打分|对话|语音}额度已用完` | message / redeem / false |
| `rate_limited` | `请求太频繁，请稍后再试` | message / retry / true |
| `ise_disabled` | （空，隐藏入口） | silent / null / false |
| `voice_not_configured` | `语音功能暂未开通` | message / null / false |
| `voice_text_too_long` | （空，客户端拆句重发） | internal / retry / true |
| `voice_invalid_state` `voice_session_too_long` | `单次最长 60 秒，请重新开始` | message / retry / true |
| `upstream_error` `upstream_timeout` | `服务暂时不可用，正在重试`；final `请稍后再试` | message / retry |
| `voice_disconnected`（本地伪码） | `网络中断，正在重连…`；final `网络连接不稳定，请稍后再试` | message / retry |
| `network_error`（本地伪码） | `网络连接失败，请检查网络后重试` | message / retry / true |
| 未知 | `服务暂时不可用，请稍后再试` | message / retry / false |

- 功能名插值（`voiceErrors.ts:87-100`）：`tts_chars`→朗读、`asr_seconds`→口语识别、`ise_calls`→跟读打分、`llm_tokens`→对话、其余→语音。
- 消费点展示文案 `voiceErrorDisplayText`（`gatewayViewState.ts:177-189`）：redeem 类拼 `，{N 月 N 日重置}`（resetsAt 缺失则 `，可在「设置 → 账号」用兑换码补足`）；silent/internal 返回空串。
- 通用约束：文案不出现 HTTP 状态码、协议术语、实现说明；不透传服务端 message。

**路由守卫 hint 文案**（`voiceRoute.ts:90-137`）：`登录沉浸云即用` / `账号已被封禁` / `暂无法连接沉浸云语音，请检查网络后重试` / `语音功能暂未开通` / `本月{朗读|识别|跟读打分}额度已用完，可在「设置 → 账号」用兑换码补足` / `跟读打分已在设置里关闭，可在「设置 → 语音」重新开启` / `沉浸云{云端朗读|口语识别|跟读打分}暂未开放`；TTS 回落标注常量 `EDGE_FALLBACK_NOTICE = "已临时使用 Edge 朗读"`（`voiceRoute.ts:69`）。

**实时字幕底部 hint**（`LiveCaptionApp.tsx:375-380`）：`静音约 1 秒自动断句；语音引擎在 设置 → 语音 里选择（沉浸云登录即用，或自带讯飞凭据）` + `打开设置` 按钮；讯飞缺凭据 toast：`讯飞听写凭据未配置：到 设置 → 语音 里填一次（或复用跟读评测那组）`。

**阅读抽屉云音色行**（`SettingsDrawer.tsx:509-611`）：`音色来源` = `沉浸云语音 · 已登录`/`沉浸云语音 · 未登录`/`沉浸云语音 · 正在读取登录状态…`；服务说明 = `音色在语音页选择，此处不重复配置`（未登录：`当前未登录，播放会临时使用 Edge 朗读`）；按钮 `去语音页登录`（未登录）/`去语音页配置`。

**朗读 toast**（`ReaderApp.tsx:474-480`）：网关错误：`朗读失败，已停止：{voiceErrorDisplayText}`；本地归因：`朗读失败，已停止：{归因}（点播放键重试，或到 设置 → 语音 检查）`；回落：`已临时使用 Edge 朗读：{detail}`（配额类带重置时间）。

**账号 tab 兑换码卡**（`RedeemCard.tsx`，锚点 `id="account-redeem"`）：输入 hint `输入兑换码补足本月额度（形如 XXXX-XXXX-XXXX-XXXX）`；按钮 `兑换`/`兑换中…`；成功 `兑换成功，额度已到账`；错误 `兑换码不存在`/`兑换码已过期`/`兑换码已被使用`/兜底 `兑换失败，请稍后再试`。语音页「兑换更多额度」→ 切账号 tab + scrollIntoView + focus（`Settings.tsx:284-292`）。

### 1.3 数据结构与本地存储

**voicePrefs 三字段**（`settingsStore.ts:37-43`，存于 localStorage `immersive-translator-settings`，与 AppSettings 同文件）：
- `voiceProvider?: "gateway" | "xfyun"`——未存过时迁移推断：任一讯飞凭据槽位存在（主凭据 iseMain / TTS 覆盖 ttsOwn / ASR 覆盖 asrOwn，`iseCredentials.ts:111-134`，secret 键名 `xfyun_ise_*`/`xfyun_tts_*`/`xfyun_asr_*`）→ 保持 `xfyun`（零感知）；否则默认 `gateway`。纯函数 `inferVoiceProvider`（`settingsStore.ts:267-273`）；异步 `resolveInitialVoiceProvider`（`:279-289`）已存值优先、推断结果只展示不落盘。
- `voiceGatewayVoice?: string`——云模式音色 id（me/config ttsVoices 里的 id；缺省用服务端默认音色=列表第一项）。
- `voiceGatewayIseEnabled?: boolean`——跟读打分本地开关，缺省 true（服务端 iseEnabled 之上的个人开关）。
- 保存语义：点卡即写盘 `saveVoicePrefs`（`settingsStore.ts:306-334`，只合并这三个字段进已存 JSON，不带出旧明文 apiKey）；`stripVoicePrefs`（`:292-297`）把它们从保存条 dirty 比较中剔除；不纳入云同步。

**能力数据**（`voiceCapabilities.ts:14-40`）：`VoiceCapabilities { available, ttsVoices: [{id,label}]（默认音色排第一，服务端已排序）, asrLanguages: string[]（只能取其中，契约只有 en_us/zh_cn）, iseEnabled, quota: {tts|asr|ise: {remaining, allowance, resetsAt}} | null }`。解析容错（`:114-125`）：无 voice 段 → available=false 全空；配额键别名 `tts/tts_chars/asr/asr_seconds/ise/ise_calls`（`:73-80`）。来源 `GET /v1/me/config` 的 voice 段，复用既有鉴权通道（Rust `auth_fetch_server_config`）；管理台可热改，客户端冷启动拉一次；`voiceRoute` 侧另有 30s TTL 缓存（`voiceRoute.ts:142-169`，失败不缓存）。

**阅读室设置**（`core/readerTypes.ts:260-263,310`）：`ttsProvider: "edge" | "local" | "cloud" | "xfyun"`，默认 `"edge"`。`xfyun` 仅旧数据兼容：启动时判定迁移允许（`resolveLegacyTtsMigrationAllowed`，`readerSettingsStore.ts:47-61`：任一讯飞凭据存在或已登录沉浸云，探测失败按无）→ 允许则旧值升格 `"cloud"` 并落盘，不允许保留 `"xfyun"`（继续「缺凭据→本地回落」，不串 Edge）。迁移谓词 `shouldMigrateLegacyTtsProvider/migrateLegacyTtsProviderValue`（`readerTypes.ts:338-351`）：仅旧值 `xfyun` 参与迁移；edge/local/cloud 永不被改写。文章级覆盖同样过 `mergeReaderSettings` + 迁移（`ReaderApp.tsx:394-398`）。

**录音重采样**（`resample.ts`）：设备采样率 Float32 → 16k/16bit/单声道；对称量化（+1→32767，-1→-32768）；REST 用 base64、流式 ASR 用 Int16 小端原始字节；只在内存，**绝不落盘**（隐私红线）。

**测试样本资产**（`src/assets/voice/ise-test-sample.pcm` + `README.md`）：16k/16bit/单声道 PCM 裸流，**54240 字节 / 1695ms**，内容固定英文句 `"The quick brown fox jumps over the lazy dog."`；参考文本常量 `SAMPLE_REF_TEXT` 同句（`GatewayVoiceSection.tsx:38`）；TTS 探测句 `"Hello."`（`:40`）。

### 1.4 网络端点与请求/响应契约

总则（契约 §一，`docs/voice-cloud-implementation-contract-2026-10-28.md:12-22`）：客户端只走网关，**禁止直连讯飞上游**；所有语音接口要求登录。

| 端点 | 方法 | 请求 | 应答 | 客户端锚点 |
|---|---|---|---|---|
| `/v1/voice/ticket` | POST | 无 body（Bearer） | `{ticket, expiresAt}`；ticket 60s 有效、一次性、限流 30/min | `voiceTicket.ts:44-56` |
| `/v1/voice/asr` | POST | `{lang: "en_us"\|"zh_cn", audio: base64(PCM, ≤50s)}` | `{text, durationMs}` | `voiceRest.ts:33-43` |
| `/v1/voice/ise` | POST | `{refText(≤2000 字), lang: "en"\|"zh", audio}` | 5 分制 `{total, accuracy, fluency, standard, isRejected, exceptInfo?, words[]}`（words: `{content, totalScore, dpMessage, sylls[{content, phones[]}]}`；网关不下发 integrity，客户端兜底 5） | `voiceRest.ts:69-109` |
| `/v1/voice/asr/stream?ticket=&lang=` | WSS | 上行 binary 16k/16bit/mono PCM（单帧 ≤128KB，建议 320ms≈10KB）+ text 帧 `{"type":"start"}`/`{"type":"stop"}` | 下行 text `{"type":"interim"\|"final","text","durationMs"?}`/`{"type":"error","code","details"?}` | `voiceAsr.ts` |
| `/v1/voice/tts/stream?ticket=` | WSS | 上行**只有** text 帧 `{"type":"synthesis","text","voice"?,"volume"?}`（绝不发 binary） | 下行 binary mp3 分片（按序追加播放）+ `{"type":"end"}` / `{"type":"error",...}` | `voiceTts.ts` |
| `/v1/me/config` | GET | Bearer | JSON 含 `voice: {ttsVoices, asrLanguages, iseEnabled, quota?}`（复用既有鉴权通道） | `voiceCapabilities.ts:114-130` |
| `/v1/redeem` | POST | `{code}`（已存在） | 2xx / 错误信封 `redeem_code_not_found/expired/used` | `RedeemCard.tsx:58-78` |

- 会话约束：ASR 会话 ≤60 秒；final 后同连接可再 start；重复 start→`voice_invalid_state`；服务端 25s ping，标准 WS 自动 pong。TTS 同连接多次 synthesis 按序不并发；单次文本 **<8000 UTF-8 字节**（客户端拆分上限 7900=8000−100 余量，`ttsTextSplit.ts:12-14`）；error 帧后连接不断可继续。
- 鉴权管线：HTTP 带 `Authorization: Bearer <access>`，401 `token_expired` 由传输层单飞刷新后**重放一次**（Windows 在 Rust `auth.rs with_auth`；令牌永不跨 IPC）；refresh 必须串行（并发双刷触发 `token_reused` 整族吊销）。WSS 不能带自定义头 → 一次性 ticket query 握手；**每次建连（含重连）前现调现用、绝不缓存、拿票到握手间不插长耗时操作**；ticket 管理器串行链单飞（并发建连排队各领各的新票，结果不共享，`voiceTicket.ts:27-42`）。
- 错误信封：`{error: {code, message, details?}}`；**非 2xx 是协议数据不是错误**，只有网络/致命鉴权才 reject 传输层。402 额外带 `x-quota-<resource>-remaining` 响应头（details 之外唯一可得字段；Windows Rust 侧白名单只透传 `x-quota-*`，`src-tauri/src/auth.rs` `whitelist_quota_headers`，4d48d85 diff 实证；客户端信封缺 remaining 时从头补，`voiceHttp.ts:65-75`）；429 透传 retry-after。信封缺失按 HTTP 状态兜底（401→unauthorized、402→quota_exceeded、429→rate_limited、5xx→upstream_error、其余 unknown，`voiceHttp.ts:41-47`）。
- Rust 传输命令 `voice_http_request`（`src-tauri/src/voice.rs:68-89`）：method 白名单 GET/POST、path 白名单 `/v1/voice/*` 且禁 `..`；`VoiceHttpText { status, body, retryAfterSeconds, headers }` camelCase；生产接线唯一调用点 `src/main.tsx:11` `installVoiceHttpTransport()`（`voiceRuntimeIpc.ts:17-26`），未接线时换票/转写/评测抛编程错误。
- WSS URL 拼装：base（默认 `authServerBaseUrl()`，null=官方云未开放→抛 `voice_not_configured`）`http→ws` + path + query（`voiceHttp.ts:90-98`）。

### 1.5 边界与错误处理

**守卫归约 `reduceVoiceRoute`**（`voiceRoute.ts:90-138`，纯函数，优先级链）：
未登录(`not_logged_in`) > 封禁(`banned`，capsError==="banned") > 能力不可用(`caps_unavailable`，caps=null 网络类) > 未开通(`voice_not_configured`，caps.available=false) > 配额耗尽(`quota_exhausted`：常驻 `quota[ability].remaining===0` 或 402 事件 resource 别名命中；带 quota 字段) > 本地 ISE 开关关(`ise_turned_off`，仅 ability=ise) > 能力缺失(`capability_missing`：ttsVoices 空 / asrLanguages 空或不含所需语种 / iseEnabled=false) > 放行 `gateway`。
- 异步入口 `resolveVoiceRoute`（`:181-211`）：provider≠gateway 直接 `{engine:"xfyun"}`（存量讯飞用户不经守卫，零回归；偏好读取失败也按 xfyun 兜底）；gateway 时登录态每次现查（未登录不拉能力，省一次往返）；caps 30s TTL；**不抛错**，取数失败折算保守 off 带引导。

**ASR 状态机**（`voiceAsr.ts`）：帧上限 128KB（超限外部大块切帧）；断线重连指数退避 1s 起步 ×2 封顶 15s、最多 6 次（累计约 45s）后终局 `voice_disconnected`；断线期间音频内存缓冲（上限 60s×32KB，超出丢最旧）待重连重放；握手失败（open 前即关）按 `voice_ticket_invalid` 换票立即重试一次，仍失败终局；鉴权类失败（token_invalid/token_reused/unauthorized/banned/quota_exceeded/voice_not_configured）终局不重试；error 帧按 §二 映射、连接保留可再 start；识别中重复 start 客户端幂等拦截；无 start 推音频忽略。

**TTS**（`voiceTts.ts`）：单片看门狗 30s 无 end → `upstream_timeout`；可重试码（upstream_error/upstream_timeout/voice_disconnected/voice_ticket_invalid/network_error）**重试 1 次**：丢弃连接换票重建重发当前片，已 end 片不重放（防重复播放），仍失败终局；模块级串行队列（前一次未结束排队）；空/纯白文本直接 onEnd 不建连；error 帧不断连可继续。**REST 录音上传失败不自动重试**（隐私红线，`voiceRest.ts:3`）。

**状态机归约 `reduceVoiceGatewayView`**（`gatewayViewState.ts:70-109`）：封禁 > 网络失败 > 下发中 > 未开通 > 部分/全可用；配额耗尽不改 caps 相位，叠在视图上（exhausted/exhaustedLabels）；配额双来源：常驻 me/config quota（remaining===0）+ 402/WSS 事件（resource 裸值，去重）。

**朗读 dispatcher**（`speechEngine.ts:500-559` + `ReaderApp.tsx:502-550`）：speak 路由带版本守卫（停止/切句后迟到结果丢弃）；启动失败可经 `onSpeakError` 同句恢复引擎——网关 `quota_exceeded` 时记录 `gatewayQuotaErrorRef`、本句与后续句转 Edge（守卫缓存可能尚未感知）；首片已播后的异步失败走 `onAsyncError`（stop + toast，不静默重试）；回落提示按 message+action 去重（连读不重复弹）。

**官方云未开放 / 平台边界**：`platformBase===null`（服务端未公开部署且本机无 server_endpoint.json）→ 官方分组不渲染、gateway 不可选、gateway 消费点守卫走 `voice_not_configured`；能力卡 `none` 态不给「重试/查网络」误导文案。

**零回归红线**（契约 §五）：存量 Edge 免费朗读用户、纯讯飞用户（未登录沉浸云）升级后第一天行为不变：默认值 edge 不变、xfyun 路径零改动、旧 ttsProvider="xfyun" 用户仅在迁移允许时升格 cloud（否则保留旧语义本地回落）。

### 1.6 相关 Windows 单测及其行为向量

运行方式（仓库根 `immersive-translator-windows/` 下）：`npx vitest run <file>`、`npx tsc --noEmit`（AGENTS.md 约定；本勘察为只读未执行）。

| 测试文件 | 关键行为向量 |
|---|---|
| `src/lib/settingsStore.voicePrefs.test.ts` | 任一凭据→xfyun（ASR-only 也算）；全空→gateway；已存值优先不探测；探测失败落 gateway；只合并三字段、不带出明文 apiKey、无效 JSON 抛错不写盘；即时保存立即可读回；整存不吞掉已存偏好；stripVoicePrefs 剔除后不点亮保存条 |
| `src/lib/voice/gatewayViewState.test.ts` | 封禁优先于一切；其余失败码归网络失败；loading/none/full/partial 三种缺失；常驻 remaining===0 判耗尽；402 事件别名（tts_chars→tts）并入且去重；状态行文案逐态断言；quotaLine 单位（字/秒/次）与 `—` 占位；resetsAt→`M 月 D 日重置`、非法 null；voiceErrorDisplayText 额度类拼重置/兜底指路、silent 返回空串 |
| `src/lib/voice/voiceRoute.test.ts` | 归约优先级逐态（未登录即使有能力仍 off；banned 与网络失败分开；voice 段缺失不给重试误导；配额常驻与事件别名两路；能力缺失三种；ise 本地开关；三项各验一次放行）；EDGE_FALLBACK_NOTICE 字面量断言；xfyun 不查登录/能力；gateway 未登录省一次 me/config；caps TTL 缓存、失败不缓存 |
| `src/lib/voice/voiceErrors.test.ts` | §二表逐行（silent/relogin/redeem/appeal 动作、final 切换、unauthorized 归一、token_reused 与 authErrorText 同文案）；quotaDetailsOf 防御（非法归 null）；功能名子集+兜底；文案不泄漏 message/HTTP 状态；非对象输入安全 |
| `src/lib/voice/voiceCapabilities.test.ts` | 完整 voice 段透传；缺段 available=false；quota 别名归一；异常条目逐条过滤（label 缺失回落 id）；getVoiceCapabilities 走 auth_fetch_server_config；AuthError 原样抛 |
| `src/lib/voice/voiceAsr.test.ts` | 退避曲线 1s×2 封顶 15s；建连 URL 带 ticket+lang、open 后发 start；48k 先重采样；final 后同连接续会话不再换票；重复 start 幂等；换 lang 重建；start 前缓冲重放；1006 断开新票新连接重发 start+重放；连续 7 次断开终局；取票失败并入退避不终局；握手失败换票重试一次、再败终局；error 帧逐码（quota 功能名/60 秒/upstream 不自动重放） |
| `src/lib/voice/voiceTts.test.ts` | 短文本 synthesis 帧（缺省 voice/volume 不上行）→binary→end→onEnd 一次；voice/volume 随帧；超长按句拆分片序上行、onEnd 恰一次；quota error 不重试；upstream 重试 1 次（换票重建、已 end 片不重放）；重试仍败终局；看门狗超时；排队按序；空文本不建连 |
| `src/lib/voice/voiceRest.test.ts` | 请求体形状；402 details.resource 进文案+头补 remaining；401 文案；429 retryAfter 透传；非 JSON 按状态兜底不透传 body；ise 评分原形状；ise_disabled silent/banned appeal；异常 words 过滤 |
| `src/lib/voice/voiceTicket.test.ts` | 并发 acquire 至多一张在途、各得新票；串行每次新票；失败不毒化队列 |
| `src/lib/voice/resample.test.ts` | 量化典型值/钳制；base64 RFC 4648 向量+跨边界还原；48k/44.1k→16k 数值；16k 直通；Int16 小端字节序 |
| `src/lib/voice/ttsTextSplit.test.ts` | 短文本单片；纯空白空数组；句界贪心打包 join 还原；中文 3 字节不超限；无标点码点硬切不腰斩代理对；换行句界、连续终结符归前句；自定义上限 |
| `src/lib/voice/voiceRuntimeIpc.test.ts` | 未接线抛编程错误不发 IPC；接线后逐参透传+应答原样带回；无 body 落 null |
| `src/core/readerTypes.test.ts:111-124` | 仅旧值 xfyun 参与迁移；允许时升格 cloud、不允许保留（不串 Edge）；edge/local/cloud 永不改写 |
| `src/reader/readerSettingsStore.test.ts` | 任一凭据或已登录→允许；无且未登录→不迁移；探测失败按无 |
| `src/reader/readerSpeechRoute.test.ts` | edge/local 直达；旧 xfyun 有凭据走讯飞无凭据回落本地（不经新守卫）；cloud+gateway 守卫过→网关引擎；cloud+xfyun→讯飞/本地零改动；cloud 守卫不过→静默 Edge+回落决策；回落文案非配额无动作位、配额带重置+redeem |
| `src-tauri/src/voice.rs` tests | 白名单放行已知路径/大小写归一；非 GET/POST 拒（`voice_request_invalid`）；`/v1/voice/` 前缀外/穿越/相对路径全拒 |
| `src-tauri/src/auth.rs` tests（4d48d85 增） | `quota_header_whitelist_only_passes_x_quota`：仅 `x-quota-*` 透传，retry-after/x-internal 不外漏 |

---

## 二、Mac 落点设计

### 2.1 应新建 / 修改的 Mac 文件清单

**新建 `Sources/ImmersiveTranslator/VoiceGateway/` 模块目录**（同 target 内新目录，对齐 Windows `src/lib/voice/` 一文件一责；Mac 无 IPC 层，运行时注入退化为主进程内直接依赖，测试用协议注入）：

| 新文件 | 对应 Windows | 职责 |
|---|---|---|
| `VoiceErrors.swift` | `voiceErrors.ts` | `VoiceError`（code/details/retryAfterSeconds）+ `voiceErrorMessage`（§二全表逐字）+ `quotaDetailsOf`/`quotaFeatureLabel`/`voiceErrorDisplayText` |
| `VoiceCapabilities.swift` | `voiceCapabilities.ts` | `VoiceCapabilities` 解析（容错+quota 别名）+ `getVoiceCapabilities()`（经 `ServerAuthClient.fetchServerConfig()`，见 ServerAuth.swift:693-703——不再新开传输） |
| `VoiceHttp.swift` | `voiceHttp.ts` + `voice.rs` 白名单 | `voiceRequest(method, path, bodyJson)`：调 `AuthTokenManager.withAuth`（ServerAuth.swift:486-533，401 单飞刷新重放已在内）+ method/path 白名单校验（对齐 voice.rs:49-64，本地伪码 `voice_request_invalid`）+ 错误信封解析/状态兜底/x-quota 头补 remaining + `buildWsUrl`（base `http→ws`，取自 `ServerAuthConfiguration.resolveBaseURL()`） |
| `VoiceTicket.swift` | `voiceTicket.ts` | 串行链 TicketManager（并发排队各领新票、失败不毒化）+ `fetchVoiceTicket()`（POST /v1/voice/ticket） |
| `VoiceRest.swift` | `voiceRest.ts` | `transcribeBatch(lang, pcmBase64)` / `evaluatePronunciation(refText, lang, pcmBase64)`（结果归一成 XfyunCore 既有 PronunciationResult 形状；integrity 兜底 5） |
| `VoiceAsrStream.swift` | `voiceAsr.ts` | `AsrStreamSession` 状态机（actor 或 final class + 串行队列）：start/stop 帧、binary 帧 ≤128KB、退避 1s×2 封顶 15s×6 次、握手失败换票重试一次、断线缓冲重放、final 后同连接续会话；WebSocket 用 `URLSessionWebSocketTask`（原生，无第三方依赖） |
| `VoiceTts.swift` | `voiceTts.ts` | `synthesize(text, voice, volume, onChunk, onEnd, onError)`：串行队列、>8000 字节拆分、看门狗 30s、可重试码重试 1 次（换票重建、已 end 片不重放） |
| `TtsTextSplit.swift` | `ttsTextSplit.ts` | `TTS_MAX_TEXT_BYTES=8000`/`TTS_SPLIT_MAX_BYTES=7900`、句终结符集合、码点硬切 |
| `Pcm16k.swift` | `resample.ts` | Float→Int16 对称量化、base64、16k 直通（Mac `MicRecorder` 已内建 16k 重采样（MicRecorder.swift:65 targetFormat 16_000 Float32），故只需量化+base64，无 44.1k/48k 线性插值分支——保留防御性直通断言） |
| `VoiceRoute.swift` | `voiceRoute.ts` | `reduceVoiceRoute`（纯函数）+ `resolveVoiceRoute`（async：读 voicePrefs→非 gateway 直放行；登录态现查 `ServerAuthClient.status`；caps 30s TTL）+ `EDGE_FALLBACK_NOTICE` |
| `GatewayViewState.swift` | `gatewayViewState.ts` | `reduceVoiceGatewayView` + `voiceGatewayStatusLine` + `quotaLine`/`quotaResetText` + 能力名常量 |
| `GatewayVoiceSection.swift` | `GatewayVoiceSection.tsx` | SwiftUI 右列云模式面板（账号卡/能力卡/一键测试三行灯） |
| `VoiceSettingsTab.swift` | `VoiceSettingsTab.tsx` | 语音 tab 双栏（左列 provider 选择、右列切换 Gateway/Xfyun） |
| `Resources/voice/ise-test-sample.pcm` | `src/assets/voice/ise-test-sample.pcm` | **字节级复用同一文件**（54240 字节，16k/16bit/mono；SwiftPM `.process("Resources")` 已有，Package.swift:19-21） |

**修改既有文件**（附证据行号）：

| Mac 文件 | 现状锚点 | 改动 |
|---|---|---|
| `Sources/ImmersiveTranslator/ServerAuth.swift` | `AuthHttpResponse` 只有 status/retryAfterSeconds/body（ServerAuth.swift:86-90）；`URLSessionAuthTransport.send`（:128-172）不收 headers | 增 `headers: [String: String]`（只收 `x-quota-*` 白名单小写键，对齐 Rust `whitelist_quota_headers`；默认 `[:]` 保持既有构造兼容）。withAuth/刷新管线**零改动**（红线：复用既有令牌存取与串行单飞） |
| `Sources/ImmersiveTranslator/Settings.swift` | `SettingsStore` UserDefaults didSet 模式（:7-73）+ `Keys`（:330-346）；语音分区只渲染 `XfyunVoiceSettingsSection()`（:1437-1439）；voice 页副标题单栏文案（:888-889）；保存条快照（:919-962） | 增三个即时保存字段 `voiceProvider`/`voiceGatewayVoice`/`voiceGatewayIseEnabled`（各自 didSet 直写 UserDefaults，不进 `SettingsSaveSnapshot`——对齐 Windows stripVoicePrefs 不点亮保存条）；语音分区改挂 `VoiceSettingsTab`（双栏），副标题换成双态文案（见 1.2）；XfyunVoiceSettingsSection 原样保留作右列讯飞面板 |
| `Sources/ImmersiveTranslator/Settings.swift`（登录自动切云） | 设置窗口持有 `serverAuth`（:991） | `SettingsView.onChange(of: serverAuth.status.loggedIn)` 做 false→true 边沿（对齐 Settings.tsx:176-185）：已是 gateway 无感；否则写 `voiceProvider=gateway` + 顶部绿色提示条 4s（文案 1.2 逐字）。启动 bootstrap 的 null→true 不算登录瞬间（对齐 Windows 注释语义） |
| `Sources/ImmersiveTranslator/App.swift` | `serverAuth = ServerAuthClient()`（:226）、`serverAuth.bootstrap()`（:342） | 自动切云的**兜底接线**：AppDelegate 观察 `serverAuth.status` 边沿，设置窗口从未打开时也落盘切 gateway（Windows 依赖设置窗口 hide 不销毁常驻，Mac 窗口可关闭；App 层观察覆盖同一用户可见结果，见 §四差异 6） |
| `Sources/ImmersiveTranslator/LiveCaptionController.swift` | 固定讯飞：`hasCredentials`（:28-30）、开麦守卫文案（:49-53）、逐句 `XfyunCredentialsStore.creds(.asr)`+`transcribeSpeech`（:113-126） | 增 `routeRef`（开麦定格 `resolveVoiceRoute("asr", asrLang:)`，整场共用）；off→`errorMessage = hint` 不开麦；gateway→逐句 `VoiceGateway.transcribeBatch`（MicRecorder 输出已 16k Float32，直接量化+base64），错误走 `voiceErrorDisplayText`；xfyun 分支零改动 |
| `Sources/ReaderCore/ReaderSettings.swift` | `TtsProvider` 仅 local/xfyun/edge（:465-479）、字段（:509）、默认 `.edge`（:559）、merge/diff（:757,799,839） | 枚举增 `case cloud`（label「云音色」）+ 迁移谓词 `shouldMigrateLegacyTtsProvider(_:hasAnyXfyunCredential:loggedIn:)` / `migrateLegacyTtsProviderValue`（纯函数放 ReaderCore，对齐 readerTypes.ts:338-351：仅旧值 xfyun 参与；edge/local/cloud 永不改写） |
| `Sources/ImmersiveTranslator/ReaderViewModel.swift` | `effectiveSettings.ttsProvider` 消费点（:390 领读、playback） | 增启动迁移判定（对齐 readerSettingsStore.ts:47-61：任一讯飞凭据或已登录→允许；探测失败按无），`loadGlobalReaderSettings` 后应用迁移并回写 |
| `Sources/ImmersiveTranslator/ReaderPlaybackEngine.swift` | 路由 `switch settings.ttsProvider` 仅 xfyun(isReady)/edge/default 本地（:192-211）；`speakCloud` 双引擎+本地回落（:213-261） | 增 `cloud` 分支：路由决策（对齐 routeReaderSpeech：cloud→resolveVoiceRoute("tts")；gateway→网关流式；守卫 off→Edge+回落提示；xfyun→存量）；网关引擎 = `VoiceTts.synthesize` 流式 mp3 分片（播放见 §四差异 5）；配额耗尽同句转 Edge+后续直 Edge+toast（对齐 ReaderApp.tsx:511-531） |
| `Sources/ImmersiveTranslator/ReaderViews.swift` | 朗读引擎 Picker 遍历 `TtsProvider.allCases`（:3196-3207）+ xfyun/edge 分支行（:3208-3246） | 档位自动含 cloud（label 云音色）；旧 xfyun 值 UI 并入云音色档（对齐 SettingsDrawer.tsx:446-447）；cloud 分支行：gateway→音色来源行+「去语音页配置」按钮（打开设置语音 tab），xfyun→存量 vcn 两输入+凭据状态（对齐 SettingsDrawer.tsx:509-611 文案逐字） |
| `Sources/ImmersiveTranslator/SettingsStore`（同 Settings.swift） | Keys 枚举（:330-346） | 增 `voiceProvider`/`voiceGatewayVoice`/`voiceGatewayIseEnabled` 三个 UserDefaults 键 |
| 兑换码卡 | Mac 账号分区现无 RedeemCard（AccountSectionView，Settings.swift:1447） | 若 Mac 已有沉浸云账号分区：新增 RedeemCard 同构（`id` 锚点→SwiftUI 用 `.accessibilityIdentifier("account-redeem")` + 滚动定位；错误文案逐字，POST /v1/redeem 经 withAuth）。「兑换更多额度」跳转：Mac 设置窗口单级导航——切到账号分区并滚动到兑换卡（对齐 Settings.tsx:284-292 语义）。若 Mac 尚未接入账号区兑换码（本次勘察未见），此项作为依赖项标注，不阻塞语音主链路 |

### 2.2 与 Mac 既有架构的衔接

- **鉴权（复用，禁另起炉灶）**：REST 全部经 `AuthTokenManager.withAuth`（ServerAuth.swift:486-533）——base URL 解析（`ServerAuthConfiguration.resolveBaseURL`）、Bearer 附带、401 `token_expired` 单飞刷新重放一次已内建；`token_invalid/reused/unauthorized` 清凭据不重刷。令牌在 Keychain（`KeychainAuthTokenStore`），永不出进程——对齐 Windows「token 永不跨 IPC」红线。**须补**：`AuthHttpResponse.headers`（x-quota-* 白名单，见上表）。登录态读取：`ServerAuthClient.status`（@Published，MainActor，ServerAuth.swift:913-915），消费点现查（内存态优先）——对齐 Windows `authGetStatus` 每次现查。
- **能力下发**：`ServerAuthClient.fetchServerConfig()`（:1021-1035，GET /v1/me/config 并落盘 server_config.json）→ `VoiceCapabilities.parse`（只取 voice 段）。语音页登录后拉一次、重试/重登由 status 变化驱动（对齐 VoiceSettingsTab.tsx:124-147）。
- **WebSocket**：`URLSessionWebSocketTask`（原生）。binary 帧用 `.data`；WSS 不能带自定义头 → ticket 进 query（同 Windows）。`WsLike` 注入面用 Swift 协议 `VoiceWebSocket`（`send/onMessage/onClose` 闭包），测试注入假实现——对齐 Windows `voiceRuntime.wsFactory` 注入模式（voiceRuntime.ts:43-58）。
- **存储**：voicePrefs 走 `SettingsStore` 的 UserDefaults didSet 既有模式（Settings.swift:7-73）；不进 `SettingsSaveSnapshot`（:919-962，对齐 stripVoicePrefs）。讯飞凭据存在性（迁移推断）读 `XfyunCredentialsStore`（XfyunCredentialsStore.swift:94-115——注意 Mac 侧 `creds(for:)` 对 asr 有「回落 ise 主凭据」语义，存在性判定需按三槽位各自 isComplete，对齐 `xfyunCredentialPresence` 语义）。
- **阅读室全局设置**：`ReaderStore.loadGlobalReaderSettings/saveGlobalReaderSettings`（ReaderStore.swift:391-400）——迁移在这里落地；文章级覆盖经既有 merge/patch 通道（ReaderSettings.swift:757,799）。
- **朗读播放层**：`ReaderPlaybackEngine.speakCloud`（:213-261）已有「云合成→AVAudioPlayer 变速播放→失败回落本地+归因」骨架，网关引擎作为第三个 `CloudEngine` case 接入；gen/epoch 语义不变（epoch 守卫已有）。
- **口语/跟读外围消费点**：Windows 侧 SpeakView/ShadowDrill/useShadowAssess/ReviewView/PracticeRelayView/speakUi 也已接网关（`grep` 实证，属其它批次），本规格主轴不含；Mac 对应 `ShadowAssessController`/`SpeakViewController` 等维持讯飞路径不动（零回归），网关化留待同构后续批次（消费范式与 LiveCaption 相同：route 定格 + voiceErrorDisplayText 收口）。
- **测试样本**：`Resources/voice/ise-test-sample.pcm` 经 Bundle resource 读取，懒加载缓存 base64（对齐 GatewayVoiceSection.tsx:58-67）。

### 2.3 需补的 Swift 测试清单（与 Windows 单测行为向量对齐）

放 `Tests/ImmersiveTranslatorTests/`（网关客户端纯逻辑）与 `Tests/ReaderCoreTests/`（迁移谓词）：

1. `VoiceErrorsTests`：§二表逐行（kind/action/retryable、final 切换、unauthorized 归一、token_reused 文案与 Mac `authErrorText` 表 token_reused 同文——ServerAuth.swift:766）；quotaDetailsOf 防御；功能名映射+兜底；文案不泄漏 message/状态码。
2. `VoiceCapabilitiesTests`：完整段透传/缺段 available=false/quota 别名归一/异常条目过滤（label 缺失回落 id）。
3. `VoiceRouteTests`：归约优先级逐态+文案字面量；xfyun 不查登录与能力；gateway 未登录省一次 me/config；caps TTL 命中与失败不缓存；EDGE_FALLBACK_NOTICE 字面量。
4. `GatewayViewStateTests`：相位归约、配额双来源（常驻+事件别名去重）、状态行逐态文案、quotaLine 单位与 `—`、resetsAt 格式化、voiceErrorDisplayText 额度拼重置/兜底指路。
5. `VoiceTicketTests`：并发排队各得新票/至多一张在途/失败不毒化。
6. `TtsTextSplitTests`：短文本单片/空白空数组/句界贪心 join 还原/中文 3 字节/码点硬切不腰斩 emoji/换行句界与连续终结符/自定义上限。
7. `Pcm16kTests`：量化典型值（0/±1/四舍五入/钳制）、base64 RFC 4648 向量、16k Float32 直通。
8. `VoiceRestTests`（假传输）：请求体形状；402 信封+头补 remaining；429 retryAfter 透传；非 JSON 状态兜底；ise 评分形状与异常 words 过滤；ise_disabled silent。
9. `VoiceAsrStreamTests`（假 WS+假票）：建连 URL 带 ticket+lang、open 后 start；final 后同连接续会话不再换票；重复 start 幂等；断线退避曲线与终局（注入假时钟/退避）；握手失败换票重试一次再败终局；error 帧逐码；缓冲重放。
10. `VoiceTtsTests`：短文本帧序（缺省 voice/volume 不上行）→end→onEnd 一次；超长拆分片序、onEnd 恰一次；upstream 重试 1 次换票重建、已 end 片不重放；看门狗超时（注入短 timeout）；排队按序；空文本不建连。
11. `VoiceHttpTests`：白名单（非 GET/POST 拒、`/v1/voice/` 外/`..` 拒）；信封解析与状态兜底；x-quota-* 头收集白名单（对齐 Rust `quota_header_whitelist_only_passes_x_quota`：retry-after/x-internal 不外漏）；buildWsUrl http→ws。
12. `ReaderCoreTests` 增（并入 `ReaderSettingsEdgeTests.swift` 或新文件）：迁移谓词——仅旧值 xfyun 参与；允许→cloud、不允许保留 xfyun；edge/local/cloud 永不改写。
13. `ReaderSpeechRouteTests`（ReaderCore 放纯路由、ImmersiveTranslatorTests 放取数）：cloud+gateway 守卫过→网关；cloud+xfyun→讯飞/本地；守卫 off→静默 Edge+回落决策；非配额回落文案无动作位、配额带重置+redeem；旧 xfyun 不经新守卫。
14. `VoicePrefsTests`（UserDefaults 注入临时 suite）：迁移推断（任一凭据→xfyun、全空→gateway、探测失败落 gateway）；即时写盘立即可读回；不点亮保存条（快照不含三字段）。
15. `LiveCaptionRouteTests`：开麦定格整场共用；off 不开麦给 hint；gateway 逐句 transcribeBatch 错误文案映射；xfyun 零改动回归。

---

## 三、逐条验收清单（1:1 保真检查点）

**契约与协议**
1. Mac 语音 REST 只经 `AuthTokenManager.withAuth`（Bearer+401 单飞刷新重放一次），不另写令牌逻辑、不直连讯飞上游做云模式请求；`token_invalid/reused/unauthorized` 清凭据不重刷（对照 ServerAuth.swift:486-533 既有行为）。
2. 端点/方法/请求/应答字段与 §1.4 表逐项一致：ticket `{ticket,expiresAt}`；asr `{lang,audio}`→`{text,durationMs}`；ise `{refText,lang,audio}`→5 分制（integrity 客户端兜底 5）；WSS 路径与 query（`?ticket=&lang=` / `?ticket=`）一致。
3. WSS 上行帧协议一致：ASR binary 16k/16bit/mono（单帧 ≤128KB）+ `{"type":"start"|"stop"}`；TTS 只有 `{"type":"synthesis","text","voice"?,"volume"?}`、绝不发 binary。
4. ticket 现调现用：每次建连（含重连）前新取、不缓存复用、拿票到握手无长耗时操作；并发建连串行排队各领新票。
5. TTS 文本拆分上限 7900 字节（8000−100），按句拆+码点硬切，join 可还原原文，任何片不超服务端 8000 红线。
6. 错误信封 `{error:{code,message,details?}}` 解析；信封缺失按状态兜底（401/402/429/5xx/unknown）；402 时 `x-quota-<resource>-remaining` 头补进 details；429 retry-after 透传；`x-quota-*` 之外响应头不出传输层。
7. 错误文案表 §1.2 逐字复刻（含 `请稍后再试`/`连接不稳定，正在重试…` 等 final 切换两态）；功能名插值映射一致；文案无 HTTP 状态码/协议术语/实现说明；不透传服务端 message。

**守卫与路由**
8. `reduceVoiceRoute` 优先级链八态逐字对齐（未登录>封禁>能力不可用>未开通>配额耗尽>ISE 本地开关>能力缺失>放行），hint 文案逐字一致。
9. provider=xfyun 消费点不经守卫、不查登录态与能力（存量讯飞零回归）；provider 读取失败按 xfyun 兜底。
10. gateway 侧 caps 30s TTL 缓存、失败不缓存；未登录不拉 me/config。
11. 实时字幕：开麦那一刻定格路由整场共用；off 给引导不开麦；gateway 逐句 REST 转写 + `voiceErrorDisplayText` 错误文案；讯飞分支行为与文案零改动。
12. 朗读：cloud 档跟随语音页 voiceProvider（gateway→网关流式 TTS、音色默认语音页所选、抽屉不重复配置；xfyun→存量讯飞路径零改动）；edge/本地引擎不变。
13. 守卫不过时朗读**静默回落 Edge**，提示 `已临时使用 Edge 朗读…`，不弹登录墙、不中断阅读；配额耗尽 toast 带重置时间与「兑换更多额度」动作；运行时 402 同句转 Edge、后续句直 Edge。
14. 旧 `ttsProvider="xfyun"` 迁移：任一讯飞凭据存在或已登录→升格 cloud；否则保留旧 xfyun（缺凭据→本地回落，不串 Edge）；edge/local/cloud 永不被改写；默认值仍 edge。

**UI 与文案**
15. 语音设置页双栏同构：左列「官方云服务」（沉浸云大卡+官方/推荐 chip）与「自带凭据 · 高级」（讯飞行+keydot）；右列随选中切换；点卡即时保存、不点亮保存条；页头双态副标题逐字。
16. 沉浸云卡状态行 8 态文案逐字（未登录/封禁/网络失败/未开通/partial/loading/full/额度用尽）。
17. GatewayVoiceSection 全部卡片与行文案逐字（账号卡、网络失败卡、封禁卡、能力卡五相位 chip+hint、音色/语种/跟读开关/额度行、一键测试三行灯及汇总条）。
18. 登录成功瞬间（false→true 边沿，bootstrap 静默续登录不算）自动切 gateway + 4s 绿色轻提示逐字；已是 gateway 无感；讯飞凭据保留可切回。
19. 迁移推断：任一讯飞凭据槽位存在→默认 xfyun；全空→gateway；推断值只展示不落盘。
20. 阅读抽屉三档「Edge 在线/云音色/系统语音」；云音色 gateway 行（音色来源/服务说明/去语音页配置）与 xfyun 行（vcn 两输入+凭据状态）文案逐字；旧 xfyun 值在云音色档高亮。
21. 一键测试：打包样本（同一 54240 字节 pcm、参考文本 "The quick brown fox jumps over the lazy dog."、TTS 探测句 "Hello."）；三行灯文案/成功/失败文案逐字；ISE 探测耗 1 次额度如实提示。
21b. 配额 UI：常驻余量条 `朗读 N 字 · 识别 N 秒 · 跟读 N 次`（`—` 占位）+ `N 月 N 日重置`；未下发时 402 事件式兜底（耗尽态+兑换入口）。
22. 兑换入口：额度耗尽的「兑换更多额度」→ 账号分区兑换码卡（滚动+聚焦）；兑换错误四文案逐字。（依赖：Mac 账号分区 RedeemCard，见 §2.1 末行）

**行为边界**
23. 录音不落盘缓存：重采样/缓冲仅在内存；REST 转写/评测失败不自动重试（与 TTS 重试一次刻意不同）。
24. 零回归：升级后第一天，Edge 默认用户、纯讯飞用户（未登录）、旧 xfyun 朗读用户行为与文案不变。
25. 新代码过 `swift test`（§2.3 全部用例）与既有套件全绿；纯逻辑（错误表/路由归约/状态机/拆分/量化/迁移谓词）单测覆盖与 Windows 行为向量一一对应。

---

## 四、平台差异清单（仅平台必然差异）

1. **传输通道无 IPC**：Windows 是 WebView2→Rust `voice_http_request` IPC（令牌在 Rust、永不跨 IPC）；Mac 单进程，`VoiceHttp` 直接进程内调 `AuthTokenManager.withAuth`。**语义等价**：鉴权管线（单飞刷新/重放/白名单头）逐项保留；差异仅在「IPC 边界」这一实现形态，Rust 白名单校验在 Mac 以同规则本地校验复刻。
2. **`AuthHttpResponse` 需补 headers 字段**：Windows 语音批次给 Rust 应答结构加了 `x-quota-*` 白名单头；Mac 既有 `AuthHttpResponse`（ServerAuth.swift:86-90）无 headers，本批次为 Mac 传输层补齐同白名单（其余头一律不透传）。这是对齐 Windows 行为的必要增量，不是行为差异。
3. **流式 mp3 播放引擎**：Windows WebView2 有 `MediaSource`（MSE）→ 首片 append 即播、兜底收齐 Blob；macOS 无 MSE。等价落法：`AVSampleBufferAudioRenderer`（或 `AVQueuePlayer`+逐片 appendable）实现首片即播，兜底路径=Windows 的 buffered 模式（收齐成 Data 再播，`speechEngine.ts:271-288` 同构）。**用户可见行为（首片即播、分片按序、打断/变速）必须一致**，仅渲染 API 不同。
4. **WebSocket 实现**：Windows 浏览器原生 `WebSocket`；Mac `URLSessionWebSocketTask`。帧语义（text/binary、close code 1006 判意外断开→重连退避）对齐；ping/pong 由 URLSession 自动应答（对齐「标准 WS 自动 pong」契约）。
5. **音频采集**：Windows `micRecorder` 设备采样率 44.1k/48k，客户端线性插值重采样（`resample.ts`）；Mac `MicRecorder` 目标格式已 16k/1ch Float32（MicRecorder.swift:65），量化层直通。数值口径一致（16k/16bit/mono 上行），差异仅在重采样发生的位置。
6. **登录自动切云的观察点**：Windows 设置窗口 hide 不销毁、组件常驻，边沿检测在设置窗口 React 层（Settings.tsx:176-185）；Mac 设置窗口可被关闭销毁。落法：边沿检测放 AppDelegate 观察 `serverAuth.status`（App.swift:226/342 已有实例），设置窗口打开时 UI 读已落盘 voiceProvider 自然跟随。结果对齐（登录后语音页选中态已切沉浸云），且覆盖 Windows 依赖窗口常驻的窄缝（从未打开过设置窗口的存量讯飞用户）——超集保真，非行为差异。
7. **`platformBase`「官方云未开放」态**：Windows `authServerBaseUrl()` 可返回 null（服务端未公开部署且无 server_endpoint.json）→ 官方分组整体隐藏；Mac `ServerAuthConfiguration.resolveBaseURL()` 恒返回值（dev 缺省 `http://127.0.0.1:8090`，ServerAuth.swift:101,113-124），无 null 态。Mac 落法：保留恒开放渲染；`voice_not_configured`/`none` 态文案与 Windows 逐字一致，守卫行为一致（连接失败落 caps_unavailable/voice_not_configured 分支）。若产品要求隐藏态，需先改 Mac ServerAuth 的 base 解析语义——超出本批次，标注为遗留决策。
8. **DPAPI → Keychain**：讯飞凭据加密存储 Windows 用 DPAPI、Mac 用 Keychain（既有事实，XfyunCredentialsStore.swift）；keydot 提示文案 Mac 侧相应为 Keychain 表述（Windows 文案含「DPAPI 加密」字样处，Mac 对应「Keychain」，与 Mac 语音页既有副标题「经 Keychain 加密存储」同口径，Settings.swift:889）。
9. **SAPI → AVSpeechSynthesizer**：「系统语音」本地引擎平台各自原生（Windows SAPI tts.rs / Mac AVSpeechSynthesizer，ReaderPlaybackEngine.swift:168 既有），本批次不改其行为。
10. **UI 控件形态**：segmented Picker / Picker 代替 HTML `<select>`/seg 按钮、SwiftUI Toggle 代替 switch button——视觉控件按 Mac 既有 SwiftUI 风格，**文案与状态语义逐字逐态一致**。
11. **服务端仓库缺失**：本规格的端点契约来自契约文档与 Windows 客户端实现（`immersive-translator-server/` 未检出）。若服务端实际字段与两者有出入，以真实联调为准并回填本规格——非平台差异，为勘察边界如实声明。

其余一切（路由优先级、文案、配额口径、重试/退避参数、存储字段、迁移谓词、测试行为向量）**一律不许差异**。

---

## 附录 A：跨窗口语音设置事件契约（2026-11-12 增补）

Windows 端 2026-11 语音设置合并（设计 `docs/voice-settings-merge-plan-2026-11-11.md`）新增了跨窗口通知层：语音偏好（voiceProvider / voiceGatewayVoice / voiceGatewayIseEnabled）写盘后广播 `voice:prefs-changed`，另一窗口订阅后**重读存储**刷新界面——只补通知，不改本规格的任何写点、文案与行为（上面验收清单 20 的逐字文案不因此变动，新增的只有行内状态行）。诚实边界（契约 §3）：阅读室自己写 L1 全局键走 ReaderApp 既有「全局 + 文章覆盖」双写路径，**不经 hub、不发事件**（`readerVoice` scope 仅第三窗启用 `writeReaderVoice` 后才会出现，Windows 现未接线）；Mac 复刻时二选一——维持「L1 唯一写点不发事件」或把写路径统一收进 hub，**不允许出现「既直写又广播」的双路径**。

**Mac 复刻语音页/阅读室联动时，事件契约按 `docs/voice-prefs-changed-contract-2026-11-12.md` 对齐**（跨端共同契约）：payload 只带 `{ scopes, from, rev }` 不带值；回执方一律重读存储；`from` 等于自身则忽略回声；`rev` 按发送方分桶单调防乱序；新增语音字段必须进 hub 写 API 并登记 scope；讯飞凭据继续走既有 `xfyun:creds-updated`，不并入本事件。实现参照 Windows `src/lib/voiceSettingsHub.ts`（写 API / 订阅 / 打分链与链路投影）。
