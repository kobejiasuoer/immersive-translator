# 液态玻璃重构版真机安装 · 2026-11-08

已将本轮液态玻璃重构版本原位安装至已配对的 iPhone 17。未卸载应用，bundle 保持 `com.kobejiasuoer.reader`、中文显示名「沉浸口语」、ASCII 可执行名 `immersive-speaking`。

- 当前源码重新完成 TypeScript/Vite 与 Xcode Release 构建，`BUILD SUCCEEDED`。
- 使用现有开发团队和设备签名，签名校验通过，签名档案包含目标手机。
- 构建期间源码散列无漂移，当前全部8个前端资源名均已嵌入主程序，运行不依赖 Vite 开发服务器。
- `devicectl` 返回 `App installed`。
- 安装前后 `Library/Application Support` 已备份。9个文件SHA-256全部一致，两个SQLite完整性检查通过，所有表逐行一致；主库322条记录、6条录音、483个音频块完整保留，6个WAV哈希一致。
- 上述逐文件一致性对比对应安装后、首次启动前。首次远程前台启动曾被 iOS 以 `Locked` 拒绝；用户解锁后，北京时间11:28成功前台启动，`devicectl` 返回 `Launched application`，PID为5637。后续两次查询确认同一安装路径、同一进程持续运行。
- 启动后重新备份并核验：两个SQLite完整性检查通过，没有缺失文件或记录；322条主库记录的内容和删除标记均保持原样，版本字段按启动持久化更新。6条录音、483个音频块逐行一致，6个WAV哈希完全一致。启动后的诊断日志及revision变化属于运行写入，不宣称所有文件仍逐字节相同。
- 以上确认安装、启动、进程存活和资料保全；未将其等同于触摸手感、真机帧率或麦克风/语音服务验收。
- 免费开发签名有效至北京时间 **2026-11-14 12:06:48**。

IPA已同步至 `immersive-translator-mobile/src-tauri/gen/apple/build/arm64/沉浸口语.ipa`。未提交代码或发布。

构建产物位于 `/tmp/immersive-liquid-device-build-2026-11-08/Build/Products/release-iphoneos/immersive-speaking.app`。构建、签名、安装及数据校验证据位于 `/tmp/immersive-liquid-device-2026-11-08/`；该目录含私有应用数据备份，没有复制进仓库，临时目录不保证长期保留。
