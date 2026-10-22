# 沉浸阅读室移动端 UI 审计 · 统一实施计划

- 日期：2026-10-20 · 基线 commit：`93f5f55` · 对象：`immersive-translator-mobile/`
- 输入：四路审计——优先级清单（P-01…P-21，26 条原始发现合并）、风格规范 `docs/mobile-ui-audit/style-spec.md`（N-1…N-6）、动效方案 `docs/mobile-ui-audit/motion-plan.md`（M-01…M-12 + O-01…O-03，O-04 已定案不做）、平台无障碍 `docs/mobile-ui-audit/platform-a11y.md`（PA-01…PA-17）
- 本文将四来源 59 条合并去重为 **51 条**（U-01…U-51），原编号保留在「来源」中可回溯；关键行号已于基线抽查核验（记录见文末附录 A）。
- 冲突裁决总原则：**风格与无障碍冲突时，以无障碍为准**（逐条落点见 §4）。

## 0. 总评

实现与候选 A「静气·纸感」定稿整体保真度高：令牌取值、push/sheet/横幅外壳契约、已定案动效大项（push 320ms、sheet 280ms、tab 160ms、reduced-motion 全局兜底）均逐项落地，且无过度动效、无 `transition: all`。问题集中在三条主线：①两条「铁律」的横切执行纪律——触控热区 ≥44×44 与输入/正文 ≥17px 被内联样式和文字 span 打破，录音停止、生词笔记生成、今天页主入口等主流程唯一入口在列；②a11y 语义层系统性缺口——可点 span/整卡 div 无按钮语义、全部选择态无编程语义、18 处输入无标签、toast/横幅对读屏静默、sheet 与 push 层无 dialog 边界；③动效「规格已写、实现未播」——横幅 400ms 弹入从未播放、识别卡翻面 240ms 硬切、触感规格 7 处缺 4 处，外加连播逐句强制瞬时居中这一个真实时序问题。平台侧最大风险是横屏已启用但全库零 `safe-area-inset-left/right`（P0），其余为讯飞凭据明文落 localStorage、缩放通道全断（WCAG 1.4.4 不闭合）等点状但明确的缺陷。建议按 §3 四批执行：地基（令牌/viewport/原生配置）→ 组件层（base.css/kit/sheets/store）→ 各屏 → 真机验证专项。

---

## 1. 优先级总表

> P0 立即修（本迭代开工前必须清掉）/ P1 本迭代 / P2 打磨。每条自包含：编号（含来源）、标题、位置、问题、修法、验收。

### 1.1 总览

| 编号 | 优先级 | 域 | 标题 | 主位置 |
|---|---|---|---|---|
| U-01 | P0 | a11y·high | 文字 span/整卡 div 充当交互件：热区 18–21px 且无按钮语义 | `src/ui/base.css:180` |
| U-02 | P0 | platform·high | 设置五屏 6 处输入内联 14/15px，违反输入 ≥17px 铁律 | `src/screens/SettingsScreens.tsx:106` |
| U-03 | P0 | style·high | 阅读器中文模式正文硬编码 14px，Aa 字号档失效 | `src/screens/ReaderScreen.tsx:346` |
| U-04 | P0 | platform·high | 横屏已启用但全库零 safe-area-inset-left/right | `src-tauri/gen/apple/project.yml:46` |
| U-05 | P0 | motion·high | 通知横幅 400ms 弹入/收起从未播放，进出场 0ms 硬切 | `src/App.tsx:370` |
| U-06 | P0 | motion·high | 连播每句强制瞬时居中，阅读流被逐句拽动 | `src/screens/ReaderScreen.tsx:68` |
| U-07 | P1 | style·medium | rd-black 作用域越出正文区 + 漏 --accent（对比度 2.7:1） | `src/ui/tokens.css:81` |
| U-08 | P1 | a11y·medium | 实体控件热区清扫（横幅/Aa/开关/chip 等 14 处 <44×44） | `src/ui/base.css:629` |
| U-09 | P1 | a11y·medium | --ink-4 用于状态/结果文案（未配置引导、跟读差词） | `src/screens/ReaderScreen.tsx:358` |
| U-10 | P1 | a11y·medium | 深色主题口语气泡译文 2.74:1 | `src/ui/base.css:1791` |
| U-11 | P1 | platform·medium | 讯飞三件套凭据明文落 localStorage，与钥匙串承诺双标 | `src/screens/SettingsScreens.tsx:287` |
| U-12 | P1 | style·medium | 连播当前句 accent-soft 底色 → 页边 2px 墨线 | `src/ui/base.css:1130` |
| U-13 | P1 | style·medium | 翻译结果页字规偏离：原文 15px 黑体、fail 态译文 16px | `src/ui/base.css:1422` |
| U-14 | P1 | style·medium | 快速复习完成态文案自相矛盾（「还剩 0 张·都在提醒里」） | `src/screens/QuickReview.tsx:93` |
| U-15 | P1 | a11y·medium | viewport 禁缩放 + 正文缩放零通道（WCAG 1.4.4 不闭合） | `index.html:5` |
| U-16 | P1 | platform·low | HTML 无首帧主题处理，深色冷启动闪白一帧 | `index.html:1` |
| U-17 | P1 | a11y·medium | sheet 与 push 层缺 dialog 语义/inert，读屏可穿层 | `src/ui/sheets.tsx:106` |
| U-18 | P1 | motion·medium | 识别卡翻面/评分组硬切，规格 240ms 未实现 | `src/screens/ReviewScreen.tsx:320` |
| U-19 | P1 | motion·medium | 触感规格 7 处只落地 3 处 | `src/screens/ReviewScreen.tsx:192` |
| U-20 | P1 | motion·medium | 列表删除零离场/新增零入场，行瞬移 | `src/ui/kit.tsx:85` |
| U-21 | P1 | motion·medium | sheet 下拉只认抓手条 + 快速轻扫速度分支缺失 | `src/ui/sheets.tsx:88` |
| U-22 | P1 | motion·medium | toast 给 sheet 让位瞬移（bottom 内联直写） | `src/store.ts:855` |
| U-23 | P1 | motion·medium | 八类高频可点控件按压态成片缺失 | `src/ui/base.css:420` |
| U-24 | P1 | motion·medium | 六个嵌套滚动容器缺 overscroll-behavior:contain | `src/ui/base.css:569` |
| U-25 | P1 | style·medium | 笔记正文 15px 无衬线，违反「衬线一页纸」与 17px 铁律 | `src/ui/base.css:2154` |
| U-26 | P1 | platform·medium | 全库无 color-scheme 声明，深色下系统控件仍浅色 | `src/ui/tokens.css:8` |
| U-27 | P1 | a11y·medium | 18 处输入控件无编程关联标签 | `src/ui/sheets.tsx:513` |
| U-28 | P1 | a11y·medium | 全部选择态无编程语义 + 行式 radio 对勾墨色 | `src/ui/kit.tsx:51` |
| U-29 | P1 | a11y·medium | toast/横幅无 live 语义，动态消息对读屏静默 | `src/store.ts:861` |
| U-30…U-51 | P2 | 各域 | 打磨批（22 条，见 §1.5） | — |

> **复核标注**（2026-10-20 独立复核）：重点条目 U-01…U-09、U-11 共 10 条已逐条证实（verdict 全部 verified），标注见各条目「复核」行；U-15/U-17 未在本轮复核范围，维持 pending。结论汇总见附录 B。

### 1.2 P0 立即修（6 条）

