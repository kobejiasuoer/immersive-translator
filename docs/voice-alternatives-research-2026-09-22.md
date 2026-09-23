# 语音能力替代方案调研 · TTS / ASR / 口语评测

> 日期：2026-09-22 · 范围：Windows 端讯飞三件套（TTS / ASR / ISE）的市场替代方案与价格
> 背景：讯飞免费额度仅 3 个月（实名礼包：个人认证 ISE 1 万次 / 90 天；未领礼包则 500 次/日），到期后 ISE 套餐一要 60 元/万次，成本远高于同行。本文盘替代方案，结论先行。

---

## 0. 结论速览

| 能力 | 当前 | 推荐替代 | 成本 | 迁移量 |
|---|---|---|---|---|
| **TTS**（阅读室朗读） | 讯飞 wss://tts-api.xfyun.cn/v2/tts | **Azure 神经 TTS**（中国区）每月 50 万字符免费；超额 ¥0.95/万字符；失败回落 Windows SAPI（已有） | ≈0 | 小（speechEngine 已有引擎抽象） |
| **ASR**（录音直译 / 口语录音，非流式） | 讯飞 wss://iat-api.xfyun.cn/v2/iat | **阿里百炼 Paraformer-v2**：每月免费 36000 秒（10 小时），长期发放；超额 ¥0.288/小时。或 **硅基流动 SenseVoice**：完全免费 | ≈0 | 小（REST，比 WS 简单） |
| **ASR**（实时字幕，流式） | 同上（iat 流式） | **本地 sherpa-onnx 流式 Zipformer**（免费离线）；或阿里 Paraformer-realtime | ≈0 | 中 |
| **口语评测 ISE**（跟读打分） | 讯飞 wss://ise-api.xfyun.cn/v2/open-ise | **腾讯云智聆口语评测 SOE**：新用户 ¥9.9/1 万次，后付费 ¥0.005/次（讯飞同项 ¥0.06/次，便宜 83%）。音素级、中英文 | 9.9 元起 | 中偏大（签名 + 题型参数 + 评分字段映射） |
| **兜底全离线**（可选） | — | **sherpa-onnx**：SenseVoice（ASR）+ 流式 Zipformer + Kokoro/VITS（TTS），CPU 可跑，Rust/Node 绑定齐 | 0，代价是安装包 + 200~500MB 模型 | 大（2-4 天） |

**一句话**：TTS 和非流式 ASR 有「持续免费」的正规替代（Azure 中国区 / 阿里百炼每月发放额度），基本零成本迁移；真正要花钱的只有口语评测，腾讯云 SOE 是讯飞 ISE 唯一的同级替代，单价低约 5 倍且体验金便宜（¥9.9 起步）。

---

## 1. 现状盘点：讯飞三件套用在哪

| 能力 | 代码入口 | 使用场景 | 调用特征 | 到期风险 |
|---|---|---|---|---|
| TTS | `src/core/xfyunTts.ts` | 阅读室朗读（凭据配置时优先于 Windows SAPI）、设置页试听 | 每句一次合成，长阅读 1 小时约数千字符 | TTS 套餐 100 万次/¥5800，到期即断 |
| ASR | `src/core/xfyunAsr.ts` | 口语陪练录音转写（SpeakView）、实时字幕/录音直译（LiveCaptionApp） | 单句录音 3~15 秒；实时字幕为持续流式 | iat 免费包到期即断 |
| ISE | `src/core/pronunciation.ts` | 跟读打分（SpeakView `evaluateSentence`）、影子跟读评估（useShadowAssess） | 每句评测 1 次（<20 词计 1 次）；重度使用 20 句/天 ≈ 600 次/月 | 礼包 90 天用完 → ¥60/万次 |
| 本地 TTS | `src-tauri/src/tts.rs`（SAPI） | 无讯飞凭据时的兜底 | 已存在，**这是现成的免费兜底** | 无 |

鉴权方式：三者均为 WebSocket + HMAC-SHA256 签名（`xfyunAuth.ts`），凭据经 DPAPI 存本地（`secret_store.rs`）。

---

## 2. TTS 替代方案

