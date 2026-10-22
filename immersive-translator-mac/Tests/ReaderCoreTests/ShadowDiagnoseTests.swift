import XCTest
@testable import ReaderCore

/// 跟读报告诊断逻辑单测：徽章判定、短板维度点名、差词/漏词清单、音素提示。
/// 对齐 src/core/shadowDiagnose.test.ts（Windows 口语陪练报告卡）。

final class ShadowDiagnoseTests: XCTestCase {
    // MARK: - 构造辅助

    /// 诊断输入的一个词（对齐 mapWordsToText 的产出：quality + word 明细）。
    private func mark(_ content: String, quality: ShadowDiagQuality, score: Double) -> ShadowDiagMark {
        ShadowDiagMark(quality: quality, score: score, word: ShadowDiagWord(content: content, phones: []))
    }

    private func result(
        total: Double,
        accuracy: Double = 4.3,
        fluency: Double = 3.4,
        integrity: Double = 4.6,
        isRejected: Bool = false,
        exceptInfo: String? = nil
    ) -> ShadowDiagResult {
        ShadowDiagResult(
            total: total, accuracy: accuracy, fluency: fluency, integrity: integrity,
            isRejected: isRejected, exceptInfo: exceptInfo
        )
    }

    private func joined(_ d: ShadowDiagnosis) -> String {
        d.segments.map(\.text).joined()
    }

    // MARK: - 主场景

    func testMainScenarioAlmostBadgeWeakFluency() {
        // 词序 the(5)/quick(4.7)/brown(漏读)/fox(2.5 差词)/jumps(3.5 ok)/over/the/lazy/dog
        let marks = [
            mark("the", quality: .good, score: 5),
            mark("quick", quality: .good, score: 4.7),
            mark("brown", quality: .missed, score: 0),
            mark("fox", quality: .bad, score: 2.5),
            mark("jumps", quality: .ok, score: 3.5),
            mark("over", quality: .good, score: 5),
            mark("the", quality: .good, score: 5),
            mark("lazy", quality: .good, score: 4.9),
            mark("dog", quality: .good, score: 4.7),
        ]
        let d = diagnoseShadow(result(total: 4.1), marks)
        XCTAssertFalse(d.pass)
        XCTAssertEqual(d.badgeKind, .almost)
        XCTAssertEqual(d.badge, "差 0.1 过关")
        XCTAssertEqual(d.weakDim, .fluency)
        XCTAssertEqual(d.drillWords, ["fox", "brown"])
        XCTAssertEqual(d.badCount, 1)
        XCTAssertEqual(d.missedCount, 1)
        // 诊断句点名短板与差词/漏词
        let text = joined(d)
        XCTAssertTrue(text.contains("流畅度 3.4"))
        XCTAssertTrue(text.contains("fox"))
        XCTAssertTrue(text.contains("漏读了 brown"))
        // 短板维度片段是 warn 强调
        XCTAssertTrue(d.segments.contains { $0.kind == .warn && $0.text.contains("流畅度") })
    }

    // MARK: - 过关 / 明显不足

    func testPassBadgePositiveCopyNoProblemList() {
        let marks = [
            mark("the", quality: .good, score: 4.9),
            mark("quick", quality: .good, score: 4.6),
            mark("brown", quality: .good, score: 4.8),
            mark("fox", quality: .good, score: 4.4),
        ]
        let d = diagnoseShadow(result(total: 4.7, accuracy: 4.8, fluency: 4.6, integrity: 5), marks)
        XCTAssertTrue(d.pass)
        XCTAssertEqual(d.badgeKind, .pass)
        XCTAssertTrue(d.drillWords.isEmpty)
        let text = joined(d)
        XCTAssertFalse(text.contains("漏读"))
        XCTAssertFalse(text.contains("不准"))
    }

    func testFailBadgeWithoutWeakDimWhenGapsSmall() {
        // 三项都 ≥4.7（gap < 0.4）→ 不硬点名维度
        let marks = [
            mark("the", quality: .ok, score: 3.0),
            mark("end", quality: .bad, score: 2.9),
        ]
        let d = diagnoseShadow(result(total: 2.8, accuracy: 4.7, fluency: 4.75, integrity: 4.7), marks)
        XCTAssertEqual(d.badgeKind, .fail)
        XCTAssertEqual(d.badge, "再练练")
        XCTAssertNil(d.weakDim)
    }

