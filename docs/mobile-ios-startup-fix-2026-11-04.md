# iOS 真机启动闪退修复 · 2026-11-04

## 结论与范围

继续用户 2026-11-04 的真机重装请求。旧版本存在真实原生启动崩溃，不能只归因于开发服务器退出。手机崩溃日志证实：中文 `.app` / 可执行路径下，Wry 探测 WebKit 版本时调用 Foundation，主线程触发 `EXC_BREAKPOINT / SIGTRAP`，尚未加载前端。

修复保持桌面显示名「沉浸口语」，仅将 iOS 内部产物名固定为 `immersive-speaking`。使用内嵌前端的 release 构建原位安装，未卸载 App、未提交代码、未发版。

## 真机证据与回归来源

- 设备：已配对 iPhone 17，CoreDevice ID `79CCCDC3-4EB4-5033-B69D-079E8F82AAB4`。
- 21:30:09 与 21:39:11（Asia/Shanghai）的两份崩溃报告在 `/tmp/codex-mobile-crashes-2026-11-04/`，原始报告保留在手机上。
- 两份报告的 `procPath` 均以 `沉浸口语.app/沉浸口语` 结尾。
- 共同调用栈：`CFRelease → __CFBundleCopyFrameworkURLForExecutablePath → NSBundle bundleWithIdentifier → wry::wkwebview::platform_webview_version → tauri_runtime_wry::Wry::init`。
- 待安装旧 IPA 的 `CFBundleExecutable` 为「沉浸口语」，与 [此前启动对照记录](mobile-ios-debug-2026-11-03.md) §5 的崩溃条件一致。旧 IPA 已备份到 `/tmp/codex-mobile-obsolete-2026-11-04.ipa`。

生成工程被覆盖的来源已确认：Tauri CLI 2.12.4 的 [synchronize_project_config](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-cli/src/mobile/ios/mod.rs#L588) 在每次 `ios dev` / `ios build` 时把 `PRODUCT_NAME` 改成配置的 `productName`。所以仅修 `project.yml` 或手改 `project.pbxproj` 不足以避免下次部署复发。

## 最终变更

1. `src-tauri/tauri.ios.conf.json` 仅覆盖 iOS 的 `productName = immersive-speaking`；Tauri CLI 与 Rust 配置生成按目标平台合并该文件，其他平台不受此文件影响。
2. 现有 `project.pbxproj` 的 debug / release target `PRODUCT_NAME` 恢复为 `immersive-speaking`，与 `project.yml` 一致。
3. 原有 `Info.plist` 的 `CFBundleDisplayName` / `CFBundleName`、窗口标题保持「沉浸口语」。本次没有重初始化 iOS 工程；以后运行 `ios init` 仍应复核生成的显示名、用途文案、签名与原有构建脚本。

## 构建、安装与验证

先在 `immersive-translator-mobile/` 执行 `npm run build`，TypeScript / Vite 构建通过，保留现有分块和体积警告。随后执行：

```sh
xcodebuild \
  -project src-tauri/gen/apple/imreader-mobile.xcodeproj \
  -scheme imreader-mobile_iOS \
  -configuration release \
  -destination 'id=00008150-001620CC3C92401C' \
  -derivedDataPath /tmp/codex-mobile-standalone-2026-11-04 \
  -allowProvisioningUpdates \
  PRODUCT_NAME=immersive-speaking build
```

工程的 Build Rust Code 相位带 `tauri/custom-protocol`，内嵌当前 `dist/` 资源，运行不依赖 5174 / 5175 服务。最终 Xcode 构建记录 `BUILD SUCCEEDED`；`codesign --verify --deep --strict` 通过。包内 `CFBundleExecutable = immersive-speaking`，中文显示名正确，二进制包含全部 9 个当前前端资源文件名，主入口为 `index-DbS7aenA.js`。

- 构建日志：`/tmp/codex-mobile-standalone-build-2026-11-04.log`。
- 安装前资料备份：`/tmp/codex-mobile-backup-2026-11-04/Library`，备份结果 JSON 为 `/tmp/codex-mobile-backup-2026-11-04.json`。
- 最终 `.app`：`/tmp/codex-mobile-standalone-2026-11-04/Build/Products/release-iphoneos/immersive-speaking.app`。
- 更新后的开发签名 IPA：`immersive-translator-mobile/src-tauri/gen/apple/build/arm64/沉浸口语.ipa`，内部为 `Payload/immersive-speaking.app`。SHA-256：`ea0ac60588ed049185a7359f8ddfb1b8cb66e4f535a661649d324b248ca76895`。
- 21:46:59 开始原位安装，`devicectl` 返回 `App installed`，bundle id 为 `com.kobejiasuoer.reader`，版本 `0.1.0`。安装结果：`/tmp/codex-mobile-install-2026-11-04.json`。
- 21:47:40 发起前台启动，`devicectl` 返回 `Launched application`，PID `58398`。启动结果：`/tmp/codex-mobile-launch-2026-11-04.json`。
- 首次后续进程查询确认同一 PID / ASCII 可执行路径仍运行，结果为 `/tmp/codex-mobile-processes-first-2026-11-04.json`。
- 超过 1 分钟后的最终查询仍为同一 PID `58398`，结果为 `/tmp/codex-mobile-processes-final-2026-11-04.json`；按新可执行名抓取崩溃报告仅返回 11 月 2 日的历史磁盘写入资源报告，没有本次启动的新报告。

本次启动与进程存活证据用于验证启动闪退修复。语音实际是否发声、ISE 服务路由、底栏拖动手感和阅读翻译观感仍需手机内验证；未把构建成功或进程存活当作这些功能已通过真机验收。iPhone 镜像当时要求手机额外解锁确认，未通过镜像观察首屏或播放音频。
