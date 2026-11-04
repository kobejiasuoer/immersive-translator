import XCTest
import ReaderCore
import XfyunCore
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 录音直译路由单测（对齐 Windows LiveCaptionApp 的 voiceRoute 接入行为向量）：
// 开麦那一刻定格路由整场共用（stop 后不清空、尾句不重新 resolve）；方向在句入口
// 定格（尾句按本场方向识别/翻译）；off 给引导不开麦不识别不产段；gateway 逐句 REST
// 转写且错误走 voiceErrorDisplayText 映射（额度类拼重置时间），失败文案按 Windows
// 写进段内「〔识别失败：…〕」，空识别结果移除占位段；xfyun 缺凭据给存量文案、错误
// 保留原始 message（存量 Mac 行为零改动：段内「（识别失败）」+ 顶部错误条、空句标 done）。
// ---------------------------------------------------------------------------

/// 录音句柄替身（只记 cancel 次数，不碰真实麦克风）。
private final class FakeLiveCaptionMic: LiveCaptionMicHandle {
    private(set) var cancelCount = 0
    func cancel() { cancelCount += 1 }
}

final class LiveCaptionRouteTests: XCTestCase {
    private struct Boom: LocalizedError {
        var errorDescription: String? { "讯飞听写连接失败" }
    }

    private func makeDeps(
        gateway: @escaping (VoiceAsrLang, [Float]) async throws -> String = { _, _ in "网关结果" },
        creds: XfyunCredentials? = nil,
        xfyun: @escaping ([Float], AsrLanguage, XfyunCredentials) async throws -> String = { _, _, _ in "讯飞结果" }
    ) -> LiveCaptionAsrDispatch.Deps {
        LiveCaptionAsrDispatch.Deps(
            gateway: gateway,
            xfyunCredentials: { creds },
            xfyun: xfyun
        )
    }

    // MARK: 前置检查：off → 引导；xfyun 缺凭据 → 存量文案

    func testPrecheckOffBlocksWithHint() {
        let decision = VoiceRouteDecision(engine: .off, reason: .notLoggedIn, hint: "登录沉浸云即用")
        XCTAssertEqual(LiveCaptionAsrDispatch.precheck(decision: decision, xfyunCredentials: { nil }), .blocked("登录沉浸云即用"))
        // 未开通 / 封禁 / 配额耗尽同走 off 引导。
        let quota = VoiceRouteDecision(engine: .off, reason: .quotaExhausted, hint: "本月识别额度已用完，可在「设置 → 账号」用兑换码补足")
        XCTAssertEqual(
            LiveCaptionAsrDispatch.precheck(decision: quota, xfyunCredentials: { nil }),
            .blocked("本月识别额度已用完，可在「设置 → 账号」用兑换码补足")
        )
        // hint 缺省兜底。
        XCTAssertEqual(
            LiveCaptionAsrDispatch.precheck(decision: VoiceRouteDecision(engine: .off), xfyunCredentials: { nil }),
            .blocked("语音识别暂不可用")
        )
    }

    func testPrecheckXfyunMissingCredentialsUsesLegacyText() {
        XCTAssertEqual(LiveCaptionAsrDispatch.precheck(decision: .xfyun, xfyunCredentials: { nil }), .blocked("未配置听写凭据：设置 → 语音"))
        let creds = XfyunCredentials(appId: "a", apiKey: "k", apiSecret: "s")
        XCTAssertEqual(LiveCaptionAsrDispatch.precheck(decision: .xfyun, xfyunCredentials: { creds }), .proceed(creds))
        XCTAssertEqual(LiveCaptionAsrDispatch.precheck(decision: .gateway, xfyunCredentials: { nil }), .proceed(nil), "gateway 不查讯飞凭据")
    }

    // MARK: gateway → 逐句 REST 转写

