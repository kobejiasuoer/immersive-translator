# 移动端免费签名续期 · 2026-11-07

用户反馈手机 App 打不开,判断为免费 Personal Team 签名 7 天到期。本轮完成确认、重建、原位安装,数据保留。未提交代码、未打 tag、未发版。

## 过期确认

- 旧包(11-05 安装产物)`embedded.mobileprovision`:创建 `2026-10-30T14:27:59Z`,**过期 `2026-11-06T14:27:59Z`**(北京时间 11-06 22:27)。11-05 的原位安装复用了 10-30 旧档案,所以昨晚失效。
- 团队 `3HX836XLHX`(免费个人团队),bundle `com.kobejiasuoer.reader`。钥匙串中开发证书仍在。

## 为什么没用现成的 resign-ios.sh

`scripts/resign-ios.sh` 重签的对象是 `gen/apple/build/imreader-mobile_iOS.xcarchive`,而该归档(11-04 08:07)的 `CFBundleExecutable` 仍是中文「沉浸口语」——正是 [启动闪退修复](mobile-ios-startup-fix-2026-11-04.md) 之前的产物,直接重签会把闪退版装回手机。本轮改为完整重建,并给脚本加了可执行名防呆(归档非 `immersive-speaking` 即拒绝执行)。

## 构建与验证

- 11-06 中午后源码无改动;重新 `npm run build`,产物哈希与 11-05 验收版一致(主入口 `index-Dzp4MACi.js` 同名同内容),源码零漂移实证。
- 踩坑两连,均已解决:
  1. `No Accounts`:Xcode Apple ID 会话失效,重启 Xcode 无效,需用户在 Xcode 里重新登录(本次由用户完成)。
  2. `generic/platform=iOS` 目标报「team has no devices」:免费团队生成档案需指定已连接设备,改 `-destination 'id=00008150-001620CC3C92401C'` 后通过。
- 最终命令(其余参数同 11-04 文档):`xcodebuild … -destination 'id=00008150-…' -derivedDataPath /tmp/renew-device-build-2026-11-07 -allowProvisioningUpdates PRODUCT_NAME=immersive-speaking build`,结果 `BUILD SUCCEEDED`。
- 产物核验:可执行名 `immersive-speaking`、显示名「沉浸口语」、`codesign --verify --deep --strict` 通过;新档案创建 `2026-11-07T04:06:48Z`,**过期 `2026-11-14T04:06:48Z`**(下次到期:11-14 12:06,Asia/Shanghai);内嵌前端与验收版逐位一致(旧二进制 20KB 探针在新二进制同偏移命中,差异仅在签名区)。

## 备份、安装与启动

- 安装前备份:`Library/Application Support` 全量 7.4 MiB(2 个 profile 资料库含 WAL、6 个 WAV 录音),与 11-05 基线口径一致。`Library` 整目录备份会被系统保护的 SplashBoard 快照挡住(EPERM),故只备份应用数据子目录。
- `devicectl` 返回 `App installed`(原位,未卸载)。
- 远程前台启动两次 `RequestDenied`(锁屏状态下 iOS 拒绝远程拉起),待用户解锁后验证。

## 证据

- 构建日志:`/tmp/renew-2026-11-07/xcodebuild-retry3.log`(成功)、`build.log`(首跑,含 vite)、`xcodebuild-retry.log` / `xcodebuild-retry2.log`(两次失败)
- 新档案:`/tmp/renew-2026-11-07/new-profile.plist`;旧档案备份:`/tmp/renew-2026-11-07/expired-profile-d1801116.bak`
- 设备数据备份:`/tmp/renew-2026-11-07/device-backup/`
- 仓库 IPA 已同步:`immersive-translator-mobile/src-tauri/gen/apple/build/arm64/沉浸口语.ipa`,SHA-256 `85f45405da2d705a9caee3efaefc7cec0a811ae5cb436275f288063a8f3e5da7`

## 待办与提醒

- **11-14 12:06(北京时间)再次到期**,续期流程见本文与 `scripts/resign-ios.sh`(注意其防呆提示)。
- 若 Xcode 再报 `No Accounts`,需在 Xcode → Settings → Accounts 重新登录 1448950074@qq.com。
- 根治需付费开发者账号($99/年,档案 1 年有效)或上架分发,未在本轮范围。
