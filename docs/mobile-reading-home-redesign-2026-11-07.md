# 移动端阅读首页改版需求文档（2026-11-07）

- **范围**：`immersive-translator-mobile` 阅读 tab 根页（ReadingHome）按设计稿重构；三 tab 导航结构与口语/笔记两页仅受胶囊 tab 栏换肤波及。
- **路径基准**：下文 `src/…` 均指 `immersive-translator-mobile/src/…`；行号以 2026-11-07 工作区抽查为准（已逐条核验，未核实项单独标注）。
- **定稿结论**：首页按设计稿重构为「大标题 + Hero 轮播 + 四宫格 + 分类横滑 + 精选推荐 + 继续阅读」的信息架构，所有区块落到现有书架/进度/精选目录/复习到期数据上；无数据支撑的元素（评分、热门榜单、消息中心、畅销/上新分类、照片资产）逐一降级、合并或本期不做。

## 1. 背景与目标

**现状**：阅读首页是「页头 + 筛选工具行 + 全量书架列表 + 两行发现入口」的工具型结构（`src/screens/LearningHome.tsx:117-165` ReadingHome），缺少内容消费引导，新用户首屏面对的是空书架与筛选器。

**目标**：

1. 信息架构升级为内容型首页——首屏先给「读什么」（Hero/推荐/横滑分类），再给「我的」（四宫格/继续阅读），全量书架能力不砍、只挪位置（去留方案见 §10-1）。
2. 视觉落地设计稿「温润自然系」：米白暖底、深绿唯一点缀色、衬线书名、大圆角白卡。
3. **所有区块必须落在真实数据上**：不造假评分、简介、榜单、上新流；设计稿中无数据支撑的元素按 §4 逐一处置。

**成功标准**：新用户首屏 3 秒内有一条可开始的阅读路径（starter / 精选 / 继续阅读）；老用户全部既有能力（导入、筛选、目录、整理、生词本、复习）可达；`npm run smoke` / `nav:test` / `reading-library:test` 全绿；iOS 16 与 dark/sepia 档不破版。

## 2. 设计稿解读摘要

设计稿为 iPhone 单屏稿，9 个区块自上而下：系统状态栏、大标题区（「阅读」+副句+搜索/消息圆钮）、Hero 轮播卡、四宫格快捷入口、分类横滑区（5 卡）、精选推荐大卡（含换一批）、继续阅读卡、底部悬浮胶囊 Tab 栏、home indicator。

**风格要点**（用于视觉规格 §7）：

- 米白底 `#F5F0E6` 与顶部浅色山水渐变融为一体；深绿 `#1E4B2F` 是全局唯一点缀色（标题/图标/激活 Tab/进度条）。
- 白色大卡 + 20-28pt 大圆角 + 轻投影；衬线书名（约 40pt 大标题、20pt 书名）；辅助灰绿 `#8C9288` 承担全部二级信息。
- 淡绿 `#DCE9D4` 圆形按钮底（箭头/播放/徽标）；浅黄 `#F9EAC8` 仅「热门榜单」一张异色卡作视觉焦点。
- 分区标题统一「4pt 绿竖条 + 粗体 + 内联灰副句 + 右侧灰字链接」；触控目标约 44pt。

**与现有首页的信息架构差异**：现有页以「书架列表」为主体、发现入口为两行按钮；设计稿以内容流为主体、书架降为四宫格入口——这是本次唯一的大架构变化（书架去留，§10-1）。

## 3. 现状勘察摘要

**可用能力清单**（全部已抽查确认）：书架/筛选/目录/整理（`LearningHome.tsx:117-165`）、阅读器+断点恢复（`ReaderScreen.tsx`）、TTS 听读（需登录，`src/services/voice.ts:1` 头注）、点词词典、句级帮助、导入（粘贴/URL/RSS/分享队列）、精选经典书库 3 本（`src/core/curated.ts:153-157`）、资讯订阅（本机精选源）、全局搜索三源（`LearningHome.tsx:394-509`）、生词本、复习 SRS、笔记、口语练习、账号/同步/导出。