    func testGatewayTranscribesPerUtterance() async {
        var seen: [VoiceAsrLang] = []
        var seenSamples: [[Float]] = []
        let deps = makeDeps(gateway: { lang, samples in
            seen.append(lang)
            seenSamples.append(samples)
            return "识别文本"
        })
        let outcome = await LiveCaptionAsrDispatch.transcribe(
            samples: [0.5, -0.5],
            language: .en_us,
            decision: .gateway,
            deps: deps
        )
        XCTAssertEqual(outcome, .text("识别文本"))
        XCTAssertEqual(seen, [.en_us])
        XCTAssertEqual(seenSamples, [[0.5, -0.5]])
    }

    func testGatewayErrorMapsQuotaWithResetTimeIntoSegment() async {
        // 本地时区 resetsAt，避免断言随时区漂移。
        var components = DateComponents()
        components.year = 2026
        components.month = 11
        components.day = 1
        components.hour = 12
        let date = Calendar.current.date(from: components)!
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = .current
        let iso = formatter.string(from: date)

        let outcome = await LiveCaptionAsrDispatch.transcribe(
            samples: [0.1],
            language: .en_us,
            decision: .gateway,
            deps: makeDeps(gateway: { _, _ in
                throw VoiceError(code: "quota_exceeded", details: ["resource": "asr_seconds", "resetsAt": iso])
            })
        )
        XCTAssertEqual(outcome, .failed(segmentSource: "〔识别失败：本月口语识别额度已用完，11 月 1 日重置〕", banner: nil))
    }

    func testGatewayUnknownAndSilentErrorsFallBackToGenericText() async {
        let outcome = await LiveCaptionAsrDispatch.transcribe(
            samples: [0.1],
            language: .en_us,
            decision: .gateway,
            deps: makeDeps(gateway: { _, _ in
                throw VoiceError(code: "teapot")
            })
        )
        XCTAssertEqual(outcome, .failed(segmentSource: "〔识别失败：服务暂时不可用，请稍后再试〕", banner: nil))
        // silent 类错误（token_expired）→ 空串兜底成通用文案。
        let silent = await LiveCaptionAsrDispatch.transcribe(
            samples: [0.1],
            language: .en_us,
            decision: .gateway,
            deps: makeDeps(gateway: { _, _ in
                throw VoiceError(code: "token_expired")
            })
        )
        XCTAssertEqual(silent, .failed(segmentSource: "〔识别失败：服务暂时不可用，请稍后再试〕", banner: nil))
        // 非 VoiceError（本地异常）同样兜底，不透传原始描述。
        struct Weird: Error {}
        XCTAssertEqual(LiveCaptionAsrDispatch.gatewayErrorText(Weird()), "服务暂时不可用，请稍后再试")
        // 封禁走 §二文案。
        XCTAssertEqual(LiveCaptionAsrDispatch.gatewayErrorText(VoiceError(code: "banned")), "账号已被封禁")
    }

    // MARK: xfyun → 存量行为零改动

    func testXfyunPreservesOriginalErrorMessage() async {
        let outcome = await LiveCaptionAsrDispatch.transcribe(
            samples: [0.1],
            language: .zh_cn,
            decision: .xfyun,
            xfyunCredentials: XfyunCredentials(),
            deps: makeDeps(creds: XfyunCredentials(), xfyun: { _, _, _ in throw Boom() })
        )
        XCTAssertEqual(outcome, .failed(segmentSource: "（识别失败）", banner: "讯飞听写连接失败"))
    }

    func testXfyunHappyPath() async {
        var usedLangs: [AsrLanguage] = []
        let outcome = await LiveCaptionAsrDispatch.transcribe(
            samples: [0.2],
            language: .zh_cn,
            decision: .xfyun,
            xfyunCredentials: XfyunCredentials(),
            deps: makeDeps(creds: XfyunCredentials(), xfyun: { _, lang, _ in
                usedLangs.append(lang)
                return "讯飞识别"
            })
        )
        XCTAssertEqual(outcome, .text("讯飞识别"))
        XCTAssertEqual(usedLangs, [.zh_cn])
    }

