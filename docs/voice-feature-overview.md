# 语音功能总览（Windows 端）

> 整理日期：2026-09-23 · 范围：immersive-translator-windows（主桌面端）全部语音能力，含代码地图、数据流与规划索引
> 语音能力 = **TTS 朗读**（Edge / 讯飞 / SAPI 三引擎）+ **语音识别**（讯飞 IAT）+ **发音评测**（讯飞 ISE）+ **口语陪练** + **录音直译**（实时字幕）。Mac 端暂无语音代码；移动端仅有 Web Speech TTS（见 §10）。

---

## 0. 能力速览

| 能力 | 用户看到的东西 | 底层服务 | 默认状态 | 核心代码 |
|---|---|---|---|---|
| TTS 朗读 | 阅读室逐句连播、点句朗读、查词发音、浮窗朗读 | Edge 在线合成（默认）/ 讯飞 TTS / Windows SAPI | Edge，免凭据开箱即用 | `speechEngine.ts` + `edgeTts.ts` / `xfyunTts.ts` / `tts.rs` |
| 语音识别 ASR | 口语陪练"按住说话"、录音直译 | 讯飞 IAT 流式听写（WebSocket） | 需配置讯飞凭据 | `xfyunAsr.ts` |
| 发音评测 ISE | 跟读打分、多维报告卡、差词专练 | 讯飞 ISE（WebSocket） | 需配置讯飞凭据 | `pronunciation.ts` |
| 口语陪练 | 按住说英语 → AI 场景回复 → 播报 → 跟读打分 | IAT + LLM + TTS + ISE 组合 | 需凭据 | `SpeakView.tsx` + `speakLogic.ts` |
| 录音直译 | 托盘入口的实时双语字幕窗口 | 麦克风 + IAT + LLM | 需凭据 | `LiveCaptionApp.tsx` + `liveCaption.ts` |
| 跟读模式 | 句子读完自动开麦跟读、达标自动下一句 | TTS + 麦克风 + ISE | 阅读室内开关 | `useShadowAssess.ts` |

---

## 1. TTS 朗读：三引擎架构

### 1.1 引擎抽象与调度

统一抽象层 `src/reader/speechEngine.ts`：

- `SpeechEngine` 接口：`speak / stopTrack / prefetch / onEnded`，用 **gen 代数** 语义处理打断（旧代数的回调/音频一律作废）。
- 三个引擎工厂：
  - `createSapiEngine()` —— 薄封装 Rust `tts.rs`（本地，离线兜底）；
  - `createXfyunEngine(getCfg)` —— 讯飞在线合成；
  - `createEdgeEngine(getCfg)` —— Edge 在线合成。
- `createCloudEngine(deps)`：讯飞与 Edge 共用的播放层。合成出 1× mp3 → 复用同一个 `<audio>` 用 `playbackRate` 变速（`preservesPitch=true`）。**语速变化不重新合成，缓存跨语速命中**；云引擎的 gen 从 1,000,000 起，与 SAPI 的 gen 空间隔离。
- 路由器 `createSpeechDispatcher(getActive)`：`ttsProvider === "edge"` → Edge；`"xfyun"` 且有凭据 → 讯飞；否则回落 SAPI。`stopTrack` 会停所有引擎，防止旧音频残留。

引擎选择在 `src/core/readerTypes.ts` 的 `ttsProvider: "edge" | "local" | "xfyun"`，**默认 `"edge"`**；切换入口在阅读室设置抽屉（三个按钮）。

### 1.2 Edge 在线合成（默认引擎，免费无凭据）

`src/core/edgeTts.ts` · `synthesizeEdgeTts(text, { voice })`

- **免凭据原理**：复用 Edge 浏览器「大声朗读」的端点 `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`，只用公开常量 `TrustedClientToken`；防滥用签名 **`Sec-MS-GEC = SHA-256 大写hex (filetime ticks 按 5 分钟窗口对齐 + TOKEN)`**（`secMsGec()` / `edgeTokenTicks()`，Web Crypto 实现）。
- **时钟偏差**：本机时间偏差 >5 分钟会 403。首次失败后用 voices 接口响应的 `Date` 头校准 skew（`calibrateClockSkew()`）再重试一次。握手 UA 依赖 WebView2 自带的 Edge UA，天然通过。
- 帧协议：`buildSpeechConfigMessage`（要求 mp3 输出）+ `buildSsmlMessage`（voice/prosody 恒 +0%）；解析二进制帧 `parseEdgeBinaryFrame`（2 字节大端头长 + `Path:audio` 净荷），收到 `Path:turn.end` 收尾。
- 音色：默认中文 `zh-CN-XiaoxiaoNeural`、英文 `en-US-AvaNeural`；`EDGE_TTS_VOICE_SUGGESTIONS` 提供 12 个建议音色（Ava / Andrew / 晓晓 / 云希…）；按句子语言自动选音色 `pickEdgeVoice()`。

