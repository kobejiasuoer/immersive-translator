# 立项 prompt · 阅读室朗读抽屉 ttsProvider 语义升格(云音色跟随语音页)

> 修订 2026-10-28(第二版):语音网关主批次已落地,本 prompt 依赖的模块已全部存在,原「先 mock 联调」的说法作废。
> 用法:新开会话,把下面整个代码块的内容发给 agent。仓库根:`D:\workspace\immersive-translator`(客户端),服务端:`D:\workspace\immersive-translator-server`。

````
# 任务:阅读室朗读引擎「云音色」语义升格

Windows 应用(React + Tauri,immersive-translator-windows/)的语音网关主批次已上线:语音设置页有 voiceProvider("gateway" | "xfyun") 双栏选择,沉浸云登录成功自动切 gateway,官方网关客户端 src/lib/voice/ 已可真连。但阅读室的朗读引擎选择 ttsProvider 仍是独立枚举(默认 "edge"),三路 dispatcher(edge / 讯飞+凭据 / 否则 SAPI)未接网关。本项目把朗读抽屉里的「讯飞」档位升格为「云音色」:来源跟随语音页的 voiceProvider(gateway→官方网关流式 TTS;xfyun→存量讯飞路径),edge/SAPI 保持本地引擎不变。

## 第一步:核实现状(以下行号是主批次落地后的线索,以实际代码为准)
- src/views/Settings.tsx 语音分区 + src/views/VoiceSettingsTab.tsx / GatewayVoiceSection.tsx:语音页双栏选择、沉浸云卡、能力 UI(音色选择器)、一键测试。
- src/lib/voice/:index.ts(导出 synthesize 等)、voiceRoute.ts(守卫:gateway 仅在「已登录 && 能力可用 && 未配额耗尽」时生效,含回落原因)、voiceErrors.ts(错误文案映射)、gatewayViewState.ts(状态机归约)。EDGE_FALLBACK_NOTICE 常量已定义但当前无消费方(本项目的验收点之一就是让它变活)。
- src/views/Settings.tsx:登录成功瞬间自动切 gateway + 轻提示(已上线,朗读侧据此自然跟随,不做第二套切换)。
- src/reader/readerTypes.ts(约 :308):ttsProvider 枚举与默认值(默认 "edge");src/reader/ReaderApp.tsx(约 :404-411):三路 dispatcher;src/reader/speechEngine.ts:朗读引擎实现;阅读室设置抽屉 SettingsDrawer.tsx:存量「讯飞凭据」文案与配置入口(grep ttsProvider 定位全部触点)。
- 契约与决策:D:/workspace/immersive-translator/docs/voice-cloud-implementation-contract-2026-10-28.md、docs/voice-cloud-decisions-2026-10-28.md。

## 目标形态
1. 朗读抽屉的引擎选择从「Edge / 讯飞 / 系统语音」改为「Edge / 云音色 / 系统语音」三档:
   - 「云音色」档:来源跟随语音页 voiceProvider。gateway 时经 src/lib/voice 的 synthesize 流式播放(mp3 分片,首片即播),音色默认取语音页所选音色,抽屉内不重复配置,给一句说明 + 「去语音页配置」跳转;xfyun 时走存量讯飞合成路径,零改动。
2. 枚举处理:建议新增 ttsProvider: "cloud" 值并把存量 "xfyun" 值迁移为 "cloud"(仅当该用户讯飞凭据存在或已登录沉浸云),而不是把 "xfyun" 语义原地改写;迁移谓词与语音页迁移规则一致(任一讯飞凭据存在→云朗读仍可用)。最终方案你核实代码后定,但必须写清存量 ttsProvider="xfyun" 用户的迁移路径与零回归论证。
3. 路由守卫(硬性契约):选「云音色」但守卫不通过(未登录沉浸云 / 能力不可用 / 配额耗尽)时,朗读静默回落 edge 并用 EDGE_FALLBACK_NOTICE 提示「已临时使用 Edge 朗读」;不弹登录墙、不报错中断阅读。
4. 配额耗尽时的朗读侧提示带重置时间(resetsAt)与「兑换更多额度」动作(复用语音页同一套错误映射与跳转,消费范式参考主批次在 SpeakView/LiveCaptionApp 的改造)。

## 硬性约束
- 存量 Edge 免费朗读用户零回归:默认值、行为、文案不变;纯讯飞用户(未登录沉浸云)行为不变。
- 官方网关协议要点已封装在 src/lib/voice,本项目不得绕开它直连网关或讯飞上游;>8000 UTF-8 字节长文按句拆分由 synthesize 内部处理,朗读侧按句喂即可。
- 界面文案简体中文,错误按 code 映射,不透传原始 message。
- 不 git commit、不改版本号、不新增 npm 依赖;新代码过 tsc 与 vitest(客户端目录:node node_modules/vitest/vitest.mjs run 与 node node_modules/typescript/bin/tsc)。
- 与代码现状冲突时以代码为准,并写进交付说明。

## 交付
1. 实施方案:枚举与迁移、dispatcher 改造点、抽屉 UI 改动清单、与语音页/voice 模块的接口契约,全部引用 file:line。
2. 代码实现 + 单测(迁移谓词、dispatcher 路由含守卫回落),跑通客户端全量 vitest 与 tsc。
3. 验证说明:三类用户(edge 默认 / 仅讯飞凭据 / 已登录沉浸云)升级后各自的第一天行为;EDGE_FALLBACK_NOTICE 从死代码变为有消费方的确认。
````

## 口径说明(为什么这样设计)

- **「云音色」是档位名,不是第四个供应商**:朗读抽屉不再问「用谁家的语音」,来源是语音页的事——与语音页「官方云在上、BYOK 在下」同一心智。
- **新增 "cloud" 值而非原地改写 "xfyun"**:枚举语义变更最易埋迁移事故,新增值 + 显式迁移谓词可论证、可测试。
- **守卫回落是最大风险点**:EDGE_FALLBACK_NOTICE 已在主批次预埋,本项目验收点就是它变活;零回归论证落在交付物里。
- **无外部阻塞**:VoiceClient/守卫/自动切云都已落地,本立项可直接真连(真实联调需预发环境,其余可本地完成)。
