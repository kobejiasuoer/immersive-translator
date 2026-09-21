# [SPIKE-B] 用 Windows 本地 SAPI 合成一段标准英语发音 WAV（16k/16bit/单声道），
# 作为"标准答案"音频去调讯飞评测 API，验证返回分数粒度。不依赖讯飞凭据。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File spike/gen_tts_sample.ps1 [-Text "..." ]
param(
    [string]$Text = "The quick brown fox jumps over the lazy dog."
)

Add-Type -AssemblyName System.Speech

$out = Join-Path $PSScriptRoot "spike_tts.wav"
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    16000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono)

$s = New-Object System.Speech.Synthesis.SpeechSynthesizer

# 优先选英文音色（中文音色读英文口音会偏重，但分数粒度验证不受影响）
$en = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like "en-*" -and $_.Enabled } | Select-Object -First 1
if ($en) {
    $s.SelectVoice($en.VoiceInfo.Name)
    Write-Host "voice: $($en.VoiceInfo.Name)"
} else {
    Write-Host "no en-* voice installed, using default: $($s.Voice.Name)"
}

$s.SetOutputToWaveFile($out, $fmt)
$s.Rate = 0
$s.Speak($Text)
$s.SetOutputToNull()
$s.Dispose()

Write-Host "saved: $out"
Write-Host "text : $Text"
