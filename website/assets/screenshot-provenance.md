# 官网产品界面素材

制作日期：2026-10-30。

这些图片是在 Chrome 中直接渲染当前工作区的 Windows React 前端后截取的**界面演示**，不是 Windows 原生运行端实拍。图片没有重新绘制产品布局，也没有读取用户的本地学习资料、登录令牌或真实录音。

| 图片 | 尺寸 | 代码与数据来源 |
| --- | --- | --- |
| `product-library.webp` | 1440 × 900 | 当前 `src/reader/ReaderApp.tsx`、`ShelfPage.tsx` 与 `reader.css`；隔离的 Tauri 存储替身提供三本书和示例进度。书名、作者为公版作品；进度、考纲数量为演示数据。 |
| `product-reading.webp` | 1440 × 900 | 当前 `ReaderApp.tsx`、`ReadingView.tsx`、`DictColumn.tsx`；公版作品《The Nightingale and the Rose》开头节选、自写中文译文与三个示例生词。 |
| `product-speaking.webp` | 1440 × 900 | 已有 `speak-preview.html?s=done&theme=sepia` 直接挂载当前 `SpeakView.tsx`；对话、目标词、逐词/音素评分来自仓库原有开发演示数据。 |
| `product-review.webp` | 1440 × 864 | 已有 `review-preview.html?v=home&theme=sepia` 直接挂载当前 `VaultPage.tsx`；生词、练习与掌握统计为仓库原有开发演示数据。截取产品内容区域，排除顶部开发预览工具栏。 |

截图环境通过隔离 IPC 替身返回演示资料；不接通 AI、账号、语音或同步服务，不使用麦克风。现有预览的 Tauri event plugin cleanup 缺失由截图脚本中的替身补齐；未修改业务代码或掩盖业务运行错误。最终四个页面的 Chrome Runtime exception 记录均为空。

官网适宜用“Windows 界面演示，学习内容与分数为示例”说明素材。不能用这些图证明模拟分数、模拟统计或当前工作区未提交功能已进入公开安装包。

复现脚本位于工作区临时目录 `.taste-skill/product-capture.mjs`，使用现有 `localhost:1420` Vite 服务及设计技能的独立 Chrome CDP 客户端。需要新实拍时，可在应用原生截图工具恢复后替换同名素材。