### 1.3 讯飞在线合成

`src/core/xfyunTts.ts` · `synthesizeXfyunTts(text, { vcn, volume }, creds)`

- `wss://tts-api.xfyun.cn/v2/tts`，单帧请求（`buildTtsRequestFrame`：`aue:"lame", sfl:1, speed 恒 50`，文本 base64 < 8000 字节）；响应逐帧 base64 解码拼接（每帧自带 `=` padding，不能整体 atob）。
- 默认发音人：中文 `xiaoyan`、英文 `catherine`；`XFUYUN_TTS_VOICE_SUGGESTIONS` 6 个。
- 错误码表 `TTS_CODE_MESSAGES` / `friendlyTtsError`：10005 APPID 未授权、10109 文本超限、10163 会话错误、11200 发音人未授权、11201 每日 500 次用完、11202 频率超限、10313 APPID 与 Key 不匹配。

### 1.4 本地 SAPI（Windows 兜底，离线可用）

`src-tauri/src/tts.rs`

- Windows SAPI `ISpVoice`，COM STA 专用线程。
- **双音轨** `TtsTrack::Sentence / Word`：查词发音（word 轨）不打断句子朗读（sentence 轨）。
- 打断用 **gen 代数递增**；向前端发 `tts:ended` / `tts:boundary`（word/sentence 边界事件）。
- 语速 0.5–2.0 对数映射到 SAPI Rate -10..10（`map_rate`）；音色按中文 LCID 启发式选择 `pick_voice`。

### 1.5 缓存与语速策略

- 双层缓存：内存 LRU 80 条（各引擎内）+ IndexedDB 磁盘缓存 `src/core/ttsDiskCache.ts`（`diskCacheGet / diskCachePut / diskCacheTrim`）。
- 缓存 key 含引擎前缀（如 `edge:voice|text`），**语速不入 key**。
- 语速策略：合成恒 1×，播放端 `playbackRate` 变速——换语速零成本、缓存全命中。

---

## 2. 语音识别与发音评测（讯飞三件套）

### 2.1 统一鉴权（前端实现）

- `src/core/xfyunAuth.ts` · `buildXfyunAuthUrl(host, path, creds)`：HMAC-SHA256 签名（`host\ndate\nGET {path} HTTP/1.1` → base64 → authorization 再 base64）拼进 wss URL。**TTS / IAT / ISE 三个服务共用**；签名在前端而非 Rust。
- `explainXfyunClose()`：浏览器 WebSocket 拿不到 HTTP 401/403，握手失败统一表现为 **close code 1006**。该函数把 1006 翻译为三步排查清单（凭据 → 系统时间 → 代理）。
- 凭据模型 `src/lib/iseCredentials.ts`：一组**主凭据**（ISE）+ TTS / ASR 按服务覆盖（`xfyun_ise_app_id` / `xfyun_tts_*` / `xfyun_asr_*`），覆盖缺失时回落主凭据。加载函数：`loadIseCredentials / loadXfyunTtsCredentials / loadAsrCredentials`，来源标识 `xfyunTtsCredSource / asrCredSource`。
- 存储 `src-tauri/src/secret_store.rs`：`secret_get / secret_set / secret_exists`，Windows DPAPI（`CryptProtectData`）加密后存应用数据目录 JSON，按 name 区分。

### 2.2 讯飞 IAT 流式听写

`src/core/xfyunAsr.ts` · `transcribeSpeech(pcm16k, "en_us" | "zh_cn", creds)` → `wss://iat-api.xfyun.cn/v2/iat`