**导航与启动链路**：

- 自研 push 栈共 **23 个 PushName**（`src/ui/nav.tsx:10-33`，已计数核对）；其中 `history`（翻译历史）/`glossary`（术语表）已注册但全仓无 `nav.push` 调用，属不可达遗留死入口，不作为本次落点。
- 新增入口页需三处同步注册：`ui/nav.tsx` PushName + `App.tsx:54` PUSH_TITLES + `App.tsx:306` view() 分支。
- 启动插队链路集中在 `App.tsx:213-304`（Safari 分享队列/剪贴板/通知动作，受 onboarded/loginIntent/accountOpen/盖层互斥约束）；切 tab 自动 popAll（`App.tsx:264-271`）；push 期间底层 inert + tabbar 视差（`App.tsx:372-412`）。**本期不得改动这些 effect 与 SheetHost 层级。**

**技术硬约束**（违反即破版或被拒）：

1. iOS 16 最低 + vite target safari16（`vite.config.ts:15`、`src-tauri/tauri.conf.json:35`）：CSS **禁 color-mix 与宽色域/渐进色函数**，半透明面一律显式 rgba（`src/ui/tokens.css:4-5` 头注）。
2. 全局字号缩放：正文字号一律 `calc(px * var(--fs-scale))`（档位 1/1.15/1.3，`src/store.ts:795-798` applyFsDom）；触控目标 ≥44px。
3. 双主题并存：全局纸感 token（`tokens.css`，墨蓝 accent）与阅读首页局部绿主题（`src/screens/libraryExperience.css:1-36`，`--library-accent #246b59`，dark `#9ac8b3`/sepia `#416351`）双轨；归一方向待拍板（§10-2）。
4. 同步协议 sync.v2 共 7 集合（`src/services/sync.ts:11`），文章 ~256KB 分块（`sync.ts:186`），实体超 `maxEntityBytes` 拒绝同步（`sync.ts:349-350`），投影与 Windows 共用（`sync.ts:59-94`）——**本期不给 Article 加新字段**。
5. 服务端实现不在本仓库内，位于同级附加目录 `immersive-translator-server/`（AGENTS.md 口径）；书库下载走 mobile 侧 `src/services/discovery.ts:47` listBooks——按书名查 `/v1/books` 目录再分页取回。「无上新数据流」仅由该调用形态佐证（本轮在该服务端 apps/ 下 grep catalog/listBooks 无命中，书库路由未定位），服务端侧未逐条核验，**接入前需与服务端确认目录能力**。
6. 性能：书架/正文全量渲染无虚拟化；首页新增大图/列表需控制首屏开销。
7. 无图片资产：`src/assets` 与 `public/` 均不存在（已 ls 确认）。

## 4. 信息架构与功能映射表

策略取值：reuse=原样复用 / adapt=改造现有 / new=新建 / drop=不做。缺口与数据事实均已抽查源码核验。