#### U-01（＝P-01＋PA-12）文字 span/整卡 div 充当交互件：热区仅 18–21px 且无按钮语义，横切多屏并波及主流程唯一入口
- **位置**：`immersive-translator-mobile/src/ui/base.css:180`（.tlink 无 padding/min-height，已实读核验）；最重处 `src/screens/CaptionScreen.tsx:407`（录音 FAB 卸载后唯一停止入口是 ：325 的 15px 文字链）、`src/screens/VocabScreen.tsx:130/:138`（「整理成笔记」13px span，已核验）、`src/screens/TodayScreen.tsx:132-178`（剪贴板动作）及 `:47/:99-117/:129/:181/:194/:202/:209`（引导条/继续阅读卡/拍译/练一练三入口）、`src/screens/QuickReview.tsx:108-117/:153-165/:229-231`、`src/screens/PracticeScreen.tsx:52-61`、`src/screens/ReviewScreen.tsx:322-324/:436/:439/:513/:516`、`src/screens/ShelfScreen.tsx:67`、`src/screens/TranslateScreen.tsx:182`、`src/screens/OnboardingScreen.tsx:124/:153`、`src/screens/ReaderScreen.tsx:381`。
- **问题**：交互动作以无热区扩展的文字 span 或整卡 div 充当按钮，命中区仅为文字本身（18–21px），违反定稿 §1.5「触控热区 ≥44×44」（docs/mobile-v3-design-2026-09-24.md:120）；同时无 button 语义，VoiceOver 按纯文本播报、不可聚焦（base.css:50-55 focus-visible 不覆盖 span），复习卡「点按翻面/给点提示/直接看答案」等逃生门对读屏用户不可发现。
- **修法**：①语义层——可点 span 与整卡 div 改 `<button className="tlink">` / `<button>`（行卡用 `width:100%; text-align:left; background:none`，.row/.prow 已有先例），保留字号样式；②热区层——.tlink（base.css:180）统一加 `min-height:44px; padding:0 12px` 并以负 margin 收视觉，一次覆盖全部调用点；inline 处逐处补足（TodayScreen 动作行、QuickReview 提示/翻面/完成、VocabScreen 组头、PracticeScreen warn-chip 上下 padding 12px+负 margin），视觉尺寸不变；③`.guide`（base.css:910-922）补按压态；④例外——ReaderScreen 的 `.sent`/`.tok` 属阅读流文本语义，保留不改 button，以既有「跟读此句」等实体按钮（ReaderScreen.tsx:448）作为可发现替代路径。
- **验收**：VoiceOver 下全部交互件播报「按钮」且可聚焦激活；热区逐点 ≥44×44 而视觉尺寸不变；CaptionScreen 录音中停止入口可一键命中；`node scripts/smoke.mjs` 全绿。
- **复核**：已确认——热区 18–21px 与行高实值吻合，span→button 修法为零视觉成本最优解（base.css:35-51 已有全局 button reset + focus-visible outline，.row/.prow 有先例）；两处引用瑕疵：CaptionScreen.tsx:325 已是 `<button>`（缺热区而非语义），:407 实为开始 FAB 且 onBack（:319-322）亦可停止录音，「唯一停止入口」略夸大，不影响结论与修法。

#### U-02（＝P-02，并入 PA-16 的 SettingsScreens 部分）设置五屏 6 处输入控件内联 14/15px，违反「输入 ≥17px」铁律
- **位置**：`immersive-translator-mobile/src/screens/SettingsScreens.tsx:106`（接口地址 14px，已核验同时 minHeight:34）、`:120`（模型 14px）、`:139`（API Key 15px，已核验 minHeight:38）、`:360`（Edge 音色 select 14px）、`:433`（讯飞三件套 14px）、`:512`（提醒时间 15px）。
- **问题**：六处内联 fontSize 覆盖 .input 的 17px 默认（base.css:371）；iOS WKWebView 对字号 <16px 的输入框聚焦时自动放大页面，BYOK 表单正是定稿 §1.4（docs/mobile-v3-design-2026-09-24.md:116）点名场景。
- **修法**：删除 6 处内联 fontSize，回 .input 的 17px 默认；需要紧凑行高时调 minHeight/padding 而非字号；同三行的 `minHeight:34/36/38` 内联一并去掉恢复 44（U-08 的搭车点，platform-a11y.md §4 建议）。（复核细化：:512 为无 .input 类的裸 `input[type=time]`，base.css:42 全局 reset 未设 font-size，须显式改写为 17px，不可只删——否则落 UA 默认字号。）
- **验收**：`grep -n "fontSize" src/screens/SettingsScreens.tsx` 无 <17 内联值；真机聚焦六个输入框页面均不自动放大。
- **复核**：已确认——六处实测 inline fontSize=14/15/15/14/14/15、minHeight 34/34/38/36/36 属实（grep 恰 6 处命中），.input 默认 17px（base.css:364，:363 注释即「≥17px 铁律 §1.4」）；index.html:5 无 maximum-scale，无法压制聚焦放大，high 恰当。

#### U-03（＝P-03）阅读器中文模式正文硬编码 14px，且 Aa 字号档对其完全失效
- **位置**：`immersive-translator-mobile/src/screens/ReaderScreen.tsx:346`（`style={{ fontSize: 14 }}`，已核验）；`src/ui/base.css:1142-1148`（.sent-zh 14px/22px，已核验）。
- **问题**：Aa 面板切「中文」模式后英文行隐藏（ReaderScreen.tsx:472 + base.css:1149），正文只剩 14px 中文行，低于「正文最小 17px」铁律（docs/mobile-v3-candidate-a.md:131）；Aa 字号档 15–24（sheets.tsx:369-373）只绑定英文行，中文模式下点「增大」数字变、正文纹丝不动，与面板自述「字号与主题只影响阅读正文」（sheets.tsx:419 附近）矛盾。
- **修法**（style-spec §10.1）：①删 ReaderScreen.tsx:346 的 14px；②正文容器（ReaderScreen.tsx:327-328）inline 增加 `--rd-fs: ${prefs.fs}px`（`as React.CSSProperties`）；③base.css `.sent-zh` 改 `font-size: max(17px, calc(var(--rd-fs, 19px) * 0.85)); line-height: 1.5;`，保留 ink-3 色与遮罩 transition。
- **验收**：三种显示模式下点 Aa「增大/减小」中文行同步变化且恒 ≥17px（默认 19 档=17px、24 档=20px）；遮罩 blur 不受影响；smoke 全绿。
- **复核**：已确认——14px 硬编码、prefs.fs 只绑 .sent-en（:472）、.rd-hidden-en 隐藏英文行后中文模式 Aa 完全无可见效果均属实，--rd-fs 挂点（:328 既有 style）可行且 iOS 16 支持 max/calc/var；保留：17px 铁律明文仅约束输入框（base.css:5/:363），正文 17px 论据属延伸，但 Aa 在中文模式整体失效的功能缺陷足以支撑 high。

#### U-04（＝PA-01）横屏已启用但全库零 `env(safe-area-inset-left/right)`，刘海横屏下正文与控件切入遮挡区
- **位置**：`immersive-translator-mobile/src-tauri/gen/apple/project.yml:46-53`（iPhone 三向/iPad 四向，已核验）；`src-tauri/gen/apple/imreader-mobile_iOS/Info.plist:52-64`；横向 padding 全为固定值：`src/ui/base.css:71`（.pane 左右 20px）、`:504`（.pbody）、`:1118`（.rd-body 24px）、`:1656`（.cam-bottom 左右 44px）。
- **问题**：grep 全库（src/ + src-tauri/）`safe-area-inset-left|right` 0 命中（本轮实跑确认）；带刘海 iPhone 横屏左右 inset 47–59px，阅读正文、翻译页、拍译相册/翻转按钮一半进入遮挡区。
- **修法**（二选一，推荐①）：①横屏非产品场景则 project.yml 与 Info.plist 收敛为仅 Portrait（iPad 保留 Portrait+UpsideDown），一行配置消除整类问题；②保留横屏则在 tokens.css `:root` 定义 `--safe-x` 两侧变量 `max(20px, env(safe-area-inset-left/right))`，让 `.pane/.pbody/.rd-body/.cam-bottom` 消费。
- **验收**：①方案——构建配置 grep 确认无 Landscape 声明；②方案——刘海真机横屏下各屏正文与按钮完整可见（真机项，见 §3 批次 4）。
- **复核**：已确认——横屏配置（project.yml:45-53、Info.plist:52-64）、safe-area 左右全库 0 命中、四类横向 padding 固定值均实读属实；viewport-fit=cover 与 env(top/bottom) 消费已在位，方案②有现成模式可循；横屏非产品场景时方案①（收敛竖屏）更优。

#### U-05（＝M-01）通知横幅 400ms 弹入/收起从未播放——挂载即终态，进出场全是硬切
- **位置**：`immersive-translator-mobile/src/App.tsx:370-371`（JSX 首插即带 `.on`，已核验；:382 关闭钮 28×28 内联）；`src/ui/base.css:601-617`（400ms translateY(-140%) CSS 已写好）；`src/store.ts:804-819`。
- **问题**：新元素无样式变化过程，transition 不运行；关闭直接卸载无离场——全 app 唯一通知面进出场 0ms 硬切，违反规格「通知横幅｜顶部弹入 400ms」（docs/mobile-v3-design-2026-09-24.md:140）。
- **修法**（motion-plan M-01，只改 App.tsx，CSS 零改动）：新增 BannerHost 组件，挂载时无 `.on`、双 rAF 后加 `.on` 播 400ms `var(--ease)` 滑入；关闭先摘 `.on`、420ms 后卸载；「稍后」先 close 再 snooze；「先清一张」先 close 再 `nav.push("quick")`（320ms push 与 400ms 收起并行）；60s 自动收起走同一离场路径（经 BannerHost 的 close）。
- **验收**：触发到期横幅（可临时把 App.tsx:246 的 8000ms 调短验证后还原）：弹入/三处关闭路径/60s 超时均有 400ms 进出场；DevTools Animations 10% 倍速逐帧核对起始位与曲线；连续「稍后→再触发」每次都重播。
- **复核**：已确认——首插即 `banner on`（:370-371）、关闭与 60s 定时均走 closeBanner（App.tsx:382/:218-222 → store.ts:817-818 置 null 即卸载）、CSS 400ms/translateY(-140%) 全为死值均属实；库内 toast（store.ts:861-895）已有「rAF 进场 + 摘类后延时卸载」同款套路可参照，CSS 零改动可行。

