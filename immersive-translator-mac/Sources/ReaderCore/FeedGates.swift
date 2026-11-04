import Foundation

/// 订阅源抓取的三道门禁（纯函数，对齐 Windows src-tauri/src/feed.rs:14-50）：
/// URL 校验（trim + scheme 白名单）、状态码转中文文案、2MB 大小门禁。
/// 网络会话在应用层 IntakeService.fetchFeed；这里只放可直接单测的判定逻辑。

/// feed XML 大小上限（订阅源是小文本，远低于 reader_fetch_url 的 5MB 网页上限）。
public let maxFeedBytes: Int64 = 2_000_000

/// 大小门禁两级共用的错误文案。
public let feedTooLargeText = "订阅内容超过 2MB，已取消"

/// 订阅地址校验：trim 首尾空白后解析，解析失败（含无 scheme 的裸字符串、http(s)
/// 缺 host）→「这不是有效的订阅地址」；scheme 不是 http/https（file/javascript/ftp…）
/// →「只支持 http/https 订阅源」。成功返回解析后的 URL 供发请求。
public func feedURLError(_ raw: String) -> Result<URL, FileImportError> {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let parsed = URL(string: trimmed), let scheme = parsed.scheme?.lowercased(), !scheme.isEmpty else {
        return .failure(FileImportError("这不是有效的订阅地址"))
    }
    if scheme != "http" && scheme != "https" {
        return .failure(FileImportError("只支持 http/https 订阅源"))
    }
    // http/https 是 special scheme，Rust Url::parse 对空 host 直接报 EmptyHost（解析失败）。
    guard let host = parsed.host, !host.isEmpty else {
        return .failure(FileImportError("这不是有效的订阅地址"))
    }
    return .success(parsed)
}

/// 状态码转中文文案：401/403 专属文案（含状态码）；其余非 2xx 通用文案含状态码；
/// 2xx 返回 nil 放行。状态码按 reqwest `StatusCode` 的 Display 形态渲染
/// （`401 Unauthorized`：数字 + 标准原因短语），与 Windows 用户所见逐字一致。
public func feedStatusErrorText(_ status: Int) -> String? {
    let rendered = httpStatusDisplay(status)
    if status == 401 || status == 403 {
        return "这个订阅源需要登录或拒绝了访问（\(rendered)）"
    }
    if !(200..<300).contains(status) {
        return "订阅源返回了 \(rendered)"
    }
    return nil
}

/// 大小门禁：content-length 头已知且超上限直接拒绝（不读 body）；头未知（nil，
/// chunked）先放行，读出文本后由调用方以文本字节长度复查同一上限。
/// 恰在 2MB 上限仍放行（`>` 才拒）。
public func feedContentLengthGate(_ contentLength: Int64?) -> String? {
    if let len = contentLength, len > maxFeedBytes {
        return feedTooLargeText
    }
    return nil
}

