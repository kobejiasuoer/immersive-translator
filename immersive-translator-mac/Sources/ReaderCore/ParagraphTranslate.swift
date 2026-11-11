import Foundation

/// 段级翻译协议：一段（若干句）一次请求，编号行保序换回。
///
/// 选段而不是逐句请求，是为了流式渲染有段级颗粒度（「翻译中 N/M 段」），
/// 同时请求数可控；选编号行而不是让模型自由分段，是为了句对对齐不漂移。
/// 对齐 src/core/paragraphTranslate.ts。

/// `^\s*[\[(【]?\s*(\d{1,3})\s*[\])】]?\s*[.、:：]?\s*(.+)$`
/// （ICU 字符类内 `[` 必须转义，否则被当作嵌套集合）
private let numberedLineRegex = try! NSRegularExpression(
    pattern: #"^\s*[\[\(【]?\s*(\d{1,3})\s*[\]\)】]?\s*[.、:：]?\s*(.+)$"#
)

/// 返回 (序号, 行文)；不匹配返回 nil。
private func matchNumberedLine(_ line: String) -> (index: Int, text: String)? {
    let range = NSRange(line.startIndex..., in: line)
    guard let m = numberedLineRegex.firstMatch(in: line, range: range),
          m.numberOfRanges >= 3,
          let idxRange = Range(m.range(at: 1), in: line),
          let textRange = Range(m.range(at: 2), in: line),
          let idx = Int(line[idxRange]) else {
        return nil
    }
    return (idx, String(line[textRange]).trimmingCharacters(in: .whitespaces))
}

/// 段内编号行的输入格式：`[1] Sentence one.`
public func buildParagraphRequestInput(_ sentences: [String]) -> String {
    sentences.enumerated().map { "[\($0.offset + 1)] \($0.element)" }.joined(separator: "\n")
}

