# 移动端液态玻璃重构 · 2026-11-08

[修改前诊断](mobile-liquid-glass-audit-2026-11-08.md) · [浏览器验收数据](mobile-liquid-glass-2026-11-08/browser-verification.json)

[查看实际效果与光学对照画廊](mobile-liquid-glass-2026-11-08/index.html)

## 实现与范围

工程是 `immersive-translator-mobile/`：React + Tauri 2，iOS 使用 WKWebView，保留最低 iOS 16 的构建目标。本轮沿用现有学习产品的绿色、系统字体和三个底部导航入口。

用户指定的高德 iOS 26 效果被落实为光学与手势验收标准：按下浮起、中心微放大、边缘弯曲与微弱色散、连续跨项拖动、速度形变、释放吸附。没有获得高德实现源码或逐帧参考视频，因此不声称逐像素复刻或参数一致。

### 光学路径

1. 外壳以低透明度填色和 CSS `backdrop-filter` 采样页面背景。
2. `LiquidLens` 在尺寸/内容/主题改变时复制本控件的图标与文字视觉内容；副本 `aria-hidden`、`inert`，不复制事件、ID或交互语义。
3. Canvas 生成胶囊 SDF 法线位移图和独立边缘图。`feDisplacementMap` 产生中心凸透镜与边缘弧面位移；`feColorMatrix` 与 RGB 位移产生局部色散，中央保持清晰。
4. 只裁去原按钮内部视觉包装层在镜片内的部分，由折射副本替代；原按钮保留完整点击区域和焦点轮廓。这样不会出现双重文字，也不会让镜片中心变成点不到的区域。
5. 顶部高光、底部暗缘、细内阴影与速度相关亮斑表达玻璃厚度。浅色、深色和减少透明度分别处理。

这是**控件图标文字平面的真实像素位移**。页面任意背景仍是 CSS 模糊，不是 UIKit 原生 Liquid Glass，也不是对整页 DOM 的实时光线追踪。选择普通 SVG 元素滤镜而不依赖 `backdrop-filter: url(...)`，是为了让 WKWebView 路径有实际可检验的结果。滤镜语法接受、截图存在差异都不单独作为成功证据；零折射/零色散/零模糊必须保留正确槽位与文字。

### 交互

- 按下立即有选项反馈，浮起程度由弹簧渐进推进。
- 长按增强透镜并触发一次触感；拖动经过新槽位时触感去重并限频。
- 横向意图成立后直接跟随手指，位置不逐帧触发 React 更新。速度驱动独立形变弹簧，停指后拉伸收敛。
- 释放后按短距离惯性投射选择槽位，位置/宽度/浮起/形变分别收敛；可以再次抓住尚未结束的回弹。
- 预览不调用业务回调。选择只在释放、点击或键盘明确激活时提交。
- 保留纵向滚动让路、多指取消、丢失捕获、失焦、后台、禁用/inert、空选中和受控父组件拒绝变更。
- `prefers-reduced-motion` 保留选择与直接手势，取消透镜变形与弹簧；减少透明度、增强对比度退回清晰实底。

## 可调参数

共用参数位于 [`liquidOptics.ts`](../immersive-translator-mobile/src/ui/liquidOptics.ts)。长度单位为 CSS px，弹簧采用单位质量模型；输入会进行有限值检查与范围限制。

| 参数 | 含义 |
| --- | --- |
| `ior` | 模拟折射强度，1为零折射 |
| `edgeWidth` | 边缘弧面作用宽度 |
| `dispersion` | 边缘 RGB 分离强度 |
| `blur` | 图标文字采样的轻微柔化半径；外壳模糊由材质 CSS 单独定义 |
| `stiffness` | 弹簧刚度 |
| `damping` | 阻尼系数，支持过阻尼的正确解析解 |
| `longPressMs` | 长按增强等待时间 |

两个组件都支持 `glass` props，不需要改业务调用者：

```tsx
<GlassNav hidden={hidden} inert={inert} glass={{
  ior: 1.34,
  edgeWidth: 10,
  dispersion: 0.35,
  blur: 0,
  stiffness: 430,
  damping: 34,
  longPressMs: 180,
}} />

<GlassSwitch value={value} items={items} onChange={setValue}
  glass={{ ior: 1.28, dispersion: 0.2, stiffness: 480, damping: 38 }} />
```

## 性能策略

