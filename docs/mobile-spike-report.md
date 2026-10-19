# M0 Spike 执行报告（Mac 侧 · iOS 真机验证）

> 执行日期：2026-09-12 ~ 09-13 · 执行人：ZCode（按 `docs/mobile-spike-runbook.md` 逐步执行）
> 工程路径：`immersive-translator-mobile/` · identifier：`com.kobejiasuoer.reader`（已锁定）
> 证据截图目录：`prototypes/shots/spike/`

## 环境快照（§0）

| 项目 | 结果 | 证据 |
|---|---|---|
| Xcode | 26.6 (17F113)，已装于 /Applications/Xcode.app，许可已接受 | `xcodebuild -version` |
| xcode-select | 已切换指向 Xcode.app（初始误指 CommandLineTools，人工 sudo 修正） | `xcode-select -p` |
| Rust | 1.98.1 (48a229cea 2026-09-01)，targets：aarch64-apple-darwin / -ios / -ios-sim | `rustup target list --installed` |
| iOS 模拟器 runtime | iOS 26.5 Simulator (23F77) arm64，手动 curl/aria2 下载 .aar 后 `simctl runtime add` 安装（详见下方「模拟器 runtime 下载记」） | 本报告附录 |
| CocoaPods | 1.17.0（brew 安装；tauri ios init 自动触发依赖检查） | `pod --version` |
| libimobiledevice | 1.4.0（tauri ios init 自动经 brew 安装） | init 日志 |
| Node / npm | v25.6.1 / 11.9.0，`npm install` 正常 | — |
| 前端构建 | `npm run build`（tsc + vite）通过，348ms，gzip 后 JS 81KB | build 输出 |
| Rust iOS 编译 | `cargo check --target aarch64-apple-ios-sim` 通过（tauri 2.11.5，1m34s） | check 输出 |

**环境备注（对后续复现有用）**：
- 本机 shell 有全局代理变量（`http_proxy=127.0.0.1:7897`，Clash Verge），系统代理同址开启；Mac 通过 iPhone 个人热点上网（en1 → 172.20.10.1）。
- rustup 为全新安装（旧残留目录无工具链）；cargo 需 `export PATH="$HOME/.cargo/bin:$PATH"`（或 source ~/.cargo/env）。

**模拟器 runtime 下载记（踩坑实录，约占本 spike 总耗时的一半）**：
1. `xcodebuild -downloadPlatform iOS` 走系统下载服务，在本机网络环境下反复停滞（恒 56.5%，无 TCP 数据流动），exit 70。清 shell 代理变量、临时关系统代理（networksetup）重试均无效——排除「系统代理掐断下载」的常见假设（首次停滞前实际已透过代理拉到 4.81GB，root 权限 staging 目录不可见导致误判为 0）。
2. 从 xcodebuild 报错日志提取到 Apple CDN 直链（updates.cdn-apple.com，.aar，8522825728 字节），改 curl 断点续传：单流走代理 7.5MB/s 稳定拉到 7.3GB，但 curl `--retry` 内部重试时遇 Range 请求被忽略会**整个文件从 0 重写**（已知 curl 行为），一夜回到解放前。
3. 终方案：aria2 单连接（`-x1 -s1 -k4M` 走代理）+ 控制文件断点续传 + bash 守护循环自动重启（CDN 对新连接间歇性限速，已建立连接可存活），凌晨 4 点完成全量 7.9GiB，**SHA-1 与官方资产元数据逐字节吻合**（6b5a8d1d…41fce）。
4. 安装坑：`simctl runtime add`（无 sudo）报 `Error creating AEA backend / Invalid argument`（AEA=Apple Encrypted Archive，社区已知问题，开发者论坛 801106 有同款）；`aea decrypt` 需个性化密钥无法离线解；重试 `xcodebuild -downloadPlatform` 续传再次停滞（其恢复机制在本网络下不可用）。**待人工：`sudo xcrun simctl runtime add`**。
- 结论：**此网络环境下不要用 xcodebuild -downloadPlatform / Xcode GUI 下载大 runtime，直接 aria2 直链 + 断点续传**。

## §1 生成 iOS 工程

- 命令：`npm run tauri ios init` —— **成功**。
- identifier 自动取自 tauri.conf.json，确认为 `com.kobejiasuoer.reader`（`src-tauri/gen/apple/project.yml:14`，出现 2 处均正确），未被询问、未改动。
- **与手册的路径差异**：Tauri 2 实际生成目录是 `src-tauri/gen/apple/`（含 `imreader-mobile.xcodeproj`、`Podfile`、`project.yml` 等），不是手册 §1 写的 `src-tauri/ios/`。后续所有「Xcode 打开工程」均指 `src-tauri/gen/apple/imreader-mobile.xcodeproj`。
- 过程记录：首次运行因缺 CocoaPods 失败（tauri 尝试 gem 安装需 sudo），`brew install cocoapods` 后重跑成功；期间 tauri 自动安装了 xcodegen、idevicesyslog、pod 等 brew 依赖。
- 警告：`No code signing certificates found`——预期内，模拟器不需要签名；真机阶段再配 Team（见 S1+）。

## S1 模拟器跑通

**结论：通过**（经历环境磨难后）。

