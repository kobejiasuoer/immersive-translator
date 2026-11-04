import AudioToolbox
import AVFoundation
import Foundation

// ---------------------------------------------------------------------------
// 沉浸云网关朗读 · mp3 分片流式播放（规格 §四差异 3：Windows WebView2 走 MSE——
// 首个分片 append 即 play、后续分片按序追加、onEnd 才 endOfStream；macOS 无 MSE，
// 等价落法 = AudioFileStream 逐片解析 mp3 帧 → AVAudioConverter 解码 PCM →
// AVAudioPlayerNode 排队播放，AVAudioUnitTimePitch 变速保调（对齐
// el.preservesPitch = true + playbackRate）。
//
// 用户可见行为与 Windows createGatewayStreamingEngine 对齐：
// - 首个可解码分片到达即开播（onStarted）；分片严格按到达序排队；
// - finish()（合成 end）后排空解码器尾帧，全部缓冲播完才 onEnded；
// - 合成结束仍无任何音频 → 「云端合成返回空音频」失败；
// - stop() 立即打断（不再回调任何事件）。
// 隐私：仅内存流转，不落盘。
// ---------------------------------------------------------------------------

/// 流式播放失败（非网关协议错误：解码/音频设备/空音频）。文案与 Windows 同句。
struct GatewayStreamPlaybackError: LocalizedError, Equatable {
    let reason: String

    var errorDescription: String? { reason }

    /// 合成正常结束但没有任何可播音频（Windows「云端合成返回空音频」）。
    static let emptyAudio = GatewayStreamPlaybackError(reason: "云端合成返回空音频")
}

// MARK: - mp3 分片解码器（AudioFileStream + AVAudioConverter，纯内存）

/// mp3 字节流 → PCM 缓冲（按到达序）。非线程安全：调用方保证在同一串行队列上调用。
final class Mp3StreamDecoder {
    /// 解码出的 PCM 缓冲（按序；首个缓冲的 format 即播放图的格式）。
    var onBuffer: ((AVAudioPCMBuffer) -> Void)?

    private var streamID: AudioFileStreamID?
    private var inputFormat: AVAudioFormat?
    private var outputFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var maxPacketSize: UInt32 = 0
    private var framesPerPacket: AVAudioFrameCount = 1152
    private(set) var producedFrames: AVAudioFramePosition = 0
    private(set) var failure: Error?

    init() {
        let selfPointer = Unmanaged.passUnretained(self).toOpaque()
        var id: AudioFileStreamID?
        let status = AudioFileStreamOpen(
            selfPointer,
            { clientData, streamID, propertyID, _ in
                let decoder = Unmanaged<Mp3StreamDecoder>.fromOpaque(clientData).takeUnretainedValue()
                decoder.handleProperty(streamID: streamID, propertyID: propertyID)
            },
            { clientData, numberBytes, numberPackets, inputData, packetDescriptions in
                let decoder = Unmanaged<Mp3StreamDecoder>.fromOpaque(clientData).takeUnretainedValue()
                decoder.handlePackets(
                    numberBytes: numberBytes,
                    numberPackets: numberPackets,
                    inputData: inputData,
                    packetDescriptions: packetDescriptions
                )
            },
            kAudioFileMP3Type,
            &id
        )
        if status == noErr {
            streamID = id
        } else {
            failure = GatewayStreamPlaybackError(reason: "云端音频解析初始化失败（\(status)）")
        }
    }

    deinit {
        close()
    }

    /// 喂入一个网关分片（任意切分边界；不足一帧的尾巴由 AudioFileStream 暂存到下一片）。
    func feed(_ data: Data) {
        guard let streamID, failure == nil, !data.isEmpty else { return }
        let status = data.withUnsafeBytes { raw -> OSStatus in
            guard let base = raw.baseAddress else { return noErr }
            return AudioFileStreamParseBytes(streamID, UInt32(raw.count), base, [])
        }
        if status != noErr, failure == nil {
            failure = GatewayStreamPlaybackError(reason: "云端音频解析失败（\(status)）")
        }
    }

