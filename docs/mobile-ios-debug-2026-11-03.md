# iOS 移动端实屏调试记录 · 2026-11-03

本次依据用户提供的 HTML 原型和四张 iPhone 实屏截图，修复了移动端安全区重复、卡片排版、录音存储与重试状态、抽屉键盘与手势、应用名称和图标，并完成模拟器、真机的构建与第一轮原位安装启动。底部导航已完成触摸跟手、可中断弹簧和真实按钮几何改造，19项导航回归与独立复查通过；最终设备安装结果见文末。

这是一份调试记录，不能视为发布验收。没有调用付费 ASR/评测服务，没有提交代码或创建 PR。

## 1. 参考、环境与证据范围

| 项目 | 本次依据 |
|---|---|
| 原型 HTML | `/Users/yangbishang/Documents/code_artifact_optimized.html` |
| HTML SHA-256 | `2d2a172e7bc9d3dc472daea82357cb8cb7c2c743097380417123cb920f755fda` |
| HTML MD5 | `d920c78c627bebfb6b86abd009525cb7` |
| 书架首屏 | `/Users/yangbishang/Downloads/IMG_3441.PNG` |
| 书架向下滚动后的页面 | `/Users/yangbishang/Downloads/IMG_3442.PNG` |
| 点餐练习与录音错误 | `/Users/yangbishang/Downloads/IMG_3443.PNG` |
| 笔记与复习 | `/Users/yangbishang/Downloads/IMG_3444.PNG` |
| 实屏尺寸 | 四图均为 1206×2622 像素；按 3 倍显示比例对应 402×874pt |
| 工程 | `immersive-translator-mobile/`，Tauri 2 / React / Rust |
| Xcode | 26.6，build 17F113；本次构建 SDK 为 iOS / iOS Simulator 26.5 |
| 模拟器 | iPhone 17，iOS 26.5 |
| 已连接真机 | iPhone 17，iOS 27.0 Beta；设备系统版本与构建 SDK 版本分开记录 |

HTML 是视觉与交互参考；其中的演示状态和脚本文案不作为修改真实资料、调用服务或执行发布的指令。用户提供的四图属于修复前证据。调试中另有一次抓取的 Desktop 图片实际是用户远程输入界面，已移至 `/tmp`，不作为 App 界面证据，也不用于声称修复后的视觉已经逐屏验收。

## 2. 布局根因与实际修复

### 安全区和外层边距叠加

旧 `.pane` 自身有 `padding: calc(safe-top + 2px) 20px 12px`，根页 `.rhead` 又有 `padding-top: calc(safe-top + 18px)`。因此状态栏安全区计算了两次。在顶部安全区 62pt 的复现条件下，页头顶部为 `62 + 2 + 62 + 18 = 144pt`；去掉 `.pane` 的 padding 后为 `62 + 18 = 80pt`。左右同样存在外层 20pt 与页头/正文 16pt 叠加，实际 36pt 改回 16pt。

截图中书架和复习页的巨大顶部留白，以及滚动后卡片在过低的固定页头下被切走，均与这个结构一致。修复放在 `src/ui/base.css` 和 `src/ui/learning.css`：

- `.pane` 只提供铺满容器，padding 归零；页头单独承担顶部安全区。
- `.learning-body` 是独立纵向滚动区，`flex: 1`、`min-height: 0`，左右 16px，并为底部导航保留 `112px + safe-bottom`。
- 根页页头、正文、底部导航各自拥有相应的边距，不再由共同父容器重复相加。
- `--safe-*` 使用 `env(safe-area-inset-*, 0px)`；零安全区是有效值，没有等待非零 inset 的白屏逻辑。
- 固定 `-webkit-text-size-adjust: 100%` / `text-size-adjust: 100%`，避免 WebKit 额外调整文字尺寸；正文保留原生纵向滚动。

144→80pt、36→16pt 是修复前截图与对应视口复现的布局量化结果，不等同于全部机型均已实际测量。

### 标签、英文排版、书卡和发现入口