| # | 设计稿区块 | 策略 | 现有支撑或缺口 | 优先级 | 做法 |
|---|---|---|---|---|---|
| 1 | 状态栏 | drop | 系统级 UI；应用只管安全区留白（`libraryExperience.css:54` `--safe-top` 已在用） | drop | 本期不做；新增顶部浅色渐变背景时保证状态栏区域留白。渐变用显式色值 `linear-gradient`，不依赖 color-mix（iOS 16） |
| 2 | 大标题区（阅读+副句+搜索钮+消息钮） | adapt | 现页头 `LearningHome.tsx:66-82` LibraryHeading（大标题+账号章+搜索框形按钮+导入钮）；搜索链路 `LearningHome.tsx:78` push learningSearch，搜索页 `LearningHome.tsx:394-509`；图标 search `icons.tsx:23`、bell `icons.tsx:62`；角标数据 `store.ts:897-899` dueReviewCount | P0 | 大标题改衬线重磅字（`--library-serif`，约 40pt）+新增副句「在阅读中，遇见更大的世界」（纯文案）；搜索改 44pt 白圆钮（跳转不变）；**「消息钮」降级为「待复习」铃铛钮**+真实角标 dueReviewCount，点击 push("review")（§10-3）；「导入」钮移入书架页与空态卡（链路不丢）；账号章保留为标题行第三圆钮（§10-11） |
| 3 | Hero 轮播卡 | new | 缺口：全仓无轮播组件、无图片资产（`src/assets`、`public/` 不存在，已验证）。可用数据：继续阅读 current `LearningHome.tsx:127-128`；首启种子 starter `src/core/demo.ts:56-69`+`store.ts:252`；今日已读 `store.ts:832-835` readTodayCount；精选入口 `LearningHome.tsx:158`；播放图标 `icons.tsx:13` | P0 | 新建 4 卡轮播：①主卡「Read More, Live Better / 阅读，让生活更有广度」+白胶囊「开始阅读」（有进度续读 current，无进度开 starter）；②经典书库卡→learningLibrary；③短文与订阅卡→learningFeeds；④今日数据卡「今日已读 N 句」（readTodayCount）。本期 CSS 渐变+图标兜底（显式色值，参照 `LearningDiscover.tsx:116` coverClass 三色渐变）；右下 4 圆点+手动横滑；摄影图列为 P2（§10-6） |
| 4 | 四宫格快捷入口 | adapt | 白卡壳新样式，四个目的地：书架=`src/core/readingLibrary.ts:114-123` shelfItems；笔记=noteslib 路由已注册（`nav.tsx:17`、`App.tsx:328` view 分支），首页入口需新增 nav.push（现有先例 `NotesScreens.tsx:231` replace）；阅读历史=数据现成（progress+lastReadAt，同搜索页「最近读过」口径 `LearningHome.tsx:427-428`）但无独立页；「我的收藏」→生词本=`LearningHome.tsx:130` requestVaultSection("words")+setTab("vocab")。图标 bookopen/note/hist/star 全在 `icons.tsx:35-51` | P0 | 整块白卡四等分+竖分隔线。书架→书架页（A/B 落点见 §10-1，两方案下均有合法去向）；笔记→新增 `nav.push("noteslib")`；阅读历史→本期先映射搜索页最近读过起始态（P2 建独立历史页，§10-5）；第 4 格文案「我的收藏」→「生词本」（无收藏书概念，待拍板 §10-4） |
| 5 | 分类横滑区（5 卡） | adapt | 现发现区两行入口 `LearningHome.tsx:158`。真实分类维度：CURATED_BOOKS 3 本 `curated.ts:153-157`、CURATED_DOCS 7 篇 `curated.ts:31-80`、CURATED_FEEDS 3 源 `curated.ts:126-130`、我的导入（sourceType 派生，`readingLibrary.ts:131-135` sourceOf）；难度口径现成 `LearningDiscover.tsx:108` | P0 | 改横向滑动卡列（末卡右缘裁切暗示横滑），共 4 张实卡：「精选经典」（CURATED_BOOKS→learningLibrary；**「畅销好书」并入此卡口径**）、「短文精选」（CURATED_DOCS→learningFeeds）、「资讯订阅」（CURATED_FEEDS→learningFeeds）、「我的导入」（→learningImport）；「热门榜单」无榜单数据→砍掉或降级为「今日已读 N 句」黄色数据卡（三选一，§10-7）；「新书上架」无上新流→**本期 drop**（§10-8）；「查看更多 ›」→learningLibrary；卡底 CSS 渐变+图标（rss/bookopen/note/clip 现成） |
| 6 | 精选推荐（大卡+换一批） | adapt | 数据池现成但小：CURATED_BOOKS 3 本（author/level/chapterCount/coverClass，`curated.ts:153-157`）+CURATED_DOCS 7 篇；加入书架走真实链路「按书名查目录→previewBook 下载+sha256→试读抽屉」（`LearningDiscover.tsx:72-84` BookSampleSheet）；封面缺图：coverOf 仅支持 data:/http(s)（`readingLibrary.ts:124-129`），用 coverClass 渐变兜底 | P0 | 大卡轮换展示精选书：衬线书名+作者（真实字段）+元信息行「进阶 · 6 章」（level+chapterCount；**「☆ 9.2」评分无数据源，不做**，§10-9）；简介行用现有口径「先试读，找到适合自己的篇章」（`LearningDiscover.tsx:102`），不造假中文简介；右侧淡绿圆形箭头钮→复用 openBook 真实链路（未上架如实报错+试读抽屉）；「换一批」在 3 书+7 短文池内轮转，列 P2（§10-10） |
| 7 | 继续阅读 | adapt | 链路完全现成：recent 按 lastReadAt 取第一条 `LearningHome.tsx:127-128`+readingState `LearningHome.tsx:59-65`+完成态「再读」`LearningHome.tsx:140-143`；封面 coverOf/coverTone 五色（`readingLibrary.ts:124-130`，色值 `libraryExperience.css:331-335`）；百分比公式同 `sync.ts:66` `Math.round((idx+1)*100/len)`；author 仅书库下载书携带（`discovery.ts:90`），粘贴/精选短文无 author | P0 | 现有「继续上次阅读」条升级为白卡：封面（coverTone 五色兜底）+衬线书名+作者行+4pt 圆头进度条+灰字「已读 N%」+右侧 52pt 淡绿播放钮；author 空值回退 sourceOf（与 ShelfCard byline 口径 `LearningHome.tsx:100` 一致）或整行隐藏；「全部 ›」→书架页；播放钮本期 push reader 断点续读（§10-9 播放决策）；完成态保留「再读」 |
| 8 | 底部悬浮胶囊 Tab 栏 | adapt | 三 tab 定义与设计稿文案完全一致（`src/ui/GlassNav.tsx:7`）；vocab 徽标=dueReviewCount，>99 显 99+（`GlassNav.tsx:14`、nav-badge）；样式基座 `src/ui/base.css:448-464`（毛玻璃+安全区） | P1 | 仅样式换肤：玻璃气泡改白色全圆角胶囊浮层（左右 16pt、高 64pt、轻投影），激活项深绿图标+文字+短横线，徽标改淡绿胶囊底；**GlassNav 弹簧手势与数据交互（actions.setTab、切 tab popAll）不动**；深绿取 `--library-accent` 系，暗色/sepia 沿用 `libraryExperience.css:20-36` 变量。波及三个 tab 根页，需回归口语与笔记页 |
| 9 | 离线提示条（现有功能，设计稿未画出） | adapt | `!navigator.onLine` 时显示（`LearningHome.tsx:137`），纯前端无数据依赖 | P0 | 保留并纳入新视觉（置于 Hero 卡上方细条）；离线时已保存内容可读能力不变，Hero「开始阅读」与推荐卡对未缓存内容降级提示（精选书下载依赖网络，`LearningDiscover.tsx:72-84` 链路已有错误提示） |

