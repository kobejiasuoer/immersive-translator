# 移动端无声排查与修复 · 2026-11-04

## 实测问题

用户反馈重新安装、启动闪退修复后，所有「听示范」与阅读播放仍然无声。此次继续检查共享朗读路径，而没有把进程存活当作声音验收。

两个独立问题已获得证据：

1. 手机保存的最新诊断表明，默认 Edge 合成每次返回 HTTP 403，随后降级为系统朗读。移动端直接访问 Edge 服务，不是用户已经验证正常的应用服务端 TTS 路由。
2. iOS 原生音频会话代码给 `setCategory:withOptions:error:` 传了普通 NSString `playback`，而非 SDK 定义的 `AVAudioSessionCategoryPlayback` 常量；失败没有回传。随后使用的单参数 `setActive:` 也不在当前 SDK 声明中，应为 `setActive:error:`。这些错误此前没有被只测采集的 `audio:test` 覆盖。

安装原生修复后、尚未更新 Edge 协议时，22:13 的真机只播放自检读回：类别 `AVAudioSessionCategoryPlayback`、路由 `Speaker`、媒体音量 `0.05`，两次 Edge 合成仍返回 403。报告为 `/tmp/codex-mobile-audio-selftest-before-edge-2026-11-04.jsonl`。这一对照区分了原生会话与合成协议，音量读回不用于代替物理可听确认。

## 修复

- `src-tauri/src/audio_session.rs` 动态加载 AVFAudio，并通过 `dlsym` 取得真实 Playback 常量。完整检查设置类别、激活和类别读回；NSError 的 domain/code/description 回传到前端。保留 MixWithOthers，输出诊断仅记录端口类型，不记录用户设备名称。
- `restore_playback_audio` 在主线程执行，并把真实结果传回命令调用者。启动初始化失败仅记录错误，不阻止应用启动。
- `src/services/webAudioSession.ts` 为支持 Audio Session API 的 WebKit 设置 `navigator.audioSession.type`；播放声明 `playback`，采集声明 `play-and-record`。用引用计数和幂等释放防止录音期间点示范切走当前录音会话。
- `voice.ts` 在云朗读与原声播放前等待原生恢复，再检查 AudioContext running 状态。缓存命中的重复点播也重新恢复会话；恢复失败不会启动音源。`store.speak` 同步准备播放，覆盖访客与系统朗读入口。
- `edge_tts.rs` 从过期的 Sec-MS-GEC v1 迁移到 v2（CS64 + 定制 SHA-256，`2-143.0.3650.75`），对齐仓库 Windows 已有实现和 [edge-tts 上游算法](https://github.com/rany2/edge-tts/blob/master/src/edge_tts/drm.py)。保留现有最小握手与 MP3 输出；HTTP 错误不再无依据地归因于用户时钟。
- 只播放自检可用 `--ita-playback-selftest` 启动，不采集麦克风；原有录音自检保持单独模式。超时会停止旧播放，防止污染下一次对照。

## 验证证据

| 验证 | 结果 |
|---|---|
| Edge 真实握手 A/B，同一时刻和 UA | v1 HTTP 403；v2 HTTP 101；服务器时间差 0–1 秒 |
| Edge Rust 离线测试 | 6 项通过 |
| Edge 真实中文合成 | 21,168 字节，验证 MP3 帧头 |
| Edge 真实英文合成 | 21,456 字节，验证 MP3 帧头 |
| v2 算法独立对照上游 Python | 600 个 7–699 字节输入全部一致，覆盖多块 padding / 奇偶 CS64 边界 |
| `npm run playback:test` | 12 项，恢复顺序/失败/缓存/停止/中断/WebKit 类型/录音会话保护 |
| `npm run audio:test` | 17 项采集、重采样与 teardown 回归 |
| `npm run recording:test` | 7 项失败与恢复回归 |
| `npm run smoke` | 18 项主流程断言 |
| TypeScript / Vite | 通过，保留既有体积与分块警告 |
| iOS target Cargo 检查 | 通过 |

播放脚本使用受控替身验证控制流，不能验证物理发声。上游 WebKit 的 [DOMAudioSession](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/audiosession/DOMAudioSession.cpp) 和 [AudioSessionIOS](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/ios/AudioSessionIOS.mm) 支持 Playback 类别覆盖的设置与保持逻辑。

## 真机部署与资料保护

继续使用开发团队签名、相同 bundle id `com.kobejiasuoer.reader` 的独立 release 包，ASCII 可执行名 `immersive-speaking`、中文显示名「沉浸口语」。保留此前新增的 `tauri.ios.conf.json`，不重新运行 `ios init`。没有卸载应用、没有发版、没有改账户或语音凭据。

安装前最新 Library 备份在 `/tmp/codex-mobile-audio-before-2026-11-04/Library`。最终构建与前端日志分别为 `/tmp/codex-mobile-audio-device-build-2026-11-04.log`、`/tmp/codex-mobile-audio-frontend-build-2026-11-04.log`。这些 `/tmp` 证据路径不保证长期保存。

22:24 开始最终原位安装，结果为 `/tmp/codex-mobile-audio-final-install-2026-11-04.json`。最终签名校验通过，二进制包含全部 9 个当前前端资源。更新后的 IPA 仍位于 `immersive-translator-mobile/src-tauri/gen/apple/build/arm64/沉浸口语.ipa`，SHA-256 为 `06f05054c05e6b471a9e4fef7715e784fe2f5ed052eefabbaa2a217a4d713961`。

22:26:57（Asia/Shanghai）启动最终只播放自检，22:27:19 完成：

- 录音标记为 `skipped: true`，没有采集麦克风。
- 会话实际类别 `AVAudioSessionCategoryPlayback`、路由 `Speaker`、音量 `1.00`。
- 两次朗读返回 `done`，总耗时 8,912ms / 7,939ms，对应解码音频时长 5.5s / 5.9s。
- 本次测试没有新的合成错误；诊断尾部仍含此前落盘的历史 403，不能误认为是新协议再次失败。
- 自检文件：`/tmp/codex-mobile-audio-final-selftest-2026-11-04.jsonl`。

镜像已连接，并在实际阅读页点击播放按钮，观察到播放状态切换。22:33 取回最新诊断，阅读路径额外完成了 9.3s / 8.8s / 4.5s 的句子音频，未出现本次启动后的新 TTS 403 或播放错误。数据在 `/tmp/codex-mobile-audio-final-diagnostics-2026-11-04/Library`。

用户随后明确回复「已经听到声音」，完成此次物理可听确认。此确认针对本轮触发的测试朗读或阅读播放，不扩展为全部音色、所有阅读场景、ISE 评测、蓝牙或来电恢复的验收。