- business 带 `domain:"iat"`，**不能带 `sub` 字段**（多传报 10163，见 commit c60d818）。
- 首帧 `status=0`，音频 1280 字节/帧，结束帧 `status=2`；结果 `extractIatSegment`（`ws[].cw[0].w`）+ `mergeIatSegment`（按 sn 归并）。
- 错误码：10105 授权/未开通、10163 采样率非法、11200 未授权、11201 超限、10803 连接超时。

### 2.3 讯飞 ISE 发音评测

`src/core/pronunciation.ts` · `evaluateSentence(pcm16k, text, creds)` → `wss://ise-api.xfyun.cn/v2/open-ise`

- 首帧 ssb：`ent:"en_vip", category:"read_sentence"`；`business.text = '\uFEFF[content]\n' + 评测文本`（**明文，非 base64**）。音频 `aue=raw`，1280 字节/帧。
- 结果 XML 为 base64 分片 → `parseIseXml` 解析 5 分制 `total / accuracy / fluency / standard / integrity`，以及 `isRejected`、`exceptInfo`（"28673" 无语音、"28676" 乱读、"28680" 信噪比低）。
- 词级 `dp_message`：16 漏读 / 32 增读 / 64 回读 / 128 替换。
- `mapWordsToText()`：DP 最大匹配把识别词映射回原文字符区间，做四档着色（good / ok / bad / missed）。
- `isPass()`：未乱读且 total ≥ 阈值（默认 4.2，见 §6 设置）。

### 2.4 跟读评测状态机

`src/reader/useShadowAssess.ts` —— 跟读模式的完整循环：

1. 本句 TTS 读完（`tts:ended`）→ 自动开麦；
2. 底噪自适应 VAD（`SPEECH_FLOOR_RATIO 2.8`，8 秒无语音提前收，15 秒上限）；
3. 录音送 `evaluateSentence` → 讯飞 ISE；
4. 达标 650ms 后自动进下一句；不达标给「再试 / 领读 / 跳过」——领读为 0.72× 慢速 word 轨，播完自动重开麦。**永不卡死播放**。

### 2.5 跟读报告与差词专练

- `src/core/shadowDiagnose.ts` · `diagnoseShadow()`：pass / almost / fail 徽章、维度短板、差词/漏词点名，全部规则基于 ISE 返回，无额外请求；`phoneTip()` / `worstPhoneOf()` 音素级建议；`SHADOW_PASS_SCORE = 4.2`。
- `src/reader/ShadowReport.tsx`：多维报告卡 + 点词看音节/音素弹层 + 动作（听领读 / 听自己录音 / 只练差词）。
- `src/reader/ShadowDrill.tsx`：只练差词抽屉——单词逐个「领读 → 按住跟读 → 出分」（单次 8 秒上限）。

---

## 3. 口语陪练（SpeakView）

`src/reader/SpeakView.tsx`（阅读室 `view === "speak"` 路由）

- 交互闭环：**按住说话**（IAT，`en_us`）→ LLM 场景回复（`translate_stream` 流式）→ TTS 播报 → 每轮可跟读打分（ISE）。
- 纯逻辑与 prompt 在 `src/core/speakLogic.ts`：4 个场景 × 3 个难度、`parseAssistantReply`。
- 会话持久化：`src/lib/speakStore.ts` 前端封装 + Rust `src-tauri/src/speak_store.rs` 落盘 `reader_speak_sessions.json`（保留 50 个；`ShadowAttempt / ShadowWord / ShadowSyll / ShadowPhone` 结构与前端同构）。

---

## 4. 录音直译（实时字幕，live-caption）

- 窗口 UI：`src/livecaption/LiveCaptionApp.tsx` + `liveCaption.css`；入口在**托盘菜单**「录音直译」（`lib.rs` → `show_live_caption_window`，窗口崩溃自动重建），窗口 `always on top`。
- 纯逻辑层：`src/core/liveCaption.ts` · `LiveSegmenter` VAD 分句器（底噪自适应起声阈值、静音 900ms 收句、12 秒强制断句）；`buildCaptionMarkdown / PlainText` 双语导出。
- 链路：麦克风流式 onChunk → `LiveSegmenter` 收句 → `resamplePcmTo16k` → `transcribeSpeech`（IAT）→ `translate_stream` 句级翻译 → 双语滚动字幕。
- 测试：`src/core/liveCaption.test.ts`。

---

## 5. 麦克风采集

`src/core/micRecorder.ts`

