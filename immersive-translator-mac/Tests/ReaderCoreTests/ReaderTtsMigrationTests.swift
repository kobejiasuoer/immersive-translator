import XCTest
@testable import ReaderCore

// ---------------------------------------------------------------------------
// 旧 xfyun → cloud 迁移谓词单测（对齐 Windows src/core/readerTypes.test.ts:111-124
// 行为向量：仅旧值 xfyun 参与迁移；允许时升格 cloud、不允许保留（不串 Edge）；
// edge/local/cloud 永不被改写）+ TtsProvider 档位枚举。
// ---------------------------------------------------------------------------

final class ReaderTtsMigrationTests: XCTestCase {
    func testOnlyLegacyXfyunParticipates() {
        // xfyun + 任一信号 → 允许迁移。
        XCTAssertTrue(shouldMigrateLegacyTtsProvider(.xfyun, signals: .init(hasAnyXfyunCredential: true, loggedIn: false)))
        XCTAssertTrue(shouldMigrateLegacyTtsProvider(.xfyun, signals: .init(hasAnyXfyunCredential: false, loggedIn: true)))
        XCTAssertTrue(shouldMigrateLegacyTtsProvider(.xfyun, signals: .init(hasAnyXfyunCredential: true, loggedIn: true)))
        // xfyun 但无凭据且未登录 → 不迁移（保留旧「缺凭据→本地回落」语义）。
        XCTAssertFalse(shouldMigrateLegacyTtsProvider(.xfyun, signals: .init(hasAnyXfyunCredential: false, loggedIn: false)))
        // 其它档位永不参与。
        XCTAssertFalse(shouldMigrateLegacyTtsProvider(.edge, signals: .init(hasAnyXfyunCredential: true, loggedIn: true)))
        XCTAssertFalse(shouldMigrateLegacyTtsProvider(.local, signals: .init(hasAnyXfyunCredential: true, loggedIn: true)))
        XCTAssertFalse(shouldMigrateLegacyTtsProvider(.cloud, signals: .init(hasAnyXfyunCredential: true, loggedIn: true)))
    }

    func testMigrateValueUpgradeVsKeep() {
        // 允许 → xfyun 升格 cloud。
        XCTAssertEqual(migrateLegacyTtsProviderValue(.xfyun, migrationAllowed: true), .cloud)
        // 不允许 → 保留 xfyun（不串 Edge）。
        XCTAssertEqual(migrateLegacyTtsProviderValue(.xfyun, migrationAllowed: false), .xfyun)
        // edge/local/cloud 永不被改写。
        XCTAssertEqual(migrateLegacyTtsProviderValue(.edge, migrationAllowed: true), .edge)
        XCTAssertEqual(migrateLegacyTtsProviderValue(.local, migrationAllowed: true), .local)
        XCTAssertEqual(migrateLegacyTtsProviderValue(.cloud, migrationAllowed: true), .cloud)
        XCTAssertEqual(migrateLegacyTtsProviderValue(.cloud, migrationAllowed: false), .cloud)
    }

    func testTtsProviderEnumContract() {
        // 编解码往返（存档兼容）；默认档仍是 edge（零回归红线）。
        XCTAssertEqual(TtsProvider(rawValue: "edge"), .edge)
        XCTAssertEqual(TtsProvider(rawValue: "xfyun"), .xfyun)
        XCTAssertEqual(TtsProvider(rawValue: "cloud"), .cloud)
        XCTAssertEqual(TtsProvider(rawValue: "local"), .local)
        XCTAssertEqual(ReaderSettings.default.ttsProvider, .edge)
        // 档位 label（抽屉 Picker 逐字）。
        XCTAssertEqual(TtsProvider.edge.label, "Edge 在线")
        XCTAssertEqual(TtsProvider.cloud.label, "云音色")
        XCTAssertEqual(TtsProvider.local.label, "系统语音（离线）")
    }
}
