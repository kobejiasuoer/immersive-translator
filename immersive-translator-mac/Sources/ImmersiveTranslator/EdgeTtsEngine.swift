import Foundation
import ReaderCore
import XfyunCore

/// Edge 在线合成的 mac 引擎外观（speechEngine.ts 的对应物，与 XfyunTtsEngine 同构）。
///
/// 免费无凭据、开箱即用（isReady 恒 true）；真正的失败在 speak 时走回落
/// （ReaderPlaybackEngine.speakCloud 的 catch，语义与讯飞共用）。
///
/// 双层缓存（key = edge:voice|text，语速不入键）：
/// - L1：内存 LRU（TtsLruCache，80 条）。
/// - L2：磁盘缓存（TtsDiskCache）——与讯飞共用同一 tts-cache 目录与 3000 条淘汰
///   （对齐 Windows：两引擎共用同一 IndexedDB store）。
/// 语速策略：恒 +0% 合成，播放端 AVAudioPlayer.enableRate 变速不变调。
final class EdgeTtsEngine: @unchecked Sendable {
    static let shared = EdgeTtsEngine()

    /// 引擎当前采用的音色配置（由 VM 在设置变化时同步）。
    struct VoiceConfig: Equatable {
        var voiceZh: String = ""
        var voiceEn: String = ""

        /// 中文句不回退英文音色；英文句空配置回退中文音色再回退默认
        /// （对齐 Windows pickEdgeVoice，speechEngine.ts:220-223）。
        func voice(forChinese chinese: Bool) -> String {
            if chinese {
                return voiceZh.isEmpty ? EdgeTts.defaultVoice : voiceZh
            }
            return voiceEn.isEmpty ? (voiceZh.isEmpty ? EdgeTts.defaultVoiceEn : voiceZh) : voiceEn
        }
    }

    private let l1 = TtsLruCache()
    private let disk = TtsDiskCache()
    private var voiceConfig = VoiceConfig()
    /// 校准后的时钟偏差（秒），跨调用复用（替代 TS 的模块级 calibratedSkewSeconds）。
    private var calibratedSkewSeconds: Int?
    private let lock = NSLock()
    private let transport: EdgeTtsTransport
    private let calibrate: (Int) async -> Int?

    /// 默认参数用于生产（真传输 + 真校准）；单测注入桩 transport / calibrate。
    init(
        transport: EdgeTtsTransport = URLSessionEdgeTtsTransport(),
        calibrate: @escaping (Int) async -> Int? = { _ in await calibrateEdgeClockSkew() }
    ) {
        self.transport = transport
        self.calibrate = calibrate
    }

    /// 免费无凭据，恒可用；服务不可用属于运行期失败，走 speak 回落。
    var isReady: Bool { true }

    func updateVoiceConfig(_ config: VoiceConfig) {
        lock.lock()
        defer { lock.unlock() }
        voiceConfig = config
    }

    private func voice(forChinese chinese: Bool) -> String {
        lock.lock()
        defer { lock.unlock() }
        return voiceConfig.voice(forChinese: chinese)
    }

    private func currentSkew() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return calibratedSkewSeconds ?? 0
    }

    private func storeSkew(_ skew: Int) {
        lock.lock()
        defer { lock.unlock() }
        calibratedSkewSeconds = skew
    }

    /// 取一段文本的音频：L1 → L2 → 网络（写入双层缓存）。
    /// 重试/校准编排全部在协议层 synthesizeEdgeTts 内，这里不做 catch 重试。
    func audioData(for text: String) async throws -> Data {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw EdgeTtsError.emptyText }
        let chinese = XfyunTts.looksChinese(trimmed)
        let opts = EdgeTtsOptions(voice: voice(forChinese: chinese))
        let key = edgeCacheKey(text: trimmed, opts: opts)

        if let hit = l1.get(key) {
            disk.touch(key)
            return hit
        }
        if let hit = disk.get(key) {
            l1.set(key, hit)
            return hit
        }
        let skew = currentSkew()
        let result = try await synthesizeEdgeTts(
            text: trimmed,
            opts: opts,
            skewSeconds: skew,
            transport: transport,
            calibrate: calibrate
        )
        storeSkew(result.skewSeconds)
        l1.set(key, result.data)
        disk.put(key, result.data)
        return result.data
    }

    /// 预取下一句（播放当前句时后台拉取；命中缓存则无网络请求）。
    func prefetch(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Task.detached(priority: .utility) { [weak self] in
            _ = try? await self?.audioData(for: trimmed)
        }
    }
}