## 5. 需要新增或改造的能力清单

| 能力 | 类型 | 说明 |
|---|---|---|
| Hero 轮播组件 | 新增 | 4 卡手动横滑+圆点指示器；尊重 `prefers-reduced-motion`（缓动用既有 `--ease`）；无第三方依赖 |
| 书架 push 页 learningShelf | 新增（方案 A 时） | 注册三处：`ui/nav.tsx` PushName + `App.tsx:54` PUSH_TITLES + view() 分支；承载现 ReadingHome 的筛选/列表/目录/整理（`LearningHome.tsx:146-164` 整段迁移）；返回手势/压暗/底层 inert 走既有 push 栈（`App.tsx:372-412`）不新增机制 |
| 阅读历史页 | P2 备选 | 按 lastReadAt 排序+readTodayCount，数据全本地、零 schema 变更；本期先映射搜索页最近读过起始态 |
| 待复习铃铛钮 | 改造 | 页头新圆钮：bell 图标+dueReviewCount 角标，点击 push("review")；替代设计稿「消息钮」 |
| 精选推荐卡 | 改造 | 复用 `LearningDiscover.tsx:72-84` openBook 全链路（含未上架如实报错文案与 BookSampleSheet 试读抽屉），首页不再实现第二套下载逻辑 |
| 继续阅读卡 | 改造 | 现 `LearningHome.tsx:138-145` 条升级为白卡（进度条/封面/播放钮）；数据取数不变 |
| 胶囊 tab 栏 | 改造 | `base.css` tabbar 段换肤；GlassNav 组件 API 与手势逻辑不动 |
| 视觉令牌扩展 | 改造 | 设计稿深绿色板落 `--library-*` 变量（`libraryExperience.css`），不新起第三套主题体系（归一方向 §10-2） |

