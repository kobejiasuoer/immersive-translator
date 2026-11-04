import Foundation

// ---------------------------------------------------------------------------
// 录音 PCM → 网关要求的 16k/16bit/单声道（base64）。
// 对齐 Windows src/lib/voice/resample.ts（隐私红线：只在内存转换，绝不落盘缓存）。
//
// Mac 采集链路差异（规格 §四差异 5）：MicRecorder 的 AVAudioConverter 目标格式
// 已是 16k/1ch Float32（MicRecorder.swift targetFormat 16_000），生产调用恒走
// 16k 直通分支，本层实质只做对称量化 + base64。非 16k 输入的线性插值重采样
// 仍按 Windows core/micRecorder resamplePcmTo16k 逐行移植保留（防御性分支：
// 将来接入非 16k 采集源时数值口径与 Windows 一致，不静默按错误时长上传）。
// ---------------------------------------------------------------------------

private let base64Alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")

/// Float32 [-1,1] → Int16（对称量化：+1 顶格 32767，-1 顶格 -32768，四舍五入）。
/// 舍入与精度口径与 JS 逐位一致：Float32 值升 Double 后乘（JS number 语义），
/// Math.round 的 half 向上取整 = floor(x+0.5)。
func float32ToInt16(_ input: [Float]) -> [Int16] {
    var out = [Int16](repeating: 0, count: input.count)
    for (i, sample) in input.enumerated() {
        // NaN：JS 侧 Math.round(NaN) 写入 Int16Array 落 0（Swift min/max 遇 NaN 会顶格）。
        if sample.isNaN { continue }
        let s = Double(max(-1, min(1, sample)))
        let scaled = s < 0 ? s * 32768.0 : s * 32767.0
        out[i] = Int16((scaled + 0.5).rounded(.down))
    }
    return out
}

/// 任意采样率 Float32 → 16k Float32 线性插值（逐行移植 Windows core/micRecorder.ts
/// resamplePcmTo16k；16k 输入原样直通）。Float32 存储、Double 运算，与 JS
/// Float32Array 读写 + number 运算同口径。
func resamplePcmTo16k(_ input: [Float], inputRate: Int) -> [Float] {
    if inputRate == 16000 { return input }
    // 非法采样率（JS 侧会抛 RangeError）：防御性原样返回，消费方已先行拦截 ≤0。
    guard inputRate > 0 else { return input }
    if input.isEmpty { return [] }
    let ratio = Double(inputRate) / 16000.0
    let count = Int((Double(input.count) / ratio).rounded(.down))
    var out = [Float](repeating: 0, count: count)
    for i in 0..<count {
        let pos = Double(i) * ratio
        let i0 = Int(pos.rounded(.down))
        let i1 = min(i0 + 1, input.count - 1)
        let frac = pos - Double(i0)
        out[i] = Float(Double(input[i0]) * (1 - frac) + Double(input[i1]) * frac)
    }
    return out
}

/// Int16 数组 → 小端字节序 Data（流式 ASR binary 帧 / REST base64 共用）。
func int16LEBytes(_ input: [Int16]) -> Data {
    var data = Data(capacity: input.count * 2)
    for v in input {
        withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) }
    }
    return data
}

/// 纯手写 base64（不依赖 Data(base64Encoded:) 的平台行为，RFC 4648 向量对齐
/// Windows bytesToBase64 的查表实现；3 字节 → 4 字符）。
func bytesToBase64(_ bytes: Data) -> String {
    var parts: [String] = []
    parts.reserveCapacity((bytes.count + 2) / 3)
    let byteArray = [UInt8](bytes)
    var i = 0
    while i < byteArray.count {
        let b0 = byteArray[i]
        let b1 = i + 1 < byteArray.count ? byteArray[i + 1] : 0
        let b2 = i + 2 < byteArray.count ? byteArray[i + 2] : 0
        let triple = (Int(b0) << 16) | (Int(b1) << 8) | Int(b2)
        var chunk = String([
            base64Alphabet[(triple >> 18) & 0x3f],
            base64Alphabet[(triple >> 12) & 0x3f],
            base64Alphabet[(triple >> 6) & 0x3f],
            base64Alphabet[triple & 0x3f],
        ])
        if i + 1 >= byteArray.count {
            chunk = String(chunk.prefix(2)) + "=="
        } else if i + 2 >= byteArray.count {
            chunk = String(chunk.prefix(3)) + "="
        }
        parts.append(chunk)
        i += 3
    }
    return parts.joined()
}

struct Pcm16kPayload {
    /// 16k/16bit/单声道 PCM 的 base64（REST asr/ise 的 audio 字段）。
    let base64: String
    /// 重采样后时长（毫秒，16000 样本/秒口径，与服务端 pcmDurationMs 一致）。
    let durationMs: Int
}

/// Float32 任意采样率 → 16k/16bit base64 载荷（REST 上传一步到位）。
/// Mac 采集已 16k，生产恒走直通（见文件头说明）。
func pcm16kToBase64(_ input: [Float], inputRate: Int = 16000) -> Pcm16kPayload {
    let resampled = resamplePcmTo16k(input, inputRate: inputRate)
    let pcm = float32ToInt16(resampled)
    let bytes = int16LEBytes(pcm)
    return Pcm16kPayload(
        base64: bytesToBase64(bytes),
        // JS Math.round（half 向上）= floor(x + 0.5)。
        durationMs: Int((Double(resampled.count) / 16000.0 * 1000.0 + 0.5).rounded(.down))
    )
}

/// Float32 任意采样率 → 16k Int16 的原始字节（流式 ASR 的 binary 帧载荷）。
func pcm16kBytes(_ input: [Float], inputRate: Int = 16000) -> Data {
    int16LEBytes(float32ToInt16(resamplePcmTo16k(input, inputRate: inputRate)))
}