/// 响应正文解码（对齐 Windows feed.rs:80-83 `resp.text()` = reqwest/encoding_rs 口径）：
/// ① BOM 嗅探优先——UTF-8 / UTF-16LE / UTF-16BE 的 BOM 命中即按其解码并剥掉 BOM
/// （encoding_rs `Encoding::decode` 的 BOM 规则）；② 否则按响应头 Content-Type 的
/// `charset` 选编码（IANA 名经 CFString 映射：iso-8859-1 / gbk / gb2312 / windows-1252…），
/// **只看响应头，不看 XML 声明里的 encoding**；③ charset 缺省 / IANA 名不识别 / 按该编码
/// 解不出 → UTF-8，坏字节以 U+FFFD 替换（等价 encoding_rs 的 lossy 解码）。
/// `charset` 传 `URLResponse.textEncodingName`（URLSession 自 Content-Type charset 派生）。
public func decodeFeedBody(_ data: Data, charset: String?) -> String {
    // ① BOM 嗅探（BOM 存在时覆盖响应头 charset）。
    if data.count >= 3, data[data.startIndex] == 0xEF, data[data.startIndex + 1] == 0xBB, data[data.startIndex + 2] == 0xBF {
        let body = data.dropFirst(3)
        return String(data: body, encoding: .utf8) ?? String(decoding: body, as: UTF8.self)
    }
    if data.count >= 2 {
        let b0 = data[data.startIndex], b1 = data[data.startIndex + 1]
        if b0 == 0xFF, b1 == 0xFE, let text = String(data: data.dropFirst(2), encoding: .utf16LittleEndian) {
            return text
        }
        if b0 == 0xFE, b1 == 0xFF, let text = String(data: data.dropFirst(2), encoding: .utf16BigEndian) {
            return text
        }
    }
    // ② 响应头 charset。
    if let name = charset?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
        let cfEncoding = CFStringConvertIANACharSetNameToEncoding(name as CFString)
        if cfEncoding != kCFStringEncodingInvalidId {
            let nsEncoding = CFStringConvertEncodingToNSStringEncoding(cfEncoding)
            if let text = String(data: data, encoding: String.Encoding(rawValue: nsEncoding)) {
                return text
            }
        }
    }
    // ③ UTF-8 兜底（lossy）。
    return String(data: data, encoding: .utf8) ?? String(decoding: data, as: UTF8.self)
}

/// HTTP 状态码的 `数字 + 标准原因短语` 渲染（对齐 http crate `StatusCode` Display：
/// 未知码渲染为 `<unknown status code>`）。
public func httpStatusDisplay(_ status: Int) -> String {
    "\(status) \(httpCanonicalReason(status) ?? "<unknown status code>")"
}

/// IANA 标准原因短语（http crate canonical_reason 同表）。
public func httpCanonicalReason(_ status: Int) -> String? {
    switch status {
    case 100: return "Continue"
    case 101: return "Switching Protocols"
    case 102: return "Processing"
    case 200: return "OK"
    case 201: return "Created"
    case 202: return "Accepted"
    case 203: return "Non Authoritative Information"
    case 204: return "No Content"
    case 205: return "Reset Content"
    case 206: return "Partial Content"
    case 207: return "Multi-Status"
    case 208: return "Already Reported"
    case 226: return "IM Used"
    case 300: return "Multiple Choices"
    case 301: return "Moved Permanently"
    case 302: return "Found"
    case 303: return "See Other"
    case 304: return "Not Modified"
    case 305: return "Use Proxy"
    case 307: return "Temporary Redirect"
    case 308: return "Permanent Redirect"
    case 400: return "Bad Request"
    case 401: return "Unauthorized"
    case 402: return "Payment Required"
    case 403: return "Forbidden"
    case 404: return "Not Found"
    case 405: return "Method Not Allowed"
    case 406: return "Not Acceptable"
    case 407: return "Proxy Authentication Required"
    case 408: return "Request Timeout"
    case 409: return "Conflict"
    case 410: return "Gone"
    case 411: return "Length Required"
    case 412: return "Precondition Failed"
    case 413: return "Payload Too Large"
    case 414: return "URI Too Long"
    case 415: return "Unsupported Media Type"
    case 416: return "Range Not Satisfiable"
    case 417: return "Expectation Failed"
    case 418: return "I'm a teapot"
    case 421: return "Misdirected Request"
    case 422: return "Unprocessable Entity"
    case 423: return "Locked"
    case 424: return "Failed Dependency"
    case 426: return "Upgrade Required"
    case 428: return "Precondition Required"
    case 429: return "Too Many Requests"
    case 431: return "Request Header Fields Too Large"
    case 451: return "Unavailable For Legal Reasons"
    case 500: return "Internal Server Error"
    case 501: return "Not Implemented"
    case 502: return "Bad Gateway"
    case 503: return "Service Unavailable"
    case 504: return "Gateway Timeout"
    case 505: return "HTTP Version Not Supported"
    case 506: return "Variant Also Negotiates"
    case 507: return "Insufficient Storage"
    case 508: return "Loop Detected"
    case 510: return "Not Extended"
    case 511: return "Network Authentication Required"
    default: return nil
    }
}