    func testMoreThanFourDrillWordsFocusFirstFour() {
        // a,b,d,e 差词在前、c,f 漏词在后，按出现序聚焦前 4
        let marks = [
            mark("a", quality: .bad, score: 1),
            mark("b", quality: .bad, score: 1),
            mark("c", quality: .missed, score: 0),
            mark("d", quality: .bad, score: 1),
            mark("e", quality: .bad, score: 1),
            mark("f", quality: .missed, score: 0),
        ]
        let d = diagnoseShadow(result(total: 2.5), marks)
        XCTAssertEqual(d.drillWords, ["a", "b", "d", "e"])
        XCTAssertEqual(d.badCount, 4)
        XCTAssertEqual(d.missedCount, 2)
    }

    // MARK: - 音素

    func testWorstPhoneOfPicksHeaviestPenaltyAboveThreshold() {
        let word = ShadowDiagWord(content: "latte", phones: [
            ShadowDiagPhone(content: "l", gwpp: -0.01),
            ShadowDiagPhone(content: "aa", gwpp: -1.9),
            ShadowDiagPhone(content: "t", gwpp: -0.05),
            ShadowDiagPhone(content: "ey", gwpp: -0.1),
        ])
        XCTAssertEqual(worstPhoneOf(word)?.content, "aa")
        // 都很轻微 → 不点名
        let clean = ShadowDiagWord(
            content: "latte",
            phones: word.phones.map { ShadowDiagPhone(content: $0.content, gwpp: -0.05) }
        )
        XCTAssertNil(worstPhoneOf(clean))
        XCTAssertNil(worstPhoneOf(nil))
    }

    func testPhoneTipKnownPhonesAndFallback() {
        XCTAssertTrue(phoneTip("dh").contains("齿"))
        XCTAssertTrue(phoneTip("ih").contains("短"))
        XCTAssertTrue(phoneTip("xx").contains("领读"))  // 兜底
    }

    // MARK: SPEAK-9 - phoneTips 全量 25 条（对齐 shadowDiagnose.ts:161-187 PHONE_TIPS）

    /// Windows PHONE_TIPS 的 25 个键；每个都必须返回针对性文案（非兜底）。
    private static let windowsPhoneTipKeys: [String] = [
        "th", "dh", "v", "w", "ng", "l", "r", "ih", "iy", "ae", "aa", "eh", "er",
        "ay", "aw", "ow", "ao", "ey", "uh", "b", "d", "g", "s", "sh", "z",
    ]

    func testPhoneTipsCoverAllTwentyFiveWindowsKeys() {
        XCTAssertEqual(Self.windowsPhoneTipKeys.count, 25)
        XCTAssertEqual(phoneTipKeys, Set(Self.windowsPhoneTipKeys), "键集合须与 Windows PHONE_TIPS 完全一致")
        for key in Self.windowsPhoneTipKeys {
            let tip = phoneTip(key)
            XCTAssertNotEqual(tip, phoneTipFallback, "\(key) 应有针对性文案而不是兜底")
            XCTAssertFalse(tip.isEmpty, "\(key) 文案不应为空")
        }
        // 兜底文案不变
        XCTAssertEqual(phoneTipFallback, "对照领读慢速跟两遍，注意口型")
        XCTAssertEqual(phoneTip("zh"), phoneTipFallback)
    }