| 方案 | 价格 | 免费额度 | 接入形态 | 中文/英文质量 | 备注 |
|---|---|---|---|---|---|
| **Azure 神经 TTS（中国区 azure.cn）** | ¥95.4/百万字符（≈0.95 元/万字符） | **每月 50 万字符免费** | REST/SDK，Subscription Key + Region | 微软神经网络音色（晓晓/云希等），中英皆优 | 与讯飞同一时代的主流方案；个人可注册 azure.cn；国际版价格更高（$15/1M）且访问不稳 |
| **Edge TTS（逆向接口）** | 免费 | 完全免费 | HTTP/WS 逆向 Edge 浏览器接口，开源库（Node/Python/Rust 均有） | 与 Azure 同款音色（XiaoxiaoNeural 等） | ⚠️ 非官方接口，微软多次收紧（Sec-MS-Token、403 风波，库跟进修复）。个人工具可接受，不能作为唯一依赖 |
| Windows SAPI（现状） | 免费 | — | 本地 `tts.rs`，已实现 | 取决于系统语音包，David/Zira 中文 Huihui，机器感明显 | 保留为最终兜底 |
| 火山引擎豆包 TTS | 大模型版 ¥3~5/万字符 | 每月 5 万字符 | REST/WS | 顶级（豆包音色） | ⚠️ 大模型版**仅企业实名**可开通；个人不建议 |
| MiniMax Speech 2.6 | Turbo ≈¥4.3/万字符；HD ≈¥7.2/万字符 | 少量 | REST | 全球 ELO 排名第 2-4（Artificial Analysis 2025） | 效果极好但对本项目过奢侈 |
| sherpa-onnx 本地 TTS | 免费 | — | 本地 ONNX，Kokoro（中英 103 音色）/Piper/Matcha/VITS | 中上，不如云端神经音色 | 模型 200~400MB 需随包或按需下载 |
| 硅基流动 CosyVoice2 | ≈¥50/M tokens（音频输出） | 有新人额度 | REST | 好 | token↔时长换算复杂，量小可忽略成本 |

**结论**：Azure 中国区免费额度对「句级朗读」用量（估算 <10 万字符/月）完全够用，超额也只 1 元/万字符；Edge TTS 可作为「免配置」的默认选项（用户零门槛），Azure 作为可选升级，SAPI 兜底。三层回落。

### 2.1 复核（同日晚）：英文音色质量专项 + 最新报价

> 触发：用户反馈讯飞英文音色（现状 `catherine`）难听，要求换掉。本节价格均为 2026-09-22 官方页面实抓。
> 另：内置搜索/阅读 MCP 配额耗尽，本节数据来自 WebFetch 直抓官方定价页 + 微软公开音色接口，个别口径以官网为准。

**现状根因**：`xfyunTts.ts` 英文句默认 `vcn=catherine`——讯飞上一代拼接风英语音色，与新一代神经/大模型 TTS 差两代，难听是产品代差问题，换讯飞音色档位解决不了。

**英文音色质量梯队**（Artificial Analysis Speech Arena ELO + 主观口碑）：

| 梯队 | 方案 | 说明 |
|---|---|---|
| 顶级 | Cartesia Sonic 3.6（AA 质量榜第一，1272 ELO） | ❌ 国内不可达，仅参考 |
| 顶级 | MiniMax speech-2.8-hd | AA 榜常年前列，英文极自然；百炼可调（¥3.5/万字符），一个 DashScope Key 即可用 |
| 优 | **Azure en-US Ava / Andrew / Emma / Brian（+Multilingual 版）** | 与 Edge TTS 同款音色；已实测在 Edge 免费接口可用（英文 47 个 / 中文 14 个音色） |
| 优 | Qwen-Audio-3.0-TTS-Plus | AA「best quality-for-price」榜；百炼 ¥1.4/万字符 |
| 好 | 腾讯云大模型音色、qwen3-tts-flash、CosyVoice2 | 明显好于讯飞 catherine |
| 差 | 讯飞 catherine（现状） | 垫底档 |

**最新报价统一口径（元/万字符，英文计费 1 字符=1 字符）**：

