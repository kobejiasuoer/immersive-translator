import Foundation

public enum ProviderMigration {
    private static let flagKey = "didMigrateProvidersV1"

    public static let legacyEndpointKey = "endpoint"
    public static let legacyModelKey = "model"

    // 迁移: 只处理 endpoint/model/activeProviderID。Key 迁移由 SettingsStore 负责(Keychain 操作)。
    // 幂等: flag 置上后不再执行。
    public static func runIfNeeded(
        providers: inout [ProviderProfile],
        activeProviderID: inout String,
        defaults: UserDefaults = .standard
    ) {
        guard !defaults.bool(forKey: flagKey) else { return }

        let legacyEndpoint = defaults.string(forKey: legacyEndpointKey) ?? ""
        let legacyModel = defaults.string(forKey: legacyModelKey) ?? ""

        // 1. 优先按 endpoint 匹配三常驻
        if let idx = providers.firstIndex(where: { $0.isBuiltin && matches($0.endpoint, legacyEndpoint) }) {
            if !legacyEndpoint.isEmpty { providers[idx].endpoint = legacyEndpoint }
            if !legacyModel.isEmpty { providers[idx].model = legacyModel }
            activeProviderID = providers[idx].id
        } else if !legacyEndpoint.isEmpty {
            // 2. 匹配不上但旧 endpoint 有效 → 建"导入的提供商"自定义项
            let imported = ProviderProfile(
                id: UUID().uuidString,
                displayName: "导入的提供商",
                endpoint: legacyEndpoint,
                model: legacyModel.isEmpty ? "gpt-3.5-turbo" : legacyModel,
                isBuiltin: false,
                customModels: legacyModel.isEmpty ? [] : [legacyModel]
            )
            providers.append(imported)
            activeProviderID = imported.id
        }
        // else: 旧 endpoint 空(全新安装) → 不动,保持 activeProviderID

        // 3. 置 flag(无论有没有旧数据,只跑一次)
        defaults.set(true, forKey: flagKey)
    }

    public static func matches(_ a: String, _ b: String) -> Bool {
        let ha = normalizedHost(a)
        return !ha.isEmpty && ha == normalizedHost(b)
    }

    // 归一化 host: 小写、去 scheme、去末尾斜杠、去已知 chat completions 路径后缀
    public static func normalizedHost(_ url: String) -> String {
        var s = url.lowercased()
        for prefix in ["https://", "http://"] where s.hasPrefix(prefix) {
            s.removeFirst(prefix.count)
        }
        // 注意: 长后缀必须在前,否则 /v1/chat/completions 会被 /chat/completions 先匹配掉前半
        for suffix in ["/api/paas/v4/chat/completions", "/v1/chat/completions", "/chat/completions"] where s.hasSuffix(suffix) {
            s.removeLast(suffix.count)
        }
        if s.hasSuffix("/") { s.removeLast() }
        return s
    }
}
