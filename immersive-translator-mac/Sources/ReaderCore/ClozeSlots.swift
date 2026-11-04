import Foundation

// MARK: - 随读抽查（原位句内挖空微测）：选槽与判分限幅的纯逻辑
//
// 对齐 Windows src/core/clozeSlots.ts + ReadingView.tsx 的文案常量（2026-10 原型
// reading-room-cloze 验证过的口径）：
// - 只挖「已读到」的句子：watermark 取 article.progress.sentenceIdx（单调递增的读到哪
//   水位线），读到才考、不剧透未读内容；
// - 每段最多一槽：随读抽查要的是轻量自检，不是满篇填空；
// - 段内排序：生词再现（known，SRS 联动价值最高）> 带直译陷阱的词块 > 其他词块
//  （长词块优先——信息量与挑战度都更高）；
// - 判分走 judgeCloze（本地毫秒级，零 LLM 消耗）；SRS 落档限幅：即时回忆不算「easy」。

/// 一个挖空槽（渲染与判分的最小单元）。偏移为句内 UTF-16（与 ChunkSpan 同坐标系）。
public struct ClozeSlot: Equatable {
    /// `${sentenceIdx}:${start}`——句号 + 跨度起点，重绘后保持稳定。
    public var id: String
    public var sentenceIdx: Int
    public var start: Int
    public var end: Int
    /// 应填的原文（跨度文本，已 trim）。
    public var answer: String
    /// 中式直译陷阱候选（judgeCloze 的 trap 档）。
    public var trap: String?
    /// 词块中文释义（答错时的朱批提示）。
    public var gloss: String?
    /// 生词再现槽：判分联动 SRS（经 vocabId 定位生词本记录）。
    public var isKnown: Bool
    public var vocabId: String?

    public init(
        id: String, sentenceIdx: Int, start: Int, end: Int, answer: String,
        trap: String? = nil, gloss: String? = nil, isKnown: Bool, vocabId: String? = nil
    ) {
        self.id = id
        self.sentenceIdx = sentenceIdx
        self.start = start
        self.end = end
        self.answer = answer
        self.trap = trap
        self.gloss = gloss
        self.isKnown = isKnown
        self.vocabId = vocabId
    }
}

private let clozeMinAnswerChars = 3
private let clozeMaxAnswerWords = 4
/// 只挖纯英文词/短语：混数字或符号的跨度打字体验差（clozeSlots.ts:40 ANSWER_SHAPE）。
private let clozeAnswerShape = try! NSRegularExpression(pattern: "^[A-Za-z][A-Za-z'’ -]*$")