| 方案 | 价格 | 免费额度 | 英文质量 | 国内可达 |
|---|---|---|---|---|
| **Edge TTS（微软逆向接口）** | **0** | 无限 | 优（Ava/Andrew 同款） | ✅ 但有收紧风险（§8.1） |
| **Azure 中国区 F0** | 超额 ¥0.954 | **50 万字符/月，长期** | 优（同上） | ✅ azure.cn 直连 |
| 腾讯云 精品音色 | ¥0.3 | 800 万字符一次性（3 个月有效） | 中（上一代神经） | ✅ |
| 腾讯云 大模型音色 | ¥1.2（日 ≤10 万字符档） | 100 万字符一次性 | 好 | ✅ |
| 硅基流动 CosyVoice2 | ¥0.5 | 新人赠金 | 中上（英文略带口音感） | ✅ |
| 阿里百炼 qwen3-tts-flash | ¥0.8 ⚠️汉字计 2 字符 | 1 万字符/90 天 | 中上 | ✅ |
| 阿里百炼 qwen-audio-3.0-tts-plus | ¥1.4 ⚠️汉字计 2 字符 | 1 万字符/90 天 | 优 | ✅ |
| 阿里百炼 MiniMax/speech-2.8-hd | ¥3.5 | 无 | 顶级 | ✅ |
| OpenAI gpt-4o-mini-tts | — | — | 优 | ❌ 本机实测 403，个人用户无代理不可用 |
| 火山豆包 TTS 大模型版 | ¥3~5 | 每月 5 万字符 | 优 | ⚠️ 大模型版仅企业实名（§6） |

**针对「英文难听」的推荐**（维持三层回落架构，只动 provider）：
1. **默认档换 Edge TTS，英文默认音色 en-US-AvaNeural / AndrewNeural，中文 XiaoxiaoNeural** —— 零成本、零配置、零凭据，英文质量一步到第一梯队；用户开箱即好听。
2. **可选升级 Azure F0**（同款音色、正规接口、每月 50 万字符免费）：Edge 通道失效时自动切换，注册了 Azure Key 的用户直接走 azure.cn。
3. **追求顶级英文**：设置页加「高质量引擎」选项接 MiniMax speech-2.8-hd（¥3.5/万字符，百炼 REST）。阅读 1 小时英文约 8~9 万字符 ≈ ¥30/小时，仅推荐重度听力用户。
4. 讯飞 TTS 保留为回落一档（已有实现不删），下个版本默认不再选中。

音色映射建议：英文句 AvaNeural（女）/ AndrewNeural（男）二选一暴露为设置项；中文句 XiaoxiaoNeural（对齐 Edge/Azure 双通道，一处配置两通道生效）。迁移量 ≈ §7 第一行（0.5~1 天）。

### 2.2 Edge TTS 接入要点（2026-09-22 本机实测验证）

> 实测脚本与试听样例：`.spike/probe-headers.mjs`、`.spike/sample-{ava,andrew-en,xiaoxiao-zh}.mp3`（Node 24 + ws 包跑通，44KB/句级 mp3 正常返回）。

**协议（对齐 rany2/edge-tts master，2026-09）**：
- 端点：`wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&Sec-MS-GEC=<token>&Sec-MS-GEC-Version=1-143.0.3650.75`
- `Sec-MS-GEC` = SHA-256 大写十六进制 of `${ticks}${TrustedClientToken}`；ticks = (unix秒 + 11644473600) 向下取整到 300 秒 × 10⁷（Windows filetime）。时钟偏差 >5 分钟即 403—— voices/list REST 响应的 `Date` 头可读，用来校准重试（本次实测本机零偏差）。
- 帧序列（连上后发两条文本帧）：`speech.config`（指定 `outputFormat: audio-24khz-48kbitrate-mono-mp3`）→ `ssml`（`X-RequestId` 无横线 UUID + 单 voice 单 prosody 的 SSML，rate/volume 恒 +0%，变速仍由播放端承担）。
- 响应：二进制帧 = 2 字节大端头长 + 头文本 + mp3 净荷，`Path:audio` 帧累加；收到文本帧 `Path:turn.end` 结束。产物即 mp3 Blob——**缓存（LRU+IndexedDB）与 <audio> 播放层可原样复用讯飞那套**。

**实测关键结论（头部矩阵）**：
| 握手方式 | 结果 |
|---|---|
| 无 User-Agent（Node 原生 WebSocket 即如此） | ❌ HTTP 403 |
| 带 Chromium/Edge UA | ✅ 成功 |
| 带 UA + 任意 Origin（含 `http://tauri.localhost`） | ✅ 成功 |