## 6. 交互与状态说明

**交互规格**（对应原型行为验收项）：

- Hero 轮播：手动横滑在 4 卡间切换，右下圆点同步高亮（首颗默认）；切换动画用 `--ease` 且尊重 `prefers-reduced-motion`。
- 「开始阅读」白胶囊：有进度续读 current（push reader 断点恢复）；全新用户打开 starter《A Small Break》。
- Hero 第 4 卡「今日已读 N 句」：N 随 readTodayCount 实时变化（跨日归零口径 `store.ts:832-835`）。
- 分类横滑：末卡右缘被屏幕裁切、可继续横滑；4 实卡各自跳对应 push 页；「新书上架」不渲染。
- 推荐卡圆形箭头钮：已上架书出试读抽屉；未上架如实提示「这本书的电子书还没有上架」（`LearningDiscover.tsx:79` 同款文案）。「换一批」点击轮换池内下一条、刷新图标带旋转反馈（P2，冒烟只验推荐卡本体）。
- 继续阅读卡：进度条按真实 progress 渲染；点击封面/书名进 reader 断点续读；播放钮本期进 reader，登录用户在阅读器内启动 TTS（未登录走阅读器现有登录引导，`store.ts:1424-1430` speak() ensureAccount 现有链路）；读完显示「再读」。
- 四宫格：四入口各自跳转且可返回首页。
- 底部胶囊 tab：切「口语」「笔记与复习」正常且自动 popAll；徽标三态（>0 显示、=0 消失、>99 显 99+）。

**降级与边界态**：

- **未登录**：复习为本地能力无门槛（铃铛钮可直接 push review）；TTS 示范音走 speak() 现有 ensureAccount 登录引导；账号章呼出 openAccountSheet 底部抽屉（`LearningHome.tsx:73`，链路不变）。
- **离线**：顶部离线条；已保存内容正常打开；精选书「加入书架」给网络错误如实提示。
- **空态**：无进度新用户不出现继续阅读卡与筛选残留；starter 空态卡（`LearningHome.tsx:154`）随书架能力移入书架页保留。
- **加载/错误**：书库查找/下载沿用 `LearningDiscover.tsx:104-105` 的 busy/notice+error/alert 模式，首页推荐卡不重复造轮子。

## 7. 视觉与无障碍规范

**色板 token 化**（设计稿 9 色 → 现有变量映射，动工前按 §10-2 结论微调）：

| 设计稿色 | 用途 | 落点 |
|---|---|---|
| #1E4B2F 深绿 | 标题/图标/激活态唯一点缀 | `--library-accent`（现 #246b59，微调） |
| #F5F0E6 米白 | 页面底色 | `--library-bg` 或全局 `--bg`（作用域待 §10-2 拍板） |
| #FFFFFF 卡片白 | 卡/圆钮/胶囊栏 | `--surface`（tokens.css） |
| #E0B23C / #F9EAC8 | 黄封面/榜单卡（P2 数据卡备用） | 卡内局部色值，不入全局 token |
| #DCE9D4 淡绿 | 圆形按钮底/徽标底 | 新增 `--library-accent-soft`（显式 rgba） |
| #242E24 / #8C9288 / #EAE6DB | 一级/二级文字/分隔线 | `--library-ink` / `--library-muted` / `--library-line` |

