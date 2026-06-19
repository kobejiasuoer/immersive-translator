import AppKit
import SwiftUI

@MainActor
private final class OnboardingModel: ObservableObject {
    @Published var isAccessibilityTrusted = PermissionPrompter.isAccessibilityTrusted()
    @Published var isScreenCaptureTrusted = PermissionPrompter.isScreenCaptureTrusted()
    @Published var didStartOCRTrial = false
    weak var window: NSWindow?

    func refresh() {
        isAccessibilityTrusted = PermissionPrompter.isAccessibilityTrusted()
        isScreenCaptureTrusted = PermissionPrompter.isScreenCaptureTrusted()
    }

    func close() {
        window?.close()
    }
}

final class OnboardingWindowController: NSWindowController {
    private let model = OnboardingModel()

    init(
        settingsStore: SettingsStore,
        onOpenSettings: @escaping () -> Void,
        onStartOCR: @escaping () -> Void
    ) {
        let view = OnboardingView(
            model: model,
            settingsStore: settingsStore,
            onOpenSettings: onOpenSettings,
            onStartOCR: onStartOCR
        )
        let hosting = NSHostingController(rootView: view)
        let window = NSWindow(contentViewController: hosting)
        window.title = "开始使用沉浸式翻译"
        window.styleMask = [.titled, .closable]
        window.setContentSize(NSSize(width: 720, height: 580))
        window.minSize = NSSize(width: 640, height: 520)
        window.isReleasedWhenClosed = false
        model.window = window
        super.init(window: window)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show() {
        model.refresh()
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}

private struct OnboardingView: View {
    @ObservedObject var model: OnboardingModel
    @ObservedObject var settingsStore: SettingsStore
    let onOpenSettings: () -> Void
    let onStartOCR: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            header
            permissionAndOCRSection
            providerSection
            privacyNote

            Spacer()

            HStack {
                Button("刷新状态") {
                    model.refresh()
                }
                Button("打开设置") {
                    onOpenSettings()
                }
                Spacer()
                Button("开始使用") {
                    model.close()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("先跑通权限和 OCR")
                .font(.title2.weight(.semibold))
            Text("新用户可以先看到本机 OCR 预览，再决定接本地模型还是云服务 API Key。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    private var permissionAndOCRSection: some View {
        section("推荐顺序") {
            VStack(alignment: .leading, spacing: 10) {
                checklistRow(
                    icon: "keyboard",
                    title: "辅助功能权限",
                    detail: "选中文本翻译时临时发送 Command + C 读取当前选区；不会记录键盘输入。",
                    isDone: model.isAccessibilityTrusted,
                    actionTitle: model.isAccessibilityTrusted ? "已授权" : "去授权",
                    isActionDisabled: model.isAccessibilityTrusted,
                    action: {
                        PermissionPrompter.requestAccessibilityIfNeeded()
                        PermissionPrompter.openPrivacyPane(kind: .accessibility)
                        model.refresh()
                    }
                )
                checklistRow(
                    icon: "rectangle.dashed",
                    title: "屏幕录制权限",
                    detail: "截图 OCR 只截取你框选的区域，然后交给本机 Apple Vision 识别。",
                    isDone: model.isScreenCaptureTrusted,
                    actionTitle: model.isScreenCaptureTrusted ? "已授权" : "去授权",
                    isActionDisabled: model.isScreenCaptureTrusted,
                    action: {
                        PermissionPrompter.requestScreenCaptureIfNeeded()
                        PermissionPrompter.openPrivacyPane(kind: .screenRecording)
                        model.refresh()
                    }
                )
                checklistRow(
                    icon: "text.viewfinder",
                    title: "试一次本机 OCR",
                    detail: "看到原文预览就说明 OCR 链路跑通；这一步不需要 API Key，也不会把截图发给翻译服务。",
                    isDone: model.didStartOCRTrial,
                    actionTitle: model.isScreenCaptureTrusted ? (model.didStartOCRTrial ? "再试一次" : "开始框选") : "先授权",
                    action: {
                        model.refresh()
                        guard model.isScreenCaptureTrusted else {
                            PermissionPrompter.requestScreenCaptureIfNeeded()
                            PermissionPrompter.openPrivacyPane(kind: .screenRecording)
                            model.refresh()
                            return
                        }
                        model.didStartOCRTrial = true
                        model.close()
                        onStartOCR()
                    }
                )
            }
        }
    }

    private var providerSection: some View {
        section("翻译接口之后再接") {
            VStack(alignment: .leading, spacing: 10) {
                providerModeRow(
                    icon: "desktopcomputer",
                    title: "也可自己填接口地址",
                    detail: "想接其它服务商或本地 OpenAI 兼容服务，直接在设置里填写接口地址即可，本地兼容接口（如 Ollama 的 http://localhost:11434/…）可不填真实 API Key。"
                )
                providerModeRow(
                    icon: "cloud",
                    title: "云接口需要 API Key",
                    detail: "DeepSeek、OpenAI、智谱等云服务需要对应服务商的 Key；Key 只保存在 macOS Keychain。"
                )
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: providerStatusIcon)
                        .foregroundStyle(providerStatusColor)
                        .frame(width: 18)
                    Text(providerStatusText)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Button("选择接口") {
                        onOpenSettings()
                    }
                    .controlSize(.small)
                }
                .font(.footnote)
                .padding(.top, 2)
            }
        }
    }

    private var privacyNote: some View {
        Text("这个工具不会后台扫描屏幕，也不会记录键盘输入；只有触发选中文本翻译或框选 OCR 时才读取对应内容。")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var apiKeyStepIsDone: Bool {
        !apiKeyIsRequired || !settingsStore.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var apiKeyIsRequired: Bool {
        TranslationClient.requiresAPIKey(for: settingsStore.endpoint.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private var providerStatusText: String {
        if !apiKeyIsRequired {
            return "当前设置是本地接口：确认本地模型服务已启动后，可以不填真实 API Key 直接测试。"
        }
        if apiKeyStepIsDone {
            return "当前云接口已配置 API Key：可以在设置里先验证短翻译请求。"
        }
        return "当前默认是云接口且还没有 API Key；这不影响先体验本机 OCR，准备翻译时再填 Key 或切到本地接口。"
    }

    private var providerStatusIcon: String {
        apiKeyStepIsDone ? "checkmark.circle.fill" : "info.circle"
    }

    private var providerStatusColor: Color {
        apiKeyStepIsDone ? .green : .blue
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func providerModeRow(icon: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.blue)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func checklistRow(
        icon: String,
        title: String,
        detail: String,
        isDone: Bool,
        actionTitle: String,
        isActionDisabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 18, weight: .semibold))
                .frame(width: 26)
                .foregroundStyle(isDone ? .green : .blue)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(title)
                        .font(.headline)
                    Label(isDone ? "已完成" : "待处理", systemImage: isDone ? "checkmark.circle.fill" : "circle")
                        .font(.caption)
                        .foregroundStyle(isDone ? .green : .secondary)
                }
                Text(detail)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button(actionTitle, action: action)
                .disabled(isActionDisabled)
                .controlSize(.small)
        }
        .padding(12)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