⇒ 微软校验 UA 而不校验 Origin。浏览器 WS 不能自设 UA，但 **WebView2 会自动携带真实 Edge UA**，与实测通过的形态一致 → 前端直连（同 `xfyunTts.ts` 模式）预期可行，接入时先在 App 内跑一次真机验证；万一被拒，兜底是把这一小段挪到 Rust（tungstenite 自定义 UA，约 100 行，`tts.rs` 已有先例）。

**实现落点（2026-09-22 已完成）**：`src/core/edgeTts.ts`（合成客户端：Sec-MS-GEC 签名 / 时钟校准自愈重试 / LRU+IndexedDB 双层缓存，默认音色 中文晓晓 / 英文 Ava）；`src/reader/speechEngine.ts` 抽出 `createCloudEngine` 工厂，讯飞与 Edge 共用播放层，新增 `createEdgeEngine`；`readerTypes.ts` 的 `ttsProvider` 扩为 `"edge" | "local" | "xfyun"`（新用户默认 edge），设置抽屉朗读引擎三选一 + Edge 中/英音色建议列表；引擎链 Edge → 讯飞（有凭据）→ SAPI。单测 `edgeTts.test.ts`（帧构造/解析/签名对齐/流式拼装/缓存/校准重试）全绿。

---

## 3. ASR 替代方案

本项目两个场景要分开看：**A. 录音转写**（口语陪练录音、录音直译整段音频——非流式可接受，延迟 1~2 秒 OK）；**B. 实时字幕**（边说边出字，需要流式）。

### 3.1 非流式（录音转写）

| 方案 | 价格 | 免费额度 | 接入 | 质量 |
|---|---|---|---|---|
| **阿里百炼 Paraformer-v2** | ¥0.00008/秒 = **¥0.288/小时** | **每月 36000 秒（10 小时），每月 1 日自动发放，长期政策**（官方文档确认，非新人一次性） | DashScope REST，API-Key 极简 | 中英日韩粤，中文效果第一梯队 |
| **硅基流动 SenseVoiceSmall** | **免费（¥0）** | 持续免费（策略变更风险见 §8） | OpenAI 兼容 `POST /v1/audio/transcriptions`，Bearer Key，最简 | 10 秒音频 70ms 推理，中文优于 Whisper-large；带情感/事件检测 |
| 本地 SenseVoice（sherpa-onnx） | 免费 | — | 本地 ONNX，int8 模型约 230MB | 同上，完全离线 |
| Azure STT（中国区） | ¥3/小时 | 每月 5 小时 | SDK | 好 |
| 火山引擎录音文件识别 | ¥0.039/分钟 ≈ ¥2.34/小时 | 每月 180 分钟 | REST | 好 |
| 讯飞 iat（现状基线） | 套餐 20 万次/¥1000 起 | 500 次/日（礼包期） | WS+签名 | 好 |

### 3.2 流式（实时字幕）

| 方案 | 价格 | 备注 |
|---|---|---|
| **本地 sherpa-onnx 流式 Zipformer**（中文 int8 约 40~80MB） | 免费 | 延迟 <500ms，CPU 占用低，完全离线；实时字幕场景的最佳答案——不依赖网络与凭据 |
| 阿里 Paraformer-realtime-v2 | ≈¥0.00032/秒 ≈ ¥1.15/小时（以官网为准） | WS 流式，接入与百炼同族 |
| Azure STT 实时（中国区） | ¥3/小时，每月 5 小时免费 | SDK 流式成熟，发音评估也走同一 SDK |
| 火山大模型流式 | ¥0.075/分钟 = ¥4.5/小时 | 贵，不推荐本项目用 |
| 「准实时」轮询 SenseVoice | 免费 | 用 VAD 分片（静音切分 2~5 秒）循环调文件转写，延迟 1~2 秒；sherpa-onnx 自带 Silero VAD 可本地切分 |

**结论**：录音转写迁去**硅基流动（免费）或百炼 Paraformer（每月 10 小时免费）**，代码比讯飞还简单（REST 一发一收）。实时字幕优先做**本地流式**（sherpa-onnx），网络与成本问题一次性消除；过渡期可先接百炼实时版。

---

## 4. 口语评测（ISE）替代——真正的缺口

这是三家云都没有完全免费方案的领域。玩家与价格：