**硬性规范**：

1. iOS 16 兼容：禁 `color-mix()` 与宽色域/渐进色函数；半透明面显式 rgba（`tokens.css:4-5` 头注既约）。
2. 全部正文字号 `calc(px * var(--fs-scale))`；`--fs-scale` 三档（1/1.15/1.3）下布局不破（`store.ts:795-798`）。
3. 触控目标 ≥44px（圆钮/入口行/卡片主按钮）。
4. 图标一律复用 `src/ui/icons.tsx` 现有清单（search/bell/me/play/bookopen/note/hist/star/sync/rss/clip 等），禁 emoji 与裸字符当图标（icons.tsx:1-5 头注既约）。
5. dark/sepia 档：新区块配色逐档走 `libraryExperience.css:20-36` 的 `--library-*` 变量，P1 冒烟逐档验证。
6. 动效统一 `--ease`，轮播尊重 `prefers-reduced-motion`。

## 8. 非目标

- **不做消息中心与未读体系**：全仓无消息/inbox 功能（已 grep 核验，唯一命中为短文正文与读屏播报文案）；页头「消息钮」降级为待复习铃铛钮。
- **不做评分/榜单数据**：无评分数据源，不造假「☆ 9.2」；「热门榜单」本期砍掉或降级（§10-7）；「新书上架」本期不渲染（精选目录为随包静态 3 本，服务端无上新流）。
- **不改三 tab 导航结构**：GlassNav 键位、弹簧手势、切 tab popAll 不变，仅换肤。
- **不做列表虚拟化**：书架/正文维持全量渲染现状。
- **不给 Article 加同步字段**：favorited（收藏）/category（分类）均缓——涉及与 Windows 共用的 sync.v2 投影（`sync.ts:59-94`）与 maxEntityBytes（`sync.ts:349-350`）评估，本期不做。
- **不动启动链路 effect 与 SheetHost 层级**：`App.tsx:213-304` 插队逻辑、SheetHost/GoalSheetHost 层级保持原样。

## 9. 分期落地建议

**前置条件（动工前必须拍板，见 §10）**：书架去留 A/B（#1）；消息钮降级（#3）；四宫格第 4 格文案（#4）；热门榜单三选一（#7）。

| 期次 | 内容 | 冒烟验收 |
|---|---|---|
| P0 | 页头（铃铛钮+搜索圆钮+副句）、四宫格、分类横滑 4 实卡、精选推荐卡、继续阅读卡、Hero 渐变兜底+信息架构迁移、离线条新视觉、（方案 A 时）learningShelf 页注册与书架迁移 | `npm run smoke` / `npm run nav:test` / `npm run reading-library:test`；手验：轮播切换与圆点、开始阅读两态（有进度/starter）、推荐卡未上架文案、继续阅读进度与「再读」、四入口跳转可返回、离线降级、触控 ≥44px、空态无残留、push 栈返回手势与启动插队不受影响 |
| P1 | 胶囊 tab 栏换肤+三 tab 根页回归；dark/sepia 全档与 `--fs-scale` 三档验证 | 手验：激活态（深绿图标+文字+短横线）、徽标三态（>0/0/99+）、切 tab popAll 正常 |
| P2 | 摄影图资产（Hero/分类卡/封面，随包或远程，含版权与包体积评估）、阅读历史独立页、换一批池内轮转、热门榜单数据卡或接书库真榜单（待服务端目录能力） | 各自补充冒烟；P2 不阻塞 P0/P1 发版 |

## 10. 待拍板问题（openQuestions 全集）

