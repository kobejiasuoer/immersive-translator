# 移动端现状评审（v3 critique）

> 评审日期：2026-09-24 · 评审人视角：挑剔的资深移动端设计评审
> 用户的原话是「太丑了，功能也不行」——本文给出有出处的批评，不客套。
>
> 评审方法（都实际做过）：
> - 通读真实工程 `immersive-translator-mobile/src/`（App.tsx、screens/ 六屏、ui/tokens.css、ui/base.css、store.ts、tokenizer.ts、core/data.ts、core/judge.ts）与 `src-tauri/src/lib.rs`；
> - 用 playwright（python sync_api，viewport 390×844 @2x）实测截图：v2 原型 16 个关键状态 + v1 原型 2 屏 + **真实应用 7 屏**（vite dev，`npm run dev` → http://localhost:5174，控制台零报错），存于 `prototypes/shots/v3-critique/`；
> - 对照 `docs/mobile-spike-report.md`、`docs/mobile-v2-brief.md` 的已知结论。
>
> 一句话结论：**真实应用是一个把开发自检面板直接装进壳里的 spike——原型 v1/v2 里已经画对的东西（首页、词典卡、复习提示阶梯、语音三件套、通知触点）一概没实现，实现的部分又到处漏 debug 马脚（性能角标、S3a/S4/S7 编号、裸 API Key 输入框、假发音按钮）。「丑」的主要来源不是配色 token（token 体系其实是好的），而是：debug 信息当用户文案、布局顶锚大留白、标注噪音无层级、emoji/汉字当图标、动效为零。**

---

## 一、视觉

### V1 debug 角标压在文章标题和按钮上
阅读页右上角无条件渲染性能角标「17ms · 8句 · 166节点」，黑色胶囊直接盖住标题右半和「遮罩」按钮的点击区（z-index 50，高于顶栏）。
证据：`src/screens/ReaderScreen.tsx:137-139`、`src/ui/base.css:356-369`；截图 `prototypes/shots/v3-critique/app-05-reader.png`（标题 "Why Cities Need Tre…" 被截断）。

### V2 「我的」页是开发自检面板，不是设置页
页面副标题写着「spike 自检：S3a TTS · S4 BYOK 网络」，区块标题带内部编号（「主题（S7：四主题 + 无 color-mix）」「TTS 自检（S3a · Web Speech）」「BYOK 网络测试（S4）」「spike 备忘」），正文是 TTS onstart/onend 事件计数器和给 spike 报告用的结论提示。用户打开「我的」看到的是工程进度，不是自己的账号与偏好。
证据：`src/screens/MeScreen.tsx:42,45,54,75-78,81,94-101`；截图 `app-04-me.png`。

### V3 每个屏的副标题都是 debug 文案
「spike 工程 · 数据为演示数据，不落盘」「演示数据 · spike 不落盘」「spike：S2 性能 / S5 导入」——原型里这个位置写的是「9月24日星期四 · 连续打卡 14 天」「与电脑端同一份数据 · SRS 到期自动进「今天」」，是产品文案；真实应用全换成了对用户无意义的内部话术。
证据：`src/screens/TodayScreen.tsx:15`、`src/screens/VocabScreen.tsx:23`、`src/screens/ShelfScreen.tsx:35`；对照截图 `app-01-today.png` vs `v2-01-today.png`。

### V4 布局全部顶锚，下半屏 40–60% 是死空间
复习卡、原型里的练/复习屏全部把卡片钉在屏幕上部，底部大片空白：真实 app 复习卡下约 60% 空白；v2 的陷阱反馈、跟读不达标、直译录制、完成摘要同样。无垂直居中、无内容补充，视觉重心失衡，观感「没做完」。
证据：截图 `app-07-review.png`、`v2-04-trap.png`、`v2-08-shadowfail.png`、`v2-09-captioning.png`、`v2-14-done.png`；布局根因 `src/ui/base.css:99-110`（.screen 直接堆叠，无居中容器）。

### V5 阅读页标注噪音三层叠加、无主次
词块点状虚线下划线 + 已收藏词蓝底 + 当前句蓝底 + 句高亮 box-shadow 同时压在正文上，演示文章几乎每行都有 2–3 种标记，扫一眼全是「链接」，正文反而退后。真实文章词块密度高于演示数据时只会更花。
证据：`src/ui/base.css:334-355`（.tok.sv / .tok.ck / .sent.cur 三种样式无优先级区分）；截图 `app-05-reader.png`、`v2-12-lookup.png`。

