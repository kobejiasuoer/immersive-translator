# 正式移动端阅读重设计 · 2026-11-05

接续阅读修复与真机验收。用户仍不满意书架及进入阅读后的视觉，并质疑独立中文展示模式；本轮直接修改正式 React / Tauri 应用。

状态更新：正式重设计及后续真机选词修复已于 **2026-11-05 22:18（Asia/Shanghai）** 原位安装。干净新闻已保存，最终书架、正文及帮助截图已取得，最新 25 篇章节 / 文章及 13 个收藏保留。详见 [最终验收记录](reader-redesign-final-acceptance-2026-11-05.md)。下文保留 07:41 初次重设计安装的历史记录；晚间实际发现并修复了初版的 iOS 选词解释竞态，不能把早晨浏览器通过视作该问题已验证。

## 设计约定

- 目的：打开一本书或一篇文章，连续读英文；遇到困难后再主动求助。书架帮助找到内容，正文帮助保持阅读。
- 基础色：白色 `#ffffff`、浅灰绿 `#f3f5f4`、正文 `#18231f`、次要文字 `#68756f`、品牌绿 `#246b59`。日间以白色页面为主；夜间与暖纸色作为用户可选偏好继续保留。
- 字体：系统字体承载中文导航和控件；英语正文使用设备上的 New York / Georgia 衬线字体。标题以字号、字重和行距建立层级，正文 20–22px、约 1.75 行距，限制行长。
- 书架：大标题、单一明确的续读入口、真实封面或有身份区分的文字封面、安静的内容列表。搜索与导入在固定位置，进度是辅助信息。减少重复统计、营销式介绍和大块绿底卡片。
- 阅读：小型导航栏；作者、篇名和自然段形成正文主体。取消顶端英文 / 双语 / 中文分段栏，不提供整页中文阅读。已保存的译文与历史偏好仍保留在数据中；译文只在主动打开的词句帮助中展示。
- 求助：原生选择与复制保持可用；选中词或短语后主动解释。手动查词、当前句帮助和收藏保留可发现且可键盘操作的入口。无自动联网解析，也不把练习插入连续阅读。
- 朗读：默认一个低矮的小型播放控件，明确显示播放 / 暂停与展开入口；上下句、语速、当前句工具放在展开状态，保留现有播放、断点和完成链路。
- 动效：触按即时反馈，面板沿相同路径开合；复用已验证的手势与焦点管理。适配 reduced motion / transparency / contrast，不堆装饰动画。

布局从左对齐的正文和书籍身份展开，书架封面承担主要视觉记忆点。避免把白色页面变成整齐划一的圆角卡片、统计仪表盘或整页暖黄模板。

## 正式实现

书架用白色页面、大标题“阅读”及固定搜索 / 导入行组织内容，右上保留账号入口。续读缩为一个低矮入口，省去重复的当前长句、首页统计和登录营销条。书籍与短文按原身份和最近阅读 / 导入顺序列出，显示真实封面或按独立身份区分的文字封面、作者或来源、章节 / 时长与断点。同名不同 ID 保留版本区分；类型和阅读状态筛选、目录、重命名、移出 / 恢复、重新提取网页及生词本入口继续沿用现有链路。

阅读页的主体为英文标题、作者和连续自然段，移除原来的英文 / 双语 / 中文分段栏；历史中文模式、已保存译文及个人修改仍留在资料中。顶部只保留返回书架、目录与排版设置。朗读器默认显示播放、句数、帮助与展开入口，展开后才显示上下句、语速、当前句工具、手动查词与跟读。章节继续、标记完成、播放状态和持久断点沿用原有行为。

选中文字后出现明确的主动解释入口，普通选取与复制不会自动请求模型。词 / 短语继续进入现有词典，整句进入句子帮助；关闭选文或模态后返回稳定的阅读帮助入口并保留阅读位置。句子中文意思只在用户主动打开的帮助面板中查看，已保存释义、例句和收藏链路保留。排版设置精简为主题、字号与行距，默认阅读偏好为英文、20px、1.78 行距、无持续词块标记。

