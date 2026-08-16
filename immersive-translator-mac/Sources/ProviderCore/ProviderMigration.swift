import Foundation

public enum ProviderMigration {
    private static let v1FlagKey = "didMigrateProvidersV1"
    private static let v2RepairFlagKey = "didMigrateProvidersV2"
    private static let importedProviderName = "导入的提供商"

    public static let legacyEndpointKey = "endpoint"
    public static let legacyModelKey = "model"

    /// Repairs persisted provider arrays before running versioned migrations.
    /// Built-ins are restored in their canonical order, duplicate/empty IDs are
    /// removed, and an unambiguous whitespace-only ID change is committed only
    /// after the caller confirms that its credential slot can be copied.
    public static func normalizeStoredProviders(
        _ storedProviders: [ProviderProfile],
        activeProviderID: inout String,
        onProviderIDChange: ((_ oldID: String, _ newID: String) -> Bool)? = nil
    ) -> [ProviderProfile] {
        let builtinIDs = Set(ProviderProfile.builtinPresets.map(\.id))
        var normalized = ProviderProfile.builtinPresets.map { preset in
            storedProviders.first { $0.id == preset.id && $0.isBuiltin } ?? preset
        }
        var seenIDs = builtinIDs

        let trimmedIDCounts = Dictionary(
            grouping: storedProviders.filter { !builtinIDs.contains($0.id) },
            by: { $0.id.trimmingCharacters(in: .whitespacesAndNewlines) }
        ).mapValues(\.count)

        for var provider in storedProviders {
            let originalID = provider.id
            let trimmedID = originalID.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedID.isEmpty,
                  !builtinIDs.contains(originalID),
                  !seenIDs.contains(originalID) else {
                continue
            }

            var normalizedID = originalID
            let canNormalizeID = originalID != trimmedID
                && !builtinIDs.contains(trimmedID)
                && trimmedIDCounts[trimmedID] == 1
                && !seenIDs.contains(trimmedID)
            if canNormalizeID,
               onProviderIDChange?(originalID, trimmedID) ?? true {
                normalizedID = trimmedID
            }

            guard seenIDs.insert(normalizedID).inserted else { continue }
            provider.isBuiltin = false
            if normalizedID == originalID {
                normalized.append(provider)
            } else {
                normalized.append(
                    ProviderProfile(
                        id: normalizedID,
                        displayName: provider.displayName,
                        endpoint: provider.endpoint,
                        model: provider.model,
                        isBuiltin: false,
                        customModels: provider.customModels
                    )
                )
                if activeProviderID == originalID {
                    activeProviderID = normalizedID
                }
            }
        }

        // A previous buggy build may have trimmed only activeProviderID. If the
        // spelling identifies exactly one retained provider, repair it to that
        // provider's actual ID so its Keychain account remains reachable.
        if !normalized.contains(where: { $0.id == activeProviderID }) {
            let trimmedActiveID = activeProviderID.trimmingCharacters(in: .whitespacesAndNewlines)
            let matches = normalized.filter {
                $0.id.trimmingCharacters(in: .whitespacesAndNewlines) == trimmedActiveID
            }
            if matches.count == 1, let matchedID = matches.first?.id {
                activeProviderID = matchedID
            }
        }

        return normalized
    }

