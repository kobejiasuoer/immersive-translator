# 官网清晰阅读与书架素材来源

制作日期：2026-11-05。对应本次官网预览的阅读、书架与书对象视觉修正。所有文件均为新素材，未覆盖 2026-11-04 原图及已有细节图。

## 来源与真实边界

素材来自当前 Windows 工程的 `ReaderApp.tsx`、`ReadingView.tsx`、`ShelfPage.tsx` 及其原有 `reader.css`。通过独立临时 Chrome 渲染，使用 `.taste-skill/product-capture.mjs` 中已经存在的匿名文章、三本书与生词夹具；没有重绘界面、修改应用业务代码或拼接出不存在的 UI。

文章是《The Nightingale and the Rose》开头节选，中文为原演示脚本的自写译文；书名、作者、进度、阅读时长、考纲数量及复习数量均为演示数据。不能据此声称真实用户成绩、AI 服务已经验收或实际学习效果。

阅读设置采用应用支持的最大字号 **24px**（`readerTypes.ts` 的 `READER_FONT_SIZE_MAX`），行距设置 1.05、段落排版、译文遮罩开启，全部句子未揭开。拍摄前解除文本选中，鼠标移到画面外，确认 `.translation-pop` 数量为零。正文没有被译文浮层、设置浮层或 hover 遮挡。

手机用途的阅读图是**Windows 阅读组件片段**：在临时匿名预览外壳中直接挂载同一个 `ReadingView`，使用与 `ReaderApp` 一致的 `reader-root` / `reader-body` 包装和未修改的应用 CSS，不挂外部 `DictColumn`。这避免完整 Windows 外壳在窄窗把解析栏覆盖到正文上；它不代表移动端已上线，也不是新绘制的手机应用 UI。480px 宽的实际响应式列让正文在官网按 335px 宽完整缩放时约为 16.75px。

## 输出文件与裁切区域

全部使用 **deviceScaleFactor=2**，WebP quality=96。裁切坐标是浏览器中的 CSS 像素，输出像素为其两倍。阅读的裁切终点根据第二个完整 `.prose-paragraph` 的实际末行计算，停在第三段前的段落间隙；没有截断单词、末行或下一段开头。

| 文件 | 输出像素 | 捕获视口（CSS px） | 裁切框 x,y,w,h（CSS px） | 实际区域 |
|---|---|---|---|---|
| `product-reading-clean-desktop-2026-11-05.webp` | 1280×1046 | 1440×1000 | 206,129,640,523 | 正常 `ReaderApp` 中完整 `.reading-col` 宽度，完整章节题头、完整英文标题和中文副题、前两个完整段落组；不包含右栏与底部渐隐。 |
| `product-reading-clean-phone-2026-11-05.webp` | 960×1306 | 480×1500 | 0,117,480,653 | 临时预览中当前 `ReadingView` 的完整窄正文列，完整题头和前两个完整段落组；无右侧解析栏覆盖。 |
| `product-library-clean-desktop-2026-11-05.webp` | 2080×1230 | 1440×1000 | 200,66,1040,615 | 实际 `.shelf-wrap` 元素，从书架页头到完整发现入口卡及原有底部内边距；不包含内容结束后的空白渐变画布。 |
| `product-library-clean-phone-2026-11-05.webp` | 960×1186 | 480×1850 | 0,66,480,593 | 当前 `ShelfPage` 的完整页头、完整主书卡与两条紧凑书目，停在书目列表结束；其后的统计与发现入口不在这个片段中。 |
| `product-night-cover-2026-11-05.webp` | 248×352 | 1440×1000 | 247,154,124,176 | 当前 `ShelfPage` 第一本文学作品的真实 `.shelf-cover` 元素边界；原组件的书名排版与背景，不是新设计的书封。 |

新图按自身比例完整显示；手机图不应继续套用固定高度或 `object-fit: cover`。若正文被缩至小于 14px，应改用窄列版本或调整展示宽度。

## 隔离与实际验证

- 本地开发服务为 `http://127.0.0.1:1420/`，使用工程已经安装的 Vite；没有安装或更新依赖。
- Chrome 使用独立临时 profile；不操作用户已有标签页，不读取真实账号、API Key、学习资料、录音或麦克风。
- IPC 替身明确使用匿名账号、`guest` 空间、`website-demo` 设备及空同步列表；外部目录响应关闭。默认未配置任何真实服务。
- CDP Fetch 仅放行本地 Vite origin 与 data URL。正常应用外壳尝试加载 Google Fonts 的请求被阻断，使用现有系统回退字体。没有下载外部字体、图片或视频。
- 五个最终输出均无 JavaScript Runtime exception；无页面横向溢出。两张阅读图 `.translation-pop` 均为零。
- 正常 `ReaderApp` 匿名夹具触发两条 `[learning-sync] 登录后才能同步学习资料` console error，保留在诊断中；没有向生产同步，也不据此宣称同步验收通过。
- 临时单组件预览出现一条 Vite HMR WebSocket 连接诊断；组件已完整渲染、无 Runtime exception、未触发外部业务请求。这是拍摄外壳的热更新诊断，不作为应用问题隐藏。
- 已逐张打开最终输出检查：章节题头离边缘有原组件内边距，英文标题完整，前两段始末完整；书架主卡、紧凑书目和发现入口无边缘截断，底部没有长空画布。

