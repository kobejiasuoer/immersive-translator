# 跟读评测 Spike（临时目录）

验证「阅读室跟读评测」功能的两个技术风险点，MVP 开工前完成。
后续追加：在线合成（TTS）实调脚本。

## Spike T：讯飞在线合成实调（app 内云朗读同协议）

1. 复制 `tts_credentials.example.json` 为 `tts_credentials.json`，填讯飞控制台
   **「语音合成」应用**的三件套（已 gitignore）。注意：实测当前这套控制台凭据
   语音评测/语音合成通用（同一 APPID 可调两个服务）；若你的控制台是两个独立应用，
   则各填各的。
2. `node spike/tts_spike.mjs` —— 默认 catherine 读英文句，产出 `spike/tts_out.mp3` 试听。
   `node spike/tts_spike.mjs "自定义文本" xiaoyan` 换文本/音色。
3. 生产模块真实链路（走 `src/core/xfyunTts.ts` 同款代码，缺凭据自动跳过）：
   `XFYUN_TTS_APP_ID=… XFYUN_TTS_API_KEY=… XFYUN_TTS_API_SECRET=… npx vitest run xfyunTts.live`

> 实测（2026-09）：服务端每帧 `data.audio` 是**独立带 `=` padding 的 base64**
> （帧尾形如 `qYI=`/`VQ==`），必须逐帧解码再按字节拼接；join 后整体 `atob`
> 会抛 InvalidCharacterError。`xfyunTts.ts` 已按此实现，单测有保真 mock 钉死。

## Spike A：WebView2 里麦克风能不能录

应用里临时加了 `[SPIKE]` 标记的代码（`App.tsx`、`lib.rs`、`src/reader/SpikeMicTest.tsx`），
启动方式：

```bash
# Windows (Git Bash)
SPIKE_MIC=1 VITE_SPIKE_MIC=1 npm run tauri dev
```

阅读室窗口会自动打开并弹出验证面板：枚举权限 → getUserMedia → 录 4 秒 16k PCM →
存 WAV 到 `app_data_dir/spike_mic.wav`，全过程同时打印到终端（`[SPIKE]` 前缀）。

- **通过**：直接用 WebView 前端采集，MVP 不需要 Rust 录音。
- **被拒（NotAllowedError）**：尝试给 reader 窗口加
  `additionalBrowserArgs: "--auto-accept-camera-and-microphone-capture"`；
  再不行就转 Rust cpal/WASAPI 采集。

## Spike B：讯飞语音评测分数粒度够不够

1. 复制 `credentials.example.json` 为 `credentials.json`，填入讯飞控制台
   「语音评测」应用的 APPID / API_KEY / API_SECRET（此文件已 gitignore）。
2. 离线自检（不消耗调用次数）：`node spike/ise_spike.mjs --selftest`
3. 生成本地标准发音样本（Windows SAPI，不需要凭据）：
   `powershell -NoProfile -ExecutionPolicy Bypass -File spike/gen_tts_sample.ps1`
4. 实调评测（零依赖，Node >= 22）：
   `node spike/ise_spike.mjs spike/spike_tts.wav "The quick brown fox jumps over the lazy dog."`

通过标准：返回句级 total/accuracy/fluency/integrity 分数 + 词级 total_score/dp_message，
满足「句级过/不过判定 + 词级着色」的产品需求。

## 用量

讯飞语音评测：创建应用后 90 天内 1 万次免费调用（以控制台页面为准）。
