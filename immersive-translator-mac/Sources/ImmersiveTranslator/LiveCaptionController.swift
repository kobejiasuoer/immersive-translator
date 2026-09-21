import Foundation
import ReaderCore
import XfyunCore

/// 录音直译控制器（R4）：麦克风流式分句 → 讯飞听写 → 句级流式翻译 → 双语字幕。
/// 对齐 Windows LiveCaptionApp：方向切换（录音中锁定）、最多显示 200 段、
/// 失败段保留原文、双语导出（.md / .txt 原生另存为）。

@MainActor
final class LiveCaptionController: ObservableObject {
    @Published private(set) var segments: [CaptionSegment] = []
    @Published private(set) var direction: CaptionDirection = .zh2en
    @Published private(set) var recording = false
    @Published private(set) var level: Float = 0
    @Published private(set) var speaking = false
    @Published var errorMessage: String?

    static let displayLimit = 200

    private var recorder: MicRecorder?
    private var segmenter: LiveSegmenter?
    private var nextSegmentId = 0
    private var startedAt: Int64 = 0
    private var endedAt: Int64 = 0
    // 独立实例：configuration() 每次实时读当前 Provider/Keychain，无共享状态问题。
    private let chat = ReaderChatClient(settingsStore: SettingsStore())

    var hasCredentials: Bool {
        XfyunCredentialsStore.shared.creds(for: .asr) != nil
    }

    // MARK: - 方向

    func toggleDirection() {
        guard !recording else { return }  // 录音中锁定
        direction = direction.swapped
    }

    // MARK: - 录音

    func toggleRecording() {
        if recording {
            stopRecording()
        } else {
            startRecording()
        }
    }

    private func startRecording() {
        guard hasCredentials else {
            errorMessage = "未配置听写凭据：设置 → 语音（可复用评测凭据）"
            return
        }
        errorMessage = nil
        segmenter = LiveSegmenter()
        startedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let language = direction
        Task { [weak self] in
            do {
                let asrLanguage: AsrLanguage = language == .zh2en ? .zh_cn : .en_us
                let rec = try await MicRecorder.start { [weak self] samples, event in
                    Task { @MainActor [weak self] in
                        self?.handleChunk(samples, event: event, language: asrLanguage)
                    }
                }
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    if self.recording == false, self.recorder == nil {
                        self.recorder = rec
                        self.recording = true
                    } else {
                        rec.cancel()
                    }
                }
            } catch {
                await MainActor.run { [weak self] in
                    self?.errorMessage = (error as? LocalizedError)?.errorDescription ?? "\(error)"
                }
            }
        }
        // 乐观置位：让 UI 立即进入录音态（拿不到录音器会在回调里报错并复位）。
        recording = true
    }

    private func stopRecording() {
        guard recording else { return }
        recording = false
        endedAt = Int64(Date().timeIntervalSince1970 * 1000)
        // 攒着的半句交出来
        if let half = segmenter?.flush(), !half.isEmpty {
            transcribe(samples: half)
        }
        recorder?.cancel()
        recorder = nil
        segmenter = nil
        speaking = false
        level = 0
    }

    private func handleChunk(_ samples: [Float], event: MicLevelEvent, language: AsrLanguage) {
        guard recording, let segmenter else { return }
        level = event.level
        if let sentence = segmenter.push(chunk: samples, level: event.level) {
            speaking = false
            transcribe(samples: sentence, language: language)
        } else {
            speaking = segmenter.speaking
        }
    }

    // MARK: - 听写 + 翻译

    private func transcribe(samples: [Float], language: AsrLanguage = .zh_cn) {
        guard let creds = XfyunCredentialsStore.shared.creds(for: .asr) else {
            errorMessage = "未配置听写凭据：设置 → 语音"
            return
        }
        let id = nextSegmentId
        nextSegmentId += 1
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        appendSegment(CaptionSegment(id: id, source: "", state: .transcribing, at: now))

        Task { [weak self] in
            guard let self else { return }
            do {
                let text = try await transcribeSpeech(pcm: floatToPcm16Bytes(samples), language: language, creds: creds)
                await MainActor.run {
                    self.updateSegment(id: id) { seg in
                        seg.source = text
                        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            seg.state = .done  // 空句直接完成（杂音句）
                            seg.target = nil
                        } else {
                            seg.state = .translating
                        }
                    }
                    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        self.translateSegment(id: id, source: text)
                    }
                }
            } catch {
                await MainActor.run {
                    self.updateSegment(id: id) { seg in
                        seg.source = seg.source.isEmpty ? "（识别失败）" : seg.source
                        seg.state = .failed
                    }
                    self.errorMessage = (error as? LocalizedError)?.errorDescription ?? "\(error)"
                }
            }
        }
    }

    private func translateSegment(id: Int, source: String) {
        let directionAtStart = direction
        let system = buildCaptionSystemPrompt(direction: directionAtStart)
        Task { [weak self] in
            guard let self else { return }
            do {
                let translated = try await self.chat.complete(systemPrompt: system, userText: source)
                await MainActor.run {
                    self.updateSegment(id: id) { seg in
                        guard seg.state == .translating || seg.state == .transcribing else { return }
                        seg.target = translated
                        seg.state = .done
                    }
                }
            } catch {
                await MainActor.run {
                    self.updateSegment(id: id) { seg in
                        // 失败段保留原文
                        seg.state = .failed
                    }
                }
            }
        }
    }

    private func appendSegment(_ segment: CaptionSegment) {
        segments.append(segment)
        if segments.count > Self.displayLimit {
            segments.removeFirst(segments.count - Self.displayLimit)
        }
    }

    private func updateSegment(id: Int, mutate: (inout CaptionSegment) -> Void) {
        guard let idx = segments.firstIndex(where: { $0.id == id }) else { return }
        mutate(&segments[idx])
        segments = segments  // 触发 @Published
    }

    // MARK: - 导出 / 清空

    var exportMeta: CaptionExportMeta {
        CaptionExportMeta(
            direction: direction,
            startedAt: startedAt,
            endedAt: endedAt == 0 ? Int64(Date().timeIntervalSince1970 * 1000) : endedAt
        )
    }

    func exportMarkdown() -> String {
        buildCaptionMarkdown(segments, meta: exportMeta)
    }

    func exportPlainText() -> String {
        buildCaptionPlainText(segments, meta: exportMeta)
    }

    func clearSegments() {
        guard !recording else { return }
        segments = []
        nextSegmentId = 0
        startedAt = 0
        endedAt = 0
    }
}
