import Foundation
import Security

enum KeychainStoreError: LocalizedError {
    case unexpectedStatus(OSStatus)

    var errorDescription: String? {
        switch self {
        case .unexpectedStatus(let status):
            let message = SecCopyErrorMessageString(status, nil) as String?
            return message ?? "Keychain 返回错误码 \(status)。"
        }
    }
}

enum KeychainStore {
    // MARK: - 测试旁路（R2-SPEAK 边界例外：测试进程不触碰 SecItem*）
    //
    // 冷构建产出的 xctest 二进制签名每次都变，钥匙串条目的 ACL 不信任它，SecItemCopyMatching
    // 会弹「允许访问」授权窗并阻塞到有人点击——无人值守的全量 swift test 因此挂到超时。
    // 测试进程里 string / setString / delete 三个原语全部改走进程内字典，完全不调用
    // SecItem* API；非测试进程三个原语与原实现逐字节一致（生产路径零变化）。
    //
    // 判定：XCTestConfigurationFilePath（Xcode/xcodebuild 跑测试时设置）或 XCTest 框架已
    // 加载（`swift test` 经 xctest 帮助进程运行，实测不设任何 XCTEST* 环境变量，只能靠
    // 框架类存在判定；生产 App 不链接 XCTest，恒为 false）。

    /// 当前是否运行在测试进程内（进程生命周期内恒定，只算一次）。
    private static let isRunningUnderXCTest: Bool =
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
        || NSClassFromString("XCTestCase") != nil

    private static let testStoreLock = NSLock()
    /// 测试进程内的替身存储：key = "\(service)\u{1F}\(account)"。
    private static var testStore: [String: String] = [:]

    private static func testStoreKey(service: String, account: String) -> String {
        "\(service)\u{1F}\(account)"
    }

    static func string(service: String, account: String) throws -> String? {
        if isRunningUnderXCTest {
            testStoreLock.lock()
            defer { testStoreLock.unlock() }
            return testStore[testStoreKey(service: service, account: account)]
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw KeychainStoreError.unexpectedStatus(status)
        }
        guard let data = item as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    static func setString(_ value: String, service: String, account: String) throws {
        if isRunningUnderXCTest {
            // 与真实路径同语义：空串 = 删除
            testStoreLock.lock()
            defer { testStoreLock.unlock() }
            let key = testStoreKey(service: service, account: account)
            if value.isEmpty {
                testStore.removeValue(forKey: key)
            } else {
                testStore[key] = value
            }
            return
        }
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]

        if value.isEmpty {
            try delete(service: service, account: account)
            return
        }

        let attributes: [String: Any] = [
            kSecValueData as String: data
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        guard updateStatus == errSecItemNotFound else {
            throw KeychainStoreError.unexpectedStatus(updateStatus)
        }

        var addQuery = query
        addQuery[kSecValueData as String] = data
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainStoreError.unexpectedStatus(addStatus)
        }
    }

