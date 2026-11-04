import Foundation
import XCTest
@testable import ReaderCore

/// 书目目录传输与下载的纯函数（对齐 Windows src-tauri/src/discover.rs:370-517 测试向量）：
/// validateBookId 七坏一好边界；buildBooksQueryItems 默认/空串过滤/clamp；
/// shouldEmitProgress 五断言（262,143/262,144/增量 137,856/恰 524,288/400,001）；
/// parseRetryAfter 四态。（Windows 的 download_result_serializes_camelCase 断言的是
/// serde camelCase IPC 序列化——Mac 同进程直传结构体无该序列化边界，无对应物。）

final class DiscoverServiceTests: XCTestCase {
    // MARK: - validateBookId（与服务端 BOOK_ID_PATTERN/限长 128 对齐）

    func testBookIdAcceptsSlugForms() {
        XCTAssertTrue(validateBookId("alice"))
        XCTAssertTrue(validateBookId("the-art-of-war-2"))
        // 限长边界：恰好 128 字符合法。
        XCTAssertTrue(validateBookId(String(repeating: "a", count: 128)))
    }

    func testBookIdRejectsInvalidForms() {
        for bad in [
            "Alice",          // 大写
            "../etc/passwd",  // 路径穿越
            "a b",            // 空格
            "",               // 空
            "a--b",           // 连续连字符（空段）
            "a.epub",         // 点号
            "书",             // 非 ASCII
        ] {
            XCTAssertFalse(validateBookId(bad), "\(bad) 应判不合法")
        }
        // 129 字符超限。
        XCTAssertFalse(validateBookId(String(repeating: "a", count: 129)))
    }

    // MARK: - buildBooksQueryItems（默认值/空串过滤/透传/clamp）

    func testQueryPairsDefaultsPage1PerPage20() {
        XCTAssertEqual(buildBooksQueryItems(), [
            URLQueryItem(name: "page", value: "1"),
            URLQueryItem(name: "perPage", value: "20"),
        ])
    }

    func testQueryPairsBlankFiltersDroppedAndValuesKept() {
        // 空串/纯空白过滤；带空格的真实关键词原值保留（编码交给 URLComponents）。
        XCTAssertEqual(
            buildBooksQueryItems(q: "po e", language: "  ", category: ""),
            [
                URLQueryItem(name: "q", value: "po e"),
                URLQueryItem(name: "page", value: "1"),
                URLQueryItem(name: "perPage", value: "20"),
            ]
        )
        // 值随 trim 后发送（空格包裹的关键词按 trim 后进对）。
        XCTAssertEqual(
            buildBooksQueryItems(q: "  war  "),
            [
                URLQueryItem(name: "q", value: "war"),
                URLQueryItem(name: "page", value: "1"),
                URLQueryItem(name: "perPage", value: "20"),
            ]
        )
    }

    func testQueryPairsPassthroughAndClamp() {
        // grade 键名透传 + page=0→1 + perPage=500 超上限→100。
        XCTAssertEqual(
            buildBooksQueryItems(grade: "easy", page: 0, perPage: 500),
            [
                URLQueryItem(name: "grade", value: "easy"),
                URLQueryItem(name: "page", value: "1"),
                URLQueryItem(name: "perPage", value: "100"),
            ]
        )
        // perPage=0 → 下限 1；page 正常透传。
        XCTAssertEqual(
            buildBooksQueryItems(page: 3, perPage: 0),
            [
                URLQueryItem(name: "page", value: "3"),
                URLQueryItem(name: "perPage", value: "1"),
            ]
        )
    }

    // MARK: - shouldEmitProgress（256KB=262144 节流阈值）

    func testProgressEmitsEvery256kb() {
        // 不足一档不报、恰满一档报。
        XCTAssertFalse(shouldEmitProgress(lastEmitted: 0, received: 262_143))
        XCTAssertTrue(shouldEmitProgress(lastEmitted: 0, received: 262_144))
        // 上一报 262144、当前 400000：增量 137856（=400000-262144）不足 256KB，不报
        //（蓝图公式 received - last_emitted >= 262_144）。
        XCTAssertFalse(shouldEmitProgress(lastEmitted: 262_144, received: 400_000))
        // 增量恰满 256KB（524288-262144=262144）才报。
        XCTAssertTrue(shouldEmitProgress(lastEmitted: 262_144, received: 524_288))
        XCTAssertFalse(shouldEmitProgress(lastEmitted: 400_000, received: 400_001))
    }

    // MARK: - parseRetryAfter（照 auth.rs 头解析口径：宽松、失败按无头）

    func testRetryAfterHeaderParsedLeniently() {
        XCTAssertEqual(parseRetryAfter("37"), 37)
        // 无头 / 非数字头 / 带空白头。
        XCTAssertNil(parseRetryAfter(nil))
        XCTAssertNil(parseRetryAfter("soon"))
        XCTAssertEqual(parseRetryAfter(" 42 "), 42)
        // 负数不是合法无符号值。
        XCTAssertNil(parseRetryAfter("-1"))
    }
}