    // 迁移: 只处理 endpoint/model/activeProviderID。Key 迁移由 SettingsStore 负责(Keychain 操作)。
    // onProviderIDChange 在 V2 合并旧的导入项时触发，调用方可将旧 provider 的 Keychain 槽复制到新槽。
    @discardableResult
    public static func runIfNeeded(
        providers: inout [ProviderProfile],
        activeProviderID: inout String,
        defaults: UserDefaults = .standard,
        onProviderIDChange: ((_ oldID: String, _ newID: String) -> Bool)? = nil,
        markCompleted: Bool = true
    ) -> Bool {
        let legacyEndpoint = defaults.string(forKey: legacyEndpointKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let legacyModel = defaults.string(forKey: legacyModelKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let needsV1Migration = !defaults.bool(forKey: v1FlagKey)
        let needsV2Repair = !defaults.bool(forKey: v2RepairFlagKey)
        guard needsV1Migration || needsV2Repair else { return false }

        if needsV1Migration {
            migrateLegacyConfiguration(
                endpoint: legacyEndpoint,
                model: legacyModel,
                providers: &providers,
                activeProviderID: &activeProviderID
            )
        }

        // V1 used string suffix matching. Endpoints with a trailing slash,
        // query, fragment, or a provider base path could therefore be imported
        // as a custom provider. Repair only entries carrying V1's generated
        // name so user-created providers on the same host remain untouched.
        var migrationSucceeded = true
        if needsV2Repair {
            migrationSucceeded = repairV1Imports(
                legacyEndpoint: legacyEndpoint,
                legacyModel: legacyModel,
                providers: &providers,
                activeProviderID: &activeProviderID,
                onProviderIDChange: onProviderIDChange
            )
        }
        if markCompleted && migrationSucceeded {
            Self.markCompleted(defaults: defaults)
        }
        return migrationSucceeded
    }

    /// Call only after the migrated provider array and active ID are persisted.
    public static func markCompleted(defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: v1FlagKey)
        defaults.set(true, forKey: v2RepairFlagKey)
    }

    private static func migrateLegacyConfiguration(
        endpoint: String,
        model: String,
        providers: inout [ProviderProfile],
        activeProviderID: inout String
    ) {
        guard !endpoint.isEmpty else { return }

        // Prefer a built-in provider. Otherwise reuse an equivalent custom
        // entry so a partially completed migration cannot append duplicates.
        if let index = providers.firstIndex(where: { $0.isBuiltin && matches($0.endpoint, endpoint) })
            ?? providers.firstIndex(where: { !$0.isBuiltin && matches($0.endpoint, endpoint) }) {
            providers[index].endpoint = endpoint
            if !model.isEmpty {
                providers[index].model = model
                providers[index].appendCustomModel(model)
            }
            activeProviderID = providers[index].id
            return
        }

        let imported = ProviderProfile(
            id: UUID().uuidString,
            displayName: importedProviderName,
            endpoint: endpoint,
            model: model.isEmpty ? "gpt-3.5-turbo" : model,
            isBuiltin: false,
            customModels: model.isEmpty ? [] : [model]
        )
        providers.append(imported)
        activeProviderID = imported.id
    }

    private static func repairV1Imports(
        legacyEndpoint: String,
        legacyModel: String,
        providers: inout [ProviderProfile],
        activeProviderID: inout String,
        onProviderIDChange: ((_ oldID: String, _ newID: String) -> Bool)?
    ) -> Bool {
        guard !legacyEndpoint.isEmpty,
              let builtinIndex = providers.firstIndex(where: {
                  $0.isBuiltin && matches($0.endpoint, legacyEndpoint)
              }) else {
            return true
        }

        let importedIndices = providers.indices.filter { index in
            let provider = providers[index]
            return !provider.isBuiltin
                && provider.displayName == importedProviderName
                && matches(provider.endpoint, legacyEndpoint)
        }
        guard !importedIndices.isEmpty else { return true }

        let builtinID = providers[builtinIndex].id
        let importedProfiles = importedIndices.map { providers[$0] }
        let activeImport = importedProfiles.first { $0.id == activeProviderID }
        let source = activeImport ?? importedProfiles[0]

        // Copy credentials before mutating/removing the source profiles. If a
        // Keychain write fails, leave the imported entries and migration flags
        // untouched so the next launch can retry safely.
        for imported in importedProfiles {
            guard onProviderIDChange?(imported.id, builtinID) ?? true else {
                return false
            }
        }

        // The imported profile holds the exact endpoint/model the user had
        // before V1. Carry those values to the built-in profile while merging
        // model history. Unknown paths never reach this branch because
        // normalizedHost retains them.
        providers[builtinIndex].endpoint = source.endpoint
        let sourceModel = source.model.trimmingCharacters(in: .whitespacesAndNewlines)
        if !sourceModel.isEmpty {
            providers[builtinIndex].model = sourceModel
        } else if !legacyModel.isEmpty {
            providers[builtinIndex].model = legacyModel
        }
        let importedModels = importedProfiles.flatMap { [$0.model] + $0.customModels }
        for model in importedModels + [legacyModel] {
            providers[builtinIndex].appendCustomModel(model)
        }

        if importedProfiles.contains(where: { $0.id == activeProviderID }) {
            activeProviderID = builtinID
        }

        let importedIDs = Set(importedProfiles.map(\.id))
        providers.removeAll { importedIDs.contains($0.id) }
        return true
    }

    public static func matches(_ a: String, _ b: String) -> Bool {
        let ha = normalizedHost(a)
        return !ha.isEmpty && ha == normalizedHost(b)
    }

    // 归一化地址，忽略 scheme、query 和 fragment；未知路径会保留，避免
    // 同域名下的自定义代理路径被误归内置 Provider。
    public static func normalizedHost(_ url: String) -> String {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }

        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        if let components = URLComponents(string: candidate),
           let host = components.host?.trimmingCharacters(in: .whitespacesAndNewlines),
           !host.isEmpty {
            let normalizedHost = host.lowercased()
            let scheme = components.scheme?.lowercased()
            guard scheme == "http" || scheme == "https" else { return "" }
            var path = components.path.lowercased()
            while path.count > 1 && path.hasSuffix("/") {
                path.removeLast()
            }
            let knownCompletionPaths = [
                "/api/paas/v4",
                "/api/paas/v4/chat/completions",
                "/v1",
                "/v1/chat/completions",
                "/chat/completions"
            ]
            var normalizedAddress = normalizedHost
            if let port = components.port,
               !((scheme == "https" && port == 443) || (scheme == "http" && port == 80)) {
                normalizedAddress += ":\(port)"
            }
            if !path.isEmpty && path != "/" && !knownCompletionPaths.contains(path) {
                return "\(normalizedAddress)\(path)"
            }
            return normalizedAddress
        }

        // Keep a conservative fallback for malformed legacy values so that
        // matching remains deterministic without retaining query credentials.
        var fallback = trimmed.lowercased()
        if let schemeEnd = fallback.range(of: "://"),
           !["http", "https"].contains(String(fallback[..<schemeEnd.lowerBound])) {
            return ""
        }
        for prefix in ["https://", "http://"] where fallback.hasPrefix(prefix) {
            fallback.removeFirst(prefix.count)
        }
        fallback = fallback.split(separator: "?", maxSplits: 1).first.map(String.init) ?? fallback
        fallback = fallback.split(separator: "#", maxSplits: 1).first.map(String.init) ?? fallback
        while fallback.hasSuffix("/") {
            fallback.removeLast()
        }
        return fallback
    }
}