#### U-06（＝M-02）连播朗读每句强制瞬时居中——阅读流被逐句「拽」
- **位置**：`immersive-translator-mobile/src/screens/ReaderScreen.tsx:68-75`（`scrollToSent` 无条件 `scrollIntoView({block:"center"})` 无 behavior，已核验）；调用点 `:104`（stepTo 连播推进）、`:131`（playFrom）。
- **问题**：目标句已在视口内也会滚，且瞬时跳变——用户读别处时页面每 3-5 秒被拽一次，旗舰阅读流滚动位置失控。
- **修法**（motion-plan M-02）：目标句在视口 25%–65% 舒适带内则不滚；带外才 `scrollIntoView({block:"center", behavior: reduce ? "auto" : "smooth"})`（显式 matchMedia 分支）；断点恢复/词典定位两处调用传 `instant=true` 保留瞬时落位。
- **验收**：连播对准一句后不再逐句跳动，仅高亮句滚出带外时平滑回中；手动滚走再点播放首句平滑居中；断点恢复/点词定位仍瞬时；reduced-motion 用户走 auto。
- **复核**：已确认——:73 无 behavior 且无条件执行、全库 scrollIntoView 单点收口、断点恢复/词典定位/上下句共用此函数（instant=true 分支有真实落点）均属实；「每 3-5 秒」为按句速估计值（实际节奏由 TTS onend 驱动）；全库无 scroll-behavior:smooth（默认 auto 即瞬时），且 JS 滚动不受 base.css:2542 reduced-motion 兜底管辖——显式 matchMedia 分支确有必要。

### 1.3 P1 本迭代（23 条）

#### U-07（＝P-04）rd-black 阅读主题作用域越出正文区，且漏覆盖 --accent 致交互文字对比度约 2.7:1
- **位置**：`immersive-translator-mobile/src/App.tsx:356`（rd-black 挂 push 根，已核验）；`src/ui/tokens.css:81-92`（.rd-black 只重定义 --accent-soft，缺 --accent，已核验）；正文容器 `src/screens/ReaderScreen.tsx:327`。
- **问题**：纯黑把顶栏、进度线、播放条一起染色，违反定稿 §1.2「阅读主题只影响阅读正文区」（docs/mobile-v3-design-2026-09-24.md:84）；浅色全局+纯黑正文下「翻译这句/重试」链接（base.css:181、ReaderScreen.tsx:381）与词块点状下划线（base.css:1169）用墨蓝 #2b567f 落 #000，对比度约 2.7:1（platform-a11y §1.4 脚本复核一致）。
- **修法**（style-spec §10.2）：①App.tsx:356 删 rd-black 拼接（rdBlack 变量一并清理）；②ReaderScreen.tsx:327 正文容器改 `pbody rd-body ${topic==="black" ? "rd-black" : ""} …`，并在 `.rd-body`（base.css:1117-1119）补 `background: var(--bg)`；③tokens.css .rd-black 按 style-spec §1.3 表补 `--accent:#8fb3d4` 与防御项 `--on-ink/--ok/--warn/--err`。
- **验收**：纯黑主题下顶栏/2px 进度线/播放条保持全局主题；正文区全黑；链接与下划线取 #8fb3d4（对 #000 ≈9.6:1）；词典卡配色不受影响。
- **复核**：已确认——.rd-black 确无 --accent、push 根染色路径（base.css:461 push background:var(--bg)）属实，对比度经 node 实算（#2b567f 落 #000 = 2.74:1，修法色 #8fb3d4 = 9.57:1）；一处瑕疵：「重试」实为 .chip 用 --ink-2（#b0aeab，9.49:1）不受影响，受影响的是 .tlink 链接与 .tok 点状下划线，主体结论成立；medium 恰当（深色全局下 --accent 已是亮蓝，仅浅色全局+纯黑组合失守）。

#### U-08（＝P-05＋PA-16＋N-6）实体控件热区清扫：14 处 <44×44
- **位置**：`immersive-translator-mobile/src/ui/base.css:629`（.bbtn 高 34）、`src/App.tsx:382`（横幅关闭钮内联 28×28，已核验）、`src/ui/base.css:2418-2425`（Aa 步进 36×36）、`src/screens/TodayScreen.tsx:66-72`（先清一张 height:40）、`src/screens/VocabScreen.tsx:61-68`（笔记库 iconbtn 40×40 覆写）、`src/screens/MiscScreens.tsx:353/:421-427`（取消钮 32×32）、`src/ui/base.css:1794-1797`（.spk 30×30）、`:227-252`（.switch 50×30，已核验）、`:203-226`（.seg 高 36）、`:1479-1493`（.chip ≈32）/`:2486-2489`（exam-chips ≈29）、`:2444-2451`（import-tabs ≈38）、`src/main.tsx:67`（回今天 height:40）。
- **问题**：违反定稿 §1.5「触控热区 ≥44×44」与候选 A §2.6「视觉 28、热区 44」；横幅「先清一张」主操作易误触。全部 ≥24px，WCAG 2.5.8 AA 通过，按定稿基线记。
- **修法**：统一手法——base.css 三处（.bbtn/.aa-steps）用透明 padding/伪元素扩热区到 ≥44，视觉维持现状；App.tsx:382 与 VocabScreen.tsx:64、MiscScreens.tsx 两处去掉小尺寸覆写恢复 .iconbtn 44 默认（负 margin 抵消位移）；TodayScreen.tsx:68 height 40→44；main.tsx:67 去 height:40；.spk/.chip/.import-tabs 用 44×44 透明伪元素（以不碰撞为限）；.switch 用 `::before{position:absolute;inset:-7px}` 扩至 64×44（style-spec N-6）；.seg 高 36 为已批准例外不调（style-spec §3）。
- **验收**：清单逐项实测命中区 ≥44×44、视觉尺寸不变、行布局零位移；与 U-23 的 :active 叠加验证。
- **复核**：已确认——14 处逐点量过均 <44（.bbtn 34、.aa-steps 36×36、.switch 50×30、.spk 30×30、.chip≈32、.import-tabs≈38、关闭钮 28×28、先清一张/回今天 height:40、取消钮 32×32 等）；.iconbtn 默认即 44×44（base.css:189-190）去覆写即恢复，.switch 本就 position:relative（base.css:232）可挂 ::before 扩区；全部 ≥24px 过 2.5.8 AA，medium 恰当。

#### U-09（＝P-06＋PA-14）--ink-4 用于状态/结果文案，两主题对比度不达标
- **位置**：`immersive-translator-mobile/src/screens/ReaderScreen.tsx:358`（「未配置模型服务·无译文产出」13px）、`src/screens/TranslateScreen.tsx:254/:267`（连接引导与状态行 16px）、`src/ui/base.css:1969-1972`（.sh-words .w-miss 跟读漏读词 22px，已核验）。
- **问题**：--ink-4（浅 2.12 / 深 3.07:1，脚本实测）被定稿 §1.2 限定「仅禁用与装饰」，这些行是状态/评测结果的唯一说明文字，两主题均 <4.5:1。
- **修法**：三处改 `--ink-3`（浅 4.90 / 深 5.25，token 已存在）；.w-miss 保留 line-through 非颜色线索，层级区分改字重；ink-4 保留给真占位（如 TranslateScreen.tsx:285「等待输入」）。
- **验收**：node 对比度脚本对三处新值两主题复测 ≥4.5:1；U-13 修复时 TranslateScreen 同点双修不遗漏。
- **复核**：已确认——三处 ink-4 与对比度数字（ink-4 浅 2.12/深 3.07，ink-3 浅 4.90/深 5.25）实测一致，:285「等待输入」真占位留 ink-4 正确；重要补充：.w-miss 当前无元素命中（全库唯一 w-* 挂载点 ShadowScreen.tsx:256 只产出 w-err/w-ok），属死样式——修复仍应做以防回潮，验收按「若接线即合规」口径。

#### U-10（＝PA-15）深色主题口语气泡译文 2.74:1
- **位置**：`immersive-translator-mobile/src/ui/base.css:1791-1793`（`[data-theme=dark] .bubble.me .zh { color: var(--ink-3) }`，已核验）；气泡底深色反转为浅色 `--ink`=#ece7dd（:1784-1790）。
- **问题**：深色下「我」的气泡是浅底，ink-3（#938b7c）落 #ece7dd 实测 2.74:1（12px 需 4.5:1），自己发言的中文译文几乎不可读；浅色无双色反转故无此问题，属深色适配漏项。
- **修法**：深色分支改墨色降透明 `color: rgba(26,24,21,.66)`（混出 ≈5.24:1）或实色 `#666258`（4.94:1）；并把该色对加入定稿 §6.4 对比度复测清单。
- **验收**：脚本复测 ≥4.5:1；浅色主题视觉不变；深色下口语聊天译文清晰可读。