这轮已有部分 `reader-first` 原型的选文行为进入正式应用，但现有词典仍主要展示中文释义，句子帮助也保留按需查看中文意思。不能据此宣称原型中的全部英文语境释义、英文改述和句子结构服务已完成集成。

实现入口：

- [ReadingHome 与书架组件](/Users/yangbishang/Projects/immersive-translator/immersive-translator-mobile/src/screens/LearningHome.tsx)；[书架局部样式](/Users/yangbishang/Projects/immersive-translator/immersive-translator-mobile/src/screens/libraryExperience.css)。同文件内的口语、笔记和复习页面实现未改。
- [ReaderScreen 正文、选文和朗读](/Users/yangbishang/Projects/immersive-translator/immersive-translator-mobile/src/screens/ReaderScreen.tsx)；[阅读局部样式](/Users/yangbishang/Projects/immersive-translator/immersive-translator-mobile/src/ui/readerExperience.css)。
- [SettingsSheet 排版设置](/Users/yangbishang/Projects/immersive-translator/immersive-translator-mobile/src/components/reading/SettingsSheet.tsx)；[SentenceSheet 主动句子帮助](/Users/yangbishang/Projects/immersive-translator/immersive-translator-mobile/src/components/reading/SentenceSheet.tsx)。
- [store 默认偏好与数据保留](/Users/yangbishang/Projects/immersive-translator/immersive-translator-mobile/src/store.ts:287)。旧译文、章节身份、收藏及断点没有删除或重建。

## 已完成验证

以下回归均执行正式源码；网络与音频替身验证控制流，不替代真实系统声音或所有外部站点行为。命令在 `immersive-translator-mobile/` 执行。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `node scripts/reader-regression-test.mjs` | 32 / 32 | 英文连续正文、选文状态、朗读展开、句子帮助、取消 / 重试与断点 |
| `node scripts/sheet-interaction-test.mjs` | 29 / 29 | 模态焦点、Tab / Escape、叠层与手势 |
| `node scripts/translate-test.mjs` | 46 / 46 | 翻译生命周期、资料切换、阅读方向覆盖 |
| `node scripts/storage-test.mjs` | 8 个场景通过 | 持久化与资料恢复 |
| `node scripts/sync-test.mjs` | 31 / 31 | 同步身份、元信息与正文关系 |
| `node scripts/dict-login-test.mjs` | 17 / 17 | 词典展示、释义收藏与登录续接 |
| `node scripts/draft-test.mjs` | 22 个场景通过 | 导入 / 笔记草稿、书架重命名、离线恢复与异步竞态 |
| `npx tsc --noEmit` / `npm run build` | 通过 | 类型及正式 Vite 构建 |
| `git diff --check` | 通过 | 补丁空白及冲突标记 |

正式 React 应用在 **320 / 390 / 768 / 1024 / 1440px** 五种真浏览器宽度下无横向溢出，操作按钮至少 **44px**，正文行宽不超过 **640px**。以保留的干净新闻正文检查长内容，135 字符英文标题完整换行，19 句按原文 10 个自然段排列；没有把每句拆成大卡片。这些结果限定于已检查样例与组合。

390px 真浏览器已通过原生拖选 `take a break` → 点击“解释” → 打开对应词典 → Escape 关闭的实际操作，焦点回到稳定的“阅读帮助”按钮；选文对象与阅读位置没有被关闭过程覆盖。这是浏览器实际选区及模态操作证据，仍需在最终 iOS WebView 中补手机触屏检查。

## 原生构建、签名与本轮安装

在前端构建与浏览器检查通过后，沿用 [iOS 启动修复流程](/Users/yangbishang/Projects/immersive-translator/docs/mobile-ios-startup-fix-2026-11-04.md)，保持原 DerivedData 和 ASCII 内部名称：

