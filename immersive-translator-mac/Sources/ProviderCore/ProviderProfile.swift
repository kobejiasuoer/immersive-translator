import Foundation

public struct ProviderProfile: Identifiable, Codable, Equatable {
    public let id: String
    public var displayName: String
    public var endpoint: String
    public var model: String
    public var isBuiltin: Bool
    public var customModels: [String]

    public init(id: String, displayName: String, endpoint: String, model: String, isBuiltin: Bool, customModels: [String]) {
        self.id = id
        self.displayName = displayName
        self.endpoint = endpoint
        self.model = model
        self.isBuiltin = isBuiltin
        self.customModels = Self.normalizedCustomModels(customModels)
    }

    private enum CodingKeys: String, CodingKey {
        case id, displayName, endpoint, model, isBuiltin, customModels
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try container.decode(String.self, forKey: .id),
            displayName: try container.decode(String.self, forKey: .displayName),
            endpoint: try container.decode(String.self, forKey: .endpoint),
            model: try container.decode(String.self, forKey: .model),
            isBuiltin: try container.decode(Bool.self, forKey: .isBuiltin),
            customModels: try container.decodeIfPresent([String].self, forKey: .customModels) ?? []
        )
    }

    // 硬编码厂商官方模型,不进 UserDefaults
    public static let builtinModelCandidates: [String: [String]] = [
        "deepseek": ["deepseek-v4-flash", "deepseek-v4", "deepseek-reasoner"],
        "zhipu":    ["glm-5.2", "glm-5.2-air", "glm-4-flash"],
        "openai":   ["gpt-5.4-mini", "gpt-5.4", "gpt-4o-mini"],
        // 自定义 provider 无内置候选,customModels 是唯一来源
    ]

    public static let builtinPresets: [ProviderProfile] = [
        ProviderProfile(
            id: "deepseek", displayName: "DeepSeek",
            endpoint: "https://api.deepseek.com/chat/completions",
            model: "deepseek-v4-flash",
            isBuiltin: true, customModels: []
        ),
        ProviderProfile(
            id: "zhipu", displayName: "智谱",
            endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
            model: "glm-5.2",
            isBuiltin: true, customModels: []
        ),
        ProviderProfile(
            id: "openai", displayName: "OpenAI",
            endpoint: "https://api.openai.com/v1/chat/completions",
            model: "gpt-5.4-mini",
            isBuiltin: true, customModels: []
        ),
    ]

    // UI 下拉展示用 = 内置候选 + 自定义历史(去重,内置在前,保持插入顺序)
    public var modelCandidates: [String] {
        let builtin = Self.builtinModelCandidates[id] ?? []
        var seen = Set<String>()
        var result: [String] = []
        // Include the currently selected model even when it came from a
        // migrated/custom configuration and is not in either history list.
        for m in [model] + builtin + customModels {
            let trimmed = m.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, !seen.contains(trimmed) else { continue }
            seen.insert(trimmed)
            result.append(trimmed)
        }
        return result
    }

    // 用户自由填了模型名 → 追加到 customModels(去重:对比内置 + 已有;超 8 条淘汰最旧)
    public mutating func appendCustomModel(_ model: String) {
        customModels = Self.normalizedCustomModels(customModels)
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let builtin = Self.builtinModelCandidates[id] ?? []
        guard !builtin.contains(trimmed), !customModels.contains(trimmed) else { return }
        customModels.append(trimmed)
        customModels = Self.normalizedCustomModels(customModels)
    }

    private static func normalizedCustomModels(_ models: [String]) -> [String] {
        var normalized: [String] = []
        for model in models {
            let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            if let existingIndex = normalized.firstIndex(of: trimmed) {
                normalized.remove(at: existingIndex)
            }
            normalized.append(trimmed)
        }
        if normalized.count > 8 {
            normalized = Array(normalized.suffix(8))
        }
        return normalized
    }
}