    /// 合成结束：排空解码器内部缓存的尾帧（mp3 解码有固有延迟）。
    func drain() {
        guard failure == nil, let converter, let outputFormat else { return }
        while true {
            guard let pcm = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: 4096) else { return }
            var error: NSError?
            let status = converter.convert(to: pcm, error: &error) { _, outStatus in
                outStatus.pointee = .endOfStream
                return nil
            }
            if status == .error {
                failure = error ?? GatewayStreamPlaybackError(reason: "云端音频解码失败")
                return
            }
            if pcm.frameLength > 0 {
                emit(pcm)
            }
            if status == .endOfStream || pcm.frameLength == 0 {
                return
            }
        }
    }

    func close() {
        if let streamID {
            AudioFileStreamClose(streamID)
        }
        streamID = nil
    }

    // MARK: AudioFileStream 回调

    private func handleProperty(streamID: AudioFileStreamID, propertyID: AudioFileStreamPropertyID) {
        guard propertyID == kAudioFileStreamProperty_ReadyToProducePackets, converter == nil else { return }
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        guard AudioFileStreamGetProperty(streamID, kAudioFileStreamProperty_DataFormat, &size, &asbd) == noErr,
              let input = AVAudioFormat(streamDescription: &asbd),
              let output = AVAudioFormat(
                standardFormatWithSampleRate: asbd.mSampleRate,
                channels: max(1, asbd.mChannelsPerFrame)
              ),
              let created = AVAudioConverter(from: input, to: output) else {
            failure = GatewayStreamPlaybackError(reason: "云端音频格式不受支持")
            return
        }
        var upper: UInt32 = 0
        var upperSize = UInt32(MemoryLayout<UInt32>.size)
        if AudioFileStreamGetProperty(streamID, kAudioFileStreamProperty_PacketSizeUpperBound, &upperSize, &upper) == noErr {
            maxPacketSize = upper
        }
        if asbd.mFramesPerPacket > 0 {
            framesPerPacket = asbd.mFramesPerPacket
        }
        inputFormat = input
        outputFormat = output
        converter = created
    }

    private func handlePackets(
        numberBytes: UInt32,
        numberPackets: UInt32,
        inputData: UnsafeRawPointer,
        packetDescriptions: UnsafeMutablePointer<AudioStreamPacketDescription>?
    ) {
        guard failure == nil, numberPackets > 0, numberBytes > 0,
              let inputFormat, let outputFormat, let converter,
              let descriptions = packetDescriptions else { return }
        var largest = maxPacketSize
        for index in 0..<Int(numberPackets) {
            largest = max(largest, descriptions[index].mDataByteSize)
        }
        let compressed = AVAudioCompressedBuffer(
            format: inputFormat,
            packetCapacity: AVAudioPacketCount(numberPackets),
            maximumPacketSize: Int(max(1, largest))
        )
        compressed.data.copyMemory(from: inputData, byteCount: Int(numberBytes))
        compressed.byteLength = numberBytes
        compressed.packetCount = AVAudioPacketCount(numberPackets)
        if let target = compressed.packetDescriptions {
            for index in 0..<Int(numberPackets) {
                target[index] = descriptions[index]
            }
        }
        let capacity = AVAudioFrameCount(numberPackets) * framesPerPacket
        guard let pcm = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: max(capacity, 1)) else { return }
        var provided = false
        var error: NSError?
        let status = converter.convert(to: pcm, error: &error) { _, outStatus in
            if provided {
                outStatus.pointee = .noDataNow
                return nil
            }
            provided = true
            outStatus.pointee = .haveData
            return compressed
        }
        if status == .error {
            failure = error ?? GatewayStreamPlaybackError(reason: "云端音频解码失败")
            return
        }
        if pcm.frameLength > 0 {
            emit(pcm)
        }
    }

    private func emit(_ pcm: AVAudioPCMBuffer) {
        producedFrames += AVAudioFramePosition(pcm.frameLength)
        onBuffer?(pcm)
    }
}

// MARK: - 流式播放器（AVAudioEngine + PlayerNode + TimePitch）