- WebView `getUserMedia` → `AudioContext` 16kHz + `ScriptProcessor`，输出 16-bit PCM；支持流式 onChunk 与整段两种模式；设备枚举（配合设置里的麦克风选择）。
- 采样率不满足时线性插值重采样（`resamplePcmTo16k`）。
- 权限：`tauri.conf.json` 为窗口统一加了 `--auto-accept-camera-and-microphone-capture` 浏览器参数，免每次弹权限框。

---

## 6. 设置与凭据 UI

### 6.1 设置项

定义于 `src/core/readerTypes.ts`，持久化在 `src/reader/readerSettingsStore.ts`：

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `ttsProvider` | `"edge"` | 引擎：edge / xfyun / local(SAPI) |
| `edgeVoiceZh` / `edgeVoiceEn` | 晓晓 / Ava | Edge 中英音色 |
| `cloudVoice` / `cloudVoiceEn` | xiaoyan / catherine | 讯飞中英发音人 |
| `voice` | — | SAPI 音色名 |
| `rate` | 1.0 | 播放语速（0.5–2.0，播放端变速） |
| `shadowingMode` / `shadowingAssess` | 开 | 跟读模式 / 跟读打分开关 |
| `shadowingPassScore` | 4.2 | 过关阈值 |
| `shadowingAutoMic` | true | 读完自动开麦 |
| `shadowingSilenceMs` | 1500 | 静音断句时长 |
| 麦克风设备 | — | 存 `immersive-translator-mic-device` |

### 6.2 凭据与服务状态灯

`src/views/XfyunVoiceSection.tsx`（挂在主窗口 设置 → 语音）：

- 一组主凭据三件套（APPID / APIKey / APISecret）+ ISE / TTS / ASR 覆盖区。
- 每个服务一枚状态灯 `LightState("idle | testing | ok | bad")`；`testService()` 用 `buildXfyunAuthUrl` **真实发起 WS 握手探测**（ise→ise-api / tts→tts-api / asr→iat-api），失败按 `explainXfyunClose` 给 1006 排查文案；支持「一键测试三个服务」。
- 保存后 `emit("xfyun:creds-updated")`，常驻阅读室窗口监听并热刷新凭据。

### 6.3 阅读室内设置

`src/reader/SettingsDrawer.tsx`：引擎切换、中英音色（带 datalist 建议）、跟读各项参数，附跳转总设置链接。

---

## 7. Rust 侧命令与事件

注册于 `src-tauri/src/lib.rs` `invoke_handler`；前端桥接在 `src/lib/tauriBridge.ts`。

| command / event | 文件 | 功能 |
|---|---|---|
| `tts_speak` | `tts.rs` | 朗读文本；参数 text/chinese/track/rate/voice/target，返回 gen 代数 |
| `tts_stop` | `tts.rs` | 推进打断代数，截断指定音轨 |
| `tts_voices` | `tts.rs` | 枚举系统 SAPI 音色（name + 中文标记） |
| `tts:ended` / `tts:boundary` 事件 | `tts.rs` | 播放结束（gen+track 配对）/ 词句边界 |
| `speak_list_sessions` / `speak_save_session` / `speak_delete_session` | `speak_store.rs` | 口语陪练会话落盘 |
| `secret_get` / `secret_set` / `secret_exists` | `secret_store.rs` | DPAPI 命名 secret（讯飞凭据） |

> 注意：**讯飞 WebSocket 签名逻辑在前端**（`xfyunAuth.ts`），Rust 侧无签名代码。`probe_https` 命令用于诊断 HTTPS 连通性（1006 排查配套，commit b6dc089）。

---

## 8. 端到端数据流

```
【TTS 出声 · 云引擎】
PlayBar 播放(Space) → usePlayback.speakIdx → dispatcher → createCloudEngine.speak
  → synthesizeEdgeTts(前端WS, Sec-MS-GEC签名) / synthesizeXfyunTts(HMAC签名wss)
  → mp3 Blob → LRU + IndexedDB 缓存 → <audio> objectURL playbackRate 播放
  → onended(gen配对) → 推进下一句
【TTS 出声 · SAPI】tts_speak invoke → Rust STA 线程 ISpVoice → 轮询发 tts:ended

【跟读评测】句子朗读 ended → useShadowAssess.begin → startMicRecorder(16k PCM)
  → 电平 VAD 判静音 → evaluateSentence → 讯飞 ISE WS → XML 解析
  → 达标自动下一句 / 失败词着色 + 领读(0.72×)

【口语陪练】按住说话 → micRecorder 整段 → transcribeSpeech(IAT)
  → translate_stream(LLM 场景回复) → TTS 播报 → 可选跟读打分(ISE) → speak_store 落盘

【录音直译】麦克风流式 onChunk → LiveSegmenter(VAD收句) → resamplePcmTo16k
  → transcribeSpeech(IAT) → translate_stream → 双语字幕滚动 → 导出 markdown
```

