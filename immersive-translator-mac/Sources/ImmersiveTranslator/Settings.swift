import AppKit
import Carbon
import ProviderCore
import SwiftUI
import UniformTypeIdentifiers

final class SettingsStore: ObservableObject {
    // MARK: - Provider configuration (multi-provider)

    @Published var providers: [ProviderProfile] {
        didSet { persistProviders() }
    }
    @Published var activeProviderID: String {
        didSet { UserDefaults.standard.set(activeProviderID, forKey: Keys.activeProviderID) }
    }
    @Published var editingAPIKey: String = ""

    var activeProvider: ProviderProfile {
        providers.first { $0.id == activeProviderID } ?? providers[0]
    }

    @Published var apiKeyStorageError: String?
    @Published var hotKeyRegistrationMessage: String?
    @Published var providerDiagnosticRequestID: UUID?

    @Published var targetLanguage: String {
        didSet { UserDefaults.standard.set(targetLanguage, forKey: Keys.targetLanguage) }
    }

    @Published var translationDirection: TranslationDirection {
        didSet { UserDefaults.standard.set(translationDirection.rawValue, forKey: Keys.translationDirection) }
    }

    @Published var ocrMode: OCRRecognitionMode {
        didSet { UserDefaults.standard.set(ocrMode.rawValue, forKey: Keys.ocrMode) }
    }

    @Published var ocrLanguagePreset: OCRLanguagePreset {
        didSet { UserDefaults.standard.set(ocrLanguagePreset.rawValue, forKey: Keys.ocrLanguagePreset) }
    }

    @Published var enableStreamingTranslation: Bool {
        didSet { UserDefaults.standard.set(enableStreamingTranslation, forKey: Keys.enableStreamingTranslation) }
    }

    @Published var customPrompt: String {
        didSet { UserDefaults.standard.set(customPrompt, forKey: Keys.customPrompt) }
    }

    @Published var glossaryText: String {
        didSet { UserDefaults.standard.set(glossaryText, forKey: Keys.glossaryText) }
    }

    @Published var selectionHotKeyShortcut: HotKeyShortcut {
        didSet { UserDefaults.standard.set(selectionHotKeyShortcut.rawValue, forKey: Keys.selectionHotKeyShortcut) }
    }

    @Published var ocrHotKeyShortcut: HotKeyShortcut {
        didSet { UserDefaults.standard.set(ocrHotKeyShortcut.rawValue, forKey: Keys.ocrHotKeyShortcut) }
    }

    init() {
        // 用局部变量完成所有计算,避免在存储属性初始化前访问 self(didSet 会触发 self 访问)。

        // 1. 加载 providers(从 UserDefaults 的 JSON;失败回退三常驻)
        var loadedProviders: [ProviderProfile]
        if let data = UserDefaults.standard.data(forKey: Keys.providers),
           let decoded = try? JSONDecoder().decode([ProviderProfile].self, from: data),
           !decoded.isEmpty {
            loadedProviders = decoded
        } else {
            loadedProviders = ProviderProfile.builtinPresets
        }
        // 兜底:保证至少含三常驻
        if !loadedProviders.contains(where: { $0.isBuiltin }) {
            loadedProviders = ProviderProfile.builtinPresets + loadedProviders
        }

        // 2. activeProviderID 初值(迁移前先取存档,没有则 deepseek)
        var resolvedActiveID = UserDefaults.standard.string(forKey: Keys.activeProviderID) ?? ProviderProfile.builtinPresets[0].id

        // 3. 迁移旧 endpoint/model/activeProviderID(只跑一次,幂等)
        ProviderMigration.runIfNeeded(providers: &loadedProviders, activeProviderID: &resolvedActiveID)

        // 4. 迁移旧 Key(旧全局 account=apiKey → 当前 active 槽;仅当新槽为空时)
        if let legacyKey = try? KeychainStore.string(service: Keys.keychainService, account: KeychainStore.legacyAccount),
           !legacyKey.isEmpty,
           KeychainStore.apiKey(for: resolvedActiveID) == nil {
            KeychainStore.setAPIKey(legacyKey, for: resolvedActiveID)
        }

        // 5. active 合法性兜底
        if !loadedProviders.contains(where: { $0.id == resolvedActiveID }) {
            resolvedActiveID = ProviderProfile.builtinPresets[0].id
        }

        // 6. 先初始化无 didSet 的存储属性,再赋值带 didSet 的(providers/activeProviderID)
        targetLanguage = UserDefaults.standard.string(forKey: Keys.targetLanguage) ?? "简体中文"
        translationDirection = TranslationDirection(rawValue: UserDefaults.standard.string(forKey: Keys.translationDirection) ?? "") ?? .autoChineseEnglish
        ocrMode = OCRRecognitionMode(rawValue: UserDefaults.standard.string(forKey: Keys.ocrMode) ?? "") ?? .accurate
        ocrLanguagePreset = OCRLanguagePreset(rawValue: UserDefaults.standard.string(forKey: Keys.ocrLanguagePreset) ?? "") ?? .autoMixed
        enableStreamingTranslation = UserDefaults.standard.object(forKey: Keys.enableStreamingTranslation) as? Bool ?? true
        customPrompt = UserDefaults.standard.string(forKey: Keys.customPrompt) ?? ""
        glossaryText = UserDefaults.standard.string(forKey: Keys.glossaryText) ?? ""
        selectionHotKeyShortcut = Self.loadSelectionHotKeyShortcut()
        ocrHotKeyShortcut = Self.loadOCRHotKeyShortcut()

        // 最后赋值带 didSet 的存储属性(self 此时已完全初始化)
        providers = loadedProviders
        activeProviderID = resolvedActiveID
        editingAPIKey = KeychainStore.apiKey(for: resolvedActiveID) ?? ""
    }

    var displayTargetLanguage: String {
        switch translationDirection {
        case .autoChineseEnglish:
            return "自动"
        case .fixedTarget:
            let target = targetLanguage.trimmingCharacters(in: .whitespacesAndNewlines)
            return target.isEmpty ? "简体中文" : target
        }
    }

    // MARK: - Provider switching & persistence

    /// 切换当前 provider:先把编辑态 key 落盘到旧 id,再从新 id 加载。
    /// 诊断状态(providerDiagnostic/providerPresetMessage)是 View 的 @State,
    /// 由 SettingsView 的 .onChange(of: activeProviderID) 重置,不在这里处理。
    func switchActiveProvider(to id: String) {
        guard id != activeProviderID, providers.contains(where: { $0.id == id }) else { return }
        persistEditingAPIKey(for: activeProviderID)
        activeProviderID = id
        editingAPIKey = KeychainStore.apiKey(for: id) ?? ""
    }

    /// 失焦/切换/退出时把编辑态 key 落盘到指定 provider 槽。
    func persistEditingAPIKey(for id: String) {
        KeychainStore.setAPIKey(editingAPIKey, for: id)
    }

    /// 用户在当前 provider 自由填了模型名 → 追加到 customModels。
    func recordCustomModel(_ model: String) {
        guard let idx = providers.firstIndex(where: { $0.id == activeProviderID }) else { return }
        providers[idx].appendCustomModel(model)
    }

    /// 删除自定义 provider(常驻不可删);同步清 Keychain 槽;若删的是 active 则回退 deepseek。
    func deleteCustomProvider(_ id: String) {
        guard let target = providers.first(where: { $0.id == id }), !target.isBuiltin else { return }
        providers.removeAll { $0.id == id }
        KeychainStore.deleteAPIKey(for: id)
        if activeProviderID == id {
            switchActiveProvider(to: ProviderProfile.builtinPresets[0].id)
        }
    }

    /// 修改当前 active provider 的字段(供 UI 的 Binding set 使用)。
    func updateActiveProvider(_ transform: (inout ProviderProfile) -> Void) {
        guard let idx = providers.firstIndex(where: { $0.id == activeProviderID }) else { return }
        transform(&providers[idx])
    }

    private func persistProviders() {
        if let data = try? JSONEncoder().encode(providers) {
            UserDefaults.standard.set(data, forKey: Keys.providers)
        }
    }

    private static func loadSelectionHotKeyShortcut() -> HotKeyShortcut {
        if let rawValue = UserDefaults.standard.string(forKey: Keys.selectionHotKeyShortcut),
           let shortcut = HotKeyShortcut(rawValue: rawValue) {
            return shortcut
        }

        switch UserDefaults.standard.string(forKey: Keys.selectionHotKeyPreset) {
        case "controlOptionT":
            return HotKeyShortcut(keyCode: UInt32(kVK_ANSI_T), modifiers: UInt32(controlKey | optionKey), keyLabel: "T")
        default:
            return .optionSpace
        }
    }

    private static func loadOCRHotKeyShortcut() -> HotKeyShortcut {
        if let rawValue = UserDefaults.standard.string(forKey: Keys.ocrHotKeyShortcut),
           let shortcut = HotKeyShortcut(rawValue: rawValue) {
            return shortcut
        }

        switch UserDefaults.standard.string(forKey: Keys.ocrHotKeyPreset) {
        case "controlOptionO":
            return HotKeyShortcut(keyCode: UInt32(kVK_ANSI_O), modifiers: UInt32(controlKey | optionKey), keyLabel: "O")
        default:
            return .controlOptionSpace
        }
    }

    private enum Keys {
        static let keychainService = "local.immersive-translator.mvp"
        static let providers = "providers"
        static let activeProviderID = "activeProviderID"
        static let targetLanguage = "targetLanguage"
        static let translationDirection = "translationDirection"
        static let ocrMode = "ocrMode"
        static let ocrLanguagePreset = "ocrLanguagePreset"
        static let enableStreamingTranslation = "enableStreamingTranslation"
        static let customPrompt = "customPrompt"
        static let glossaryText = "glossaryText"
        static let selectionHotKeyShortcut = "selectionHotKeyShortcut"
        static let ocrHotKeyShortcut = "ocrHotKeyShortcut"
        static let selectionHotKeyPreset = "selectionHotKeyPreset"
        static let ocrHotKeyPreset = "ocrHotKeyPreset"
    }
}

enum TranslationDirection: String, CaseIterable, Identifiable {
    case autoChineseEnglish
    case fixedTarget

    var id: String { rawValue }

    var title: String {
        switch self {
        case .autoChineseEnglish:
            return "中英互译"
        case .fixedTarget:
            return "固定目标语言"
        }
    }

    var detail: String {
        switch self {
        case .autoChineseEnglish:
            return "中文自动翻成英文，其他语言自动翻成简体中文。"
        case .fixedTarget:
            return "始终翻译到下面填写的目标语言。"
        }
    }
}

enum OCRRecognitionMode: String, CaseIterable, Identifiable {
    case accurate
    case fast

    var id: String { rawValue }

    var title: String {
        switch self {
        case .accurate:
            return "准确"
        case .fast:
            return "快速"
        }
    }
}

enum OCRLanguagePreset: String, CaseIterable, Identifiable {
    case autoMixed
    case chineseEnglish
    case english
    case japanese
    case korean

    var id: String { rawValue }

    var title: String {
        switch self {
        case .autoMixed:
            return "混合"
        case .chineseEnglish:
            return "中英"
        case .english:
            return "英文"
        case .japanese:
            return "日文"
        case .korean:
            return "韩文"
        }
    }

    var recognitionLanguages: [String] {
        switch self {
        case .autoMixed:
            return ["en-US", "zh-Hans", "zh-Hant", "ja-JP", "ko-KR"]
        case .chineseEnglish:
            return ["zh-Hans", "zh-Hant", "en-US"]
        case .english:
            return ["en-US"]
        case .japanese:
            return ["ja-JP", "en-US"]
        case .korean:
            return ["ko-KR", "en-US"]
        }
    }

    var fallbackPresets: [OCRLanguagePreset] {
        switch self {
        case .autoMixed:
            return []
        case .japanese:
            return [.autoMixed]
        default:
            return [.autoMixed, .japanese]
        }
    }
}

private enum ProviderConfigurationAdvisor {
    static func sensitiveQueryItemsMessage(for urlString: String) -> String? {
        let sensitiveQueryNames = TranslationClient.sensitiveQueryItemNames(in: urlString)
        guard !sensitiveQueryNames.isEmpty else {
            return nil
        }

        let names = sensitiveQueryNames.joined(separator: "、")
        return "接口地址 query 里包含疑似凭证（\(names)）。建议把密钥移到 API Key 字段，避免复制地址、诊断报告或代理日志时泄露；App 会在日志和报告里自动脱敏。"
    }
}

private struct ProviderConnectionDiagnostic {
    let level: ProviderConnectionDiagnosticLevel
    let endpoint: String
    let message: String
    var kind: ProviderDiagnosticKind = .none
    var completedAt: Date?
    var elapsed: TimeInterval?
    var statusCode: Int?
    var requestURL: String?
    var model: String?

    static let idle = ProviderConnectionDiagnostic(
        level: .idle,
        endpoint: "",
        message: "尚未测试当前接口。",
        kind: .none
    )
}

private enum ProviderDiagnosticKind: String {
    case none
    case connection
    case translation
    case cancelled
    case configuration

    var title: String {
        switch self {
        case .none:
            return "未测试"
        case .connection:
            return "连通性测试"
        case .translation:
            return "真实翻译验证"
        case .cancelled:
            return "已取消"
        case .configuration:
            return "配置检查"
        }
    }
}

private struct ProviderLatencyAssessment {
    let label: String
    let detail: String
    let nextStepText: String?

    var reportText: String {
        "\(label)：\(detail)"
    }

    static func make(
        kind: ProviderDiagnosticKind,
        elapsed: TimeInterval?,
        isLocalEndpoint: Bool
    ) -> ProviderLatencyAssessment? {
        guard let elapsed else { return nil }

        switch kind {
        case .connection:
            return connectionAssessment(elapsed: elapsed, isLocalEndpoint: isLocalEndpoint)
        case .translation:
            return translationAssessment(elapsed: elapsed, isLocalEndpoint: isLocalEndpoint)
        case .none, .cancelled, .configuration:
            return nil
        }
    }