- 位移图不随拖动重建，最多256×128像素，与屏幕 DPR 解耦；LRU最多保留24组。
- SVG滤镜节点在挂载时建立；拖动只改变坐标、变形、位移强度和局部裁剪路径。
- 可见区域是一个胶囊；离屏过滤区域固定为整个控件的宽度×高度，避免 WebKit 采样错位。滤镜和原语均采用 `objectBoundingBox` 归一化坐标，R通道按高宽比校正，使横纵位移保持相同像素尺度；不采集整屏纹理。
- 光学层不自建 RAF；只由控件的手势/弹簧调度，收敛、后台和卸载时停止。
- 尺寸读、复制节点和主题计算放在配置阶段；移动帧不调用布局测量。
- 多处页面分段控件自动复用此实现；在 Sheet 内取消外壳重复背景模糊。
- 登录遮罩移除全屏 blur，大面板用边缘高光和阴影表达层次；阅读选词胶囊统一边缘材质。
- 透明度/对比度偏好和贴图加载失败时保留原字及可操作的静态选中层。

解析弹簧在60Hz/120Hz时间步结果一致，说明运动计算不依赖刷新率。浏览器 RAF 数据仅代表当前 Mac 测试环境的调度情况，不能据此保证实体 iPhone 的 GPU 合成时间或 ProMotion 120fps；真机触感和持续拖动帧率仍需设备测量。

## 文件

路径均相对 `immersive-translator-mobile/`：

| 文件 | 改动 |
| --- | --- |
| `src/ui/GlassNav.tsx` | 主导航按压/长按/拖动状态、触感、光学接入 |
| `src/ui/GlassSwitch.tsx` | 通用受控切换，同材质与交互 |
| `src/ui/LiquidLens.tsx` | SVG光学图、视觉副本、局部裁剪与回退 |
| `src/ui/liquidOptics.ts` | 参数、SDF法线图、缓存 |
| `src/ui/liquidGlass.css` | 透镜表面与浅深色高光 |
| `src/ui/liquidNav.css` | 主导航外壳、可交互文字包装层 |
| `src/ui/glassSwitch.css` | 通用切换外壳、包装层、模态内性能处理 |
| `src/ui/liquidSurfaces.css` | 弹窗和阅读悬浮胶囊材质 |
| `src/ui/navMotion.ts` | 修正过阻尼弹簧解析解 |
| `src/main.tsx` | 接入浮层材质样式 |
| `scripts/liquid-physics-test.mjs` | 60/120Hz、阻尼范围、参数与SDF检查 |
| `scripts/liquid-switch-test.mjs` | 长按、停指休眠、受控选择及边界回归 |
| `scripts/liquid-glass-browser-test.mjs` | Chromium/WebKit真实浏览器输入与像素检查 |

修改前核心文件备份于 `/tmp/immersive-liquid-glass-baseline-2026-11-08/`。本轮未提交、推送或发布。

## 最终验证

- `npm run build`：TypeScript 与 Vite 生产构建通过。
- `npx tauri ios build --target aarch64-sim --debug --ci`：iOS模拟器构建通过。构建仍提示既有大chunk及Rust编译warning，没有构建错误。
- 原主导航19项、通用切换25项、Sheet/键盘29项、侧滑返回33项、Smoke20项回归通过。
- 新增长按/停指休眠等5组切换测试；60/120Hz、欠阻尼/临界/过阻尼收敛、参数边界和SDF对称性检查通过。
- Chromium 156.0.8078.80：14组浏览器检查通过，包括可信CDP连续触摸拖动。
- WebKit 26.5：12组通过。Playwright没有提供该引擎的可信连续触摸移动或减少透明度媒体模拟，因此这两项明确记录为不可模拟；已测可信pointer拖动、touchscreen点击、减少动态效果和增强对比度。
- 两引擎均有独立SDF/RGB像素变化，零光学参数与未过滤图像的平均通道差分别为0.114/255、0.138/255；WebKit真实主导航文字正确、清晰。
- 拖动期间贴图编码0次、滤镜节点复用；收敛后RAF请求与执行计数保持不变。
- `git diff --check`通过。

详细原始数据见画廊和 `verification/`。帧时采样包含自动截图开销，Chromium存在一个66.8ms样本，不应将这些数据包装成“全部帧满帧”。真机触感与ProMotion帧率未测。