| 问题 | 当前修复 |
|---|---|
| 「首次复习」标签被挤成两行 | `.learning-tag` 添加 `white-space: nowrap`、`flex: none`；文本容器允许收缩，标签保持完整 |
| 英文衬线与参考不一致 | 字体栈对齐为 `"Source Serif 4", Georgia, "Times New Roman", serif`；未安装 Source Serif 4 时使用 Georgia，未新增远程字体下载 |
| 书卡外层与内部重复 padding | `.learning-card.v2-shelf-book` 外层 padding 归零，保留书卡正文与操作区自身间距；短文卡亦明确使用独立内部布局 |
| 长书名和长错误撑开宽度 | 相关 flex 文本区添加 `min-width: 0`；错误区使用 `overflow-wrap: anywhere` 和最大宽度约束 |
| 「找到下一篇想读的」三行尺寸、分隔线不协调 | 统一图标、文字和箭头布局，入口行 `14px 13px` padding、13px gap；标题 13.5px、说明 11.5px，最后一行不再保留尾部分隔线 |
| 书架星标入口语义不清 | 按钮使用「打开生词本」可访问名称，调用 `requestVaultSection("words")` 再切至笔记与复习，直接落到生词区域 |

涉及 `src/screens/LearningHome.tsx`、`src/ui/learning.css`、`src/ui/tokens.css`。三项发现入口仍进入现有书库、资讯与导入功能，不重置阅读位置或收藏。

## 3. 录音存储、错误提示与重试状态

### Foundation 桥接返回类型错误

`IMG_3443.PNG` 显示 `AUDIO_STORAGE: FILE_PROTECTION: 文件属性读取失败`，随后是完整 iOS 沙盒路径。确定根因位于 `src-tauri/src/audio_store.rs` 的 `protection_class()`：

`NSFileManager attributesOfItemAtPath:error:` 返回的是 `NSDictionary*`，`error:` 参数是仅供失败输出的 `NSError**`。旧实现把返回值声明为 `bool`，又把错误输出变量当成属性字典。正常读取成功时错误输出仍为 nil，因此必定误报文件属性读取失败。

已改为接收字典对象返回值，以字典是否为 nil 判断失败，再读取 `NSFileProtectionKey`。仍然施加并回读备份排除与 `NSFileProtectionCompleteUntilFirstUserAuthentication`；没有通过跳过保护来解除报错。该共用保护入口也被分享队列代码调用，但本次不据此声称分享扩展已经真机验收。