#### U-11（＝P-07）讯飞三件套凭据明文落 localStorage，与「Keychain 存储」承诺及模型 Key 处理双标
- **位置**：`immersive-translator-mobile/src/screens/SettingsScreens.tsx:287`（updVoice 持久化）、`:431-439`（三件套输入无 type、无显隐切换）、`:443`（文案「仅存本机」）；`src/store.ts:260`（setSettings 只脱敏 apiKey）。
- **问题**：同屏双标——模型 Key 有 password type + eye 显隐（:140-153）+「存在系统钥匙串」文案（:158），讯飞 appid/key/secret 明文落 localStorage；定稿 #22 明确语音服务子页「Keychain 存储」（docs/mobile-v3-design-2026-09-24.md:347）。
- **修法**：三件套沿用模型 Key 的钥匙串路径（store.ts:547-576 secret_put 模式，account 另起三件键名），输入框加 `type=password` + eye 显隐（复用 ：146-153 模式），文案与钥匙串状态对齐。
- **验收**：DevTools Application 面板确认 localStorage 无讯飞明文凭据；真机卸载重装后凭据经钥匙串恢复语义与模型 Key 一致；显隐切换可用。
- **复核**：已确认——明文落盘路径属实（store.ts:260 persistable 仅脱敏 apiKey，:384/:400 原样 JSON 写 localStorage）、钥匙串 secret_put 无键名白名单（src-tauri/src/keychain.rs:18）可复制、SettingsScreens.tsx:474「凭据…不落盘」文案与实际落盘自相矛盾；medium 恰当（暴露面限本机/备份提取，无远程攻击面，高于文案类 low）。

#### U-12（＝P-08）连播当前句用 accent-soft 整句底色，违反「页边 2px 墨线」明文决策并与生词标注叠层
- **位置**：`immersive-translator-mobile/src/ui/base.css:1130-1132`（.sent.playing 底色，经 ReaderScreen.tsx:339 触达）。
- **问题**：与「当前句只以页边距处一根 2px 墨线标记，不用底色」（docs/mobile-v3-candidate-a.md:23 V5、:271 §4.6）相抵；且与同行 tok.known 底色（base.css:1171-1173，同为 accent-soft）叠成两层标注，违反「同一行至多一种标注」。
- **修法**（style-spec §10.3）：.sent 加 `position:relative`，`.sent.playing::before` 绝对定位 `left:-24px`（对应正文 24px 边距）画 2px 宽 accent 竖线；删原底色规则与 border-radius/transition。
- **验收**：连播当前句无底色、仅页边一根 2px 墨蓝竖线；与已收藏词同句时整行只有一种标注；纯黑主题下墨线随补全的 --accent 可见；多行中文句墨线纵贯整句块。

#### U-13（＝P-09）翻译结果页文字规格偏离契约：原文区 15px 黑体、失败态译文缩到 16px
- **位置**：`immersive-translator-mobile/src/ui/base.css:1422-1428`（.tr-src 15px 黑体）、`:1429-1434`（.tr-zh 19px 衬线行高 32）；`src/screens/TranslateScreen.tsx:235`（fail 态 fontSize:16）、`:254/:267`（unconfigured 态 16px + ink-4）。
- **问题**：契约规定「原文区（衬线 17px，done 态点按即编辑）」（docs/mobile-v3-candidate-a.md:300），编辑态 textarea（.input 17px）反比展示态大 2px；fail/unconfigured 态译文 19px 缩到 16px，低于 17px 铁律且与 done/streaming 不一致。
- **修法**（style-spec §10.4）：.tr-src 加 `font-family: var(--font-serif)`、17px/25px（色留 --ink-2）；.tr-zh 行高 32→34（对齐 --fs-reading 19/34）；删 fail 态 fontSize:16 覆盖（失败信号由 --err 状态行承担）；unconfigured 态删 fontSize:16 并 ink-4→ink-3（与 U-09 同点双修）。
- **验收**：done 态原文 17px 衬线与编辑态同级；streaming 中「停止并保留已译」前后译文字号不变；未配置态引导句两主题 ≥4.5:1。

#### U-14（＝P-10）快速复习完成态文案自相矛盾：「还剩 0 张 · 都在今晚的提醒里」
- **位置**：`immersive-translator-mobile/src/screens/QuickReview.tsx:92-94`（done 分支固定文案）；入口空态 `:54-57` 已是「已清完，明天见」口径。
- **问题**：清完最后一张到期卡后「还剩 0 张」与「都在今晚的提醒里」同句矛盾；定稿 §3.14 规定无到期态为「已清完，明天见」。
- **修法**（style-spec §10.5）：done 分支按 `st.due === 0` 分叉——big 保持「已清 1 张」，sub 换「今天的到期都清完了 · 明天见」，仅 `st.due > 0` 保留「还剩 N 张 · 都在今晚的提醒里」（st 读的是 gradeVocab 推移后的新值）。
- **验收**：仅 1 张到期清完→「明天见」；≥2 张清完第一张→「还剩 N-1 张」；`grep -n "还剩" src/screens/QuickReview.tsx` 仅一处且在分支内。

#### U-15（＝P-11＋PA-04）viewport 带 user-scalable=no 且正文缩放零通道，低视力无任何放大手段（WCAG 1.4.4 不闭合）
- **位置**：`immersive-translator-mobile/index.html:5`（user-scalable=no，已核验）；`src/ui/base.css:20`（字阶全固定 px）、`src/ui/tokens.css:58-61`（无 -apple-system-body）、grep `text-size-adjust` 全库 0 命中。
- **问题**：WKWebView 内禁掉捏合缩放；且 WKWebView 不把动态字体应用到固定 px 文本——应用内没有任何放大正文的通道；≥17px 只是下限不是缩放机制。
- **修法**：①index.html:5 移除 `user-scalable=no`，保留 `viewport-fit=cover`；②外观页加全局「字号」档位写 `--fs-scale` 到 :root，正文类尺寸改 `calc(<size> * var(--fs-scale, 1))`（阅读页 Aa 15–24 已有先例可推广）；两条必须同批落地 1.4.4 才闭合。
- **验收**：真机捏合缩放可用；外观页字号档切换后今天页/设置页正文随动；极端 200% 下允许局部折行（取舍见 §4）。
- **复核**：未覆盖——本轮独立复核未含此条，维持 pending。

#### U-16（＝P-13）HTML 无首帧主题处理，深色用户冷启动闪白一帧
- **位置**：`immersive-translator-mobile/index.html:1`（无 data-theme 初值/内联脚本）；主题到 store 模块求值才写 DOM（`src/store.ts:1001`），:root 默认浅色纸底（tokens.css:8）。
- **问题**：深色偏好用户每次冷启动先按浅色绘制一帧。
- **修法**：index.html head 内联脚本先读持久化主题（localStorage `ita.v3.state`）或 `matchMedia("(prefers-color-scheme: dark)")`，在 CSS 绘制前设好 `data-theme`。
- **验收**：深色系统/深色偏好下冷启动无白帧；浅色路径不受影响；与 U-26 的 meta 声明不冲突。

#### U-17（＝P-12＋PA-13）sheet 与 push 全屏层缺 dialog 语义与 inert，VoiceOver 下无边界感且可穿层
- **位置**：`immersive-translator-mobile/src/ui/sheets.tsx:106`（SheetHost 无 role/aria-modal/名称，遮罩非关闭控件）；`src/App.tsx:353-360`（.push 无 role/inert，被盖住的 tabbar :334-350 与 pane :325-331 仍在辅助树可漫游可激活）。
- **问题**：VoiceOver 下 sheet 只是匿名内容且背景可漫游；push 页可触达并点按被盖住的 5 个 Tab 引发栈错乱。两者同机制，应共用一套实现。
- **修法**：①.sheet 容器加 `role="dialog" aria-modal="true"` 以 sheet 标题作 aria-label，遮罩改可激活关闭控件（或 aria-hidden）；②.push 根同样加 dialog 语义 + 页标题 aria-label，进栈移焦点入新页标题（tabIndex=-1+focus）、出栈归还；③底层与 sheet 共用一套 inert 机制（对 .app 底层设 inert）。
- **验收**：VoiceOver 无法触达 push 层背后的 Tab 与 pane 内容；sheet 打开播报名称、Esc/遮罩可关；焦点进栈/出栈正确归还。
- **复核**：未覆盖——本轮独立复核未含此条，维持 pending。