private func clozeAnswerText(_ en: String, _ span: ChunkSpan) -> String {
    let ns = en as NSString
    let start = min(max(0, span.start), ns.length)
    let end = min(max(start, span.end), ns.length)
    return ns.substring(with: NSRange(location: start, length: end - start))
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

private func clozeEligible(_ span: ChunkSpan, en: String) -> Bool {
    let answer = clozeAnswerText(en, span)
    if answer.count < clozeMinAnswerChars { return false }
    if answer.split(whereSeparator: { $0.isWhitespace }).count > clozeMaxAnswerWords { return false }
    let range = NSRange(location: 0, length: (answer as NSString).length)
    return clozeAnswerShape.firstMatch(in: answer, options: [], range: range) != nil
}

/// 段内候选排序权重：known > 带陷阱词块 > 词块（同档长者优先）。
private func clozeSpanWeight(_ span: ChunkSpan) -> Int {
    let len = span.end - span.start
    if span.kind == .known { return 10_000 + len }
    if let trap = span.chunk?.trap, !trap.isEmpty { return 5_000 + len }
    return len
}

/// 产出本文的挖空槽集合：[sentenceIdx: ClozeSlot]。每段选一个权重最高的可挖跨度
///（跨句比较、同权重先到者保留）；整段无可挖跨度则跳过；idx > watermark 的句子不参与。
public func pickClozeSlots(
    spansBySentence: [Int: [ChunkSpan]],
    sentences: [SentencePair],
    watermark: Int
) -> [Int: ClozeSlot] {
    var bestByPara: [Int: (slot: ClozeSlot, weight: Int)] = [:]
    for s in sentences {
        if s.idx > watermark { continue }
        guard let spans = spansBySentence[s.idx] else { continue }
        for span in spans {
            guard clozeEligible(span, en: s.en) else { continue }
            let weight = clozeSpanWeight(span)
            if let prev = bestByPara[s.paragraphIdx], prev.weight >= weight { continue }
            let answer = clozeAnswerText(s.en, span)
            let trap = span.chunk?.trap?.trimmingCharacters(in: .whitespacesAndNewlines)
            let gloss = span.chunk?.gloss.trimmingCharacters(in: .whitespacesAndNewlines)
            let isKnown = span.kind == .known
            bestByPara[s.paragraphIdx] = (
                slot: ClozeSlot(
                    id: "\(s.idx):\(span.start)",
                    sentenceIdx: s.idx,
                    start: span.start,
                    end: span.end,
                    answer: answer,
                    trap: (trap?.isEmpty == false) ? trap : nil,
                    gloss: (gloss?.isEmpty == false) ? gloss : nil,
                    isKnown: isKnown,
                    vocabId: isKnown ? normalizeWordKey(answer) : nil
                ),
                weight: weight
            )
        }
    }
    var picked: [Int: ClozeSlot] = [:]
    for (_, entry) in bestByPara {
        picked[entry.slot.sentenceIdx] = entry.slot
    }
    return picked
}

/// 原位抽查判分 → SRS 档位限幅：即时回忆最高只记 good。
/// perfect → good（不记 easy，防刚见过的词推高间隔）；close → hard；trap / wrong → forgot。
public func clozeVerdictToGrade(_ verdict: RecallVerdict) -> ReviewGrade {
    switch verdict {
    case .perfect: return .good
    case .close: return .hard
    case .trap, .wrong: return .forgot
    }
}

/// 印章四档文案（ReadingView.tsx:117-122 VERDICT_LABEL）。
public func clozeVerdictLabel(_ verdict: RecallVerdict) -> String {
    switch verdict {
    case .perfect: return "命中"
    case .close: return "接近"
    case .trap: return "陷阱"
    case .wrong: return "未中"
    }
}

/// 用过首字母提示的 perfect 降档为 close（ReadingView.tsx:497）。
public func clozeApplyHintPenalty(_ verdict: RecallVerdict, usedHint: Bool) -> RecallVerdict {
    usedHint && verdict == .perfect ? .close : verdict
}

/// 判分后胶带小条文案（ReadingView.tsx:506-510）：known 槽按良好/需复习，词块槽「抽查完成」。
public func clozeToastLabel(isKnown: Bool, verdict: RecallVerdict) -> String {
    guard isKnown else { return "抽查完成" }
    return (verdict == .perfect || verdict == .close) ? "已记入复习 · 良好" : "已记入复习 · 需复习"
}

/// 答错（trap / wrong）时的朱批（ReadingView.tsx:534-536）：有陷阱讲陷阱，否则讲释义；都没有不出。
public func clozeNoteText(_ slot: ClozeSlot) -> String? {
    if let trap = slot.trap, !trap.isEmpty { return "陷阱 · \(trap)" }
    if let gloss = slot.gloss, !gloss.isEmpty { return "释义 · \(gloss)" }
    return nil
}

/// 挖空输入框的无障碍名（ReadingView.tsx:547）：`补全挖空的{生词|词块}：{firstLetters}`。
public func clozeInputAccessibilityLabel(_ slot: ClozeSlot) -> String {
    "补全挖空的\(slot.isKnown ? "生词" : "词块")：\(firstLetters(slot.answer))"
}

/// 随读抽查战绩（ReadingView.tsx:200-214 clozeTally）。
public struct ClozeTally: Equatable {
    public var hit: Int
    public var close: Int
    public var trap: Int
    public var done: Int
    public var todo: Int

    public init(hit: Int = 0, close: Int = 0, trap: Int = 0, done: Int = 0, todo: Int = 0) {
        self.hit = hit
        self.close = close
        self.trap = trap
        self.done = done
        self.todo = todo
    }
}

public func clozeTally(slots: [Int: ClozeSlot], verdicts: [String: RecallVerdict]) -> ClozeTally {
    var tally = ClozeTally()
    for slot in slots.values {
        guard let v = verdicts[slot.id] else { continue }
        tally.done += 1
        switch v {
        case .perfect: tally.hit += 1
        case .close: tally.close += 1
        case .trap: tally.trap += 1
        case .wrong: break
        }
    }
    tally.todo = slots.count - tally.done
    return tally
}

/// 工具栏战绩 meter 文案（ReadingView.tsx:879）。
public func clozeMeterText(_ t: ClozeTally) -> String {
    "抽查 \(t.hit) 命中 · \(t.close) 接近 · \(t.trap) 陷阱 · 剩 \(t.todo)"
}
