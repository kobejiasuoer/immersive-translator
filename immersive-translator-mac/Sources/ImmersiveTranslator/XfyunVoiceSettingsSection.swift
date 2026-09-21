import SwiftUI
import XfyunCore

/// 设置窗口「语音（讯飞）」区：三组凭据卡（评测 / 合成 / 听写）。
/// 对齐 Windows XfyunVoiceSection.tsx：
/// - 每卡 APPID + APIKey + APISecret 三输入，部分更新语义（空串不覆盖已存值）。
/// - 保存后引擎立即生效（凭据实时从 Keychain 读）。
/// - 状态徽标：已配好 ✓ / 未配置；听写留空自动回落评测凭据的说明。

struct XfyunVoiceSettingsSection: View {
    @ObservedObject private var store = XfyunCredentialsStore.shared
    @State private var editing: [XfyunService: (appId: String, apiKey: String, apiSecret: String)] = [:]
    @State private var saveResults: [XfyunService: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("讯飞开放平台的语音能力按服务独立开通。跟读评测 / 云朗读 / 口语听写各创建一个应用，凭据分别填在下面；都存本机 Keychain，不上传。")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            ForEach(XfyunService.allCases) { service in
                credentialCard(service)
            }

            Text("「流式听写」凭据留空时自动使用「语音评测」的凭据（两类能力常共用一个应用）。每日免费额度以讯飞控制台为准（合成约 500 次/日，朗读有本地缓存不重复扣额）。")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func fields(_ service: XfyunService) -> Binding<(appId: String, apiKey: String, apiSecret: String)> {
        Binding(
            get: {
                editing[service] ?? ("", "", "")
            },
            set: { value in
                editing[service] = value
            }
        )
    }

    private func credentialCard(_ service: XfyunService) -> some View {
        let current = store.credentials[service] ?? XfyunCredentials()
        let complete = current.isComplete
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(service.label)
                    .font(.system(size: 12.5, weight: .semibold))
                if complete {
                    Label("已配置", systemImage: "checkmark.circle.fill")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(.green)
                        .labelStyle(.titleAndIcon)
                } else {
                    Label("未配置", systemImage: "circle.dashed")
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            HStack(spacing: 10) {
                credentialField("APPID", text: bindingFor(service, \.appId))
                credentialField("APIKey", text: bindingFor(service, \.apiKey))
                credentialField("APISecret", text: bindingFor(service, \.apiSecret), secure: true)
            }

            HStack {
                Text(service.consoleHint)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                if let result = saveResults[service] {
                    Text(result)
                        .font(.system(size: 10.5))
                        .foregroundStyle(result.contains("失败") ? .red : .green)
                }
                Button("保存") {
                    save(service)
                }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(12)
        .background(Color.secondary.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func bindingFor(_ service: XfyunService, _ keyPath: WritableKeyPath<(appId: String, apiKey: String, apiSecret: String), String>) -> Binding<String> {
        let base = fields(service)
        return Binding(
            get: { base.wrappedValue[keyPath: keyPath] },
            set: { value in
                base.wrappedValue[keyPath: keyPath] = value
            }
        )
    }

    private func credentialField(_ label: String, text: Binding<String>, secure: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
            if secure {
                SecureField("", text: text)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 11.5))
            } else {
                TextField("", text: text)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 11.5))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func save(_ service: XfyunService) {
        let f = editing[service] ?? ("", "", "")
        let ok = store.update(service, appId: f.appId, apiKey: f.apiKey, apiSecret: f.apiSecret)
        saveResults[service] = ok ? "✓ 已保存" : "保存失败（Keychain 写入异常）"
        if ok {
            editing[service] = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                saveResults[service] = nil
            }
        }
    }
}