### V6 emoji 和汉字当图标
词典卡发音按钮是 🔊 emoji（跨平台字形不一致，廉价感最典型的来源）；阅读页遮罩开关是单字「目」，语速按钮是裸文字「1×」、播放键是「▶ / ❚❚」文本字形，返回键是「‹」。全应用没有一个成体系的图标语言（tab 栏反而用了正经 SVG）。
证据：`src/App.tsx:69-71`（🔊）、`src/screens/ReaderScreen.tsx:141-152,155-163`（‹ / 目 / ▶ / 1×）；截图 `app-06-dict-sheet.png`。

### V7 到期状态满屏红、双重信号
生词列表每行同时给红点 + 红色「到期」文字（红色用的是 --err 错误色表达日程状态），演示数据全部到期时整屏报警器视觉；原型同病（`v2-13-vocab.png`），「现在到期」还加了红色，焦虑感更强。
证据：`src/screens/VocabScreen.tsx:72,84-86`、`src/ui/tokens.css:28`（--err 即 .dot 底色）；截图 `app-02-vocab.png`。

### V8 完形卡的中文提示是一串全角下划线
用正则把中文字符逐个替换成「＿」，渲染成一条断续的黑线，像坏掉的表单占位符，不像提示。原型 v2 已改为虚线占位 + 「再给一点提示」阶梯（v2-02），真实 app 没跟进。
证据：`src/screens/ReviewScreen.tsx:141`；截图 `app-07-review.png` vs `v2-02-review.png`。

### V9 区块标签中英混排
纯中文界面里出现大写英文小节标签「WORDS / CHUNKS」（单词/词块切换已是中文），排版语言不统一。
证据：`src/screens/VocabScreen.tsx:52`；截图 `app-02-vocab.png`、`v2-13-vocab.png`。

### V10 全应用动效为零
base.css 全文仅 1 处 transition（中文遮罩揭示，`base.css:324`）。底部词典卡无上滑动画、生词本→词典卡无 push 过渡、tab 切换是 display:none 硬切、按钮无按压态。iOS 用户对「动」的预期全面落空，这是「廉价感」最大的单一来源之一。
证据：`grep -n "animation\|transition" src/ui/base.css` 仅命中 324 行；`src/App.tsx:34-45`（.hidden 硬切）；`src/App.tsx:61-64`（sheet 无动画挂载）。

### V11 录制中的字幕流对比度过低
直译录制时「正在说」的流式文本是浅灰 40% 透明级——它是录制中唯一的内容主体，却被渲染成禁用态的样子；顶部电平条做成通栏进度条样式，不像麦克风电平。
证据：截图 `v2-09-captioning.png`；`prototypes/mobile-v2-2026-09-23.html` 直译录制态样式。

## 二、交互

### I1 词典卡发音按钮是假的
按钮绑的是 `console.log("speak", word)`——`store.ts` 里现成的 `speak()` 不用。点了没有任何反馈也不禁用，是交互死路。诊断卡里唯一一个「听」的入口是坏的。
证据：`src/App.tsx:69-71`；对照 `src/store.ts:127-154`（speak 已实现）。

### I2 生词无法删除，「已在生词本」是死胡同
`deleteWord` 在 store 里有完整实现但全工程零调用；列表无滑动删除、词典卡无移除按钮，已收藏词打开卡片只看到 disabled 的「✓ 已在生词本」。收藏是不可逆操作。
证据：`src/store.ts:88-91`（实现）vs `grep -rn deleteWord src/` 仅此一处；`src/App.tsx:97-99`（disabled 按钮）；截图 `app-06-dict-sheet.png`。

### I3 完形输入框不自动聚焦
每张完形卡都要先点一下蓝色空格才能弹键盘打字。spike 注释自己写了「真机观察点：键盘弹起是否遮挡输入槽（visualViewport 适配必要性）」，但连最基本的 autoFocus 都没做。
证据：`src/screens/ReviewScreen.tsx:17,128-136`（input 无 autoFocus，grep 全工程无 autoFocus）。

### I4 阅读页点空白 = 突然开始全文连播
点句子里任何非词 token（标点间的空隙也算）都会立即 `stopSpeak + stepTo(该句, true)` 并进入自动连播状态，滚动页面、想选词时的误触都会触发朗读。没有「点一下读一句」与「连播」的模式区分，也没有朗读中的逐句高亮跟随用户预期。
证据：`src/screens/ReaderScreen.tsx:88-94,47-55`。

### I5 阅读进度与滚动脱节，续读是假的
「第 N 句 / 8」只随播放前进，手动滚动不更新计数与当前句高亮；首页「继续阅读」恒取 `articles[0]`，「63%」和进度条宽度是硬编码字面量——根本不记录阅读位置。
证据：`src/screens/ReaderScreen.tsx:47-55,146-148`、`src/screens/TodayScreen.tsx:9,37,40`（`63%` 两处字面量）；截图 `app-01-today.png`。