- runtime：iOS 26.5 (23F77)，Xcode GUI Platforms 页下载安装（CLI 通道在本机网络不可用，见 §0 下载记）。
- `npm run tauri ios dev -- "iPhone 17"`（模拟器按**名字**匹配）——构建、部署、启动全链路 OK。
- 首屏 < 3s 出现：**通过**（部署后模拟器冷启动到界面渲染约 2s，主观流畅）。
- Rust 日志通道：正常（`[spike]` 前缀的 stdout 能从 `simctl`/dev 日志流里看到）。
- 证据截图：`prototypes/shots/spike/s1-simulator-today.png`（修复后「今天」页完整渲染）；`s1-simulator-black-before-fix.png`（修复前黑屏，见下方根因记录）。

**黑屏坑根因记录（本 spike 最重要的工程发现）**：spike 工程的 `tauri.conf.json` 里 `app.windows` 为 `[]`（空数组）→ Tauri 在 iOS 上一窗口都不创建 → 模拟器/真机均纯黑屏，且无任何报错（进程、签名、WebKit 网络扩展全部正常，极易误诊为系统/签名问题）。桌面期只在浏览器验证过 vite 页面、未以桌面窗口形态运行过，故未暴露。**修复：补 `windows: [{ label: "main", url: "index.html" }]`，重新构建即恢复**。诊断手段：Rust 侧 `setup` 钩子打印 `app.webview_windows().len()`（0 → 定案）。

## S1+ 真机跑通

**结论：通过（含踩坑实录，坑均已在下文记录，属于一次性环境问题）**。

- 真机：iPhone 17（iPhone18,3），iOS 27.0 Beta (24A5390f)，UDID `00008150-001620CC3C92401C`。
- 签名：免费 Personal Team `3HX836XLHX`（Apple Development: 1448950074@qq.com），Xcode 自动签名 + `-allowProvisioningUpdates` 自动生成 `iOS Team Provisioning Profile: com.kobejiasuoer.reader`，全程零手工证书操作（免费账号 7 天有效期，spike 够用）。
- 最终命令：`npm run tauri ios dev`（**不带任何参数**）。证据（dev 日志）：`Launched application with com.kobejiasuoer.reader bundle identifier`；安装路径 `/private/var/containers/Bundle/Application/9422A471-…/reader-spike.app/`。
- Rust debug 版编译 + 签名 + 安装 + 启动全链路 OK；`idevicesyslog` 日志通道已挂（「Watching src-tauri for changes」+ connected 标记）。

**踩坑实录（复现规避，均属环境/CLI 行为，非 Tauri 能力问题）**：
1. **设备参数是按名字模糊匹配的**：`tauri ios dev <参数>` 里传 UDID（xctrace 或 CoreDevice 格式均不行）→ `best_match` 0 分 → 报错被吞 → 静默回落到「无模拟器」分支 → 卡 "Opening Xcode"。**单设备场景直接不传参**，CLI 自动选中（无交互提示）。
2. **真机 dev 的 devUrl**：CLI 检测到真机会把 localhost 改写为当前局域网 IP（`use_network_address_for_dev_url`），但 vite 必须监听公网——本项目 vite 配置原为 `host: false`，已改 `host: true`（spike 必要修复之一）。不要在 tauri.conf.json 里硬编码 IP（本机网络在热点/路由器间切换过一次，硬编码必踩雷）。
3. **手机侧三件套缺一不可**：开发者模式（不开则 xcodebuild `error:Developer Mode disabled`，需重启手机生效）→ 信任电脑 → VPN与设备管理里信任开发者证书（免费账号装完 app 首次启动会黑屏/拒绝，`invalid code signature … not been explicitly trusted`，信任后即可）。
4. 装上但黑屏还有一种常见原因：dev 进程已死（app 加载的是 Mac 上 5174 的 vite 页面），重跑 dev 即可。

## S2 长文性能（核心项）

（待执行）

## S3a TTS

（待执行）

## S4 BYOK 网络

（待执行）

## S5 文件导入

（待执行）

## S6 Share Extension 预研

**社区方案调研（先行， hands-on 验证见下）**：

- Tauri 2 **无官方 Share Extension 支持**；官方插件 `tauri-plugin-share` 只是「发起分享」方向，不是接收方。
- 社区可行路径（Reddit r/tauri 2026 帖）：手动在 Xcode 给生成的工程加 Extension target → 扩展把数据写入 **App Groups 共享容器** → 主 App 前台在 `visibilitychange` 时轮询读取。iOS 平台限制：Share Extension **无法直接拉起主 App**（所有跨端框架同此限制，非 Tauri 独有）。
- 已知坑：GitHub issue #15663——用 App Store Connect **API-key 认证**构建时，嵌入扩展的 entitlements 会丢失（CI/上架发布路径受影响；本地 Xcode 签名构建不受此 bug 影响）；#10197 有反馈加扩展后模拟器部署异常的个案。
- 结论倾向：与手册 §8 预期一致——技术上可行但要手动维护 Xcode 工程，「折腾 2 小时不通 → P0 降级剪贴板检测」的预案成立。

（hands-on 最小验证结果：待执行）

## S7 CSS/键盘

（待执行）

## §10 Rust 侧探针

（待执行）

## §11 Go/No-Go 结论

（待汇总）
