import Foundation

/// 书目目录传输与下载的纯函数（对齐 Windows src-tauri/src/discover.rs:88-156）：
/// 书目 id 预校验、目录查询键值对、下载进度节流、retry-after 头解析。
/// 网络与鉴权在应用层 DiscoverService；这里只放可直接单测的判定逻辑。

/// 书目 id 限长（与服务端 BOOK_ID_MAX_LENGTH 对齐：books.constants.ts）。
public let bookIdMaxLength = 128

/// 下载进度节流阈值：每满 256KB 报一次（Windows 防 IPC 洪泛；Mac 回调口径同款）。
public let downloadProgressChunkBytes: Int64 = 262_144

/// 书目 id 本地预校验（防 URL 拼接穿越第一道）：与服务端
/// BOOK_ID_PATTERN（`^[a-z0-9]+(-[a-z0-9]+)*$`）+ 限长 128 对齐——白名单
/// 排除一切路径字符（/ \ . 与大小写变体）；服务端另有 zod +
/// resolve+startsWith 双保险，这里是客户端第一道，不合式直接不发网络。
public func validateBookId(_ id: String) -> Bool {
    if id.isEmpty || id.utf8.count > bookIdMaxLength { return false }
    return id.split(separator: "-", omittingEmptySubsequences: false).allSatisfy { seg in
        !seg.isEmpty && seg.utf8.allSatisfy { byte in
            (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte)
                || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
        }
    }
}

/// 目录查询键值对（不手拼字符串：q 是用户输入有编码/注入坑，交给 URLComponents
/// 自动百分号编码）。规则：五筛选 trim 非空才进对（空串/纯空白过滤省一次 400 往返，
/// 服务端 zod 本就 trim+min(1)），值随 trim 后发送与服务端 trim 语义等价；长度越界
/// 不拦（服务端 400 有文案，原样透传）；分页对齐服务端默认 page=1 / perPage=20 上限 100。
public func buildBooksQueryItems(
    q: String? = nil,
    language: String? = nil,
    category: String? = nil,
    source: String? = nil,
    grade: String? = nil,
    page: Int? = nil,
    perPage: Int? = nil
) -> [URLQueryItem] {
    var items: [URLQueryItem] = []
    for (key, value) in [("q", q), ("language", language), ("category", category), ("source", source), ("grade", grade)] {
        if let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty {
            items.append(URLQueryItem(name: key, value: trimmed))
        }
    }
    items.append(URLQueryItem(name: "page", value: String(max(1, page ?? 1))))
    items.append(URLQueryItem(name: "perPage", value: String(min(100, max(1, perPage ?? 20)))))
    return items
}

/// 下载进度节流：距上次已上报字节数满 256KB 才再报。
public func shouldEmitProgress(lastEmitted: Int64, received: Int64) -> Bool {
    received - lastEmitted >= downloadProgressChunkBytes
}

/// retry-after 头解析（照 auth.rs 传输层同款：取值→trim→无符号整数，
/// 任何一步失败按无头处理，不报错）。
public func parseRetryAfter(_ header: String?) -> Int? {
    guard let header else { return nil }
    guard let value = UInt64(header.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
    return Int(exactly: value)
}
