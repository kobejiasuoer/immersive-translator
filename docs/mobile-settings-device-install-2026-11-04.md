# 账号与语音调整真机原位更新 · 2026-11-04

用户在代码修改后要求更新真实手机并实机验。本轮已对已配对 iPhone 17 完成原位安装与前台启动，未卸载、未修改版本号、未执行 GitHub 或商店发版。

## 构建与安装

- 先备份手机应用的 Library，路径 `/tmp/mobile-settings-device-before-2026-11-04/Library`，约 20 MiB。账号会话继续使用同一 bundle id 的现有钥匙串。
- TypeScript / Vite 构建通过。编译期间阅读与提醒的并行改动完成，因此补做一轮前端与 Xcode release 构建。
- Xcode 构建使用既有工程、开发团队 `3HX836XLHX`、bundle `com.kobejiasuoer.reader`、ASCII 内部产物名 `immersive-speaking`、中文显示名「沉浸口语」，Rust 相位启用 `tauri/custom-protocol`，内嵌前端，不依赖 Vite。
- `codesign --verify --deep --strict` 通过，主程序包含本次构建快照的全部 9 个前端资源。主入口 `index-BNNH7RVl.js`；账号、语音、服务请求及存储的关键源文件与构建快照散列一致。
- 23:32:23（Asia/Shanghai）开始安装，`devicectl` 返回 `App installed`；23:33:43 正常前台启动返回 PID 58849。
- 之后手机发生另一次并行原位安装，应用 Bundle/Application 路径改变，原 PID 消失。没有本次新增的应用崩溃记录，不能把这次进程消失认定为代码闪退。
- 23:36:31 再次前台启动，并以诊断 console 观察。PID 58865 在一分钟后仍运行。退出本机诊断 console 后再次确认应用进程继续存在。
- 安装后 Library 备份位于 `/tmp/mobile-settings-device-after-2026-11-04/Library`。前后学习数据库均保留 279 条 records、2 条录音与 220 个音频块；两份 profile snapshot 仍存在。

本轮安装完成后，另一聊天继续修改并安装同一应用，因此这份构建快照及资源散列仅对应本轮产物，不用于冒认随后并行安装的二进制。

## 验收边界

已确认原位安装成功、真实设备前台启动与进程持续运行。需要用户继续实际验证账号页、阅读设置、登录后的声音试听、语音识别及跟读评分；进程存活不等于物理可听验收。本轮没有自动采集麦克风或替用户发起评分。

## 临时证据

- 产物：`/tmp/mobile-settings-device-build-2026-11-04/Build/Products/release-iphoneos/immersive-speaking.app`
- 构建日志：`/tmp/mobile-settings-device-xcode-2026-11-04.log`
- 构建输入：`/tmp/mobile-settings-device-build-input-2026-11-04.json`
- 包校验：`/tmp/mobile-settings-device-package-verification-2026-11-04.json`
- 安装与启动：`/tmp/mobile-settings-device-install-2026-11-04.json`、`/tmp/mobile-settings-device-launch-2026-11-04.json`
- 最终进程：`/tmp/mobile-settings-device-processes-final-2026-11-04.json`

`/tmp` 路径不保证长期保存。
