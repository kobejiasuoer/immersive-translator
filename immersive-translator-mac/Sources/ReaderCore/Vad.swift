import Foundation

/// 静音检测（VAD）纯内核：判定逻辑与阈值常量的一处定义（参数与语义对齐
/// src/core/vad.ts），口语页点击开麦（SpeakViewController）与阅读室跟读评测
///（ShadowAssessController）共用——SPEAK-11 起跟读侧弃内联副本，全部走本内核。
///
/// 设计（沿用跟读评测的经验值，语义不变）：
/// - 开说/静音阈值不写死绝对电平——轻声说话或低灵敏麦克风的绝对电平可能永远
///   够不到固定线，这里按「运行时估计的底噪 × 信噪比倍率」自适应，绝对下限
///   兜住极安静房间的噪声毛刺，封顶保证开口即说话（前面没有静音样本）时阈值
///   不会被顶飞。
/// - 底噪估计只采信低于阈值的电平：说话块不抬高底噪，阈值不追着人声涨。
/// - 迟迟未判定开说时的救援线：3.5s 后持续高于底噪 1.8× 也算开口（超低电平
///   麦克风）；一直没听到开说 → 8s 提前收（提示检查麦克风）。
///
/// 无计时器、无状态订阅：调用方把麦克风的 { level, elapsedMs } 喂进 feed()，
/// 判定到断句时机时回调 onAutoStop。纯逻辑，单测友好。

/// 开说阈值 = clamp(底噪 × 2.8, 绝对下限, 封顶)；静音判定 = max(下限, 底噪 × 1.6)。
public let vadSpeechLevelMin: Float = 0.006
public let vadSpeechLevelCeiling: Float = 0.05
public let vadSilenceLevelMin: Float = 0.003
public let vadSpeechFloorRatio: Float = 2.8
public let vadSilenceFloorRatio: Float = 1.6
/// 迟迟未判定开说时的救援线：3.5s 后持续高于底噪 1.8× 也算开口（超低电平麦克风）。
public let vadRescueAfterMs: Int = 3500
public let vadRescueFloorRatio: Float = 1.8
/// 一直没听到开说 → 提前收（原来干等满 15s 才停），提示检查麦克风。
public let vadNoSpeechTimeoutMs: Int = 8000
/// 静音断句最短录音时长：太短的片段直接判静音没有意义。
public let vadMinRecordMs: Int = 700
/// 单次录音上限。
public let vadMaxRecordMs: Int = 15_000

/// onAutoStop 的触发原因。
public enum VadStopReason: Equatable, Sendable {
    /// 说过话后静音断句。
    case silence
    /// 一直没等到开说（提前收，提示检查麦克风）。
    case noSpeech
    /// 超单次录音上限。
    case maxDuration
}

/// 一次录音会话的 VAD 检测器（值语义由调用方持有；回调在 feed 的调用线程同步触发）。
public final class VadDetector {
    private let silenceMs: Double
    private let minRecordMs: Int
    private let maxRecordMs: Int
    private let onSpeechStart: (() -> Void)?
    private let onAutoStop: ((VadStopReason) -> Void)?

    private(set) var started = false
    /// 运行时底噪估计（nil = 还没收到电平）。
    private(set) var floor: Float?
    private var lastVoiceAt = 0
    private var stopped = false

    /// - Parameters:
    ///   - silenceMs: 开麦那一刻取定的静音断句时长（录音中途改设置不打断本次）。
    ///   - onSpeechStart: 判定「开口说话」的瞬间回调（false→true 跳变，含救援线判定）。
    ///   - onAutoStop: 自动收麦：静音断句 / 一直没开说 / 超时长。一次生命周期至多一次。
    public init(
        silenceMs: Double,
        minRecordMs: Int = vadMinRecordMs,
        maxRecordMs: Int = vadMaxRecordMs,
        onSpeechStart: (() -> Void)? = nil,
        onAutoStop: ((VadStopReason) -> Void)? = nil
    ) {
        self.silenceMs = silenceMs
        self.minRecordMs = minRecordMs
        self.maxRecordMs = maxRecordMs
        self.onSpeechStart = onSpeechStart
        self.onAutoStop = onAutoStop
    }

    /// 复位（新一轮录音前调用）。
    public func reset() {
        started = false
        lastVoiceAt = 0
        floor = nil
        stopped = false
    }

    /// 喂入麦克风的电平事件（level 0–1，elapsedMs 已录毫秒）。
    public func feed(_ level: Float, elapsedMs: Int) {
        guard !stopped else { return }
        let speechLevel = min(vadSpeechLevelCeiling, max(vadSpeechLevelMin, (floor ?? 0) * vadSpeechFloorRatio))
        if level < speechLevel {
            // 底噪估计只采信低于阈值的电平：说话块不抬高底噪，阈值不追着人声涨。
            floor = floor == nil ? level : min(level, floor! * 1.05)
        }
        let silenceLevel = max(vadSilenceLevelMin, (floor ?? 0) * vadSilenceFloorRatio)
        if level >= speechLevel {
            markStarted(elapsedMs: elapsedMs)
        } else if !started,
                  elapsedMs >= vadRescueAfterMs,
                  level >= (floor ?? 0) * vadRescueFloorRatio {
            // 超低电平麦克风：绝对阈值够不到，但持续高于底噪也算开口。
            markStarted(elapsedMs: elapsedMs)
        }
        if !started, elapsedMs >= vadNoSpeechTimeoutMs {
            // 一直没等到开说：提前收，别让用户干等满 15s。
            stopped = true
            onAutoStop?(.noSpeech)
            return
        }
        if started,
           level < silenceLevel,
           Double(elapsedMs - lastVoiceAt) >= silenceMs,
           elapsedMs >= minRecordMs {
            stopped = true
            onAutoStop?(.silence)
        } else if elapsedMs >= maxRecordMs {
            stopped = true
            onAutoStop?(.maxDuration)
        }
    }

    private func markStarted(elapsedMs: Int) {
        guard !started else {
            lastVoiceAt = elapsedMs
            return
        }
        started = true
        lastVoiceAt = elapsedMs
        onSpeechStart?()
    }
}
