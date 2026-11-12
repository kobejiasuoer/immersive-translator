# 官网预览尺寸调整（2026-11-05）

用户指出首屏标题与产品截图过大，几乎挤满宽屏。本次延续已有 The page is the object 方向（seed 1337086390），保留墨绿、书页与产品舞台，仅校准尺寸和响应式布局，没有重新抽取方向或素材。

## 根因与改动

- 原两侧边距最大40px，标题最大132px，16:10产品图随整页宽度撑高。1920px宽时，产品图约1840×1150px。
- `upgrade.css` 用共享水平内边距限制正文1120px；首屏标题、文案、按钮和产品舞台统一居中限制880px。背景色块仍铺满页面。
- 桌面标题上限80px，区块标题上限52px，正文16px；手机标题44px。下载按钮48px高，场景切换按钮至少44px高。
- 宽度至少801px且视口高度不超过850px时，首屏字号和预览宽度随高度收紧。1366×768实际预览约717×448px，完整落在首屏；1440×700预览640×400px。
- 修正800/801处字号反向突增；540/541两侧均44px，仅由双行手机排版变为单行。
- `mobile.css` 去掉桌面展示区额外28px内边距，让手机原型图对齐所在列；现有平板、手机覆盖规则保留。

范围：官网升级预览样式及本文档。没有修改下载逻辑、素材内容、正式首页或应用业务。

## 实际验证

- `lint.mjs`：0 FAIL / 0 WARN。
- `inspect.mjs`：1440×900、768×1024、390×844，0 FAIL / 2 WARN。警告为没有摄影素材与视频；本页以真实软件界面为证明材料，本次尺寸修正没有新增素材需求。报告为 `.taste-skill/scale-final-2026-11-05/report.json`。
- `.taste-skill/scale-check-2026-11-05.mjs`：1920×921、1366×768、1440×700、2560×1440、800/801、540/541及320px宽，共9种尺寸，没有横向溢出，预览宽度受限，主要按钮保持至少44px。尺寸结果及首屏截图位于 `.taste-skill/scale-after-2026-11-05/`。
- 既有 `.taste-skill/concise-check.mjs` 最终退出码0：6种尺寸的切图、大图、焦点恢复、FAQ、菜单、下载状态、资源和锚点均通过；减少动画、禁JS、file URL、API失败回退也通过。

边界：极矮桌面窗口仍需滚动；640px预览宽度下限用于保留细节。小尺寸产品预览继续支持点击查看原图。高度850px处有一次明确的响应式收紧。

## 视觉复核

ROUND 1

Seen in one second: 超大标题和贴近两侧的产品图同时争夺首屏。
Idea (one sentence): 把自己的书和文章接续为阅读、口语与复习。
Live thing: 阅读、口语与复习切换，并可打开原图查看细节。
Layout words by section: hero=产品舞台 / voice=反馈特写 / content=书架分栏 / mobile=错位双屏 / download=入口与折叠说明。
Scores: design 6 · usability 6 · creativity 7 · content 8 → overall 6.4。
Caps applied: 无。
Top three problems: 宽屏两侧仅40px留白；标题最大132px；截图撑高导致首屏只剩上半部。通过正文与首屏宽度约束、字号下降、矮屏布局修正。

ROUND 2

Seen in one second: 收紧后的阅读产品舞台，标题、按钮与预览比例清楚。
Idea (one sentence): 沿用原有学习材料到开口练习的叙事。
Live thing: 切换与原图查看均经回归确认。
Layout words by section: 保持上述五段结构，已看完桌面、平板、手机截图。
Scores: design 7.5 · usability 8 · creativity 7 · content 8 → overall 7.6。
Caps applied: 无。
Top three problems: 第一轮800/801处字号突增、手机支持句被窄栏强制折行、矮屏预览仍被首屏截断；最终已分别修正。

没有新增图像、视频、生成素材或示例文案；来源与开发中状态沿用现有素材说明。