    // MARK: 控制器级：路由定格整场共用 + 缺失时补一次

    @MainActor
    func testControllerPinsRouteForWholeSessionAndResolvesWhenMissing() async {
        let controller = LiveCaptionController()
        var resolved = 0
        controller.routeResolver = { _ in
            resolved += 1
            return .gateway
        }
        var transcribed: [[Float]] = []
        controller.gatewayTranscriber = { _, samples in
            transcribed.append(samples)
            // 空串：gateway 没识别出内容 → 移除占位段，不触发翻译通道（单测不碰 LLM 网络）。
            return ""
        }
        controller.route = nil
        // route 缺失（未经开麦定格）：补一次 resolve 并定格。
        controller.transcribe(samples: [0.3])
        await assertAsync { !transcribed.isEmpty }
        XCTAssertEqual(resolved, 1, "route 缺失补一次 resolve")
        // 定格后整场共用：后续句不再 resolve。
        controller.transcribe(samples: [0.4])
        await assertAsync { transcribed.count == 2 }
        XCTAssertEqual(resolved, 1, "开麦那一刻定格，整场共用")
        // 空识别结果：占位段移除（对齐 Windows `!text`），不残留「识别中…」。
        await assertAsync { controller.segments.isEmpty }
        XCTAssertEqual(controller.route?.engine, .gateway)
    }

    // MARK: gateway 空识别结果 → 移除占位段（LiveCaptionApp.tsx:156-159）；讯飞存量不变

    func testDispatchGatewayEmptyTextYieldsEmptyOutcome() async {
        let empty = await LiveCaptionAsrDispatch.transcribe(
            samples: [0.1],
            language: .zh_cn,
            decision: .gateway,
            deps: makeDeps(gateway: { _, _ in "" })
        )
        XCTAssertEqual(empty, .empty, "gateway 空串：调用方移除占位段")
        // Windows 只判空串（`!text` 不 trim）：非空白串照常进翻译。
        let spaced = await LiveCaptionAsrDispatch.transcribe(
            samples: [0.1],
            language: .zh_cn,
            decision: .gateway,
            deps: makeDeps(gateway: { _, _ in " " })
        )
        XCTAssertEqual(spaced, .text(" "))
        // 讯飞分支不走 .empty（存量「空句标 done」零改动）。
        let xfyun = await LiveCaptionAsrDispatch.transcribe(
            samples: [0.1],
            language: .zh_cn,
            decision: .xfyun,
            xfyunCredentials: XfyunCredentials(),
            deps: makeDeps(creds: XfyunCredentials(), xfyun: { _, _, _ in "" })
        )
        XCTAssertEqual(xfyun, .text(""))
    }

    @MainActor
    func testControllerGatewayEmptyResultRemovesPlaceholder() async {
        let controller = LiveCaptionController()
        controller.route = .gateway
        var statesDuringAsr: [[CaptionSegment.State]] = []
        controller.gatewayTranscriber = { _, _ in
            let states = await MainActor.run { controller.segments.map(\.state) }
            statesDuringAsr.append(states)
            return ""
        }
        controller.transcribe(samples: [0.1])
        await assertAsync { !statesDuringAsr.isEmpty }
        XCTAssertEqual(statesDuringAsr, [[.transcribing]], "识别期间占位段在屏")
        await assertAsync("没识别出内容：占位段移除，不永久显示「识别中…」") { controller.segments.isEmpty }
        XCTAssertNil(controller.errorMessage, "不打断后续、不给错误条")
    }

    @MainActor
    func testControllerXfyunEmptyResultKeepsLegacyDoneSegment() async {
        let controller = LiveCaptionController()
        controller.route = .xfyun
        controller.xfyunAsrCredentials = { XfyunCredentials(appId: "a", apiKey: "k", apiSecret: "s") }
        controller.xfyunTranscriber = { _, _, _ in "" }
        controller.transcribe(samples: [0.1])
        await assertAsync { controller.segments.first?.state == .done }
        XCTAssertEqual(controller.segments.count, 1, "讯飞分支存量：空句标 done 保留（零改动）")
        XCTAssertEqual(controller.segments.first?.source, "")
        XCTAssertNil(controller.segments.first?.target)
    }

