import AppKit
import SwiftUI

final class SettingsStore: ObservableObject {
    @Published var apiKey: String {
        didSet {
            do {
                try KeychainStore.setString(apiKey, service: Keys.keychainService, account: Keys.apiKey)
                UserDefaults.standard.removeObject(forKey: Keys.apiKey)
                apiKeyStorageError = nil
            } catch {
                apiKeyStorageError = error.localizedDescription
            }
        }
    }

    @Published var apiKeyStorageError: String?

    @Published var endpoint: String {
        didSet { UserDefaults.standard.set(endpoint, forKey: Keys.endpoint) }
    }

    @Published var model: String {
        didSet { UserDefaults.standard.set(model, forKey: Keys.model) }
    }

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

    @Published var selectionHotKeyPreset: SelectionHotKeyPreset {
        didSet { UserDefaults.standard.set(selectionHotKeyPreset.rawValue, forKey: Keys.selectionHotKeyPreset) }
    }

    @Published var ocrHotKeyPreset: OCRHotKeyPreset {
        didSet { UserDefaults.standard.set(ocrHotKeyPreset.rawValue, forKey: Keys.ocrHotKeyPreset) }
    }

    init() {
        let apiKeyResult = Self.loadAPIKey()
        apiKey = apiKeyResult.value
        apiKeyStorageError = apiKeyResult.errorMessage
        endpoint = UserDefaults.standard.string(forKey: Keys.endpoint) ?? "https://api.openai.com/v1/chat/completions"
        model = UserDefaults.standard.string(forKey: Keys.model) ?? "gpt-4o-mini"
        targetLanguage = UserDefaults.standard.string(forKey: Keys.targetLanguage) ?? "简体中文"
        translationDirection = TranslationDirection(rawValue: UserDefaults.standard.string(forKey: Keys.translationDirection) ?? "") ?? .autoChineseEnglish
        ocrMode = OCRRecognitionMode(rawValue: UserDefaults.standard.string(forKey: Keys.ocrMode) ?? "") ?? .accurate
        ocrLanguagePreset = OCRLanguagePreset(rawValue: UserDefaults.standard.string(forKey: Keys.ocrLanguagePreset) ?? "") ?? .autoMixed
        enableStreamingTranslation = UserDefaults.standard.object(forKey: Keys.enableStreamingTranslation) as? Bool ?? true
        selectionHotKeyPreset = SelectionHotKeyPreset(rawValue: UserDefaults.standard.string(forKey: Keys.selectionHotKeyPreset) ?? "") ?? .optionSpace
        ocrHotKeyPreset = OCRHotKeyPreset(rawValue: UserDefaults.standard.string(forKey: Keys.ocrHotKeyPreset) ?? "") ?? .controlOptionSpace
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

    private static func loadAPIKey() -> (value: String, errorMessage: String?) {
        let legacyKey = UserDefaults.standard.string(forKey: Keys.apiKey) ?? ""

        do {
            if let keychainKey = try KeychainStore.string(service: Keys.keychainService, account: Keys.apiKey),
               !keychainKey.isEmpty {
                UserDefaults.standard.removeObject(forKey: Keys.apiKey)
                UserDefaults.standard.synchronize()
                return (keychainKey, nil)
            }

            if !legacyKey.isEmpty {
                try KeychainStore.setString(legacyKey, service: Keys.keychainService, account: Keys.apiKey)
                UserDefaults.standard.removeObject(forKey: Keys.apiKey)
                UserDefaults.standard.synchronize()
                return (legacyKey, nil)
            }
            UserDefaults.standard.removeObject(forKey: Keys.apiKey)
            UserDefaults.standard.synchronize()
            return ("", nil)
        } catch {
            if legacyKey.isEmpty {
                UserDefaults.standard.removeObject(forKey: Keys.apiKey)
                UserDefaults.standard.synchronize()
            }
            return (legacyKey, error.localizedDescription)
        }
    }

    private enum Keys {
        static let apiKey = "apiKey"
        static let keychainService = "local.immersive-translator.mvp"
        static let endpoint = "endpoint"
        static let model = "model"
        static let targetLanguage = "targetLanguage"
        static let translationDirection = "translationDirection"
        static let ocrMode = "ocrMode"
        static let ocrLanguagePreset = "ocrLanguagePreset"
        static let enableStreamingTranslation = "enableStreamingTranslation"
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
                        labeledField("API Key", text: $settingsStore.apiKey, secure: true)
                        labeledField("接口地址", text: $settingsStore.endpoint)
                        labeledField("模型", text: $settingsStore.model)

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

                    settingsSection("常用配置") {
                        HStack(spacing: 8) {
                            presetButton("DeepSeek 快速", endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-chat")
                            presetButton("DeepSeek V4 Flash", endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-v4-flash")
                            presetButton("OpenAI Mini", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini")
                        }
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

                        Text("语言越少通常越快、误识别越少；混合适合临时看不准语言的截图。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    settingsSection("快捷键") {
                        Picker("选中文本翻译", selection: $settingsStore.selectionHotKeyPreset) {
                            ForEach(SelectionHotKeyPreset.allCases) { preset in
                                Text(preset.title).tag(preset)
                            }
                        }
                        .pickerStyle(.menu)

                        Picker("截图 OCR 翻译", selection: $settingsStore.ocrHotKeyPreset) {
                            ForEach(OCRHotKeyPreset.allCases) { preset in
                                Text(preset.title).tag(preset)
                            }
                        }
                        .pickerStyle(.menu)
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
        let endpoint = settingsStore.endpoint.lowercased()
        if endpoint.contains("deepseek") {
            return "DeepSeek 兼容接口"
        }
        if endpoint.contains("bigmodel") || endpoint.contains("z.ai") {
            return "智谱 GLM 兼容接口"
        }
        if endpoint.contains("openai") {
            return "OpenAI 接口"
        }
        return "OpenAI Chat Completions 兼容接口"
    }

    private func presetButton(_ title: String, endpoint: String, model: String) -> some View {
        Button(title) {
            settingsStore.endpoint = endpoint
            settingsStore.model = model
        }
        .controlSize(.small)
        .help("填入 \(model) 的接口和模型名，不会改动 API Key")
    }
}