复现脚本：`.taste-skill/product-clean-capture-2026-11-05.mjs`。最终诊断：`.taste-skill/product-clean-2026-11-05/capture-report.json`。探测用 PNG 与 `probe-report.json` 仅用于临时视觉检查，不属于网站部署素材。完整原图及先前素材来源继续见 `screenshot-upgrade-provenance-2026-11-04.md`。

## 手机口语与复习补拍

同日补拍四张新图，继续采用当前真实组件及原有 CSS，未修改应用业务文件。口语通过既有 `speak-preview.html?s=done&theme=sepia` 挂载当前 `SpeakView`，从真实预览按钮恢复其匿名会话，只截取完整的第一轮 AI 问题和用户回答。没有触发录音、真实语音评测、TTS 或 LLM；4.2/5.0 发音分与目标词命中状态仍是原预览的模拟数据。

复习通过既有 `review-preview.html?v=focus&theme=sepia` 挂载当前 `VaultPage`，采用其真实单列专注状态。为避免原预览夹具里的占位释义与不匹配原句，继续复用 2026-11-04 已记录的浏览器响应替换：补齐 unwind／take root 释义、与 source 索引一致的示例句及 `Reading and New Ideas`／`Finding the Right Address` 示例来源名。替换仅作用于开发预览夹具响应，复习组件、判分与应用代码未变。

复习图展示一次完整的初始完形任务，包含题干、输入框、两级提示、提交／放弃操作和底部说明。题干中的 `Reading helps me unwind, and new ideas begin to take root.` 是沿用夹具的自写示例，不冒充真实文章摘录。没有提交答案或改变复习结果。

| 文件 | 输出像素 | 捕获视口（CSS px） | 裁切框 x,y,w,h（CSS px） | 实际区域 |
|---|---|---|---|---|
| `product-speaking-clean-phone-2026-11-05.webp` | 864×734 | 850×1250 | 31,197,432,367 | 第一轮完整 `.dialogue-turn` 与紧随其后的完整 `.dialogue-turn.mine`，含8px边缘留量；不包含后续对话的半行或右侧评测栏。 |
| `product-review-clean-phone-2026-11-05.webp` | 860×1254 | 480×1200 | 25,56,430,627 | 完整 `.vault-page .focus-wrap`，一张原生专注完形任务，无开发说明条或后续任务截断。 |
| `product-speaking-clean-desktop-2026-11-05.webp` | 1788×694 | 1440×1250 | 31,137,894,347 | 桌面预览中同一轮完整 AI 问题与用户回答，保留原生左右错位，不把段落边界截断。 |
| `product-review-clean-desktop-2026-11-05.webp` | 1360×1094 | 960×1200 | 140,38,680,547 | 原生专注复习模式完整 `.focus-wrap`，同一完形任务的宽列版本。 |

全部2×DSF、WebP quality96。口语原文使用组件固定的19px字号，432px逻辑宽度在官网335px展示时约为14.73px；复习题干为原生26px，430px逻辑宽度在335px展示时约为20.26px。译文、操作与状态属于组件原有次级字号，没有为拍摄改写字号。两张手机图仍应按自身比例完整显示。

四张最终图均已逐张打开检查：完整题干、对话末行、用户回答卡的四边与复习任务全部操作完整。诊断中的 Runtime exception、console error、横向溢出和外部请求均为空。复现脚本 `.taste-skill/practice-clean-capture-2026-11-05.mjs` 实际退出码0；完整诊断及原生预览整屏探测PNG位于 `.taste-skill/practice-clean-2026-11-05/`，不作为部署素材。

## 手机书架内容聚焦图

原生 `ShelfPage` 窄布局把主书封面置于书名上方，其右侧会留下空白。为让官网手机展示更紧凑，再生成 `product-library-phone-focus-2026-11-05.webp`，保留前面全部原图。

该图使用同一真实 `ReaderApp` / `ShelfPage` 和匿名夹具，重新渲染后按原生元素边界进行**一次连续裁切**，没有拼接、重绘、挪动元素或修改组件样式。裁切从 `.shelf-bookmain` 顶部前的安全间隙开始，封面位于裁切框上方；连续包含书名、作者、元数据、阅读进度、继续阅读／目录控件，以及 `.shelf-booksmini` 中完整的 Alice 和 Pride 两条书目。终点保留10px留量，随后统计区域不在片段中。

| 文件 | 输出像素 | 捕获视口（CSS px） | 裁切框 x,y,w,h（CSS px） |
|---|---|---|---|
| `product-library-phone-focus-2026-11-05.webp` | 960×646 | 480×1850，DSF=2 | 0,336,480,323 |

WebP quality96。原生22px主书名按335px宽展示时约15.35px。已实际打开输出检查，书名、作者、进度、阅读控件及两条书目完整，没有上方封面和大块空白。旧 `product-library-clean-phone-2026-11-05.webp` 与桌面图保持原样。

复现：`node .taste-skill/product-clean-capture-2026-11-05.mjs --library-focus`，实际退出码0。单独诊断在 `.taste-skill/product-clean-2026-11-05/library-focus-report.json`；无Runtime exception或横向溢出。匿名同步与字体请求阻断诊断仍如上节所述，未隐藏。
