import Foundation
import XfyunCore

// ---------------------------------------------------------------------------
// 语音 REST（对齐 Windows src/lib/voice/voiceRest.ts，契约 §一/§四）：
// 非流式转写 + 发音评测。
// 隐私红线：录音不落盘缓存；上传失败不自动重试（与 TTS 的重试一次刻意不同）。
// 错误按服务端信封 code 归一成 VoiceError，文案映射统一走 voiceErrorMessage。
// ---------------------------------------------------------------------------

/// 流式与 REST 共用的识别语种（契约只有 en_us/zh_cn）。
enum VoiceAsrLang: String {
    case en_us
    case zh_cn
}

/// 评测语种（ise 请求体的 lang 字段）。
enum VoiceIseLang: String {
    case en
    case zh
}

struct AsrBatchResult: Equatable {
    let text: String
    let durationMs: Double?
}

/// POST /v1/voice/asr `{lang, audio(base64 PCM, ≤50 秒)}` → `{text, durationMs}`。
func transcribeBatch(lang: VoiceAsrLang, pcmBase64: String) async throws -> AsrBatchResult {
    // 请求体与 JS `JSON.stringify({ lang, audio })` 同形（键序一致、`/` 不转义）。
    let body = "{\"lang\":\(voiceJsonString(lang.rawValue)),\"audio\":\(voiceJsonString(pcmBase64))}"
    let response = try await voiceRequest(method: "POST", path: "/v1/voice/asr", bodyJson: body)
    let parsed = try requireOkJson(response)
    let text = parsed["text"] as? String ?? ""
    return AsrBatchResult(text: text, durationMs: voiceJsonNumber(parsed["durationMs"]))
}

/// 网关评测结果（服务端统一成客户端 PronunciationResult 形状；5 分制；
/// integrity 网关不下发，单句口径兜底 5，与 XfyunCore 解析器的句级缺省一致）。
struct VoiceIseResult {
    var pronunciation: PronunciationResult

    var total: Double { pronunciation.total }
    var isRejected: Bool { pronunciation.isRejected }
}

/// 解析 words[]：逐条形状校验（content/totalScore 必填），音节/音素字段再校一遍
/// （对齐 Windows parseWord/parsePhones：content 非字符串的条目整条过滤）。
private func parseIseWord(_ raw: Any?) -> WordScore? {
    guard let rec = raw as? [String: Any],
          let content = rec["content"] as? String,
          let totalScore = jsonNumber(rec["totalScore"]) else { return nil }
    let dpMessage = Int(jsonNumber(rec["dpMessage"]) ?? 0)
    let syllsRaw = rec["sylls"] as? [Any] ?? []
    let sylls: [SyllScore] = syllsRaw.compactMap { syllRaw in
        guard let syll = syllRaw as? [String: Any],
              let syllContent = syll["content"] as? String else { return nil }
        let phonesRaw = syll["phones"] as? [Any] ?? []
        let phones: [PhoneScore] = phonesRaw.compactMap { phoneRaw in
            guard let phone = phoneRaw as? [String: Any],
                  let phoneContent = phone["content"] as? String else { return nil }
            return PhoneScore(
                content: phoneContent,
                dpMessage: Int(jsonNumber(phone["dpMessage"]) ?? 0),
                gwpp: jsonNumber(phone["gwpp"]) ?? 0
            )
        }
        return SyllScore(
            content: syllContent,
            syllScore: jsonNumber(syll["syllScore"]) ?? 0,
            serrMsg: Int(jsonNumber(syll["serrMsg"]) ?? 0),
            phones: phones
        )
    }
    return WordScore(content: content, totalScore: totalScore, dpMessage: dpMessage, sylls: sylls)
}

/// JSON 数值读取（对齐 JS `typeof v === "number"`；布尔不算数，见 voiceJsonNumber）。
private func jsonNumber(_ value: Any?) -> Double? {
    voiceJsonNumber(value)
}

/// POST /v1/voice/ise `{refText(≤2000 字), lang:"en", audio}` → 5 分制评分。
func evaluatePronunciation(refText: String, lang: VoiceIseLang, pcmBase64: String) async throws -> VoiceIseResult {
    // 请求体与 JS `JSON.stringify({ refText, lang, audio })` 同形。
    let body = "{\"refText\":\(voiceJsonString(refText)),\"lang\":\(voiceJsonString(lang.rawValue)),\"audio\":\(voiceJsonString(pcmBase64))}"
    let response = try await voiceRequest(method: "POST", path: "/v1/voice/ise", bodyJson: body)
    guard (200..<300).contains(response.status) else {
        throw errorFromHttpResponse(response.status, body: response.body, retryAfterSeconds: response.retryAfterSeconds, headers: response.headers)
    }
    guard let parsed = parseJsonObjectBody(response.body) else {
        throw VoiceError(code: "unknown", message: "评测响应不是 JSON")
    }
    func num(_ key: String) -> Double {
        jsonNumber(parsed[key]) ?? 0
    }
    let words = (parsed["words"] as? [Any] ?? []).compactMap(parseIseWord)
    let integrity = num("integrity")
    let pronunciation = PronunciationResult(
        total: num("total"),
        accuracy: num("accuracy"),
        fluency: num("fluency"),
        standard: num("standard"),
        integrity: integrity != 0 ? integrity : 5, // 网关不下发 integrity：句级兜底 5（同本地解析器）
        isRejected: voiceJsonIsTrue(parsed["isRejected"]),
        exceptInfo: parsed["exceptInfo"] as? String,
        words: words
    )
    return VoiceIseResult(pronunciation: pronunciation)
}
