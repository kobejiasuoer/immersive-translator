# 语音云服务实施契约(实施阶段唯一规范输入)

日期:2026-10-28。本文整合:官方语音网关协议摘要、「语音页接入官方云服务」交互定稿核心契约、2026-10-28 产品决策。所有实施以本文为准;冲突时先查本文,本文未覆盖再查代码现状。

配套输入(只读参考):
- 产品决策:`docs/voice-cloud-decisions-2026-10-28.md`
- 高保真原型(目标 UI 形态):`prototypes/voice-settings-cloud-2026-10-27.html`(顶部「原型预览工具」可切换 11 个状态)
- 阅读室立项(独立支线,不在本契约内):`docs/reader-tts-provider-upgrade-prompt-2026-10-28.md`

---

## 一、官方语音网关协议摘要

- 总则:客户端只走网关,禁止直连讯飞上游(服务端会换源)。所有语音接口要求登录:HTTP 带 `Authorization: Bearer <access>`;WSS 不能带自定义头,用一次性 ticket 握手。
- 登录态:access JWT 约 15 分钟、refresh 约 30 天;**refresh 必须串行**(并发双刷触发 `token_reused` 整族吊销强制下线)。401 `token_expired`→刷新后重试一次;`token_invalid`/`unauthorized`→重新登录。客户端已有沉浸云登录与刷新实现,**必须复用其令牌存取与刷新串行机制,不得另起炉灶**。
- 能力配置:`GET /v1/me/config` 返回 `voice` 段:`ttsVoices:[{id,label}]`(默认音色排第一,做发音人选择器数据源)、`asrLanguages:["en_us","zh_cn"]`(ASR 的 lang 只能取其中)、`iseEnabled`(总开关,false 隐藏评测入口,调了 403 `ise_disabled`)。管理台可热改,客户端冷启动拉一次。
  **2026-10-28 新增契约**:服务端在 `voice` 段补配额余量字段(结构由服务端实施定,须含 tts/asr/ise 各自 remaining 与 resetsAt,UTC 自然月口径);字段未上线前客户端按 402 事件式兜底,上线后升级为常驻实时余量条。
- 换票:`POST /v1/voice/ticket` → `{ticket,expiresAt}`。ticket 60 秒有效、只能用一次,限流 30/分钟。**每次建连(含重连)前现调现用,绝不缓存;拿票到握手之间不插长耗时操作**;ticket 管理器按需单飞(single-flight)。
- 流式 ASR:`WSS /v1/voice/asr/stream?ticket=&lang=`。音频 16k/16bit/单声道 PCM(32KB/s),建议 320ms/帧(约 10KB),**单帧≤128KB**。上行 binary 音频 + text 帧 `{"type":"start"|"stop"}`;下行 `{"type":"interim"|"final"|"error"}`。会话≤60 秒;final 后可同连接再 start(不必重连);重复 start→`voice_invalid_state`;服务端 25s ping,标准 WS 自动 pong。
- 流式 TTS:`WSS /v1/voice/tts/stream?ticket=`。上行 `{"type":"synthesis","text","voice"?,"volume"?}`;下行 binary mp3 分片(按序追加播放)+ `{"type":"end"}` + error 帧。同连接多次 synthesis 按序不并发;**单次文本<8000 UTF-8 字节,超长按句拆分**;error 帧后连接不断可继续;不发任何 binary 上行。
- REST:`POST /v1/voice/asr` `{lang, audio(base64 PCM,≤50 秒)}` → `{text,durationMs}`;`POST /v1/voice/ise` `{refText(≤2000 字), lang:"en", audio}` → 5 分制评分 `{total,accuracy,fluency,standard,isRejected,words[]}`。录音是隐私:不落盘缓存、失败不自动重试上传。
- 服务端实现位置(参考):`immersive-translator-server/apps/api/src/modules/gateway-voice/`(voice.controller / voice-ticket.service / voice-routing.service / tts-stream.handler / voice-ws.server)、`modules/quota/quota.service.ts`。

