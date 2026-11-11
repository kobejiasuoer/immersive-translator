import XCTest
import ReaderCore
@testable import ImmersiveTranslator

/// BUG-026：浮窗朗读云音色档路由（CloudTtsRouter.route，可能挂起的网络探测）返回后须先核代数。
///
/// 真实 PanelTtsSpeaker + 真实 AVSpeechSynthesizer（本地腿真出声），只把路由裁决换成测试可控的
/// 挂起闸门（不碰网络、不读 Keychain 里的讯飞凭据）。可观测后果：迟到的旧裁决若仍进 .local 腿，
/// 会把 playingGeneration 覆盖成旧代数——当前朗读播完后 speaking 永不复位（并伴随幽灵语音）。
@MainActor
final class PanelTtsSpeakerRouteGenerationTests: XCTestCase {
    /// 路由闸门：每次裁决挂起，测试按序放行。
    private final class RouteGate {
        var pending: [CheckedContinuation<CloudTtsRouter.Engine, Never>] = []
    }

    private func waitUntil(
        _ what: String,
        timeout: TimeInterval,
        _ condition: @MainActor () -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline {
                XCTFail("等待超时：\(what)")
                return
            }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    func testStaleRouteVerdictAfterTargetSwitchIsDropped() async {
        let gate = RouteGate()
        let speaker = PanelTtsSpeaker(
            resolveProvider: { .cloud },
            routeCloud: { await withCheckedContinuation { gate.pending.append($0) } }
        )

        speaker.toggle(.original, text: "Alpha.")
        await waitUntil("原文朗读进入路由裁决", timeout: 3) { gate.pending.count == 1 }
        // 裁决挂起期间换朗读位：stop() 推进代数并取消旧任务，新朗读进入自己的裁决。
        speaker.toggle(.translated, text: "Bravo.")
        await waitUntil("译文朗读进入路由裁决", timeout: 3) { gate.pending.count == 2 }
        XCTAssertEqual(speaker.speaking, .translated)

        gate.pending[1].resume(returning: .local)  // 当前朗读位：本地出声
        gate.pending[0].resume(returning: .local)  // 迟到的旧裁决：必须被代数门禁丢弃

        // 当前朗读自然播完 → speaking 复位；旧裁决若混进本地腿，这里永远等不到 nil。
        await waitUntil("译文播完后朗读态复位", timeout: 15) { speaker.speaking == nil }
        speaker.stop()
    }
}