1. **书架去留（最大架构决策，P0 动工前置）**：设计稿首页不放全量书架列表，但书架列表+类型/状态筛选+目录抽屉+整理（`LearningHome.tsx:146-164`）是可用功能不能砍。**方案 A（推荐）**：首页保留精简书架预览（最近 3 项+「查看全部」），全部列表移入新 push 页 learningShelf（注册 `ui/nav.tsx` PushName + `App.tsx:54` PUSH_TITLES + view() 分支）；**方案 B**：书架整体移入独立页，首页只留内容流。两方案下四宫格「书架」格均有合法落点。
2. **主题归一方向**：阅读首页局部绿主题（`libraryExperience.css:1-36`，#246b59）与设计稿深绿（#1E4B2F）接近，建议以 library 绿主题为基座微调色值实现；是否反向统一到全局纸感 token（墨蓝 accent）？另：设计稿米白底 #F5F0E6 只作用于阅读首页还是全局三 tab？改全局会牵动 SpeakingHome/VaultBody 视觉。
3. **消息圆钮降级**：产品无消息中心（已 grep 验证），「消息圆钮+数字 1」建议降级为「待复习」铃铛钮+真实角标 dueReviewCount、点击 push("review")——是否接受？或本期页头只放搜索圆钮+账号章？
4. **四宫格第 4 格「我的收藏」**：产品无「收藏书」能力，最接近的是生词本。建议改文案为「生词本」（复用 requestVaultSection("words") 链路）；若坚持「收藏内容」则需给 Article 加 favorited 字段——涉及 sync.v2 投影与 maxEntityBytes 评估，不建议本期做。请拍板文案与去向。
5. **「阅读历史」落地深度**：本期先映射全局搜索页「最近读过」起始态（`LearningHome.tsx:427-428` 现成，零新页面），P2 再建轻量历史页（按 lastReadAt 排序+readTodayCount，数据全本地）？还是本期直接建页？
6. **Hero 摄影图资产**：`src/assets` 与 `public/` 均无图片（已验证）。方案 A：新增随包摄影图（包体积+版权成本，iOS 包体积敏感）；方案 B（推荐本期）：CSS 渐变+大图标兜底，P2 替换真图。分类卡与推荐封面同理。
7. **「热门榜单」异色卡三选一**：①本期砍掉；②降级为「今日已读 N 句」黄色数据卡（readTodayCount 现成，保留唯一异色卡视觉焦点）；③等书库服务端目录具备榜单能力后接真数据。**推荐②**。
8. **「新书上架」卡确认本期 drop**：精选目录为随包静态 3 本（`curated.ts:153-157`）；书库目录仅见 mobile 侧按书名查找（`discovery.ts:47` listBooks，GET `/v1/books?q=…`），未见上新数据流——该结论从调用形态佐证，服务端（同级附加目录 `immersive-translator-server/`）书库路由未逐条核验；待书库目录具备增量上新能力后再评估。
9. **精选推荐评分「☆ 9.2」确认不做**（无任何评分数据源，不造假）；元信息行改用真实「难度 · 章数」（level+chapterCount，`curated.ts:153-157`）。
10. **继续阅读播放钮**：本期点击进 reader 断点续读、由阅读器内播放（TTS 需登录经服务器中转，`voice.ts` 统一账号语音；首页直触发需处理未登录降级与代际防串音）——还是本期直接触发听读？**推荐前者**。
11. **「换一批」价值**：数据池仅 3 书+7 短文，池内轮转很快见底。本期先做池内随机轮转（成本低，列 P2）还是等精选目录扩充后上？**推荐先做，文案不改**（点击确实会换）。
12. **账号章新位置**：设计稿页头无账号章，但登录态/同步状态入口（openAccountSheet，`LearningHome.tsx:73`）不能丢。建议保留为标题行第三个圆钮（图标 me，`icons.tsx:12`），还是收进右上铃铛旁？
