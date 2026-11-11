# 移动端液态玻璃巡检与重构依据 · 2026-11-08

本文记录本轮修改前的源码诊断。行号对应巡检基线，重构后可能移动。现有实现已经有较完整的跟手与弹簧行为；主要差距是缺少真正的背景采样位移、材质厚度与按压连续过渡，不能将已有成果概括为“只有动画，没有物理”。

## 1. 技术栈与实现边界

- 主工程：`immersive-translator-mobile/`，React 19 + TypeScript + Vite + Tauri 2。
- iOS 使用 WKWebView 承载 Web UI；`src-tauri/tauri.conf.json:35` 最低系统版本为 iOS 16.0，`vite.config.ts:15` 构建目标为 `safari16`。
- 当前源代码无 `feDisplacementMap`、`feColorMatrix`、SDF、WebGL、Metal、Flutter Shader 或 Skia 渲染管线。玻璃效果全部来自 CSS 半透明背景、`backdrop-filter: blur(...) saturate(...)`、边框及阴影。
- 触感已有原生桥：`src/services/device.ts:69`、`src-tauri/capabilities/default.json:10`、`src-tauri/src/lib.rs:975`。无需为本次重构再造原生插件。
- 本次应采用 WebView 路径；不能仅因运行于 iPhone 就将普通 DOM 滑块描述为 UIKit 原生 Liquid Glass。Safari/WKWebView 对 SVG backdrop filter 的实际支持必须另行验证，不能用 CSS 属性语法接受作为“已成功折射”的证明。

用户指定的高德 iOS 26 视觉目标在本轮中拆成可验证行为：滑块覆盖文字/图标时有局部像素弯曲、中心微放大、边缘色差、按压浮起、速度形变与阻尼回位。本文不声称已获得高德内部参数或其实现源码。

## 2. 组件清单

| 表面 | 源码位置（相对于移动端工程） | 修改前实际行为 |
| --- | --- | --- |
| 底部主导航、拖动透镜 | `src/ui/GlassNav.tsx` | `span.glass-bubble` 是按钮下方的着色选中背景，按钮与图标在其上方；支持拖拽和弹簧。 |
| TabBar 最终布局与材质 | `src/ui/product.css:47–60` | 64px 外壳、20px 背景模糊、52px 高选中胶囊。此文件覆盖大部分旧样式。 |
| TabBar 历史样式、材质叠层 | `src/ui/learning.css:6,41,752–756`、`src/ui/base.css:449–464` | 8/18px blur 与多个材质声明仍在级联中，最终应以 computed style 为准；它们不是多份同时执行的滤镜。 |
| 玻璃色彩变量 | `src/ui/tokens.css:150–164` | 浅色外壳 86% 白、选中 88% 绿；深色外壳 88%、选中 80%，底图对比细节被明显遮盖。 |
| 通用分段切换与滑动指示器 | `src/ui/GlassSwitch.tsx`、`src/ui/glassSwitch.css` | 16px 背景模糊；滑块为填色/阴影；受控值仅在释放后提交。 |
| 分段控件使用方 | `src/ui/kit.tsx`、`components/reading/Drawer.tsx`、`screens/LearningHome.tsx`、`LearningDiscover.tsx`、`LearningImport.tsx`、`AccountScreen.tsx`、`components/vault/VaultBody.tsx`、`WordDetailSheet.tsx`、`components/speaking/VoiceSettingsSheet.tsx` | 搜索、内容类型、难度、笔记/复习、导入、登录、语速、设置及抽屉页签复用 `GlassSwitch`。共享组件重构应自动覆盖这些表面，无需改业务回调。 |
| 旧悬浮胶囊播放条 | `src/ui/base.css:1634–1648` | 曾有圆胶囊和8px背景模糊；`src/ui/learning.css:831` 又将阅读页此规则覆盖为实底、无模糊。当前 TSX 已不渲染 `rd-playbar`，不能把历史规则当作当前截图。 |
| 当前阅读器底部操作 | `src/ui/readerExperience.css:111,115`、`src/screens/ReaderScreen.tsx:630,635` | 实际渲染的是 `reader-selection`、`reader-listen`，颜色由阅读主题控制，无滑动透镜。 |
| 登录模态遮罩 | `src/ui/learning.css:6` 的 `.account-overlay`；`src/screens/AccountScreen.tsx:181` | 整个视口4px背景模糊和深色遮罩，面板为实底。该规则缺少 `-webkit-backdrop-filter` 及自己的减少透明度覆盖。 |
| 通用 Sheet / Drawer | `src/ui/sheets.tsx:87–98`、`src/components/reading/Drawer.tsx:59–79`、`src/ui/base.css:561–594` | 半透明变暗遮罩 + 实底面板，320ms CSS transform 进出；当前不是折射表面。 |
| Push 遮罩与导航阻断 | `src/App.tsx:404–442`、`src/ui/base.css:466–478` | 普通页面与全屏任务分层；模态期间主导航 inert，全屏任务隐藏导航。必须保留。 |

检索中的 `.reader-mask .sent-zh { filter: blur(6px) }` 是学习内容隐藏逻辑；`.swipe-act:active { filter: brightness(...) }` 是按压反馈，不应混入玻璃材质重构。

## 3. 四维差距

### 光学折射

`GlassNav.tsx:173` 与 `GlassSwitch.tsx:243` 仅渲染空的背景 span。`glassSwitch.css:16,32` 明确让按钮 z-index 为1、滑块为0；主导航也通过 `learning.css:6` 将按钮放在选中背景上方。没有任何像素重采样链路，因此滑块经过图标时不可能使其弯曲。