### I6 词典卡只能点遮罩关闭，grabber 是骗人的
抽屉把手（grabber）画出来了但没有下拉手势，无 X 按钮；加上无动画（见 V10），弹出/关闭都是瞬跳。
证据：`src/App.tsx:61-64`（仅 dim onClick）、`src/ui/base.css:391-397`（装饰性 grabber）。

### I7 评分不可撤销、无逃生门
四档评分一点立即前进，误触即错档、无撤销；原型 v2 的「跳过这张」在真实 app 复习流里不存在（完形只有提交/看答案，识别只有翻面）。
证据：`src/screens/ReviewScreen.tsx:83-90`、`grep -n 跳过 src/screens/ReviewScreen.tsx` 无命中；对照 `v2-02-review.png`（原型有「跳过这张」）。

### I8 识别卡全程无声
识别模式不播单词发音、翻面后也没有 TTS，靠纯视觉「回想」；而发音链路（Web Speech）就躺在 store 里。一个口语学习产品，复习环节是哑的。
证据：`src/screens/ReviewScreen.tsx:172-193`（识别卡无 speak 调用）。

### I9 遮罩按段落揭示，第一段两句话共用一个中文
tap 中文揭示以段为单位（reveal 的是段落 pi），中英对照粒度错位；「目」按钮无文案、无 onboarding 提示，新用户不知道这是干嘛的。
证据：`src/screens/ReaderScreen.tsx:26-35,82-87,150-152`；截图 `app-05-reader.png`（第 1 段 EN 两句 / ZH 两句连排）。

### I10 收藏动线二选一但无解释、无后续
「收进生词本 / 收为词块」并列给首次用户，没有任何说明两者差别（原型在卡片底部有一行「收藏后整篇自动高亮，SRS 到期进「今天」复习」）；收藏成功后 sheet 直接消失只剩 toast，无「去看看」动作。
证据：`src/App.tsx:96-110`、`src/store.ts:86`；对照 `v2-12-lookup.png` 底部说明行。

### I11 语速循环顺序反直觉
1× → 1.25× → 0.85× → 1×，常用链路（放慢）要按两下；按钮无菜单、无当前速档标识之外的任何 affordance。
证据：`src/screens/ReaderScreen.tsx:161-163`。

## 三、功能（对照「Windows 端有、移动端没有」抓大放小）

### F1 没有词典——查词是 7 个词的假字典
未收藏词 tap 查词走 `MINI_DICT`，总共 7 个词条，数据文件注释自认「spike 词典（未收藏词 tap 查词的假结果；实际实现走 readerDict）」；查不到就显示「（spike：未接入词典）」，而且**照样能把这个没有释义的词收进生词本**。Windows 端的完整词典卡（释义/音标/变形/例句）在移动端不存在。
证据：`src/core/data.ts:101-110`（7 词条+注释）、`src/screens/ReaderScreen.tsx:105-113`；截图 `app-06-dict-sheet.png`（"idea" → 未接入词典）。

### F2 没有翻译
全工程无任何文本翻译调用：阅读页中文是预置数据（`DEMO_ARTICLES` 写死），无划句翻译、无整段对照、无自定义文本翻译入口。Windows 端的核心能力在移动端为零。（grep 全 src 无 translate/翻译调用，仅「直译陷阱」文案。）

### F3 语音三件套整体缺席（口语陪练 / 影子跟读 / 录音直译）
v2 原型已对齐 Mac 端 P4/P5/P6 的三件套并定稿交互（`docs/mobile-v2-brief.md` §1），真实应用零实现：无 PracticeScreen、无录音、无 ASR/评测/LLM 调用，grep 全 src 无 practice/陪练/跟读/直译功能代码。原生侧同样只有 `ping` 和 `storage_probe` 两个 command（`src-tauri/src/lib.rs:19,25-42`）。这是「Windows 有、移动端没有」里最大的一块。

### F4 没有复习触点：无通知、无快速复习
原型 v2 的「通知横幅 → 清一张」闭环（notify/quick）在真实应用不存在：grep 全 src 无通知相关代码，原生侧无 UNUserNotificationCenter 集成。移动端复习提醒 = 0，SRS 排程形同虚设（排程了没人叫你）。

### F5 没有听写卡
判分内核里词级 diff（听写判分）都移植了（`core/judge.ts:52` LCS 对齐），但复习队列只有 cloze | recognition 两种模式，听写卡无入口——原型 v1/v2 都有（`v2-05-dictdiff.png`）。移植了引擎忘了造车。

### F6 没有历史与统计
判分结果只改 `dueAt` 一个字段（`store.ts:92-95`），无答题记录、无错题本、无 streak、无「本周 21 复习 / 6 新词 / 3 陷阱」（原型首页有，`v2-01-today.png`）。复习完的总结页只有 emoji + 一句话（`ReviewScreen.tsx:47-60` vs 原型四格摘要 `v2-14-done.png`）。

