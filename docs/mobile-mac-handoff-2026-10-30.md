# 移动端 Mac 收尾清单

给 Mac 上的 AI：请在当前仓库继续实现并验证下列剩余工作。先读取本文、`docs/mobile-execution-2026-10-29.md`、`immersive-translator-mobile/docs/native-release-checks-2026-10-29.md`、`contracts/learning-relay-v2.md` 和代码现状，再动手。不要重做已完成的 React 主流程、游客/账号模型、Windows 接力或共享合并逻辑，也不要覆盖已有未提交修改。

## 当前状态

移动端主体已经按 `prototypes/mobile-accepted-2026-10-29.html` 实现。Windows 工作站上的移动端构建及账号、查词登录、翻译、同步、草稿、主流程回归通过。剩余工作集中在 iOS 专属原生实现、真实设备验证，以及真实服务端和 Windows+iPhone 联调；当前不能称为已通过发布验收。

优先顺序：先做录音文件保护，再做 Safari 分享接收扩展，然后完成 iOS 真机矩阵和三端端到端回归。每一项要报告实际命令、设备/系统版本、测试结果和未解决问题。只编译通过不算完成。

## P0：iOS 录音文件保护

相关实现：`immersive-translator-mobile/src-tauri/src/audio_store.rs`、`persistence.rs`、`persistence_commands.rs`。当前私有录音位于每个 profile 的本地目录；协议要求录音只在录制设备保存，不同步音频。

- 在 iOS 上为录音目录和录音文件设置 `NSURLIsExcludedFromBackupKey = true` 及 `NSFileProtectionCompleteUntilFirstUserAuthentication`。实现方式须匹配现有 Rust/Tauri/Objective-C 代码结构，并限制在 iOS 条件编译中。
- 检查新建目录、分块写入文件、partial、staged、final 文件、临时文件和原子 rename 后的属性。rename 可能改变或暴露属性，须在最终路径再次应用并验证。
- 对已有录音实现幂等迁移/修复属性；属性设置失败要返回可见错误并保留录音，不能清空或假报成功。
- 确认账号 profile 目录隔离及退出/换号行为不变；不把录音路径或字节写入云同步载荷。
- 补可在本机运行的单元/集成检查。随后在真实 iPhone 验证备份排除、应用升级后旧录音属性迁移、首次解锁前/解锁后的读取表现、锁屏和后台期间的录音读取/续写行为。模拟器或 Windows 检查不能代替这些验证。

完成标准：目录及 partial/staged/final 文件均具有要求的属性；已有文件升级迁移通过；故障不丢音频且前端可见；真机锁屏/备份验证有记录。

## P0：Safari 入站分享扩展

现有 `tauri-plugin-share` 和 `share_text` 是**向外分享**，不提供 Safari 分享到本 App 的 Share Extension。Apple 工程在 `immersive-translator-mobile/src-tauri/gen/apple`。

- 建立签名配置正确的 iOS Share Extension target 和 App Group，与主 App 共享一个有界、可恢复的本地交接队列。确认 `project.yml`、Xcode 工程、entitlements、bundle identifier 和生成流程一致；说明哪些文件是生成源、哪些会被重新生成覆盖。
- 处理 Safari 分享的 URL 和实际可用文本类型；对类型、大小、URL scheme 和正文长度校验，拒绝不支持/超限输入并向用户显示清楚结果。不要因为分享动作就自动登录、联网抓取或保存文章。
- App 打开后显示原型约定的预览/确认流程，再写入既有阅读导入路径。交接需要稳定 ID/去重，重复唤起不得重复导入。
- 处理扩展或 App 被系统终止、重复回调、队列写一半、目标 App 尚未运行和导入失败重试。成功确认消费队列项；失败时保留可恢复输入。限制队列容量和保留时间，避免无限制保存分享内容。
- 增加可自动化的解析、校验、幂等和恢复测试；在真实 iPhone 从 Safari 分享 URL/选中文字，覆盖冷启动、已运行、重复分享、取消确认和进程终止恢复。

完成标准：Safari 分享到 App 能进入预览，确认后恰好保存一次；取消不保存；崩溃后可重试且不重复；无越权联网或静默导入。

## P0：iOS 构建与真机体验

最低系统已统一为 iOS 16。Windows 当前仅验证过 Windows Rust target；以下必须在 Mac/Xcode 环境验证。

