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
    static func string(service: String, account: String) throws -> String? {
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
}