### F7 没有数据持久化
全部状态是内存里的 demo 数组（`store.ts:27-32`），杀掉 app 全丢；Rust 侧只写了 `storage_probe` 探针（`lib.rs:30-42`），真实存储层未开工。Windows 端有落盘，移动端是「一次性的」。

### F8 导入/同步只有半截
书架导入解析 .json 后只 toast 计数、明示「spike：不合并」（`ShelfScreen.tsx:14-29`）；无分享扩展收词（原型有 share 模拟，`docs/mobile-spike-report.md` §6 也只做了预研）；无剪贴板兜底。电脑 → 手机的内容与生词流转未闭环。

### F9 书架没有内容来源
只有 2 篇演示文章 + 1 篇压测文章；无 RSS/网页/文件/剪贴板任何真实内容入口。Windows 端的内容库在移动端无从谈起。

### F10 TTS 链路只够「能响」
Web Speech 逐句连播 + onend 兜底（`store.ts:127-154`），无语速持久化、无领读/慢速、无评测；spike 报告里 S3a/S4 全部「待执行」（`docs/mobile-spike-report.md:71-77`）——连 WebView 上 TTS 是否可靠都还没验证完。

## 四、信息架构

### A1 4 Tab vs 已定稿的 5 Tab，语音练习没有入口
真实 app 是 今天/生词/书架/我的（`src/App.tsx:11`）；v2 原型定稿 5 Tab 今天/练/书架/生词/我的（`docs/mobile-v2-brief.md` §0,§2.1，`v2-01-today.png` tab 栏）。缺「练」Tab 不是少一个页面，是整条练的业务线（见 F3）无处安放；且生词/书架顺序与定稿不一致。

### A2 书架 = 调试页
「压测（S2）」文章以一级卡片摆在外面，文案是「600 句全量渲染 · 观察右上角角标（首屏渲染 ms）」；导入卡标题「导入同步文件（S5）」。内部实验项与用户内容平级混排。
证据：`src/screens/ShelfScreen.tsx:38-58`；截图 `app-03-shelf.png`。

### A3 首页没有回答「今天该干什么」
真实首页 = 大数字 + 开始复习 + 一张假续读卡（`app-01-today.png`），仅此三样；原型的 streak、进度点阵、练一练快捷入口、本周统计全部未实现（`v2-01-today.png`）。首页作为每日动线的枢纽是空的。

### A4 词典卡信息不足以支撑收藏决策
真实卡片：词 + 类型徽章 + 可能为空的释义 + 来源句（无出处标注）；原型卡片：释义 + 来源句 + 「来自《文章》· 第 N 句」+ 收藏后行为说明（`app-06-dict-sheet.png` vs `v2-12-lookup.png`）。用户在信息最少的形态里被要求做「收单词还是收词块」的决定。

### A5 复习卡缺少上下文与阶梯
原型完形卡有「来自《Why Cities Need Trees》」出处、中文提示虚线、提示阶梯（释义→首字母→槽位记法）、跳过；真实 app 全没有，只有一句被下划线串替换的中文。同一功能在原型里是教学动线，在 app 里是考试。
证据：`src/screens/ReviewScreen.tsx:112-169` vs `v2-02-review.png`。

### A6 「我的」没有承担「我的」该有的任何职责
无账号/设备、无学习目标（每日新词量、提醒时间）、无跟读及格线、无导出格式、无反馈/关于（这些在 v2 brief §1 里已规划为「我的 · 练」分组）；实际内容见 V2。设置类信息架构整体缺位。

---

## 附：本次实际执行的命令

- `find immersive-translator-mobile/src -type f` / 通读 10 个源文件（行号引用均出自本会话读取）。
- `npm run dev`（immersive-translator-mobile/）→ `http://localhost:5174`；playwright sync_api 截真实应用 7 屏（`app-01…07`），`pageerror/console error` 均为 none。
- playwright sync_api 截 v2 原型 16 状态 + v1 原型 2 屏（首脚本因同文档 hash 跳转不触发 IIFE 而全部截成今天页，已用 about:blank 隔离重截，复现见 `/tmp/v3_shots.py`、`/tmp/v3_shots2.py`）。
- `grep` 验证：deleteWord 零调用、autoFocus 零命中、base.css 仅 1 处 transition、全 src 无通知/练习/听写/持久化代码、MINI_DICT 7 词条、`App.tsx:69` 发音按钮为 console.log。
- 未做（如实说明）：未在 iOS 真机/模拟器上跑（本会话环境无设备连接），真机手感类结论以 spike 报告与原型 Playwright 实测为准；未盘点 Windows 端代码，功能对照仅按 ask 指定的「抓大的」清单。
