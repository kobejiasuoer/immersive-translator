# 沉浸阅读室 · 语音能力升级路线图

> 调研日期：2026-09-15（定时调研任务产出，基于当日网络搜索 + 代码核实）
> 结论速览：**近期**主推「云 TTS Provider 抽象 + Azure 官方免费量（或讯飞已开通服务）」解决音色枯燥；**中期**先做「发音人话讲解」（数据已到手，成本最低感知最强）和「评测多供应商」，句子对话次之；**远期**语音 Agent 陪读走豆包/Qwen-Omni Realtime 的 WebSocket 双工。

---

## 0. 现状盘点（代码核实结果）

| 环节 | 实现 | 文件 | 关键约束 |
|---|---|---|---|
| 朗读/领读 TTS | Windows SAPI `ISpVoice`，专用 STA 线程，sentence/word 双音轨，语速 0.5-2.0 对数映射，word/sentence boundary 事件 | `src-tauri/src/tts.rs` | 零依赖、离线；但音色取决于系统安装（本机仅 Huihui 等） |
| 发音评测 | 讯飞 ISE 流式版，前端 WebSocket 直连（HMAC 鉴权），5 分制句/词/音节/音素四级 + gwpp 音素惩罚 | `src/core/pronunciation.ts` | 单一供应商；90 天 1 万次免费 |
| 麦克风 | WebView getUserMedia → 16k AudioContext → PCM；电平/VAD 在 `useShadowAssess` | `src/core/micRecorder.ts` | 依赖 `additionalBrowserArgs` 放行权限（已验证） |
| 播放推进 | `usePlayback.ts` 以 `tts:ended`（gen 代数匹配）驱动句级推进；boundary 仅作链路校验锚点 | `src/reader/usePlayback.ts` | **词级 boundary 当前产品并未依赖** → 云 TTS 替换不破坏高亮 |
| LLM | OpenAI 兼容 chat/completions（Rust reqwest 流式），DeepSeek/GLM/千问/Kimi 等 | `src-tauri/src/translation.rs` | 可复用为「发音讲解」的生成器 |

**已开通**：讯飞语音评测（ISE）+ 讯飞语音生成（TTS）。

---

## 1. 近期：多音色 TTS（预计 1-2 周）

### 1.1 方案对比