当前 blur 会混合邻近颜色，saturate 只改变饱和度；两者都不会形成法线驱动的边缘挤压或中心放大。浅色高不透明度进一步让材质接近柔和的实底分段控件。升级需要明确“背景内容层 → 局部折射采样 → 透镜边缘光 → 可访问交互层”的顺序。

### 色散与高光

已有顶部内高光、轻微阴影和跟速度横移的径向亮斑，不能说完全没有高光：`GlassNav.tsx:31–32`、`learning.css:41`、`product.css:57`，以及 `GlassSwitch.tsx:74–75`、`glassSwitch.css:35–39`。

缺少独立 RGB 采样差、以胶囊边界/法线为依据的边缘聚光、清晰的底部暗缘与厚度连续性。当前 `::after` 是铺在整个胶囊上的径向白色渐变，不是折射边缘高光。应将色散限制于边缘并保持中央文字清晰，避免整段标签出现彩色重影。

### 流体物理

已有：80ms/6样本速度窗口，速度限制，跟手位置，水平拉伸/垂直缩放，边界橡皮筋，短时速度投射，松手弹簧，可从显示值重新抓取。`navMotion.ts:30–39` 使用解析弹簧，不是固定时长 CSS easing。

缺失：按压 `press = 1` 是直接跳变（`GlassNav.tsx:92`、`GlassSwitch.tsx:150`），松手仅指数衰减（两者分别48/101行）；尚无持续的按压升起弹簧、长按唤醒态、独立的形变回弹状态。形变直接由速度绝对值映射，速度暂停时也缺少独立的平滑收敛。应把位置、浮起程度和形变各自连续驱动，避免触摸事件一停止就保留过时速度形变。

### 交互完备性

已有点击/拖动消歧、6px方向阈值、纵向滚动让路、pointer capture、TouchEvent 兼容路径、多触点取消、捕获丢失、失焦/后台取消、禁用项、无障碍语义及键盘路径。`GlassSwitch` 还保留空选中、自评重选和受控父组件拒绝变更的能力。

缺少长按计时/唤醒态和跨槽触感。主导航只在真正切换时触发 `haptic("light")`（61行）；通用切换没有触感调用。跨槽拖拽已有视觉预览，但不应每帧触发原生 haptic 或提前执行业务回调；应只在候选项变化时去重并限频。

## 4. 性能诊断与边界

1. **已有良好基线**：只有拖动事件或未收敛的弹簧才调度 RAF；到位后停帧。手势帧不调用 React setState；尺寸通过 ResizeObserver/按下时测量，移动事件不重复布局读。`nav-test.mjs` 与 `glass-switch-test.mjs` 已对此做行为回归。
2. **真实风险来自采样面积与层数**：背景 blur、圆角裁切、阴影通常涉及中间合成表面。多个 `GlassSwitch`、外壳 blur、透镜 RGB 三路采样与登录全屏 blur 同时显示时，需要约束像素预算。不能因为 transform 使用 GPU 就推断背后的滤镜也“零成本”。
3. **高频小分配可减少**：两个 paint 每帧查询按钮、遍历并切属性；move 每次 push/filter/slice 样本。导航仅三项，不是当前首要瓶颈，但新增光学开销前应缓存节点和避免无变化属性写入。
4. **历史 CSS 不等于重复执行**：同一元素被多条 CSS 规则覆盖不会自动叠加 blur；需要按当前样式级联识别真正同时存在的元素过滤链。优先收敛共享玻璃专用样式，降低维护时误判。
5. **新增光学层约束**：位移图只在尺寸/光学参数变化时生成并有尺寸上限；过滤节点保持稳定；拖拽只更新位移/形变/少量采样参数；静态不运行轮询或持久 RAF；模态隐藏与后台立即释放高频工作。
6. **降级**：减少动态效果停用弹性和速度形变；减少透明度/增强对比度使用可读实底；SVG背景过滤不生效时仍保留滑动、选择、焦点与业务能力，并如实标明回退路径。
7. **验收口径**：既有手势测试只证明状态机和调度行为，不能证明光学效果或 iPhone 60/120fps。必须增加真实浏览器光学截图、拖动帧采集、WebKit路径验证；真实 iPhone GPU/触感与120Hz仍需要设备实测。

## 5. 建议本轮改造范围

优先修改 `GlassNav.tsx`、`GlassSwitch.tsx`、`glassSwitch.css`，并抽出共享光学参数/材质渲染和手势物理。共享材质应包含 IOR、边缘宽度、色散、blur、刚度与阻尼；参数不得在两个控件各自散落。`navMotion.ts` 的既有位置投射和边界行为应保留或经过等价回归验证。

TabBar 当前视觉由 `product.css`、`learning.css`、`tokens.css`共同决定，接入新材质必须核对这三者的覆盖关系。浮层先统一清晰的表面高光、厚度和遮罩权重，避免给全屏 scrim 无差别叠加高成本折射；阅读正文操作条和业务布局不是本轮首要重写对象。

回归至少覆盖：点击/重选、连续跨项拖拽、长按唤醒、暂停后的速度衰减、快速反向、松手投射、抓取回弹、纵向滚动、多指、取消、隐藏、禁用项、空选中、键盘、Reduce Motion、减少透明度、颜色主题、字号与布局，以及滤镜实例/贴图生成频次和静态 RAF 休眠。