#### U-18（＝M-03）识别卡「点按翻面」与评分组硬切，规格 240ms 未实现
- **位置**：`immersive-translator-mobile/src/screens/ReviewScreen.tsx:320-331`（翻面内容硬切）、`:264-278`（评分组瞬时弹入）；同型 `src/screens/QuickReview.tsx:106-123`。
- **问题**：规格明文「判分/揭底｜翻面 240ms」（docs/mobile-v3-design-2026-09-24.md:138），现在是硬切，与下一张卡的 cardin 不连贯。
- **修法**：base.css 加 `.rv-flip { animation: cardin 240ms var(--ease); }`（复用 :1246 既有 keyframes）；包住背面支路与 `.grades`（`<div className="grades rv-flip">`）；QuickReview 同型（包 hint + GradeRow）。不做 3D rotateY（守「不做 scale 防布局抖动」定案）。
- **验收**：翻面/评分 240ms 淡入上移呈现；连续翻面/撤销每次重播；下一张卡 cardin 不受影响；reduced-motion 全局兜底即时切换。

#### U-19（＝M-04）触感规格 7 处只落地 3 处——评分/收词/开麦/清空到期全缺
- **位置**：现有 6 处调用（grep 核验自 motion-plan）：kit.tsx:170、App.tsx:83/111/341、SettingsScreens.tsx:54/322；缺失点：评分 `src/screens/ReviewScreen.tsx:177/:192`、`src/screens/QuickReview.tsx:72`，收词 `src/store.ts:617`，开麦 `src/screens/SpeakScreens.tsx:363/:508`、CaptionScreen start()、`src/screens/ShadowScreen.tsx:164`。
- **问题**：评分/收词/开麦是高频核心动作，规格点名（tab/评分/收词/开麦=light、清空今日到期=success）却零触感；设置页两处 success 反落在未点名场景，优先级倒挂。
- **修法**：复用 `services/device.ts:70-86` 现有 `haptic()`——评分/收词/开麦各补 `haptic("light")`（store 若担心循环依赖则移到 sheets.tsx:170 collect() 内）；QuickReview 清掉最后一张到期（`st.due === 1`）改发 `haptic("success")`（device.ts:85 双脉冲），不与 light 叠发。
- **验收**：真机（Tauri iOS）评分/收藏/开麦各一次轻微单脉冲，清完最后一张一次 success 双脉冲；浏览器 vibrate 静默失败无异常；smoke 全绿。

#### U-20（＝M-05）列表删除零离场、新增零入场——行被「报删」，其余行瞬间上跳
- **位置**：`immersive-translator-mobile/src/ui/kit.tsx:85-181`（SwipeRow onDelete 直改进 store）；五个调用面：`src/screens/VocabScreen.tsx:17`、`ShelfScreen.tsx:66`、`MiscScreens.tsx:33/:162`、`NotesScreens.tsx:308`。
- **问题**：破坏性动作失去空间确认，撤销恢复行瞬移插回；cap-card（base.css:2068）已有 cardin 先例，列表行反而没有。
- **修法**：①入场——base.css 左滑段给 `.swipe-row` 加 `animation: cardin 240ms var(--ease)`（一行覆盖五面，undo 恢复也吃到）；②离场——collapseDelete：先量 wrap offsetHeight，过渡 height+opacity→0（200ms --ease），210ms 后进 store（不依赖 transitionend），显式 matchMedia reduce 分支跳过折叠直接删。
- **验收**：生词/书架/历史/笔记库左滑删除行 200ms 压扁淡出、下方行平滑上补；撤销 240ms 插回；连续快删互不串扰；滑动中不触发折叠。

#### U-21（＝M-06＋P-15）sheet 下拉关闭只认抓手条（15px 命中高）+ 快速轻扫速度分支缺失
- **位置**：`immersive-translator-mobile/src/ui/sheets.tsx:62-100`（pointer 事件只挂 grabRef，:90）；速度分支 ：88 只有 dy>120，而文件头注（:4）声称两者已实现；抓手条 `src/ui/base.css:555-568` ≈15px 命中高。
- **问题**：违背 iOS 半模态「任意位置下拉」肌肉记忆；短促轻扫 sheet 不关闭，与头注承诺不符（定稿 §1.8「>120px 或 >0.4px/ms 释放关闭」，docs 行 135）。
- **修法**（同 handler 一并修）：pointer 事件从 grabRef 改挂 sheet 根——down 记 t0，`scrollTop>0` 时让位给滚动，`dy<0` 忽略，首次 `dy>6` 才接管防点击误判；up 时 `v = dy/耗时`，`dy>120 || v>0.4` 执行 `actions.setSheet(null)`；抓手条保留（事件冒泡同 handler）。
- **验收**：词典卡/Aa 正文区下拉跟手，>120px 或快速轻扫都关闭否则 280ms 弹回；先下滚内容不误触拖拽；字号 ± 点击不被误判（6px 死区）。

#### U-22（＝M-07）toast 给 sheet 让位是瞬移——bottom 内联直写，无过渡
- **位置**：`immersive-translator-mobile/src/store.ts:855-860`（repositionToasts 直写 style.bottom）、`:526-532`（setSheet 两次调用）；`src/ui/base.css:653-679`（.toast 只过渡 opacity/transform）。
- **问题**：收词 toast 存活 5s 期间开关 sheet，墨色胶囊在两位置间瞬移（来回各一次）。
- **修法**：让位量改走 CSS 变量——`.toast.on { transform: translateY(var(--toast-lift, 0px)) }`，repositionToasts 写 `--toast-lift: -(sheet高+12-96)px`，复用现有 200ms var(--ease) transform 过渡；safe-area 常量相减抵消无需读 env。
- **验收**：toast 在屏时开/关词典卡，toast 200ms 平滑上移/回落；无 toast 时无副作用；深色 toast 同样生效。

#### U-23（＝N-1）八类高频可点控件按压态成片缺失
- **位置**：`immersive-translator-mobile/src/ui/base.css`——.tab（:420-439）、.seg button（:210-220）、.switch（:227-252）、.banner .bbtn（:628-641）、.row（:297-310）、.ob-opt（:2185-2197）、.import-tabs button（:2444-2451）、.swipe-act（:1032-1045）均无 ：active；WKWebView 需 touch 监听才激活 ：active，而 document 上现仅 pointerdown（App.tsx:224）。
- **问题**：tab bar 是全 app 最高频控件却按下零反馈，违反定稿 §1.8/候选 A §2.9「全局 ：active 覆盖所有可点元素」与 apple-design「Respond on pointer-down」。
- **修法**：按实底/文字两式补 ：active——.tab/.switch/.bbtn/.import-tabs opacity .78；.seg button 背景→--surface；.row/.ob-opt 背景→--surface-2；.swipe-act 背景→--err-soft + brightness(.96)；并在 `src/main.tsx` 挂一次空 touchstart 监听（passive）。
- **验收**：真机/模拟器逐个按下八类控件均有 <100ms 即时反馈；与 U-36 的 100ms 过渡叠加不堆积。

#### U-24（＝N-4）六个嵌套滚动容器缺 `overscroll-behavior: contain`
- **位置**：`immersive-translator-mobile/src/ui/base.css`——.sheet-body（:569-576）、.chat-body（:1747-1756）、.rv-stage（:1235-1242）、.qk-stage（:2518-2525）、.sh-stage（:1931-1939）、.ob-stage（:2178-2184）；.pane/.pbody 已合规。
- **问题**：滚到边界手势链给底层，sheet 内触底续拖带动整页橡皮筋，破模态感（候选 A §7/定稿 §6.1 明文要求）。
- **修法**：六条规则各加一行 `overscroll-behavior: contain;`。
- **验收**：词典卡/Aa/导入 sheet 内滚到顶/底继续拖，背景页面纹丝不动；聊天流/复习/清一张/跟读舞台同理；iOS 16 WKWebView 实机验证。

#### U-25（＝N-5）笔记正文 15px 无衬线，违反「衬线一页纸」与正文 ≥17px
- **位置**：`immersive-translator-mobile/src/ui/base.css:2154-2163`（.note-stream 未设 font-family）；消费者 `src/screens/NotesScreens.tsx:257/:263/:344`。
- **问题**：笔记生成/详情的正文本体是 15px sans，与候选 A §4.15「笔记流式预览：衬线一页纸」及 17px 铁律不符。
- **修法**：加 `font-family: var(--font-serif)`、15px→17px、line-height 25→26px（--fs-body 17/26）。
- **验收**：笔记两屏为衬线 17/26；笔记库列表行（非正文）不受影响；smoke 通过。

