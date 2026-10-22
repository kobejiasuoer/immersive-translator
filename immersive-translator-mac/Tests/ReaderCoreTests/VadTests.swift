import XCTest
@testable import ReaderCore

/// VAD 纯内核（SPEAK-2）：静音断句 / 无话提前收 / 封顶 / 底噪自适应 / 救援线 /
/// 复位语义。对齐 src/core/vad.ts 的行为（参数同源：1.5s 静音、8s 无话、15s 封顶）。

final class VadTests: XCTestCase {
    /// 电平事件序列：[(电平, 距开始的毫秒)]。
    private func feed(_ d: VadDetector, _ events: [(Float, Int)]) {
        for (level, at) in events {
            d.feed(level, elapsedMs: at)
        }
    }

    /// 环境底噪（够不上绝对开说下限 0.006 的真实电平；不用 0.0——
    /// 那会把底噪估计拉到 0，触发救援线退化分支，与真麦行为不符）。
    private let roomNoise: Float = 0.0005

    // MARK: - 静音断句

    func testSilenceAutoStopAfterUtterance() {
        var stop: VadStopReason?
        let d = VadDetector(silenceMs: 1500, onAutoStop: { stop = $0 })
        // 开口说话（高电平）→ 静音 1.5s+
        feed(d, [
            (0.01, 100), (0.02, 400), (0.03, 800),          // 开说（超过绝对下限）
            (roomNoise, 1000), (roomNoise, 2600),           // 静音 1.6s（800 → 2600）
        ])
        XCTAssertEqual(stop, .silence)
        XCTAssertTrue(d.started)
    }

    func testShortSilenceDoesNotStop() {
        var stop: VadStopReason?
        let d = VadDetector(silenceMs: 1500, onAutoStop: { stop = $0 })
        feed(d, [
            (0.03, 100), (0.03, 800),
            (roomNoise, 1200), (0.03, 1300),   // 只停了 0.5s 又开口
        ])
        XCTAssertNil(stop)
        XCTAssertTrue(d.started)
    }

    /// 静音断句有最短录音时长护栏（< 700ms 的一小段不判停）。
    func testSilenceBeforeMinRecordMsDoesNotStop() {
        var stop: VadStopReason?
        let d = VadDetector(silenceMs: 1500, onAutoStop: { stop = $0 })
        feed(d, [
            (0.03, 100),
            (roomNoise, 300), (roomNoise, 700),   // 说了一个极短的音就静音，间隔仍不足 1.5s
        ])
        XCTAssertNil(stop)
    }

    // MARK: - 无话提前收 / 封顶

    func testNoSpeechTimeoutAt8s() {
        var stop: VadStopReason?
        let d = VadDetector(silenceMs: 1500, onAutoStop: { stop = $0 })
        // 一直只有环境底噪（够不上绝对下限 0.006，也够不上底噪×1.8 的救援线）
        feed(d, [(roomNoise, 100), (roomNoise, 4000), (roomNoise, 7999)])
        XCTAssertNil(stop)
        feed(d, [(roomNoise, 8001)])
        XCTAssertEqual(stop, .noSpeech)
        XCTAssertFalse(d.started)
    }

    func testMaxDurationCapAt15s() {
        var stop: VadStopReason?
        let d = VadDetector(silenceMs: 1500, onAutoStop: { stop = $0 })
        // 持续说话不停
        var events: [(Float, Int)] = []
        for t in stride(from: 100, through: 14_900, by: 100) {
            events.append((0.03, t))
        }
        feed(d, events)
        XCTAssertNil(stop, "14.9s 仍连续说话：不到封顶")
        feed(d, [(0.03, 15_000)])
        XCTAssertEqual(stop, .maxDuration)
        XCTAssertTrue(d.started)
    }

    /// 一次生命周期至多触发一次 onAutoStop；停后 feed 全部忽略。
    func testFeedAfterStopIsIgnored() {
        var stops: [VadStopReason] = []
        let d = VadDetector(silenceMs: 1500, onAutoStop: { stops.append($0) })
        feed(d, [(roomNoise, 100), (roomNoise, 8100), (0.03, 8200), (roomNoise, 12_000)])
        XCTAssertEqual(stops, [.noSpeech])
    }

    // MARK: - 底噪自适应 / 救援线

    /// 轻声说话（绝对电平够不到固定下限）：底噪估计抬高后，持续高于底噪 1.8×
    /// 的救援线在 3.5s 后判定开口（超低电平麦克风）。
    func testRescueLineForVeryLowLevelMic() {
        var speechStarted = false
        var stop: VadStopReason?
        let d = VadDetector(
            silenceMs: 1500,
            onSpeechStart: { speechStarted = true },
            onAutoStop: { stop = $0 }
        )
        // 底噪 0.001（低于绝对下限 0.006 → speechLevel 恒 0.006，够不上）
        feed(d, [(0.001, 100), (0.001, 1000), (0.002, 3700)])
        XCTAssertTrue(speechStarted, "3.5s 后持续高于底噪 1.8×（0.002 ≥ 0.001×1.8）应判开口")
        XCTAssertEqual(d.floor ?? -1, 0.001, accuracy: 0.0005)
        // 开口后静音（0.0005 < 底噪×1.6）满 1.5s → silence 断句
        feed(d, [(0.0005, 3900), (0.0005, 5300)])
        XCTAssertEqual(stop, .silence)
    }