## 二、错误码 → 用户文案映射(UI 层与 VoiceClient 共用一份,勿写两处)

| code | 场景 | 用户文案 | 动作 |
| --- | --- | --- | --- |
| `token_expired` | HTTP 401 | (静默) | 刷新后重试一次 |
| `token_invalid` / `unauthorized` | HTTP 401 | 「登录已失效,请重新登录」 | 跳登录 |
| `token_reused` | 401/通知 | 「账号已在其他设备登录,本设备已安全下线,请重新登录」 | 与 Rust auth.rs SessionKicked 既有文案对齐;不重试 |
| `banned` | HTTP 403 | 「账号已被封禁」+「前往申诉」 | 状态行红点,不提供重试,语音入口置灰 |
| `voice_ticket_invalid` | WSS 握手 401 | 「连接不稳定,正在重试…」 | 重新换票再试一次;仍失败「请稍后再试」 |
| `quota_exceeded` | HTTP 402 / WSS error 帧 | 「本月{功能名}额度已用完」 | 展示剩余/重置时间(resetsAt 取 402 details 或 WSS details,**响应头只有 remaining**),按钮「兑换更多额度」→账号页兑换码入口 |
| `rate_limited` | HTTP 429 | 「请求太频繁,请稍后再试」 | 按 retry-after 退避 |
| `ise_disabled` | HTTP 403 | (不提示) | 隐藏评测入口 |
| `voice_not_configured` | 503 / error 帧 | 「语音功能暂未开通」 | — |
| `voice_text_too_long` | TTS error 帧 | (内部处理) | 按句拆分重发 |
| `voice_invalid_state` / `voice_session_too_long` | ASR error 帧 | 「单次最长 60 秒,请重新开始」 | 修状态机 |
| `upstream_error` / `upstream_timeout` | 502/504/error 帧 | 「服务暂时不可用,正在重试」 | 重试 1 次,仍失败「请稍后再试」 |
| WSS 1006 等意外断开 | 网络抖动 | 「网络中断,正在重连…」 | 指数退避:重换票→新连接;ASR 重连后重新 start |

通用:文案不出现 HTTP 状态码、协议术语、「(本地时区)」等实现说明。

## 三、语音页交互契约(定稿核心)

