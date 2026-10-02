import AVFoundation
import AppKit
import CoreAudio
import AudioToolbox

/// 跟读 / 口语麦克风设备偏好（对齐 Windows localStorage "immersive-translator-mic-device"）：
/// 机器本地 UserDefaults，不随文章、不进 reader 设置 schema。
enum MicDevicePreference {
    static let key = "readerMicDeviceUID"

    /// 空串表示「系统默认」。
    static var savedUID: String {
        UserDefaults.standard.string(forKey: key) ?? ""
    }

    static func save(_ uid: String) {
        UserDefaults.standard.set(uid, forKey: key)
    }

    /// 录音入口用：空串视为未选，传 nil 走系统默认。
    static var selectedUID: String? {
        let uid = savedUID
        return uid.isEmpty ? nil : uid
    }
}

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
    /// deviceUID 非空时先绑定偏好设备再建格式/convert/tap（换设备后输入格式会变，
    /// 顺序是硬约束）；绑定失败回退系统默认（对齐 Windows OverconstrainedError 回退）。
    static func start(
        deviceUID: String? = nil,
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
        // 偏好设备绑定必须在读 inputFormat 之前（每次 start 新建 engine，无运行中切设备问题）。
        if let deviceUID, !deviceUID.isEmpty {
            _ = bindInputDevice(recorder.engine, deviceUID: deviceUID)
        }
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

    // MARK: - 设备枚举与绑定（CoreAudio；mac 无 WebRTC 的 {exact: deviceId}，走 AUHAL CurrentDevice）

    /// 枚举系统输入设备（对齐 Windows listMicDevices 挂载时枚举）。
    /// CoreAudio 一趟枚举同时拿 uid/name/deviceID；仅枚举不触发麦克风权限弹窗。
    /// 有输入流（kAudioDevicePropertyStreams, scope Input）的才算输入设备。
    static func availableMicDevices() -> [(uid: String, name: String, deviceID: AudioDeviceID)] {
        var devicesAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        let systemObject = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(systemObject, &devicesAddress, 0, nil, &size) == noErr, size > 0 else {
            return []
        }
        var deviceIDs = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(systemObject, &devicesAddress, 0, nil, &size, &deviceIDs) == noErr else {
            return []
        }

        var devices: [(uid: String, name: String, deviceID: AudioDeviceID)] = []
        for deviceID in deviceIDs {
            var streamsAddress = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyStreams,
                mScope: kAudioObjectPropertyScopeInput,
                mElement: kAudioObjectPropertyElementMain
            )
            var streamsSize: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(deviceID, &streamsAddress, 0, nil, &streamsSize) == noErr,
                  streamsSize > 0 else { continue }
            guard let name = stringProperty(deviceID, selector: kAudioObjectPropertyName),
                  let uid = stringProperty(deviceID, selector: kAudioDevicePropertyDeviceUID) else { continue }
            devices.append((uid: uid, name: name, deviceID: deviceID))
        }
        return devices
    }

    private static func stringProperty(_ objectID: AudioObjectID, selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(objectID, &address, 0, nil, &size) == noErr,
              size >= UInt32(MemoryLayout<CFString?>.size) else { return nil }
        // 名称 / UID 属性都是 CFStringRef；按 CFString 引用直读。
        var value: CFString?
        let status = withUnsafeMutablePointer(to: &value) { pointer in
            AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, pointer)
        }
        guard status == noErr, let cfString = value else { return nil }
        return cfString as String
    }

    /// 把 engine 输入节点（AUHAL）绑到指定 UID 的设备。落盘的是 UID 字符串，
    /// AudioDeviceID 每次按 UID 重新枚举（设备可被拔/换，不宜落盘）。
    /// 失败记一条诊断并返回 false，由调用方回退系统默认。
    @discardableResult
    static func bindInputDevice(_ engine: AVAudioEngine, deviceUID: String) -> Bool {
        guard let device = availableMicDevices().first(where: { $0.uid == deviceUID }) else {
            DiagnosticLogger.log("mic.bind.device-not-found uid=\(deviceUID)")
            return false
        }
        guard let audioUnit = engine.inputNode.audioUnit else {
            DiagnosticLogger.log("mic.bind.audio-unit-unavailable")
            return false
        }
        var deviceID = device.deviceID
        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &deviceID,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )
        guard status == noErr else {
            DiagnosticLogger.log("mic.bind.set-current-device.failed status=\(status)")
            return false
        }
        return true
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