    static func delete(service: String, account: String) throws {
        if isRunningUnderXCTest {
            testStoreLock.lock()
            defer { testStoreLock.unlock() }
            testStore.removeValue(forKey: testStoreKey(service: service, account: account))
            return
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]

        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainStoreError.unexpectedStatus(status)
        }
    }

    // MARK: - Provider-scoped API Key slots

    /// 与 SettingsStore.Keys.keychainService 一致; 旧全局 key 存在 account=legacyAccount,
    /// 新 key 按 providerId 分槽存在 account="apiKey.<providerId>"。
    private static let providerService = "local.immersive-translator.mvp"
    static let legacyAccount = "apiKey"

    /// 读取某 provider 的 key; 不存在或为空返回 nil。
    static func apiKey(for providerId: String) -> String? {
        try? apiKeyThrowing(for: providerId)
    }

    /// 读取某 provider 的 key，并保留 Keychain 错误给迁移/设置流程处理。
    static func apiKeyThrowing(for providerId: String) throws -> String? {
        guard let raw = try string(service: providerService, account: accountKey(for: providerId))?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else {
            return nil
        }
        return raw
    }

    /// 写入某 provider 的 key; 空串表示删除该槽,避免残留失效 key。
    /// 写失败时记日志不抛给 UI(输入仍在内存,下次落盘再试)。
    @discardableResult
    static func setAPIKey(_ value: String, for providerId: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if trimmed.isEmpty {
                try delete(service: providerService, account: accountKey(for: providerId))
            } else {
                try setString(trimmed, service: providerService, account: accountKey(for: providerId))
            }
            let stored = try apiKeyThrowing(for: providerId)
            return trimmed.isEmpty ? stored == nil : stored == trimmed
        } catch {
            DiagnosticLogger.log("keychain.write.failed providerId=\(providerId) error=\(error.localizedDescription)")
            return false
        }
    }

    /// 删除某 provider 的 key 槽(删除自定义 provider 时调用)。
    @discardableResult
    static func deleteAPIKey(for providerId: String) -> Bool {
        do {
            try delete(service: providerService, account: accountKey(for: providerId))
            return true
        } catch {
            DiagnosticLogger.log(
                "keychain.delete.failed providerId=\(providerId) error=\(error.localizedDescription)"
            )
            return false
        }
    }

    /// 批量清空全部 Provider 密钥槽与旧全局密钥（设置危险区「恢复默认」专用）。
    ///
    /// 语义：删 account 为 `apiKey.*` 的全部槽 + `legacyAccount`（含已从列表删除的
    /// 自定义 provider 残槽）；账号令牌槽 `serverAuthAccount` 保留（Windows 侧 vault
    /// 整体覆写为单空桶的等价物——那边 vault 与账号令牌本就分存）。
    /// 返回被清除的 account 列表；个别槽删除失败记日志跳过，不中断其余清理。
    @discardableResult
    static func deleteAllProviderAPIKeySlots() -> [String] {
        let targets = allProviderKeySlotAccounts()
        var cleared: [String] = []
        for account in targets {
            do {
                try delete(service: providerService, account: account)
                cleared.append(account)
            } catch {
                DiagnosticLogger.log(
                    "keychain.reset.delete.failed account=\(account) error=\(error.localizedDescription)"
                )
            }
        }
        return cleared
    }

    /// 枚举该 service 下全部 `apiKey.*` 槽与 legacyAccount（测试进程枚举替身字典）。
    private static func allProviderKeySlotAccounts() -> [String] {
        if isRunningUnderXCTest {
            testStoreLock.lock()
            defer { testStoreLock.unlock() }
            let prefix = "\(providerService)\u{1F}"
            return testStore.keys.compactMap { key in
                guard key.hasPrefix(prefix) else { return nil }
                let account = String(key.dropFirst(prefix.count))
                return account == legacyAccount || account.hasPrefix("apiKey.") ? account : nil
            }.sorted()
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: providerService,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll
        ]
        var items: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &items)
        guard status == errSecSuccess, let array = items as? [[String: Any]] else {
            if status != errSecItemNotFound {
                DiagnosticLogger.log("keychain.reset.enumerate.failed status=\(status)")
            }
            return []
        }
        return array
            .compactMap { $0[kSecAttrAccount as String] as? String }
            .filter { $0 == legacyAccount || $0.hasPrefix("apiKey.") }
            .sorted()
    }

    /// Copies a provider credential without conflating a Keychain read failure
    /// with a missing item. The source slot is intentionally retained so a
    /// migration never destroys the only recoverable copy.
    static func copyAPIKeyIfNeeded(from oldProviderId: String, to newProviderId: String) -> Bool {
        do {
            let destination = try apiKeyThrowing(for: newProviderId)
            let source = try apiKeyThrowing(for: oldProviderId)
            guard let source, !source.isEmpty else {
                return true
            }
            if let destination, !destination.isEmpty {
                guard destination == source else {
                    DiagnosticLogger.log(
                        "keychain.copy.conflict oldProviderId=\(oldProviderId) newProviderId=\(newProviderId)"
                    )
                    return false
                }
                return true
            }
            return setAPIKey(source, for: newProviderId)
        } catch {
            DiagnosticLogger.log(
                "keychain.copy.failed oldProviderId=\(oldProviderId) newProviderId=\(newProviderId) error=\(error.localizedDescription)"
            )
            return false
        }
    }

    private static func accountKey(for providerId: String) -> String {
        "apiKey.\(providerId)"
    }

    // MARK: - 服务端账号双令牌槽（server_auth，auth 模块专用）
    //
    // 对齐 Windows secret_store.rs 的 AUTH_SLOT 保留名：双令牌单槽 JSON
    // （accessToken/refreshToken/accessExpiresAt/user 一次写入保证配套）。
    // 既有 providerService 不动；此槽只经 ServerAuth.swift 的
    // KeychainAuthTokenStore 读写，令牌绝不落明文文件、不跨层暴露。

    /// 双令牌槽 account 名（保留名，不与 apiKey.<providerId> 冲突）。
    static let serverAuthAccount = "server_auth"

    /// 读取双令牌槽原始 JSON；不存在返回 nil，读取失败同样返回 nil 并留日志
    /// （登录态按「未登录」处理，不让 Keychain 故障阻断启动）。
    static func loadServerAuthTokenJSON() -> String? {
        do {
            return try string(service: providerService, account: serverAuthAccount)
        } catch {
            DiagnosticLogger.log(
                "keychain.serverAuth.read.failed error=\(error.localizedDescription)"
            )
            return nil
        }
    }

    /// 写入双令牌槽原始 JSON（空串等于删除，沿用 setString 语义）。
    static func saveServerAuthTokenJSON(_ json: String) throws {
        try setString(json, service: providerService, account: serverAuthAccount)
    }

    /// 删除双令牌槽（登出/凭据失效时调用；条目不存在也成功）。
    static func clearServerAuthToken() throws {
        try delete(service: providerService, account: serverAuthAccount)
    }
}
