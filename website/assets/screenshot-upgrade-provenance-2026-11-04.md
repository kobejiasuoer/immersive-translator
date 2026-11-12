# 官网升级版界面素材来源

制作日期：2026-11-04。工作区基于提交 `3f66441`，Windows 配置版本 `0.15.2`。

这些图片通过独立 Chrome 浏览器渲染当前 Windows React 组件后截取，是**界面演示**，不是 Windows 原生端实拍。不使用真实用户资料、账号、麦克风或 AI 服务。页面中学习进度、分数、出勤数据及练习内容均为示例，不能据此声称实际学习效果或生产服务已验收。

| 素材 | 尺寸 | 实际组件与入口 | 示例数据 |
|---|---|---|---|
| `product-library-2026-11.webp` | 1440 × 900 | `ReaderApp.tsx`、`ShelfPage.tsx`、`ReaderTopBar.tsx`；`/?window=reader` | 三本公版作品的标题和作者、模拟进度与考纲计数。通过独立 IPC 替身读取，未接触本机学习数据。 |
| `product-reading-2026-11.webp` | 1440 × 900 | `ReaderApp.tsx`、`ReadingView.tsx`、`DictColumn.tsx`；从书架点击“继续读”，再选择“本章生词” | 《The Nightingale and the Rose》开头节选、自写中文译文与三个生词。沿用已有素材脚本的数据，字号 20、行距设置 1.45。截图等待未配置服务的正常提示消失，没有删改组件。 |
| `product-speaking-2026-11.webp` | 1440 × 900 | 当前 `SpeakView.tsx`；`/speak-preview.html?s=done&theme=sepia` | 仓库开发预览内的书市对话、目标词、模拟逐词与音素评分。不启动预览的录音或评测动作。 |
| `product-review-2026-11.webp` | 1440 × 864 | 当前 `VaultPage.tsx`；`/review-preview.html?v=home&theme=sepia`。截取 y=36 以排除顶部开发说明 | 沿用原开发预览的五词、模拟日志与口语纠偏。原样例缺少与 source 索引对应的原句，并把 unwind、take root 释义写成占位值，本轮仅在浏览器内替换**预览夹具响应**：补齐相符原句、释义，并将示例来源名改为 `Reading and New Ideas`、`Finding the Right Address`，不冒充真实文章摘录。当前组件的复习/渲染代码未变。 |
| `product-shadow-2026-11.webp` | 483 × 409 | 现有 `shadow-preview.html` 直接挂载当前 `ShadowReport.tsx`；浏览器宽度 560，在真实响应式布局中紧贴 `.speak-report-card` 裁切，排除预览对话外壳与空白 | 仓库已有模拟 ISE 结构、4.1 分、薄弱词与重练动作。仅为当前报告组件特写，不是完整口语页截图。 |

## 隔离与实际检查

- 本地 Vite 为 `http://127.0.0.1:1420/`。本机 Node 同级没有 npm 命令，使用已安装项目的 `node_modules/vite/bin/vite.js` 启动；没有安装依赖。
- Chrome 使用独立临时 profile，任务结束自动关闭；未操作用户已有页面。
- 页面请求全部经过 CDP Fetch 拦截，仅放行当前本地 Vite origin 与 data URL。Google Fonts 请求被阻断，因此画面使用现有系统字体回退；没有下载外部字体或媒体。
- Reader 的 IPC 替身明确返回匿名账号、`guest` 学习空间、`website-demo` 设备、空同步列表及关闭的网络目录响应；不读取 API Key 或真实存储。没有使用账号或调用音频动作。
- 五张最终画面 Runtime exception 均为空，页面均无横向溢出。口语、复习、跟读没有 console error。
- 书架与阅读出现两条 `[learning-sync] 登录后才能同步学习资料` console error。这是实际匿名演示环境触发的自动同步调用，已记录，不掩盖也不据此宣称同步通过；替身没有向生产发起请求。
- 11/04 的独立“连续正文＋英文解释”阅读原型没有用于这些正式界面素材。

复现脚本与诊断位于工作区临时目录：`.taste-skill/product-capture-upgrade-2026-11-04.mjs`、`.taste-skill/review-capture-upgrade-2026-11-04.mjs`、`.taste-skill/shadow-closeup-capture-2026-11-04.mjs`；后两者分别生成最终 review 图与紧贴报告的 shadow 特写。诊断保存在同目录的 `*-report-2026-11-04.json` 文件中，不作为静态网站部署资产。

网站建议保留说明：“Windows 界面演示，学习内容与分数为示例。”

## 2026-11-05 官网细节裁切

重新设计的预览页从上述原图生成三张 WebP 细节图，未重绘内容、分数或状态。通过 Pillow 按原图像素裁切后以 quality=92 保存；查看大图仍指向原图。

| 细节图 | 原图 | 裁切框（左、上、右、下） | 输出尺寸 |
|---|---|---|---|
| `product-reading-detail-2026-11.webp` | `product-reading-2026-11.webp` | 210,136,870,550 | 660×414 |
| `product-speaking-detail-2026-11.webp` | `product-speaking-2026-11.webp` | 16,142,920,657 | 904×515 |
| `product-review-detail-2026-11.webp` | `product-review-2026-11.webp` | 259,76,1110,559 | 851×483 |

首屏 HTML 书摘交互使用同一作品中的原句、自写译文和自写开口提示，只在本地切换展示状态，没有连接 AI 服务或麦克风。
