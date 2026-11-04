import XCTest
@testable import ImmersiveTranslator

// ---------------------------------------------------------------------------
// 兑换码单测（对齐 Windows src/views/RedeemCard.test.tsx 9 用例 + speakUi.test.ts
// redeem 档）：三业务码逐字映射 / validation_error·未知码·非 JSON 落兜底且
// codeOf 为 nil / 空输入禁用 / submitting 全禁用 + trim 透传 / success 清空
// 输入 / error 保留输入 / reject 兜底 / 通知分类三形态。
// UI 控件层的 Return 键提交与禁用态由 RedeemCardView 绑定 RedeemModel 同源
// 状态机（canSubmit/submitting），此处覆盖状态机本体。
// ---------------------------------------------------------------------------

final class RedeemTests: XCTestCase {
    private func response(_ status: Int, body: String) -> AuthHttpResponse {
        AuthHttpResponse(status: status, retryAfterSeconds: nil, body: body)
    }

    private func envelope(_ code: String, message: String = "m") -> String {
        "{\"error\":{\"code\":\"\(code)\",\"message\":\"\(message)\"}}"
    }

    // MARK: 错误码解析（宽松；非 JSON → nil）

    func testErrorCodeOfParsesEnvelope() {
        XCTAssertEqual(redeemErrorCodeOf(response(404, body: envelope("redeem_code_not_found"))), "redeem_code_not_found")
        // 非 JSON（代理页/网关文本）→ nil
        XCTAssertNil(redeemErrorCodeOf(response(502, body: "<html>Bad Gateway</html>")))
        // 空字符串 code / code 非字符串 / 无 error 信封 → nil
        XCTAssertNil(redeemErrorCodeOf(response(400, body: "{\"error\":{\"code\":\"\",\"message\":\"m\"}}")))
        XCTAssertNil(redeemErrorCodeOf(response(400, body: "{\"error\":{\"code\":42,\"message\":\"m\"}}")))
        XCTAssertNil(redeemErrorCodeOf(response(400, body: "{\"message\":\"no envelope\"}")))
        XCTAssertNil(redeemErrorCodeOf(response(400, body: "not json")))
    }

    // MARK: 三码逐字 + 兜底（绝不透传服务端 message）

    func testErrorTextMapsThreeBusinessCodesExactly() {
        XCTAssertEqual(redeemErrorText(response(404, body: envelope("redeem_code_not_found"))), "兑换码不存在")
        XCTAssertEqual(redeemErrorText(response(404, body: envelope("redeem_code_expired"))), "兑换码已过期")
        XCTAssertEqual(redeemErrorText(response(409, body: envelope("redeem_code_used"))), "兑换码已被使用")
        // validation_error / 未知码 / 非 JSON → 兜底
        XCTAssertEqual(redeemErrorText(response(422, body: envelope("validation_error"))), "兑换失败，请稍后再试")
        XCTAssertEqual(redeemErrorText(response(500, body: envelope("who_knows"))), "兑换失败，请稍后再试")
        XCTAssertEqual(redeemErrorText(response(502, body: "Bad Gateway")), "兑换失败，请稍后再试")
        // 服务端 message 永不进入用户文案
        let leaky = redeemErrorText(response(418, body: envelope("teapot", message: "内部提示别外泄")))
        XCTAssertEqual(leaky, "兑换失败，请稍后再试")
    }

    // MARK: 提交状态机（idle → submitting → success | error）

