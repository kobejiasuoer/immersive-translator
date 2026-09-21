import AVFoundation
import AppKit

/// 麦克风录音器（跟读评测 / 口语陪练 / 录音直译共用）。
/// 对齐 src/core/micRecorder.ts 的采集链路：AVAudioEngine 输入 →
/// AVAudioConverter 重采样 16k 单声道 Float32 → 缓冲或流式 onChunk。
/// onLevel 上报平滑电平（0–1）与已录时长，驱动外层静音 VAD。

struct MicLevelEvent {
    /// 平滑电平 0–1（人声朗读通常 0.05–0.6）。
    var level: Float
    /// 已录制毫秒数。
    var elapsedMs: Int
    /// 采样率（恒 16000）。
    var sampleRate: Double = 16_000
}

enum MicRecorderError: Error, LocalizedError {
    case permissionDenied
    case noInputDevice
    case startFailed(String)

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "麦克风权限被拒绝——请在系统设置 → 隐私与安全性 → 麦克风里允许本应用"
        case .noInputDevice:
            return "找不到可用的麦克风设备"
        case .startFailed(let message):
            return "麦克风打不开：\(message)"
        }
    }
}

final class MicRecorder {
    /// 流式分块（录音直译用）；与缓冲模式二选一。
    var onChunk: (([Float], MicLevelEvent) -> Void)?
    var onLevel: ((MicLevelEvent) -> Void)?

    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private let targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    private var buffer: [Float] = []
    private var smoothedLevel: Float = 0
    private var startedAt: DispatchTime?
    private var running = false
    private let queue = DispatchQueue(label: "local.immersive-translator.mic")

    private init() {}

    /// 开始录音。返回控制句柄；失败抛 MicRecorderError。
    static func start(
        onLevel: ((MicLevelEvent) -> Void)? = nil,
        onChunk: (([Float], MicLevelEvent) -> Void)? = nil
    ) async throws -> MicRecorder {
        // 权限：macOS 14+ 有请求 API；更早版本首次 tap 会触发系统弹窗。
        if #available(macOS 14.0, *) {
            let granted = await AVAudioApplication.requestRecordPermission()
            guard granted else { throw MicRecorderError.permissionDenied }
        } else {
            guard AVCaptureDevice.authorizationStatus(for: .audio) != .denied else {
                throw MicRecorderError.permissionDenied
            }
        }

        let recorder = MicRecorder()
        recorder.onLevel = onLevel
        recorder.onChunk = onChunk

        let input = recorder.engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw MicRecorderError.noInputDevice
        }
        recorder.converter = AVAudioConverter(from: inputFormat, to: recorder.targetFormat)

        input.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { buffer, _ in
            recorder.handleInput(buffer: buffer)
        }
        recorder.engine.prepare()
        do {
            try recorder.engine.start()
        } catch {
            throw MicRecorderError.startFailed(error.localizedDescription)
        }
        recorder.running = true
        recorder.startedAt = .now()
        return recorder
    }

    private func handleInput(buffer: AVAudioPCMBuffer) {
        queue.sync {
            guard self.running else { return }
            guard let converter = self.converter else { return }

            // 重采样到 16k 单声道
            let ratio = self.targetFormat.sampleRate / buffer.format.sampleRate
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
            guard let out = AVAudioPCMBuffer(pcmFormat: self.targetFormat, frameCapacity: capacity) else { return }
            var conversionError: NSError?
            let status = converter.convert(to: out, error: &conversionError) { _, outStatus in
                outStatus.pointee = .haveData
                return buffer
            }
            guard status != .error, conversionError == nil else { return }

            let channels = out.floatChannelData![0]
            let frames = Int(out.frameLength)
            guard frames > 0 else { return }

            // RMS 电平 → 平滑（对齐 micRecorder 的 attack/release 平滑）
            var sumSq: Float = 0
            for i in 0..<frames {
                sumSq += channels[i] * channels[i]
            }
            let rms = sqrtf(sumSq / Float(frames))
            self.smoothedLevel = self.smoothedLevel * 0.6 + rms * 0.4

            let elapsedMs = Int((DispatchTime.now().uptimeNanoseconds - (self.startedAt?.uptimeNanoseconds ?? 0)) / 1_000_000)
            let event = MicLevelEvent(level: self.smoothedLevel, elapsedMs: elapsedMs)
            let samples = Array(UnsafeBufferPointer(start: channels, count: frames))
            if self.onChunk != nil {
                self.onChunk?(samples, event)
            } else {
                self.buffer.append(contentsOf: samples)
                self.onLevel?(event)
            }
        }
    }

    var isRunning: Bool {
        queue.sync { running }
    }

    /// 停止并返回 16k 单声道 Float32 PCM（[-1,1]）。流式模式返回空。
    func stop() -> [Float] {
        queue.sync {
            running = false
        }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        return queue.sync {
            defer { buffer.removeAll(keepingCapacity: false) }
            return buffer
        }
    }

    /// 放弃录音并立即释放麦克风。
    func cancel() {
        _ = stop()
    }
}
