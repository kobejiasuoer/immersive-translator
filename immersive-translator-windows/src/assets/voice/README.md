# voice/ 语音测试样本资产

## ise-test-sample.pcm

语音页「一键测试」用的真实英文语音样本(契约 `docs/voice-cloud-implementation-contract-2026-10-28.md` §三.9):云模式下打进 ISE 验证跟读打分全链路(会耗 1 次评分额度)。

### 格式

| 项 | 值 |
| --- | --- |
| 编码 | PCM 裸流(无 WAV 头) |
| 采样率 | 16000 Hz |
| 位深 | 16 bit(有符号小端 int16) |
| 声道 | 1(单声道) |
| 字节率 | 32000 B/s |
| 精确字节数 | **54240**(27120 个采样点) |
| 时长 | **1695 ms**(1.695 s,契约要求 1-2 s / 32-64 KB) |
| 内容 | 固定英文句 "The quick brown fox jumps over the lazy dog." |
| 音色 | Microsoft Zira Desktop(en-US,SAPI 本地引擎) |

### 生成方式

Windows SAPI 本地合成(PowerShell + System.Speech 托管封装),产出 16kHz/16bit/单声道 WAV 后剥离头部:

```powershell
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Zira Desktop')
$s.Rate = 6   # 0=自然语速约 3.3s 超契约上限,6 压到 1.695s
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono)   # 等价 SAPI SAFT16kHz16BitMono
$s.SetOutputToWaveFile($wavPath, $fmt)
$s.Speak('The quick brown fox jumps over the lazy dog.')
```

**注意:头部实为 46 字节,不是 44。** SAPI 写出的 `fmt ` 块带 2 字节 `cbSize` 扩展(18 字节负载),`data` 块从偏移 46 开始。剥离头部前必须逐 chunk 解析找到 `data` 块偏移,勿盲剥 44(会留下 2 字节脏数据、错位 1 个采样点)。本文件已按解析出的偏移正确剥离,可直接当裸 PCM 使用。

### 替换

后续可由服务端云 TTS 样本**原格式替换**(同路径同名,仍为 16k/16bit/单声道裸 PCM,时长保持 1-2 s),消费方(`src/lib/voice/` VoiceClient 一键测试)不感知来源。