    private static func connectionAssessment(
        elapsed: TimeInterval,
        isLocalEndpoint: Bool
    ) -> ProviderLatencyAssessment {
        if isLocalEndpoint {
            if elapsed <= 2 {
                return ProviderLatencyAssessment(
                    label: "本地连接正常",
                    detail: "本地兼容接口首个响应及时。",
                    nextStepText: nil
                )
            }
            if elapsed <= 5 {
                return ProviderLatencyAssessment(
                    label: "本地连接偏慢",
                    detail: "本地服务可能正在冷启动、加载模型，或端口代理响应较慢。",
                    nextStepText: "本地入口偏慢，先确认 Ollama/本地代理已启动并完成模型加载。"
                )
            }
            return ProviderLatencyAssessment(
                label: "本地连接很慢",
                detail: "本地接口首个响应已经明显偏慢，日常翻译会有等待感。",
                nextStepText: "本地入口很慢，优先检查模型是否卡在加载、机器负载和本地代理端口。"
            )
        }

        if elapsed < 1.5 {
            return ProviderLatencyAssessment(
                label: "连接正常",
                detail: "服务商入口或代理链路首个响应及时。",
                nextStepText: nil
            )
        }
        if elapsed <= 4 {
            return ProviderLatencyAssessment(
                label: "连接偏慢",
                detail: "服务商入口、跨境网络或代理链路已有可感知等待。",
                nextStepText: "入口响应偏慢，优先检查网络/代理/服务商入口；真实请求更慢时再看模型排队。"
            )
        }
        return ProviderLatencyAssessment(
            label: "连接很慢",
            detail: "入口首个响应已经明显偏慢，模型再快也会有等待感。",
            nextStepText: "入口响应很慢，建议切换网络/代理或低延迟预设，稍后再验证真实请求。"
        )
    }

    private static func translationAssessment(
        elapsed: TimeInterval,
        isLocalEndpoint: Bool
    ) -> ProviderLatencyAssessment {
        if isLocalEndpoint {
            if elapsed <= 6 {
                return ProviderLatencyAssessment(
                    label: "本地短翻译正常",
                    detail: "本地模型完成短文本翻译的耗时在可接受范围内。",
                    nextStepText: nil
                )
            }
            if elapsed <= 12 {
                return ProviderLatencyAssessment(
                    label: "本地短翻译偏慢",
                    detail: "本机模型可能在冷启动、上下文加载，或受 CPU/GPU/内存压力影响。",
                    nextStepText: "本地短翻译偏慢，优先确认模型已预热，并检查本机 CPU/GPU/内存占用。"
                )
            }
            return ProviderLatencyAssessment(
                label: "本地短翻译很慢",
                detail: "短文本都需要较长时间，日常 OCR 段落会更容易等待。",
                nextStepText: "本地短翻译很慢，建议换更小模型、提前预热，或临时切到云端低延迟预设。"
            )
        }

        if elapsed < 3 {
            return ProviderLatencyAssessment(
                label: "短翻译正常",
                detail: "短文本完整翻译返回及时。",
                nextStepText: nil
            )
        }
        if elapsed <= 8 {
            return ProviderLatencyAssessment(
                label: "短翻译偏慢",
                detail: "短文本验证已有等待感，可能是模型排队、服务商限速或非流式完整返回较慢。",
                nextStepText: "短翻译偏慢，建议开启流式显示；若仍慢，再切换低延迟模型或预设。"
            )
        }
        return ProviderLatencyAssessment(
            label: "短翻译很慢",
            detail: "短文本验证已经明显偏慢，日常长段落会更容易卡住。",
            nextStepText: "短翻译很慢，优先检查模型排队/限速，或切换低延迟预设后重新验证。"
        )
    }
}

private enum ProviderConnectionDiagnosticLevel: Equatable {
    case idle
    case success
    case warning
    case failure

    var title: String {
        switch self {
        case .idle:
            return "未测试"
        case .success:
            return "成功"
        case .warning:
            return "需要检查"
        case .failure:
            return "失败"
        }
    }

    var color: Color {
        switch self {
        case .idle:
            return .secondary
        case .success:
            return .green
        case .warning:
            return .orange
        case .failure:
            return .red
        }
    }
}

private struct ProviderConnectionBodyInspection {
    let level: ProviderConnectionDiagnosticLevel
    let message: String
}

private enum ProviderConnectionBodyInspector {
    static func inspect(data: Data, elapsedText: String) -> ProviderConnectionBodyInspection? {
        guard !data.isEmpty else { return nil }

        if let errorMessage = TranslationResponseErrorParser.message(from: data) {
            let nextStep = diagnosticNextStep(
                from: errorMessage,
                fallback: "请继续验证翻译请求，或按该提示检查 Key、模型、额度和权限。"
            )
            return ProviderConnectionBodyInspection(
                level: .warning,
                message: "接口已连通，首个响应 \(elapsedText)，但响应正文是错误 JSON：\(compactPreview(errorMessage))。\(nextStep)"
            )
        }

        if (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) != nil {
            return nil
        }

        guard let text = String(data: data.prefix(240), encoding: .utf8) else {
            return ProviderConnectionBodyInspection(
                level: .warning,
                message: "接口已连通，首个响应 \(elapsedText)，但响应正文不是 UTF-8 JSON。请检查代理、网关或接口地址是否返回了二进制/压缩内容。"
            )
        }

        let preview = compactPreview(text)
        guard !preview.isEmpty else { return nil }

        if looksLikeHTML(preview) {
            let nextStep = diagnosticNextStep(
                from: preview,
                fallback: "请检查地址是否填成控制台网页、代理登录页，或缺少 Chat Completions 路径。"
            )
            return ProviderConnectionBodyInspection(
                level: .warning,
                message: "接口已连通，首个响应 \(elapsedText)，但返回的是网页或网关页：\(preview)。\(nextStep)"
            )
        }

        let nextStep = diagnosticNextStep(
            from: preview,
            fallback: "请确认地址指向 Chat Completions 兼容接口，而不是健康检查页、普通网页或代理提示。"
        )
        return ProviderConnectionBodyInspection(
            level: .warning,
            message: "接口已连通，首个响应 \(elapsedText)，但返回的是非 JSON 文本：\(preview)。\(nextStep)"
        )
    }

    private static func diagnosticNextStep(from message: String, fallback: String) -> String {
        guard let issue = TranslationErrorIssue.classify(statusCode: nil, message: message) else {
            return fallback
        }
        return "判断为「\(issue.statusMessage)」。\(issue.diagnosticNextStep)"
    }

    private static func compactPreview(_ text: String, maxLength: Int = 120) -> String {
        let compact = text
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard compact.count > maxLength else { return compact }
        return "\(compact.prefix(maxLength))..."
    }

    private static func looksLikeHTML(_ text: String) -> Bool {
        let lowercased = text.lowercased()
        return lowercased.hasPrefix("<!doctype")
            || lowercased.hasPrefix("<html")
            || lowercased.contains("<body")
            || lowercased.contains("</html>")
            || lowercased.contains("cloudflare")
            || lowercased.contains("nginx")
            || lowercased.contains("login")
            || lowercased.contains("sign in")
            || lowercased.contains("captcha")
    }
}

private struct ProviderConfigurationHint: Identifiable {
    let id: String
    let level: ProviderConfigurationHintLevel
    let message: String
}

private struct TranslationStylePreset: Identifiable {
    let id: String
    let title: String
    let prompt: String

    static let all: [TranslationStylePreset] = [
        TranslationStylePreset(
            id: "natural",
            title: "自然口语",
            prompt: "译文要自然、顺口，像母语者日常会说的话；不要逐字硬翻。"
        ),
        TranslationStylePreset(
            id: "technical",
            title: "技术文档",
            prompt: "面向技术文档翻译：保留代码、命令、API 名称、路径和配置键；术语稳定一致，句子清晰准确。"
        ),
        TranslationStylePreset(
            id: "ui",
            title: "产品 UI",
            prompt: "面向产品界面和按钮文案翻译：短句优先简洁，动作词统一，避免冗长解释。"
        ),
        TranslationStylePreset(
            id: "faithful",
            title: "忠实原文",
            prompt: "尽量忠实保留原文结构、语气和信息顺序；不要补充原文没有的信息。"
        )
    ]
}

private enum ProviderConfigurationHintLevel {
    case info
    case warning
    case failure

    var color: Color {
        switch self {
        case .info:
            return .secondary
        case .warning:
            return .orange
        case .failure:
            return .red
        }
    }

    var systemImage: String {
        switch self {
        case .info:
            return "info.circle"
        case .warning:
            return "exclamationmark.triangle"
        case .failure:
            return "xmark.octagon"
        }
    }
}

private struct GlossarySummary {
    let nonEmptyLineCount: Int
    let mappingCount: Int
    let effectiveMappingCount: Int
    let requestMappingCount: Int
    let overflowMappingCount: Int
    let ignoredLineCount: Int
    let ignoredLineSamples: [String]
    let duplicateSources: [String]
    let sampleMappings: [GlossaryMapping]
    let lastRequestMapping: GlossaryMapping?
    let firstOverflowMapping: GlossaryMapping?

    var isEmpty: Bool {
        nonEmptyLineCount == 0
    }

    static func make(from text: String) -> GlossarySummary {
        let result = GlossaryParser.parse(text)
        let effectiveMappings = result.effectiveMappings
        let requestMappings = Array(effectiveMappings.prefix(GlossaryParser.promptMappingLimit))
        let overflowMappings = Array(effectiveMappings.dropFirst(GlossaryParser.promptMappingLimit))

        return GlossarySummary(
            nonEmptyLineCount: result.nonEmptyLineCount,
            mappingCount: result.mappings.count,
            effectiveMappingCount: effectiveMappings.count,
            requestMappingCount: requestMappings.count,
            overflowMappingCount: overflowMappings.count,
            ignoredLineCount: result.ignoredLineCount,
            ignoredLineSamples: result.ignoredLineSamples,
            duplicateSources: result.duplicateSources,
            sampleMappings: Array(effectiveMappings.prefix(3)),
            lastRequestMapping: requestMappings.last,
            firstOverflowMapping: overflowMappings.first
        )
    }
}

final class SettingsWindowController: NSWindowController {
    private let settingsStore: SettingsStore

    init(settingsStore: SettingsStore) {
        self.settingsStore = settingsStore
        let view = SettingsView(settingsStore: settingsStore)
        let hosting = NSHostingController(rootView: view)
        let window = NSWindow(contentViewController: hosting)
        window.title = "沉浸式翻译设置"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.setContentSize(NSSize(width: 600, height: 680))
        window.minSize = NSSize(width: 520, height: 440)
        window.isReleasedWhenClosed = false
        super.init(window: window)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show() {
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}

struct SettingsView: View {
    @ObservedObject var settingsStore: SettingsStore
    @State private var recordingHotKey: HotKeyRecorderTarget?
    @State private var hotKeyRecorderMessage = ""
    @State private var providerDiagnostic = ProviderConnectionDiagnostic.idle
    @State private var isTestingProviderConnection = false
    @State private var isVerifyingProviderTranslation = false
    @State private var providerDiagnosticTask: Task<Void, Never>?
    @State private var providerTranslationTask: Task<Void, Never>?
    @State private var providerDiagnosticRunID = UUID()
    @State private var providerTranslationRunID = UUID()
    @State private var providerClipboardMessage = ""
    @State private var providerPresetMessage = ""
    @State private var providerPresetChangeSuppressionCount = 0
    @State private var lastHandledProviderDiagnosticRequestID: UUID?
    @State private var customPromptMessage = ""
    @State private var glossaryMaintenanceMessage = ""

    // 多 Provider UI 状态
    @State private var showAddCustomProvider = false
    @State private var pendingDeleteProvider: ProviderProfile?
    @State private var newProviderName = ""
    @State private var newProviderEndpoint = ""
    @State private var newProviderModel = ""
    @State private var showCustomModelInput = false
    @State private var customModelInput = ""

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("沉浸式翻译设置")
                            .font(.title2.weight(.semibold))
                        Spacer()
                        Text(currentProviderHint)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    settingsSection("翻译服务") {
                        providerOnboardingGuide

                        providerSelector

                        labeledField("接口地址", text: Binding(
                            get: { settingsStore.activeProvider.endpoint },
                            set: { newValue in settingsStore.updateActiveProvider { $0.endpoint = newValue } }
                        ))
                        labeledField("模型", text: Binding(
                            get: { settingsStore.activeProvider.model },
                            set: { newValue in settingsStore.updateActiveProvider { $0.model = newValue } }
                        ))
                        // 模型候选下拉(内置 + 自定义历史) + 自定义输入入口
                        modelCandidatePicker
                        labeledField(apiKeyFieldTitle, text: $settingsStore.editingAPIKey, secure: true)
                        providerConfigurationSummary

                        Picker("翻译方向", selection: $settingsStore.translationDirection) {
                            ForEach(TranslationDirection.allCases) { direction in
                                Text(direction.title).tag(direction)
                            }
                        }
                        .pickerStyle(.segmented)

                        Text(settingsStore.translationDirection.detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)

                        if settingsStore.translationDirection == .fixedTarget {
                            labeledField("目标语言", text: $settingsStore.targetLanguage)
                        }
                        Toggle("流式显示译文", isOn: $settingsStore.enableStreamingTranslation)
                    }

                    settingsSection("接口诊断") {
                        if !providerPresetMessage.isEmpty {
                            HStack(alignment: .top, spacing: 6) {
                                Image(systemName: "checkmark.circle")
                                    .foregroundStyle(.green)
                                Text(providerPresetMessage)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        }

                        Text(providerDiagnosticsText)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)

                        providerConnectionDiagnosticRow
                    }

                    settingsSection("截图 OCR") {
                        Picker("识别模式", selection: $settingsStore.ocrMode) {
                            ForEach(OCRRecognitionMode.allCases) { mode in
                                Text(mode.title).tag(mode)
                            }
                        }
                        .pickerStyle(.segmented)

                        Picker("识别语言", selection: $settingsStore.ocrLanguagePreset) {
                            ForEach(OCRLanguagePreset.allCases) { preset in
                                Text(preset.title).tag(preset)
                            }
                        }
                        .pickerStyle(.segmented)

                        Text("日文截图建议选“日文”或“混合”；快速模式遇到日文/中文/韩文会自动用准确模式识别。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    settingsSection("术语表与固定风格") {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("自定义提示词")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            TextEditor(text: $settingsStore.customPrompt)
                                .font(.system(size: 13))
                                .frame(minHeight: 70)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                                        .stroke(Color.primary.opacity(0.12), lineWidth: 1)
                                )
                            Text("例如：译文要自然口语化；技术名词保留英文；不要翻译产品名。")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            customPromptPresetActions
                        }

                        VStack(alignment: .leading, spacing: 6) {
                            Text("本地术语表")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            TextEditor(text: $settingsStore.glossaryText)
                                .font(.system(size: 13))
                                .frame(minHeight: 90)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                                        .stroke(Color.primary.opacity(0.12), lineWidth: 1)
                                )
                            Text("每行一个术语，例如：ImmersiveTranslator = 沉浸式翻译器。也支持 CSV/TSV 前两列、逗号/中文逗号或竖线分隔；表格里的后续备注列只本地忽略，不会随请求发送。空行、# 或 // 开头的备注、表头和无法识别的行也不会发送。")
                                .font(.footnote)
                                .foregroundStyle(.secondary)

                            glossarySummaryView
                            glossaryMaintenanceActions
                        }
                    }