/// 网关朗读一句的流式播放器（一句一个实例；stop 后作废）。线程：append/finish 可在
/// 任意线程调用（内部串行队列保序）；回调一律回主线程。
final class GatewayStreamPlayer {
    /// 首个音频缓冲开始播放（Windows el.play() resolve 的等价时刻）。
    var onStarted: (() -> Void)?
    /// 全部音频播完（Windows el.onended）。
    var onEnded: (() -> Void)?
    /// 解码 / 音频设备 / 空音频失败（首片前后都可能；调用方按 started 区分启动失败与异步失败）。
    var onError: ((Error) -> Void)?

    private let queue = DispatchQueue(label: "local.immersive-translator.gateway-tts-player")
    private let rate: Float
    private let decoder: Mp3StreamDecoder
    private var engine: AVAudioEngine?
    private var node: AVAudioPlayerNode?
    private var outstanding = 0
    private var scheduledAny = false
    private var started = false
    private var finished = false
    private var settled = false
    /// 打断标志（主线程 stop 写、串行队列与主线程回调读；锁保护，不阻塞主线程等队列）。
    private let stopLock = NSLock()
    private var stoppedFlag = false
    private var stopped: Bool {
        stopLock.lock()
        defer { stopLock.unlock() }
        return stoppedFlag
    }

    /// rate：变速倍率（调用方按阅读语速钳制）；TimePitch 保持音高。
    init(rate: Float) {
        self.rate = rate
        self.decoder = Mp3StreamDecoder()
        decoder.onBuffer = { [weak self] buffer in
            self?.schedule(buffer)
        }
    }

    /// 追加一个 mp3 分片（按调用顺序解码排队）。
    func append(_ chunk: Data) {
        queue.async { [weak self] in
            guard let self, !self.stopped, !self.settled else { return }
            self.decoder.feed(chunk)
            self.checkDecoderFailure()
        }
    }

    /// 合成结束（end 帧）：排空解码尾帧，全部播完后 onEnded；无音频则空音频失败。
    func finish() {
        queue.async { [weak self] in
            guard let self, !self.stopped, !self.settled else { return }
            self.decoder.drain()
            self.checkDecoderFailure()
            guard !self.settled else { return }
            self.finished = true
            self.checkEnded()
        }
    }

    /// 立即打断（此后不再回调任何事件）。
    func stop() {
        stopLock.lock()
        stoppedFlag = true
        stopLock.unlock()
        // 播放图只在串行队列上读写（buildGraph 也在队列里），停机同样排进队列。
        queue.async { [self] in
            node?.stop()
            engine?.stop()
            decoder.close()
        }
    }

    // MARK: 内部（串行队列）

    private func schedule(_ buffer: AVAudioPCMBuffer) {
        guard !stopped, !settled else { return }
        if engine == nil {
            do {
                try buildGraph(format: buffer.format)
            } catch {
                fail(error)
                return
            }
        }
        guard let node else { return }
        outstanding += 1
        scheduledAny = true
        node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            self?.queue.async {
                guard let self, !self.stopped, !self.settled else { return }
                self.outstanding -= 1
                self.checkEnded()
            }
        }
        if !started {
            started = true
            node.play()
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.isStopped else { return }
                self.onStarted?()
            }
        }
    }

    private var isStopped: Bool { stopped }

    private func buildGraph(format: AVAudioFormat) throws {
        let engine = AVAudioEngine()
        let node = AVAudioPlayerNode()
        let timePitch = AVAudioUnitTimePitch()
        timePitch.rate = rate
        engine.attach(node)
        engine.attach(timePitch)
        engine.connect(node, to: timePitch, format: format)
        engine.connect(timePitch, to: engine.mainMixerNode, format: format)
        engine.prepare()
        try engine.start()
        self.engine = engine
        self.node = node
    }

    private func checkDecoderFailure() {
        if let failure = decoder.failure {
            fail(failure)
        }
    }

    private func checkEnded() {
        guard finished, outstanding == 0, !settled, !stopped else { return }
        settled = true
        if !scheduledAny {
            deliverError(GatewayStreamPlaybackError.emptyAudio)
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.isStopped else { return }
            self.onEnded?()
        }
    }

    private func fail(_ error: Error) {
        guard !settled, !stopped else { return }
        settled = true
        node?.stop()
        engine?.stop()
        deliverError(error)
    }

    private func deliverError(_ error: Error) {
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.isStopped else { return }
            self.onError?(error)
        }
    }
}