1. **信息架构**:复刻「模型服务」页双栏单选同构(provider-workspace,左列 0.92fr 选择、右列 1.08fr 配置,`Settings.tsx:547-613` 参考)。左列:「沉浸云语音」官方大卡(platform-card 视觉)+「自带凭据 · 高级」分组下的讯飞行;右列随选中切换。
2. **数据**:新增独立字段 `voiceProvider: "gateway" | "xfyun"`(与 LLM providerId 解耦),**即时保存**(点卡即写盘,不经底部保存条,与讯飞凭据卡一致),且不纳入云同步(2026-10-28 决策 6)。
3. **迁移推断**:任一讯飞凭据存在(iseCredsConfigured() || xfyunTtsCredsConfigured() || ASR 等价判定,注意高级覆盖可不配主凭据)→ 默认保持 `xfyun`(零感知);否则默认 `gateway`。
4. **登录自动切云**(2026-10-28 决策 1):沉浸云**登录成功的瞬间**自动把 voiceProvider 写为 `gateway`,对用户可见(卡片选中态变化 + 轻提示「已切换为沉浸云语音」),讯飞凭据保留可切回。未登录的存量讯飞用户维持迁移推断结果。
5. **消费点路由守卫(硬性契约,防存量回归)**:`voiceProvider=gateway` 仅在「已登录 && 能力可用 && 未配额耗尽」时对消费点生效;不满足时——TTS **静默回落 edge/本地引擎**并在抽屉/toast 标注「已临时使用 Edge 朗读」(edge 是存量默认免费引擎,`readerTypes.ts:308` 默认 edge);ASR/ISE 入口按态禁用并给「登录沉浸云即用」引导。`LiveCaptionApp.tsx:106-108`、`SpeakView.tsx:615-618` 现在硬性要求讯飞凭据并弹讯飞专属文案,必须扩出 gateway 分支。
6. **状态机**(沉浸云卡):未登录(琥珀点+「登录沉浸云语音即用」+登录按钮)/ 登录中 / 能力下发中(skeleton)/ 可用 / 部分可用(iseEnabled=false→隐藏跟读入口;asrLanguages 空→「暂未开放」;ttsVoices 空→音色行降级)/ 未开通(voice_not_configured)/ 配额耗尽(余量条+「兑换更多额度」)/ 网络失败(重试)/ 封禁(红点+「前往申诉」,无重试)/ 官方云未开放(platformBase===null:左列只渲染讯飞行,页头保留现文案)。
7. **能力 UI**:云模式右列=音色选择器(ttsVoices)+识别语种 chips(asrLanguages,不做选择器,语种由消费场景决定)+跟读打分开关(iseEnabled)+配额余量条(服务端字段上线后常驻,之前 402 事件式)+一键测试。切到讯飞 BYOK 时这些控件不可见,右列回归讯飞三件套(现 `XfyunVoiceSection` 内容,含服务状态灯与高级覆盖折叠,原样保留)。
8. **一键测试**:三行灯(跟读打分/云端朗读/口语识别)+ msg-bar 汇总。云模式:用打包的真实英文语音样本(见下)打 ISE 验全链路(会耗 1 次评分额度)、TTS/ASR 各自轻量探测;结果行内可单独重测。讯飞模式:保留现有三灯探测逻辑。
9. **测试样本资产**:`immersive-translator-windows/src/assets/voice/ise-test-sample.pcm`——16k/16bit/单声道 PCM 裸流,1-2 秒(32-64KB),内容为一句固定英文(可用 Windows SAPI 本地合成后剥离 WAV 头得到,服务端云 TTS 样本后续可替换,格式不变)。
10. **兑换码入口**(2026-10-28 决策 5):账号页(Settings「账号」tab)新增兑换码卡片:输入框+提交,错误文案映射 `REDEEM_CODE_NOT_FOUND/EXPIRED/USED`(服务端 `POST /v1/redeem` 已存在,`redeem.controller.ts`);语音页「兑换更多额度」按钮 → 切到账号 tab 并聚焦/滚动到该卡片。

## 四、VoiceClient 模块契约

位置 `immersive-translator-windows/src/lib/voice/`,UI 层不接触帧协议。至少导出:
- `getVoiceCapabilities()`——拉 me/config 的 voice 段(含配额,若服务端已下发);
- `startStreamingAsr(lang, onInterim, onFinal, onError)` / `pushAudioChunk(pcm)` / `stopAsr()`——ticket 现调现用、断线指数退避重连、final 后同连接续会话;
- `synthesize(text, voice?, volume?, onChunk, onEnd, onError)`——mp3 分片回调、>8000 字节自动按句拆分;
- `transcribeBatch(lang, pcmBase64)`、`evaluatePronunciation(refText, lang, pcmBase64)`;
- `voiceErrorMessage(code)` 等错误映射工具(映射表唯一来源,见本文第二节);
- 录音重采样:设备采样率(44.1k/48k)→16k 单声道 16bit 的重采样工具函数。

约束:复用既有沉浸云令牌存取与刷新串行机制;不新增 npm 依赖(浏览器原生 WebSocket/JSON/base64 足够);旧讯飞直连路径(`iseCredentials.ts` 一族与消费点讯飞分支)**零改动保留**。

## 五、全项目硬约束

- **零回归**:存量 Edge 免费朗读用户、纯讯飞用户升级后第一天行为不变。
- 不 git commit、不改版本号、不加无关依赖;改动保持可审查(小步、贴近现有代码风格,注释密度随现状)。
- 界面文案简体中文;错误按 code 映射,不透传原始 message;录音不落盘缓存。
- TypeScript 严格模式,新代码过 `tsc` 与 `vitest run`。