                    settingsSection("快捷键") {
                        hotKeyRecorderRow(
                            title: "选中文本翻译",
                            shortcut: settingsStore.selectionHotKeyShortcut,
                            target: .selection
                        ) { shortcut in
                            settingsStore.selectionHotKeyShortcut = shortcut
                        }

                        hotKeyRecorderRow(
                            title: "截图 OCR 翻译",
                            shortcut: settingsStore.ocrHotKeyShortcut,
                            target: .ocr
                        ) { shortcut in
                            settingsStore.ocrHotKeyShortcut = shortcut
                        }

                        if let conflictMessage = hotKeyConflictMessage {
                            Text(conflictMessage)
                                .font(.footnote)
                                .foregroundStyle(.orange)
                                .fixedSize(horizontal: false, vertical: true)
                        } else if let registrationMessage = settingsStore.hotKeyRegistrationMessage {
                            Text(registrationMessage)
                                .font(.footnote)
                                .foregroundStyle(.orange)
                                .fixedSize(horizontal: false, vertical: true)
                        } else if !hotKeyRecorderMessage.isEmpty {
                            Text(hotKeyRecorderMessage)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        } else {
                            Text("点击“录制”后按下新组合键。建议至少包含 Control / Option / Command 之一，避免和普通输入冲突。")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }

                    storageMessage
                }
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }

            Divider()

            HStack {
                Button("打开辅助功能设置") {
                    PermissionPrompter.openPrivacyPane(kind: .accessibility)
                }
                Button("打开屏幕录制设置") {
                    PermissionPrompter.openPrivacyPane(kind: .screenRecording)
                }
                Spacer()
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 14)
            .background(.regularMaterial)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onChange(of: settingsStore.activeProvider.endpoint) { _ in
            cancelProviderDiagnosticTasks()
            providerPresetMessage = ""
            markProviderDiagnosticNeedsRerun("接口地址已变更，建议重新测试当前接口。")
        }
        .onChange(of: settingsStore.activeProvider.model) { _ in
            cancelProviderVerificationTask()
            providerPresetMessage = ""
            markProviderDiagnosticNeedsRerun("模型已变更，建议重新验证翻译请求。")
        }
        .onChange(of: settingsStore.editingAPIKey) { _ in
            cancelProviderVerificationTask()
            providerPresetMessage = ""
            markProviderDiagnosticNeedsRerun("API Key 已变更，建议重新验证翻译请求。")
        }
        .onChange(of: settingsStore.translationDirection) { _ in
            cancelProviderVerificationTask()
            providerPresetMessage = ""
            markProviderDiagnosticNeedsRerun("翻译方向已变更，建议重新验证翻译请求。")
        }
        .onChange(of: settingsStore.targetLanguage) { _ in
            cancelProviderVerificationTask()
            providerPresetMessage = ""
            markProviderDiagnosticNeedsRerun("目标语言已变更，建议重新验证翻译请求。")
        }
        .onChange(of: settingsStore.enableStreamingTranslation) { _ in
            cancelProviderVerificationTask()
            providerPresetMessage = ""
            markProviderDiagnosticNeedsRerun("流式显示设置已变更，建议重新验证翻译请求。")
        }
        .onChange(of: settingsStore.customPrompt) { _ in
            cancelProviderVerificationTask()
            providerPresetMessage = ""
            markProviderDiagnosticNeedsRerun("固定风格已变更，建议重新验证翻译请求。")
        }
        .onChange(of: settingsStore.glossaryText) { _ in
            cancelProviderVerificationTask()
            providerPresetMessage = ""
            markProviderDiagnosticNeedsRerun("术语表已变更，建议重新验证翻译请求。")
        }
        .sheet(isPresented: $showAddCustomProvider) {
            VStack(alignment: .leading, spacing: 12) {
                Text("添加自定义提供商").font(.headline)
                TextField("名称（如 我的 Ollama）", text: $newProviderName)
                    .textFieldStyle(.roundedBorder)
                TextField("接口地址（https://... 或 http://localhost...）", text: $newProviderEndpoint)
                    .textFieldStyle(.roundedBorder)
                TextField("模型名（可留空，默认 gpt-3.5-turbo）", text: $newProviderModel)
                    .textFieldStyle(.roundedBorder)
                HStack {
                    Spacer()
                    Button("取消") {
                        newProviderName = ""
                        newProviderEndpoint = ""
                        newProviderModel = ""
                        showAddCustomProvider = false
                    }
                    Button("添加") { addCustomProvider() }
                    .disabled(newProviderName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                              || newProviderEndpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding()
            .frame(width: 380)
        }
        .alert("删除自定义提供商", isPresented: Binding(
            get: { pendingDeleteProvider != nil },
            set: { if !$0 { pendingDeleteProvider = nil } }
        )) {
            Button("取消", role: .cancel) { pendingDeleteProvider = nil }
            Button("删除", role: .destructive) { confirmDeleteCustomProvider() }
        } message: {
            Text("确认删除“\(pendingDeleteProvider?.displayName ?? "")”？其 API Key 会一并从钥匙串清除，常驻提供商（DeepSeek/智谱/OpenAI）不可删除。")
        }
        .onChange(of: settingsStore.providerDiagnosticRequestID) { _ in
            runRequestedProviderDiagnostic()
        }
        .onAppear {
            runRequestedProviderDiagnostic()
        }
        .onDisappear {
            cancelProviderDiagnosticTasks()
        }
    }

    private func settingsSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var storageMessage: some View {
        Group {
            if let apiKeyStorageError = settingsStore.apiKeyStorageError {
                Text("API Key 未能写入 Keychain：\(apiKeyStorageError)")
                    .font(.footnote)
                    .foregroundStyle(.red)
            } else {
                Text("API Key 会保存到 macOS Keychain，其它设置保存在本机。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var providerOnboardingGuide: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: providerRequiresAPIKey ? "cloud" : "desktopcomputer")
                    .foregroundStyle(providerRequiresAPIKey ? .blue : .green)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 4) {
                    Text("先选接口类型，不必一上来就找 Key")
                        .font(.subheadline.weight(.semibold))
                    Text("内置三个云预设（DeepSeek、OpenAI、智谱），需要对应服务商的 API Key。想接其它服务商或本地 OpenAI 兼容服务，直接在下面填写接口地址和 Key 即可，本地兼容接口可不填真实 Key。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(providerOnboardingStatusText)
                        .font(.footnote)
                        .foregroundStyle(providerOnboardingStatusColor)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(10)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(providerOnboardingStatusColor.opacity(0.25), lineWidth: 1)
        )
    }

    private var apiKeyFieldTitle: String {
        providerRequiresAPIKey ? "API Key（云接口需要）" : "API Key（本地接口可留空）"
    }

    private var providerOnboardingStatusText: String {
        let endpoint = settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        if endpoint.isEmpty {
            return "接口地址还没填：选一个内置云预设，或自己填写其它服务商 / 本地 OpenAI 兼容地址，再决定要不要填 API Key。"
        }
        if !providerRequiresAPIKey {
            return "当前是本地接口：确认本地服务已启动并加载模型后，可以直接测试当前接口或验证短翻译。"
        }
        if (KeychainStore.apiKey(for: settingsStore.activeProviderID) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "当前是云接口且还没有 API Key：可以先测试入口连通性；真实翻译前需要填 Key。"
        }
        return "当前云接口已填写 API Key：建议先验证一次短翻译，确认模型、余额和权限都可用。"
    }

    private var providerOnboardingStatusColor: Color {
        let endpoint = settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        if endpoint.isEmpty {
            return .blue
        }
        if !providerRequiresAPIKey {
            return .green
        }
        return (KeychainStore.apiKey(for: settingsStore.activeProviderID) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .blue : .green
    }

    private func labeledField(_ title: String, text: Binding<String>, secure: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            if secure {
                SecureField(title, text: text)
                    .textFieldStyle(.roundedBorder)
            } else {
                TextField(title, text: text)
                    .textFieldStyle(.roundedBorder)
            }
        }
    }

    private var currentProviderHint: String {
        let endpoint = settingsStore.activeProvider.endpoint.lowercased()
        if endpoint.contains("deepseek") {
            return "DeepSeek 兼容接口"
        }
        if endpoint.contains("bigmodel") || endpoint.contains("z.ai") {
            return "智谱 GLM 兼容接口"
        }
        if endpoint.contains("generativelanguage.googleapis.com") {
            return "Google Gemini 兼容接口"
        }
        if endpoint.contains("openrouter.ai") {
            return "OpenRouter 统一模型接口"
        }
        if endpoint.contains("siliconflow.cn") {
            return "SiliconFlow 兼容接口"
        }
        if endpoint.contains("dashscope.aliyuncs.com")
            || endpoint.contains("dashscope-intl.aliyuncs.com")
            || endpoint.contains("dashscope-us.aliyuncs.com")
            || endpoint.contains("cn-hongkong.dashscope.aliyuncs.com")
            || endpoint.contains("cn-hongkong.aliyuncs.com") {
            return "阿里云百炼 OpenAI 兼容接口"
        }
        if endpoint.contains("api.groq.com") {
            return "Groq OpenAI 兼容接口"
        }
        if endpoint.contains("api.x.ai") {
            return "xAI Chat Completions 接口"
        }
        if endpoint.contains("moonshot.cn") || endpoint.contains("platform.moonshot") {
            return "Moonshot / Kimi 兼容接口"
        }
        if endpoint.contains("localhost") || endpoint.contains("127.0.0.1") || endpoint.contains("[::1]") {
            return "本地 OpenAI 兼容接口"
        }
        if endpoint.contains("openai") {
            return "OpenAI 接口"
        }
        return "OpenAI Chat Completions 兼容接口"
    }

    private var providerDiagnosticsText: String {
        let endpoint = settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        let model = settingsStore.activeProvider.model.trimmingCharacters(in: .whitespacesAndNewlines)
        if endpoint.isEmpty {
            return "接口地址为空时无法发起请求；请选择预设或填写完整 Chat Completions 地址。"
        }
        if let url = providerEffectiveURL, !TranslationClient.requiresAPIKey(for: url) {
            return "当前是本地 OpenAI 兼容接口：可以不填真实 API Key；若请求慢，优先检查本机模型是否已拉取、是否正在加载。"
        }
        if providerRequiresAPIKey,
           (KeychainStore.apiKey(for: settingsStore.activeProviderID) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "当前是云接口：连通性测试可以先跑，真实翻译需要 API Key；如果只是先试用，也可自己填一个本地 OpenAI 兼容地址（如 http://localhost:11434/v1/chat/completions）直接试。"
        }
        if model.isEmpty {
            return "模型为空时会回退到默认模型；建议明确填写服务商支持的模型名，排查 404 会更轻松。"
        }
        if !endpoint.lowercased().contains("chat/completions") {
            return "当前地址会自动补全到 Chat Completions 路径；如果服务商要求完整路径，请直接填写完整 URL。"
        }
        return "慢请求排查顺序：先做连通性测试，再用真实请求验证 Key/模型/余额/权限，最后看模型排队或服务商限流。"
    }

    private var providerConfigurationSummary: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: providerEffectiveURL == nil ? "link.badge.plus" : "link")
                    .foregroundStyle(.secondary)
                    .frame(width: 14)
                Text(providerEffectiveURLText)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if let providerEffectiveURL {
                    Button {
                        copyProviderText(
                            TranslationClient.redactedURLString(providerEffectiveURL.absoluteString),
                            message: "已复制实际请求地址"
                        )
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .buttonStyle(.borderless)
                    .help("复制实际请求地址")
                }
            }

            ForEach(providerConfigurationHints) { hint in
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: hint.level.systemImage)
                        .foregroundStyle(hint.level.color)
                        .frame(width: 14)
                    Text(hint.message)
                        .foregroundStyle(hint.level.color)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .font(.footnote)
        .padding(10)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(providerConfigurationBorderColor.opacity(0.25), lineWidth: 1)
        )
    }

    private var providerEffectiveURLText: String {
        if let url = providerEffectiveURL {
            return "实际请求地址：\(TranslationClient.redactedURLString(url.absoluteString))"
        }
        return "实际请求地址：暂时无法解析，请填写完整接口地址。"
    }

    private var providerEffectiveURL: URL? {
        let endpoint = settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !endpoint.isEmpty else { return nil }
        return TranslationClient.chatCompletionsURL(from: endpoint)
    }

    private var providerConfigurationBorderColor: Color {
        if providerConfigurationHints.contains(where: { $0.level == .failure }) {
            return .red
        }
        if providerConfigurationHints.contains(where: { $0.level == .warning }) {
            return .orange
        }
        return .secondary
    }

    private var providerConfigurationHints: [ProviderConfigurationHint] {
        let endpoint = settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        let model = settingsStore.activeProvider.model.trimmingCharacters(in: .whitespacesAndNewlines)
        var hints: [ProviderConfigurationHint] = []

        if endpoint.isEmpty {
            hints.append(ProviderConfigurationHint(
                id: "empty-endpoint",
                level: .failure,
                message: "接口地址为空，翻译请求无法发出。"
            ))
        } else if let url = providerEffectiveURL {
            let scheme = url.scheme?.lowercased() ?? ""
            if scheme.isEmpty {
                hints.append(ProviderConfigurationHint(
                    id: "missing-scheme",
                    level: .failure,
                    message: "接口地址缺少 https:// 或 http://。请填写完整 URL。"
                ))
            } else if scheme != "https" && !isLocalDevelopmentHost(url.host) {
                hints.append(ProviderConfigurationHint(
                    id: "non-https",
                    level: .warning,
                    message: "当前不是 HTTPS。除本地代理外，正式服务商建议使用 HTTPS，避免请求被拦截或证书校验失败。"
                ))
            }

            let originalPath = URLComponents(string: endpoint)?.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? ""
            let effectivePath = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if !originalPath.isEmpty, originalPath != effectivePath {
                hints.append(ProviderConfigurationHint(
                    id: "path-expanded",
                    level: .info,
                    message: "已自动补全为 Chat Completions 路径；如果服务商文档给的是完整地址，也可以直接粘贴完整 URL。"
                ))
            }

            if let message = ProviderConfigurationAdvisor.sensitiveQueryItemsMessage(for: url.absoluteString) {
                hints.append(ProviderConfigurationHint(
                    id: "sensitive-query-items",
                    level: .warning,
                    message: message
                ))
            }
        } else {
            hints.append(ProviderConfigurationHint(
                id: "invalid-endpoint",
                level: .failure,
                message: "接口地址无法解析。请检查是否有空格、中文标点或缺少协议头。"
            ))
        }

        if model.isEmpty {
            hints.append(ProviderConfigurationHint(
                id: "empty-model",
                level: .warning,
                message: "模型为空时会回退到 gpt-5.4-mini；建议明确填写服务商支持的模型名。"
            ))
        } else if isLocalProviderEndpoint, Self.isLocalModelPlaceholder(model) {
            hints.append(ProviderConfigurationHint(
                id: "local-model-placeholder",
                level: .warning,
                message: "模型名看起来还是占位符。LM Studio 请在 Developer / Models 里复制已加载模型的 identifier；Ollama 可用 `ollama list` 查看模型名；vLLM 可请求 `/v1/models` 或使用 `vllm serve <模型名>` 里的模型 ID。"
            ))
        }

        if (KeychainStore.apiKey(for: settingsStore.activeProviderID) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if providerRequiresAPIKey {
                hints.append(ProviderConfigurationHint(
                    id: "empty-api-key",
                    level: .warning,
                    message: "还没有填写 API Key。连接测试仍可运行，但真实翻译会先提示缺少 API Key。"
                ))
            } else {
                hints.append(ProviderConfigurationHint(
                    id: "local-api-key-not-required",
                    level: .info,
                    message: "本地接口不需要真实 API Key；如果你的本地代理要求占位值，也可以填入 ollama 或 local。"
                ))
            }
        }

        if isLocalProviderEndpoint {
            hints.append(ProviderConfigurationHint(
                id: "local-provider",
                level: .info,
                message: "本地服务需要先启动并加载对应模型；Ollama 默认端口通常是 11434，LM Studio 通常是 1234，vLLM 通常是 8000。"
            ))
        }

        if hints.isEmpty {
            hints.append(ProviderConfigurationHint(
                id: "ready",
                level: .info,
                message: "配置看起来完整。若仍失败，可用“测试当前接口”区分网络问题和 Key/模型/额度问题。"
            ))
        }

        return hints
    }

    private func isLocalDevelopmentHost(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else { return false }
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
    }

    private var providerRequiresAPIKey: Bool {
        guard let providerEffectiveURL else {
            return true
        }
        return TranslationClient.requiresAPIKey(for: providerEffectiveURL)
    }

    private var isZhipuProviderEndpoint: Bool {
        guard let host = providerEffectiveURL?.host()?.lowercased() else {
            return false
        }
        return host.contains("bigmodel.cn") || host.contains("z.ai")
    }

    private var isLocalProviderEndpoint: Bool {
        guard let host = providerEffectiveURL?.host()?.lowercased() else {
            return false
        }
        return isLocalDevelopmentHost(host)
    }

    private static func isLocalModelPlaceholder(_ model: String) -> Bool {
        let normalized = model.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return [
            "model-identifier",
            "model_identifier",
            "local-model",
            "your-model",
            "your-model-name",
            "loaded-model",
            "served-model",
            "served-model-name",
            "model-name"
        ].contains(normalized)
    }

    private var providerConnectionDiagnosticRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Button(isTestingProviderConnection ? "测试中..." : "测试当前接口") {
                    runProviderConnectionDiagnostic()
                }
                .controlSize(.small)
                .disabled(isTestingProviderConnection || isVerifyingProviderTranslation || settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Button(isVerifyingProviderTranslation ? "验证中..." : "验证翻译请求") {
                    runProviderTranslationVerification()
                }
                .controlSize(.small)
                .disabled(isTestingProviderConnection || isVerifyingProviderTranslation || providerTranslationVerificationDisabled)

                if isTestingProviderConnection || isVerifyingProviderTranslation {
                    Button("取消") {
                        cancelProviderDiagnosticTasks()
                        providerDiagnostic = ProviderConnectionDiagnostic(
                            level: .warning,
                            endpoint: settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines),
                            message: "已取消当前 Provider 诊断。",
                            kind: .cancelled,
                            completedAt: Date()
                        )
                    }
                    .controlSize(.small)
                }

                Button("复制诊断") {
                    copyProviderText(
                        providerDiagnosticReport,
                        message: "已复制 Provider 诊断"
                    )
                }
                .controlSize(.small)
                .disabled(providerDiagnostic.level == .idle)

                Button("复制支持包") {
                    copyProviderText(
                        providerDiagnosticSupportBundle,
                        message: "已复制脱敏支持包"
                    )
                }
                .controlSize(.small)
                .disabled(providerDiagnostic.level == .idle)
                .help("复制诊断报告、配置提示和不含真实 API Key 的 curl 命令")

                Button("复制 curl") {
                    copyProviderText(
                        providerDiagnosticCurlCommand,
                        message: "已复制安全 curl 命令"
                    )
                }
                .controlSize(.small)
                .disabled(providerEffectiveURL == nil)
                .help("复制一个不包含真实 API Key 的 Chat Completions 复现命令")

                Button("复制日志路径") {
                    copyProviderText(
                        DiagnosticLogger.logFileURL().path,
                        message: "已复制诊断日志路径"
                    )
                }
                .controlSize(.small)

                Button("显示日志") {
                    revealDiagnosticLog()
                }
                .controlSize(.small)

                if isTestingProviderConnection || isVerifyingProviderTranslation {
                    ProgressView()
                        .controlSize(.small)
                        .scaleEffect(0.72)
                        .frame(width: 18, height: 18)
                }

                Spacer(minLength: 0)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(providerDiagnostic.message)
                    .font(.footnote)
                    .foregroundStyle(providerDiagnostic.level.color)
                    .fixedSize(horizontal: false, vertical: true)
                if let metadata = providerDiagnosticMetadataText {
                    Text(metadata)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let nextStep = providerDiagnosticNextStepText {
                    HStack(alignment: .top, spacing: 5) {
                        Image(systemName: "arrow.turn.down.right")
                            .foregroundStyle(.secondary)
                        Text("建议下一步：\(nextStep)")
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.caption2)
                }
                Text("只测试接口连通性和首个响应耗时，不发送 API Key、原文或翻译请求正文；本地 HTTP 接口可直接测试。")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("“验证翻译请求”会发送一段很短的测试文本，用来检查 API Key、模型名、余额/限流和账号权限。")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                if !providerClipboardMessage.isEmpty {
                    Text(providerClipboardMessage)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(10)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(providerDiagnostic.level.color.opacity(providerDiagnostic.level == .idle ? 0.12 : 0.35), lineWidth: 1)
        )
    }

    private var providerTranslationVerificationDisabled: Bool {
        settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || (providerRequiresAPIKey && (KeychainStore.apiKey(for: settingsStore.activeProviderID) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private var providerDiagnosticLatencyAssessment: ProviderLatencyAssessment? {
        guard providerDiagnostic.level != .idle else { return nil }

        let diagnosticURL = providerDiagnostic.requestURL.flatMap(URL.init(string:)) ?? providerEffectiveURL
        let isLocalEndpoint = isLocalDevelopmentHost(diagnosticURL?.host()?.lowercased())
        return ProviderLatencyAssessment.make(
            kind: providerDiagnostic.kind,
            elapsed: providerDiagnostic.elapsed,
            isLocalEndpoint: isLocalEndpoint
        )
    }

    private var providerDiagnosticMetadataText: String? {
        guard providerDiagnostic.level != .idle else { return nil }

        var parts = [providerDiagnostic.kind.title]
        if let elapsed = providerDiagnostic.elapsed {
            parts.append("耗时 \(String(format: "%.1fs", elapsed))")
        }
        if let latencyAssessment = providerDiagnosticLatencyAssessment {
            parts.append("延迟 \(latencyAssessment.label)")
        }
        if let statusCode = providerDiagnostic.statusCode {
            parts.append("HTTP \(statusCode)")
        }
        if let completedAt = providerDiagnostic.completedAt {
            parts.append("完成于 \(Self.providerDiagnosticDateFormatter.string(from: completedAt))")
        }
        return parts.joined(separator: " · ")
    }

    private var providerDiagnosticNextStepText: String? {
        if isTestingProviderConnection {
            return "等待首个响应；如果超时，优先检查网络、代理或本地服务是否启动。"
        }
        if isVerifyingProviderTranslation {
            return "等待真实翻译结果；如果失败，下面会按 Key、模型、额度、权限或网络分类提示。"
        }

        switch providerDiagnostic.level {
        case .idle:
            if settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return "先选择一个 Provider 预设，或填写完整 Chat Completions 接口地址。"
            }
            if !providerRequiresAPIKey {
                return "本地接口不需要真实 API Key；先确认本地服务已启动，然后测试当前接口或验证短翻译。"
            }
            if providerTranslationVerificationDisabled {
                return "先测试当前接口；补齐 API Key 后再验证真实翻译请求。"
            }
            return "先测试当前接口确认网络，再验证翻译请求确认 Key、模型、额度和权限。"
        case .success:
            switch providerDiagnostic.kind {
            case .connection:
                if providerTranslationVerificationDisabled {
                    return "网络已通；填写 API Key 后再验证真实翻译请求。"
                }
                if let nextStep = providerDiagnosticLatencyAssessment?.nextStepText {
                    return "\(nextStep) 然后继续验证翻译请求，确认模型名、余额和账号权限。"
                }
                return "网络已通；继续验证翻译请求，确认模型名、余额和账号权限。"
            case .translation:
                if let nextStep = providerDiagnosticLatencyAssessment?.nextStepText {
                    return "\(nextStep) 当前 Key、模型和权限已通过短文本验证。"
                }
                return "当前配置可用；如果日常仍慢，可开启流式显示或切换低延迟预设。"
            case .none, .cancelled, .configuration:
                return nil
            }
        case .warning:
            return providerWarningNextStepText
        case .failure:
            return providerFailureNextStepText
        }
    }

    private var providerWarningNextStepText: String {
        if providerDiagnostic.kind == .cancelled {
            return "如果只是手动取消，可以调整配置后重新发起诊断。"
        }
        if let issue = TranslationErrorIssue.classify(
            statusCode: providerDiagnostic.statusCode,
            message: providerDiagnostic.message
        ) {
            if let nextStep = zhipuProviderDiagnosticNextStep(for: issue) {
                return nextStep
            }
            return issue.diagnosticNextStep
        }

        switch providerDiagnostic.statusCode {
        case 404:
            return "优先核对接口路径和模型名；如果用预设，重新点一次对应服务商预设再验证。"
        case 405:
            return "GET 被拒绝通常没关系；继续验证翻译请求，真实请求会使用 POST。"
        case 429:
            return "稍后重试，或到服务商控制台检查额度、RPM/TPM 限制和并发限制。"
        case let status? where (500...599).contains(status):
            return "服务商侧可能繁忙；稍后重试，或临时切换到另一个低延迟预设。"
        default:
            if let nextStep = providerDiagnosticLatencyAssessment?.nextStepText {
                return nextStep
            }
            return "网络基本可达；若翻译仍失败，继续验证翻译请求拿到更精确的 Key/模型/额度提示。"
        }
    }

    private var providerFailureNextStepText: String {
        if let nextStep = providerDiagnosticLatencyAssessment?.nextStepText,
           providerDiagnostic.statusCode == nil {
            return nextStep
        }
        if let issue = TranslationErrorIssue.classify(
            statusCode: providerDiagnostic.statusCode,
            message: providerDiagnostic.message
        ) {
            if let nextStep = zhipuProviderDiagnosticNextStep(for: issue) {
                return nextStep
            }
            return issue.diagnosticNextStep
        }

        switch providerDiagnostic.statusCode {
        case 400:
            return "检查模型名、流式兼容性和服务商参数；可先关闭流式显示再验证一次。"
        case 401:
            return "重新粘贴 API Key，并确认 Key 属于当前服务商和接口地址。"
        case 402:
            return "到服务商控制台检查余额、账单状态或免费额度是否用完。"
        case 403:
            return "检查账号是否有当前模型、区域或 API 权限；必要时切换到可用模型。"
        case 404:
            return "核对接口地址和模型名；最稳妥是重新选择服务商预设后再验证。"
        case 408, 504:
            return "检查代理和网络稳定性；慢请求可开启流式显示减少等待感。"
        case 429:
            return "稍后重试，或降低请求频率并检查服务商限流/余额。"
        case let status? where (500...599).contains(status):
            return "服务商侧异常概率较高；稍后重试或切换 Provider 预设。"
        default:
            if providerDiagnostic.kind == .configuration {
                return "先修正上面的配置提示，再重新测试当前接口。"
            }
            return "检查网络、代理、防火墙和接口地址；如果是本地接口，确认服务已启动且端口正确。"
        }
    }

    private func zhipuProviderDiagnosticNextStep(for issue: TranslationErrorIssue) -> String? {
        guard isZhipuProviderEndpoint else { return nil }
        let model = currentProviderDiagnosticModel

        switch issue {
        case .apiKey:
            return "这是智谱接口：重新复制智谱开放平台 API Key，确认没有混用 Coding 专属 Key、其它服务商 Key 或旧项目 Key。"
        case .modelName, .permission:
            return "这是智谱接口：到智谱开放平台确认当前账号已开通 `\(model)`，并核对模型名是否和控制台可用模型列表一致。"
        case .endpoint, .gatewayHTML:
            return "这是智谱接口：通用翻译应使用 `https://open.bigmodel.cn/api/paas/v4/chat/completions`，不要填成控制台页面、Coding 专属端点或只到 `/api/paas/v4` 的根路径。"
        case .requestParameter, .streamCompatibility:
            return "这是智谱接口：优先重新选择智谱预设，让 App 自动关闭 thinking 并带上 GLM 兼容参数；仍失败时可先关闭流式显示再验证。"
        case .billing, .rateLimit:
            return "这是智谱接口：到智谱开放平台检查余额、套餐额度、RPM/TPM 和并发限制，稍后再验证短翻译。"
        case .timeout, .serviceUnavailable:
            return "这是智谱接口：先检查到 open.bigmodel.cn 的网络和代理；若入口正常但短翻译偏慢，可开启流式显示或临时切到 GLM-4 Flash。"
        default:
            return nil
        }
    }

    private var providerDiagnosticReport: String {
        let endpoint = settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        let model = settingsStore.activeProvider.model.trimmingCharacters(in: .whitespacesAndNewlines)
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "<unknown>"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "<unknown>"
        let latencyAssessment = providerDiagnosticLatencyAssessment?.reportText ?? "<unknown>"
        let targetDescription: String
        switch settingsStore.translationDirection {
        case .autoChineseEnglish:
            targetDescription = settingsStore.translationDirection.title
        case .fixedTarget:
            let target = settingsStore.targetLanguage.trimmingCharacters(in: .whitespacesAndNewlines)
            targetDescription = "\(settingsStore.translationDirection.title)：\(target.isEmpty ? "简体中文" : target)"
        }

        return """
        ImmersiveTranslator Provider Diagnostic
        App version: \(version) (\(build))
        macOS: \(ProcessInfo.processInfo.operatingSystemVersionString)
        Provider: \(currentProviderHint)
        Diagnostic type: \(providerDiagnostic.kind.title)
        Completed at: \(providerDiagnostic.completedAt.map(Self.providerDiagnosticISOFormatter.string(from:)) ?? "<not completed>")
        Elapsed: \(providerDiagnostic.elapsed.map { String(format: "%.2fs", $0) } ?? "<unknown>")
        Latency assessment: \(latencyAssessment)
        HTTP status: \(providerDiagnostic.statusCode.map(String.init) ?? "<not captured>")
        Endpoint input: \(endpoint.isEmpty ? "<empty>" : TranslationClient.redactedURLString(endpoint))
        Effective request URL: \(redactedProviderDiagnosticRequestURL)
        Model: \(providerDiagnostic.model ?? (model.isEmpty ? "gpt-5.4-mini (default fallback)" : model))
        API key configured: \(providerAPIKeyReportText)
        Translation direction: \(targetDescription)
        Streaming: \(settingsStore.enableStreamingTranslation ? "on" : "off")
        Custom prompt: \(providerCustomPromptReportText)
        Glossary: \(providerGlossaryReportText)
        Configuration fingerprint: \(providerConfigurationFingerprint)
        Result: \(providerDiagnostic.level.title)
        Message: \(providerDiagnostic.message)
        Suggested next step: \(providerDiagnosticNextStepText ?? "<none>")
        Diagnostic log: \(DiagnosticLogger.logFileURL().path)
        """
    }

    private var providerDiagnosticSupportBundle: String {
        let hints = providerConfigurationHints
            .map { "- \($0.message)" }
            .joined(separator: "\n")
        let diagnostics = providerDiagnosticReport
        let curl = providerDiagnosticCurlCommand

        return """
        ImmersiveTranslator Support Bundle
        Generated at: \(Self.providerDiagnosticISOFormatter.string(from: Date()))
        Redaction: API Key is never included; sensitive URL query items are replaced with REDACTED; curl uses ${API_KEY} when auth is required.

        ## Diagnostic
        \(diagnostics)

        ## Configuration Hints
        \(hints.isEmpty ? "- <none>" : hints)

        ## Safe Reproduction curl
        \(curl)
        """
    }

    private var providerDiagnosticCurlCommand: String {
        guard let url = providerEffectiveURL else {
            return "# 接口地址无法解析，请先修正设置里的接口地址。"
        }

        let model = settingsStore.activeProvider.model.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedModel = model.isEmpty ? "gpt-5.4-mini" : model
        let requiresAPIKey = TranslationClient.requiresAPIKey(for: url)
        let payload = providerDiagnosticCurlPayload(
            model: resolvedModel,
            stream: settingsStore.enableStreamingTranslation
        )
        let prettyPayload = prettyPrintedJSONString(payload) ?? #"{"model":"gpt-5.4-mini"}"#
        let safeURLString = TranslationClient.redactedURLString(url.absoluteString)

        var lines = [
            "curl -N \\",
            "  \(shellQuoted(safeURLString)) \\",
            "  -H \(shellQuoted("Content-Type: application/json")) \\",
            "  -H \(shellQuoted("Accept: application/json")) \\"
        ]

        if requiresAPIKey {
            lines.append("  -H \"Authorization: Bearer ${API_KEY}\" \\")
        }

        lines.append("  -d \(shellQuoted(prettyPayload))")

        let prefix = requiresAPIKey
            ? "# 先在终端设置：export API_KEY='你的服务商 API Key'\n# 这个命令不会复制当前 App 里的真实 API Key。\n"
            : "# 本地接口复现命令，不包含 API Key；如果你的代理要求占位值，可手动加 -H 'Authorization: Bearer local'。\n"
        return prefix + lines.joined(separator: "\n")
    }

    private var redactedProviderDiagnosticRequestURL: String {
        let urlText = providerDiagnostic.requestURL ?? providerEffectiveURL?.absoluteString
        return urlText.map(TranslationClient.redactedURLString) ?? "<invalid>"
    }

    private var providerConfigurationFingerprint: String {
        let components = [
            settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines),
            providerEffectiveURL?.absoluteString ?? "<invalid>",
            settingsStore.activeProvider.model.trimmingCharacters(in: .whitespacesAndNewlines),
            settingsStore.translationDirection.rawValue,
            settingsStore.targetLanguage.trimmingCharacters(in: .whitespacesAndNewlines),
            settingsStore.enableStreamingTranslation ? "stream" : "buffered",
            providerCustomPromptReportText,
            providerGlossaryReportText,
            providerRequiresAPIKey ? ((KeychainStore.apiKey(for: settingsStore.activeProviderID) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "no-key" : "has-key") : "key-not-required"
        ]
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in components.joined(separator: "\u{1F}").utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return String(format: "%016llx", hash)
    }

    private func providerDiagnosticCurlPayload(model: String, stream: Bool) -> [String: Any] {
        var payload: [String: Any] = [
            "model": model,
            "messages": [
                [
                    "role": "system",
                    "content": "You are a concise translation engine. Return only the translation."
                ],
                [
                    "role": "user",
                    "content": "<text>\nProvider diagnostic ping: translate this short sentence.\n</text>"
                ]
            ],
            "temperature": 0.2,
            "stream": stream
        ]

        let lowercasedModel = model.lowercased()
        let host = providerEffectiveURL?.host()?.lowercased() ?? ""
        if host.contains("deepseek") || lowercasedModel.hasPrefix("deepseek-") {
            payload["thinking"] = ["type": "disabled"]
            payload["max_tokens"] = 1024
        } else if lowercasedModel.hasPrefix("glm-") || host.contains("bigmodel.cn") || host.contains("z.ai") {
            payload["thinking"] = ["type": "disabled"]
            payload["do_sample"] = false
            payload["max_tokens"] = 1024
        }

        return payload
    }

    private func prettyPrintedJSONString(_ object: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(
                withJSONObject: object,
                options: [.prettyPrinted, .sortedKeys]
              ) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    private func shellQuoted(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }

    private var providerAPIKeyReportText: String {
        if !providerRequiresAPIKey {
            return (KeychainStore.apiKey(for: settingsStore.activeProviderID) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "not required for local endpoint"
                : "yes (local endpoint also has a configured value)"
        }
        return (KeychainStore.apiKey(for: settingsStore.activeProviderID) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "no" : "yes"
    }

    private var providerCustomPromptReportText: String {
        let prompt = settingsStore.customPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        return prompt.isEmpty ? "empty" : "configured (\(prompt.count) chars)"
    }

    private var providerGlossaryReportText: String {
        let summary = GlossarySummary.make(from: settingsStore.glossaryText)
        guard !summary.isEmpty else {
            return "empty"
        }

        var parts = [
            "\(summary.effectiveMappingCount) effective",
            "\(summary.requestMappingCount) sent"
        ]
        if summary.overflowMappingCount > 0 {
            parts.append("\(summary.overflowMappingCount) local-only")
        }
        if summary.ignoredLineCount > 0 {
            parts.append("\(summary.ignoredLineCount) ignored")
        }
        if !summary.duplicateSources.isEmpty {
            parts.append("\(summary.duplicateSources.count) duplicate sources")
        }
        return parts.joined(separator: ", ")
    }

    private static let providerDiagnosticDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .medium
        return formatter
    }()

    private static let providerDiagnosticISOFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private func copyProviderText(_ text: String, message: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        providerClipboardMessage = message
    }

    private func revealDiagnosticLog() {
        let logURL = DiagnosticLogger.logFileURL()
        if FileManager.default.fileExists(atPath: logURL.path) {
            NSWorkspace.shared.activateFileViewerSelecting([logURL])
            providerClipboardMessage = "已在 Finder 中显示诊断日志"
            return
        }

        do {
            try FileManager.default.createDirectory(
                at: logURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            NSWorkspace.shared.open(logURL.deletingLastPathComponent())
            providerClipboardMessage = "日志尚未生成，已打开日志目录"
        } catch {
            providerClipboardMessage = "无法打开日志目录：\(error.localizedDescription)"
        }
    }

    private var customPromptPresetActions: some View {
        HStack(spacing: 8) {
            Menu("追加风格模板") {
                ForEach(TranslationStylePreset.all) { preset in
                    Button(preset.title) {
                        appendCustomPromptPreset(preset)
                    }
                }
            }
            .controlSize(.small)

            Button("复制风格") {
                copyCustomPrompt()
            }
            .controlSize(.small)
            .disabled(settingsStore.customPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            Button("清空风格") {
                clearCustomPrompt()
            }
            .controlSize(.small)
            .disabled(settingsStore.customPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            if !customPromptMessage.isEmpty {
                Text(customPromptMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
    }

    private func appendCustomPromptPreset(_ preset: TranslationStylePreset) {
        let existing = settingsStore.customPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !existing.contains(preset.prompt) else {
            customPromptMessage = "已包含“\(preset.title)”模板"
            return
        }

        settingsStore.customPrompt = existing.isEmpty ? preset.prompt : "\(existing)\n\(preset.prompt)"
        customPromptMessage = "已追加“\(preset.title)”风格"
    }

    private func copyCustomPrompt() {
        let prompt = settingsStore.customPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else {
            customPromptMessage = "固定风格为空"
            return
        }

        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(prompt, forType: .string)
        customPromptMessage = "已复制固定风格"
    }

    private func clearCustomPrompt() {
        let prompt = settingsStore.customPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else {
            customPromptMessage = "固定风格为空"
            return
        }

        let alert = NSAlert()
        alert.messageText = "清空固定翻译风格？"
        alert.informativeText = "术语表不会受影响。若想保留备份，可以先点“复制风格”。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "清空")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else {
            customPromptMessage = "已取消清空"
            return
        }

        settingsStore.customPrompt = ""
        customPromptMessage = "已清空固定风格"
    }

    private var glossarySummaryView: some View {
        let summary = GlossarySummary.make(from: settingsStore.glossaryText)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: summary.isEmpty ? "text.badge.plus" : "checklist")
                    .frame(width: 14)
                Text(glossarySummaryText(summary))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(glossarySummaryColor(summary))

            if !summary.sampleMappings.isEmpty {
                ForEach(summary.sampleMappings) { mapping in
                    Text("\(mapping.source) -> \(mapping.target)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            if !summary.ignoredLineSamples.isEmpty {
                ForEach(summary.ignoredLineSamples, id: \.self) { sample in
                    Text("未识别示例：\(sample)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.orange)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            if summary.overflowMappingCount > 0,
               let lastRequestMapping = summary.lastRequestMapping,
               let firstOverflowMapping = summary.firstOverflowMapping {
                Text("发送边界：\(lastRequestMapping.source) -> \(lastRequestMapping.target)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text("仅本地保留起点：\(firstOverflowMapping.source) -> \(firstOverflowMapping.target)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.orange)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .font(.footnote)
        .padding(10)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.primary.opacity(0.10), lineWidth: 1)
        )
    }

    private func glossarySummaryText(_ summary: GlossarySummary) -> String {
        guard !summary.isEmpty else {
            return "术语表为空。支持“原词 = 译法”“原词 -> 译法”“原词：译法”、CSV/TSV 前两列等常见写法。"
        }

        var parts = ["识别到 \(summary.mappingCount) 条术语映射"]
        if summary.effectiveMappingCount != summary.mappingCount {
            parts.append("去重后 \(summary.effectiveMappingCount) 条有效映射")
        }
        if summary.overflowMappingCount > 0 {
            parts.append("本次请求只发送前 \(summary.requestMappingCount) 条，超出 \(summary.overflowMappingCount) 条仅本地保留")
        } else {
            parts.append("本次请求会发送 \(summary.requestMappingCount) 条")
        }
        if summary.ignoredLineCount > 0 {
            let sampleHint = summary.ignoredLineSamples.isEmpty ? "" : "，下方显示可修正示例"
            parts.append("\(summary.ignoredLineCount) 行备注/表头/未识别内容不会随翻译请求发送\(sampleHint)")
        }
        if !summary.duplicateSources.isEmpty {
            parts.append("有 \(summary.duplicateSources.count) 个重复原词，发送时以后者为准")
        }
        return parts.joined(separator: "；") + "。"
    }

    private func glossarySummaryColor(_ summary: GlossarySummary) -> Color {
        summary.ignoredLineCount > 0 || !summary.duplicateSources.isEmpty ? .orange : .secondary
    }

    private func glossaryMaintenanceSummary(_ summary: GlossarySummary, includeIssues: Bool = true) -> String {
        var parts = [
            "有效 \(summary.effectiveMappingCount) 条",
            "请求发送 \(summary.requestMappingCount) 条"
        ]
        if summary.overflowMappingCount > 0 {
            parts.append("\(summary.overflowMappingCount) 条仅本地保留")
        }
        if includeIssues, summary.ignoredLineCount > 0 {
            parts.append("\(summary.ignoredLineCount) 行忽略")
        }
        if includeIssues, !summary.duplicateSources.isEmpty {
            parts.append("\(summary.duplicateSources.count) 个重复以后者为准")
        }
        return parts.joined(separator: "，")
    }

    private var glossaryMaintenanceActions: some View {
        HStack(spacing: 8) {
            Button("追加导入") {
                importGlossaryText()
            }
            .controlSize(.small)

            Button("导出") {
                exportGlossaryText()
            }
            .controlSize(.small)
            .disabled(settingsStore.glossaryText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            Button("复制") {
                copyGlossaryText()
            }
            .controlSize(.small)
            .disabled(settingsStore.glossaryText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            Button("复制请求映射") {
                copyEffectiveGlossaryMappings()
            }
            .controlSize(.small)
            .disabled(GlossaryParser.promptText(from: settingsStore.glossaryText).isEmpty)

            Button("清理去重") {
                cleanGlossaryText()
            }
            .controlSize(.small)
            .disabled(GlossaryParser.cleanedText(from: settingsStore.glossaryText).isEmpty)

            if !glossaryMaintenanceMessage.isEmpty {
                Text(glossaryMaintenanceMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
    }

    private func importGlossaryText() {
        let panel = NSOpenPanel()
        panel.title = "追加导入术语表"
        panel.allowedContentTypes = glossaryImportContentTypes
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false

        panel.begin { response in
            guard response == .OK, let url = panel.url else {
                glossaryMaintenanceMessage = "已取消导入"
                return
            }
            do {
                let imported = try GlossaryImportReader.text(from: url)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                guard !imported.isEmpty else {
                    glossaryMaintenanceMessage = "导入文件为空"
                    return
                }

                let existing = settingsStore.glossaryText.trimmingCharacters(in: .whitespacesAndNewlines)
                settingsStore.glossaryText = existing.isEmpty ? imported : "\(existing)\n\(imported)"
                let summary = GlossarySummary.make(from: settingsStore.glossaryText)
                glossaryMaintenanceMessage = "已追加导入：\(glossaryMaintenanceSummary(summary))"
            } catch {
                glossaryMaintenanceMessage = "导入失败：\(error.localizedDescription)"
            }
        }
    }

    private func exportGlossaryText() {
        let text = settingsStore.glossaryText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            glossaryMaintenanceMessage = "术语表为空"
            return
        }

        let panel = NSSavePanel()
        panel.title = "导出术语表"
        panel.allowedContentTypes = [.plainText]
        panel.nameFieldStringValue = defaultGlossaryFileName
        panel.canCreateDirectories = true

        panel.begin { response in
            guard response == .OK, let url = panel.url else {
                glossaryMaintenanceMessage = "已取消导出"
                return
            }
            let exportURL = normalizedGlossaryExportURL(for: url)
            do {
                try (text + "\n").write(to: exportURL, atomically: true, encoding: .utf8)
                let summary = GlossarySummary.make(from: text)
                glossaryMaintenanceMessage = "已导出术语表：\(exportURL.lastPathComponent) · \(glossaryMaintenanceSummary(summary))"
                NSWorkspace.shared.activateFileViewerSelecting([exportURL])
            } catch {
                glossaryMaintenanceMessage = "导出失败：\(error.localizedDescription)"
            }
        }
    }

    private func copyGlossaryText() {
        let text = settingsStore.glossaryText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            glossaryMaintenanceMessage = "术语表为空"
            return
        }

        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        glossaryMaintenanceMessage = "已复制术语表"
    }

    private func copyEffectiveGlossaryMappings() {
        let text = GlossaryParser.promptText(from: settingsStore.glossaryText)
        guard !text.isEmpty else {
            glossaryMaintenanceMessage = "没有可复制的有效映射"
            return
        }

        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        let count = text.components(separatedBy: .newlines)
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .count
        let summary = GlossarySummary.make(from: settingsStore.glossaryText)
        let overflowText = summary.overflowMappingCount > 0 ? "，另有 \(summary.overflowMappingCount) 条仅本地保留" : ""
        let duplicateText = summary.duplicateSources.isEmpty ? "" : "，\(summary.duplicateSources.count) 个重复以后者为准"
        glossaryMaintenanceMessage = "已复制请求映射：\(count) 条会发送\(overflowText)\(duplicateText)"
    }

    private func cleanGlossaryText() {
        let original = settingsStore.glossaryText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !original.isEmpty else {
            glossaryMaintenanceMessage = "术语表为空"
            return
        }

        let cleaned = GlossaryParser.cleanedText(from: original)
        guard !cleaned.isEmpty else {
            glossaryMaintenanceMessage = "没有可保留的有效映射；原内容未修改"
            return
        }

        if cleaned == original {
            let summary = GlossarySummary.make(from: cleaned)
            glossaryMaintenanceMessage = "术语表已经整齐：\(glossaryMaintenanceSummary(summary, includeIssues: false))"
            return
        }

        let summary = GlossarySummary.make(from: original)
        if summary.ignoredLineCount > 0 || !summary.duplicateSources.isEmpty {
            let ignoredSampleText = summary.ignoredLineSamples.isEmpty
                ? ""
                : "。未识别示例：\(summary.ignoredLineSamples.joined(separator: "；"))"
            let alert = NSAlert()
            alert.messageText = "清理并去重术语表？"
            alert.informativeText = "将保留 \(summary.effectiveMappingCount) 条有效映射"
                + (summary.ignoredLineCount > 0 ? "，移除 \(summary.ignoredLineCount) 行未识别/备注" : "")
                + (!summary.duplicateSources.isEmpty ? "，\(summary.duplicateSources.count) 个重复原词以后者为准" : "")
                + ignoredSampleText
                + "。如果想留备份，可以先点“导出”。"
            alert.alertStyle = .warning
            alert.addButton(withTitle: "清理")
            alert.addButton(withTitle: "取消")
            guard alert.runModal() == .alertFirstButtonReturn else {
                glossaryMaintenanceMessage = "已取消清理"
                return
            }
        }

        settingsStore.glossaryText = cleaned
        let cleanedSummary = GlossarySummary.make(from: cleaned)
        glossaryMaintenanceMessage = "已清理去重：\(glossaryMaintenanceSummary(cleanedSummary, includeIssues: false))"
    }

    private var defaultGlossaryFileName: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd-HHmm"
        return "immersive-translator-glossary-\(formatter.string(from: Date())).txt"
    }

    private func normalizedGlossaryExportURL(for url: URL) -> URL {
        let extensionName = url.pathExtension.lowercased()
        if extensionName == "txt" || extensionName == "text" {
            return url
        }
        let baseURL = extensionName.isEmpty ? url : url.deletingPathExtension()
        return baseURL.appendingPathExtension("txt")
    }

    private var glossaryImportContentTypes: [UTType] {
        var types: [UTType] = [.plainText, .text]
        if let csv = UTType(filenameExtension: "csv") {
            types.append(csv)
        }
        if let tsv = UTType(filenameExtension: "tsv") {
            types.append(tsv)
        }
        return types
    }

    private func cancelProviderDiagnosticTasks() {
        cancelProviderConnectionTask()
        cancelProviderVerificationTask()
    }

    private func markProviderDiagnosticNeedsRerun(_ message: String) {
        providerDiagnostic = ProviderConnectionDiagnostic(
            level: .idle,
            endpoint: settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines),
            message: message,
            kind: .configuration,
            requestURL: providerEffectiveURL?.absoluteString,
            model: currentProviderDiagnosticModel
        )
        providerClipboardMessage = ""
    }

    private func runRequestedProviderDiagnostic() {
        guard let requestID = settingsStore.providerDiagnosticRequestID,
              requestID != lastHandledProviderDiagnosticRequestID else {
            return
        }

        lastHandledProviderDiagnosticRequestID = requestID
        providerClipboardMessage = providerTranslationVerificationDisabled
            ? "已从错误浮窗进入诊断：先测试接口连通性"
            : "已从错误浮窗进入诊断：正在验证翻译请求"

        if providerTranslationVerificationDisabled {
            runProviderConnectionDiagnostic()
        } else {
            runProviderTranslationVerification()
        }
    }

    private func cancelProviderConnectionTask() {
        providerDiagnosticRunID = UUID()
        providerDiagnosticTask?.cancel()
        providerDiagnosticTask = nil
        isTestingProviderConnection = false
    }

    private func cancelProviderVerificationTask() {
        providerTranslationRunID = UUID()
        providerTranslationTask?.cancel()
        providerTranslationTask = nil
        isVerifyingProviderTranslation = false
    }

    private func runProviderConnectionDiagnostic() {
        let endpoint = settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !endpoint.isEmpty else {
            providerDiagnostic = ProviderConnectionDiagnostic(
                level: .failure,
                endpoint: endpoint,
                message: "接口地址为空，无法测试。",
                kind: .configuration,
                completedAt: Date(),
                model: currentProviderDiagnosticModel
            )
            return
        }

        guard let url = TranslationClient.chatCompletionsURL(from: endpoint) else {
            providerDiagnostic = ProviderConnectionDiagnostic(
                level: .failure,
                endpoint: endpoint,
                message: "接口地址不是有效 URL，请填写完整 HTTPS 地址。",
                kind: .configuration,
                completedAt: Date(),
                model: currentProviderDiagnosticModel
            )
            return
        }

        cancelProviderConnectionTask()
        let runID = UUID()
        providerDiagnosticRunID = runID
        isTestingProviderConnection = true
        providerDiagnostic = ProviderConnectionDiagnostic(
            level: .idle,
            endpoint: endpoint,
            message: "正在连接 \(url.host() ?? "接口服务器")...",
            kind: .connection,
            requestURL: url.absoluteString,
            model: currentProviderDiagnosticModel
        )
        DiagnosticLogger.log("provider.diagnostic.start endpoint=\(TranslationClient.redactedURLString(url.absoluteString))")

        providerDiagnosticTask = Task {
            let result = await Self.testProviderConnection(url: url, originalEndpoint: endpoint)
            await MainActor.run {
                defer {
                    if providerDiagnosticRunID == runID {
                        isTestingProviderConnection = false
                        providerDiagnosticTask = nil
                    }
                }
                guard providerDiagnosticRunID == runID else {
                    return
                }
                guard result.endpoint == settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines) else {
                    return
                }
                providerDiagnostic = result
            }
        }
    }

    private func runProviderTranslationVerification() {
        cancelProviderConnectionTask()
        cancelProviderVerificationTask()

        let endpoint = settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !endpoint.isEmpty else {
            providerDiagnostic = ProviderConnectionDiagnostic(
                level: .failure,
                endpoint: endpoint,
                message: "接口地址为空，无法验证翻译请求。",
                kind: .configuration,
                completedAt: Date(),
                model: currentProviderDiagnosticModel
            )
            return
        }

        let requestURL = TranslationClient.chatCompletionsURL(from: endpoint)?.absoluteString
        guard !providerRequiresAPIKey || !(KeychainStore.apiKey(for: settingsStore.activeProviderID) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            providerDiagnostic = ProviderConnectionDiagnostic(
                level: .failure,
                endpoint: endpoint,
                message: "还没有填写 API Key。真实请求验证需要 API Key，连通性测试不需要。",
                kind: .configuration,
                completedAt: Date(),
                requestURL: requestURL,
                model: currentProviderDiagnosticModel
            )
            return
        }

        let model = settingsStore.activeProvider.model.trimmingCharacters(in: .whitespacesAndNewlines)
        let apiKey = (KeychainStore.apiKey(for: settingsStore.activeProviderID) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let runID = UUID()
        let verificationText = "Provider diagnostic ping: translate this short sentence."
        providerTranslationRunID = runID
        isVerifyingProviderTranslation = true
        providerDiagnostic = ProviderConnectionDiagnostic(
            level: .idle,
            endpoint: endpoint,
            message: "正在发送短文本验证请求...",
            kind: .translation,
            requestURL: requestURL,
            model: currentProviderDiagnosticModel
        )
        DiagnosticLogger.log("provider.translation_verification.start endpoint=\(TranslationClient.redactedURLString(endpoint)) model=\(model)")

        providerTranslationTask = Task { @MainActor in
            let startedAt = Date()
            defer {
                if providerTranslationRunID == runID {
                    isVerifyingProviderTranslation = false
                    providerTranslationTask = nil
                }
            }
            do {
                let result = try await TranslationClient(settingsStore: settingsStore)
                    .translateWithMetadata(text: verificationText)
                guard isCurrentProviderVerification(endpoint: endpoint, model: model, apiKey: apiKey, runID: runID) else {
                    return
                }
                let elapsedText = String(format: "%.1fs", Date().timeIntervalSince(startedAt))
                let elapsed = Date().timeIntervalSince(startedAt)
                let preview = compactProviderDiagnosticPreview(result.text)
                let latencyLabel = ProviderLatencyAssessment.make(
                    kind: .translation,
                    elapsed: elapsed,
                    isLocalEndpoint: isLocalProviderEndpoint
                )?.label ?? "延迟未评估"
                providerDiagnostic = ProviderConnectionDiagnostic(
                    level: .success,
                    endpoint: endpoint,
                    message: "真实翻译请求成功，用时 \(elapsedText)（\(latencyLabel)）。模型：\(result.model)，目标：\(result.targetLanguage)。返回预览：\(preview)",
                    kind: .translation,
                    completedAt: Date(),
                    elapsed: elapsed,
                    requestURL: requestURL,
                    model: result.model
                )
                DiagnosticLogger.log("provider.translation_verification.success elapsed=\(elapsedText) model=\(result.model) target=\(result.targetLanguage)")
            } catch {
                guard isCurrentProviderVerification(endpoint: endpoint, model: model, apiKey: apiKey, runID: runID) else {
                    return
                }
                let elapsed = Date().timeIntervalSince(startedAt)
                providerDiagnostic = ProviderConnectionDiagnostic(
                    level: .failure,
                    endpoint: endpoint,
                    message: ErrorMessageFormatter.message(for: error),
                    kind: .translation,
                    completedAt: Date(),
                    elapsed: elapsed,
                    statusCode: providerStatusCode(for: error),
                    requestURL: requestURL,
                    model: currentProviderDiagnosticModel
                )
                DiagnosticLogger.log("provider.translation_verification.failed error=\(error.localizedDescription)")
            }
        }
    }

    private var currentProviderDiagnosticModel: String {
        let model = settingsStore.activeProvider.model.trimmingCharacters(in: .whitespacesAndNewlines)
        return model.isEmpty ? "gpt-5.4-mini (default fallback)" : model
    }

    private func providerStatusCode(for error: Error) -> Int? {
        guard let translationError = error as? TranslationClientError else {
            return nil
        }

        switch translationError {
        case .badResponse(let statusCode, _):
            return statusCode
        case .invalidEndpoint, .missingAPIKey, .emptyTranslation, .invalidResponse:
            return nil
        }
    }

    private func isCurrentProviderVerification(endpoint: String, model: String, apiKey: String, runID: UUID) -> Bool {
        providerTranslationRunID == runID
            && endpoint == settingsStore.activeProvider.endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
            && model == settingsStore.activeProvider.model.trimmingCharacters(in: .whitespacesAndNewlines)
            && apiKey == (KeychainStore.apiKey(for: settingsStore.activeProviderID) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func compactProviderDiagnosticPreview(_ text: String, maxLength: Int = 48) -> String {
        let collapsed = text
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        guard !collapsed.isEmpty else { return "空结果" }
        guard collapsed.count > maxLength else { return collapsed }
        return "\(collapsed.prefix(maxLength))..."
    }

    private static func testProviderConnection(url: URL, originalEndpoint: String) async -> ProviderConnectionDiagnostic {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 6
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let startedAt = Date()
        let safeURLString = TranslationClient.redactedURLString(url.absoluteString)
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let elapsed = Date().timeIntervalSince(startedAt)
            let elapsedText = String(format: "%.1fs", elapsed)
            guard let httpResponse = response as? HTTPURLResponse else {
                DiagnosticLogger.log("provider.diagnostic.non_http elapsed=\(elapsedText) endpoint=\(safeURLString)")
                return ProviderConnectionDiagnostic(
                    level: .warning,
                    endpoint: originalEndpoint,
                    message: "已收到响应，用时 \(elapsedText)，但不是标准 HTTP 响应。请确认接口服务是否兼容。",
                    kind: .connection,
                    completedAt: Date(),
                    elapsed: elapsed,
                    requestURL: url.absoluteString
                )
            }

            let statusCode = httpResponse.statusCode
            DiagnosticLogger.log("provider.diagnostic.http status=\(statusCode) elapsed=\(elapsedText) endpoint=\(safeURLString)")
            switch statusCode {
            case 200..<300:
                if let inspection = ProviderConnectionBodyInspector.inspect(data: data, elapsedText: elapsedText) {
                    return ProviderConnectionDiagnostic(
                        level: inspection.level,
                        endpoint: originalEndpoint,
                        message: inspection.message,
                        kind: .connection,
                        completedAt: Date(),
                        elapsed: elapsed,
                        statusCode: statusCode,
                        requestURL: url.absoluteString
                    )
                }
                return ProviderConnectionDiagnostic(
                    level: .success,
                    endpoint: originalEndpoint,
                    message: "接口可连接，首个响应 \(elapsedText)。这只代表网络通，不代表模型或额度已验证。",
                    kind: .connection,
                    completedAt: Date(),
                    elapsed: elapsed,
                    statusCode: statusCode,
                    requestURL: url.absoluteString
                )
            case 401, 403:
                return ProviderConnectionDiagnostic(
                    level: .success,
                    endpoint: originalEndpoint,
                    message: "接口已连通，首个响应 \(elapsedText)，服务端要求认证/权限。下一步请检查 API Key、账号权限和模型开通状态。",
                    kind: .connection,
                    completedAt: Date(),
                    elapsed: elapsed,
                    statusCode: statusCode,
                    requestURL: url.absoluteString
                )
            case 404:
                return ProviderConnectionDiagnostic(
                    level: .warning,
                    endpoint: originalEndpoint,
                    message: "网络已连通，首个响应 \(elapsedText)，但服务端返回 404。若翻译也报 404，请优先核对接口路径和模型名。",
                    kind: .connection,
                    completedAt: Date(),
                    elapsed: elapsed,
                    statusCode: statusCode,
                    requestURL: url.absoluteString
                )
            case 405:
                return ProviderConnectionDiagnostic(
                    level: .success,
                    endpoint: originalEndpoint,
                    message: "接口已连通，首个响应 \(elapsedText)。服务端拒绝 GET 是正常现象；真正翻译会使用 POST。",
                    kind: .connection,
                    completedAt: Date(),
                    elapsed: elapsed,
                    statusCode: statusCode,
                    requestURL: url.absoluteString
                )
            case 429:
                return ProviderConnectionDiagnostic(
                    level: .warning,
                    endpoint: originalEndpoint,
                    message: "接口已连通，首个响应 \(elapsedText)，但服务端提示限流。请稍后重试或检查账号额度/频率限制。",
                    kind: .connection,
                    completedAt: Date(),
                    elapsed: elapsed,
                    statusCode: statusCode,
                    requestURL: url.absoluteString
                )
            case 500...599:
                return ProviderConnectionDiagnostic(
                    level: .warning,
                    endpoint: originalEndpoint,
                    message: "接口已连通，首个响应 \(elapsedText)，但服务端返回 HTTP \(statusCode)。可能是服务商临时异常或模型繁忙。",
                    kind: .connection,
                    completedAt: Date(),
                    elapsed: elapsed,
                    statusCode: statusCode,
                    requestURL: url.absoluteString
                )
            default:
                return ProviderConnectionDiagnostic(
                    level: .warning,
                    endpoint: originalEndpoint,
                    message: "接口已返回 HTTP \(statusCode)，首个响应 \(elapsedText)。网络可达；若翻译失败，再按错误提示检查 Key、模型和额度。",
                    kind: .connection,
                    completedAt: Date(),
                    elapsed: elapsed,
                    statusCode: statusCode,
                    requestURL: url.absoluteString
                )
            }
        } catch {
            let elapsed = Date().timeIntervalSince(startedAt)
            let elapsedText = String(format: "%.1fs", elapsed)
            DiagnosticLogger.log("provider.diagnostic.error elapsed=\(elapsedText) endpoint=\(safeURLString) error=\(error.localizedDescription)")
            if let urlError = error as? URLError {
                return ProviderConnectionDiagnostic(
                    level: .failure,
                    endpoint: originalEndpoint,
                    message: providerNetworkDiagnosticMessage(for: urlError, url: url, elapsedText: elapsedText),
                    kind: .connection,
                    completedAt: Date(),
                    elapsed: elapsed,
                    requestURL: url.absoluteString
                )
            }
            return ProviderConnectionDiagnostic(
                level: .failure,
                endpoint: originalEndpoint,
                message: "接口连接测试失败，用时 \(elapsedText)。详细信息：\(error.localizedDescription)",
                kind: .connection,
                completedAt: Date(),
                elapsed: elapsed,
                requestURL: url.absoluteString
            )
        }
    }

    private static func providerNetworkDiagnosticMessage(for error: URLError, url: URL, elapsedText: String) -> String {
        let endpointText = providerEndpointDescription(for: url)
        let endpointSuffix = endpointText.map { " 主机：\($0)。" } ?? ""
        let isLocalEndpoint = isLocalProviderHost(url.host())

        switch error.code {
        case .timedOut:
            if isLocalEndpoint {
                return "本地接口连接测试超时，用时 \(elapsedText)。\(localProviderRecoveryHint(for: url, reason: .timeout))\(endpointSuffix)"
            }
            return "连接测试超时，用时 \(elapsedText)。通常是网络到服务商较慢、代理不可用、DNS 卡住，或接口地址无法访问。\(endpointSuffix)"
        case .cannotFindHost:
            return "找不到接口域名，用时 \(elapsedText)。请检查接口地址拼写，或当前代理/VPN 是否能解析这个服务商。\(endpointSuffix)"
        case .dnsLookupFailed:
            return "DNS 解析失败，用时 \(elapsedText)。请检查系统 DNS、代理/VPN，或换一个网络后再测试。\(endpointSuffix)"
        case .cannotConnectToHost:
            if isLocalEndpoint {
                return "无法连接本地接口，用时 \(elapsedText)。\(localProviderRecoveryHint(for: url, reason: .cannotConnect))\(endpointSuffix)"
            }
            return "接口主机可以识别，但连接没有建立，用时 \(elapsedText)。请检查代理/VPN、防火墙、服务商入口状态或接口端口。\(endpointSuffix)"
        case .networkConnectionLost:
            return "网络连接中断，用时 \(elapsedText)。请检查当前网络、代理或 VPN 是否稳定后再测试。\(endpointSuffix)"
        case .notConnectedToInternet:
            return "当前没有网络连接。联网后再测试。"
        case .badURL, .unsupportedURL:
            return "接口地址格式不正确。请填写完整 HTTPS 地址。"
        case .appTransportSecurityRequiresSecureConnection:
            return "macOS 拦截了非安全连接。云服务商建议使用 HTTPS；如果是本地接口，请确认地址和系统安全策略。\(endpointSuffix)"
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid:
            return "HTTPS 安全连接失败。请确认接口地址使用可信证书；如果走代理，也要确认代理证书已被系统信任。\(endpointSuffix)"
        case .cannotLoadFromNetwork, .dataNotAllowed:
            return "系统网络策略不允许访问这个接口。请检查网络权限、低数据模式、代理/VPN 或企业防火墙。\(endpointSuffix)"
        case .cannotParseResponse:
            return "接口响应无法解析。常见原因是地址填到了网页、代理登录页或非 Chat Completions 接口。\(endpointSuffix)"
        case .httpTooManyRedirects, .redirectToNonExistentLocation:
            return "接口发生异常跳转。请检查地址是否填成控制台网页、登录页、短链，或代理网关是否要求登录。\(endpointSuffix)"
        case .clientCertificateRequired, .clientCertificateRejected:
            return "接口要求客户端证书认证。普通 OpenAI 兼容接口通常不需要证书，请检查代理、网关或企业网络配置。\(endpointSuffix)"
        default:
            return "接口连接测试失败，用时 \(elapsedText)。\(endpointSuffix)详细信息：\(error.localizedDescription)"
        }
    }

    private static func providerEndpointDescription(for url: URL) -> String? {
        guard let host = url.host(), !host.isEmpty else { return nil }
        guard let port = url.port else { return host }
        return "\(host):\(port)"
    }

    private enum LocalProviderRecoveryReason {
        case cannotConnect
        case timeout
    }

    private static func localProviderRecoveryHint(for url: URL, reason: LocalProviderRecoveryReason) -> String {
        let actionPrefix: String
        switch reason {
        case .cannotConnect:
            actionPrefix = "请先确认本机服务已启动，端口和路径正确。"
        case .timeout:
            actionPrefix = "请确认本机服务仍在运行、模型已加载完成，端口没有被代理或防火墙拦截。"
        }

        switch url.port {
        case 11434:
            return "\(actionPrefix) 这看起来像 Ollama：可先运行 `ollama list` / `ollama pull <模型名>`，并确认路径类似 `http://localhost:11434/v1/chat/completions`。"
        case 1234:
            return "\(actionPrefix) 这看起来像 LM Studio：请在 Developer 里 Start Server、加载模型，并把模型名改成已加载模型的 identifier。"
        case 8000:
            return "\(actionPrefix) 这看起来像 vLLM：请确认 `vllm serve <模型名>` 仍在运行，并检查 `/v1/models` 是否能返回模型列表。"
        default:
            return "\(actionPrefix) 如果是本地 OpenAI 兼容服务，请检查服务进程、端口、防火墙和 `/v1/chat/completions` 路径。"
        }
    }

    private static func isLocalProviderHost(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else { return false }
        return host == "localhost"
            || host == "127.0.0.1"
            || host == "::1"
            || host == "0.0.0.0"
    }

    // 服务商选择区:三常驻卡片 + 自定义列表 + 添加按钮
    private var providerSelector: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                ForEach(settingsStore.providers.filter { $0.isBuiltin }) { profile in
                    builtinProviderCard(profile)
                }
            }

            let customProviders = settingsStore.providers.filter { !$0.isBuiltin }
            if !customProviders.isEmpty {
                Text("自定义").font(.caption).foregroundStyle(.secondary)
                VStack(spacing: 6) {
                    ForEach(customProviders) { profile in
                        customProviderRow(profile)
                    }
                }
            }

            Button {
                showAddCustomProvider = true
            } label: {
                Label("添加自定义提供商", systemImage: "plus")
                    .font(.footnote)
            }
            .buttonStyle(.borderless)
        }
    }

    private func builtinProviderCard(_ profile: ProviderProfile) -> some View {
        let isSelected = settingsStore.activeProviderID == profile.id

        return Button {
            selectProvider(profile.id)
        } label: {
            VStack(alignment: .leading, spacing: 7) {
                HStack(alignment: .firstTextBaseline) {
                    Text(profile.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Spacer()
                    if isSelected {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                }
                Text(profile.model)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(isSelected ? Color.accentColor.opacity(0.12) : Color.primary.opacity(0.05))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(isSelected ? Color.accentColor.opacity(0.45) : Color.primary.opacity(0.10), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .help("切换到 \(profile.displayName)")
    }

    private func customProviderRow(_ profile: ProviderProfile) -> some View {
        let isSelected = settingsStore.activeProviderID == profile.id
        return HStack(spacing: 8) {
            Button {
                selectProvider(profile.id)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                        .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(profile.displayName).font(.subheadline)
                        Text("\(profile.endpoint) · \(profile.model)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                }
            }
            .buttonStyle(.plain)

            Button(role: .destructive) {
                pendingDeleteProvider = profile
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.red.opacity(0.6))
            }
            .buttonStyle(.plain)
            .help("删除 \(profile.displayName)")
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(isSelected ? Color.accentColor.opacity(0.08) : Color.clear)
        )
    }

    private var modelCandidatePicker: some View {
        HStack {
            Picker("模型候选", selection: Binding(
                get: { settingsStore.activeProvider.model },
                set: { newValue in settingsStore.updateActiveProvider { $0.model = newValue } }
            )) {
                ForEach(settingsStore.activeProvider.modelCandidates, id: \.self) { candidate in
                    Text(candidate).tag(candidate)
                }
            }
            .labelsHidden()
            Spacer()
            Button("自定义...") {
                customModelInput = ""
                showCustomModelInput = true
            }
            .font(.footnote)
            .buttonStyle(.borderless)
        }
        .sheet(isPresented: $showCustomModelInput) {
            VStack(alignment: .leading, spacing: 12) {
                Text("输入模型名").font(.headline)
                TextField("如 deepseek-v4-turbo", text: $customModelInput)
                    .textFieldStyle(.roundedBorder)
                HStack {
                    Spacer()
                    Button("取消") { showCustomModelInput = false }
                    Button("确定") {
                        let trimmed = customModelInput.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            settingsStore.updateActiveProvider { $0.model = trimmed }
                            settingsStore.recordCustomModel(trimmed)
                        }
                        showCustomModelInput = false
                    }
                }
            }
            .padding()
            .frame(width: 320)
        }
    }

    // 统一处理"选中 provider":切换 + 重置诊断 View 状态。
    // (providerDiagnostic/providerPresetMessage 是 View @State, 在这里重置)
    private func selectProvider(_ id: String) {
        cancelProviderDiagnosticTasks()
        settingsStore.switchActiveProvider(to: id)
        providerDiagnostic = .idle
        providerPresetMessage = ""
        providerClipboardMessage = ""
    }

    // MARK: - 自定义 provider 增删表单

    private func addCustomProvider() {
        let name = newProviderName.trimmingCharacters(in: .whitespacesAndNewlines)
        let endpoint = newProviderEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !endpoint.isEmpty else { return }
        let model = newProviderModel.trimmingCharacters(in: .whitespacesAndNewlines)
        let profile = ProviderProfile(
            id: UUID().uuidString,
            displayName: name,
            endpoint: endpoint,
            model: model.isEmpty ? "gpt-3.5-turbo" : model,
            isBuiltin: false,
            customModels: []
        )
        settingsStore.providers.append(profile)
        selectProvider(profile.id)
        newProviderName = ""
        newProviderEndpoint = ""
        newProviderModel = ""
        showAddCustomProvider = false
    }

    private func confirmDeleteCustomProvider() {
        guard let profile = pendingDeleteProvider else { return }
        settingsStore.deleteCustomProvider(profile.id)
        pendingDeleteProvider = nil
    }

    private var hotKeyConflictMessage: String? {
        guard settingsStore.selectionHotKeyShortcut == settingsStore.ocrHotKeyShortcut else {
            return nil
        }
        return "两个功能都使用 \(settingsStore.selectionHotKeyShortcut.title)。请录制不同快捷键，避免只触发其中一个。建议试试：\(hotKeySuggestionText(excluding: settingsStore.selectionHotKeyShortcut))。"
    }

    private func hotKeyRecorderRow(
        title: String,
        shortcut: HotKeyShortcut,
        target: HotKeyRecorderTarget,
        onRecord: @escaping (HotKeyShortcut) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(shortcut.title)
                        .font(.system(size: 14, weight: .medium, design: .rounded))
                        .textSelection(.enabled)
                    Text(hotKeyRecorderDetailText(for: target, shortcut: shortcut))
                        .font(.caption2)
                        .foregroundStyle(hotKeyRecorderDetailColor(for: target, shortcut: shortcut))
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()

                Button(recordingHotKey == target ? "按下组合键..." : "录制") {
                    recordingHotKey = target
                    hotKeyRecorderMessage = "正在录制 \(title)：按 Esc 取消。"
                }
                .controlSize(.small)

                Button("恢复默认") {
                    switch target {
                    case .selection:
                        onRecord(.optionSpace)
                    case .ocr:
                        onRecord(.controlOptionSpace)
                    }
                    recordingHotKey = nil
                    hotKeyRecorderMessage = "已恢复 \(title) 默认快捷键。"
                }
                .controlSize(.small)
                .disabled(shortcut == defaultHotKeyShortcut(for: target))
                .help("恢复为 \(defaultHotKeyShortcut(for: target).title)")
            }

            if let advisory = hotKeyAdvisoryMessage(for: shortcut, target: target) {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle")
                    Text(advisory)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.caption)
                .foregroundStyle(.orange)
            }
        }
        .padding(10)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(recordingHotKey == target ? Color.accentColor.opacity(0.65) : Color.primary.opacity(0.10), lineWidth: 1)
        )
        .background(
            HotKeyRecorderBridge(
                isRecording: recordingHotKey == target,
                onRecord: { shortcut in
                    onRecord(shortcut)
                    recordingHotKey = nil
                    hotKeyRecorderMessage = hotKeyRecordedMessage(title: title, shortcut: shortcut, target: target)
                },
                onCancel: {
                    recordingHotKey = nil
                    hotKeyRecorderMessage = "已取消录制 \(title)。"
                },
                onInvalid: { reason in
                    hotKeyRecorderMessage = "\(reason) 建议试试：\(hotKeySuggestionText(excluding: shortcut, target: target))。"
                }
            )
            .frame(width: 0, height: 0)
        )
    }

    private func defaultHotKeyShortcut(for target: HotKeyRecorderTarget) -> HotKeyShortcut {
        switch target {
        case .selection:
            return .optionSpace
        case .ocr:
            return .controlOptionSpace
        }
    }

    private func hotKeyRecorderDetailText(for target: HotKeyRecorderTarget, shortcut: HotKeyShortcut) -> String {
        if shortcut == otherHotKeyShortcut(for: target) {
            return "与\(otherHotKeyTitle(for: target))重复；建议：\(hotKeySuggestionText(excluding: shortcut, target: target))"
        }
        if shortcut == defaultHotKeyShortcut(for: target) {
            return "默认快捷键"
        }
        return "自定义快捷键；默认：\(defaultHotKeyShortcut(for: target).title)"
    }

    private func hotKeyRecorderDetailColor(for target: HotKeyRecorderTarget, shortcut: HotKeyShortcut) -> Color {
        if shortcut == otherHotKeyShortcut(for: target) {
            return .red
        }
        return shortcut == defaultHotKeyShortcut(for: target) ? Color.secondary : Color.orange
    }

    private func hotKeyRecordedMessage(title: String, shortcut: HotKeyShortcut, target: HotKeyRecorderTarget) -> String {
        if shortcut == otherHotKeyShortcut(for: target) {
            return "已录制 \(title)：\(shortcut.title)，但它和\(otherHotKeyTitle(for: target))重复；重复组合只会有一个功能能注册成全局热键。建议试试：\(hotKeySuggestionText(excluding: shortcut, target: target))。"
        }
        if shortcut == defaultHotKeyShortcut(for: target) {
            return "已录制 \(title)：\(shortcut.title)，这是默认快捷键；如果没有橙色注册提示，说明已注册为全局热键。"
        }
        if let advisory = hotKeyAdvisoryMessage(for: shortcut, target: target) {
            return "已录制 \(title)：\(shortcut.title)，并已尝试注册为全局热键。\(advisory)"
        }
        return "已录制 \(title)：\(shortcut.title)；如果没有橙色注册提示，说明已注册为全局热键。"
    }

    private func hotKeySuggestionText(
        excluding shortcut: HotKeyShortcut,
        target: HotKeyRecorderTarget? = nil
    ) -> String {
        var excludedShortcuts = [shortcut]
        if let target {
            excludedShortcuts.append(otherHotKeyShortcut(for: target))
        }

        return HotKeyShortcut.suggestionText(excluding: excludedShortcuts)
    }

    private func otherHotKeyShortcut(for target: HotKeyRecorderTarget) -> HotKeyShortcut {
        switch target {
        case .selection:
            return settingsStore.ocrHotKeyShortcut
        case .ocr:
            return settingsStore.selectionHotKeyShortcut
        }
    }

    private func otherHotKeyTitle(for target: HotKeyRecorderTarget) -> String {
        switch target {
        case .selection:
            return "截图 OCR 翻译"
        case .ocr:
            return "选中文本翻译"
        }
    }

    private func hotKeyAdvisoryMessage(for shortcut: HotKeyShortcut, target: HotKeyRecorderTarget) -> String? {
        let suggestion = hotKeySuggestionText(excluding: shortcut, target: target)
        return shortcut.advisoryMessage(suggestion: suggestion)
    }
}

private enum HotKeyRecorderTarget {
    case selection
    case ocr
}

private struct HotKeyRecorderBridge: NSViewRepresentable {
    let isRecording: Bool
    let onRecord: (HotKeyShortcut) -> Void
    let onCancel: () -> Void
    let onInvalid: (String) -> Void

    func makeNSView(context: Context) -> HotKeyRecorderView {
        let view = HotKeyRecorderView()
        view.onRecord = onRecord
        view.onCancel = onCancel
        view.onInvalid = onInvalid
        return view
    }

    func updateNSView(_ view: HotKeyRecorderView, context: Context) {
        view.onRecord = onRecord
        view.onCancel = onCancel
        view.onInvalid = onInvalid
        view.isRecording = isRecording
        if isRecording {
            DispatchQueue.main.async {
                view.window?.makeFirstResponder(view)
            }
        }
    }
}

private final class HotKeyRecorderView: NSView {
    var onRecord: ((HotKeyShortcut) -> Void)?
    var onCancel: (() -> Void)?
    var onInvalid: ((String) -> Void)?
    var isRecording = false

    override var acceptsFirstResponder: Bool { true }

    override func keyDown(with event: NSEvent) {
        guard isRecording else {
            super.keyDown(with: event)
            return
        }

        if event.keyCode == UInt16(kVK_Escape) {
            onCancel?()
            return
        }

        guard let shortcut = HotKeyShortcut(event: event) else {
            onInvalid?(invalidHotKeyReason(for: event))
            return
        }

        onRecord?(shortcut)
    }

    private func invalidHotKeyReason(for event: NSEvent) -> String {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let hasCoreModifier = flags.contains(.command) || flags.contains(.control) || flags.contains(.option)

        if !hasCoreModifier {
            if flags.contains(.shift) {
                return "只有 Shift 不适合作为全局快捷键。请同时按住 Control、Option 或 Command。"
            }
            return "单独按键不能作为全局快捷键。请按下带 Control、Option 或 Command 的组合键。"
        }

        let fallback = event.charactersIgnoringModifiers?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if fallback.isEmpty, !Self.knownKeyLabels.contains(UInt32(event.keyCode)) {
            return "这个按键无法识别为稳定的全局快捷键。请换成字母、数字、空格或功能键组合。"
        }

        return "这个组合键不能作为全局快捷键。请换一个包含 Control、Option 或 Command 的组合。"
    }

    private static let knownKeyLabels: Set<UInt32> = [
        UInt32(kVK_Space),
        UInt32(kVK_Return),
        UInt32(kVK_Tab),
        UInt32(kVK_Delete),
        UInt32(kVK_ForwardDelete),
        UInt32(kVK_Home),
        UInt32(kVK_End),
        UInt32(kVK_PageUp),
        UInt32(kVK_PageDown),
        UInt32(kVK_LeftArrow),
        UInt32(kVK_RightArrow),
        UInt32(kVK_UpArrow),
        UInt32(kVK_DownArrow),
        UInt32(kVK_F1),
        UInt32(kVK_F2),
        UInt32(kVK_F3),
        UInt32(kVK_F4),
        UInt32(kVK_F5),
        UInt32(kVK_F6),
        UInt32(kVK_F7),
        UInt32(kVK_F8),
        UInt32(kVK_F9),
        UInt32(kVK_F10),
        UInt32(kVK_F11),
        UInt32(kVK_F12)
    ]
}