```sh
xcodebuild \
  -project src-tauri/gen/apple/imreader-mobile.xcodeproj \
  -scheme imreader-mobile_iOS \
  -configuration release \
  -destination 'id=00008150-001620CC3C92401C' \
  -derivedDataPath /tmp/codex-mobile-standalone-2026-11-04 \
  -allowProvisioningUpdates \
  PRODUCT_NAME=immersive-speaking build
```

结果为 `BUILD SUCCEEDED`，日志在 `/tmp/codex-reader-redesign-final-build-2026-11-05.log`。`codesign --verify --deep --strict --verbose=2` 通过；bundle id 仍为 `com.kobejiasuoer.reader`，内部可执行名为 `immersive-speaking`，桌面显示名仍为“沉浸口语”。

当前入口为 **`index-DRrgUHjD.js`**，样式为 **`index-EH_F5hcZ.css`**。全部 8 个当前 JS / CSS 资源已核对完整字节入包：用 Node 内置 Brotli 解压原生编译缓存，逐文件与当前 `dist/assets` 比较字节完全相等，再确认每个完整压缩 payload 存在于最终 `.app` 二进制中。新正文、朗读、选文和书架标记 `reader-document` / `reader-listen` / `reader-selection` / `reader-help-button` / `library-experience` / `library-resume-main` 及对应新控件文案均存在，通知桥也仍在。核验结果为 `/tmp/codex-reader-redesign-native-assets-2026-11-05.json`；没有仅凭版本号或文件名判断已带入本轮界面。

**2026-11-05 07:41:47（Asia/Shanghai）原位安装成功。** `devicectl` 返回 `App installed`，最终路径为 `/private/var/containers/Bundle/Application/2F92E82A-B9BE-4EB5-AB89-3BED594FE061/immersive-speaking.app/`。安装结果保存在 `/tmp/codex-reader-redesign-final-install-2026-11-05.json`。本轮没有卸载应用、打 tag、提交代码或更改其他平台包。

更新后的 IPA 为 [沉浸口语.ipa](/Users/yangbishang/Projects/immersive-translator/immersive-translator-mobile/src-tauri/gen/apple/build/arm64/沉浸口语.ipa)，内部为 `Payload/immersive-speaking.app`，ZIP 完整性检查通过；SHA-256：`1600a156e8a5087fc48f3f2df3e91d5bd294e2d061871d7544487cb262022c7c`。本轮之前的 IPA 保存在 `/tmp/codex-reader-before-redesign-2026-11-05.ipa`，更新结果在 `/tmp/codex-reader-redesign-final-ipa-2026-11-05.json`。

## 安装后数据核对与剩余真机证据

07:27 安装前基线为 `/tmp/codex-reader-redesign-before-install-2026-11-05/ApplicationSupport`。07:42 安装后只读复制到 `/tmp/codex-reader-redesign-post-install-2026-11-05/ApplicationSupport`，复制结果为 `/tmp/codex-reader-redesign-post-install-copy-2026-11-05.json`。

两个资料库均保留；当前资料的 **19 篇章节 / 文章、13 个收藏**及全部原 ID 存在。文章、词条、笔记、阅读进度、个人译文和完成状态与 07:27 基线逐条完全相同。原新闻仍为 30 句，断点为索引 11（界面第 12 句），这也是 07:27 基线的值；不能套用更早 00:53 的索引 9。结果为 `/tmp/codex-reader-redesign-data-check-2026-11-05.json`。

07:42 时干净新闻仍为待保存草稿，与 07:27 基线相同：粘贴模式、预览已打开、标题 135 字符、输入及完整正文各 2839 字符。后续已于 07:56 在手机点击保存，晚间完成选词和面板检查及最终安装。实际结果、截图、最新数据基线与仍存的分句边界问题均见 [最终验收记录](reader-redesign-final-acceptance-2026-11-05.md)。