#### U-26（＝PA-02）全库无 color-scheme 声明，深色主题下系统键盘/表单控件仍是浅色
- **位置**：`immersive-translator-mobile/src/ui/tokens.css:8`（:root）、`:33`（[data-theme=dark]）；grep color-scheme 仅命中 store.ts:195/371/453 的 matchMedia，CSS/meta 层零声明。
- **问题**：主题由 data-theme 驱动（store.ts:466）但未声明 color-scheme——深色下 WKWebView 系统键盘、日期/时间滚轮、表单控件按浅色渲染，与深色纸面割裂。
- **修法**：tokens.css `:root, [data-theme="light"] { color-scheme: light; }`、`[data-theme="dark"] { color-scheme: dark; }`、`.rd-black` 同步 `color-scheme: dark`；可选 index.html 补 `<meta name="color-scheme" content="light dark">` 配合 U-16。
- **验收**：深色主题下 BYOK/讯飞/搜索输入弹深色键盘；时间滚轮深色；浅色不受影响。

#### U-27（＝PA-08）18 处输入控件无编程关联标签（placeholder 充当唯一说明）
- **位置**：`immersive-translator-mobile/src/ui/sheets.tsx:513/:983/:1002`、`src/screens/MiscScreens.tsx:29/:118-124`、`src/screens/VocabScreen.tsx:90`、`src/screens/OnboardingScreen.tsx:91-98`、`src/screens/TranslateScreen.tsx:167-173`、`src/screens/ReviewScreen.tsx:419/:496`、`src/screens/QuickReview.tsx:136`、`src/screens/SpeakScreens.tsx:487`、`src/screens/SettingsScreens.tsx:104/:118/:137/:431/:504`。
- **问题**：VoiceOver 回退播报 placeholder（「sk-…」「https://…」），判分输入框（完形/听写）用途不可知（WCAG 1.3.1/3.3.2/4.1.2）。
- **修法**：逐处加 aria-label；可见文案在场时优先 aria-labelledby 指向行内文字（如设置页 `<span className="meta2">`）；完形/听写答案输入至少 `aria-label="输入答案"`。
- **验收**：VoiceOver 逐输入框播报正确用途名称，无「sk-…, 文本字段」类播报。

#### U-28（＝PA-09＋P-19）全部选择态无编程语义 + 行式 radio 选中对勾为墨色
- **位置**：`immersive-translator-mobile/src/ui/kit.tsx:51-58`（Seg 仅切 .on class）；`src/ui/sheets.tsx:445`（语速对勾）、`:936-943`（exam chips）、`:893`（import-tabs）；`src/screens/SettingsScreens.tsx:86-88/:557-561`（行式 radio，P-19 对勾 color: var(--ink)，base.css:354-356）；`src/screens/OnboardingScreen.tsx:59`；`src/App.tsx:338`（Tab 仅 .on 变色）。
- **问题**：VoiceOver 一律播报「按钮」，选中与否不可知（WCAG 4.1.2）；定稿 §3.18 规定「行式 radio（墨蓝对勾）」（docs 行 299），墨蓝四处清单②亦列「分段选中」。
- **修法**：互斥组用 `role="radiogroup"` + `role="radio" aria-checked`（单按钮用 aria-pressed）；Tab 加 `aria-current="true"`；chips/页签加 aria-pressed；选中行对勾加 `style={{ color: "var(--accent)" }}`（未选中 22px 占位不变）。与 P-19 同批同行修改。
- **验收**：VoiceOver 播报「已选中/未选中」；对勾两主题呈墨蓝；设置页/Aa/首启各选择组语义正确。

#### U-29（＝PA-11）toast 与通知横幅无 live 语义，动态消息对 VoiceOver 全程静默
- **位置**：`immersive-translator-mobile/src/store.ts:861-896`（createElement 命令式 DOM，无 role/aria-live）；`src/App.tsx:370-407`（横幅无 role/alert）。
- **问题**：「已收藏·去看看」「已移出生词本·撤销」及到期横幅（含「先清一张」主动作）对读屏静默（WCAG 4.1.3）；5s 撤销窗本身是既定决策，不在改造范围。
- **修法**：建 toast 时加 `role="status"`（中性/成功）或 `role="alert"`（失败），先挂空区后改文本的稳定区域模式；横幅容器加 role=alert/status，并让「先清一张」成为横幅出现后的第一顺序焦点（与 U-05 同文件实施）。
- **验收**：VoiceOver 自动播报收藏/撤销/横幅内容；「先清一张」可达可激活；5s 自动消失行为不变。

### 1.4 P0/P1 未进重点复核的其余条目速览

U-10、U-14、U-16、U-18~U-26、U-28、U-29 已在上文（topItems 只收录 12 条，其余条目规格同等自包含，执行时以本文为准）。

### 1.5 P2 打磨（22 条）

> 均为一行式或小改造；来源与详细论证见各路文档对应条目。