- 检查 Xcode、Command Line Tools、CocoaPods、Rust iOS targets 和 Tauri CLI。使用仓库锁文件安装依赖，先运行 TypeScript/Vite 与所有 mobile 确定性测试；对 Apple 工程重新生成时复核 iOS 16 deployment target、麦克风用途文案、entitlements、插件配置和用户已有改动。
- 按本机 Tauri CLI 的 `ios` 命令帮助选择模拟器/真机开发与归档命令，不猜命令参数。先跑模拟器检查构建启动，再用真实 iPhone 验证原生能力。
- 验证：全新安装和升级启动；游客离线阅读、收藏、草稿与冷启动恢复；Keychain 登录/退出/换号/取消；麦克风首次拒绝后重试；录音不足一个分块与长录音；ASR/ISE 失败保留原声和文字；蓝牙/有线/扬声器路由、来电/Siri/锁屏/前后台中断；语音播放互斥；键盘、安全区、动态字体与长文本；低存储/存储失败提示；通知/系统分享权限拒绝时的回退。
- 验证 UI 不覆盖系统 Home Indicator、键盘和安全区；玻璃底栏滚动/拖动不抢垂直滚动，减少动态效果偏好得到尊重。
- 保存可复现测试记录：设备型号、iOS 版本、构建号、权限前置状态、步骤及结果。发现问题要修复并重跑相应回归。
- 本清单只授权本地实现和本机/测试设备验证。不要擅自接受新协议、购买 Apple 计划、上传构建、发布 TestFlight/App Store 或触发真实付费服务；这些需要用户届时明确授权。

完成标准：Apple 原生工程可在支持环境干净构建并安装；真机核心场景通过；崩溃、数据丢失、账号串扰、录音隐私和 P0 交互问题均已关闭或有明确阻塞记录。

## P1：Windows + iPhone + 实际服务端端到端回归

共享协议和服务端实现已经完成本地构建与单元测试；一次嵌入式 PostgreSQL E2E 为 19 项通过、1 项 66 KiB 测例 OOM，单项重跑通过。不能将其描述为全套 E2E 稳定通过。

- 在有稳定数据库内存/资源的测试环境完整重跑服务端 sync E2E，特别记录 65,536 字节边界、分页、quota、409、stale cursor、未知字段和 tombstone 场景。保留 OOM 复现信息；不要通过降低覆盖或跳过失败项宣称通过。
- 用一个隔离测试账号及 Windows、iPhone 两台物理设备验证：登录及资料隔离；同文章/同章节/同句进度、译文和词条往返；笔记与来源引用；口语 task/step/attempt/草稿/反馈；复习 grade/undo 事件；断网后两设备修改同一 task，恢复网络后 attempt 并集与字段时钟收敛；取消回答和删除不会被旧设备复活。
- 明确验证录音音频字节、base64、文件路径不在请求、服务端数据库同步载荷和另一设备状态中；另一设备仅显示源设备录音提示。
- 注入超时、429、断连、服务端错误、进程杀死和重启；未知结果不自动重复发送可能计费的请求。记录 outbox/baseVersion/cursor 最终收敛状态。
- 依照 `contracts/learning-relay-v2.md` 检查协议结果；不得为了测试改动生产数据或把测试用例打到付费服务。

完成标准：服务端全套 E2E 稳定通过；两设备断网并发编辑后重复同步最终收敛；账号数据互不可见；同步请求不含录音字节；失败恢复无丢失或假成功。

## 建议运行顺序

在 `immersive-translator-mobile`：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run storage:test
pnpm run discovery:test
pnpm run sync:test
pnpm run auth:test
pnpm run dict-login:test
pnpm run audio:test
pnpm run draft:test
pnpm run translate:test
pnpm run nav:test
pnpm run smoke
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib
```

Windows 开发机已有的这些测试是基线；Mac 上还应加入 iOS target check、Share Extension 测试、Xcode build 和设备矩阵。iOS 特定 Rust 构建需要联网下载 Apple target crates 时，记录实际情况，不要把 Windows host 测试冒充 iOS 构建。

## 已知边界

- 个人 EPUB/PDF 手机导入仍按约定由 Windows 规范化章节后接力，本轮不扩成手机文件解析器。
- 服务端 tombstone 超过保留期限后的永久防复活保证目前没有实现，见协议说明；本次联调须验证保留期内行为，不得声称永久保证。
- 本地构建、模拟器、浏览器截图均不能替代 iPhone 真机权限、文件保护、备份排除、音频路由和两设备端到端验证。
- 用户确认的完整原型及基线回归记录见 `docs/mobile-execution-2026-10-29.md`。