    /// 本批补齐的 8 条（ao/ey/uh/b/d/g/s/sh）与 Windows 逐字一致（shadowDiagnose.ts:178-185）。
    func testEightNewPhoneTipsMatchWindowsVerbatim() {
        XCTAssertEqual(phoneTip("ao"), "长元音『奥』：舌后部抬一点、嘴拢圆，喉咙里共鸣（thought 的元音）")
        XCTAssertEqual(phoneTip("ey"), "双元音：从『诶』滑向『衣』，前重后轻，下巴逐渐收拢（late 的元音）")
        XCTAssertEqual(phoneTip("uh"), "中央松元音（schwa）：舌头放松平放口中，轻而短促，不要读成饱满的『啊』")
        XCTAssertEqual(phoneTip("b"), "浊塞音：双唇先闭紧，声带先振动再爆破放开，几乎不送气")
        XCTAssertEqual(phoneTip("d"), "浊塞音：舌尖抵上齿龈，声带先振动再弹开；词尾不要多出一个『特』")
        XCTAssertEqual(phoneTip("g"), "浊塞音：舌后部抵住软腭，声带先振动再放开，不送气")
        XCTAssertEqual(phoneTip("s"), "舌尖接近上齿龈，气流细而平地摩擦出来；不要把整个舌面抬起来")
        XCTAssertEqual(phoneTip("sh"), "舌面稍抬、双唇略撮圆，摩擦比『斯』更宽更闷（ship 的开头）")
    }

    /// 既有 17 条不被本批改动（抽样逐字核对首尾与中段）。
    func testExistingPhoneTipsUnchanged() {
        XCTAssertEqual(phoneTip("th"), "清音 th：舌尖轻放在上下齿之间送气，不是『斯』")
        XCTAssertEqual(phoneTip("ow"), "双元音『欧』，从 o 滑到 u")
        XCTAssertEqual(phoneTip("z"), "声带振动的 s；词尾不要读成『斯』")
    }

    // MARK: SPEAK-13 - 跟读异常可行动卡分类（对齐 SpeakView.tsx:729-779 / 1604-1669）

    func testPrecheckSilentOrShortRecordingIsNovoice() {
        // 静音（峰值 < 0.01）→ novoice
        let silent = shadowPrecheckFailureCard(sampleCount: 16_000, peak: 0.004)
        XCTAssertEqual(silent?.kind, .novoice)
        XCTAssertEqual(silent?.title, "· 没听到你的声音")
        XCTAssertEqual(silent?.body, "离麦克风近一点，按住按钮读完这一句再松开。")
        XCTAssertEqual(silent?.actions, [ShadowFailureAction(kind: .again, title: "🎤 重新跟读", primary: true)])
        // 过短（< 0.5s@16k）即便有声也 → novoice
        XCTAssertEqual(shadowPrecheckFailureCard(sampleCount: 7_999, peak: 0.3)?.kind, .novoice)
        // 边界：恰好 8000 样本 + 峰值恰好 0.01 → 体检通过
        XCTAssertNil(shadowPrecheckFailureCard(sampleCount: 8_000, peak: 0.01))
        XCTAssertNil(shadowPrecheckFailureCard(sampleCount: 16_000, peak: 0.2))
        // 阈值常量对齐 Windows MIN_UTTERANCE_SAMPLES / peak<0.01
        XCTAssertEqual(shadowPrecheckMinSamples, 8_000)
        XCTAssertEqual(shadowPrecheckMinPeak, 0.01)
    }

    func testRecordingPeakScansEverySixteenthSample() {
        // 步进 16：下标 0/16/32… 参与；夹在中间的尖峰不计（与 SpeakView.tsx:737 同语义）
        var samples = [Float](repeating: 0, count: 64)
        samples[5] = 0.9
        XCTAssertEqual(shadowRecordingPeak(samples), 0)
        samples[32] = -0.4
        XCTAssertEqual(shadowRecordingPeak(samples), 0.4, accuracy: 0.0001)
        XCTAssertEqual(shadowRecordingPeak([]), 0)
    }

    func testRejectedResultIsRejectedCardWithHearModelAndAgain() {
        let card = shadowResultFailureCard(isRejected: true, exceptInfo: nil)
        XCTAssertEqual(card?.kind, .rejected)
        XCTAssertEqual(card?.title, "✗ 读的好像不是这句话")
        XCTAssertEqual(card?.body, "不用灰心——可能句子太长跟丢了。先听一遍领读，照着文字再试一次。")
        XCTAssertEqual(card?.actions, [
            ShadowFailureAction(kind: .hearModel, title: "🔊 听领读", primary: true),
            ShadowFailureAction(kind: .again, title: "🎤 再跟读", primary: false),
        ])
        // is_rejected 优先于异常码（Windows 先查 isRejected）
        XCTAssertEqual(shadowResultFailureCard(isRejected: true, exceptInfo: "28680")?.kind, .rejected)
    }