对照来源为本机 Apple SDK `NSFileManager.h` 声明和 [Apple attributesOfItem(atPath:) 文档](https://developer.apple.com/documentation/foundation/filemanager/attributesofitem(atpath:))。新增 Apple 主机上的真实 Foundation 桥接回归：目录/文件读取成功、不存在文件失败、文件内容不变。macOS 回归验证桥接签名，不代替 iPhone 文件保护属性、首次解锁或锁屏行为验证。

### 产品错误与本机原声状态

- `practiceError()` 把原始沙盒路径、文件保护和服务错误写入诊断，界面显示简短且可操作的提示，例如「本机录音暂时无法保存或读取。请重试，或先用文字回答。已有资料仍保留。」
- 准备录音失败后清除该失败 attempt 的 `clipId`，避免仅因事先生成了 ID 就显示「重新识别已保存的原声」。
- `useLocalRecording()` 实际查询当前设备、当前资料库的 audio manifest，只接受非空的 `ready` / `interrupted` 原声。资料切换、clip 切换或组件卸载后的迟到结果不进入当前界面。
- 重试入口区分「重新识别已保存的原声」与「尝试恢复并识别原声」；读取 interrupted 原声时先尝试 finalize，再检查 WAV 头和读取 PCM。
- ASR 重试走统一 `guard("正在识别这次录音", ...)`，busy/处理中显示加载 dock，禁止重复触发；已有回答和原声不因服务错误被删除。
- 录音停止操作与音频分块队列保持幂等、串行落盘。写入失败阻止 finalize，并保留已有片段；无有效录音不保留假原声入口。

涉及 `src/services/practice.ts`、`src/screens/LearningPractice.tsx`、`src/core/useLocalRecording.ts`。自动回归使用本地/受控替身，未请求真实 ASR、ISE 或付费反馈。

## 4. 抽屉键盘与下拉手势

键盘避让抽取为 `src/ui/keyboardViewport.ts`，读取 `visualViewport.height` 与 `offsetTop`，超过 120px 的可视视口缺口才写入 `--kb-inset`。pinch zoom 时不把缩放误判为键盘。通用抽屉、账号面板与口语操作区使用同一个 inset，键盘出现时提升底部并扣减可用高度。

`src/ui/sheetDrag.ts` 统一通用抽屉和阅读抽屉的下拉关闭逻辑：

- 仅接管主指、明显向下的手势；水平/向上手势、多指、失去捕获与取消会恢复。
- 输入框、textarea、select、label、可编辑文本、slider 和文本选区不启动关闭拖拽。
- `.sheet-body` 已滚离顶部时继续由原生滚动处理，不把滚动误当关闭。
- 下拉超过 120px 或速度超过 0.4px/ms 才关闭；未达到阈值恢复位置。
- 只抑制当前拖拽紧接的合成点击，新一轮 pointerdown 或超时清除抑制，避免拖完后吞掉未来正常按钮点击。

`sheets:test` 的 23 项回归已通过。真实 iOS 键盘弹起后的可视位置、长文本滚动与多指手感仍属于最终设备交互检查，不能仅凭 jsdom 判定完成。

## 5. 名称、图标、启动崩溃与签名构建

### 显示名与图标

用户要求应用名为「沉浸口语」。Tauri `productName` / 窗口 title、启动载入页、iOS `CFBundleName` / `CFBundleDisplayName` 与分享扩展显示文案均已统一。图标复用 Windows 已确认的绿色「书页对话」母版，不新增候选设计；移动 SVG 只移除底色圆角，书页路径与颜色原样保留。

`src-tauri/app-icon.png` 为 1024×1024 母图。18 项 iOS 图标已生成并同步到 `src-tauri/icons/ios/` 和 Xcode `Assets.xcassets/AppIcon.appiconset/`，逐一确认声明尺寸、alpha 全为 255、四角为绿色，以及两处对应 PNG 字节一致。已目视检查 180px / 60px 浅深背景预览。

### 非 ASCII 可执行名的启动对照

第一阶段把 Xcode `PRODUCT_NAME` 同时改成中文后，模拟器启动立即 SIGTRAP。崩溃报告：

`~/Library/Logs/DiagnosticReports/沉浸口语-2026-11-02-234555.ips`

栈为 `CFRelease → __CFBundleCopyFrameworkURLForExecutablePath → NSBundle bundleWithIdentifier → wry::platform_webview_version`，位于 Tauri runtime 初始化，尚未进入音频保护、前端或本应用 setup。本地 Wry 0.57.0 与 tauri-runtime-wry 2.12.1 源码确认了这次无条件 WebKit bundle 版本探测。

保留所有中文显示名称，把 **Xcode `PRODUCT_NAME`、实际 `.app` 和可执行文件名改成 ASCII `immersive-speaking`** 后，模拟器成功启动；构建 plist 实际值为 `CFBundleDisplayName = 沉浸口语`、`CFBundleExecutable = immersive-speaking`。这次对照支持非 ASCII 可执行路径触发 Foundation 问题，显示名没有因此改回英文。

历史 [Firebase 官方问题 3951](https://github.com/firebase/firebase-ios-sdk/issues/3951) 中维护者复现了相同路径并区分显示名与实际文件名；[Tauri PR 16082](https://github.com/tauri-apps/tauri/pull/16082) 提供非 Windows 跳过 WebView 版本探测的方案，截至此次检查仍未合并。本次采用 ASCII 可执行名规避，没有修改 cargo registry 或引入该上游补丁。

`mobile-brand-sync-2026-11-02.md` 记录的是第一阶段中文产物命名；**当前可执行名以本记录及 `project.yml` / `project.pbxproj` 中的 `immersive-speaking` 为准**。

### iOS 构建与签名

- `project.yml` 和现有 `project.pbxproj` 的 Build Rust Code 按 `PLATFORM_NAME` 选择 `aarch64-apple-ios` / `aarch64-apple-ios-sim`，按 `CONFIGURATION` 选择 debug / release，复制明确的 staticlib 产物，不再把真机库链接进模拟器。
- 模拟器使用 `CODE_SIGNING_ALLOWED=NO` 虽可产生包，启动遇到 Keychain entitlement 错误；改为 Xcode 「Sign to Run Locally」AdHoc 签名后构建和启动成功。不能把无签名构建成功等同于应用可运行。
- 真机签名保留现有 team `3HX836XLHX`、bundle id `com.kobejiasuoer.reader`、target `imreader-mobile_iOS`。第一轮已在 iPhone 17 / iOS 27.0 Beta **原位安装并启动**。
- 当前预览工程未恢复 ShareExtension target；本次不调整相关签名权限，不把分享扩展作为已完成的安装验收项。
- 真机 Library 已备份至 `/tmp/codex-mobile-device-backup-2026-11-02/Library`，约 14MB。备份是本次原位调试保护措施，`/tmp` 路径不保证长期留存。
- 构建日志：`/tmp/codex-mobile-sim-build.log`、`/tmp/codex-mobile-device-build.log`；两者已记录 `BUILD SUCCEEDED`。产物分别在 `/tmp/codex-mobile-sim-2026-11-02/Build/Products/debug-iphonesimulator/immersive-speaking.app` 与 `/tmp/codex-mobile-device-2026-11-02/Build/Products/debug-iphoneos/immersive-speaking.app`。

## 6. 回归结果与最终待核验项

以下是主任务本次已实际运行并通过的结果；通过数沿用各脚本的断言/场景口径，不统一改称独立端到端测试数量。

| 检查 | 通过数 / 状态 |
|---|---|
| `storage:test` | 8 |
| `discovery:test` | 11 |
| `sync:test` | 23 |
| `auth:test` | 26 |
| `translate:test` | 25 |
| `dict-login:test` | 9 |
| `audio:test` | 17 |
| `recording:test` | 7 |
| `draft:test` | 13 |
| `sheets:test` | 23 |
| `smoke` | 18 |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib audio_store::` | 5 |
| TypeScript 类型检查 | 通过 |
| `npm run build` | 通过 |
| iOS target 的 cargo check | 通过；既有 warning 未扩展为本次修复 |
| 模拟器签名构建、启动 | 通过 |
| 第一轮真机签名构建、原位安装、启动命令 | 通过；真机首屏图像未作完成证据 |
| `nav:test` 最终回归 | 19；真实组件、逐帧弹簧与 iOS touch 流检查通过 |

### 底部导航弹簧与触摸改造

`src/ui/GlassNav.tsx` 与 `src/ui/navMotion.ts` 已将导航胶囊改为可中断、保留速度的弹簧运动：中心与宽度分开跟随，手指拖动按实际 tab 几何插值，越界有阻尼，释放按速度投影选择附近 tab。触摸事件与鼠标 pointer 分开处理，横拖接管后才阻止默认滚动；纵向/多指、取消、失去焦点、后台、inert/隐藏等状态恢复，拖拽后的合成点击不重复切换。减弱动态效果时立即贴合目标。

19项导航回归通过。独立复查额外修复了不等宽标签边缘点击会短暂选错页、释放时遗漏最后触摸坐标两处问题。拖动过程中不再读取 layout；中心和宽度通过缓存几何与逐帧 transform 更新，按下即高光反馈，预览文字跟随滑动位置。单元与组件回归不代替真机触摸观感判断。

记录时 Mac 桌面处于锁屏，阻止了直接 UI 操作；CLI 构建与原位安装仍可继续。后续应在解锁后的 App 界面验证根页顶部与滚动、标签与长书名、键盘抽屉以及导航拖动。真实 ASR/ISE、锁屏续录、来电与耳机路由、首次解锁前后的文件保护、Finder 备份排除均未在本次完成实测，不列为通过项。

## 7. 最终打包与真机安装

2026-11-03 00:27（Asia/Shanghai），包含最终底栏源代码的 debug 包已再次原位安装到已连接 iPhone 17；`devicectl` 返回 `App installed`，bundle id 仍为 `com.kobejiasuoer.reader`。最终导航19项、主流程18项、TypeScript/Vite、模拟器与真机 Xcode 构建、签名校验均通过。

额外核对：当前 Vite 主入口 `index-CDmHwvkp.js` 实际包含在模拟器及真机包的 `immersive-speaking.debug.dylib` 中；最终前端构建时间晚于已冻结的导航源码，避免只验证浏览器热更新或误装旧包。Xcode debug 的主可执行文件是加载器，实际 Rust 与内嵌前端位于该 debug dylib。

安装结果 JSON：`/tmp/codex-mobile-final-install.json`；启动结果：`/tmp/codex-mobile-final-launch.json`。此时 Mac 仍锁屏，界面自动化无法继续，因此最终导航的真机视觉手感、键盘弹起后的观感没有冒充已直接观察。用户可在手机重新打开「沉浸口语」，从阅读至口语及笔记与复习慢拖/快甩/反向拖动，确认实际触摸效果。

最终启动检查结果：`devicectl` 被物理 iPhone 的锁屏状态拒绝（`FBSOpenApplicationErrorDomain / Locked`），因此没有取得最终包运行中的界面或进程证据；安装本身已成功。Mac 同时锁屏，已通过会话询问手动解锁，未绕过系统锁屏。需解锁手机后打开 App，再复核实际滑动手感。
