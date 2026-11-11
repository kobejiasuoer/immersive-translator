# 沉浸口语 · Apple Native 精修交付 · 2026-11-07

本轮已实际修改、运行并构建 `immersive-translator-mobile`。在上一轮未提交成果之上继续精修，未重写 API、SQLite/IndexedDB、账号数据、ASR/TTS 或 SRS。修改前将完整移动端源码基线保存于 `/tmp/immersive-apple-refinement-2026-11-07-baseline`，未提交、推送或发布版本。

[前后截图画廊](mobile-apple-refinement-2026-11-07/index.html) · [三个首页最终效果](mobile-apple-refinement-2026-11-07/after-overview.png) · [前后对照](mobile-apple-refinement-2026-11-07/comparison.png) · [本轮准确变更清单](mobile-apple-refinement-2026-11-07/changed-files.json)

## 1. 审查依据与工程事实

已阅读本地 `apple-design` 完整技能、`ui-skills-root` 及 `apple-web-app` 的布局、键盘和系统外观参考。已有 Apple Design 技能，无需另行安装。官方资料通过 Apple 文档 JSON 读取；搜索工具当时返回网关 404，改用 Apple 官方站点直接读取。

参考：[Apple HIG](https://developer.apple.com/design/human-interface-guidelines/)、[Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)、[Typography](https://developer.apple.com/design/human-interface-guidelines/typography)、[Materials](https://developer.apple.com/design/human-interface-guidelines/materials)、[SF Symbols](https://developer.apple.com/design/human-interface-guidelines/sf-symbols)、[Design Resources](https://developer.apple.com/design/resources/)。

工程为 React 19 + TypeScript + Vite + Tauri 2 / WKWebView；最低 iOS 16，Vite 构建目标 safari16。本机检查环境为 iPhone 17 模拟器、iOS 26.5。现有桥接包括触感、系统分享、剪贴板、深链、通知、语音与音频会话。没有引入新的原生框架或大型依赖。

## 2. Apple HIG 审计与落地

| 审计问题 | 最终处理 |
| --- | --- |
| 全页偏绿，内容卡片和操作层争抢注意力 | 中性浅灰/纯黑页面、白色/深灰分组；绿色集中在主操作和状态。 |
| 标题固定、控件与说明普遍偏小 | 34px 系统大标题，滚动后显示行内标题；正文17px、次级15px、说明13px，使用字号缩放。 |
| 续读、口语、复习有多层卡片/网格 | 续读和表达去外框；场景、掌握阶段、搜索结果用分隔列表。 |
| 口语作答像聊天气泡 | 问题、我的回答、建议采用平铺文稿层级，录音操作与真实状态保持突出。 |
| 二级页离开 Tab 后丢失位置 | 每个 Tab 保留自己的页面树、筛选、查询、滚动及局部草稿；普通二级页仍可切 Tab。 |
| 隐藏页异步操作可能跳入另一 Tab | 导航方法绑定所属 Tab，后台页面的 Portal 隐藏；恢复时回到原页面。 |
| 新缓存需要账号隔离边界 | 切换账号清空页面与局部表单，旧导航回调失效；明确的游客登录仅保留当前受保护操作的活动页面链。 |
| 阅读暖色会污染全局主题 | 暖色纸面局限于阅读器，不覆盖系统/应用深色外观。 |
| 模态层和底栏层级冲突 | 底栏位于普通页面上方、抽屉下方；保存操作可点，焦点被约束在模态中。 |

## 3. 统一设计方向

采用 Apple Native + Editorial Minimalism：系统操作界面与英文阅读内容使用不同排版，留白和分组承担层级，材质仅用于导航等功能层。

**按用户最后补充要求，完整保留液态玻璃滑动 Tab 组件。** 保留跟手拖动、速度投射、可打断弹簧、边界阻尼、点击消歧、多触点取消与 Reduce Motion；更新材质和图标以融入新界面。它是产品有意保留的 WebView 自定义组件，未宣称接入系统 Liquid Glass。

阅读器、口语练习和复习流程保持专注的全屏路径；书库、搜索、生词本等普通二级页面可直接切换 Tab。账号、语音设置、导入等操作继续由页头或抽屉承载。

## 4. 页面变化

| 页面 | 本轮结果 |
| --- | --- |
| 阅读首页 | 大标题、页头导入、全宽搜索、轻量书库/订阅入口；分段内容筛选；续读与书目使用分隔行，英文标题优先。 |
| 口语首页 | 无框“一个表达，一句话”；真实续练状态；场景改为分隔列表，自由练习与原文跟读同组，保留生词本/历史/语音入口。 |
| 笔记与复习 | 无框今日任务、单行复习方式、优先呈现这一轮的表达；掌握阶段改为分组行，词库提供系统 select，笔记支持本地搜索。 |
| 阅读器 | 中性纸面及独立暖色/夜间纸色；连续正文、清晰选择反馈、居中标题和克制朗读控件，保留查词、翻译、收藏与跟读。 |
| 口语详情 | 问题/回答/建议文稿层级；显示“录音中”、真实音量和 m:ss 时长；保留转写、处理中、失败恢复、草稿与退出逻辑。 |
| 复习/笔记详情 | 去掉题卡外框和装饰条，收紧过大的顶栏留白；标题与题型文案更准确，保留自评和计划。 |
| 相关设置 | 继承统一系统字体、导航、按钮、输入框、模态和主题；没有重做已有账号与权限业务。 |

## 5. Design System 与系统能力

- 色彩：浅色背景 `#F2F2F7`、内容 `#FFFFFF`、文字 `#1C1C1E`、品牌绿 `#246B52`；深色背景 `#000000`、分组 `#1C1C1E`、文字 `#F2F2F7`、强调 `#91CFAD`。
- 字体：系统 `-apple-system` / PingFang 回退用于界面；`ui-serif` / New York / Georgia 回退用于英文内容，没有打包分发 Apple 字体。
- 字号：34/20/17/15/13 的角色分层，沿用应用字号设置；这不是新的原生 Dynamic Type 桥接。标签栏文案保持11px，避免放大时挤压导航。
- 触控：主要操作至少44px；文本输入保留系统字号、缩放与正文选文。
- 动效：不增加首页循环动画，保留玻璃导航原有可中断运动；减少动态效果、减少透明度和增强对比度有降级样式。
- 图标：使用系统 `NSImage(systemSymbolName:)` 导出55个静态单色 SF Symbols 资产（96×96，按24pt使用），经 CSS mask 随主题着色。核心语义包括 `book/book.fill`、`waveform`、`note.text`、`mic`、`magnifyingglass`、`gearshape`、`bookmark`、`play.fill`、`pause.fill`、`clock.arrow.circlepath`、`square.and.arrow.up`。完整对应关系在 `public/symbols/symbols.json`。
- Apple 平台使用这些静态资源；非 Apple 环境仍使用原有 SVG。未接入 UIKit/SwiftUI 图标 API、原生 Symbol Effects、原生导航栏或原生 Liquid Glass。
- 现有触感、分享、通知、录音和权限桥接保留；本轮未新增系统能力。

## 6. 重要代码

- `src/ui/tokens.css`、`product.css`、`LearningHeading.tsx`：主题、排版、材质、标题与共享控件。
- `src/ui/GlassNav.tsx`：保留原有拖动/弹簧逻辑，增加统一符号及键盘焦点路径。
- `src/App.tsx`、`ui/nav.tsx`、`components/reading/Drawer.tsx`：分 Tab 页面保持、所属导航绑定、账号边界、隐藏 Portal 和模态层级。
- `src/screens/LearningHome.tsx`、`libraryExperience.css`、`ui/readerExperience.css`：阅读与搜索呈现。
- `src/screens/SpeakingHome.tsx`、`speakingExperience.css`、`LearningPractice.tsx`、`practiceConversation.css`：口语首页和练习呈现。
- `src/components/vault/VaultBody.tsx`、`vaultExperience.css`、`NotesScreens.tsx`、`ReviewScreen.tsx`、`QuickReview.tsx`：知识库、笔记与复习。
- `src/ui/icons.tsx`、`public/symbols/`、`scripts/export-apple-symbols.swift`：SF Symbols 静态资源与非 Apple 回退。
- `scripts/apple-navigation-test.mjs`：新增跨 Tab、模态与账号隔离浏览器验收；`smoke.mjs` 仅适配导入按钮新可访问名称。原手势测试完整保留。

## 7. 实际运行与验证

| 验证 | 结果 |
| --- | --- |
| TypeScript + Vite 生产构建 | 通过。保留既有大于500kB的 chunk 提示，未引入依赖。 |
| iOS aarch64-sim debug 构建 | 通过，产物 `src-tauri/gen/apple/build/arm64-sim/immersive-speaking.app`。 |
| codesign --verify --deep --strict | 通过。 |
| Smoke | 18 项通过。 |
| 阅读器 / 阅读书库 | 阅读器36项、书库回归通过。 |
| 字典与登录 | 28 项通过。 |
| 账号设置 | 5 项通过。 |
| Sheet / 键盘 | 29 项通过。 |
| 草稿与复习 | 23 项通过。 |
| 录音失败/恢复 | 24 项通过。 |
| 原液态玻璃手势 | 19 项通过，包括触摸/鼠标、投射、打断、边界、取消、Reduce Motion、清理。 |
| 实际浏览器导航 | 9组通过：真实拖动、键盘、跨Tab筛选/滚动/搜索、全屏路径、抽屉、隐藏Portal、账号切换。 |
| 原应用学习路径 | 实际阅读→查表达→收藏→练习草稿→返回原文，及320/390/430/768宽度首页检查通过，无横向溢出或运行错误。 |
| 字号与主题 | 130%/140%/200%局部检查、三个首页深色、独立阅读夜间/暖色检查通过。 |

完成至少两轮视觉复核。第一轮修正了抽屉被底栏覆盖的问题；后续检查完善隐藏页面/账号边界，按用户偏好恢复玻璃手势，并重新采集最终截图。

模拟器中实际完成安装和启动，查看阅读、口语、笔记首页、浅/深色、安全区、系统状态栏和 Home Indicator；实际调出系统软键盘并输入搜索，结果和输入框正常。最终玻璃底栏的点击切换和浅深色外观已检查。

模拟器自动拖拽注入两次没有触发切页，因此**不将其算作 iOS 触摸拖动验收通过**；完整原手势实现、浏览器实际拖动及组件手势回归均通过。仍需真实 iPhone 确认触摸滑动手感。

## 8. 仍需真机验证

真实麦克风权限和录音、联网 ASR/TTS 全链路、音频中断/耳机切换、触感、系统分享、真实 Dynamic Island/状态栏组合、VoiceOver 朗读顺序、系统大字与应用字号的组合、玻璃导航真实触摸及录音中软键盘切换。本轮没有将浏览器测试夹具的结果算作真机结果。

`before/` 来自保存的修改前源码实际运行；`after/` 来自最终源码相同的隔离浏览器操作流程。`simulator/` 为模拟器实际截图；其余 review 目录保留中间轮检查材料，可能显示中间版本。最终效果以 `after/` 和模拟器最终首页截图为准。
