# 当前确认版真机安装 · 2026-11-07

已将用户确认的液态玻璃、侧滑返回、普通返回免确认版本原位安装到已配对的 iPhone 17。保持 `com.kobejiasuoer.reader` 和中文显示名「沉浸口语」，未卸载 App、未修改版本号、未发布。

## 本轮完善

实际浏览器复现了口语返回的一个动画问题：保存超过一帧时，页面先回到原位，再从原位退出。现在业务返回按钮在保存期间标记 `data-nav-back-pending`，侧滑保持释放位置；保存完成后继续滑出，操作取消或局部失败才回弹。保存期间没有持续动画循环，不提前出栈或绕过数据保存。

改动仅涉及 `LearningPractice.tsx`、`ui/edgeBack.ts`、`ui/edgeBack.css` 及对应手势验收脚本。底部与页内液态玻璃组件保持原样。

## 安装与资料

- Xcode Release 构建内嵌全部前端资源，不依赖电脑 Vite 服务；可执行文件保留 ASCII 名 `immersive-speaking`。
- 签名校验通过，签名档案包含该设备，**有效至北京时间 2026-11-14 12:06:48**。
- 安装前备份 `Library/Application Support`。两次原位安装均保留学习资料和 6 个 WAV 文件；两个资料库完整性检查均通过，主资料库仍为 322 条记录、6 条录音及 483 个音频块。最终对比见 [资料核验](mobile-current-device-install-2026-11-07/database-preservation.json)。
- 最终 `devicectl` 返回 `App installed`，随后返回 `Launched application`；后续检查同一安装包进程仍在运行。此证据确认安装和启动，不代表已自动验证物理触摸、麦克风或远程语音服务。
- 当前 IPA 同步至 `immersive-translator-mobile/src-tauri/gen/apple/build/arm64/沉浸口语.ipa`。

## 验证与证据

- TypeScript/Vite、Xcode Release 构建、代码签名校验通过；源码散列与最终构建输入一致。
- 33 项侧滑交互测试、37 项录音与返回回归通过。
- 12 组实际浏览器验收通过，其中 CDP 触摸验收将进度保存延迟 600ms，确认页面保持释放位置，保存后继续向右，无先回弹；重新进入后草稿仍在。[浏览器日志](mobile-current-device-install-2026-11-07/touch-browser.txt)。
- [安装包核验](mobile-current-device-install-2026-11-07/package-verification.json) · [手势测试](mobile-current-device-install-2026-11-07/edge-interaction.txt) · [录音回归](mobile-current-device-install-2026-11-07/recording-regression.txt)。

完整构建、安装、启动记录及私有资料备份保存在 `/tmp/immersive-device-current-2026-11-07/`；源码/构建产物位于 `/tmp/immersive-device-current-build-2026-11-07/`。私有资料未写入仓库；临时目录不保证长期保留。