| 方案 | 音色/自然度 | 中英文 | 免费额度 | 付费价格 | 离线 | 落地方式 | 判断 |
|---|---|---|---|---|---|---|---|
| SAPI（现状） | 系统Installed voices，本机差 | ✅ | 无限 | 免费 | ✅ | 已有 | 保留为离线兜底 |
| **Azure Speech 官方** | 500+ 神经音色，顶级自然度 | ✅ | **50 万字符/月**（[来源](https://azure.microsoft.com/en-us/products/ai-foundry/tools/speech)，[对比评测](https://www.speechmatics.com/company/articles-and-news/best-tts-apis-in-2025-top-12-text-to-speech-services-for-developers)） | ~$15/百万字符（待验证） | ❌ | Rust reqwest REST（SSML）→ 前端 `<audio>` 播放 | **主推**；国内可用性待验证（见 1.4） |
| **讯飞在线合成（已开通）** | 100+ 发音人，含超拟人合成 | ✅ 方言 | **每日 500 次**（[API 文档](https://www.xfyun.cn/doc/tts/online_tts/API.html)） | 长文本 ~2.4 元/万字符 | ❌ | WebSocket 流式，协议与 ISE 同族 | **即用项**：账号已开通，当天可接 |
| 火山豆包 TTS 2.0 | 200+ 预置音色 + 5-10s 声音复刻 | ✅ | 每应用 2 万字符试用（[评测](https://developer.volcengine.com/articles/7631415579070136370)） | **4.5 元/万字符**（[计费](https://www.volcengine.com/docs/6561/1359370)）；复刻音色 ~150 元/年 | ❌ | HTTP/WS | 高音质付费选项；音色最丰富 |
| MiniMax speech-2.8 | 600+ 音色、32 语言同段切换 | ✅ | 注册赠送（待验证） | 阿里云百炼渠道 **3.5 元/万字符**（[来源](https://help.aliyun.com/zh/model-studio/minimax-synchronous-speech-synthesis-api)） | ❌ | HTTP | 高音质付费选项；海外站价格不同 |
| CosyVoice 2/3（开源） | 零样本克隆、指令控情感；首包 ~150ms | ✅ | 本地免费 | 需 **4-6GB 显存**（[GitHub](https://github.com/FunAudioLLM/CosyVoice)） | ✅ | 本地起服务 + HTTP | 仅当用户有 N 卡；不适合内置 |
| Piper / Kokoro | 轻量 CPU 可跑，质量中下 | 英强中弱 | 本地免费 | 免费 | ✅ | Rust 绑定/子进程 | 中文音色质量不达标，**不推荐** |
| edge-tts | 即 Edge 浏览器同款神经音色 | ✅ | 非官方免费 | 免费 | ❌ | 模拟 Edge 端点（[openai-edge-tts](https://github.com/travisvn/openai-edge-tts)） | 非官方接口随时可能被封，**不作为产品依赖**，可作开发者自用后门 |

### 1.2 推荐：三层策略

1. **默认主路径 = Azure 官方**：免费 50 万字符/月 ≈ 每天 1.6 万字符。按阅读室用量估算（一篇 500 词 ≈ 3000 字符，每天 4-5 篇 + 领读重听 ≈ 1.5-2 万字符/天），个人使用**基本贴着免费线**，超量再买。
2. **即用验证路径 = 讯飞在线合成**（已开通、每日 500 次免费）：先用它把「云 TTS 播放链路」跑通（实验 1），Azure 作为第二 provider 接入。
3. **SAPI 永远保留**：断网/未配置 Key 时回落，阅读室永远有声。

### 1.3 改造点（文件级）

| 文件 | 改造 |
|---|---|
| `src-tauri/src/tts.rs` | 抽 `TtsProvider` trait（`speak(text, opts) -> gen`）；SAPI 实现不动 |
| `src-tauri/src/tts_cloud.rs`（新增） | 讯飞/Azure HTTP 合成（reqwest），返回音频 bytes + 元数据；凭据复用 `secret_store.rs` 命名 secret |
| 播放路径 | **推荐前端播放**：Rust 把音频 bytes 经事件/临时文件给前端，`<audio>` + `URL.createObjectURL` 播放；`usePlayback.ts` 的 `tts:ended` 语义改为「前端 audio onended → 通知后端 gen++」或由后端转发。句级推进逻辑不变 |
| `SettingsDrawer.tsx` | 音色下拉按 provider 分组（本地 / 讯飞 / Azure…），试听按钮 |
| `readerTypes.ts` | `voice: string` 扩展为 `{ provider, voice }`（schema + reader_store.rs 同步，走既有 4 处同步流程） |
| **不需要动** | `micRecorder.ts`、`pronunciation.ts`、`useShadowAssess.ts`——跟读评测链路与 TTS 无耦合（领读只是调 `ttsSpeakAdvanced`） |

### 1.4 风险与注意

- **Azure 国内可用性【待验证】**：全球区直连可能不稳；Azure 中国区（世纪互联）有 Speech 服务但需国内账号。实验 2 专测连通性。若不稳，主路径换讯飞超拟人合成（质量也是大模型级）。
- **word boundary 丢失**：云 TTS REST 无词级事件。经核实当前代码 boundary 仅作校验锚点（`usePlayback.ts` 注释），**高亮不受影响**。
- 讯飞在线合成为 WebSocket 流式，协议风格与 ISE 相同，前端直连亦可（省 Rust 改动）。

---

## 2. 中期：评测多供应商 + 语音大模型增强（1-2 个月）

### 2.1 发音评测去单一依赖

| 方案 | 分数粒度 | 免费额度 | 价格 | 接入 | 判断 |
|---|---|---|---|---|---|
| 讯飞 ISE（现状） | 句/词/音节/**音素+gwpp** | 90 天 1 万次 | 0.6 分/次（20 万次 1200 元，[会员价](https://www.xfyun.cn/doc/member/trial.html)） | 已接 | 保留为主 |
| **Azure Pronunciation Assessment** | 句/词/**音素** | **5 音频小时/月**（[定价](https://azure.microsoft.com/en-us/pricing/details/speech/)，[文档](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-pronunciation-assessment)） | ~$1/小时（与 STT 同价） | REST 或 SDK | **第一备选**，粒度同级 |
| 阿里云语音评测 | 篇章/句/**词**（dp_type 增漏读/重复、集外词标记）；音素走单独题型 | 未知【待验证】 | 未知【待验证】 | NLS API（[段落跟读文档](https://help.aliyun.com/zh/document_detail/2996315.html)） | 词级粒度略粗但够「过/不过+着色」 |
| 火山/有道/腾讯/好未来 | 句/词级 | 需价格计算器【待验证】（[入口](https://www.volcengine.com/product/voice-tech)） | — | — | 备选池 |
| 本地 whisper.cpp + MFA 强制对齐 | 理论音素级 | 免费 | 免费 | 需自带声学模型+词典+对齐器 | **不推荐**：工程重、无「评分」只有对齐，实时性差；与 decisions 文档既有结论一致 |

**改造点**：`src/core/pronunciation.ts` 抽 `AssessmentProvider` 接口（`evaluate(pcm, text, creds) -> PronunciationResult`），ISE 实现改名 `iseProvider.ts`，新增 `azurePaProvider.ts`。UI/状态机零改动——MVP 时就是按这个边界切的。

### 2.2 四个候选场景评估（价值判定）

| 场景 | 价值判定 | 依赖 | 成本 |
|---|---|---|---|
| **① 发音问题人话讲解** | ⭐⭐⭐⭐⭐ **必做**。ISE 的音素 gwpp 数据已在手里（如 "quick 的 /ɪ/ gwpp=-1.30 全句最差"），只差一步 LLM 提示词把数据翻成中文指导（"你的 quick 短元音拖长了，试着收着点"）。ELSA 的核心卖点就是这个（[音素级反馈评测](https://skywork.ai/skypage/en/ELSA-Speak-in-2025-An-AI-User%2527s-Deep-Dive-into-the-Ultimate-Pronunciation-Coach/1974387185089703936)） | 既有 ISE + 既有 LLM 管线 | **≤2 天**。复用 `requestTranslate`；在失败面板加「哪里不对？」按钮 |
| **② 句子情境对话（就当前句角色扮演）** | ⭐⭐⭐⭐ 推荐，但排①之后。差异化明确：[多邻国 Video Call 被评"没有发音评分"](https://practiceme.app/vs/duolingo-max)，而我们可以**对话内容用语音大模型 + 发音用 ISE 评分**闭环 | GLM-4-Voice（HTTP chat API，**80 元/百万 token**，base64 音频进出，情感/语速/方言可控，[文档](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-4-voice)）或 Qwen-Omni Realtime（WebSocket） | ~1 周。对话面板浮层 + 会话状态机 |
| **③ 情感化朗读（同句多情绪示范）** | ⭐⭐⭐ 值得，随云 TTS 顺带落地。语调教学价值高（"这句是讽刺，听我用地摊语气读一遍"）；GLM-4-Voice / 豆包 / MiniMax 都支持情感参数 | 近期云 TTS Provider（豆包 2.0 音色+情感、讯飞超拟人合成均支持） | 随 1.3 顺带：领读按钮旁加情绪选择。≤2 天（在 provider 就绪后） |
| **④ 听后复述（retell）** | ⭐⭐⭐⭐ 高潜力，**先验证再排期**。读完一段用自己的话复述 → 评测内容覆盖度，是「产出式练习」的自然延伸，与现有 SRS 复习体系衔接 | ISE 英文题型含 `retell`/`topic`（[题型列表](https://www.xfyun.cn/doc/Ise/IseAPI.html)），但**请求格式与返回【待验证】**（实验 5） | 验证 ≤2 天；产品化 ~1 周 |

**判定为噱头/暂缓**：实时语音翻译（偏翻译工具场景，与"读"的动线冲突）；唱歌式朗读（无学习价值锚点）；全文连续语音听写（与听写卡重复）。

### 2.3 语音大模型能力盘点（2026-09）

| 模型 | 调用 | 价格 | 关键能力 | 备注 |
|---|---|---|---|---|
| GLM-4-Voice（智谱） | HTTP Chat API，base64 wav 进出 | **80 元/百万 token**（统一价，[文档](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-4-voice)） | 端到端中英对话；**情感/语调/语速/方言指令可控**；8K 上下文 | 已开源 9B（[GitHub](https://github.com/zai-org/GLM-4-Voice)），MOS 4.45；本项目已有智谱账号体系 |
| Qwen3.5-Omni / Realtime（阿里） | WebSocket Realtime | 待验证 | **60+ 语言输入 / 30+ 输出、音色克隆、语义打断**，VoiceBench 93.1（[实测](https://www.qbitai.com/2026/03/393941.html)、[文档](https://help.aliyun.com/zh/model-studio/realtime)） | 实时翻译 ~3s 延迟 |
| 豆包端到端实时语音（火山） | WebSocket（[接入文档](https://www.volcengine.com/docs/6561/1594356)） | 文本输入 **10 元/百万 token**，输出价【待验证】（[计费](https://www.volcengine.com/docs/6561/1359370)） | 中英双语、多模式交互 | 文本输入价是目前公开最便宜的 |
| Step-Audio（阶跃） | 【待验证：API 开放情况与价格】 | — | 方言/情感唱歌见长 | 搜索配额受限未完成 |
| OpenAI Realtime / Gemini Live | WebSocket | 音频 token 计价，贵 | 顶配质量 | 国内直连不可行，仅自用 |

---

## 3. 远期：语音 Agent 陪读（3 个月+）

**形态**：读完一篇/一段后，「和这篇文章聊聊」——AI 就内容做苏格拉底式提问、观点讨论、词汇运用演练，全程语音；讨论中被你读错的词自动进生词本。

**技术选型**：豆包 Realtime（文本输入 10 元/百万 token）或 Qwen3.5-Omni Realtime 为主（国内直连、WebSocket 双工、语义打断）；GLM-4-Voice HTTP 版适合非实时的「讲解生成」。

**架构要点**：
- 双工 WebSocket 建议**前端直连**（与 ISE 同模式，避免 Rust 加 tungstenite 依赖）；连续对话音频流复用 `micRecorder.ts`（需扩展为流式分片输出，当前是一次性 stop）。
- 与跟读评测共存：通话模式下 VAD 让位给服务端断句。
- 前置条件：中期②积累的对话面板与会话状态机，远期只是把「打字的对话」换成「说话的对话」。

**竞品锚点**：[多邻国 Max Video Call with Lily](https://blog.duolingo.com/video-call/)（角色扮演通话，正下放到 Super 订阅）；ELSA 专攻发音不擅自由对话（[评测](https://www.talkio.ai/blog/best-ai-language-speaking-practice-apps-in-2026)）——**「沉浸原文 + 发音评分 + 自由对话」三合一没有对标产品**，是本产品的定位护城河。

---

## 4. 竞品可借鉴交互清单

| 产品 | 可借鉴 | 落到本项目的形态 |
|---|---|---|
| ELSA Speak | 音素级彩色反馈、错音聚焦小课程 | 词着色已有；加「本篇错音 Top3」汇总，复习时针对练 |
| Duolingo Max | 视频通话角色扮演、低压对话 | 中期②的对话面板；角色人设（外教/小说人物） |
| LingQ / Readlang | 点句即读、句级 TTS 循环 | 已具备（`onSpeakSentence`）；可加「本句循环 N 遍」精听模式 |
| Language Reactor | 双语字幕 + 逐句 AB 循环 | 阅读室遮罩模式已类似；补「AB 循环朗读」 |
| Speechify | 语速无级调节的听读范式 | 已有 0.5-2.0×；云 TTS 后自然度提升才见真章 |

---

## 5. 下一步最小可行实验（每项 ≤2 天）

1. **讯飞在线合成接 Provider 分支**（已开通，零成本）：tts.rs 抽 trait + 讯飞 WS 合成 + 设置音色下拉 + 前端 `<audio>` 播放链路验证。→ 直接产出近期 1.3 的大部分。
2. **Azure 免费账号连通性测试**：注册 F0、REST 合成 3 句、记录国内直连延迟与稳定性。→ 决定主路径是 Azure 还是讯飞超拟人。
3. **发音人话讲解落地**：ISE 结果 → LLM prompt → 失败面板「哪里不对？」按钮。→ 中期①整体完成。
4. **GLM-4-Voice 试调**：复用 spike 脚本模式，base64 音频进出 + 情感指令（"用悲伤的语气说"）验证可控性。→ 为②③探路。
5. **ISE retell 题型验证**：读一段 → 用自己的话复述 → 看返回结构是否有内容覆盖度分数。→ 决定中期④是否立项。
6. **豆包/MiniMax 试听选型**：控制台试听 200+/600+ 音色，各挑 5 个适合「英文外教感」的。→ 近期音色库的种子数据。

---

## 6. 来源汇总

- Azure Speech 免费额度/定价：[Azure Speech](https://azure.microsoft.com/en-us/products/ai-foundry/tools/speech)、[Speechmatics TTS API 对比](https://www.speechmatics.com/company/articles-and-news/best-tts-apis-in-2025-top-12-text-to-speech-services-for-developers)
- Azure Pronunciation Assessment：[文档](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-pronunciation-assessment)、[定价](https://azure.microsoft.com/en-us/pricing/details/speech/)、[配额](https://docs.azure.cn/en-us/ai-services/speech-service/speech-services-quotas-and-limits)
- 火山豆包语音：[计费说明](https://www.volcengine.com/docs/6561/1359370)、[计费概述](https://www.volcengine.com/docs/6561/1359369)、[端到端实时语音 API](https://www.volcengine.com/docs/6561/1594356)、[新用户额度评测](https://developer.volcengine.com/articles/7631415579070136370)
- 讯飞：[在线合成 API](https://www.xfyun.cn/doc/tts/online_tts/API.html)、[ISE 题型/会员价](https://www.xfyun.cn/doc/member/trial.html)、[ISE 产品页](https://www.xfyun.cn/services/ise)
- MiniMax：[阿里云百炼 Speech-2.8 渠道价](https://help.aliyun.com/zh/model-studio/minimax-synchronous-speech-synthesis-api)
- 阿里云语音评测：[段落跟读题型](https://help.aliyun.com/zh/document_detail/2996315.html)、[Qwen Realtime](https://help.aliyun.com/zh/model-studio/realtime)
- GLM-4-Voice：[智谱文档](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-4-voice)、[GitHub](https://github.com/zai-org/GLM-4-Voice)
- Qwen3.5-Omni：[量子位实测](https://www.qbitai.com/2026/03/393941.html)
- 语音大模型综述（更新至 2026.08）：[知乎专栏](https://zhuanlan.zhihu.com/p/14831605089)
- CosyVoice：[GitHub](https://github.com/FunAudioLLM/CosyVoice)
- edge-tts：[openai-edge-tts](https://github.com/travisvn/openai-edge-tts)、[Reddit 讨论](https://www.reddit.com/r/LocalLLaMA/comments/1g2ceyu/free_microsoft_edge_tts_api_endpoint_local/)
- 竞品：[ELSA 深度评测](https://skywork.ai/skypage/en/ELSA-Speak-in-2025-An-AI-User%2527s-Deep-Dive-into-the-Ultimate-Pronunciation-Coach/1974387185089703936)、[Duolingo Max](https://www.duolingo.com/help/what-is-duolingo-max)、[Video Call 博客](https://blog.duolingo.com/video-call/)、[Max vs ELSA 对比](https://practiceme.app/vs/duolingo-max)、[2026 口语应用盘点](https://www.talkio.ai/blog/best-ai-language-speaking-practice-apps-in-2026)

## 7. 待验证清单（下次调研/实验时补）

- [ ] Azure Speech 国内直连稳定性、中国区（世纪互联）个人可购性
- [ ] 豆包端到端 Realtime 的**输出**音频 token 价格
- [ ] Step-Audio API 开放情况与价格（本次搜索配额受限）
- [ ] 有道智云 / 火山口语评测具体价格与免费额度
- [ ] 阿里云语音评测计费、音素题型返回结构
- [ ] ISE `retell`/`topic` 题型的请求格式与返回（实验 5）
- [ ] 讯飞超拟人合成（星火 TTS）与在线合成的 API 差异与价格
- [ ] GLM-4-Voice 音色列表与免费额度（文档未列，需控制台确认）