| 方案 | 价格 | 评测粒度 | 语种 | 接入 | 备注 |
|---|---|---|---|---|---|
| 讯飞 ISE（现状基线） | 套餐一 **¥60/万次**（¥0.006/次）；20 万次/年 ¥1200 | 音节级，准确度/流畅度/完整度/声韵调 | 中英 | WS+HMAC（现成） | 权威（国家语委鉴定、四六级口语同源），但最贵 |
| **腾讯云智聆 SOE（新版）** | **¥9.9/1 万次**（限购 1 次）；后付费 ¥0.005/次；15 万次/¥600 | **音素级**，准确度(GOP)/流畅度/完整度/重音/声调；与专家打分相似度 95%+ | 中英（分 ServerType） | WS + 签名；有 JS/WebSocket 接口与小程序插件 | **最优先替代**。单价约为讯飞 1/5~1/6；题型：字/词/句/段落/自由说/多分支 |
| Azure 发音评估（中国区） | ¥3.05/小时/功能（按音频时长计） | **音素级**，准确度/流利度/韵律/完整度 + 音素反馈 | en 为主（zh 支持需按文档验证） | Azure Speech SDK，与 TTS/STT 同一套凭据 | 5 秒单句 ≈ ¥0.004/次，与 SOE 相当；若 TTS 也选 Azure 则一套 Key 全解决 |
| 有道智云语音评测 | 送 50 元体验金，单价约 ¥0.005/次量级（需商务确认） | 音素级，准确度/完整度/流利度/重音/音标监测 | 中英 | HTTPS API（录音整段上传，非流式） | 网易系，教育场景成熟 |
| 驰声 Chivox / 声通 / 云知声 / 先声 | 均面向 B 端（中高考同源），无自助开通 | 音素级 | 中英 | 商务对接 | 不适合个人项目自助接入 |
| 「ASR + LLM」自建评测 | 仅 LLM 费用 | 无音素级 | 任意 | 自己拼 | ⚠️ ASR 会「纠正」发音错误，识别文本正确≠发音正确；只能评语法/内容，发音准确度不可信。可作辅助点评（LLM 对比识别文本与标准文本给语言性反馈），不能替代打分 |

**结论**：
- 首选 **腾讯云 SOE**：¥9.9 起步、音素级、中英文、题型覆盖跟读场景。迁移要点是评分字段映射（讯飞 `total_score/phone_score/tone` → SOE `SuggestedScore/Accuracy/Fluency/Pronunciation`）与题型参数（read_sentence → sentence 模式）。
- 若愿意统一到 Azure（TTS+STT+评测一套 Key），发音评估按时长计费几乎免费，且 en-US 评测效果业界公认一流；缺点是 azure.cn 需单独实名注册，中文评测支持需验证。

---

## 5. 本地离线全家桶：sherpa-onnx（可选支线）

- 定位：k2-fsa 出品，ONNX Runtime 推理框架，**Rust/Node/Python/C# 等 12 语言绑定**，Windows x64 预编译齐（Tauri 可用 npm 包 `sherpa-onnx-node` 或 Rust crate，也可 sidecar exe）。
- ASR：SenseVoice（非流式，中英日韩粤）、流式 Zipformer/Paraformer（实时）、Whisper；内置 Silero VAD。
- TTS：Kokoro（中英多音色）、Piper、Matcha、VITS。
- 成本：模型文件 40~500MB/个，建议**首启按需下载**（不塞安装包）；CPU 推理即可（int8）。
- 适合：实时字幕本地化、无网兜底、彻底零 API 成本的「离线模式」卖点。
- 代价：集成与模型分发工程量 2~4 天，音色/评分能力不如云端。

---

## 6. 推荐迁移路线（两档）

### 方案 A：最低成本正规军（推荐先做，约 3~4 人日）
1. **TTS**：接入 Azure 中国区神经 TTS（免费 50 万字符/月）→ 保留 Edge TTS 作为「免配置默认」→ SAPI 兜底。`speechEngine.ts` 已有引擎抽象，加一个 provider 即可。
2. **录音 ASR**：`xfyunAsr.ts` 的录音直译/口语转写改调**硅基流动 SenseVoice**（REST，几十行代码）或百炼 Paraformer。
3. **实时字幕**：短期用百炼 Paraformer-realtime；中期换本地 sherpa-onnx 流式（消除成本与网络依赖）。
4. **ISE → 腾讯云 SOE**：新增 `soeEvaluate`，按 §4 映射评分与题型；设置页语音 Tab 从「讯飞三件套」泛化为按 provider 分组凭据（沿用 `xfyun:creds-updated` 广播刷新机制）。

