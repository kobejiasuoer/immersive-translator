import Foundation

/// 录音直译（R4）的纯逻辑层：VAD 分句器 + 字幕段模型 + 双语导出。
/// 对齐 src/core/liveCaption.ts：
/// 分句器把连续麦克风流切成一句一句：电平起声开攒、静音超过阈值收句，
/// 超长强制断句（IAT 单句上限 60s，这里 12s 更接近口语换气）。
/// 收句即交出缓冲并复位——长录音内存不随时长增长。

/// 一个字幕段：一句原文（ASR）+ 译文（LLM）。
public struct CaptionSegment: Equatable, Identifiable {
    public enum State: String, Equatable {
        case transcribing
        case translating
        case done
        case failed
    }

    public var id: Int
    /// ASR 原文。
    public var source: String
    /// 译文；未完成为 nil。
    public var target: String?
    public var state: State
    /// Unix 毫秒。
    public var at: Int64

    public init(id: Int, source: String, target: String? = nil, state: State, at: Int64) {
        self.id = id
        self.source = source
        self.target = target
        self.state = state
        self.at = at
    }
}

/// 方向：中→英 / 英→中。
public enum CaptionDirection: String, Equatable, CaseIterable {
    case zh2en
    case en2zh

    public var label: String {
        switch self {
        case .zh2en: return "中 → 英"
        case .en2zh: return "英 → 中"
        }
    }

    public var swapped: CaptionDirection {
        self == .zh2en ? .en2zh : .zh2en
    }

    public var asrLanguage: String {
        self == .zh2en ? "zh_cn" : "en_us"
    }

    public var targetLabel: String {
        self == .zh2en ? "英文" : "简体中文"
    }
}

/// 字幕翻译的系统提示（句级、只出译文、容忍 ASR 错词）。
public func buildCaptionSystemPrompt(direction: CaptionDirection) -> String {
    let target = direction.targetLabel
    return [
        "你是同声传译引擎。把用户消息里的原句翻译成\(target)。",
        "规则：只输出译文，不要解释；保留数字、专名与语气；",
        "原句来自语音识别，可能有错词或没有标点，按上下文合理理解与断句；",
        "句子不完整时也照翻已说出的部分。",
    ].joined()
}

// MARK: - VAD 分句器

public struct SegmenterOptions {
    /// 起声电平绝对下限；实际阈值 = max(下限, 运行时底噪 × 2.8)。
    public var speechLevel: Float = 0.005
    /// 静音判定电平绝对下限（历史选项保留；静音收句走「距上次出声时长」）。
    public var silenceLevel: Float = 0.0025
    /// 收句静音时长（毫秒）。
    public var silenceMs: Double = 900
    /// 最短成句时长（毫秒），太短的杂音不成句。
    public var minMs: Double = 600
    /// 强制断句上限（毫秒）。
    public var maxMs: Double = 12_000

    public init(
        speechLevel: Float = 0.005,
        silenceLevel: Float = 0.0025,
        silenceMs: Double = 900,
        minMs: Double = 600,
        maxMs: Double = 12_000
    ) {
        self.speechLevel = speechLevel
        self.silenceLevel = silenceLevel
        self.silenceMs = silenceMs
        self.minMs = minMs
        self.maxMs = maxMs
    }
}

/// 起声阈值相对底噪的倍率与封顶（与跟读评测的 VAD 同一套经验值）。
/// 底噪只采信低于当前阈值的电平——说话块不抬高底噪；封顶保证一开口
/// 就是说话（前面没有静音块）时也能立刻起句。
let segmenterSpeechFloorRatio: Float = 2.8
let segmenterSpeechLevelCeiling: Float = 0.05

/// 流式分句状态机：push(块, 电平, 采样率) → 收句时返回整句 PCM，否则 nil。
/// 静音段不缓冲；收句后缓冲清零。线程安全性由调用方保证（单回调队列）。
public final class LiveSegmenter {
    private let opts: SegmenterOptions
    private var buffer: [[Float]] = []
    private var bufferedSamples = 0
    private var started = false
    private var lastVoiceMs: Double = 0
    private var elapsedMs: Double = 0
    /// 运行时底噪估计（快速下探、缓慢上浮）；nil = 还没收到电平。
    private var floor: Float?

    public init(options: SegmenterOptions = SegmenterOptions()) {
        self.opts = options
    }

