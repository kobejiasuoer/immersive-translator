# M0 Spike 执行手册（Mac 侧）

> 工程已就位：`immersive-translator-mobile/`（React 界面 + Tauri 2 工程，Windows 上已验证：`npm run build` ✓、`cargo check` ✓、浏览器全链路 ✓）。
> 本手册把 Mac 侧要做的事压缩成「照着敲」的清单，预计 1–2 天出 Go/No-Go 结论。
> 判据与背景见 `docs/mobile-implementation-plan.md` §3-M0。

## 0. 一次性环境（约 1 小时）

```bash
# 1) Xcode（App Store，约 12GB）+ 命令行工具
xcode-select --install

# 2) Rust（若 Mac 上没有）+ iOS 目标
rustup target add aarch64-apple-ios aarch64-apple-ios-sim

# 3) 拉代码 + 装依赖
git pull && cd immersive-translator-mobile && npm install
```

Xcode → Settings → Accounts → 登录 Apple ID（免费即可开始真机调试；付费账号建议此步顺手买好，$99/年）。

## 1. 生成 iOS 工程（首次，5 分钟）

```bash
npm run tauri ios init
```

- 提示 identifier 时确认/填 `com.kobejiasuoer.reader`（**已锁定，上架后不可改**，与产品名无关）；
- 生成 `src-tauri/ios/`（Xcode 工程）。提交进 git；
- （可选）正式图标：`npx tauri icon path/to/1024x1024.png` 会补全整套 iOS 图标，spike 阶段可跳过。

## 2. S1 模拟器跑通（10 分钟）

```bash
npm run tauri ios dev        # 默认起模拟器
```

- 首屏 < 3s 出现即通过；
- 打开 Xcode console 应能看到 Rust 日志通道正常；
- 「我的」页调 `storage_probe`（见 §6）验证沙盒写读。

## 3. S1+ 真机跑通（30 分钟）

1. iPhone：设置 → 隐私与安全性 → 开发者模式（iOS 16+，需重启）；
2. 数据线连 Mac；Xcode 打开 `src-tauri/ios/` 里的 `.xcodeproj`，Signing & Capabilities 选你的 Team（免费 Apple ID 即可，签名 7 天过期）；
3. iPhone 上信任证书：设置 → 通用 → VPN与设备管理；
4. `npm run tauri ios dev`（或直接 Xcode Run）。
   - 排错：WebView 调试用 Mac Safari → 开发菜单 → [iPhone] → [WKWebView]。

## 4. S2 长文性能（核心项，30 分钟）

操作：App 内 书架 → 「Stress ×75」→ 观察右上角角标，然后快速滚动到底再滚回。

记录（写进 `docs/mobile-spike-report.md`）：

| 指标 | 桌面 Chrome 基线 | 真机实测 | 结论 |
|---|---|---|---|
| 首屏渲染角标 | 103ms | ___ | |
| 600 句 / 12450 节点全量渲染滚动流畅度 | 流畅 | ___（主观：掉帧/跟手） | |
| 内存（Xcode → Debug Memory Graph） | — | ___ MB | |

判据：真机渲染 ≤ 400ms 且滚动无明显掉帧 → 通过；否则尝试：`content-visibility: auto`（给 `.para` 加）再测一轮；仍不行 → 虚拟化方案评估或 No-Go。

## 5. S3a TTS（30 分钟）

操作：「我的」→ TTS 自检 → 播放测试句，连续 5 次；再去阅读页开逐句连播听 10 句。

- 看 onstart/onend 计数：**onend 恒 0 而播放正常** = WebView 的 onend 不可靠（我们已做兜底定时器，console 会 warn，统计命中率）；
- 真机静音键、音量、锁屏后是否停播（锁屏停播属预期，正式实现走 AVSpeechSynthesizer + audio session）；
- 结论三选一：① Web Speech 完全可用（后续零原生工作）② onend 不可靠但兜底可接受 ③ 整体不可用 → M4 写 AVSpeechSynthesizer 插件（原生，1–2 天）。

## 6. S4 BYOK 网络（15 分钟）

操作：「我的」→ BYOK 测试 → 填任意一家的 endpoint + key（DeepSeek/智谱/OpenAI）→ 发送。

- HTTP 200 + 回包 → WebView fetch 直连可行（最省事）；
- CORS/TypeError → 记录错误原文，改走 Rust `tauri-plugin-http`（M1 加依赖重测，spike 只需结论）。
- 桌面 Chrome 已可先测同一请求作对照。

## 7. S5 文件导入（15 分钟）

操作：书架 → 选择文件 → 选任意 .json。

- 真机上应唤起 document picker（Files app），能读到文件并 toast 解析结果；
- 顺带测 AirDrop 一个 .json 到手机再从「文件」里选——这是 v0 互导的真实路径。

## 8. S6 Share Extension 预研（半天，可最后做）

先查社区方案（Tauri app extensions 反馈较多）：

- 最小验证：Xcode 里给生成的工程加 Share Extension target + App Group → 扩展写一条假数据到共享容器 → 主 App 前台读出来；
- 通过 → M4 做正式版；折腾 2 小时仍不通 → **降级决定**：P0 改剪贴板检测（App 激活时识别英文），扩展移 P1。这不是失败，是计划内的岔路。

## 9. S7 CSS/键盘（15 分钟）

- 四主题逐个切（令牌已去 color-mix，iOS 16.0 目标安全）；
- 遮罩模式 + 揭底；
- 复习 → 完形卡：聚焦输入框，观察键盘是否遮挡输入槽（输入框字号已设 17px 防 iOS 自动放大）；遮挡 → M5 加 visualViewport 适配。

## 10. Rust 侧探针（5 分钟）

「我的」页暂无按钮（spike 不接 invoke），可在 Safari WebView console 里直接跑：

```js
const { invoke } = await import("http://localhost:5174/@tauri-apps/api/core");
await invoke("storage_probe").then(console.log).catch(console.error);
await invoke("ping"); // "pong"
```

`storage_probe` 返回 iOS 沙盒路径 + 写读回显，即 M1 数据层选址确认。

## 11. 出报告 → 拍板 Go/No-Go

把上面各表填进 `docs/mobile-spike-report.md`（新建，格式随意，证据截图放 `prototypes/shots/spike/`），对照落地文档 §3-M0 的 No-Go 判据给结论。**Go → 进入 M1（monorepo 抽包）；No-Go → 切 Expo RN（reader-core 复用不变）。**