### 方案 B：全离线极简版（可选，2~4 人日）
全部换 sherpa-onnx（SenseVoice + 流式 Zipformer + Kokoro），零 API、零凭据、隐私最好，作为「离线模式」独立卖点；云端方案保留为「高质量模式」。

### 不建议
- 豆包 TTS 大模型版（企业认证门槛）、MiniMax（效果溢价对本项目无必要）、驰声/声通等 B 端商务线（无法自助开通）。

---

## 7. 迁移成本评估（代码级）

| 改造点 | 位置 | 工作量 |
|---|---|---|
| TTS provider 抽象 + Azure/Edge 接入 | `speechEngine.ts`、`SettingsDrawer.tsx`（音色列表）、`xfyunTts.ts` 保留为可选 | 0.5~1 天 |
| 录音 ASR 换 SenseVoice/Paraformer | `xfyunAsr.ts` 调用方（SpeakView / LiveCaptionApp）新增 REST 客户端 | 0.5 天 |
| 流式 ASR（百炼实时 或 sherpa-onnx） | LiveCaptionApp 录音管道 | 1~2 天 |
| ISE → SOE | `pronunciation.ts` 平级新增 `soe.ts`（WS+签名、题型、字段映射）、`useShadowAssess`/`SpeakView` 适配 | 2~3 天 |
| 凭据设置泛化 | `XfyunVoiceSection.tsx` → VoiceSection（按 provider 分组，DPAPI 键名新增 `azure_tts_*`、`siliconflow_key`、`tencent_soe_*` 等） | 0.5 天 |
| 本地模型下载管理（方案 B/实时字幕本地化） | 首启下载器 + 存储路径 + 进度 UI | 1~2 天 |

风险提示：讯飞现有实现**先不要删**，作为回落 provider 保留一个版本周期；评分结果 UI 字段已按 `PronunciationResult` 抽象，映射层改动可控。

---

## 8. 风险与注意事项

1. **Edge TTS 是逆向接口**：微软历史上多次收紧（Sec-MS-Token、403 风波），每次靠社区库跟进修复（几周内）。只可作兜底/默认，不可作唯一依赖。
2. **硅基流动「完全免费」是当前策略**，可能调整（他们历史上把部分模型转为收费）。百炼 Paraformer/SenseVoice 的每月免费额度是官方文档明示的**长期政策**，相对更稳。
3. **Azure 中国区（azure.cn，世纪互联）与国际版账号不通用**；个人可实名注册，发音评估的中文语种支持需以最新文档实测为准。
4. **腾讯云 SOE 新版**计费中英文通用（基础版即将下线，直接接新版）；按文本长度计次，段落模式 20 词计 1 次——跟读场景单句 1 次，成本可精确预估。
5. **ASR+LLM 自建评测不可行**（发音维度）：ASR 已纠正发音，识别正确≠发音正确，勿用识别文本评发音准确度。
6. 讯飞到期时间点前留出迁移窗口；迁移期间保留讯飞 provider 与回落链，避免「到期即全断」。

---

## 附：数据来源
- 讯飞 ISE 价格/礼包：xfyun.cn/services/ise（实名礼包 1 万次/90 天、套餐一 60 元/万次）
- 腾讯云 SOE 计费：cloud.tencent.com/document/product/1774/107342（9.9 元/万次、后付费 0.005 元/次）
- Azure 中国区语音定价：azure.cn/pricing/details/cognitive-services（TTS 50 万字符/月免费、STT 5 小时/月、发音评估 ¥3.05/小时/功能）
- 阿里百炼 Paraformer-v2：¥0.00008/秒、每月免费 36000 秒长期发放；免费额度政策：help.aliyun.com/document_detail/2975130
- 硅基流动 SenseVoiceSmall：siliconflow.cn 模型中心（¥0）及 API 文档
- 火山引擎音视频费用：volcengine.com/docs/84458/1585106；豆包 TTS 企业限制：github.com/xinnan-tech/xiaozhi-esp32-server/issues/954
- MiniMax/语音模型 ELO 排行：Artificial Analysis（国信证券研报转引，2025-10 数据）
- Edge TTS 风险与修复史：Hacker News 2025-01 讨论、edge-tts 6.1.15/16 修复记录、CSDN 案例汇总
- sherpa-onnx 能力矩阵：k2-fsa.github.io/sherpa/onnx 与官方 README