---

## 9. UI 入口一览

| 位置 | 文件 | 语音交互 |
|---|---|---|
| 阅读室总装 | `src/reader/ReaderApp.tsx`（203–240 行装配三引擎） | 引擎装配、`xfyun:creds-updated` 热刷新、`speakWord`（0.72× word 轨）/ `speakSentence` |
| 播放条 | `src/reader/PlayBar.tsx` | 播放/暂停（**Space 快捷键**）、语速预设、跟读等待 UI（继续/领读/跳过） |
| 正文/词典/复习 | `ReadingView.tsx` / `DictColumn.tsx` / `ReviewView.tsx` / `VocabListPanel.tsx` | 点句朗读、查词发音按钮、复习读词读句 |
| 跟读报告 | `ShadowReport.tsx` / `ShadowDrill.tsx` | 报告卡、差词专练 |
| 口语陪练 | `SpeakView.tsx` | 按住说话对话练习 |
| 录音直译 | `src/livecaption/LiveCaptionApp.tsx` | 托盘入口、开始录音、方向切换 |
| 主窗口设置 | `src/views/Settings.tsx` → `XfyunVoiceSection.tsx` | 凭据、状态灯、一键测试 |
| 浮窗 | `src/views/TranslationPanel.tsx` | 翻译结果朗读（直接 `ttsSpeak/ttsStop`，走 SAPI） |
| 快速复习 | `src/quickreview/QuickReviewApp.tsx` | 单词发音（word 轨） |

---

## 10. 各端现状

- **Windows**（本文主体）：全部语音能力。
- **Mac**（`immersive-translator-mac/`）：无语音代码，待对齐。
- **移动端**（`immersive-translator-mobile/`）：仅 Web Speech API TTS——`src/store.ts`（`speak / stopSpeak / pickVoice`，onend 兜底计时器）、`ReaderScreen.tsx` 逐句连播、`MeScreen.tsx` TTS 自检；无 ASR、无原生桥。

---

## 11. 文件地图（语音相关全清单）

| 文件（相对 `immersive-translator-windows/`） | 角色 |
|---|---|
| `src/core/edgeTts.ts` | Edge 在线 TTS（默认；Sec-MS-GEC 签名、时钟校准） |
| `src/core/xfyunTts.ts` | 讯飞在线 TTS（wss、错误码表） |
| `src/core/xfyunAuth.ts` | 讯飞 HMAC 签名 + 1006 close 解释（三服务共用） |
| `src/core/xfyunAsr.ts` | 讯飞 IAT 听写（口语陪练/录音直译） |
| `src/core/pronunciation.ts` | 讯飞 ISE 评测 + XML 解析 + 词映射 + 过关判定 |
| `src/core/micRecorder.ts` | 麦克风采集（16k PCM、流式/整段、设备枚举） |
| `src/core/liveCaption.ts` | 录音直译逻辑层（LiveSegmenter VAD、导出） |
| `src/core/ttsDiskCache.ts` | TTS IndexedDB 磁盘缓存（L2） |
| `src/core/speakLogic.ts` | 口语陪练纯逻辑（场景/prompt/会话类型） |
| `src/core/shadowDiagnose.ts` | 跟读报告规则诊断（差词/音素建议） |
| `src/core/readerTypes.ts` | ttsProvider/音色/跟读设置项定义（默认 edge） |
| `src/reader/speechEngine.ts` | 引擎抽象 + 三引擎实现 + 调度器 |
| `src/reader/usePlayback.ts` | 逐句连播/预取/跟读等待 |
| `src/reader/useShadowAssess.ts` | 跟读评测状态机（录音/VAD/领读） |
| `src/reader/ReaderApp.tsx` | 阅读室总装（引擎装配、发音入口） |
| `src/reader/PlayBar.tsx` / `ReadingView.tsx` / `DictColumn.tsx` | 播放条（Space）、点句朗读、查词发音 |
| `src/reader/SettingsDrawer.tsx` | 引擎切换/音色/跟读设置 UI |
| `src/reader/SpeakView.tsx` / `ShadowReport.tsx` / `ShadowDrill.tsx` | 口语陪练 / 跟读报告卡 / 差词特练 |
| `src/lib/iseCredentials.ts` | 讯飞凭据模型（主 + TTS/ASR 覆盖，回落） |
| `src/lib/tauriBridge.ts` | ttsSpeak/ttsStop/ttsVoices/secret* 桥接 |
| `src/lib/speakStore.ts` | 口语陪练会话存取封装 |
| `src/views/XfyunVoiceSection.tsx` | 凭据 UI + 服务状态灯 + 一键测试 |
| `src/views/Settings.tsx` | 「语音」设置分区入口 |
| `src/views/TranslationPanel.tsx` / `src/quickreview/QuickReviewApp.tsx` | 浮窗朗读（SAPI）/ 快速复习发音 |
| `src/livecaption/LiveCaptionApp.tsx` | 录音直译窗口 UI |
| `src-tauri/src/tts.rs` | SAPI TTS（双音轨、gen 打断、boundary 事件） |
| `src-tauri/src/speak_store.rs` | 口语陪练会话落盘 |
| `src-tauri/src/secret_store.rs` | DPAPI 加密 secret（讯飞凭据存储） |
| `src-tauri/src/lib.rs` | command 注册 + 托盘「录音直译」+ 窗口重建 |
| `src-tauri/tauri.conf.json` | live-caption 窗口 + 各窗口麦克风 browser args |

