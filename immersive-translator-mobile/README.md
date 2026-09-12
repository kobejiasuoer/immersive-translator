# immersive-translator-mobile

沉浸阅读室移动端（iOS 先行）· **M0 spike 工程**。

目的：在写正式代码前，真机验证 Tauri 2 iOS 的关键不确定性（落地文档 §3-M0）。
交互蓝本：`prototypes/mobile-v1.html`；执行手册：`docs/mobile-spike-runbook.md`。

## 目录

```
src/            React 界面（四 Tab + 阅读器 + 复习 + 自检面板）
  core/         判分/SRS/数据（M1 迁 packages/reader-core）
  screens/      TodayScreen / VocabScreen / ShelfScreen / MeScreen / ReaderScreen / ReviewScreen
  ui/           令牌与基底样式（无 color-mix，iOS 16.0 兼容）
src-tauri/      Tauri 2 工程（ios/ 目录由 Mac 上 `tauri ios init` 生成）
```

## 运行

```bash
npm install

# Windows / 浏览器开发环（日常 UI 迭代就用这个）
npm run dev            # http://localhost:5174

# Mac / iOS（见 docs/mobile-spike-runbook.md）
npm run tauri ios init # 首次，生成 src-tauri/ios（需要 Xcode）
npm run tauri ios dev  # 模拟器；真机在 Xcode 里选设备
```

## spike 自检入口（都在 App 内）

- **S2 性能**：书架 → 压测文章（600 句全量渲染），右上角角标 = 首屏渲染 ms + 节点数；
- **S3a TTS**：我的 → TTS 自检（onstart/onend 计数，判断 Web Speech 在 WKWebView 的可靠性）；
- **S4 BYOK**：我的 → BYOK 网络测试（WebView fetch 直连 LLM API，CORS 观察）；
- **S5 导入**：书架 → 导入同步文件（file input / 真机 document picker）；
- **键盘适配**：今天 → 开始复习 → 完形卡（键盘弹起是否遮挡输入槽）。

spike 结果记录到 `docs/mobile-spike-report.md`，Go/No-Go 判据见落地文档 §3-M0。