/// 解析编号行响应。返回按输入序号对齐的译文数组；行数与序号
/// 无法和输入一一对应时返回 nil（上层把该段标为 failed，可重试）。
public func parseParagraphResponse(_ raw: String, expectedCount: Int) -> [String]? {
    let lines = raw
        .replacingOccurrences(of: "\r\n", with: "\n")
        .replacingOccurrences(of: "\r", with: "\n")
        .components(separatedBy: "\n")
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
    if lines.isEmpty { return nil }

    var byIndex: [Int: String] = [:]
    var numbered = 0
    for line in lines {
        if line.hasPrefix("```") { continue }
        guard let (idx, text) = matchNumberedLine(line) else { continue }
        guard !text.isEmpty, idx >= 1, idx <= expectedCount else { continue }
        if byIndex[idx] == nil {
            byIndex[idx] = text
            numbered += 1
        }
    }

    if numbered != expectedCount {
        // 降级：完全没有编号时，按「非空行数 == 句数」对齐（模型偶尔丢前缀）
        if numbered == 0, lines.count == expectedCount {
            return lines.map {
                $0.replacingOccurrences(of: #"^`{3,}|`{3,}$"#, with: "", options: .regularExpression)
                    .trimmingCharacters(in: .whitespaces)
            }
        }
        return nil
    }
    return (1...expectedCount).compactMap { byIndex[$0] }
}

/// 流式过程中的部分解析：只取已完整的编号行，未到的句子返回 nil。
/// 与 parseParagraphResponse 不同，这允许行数不足（流还在写）。
public func parsePartialNumbered(_ raw: String, expectedCount: Int) -> [String?] {
    var out: [String?] = Array(repeating: nil, count: expectedCount)
    let lines = raw
        .replacingOccurrences(of: "\r\n", with: "\n")
        .replacingOccurrences(of: "\r", with: "\n")
        .components(separatedBy: "\n")
    for line in lines {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !trimmed.hasPrefix("```") else { continue }
        guard let (idx, text) = matchNumberedLine(trimmed) else { continue }
        guard !text.isEmpty, idx >= 1, idx <= expectedCount else { continue }
        if out[idx - 1] == nil { out[idx - 1] = text }
    }
    return out
}

/// 中文句子之间不加空格。
public func joinChineseLines(_ lines: [String]) -> String {
    lines.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined()
}

/// 段落翻译的系统提示词：保序、编号、只输出译文行。
public func buildParagraphTranslateSystemPrompt(
    targetLanguage: String,
    customStyle: String,
    glossaryText: String
) -> String {
    let target = targetLanguage.isEmpty ? "中文" : targetLanguage
    var lines: [String] = [
        "你是专业的英译\(target)译者。输入是若干行带 [N] 编号的英文句子（属于同一段落）。",
        "要求：",
        "1. 逐行翻译成自然的\(target)，保持编号前缀，输出恰好与输入相同数量的行；",
        "2. 输出格式严格为 `[N] 译文`，每行一句，不要合并、不要拆分、不要加任何解释或前后缀；",
        "3. 保留专有名词与数字的准确性；不要输出 Markdown 代码块围栏。"
    ]
    let cleanStyle = customStyle.trimmingCharacters(in: .whitespacesAndNewlines)
    if !cleanStyle.isEmpty {
        lines.append("风格要求：\(cleanStyle)")
    }
    let cleanGlossary = glossaryText.trimmingCharacters(in: .whitespacesAndNewlines)
    if !cleanGlossary.isEmpty {
        lines.append("术语表（优先遵守）：\n\(cleanGlossary)")
    }
    return lines.filter { !$0.isEmpty }.joined(separator: "\n")
}

/// 标题（单行）翻译的系统提示词。
public func buildTitleTranslateSystemPrompt(target: String) -> String {
    [
        "你是专业的英译\(target)译者。把输入的文章标题翻译成简洁自然的\(target)。",
        "只输出译文本身，不要解释、不要引号、不要保留原文。"
    ].joined(separator: "\n")
}

// ---- 429 自动退避（阅读室段级管线专用）----

/// 主动限速间隔（毫秒）：沉浸云网关令牌桶 10 次/分钟（每 6s 回 1 个令牌），
/// 平台请求按此间隔匀速发送，从源头避免 429（每段 2~4s 翻完就立刻发下一段
/// ≈ 20 次/分钟，串行也会打穿令牌桶）。6.5s = 6s 补水 + 0.5s 余量。
/// 第三方 provider 不限速（各家配额远高于此）。
public let translatePacingIntervalMs = 6_500

/// 无 `Retry-After` 头时的回退等待时长（毫秒）。
public let translateBackoffWaitMs = 20_000
/// 每次退避等待的上下限（秒）：服务端给的 `Retry-After` 收敛到这个区间，
/// 防止异常大值让整篇管线挂死、异常小值打穿令牌桶。
public let translateBackoffWaitMinSec = 5
public let translateBackoffWaitMaxSec = 60
/// 连续 429 熔断阈值：连续这么多次 429 且期间没有任何成功请求 → 整篇暂停
///（服务端硬限流/故障时不空转；一旦有成功即清零重新计）。
public let translateMaxConsecutive429 = 10

/// 单段尝试的活动看门狗超时（秒）：正常段落请求十几秒内翻完；网关假死、TLS
/// 半开连接等异常下 URLSession 的资源级超时兜不住流式响应（首字节后停摆不再
/// 触发任何超时），请求会永久挂起、管线停在「翻译中 N/M 段」。看门狗按「自上次
/// 流增量以来的静默时长」计时，慢模型只要还在出字就不会误伤（QA BUG-006）。
public let translateWatchdogTimeoutSeconds: TimeInterval = 180

/// 整篇退避总次数预算：按段数比例给（每段最多摊到 2 次退避），下限 12。
/// 服务端令牌桶 10 次/分钟时，85 段约需 75 次短等待（retry-after≈6s）即可
/// 节流翻完全篇——这正是按比例放宽的原因（旧固定 6 次预算是批量判死的根源）。
public func translateRunBackoffBudget(totalGroups: Int) -> Int {
    max(12, totalGroups * 2)
}

/// 单次 429 退避的决策结果。
public enum TranslateRetryPlan: Equatable {
    /// 等待指定毫秒后重试本段。
    case wait(ms: Int)
    /// 立即落 failed（非 429 错误，维持原判死语义）。
    case failNow
    /// 429 但退避预算耗尽：整篇暂停——当前段与未认领段全部保持 pending，
    /// 不写失败态；用户重开文章/点重试可恢复（旧实现会把剩余段逐个判死）。
    case pauseRun
}

/// 决定一次 429 是否继续退避：等待时长优先取服务端 `Retry-After`（clamp 到
/// 5~60s，无头回退 20s）；连续 429 熔断与整篇总预算任一耗尽即暂停整篇。
///
/// 只用结构化 HTTP 状态码与头，绝不匹配响应文本。
/// Mac 先行版：与 Windows `src/core/paragraphTranslate.ts planTranslateRetry`
///（每段 ≤1 次 + 固定 20s + 封顶 6 次）语义分叉，Windows 待跟进对齐。
public func planTranslateRetry(
    httpStatus: Int?,
    retryAfterSeconds: Int?,
    runBackoffs: Int,
    consecutive429s: Int,
    totalGroups: Int
) -> TranslateRetryPlan {
    guard httpStatus == 429 else { return .failNow }
    if consecutive429s >= translateMaxConsecutive429 { return .pauseRun }
    if runBackoffs >= translateRunBackoffBudget(totalGroups: totalGroups) { return .pauseRun }
    let waitSec: Int
    if let retryAfterSeconds {
        waitSec = min(max(retryAfterSeconds, translateBackoffWaitMinSec), translateBackoffWaitMaxSec)
    } else {
        waitSec = translateBackoffWaitMs / 1000
    }
    return .wait(ms: waitSec * 1000)
}