    /// 等待异步提交收尾（模型状态在 MainActor Task 里翻转）。
    @MainActor
    private func waitUntil(_ condition: @escaping () -> Bool) async {
        let deadline = Date().addingTimeInterval(5)
        while !condition() && Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    @MainActor
    func testEmptyOrWhitespaceCodeCannotSubmit() {
        let model = RedeemModel(redeem: { [self] _ in self.response(200, body: "{}") })
        model.code = ""
        XCTAssertFalse(model.canSubmit)  // 空输入禁用
        model.code = "   \n  "
        XCTAssertFalse(model.canSubmit)  // 纯空白等效空
        model.code = "ABCD-1234"
        XCTAssertTrue(model.canSubmit)
    }

    @MainActor
    func testSubmitPassesTrimmedCodeAndSucceeds() async {
        var received: [String] = []
        let model = RedeemModel(redeem: { [self] code in
            received.append(code)
            return self.response(200, body: "{\"granted\":100}")
        })
        model.code = "  ABCD-EFGH-IJKL-MNOP  \n"
        model.handleSubmit()
        await waitUntil { model.phase == .success }
        XCTAssertEqual(received, ["ABCD-EFGH-IJKL-MNOP"])  // 透传 trim 后的码
        XCTAssertEqual(model.message, "兑换成功，额度已到账")
        XCTAssertEqual(model.code, "")  // success 清空输入（允许连兑）
    }

    @MainActor
    func testNotFoundErrorKeepsInputForRetry() async {
        let model = RedeemModel(redeem: { [self] _ in
            self.response(404, body: self.envelope("redeem_code_not_found"))
        })
        model.code = "WRON-GCOD-EEEE-EEEE"
        model.handleSubmit()
        await waitUntil { model.phase == .error }
        XCTAssertEqual(model.message, "兑换码不存在")
        XCTAssertEqual(model.code, "WRON-GCOD-EEEE-EEEE")  // error 保留输入可改后重试
    }

    @MainActor
    func testExpiredAndUsedMappings() async {
        let expired = RedeemModel(redeem: { [self] _ in
            self.response(404, body: self.envelope("redeem_code_expired"))
        })
        expired.code = "OLD1-CODE-EEEE-EEEE"
        expired.handleSubmit()
        await waitUntil { expired.phase == .error }
        XCTAssertEqual(expired.message, "兑换码已过期")

        let used = RedeemModel(redeem: { [self] _ in
            self.response(409, body: self.envelope("redeem_code_used"))
        })
        used.code = "USED1-CODE-EEEE-EEEE"
        used.handleSubmit()
        await waitUntil { used.phase == .error }
        XCTAssertEqual(used.message, "兑换码已被使用")
    }

    @MainActor
    func testRejectFallsBackToGenericMessage() async {
        // reject 只可能是网络/致命鉴权（AuthError）：统一兜底文案
        let model = RedeemModel(redeem: { _ in
            throw AuthError.local("network_error", "网络请求失败")
        })
        model.code = "ANY1-CODE-EEEE-EEEE"
        model.handleSubmit()
        await waitUntil { model.phase == .error }
        XCTAssertEqual(model.message, "兑换失败，请稍后再试")
        XCTAssertEqual(model.code, "ANY1-CODE-EEEE-EEEE")  // 输入保留
    }

    @MainActor
    func testSubmittingBlocksResubmitAndClearsOnDone() async {
        let gate = YesNoGate()
        let model = RedeemModel(redeem: { [gate, self] _ in
            await gate.wait()
            return self.response(200, body: "{}")
        })
        model.code = "SLOW1-CODE-EEEE-EEE"
        model.handleSubmit()
        XCTAssertEqual(model.phase, .submitting)  // submitting 相位
        XCTAssertFalse(model.canSubmit)  // 全控件禁用口径
        // 提交中再点：不重复上送
        model.handleSubmit()
        await waitUntil { gate.calls == 1 }
        XCTAssertEqual(gate.calls, 1)
        gate.open()
        await waitUntil { model.phase == .success }
        XCTAssertEqual(model.canSubmit, false)  // 输入已清空
    }

    // MARK: 通知分类（speakUi.test.ts:74-81 三形态 → redeem 档）

    func testFriendlyNoticeClassifiesQuotaExhaustedForms() {
        let forms = [
            "本月朗读额度已用完，11 月 1 日重置",  // 带重置时间
            "额度已用完，可在「设置 → 账号」用兑换码补足",  // 兑换指路
            "语音识别额度已用完，明天恢复",  // 识别额度同款
        ]
        for form in forms {
            let notice = speakFriendlyNotice(form)
            XCTAssertEqual(notice.kind, .redeem, form)
            XCTAssertTrue(notice.message.contains("额度已用完"))  // message 原样不改写
            XCTAssertEqual(notice.message, form.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        // 其他文案归 other 原样展示
        let other = speakFriendlyNotice("  没听到声音，再试一次  ")
        XCTAssertEqual(other.kind, .other)
        XCTAssertEqual(other.message, "没听到声音，再试一次")  // trim 后原文
    }

    // MARK: 门（挂起传输，驱动 submitting 相位）

    private final class YesNoGate: @unchecked Sendable {
        private let lock = NSLock()
        private var opened = false
        private var waiters: [CheckedContinuation<Void, Never>] = []
        private var callCount = 0

        var calls: Int {
            lock.lock()
            defer { lock.unlock() }
            return callCount
        }

        func wait() async {
            let alreadyOpened = markCalledAndCheck()
            if alreadyOpened { return }
            await withCheckedContinuation { continuation in
                enqueueWaiter(continuation)
            }
        }

        /// 同步段（锁只在同步上下文里短暂持有，不跨挂起点）。
        private func markCalledAndCheck() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            callCount += 1
            return opened
        }

        private func enqueueWaiter(_ continuation: CheckedContinuation<Void, Never>) {
            lock.lock()
            defer { lock.unlock() }
            if opened {
                continuation.resume()
            } else {
                waiters.append(continuation)
            }
        }

        func open() {
            lock.lock()
            opened = true
            let toResume = waiters
            waiters = []
            lock.unlock()
            for continuation in toResume { continuation.resume() }
        }
    }
}