测试（`src/core/*.test.ts` 及同目录）：`edgeTts` / `xfyunTts`（含 `.live`）/ `xfyunAsr` / `pronunciation` / `speechEngine` / `usePlayback` / `speakLogic` / `liveCaption` / `shadowDiagnose`，另有 `spike/` 协议探测脚本（环境变量凭据、env 门控自跳过）。

---

## 12. 已知坑与关键决策速记

- **Edge TTS 免凭据** = 公开 TrustedClientToken + SHA-256 时间窗签名；本机时钟偏差 >5 分钟会 403，已做 Date 头校准重试。
- **讯飞握手失败一律表现为 close 1006**（浏览器拿不到 HTTP 401/403），UI 按「凭据 → 系统时间 → 代理」三步排查提示；另有 `probe_https` 诊断命令。
- **IAT 请求多传 `business.sub` 会报 10163**（commit c60d818 修复），spike 脚本注释里保留了这条教训。
- **语速策略** = 合成恒 1×、播放端 `playbackRate` 变速：换语速不重新合成、缓存跨语速命中。
- 云 TTS 无词级 boundary 事件；经核实当前词级高亮并不依赖 boundary（仅作链路校验锚点），引擎替换不破坏功能。
- 浮窗/快速复习朗读目前直接走 SAPI，未接引擎调度（历史路径，功能独立）。

---

## 13. 规划与演进（索引）

| 文档 | 内容 | 状态 |
|---|---|---|
| `docs/voice-roadmap.md` | 语音能力升级路线图：多音色 TTS、评测多供应商、语音大模型、语音 Agent 陪读 | 调研（2026-09-15） |
| `docs/voice-alternatives-research-2026-09-22.md` | 讯飞三件套的替代方案与价格：Azure 中国区 TTS、阿里 Paraformer、腾讯云 SOE 等 | 调研（2026-09-22）；其中「Edge 默认 + SAPI 兜底」已落地，其余待立项 |
| `docs/live-caption-v2-plan-2026-09-23.md` | 录音直译 v2：R5「录音复盘」（讯飞语音转写 lfasr，Rust reqwest + `replay_store.rs` + `meeting-replay` 窗口）+ R4v2「系统声音实时字幕」（WASAPI loopback），终态「会议副驾」 | v0.1 草案待评审；里程碑 M0 spike → M1 复盘 MVP → M1.5 报告 → M2 系统声音 → M3 合体，映射 v0.7.0–v0.8.0 |
| `docs/server-architecture-plan-2026-09-22.md` | 服务端规划含语音网关（N3）：客户端零发版换语音上游 | 规划 |

配套交互原型：`docs/voice-flow-diagram.html`。