- **U-30（＝N-2，low·motion）按压反馈数值收敛**。位置：base.css 九处（.btn-ghost:177-179 等，完整清单 style-spec §10.6 N-2）。问题：opacity 0.6/0.7/0.75/0.78/0.85 五档并存 + .src-card:active（:2349-2351）用 --hairline 底，定稿明文只有 0.78 一档。修法：九处统一 `opacity: .78`、src-card 改 `var(--surface-2)`。验收：`grep -n ":active" src/ui/base.css` 输出 opacity 仅 0.78、背景仅 --surface-2（swipe-act err-soft 例外）、禁用 0.35。
- **U-31（＝N-3，low·motion）主题切换无 transition 抑制，换肤拖影约 300ms**。位置：`src/store.ts:466`（applyThemeDom）+ base.css 成片颜色 transition。修法：base.css 末尾加 `html.theme-switch * { transition: none !important; }` 块，applyThemeDom 写完 data-theme 后加类、双 rAF 后移除。验收：外观页来回切换颜色一帧内整体翻转；普通交互动画不受影响；与 U-16 叠加后冷启动无闪。
- **U-32（＝M-08，low·motion）拍译/手动输入→翻译结果 replace 硬切**。位置：`src/App.tsx:107-112`（触发点 CameraScreen.tsx:159/336）。修法：replace 改 push 同款入场（entered:false + 双 rAF 置真），新屏 320ms --ease 从右滑入，旧屏即刻卸载露出 tab 层作背景。验收：拍译→结果页滑入；连拍防抖与深链 #translate 无回归。
- **U-33（＝M-09，low·motion）进度墨线动画走 width 布局属性**。位置：base.css:795-801（.meter 320ms）、:1111-1116（.rd-prog 200ms）；写入点 kit.tsx:76-82、ReaderScreen/ReviewScreen.tsx:293。修法：改 `transform: scaleX(p)` + origin left，时长曲线不变，默认 scaleX(0)。验收：视觉与节奏不变；Performance 面板播放/评分中无 layout 抖动。
- **U-34（＝M-10，low·motion）.cam-scan 死代码 27 行**。位置：base.css:1605-1631（grep 全 tsx 零引用）。修法：整段删除；未来恢复扫描线按 translateY 另写。验收：`npm run build` 通过，拍译全流程无回归。
- **U-35（＝M-11，low·motion）直译 72px FAB 显隐硬切**。位置：`src/screens/CaptionScreen.tsx:403-412`、base.css:2091-2108。修法：常挂载+类切换——.cap-fab 加 transform/opacity 200ms 过渡，hide 态 `translateX(-50%) scale(0.9)+opacity:0`（保留定位 translateX），rec 期间 disabled。验收：开录缩退淡出、停录回弹归位、rec 中不可点。与 U-01 的录音停止入口修复同文件。
- **U-36（＝M-12，low·motion）按压 100ms 过渡大面积缺失**。位置：base.css——.tlink/.iconbtn/.frow/.grade/.chip/.menu-item/.holdbtn 等十余类 :active 均为 0ms 硬切（.btn/.tab/.switch 已有过渡不动）。修法：一条组规则 `transition: opacity 100ms linear, background-color 100ms linear` 覆盖缺量清单（motion-plan M-12 有完整选择器表）；.holdbtn 另补 border-color/color。验收：行/图标钮/chip 按下有 100ms 渐入，主按钮手感不变，快速连点无堆积。
- **U-37（＝O-01，medium·motion 增量）push 底层零反馈，「盖纸」不像「推入」**。位置：`src/App.tsx:353-360`、base.css:458-467。修法：push 存在期间底层压暗 scrim（z-35、rgba(32,29,24,.12)、opacity 320ms）+ tab 栏 translateX(-25%) 视差（320ms 同曲线），只看 stack.length 布尔。验收：push 进出底层轻微左移+压暗同步回位；转场中点底层不误触。
- **U-38（＝O-02，low·motion）Onboarding 三步硬切**。位置：`src/screens/OnboardingScreen.tsx:43/:79/:131`。修法：步骤内容包 `key={step}` 容器复用 tabin（160ms 淡入+4px 上移，base.css:83 既有）。验收：三步间 160ms 入场；不做左右滑移（守 tab 定案精神）。
- **U-39（＝O-03，low·motion）跟读报告卡/分数胶囊/快速复习完成态零入场**。位置：`src/screens/ShadowScreen.tsx:290/:329/:353`、`src/screens/QuickReview.tsx:84-98`。修法：容器加 cardin 240ms；完成态 success 触感并入 U-19 同一改动。验收：结果时刻 240ms 入场 + success 双脉冲。
- **U-40（＝PA-03，medium·platform，Unverified 真机先行）状态栏样式无任何原生处理**。位置：`src-tauri/gen/apple/imreader-mobile_iOS/Info.plist`（无 UIStatusBarStyle/UIUserInterfaceStyle）；grep StatusBar 于 src-tauri/src 与 Sources 零命中。修法：真机先验证 wry 0.57 默认行为；不随动则经 Tauri command 按 data-theme 调原生 setStatusBarStyle/overridesUserInterfaceStyle。验收：深色主题下状态栏时钟可读（真机）。
- **U-41（＝PA-05，low·platform）键盘弹起时 sheet max-height 不扣 --kb-inset，顶部被裁 ≈131px@852 屏**。位置：base.css:537（:535 bottom 已扣）。修法：改 `max-height: calc(76% - var(--kb-inset, 0px))`，一处修改。验收：键盘弹起时文内搜索/导入 sheet 的把手与标题可见；jsdom 回退 0px 不受影响。
- **U-42（＝PA-06，low·platform，Unverified）iPad 四向 + iOS 26 窗口化下左上返回钮可能被系统控制压住**。位置：project.yml:50-53、kit.tsx:22-27。修法：iPad 真机观察；复现则给 .pnav .side.l 预留 ~64px 左上安全角或窗口化时右移返回钮。验收：iPad 窗口化下返回钮可点（真机）。
- **U-43（＝PA-07，low·platform）产品名三处不一致（reader-spike/沉浸口语/沉浸阅读室）**。位置：`src-tauri/tauri.conf.json:3/:17`、Info.plist:24-27、index.html:7；分享文案 MiscScreens.tsx:351/:419 自称「沉浸口语」。修法：定名后统一 productName、CFBundleName/DisplayName、index.html title 三处，更名决策回写设计档案。验收：三处口径一致，安装名=应用自称。
- **U-44（＝PA-10，low·a11y）生词 Tab 到期角标被 aria-label 覆盖，读屏听不到到期数**。位置：`src/App.tsx:339`（aria-label={t.label}）+ :346（tbadge）。修法：`aria-label={st.due > 0 && t.key === "vocab" ? \`生词，${st.due} 个到期\` : t.label}`。验收：VoiceOver 播报「生词，N 个到期」。
- **U-45（＝PA-17，low·a11y）左滑删除拖拽是唯一显性路径，无可见单指替代（WCAG 2.5.7）**。位置：kit.tsx:85-181（使用点 VocabScreen.tsx:17、ShelfScreen.tsx:66、MiscScreens.tsx:33/:162、NotesScreens.tsx:308）。修法：行尾加常驻「···」iconbtn（或长按菜单）内含同一 onDelete 的「删除」。验收：不依赖拖拽也能两步内删除；与 U-20 同组件实施。
- **U-46（＝P-14，low·style）--fs 字阶令牌未落地，多处字面值漂出标度**。位置：`src/ui/tokens.css:58`（:root 无 --fs-*）+ base.css 消费类：.frow 16px（:339）、.menu-item 16px/高 50（:587-588）、.art-title 行高 26（:774-777）、.sheet-title 行高缺 28（:577-582）。修法：按 style-spec §4.1 表落 --fs-* 九枚并让消费类改读令牌，一次校准到 17px/52px/28px。验收：grep 无裸 16px headline 类；四类视觉对齐 §4.1 目标值。
- **U-47（＝P-16，low·style）练 Tab 页脚残留开发口吻（「ISE」缩写与「不假打分」括注）**。位置：`src/screens/PracticeScreen.tsx:106`。修法：按原型 prototypes/mobile-v3-2026-09-24.html:1298 改白话句（如「跟读评测使用讯飞语音评测，未配置时仅播放领读」），去「走…ISE」与括注；降级语义保留行内。验收：界面无工程词汇；「ISE/TTS/ASR」仅存于「我的→语音服务」状态灯场景。
- **U-48（＝P-17，low·style）M0 spike 遗留屏与路由仍打进生产包**。位置：`src/App.tsx:32/:314-315`、`src/ui/nav.tsx:30`、`src/screens/SpikeScreen.tsx`（入口已被 MeScreen.tsx:155-158 DEV 门控，屏本体未门控）。修法：App.tsx 的 case "spike" 与 import 同 `import.meta.env.DEV` 门控，或直接删除屏文件与路由项。验收：生产构建无 spike 路由与屏代码（`npm run build` 后 grep 产物确认）。
- **U-49（＝P-18，low·style）测试失败状态点用 warn 色，与「未配置」同色无法区分**。位置：`src/screens/SettingsScreens.tsx:185/:465-466`（失败）对照 ：400/:409（未配置均 warn）。修法：两处失败态改 `statusdot err`（.statusdot.err base.css:292 已定义但全 app 零使用），形成 ok/未配置/失败三态。验收：三态视觉可分；err 使用符合定稿 §1.3「仅真实错误」。
- **U-50（＝P-20，low·motion，需产品定夺）跟读领读慢速档 0.6× 与定稿 0.72× 不符**。位置：`src/screens/ShadowScreen.tsx:447-455`（Seg 值）、`:100`（头注）、`:342`（按钮文案）三处一致 0.6；定稿 §3.12（docs 行 267）与候选 A §4.12 均 0.72。修法：若无 0.6 的实测决策记录，leadRate 改 0.72（Seg/文案/预取键同源一处 state）；若有，回写两份设计档案。验收：三处口径一致且与设计档案一致，无两处并存。
- **U-51（＝P-21，low·motion）首启第 3 步无「上一步」，填错 Key 唯一出路是提交**。位置：`src/screens/OnboardingScreen.tsx:131-150`（第 2 步有「上一步」:122-128，第 3 步无）。修法：第 3 步补同款「上一步」文字链接 `onClick={() => setStep(2)}`。验收：3/3 可回退到 2/3 且表单值保留；与 U-38 的步进动画叠加自然。

---

## 2. 来源映射与合并记录

| 合并后 | 来源 | 合并理由 |
|---|---|---|
| U-01 | P-01＋PA-12 | 同根：span/div 充当交互件，语义与热区一次修 |
| U-02 | P-02 | 同文件三行搭车 PA-16 的 minHeight 覆写 |
| U-08 | P-05＋PA-16＋N-6 | 同一「热区 ≥44」铁律的两份清单 + .switch，一次清扫提交 |
| U-09 | P-06＋PA-14 | 同为 ink-4 误用于状态/结果文案 |
| U-15 | P-11＋PA-04 | 1.4.4 闭合必须两条同批（platform-a11y §4） |
| U-17 | P-12＋PA-13 | dialog/inert 同一机制覆盖 sheet 与 push 层 |
| U-21 | M-06＋P-15 | 同一 pointer handler，手势区与速度分支一并修 |
| U-28 | PA-09＋P-19 | 语义与对勾颜色同批同行修改 |
| 其余 | P-03/04/08/09/10 已由 style-spec §10.1-10.5 展开为可执行步骤，本文直接收录 | — |
| 未收录 | motion-plan O-04（主题切换过渡） | 已定案「不做」，理由存档于 motion-plan §2 |

---

## 3. 实施批次建议（按依赖排序）

**批次 1｜地基（先行，半天）**：U-26（color-scheme 声明）、U-15（viewport 移除 user-scalable=no + --fs-scale 机制立项）、U-16（首帧主题脚本）、U-04（横屏配置决策——决定后续是否需要 --safe-x CSS 消费）、U-07（rd-black 令牌补全与作用域收敛，tokens.css 层）。理由：都在 tokens.css/index.html/原生配置层，是后续组件与各屏改动的取值前提；U-04 若选收敛 Portrait 则免掉一批 CSS 工作。

**批次 2｜组件层与全局 CSS（1-2 天）**：base.css 集中批——U-01 的 .tlink 全局热区、U-08 热区清扫、U-23 :active、U-24 overscroll、U-36 按压过渡、U-30 数值收敛、U-31 换肤抑制；kit.tsx——U-20 SwipeRow、U-45、U-28 的 Seg；sheets.tsx——U-21、U-27 部分、U-17 的 sheet 半；store.ts——U-22、U-29 的 toast 半。理由：U-17 的 inert 机制是 sheet/push 共用基建，先立起来批次 3 各屏才能复用；base.css 批做完，各屏只剩语义与文案。