    /// 说话块不抬高底噪估计（只采信低于阈值的电平）。
    func testSpeechBlocksDoNotRaiseFloor() {
        let d = VadDetector(silenceMs: 1500)
        feed(d, [(0.001, 100), (0.02, 500), (0.02, 900), (0.02, 1300)])
        XCTAssertEqual(d.floor ?? -1, 0.001, accuracy: 0.0005, "高电平样本不进底噪估计")
        XCTAssertTrue(d.started)
    }

    /// 开口即说话（前面没有静音样本）：底噪缺省 0 → speechLevel 取绝对下限，
    /// 正常音量即开说，阈值不会被顶飞。
    func testSpeechCeilingKeepsThresholdSane() {
        let d = VadDetector(silenceMs: 1500)
        feed(d, [(0.9, 100), (0.9, 300)])
        XCTAssertTrue(d.started)
    }

    // MARK: - onSpeechStart 只跳变一次

    func testSpeechStartFiresOnce() {
        var count = 0
        let d = VadDetector(silenceMs: 1500, onSpeechStart: { count += 1 })
        feed(d, [(0.03, 100), (0.03, 500), (0.03, 900), (0.03, 1300)])
        XCTAssertEqual(count, 1)
    }

    // MARK: - reset

    func testResetStartsFreshLifecycle() {
        var stops: [VadStopReason] = []
        let d = VadDetector(silenceMs: 1500, onAutoStop: { stops.append($0) })
        feed(d, [(roomNoise, 100), (roomNoise, 8100)])
        XCTAssertEqual(stops, [.noSpeech])
        d.reset()
        XCTAssertFalse(d.started)
        XCTAssertNil(d.floor)
        // 复位后可以再次进入生命周期
        feed(d, [(0.03, 100), (0.03, 500), (roomNoise, 700), (roomNoise, 2400)])
        XCTAssertEqual(stops, [.noSpeech, .silence])
        XCTAssertTrue(d.started)
    }

    /// 参数与 src/core/vad.ts 常量同源（对齐值快照）。
    func testVadConstantsMatchWindowsBaseline() {
        XCTAssertEqual(vadSpeechLevelMin, 0.006)
        XCTAssertEqual(vadSpeechLevelCeiling, 0.05)
        XCTAssertEqual(vadSilenceLevelMin, 0.003)
        XCTAssertEqual(vadSpeechFloorRatio, 2.8)
        XCTAssertEqual(vadSilenceFloorRatio, 1.6)
        XCTAssertEqual(vadRescueAfterMs, 3500)
        XCTAssertEqual(vadRescueFloorRatio, 1.8)
        XCTAssertEqual(vadNoSpeechTimeoutMs, 8000)
        XCTAssertEqual(vadMinRecordMs, 700)
        XCTAssertEqual(vadMaxRecordMs, 15_000)
    }

    // MARK: SPEAK-11 - 跟读侧接入（ShadowAssessController 开麦那一刻取定 silenceMs）

    /// 跟读评测把设置里的静音断句时长（如 2500ms）交给同一内核：断句时机随之变化，
    /// 其余阈值（开说/救援/无话/封顶）与口语开麦同源不变。
    func testShadowSideSilenceMsFromSettingsIsHonored() {
        var stop2500: VadStopReason?
        let longer = VadDetector(silenceMs: 2500, onAutoStop: { stop2500 = $0 })
        feed(longer, [
            (0.03, 100), (0.03, 800),
            (roomNoise, 1000), (roomNoise, 2600),   // 距最后一次有声 1.8s：1500 档会停，2500 档不停
        ])
        XCTAssertNil(stop2500, "2.5s 静音档：1.8s 静音不断句")
        feed(longer, [(roomNoise, 3400)])          // 2.6s 静音 → 断句
        XCTAssertEqual(stop2500, .silence)

        // 同一序列在 1500 档立即断句（口语开麦默认档），证明差异只来自 silenceMs 参数
        var stop1500: VadStopReason?
        let shorter = VadDetector(silenceMs: 1500, onAutoStop: { stop1500 = $0 })
        feed(shorter, [(0.03, 100), (0.03, 800), (roomNoise, 1000), (roomNoise, 2600)])
        XCTAssertEqual(stop1500, .silence)
    }

    /// 跟读侧「手动说完」先于 VAD：停后再喂电平不再二次触发（一次生命周期至多一次）。
    func testNoSecondAutoStopAfterManualFinishSemantics() {
        var stops: [VadStopReason] = []
        let d = VadDetector(silenceMs: 1500, onAutoStop: { stops.append($0) })
        feed(d, [(0.03, 100), (0.03, 800), (roomNoise, 1000), (roomNoise, 2600)])
        XCTAssertEqual(stops, [.silence])
        feed(d, [(0.03, 2700), (roomNoise, 5000), (roomNoise, 16_000)])
        XCTAssertEqual(stops, [.silence], "停后不再触发 silence/maxDuration")
    }
}
