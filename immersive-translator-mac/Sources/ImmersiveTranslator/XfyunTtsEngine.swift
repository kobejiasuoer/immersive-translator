import Foundation
import AVFoundation
import CryptoKit
import ReaderCore
import XfyunCore

/// 讯飞云 TTS 的 mac 引擎外观（speechEngine.ts + ttsDiskCache.ts 的对应物）。
///
/// 双层缓存（key = vcn|volume|text，语速不入键）：
/// - L1：内存 LRU（TtsLruCache，80 条）。
/// - L2：磁盘缓存（Application Support/ImmersiveTranslator/tts-cache/，3000 条上限，
///   超限按访问时间淘汰最旧）——重听/领读/预取不烧每日 500 次免费额度，
///   且应用重启后仍命中。
/// 语速策略：恒 1× 合成，播放端 AVAudioPlayer.enableRate 变速不变调。
final class XfyunTtsEngine {
    static let shared = XfyunTtsEngine()

    /// 引擎当前采用的音色配置（由 VM 在设置变化时同步）。
    struct VoiceConfig: Equatable {
        var vcnCn: String = ""
        var vcnEn: String = "catherine"

        func vcn(forChinese chinese: Bool) -> String {
            if chinese {
                return vcnCn.isEmpty ? XfyunTts.defaultVcn : vcnCn
            }
            return vcnEn.isEmpty ? (vcnCn.isEmpty ? XfyunTts.defaultVcnEn : vcnCn) : vcnEn
        }
    }

    private let l1 = TtsLruCache()
    private let disk: TtsDiskCache
    private var voiceConfig = VoiceConfig()
    private let lock = NSLock()

    private init() {
        self.disk = TtsDiskCache()
    }

    var isReady: Bool {
        XfyunCredentialsStore.shared.isComplete(.tts)
    }

    func updateVoiceConfig(_ config: VoiceConfig) {
        lock.lock()
        defer { lock.unlock() }
        voiceConfig = config
    }

    /// 凭据更新后失效内存缓存标记（下次合成读取新凭据）。
    func invalidateCredentials() {
        // 凭据从 Keychain 实时读取，无需失效缓存内容；保留入口对齐 Windows 广播语义。
    }

    func vcn(forChinese chinese: Bool) -> String {
        lock.lock()
        defer { lock.unlock() }
        return voiceConfig.vcn(forChinese: chinese)
    }

    /// 取一段文本的音频：L1 → L2 → 网络（写入双层缓存）。
    func audioData(for text: String) async throws -> Data {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw XfyunTtsError.emptyText }
        let chinese = XfyunTts.looksChinese(trimmed)
        let opts = XfyunTtsOptions(vcn: vcn(forChinese: chinese))
        let key = ttsCacheKey(text: trimmed, opts: opts)

        if let hit = l1.get(key) {
            disk.touch(key)
            return hit
        }
        if let hit = disk.get(key) {
            l1.set(key, hit)
            return hit
        }
        guard let creds = XfyunCredentialsStore.shared.creds(for: .tts) else {
            throw XfyunSessionError.business(code: -1, message: "讯飞合成凭据未配置（设置 → 语音）")
        }
        let data = try await synthesizeXfyunTts(text: trimmed, opts: opts, creds: creds)
        l1.set(key, data)
        disk.put(key, data)
        return data
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

/// L2 磁盘缓存：tts-cache/<sha256(key)>.mp3 + <同名>.meta（访问时间）。
/// 上限 3000 条（对齐 Windows IndexedDB 3000 条/200MB），超限按访问时间淘汰。
final class TtsDiskCache {
    private let directory: URL
    private let queue = DispatchQueue(label: "local.immersive-translator.tts.disk", qos: .utility)
    static let entryLimit = 3000

    init(baseDirectory: URL? = nil) {
        let base = baseDirectory
            ?? FileManager.default
                .urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
                .appendingPathComponent("ImmersiveTranslator", isDirectory: true)
        self.directory = base.appendingPathComponent("tts-cache", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private func fileURL(for key: String) -> URL {
        let digest = sha256Hex(key)
        return directory.appendingPathComponent(digest + ".mp3")
    }

    func get(_ key: String) -> Data? {
        queue.sync {
            let url = fileURL(for: key)
            guard let data = try? Data(contentsOf: url) else { return nil }
            touchLocked(key)
            return data
        }
    }

    func put(_ key: String, _ data: Data) {
        queue.sync {
            let url = fileURL(for: key)
            try? data.write(to: url, options: .atomic)
            // 访问时间文件（内容 = unix 秒）
            let meta = directory.appendingPathComponent(url.lastPathComponent + ".at")
            try? Data(String(Int(Date().timeIntervalSince1970)).utf8).write(to: meta, options: .atomic)
            evictIfNeededLocked()
        }
    }

    /// 刷新访问时间（缓存命中时）。
    func touch(_ key: String) {
        queue.sync {
            touchLocked(key)
        }
    }

    private func touchLocked(_ key: String) {
        let url = fileURL(for: key)
        let meta = directory.appendingPathComponent(url.lastPathComponent + ".at")
        try? Data(String(Int(Date().timeIntervalSince1970)).utf8).write(to: meta, options: .atomic)
    }

    private func evictIfNeededLocked() {
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.contentModificationDateKey]
        ) else { return }
        let mp3s = entries.filter { $0.pathExtension == "mp3" }
        guard mp3s.count > Self.entryLimit else { return }
        struct Entry {
            var url: URL
            var accessedAt: Date
        }
        var list: [Entry] = []
        for url in mp3s {
            let meta = directory.appendingPathComponent(url.lastPathComponent + ".at")
            var date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            if let text = try? String(contentsOf: meta, encoding: .utf8), let t = Double(text) {
                date = Date(timeIntervalSince1970: t)
            }
            list.append(Entry(url: url, accessedAt: date))
        }
        list.sort { $0.accessedAt < $1.accessedAt }
        let excess = list.count - Self.entryLimit
        for entry in list.prefix(excess) {
            try? FileManager.default.removeItem(at: entry.url)
            let meta = directory.appendingPathComponent(entry.url.lastPathComponent + ".at")
            try? FileManager.default.removeItem(at: meta)
        }
    }
}

func sha256Hex(_ text: String) -> String {
    let digest = SHA256.hash(data: Data(text.utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
}