    func testExceptCodesMapToNovoiceNoisyAndExcept() {
        let novoice = shadowResultFailureCard(isRejected: false, exceptInfo: "28673")
        XCTAssertEqual(novoice?.kind, .novoice)
        XCTAssertEqual(novoice?.actions.map(\.title), ["🎤 重新跟读"])

        let noisy = shadowResultFailureCard(isRejected: false, exceptInfo: "28680")
        XCTAssertEqual(noisy?.kind, .noisy)
        XCTAssertEqual(noisy?.title, "· 环境有点吵")
        XCTAssertEqual(noisy?.body, "背景噪音偏大，评测听不清——换个安静些的地方，或离麦克风再近一点。")
        XCTAssertEqual(noisy?.actions, [ShadowFailureAction(kind: .again, title: "🎤 重新跟读", primary: true)])

        let except = shadowResultFailureCard(isRejected: false, exceptInfo: "28676")
        XCTAssertEqual(except?.kind, .except)
        XCTAssertEqual(except?.title, "· 这次没评上")
        XCTAssertEqual(except?.body, "评测异常（28676），再试一次")
        XCTAssertEqual(except?.actions, [ShadowFailureAction(kind: .again, title: "🎤 再试一次", primary: true)])

        // 干净结果：无卡
        XCTAssertNil(shadowResultFailureCard(isRejected: false, exceptInfo: nil))
    }

    func testExceptCardCarriesDetailOrDefaultBody() {
        // 服务异常带详情
        let withDetail = shadowExceptFailureCard(detail: "语音评测超时（20s 无结果）")
        XCTAssertEqual(withDetail.kind, .except)
        XCTAssertEqual(withDetail.body, "语音评测超时（20s 无结果）")
        XCTAssertEqual(withDetail.actions.map(\.title), ["🎤 再试一次"])
        // 详情为空/空白 → Windows `detail || "再试一次应该就好。"`
        XCTAssertEqual(shadowExceptFailureCard(detail: nil).body, "再试一次应该就好。")
        XCTAssertEqual(shadowExceptFailureCard(detail: "   ").body, "再试一次应该就好。")
        XCTAssertEqual(shadowFailureCard(.except), shadowExceptFailureCard(detail: nil))
    }

    func testEveryFailureKindHasExactlyOnePrimaryAction() {
        for kind in [ShadowFailureKind.rejected, .novoice, .noisy, .except] {
            let card = shadowFailureCard(kind)
            XCTAssertEqual(card.kind, kind)
            XCTAssertEqual(card.actions.filter(\.primary).count, 1, "\(kind) 应恰有一个主按钮")
            XCTAssertTrue(card.actions.contains { $0.kind == .again }, "\(kind) 都能再跟读")
            XCTAssertFalse(card.title.isEmpty)
            XCTAssertFalse(card.body.isEmpty)
        }
        // 只有 rejected 带「听领读」
        XCTAssertTrue(shadowFailureCard(.rejected).actions.contains { $0.kind == .hearModel })
        for kind in [ShadowFailureKind.novoice, .noisy, .except] {
            XCTAssertFalse(shadowFailureCard(kind).actions.contains { $0.kind == .hearModel })
        }
    }

    // MARK: - 拒绝 / 异常（isPass 语义的前两项）

    func testRejectedAndExceptResultsNeverPass() {
        XCTAssertFalse(diagnoseShadow(result(total: 5, isRejected: true), []).pass)
        XCTAssertFalse(diagnoseShadow(result(total: 5, exceptInfo: "28673"), []).pass)
        XCTAssertFalse(diagnoseShadow(result(total: 5, exceptInfo: "28680"), []).pass)
        XCTAssertFalse(diagnoseShadow(result(total: 5, exceptInfo: "28676"), []).pass)
    }
}