    // MARK: 方向与路由在句入口定格（对齐 handleUtterance 的 dir / routeRef 同步读取）

    @MainActor
    func testTranscribePinsDirectionAtEntryForAsrAndTranslation() async {
        let controller = LiveCaptionController()
        controller.toggleDirection() // en2zh → en_us
        var resolvedLangs: [VoiceAsrLang?] = []
        controller.routeResolver = { lang in
            resolvedLangs.append(lang)
            return .gateway
        }
        var asrLangs: [VoiceAsrLang] = []
        controller.gatewayTranscriber = { lang, _ in
            asrLangs.append(lang)
            return "hello world"
        }
        var prompts: [String] = []
        var sources: [String] = []
        controller.captionTranslator = { system, source in
            prompts.append(system)
            sources.append(source)
            return "你好世界"
        }
        controller.transcribe(samples: [0.1])
        // 进函数之后立刻切回方向（录音已停时允许）：本句仍按入口方向识别/翻译。
        controller.toggleDirection()
        XCTAssertEqual(controller.direction, .zh2en)
        await assertAsync { controller.segments.first?.state == .done }
        XCTAssertEqual(resolvedLangs, [.en_us], "补 resolve 按入口方向的语种")
        XCTAssertEqual(asrLangs, [.en_us])
        XCTAssertEqual(prompts, [buildCaptionSystemPrompt(direction: .en2zh)], "译向按入口方向")
        XCTAssertEqual(sources, ["hello world"])
        XCTAssertEqual(controller.segments.first?.source, "hello world")
        XCTAssertEqual(controller.segments.first?.target, "你好世界")
    }

    /// 停止录音 flush 尾句：按本场方向的语种识别（原先未传语种恒按 zh_cn），复用
    /// 开麦定格的路由（不重新 resolve），stop 后路由决策保留（Windows routeRef 不清空）。
    @MainActor
    func testStopFlushesTailWithSessionDirectionAndPinnedRoute() async {
        let controller = LiveCaptionController()
        controller.toggleDirection() // en2zh → en_us
        var resolvedLangs: [VoiceAsrLang?] = []
        controller.routeResolver = { lang in
            resolvedLangs.append(lang)
            return .gateway
        }
        let mic = FakeLiveCaptionMic()
        var onChunk: (([Float], MicLevelEvent) -> Void)?
        controller.micStarter = { handler in
            onChunk = handler
            return mic
        }
        var transcribedLangs: [VoiceAsrLang] = []
        var transcribedCounts: [Int] = []
        controller.gatewayTranscriber = { lang, samples in
            transcribedLangs.append(lang)
            transcribedCounts.append(samples.count)
            return "" // 空串：移除占位段，不触发翻译通道
        }
        controller.toggleRecording()
        await assertAsync("守卫放行后开麦") { controller.recording && onChunk != nil }
        // 一块有声音频：分句器起句攒着（未到静音收句）。
        onChunk?([Float](repeating: 0.2, count: 1600), MicLevelEvent(level: 0.5, elapsedMs: 100))
        await assertAsync("分句器正在攒一句") { controller.speaking }
        XCTAssertTrue(transcribedLangs.isEmpty, "未收句前不识别")

        controller.toggleRecording() // 停止：flush 尾句
        XCTAssertFalse(controller.recording)
        await assertAsync("尾句送识别") { !transcribedLangs.isEmpty }
        XCTAssertEqual(transcribedLangs, [.en_us], "en2zh 尾句按 en_us 识别")
        XCTAssertEqual(transcribedCounts, [1600])
        XCTAssertEqual(resolvedLangs, [.en_us], "尾句复用开麦定格的路由，不重新 resolve")
        XCTAssertEqual(controller.route?.engine, .gateway, "stop 后路由决策保留")
        await assertAsync("录音器已释放") { mic.cancelCount == 1 }
        await assertAsync { controller.segments.isEmpty }
    }

