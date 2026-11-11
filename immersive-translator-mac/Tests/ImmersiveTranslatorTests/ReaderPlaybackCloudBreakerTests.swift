import XCTest
import ReaderCore
import XfyunCore
@testable import ImmersiveTranslator

/// BUG-025：阅读室云合成（讯飞 / Edge）网络熔断。
///
/// 真实 ReaderPlaybackEngine（播放状态机 / 引擎路由 / 本地回落全真），只把「云取音」换成
/// 计数替身：fetch 一律挂起到被取消（= 挂起型网络「连上但不回包」的替身），cached 恒未命中。
/// 用例刻意不走 speakCloud 的失败 catch 分支——那里会往用户真实 diagnostic.log 写
/// `reader.tts.cloud-fallback`（QA 按该行计数取证），单测不得污染；熔断改由
/// tripCloudNetworkBreaker 预先打开，触发判定另由 shouldTripCloudNetworkBreaker 纯函数覆盖。
@MainActor
final class ReaderPlaybackCloudBreakerTests: XCTestCase {
    /// 云取音替身的调用记录（只在主 actor 上读写）。
    private final class CloudProbe {
        var fetches: [String] = []
        var cacheLookups: [String] = []
    }

    private var now = Date(timeIntervalSince1970: 1_800_000_000)

    private func makeEngine(_ probe: CloudProbe, provider: TtsProvider = .edge) -> ReaderPlaybackEngine {
        let engine = ReaderPlaybackEngine()
        engine.cloudAudioSource = .init(
            fetch: { _, text in
                await MainActor.run { probe.fetches.append(text) }
                // 挂起直到任务被取消：stop() 取消后抛 CancellationError，走「掐掉即可」分支。
                try await Task.sleep(nanoseconds: 60_000_000_000)
                throw CancellationError()
            },
            cached: { _, text in
                await MainActor.run { probe.cacheLookups.append(text) }
                return nil
            }
        )
        engine.breakerClock = { [unowned self] in self.now }
        engine.updateContext(
            texts: ["One.", "Two.", "Three."],
            settings: .init(rate: 1, voice: "", sentencePauseMs: 0, shadowingMode: true, ttsProvider: provider)
        )
        return engine
    }

    private func waitUntil(
        _ what: String,
        timeout: TimeInterval = 3,
        _ condition: @MainActor () -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline {
                XCTFail("等待超时：\(what)")
                return
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    /// 熔断窗口内后续句不发网络请求（只查缓存，未命中即本地）；窗口过期后下一句重新走网络。
    func testOpenBreakerSkipsNetworkUntilWindowExpires() async {
        let probe = CloudProbe()
        let engine = makeEngine(probe)
        let t0 = now
        engine.tripCloudNetworkBreaker(for: .edge)

        engine.jumpTo(0, autoplay: true)
        await waitUntil("窗口内第 1 句查缓存") { probe.cacheLookups == ["One."] }
        XCTAssertEqual(probe.fetches, [], "熔断窗口内不得再发网络请求（否则挂起型网络下每句都要先等满超时）")
        XCTAssertTrue(engine.playing, "缓存未命中应直接本地合成继续朗读，而不是停播")
        engine.stop()

        now = t0.addingTimeInterval(engine.cloudNetworkBreakerTTL - 1)
        engine.jumpTo(1, autoplay: true)
        await waitUntil("窗口末尾第 2 句仍只查缓存") { probe.cacheLookups == ["One.", "Two."] }
        XCTAssertEqual(probe.fetches, [])
        engine.stop()

        now = t0.addingTimeInterval(engine.cloudNetworkBreakerTTL + 1)
        engine.jumpTo(2, autoplay: true)
        await waitUntil("窗口过期后第 3 句重新走网络") { probe.fetches == ["Three."] }
        XCTAssertEqual(probe.cacheLookups, ["One.", "Two."], "过期后走引擎完整路径（缓存 → 网络），不再走只查缓存路径")
        engine.stop()
    }

    /// 熔断按引擎分键：讯飞的网络熔断不拦 Edge 的网络尝试。
    func testBreakerIsKeyedPerEngine() async {
        let probe = CloudProbe()
        let engine = makeEngine(probe, provider: .edge)
        engine.tripCloudNetworkBreaker(for: .xfyun)

        engine.jumpTo(0, autoplay: true)
        await waitUntil("Edge 照常走网络") { probe.fetches == ["One."] }
        XCTAssertEqual(probe.cacheLookups, [])
        engine.stop()
    }

    /// 用户按播放键开播 = 显式重试：熔断复位，本句重新走网络（「检查网络后重试」不被窗口吞掉）。
    func testExplicitPlayResetsBreaker() async {
        let probe = CloudProbe()
        let engine = makeEngine(probe)
        engine.tripCloudNetworkBreaker(for: .edge)

        engine.toggle()
        await waitUntil("开播后重新走网络") { probe.fetches == ["One."] }
        XCTAssertEqual(probe.cacheLookups, [])
        engine.stop()
    }

    /// 只有网络类失败打开熔断；凭据 / 空文本 / 空音频等与网络无关的失败不拦后续句。
    func testOnlyNetworkClassFailuresTripBreaker() {
        XCTAssertTrue(ReaderPlaybackEngine.shouldTripCloudNetworkBreaker(EdgeTtsError.timeout))
        XCTAssertTrue(ReaderPlaybackEngine.shouldTripCloudNetworkBreaker(EdgeTtsError.connectionRejected))
        XCTAssertTrue(ReaderPlaybackEngine.shouldTripCloudNetworkBreaker(EdgeTtsError.partialAudio))
        XCTAssertTrue(ReaderPlaybackEngine.shouldTripCloudNetworkBreaker(URLError(.timedOut)))
        XCTAssertTrue(ReaderPlaybackEngine.shouldTripCloudNetworkBreaker(URLError(.notConnectedToInternet)))

        XCTAssertFalse(ReaderPlaybackEngine.shouldTripCloudNetworkBreaker(EdgeTtsError.emptyAudio))
        XCTAssertFalse(ReaderPlaybackEngine.shouldTripCloudNetworkBreaker(EdgeTtsError.emptyText))
        XCTAssertFalse(ReaderPlaybackEngine.shouldTripCloudNetworkBreaker(
            XfyunSessionError.business(code: -1, message: "讯飞合成凭据未配置（设置 → 语音）")
        ))
    }
}