**批次 3｜各屏（2-3 天，可并行）**：阅读器（U-03、U-06、U-12、U-09 阅读侧）；翻译页（U-13、U-09 翻译侧）；设置五屏（U-02、U-11、U-28 的 radio、U-49）；练习闭环（U-18、U-19、U-35、U-39）；今天/书架/生词（U-01 的卡片 button 化、U-14、U-27 各屏部分）；App 外壳（U-05 横幅、U-32、U-37、U-44、U-48）；Onboarding（U-38、U-51）；笔记（U-25）；生词 Tab（U-44）。每个屏提交独立，随提交跑 smoke。

**批次 4｜P2 打磨 + 真机验证专项**：U-30/31/33/34/36/38/41/43/46/47/48/49/50/51 顺手批；真机专项——U-04②（若选横屏方案）、U-19 触感、U-06 滚动手感、U-40 状态栏、U-42 iPad 窗口化、U-15 捏合缩放（后四项原文档标 Unverified，须设备观察后定实施）。

**每批验收纪律**：`npm run build` 零错误、`node scripts/smoke.mjs` 全绿、控制台零报错；动效项过 DevTools Animations 10% 倍速 + Rendering 面板 reduced-motion 复验；样式项过 style-spec §11 验收清单；连续快速触发（连点返回/连续评分/开关 sheet/连删多行）确认所有过渡可中断无错位。

---

## 4. 冲突与取舍

1. **总原则：无障碍 > 风格**（本轮任务约定）。具体落点：
   - **U-01 .tlink 热区**：44px 热区 + 负 margin 若在个别紧凑行（组头 13px 链接）收不净导致行高溢出，以热区为准，微调行距让位——不允许用「视觉优先」保留 <44 命中区。
   - **U-03 中文行字号**：`max(17px, calc(var(--rd-fs) * 0.85))` 的 17px 下限优先于「随 Aa 线性缩放到底」——15 档时中文行不再跟手缩小（12.75px 被截断到 17px），这是铁律对跟手性的让位，需在 Aa 面板文案上可接受。
   - **U-09 .w-miss**：改 ink-3 后与 .w-err 的颜色层级差收窄——层级区分改字重（风格让位对比度），line-through 保留为非颜色线索。
   - **U-15 缩放开放**：移除 user-scalable=no 后极端放大可能破个别固定布局——以 WCAG 1.4.4 为准，接受 200% 下的局部折行；布局修复不作为本项前置条件。
   - **U-07 rd-black 补 --accent=#8fb3d4**：纯黑底上「墨蓝点缀」取深色主题亮色变体，属对比度强制（2.7:1→9.6:1），不视为破坏色板纪律。
2. **动效纪律内的取舍**（延续既有定案，不翻案）：按压态**不做 scale**（定稿 §1.8 对 better-ui「press 0.96」的项目级豁免，a11y/motion 均按 opacity/背景两式执行）；主题切换**不加过渡**（O-04 定案，仅做 U-31 的拖影抑制）；sheet 拖拽跟手属用户驱动位移，reduced-motion 下保留。
3. **U-06 平滑滚动 vs 瞬时确定性**：连播推进改平滑（运动连续性优先），断点恢复/词典定位保留瞬时（可用性优先）——按调用点分流，不取全有全无。
4. **U-12 墨线 vs 底色**：若多行长句仅页边墨线视觉锚定不足，**不回退底色**（定稿明文决策），可在 2px 宽度上限内加浓（≤3px）并记录于设计档案。
5. **U-50 的 0.6 vs 0.72**：代码三处一致 vs 设计档案两处一致，属事实冲突而非风格取舍——默认改代码回 0.72；若团队确认 0.6 是实测后的新决策，必须回写 `docs/mobile-v3-design-2026-09-24.md` 与 `docs/mobile-v3-candidate-a.md`，不允许两处口径并存。
6. **U-19 触感与 U-39 success 并发**：QuickReview 清掉最后一张到期只发 success 不叠 light（motion-plan 已定），避免双脉冲。
7. **语义化改 button 的例外**：ReaderScreen 的 `.sent`/`.tok`（阅读正文点击）保留文本流语义不改 button（U-01 ④）——以既有实体按钮作可发现替代路径，这是「阅读流语义」对「全量 button 化」的让位，属 a11y 内部权衡而非风格让步。

---

## 附录 A｜行号抽查核验记录（基线 `93f5f55`，本计划撰写时实跑）

以下关键条目的行号与内容已在本轮实读核验，与三路文档及优先级清单一致：

1. `sed -n '176,190p' immersive-translator-mobile/src/ui/base.css` → .tlink（:180-184）确无 padding/min-height，`.tlink:active opacity 0.7`（N-2 数值确认）。
2. `sed -n '5,7p' immersive-translator-mobile/index.html` → viewport 含 `user-scalable=no`（U-15）。
3. `sed -n '104,142p' immersive-translator-mobile/src/screens/SettingsScreens.tsx` → :106/:120 `fontSize:14`、:139 `fontSize:15`（U-02），minHeight 34/38。
4. `sed -n '344,348p' immersive-translator-mobile/src/screens/ReaderScreen.tsx` + `sed -n '1140,1150p' immersive-translator-mobile/src/ui/base.css` → sent-zh 硬编码 14px（U-03 两处）。
5. `sed -n '354,358p' immersive-translator-mobile/src/App.tsx` + `sed -n '79,94p' immersive-translator-mobile/src/ui/tokens.css` → rd-black 挂 push 根（:356）且 .rd-black（:81-92）缺 --accent（U-07）。
6. `sed -n '368,384p' immersive-translator-mobile/src/App.tsx` → 横幅首插即带 `.on`（:370-371）、关闭钮内联 28×28（:382）（U-05/U-08）。
7. `sed -n '66,76p' immersive-translator-mobile/src/screens/ReaderScreen.tsx` → scrollToSent 无条件 `scrollIntoView({block:"center"})`（U-06）。
8. `sed -n '44,54p' immersive-translator-mobile/src-tauri/gen/apple/project.yml` + `grep -rn "safe-area-inset-left\|safe-area-inset-right" immersive-translator-mobile/src/ immersive-translator-mobile/src-tauri/src/ immersive-translator-mobile/src-tauri/gen/apple/Sources/` → 横屏三向/四向启用、safe-area 左右 0 命中（U-04）。
9. `sed -n '1780,1796p'`、`sed -n '1965,1974p'`、`sed -n '226,254p' immersive-translator-mobile/src/ui/base.css` → 深色 .bubble.me .zh 用 ink-3（:1791-1793）、.w-miss ink-4+line-through（:1969-1972）、.switch 50×30（:227-228）（U-10/U-09/U-08）。
10. `sed -n '128,142p' immersive-translator-mobile/src/screens/VocabScreen.tsx` → 「整理成笔记」13px tlink span 两处（U-01）。

未逐条复跑其余发现（59 条中的其余引用行号采信三路文档的实读记录）；各条验收时以文末验收纪律为准。

---

## 附录 B｜独立复核结论（2026-10-20）

- **范围**：本计划 topItems 12 条中的 10 条（U-01…U-09、U-11）由独立复核逐条实读核验（base.css/tokens.css/相关 screen 源码、配置文件与两份设计基线，对比度经 node 脚本实算）；U-15、U-17 未在本轮复核范围。
- **结果**：**10/10 证实，无存疑条目**（verdict 全部 verified），优先级评级与修法方向均无需调整。复核另贡献 6 处细化/修正，已回写至各条目「复核」行（U-02 的修法细化同步写入该条目「修法」行，其余仅记录不改正文）：
  1. **U-01**：「唯一停止入口」略夸大——CaptionScreen.tsx:325 已是 `<button>`（缺热区而非语义），且 onBack（:319-322）亦可停止录音；修法不受影响。
  2. **U-02**：:512 为无 .input 类的裸 `input[type=time]`，全局 reset 未设 font-size——该处须显式改写 17px 而非删内联值，否则落 UA 默认。
  3. **U-03**：17px 铁律明文仅约束输入框（base.css:5/:363），正文 17px 论据属延伸；high 由「Aa 在中文模式整体失效」的功能缺陷支撑。
  4. **U-06**：「每 3-5 秒」为按句速估计值，实际节奏由 TTS onend 驱动；JS 滚动不受 reduced-motion 全局兜底管辖，显式 matchMedia 分支必要。
  5. **U-07**：「重试」按钮实为 .chip 用 --ink-2（9.49:1）不受影响；受影响的是 .tlink 链接与 .tok 点状下划线（2.74:1 → 修法后 9.57:1，node 实算）。
  6. **U-09**：.w-miss 当前无元素命中（ShadowScreen.tsx:256 只产出 w-err/w-ok），属死样式——修复保留以防回潮。
- **执行口径**：后来者执行时以各条目「复核」行标注后的口径为准；复核未覆盖的条目（含其余 39 条非重点条目）仍以原条目正文为准，建议在下轮复核中补齐 U-15/U-17。本轮复核未修改任何产品代码。