    /// 是否正在攒一句（供 UI 显示「正在听」）。
    public var speaking: Bool { started }

    /// 当前起声阈值：max(绝对下限, 底噪 × 倍率)，封顶防阈值被说话电平顶飞。
    private var speechLevel: Float {
        let f = floor ?? 0
        return min(segmenterSpeechLevelCeiling, max(opts.speechLevel, f * segmenterSpeechFloorRatio))
    }

    /// 推入一块 16k PCM 与平滑电平；收句返回整句，否则 nil。
    public func push(chunk: [Float], level: Float, sampleRate: Double = 16_000) -> [Float]? {
        elapsedMs += Double(chunk.count) / sampleRate * 1000
        let threshold = speechLevel
        if level < threshold {
            floor = floor == nil ? level : min(level, floor! * 1.05)
        }
        if !started {
            if level < threshold { return nil }  // 静音段不缓冲
            started = true
            lastVoiceMs = elapsedMs
        }
        buffer.append(chunk)
        bufferedSamples += chunk.count
        if level >= threshold {
            lastVoiceMs = elapsedMs
        }

        if elapsedMs - lastVoiceMs >= opts.silenceMs {
            // 静音收句：说够最短时长才成句，太短的杂音丢弃
            return lastVoiceMs >= opts.minMs ? take() : reset()
        }
        if elapsedMs >= opts.maxMs {
            return take()
        }
        return nil
    }

    /// 主动收句（停止录音时把攒着的半句交出来）；没攒返回 nil。
    public func flush() -> [Float]? {
        guard started else { return nil }
        return take()
    }

    @discardableResult
    private func reset() -> [Float]? {
        buffer = []
        bufferedSamples = 0
        started = false
        lastVoiceMs = 0
        elapsedMs = 0
        return nil
    }

    private func take() -> [Float]? {
        guard bufferedSamples > 0 else { return reset() }
        var out = [Float]()
        out.reserveCapacity(bufferedSamples)
        for c in buffer { out.append(contentsOf: c) }
        reset()
        return out
    }
}

// MARK: - 双语导出

public struct CaptionExportMeta {
    public var direction: CaptionDirection
    /// Unix 毫秒。
    public var startedAt: Int64
    public var endedAt: Int64

    public init(direction: CaptionDirection, startedAt: Int64, endedAt: Int64) {
        self.direction = direction
        self.startedAt = startedAt
        self.endedAt = endedAt
    }
}

public func captionFileName(now: Int64 = Int64(Date().timeIntervalSince1970 * 1000), ext: String = "md") -> String {
    let date = Date(timeIntervalSince1970: Double(now) / 1000)
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd-HHmm"
    return "录音直译-\(f.string(from: date)).\(ext)"
}

/// 双语对照 Markdown：一句原文 + 缩进译文。
public func buildCaptionMarkdown(_ segments: [CaptionSegment], meta: CaptionExportMeta) -> String {
    let date = Date(timeIntervalSince1970: Double(meta.startedAt) / 1000)
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd HH:mm"
    let mins = max(1, Int((Double(meta.endedAt - meta.startedAt) / 60_000).rounded()))
    var lines = [
        "# 录音直译 · \(f.string(from: date))",
        "",
        "方向：\(meta.direction.label) · 时长约 \(mins) 分钟 · \(segments.count) 句",
        "",
    ]
    for seg in segments {
        let source = seg.source.trimmingCharacters(in: .whitespacesAndNewlines)
        if source.isEmpty { continue }
        lines.append("- \(source)")
        if let target = seg.target?.trimmingCharacters(in: .whitespacesAndNewlines), !target.isEmpty {
            lines.append("  - \(target)")
        }
    }
    return lines.joined(separator: "\n") + "\n"
}

/// 双语对照纯文本：原文一行、译文一行、空行分隔。
public func buildCaptionPlainText(_ segments: [CaptionSegment], meta: CaptionExportMeta) -> String {
    var blocks = ["录音直译（\(meta.direction.label)）"]
    for seg in segments {
        let source = seg.source.trimmingCharacters(in: .whitespacesAndNewlines)
        if source.isEmpty { continue }
        blocks.append(source)
        if let target = seg.target?.trimmingCharacters(in: .whitespacesAndNewlines), !target.isEmpty {
            blocks.append(target)
        }
    }
    return blocks.joined(separator: "\n\n") + "\n"
}