    @MainActor
    func testControllerGatewayFailureWritesInlineSegmentWithoutBanner() async {
        let controller = LiveCaptionController()
        controller.route = .gateway
        controller.gatewayTranscriber = { _, _ in throw VoiceError(code: "banned") }
        controller.transcribe(samples: [0.1])
        await assertAsync { controller.segments.first?.state == .failed }
        XCTAssertEqual(controller.segments.first?.source, "〔识别失败：账号已被封禁〕")
        XCTAssertNil(controller.errorMessage, "gateway 失败文案在段内，不另起错误条（对齐 Windows）")
    }

    @MainActor
    func testControllerXfyunFailureKeepsLegacyPresentation() async {
        let controller = LiveCaptionController()
        controller.route = .xfyun
        controller.xfyunAsrCredentials = { XfyunCredentials(appId: "a", apiKey: "k", apiSecret: "s") }
        controller.xfyunTranscriber = { _, _, _ in throw Boom() }
        controller.transcribe(samples: [0.1])
        await assertAsync { controller.segments.first?.state == .failed }
        XCTAssertEqual(controller.segments.first?.source, "（识别失败）")
        XCTAssertEqual(controller.errorMessage, "讯飞听写连接失败")
    }

    @MainActor
    func testControllerOffRouteDoesNotProduceSegment() async {
        let controller = LiveCaptionController()
        controller.route = VoiceRouteDecision(engine: .off, reason: .notLoggedIn, hint: "登录沉浸云即用")
        controller.transcribe(samples: [0.1])
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(controller.segments.count, 0, "off 不产段")
        XCTAssertEqual(controller.errorMessage, "登录沉浸云即用")
    }

    @MainActor
    func testControllerXfyunMissingCredentialsNoSegment() async {
        let controller = LiveCaptionController()
        controller.route = .xfyun
        controller.xfyunAsrCredentials = { nil }
        controller.transcribe(samples: [0.1])
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(controller.segments.count, 0)
        XCTAssertEqual(controller.errorMessage, "未配置听写凭据：设置 → 语音")
    }

    // MARK: 开麦守卫：off 不开麦给 hint；xfyun 缺凭据给存量文案（不进录音态）

    @MainActor
    func testStartRecordingOffRouteDoesNotOpenMic() async {
        let controller = LiveCaptionController()
        var resolvedLangs: [VoiceAsrLang?] = []
        controller.routeResolver = { lang in
            resolvedLangs.append(lang)
            return VoiceRouteDecision(engine: .off, reason: .notLoggedIn, hint: "登录沉浸云即用")
        }
        controller.toggleRecording()
        await assertAsync { controller.errorMessage != nil }
        XCTAssertEqual(controller.errorMessage, "登录沉浸云即用")
        XCTAssertFalse(controller.recording, "守卫不过不开麦、不进录音态")
        XCTAssertEqual(resolvedLangs, [.zh_cn], "开麦那一刻按方向定 asrLang（zh2en → zh_cn）")
        XCTAssertEqual(controller.route?.engine, .off, "定格的路由决策")
    }

    @MainActor
    func testStartRecordingXfyunWithoutCredentialsShowsLegacyText() async {
        let controller = LiveCaptionController()
        controller.routeResolver = { _ in .xfyun }
        controller.xfyunAsrCredentials = { nil }
        controller.toggleDirection() // en2zh → en_us
        controller.toggleRecording()
        await assertAsync { controller.errorMessage != nil }
        XCTAssertEqual(controller.errorMessage, "未配置听写凭据：设置 → 语音（可复用评测凭据）")
        XCTAssertFalse(controller.recording)
        XCTAssertEqual(controller.asrLanguage, .en_us)
    }
}
